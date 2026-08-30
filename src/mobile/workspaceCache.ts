// Bounded protected workspace cache (v1) — reference implementation.
//
// Encodes the storage contract for Bead `psyche-i7c.10.1`
// (OpenCoven/psyche-build#210, "Implement bounded protected workspace cache").
// The human-readable contract this module mirrors lives in
// `docs/mobile/WORKSPACE-CACHE-CONTRACT.md`; the Beads source remains
// authoritative for the deliverable definition. Stale/live reconciliation on
// top of this cache belongs to `psyche-i7c.10.2` (#211), which consumes these
// exact entry points and filenames.
//
// This module is platform-neutral and additive: it never touches the network,
// never reads a clock or random source, never infers runtime state, and never
// grants mutation authority over restored data. Persistence mechanics (real
// Application Support files, file-protection attributes, crash-atomic
// renames) are owned by the platform layers that implement the injected
// {@link WorkspaceCacheStorageAdapter}; the Swift/XCTest proof of those
// attributes is a documented gap in the working record for this issue.
//
// Design invariants (all enforced here, all tested):
// - Atomic replacement only: write-temp-then-promote; a failed promote leaves
//   the previously promoted record byte-identical.
// - Host-identity keying: records are stored under a key derived from the
//   host identity AND carry the key inside the record; other-host state never
//   restores (refused before any payload is exposed).
// - Complete-until-first-auth protection: restored cache is returned as
//   protected/inert until the caller asserts the session's first successful
//   authentication, and even then it is never marked presentable-as-live.
// - Bounds are explicit: oversized input is rejected with typed errors;
//   nothing is ever truncated silently.
// - Schema-closed: unknown fields (including credential-, transcript-, or
//   source-shaped ones) are rejected rather than ignored.

/** Schema version of the cached workspace record format produced and validated here. */
export const WORKSPACE_CACHE_RECORD_VERSION = 1;

/**
 * Authoritative total budget for one serialized cache record, in UTF-8 bytes.
 * This cap is checked before any storage call on the write path and before
 * parsing on the read path. Per-field limits are necessary but NOT
 * sufficient: a record whose fields are individually legal can still exceed
 * this budget and then fails explicitly with `oversize-record`.
 */
export const WORKSPACE_CACHE_MAX_RECORD_BYTES = 131_072;

/** Maximum number of cached project refs. */
export const WORKSPACE_CACHE_MAX_PROJECTS = 8;

/** Maximum number of cached pane refs. */
export const WORKSPACE_CACHE_MAX_PANES = 24;

/** Maximum number of cached drafts (at most one per pane). */
export const WORKSPACE_CACHE_MAX_DRAFTS = 24;

/** Maximum length of one draft, in UTF-16 code units. */
export const WORKSPACE_CACHE_MAX_DRAFT_CODE_UNITS = 2_048;

/** Maximum length of an identifier field, in UTF-16 code units. */
export const WORKSPACE_CACHE_MAX_ID_CODE_UNITS = 128;

/** Maximum length of a display-text field (project name, pane title), in UTF-16 code units. */
export const WORKSPACE_CACHE_MAX_DISPLAY_TEXT_CODE_UNITS = 200;

/** Maximum length of the platform install-scope identifier, in UTF-16 code units. */
export const WORKSPACE_CACHE_MAX_HOST_ID_CODE_UNITS = 128;

/** Minimum length of the platform install-scope identifier, in UTF-16 code units. */
export const WORKSPACE_CACHE_MIN_HOST_ID_CODE_UNITS = 8;

/** Platforms that participate in the mobile workspace cache family. */
export type WorkspaceCachePlatform = 'ios' | 'ipados' | 'macos';

export const WORKSPACE_CACHE_PLATFORMS: readonly WorkspaceCachePlatform[] = [
  'ios',
  'ipados',
  'macos',
];

/** Identity input used to derive the host key. See the contract document, section 5. */
export interface WorkspaceHostIdentity {
  /** Platform family. Keying is scoped per platform so ids cannot collide across families. */
  readonly platform: WorkspaceCachePlatform;
  /**
   * Opaque, install-scoped identifier generated once per install by the
   * platform layer (for example a UUID in platform-protected storage). It
   * MUST NOT be derived from hostname, user name, hardware serial, or any
   * other personally identifying or unstable value.
   */
  readonly installScopeId: string;
}

const HOST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** C0 and C1 control characters, for single-line display text. */
const DISPLAY_TEXT_CONTROL_PATTERN = /[\u0000-\u001F\u007F-\u009F]/;
/**
 * Control characters not allowed in drafts: everything in C0/C1 except tab
 * (U+0009) and line feed (U+000A). Carriage return is rejected; callers
 * normalize newlines before caching.
 */
const DRAFT_CONTROL_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

/**
 * Defense-in-depth backstop: credential-shaped content is rejected wherever
 * free text is accepted. The primary control is the closed schema (unknown
 * fields are rejected); these shape patterns catch credentials smuggled into
 * otherwise legal text fields. They are shape-based to keep false positives
 * low, and they are a backstop, not a guarantee.
 */
