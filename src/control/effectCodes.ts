export const STABLE_SURFACE_EFFECT_CODES = Object.freeze([
  'action_timeout',
  'args_too_large',
  'automation_failed',
  'backend_unavailable',
  'element_missing',
  'provider_busy',
  'provider_unavailable',
  'resource_missing',
  'resource_replaced',
  'mutation_not_allowed',
  'mutation_plan_invalid',
  'mutation_target_stale',
  'result_too_large',
  'script_source_too_large',
  'script_args_invalid',
  'script_args_too_large',
  'serialization_failed',
  'snapshot_too_large',
  'snapshot_stale',
  'target_unavailable',
] as const);

export type StableSurfaceEffectCode = typeof STABLE_SURFACE_EFFECT_CODES[number];

const STABLE_SURFACE_EFFECT_CODE_SET = new Set<string>(STABLE_SURFACE_EFFECT_CODES);

export function isStableSurfaceEffectCode(value: unknown): value is StableSurfaceEffectCode {
  return typeof value === 'string' && STABLE_SURFACE_EFFECT_CODE_SET.has(value);
}
