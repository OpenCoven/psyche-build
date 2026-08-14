import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const provider = readFileSync(new URL(
  '../native/desktop/psyche-build-tauri/src-tauri/src/control_provider.rs',
  import.meta.url,
), 'utf8');
const lib = readFileSync(new URL(
  '../native/desktop/psyche-build-tauri/src-tauri/src/lib.rs',
  import.meta.url,
), 'utf8');
const cargo = readFileSync(new URL(
  '../native/desktop/psyche-build-tauri/src-tauri/Cargo.toml',
  import.meta.url,
), 'utf8');
const capability = JSON.parse(readFileSync(new URL(
  '../native/desktop/psyche-build-tauri/src-tauri/capabilities/default.json',
  import.meta.url,
), 'utf8')) as { windows?: string[] };

describe('Tauri browser control provider contract', () => {
  it('derives the endpoint from canonical-root SHA-256 first 20 hex characters', () => {
    expect(provider).toMatch(/canonicalize\(/);
    expect(provider).toMatch(/Sha256::digest/);
    expect(provider).toMatch(/\.take\(20\)/);
    expect(provider).toContain('.psyche/runtime/sockets');
    expect(provider).toContain('normalize_canonical_identity');
    expect(provider).toContain('project_identity_hash');
    expect(cargo).toContain('unicode-normalization');
  });

  it('reads only the operator token from a 0600 credential file', () => {
    expect(provider).toContain('control-credentials.json');
    expect(provider).toMatch(/permissions\(\)\.mode\(\) & 0o777 != 0o600/);
    expect(provider).toMatch(/struct StoredCredentials[\s\S]*operator_token: String/);
    expect(provider).not.toMatch(/agent_token\s*:/);
    expect(provider).toContain('O_NOFOLLOW');
    expect(provider).toMatch(/file\s*\.metadata\(\)/);
    expect(provider).toMatch(/\.take\(MAX_CREDENTIAL_BYTES/);
  });

  it('writes hello and provider registration before any resource frames', () => {
    expect(provider).toMatch(/fn send_handshake[\s\S]*OutboundFrame::Hello[\s\S]*OutboundFrame::Register/);
    expect(provider).toMatch(/connect_provider\(&root[\s\S]*mpsc::channel/);
    expect(provider).toMatch(/expect_handshake_response[\s\S]*"welcome"[\s\S]*"ack"/);
  });

  it('emits bounded typed effect requests to the main webview', () => {
    expect(provider).toContain('control:provider-effect-request');
    expect(provider).toMatch(/ProviderEffectRequest/);
    expect(provider).toMatch(/MAX_PROVIDER_LINE_BYTES/);
    expect(provider).toMatch(/MAX_PROVIDER_RESULT_BYTES/);
    expect(provider).toMatch(/validate_effect_request/);
    expect(provider).toMatch(/effect\.version != 1/);
    expect(provider).toMatch(/effect\.frame_type != "provider\.effect\.request"/);
    expect(provider).toMatch(/pending_effects\.contains/);
    expect(provider).toMatch(/effect\.request_id != effect\.action_id/);
    expect(provider).toContain('effect.project_root = Some(root_key.clone())');
  });

  it('exposes typed commands and a closed operator command enum', () => {
    for (const command of [
      'control_provider_start', 'control_provider_stop', 'control_provider_upsert',
      'control_provider_remove', 'control_provider_complete', 'control_operator_submit',
      'control_state', 'control_provider_shutdown',
    ]) {
      expect(lib).toContain(command);
    }
    expect(provider).toMatch(/enum OperatorCommand[\s\S]*LeaseGrant[\s\S]*LeaseRevoke[\s\S]*ApprovalResolve/);
    expect(provider).not.toMatch(/control_operator_submit[^(]*\([^)]*serde_json::Value/);
    expect(provider).not.toMatch(/control_provider_(?:upsert|complete)[^(]*\([^)]*serde_json::Value/);
    expect(provider).toMatch(/control_operator_submit[\s\S]*standalone_control_request/);
    expect(provider).toMatch(/control_state[\s\S]*standalone_control_request/);
    expect(provider).not.toMatch(/control_operator_submit[\s\S]{0,800}connection_for/);
  });

  it('clears pending effects on stop and reconnect', () => {
    expect(provider).toMatch(/fn clear_pending/);
    expect(provider.match(/clear_pending\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(provider).toContain('MAX_PENDING_REQUESTS');
    expect(provider).toMatch(/responses\.len\(\) >= MAX_PENDING_REQUESTS/);
    expect(provider).toMatch(/struct PendingResponse[\s\S]*expected_type/);
    expect(provider).toMatch(/frame_type == response\.expected_type/);
  });

  it('returns the canonical resource generation to the desktop after upsert', () => {
    expect(provider).toMatch(/control_provider_upsert[\s\S]*Result<BrowserTabResource, String>/);
    expect(provider).toMatch(/send_request[\s\S]*\.get\("resource"\)/);
    expect(lib).toContain('control_provider_upsert');
    expect(readFileSync(new URL(
      '../native/desktop/psyche-build-tauri/web/main.js', import.meta.url,
    ), 'utf8')).toMatch(/control_provider_upsert[\s\S]{0,500}controlGeneration\s*=\s*canonical\.generation/);
  });

  it('registers the provider manager and cryptographic dependencies', () => {
    expect(lib).toContain('mod control_provider;');
    expect(lib).toContain('.manage(ControlProviderState::default())');
    expect(cargo).toContain('sha2 = "0.10"');
    expect(cargo).toContain('base64 = "0.22"');
  });

  it('rejects every control command from non-main webviews before authority access', () => {
    for (const command of [
      'control_provider_start', 'control_provider_stop', 'control_provider_upsert',
      'control_provider_remove', 'control_provider_complete', 'control_operator_submit',
      'control_state',
    ]) {
      expect(provider).toMatch(new RegExp(
        `fn ${command}[\\s\\S]{0,500}webview: tauri::Webview[\\s\\S]{0,250}`
          + 'ensure_trusted_control_caller\\(webview.label\\(\\)\\)\\?;',
      ));
    }
    expect(provider).toContain('ensure_trusted_control_caller("psyche-browser-untrusted")');
    expect(capability.windows).toEqual(['main']);
  });

  it('gates every browser command that can target a child view to the trusted main webview first', () => {
    for (const command of [
      'browser_navigate', 'browser_set_bounds', 'browser_hide', 'browser_hide_all_except',
      'browser_destroy', 'browser_destroy_many', 'browser_reload', 'browser_eval', 'browser_snapshot',
    ]) {
      expect(lib).toMatch(new RegExp(
        `fn ${command}\\([\\s\\S]{0,300}webview: tauri::Webview[\\s\\S]{0,220}\\{\\n\\s*ensure_trusted_browser_caller\\(webview.label\\(\\)\\)\\?;`,
      ));
    }
    expect(lib).toContain('ensure_trusted_browser_caller("psyche-browser-untrusted")');
  });

  it('pre-bounds screenshot pixels and reserves base64 JSON wire overhead', () => {
    expect(lib).toContain('MAX_BROWSER_SNAPSHOT_PIXELS');
    expect(lib).toContain('MAX_BROWSER_SNAPSHOT_DIMENSION');
    expect(lib).toMatch(/MAX_BROWSER_SNAPSHOT_BYTES[^=]*=\s*\(MAX_PROVIDER_RESULT_BYTES\s*-\s*MAX_BROWSER_SNAPSHOT_JSON_OVERHEAD\)\s*\/\s*4\s*\*\s*3/);
    expect(lib).toMatch(/validate_browser_snapshot_dimensions[\s\S]*checked_mul/);
    expect(lib).toMatch(/browser_snapshot[\s\S]*validate_browser_snapshot_dimensions[\s\S]*takeSnapshotWithConfiguration/);
  });

  it('implements Unix and Windows control endpoint transports', () => {
    expect(provider).toContain('#[cfg(unix)]');
    expect(provider).toContain('UnixStream');
    expect(provider).toContain('#[cfg(windows)]');
    expect(provider).toContain('ClientOptions');
    expect(provider).toContain('psyche-control-');
    expect(provider).toMatch(/async fn connect_control/);
    expect(provider).toContain('FILE_FLAG_OPEN_REPARSE_POINT');
  });

  it('provides an explicit provider shutdown lifecycle', () => {
    expect(provider).toContain('control_provider_shutdown');
    expect(lib).toContain('control_provider_shutdown');
    expect(provider).toMatch(/control_provider_shutdown[\s\S]*task\.abort\(\)[\s\S]*task\.await/);
    expect(provider).toContain('impl Drop for ControlProviderState');
  });
});
