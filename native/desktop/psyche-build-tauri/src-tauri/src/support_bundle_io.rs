//! Headless helper. Potentially blocking filesystem work stays in this process,
//! under the GUI parent's deadline, cancellation grace and process-group fence.
use super::{decode_file_result, decode_result, private_result, terminal, WorkerResult, WORKER};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

pub(super) struct ParentControl {
    finished: Arc<AtomicBool>,
    cancellation: Option<std::sync::mpsc::Receiver<()>>,
}
impl Drop for ParentControl {
    fn drop(&mut self) {
        self.finished.store(true, Ordering::Release);
    }
}
fn supervise_parent(
    mut input: BufReader<std::io::Stdin>,
    cancel: Arc<AtomicBool>,
) -> ParentControl {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let finished = Arc::new(AtomicBool::new(false));
    let completion = finished.clone();
    std::thread::spawn(move || loop {
        match line(&mut input, 32) {
            Ok(message) if message == b"cancel\n" => {
                cancel.store(true, Ordering::Release);
                // Never block EOF supervision on a Node pipe. The separate
                // relay starts only after Node's initial request is written.
                let _ = sender.try_send(());
            }
            _ => {
                if !completion.load(Ordering::Acquire) {
                    unsafe {
                        if libc::getpgrp() == libc::getpid() {
                            libc::kill(-libc::getpgrp(), libc::SIGKILL);
                        }
                    }
                    std::process::exit(74);
                }
                break;
            }
        }
    });
    ParentControl {
        finished,
        cancellation: Some(receiver),
    }
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Create { request: Value },
    Reveal { root: String, result: Value },
}

