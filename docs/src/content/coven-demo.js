export const meta = { title: 'Coven Demo Loop' };

export function render() {
  return `
    <h1>Coven Demo Loop</h1>
    <p class="lead">Use this loop to show how psyche and Coven fit together: one project, any harness, visible work.</p>

    <h2>Prerequisites</h2>
    <pre><code data-lang="bash">npm install -g psyche
npx @opencoven/cli doctor
coven doctor
coven daemon start
coven daemon status</code></pre>
    <p>Coven is optional. If it is not installed or the daemon is stopped, psyche still runs normal tmux panes, worktrees, file browsing, merge, PR, and cleanup flows.</p>

    <h2>Demo Path</h2>
    <ol>
      <li>Run <code>psyche</code> from the repository you want to work in.</li>
      <li>Press <kbd>n</kbd> for a normal psyche agent pane, or press <kbd>d</kbd> to launch the desktop-use Coven pane.</li>
      <li>For a CLI-started Coven session, run <code>coven run codex "fix the failing tests" --title "Fix tests"</code> or <code>coven run claude "review this branch" --title "Review branch"</code> in a terminal pane.</li>
      <li>Watch matching Coven sessions in the side panel for the active project.</li>
      <li>Use <kbd>j</kbd> to watch work, <kbd>f</kbd> to inspect files and diffs, and <kbd>m</kbd> to open the pane menu.</li>
      <li>Finish explicitly: merge, create a GitHub PR, archive, close, or clean up the worktree.</li>
    </ol>

    <h2>Current Contract</h2>
    <p>psyche talks to the local Coven daemon through <code>/api/v1</code>. It accepts the current <code>apiVersion: "coven.daemon.v1"</code> health contract and follows event <code>seq</code> cursors from the paginated events envelope.</p>

    <h2>Unavailable State</h2>
    <p>When Coven is missing or stopped, psyche keeps the unavailable state compact and recoverable. Check the runtime with:</p>
    <pre><code data-lang="bash">command -v coven
coven doctor
coven daemon restart
coven daemon status</code></pre>

    <p>Roadmap context lives in the <a href="https://github.com/OpenCoven/coven/blob/main/docs/ROADMAP.md" target="_blank" rel="noopener">OpenCoven public roadmap</a>.</p>
  `;
}
