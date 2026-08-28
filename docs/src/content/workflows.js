export const meta = { title: 'Workflows' };

export function render() {
  return `
    <h1>Workflows</h1>
    <p class="lead">These are the common psyche loops: launch a task in one or more lanes, compare lanes, inspect the result, integrate cleanly, and keep background lanes visible enough to trust. A <strong>task</strong> is one requested outcome, a <strong>lane</strong> is one agent or terminal working on it, and <strong>integration</strong> is how you inspect, merge, PR, or clean up that work.</p>

    <h2>Ship a Small Fix with One Agent</h2>
    <ol>
      <li>Run <code>psyche</code> from the repository you want to edit.</li>
      <li>Press <kbd>n</kbd>, describe the fix, and choose an installed agent.</li>
      <li>Press <kbd>j</kbd> to watch the agent when you need detail, or stay in the sidebar and let status tracking run.</li>
      <li>Press <kbd>f</kbd> to inspect changed files in read-only mode.</li>
      <li>Press <kbd>m</kbd>, choose <strong>Merge</strong>, and let psyche auto-commit, merge, and clean up.</li>
    </ol>

    <h2>Compare Two Lanes on the Same Prompt</h2>
    <p>Running two agents on one task is a two-lane comparison — a plain multi-select launch with two agents, not a special product mode. It is useful when you want different model or tooling instincts without manually duplicating the prompt.</p>
    <ol>
      <li>Press <kbd>n</kbd> and enter the task once.</li>
      <li>Select two agents such as <strong>Claude Code</strong> and <strong>Codex</strong>.</li>
      <li>psyche creates two isolated lanes with the same prompt and agent-specific suffixes.</li>
      <li>Use <kbd>j</kbd>, <kbd>f</kbd>, and the pane menu to compare implementation quality.</li>
      <li>Merge the better branch and close the other lane when you are done.</li>
    </ol>

    <h2>Collaborate on One Worktree</h2>
    <p>Sometimes the right move is not a competition. Attach another agent or a shell to the same branch when you want review, test execution, or manual inspection against the same files.</p>
    <table>
      <thead>
        <tr><th>Action</th><th>Shortcut</th><th>Result</th></tr>
      </thead>
      <tbody>
        <tr><td>Add another agent</td><td><kbd>a</kbd></td><td>Launches a sibling agent pane in the selected worktree</td></tr>
        <tr><td>Add a terminal</td><td><kbd>A</kbd></td><td>Opens a shell in the selected worktree</td></tr>
        <tr><td>Open in editor</td><td>Pane menu</td><td>Opens the worktree path in your configured editor</td></tr>
        <tr><td>Copy path</td><td>Pane menu</td><td>Copies the worktree path for external tools</td></tr>
      </tbody>
    </table>

    <h2>Review Before Merge</h2>
    <p>Use the file browser as the first review pass when you want signal without giving up the psyche control view.</p>
    <ol>
      <li>Select the pane you want to review.</li>
      <li>Press <kbd>f</kbd> to open the worktree file browser.</li>
      <li>Type to filter files or directories.</li>
      <li>Press <kbd>Enter</kbd> to preview a file.</li>
      <li>Press <kbd>d</kbd> or <kbd>Tab</kbd> to switch between source and diff views.</li>
      <li>Press <kbd>Shift+O</kbd> if you need the directory in Finder or your system file manager.</li>
    </ol>

    <h2>Run a Safer Merge</h2>
    <p>A merge is safest when validation runs inside the worktree before the branch returns to main. Put that validation in <code>.psyche-hooks/pre_merge</code> so the merge path is repeatable.</p>
    <pre><code data-lang="bash">#!/bin/bash
set -euo pipefail

cd "$PSYCHE_WORKTREE_PATH"
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test</code></pre>
    <p>Make the hook executable with <code>chmod +x .psyche-hooks/pre_merge</code>. If the hook exits non-zero, psyche stops the merge.</p>

    <h2>Work Across Multiple Repos</h2>
    <p>Attach related repositories when one task spans frontend, backend, docs, or tooling.</p>
    <ol>
      <li>Start psyche in the first repository.</li>
      <li>Press <kbd>p</kbd> and select another repository.</li>
      <li>Create panes inside that attached project from the same session.</li>
      <li>Use <kbd>←</kbd> and <kbd>→</kbd> to move between project groups.</li>
      <li>Use <kbd>P</kbd> to show only the active project's panes while keeping other projects alive.</li>
    </ol>

    <h2>Preview the Docs Site</h2>
    <p>When docs copy or UI changes, run the static docs site locally before publishing.</p>
    <pre><code data-lang="bash">cd docs
npm install
npm run dev</code></pre>
    <p>Use <a href="#/remote-access">Docs Preview</a> for build and private-review notes.</p>
  `;
}
