export const meta = { title: 'Hooks' };

export function render() {
  return `
    <h1>Hooks</h1>
    <p class="lead">psyche provides 11 lifecycle hooks that let you run custom scripts at key moments — from pane creation to merge completion. Hooks are simple shell scripts that receive context via environment variables.</p>

    <h2>Creating Hooks with AI</h2>
    <p>The easiest way to create and edit hooks is with psyche's AI-assisted authoring:</p>
    <ol>
      <li>Focus the main psyche pane and press <kbd>h</kbd></li>
      <li>psyche initializes a <code>.psyche-hooks/</code> directory with documentation and example hooks</li>
      <li>A new pane opens with an AI agent that walks you through creating or editing hooks for your project</li>
    </ol>
    <p>The agent understands all available hook types and environment variables, so you can describe what you want in plain language — like "install dependencies when a worktree is created" or "run tests before merging" — and it will write the scripts for you.</p>

    <div class="callout callout-tip">
      <div class="callout-title">Tip</div>
      Press <kbd>?</kbd> to see all available shortcuts, or access hook authoring from the settings menu with <kbd>s</kbd> → "Manage Hooks".
    </div>

    <h2>Manual Setup</h2>
    <p>You can also create hooks by hand. Hooks are shell scripts placed in a hooks directory. psyche searches for hooks in this priority order:</p>
    <ol>
      <li><code>.psyche-hooks/</code> — project root (highest priority)</li>
      <li><code>.psyche/hooks/</code> — inside the psyche data directory</li>
      <li><code>~/.psyche/hooks/</code> — global hooks (lowest priority)</li>
    </ol>
    <p>The first directory found is used. Scripts must be executable (<code>chmod +x</code>).</p>
    <p>To create the directory manually:</p>
    <pre><code data-lang="bash">mkdir -p .psyche-hooks
chmod +x .psyche-hooks/*</code></pre>

    <h2>Available Hooks</h2>
    <p>Each hook is a script file named exactly as shown below. All hooks receive environment variables with context about the current operation.</p>

    <h3>Pane Lifecycle</h3>

    <h4><code>before_pane_create</code></h4>
    <p>Runs before a new pane is created. Can be used for validation or setup.</p>
    <table>
      <thead><tr><th>Variable</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td><code>PSYCHE_SLUG</code></td><td>The slug (branch name) for the new pane</td></tr>
        <tr><td><code>PSYCHE_PROMPT</code></td><td>The user's prompt text</td></tr>
        <tr><td><code>PSYCHE_AGENT</code></td><td>The selected agent (claude, opencode, codex)</td></tr>
        <tr><td><code>PSYCHE_ROOT</code></td><td>Path to the project root</td></tr>
      </tbody>
    </table>

    <h4><code>pane_created</code></h4>
    <p>Runs after a pane has been created and the agent is launched.</p>
    <table>
      <thead><tr><th>Variable</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td><code>PSYCHE_PANE_ID</code></td><td>The psyche pane ID (e.g. psyche-1)</td></tr>
        <tr><td><code>PSYCHE_SLUG</code></td><td>The slug (branch name)</td></tr>
        <tr><td><code>PSYCHE_PROMPT</code></td><td>The user's prompt text</td></tr>
        <tr><td><code>PSYCHE_AGENT</code></td><td>The agent being used</td></tr>
        <tr><td><code>PSYCHE_TMUX_PANE_ID</code></td><td>The tmux pane ID (e.g. %38)</td></tr>
        <tr><td><code>PSYCHE_WORKTREE_PATH</code></td><td>Path to the worktree</td></tr>
        <tr><td><code>PSYCHE_ROOT</code></td><td>Path to the project root</td></tr>
      </tbody>
    </table>

    <h4><code>worktree_created</code></h4>
    <p>Runs after the git worktree is created but before the agent launches. Useful for installing dependencies or copying config files.</p>
    <table>
      <thead><tr><th>Variable</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td><code>PSYCHE_SLUG</code></td><td>The slug (branch name)</td></tr>
        <tr><td><code>PSYCHE_WORKTREE_PATH</code></td><td>Path to the new worktree</td></tr>
        <tr><td><code>PSYCHE_BRANCH</code></td><td>Git branch name</td></tr>
        <tr><td><code>PSYCHE_ROOT</code></td><td>Path to the project root</td></tr>
      </tbody>
    </table>

    <div class="callout callout-tip">
      <div class="callout-title">Common use case</div>
      Use <code>worktree_created</code> to run <code>npm install</code> or <code>pnpm install</code> in the new worktree, so the agent has all dependencies ready.
    </div>

    <h4><code>before_pane_close</code></h4>
    <p>Runs before a pane is closed.</p>
    <table>
      <thead><tr><th>Variable</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td><code>PSYCHE_PANE_ID</code></td><td>The psyche pane ID</td></tr>
        <tr><td><code>PSYCHE_SLUG</code></td><td>The slug</td></tr>
        <tr><td><code>PSYCHE_TMUX_PANE_ID</code></td><td>The tmux pane ID</td></tr>
        <tr><td><code>PSYCHE_WORKTREE_PATH</code></td><td>Path to the worktree</td></tr>
      </tbody>
    </table>

    <h4><code>pane_closed</code></h4>
    <p>Runs after a pane has been closed.</p>
    <table>
      <thead><tr><th>Variable</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td><code>PSYCHE_PANE_ID</code></td><td>The psyche pane ID</td></tr>
        <tr><td><code>PSYCHE_SLUG</code></td><td>The slug</td></tr>
      </tbody>
    </table>

    <h3>Worktree Lifecycle</h3>

    <h4><code>before_worktree_remove</code></h4>
    <p>Runs before a worktree is removed (during close or merge cleanup).</p>
    <table>
      <thead><tr><th>Variable</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td><code>PSYCHE_SLUG</code></td><td>The slug</td></tr>
        <tr><td><code>PSYCHE_WORKTREE_PATH</code></td><td>Path to the worktree</td></tr>
        <tr><td><code>PSYCHE_BRANCH</code></td><td>Git branch name</td></tr>
      </tbody>
    </table>

    <h4><code>worktree_removed</code></h4>
    <p>Runs after a worktree has been removed.</p>
    <table>
      <thead><tr><th>Variable</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td><code>PSYCHE_SLUG</code></td><td>The slug</td></tr>
        <tr><td><code>PSYCHE_BRANCH</code></td><td>Git branch that was deleted</td></tr>
      </tbody>
    </table>

    <h3>Merge Hooks</h3>

    <h4><code>pre_merge</code></h4>
    <p>Runs before the merge process begins. Can be used to run tests or validation.</p>
    <table>
      <thead><tr><th>Variable</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td><code>PSYCHE_PANE_ID</code></td><td>The psyche pane ID</td></tr>
        <tr><td><code>PSYCHE_SLUG</code></td><td>The slug</td></tr>
        <tr><td><code>PSYCHE_WORKTREE_PATH</code></td><td>Path to the worktree</td></tr>
        <tr><td><code>PSYCHE_BRANCH</code></td><td>Branch being merged</td></tr>
        <tr><td><code>PSYCHE_TARGET_BRANCH</code></td><td>Target branch (e.g. main)</td></tr>
      </tbody>
    </table>

    <h4><code>post_merge</code></h4>
    <p>Runs after a successful merge.</p>
    <table>
      <thead><tr><th>Variable</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td><code>PSYCHE_PANE_ID</code></td><td>The psyche pane ID</td></tr>
        <tr><td><code>PSYCHE_SLUG</code></td><td>The slug</td></tr>
        <tr><td><code>PSYCHE_BRANCH</code></td><td>Branch that was merged</td></tr>
        <tr><td><code>PSYCHE_TARGET_BRANCH</code></td><td>Target branch</td></tr>
      </tbody>
    </table>

    <h3>Action Hooks</h3>

    <h4><code>run_test</code></h4>
    <p>Triggered from the pane menu "Run Test" action. Used to execute your project's test suite in the worktree.</p>
    <table>
      <thead><tr><th>Variable</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td><code>PSYCHE_PANE_ID</code></td><td>The psyche pane ID</td></tr>
        <tr><td><code>PSYCHE_SLUG</code></td><td>The slug</td></tr>
        <tr><td><code>PSYCHE_WORKTREE_PATH</code></td><td>Path to the worktree</td></tr>
        <tr><td><code>PSYCHE_TMUX_PANE_ID</code></td><td>The tmux pane ID</td></tr>
      </tbody>
    </table>

    <h4><code>run_dev</code></h4>
    <p>Triggered from the pane menu "Run Dev" action. Used to start a dev server in the worktree.</p>
    <table>
      <thead><tr><th>Variable</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td><code>PSYCHE_PANE_ID</code></td><td>The psyche pane ID</td></tr>
        <tr><td><code>PSYCHE_SLUG</code></td><td>The slug</td></tr>
        <tr><td><code>PSYCHE_WORKTREE_PATH</code></td><td>Path to the worktree</td></tr>
        <tr><td><code>PSYCHE_TMUX_PANE_ID</code></td><td>The tmux pane ID</td></tr>
      </tbody>
    </table>

    <h2>HTTP Callback API</h2>
    <p>The <code>run_test</code> and <code>run_dev</code> hooks can report back over HTTP. Psyche Build exposes the port it is listening on; you build the URL yourself:</p>
    <table>
      <thead><tr><th>Variable</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td><code>PSYCHE_SERVER_PORT</code></td><td>Port of the local HTTP server, e.g. <code>3142</code></td></tr>
      </tbody>
    </table>
    <pre><code data-lang="bash">curl -X PUT "http://localhost:$PSYCHE_SERVER_PORT/api/panes/$PSYCHE_PANE_ID/test" \\
  -H "Content-Type: application/json" \\
  -d '{"status":"passed"}'</code></pre>
    <p>This lets you report test results or dev server status back to the pane.</p>

    <h2>Example Hooks</h2>

    <h3>Install dependencies on worktree creation</h3>
    <pre><code data-lang="bash">#!/bin/bash
# .psyche-hooks/worktree_created

cd "$PSYCHE_WORKTREE_PATH"

# Install Node.js dependencies
if [ -f "pnpm-lock.yaml" ]; then
  pnpm install --frozen-lockfile
elif [ -f "package-lock.json" ]; then
  npm ci
elif [ -f "yarn.lock" ]; then
  yarn install --frozen-lockfile
fi</code></pre>

    <h3>Run tests before merge</h3>
    <pre><code data-lang="bash">#!/bin/bash
# .psyche-hooks/pre_merge

cd "$PSYCHE_WORKTREE_PATH"
npm test

# If tests fail, the non-zero exit code will abort the merge
if [ $? -ne 0 ]; then
  echo "Tests failed — aborting merge"
  exit 1
fi</code></pre>

    <h3>Notify on merge completion</h3>
    <pre><code data-lang="bash">#!/bin/bash
# .psyche-hooks/post_merge

# Send a desktop notification (macOS)
osascript -e "display notification \\"Merged $PSYCHE_SLUG into $PSYCHE_TARGET_BRANCH\\" with title \\"psyche\\""</code></pre>

    <div class="callout callout-warning">
      <div class="callout-title">Important</div>
      Hook scripts must be executable. Run <code>chmod +x .psyche-hooks/*</code> after creating them. Hooks that exit with a non-zero status code will abort the operation for <code>pre_merge</code> and <code>before_pane_create</code>.
    </div>
  `;
}
