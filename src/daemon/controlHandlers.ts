import type { TmuxControl } from '../services/tmuxControl.js';
import { assertTmuxPaneId } from '../utils/tmuxTarget.js';
import { decodeBase64Payload } from '../utils/base64.js';
import { buildDesktopUseQuickInput, isDesktopUseQuickAction, type DesktopUseQuickAction } from '../utils/covenDesktopUse.js';
import type { ControlHandlers } from '../control/runtime.js';
import { validatePaneNamedKeys } from '../control/types.js';
import type { PaneResourceController } from '../control/resources/panes.js';
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
  /** Shared stable pane projection used by both handlers and the host runtime. */
  panes?: PaneResourceController;
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
  const panes = () => {
    if (!deps.panes) {
      throw Object.assign(new Error('pane resource controller is unavailable'), { code: 'command_not_implemented' });
    }
    return deps.panes;
  };

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
      const result = await spawn(deps.projectRoot, deps.sessionName, request);
      await deps.panes?.refresh();
      return result;
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
    async observePane(payload) {
      return panes().observe(payload.paneId, payload.generation, payload.afterSequence);
    },
    async actOnPane(payload) {
      if (payload.action.kind === 'create') {
        const result = await spawn(deps.projectRoot, deps.sessionName, {
          requestId: payload.taskId,
          cwd: payload.action.cwd,
          title: payload.action.title,
          agent: payload.action.agent,
          branch: payload.action.branch,
        });
        const resources = await panes().refresh();
        const resource = resources.find((candidate) => candidate.tmuxPaneId === result.id);
        if (!resource) {
          throw Object.assign(new Error('created pane was not present in the canonical registry'), {
            code: 'resource_missing',
          });
        }
        return resource;
      }

      const controller = panes();
      if (typeof payload.paneId !== 'string' || typeof payload.generation !== 'number') {
        throw Object.assign(new Error('existing pane action requires a resource generation'), {
          code: 'resource_missing',
        });
      }
      const resource = controller.resolve(payload.paneId, payload.generation);
      const tmuxPaneId = assertTmuxPaneId(resource.tmuxPaneId);
      switch (payload.action.kind) {
        case 'send_text':
          await deps.tmux.sendKeysHexAcknowledged(tmuxPaneId, Buffer.from(payload.action.text, 'utf8'));
          return undefined;
        case 'send_keys': {
          const keys = validatePaneNamedKeys(payload.action.keys);
          await deps.tmux.sendNamedKeysAcknowledged(tmuxPaneId, keys);
          return undefined;
        }
        case 'interrupt': {
          const key = payload.action.key ?? 'C-c';
          await deps.tmux.sendNamedKeysAcknowledged(tmuxPaneId, [key]);
          return undefined;
        }
        case 'focus': {
          await deps.tmux.selectPaneAcknowledged(tmuxPaneId);
          const observed = await deps.tmux.queryPane(tmuxPaneId);
          return Object.freeze({
            paneId: resource.id, generation: resource.generation,
            focused: observed.focused, cols: observed.cols, rows: observed.rows,
          });
        }
        case 'resize': {
          await deps.tmux.resizePaneAcknowledged(tmuxPaneId, payload.action.cols, payload.action.rows);
          const observed = await deps.tmux.queryPane(tmuxPaneId);
          return Object.freeze({
            paneId: resource.id, generation: resource.generation,
            focused: observed.focused, cols: observed.cols, rows: observed.rows,
          });
        }
        case 'close':
          await deps.tmux.killPaneAcknowledged(tmuxPaneId);
          controller.remove(resource.id, resource.generation);
          return undefined;
        default:
          return assertNever(payload.action);
      }
    },
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

function assertNever(value: never): never {
  throw Object.assign(new Error(`unsupported pane action: ${String((value as { kind?: unknown }).kind)}`), {
    code: 'command_not_implemented',
  });
}
