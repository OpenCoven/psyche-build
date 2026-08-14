import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const mainJs = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/web/main.js'),
  'utf8',
).replace(/\r\n/g, '\n');
const stylesCss = readFileSync(join(repoRoot, 'native/desktop/psyche-build-tauri/web/styles.css'), 'utf8');
const tauriLib = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/src-tauri/src/lib.rs'),
  'utf8',
).replace(/\r\n/g, '\n');
const tauriBuild = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/src-tauri/build.rs'),
  'utf8',
);
const defaultCapability = JSON.parse(readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/src-tauri/capabilities/default.json'),
  'utf8',
));
const browserShortcutCapabilityPath = join(
  repoRoot,
  'native/desktop/psyche-build-tauri/src-tauri/capabilities/browser-app-shortcuts.json',
);
const browserShortcutCapability = existsSync(browserShortcutCapabilityPath)
  ? JSON.parse(readFileSync(browserShortcutCapabilityPath, 'utf8'))
  : null;
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

function browserShortcutInjectionSource() {
  const start = tauriLib.indexOf('fn browser_shortcut_initialization_script(');
  const end = tauriLib.indexOf('\n}\n', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return tauriLib.slice(start, end + 2);
}

function registeredAppCommands() {
  const match = tauriLib.match(
    /tauri::generate_handler!\[(?<commands>[\s\S]*?)\]\)/,
  );
  expect(match?.groups?.commands).toBeTruthy();
  return match!.groups!.commands
    .split(',')
    .map((command) => command.trim())
    .filter(Boolean);
}

function manifestAppCommands() {
  const match = tauriBuild.match(
    /AppManifest::new\(\)\.commands\(\s*&\[(?<commands>[\s\S]*?)\]\s*\)/,
  );
  expect(match?.groups?.commands).toBeTruthy();
  return Array.from(match!.groups!.commands.matchAll(/"([^"]+)"/g), ([, command]) => command);
}

