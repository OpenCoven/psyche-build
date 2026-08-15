import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PsychePane } from '../src/types.js';
import {
  captureRitualFromSession,
  getBuiltInRituals,
  getProjectDefaultRitualId,
  listAvailableRituals,
  listProjectRituals,
  resolveRitualProjectRoot,
  ritualIdFromName,
  saveProjectRitual,
  setProjectDefaultRitualId,
} from '../src/utils/rituals.js';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'psyche-rituals-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('rituals', () => {
  it('ships curated built-in rituals', () => {
    const rituals = getBuiltInRituals();

    expect(rituals.map((ritual) => ritual.id)).toEqual([
      'start-coding',
      'terminal-first',
      'review-stack',
      'release-check',
      'fix-openclaw',
    ]);
    expect(rituals.find((ritual) => ritual.id === 'review-stack')?.projects[0].panes).toHaveLength(3);

    const fixOpenClaw = rituals.find((ritual) => ritual.id === 'fix-openclaw');
    expect(fixOpenClaw?.projects[0].panes).toEqual([
      expect.objectContaining({
        kind: 'terminal',
        name: 'Fix OpenClaw',
        command: expect.stringContaining('coven fix openclaw'),
      }),
      expect.objectContaining({
        kind: 'terminal',
        name: 'Verification',
        command: expect.stringContaining('git diff --check'),
      }),
      expect.objectContaining({
        kind: 'terminal',
        name: 'Diff Watch',
        command: expect.stringContaining('git diff --stat'),
      }),
      expect.objectContaining({
        kind: 'terminal',
        name: 'Coven Sessions',
        command: expect.stringContaining('coven sessions'),
      }),
    ]);
  });

  it('creates stable ritual IDs from names', () => {
    expect(ritualIdFromName(' Review Stack! ')).toBe('review-stack');
    expect(ritualIdFromName('')).toBe('ritual');
  });

  it('saves and lists project rituals', () => {
    saveProjectRitual(tempDir, {
      version: 1,
      id: 'my-flow',
      name: 'My Flow',
      scope: 'project',
      projects: [
        {
          projectRoot: '.',
          panes: [{ kind: 'terminal', name: 'Shell', command: 'git status' }],
        },
      ],
    });

    const saved = listProjectRituals(tempDir);
    expect(saved.map((ritual) => ritual.id)).toEqual(['my-flow']);
    expect(saved[0].projects[0].panes[0]).toEqual({
      kind: 'terminal',
      name: 'Shell',
      command: 'git status',
    });
    expect(listAvailableRituals(tempDir).some((ritual) => ritual.id === 'my-flow')).toBe(true);
  });

  it('does not let project JSON claim built-in trust', () => {
    const ritualsDir = path.join(tempDir, '.psyche', 'rituals');
    fs.mkdirSync(ritualsDir, { recursive: true });
    fs.writeFileSync(path.join(ritualsDir, 'untrusted.json'), JSON.stringify({
      version: 1,
      id: 'untrusted',
      name: 'Untrusted',
      scope: 'builtin',
      projects: [{
        projectRoot: '.',
        panes: [{ kind: 'terminal', command: 'touch /tmp/should-not-run' }],
      }],
    }));

    const [ritual] = listProjectRituals(tempDir);
    expect(ritual.scope).toBe('project');
    expect(ritual.projects[0].panes[0].command).toBe('touch /tmp/should-not-run');
  });

  it('persists project default ritual attachments', () => {
    expect(getProjectDefaultRitualId(tempDir)).toBeUndefined();

    setProjectDefaultRitualId(tempDir, 'review-stack');
    expect(getProjectDefaultRitualId(tempDir)).toBe('review-stack');

    setProjectDefaultRitualId(tempDir);
    expect(getProjectDefaultRitualId(tempDir)).toBeUndefined();
  });

  it('resolves dot project roots against the active project', () => {
    expect(resolveRitualProjectRoot({ projectRoot: '.', panes: [{ kind: 'terminal' }] }, tempDir)).toBe(tempDir);
    expect(resolveRitualProjectRoot({ projectRoot: 'packages/app', panes: [{ kind: 'terminal' }] }, tempDir)).toBe(
      path.join(tempDir, 'packages/app')
    );
  });

  it('captures current session intent without tmux pane IDs', () => {
    const panes: PsychePane[] = [
      {
        id: 'psyche-1',
        paneId: '%1',
        slug: 'feature-a',
        prompt: 'Implement feature A',
        agent: 'codex',
        projectRoot: tempDir,
        projectName: 'project',
        worktreePath: path.join(tempDir, '.psyche/worktrees/feature-a'),
      },
      {
        id: 'psyche-2',
        paneId: '%2',
        slug: 'shell-2',
        prompt: '',
        type: 'shell',
        projectRoot: tempDir,
        projectName: 'project',
      },
    ];

    const ritual = captureRitualFromSession({
      name: 'Daily Flow',
      projectRoot: tempDir,
      panes,
      sidebarProjects: [],
    });

    expect(ritual.id).toBe('daily-flow');
    expect(ritual.projects[0].projectRoot).toBe('.');
    expect(ritual.projects[0].panes).toEqual([
      {
        kind: 'agent',
        name: 'feature-a',
        prompt: 'Implement feature A',
        agent: 'codex',
      },
      {
        kind: 'terminal',
        name: 'shell-2',
      },
    ]);
    expect(JSON.stringify(ritual)).not.toContain('%1');
    expect(JSON.stringify(ritual)).not.toContain('.psyche/worktrees');
  });
});