const FORBIDDEN_CONTENT_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'credential-assignment', pattern: /(?:password|passwd|secret|api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret)\s*[:=]\s*\S/i },
  { label: 'authorization-header', pattern: /authorization\s*:\s*\S/i },
  { label: 'bearer-token', pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i },
  { label: 'private-key-armored', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'api-key-shape', pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}\b/ },
  { label: 'github-token-shape', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
];

/** Validation problem codes. Problem messages never echo offending content, only paths, shapes, and lengths. */
export type WorkspaceCacheProblemCode =
  | 'invalid-record'
  | 'unsupported-version'
  | 'unknown-field'
  | 'missing-field'
  | 'invalid-field'
  | 'host-mismatch'
  | 'too-many-items'
  | 'oversize-field'
  | 'forbidden-content'
  | 'oversize-record';

/** One structured validation problem. `path` is a bounded field path such as `drafts[2].text`. */
export interface WorkspaceCacheProblem {
  readonly code: WorkspaceCacheProblemCode;
  readonly message: string;
  readonly path?: string;
}

/**
 * Typed error codes thrown by the cache facade. Validation rejections use
 * the first validation problem's code 1:1 (with every problem attached);
 * infrastructure failures use the dedicated codes below.
 */
export type WorkspaceCacheErrorCode =
  | WorkspaceCacheProblemCode
  | 'invalid-host-identity'
  | 'auth-required'
  | 'temp-write-failed'
  | 'promote-failed'
  | 'storage-read-failed';

/** Typed error raised by the cache facade. Carries structured problems when validation failed. */
export class WorkspaceCacheError extends Error {
  readonly code: WorkspaceCacheErrorCode;
  readonly problems?: readonly WorkspaceCacheProblem[];

