import type {
  ClientMessage,
  ServerMessage,
} from '../src/services/bridge/wireProtocol.js';
import type { ServerResponse } from '../src/daemon/protocol.js';
import { PaneAction } from '../src/actions/types.js';

/**
 * Typed source of truth for the wire-protocol fixtures.
 *
 * The JSON files beside this one are generated from it (`pnpm run
 * fixtures:generate`) and are what the Swift suite reads. This file exists so
 * the compiler enforces something JSON cannot: that every fixture is a
 * *complete* example of its message.
 *
 * Without it, adding a field to a payload passed everything — tsc was happy and
 * all contract tests passed — while the Swift mirror never learned the field
 * existed. Adding a field is far more common than adding a message type, so
 * that was the likelier drift and the one the JSON-only design missed.
 */

/**
 * Strips optionality at every depth, so a fixture must spell out every field.
 * Optional fields accept an explicit `undefined` sentinel, which keeps the
 * compile-time completeness check while matching their omitted JSON wire shape.
 * Adding `foo?: string` to a payload makes every fixture for it a compile error
 * until the author supplies a value or that sentinel — which is the moment to
 * also update the Swift struct.
 *
 * Unions like `string | null` are left alone: they are not object types, so the
 * mapped branch does not apply and `null` stays a legal value.
 */
type OptionalKeys<T extends object> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? K : never
}[keyof T];

type Complete<T> =
  T extends readonly (infer E)[] ? Complete<E>[]
    : T extends object
      ? { [K in Exclude<keyof T, OptionalKeys<T>>]: Complete<T[K]> }
        & { [K in OptionalKeys<T>]: Complete<Exclude<T[K], undefined>> | undefined }
      : T;

type CompleteMessage<M> = M extends { type: infer T; payload: infer P }
  ? { type: T; payload: Complete<P> }
  : never;

export type ClientFixture = CompleteMessage<ClientMessage>;
export type ServerFixture = CompleteMessage<ServerMessage>;
export type MobileControlFixture = CompleteMessage<
  Extract<ClientMessage, { type: 'control' }>
  | Extract<ServerMessage, { type: 'control' | 'workspaceChanged' }>
>;
type CompleteDaemonMessage<M> = M extends { type: infer T }
  ? { [K in keyof M]-?: Complete<M[K]> } & { type: T }
  : never;

export type WorkspaceSnapshotFixture = CompleteDaemonMessage<Extract<
  ServerResponse,
  { type: 'workspace.snapshot.result' }
>>;

/**
 * Keys may carry a `_variant` suffix to cover a second shape of the same
 * message — the wire type is always the `type` field, and the contract tests
 * key completeness off that, not off these names.
 */
export const CLIENT_FIXTURES = {
  hello: {
    type: 'hello',
    payload: {
      clientId: 'ios-device-1',
      clientName: 'Psyche for iPhone',
      protocolVersion: 2,
      token: 'tok_abc123',
    },
  },
  hello_noToken: {
    type: 'hello',
    payload: {
      clientId: 'ios-device-1',
      clientName: 'Psyche for iPhone',
      protocolVersion: 2,
      token: null,
    },
  },
  listPanes: { type: 'listPanes', payload: {} },
  sendInput: { type: 'sendInput', payload: { paneId: '%3', data: 'bHMgLWxhCg==' } },
  focusPane: { type: 'focusPane', payload: { paneId: '%3' } },
  ping: { type: 'ping', payload: { token: 'tok_abc123' } },
  listProjects: { type: 'listProjects', payload: {} },
  subscribePane: { type: 'subscribePane', payload: { paneId: '%3', sinceSeq: 42 } },
  subscribePane_noSeq: { type: 'subscribePane', payload: { paneId: '%3', sinceSeq: null } },
  unsubscribePane: { type: 'unsubscribePane', payload: { paneId: '%3' } },
  listRituals: { type: 'listRituals', payload: { projectId: 'proj-1' } },
  launchRitual: {
    type: 'launchRitual',
    payload: {
      projectId: 'proj-1',
      ritualId: 'start-coding',
      params: { prompt: 'Fix the failing tests' },
    },
  },
  pair: {
    type: 'pair',
    payload: { code: '123456', clientId: 'ios-device-1', clientName: 'Psyche for iPhone' },
  },
} satisfies Record<string, ClientFixture>;

