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

describe('Tauri browser control provider contract', () => {
  it('derives the endpoint from canonical-root SHA-256 first 20 hex characters', () => {
    expect(provider).toMatch(/canonicalize\(/);
    expect(provider).toMatch(/Sha256::digest/);
    expect(provider).toMatch(/\.take\(20\)/);
    expect(provider).toContain('.psyche/runtime/sockets');
  });

  it('reads only the operator token from a 0600 credential file', () => {
    expect(provider).toContain('control-credentials.json');
    expect(provider).toMatch(/permissions\(\)\.mode\(\) & 0o777 != 0o600/);
    expect(provider).toMatch(/struct StoredCredentials[\s\S]*operator_token: String/);
    expect(provider).not.toMatch(/agent_token\s*:/);
  });

  it('writes hello and provider registration before any resource frames', () => {
    expect(provider).toMatch(/fn send_handshake[\s\S]*OutboundFrame::Hello[\s\S]*OutboundFrame::Register/);
    expect(provider).toMatch(/send_handshake\(&mut stream[\s\S]*\.await\?;[\s\S]*mpsc::channel/);
    expect(provider).toMatch(/expect_handshake_response[\s\S]*"welcome"[\s\S]*"ack"/);
  });

  it('emits bounded typed effect requests to the main webview', () => {
    expect(provider).toContain('control:provider-effect-request');
    expect(provider).toMatch(/ProviderEffectRequest/);
    expect(provider).toMatch(/MAX_PROVIDER_LINE_BYTES/);
    expect(provider).toMatch(/MAX_PROVIDER_RESULT_BYTES/);
  });

  it('exposes typed commands and a closed operator command enum', () => {
    for (const command of [
      'control_provider_start', 'control_provider_stop', 'control_provider_upsert',
      'control_provider_remove', 'control_provider_complete', 'control_operator_submit',
      'control_state',
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
    expect(provider).toMatch(/responses\.lock\(\)\.len\(\) >= MAX_PENDING_REQUESTS/);
  });

  it('registers the provider manager and cryptographic dependencies', () => {
    expect(lib).toContain('mod control_provider;');
    expect(lib).toContain('.manage(ControlProviderState::default())');
    expect(cargo).toContain('sha2 = "0.10"');
    expect(cargo).toContain('base64 = "0.22"');
  });
});
