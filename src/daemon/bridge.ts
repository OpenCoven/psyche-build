import { execFileSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { atomicWriteJson } from '../utils/atomicWrite.js';
import { generateSiblingSlugForTargetPane } from '../utils/attachAgent.js';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  AGENT_IDS,
  buildAgentCommand,
  buildInitialPromptCommand,
  getAgentProcessName,
  getPromptTransport,
  getSendKeysPostPasteDelayMs,
  getSendKeysPrePrompt,
  getSendKeysReadyDelayMs,
  getSendKeysSubmit,
  type AgentName,
} from '../utils/agentLaunch.js';
import { sendPromptViaTmux } from '../utils/agentPromptDispatch.js';
import { TmuxService } from '../services/TmuxService.js';
import { buildPromptReadAndDeleteSnippet, writePromptFile } from '../utils/promptStore.js';
import type { PsycheConfig, PsychePane } from '../types.js';
import {
  capturePaneInsertion,
  insertPaneIntoStoredLayout,
  removePaneFromStoredLayout,
  type PaneInsertion,
} from '../utils/layoutManager.js';
import { withPanesConfigFileWriteLock } from '../utils/panesConfigQueue.js';
import {
  isAgenticCapability,
  type AgenticCapabilityRouter,
  type AgenticCapabilityExecution,
  type CapabilityProviderId,
} from '../orchestration/capabilityRouter.js';
import type {
  CovenSessionEvent,
  CovenSessionLaunchRequest,
  CovenSessionSummary,
  PaneStatusResult,
  PaneSummary,
  ProjectSummary,
} from './protocol.js';

export const DEFAULT_CAPTURE_LINES = 200;
export const MAX_CAPTURE_LINES = 2_000;

export interface ScopeCheckResult {
  projectRoot: string;
  requestedCwd: string;
}

export interface BridgeSpawnRequest {
  requestId: string;
  cwd: string;
  agent?: string;
  title?: string;
  prompt?: string;
  /** Existing branch or ref from which to create the generated pane branch. */
  startPointBranch?: string;
  branch?: string;
  /**
   * Attach to a worktree that already exists instead of creating one, so
   * several agents share a branch and files. The worktree is NOT created, and
   * critically is never rolled back on failure — other panes are using it.
   */
  existingWorktree?: { slug: string; worktreePath: string; branchName: string };
}

export interface BridgeSpawnPromptKeysRequest {
  paneId: string;
  prompt: string;
  agent: AgentName;
}

export interface BridgeSpawnDeps {
  tmuxSessionExists: (name: string) => boolean;
  createTmuxPane: (
    sessionName: string,
    cwd: string,
    title?: string,
    targetPaneId?: string,
  ) => string;
  sendTmuxCommand: (paneId: string, command: string) => void;
  /** Remove a pane whose config persistence failed after it was created. */
  killTmuxPane?: (paneId: string) => void;
  getFocusedTmuxPaneId?: (sessionName: string) => string | null;
  /**
   * Type a prompt into a send-keys agent's TUI after it starts.
   *
   * Optional so existing partial deps objects keep working — note that
   * __tests__ is outside tsconfig's `include`, so a required field here would
   * not be a compile error for callers in tests, just a runtime TypeError.
   */
  sendPromptKeys?: (request: BridgeSpawnPromptKeysRequest) => Promise<void>;
}

export interface BridgeSpawnResult {
  id: string;
  pane: PaneSummary;
  worktreePath: string;
  branch: string;
}

export interface BridgeError {
  code: string;
  message: string;
}

export interface CovenHealth {
  ok: boolean;
  apiVersion: string;
  supportedApiVersions: string[];
  capabilities: Record<string, unknown>;
  daemon?: Record<string, unknown> | null;
}

export interface CovenClient {
  health?: () => Promise<CovenHealth>;
  listSessions: () => Promise<CovenSessionSummary[]>;
  getSession?: (sessionId: string) => Promise<CovenSessionSummary>;
  launchSession?: (
    request: CovenSessionLaunchRequest & { projectRoot: string; cwd: string },
  ) => Promise<CovenSessionSummary>;
  listEvents?: (sessionId: string, options?: { afterSeq?: number; afterEventId?: string; since?: string }) => Promise<CovenSessionEvent[]>;
  sendInput?: (sessionId: string, data: string) => Promise<void>;
  killSession?: (sessionId: string) => Promise<void>;
}

export interface CovenClientOptions {
  baseUrl?: string;
  host?: string;
  port?: number;
  socketPath?: string;
  covenHome?: string;
}

export interface BridgeCovenOpenResult {
  id: string;
  pane: PaneSummary;
  session: CovenSessionSummary;
}

export interface ProjectCovenCapabilityRequest {
  taskId: string;
  traceId?: string;
  capability: string;
  provider?: string;
  prompt: string;
  title?: string;
  state?: Readonly<Record<string, unknown>>;
  attempt?: number;
  idempotencyKey?: string;
}

const LIVE_CAPABILITY_SESSION_STATUSES = new Set<CovenSessionSummary['status']>([
  'starting',
  'running',
  'waiting',
]);

interface RawConfigPane extends Record<string, unknown> {
  id?: string;
  paneId?: string;
  slug?: string;
  title?: string;
  displayName?: string;
  worktreePath?: string;
  worktreeDir?: string;
  cwd?: string;
  branch?: string;
  branchName?: string;
  agent?: string;
  agentStatus?: string;
  needsAttention?: boolean;
  lastUpdated?: string;
}

interface BridgeConfig extends Omit<Partial<PsycheConfig>, 'panes'> {
  panes?: RawConfigPane[];
}

interface BridgePanePlacement {
  config: BridgeConfig;
  panes: PsychePane[];
  controlPaneId: string;
  insertion: PaneInsertion;
}

