import type {
  ClientMessage,
  ServerMessage,
} from '../src/services/bridge/wireProtocol.js';

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
 * Adding `foo?: string` to a payload makes every fixture for it a compile
 * error until the author supplies a value — which is the moment to also update
 * the Swift struct.
 *
 * Unions like `string | null` are left alone: they are not object types, so the
 * mapped branch does not apply and `null` stays a legal value.
 */
type Complete<T> =
  T extends readonly (infer E)[] ? Complete<E>[]
    : T extends object ? { [K in keyof T]-?: Complete<T[K]> }
      : T;

type CompleteMessage<M> = M extends { type: infer T; payload: infer P }
  ? { type: T; payload: Complete<P> }
  : never;

export type ClientFixture = CompleteMessage<ClientMessage>;
export type ServerFixture = CompleteMessage<ServerMessage>;

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
    },
  },
  welcome_noProject: {
    type: 'welcome',
    payload: {
      serverId: 'srv-1',
      serverName: 'psyche-build',
      protocolVersion: 2,
      projectName: null,
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
