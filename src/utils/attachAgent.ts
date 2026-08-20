/**
 * Attach a second (or Nth) agent to an existing worktree pane.
 *
 * Sibling-slug generation lives here so that callers and the local backend
 * share one naming convention.  The heavy lifting — tmux split, layout,
 * title, hook, launch, persistence, focus — is delegated entirely to
 * `createPane`, which already handles shared-worktree lanes.
 */

import path from 'path';
import type { PsychePane } from '../types.js';
import type { AgentName } from './agentLaunch.js';
import { createPane, type CreatePaneOptions } from './paneCreation.js';

export interface AttachAgentOptions {
  targetPane: PsychePane;
  prompt: string;
  agent: AgentName;
  existingPanes: PsychePane[];
  sessionProjectRoot: string;
  /**
   * Retained for callers using the older API. Config access is now derived
   * from sessionProjectRoot and performed through the shared mutation APIs.
   */
  sessionConfigPath?: string;
  /**
   * Durable persistence callback invoked while the worktree-reuse
   * reservation is still held.
   */
  persistReusedPane?: (pane: PsychePane) => Promise<void>;
}

/**
 * Generate a unique sibling slug like `fix-auth-a2`, `fix-auth-a3`, etc.
 */
export function generateSiblingSlugForTargetPane(
  targetPane: Pick<PsychePane, 'slug' | 'worktreePath'>,
  existingPanes: ReadonlyArray<Pick<PsychePane, 'slug'>>,
): string {
  // Always anchor attached-agent slugs to the real worktree directory name.
  // This avoids repeated suffixes when attaching from an already attached pane.
  const worktreeSlug = targetPane.worktreePath
    ? path.basename(targetPane.worktreePath)
    : '';
  const baseSlug = worktreeSlug || targetPane.slug;

  const siblingPrefix = `${baseSlug}-a`;
  let maxSibling = 1;

  for (const pane of existingPanes) {
    if (!pane.slug.startsWith(siblingPrefix)) continue;
    const suffix = pane.slug.slice(siblingPrefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    maxSibling = Math.max(maxSibling, Number.parseInt(suffix, 10));
  }

  return `${baseSlug}-a${maxSibling + 1}`;
}

/**
 * Compatibility wrapper: submits one shared-worktree lane by delegating
 * to `createPane` with an allocator that computes the sibling slug from the
 * persisted pane registry while reuse is reserved.
 *
 * All tmux split, layout, title, hook, launch, and focus logic is handled
 * by `createPane` — this function owns only the sibling-slug allocator.
 */
export async function attachAgentToWorktree(
  options: AttachAgentOptions,
): Promise<{ pane: PsychePane }> {
  if (!options.targetPane.worktreePath) {
    throw new Error('Target pane has no worktree to attach to');
  }

  const projectRoot = options.targetPane.projectRoot || options.sessionProjectRoot;
  const createPaneOptions: CreatePaneOptions = {
    prompt: options.prompt,
    agent: options.agent,
    projectName: options.targetPane.projectName || path.basename(projectRoot),
    projectRoot,
    existingPanes: options.existingPanes,
    existingWorktree: {
      slug: options.targetPane.slug,
      worktreePath: options.targetPane.worktreePath,
      branchName: options.targetPane.branchName || options.targetPane.slug,
    },
    resolveExistingWorktreeSlug: (freshPanes) => (
      generateSiblingSlugForTargetPane(options.targetPane, freshPanes)
    ),
    sessionProjectRoot: options.sessionProjectRoot,
    ...(options.sessionConfigPath ? { sessionConfigPath: options.sessionConfigPath } : {}),
    ...(options.persistReusedPane ? { persistReusedPane: options.persistReusedPane } : {}),
  };

  // The agent is already selected by the caller, so createPane's internal
  // auto-selection fallback won't trigger. Passing a single-element list
  // satisfies the type without importing the full registry.
  const result = await createPane(createPaneOptions, [options.agent]);

  if (result.needsAgentChoice || !result.pane) {
    throw new Error(`Could not resolve agent "${options.agent}" for attached pane`);
  }

  return { pane: result.pane };
}
