import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PsychePane } from '../src/types.js';

const createPaneMock = vi.hoisted(() => vi.fn());

vi.mock('../src/utils/paneCreation.js', () => ({
  createPane: createPaneMock,
}));

import {
  attachAgentToWorktree,
  generateSiblingSlugForTargetPane,
} from '../src/utils/attachAgent.js';

const WORKTREE_PATH = '/repo/.psyche/worktrees/feature';

function createTargetPane(overrides: Partial<PsychePane> = {}): PsychePane {
  return {
    id: 'psyche-source',
    slug: 'feature',
    branchName: 'feature',
    prompt: '',
    paneId: '%source',
    projectRoot: '/repo',
    projectName: 'Repo',
    worktreePath: WORKTREE_PATH,
    ...overrides,
  };
}

function createdPane(slug: string): PsychePane {
  return {
    id: `psyche-${slug}`,
    slug,
    branchName: 'feature',
    prompt: 'Review the changes',
    paneId: `%${slug}`,
    projectRoot: '/repo',
    projectName: 'Repo',
    worktreePath: WORKTREE_PATH,
  };
}

describe('generateSiblingSlugForTargetPane', () => {
  it('increments from existing attached-agent siblings', () => {
    const slug = generateSiblingSlugForTargetPane(
      { slug: 'cli-login', worktreePath: '/repo/.psyche/worktrees/cli-login' },
      [
        { slug: 'cli-login' },
        { slug: 'cli-login-a2' },
      ],
    );

    expect(slug).toBe('cli-login-a3');
  });

  it('uses worktree directory as base when attaching from a suffixed sibling', () => {
    const slug = generateSiblingSlugForTargetPane(
      { slug: 'cli-login-a2', worktreePath: '/repo/.psyche/worktrees/cli-login' },
      [
        { slug: 'cli-login' },
        { slug: 'cli-login-a2' },
      ],
    );

    expect(slug).toBe('cli-login-a3');
  });

  it('always uses highest sibling suffix + 1', () => {
    const slug = generateSiblingSlugForTargetPane(
      { slug: 'cli-login-a4', worktreePath: '/repo/.psyche/worktrees/cli-login' },
      [
        { slug: 'cli-login' },
        { slug: 'cli-login-a2' },
        { slug: 'cli-login-a4' },
      ],
    );

    expect(slug).toBe('cli-login-a5');
  });

  it('preserves legitimate branch/worktree names that end in -aN', () => {
    const slug = generateSiblingSlugForTargetPane(
      { slug: 'feature-a2', worktreePath: '/repo/.psyche/worktrees/feature-a2' },
      [{ slug: 'feature-a2' }],
    );

    expect(slug).toBe('feature-a2-a2');
  });
});

