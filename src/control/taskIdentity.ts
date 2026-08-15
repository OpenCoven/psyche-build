export const MAX_CONTROL_TASK_ID_LENGTH = 256;

export function normalizeControlTaskId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_CONTROL_TASK_ID_LENGTH
    ? normalized
    : undefined;
}
