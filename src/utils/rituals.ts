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
  const scope = parsed.scope === 'builtin' || parsed.scope === 'project'
    ? parsed.scope
    : fallbackScope;
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

function readProjectRitualManifest(projectRoot: string): ProjectRitualManifest {
  const manifestPath = getProjectRitualManifestPath(projectRoot);
  if (!fs.existsSync(manifestPath)) {
    return { version: RITUAL_VERSION };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
    return {
      version: RITUAL_VERSION,
      ...(typeof parsed.defaultRitualId === 'string' && parsed.defaultRitualId.trim()
        ? { defaultRitualId: parsed.defaultRitualId.trim() }
        : {}),
    };
  } catch {
    return { version: RITUAL_VERSION };
  }
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
