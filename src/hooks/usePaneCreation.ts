import path from 'path';
import * as os from 'os';
import type { PsychePane, MergeTargetReference } from '../types.js';
import { createPane } from '../utils/paneCreation.js';
import { LogService } from '../services/LogService.js';
import { WorktreeCleanupService } from '../services/WorktreeCleanupService.js';
import { type AgentName } from '../utils/agentLaunch.js';
import { Orchestrator } from '../orchestration/orchestrator.js';
import { createLocalPaneBackend } from '../orchestration/localPaneBackend.js';
import { buildMultiAgentTaskRequest } from '../orchestration/adapters.js';
import { generateSlug } from '../utils/slug.js';
import { SettingsManager } from '../utils/settingsManager.js';

interface Params {
  panes: PsychePane[];
  savePanes: (p: PsychePane[]) => Promise<void>;
  appendPanes?: (panes: PsychePane[]) => Promise<PsychePane[]>;
  projectName: string;
  sessionProjectRoot: string;
  panesFile: string;
  setIsCreatingPane: (v: boolean) => void;
  setStatusMessage: (msg: string) => void;
  loadPanes: () => Promise<void>;
  availableAgents: AgentName[];
  sidebarWidth?: number;
}

interface CreateNewPaneOptions {
  existingPanes?: PsychePane[];
  slugSuffix?: string;
  slugBase?: string;
  targetProjectRoot?: string;
  skipAgentSelection?: boolean;
  startPointBranch?: string;
  mergeTargetChain?: MergeTargetReference[];
  focusedTmuxPaneId?: string | null;
  selectedPaneId?: string;
}

const MAX_PARALLEL_PANE_CREATIONS = 4;

function getParallelPaneCreationLimit(totalAgents: number): number {
  if (totalAgents <= 1) {
    return 1;
  }

  const overrideRaw = process.env.PSYCHE_PANE_CREATE_CONCURRENCY;
  if (overrideRaw) {
    const override = Number.parseInt(overrideRaw, 10);
    if (Number.isFinite(override) && override > 0) {
      return Math.min(totalAgents, override);
    }
  }

  const maybeAvailableParallelism = (os as any).availableParallelism;
  const cpuCount = typeof maybeAvailableParallelism === 'function'
    ? maybeAvailableParallelism.call(os)
    : os.cpus().length;
  const conservativeLimit = Math.max(1, Math.floor(cpuCount / 2));

  return Math.max(
    1,
    Math.min(totalAgents, MAX_PARALLEL_PANE_CREATIONS, conservativeLimit)
  );
}

function enqueueManagedWorktreePruning(
  projectRoots: string[],
  activePanes: PsychePane[]
): void {
  const uniqueProjectRoots = Array.from(new Set(projectRoots));

  for (const projectRoot of uniqueProjectRoots) {
    const maxManagedWorktrees = new SettingsManager(projectRoot).getSettings().maxManagedWorktrees;
    if (typeof maxManagedWorktrees !== 'number') {
      continue;
    }

    WorktreeCleanupService.getInstance().enqueuePruneManagedWorktrees({
      projectRoot,
      activePanes,
      maxManagedWorktrees,
    });
  }
}

