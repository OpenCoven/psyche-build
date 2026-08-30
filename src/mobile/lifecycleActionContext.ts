// Phase 9 scoped lifecycle action-context contract (v1).
//
// Encodes the scoped action context that the Phase 9 pane lifecycle actions
// (merge, create PR, stop, close and clean up, plus the pane menu's rename,
// files, and rituals additions) attach to their action chains. The execution
// plan this module mirrors lives in `docs/mobile/PHASE-9-LIFECYCLE-PLAN.md`;
// the Beads source remains authoritative for the child task definitions
// (OpenCoven/psyche-build#217, Bead `psyche-i7c.9`; children #218–#221 own
// their implementations).
//
// This module is a contract slice only: it executes no action, holds no
// authority, persists nothing, and never infers runtime state. It is a pure,
// deterministic record model so every guarded lifecycle flow can carry one
// validated, minimal identity bundle — canonical selected project, tmux
// server/session/pane identity, worktree/branch identity, action id, and an
// authority reference — instead of free-form strings.
//
// Authority notice: the authority reference carried here is display/scoping
// metadata only. The host control plane and the host action workflows remain
// the single source of truth for validation, merge/PR confirmation chains,
// cleanup choices, and revocation. Nothing in this module may grant, infer,
// or broaden authority — not from a UI selection, tmux pane, worktree,
// branch, Bead, or GitHub issue.

/** Schema version of the scoped action-context format produced and validated here. */
export const LIFECYCLE_ACTION_CONTEXT_VERSION = 1;

/**
 * Pane lifecycle actions in Phase 9 scope. These are the pane menu actions
 * the phase adds or guards on mobile; read-only actions (view, copy path)
 * are out of scope because they mutate nothing.
 *
 * `merge` and `create_pr` mirror `PaneAction.MERGE` / `PaneAction.CREATE_PR`
 * in `src/actions/types.ts`; `close` mirrors `PaneAction.CLOSE` (which owns
 * the host cleanup choices). `stop` is the distinct native stop action whose
 * contract is: terminate the pane process, always retain worktree/branch.
 */
export type LifecycleActionId =
  | 'merge'
  | 'create_pr'
  | 'stop'
  | 'close'
  | 'rename'
  | 'files'
  | 'rituals';

/** Canonical Phase 9 action ids. */
export const LIFECYCLE_ACTION_IDS: readonly LifecycleActionId[] = [
  'merge',
  'create_pr',
  'stop',
  'close',
  'rename',
  'files',
  'rituals',
];

/**
 * Actions whose failure mode destroys state and therefore always require the
 * consequence-first guarded confirmation: `merge` closes sibling panes and
 * advances the target branch, `stop` terminates the pane process, and `close`
 * tears down the pane and may delete the worktree and/or branch through the
 * host cleanup choices. `create_pr` is an external side effect guarded by the
 * host's own confirm/review flow, but does not destroy local state.
 */
export const DESTRUCTIVE_LIFECYCLE_ACTION_IDS: readonly LifecycleActionId[] = [
  'merge',
  'stop',
  'close',
];

/** True when the action id is one of the destructive lifecycle actions. */
export function isDestructiveLifecycleAction(actionId: string): boolean {
  return (DESTRUCTIVE_LIFECYCLE_ACTION_IDS as readonly string[]).includes(actionId);
}

/**
 * Actions that cannot run without a worktree. Mirrors the
 * `requires: { worktree: true }` metadata in the host `ACTION_REGISTRY`.
 * `stop` and `close` may legally run on shell panes without a worktree.
 */
export const WORKTREE_REQUIRED_ACTION_IDS: readonly LifecycleActionId[] = [
  'merge',
  'create_pr',
];

/**
 * Structurally mirrors `TmuxServerIdentity` in
 * `src/services/TmuxServerIdentity.ts` (pid + process start identity defeat
 * PID reuse; optional socket/session tighten the binding) without importing
 * the host service: this module stays a dependency-free pure contract.
 */
