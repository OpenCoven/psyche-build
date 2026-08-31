import fs from 'fs';
import path from 'path';
import type { SidebarProject, PsychePane } from '../types.js';
import {
  isAgentName,
  type AgentName,
} from './agentLaunch.js';
import { getPaneProjectRoot } from './paneProject.js';
import { getPaneDisplayName } from './paneTitle.js';
import { sameSidebarProjectRoot } from './sidebarProjects.js';

export const RITUAL_VERSION = 1;
export const MAX_PROJECT_RITUAL_FILES = 100;
export const MAX_PROJECT_RITUAL_DIRECTORY_ENTRIES = MAX_PROJECT_RITUAL_FILES;
export const MAX_PROJECT_RITUAL_FILE_BYTES = 64 * 1024;
export const MAX_PROJECT_RITUAL_STORE_BYTES = 512 * 1024;
export const MAX_PROJECT_RITUAL_MANIFEST_BYTES = 16 * 1024;
export const MAX_PROJECT_RITUAL_READ_BYTES =
  MAX_PROJECT_RITUAL_STORE_BYTES + MAX_PROJECT_RITUAL_MANIFEST_BYTES;
export const MAX_PUBLISHED_RITUAL_ID_BYTES = 128;
export const MAX_PUBLISHED_RITUAL_NAME_BYTES = 256;
export const MAX_PUBLISHED_RITUAL_DESCRIPTION_BYTES = 1024;

export type RitualScope = 'builtin' | 'project';
export type RitualPaneKind = 'agent' | 'terminal';

export interface RitualPaneDefinition {
  kind: RitualPaneKind;
  name?: string;
  prompt?: string;
  agent?: AgentName;
  command?: string;
}

const FIX_OPENCLAW_COMMAND = 'coven fix openclaw --repo "$PWD" --keep-session';

const FIX_OPENCLAW_VERIFY_COMMAND = `while true; do
  clear
  date
  echo "Fix OpenClaw verification cockpit"
  echo
  git diff --check
  echo
  git status --short
  echo
  echo "Run focused checks here when the repair pane changes files."
  sleep 5
done`;

const FIX_OPENCLAW_DIFF_COMMAND = `while true; do
  clear
  date
  echo "Changed files"
  git status --short
  echo
  echo "Diff stat"
  git diff --stat
  echo
  echo "Names"
  git diff --name-only
  sleep 5
done`;

const FIX_OPENCLAW_SESSIONS_COMMAND = `while true; do
  clear
  date
  echo "Coven sessions"
  coven sessions --json 2>/dev/null || coven sessions 2>/dev/null || echo "No Coven sessions yet, or Coven is unavailable."
  sleep 5
done`;

export interface RitualProjectDefinition {
  projectRoot?: string;
  projectName?: string;
  panes: RitualPaneDefinition[];
}

export interface RitualDefinition {
  version: typeof RITUAL_VERSION;
  id: string;
  name: string;
  description?: string;
  scope: RitualScope;
  projects: RitualProjectDefinition[];
}

export interface ProjectRitualManifest {
  version: typeof RITUAL_VERSION;
  defaultRitualId?: string;
}

export interface CaptureRitualOptions {
  name: string;
  projectRoot: string;
  panes: PsychePane[];
  sidebarProjects: SidebarProject[];
}

