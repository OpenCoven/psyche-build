import type {
  StressHarnessDependencies,
  StressResource,
} from './stress-harness';

export interface NativeDiagnosticsAuthorization {
  debugBuild?: unknown;
  stressAuthorized?: unknown;
}

export interface DiagnosticsStressAdapterHost extends Omit<StressHarnessDependencies, 'authorized'> {}

export interface DiagnosticsStressAdapterTarget {
  PsycheDiagnosticsStressAdapters?: unknown;
}

export type GpuDiagnosticRow = readonly [string, string, unknown];

const GPU_DIAGNOSTIC_LABELS = Object.freeze([
  ['acceleration', 'Acceleration'],
  ['engine', 'Engine'],
  ['engineVersion', 'Engine version'],
  ['backend', 'Backend'],
  ['adapter', 'Adapter'],
  ['supportingProbe', 'Probe'],
  ['os', 'OS'],
  ['arch', 'Architecture'],
  ['debugBuild', 'Debug build'],
  ['stressAuthorized', 'Stress authorized'],
  ['cpuPercent', 'CPU percent'],
  ['rssBytes', 'Resident memory'],
] as const);

function isStressAdapterHost(value: unknown): value is DiagnosticsStressAdapterHost {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DiagnosticsStressAdapterHost>;
  return typeof candidate.createTerminal === 'function'
    && typeof candidate.createEditor === 'function'
    && typeof candidate.createBrowser === 'function'
    && typeof candidate.focus === 'function'
    && typeof candidate.resize === 'function'
    && typeof candidate.setVisible === 'function'
    && typeof candidate.cycleWindow === 'function'
    && typeof candidate.loseGraphicsContext === 'function'
    && typeof candidate.resetMetrics === 'function'
    && typeof candidate.snapshotMetrics === 'function'
    && typeof candidate.sleep === 'function'
    && typeof candidate.requestFrame === 'function'
    && typeof candidate.cancelFrame === 'function'
    && typeof candidate.now === 'function'
    && typeof candidate.onProgress === 'function';
}

export function isNativeDiagnosticsStressAuthorized(
  report: NativeDiagnosticsAuthorization | null | undefined,
): boolean {
  return report?.debugBuild === true && report.stressAuthorized === true;
}

export function installDiagnosticsStressAdapters(
  target: DiagnosticsStressAdapterTarget,
  report: NativeDiagnosticsAuthorization | null | undefined,
  host: DiagnosticsStressAdapterHost,
): boolean {
  delete target.PsycheDiagnosticsStressAdapters;
  if (!isNativeDiagnosticsStressAuthorized(report) || !isStressAdapterHost(host)) return false;

  target.PsycheDiagnosticsStressAdapters = Object.freeze({
    ...host,
    authorized: true,
  });
  return true;
}

export function isGpuDiagnosticsStressRunEnabled(
  authorized: boolean,
  adaptersInstalled: boolean,
  runActive: boolean,
  cleanupRecoveryRequired = false,
): boolean {
  return authorized && adaptersInstalled && !runActive && !cleanupRecoveryRequired;
}

export function isGpuDiagnosticsContextLossConfirmed(
  title: string,
  pageTitle: string,
): boolean {
  return title === `${pageTitle} · context-lost`;
}

export function presentGpuDiagnosticRows(
  report: Record<string, unknown> | null | undefined,
): readonly GpuDiagnosticRow[] {
  if (!report) return [];
  return GPU_DIAGNOSTIC_LABELS.flatMap(([key, label]) => {
    const value = report[key];
    return value === undefined || value === null || value === ''
      ? []
      : [[key, label, value] as const];
  });
}

export type { StressResource };