export interface LifecycleTmuxServerIdentity {
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly socketPath?: string;
  /** tmux session id in `$N` form, when the installed tmux exposes it. */
  readonly sessionId?: string;
}

/**
 * What authorizes the action on the host. This is a pointer for scoped
 * display and correlation, never a grant: the host control plane validates
 * the referenced approval/lease/session at execution time and may have
 * revoked it by then. A context whose authority reference is stale must be
 * re-validated by the host, never trusted from the remote surface.
 */
export type LifecycleAuthorityKind = 'approval' | 'lease' | 'host-session';

/**
 * Scoped action context for one guarded pane lifecycle action: the minimal,
 * validated identity bundle a remote surface needs to name exactly what a
 * confirmation is about to affect — and nothing more.
 */
export interface LifecycleActionContext {
  readonly version: typeof LIFECYCLE_ACTION_CONTEXT_VERSION;
  /** The guarded action this context scopes. */
  readonly actionId: LifecycleActionId;
  /** Host running the tmux server and the cockpit (display identity). */
  readonly host: { readonly name: string };
  /** Canonical selected project: the realpath'd project root, plus an optional display name. */
  readonly project: { readonly canonicalRoot: string; readonly displayName?: string };
  /** Exact pane identity: durable record id + live tmux pane/session/server binding. */
  readonly pane: {
    /** Durable psyche pane record id (`PsychePane.id`). */
    readonly id: string;
    /** Live tmux pane id in `%N` form (`PsychePane.paneId`). */
    readonly tmuxPaneId: string;
    /** tmux session the pane lives in. */
    readonly tmuxSessionName: string;
    /** tmux server generation the pane id is meaningful within. */
    readonly tmuxServer: LifecycleTmuxServerIdentity;
    /** Optional human label for summaries (`getPaneDisplayName`). */
    readonly displayName?: string;
  };
  /**
   * Worktree and branch the action affects, when the pane has one. Absent
   * for shell panes; required for `merge`/`create_pr`. `stop` retains both;
   * `close` may delete them per the host cleanup choices.
   */
  readonly worktree?: { readonly path: string; readonly branch?: string };
  /** Host authority reference (pointer only — see the type's authority notice). */
  readonly authority: {
    readonly kind: LifecycleAuthorityKind;
    /** Approval id, lease id, or host session identifier, as named by the host. */
    readonly reference: string;
  };
  /**
   * What the confirmed action will do, in one bounded human-readable phrase.
   * Destructive confirmations must render this before their confirm button.
   */
  readonly consequence: string;
  /**
   * ISO-8601 instant at which the host captured this context. Consumers use
   * {@link isLifecycleActionContextStale} to disable actions built on stale
   * snapshots instead of trusting them.
   */
  readonly capturedAt: string;
}

export type LifecycleActionContextProblemCode =
  | 'invalid-context'
  | 'invalid-version'
  | 'unknown-field'
  | 'missing-field'
  | 'invalid-field'
  | 'unsafe-content'
  | 'worktree-required';

export interface LifecycleActionContextProblem {
  readonly code: LifecycleActionContextProblemCode;
  readonly message: string;
  /** Dotted path of the offending field, when attributable to one. */
  readonly path?: string;
}

export type LifecycleActionContextValidation =
  | { readonly ok: true; readonly context: LifecycleActionContext }
  | { readonly ok: false; readonly problems: readonly LifecycleActionContextProblem[] };

// --- fail-closed content policy ---------------------------------------------
//
// Every string field is bounded and free of control characters. Identity
// fields additionally reject shell metacharacters outright. The consequence
// phrase allows sentence punctuation but still rejects command/secret shapes.
// The scanner is defense-in-depth for a display/scoping contract, not a
// sandbox: the host never interpolates these values unquoted.

/** Never legitimate in any context string (control characters, including newlines and tabs). */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Shell/command metacharacters rejected in identity strings, paths, and references. */
const IDENTIFIER_FORBIDDEN = /[`$;|<>]/;

/** Metacharacters rejected even in prose (single '&' and ';' stay legal in sentences). */
const PROSE_FORBIDDEN = /[`$|<>]/;

