import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const provider = readFileSync(
  new URL('../native/desktop/psyche-build-tauri/src-tauri/src/control_provider.rs', import.meta.url),
  'utf8',
);
const lib = readFileSync(
  new URL('../native/desktop/psyche-build-tauri/src-tauri/src/lib.rs', import.meta.url),
  'utf8',
);
const cargo = readFileSync(
  new URL('../native/desktop/psyche-build-tauri/src-tauri/Cargo.toml', import.meta.url),
  'utf8',
);
const main = readFileSync(
  new URL('../native/desktop/psyche-build-tauri/web/main.js', import.meta.url), 'utf8',
);

describe('desktop control browser provider transport', () => {
  it('derives the socket from canonical-root SHA-256 using the TypeScript 20-hex contract', () => {
    expect(provider).toMatch(/canonicalize\(project_root\)/);
    expect(provider).toMatch(/Sha256::digest\([^)]*canonical[^)]*\)/s);
    expect(provider).toMatch(/\[..20\]/);
    expect(provider).toContain('.psyche/runtime/sockets');
  });

  it('shares the decomposed-Unicode NFC hash fixture with Rust', () => {
    const fixture = JSON.parse(readFileSync(new URL(
      '../protocol-fixtures/control-v1/unicode-project-root.json', import.meta.url), 'utf8'));
    expect(createHash('sha256').update(fixture.decomposed.normalize('NFC')).digest('hex').slice(0, 20))
      .toBe(fixture.sha256First20);
    expect(provider).toContain('unicode-project-root.json');
    expect(provider).toContain('nfc()');
  });

  it('reads only the operator token from a mode-0600 project credential file', () => {
    expect(provider).toContain('control-credentials.json');
    expect(provider).toMatch(/mode\(\)\s*&\s*0o777\s*!=\s*0o600/);
    expect(provider).toMatch(/operator_token|operatorToken/);
    expect(provider).not.toMatch(/credentials\.agent_token|credentials\.agentToken/);
  });

  it('sends hello then registration before permitting resource frames', () => {
    const hello = provider.indexOf('"hello"');
    const register = provider.indexOf('"provider.register"');
    expect(hello).toBeGreaterThan(-1);
    expect(register).toBeGreaterThan(hello);
    expect(provider).toContain('registered: true');
    expect(provider).toContain('if !connection.registered');
  });

  it('uses a Tokio reader task and mpsc writer and emits provider effect pushes', () => {
    expect(provider).toContain('tokio::spawn');
    expect(provider).toContain('BufReader');
    expect(provider).toContain('mpsc::');
    expect(provider).toContain('control:provider-effect-request');
    expect(provider).toContain('"projectRoot".to_string()');
    expect(provider).toMatch(/get_webview_window\("main"\)/);
    expect(provider).toContain('connected: Arc<AtomicBool>');
    expect(provider).toContain('pending_effects: Arc<Mutex<HashMap<String, PendingEffectCorrelation>>>');
    expect(provider).toContain('EFFECT_TOMBSTONE_TTL');
    expect(provider).toContain('reserve_pending_effect(');
    expect(provider).toContain('cancel_pending_effect(');
    expect(provider).toContain('complete_pending_effect(');
    expect(provider).not.toContain('pending_effects.lock().remove');
    expect(provider).toContain('provider.effect.cancel');
    expect(provider).toContain('webview_emit_failed');
    expect(provider).toContain('MAX_PENDING_EFFECTS');
    expect(provider).toContain('cancel_pending_response(');
    expect(provider).toContain('remove_if_nonce(');
    expect(provider).toContain('connection.connection_nonce');
    expect(provider).not.toContain('clear_connection_script_flights');
  });

  it('exposes only typed provider and bounded operator commands', () => {
    for (const name of [
      'control_provider_start', 'control_provider_stop', 'control_provider_upsert',
      'control_provider_remove', 'control_provider_complete', 'control_operator_submit',
      'control_state',
    ]) expect(lib).toContain(name);
    expect(provider).toMatch(/enum\s+OperatorCommand/);
    expect(provider).toContain('LeaseGrant');
    expect(provider).toContain('LeaseRevoke');
    expect(provider).toContain('ApprovalResolve');
    expect(provider).not.toMatch(/control_operator_submit[^\{]+serde_json::Value/s);
    expect(provider).toMatch(/enum\s+ProviderEffectResult/);
    expect(provider).toMatch(/enum\s+BrowserResourceKind/);
  });

  it('returns isolated inspection through native correlation and validates snapshot bounds', () => {
    expect(lib).toContain('browser_inspect');
    expect(lib).toContain('WKContentWorld');
    expect(lib).toContain('backend_unavailable');
    expect(lib).toContain('BROWSER_INSPECTION_TIMEOUT');
  });

  it('exposes typed trusted-shell inspection with fixed embedded script provenance', () => {
    const inspect = lib.slice(lib.indexOf('async fn browser_inspect'), lib.indexOf('async fn browser_inspect') + 5_000);
    expect(inspect).toContain('caller: tauri::Webview');
    expect(inspect).toContain('require_main_webview');
    expect(inspect).toContain('BrowserInspectRequest');
    expect(inspect).not.toMatch(/label:\s*Option<String>/);
    expect(inspect).not.toMatch(/script:\s*String/);
    expect(lib).toContain('include_str!("../../web/control/browser-automation-runtime.js")');
    expect(lib).toContain('BrowserBindingState');
    expect(lib).toContain('navigation_epoch');
    const reload = lib.slice(lib.indexOf('fn browser_reload'), lib.indexOf('fn browser_reload') + 1_500);
    expect(reload).toContain('browser_binding');
    expect(reload).not.toContain('navigation_epoch =');
    const confirmedNavigation = lib.slice(lib.indexOf('fn update_browser_binding_navigation'),
      lib.indexOf('fn update_browser_binding_navigation') + 1_500);
    expect(confirmedNavigation).toContain('script_flights');
    const confirmedNavigationState = lib.slice(lib.indexOf('fn confirm_browser_navigation'),
      lib.indexOf('fn confirm_browser_navigation') + 3_500);
    expect(confirmedNavigationState).toContain('operations.remove(&tab_id)');
    expect(main).toContain('status: "timed_out_pending"');
    expect(main).toContain('browser:script-terminal');
    expect(main).toContain('createBrowserScriptTimeoutState');
    expect(main).toContain('current.phase = "acknowledged"');
    expect(lib).not.toMatch(/fn browser_eval\s*\(/);
  });

  it('keeps exactly the three reviewed browser automation public exports', () => {
    const entry = readFileSync(new URL(
      '../native/desktop/psyche-build-tauri/web/control/control-entry.js', import.meta.url), 'utf8');
    expect(entry.match(/\b(browserAutomationSource|dispatchBrowserAutomation|installBrowserAutomation)\b/g))
      .toHaveLength(3);
    expect(entry).not.toContain('validateBrowserSnapshot');
  });

  it('clears pending effects on stop and reconnect and declares crypto dependencies', () => {
    expect(provider).toMatch(/pending_effects\.lock\(\)\.clear\(\)/);
    expect(provider.match(/pending_effects\.lock\(\)\.clear\(\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(cargo).toMatch(/^sha2\s*=\s*"0\.10"/m);
    expect(cargo).toMatch(/^base64\s*=\s*"0\.22"/m);
  });

  it('does not treat provider resource removal or navigation dispatch as document termination', () => {
    const remove = provider.slice(provider.indexOf('pub async fn control_provider_remove'),
      provider.indexOf('pub fn control_provider_complete'));
    expect(remove).not.toContain('script_flights');
    expect(remove).not.toContain('clear_matching_request');
    const navigate = lib.slice(lib.indexOf('fn browser_navigate'), lib.indexOf('fn browser_set_bounds'));
    expect(navigate).not.toContain('script_flights');
    expect(navigate).not.toContain('flights.lock().remove');
  });
});
