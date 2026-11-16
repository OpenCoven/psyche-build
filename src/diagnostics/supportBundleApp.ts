import path from 'node:path';
import { collectSupportBundle, serializeSupportBundle, supportBundleDigest, type SupportCollector } from './supportBundle.js';
import { createSupportCollectors, supportBundleArchitecture, supportBundlePlatform } from './supportBundleCollectors.js';
import { supportBundleDirectory, supportBundleFilename, writeSupportBundleFile } from './supportBundleStore.js';
import { getAgentDefinitions } from '../utils/agentLaunch.js';

export interface AppSupportRequest {
  projectRoot: string;
  releaseVersion: string;
  sourceSha: string;
  graphics?: { engine: 'wkwebview' | 'webview2' | 'webkitgtk'; accelerated: 'unknown' };
  lifecycle?: { panes: number };
  updater?: { checksEnabled: boolean; state: 'disabled' | 'available' | 'unknown' | 'unavailable' };
}
export interface AppSupportResult {
  state: 'saved' | 'failed' | 'cancelled' | 'recovery_required';
  code: string;
  path?: string;
  fileName?: string;
  categories?: { category: string; disposition: string; reason: string }[];
  bytes?: number;
  digest?: string;
  bundleStatus?: string;
  redactedFields?: number;
  omittedFields?: number;
  truncated?: boolean;
  retentionFailures?: number;
}
export async function createAppSupportBundle(request: AppSupportRequest, signal?: AbortSignal): Promise<AppSupportResult> {
  if (signal?.aborted) return { state: 'cancelled', code: 'cancelled' };
  const categories = [
    { category: 'provenance', disposition: 'collected', reason: 'unverified' },
    { category: 'persistence', disposition: 'collected', reason: 'project_recovery_only' },
    { category: 'providers', disposition: 'collected', reason: 'filesystem_only' },
    { category: 'lifecycle', disposition: request.lifecycle ? 'collected' : 'omitted', reason: request.lifecycle ? 'counts_only' : 'owner_unavailable' },
    { category: 'updater', disposition: request.updater ? 'collected' : 'omitted', reason: request.updater ? 'native_snapshot' : 'owner_unavailable' },
    { category: 'graphics', disposition: request.graphics ? 'collected' : 'omitted', reason: request.graphics ? 'engine_only' : 'owner_unavailable' },
    { category: 'receipts', disposition: 'omitted', reason: 'owner_unavailable' },
    { category: 'terminal', disposition: 'omitted', reason: 'content_excluded' },
  ];
  const collectedAt = new Date().toISOString();
  // Desktop lifecycle/updater facts come from their actual native composition,
  // not the TUI's project configuration. No snapshot gains authority here.
  const collectors: SupportCollector[] = createSupportCollectors({
    projectRoot: request.projectRoot, releaseVersion: request.releaseVersion,
    platform: supportBundlePlatform(process.platform), architecture: supportBundleArchitecture(process.arch),
    providerDefinitions: getAgentDefinitions(), providerSearchPath: (process.env.PATH ?? '').split(path.delimiter),
  }).filter(collector => !['provenance', 'lifecycle', 'updater'].includes(collector.name));
  collectors.push({ name: 'native', collect: async () => ({
    provenance: { application: 'psyche-build', releaseVersion: request.releaseVersion, sourceSha: request.sourceSha,
      platform: supportBundlePlatform(process.platform), architecture: supportBundleArchitecture(process.arch) },
    ...(request.lifecycle ? { lifecycle: { panes: request.lifecycle.panes, state: 'available' } } : {}),
    ...(request.updater ? { updater: { mode: request.updater.checksEnabled ? 'enabled' : 'disabled', state: request.updater.state } } : {}),
    ...(request.graphics ? { graphics: { ...request.graphics, state: 'partial' } } : {}),
    records: categories.filter(category => category.disposition === 'omitted').map((category, index) => ({
      sequence: index, at: collectedAt, component: category.category, event: 'omitted',
      attributes: { state: category.category === 'terminal' ? 'unsupported' : 'unavailable' },
    })),
  }) });
  let bundle;
  try {
    bundle = await collectSupportBundle(collectors, { signal });
  } catch {
    return signal?.aborted ? { state: 'cancelled', code: 'cancelled' } : { state: 'failed', code: 'collection_failed' };
  }
  if (signal?.aborted) return { state: 'cancelled', code: 'cancelled' };
  try {
    const serialized = serializeSupportBundle(bundle);
    const digest = supportBundleDigest(bundle);
    const written = await writeSupportBundleFile({
      directory: supportBundleDirectory(request.projectRoot), projectRoot: request.projectRoot,
      filename: supportBundleFilename(bundle.generatedAt, digest), serialized, signal,
    });
    return { state: 'saved', code: 'saved', path: written.path, fileName: path.basename(written.path),
      bytes: written.bytes, digest, bundleStatus: bundle.status,
      redactedFields: bundle.redaction.redactedFields, omittedFields: bundle.redaction.omittedFields,
      truncated: Object.entries(bundle.truncation).some(([key, value]) => key !== 'totalPayloadBounded' && typeof value === 'number' && value > 0),
      retentionFailures: written.retentionFailures, categories };
  } catch {
    return signal?.aborted ? { state: 'cancelled', code: 'cancelled' } : { state: 'failed', code: 'write_failed' };
  }
}
