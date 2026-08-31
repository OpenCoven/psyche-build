import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const mainJs = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/web/main.js'),
  'utf8',
);
const covenSessionsRs = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/src-tauri/src/coven_sessions.rs'),
  'utf8',
);
const workspaceModel = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/web/workspace/workspace-model.mjs'),
  'utf8',
);

function functionSource(name: string) {
  const asyncStart = mainJs.indexOf(`async function ${name}(`);
  const syncStart = mainJs.indexOf(`function ${name}(`);
  const start = asyncStart === -1 ? syncStart : asyncStart;
  if (start === -1) throw new Error(`missing function ${name}`);
  const bodyStart = mainJs.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < mainJs.length; index += 1) {
    if (mainJs[index] === '{') depth += 1;
    if (mainJs[index] === '}') depth -= 1;
    if (depth === 0) return mainJs.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function compileFunction<T extends (...args: never[]) => unknown>(
  source: string,
  dependencies: Record<string, unknown>,
) {
  const names = Object.keys(dependencies);
  const values = Object.values(dependencies);
  return Function(...names, `"use strict"; return (${source});`)(...values) as T;
}

describe('Coven launch adapter compatibility profile', () => {
  it('pins one immutable daemon API version across the JS and Rust launch contract', () => {
    const jsVersion = mainJs.match(/var COVEN_LAUNCH_API_VERSION = "([^"]+)";/)?.[1];
    const rustVersion = covenSessionsRs.match(/const STABLE_API_VERSION: &str = "([^"]+)";/)?.[1];
    expect(jsVersion).toBe('coven.daemon.v1');
    expect(rustVersion).toBe('coven.daemon.v1');
    expect(jsVersion).toBe(rustVersion);
    expect(functionSource('refreshCovenLaunchCapabilities')).toContain(
      'normalized.apiVersion !== COVEN_LAUNCH_API_VERSION',
    );
  });

  it('transports the composer prompt in the daemon launch body, never in argv', () => {
    const spawnAgentThread = functionSource('spawnAgentThread');
    expect(spawnAgentThread).toContain('invoke("coven_launch_session"');
    expect(spawnAgentThread).toContain('prompt: userPrompt');
    expect(spawnAgentThread).not.toContain('args.push');
    expect(spawnAgentThread).toMatch(
      /args: \["attach", launchResult\.sessionId\]/,
    );

    const rustLaunch = covenSessionsRs;
    expect(rustLaunch).toContain('"/api/v1/sessions"');
    expect(rustLaunch).toContain('Content-Type: application/json');
    expect(rustLaunch).toMatch(
      /fn launch_request_body\(request: &CovenLaunchRequest\) -> Result<Vec<u8>, String> \{[\s\S]*"prompt"/,
    );
    // The daemon would otherwise default the session title to the prompt.
    expect(rustLaunch).toMatch(
      /_ => format!\("Coven \{\}", request\.harness\),/,
    );
  });

  it('bounds the prompt channel on both sides of the adapter', () => {
    const rustPromptMax = covenSessionsRs.match(
      /const MAX_PROMPT_CHARS: usize = ([0-9_]+);/,
    )?.[1];
    const jsPromptMax = mainJs.match(
      /var COVEN_LAUNCH_PROMPT_MAX_CHARS = ([0-9_]+);/,
    )?.[1];
    expect(rustPromptMax).toBe('8_192');
    expect(jsPromptMax).toBe('8192');
    expect(covenSessionsRs).toContain(
      'fn validate_launch_request(',
    );
    expect(covenSessionsRs).toContain('Result<CovenLaunchRequest, String>');
    expect(functionSource('spawnAgentThread')).toContain(
      'COVEN_LAUNCH_PROMPT_MAX_CHARS',
    );
  });

  it('persists only the canonical Coven session identity, never prompt text', () => {
    const sanitizeSource = workspaceModel.slice(
      workspaceModel.indexOf('export function sanitizeSessionDescriptor'),
      workspaceModel.indexOf('export function sanitizePaneTree'),
    );
    expect(sanitizeSource).toContain("launchKind === 'coven-attach'");
    expect(sanitizeSource).toContain('covenSessionId');
    expect(sanitizeSource).not.toMatch(/prompt/i);
    // The in-memory launch model may carry a bounded digest only.
    expect(functionSource('covenPromptDigest')).toMatch(/sha256:/);
    const createThread = functionSource('createThread');
    expect(createThread).toContain('promptDigest');
    expect(createThread).not.toMatch(/userPrompt|rawPrompt/);
  });

  it('distinguishes accepted, spawned, running, failed, and recovery_required states', () => {
    expect(mainJs).toMatch(
      /var COVEN_LAUNCH_STATES = \[\s*"accepted",\s*"spawned",\s*"running",\s*"failed",\s*"recovery_required",\s*\];/,
    );
    const outcome = functionSource('covenLaunchOutcome');
    expect(outcome).toContain('"accepted"');
    expect(outcome).toContain('"recovery_required"');
    expect(outcome).toContain('"failed"');
  });

  it('gates provider options on capabilities confirmed by the selected executable', () => {
    expect(covenSessionsRs).toContain('coven_binary, ADAPTER_LIST_TIMEOUT');
    expect(covenSessionsRs).toContain('parse_adapter_list');
    const gate = functionSource('covenLaunchGate');
    expect(gate).toContain('is not offered by this Coven executable');
    expect(gate).toContain('is unavailable in Coven');
    expect(gate).toContain('Checking Coven capabilities');
    const render = functionSource('renderAgentPicker');
    expect(render).toContain('covenLaunchGate(entry)');
    expect(render).toContain('aria-disabled');
    // Prompt submission is gated before any launch exchange.
    expect(functionSource('launchSelectedAgent')).toMatch(
      /var gate = covenLaunchGate\(entry\);\s*if \(gate\) \{/,
    );
  });

  it('normalizes daemon capability snapshots defensively', () => {
    const normalize = compileFunction<
      (payload: unknown) => Record<string, unknown> | null
    >(functionSource('normalizeCovenLaunchCapabilities'), {});

    expect(normalize(null)).toBeNull();
    expect(normalize('nope')).toBeNull();
    expect(normalize({})).toBeNull();
    expect(
      normalize({
        status: 'ready',
        apiVersion: 'coven.daemon.v1',
        adapters: [
          { id: 'codex', label: 'Codex', available: true, source: 'bundled' },
          { id: 'broken' },
          null,
          { id: 'grok', label: 'Grok Build', available: false },
        ],
        message: null,
      }),
    ).toEqual({
      status: 'ready',
      apiVersion: 'coven.daemon.v1',
      adapters: [
        { id: 'codex', label: 'Codex', available: true },
        { id: 'broken', label: 'broken', available: false },
        { id: 'grok', label: 'Grok Build', available: false },
      ],
      message: null,
    });
  });

  it('fails closed on unavailable or incompatible daemons with recovery guidance', () => {
    const failureStatus = functionSource('covenLaunchFailureStatus');
    expect(failureStatus).toContain('coven daemon start');
    expect(covenSessionsRs).toContain(
      'const UNAVAILABLE_MESSAGE: &str = "Coven daemon is not running; run `coven daemon start`";',
    );
    expect(covenSessionsRs).toContain(
      'const INCOMPATIBLE_MESSAGE: &str = "Coven daemon API update required";',
    );
  });
});
