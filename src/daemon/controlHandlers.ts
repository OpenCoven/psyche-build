import { tmuxDimensionArg, type TmuxControl } from '../services/tmuxControl.js';
import { decodeBase64Payload } from '../utils/base64.js';
import { assertTmuxPaneId, quoteTmuxArgument } from '../utils/tmuxTarget.js';
import { buildDesktopUseQuickInput, isDesktopUseQuickAction, type DesktopUseQuickAction } from '../utils/covenDesktopUse.js';
import type { ControlHandlers } from '../control/runtime.js';
import { PaneObservationStore } from '../control/resources/paneObservation.js';
import { SurfaceRegistry, type PaneSurface } from '../control/surfaces.js';
import type { PaneNamedKey } from '../control/types.js';
import type {
  BrowserProviderBroker,
  ProviderEffectResult,
} from '../control/browserProviderBroker.js';
import { randomUUID } from 'node:crypto';
import { AGENT_CONTROL_LIMITS } from '../control/limits.js';
import { BrowserSemanticSnapshotRegistry } from '../control/browserSemanticSnapshots.js';
import type { AgenticCapabilityRouter } from '../orchestration/capabilityRouter.js';
import {
  spawnBridgePane,
  killBridgePane,
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
  paneObservations?: PaneObservationStore;
  surfaces?: SurfaceRegistry;
  refreshPaneSurfaces?: () => Promise<readonly PaneSurface[]>;
  /** Safe durable pane teardown; injectable for handler tests. */
  closePane?: (projectRoot: string, paneId: string) => Promise<unknown>;
  browserProvider?: Pick<BrowserProviderBroker, 'dispatch'>;
  browserSemanticSnapshots?: BrowserSemanticSnapshotRegistry;
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
  const paneObservations = deps.paneObservations ?? new PaneObservationStore();
  const surfaces = deps.surfaces ?? new SurfaceRegistry();
  const closePane = deps.closePane ?? killBridgePane;

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
      await deps.tmux.sendKeysHex(payload.paneId, bytes);
    },

    async resizePane(payload): Promise<void> {
      deps.tmux.resizePane(payload.paneId, payload.cols, payload.rows);
    },

    async focusPane(payload): Promise<void> {
      deps.tmux.selectPane(payload.paneId);
    },

    async killPane(payload): Promise<void> {
      await deps.tmux.killPane(payload.paneId);
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
      requirePaneSurface(surfaces, payload.paneId, payload.generation);
      return paneObservations.read(payload.paneId, { afterSequence: payload.afterSequence });
    },
    async actOnPane(payload) {
      if (payload.action.kind === 'create') {
        if (payload.projectId !== deps.projectRoot) {
          throw codedHandlerError('resource_scope_mismatch', 'pane creation target is outside this project');
        }
        const result = await spawn(deps.projectRoot, deps.sessionName, {
          requestId: '',
          cwd: payload.action.cwd,
          title: payload.action.title,
          agent: payload.action.agent,
          branch: payload.action.branch,
        });
        const refreshed = await deps.refreshPaneSurfaces?.();
        const created = refreshed?.find((surface) => surface.tmuxPaneId === result.id);
        if (!created) {
          throw codedHandlerError('resource_missing', 'created pane has no stable Psyche resource binding');
        }
        return { ...result, id: created.id, pane: { ...result.pane, id: created.id } };
      }

      if (
        typeof payload.paneId !== 'string'
        || typeof payload.generation !== 'number'
        || !Number.isSafeInteger(payload.generation)
      ) {
        throw codedHandlerError('resource_missing', 'pane action target is missing');
      }
      // Re-read the durable binding immediately before every effect. The refresh
      // drops panes whose persisted tmux server generation is no longer current.
      await deps.refreshPaneSurfaces?.();
      const pane = requirePaneSurface(surfaces, payload.paneId, payload.generation);
      const target = assertTmuxPaneId(pane.tmuxPaneId);
      const quotedTarget = quoteTmuxArgument(target);
      switch (payload.action.kind) {
        case 'send_text':
          await deps.tmux.sendKeysHex(target, Buffer.from(payload.action.text, 'utf8'));
          return { paneId: payload.paneId, bytes: Buffer.byteLength(payload.action.text, 'utf8') };
        case 'send_keys': {
          if (payload.action.keys.length === 0) {
            throw codedHandlerError('invalid_pane_key', 'at least one named key is required');
          }
          for (const key of payload.action.keys) assertNamedPaneKey(key);
          await deps.tmux.executeCommand(
            `send-keys -t ${quotedTarget} ${payload.action.keys.join(' ')}`,
          );
          return { paneId: payload.paneId, keys: payload.action.keys.length };
        }
        case 'interrupt': {
          const key = payload.action.key ?? 'C-c';
          assertNamedPaneKey(key);
          await deps.tmux.executeCommand(`send-keys -t ${quotedTarget} ${key}`);
          return { paneId: payload.paneId, interrupted: true, key };
        }
        case 'focus': {
          const lines = await deps.tmux.executeCommandWithOutput(
            `select-pane -t ${quotedTarget} \\; display-message -p -t ${quotedTarget} '#{pane_active}'`,
          );
          return { paneId: payload.paneId, focused: lines.at(-1)?.trim() === '1' };
        }
        case 'resize': {
          const cols = tmuxDimensionArg(payload.action.cols, 'cols');
          const rows = tmuxDimensionArg(payload.action.rows, 'rows');
          const lines = await deps.tmux.executeCommandWithOutput(
            `resize-pane -t ${quotedTarget} -x ${cols} -y ${rows} \\; `
              + `display-message -p -t ${quotedTarget} '#{pane_width} #{pane_height}'`,
          );
          const observed = parsePaneDimensions(lines.at(-1));
          return { paneId: payload.paneId, ...observed };
        }
        case 'close':
          await closePane(deps.projectRoot, payload.paneId);
          surfaces.remove(payload.paneId);
          paneObservations.clear(payload.paneId);
          return { paneId: payload.paneId, closed: true };
      }
    },
    inspectBrowser: deps.browserProvider
      ? async (payload) => {
        const value = providerValue(await deps.browserProvider!.dispatch({
          actionId: randomUUID(), tabId: payload.tabId, generation: payload.generation,
          operation: { kind: 'inspect', includeScreenshot: payload.includeScreenshot },
          timeoutMs: AGENT_CONTROL_LIMITS.actionTimeoutMs,
        }));
        return deps.browserSemanticSnapshots
          ? deps.browserSemanticSnapshots.store(value, payload.tabId, payload.generation)
          : value;
      }
      : notSupported('browser.inspect'),
    actOnBrowser: deps.browserProvider
      ? async (payload) => providerValue(await deps.browserProvider!.dispatch({
          actionId: randomUUID(), tabId: payload.tabId, generation: payload.generation,
          operation: {
            kind: 'action', action: payload.action,
            ...('snapshotId' in payload && payload.snapshotId ? { snapshotId: payload.snapshotId } : {}),
          },
          timeoutMs: AGENT_CONTROL_LIMITS.actionTimeoutMs,
        }))
      : notSupported('browser.action'),
    runBrowserScript: deps.browserProvider
      ? async (payload) => providerValue(await deps.browserProvider!.dispatch({
          actionId: randomUUID(), tabId: payload.tabId, generation: payload.generation,
          operation: { kind: 'script', source: payload.source,
            ...(payload.args === undefined ? {} : { args: payload.args }) },
          timeoutMs: AGENT_CONTROL_LIMITS.actionTimeoutMs,
        }))
      : notSupported('browser.script'),

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