describe('attachAgentToWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createPaneMock.mockReset();
  });

  it('rejects when the target pane has no worktree', async () => {
    await expect(attachAgentToWorktree({
      targetPane: createTargetPane({ worktreePath: undefined }),
      prompt: 'Review the changes',
      agent: 'claude',
      existingPanes: [],
      sessionProjectRoot: '/session',
    })).rejects.toThrow(/no worktree/);

    expect(createPaneMock).not.toHaveBeenCalled();
  });

  it('passes the target worktree and a reserved sibling slug allocator to createPane', async () => {
    const targetPane = createTargetPane();
    const result = createdPane('feature-a2');
    createPaneMock.mockResolvedValueOnce({
      pane: result,
      needsAgentChoice: false,
      persistedDuringLifecycle: true,
    });

    await attachAgentToWorktree({
      targetPane,
      prompt: 'Review the changes',
      agent: 'claude',
      existingPanes: [targetPane],
      sessionProjectRoot: '/session',
    });

    expect(createPaneMock).toHaveBeenCalledOnce();
    const options = createPaneMock.mock.calls[0][0];
    expect(options.existingWorktree).toEqual({
      slug: 'feature',
      worktreePath: WORKTREE_PATH,
      branchName: 'feature',
    });
    expect(options.resolveExistingWorktreeSlug([targetPane])).toBe('feature-a2');
    expect(options.agent).toBe('claude');
    expect(options.prompt).toBe('Review the changes');
    expect(options.sessionProjectRoot).toBe('/session');
    expect(options.projectRoot).toBe('/repo');
  });

  it('passes the available agents list with the selected agent', async () => {
    const result = createdPane('feature-a2');
    createPaneMock.mockResolvedValueOnce({
      pane: result,
      needsAgentChoice: false,
    });

    await attachAgentToWorktree({
      targetPane: createTargetPane(),
      prompt: 'p',
      agent: 'codex',
      existingPanes: [createTargetPane()],
      sessionProjectRoot: '/session',
    });

    const agents = createPaneMock.mock.calls[0][1];
    expect(agents).toEqual(['codex']);
  });

  it('does not treat the caller pane snapshot as sibling slug authority', async () => {
    const targetPane = createTargetPane();
    createPaneMock.mockResolvedValueOnce({
      pane: createdPane('feature-a3'),
      needsAgentChoice: false,
    });

    await attachAgentToWorktree({
      targetPane,
      prompt: 'p',
      agent: 'claude',
      existingPanes: [targetPane, { slug: 'feature-a2' } as PsychePane],
      sessionProjectRoot: '/session',
    });

    const options = createPaneMock.mock.calls[0][0];
    expect(options.resolveExistingWorktreeSlug([targetPane])).toBe('feature-a2');
  });

  it('allocates the sibling slug from fresh persisted panes instead of the caller snapshot', async () => {
    const targetPane = createTargetPane();
    const persistedSibling = createdPane('feature-a2');
    createPaneMock.mockImplementationOnce(async (options) => {
      const slug = options.resolveExistingWorktreeSlug([
        targetPane,
        persistedSibling,
      ]);
      return {
        pane: createdPane(slug),
        needsAgentChoice: false,
      };
    });

    const { pane } = await attachAgentToWorktree({
      targetPane,
      prompt: 'p',
      agent: 'claude',
      existingPanes: [targetPane],
      sessionProjectRoot: '/session',
    });

    expect(pane.slug).toBe('feature-a3');
  });

  it('allocates distinct sibling slugs for parallel attaches', async () => {
    const targetPane = createTargetPane();
    let persistedPanes = [targetPane];
    let reservationTail = Promise.resolve();

    createPaneMock.mockImplementation(async (options) => {
      const previousReservation = reservationTail;
      let releaseReservation!: () => void;
      reservationTail = new Promise<void>((resolve) => {
        releaseReservation = resolve;
      });
      await previousReservation;

      try {
        const slug = options.resolveExistingWorktreeSlug(persistedPanes);
        const pane = createdPane(slug);
        persistedPanes = [...persistedPanes, pane];
        return {
          pane,
          needsAgentChoice: false,
        };
      } finally {
        releaseReservation();
      }
    });

    const [first, second] = await Promise.all([
      attachAgentToWorktree({
        targetPane,
        prompt: 'first',
        agent: 'claude',
        existingPanes: [targetPane],
        sessionProjectRoot: '/session',
      }),
      attachAgentToWorktree({
        targetPane,
        prompt: 'second',
        agent: 'codex',
        existingPanes: [targetPane],
        sessionProjectRoot: '/session',
      }),
    ]);

    expect([first.pane.slug, second.pane.slug].sort()).toEqual([
      'feature-a2',
      'feature-a3',
    ]);
  });

  it('returns the pane created by createPane', async () => {
    const expected = createdPane('feature-a2');
    createPaneMock.mockResolvedValueOnce({
      pane: expected,
      needsAgentChoice: false,
    });

    const { pane } = await attachAgentToWorktree({
      targetPane: createTargetPane(),
      prompt: 'p',
      agent: 'claude',
      existingPanes: [createTargetPane()],
      sessionProjectRoot: '/session',
    });

    expect(pane).toBe(expected);
  });

  it('throws when createPane cannot resolve an agent', async () => {
    createPaneMock.mockResolvedValueOnce({
      pane: null,
      needsAgentChoice: true,
    });

    await expect(attachAgentToWorktree({
      targetPane: createTargetPane(),
      prompt: 'p',
      agent: 'claude',
      existingPanes: [createTargetPane()],
      sessionProjectRoot: '/session',
    })).rejects.toThrow(/Could not resolve agent/);
  });

  it('forwards persistReusedPane to createPane', async () => {
    const persistFn = vi.fn();
    createPaneMock.mockResolvedValueOnce({
      pane: createdPane('feature-a2'),
      needsAgentChoice: false,
    });

    await attachAgentToWorktree({
      targetPane: createTargetPane(),
      prompt: 'p',
      agent: 'claude',
      existingPanes: [createTargetPane()],
      sessionProjectRoot: '/session',
      persistReusedPane: persistFn,
    });

    expect(createPaneMock.mock.calls[0][0].persistReusedPane).toBe(persistFn);
  });

  it('uses projectRoot from targetPane, falling back to sessionProjectRoot', async () => {
    createPaneMock.mockResolvedValueOnce({
      pane: createdPane('feature-a2'),
      needsAgentChoice: false,
    });

    await attachAgentToWorktree({
      targetPane: createTargetPane({ projectRoot: undefined }),
      prompt: 'p',
      agent: 'claude',
      existingPanes: [createTargetPane()],
      sessionProjectRoot: '/session',
    });

    expect(createPaneMock.mock.calls[0][0].projectRoot).toBe('/session');
  });
});
