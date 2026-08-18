import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import type { PsychePane, ProjectSettings, SavePanes } from '../types.js';
import { TmuxService } from '../services/TmuxService.js';
import {
  sameTmuxServerIdentity,
  type TmuxServerIdentity,
} from '../services/TmuxServerIdentity.js';
import { enforceControlPaneSize } from '../utils/tmux.js';
import { SIDEBAR_WIDTH } from '../utils/layoutManager.js';
import {
  tearDownPaneWithVerification,
  type VerifiedPaneTeardownResult,
} from '../utils/paneTeardown.js';
import {
  joinBackgroundWindowTransaction,
  startBackgroundWindowTransaction,
} from '../utils/backgroundWindowTransaction.js';
import { writeWorktreeRecoveryMarker } from '../services/WorktreeRecoveryMarker.js';
import { deriveProjectRootFromWorktreePath } from '../utils/paneProject.js';

interface Params {
  panes: PsychePane[];
  savePanes: SavePanes;
  projectSettings: ProjectSettings;
  setStatusMessage: (msg: string) => void;
  setRunningCommand: (v: boolean) => void;
  refreshPanes?: () => Promise<void>;
}

export default function usePaneRunner({
  panes,
  savePanes,
  projectSettings,
  setStatusMessage,
  setRunningCommand,
  refreshPanes,
}: Params) {
  const copyNonGitFiles = async (worktreePath: string, sourceProjectRoot?: string) => {
    try {
      setStatusMessage('Copying non-git files from main...');
      const derivedRoot = worktreePath.replace(/[\\\/]\.psyche[\\\/]worktrees[\\\/][^\\\/]+$/, '');
      const projectRoot = sourceProjectRoot
        || (derivedRoot !== worktreePath ? derivedRoot : undefined)
        || execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', stdio: 'pipe' }).trim();
      const rsyncCmd = `rsync -avz --exclude='.git' --exclude='.psyche' --exclude='node_modules' --exclude='dist' --exclude='build' --exclude='.next' --exclude='.turbo' "${projectRoot}/" "${worktreePath}/"`;
      execSync(rsyncCmd, { stdio: 'pipe' });
      setStatusMessage('Non-git files copied successfully');
      setTimeout(() => setStatusMessage(''), 2000);
    } catch {
      setStatusMessage('Failed to copy non-git files');
      setTimeout(() => setStatusMessage(''), 2000);
    }
  };

  const runCommandInternal = async (type: 'test' | 'dev', pane: PsychePane) => {
    if (!pane.worktreePath) {
      setStatusMessage('No worktree path for this pane');
      setTimeout(() => setStatusMessage(''), 2000);
      return;
    }

    const command = type === 'test' ? projectSettings.testCommand : projectSettings.devCommand;
    if (!command) {
      setStatusMessage('No command configured');
      setTimeout(() => setStatusMessage(''), 2000);
      return;
    }

    try {
      setRunningCommand(true);
      setStatusMessage(`Starting ${type} in background window...`);

      const tmuxService = TmuxService.getInstance();
      const projectRoot = pane.projectRoot
        || deriveProjectRootFromWorktreePath(pane.worktreePath)
        || process.cwd();
      const tearDownPaneForGeneration = async (
        paneId: string,
        allocationIdentity: TmuxServerIdentity,
      ): Promise<VerifiedPaneTeardownResult> => {
        const current = tmuxService.getServerIdentity?.();
        if (!current) {
          return {
            presence: 'unknown',
            error: 'current tmux server generation could not be verified',
          };
        }
        if (!sameTmuxServerIdentity(allocationIdentity, current)) {
          return { presence: 'absent' };
        }
        return tearDownPaneWithVerification({
          probe: async () => {
            const identity = tmuxService.getServerIdentity?.();
            if (!identity) return 'unknown';
            if (!sameTmuxServerIdentity(allocationIdentity, identity)) return 'absent';
            return tmuxService.probePanePresence(paneId);
          },
          kill: async () => {
            const identity = tmuxService.getServerIdentity?.();
            if (!identity) {
              throw new Error('current tmux server generation could not be verified');
            }
            if (!sameTmuxServerIdentity(allocationIdentity, identity)) {
              return;
            }
            await tmuxService.killPane(paneId);
          },
        });
      };
      const tearDownWindowForGeneration = async (
        windowId: string,
        allocationIdentity: TmuxServerIdentity,
      ): Promise<VerifiedPaneTeardownResult> => {
        const current = tmuxService.getServerIdentity?.();
        if (!current) {
          return {
            presence: 'unknown',
            error: 'current tmux server generation could not be verified',
          };
        }
        if (!sameTmuxServerIdentity(allocationIdentity, current)) {
          return { presence: 'absent' };
        }
        return tearDownPaneWithVerification({
          probe: async () => {
            const identity = tmuxService.getServerIdentity?.();
            if (!identity) return 'unknown';
            if (!sameTmuxServerIdentity(allocationIdentity, identity)) return 'absent';
            return tmuxService.probeWindowPresence(windowId);
          },
          kill: async () => {
            const identity = tmuxService.getServerIdentity?.();
            if (!identity) {
              throw new Error('current tmux server generation could not be verified');
            }
            if (!sameTmuxServerIdentity(allocationIdentity, identity)) {
              return;
            }
            await tmuxService.killWindow(windowId);
          },
        });
      };
      const tearDownResource = async (
        resource: { windowId: string; paneId: string },
        allocationIdentity: TmuxServerIdentity,
      ): Promise<VerifiedPaneTeardownResult> => {
        const backgroundPane = await tearDownPaneForGeneration(
          resource.paneId,
          allocationIdentity,
        );
        const window = await tearDownWindowForGeneration(
          resource.windowId,
          allocationIdentity,
        );
        const presence = [backgroundPane, window].some(
          (result) => result.presence === 'unknown',
        )
          ? 'unknown'
          : [backgroundPane, window].some((result) => result.presence === 'present')
            ? 'present'
            : 'absent';
        return {
          presence,
          ...(backgroundPane.error || window.error
            ? { error: backgroundPane.error || window.error }
            : {}),
        };
      };
      const retainUncertainRecovery = async (
        recoveryPane: PsychePane,
        reason: string,
      ): Promise<string | undefined> => {
        try {
          const marker = await writeWorktreeRecoveryMarker({
            projectRoot,
            worktreePath: recoveryPane.worktreePath || projectRoot,
            pane: {
              id: recoveryPane.id,
              paneId: recoveryPane.paneId,
            },
            operation: 'background-window-launch',
            reason,
          });
          return `wrote recovery marker ${marker.path}. ${
            marker.warning ? `${marker.warning}. ` : ''
          }${marker.marker.operatorInstructions}`;
        } catch {
          return undefined;
        }
      };

      const windowName = `${pane.slug}-${type}`;
      const runtimeDir = path.join(pane.worktreePath, '.psyche');
      await fs.mkdir(runtimeDir, { recursive: true });
      const logFile = path.join(runtimeDir, `${pane.id}-${type}.log`);
      const fullCommand = `cd "${pane.worktreePath}" && ${command} 2>&1 | tee ${logFile}`;
      const transaction = await startBackgroundWindowTransaction({
        type,
        projectRoot,
        pane,
        allocateWindow: () => tmuxService.newWindow({ name: windowName, detached: true }),
        getWindowPaneId: (windowId) => tmuxService.getWindowPaneId(windowId),
        sendCommand: (resource) => tmuxService.sendKeys(
          resource.paneId,
          `'${fullCommand.replace(/'/g, "'\\''")}' Enter`,
        ),
        tearDownResource,
        tearDownAllocatedWindow: tearDownWindowForGeneration,
        getTmuxServerIdentity: () => tmuxService.getServerIdentity?.(),
        retainUncertainRecovery,
      });
      await refreshPanes?.();

      if (type === 'test') setTimeout(() => monitorTestOutput(transaction.pane.id, logFile), 2000);
      else setTimeout(() => monitorDevOutput(transaction.pane.id, logFile), 2000);

      setRunningCommand(false);
      setStatusMessage(`${type === 'test' ? 'Test' : 'Dev server'} started in background`);
      setTimeout(() => setStatusMessage(''), 3000);
    } catch {
      setRunningCommand(false);
      setStatusMessage(`Failed to run ${type} command`);
      setTimeout(() => setStatusMessage(''), 3000);
    }
  };

  const monitorTestOutput = async (paneId: string, logFile: string) => {
    try {
      const content = await fs.readFile(logFile, 'utf-8');
      let status: 'passed' | 'failed' | 'running' = 'running';
      if (content.match(/(?:tests?|specs?) (?:passed|✓|succeeded)/i) || content.match(/\b0 fail(?:ing|ed|ures?)\b/i)) {
        status = 'passed';
      } else if (content.match(/(?:tests?|specs?) (?:failed|✗|✖)/i) || content.match(/\d+ fail(?:ing|ed|ures?)/i) || content.match(/error:/i)) {
        status = 'failed';
      }

      const pane = panes.find(p => p.id === paneId);
      const testTarget = pane?.testPaneId || pane?.testWindowId;
      if (testTarget) {
        try {
          const targetList = pane?.testPaneId
            ? `tmux list-panes -a -F '#{pane_id}' | rg -q '${testTarget}'`
            : `tmux list-windows -a -F '#{window_id}' | rg -q '${testTarget}'`;
          execSync(targetList, { stdio: 'pipe' });
          const paneOutput = execSync(
            `tmux capture-pane -t '${testTarget}' -p | tail -5`,
            { encoding: 'utf-8' },
          );
          if (paneOutput.includes('$') || paneOutput.includes('#')) {
            if (status === 'running') status = 'passed';
          }
        } catch {
          if (status === 'running') status = 'failed';
        }
      }

      const updatedPanes = panes.map(p => p.id === paneId ? { ...p, testStatus: status, testOutput: content.slice(-5000) } : p);
      await savePanes(updatedPanes, panes);
      if (status === 'running') setTimeout(() => monitorTestOutput(paneId, logFile), 2000);
    } catch {}
  };

  const monitorDevOutput = async (paneId: string, logFile: string) => {
    try {
      const content = await fs.readFile(logFile, 'utf-8');
      const urlMatch = content.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+/i) || content.match(/Local:\s+(https?:\/\/[^\s]+)/i) || content.match(/listening on port (\d+)/i);
      let devUrl = '';
      if (urlMatch) {
        if (urlMatch[0].startsWith('http')) devUrl = urlMatch[0];
        else if ((urlMatch as any)[1]) devUrl = `http://localhost:${(urlMatch as any)[1]}`;
      }
      const pane = panes.find(p => p.id === paneId);
      let status: 'running' | 'stopped' = 'running';
      const devTarget = pane?.devPaneId || pane?.devWindowId;
      if (devTarget) {
        try {
          const targetList = pane?.devPaneId
            ? `tmux list-panes -a -F '#{pane_id}' | rg -q '${devTarget}'`
            : `tmux list-windows -a -F '#{window_id}' | rg -q '${devTarget}'`;
          execSync(targetList, { stdio: 'pipe' });
        } catch {
          status = 'stopped';
        }
      }
      const updatedPanes = panes.map(p => p.id === paneId ? { ...p, devStatus: status, devUrl: devUrl || p.devUrl } : p);
      await savePanes(updatedPanes, panes);
      if (status === 'running') setTimeout(() => monitorDevOutput(paneId, logFile), 2000);
    } catch {}
  };

  const attachBackgroundWindow = async (pane: PsychePane, type: 'test' | 'dev') => {
    const windowId = type === 'test' ? pane.testWindowId : pane.devWindowId;
    if (!windowId) {
      setStatusMessage(`No ${type} window to attach`);
      setTimeout(() => setStatusMessage(''), 2000);
      return;
    }
    try {
      const tmuxService = TmuxService.getInstance();
      const projectRoot = pane.projectRoot
        || (pane.worktreePath
          ? deriveProjectRootFromWorktreePath(pane.worktreePath)
          : undefined)
        || process.cwd();
      const expectedGeneration = type === 'test'
        ? pane.testTmuxServerIdentity
        : pane.devTmuxServerIdentity;
      if (!expectedGeneration) {
        throw new Error(`Cannot join an unversioned ${type} background window`);
      }
      await joinBackgroundWindowTransaction({
        type,
        projectRoot,
        pane,
        expectedWindow: {
          windowId,
          paneId: type === 'test' ? pane.testPaneId : pane.devPaneId,
          tmuxServerIdentity: expectedGeneration,
        },
        getWindowPaneId: (targetWindowId) => tmuxService.getWindowPaneId(targetWindowId),
        joinPane: async (targetWindowId) => {
          await tmuxService.joinPane(targetWindowId, true);
        },
        tearDownJoinedPane: async (joinedPaneId, allocationIdentity) => {
          const current = tmuxService.getServerIdentity?.();
          if (!current) {
            return {
              presence: 'unknown',
              error: 'current tmux server generation could not be verified',
            };
          }
          if (!sameTmuxServerIdentity(allocationIdentity, current)) {
            return { presence: 'absent' };
          }
          return tearDownPaneWithVerification({
            probe: async () => {
              const identity = tmuxService.getServerIdentity?.();
              if (!identity) return 'unknown';
              if (!sameTmuxServerIdentity(allocationIdentity, identity)) {
                return 'absent';
              }
              return tmuxService.probePanePresence(joinedPaneId);
            },
            kill: async () => {
              const identity = tmuxService.getServerIdentity?.();
              if (!identity) {
                throw new Error('current tmux server generation could not be verified');
              }
              if (!sameTmuxServerIdentity(allocationIdentity, identity)) {
                return;
              }
              await tmuxService.killPane(joinedPaneId);
            },
          });
        },
        getTmuxServerIdentity: () => tmuxService.getServerIdentity?.(),
        retainUncertainRecovery: async (recoveryPane, reason) => {
          try {
            const marker = await writeWorktreeRecoveryMarker({
              projectRoot,
              worktreePath: recoveryPane.worktreePath || projectRoot,
              pane: {
                id: recoveryPane.id,
                paneId: recoveryPane.paneId,
              },
              operation: 'background-window-join',
              reason,
            });
            return `wrote recovery marker ${marker.path}. ${
              marker.warning ? `${marker.warning}. ` : ''
            }${marker.marker.operatorInstructions}`;
          } catch {
            return undefined;
          }
        },
      });
      await refreshPanes?.();
      // Don't apply global layouts - just enforce sidebar width
      try {
        const controlPaneId = await tmuxService.getCurrentPaneId();
        enforceControlPaneSize(controlPaneId, SIDEBAR_WIDTH);
      } catch {}
      await tmuxService.selectPane('{last}');
      setStatusMessage(`Attached ${type} window`);
      setTimeout(() => setStatusMessage(''), 2000);
    } catch {
      setStatusMessage(`Failed to attach ${type} window`);
      setTimeout(() => setStatusMessage(''), 2000);
    }
  };

  return { copyNonGitFiles, runCommandInternal, monitorTestOutput, monitorDevOutput, attachBackgroundWindow } as const;
}