fn line(reader: &mut impl BufRead, limit: usize) -> Result<Vec<u8>, ()> {
    let mut bytes = Vec::new();
    reader
        .take((limit + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| ())?;
    if bytes.len() > limit || bytes.last() != Some(&b'\n') {
        return Err(());
    }
    Ok(bytes)
}

pub(super) fn entry() -> i32 {
    // A helper is valid only in the fresh process group owned by its supervisor.
    if unsafe { libc::getpgrp() != libc::getpid() } {
        return 64;
    }
    let mut input = BufReader::new(std::io::stdin());
    let result = (|| {
        let request: Request = serde_json::from_slice(&line(&mut input, 32768)?).map_err(|_| ())?;
        let cancel = Arc::new(AtomicBool::new(false));
        // Install before discovery, setup, inspection or reveal can block.
        let mut control = supervise_parent(input, cancel.clone());
        match request {
            Request::Create { request } => Ok(create(request, cancel, Some(&mut control))),
            Request::Reveal { root, result } => {
                // All validation and opener preparation remain inside this
                // killable helper; the parent never blocks on project storage.
                let (checked, inspected) = decode_file_result(
                    Path::new(&root),
                    &serde_json::to_vec(&result).map_err(|_| ())?,
                )
                .map_err(|_| ())?;
                if checked.state != "saved" {
                    return Err(());
                }
                let inspected = inspected.ok_or(())?;
                #[cfg(target_os = "macos")]
                super::reveal::show(&inspected).map_err(|_| ())?;
                #[cfg(not(target_os = "macos"))]
                {
                    let _ = inspected;
                    return Err(());
                }
                Ok(terminal("revealed", "revealed"))
            }
        }
    })()
    .unwrap_or_else(|_| terminal("recovery_required", "worker_failed"));
    let encoded = private_result(&result);
    let _ = writeln!(std::io::stdout(), "{encoded}");
    0
}

pub(super) fn create(
    request: Value,
    cancel: Arc<AtomicBool>,
    control: Option<&mut ParentControl>,
) -> WorkerResult {
    if cancel.load(Ordering::Acquire) {
        return terminal("cancelled", "cancelled");
    }
    let Some(root) = request
        .get("projectRoot")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return terminal("failed", "invalid_request");
    };
    let Some(node) = crate::which_on_path("node") else {
        return terminal("failed", "node_unavailable");
    };
    let Ok(script) = std::str::from_utf8(WORKER) else {
        return terminal("failed", "worker_failed");
    };
    // Keep the static, public worker below platform argv limits. Project data
    // and diagnostic input travel only over stdin, never process arguments.
    if script.len() > 120000 {
        return terminal("failed", "worker_failed");
    }
    let mut command = Command::new(node);
    command
        .args([
            "--input-type=commonjs",
            "--eval",
            script,
            "--",
            "--native-store",
        ])
        .env_clear()
        .env("PATH", crate::platform::augmented_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(home) = crate::platform::home_directory() {
        command.env("HOME", home);
    }
    let Ok(mut child) = command.spawn() else {
        return terminal("failed", "node_unavailable");
    };
    let Some(stdin) = child.stdin.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return terminal("recovery_required", "worker_failed");
    };
    let stdin = Arc::new(Mutex::new(stdin));
    let initial = match serde_json::to_vec(&request) {
        Ok(input) if input.len() + 1 <= 16384 => input,
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            return terminal("failed", "invalid_request");
        }
    };
    // The request must precede any queued cancellation on the Node pipe.
    // Otherwise a quick Cancel could be parsed as the initial JSON request.
    if {
        let mut pipe = stdin.lock();
        pipe.write_all(&initial)
            .and_then(|_| pipe.write_all(b"\n"))
            .is_err()
    } {
        let _ = child.kill();
        let _ = child.wait();
        return terminal("recovery_required", "worker_failed");
    }
    if let Some(control) = control {
        if let Some(cancellation) = control.cancellation.take() {
            let child_input = stdin.clone();
            std::thread::spawn(move || {
                for () in cancellation {
                    if child_input.lock().write_all(b"cancel\n").is_err() {
                        break;
                    }
                }
            });
        }
    }
    let result = (|| -> Result<WorkerResult, ()> {
        let mut output = BufReader::new(child.stdout.take().ok_or(())?);
        loop {
            let message: Value = serde_json::from_slice(&line(&mut output, 256 * 1024)?).map_err(|_| ())?;
            match message.get("kind").and_then(Value::as_str) {
                Some("persist") => {
                    let data = message.get("request").ok_or(())?;
                    let filename = data.get("filename").and_then(Value::as_str).ok_or(())?;
                    let serialized = data.get("serialized").and_then(Value::as_str).ok_or(())?;
                    let retained = data.get("maxRetained").and_then(Value::as_u64).filter(|value| *value <= 10).ok_or(())?;
                    let response = match crate::support_store::persist(Path::new(&root), filename, serialized, retained as usize, &cancel) {
                        Ok(written) => json!({ "kind": "persisted", "ok": true, "written": written }),
                        Err(code) => {
                            if code == "cancelled" { let _ = stdin.lock().write_all(b"cancel\n"); }
                            json!({ "kind": "persisted", "ok": false, "code": if code == "cancelled" { "cancelled" } else { "write_failed" } })
                        }
                    };
                    let encoded = serde_json::to_vec(&response).map_err(|_| ())?;
                    let mut pipe = stdin.lock(); pipe.write_all(&encoded).and_then(|_| pipe.write_all(b"\n")).map_err(|_| ())?;
                }
                Some("result") => return decode_result(Path::new(&root), &serde_json::to_vec(message.get("result").ok_or(())?).map_err(|_| ())?).map_err(|_| ()),
                _ => return Err(()),
            }
        }
    })().unwrap_or_else(|_| terminal("recovery_required", "worker_failed"));
    let _ = child.kill();
    let _ = child.wait();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn support_bundle_parent_eof_probe() {
        if std::env::var_os("PSYCHE_SUPPORT_EOF_PROBE").is_none() {
            return;
        }
        let _guard = supervise_parent(
            BufReader::new(std::io::stdin()),
            Arc::new(AtomicBool::new(false)),
        );
        // Models an operation blocked before Node discovery or during reveal.
        let (_sender, blocked) = std::sync::mpsc::sync_channel::<()>(0);
        let _ = blocked.recv();
    }
    #[test]
    fn support_bundle_parent_eof_stops_helper_before_node_or_reveal_work() {
        use std::os::unix::process::{CommandExt, ExitStatusExt};
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "support_bundle::io::tests::support_bundle_parent_eof_probe",
            ])
            .env("PSYCHE_SUPPORT_EOF_PROBE", "1")
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        drop(child.stdin.take());
        for _ in 0..100 {
            if let Some(status) = child.try_wait().unwrap() {
                // Group SIGKILL and the guard's fixed exit can race. Both are
                // valid termination paths; the actual cleanup invariant is that
                // no owned process group remains, not one exact wait status.
                assert!(
                    status.signal() == Some(libc::SIGKILL) || status.code() == Some(74),
                    "unexpected helper status: {status:?}"
                );
                assert!(
                    !super::super::group_alive(Some(child.id())),
                    "parent EOF left the helper group alive"
                );
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let _ = child.kill();
        let _ = child.wait();
        panic!("parent EOF did not stop the helper's blocked work");
    }
}
