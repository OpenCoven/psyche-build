export const meta = { title: 'Multi-Agent' };

export function render() {
  return `
    <h1>Multi-Agent</h1>
    <p class="lead">Psyche Build runs several agents in parallel on the same or related work. Everything below uses one model: a <strong>task</strong> is one requested outcome, a <strong>lane</strong> is one agent or terminal working on it, an <strong>isolation mode</strong> is where that lane runs, and <strong>integration</strong> is how you bring a lane's work back.</p>

    <h2>The Model</h2>
    <ul>
      <li><strong>Task</strong> — one requested outcome.</li>
      <li><strong>Lane</strong> — one agent or terminal working on that task.</li>
      <li><strong>Isolation mode</strong> — an isolated worktree, a shared worktree, a plain terminal, or a Coven-managed session.</li>
      <li><strong>Integration</strong> — inspect, compare, merge, create a PR, archive, or clean up.</li>
    </ul>

    <h2>Launch One or Many Isolated Lanes</h2>
    <p>Press <kbd>n</kbd>, describe the task once, and pick one or more agents (or none for a plain terminal). Each selected agent starts as its own lane in an isolated worktree and branch, all receiving the same prompt.</p>
    <p>For example, with Claude Code and OpenCode available, the multi-select launch offers each agent independently:</p>
    <pre><code data-lang="text">◉ Claude Code
◉ OpenCode
◎ Codex</code></pre>
    <p>Selecting two agents launches two isolated lanes. Psyche Build derives a shared base slug from your prompt (e.g. <code>fix-auth</code>) and appends an agent-specific suffix per lane:</p>
    <table>
      <thead>
        <tr><th>Agent</th><th>Suffix</th></tr>
      </thead>
      <tbody>
        <tr><td>Claude Code</td><td><code>-claude-code</code></td></tr>
        <tr><td>OpenCode</td><td><code>-opencode</code></td></tr>
        <tr><td>Codex</td><td><code>-codex</code></td></tr>
      </tbody>
    </table>
    <p>Because each lane has an independent worktree, the lanes never conflict.</p>

    <h2>Compare Two Lanes (A/B Example)</h2>
    <p>Running two agents on one task is a two-lane comparison, not a special product mode — it is just a multi-select launch with two agents. It is useful when you want different model or tooling instincts on the same prompt.</p>
    <ol>
      <li>Press <kbd>n</kbd> and enter the task once.</li>
      <li>Select two agents, for example Claude Code and Codex.</li>
      <li>Two isolated lanes run the same prompt, e.g. <code>fix-auth-claude-code</code> and <code>fix-auth-codex</code>.</li>
      <li>Jump between lanes with <kbd>j</kbd> to review each agent's work.</li>
      <li>Merge the better result with <kbd>m</kbd>, then close the other lane with <kbd>x</kbd> to discard it.</li>
    </ol>

    <h2>Attach Agents to One Shared Worktree</h2>
    <p>You can also add lanes to an <em>existing</em> worktree so multiple agents collaborate on the same branch and files — useful when one agent handles code and another runs tests, reviews, or provides a second opinion.</p>
    <ol>
      <li>Select a lane in the sidebar.</li>
      <li>Press <kbd>a</kbd> (or open the pane menu and choose <strong>Add Agent to Worktree</strong>).</li>
      <li>Pick which agent to attach; a new lane opens in the same worktree.</li>
      <li>Press <kbd>A</kbd> (Shift+A) to attach a plain terminal to the same worktree for manual commands, inspection, or build monitoring.</li>
    </ol>
    <p>Attached lanes get sibling slugs based on the worktree name — e.g. <code>fix-auth-a2</code>, <code>fix-auth-a3</code>. When you close a lane whose worktree is still used by other lanes, Psyche Build only closes that lane; the worktree stays intact until the last lane using it is closed.</p>

    <h2>Bounded Concurrency and Partial Failure</h2>
    <p>Parallel lanes run with bounded concurrency, so a large launch does not start every agent at once. Lanes are independent: if one lane fails to launch or an agent errors, the other lanes keep running. Each lane's status and output are inspectable on its own, so a partial failure is visible and recoverable without affecting the rest of the task.</p>

    <h2>Daemon and MCP Orchestration</h2>
    <p>Beyond the interactive TUI, lanes can be launched and controlled programmatically. The <code>psyche mcp</code> server exposes the project's leased pane and browser surface over MCP, so a trusted, task-scoped client can dispatch work and observe results:</p>
    <ul>
      <li><code>psyche_execute_task</code> submits an orchestration request that creates one or more lanes for a task.</li>
      <li><code>psyche_create_pane</code> creates a single leased lane through the owner.</li>
      <li><code>psyche_kill_pane</code> closes a lane after approval; it returns the worktree and branch and <strong>does not delete them</strong>, because a worktree can hold the only copy of uncommitted changes.</li>
      <li><code>psyche_list_panes</code> and <code>psyche_get_pane_output</code> observe lane state and bounded output.</li>
    </ul>
    <p>Every mutation passes through the same authenticated authority, policy, approval, and receipt path as the TUI. See <a href="#/agents">Agents</a> and the README's MCP section for the full lease and approval model.</p>

    <h2>Optional Coven and Capability Providers</h2>
    <p>Lanes resolve their execution capability through a provider. The Coven-native provider is the default; Psyche is an optional registration point for additional capabilities. Providers are optional — when a provider is missing or explicitly unavailable, that capability fails closed rather than silently degrading, and ordinary panes, worktrees, merges, and file browsing keep working. A Coven-managed session is one of the available isolation modes when a compatible local session provider is running.</p>

    <h2>Integrate Results Explicitly</h2>
    <p>Integration is always an explicit step, never automatic. Once a lane's work is ready:</p>
    <ul>
      <li>Press <kbd>f</kbd> to inspect changed files and diffs in read-only mode.</li>
      <li>Press <kbd>j</kbd> to jump between lanes (switch tmux focus).</li>
      <li>Press <kbd>m</kbd> to merge, create a GitHub PR, attach another agent, or clean up.</li>
      <li>Press <kbd>x</kbd> to close and discard a lane you do not want.</li>
    </ul>

    <div class="callout callout-tip">
      <div class="callout-title">Tip</div>
      Two-lane comparisons shine on complex tasks where different agents may take very different approaches. Try one on refactoring, architecture decisions, or tricky bug fixes.
    </div>
  `;
}