const BUILT_IN_RITUALS: RitualDefinition[] = [
  {
    version: RITUAL_VERSION,
    id: 'start-coding',
    name: 'Start Coding',
    description: 'Open one agent pane for focused implementation work.',
    scope: 'builtin',
    projects: [
      {
        projectRoot: '.',
        panes: [
          {
            kind: 'agent',
            name: 'Implementation',
            prompt: 'Read AGENTS.md, inspect the current project, and implement the requested change.',
          },
        ],
      },
    ],
  },
  {
    version: RITUAL_VERSION,
    id: 'terminal-first',
    name: 'Terminal First',
    description: 'Open one terminal pane in this project.',
    scope: 'builtin',
    projects: [
      {
        projectRoot: '.',
        panes: [
          {
            kind: 'terminal',
            name: 'Terminal',
          },
        ],
      },
    ],
  },
  {
    version: RITUAL_VERSION,
    id: 'review-stack',
    name: 'Review Stack',
    description: 'Open implementation, review, and checks panes.',
    scope: 'builtin',
    projects: [
      {
        projectRoot: '.',
        panes: [
          {
            kind: 'agent',
            name: 'Implementation',
            prompt: 'Read AGENTS.md, inspect the current task, and implement the requested change.',
          },
          {
            kind: 'agent',
            name: 'Review',
            prompt: 'Review the implementation for bugs, regressions, missing tests, and maintainability risks.',
          },
          {
            kind: 'terminal',
            name: 'Checks',
          },
        ],
      },
    ],
  },
  {
    version: RITUAL_VERSION,
    id: 'release-check',
    name: 'Release Check',
    description: 'Open a release planning agent and checks terminal.',
    scope: 'builtin',
    projects: [
      {
        projectRoot: '.',
        panes: [
          {
            kind: 'agent',
            name: 'Release',
            prompt: 'Audit the release state, review changelog/version/package metadata, and identify blockers before publishing.',
          },
          {
            kind: 'terminal',
            name: 'Checks',
          },
        ],
      },
    ],
  },
  {
    version: RITUAL_VERSION,
    id: 'fix-openclaw',
    name: 'Fix OpenClaw',
    description: 'Open a Coven repair cockpit with separate repair, verification, diff, and session panes.',
    scope: 'builtin',
    projects: [
      {
        projectRoot: '.',
        panes: [
          {
            kind: 'terminal',
            name: 'Fix OpenClaw',
            command: FIX_OPENCLAW_COMMAND,
          },
          {
            kind: 'terminal',
            name: 'Verification',
            command: FIX_OPENCLAW_VERIFY_COMMAND,
          },
          {
            kind: 'terminal',
            name: 'Diff Watch',
            command: FIX_OPENCLAW_DIFF_COMMAND,
          },
          {
            kind: 'terminal',
            name: 'Coven Sessions',
            command: FIX_OPENCLAW_SESSIONS_COMMAND,
          },
        ],
      },
    ],
  },
];

export function getBuiltInRituals(): RitualDefinition[] {
  return BUILT_IN_RITUALS.map(cloneRitual);
}

export function getProjectRitualsDir(projectRoot: string): string {
  return path.join(projectRoot, '.psyche', 'rituals');
}

export function getProjectRitualManifestPath(projectRoot: string): string {
  return path.join(projectRoot, '.psyche', 'rituals.json');
}

export function ritualIdFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'ritual';
}

function cloneRitual(ritual: RitualDefinition): RitualDefinition {
  return {
    ...ritual,
    projects: ritual.projects.map((project) => ({
      ...project,
      panes: project.panes.map((pane) => ({ ...pane })),
    })),
  };
}

function normalizePane(value: unknown): RitualPaneDefinition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const parsed = value as Record<string, unknown>;
  const kind = parsed.kind === 'agent' || parsed.kind === 'terminal'
    ? parsed.kind
    : null;
  if (!kind) {
    return null;
  }

  const pane: RitualPaneDefinition = { kind };

  if (typeof parsed.name === 'string' && parsed.name.trim()) {
    pane.name = parsed.name.trim();
  }

  if (kind === 'agent' && typeof parsed.prompt === 'string' && parsed.prompt.trim()) {
    pane.prompt = parsed.prompt.trim();
  }

  if (kind === 'terminal' && typeof parsed.command === 'string' && parsed.command.trim()) {
    pane.command = parsed.command.trim();
  }

  if (typeof parsed.agent === 'string' && isAgentName(parsed.agent)) {
    pane.agent = parsed.agent;
  }

  return pane;
}

function normalizeProject(value: unknown): RitualProjectDefinition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const parsed = value as Record<string, unknown>;
  const panes = Array.isArray(parsed.panes)
    ? parsed.panes.map(normalizePane).filter((pane): pane is RitualPaneDefinition => !!pane)
    : [];

  if (panes.length === 0) {
    return null;
  }

  const project: RitualProjectDefinition = { panes };

  if (typeof parsed.projectRoot === 'string' && parsed.projectRoot.trim()) {
    project.projectRoot = parsed.projectRoot.trim();
  }

  if (typeof parsed.projectName === 'string' && parsed.projectName.trim()) {
    project.projectName = parsed.projectName.trim();
  }

  return project;
}

