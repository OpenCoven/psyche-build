//! Headless helper. Potentially blocking filesystem work stays in this process,
//! under the GUI parent's deadline, cancellation grace and process-group fence.
use super::{decode_result, private_result, terminal, WorkerResult, WORKER};
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
    let mut input = BufReader::new(std::io::stdin());
    let result = (|| {
        let request: Request = serde_json::from_slice(&line(&mut input, 32768)?).map_err(|_| ())?;
        match request {
            Request::Create { request } => Ok(create(
                request,
                Arc::new(AtomicBool::new(false)),
                Some(input),
            )),
            Request::Reveal { root, result } => {
                // All validation and opener preparation remain inside this
                // killable helper; the parent never blocks on project storage.
                let checked = decode_result(
                    Path::new(&root),
                    &serde_json::to_vec(&result).map_err(|_| ())?,
                )
                .map_err(|_| ())?;
                if checked.state != "saved" {
                    return Err(());
                }
                tauri_plugin_opener::reveal_item_in_dir(checked.path.ok_or(())?).map_err(|_| ())?;
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
    control: Option<BufReader<std::io::Stdin>>,
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
    let finished = Arc::new(AtomicBool::new(false));
    if let Some(mut control) = control {
        let child_input = stdin.clone();
        let cancel = cancel.clone();
        let finished = finished.clone();
        let pid = child.id();
        std::thread::spawn(move || loop {
            match line(&mut control, 32) {
                Ok(message) if message == b"cancel\n" => {
                    cancel.store(true, Ordering::Release);
                    let _ = child_input.lock().write_all(b"cancel\n");
                }
                _ => {
                    if !finished.load(Ordering::Acquire) {
                        // Parent disappearance must not leave an orphaned IO
                        // helper or Node worker. Never signal a caller's group
                        // when the helper was invoked outside our supervisor.
                        unsafe {
                            libc::kill(pid as libc::pid_t, libc::SIGKILL);
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
    finished.store(true, Ordering::Release);
    let _ = child.kill();
    let _ = child.wait();
    result
}
