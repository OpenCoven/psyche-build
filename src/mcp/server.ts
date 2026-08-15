__OURS__

const PROTOCOL_VERSION = '2025-06-18';
export const SERVER_NAME = 'psyche';
const SERVER_VERSION = '0.0.1';

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}
interface JsonRpcSuccess<T = unknown> { jsonrpc: '2.0'; id: JsonRpcId; result: T }
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
export const MCP_CONTROL_ERROR_CODE = -32001;

__OURS__
}

/** Exact legacy porcelain projection, now using the non-blocking read API. */
export async function listLegacyWorktrees(
  projectRoot: string,
  run: GitWorktreeRunner = runGitWorktree,
): Promise<LegacyWorktree[]> {
  const { stdout: raw } = await run(
    'git',
    ['-C', projectRoot, 'worktree', 'list', '--porcelain'],
    { encoding: 'utf8', timeout: 5000 },
  );
  const worktrees: LegacyWorktree[] = [];
  let current: LegacyWorktree | null = null;
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
  return worktrees;
}

__OURS__
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

__OURS__
};

function exactObject(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): Record<string, unknown> {
  return { type: 'object', properties, required: [...required], additionalProperties: false };
}

__OURS__

export const TOOLS: ToolDef[] = [
  {
    name: 'psyche_control_list',
__OURS__
        }));
      });
    },
  },
  {
    name: 'psyche_pane_observe',
__OURS__
    }),
  },
  {
    name: 'psyche_create_pane',
__OURS__
      return {
        project_root: projectRoot,
        ...rituals,
        count: rituals.builtin.length + rituals.project.length,
      };
    },
  },
  {
    name: 'psyche_list_worktrees',
__OURS__
      return { project_root: projectRoot, count: worktrees.length, worktrees };
    },
  },
];

__OURS__
  };
}

async function handleToolsCall(params: unknown): Promise<unknown> {
__OURS__
  return {
    content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
  };
}

__OURS__
export async function handleMcpRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  try {
    let result: unknown;
    switch (req.method) {
      case 'initialize': result = await handleInitialize(); break;
      case 'notifications/initialized': return null;
__OURS__
      case 'tools/call': result = await handleToolsCall(req.params); break;
      case 'ping': result = {}; break;
      default:
        return { jsonrpc: '2.0', id, error: { code: ERR_METHOD_NOT_FOUND, message: `Method not found: ${req.method}` } };
    }
    return { jsonrpc: '2.0', id, result };
  } catch (error) {
__OURS__
  }
}

async function dispatch(request: JsonRpcRequest): Promise<void> {
  const response = await handleMcpRequest(request);
  if (response) writeResponse(response);
}

__OURS__
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      fail(null, ERR_PARSE, 'Parse error: stdin is not valid JSON');
      return;
    }
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      fail(request.id ?? null, ERR_INVALID_REQUEST, 'Invalid JSON-RPC 2.0 request');
      return;
    }
__OURS__
}