/** Credential-shaped content rejected everywhere (fail closed on protected data). */
const SECRET_PATTERNS: readonly RegExp[] = [
  /gh[posur]_[A-Za-z0-9]{16,}/, // GitHub classic PATs / OAuth / user / app / refresh tokens
  /github_pat_[A-Za-z0-9_]{20,}/, // GitHub fine-grained PATs
  /sk-(?:ant-)?[A-Za-z0-9_-]{20,}/, // OpenAI/Anthropic-style API keys
  /AKIA[0-9A-Z]{16}/, // AWS access key ids
  /xox[baprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/, // JWTs
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private key material
  /\b(?:api[_-]?key|secret|password|passwd|bearer)\b\s*[:=]\s*\S+/i, // labeled secrets
];

/** Raw-command-shaped content rejected everywhere. */
const RAW_COMMAND_PATTERNS: readonly RegExp[] = [
  /\brm\s+-[a-z]/i, // rm with flags
  /\b(?:bash|sh|zsh)\s+-c\b/i, // shell -c one-liners
  /\bkill-(?:pane|window|session|server)\b/i, // tmux kill-* command literals
  /\b(?:tmux|git|gh|npm|pnpm|npx|node|curl|wget|sudo)\s+\S+\s+-{1,2}[A-Za-z]/i, // tool + subcommand + flag
];

/** Absolute-path shape: POSIX absolute, Windows drive, or UNC. */
const ABSOLUTE_PATH = /^(?:\/|\\\\|[A-Za-z]:[\\/])/;

/**
 * tmux session names are interpolated into tmux target strings, where ':'
 * and '.' are separators; reject them rather than quote defensively.
 */
const TMUX_SESSION_FORBIDDEN = /[:.]/;

/**
 * tmux server identity parts have canonical symbol-prefixed forms — pane ids
 * `%N`, session ids `$N` — so the sessionId field is format-checked instead
 * of running under the bare-`$` identifier ban (a real `$2` session id is not
 * command substitution).
 */
const TMUX_SESSION_ID = /^\$\d{1,10}$/;

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

interface StringCheckOptions {
  /** Maximum length (all strings are bounded; minimum is 1 after trimming). */
  readonly max: number;
  /** Prose policy (allows sentence punctuation); default is the stricter identifier policy. */
  readonly prose?: boolean;
}

/**
 * Validate one bounded string under the fail-closed content policy. Returns a
 * problem when the value is missing, unbounded, control-character-bearing,
 * metacharacter-bearing, or credential/command-shaped.
 */
function stringProblem(
  value: unknown,
  path: string,
  options: StringCheckOptions,
): LifecycleActionContextProblem | undefined {
  if (typeof value !== 'string') {
    return { code: 'invalid-field', message: `${path} must be a string`, path };
  }
  if (value.length === 0 || isBlank(value)) {
    return { code: 'missing-field', message: `${path} must be a non-empty string`, path };
  }
  if (value.length > options.max) {
    return {
      code: 'invalid-field',
      message: `${path} must be at most ${options.max} characters`,
      path,
    };
  }
  if (CONTROL_CHARS.test(value)) {
    return { code: 'unsafe-content', message: `${path} contains control characters`, path };
  }
  if (options.prose ? PROSE_FORBIDDEN.test(value) : IDENTIFIER_FORBIDDEN.test(value)) {
    return {
      code: 'unsafe-content',
      message: `${path} contains shell metacharacters and is rejected fail closed`,
      path,
    };
  }
  if (/&&|\|\|/.test(value)) {
    return {
      code: 'unsafe-content',
      message: `${path} contains chained-command operators and is rejected fail closed`,
      path,
    };
  }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(value)) {
      return {
        code: 'unsafe-content',
        message: `${path} matches a credential-shaped pattern and is rejected fail closed`,
        path,
      };
    }
  }
  for (const pattern of RAW_COMMAND_PATTERNS) {
    if (pattern.test(value)) {
      return {
        code: 'unsafe-content',
        message: `${path} contains raw-command-shaped text and is rejected fail closed`,
        path,
      };
    }
  }
  return undefined;
}

