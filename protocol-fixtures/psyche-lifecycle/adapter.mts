import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { planOrchestrationTask } from '../../src/orchestration/planner.js';
import { actor, effects, human, observe, openNative, projectRoot } from './native.mts';

const profile = 'psyche.experimental.adapter-lifecycle.v1';
const input = JSON.parse(readFileSync(0, 'utf8'));
const deny = (code: string) => ({ code, executions: effects() });
const command = (id: string, kind: string, payload: object, principal: typeof human | typeof actor = human) => ({
  id, kind, idempotencyKey: id, ownerEpoch: 1, projectRoot, createdAt: new Date().toISOString(), actor: principal, payload,
});

async function run() {
  if (input.phase === 'rollback') {
    const reader = fileURLToPath(new URL('./reopen.mts', import.meta.url));
    return JSON.parse(execFileSync(process.execPath, [...process.execArgv, reader, input.task_id, input.action_id], { encoding: 'utf8' }));
  }
  if (input.profile !== profile) return deny('unsupported_version');
  const requestBytes = Buffer.from(input.request_hex, 'hex');
  const request = JSON.parse(requestBytes.toString());
  const digest = 'sha256:' + createHash('sha256').update(requestBytes).digest('hex');
  // This fixture admits only the producer's exact synthetic launch golden.
  if (digest !== 'sha256:75d651c5eb7f6e3ccd65631fce08afdcb8ac2a800bc0d8db55eaf9cf43519d04') return deny('unsupported_request');
  if (input.phase !== 'first') {
    const { version, requestId, requestDigest, action } = JSON.parse(readFileSync('fixture-binding.json', 'utf8'));
    if (input.reader_version !== version) return deny('incompatible_downgrade');
    if (input.request_id !== requestId || digest !== requestDigest) return deny('stale_correlation');
    assert.equal(input.phase, 'replay');
    const native = await openNative(2);
    await native.runtime.submit(action);
    return { ...observe(native, action.payload.taskId, action.id), request_id: requestId, request_digest: requestDigest };
  }
  if (input.request_id !== request.request_id) return deny('stale_correlation');
  const native = await openNative(1, input.fault === 'lost_ack');
  const plan = planOrchestrationTask({ taskId: randomUUID(), operationId: randomUUID(), projectRoot,
    prompt: 'Offline controlled submit', lanes: [{ id: randomUUID(), mode: 'isolated-worktree' }] });
  const taskId = plan.lanes[0].taskId;
  assert.equal(taskId, plan.taskId);
  const submit = (c: ReturnType<typeof command>) => native.runtime.submit(c as Parameters<typeof native.runtime.submit>[0]);
  const requestId = randomUUID();
  await submit(command(requestId, 'lease.request', { taskId, ttlMs: 60_000, grants: [{
    target: { kind: 'browser_tab', id: native.tab.id, generation: native.tab.generation }, capabilities: ['browser.interact'],
  }] }, actor));
  const grant = await submit(command(randomUUID(), 'lease.grant', { requestId }));
  assert(grant.status === 'succeeded' && grant.value);
  const { lease } = grant.value as { lease: {id: string; revision: number} };
  const action = command(randomUUID(), 'browser.action', { taskId, leaseId: lease.id, leaseRevision: lease.revision,
    tabId: native.tab.id, generation: native.tab.generation, snapshotId: 'fixture-snapshot', action: { kind: 'submit', elementRef: 'fixture' } }, actor);
  const pending = await submit(action);
  assert(pending.status === 'succeeded' && pending.value);
  const { approvalId, payloadDigest } = pending.value as {approvalId: string; payloadDigest: string};
  assert(approvalId && payloadDigest && effects() === 0);
  writeFileSync('fixture-binding.json', JSON.stringify({ version: 1, requestId: request.request_id, requestDigest: digest, action }), { flag: 'wx', mode: 0o600 });
  const resolution = { approvalId, payloadDigest, decision: 'approve' };
  if (input.fault === 'agent_approval') {
    const result = await submit(command(randomUUID(), 'approval.resolve', resolution, actor));
    assert(result.status === 'rejected');
    return deny(result.code);
  }
  if (input.fault === 'cancel') {
    const revoked = await submit(command(randomUUID(), 'lease.revoke', { leaseId: lease.id }));
    assert.equal(revoked.status, 'succeeded');
    await submit(command(randomUUID(), 'approval.resolve', resolution));
    const receipt = native.runtime.receiptForTask(action.id, taskId);
    assert.equal(receipt?.state, 'failed');
    return deny(receipt!.code!);
  }
  await submit(command(randomUUID(), 'approval.resolve', resolution));
  return { ...observe(native, taskId, action.id), request_id: request.request_id, request_digest: digest };
}
console.log(JSON.stringify(await run()));
