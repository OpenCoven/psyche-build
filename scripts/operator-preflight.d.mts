type Architecture = 'aarch64' | 'x86_64' | 'unknown';
type ToolStatus = 'available' | 'missing' | 'probe_failed' | 'not_observed';
type ToolRunner = (command: string, args: string[], options: object) => {
  status: number | null; signal?: string | null; error?: Error;
};
export function parsePreflightArguments(args: string[]): Exclude<Architecture, 'unknown'> | undefined;
export function probeTool(tool: string, run?: ToolRunner): ToolStatus;
export function collectOperatorPreflight(options?: {
  platform?: string;
  architecture?: string;
  artifactArchitecture?: string;
  checkTool?: (tool: string) => ToolStatus;
}): {
  schemaVersion: number;
  acceptance: 'not_observed';
  host: { platform: 'macos' | 'unsupported'; architecture: Architecture };
  artifact: { architecture: Architecture; source: 'not_observed' | 'operator_declared';
    compatibility: 'matches' | 'mismatch' | 'not_observed' };
  tools: Record<string, ToolStatus>;
  uiAutomationPermission: 'unknown';
  disposableContext: 'unverified';
  setupBlockers: string[];
  requiredOperatorChecks: string[];
  productScenarios: { id: string; status: 'not_observed' }[];
  limits: Record<string, number>;
};
