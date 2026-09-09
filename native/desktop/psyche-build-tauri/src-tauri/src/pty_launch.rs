//! Starting a PTY, and attaching to one that is already running.
//!
//! The second half of #197 slice 3's "start and attach", after `pty_cwd`
//! took working-directory resolution. This owns the reservation that makes a
//! restart safe, the launch validation that decides what may be executed, and
//! the four commands the front end calls.
//!
//! `PendingPtyStart` is the reason a same-identifier restart cannot race. It
//! reserves the thread identifier before anything is spawned and releases it
//! on drop, so a start that fails partway leaves nothing installed. Its `Drop`
//! is load-bearing rather than tidy-up.
//!
//! Launch validation is a security boundary, not a convenience.
//! `trusted_coven_executable` decides which binary may be executed and
//! `apply_launch_env` scrubs inherited environment — including `TMUX`, so a
//! pane started inside a multiplexer does not inherit its session.
//!
//! `native_launch_command` stayed in the crate root. It looks like launch
//! code, but its only caller is `native_sessions`, so it belongs to that
//! capability rather than this one.
//!
//! The module is `pty_launch` rather than `pty_start` because it defines a
//! command of that name. `app.rs` globs the crate root to build
//! `generate_handler!`, so a module and a command sharing an identifier
//! collide there, and the command name is part of the IPC contract.

use super::*;

#[derive(Debug)]
pub(crate) struct PendingPtyStart {
    pub(crate) token: PtySessionToken,
    completed: bool,
}

impl PendingPtyStart {
    pub(crate) fn reserve(thread_id: &str) -> Result<Self, String> {
        let token = PTY_LIFECYCLES
            .lock()
            .reserve(thread_id)
            .map_err(|error| error.to_string())?;
        Ok(Self {
            token,
            completed: false,
        })
    }

    pub(crate) fn install(
        mut self,
        session: PtySession,
    ) -> Result<(PtySessionToken, InstallSessionOutcome<PtySession>), String> {
        let outcome = PTY_LIFECYCLES
            .lock()
            .install(&self.token, session)
            .map_err(|error| error.to_string())?;
        self.completed = true;
        Ok((self.token.clone(), outcome))
    }
}