export function normalizeRitual(value: unknown, fallbackScope: RitualScope = 'project'): RitualDefinition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const parsed = value as Record<string, unknown>;
  if (parsed.version !== RITUAL_VERSION) {
    return null;
  }

  const name = typeof parsed.name === 'string' && parsed.name.trim()
    ? parsed.name.trim()
    : '';
  if (!name) {
    return null;
  }

  const id = typeof parsed.id === 'string' && parsed.id.trim()
    ? ritualIdFromName(parsed.id)
    : ritualIdFromName(name);
  // The loader, not repository-controlled JSON, determines whether a ritual is
  // trusted as built in. In particular, a project ritual must not be able to
  // opt into the privileges reserved for bundled rituals by setting its scope.
  const scope = fallbackScope;
  const projects = Array.isArray(parsed.projects)
    ? parsed.projects.map(normalizeProject).filter((project): project is RitualProjectDefinition => !!project)
    : [];

  if (projects.length === 0) {
    return null;
  }

  const ritual: RitualDefinition = {
    version: RITUAL_VERSION,
    id,
    name,
    scope,
    projects,
  };

  if (typeof parsed.description === 'string' && parsed.description.trim()) {
    ritual.description = parsed.description.trim();
  }

  return ritual;
}

export function saveProjectRitual(projectRoot: string, ritual: RitualDefinition): RitualDefinition {
  const normalized = normalizeRitual(
    {
      ...ritual,
      version: RITUAL_VERSION,
      id: ritual.id || ritualIdFromName(ritual.name),
      scope: 'project',
    },
    'project'
  );

  if (!normalized) {
    throw new Error('Invalid ritual definition');
  }

  const dir = getProjectRitualsDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${normalized.id}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
  return normalized;
}

export function listProjectRituals(projectRoot: string): RitualDefinition[] {
  const dir = getProjectRitualsDir(projectRoot);
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs.readdirSync(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => {
      try {
        const content = fs.readFileSync(path.join(dir, entry), 'utf-8');
        return normalizeRitual(JSON.parse(content), 'project');
      } catch {
        return null;
      }
    })
    .filter((ritual): ritual is RitualDefinition => !!ritual);
}

/**
 * What the project's on-disk ritual store actually contains, with the failure
 * classified instead of swallowed. Ritual publication needs the difference
 * between "the project defines nothing" and "the host may not read the store"
 * so a remote client can render the true state; listProjectRituals keeps its
 * long-standing lenient contract for existing callers.
 */
export interface RitualStoreListing {
  /** Every project ritual that parsed and normalized. */
  rituals: RitualDefinition[];
  /** Entries that exist but do not satisfy the supported ritual shape. */
  incompatibleCount: number;
  /** The host may not read the store (EACCES/EPERM somewhere in the read). */
  denied: boolean;
  /** The read failed for any other reason (unexpected fs or parse failure). */
  failed: boolean;
  /** The store exceeded its file-count, per-file, or aggregate byte limit. */
  limitExceeded: boolean;
  /** Bytes actually read from accepted regular files. */
  bytesRead: number;
}

export interface RitualManifestListing {
  defaultRitualId?: string;
  /** The host may not read the manifest. */
  denied: boolean;
  /** The manifest read failed for another filesystem reason. */
  failed: boolean;
  /** The manifest exists but does not satisfy the supported shape. */
  incompatible: boolean;
  /** The manifest exceeds its byte or identifier limit. */
  limitExceeded: boolean;
  /** Bytes actually read from the accepted regular manifest file. */
  bytesRead: number;
}

