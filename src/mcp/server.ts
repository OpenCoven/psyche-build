/**
 * psyche MCP server (stdio JSON-RPC 2.0).
 *
 * Exposes psyche's pane/ritual/worktree surface to MCP-capable clients
 * (coven-code, Claude Code, OpenCode, etc.) so any familiar can fan work
 * into parallel psyche panes mid-conversation without leaving its session.
 *
 * Wire-up on the client side (e.g. ~/.coven-code/settings.json):
 *
 *   {
 *     "mcp_servers": [
 *       { "name": "psyche", "command": "psyche", "args": ["mcp"], "type": "stdio" }
 *     ]
 *   }
 *
 * Protocol: a minimal JSON-RPC 2.0 implementation of the MCP `initialize`,
 * `tools/list`, and `tools/call` methods. We intentionally hand-roll instead
 * of pulling in `@modelcontextprotocol/sdk` so this first ship has zero new
 * runtime dependencies — easy to revisit if the surface grows.
 *
 * Reuses psyche's existing pane primitives from `../daemon/panes.ts` so the
 * MCP path and the Ink TUI path share state and don't fork.
 */

import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { capturePaneSync, listPanes } from '../daemon/panes.js';
import type { PaneSummary } from '../daemon/protocol.js';
import { getBuiltInRituals, listProjectRituals } from '../utils/rituals.js';
import {
  killBridgePane,
  spawnBridgePane,
  type BridgeKillResult,
  type BridgeSpawnRequest,
  type BridgeSpawnResult,
} from '../daemon/bridge.js';
import { tmuxSessionNameForRoot } from '../services/bridge/tmuxControl.js';
import { Orchestrator } from '../orchestration/orchestrator.js';
import { createBridgePaneBackend } from '../orchestration/bridgePaneBackend.js';
import {
  composeLaneBackends,
  createCovenSessionBackend,
} from '../orchestration/covenSessionBackend.js';
import {
  ORCHESTRATION_LANE_MODES,
  type OrchestrationTaskRequest,
  type OrchestrationTaskResult,
} from '../orchestration/types.js';

const PROTOCOL_VERSION = '2025-06-18';
export const SERVER_NAME = 'psyche';
const SERVER_VERSION = '0.0.1';

// ---- JSON-RPC plumbing ----------------------------------------------------

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess<T = unknown> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: T;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;

function writeResponse(res: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(res) + '\n');
}

function fail(id: JsonRpcId, code: number, message: string, data?: unknown): void {
  writeResponse({ jsonrpc: '2.0', id, error: { code, message, data } });
}

// ---- Tool registry --------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Side-effecting collaborators, injectable so tools/call can be tested without
 * a live tmux server or a real git repository.
 */
export interface McpDeps {
  spawnPane: (
    projectRoot: string,
    sessionName: string,
    request: BridgeSpawnRequest,
  ) => Promise<BridgeSpawnResult>;
  killPane: (projectRoot: string, paneId: string) => Promise<BridgeKillResult>;
  sessionNameForRoot: (projectRoot: string) => string;
  executeTask: (
    request: OrchestrationTaskRequest,
    sessionName: string,
  ) => Promise<{
    result: OrchestrationTaskResult;
    spawned: Map<string, BridgeSpawnResult>;
  }>;
}

export const defaultMcpDeps: McpDeps = {
  spawnPane: (projectRoot, sessionName, request) =>
    spawnBridgePane(projectRoot, sessionName, request),
  killPane: (projectRoot, paneId) => killBridgePane(projectRoot, paneId),
  sessionNameForRoot: tmuxSessionNameForRoot,
  executeTask: async (request, sessionName) => {
    // One task can mix local panes and Coven sessions; each backend stays
    // unaware of the other and the router owns which mode goes where.
    const panes = createBridgePaneBackend({ sessionName });
    const coven = createCovenSessionBackend();
    const orchestrator = new Orchestrator({
      executeLane: composeLaneBackends({
        'isolated-worktree': panes.execute,
        'shared-worktree': panes.execute,
        terminal: panes.execute,
        'coven-session': coven.execute,
      }),
    });
    const result = await orchestrator.execute(request);
    return { result, spawned: panes.spawned() };
  },
};

let deps: McpDeps = defaultMcpDeps;

/** Test seam. Returns a restore function. */
export function setMcpDeps(next: Partial<McpDeps>): () => void {
  const previous = deps;
  deps = { ...deps, ...next };
  return () => {
    deps = previous;
  };
}

function resolveProjectRoot(args: Record<string, unknown>): string {
  const raw = args.project_root ?? args.projectRoot;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return process.env.PSYCHE_PROJECT_ROOT ?? process.cwd();
}