  constructor(
    code: WorkspaceCacheErrorCode,
    message: string,
    options: { readonly problems?: readonly WorkspaceCacheProblem[]; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'WorkspaceCacheError';
    this.code = code;
    if (options.problems !== undefined) {
      this.problems = options.problems;
    }
  }
}

/**
 * Derive the host key from the host identity. The key is the normalized
 * composite of the platform and the install-scope identifier. It is an
 * opaque routing key: no credentials, no user identity, no filesystem paths.
 * Derivation is deterministic and exact — the identity itself is the key, so
 * different hosts cannot collide (a digest could only weaken the
 * other-host-never-restores guarantee by introducing collisions).
 *
 * Throws {@link WorkspaceCacheError} with code `invalid-host-identity` when
 * the identity is malformed. Fail closed: nothing is derived from partial or
 * hostile input.
 */
export function deriveHostKey(host: WorkspaceHostIdentity): string {
  if (!isRecordLike(host)) {
    throw new WorkspaceCacheError(
      'invalid-host-identity',
      'host identity must be an object with platform and installScopeId',
    );
  }
  if (
    typeof host.platform !== 'string' ||
    !WORKSPACE_CACHE_PLATFORMS.includes(host.platform as WorkspaceCachePlatform)
  ) {
    throw new WorkspaceCacheError(
      'invalid-host-identity',
      `host identity platform must be one of ${WORKSPACE_CACHE_PLATFORMS.join('|')}`,
    );
  }
  const installScopeId = host.installScopeId;
  if (typeof installScopeId !== 'string' || !HOST_ID_PATTERN.test(installScopeId)) {
    throw new WorkspaceCacheError(
      'invalid-host-identity',
      `host identity installScopeId must match ${String(HOST_ID_PATTERN)}`,
    );
  }
  return `${host.platform}:${installScopeId}`;
}

/**
 * Storage key for a host's cache record, namespaced by schema version. The
 * key is a relative, path-safe location the adapter maps into its backing
 * store (Application Support on Apple platforms). Host namespacing is the
 * first isolation layer; the in-record host key is the second.
 */
export function workspaceCacheStorageKey(hostKey: string): string {
  if (typeof hostKey !== 'string' || !HOST_ID_PATTERN.test(hostKey.split(':').slice(1).join(':'))) {
    throw new WorkspaceCacheError('invalid-host-identity', 'host key is not a derived host key');
  }
  return `psyche/mobile/workspace-cache/v${WORKSPACE_CACHE_RECORD_VERSION}/${hostKey}.json`;
}

/** A cached project reference. Opaque id plus display name only — never paths, never source. */
export interface CachedProjectRef {
  readonly projectId: string;
  readonly name: string;
}

/** A cached pane reference. Opaque ids plus display title only — never transcripts or output. */
export interface CachedPaneRef {
  readonly paneId: string;
  readonly projectId: string;
  readonly title: string;
}

/** The selection as last confirmed by an authenticated session. */
export interface CachedSelection {
  readonly projectId: string;
  readonly paneId?: string;
}

/** One pane's in-progress input draft. The only free-text field in the record besides display text. */
export interface CachedDraft {
  readonly paneId: string;
  readonly text: string;
}

/** Validated cached workspace record (the stored shape, version 1). */
export interface CachedWorkspaceState {
  readonly version: typeof WORKSPACE_CACHE_RECORD_VERSION;
  /** Host key this record belongs to. Restored only when it matches the deriving host. */
  readonly hostKey: string;
  /** Opaque identifier of the cached workspace. */
  readonly workspaceId: string;
  /**
   * Monotonic sequence of the last state confirmed by an authenticated
   * session. Reconciliation ordering key for #211; never a wall-clock value.
   */
  readonly lastConfirmedSequence: number;
  /**
   * Optional caller-supplied epoch-milliseconds of the last confirmation,
   * for stale-age display. The module never reads a clock; supplying and
   * interpreting this value is the caller's (and #211's) responsibility.
   */
  readonly lastConfirmedAtMs?: number;
  readonly projects: readonly CachedProjectRef[];
  readonly panes: readonly CachedPaneRef[];
  readonly selection: CachedSelection | null;
  readonly drafts: readonly CachedDraft[];
}

/** Caller-supplied state input. Version and hostKey are stamped by the module; explicit values are validated, not trusted. */
export type WorkspaceCacheStateInput = Omit<CachedWorkspaceState, 'version' | 'hostKey'> & {
  readonly version?: typeof WORKSPACE_CACHE_RECORD_VERSION;
  readonly hostKey?: string;
};

/** Protection mode of a restored record. */
export type WorkspaceCacheProtection = 'protected-inert' | 'stale-pending-reconciliation';

/**
 * A restored cached workspace, wrapped in the protection envelope. The
 * literal-typed flags are the contract: there is no value of this type under
 * which the cache may be presented as live or used for input, so a caller
 * cannot present stale bytes as a live surface through this module.
 */
export interface RestoredCachedWorkspaceState {
  /** The validated record. */
  readonly record: CachedWorkspaceState;
  /** Host key the record was restored under (equal to the deriving host's key). */
  readonly hostKey: string;
  /**
   * `protected-inert` before the session's first successful authentication:
   * view-only recovery context, reconciliation must not run.
   * `stale-pending-reconciliation` after the assertion: #211 owns reconciling
   * it against an authoritative snapshot.
   */
  readonly protection: WorkspaceCacheProtection;
  /** Always false. Cached state is never the live surface, before or after auth. */
  readonly presentableAsLive: false;
  /** Always false. Input is enabled only by live reconciliation, never by the cache. */
  readonly inputEnabled: false;
  /** Always false. The cache never grants mutation authority. */
  readonly mutationsAllowed: false;
  /** False while protected-inert; true once the first-auth assertion is made. */
  readonly reconciliationAllowed: boolean;
}

export type WorkspaceCacheRestoreResult =
  | { readonly status: 'empty' }
  | {
      /** A record exists under this host's key (or carries a foreign key) but belongs to another host. No payload is exposed. */
      readonly status: 'refused-other-host';
    }
  | {
      /** The stored record failed strict validation and is not exposed. It is NOT removed implicitly; use discard. */
      readonly status: 'unusable';
      readonly problems: readonly WorkspaceCacheProblem[];
    }
  | { readonly status: 'restored'; readonly state: RestoredCachedWorkspaceState };

export interface WorkspaceCacheSaveResult {
  readonly hostKey: string;
  readonly storageKey: string;
  readonly byteLength: number;
  readonly record: CachedWorkspaceState;
}

/**
 * Temp handle returned by {@link WorkspaceCacheStorageAdapter.writeTemp}.
 * Opaque to the cache module; the adapter owns its meaning.
 */
export type WorkspaceCacheTempHandle = string;

/**
 * Storage adapter contract. The platform layer implements this over its real
 * storage (Application Support on Apple platforms). Semantics the adapter
 * MUST uphold:
 * - `writeTemp` durably writes bytes to a private temp location for `key`
 *   and returns a handle; the promoted record is untouched.
 * - `promote` atomically replaces the promoted record for `key` with the
 *   temp bytes (rename-class operation). After promote, the temp handle is
 *   consumed. Either the promoted record becomes the new bytes or it stays
 *   exactly as before; no torn state is observable.
 * - `discardTemp` removes a temp location; must be safe for unknown handles.
 * - `remove` removes the promoted record; idempotent.
 * - `read` returns a copy of the promoted bytes or null when absent.
 * - On Apple platforms both record and temp files MUST carry
 *   `NSFileProtectionCompleteUntilFirstUserAuthentication` or stricter.
 */
export interface WorkspaceCacheStorageAdapter {
  read(key: string): Uint8Array | null;
  writeTemp(key: string, bytes: Uint8Array): WorkspaceCacheTempHandle;
  promote(key: string, temp: WorkspaceCacheTempHandle): void;
  discardTemp(temp: WorkspaceCacheTempHandle): void;
  remove(key: string): void;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** UTF-8 byte length of a string (code-point exact). */
function utf8ByteLength(text: string): number {
  let length = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return length;
}

/**
 * Encode a string as UTF-8. Only ever fed JSON.stringify output, which never
 * contains raw lone surrogates (they are escaped), so every code point here
 * is scalar-valued.
 */
function encodeUtf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

/**
 * Strict UTF-8 decode. Returns null on any invalid sequence: bad lead bytes,
 * truncated sequences, missing continuations, overlong encodings, surrogate
 * encodings, and code points beyond U+10FFFF. Fail closed on hostile bytes.
 */
function decodeUtf8(bytes: Uint8Array): string | null {
  let out = '';
  let index = 0;
  while (index < bytes.length) {
    const lead = bytes[index]!;
    let length: number;
    let code: number;
    let lowerBound: number;
    if (lead < 0x80) {
      out += String.fromCharCode(lead);
      index += 1;
      continue;
    } else if (lead >= 0xc2 && lead <= 0xdf) {
      length = 2;
      code = lead & 0x1f;
      lowerBound = 0x80;
    } else if (lead >= 0xe0 && lead <= 0xef) {
      length = 3;
      code = lead & 0x0f;
      lowerBound = 0x800;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      length = 4;
      code = lead & 0x07;
      lowerBound = 0x10000;
    } else {
      return null;
    }
    if (index + length > bytes.length) {
      return null;
    }
    for (let offset = 1; offset < length; offset += 1) {
      const continuation = bytes[index + offset]!;
      if ((continuation & 0xc0) !== 0x80) {
        return null;
      }
      code = (code << 6) | (continuation & 0x3f);
    }
    if (code < lowerBound || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      return null;
    }
    out += String.fromCodePoint(code);
    index += length;
  }
  return out;
}

const ROOT_FIELDS: readonly string[] = [
  'version',
  'hostKey',
  'workspaceId',
  'lastConfirmedSequence',
  'lastConfirmedAtMs',
  'projects',
  'panes',
  'selection',
  'drafts',
];
const PROJECT_FIELDS: readonly string[] = ['projectId', 'name'];
const PANE_FIELDS: readonly string[] = ['paneId', 'projectId', 'title'];
const SELECTION_FIELDS: readonly string[] = ['projectId', 'paneId'];
const DRAFT_FIELDS: readonly string[] = ['paneId', 'text'];

export interface ValidateCachedWorkspaceStateOptions {
  /** `input` accepts module-stamped fields as optional; `stored` requires the full persisted shape. */
  readonly mode: 'input' | 'stored';
  /** When set, the record's (optional or required) hostKey must equal this derived key. */
  readonly expectedHostKey?: string;
}

function checkUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  problems: WorkspaceCacheProblem[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      problems.push({
        code: 'unknown-field',
        message: `unknown field is rejected by the closed v1 schema`,
        path: path === '' ? key : `${path}.${key}`,
      });
    }
  }
}

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isValidCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function findForbiddenContent(text: string): string | null {
  for (const rule of FORBIDDEN_CONTENT_PATTERNS) {
    if (rule.pattern.test(text)) {
      return rule.label;
    }
  }
  return null;
}