export function readProjectRitualStore(
  projectRoot: string,
  maxStoreBytes: number = MAX_PROJECT_RITUAL_STORE_BYTES,
): RitualStoreListing {
  const listing: RitualStoreListing = {
    rituals: [],
    incompatibleCount: 0,
    denied: false,
    failed: false,
    limitExceeded: false,
    bytesRead: 0,
  };
  const directoryChainRead = openRitualDirectoryChain(projectRoot, ['.psyche', 'rituals']);
  if (directoryChainRead.missing) {
    return listing;
  }
  if (
    directoryChainRead.denied
    || directoryChainRead.failed
    || directoryChainRead.incompatible
    || !directoryChainRead.chain
  ) {
    listing.denied = directoryChainRead.denied;
    listing.failed = directoryChainRead.failed;
    listing.incompatibleCount = directoryChainRead.incompatible ? 1 : 0;
    return listing;
  }

  const directoryChain = directoryChainRead.chain;
  try {
    const directoryRead = readBoundedRitualEntries(directoryChain);
    if (
      directoryRead.denied
      || directoryRead.failed
      || directoryRead.incompatible
      || directoryRead.limitExceeded
    ) {
      listing.denied = directoryRead.denied;
      listing.failed = directoryRead.failed;
      listing.incompatibleCount = directoryRead.incompatible ? 1 : 0;
      listing.limitExceeded = directoryRead.limitExceeded;
      return listing;
    }

    const aggregateLimit = Math.min(
      MAX_PROJECT_RITUAL_STORE_BYTES,
      normalizeReadBudget(maxStoreBytes),
    );
    let aggregateBytes = 0;
    for (const entry of directoryRead.entries) {
      const fileRead = readBoundedUtf8File(
        path.join(directoryChain.leafPath, entry),
        MAX_PROJECT_RITUAL_FILE_BYTES,
        aggregateLimit - aggregateBytes,
        directoryChain,
      );
      aggregateBytes += fileRead.bytes;
      listing.bytesRead = aggregateBytes;
      if (fileRead.content === undefined) {
        if (fileRead.denied) {
          listing.denied = true;
        } else if (fileRead.limitExceeded) {
          listing.limitExceeded = true;
        } else if (fileRead.incompatible) {
          listing.incompatibleCount += 1;
        } else {
          // A single unreadable entry must not mask the rest of the store, but
          // it does mean the listing is not a faithful read.
          listing.failed = true;
        }
        if (fileRead.aggregateLimitExceeded) {
          break;
        }
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(fileRead.content);
      } catch {
        // Malformed content is an unsupported entry, not a broken store read.
        listing.incompatibleCount += 1;
        continue;
      }

      const ritual = normalizeRitual(parsed, 'project');
      if (ritual) {
        listing.rituals.push(ritual);
      } else {
        listing.incompatibleCount += 1;
      }
    }
  } finally {
    applyRitualDirectoryCloseFailure(listing, closeRitualDirectoryChain(directoryChain));
  }
  return listing;
}

function readBoundedRitualEntries(directoryChain: RitualDirectoryChain): {
  entries: string[];
  missing: boolean;
  denied: boolean;
  failed: boolean;
  incompatible: boolean;
  limitExceeded: boolean;
} {
  const result = {
    entries: [] as string[],
    missing: false,
    denied: false,
    failed: false,
    incompatible: false,
    limitExceeded: false,
  };
  let directory: fs.Dir | undefined;
  try {
    assertRitualDirectoryChain(directoryChain);
    directory = fs.opendirSync(directoryChain.leafPath);
    assertRitualDirectoryChain(directoryChain);
  } catch (error) {
    try {
      directory?.closeSync();
    } catch {
      // The path validation failure remains the authoritative classification.
    }
    result.missing = false;
    result.denied = isPermissionError(error);
    result.incompatible = isMissingError(error) || isUnsafeRitualPathError(error);
    result.failed = !result.denied && !result.incompatible;
    return result;
  }
  const openedDirectory = directory;

  try {
    let examinedEntries = 0;
    while (true) {
      const entry = openedDirectory.readSync();
      if (!entry) break;
      examinedEntries += 1;
      if (examinedEntries > MAX_PROJECT_RITUAL_DIRECTORY_ENTRIES) {
        result.entries = [];
        result.limitExceeded = true;
        break;
      }
      if (!entry.name.endsWith('.json')) continue;
      if (result.entries.length >= MAX_PROJECT_RITUAL_FILES) {
        result.entries = [];
        result.limitExceeded = true;
        break;
      }
      result.entries.push(entry.name);
    }
    assertRitualDirectoryChain(directoryChain);
  } catch (error) {
    result.denied = isPermissionError(error);
    result.incompatible = isUnsafeRitualPathError(error);
    result.failed = !result.denied && !result.incompatible;
    result.entries = [];
  } finally {
    try {
      openedDirectory.closeSync();
    } catch (error) {
      result.denied ||= isPermissionError(error);
      result.incompatible ||= isUnsafeRitualPathError(error);
      result.failed ||= !result.denied && !result.incompatible;
      result.entries = [];
    }
  }

  result.entries.sort();
  return result;
}