function pathProblem(value: unknown, fieldPath: string): LifecycleActionContextProblem | undefined {
  const basic = stringProblem(value, fieldPath, { max: 4096 });
  if (basic) {
    return basic;
  }
  const candidate = value as string;
  if (!ABSOLUTE_PATH.test(candidate)) {
    return {
      code: 'invalid-field',
      message: `${fieldPath} must be an absolute path`,
      path: fieldPath,
    };
  }
  if (/(^|[\\/])\.\.?(?:[\\/]|$)/.test(candidate)) {
    return {
      code: 'unsafe-content',
      message: `${fieldPath} must not contain '.' or '..' path segments`,
      path: fieldPath,
    };
  }
  return undefined;
}

function branchProblem(value: unknown, fieldPath: string): LifecycleActionContextProblem | undefined {
  const basic = stringProblem(value, fieldPath, { max: 256 });
  if (basic) {
    return basic;
  }
  const branch = value as string;
  // Conservative git check-ref-format subset; host git remains the authority.
  if (/[\s~^:?*[\\]/.test(branch) || branch.includes('..') || branch.includes('//')) {
    return {
      code: 'invalid-field',
      message: `${fieldPath} is not a conservative git branch name`,
      path: fieldPath,
    };
  }
  if (branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/')) {
    return {
      code: 'invalid-field',
      message: `${fieldPath} is not a conservative git branch name`,
      path: fieldPath,
    };
  }
  if (branch.endsWith('.lock')) {
    return {
      code: 'invalid-field',
      message: `${fieldPath} must not end with '.lock'`,
      path: fieldPath,
    };
  }
  return undefined;
}

function unknownKeysProblem(
  value: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
): LifecycleActionContextProblem | undefined {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      return {
        code: 'unknown-field',
        message: `${prefix}.${key} is not part of the v1 schema`,
        path: `${prefix}.${key}`,
      };
    }
  }
  return undefined;
}

function optionalStringProblem(
  record: Record<string, unknown>,
  key: string,
  prefix: string,
): LifecycleActionContextProblem | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    return undefined;
  }
  return stringProblem(record[key], `${prefix}.${key}`, { max: 256 });
}

/**
 * Strictly validate a scoped lifecycle action context received from any
 * surface. Unknown fields, missing identities, out-of-bounds values, and
 * credential/command-shaped content are all rejected; the validator is
 * defensive about shape so a malformed record from an untrusted surface
 * fails closed with problems instead of throwing.
 *
 * Required identities: host name, canonical project root, exact pane identity
 * (durable id, tmux pane id, tmux session name, tmux server generation), the
 * action id, the host authority reference, and the consequence phrase. The
 * worktree identity is required exactly when the action requires one
 * (`merge`, `create_pr`).
 */