export const TOOLS: ToolDef[] = [
  {
    name: 'psyche_list_panes',
    description:
      'List all psyche panes for the active project. Each entry includes the tmux pane id, working directory, branch, agent, and human-readable title.',
    inputSchema: {
      type: 'object',
      properties: {
        project_root: {
          type: 'string',
          description:
            'Absolute path to the project root whose panes to list. Defaults to $PSYCHE_PROJECT_ROOT then process.cwd() if omitted.',
        },
      },
    },
    handler: async (args) => {
      const projectRoot = resolveProjectRoot(args);
      const panes: PaneSummary[] = await listPanes(projectRoot);
      return {
        project_root: projectRoot,
        count: panes.length,
        panes,
      };
    },
  },
  {
    name: 'psyche_execute_task',
    description:
      'Run one task across several parallel lanes. Each lane gets its own git worktree, branch, tmux pane, and harness, all seeded with the same prompt — the way to compare two agents on one problem, or to split work across several. Lanes run with bounded concurrency and fail independently: the task reports completed, partial, or failed, and successful lanes stay usable when siblings fail.',
    inputSchema: {
      type: 'object',
      required: ['prompt', 'lanes'],
      properties: {
        prompt: { type: 'string', description: 'Prompt seeded into every lane.' },
        lanes: {
          type: 'array',
          minItems: 1,
          description: 'One entry per parallel worker.',
          items: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string', description: 'Unique lane id, e.g. the agent name.' },
              agent: {
                type: 'string',
                description: 'Harness id. Omit together with mode "terminal" for a plain shell.',
              },
              mode: {
                type: 'string',
                enum: [...ORCHESTRATION_LANE_MODES],
                description:
                  'Defaults to isolated-worktree. shared-worktree and coven-session are not available on this path yet.',
              },
            },
          },
        },
        task_id: { type: 'string', description: 'Stable id for this task. Generated when omitted.' },
        concurrency: { type: 'number', description: 'Max lanes running at once. Defaults to the lane count, capped at 4.' },
        branch: { type: 'string', description: 'Start-point branch for the new worktrees.' },
        project_root: { type: 'string' },
      },
    },
    handler: async (args) => {
      const prompt = String(args.prompt ?? '').trim();
      if (!prompt) {
        throw Object.assign(new Error('psyche_execute_task requires `prompt`'), { code: ERR_INVALID_PARAMS });
      }
      const rawLanes = Array.isArray(args.lanes) ? args.lanes : [];
      if (rawLanes.length === 0) {
        throw Object.assign(new Error('psyche_execute_task requires at least one lane'), { code: ERR_INVALID_PARAMS });
      }

      const projectRoot = resolveProjectRoot(args);
      const request: OrchestrationTaskRequest = {
        taskId: typeof args.task_id === 'string' && args.task_id.trim()
          ? args.task_id.trim()
          : `mcp-task-${Date.now()}`,
        projectRoot,
        prompt,
        ...(typeof args.branch === 'string' ? { startPointBranch: args.branch } : {}),
        ...(typeof args.concurrency === 'number' ? { concurrency: args.concurrency } : {}),
        lanes: rawLanes.map((raw) => {
          const lane = (raw ?? {}) as Record<string, unknown>;
          const agent = typeof lane.agent === 'string' ? lane.agent : undefined;
          return {
            id: String(lane.id ?? '').trim(),
            mode: (typeof lane.mode === 'string' ? lane.mode : agent ? 'isolated-worktree' : 'terminal') as never,
            ...(agent ? { agent: agent as never } : {}),
          };
        }),
      };

      const { result, spawned } = await deps.executeTask(request, deps.sessionNameForRoot(projectRoot));

      return {
        task_id: result.taskId,
        status: result.status,
        lanes: result.lanes.map((lane) => {
          const spawn = spawned.get(lane.id);
          return {
            id: lane.id,
            status: lane.status,
            ...(spawn
              ? { pane_id: spawn.id, worktree_path: spawn.worktreePath, branch: spawn.branch }
              : {}),
            ...(lane.status === 'failed' ? { error: lane.error } : {}),
          };
        }),
      };
    },
  },
  {
    name: 'psyche_create_pane',
    description:
      'Create a new psyche pane: a fresh git worktree and branch off the project root, a tmux pane, and the chosen harness launched with the prompt. Returns the tmux pane id, worktree path, and branch. The psyche tmux session for this project must already be running.',
    inputSchema: {
      type: 'object',
      required: ['prompt', 'agent'],
      properties: {
        prompt: { type: 'string', description: 'Initial prompt to seed the harness with.' },
        agent: {
          type: 'string',
          description:
            "Harness id (`coven-code`, `claude`, `codex`, `opencode`, `cline`, `gemini`, `qwen`, `amp`, `pi`, `cursor`, `copilot`, `crush`).",
        },
        branch: {
          type: 'string',
          description: 'Branch name for the new worktree. If omitted, psyche derives one from the prompt slug.',
        },
        title: { type: 'string', description: 'Human-readable pane title. Defaults to the derived slug.' },
        project_root: { type: 'string' },
      },
    },
    handler: async (args) => {
      const prompt = String(args.prompt ?? '').trim();
      if (!prompt) {
        throw Object.assign(new Error('psyche_create_pane requires `prompt`'), { code: ERR_INVALID_PARAMS });
      }
      const agent = String(args.agent ?? '').trim();
      if (!agent) {
        throw Object.assign(new Error('psyche_create_pane requires `agent`'), { code: ERR_INVALID_PARAMS });
      }
      const projectRoot = resolveProjectRoot(args);
      const result = await deps.spawnPane(projectRoot, deps.sessionNameForRoot(projectRoot), {
        requestId: `mcp-${Date.now()}`,
        cwd: projectRoot,
        agent,
        prompt,
        branch: typeof args.branch === 'string' ? args.branch : undefined,
        title: typeof args.title === 'string' ? args.title : undefined,
      });
      return {
        pane_id: result.id,
        worktree_path: result.worktreePath,
        branch: result.branch,
        pane: result.pane,
      };
    },
  },
  {
    name: 'psyche_kill_pane',
    description:
      'Terminate a psyche pane and remove it from the project config. Does NOT delete the pane\'s git worktree or branch — those are returned so you can inspect or merge the work, and removing them stays an explicit action in the psyche TUI.',
    inputSchema: {
      type: 'object',
      required: ['pane_id'],
      properties: {
        pane_id: {
          type: 'string',
          description: 'Pane id from `psyche_list_panes` — either the tmux pane id (e.g. `%3`) or the psyche pane id.',
        },
        project_root: { type: 'string' },
      },
    },
    handler: async (args) => {
      const paneId = String(args.pane_id ?? '').trim();
      if (!paneId) {
        throw Object.assign(new Error('psyche_kill_pane requires `pane_id`'), { code: ERR_INVALID_PARAMS });
      }
      const projectRoot = resolveProjectRoot(args);
      const result = await deps.killPane(projectRoot, paneId);
      return {
        pane_id: result.paneId,
        id: result.id,
        killed: result.killed,
        worktree_path: result.worktreePath,
        branch: result.branch,
        note: 'Worktree and branch were left in place. Remove them from the psyche TUI if you no longer need the work.',
      };
    },
  },
  {
    name: 'psyche_get_pane_output',
    description:
      "Capture the current visible buffer plus scrollback of a psyche pane. Returns ANSI-escaped text — strip codes on the caller if you just want the plain content. Use this to read what a running agent has produced so far without attaching.",
    inputSchema: {
      type: 'object',
      required: ['pane_id'],
      properties: {
        pane_id: { type: 'string', description: 'tmux pane id (e.g. `%3`) returned by `psyche_list_panes`.' },
        strip_ansi: {
          type: 'boolean',
          description: 'When true, strip ANSI escape sequences before returning. Default false (preserves colour for terminal renderers).',
        },
      },
    },
    handler: async (args) => {
      const paneId = String(args.pane_id ?? '').trim();
      if (!paneId) {
        throw Object.assign(new Error('psyche_get_pane_output requires `pane_id`'), { code: ERR_INVALID_PARAMS });
      }
      const buf = capturePaneSync(paneId);
      let text = buf.toString('utf8');
      if (args.strip_ansi === true) {
        // OSC, CSI, and standalone ESC sequences. Same surface as `strip-ansi`
        // npm but avoids the runtime dep.
        text = text.replace(/\x1B\][^\x07]*\x07/g, '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
      }
      return { pane_id: paneId, bytes: buf.length, content: text };
    },
  },
  {
    name: 'psyche_list_rituals',
    description:
      "List every ritual available to the active project — both psyche built-ins (Start Coding, Terminal First, Review Stack, Release Check, Fix OpenClaw, …) and project-saved rituals from `<projectRoot>/.psyche/rituals/`. Each entry includes its id, name, scope (`builtin`|`project`), description, and pane spec.",
    inputSchema: {
      type: 'object',
      properties: {
        project_root: { type: 'string' },
      },
    },
    handler: async (args) => {
      const projectRoot = resolveProjectRoot(args);
      const builtin = getBuiltInRituals().map((r) => ({ ...r, scope: 'builtin' as const }));
      const project = listProjectRituals(projectRoot).map((r) => ({ ...r, scope: 'project' as const }));
      return {
        project_root: projectRoot,
        builtin,
        project,
        count: builtin.length + project.length,
      };
    },
  },
  {
    name: 'psyche_list_worktrees',
    description:
      "List every git worktree associated with the active project's repository, including the path, branch, current HEAD sha, and whether it is the main worktree. Useful when you need to know which branches are already checked out before suggesting a new pane.",
    inputSchema: {
      type: 'object',
      properties: {
        project_root: { type: 'string' },
      },
    },
    handler: async (args) => {
      const projectRoot = resolveProjectRoot(args);
      let raw: string;
      try {
        raw = execFileSync('git', ['-C', projectRoot, 'worktree', 'list', '--porcelain'], {
          encoding: 'utf8',
          timeout: 5000,
        });
      } catch (err) {
        throw Object.assign(
          new Error(`git worktree list failed: ${err instanceof Error ? err.message : String(err)}`),
          { code: ERR_INTERNAL },
        );
      }

      const worktrees: Array<{
        path: string;
        head?: string;
        branch?: string;
        bare?: boolean;
        detached?: boolean;
        locked?: boolean;
      }> = [];

      let current: (typeof worktrees)[number] | null = null;
      for (const line of raw.split('\n')) {
        if (line.startsWith('worktree ')) {
          if (current) worktrees.push(current);
          current = { path: line.slice('worktree '.length) };
        } else if (current && line.startsWith('HEAD ')) {
          current.head = line.slice('HEAD '.length);
        } else if (current && line.startsWith('branch ')) {
          current.branch = line.slice('branch '.length);
        } else if (current && line === 'bare') {
          current.bare = true;
        } else if (current && line === 'detached') {
          current.detached = true;
        } else if (current && line.startsWith('locked')) {
          current.locked = true;
        }
      }
      if (current) worktrees.push(current);

      return { project_root: projectRoot, count: worktrees.length, worktrees };
    },
  },
];

