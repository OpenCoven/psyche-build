/**
 * Versioned cross-platform Vim acceptance manifest (v1).
 *
 * Vim Slice 5 (OpenCoven/psyche-build#227, Bead psyche-no8.5) owns the
 * acceptance contract: one fixture version shared by desktop, web, the Ink
 * TUI, and iOS, and a bounded set of acceptance items each platform slice
 * must execute and record before its behavior may be claimed. The manifest
 * records no claim by itself: `validateAcceptanceManifest` fails closed on
 * missing platforms, unknown fields, unknown statuses, missing or unknown
 * items, fixture-version drift, and items that claim success without evidence
 * or record a gap without naming it.
 *
 * The platform adapters themselves are owned by OpenCoven/psyche-build#223
 * (desktop reference adapter), #224 (browser/web), #225 (Ink TUI), and #226
 * (iOS). Until those slices execute their checklists, every item is
 * `not-run`; this module defines what they must later prove.
 */

/** Manifest schema version. Bump only with an explicit, reviewed contract change. */
export const VIM_ACCEPTANCE_MANIFEST_VERSION = 1 as const;

/**
 * The single shared Vim conformance fixture version every platform must
 * implement. Must stay identical to the `version` declared by the fixture
 * documents under `protocol-fixtures/vim/v1/` and validated by
 * `@opencoven/psyche-vim-core`. A platform declaring any other version fails
 * its conformance gate instead of silently accepting drift.
 */
export const VIM_ACCEPTANCE_FIXTURE_VERSION = 'vim/v1' as const;

export type VimFixtureVersion = typeof VIM_ACCEPTANCE_FIXTURE_VERSION;

/** Platforms that must agree on one fixture version. */
export const VIM_ACCEPTANCE_PLATFORMS = ['desktop', 'web', 'ink', 'ios'] as const;

export type VimAcceptancePlatform = (typeof VIM_ACCEPTANCE_PLATFORMS)[number];

/** Bounded acceptance status vocabulary. Any other value is rejected. */
export const VIM_ACCEPTANCE_STATUSES = ['pass', 'fail', 'not-run', 'unavailable'] as const;

export type VimAcceptanceStatus = (typeof VIM_ACCEPTANCE_STATUSES)[number];

/** Maximum accepted length of one acceptance item id. */
export const MAX_ACCEPTANCE_ITEM_ID_LENGTH = 128;
/** Maximum accepted length of one `evidence` or `gap` note. */
export const MAX_ACCEPTANCE_NOTE_LENGTH = 512;
/** Maximum accepted number of items on one platform. */
export const MAX_ACCEPTANCE_ITEMS_PER_PLATFORM = 64;

/**
 * Acceptance items required on every platform: the shared contract floor.
 * Item ids are stable contract identifiers; human-readable requirements live
 * in `docs/vim/ACCEPTANCE-MATRIX.md`, which must name every id listed here.
 */
const COMMON_REQUIRED_ITEMS = [
  'fixture-conformance',
  'opt-in-disabled-passthrough',
  'opt-in-persistence-rebind',
  'terminal-byte-passthrough',
  'chrome-trigger-enter-exit',
  'pending-reset-boundaries',
  'unsupported-action-safety',
  'guarded-actions-authority',
  'focus-restoration',
  'accessibility-announcements',
  'mode-aware-help',
  'real-vim-smoke',
  'real-neovim-smoke',
  'tmux-nested-smoke',
  'dispatch-performance-budget',
] as const;

/**
 * Required acceptance item ids per platform: the shared floor plus each
 * platform's specific obligations from the approved Vim design.
 */
export const REQUIRED_VIM_ACCEPTANCE_ITEMS: Readonly<
  Record<VimAcceptancePlatform, readonly string[]>
> = {
  desktop: [
    ...COMMON_REQUIRED_ITEMS,
    'existing-shortcuts-preserved',
    'embedded-editor-parity',
    'desktop-browser-automation',
  ],
  web: [
    ...COMMON_REQUIRED_ITEMS,
    'keys-transport-unchanged',
    'native-text-inputs-unchanged',
    'web-browser-automation',
  ],
  ink: [
    ...COMMON_REQUIRED_ITEMS,
    'input-precedence-top',
    'existing-shortcuts-preserved',
  ],
  ios: [
    ...COMMON_REQUIRED_ITEMS,
    'hardware-keyboard-command',
    'software-chrome-key',
    'pty-transport-unchanged',
    'swift-fixture-parity',
    'physical-device-evidence',
  ],
};