export function validateActionContext(value: unknown): LifecycleActionContextValidation {
  if (!isRecordLike(value)) {
    return {
      ok: false,
      problems: [{ code: 'invalid-context', message: 'action context must be an object' }],
    };
  }
  const problems: LifecycleActionContextProblem[] = [];

  if (value.version !== LIFECYCLE_ACTION_CONTEXT_VERSION) {
    problems.push({
      code: 'invalid-version',
      message: `action context version must be ${LIFECYCLE_ACTION_CONTEXT_VERSION}`,
      path: 'version',
    });
  }

  const actionId = value.actionId;
  if (
    typeof actionId !== 'string'
    || !(LIFECYCLE_ACTION_IDS as readonly string[]).includes(actionId)
  ) {
    problems.push({
      code: 'invalid-field',
      message: `actionId must be one of ${LIFECYCLE_ACTION_IDS.join('|')}`,
      path: 'actionId',
    });
  }

  const unknownTop = unknownKeysProblem(
    value,
    ['version', 'actionId', 'host', 'project', 'pane', 'worktree', 'authority', 'consequence', 'capturedAt'],
    'context',
  );
  if (unknownTop) {
    problems.push(unknownTop);
  }

  // Host identity.
  const host = value.host;
  if (!isRecordLike(host)) {
    problems.push({ code: 'missing-field', message: 'host identity is required', path: 'host' });
  } else {
    const unknownHost = unknownKeysProblem(host, ['name'], 'host');
    if (unknownHost) {
      problems.push(unknownHost);
    }
    const hostName = stringProblem(host.name, 'host.name', { max: 256 });
    if (hostName) {
      problems.push(hostName);
    }
  }

  // Canonical selected project.
  const project = value.project;
  if (!isRecordLike(project)) {
    problems.push({
      code: 'missing-field',
      message: 'canonical project identity is required',
      path: 'project',
    });
  } else {
    const unknownProject = unknownKeysProblem(project, ['canonicalRoot', 'displayName'], 'project');
    if (unknownProject) {
      problems.push(unknownProject);
    }
    const root = pathProblem(project.canonicalRoot, 'project.canonicalRoot');
    if (root) {
      problems.push(root);
    }
    const displayName = optionalStringProblem(project, 'displayName', 'project');
    if (displayName) {
      problems.push(displayName);
    }
  }

  // Exact pane identity: durable record id + live tmux pane/session/server.
  const pane = value.pane;
  if (!isRecordLike(pane)) {
    problems.push({ code: 'missing-field', message: 'pane identity is required', path: 'pane' });
  } else {
    const unknownPane = unknownKeysProblem(
      pane,
      ['id', 'tmuxPaneId', 'tmuxSessionName', 'tmuxServer', 'displayName'],
      'pane',
    );
    if (unknownPane) {
      problems.push(unknownPane);
    }
    const paneId = stringProblem(pane.id, 'pane.id', { max: 256 });
    if (paneId) {
      problems.push(paneId);
    }
    if (typeof pane.tmuxPaneId !== 'string' || !/^%\d{1,10}$/.test(pane.tmuxPaneId)) {
      problems.push({
        code: 'invalid-field',
        message: 'pane.tmuxPaneId must be a tmux pane id in %N form',
        path: 'pane.tmuxPaneId',
      });
    }
    if (typeof pane.tmuxSessionName !== 'string') {
      problems.push({
        code: 'invalid-field',
        message: 'pane.tmuxSessionName must be a string',
        path: 'pane.tmuxSessionName',
      });
    } else {
      const session = stringProblem(pane.tmuxSessionName, 'pane.tmuxSessionName', { max: 256 });
      if (session) {
        problems.push(session);
      } else if (TMUX_SESSION_FORBIDDEN.test(pane.tmuxSessionName)) {
        problems.push({
          code: 'unsafe-content',
          message: 'pane.tmuxSessionName must not contain tmux target separators (":" or ".")',
          path: 'pane.tmuxSessionName',
        });
      }
    }
    const paneDisplayName = optionalStringProblem(pane, 'displayName', 'pane');
    if (paneDisplayName) {
      problems.push(paneDisplayName);
    }
    const server = pane.tmuxServer;
    if (!isRecordLike(server)) {
      problems.push({
        code: 'missing-field',
        message: 'pane.tmuxServer identity is required',
        path: 'pane.tmuxServer',
      });
    } else {
      const unknownServer = unknownKeysProblem(
        server,
        ['pid', 'processStartIdentity', 'socketPath', 'sessionId'],
        'pane.tmuxServer',
      );
      if (unknownServer) {
        problems.push(unknownServer);
      }
      if (
        typeof server.pid !== 'number'
        || !Number.isInteger(server.pid)
        || server.pid <= 0
        || !Number.isSafeInteger(server.pid)
      ) {
        problems.push({
          code: 'invalid-field',
          message: 'pane.tmuxServer.pid must be a positive safe integer',
          path: 'pane.tmuxServer.pid',
        });
      }
      const startIdentity = stringProblem(server.processStartIdentity, 'pane.tmuxServer.processStartIdentity', { max: 512 });
      if (startIdentity) {
        problems.push(startIdentity);
      }
      for (const optionalKey of ['socketPath', 'sessionId'] as const) {
        if (!Object.prototype.hasOwnProperty.call(server, optionalKey)) {
          continue;
        }
        if (optionalKey === 'sessionId') {
          const sessionId = server.sessionId;
          if (
            typeof sessionId !== 'string'
            || !TMUX_SESSION_ID.test(sessionId)
            || sessionId.length > 4096
          ) {
            problems.push({
              code: 'invalid-field',
              message: 'pane.tmuxServer.sessionId must be a tmux session id in $N form',
              path: 'pane.tmuxServer.sessionId',
            });
          }
          continue;
        }
        const part = stringProblem(server[optionalKey], `pane.tmuxServer.${optionalKey}`, { max: 4096 });
        if (part) {
          problems.push(part);
        }
      }
    }
  }

  // Worktree/branch identity: required exactly when the action needs one.
  const worktree = value.worktree;
  if (worktree === undefined || worktree === null) {
    const actionRequiresWorktree =
      typeof actionId === 'string'
      && (WORKTREE_REQUIRED_ACTION_IDS as readonly string[]).includes(actionId);
    if (actionRequiresWorktree) {
      problems.push({
        code: 'worktree-required',
        message: `actionId "${actionId}" requires a worktree identity`,
        path: 'worktree',
      });
    }
  } else if (!isRecordLike(worktree)) {
    problems.push({
      code: 'invalid-field',
      message: 'worktree identity must be an object when present',
      path: 'worktree',
    });
  } else {
    const unknownWorktree = unknownKeysProblem(worktree, ['path', 'branch'], 'worktree');
    if (unknownWorktree) {
      problems.push(unknownWorktree);
    }
    const worktreePath = pathProblem(worktree.path, 'worktree.path');
    if (worktreePath) {
      problems.push(worktreePath);
    }
    if (Object.prototype.hasOwnProperty.call(worktree, 'branch') && worktree.branch !== undefined) {
      const branch = branchProblem(worktree.branch, 'worktree.branch');
      if (branch) {
        problems.push(branch);
      }
    }
  }

  // Host authority reference (pointer only).
  const authority = value.authority;
  if (!isRecordLike(authority)) {
    problems.push({
      code: 'missing-field',
      message: 'authority reference is required',
      path: 'authority',
    });
  } else {
    const unknownAuthority = unknownKeysProblem(authority, ['kind', 'reference'], 'authority');
    if (unknownAuthority) {
      problems.push(unknownAuthority);
    }
    const validKinds: readonly LifecycleAuthorityKind[] = ['approval', 'lease', 'host-session'];
    if (
      typeof authority.kind !== 'string'
      || !validKinds.includes(authority.kind as LifecycleAuthorityKind)
    ) {
      problems.push({
        code: 'invalid-field',
        message: `authority.kind must be one of ${validKinds.join('|')}`,
        path: 'authority.kind',
      });
    }
    const reference = stringProblem(authority.reference, 'authority.reference', { max: 256 });
    if (reference) {
      problems.push(reference);
    }
  }

  // Consequence phrase and capture instant.
  const consequence = stringProblem(value.consequence, 'consequence', { max: 1000, prose: true });
  if (consequence) {
    problems.push(consequence);
  }

  if (typeof value.capturedAt !== 'string' || value.capturedAt.length === 0) {
    problems.push({
      code: 'missing-field',
      message: 'capturedAt must be an ISO-8601 instant string',
      path: 'capturedAt',
    });
  } else if (!Number.isFinite(Date.parse(value.capturedAt))) {
    problems.push({
      code: 'invalid-field',
      message: 'capturedAt must parse as an ISO-8601 instant',
      path: 'capturedAt',
    });
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }
  return { ok: true, context: value as unknown as LifecycleActionContext };
}