function readBoundedUtf8File(
  filePath: string,
  maxFileBytes: number,
  aggregateBytesRemaining: number,
  directoryChain: RitualDirectoryChain,
): {
  content?: string;
  bytes: number;
  missing: boolean;
  denied: boolean;
  failed: boolean;
  incompatible: boolean;
  limitExceeded: boolean;
  aggregateLimitExceeded: boolean;
} {
  const result = {
    bytes: 0,
    missing: false,
    denied: false,
    failed: false,
    incompatible: false,
    limitExceeded: false,
    aggregateLimitExceeded: false,
  } as {
    content?: string;
    bytes: number;
    missing: boolean;
    denied: boolean;
    failed: boolean;
    incompatible: boolean;
    limitExceeded: boolean;
    aggregateLimitExceeded: boolean;
  };
  let descriptor: number;
  try {
    assertRitualDirectoryChain(directoryChain);
    descriptor = fs.openSync(filePath, ritualFileReadFlags());
  } catch (error) {
    result.missing = isMissingError(error);
    result.denied = isPermissionError(error);
    result.incompatible = isUnsafeRitualPathError(error);
    result.failed = !result.missing && !result.denied && !result.incompatible;
    return result;
  }

  try {
    assertRitualDirectoryChain(directoryChain);
    const openedStats = fs.fstatSync(descriptor, { bigint: true });
    if (!openedStats.isFile()) {
      result.incompatible = true;
      return result;
    }
    assertOpenedRitualFileIdentity(filePath, openedStats);
    const aggregateLimit = Math.max(0, aggregateBytesRemaining);
    if (
      openedStats.size > BigInt(maxFileBytes)
      || openedStats.size > BigInt(aggregateLimit)
    ) {
      result.limitExceeded = true;
      result.aggregateLimitExceeded = openedStats.size > BigInt(aggregateLimit);
      return result;
    }
    const expectedBytes = Number(openedStats.size);
    const buffer = Buffer.alloc(expectedBytes);
    while (result.bytes < expectedBytes) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        result.bytes,
        expectedBytes - result.bytes,
        result.bytes,
      );
      if (bytesRead === 0) {
        result.failed = true;
        return result;
      }
      result.bytes += bytesRead;
    }
    const currentStats = fs.fstatSync(descriptor, { bigint: true });
    if (!currentStats.isFile()) {
      result.incompatible = true;
      return result;
    }
    if (currentStats.size !== openedStats.size) {
      result.limitExceeded = currentStats.size > BigInt(maxFileBytes)
        || currentStats.size > BigInt(aggregateLimit);
      result.aggregateLimitExceeded = currentStats.size > BigInt(aggregateLimit);
      result.failed = !result.limitExceeded;
      return result;
    }
    assertRitualDirectoryChain(directoryChain);
    assertOpenedRitualFileIdentity(filePath, currentStats);
    result.content = buffer.toString('utf8');
  } catch (error) {
    result.denied = isPermissionError(error);
    result.incompatible = isMissingError(error) || isUnsafeRitualPathError(error);
    result.failed = !result.denied && !result.incompatible;
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      result.denied ||= isPermissionError(error);
      result.failed ||= !result.denied;
      result.content = undefined;
    }
  }
  return result;
}

function normalizeReadBudget(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return value;
}

interface RitualDirectoryIdentity {
  directoryPath: string;
  realPath: string;
  dev: bigint;
  ino: bigint;
  descriptor?: number;
}

interface RitualDirectoryChain {
  directories: RitualDirectoryIdentity[];
  leafPath: string;
}