export function isPathInsideOrEqual(parent: string, candidate: string): boolean {
  const rel = path.relative(parent, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

export async function resolveScopedCwd(projectRoot: string, cwd?: string): Promise<ScopeCheckResult> {
  const rootReal = await realpath(projectRoot);
  const requestedPath = cwd ? path.resolve(rootReal, cwd) : rootReal;
  let requestedReal: string;
  try {
    requestedReal = await realpath(requestedPath);
  } catch {
    throw new Error(`cwd does not exist inside the psyche project root`);
  }

  if (!isPathInsideOrEqual(rootReal, requestedReal)) {
    throw new Error(`cwd is outside the psyche project root`);
  }

  return { projectRoot: rootReal, requestedCwd: requestedReal };
}

export async function buildScopedProject(
  projectRoot: string,
  cwd?: string,
  options: { title?: string; autonomyProfile?: string } = {},
): Promise<ProjectSummary> {
  const scoped = await resolveScopedCwd(projectRoot, cwd);
  return {
    id: scoped.projectRoot,
    root: scoped.projectRoot,
    cwd: scoped.projectRoot,
    title: options.title || path.basename(scoped.projectRoot),
    autonomyProfile: options.autonomyProfile,
  };
}

export async function listScopedProjects(projectRoot: string): Promise<ProjectSummary[]> {
  return [await buildScopedProject(projectRoot)];
}

export async function listProjectCovenSessions(
  projectRoot: string,
  client: CovenClient,
): Promise<CovenSessionSummary[]> {
  const rootReal = await realpath(projectRoot);
  const sessions = await client.listSessions();
  const scopedSessions: CovenSessionSummary[] = [];

  for (const session of sessions) {
    try {
      const sessionRoot = await realpath(session.projectRoot);
      if (isPathInsideOrEqual(rootReal, sessionRoot)) {
        scopedSessions.push({ ...session, projectRoot: sessionRoot });
      }
    } catch {
      // Refuse to display sessions whose project root cannot be verified.
    }
  }

  return scopedSessions;
}

export async function launchProjectCovenSession(
  projectRoot: string,
  request: Partial<CovenSessionLaunchRequest> | undefined,
  client: CovenClient = createCovenClient(),
): Promise<CovenSessionSummary> {
  if (!client.launchSession) {
    throw bridgeError('coven_launch_unsupported', 'Coven client does not support launching sessions');
  }
  const harness = typeof request?.harness === 'string' ? request.harness.trim() : '';
  const prompt = typeof request?.prompt === 'string' ? request.prompt.trim() : '';
  const title = typeof request?.title === 'string' ? request.title.trim() : undefined;
  if (!harness) {
    throw bridgeError('invalid_coven_launch', 'Coven launch requires a harness');
  }
  if (!prompt) {
    throw bridgeError('invalid_coven_launch', 'Coven launch requires a prompt');
  }

  const scoped = await resolveScopedCwd(
    projectRoot,
    typeof request?.cwd === 'string' ? request.cwd : undefined,
  );
  const session = await client.launchSession({
    harness,
    prompt,
    title: title || undefined,
    projectRoot: scoped.projectRoot,
    cwd: scoped.requestedCwd,
  });
  const sessionRoot = await realpath(session.projectRoot);
  if (!isPathInsideOrEqual(scoped.projectRoot, sessionRoot)) {
    throw bridgeError('coven_session_scope_violation', 'Coven launched a session outside this psyche project scope');
  }
  return { ...session, projectRoot: sessionRoot };
}

export async function routeProjectCovenSessionCapability(
  projectRoot: string,
  sessionId: string,
  request: ProjectCovenCapabilityRequest,
  router: AgenticCapabilityRouter,
  client: CovenClient = createCovenClient(),
): Promise<AgenticCapabilityExecution> {
  if (!client.getSession) {
    throw bridgeError(
      'coven_session_lookup_unsupported',
      'Coven client does not support fetching sessions',
    );
  }
  if (!isSafeCovenSessionId(sessionId)) {
    throw bridgeError('invalid_coven_session_id', 'Coven session id contains unsupported characters');
  }
  const capability = typeof request.capability === 'string' ? request.capability.trim() : '';
  const taskId = typeof request.taskId === 'string' ? request.taskId.trim() : '';
  const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : '';
  const provider = typeof request.provider === 'string' ? request.provider.trim() : undefined;
  if (!isAgenticCapability(capability)) {
    throw bridgeError('invalid_capability_route', `Unsupported agentic capability "${capability}"`);
  }
  if (!taskId) {
    throw bridgeError('invalid_capability_route', 'Capability route requires a taskId');
  }
  if (!prompt) {
    throw bridgeError('invalid_capability_route', 'Capability route requires a prompt');
  }
  if (provider !== undefined && provider !== 'coven-native' && provider !== 'psyche') {
    throw bridgeError('invalid_capability_route', `Unsupported capability provider "${provider}"`);
  }
  if (
    request.attempt !== undefined
    && (!Number.isInteger(request.attempt) || request.attempt < 1)
  ) {
    throw bridgeError('invalid_capability_route', 'Capability route attempt must be a positive integer');
  }

  const rootReal = await realpath(projectRoot);
  const session = await client.getSession(sessionId);
  const sessionRoot = await realpath(session.projectRoot);
  if (!isPathInsideOrEqual(rootReal, sessionRoot)) {
    throw bridgeError(
      'coven_session_scope_violation',
      'Coven session is outside this psyche project scope',
    );
  }
  if (!LIVE_CAPABILITY_SESSION_STATUSES.has(session.status)) {
    throw bridgeError(
      'coven_session_not_live',
      `Coven session "${session.id}" is not live`,
    );
  }
  const scoped = await resolveScopedCwd(
    sessionRoot,
    typeof session.cwd === 'string' ? session.cwd : undefined,
  );

  return router.execute({
    taskId,
    traceId: typeof request.traceId === 'string' && request.traceId.trim()
      ? request.traceId.trim()
      : undefined,
    capability,
    provider: provider as CapabilityProviderId | undefined,
    input: {
      prompt,
      harness: session.harness,
      title: typeof request.title === 'string' && request.title.trim()
        ? request.title.trim()
        : undefined,
      state: request.state,
    },
    context: {
      sessionId: session.id,
      projectRoot: scoped.projectRoot,
      cwd: scoped.requestedCwd,
      attempt: request.attempt,
      idempotencyKey: typeof request.idempotencyKey === 'string' && request.idempotencyKey.trim()
        ? request.idempotencyKey.trim()
        : undefined,
    },
  });
}

export async function openProjectCovenSession(
  projectRoot: string,
  sessionName: string,
  sessionId: string,
  client: CovenClient = createCovenClient(),
  deps: BridgeSpawnDeps = defaultSpawnDeps,
): Promise<BridgeCovenOpenResult> {
  if (!isSafeCovenSessionId(sessionId)) {
    throw bridgeError('invalid_coven_session_id', 'Coven session id contains unsupported characters');
  }
  const scopedSessions = await listProjectCovenSessions(projectRoot, client);
  const session = scopedSessions.find((candidate) => candidate.id === sessionId);
  if (!session) {
    throw bridgeError('coven_session_not_found', 'Coven session is not in this psyche project scope');
  }
  if (!deps.tmuxSessionExists(sessionName)) {
    throw bridgeError('tmux_session_missing', 'psyche tmux session is not running; start psyche for this project first');
  }

  const title = `coven:${session.title || session.id.slice(0, 8)}`;
  const placement = await captureBridgePanePlacement(projectRoot, sessionName, deps);
  const paneId = deps.createTmuxPane(
    sessionName,
    session.projectRoot,
    title,
    placement?.insertion.targetTmuxPaneId,
  );

  const now = new Date().toISOString();
  const makePane = (config: BridgeConfig): RawConfigPane => ({
    id: nextBridgePaneId(),
    slug: uniqueCovenPaneSlug(config, session),
    title,
    displayName: title,
    prompt: '',
    paneId,
    cwd: session.projectRoot,
    projectRoot,
    projectName: path.basename(projectRoot),
    type: 'shell',
    shellType: 'coven',
    covenSession: {
      id: session.id,
      harness: session.harness,
      status: session.status,
      projectRoot: session.projectRoot,
    },
    lastUpdated: now,
  });
  let pane: RawConfigPane;
  try {
    pane = placement
      ? makePane(placement.config)
      : await mutateBridgeConfig(projectRoot, (config) => {
        const record = makePane(config);
        config.projectName = config.projectName || path.basename(projectRoot);
        config.projectRoot = projectRoot;
        config.settings = config.settings || {};
        config.panes = [...(Array.isArray(config.panes) ? config.panes : []), record];
        config.lastUpdated = now;
        return record;
      });
    if (placement) {
      await insertPaneIntoStoredLayout({
        panesFile: bridgeConfigPath(projectRoot),
        panes: placement.panes,
        pane: rawPaneForLayout(pane),
        controlPaneId: placement.controlPaneId,
        insertion: placement.insertion,
        sidebarWidth: placement.config.controlPaneSize,
        resolveSidebarWidthFromConfig: true,
      });
    }
  } catch (error) {
    cleanupSpawnedTmuxPane(paneId, deps);
    throw error;
  }
  deps.sendTmuxCommand(paneId, buildCovenAttachCommand(session.id));

  return {
    id: paneId,
    pane: rawPaneToSummary(pane, projectRoot),
    session,
  };
}

export function buildCovenAttachCommand(sessionId: string): string {
  if (!isSafeCovenSessionId(sessionId)) {
    throw bridgeError('invalid_coven_session_id', 'Coven session id contains unsupported characters');
  }
  return `coven attach ${sessionId}`;
}

function isSafeCovenSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9._:-]+$/.test(sessionId);
}

