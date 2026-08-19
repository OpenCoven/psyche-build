export const meta = { title: 'Agents' };

export function render() {
  return `
    <h1>Agents</h1>
    <p class="lead">Psyche Build detects supported AI coding agent CLIs and launches them in isolated panes and git worktrees. Each agent remains an optional integration; plain terminal panes work without any agent CLI.</p>

    <h2>Agent Detection</h2>
    <p>Run <code>psyche doctor</code> to see whether this shell can find a supported agent CLI. psyche can still create plain terminal panes when none are installed; install at least one supported CLI when you want prompt-launched agent panes.</p>
    <p>psyche automatically detects installed agents by searching:</p>
    <ol>
      <li>Your shell's command path (<code>command -v</code>)</li>
      <li>Common installation directories:
        <ul>
          <li><code>~/.claude/local/claude</code></li>
          <li><code>~/.local/bin/</code></li>
          <li><code>/usr/local/bin/</code></li>
          <li><code>/opt/homebrew/bin/</code></li>
        </ul>
      </li>
    </ol>
    <p>If only one agent is found, psyche uses it automatically. If multiple agents are available, you'll be prompted to choose (unless <code>defaultAgent</code> is set in <a href="#/configuration">configuration</a>).</p>

    <h2>Enabling Agents</h2>
    <p>Coven Code, Claude Code, OpenCode, and Codex are enabled by default. To use other agents, open settings by pressing <kbd>s</kbd> and toggle on the agents you want available in the agent selector.</p>

    <h2>Default Agent</h2>
    <p>To focus your preferred agent first in the agent selection dialog, set a default agent:</p>
    <ul>
      <li><strong>TUI:</strong> Press <kbd>s</kbd> → set "Default Agent"</li>
      <li><strong>Config:</strong> Add <code>"defaultAgent": "coven-code"</code> to your settings JSON</li>
      <li><strong>API:</strong> <code>PATCH /api/settings</code> with <code>{"defaultAgent": "coven-code"}</code></li>
    </ul>

    <h2>Permission Modes</h2>
    <p>The <code>permissionMode</code> setting controls what flags psyche passes to each agent:</p>
    <table>
      <thead>
        <tr><th>permissionMode</th><th>Coven Code</th><th>Claude Code</th><th>Codex</th><th>opencode</th></tr>
      </thead>
      <tbody>
        <tr><td><code>''</code> (empty)</td><td>No flags</td><td>No flags</td><td>No flags</td><td>No flags</td></tr>
        <tr><td><code>plan</code></td><td><code>--permission-mode plan</code></td><td><code>--permission-mode plan</code></td><td>No flags</td><td>No flags</td></tr>
        <tr><td><code>acceptEdits</code></td><td><code>--permission-mode accept-edits</code></td><td><code>--permission-mode acceptEdits</code></td><td><code>--ask-for-approval untrusted --sandbox danger-full-access</code></td><td>No flags</td></tr>
        <tr><td><code>bypassPermissions</code></td><td><code>--permission-mode bypass-permissions</code></td><td><code>--dangerously-skip-permissions</code></td><td><code>--dangerously-bypass-approvals-and-sandbox</code></td><td>No flags</td></tr>
      </tbody>
    </table>

    <h2>Autopilot Mode</h2>
    <p>When <code>enableAutopilotByDefault</code> is enabled in <a href="#/configuration">settings</a>, psyche will automatically accept agent option dialogs when no risk is detected. This reduces manual intervention while agents work.</p>
    <p>This setting controls dialog handling and is separate from <code>permissionMode</code>.</p>

    <div class="callout callout-warning">
      <div class="callout-title">Caution</div>
      With the default <code>permissionMode</code> (<code>bypassPermissions</code>), Claude and Codex run with full-permission flags. Combined with autopilot, this provides highly autonomous behavior. Use only in isolated/trusted environments.
    </div>

    <h2>Agent Status Detection</h2>
    <p>psyche monitors each agent pane to determine its current state. This is used to show status indicators in the sidebar.</p>
    <p>The detection works by:</p>
    <ol>
      <li><strong>Activity tracking</strong> — if the terminal content is changing, the agent is considered "working"</li>
      <li><strong>LLM analysis</strong> — when activity stops, psyche uses a lightweight LLM (grok-4-fast, free tier) to analyze the terminal content and determine if the agent is waiting for input, showing a dialog, or idle</li>
      <li><strong>User typing detection</strong> — if the user is typing, psyche avoids false positives</li>
    </ol>
    <p>Each pane has its own worker thread that polls every second without blocking the main UI.</p>
  `;
}
