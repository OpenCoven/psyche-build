export const meta = { title: 'Introduction' };

export function render() {
  return `
    <h1>What is psyche?</h1>
    <p class="lead">psyche runs multiple coding agents and shell panes in parallel using tmux and git worktrees. It automates the worktree lifecycle, supports multiple projects in one session, includes a built-in read-only file browser for each worktree, and can raise native macOS notifications when background panes need attention. If you provide an OpenRouter key, it will also generate branch names, commit messages, and other quality-of-life automation for you.</p>
    <p>Use <kbd>f</kbd> to browse files inside a pane's worktree, <kbd>h</kbd> and <kbd>H</kbd> to hide panes without stopping them, and <kbd>P</kbd> to focus a single project's panes inside a shared session.</p>

    <div class="agent-cloud">
      <a href="#/agents" class="agent-cloud-item">
        <img src="/agents/claude.svg" alt="Claude Code" class="agent-cloud-logo" />
        <span>Claude Code</span>
      </a>
      <a href="#/agents" class="agent-cloud-item">
        <img src="/agents/opencode.svg" alt="OpenCode" class="agent-cloud-logo" />
        <span>OpenCode</span>
      </a>
      <a href="#/agents" class="agent-cloud-item">
        <img src="/agents/codex.svg" alt="Codex" class="agent-cloud-logo" />
        <span>Codex</span>
      </a>
      <a href="#/agents" class="agent-cloud-item">
        <img src="/agents/cline.svg" alt="Cline" class="agent-cloud-logo" />
        <span>Cline</span>
      </a>
      <a href="#/agents" class="agent-cloud-item">
        <img src="/agents/gemini.svg" alt="Gemini CLI" class="agent-cloud-logo" />
        <span>Gemini</span>
      </a>
      <a href="#/agents" class="agent-cloud-item">
        <img src="/agents/qwen.svg" alt="Qwen CLI" class="agent-cloud-logo" />
        <span>Qwen</span>
      </a>
      <a href="#/agents" class="agent-cloud-item">
        <img src="/agents/amp.svg" alt="Amp" class="agent-cloud-logo" />
        <span>Amp</span>
      </a>
      <a href="#/agents" class="agent-cloud-item">
        <img src="/agents/pi.svg" alt="pi CLI" class="agent-cloud-logo" />
        <span>pi</span>
      </a>
      <a href="#/agents" class="agent-cloud-item">
        <img src="/agents/cursor.svg" alt="Cursor" class="agent-cloud-logo" />
        <span>Cursor</span>
      </a>
      <a href="#/agents" class="agent-cloud-item">
        <img src="/agents/copilot.svg" alt="GitHub Copilot" class="agent-cloud-logo" />
        <span>Copilot</span>
      </a>
      <a href="#/agents" class="agent-cloud-item">
        <img src="/agents/crush.svg" alt="Crush" class="agent-cloud-logo" />
        <span>Crush</span>
      </a>
    </div>

    <div class="sa-banner">
      <div class="sa-banner-inner">
        <div class="sa-banner-content">
          <div class="sa-banner-header">
            <span class="sa-badge">Field Manual</span>
          </div>
          <p class="sa-description">psyche is local-first infrastructure for managing parallel agent work. The docs below are the release surface: start with the workflow map, then use troubleshooting and configuration when you need to understand a project setup.</p>
          <div id="sa-form-wrapper">
            <div class="sa-form sa-link-row">
              <a href="#workflows" class="sa-submit">Read Workflows</a>
              <a href="#configuration" class="sa-submit sa-submit-secondary">Configuration</a>
              <a href="#troubleshooting" class="sa-submit sa-submit-secondary">Troubleshooting</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}
