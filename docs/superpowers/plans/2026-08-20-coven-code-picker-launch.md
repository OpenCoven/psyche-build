# Coven Code Picker Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the terminal/TUI Coven Code picker launch `coven code --session-id <generated UUID>` instead of the retired `coven-code` executable or any Codex-specific path.

**Architecture:** Keep `coven-code` as the stable configuration and picker ID, but update its registry command to the current `coven` executable and `code` subcommand. Add an optional command-building context for a validated Coven session ID, then have `launchAgentInPane` generate exactly one UUID per new Coven pane and pass it through every prompt path.

**Tech Stack:** TypeScript, Node.js `randomUUID`, tmux command dispatch, Vitest, pnpm.

---

## File structure

- Modify `src/utils/agentLaunch.ts`: update the Coven registry entry, add the optional command context, validate and append Coven session IDs, and generate one ID in the shared new-pane launcher.
- Modify `__tests__/agentLaunch.test.ts`: cover current Coven executable discovery, static command metadata, contextual session-ID construction, and unsafe ID rejection.
- Modify `__tests__/launchAgentInPane.test.ts`: inject deterministic UUIDs and cover prompted, no-prompt, permission, and non-Codex launch behavior.
- Reference `docs/superpowers/specs/2026-08-20-coven-code-picker-launch-design.md`: approved TUI behavior and scope; no further documentation edit is required.

### Task 1: Define the Coven Command Contract

**Files:**
- Modify: `__tests__/agentLaunch.test.ts:1-265`
- Modify: `src/utils/agentLaunch.ts:1-565`

- [ ] **Step 1: Write failing registry and command-builder tests**

Add a registry contract test near the existing Coven ordering tests in
`__tests__/agentLaunch.test.ts`:

```ts
it('resolves Coven Code through the current coven executable', () => {
  const definition = AGENT_REGISTRY['coven-code'];

  expect(definition.installTestCommand).toBe(
    'command -v coven 2>/dev/null || which coven 2>/dev/null',
  );
  expect(definition.commonPaths).toContain('/opt/homebrew/bin/coven');
  expect(definition.commonPaths).not.toContain('/opt/homebrew/bin/coven-code');
  expect(definition.promptCommand).toBe('coven code');
  expect(definition.resumeCommandTemplate).toBe('coven code --resume{permissions}');
});
```

Replace the existing Coven expectations in
`describe('buildInitialPromptCommand per agent and permission mode')`:

```ts
it('builds positional prompt commands for coven-code', () => {
  expect(buildInitialPromptCommand('coven-code', '"fix it"', undefined))
    .toBe('coven code "fix it"');
  expect(buildInitialPromptCommand('coven-code', '"fix it"', 'plan'))
    .toBe('coven code --permission-mode plan "fix it"');
  expect(buildInitialPromptCommand('coven-code', '"fix it"', 'bypassPermissions'))
    .toBe('coven code --permission-mode bypass-permissions "fix it"');
});
```

Add contextual session-ID tests in `describe('command builders')`:

```ts
it('adds a supplied session id to Coven Code commands', () => {
  const context = {
    covenSessionId: '12345678-1234-4abc-8def-1234567890ab',
  };

  expect(buildAgentCommand('coven-code', undefined, context)).toBe(
    'coven code --session-id 12345678-1234-4abc-8def-1234567890ab',
  );
  expect(buildInitialPromptCommand(
    'coven-code',
    '"fix it"',
    'plan',
    context,
  )).toBe(
    'coven code --session-id 12345678-1234-4abc-8def-1234567890ab ' +
      '--permission-mode plan "fix it"',
  );
});

it('rejects unsafe Coven session ids without emitting a command', () => {
  expect(() => buildAgentCommand('coven-code', undefined, {
    covenSessionId: '$(touch /tmp/unsafe)',
  })).toThrow('Coven session id contains unsupported characters');
});

it('does not add Coven session ids to other agents', () => {
  expect(buildAgentCommand('codex', undefined, {
    covenSessionId: '12345678-1234-4abc-8def-1234567890ab',
  })).toBe('codex');
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm vitest --run __tests__/agentLaunch.test.ts
```

Expected: FAIL because the registry still resolves `coven-code`, the command
builders do not accept a launch context, and static commands still use the
retired executable.

- [ ] **Step 3: Update the Coven registry entry**

In `src/utils/agentLaunch.ts`, replace the executable-specific fields of the
`coven-code` registry entry:

```ts
'coven-code': {
  id: 'coven-code',
  name: 'Coven Code',
  shortLabel: 'cv',
  description: 'OpenCoven coding harness — Claurst-based TUI with familiar personas',
  slugSuffix: 'coven-code',
  installTestCommand: 'command -v coven 2>/dev/null || which coven 2>/dev/null',
  commonPaths: [
    ...homePath('.local/bin/coven'),
    '/opt/homebrew/bin/coven',
    '/usr/local/bin/coven',
    ...homePath('bin/coven'),
    ...homePath('.npm-global/bin/coven'),
  ],
  promptCommand: 'coven code',
  promptTransport: 'positional',
  permissionFlags: {
    plan: '--permission-mode plan',
    acceptEdits: '--permission-mode accept-edits',
    bypassPermissions: '--permission-mode bypass-permissions',
  },
  defaultEnabled: true,
  resumeCommandTemplate: 'coven code --resume{permissions}',
},
```