function browserShortcutListenerBlock(name: string) {
  const start = mainJs.indexOf(`listen("${name}", function () {`);
  const end = mainJs.indexOf('}).catch(function () {});', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return mainJs.slice(start, end + '}).catch(function () {});'.length);
}

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

  it('overlays the dirty dot and close control without reflowing the file tab', () => {
    expect(mainJs).toContain('item.className = "file-tab-item"');
    expect(stylesCss).toMatch(/\.file-tab-item \{[^}]*position: relative;[^}]*flex: 0 0 auto;/);
    expect(stylesCss).toMatch(/\.file-tab-item > \.tab \{[^}]*padding-right: 34px;/);
    expect(stylesCss).toMatch(/\.tab \.dot \{[^}]*position: absolute/);
    expect(stylesCss).toMatch(/\.file-tab-item > \.close \{[^}]*position: absolute/);
    expect(stylesCss).toContain('.file-tab-item:hover > .close { opacity: 1; }');
    expect(stylesCss).toContain('.file-tab-item:hover .dot { opacity: 0; }');
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

  it('lets embedded browser webviews forward exact T/D/F app shortcuts', () => {
    const injection = browserShortcutInjectionSource();
    const invokeCapture = injection.indexOf('var invoke = core.invoke;');
    const promiseCapture = injection.indexOf('var promiseThen = Promise.prototype.then;');
    const lowercaseCapture = injection.indexOf(
      'var stringToLowerCase = String.prototype.toLowerCase;',
    );
    const listener = injection.indexOf('window.addEventListener("keydown", function(event) {');
    const trustedGuard = injection.indexOf('event.isTrusted !== true');
    const repeatGuard = injection.indexOf('event.repeat');
    const preventDefault = injection.indexOf('event.preventDefault();');
    const invokeCall = injection.indexOf('"browser_app_shortcut"');

    expect(invokeCapture).toBeGreaterThanOrEqual(0);
    expect(promiseCapture).toBeGreaterThanOrEqual(0);
    expect(lowercaseCapture).toBeGreaterThanOrEqual(0);
    expect(invokeCapture).toBeLessThan(listener);
    expect(promiseCapture).toBeLessThan(listener);
    expect(lowercaseCapture).toBeLessThan(listener);
    expect(trustedGuard).toBeGreaterThan(listener);
    expect(repeatGuard).toBeGreaterThan(listener);
    expect(trustedGuard).toBeLessThan(preventDefault);
    expect(repeatGuard).toBeLessThan(preventDefault);
    expect(preventDefault).toBeLessThan(invokeCall);
    expect(injection).toContain('reflectApply(invoke, core, [');
    expect(injection).toContain('shortcut = "terminal-pane"');
    expect(injection).toContain('shortcut = "agent-pane"');
    expect(injection).toContain('shortcut = "composer"');
    expect(injection).toContain('url: location.href');
    expect(injection).toContain('secret: secret');
    expect(injection).toContain('reflectApply(promiseThen, pending, [');
    expect(injection).toContain('secret = nextSecret;');
    expect(injection).not.toMatch(/emit\("browser:shortcut-(terminal-pane|agent-pane|composer)"/);
    expect(tauriLib).toMatch(
      /emit\("browser:title", \{\{ label: browserLabel, title: title, url: location\.href \}\}\);/,
    );
    expect(tauriLib).toMatch(
      /emit\("browser:focus", \{\{ label: browserLabel, url: location\.href \}\}\);/,
    );
    expect(tauriLib).not.toMatch(forbiddenBrowserNewTabShortcut);
    expect(injection).toContain(
      'var key = event.key ? reflectApply(stringToLowerCase, event.key, []) : "";',
    );
    expect(injection).toContain('var primary = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;');
    expect(injection).toContain('if ((event.metaKey || event.ctrlKey) && key === "t") {');
    expect(injection).not.toContain('if (primary && key === "t") {');
    expect(injection).toContain('else if (primary && key === "d") {');
    expect(injection).toContain('else if (primary && key === "f") {');
    expect(injection).not.toContain('key === "p"');
    expect(injection).not.toContain('key === "k"');
    expect(injection).toContain('function(initialSecret)');
    expect(tauriLib).toMatch(/\.initialization_script\(shortcut_script\)/);
    const ensureBrowserStart = tauriLib.indexOf('fn ensure_browser(');
    const ensureBrowserEnd = tauriLib.indexOf('\n}\n', ensureBrowserStart);
    const ensureBrowser = tauriLib.slice(ensureBrowserStart, ensureBrowserEnd);
    expect(ensureBrowser).not.toContain('window.addEventListener("keydown"');
    expect(browserShortcutListenerBlock("browser:shortcut-terminal-pane")).toContain('createTerminalPane();');
    expect(browserShortcutListenerBlock("browser:shortcut-agent-pane")).toContain('openAgentPicker();');
    const composerListener = browserShortcutListenerBlock("browser:shortcut-composer");
    expect(composerListener).toContain('commandInput.focus();');
    expect(composerListener).toContain('openPalette("/", true);');
  });

  it('registers a caller-bound allowlisted browser shortcut command', () => {
    expect(tauriLib).toMatch(
      /#\[tauri::command\]\s*fn browser_app_shortcut\(\s*webview:\s*tauri::Webview,\s*authorizations:\s*State<'_, BrowserShortcutAuthorizations>,\s*shortcut:\s*String,\s*url:\s*String,\s*secret:\s*String,\s*\)\s*->\s*Result<String,\s*String>/,
    );
    expect(tauriLib).toMatch(
      /fn resolve_browser_app_shortcut\([^)]*label:\s*&str[^)]*shortcut:\s*&str[^)]*\)[\s\S]*label\.starts_with\(BROWSER_LABEL_PREFIX\)/,
    );
    expect(tauriLib).toMatch(/"terminal-pane"\s*=>\s*Ok\("browser:shortcut-terminal-pane"\)/);
    expect(tauriLib).toMatch(/"agent-pane"\s*=>\s*Ok\("browser:shortcut-agent-pane"\)/);
    expect(tauriLib).toMatch(/"composer"\s*=>\s*Ok\("browser:shortcut-composer"\)/);
    expect(tauriLib).toMatch(/unknown browser app shortcut/);

    const commandStart = tauriLib.indexOf('fn browser_app_shortcut(');
    const commandEnd = tauriLib.indexOf('\n}\n', commandStart);
    expect(commandStart).toBeGreaterThanOrEqual(0);
    expect(commandEnd).toBeGreaterThan(commandStart);
    const command = tauriLib.slice(commandStart, commandEnd);
    expect(command).toContain('webview.label()');
    expect(command).toContain('label: webview.label().to_string()');
    expect(command).not.toMatch(/\blabel:\s*String/);
    const authorizationIndex = command.indexOf('.authorize_and_rotate(');
    const focusIndex = command.indexOf('.set_focus()');
    const emitIndex = command.indexOf('.emit_to(');
    expect(authorizationIndex).toBeGreaterThanOrEqual(0);
    expect(focusIndex).toBeGreaterThanOrEqual(0);
    expect(focusIndex).toBeGreaterThan(authorizationIndex);
    expect(emitIndex).toBeGreaterThan(focusIndex);
    expect(command).toMatch(/\.emit_to\(\s*"main"/);
    expect(command).not.toMatch(/\.emit\(/);
    expect(command).toContain('random_browser_shortcut_secret');

    expect(tauriLib).toMatch(
      /tauri::generate_handler!\[[\s\S]*browser_app_shortcut,[\s\S]*\]/,
    );
  });

  it('keeps the explicit app manifest synchronized with every registered command', () => {
    expect(tauriBuild).toContain('tauri_build::Attributes');
    expect(manifestAppCommands()).toEqual(registeredAppCommands());
  });

  it('grants every generated app permission to main and only the shortcut to browsers', () => {
    const generatedPermissions = registeredAppCommands().map(
      (command) => `allow-${command.replaceAll('_', '-')}`,
    );
    const mainAppPermissions = defaultCapability.permissions.filter(
      (permission: string) => !permission.includes(':'),
    );
    expect(defaultCapability).toMatchObject({
      identifier: 'default',
      windows: ['main'],
      permissions: expect.arrayContaining([
        'core:default',
        'core:window:allow-start-dragging',
        'clipboard-manager:allow-write-text',
        'opener:allow-open-url',
        'opener:allow-reveal-item-in-dir',
        'opener:default',
        'dialog:default',
        'dialog:allow-open',
      ]),
    });
    expect(mainAppPermissions).toEqual(generatedPermissions);

    expect(browserShortcutCapability).not.toBeNull();
    expect(browserShortcutCapability).toEqual({
      $schema: '../gen/schemas/macOS-schema.json',
      identifier: 'browser-app-shortcuts',
      description: 'Allows embedded browser webviews to forward approved application shortcuts',
      local: true,
      webviews: ['psyche-browser-*'],
      remote: {
        urls: ['http://*', 'https://*'],
      },
      permissions: ['allow-browser-app-shortcut', 'allow-browser-automation-result'],
    });
    expect(browserShortcutCapability.permissions).toHaveLength(2);
    expect(JSON.stringify(browserShortcutCapability)).not.toContain('core:event:allow-emit');
  });

  it('manages per-webview shortcut authorization across navigation and destruction', () => {
    expect(tauriCargo).toMatch(/^getrandom\s*=\s*"0\.2"/m);
    expect(tauriLib).toMatch(
      /const MIN_BROWSER_SHORTCUT_INTERVAL: Duration = Duration::from_millis\((?:75|80|90|100)\);/,
    );
    expect(tauriLib).toContain('.manage(BrowserShortcutAuthorizations::default())');
    expect(tauriLib).toMatch(
      /let initial_secret = random_browser_shortcut_secret\(\)\?;[\s\S]*\.install\(label, initial_secret\.clone\(\)\)/,
    );
    expect(tauriLib).toMatch(
      /PageLoadEvent::Started[\s\S]*\.reset\(&browser_label\)/,
    );
    expect(tauriLib).toMatch(
      /fn destroy_browser_webview[\s\S]*\.remove\(&label\)/,
    );
  });

  it('keeps browser navigation single-shot for newly created webviews', () => {
    expect(tauriLib).toMatch(/fn\s+ensure_browser[\s\S]*?->\s*Result<bool,\s*String>/);
    expect(tauriLib).toMatch(/return\s+Ok\(false\);/);
    expect(tauriLib).toMatch(/let\s+created\s*=\s*ensure_browser\(/);
    expect(tauriLib).toMatch(/webview\s*=\s*app[\s\S]*?if\s+!created\s*\{[\s\S]*?webview\s*\.set_position\(LogicalPosition::new\(x,\s*y\)\)[\s\S]*?webview\s*\.set_size\(LogicalSize::new\(w\.max\(1\.0\),\s*h\.max\(1\.0\)\)\)/);
    const navigate = tauriLib.slice(tauriLib.indexOf('async fn browser_navigate('), tauriLib.indexOf('fn browser_set_bounds('));
    expect(navigate.match(/start_browser_navigation\(/g)).toHaveLength(1);
  });

  it('reports PTY exit codes and keeps PATH augmentation behind the platform boundary', () => {
    expect(tauriLib).toMatch(/status\.ok\(\)\.map\(\|s\|\s*s\.exit_code\(\)\s+as\s+i32\)/);
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
      /pending_start\.install\(\s*PtySession\s*\{[\s\S]*?terminator:[\s\S]*?\}\s*\)/
    );
    expect(tauriLib).toMatch(
      /pump\.start_worker[\s\S]*?app_for_output[\s\S]*?\.emit\("pty:data-batch",\s*payload\)/
    );
    expect(tauriLib).not.toMatch(/\.emit\(\s*"pty:data"/);
    expect(tauriLib).toMatch(
      /let\s+\(reader_done_tx,\s*reader_done_rx\)\s*=\s*std::sync::mpsc::sync_channel\(1\);[\s\S]*?reader_done_tx\.send\(reader_result\)/
    );
    expect(tauriLib).toMatch(
      /let\s+outcome\s*=\s*coordinate_exit_shutdown\(\s*&mut shutdown,\s*EXIT_DRAIN_TIMEOUT\s*\);[\s\S]*?app_for_exit\.emit\(\s*"pty:exit"/
    );
    expect(tauriLib).not.toMatch(/data_thread\.join\(\)/);
    expect(tauriLib).toMatch(
      /async\s+fn\s+pty_write[\s\S]*?pty_write_operation\(&thread_id\)[\s\S]*?try_acquire_owned\(\)[\s\S]*?operation_lane\.lock_owned\(\)\.await[\s\S]*?spawn_blocking/
    );
    expect(tauriLib).toMatch(
      /fn\s+pty_write_operation[\s\S]*?let\s+guard\s*=\s*PTY_LIFECYCLES\.lock\(\);[\s\S]*?\.live\(thread_id\)[\s\S]*?Arc::clone\(&session\.writer\)[\s\S]*?Arc::clone\(&session\.operation_lane\)[\s\S]*?Arc::clone\(&session\.operation_admission\)[\s\S]*?drop\(guard\)/
    );
    expect(tauriLib).toMatch(
      /fn\s+pty_write_blocking[\s\S]*?let\s+mut\s+writer\s*=\s*writer\.lock\(\);[\s\S]*?writer\.write_all\(&bytes\)[\s\S]*?writer\.flush\(\)/
    );
    expect(tauriLib).toMatch(
      /app_for_exit\.emit\([\s\S]*?"pty:exit"[\s\S]*?generation:\s*exit_token\.generation[\s\S]*?PTY_LIFECYCLES\.lock\(\)\.finish_exit\(&exit_token\)/
    );
    expect(tauriLib).toMatch(/fn\s+agent_skill_source_rank\(source:\s*&str\)\s*->\s*u8/);
    expect(tauriLib).toMatch(/"project"\s*=>\s*0,[\s\S]*?"user"\s*=>\s*1,[\s\S]*?"plugin"\s*=>\s*2/);
    expect(tauriLib).toMatch(
      /out\.sort_by\(\|a,\s*b\|\s*\{[\s\S]*?a\.name[\s\S]*?\.cmp\(&b\.name\)[\s\S]*?\.then\(a\.kind\.cmp\(&b\.kind\)\)[\s\S]*?agent_skill_source_rank\(&a\.source\)\.cmp\(&agent_skill_source_rank\(&b\.source\)\)[\s\S]*?\.then\(a\.source\.cmp\(&b\.source\)\)/
    );
    expect(tauriLib).toMatch(/out\.dedup_by\(\|a,\s*b\|\s*a\.name\s*==\s*b\.name\s*&&\s*a\.kind\s*==\s*b\.kind\)/);
    expect(tauriLib).not.toMatch(/let\s+_\s*=\s*app\.get_webview_window\("main"\);/);
  });

  it('delivers batched PTY output to the matching terminal thread', () => {
    expect(mainJs).toMatch(
      /listen\("pty:data-batch",\s*function\s*\(event\)[\s\S]*?var\s+payload\s*=\s*event\.payload\s*\|\|\s*\{\};[\s\S]*?if\s*\(!payload\.threadId\s*\|\|\s*!payload\.bytes\)\s*return;[\s\S]*?var\s+thread\s*=\s*findThread\(payload\.threadId\);[\s\S]*?if\s*\(!isLiveThread\(thread\)\)\s*return;[\s\S]*?if\s*\(!thread\.terminalController\s*\|\|\s*!thread\.terminalController\.receive\(payload\)\)\s*return;[\s\S]*?var\s+bytes\s*=\s*new\s+Uint8Array\(payload\.bytes\);/,
    );
    expect(mainJs).not.toMatch(/listen\("pty:data",/);
    expect(mainJs).toMatch(
      /window\.PsycheRuntime[\s\S]*typeof window\.PsycheRuntime\.createTerminalPaneController !== "function"/,
    );
    expect(tauriLib).toMatch(
      /fn\s+pty_ack\(thread_id:\s*String,\s*sequence:\s*u64\)[\s\S]*?clone_live_pty_pump\(&thread_id\)\?[\s\S]*?pump\.acknowledge\(sequence\)/,
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
