import type { TmuxControl } from '../services/tmuxControl.js';
import { decodeBase64Payload } from '../utils/base64.js';
import { buildDesktopUseQuickInput, isDesktopUseQuickAction, type DesktopUseQuickAction } from '../utils/covenDesktopUse.js';
import type { ControlHandlers } from '../control/runtime.js';
import type { AgenticCapabilityRouter } from '../orchestration/capabilityRouter.js';
import {
  spawnBridgePane,
  createCovenClient,
  launchProjectCovenSession,
  openProjectCovenSession,
  routeProjectCovenSessionCapability,
  updatePaneMeta,
  defaultSpawnDeps,
  type BridgeSpawnRequest,
  type BridgeSpawnResult,
  type BridgeSpawnDeps,
  type CovenClient,
  type ProjectCovenCapabilityRequest,
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
  /** Router used to execute Coven session capabilities. */
  capabilityRouter: AgenticCapabilityRouter;
  /** Coven client factory; defaults to the real bridge client. */
  createCovenClient?: () => CovenClient;
  /** Spawn deps used when opening a Coven session pane; defaults to the real bridge deps. */
  covenSpawnDeps?: BridgeSpawnDeps;
}

function notSupported(kind: string): () => Promise<never> {
  return () => Promise.reject(Object.assign(
    new Error(`control command not supported by the daemon adapter: ${kind}`),
    { code: 'command_not_supported' },
  ));
}

function notImplemented(kind: string): () => Promise<never> {
  return () => Promise.reject(Object.assign(
    new Error(`agent surface backend is not implemented: ${kind}`),
    { code: 'command_not_implemented' },
  ));
}

/**
 * The concrete {@link ControlHandlers} that turn canonical control commands
 * into daemon effects.
 *
 * This is the single module that reaches the real pane-mutation effects
 * (`tmux.sendKeysHex`, `resizePane`, `selectPane`, `killPane`, and
 * `spawnBridgePane`) and the Coven session mutations (`launchProjectCovenSession`,
 * `openProjectCovenSession`, `routeProjectCovenSessionCapability`, and desktop
 * quick actions) on behalf of the runtime. `Connection.dispatch` no longer
 * touches those effects directly; it submits commands to the runtime, and the
 * runtime drives these handlers. Commands the daemon does not yet translate
 * reject with `command_not_supported` rather than silently succeeding.
 */
export function createDaemonControlHandlers(deps: DaemonControlHandlerDeps): ControlHandlers {
  const spawn = deps.spawnPane ?? spawnBridgePane;
  const covenClientFactory = deps.createCovenClient ?? createCovenClient;
  const covenSpawnDeps = deps.covenSpawnDeps ?? defaultSpawnDeps;

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
    async updatePaneMeta(payload): Promise<void> {
      await updatePaneMeta(deps.projectRoot, payload.paneId, {
        title: payload.title,
        agent: payload.agent,
      });
    },
    launchRitual: notSupported('ritual.launch'),
    observePane: notImplemented('pane.observe'),
    actOnPane: notImplemented('pane.action'),
    inspectBrowser: notImplemented('browser.inspect'),
    actOnBrowser: notImplemented('browser.action'),
    runBrowserScript: notImplemented('browser.script'),

    async launchCovenSession(payload) {
      return launchProjectCovenSession(
        deps.projectRoot,
        {
          harness: payload.harness,
          prompt: payload.prompt,
          cwd: payload.cwd,
          title: payload.title,
        },
        covenClientFactory(),
      );
    },

    async openCovenSession(payload) {
      return openProjectCovenSession(
        deps.projectRoot,
        deps.sessionName,
        payload.sessionId,
        covenClientFactory(),
        covenSpawnDeps,
      );
    },

    async runCovenDesktopAction(payload) {
      if (!isDesktopUseQuickAction(payload.action)) {
        throw Object.assign(
          new Error(`unsupported coven desktop action: ${payload.action}`),
          { code: 'invalid_desktop_action' },
        );
      }
      const action: DesktopUseQuickAction = payload.action;
      const client = covenClientFactory();
      await client.sendInput?.(payload.sessionId, buildDesktopUseQuickInput(action));
      return { sessionId: payload.sessionId, action, accepted: true };
    },

    async executeCovenCapability(payload) {
      const request: ProjectCovenCapabilityRequest = {
        taskId: payload.taskId,
        traceId: payload.traceId,
        capability: payload.capability,
        provider: payload.provider,
        prompt: payload.prompt,
        title: payload.title,
        state: payload.state,
        attempt: payload.attempt,
        idempotencyKey: payload.idempotencyKey,
      };
      const execution = await routeProjectCovenSessionCapability(
        deps.projectRoot,
        payload.sessionId,
        request,
        deps.capabilityRouter,
        covenClientFactory(),
      );
      return { sessionId: payload.sessionId, execution };
    },
  };
}