/**
 * Render the consequence-first summary that destructive confirmations must
 * read before their confirm button: host, project, pane, worktree, branch,
 * and consequence, in a stable order. Returns null (never a partial string)
 * when the context is missing a required field, so a caller can fail closed
 * instead of naming only some of what is about to be affected.
 */
export function consequenceSummary(context: LifecycleActionContext): string | null {
  if (!isRecordLike(context)) {
    return null;
  }
  const host = context.host;
  const project = context.project;
  const pane = context.pane;
  const worktree = context.worktree;
  const authority = context.authority;
  if (
    !isRecordLike(host)
    || !isRecordLike(project)
    || !isRecordLike(pane)
    || !isRecordLike(authority)
  ) {
    return null;
  }

  const hostName = typeof host.name === 'string' && !isBlank(host.name) ? host.name : null;
  const canonicalRoot =
    typeof project.canonicalRoot === 'string' && !isBlank(project.canonicalRoot)
      ? project.canonicalRoot
      : null;
  const projectDisplayName =
    typeof project.displayName === 'string' && !isBlank(project.displayName)
      ? project.displayName
      : null;
  const paneId = typeof pane.id === 'string' && !isBlank(pane.id) ? pane.id : null;
  const tmuxPaneId =
    typeof pane.tmuxPaneId === 'string' && !isBlank(pane.tmuxPaneId) ? pane.tmuxPaneId : null;
  const paneDisplayName =
    typeof pane.displayName === 'string' && !isBlank(pane.displayName)
      ? pane.displayName
      : null;
  const consequence =
    typeof context.consequence === 'string' && !isBlank(context.consequence)
      ? context.consequence
      : null;

  if (!hostName || !canonicalRoot || !paneId || !tmuxPaneId || !consequence) {
    return null;
  }

  const projectLabel = projectDisplayName
    ? `${projectDisplayName} (${canonicalRoot})`
    : canonicalRoot;
  const paneLabel = paneDisplayName ? `${paneDisplayName} (${tmuxPaneId})` : tmuxPaneId;
  const worktreePath =
    isRecordLike(worktree) && typeof worktree.path === 'string' && !isBlank(worktree.path)
      ? worktree.path
      : null;
  const branch =
    isRecordLike(worktree) && typeof worktree.branch === 'string' && !isBlank(worktree.branch)
      ? worktree.branch
      : null;

  return [
    `host: ${hostName}`,
    `project: ${projectLabel}`,
    `pane: ${paneLabel} [${paneId}]`,
    `worktree: ${worktreePath ?? 'none attached'}`,
    `branch: ${branch ?? 'none'}`,
    `consequence: ${consequence}`,
  ].join(' · ');
}