// Node does not expose openat-style directory reads, so retain each verified
// descriptor and re-check path identity around every path-based operation.
function openRitualDirectoryChain(
  projectRoot: string,
  components: readonly string[],
): {
  chain?: RitualDirectoryChain;
  missing: boolean;
  denied: boolean;
  failed: boolean;
  incompatible: boolean;
} {
  const result = {
    missing: false,
    denied: false,
    failed: false,
    incompatible: false,
  } as {
    chain?: RitualDirectoryChain;
    missing: boolean;
    denied: boolean;
    failed: boolean;
    incompatible: boolean;
  };
  const directories: RitualDirectoryIdentity[] = [];
  try {
    const canonicalRoot = fs.realpathSync.native(path.resolve(projectRoot));
    const directoryPaths = [canonicalRoot];
    for (const component of components) {
      directoryPaths.push(path.join(directoryPaths.at(-1)!, component));
    }
    for (const directoryPath of directoryPaths) {
      directories.push(openRitualDirectory(directoryPath));
    }
    result.chain = {
      directories,
      leafPath: directoryPaths.at(-1)!,
    };
  } catch (error) {
    result.missing = isMissingError(error);
    result.denied = isPermissionError(error);
    result.incompatible = isUnsafeRitualPathError(error);
    result.failed = !result.missing && !result.denied && !result.incompatible;
    closeRitualDirectoryChain({
      directories,
      leafPath: directories.at(-1)?.directoryPath ?? path.resolve(projectRoot),
    });
  }
  return result;
}

function openRitualDirectory(directoryPath: string): RitualDirectoryIdentity {
  const initialStats = fs.lstatSync(directoryPath, { bigint: true });
  if (!initialStats.isDirectory() || initialStats.isSymbolicLink()) {
    throw unsafeRitualPathError();
  }

  let descriptor: number | undefined;
  try {
    if (process.platform !== 'win32') {
      descriptor = fs.openSync(directoryPath, ritualDirectoryReadFlags());
      const openedStats = fs.fstatSync(descriptor, { bigint: true });
      if (
        !openedStats.isDirectory()
        || openedStats.dev !== initialStats.dev
        || openedStats.ino !== initialStats.ino
      ) {
        throw unsafeRitualPathError();
      }
    }

    const realPath = fs.realpathSync.native(directoryPath);
    if (!sameRitualPath(realPath, directoryPath)) {
      throw unsafeRitualPathError();
    }
    const currentStats = fs.lstatSync(directoryPath, { bigint: true });
    if (
      !currentStats.isDirectory()
      || currentStats.isSymbolicLink()
      || currentStats.dev !== initialStats.dev
      || currentStats.ino !== initialStats.ino
    ) {
      throw unsafeRitualPathError();
    }
    return {
      directoryPath,
      realPath,
      dev: currentStats.dev,
      ino: currentStats.ino,
      ...(descriptor === undefined ? {} : { descriptor }),
    };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the validation failure that made this directory unsafe.
      }
    }
    throw error;
  }
}

function assertRitualDirectoryChain(directoryChain: RitualDirectoryChain): void {
  for (const identity of directoryChain.directories) {
    try {
      if (identity.descriptor !== undefined) {
        const openedStats = fs.fstatSync(identity.descriptor, { bigint: true });
        if (
          !openedStats.isDirectory()
          || openedStats.dev !== identity.dev
          || openedStats.ino !== identity.ino
        ) {
          throw unsafeRitualPathError();
        }
      }
      const currentStats = fs.lstatSync(identity.directoryPath, { bigint: true });
      if (
        !currentStats.isDirectory()
        || currentStats.isSymbolicLink()
        || currentStats.dev !== identity.dev
        || currentStats.ino !== identity.ino
      ) {
        throw unsafeRitualPathError();
      }
      const currentRealPath = fs.realpathSync.native(identity.directoryPath);
      if (
        !sameRitualPath(currentRealPath, identity.realPath)
        || !sameRitualPath(currentRealPath, identity.directoryPath)
      ) {
        throw unsafeRitualPathError();
      }
    } catch (error) {
      if (isPermissionError(error) || !isMissingError(error)) throw error;
      throw unsafeRitualPathError();
    }
  }
}

function assertOpenedRitualFileIdentity(filePath: string, openedStats: fs.BigIntStats): void {
  try {
    const currentStats = fs.lstatSync(filePath, { bigint: true });
    if (
      !currentStats.isFile()
      || currentStats.isSymbolicLink()
      || currentStats.dev !== openedStats.dev
      || currentStats.ino !== openedStats.ino
    ) {
      throw unsafeRitualPathError();
    }
  } catch (error) {
    if (isPermissionError(error) || !isMissingError(error)) throw error;
    throw unsafeRitualPathError();
  }
}

