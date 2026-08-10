const EM_DASH = "—";
const ELLIPSIS = "…";

export const FOOTER_TIERS = Object.freeze({
  FULL: "full",
  NO_SESSION: "no-session",
  NO_SPEND: "no-spend",
  NO_CONTEXT: "no-context",
  CORE: "core",
  COMPACT: "compact",
});

export function isAgentPaneKind(kind) {
  return kind !== "shell" && kind !== "web";
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

function footerValue(value, fallback) {
  return value ? String(value) : fallback;
}

export function footerItems(state) {
  const metrics = state.metrics;
  const core = [
    {
      key: "branch",
      label: "Branch",
      value: footerValue(state.branch, "detached"),
      fullValue: footerValue(state.branch, "detached"),
      action: "copy",
    },
    {
      key: "worktree",
      label: "Worktree",
      value: footerValue(state.worktreeLabel, state.worktreePath || "worktree"),
      fullValue: footerValue(state.worktreePath, ""),
      action: "reveal",
    },
  ];

  if (!isAgentPaneKind(state.kind)) {
    return core.concat([{
      key: "pane",
      label: "Pane ID",
      value: footerValue(state.paneId, ""),
      fullValue: footerValue(state.paneId, ""),
      action: "copy",
    }]);
  }

  return core.concat([
    {
      key: "model",
      label: "Model",
      value: metricValue(metrics, (current) => footerValue(current.model, EM_DASH)),
      fullValue: footerValue(metrics && metrics.model, ""),
      action: metrics && metrics.canSwitchModel ? "switch-model" : "usage",
    },
    {
      key: "session",
      label: "Session ID",
      value: metricValue(metrics, (current) => current.sessionId ? current.sessionId.slice(0, 8) : EM_DASH),
      fullValue: footerValue(metrics && metrics.sessionId, ""),
      action: "copy",
    },
    {
      key: "context",
      label: "Context",
      value: metricValue(metrics, (current) => formatContext(current.contextUsed, current.contextLimit)),
      fullValue: Number.isFinite(metrics && metrics.contextUsed) &&
        Number.isFinite(metrics && metrics.contextLimit)
        ? `${metrics.contextUsed} / ${metrics.contextLimit} tokens`
        : "",
      action: "usage",
    },
    {
      key: "spend",
      label: "Spend",
      value: metricValue(metrics, (current) => formatSpend(current.spendUsd)),
      fullValue: Number.isFinite(metrics && metrics.spendUsd)
        ? `$${metrics.spendUsd.toFixed(4)}`
        : "",
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
