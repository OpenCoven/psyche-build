__OURS__
import { decodeBase64Payload } from '../utils/base64.js';
import { assertTmuxPaneId, quoteTmuxArgument } from '../utils/tmuxTarget.js';
import { buildDesktopUseQuickInput, isDesktopUseQuickAction, type DesktopUseQuickAction } from '../utils/covenDesktopUse.js';
__OURS__
import type { AgenticCapabilityRouter } from '../orchestration/capabilityRouter.js';
import type { BrowserProviderBroker } from '../control/browserProviderBroker.js';
import type { ProviderEffectResult } from '../control/protocol.js';
import {
  spawnBridgePane,
  createCovenClient,
  launchProjectCovenSession,
  openProjectCovenSession,
  routeProjectCovenSessionCapability,
  resolveConfiguredPaneId,
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
  browserProviders?: BrowserProviderBroker;
  /** Coven client factory; defaults to the real bridge client. */
  createCovenClient?: () => CovenClient;
  /** Spawn deps used when opening a Coven session pane; defaults to the real bridge deps. */
  covenSpawnDeps?: BridgeSpawnDeps;
  paneObservations?: PaneObservationStore;
  surfaces?: SurfaceRegistry;
  refreshPaneSurfaces?: () => Promise<readonly PaneSurface[]>;
  browserProvider?: Pick<BrowserProviderBroker, 'dispatch'>;
  browserSemanticSnapshots?: BrowserSemanticSnapshotRegistry;
}

function notSupported(kind: string): () => Promise<never> {
  return () => Promise.reject(Object.assign(
    new Error(`control command not supported by the daemon adapter: ${kind}`),
    { code: 'command_not_supported' },
  ));
}

export function createBrowserSnapshotResolver(
  broker: BrowserProviderBroker,
): CanonicalBrowserSnapshotResolver {
  return async (payload) => {
    if (typeof payload.snapshotId !== 'string' || !('elementRef' in payload.action)) return undefined;
    const result = await broker.dispatch({
      actionId: `resolve:${payload.tabId}:${payload.generation}:${payload.snapshotId}:${payload.action.elementRef}`,
      tabId: payload.tabId,
      generation: payload.generation,
      operation: {
        kind: 'resolve', snapshotId: payload.snapshotId, elementRef: payload.action.elementRef,
        actionKind: payload.action.kind,
      },
    });
    if (result.status !== 'succeeded') {
      throw Object.assign(new Error(result.message), {
        code: result.code,
        ...(result.status === 'unknown' ? { ambiguous: true } : {}),
      });
    }
    if (!result.value || typeof result.value !== 'object') return undefined;
    const value = result.value as Record<string, unknown>;
    if (typeof value.documentId !== 'string' || value.documentId.length === 0 ||
      !('submit' in value) || !(typeof value.submit === 'boolean' || value.submit === null) ||
      !('formId' in value) || !(typeof value.formId === 'string' || value.formId === null) ||
      !('secret' in value) || !(typeof value.secret === 'boolean' || value.secret === null)) return undefined;
    return {
      tabId: payload.tabId, generation: payload.generation,
      snapshotId: typeof value.snapshotId === 'string' ? value.snapshotId : '',
      elementRef: typeof value.ref === 'string' ? value.ref : '',
      actionKind: typeof value.actionKind === 'string' ? value.actionKind as never : payload.action.kind,
      documentId: value.documentId,
      submit: value.submit, formId: value.formId, secret: value.secret,
    };
  };
}

export function createBrowserScriptContextResolver(
  broker: BrowserProviderBroker,
): CanonicalBrowserScriptContextResolver {
  return async (payload) => {
    const result = await broker.dispatch({
      actionId: `script-context:${payload.tabId}:${payload.generation}:${randomUUID()}`,
      tabId: payload.tabId,
      generation: payload.generation,
      operation: { kind: 'script_context' },
    });
    if (result.status !== 'succeeded') {
      throw Object.assign(new Error(result.message), {
        code: result.code,
        ...(result.status === 'unknown' ? { ambiguous: true } : {}),
      });
    }
    if (!result.value || typeof result.value !== 'object') {
      throw Object.assign(new Error('browser script context is malformed'), { code: 'snapshot_stale' });
    }
    const value = result.value as Record<string, unknown>;
    if (typeof value.documentId !== 'string' || !value.documentId
        || typeof value.documentToken !== 'string' || !value.documentToken
        || !Number.isSafeInteger(value.navigationEpoch) || (value.navigationEpoch as number) < 0
        || typeof value.navigationUrl !== 'string' || !value.navigationUrl) {
      throw Object.assign(new Error('browser script context is malformed'), { code: 'snapshot_stale' });
    }
    return { tabId: payload.tabId, generation: payload.generation,
      documentId: value.documentId, documentToken: value.documentToken,
      navigationEpoch: value.navigationEpoch as number, navigationUrl: value.navigationUrl };
  };
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
__OURS__

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
      const tmuxPaneId = await resolvePaneId(payload.paneId);
      await deps.tmux.sendKeysHex(tmuxPaneId, bytes);
    },

    async resizePane(payload): Promise<void> {
      const tmuxPaneId = await resolvePaneId(payload.paneId);
      deps.tmux.resizePane(tmuxPaneId, payload.cols, payload.rows);
    },

    async focusPane(payload): Promise<void> {
      const tmuxPaneId = await resolvePaneId(payload.paneId);
      deps.tmux.selectPane(tmuxPaneId);
    },

    async killPane(payload): Promise<void> {
      const tmuxPaneId = await resolvePaneId(payload.paneId);
      await deps.tmux.killPane(tmuxPaneId);
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
__OURS__
          cwd: payload.action.cwd,
          title: payload.action.title,
          agent: payload.action.agent,
          branch: payload.action.branch,
        });
__OURS__

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

__OURS__
}