- [ ] **Step 4: Add the optional command context and safe session-ID insertion**

Add this exported interface beside the existing launch-related types:

```ts
export interface AgentCommandContext {
  covenSessionId?: string;
}
```

Add these helpers above `buildAgentCommand`:

```ts
function isSafeCovenSessionId(sessionId: string): boolean {
  return (
    sessionId.length >= 1
    && sessionId.length <= 128
    && /^[A-Za-z0-9._:-]+$/.test(sessionId)
  );
}

function applyAgentCommandContext(
  agent: AgentName,
  command: string,
  context?: AgentCommandContext,
): string {
  if (agent !== 'coven-code' || context?.covenSessionId === undefined) {
    return command;
  }
  if (!isSafeCovenSessionId(context.covenSessionId)) {
    throw new Error('Coven session id contains unsupported characters');
  }
  return `${command} --session-id ${context.covenSessionId}`;
}
```

Change the command builders to accept and apply the optional context:

```ts
export function buildAgentCommand(
  agent: AgentName,
  permissionMode: PermissionMode | undefined,
  context?: AgentCommandContext,
): string {
  const definition = AGENT_REGISTRY[agent];
  const baseCommand = applyAgentCommandContext(
    agent,
    definition.noPromptCommand || definition.promptCommand,
    context,
  );
  return appendFlags(baseCommand, getPermissionFlags(agent, permissionMode));
}

export function buildInitialPromptCommand(
  agent: AgentName,
  promptToken: string,
  permissionMode: PermissionMode | undefined,
  context?: AgentCommandContext,
): string {
  const definition = AGENT_REGISTRY[agent];
  if (definition.promptTransport === 'send-keys') {
    return buildAgentCommand(agent, permissionMode, context);
  }

  const baseCommand = appendFlags(
    applyAgentCommandContext(agent, definition.promptCommand, context),
    getPermissionFlags(agent, permissionMode),
  );

  if (definition.promptTransport === 'stdin') {
    return `printf '%s\\n' ${promptToken} | ${baseCommand}`;
  }

  if (definition.promptTransport === 'option' && definition.promptOption) {
    return `${baseCommand} ${definition.promptOption} ${promptToken}`;
  }

  return `${baseCommand} ${promptToken}`;
}
```

Leave callers unchanged in this task; the new parameter is optional and
preserves every existing non-Coven command.

- [ ] **Step 5: Run the registry and builder tests**

Run:

```bash
pnpm vitest --run __tests__/agentLaunch.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the command contract**

```bash
git add src/utils/agentLaunch.ts __tests__/agentLaunch.test.ts
git commit -m "fix: launch Coven Code through coven"
```

### Task 2: Generate One Session ID Per TUI Pane

**Files:**
- Modify: `__tests__/launchAgentInPane.test.ts:1-195`
- Modify: `src/utils/agentLaunch.ts:1-697`

- [ ] **Step 1: Make Coven pane-launch tests deterministic**

Add a fixed session ID below the mocks in
`__tests__/launchAgentInPane.test.ts`:

```ts
const COVEN_SESSION_ID = '12345678-1234-4abc-8def-1234567890ab';
```

Update the `launch` helper so Coven launches receive a deterministic generator
unless a test overrides it:

```ts
async function launch(agent: AgentName, prompt = 'Fix the failing tests', extra = {}) {
  const tmux = createTmux();
  const covenDefaults = agent === 'coven-code'
    ? { generateCovenSessionId: () => COVEN_SESSION_ID }
    : {};
  await launchAgentInPane({
    paneId: '%1',
    agent,
    prompt,
    slug: 'fix-tests',
    projectRoot,
    psychePaneId: 'psyche-1',
    tmuxService: tmux as never,
    ...covenDefaults,
    ...extra,
  });
  return tmux;
}
```

- [ ] **Step 2: Replace retired-command expectations and add UUID lifecycle tests**

Replace the Coven-specific expectations with:

```ts
it('launches Coven Code with one generated session id and its prompt', async () => {
  const generateCovenSessionId = vi.fn(() => COVEN_SESSION_ID);
  const tmux = await launch('coven-code', 'Fix the failing tests', {
    generateCovenSessionId,
  });

  expect(generateCovenSessionId).toHaveBeenCalledTimes(1);
  expect(tmux.shellCommands[0]).toMatch(
    /coven code --session-id 12345678-1234-4abc-8def-1234567890ab "\$PSYCHE_PROMPT_CONTENT"$/,
  );
});

