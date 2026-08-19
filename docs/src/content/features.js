export const meta = { title: 'Feature Map' };

export function render() {
  return `
    <h1>Feature Map</h1>
    <p class="lead">Use this page as a map of what psyche can do and where to go next. psyche is local-first: it coordinates tmux panes, git worktrees, agents, review tools, merge automation, and notifications from one project-scoped TUI.</p>

    <h2>At a Glance</h2>
    <table>
      <thead>
        <tr><th>Feature</th><th>Use it when</th><th>Start here</th></tr>
      </thead>
      <tbody>
        <tr><td>Project sessions</td><td>You want one stable psyche session per repository</td><td><a href="#/core-concepts">Core Concepts</a></td></tr>
        <tr><td>Worktree panes</td><td>You want several agents working without touching the same checkout</td><td><a href="#/getting-started">Getting Started</a></td></tr>
        <tr><td>Agent registry</td><td>You use Claude Code, Codex, opencode, Gemini, Qwen, Amp, Cursor, Copilot, Cline, Crush, or pi</td><td><a href="#/agents">Agents</a></td></tr>
        <tr><td>Two-lane comparison</td><td>You want two agents to attempt the same task independently</td><td><a href="#/multi-agent">Multi-Agent</a></td></tr>
        <tr><td>Shared-worktree agents</td><td>You want another agent or shell attached to an existing branch</td><td><a href="#/workflows">Workflows</a></td></tr>
        <tr><td>File browser</td><td>You want to inspect files and diffs without leaving psyche</td><td><a href="#/workflows">Workflows</a></td></tr>
        <tr><td>Pane visibility controls</td><td>You want to focus one pane or one project without stopping background work</td><td><a href="#/keyboard-shortcuts">Keyboard Shortcuts</a></td></tr>
        <tr><td>Two-phase merge</td><td>You want conflicts resolved in worktrees before anything lands on main</td><td><a href="#/merging">Merging</a></td></tr>
        <tr><td>Hooks</td><td>You want project-specific setup, validation, or merge automation</td><td><a href="#/hooks">Hooks</a></td></tr>
        <tr><td>Docs preview</td><td>You want to review the public docs site locally before shipping</td><td><a href="#/remote-access">Docs Preview</a></td></tr>
      </tbody>
    </table>

    <h2>Parallel Work</h2>
    <p>Each psyche pane maps to a git worktree and branch. That means one agent can refactor a parser, another can fix tests, and a third can inspect the result without requiring stash juggling or checkout switching.</p>
    <ul>
      <li><strong>Project-scoped tmux sessions:</strong> running <code>psyche</code> inside a repo creates or attaches to the same stable session for that repo.</li>
      <li><strong>One worktree per work pane:</strong> agent panes get isolated filesystem state and their own branch.</li>
      <li><strong>Child worktrees:</strong> use <kbd>b</kbd> when you need a follow-up branch from an existing pane's current state.</li>
      <li><strong>Plain terminals:</strong> use <kbd>t</kbd> for a new shell worktree or <kbd>A</kbd> to add a shell to the selected worktree.</li>
    </ul>

    <h2>Review and Navigation</h2>
    <p>psyche gives you several ways to inspect work before merging it.</p>
    <ul>
      <li><strong>Sidebar status:</strong> panes show their slug, prompt, project group, hidden state, and attention state.</li>
      <li><strong>Read-only file browser:</strong> press <kbd>f</kbd> to inspect the selected worktree, filter files, and switch between source and diff views.</li>
      <li><strong>Pane menus:</strong> press <kbd>m</kbd> from the sidebar or <kbd>Alt+Shift+M</kbd> from an active tmux pane to act on that pane.</li>
      <li><strong>Visibility controls:</strong> use <kbd>h</kbd>, <kbd>H</kbd>, and <kbd>P</kbd> to reduce visual noise without stopping background agents.</li>
    </ul>

    <h2>Automation Boundaries</h2>
    <p>psyche automates repetitive development tasks, but the important state stays visible.</p>
    <ul>
      <li><strong>OpenRouter-assisted naming:</strong> prompts can become useful branch slugs when <code>OPENROUTER_API_KEY</code> is configured.</li>
      <li><strong>Commit message generation:</strong> merge auto-commit can summarize the diff before merging.</li>
      <li><strong>Autopilot:</strong> low-risk agent options can be accepted automatically when enabled in settings.</li>
      <li><strong>Hooks:</strong> projects can install dependencies on worktree creation, run validation before merge, or notify external systems after merge.</li>
    </ul>

    <h2>Merge and Cleanup</h2>
    <p>The merge flow is intentionally conservative. psyche auto-commits worktree changes, merges the target branch into the worktree first, and only merges back to the target branch after that succeeds.</p>
    <div class="callout callout-info">
      <div class="callout-title">Review point</div>
      If conflicts appear, they stay in the worktree branch. Fix them there, rerun validation, then retry the merge from the pane menu.
    </div>

    <h2>Native macOS Helper</h2>
    <p>On macOS, psyche can use its bundled helper app to determine whether the psyche terminal window is truly focused and to send native notifications for background panes that need attention. On other platforms, the helper path stays inert and psyche continues to work as a tmux-based TUI.</p>

    <h2>Where to Go Next</h2>
    <ul>
      <li><a href="#/workflows">Workflows</a> for task-by-task usage recipes</li>
      <li><a href="#/troubleshooting">Troubleshooting</a> for common failures and recovery commands</li>
      <li><a href="#/remote-access">Docs Preview</a> for local docs review</li>
    </ul>
  `;
}