/**
 * Strictly validate a workspace cache record or input. Unknown fields,
 * wrong versions, out-of-bound counts and lengths, malformed identifiers,
 * control characters, dangling references, and credential-shaped content are
 * all rejected. Returns the (possibly empty) problem list; an empty list
 * means the value is schema-valid. This function is pure and deterministic.
 */
export function validateCachedWorkspaceState(
  input: unknown,
  options: ValidateCachedWorkspaceStateOptions,
): readonly WorkspaceCacheProblem[] {
  const problems: WorkspaceCacheProblem[] = [];
  if (!isRecordLike(input)) {
    return [{ code: 'invalid-record', message: 'workspace cache record must be an object' }];
  }
  checkUnknownFields(input, ROOT_FIELDS, '', problems);

  // Version: optional on the input path (stamped by the module), required on
  // the stored path. Any explicit value must be exactly this schema's version.
  if (input.version === undefined) {
    if (options.mode === 'stored') {
      problems.push({ code: 'missing-field', message: 'version is required in a stored record' });
    }
  } else if (input.version !== WORKSPACE_CACHE_RECORD_VERSION) {
    problems.push({
      code: 'unsupported-version',
      message: `record version must be ${WORKSPACE_CACHE_RECORD_VERSION}`,
    });
  }

  // Host key: optional on the input path (stamped), required on the stored path.
  if (input.hostKey === undefined) {
    if (options.mode === 'stored') {
      problems.push({ code: 'missing-field', message: 'hostKey is required in a stored record' });
    }
  } else if (typeof input.hostKey !== 'string' || input.hostKey.length === 0) {
    problems.push({ code: 'invalid-field', message: 'hostKey must be a non-empty string' });
  } else if (
    !HOST_ID_PATTERN.test(input.hostKey.split(':').slice(1).join(':')) ||
    !WORKSPACE_CACHE_PLATFORMS.includes(input.hostKey.split(':', 1)[0] as WorkspaceCachePlatform)
  ) {
    problems.push({ code: 'invalid-field', message: 'hostKey is not a derived host key' });
  } else if (options.expectedHostKey !== undefined && input.hostKey !== options.expectedHostKey) {
    problems.push({
      code: 'host-mismatch',
      message: 'record belongs to a different host and is refused',
    });
  }

  if (typeof input.workspaceId !== 'string' || !isValidId(input.workspaceId)) {
    problems.push({
      code: 'invalid-field',
      message: `workspaceId must match ${String(ID_PATTERN)}`,
      path: 'workspaceId',
    });
  }

  if (!isValidCount(input.lastConfirmedSequence)) {
    problems.push({
      code: 'invalid-field',
      message: 'lastConfirmedSequence must be a non-negative safe integer',
      path: 'lastConfirmedSequence',
    });
  }

  if (input.lastConfirmedAtMs !== undefined && !isValidCount(input.lastConfirmedAtMs)) {
    problems.push({
      code: 'invalid-field',
      message: 'lastConfirmedAtMs must be a non-negative safe integer when present',
      path: 'lastConfirmedAtMs',
    });
  }

  // Projects.
  if (!Array.isArray(input.projects)) {
    problems.push({ code: 'invalid-field', message: 'projects must be an array', path: 'projects' });
  } else {
    if (input.projects.length > WORKSPACE_CACHE_MAX_PROJECTS) {
      problems.push({
        code: 'too-many-items',
        message: `projects exceeds the maximum of ${WORKSPACE_CACHE_MAX_PROJECTS} (got ${input.projects.length})`,
        path: 'projects',
      });
    }
    const projectIds = new Set<string>();
    for (let index = 0; index < input.projects.length; index += 1) {
      const path = `projects[${index}]`;
      const project: unknown = input.projects[index];
      if (!isRecordLike(project)) {
        problems.push({ code: 'invalid-field', message: 'project must be an object', path });
        continue;
      }
      checkUnknownFields(project, PROJECT_FIELDS, path, problems);
      if (!isValidId(project.projectId)) {
        problems.push({
          code: 'invalid-field',
          message: `projectId must match ${String(ID_PATTERN)}`,
          path: `${path}.projectId`,
        });
      } else if (projectIds.has(project.projectId)) {
        problems.push({
          code: 'invalid-field',
          message: 'projectId is duplicated',
          path: `${path}.projectId`,
        });
      } else {
        projectIds.add(project.projectId);
      }
      if (
        typeof project.name !== 'string' ||
        project.name.length === 0 ||
        project.name.length > WORKSPACE_CACHE_MAX_DISPLAY_TEXT_CODE_UNITS ||
        DISPLAY_TEXT_CONTROL_PATTERN.test(project.name)
      ) {
        problems.push({
          code: 'oversize-field',
          message: `project name must be 1..${WORKSPACE_CACHE_MAX_DISPLAY_TEXT_CODE_UNITS} code units without control characters`,
          path: `${path}.name`,
        });
      } else {
        const forbidden = findForbiddenContent(project.name);
        if (forbidden !== null) {
          problems.push({
            code: 'forbidden-content',
            message: `project name matches a credential-shaped pattern (${forbidden}) and is rejected`,
            path: `${path}.name`,
          });
        }
      }
    }
    // Panes.
    if (!Array.isArray(input.panes)) {
      problems.push({ code: 'invalid-field', message: 'panes must be an array', path: 'panes' });
    } else {
      if (input.panes.length > WORKSPACE_CACHE_MAX_PANES) {
        problems.push({
          code: 'too-many-items',
          message: `panes exceeds the maximum of ${WORKSPACE_CACHE_MAX_PANES} (got ${input.panes.length})`,
          path: 'panes',
        });
      }
      const paneIds = new Set<string>();
      const paneProjects = new Map<string, string>();
      for (let index = 0; index < input.panes.length; index += 1) {
        const path = `panes[${index}]`;
        const pane: unknown = input.panes[index];
        if (!isRecordLike(pane)) {
          problems.push({ code: 'invalid-field', message: 'pane must be an object', path });
          continue;
        }
        checkUnknownFields(pane, PANE_FIELDS, path, problems);
        if (!isValidId(pane.paneId)) {
          problems.push({
            code: 'invalid-field',
            message: `paneId must match ${String(ID_PATTERN)}`,
            path: `${path}.paneId`,
          });
        } else if (paneIds.has(pane.paneId)) {
          problems.push({
            code: 'invalid-field',
            message: 'paneId is duplicated',
            path: `${path}.paneId`,
          });
        } else {
          paneIds.add(pane.paneId);
        }
        if (typeof pane.projectId === 'string') {
          paneProjects.set(pane.paneId as string, pane.projectId);
        }
        if (!isValidId(pane.projectId)) {
          problems.push({
            code: 'invalid-field',
            message: `pane projectId must match ${String(ID_PATTERN)}`,
            path: `${path}.projectId`,
          });
        } else if (projectIds.size > 0 && !projectIds.has(pane.projectId)) {
          problems.push({
            code: 'invalid-field',
            message: 'pane references a projectId that is not cached',
            path: `${path}.projectId`,
          });
        }
        if (
          typeof pane.title !== 'string' ||
          pane.title.length === 0 ||
          pane.title.length > WORKSPACE_CACHE_MAX_DISPLAY_TEXT_CODE_UNITS ||
          DISPLAY_TEXT_CONTROL_PATTERN.test(pane.title)
        ) {
          problems.push({
            code: 'oversize-field',
            message: `pane title must be 1..${WORKSPACE_CACHE_MAX_DISPLAY_TEXT_CODE_UNITS} code units without control characters`,
            path: `${path}.title`,
          });
        } else {
          const forbidden = findForbiddenContent(pane.title);
          if (forbidden !== null) {
            problems.push({
              code: 'forbidden-content',
              message: `pane title matches a credential-shaped pattern (${forbidden}) and is rejected`,
              path: `${path}.title`,
            });
          }
        }
      }
      // Selection.
      if (input.selection === undefined || input.selection === null) {
        if (input.selection === undefined) {
          problems.push({
            code: 'missing-field',
            message: 'selection is required (use null when nothing is selected)',
            path: 'selection',
          });
        }
      } else if (!isRecordLike(input.selection)) {
        problems.push({
          code: 'invalid-field',
          message: 'selection must be an object or null',
          path: 'selection',
        });
      } else {
        checkUnknownFields(input.selection, SELECTION_FIELDS, 'selection', problems);
        const selection = input.selection;
        if (!isValidId(selection.projectId)) {
          problems.push({
            code: 'invalid-field',
            message: `selection projectId must match ${String(ID_PATTERN)}`,
            path: 'selection.projectId',
          });
        } else if (projectIds.size > 0 && !projectIds.has(selection.projectId)) {
          problems.push({
            code: 'invalid-field',
            message: 'selection references a projectId that is not cached',
            path: 'selection.projectId',
          });
        }
        if (selection.paneId !== undefined) {
          if (!isValidId(selection.paneId)) {
            problems.push({
              code: 'invalid-field',
              message: `selection paneId must match ${String(ID_PATTERN)}`,
              path: 'selection.paneId',
            });
          } else if (paneIds.size > 0 && !paneIds.has(selection.paneId)) {
            problems.push({
              code: 'invalid-field',
              message: 'selection references a paneId that is not cached',
              path: 'selection.paneId',
            });
          } else {
            const paneProject = paneProjects.get(selection.paneId as string);
            if (
              paneProject !== undefined &&
              typeof selection.projectId === 'string' &&
              paneProject !== selection.projectId
            ) {
              problems.push({
                code: 'invalid-field',
                message: 'selection paneId does not belong to the selected project',
                path: 'selection.paneId',
              });
            }
          }
        }
      }
      // Drafts.
      if (!Array.isArray(input.drafts)) {
        problems.push({ code: 'invalid-field', message: 'drafts must be an array', path: 'drafts' });
      } else {
        if (input.drafts.length > WORKSPACE_CACHE_MAX_DRAFTS) {
          problems.push({
            code: 'too-many-items',
            message: `drafts exceeds the maximum of ${WORKSPACE_CACHE_MAX_DRAFTS} (got ${input.drafts.length})`,
            path: 'drafts',
          });
        }
        const draftPaneIds = new Set<string>();
        for (let index = 0; index < input.drafts.length; index += 1) {
          const path = `drafts[${index}]`;
          const draft: unknown = input.drafts[index];
          if (!isRecordLike(draft)) {
            problems.push({ code: 'invalid-field', message: 'draft must be an object', path });
            continue;
          }
          checkUnknownFields(draft, DRAFT_FIELDS, path, problems);
          if (!isValidId(draft.paneId)) {
            problems.push({
              code: 'invalid-field',
              message: `draft paneId must match ${String(ID_PATTERN)}`,
              path: `${path}.paneId`,
            });
          } else if (draftPaneIds.has(draft.paneId)) {
            problems.push({
              code: 'invalid-field',
              message: 'draft paneId is duplicated',
              path: `${path}.paneId`,
            });
          } else {
            draftPaneIds.add(draft.paneId);
            if (paneIds.size > 0 && !paneIds.has(draft.paneId)) {
              problems.push({
                code: 'invalid-field',
                message: 'draft references a paneId that is not cached',
                path: `${path}.paneId`,
              });
            }
          }
          if (
            typeof draft.text !== 'string' ||
            draft.text.length > WORKSPACE_CACHE_MAX_DRAFT_CODE_UNITS ||
            DRAFT_CONTROL_PATTERN.test(draft.text)
          ) {
            problems.push({
              code: 'oversize-field',
              message: `draft text must be at most ${WORKSPACE_CACHE_MAX_DRAFT_CODE_UNITS} code units without control characters other than tab and line feed`,
              path: `${path}.text`,
            });
          } else {
            const forbidden = findForbiddenContent(draft.text);
            if (forbidden !== null) {
              problems.push({
                code: 'forbidden-content',
                message: `draft text matches a credential-shaped pattern (${forbidden}) and is rejected`,
                path: `${path}.text`,
              });
            }
          }
        }
      }
    }
  }

  return problems;
}