/** One acceptance item: a required id, its bounded status, and honest notes. */
export interface VimAcceptanceItem {
  /** Stable id from `REQUIRED_VIM_ACCEPTANCE_ITEMS` for the owning platform. */
  readonly id: string;
  readonly status: VimAcceptanceStatus;
  /**
   * Required for `pass`. Names the exact command run, the observed result, and
   * the source SHA or artifact it is tied to. Bounded; never raw terminal
   * bytes, pasted text, editor contents, or unrestricted logs.
   */
  readonly evidence?: string;
  /**
   * Required for `fail`, `not-run`, and `unavailable`. Names the concrete gap
   * and where it is tracked. A `pass` item must not declare a gap.
   */
  readonly gap?: string;
}

/** One platform's acceptance record against the shared fixture version. */
export interface VimAcceptancePlatformManifest {
  /** Must equal `VIM_ACCEPTANCE_FIXTURE_VERSION`; drift fails the gate. */
  readonly fixtureVersion: VimFixtureVersion;
  readonly items: readonly VimAcceptanceItem[];
}

/** The complete cross-platform acceptance manifest (schema version 1). */
export interface VimAcceptanceManifest {
  readonly version: typeof VIM_ACCEPTANCE_MANIFEST_VERSION;
  readonly platforms: Readonly<Record<VimAcceptancePlatform, VimAcceptancePlatformManifest>>;
}

const DEFAULT_UNSTARTED_GAP =
  'Awaiting execution by the owning platform slice; no acceptance evidence exists yet.';