function closeRitualDirectoryChain(directoryChain: RitualDirectoryChain): unknown {
  let closeError: unknown;
  for (const identity of [...directoryChain.directories].reverse()) {
    if (identity.descriptor === undefined) continue;
    try {
      fs.closeSync(identity.descriptor);
    } catch (error) {
      closeError ??= error;
    }
  }
  return closeError;
}

function applyRitualDirectoryCloseFailure(
  listing: Pick<RitualStoreListing, 'denied' | 'failed' | 'rituals'>,
  error: unknown,
): void {
  if (!error) return;
  listing.denied ||= isPermissionError(error);
  listing.failed ||= !listing.denied;
  listing.rituals = [];
}

function sameRitualPath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function ritualDirectoryReadFlags(): number {
  let flags = fs.constants.O_RDONLY;
  if (process.platform !== 'win32') {
    if (typeof fs.constants.O_NOFOLLOW === 'number') {
      flags |= fs.constants.O_NOFOLLOW;
    }
    if (typeof fs.constants.O_DIRECTORY === 'number') {
      flags |= fs.constants.O_DIRECTORY;
    }
  }
  return flags;
}

function ritualFileReadFlags(): number {
  let flags = fs.constants.O_RDONLY;
  if (process.platform !== 'win32') {
    flags |= fs.constants.O_NONBLOCK;
    if (typeof fs.constants.O_NOFOLLOW === 'number') {
      flags |= fs.constants.O_NOFOLLOW;
    }
  }
  return flags;
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EACCES' || code === 'EPERM';
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function isUnsafeRitualPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ELOOP'
    || code === 'ENXIO'
    || code === 'ENODEV'
    || code === 'ENOTDIR'
    || code === 'RITUAL_PATH_UNSAFE';
}

function unsafeRitualPathError(): NodeJS.ErrnoException {
  return Object.assign(new Error('Ritual path contains an unsafe directory component'), {
    code: 'RITUAL_PATH_UNSAFE',
  });
}

export function listAvailableRituals(projectRoot: string): RitualDefinition[] {
  const ritualsById = new Map<string, RitualDefinition>();
  for (const ritual of getBuiltInRituals()) {
    ritualsById.set(ritual.id, ritual);
  }
  for (const ritual of listProjectRituals(projectRoot)) {
    ritualsById.set(ritual.id, ritual);
  }
  return [...ritualsById.values()];
}

export function loadRitual(projectRoot: string, ritualId: string): RitualDefinition | null {
  return listAvailableRituals(projectRoot)
    .find((ritual) => ritual.id === ritualId) || null;
}

export function readProjectRitualManifest(
  projectRoot: string,
  maxManifestBytes: number = MAX_PROJECT_RITUAL_MANIFEST_BYTES,
): RitualManifestListing {
  const directoryChainRead = openRitualDirectoryChain(projectRoot, ['.psyche']);
  if (
    directoryChainRead.missing
    || directoryChainRead.denied
    || directoryChainRead.failed
    || directoryChainRead.incompatible
    || !directoryChainRead.chain
  ) {
    return {
      denied: directoryChainRead.denied,
      failed: directoryChainRead.failed,
      incompatible: directoryChainRead.incompatible,
      limitExceeded: false,
      bytesRead: 0,
    };
  }

  const directoryChain = directoryChainRead.chain;
  const manifestPath = path.join(directoryChain.leafPath, 'rituals.json');
  const manifestLimit = Math.min(
    MAX_PROJECT_RITUAL_MANIFEST_BYTES,
    normalizeReadBudget(maxManifestBytes),
  );
  let fileRead: ReturnType<typeof readBoundedUtf8File> | undefined;
  let readError: unknown;
  try {
    fileRead = readBoundedUtf8File(
      manifestPath,
      manifestLimit,
      manifestLimit,
      directoryChain,
    );
  } catch (error) {
    readError = error;
  }
  const closeError = closeRitualDirectoryChain(directoryChain);
  if (readError) throw readError;
  if (!fileRead) throw new Error('Ritual manifest read did not produce a result');
  if (closeError) {
    fileRead = {
      bytes: fileRead.bytes,
      missing: false,
      denied: isPermissionError(closeError),
      failed: !isPermissionError(closeError),
      incompatible: false,
      limitExceeded: false,
      aggregateLimitExceeded: false,
    };
  }
  const result: RitualManifestListing = {
    denied: fileRead.denied,
    failed: fileRead.failed,
    incompatible: fileRead.incompatible,
    limitExceeded: fileRead.limitExceeded,
    bytesRead: fileRead.bytes,
  };
  if (fileRead.missing || fileRead.content === undefined) {
    return result;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fileRead.content);
  } catch {
    result.incompatible = true;
    return result;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    result.incompatible = true;
    return result;
  }

  const manifest = parsed as Record<string, unknown>;
  if (manifest.version !== RITUAL_VERSION) {
    result.incompatible = true;
    return result;
  }
  if (manifest.defaultRitualId === undefined) {
    return result;
  }
  if (typeof manifest.defaultRitualId !== 'string' || !manifest.defaultRitualId.trim()) {
    result.incompatible = true;
    return result;
  }

  const defaultRitualId = manifest.defaultRitualId.trim();
  if (Buffer.byteLength(defaultRitualId, 'utf8') > MAX_PUBLISHED_RITUAL_ID_BYTES) {
    result.limitExceeded = true;
    return result;
  }
  result.defaultRitualId = defaultRitualId;
  return result;
}

