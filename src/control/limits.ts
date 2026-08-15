export const AGENT_CONTROL_LIMITS = Object.freeze({
  leaseTtlMs: 30 * 60_000,
  leaseRequestRecords: 1_000,
  leaseRequestPending: 100,
  leaseRequestGrants: 32,
  leaseRequestCapabilitiesPerGrant: 12,
  leaseRequestTextBytes: 128,
  leaseRequestCapabilityBytes: 64,
  approvalTtlMs: 5 * 60_000,
  paneOutputBytes: 64 * 1024,
  paneOutputChunks: 512,
  semanticNodes: 2_000,
  semanticDepth: 32,
  accessibleNameBytes: 512,
  snapshotTtlMs: 30_000,
  screenshotBytes: 4 * 1024 * 1024,
  scriptSourceBytes: 64 * 1024,
  scriptArgsBytes: 256 * 1024,
  scriptResultBytes: 256 * 1024,
  actionTimeoutMs: 15_000,
  scriptTimeoutMs: 5_000,
  pendingCommands: 256,
  resourceQueueDepth: 64,
});

const MAX_RAW_SCREENSHOT_BYTES = AGENT_CONTROL_LIMITS.screenshotBytes;
const BASE64_SCREENSHOT_BYTES = Math.ceil(MAX_RAW_SCREENSHOT_BYTES / 3) * 4;
const PROVIDER_RESULT_ENVELOPE_BYTES = 128 * 1024;

export const CONTROL_WIRE_LIMITS = Object.freeze({
  maxFrameBytes: 6 * 1024 * 1024,
  maxProviderResultBytes: BASE64_SCREENSHOT_BYTES + PROVIDER_RESULT_ENVELOPE_BYTES,
});