function invalid(message: string): never {
  throw new TypeError(`Invalid Vim acceptance manifest: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(
  candidate: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(candidate)) {
    if (!allowed.includes(key)) invalid(`${where} has unknown field ${JSON.stringify(key)}`);
  }
}

function validateBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
  allowEmpty = false,
): asserts value is string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maxLength) {
    invalid(`${field} has an invalid string`);
  }
}

function requireNote(
  item: Record<string, unknown>,
  field: 'evidence' | 'gap',
  platform: VimAcceptancePlatform,
  id: string,
): void {
  if (!Object.hasOwn(item, field)) {
    invalid(`${platform} item ${id} with status ${item.status} requires ${field}`);
  }
  validateBoundedString(item[field], `${platform} item ${id} ${field}`, MAX_ACCEPTANCE_NOTE_LENGTH);
}

function validatePlatformItems(
  platform: VimAcceptancePlatform,
  items: readonly VimAcceptanceItem[],
): void {
  const required = REQUIRED_VIM_ACCEPTANCE_ITEMS[platform];
  const seen = new Set<string>();
  for (const entry of items) {
    if (!isPlainObject(entry)) invalid(`${platform} items must be objects`);
    rejectUnknownFields(entry, ['id', 'status', 'evidence', 'gap'], `${platform} item`);
    validateBoundedString(entry.id, `${platform} item id`, MAX_ACCEPTANCE_ITEM_ID_LENGTH);
    if (seen.has(entry.id)) invalid(`${platform} has duplicate item ${entry.id}`);
    seen.add(entry.id);
    if (!required.includes(entry.id)) {
      invalid(`${platform} has unknown acceptance item ${entry.id}`);
    }
    if (
      !VIM_ACCEPTANCE_STATUSES.includes(entry.status as VimAcceptanceStatus) ||
      typeof entry.status !== 'string'
    ) {
      invalid(
        `${platform} item ${entry.id} has status ${JSON.stringify(entry.status)}; allowed: ${VIM_ACCEPTANCE_STATUSES.join(', ')}`,
      );
    }
    if (entry.status === 'pass') {
      requireNote(entry, 'evidence', platform, entry.id);
      if (Object.hasOwn(entry, 'gap')) invalid(`${platform} item ${entry.id} claims pass but declares a gap`);
    } else {
      requireNote(entry, 'gap', platform, entry.id);
      if (Object.hasOwn(entry, 'evidence')) {
        validateBoundedString(
          entry.evidence,
          `${platform} item ${entry.id} evidence`,
          MAX_ACCEPTANCE_NOTE_LENGTH,
        );
      }
    }
  }
  const missing = required.filter((id) => !seen.has(id));
  if (missing.length > 0) invalid(`${platform} is missing required acceptance item(s) ${missing.join(', ')}`);
}

/**
 * Strictly validates a cross-platform Vim acceptance manifest: all four
 * platforms covered with no unknown platform keys, no unknown fields at any
 * level, the shared fixture version on every platform, the complete required
 * item catalog per platform with no duplicates or extras, statuses bounded to
 * `pass`/`fail`/`not-run`/`unavailable`, and evidence/gap discipline enforced.
 */
export function validateAcceptanceManifest(manifest: unknown): asserts manifest is VimAcceptanceManifest {
  if (!isPlainObject(manifest)) invalid('manifest must be an object');
  rejectUnknownFields(manifest, ['version', 'platforms'], 'manifest');
  if (
    manifest.version !== VIM_ACCEPTANCE_MANIFEST_VERSION ||
    typeof manifest.version !== 'number'
  ) {
    invalid(`manifest must declare version ${VIM_ACCEPTANCE_MANIFEST_VERSION}`);
  }
  if (!isPlainObject(manifest.platforms)) invalid('manifest must contain platforms');

  const present = Object.keys(manifest.platforms);
  const required = VIM_ACCEPTANCE_PLATFORMS as readonly string[];
  const missing = required.filter((platform) => !present.includes(platform));
  if (missing.length > 0) invalid(`platforms is missing required platform(s) ${missing.join(', ')}`);
  const unknown = present.filter((platform) => !required.includes(platform));
  if (unknown.length > 0) invalid(`platforms has unknown platform(s) ${unknown.join(', ')}`);

  for (const platform of required as VimAcceptancePlatform[]) {
    const entry = manifest.platforms[platform];
    if (!isPlainObject(entry)) invalid(`${platform} manifest must be an object`);
    rejectUnknownFields(entry, ['fixtureVersion', 'items'], `${platform} manifest`);
    if (entry.fixtureVersion !== VIM_ACCEPTANCE_FIXTURE_VERSION) {
      invalid(
        `${platform} must declare fixture version ${VIM_ACCEPTANCE_FIXTURE_VERSION}, got ${JSON.stringify(entry.fixtureVersion)}`,
      );
    }
    if (!Array.isArray(entry.items)) invalid(`${platform} must contain items`);
    if (entry.items.length === 0) invalid(`${platform} must contain at least one item`);
    if (entry.items.length > MAX_ACCEPTANCE_ITEMS_PER_PLATFORM) {
      invalid(`${platform} item count exceeds ${MAX_ACCEPTANCE_ITEMS_PER_PLATFORM}`);
    }
    validatePlatformItems(platform, entry.items);
  }
}

function unstartedPlatformManifest(
  platform: VimAcceptancePlatform,
  gap: string,
): VimAcceptancePlatformManifest {
  return {
    fixtureVersion: VIM_ACCEPTANCE_FIXTURE_VERSION,
    items: REQUIRED_VIM_ACCEPTANCE_ITEMS[platform].map((id) => ({
      id,
      status: 'not-run' as const,
      gap,
    })),
  };
}

/**
 * Builds the v1 manifest in its honest initial state: every required item on
 * every platform is `not-run` with the given gap note. Platform slices fill
 * their own statuses and evidence as they execute the matrix.
 */
export function createUnstartedAcceptanceManifest(gap: string = DEFAULT_UNSTARTED_GAP): VimAcceptanceManifest {
  const manifest: VimAcceptanceManifest = {
    version: VIM_ACCEPTANCE_MANIFEST_VERSION,
    platforms: {
      desktop: unstartedPlatformManifest('desktop', gap),
      web: unstartedPlatformManifest('web', gap),
      ink: unstartedPlatformManifest('ink', gap),
      ios: unstartedPlatformManifest('ios', gap),
    },
  };
  validateAcceptanceManifest(manifest);
  return manifest;
}
