import { createHash } from 'node:crypto';
import { OrchestrationError } from './types.js';

export const MAX_ORCHESTRATION_OPERATION_ID_LENGTH = 128;

function tupleDigest(domain: string, values: readonly string[]): string {
  const hash = createHash('sha256');
  hash.update(domain, 'utf8');
  for (const value of values) {
    const bytes = Buffer.from(value, 'utf8');
    hash.update(`:${bytes.byteLength}:`, 'utf8');
    hash.update(bytes);
  }
  return hash.digest('hex');
}

export function normalizeOrchestrationOperationId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new OrchestrationError(
      'invalid_orchestration_request',
      'operationId must be a string',
    );
  }
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > MAX_ORCHESTRATION_OPERATION_ID_LENGTH
  ) {
    throw new OrchestrationError(
      'invalid_orchestration_request',
      `operationId must contain 1-${MAX_ORCHESTRATION_OPERATION_ID_LENGTH} characters`,
    );
  }
  return normalized;
}

export function deriveOrchestrationOperationId(authority: string): string {
  return `orch-op-v1-${tupleDigest('psyche.orchestration.operation.v1', [authority])}`;
}

export function daemonOrchestrationControlIdempotencyKey(input: {
  operationId?: string;
  connectionId: string;
  requestId: string;
}): string {
  if (typeof input.connectionId !== 'string' || typeof input.requestId !== 'string') {
    throw new OrchestrationError(
      'invalid_orchestration_request',
      'daemon orchestration connection and request identities must be strings',
    );
  }
  const authority = input.operationId === undefined
    ? ['connection', input.connectionId, input.requestId]
    : ['explicit', normalizeOrchestrationOperationId(input.operationId)];
  return `orch-daemon-v1-${tupleDigest(
    'psyche.orchestration.daemon-control.v1',
    authority,
  )}`;
}

export function daemonOrchestrationControlStepIdempotencyKey(input: {
  executionIdempotencyKey: string;
  connectionId: string;
  step: 'lease-request' | 'lease-grant';
}): string {
  return `orch-daemon-step-v1-${tupleDigest(
    'psyche.orchestration.daemon-control-step.v1',
    [input.step, input.connectionId, input.executionIdempotencyKey],
  )}`;
}

export function bridgePaneLaunchRequestId(operationId: string, laneId: string): string {
  return `orch-pane-v1-${tupleDigest(
    'psyche.orchestration.bridge-pane.v1',
    [normalizeOrchestrationOperationId(operationId), laneId],
  )}`;
}

export function orchestrationLaneResultKey(operationId: string, laneId: string): string {
  return `orch-lane-v1-${tupleDigest(
    'psyche.orchestration.retained-lane.v1',
    [normalizeOrchestrationOperationId(operationId), laneId],
  )}`;
}