function uniqueCovenPaneSlug(config: BridgeConfig, session: CovenSessionSummary): string {
  const base = `coven-${session.id.slice(0, 8)}`;
  const panes = Array.isArray(config.panes) ? config.panes : [];
  const existing = new Set(panes.map((pane) => String(pane.slug ?? '')));
  for (let i = 0; i < 100; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    if (!existing.has(slug)) return slug;
  }
  return `${base}-${Date.now()}`;
}

export function createCovenClient(options: string | CovenClientOptions = {}): CovenClient {
  const endpoint = resolveCovenEndpoint(options);
  let healthPromise: Promise<CovenHealth> | null = null;

  const health = async (): Promise<CovenHealth> => {
    const raw = await requestCovenApi(endpoint, 'GET', '/api/v1/health');
    return normalizeCovenHealth(raw);
  };

  const ensureHealth = async (): Promise<void> => {
    healthPromise ??= health();
    try {
      const result = await healthPromise;
      const supportsV1 = result.apiVersion === 'coven.daemon.v1'
        || result.apiVersion === 'v1'
        || result.supportedApiVersions.includes('v1')
        || result.supportedApiVersions.includes('coven.daemon.v1');
      if (!supportsV1) {
        throw bridgeError('unsupported_coven_api_version', 'unsupported API version');
      }
    } catch (error) {
      healthPromise = null;
      throw error;
    }
  };

  const request = async (method: string, requestPath: string, body?: unknown): Promise<unknown> => {
    await ensureHealth();
    return requestCovenApi(endpoint, method, versionedCovenPath(requestPath), body);
  };

  return {
    health,
    async listSessions() {
      const raw = await request('GET', '/sessions');
      return Array.isArray(raw) ? raw.map(normalizeCovenSession) : [];
    },
    async getSession(sessionId: string) {
      const raw = await request('GET', `/sessions/${encodeURIComponent(sessionId)}`);
      return normalizeCovenSession(raw);
    },
    async launchSession(launchRequest) {
      const raw = await request('POST', '/sessions', launchRequest);
      return normalizeCovenSession(raw);
    },
    async listEvents(sessionId: string, options?: { afterSeq?: number; afterEventId?: string; since?: string }) {
      const params = new URLSearchParams({ sessionId });
      if (typeof options?.afterSeq === 'number' && Number.isFinite(options.afterSeq)) {
        params.set('afterSeq', String(Math.trunc(options.afterSeq)));
      } else if (options?.afterEventId) {
        params.set('afterEventId', options.afterEventId);
      } else if (options?.since) {
        params.set('since', options.since);
      }
      const raw = await request('GET', `/events?${params.toString()}`);
      if (Array.isArray(raw)) return raw.map(normalizeCovenEvent);
      if (raw && typeof raw === 'object' && Array.isArray((raw as { events?: unknown }).events)) {
        return ((raw as { events: unknown[] }).events).map(normalizeCovenEvent);
      }
      return [];
    },
    async sendInput(sessionId: string, data: string) {
      await request('POST', `/sessions/${encodeURIComponent(sessionId)}/input`, { data });
    },
    async killSession(sessionId: string) {
      await request('POST', `/sessions/${encodeURIComponent(sessionId)}/kill`);
    },
  };
}

export function resolveCovenEndpoint(options: string | CovenClientOptions): { baseUrl?: string; socketPath?: string } {
  if (typeof options === 'string') {
    return { socketPath: path.join(options, 'coven.sock') };
  }

  if (options.socketPath) return { socketPath: options.socketPath };
  if (options.covenHome) return { socketPath: path.join(options.covenHome, 'coven.sock') };
  if (process.env.COVEN_SOCKET) return { socketPath: process.env.COVEN_SOCKET };
  if (process.env.COVEN_HOME && !process.env.COVEN_PORT && !process.env.COVEN_URL) {
    return { socketPath: path.join(process.env.COVEN_HOME, 'coven.sock') };
  }

  if (!options.baseUrl && !options.host && !options.port && !process.env.COVEN_URL && !process.env.COVEN_PORT) {
    return { socketPath: path.join(process.env.HOME || homedir(), '.coven', 'coven.sock') };
  }

  const baseUrl = options.baseUrl
    || process.env.COVEN_URL
    || `http://${options.host || '127.0.0.1'}:${options.port || Number(process.env.COVEN_PORT || 7777)}`;
  return { baseUrl };
}

function versionedCovenPath(requestPath: string): string {
  if (requestPath.startsWith('/api/')) return requestPath;
  return `/api/v1${requestPath.startsWith('/') ? requestPath : `/${requestPath}`}`;
}

function requestCovenApi(endpoint: { baseUrl?: string; socketPath?: string }, method: string, requestPath: string, body?: unknown): Promise<unknown> {
  return endpoint.socketPath
    ? requestCovenApiSocket(endpoint.socketPath, method, requestPath, body)
    : requestCovenApiHttp(endpoint.baseUrl || 'http://127.0.0.1:7777', method, requestPath, body);
}

