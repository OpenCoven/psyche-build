import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { canonicalizeProjectRoot } from './projectIdentity.js';

export interface RegisteredPane {
  paneId: string;
  cwd: string;
}

export interface ControlScopeInput {
  panes?: RegisteredPane[];
  worktrees?: string[];
  sessionIds?: string[];
}

function isContained(parent: string, candidate: string): boolean {
  if (candidate === parent) return true;
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export class ControlScope {
  private constructor(
    private readonly canonicalRoot: string,
    private readonly panes: Map<string, RegisteredPane>,
    private readonly sessionIds: Set<string>,
    private readonly worktrees: string[],
  ) {}

  static async create(projectRoot: string, input: ControlScopeInput = {}): Promise<ControlScope> {
    const canonicalRoot = await canonicalizeProjectRoot(projectRoot);
    const panes = new Map<string, RegisteredPane>();
    for (const pane of input.panes ?? []) panes.set(pane.paneId, pane);
    const worktrees: string[] = [];
    for (const worktree of input.worktrees ?? []) {
      const canonicalWorktree = await realpath(path.resolve(worktree));
      if (isContained(canonicalRoot, canonicalWorktree)) worktrees.push(canonicalWorktree);
    }
    return new ControlScope(
      canonicalRoot,
      panes,
      new Set(input.sessionIds ?? []),
      worktrees,
    );
  }

  private async resolveWithExistingAncestor(absolute: string): Promise<string> {
    const pending: string[] = [];
    let current = absolute;
    for (;;) {
      try {
        const real = await realpath(current);
        return pending.length > 0 ? path.join(real, ...pending.reverse()) : real;
      } catch {
        const parent = path.dirname(current);
        if (parent === current) return absolute;
        pending.push(path.basename(current));
        current = parent;
      }
    }
  }

  async requireContainedPath(candidate: string): Promise<string> {
    const resolved = await this.resolveWithExistingAncestor(path.resolve(candidate));
    if (isContained(this.canonicalRoot, resolved)) return resolved;
    for (const worktree of this.worktrees) {
      if (isContained(worktree, resolved)) return resolved;
    }
    throw new Error(`path is outside the canonical project: ${candidate}`);
  }

  requireOwnedPane(paneId: string): RegisteredPane {
    const pane = this.panes.get(paneId);
    if (!pane) throw new Error(`pane is not owned by this project: ${paneId}`);
    return pane;
  }

  requireRegisteredSession(sessionId: string): string {
    if (!this.sessionIds.has(sessionId)) {
      throw new Error(`session is not owned by this project: ${sessionId}`);
    }
    return sessionId;
  }
}