/**
 * Serialize a validated record to its canonical byte form: fixed key order,
 * JSON encoding, UTF-8 bytes. Deterministic — the same record always yields
 * byte-identical output.
 */
function serializeRecord(record: CachedWorkspaceState): Uint8Array {
  const json = JSON.stringify({
    version: record.version,
    hostKey: record.hostKey,
    workspaceId: record.workspaceId,
    lastConfirmedSequence: record.lastConfirmedSequence,
    ...(record.lastConfirmedAtMs === undefined
      ? {}
      : { lastConfirmedAtMs: record.lastConfirmedAtMs }),
    projects: record.projects.map((project) => ({
      projectId: project.projectId,
      name: project.name,
    })),
    panes: record.panes.map((pane) => ({
      paneId: pane.paneId,
      projectId: pane.projectId,
      title: pane.title,
    })),
    selection:
      record.selection === null
        ? null
        : record.selection.paneId === undefined
          ? { projectId: record.selection.projectId }
          : { projectId: record.selection.projectId, paneId: record.selection.paneId },
    drafts: record.drafts.map((draft) => ({ paneId: draft.paneId, text: draft.text })),
  });
  return encodeUtf8(json);
}

function stampRecord(state: WorkspaceCacheStateInput, hostKey: string): CachedWorkspaceState {
  return {
    version: WORKSPACE_CACHE_RECORD_VERSION,
    hostKey,
    workspaceId: state.workspaceId,
    lastConfirmedSequence: state.lastConfirmedSequence,
    ...(state.lastConfirmedAtMs === undefined
      ? {}
      : { lastConfirmedAtMs: state.lastConfirmedAtMs }),
    projects: state.projects.map((project) => ({
      projectId: project.projectId,
      name: project.name,
    })),
    panes: state.panes.map((pane) => ({
      paneId: pane.paneId,
      projectId: pane.projectId,
      title: pane.title,
    })),
    selection:
      state.selection === null
        ? null
        : state.selection.paneId === undefined
          ? { projectId: state.selection.projectId }
          : { projectId: state.selection.projectId, paneId: state.selection.paneId },
    drafts: state.drafts.map((draft) => ({ paneId: draft.paneId, text: draft.text })),
  };
}