function requestCovenApiSocket(socketPath: string, method: string, requestPath: string, body?: unknown): Promise<unknown> {
  const bodyText = body === undefined ? '' : JSON.stringify(body);
  const request = [
    `${method} ${requestPath} HTTP/1.1`,
    'Host: coven',
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(bodyText)}`,
    'Connection: close',
    '',
    bodyText,
  ].join('\r\n');

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks: Buffer[] = [];
    socket.on('connect', () => socket.end(request));
    socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
        reject(bridgeError(
          'coven_daemon_unavailable',
          'Coven daemon is not running; start it with `coven daemon start`',
        ));
        return;
      }
      reject(error);
    });
    socket.on('end', () => {
      try {
        resolve(parseCovenHttpResponse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function requestCovenApiHttp(baseUrl: string, method: string, requestPath: string, body?: unknown): Promise<unknown> {
  const url = new URL(requestPath, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const bodyText = body === undefined ? '' : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyText),
      },
      timeout: 2_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        try {
          resolve(parseCovenPayload(Number(res.statusCode), Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(bridgeError('coven_api_timeout', 'Coven API timed out')));
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') {
        reject(bridgeError(
          'coven_daemon_unavailable',
          'Coven daemon is not running; start it with `coven daemon start`',
        ));
        return;
      }
      reject(error);
    });
    req.end(bodyText);
  });
}

function parseCovenHttpResponse(response: string): unknown {
  const [head, payload = ''] = response.split('\r\n\r\n');
  const status = Number(head.split(/\s+/)[1]);
  return parseCovenPayload(status, payload);
}

function parseCovenPayload(status: number, payload: string): unknown {
  if (!Number.isFinite(status) || status < 200 || status >= 300) {
    let message = `Coven API returned HTTP ${status || 'unknown'}`;
    let code = 'coven_api_failed';
    try {
      const parsed = payload.trim() ? JSON.parse(payload) : null;
      if (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') {
        message = (parsed as { error: string }).error;
      } else if (
        parsed
        && typeof parsed === 'object'
        && (parsed as { error?: unknown }).error
        && typeof (parsed as { error: { code?: unknown; message?: unknown } }).error === 'object'
      ) {
        const envelope = (parsed as { error: { code?: unknown; message?: unknown } }).error;
        code = typeof envelope.code === 'string' && envelope.code.trim()
          ? envelope.code.trim()
          : code;
        message = typeof envelope.message === 'string' && envelope.message.trim()
          ? envelope.message.trim()
          : message;
      }
    } catch {
      // Keep generic HTTP message.
    }
    throw bridgeError(code, message);
  }
  return payload.trim() ? JSON.parse(payload) : null;
}

function normalizeCovenHealth(raw: unknown): CovenHealth {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const supportedRaw = Array.isArray(record.supportedApiVersions)
    ? record.supportedApiVersions
    : Array.isArray(record.supported_api_versions)
      ? record.supported_api_versions
      : [];
  return {
    ok: record.ok === true,
    apiVersion: String(record.apiVersion ?? record.api_version ?? ''),
    supportedApiVersions: supportedRaw.map((value) => String(value)),
    capabilities: record.capabilities && typeof record.capabilities === 'object'
      ? record.capabilities as Record<string, unknown>
      : {},
    daemon: record.daemon && typeof record.daemon === 'object'
      ? record.daemon as Record<string, unknown>
      : record.daemon === null
        ? null
        : undefined,
  };
}

function normalizeCovenSession(raw: any): CovenSessionSummary {
  const archivedAt = typeof raw.archivedAt === 'string'
    ? raw.archivedAt
    : typeof raw.archived_at === 'string'
      ? raw.archived_at
      : undefined;

  return {
    id: String(raw.id),
    projectRoot: String(raw.projectRoot ?? raw.project_root),
    cwd: typeof raw.cwd === 'string' && raw.cwd.trim() ? raw.cwd.trim() : undefined,
    harness: String(raw.harness),
    title: String(raw.title),
    status: archivedAt ? 'archived' : (raw.status || 'created'),
    createdAt: String(raw.createdAt ?? raw.created_at),
    updatedAt: String(raw.updatedAt ?? raw.updated_at),
    archivedAt,
  };
}

function normalizeCovenEvent(raw: any): CovenSessionEvent {
  return {
    seq: typeof raw.seq === 'number' && Number.isFinite(raw.seq) ? raw.seq : undefined,
    id: String(raw.id),
    sessionId: String(raw.sessionId ?? raw.session_id),
    kind: String(raw.kind),
    payloadJson: String(raw.payloadJson ?? raw.payload_json),
    createdAt: String(raw.createdAt ?? raw.created_at),
  };
}

export function boundedLineCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CAPTURE_LINES;
  return Math.min(MAX_CAPTURE_LINES, Math.max(1, Math.trunc(value)));
}

export function tailTextLines(text: string, requestedLines: unknown): string {
  const lines = boundedLineCount(requestedLines);
  const normalized = text.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n');
  return parts.slice(-lines).join('\n');
}

export function capturePaneText(
  paneId: string,
  requestedLines: unknown,
  capture: (id: string) => Buffer,
): { id: string; text: string; lines: number } {
  const lines = boundedLineCount(requestedLines);
  const text = capture(paneId).toString('utf8');
  return { id: paneId, text: tailTextLines(text, lines), lines };
}

export async function resolveConfiguredPaneId(projectRoot: string, paneId: string): Promise<string> {
  const config = await readBridgeConfig(projectRoot);
  const pane = findRawPane(config, paneId);
  if (!pane) {
    throw bridgeError('pane_not_found', 'pane is not registered in this psyche project');
  }
  return String(pane.paneId ?? pane.id ?? paneId);
}

export async function readPaneStatus(
  projectRoot: string,
  paneId: string,
  exists: (id: string) => boolean | undefined = () => undefined,
): Promise<PaneStatusResult> {
  const config = await readBridgeConfig(projectRoot);
  const pane = findRawPane(config, paneId);
  if (!pane) {
    return { id: paneId, status: 'unknown' };
  }

  const tmuxPaneId = String(pane.paneId ?? pane.id ?? paneId);
  const existsValue = exists(tmuxPaneId);
  const summary = rawPaneToSummary(pane, projectRoot);

  return {
    id: tmuxPaneId,
    exists: existsValue,
    status: typeof pane.agentStatus === 'string' ? pane.agentStatus : 'unknown',
    pane: summary,
    metadata: {
      psycheId: typeof pane.id === 'string' ? pane.id : undefined,
      title: typeof pane.title === 'string' ? pane.title : typeof pane.displayName === 'string' ? pane.displayName : undefined,
      agent: typeof pane.agent === 'string' ? pane.agent : undefined,
      branch: typeof pane.branchName === 'string' ? pane.branchName : typeof pane.branch === 'string' ? pane.branch : undefined,
      cwd: String(pane.worktreePath ?? pane.worktreeDir ?? pane.cwd ?? projectRoot),
      needsAttention: typeof pane.needsAttention === 'boolean' ? pane.needsAttention : undefined,
      lastActivity: typeof pane.lastUpdated === 'string' ? pane.lastUpdated : undefined,
    },
  };
}

/**
 * Serializes worktree-name allocation across concurrent spawns.
 *
 * uniqueSlug and resolveSpawnBranch are check-then-act: they scan the
 * filesystem and git refs for a free name, but nothing reserves it until
 * `git worktree add` runs. Two lanes spawning at once therefore pick the SAME
 * slug, and the second worktree add dies with "already exists". That never
 * surfaced while fan-out lived only in the TUI, which created panes one at a
 * time; running lanes in parallel exposed it immediately.
 *
 * The critical section is allocation through creation — the step that actually
 * claims the name. Pane setup and agent launch stay outside it, so lanes still
 * overlap for the slow parts.
 */
let worktreeClaim: Promise<unknown> = Promise.resolve();

async function claimWorktree<T>(work: () => Promise<T>): Promise<T> {
  const previous = worktreeClaim;
  let release!: () => void;
  worktreeClaim = new Promise<void>((resolve) => { release = resolve; });
  // A failed claim must not wedge the queue, so predecessors are awaited for
  // ordering only.
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
  }
}

export async function mutateBridgeConfig<T>(
  projectRoot: string,
  mutate: (config: BridgeConfig) => T | Promise<T>,
): Promise<T> {
  const configPath = bridgeConfigPath(projectRoot);
  await mkdir(path.dirname(configPath), { recursive: true });
  return withPanesConfigFileWriteLock(configPath, async () => {
    const config = await readBridgeConfig(projectRoot);
    const result = await mutate(config);
    await writeBridgeConfig(projectRoot, config);
    return result;
  });
}

/**
 * Patch a pane's metadata in the project config.
 *
 * Goes through `mutateBridgeConfig` rather than doing its own
 * read-parse-write. That gives it three things it did not have: serialization
 * against concurrent spawns (an inline read-modify-write here dropped panes
 * that a spawn appended between the read and the write), an atomic write
 * (a plain `writeFile` truncates first, so a crash left a torn registry), and
 * a read that refuses to fall back to an empty config when the file exists but
 * cannot be parsed.
 *
 * Lives here (not in the daemon entrypoint) so the control handler can reach
 * it without importing `index.ts`, keeping pane.meta.update on the same
 * runtime-authority path as every other pane mutation.
 */
export async function updatePaneMeta(
  projectRoot: string,
  paneId: string,
  patch: { title?: string; agent?: string },
): Promise<void> {
  await mutateBridgeConfig(projectRoot, (config) => {
    const panes = Array.isArray(config.panes) ? config.panes : [];
    const pane = panes.find((p) => p.id === paneId || p.paneId === paneId);
    if (!pane) throw new Error(`pane ${paneId} not found`);
    if (patch.title !== undefined) pane.title = patch.title;
    if (patch.agent !== undefined) pane.agent = patch.agent;
    config.panes = panes;
  });
}

/**
 * Date.now() alone collides when several panes are created inside one
 * millisecond, which concurrent lanes do routinely.
 */
let paneIdCounter = 0;

function nextBridgePaneId(): string {
  paneIdCounter += 1;
  return `psyche-${Date.now()}-${paneIdCounter}`;
}

/**
 * Validate an existing worktree and allocate a sibling slug for a new pane in
 * it, so attached agents read as siblings (fix-auth-a2, fix-auth-a3) rather
 * than colliding on the original slug.
 *
 * Nothing is created here. The worktree must already be registered with git
 * and live inside the project, which is what stops an arbitrary path arriving
 * over the wire from being used.
 */
/**
 * Sibling slugs handed out but not yet written to config.
 *
 * The create path does not need this: createGitWorktree makes the directory
 * inside the claim mutex, so the next uniqueSlug scan sees it. Attaching
 * creates nothing on disk, so without an explicit reservation two concurrent
 * attaches to the same worktree both read the same config and both pick
 * fix-auth-a2.
 */
const reservedSiblingSlugs = new Set<string>();

export function releaseSiblingSlug(slug: string): void {
  reservedSiblingSlugs.delete(slug);
}

async function resolveSharedWorktree(
  projectRoot: string,
  existing: { slug: string; worktreePath: string; branchName: string },
): Promise<{ slug: string; branch: string; worktreePath: string }> {
  let resolved: string;
  try {
    resolved = await realpath(existing.worktreePath);
  } catch {
    throw bridgeError('invalid_worktree_path', 'existing worktree path does not exist');
  }

  if (!isPathInsideOrEqual(projectRoot, resolved)) {
    throw bridgeError(
      'invalid_worktree_path',
      'existing worktree is outside the psyche project root',
    );
  }

  if (!listGitWorktreePaths(projectRoot).has(resolved)) {
    throw bridgeError(
      'invalid_worktree_path',
      'path is not a registered git worktree of this project',
    );
  }

  // Read the branch from the worktree rather than trusting the request. A
  // caller reaching spawnBridgePane directly could otherwise persist a
  // branchName that has nothing to do with what is checked out, and every
  // later report and merge decision would inherit that lie.
  const branch = readWorktreeBranch(resolved) ?? existing.branchName;

  // Allocate under the same mutex the create path uses, and consult the
  // in-flight reservations as well as config, so concurrent attaches to one
  // worktree cannot land on the same sibling slug.
  return claimWorktree(async () => {
    const config = await readBridgeConfig(projectRoot);
    const panes = Array.isArray(config.panes) ? config.panes : [];
    const taken = [
      ...panes.map((pane) => ({ slug: String(pane.slug ?? '') })),
      ...[...reservedSiblingSlugs].map((slug) => ({ slug })),
    ];
    const slug = generateSiblingSlugForTargetPane(
      { slug: existing.slug, worktreePath: resolved },
      taken,
    );
    reservedSiblingSlugs.add(slug);
    return { slug, branch, worktreePath: resolved };
  });
}

/** Branch actually checked out in a worktree, or null if detached/unreadable. */
function readWorktreeBranch(worktreePath: string): string | null {
  try {
    const name = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    return name && name !== 'HEAD' ? name : null;
  } catch {
    return null;
  }
}

/** Canonical paths of every worktree git knows about for this project. */
function listGitWorktreePaths(projectRoot: string): Set<string> {
  const out = new Set<string>();
  try {
    const raw = execFileSync('git', ['-C', projectRoot, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
    });
    for (const line of raw.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      try {
        out.add(realpathSync(line.slice('worktree '.length).trim()));
      } catch {
        // Pruned or inaccessible — not a valid attach target anyway.
      }
    }
  } catch {
    // Not a git repo, or git unavailable; the containment check still applies.
  }
  return out;
}

export async function spawnBridgePane(
  projectRoot: string,
  sessionName: string,
  request: BridgeSpawnRequest,
  deps: BridgeSpawnDeps = defaultSpawnDeps,
): Promise<BridgeSpawnResult> {
  const scoped = await resolveScopedCwd(
    projectRoot,
    typeof request?.cwd === 'string' ? request.cwd : undefined,
  );
  if (!deps.tmuxSessionExists(sessionName)) {
    throw bridgeError('tmux_session_missing', 'psyche tmux session is not running; start psyche for this project first');
  }

  const agent = normalizeAgent(request.agent);
  const attaching = request.existingWorktree !== undefined;
  const { slug, branch, worktreePath } = attaching
    ? await resolveSharedWorktree(scoped.projectRoot, request.existingWorktree!)
    : await claimWorktree(async () => {
    const nextSlug = await uniqueSlug(scoped.projectRoot, slugFromRequest(request));
    const nextBranch = await resolveSpawnBranch(scoped.projectRoot, request.branch, nextSlug);
    const worktreesRoot = await ensureGeneratedWorktreesRoot(scoped.projectRoot);
    const nextWorktreePath = path.join(worktreesRoot, nextSlug);
    assertGeneratedWorktreePath(scoped.projectRoot, nextWorktreePath);

    createGitWorktree(
      scoped.projectRoot,
      nextWorktreePath,
      nextBranch,
      request.startPointBranch,
    );
    return { slug: nextSlug, branch: nextBranch, worktreePath: nextWorktreePath };
  });

  // Everything past the claim can fail — tmux can refuse to split, the config
  // write can fail. A worktree already exists by then, so a failed lane would
  // otherwise leak one plus its branch. Roll them back rather than leaving
  // orphans behind for the user to find later.
  try {
    return await finishSpawn();
  } catch (error) {
    // Only ever roll back a worktree THIS call created. A shared worktree is
    // in use by other panes; deleting it here would destroy their work.
    if (attaching) {
      releaseSiblingSlug(slug);
    } else {
      removeGitWorktree(scoped.projectRoot, worktreePath, branch);
    }
    throw error;
  }

  async function finishSpawn(): Promise<BridgeSpawnResult> {
  const title = request.title || slug;
  const placement = await captureBridgePanePlacement(scoped.projectRoot, sessionName, deps);
  const paneId = deps.createTmuxPane(
    sessionName,
    worktreePath,
    title,
    placement?.insertion.targetTmuxPaneId,
  );
  const now = new Date().toISOString();
  const pane: RawConfigPane = {
    id: nextBridgePaneId(),
    slug,
    title,
    displayName: title,
    prompt: request.prompt || '',
    paneId,
    projectRoot: scoped.projectRoot,
    projectName: path.basename(scoped.projectRoot),
    type: 'worktree',
    worktreePath,
    branchName: branch,
    branch,
    agent,
    agentStatus: agent ? 'working' : 'idle',
    lastUpdated: now,
  };
  let settings: PsycheConfig['settings'] | undefined;
  try {
    settings = placement
      ? placement.config.settings
      : await mutateBridgeConfig(scoped.projectRoot, (config) => {
        config.projectName = config.projectName || path.basename(scoped.projectRoot);
        config.projectRoot = scoped.projectRoot;
        config.settings = config.settings || {};
        config.panes = [...(Array.isArray(config.panes) ? config.panes : []), pane];
        config.lastUpdated = now;
        return config.settings;
      });
    if (placement) {
      await insertPaneIntoStoredLayout({
        panesFile: bridgeConfigPath(scoped.projectRoot),
        panes: placement.panes,
        pane: rawPaneForLayout(pane),
        controlPaneId: placement.controlPaneId,
        insertion: placement.insertion,
        sidebarWidth: placement.config.controlPaneSize,
        resolveSidebarWidthFromConfig: true,
      });
    }
  } catch (error) {
    cleanupSpawnedTmuxPane(paneId, deps);
    throw error;
  }
  // Persisted, so the slug is now discoverable from config itself.
  if (attaching) releaseSiblingSlug(slug);

  if (agent) {
    const launchCommand = await buildLaunchCommand(scoped.projectRoot, slug, agent, request.prompt, settings?.permissionMode);
    deps.sendTmuxCommand(paneId, launchCommand);

    // send-keys agents were launched bare above; type the prompt into their
    // TUI once it is up. Without this the prompt is silently dropped.
    const prompt = request.prompt;
    if (prompt && prompt.trim() && getPromptTransport(agent) === 'send-keys') {
      const sendPromptKeys = deps.sendPromptKeys ?? sendPromptKeysToPane;
      await sendPromptKeys({ paneId, prompt, agent });
    }
  }

  return {
    id: paneId,
    pane: rawPaneToSummary(pane, scoped.projectRoot),
    worktreePath,
    branch,
  };
  }
}

/**
 * Best-effort rollback of a worktree this spawn just created.
 *
 * Only ever called for a worktree allocated moments earlier in the same call,
 * so there is no user work to lose. Failures are swallowed: the caller is
 * already reporting a lane failure, and a cleanup error must not replace the
 * real one.
 */
function removeGitWorktree(projectRoot: string, worktreePath: string, branch: string): void {
  try {
    execFileSync('git', ['-C', projectRoot, 'worktree', 'remove', '--force', worktreePath], {
      stdio: 'ignore',
    });
  } catch {
    // Already gone, or never fully created.
  }
  try {
    execFileSync('git', ['-C', projectRoot, 'branch', '-D', branch], { stdio: 'ignore' });
  } catch {
    // Branch may not exist if the worktree add itself failed.
  }
}

export interface BridgeKillDeps {
  tmuxPaneExists: (paneId: string) => boolean | undefined;
  killTmuxPane: (paneId: string) => void;
}

export interface BridgeKillResult {
  id: string;
  paneId: string;
  /** True when a live tmux pane was actually killed. */
  killed: boolean;
  /** Left on disk deliberately — see the note on killBridgePane. */
  worktreePath?: string;
  branch?: string;
}

export const defaultKillDeps: BridgeKillDeps = {
  tmuxPaneExists,
  killTmuxPane,
};

/**
 * Terminate a pane registered in this project and remove its config record and
 * persistent layout leaf.
 *
 * Deliberately NON-destructive to git state: the worktree and branch are left
 * exactly as they are, and are returned so the caller can report what remains.
 * Deleting them is a separate, explicit act — the TUI's close/merge flows ask
 * first, because a worktree can hold uncommitted work and a branch can be the
 * only reference to it. An MCP client killing a pane must not be able to
 * destroy work as a side effect.
 *
 * Killing a pane whose tmux pane is already gone is not an error; the config
 * record is still removed so the project stops advertising a dead pane.
 */
export async function killBridgePane(
  projectRoot: string,
  paneId: string,
  deps: BridgeKillDeps = defaultKillDeps,
): Promise<BridgeKillResult> {
  const scoped = await resolveScopedCwd(projectRoot);
  const config = await readBridgeConfig(scoped.projectRoot);
  const found = findRawPane(config, paneId);
  if (!found) {
    throw bridgeError('pane_not_found', 'pane is not registered in this psyche project');
  }

  const tmuxPaneId = String(found.paneId ?? found.id ?? paneId);
  const psychePaneId = String(found.id ?? tmuxPaneId);
  const pane = found;

  let killed = false;
  if (deps.tmuxPaneExists(tmuxPaneId) !== false) {
    try {
      deps.killTmuxPane(tmuxPaneId);
      killed = true;
    } catch (error) {
      throw bridgeError(
        'pane_kill_failed',
        `failed to kill tmux pane: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (typeof config.controlPaneId === 'string' && config.controlPaneId) {
    await removePaneFromStoredLayout({
      panesFile: bridgeConfigPath(scoped.projectRoot),
      paneId: psychePaneId,
      controlPaneId: config.controlPaneId,
      sidebarWidth: config.controlPaneSize,
      resolveSidebarWidthFromConfig: true,
    });
  } else {
    // Legacy configs without a control pane have no persistent layout to
    // reconcile, but still need their record removed under the mutation lock.
    await mutateBridgeConfig(scoped.projectRoot, (current) => {
      const panes = Array.isArray(current.panes) ? current.panes : [];
      current.panes = panes.filter(
        (candidate) => candidate.id !== pane.id && candidate.paneId !== pane.paneId,
      );
      current.lastUpdated = new Date().toISOString();
    });
  }

  return {
    id: psychePaneId,
    paneId: tmuxPaneId,
    killed,
    worktreePath: typeof pane.worktreePath === 'string' ? pane.worktreePath : undefined,
    branch: typeof pane.branchName === 'string'
      ? pane.branchName
      : typeof pane.branch === 'string' ? pane.branch : undefined,
  };
}

