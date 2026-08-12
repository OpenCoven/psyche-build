import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const mainJs = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/web/main.js'),
  'utf8',
).replace(/\r\n/g, '\n');
const stylesCss = readFileSync(join(repoRoot, 'native/desktop/psyche-build-tauri/web/styles.css'), 'utf8');
const tauriLib = readFileSync(join(repoRoot, 'native/desktop/psyche-build-tauri/src-tauri/src/lib.rs'), 'utf8');
const tauriCargo = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/src-tauri/Cargo.toml'),
  'utf8'
);
const platformMod = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/src-tauri/src/platform/mod.rs'),
  'utf8'
);
const macosPlatform = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/src-tauri/src/platform/macos.rs'),
  'utf8'
);
const indexHtml = readFileSync(join(repoRoot, 'native/desktop/psyche-build-tauri/web/index.html'), 'utf8');
const tauriConfig = JSON.parse(
  readFileSync(join(repoRoot, 'native/desktop/psyche-build-tauri/src-tauri/tauri.conf.json'), 'utf8')
);
const forbiddenContextualTabFn = new RegExp(`function\\s+${'createContextual' + 'Tab'}\\(\\)`);
const forbiddenBrowserNewTabShortcut = new RegExp(`${'browser:shortcut-' + 'new' + '-tab'}`);