/** Map validation problems to the typed save error code (first problem wins; all problems are attached). */
function errorForProblems(problems: readonly WorkspaceCacheProblem[]): WorkspaceCacheError {
  return new WorkspaceCacheError(
    problems[0]!.code,
    'workspace cache state failed strict validation; nothing was truncated or written',
    { problems },
  );
}

export interface WorkspaceCacheSaveRequest {
  readonly storage: WorkspaceCacheStorageAdapter;
  readonly host: WorkspaceHostIdentity;
  readonly state: WorkspaceCacheStateInput;
  /**
   * Attestation that the state being cached was observed during an
   * authenticated session (for example the last-known state of a session
   * that has since dropped). The literal `true` type makes pre-auth writes
   * inexpressible at compile time; the runtime check covers untyped callers.
   */
  readonly auth: { readonly authAccepted: true };
}

/**
 * Save (or atomically replace) the workspace cache for the deriving host.
 * Flow: validate → stamp → serialize → byte-budget check → writeTemp →
 * promote. Every failure leaves the previously promoted record untouched;
 * nothing is ever truncated. Throws {@link WorkspaceCacheError} on any
 * rejection; the adapter is untouched when validation fails.
 */
export function saveWorkspaceCache(request: WorkspaceCacheSaveRequest): WorkspaceCacheSaveResult {
  if (request.auth.authAccepted !== true) {
    throw new WorkspaceCacheError(
      'auth-required',
      'workspace cache writes require an authenticated-session attestation',
    );
  }
  const hostKey = deriveHostKey(request.host);
  const problems = validateCachedWorkspaceState(request.state, {
    mode: 'input',
    expectedHostKey: hostKey,
  });
  if (problems.length > 0) {
    throw errorForProblems(problems);
  }
  const record = stampRecord(request.state, hostKey);
  const bytes = serializeRecord(record);
  if (bytes.byteLength > WORKSPACE_CACHE_MAX_RECORD_BYTES) {
    throw new WorkspaceCacheError(
      'oversize-record',
      `serialized record is ${bytes.byteLength} bytes and exceeds the ${WORKSPACE_CACHE_MAX_RECORD_BYTES}-byte budget; it is rejected, not truncated`,
    );
  }
  const key = workspaceCacheStorageKey(hostKey);
  let temp: WorkspaceCacheTempHandle;
  try {
    temp = request.storage.writeTemp(key, bytes);
  } catch (cause) {
    throw new WorkspaceCacheError('temp-write-failed', 'storage adapter failed the temp write', {
      cause,
    });
  }
  try {
    request.storage.promote(key, temp);
  } catch (cause) {
    try {
      request.storage.discardTemp(temp);
    } catch {
      // Best-effort cleanup; the promote failure is the actionable error.
    }
    throw new WorkspaceCacheError(
      'promote-failed',
      'storage adapter failed the atomic promote; the previously promoted record is untouched',
      { cause },
    );
  }
  return { hostKey, storageKey: key, byteLength: bytes.byteLength, record };
}