it('applies Coven Code permission flags after the generated session id', async () => {
  const tmux = await launch('coven-code', '', { permissionMode: 'plan' });

  expect(tmux.shellCommands[0]).toBe(
    'coven code --session-id 12345678-1234-4abc-8def-1234567890ab ' +
      '--permission-mode plan',
  );
});
```

Update the no-prompt expectations:

```ts
it('starts Coven Code with a generated session id when there is no prompt', async () => {
  const tmux = await launch('coven-code', '');
  expect(tmux.shellCommands[0]).toBe(
    'coven code --session-id 12345678-1234-4abc-8def-1234567890ab',
  );
  expect(sendPromptViaTmux).not.toHaveBeenCalled();
});

it('treats a whitespace-only prompt as no prompt', async () => {
  const tmux = await launch('coven-code', '   \n  ');
  expect(tmux.shellCommands[0]).toBe(
    'coven code --session-id 12345678-1234-4abc-8def-1234567890ab',
  );
});
```

Add a non-Coven generator guard near the Codex hook tests:

```ts
it('does not generate a Coven session id for Codex', async () => {
  const generateCovenSessionId = vi.fn(() => COVEN_SESSION_ID);

  await launch('codex', 'Fix it', { generateCovenSessionId });

  expect(generateCovenSessionId).not.toHaveBeenCalled();
});
```

Keep the existing assertion that Coven Code does not contain
`PSYCHE_TMUX_PANE_ID=` and the existing Codex hook assertion unchanged.

- [ ] **Step 3: Run the pane-launch test to verify it fails**

Run:

```bash
pnpm vitest --run __tests__/launchAgentInPane.test.ts
```

Expected: FAIL because `launchAgentInPane` does not accept a session-ID
generator and does not pass command context to the builders.

- [ ] **Step 4: Add UUID generation to the shared TUI pane launcher**

Add the Node crypto import at the top of `src/utils/agentLaunch.ts`:

```ts
import { randomUUID } from 'node:crypto';
```

Extend `LaunchAgentInPaneOptions`:

```ts
export interface LaunchAgentInPaneOptions {
  paneId: string;
  agent: AgentName;
  prompt: string;
  slug: string;
  projectRoot: string;
  worktreePath?: string;
  permissionMode?: PermissionMode;
  psychePaneId?: string;
  codexHookEventFile?: string;
  generateCovenSessionId?: () => string;
  tmuxService?: Pick<
    TmuxService,
    'sendShellCommand' | 'sendTmuxKeys' | 'getPaneCurrentCommand'
  >;
}
```

Destructure the generator with its production default:

```ts
const {
  paneId,
  agent,
  prompt,
  slug,
  projectRoot,
  worktreePath,
  permissionMode,
  psychePaneId,
  codexHookEventFile,
  generateCovenSessionId = randomUUID,
  tmuxService = TmuxService.getInstance(),
} = options;
```

Generate the context once, before choosing the prompt path:

```ts
const commandContext: AgentCommandContext | undefined = agent === 'coven-code'
  ? { covenSessionId: generateCovenSessionId() }
  : undefined;
```

Pass `commandContext` to all three builder calls in `launchAgentInPane`:

```ts
launchCommand = `${promptBootstrap}; ${buildInitialPromptCommand(
  agent,
  '"$PSYCHE_PROMPT_CONTENT"',
  permissionMode,
  commandContext,
)}`;
```

```ts
launchCommand = buildInitialPromptCommand(
  agent,
  `"${escapedPrompt}"`,
  permissionMode,
  commandContext,
);
```

```ts
launchCommand = buildAgentCommand(agent, permissionMode, commandContext);
```

Do not alter the existing `if (agent === 'codex')` hook wrapper.

- [ ] **Step 5: Run both focused suites**

Run:

```bash
pnpm vitest --run __tests__/agentLaunch.test.ts __tests__/launchAgentInPane.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the per-pane session launch**

```bash
git add src/utils/agentLaunch.ts __tests__/launchAgentInPane.test.ts
git commit -m "fix: assign Coven Code pane sessions"
```

### Task 3: Verify the TUI Launch Surface

**Files:**
- Verify: `src/utils/agentLaunch.ts`
- Verify: `__tests__/agentLaunch.test.ts`
- Verify: `__tests__/launchAgentInPane.test.ts`

- [ ] **Step 1: Run the focused regression suites**

Run:

```bash
pnpm vitest --run __tests__/agentLaunch.test.ts __tests__/launchAgentInPane.test.ts
```

Expected: PASS with all Coven registry, command-building, UUID lifecycle,
prompt-safety, and Codex-hook tests green.

- [ ] **Step 2: Run the test TypeScript compiler**

Run:

```bash
pnpm run typecheck:tests
```

Expected: PASS with no signature or fixture type errors.

- [ ] **Step 3: Inspect the final diff for retired launch commands**

Run:

```bash
git --no-pager diff HEAD~2 -- \
  src/utils/agentLaunch.ts \
  __tests__/agentLaunch.test.ts \
  __tests__/launchAgentInPane.test.ts
```

Expected: the active `coven-code` registry entry and launch expectations use
`coven code`; `coven-code` remains only as the stable agent ID, display-related
slug, and test descriptions. The `agent === 'codex'` hook wrapper is unchanged.
