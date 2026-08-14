import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { BrowserProviderBroker } from '../src/control/browserProviderBroker.js';
import { SurfaceRegistry } from '../src/control/surfaces.js';
import { ControlServer, type ControlServerRuntime } from '../src/control/server.js';
import { createControlCredentialStore } from '../src/control/credentials.js';
import { CONTROL_WIRE_LIMITS } from '../src/control/limits.js';

function resource(providerId = 'desktop-1') {
  return {
    id: 'tab-1', kind: 'browser_tab' as const, generation: 1,
    projectRoot: '/repo', worktreeRoot: '/repo', providerId,
    webviewLabel: 'browser-main', url: 'https://example.com', title: 'Example',
    loading: false, viewport: { width: 1200, height: 800 },
  };
}

function harness() {
  const surfaces = new SurfaceRegistry();
  const revoked: unknown[] = [];
  const broker = new BrowserProviderBroker({
    projectRoot: '/repo', surfaces,
    revokeSurfaceAuthority: (target) => revoked.push(target),
    canonicalizePath: (candidate) => candidate,
  });
  const sent: unknown[] = [];
  const connection = broker.register('desktop-1', (frame) => { sent.push(frame); return true; });
  return { broker, connection, surfaces, revoked, sent };
}

describe('BrowserProviderBroker', () => {
  it('registers one provider, replaces it, and owns resource upsert/remove', async () => {
    const first = harness();
    await expect(first.connection.upsert(resource())).resolves.toMatchObject({ id: 'tab-1', generation: 1 });
    expect(first.surfaces.get('tab-1')).toMatchObject({ providerId: 'desktop-1' });

    first.connection.remove('tab-1', 1);
    expect(first.surfaces.get('tab-1')).toBeUndefined();
    expect(first.revoked).toEqual([{ kind: 'browser_tab', id: 'tab-1', generation: 1 }]);

    await first.connection.upsert(resource());
    const replacement = first.broker.register('desktop-2', () => true);
    expect(first.surfaces.get('tab-1')).toBeUndefined();
    await expect(first.connection.upsert(resource())).rejects.toThrowError(/provider is disconnected/);
    replacement.disconnect();
  });

  it('correlates one in-flight effect per tab to the exact provider request', async () => {
    const { broker, connection, sent } = harness();
    await connection.upsert(resource());
    const pending = broker.dispatch({
      actionId: 'action-1', tabId: 'tab-1', generation: 1,
      operation: { kind: 'inspect' },
    });
    expect(sent[0]).toMatchObject({
      version: 1, type: 'provider.effect.request', actionId: 'action-1',
      tabId: 'tab-1', generation: 1, operation: { kind: 'inspect' },
    });
    const requestId = (sent[0] as { requestId: string }).requestId;
    expect(() => connection.complete('wrong-request', {
      actionId: 'action-1', status: 'succeeded', value: {},
    })).toThrowError(/request correlation/);
    expect(() => connection.complete(requestId, {
      actionId: 'wrong-action', status: 'succeeded', value: {},
    })).toThrowError(/action correlation/);
    const second = broker.dispatch({
      actionId: 'action-2', tabId: 'tab-1', generation: 1,
      operation: { kind: 'action', action: { kind: 'reload' } },
    });
    expect(sent).toHaveLength(1);
    connection.complete(requestId, {
      actionId: 'action-1', status: 'succeeded', value: { snapshot: true },
    });
    await expect(pending).resolves.toEqual({
      actionId: 'action-1', status: 'succeeded', value: { snapshot: true },
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const secondRequestId = (sent[1] as { requestId: string }).requestId;
    connection.complete(secondRequestId, { actionId: 'action-2', status: 'succeeded' });
    await expect(second).resolves.toMatchObject({ actionId: 'action-2', status: 'succeeded' });
  });

  it('times out ambiguously, fences the tab, and only late completion clears it', async () => {
    vi.useFakeTimers();
    try {
      const { broker, connection, sent } = harness();
      await connection.upsert(resource());
      const pending = broker.dispatch({
        actionId: 'action-timeout', tabId: 'tab-1', generation: 1,
        operation: { kind: 'script', source: '1', expectedContext: {
          documentId: 'document-1', documentToken: 'token-1', navigationEpoch: 1,
          navigationUrl: 'https://example.test',
        } },
      });
      const assertion = expect(pending).rejects.toMatchObject({ code: 'action_timeout', ambiguous: true, noRetry: true });
      const request = sent[0] as any;
      connection.started(request.requestId, { actionId: 'action-timeout', tabId: 'tab-1', generation: 1,
        invocationId: request.requestId, documentToken: 'token-1' });
      connection.executing(request.requestId, { actionId: 'action-timeout', tabId: 'tab-1', generation: 1,
        invocationId: request.requestId, documentToken: 'token-1' });
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
      expect(sent[1]).toMatchObject({ type: 'provider.effect.cancel', actionId: 'action-timeout', reason: 'timeout' });
      await expect(broker.dispatch({ actionId: 'blocked', tabId: 'tab-1', generation: 1,
        operation: { kind: 'inspect' } })).rejects.toMatchObject({ code: 'effect_in_flight' });
      await connection.upsert({ ...resource(), id: 'tab-2', webviewLabel: 'browser-second' });
      const independent = broker.dispatch({ actionId: 'independent', tabId: 'tab-2', generation: 1,
        operation: { kind: 'inspect' } });
      const independentFrame = sent.find((frame: any) => frame.actionId === 'independent') as any;
      connection.complete(independentFrame.requestId, { actionId: 'independent', status: 'succeeded' });
      await expect(independent).resolves.toMatchObject({ status: 'succeeded' });
      const requestId = (sent[0] as { requestId: string }).requestId;
      connection.complete(requestId, { actionId: 'action-timeout', status: 'succeeded' });
      expect(() => connection.complete(requestId, {
        actionId: 'action-timeout', status: 'succeeded',
      })).toThrowError(expect.objectContaining({ code: 'request_correlation_mismatch' }));
      const next = broker.dispatch({ actionId: 'after-late', tabId: 'tab-1', generation: 1,
        operation: { kind: 'inspect' } });
      const nextRequestId = (sent.find((frame: any) => frame.actionId === 'after-late') as { requestId: string }).requestId;
      connection.complete(nextRequestId, { actionId: 'after-late', status: 'succeeded' });
      await expect(next).resolves.toMatchObject({ actionId: 'after-late', status: 'succeeded' });
      expect(() => connection.complete('unknown', {
        actionId: 'after-late', status: 'succeeded',
      })).toThrowError(expect.objectContaining({ code: 'request_correlation_mismatch' }));
      connection.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts the exact five-second budget only after correlated native evaluation starts', async () => {
    vi.useFakeTimers();
    try {
      const { broker, connection, sent } = harness();
      await connection.upsert(resource());
      const pending = broker.dispatch({ actionId: 'queued-script', tabId: 'tab-1', generation: 1,
        operation: { kind: 'script', source: 'return 1', expectedContext: {
          documentId: 'document-1', documentToken: 'token-1', navigationEpoch: 1,
          navigationUrl: 'https://example.test',
        } } });
      await vi.advanceTimersByTimeAsync(10_000);
      const request = sent[0] as any;
      expect(() => connection.started(request.requestId, { actionId: 'queued-script', tabId: 'tab-1', generation: 1,
        invocationId: request.requestId, documentToken: 'wrong-token' }))
        .toThrowError(expect.objectContaining({ code: 'request_correlation_mismatch' }));
      connection.started(request.requestId, { actionId: 'queued-script', tabId: 'tab-1', generation: 1,
        invocationId: request.requestId, documentToken: 'token-1' });
      connection.executing(request.requestId, { actionId: 'queued-script', tabId: 'tab-1', generation: 1,
        invocationId: request.requestId, documentToken: 'token-1' });
      await vi.advanceTimersByTimeAsync(4_999);
      connection.complete(request.requestId, { actionId: 'queued-script', status: 'succeeded',
        value: { value: 1, byteCount: 1, durationMs: 4_999 } });
      await expect(pending).resolves.toMatchObject({ status: 'succeeded' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects completion before execution and duplicate or mismatched execution frames', async () => {
    const { broker, connection, sent } = harness();
    await connection.upsert(resource());
    const pending = broker.dispatch({ actionId: 'ordered-script', tabId: 'tab-1', generation: 1,
      operation: { kind: 'script', source: 'return 1', expectedContext: {
        documentId: 'document-1', documentToken: 'token-1', navigationEpoch: 1,
        navigationUrl: 'https://example.test',
      } } });
    const request = sent[0] as any;
    connection.started(request.requestId, { actionId: 'ordered-script', tabId: 'tab-1', generation: 1,
      invocationId: request.requestId, documentToken: 'token-1' });
    expect(() => connection.complete(request.requestId, { actionId: 'ordered-script', status: 'succeeded' }))
      .toThrowError(expect.objectContaining({ code: 'request_correlation_mismatch' }));
    expect(() => connection.executing(request.requestId, { actionId: 'ordered-script', tabId: 'tab-1', generation: 1,
      invocationId: request.requestId, documentToken: 'wrong-token' }))
      .toThrowError(expect.objectContaining({ code: 'request_correlation_mismatch' }));
    connection.executing(request.requestId, { actionId: 'ordered-script', tabId: 'tab-1', generation: 1,
      invocationId: request.requestId, documentToken: 'token-1' });
    expect(() => connection.executing(request.requestId, { actionId: 'ordered-script', tabId: 'tab-1', generation: 1,
      invocationId: request.requestId, documentToken: 'token-1' }))
      .toThrowError(expect.objectContaining({ code: 'request_correlation_mismatch' }));
    connection.complete(request.requestId, { actionId: 'ordered-script', status: 'succeeded' });
    await expect(pending).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('rejects impossible provider timeout and failed unknown results before settling the effect', async () => {
    const { broker, connection, sent } = harness();
    await connection.upsert(resource());
    const pending = broker.dispatch({ actionId: 'validated-script', tabId: 'tab-1', generation: 1,
      operation: { kind: 'script', source: 'return 1', expectedContext: {
        documentId: 'document-1', documentToken: 'token-1', navigationEpoch: 1,
        navigationUrl: 'https://example.test',
      } } });
    const request = sent[0] as any;
    connection.started(request.requestId, { actionId: 'validated-script', tabId: 'tab-1', generation: 1,
      invocationId: request.requestId, documentToken: 'token-1' });
    connection.executing(request.requestId, { actionId: 'validated-script', tabId: 'tab-1', generation: 1,
      invocationId: request.requestId, documentToken: 'token-1' });
    for (const result of [
      { actionId: 'validated-script', status: 'failed' as const, code: 'action_timeout', message: 'bad' },
      { actionId: 'validated-script', status: 'failed' as const, code: 'action_timeout', message: 'bad', durationMs: 1 },
      { actionId: 'validated-script', status: 'failed' as const, code: 'effect_unknown', message: 'bad', durationMs: 1 },
    ]) {
      expect(() => connection.complete(request.requestId, result))
        .toThrowError(expect.objectContaining({ code: 'invalid_provider_result' }));
    }
    connection.complete(request.requestId, { actionId: 'validated-script', status: 'failed',
      code: 'script_execution_failed', message: 'failed', durationMs: 5_000 });
    await expect(pending).resolves.toMatchObject({ status: 'failed', code: 'script_execution_failed' });
  });

  it('fails safely when native evaluation is never prepared', async () => {
    vi.useFakeTimers();
    try {
      const { broker, connection, sent } = harness();
      await connection.upsert(resource());
      const pending = broker.dispatch({ actionId: 'never-started', tabId: 'tab-1', generation: 1,
        operation: { kind: 'script', source: 'return 1', expectedContext: {
          documentId: 'document-1', documentToken: 'token-1', navigationEpoch: 1,
          navigationUrl: 'https://example.test',
        } } });
      const request = sent[0] as any;
      expect(() => connection.complete(request.requestId, { actionId: 'never-started', status: 'unknown_pending',
        code: 'effect_unknown', message: 'impossible', ambiguous: true, durationMs: 0 }))
        .toThrowError(expect.objectContaining({ code: 'request_correlation_mismatch' }));
      const assertion = expect(pending).rejects.toMatchObject({ code: 'provider_unavailable', durationMs: 0 });
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains a prepared script ambiguity until its exact late terminal', async () => {
    vi.useFakeTimers();
    try {
      const { broker, connection, sent, revoked } = harness();
      await connection.upsert(resource());
      await connection.upsert({ ...resource(), id: 'tab-2', webviewLabel: 'browser-second' });
      const pending = broker.dispatch({ actionId: 'prepared-near-watchdog', tabId: 'tab-1', generation: 1,
        operation: { kind: 'script', source: 'return 1', expectedContext: {
          documentId: 'document-1', documentToken: 'token-1', navigationEpoch: 1,
          navigationUrl: 'https://example.test',
        } } });
      const request = sent.find((frame: any) => frame.actionId === 'prepared-near-watchdog') as any;
      await vi.advanceTimersByTimeAsync(14_999);
      connection.started(request.requestId, { actionId: 'prepared-near-watchdog', tabId: 'tab-1', generation: 1,
        invocationId: request.requestId, documentToken: 'token-1' });
      const assertion = expect(pending).rejects.toMatchObject({
        code: 'effect_unknown', ambiguous: true, noRetry: true, durationMs: 0,
      });
      await vi.advanceTimersByTimeAsync(1);
      await assertion;

      await expect(broker.dispatch({ actionId: 'blocked', tabId: 'tab-1', generation: 1,
        operation: { kind: 'inspect' } })).rejects.toMatchObject({ code: 'effect_in_flight' });
      const independent = broker.dispatch({ actionId: 'independent', tabId: 'tab-2', generation: 1,
        operation: { kind: 'inspect' } });
      const independentRequest = sent.find((frame: any) => frame.actionId === 'independent') as any;
      connection.complete(independentRequest.requestId, { actionId: 'independent', status: 'succeeded' });
      await expect(independent).resolves.toMatchObject({ status: 'succeeded' });
      expect(revoked).toEqual([]);

      connection.complete(request.requestId, { actionId: 'prepared-near-watchdog', status: 'unknown_pending',
        code: 'effect_unknown', message: 'execution acknowledgement was lost', ambiguous: true, durationMs: 0 });
      connection.complete(request.requestId, { actionId: 'prepared-near-watchdog', status: 'unknown',
        code: 'effect_unknown', message: 'late native callback', ambiguous: true, durationMs: 1 });

      const next = broker.dispatch({ actionId: 'after-terminal', tabId: 'tab-1', generation: 1,
        operation: { kind: 'inspect' } });
      const nextRequest = sent.find((frame: any) => frame.actionId === 'after-terminal') as any;
      expect(() => connection.complete(request.requestId, { actionId: 'prepared-near-watchdog', status: 'unknown',
        code: 'effect_unknown', message: 'stale callback', ambiguous: true, durationMs: 2 }))
        .toThrowError(expect.objectContaining({ code: 'request_correlation_mismatch' }));
      connection.complete(nextRequest.requestId, { actionId: 'after-terminal', status: 'succeeded' });
      await expect(next).resolves.toMatchObject({ status: 'succeeded' });
      expect(revoked).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts late exact executing only to release an already-unknown fence', async () => {
    vi.useFakeTimers();
    try {
      const { broker, connection, sent } = harness();
      await connection.upsert(resource());
      const pending = broker.dispatch({ actionId: 'late-executing', tabId: 'tab-1', generation: 1,
        operation: { kind: 'script', source: 'return 1', expectedContext: {
          documentId: 'document-1', documentToken: 'token-1', navigationEpoch: 1,
          navigationUrl: 'https://example.test',
        } } });
      const request = sent[0] as any;
      connection.started(request.requestId, { actionId: 'late-executing', tabId: 'tab-1', generation: 1,
        invocationId: request.requestId, documentToken: 'token-1' });
      const assertion = expect(pending).rejects.toMatchObject({ code: 'effect_unknown', noRetry: true });
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      expect(() => connection.executing(request.requestId, { actionId: 'late-executing', tabId: 'tab-1', generation: 1,
        invocationId: request.requestId, documentToken: 'token-1' })).not.toThrow();
      await expect(broker.dispatch({ actionId: 'still-blocked', tabId: 'tab-1', generation: 1,
        operation: { kind: 'inspect' } })).rejects.toMatchObject({ code: 'effect_in_flight' });
      connection.complete(request.requestId, { actionId: 'late-executing', status: 'succeeded' });
      const next = broker.dispatch({ actionId: 'released', tabId: 'tab-1', generation: 1,
        operation: { kind: 'inspect' } });
      const nextRequest = sent.find((frame: any) => frame.actionId === 'released') as any;
      connection.complete(nextRequest.requestId, { actionId: 'released', status: 'succeeded' });
      await expect(next).resolves.toMatchObject({ status: 'succeeded' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets an exact replacement terminal buffered before five seconds win', async () => {
    vi.useFakeTimers();
    try {
      const { broker, connection, sent } = harness();
      await connection.upsert(resource());
      const pending = broker.dispatch({ actionId: 'replacement-at-deadline', tabId: 'tab-1', generation: 1,
        operation: { kind: 'script', source: 'new Promise(() => {})', expectedContext: {
          documentId: 'document-1', documentToken: 'token-1', navigationEpoch: 1,
          navigationUrl: 'https://example.test',
        } } });
      const request = sent.find((frame: any) => frame.actionId === 'replacement-at-deadline') as any;
      connection.started(request.requestId, { actionId: 'replacement-at-deadline', tabId: 'tab-1', generation: 1,
        invocationId: request.requestId, documentToken: 'token-1' });
      connection.executing(request.requestId, { actionId: 'replacement-at-deadline', tabId: 'tab-1', generation: 1,
        invocationId: request.requestId, documentToken: 'token-1' });
      await vi.advanceTimersByTimeAsync(4_999);
      connection.complete(request.requestId, { actionId: 'replacement-at-deadline', status: 'unknown',
        code: 'effect_unknown', message: 'document replaced at deadline', ambiguous: true });
      await expect(pending).resolves.toMatchObject({ status: 'unknown', code: 'effect_unknown' });
      await vi.advanceTimersByTimeAsync(1);
      expect(sent.filter((frame: any) => frame.type === 'provider.effect.cancel')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a native script deadline as nonterminal until late completion', async () => {
    const { broker, connection, sent } = harness();
    await connection.upsert(resource());
    await connection.upsert({ ...resource(), id: 'tab-2', webviewLabel: 'browser-second' });
    const pending = broker.dispatch({ actionId: 'native-timeout', tabId: 'tab-1', generation: 1,
      operation: { kind: 'script', source: 'new Promise(() => {})', expectedContext: {
        documentId: 'document-1', documentToken: 'token-1', navigationEpoch: 1,
        navigationUrl: 'http://192.168.1.20/',
      } } });
    const requestId = (sent[0] as { requestId: string }).requestId;
    connection.started(requestId, { actionId: 'native-timeout', tabId: 'tab-1', generation: 1,
      invocationId: requestId, documentToken: 'token-1' });
    connection.executing(requestId, { actionId: 'native-timeout', tabId: 'tab-1', generation: 1,
      invocationId: requestId, documentToken: 'token-1' });
    connection.complete(requestId, { actionId: 'native-timeout', status: 'timed_out_pending',
      code: 'action_timeout', message: 'browser script exceeded the execution deadline', durationMs: 5_000 });
    await expect(pending).rejects.toMatchObject({ code: 'action_timeout', noRetry: true });
    await expect(broker.dispatch({ actionId: 'blocked', tabId: 'tab-1', generation: 1,
      operation: { kind: 'inspect' } })).rejects.toMatchObject({ code: 'effect_in_flight' });
    const independent = broker.dispatch({ actionId: 'independent', tabId: 'tab-2', generation: 1,
      operation: { kind: 'inspect' } });
    const independentRequest = sent.find((frame: any) => frame.actionId === 'independent') as any;
    connection.complete(independentRequest.requestId, { actionId: 'independent', status: 'succeeded' });
    await expect(independent).resolves.toMatchObject({ status: 'succeeded' });
    connection.complete(requestId, { actionId: 'native-timeout', status: 'unknown',
      code: 'effect_unknown', message: 'late native completion', ambiguous: true });
    const afterLate = broker.dispatch({ actionId: 'after-late', tabId: 'tab-1', generation: 1,
      operation: { kind: 'inspect' } });
    const afterLateRequest = sent.find((frame: any) => frame.actionId === 'after-late') as any;
    connection.complete(afterLateRequest.requestId, { actionId: 'after-late', status: 'succeeded' });
    await expect(afterLate).resolves.toMatchObject({ status: 'succeeded' });
    connection.disconnect();
  });

  it('terminalizes a delivered over-deadline callback without retaining a timeout fence', async () => {
    vi.useFakeTimers();
    try {
      const { broker, connection, sent } = harness();
      await connection.upsert(resource());
      const pending = broker.dispatch({ actionId: 'delivered-timeout', tabId: 'tab-1', generation: 1,
        operation: { kind: 'script', source: 'return 1', expectedContext: {
          documentId: 'document-1', documentToken: 'token-1', navigationEpoch: 1,
          navigationUrl: 'https://example.test',
        } } });
      const request = sent[0] as any;
      connection.started(request.requestId, { actionId: 'delivered-timeout', tabId: 'tab-1', generation: 1,
        invocationId: request.requestId, documentToken: 'token-1' });
      connection.executing(request.requestId, { actionId: 'delivered-timeout', tabId: 'tab-1', generation: 1,
        invocationId: request.requestId, documentToken: 'token-1' });
      connection.complete(request.requestId, { actionId: 'delivered-timeout', status: 'failed',
        code: 'action_timeout', message: 'callback completed after deadline', durationMs: 5_000 });
      await expect(pending).resolves.toMatchObject({ status: 'failed', code: 'action_timeout' });
      await vi.advanceTimersByTimeAsync(60_001);
      const next = broker.dispatch({ actionId: 'after-delivered-timeout', tabId: 'tab-1', generation: 1,
        operation: { kind: 'inspect' } });
      const nextRequest = sent.find((frame: any) => frame.actionId === 'after-delivered-timeout') as any;
      connection.complete(nextRequest.requestId, { actionId: 'after-delivered-timeout', status: 'succeeded' });
      await expect(next).resolves.toMatchObject({ status: 'succeeded' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a replacement terminal after timeout ACK rewrite action_timeout', async () => {
    vi.useFakeTimers();
    try {
      const { broker, connection, sent } = harness();
      await connection.upsert(resource());
      const pending = broker.dispatch({ actionId: 'replacement-during-timeout-ack', tabId: 'tab-1', generation: 1,
        operation: { kind: 'script', source: 'new Promise(() => {})', expectedContext: {
          documentId: 'document-1', documentToken: 'token-1', navigationEpoch: 1,
          navigationUrl: 'https://example.test',
        } } });
      const request = sent.find((frame: any) => frame.actionId === 'replacement-during-timeout-ack') as any;
      connection.started(request.requestId, { actionId: 'replacement-during-timeout-ack', tabId: 'tab-1', generation: 1,
        invocationId: request.requestId, documentToken: 'token-1' });
      connection.executing(request.requestId, { actionId: 'replacement-during-timeout-ack', tabId: 'tab-1', generation: 1,
        invocationId: request.requestId, documentToken: 'token-1' });
      connection.complete(request.requestId, { actionId: 'replacement-during-timeout-ack',
        status: 'timed_out_pending', code: 'action_timeout',
        message: 'browser script exceeded the execution deadline', durationMs: 5_000 });
      await expect(pending).rejects.toMatchObject({ code: 'action_timeout', noRetry: true });
      connection.complete(request.requestId, { actionId: 'replacement-during-timeout-ack', status: 'unknown',
        code: 'effect_unknown', message: 'document replaced at deadline', ambiguous: true });
      expect(sent.filter((frame: any) => frame.type === 'provider.effect.cancel')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminalizes only the removed timed-out tab without disconnecting unrelated tabs', async () => {
    vi.useFakeTimers();
    try {
      const { broker, connection, sent, surfaces } = harness();
      await connection.upsert(resource());
      await connection.upsert({ ...resource(), id: 'tab-2', webviewLabel: 'browser-second' });
      const timedOut = broker.dispatch({ actionId: 'timed-out-a', tabId: 'tab-1', generation: 1,
        operation: { kind: 'script', source: 'new Promise(() => {})', expectedContext: {
          documentId: 'document-a', documentToken: 'token-a', navigationEpoch: 1,
          navigationUrl: 'https://example.test/a',
        } } });
      const oldRequest = sent.find((frame: any) => frame.actionId === 'timed-out-a') as any;
      connection.started(oldRequest.requestId, { actionId: 'timed-out-a', tabId: 'tab-1', generation: 1,
        invocationId: oldRequest.requestId, documentToken: 'token-a' });
      connection.executing(oldRequest.requestId, { actionId: 'timed-out-a', tabId: 'tab-1', generation: 1,
        invocationId: oldRequest.requestId, documentToken: 'token-a' });
      connection.complete(oldRequest.requestId, { actionId: 'timed-out-a', status: 'timed_out_pending',
        code: 'action_timeout', message: 'browser script exceeded the execution deadline', durationMs: 5_000 });
      await expect(timedOut).rejects.toMatchObject({ code: 'action_timeout', noRetry: true });

      connection.remove('tab-1', 1);
      expect(surfaces.get('tab-1')).toBeUndefined();
      expect(() => connection.complete(oldRequest.requestId, { actionId: 'timed-out-a', status: 'unknown',
        code: 'effect_unknown', message: 'stale callback', ambiguous: true }))
        .toThrowError(expect.objectContaining({ code: 'request_correlation_mismatch' }));
      await vi.advanceTimersByTimeAsync(60_001);

      const independent = broker.dispatch({ actionId: 'still-usable-b', tabId: 'tab-2', generation: 1,
        operation: { kind: 'inspect' } });
      const independentRequest = sent.find((frame: any) => frame.actionId === 'still-usable-b') as any;
      connection.complete(independentRequest.requestId, { actionId: 'still-usable-b', status: 'succeeded' });
      await expect(independent).resolves.toMatchObject({ status: 'succeeded' });

      const replacement = await connection.upsert({ ...resource(), webviewLabel: 'browser-replacement' });
      expect(replacement.generation).toBe(2);
      const newer = broker.dispatch({ actionId: 'new-a', tabId: 'tab-1', generation: 2,
        operation: { kind: 'inspect' } });
      const newerRequest = sent.find((frame: any) => frame.actionId === 'new-a') as any;
      expect(() => connection.complete(oldRequest.requestId, { actionId: 'timed-out-a', status: 'unknown',
        code: 'effect_unknown', message: 'late old callback', ambiguous: true }))
        .toThrowError(expect.objectContaining({ code: 'request_correlation_mismatch' }));
      connection.complete(newerRequest.requestId, { actionId: 'new-a', status: 'succeeded' });
      await expect(newer).resolves.toMatchObject({ status: 'succeeded' });
      connection.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the provider and recreated tab usable after an exact late terminal', async () => {
    vi.useFakeTimers();
    try {
      const { broker, connection, sent } = harness();
      await connection.upsert(resource());
      await connection.upsert({ ...resource(), id: 'tab-2', webviewLabel: 'browser-second' });
      const timedOut = broker.dispatch({ actionId: 'partial-destroy-a', tabId: 'tab-1', generation: 1,
        operation: { kind: 'script', source: 'new Promise(() => {})', expectedContext: {
          documentId: 'document-a', documentToken: 'token-a', navigationEpoch: 1,
          navigationUrl: 'https://example.test/a',
        } } });
      const oldRequest = sent.find((frame: any) => frame.actionId === 'partial-destroy-a') as any;
      connection.started(oldRequest.requestId, { actionId: 'partial-destroy-a', tabId: 'tab-1', generation: 1,
        invocationId: oldRequest.requestId, documentToken: 'token-a' });
      connection.executing(oldRequest.requestId, { actionId: 'partial-destroy-a', tabId: 'tab-1', generation: 1,
        invocationId: oldRequest.requestId, documentToken: 'token-a' });
      connection.complete(oldRequest.requestId, { actionId: 'partial-destroy-a', status: 'timed_out_pending',
        code: 'action_timeout', message: 'browser script exceeded the execution deadline', durationMs: 5_000 });
      await expect(timedOut).rejects.toMatchObject({ code: 'action_timeout', noRetry: true });
      connection.complete(oldRequest.requestId, { actionId: 'partial-destroy-a', status: 'unknown',
        code: 'effect_unknown', message: 'confirmed native destroy', ambiguous: true });

      const recreated = await connection.upsert({ ...resource(), webviewLabel: 'browser-main' });
      expect(recreated.generation).toBe(1);
      await vi.advanceTimersByTimeAsync(60_001);
      const replacement = broker.dispatch({ actionId: 'recreated-a', tabId: 'tab-1', generation: 1,
        operation: { kind: 'inspect' } });
      const replacementRequest = sent.find((frame: any) => frame.actionId === 'recreated-a') as any;
      expect(() => connection.complete(oldRequest.requestId, { actionId: 'partial-destroy-a', status: 'unknown',
        code: 'effect_unknown', message: 'stale old callback', ambiguous: true }))
        .toThrowError(expect.objectContaining({ code: 'request_correlation_mismatch' }));

      const independent = broker.dispatch({ actionId: 'still-usable-b', tabId: 'tab-2', generation: 1,
        operation: { kind: 'inspect' } });
      const independentRequest = sent.find((frame: any) => frame.actionId === 'still-usable-b') as any;
      connection.complete(independentRequest.requestId, { actionId: 'still-usable-b', status: 'succeeded' });
      await expect(independent).resolves.toMatchObject({ status: 'succeeded' });
      connection.complete(replacementRequest.requestId, { actionId: 'recreated-a', status: 'succeeded' });
      await expect(replacement).resolves.toMatchObject({ status: 'succeeded' });
      connection.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('disconnects and clears a timed-out fence when the bounded late-completion window expires', async () => {
    vi.useFakeTimers();
    try {
      const { broker, connection, surfaces } = harness();
      await connection.upsert(resource());
      const pending = broker.dispatch({ actionId: 'abandoned', tabId: 'tab-1', generation: 1,
        operation: { kind: 'inspect' } });
      const assertion = expect(pending).rejects.toMatchObject({ code: 'effect_unknown', ambiguous: true });
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      await vi.advanceTimersByTimeAsync(60_001);
      expect(surfaces.get('tab-1')).toBeUndefined();
      await expect(broker.dispatch({ actionId: 'after-abandon', tabId: 'tab-1', generation: 1,
        operation: { kind: 'inspect' } })).rejects.toMatchObject({ code: 'provider_unavailable' });
      expect(() => connection.complete('unknown', {
        actionId: 'abandoned', status: 'succeeded',
      })).toThrowError(expect.objectContaining({ code: 'provider_unavailable' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('distinguishes disconnect before send from ambiguous disconnect after send', async () => {
    const unavailable = new BrowserProviderBroker({
      projectRoot: '/repo', surfaces: new SurfaceRegistry(),
      revokeSurfaceAuthority: vi.fn(),
    });
    await expect(unavailable.dispatch({
      actionId: 'not-sent', tabId: 'tab-1', generation: 1,
      operation: { kind: 'inspect' },
    })).rejects.toMatchObject({ code: 'provider_unavailable' });

    const { broker, connection, surfaces, revoked } = harness();
    await connection.upsert(resource());
    const pending = broker.dispatch({
      actionId: 'sent', tabId: 'tab-1', generation: 1,
      operation: { kind: 'inspect' },
    });
    connection.disconnect();
    await expect(pending).rejects.toMatchObject({ code: 'effect_unknown', ambiguous: true });
    expect(surfaces.get('tab-1')).toBeUndefined();
    expect(revoked).toContainEqual({ kind: 'browser_tab', id: 'tab-1', generation: 1 });
  });

  it('treats explicit send failure as unavailable without ambiguity', async () => {
    const surfaces = new SurfaceRegistry();
    const broker = new BrowserProviderBroker({ projectRoot: '/repo', surfaces, revokeSurfaceAuthority: vi.fn(),
      canonicalizePath: (candidate) => candidate });
    const connection = broker.register('desktop-1', () => false);
    await connection.upsert(resource());
    await expect(broker.dispatch({ actionId: 'action-1', tabId: 'tab-1', generation: 1,
      operation: { kind: 'inspect' } })).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  it('rejects outside worktrees and revokes the prior generation before publishing replacement', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-provider-root-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'psyche-provider-outside-'));
    const surfaces = new SurfaceRegistry();
    const revoked: unknown[] = [];
    const broker = new BrowserProviderBroker({ projectRoot: root, surfaces,
      revokeSurfaceAuthority: (target) => revoked.push(target) });
    const connection = broker.register('desktop-1', () => true);
    try {
      await expect(connection.upsert({ ...resource(), projectRoot: root, worktreeRoot: outside }))
        .rejects.toMatchObject({ code: 'capability_denied' });
      const first = await connection.upsert({ ...resource(), projectRoot: root, worktreeRoot: root });
      const second = await connection.upsert({ ...resource(), projectRoot: root, worktreeRoot: root,
        webviewLabel: 'browser-replaced', generation: first.generation });
      expect(second.generation).toBe(first.generation + 1);
      expect(revoked).toContainEqual({ kind: 'browser_tab', id: 'tab-1', generation: first.generation });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects a browser upsert colliding with a pane ID without revoking or overwriting it', async () => {
    const surfaces = new SurfaceRegistry();
    const pane = surfaces.upsertPane({ id: 'tab-1', tmuxPaneId: '%1', projectRoot: '/repo',
      worktreeRoot: '/repo', writable: true, outputSequence: 0 });
    const revoked: unknown[] = [];
    const broker = new BrowserProviderBroker({ projectRoot: '/repo', surfaces,
      revokeSurfaceAuthority: (target) => revoked.push(target), canonicalizePath: (candidate) => candidate });
    const connection = broker.register('desktop-1', () => true);
    await expect(connection.upsert(resource())).rejects.toMatchObject({ code: 'resource_collision' });
    expect(surfaces.get('tab-1')).toBe(pane);
    expect(revoked).toEqual([]);
  });

  it('advances canonical generation across disconnect and rejects stale removal after reconnect', async () => {
    const { broker, connection } = harness();
    const first = await connection.upsert(resource());
    connection.disconnect();
    const reconnected = broker.register('desktop-1', () => true);
    const second = await reconnected.upsert(resource());
    expect(second.generation).toBe(first.generation + 1);
    expect(() => reconnected.remove('tab-1', first.generation)).toThrowError(/replaced/);
    expect(() => reconnected.remove('tab-1', second.generation)).not.toThrow();
  });
});

describe('ControlServer provider mode', () => {
  it('requires an operator to register and then rejects ordinary control frames', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'psyche-provider-'));
    const endpoint = path.join(tmpdir(), `psyche-provider-${randomBytes(6).toString('hex')}.sock`);
    const credentials = await createControlCredentialStore({
      projectRoot, filePath: path.join(projectRoot, 'credentials.json'),
    });
    const broker = new BrowserProviderBroker({
      projectRoot, surfaces: new SurfaceRegistry(), revokeSurfaceAuthority: vi.fn(),
    });
    const runtime: ControlServerRuntime = {
      submit: vi.fn(),
      snapshot: () => ({ ownerEpoch: 1, sequence: 0, commands: {}, leases: {} }),
      readEvents: () => ({ events: [], nextSequence: 0, gap: false }),
    };
    const server = await ControlServer.start({
      endpoint, projectRoot, ownerEpoch: 1, runtime, credentials, browserProviders: broker,
    });
    const exchange = async (token: string): Promise<Array<Record<string, unknown>>> => {
      const socket = connect(endpoint);
      socket.setEncoding('utf8');
      const frames: Array<Record<string, unknown>> = [];
      const received = new Promise<void>((resolve, reject) => {
        let buffer = '';
        socket.on('data', (chunk: string) => {
          buffer += chunk;
          let newline = buffer.indexOf('\n');
          while (newline >= 0) {
            frames.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
            buffer = buffer.slice(newline + 1);
            if (frames.length === 3) resolve();
            newline = buffer.indexOf('\n');
          }
        });
        socket.once('error', reject);
      });
      socket.write(`${JSON.stringify({ version: 1, type: 'hello', requestId: 'hello', token,
        clientName: 'desktop-test', projectRoot })}\n`);
      socket.write(`${JSON.stringify({ version: 1, type: 'provider.register', requestId: 'register-1',
        providerId: 'desktop-1' })}\n`);
      socket.write(`${JSON.stringify({ version: 1, type: 'state.get', requestId: 'state-1' })}\n`);
      await received;
      socket.destroy();
      return frames;
    };
    try {
      const operatorFrames = await exchange(await credentials.operatorToken());
      expect(operatorFrames.map((frame) => frame.type)).toEqual(['welcome', 'ack', 'error']);
      expect(operatorFrames[2]).toMatchObject({ requestId: 'state-1', code: 'provider_mode' });

      const agentFrames = await exchange(await credentials.agentToken());
      expect(agentFrames[1]).toMatchObject({ requestId: 'register-1', code: 'operator_required' });
      expect(agentFrames[2]).toMatchObject({ type: 'state.result' });
    } finally {
      await server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('preserves provider error code and request correlation and rejects oversized complete frames', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'psyche-provider-wire-'));
    const endpoint = path.join(tmpdir(), `psyche-provider-${randomBytes(6).toString('hex')}.sock`);
    const credentials = await createControlCredentialStore({ projectRoot,
      filePath: path.join(projectRoot, 'credentials.json') });
    const broker = new BrowserProviderBroker({ projectRoot, surfaces: new SurfaceRegistry(),
      revokeSurfaceAuthority: vi.fn() });
    const runtime: ControlServerRuntime = { submit: vi.fn(),
      snapshot: () => ({ ownerEpoch: 1, sequence: 0, commands: {}, leases: {} }),
      readEvents: () => ({ events: [], nextSequence: 0, gap: false }) };
    const server = await ControlServer.start({ endpoint, projectRoot, ownerEpoch: 1,
      runtime, credentials, browserProviders: broker });
    try {
      const socket = connect(endpoint); socket.setEncoding('utf8');
      const frames: Array<Record<string, unknown>> = [];
      socket.on('data', (chunk: string) => {
        for (const line of chunk.trim().split('\n')) if (line) frames.push(JSON.parse(line));
      });
      socket.write(`${JSON.stringify({ version: 1, type: 'hello', requestId: 'hello',
        token: await credentials.operatorToken(), clientName: 'provider', projectRoot })}\n`);
      socket.write(`${JSON.stringify({ version: 1, type: 'provider.register', requestId: 'register',
        providerId: 'desktop-1' })}\n`);
      socket.write(`${JSON.stringify({ version: 1, type: 'provider.resource.remove', requestId: 'remove-stale',
        id: 'missing', generation: 1 })}\n`);
      await vi.waitFor(() => expect(frames).toHaveLength(3));
      expect(frames[2]).toMatchObject({ type: 'error', requestId: 'remove-stale', code: 'resource_missing' });
      socket.destroy();

      const huge = connect(endpoint); huge.setEncoding('utf8');
      huge.on('error', () => undefined);
      let response = '';
      huge.on('data', (chunk: string) => { response += chunk; });
      huge.write(`${JSON.stringify({ version: 1, type: 'state.get', requestId: 'huge',
        padding: 'x'.repeat(7 * 1024 * 1024) })}\n`);
      await vi.waitFor(() => expect(response).toContain('frame_too_large'), { timeout: 3_000 });
      huge.destroy();

      const oversizedResult = connect(endpoint); oversizedResult.setEncoding('utf8');
      oversizedResult.on('error', () => undefined);
      let resultResponse = '';
      oversizedResult.on('data', (chunk: string) => { resultResponse += chunk; });
      oversizedResult.write(`${JSON.stringify({ version: 1, requestId: 'oversized-result',
        result: { actionId: 'a', status: 'succeeded', value: 'x'.repeat(5.5 * 1024 * 1024) },
        type: 'provider.effect.result' })}\n`);
      await vi.waitFor(() => expect(resultResponse).toContain('result_too_large'), { timeout: 3_000 });
      expect(resultResponse).toContain('oversized-result');
      oversizedResult.destroy();

      const contract = JSON.parse(await readFile(new URL(
        '../protocol-fixtures/control-v1/provider-contract.json', import.meta.url), 'utf8')) as {
        base64ScreenshotBytes: number; maxProviderResultWireBytes: number;
      };
      expect(CONTROL_WIRE_LIMITS).toEqual({ maxFrameBytes: 6 * 1024 * 1024,
        maxProviderResultBytes: contract.maxProviderResultWireBytes });
      const maxScreenshot = connect(endpoint); maxScreenshot.setEncoding('utf8');
      maxScreenshot.on('error', () => undefined);
      let maxResponse = '';
      maxScreenshot.on('data', (chunk: string) => { maxResponse += chunk; });
      maxScreenshot.write(`${JSON.stringify({ version: 1, requestId: 'max-screenshot',
        result: { actionId: 'a', status: 'succeeded', value: {
          pngBase64: 'A'.repeat(contract.base64ScreenshotBytes) } },
        type: 'provider.effect.result' })}\n`);
      await vi.waitFor(() => expect(maxResponse).toContain('unauthorized'), { timeout: 3_000 });
      expect(maxResponse).not.toContain('result_too_large');
      maxScreenshot.destroy();

      const overWire = connect(endpoint); overWire.setEncoding('utf8');
      overWire.on('error', () => undefined);
      let overResponse = '';
      overWire.on('data', (chunk: string) => { overResponse += chunk; });
      overWire.write(`${JSON.stringify({ version: 1, requestId: 'over-wire',
        result: { actionId: 'a', status: 'succeeded', value:
          'x'.repeat(contract.maxProviderResultWireBytes) }, type: 'provider.effect.result' })}\n`);
      await vi.waitFor(() => expect(overResponse).toContain('result_too_large'), { timeout: 3_000 });
      overWire.destroy();
    } finally {
      await server.close(); await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