// ---- MCP method dispatch --------------------------------------------------

async function handleInitialize(_params: unknown): Promise<unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    capabilities: {
      tools: { listChanged: false },
    },
  };
}

async function handleToolsList(_params: unknown): Promise<unknown> {
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
}

async function handleToolsCall(params: unknown): Promise<unknown> {
  const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
  if (!p.name || typeof p.name !== 'string') {
    throw Object.assign(new Error('tools/call requires `name`'), { code: ERR_INVALID_PARAMS });
  }
  const tool = TOOLS.find((t) => t.name === p.name);
  if (!tool) {
    throw Object.assign(new Error(`Unknown tool: ${p.name}`), { code: ERR_METHOD_NOT_FOUND });
  }
  const result = await tool.handler(p.arguments ?? {});
  // MCP `tools/call` wraps the result in a content array of text/json blocks.
  // We always emit a single JSON block — clients that prefer text can stringify.
  return {
    content: [
      {
        type: 'text',
        text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
      },
    ],
  };
}

/**
 * Handle one JSON-RPC request and return the response.
 *
 * Returns null for notifications, which by protocol get no reply. Kept
 * separate from the stdio loop so tests can exercise the real tool dispatch
 * without spawning a process or touching stdout.
 */
export async function handleMcpRequest(
  req: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  try {
    let result: unknown;
    switch (req.method) {
      case 'initialize':
        result = await handleInitialize(req.params);
        break;
      case 'notifications/initialized':
        return null;
      case 'tools/list':
        result = await handleToolsList(req.params);
        break;
      case 'tools/call':
        result = await handleToolsCall(req.params);
        break;
      case 'ping':
        result = {};
        break;
      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: ERR_METHOD_NOT_FOUND, message: `Method not found: ${req.method}` },
        };
    }
    return { jsonrpc: '2.0', id, result };
  } catch (err) {
    const code = (err as { code?: number }).code ?? ERR_INTERNAL;
    const message = err instanceof Error ? err.message : String(err);
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}

async function dispatch(req: JsonRpcRequest): Promise<void> {
  const response = await handleMcpRequest(req);
  if (response) writeResponse(response);
}

// ---- stdio loop -----------------------------------------------------------

export async function runMcpServer(): Promise<void> {
  // MCP frames are newline-delimited JSON-RPC objects on stdin/stdout.
  // stderr is reserved for log output so it doesn't corrupt the protocol.
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      fail(null, ERR_PARSE, 'Parse error: stdin is not valid JSON');
      return;
    }
    if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      fail(req.id ?? null, ERR_INVALID_REQUEST, 'Invalid JSON-RPC 2.0 request');
      return;
    }
    void dispatch(req);
  });

  // Stay alive until stdin closes — clients (coven-code, etc.) signal end-of-
  // session by closing their write end.
  await new Promise<void>((resolve) => {
    rl.on('close', () => resolve());
  });
}