export interface WorkspaceCacheRestoreRequest {
  readonly storage: WorkspaceCacheStorageAdapter;
  readonly host: WorkspaceHostIdentity;
  /**
   * Whether the session's first successful authentication has happened.
   * False restores the record as protected-inert. This is a caller
   * attestation — the platform layer passes it only after its bridge session
   * reported authentication success — and the protection envelope keeps the
   * restored state non-live regardless of the assertion.
   */
  readonly auth: { readonly authAccepted: boolean };
}

/**
 * Restore the workspace cache for the deriving host. Never exposes
 * other-host, malformed, oversize, or foreign-version payloads; such records
 * come back as `refused-other-host` / `unusable` and are left in place
 * (explicit {@link discardWorkspaceCache} is the only removal path).
 */
export function restoreWorkspaceCache(
  request: WorkspaceCacheRestoreRequest,
): WorkspaceCacheRestoreResult {
  const hostKey = deriveHostKey(request.host);
  const key = workspaceCacheStorageKey(hostKey);
  let bytes: Uint8Array | null;
  try {
    bytes = request.storage.read(key);
  } catch (cause) {
    throw new WorkspaceCacheError('storage-read-failed', 'storage adapter failed the read', {
      cause,
    });
  }
  if (bytes === null) {
    return { status: 'empty' };
  }
  if (bytes.byteLength > WORKSPACE_CACHE_MAX_RECORD_BYTES) {
    return {
      status: 'unusable',
      problems: [
        {
          code: 'oversize-record',
          message: `stored record is ${bytes.byteLength} bytes and exceeds the ${WORKSPACE_CACHE_MAX_RECORD_BYTES}-byte budget`,
        },
      ],
    };
  }
  const text = decodeUtf8(bytes);
  if (text === null) {
    return {
      status: 'unusable',
      problems: [{ code: 'invalid-record', message: 'stored record is not valid UTF-8' }],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return {
      status: 'unusable',
      problems: [{ code: 'invalid-record', message: 'stored record is not valid JSON' }],
    };
  }
  // Host refusal runs before deep validation and before any payload exposure:
  // a stored key that is absent, non-string, malformed, or simply not ours
  // means the record does not belong to this host.
  if (isRecordLike(parsed) && typeof parsed.hostKey === 'string') {
    const storedHostKey = parsed.hostKey;
    const shapeOk =
      HOST_ID_PATTERN.test(storedHostKey.split(':').slice(1).join(':')) &&
      WORKSPACE_CACHE_PLATFORMS.includes(storedHostKey.split(':', 1)[0] as WorkspaceCachePlatform);
    if (!shapeOk || storedHostKey !== hostKey) {
      return { status: 'refused-other-host' };
    }
  }
  const problems = validateCachedWorkspaceState(parsed, {
    mode: 'stored',
    expectedHostKey: hostKey,
  });
  if (problems.length > 0) {
    return { status: 'unusable', problems };
  }
  const record = parsed as CachedWorkspaceState;
  return {
    status: 'restored',
    state: {
      record,
      hostKey,
      protection: request.auth.authAccepted ? 'stale-pending-reconciliation' : 'protected-inert',
      presentableAsLive: false,
      inputEnabled: false,
      mutationsAllowed: false,
      reconciliationAllowed: request.auth.authAccepted === true,
    },
  };
}

export interface WorkspaceCacheDiscardRequest {
  readonly storage: WorkspaceCacheStorageAdapter;
  readonly host: WorkspaceHostIdentity;
}

/**
 * Explicitly remove this host's cache record. The only removal path —
 * restore never deletes implicitly, so an unreadable record stays available
 * for diagnosis until someone discards it deliberately. Idempotent.
 */
export function discardWorkspaceCache(
  request: WorkspaceCacheDiscardRequest,
): { readonly removed: boolean } {
  const hostKey = deriveHostKey(request.host);
  const key = workspaceCacheStorageKey(hostKey);
  const existed = request.storage.read(key) !== null;
  request.storage.remove(key);
  return { removed: existed };
}

/** Identity-bound store facade: the ergonomic entry point for platform layers. */
export interface WorkspaceCacheStore {
  readonly hostKey: string;
  readonly storageKey: string;
  save(state: WorkspaceCacheStateInput, auth: { readonly authAccepted: true }): WorkspaceCacheSaveResult;
  restore(auth: { readonly authAccepted: boolean }): WorkspaceCacheRestoreResult;
  discard(): { readonly removed: boolean };
}

/**
 * Bind a storage adapter and a host identity into a store facade. The host
 * key is derived exactly once, so save/restore/discard are key-consistent by
 * construction.
 */
export function createWorkspaceCacheStore(request: {
  readonly storage: WorkspaceCacheStorageAdapter;
  readonly host: WorkspaceHostIdentity;
}): WorkspaceCacheStore {
  const hostKey = deriveHostKey(request.host);
  const storageKey = workspaceCacheStorageKey(hostKey);
  const storage = request.storage;
  return {
    hostKey,
    storageKey,
    save(state, auth) {
      return saveWorkspaceCache({ storage, host: request.host, state, auth });
    },
    restore(auth) {
      return restoreWorkspaceCache({ storage, host: request.host, auth });
    },
    discard() {
      return discardWorkspaceCache({ storage, host: request.host });
    },
  };
}

/**
 * Pure in-memory reference adapter implementing the write-temp-then-promote
 * model. Used by the test suite and as the executable specification for
 * platform adapters: temp writes are invisible until promoted, promote
 * swaps atomically, reads return copies, and unknown temp handles are
 * rejected.
 */
export function createMemoryWorkspaceCacheStorage(): WorkspaceCacheStorageAdapter {
  const promoted = new Map<string, Uint8Array>();
  const temps = new Map<string, Uint8Array>();
  let tempCounter = 0;
  return {
    read(key) {
      const bytes = promoted.get(key);
      return bytes === undefined ? null : bytes.slice();
    },
    writeTemp(key, bytes) {
      tempCounter += 1;
      const handle = `temp-${tempCounter}`;
      temps.set(handle, bytes.slice());
      return handle;
    },
    promote(key, temp) {
      const bytes = temps.get(temp);
      if (bytes === undefined) {
        throw new Error(`memory adapter: unknown temp handle ${JSON.stringify(temp)}`);
      }
      promoted.set(key, bytes.slice());
      temps.delete(temp);
    },
    discardTemp(temp) {
      temps.delete(temp);
    },
    remove(key) {
      promoted.delete(key);
    },
  };
}
