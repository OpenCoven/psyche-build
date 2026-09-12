import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { collectOperatorPreflight, parsePreflightArguments, probeTool } from '../scripts/operator-preflight.mjs';

describe('operator preflight', () => {
  it('normalizes aliases without claiming artifact observation or acceptance', () => {
    const report = collectOperatorPreflight({
      platform: 'darwin', architecture: 'arm64', artifactArchitecture: 'aarch64',
      checkTool: () => 'available',
    });
    expect(report.host).toEqual({ platform: 'macos', architecture: 'aarch64' });
    expect(report.artifact).toEqual({ architecture: 'aarch64', source: 'operator_declared', compatibility: 'matches' });
    expect(report.uiAutomationPermission).toBe('unknown');
    expect(report.disposableContext).toBe('unverified');
    expect(report.productScenarios).toHaveLength(14);
    expect(report.productScenarios.every(s => s.status === 'not_observed')).toBe(true);
    expect(report.acceptance).toBe('not_observed');
  });

  it('separates actionable setup blockers from unknown observations', () => {
    const report = collectOperatorPreflight({
      platform: 'darwin', architecture: 'x64', artifactArchitecture: 'arm64',
      checkTool: tool => tool === 'tmux' ? 'missing' : 'probe_failed',
    });
    expect(report.setupBlockers).toContain('artifact_architecture_mismatch');
    expect(report.setupBlockers).toContain('tmux_missing');
    expect(report.setupBlockers).toContain('git_probe_failed');
    expect(report.setupBlockers).not.toContain('permission_unknown');
  });

  it('leaves absent artifact and unsupported host observations explicit', () => {
    const checkTool = vi.fn(() => 'available' as const);
    const report = collectOperatorPreflight({ platform: 'win32', architecture: 'riscv64', checkTool });
    expect(report.host).toEqual({ platform: 'unsupported', architecture: 'unknown' });
    expect(report.artifact.compatibility).toBe('not_observed');
    expect(report.setupBlockers).toContain('unsupported_host');
    expect(checkTool).not.toHaveBeenCalled();
  });

  it('accepts only a bounded architecture option, never paths or safety assertions', () => {
    expect(parsePreflightArguments(['--', '--artifact-arch', 'x64'])).toBe('x86_64');
    for (const args of [['/private/secret'], ['--artifact-arch'], ['--artifact-arch', 'secret'],
      ['--disposable'], ['--artifact-arch', 'x64', '--artifact-arch', 'arm64'], ['x'.repeat(10000)]]) {
      expect(() => parsePreflightArguments(args)).toThrow('invalid_arguments');
    }
  });

  it('bounds shell execution and discards output without executing discovered tools', () => {
    const run = vi.fn(() => ({ status: 0 }));
    expect(probeTool('git', run)).toBe('available');
    expect(run).toHaveBeenCalledWith('/bin/sh', ['-c', 'command -v git >/dev/null 2>&1'], expect.objectContaining({
      timeout: 1000, killSignal: 'SIGKILL', maxBuffer: 1024, stdio: 'ignore',
    }));
    expect(probeTool('tmux', () => ({ status: 1 }))).toBe('missing');
    expect(probeTool('tmux', () => ({ status: null, error: new Error('private') }))).toBe('probe_failed');
    expect(() => probeTool('secret')).toThrow('invalid_tool');
  });

  it('rejects CLI input with only a fixed error and no report', () => {
    const result = spawnSync(process.execPath, ['scripts/operator-preflight.mjs', '/private/secret'], { encoding: 'utf8' });
    expect(result.status).toBe(64);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('operator-preflight: invalid_arguments\n');
  });
});