describe('Tauri desktop tab shortcuts', () => {
  it('routes Command+T to terminal panes globally', () => {
    expect(mainJs).toMatch(/async function createTerminalPane\(\)/);
    expect(mainJs).toMatch(
      /async function createTerminalPane\(\)\s*\{[\s\S]*var project = activeProject\(\);[\s\S]*if \(!project \|\| !project\.root\)\s*\{[\s\S]*setStatus\("Open a project before starting a terminal", "warn"\);[\s\S]*return null;[\s\S]*\}[\s\S]*var worktree = selectedWorktree\(project\);[\s\S]*if \(!worktree \|\| !worktree\.path\)\s*\{[\s\S]*setStatus\("Select an available worktree before starting a terminal", "warn"\);[\s\S]*return null;[\s\S]*\}[\s\S]*await showTerminalView\(\)[\s\S]*return spawnShellThread\(project\);[\s\S]*\}/
    );
    expect(mainJs).toMatch(
      /String\(e\.key\)\.toLowerCase\(\)\s*===\s*"t"[\s\S]*e\.preventDefault\(\);[\s\S]*await createTerminalPane\(\);/
    );
    expect(mainJs).not.toMatch(forbiddenContextualTabFn);
    expect(mainJs).not.toMatch(
      /if\s*\(\s*String\(e\.key\)\.toLowerCase\(\)\s*===\s*"t"\s*\)\s*\{[^}]*openBlankBrowserTab\(\)/
    );
  });

  it('swaps the dirty dot for the close control in one non-reflowing slot', () => {
    // Both controls live in the same fixed-width slot, so revealing one cannot
    // shift the strip.
    expect(mainJs).toMatch(/<span class="tab-end">/);
    expect(stylesCss).toMatch(/\.tab-end \{[^}]*flex: 0 0 16px/);
    expect(stylesCss).toMatch(/\.tab \.dot \{[^}]*position: absolute/);
    expect(stylesCss).toMatch(/\.tab \.close \{[^}]*position: absolute/);
    expect(stylesCss).toContain('.tab:hover .close { opacity: 1; }');
    expect(stylesCss).toContain('.tab:hover .dot { opacity: 0; }');
    // The active tab keeps its dot: that is the file whose unsaved state matters.
    expect(stylesCss).not.toMatch(/\.tab\.active \.dot \{[^}]*opacity: 0/);
  });

  it('closes a file tab on middle click', () => {
    expect(mainJs).toMatch(
      /addEventListener\("auxclick",[\s\S]*e\.button !== 1[\s\S]*closeFileTab\(file\.id\)/
    );
  });

  it('fades the strip edges only while it actually overflows', () => {
    expect(mainJs).toMatch(
      /function syncTabStripOverflow\(\)[\s\S]*scrollWidth > tabStripEl\.clientWidth \+ 1[\s\S]*toggle\("is-overflowing"/
    );
    expect(mainJs).toMatch(/function scrollActiveTabIntoView\(\)[\s\S]*scrollIntoView/);
    // Refreshing the strip and resizing the window both re-measure.
    expect(mainJs).toMatch(/syncTabStripOverflow\(\);\n    scrollActiveTabIntoView\(\);/);
    expect(stylesCss).toMatch(/\.tab-strip\.is-overflowing \{[^}]*mask-image/);
    expect(stylesCss).not.toMatch(/\.tab-strip \{[^}]*[^.]mask-image/);
  });

  it('lets embedded browser webviews request a terminal pane with Command+T', () => {
    expect(tauriLib).toMatch(/browser:shortcut-terminal-pane/);
    expect(tauriLib).not.toMatch(forbiddenBrowserNewTabShortcut);
    expect(tauriLib).toMatch(/event\.key\.toLowerCase\(\)\s*===\s*"t"/);
    expect(tauriLib).toMatch(/function\(browserLabel\)/);
    expect(tauriLib).not.toMatch(/label_json,\s*label_json/);
    expect(mainJs).toMatch(
      /listen\(\s*"browser:shortcut-terminal-pane",\s*function\s*\(\)\s*\{[\s\S]*createTerminalPane\(\);[\s\S]*\}\s*\)\.catch/
    );
  });

  it('keeps browser navigation single-shot for newly created webviews', () => {
    expect(tauriLib).toMatch(/fn\s+ensure_browser[\s\S]*?->\s*Result<bool,\s*String>/);
    expect(tauriLib).toMatch(/return\s+Ok\(false\);/);
    expect(tauriLib).toMatch(/let\s+created\s*=\s*ensure_browser\(/);
    expect(tauriLib).toMatch(/if\s+!created\s*\{[\s\S]*?webview\s*=\s*app[\s\S]*?webview\s*\.set_position\(LogicalPosition::new\(x,\s*y\)\)[\s\S]*?webview\s*\.set_size\(LogicalSize::new\(w\.max\(1\.0\),\s*h\.max\(1\.0\)\)\)/);
    expect(tauriLib).toMatch(/if\s+!created\s*\{[\s\S]*?webview\.navigate\(parsed_url\)/);
  });

  it('reports PTY exit codes and keeps PATH augmentation behind the platform boundary', () => {
    expect(tauriLib).toMatch(
      /status\.ok\(\)\.map\(\|status\|\s*status\.exit_code\(\)\s+as\s+i32\)/
    );
    expect(tauriLib).toMatch(
      /fn\s+app_environment\(\)\s*->\s*AppEnvironment[\s\S]*?let\s+\(default_shell,\s*default_shell_args\)\s*=\s*platform::default_shell\(\);/
    );
    expect(tauriLib).toMatch(
      /fn\s+which_on_path\(binary:\s*&str\)\s*->\s*Option<String>\s*\{\s*let\s+path\s*=\s*platform::augmented_path\(\);\s*for\s+dir\s+in\s+std::env::split_paths\(&path\)/s
    );
    expect(platformMod).toMatch(
      /pub\s+fn\s+augmented_path\(\)\s*->\s*OsString\s*\{\s*target::augmented_path\(\)\s*\}/s
    );
    expect(macosPlatform).toMatch(/fn\s+augmented_path\(\)\s*->\s*OsString\s*\{/);
    expect(macosPlatform).toMatch(/let\s+mut\s+parts\s*=\s*split_and_deduplicate_paths\(&existing\);/);
    expect(macosPlatform).toMatch(/std::env::join_paths\(&parts\)\.unwrap_or\(existing\)/);
    expect(macosPlatform).toMatch(/fn\s+newest_nvm_node_bin\(/);
    expect(macosPlatform).toMatch(/apply_vibrancy/);
    expect(macosPlatform).not.toMatch(/PATH\.split\(|join\(":"\)|split\(":"\)/);
    expect(macosPlatform).not.toMatch(/\.nvm\/versions\/node\/v\d+\.\d+\.\d+\/bin/);
  });

  it('keeps Tauri backend shared-state operations grouped correctly', () => {
    expect(tauriLib).toMatch(
      /static\s+PTY_LIFECYCLES:\s*Lazy<Mutex<PtyLifecycleRegistry<PtySession>>>/
    );
    expect(tauriLib).not.toMatch(/static\s+STARTING_SESSIONS:/);
    expect(tauriLib).toMatch(/let\s+pending_start\s*=\s*PendingPtyStart::reserve\(&thread_id\)\?/);
    expect(tauriLib).toMatch(
      /let\s+session\s*=\s*match\s+startup\.take_session\(\)[\s\S]*?startup\.prepare_exit_activation\(session_token\.clone\(\)\)[\s\S]*?pending_start\.install\(session\)/
    );
    expect(tauriLib).toContain('std::thread::Builder::new()');
    expect(tauriLib).toMatch(/startup\.spawn_reader\(&thread_spawner/);
    expect(tauriLib).toMatch(/startup\.spawn_exit_watcher\(&thread_spawner/);
    expect(tauriLib).toMatch(/startup\.activate_exit_watcher\(\)/);
    expect(tauriLib).not.toContain('PtySpawnTerminationGuard');
    expect(tauriLib).toMatch(
      /pump\.start_worker[\s\S]*?app_for_output[\s\S]*?\.emit\("pty:data-batch",\s*payload\)/
    );
    expect(tauriLib).not.toMatch(/\.emit\(\s*"pty:data"/);
    expect(tauriLib).toMatch(
      /let\s+\(reader_done_tx,\s*reader_done_rx\)\s*=\s*std::sync::mpsc::sync_channel\(1\);[\s\S]*?reader_done_tx\.send\(reader_result\)/
    );
    expect(tauriLib).toMatch(
      /let\s+outcome\s*=\s*coordinate_exit_shutdown\(\s*&mut shutdown,\s*EXIT_DRAIN_TIMEOUT\s*\);[\s\S]*?app\.emit\(\s*"pty:exit"/
    );
    expect(tauriLib).not.toMatch(/data_thread\.join\(\)/);
    expect(tauriLib).toMatch(
      /let\s+writer\s*=\s*\{[\s\S]*?let\s+guard\s*=\s*PTY_LIFECYCLES\.lock\(\);[\s\S]*?guard[\s\S]*?\.live\(&thread_id\)[\s\S]*?Arc::clone\(&session\.writer\)[\s\S]*?\};[\s\S]*?let\s+mut\s+writer\s*=\s*writer\.lock\(\);/
    );
    expect(tauriLib).toMatch(
      /app\.emit\([\s\S]*?"pty:exit"[\s\S]*?generation:\s*token\.generation[\s\S]*?PTY_LIFECYCLES\.lock\(\)\.finish_exit\(&token\)/
    );
    expect(tauriLib).toMatch(/fn\s+agent_skill_source_rank\(source:\s*&str\)\s*->\s*u8/);
    expect(tauriLib).toMatch(/"project"\s*=>\s*0,[\s\S]*?"user"\s*=>\s*1,[\s\S]*?"plugin"\s*=>\s*2/);
    expect(tauriLib).toMatch(
      /out\.sort_by\(\|a,\s*b\|\s*\{[\s\S]*?a\.name[\s\S]*?\.cmp\(&b\.name\)[\s\S]*?\.then\(a\.kind\.cmp\(&b\.kind\)\)[\s\S]*?agent_skill_source_rank\(&a\.source\)\.cmp\(&agent_skill_source_rank\(&b\.source\)\)[\s\S]*?\.then\(a\.source\.cmp\(&b\.source\)\)/
    );
    expect(tauriLib).toMatch(/out\.dedup_by\(\|a,\s*b\|\s*a\.name\s*==\s*b\.name\s*&&\s*a\.kind\s*==\s*b\.kind\)/);
    expect(tauriLib).not.toMatch(/let\s+_\s*=\s*app\.get_webview_window\("main"\);/);

    const startBegin = tauriLib.indexOf('fn pty_start(');
    const startEnd = tauriLib.indexOf('\n#[tauri::command]\nfn pty_write', startBegin);
    const startSource = tauriLib.slice(startBegin, startEnd);
    const readerSpawn = startSource.indexOf('startup.spawn_reader(');
    const watcherSpawn = startSource.indexOf('startup.spawn_exit_watcher(');
    const activationPrepare = startSource.indexOf(
      'startup.prepare_exit_activation('
    );
    const registration = startSource.indexOf('pending_start.install(session)');
    const activation = startSource.indexOf('startup.activate_exit_watcher()');
    expect(readerSpawn).toBeGreaterThanOrEqual(0);
    expect(watcherSpawn).toBeGreaterThan(readerSpawn);
    expect(activationPrepare).toBeGreaterThan(watcherSpawn);
    expect(registration).toBeGreaterThan(activationPrepare);
    expect(activation).toBeGreaterThan(registration);
    expect(startSource).not.toContain('std::thread::spawn');
  });

  it('queries and validates the current Unix PTY foreground group before bounded escalation', () => {
    expect(tauriLib).toMatch(/portable_pty::\{[^}]*ChildKiller/);
    expect(tauriLib).toMatch(/child\.clone_killer\(\)/);
    expect(tauriLib).toMatch(/child\.process_id\(\)/);
    expect(tauriLib).toMatch(/master\.process_group_leader\(\)/);
    expect(tauriLib).toContain('master.as_raw_fd()');
    expect(tauriLib).toContain('libc::tcgetpgrp');
    expect(tauriLib).toContain('libc::tcgetsid');
    expect(tauriLib).toContain('libc::getsid');
    expect(tauriLib).toContain('libc::getpgid');
    expect(tauriLib).toMatch(/libc::SIGHUP[\s\S]*libc::SIGCONT[\s\S]*libc::SIGKILL/);
    expect(tauriLib).not.toContain('UNIX_PTY_TERMINATION_GRACE');
    expect(tauriLib).toMatch(
      /for\s+signal\s+in\s+\[libc::SIGHUP,\s*libc::SIGCONT,\s*libc::SIGKILL\][\s\S]*?observe_termination\([^)]*identity[^)]*\)[\s\S]*?verified_unix_process_groups/
    );
    expect(tauriLib).toContain('original_session');
    expect(tauriLib).toContain('original_group');
    expect(tauriLib).toMatch(/reader_cancellation\.cancel\(\)/);
  });

  it('disables the Unix raw-PID fallback before the exit watcher can wait or reap', () => {
    expect(tauriLib).toMatch(
      /fn\s+wait_for_child<[^>]+>[\s\S]*?disable_pid_fallback_before_wait\(\);[\s\S]*?wait\(\)/
    );
    const watcherStart = tauriLib.indexOf('fn run_pty_exit_watcher(');
    const waitStart = tauriLib.indexOf(
      'terminator.wait_for_child(|| child.wait())',
      watcherStart
    );
    const shutdownStart = tauriLib.indexOf('PtyExitShutdown::new(', waitStart);
    expect(watcherStart).toBeGreaterThanOrEqual(0);
    expect(waitStart).toBeGreaterThan(watcherStart);
    expect(shutdownStart).toBeGreaterThan(waitStart);
  });

  it('delegates Windows process-tree termination to the vendored PTY child killer', () => {
    expect(tauriCargo).not.toMatch(
      /\[target\.'cfg\(windows\)'\.dependencies\][\s\S]*windows-sys/
    );
    expect(tauriLib).not.toContain('AssignProcessToJobObject');
    expect(tauriLib).not.toContain('CreateJobObjectW');
    expect(tauriLib).not.toContain('TerminateJobObject');
    expect(tauriLib).not.toContain('TerminateProcess');
    expect(tauriLib).toMatch(
      /struct\s+WindowsProcessTreeKiller\s*\{[\s\S]*?killer:\s*Mutex<Box<dyn ChildKiller \+ Send \+ Sync>>/
    );
    expect(tauriLib).toMatch(
      /fn\s+terminate_platform_process\(\s*process_tree:\s*&WindowsProcessTreeKiller[\s\S]*?process_tree\.terminate\(\)\?;[\s\S]*?PtyTerminationOutcome::ProcessTree/
    );
    const windowsStart = tauriLib.indexOf(
      '#[cfg(windows)]\nfn terminate_platform_process'
    );
    expect(windowsStart).toBeGreaterThanOrEqual(0);
    const windowsEnd = tauriLib.indexOf('\n#[cfg', windowsStart + 1);
    const windowsTermination = tauriLib.slice(
      windowsStart,
      windowsEnd === -1 ? undefined : windowsEnd
    );
    expect(windowsTermination).toContain('process_tree.terminate()?');
    expect(windowsTermination).not.toContain('killer.kill()');
    expect(windowsTermination).not.toContain('libc::');

    const stopStart = tauriLib.indexOf('fn terminate_pty_session(');
    const stopEnd = tauriLib.indexOf('\npub fn recent_pty_transport_snapshot', stopStart);
    const stopSource = tauriLib.slice(stopStart, stopEnd);
    expect(stopSource.indexOf('session.terminator.terminate()')).toBeGreaterThanOrEqual(0);
    expect(stopSource.indexOf('drop(session)')).toBeGreaterThan(
      stopSource.indexOf('session.terminator.terminate()')
    );

    const shutdownHooksStart = tauriLib.indexOf('impl ExitShutdownHooks for PtyExitShutdown');
    const timeoutStart = tauriLib.indexOf('fn terminate_process(&mut self)', shutdownHooksStart);
    const timeoutEnd = tauriLib.indexOf('fn finish_terminated_cleanup', timeoutStart);
    const timeoutSource = tauriLib.slice(timeoutStart, timeoutEnd);
    expect(timeoutSource.indexOf('self.terminator.terminate()')).toBeGreaterThanOrEqual(0);
    expect(timeoutSource.indexOf('self.begin_matching_exit()')).toBeGreaterThan(
      timeoutSource.indexOf('self.terminator.terminate()')
    );
  });

  it('delivers batched PTY output to the matching terminal thread', () => {
    expect(mainJs).toMatch(
      /listen\("pty:data-batch",\s*function\s*\(event\)[\s\S]*?var\s+threadId\s*=\s*payload\.threadId\s*\|\|\s*payload\.thread_id;[\s\S]*?findThread\(threadId\)[\s\S]*?thread\.term\.write\(bytes,\s*acknowledge\)/,
    );
    expect(mainJs).not.toMatch(/listen\("pty:data",/);
    expect(mainJs).toMatch(
      /function\s+acknowledgePtyBatch\(threadId,\s*sequence\)[\s\S]*?invoke\("pty_ack",\s*\{[\s\S]*?threadId:\s*threadId,[\s\S]*?sequence:\s*sequence/,
    );
    expect(tauriLib).toMatch(
      /fn\s+pty_ack\(thread_id:\s*String,\s*sequence:\s*u64\)[\s\S]*?session\.pump\.clone\(\)[\s\S]*?pump\.acknowledge\(sequence\)/,
    );
    expect(tauriLib).toMatch(/generate_handler!\[[\s\S]*?pty_ack,/);
  });

  it('queries and validates the current Unix PTY foreground group before bounded escalation', () => {
    expect(tauriLib).toMatch(/portable_pty::\{[^}]*ChildKiller/);
    expect(tauriLib).toMatch(/child\.clone_killer\(\)/);
    expect(tauriLib).toMatch(/child\.process_id\(\)/);
    expect(tauriLib).toMatch(/master\.process_group_leader\(\)/);
    expect(tauriLib).toContain('master.as_raw_fd()');
    expect(tauriLib).toContain('libc::tcgetpgrp');
    expect(tauriLib).toContain('libc::tcgetsid');
    expect(tauriLib).toContain('libc::getsid');
    expect(tauriLib).toContain('libc::getpgid');
    expect(tauriLib).toMatch(/libc::SIGHUP[\s\S]*libc::SIGCONT[\s\S]*libc::SIGKILL/);
    expect(tauriLib).not.toContain('UNIX_PTY_TERMINATION_GRACE');
    expect(tauriLib).toMatch(
      /for\s+signal\s+in\s+\[libc::SIGHUP,\s*libc::SIGCONT,\s*libc::SIGKILL\][\s\S]*?observe_termination\([^)]*identity[^)]*\)[\s\S]*?verified_unix_process_groups/
    );
    expect(tauriLib).toContain('original_session');
    expect(tauriLib).toContain('original_group');
    expect(tauriLib).toMatch(/reader_cancellation\.cancel\(\)/);
  });

  it('disables the Unix raw-PID fallback before the exit watcher can wait or reap', () => {
    expect(tauriLib).toMatch(
      /fn\s+wait_for_child<[^>]+>[\s\S]*?disable_pid_fallback_before_wait\(\);[\s\S]*?wait\(\)/
    );
    const watcherStart = tauriLib.indexOf('let exit_terminator = terminator;');
    const waitStart = tauriLib.indexOf('exit_terminator.wait_for_child(|| child.wait())', watcherStart);
    const shutdownStart = tauriLib.indexOf('PtyExitShutdown::new(', waitStart);
    expect(watcherStart).toBeGreaterThanOrEqual(0);
    expect(waitStart).toBeGreaterThan(watcherStart);
    expect(shutdownStart).toBeGreaterThan(waitStart);
  });

  it('owns a kill-on-close Windows Job Object and terminates it before ConPTY teardown', () => {
    expect(tauriCargo).toMatch(
      /\[target\.'cfg\(windows\)'\.dependencies\][\s\S]*windows-sys\s*=\s*\{[^}]*version\s*=\s*"=0\.59\.0"[^}]*Win32_Foundation[^}]*Win32_Security[^}]*Win32_System_JobObjects[^}]*Win32_System_Threading/
    );
    expect(tauriLib).toContain('const WINDOWS_REQUIRED_PROCESS_RIGHTS: u32 = 0x0101;');
    expect(tauriLib).toContain('const WINDOWS_JOB_KILL_ON_CLOSE_LIMIT: u32 = 0x2000;');
    expect(tauriLib).toMatch(/OpenProcess\(\s*WINDOWS_REQUIRED_PROCESS_RIGHTS/);
    expect(tauriLib).toContain('CreateJobObjectW');
    expect(tauriLib).toContain('JobObjectExtendedLimitInformation');
    expect(tauriLib).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE');
    expect(tauriLib).toContain('SetInformationJobObject');
    expect(tauriLib).toContain('AssignProcessToJobObject');
    expect(tauriLib).toContain('TerminateJobObject');
    expect(tauriLib).toContain('TerminateProcess');
    expect(tauriLib).toContain('CloseHandle');
    expect(tauriLib).toContain('WindowsExternalJobRestriction');
    expect(tauriLib).toMatch(/impl<[^>]*>\s+Drop\s+for\s+OwnedTerminationResource/);
    expect(tauriLib).toMatch(/if\s+result\s*!=\s*0\s*\{\s*Ok\(\(\)\)/);
    expect(tauriLib).toMatch(
      /let\s+result\s*=\s*unsafe\s*\{\s*TerminateJobObject\(self\.raw_handle\(\),\s*1\)\s*\};\s*check_windows_bool\(result,\s*std::io::Error::last_os_error\)/
    );
    const windowsStart = tauriLib.search(
      /#\[cfg\(windows\)\]\r?\nfn terminate_platform_process/,
    );
    expect(windowsStart).toBeGreaterThanOrEqual(0);
    const windowsEnd = tauriLib.indexOf('\n#[cfg', windowsStart + 1);
    const windowsTermination = tauriLib.slice(
      windowsStart,
      windowsEnd === -1 ? undefined : windowsEnd
    );
    expect(windowsTermination).toContain('process_tree.terminate()');
    expect(windowsTermination).not.toContain('killer.kill()');
    expect(windowsTermination).not.toContain('libc::');

    const stopStart = tauriLib.indexOf('fn terminate_pty_session(');
    const stopEnd = tauriLib.indexOf('\npub fn recent_pty_transport_snapshot', stopStart);
    const stopSource = tauriLib.slice(stopStart, stopEnd);
    expect(stopSource.indexOf('session.terminator.terminate()')).toBeGreaterThanOrEqual(0);
    expect(stopSource.indexOf('drop(session)')).toBeGreaterThan(
      stopSource.indexOf('session.terminator.terminate()')
    );

    const shutdownHooksStart = tauriLib.indexOf('impl ExitShutdownHooks for PtyExitShutdown');
    const timeoutStart = tauriLib.indexOf('fn terminate_process(&mut self)', shutdownHooksStart);
    const timeoutEnd = tauriLib.indexOf('fn finish_terminated_cleanup', timeoutStart);
    const timeoutSource = tauriLib.slice(timeoutStart, timeoutEnd);
    expect(timeoutSource.indexOf('self.terminator.terminate()')).toBeGreaterThanOrEqual(0);
    expect(timeoutSource.indexOf('self.begin_matching_exit()')).toBeGreaterThan(
      timeoutSource.indexOf('self.terminator.terminate()')
    );
  });

  it('keeps the Tauri app CSP free of broad unsafe allowances', () => {
    const csp = tauriConfig.app.security.csp as string;
    expect(csp).toMatch(/style-src\s+'self'/);
    expect(csp).toMatch(/script-src\s+'self'/);
    expect(csp).not.toMatch(/'unsafe-inline'|'unsafe-eval'/);
    expect(indexHtml).not.toMatch(/\sstyle=/);
    expect(mainJs).not.toMatch(/style\.cssText/);
  });

  it('keeps browser tabs thin and collapsible under narrow browser panes', () => {
    expect(stylesCss).toMatch(/--browser-tab-h:\s*22px;/);
    expect(stylesCss).toMatch(
      /\.browser-surface\s*\{[^}]*grid-template-rows:\s*var\(--browser-bar-h\) var\(--browser-tab-h\) minmax\(0, 1fr\);/s
    );
    expect(stylesCss).toMatch(/\.browser-tab\s*\{[\s\S]*?min-width:\s*34px;[\s\S]*?flex:\s*1 1 118px;/);
    expect(stylesCss).toMatch(/\.browser-tab-title\s*\{[\s\S]*?min-width:\s*0;/);
  });

  it('keeps terminal tabs horizontally scrollable without vertical overflow', () => {
    expect(stylesCss).toMatch(
      /\.tab-strip\s*\{[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;/
    );
  });
});
