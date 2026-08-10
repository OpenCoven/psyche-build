const EM_DASH = "—";
const ELLIPSIS = "…";
const NOT_REPORTED = "not reported";
const LOADING = "loading";

export const FOOTER_TIERS = Object.freeze({
  FULL: "full",
  NO_SESSION: "no-session",
  NO_SPEND: "no-spend",
  NO_CONTEXT: "no-context",
  CORE: "core",
  COMPACT: "compact",
});

const AGENT_PANE_KINDS = Object.freeze([
  "coven-chat",
  "coven-attach",
  "agent-copilot",
  "agent-codex",
  "agent-anthropic",
  "agent-grok-build",
]);

export function isAgentPaneKind(kind) {
  return AGENT_PANE_KINDS.includes(kind);
}

export function footerTier(width) {
  if (width >= 720) return FOOTER_TIERS.FULL;
  if (width >= 620) return FOOTER_TIERS.NO_SESSION;
  if (width >= 540) return FOOTER_TIERS.NO_SPEND;
  if (width >= 460) return FOOTER_TIERS.NO_CONTEXT;
  if (width >= 380) return FOOTER_TIERS.CORE;
  return FOOTER_TIERS.COMPACT;
}

export function hiddenFooterKeys(tier, isAgent) {
  if (!isAgent) return tier === FOOTER_TIERS.COMPACT ? ["pane"] : [];
  if (tier === FOOTER_TIERS.NO_SESSION) return ["session"];
  if (tier === FOOTER_TIERS.NO_SPEND) return ["session", "spend"];
  if (tier === FOOTER_TIERS.NO_CONTEXT) return ["session", "spend", "context"];
  if (tier === FOOTER_TIERS.CORE || tier === FOOTER_TIERS.COMPACT) {
    return ["session", "spend", "context", "model"];
  }
  return [];
}

export function formatContext(used, limit) {
  if (!Number.isFinite(used) || used < 0 || !Number.isFinite(limit) || limit <= 0) {
    return EM_DASH;
  }
  return `${Math.max(0, Math.min(100, Math.round((used / limit) * 100)))}%`;
}

export function formatSpend(value) {
  return Number.isFinite(value) && value >= 0 ? `$${value.toFixed(2)}` : EM_DASH;
}

function metricValue(metrics, formatter) {
  if (!metrics || metrics.phase === "idle" || metrics.phase === "loading") {
    return ELLIPSIS;
  }
  return formatter(metrics);
}

function metricA11yValue(metrics, formatter) {
  if (!metrics || metrics.phase === "idle" || metrics.phase === "loading") {
    return LOADING;
  }
  return formatter(metrics);
}

function footerValue(value, fallback) {
  return value ? String(value) : fallback;
}

function contextFullValue(metrics) {
  return Number.isFinite(metrics && metrics.contextUsed) &&
    Number.isFinite(metrics && metrics.contextLimit)
    ? `${metrics.contextUsed} / ${metrics.contextLimit} tokens`
    : "";
}

function spendFullValue(metrics) {
  return Number.isFinite(metrics && metrics.spendUsd)
    ? `$${metrics.spendUsd.toFixed(4)}`
    : "";
}

export function footerItems(state) {
  const metrics = state.metrics;
  const core = [
    {
      key: "branch",
      label: "Branch",
      value: footerValue(state.branch, "detached"),
      fullValue: footerValue(state.branch, "detached"),
      a11yValue: footerValue(state.branch, "detached"),
      action: "copy",
    },
    {
      key: "worktree",
      label: "Worktree",
      value: footerValue(state.worktreeLabel, state.worktreePath || "worktree"),
      fullValue: footerValue(state.worktreePath, ""),
      a11yValue: footerValue(state.worktreePath, footerValue(
        state.worktreeLabel,
        "worktree",
      )),
      action: "reveal",
    },
  ];

  if (!isAgentPaneKind(state.kind)) {
    return core.concat([{
      key: "pane",
      label: "Pane ID",
      value: footerValue(state.paneId, ""),
      fullValue: footerValue(state.paneId, ""),
      a11yValue: footerValue(state.paneId, NOT_REPORTED),
      action: "copy",
    }]);
  }

  return core.concat([
    {
      key: "model",
      label: "Model",
      value: metricValue(metrics, (current) => footerValue(current.model, EM_DASH)),
      fullValue: footerValue(metrics && metrics.model, ""),
      a11yValue: metricA11yValue(metrics, (current) => footerValue(current.model, NOT_REPORTED)),
      action: metrics && metrics.canSwitchModel ? "switch-model" : "usage",
    },
    {
      key: "session",
      label: "Session ID",
      value: metricValue(metrics, (current) => current.sessionId ? current.sessionId.slice(0, 8) : EM_DASH),
      fullValue: footerValue(metrics && metrics.sessionId, ""),
      a11yValue: metricA11yValue(metrics, (current) => footerValue(current.sessionId, NOT_REPORTED)),
      action: "copy",
    },
    {
      key: "context",
      label: "Context",
      value: metricValue(metrics, (current) => formatContext(current.contextUsed, current.contextLimit)),
      fullValue: contextFullValue(metrics),
      a11yValue: metricA11yValue(metrics, (current) => contextFullValue(current) || NOT_REPORTED),
      action: "usage",
    },
    {
      key: "spend",
      label: "Spend",
      value: metricValue(metrics, (current) => formatSpend(current.spendUsd)),
      fullValue: spendFullValue(metrics),
      a11yValue: metricA11yValue(metrics, (current) => spendFullValue(current) || NOT_REPORTED),
      action: "usage",
    },
  ]);
}

export function shouldApplyMetricsResponse(thread, response) {
  return Boolean(thread && response)
    && thread.id === response.threadId
    && thread.metricsGeneration === response.generation
    && thread.launch?.covenSessionId === response.sessionId;
}