const PANE = {
  id: '%3',
  displayName: 'fix-auth',
  kind: 'worktree',
  projectId: 'proj-1',
  projectName: 'psyche-build',
  worktreePath: '/repo/.psyche/worktrees/fix-auth',
  agent: 'coven-code',
  status: 'working',
} as const;

const SHELL_PANE = {
  id: '%4',
  displayName: 'shell',
  kind: 'shell',
  projectId: null,
  projectName: null,
  worktreePath: null,
  agent: null,
  status: 'idle',
} as const;

const RITUAL = {
  id: 'start-coding',
  displayName: 'Start Coding',
  description: 'Open one agent pane for focused implementation work.',
  scope: 'builtIn',
  projectId: null,
} as const;

export const SERVER_FIXTURES = {
  welcome: {
    type: 'welcome',
    payload: {
      serverId: 'srv-1',
      serverName: 'psyche-build',
      protocolVersion: 2,
      projectName: 'psyche-build',
      supportedVersions: [2, 3],
    },
  },
  welcome_noProject: {
    type: 'welcome',
    payload: {
      serverId: 'srv-1',
      serverName: 'psyche-build',
      protocolVersion: 2,
      projectName: null,
      supportedVersions: [2, 3],
    },
  },
  paneList: { type: 'paneList', payload: [PANE] },
  paneListChanged: { type: 'paneListChanged', payload: [PANE, SHELL_PANE] },
  projectList: {
    type: 'projectList',
    payload: [{ id: 'proj-1', displayName: 'psyche-build', attentionCount: 2 }],
  },
  paneOutput: { type: 'paneOutput', payload: { paneId: '%3', data: 'aGVsbG8gd29ybGQK', seq: 1024 } },
  ritualList: { type: 'ritualList', payload: { projectId: 'proj-1', rituals: [RITUAL] } },
  ritualList_empty: { type: 'ritualList', payload: { projectId: null, rituals: [] } },
  attention: {
    type: 'attention',
    payload: {
      paneId: '%3',
      reason: 'waiting',
      summary: 'Agent is awaiting input',
      timestamp: '2026-08-03T02:17:18Z',
    },
  },
  attention_noSummary: {
    type: 'attention',
    payload: {
      paneId: '%3',
      reason: 'idle',
      summary: null,
      timestamp: '2026-08-03T02:17:18Z',
    },
  },
  pairChallenge: { type: 'pairChallenge', payload: { expiresAt: '2026-08-03T02:22:18Z', codeLength: 6 } },
  pairAccepted: { type: 'pairAccepted', payload: { token: 'tok_abc123' } },
  pairRejected: { type: 'pairRejected', payload: { reason: 'code expired' } },
  pong: { type: 'pong', payload: { token: 'tok_abc123' } },
  error: {
    type: 'error',
    payload: { code: 'pane_not_found', message: 'pane is not registered in this psyche project' },
  },
} satisfies Record<string, ServerFixture>;

