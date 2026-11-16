import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';

const security = readFileSync(new URL('../docs/BRIDGE-SECURITY.md', import.meta.url), 'utf8');

// Claim guards for #505. These verify the documentation, not the runtime's
// security properties. Production authority and transport tests remain separate.
describe('bridge security documentation truthfulness', () => {
  it('routes vulnerability reports privately rather than to public issues', () => {
    assert.match(security, /\[SECURITY\.md\]\(\.\.\/SECURITY\.md\)/);
    assert.match(security, /https:\/\/github\.com\/OpenCoven\/psyche-build\/security\/advisories\/new/);
    assert.doesNotMatch(security, /Security issues in this repository:.*\/issues/);
    assert.match(security, /Do not post vulnerabilities/);
  });
  it('distinguishes the canonical local control socket from both WebSockets', () => {
    assert.match(security, /Canonical control IPC/);
    assert.match(security, /src\/control\/server\.ts/);
    assert.match(security, /Unix socket or Windows named pipe/);
  });
  it('does not treat a per-user legacy token as project-isolated credentials', () => {
    assert.match(security, /per-user, operator-equivalent/);
    assert.match(security, /same token can authenticate to other daemon instances/);
    assert.match(security, /Authentication is not authorization/);
  });
  it('reports production operator and provider refusals instead of implying live grants', () => {
    assert.match(security, /operator_authority_unavailable/);
    assert.match(security, /provider_authority_unavailable/);
    assert.match(security, /trusted-test-only.*not a production workaround/);
  });
  it('limits the timing-safe claim to implementations that actually use it', () => {
    assert.match(security, /TokenStore\.validate/);
    assert.match(security, /ordinary JavaScript string equality/);
    assert.doesNotMatch(security, /Code and\ntoken comparisons use `timingSafeEqual`/);
  });
  it('distinguishes first-pair TOFU from authenticated identity binding', () => {
    assert.match(security, /trust on first use \(TOFU\)/);
    assert.match(security, /pairing code does not cryptographically bind/);
    assert.match(security, /Bonjour/);
  });
  it('does not mistake frame limits for unauthenticated connection bounds', () => {
    assert.match(security, /no application-level idle authentication deadline/);
    assert.match(security, /no pre-authentication connection cap/);
    assert.match(security, /4 MiB.*128 frames.*8 MiB/);
  });
});
