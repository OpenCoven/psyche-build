export const meta = { title: 'Docs Preview' };

export function render() {
  return `
    <h1>Docs Preview</h1>
    <p class="lead">psyche itself is a local terminal application. The docs site is a static local preview surface for reviewing the public manual before it ships.</p>

    <h2>Run the docs locally</h2>
    <pre><code data-lang="bash">cd docs
npm install
npm run dev</code></pre>

    <p>The Vite dev server serves the single-page docs app from <code>docs/src</code> and static assets from <code>docs/public</code>.</p>

    <h2>Private review</h2>
    <p>If you need to review from another device, expose the localhost docs server with your private network tooling. Keep this separate from psyche runtime sessions and do not expose project worktrees publicly.</p>

    <h2>Production build</h2>
    <pre><code data-lang="bash">cd docs
npm run build
npm run preview</code></pre>

    <p>The production build should stay static, branded as psyche, and free of old package names.</p>
  `;
}