export const WORKSPACE_SNAPSHOT_FIXTURE = {
  type: 'workspace.snapshot.result',
  requestId: 'workspace-1',
  workspace: {
    revision: 42,
    projects: [{
      id: 'project-1',
      root: '/repo',
      title: 'psyche-build',
      worktrees: [{
        path: '/repo',
        head: '0123456789abcdef0123456789abcdef01234567',
        branch: 'main',
        isMain: true,
        detached: false,
        bare: false,
        locked: false,
        lockReason: undefined,
        prunable: false,
        pruneReason: undefined,
        dirty: true,
        missing: false,
        panes: [{
          id: '%3',
          cwd: '/repo',
          title: 'implementation',
          kind: 'agent',
          agent: 'coven-code',
          status: 'running',
          needsAttention: false,
          lastActivity: '2026-08-03T02:12:00.000Z',
          recoverability: 'healthy',
        }],
        runningCount: 1,
        attentionCount: 0,
      }, {
        path: '/worktrees/review',
        head: 'fedcba9876543210fedcba9876543210fedcba98',
        branch: 'review',
        isMain: false,
        detached: false,
        bare: false,
        locked: true,
        lockReason: 'manual review',
        prunable: true,
        pruneReason: 'gitdir file points to non-existent location',
        dirty: false,
        missing: true,
        panes: [{
          id: 'coven:review',
          cwd: '/worktrees/review',
          title: 'review lane',
          kind: 'coven-session',
          agent: 'coven-code',
          status: 'waiting',
          needsAttention: true,
          lastActivity: '2026-08-03T02:17:18.000Z',
          recoverability: 'healthy',
        }],
        runningCount: 0,
        attentionCount: 1,
      }],
      projectPanes: [{
        id: '%9',
        cwd: '/missing/worktree',
        title: 'orphaned pane',
        kind: 'terminal',
        agent: undefined,
        status: 'exited',
        needsAttention: false,
        lastActivity: undefined,
        recoverability: 'missing-worktree',
      }],
      runningCount: 1,
      attentionCount: 1,
    }],
  },
} satisfies WorkspaceSnapshotFixture;

