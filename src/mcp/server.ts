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

function ok<T>(id: JsonRpcId, result: T): void {
  writeResponse({ jsonrpc: '2.0', id, result });
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
    name: 'psyche_create_pane',
    description:
      '[STUB — wiring in progress] Create a new psyche pane with the given prompt, agent, and optional worktree/branch. Returns the new pane id once the daemon-driven path is hooked up.',
    inputSchema: {
      type: 'object',
      required: ['prompt', 'agent'],
      properties: {
        prompt: { type: 'string', description: 'Initial prompt to seed the harness with.' },
        agent: {
          type: 'string',
          description:
            "Harness id (`claude`, `codex`, `opencode`, `coven-code`, `cline`, `gemini`, `qwen`, `amp`, `pi`, `cursor`, `copilot`, `crush`).",
        },
        worktree: {
          type: 'string',
          description: 'Existing worktree path. If omitted, psyche creates a new worktree from the project root.',
        },
        branch: {
          type: 'string',
          description: 'Branch name for the new worktree. If omitted, psyche derives one from the prompt slug.',
        },
        project_root: { type: 'string' },
      },
    },
    handler: async (_args) => {
      // TODO(step-2b): wire to psyche's pane-creation flow
      // (src/utils/paneCreation.ts → TmuxService.createPane + AgentLaunch).
      // Tonight ships the shape; behaviour lands in the next commit.
      throw new Error(
        'psyche_create_pane is not yet wired — coming in the next MCP commit. Use the psyche TUI for now.',
      );
    },
  },
  {
    name: 'psyche_kill_pane',
    description:
      '[STUB — wiring in progress] Terminate the named psyche pane and clean up its worktree.',
    inputSchema: {
      type: 'object',
      required: ['pane_id'],
      properties: {
        pane_id: { type: 'string', description: 'tmux pane id (e.g. `%3`) returned by `psyche_list_panes`.' },
        project_root: { type: 'string' },
      },
    },
    handler: async (_args) => {
      throw new Error(
        'psyche_kill_pane is not yet wired — coming in the next MCP commit. Use the psyche TUI for now.',
      );
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

async function dispatch(req: JsonRpcRequest): Promise<void> {
  const id = req.id ?? null;
  try {
    let result: unknown;
    switch (req.method) {
      case 'initialize':
        result = await handleInitialize(req.params);
        break;
      case 'notifications/initialized':
        // Notifications have no response.
        return;
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
        fail(id, ERR_METHOD_NOT_FOUND, `Method not found: ${req.method}`);
        return;
    }
    ok(id, result);
  } catch (err) {
    const code = (err as { code?: number }).code ?? ERR_INTERNAL;
    const message = err instanceof Error ? err.message : String(err);
    fail(id, code, message);
  }
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
