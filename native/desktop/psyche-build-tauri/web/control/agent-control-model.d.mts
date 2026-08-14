export interface AgentControlModelOptions {
  now?: number;
  operator?: boolean;
  previousOwnerEpoch?: number;
}

export function createAgentControlModel(
  snapshot: Record<string, unknown>,
  options?: AgentControlModelOptions,
): any;

export function resourceLeaseBadge(model: any, resource: Record<string, unknown> | null): any | null;

export function surfaceResourceIdentity(
  model: any,
  kind: string,
  id: string,
): Record<string, unknown> | null;
