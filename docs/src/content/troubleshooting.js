export const meta = { title: 'Troubleshooting' };

export function render() {
  return `
    <h1>Troubleshooting</h1>
    <p class="lead">Start here when psyche does not launch, an agent is missing, panes look stale, merges stop, or a docs preview is not building.</p>

    <h2>Quick Diagnostics</h2>
    <p>For source CLI diagnostics, run the executable from its checkout:</p>
    <pre><code data-lang="bash">node /path/to/psyche-build/psyche doctor
node --version
pnpm --version
tmux -V
git status --short
node /path/to/psyche-build/psyche --version</code></pre>
    <p>When developing psyche itself, use the maintainer doctor command:</p>
    <pre><code data-lang="bash">pnpm run dev:doctor</code></pre>

    <h2>Homebrew Install Fails</h2>
    <table>
      <thead>
        <tr><th>Symptom</th><th>Check</th><th>Fix</th></tr>
      </thead>
      <tbody>
        <tr><td>The GUI does not launch</td><td>The Cask is not installed, Gatekeeper rejected the app, or launch state is corrupt</td><td>Reinstall, verify the signed app identity, run <code>open -a "Psyche Build"</code>, and report any trust failure rather than bypassing it</td></tr>
        <tr><td>Cask name not found</td><td>The local tap metadata is stale or the tap is not configured</td><td>Run <code>brew update</code>, then confirm <code>opencoven/tap/psyche-build</code> resolves</td></tr>
        <tr><td>Checksum mismatch</td><td>The Cask and release assets disagree</td><td>Stop and report the release integrity failure; do not bypass Homebrew verification</td></tr>
      </tbody>
    </table>
    <p>The supported public <code>v0.0.1</code> install path is:</p>
    <pre><code data-lang="bash">brew install --cask opencoven/tap/psyche-build
open -a "Psyche Build"</code></pre>
    <p>The Cask installs only <code>Psyche Build.app</code>. It does not provide a <code>psyche</code> command. The Node CLI is not an npm release in 0.0.1; source-development recovery uses <code>node /path/to/psyche-build/psyche</code> from the repository checkout.</p>

    <h2>psyche Will Not Start</h2>
    <ul>
      <li>Run from inside a git repository. psyche expects a project root it can associate with panes and worktrees.</li>
      <li>Confirm tmux is installed with <code>tmux -V</code>.</li>
      <li>Check whether an old session is still running with <code>tmux list-sessions | grep psyche</code>.</li>
      <li>If panes look stale after a crash, restart psyche from the project root and let it rehydrate pane state.</li>
    </ul>

    <h2>Agent Does Not Appear</h2>
    <p>psyche only shows agents that are installed, enabled, and detectable.</p>
    <ol>
      <li>Confirm the agent CLI works from the same shell where you launch psyche.</li>
      <li>Open psyche settings with <kbd>s</kbd> and check <strong>Enabled Agents</strong>.</li>
      <li>If you installed the agent in a custom path, add that path to your shell profile before launching psyche.</li>
      <li>Set <code>defaultAgent</code> only after the agent appears in the selector.</li>
    </ol>

    <h2>Optional session integration is unavailable</h2>
    <p>Psyche Build's core tmux, worktree, agent, merge, pull-request, ritual, settings, and file-browser workflows continue without the optional session provider.</p>
    <p>If you enabled that integration, verify its local service is running for the same canonical project root, then restart or refresh Psyche Build.</p>

    <h2>Branch Names or Commit Messages Are Generic</h2>
    <p>Smart branch names and AI commit messages require OpenRouter.</p>
    <pre><code data-lang="bash">export OPENROUTER_API_KEY="sk-or-v1-..."</code></pre>
    <p>Without that key, psyche still works. It falls back to timestamp-based branch names and generic commit messages.</p>

    <h2>Merge Stops on Conflicts</h2>
    <p>This is expected. psyche keeps conflicts in the worktree branch so main stays clean.</p>
    <ol>
      <li>Jump to the pane with <kbd>j</kbd>.</li>
      <li>Inspect conflicting files with <code>git status</code>.</li>
      <li>Resolve conflicts manually or ask the agent to resolve them.</li>
      <li>Run project validation in the worktree.</li>
      <li>Retry merge from the pane menu.</li>
    </ol>

    <h2>macOS Notifications Do Not Fire</h2>
    <ul>
      <li>Confirm macOS notification permissions allow psyche helper notifications.</li>
      <li>Make sure the pane is not the fully focused psyche pane. Focused panes do not notify.</li>
      <li>Open settings with <kbd>s</kbd> and check the enabled notification sounds.</li>
      <li>Non-macOS systems still show sidebar and border attention state, but do not use the native helper.</li>
    </ul>

    <h2>Docs Preview Is Not Working</h2>
    <table>
      <thead>
        <tr><th>Symptom</th><th>Likely cause</th><th>Fix</th></tr>
      </thead>
      <tbody>
        <tr><td>Dev server will not start</td><td>Docs dependencies are missing</td><td>Run <code>cd docs && npm install</code>, then <code>npm run dev</code></td></tr>
        <tr><td>Preview shows connection refused</td><td>Docs server is not running</td><td>Run <code>cd docs && npm run dev</code></td></tr>
        <tr><td>Build fails on old names</td><td>Imported docs still mention an old package or asset</td><td>Search <code>docs/</code> for old names and replace with psyche-specific copy</td></tr>
        <tr><td>You accidentally made it public</td><td>Funnel is enabled instead of Serve</td><td>Run <code>tailscale serve status</code>, then disable Funnel or reset Serve</td></tr>
      </tbody>
    </table>
  `;
}