export function getProjectDefaultRitualId(projectRoot: string): string | undefined {
  return readProjectRitualManifest(projectRoot).defaultRitualId;
}

export function setProjectDefaultRitualId(projectRoot: string, ritualId?: string): ProjectRitualManifest {
  const manifest: ProjectRitualManifest = {
    version: RITUAL_VERSION,
    ...(ritualId ? { defaultRitualId: ritualId } : {}),
  };
  const manifestPath = getProjectRitualManifestPath(projectRoot);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  return manifest;
}

export function resolveRitualProjectRoot(
  ritualProject: RitualProjectDefinition,
  activeProjectRoot: string
): string {
  if (!ritualProject.projectRoot || ritualProject.projectRoot === '.') {
    return activeProjectRoot;
  }

  if (path.isAbsolute(ritualProject.projectRoot)) {
    return path.resolve(ritualProject.projectRoot);
  }

  return path.resolve(activeProjectRoot, ritualProject.projectRoot);
}

export function captureRitualFromSession(options: CaptureRitualOptions): RitualDefinition {
  const name = options.name.trim();
  if (!name) {
    throw new Error('Ritual name is required');
  }

  const projectRoots = new Map<string, string>();
  projectRoots.set(path.resolve(options.projectRoot), path.basename(options.projectRoot) || 'project');

  for (const project of options.sidebarProjects) {
    projectRoots.set(path.resolve(project.projectRoot), project.projectName);
  }

  for (const pane of options.panes) {
    const paneProjectRoot = getPaneProjectRoot(pane, options.projectRoot);
    projectRoots.set(path.resolve(paneProjectRoot), pane.projectName || path.basename(paneProjectRoot));
  }

  const projects: RitualProjectDefinition[] = [];
  for (const [projectRoot, projectName] of projectRoots) {
    const panes = options.panes
      .filter((pane) => sameSidebarProjectRoot(getPaneProjectRoot(pane, options.projectRoot), projectRoot))
      .map((pane): RitualPaneDefinition | null => {
        if (pane.browserPath) {
          return null;
        }

        if (pane.type === 'shell') {
          return {
            kind: 'terminal',
            name: pane.displayName || pane.slug || 'Terminal',
          };
        }

        return {
          kind: 'agent',
          name: getPaneDisplayName(pane),
          prompt: pane.prompt && pane.prompt !== 'No initial prompt' ? pane.prompt : undefined,
          agent: pane.agent,
        };
      })
      .filter((pane): pane is RitualPaneDefinition => !!pane);

    if (panes.length === 0) {
      continue;
    }

    projects.push({
      projectRoot: sameSidebarProjectRoot(projectRoot, options.projectRoot) ? '.' : projectRoot,
      projectName,
      panes,
    });
  }

  if (projects.length === 0) {
    throw new Error('No panes are available to save as a ritual');
  }

  return {
    version: RITUAL_VERSION,
    id: ritualIdFromName(name),
    name,
    scope: 'project',
    projects,
  };
}