const PANE_NAMED_KEYS: ReadonlySet<PaneNamedKey> = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Up', 'Down', 'Left', 'Right', 'C-c', 'C-d',
]);

function assertNamedPaneKey(value: unknown): asserts value is PaneNamedKey {
  if (typeof value !== 'string' || !PANE_NAMED_KEYS.has(value as PaneNamedKey)) {
    throw codedHandlerError('invalid_pane_key', 'named pane key is not allowed');
  }
}

function requirePaneSurface(surfaces: SurfaceRegistry, id: string, generation: number) {
  const resource = surfaces.require(id, generation);
  if (resource.kind !== 'pane') {
    throw codedHandlerError('resource_missing', 'surface is not a pane');
  }
  return resource;
}

function parsePaneDimensions(line: string | undefined): { cols: number; rows: number } {
  const match = /^(\d+)\s+(\d+)$/.exec(line?.trim() ?? '');
  if (!match) throw codedHandlerError('backend_unavailable', 'tmux did not report pane dimensions');
  return { cols: Number(match[1]), rows: Number(match[2]) };
}

function codedHandlerError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function providerValue(result: ProviderEffectResult): unknown {
  if (result.status === 'succeeded') return result.value;
  if (result.status === 'unknown') {
    throw Object.assign(new Error(result.message ?? 'browser effect result is unknown'), {
      code: 'effect_unknown', ambiguous: true,
    });
  }
  throw codedHandlerError(result.code, result.message);
}