export function killTmuxPane(paneId: string): void {
  execFileSync('tmux', ['kill-pane', '-t', paneId], { stdio: 'ignore' });
}

function cleanupSpawnedTmuxPane(paneId: string, deps: BridgeSpawnDeps): void {
  try {
    (deps.killTmuxPane ?? killTmuxPane)(paneId);
  } catch {
    // The persistence failure remains the actionable error if pane cleanup
    // also fails.
  }
}

export function tmuxPaneExists(paneId: string): boolean | undefined {
  try {
    execFileSync('tmux', ['display-message', '-p', '-t', paneId, '#{pane_id}'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function createTmuxPane(
  sessionName: string,
  cwd: string,
  title?: string,
  targetPaneId?: string,
): string {
  const paneId = execFileSync('tmux', [
    'split-window',
    '-d',
    '-P',
    '-F',
    '#{pane_id}',
    '-t',
    targetPaneId || sessionName,
    '-c',
    cwd,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  if (title) {
    try {
      execFileSync('tmux', ['select-pane', '-t', paneId, '-T', title], { stdio: 'ignore' });
    } catch {
      // Title is cosmetic; the pane id is still usable.
    }
  }

  return paneId;
}

export function sendTmuxCommand(paneId: string, command: string): void {
  execFileSync('tmux', ['send-keys', '-t', paneId, command, 'C-m'], { stdio: 'ignore' });
}

export async function sendPromptKeysToPane(
  request: BridgeSpawnPromptKeysRequest,
): Promise<void> {
  const { paneId, prompt, agent } = request;
  const tmuxService = TmuxService.getInstance();
  let baselineCommand: string | undefined;
  try {
    baselineCommand = await tmuxService.getPaneCurrentCommand(paneId);
  } catch {
    baselineCommand = undefined;
  }

  await sendPromptViaTmux({
    paneId,
    prompt,
    tmuxService,
    expectedCommand: getAgentProcessName(agent),
    baselineCommand,
    prePromptKeys: getSendKeysPrePrompt(agent),
    submitKeys: getSendKeysSubmit(agent),
    postPasteDelayMs: getSendKeysPostPasteDelayMs(agent),
    readyDelayMs: getSendKeysReadyDelayMs(agent),
  });
}

export const defaultSpawnDeps: BridgeSpawnDeps = {
  sendPromptKeys: sendPromptKeysToPane,
  tmuxSessionExists: (name) => {
    try {
      execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },
  getFocusedTmuxPaneId: (sessionName) => {
    try {
      return execFileSync(
        'tmux',
        ['display-message', '-p', '-t', sessionName, '#{pane_id}'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ).trim() || null;
    } catch {
      return null;
    }
  },
  createTmuxPane,
  killTmuxPane,
  sendTmuxCommand,
};

function configPanesForLayout(config: BridgeConfig): PsychePane[] {
  return (Array.isArray(config.panes) ? config.panes : []).flatMap((pane) => {
    if (typeof pane.id !== 'string' || typeof pane.paneId !== 'string') {
      return [];
    }
    return [rawPaneForLayout(pane)];
  });
}

function rawPaneForLayout(pane: RawConfigPane): PsychePane {
  return pane as unknown as PsychePane;
}

/**
 * Captures the physical split target before creating a daemon-owned pane.
 *
 * Configurations without a sidebar control pane predate persistent layouts;
 * keep their legacy append behavior because there is no layout to project.
 */
async function captureBridgePanePlacement(
  projectRoot: string,
  sessionName: string,
  deps: BridgeSpawnDeps,
): Promise<BridgePanePlacement | undefined> {
  const config = await readBridgeConfig(projectRoot);
  if (typeof config.controlPaneId !== 'string' || !config.controlPaneId) {
    return undefined;
  }

  const panes = configPanesForLayout(config);
  if (!panes.some((pane) => !pane.hidden)) {
    return undefined;
  }

  const insertion = await capturePaneInsertion({
    panesFile: bridgeConfigPath(projectRoot),
    panes,
    focusedTmuxPaneId: deps.getFocusedTmuxPaneId?.(sessionName) ?? undefined,
  });
  if (!insertion) {
    throw bridgeError('pane_layout_target_missing', 'pane layout has no visible insertion target');
  }

  return {
    config,
    panes,
    controlPaneId: config.controlPaneId,
    insertion,
  };
}

/**
 * Read the project config, or synthesize an empty one if there is none yet.
 *
 * The "or" matters: this used to swallow *every* failure and hand back a
 * config with `panes: []`. Callers in the mutate path then wrote that back,
 * so a single unreadable or half-written config — EACCES, a torn write, a
 * stray editor save — silently erased every pane record, worktree pointer and
 * branch name the project had. Only ENOENT is a legitimately empty project;
 * anything else propagates so the caller fails loudly and the file on disk is
 * left alone for the user to recover.
 */
async function readBridgeConfig(projectRoot: string): Promise<BridgeConfig> {
  const configPath = bridgeConfigPath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw bridgeError(
        'config_unreadable',
        `could not read ${configPath}: ${bridgeErrorMessage(error)}`,
      );
    }
    return {
      projectName: path.basename(projectRoot),
      projectRoot,
      panes: [],
      settings: {},
      lastUpdated: new Date().toISOString(),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw bridgeError(
      'config_corrupt',
      `${configPath} is not valid JSON and will not be overwritten: ${bridgeErrorMessage(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw bridgeError('config_corrupt', `${configPath} is not a JSON object`);
  }
  return parsed as BridgeConfig;
}

/**
 * Write the project config atomically.
 *
 * A plain `writeFile` truncates first, so a crash — or a reader arriving
 * mid-write — sees a half-written file. Since the config *is* the pane
 * registry, that is data loss, not a transient glitch. Write-then-rename
 * means a reader observes either the old file or the new one.
 */
async function writeBridgeConfig(projectRoot: string, config: BridgeConfig): Promise<void> {
  const configPath = bridgeConfigPath(projectRoot);
  await mkdir(path.dirname(configPath), { recursive: true });
  await atomicWriteJson(configPath, config);
}

function bridgeConfigPath(projectRoot: string): string {
  return path.join(projectRoot, '.psyche', 'psyche.config.json');
}

function findRawPane(config: BridgeConfig, paneId: string): RawConfigPane | undefined {
  const panes = Array.isArray(config.panes) ? config.panes : [];
  return panes.find((pane) => pane.id === paneId || pane.paneId === paneId);
}

function rawPaneToSummary(pane: RawConfigPane, projectRoot: string): PaneSummary {
  const tmuxId = String(pane.paneId ?? pane.id ?? '');
  const title =
    typeof pane.title === 'string' ? pane.title :
    typeof pane.displayName === 'string' ? pane.displayName :
    typeof pane.slug === 'string' ? pane.slug :
    typeof pane.id === 'string' ? pane.id : undefined;

  return {
    id: tmuxId,
    cwd: String(pane.worktreePath ?? pane.worktreeDir ?? pane.cwd ?? projectRoot),
    branch: typeof pane.branchName === 'string' ? pane.branchName : typeof pane.branch === 'string' ? pane.branch : undefined,
    agent: typeof pane.agent === 'string' ? pane.agent : undefined,
    title,
    lastActivity: typeof pane.lastUpdated === 'string' ? pane.lastUpdated : undefined,
  };
}

function normalizeAgent(agent: string | undefined): AgentName | undefined {
  if (!agent) return undefined;
  if ((AGENT_IDS as readonly string[]).includes(agent)) return agent as AgentName;
  throw bridgeError('invalid_agent', `unsupported agent: ${agent}`);
}

function slugFromRequest(request: BridgeSpawnRequest): string {
  const source = request.title || request.branch || request.prompt || request.requestId || 'bridge-pane';
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/[/.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'bridge-pane';
}

async function uniqueSlug(projectRoot: string, baseSlug: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const slug = i === 0 ? baseSlug : `${baseSlug}-${i + 1}`;
    const worktreePath = path.join(projectRoot, '.psyche', 'worktrees', slug);
    try {
      await realpath(worktreePath);
    } catch {
      return slug;
    }
  }
  throw bridgeError('slug_exhausted', 'could not allocate a unique psyche worktree slug');
}

async function resolveSpawnBranch(projectRoot: string, requestedBranch: string | undefined, slug: string): Promise<string> {
  const base = requestedBranch || `psyche/${slug}`;
  if (!isValidBridgeBranchName(base)) {
    throw bridgeError('invalid_branch', 'branch must be a safe local git branch name');
  }

  if (requestedBranch) return base;

  for (let i = 0; i < 100; i++) {
    const branch = i === 0 ? base : `${base}-${i + 1}`;
    if (!gitBranchExists(projectRoot, branch)) return branch;
  }
  throw bridgeError('branch_exhausted', 'could not allocate a unique psyche branch');
}

function createGitWorktree(
  projectRoot: string,
  worktreePath: string,
  branch: string,
  startPointBranch?: string,
): void {
  assertGeneratedWorktreePath(projectRoot, worktreePath);
  try {
    execFileSync('git', ['-C', projectRoot, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
    execFileSync('git', ['-C', projectRoot, 'worktree', 'prune'], { stdio: 'ignore' });
    if (gitBranchExists(projectRoot, branch)) {
      execFileSync('git', ['-C', projectRoot, 'worktree', 'add', worktreePath, branch], { stdio: 'pipe' });
    } else {
      const args = ['-C', projectRoot, 'worktree', 'add', worktreePath, '-b', branch];
      if (startPointBranch) args.push(startPointBranch);
      execFileSync('git', args, { stdio: 'pipe' });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw bridgeError('worktree_create_failed', `failed to create scoped worktree: ${message}`);
  }
}

function gitBranchExists(projectRoot: string, branch: string): boolean {
  try {
    execFileSync('git', ['-C', projectRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isValidBridgeBranchName(branch: string): boolean {
  if (!branch || branch.includes('..') || branch.startsWith('/') || branch.endsWith('/') || branch.includes(' ')) {
    return false;
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) return false;
  try {
    execFileSync('git', ['check-ref-format', '--branch', branch], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function ensureGeneratedWorktreesRoot(projectRoot: string): Promise<string> {
  const worktreesRoot = path.join(projectRoot, '.psyche', 'worktrees');
  await mkdir(worktreesRoot, { recursive: true });
  const rootReal = await realpath(projectRoot);
  const worktreesReal = await realpath(worktreesRoot);
  if (!isPathInsideOrEqual(rootReal, worktreesReal)) {
    throw bridgeError('invalid_worktree_path', 'project .psyche/worktrees resolves outside the daemon project root');
  }
  return worktreesRoot;
}

function assertGeneratedWorktreePath(projectRoot: string, worktreePath: string): void {
  const worktreesRoot = path.join(projectRoot, '.psyche', 'worktrees');
  if (!isPathInsideOrEqual(worktreesRoot, worktreePath) || worktreePath === worktreesRoot) {
    throw bridgeError('invalid_worktree_path', 'generated worktree path escaped the project .psyche/worktrees directory');
  }
}

async function buildLaunchCommand(
  projectRoot: string,
  slug: string,
  agent: AgentName,
  prompt: string | undefined,
  permissionMode: PsycheConfig['settings']['permissionMode'],
): Promise<string> {
  // send-keys agents take no prompt on the command line — it is typed into
  // their TUI after launch. Writing a prompt file here would read it into a
  // variable, delete the file, and then run a bare command, destroying the
  // prompt with no trace.
  if (!prompt || !prompt.trim() || getPromptTransport(agent) === 'send-keys') {
    return buildAgentCommand(agent, permissionMode);
  }

  const promptFile = await writePromptFile(projectRoot, slug, prompt);
  return `${buildPromptReadAndDeleteSnippet(promptFile)}; ${buildInitialPromptCommand(
    agent,
    '"$PSYCHE_PROMPT_CONTENT"',
    permissionMode,
  )}`;
}

function bridgeError(code: string, message: string): Error & BridgeError {
  const error = new Error(message) as Error & BridgeError;
  error.code = code;
  error.message = message;
  return error;
}

export function bridgeErrorCode(error: unknown, fallback: string): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : fallback;
}

export function bridgeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