export default function usePaneCreation({
  panes,
  savePanes,
  appendPanes,
  projectName,
  sessionProjectRoot,
  panesFile,
  setIsCreatingPane,
  setStatusMessage,
  loadPanes,
  availableAgents,
  sidebarWidth,
}: Params) {
  const openInEditor = async (currentPrompt: string, setPrompt: (v: string) => void) => {
    try {
      const fs = await import('fs');
      const tmpFile = path.join(os.tmpdir(), `psyche-prompt-${Date.now()}.md`);
      fs.writeFileSync(tmpFile, currentPrompt || '# Enter your Claude prompt here\n\n');
      const editor = process.env.EDITOR || process.env.VISUAL || 'nano';
      process.stdout.write('\x1b[2J\x1b[H');
      const { spawn } = await import('child_process');
      const editorProcess = spawn(editor, [tmpFile], { stdio: 'inherit', shell: true });
      editorProcess.on('close', () => {
        try {
          const content = fs.readFileSync(tmpFile, 'utf8').replace(/^# Enter your Claude prompt here\s*\n*/m, '').trim();
          setPrompt(content);
          fs.unlinkSync(tmpFile);
          process.stdout.write('\x1b[2J\x1b[H');
        } catch {}
      });
    } catch {}
  };

  const createPaneInternal = async (
    prompt: string,
    agent?: AgentName,
    options: CreateNewPaneOptions = {}
  ): Promise<PsychePane> => {
    const panesForCreation = options.existingPanes ?? panes;
    const result = await createPane(
      {
        prompt,
        agent,
        projectName,
        existingPanes: panesForCreation,
        slugSuffix: options.slugSuffix,
        slugBase: options.slugBase,
        projectRoot: options.targetProjectRoot,
        skipAgentSelection: options.skipAgentSelection,
        startPointBranch: options.startPointBranch,
        mergeTargetChain: options.mergeTargetChain,
        focusedTmuxPaneId: options.focusedTmuxPaneId,
        selectedPaneId: options.selectedPaneId,
        sessionProjectRoot,
        sessionConfigPath: panesFile,
        sidebarWidth,
      },
      availableAgents
    );

    if (result.needsAgentChoice) {
      throw new Error('Agent choice is required');
    }

    return result.pane;
  };

  const createNewPane = async (
    prompt: string,
    agent?: AgentName,
    options: CreateNewPaneOptions = {}
  ): Promise<PsychePane | null> => {
    const panesForCreation = options.existingPanes ?? panes;

    try {
      setIsCreatingPane(true)
      setStatusMessage("Creating pane...")

      const pane = await createPaneInternal(prompt, agent, options);

      // Save the pane
      const updatedPanes = appendPanes
        ? await appendPanes([pane])
        : [...panesForCreation, pane];
      if (!appendPanes) {
        await savePanes(updatedPanes);
      }
      enqueueManagedWorktreePruning([pane.projectRoot || sessionProjectRoot], updatedPanes);

      await loadPanes();
      setStatusMessage("Pane created")
      setTimeout(() => setStatusMessage(""), 2000)
      return pane;
    } catch (error) {
      const msg = 'Failed to create pane';
      LogService.getInstance().error(msg, 'usePaneCreation', undefined, error instanceof Error ? error : undefined);
      setStatusMessage(`Failed to create pane: ${error}`);
      setTimeout(() => setStatusMessage(''), 3000);
      return null;
    } finally {
      setIsCreatingPane(false)
    }
  };

  const createPanesForAgents = async (
    prompt: string,
    selectedAgents: AgentName[],
    options: Pick<
      CreateNewPaneOptions,
      'existingPanes' | 'targetProjectRoot' | 'startPointBranch' | 'mergeTargetChain'
      | 'focusedTmuxPaneId' | 'selectedPaneId'
    > = {}
  ): Promise<PsychePane[]> => {
    const panesForCreation = options.existingPanes ?? panes;
    const dedupedAgents = selectedAgents.filter(
      (agent, index) => selectedAgents.indexOf(agent) === index
    );

    if (dedupedAgents.length === 0) {
      return [];
    }

    const isMultiLaunch = dedupedAgents.length > 1;
    // Sibling lanes share a slug stem so they read as variants of one task
    // (fix-auth-codex, fix-auth-claude) rather than unrelated names.
    const slugBase = isMultiLaunch ? await generateSlug(prompt) : undefined;
    const parallelLimit = getParallelPaneCreationLimit(dedupedAgents.length);
    const targetProjectRoot = options.targetProjectRoot || sessionProjectRoot;

    try {
      setIsCreatingPane(true);
      if (parallelLimit > 1) {
        setStatusMessage(
          `Creating ${dedupedAgents.length} panes (${parallelLimit} parallel)...`
        );
      } else {
        setStatusMessage(`Creating ${dedupedAgents.length} pane${dedupedAgents.length === 1 ? '' : 's'}...`);
      }

      const backend = createLocalPaneBackend({
        projectName,
        sessionProjectRoot,
        sessionConfigPath: panesFile,
        basePanes: panesForCreation,
        availableAgents,
        slugBase,
        sidebarWidth,
        focusedTmuxPaneId: options.focusedTmuxPaneId,
        selectedPaneId: options.selectedPaneId,
      });
      const orchestrator = new Orchestrator({ executeLane: backend.execute });

      const result = await orchestrator.execute(buildMultiAgentTaskRequest({
        taskId: `task-${Date.now()}`,
        projectRoot: targetProjectRoot,
        prompt,
        agents: dedupedAgents,
        startPointBranch: options.startPointBranch,
        mergeTargetChain: options.mergeTargetChain,
        concurrency: parallelLimit,
      }));

      const createdPanes = result.lanes.flatMap((lane) =>
        lane.status === 'completed' && lane.pane ? [lane.pane] : []
      );
      const failures = result.lanes.filter((lane) => lane.status === 'failed');

      for (const failure of failures) {
        if (failure.status !== 'failed') continue;
        LogService.getInstance().error(
          `Lane "${failure.id}" failed: ${failure.error.message}`,
          'usePaneCreation'
        );
      }

      // Successful lanes are persisted even when siblings failed — a partial
      // result still leaves usable work behind.
      if (createdPanes.length > 0) {
        const updatedPanes = appendPanes
          ? await appendPanes(createdPanes)
          : [...panesForCreation, ...createdPanes];
        if (!appendPanes) {
          await savePanes(updatedPanes);
        }
        enqueueManagedWorktreePruning(
          createdPanes.map((pane) => pane.projectRoot || sessionProjectRoot),
          updatedPanes
        );
        await loadPanes();
      }

      if (failures.length > 0) {
        setStatusMessage(
          `Created ${createdPanes.length}/${dedupedAgents.length} panes (${failures.length} failed)`
        );
      } else {
        setStatusMessage(
          `Created ${createdPanes.length} pane${createdPanes.length === 1 ? '' : 's'}`
        );
      }
      setTimeout(() => setStatusMessage(""), 3000);

      return createdPanes;
    } catch (error) {
      LogService.getInstance().error(
        'Failed to create panes',
        'usePaneCreation',
        undefined,
        error instanceof Error ? error : undefined
      );
      setStatusMessage(`Failed to create panes: ${error}`);
      setTimeout(() => setStatusMessage(''), 3000);
      return [];
    } finally {
      setIsCreatingPane(false);
    }
  };

  return { openInEditor, createNewPane, createPanesForAgents } as const;
}