/**
 * Aligned with the mobile control gateway's remote action-session TTL
 * (5 minutes, `src/services/bridge/MobileControlGateway.ts`): a context older than
 * this is a stale snapshot of a possibly-changed host, pane, worktree, or
 * authority, and the action it scopes must be disabled and re-captured.
 */
export const LIFECYCLE_ACTION_CONTEXT_MAX_AGE_MS = 5 * 60_000;

/**
 * Whether a captured context is stale at `nowMs`. Fail closed: a missing or
 * unparseable `capturedAt`, a future capture instant (clock skew), or an age
 * beyond {@link LIFECYCLE_ACTION_CONTEXT_MAX_AGE_MS} all count as stale, and
 * stale actions are disabled rather than executed on a possibly-changed host.
 * This predicate covers snapshot age only; in-progress action state is owned
 * by the host action sessions, and server-generation drift is owned by the
 * tmux identity comparison on the host.
 */
export function isLifecycleActionContextStale(
  context: LifecycleActionContext,
  nowMs: number,
  maxAgeMs: number = LIFECYCLE_ACTION_CONTEXT_MAX_AGE_MS,
): boolean {
  if (!isRecordLike(context) || typeof context.capturedAt !== 'string') {
    return true;
  }
  const capturedMs = Date.parse(context.capturedAt);
  if (!Number.isFinite(capturedMs) || !Number.isFinite(nowMs)) {
    return true;
  }
  const ageMs = nowMs - capturedMs;
  if (ageMs < 0) {
    return true;
  }
  return ageMs > maxAgeMs;
}
