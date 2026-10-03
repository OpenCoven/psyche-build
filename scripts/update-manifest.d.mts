export const MANIFEST_SCHEMA: 1;
export const SIGNATURE_SCHEMA: 1;
export const KEYS_SCHEMA: 1;
export const MAX_VALIDITY_DAYS: 30;
export const MANIFEST_FILE: 'update-manifest.json';
export const SIGNATURE_FILE: 'update-manifest.json.sig';
export const ARCHITECTURES: readonly ['aarch64', 'x86_64'];

export type VerifyReason =
  | 'keys_malformed'
  | 'no_trusted_keys'
  | 'signature_malformed'
  | 'unknown_key_id'
  | 'signature_invalid'
  | 'manifest_malformed'
  | 'manifest_not_canonical'
  | 'manifest_not_yet_valid'
  | 'manifest_expired'
  | 'manifest_mismatch';
export const VERIFY_REASONS: readonly VerifyReason[];

export class UpdateManifestError extends Error {
  readonly reason: string;
  constructor(reason: string, message?: string);
}

export interface ManifestArtifact {
  file: string;
  sha256: string;
}

export interface UpdateManifest {
  schema: 1;
  version: string;
  tag: string;
  source_sha: string;
  artifacts: { aarch64: ManifestArtifact; x86_64: ManifestArtifact };
  published_at: string;
  expires_at: string;
}

export interface PublicKeyEntry {
  keyId: string;
  publicKey: string;
}

export interface TrustedKeys {
  current: PublicKeyEntry | null;
  next: PublicKeyEntry | null;
}

export type VerifyResult =
  | { ok: true; keyId: string; slot: 'current' | 'next'; manifest: UpdateManifest }
  | { ok: false; reason: VerifyReason };

type Bytes = Uint8Array | string;

export function canonicalJson(value: unknown): string;
export function canonicalFileText(value: unknown): string;
export function normalizeTimestamp(value: string | number): string;
export function dmgFileName(version: string, architecture: string): string;
export function parseSha256Sums(
  text: string,
  version: string,
): { aarch64: ManifestArtifact; x86_64: ManifestArtifact };
export function buildManifest(input: {
  version: string;
  tag: string;
  sourceSha: string;
  sha256sums: string;
  publishedAt: string | number;
  expiresAt?: string | number;
  expiresInDays?: number;
  now?: string | number;
}): UpdateManifest;
export function keyIdForPublicKey(rawPublicKey: Uint8Array): string;
export function publicKeyEntryFromPrivatePem(privateKeyPem: string): PublicKeyEntry;
export function parseKeysFile(text: Bytes): TrustedKeys;
export function isSigningActive(keys: TrustedKeys): boolean;
export function signManifest(manifestBytes: Bytes, privateKeyPem: string, keys: TrustedKeys): string;
export function verifyManifest(input: {
  manifestBytes: Bytes;
  signatureBytes: Bytes;
  keys: TrustedKeys;
  now?: string | number;
  expect?: { tag?: string; sourceSha?: string; sha256sums?: string };
}): VerifyResult;

export function main(
  argv?: string[],
  options?: {
    env?: Record<string, string | undefined>;
    io?: { stdout: (text: string) => void; stderr: (text: string) => void };
  },
): number;