impl Drop for PendingPtyStart {
    fn drop(&mut self) {
        if !self.completed {
            PTY_LIFECYCLES.lock().abort_start(&self.token);
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StartOptions {
    pub thread_id: String,
    pub project_root: Option<String>,
    pub cwd: Option<String>,
    pub launch_kind: Option<String>,
    pub coven_session_id: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    /// Extra environment variables on top of the inherited environment.
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PtyAttachOptions {
    pub thread_id: String,
    pub session_id: String,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

pub(crate) fn prepare_pty_start(
    options: &StartOptions,
) -> Result<(PendingPtyStart, OpenedPtyCwd), String> {
    let thread_id = options.thread_id.clone();
    let pending_start = PendingPtyStart::reserve(&thread_id)?;
    let project_root = options
        .project_root
        .as_deref()
        .ok_or_else(|| "projectRoot is required".to_string())?;
    let cwd = options.cwd.as_deref().unwrap_or(project_root);
    let resolved_cwd = open_pty_cwd(project_root, cwd)?;
    Ok((pending_start, resolved_cwd))
}

fn has_no_launch_env(env: Option<&HashMap<String, String>>) -> bool {
    env.map_or(true, HashMap::is_empty)
}

pub(crate) fn validate_coven_launch_with(
    options: &StartOptions,
    resolved_coven: Option<&str>,
) -> Result<(), String> {
    let Some(launch_kind) = options.launch_kind.as_deref() else {
        return Ok(());
    };
    if !matches!(launch_kind, "coven-code" | "coven-attach") {
        return Err(format!("unsupported launch kind: {launch_kind}"));
    }

    trusted_coven_executable_with(options.command.as_deref(), resolved_coven)?;

    match launch_kind {
        "coven-code" => {
            if !has_no_launch_env(options.env.as_ref()) {
                return Err("coven-code does not accept launch environment entries".to_string());
            }
            if options.coven_session_id.is_some() {
                return Err("coven-code does not accept a session id".to_string());
            }
            match options.args.as_deref() {
                None | Some([]) => Ok(()),
                _ => Err("coven-code does not accept launch arguments".to_string()),
            }
        }
        "coven-attach" => {
            if !has_no_launch_env(options.env.as_ref()) {
                return Err("coven-attach does not accept launch environment entries".to_string());
            }
            let session_id = options
                .coven_session_id
                .as_deref()
                .ok_or_else(|| "coven-attach requires a session id".to_string())?;
            if !is_safe_session_id(session_id) {
                return Err("coven-attach session id is unsafe".to_string());
            }
            match options.args.as_deref() {
                Some([verb, argument]) if verb == "attach" && argument == session_id => Ok(()),
                _ => Err(
                    "coven-attach requires exactly 'attach' and the validated session id"
                        .to_string(),
                ),
            }
        }
        _ => unreachable!("launch kind was checked above"),
    }
}

pub(crate) fn trusted_coven_executable_with(
    requested_coven: Option<&str>,
    resolved_coven: Option<&str>,
) -> Result<String, String> {
    let resolved_coven = resolved_coven.ok_or_else(|| "Coven executable not found".to_string())?;
    if requested_coven != Some(resolved_coven) {
        return Err("Coven launch command does not match the resolved executable".to_string());
    }
    Ok(resolved_coven.to_string())
}

#[cfg(target_os = "windows")]
fn trusted_coven_executable(requested_coven: &str) -> Result<String, String> {
    let resolved_coven = which_on_path("coven");
    trusted_coven_executable_with(Some(requested_coven), resolved_coven.as_deref())
}

fn validate_coven_launch(options: &StartOptions) -> Result<(), String> {
    let resolved_coven = which_on_path("coven");
    validate_coven_launch_with(options, resolved_coven.as_deref())
}

pub(crate) fn apply_launch_env(
    cmd: &mut CommandBuilder,
    env: Option<&HashMap<String, String>>,
    launch_kind: Option<&str>,
) {
    if let Some(extra_env) = env {
        for (key, value) in extra_env {
            // Empty-string values are treated as "unset this variable" so the
            // JS layer can scrub TMUX (which tmux uses to detect nesting).
            if value.is_empty() {
                cmd.env_remove(key);
            } else {
                cmd.env(key, value);
            }
        }
    }
    if matches!(launch_kind, Some("coven-code" | "coven-attach")) {
        cmd.env_remove(COVEN_SESSION_SOURCE);
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PtyExitEvent {
    pub thread_id: String,
    pub generation: u64,
    pub code: Option<i32>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PtyStartResult {
    generation: u64,
}

#[tauri::command]
pub(crate) async fn pty_start(
    webview: tauri::Webview,
    app: AppHandle,
    options: StartOptions,
) -> Result<PtyStartResult, String> {
    ensure_trusted_pty_caller(webview.label())?;
    match tauri::async_runtime::spawn_blocking(move || pty_start_blocking(app, options)).await {
        Ok(result) => result,
        Err(error) => Err(format!("failed to join PTY start task: {error}")),
    }
}

fn pty_start_blocking(app: AppHandle, options: StartOptions) -> Result<PtyStartResult, String> {
    pty_start_blocking_with_launch(app, options, None)
}

#[cfg(debug_assertions)]
pub(crate) fn pty_start_blocking_with_trusted_fixture(
    app: AppHandle,
    options: StartOptions,
    fixture_launch: platform::TrustedFixtureLaunch,
) -> Result<PtyStartResult, String> {
    pty_start_blocking_with_launch(app, options, Some(fixture_launch.into_descriptor()))
}

fn pty_start_blocking_with_launch(
    app: AppHandle,
    options: StartOptions,
    trusted_fixture_launch: Option<platform::LaunchDescriptor>,
) -> Result<PtyStartResult, String> {
    let thread_id = options.thread_id.clone();
    let (pending_start, resolved_cwd) = prepare_pty_start(&options)?;
    validate_coven_launch(&options)?;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: options.rows.unwrap_or(40),
            cols: options.cols.unwrap_or(120),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let platform::LaunchDescriptor {
        command,
        args,
        env: launch_env,
    } = match trusted_fixture_launch {
        Some(fixture_launch) => fixture_launch,
        None => platform::pty_launch_descriptor(options.command, options.args)?,
    };
    let mut cmd = CommandBuilder::new(command);
    cmd.args(args);
    cmd.env("PATH", platform::augmented_path());
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("PSYCHE_TAURI", "1");
    cmd.env("PSYCHE_NATIVE_CONTAINER", "1");
    if std::env::var("LANG").is_err() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    if std::env::var("LC_ALL").is_err() {
        cmd.env("LC_ALL", "en_US.UTF-8");
    }
    apply_launch_env(
        &mut cmd,
        options.env.as_ref(),
        options.launch_kind.as_deref(),
    );
    // Always make sure TMUX is unset unless something downstream explicitly
    // wants it. Inheriting it from the Tauri parent process makes nested-tmux
    // checks misfire.
    cmd.env_remove("TMUX");
    cmd.env_remove("npm_config_prefix");
    cmd.env_remove("NPM_CONFIG_PREFIX");
    cmd.env_remove("PREFIX");
    for (key, value) in launch_env {
        cmd.env(key, value);
    }

    resolved_cwd.configure_command_cwd(&mut cmd)?;
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(resolved_cwd);
    register_pty_client(app, thread_id, pending_start, pair, child)
}

fn register_pty_client(
    app: AppHandle,
    thread_id: String,
    pending_start: PendingPtyStart,
    pair: portable_pty::PtyPair,
    mut child: Box<dyn Child + Send + Sync>,
) -> Result<PtyStartResult, String> {
    let spawn_time_unix_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let pid = child.process_id();
    let terminator = PtyProcessTerminator::from_spawned_child(child.as_ref(), pair.master.as_ref())
        .map_err(|error| error.to_string())?;
    let mut spawn_guard = PtySpawnTerminationGuard::new(terminator.clone());
    let (mut reader, reader_cancellation) = prepare_pty_reader(pair.master.as_ref())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let generation = pending_start.token.generation;
    let pump = OutputPump::new_with_generation(thread_id.clone(), generation)
        .map_err(|e| e.to_string())?;
    let app_for_output = app.clone();
    pump.start_worker(move |payload| {
        app_for_output
            .emit("pty:data-batch", payload)
            .map_err(|error| error.to_string())
    })
    .map_err(|e| e.to_string())?;

    let (session_token, install_outcome) = pending_start.install(PtySession {
        master: Arc::new(Mutex::new(pair.master)),
        writer: Arc::new(Mutex::new(writer)),
        operation_lane: Arc::new(tokio::sync::Mutex::new(())),
        operation_admission: Arc::new(tokio::sync::Semaphore::new(2)),
        pump: pump.clone(),
        terminator: terminator.clone(),
        reader_cancellation: reader_cancellation.clone(),
        pid,
        spawn_time_unix_secs,
    })?;
    spawn_guard.disarm();

    let reader_pump = pump.clone();
    let (reader_done_tx, reader_done_rx) = std::sync::mpsc::sync_channel(1);
    #[cfg(windows)]
    let reader_cancellation_for_thread = reader_cancellation.clone();
    let data_thread = std::thread::spawn(move || {
        #[cfg(windows)]
        let reader_result = match reader_cancellation_for_thread.install_current_thread() {
            Ok(()) => pump_pty_reader(&mut reader, reader_pump),
            Err(error) => Err(format!(
                "failed to retain Windows PTY reader thread handle: {error}"
            )),
        };
        #[cfg(not(windows))]
        let reader_result = pump_pty_reader(&mut reader, reader_pump);
        let _ = reader_done_tx.send(reader_result);
    });

    let app_for_exit = app.clone();
    let exit_pump = pump;
    let exit_token = session_token.clone();
    let exit_terminator = terminator;
    std::thread::spawn(move || {
        let status = exit_terminator.wait_for_child(|| child.wait());
        let code = status.ok().map(|s| s.exit_code() as i32);
        let mut shutdown = PtyExitShutdown::new(
            exit_token.clone(),
            exit_pump,
            exit_terminator,
            reader_cancellation,
            reader_done_rx,
            data_thread,
        );
        let outcome = coordinate_exit_shutdown(&mut shutdown, EXIT_DRAIN_TIMEOUT);
        if outcome == ExitShutdownOutcome::TimedOut {
            let snapshot = shutdown.pump.snapshot();
            log::warn!(
                "PTY output shutdown timed out for '{}' with {} pending bytes, \
                 prepared={}, {} in-flight batches, and {} blocked producers",
                snapshot.thread_id,
                snapshot.pending_bytes,
                snapshot.prepared,
                snapshot.in_flight_batches,
                snapshot.blocked_producers,
            );
        }
        RECENT_PTY_SNAPSHOTS.lock().insert(FinalOutputPumpSnapshot {
            key: TransportSessionKey::new(exit_token.thread_id.clone(), exit_token.generation),
            outcome,
            transport: shutdown.pump.snapshot(),
        });
        if shutdown.exit_event_allowed {
            let _ = app_for_exit.emit(
                "pty:exit",
                PtyExitEvent {
                    thread_id: exit_token.thread_id.clone(),
                    generation: exit_token.generation,
                    code,
                },
            );
        }
        // Timeout cleanup has its own bounded budget, so it must happen only after
        // observers receive the exit. If reader or worker cleanup is still
        // incomplete, give it one final bounded retry. If cancellation still
        // cannot quiesce a thread, detach its handle after the cancelled pump
        // has been sealed and release the lifecycle entry; the pump rejects
        // late old-generation output before a new session can reuse the id.
        if outcome == ExitShutdownOutcome::TimedOut {
            if !shutdown.finish_terminated_threads(EXIT_TERMINATION_CLEANUP_TIMEOUT) {
                std::thread::spawn(move || {
                    let mut shutdown = shutdown;
                    if !shutdown.finish_terminated_threads(EXIT_TERMINATION_CLEANUP_TIMEOUT) {
                        shutdown.abandon_terminated_threads();
                    }
                    finish_pty_lifecycle(&shutdown);
                });
                return;
            }
        }
        if shutdown.exit_event_allowed {
            PTY_LIFECYCLES.lock().finish_exit(&exit_token);
        }
    });

    if let InstallSessionOutcome::StopImmediately(session) = install_outcome {
        let termination = terminate_pty_session(session)
            .map(|outcome| format!("{outcome:?}"))
            .unwrap_or_else(|error| error);
        return Err(format!(
            "thread '{}' generation {} was stopped during start ({termination})",
            session_token.thread_id, session_token.generation
        ));
    }

    Ok(PtyStartResult {
        generation: session_token.generation,
    })
}

#[tauri::command]
pub(crate) async fn pty_attach(
    webview: tauri::Webview,
    app: AppHandle,
    options: PtyAttachOptions,
) -> Result<PtyStartResult, String> {
    ensure_trusted_pty_caller(webview.label())?;
    match tauri::async_runtime::spawn_blocking(move || pty_attach_blocking(app, options)).await {
        Ok(result) => result,
        Err(error) => Err(format!("failed to join PTY attach task: {error}")),
    }
}

fn pty_attach_blocking(
    app: AppHandle,
    options: PtyAttachOptions,
) -> Result<PtyStartResult, String> {
    validate_pty_thread_id(&options.thread_id)?;
    let attach_args = native_sessions::build_attach_args(
        &native_sessions::native_socket_path()?,
        &options.session_id,
    )?;
    let pending_start = PendingPtyStart::reserve(&options.thread_id)?;
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: options.rows.unwrap_or(40),
            cols: options.cols.unwrap_or(120),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;
    let tmux = which_on_path("tmux")
        .ok_or_else(|| "tmux is unavailable; install tmux and restart Psyche".to_string())?;
    let mut command = CommandBuilder::new(tmux);
    command.args(attach_args);
    command.env("PATH", platform::augmented_path());
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env_remove("TMUX");
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;
    register_pty_client(app, options.thread_id, pending_start, pair, child)
}