export const MOBILE_CONTROL_FIXTURES = {
  workspaceSnapshotRequest: {
    type: 'control',
    payload: {
      type: 'workspace.snapshot',
      requestId: 'workspace-1',
    },
  },
  workspaceChanged: {
    type: 'workspaceChanged',
    payload: {
      revision: 42,
      sequence: 7,
      workspace: WORKSPACE_SNAPSHOT_FIXTURE.workspace,
    },
  },
  attachAgentPane: {
    type: 'control',
    payload: {
      type: 'panes.attach',
      requestId: 'attach-1',
      id: '%3',
      cols: 100,
      rows: 32,
      sinceSeq: 12,
    },
  },
  spawnAgentPane: {
    type: 'control',
    payload: {
      type: 'panes.spawn',
      requestId: 'spawn-1',
      idempotencyKey: 'spawn-agent-1',
      kind: 'agent',
      projectId: '/repo',
      cwd: '/repo',
      branch: undefined,
      startPointBranch: undefined,
      existingWorktree: undefined,
      agent: 'coven-code',
      title: 'Implement mobile cockpit',
      prompt: 'Add the paired protocol-v3 control envelope.',
    },
  },
  detachPane: {
    type: 'control',
    payload: {
      type: 'panes.detach',
      requestId: 'detach-1',
      streamId: 'stream-1',
    },
  },
  inputPane: {
    type: 'control',
    payload: {
      type: 'panes.input',
      requestId: 'input-1',
      streamId: 'stream-1',
      data: 'bHMgLWxhCg==',
    },
  },
  resizePane: {
    type: 'control',
    payload: {
      type: 'panes.resize',
      requestId: 'resize-1',
      streamId: 'stream-1',
      cols: 120,
      rows: 40,
    },
  },
  killPane: {
    type: 'control',
    payload: {
      type: 'panes.kill',
      requestId: 'kill-1',
      id: '%3',
    },
  },
  launchRitual: {
    type: 'control',
    payload: {
      type: 'rituals.launch',
      requestId: 'ritual-1',
      projectId: 'psyche',
      ritualId: 'daily-standup',
      params: { branch: 'main' },
    },
  },
  paneMeta: {
    type: 'control',
    payload: {
      type: 'panes.meta',
      requestId: 'meta-1',
      id: '%3',
      title: 'Mobile cockpit',
      agent: 'coven-code',
    },
  },
  listFiles: {
    type: 'control',
    payload: {
      type: 'files.list',
      requestId: 'files-list-1',
      paneId: '%3',
    },
  },
  readFile: {
    type: 'control',
    payload: {
      type: 'files.read',
      requestId: 'files-read-1',
      paneId: '%3',
      path: 'src/index.ts',
    },
  },
  diffFile: {
    type: 'control',
    payload: {
      type: 'files.diff',
      requestId: 'files-diff-1',
      paneId: '%3',
      path: 'src/index.ts',
    },
  },
  startAction: {
    type: 'control',
    payload: {
      type: 'actions.start',
      requestId: 'action-start-1',
      paneId: '%3',
      action: PaneAction.VIEW,
    },
  },
  respondToAction: {
    type: 'control',
    payload: {
      type: 'actions.respond',
      requestId: 'action-response-1',
      paneId: '%3',
      response: { type: 'confirm' },
    },
  },
  ack: {
    type: 'control',
    payload: {
      type: 'ack',
      requestId: 'ack-1',
      ok: true,
    },
  },
  paneSpawned: {
    type: 'control',
    payload: {
      type: 'panes.spawn.result',
      requestId: 'spawn-1',
      id: '%3',
      pane: undefined,
      worktreePath: '/repo/.psyche/worktrees/mobile-cockpit',
      branch: 'mobile-cockpit',
    },
  },
  streamExited: {
    type: 'control',
    payload: {
      type: 'panes.stream.exit',
      streamId: 'stream-1',
      reason: 'pane exited',
    },
  },
  controlError: {
    type: 'control',
    payload: {
      type: 'error',
      requestId: 'error-1',
      code: 'pane_not_found',
      message: 'pane is not registered',
    },
  },
  workspaceSnapshotResult: {
    type: 'control',
    payload: {
      type: 'mobile.workspace.snapshot.result',
      requestId: 'workspace-1',
      sequence: 7,
      workspace: WORKSPACE_SNAPSHOT_FIXTURE.workspace,
    },
  },
  attachPaneResult: {
    type: 'control',
    payload: {
      type: 'mobile.panes.attach.result',
      requestId: 'attach-1',
      streamId: 'stream-1',
      id: '%3',
      latestSeq: 12,
      hasReplay: true,
      replayMode: 'replace',
    },
  },
  filesListResult: {
    type: 'control',
    payload: {
      type: 'files.list.result',
      requestId: 'files-list-1',
      paneId: '%3',
      snapshot: {
        rootPath: '/repo',
        files: [{
          path: 'src/index.ts',
          name: 'index.ts',
          parentPath: 'src',
          exists: true,
          changed: true,
          statusCode: 'M',
          statusLabel: 'Modified',
        }],
      },
    },
  },
  filesReadResult: {
    type: 'control',
    payload: {
      type: 'files.read.result',
      requestId: 'files-read-1',
      paneId: '%3',
      path: 'src/index.ts',
      content: 'export {};\n',
    },
  },
  filesDiffResult: {
    type: 'control',
    payload: {
      type: 'files.diff.result',
      requestId: 'files-diff-1',
      paneId: '%3',
      path: 'src/index.ts',
      diff: '@@ -0,0 +1 @@\n+export {};\n',
    },
  },
  actionResult: {
    type: 'control',
    payload: {
      type: 'actions.result',
      requestId: 'action-start-1',
      sessionId: undefined,
      result: {
        type: 'success',
        message: 'Action completed',
        title: undefined,
        confirmLabel: undefined,
        cancelLabel: undefined,
        options: undefined,
        placeholder: undefined,
        defaultValue: undefined,
        inputMaxVisibleLines: undefined,
        progress: undefined,
        targetPaneId: undefined,
        reviewData: undefined,
        data: undefined,
        relatedFiles: undefined,
        dismissable: undefined,
      },
    },
  },
} satisfies Record<string, MobileControlFixture>;
