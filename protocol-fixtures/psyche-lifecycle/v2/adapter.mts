import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readSync, writeFileSync, writeSync } from 'node:fs';
import { runFixture } from '../adapter.mts';
import { effects, openNative } from '../native.mts';

const store = 'v2-binding.json';
const executions = 'v2-executions.ndjson';
const refusal = 'v2-refusal';
const deny = (code: string) => ({ code, executions: effects() });
const stored = () => JSON.parse(readFileSync(store, 'utf8'));
const hash = (bytes: Buffer) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

function invokeSink() {
  const fd = Number(process.env.PSYCHE_TEST_EFFECT_FD);
  if (!Number.isSafeInteger(fd) || fd < 3) throw new Error('missing test effect channel');
  const { binding } = stored();
  const frame = Buffer.from(JSON.stringify(binding) + '\n');
  let sent = 0;
  while (sent < frame.length) sent += writeSync(fd, frame, sent, frame.length - sent);
  const response = Buffer.alloc(37);
  let offset = 0;
  while (offset < response.length) {
    const size = readSync(fd, response, offset, response.length - offset, null);
    if (!size) throw new Error('missing durable effect acknowledgement');
    offset += size;
  }
  const execution_id = response.toString('ascii').trimEnd();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(execution_id)) throw new Error('invalid effect acknowledgement');
  appendFileSync(executions, JSON.stringify({ execution_id, binding }) + '\n', { mode: 0o600, flush: true });
}

async function run() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (!input || typeof input !== 'object' || Array.isArray(input)) return deny('unsupported_request');
  if (input.profile !== 'psyche.experimental.adapter-lifecycle.v2') return deny('unsupported_version');
  if (input.reader_version !== 2) return deny('incompatible_downgrade');
  if (!['first', 'replay', 'rollback'].includes(input.phase) || ![undefined, 'agent_approval', 'cancel', 'lost_ack'].includes(input.fault)) return deny('unsupported_request');
  const allowed = ['profile', 'reader_version', 'phase', 'task_id', 'action_id'];
  if (input.phase !== 'rollback') allowed.push('request_id', 'request_hex');
  if (input.phase === 'first') allowed.push('fault');
  if (Object.keys(input).some(key => !allowed.includes(key))) return deny('unsupported_request');
  const previous = existsSync(store) ? stored() : undefined;
  if (input.phase !== 'first' && !previous) return deny('stale_correlation');
  if (previous && input.phase !== 'rollback' && (input.request_id !== previous.binding.request_id || input.request_hex !== previous.request_hex)) return deny('stale_correlation');
  if (previous && (input.phase === 'rollback' || input.task_id !== undefined || input.action_id !== undefined) &&
      (input.task_id !== previous.binding.task_id || input.action_id !== previous.binding.action_id)) return deny('stale_correlation');
  if (previous && existsSync(refusal)) {
    const { code } = JSON.parse(readFileSync(refusal, 'utf8'));
    const native = await openNative(input.phase === 'rollback' ? 3 : 2, false, invokeSink);
    const receipt = native.runtime.receiptForTask(previous.binding.action_id, previous.binding.task_id);
    // A new native epoch invalidates a pending approval. The original denied resolution remains durable.
    const retained = ['operator_required', 'action_invalidated'].includes(code) &&
      receipt?.state === 'failed' && receipt.code === 'action_invalidated';
    if (!retained) throw new Error('native refusal evidence changed');
    return deny(code);
  }
  const native = await runFixture({ ...input, profile: 'psyche.experimental.adapter-lifecycle.v1', reader_version: 1 }, {
    onEffect: invokeSink,
    persist(requestHex, attemptId, taskId, actionId, approvalId, approvalDigest) {
      const raw = Buffer.from(requestHex, 'hex');
      const binding = { request_id: JSON.parse(raw.toString()).request_id, request_digest: hash(raw),
        attempt_id: attemptId, task_id: taskId, action_id: actionId, approval_id: approvalId, approval_digest: approvalDigest };
      writeFileSync(store, JSON.stringify({ binding, request_hex: requestHex }), { flag: 'wx', mode: 0o600 });
    },
    refusal(code, outcomeId) { writeFileSync(refusal, JSON.stringify({ code, outcomeId }), { flag: 'wx', mode: 0o600 }); },
  });
  if ('code' in native) return native;
  const events = readFileSync(executions, 'utf8').trimEnd().split('\n');
  if (events.length !== 1) throw new Error('unexpected native execution count');
  return { ...stored().binding, ...native, execution_id: JSON.parse(events[0]).execution_id };
}
console.log(JSON.stringify(await run()));
