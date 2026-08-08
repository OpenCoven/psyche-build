import type { TmuxControl } from '../services/tmuxControl.js';
import { decodeBase64Payload } from '../utils/base64.js';
import type { ControlHandlers } from '../control/runtime.js';
import {
  spawnBridgePane,
  type BridgeSpawnRequest,
  type BridgeSpawnResult,
} from './bridge.js';

export interface DaemonControlHandlerDeps {
  tmux: TmuxControl;
  projectRoot: string;
  sessionName: string;
  /** Effect boundary for pane creation; defaults to the real bridge spawn. */
  spawnPane?: (
    projectRoot: string,
    sessionName: string,
    request: BridgeSpawnRequest,
  ) => Promise<BridgeSpawnResult>;
}

function notSupported(kind: string): () => Promise<never> {
  return () => Promise.reject(Object.assign(
    new Error(`control command not supported by the daemon adapter: ${kind}`),
    { code: 'command_not_supported' },
  ));
}

/**
 * The concrete {@link ControlHandlers} that turn canonical control commands
 * into daemon effects.
 *
 * This is the single module that reaches the real pane-mutation effects
 * (`tmux.sendKeysHex`, `resizePane`, `selectPane`, `killPane`, and
 * `spawnBridgePane`) on behalf of the runtime. `Connection.dispatch` no longer
 * touches those effects directly; it submits commands to the runtime, and the
 * runtime drives these handlers. Commands the daemon does not yet translate
 * reject with `command_not_supported` rather than silently succeeding.
 */
export function createDaemonControlHandlers(deps: DaemonControlHandlerDeps): ControlHandlers {
  const spawn = deps.spawnPane ?? spawnBridgePane;

  return {
    async spawnPane(payload): Promise<BridgeSpawnResult> {
      const request: BridgeSpawnRequest = {
        requestId: payload.requestId ?? '',
        cwd: payload.cwd,
        agent: payload.agent,
        title: payload.title,
        prompt: payload.prompt,
        branch: payload.branch,
        startPointBranch: payload.startPointBranch,
        existingWorktree: payload.existingWorktree,
      };
      return spawn(deps.projectRoot, deps.sessionName, request);
    },

    async sendInput(payload): Promise<void> {
      const bytes = decodeBase64Payload(payload.dataBase64);
      if (!bytes) {
        throw Object.assign(new Error('input must be base64'), { code: 'bad_base64' });
      }
      deps.tmux.sendKeysHex(payload.paneId, bytes);
    },

    async resizePane(payload): Promise<void> {
      deps.tmux.resizePane(payload.paneId, payload.cols, payload.rows);
    },

    async focusPane(payload): Promise<void> {
      deps.tmux.selectPane(payload.paneId);
    },

    async killPane(payload): Promise<void> {
      deps.tmux.killPane(payload.paneId);
    },

    executeOrchestration: notSupported('orchestration.execute'),
    sendPrompt: notSupported('pane.prompt'),
    interruptPane: notSupported('pane.interrupt'),
    openTerminal: notSupported('pane.terminal.open'),
    respawnPane: notSupported('pane.respawn'),
    openConflictPane: notSupported('pane.conflict.open'),
    updatePaneOption: notSupported('pane.option.update'),
    updatePaneMeta: notSupported('pane.meta.update'),
    launchRitual: notSupported('ritual.launch'),
    launchCovenSession: notSupported('coven.session.launch'),
    openCovenSession: notSupported('coven.session.open'),
    runCovenDesktopAction: notSupported('coven.desktop.action'),
    executeCovenCapability: notSupported('coven.capability.execute'),
  };
}
