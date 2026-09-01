// psyche — Tauri prototype workspace shell
// One module, no bundler. The runtime bundle owns xterm's UMD globals and the
// global Tauri API surface exposed via `withGlobalTauri: true`.

(function () {
  "use strict";

  // ============================================================
  // 1. Visible boot diagnostics
  // ============================================================

  function showBootError(msg) {
    var host = document.getElementById("terminal-host");
    if (!host) return;
    host.innerHTML = "";
    var pre = document.createElement("pre");
    pre.className = "boot-error";
    pre.textContent = "psyche boot error\n\n" + msg;
    host.appendChild(pre);
  }

  window.addEventListener("error", function (e) {
    showBootError(String((e.error && e.error.stack) || e.error || e.message));
  });
  window.addEventListener("unhandledrejection", function (e) {
    showBootError("Unhandled promise rejection:\n" + String(e.reason));
  });

  // ============================================================
  // 1a. Compositor-safe transition helper
  // ============================================================
  //
  // Adds `.is-transitioning` for the duration of a transform/opacity
  // transition or animation, giving the compositor a scoped `will-change`
  // hint. The class is removed on transitionend/animationend and, as a
  // safety net against interrupted or never-fired events, after 500 ms so no
  // element keeps a pinned compositor layer.
  function beginCompositorTransition(element) {
    if (!element || !element.classList) return;
    if (element.__compositorTransitionCleanup) {
      element.__compositorTransitionCleanup();
    }
    element.classList.add("is-transitioning");

    var settled = false;
    function finish(event) {
      if (event && event.target !== element) return;
      if (settled) return;
      settled = true;
      element.removeEventListener("transitionend", finish);
      element.removeEventListener("animationend", finish);
      window.clearTimeout(timer);
      element.__compositorTransitionCleanup = null;
      element.classList.remove("is-transitioning");
    }

    var timer = window.setTimeout(finish, 500);
    element.addEventListener("transitionend", finish);
    element.addEventListener("animationend", finish);
    element.__compositorTransitionCleanup = finish;
  }

  function initializeTitlebarBrandMark() {
    var mark = document.getElementById("titlebar-brand-mark");
    if (!mark) return;
    function removeFailedMark() {
      mark.remove();
    }
    mark.addEventListener("error", removeFailedMark, { once: true });
    if (mark.complete && mark.naturalWidth === 0) removeFailedMark();
  }
  initializeTitlebarBrandMark();

  if (typeof window.Terminal !== "function") {
    showBootError("xterm.js did not register a global Terminal constructor.");
    return;
  }
  if (!window.__TAURI__ || !window.__TAURI__.core || !window.__TAURI__.event) {
    showBootError(
      "Tauri global API is not present. This page was opened outside the Tauri runtime.\n\n" +
        "Launch it with:\n  cd native/desktop/psyche-build-tauri\n  pnpm dev\n\n" +
        "Opening web/index.html as file:// or in a normal browser will not inject window.__TAURI__."
    );
    return;
  }
  if (!window.PsycheRuntime ||
      typeof window.PsycheRuntime.createTerminalPaneController !== "function" ||
      typeof window.PsycheRuntime.FrameScheduler !== "function") {
    showBootError("PTY runtime bundle missing. Run `pnpm --dir native/desktop/psyche-build-tauri build:web`.");
    return;
  }

  var statusController = null;
  var ptyRuntime = window.PsycheRuntime;
  // FrameScheduler invokes this callback as a plain function. Bind it to the
  // Window receiver because WebKit enforces the receiver for this Web API.
  var terminalFrameScheduler = new ptyRuntime.FrameScheduler(window.requestAnimationFrame.bind(window));
  var invokeNative = window.__TAURI__.core.invoke;
  var listen = window.__TAURI__.event.listen;
  var opener = window.__TAURI__.opener || null;
  var clipboardManager = window.__TAURI__.clipboardManager || null;
  var openUrl = (opener && opener.openUrl) || null;
  var currentWindow = window.__TAURI__.window && window.__TAURI__.window.getCurrentWindow
    ? window.__TAURI__.window.getCurrentWindow()
    : null;

  function invoke(command, args) {
    var startedAt = performance.now();
    try {
      return Promise.resolve(invokeNative(command, args)).then(
        function (value) {
          if (statusController) {
            statusController.noteOperation(command, performance.now() - startedAt, true);
          }
          return value;
        },
        function (error) {
          if (statusController) {
            statusController.noteOperation(command, performance.now() - startedAt, false);
          }
          throw error;
        }
      );
    } catch (error) {
      if (statusController) {
        statusController.noteOperation(command, performance.now() - startedAt, false);
      }
      throw error;
    }
  }

  // ============================================================
  // 2. State
  // ============================================================

  /**
   * threads = ordered list of { id, projectId, name, kind, command, args, env,
   *                             status: 'starting'|'running'|'exited',
   *                             term, terminalController, host, lastBytes }
   *   `pane` is the thread's framed pane in the canvas; `host` is the xterm
   *   container inside it. Placement lives in the per-worktree pane tree
   *   (`paneLayouts`), not on the thread.
   * projects = ordered list of { id, name, root, collapsed }
   */
  var state = {
    env: null,
    projects: [],
    threads: [],
    activeProjectId: null,
    activeThreadId: null,
    /** Files opened from the Files panel. These are the only things the Files
     *  pane's tab strip shows; projects are switched from the sessions sidebar.
     *  { id, path, rel, name, projectId, text, originalText, dirty, saving,
     *    languageId, cursor, selection, truncated, binary, size, error, saveError } */
    openFiles: [],
    /** The selected tab in the mounted Files pane, whether or not it has focus. */
    activeFileId: null,
    /** Discovered slash commands the active agent harness will recognise.
     *  Refreshed on boot and on project switch via `agent_skills`. */
    agentSkills: [],
  };
  // File focus is presentation-only. Open files persist through state.openFiles,
  // but the pane to return to belongs only to the current interaction.
  var fileFocus = {
    returnThreadId: null,
  };
  var paneLayouts = new Map();
  var filesPanes = new Map();
  var imageDropScaleFactor = 1;
  var imageDropTarget = null;
  var covenEnsureFlights = new Map();
  var covenAttachInFlight = new Map();
  var covenDiscovery = PsycheSessions.createCovenDiscoveryState();
  var covenSessionCloseFlights = new Set();
  var covenSessionMutationGeneration = 0;
  var covenDiscoveryFlight = null;
  var covenPollTimer = null;
  var COVEN_POLL_MS = 5000;
  // The pinned Coven launch profile: prompt-backed provider launches are
  // accepted only by this daemon API version, with the composer prompt
  // transported in the launch request body — never as process argv and
  // never into the persisted launch model.
  var COVEN_LAUNCH_API_VERSION = "coven.daemon.v1";
  var COVEN_LAUNCH_PROMPT_MAX_CHARS = 8192;
  var COVEN_LAUNCH_CAPABILITIES_TTL_MS = 15000;
  var COVEN_LAUNCH_STATES = [
    "accepted",
    "spawned",
    "running",
    "failed",
    "recovery_required",
  ];
  var covenLaunchCapabilitiesSnapshot = null;
  var covenLaunchCapabilitiesFetchedAt = 0;
  var covenLaunchCapabilitiesFlight = null;
  var paneCounter = 0n;
  var MAX_PENDING_PTY_INPUT_BYTES = 1024 * 1024;
  var MAX_PENDING_PTY_INPUT_WRITES = 256;
  var PANE_METRICS_POLL_MS = 15000;
  var paneMetricsPollTimer = 0;
  var paneFooterPopoverCleanup = null;
  var paneFooterPopover = null;
  var paneFooterPopoverOwner = null;
  var paneFooterPopoverTrigger = null;
  var paneFooterPopoverThreadId = null;
  var projectAppearancePopover = null;
  var projectAppearancePopoverRestoreKey = "";
  var browserTabLifecycleStates = new WeakMap();
  var browserPaneLifecycleStates = new WeakMap();
  var browserCreationFlights = new Map();
  var browserControlProviders = new Map();
  var browserAutomationWaiters = new Map();
  var browserAutomationSnapshotRefs = new Map();
  // Matches --pane-min-w / --pane-min-h: the tree's arithmetic and the pane's
  // own CSS floor have to agree, or a layout the tree calls valid renders
  // overflowing. 200x137 includes the fixed 27px footer rail.
  var PANE_MINIMUMS = { width: 200, height: 137, separator: 6 };

  function handleVisibilityChange() {
    if (document.hidden || document.visibilityState === "hidden") {
      saveWorkspaceNow().catch(function () {});
      stopCovenPolling();
    } else {
      startCovenPolling();
      if (typeof refreshStatusController === "function") refreshStatusController();
    }
    syncPaneMetricsVisibility();
    syncAllPtyVisibility();
  }

  /**
   * `editingContext` is non-null while the user is editing a label inline.
   * refreshSidebar / refreshTabs early-return so PTY events (which call them
   * to update status dots) can't clobber the active <input>.
   */
  var editingContext = null;

  function findProject(id) {
    for (var i = 0; i < state.projects.length; i++) {
      if (state.projects[i].id === id) return state.projects[i];
    }
    return null;
  }
  function activeProject() {
    return findProject(state.activeProjectId) || state.projects[0] || null;
  }
  var agentControlModel = null;
  var agentControlOwnerEpoch = null;
  var agentControlProjectRoot = null;
  var agentControlRefreshRequestId = 0;
  var agentControlRefreshFlight = null;
  var agentControlRefreshQueued = false;
  var agentControlUiLifecycle = null;

  function agentControlCommand(project, command) {
    var currentProject = activeProject();
    if (!project || !currentProject || currentProject.root !== project.root ||
        agentControlProjectRoot !== project.root) {
      var projectError = new Error("agent control project changed");
      projectError.code = "control_project_changed";
      return Promise.reject(projectError);
    }
    return invoke("control_operator_submit", { projectRoot: project.root, command: command }).then(function (response) {
      var outcome = response && response.outcome;
      if (!outcome || outcome.status !== "succeeded") {
        var error = new Error(outcome && outcome.message || "operator command failed");
        error.code = outcome && outcome.code;
        throw error;
      }
      return outcome;
    });
  }

  function updateAgentControlBadges(model) {
    document.querySelectorAll(".agent-control-badge").forEach(function (badge) { badge.remove(); });
    if (!model || !window.PsycheControl) return;
    document.querySelectorAll(".terminal-pane[data-thread-id]").forEach(function (pane) {
      var threadId = pane.dataset.threadId;
      var resource = window.PsycheControl.surfaceResourceIdentity(model, "pane", threadId);
      if (resource) pane.dataset.controlGeneration = String(resource.generation);
      else delete pane.dataset.controlGeneration;
      var badge = window.PsycheControl.resourceLeaseBadge(model, resource);
      var header = pane.querySelector(".terminal-pane-header");
      if (!badge || !header) return;
      var node = document.createElement("span");
      node.className = "agent-control-badge";
      node.textContent = "leased · " + badge.capabilitySummary;
      node.setAttribute("aria-label", "Leased to " + badge.agentId + " for " + badge.taskId + " with " + badge.capabilitySummary + " until " + badge.expiresAt);
      node.dataset.leaseId = badge.leaseId;
      node.dataset.leaseRevision = String(badge.revision);
      header.appendChild(node);
    });
    document.querySelectorAll(".browser-tab[data-tab-id]").forEach(function (tabNode) {
      var resource = window.PsycheControl.surfaceResourceIdentity(model, "browser_tab", tabNode.dataset.tabId);
      if (resource) tabNode.dataset.controlGeneration = String(resource.generation);
      else delete tabNode.dataset.controlGeneration;
      var badge = window.PsycheControl.resourceLeaseBadge(model, resource);
      if (!badge) return;
      var node = document.createElement("span");
      node.className = "agent-control-badge";
      node.textContent = "leased · " + badge.capabilitySummary;
      node.setAttribute("aria-label", "Leased to " + badge.agentId + " for " + badge.taskId + " with " + badge.capabilitySummary + " until " + badge.expiresAt);
      node.dataset.leaseId = badge.leaseId;
      node.dataset.leaseRevision = String(badge.revision);
      tabNode.appendChild(node);
    });
  }

  function renderAgentControl() {
    var content = document.getElementById("agent-control-content");
    var count = document.getElementById("agent-control-count");
    var project = activeProject();
    var model = project && project.root === agentControlProjectRoot ? agentControlModel : null;
    if (count) {
      count.textContent = String(model ? model.pendingCount : 0);
      count.hidden = !model || model.pendingCount === 0;
    }
    updateAgentControlBadges(model);
    if (!content || !window.PsycheControl) return;
    if (!model || !project) {
      content.replaceChildren();
      return;
    }
    window.PsycheControl.renderAgentControlDrawer(content, model, {
      onGrant: function (request) {
        return agentControlCommand(project, {
          type: "lease_grant", requestId: request.requestId,
        });
      },
      onDeny: function (approval) {
        return agentControlCommand(project, {
          type: "approval_resolve", approvalId: approval.approvalId,
          payloadDigest: approval.payloadDigest, decision: "deny",
        });
      },
      onApprove: function (approval) {
        return agentControlCommand(project, {
          type: "approval_resolve", approvalId: approval.approvalId,
          payloadDigest: approval.payloadDigest, decision: "approve",
        });
      },
      onRevoke: function (target) {
        return agentControlCommand(project, { type: "lease_revoke", leaseId: target.leaseId });
      },
      onStateChange: refreshAgentControlState,
    });
  }

  function refreshAgentControlState() {
    var project = activeProject();
    if (!project || !window.PsycheControl) return Promise.resolve(null);
    if (agentControlRefreshFlight) {
      agentControlRefreshQueued = true;
      return agentControlRefreshFlight;
    }
    var projectRoot = project.root;
    var requestId = ++agentControlRefreshRequestId;
    var flight = invoke("control_state", { projectRoot: projectRoot }).then(function (response) {
      var currentProject = activeProject();
      if (requestId !== agentControlRefreshRequestId || !currentProject || currentProject.root !== projectRoot) {
        return null;
      }
      var snapshot = response && response.snapshot ? response.snapshot : response;
      agentControlModel = window.PsycheControl.createAgentControlModel(snapshot || {}, {
        operator: true,
        previousOwnerEpoch: agentControlOwnerEpoch,
        projectRoot: projectRoot,
      });
      agentControlOwnerEpoch = agentControlModel.ownerEpoch;
      agentControlProjectRoot = projectRoot;
      renderAgentControl();
      return agentControlModel;
    }).catch(function () {
      var currentProject = activeProject();
      if (requestId !== agentControlRefreshRequestId || !currentProject || currentProject.root !== projectRoot) {
        return null;
      }
      agentControlModel = null;
      agentControlOwnerEpoch = null;
      agentControlProjectRoot = null;
      renderAgentControl();
      return null;
    }).finally(function () {
      if (agentControlRefreshFlight === flight) agentControlRefreshFlight = null;
      if (agentControlRefreshQueued) {
        agentControlRefreshQueued = false;
        void refreshAgentControlState();
      }
    });
    agentControlRefreshFlight = flight;
    return flight;
  }

  function resetAgentControlProject(project) {
    agentControlRefreshRequestId += 1;
    agentControlRefreshQueued = false;
    agentControlModel = null;
    agentControlOwnerEpoch = null;
    agentControlProjectRoot = null;
    renderAgentControl();
    if (project) void refreshAgentControlState();
  }

  function assignActiveProjectId(id, options) {
    if (state.activeProjectId === id) return false;
    state.activeProjectId = id;
    if (!options || options.resetAgentControl !== false) {
      resetAgentControlProject(findProject(id));
    }
    syncFilesPanelScope();
    return true;
  }

  function assignSelectedWorktreePath(project, worktreePath) {
    if (!project || project.selectedWorktreePath === worktreePath) return false;
    project.selectedWorktreePath = worktreePath;
    if (project.id === state.activeProjectId) syncFilesPanelScope();
    return true;
  }

  function installAgentControlUi() {
    var toggle = document.getElementById("agent-control-toggle");
    var overlay = document.getElementById("agent-control-overlay");
    var close = document.getElementById("agent-control-close");
    if (!toggle || !overlay || !close || !window.PsycheControl) return null;
    agentControlUiLifecycle = window.PsycheControl.installAgentControlUiLifecycle({
      toggle: toggle,
      overlay: overlay,
      close: close,
      refresh: refreshAgentControlState,
    });
    return agentControlUiLifecycle;
  }
  window.addEventListener("beforeunload", function () {
    if (agentControlUiLifecycle) agentControlUiLifecycle.dispose();
    agentControlUiLifecycle = null;
  });
  function mergeWorktreePresentationState(project, discovered) {
    var existing = Array.isArray(project.worktrees) ? project.worktrees : [];
    return (Array.isArray(discovered) ? discovered : []).map(function (worktree) {
      var previous = existing.find(function (item) { return item.path === worktree.path; });
      return Object.assign({}, worktree, { collapsed: previous ? !!previous.collapsed : false });
    });
  }
  function selectedWorktree(project) {
    project = project || activeProject();
    if (!project) return null;
    var worktrees = Array.isArray(project.worktrees) ? project.worktrees : [];
    return worktrees.find(function (worktree) { return worktree.path === project.selectedWorktreePath; }) ||
      worktrees.find(function (worktree) { return worktree.is_main; }) ||
      worktrees[0] ||
      { path: project.root, branch: null, is_main: true, dirty: false, missing: false };
  }
  function activeWorkspaceRoot(project) {
    var worktree = selectedWorktree(project);
    return worktree ? worktree.path : (project && project.root);
  }
  function nextPaneId(prefix) {
    paneCounter += 1n;
    return prefix + "-" + paneCounter.toString();
  }
  function paneIdSequence(id) {
    var match = /-(\d+)$/.exec(String(id || ""));
    if (!match) return 0n;
    try {
      return BigInt(match[1]);
    } catch {
      return 0n;
    }
  }
  function reservePaneId(id) {
    var sequence = paneIdSequence(id);
    if (sequence > paneCounter) paneCounter = sequence;
  }
  function reservePaneTreeIds(node) {
    if (!node) return;
    reservePaneId(node.id);
    if (node.type === "split") {
      reservePaneTreeIds(node.first);
      reservePaneTreeIds(node.second);
    }
  }
  function paneLayoutKey(projectId, worktreePath) {
    return String(projectId || "") + "\u0000" + String(worktreePath || "");
  }
  function paneLayoutFor(projectId, worktreePath) {
    return paneLayouts.get(paneLayoutKey(projectId, worktreePath)) || null;
  }
  function filesPaneKey(projectId, workspaceRoot) {
    return paneLayoutKey(projectId, workspaceRoot);
  }
  function ensureFilesPane(project, workspaceRoot) {
    if (!project || project.closing) return null;
    var key = filesPaneKey(project.id, workspaceRoot);
    var existing = filesPanes.get(key);
    if (existing) {
      if (existing.hidden) reopenFilesPane(existing);
      return existing;
    }
    var filesPane = {
      id: nextPaneId("files"),
      kind: "files",
      projectId: project.id,
      workspaceRoot: workspaceRoot,
      activeFileId: null,
      previousFocusedSessionId: state.activeThreadId || null,
      hidden: false,
      pane: null,
      host: null,
    };
    filesPanes.set(key, filesPane);
    commitPanePlacement(prepareFilesPanePlacement(filesPane));
    mountFilesPane(filesPane);
    return filesPane;
  }
  function activePaneLayout() {
    var project = activeProject();
    return project ? paneLayoutFor(project.id, activeWorkspaceRoot(project)) : null;
  }
  function activePaneLayoutKey() {
    var project = activeProject();
    return project ? paneLayoutKey(project.id, activeWorkspaceRoot(project)) : null;
  }

  // -------- Focus sets --------
  // A set is a named, colour-coded subset of the panes on one canvas. It scopes
  // what the canvas draws; it never changes the tiling underneath, and it never
  // gains or loses a pane except when the user says so.
  //
  // Sets are keyed by pane layout (project + worktree) for the same reason the
  // tiling is: a set that spanned two worktrees would have no single canvas to
  // scope. They live for the session — restoring them is a follow-up.
  var focusSets = [];
  var setPicking = null;
  var SET_COLOR_COUNT = 4;

  function setsForKey(key) {
    return focusSets.filter(function (set) { return set.key === key; });
  }

  /** The sets a pane belongs to, for its row's membership swatches. */
  function setsForThread(thread) {
    if (!thread) return [];
    var key = paneLayoutKey(thread.projectId, thread.worktreePath);
    return focusSets.filter(function (set) {
      return set.key === key && set.threadIds.indexOf(thread.id) !== -1;
    });
  }

  function findFocusSet(id) {
    for (var i = 0; i < focusSets.length; i++) {
      if (focusSets[i].id === id) return focusSets[i];
    }
    return null;
  }

  /** The set scoping the active canvas, if it still has members. */
  function activeFocusSet() {
    var layout = activePaneLayout();
    if (!layout || !layout.activeSetId) return null;
    var set = findFocusSet(layout.activeSetId);
    if (set && set.threadIds.length) return set;
    layout.activeSetId = null;
    return null;
  }
  function activatePaneLayoutFocus(project, worktreePath) {
    assignSelectedWorktreePath(project, worktreePath);
    var layout = paneLayoutFor(project.id, worktreePath);
    var leaf = layout && PsychePanes.findLeafById(layout.root, layout.focusedLeafId);
    var surface = leaf && (typeof canvasSurfaceById === "function"
      ? canvasSurfaceById(leaf.threadId)
      : findThread(leaf.threadId));
    var thread = surface && findThread(surface.id);
    var activeThread = thread &&
      thread.kind !== "coven-code" && thread.kind !== "coven-attach"
        ? thread
        : null;
    state.activeThreadId = activeThread ? activeThread.id : null;
    if (activeThread) project.lastActiveThreadId = activeThread.id;
    if (typeof restoreFilesPaneSelection === "function") {
      restoreFilesPaneSelection(project, worktreePath);
    }
    clearPassiveCovenPaneFocus(layout);
  }
  async function activateProjectWorktree(project, worktreePath, options) {
    var refreshStatus = !options || options.refreshStatus !== false;
    if (!project) return false;
    var previousWorktreePath = project.selectedWorktreePath;
    var projectChanged = project.id !== state.activeProjectId;
    if (!(await showTerminalView())) return false;
    assignSelectedWorktreePath(project, worktreePath);
    if (projectChanged) {
      var projectOptions = Object.assign(
        {},
        options || {},
        { refreshStatus: false }
      );
      if (!(await setActiveProject(project.id, projectOptions))) {
        assignSelectedWorktreePath(project, previousWorktreePath);
        return false;
      }
    } else {
      activatePaneLayoutFocus(project, worktreePath);
    }
    if (!projectChanged) {
      renderPaneWorkspace({ preserveTerminalFocus: false });
      renderGitSurface();
    }
    loadAgentSkills();
    refreshSidebar();
    syncProjectBrowser();
    saveWorkspaceSoon();
    if (refreshStatus && typeof refreshStatusController === "function") {
      refreshStatusController();
    }
    return true;
  }
  function measuredTerminalHost() {
    var rect = terminalHost.getBoundingClientRect();
    var styles = window.getComputedStyle(terminalHost);
    var horizontalPadding = (parseFloat(styles.paddingLeft) || 0) +
      (parseFloat(styles.paddingRight) || 0);
    var verticalPadding = (parseFloat(styles.paddingTop) || 0) +
      (parseFloat(styles.paddingBottom) || 0);
    return {
      x: 0,
      y: 0,
      width: Math.max(0, rect.width - horizontalPadding),
      height: Math.max(0, rect.height - verticalPadding),
    };
  }
  function preparePanePlacement(threadId, projectId, worktreePath) {
    var key = paneLayoutKey(projectId, worktreePath);
    var current = paneLayouts.get(key) || null;
    var leaf = PsychePanes.createLeaf(nextPaneId("leaf"), threadId);
    var anchorLeaf = current && current.root
      ? PsychePanes.findLeafById(current.root, current.focusedLeafId)
      : null;
    var anchorLeafId = anchorLeaf
      ? anchorLeaf.id
      : (current && current.root ? PsychePanes.leafIds(current.root)[0] : null);
    var root = current && current.root
      ? PsychePanes.insertBelow(
          current.root,
          anchorLeafId,
          leaf,
          nextPaneId("split")
        )
      : leaf;
    if (!PsychePanes.canFit(root, measuredTerminalHost(), PANE_MINIMUMS)) return null;
    return { key: key, value: { root: root, focusedLeafId: leaf.id } };
  }
  function prepareFilesPanePlacement(filesPane) {
    var key = filesPaneKey(filesPane.projectId, filesPane.workspaceRoot);
    var current = paneLayouts.get(key) || null;
    var filesLeaf = PsychePanes.createLeaf(filesPane.id, filesPane.id);
    var focusedLeaf = current && current.root
      ? PsychePanes.findLeafById(current.root, current.focusedLeafId)
      : null;
    var focusedLeafId = focusedLeaf
      ? focusedLeaf.id
      : (current && current.root ? PsychePanes.leafIds(current.root)[0] : null);
    var proposedRoot = current && current.root
      ? PsychePanes.insertRelative(
          current.root,
          focusedLeafId,
          filesLeaf,
          nextPaneId("split"),
          "right"
        )
      : filesLeaf;
    var value = Object.assign({}, current || {}, {
      root: proposedRoot,
      focusedLeafId: filesLeaf.id,
      spanRoot: null,
      spanSignature: null,
    });
    value.maximizedLeafId = PsychePanes.canFit(
      proposedRoot,
      measuredTerminalHost(),
      PANE_MINIMUMS
    ) ? null : filesLeaf.id;
    return { key: key, value: value };
  }
  function commitPanePlacement(placement) {
    paneLayouts.set(placement.key, placement.value);
    saveWorkspaceSoon();
  }
  function covenDiscoveryScopes() {
    return state.projects.map(function (project) {
      var worktreeRoots = (project.worktrees || [])
        .filter(function (worktree) {
          return !worktree.missing && !worktree.prunable && !worktree.bare &&
            worktree.path && worktree.path !== project.root;
        })
        .map(function (worktree) { return worktree.path; })
        .filter(function (root, index, roots) { return roots.indexOf(root) === index; });
      return { projectRoot: project.root, worktreeRoots: worktreeRoots };
    });
  }
  function covenDiscoveryRoots() {
    return covenDiscoveryScopes().reduce(function (roots, scope) {
      [scope.projectRoot].concat(scope.worktreeRoots).forEach(function (root) {
        if (root && roots.indexOf(root) === -1) roots.push(root);
      });
      return roots;
    }, []);
  }
  function covenRootDepth(root) {
    if (typeof root !== "string") return 0;
    return root.split("/").filter(function (component) { return component.length > 0; }).length;
  }
  function covenProjectCandidate(project, sessionRoot) {
    if (!project || !project.id || typeof project.root !== "string" || !project.root ||
        typeof sessionRoot !== "string" || !sessionRoot) return null;
    if (project.root === sessionRoot) {
      return { project: project, rank: 0, depth: covenRootDepth(project.root) };
    }
    var ownsWorktree = (project.worktrees || []).some(function (worktree) {
      return worktree && worktree.path === sessionRoot && !worktree.missing &&
        !worktree.prunable && !worktree.bare;
    });
    if (!ownsWorktree) return null;
    return {
      project: project,
      rank: 1,
      depth: covenRootDepth(project.root),
    };
  }
  function compareCovenProjectCandidates(left, right) {
    if (left.rank !== right.rank) return left.rank - right.rank;
    if (left.depth !== right.depth) return right.depth - left.depth;
    var leftId = String(left.project.id);
    var rightId = String(right.project.id);
    return leftId < rightId ? -1 : (leftId > rightId ? 1 : 0);
  }
  function covenSessionAssignments() {
    var sessionsById = new Map();
    covenDiscovery.sessionsByProject.forEach(function (sessions) {
      (sessions || []).forEach(function (session) {
        if (!session || !session.id) return;
        var records = sessionsById.get(session.id) || [];
        records.push(session);
        sessionsById.set(session.id, records);
      });
    });
    var assignments = new Map();
    sessionsById.forEach(function (records) {
      var candidates = [];
      records.forEach(function (session) {
        state.projects.forEach(function (project) {
          var candidate = covenProjectCandidate(project, session.projectRoot);
          if (candidate) candidates.push({ session: session, candidate: candidate });
        });
      });
      candidates.sort(function (left, right) {
        var ownerOrder = compareCovenProjectCandidates(left.candidate, right.candidate);
        if (ownerOrder) return ownerOrder;
        var leftRoot = String(left.session.projectRoot);
        var rightRoot = String(right.session.projectRoot);
        return leftRoot < rightRoot ? -1 : (leftRoot > rightRoot ? 1 : 0);
      });
      var winner = candidates[0];
      if (!winner) return;
      var ownerSessions = assignments.get(winner.candidate.project.id) || [];
      ownerSessions.push(winner.session);
      assignments.set(winner.candidate.project.id, ownerSessions);
    });
    return assignments;
  }
  function covenSessionsForProject(project, assignments) {
    var owned = assignments || covenSessionAssignments();
    return owned.get(project.id) || [];
  }
  function allCovenSessionsForProject(project) {
    var roots = [project.root].concat(
      (project.worktrees || []).map(function (worktree) { return worktree.path; })
    ).filter(function (root, index, candidates) {
      return root && candidates.indexOf(root) === index;
    });
    return roots.reduce(function (sessions, root) {
      return sessions.concat(covenDiscovery.allSessionsByProject.get(root) || []);
    }, []);
  }
  async function refreshCovenSessions(options) {
    var force = !!(options && options.force);
    var requiredGeneration = force
      ? Number(options && options.requiredGeneration) || covenSessionMutationGeneration
      : 0;
    if ((!force && document.visibilityState === "hidden") || state.projects.length === 0) {
      return covenDiscovery;
    }
    var roots = covenDiscoveryRoots();
    var projectScopes = covenDiscoveryScopes();
    var requestKey = JSON.stringify(projectScopes.map(function (scope) {
      return {
        projectRoot: scope.projectRoot,
        worktreeRoots: scope.worktreeRoots.slice().sort(),
      };
    }).sort(function (left, right) {
      return left.projectRoot < right.projectRoot ? -1 :
        (left.projectRoot > right.projectRoot ? 1 : 0);
    }));
    if (covenDiscoveryFlight) {
      if (force) {
        if (covenDiscoveryFlight.key === requestKey &&
            covenDiscoveryFlight.startedGeneration >= requiredGeneration) {
          return covenDiscoveryFlight.promise;
        }
        try {
          await covenDiscoveryFlight.promise;
        } catch (_) {}
        return refreshCovenSessions({
          force: true,
          requiredGeneration: requiredGeneration,
        });
      }
      if (covenDiscoveryFlight.key === requestKey) return covenDiscoveryFlight.promise;
    }
    var started = PsycheSessions.beginCovenRequest(covenDiscovery);
    covenDiscovery = started.state;
    renderSessionList();
    var flight = {
      key: requestKey,
      promise: null,
      startedGeneration: covenSessionMutationGeneration,
    };
    covenDiscoveryFlight = flight;
    flight.promise = (async function () {
      var requestStartedAt = performance.now();
      var errorMessage = "";
      var ownsDiscovery = false;
      try {
        var response = await invoke("coven_sessions", {
          projectRoots: roots,
          projectScopes: projectScopes,
        });
        covenDiscovery = PsycheSessions.applyCovenResponse(
          covenDiscovery,
          started.requestId,
          response
        );
        ownsDiscovery = covenDiscovery.requestId === started.requestId;
      } catch (error) {
        errorMessage = error && error.message ? error.message : String(error || "");
        if (!errorMessage) errorMessage = "Coven sessions could not be loaded";
        covenDiscovery = PsycheSessions.applyCovenResponse(
          covenDiscovery,
          started.requestId,
          { status: "error", sessions: [], message: errorMessage }
        );
        ownsDiscovery = covenDiscovery.requestId === started.requestId;
      } finally {
        if (covenDiscoveryFlight === flight) covenDiscoveryFlight = null;
      }
      if (ownsDiscovery && typeof noteStatusCovenSample === "function") {
        noteStatusCovenSample({
          phase: covenDiscovery.phase,
          latencyMs: performance.now() - requestStartedAt,
          refreshedAt: covenDiscovery.refreshedAt,
          error: covenDiscovery.phase === "ready"
            ? ""
            : (covenDiscovery.message || errorMessage),
        });
      }
      renderSessionList();
      if (ownsDiscovery && typeof refreshStatusController === "function") {
        refreshStatusController();
      }
      return covenDiscovery;
    })();
    return flight.promise;
  }
  async function closeCovenSession(session) {
    if (!session || !session.id || covenSessionCloseFlights.has(session.id)) return false;
    var id = session.id;
    covenSessionCloseFlights.add(id);
    try {
      await invoke("coven_session_kill", { sessionId: id, session_id: id });
      covenSessionMutationGeneration += 1;
      await refreshCovenSessions({
        force: true,
        requiredGeneration: covenSessionMutationGeneration,
      });
      return true;
    } catch (error) {
      setStatus("Stop and close failed: " + String(error), "error");
      return false;
    } finally {
      covenSessionCloseFlights.delete(id);
    }
  }
  function stopCovenPolling() {
    if (covenPollTimer) clearInterval(covenPollTimer);
    covenPollTimer = null;
  }
  function startCovenPolling() {
    stopCovenPolling();
    if (document.visibilityState === "hidden" || state.projects.length === 0) return;
    refreshCovenSessions();
    covenPollTimer = setInterval(refreshCovenSessions, COVEN_POLL_MS);
  }
  function refreshProjectWorktrees(project) {
    if (!project) return Promise.resolve([]);
    var previousWorkspaceRoot = activeWorkspaceRoot(project);
    function invalidateChangedDiffScope() {
      if (project.id === state.activeProjectId &&
          activeWorkspaceRoot(project) !== previousWorkspaceRoot) {
        suspendGitRequests();
      }
    }
    if (state.env && state.env.native_workspace_v2 === false) {
      project.worktrees = mergeWorktreePresentationState(project, [{
        path: project.root, branch: null, is_main: true, dirty: false, missing: false,
      }]);
      assignSelectedWorktreePath(project, project.root);
      invalidateChangedDiffScope();
      refreshSidebar();
      if (typeof refreshStatusController === "function") refreshStatusController();
      refreshCovenSessions();
      return Promise.resolve(project.worktrees);
    }
    return invoke("git_worktrees", { root: project.root }).then(function (worktrees) {
      project.worktrees = mergeWorktreePresentationState(project, worktrees);
      var selected = selectedWorktree(project);
      assignSelectedWorktreePath(project, selected ? selected.path : project.root);
      invalidateChangedDiffScope();
      refreshSidebar();
      saveWorkspaceSoon();
      if (typeof refreshStatusController === "function") refreshStatusController();
      refreshCovenSessions();
      return project.worktrees;
    }).catch(function () {
      project.worktrees = mergeWorktreePresentationState(project, [{
        path: project.root, branch: null, is_main: true, dirty: false, missing: false,
      }]);
      assignSelectedWorktreePath(project, project.root);
      invalidateChangedDiffScope();
      refreshSidebar();
      if (typeof refreshStatusController === "function") refreshStatusController();
      refreshCovenSessions();
      return project.worktrees;
    });
  }
  function activeProjectThreads() {
    var p = activeProject();
    if (!p) return [];
    return state.threads.filter(function (t) { return t.projectId === p.id && !t.hidden; });
  }
  // A pane whose process exited cleanly has nothing left to report, so its rail
  // row is noise. Only the row goes: the pane stays on the canvas with its Retry
  // button, and closing that pane drops the thread outright, so nothing is
  // stranded. `failed` is deliberately not dormant — a crash should stay visible
  // in the rail until it is dealt with.
  function isDormantThread(thread) {
    return Boolean(thread) && thread.status === "exited";
  }
  async function setActiveProject(id, options) {
    var refreshStatus = !options || options.refreshStatus !== false;
    if (state.activeProjectId === id) return true;
    if (!(await showTerminalView())) return false;
    var project = findProject(id);
    if (!project) return false;
    var workspaceRoot = activeWorkspaceRoot(project);
    assignSelectedWorktreePath(project, workspaceRoot);
    if (typeof assignActiveProjectId === "function") assignActiveProjectId(id);
    else Object.assign(state, { activeProjectId: id });
    clearPassiveCovenPaneFocus();
    // Refresh agent skill suggestions for the new project's `.claude` tree.
    loadAgentSkills();
    // Restore the project's last-focused thread, falling back within the
    // workspace tree the active canvas is allowed to show.
    var workspaceRoot = activeWorkspaceRoot(project);
    if (typeof restoreFilesPaneSelection === "function") {
      restoreFilesPaneSelection(project, workspaceRoot);
    }
    var layout = paneLayoutFor(id, workspaceRoot);
    var scopedRoot = layout ? scopedPaneRoot(layout) : null;
    var threads = state.threads.filter(function (t) {
      return t.projectId === id && t.worktreePath === workspaceRoot && !t.hidden &&
        t.kind !== "coven-code" && t.kind !== "coven-attach";
    });
    var rememberedThread = project.lastActiveThreadId && state.threads.find(function (thread) {
      return thread.id === project.lastActiveThreadId;
    });
    if (rememberedThread &&
        (rememberedThread.kind === "coven-code" || rememberedThread.kind === "coven-attach")) {
      project.lastActiveThreadId = null;
    }
    var fallbackIds = layout && layout.activeSetId && scopedRoot
      ? PsychePanes.leafIds(scopedRoot).map(function (leafId) {
          var leaf = PsychePanes.findLeafById(scopedRoot, leafId);
          return leaf ? leaf.threadId : null;
        })
      : threads.map(function (thread) { return thread.id; });
    var candidateIds = [];
    if (project.lastActiveThreadId &&
        threads.some(function (thread) { return thread.id === project.lastActiveThreadId; }) &&
        paneFocusEligible(layout, project.lastActiveThreadId)) {
      candidateIds.push(project.lastActiveThreadId);
    }
    fallbackIds.forEach(function (threadId) {
      if (threadId && candidateIds.indexOf(threadId) === -1 &&
          threads.some(function (thread) { return thread.id === threadId; })) {
        candidateIds.push(threadId);
      }
    });
    var focused = false;
    var focusOptions = Object.assign({}, options || {}, { refreshStatus: false });
    for (var i = 0; i < candidateIds.length; i += 1) {
      if (!paneFocusEligible(layout, candidateIds[i])) continue;
      if (await focusThread(candidateIds[i], focusOptions)) {
        focused = true;
        break;
      }
    }
    if (!focused) {
      state.activeThreadId = null;
      renderPaneWorkspace({ preserveTerminalFocus: false });
      refreshSidebar();
      refreshTabs();
      syncProjectBrowser();
    }
    renderGitSurface();
    syncProjectBrowser();
    saveWorkspaceSoon();
    if (refreshStatus && typeof refreshStatusController === "function") {
      refreshStatusController();
    }
    return true;
  }
  var projectCounter = 0;
  function makeProjectId() {
    projectCounter += 1;
    return "p" + Date.now().toString(36) + "-" + projectCounter;
  }

  var commandHistory = [];
  var RECENT_COMMANDS_KEY = "psyche.tauri.recentCommands.v1";
  var recentCommands = loadRecentCommands();

  var HARD_MAX_PROJECTS = 10;
  var HARD_MAX_BROWSER_TABS_PER_PROJECT = 10;
  var THEMES = ["coven-purple", "claude-orange", "codex-blackish", "gemini-blue", "emerald", "rose"];
  var DEFAULT_THEME = "coven-purple";
  var DEFAULT_BG_OPACITY = 1;
  // Surfaces are rgba(..., calc(--bg-opacity * own-alpha)) and CSS clamps alpha
  // to 1, so a multiplier this large drives every one of them fully opaque —
  // the lowest surface alpha in the sheet is 0.45, and 0.45 * 2.5 > 1.
  var SOLID_BG_MULTIPLIER = 2.5;
  // Floor is deliberately above 0: at 0 the chrome vanishes entirely and the
  // window becomes unusable with no visible control to undo it.
  var MIN_BG_OPACITY = 0.3;
  var MAX_BG_OPACITY = 1;
  var SETTINGS_KEY = "psyche.tauri.settings.v1";
  var PROJECT_APPEARANCES_KEY = "psyche.tauri.project-appearances.v1";
  var deferredStatusMessages = [];
  var LEGACY_WORKSPACE_STATE_KEY = "psyche.tauri.workspace.v1";
  var settings = loadSettings();
  var projectAppearances = loadProjectAppearances();
  var isRestoringWorkspace = false;
  var legacyWorkspaceMigration = { projectsPreserved: false };
  var saveWorkspaceTimer = 0;

  function terminalTheme() {
    return {
      background: "rgba(0, 0, 0, 0)",
      foreground: "#ece9f5",
      cursor: "#a78bfa",
      selectionBackground: "rgba(167,139,250,0.30)",
    };
  }

  function clampInt(value, fallback, min, max) {
    var n = parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }
  function clampFloat(value, fallback, min, max) {
    var n = parseFloat(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }
  function queueDeferredStatus(text, level) {
    deferredStatusMessages.push({
      text: String(text),
      level: typeof level === "string" ? level : "",
    });
  }
  function flushDeferredStatusMessages() {
    if (!deferredStatusMessages.length) return;
    deferredStatusMessages.forEach(function (entry) {
      if (entry.level === "error") showStatusError(entry.text);
      else setStatus(entry.text, entry.level);
    });
    deferredStatusMessages = [];
  }
  function loadSettings() {
    var defaults = {
      maxProjects: 10,
      maxBrowserTabsPerProject: 10,
      bgOpacity: DEFAULT_BG_OPACITY,
      theme: DEFAULT_THEME,
      solidBg: false,
      sessionFilter: "all",
      selectedSessionKey: "",
    };
    try {
      var saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      return {
        maxProjects: clampInt(saved.maxProjects, defaults.maxProjects, 1, HARD_MAX_PROJECTS),
        maxBrowserTabsPerProject: clampInt(saved.maxBrowserTabsPerProject, defaults.maxBrowserTabsPerProject, 1, HARD_MAX_BROWSER_TABS_PER_PROJECT),
        bgOpacity: clampFloat(saved.bgOpacity, defaults.bgOpacity, MIN_BG_OPACITY, MAX_BG_OPACITY),
        theme: THEMES.indexOf(saved.theme) === -1 ? defaults.theme : saved.theme,
        solidBg: saved.solidBg === true,
        sessionFilter: PsycheSessions.normalizeSidebarFilter(saved.sessionFilter),
        selectedSessionKey: typeof saved.selectedSessionKey === "string" ? saved.selectedSessionKey.slice(0, 1024) : "",
      };
    } catch (_) { return defaults; }
  }
  function loadProjectAppearances() {
    try {
      return PsycheSessions.parseProjectAppearances(
        localStorage.getItem(PROJECT_APPEARANCES_KEY)
      );
    } catch (error) {
      queueDeferredStatus("project appearance load failed: " + String(error), "error");
      return {};
    }
  }
  function saveSettings() {
    settings.maxProjects = clampInt(settings.maxProjects, 10, 1, HARD_MAX_PROJECTS);
    settings.maxBrowserTabsPerProject = clampInt(settings.maxBrowserTabsPerProject, 10, 1, HARD_MAX_BROWSER_TABS_PER_PROJECT);
    settings.bgOpacity = clampFloat(settings.bgOpacity, DEFAULT_BG_OPACITY, MIN_BG_OPACITY, MAX_BG_OPACITY);
    if (THEMES.indexOf(settings.theme) === -1) settings.theme = DEFAULT_THEME;
    settings.solidBg = settings.solidBg === true;
    settings.sessionFilter = PsycheSessions.normalizeSidebarFilter(settings.sessionFilter);
    settings.selectedSessionKey = typeof settings.selectedSessionKey === "string" ? settings.selectedSessionKey.slice(0, 1024) : "";
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }
  function saveProjectAppearances() {
    try {
      localStorage.setItem(
        PROJECT_APPEARANCES_KEY,
        JSON.stringify(projectAppearances)
      );
      return true;
    } catch (error) {
      showStatusError("project appearance save failed: " + String(error));
      return false;
    }
  }

  // ---- Background opacity ----
  // One multiplier drives every translucent chrome surface (via the
  // --bg-opacity custom property) *and* the xterm theme. The terminal canvas
  // paints its own background, so CSS alone would leave the largest surface in
  // the window stubbornly opaque.
  // Themes and the solid/vibrant switch are both single attributes on <html>;
  // the stylesheet does the rest, so nothing here has to know about colours.
  function applyTheme(name, opts) {
    var t = THEMES.indexOf(name) === -1 ? DEFAULT_THEME : name;
    settings.theme = t;
    document.documentElement.setAttribute("data-theme", t);
    if (themeSelectEl && themeSelectEl.value !== t) themeSelectEl.value = t;
    state.threads.forEach(function (thread) {
      if (thread.terminalController) thread.terminalController.setTheme(terminalTheme());
    });
    if (!opts || opts.persist !== false) saveSettings();
  }
  function applySolidBg(on, opts) {
    var v = on === true;
    settings.solidBg = v;
    document.documentElement.setAttribute("data-surface", v ? "solid" : "vibrant");
    document.documentElement.style.setProperty(
      "--bg-opacity", String(v ? SOLID_BG_MULTIPLIER : settings.bgOpacity));
    if (solidBgEl && solidBgEl.checked !== v) solidBgEl.checked = v;
    // The opacity slider only bites against the vibrancy material.
    if (bgOpacityInput) bgOpacityInput.disabled = v;
    if (!opts || opts.persist !== false) saveSettings();
  }
  function applyBgOpacity(value, opts) {
    var v = clampFloat(value, DEFAULT_BG_OPACITY, MIN_BG_OPACITY, MAX_BG_OPACITY);
    settings.bgOpacity = v;
    // Solid mode wins: it pins the multiplier regardless of the slider.
    document.documentElement.style.setProperty(
      "--bg-opacity", String(settings.solidBg ? SOLID_BG_MULTIPLIER : v));
    if (bgOpacityInput && bgOpacityInput.value !== String(v)) bgOpacityInput.value = String(v);
    if (bgOpacityValueEl) bgOpacityValueEl.textContent = Math.round(v * 100) + "%";
    if (!opts || opts.persist !== false) saveSettings();
  }

  function persistableBrowsers(project) {
    ensureBrowserModel(project);
    return project.browsersByWorktree;
  }
  function persistableProject(project) {
    return { id: project.id, name: project.name, root: project.root, collapsed: !!project.collapsed, selectedWorktreePath: project.selectedWorktreePath, worktreePresentation: (project.worktrees || []).map(function (worktree) { return { path: worktree.path, collapsed: !!worktree.collapsed }; }), browsersByWorktree: persistableBrowsers(project) };
  }
  function persistableSession(thread) {
    if (!thread || !thread.launch ||
        ["shell", "psyche", "coven-code", "coven-attach", "coven-recovery"].indexOf(thread.launch.launchKind) === -1) {
      return null;
    }
    var persisted = {
      id: thread.id,
      projectId: thread.projectId,
      worktreePath: thread.worktreePath,
      name: thread.name,
      kind: thread.kind,
      launchKind: thread.launch.launchKind,
      hidden: thread.hidden === true,
    };
    if (thread.launch.launchKind === "coven-attach") {
      persisted.covenSessionId = thread.launch.covenSessionId || null;
      if (thread.launch.recoveryRequired === true) persisted.recoveryRequired = true;
    }
    return persisted;
  }
  function persistableFilesPanes() {
    var records = [];
    filesPanes.forEach(function (pane) {
      if (!pane || !pane.id || !pane.projectId || !pane.workspaceRoot) return;
      records.push({
        id: pane.id,
        projectId: pane.projectId,
        workspaceRoot: pane.workspaceRoot,
        hidden: pane.hidden === true,
      });
    });
    return records;
  }
  function persistablePaneLayouts() {
    var records = [];
    paneLayouts.forEach(function (layout, key) {
      var separator = key.indexOf("\u0000");
      if (separator === -1 || !layout || !layout.root) return;
      records.push({
        projectId: key.slice(0, separator),
        worktreePath: key.slice(separator + 1),
        root: layout.root,
        focusedLeafId: layout.focusedLeafId || null,
      });
    });
    return records;
  }
  function buildPersistedWorkspace() {
    return {
      version: 3,
      activeProjectId: state.activeProjectId || null,
      activeThreadId: state.activeThreadId || null,
      projects: state.projects.map(persistableProject).slice(0, HARD_MAX_PROJECTS),
      sessions: state.threads.map(persistableSession).filter(Boolean),
      filesPanes: persistableFilesPanes(),
      paneLayouts: persistablePaneLayouts(),
    };
  }
  function workspaceModel() {
    return window.PsycheWorkspace || null;
  }
  var workspaceSaveQueue = Promise.resolve();
  var workspaceSaveCriticalSection = null;
  function queueWorkspaceSave() {
    if (isRestoringWorkspace) return workspaceSaveQueue;
    workspaceSaveQueue = workspaceSaveQueue.catch(function () {});
    workspaceSaveQueue = workspaceSaveQueue.then(function () {
      var model = workspaceModel();
      if (!model) throw new Error("workspace model is unavailable");
      var workspace = model.sanitizeWorkspaceV3(buildPersistedWorkspace());
      if (!workspace) throw new Error("workspace state is invalid");
      return invoke("workspace_save", { workspace: workspace });
    }).then(function () {
      return true;
    }).catch(function (error) {
      setStatus("workspace save failed: " + String(error), "error");
      throw error;
    });
    return workspaceSaveQueue;
  }
  function saveWorkspaceNow() {
    if (isRestoringWorkspace) return workspaceSaveQueue;
    if (workspaceSaveCriticalSection) {
      workspaceSaveCriticalSection.requestVersion += 1;
      return workspaceSaveCriticalSection.promise;
    }
    return queueWorkspaceSave();
  }
  function saveWorkspaceSoon() {
    if (isRestoringWorkspace) return workspaceSaveQueue;
    if (workspaceSaveCriticalSection) {
      workspaceSaveCriticalSection.requestVersion += 1;
      return workspaceSaveCriticalSection.promise;
    }
    if (saveWorkspaceTimer) cancelAnimationFrame(saveWorkspaceTimer);
    saveWorkspaceTimer = requestAnimationFrame(function () {
      saveWorkspaceTimer = 0;
      saveWorkspaceNow().catch(function () {});
    });
  }
  async function beginWorkspaceSaveCriticalSection() {
    if (workspaceSaveCriticalSection) {
      throw new Error("workspace save critical section is already active");
    }
    if (saveWorkspaceTimer) {
      cancelAnimationFrame(saveWorkspaceTimer);
      saveWorkspaceTimer = 0;
    }
    var resolveDeferred;
    var rejectDeferred;
    var section = {
      requestVersion: 0,
      lastFlushedVersion: -1,
      hasFlushed: false,
      promise: new Promise(function (resolve, reject) {
        resolveDeferred = resolve;
        rejectDeferred = reject;
      }),
      resolve: resolveDeferred,
      reject: rejectDeferred,
    };
    section.promise.catch(function () {});
    workspaceSaveCriticalSection = section;
    await workspaceSaveQueue.catch(function () {});
    return section;
  }
  async function flushWorkspaceSaveCriticalSection(section) {
    if (!section || workspaceSaveCriticalSection !== section) {
      throw new Error("workspace save critical section is not active");
    }
    do {
      var requestedVersion = section.requestVersion;
      await queueWorkspaceSave();
      section.lastFlushedVersion = requestedVersion;
      section.hasFlushed = true;
    } while (section.requestVersion !== section.lastFlushedVersion);
    return true;
  }
  async function finishWorkspaceSaveCriticalSection(section) {
    if (!section || workspaceSaveCriticalSection !== section) {
      throw new Error("workspace save critical section is not active");
    }
    try {
      while (!section.hasFlushed ||
          section.requestVersion !== section.lastFlushedVersion) {
        await flushWorkspaceSaveCriticalSection(section);
      }
      workspaceSaveCriticalSection = null;
      section.resolve(true);
      return true;
    } catch (error) {
      workspaceSaveCriticalSection = null;
      section.reject(error);
      throw error;
    }
  }
  async function readSavedWorkspace() {
    var model = workspaceModel();
    if (!model) return null;
    legacyWorkspaceMigration.projectsPreserved = false;
    try {
      var saved = await invoke("workspace_load");
      if (saved) {
        var sanitized = model.sanitizeWorkspaceV3(saved);
        if (!sanitized) setStatus("workspace restore failed: invalid workspace v3", "error");
        return sanitized;
      }
    } catch (error) {
      setStatus("workspace restore failed: " + String(error), "error");
      return null;
    }
    try {
      var legacy = JSON.parse(localStorage.getItem(LEGACY_WORKSPACE_STATE_KEY) || "null");
      if (legacy && Array.isArray(legacy.projects) && legacy.projects.length > 0) {
        legacyWorkspaceMigration.projectsPreserved = true;
        setStatus(
          "Legacy projects were preserved but cannot be opened automatically; " +
            "reopen them with the folder picker.",
          "warn"
        );
      }
      return null;
    } catch (_) {
      return null;
    }
  }
  async function loadSavedWorkspace() {
    return readSavedWorkspace();
  }
  function sanitizeSavedProject(saved) {
    if (!saved || !saved.root) return null;
    var project = {
      id: saved.id || makeProjectId(),
      name: saved.name || String(saved.root).split("/").pop() || saved.root,
      root: saved.root,
      collapsed: saved.collapsed === true,
      selectedWorktreePath: saved.selectedWorktreePath || saved.root,
      worktrees: Array.isArray(saved.worktreePresentation) ? saved.worktreePresentation : [],
      browsersByWorktree: {},
      nativeAuthorityReady: false,
    };
    var savedBrowsers = saved.browsersByWorktree && typeof saved.browsersByWorktree === "object"
      ? saved.browsersByWorktree
      : {};
    Object.keys(savedBrowsers).forEach(function (workspaceRoot) {
      project.browsersByWorktree[workspaceRoot] = sanitizeBrowserModel(savedBrowsers[workspaceRoot]);
    });
    // v1 stored one browser model per project. Keep it attached to the main
    // checkout so upgrading never discards tabs or history.
    if (!project.browsersByWorktree[project.root] && saved.browser) {
      project.browsersByWorktree[project.root] = sanitizeBrowserModel(saved.browser);
    }
    return project;
  }
  function sanitizeBrowserModel(savedBrowser) {
    savedBrowser = savedBrowser || {};
    var browser = { tabs: [], activeTabId: null };
    if (Array.isArray(savedBrowser.tabs)) {
      browser.tabs = savedBrowser.tabs.slice(0, HARD_MAX_BROWSER_TABS_PER_PROJECT).map(function (tab) {
        var url = tab.url || "about:blank";
        var history = Array.isArray(tab.history) ? tab.history.filter(Boolean).slice(-50) : [];
        return { id: tab.id || makeBrowserTabId(), url: url, title: tab.title || tabTitle(url), history: history, historyIndex: clampInt(tab.historyIndex, history.length ? history.length - 1 : -1, -1, Math.max(-1, history.length - 1)), created: false, loading: false };
      });
    }
    browser.activeTabId = savedBrowser.activeTabId || (browser.tabs[0] && browser.tabs[0].id) || null;
    return browser;
  }

  // ============================================================
  // 3. DOM refs
  // ============================================================

  var detail = document.getElementById("detail");
  var tabStripEl = document.getElementById("tab-strip");
  var terminalHost = document.getElementById("terminal-host");
  var commandInput = document.getElementById("command-input");
  var paletteEl = document.getElementById("palette");
  var statusEl = document.getElementById("shell-status");
  var preview = document.getElementById("preview");
  var previewEmpty = preview.querySelector(".preview-empty");
  var urlInput = document.getElementById("url");
  var browserTabStrip = document.getElementById("browser-tab-strip");
  var terminalArea = document.querySelector(".terminal-area");
  var browserSurface = document.getElementById("browser-surface");
  var browserSurfaceStaging = document.getElementById("browser-surface-staging");
  var activeSurface = "terminal";

  var appEl = document.getElementById("app");
  var sidebarEl = document.getElementById("sidebar");
  var sidebarMiniEl = document.getElementById("sidebar-mini");
  var sidebarCollapseEl = document.getElementById("sidebar-collapse");
  var sidebarExpandEl = document.getElementById("sidebar-expand");
  var sidebarResizeEl = document.getElementById("sidebar-resize");
  var newPaneMenuEl = document.getElementById("new-pane-menu");
  var newPaneMenuHeadEl = document.getElementById("new-pane-menu-head");
  var statusAlertEl = document.getElementById("status-alert");
  var toastEl = document.getElementById("toast");
  var helpOverlayEl = document.getElementById("help-overlay");
  var agentPickerOverlayEl = document.getElementById("agent-picker-overlay");
  var agentPickerListEl = document.getElementById("agent-picker-list");
  var agentPickerIndex = 0;
  var agentPickerPreviousFocus = null;
  var agentLaunchInFlight = false;
  var helpGridEl = document.getElementById("help-grid");
  var daemonStatusEl = document.getElementById("daemon-status");
  var daemonLabelEl = document.getElementById("daemon-label");
  var composerSendEl = document.getElementById("composer-send");
  var composerSendHintEl = document.getElementById("composer-send-hint");
  var composerMicEl = document.getElementById("composer-mic");

  // -------- Voice call bar --------
  // Board 4's call bar. The bar, its timer and its mute state are real UI; what
  // does not exist yet is a voice transport. There is no getUserMedia, no
  // speech recogniser and no audio path to an agent anywhere in this app, so a
  // call is a local session that shows the designed chrome and says plainly
  // that it is not carrying audio. When a transport lands, `startCall` is where
  // it attaches -- nothing below fakes a connection or a peer.

  var callBarEl = document.getElementById("call-bar");
  var callTargetEl = document.getElementById("call-target");
  var callTimerEl = document.getElementById("call-timer");
  var callNoteEl = document.getElementById("call-note");
  var callMuteBtn = document.getElementById("call-mute");
  var callEndBtn = document.getElementById("call-end");
  var composerCallEl = document.getElementById("composer-call");

  var callState = { active: false, startedAt: 0, muted: false, timer: 0 };

  function formatCallTime(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var minutes = Math.floor(total / 60);
    var seconds = total % 60;
    return minutes + ":" + (seconds < 10 ? "0" : "") + seconds;
  }

  function paintCallBar() {
    if (!callBarEl) return;
    callBarEl.hidden = !callState.active;
    callBarEl.classList.toggle("is-muted", callState.muted);
    if (composerCallEl) composerCallEl.setAttribute("aria-pressed", callState.active ? "true" : "false");
    // Painted whether or not the bar is showing: leaving the control reading
    // "Unmute" after a call ends would have the next call open mislabelled.
    if (callMuteBtn) {
      callMuteBtn.textContent = callState.muted ? "Unmute" : "Mute";
      callMuteBtn.setAttribute("aria-pressed", callState.muted ? "true" : "false");
    }
    if (!callState.active) return;
    if (callTimerEl) callTimerEl.textContent = formatCallTime(Date.now() - callState.startedAt);
  }

  function startCall() {
    if (callState.active) return false;
    var thread = findThread(state.activeThreadId);
    callState.active = true;
    callState.muted = false;
    callState.startedAt = Date.now();
    if (callTargetEl) callTargetEl.textContent = thread ? thread.name : "no pane focused";
    // Say what is actually true rather than "the agent hears your terminal":
    // nothing is listening, and a bar that implied otherwise would be a lie
    // told in the UI.
    if (callNoteEl) callNoteEl.textContent = "no voice transport yet — chrome only";
    paintCallBar();
    callState.timer = setInterval(paintCallBar, 1000);
    return true;
  }

  function endCall() {
    if (!callState.active) return false;
    clearInterval(callState.timer);
    callState.timer = 0;
    callState.active = false;
    callState.muted = false;
    paintCallBar();
    return true;
  }

  function toggleCallMute() {
    if (!callState.active) return false;
    callState.muted = !callState.muted;
    paintCallBar();
    return callState.muted;
  }

  if (composerCallEl) {
    composerCallEl.addEventListener("click", function () {
      if (callState.active) endCall();
      else startCall();
    });
  }
  if (callMuteBtn) callMuteBtn.addEventListener("click", toggleCallMute);
  if (callEndBtn) callEndBtn.addEventListener("click", endCall);
  function isProcessBackedThread(thread) {
    return !!(thread && thread.launch);
  }

  function statusThreadSnapshot(thread) {
    var launch = thread && thread.launch ? thread.launch : null;
    return {
      id: thread && thread.id ? thread.id : null,
      name: thread && thread.name ? thread.name : (thread && thread.id) || "",
      kind: thread && thread.kind ? thread.kind : "shell",
      status: thread && typeof thread.status === "string" ? thread.status : "",
      covenSessionId: thread && thread.covenSessionId != null
        ? thread.covenSessionId
        : (launch && launch.covenSessionId) || null,
      processBacked: isProcessBackedThread(thread),
      needsAttention: !!(thread && thread.needsAttention),
      startedAt: thread && thread.startedAt != null ? thread.startedAt : null,
      finishedAt: thread && thread.finishedAt != null ? thread.finishedAt : null,
      exitCode: thread && thread.exitCode != null ? thread.exitCode : null,
    };
  }

  function statusCovenSessionSnapshot(session) {
    if (!session || !session.id) return null;
    var record = { id: session.id };
    if (session.projectRoot != null) record.projectRoot = session.projectRoot;
    if (session.cwd != null) record.cwd = session.cwd;
    if (session.title != null) record.title = session.title;
    if (session.harness != null) record.harness = session.harness;
    if (session.model != null) record.model = session.model;
    if (session.currentTask != null) record.currentTask = session.currentTask;
    if (session.inputTokens != null) record.inputTokens = session.inputTokens;
    if (session.outputTokens != null) record.outputTokens = session.outputTokens;
    if (session.status != null) record.status = session.status;
    if (session.createdAt != null) record.createdAt = session.createdAt;
    if (session.updatedAt != null) record.updatedAt = session.updatedAt;
    if (session.archivedAt != null) record.archivedAt = session.archivedAt;
    return record;
  }

  function readStructuredAgentToolCallCount() {
    if (Number.isFinite(state.agentToolCalls)) return state.agentToolCalls;
    var project = activeProject();
    if (project && Number.isFinite(project.agentToolCalls)) return project.agentToolCalls;
    return null;
  }

  function getStatusContext() {
    var project = activeProject();
    var context = {
      activeThreadId: state.activeThreadId || null,
      threads: state.threads.map(statusThreadSnapshot),
      covenSessions: project
        ? allCovenSessionsForProject(project).map(statusCovenSessionSnapshot).filter(Boolean)
        : [],
    };
    var agentToolCalls = readStructuredAgentToolCallCount();
    if (agentToolCalls != null) {
      context.agentToolCalls = agentToolCalls;
    }
    return context;
  }

  function buildStatusController() {
    var PsycheStatus = window.PsycheStatus;
    // Temporary incremental-development guard until the status bundle loads
    // before main.js in Task 8.
    if (!PsycheStatus || typeof PsycheStatus.createStatusController !== "function") {
      var statusAlert = document.getElementById("status-alert");
      if (statusAlert) {
        statusAlert.textContent = "Workspace status unavailable: status bundle missing.";
      }
      console.warn(
        "[status controller] footer status bundle missing; window.PsycheStatus.createStatusController unavailable"
      );
      return null;
    }
    var bar = document.getElementById("status-bar");
    var metrics = document.getElementById("status-metrics");
    var detailPanel = document.getElementById("status-detail");
    var detailTitle = document.getElementById("status-detail-title");
    var detailBody = document.getElementById("status-detail-body");
    var detailClose = document.getElementById("status-detail-close");
    var detailPin = document.getElementById("status-detail-pin");
    var detailCopy = document.getElementById("status-detail-copy");
    var moreButton = document.getElementById("status-more-button");
    var moreMenu = document.getElementById("status-more-menu");
    var live = document.getElementById("status-live");
    var alert = document.getElementById("status-alert");
    var trailing = document.querySelector(".status-bar-trailing");
    var scopeButtons = document.querySelectorAll(".status-scope-btn, .status-detail-scope-btn");
    if (!bar || !metrics || !detailPanel || !detailTitle || !detailBody || !detailClose ||
        !detailPin || !detailCopy || !moreButton || !moreMenu || !live || !alert ||
        !trailing || !scopeButtons || !scopeButtons.length) {
      return null;
    }
    return PsycheStatus.createStatusController({
      elements: {
        bar: bar,
        metrics: metrics,
        detail: detailPanel,
        detailTitle: detailTitle,
        detailBody: detailBody,
        close: detailClose,
        pin: detailPin,
        copy: detailCopy,
        scopeButtons: scopeButtons,
        more: moreButton,
        moreMenu: moreMenu,
        live: live,
        alert: alert,
        trailing: trailing,
      },
      fetchMetrics: function (scope) {
        return invokeNative("workspace_metrics", { scope: scope || null });
      },
      getContext: getStatusContext,
      storage: localStorage,
      copyText: function (text) {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
          return Promise.reject(new Error("Clipboard API unavailable"));
        }
        return navigator.clipboard.writeText(text);
      },
    });
  }

  statusController = buildStatusController();

  function noteStatusActivity(at) {
    if (!statusController || typeof statusController.noteActivity !== "function") return;
    statusController.noteActivity(at);
  }

  function noteStatusPtyData(threadId, bytes, at) {
    if (!statusController || typeof statusController.notePtyData !== "function") return;
    statusController.notePtyData(threadId, bytes, at);
  }

  function noteStatusCovenSample(sample) {
    if (!statusController || typeof statusController.noteCovenSample !== "function") return;
    statusController.noteCovenSample(sample);
  }

  function refreshStatusController() {
    if (!statusController || typeof statusController.refresh !== "function" ||
        document.visibilityState === "hidden") {
      return Promise.resolve(null);
    }
    return statusController.refresh().catch(function (error) {
      console.warn("[status controller] refresh failed", error);
      return null;
    });
  }

  document.addEventListener("pointerdown", function () { noteStatusActivity(); }, true);
  document.addEventListener("keydown", function () { noteStatusActivity(); }, true);

  // ---- Toast ----
  // Short-lived confirmation for actions whose effect happens off-screen
  // (for example, a pane spawned behind a maximised pane).
  var toastTimer = 0;
  function toast(message, duration, options) {
    if (!toastEl) return;
    var announce = !options || options.announce !== false;
    if (announce) {
      if (toastEl.getAttribute("aria-hidden") === "true") {
        toastEl.textContent = "";
      }
      toastEl.removeAttribute("aria-hidden");
    } else {
      toastEl.setAttribute("aria-hidden", "true");
    }
    toastEl.textContent = message;
    toastEl.classList.add("is-visible");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove("is-visible");
      toastEl.textContent = "";
      toastEl.removeAttribute("aria-hidden");
      toastTimer = 0;
    }, duration || 2600);
  }

  function showStatusError(message) {
    var text = String(message);
    if (statusAlertEl) statusAlertEl.textContent = text;
    toast(text, 6000, { announce: false });
  }

  function showPanePlacementWarning(message) {
    setStatus(message, "warn");
    toast(message, 6000);
  }

  async function copyPaneFooterValue(label, value) {
    if (!value) {
      toast(label + " is not reported");
      return false;
    }
    if (!clipboardManager || typeof clipboardManager.writeText !== "function") {
      setStatus("Clipboard support is unavailable", "error");
      return false;
    }
    try {
      await clipboardManager.writeText(value);
      toast(label + " copied");
      return true;
    } catch (error) {
      setStatus("Copy failed: " + String(error), "error");
      return false;
    }
  }

  async function revealPaneWorktree(path) {
    if (!path) {
      setStatus("Worktree path is unavailable", "error");
      return false;
    }
    if (!opener || typeof opener.revealItemInDir !== "function") {
      setStatus("Finder reveal is unavailable", "error");
      return false;
    }
    try {
      await opener.revealItemInDir(path);
      return true;
    } catch (error) {
      setStatus("Reveal failed: " + String(error), "error");
      return false;
    }
  }

  function markActiveSurface(surface) {
    activeSurface = surface === "browser" ? "browser" : "terminal";
    if (detail) detail.dataset.activeSurface = activeSurface;
  }

  if (terminalArea) {
    terminalArea.addEventListener("pointerdown", function () { markActiveSurface("terminal"); }, true);
    terminalArea.addEventListener("focusin", function () { markActiveSurface("terminal"); }, true);
  }
  if (browserSurface) {
    browserSurface.addEventListener("pointerdown", function () { markActiveSurface("browser"); }, true);
    browserSurface.addEventListener("focusin", function () { markActiveSurface("browser"); }, true);
  }

  function setStatus(text, level) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = "status-pill " + (level || "");
  }
  function setProjectStatus(project, level) {
    project = project || activeProject();
    var statusLevel = level || "ok";
    if (statusLevel === "ok") setStatus("Coven is ready", "ok");
    else if (statusLevel === "") setStatus(project ? project.name : "ready", "");
    else setStatus(project ? project.name : "ready", statusLevel);
  }

  /**
   * Titlebar runtime light. It reports the focused pane's actual PTY state —
   * running / starting / exited / no pane — rather than a remote connection,
   * because every session this app owns is a local Tauri-managed process.
   */
  function syncDaemonStatus() {
    if (!daemonStatusEl) return;
    var thread = findThread(state.activeThreadId);
    var project = activeProject();
    var stateName = "idle";
    var label = "psyche · local";
    if (thread) {
      stateName = thread.spawning || thread.status === "starting"
        ? "starting"
        : thread.status === "exited" ? "exited" : "running";
      label = "psyche · " + (stateName === "running" ? "local" : stateName);
    } else if (!project) {
      label = "psyche · no project";
    } else {
      label = "psyche · no pane";
    }
    daemonStatusEl.dataset.state = stateName;
    if (daemonLabelEl) daemonLabelEl.textContent = label;
  }

  // ============================================================
  // 5. PTY event plumbing
  // ============================================================

  function threadTerminalVisibility(thread) {
    var snapshot = thread && thread.terminalController &&
      thread.terminalController.rendererSnapshot
        ? thread.terminalController.rendererSnapshot()
        : null;
    return {
      documentVisible: !document.hidden,
      paneVisible: !!thread && !thread.hidden && !!terminalHost &&
        terminalHost.isConnected && !terminalHost.hidden && !!thread.pane &&
        thread.pane.isConnected,
      intersecting: snapshot ? snapshot.visibility.intersecting : true,
    };
  }

  function ensureThreadPtyController(thread) {
    if (!thread || thread.kind === "web") return null;
    return thread.terminalController || null;
  }

  function syncThreadPtyVisibility(thread) {
    if (!thread || !thread.terminalController ||
        typeof thread.terminalController.setVisibility !== "function") {
      return Promise.resolve(false);

    }
    return thread.terminalController.setVisibility(threadTerminalVisibility(thread)).catch(function () {
      return false;
    });
  }

  function syncAllPtyVisibility() {
    state.threads.forEach(function (thread) {
      syncThreadPtyVisibility(thread);
    });
  }

  function createThreadPtyIoQueue() {
    return {
      closed: false,
      inputTail: Promise.resolve(),
      pendingInputBytes: 0,
      pendingInputWrites: 0,
    };
  }

  listen("pty:data-batch", function (event) {
    var payload = event.payload || {};
    if (!payload.threadId || !payload.bytes) return;
    var thread = findThread(payload.threadId);
    if (!isLiveThread(thread)) return;
    if (!thread.terminalController || !thread.terminalController.receive(payload)) return;
    var bytes = new Uint8Array(payload.bytes);
    thread.lastOutputAt = Date.now();
    if (typeof noteStatusPtyData === "function") noteStatusPtyData(payload.threadId, bytes);
    schedulePaneMetricsRefresh(thread, 1200);
  }).catch(function () {});

  async function handlePtyExit(payload) {
    payload = payload || {};
    var thread = findThread(payload.thread_id);
    if (!thread || thread.closing || thread.closeStarted) return false;
    var hasNativeGeneration = payload.generation !== undefined;
    var knownNativeGeneration = Number.isSafeInteger(thread.ptyGeneration) &&
      thread.ptyGeneration > 0 ? thread.ptyGeneration : null;
    if (thread.terminalController &&
        typeof thread.terminalController.currentPtyGeneration === "function") {
      var controllerGeneration = thread.terminalController.currentPtyGeneration();
      if (Number.isSafeInteger(controllerGeneration) && controllerGeneration > 0) {
        knownNativeGeneration = controllerGeneration;
      }
    }
    if (!hasNativeGeneration && knownNativeGeneration !== null) return false;
    if (hasNativeGeneration && Number.isSafeInteger(payload.generation) &&
        payload.generation > 0 && knownNativeGeneration !== null &&
        payload.generation !== knownNativeGeneration) return false;
    var stoppedByUser = thread.stopRequested;
    var exitAccepted = true;
    if (thread.terminalController &&
        typeof thread.terminalController.markPtyExited === "function") {
      exitAccepted = !hasNativeGeneration
        ? thread.terminalController.markPtyExited()
        : thread.terminalController.markPtyExited(payload.generation);
    }
    if (exitAccepted === false) return false;
    thread.ptyLifecycleToken = (thread.ptyLifecycleToken || 0) + 1;
    var exitLifecycleToken = thread.ptyLifecycleToken;
    thread.ptyGeneration = null;
    thread.ptyStarted = false;
    if (thread.ptyIoQueue) thread.ptyIoQueue.closed = true;
    thread.ptyIoQueue = {
      closed: false,
      inputTail: Promise.resolve(),
      pendingInputBytes: 0,
      pendingInputWrites: 0,
    };
    if (thread.startInFlight) {
      thread.exitDuringStart = true;
    }
    thread.stopRequested = false;
    thread.spawning = false;
    thread.finishedAt = Date.now();
    thread.exitCode = payload.code == null ? null : payload.code;
    var persistentLive = false;
    if (isPersistentThread(thread)) {
      try {
        var liveSessionIds = await invoke("native_session_list");
        if (thread.ptyLifecycleToken !== exitLifecycleToken) return false;
        persistentLive = Array.isArray(liveSessionIds) && liveSessionIds.indexOf(thread.id) !== -1;
      } catch (error) {
        if (thread.ptyLifecycleToken !== exitLifecycleToken) return false;
        console.warn("[native_session_list] failed after client exit: " + String(error));
        persistentLive = true;
      }
    }
    if (thread.ptyLifecycleToken !== exitLifecycleToken) return false;
    thread.persistentLive = persistentLive;
    thread.status = persistentLive ? "failed" : "exited";
    thread.isWorking = false;
    if (!persistentLive && !stoppedByUser && payload.code != null && payload.code !== 0) {
      thread.status = "failed";
    }
    // An exited pane is not waiting on an answer, it is over. Leaving the badge
    // would send the user to a pane with nothing to say.
    clearThreadAttention(thread);
    syncThreadPaneMetadata(thread);
    if (thread.terminalController) {
      thread.terminalController.write(persistentLive
        ? "\r\n\x1b[33m[session connection lost — retry to reattach]\x1b[0m\r\n"
        : "\r\n\x1b[2;90m[process exited]\x1b[0m\r\n");
    }
    refreshSidebar();
    refreshTabs();
    if (state.activeThreadId === thread.id) {
      setProjectStatus(findProject(thread.projectId), "warn");
    }
    if (typeof refreshStatusController === "function") refreshStatusController();
    saveWorkspaceSoon();
    return true;
  }

  listen("pty:exit", function (event) {
    handlePtyExit(event.payload || {}).catch(function (error) {
      console.warn("[pty:exit] reconciliation failed: " + String(error));
    });
  }).catch(function () {});

  function findThread(id) {
    for (var i = 0; i < state.threads.length; i++) {
      if (state.threads[i].id === id) return state.threads[i];
    }
    return null;
  }
  function findFocusableThread(id) {
    var thread = findThread(id);
    if (!thread || thread.hidden ||
        (thread.kind === "web"
          ? browserPaneIsClosing(thread)
          : thread.closing || thread.closeStarted)) return null;
    return thread;
  }
  function findFilesPaneBySurfaceId(id) {
    var match = null;
    filesPanes.forEach(function (pane) {
      if (!match && pane.id === id) match = pane;
    });
    return match;
  }
  function canvasSurfaceById(id) {
    return findThread(id) || findFilesPaneBySurfaceId(id);
  }
  function filesPaneHasCanvasFocus(filesPane) {
    if (!filesPane) {
      var file = findOpenFile(state.activeFileId);
      filesPane = file
        ? filesPanes.get(filesPaneKey(file.projectId, file.workspaceRoot))
        : null;
    }
    var project = findProject(state.activeProjectId);
    if (!filesPane || !project ||
        filesPane.projectId !== project.id ||
        filesPane.workspaceRoot !== activeWorkspaceRoot(project)) return false;
    var layout = paneLayoutForThread(filesPane);
    var leaf = layout && layout.root
      ? PsychePanes.findLeafById(layout.root, layout.focusedLeafId)
      : null;
    return !!filesPane && !!leaf && canvasSurfaceById(leaf.threadId) === filesPane;
  }

  function acceptsImageDrop(thread) {
    return !!thread
      && thread.kind !== "web"
      && !thread.closing
      && !thread.closeStarted
      && thread.status === "running"
      && thread.ptyStarted === true;
  }

  function resolveImageDropTarget(position, scaleFactor) {
    var cssPosition = PsycheTerminalInput.physicalToCssPosition(position, scaleFactor);
    if (!cssPosition) return null;
    var element = document.elementFromPoint(cssPosition.x, cssPosition.y);
    var pane = element && typeof element.closest === "function"
      ? element.closest(".terminal-pane[data-thread-id]")
      : null;
    if (!pane) return null;
    var thread = findThread(pane.dataset.threadId);
    return acceptsImageDrop(thread) ? thread : null;
  }

  function clearImageDropTarget() {
    if (imageDropTarget && imageDropTarget.pane) {
      imageDropTarget.pane.classList.remove("image-drop-target");
    }
    imageDropTarget = null;
  }

  function setImageDropTarget(thread) {
    if (thread === imageDropTarget) return;
    clearImageDropTarget();
    if (!acceptsImageDrop(thread) || !thread.pane) return;
    imageDropTarget = thread;
    thread.pane.classList.add("image-drop-target");
  }

  async function insertDroppedImages(thread, paths) {
    var insertion = PsycheTerminalInput.buildImageDropInsertion(paths);
    if (!insertion.accepted.length) {
      toast("No supported images in this drop");
      return false;
    }

    try {
      if (!(await focusThread(thread.id))) {
        setStatus("image drop focus failed", "warn");
        return false;
      }
    } catch (_error) {
      setStatus("image drop focus failed", "warn");
      return false;
    }

    thread = findThread(thread.id);
    if (!acceptsImageDrop(thread)) {
      setStatus("image drop target is no longer available", "warn");
      return false;
    }

    try {
      if (!(await sendToThread(thread, insertion.text))) {
        setStatus("image drop write failed", "error");
        return false;
      }
    } catch (_error) {
      setStatus("image drop write failed", "error");
      return false;
    }

    if (insertion.skipped.length) {
      toast(
        "Inserted " + insertion.accepted.length + " image" +
        (insertion.accepted.length === 1 ? "" : "s") +
        "; skipped " + insertion.skipped.length + " unsupported file" +
        (insertion.skipped.length === 1 ? "" : "s")
      );
    }
    return true;
  }

  async function handleTerminalImageDropEvent(event) {
    var payload = event && event.payload ? event.payload : {};
    if (payload.type === "leave") {
      clearImageDropTarget();
      return false;
    }
    if (payload.type !== "enter" && payload.type !== "over" && payload.type !== "drop") {
      return false;
    }

    var thread = resolveImageDropTarget(payload.position, imageDropScaleFactor);
    setImageDropTarget(thread);
    if (payload.type !== "drop") return !!thread;

    clearImageDropTarget();
    if (!thread) {
      toast("Drop images onto a running terminal pane");
      return false;
    }
    return insertDroppedImages(thread, Array.isArray(payload.paths) ? payload.paths : []);
  }

  async function installTerminalImageDrop() {
    if (!currentWindow ||
        typeof currentWindow.scaleFactor !== "function" ||
        typeof currentWindow.onDragDropEvent !== "function") {
      setStatus("image drop unavailable: Tauri window API missing", "warn");
      return false;
    }

    try {
      var scaleFactor = await currentWindow.scaleFactor();
      if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
        throw new Error("invalid window scale factor");
      }
      imageDropScaleFactor = scaleFactor;
      if (typeof currentWindow.onScaleChanged === "function") {
        await currentWindow.onScaleChanged(function (event) {
          var nextScaleFactor = event && event.payload && event.payload.scaleFactor;
          if (Number.isFinite(nextScaleFactor) && nextScaleFactor > 0) {
            imageDropScaleFactor = nextScaleFactor;
          }
          clearImageDropTarget();
        });
      }
      await currentWindow.onDragDropEvent(handleTerminalImageDropEvent);
      window.addEventListener("blur", clearImageDropTarget);
      return true;
    } catch (error) {
      clearImageDropTarget();
      setStatus("image drop unavailable: " + String(error), "warn");
      return false;
    }
  }

  function findBrowserPane(projectId, worktreePath) {
    return state.threads.find(function (thread) {
      return thread.kind === "web" && thread.projectId === projectId &&
        thread.worktreePath === worktreePath;
    }) || null;
  }

  // ============================================================
  // 5a. Hover to focus
  // ============================================================

  // Focus follows the mouse across the canvas: resting over a pane makes it the
  // one that types, with no click. One delegated listener on the host rather
  // than a handler per pane, so it covers terminal and browser panes alike and
  // survives the canvas being re-tiled.
  //
  // Every guard here exists because hover is an *accidental* gesture -- the
  // pointer crosses panes on the way to somewhere else, and it must not be
  // able to interrupt something the user is deliberately doing.

  var HOVER_FOCUS_DWELL_MS = 140;
  var hoverFocusTimer = null;

  function cancelHoverFocus() {
    if (hoverFocusTimer === null) return;
    clearTimeout(hoverFocusTimer);
    hoverFocusTimer = null;
  }

  function hoverFocusBlocked() {
    // Mid-drag the pointer is over panes it is not choosing, and re-tiling
    // under a live drag would drop the gesture.
    if (document.body.classList.contains("is-pane-dragging")) return true;
    // An inline rename and a modal both own the keyboard; taking it back would
    // discard what the user is part-way through.
    if (editingContext) return true;
    if (document.querySelector(".session-context-menu")) return true;
    // The composer, the URL bar, a palette query: text the user is typing into
    // is never worth losing to a stray pointer resting on the canvas.
    var focused = document.activeElement;
    if (focused && focused !== document.body) {
      var editable = focused.isContentEditable
        || focused.tagName === "INPUT"
        || focused.tagName === "TEXTAREA";
      if (editable) {
        var terminalInput = focused.closest && focused.closest(".xterm");
        if (!terminalInput) return true;
      }
    }
    return false;
  }

  if (terminalHost) {
    terminalHost.addEventListener("pointerover", function (event) {
      // Touch and pen have no hover: for them a tap already means "focus this".
      if (event.pointerType && event.pointerType !== "mouse") return;
      var paneEl = event.target && event.target.closest
        ? event.target.closest(".terminal-pane")
        : null;
      cancelHoverFocus();
      if (!paneEl || !paneEl.dataset.threadId) return;
      var threadId = paneEl.dataset.threadId;
      if (threadId === state.activeThreadId) return;
      hoverFocusTimer = setTimeout(function () {
        hoverFocusTimer = null;
        // Re-checked on fire, not just on entry: the dwell is long enough for a
        // drag to start or a dialog to open after the pointer arrived.
        if (hoverFocusBlocked()) return;
        if (threadId === state.activeThreadId) return;
        if (!findThread(threadId)) return;
        focusThread(threadId);
      }, HOVER_FOCUS_DWELL_MS);
    });
    terminalHost.addEventListener("pointerleave", cancelHoverFocus);
  }

  // ============================================================
  // 5b. "This pane is waiting on you"
  // ============================================================

  // A pane that has asked the user something and gone quiet is the one state
  // the app must never let scroll past. The rail already knew how to *count*
  // sessions needing attention, but nothing ever set the flag on a local pane,
  // so the badges only ever lit for daemon-reported Coven sessions. This is
  // where local panes earn it: sample the visible tail, and when it settles
  // with no sign of work in flight, the turn is the user's.
  //
  // Shells are exempt. A prompt sitting at `$` is idle, not waiting -- flagging
  // that would put a permanent badge on every terminal in the app.

  var ATTENTION_SAMPLE_MS = 700;
  var ATTENTION_TAIL_LINES = 14;
  var attentionTracker = PsycheSessions.createAttentionTracker();

  function threadWantsAttentionTracking(thread) {
    return !!thread
      && (thread.kind || "shell") !== "shell"
      && thread.kind !== "web"
      && !thread.closing
      && !thread.closeStarted
      && thread.status !== "exited"
      && thread.status !== "failed";
  }

  /**
   * Push a session's attention state onto every surface that shows it. Only the
   * rail is re-rendered wholesale; the pane and its minimap entry are touched
   * in place, because this runs on a timer and re-tiling the canvas under a
   * user mid-drag would be worse than the badge it is trying to draw.
   */
  function applyThreadAttention(thread, next) {
    var was = !!thread.needsAttention;
    var wasReason = thread.attentionReason || null;
    if (was === next.needsAttention && wasReason === next.reason) return false;
    thread.needsAttention = next.needsAttention;
    thread.attentionReason = next.reason;
    syncThreadAttentionChrome(thread);
    renderSessionList();
    syncSessionListScroll();
    return true;
  }

  function syncThreadAttentionChrome(thread) {
    if (!thread) return;
    if (thread.pane) {
      thread.pane.classList.toggle("needs-attention", !!thread.needsAttention);
      syncPaneBranchStatusChrome(thread.pane.parentElement);
    }
    if (thread.paneAttention) {
      var label = PsycheSessions.attentionLabel(thread.attentionReason);
      thread.paneAttention.hidden = !thread.needsAttention;
      thread.paneAttention.textContent = thread.needsAttention ? label : "";
      thread.paneAttention.title = label;
      thread.paneAttention.setAttribute("aria-label", label);
    }
    var minimapDot = terminalArea &&
      terminalArea.querySelector('.minimap-pane[data-thread-id="' + thread.id + '"] .minimap-dot');
    if (minimapDot) minimapDot.classList.toggle("attention", !!thread.needsAttention);
  }

  function noteThreadInput(thread, text) {
    if (!thread || !threadWantsAttentionTracking(thread)) return;
    var next = text === "\x03"
      ? attentionTracker.interrupt(thread.id)
      : attentionTracker.userInput(thread.id);
    applyThreadAttention(thread, next);
  }

  function clearThreadAttention(thread) {
    if (!thread) return false;
    attentionTracker.forget(thread.id);
    return applyThreadAttention(thread, { needsAttention: false, reason: null });
  }

  function syncLocalSidebarStatusKeys(now) {
    state.threads.forEach(function (thread) {
      if (!thread) return;
      thread.sidebarStatusKey = PsycheSessions.deriveLocalSidebarStatus(thread, now).key;
    });
  }

  function sampleThreadAttention() {
    var now = Date.now();
    var tracked = [];
    var needsFinalRender = false;
    state.threads.forEach(function (thread) {
      if (!thread || !thread.terminalController) return;
      var tail = thread.terminalController.tail(ATTENTION_TAIL_LINES);
      thread.isWorking = PsycheSessions.sidebarTailIsWorking(tail);
      var attentionChanged = false;
      if (!threadWantsAttentionTracking(thread)) {
        if (thread.needsAttention) {
          attentionChanged = clearThreadAttention(thread);
        }
      } else {
        tracked.push(thread.id);
        attentionChanged = applyThreadAttention(
          thread,
          attentionTracker.observe(thread.id, tail, now)
        );
      }
      var nextStatus = PsycheSessions.deriveLocalSidebarStatus(thread, now);
      var statusChanged = false;
      if (thread.sidebarStatusKey !== nextStatus.key) {
        thread.sidebarStatusKey = nextStatus.key;
        statusChanged = true;
      }
      if (attentionChanged) {
        needsFinalRender = false;
      } else if (statusChanged) {
        needsFinalRender = true;
      }
    });
    attentionTracker.retain(tracked);
    if (needsFinalRender) {
      renderSessionList();
      syncSessionListScroll();
    }
  }

  setInterval(sampleThreadAttention, ATTENTION_SAMPLE_MS);

  // ============================================================
  // 6. Threads — create / focus / close
  // ============================================================

  var threadCounter = 0;
  function makeThreadId() {
    threadCounter += 1;
    return "t" + Date.now().toString(36) + "-" + threadCounter;
  }
  function isLiveThread(thread) {
    return !!thread && !thread.closing && state.threads.indexOf(thread) !== -1;
  }

  function threadCovenSessionId(thread) {
    return thread && thread.launch && thread.launch.covenSessionId || null;
  }

  function isPersistentThread(thread) {
    var launchKind = thread && thread.launch && thread.launch.launchKind;
    return ["shell", "psyche", "coven-code", "coven-attach"].indexOf(launchKind) !== -1;
  }

  function nativeSessionRequest(thread) {
    var request = {
      id: thread.id,
      projectRoot: thread.launch.projectRoot,
      cwd: thread.launch.cwd,
      launchKind: thread.launch.launchKind,
    };
    if (thread.launch.launchKind === "coven-attach") {
      request.covenSessionId = thread.launch.covenSessionId || null;
    }
    return request;
  }

  var nativeSessionCreatesByProject = new Map();
  function projectNativeSessionCreateCount(projectId) {
    return nativeSessionCreatesByProject.get(projectId) || 0;
  }
  async function createNativeSessionForThread(thread, options) {
    var projectId = thread && thread.projectId;
    var project = projectId ? findProject(projectId) : null;
    var preAdmission = options && options.mode === "pre-admission";
    if (!project) {
      throw new Error("project no longer exists");
    }
    if ((!preAdmission && !isLiveThread(thread)) ||
        thread.closeStarted || thread.closing) {
      throw new Error("thread is no longer live");
    }
    if (project.closing) {
      throw new Error("project is closing");
    }
    if (projectId) {
      nativeSessionCreatesByProject.set(
        projectId,
        projectNativeSessionCreateCount(projectId) + 1
      );
    }
    try {
      return await invoke("native_session_create", {
        request: nativeSessionRequest(thread),
      });
    } finally {
      if (projectId) {
        var remaining = projectNativeSessionCreateCount(projectId) - 1;
        if (remaining > 0) nativeSessionCreatesByProject.set(projectId, remaining);
        else nativeSessionCreatesByProject.delete(projectId);
      }
    }
  }

  // An exited pane is not an attachment you can focus, so it must not make a
  // row read as attached. main added that guard to isReusableCovenAttachment
  // alongside createCovenSessionRow; this branch replaced that render path with
  // the sidebar model, so the guard is carried here instead of being lost with
  // the function it arrived in.
  function covenRowAttached(state, projectId, sessionId) {
    return state.threads.some(function (thread) {
      return thread.projectId === projectId
        && threadCovenSessionId(thread) === sessionId
        && (thread.status === "starting" || thread.status === "running")
        && !thread.closeStarted;
    });
  }

  async function createThread(opts) {
    var project = opts.project || activeProject();
    if (project && project.closing) {
      setStatus(project.name + " is closing; no new pane can be created", "warn");
      return null;
    }
    var id = makeThreadId();
    var sourceLaunch = opts.launch || {
      command: opts.command,
      args: opts.args || [],
      env: opts.env || {},
      projectRoot: opts.projectRoot || (project && project.root),
      cwd: opts.cwd || opts.worktreePath || opts.projectRoot,
      launchKind: opts.launchKind || null,
      covenSessionId: opts.covenSessionId || null,
      promptDigest: opts.promptDigest || null,
      metricsProvider: opts.metricsProvider || null,
    };
    var sourceLaunchKind = sourceLaunch.launchKind || null;
    var isCovenCodeLaunch = sourceLaunchKind === "coven-code";
    var isCovenAttachLaunch = sourceLaunchKind === "coven-attach";
    var launch = {
      command: sourceLaunch.command,
      args: Array.isArray(sourceLaunch.args) ? sourceLaunch.args.slice() : [],
      env: Object.assign({}, sourceLaunch.env || {}),
      projectRoot: sourceLaunch.projectRoot || (project && project.root) || null,
      cwd: sourceLaunch.cwd || opts.worktreePath || sourceLaunch.projectRoot ||
        (project && activeWorkspaceRoot(project)) || null,
      launchKind: sourceLaunchKind,
      covenSessionId: isCovenAttachLaunch ? sourceLaunch.covenSessionId || null : null,
      // A bounded prompt reference (short digest) for the accepted daemon
      // launch; the raw prompt never enters this model. In-memory only — the
      // persisted workspace descriptor keeps launchKind and the canonical
      // Coven session id.
      promptDigest: isCovenAttachLaunch ? sourceLaunch.promptDigest || null : null,
      metricsProvider: isCovenCodeLaunch
        ? null
        : sourceLaunch.metricsProvider || opts.metricsProvider || null,
    };
    var worktreePath = opts.worktreePath || launch.cwd || launch.projectRoot ||
      (project && activeWorkspaceRoot(project));
    var projectId = project ? project.id : null;
    var placement = preparePanePlacement(id, projectId, worktreePath);
    if (!placement) {
      setStatus("Not enough space for another terminal pane", "warn");
      return null;
    }
    var thread = {
      id: id,
      projectId: projectId,
      worktreePath: worktreePath,
      name: opts.name || "thread " + (state.threads.length + 1),
      kind: opts.kind || "shell",
      launch: launch,
      status: "starting",
      spawning: true,
      term: null,
      host: null,
      pane: null,
      closing: false,
      closeStarted: false,
      startInFlight: false,
      exitDuringStart: false,
      stopRequested: false,
      ptyStarted: false,
      ptyGeneration: null,
      ptyLifecycleToken: 0,
      terminalController: null,
      ptyIoQueue: {
        closed: false,
        inputTail: Promise.resolve(),
        pendingInputBytes: 0,
        pendingInputWrites: 0,
      },
      metricsGeneration: 0,
      metrics: launch.launchKind === "coven-code" && launch.covenSessionId
        ? loadingPaneMetrics(launch)
        : null,
      metricsRefreshTimer: 0,
      lastOutputAt: 0,
      isWorking: false,
      sidebarStatusKey: "busy",
      startedAt: Date.now(),
      finishedAt: null,
      exitCode: null,
    };
    if (isPersistentThread(thread) && !opts.deferStart) {
      try {
        await createNativeSessionForThread(thread, { mode: "pre-admission" });
      } catch (error) {
        setStatus(thread.name + " failed to start: " + String(error), "error");
        return null;
      }
    }
    commitPanePlacement(placement);
    state.threads.push(thread);
    if (typeof noteStatusActivity === "function") noteStatusActivity();
    mountTerminal(thread);
    focusThread(id, opts.focusTerminal === false ? { focusTerminal: false } : undefined);
    refreshSidebar();
    refreshTabs();
    if (opts.deferStart) {
      return thread;
    }
    // The controller's initial keyed frame fits before this later spawn frame,
    // so the PTY starts at the visible xterm size instead of 80x24.
    if (opts.waitForPtyStart) {
      await new Promise(function (resolve) { requestAnimationFrame(resolve); });
      if (!isLiveThread(thread)) return null;
      var started = isPersistentThread(thread)
        ? await attachThreadClientAndResolveRecovery(thread)
        : await spawnPty(thread);
      return started ? thread : null;
    }
    requestAnimationFrame(function () {
      if (!isLiveThread(thread)) return;
      if (isPersistentThread(thread)) attachThreadClientAndResolveRecovery(thread);
      else spawnPty(thread);
    });
    return thread;
  }

  async function reserveCovenLaunchThread(opts) {
    var thread = await createThread({
      project: opts.project,
      worktreePath: opts.worktreePath,
      name: opts.name + " launch recovery",
      kind: "coven-recovery",
      launchKind: "coven-recovery",
      projectRoot: opts.projectRoot,
      cwd: opts.worktreePath,
      promptDigest: opts.promptDigest || null,
      deferStart: true,
      focusTerminal: false,
    });
    if (!thread) return null;
    try {
      await saveWorkspaceNow();
    } catch (persistenceError) {
      var cleanupError = null;
      try {
        var released = await releaseCovenLaunchReservation(thread);
        if (released !== true) {
          cleanupError = new Error("reservation cleanup was not confirmed");
        }
      } catch (error) {
        cleanupError = error;
      }
      var message =
        "Coven launch was not submitted because its recovery reservation could not be saved: " +
        String(persistenceError);
      if (cleanupError) {
        message += "; reservation cleanup also failed: " + String(cleanupError);
      }
      throw new Error(message);
    }
    return thread;
  }

  function hasCovenLaunchRecovery(projectId, worktreePath) {
    return state.threads.some(function (thread) {
      return thread.projectId === projectId
        && thread.worktreePath === worktreePath
        && thread.launch
        && (thread.launch.launchKind === "coven-recovery" ||
          thread.launch.recoveryRequired === true);
    });
  }

  async function markCovenLaunchRecoveryRequired(thread, message) {
    if (!isLiveThread(thread)) return null;
    thread.status = "failed";
    thread.spawning = false;
    thread.finishedAt = Date.now();
    thread.sidebarStatusKey = "error";
    if (thread.terminalController) {
      thread.terminalController.write(
        "\r\n\x1b[33m[launch outcome unknown]\x1b[0m " + String(message) + "\r\n"
      );
    }
    syncThreadPaneMetadata(thread);
    refreshSidebar();
    refreshTabs();
    await saveWorkspaceNow();
    return thread;
  }

  async function releaseCovenLaunchReservation(thread) {
    if (!thread) return false;
    return closeThread(thread.id, {
      skipNativeSessionStop: true,
      protectCovenRecovery: false,
    });
  }

  async function acceptCovenLaunchReservation(thread, options) {
    function reservationIsCurrent() {
      return !thread.closeStarted && state.threads.indexOf(thread) !== -1;
    }

    function surfaceClosedReservation() {
      setStatus(
        (options.name || thread.name || "Coven launch") +
          " was accepted by Coven after its local reservation was closed; " +
          "no local attachment was created. Inspect Coven session " +
          options.sessionId + ".",
        "error"
      );
    }

    function surfaceNonDurableRecovery(error) {
      if (thread.terminalController) {
        thread.terminalController.write(
          "\r\n\x1b[31m[Coven recovery state is not durable]\x1b[0m " +
            "inspect Coven before closing: " + String(error) + "\r\n"
        );
      }
      setStatus(
        thread.name +
          " was accepted by Coven, but its recovery state is not durable; " +
          "inspect Coven before closing: " + String(error),
        "error"
      );
    }

    if (!reservationIsCurrent()) {
      surfaceClosedReservation();
      return null;
    }

    var finishAcceptance;
    var acceptanceInFlight = new Promise(function (resolve) {
      finishAcceptance = resolve;
    });
    thread.covenLaunchAcceptanceInFlight = acceptanceInFlight;
    try {
      thread.name = options.name || thread.name;
      thread.kind = "coven-attach";
      thread.launch.command = state.env.coven_path;
      thread.launch.args = ["attach", options.sessionId];
      thread.launch.launchKind = "coven-attach";
      thread.launch.covenSessionId = options.sessionId;
      thread.launch.promptDigest = options.promptDigest || null;
      thread.launch.metricsProvider = options.harness || "coven";
      thread.launch.recoveryRequired = true;
      thread.status = "starting";
      thread.spawning = true;
      thread.finishedAt = null;
      syncThreadPaneMetadata(thread);
      refreshSidebar();
      refreshTabs();
      try {
        await saveWorkspaceNow();
      } catch (error) {
        thread.launch.recoveryRequired = true;
        thread.status = "failed";
        thread.spawning = false;
        thread.finishedAt = Date.now();
        thread.sidebarStatusKey = "error";
        if (thread.terminalController) {
          thread.terminalController.write(
            "\r\n\x1b[31m[Coven session accepted; local recovery required]\x1b[0m " +
              String(error) + "\r\n"
          );
        }
        setStatus(
          thread.name + " was accepted by Coven but local recovery is required: " + String(error),
          "error"
        );
        syncThreadPaneMetadata(thread);
        refreshSidebar();
        refreshTabs();
        try {
          await saveWorkspaceNow();
        } catch (recoverySaveError) {
          surfaceNonDurableRecovery(recoverySaveError);
        }
        return thread;
      }
      if (!reservationIsCurrent()) {
        surfaceClosedReservation();
        return thread;
      }
      try {
        await createNativeSessionForThread(thread);
        thread.persistentLive = true;
      } catch (error) {
        thread.launch.recoveryRequired = true;
        thread.status = "failed";
        thread.spawning = false;
        thread.finishedAt = Date.now();
        if (thread.terminalController) {
          thread.terminalController.write(
            "\r\n\x1b[31m[Coven session accepted; local attachment unavailable]\x1b[0m " +
              String(error) + "\r\n"
          );
        }
        setStatus(
          thread.name + " was accepted by Coven but could not be attached: " + String(error),
          "error"
        );
        syncThreadPaneMetadata(thread);
        refreshSidebar();
        refreshTabs();
        try {
          await saveWorkspaceNow();
        } catch (recoverySaveError) {
          surfaceNonDurableRecovery(recoverySaveError);
        }
        return thread;
      }
      if (!reservationIsCurrent()) {
        surfaceClosedReservation();
        return thread;
      }
      var attached;
      var attachmentError = null;
      try {
        attached = await attachThreadClient(thread);
      } catch (error) {
        attached = false;
        attachmentError = error;
      }
      if (!attached) {
        thread.launch.recoveryRequired = true;
        thread.status = "failed";
        thread.spawning = false;
        thread.finishedAt = Date.now();
        thread.sidebarStatusKey = "error";
        setStatus(
          thread.name +
            " was accepted by Coven but its local attachment did not start" +
            (attachmentError ? ": " + String(attachmentError) : "") + "; " +
            "inspect Coven before closing",
          "error"
        );
        syncThreadPaneMetadata(thread);
        refreshSidebar();
        refreshTabs();
        return thread;
      }
      thread.launch.recoveryRequired = false;
      try {
        await saveWorkspaceNow();
      } catch (error) {
        thread.launch.recoveryRequired = true;
        thread.sidebarStatusKey = "error";
        if (thread.terminalController) {
          thread.terminalController.write(
            "\r\n\x1b[31m[Coven session accepted; attachment persistence failed]\x1b[0m " +
              String(error) + "\r\n"
          );
        }
        setStatus(
          thread.name +
            " was accepted by Coven but final attachment persistence failed; " +
            "local recovery is required: " + String(error),
          "error"
        );
        syncThreadPaneMetadata(thread);
        refreshSidebar();
        refreshTabs();
        try {
          await saveWorkspaceNow();
        } catch (recoverySaveError) {
          surfaceNonDurableRecovery(recoverySaveError);
        }
      }
      return thread;
    } finally {
      if (thread.covenLaunchAcceptanceInFlight === acceptanceInFlight) {
        thread.covenLaunchAcceptanceInFlight = null;
      }
      finishAcceptance();
    }
  }

  async function createBrowserPane(project) {
    var options = arguments[1] || {};
    project = project || activeProject();
    if (!project || project.closing) return null;
    var worktreePath = options.worktreePath || activeWorkspaceRoot(project);
    var isCurrent = typeof options.isCurrent === "function"
      ? options.isCurrent
      : function () { return true; };
    if (!worktreePath || !isCurrent() || project.closing) return null;
    var sourceLayout = paneLayoutFor(project.id, worktreePath);
    var sourceMaximizedLeafId = sourceLayout && sourceLayout.maximizedLeafId;
    if (!(await showTerminalView())) return null;
    if (!isCurrent() || project.closing) return null;
    var existing = findBrowserPane(project.id, worktreePath);
    if (existing) {
      if (browserPaneIsClosing(existing)) return null;
      await focusThread(existing.id);
      return !isCurrent() || browserPaneIsClosing(existing) ? null : existing;
    }
    await new Promise(function (resolve) { requestAnimationFrame(resolve); });
    if (!isCurrent() || project.closing) return null;
    existing = findBrowserPane(project.id, worktreePath);
    if (existing) {
      if (browserPaneIsClosing(existing)) return null;
      await focusThread(existing.id);
      return !isCurrent() || browserPaneIsClosing(existing) ? null : existing;
    }
    var id = makeThreadId();
    var placement = preparePanePlacement(id, project.id, worktreePath);
    if (!placement) {
      setStatus("Not enough space for another pane", "warn");
      return null;
    }
    if (project.closing) return null;
    var pane = {
      id: id,
      projectId: project.id,
      worktreePath: worktreePath,
      name: "Web",
      kind: "web",
      status: "running",
      spawning: false,
      term: null,
      fit: null,
      host: null,
      pane: null,
      closing: false,
      closeStarted: false,
      startInFlight: false,
      stopRequested: false,
      ptyStarted: false,
      ptyGeneration: null,
      ptyLifecycleToken: 0,
    };
    commitPanePlacement(placement);
    state.threads.push(pane);
    if (typeof noteStatusActivity === "function") noteStatusActivity();
    mountBrowserPane(pane);
    var focusOptions = { focusTerminal: false };
    if (sourceMaximizedLeafId) {
      focusOptions.preserveFullscreenLeafId = sourceMaximizedLeafId;
    }
    await focusThread(id, focusOptions);
    if (!isCurrent() || browserPaneIsClosing(pane) ||
        findBrowserPane(project.id, worktreePath) !== pane) return null;
    refreshSidebar();
    refreshTabs();
    return pane;
  }

  function stopThreadPty(thread) {
    if (!thread || thread.stopRequested) return Promise.resolve(false);
    thread.stopRequested = true;
    var knownGeneration = Number.isSafeInteger(thread.ptyGeneration) && thread.ptyGeneration > 0
      ? thread.ptyGeneration
      : null;
    var generationLookup = knownGeneration !== null ||
      (!thread.ptyStarted && thread.status !== "running")
      ? Promise.resolve(knownGeneration)
      : invoke("pty_current_generation", {
        threadId: thread.id,
        thread_id: thread.id,
      }).then(function (value) {
        return Number.isSafeInteger(value) && value > 0 ? value : null;
      });
    return generationLookup.then(function (generation) {
      var args = {
        threadId: thread.id,
        thread_id: thread.id,
      };
      if (generation !== null) args.generation = generation;
      return invoke("pty_stop", args);
    }).then(function () {
      return true;
    }).catch(function (err) {
      console.warn("[pty_stop] failed for " + thread.id + ": " + String(err));
      return false;
    });
  }

  function spawnPty(thread) {
    if (!isLiveThread(thread) || thread.startInFlight || thread.closeStarted ||
        thread.ptyStarted || thread.status === "running") {
      return Promise.resolve(false);
    }
    var launch = thread.launch;
    var terminalController = ensureThreadPtyController(thread);
    thread.ptyLifecycleToken = (thread.ptyLifecycleToken || 0) + 1;
    var ptyLifecycleToken = thread.ptyLifecycleToken;
    thread.ptyGeneration = null;
    var ptyStartAttempt = null;
    if (terminalController && typeof terminalController.prepareForPtyStart === "function") {
      ptyStartAttempt = terminalController.prepareForPtyStart();
    }
    thread.lastOutputAt = 0;
    thread.isWorking = false;
    thread.sidebarStatusKey = "busy";
    attentionTracker.forget(thread.id);
    thread.needsAttention = false;
    thread.attentionReason = null;
    syncThreadAttentionChrome(thread);
    thread.stopRequested = false;
    thread.exitDuringStart = false;
    thread.startInFlight = true;
    thread.status = "starting";
    thread.spawning = true;
    thread.startedAt = Date.now();
    thread.finishedAt = null;
    thread.exitCode = null;
    syncThreadPaneMetadata(thread);
    refreshSidebar();
    refreshTabs();
    var terminalSize = terminalController && typeof terminalController.dimensions === "function"
      ? terminalController.dimensions()
      : { cols: 120, rows: 40 };
    return invoke("pty_start", {
      options: {
        threadId: thread.id,
        thread_id: thread.id,
        projectRoot: launch.projectRoot,
        project_root: launch.projectRoot,
        cwd: launch.cwd,
        launchKind: launch.launchKind,
        launch_kind: launch.launchKind,
        covenSessionId: launch.covenSessionId,
        coven_session_id: launch.covenSessionId,
        command: launch.command,
        args: launch.args,
        cols: terminalSize.cols,
        rows: terminalSize.rows,
        env: launch.env,
      },
    }).then(function (ptyStartResult) {
      thread.startInFlight = false;
      thread.ptyGeneration = ptyStartResult && Number.isSafeInteger(ptyStartResult.generation) &&
        ptyStartResult.generation > 0
        ? ptyStartResult.generation
        : null;
      if (!isLiveThread(thread)) {
        if (terminalController &&
            typeof terminalController.restoreAfterFailedPtyStart === "function") {
          terminalController.restoreAfterFailedPtyStart(ptyStartAttempt);
        }
        return stopThreadPty(thread).then(function () { return false; });
      }
      if (thread.exitDuringStart) {
        thread.exitDuringStart = false;
        thread.ptyGeneration = null;
        thread.ptyStarted = false;
        thread.spawning = false;
        thread.isWorking = false;
        if (terminalController &&
            typeof terminalController.restoreAfterFailedPtyStart === "function") {
          terminalController.restoreAfterFailedPtyStart(ptyStartAttempt);
        }
        syncThreadPaneMetadata(thread);
        refreshSidebar();
        refreshTabs();
        return false;
      }
      thread.ptyStarted = true;
      thread.status = "running";
      thread.spawning = false;
      if (thread.terminalController &&
          typeof thread.terminalController.markPtyStarted === "function") {
        thread.terminalController.markPtyStarted(
          ptyStartAttempt,
          ptyStartResult && Number.isSafeInteger(ptyStartResult.generation) &&
            ptyStartResult.generation > 0
            ? ptyStartResult.generation
            : undefined
        ).catch(function () {});
      }
      syncThreadPaneMetadata(thread);
      refreshSidebar();
      refreshTabs();
      if (state.activeThreadId === thread.id) {
        setProjectStatus(findProject(thread.projectId), "ok");
      }
      return true;
    }).catch(function (err) {
      thread.startInFlight = false;
      thread.ptyGeneration = null;
      var msg = String(err);
      if (!isLiveThread(thread)) {
        if (terminalController &&
            typeof terminalController.restoreAfterFailedPtyStart === "function") {
          terminalController.restoreAfterFailedPtyStart(ptyStartAttempt);
        }
        if (msg.indexOf("already running") !== -1) {
          thread.ptyStarted = true;
          return stopThreadPty(thread).then(function () { return false; });
        }
        return false;
      }
      if (thread.exitDuringStart) {
        thread.exitDuringStart = false;
        thread.ptyGeneration = null;
        thread.ptyStarted = false;
        thread.spawning = false;
        thread.isWorking = false;
        if (terminalController &&
            typeof terminalController.restoreAfterFailedPtyStart === "function") {
          terminalController.restoreAfterFailedPtyStart(ptyStartAttempt);
        }
        syncThreadPaneMetadata(thread);
        refreshSidebar();
        refreshTabs();
        return false;
      }
      thread.spawning = false;
      if (msg.indexOf("cleanup in progress") !== -1) {
        if (terminalController &&
            typeof terminalController.restoreAfterFailedPtyStart === "function") {
          terminalController.restoreAfterFailedPtyStart(ptyStartAttempt);
        }
        thread.ptyStarted = false;
        if (thread.terminalController) thread.terminalController.stopPtyDelivery();

        thread.status = "exited";
        thread.finishedAt = Date.now();
        thread.exitCode = null;
        if (state.activeThreadId === thread.id) {
          setStatus(thread.name + " is still cleaning up; retry shortly", "warn");
        }
      } else if (msg.indexOf("already running") !== -1) {
        thread.ptyStarted = true;
        thread.status = "running";
        thread.stopRequested = false;
        var adoptionPromise = invoke("pty_current_generation", {
          threadId: thread.id,
          thread_id: thread.id,
        }).then(function (generation) {
          if (thread.ptyLifecycleToken !== ptyLifecycleToken || !isLiveThread(thread)) {
            if (terminalController &&
                typeof terminalController.restoreAfterFailedPtyStart === "function") {
              terminalController.restoreAfterFailedPtyStart(ptyStartAttempt);
            }
            return false;
          }
          var nativeGeneration = Number.isSafeInteger(generation) && generation > 0
            ? generation
            : null;
          if (nativeGeneration === null) {
            throw new Error("native PTY generation was not returned for adoption");
          }
          thread.ptyGeneration = nativeGeneration;
          if (terminalController &&
              typeof terminalController.adoptRunningPty === "function") {
            return terminalController.adoptRunningPty(ptyStartAttempt, nativeGeneration);
          }
          if (terminalController &&
              typeof terminalController.markPtyStarted === "function") {
            return terminalController.markPtyStarted(ptyStartAttempt, nativeGeneration);
          }
          return true;
        }).catch(function (adoptionError) {
          if (terminalController &&
              typeof terminalController.restoreAfterFailedPtyStart === "function") {
            terminalController.restoreAfterFailedPtyStart(ptyStartAttempt);
          }
          thread.ptyGeneration = null;
          thread.ptyStarted = false;
          thread.status = "failed";
          thread.isWorking = false;
          thread.finishedAt = Date.now();
          thread.exitCode = null;
          if (thread.terminalController) {
            thread.terminalController.write(
              "\r\n\x1b[31m[pty adoption error]\x1b[0m " +
                String(adoptionError) + "\r\n",
            );
          }
          syncThreadPaneMetadata(thread);
          refreshSidebar();
          refreshTabs();
          return false;
        });
        if (state.activeThreadId === thread.id) {
          setProjectStatus(findProject(thread.projectId), "ok");
        }
        syncThreadPaneMetadata(thread);
        refreshSidebar();
        refreshTabs();
        return adoptionPromise;
      } else {
        if (terminalController &&
            typeof terminalController.restoreAfterFailedPtyStart === "function") {
          terminalController.restoreAfterFailedPtyStart(ptyStartAttempt);
        }
        thread.ptyStarted = false;
        thread.status = "failed";
        thread.isWorking = false;
        thread.finishedAt = Date.now();
        thread.exitCode = null;
        if (thread.terminalController) {
          thread.terminalController.write("\r\n\x1b[31m[pty_start error]\x1b[0m " + msg + "\r\n");
        }
        if (state.activeThreadId === thread.id) {
          setStatus(thread.name + " failed to start: " + msg, "error");
        }
      }
      syncThreadPaneMetadata(thread);
      refreshSidebar();
      refreshTabs();
      return thread.status === "running";
    });
  }

  function attachThreadClient(thread) {
    if (!isLiveThread(thread) || thread.startInFlight || thread.closeStarted ||
        thread.ptyStarted) {
      return Promise.resolve(false);
    }
    var terminalController = ensureThreadPtyController(thread);
    thread.ptyLifecycleToken = (thread.ptyLifecycleToken || 0) + 1;
    var ptyLifecycleToken = thread.ptyLifecycleToken;
    thread.ptyGeneration = null;
    var ptyStartAttempt = terminalController &&
      typeof terminalController.prepareForPtyStart === "function"
        ? terminalController.prepareForPtyStart()
        : null;
    thread.lastOutputAt = 0;
    thread.isWorking = false;
    thread.sidebarStatusKey = "busy";
    attentionTracker.forget(thread.id);
    thread.needsAttention = false;
    thread.attentionReason = null;
    syncThreadAttentionChrome(thread);
    thread.stopRequested = false;
    thread.exitDuringStart = false;
    thread.startInFlight = true;
    thread.status = "starting";
    thread.spawning = true;
    thread.startedAt = Date.now();
    thread.finishedAt = null;
    thread.exitCode = null;
    syncThreadPaneMetadata(thread);
    refreshSidebar();
    refreshTabs();
    return invoke("pty_attach", {
      options: {
        threadId: thread.id,
        sessionId: thread.id,
        cols: thread.term ? thread.term.cols : 120,
        rows: thread.term ? thread.term.rows : 40,
      },
    }).then(function (ptyStartResult) {
      thread.startInFlight = false;
      thread.ptyGeneration = ptyStartResult && Number.isSafeInteger(ptyStartResult.generation) &&
        ptyStartResult.generation > 0
        ? ptyStartResult.generation
        : null;
      if (!isLiveThread(thread)) return stopThreadPty(thread).then(function () { return false; });
      if (thread.exitDuringStart) {
        thread.exitDuringStart = false;
        thread.ptyGeneration = null;
        thread.spawning = false;
        return false;
      }
      thread.ptyStarted = true;
      thread.status = "running";
      thread.spawning = false;
      if (terminalController && typeof terminalController.markPtyStarted === "function") {
        terminalController.markPtyStarted(
          ptyStartAttempt,
          ptyStartResult && Number.isSafeInteger(ptyStartResult.generation) &&
            ptyStartResult.generation > 0
            ? ptyStartResult.generation
            : undefined
        ).catch(function () {});
      }
      syncThreadPaneMetadata(thread);
      refreshSidebar();
      refreshTabs();
      if (state.activeThreadId === thread.id) setProjectStatus(findProject(thread.projectId), "ok");
      return true;
    }).catch(function (error) {
      thread.startInFlight = false;
      thread.ptyGeneration = null;
      if (terminalController &&
          typeof terminalController.restoreAfterFailedPtyStart === "function") {
        terminalController.restoreAfterFailedPtyStart(ptyStartAttempt);
      }
      if (!isLiveThread(thread)) return false;
      thread.ptyStarted = false;
      thread.spawning = false;
      thread.status = "failed";
      thread.isWorking = false;
      thread.finishedAt = Date.now();
      thread.exitCode = null;
      if (thread.term) {
        thread.term.write("\r\n\x1b[31m[attach error]\x1b[0m " + String(error) + "\r\n");
      }
      syncThreadPaneMetadata(thread);
      refreshSidebar();
      refreshTabs();
      saveWorkspaceSoon();
      return false;
    });
  }

  async function attachThreadClientAndResolveRecovery(thread) {
    var attached = await attachThreadClient(thread);
    if (!attached || !thread.launch ||
        thread.launch.launchKind !== "coven-attach" ||
        thread.launch.recoveryRequired !== true) {
      return attached;
    }
    thread.launch.recoveryRequired = false;
    try {
      await saveWorkspaceNow();
      setStatus(thread.name + " Coven recovery resolved after successful reattachment", "ok");
    } catch (error) {
      thread.launch.recoveryRequired = true;
      syncThreadPaneMetadata(thread);
      refreshSidebar();
      refreshTabs();
      setStatus(
        thread.name +
          " reattached, but its recovery resolution is not durable; " +
          "inspect Coven before closing: " + String(error),
        "error"
      );
      saveWorkspaceSoon();
    }
    return true;
  }

  async function retryThread(id) {
    var thread = findThread(id);
    if (!thread || thread.startInFlight || thread.retryInFlight || thread.closeStarted) return false;
    if (thread.status !== "exited" && thread.status !== "failed") return false;
    if (thread.launch.launchKind === "coven-recovery") {
      setStatus(
        "Coven launch outcome is unknown; inspect Coven sessions before retrying",
        "warn"
      );
      return false;
    }
    var finishRetry;
    var retryInFlight = new Promise(function (resolve) {
      finishRetry = resolve;
    });
    thread.retryInFlight = retryInFlight;
    try {
      if (thread.launch.launchKind === "coven-attach") {
        await refreshCovenSessions();
        if (!isLiveThread(thread) || thread.closeStarted) return false;
        var project = findProject(thread.projectId);
        var stillExists = project
          && !project.closing
          && covenDiscovery.phase === "ready"
          && covenSessionsForProject(project).some(function (session) {
            return session.id === thread.launch.covenSessionId;
          });
        if (!stillExists) {
          setStatus("Coven session is no longer available; refresh the rail before retrying", "warn");
          return false;
        }
      }
      if (typeof noteStatusActivity === "function") noteStatusActivity();
      if (!isPersistentThread(thread)) return await spawnPty(thread);
      if (thread.persistentLive) return await attachThreadClientAndResolveRecovery(thread);
      try {
        await createNativeSessionForThread(thread);
      } catch (error) {
        setStatus(thread.name + " failed to restart: " + String(error), "error");
        return false;
      }
      if (!isLiveThread(thread) || thread.closeStarted) {
        try {
          await invoke("native_session_stop", { id: id });
        } catch (cleanupError) {
          setStatus(
            thread.name + " restarted after local removal and cleanup failed: " +
              String(cleanupError),
            "error"
          );
        }
        return false;
      }
      return await attachThreadClientAndResolveRecovery(thread);
    } finally {
      if (thread.retryInFlight === retryInFlight) thread.retryInFlight = null;
      finishRetry();
    }
  }

  var TERMINAL_URL_RE = /\b((?:https?:\/\/|localhost(?::\d+)?|(?:127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,})(?:[^\s<>"'`]*)?)/ig;

  function terminalLineText(term, y) {
    var buffer = term.buffer && term.buffer.active;
    if (!buffer || typeof buffer.getLine !== "function") return "";
    var line = buffer.getLine(y - 1);
    if (!line || typeof line.translateToString !== "function") return "";
    return line.translateToString(true);
  }

  function terminalViewportY(term) {
    var buffer = term.buffer && term.buffer.active;
    return buffer && typeof buffer.viewportY === "number" ? buffer.viewportY : 0;
  }

  function trimTerminalUrl(raw) {
    var value = String(raw || "");
    while (/[.,;:!?]$/.test(value)) value = value.slice(0, -1);
    while (/[)\]}]$/.test(value)) {
      var last = value[value.length - 1];
      var open = last === ")" ? "(" : last === "]" ? "[" : "{";
      if (countChars(value, open) >= countChars(value, last)) break;
      value = value.slice(0, -1);
    }
    return value;
  }

  function countChars(value, needle) {
    var count = 0;
    for (var i = 0; i < value.length; i++) {
      if (value[i] === needle) count += 1;
    }
    return count;
  }

  function boundedBrowserError(error) {
    var value;
    try {
      value = error && typeof error.message === "string"
        ? error.message
        : String(error);
    } catch (_) {
      value = "unknown error";
    }
    value = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
    if (!value) value = "unknown error";
    return value.length > 240 ? value.slice(0, 237) + "..." : value;
  }

  function terminalLinksForLine(thread, text, y) {
    var links = [];
    var match;
    TERMINAL_URL_RE.lastIndex = 0;
    while ((match = TERMINAL_URL_RE.exec(text)) !== null) {
      var raw = match[0];
      var url = trimTerminalUrl(raw);
      if (!normaliseUrl(url)) continue;
      links.push(createTerminalLink(thread, url, match.index + 1, y));
    }
    return links;
  }

  function createTerminalLink(thread, url, x, y) {
    return {
      text: url,
      range: {
        start: { x: x, y: y },
        end: { x: x + url.length - 1, y: y },
      },
      activate: function (event) {
        openTerminalLink(thread, url, event).catch(function (error) {
          setStatus("link open failed: " + boundedBrowserError(error), "error");
        });
      },
    };
  }

  async function navigateProjectBrowserLink(thread, rawUrl) {
    var normalised = normaliseUrl(rawUrl);
    if (!normalised) return false;
    if (!thread) return false;
    var threadId = thread.id;
    var projectId = thread.projectId;
    var worktreePath = thread.worktreePath;
    if (!threadId || !projectId || !worktreePath || findThread(threadId) !== thread) return false;
    var project = findProject(projectId);
    if (!project) return false;
    if (!(await focusThread(threadId, { focusTerminal: false }))) return false;
    if (findThread(threadId) !== thread ||
        thread.id !== threadId ||
        thread.projectId !== projectId ||
        thread.worktreePath !== worktreePath ||
        findProject(projectId) !== project ||
        activeProject() !== project ||
        activeWorkspaceRoot(project) !== worktreePath) return false;
    return navigateBrowserForContext(normalised, {
      project: project,
      projectId: projectId,
      worktreePath: worktreePath,
      sourceThread: thread,
    });
  }

  async function openTerminalLink(thread, url, event) {
    var normalised = normaliseUrl(url);
    if (!normalised) return false;
    var external = event && (event.button === 2 || event.type === "contextmenu");
    if (external) {
      if (!openUrl) return false;
      await openUrl(normalised);
      return true;
    }
    return navigateProjectBrowserLink(thread, normalised);
  }

  function terminalUrlAtEvent(thread, term, event) {
    var screen = term.element && term.element.querySelector(".xterm-screen");
    var dimensions = term._core && term._core._renderService && term._core._renderService.dimensions;
    var cell = dimensions && dimensions.css && dimensions.css.cell;
    if (!screen || !cell || !cell.width || !cell.height) return "";
    var rect = screen.getBoundingClientRect();
    var x = Math.floor((event.clientX - rect.left) / cell.width) + 1;
    var screenY = Math.floor((event.clientY - rect.top) / cell.height) + 1;
    if (x < 1 || screenY < 1 || x > term.cols || screenY > term.rows) return "";
    var y = terminalViewportY(term) + screenY;
    var links = terminalLinksForLine(thread, terminalLineText(term, y), y);
    for (var i = 0; i < links.length; i++) {
      if (links[i].range.start.x <= x && links[i].range.end.x >= x) return links[i].text;
    }
    return "";
  }

  function registerTerminalLinkHandling(thread, term, container) {
    var linkRegistration = null;
    if (typeof term.registerLinkProvider === "function") {
      linkRegistration = term.registerLinkProvider({
        provideLinks: function (y, callback) {
          callback(terminalLinksForLine(thread, terminalLineText(term, y), y));
        },
      });
    }
    function handleContextMenu(event) {
      var url = terminalUrlAtEvent(thread, term, event);
      if (!url) return;
      event.preventDefault();
      event.stopPropagation();
      openTerminalLink(thread, url, event).catch(function (error) {
        setStatus("link open failed: " + boundedBrowserError(error), "error");
      });
    }
    container.addEventListener("contextmenu", handleContextMenu, true);
    return {
      dispose: function () {
        container.removeEventListener("contextmenu", handleContextMenu, true);
        if (linkRegistration && linkRegistration.dispose) linkRegistration.dispose();
      },
    };
  }

  function stageBrowserSurface() {
    if (browserSurfaceStaging && browserSurface &&
        browserSurface.parentElement !== browserSurfaceStaging) {
      browserSurfaceStaging.appendChild(browserSurface);
    }
  }

  // -------- Tools on the canvas --------
  // The Git surface has one neutral staging host and one pane owner at a time.

  var gitSurfaceEl = document.getElementById("git-surface");
  var gitSurfaceStagingEl = document.getElementById("git-surface-staging");
  var gitRefreshFlight = null;

  function stageGitSurface() {
    if (gitSurfaceEl && gitSurfaceStagingEl &&
        gitSurfaceEl.parentElement !== gitSurfaceStagingEl) {
      gitSurfaceStagingEl.appendChild(gitSurfaceEl);
    }
  }

  /** The thread holding the Git pane for one project and worktree. */
  function gitPaneThread(projectId, workspaceRoot) {
    for (var i = 0; i < state.threads.length; i++) {
      var thread = state.threads[i];
      if (thread.kind === "git" &&
          thread.projectId === projectId &&
          thread.worktreePath === workspaceRoot &&
          !thread.closing) return thread;
    }
    return null;
  }

  function gitPaneIsVisible(project) {
    project = project || activeProject();
    if (!project || project.id !== state.activeProjectId) return false;
    var workspaceRoot = activeWorkspaceRoot(project);
    var thread = gitPaneThread(project.id, workspaceRoot);
    return !!thread && !thread.hidden && !thread.closing &&
      canvasThreadIds().indexOf(thread.id) !== -1;
  }

  function renderGitSurface(options) {
    var project = activeProject();
    if (!gitPaneIsVisible(project)) {
      suspendGitRequests();
      return false;
    }
    var projectId = project.id;
    var workspaceRoot = activeWorkspaceRoot(project);
    var scopeKey = projectId + "\0" + workspaceRoot;
    if (gitRefreshFlight && gitRefreshFlight.scopeKey === scopeKey &&
        !(options && options.force)) {
      return gitRefreshFlight.promise;
    }

    var refreshGeneration = gitRefreshRequestGate.next();
    var gitGeneration = gitPanelRequestGate.next();
    var diffGeneration = diffPanelRequestGate.next();
    diffRequestGate.next();
    prepareGitSurfaceRefresh();
    setGitChangesCount(0);

    var flight = { scopeKey: scopeKey, promise: null };
    var statusRequest;
    try {
      statusRequest = invoke("git_status", { root: workspaceRoot });
    } catch (err) {
      statusRequest = Promise.reject(err);
    }
    flight.promise = Promise.resolve(statusRequest).then(function (status) {
      if (!gitSurfaceRequestMatches(projectId, workspaceRoot, refreshGeneration)) return;
      setGitChangesCount(status && status.is_repo ? (status.files || []).length : 0);
      renderDiffsPanel(project, workspaceRoot, status, diffGeneration, refreshGeneration);
      return renderGitPanel(project, workspaceRoot, status, gitGeneration, refreshGeneration);
    }).catch(function (err) {
      if (!gitSurfaceRequestMatches(projectId, workspaceRoot, refreshGeneration)) return;
      setGitChangesCount(0);
      renderGitSurfaceError(err);
    }).finally(function () {
      if (gitRefreshFlight === flight) gitRefreshFlight = null;
    });
    gitRefreshFlight = flight;
    return flight.promise;
  }

  function createPaneHideButton(surface) {
    var hide = document.createElement("button");
    hide.type = "button";
    hide.className = "terminal-pane-hide";
    hide.title = "Hide pane";
    hide.setAttribute("aria-label", "Hide pane");
    hide.textContent = "−";
    hide.addEventListener("click", function (event) {
      event.stopPropagation();
      hideCanvasSurface(surface);
    });
    return hide;
  }

  function mountToolPane(thread) {
    var pane = document.createElement("section");
    pane.className = "terminal-pane is-tool";
    pane.dataset.threadId = thread.id;
    var header = document.createElement("header");
    header.className = "terminal-pane-header";
    var glyph = document.createElement("span");
    glyph.className = "terminal-pane-glyph is-tool";
    glyph.textContent = "\u2387";
    glyph.setAttribute("aria-hidden", "true");
    var label = document.createElement("span");
    label.className = "terminal-pane-label";
    var title = document.createElement("span");
    title.className = "terminal-pane-title";
    title.id = "terminal-pane-title-" + thread.id;
    title.textContent = thread.name;
    var meta = document.createElement("span");
    meta.className = "terminal-pane-meta";
    label.appendChild(title);
    label.appendChild(meta);
    var hide = createPaneHideButton(thread);
    var maximize = document.createElement("button");
    maximize.type = "button";
    maximize.className = "terminal-pane-max";
    maximize.addEventListener("click", function (event) {
      event.stopPropagation();
      togglePaneMaximize(thread);
    });
    var close = document.createElement("button");
    close.type = "button";
    close.className = "terminal-pane-close";
    close.title = "Close Git pane";
    close.setAttribute("aria-label", "Close Git pane");
    close.textContent = "\u00d7";
    close.addEventListener("click", function (event) {
      event.stopPropagation();
      closeToolPane(thread);
    });
    header.addEventListener("pointerdown", function (event) {
      if (event.target && event.target.closest && event.target.closest("button")) return;
      startPaneReposition(thread, event);
    });
    header.addEventListener("dblclick", function (event) {
      if (event.target && event.target.closest && event.target.closest("button")) return;
      event.preventDefault();
      togglePaneMaximize(thread);
    });
    header.appendChild(glyph);
    header.appendChild(label);
    header.appendChild(hide);
    header.appendChild(maximize);
    header.appendChild(close);
    var body = document.createElement("div");
    body.className = "terminal-pane-body tool-pane-body";
    body.addEventListener("pointerdown", function () {
      if (state.activeThreadId !== thread.id) focusThread(thread.id);
    }, true);
    pane.appendChild(header);
    pane.appendChild(body);
    thread.pane = pane;
    pane.appendChild(createPaneFooter(thread));
    thread.host = body;
    thread.toolBody = body;
    thread.paneTitle = title;
    thread.paneMeta = meta;
    thread.paneHide = hide;
    thread.paneMax = maximize;
    thread.paneClose = close;
    syncThreadPaneMetadata(thread);
    renderPaneWorkspace({ preserveTerminalFocus: false });
  }

  function mountFilesPane(filesPane) {
    var pane = document.createElement("section");
    pane.className = "terminal-pane is-files";
    pane.id = "canvas-surface-" + filesPane.id;
    pane.dataset.surfaceId = filesPane.id;
    pane.setAttribute("aria-label", "Files pane");
    pane.setAttribute("aria-current", "false");

    var header = document.createElement("header");
    header.className = "terminal-pane-header";
    var glyph = document.createElement("span");
    glyph.className = "terminal-pane-glyph is-files";
    glyph.textContent = "F";
    glyph.setAttribute("aria-hidden", "true");
    var label = document.createElement("span");
    label.className = "terminal-pane-label";
    var title = document.createElement("span");
    title.className = "terminal-pane-title";
    title.id = "terminal-pane-title-" + filesPane.id;
    title.textContent = "Files";
    var meta = document.createElement("span");
    meta.className = "terminal-pane-meta";
    meta.textContent = filesPane.workspaceRoot || "";
    label.appendChild(title);
    label.appendChild(meta);

    var hide = createPaneHideButton(filesPane);
    var maximize = document.createElement("button");
    maximize.type = "button";
    maximize.className = "terminal-pane-max";
    maximize.addEventListener("click", function (event) {
      event.stopPropagation();
      togglePaneMaximize(filesPane);
    });
    var close = document.createElement("button");
    close.type = "button";
    close.className = "terminal-pane-close";
    close.title = "Close Files pane";
    close.setAttribute("aria-label", "Close Files pane");
    close.textContent = "\u00d7";
    close.addEventListener("click", function (event) {
      event.stopPropagation();
      closeFilesPane(filesPane);
    });

    header.addEventListener("pointerdown", function (event) {
      if (event.target && event.target.closest && event.target.closest("button")) return;
      startPaneReposition(filesPane, event);
    });
    header.addEventListener("dblclick", function (event) {
      if (event.target && event.target.closest && event.target.closest("button")) return;
      event.preventDefault();
      togglePaneMaximize(filesPane);
    });
    header.appendChild(glyph);
    header.appendChild(label);
    header.appendChild(hide);
    header.appendChild(maximize);
    header.appendChild(close);
    var body = document.createElement("div");
    body.className = "terminal-pane-body files-pane-body";
    body.appendChild(fileViewEl);
    pane.appendChild(header);
    pane.appendChild(body);
    pane.addEventListener("pointerdown", function (event) {
      if (event.target && event.target.closest && event.target.closest("button")) return;
      if (!filesPaneHasCanvasFocus(filesPane)) focusCanvasSurface(filesPane);
    }, true);
    pane.addEventListener("focusin", function (event) {
      if (event.target && event.target.closest && event.target.closest("button")) return;
      if (!filesPaneHasCanvasFocus(filesPane)) focusCanvasSurface(filesPane);
    });

    filesPane.pane = pane;
    filesPane.host = body;
    filesPane.paneTitle = title;
    filesPane.paneMeta = meta;
    filesPane.paneHide = hide;
    filesPane.paneMax = maximize;
    filesPane.paneClose = close;
    return pane;
  }

  /**
   * Open Git as a pane, or focus the existing pane for this scope.
   */
  async function openOrFocusGitPane() {
    var project = activeProject();
    if (!project) { setStatus("No project open", "warn"); return null; }
    if (!(await showTerminalView())) return null;
    // The file guard can await user input, so project/worktree selection may
    // have changed while it was open. Resolve and dedupe only after it passes.
    project = activeProject();
    if (!project) { setStatus("No project open", "warn"); return null; }
    var workspaceRoot = activeWorkspaceRoot(project);
    var existing = gitPaneThread(project.id, workspaceRoot);
    if (existing) {
      var reopened = existing.hidden;
      if (reopened && !reopenThread(existing.id)) {
        showPanePlacementWarning("Not enough space for another pane");
        return null;
      }
      revealGitPane(existing);
      await focusThread(existing.id);
      if (!reopened) renderGitSurface();
      return existing;
    }
    var id = makeThreadId();
    var placement = preparePanePlacement(id, project.id, workspaceRoot);
    if (!placement) {
      showPanePlacementWarning("Not enough space for another pane");
      return null;
    }
    var thread = {
      id: id,
      projectId: project.id,
      worktreePath: workspaceRoot,
      name: "Git",
      kind: "git",
      status: "",
      spawning: false,
      term: null,
      fit: null,
      host: null,
      pane: null,
      closing: false,
      closeStarted: false,
      startInFlight: false,
      stopRequested: false,
      ptyStarted: false,
    };
    commitPanePlacement(placement);
    revealGitPane(thread);
    state.threads.push(thread);
    if (typeof noteStatusActivity === "function") noteStatusActivity();
    mountToolPane(thread);
    await focusThread(id);
    renderGitSurface();
    refreshSidebar();
    saveWorkspaceSoon();
    return thread;
  }

  /** Close the pane after returning its shared surface to neutral staging. */
  function closeToolPane(thread) {
    return thread ? closeThread(thread.id) : false;
  }

  function mountBrowserPane(thread) {
    var pane = document.createElement("section");
    pane.className = "terminal-pane is-web";
    pane.dataset.threadId = thread.id;
    var header = document.createElement("header");
    header.className = "terminal-pane-header";
    var glyph = document.createElement("span");
    glyph.className = "terminal-pane-glyph is-web";
    glyph.textContent = paneGlyphFor("web");
    glyph.setAttribute("aria-hidden", "true");
    var label = document.createElement("span");
    label.className = "terminal-pane-label";
    var title = document.createElement("span");
    title.className = "terminal-pane-title";
    title.id = "terminal-pane-title-" + thread.id;
    title.textContent = thread.name;
    var meta = document.createElement("span");
    meta.className = "terminal-pane-meta";
    label.appendChild(title);
    label.appendChild(meta);
    var hide = createPaneHideButton(thread);
    var maximize = document.createElement("button");
    maximize.type = "button";
    maximize.className = "terminal-pane-max";
    maximize.addEventListener("click", function (event) {
      event.stopPropagation();
      togglePaneMaximize(thread);
    });
    var close = document.createElement("button");
    close.type = "button";
    close.className = "terminal-pane-close";
    close.title = "Close Web pane";
    close.setAttribute("aria-label", "Close Web pane");
    close.textContent = "×";
    close.addEventListener("click", function (event) {
      event.stopPropagation();
      closeBrowserPane(thread);
    });
    header.addEventListener("pointerdown", function (event) {
      if (event.target && event.target.closest && event.target.closest("button")) return;
      startPaneReposition(thread, event);
    });
    header.addEventListener("dblclick", function (event) {
      if (event.target && event.target.closest && event.target.closest("button")) return;
      event.preventDefault();
      togglePaneMaximize(thread);
    });
    header.addEventListener("contextmenu", function (event) {
      event.preventDefault();
      event.stopPropagation();
      openSessionContextMenu(event, [
        { label: "Hide", run: function () { hideThread(thread.id); } },
        { label: "Close", danger: true, run: function () { closeBrowserPane(thread); } },
      ]);
    });
    header.appendChild(glyph);
    header.appendChild(label);
    header.appendChild(hide);
    header.appendChild(maximize);
    header.appendChild(close);
    var body = document.createElement("div");
    body.className = "terminal-pane-body browser-pane-body";
    body.addEventListener("pointerdown", function () {
      if (state.activeThreadId !== thread.id) focusThread(thread.id);
    }, true);
    pane.appendChild(header);
    pane.appendChild(body);
    thread.pane = pane;
    pane.appendChild(createPaneFooter(thread));
    pane.addEventListener("pointerdown", function (event) {
      handlePanePointerDown(thread, body, close, event);
    });
    thread.host = body;
    thread.browserBody = body;
    thread.paneTitle = title;
    thread.paneMeta = meta;
    thread.paneHide = hide;
    thread.paneMax = maximize;
    thread.paneClose = close;
    syncThreadPaneMetadata(thread);
    renderPaneWorkspace({ preserveTerminalFocus: false });
  }

  function isTerminalFocusReport(data) {
    return data === "\x1b[I" || data === "\x1b[O";
  }

  function beginTerminalFocusReportToken(thread, report, policy) {
    if (
      !thread ||
      !isTerminalFocusReport(report) ||
      (policy !== "suppress" && policy !== "allow")
    ) {
      return null;
    }
    var token = { report: report, policy: policy };
    if (!thread.internalFocusReportTokens) {
      thread.internalFocusReportTokens = [];
    }
    thread.internalFocusReportTokens.push(token);
    return token;
  }

  function clearTerminalFocusReportToken(thread, token) {
    var tokens = thread && thread.internalFocusReportTokens;
    if (!tokens || !token) return;
    var index = tokens.indexOf(token);
    if (index !== -1) tokens.splice(index, 1);
    if (tokens.length === 0) {
      delete thread.internalFocusReportTokens;
    }
  }

  function consumeTerminalFocusReportToken(thread, report) {
    var tokens = thread && thread.internalFocusReportTokens;
    if (!tokens) return null;
    for (var i = tokens.length - 1; i >= 0; i--) {
      if (tokens[i].report !== report) continue;
      var token = tokens[i];
      clearTerminalFocusReportToken(thread, token);
      return token;
    }
    return null;
  }

  function withTerminalFocusReportToken(thread, report, policy, action) {
    var token = beginTerminalFocusReportToken(thread, report, policy);
    try {
      return action();
    } finally {
      clearTerminalFocusReportToken(thread, token);
    }
  }

  function consumeTerminalDataSuppression(thread, data) {
    if (!thread || !isTerminalFocusReport(data)) return false;
    var token = consumeTerminalFocusReportToken(thread, data);
    return !!token && token.policy === "suppress";
  }

  function routeTerminalData(thread, data) {
    if (consumeTerminalDataSuppression(thread, data)) return false;
    sendToThread(thread, data);
    return true;
  }

  function mountTerminal(thread) {
    var pane = document.createElement("section");
    pane.className = "terminal-pane";
    pane.dataset.threadId = thread.id;
    var header = document.createElement("header");
    header.className = "terminal-pane-header";
    // Kind glyph + worktree meta, so a wall of panes stays legible at a glance.
    var glyph = document.createElement("span");
    glyph.className = "terminal-pane-glyph " +
      ((thread.kind || "shell") === "shell" ? "is-term" : "is-agent");
    glyph.textContent = paneGlyphFor(thread.kind);
    glyph.setAttribute("aria-hidden", "true");
    // Title and meta share one grid track so they ellipsize against each other
    // instead of against the buttons.
    var label = document.createElement("span");
    label.className = "terminal-pane-label";
    var title = document.createElement("span");
    title.className = "terminal-pane-title";
    title.id = "terminal-pane-title-" + thread.id;
    title.textContent = thread.name;
    var meta = document.createElement("span");
    meta.className = "terminal-pane-meta";
    label.appendChild(title);
    label.appendChild(meta);
    var hide = createPaneHideButton(thread);
    var maximize = document.createElement("button");
    maximize.type = "button";
    maximize.className = "terminal-pane-max";
    maximize.addEventListener("click", function (event) {
      event.stopPropagation();
      togglePaneMaximize(thread);
    });
    var close = document.createElement("button");
    close.type = "button";
    close.className = "terminal-pane-close";
    close.title = "Stop and close terminal";
    close.setAttribute("aria-label", "Stop and close " + thread.name);
    close.textContent = "×";
    close.addEventListener("click", function (event) {
      event.stopPropagation();
      closeThread(thread.id);
    });
    // Worded, not a bare dot, and ahead of the status chip: a pane waiting on
    // the user outranks "running" as the thing its header should be saying.
    var attention = document.createElement("span");
    attention.className = "terminal-pane-attention";
    attention.hidden = true;
    thread.paneAttention = attention;
    // The header doubles as the pane's drag handle. Buttons inside it keep
    // their own click behaviour; the gesture only starts once the pointer has
    // travelled far enough to not be a click.
    header.addEventListener("pointerdown", function (event) {
      if (event.target && event.target.closest && event.target.closest("button")) return;
      startPaneReposition(thread, event);
    });
    header.appendChild(glyph);
    header.appendChild(label);
    header.appendChild(attention);
    header.appendChild(hide);
    header.appendChild(maximize);
    header.appendChild(close);
    // Double-clicking the header is the mouse route into focus mode, mirroring
    // the maximise button so the gesture and the control agree.
    header.addEventListener("dblclick", function (event) {
      if (event.target && event.target.closest && event.target.closest("button")) return;
      event.preventDefault();
      togglePaneMaximize(thread);
    });
    // Retry lost its header button, so the pane's own context menu carries it.
    // The sidebar row cannot: PR #54 hides exited rows, and exited is exactly
    // the state you retry from.
    header.addEventListener("contextmenu", function (event) {
      event.preventDefault();
      event.stopPropagation();
      openSessionContextMenu(event, [
        thread.status === "exited" || thread.status === "failed"
          ? { label: "Retry", run: function () { retryThread(thread.id); } }
          : null,
        thread.status !== "exited"
          ? { label: "Interrupt", run: function () { sendToThread(thread, "\x03"); } }
          : null,
        { label: "Hide", run: function () { hideThread(thread.id); } },
        { label: "Stop and close", danger: true, run: function () { closeThread(thread.id); } },
      ]);
    });
    var body = document.createElement("div");
    body.className = "terminal-pane-body";
    var container = document.createElement("div");
    container.className = "term-instance";
    container.dataset.threadId = thread.id;
    body.appendChild(container);
    pane.appendChild(header);
    pane.appendChild(body);
    thread.pane = pane;
    pane.appendChild(createPaneFooter(thread));
    pane.addEventListener("pointerdown", function (event) {
      handlePanePointerDown(thread, body, close, event);
    });
    thread.host = container;
    thread.paneTitle = title;
    thread.paneMeta = meta;
    thread.paneHide = hide;
    thread.paneMax = maximize;
    thread.paneClose = close;
    syncThreadPaneMetadata(thread);
    renderPaneWorkspace({ preserveTerminalFocus: false });

    var controller = PsycheRuntime.createTerminalPaneController({
      paneId: thread.id,
      threadId: thread.id,
      container: container,
      frameScheduler: terminalFrameScheduler,
      invoke: invoke,
      initialVisibility: threadTerminalVisibility(thread),
      isSelected: function () { return state.activeThreadId === thread.id; },
      terminalOptions: {
        fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
        fontSize: 13,
        lineHeight: 1.18,
        // Fully transparent canvas: the terminal's tint comes from
        // .terminal-area's CSS background, which already tracks --bg-opacity.
        allowTransparency: true,
        theme: terminalTheme(),
        cursorBlink: true,
        convertEol: false,
        allowProposedApi: true,
      },
      registerLinks: function (term, container) {
        return registerTerminalLinkHandling(thread, term, container);
      },
      onData: function (data) {
        routeTerminalData(thread, data);
      },
      onBell: function () {
        if (!threadWantsAttentionTracking(thread)) return;
        applyThreadAttention(thread, attentionTracker.bell(thread.id));
      },
    });
    thread.terminalController = controller;
    // Temporary compatibility alias for legacy link/tail inspection callers.
    thread.term = controller.compatibilityTerminal();
    container.addEventListener("pointerdown", function () {
      if (state.activeThreadId !== thread.id) {
        focusThread(thread.id);
      } else {
        controller.focus();
      }
    });
    syncThreadPtyVisibility(thread);
  }

  function applyPaneStatus(pane, status) {
    if (!pane) return "";
    var label = status || "";
    var supported = label === "running" || label === "starting" ||
      label === "failed" || label === "exited";
    if (!supported) {
      if (pane.dataset) delete pane.dataset.status;
      pane.removeAttribute("aria-description");
      return "";
    }
    pane.dataset.status = label;
    pane.setAttribute("aria-description", "Status: " + label);
    return label;
  }

  function syncPaneBranchStatusChrome(branch) {
    if (!branch || !branch.classList ||
        !branch.classList.contains("terminal-pane-branch")) return;
    var pane = branch.firstElementChild;
    var status = pane && pane.classList &&
      pane.classList.contains("terminal-pane") && pane.dataset
      ? pane.dataset.status || ""
      : "";
    var glows = status === "starting" || status === "failed" || status === "exited";
    var needsAttention = pane && pane.classList &&
      pane.classList.contains("needs-attention");
    if (glows && !needsAttention) {
      branch.dataset.status = status;
    } else if (branch.dataset) {
      delete branch.dataset.status;
    }
  }

  function handlePanePointerDown(thread, body, close, event) {
    var target = event.target;
    if ((body && body.contains(target)) || (close && close.contains(target))) return;
    // Every header button re-renders the canvas, and renderPaneWorkspace
    // detaches and re-appends the panes — a target that leaves the document
    // between pointerdown and pointerup never gets its click. Focusing here
    // would therefore swallow the first press of span, maximise and close.
    if (target && target.closest && target.closest("button")) return;
    if (state.activeThreadId !== thread.id) focusThread(thread.id);
  }

  // -------- Drag a pane onto another pane's edge to re-tile it --------
  // Pointer events rather than HTML5 drag-and-drop: the panes host xterm
  // canvases, and a native drag image over a live terminal reads as a glitch.
  // Owning the gesture also lets the drop target be a region of a pane rather
  // than the whole element.

  var PANE_DRAG_THRESHOLD = 5;

  function paneRepositionSurfaceIds() {
    var layout = activePaneLayout();
    var root = effectivePaneRoot(layout);
    if (!root) return [];
    return PsychePanes.leafIds(root).map(function (leafId) {
      var leaf = PsychePanes.findLeafById(root, leafId);
      var surface = leaf && (typeof canvasSurfaceById === "function"
        ? canvasSurfaceById(leaf.threadId)
        : findThread(leaf.threadId));
      return surface ? surface.id : null;
    }).filter(Boolean);
  }

  function paneElementAt(clientX, clientY) {
    var ids = paneRepositionSurfaceIds();
    for (var i = 0; i < ids.length; i++) {
      var thread = typeof canvasSurfaceById === "function"
        ? canvasSurfaceById(ids[i])
        : findThread(ids[i]);
      var pane = thread && thread.pane;
      if (!pane) continue;
      var rect = pane.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right &&
          clientY >= rect.top && clientY <= rect.bottom) {
        return { thread: thread, rect: rect };
      }
    }
    return null;
  }

  // Nearest edge wins, so the pane splits along whichever side the pointer is
  // closest to. Four triangular zones meeting at the centre — predictable
  // enough that the drop lands where the highlight promised.
  function paneDropZone(rect, clientX, clientY) {
    var relX = rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
    var relY = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
    var edges = [
      { position: "left", distance: relX },
      { position: "right", distance: 1 - relX },
      { position: "above", distance: relY },
      { position: "below", distance: 1 - relY },
    ];
    edges.sort(function (a, b) { return a.distance - b.distance; });
    return edges[0].position;
  }

  function movePaneTo(sourceThreadId, targetThreadId, position) {
    var layout = activePaneLayout();
    if (!layout || !layout.root) return false;
    var source = PsychePanes.findLeafByThreadId(layout.root, sourceThreadId);
    var target = PsychePanes.findLeafByThreadId(layout.root, targetThreadId);
    if (!source || !target) return false;
    var nextRoot = PsychePanes.moveLeaf(
      layout.root, source.id, target.id, position, nextPaneId("split")
    );
    if (nextRoot === layout.root) return false;
    layout.root = nextRoot;
    layout.focusedLeafId = source.id;
    renderPaneWorkspace();
    scheduleTerminalPaneFits();
    saveWorkspaceSoon();
    return true;
  }

  // The drop highlight is shared by both drags -- repositioning a pane and
  // repositioning any canvas pane uses this one shared affordance.
  // Fixed positioning takes the client rects as-is, so it needs no positioned
  // ancestor and cannot be clipped by a pane's own overflow.
  var paneDropIndicator = null;

  function showPaneDropIndicator(rect, position) {
    if (!paneDropIndicator) {
      paneDropIndicator = document.createElement("div");
      paneDropIndicator.className = "pane-drop-indicator";
      paneDropIndicator.setAttribute("aria-hidden", "true");
      document.body.appendChild(paneDropIndicator);
    }
    var left = rect.left;
    var top = rect.top;
    var width = rect.width;
    var height = rect.height;
    if (position === "left" || position === "right") {
      width = rect.width / 2;
      if (position === "right") left = rect.left + width;
    } else {
      height = rect.height / 2;
      if (position === "below") top = rect.top + height;
    }
    paneDropIndicator.style.left = left + "px";
    paneDropIndicator.style.top = top + "px";
    paneDropIndicator.style.width = width + "px";
    paneDropIndicator.style.height = height + "px";
    paneDropIndicator.hidden = false;
  }

  function clearPaneDropIndicator() {
    if (!paneDropIndicator) return;
    paneDropIndicator.remove();
    paneDropIndicator = null;
  }

  function startPaneReposition(thread, event) {
    if (!terminalHost || event.button !== 0 || !thread || !thread.pane) return;
    // A lone pane has nothing to be repositioned against.
    if (paneRepositionSurfaceIds().length < 2) return;

    var pointerId = event.pointerId;
    var startX = event.clientX;
    var startY = event.clientY;
    var dragging = false;
    var drop = null;

    function beginDrag() {
      dragging = true;
      document.body.classList.add("is-pane-dragging");
      thread.pane.classList.add("is-dragging");
    }

    var showIndicator = showPaneDropIndicator;

    function onPointerMove(moveEvent) {
      if (moveEvent.pointerId !== pointerId) return;
      if (!dragging) {
        if (Math.abs(moveEvent.clientX - startX) < PANE_DRAG_THRESHOLD &&
            Math.abs(moveEvent.clientY - startY) < PANE_DRAG_THRESHOLD) {
          return;
        }
        beginDrag();
      }
      var hit = paneElementAt(moveEvent.clientX, moveEvent.clientY);
      if (!hit || hit.thread.id === thread.id) {
        drop = null;
        clearPaneDropIndicator();
        return;
      }
      var position = paneDropZone(hit.rect, moveEvent.clientX, moveEvent.clientY);
      drop = { threadId: hit.thread.id, position: position };
      showIndicator(hit.rect, position);
    }

    function onKeyDown(keyEvent) {
      if (keyEvent.key !== "Escape") return;
      keyEvent.preventDefault();
      drop = null;
      finish();
    }

    function finish(endEvent) {
      if (endEvent && endEvent.pointerId !== undefined && endEvent.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", onKeyDown, true);
      if (!dragging) return;
      document.body.classList.remove("is-pane-dragging");
      thread.pane.classList.remove("is-dragging");
      clearPaneDropIndicator();
      dragging = false;
      if (drop) movePaneTo(thread.id, drop.threadId, drop.position);
    }

    function cancel(cancelEvent) {
      drop = null;
      finish(cancelEvent);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", onKeyDown, true);
  }

  function createPaneDivider(node, ratio) {
    // A column split stacks panes, so its separator runs left-to-right and is
    // dragged vertically; a row split is the mirror image. ARIA names the
    // separator's own orientation, which is the opposite of the drag axis.
    var isRow = node.orientation === "row";
    var divider = document.createElement("div");
    divider.className = "terminal-pane-divider" + (isRow ? " is-row" : "");
    divider.dataset.splitId = node.id;
    divider.setAttribute("role", "separator");
    divider.setAttribute("aria-orientation", isRow ? "vertical" : "horizontal");
    divider.setAttribute("aria-valuemin", "0");
    divider.setAttribute("aria-valuemax", "100");
    divider.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    divider.tabIndex = 0;
    function latestSplitRatio(layout) {
      if (!layout || !layout.root) return NaN;
      var spanning = Boolean(layout.spanMode) && Boolean(layout.spanRoot) &&
        !layout.maximizedLeafId && layout.spanRoot !== layout.root;
      var root = spanning ? layout.spanRoot : layout.root;
      function findRatio(candidate) {
        if (!candidate || candidate.type === "leaf") return NaN;
        if (candidate.id === node.id) return candidate.ratio;
        var firstRatio = findRatio(candidate.first);
        return Number.isFinite(firstRatio) ? firstRatio : findRatio(candidate.second);
      }
      return findRatio(root);
    }
    divider.addEventListener("pointerdown", function (event) {
      event.preventDefault();
      var dragLayout = activePaneLayout();
      var parent = divider.parentElement;
      var rect = parent && parent.getBoundingClientRect();
      var origin = rect && (isRow ? rect.left : rect.top);
      var extent = rect && (isRow ? rect.width : rect.height);
      if (!dragLayout || !rect || !Number.isFinite(origin) || !Number.isFinite(extent) || extent <= 0) {
        return;
      }
      var pointerId = event.pointerId;
      var moved = false;
      // The divider survives the whole gesture now that the drag no longer
      // rebuilds the tree, so it can own the pointer instead of relying on the
      // window listeners to outlive its own element.
      if (typeof divider.setPointerCapture === "function") {
        try { divider.setPointerCapture(pointerId); } catch (error) { void error; }
      }
      function releasePointer() {
        if (typeof divider.releasePointerCapture !== "function") return;
        try { divider.releasePointerCapture(pointerId); } catch (error) { void error; }
      }
      function onPointerMove(moveEvent) {
        if (moveEvent.pointerId !== pointerId) return;
        if (activePaneLayout() !== dragLayout) {
          stopPointerResize();
          return;
        }
        var position = isRow ? moveEvent.clientX : moveEvent.clientY;
        if (!Number.isFinite(position)) return;
        var nextRatio = (position - origin) / extent;
        if (!Number.isFinite(nextRatio)) return;
        // Live: reflow the existing branches in place. Rebuilding the tree here
        // would detach every terminal once per frame, which drops each pane to
        // the hidden PTY cadence for as long as the drag lasts.
        moved = updateActiveSplit(node.id, nextRatio, dragLayout, false, true) || moved;
      }
      function stopPointerResize(endEvent) {
        if (endEvent && endEvent.pointerId !== undefined && endEvent.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", stopPointerResize);
        window.removeEventListener("pointercancel", stopPointerResize);
        window.removeEventListener("blur", stopPointerResize);
        releasePointer();
        // One authoritative render closes the gesture: it rebuilds the tree the
        // live path only restyled, and persists the ratio nothing saved yet.
        if (moved) schedulePaneTreeLayout(null);
        moved = false;
      }
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", stopPointerResize);
      window.addEventListener("pointercancel", stopPointerResize);
      window.addEventListener("blur", stopPointerResize);
    });
    divider.addEventListener("keydown", function (event) {
      var shrinkKey = isRow ? "ArrowLeft" : "ArrowUp";
      var growKey = isRow ? "ArrowRight" : "ArrowDown";
      if (event.key !== shrinkKey && event.key !== growKey) return;
      event.preventDefault();
      var step = event.shiftKey ? 0.01 : 0.04;
      var keyLayout = activePaneLayout();
      var currentRatio = latestSplitRatio(keyLayout);
      if (!Number.isFinite(currentRatio)) currentRatio = ratio;
      updateActiveSplit(
        node.id,
        currentRatio + (event.key === shrinkKey ? -step : step),
        keyLayout,
        true
      );
    });
    return divider;
  }

  function focusPaneDivider(splitId) {
    if (!terminalHost) return false;
    var dividers = terminalHost.querySelectorAll(".terminal-pane-divider");
    for (var i = 0; i < dividers.length; i++) {
      if (dividers[i].dataset.splitId !== splitId) continue;
      dividers[i].focus();
      return true;
    }
    return false;
  }

  function updateActiveSplit(splitId, ratio, expectedLayout, restoreFocus, live) {
    if (!Number.isFinite(ratio)) return false;
    var layout = activePaneLayout();
    if (!layout || !layout.root || (expectedLayout && layout !== expectedLayout)) return false;
    // While spanning, the dividers on screen belong to the derived tree — the
    // drag has to land there or it would resize a split nobody can see.
    var spanning = Boolean(layout.spanMode) && Boolean(layout.spanRoot) &&
      !layout.maximizedLeafId && layout.spanRoot !== layout.root;
    var current = spanning ? layout.spanRoot : layout.root;
    var nextRoot = PsychePanes.resizeSplit(current, splitId, ratio);
    if (nextRoot === current) return false;
    if (spanning) layout.spanRoot = nextRoot;
    else layout.root = nextRoot;
    // A live update restyles the branches already on screen. It falls through to
    // a full render whenever the mounted tree no longer matches the model.
    if (live && applyProjectedSplitRatios(layout)) return true;
    schedulePaneTreeLayout(restoreFocus ? splitId : null);
    return true;
  }

  // The branch elements each mounted split flexes, keyed by split id. Held so a
  // divider drag can restyle the tree it already built instead of building a new
  // one — see applyProjectedSplitRatios.
  var mountedSplitBranches = new Map();

  /**
   * Push the projected (minimum-clamped) ratios of every mounted split onto the
   * elements renderPaneNode already created. Returns false when the mounted tree
   * has drifted from the model, which is the caller's cue to render properly.
   */
  function applyProjectedSplitRatios(layout) {
    if (!terminalHost || !mountedSplitBranches.size) return false;
    var root = effectivePaneRoot(layout);
    if (!root) return false;
    var projected = PsychePanes.layoutRects(root, measuredTerminalHost(), PANE_MINIMUMS);
    if (!projected.splits.length || projected.splits.length !== mountedSplitBranches.size) {
      return false;
    }
    for (var index = 0; index < projected.splits.length; index++) {
      if (!mountedSplitBranches.has(projected.splits[index].splitId)) return false;
    }
    projected.splits.forEach(function (split) {
      var branches = mountedSplitBranches.get(split.splitId);
      branches.first.style.flexGrow = String(split.ratio);
      branches.second.style.flexGrow = String(1 - split.ratio);
      branches.divider.setAttribute("aria-valuenow", String(Math.round(split.ratio * 100)));
    });
    // The containers changed size, so the terminals still have to re-measure —
    // but against a DOM that stayed mounted, so fit() sees a real box and the
    // pane keeps the visible PTY cadence throughout.
    scheduleTerminalPaneFits();
    scheduleBrowserBounds();
    return true;
  }

  // Span cycle: ▦ tiled → ▥ the pane takes a full column, the others stack to
  // its side → ▤ it takes a full row, the others line up below → tiled again.
  // The mode is named for what the spanned pane gets; the top-level split runs
  // along the other axis, which is what SPAN_ORIENTATION translates.
  var SPAN_ORIENTATION = { column: "row", row: "column" };

  function spanSignature(layout, base) {
    return layout.spanMode + "|" + layout.focusedLeafId + "|" +
      PsychePanes.leafIds(base).join(",");
  }

  /**
   * The tiled tree narrowed to the set scoping this canvas, or the tiled tree
   * itself. A set whose panes have all gone stops scoping rather than leaving
   * an empty canvas behind.
   */
  function scopedPaneRoot(layout) {
    if (!layout.activeSetId) return layout.root;
    var set = findFocusSet(layout.activeSetId);
    if (!set || !set.threadIds.length) {
      layout.activeSetId = null;
      return layout.root;
    }
    var scopedSessions = PsychePanes.retainThreads(layout.root, set.threadIds);
    if (!scopedSessions) {
      layout.activeSetId = null;
      return layout.root;
    }
    var projectedSurfaceIds = set.threadIds.slice();
    if (typeof canvasSurfaceById === "function") {
      PsychePanes.leafIds(layout.root).forEach(function (leafId) {
        var leaf = PsychePanes.findLeafById(layout.root, leafId);
        var surface = leaf && canvasSurfaceById(leaf.threadId);
        if (surface && surface.kind === "files" &&
            projectedSurfaceIds.indexOf(surface.id) === -1) {
          projectedSurfaceIds.push(surface.id);
        }
      });
    }
    var scoped = PsychePanes.retainThreads(layout.root, projectedSurfaceIds);
    return scoped;
  }

  function paneFocusEligible(layout, threadId) {
    if (!layout || !layout.root || !layout.activeSetId) return true;
    var root = scopedPaneRoot(layout);
    if (!layout.activeSetId) return true;
    return Boolean(root && PsychePanes.findLeafByThreadId(root, threadId));
  }

  function paneSurfaceFocusEligible(layout, surface) {
    if (!surface || surface.hidden || !paneFocusEligible(layout, surface.id)) return false;
    if (surface.kind === "files") return true;
    return surface.kind === "web"
      ? !browserPaneIsClosing(surface)
      : !surface.closing && !surface.closeStarted;
  }

  function resolvePaneFocusSuccessor(layout, preferredId, threadsOnly) {
    if (!layout || !layout.root) return null;
    var root = scopedPaneRoot(layout);
    if (!root) return null;
    var leafIds = PsychePanes.leafIds(root);
    var preferredLeaf = preferredId &&
      PsychePanes.findLeafByThreadId(root, preferredId);
    if (preferredLeaf) {
      leafIds = [preferredLeaf.id].concat(leafIds.filter(function (leafId) {
        return leafId !== preferredLeaf.id;
      }));
    }
    for (var i = 0; i < leafIds.length; i += 1) {
      var leaf = PsychePanes.findLeafById(root, leafIds[i]);
      var surface = leaf && (typeof canvasSurfaceById === "function"
        ? canvasSurfaceById(leaf.threadId)
        : typeof findThread === "function" ? findThread(leaf.threadId) : leaf);
      if (threadsOnly && surface && surface.kind === "files") continue;
      if (paneSurfaceFocusEligible(layout, surface)) return surface.id;
    }
    return null;
  }

  /**
   * The tree the canvas actually draws. Maximise and span are presentation
   * modes, so neither one edits the tiled tree — leaving them restores exactly
   * the layout you had, and a pane opened or closed mid-mode still lands in the
   * tiling underneath. The derived tree is cached against a signature so that
   * dragging its dividers keeps the ratios instead of rebuilding them away.
   */
  function effectivePaneRoot(layout) {
    if (!layout || !layout.root) return null;
    // Focus mode is one pane by definition, so it outranks both other modes.
    if (layout.maximizedLeafId) {
      var maximized = PsychePanes.findLeafById(layout.root, layout.maximizedLeafId);
      if (maximized) return maximized;
      layout.maximizedLeafId = null;
    }
    // Scope first, then span: spanning re-tiles whatever the canvas is showing,
    // which inside a set is the set.
    var base = scopedPaneRoot(layout);
    if (!layout.spanMode) return base;
    var signature = spanSignature(layout, base);
    if (!layout.spanRoot || layout.spanSignature !== signature) {
      layout.spanRoot = PsychePanes.spanLayout(
        base,
        layout.focusedLeafId,
        SPAN_ORIENTATION[layout.spanMode],
        "span"
      );
      layout.spanSignature = signature;
    }
    return layout.spanRoot;
  }

  function paneLayoutForThread(surface) {
    return surface ? paneLayoutFor(
      surface.projectId,
      surface.worktreePath || surface.workspaceRoot
    ) : null;
  }

  /** Make a Git leaf visible without discarding compatible presentation state. */
  function revealGitPane(thread) {
    var layout = paneLayoutForThread(thread);
    var leaf = layout && layout.root && PsychePanes.findLeafByThreadId(layout.root, thread.id);
    if (!layout || !leaf) return false;
    var changed = false;
    if (layout.activeSetId) {
      var set = findFocusSet(layout.activeSetId);
      if (!set || set.threadIds.indexOf(thread.id) === -1) {
        layout.activeSetId = null;
        layout.spanRoot = null;
        layout.spanSignature = null;
        changed = true;
      }
    }
    if (layout.maximizedLeafId && layout.maximizedLeafId !== leaf.id) {
      layout.maximizedLeafId = null;
      changed = true;
    }
    return changed;
  }

  // -------- Focus-set interactions --------

  /** Enter multi-select. The set is only created when the user confirms. */
  function beginSetPicking() {
    var key = activePaneLayoutKey();
    var layout = activePaneLayout();
    if (!key || !layout || !layout.root) {
      toast("Open some panes first — a focus set is a subset of them");
      return false;
    }
    setPicking = { key: key, picked: [] };
    refreshSidebar();
    return true;
  }

  function cancelSetPicking() {
    if (!setPicking) return false;
    setPicking = null;
    refreshSidebar();
    return true;
  }

  function isPicked(threadId) {
    return Boolean(setPicking) && setPicking.picked.indexOf(threadId) !== -1;
  }

  function toggleSetPick(threadId) {
    if (!setPicking) return;
    var at = setPicking.picked.indexOf(threadId);
    if (at === -1) setPicking.picked.push(threadId);
    else setPicking.picked.splice(at, 1);
    refreshSidebar();
  }

  function createFocusSet() {
    if (!setPicking || !setPicking.picked.length) return null;
    var key = setPicking.key;
    // Colours cycle through the four set swatches; a fifth set on one canvas
    // reuses the first colour rather than inventing an unnamed one.
    var index = (setsForKey(key).length % SET_COLOR_COUNT) + 1;
    var set = {
      id: nextPaneId("set"),
      index: index,
      name: "Set " + (setsForKey(key).length + 1),
      key: key,
      threadIds: setPicking.picked.slice(),
    };
    focusSets.push(set);
    setPicking = null;
    activateFocusSet(set.id);
    toast(set.name + " — " + set.threadIds.length + " panes");
    return set;
  }

  function activateFocusSet(setId) {
    var layout = activePaneLayout();
    if (!layout) return false;
    var set = findFocusSet(setId);
    if (!set || !set.threadIds.length) return false;
    layout.activeSetId = setId;
    // A set is a different canvas; the modes that framed the old one do not
    // carry over.
    layout.maximizedLeafId = null;
    layout.spanRoot = null;
    layout.spanSignature = null;
    refreshSidebar();
    return true;
  }

  function clearFocusSet() {
    var layout = activePaneLayout();
    if (!layout || !layout.activeSetId) return false;
    layout.activeSetId = null;
    layout.spanRoot = null;
    layout.spanSignature = null;
    refreshSidebar();
    return true;
  }

  /**
   * Board 8's rule: clicking a member scopes the canvas to its set, and
   * clicking anything that is not in a set returns to all panes. Selection
   * flows through the rows themselves rather than a standing chip bar.
   */
  function applySetScopeForThread(thread) {
    thread = thread && findThread(thread.id);
    if (!thread) return false;
    var sets = setsForThread(thread);
    if (!sets.length) return clearFocusSet();
    var layout = paneLayoutForThread(thread);
    if (layout && layout.activeSetId === sets[0].id) return false;
    return activateFocusSet(sets[0].id);
  }

  function snapshotSetScopePresentation(thread) {
    var layout = paneLayoutForThread(thread);
    if (!layout) return null;
    return {
      projectId: thread.projectId,
      worktreePath: thread.worktreePath,
      layout: layout,
      root: layout.root,
      activeSetId: layout.activeSetId,
      maximizedLeafId: layout.maximizedLeafId,
      spanRoot: layout.spanRoot,
      spanSignature: layout.spanSignature,
    };
  }

  function restoreSetScopePresentation(snapshot, applied) {
    if (!snapshot || !applied || snapshot.layout !== applied.layout) return false;
    var layout = paneLayoutFor(snapshot.projectId, snapshot.worktreePath);
    if (layout !== snapshot.layout ||
        layout.root !== applied.root ||
        layout.activeSetId !== applied.activeSetId ||
        layout.maximizedLeafId !== applied.maximizedLeafId ||
        layout.spanRoot !== applied.spanRoot ||
        layout.spanSignature !== applied.spanSignature) return false;
    layout.activeSetId = snapshot.activeSetId;
    layout.maximizedLeafId = snapshot.maximizedLeafId;
    layout.spanRoot = snapshot.spanRoot;
    layout.spanSignature = snapshot.spanSignature;
    renderPaneWorkspace();
    refreshSidebar();
    return true;
  }

  function removeFromFocusSet(setId, threadId) {
    var set = findFocusSet(setId);
    if (!set) return false;
    var at = set.threadIds.indexOf(threadId);
    if (at === -1) return false;
    set.threadIds.splice(at, 1);
    var layout = activePaneLayout();
    if (!set.threadIds.length && layout && layout.activeSetId === setId) {
      layout.activeSetId = null;
      toast(set.name + " is empty — showing all panes");
    }
    if (layout) { layout.spanRoot = null; layout.spanSignature = null; }
    refreshSidebar();
    return true;
  }

  /** Drop a closed pane out of every set, so no set points at a dead thread. */
  function forgetThreadInSets(threadId) {
    focusSets.forEach(function (set) {
      var at = set.threadIds.indexOf(threadId);
      if (at !== -1) set.threadIds.splice(at, 1);
    });
    focusSets = focusSets.filter(function (set) { return set.threadIds.length > 0; });
  }

  function cyclePaneSpan(surface) {
    surface = (surface && typeof canvasSurfaceById === "function"
      ? canvasSurfaceById(surface.id)
      : surface) || surface;
    var layout = paneLayoutForThread(surface);
    if (!layout || !layout.root) return;
    var leaf = PsychePanes.findLeafByThreadId(layout.root, surface.id);
    if (!leaf) return;
    // Spanning a different pane restarts the cycle rather than continuing the
    // previous pane's position in it.
    var continuing = layout.spanMode && layout.focusedLeafId === leaf.id;
    layout.spanMode = !continuing
      ? "column"
      : layout.spanMode === "column" ? "row" : null;
    layout.focusedLeafId = leaf.id;
    layout.maximizedLeafId = null;
    layout.spanRoot = null;
    layout.spanSignature = null;
    var thread = typeof findThread === "function" ? findThread(surface.id) : surface;
    if (surface.kind === "files") {
      focusCanvasSurface(surface);
    } else if (state.activeThreadId !== surface.id && thread) {
      focusThread(surface.id);
      return;
    }
    renderPaneWorkspace();
  }

  function togglePaneMaximize(surface) {
    surface = (surface && typeof canvasSurfaceById === "function"
      ? canvasSurfaceById(surface.id)
      : surface) || surface;
    var layout = paneLayoutForThread(surface);
    if (!layout || !layout.root) return;
    if (!paneSurfaceFocusEligible(layout, surface)) return;
    var leaf = PsychePanes.findLeafByThreadId(layout.root, surface.id);
    if (!leaf) return;
    layout.maximizedLeafId = layout.maximizedLeafId === leaf.id ? null : leaf.id;
    layout.focusedLeafId = leaf.id;
    var thread = typeof findThread === "function" ? findThread(surface.id) : surface;
    if (surface.kind === "files") {
      focusCanvasSurface(surface);
    } else if (state.activeThreadId !== surface.id && thread) {
      focusThread(surface.id);
      return;
    }
    renderPaneWorkspace();
  }

  /** Leave focus mode; reports whether there was one to leave (esc cascade). */
  function exitPaneMaximize() {
    var layout = activePaneLayout();
    if (!layout || !layout.maximizedLeafId) return false;
    layout.maximizedLeafId = null;
    renderPaneWorkspace();
    return true;
  }

  var MAX_ICON =
    '<svg viewBox="0 0 14 14" width="11" height="11" aria-hidden="true">' +
    '<path d="M5.5 2H2v3.5M8.5 12H12V8.5" fill="none" stroke="currentColor" ' +
    'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var RESTORE_ICON =
    '<svg viewBox="0 0 14 14" width="11" height="11" aria-hidden="true">' +
    '<path d="M2 5.5h3.5V2M12 8.5H8.5V12" fill="none" stroke="currentColor" ' +
    'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function syncPaneMaxControl(thread, layout, leaf) {
    if (!thread.paneMax) return;
    var maxed = Boolean(leaf) && layout.maximizedLeafId === leaf.id;
    var label = maxed ? "Restore the tiling (esc)" : "Focus this pane";
    thread.paneMax.innerHTML = maxed ? RESTORE_ICON : MAX_ICON;
    thread.paneMax.title = label;
    thread.paneMax.setAttribute("aria-label", label);
    thread.paneMax.setAttribute("aria-pressed", maxed ? "true" : "false");
  }

  function focusedTerminalThreadForRender() {
    var activeElement = document.activeElement;
    if (!activeElement) return null;
    for (var i = 0; i < state.threads.length; i++) {
      var thread = state.threads[i];
      if (thread.terminalController && thread.host && thread.host.contains(activeElement)) {
        return thread;
      }
    }
    return null;
  }

  function restoreRenderedTerminalFocus(thread) {
    if (!thread) return;
    requestAnimationFrame(function () {
      if (
        !isLiveThread(thread) ||
        state.activeThreadId !== thread.id ||
        !thread.terminalController ||
        !thread.pane ||
        terminalHost.hidden ||
        !terminalHost.contains(thread.pane)
      ) {
        return;
      }
      withTerminalFocusReportToken(thread, "\x1b[I", "suppress", function () {
        thread.terminalController.focus();
      });
    });
  }

  function renderPaneNode(node, splitRatios) {
    if (node.type === "leaf") {
      var thread = typeof canvasSurfaceById === "function"
        ? canvasSurfaceById(node.threadId)
        : findThread(node.threadId);
      if (thread && thread.kind === "files" && !thread.pane) {
        mountFilesPane(thread);
      }
      if (thread && thread.kind === "files" && thread.host && fileViewEl &&
          fileViewEl.parentElement !== thread.host) {
        thread.host.appendChild(fileViewEl);
      }
      if (thread && thread.kind === "web" && thread.browserBody && browserSurface) {
        thread.browserBody.appendChild(browserSurface);
      }
      if (thread && thread.kind === "git" && thread.toolBody && gitSurfaceEl &&
          gitSurfaceEl.parentElement !== thread.toolBody) {
        thread.toolBody.appendChild(gitSurfaceEl);
      }
      return thread && thread.pane ? thread.pane : document.createDocumentFragment();
    }
    var ratio = splitRatios.get(node.id);
    if (!Number.isFinite(ratio)) ratio = node.ratio;
    var isRow = node.orientation === "row";
    var split = document.createElement("div");
    split.className = "terminal-pane-split" + (isRow ? " is-row" : "");
    var first = document.createElement("div");
    first.className = "terminal-pane-branch";
    first.style.flexGrow = String(ratio);
    first.appendChild(renderPaneNode(node.first, splitRatios));
    syncPaneBranchStatusChrome(first);
    var second = document.createElement("div");
    second.className = "terminal-pane-branch";
    second.style.flexGrow = String(1 - ratio);
    second.appendChild(renderPaneNode(node.second, splitRatios));
    syncPaneBranchStatusChrome(second);
    var divider = createPaneDivider(node, ratio);
    split.appendChild(first);
    split.appendChild(divider);
    split.appendChild(second);
    mountedSplitBranches.set(node.id, { first: first, second: second, divider: divider });
    return split;
  }

  function renderPaneWorkspace(options) {
    if (!terminalHost) return;
    var focusTargetThread = options && options.focusTargetThread || null;
    var preserveTerminalFocus = !focusTargetThread &&
      (!options || options.preserveTerminalFocus !== false);
    var focusedThread = focusedTerminalThreadForRender();
    try {
      if (focusedThread && focusedThread.terminalController) {
        withTerminalFocusReportToken(
          focusedThread,
          "\x1b[O",
          preserveTerminalFocus ? "suppress" : "allow",
          function () {
            focusedThread.terminalController.blur();
          }
        );
      }
      stageBrowserSurface();
      stageGitSurface();
      terminalHost.replaceChildren();
      // Everything renderPaneNode registered is about to be detached, so the
      // live-resize registry is only ever as old as this render.
      mountedSplitBranches.clear();
      var layout = activePaneLayout();
      if (!layout || !layout.root) {
        renderTerminalEmptyState();
        renderPaneMinimap(
          layout,
          filesPaneHasCanvasFocus() ? findOpenFile(state.activeFileId) : null
        );
        syncAllPtyVisibility();
        return;
      }
      var root = effectivePaneRoot(layout);
      var projected = PsychePanes.layoutRects(
        root,
        measuredTerminalHost(),
        PANE_MINIMUMS
      );
      var splitRatios = new Map();
      projected.splits.forEach(function (split) {
        splitRatios.set(split.splitId, split.ratio);
      });
      terminalHost.appendChild(renderPaneNode(root, splitRatios));
      // Span and maximise change what every *other* pane's controls should say,
      // so the whole tiled tree is synced, not just the panes on screen.
      PsychePanes.leafIds(layout.root).forEach(function (leafId) {
        var leaf = PsychePanes.findLeafById(layout.root, leafId);
        var surface = leaf && (typeof canvasSurfaceById === "function"
          ? canvasSurfaceById(leaf.threadId)
          : findThread(leaf.threadId));
        if (!surface || !surface.pane) return;
        var focused = leaf.id === layout.focusedLeafId;
        surface.pane.classList.toggle("focused", focused);
        surface.pane.setAttribute("aria-current", focused ? "true" : "false");
        syncPaneMaxControl(surface, layout, leaf);
        var thread = findThread(surface.id);
        if (thread) {
          syncPanePicking(thread);
          syncThreadPaneMetadata(thread);
        }
      });
      renderSetPickBar();
      renderPaneMinimap(
        layout,
        filesPaneHasCanvasFocus() ? findOpenFile(state.activeFileId) : null
      );
      syncAllPtyVisibility();
      scheduleTerminalPaneFits();
      scheduleBrowserBounds();
    } finally {
      if (preserveTerminalFocus) restoreRenderedTerminalFocus(focusedThread);
    }

  }

  /**
   * While picking, a tile is a checkbox. The overlay takes the click so the
   * gesture never reaches the terminal underneath — a stray keystroke into a
   * live shell is not an acceptable cost for selecting a pane.
   */
  function syncPanePicking(thread) {
    var pane = thread.pane;
    var picking = Boolean(setPicking);
    pane.classList.toggle("is-picking", picking);
    pane.classList.toggle("is-picked", picking && isPicked(thread.id));
    var overlay = pane.querySelector(".pane-pick-overlay");
    if (!picking) {
      if (overlay) overlay.remove();
      return;
    }
    if (!overlay) {
      overlay = document.createElement("button");
      overlay.type = "button";
      overlay.className = "pane-pick-overlay";
      overlay.addEventListener("click", function (event) {
        event.stopPropagation();
        toggleSetPick(thread.id);
      });
      pane.appendChild(overlay);
    }
    var picked = isPicked(thread.id);
    overlay.textContent = picked ? "✓" : "";
    overlay.title = (picked ? "Remove " : "Include ") + thread.name + " in the set";
    overlay.setAttribute("aria-label", overlay.title);
    overlay.setAttribute("aria-pressed", picked ? "true" : "false");
  }

  /**
   * The pick bar is the only chrome a focus set ever gets, and it only exists
   * while you are picking — Board 10's "zero standing chrome". Built here
   * rather than in index.html for the same reason.
   */
  function renderSetPickBar() {
    if (!terminalArea) return;
    var bar = terminalArea.querySelector(".set-pick-bar");
    if (!setPicking) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "set-pick-bar";
      bar.setAttribute("role", "toolbar");
      bar.setAttribute("aria-label", "Focus set selection");
      terminalArea.insertBefore(bar, terminalHost);
    }
    var count = setPicking.picked.length;
    bar.replaceChildren();

    var hint = document.createElement("span");
    hint.className = "set-pick-hint";
    hint.title = "Click tiles or sidebar rows to include them — the set shows only what you pick";
    var dot = document.createElement("span");
    dot.className = "set-pick-dot";
    hint.appendChild(dot);
    hint.appendChild(document.createTextNode("Pick panes"));

    var create = document.createElement("button");
    create.type = "button";
    create.className = "set-pick-create";
    create.textContent = "Create · " + count;
    create.disabled = count === 0;
    create.title = count
      ? "Create the set — the canvas will show only these panes"
      : "Pick at least one pane";
    create.addEventListener("click", function () { createFocusSet(); });

    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "set-pick-cancel";
    cancel.textContent = "×";
    cancel.title = "Cancel (esc)";
    cancel.setAttribute("aria-label", "Cancel picking");
    cancel.addEventListener("click", function () { cancelSetPicking(); });

    bar.appendChild(hint);
    bar.appendChild(create);
    bar.appendChild(cancel);
  }

  /**
   * Focus mode hides every pane but one, so the minimap is how the others stay
   * reachable — a carousel of the panes the canvas is no longer drawing.
   */
  function paneMinimapItems(layout, activeFile) {
    var items = [];
    if (activeFile) {
      items.push({
        kind: "file",
        id: activeFile.id,
        label: activeFile.name,
        detail: activeFile.rel,
        current: true,
        thread: null,
      });
    }
    if (!layout || !layout.root) return items;

    PsychePanes.leafIds(scopedPaneRoot(layout)).forEach(function (leafId) {
      var leaf = PsychePanes.findLeafById(layout.root, leafId);
      var surface = leaf && canvasSurfaceById(leaf.threadId);
      if (!surface) return;
      if (surface.kind === "files") {
        if (activeFile) return;
        var file = findOpenFile(surface.activeFileId);
        items.push({
          kind: "file",
          id: file ? file.id : surface.id,
          label: file ? file.name : (surface.name || "Files"),
          detail: file ? file.rel : (surface.workspaceRoot || "Workspace files"),
          current: layout.maximizedLeafId === leafId,
          thread: null,
          surface: surface,
        });
        return;
      }
      var thread = surface;
      items.push({
        kind: "pane",
        id: thread.id,
        label: thread.name,
        detail: (thread.status || "") +
          (thread.needsAttention
            ? " · " + PsycheSessions.attentionLabel(thread.attentionReason)
            : ""),
        current: !activeFile && layout.maximizedLeafId === leafId,
        thread: thread,
      });
    });
    return items;
  }

  function renderPaneMinimap(layout, activeFile) {
    if (!terminalArea) return;
    var rail = terminalArea.querySelector(".pane-minimap");
    if (!activeFile && (!layout || !layout.maximizedLeafId)) {
      if (rail) rail.remove();
      return;
    }
    if (!rail) {
      rail = document.createElement("aside");
      rail.className = "pane-minimap";
      rail.setAttribute("aria-label", "Pane minimap");
      terminalArea.appendChild(rail);
    }
    rail.replaceChildren();
    paneMinimapItems(layout, activeFile).forEach(function (item) {
      var entry = document.createElement("button");
      entry.type = "button";
      entry.className = "minimap-pane" +
        (item.kind === "file" ? " is-file" : "") +
        (item.current ? " is-current" : "");
      if (item.kind === "pane") entry.dataset.threadId = item.thread.id;
      if (item.surface) entry.dataset.surfaceId = item.surface.id;
      entry.title = item.kind === "file"
        ? item.current
          ? item.detail + " · current file"
          : item.label + " — " + item.detail + " · click to focus Files"
        : item.label + " — " + item.detail + " · click to focus this pane";
      entry.setAttribute("aria-label", entry.title);

      var head = document.createElement("span");
      head.className = "minimap-head";
      var glyph = document.createElement("span");
      glyph.className = "minimap-glyph";
      glyph.textContent = item.kind === "file" ? "F" : paneGlyphFor(item.thread.kind);
      var dot = document.createElement("span");
      dot.className = item.kind === "file"
        ? "minimap-dot file"
        : "minimap-dot " + sessionStatusClass(item.thread) +
          (item.thread.needsAttention ? " attention" : "");
      head.appendChild(glyph);
      head.appendChild(dot);

      var body = document.createElement("span");
      body.className = "minimap-body";
      var name = document.createElement("span");
      name.className = "minimap-name";
      name.textContent = item.label;

      entry.appendChild(head);
      entry.appendChild(body);
      entry.appendChild(name);
      if (item.kind === "file") {
        entry.addEventListener("click", function () {
          if (item.surface) {
            togglePaneMaximize(item.surface);
            return;
          }
          restoreFileEditorFocus();
        });
      } else {
        entry.addEventListener("click", async function () {
          var leaf = PsychePanes.findLeafByThreadId(layout.root, item.thread.id);
          if (!leaf) return;
          if (filesPaneHasCanvasFocus()) {
            await returnFromFileFocus(item.thread.id, true);
            return;
          }
          await focusThread(item.thread.id);
        });
      }
      rail.appendChild(entry);
    });
  }

  function focusCanvasSurface(surface) {
    if (!surface) return false;
    if (surface.kind !== "files") {
      focusThread(surface.id);
      return true;
    }
    if (typeof rememberFilesPaneReturnThread === "function") {
      rememberFilesPaneReturnThread(surface);
    }
    var project = findProject(surface.projectId);
    if (project) {
      assignSelectedWorktreePath(project, surface.workspaceRoot);
      if (typeof assignActiveProjectId === "function") assignActiveProjectId(project.id);
      else Object.assign(state, { activeProjectId: project.id });
    }
    state.activeThreadId = null;
    var layout = paneLayoutFor(surface.projectId, surface.workspaceRoot);
    var leaf = layout && layout.root
      ? PsychePanes.findLeafByThreadId(layout.root, surface.id)
      : null;
    if (!layout || !leaf) return false;
    layout.focusedLeafId = leaf.id;
    PsychePanes.leafIds(layout.root).forEach(function (leafId) {
      var candidateLeaf = PsychePanes.findLeafById(layout.root, leafId);
      var candidate = candidateLeaf && canvasSurfaceById(candidateLeaf.threadId);
      if (candidate && candidate.pane) {
        var focused = candidateLeaf.id === leaf.id;
        candidate.pane.classList.toggle("focused", focused);
        candidate.pane.setAttribute("aria-current", focused ? "true" : "false");
      }
    });
    refreshSidebar();
    return true;
  }

  async function focusThread(id, options) {
    function resolveFocusableThread() {
      var candidate = findThread(id);
      var candidateLayout = paneLayoutForThread(candidate);
      return paneSurfaceFocusEligible(candidateLayout, candidate) ? candidate : null;
    }
    var thread = resolveFocusableThread();
    if (!thread) return false;
    var layout = paneLayoutForThread(thread);
    if (!(await showTerminalView())) return false;
    thread = resolveFocusableThread();
    if (!thread) return false;
    layout = paneLayoutForThread(thread);
    var focusedSourceThread = focusedTerminalThreadForRender();
    if (focusedSourceThread) {
      withTerminalFocusReportToken(
        focusedSourceThread,
        "\x1b[O",
        "allow",
        function () {
          focusedSourceThread.terminalController.blur();
        }
      );
    }
    var project = findProject(thread.projectId);
    var scopeChanged = state.activeProjectId !== thread.projectId ||
      !project || activeWorkspaceRoot(project) !== thread.worktreePath;
    markActiveSurface(thread.kind === "web" ? "browser" : "terminal");
    state.activeThreadId = id;
    // Make the thread's project the active one so the sidebar/tabs
    // stay in sync if the user clicked into a different project's thread.
    if (project) assignSelectedWorktreePath(project, thread.worktreePath);
    if (thread.projectId && state.activeProjectId !== thread.projectId) {
      if (typeof assignActiveProjectId === "function") assignActiveProjectId(thread.projectId);
      else Object.assign(state, { activeProjectId: thread.projectId });
    }
    if (project) {
      if (thread.kind !== "coven-code" && thread.kind !== "coven-attach") {
        project.lastActiveThreadId = id;
      }
    }
    var leaf = layout && PsychePanes.findLeafByThreadId(layout.root, id);
    if (layout && leaf) {
      var maximizedLeafId = layout.maximizedLeafId ||
        options && options.preserveFullscreenLeafId;
      if (maximizedLeafId) {
        layout.maximizedLeafId = PsychePanes.findLeafById(layout.root, maximizedLeafId)
          ? leaf.id
          : null;
      }
      layout.focusedLeafId = leaf.id;
    }
    renderPaneWorkspace({ focusTargetThread: thread });
    if (scopeChanged) renderGitSurface();
    refreshSidebar();
    requestAnimationFrame(function () {
      var focusedThread = resolveFocusableThread();
      if (!focusedThread || state.activeThreadId !== id) return;
      if (
        isLiveThread(focusedThread) &&
        focusedThread.terminalController &&
        focusedThread.pane &&
        !terminalHost.hidden &&
        terminalHost.contains(focusedThread.pane)
      ) {
        scheduleTerminalPaneFits();
        if (!options || options.focusTerminal !== false) {
          withTerminalFocusReportToken(focusedThread, "\x1b[I", "allow", function () {
            focusedThread.terminalController.focus();
          });
        }
      }
      scheduleBrowserBounds();
    });

    setProjectStatus(project, statusLevel(thread.status));
    if ((!options || options.refreshStatus !== false) &&
        typeof refreshStatusController === "function") {
      refreshStatusController();
    }
    saveWorkspaceSoon();
    return true;
  }

  async function focusThreadFromSidebar(thread) {
    var layout = paneLayoutForThread(thread);
    var maximizedLeafId = layout && layout.maximizedLeafId;
    applySetScopeForThread(thread);
    if (maximizedLeafId) {
      return focusThread(thread.id, { preserveFullscreenLeafId: maximizedLeafId });
    }
    return focusThread(thread.id);
  }

  async function focusBrowserPaneForNavigation(pane, options) {
    options = options || {};
    var isCurrent = typeof options.isCurrent === "function"
      ? options.isCurrent
      : function () { return true; };
    if (!pane || !isCurrent()) return false;
    if (!options.alreadyFocused) {
      var layout = paneLayoutForThread(pane);
      var maximizedLeafId = layout && layout.maximizedLeafId;
      var focusOptions = { focusTerminal: false };
      if (maximizedLeafId) {
        focusOptions.preserveFullscreenLeafId = maximizedLeafId;
      }
      if (!(await focusThread(pane.id, focusOptions))) return false;
    }
    return isCurrent();
  }

  function statusLevel(s) {
    if (s === "running") return "ok";
    if (s === "starting") return "";
    return "warn";
  }

  function syncThreadPaneMetadata(thread) {
    if (!thread) return;
    if (thread.paneTitle) thread.paneTitle.textContent = thread.name;
    if (thread.paneMeta) {
      thread.paneMeta.textContent = (thread.kind || "shell") + " · " +
        threadLaneLabel(thread);
    }
    if (thread.pane) {
      var normalizedStatus = applyPaneStatus(thread.pane, thread.status);
      thread.pane.setAttribute(
        "aria-label",
        thread.name + (normalizedStatus ? ", status " + normalizedStatus : "")
      );
      syncPaneBranchStatusChrome(thread.pane.parentElement);
    }
    if (typeof syncPaneFooter === "function") syncPaneFooter(thread);
    var layout = paneLayoutForThread(thread);
    var leaf = layout && layout.root
      ? PsychePanes.findLeafByThreadId(layout.root, thread.id)
      : null;
    if (layout) {
      syncPaneMaxControl(thread, layout, leaf);
    }
    if (thread.paneClose) {
      var closeLabel = sessionCloseLabel(thread);
      thread.paneClose.title = closeLabel;
      thread.paneClose.setAttribute("aria-label", closeLabel);
    }
  }

  function detachThreadPane(surface, options) {
    surface = surface && (typeof canvasSurfaceById === "function"
      ? canvasSurfaceById(surface.id)
      : surface);
    if (!surface) return null;
    var thread = typeof findThread === "function" ? findThread(surface.id) : surface;
    if (thread && thread.terminalController) {
      var focusedThread = focusedTerminalThreadForRender();
      if (focusedThread === thread) {
        withTerminalFocusReportToken(thread, "\x1b[O", "allow", function () {
          thread.terminalController.blur();
        });
      }
    }
    if (thread && typeof paneFooterPopoverThreadId !== "undefined" &&
        paneFooterPopoverThreadId === thread.id &&
        typeof closePaneFooterPopovers === "function") {
      closePaneFooterPopovers(false);
    }
    if (thread && typeof closePaneFooterMenu === "function") closePaneFooterMenu(thread, false);
    if (thread && thread.paneFooterObserver) thread.paneFooterObserver.disconnect();
    if (thread) {
      thread.paneFooterObserver = null;
      thread.paneFooter = null;
      thread.paneFooterItems = null;
      thread.paneFooterOverflow = null;
      thread.paneFooterMenuTrigger = null;
      thread.createPaneFooterButton = null;
    }
    var key = paneLayoutKey(
      surface.projectId,
      surface.worktreePath || surface.workspaceRoot
    );
    var layout = paneLayouts.get(key);
    if (!layout || !layout.root) return null;
    var leaf = PsychePanes.findLeafByThreadId(layout.root, surface.id);
    if (!leaf) return null;
    var removed = PsychePanes.removeLeaf(layout.root, leaf.id);
    if (!removed.root) {
      paneLayouts.delete(key);
      if (!options || options.persist !== false) saveWorkspaceSoon();
      return null;
    }
    layout.root = removed.root;
    var nextLeaf = PsychePanes.findLeafById(removed.root, removed.nextLeafId);
    var nextThreadId = resolvePaneFocusSuccessor(
      layout,
      nextLeaf ? nextLeaf.threadId : null
    );
    nextLeaf = nextThreadId
      ? PsychePanes.findLeafByThreadId(removed.root, nextThreadId)
      : null;
    if (layout.focusedLeafId === leaf.id) {
      layout.focusedLeafId = nextLeaf ? nextLeaf.id : null;
    }
    paneLayouts.set(key, layout);
    if (!options || options.persist !== false) saveWorkspaceSoon();
    return nextLeaf ? nextLeaf.threadId : null;
  }

  async function closeBrowserPane(thread) {
    if (!thread || thread.kind !== "web") return false;
    var paneLifecycle = browserPaneLifecycle(thread);
    if (paneLifecycle.tearingDown) return false;
    paneLifecycle.tearingDown = true;
    try {
    var project = findProject(thread.projectId);
    if (!project) return false;
    var browser = ensureBrowserModel(project, thread.worktreePath);
    if (!browser) return false;
    var originalActiveTabId = browser.activeTabId;
    var tabMetadataByLabel = new Map(browser.tabs.map(function (tab) {
      var navigationSnapshot = browserTabLifecycle(tab).navigationSnapshot;
      return [browserLabelForTab(project, tab), {
        id: tab.id,
        label: browserLabelForTab(project, tab),
        url: navigationSnapshot ? navigationSnapshot.url : (tab.url || "about:blank"),
        title: navigationSnapshot ? navigationSnapshot.title : tab.title,
        history: navigationSnapshot
          ? navigationSnapshot.history.slice()
          : (Array.isArray(tab.history) ? tab.history.slice() : []),
        historyIndex: navigationSnapshot ? navigationSnapshot.historyIndex : tab.historyIndex,
        wasLive: tab.created,
      }];
    }));
    var liveTabs = Array.from(tabMetadataByLabel.values()).filter(function (tab) {
      return tab.wasLive;
    });
    var liveTabsByLabel = new Map(liveTabs.map(function (tab) {
      return [tab.label, tab];
    }));
    var labels = browser.tabs.map(function (tab) {
      return browserLabelForTab(project, tab);
    });
    async function recoverAffectedLiveTabs(recoverLabels, skippedLabels) {
      var recreated = 0;
      var affectedLiveTabs = 0;
      var recoveryErrors = [];
      for (var index = 0; index < labels.length; index += 1) {
        var label = labels[index];
        if (!recoverLabels.has(label)) continue;
        var savedTab = skippedLabels.has(label) ? null : liveTabsByLabel.get(label);
        if (savedTab) affectedLiveTabs += 1;
        var currentTab = browser.tabs.find(function (tab) {
          return browserLabelForTab(project, tab) === label;
        });
        if (!currentTab) {
          recoveryErrors.push(label + ": tab state missing");
          continue;
        }
        var tabLifecycle = browserTabLifecycle(currentTab);
        currentTab.created = false;
        currentTab.loading = false;
        tabLifecycle.nativeLabel = null;
        tabLifecycle.pendingGeneration = 0;
        tabLifecycle.pendingUrl = null;
        tabLifecycle.liveGeneration = 0;
        tabLifecycle.liveUrl = null;
        tabLifecycle.liveNavigationToken = null;
        tabLifecycle.eventUrl = null;
        tabLifecycle.viewLive = false;
        tabLifecycle.navigationSnapshot = null;
        if (skippedLabels.has(label)) continue;
        if (!savedTab) continue;
        try {
          var recoveryNavigationToken = "recovery:" + Date.now() + ":" + index;
          var recoveryGeneration = tabLifecycle.generation + 1;
          if (!tabLifecycle.automationSource) tabLifecycle.automationSource = PsycheControl.browserAutomationSource();
          var recoveryNavigation = await invoke("browser_navigate", {
            label: savedTab.label,
            url: savedTab.url,
            x: -10000,
            y: -10000,
            w: 1,
            h: 1,
            generation: recoveryGeneration,
            navigationToken: recoveryNavigationToken,
            automationSource: tabLifecycle.automationSource,
          });
          currentTab.created = true;
          currentTab.loading = false;
          tabLifecycle.generation = recoveryGeneration;
          tabLifecycle.nativeLabel = nativeBrowserLabel(savedTab.label);
          tabLifecycle.liveGeneration = tabLifecycle.generation;
          tabLifecycle.liveUrl = savedTab.url;
          tabLifecycle.liveNavigationToken = recoveryNavigationToken;
          tabLifecycle.viewLive = true;
          recreated += 1;
        } catch (recoveryError) {
          currentTab.created = false;
          currentTab.loading = false;
          recoveryErrors.push(savedTab.id + ": " + boundedBrowserError(recoveryError));
        }
      }
      if (browser.tabs.some(function (tab) { return tab.id === originalActiveTabId; })) {
        browser.activeTabId = originalActiveTabId;
      }
      browser.tabs.forEach(function (tab) {
        var metadata = tabMetadataByLabel.get(browserLabelForTab(project, tab));
        if (!metadata) return;
        tab.url = metadata.url;
        tab.title = metadata.title;
        tab.history = metadata.history.slice();
        tab.historyIndex = metadata.historyIndex;
      });
      syncProjectBrowser();
      saveWorkspaceSoon();
      return {
        recreated: recreated,
        affectedLiveTabs: affectedLiveTabs,
        recoveryErrors: recoveryErrors,
      };
    }
    async function restoreLiveBrowserControls() {
      var recoveryErrors = [];
      for (var index = 0; index < browser.tabs.length; index += 1) {
        var tab = browser.tabs[index];
        var lifecycle = browserTabLifecycle(tab);
        if (!tab.created || !lifecycle.nativeLabel || !lifecycle.viewLive) continue;
        try {
          var restored = await installBrowserAutomationForPair({
            project: project,
            worktreePath: thread.worktreePath,
            browser: browser,
            tab: tab,
          });
          if (!restored) recoveryErrors.push(tab.id + ": browser control restore was not confirmed");
        } catch (error) {
          recoveryErrors.push(tab.id + ": " + boundedBrowserError(error));
        }
      }
      return recoveryErrors;
    }
    for (var automationIndex = 0; automationIndex < browser.tabs.length; automationIndex += 1) {
      var automationTab = browser.tabs[automationIndex];
      if (!browserTabLifecycle(automationTab).nativeLabel) continue;
      var automationPair = { project: project, worktreePath: thread.worktreePath, browser: browser, tab: automationTab };
      var automationInvalidated = false;
      try {
        automationInvalidated = await invalidateBrowserAutomation(automationPair);
      } catch (error) {
        setStatus(
          "browser pane close failed before native teardown: " +
            boundedBrowserError(error),
          "error"
        );
        return false;
      }
      if (!automationInvalidated) {
        setStatus("browser automation invalidation failed", "error");
        return false;
      }
      var controlRemoved = false;
      try {
        controlRemoved = await removeBrowserControlResource(automationPair);
      } catch (error) {
        setStatus(
          "browser pane close failed before native teardown: " +
            boundedBrowserError(error),
          "error"
        );
        return false;
      }
      if (!controlRemoved) {
        setStatus(
          "browser pane close failed before native teardown: browser control resource removal was not confirmed",
          "error"
        );
        return false;
      }
    }
    var navigationTails = browser.tabs.map(function (tab) {
      return browserTabLifecycle(tab).navigationTail;
    }).filter(function (tail) {
      return !!tail;
    });
    if (navigationTails.length) await Promise.all(navigationTails);
    var outcome;
    try {
      outcome = labels.length
        ? await invoke("browser_destroy_many", { labels: labels })
        : { destroyed: [], failures: [] };
    } catch (error) {
      var missingLiveLabels = new Set();
      liveTabs.forEach(function (savedTab) {
        var currentTab = browser.tabs.find(function (tab) {
          return browserLabelForTab(project, tab) === savedTab.label;
        });
        if (!currentTab || !currentTab.created ||
            !browserTabLifecycle(currentTab).viewLive) {
          missingLiveLabels.add(savedTab.label);
        }
      });
      var transportStatus = "browser pane close failed before structured teardown outcome: " + boundedBrowserError(error);
      if (missingLiveLabels.size) {
        var transportRecovery = await recoverAffectedLiveTabs(missingLiveLabels, new Set());
        transportStatus += "; recreated " + transportRecovery.recreated + "/" +
          transportRecovery.affectedLiveTabs + " missing live tabs";
        if (transportRecovery.recoveryErrors.length) {
          transportStatus += "; recreation failures: " + transportRecovery.recoveryErrors.join(", ");
        }
      }
      var transportControlErrors = await restoreLiveBrowserControls();
      if (transportControlErrors.length) {
        transportStatus += "; browser control restore failures: " + transportControlErrors.join(", ");
      }
      setStatus(transportStatus, "error");
      return false;
    }
    var destroyed = new Set(Array.isArray(outcome && outcome.destroyed) ? outcome.destroyed : []);
    var failures = Array.isArray(outcome && outcome.failures)
      ? outcome.failures.map(function (failure) {
          return {
            label: failure && typeof failure.label === "string" ? failure.label : "",
            error: failure && failure.error != null ? boundedBrowserError(failure.error) : "unknown close error",
          };
        })
      : [];
    var failedLabels = new Set(failures.map(function (failure) { return failure.label; }));
    labels.forEach(function (label) {
      if (!destroyed.has(label) && !failedLabels.has(label)) {
        failures.push({ label: label, error: "missing teardown outcome" });
        failedLabels.add(label);
      }
    });
    if (failures.length) {
      destroyed.forEach(function (label) {
        var destroyedTab = browser.tabs.find(function (tab) {
          return browserLabelForTab(project, tab) === label;
        });
        if (destroyedTab) invalidateBrowserNavigation(destroyedTab);
      });
      var recovery = await recoverAffectedLiveTabs(destroyed, failedLabels);
      var closeErrors = failures.map(function (failure) {
        return failure.label + ": " + failure.error;
      });
      var recoveryStatus = "browser pane close failed; native close failures: " + closeErrors.join(", ");
      recoveryStatus += "; recreated " + recovery.recreated + "/" + recovery.affectedLiveTabs + " confirmed-destroyed live tabs";
      if (recovery.recoveryErrors.length) recoveryStatus += "; recreation failures: " + recovery.recoveryErrors.join(", ");
      var controlRecoveryErrors = await restoreLiveBrowserControls();
      if (controlRecoveryErrors.length) {
        recoveryStatus += "; browser control restore failures: " + controlRecoveryErrors.join(", ");
      }
      setStatus(recoveryStatus, "error");
      return false;
    }
    var wasActive = state.activeThreadId === thread.id;
    browser.tabs.forEach(function (tab) {
      invalidateBrowserNavigation(tab);
      tab.created = false;
      tab.loading = false;
      var lifecycle = browserTabLifecycle(tab);
      lifecycle.nativeLabel = null;
      lifecycle.pendingGeneration = 0;
      lifecycle.pendingUrl = null;
      lifecycle.liveGeneration = 0;
      lifecycle.liveUrl = null;
      lifecycle.liveNavigationToken = null;
      lifecycle.eventUrl = null;
      lifecycle.viewLive = false;
      lifecycle.navigationSnapshot = null;
    });
    saveWorkspaceSoon();
    stageBrowserSurface();
    var closed = await closeThread(thread.id);
    if (closed && wasActive) markActiveSurface("terminal");
    return closed;
    } finally {
      paneLifecycle.tearingDown = false;
    }
  }

  function retainFileFocusAfterThreadRemoval(removedThreadId, nextThreadId, projectId) {
    if (!state.activeFileId || !filesPaneHasCanvasFocus()) return false;
    state.activeThreadId = nextThreadId || null;
    if (fileFocus.returnThreadId === removedThreadId) {
      fileFocus.returnThreadId = nextThreadId || null;
    }
    if (typeof filesPanes !== "undefined") {
      filesPanes.forEach(function (filesPane) {
        if (filesPane.previousFocusedSessionId === removedThreadId) {
          filesPane.previousFocusedSessionId = null;
        }
      });
    }
    var project = findProject(projectId);
    if (project) {
      project.lastActiveThreadId = nextThreadId || null;
      if (nextThreadId) {
        var nextThread = findThread(nextThreadId);
        if (nextThread) assignSelectedWorktreePath(project, nextThread.worktreePath);
      }
    }
    return true;
  }

  async function closeThread(id, options) {
    var thread = findThread(id);
    if (!thread || thread.closeStarted) return false;
    var protectCovenRecovery = !options || options.protectCovenRecovery !== false;
    if (protectCovenRecovery && thread.covenLaunchOutcomeInFlight) {
      await thread.covenLaunchOutcomeInFlight;
      thread = findThread(id);
      if (!thread || thread.closeStarted) return false;
    }
    if (protectCovenRecovery && thread.covenLaunchAcceptanceInFlight) {
      await thread.covenLaunchAcceptanceInFlight;
      thread = findThread(id);
      if (!thread || thread.closeStarted) return false;
    }
    if (protectCovenRecovery && thread.retryInFlight) {
      await thread.retryInFlight;
      thread = findThread(id);
      if (!thread || thread.closeStarted) return false;
    }
    var wasActive = state.activeThreadId === id;
    if (thread.kind === "git") {
      suspendGitRequests();
      stageGitSurface();
    }
    if (thread.kind === "web" && wasActive) {
      markActiveSurface("terminal");
    }
    thread.closeStarted = true;
    thread.closing = true;
    if (
      protectCovenRecovery &&
      thread.launch &&
      (thread.launch.launchKind === "coven-recovery" ||
        thread.launch.recoveryRequired === true)
    ) {
      thread.closeStarted = false;
      thread.closing = false;
      setStatus(
        thread.name +
          " cannot be closed while its Coven launch outcome requires recovery; " +
          "inspect Coven before closing",
        "error"
      );
      return false;
    }
    if (isPersistentThread(thread) && !(options && options.skipNativeSessionStop)) {
      try {
        await invoke("native_session_stop", { id: thread.id });
      } catch (error) {
        thread.closeStarted = false;
        thread.closing = false;
        setStatus("failed to stop " + thread.name + ": " + String(error), "error");
        return false;
      }
    }
    if (thread.ptyIoQueue) {
      thread.ptyIoQueue.closed = true;
    }
    thread.metricsGeneration += 1;
    if (thread.metricsRefreshTimer) {
      clearTimeout(thread.metricsRefreshTimer);
      thread.metricsRefreshTimer = 0;
    }
    if (typeof noteStatusActivity === "function") noteStatusActivity();
    if (thread.terminalController && thread.terminalController.dispose) {
      try { thread.terminalController.dispose(); } catch (_) {}
    }
    // A set must never point at a thread that no longer exists, or scoping the
    // canvas to it would silently show fewer panes than it claims.
    forgetThreadInSets(id);
    var nextThreadId = detachThreadPane(thread, {
      persist: !options || options.persist !== false,
    });
    thread.terminalController = null;
    thread.term = null;
    if (thread.kind !== "web" && thread.kind !== "git" && !thread.startInFlight) {
      await stopThreadPty(thread);
    }
    var closingProjectId = thread.projectId;
    state.threads = state.threads.filter(function (t) { return t.id !== id; });
    if (wasActive) {
      var closingLayout = paneLayoutForThread(thread);
      nextThreadId = resolvePaneFocusSuccessor(closingLayout, nextThreadId, true);
      if (closingLayout) {
        var focusedLeaf = closingLayout.focusedLeafId &&
          PsychePanes.findLeafById(closingLayout.root, closingLayout.focusedLeafId);
        var focusedSurface = focusedLeaf && (typeof canvasSurfaceById === "function"
          ? canvasSurfaceById(focusedLeaf.threadId)
          : findThread(focusedLeaf.threadId));
        if (!paneSurfaceFocusEligible(closingLayout, focusedSurface)) {
          var successorLeaf = nextThreadId &&
            PsychePanes.findLeafByThreadId(closingLayout.root, nextThreadId);
          closingLayout.focusedLeafId = successorLeaf ? successorLeaf.id : null;
        }
      }
      // Prefer the next thread in the same project so closing a tab doesn't
      // teleport the user into a different project.
      state.activeThreadId = null;
      if (retainFileFocusAfterThreadRemoval(id, nextThreadId, closingProjectId)) {
        renderPaneWorkspace({ preserveTerminalFocus: false });
        if (!nextThreadId) setProjectStatus(findProject(closingProjectId), "");
      } else if (nextThreadId && (!options || options.focus !== false)) {
        var nextThread = findThread(nextThreadId);
        var nextSurface = nextThread || (typeof canvasSurfaceById === "function"
          ? canvasSurfaceById(nextThreadId)
          : null);
        if (nextThread) focusThread(nextThreadId);
        else if (nextSurface) renderPaneWorkspace();
      } else {
        renderPaneWorkspace({ preserveTerminalFocus: false });
        setProjectStatus(findProject(closingProjectId), "");
      }
    } else if (options && options.preserveTerminalFocus === false) {
      renderPaneWorkspace({ preserveTerminalFocus: false });
    } else {
      renderPaneWorkspace();
    }
    refreshSidebar();
    refreshTabs();
    if (!options || options.persist !== false) await saveWorkspaceNow();
    return true;
  }

  function hideThread(id) {
    var thread = findThread(id);
    if (!thread || thread.hidden) return false;
    var wasActive = state.activeThreadId === id;
    if (thread.kind === "git") suspendGitRequests();
    thread.metricsGeneration += 1;
    if (thread.metricsRefreshTimer) {
      clearTimeout(thread.metricsRefreshTimer);
      thread.metricsRefreshTimer = 0;
    }
    if (typeof noteStatusActivity === "function") noteStatusActivity();
    var nextThreadId = detachThreadPane(thread);
    thread.hidden = true;
    nextThreadId = resolvePaneFocusSuccessor(
      paneLayoutForThread(thread),
      nextThreadId,
      true
    );
    var focusingNext = false;
    if (wasActive) {
      state.activeThreadId = null;
      if (!retainFileFocusAfterThreadRemoval(id, nextThreadId, thread.projectId) && nextThreadId) {
        focusingNext = true;
        focusThread(nextThreadId);
      }
    }
    if (!focusingNext) {
      if (wasActive) {
        renderPaneWorkspace({ preserveTerminalFocus: false });
      } else {
        renderPaneWorkspace();
      }
    }
    if (thread.kind === "git") stageGitSurface();
    refreshSidebar();
    refreshTabs();
    saveWorkspaceSoon();
    return true;
  }

  function hideFilesPane(filesPane) {
    if (!filesPane || filesPane.hidden) return false;
    var wasFocused = filesPaneHasCanvasFocus(filesPane);
    var nextSurfaceId = detachThreadPane(filesPane);
    filesPane.hidden = true;
    if (wasFocused) state.activeThreadId = null;
    var nextSurface = nextSurfaceId && canvasSurfaceById(nextSurfaceId);
    if (nextSurface && nextSurface.kind === "files") {
      focusCanvasSurface(nextSurface);
    } else if (nextSurface) {
      focusThread(nextSurface.id);
    } else {
      renderPaneWorkspace({ preserveTerminalFocus: false });
    }
    refreshSidebar();
    refreshTabs();
    saveWorkspaceSoon();
    return true;
  }

  function reopenFilesPane(filesPane) {
    if (!filesPane || !filesPane.hidden) return false;
    var project = findProject(filesPane.projectId);
    if (!project || state.activeProjectId !== project.id ||
        activeWorkspaceRoot(project) !== filesPane.workspaceRoot) return false;
    var placement = prepareFilesPanePlacement(filesPane);
    if (!placement) {
      setStatus("Not enough space to reopen the Files pane", "warn");
      return false;
    }
    filesPane.hidden = false;
    commitPanePlacement(placement);
    renderPaneWorkspace({ preserveTerminalFocus: false });
    focusCanvasSurface(filesPane);
    refreshSidebar();
    refreshTabs();
    saveWorkspaceSoon();
    return true;
  }

  function hideCanvasSurface(surface) {
    surface = surface && canvasSurfaceById(surface.id);
    if (!surface) return false;
    if (surface.kind === "files") return hideFilesPane(surface);
    return hideThread(surface.id);
  }

  function reopenThread(id) {
    var thread = findThread(id);
    if (!thread || !thread.hidden) return false;
    var project = findProject(thread.projectId);
    if (state.activeProjectId !== thread.projectId || !project || project.closing ||
        activeWorkspaceRoot(project) !== thread.worktreePath) return false;
    var placement = preparePanePlacement(thread.id, thread.projectId, thread.worktreePath);
    if (!placement) {
      setStatus("Not enough space to reopen this terminal pane", "warn");
      return false;
    }
    if (typeof noteStatusActivity === "function") noteStatusActivity();
    thread.hidden = false;
    commitPanePlacement(placement);
    if (thread.pane && !thread.paneFooter) {
      var staleFooter = thread.pane.querySelector(".terminal-pane-footer");
      if (staleFooter) staleFooter.remove();
      thread.pane.appendChild(createPaneFooter(thread));
    }
    if (thread.kind !== "coven-code" && thread.kind !== "coven-attach") {
      project.lastActiveThreadId = thread.id;
    }
    state.activeThreadId = thread.id;
    renderPaneWorkspace({ preserveTerminalFocus: false });
    if (thread.kind === "git") revealGitPane(thread);
    if (thread.kind === "git") renderGitSurface();
    refreshSidebar();
    saveWorkspaceSoon();
    return true;
  }

  function reopenThreads(projectId, worktreePath) {
    var reopened = 0;
    for (var i = 0; i < state.threads.length; i++) {
      var thread = state.threads[i];
      if (thread.projectId === projectId && thread.worktreePath === worktreePath && thread.hidden) {
        if (!reopenThread(thread.id)) break;
        reopened += 1;
      }
    }
    return reopened;
  }

  async function reopenThreadsForWorkspace(project, worktreePath) {
    if (!(await activateProjectWorktree(project, worktreePath))) return 0;
    var reopened = reopenThreads(project.id, worktreePath);
    if (reopened && state.activeThreadId) await focusThread(state.activeThreadId);
    return reopened;
  }

  function threadIsToolPane(thread) {
    return !!thread && (thread.kind === "git" || thread.kind === "web");
  }

  function duplicateThread(thread) {
    if (!thread || thread.status === "exited" || threadIsToolPane(thread)) return null;
    var project = findProject(thread.projectId);
    var launch = thread.launch;
    if (launch && launch.launchKind === "coven-code") {
      launch = covenCliLaunch(project || { root: launch.projectRoot }, thread.worktreePath || launch.cwd);
      if (!launch) return null;
    }
    return createThread({
      project: project,
      name: thread.name + " copy",
      kind: thread.kind,
      worktreePath: thread.worktreePath,
      launch: launch,
    });
  }

  function sessionCloseLabel(thread) {
    if (thread && thread.kind === "git") return "Close Git pane";
    if (thread && thread.kind === "web") return "Close Web pane";
    if (thread && thread.launch &&
        (thread.launch.launchKind === "coven-recovery" ||
          thread.launch.recoveryRequired === true)) {
      return "Resolve inspected Coven recovery" +
        (thread.name ? " for " + thread.name : "");
    }
    return "Stop and close" + (thread && thread.name ? " " + thread.name : "");
  }

  /** Context actions are capability-based: tool panes never receive PTY actions. */
  function localSessionContextActions(thread, memberships, callbacks) {
    var isTool = threadIsToolPane(thread);
    var resolvesCovenRecovery = thread && thread.launch &&
      (thread.launch.launchKind === "coven-recovery" ||
        thread.launch.recoveryRequired === true);
    var actions = [{ label: "Focus", run: callbacks.focus }];
    if (!isTool && memberships.length) {
      actions.push({
        label: "Show only " + memberships[0].name,
        run: callbacks.showSet,
      });
      actions.push({
        label: "Remove from " + memberships[0].name,
        run: callbacks.removeSet,
      });
    }
    if (!isTool) {
      actions.push({ label: "Rename…", run: callbacks.rename });
      if (thread.status !== "exited" && !resolvesCovenRecovery) {
        actions.push({ label: "Duplicate", run: callbacks.duplicate });
        actions.push({ label: "Interrupt", run: callbacks.interrupt });
      }
    }
    actions.push({ label: "Hide", run: callbacks.hide });
    actions.push({
      label: isTool || resolvesCovenRecovery
        ? sessionCloseLabel(thread)
        : "Stop and close",
      danger: true,
      run: callbacks.close,
    });
    return actions;
  }

  function projectAppearanceContextActions(project, anchor) {
    if (!project) return [];
    var restoreKey = anchor && anchor.dataset
      ? anchor.dataset.treeKey || ""
      : "";
    function restoreProjectFocus() {
      if (!restoreKey) return;
      sessionTreeFocusKey = restoreKey;
      restoreSessionTreeFocus(restoreKey);
    }
    return [{
      label: "Customize appearance",
      run: function () {
        openProjectAppearancePopover(project, anchor);
      },
    }, {
      label: "Close project",
      danger: true,
      run: function () {
        var wasActive = state.activeProjectId === project.id;
        return Promise.resolve(removeProject(project.id)).then(function (closed) {
          if (!closed || !wasActive) restoreProjectFocus();
          return closed;
        }, function (error) {
          restoreProjectFocus();
          throw error;
        });
      },
    }];
  }

  var sessionContextMenu = null;
  var sessionContextMenuRestoreKey = "";
  function closeSessionContextMenu(options) {
    var restoreFocus = !options || options.restoreFocus !== false;
    var restoreKey = sessionContextMenuRestoreKey;
    if (sessionContextMenu && sessionContextMenu.parentNode) {
      sessionContextMenu.parentNode.removeChild(sessionContextMenu);
    }
    sessionContextMenu = null;
    sessionContextMenuRestoreKey = "";
    if (restoreFocus && restoreKey) {
      sessionTreeFocusKey = restoreKey;
      restoreSessionTreeFocus(restoreKey);
    }
  }
  function openSessionContextMenu(event, actions, anchor) {
    event.preventDefault();
    event.stopPropagation();
    closeProjectAppearancePopover({ restoreFocus: false });
    closeSessionContextMenu({ restoreFocus: false });
    var menu = document.createElement("div");
    menu.className = "session-context-menu";
    menu.setAttribute("role", "menu");
    var menuAnchor = anchor || event.currentTarget || event.target || null;
    var usePointerPosition = Number(event.clientX) > 0 && Number(event.clientY) > 0;
    var anchorRect = !usePointerPosition &&
      menuAnchor &&
      typeof menuAnchor.getBoundingClientRect === "function"
      ? menuAnchor.getBoundingClientRect()
      : null;
    menu.style.left = Math.max(8, usePointerPosition
      ? event.clientX
      : anchorRect
        ? anchorRect.left
        : 8) + "px";
    menu.style.top = Math.max(8, usePointerPosition
      ? event.clientY
      : anchorRect
        ? anchorRect.bottom + 6
        : 8) + "px";
    actions.forEach(function (action) {
      if (!action) return;
      var item = document.createElement("button");
      item.type = "button";
      item.className = "session-context-item" + (action.danger ? " danger" : "");
      item.setAttribute("role", "menuitem");
      item.textContent = action.label;
      item.addEventListener("click", function () {
        closeSessionContextMenu({ restoreFocus: false });
        action.run();
      });
      menu.appendChild(item);
    });
    document.body.appendChild(menu);
    sessionContextMenu = menu;
    sessionContextMenuRestoreKey = anchor && anchor.dataset
      ? anchor.dataset.treeKey || ""
      : "";
    var rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) {
      menu.style.left = Math.max(8, window.innerWidth - rect.width - 8) + "px";
    }
    if (rect.bottom > window.innerHeight - 8) {
      menu.style.top = Math.max(8, window.innerHeight - rect.height - 8) + "px";
    }
    var first = menu.querySelector("button");
    if (first) first.focus();
  }
  document.addEventListener("pointerdown", function (event) {
    if (sessionContextMenu && !sessionContextMenu.contains(event.target)) {
      closeSessionContextMenu();
    }
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closeSessionContextMenu();
  });
  document.addEventListener("pointerdown", function (event) {
    if (projectAppearancePopover && !projectAppearancePopover.contains(event.target)) {
      closeProjectAppearancePopover();
    }
  });
  document.addEventListener("keydown", function (event) {
    if (!projectAppearancePopover || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeProjectAppearancePopover();
  });

  function scheduleTerminalPaneFits() {
    state.threads.forEach(function (thread) {
      if (thread.terminalController) thread.terminalController.scheduleFit();
    });
  }
  var pendingPaneDividerFocusId = null;
  function schedulePaneTreeLayout(focusSplitId) {
    pendingPaneDividerFocusId = focusSplitId || null;
    terminalFrameScheduler.schedule("layout:pane-tree", function () {
      var restoreSplitId = pendingPaneDividerFocusId;
      pendingPaneDividerFocusId = null;
      renderPaneWorkspace();
      if (restoreSplitId) focusPaneDivider(restoreSplitId);
      saveWorkspaceSoon();
    });
  }

  var pendingTabScroll = false;
  function scheduleTabMeasurements(scrollActive) {
    pendingTabScroll = pendingTabScroll || Boolean(scrollActive);
    terminalFrameScheduler.schedule("layout:tabs", function () {
      var shouldScroll = pendingTabScroll;
      pendingTabScroll = false;
      syncTabStripOverflow();
      if (shouldScroll) scrollActiveTabIntoView();
    });
  }
  window.addEventListener("resize", function () {
    scheduleTerminalPaneFits();
    scheduleBrowserBounds();
    // Whether the strip overflows is a function of width, not of its contents.
    scheduleTabMeasurements();
    scheduleSidebarLayout();
  });

  // ============================================================
  // 6b. Rename + inline-edit primitive
  // ============================================================

  function renameThread(id, newName) {
    var t = findThread(id);
    if (!t) return false;
    var trimmed = String(newName || "").trim();
    if (!trimmed) return false;
    t.name = trimmed;
    syncThreadPaneMetadata(t);
    saveWorkspaceSoon();
    if (state.activeThreadId === id) {
      setProjectStatus(findProject(t.projectId), statusLevel(t.status));
    }
    return true;
  }
  function renameProject(id, newName) {
    var p = findProject(id);
    if (!p) return false;
    var trimmed = String(newName || "").trim();
    if (!trimmed) return false;
    p.name = trimmed;
    saveWorkspaceSoon();
    return true;
  }

  /**
   * Mount a focused, selected <input> in `el`, or in opts.host while
   * opts.hide is temporarily removed from view and the accessibility tree.
   * Calls onCommit(value) on Enter / blur if the value changed; Escape
   * cancels. Sets editingContext so the surface's refresh loop pauses until
   * the edit settles, then runs `done()` (which usually re-renders).
   */
  function editLabelInline(el, surface, opts) {
    if (!el) return;
    var initial = opts.initial != null ? String(opts.initial) : el.textContent;
    editingContext = { surface: surface, originalText: initial };

    var input = document.createElement("input");
    input.type = "text";
    input.className = "inline-edit";
    input.value = initial;
    input.spellcheck = false;
    input.autocomplete = "off";
    if (opts.ariaLabel) input.setAttribute("aria-label", opts.ariaLabel);

    var hiddenEl = opts.hide || null;
    var hiddenAria = hiddenEl ? hiddenEl.getAttribute("aria-hidden") : null;
    var hiddenTabindex = hiddenEl ? hiddenEl.getAttribute("tabindex") : null;
    if (hiddenEl) {
      hiddenEl.classList.add("inline-edit-hidden");
      hiddenEl.setAttribute("aria-hidden", "true");
      hiddenEl.setAttribute("tabindex", "-1");
    }
    if (opts.host) opts.host.appendChild(input);
    else el.replaceChildren(input);
    // Defer focus by a tick so the dblclick text-selection doesn't override.
    requestAnimationFrame(function () {
      input.focus();
      input.select();
    });

    var settled = false;
    function settle(commit) {
      if (settled) return;
      settled = true;
      var value = input.value;
      editingContext = null;
      if (commit) {
        var changed = value.trim() && value.trim() !== initial;
        if (changed) {
          try { opts.onCommit(value.trim()); } catch (_) {}
        }
      }
      if (hiddenEl) {
        hiddenEl.classList.remove("inline-edit-hidden");
        if (hiddenAria === null) hiddenEl.removeAttribute("aria-hidden");
        else hiddenEl.setAttribute("aria-hidden", hiddenAria);
        if (hiddenTabindex === null) hiddenEl.removeAttribute("tabindex");
        else hiddenEl.setAttribute("tabindex", hiddenTabindex);
      }
      if (opts.host && input.parentNode === opts.host) opts.host.removeChild(input);
      if (typeof opts.done === "function") opts.done();
    }
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { settle(true); e.preventDefault(); }
      else if (e.key === "Escape") { settle(false); e.preventDefault(); }
      e.stopPropagation();
    });
    input.addEventListener("blur", function () { settle(true); });
    // Don't let the dblclick-induced click bubble into row click handlers.
    input.addEventListener("click", function (e) { e.stopPropagation(); });
    input.addEventListener("dblclick", function (e) { e.stopPropagation(); });
  }

  // ============================================================
  // 7. Sidebar render — sidebar removed; this stays as a no-op alias for
  //    refreshTabs so existing callsites (PTY events, rename flows, etc.)
  //    continue to update the surviving project tab strip.
  // ============================================================

  // The fade means "there is more below", so it has to answer whether the list
  // can still scroll down - not merely whether it overflows. Otherwise it keeps
  // promising content after you have already reached the bottom.
  function syncSessionListScroll() {
    if (!sessionListEl) return false;
    var more = sessionListEl.scrollTop + sessionListEl.clientHeight
      < sessionListEl.scrollHeight - 1;
    sessionListEl.classList.toggle("has-more", more);
    return more;
  }

  function createVirtualListSpacer(position, height) {
    var spacer = document.createElement("div");
    spacer.className = "virtual-list-spacer virtual-list-spacer-" + position;
    spacer.style.height = Math.max(0, height || 0) + "px";
    spacer.setAttribute("role", "presentation");
    spacer.setAttribute("aria-hidden", "true");
    return spacer;
  }

  function collectionRowHeight(element, property, fallback) {
    if (!element || typeof getComputedStyle !== "function") return fallback;
    var value = parseFloat(getComputedStyle(element).getPropertyValue(property));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  function sessionVirtualScrollTop(rowHeight) {
    if (!sessionListEl || typeof sessionListEl.getBoundingClientRect !== "function") {
      return sessionListEl ? sessionListEl.scrollTop : 0;
    }
    var listTop = sessionListEl.getBoundingClientRect().top;
    var categories = sessionListEl.querySelectorAll("[data-virtual-row-start]");
    for (var index = 0; index < categories.length; index++) {
      var category = categories[index];
      if (typeof category.getBoundingClientRect !== "function") continue;
      var rect = category.getBoundingClientRect();
      if (rect.bottom <= listTop) continue;
      var start = Number(category.dataset.virtualRowStart) || 0;
      var count = Number(category.dataset.virtualRowCount) || 0;
      var labelHeight = category.firstElementChild
        ? category.firstElementChild.offsetHeight || 0
        : 0;
      var withinRows = Math.max(0, listTop - rect.top - labelHeight);
      return start * rowHeight + Math.min(count * rowHeight, withinRows);
    }
    return sessionListEl.scrollTop;
  }

  function sessionOuterScrollTopForRow(rowIndex, rowHeight) {
    if (!sessionListEl || typeof sessionListEl.getBoundingClientRect !== "function") {
      return rowIndex * rowHeight;
    }
    var listTop = sessionListEl.getBoundingClientRect().top;
    var categories = sessionListEl.querySelectorAll("[data-virtual-row-start]");
    for (var index = 0; index < categories.length; index++) {
      var category = categories[index];
      var start = Number(category.dataset.virtualRowStart) || 0;
      var count = Number(category.dataset.virtualRowCount) || 0;
      if (rowIndex < start || rowIndex >= start + count ||
          typeof category.getBoundingClientRect !== "function") continue;
      var categoryTop = sessionListEl.scrollTop +
        category.getBoundingClientRect().top - listTop;
      var labelHeight = category.firstElementChild
        ? category.firstElementChild.offsetHeight || 0
        : 0;
      return Math.max(0, categoryTop + labelHeight + (rowIndex - start) * rowHeight);
    }
    return rowIndex * rowHeight;
  }

  function refreshSidebar() {
    refreshTabs();
    renderSessionList();
    renderPaneWorkspace();
    syncComposerChrome();
    syncDaemonStatus();
    syncSessionListScroll();
  }

  // ============================================================
  // 7b. Sessions sidebar
  // ============================================================

  // Local rows remain backed by state.threads, the same source used by the tab
  // strip and terminal host.

  var themeSelectEl = document.getElementById("theme-select");
  var solidBgEl = document.getElementById("solid-bg");
  var bgOpacityInput = document.getElementById("bg-opacity");
  var bgOpacityValueEl = document.getElementById("bg-opacity-value");
  var sidebarSessionControlsEl = document.getElementById("sidebar-session-controls");
  var sessionListEl = document.getElementById("session-list");
  var sidebarFilesEl = document.getElementById("sidebar-files");
  if (sessionListEl) {
    sessionListEl.__psycheVirtualRuntime = ptyRuntime;
    sessionListEl.addEventListener("scroll", function () {
      syncSessionListScroll();
      if (!sessionListEl.__psycheVirtualState ||
          !sessionListEl.__psycheVirtualState.virtualized) return;
      var focusedSessionControl = sessionListEl.contains(document.activeElement) &&
        document.activeElement.dataset
        ? document.activeElement.dataset
        : null;
      var sessionScrollFocusKey = focusedSessionControl
        ? focusedSessionControl.treeKey || ""
        : "";
      var sessionScrollProjectFilesId = focusedSessionControl
        ? focusedSessionControl.projectFiles || ""
        : "";
      terminalFrameScheduler.schedule("collection:sessions", function () {
        renderSessionList({
          preserveFocus: false,
          restoreFocusKey: sessionScrollFocusKey,
          restoreProjectFilesId: sessionScrollProjectFilesId,
        });
      });
    });
  }
  var sidebarView = "sessions";
  var sidebarFilesReturnProjectId = null;

  // The file tree renders lazily: switching to it is the only thing that has to
  // ask the filesystem, and the sessions rail should not pay for that.
  function setSidebarView(name) {
    var enteringFiles = sidebarView !== "files" && name === "files";
    sidebarView = name === "files" ? "files" : "sessions";
    var showingFiles = sidebarView === "files";
    if (sidebarSessionControlsEl) sidebarSessionControlsEl.hidden = showingFiles;
    if (sessionListEl) sessionListEl.hidden = showingFiles;
    if (sidebarFilesEl) sidebarFilesEl.hidden = !showingFiles;
    if (showingFiles) {
      closeNewPaneMenu();
      if (enteringFiles) {
        var focusFilesControl = function () {
          if (sidebarFilesEl && sidebarFilesEl.hidden) return false;
          var back = document.getElementById("files-back");
          if (back && !back.hidden && typeof back.focus === "function") {
            back.focus();
            if (document.activeElement === back) return true;
          }
          var refresh = document.getElementById("files-refresh");
          if (refresh && !refresh.hidden && typeof refresh.focus === "function") {
            refresh.focus();
            if (document.activeElement === refresh) return true;
          }
          return false;
        };
        if (!focusFilesControl() && typeof requestAnimationFrame === "function") {
          requestAnimationFrame(function () {
            focusFilesControl();
          });
        }
        syncFilesPanelScope();
      }
    }
    return sidebarView;
  }

  async function showProjectFiles(projectId) {
    var project = findProject(projectId);
    if (!project) return false;
    var refreshingCurrentScope = sidebarView === "files" &&
      state.activeProjectId === project.id;
    if (!(await setActiveProject(projectId))) return false;
    project = findProject(projectId);
    if (!project || state.activeProjectId !== project.id) return false;
    sidebarFilesReturnProjectId = project.id;
    setSidebarView("files");
    if (refreshingCurrentScope) syncFilesPanelScope();
    return true;
  }

  function showSessionsSidebar() {
    invalidateFilesPanelRender();
    var restoreProjectId = sidebarFilesReturnProjectId;
    sidebarFilesReturnProjectId = null;
    setSidebarView("sessions");
    renderSessionList({ preserveFocus: false });
    requestAnimationFrame(function () {
      var buttons = sessionListEl ? sessionListEl.querySelectorAll("[data-project-files]") : [];
      var target = Array.prototype.find.call(buttons, function (button) {
        return button.dataset.projectFiles === restoreProjectId;
      });
      if (target) target.focus();
      else if (!restoreSessionTreeFocus("")) {
        var trigger = document.getElementById("rail-new-tab");
        if (trigger && typeof trigger.focus === "function") trigger.focus();
      }
    });
    return true;
  }

  // The git panel uses the same segmented switch as the sidebar: Changes is the
  // working tree and its diffs, Commit is the branch state and history. Two
  // rails, one control to learn.
  var gitTab = "changes";
  function setGitTab(name) {
    gitTab = name === "commit" ? "commit" : "changes";
    var changes = document.getElementById("git-tab-changes");
    var commit = document.getElementById("git-tab-commit");
    if (changes) changes.hidden = gitTab !== "changes";
    if (commit) commit.hidden = gitTab !== "commit";
    Array.prototype.forEach.call(
      document.querySelectorAll("[data-git-tab]"),
      function (btn) {
        var active = btn.dataset.gitTab === gitTab;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-selected", active ? "true" : "false");
      }
    );
    return gitTab;
  }

  Array.prototype.forEach.call(
    document.querySelectorAll("[data-git-tab]"),
    function (btn) {
      btn.addEventListener("click", function () { setGitTab(btn.dataset.gitTab); });
    }
  );
  var sessionTypeFilter = settings.sessionFilter;
  var sessionTreeFocusKey = "";

  function setSessionTypeFilter(value, options) {
    sessionTypeFilter = PsycheSessions.normalizeSidebarFilter(value);
    settings.sessionFilter = sessionTypeFilter;
    if (!options || options.persist !== false) saveSettings();
    Array.prototype.forEach.call(
      document.querySelectorAll("[data-session-filter]"),
      function (button) {
        var active = button.dataset.sessionFilter === sessionTypeFilter;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      }
    );
    renderSessionList();
  }

  // ~/Documents/GitHub/OpenCoven/coven-cave → ~/…/OpenCoven/coven-cave
  function shortenRoot(root) {
    if (!root) return "";
    var home = (state.env && state.env.home) || "";
    var path = home && root.indexOf(home) === 0 ? "~" + root.slice(home.length) : root;
    var parts = path.split("/").filter(Boolean);
    if (path.length <= 32 || parts.length <= 3) return path;
    var head = path.charAt(0) === "~" ? "~/" : "/";
    return head + "…/" + parts.slice(-2).join("/");
  }

  /** Thread ids that currently own a leaf in the active worktree's pane tree. */
  function canvasThreadIds() {
    var layout = activePaneLayout();
    if (!layout || !layout.root) return [];
    return PsychePanes.leafIds(layout.root).map(function (leafId) {
      var leaf = PsychePanes.findLeafById(layout.root, leafId);
      return leaf ? leaf.threadId : null;
    }).filter(function (id) {
      return !!id && !!findThread(id);
    });
  }

  function effectiveCanvasThreadIds() {
    var layout = activePaneLayout();
    var root = effectivePaneRoot(layout);
    if (!root) return [];
    return PsychePanes.leafIds(root).map(function (leafId) {
      var leaf = PsychePanes.findLeafById(root, leafId);
      return leaf ? leaf.threadId : null;
    }).filter(Boolean);
  }

  function threadWantsMetrics(thread) {
    return !document.hidden
      && terminalHost
      && terminalHost.isConnected
      && !terminalHost.hidden
      && isLiveThread(thread)
      && !thread.hidden
      && thread.status !== "exited"
      && thread.launch
      && thread.launch.launchKind === "coven-code"
      && thread.pane
      && thread.pane.isConnected
      && terminalHost.contains(thread.pane)
      && effectiveCanvasThreadIds().indexOf(thread.id) !== -1
      && Boolean(thread.launch.covenSessionId);
  }

  function loadingPaneMetrics(launch) {
    return {
      phase: "loading",
      provider: launch && launch.metricsProvider || "coven",
      sessionId: launch && launch.covenSessionId || null,
      model: null,
      contextUsed: null,
      contextLimit: null,
      cumulativeInputTokens: null,
      cumulativeOutputTokens: null,
      cacheCreationTokens: null,
      cacheReadTokens: null,
      spendUsd: null,
      costKind: "unknown",
      updatedAt: null,
      stale: false,
      error: null,
      canSwitchModel: false,
    };
  }

  function metricsValue(previous, key) {
    return previous && previous[key] !== undefined ? previous[key] : null;
  }

  function metricsErrorState(thread, error) {
    var previous = thread.metrics;
    return {
      phase: "error",
      provider: previous && previous.provider ||
        thread.launch && thread.launch.metricsProvider || "coven",
      sessionId: thread.launch && thread.launch.covenSessionId || null,
      model: metricsValue(previous, "model"),
      contextUsed: metricsValue(previous, "contextUsed"),
      contextLimit: metricsValue(previous, "contextLimit"),
      cumulativeInputTokens: metricsValue(previous, "cumulativeInputTokens"),
      cumulativeOutputTokens: metricsValue(previous, "cumulativeOutputTokens"),
      cacheCreationTokens: metricsValue(previous, "cacheCreationTokens"),
      cacheReadTokens: metricsValue(previous, "cacheReadTokens"),
      spendUsd: metricsValue(previous, "spendUsd"),
      costKind: previous && previous.costKind || "unknown",
      updatedAt: metricsValue(previous, "updatedAt"),
      stale: Boolean(previous && (previous.phase === "ready" || previous.stale)),
      error: String(error),
      canSwitchModel: false,
    };
  }

  async function refreshPaneMetrics(thread) {
    if (!threadWantsMetrics(thread)) return false;
    thread.metricsGeneration += 1;
    var generation = thread.metricsGeneration;
    var sessionId = thread.launch.covenSessionId;
    if (!thread.metrics || thread.metrics.phase === "idle") {
      thread.metrics = loadingPaneMetrics(thread.launch);
      syncPaneFooter(thread);
    }
    try {
      var metrics = await invoke("pane_session_metrics", {
        projectRoot: thread.launch.projectRoot,
        project_root: thread.launch.projectRoot,
        cwd: thread.worktreePath,
        sessionId: sessionId,
        session_id: sessionId,
      });
      var response = {
        threadId: thread.id,
        generation: generation,
        sessionId: metrics.sessionId,
      };
      if (!threadWantsMetrics(thread) ||
          !PsychePanes.shouldApplyMetricsResponse(thread, response)) return false;
      thread.metrics = {
        phase: "ready",
        provider: metrics.provider || "coven",
        sessionId: metrics.sessionId,
        model: metrics.model,
        contextUsed: metrics.contextUsed,
        contextLimit: metrics.contextLimit,
        cumulativeInputTokens: metrics.cumulativeInputTokens,
        cumulativeOutputTokens: metrics.cumulativeOutputTokens,
        cacheCreationTokens: metrics.cacheCreationTokens,
        cacheReadTokens: metrics.cacheReadTokens,
        spendUsd: metrics.spendUsd,
        costKind: metrics.costKind || "unknown",
        updatedAt: metrics.updatedAt,
        stale: false,
        error: null,
        canSwitchModel: false,
      };
      syncPaneFooter(thread);
      return true;
    } catch (error) {
      if (thread.metricsGeneration !== generation ||
          !threadWantsMetrics(thread) ||
          thread.launch.covenSessionId !== sessionId) return false;
      thread.metrics = metricsErrorState(thread, error);
      syncPaneFooter(thread);
      return false;
    }
  }

  function schedulePaneMetricsRefresh(thread, delay) {
    if (!thread) return;
    if (thread.metricsRefreshTimer) clearTimeout(thread.metricsRefreshTimer);
    thread.metricsRefreshTimer = 0;
    if (!threadWantsMetrics(thread)) return;
    thread.metricsRefreshTimer = setTimeout(function () {
      thread.metricsRefreshTimer = 0;
      if (threadWantsMetrics(thread)) refreshPaneMetrics(thread);
    }, delay);
  }

  function refreshVisiblePaneMetrics() {
    state.threads.forEach(function (thread) {
      if (threadWantsMetrics(thread)) refreshPaneMetrics(thread);
    });
  }

  function syncPaneMetricsVisibility() {
    if (document.hidden || !terminalHost ||
        !terminalHost.isConnected || terminalHost.hidden) {
      state.threads.forEach(function (thread) {
        thread.metricsGeneration = (thread.metricsGeneration || 0) + 1;
        if (thread.metricsRefreshTimer) {
          clearTimeout(thread.metricsRefreshTimer);
          thread.metricsRefreshTimer = 0;
        }
      });
      return false;
    }
    refreshVisiblePaneMetrics();
    return true;
  }

  /** Sidebar and menu glyph for a pane kind. */
  function paneGlyphFor(kind) {
    if (kind === "shell") return "❯_";
    if (kind === "web") return "◍";
    return "✳";
  }

  /** Meta line's second half: the branch if there is one, else the path. */
  function sessionLaneLabel(worktree) {
    if (!worktree) return "";
    return worktree.branch || shortenRoot(worktree.path);
  }

  /**
   * The same lane label from a thread, so a pane header and its sidebar row
   * never disagree about which lane the pane is in.
   */
  function threadLaneLabel(thread) {
    var path = (thread && thread.worktreePath) || "";
    var project = thread && findProject(thread.projectId);
    var worktrees = (project && project.worktrees) || [];
    for (var i = 0; i < worktrees.length; i++) {
      if (worktrees[i].path === path) return sessionLaneLabel(worktrees[i]);
    }
    return shortenRoot(path);
  }

  function threadWorktree(thread) {
    var project = thread && findProject(thread.projectId);
    var worktrees = (project && project.worktrees) || [];
    var exact = worktrees.find(function (worktree) {
      return worktree.path === thread.worktreePath;
    });
    if (exact) return exact;
    return {
      path: thread.worktreePath || null,
      branch: null,
    };
  }

  function paneFooterState(thread) {
    var worktree = threadWorktree(thread);
    var isAgent = PsychePanes.isAgentPaneKind(thread.kind);
    var metrics = thread.metrics || null;
    var isEligibleCoven = thread.launch
      && thread.launch.launchKind === "coven-code"
      && Boolean(thread.launch.covenSessionId);
    if (isEligibleCoven && !metrics) {
      metrics = loadingPaneMetrics(thread.launch);
    } else if (isAgent && !metrics) {
      metrics = {
        phase: "ready",
        provider: thread.launch && thread.launch.metricsProvider || "agent",
        sessionId: thread.launch && thread.launch.covenSessionId || null,
        model: null,
        contextUsed: null,
        contextLimit: null,
        spendUsd: null,
        tokens: null,
        costKind: "unknown",
        updatedAt: null,
        stale: false,
        error: "Session metrics are not reported by this harness",
        canSwitchModel: false,
      };
    }
    return {
      kind: thread.kind || "shell",
      branch: worktree.branch || null,
      worktreeLabel: shortenRoot(worktree.path || thread.worktreePath || ""),
      worktreePath: worktree.path || null,
      paneId: thread.id,
      metrics: metrics,
    };
  }

  function closePaneFooterPopovers(restoreFocus) {
    var trigger = paneFooterPopoverTrigger;
    if (paneFooterPopoverCleanup) paneFooterPopoverCleanup();
    paneFooterPopoverCleanup = null;
    if (paneFooterPopover && paneFooterPopover.remove) paneFooterPopover.remove();
    paneFooterPopover = null;
    paneFooterPopoverOwner = null;
    paneFooterPopoverTrigger = null;
    paneFooterPopoverThreadId = null;
    state.threads.forEach(function (thread) {
      closePaneFooterMenu(thread, false);
    });
    Array.prototype.forEach.call(
      document.querySelectorAll(".pane-footer-popover"),
      function (popover) { popover.remove(); }
    );
    if (restoreFocus && trigger && trigger.focus &&
        (trigger.isConnected === undefined || trigger.isConnected)) {
      trigger.focus();
    }
  }

  function closePaneUsagePopoverForFooter(thread, restoreFocus) {
    if (!thread ||
        paneFooterPopoverThreadId !== thread.id ||
        paneFooterPopoverOwner !== thread.paneFooter) return false;
    closePaneFooterPopovers(restoreFocus);
    return true;
  }

  function paneUsageRow(label, value) {
    var row = document.createElement("div");
    row.className = "pane-usage-row";
    var key = document.createElement("span");
    key.textContent = label;
    var detail = document.createElement("strong");
    detail.textContent = value;
    row.appendChild(key);
    row.appendChild(detail);
    return row;
  }

  function positionPaneFooterPopover(popover, anchor) {
    document.body.appendChild(popover);
    var margin = 8;
    var gap = 6;
    var anchorRect = anchor.getBoundingClientRect();
    var maxWidth = Math.max(0, Math.min(320, window.innerWidth - 16));
    popover.style.maxWidth = maxWidth + "px";
    var viewportMaxHeight = Math.max(0, window.innerHeight - margin * 2);
    popover.style.maxHeight = viewportMaxHeight + "px";
    var popoverRect = popover.getBoundingClientRect();
    var spaceAbove = Math.max(0, anchorRect.top - gap - margin);
    var spaceBelow = Math.max(
      0,
      window.innerHeight - anchorRect.bottom - gap - margin
    );
    var placeAbove = popoverRect.height <= spaceAbove ||
      spaceAbove >= spaceBelow;
    var availableHeight = placeAbove ? spaceAbove : spaceBelow;
    popover.style.maxHeight = Math.min(
      viewportMaxHeight,
      availableHeight
    ) + "px";
    popoverRect = popover.getBoundingClientRect();
    popover.style.left = Math.max(margin, Math.min(
      window.innerWidth - popoverRect.width - margin,
      anchorRect.right - popoverRect.width
    )) + "px";
    var preferredTop = placeAbove
      ? anchorRect.top - popoverRect.height - gap
      : anchorRect.bottom + gap;
    popover.style.top = Math.max(margin, Math.min(
      window.innerHeight - popoverRect.height - margin,
      preferredTop
    )) + "px";
  }

  function openPaneUsagePopover(thread, trigger) {
    closePaneFooterPopovers(false);
    var metrics = paneFooterState(thread).metrics || {};
    var notReported = "Not reported by Coven";
    var popover = document.createElement("div");
    popover.className = "pane-footer-popover pane-usage-popover";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", thread.name + " session usage");
    popover.setAttribute("tabindex", "-1");
    popover.appendChild(paneUsageRow("Provider", "Coven"));
    popover.appendChild(paneUsageRow("Model", metrics.model || notReported));
    popover.appendChild(paneUsageRow(
      "Session",
      metrics.sessionId || "Not available"
    ));
    popover.appendChild(paneUsageRow(
      "Context",
      Number.isFinite(metrics.contextUsed) && Number.isFinite(metrics.contextLimit)
        ? metrics.contextUsed + " / " + metrics.contextLimit + " tokens"
        : notReported
    ));
    popover.appendChild(paneUsageRow(
      "Input tokens",
      Number.isFinite(metrics.cumulativeInputTokens)
        ? String(metrics.cumulativeInputTokens)
        : "Not available"
    ));
    popover.appendChild(paneUsageRow(
      "Output tokens",
      Number.isFinite(metrics.cumulativeOutputTokens)
        ? String(metrics.cumulativeOutputTokens)
        : "Not available"
    ));
    var spend = notReported;
    if (Number.isFinite(metrics.spendUsd)) {
      spend = "$" + metrics.spendUsd.toFixed(4);
      if (metrics.costKind === "local-estimate") spend += " · Local estimate";
    }
    popover.appendChild(paneUsageRow("Spend", spend));
    popover.appendChild(paneUsageRow(
      "Updated",
      metrics.updatedAt ||
        (metrics.phase === "loading" ? "Loading…" : "Not available")
    ));
    if (metrics.stale) popover.appendChild(paneUsageRow("State", "Stale"));
    if (metrics.error) popover.appendChild(paneUsageRow("Error", metrics.error));
    paneFooterPopover = popover;
    paneFooterPopoverOwner = thread.paneFooter;
    paneFooterPopoverTrigger = trigger || null;
    paneFooterPopoverThreadId = thread.id;
    positionPaneFooterPopover(popover, trigger || thread.paneFooter);

    function onUsageKeyDown(event) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closePaneFooterPopovers(true);
    }
    document.addEventListener("keydown", onUsageKeyDown, true);
    paneFooterPopoverCleanup = function () {
      document.removeEventListener("keydown", onUsageKeyDown, true);
    };
    popover.focus();
    return popover;
  }

  function paneFooterActionValue(item) {
    return item && typeof item.fullValue === "string" ? item.fullValue : "";
  }

  function paneFooterItemDescription(item) {
    if (!item) return "";
    var value = item.a11yValue || paneFooterActionValue(item) || item.value || "not reported";
    return item.label + ": " + value;
  }

  function runPaneFooterAction(thread, item, trigger) {
    if (!item) return false;
    if (item.action === "copy") {
      return copyPaneFooterValue(item.label, paneFooterActionValue(item));
    }
    if (item.action === "reveal") {
      return revealPaneWorktree(paneFooterActionValue(item));
    }
    if (item.action === "usage") {
      openPaneUsagePopover(thread, trigger);
      return true;
    }
    if (item.action === "model-details") {
      toast(item.label + " is not reported");
      return false;
    }
    if (item.action === "switch-model") {
      toast(item.label + " is not reported");
      return false;
    }
    toast(item.label + " is not reported");
    return false;
  }

  function handlePaneFooterPointerDown(thread, event) {
    var target = event.target;
    if (target && target.closest && target.closest("button")) {
      event.stopPropagation();
      return;
    }
    if (state.activeThreadId !== thread.id) focusThread(thread.id);
    event.stopPropagation();
  }

  function focusPaneAfterFooterAction(thread) {
    if (!thread || state.activeThreadId === thread.id) return;
    requestAnimationFrame(function () {
      if (state.activeThreadId !== thread.id) focusThread(thread.id);
    });
  }

  function handlePaneFooterItemClick(thread, item, event, fromOverflowMenu) {
    event.stopPropagation();
    var trigger = fromOverflowMenu
      ? (thread.paneFooterMenuTrigger || thread.paneFooterOverflow)
      : event.currentTarget;
    var result = runPaneFooterAction(thread, item, trigger);
    if (item && item.action === "usage") return result;
    closePaneFooterMenu(thread, Boolean(fromOverflowMenu));
    focusPaneAfterFooterAction(thread);
    return result;
  }

  function closePaneFooterMenu(thread, restoreFocus) {
    if (!thread) return;
    var trigger = thread.paneFooterMenuTrigger || thread.paneFooterOverflow;
    if (thread.paneFooterMenuCleanup) {
      thread.paneFooterMenuCleanup();
      thread.paneFooterMenuCleanup = null;
    }
    if (thread.paneFooterMenu && thread.paneFooterMenu.parentNode) {
      thread.paneFooterMenu.parentNode.removeChild(thread.paneFooterMenu);
    }
    thread.paneFooterMenu = null;
    thread.paneFooterMenuTrigger = null;
    if (thread.paneFooterOverflow) {
      thread.paneFooterOverflow.setAttribute("aria-expanded", "false");
    }
    if (restoreFocus && trigger && trigger.focus &&
        (trigger.isConnected === undefined || trigger.isConnected)) {
      trigger.focus();
    }
  }

  function paneFooterMenuItems(menu) {
    if (!menu || !menu.querySelectorAll) return [];
    return Array.prototype.filter.call(
      menu.querySelectorAll('[role="menuitem"]'),
      function (button) {
        return !button.disabled;
      }
    );
  }

  function movePaneFooterMenuFocus(menu, key) {
    var buttons = paneFooterMenuItems(menu);
    if (!buttons.length) return false;
    var current = document.activeElement;
    var currentIndex = buttons.indexOf(current);
    var nextIndex = 0;
    if (key === "Home") {
      nextIndex = 0;
    } else if (key === "End") {
      nextIndex = buttons.length - 1;
    } else if (key === "ArrowUp") {
      nextIndex = currentIndex === -1
        ? buttons.length - 1
        : (currentIndex + buttons.length - 1) % buttons.length;
    } else if (key === "ArrowDown") {
      nextIndex = currentIndex === -1
        ? 0
        : (currentIndex + 1) % buttons.length;
    } else {
      return false;
    }
    buttons[nextIndex].focus();
    return true;
  }

  function handlePaneFooterMenuKeyDown(thread, menu, event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePaneFooterMenu(thread, true);
      return true;
    }
    if (!movePaneFooterMenuFocus(menu, event.key)) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function createPaneFooter(thread) {
    var footer = document.createElement("footer");
    footer.className = "terminal-pane-footer";
    footer.setAttribute("aria-label", "Pane details");
    footer.dataset.tier = PsychePanes.footerTier(0);

    var itemsHost = document.createElement("div");
    itemsHost.className = "terminal-pane-footer-items";
    var overflow = document.createElement("button");
    overflow.type = "button";
    overflow.className = "terminal-pane-footer-overflow";
    overflow.textContent = "\u2026";
    overflow.title = "More pane details";
    overflow.setAttribute("aria-label", "More pane details");
    overflow.setAttribute("aria-haspopup", "menu");
    overflow.setAttribute("aria-expanded", "false");
    overflow.hidden = true;

    thread.createPaneFooterButton = function (item, role) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = role === "menuitem"
        ? "pane-footer-menu-item"
        : "terminal-pane-footer-item";
      button.dataset.footerKey = item.key;
      var description = paneFooterItemDescription(item);
      button.title = description;
      button.setAttribute("aria-label", description);
      if (role) button.setAttribute("role", role);
      var label = document.createElement("span");
      label.className = "pane-footer-item-label";
      label.textContent = item.label;
      var value = document.createElement("span");
      value.className = "pane-footer-item-value";
      value.textContent = item.value;
      button.appendChild(label);
      button.appendChild(value);
      button.addEventListener("click", function (event) {
        handlePaneFooterItemClick(thread, item, event, role === "menuitem");
      });
      return button;
    };

    footer.addEventListener("pointerdown", function (event) {
      handlePaneFooterPointerDown(thread, event);
    });
    overflow.addEventListener("click", function (event) {
      event.stopPropagation();
      syncPaneFooter(thread, true, event.currentTarget);
    });
    footer.appendChild(itemsHost);
    footer.appendChild(overflow);

    thread.paneFooter = footer;
    thread.paneFooterItems = itemsHost;
    thread.paneFooterOverflow = overflow;
    var observer = null;
    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver(function (entries) {
        var width = entries[0] && entries[0].contentRect
          ? entries[0].contentRect.width
          : footer.getBoundingClientRect().width;
        footer.dataset.tier = PsychePanes.footerTier(width);
        syncPaneFooter(thread);
      });
      observer.observe(thread.pane || footer);
    }
    thread.paneFooterObserver = observer;
    syncPaneFooter(thread);
    return footer;
  }

  function syncPaneFooter(thread) {
    if (!thread || !thread.paneFooter || !thread.paneFooterItems) return;
    var openOverflow = arguments[1];
    var overflowTrigger = arguments[2] || thread.paneFooterOverflow;
    closePaneUsagePopoverForFooter(thread, false);
    var items = PsychePanes.footerItems(paneFooterState(thread));
    var currentTier = thread.paneFooter.dataset.tier ||
      PsychePanes.footerTier(thread.paneFooter.getBoundingClientRect().width);
    var isAgentPaneKind = PsychePanes.isAgentPaneKind(thread.kind);
    var hiddenKeys = PsychePanes.hiddenFooterKeys(currentTier, isAgentPaneKind);
    var hiddenItems = items.filter(function (item) {
      return hiddenKeys.indexOf(item.key) !== -1;
    });

    thread.paneFooterItems.innerHTML = "";
    items.forEach(function (item) {
      thread.paneFooterItems.appendChild(thread.createPaneFooterButton(item));
    });
    thread.paneFooterOverflow.hidden = hiddenItems.length === 0;

    closePaneFooterMenu(thread, false);
    if (!openOverflow || hiddenItems.length === 0) return;

    closePaneFooterPopovers(false);
    var menu = document.createElement("div");
    menu.className = "pane-footer-popover pane-footer-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Hidden pane details");
    hiddenItems.forEach(function (item) {
      var button = thread.createPaneFooterButton(item, "menuitem");
      button.setAttribute("role", "menuitem");
      menu.appendChild(button);
    });
    thread.paneFooterMenu = menu;
    thread.paneFooterMenuTrigger = overflowTrigger;
    thread.paneFooterOverflow.setAttribute("aria-expanded", "true");
    positionPaneFooterPopover(menu, overflowTrigger);

    function onOutsidePointerDown(event) {
      if (menu.contains(event.target) || overflowTrigger.contains(event.target)) return;
      closePaneFooterMenu(thread, false);
    }
    function onMenuKeyDown(event) {
      handlePaneFooterMenuKeyDown(thread, menu, event);
    }
    document.addEventListener("pointerdown", onOutsidePointerDown, true);
    document.addEventListener("keydown", onMenuKeyDown, true);
    thread.paneFooterMenuCleanup = function () {
      document.removeEventListener("pointerdown", onOutsidePointerDown, true);
      document.removeEventListener("keydown", onMenuKeyDown, true);
    };
    var first = paneFooterMenuItems(menu)[0];
    if (first) first.focus();
  }

  function handlePaneFooterPopoverPointerDown(event) {
    if (!paneFooterPopover) return;
    var target = event.target;
    if (target && paneFooterPopover.contains(target)) return;
    if (target && paneFooterPopoverTrigger &&
        paneFooterPopoverTrigger.contains(target)) return;
    closePaneFooterPopovers(false);
  }
  document.addEventListener("pointerdown", handlePaneFooterPopoverPointerDown, true);

  /**
   * Focus-set membership swatches. Squares, in the set's colour, so they can't
   * be read as a status light. A pane in no set renders nothing.
   */
  function sessionSetSwatches(thread) {
    var sets = setsForThread(thread);
    if (!sets.length) return "";
    return '<span class="session-sets">' + sets.map(function (set) {
      var index = Math.min(4, Math.max(1, Number(set.index) || 1));
      var name = "In " + (set.name || "a focus set");
      return '<span class="session-set-swatch" data-set="' + index +
        '" title="' + escapeHtml(name) + '" aria-label="' + escapeHtml(name) + '"></span>';
    }).join("") + "</span>";
  }

  var SESSION_CLOSE_SECONDS = 3;
  /** The armed row's teardown, so a second row disarms the first. */
  var armedSessionClose = null;

  function disarmSessionClose(options) {
    if (!armedSessionClose) return;
    var armed = armedSessionClose;
    var confirmOwnedFocus = document.activeElement === armed.confirm;
    armedSessionClose = null;
    clearInterval(armed.timer);
    armed.confirm.remove();
    if (armed.close.isConnected) armed.close.hidden = false;
    if ((!options || options.restoreFocus !== false) && confirmOwnedFocus &&
        armed.host.isConnected) {
      if (armed.host.dataset && armed.host.dataset.treeItem) {
        focusSessionTreeItem(armed.host);
      } else {
        armed.host.focus();
      }
    }
  }

  /**
   * Closing a pane stops a process, so it never happens on a single click. The
   * × swaps for a countdown pill that has to be clicked again, and that cancels
   * itself when the timer runs out — the guard costs nothing if you meant it
   * and everything if you didn't.
   */
  function requestThreadClose(thread) {
    if (!thread) return Promise.resolve(false);
    if (thread.kind === "web") return closeBrowserPane(thread);
    return Promise.resolve(closeThread(thread.id));
  }

  async function resolveCovenLaunchRecovery(thread) {
    if (!isLiveThread(thread) || !thread.launch ||
        (thread.launch.launchKind !== "coven-recovery" &&
          thread.launch.recoveryRequired !== true)) {
      return false;
    }
    if (thread.covenLaunchOutcomeInFlight ||
        thread.covenLaunchAcceptanceInFlight ||
        thread.retryInFlight) {
      setStatus(
        thread.name + " Coven launch is still settling; wait before resolving recovery",
        "warn"
      );
      return false;
    }
    var closed = await closeThread(thread.id, { protectCovenRecovery: false });
    if (closed) {
      setStatus(
        thread.name + " Coven recovery marked resolved after confirmed inspection",
        "ok"
      );
    }
    return closed;
  }

  function armSessionClose(host, close, label, onConfirm, actionLabel) {
    disarmSessionClose();
    var expiresAt = Date.now() + SESSION_CLOSE_SECONDS * 1000;
    var action = actionLabel || "Close";
    var confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "session-close-confirm";
    confirm.title = "Click to confirm — auto-cancels when the timer runs out";
    function paint() {
      var left = Math.ceil(Math.max(0, expiresAt - Date.now()) / 1000);
      confirm.textContent = action + " · " + left;
      confirm.setAttribute(
        "aria-label",
        "Confirm " + (action === "Close" ? "closing" : action.toLowerCase()) + " " + label
      );
    }
    paint();
    confirm.addEventListener("click", async function (event) {
      event.stopPropagation();
      if (Date.now() >= expiresAt) {
        disarmSessionClose();
        return;
      }
      var confirmOwnedFocus = document.activeElement === confirm;
      var treeKey = host.dataset.treeKey || "";
      disarmSessionClose({ restoreFocus: false });
      function restoreFocusIfNeeded() {
        var active = document.activeElement;
        if (active && active !== document.body) return;
        var items = sessionListEl.querySelectorAll("[data-tree-item]");
        for (var i = 0; i < items.length; i++) {
          if (items[i].dataset.treeKey === treeKey && items[i].isConnected) {
            focusSessionTreeItem(items[i]);
            return;
          }
        }
      }
      function reportCloseFailure(error) {
        var detail = error && error.message ? ": " + error.message : "";
        setStatus("Failed to close " + label + detail, "error");
      }
      var result;
      try {
        result = onConfirm();
      } catch (err) {
        reportCloseFailure(err);
        if (confirmOwnedFocus) restoreFocusIfNeeded();
        return;
      }
      if (!confirmOwnedFocus || !result || typeof result.then !== "function") return;
      Promise.resolve(result).then(function (succeeded) {
        if (succeeded === false) restoreFocusIfNeeded();
      }, function (error) {
        reportCloseFailure(error);
        restoreFocusIfNeeded();
      });
    });
    close.hidden = true;
    host.appendChild(confirm);
    var timer = setInterval(function () {
      if (Date.now() >= expiresAt) { disarmSessionClose(); return; }
      paint();
    }, 1000);
    armedSessionClose = {
      timer: timer,
      confirm: confirm,
      close: close,
      host: host,
      treeKey: host.dataset.treeKey || "",
      expiresAt: expiresAt,
    };
    confirm.focus();
  }

  function sessionStatusClass(thread) {
    if (thread.spawning || thread.status === "starting") return "starting";
    if (thread.status === "running") return "running";
    if (thread.status === "exited") return "exited";
    return "";
  }

  function covenAttachKey(project, session) {
    return project.root + "\n" + session.id;
  }

  function waitForTerminalLayout() {
    return new Promise(function (resolve) { requestAnimationFrame(resolve); });
  }

  function isReusableCovenAttachment(thread, project, session, threadId) {
    return !!thread
      && (!threadId || thread.id === threadId)
      && thread.projectId === project.id
      && threadCovenSessionId(thread) === session.id
      && (thread.status === "starting" || thread.status === "running")
      && !thread.closeStarted;
  }

  function findCovenAttachment(project, session, threadId) {
    return state.threads.find(function (thread) {
      return isReusableCovenAttachment(thread, project, session, threadId);
    }) || null;
  }

  function covenWorktreeForSession(project, session) {
    var worktrees = project.worktrees || [];
    var containing = worktrees.filter(function (candidate) {
      return session.cwd && (
        session.cwd === candidate.path
        || session.cwd.indexOf(candidate.path + "/") === 0
      );
    }).sort(function (left, right) {
      return right.path.length - left.path.length;
    });
    return containing[0] || worktrees.find(function (candidate) {
      return session.projectRoot === candidate.path;
    }) || selectedWorktree(project);
  }

  function resolveCurrentCovenAttachTarget(expected) {
    var project = findProject(expected.projectId);
    if (!project || project.root !== expected.projectRoot) return null;
    var session = covenSessionsForProject(project).find(function (candidate) {
      return candidate.id === expected.sessionId;
    });
    if (!session ||
        (session.projectRoot || null) !== expected.sessionProjectRoot ||
        (session.cwd || null) !== expected.sessionCwd) return null;
    var worktree = covenWorktreeForSession(project, session);
    if (!worktree || worktree.path !== expected.worktreePath) return null;
    var ownsWorktree = worktree.path === project.root ||
      (project.worktrees || []).some(function (candidate) {
        return candidate.path === worktree.path;
      });
    return ownsWorktree ? { project: project, session: session, worktree: worktree } : null;
  }

  function focusCovenAttachmentForCaller(opening, options) {
    return opening.then(async function (thread) {
      if (!thread || !(await focusThread(thread.id, options))) return null;
      return thread;
    });
  }

  function openCovenSession(project, session, options) {
    if (!project || !session || !PsycheSessions.isSafeCovenSessionId(session.id)) {
      setStatus("Invalid Coven session", "error");
      return Promise.resolve(null);
    }
    if (!state.env || !state.env.coven_path) {
      setStatus("Coven CLI not found — install @opencoven/cli and restart Psyche", "error");
      return Promise.resolve(null);
    }

    var existing = findCovenAttachment(project, session);
    if (existing) {
      var existingId = existing.id;
      return Promise.resolve().then(async function () {
        existing = findCovenAttachment(project, session, existingId);
        if (!existing) return null;
        if (!(await activateProjectWorktree(project, existing.worktreePath, options))) return null;
        existing = findCovenAttachment(project, session, existingId);
        if (!existing) return null;
        await waitForTerminalLayout();
        existing = findCovenAttachment(project, session, existingId);
        if (!existing) return null;
        if (existing.hidden && !reopenThread(existing.id)) return null;
        existing = findCovenAttachment(project, session, existingId);
        if (!existing || !(await focusThread(existing.id, options))) return null;
        return findCovenAttachment(project, session, existingId);
      });
    }

    var key = covenAttachKey(project, session);
    var opening = covenAttachInFlight.get(key);
    if (!opening) {
      var worktree = covenWorktreeForSession(project, session);
      if (!worktree || !worktree.path) return Promise.resolve(null);
      var expected = {
        projectId: project.id,
        projectRoot: project.root,
        sessionId: session.id,
        sessionProjectRoot: session.projectRoot || null,
        sessionCwd: session.cwd || null,
        worktreePath: worktree.path,
      };
      opening = Promise.resolve().then(async function () {
        var current = resolveCurrentCovenAttachTarget(expected);
        if (!current) {
          setStatus(
            "Coven session is no longer available; refresh the rail before retrying",
            "warn"
          );
          return null;
        }
        if (!(await activateProjectWorktree(
          current.project,
          current.worktree.path,
          { focusTerminal: false }
        ))) return null;
        await waitForTerminalLayout();
        current = resolveCurrentCovenAttachTarget(expected);
        if (!current) {
          setStatus(
            "Coven session is no longer available; refresh the rail before retrying",
            "warn"
          );
          return null;
        }
        return createThread({
          project: current.project,
          name: current.session.title || "Coven " + current.session.id.slice(0, 8),
          kind: "coven-attach",
          command: state.env.coven_path,
          args: ["attach", current.session.id],
          projectRoot: current.project.root,
          cwd: current.session.cwd || current.worktree.path,
          worktreePath: current.worktree.path,
          launchKind: "coven-attach",
          covenSessionId: current.session.id,
          metricsProvider: current.session.harness || "coven",
          focusTerminal: false,
        });
      }).finally(function () {
        covenAttachInFlight.delete(key);
      });
      covenAttachInFlight.set(key, opening);
    }
    return focusCovenAttachmentForCaller(opening, options);
  }

  function attachTooltip(element, text) {
    if (!element || !text) return element;
    element.classList.add("has-tooltip");
    element.dataset.tooltip = text;
    if (!element.title) element.title = text;
    return element;
  }

  function appendHighlightedText(element, value, ranges) {
    var source = String(value || "");
    var cursor = 0;
    (ranges || []).forEach(function (range) {
      var start = range[0];
      var end = range[1];
      if (start > cursor) {
        var plain = document.createElement("span");
        plain.textContent = source.slice(cursor, start);
        element.appendChild(plain);
      }
      var mark = document.createElement("mark");
      mark.textContent = source.slice(start, end);
      element.appendChild(mark);
      cursor = end;
    });
    if (cursor < source.length) {
      var remainder = document.createElement("span");
      remainder.textContent = source.slice(cursor);
      element.appendChild(remainder);
    }
  }

  function createDisclosure(label, expanded, autoExpanded) {
    var disclosure = document.createElement("button");
    disclosure.type = "button";
    disclosure.className = "session-disclosure";
    disclosure.setAttribute("tabindex", "-1");
    var actionLabel = autoExpanded
      ? label + " is temporarily expanded for search; clear search to restore saved collapse state"
      : (expanded ? "Collapse " : "Expand ") + label;
    disclosure.setAttribute("aria-label", actionLabel);
    disclosure.textContent = expanded ? "▾" : "▸";
    attachTooltip(disclosure, actionLabel);
    return disclosure;
  }

  function createStatusIndicator(status, matches) {
    var indicator = document.createElement("span");
    indicator.className = "session-status session-state status-" + status.key;
    indicator.setAttribute("aria-label", status.tooltip);
    var icon = document.createElement("span");
    icon.className = "session-status-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = status.icon;
    var label = document.createElement("span");
    label.className = "session-status-label";
    label.textContent = status.label;
    if (matches && matches.length) {
      label.textContent = "";
      appendHighlightedText(label, status.label, matches);
    }
    indicator.appendChild(icon);
    indicator.appendChild(label);
    attachTooltip(indicator, status.tooltip);
    return indicator;
  }

  function createCategoryLabel(category) {
    var label = document.createElement("div");
    label.className = "session-category-label session-subsection-label";
    label.setAttribute("role", "presentation");
    var icon = document.createElement("span");
    icon.className = "session-category-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = category.icon;
    var name = document.createElement("span");
    name.className = "session-category-name";
    appendHighlightedText(name, category.label, category.labelMatches);
    var count = document.createElement("span");
    count.className = "session-category-count";
    count.textContent = String(category.count);
    count.setAttribute(
      "aria-label",
      category.count + " " + category.label.toLowerCase() + " session" +
        (category.count === 1 ? "" : "s")
    );
    label.appendChild(icon);
    label.appendChild(name);
    label.appendChild(count);
    return label;
  }

  function createSessionRow(rowModel, options) {
    var wrapper = document.createElement("div");
    wrapper.className = "session-row-wrap";
    wrapper.setAttribute("role", "none");
    var legacyStatus = rowModel.status.key === "active"
      ? " running"
      : rowModel.status.key === "busy"
        ? " starting"
        : rowModel.status.key === "exited" ? " exited" : "";
    var row = document.createElement("div");
    row.className = "session-row kind-" + rowModel.type.slice(0, -1)
      + " status-" + rowModel.status.key
      + legacyStatus
      + (options.selected ? " is-selected active" : "")
      + (rowModel.needsAttention ? " needs-attention" : "");
    row.dataset.treeItem = "session";
    row.dataset.treeKey = rowModel.key;
    row.dataset.selectionKey = rowModel.selectionKey;
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-level", "3");
    row.setAttribute("aria-selected", options.selected ? "true" : "false");
    row.setAttribute("tabindex", options.tabindex);
    if (options.selected) row.setAttribute("aria-current", "true");
    attachTooltip(row, options.tooltip);

    var icon = document.createElement("span");
    icon.className = "session-type-icon session-glyph";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = rowModel.source === "coven"
      ? "✳"
      : paneGlyphFor(rowModel.kind);

    var text = document.createElement("span");
    text.className = "session-text";
    var titleLine = document.createElement("span");
    titleLine.className = "session-title-line session-title-row";
    var title = document.createElement("span");
    title.className = "session-title";
    appendHighlightedText(title, rowModel.title, rowModel.titleMatches);
    titleLine.appendChild(title);
    if (options.onCanvas) {
      var onCanvas = document.createElement("span");
      onCanvas.className = "session-oncanvas";
      onCanvas.textContent = "▣";
      onCanvas.setAttribute("aria-label", "On the canvas");
      attachTooltip(onCanvas, "On the canvas");
      titleLine.appendChild(onCanvas);
    }
    if (options.sets && options.sets.length) {
      var swatches = document.createElement("span");
      swatches.className = "session-sets";
      options.sets.forEach(function (set) {
        var swatch = document.createElement("span");
        swatch.className = "session-set-swatch";
        swatch.dataset.set = String(Math.min(4, Math.max(1, Number(set.index) || 1)));
        swatch.setAttribute("aria-label", "In " + (set.name || "a focus set"));
        attachTooltip(swatch, "In " + (set.name || "a focus set"));
        swatches.appendChild(swatch);
      });
      titleLine.appendChild(swatches);
    }
    var meta = document.createElement("span");
    meta.className = "session-meta session-sub";
    if (rowModel.source === "coven" &&
        String(rowModel.meta || "").toLowerCase().indexOf("coven") === -1) {
      var source = document.createElement("span");
      source.className = "session-source";
      appendHighlightedText(
        source,
        "Coven · ",
        PsycheSessions.matchTextRanges("Coven · ", options.query)
      );
      meta.appendChild(source);
    }
    appendHighlightedText(meta, rowModel.meta, rowModel.metaMatches);
    text.appendChild(titleLine);
    text.appendChild(meta);

    row.appendChild(icon);
    row.appendChild(text);
    row.appendChild(createStatusIndicator(rowModel.status, rowModel.statusMatches));
    wrapper.appendChild(row);
    return { wrapper: wrapper, row: row, title: title };
  }

  function createBranchGroup(branchModel, options) {
    var unavailableState = branchModel.worktree.virtual
      ? "sessions with no available worktree"
      : branchModel.worktree.missing ? "worktree is missing" : "";
    var tooltip = branchModel.worktree.virtual
      ? "Sessions with no available worktree"
      : (branchModel.worktree.path || branchModel.title) +
        (branchModel.worktree.missing ? " — worktree is missing" : "") +
        (branchModel.autoExpanded
          ? " — temporarily expanded for search; clear search to restore saved collapse state"
          : "");
    var group = document.createElement("div");
    group.className = "session-branch session-worktree-group"
      + (options.active ? " is-active selected" : "")
      + (branchModel.worktree.missing ? " is-missing missing" : "");
    group.dataset.treeItem = "branch";
    group.dataset.treeKey = branchModel.key;
    group.setAttribute("role", "treeitem");
    group.setAttribute("aria-level", "2");
    group.setAttribute("tabindex", options.tabindex);
    group.setAttribute("aria-expanded", branchModel.expanded ? "true" : "false");

    var head = document.createElement("div");
    head.className = "session-branch-head session-worktree-head";
    var disclosure = createDisclosure(
      branchModel.title,
      branchModel.expanded,
      branchModel.autoExpanded
    );
    if (unavailableState) {
      disclosure.disabled = true;
      disclosure.setAttribute("aria-disabled", "true");
      disclosure.setAttribute(
        "aria-label",
        branchModel.title + " unavailable — " + tooltip
      );
      disclosure.title = tooltip;
      attachTooltip(disclosure, tooltip);
    }
    var title = document.createElement("span");
    title.className = "session-branch-name worktree-name";
    appendHighlightedText(title, branchModel.title, branchModel.titleMatches);
    var count = document.createElement("span");
    count.className = "session-branch-count";
    count.textContent = String(branchModel.count);
    if (branchModel.worktree.dirty) count.textContent += " ±";
    count.setAttribute(
      "aria-label",
      branchModel.count + " session" + (branchModel.count === 1 ? "" : "s") +
        (branchModel.attentionCount > 0
          ? ", " + branchModel.attentionCount + " need attention"
          : "")
    );
    if (branchModel.attentionCount > 0) {
      var attention = document.createElement("span");
      attention.className = "session-attention-count session-attention-badge";
      attention.textContent = "!" + branchModel.attentionCount;
      count.appendChild(attention);
    }
    head.appendChild(disclosure);
    head.appendChild(title);
    head.appendChild(count);
    attachTooltip(head, tooltip);
    group.setAttribute(
      "aria-label",
      branchModel.title + ", " + branchModel.count + " session" +
        (branchModel.count === 1 ? "" : "s") +
        (branchModel.attentionCount > 0
          ? ", " + branchModel.attentionCount + " need attention"
          : "") +
        (unavailableState ? ", " + unavailableState : "") +
        (branchModel.autoExpanded ? ", temporarily expanded for search" : "")
    );
    group.title = tooltip;

    var children = document.createElement("div");
    children.className = "session-branch-children";
    children.setAttribute("role", "group");
    group.appendChild(head);
    return {
      group: group,
      head: head,
      disclosure: disclosure,
      children: children,
    };
  }

  function createProjectGroup(projectModel, options) {
    var appearance = options.appearance ||
      PsycheSessions.resolveProjectAppearance(projectModel.project, projectAppearances);
    var group = document.createElement("section");
    group.className = "session-project session-group"
      + (options.current ? " is-current" : "");
    group.dataset.treeItem = "project";
    group.dataset.treeKey = projectModel.key;
    group.dataset.projectId = projectModel.project.id;
    group.dataset.projectAccent = appearance.accent.id;
    group.dataset.projectAppearance = appearance.customized ? "custom" : "automatic";
    group.setAttribute("role", "treeitem");
    group.setAttribute("aria-level", "1");
    group.setAttribute("tabindex", options.tabindex);
    group.setAttribute("aria-expanded", projectModel.expanded ? "true" : "false");

    var head = document.createElement("div");
    head.className = "session-project-head session-group-head";
    head.style.setProperty("--project-accent-rgb", appearance.accent.rgb);
    var disclosure = createDisclosure(
      projectModel.title,
      projectModel.expanded,
      projectModel.autoExpanded
    );
    if (appearance.glyph) {
      var glyph = document.createElement("span");
      glyph.className = "session-project-glyph";
      glyph.textContent = appearance.glyph.value;
      glyph.setAttribute("aria-hidden", "true");
      head.appendChild(disclosure);
      head.appendChild(glyph);
    } else {
      head.appendChild(disclosure);
    }
    var title = document.createElement("span");
    title.className = "session-project-name";
    appendHighlightedText(title, projectModel.title, projectModel.titleMatches);
    var count = document.createElement("span");
    count.className = "session-project-count";
    count.textContent = String(projectModel.count);
    count.setAttribute(
      "aria-label",
      projectModel.count + " session" + (projectModel.count === 1 ? "" : "s") +
        (projectModel.attentionCount > 0
          ? ", " + projectModel.attentionCount + " need attention"
          : "")
    );
    if (projectModel.attentionCount > 0) {
      var attention = document.createElement("span");
      attention.className = "session-attention-count session-attention-badge";
      attention.textContent = "!" + projectModel.attentionCount;
      count.appendChild(attention);
    }
    var files = document.createElement("button");
    files.type = "button";
    files.className = "session-project-files";
    files.dataset.projectFiles = projectModel.project.id;
    files.textContent = "Files";
    files.setAttribute("aria-label", "Browse files in " + projectModel.title);
    head.appendChild(title);
    head.appendChild(count);
    head.appendChild(files);
    attachTooltip(
      head,
      (projectModel.project.root || projectModel.title) +
        (projectModel.autoExpanded
          ? " — temporarily expanded for search; clear search to restore saved collapse state"
          : "")
    );
    group.setAttribute(
      "aria-label",
      projectModel.title + ", " + projectModel.count + " session" +
        (projectModel.count === 1 ? "" : "s") +
        (projectModel.attentionCount > 0
          ? ", " + projectModel.attentionCount + " need attention"
          : "") +
        (projectModel.autoExpanded ? ", temporarily expanded for search" : "")
    );
    group.title = projectModel.project.root || projectModel.title;

    var children = document.createElement("div");
    children.className = "session-project-children";
    children.setAttribute("role", "group");
    group.appendChild(head);
    return {
      group: group,
      head: head,
      disclosure: disclosure,
      files: files,
      children: children,
    };
  }

  function covenToneClass(phase) {
    if (phase === "error" || phase === "incompatible") return "coven-tone-danger";
    if (phase === "unavailable") return "coven-tone-warn";
    return "coven-tone-muted";
  }

  function covenInlineState(discovery) {
    if (!discovery || discovery.phase === "idle" || discovery.phase === "ready") return null;
    var message = discovery.phase === "loading"
      ? "Loading Coven sessions"
      : (discovery.message || "Coven sessions unavailable");
    if (discovery.stale) message += " — showing last confirmed sessions";
    return { message: message, className: covenToneClass(discovery.phase) };
  }

  function visibleSessionTreeItems() {
    if (!sessionListEl) return [];
    return Array.prototype.filter.call(
      sessionListEl.querySelectorAll("[data-tree-item]"),
      function (item) { return item.offsetParent !== null; }
    );
  }

  function focusSessionTreeItem(item) {
    if (!item) return false;
    visibleSessionTreeItems().forEach(function (candidate) {
      candidate.setAttribute("tabindex", candidate === item ? "0" : "-1");
    });
    sessionTreeFocusKey = item.dataset.treeKey || "";
    item.focus();
    return true;
  }

  function focusLogicalSessionTreeKey(key) {
    var items = visibleSessionTreeItems();
    var mounted = items.find(function (item) { return item.dataset.treeKey === key; });
    if (mounted) return focusSessionTreeItem(mounted);
    var virtualState = sessionListEl && sessionListEl.__psycheVirtualState;
    var rowIndex = virtualState && virtualState.rowIndexes.get(key);
    if (rowIndex === undefined || !sessionListEl) return false;
    virtualState.focusKey = key;
    sessionTreeFocusKey = key;
    sessionListEl.scrollTop = sessionOuterScrollTopForRow(
      rowIndex,
      virtualState.rowHeight || 44
    );
    renderSessionList();
    return true;
  }

  function parentSessionTreeItem(item) {
    var parent = item && item.parentElement;
    while (parent && parent !== sessionListEl) {
      if (parent.matches(".session-branch")) return parent;
      if (parent.matches(".session-project")) return parent;
      parent = parent.parentElement;
    }
    return null;
  }

  function firstChildSessionTreeItem(item) {
    if (!item) return null;
    if (item.dataset.treeItem === "project") {
      return item.querySelector(".session-branch");
    }
    if (item.dataset.treeItem === "branch") {
      return item.querySelector(".session-row");
    }
    return null;
  }

  function toggleSessionTreeDisclosure(item) {
    var disclosure = item && item.querySelector(".session-disclosure");
    if (!disclosure || disclosure.disabled) return false;
    disclosure.click();
    return true;
  }

  function activateSessionTreeItem(item) {
    if (!item) return false;
    if (item.dataset.treeItem === "session") {
      item.click();
      return true;
    }
    var head = item.querySelector(
      item.dataset.treeItem === "project"
        ? ".session-project-head"
        : ".session-branch-head"
    );
    if (!head) return false;
    head.click();
    return true;
  }

  function handleSessionTreeKeydown(event) {
    var item = event.target && event.target.matches &&
      event.target.matches("[data-tree-item]") ? event.target : null;
    if (!item || document.activeElement !== item) return;
    var items = visibleSessionTreeItems();
    var index = items.indexOf(item);
    if (index === -1) return;
    sessionTreeFocusKey = item.dataset.treeKey || "";

    var virtualState = sessionListEl && sessionListEl.__psycheVirtualState;
    if (virtualState && virtualState.virtualized &&
        (event.key === "ArrowDown" || event.key === "ArrowUp" ||
          event.key === "Home" || event.key === "End")) {
      var logicalIndex = virtualState.logicalKeys.indexOf(sessionTreeFocusKey);
      if (logicalIndex !== -1) {
        var logicalNext = logicalIndex;
        if (event.key === "Home") logicalNext = 0;
        else if (event.key === "End") logicalNext = virtualState.logicalKeys.length - 1;
        else if (event.key === "ArrowDown") {
          logicalNext = Math.min(virtualState.logicalKeys.length - 1, logicalIndex + 1);
        } else logicalNext = Math.max(0, logicalIndex - 1);
        event.preventDefault();
        focusLogicalSessionTreeKey(virtualState.logicalKeys[logicalNext]);
        return;
      }
    }

    if (item.dataset.treeItem === "project" &&
        (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) {
      var project = findProject(item.dataset.projectId);
      if (!project) return;
      event.preventDefault();
      event.stopPropagation();
      openSessionContextMenu(event, projectAppearanceContextActions(project, item), item);
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp" ||
        event.key === "Home" || event.key === "End") {
      var next = index;
      if (event.key === "Home") next = 0;
      else if (event.key === "End") next = items.length - 1;
      else if (event.key === "ArrowDown") next = Math.min(items.length - 1, index + 1);
      else next = Math.max(0, index - 1);
      event.preventDefault();
      focusSessionTreeItem(items[next]);
      return;
    }

    if (event.key === "ArrowLeft") {
      if ((item.dataset.treeItem === "project" || item.dataset.treeItem === "branch") &&
          item.getAttribute("aria-expanded") === "true") {
        event.preventDefault();
        toggleSessionTreeDisclosure(item);
        return;
      }
      var parent = parentSessionTreeItem(item);
      if (parent) {
        event.preventDefault();
        focusSessionTreeItem(parent);
      }
      return;
    }

    if (event.key === "ArrowRight") {
      if ((item.dataset.treeItem === "project" || item.dataset.treeItem === "branch") &&
          item.getAttribute("aria-expanded") === "false") {
        event.preventDefault();
        toggleSessionTreeDisclosure(item);
        return;
      }
      var child = firstChildSessionTreeItem(item);
      if (child) {
        event.preventDefault();
        focusSessionTreeItem(child);
      } else if (virtualState && virtualState.childKeys) {
        var logicalChildKey = virtualState.childKeys.get(item.dataset.treeKey || "");
        if (logicalChildKey) {
          event.preventDefault();
          focusLogicalSessionTreeKey(logicalChildKey);
        }
      }
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      activateSessionTreeItem(item);
      return;
    }
    if (event.key === " " && item.dataset.treeItem !== "session") {
      event.preventDefault();
      toggleSessionTreeDisclosure(item);
    }
  }

  function restoreSessionTreeFocus(key) {
    var items = visibleSessionTreeItems();
    var target = items.find(function (item) {
      return key && item.dataset.treeKey === key;
    }) || items.find(function (item) {
      return item.getAttribute("tabindex") === "0";
    }) || items[0];
    return focusSessionTreeItem(target);
  }

  function renderSessionList(options) {
    if (!sessionListEl) return;
    if (editingContext && editingContext.surface === "sidebar") return;
    var popoverRestoreKey = projectAppearancePopoverRestoreKey;
    var popoverOwnsFocus = projectAppearancePopover &&
      projectAppearancePopover.contains(document.activeElement);
    closeProjectAppearancePopover({ restoreFocus: false });
    var now = Date.now();
    syncLocalSidebarStatusKeys(now);
    // A re-render would strand an armed confirm on a row that no longer exists.
    // Carry its tree identity through the rebuild so focus lands on the
    // replacement row instead of the soon-to-be-detached host.
    var armedCloseTreeKey = armedSessionClose &&
      armedSessionClose.confirm.contains(document.activeElement)
      ? armedSessionClose.treeKey
      : "";
    disarmSessionClose({ restoreFocus: false });
    function targetWithin(event, element) {
      for (var node = event && event.target; node; node = node.parentNode) {
        if (node === element) return true;
      }
      return false;
    }
    var virtualState = sessionListEl.__psycheVirtualState || {
      virtualized: false,
      logicalKeys: [],
      rowIndexes: new Map(),
      childKeys: new Map(),
      focusKey: "",
    };
    sessionListEl.__psycheVirtualState = virtualState;
    var preserveFocus = !options || options.preserveFocus !== false;
    var requestedRestoreKey = options && options.restoreFocusKey;
    var requestedProjectFilesId = options && options.restoreProjectFilesId;
    var activeProjectFilesId = requestedProjectFilesId ||
      (preserveFocus &&
      document.activeElement && document.activeElement.dataset
      ? document.activeElement.dataset.projectFiles || ""
      : "");
    var activeTreeKey = virtualState.focusKey || (preserveFocus &&
      document.activeElement && document.activeElement.dataset
      ? document.activeElement.dataset.treeKey
      : "") || armedCloseTreeKey ||
      (popoverOwnsFocus ? popoverRestoreKey : "");
    var shouldRestoreTreeFocus = Boolean(activeTreeKey || requestedRestoreKey);
    if (activeTreeKey) sessionTreeFocusKey = activeTreeKey;
    var focusedKey = requestedRestoreKey || sessionTreeFocusKey;
    sessionListEl.setAttribute("role", "tree");
    sessionListEl.setAttribute(
      "aria-label",
      "Sessions by project, branch, and category"
    );
    if (setPicking) sessionListEl.setAttribute("aria-multiselectable", "true");
    else sessionListEl.removeAttribute("aria-multiselectable");
    var virtualRuntime = sessionListEl.__psycheVirtualRuntime;
    var sessionRowHeight = virtualRuntime
      ? collectionRowHeight(sessionListEl, "--session-row-h", 44)
      : 44;
    var measuredSessionScrollTop = virtualRuntime
      ? sessionVirtualScrollTop(sessionRowHeight)
      : sessionListEl.scrollTop || 0;
    sessionListEl.replaceChildren();

    var currentSearchQuery = "";
    var matched = 0;
    var inlineState = covenInlineState(covenDiscovery);
    // Walked once per render: every row tests membership against this list.
    var onCanvasIds = canvasThreadIds();
    var covenAssignments = covenSessionAssignments();

    var persistedSelectionExists = !settings.selectedSessionKey ||
      state.projects.some(function (project) {
        var localMatch = state.threads.some(function (thread) {
          return thread.projectId === project.id && !thread.hidden &&
            !isDormantThread(thread) &&
            PsycheSessions.localSidebarSelectionKey(project, thread) ===
              settings.selectedSessionKey;
        });
        if (localMatch) return true;
        return covenSessionsForProject(project).some(function (session) {
          return PsycheSessions.sidebarSelectionKey({
            source: "coven",
            id: session.id,
          }) === settings.selectedSessionKey;
        });
      });
    var canValidatePersistedSelection = state.projects.length > 0 &&
      !isRestoringWorkspace &&
      (settings.selectedSessionKey.indexOf("coven:") !== 0 ||
        covenDiscovery.phase === "ready");
    if (settings.selectedSessionKey && canValidatePersistedSelection &&
        !persistedSelectionExists) {
      settings.selectedSessionKey = "";
      saveSettings();
    }

    var selectedThread = findThread(state.activeThreadId);
    var selectedThreadProject = selectedThread && findProject(selectedThread.projectId);
    var selectedKey = selectedThread && selectedThreadProject
      ? PsycheSessions.localSidebarSelectionKey(selectedThreadProject, selectedThread)
      : settings.selectedSessionKey;

    var projectModels = [];
    state.projects.forEach(function (project) {
      var projectThreads = state.threads.filter(function (thread) {
        return thread.projectId === project.id && !isDormantThread(thread);
      });
      var visibleLocalRows = projectThreads.filter(function (thread) {
        return !thread.hidden;
      });
      var remoteRows = covenSessionsForProject(project, covenAssignments);
      if (projectThreads.length === 0 && remoteRows.length === 0) return;
      // This branch calls buildSidebarProjectModel instead of reaching for
      // buildProjectRailModel directly; the rail model still exists and
      // sidebar-model.mjs builds on it. Eligibility is decided before the
      // sidebar model sees any rows so query/filter presentation cannot turn a
      // populated project into an "empty" one. main's covenAssignments
      // argument survives the swap: it hoists the assignment map out of the
      // per-project loop, which covenSessionsForProject would otherwise rebuild
      // once per project.
      var projectModel = PsycheSessions.buildSidebarProjectModel({
        project: project,
        localSessions: visibleLocalRows,
        covenSessions: remoteRows,
        query: currentSearchQuery,
        filter: sessionTypeFilter,
        selectedKey: selectedKey,
        now: now,
      });
      matched += projectModel.visibleCount;
      projectModels.push({
        project: project,
        model: projectModel,
        appearance: PsycheSessions.resolveProjectAppearance(project, projectAppearances),
      });
    });

    var sessionRows = [];
    virtualState.logicalKeys = [];
    virtualState.rowIndexes = new Map();
    virtualState.childKeys = new Map();
    projectModels.forEach(function (entry) {
      virtualState.logicalKeys.push(entry.model.key);
      if (!entry.model.expanded) return;
      if (entry.model.branches.length) {
        virtualState.childKeys.set(entry.model.key, entry.model.branches[0].key);
      }
      entry.model.branches.forEach(function (branch) {
        virtualState.logicalKeys.push(branch.key);
        if (!branch.expanded) return;
        var firstCategoryWithRows = branch.categories.find(function (category) {
          return category.rows.length > 0;
        });
        if (firstCategoryWithRows) {
          virtualState.childKeys.set(branch.key, firstCategoryWithRows.rows[0].key);
        }
        branch.categories.forEach(function (category) {
          category.rows.forEach(function (row) {
            virtualState.rowIndexes.set(row.key, sessionRows.length);
            sessionRows.push(row);
            virtualState.logicalKeys.push(row.key);
          });
        });
      });
    });
    var sessionActiveIndex = sessionRows.findIndex(function (item) {
      return activeTreeKey && item.key === activeTreeKey;
    });
    var sessionVirtualWindow = null;
    var sessionVisibleKeys = null;
    virtualState.rowHeight = sessionRowHeight;
    virtualState.virtualized = Boolean(
      virtualRuntime && virtualRuntime.shouldVirtualize(sessionRows.length)
    );
    if (virtualState.virtualized) {
      sessionVirtualWindow = virtualRuntime.virtualizeItems(sessionRows, {
        rowHeight: sessionRowHeight,
        viewportHeight: sessionListEl.clientHeight,
        scrollTop: measuredSessionScrollTop,
        overscan: virtualRuntime.VIRTUAL_LIST_OVERSCAN,
        activeIndex: sessionActiveIndex >= 0 ? sessionActiveIndex : undefined,
        getKey: function (item) { return item.key; },
      });
      sessionVisibleKeys = new Set(sessionVirtualWindow.items.map(function (item) {
        return item.key;
      }));
    }

    if (sessionTypeFilter !== "all") {
      var summary = document.createElement("div");
      summary.className = "session-result-summary";
      summary.setAttribute("role", "status");
      summary.setAttribute("aria-live", "polite");
      var summaryText = document.createElement("span");
      summaryText.textContent = matched + (matched === 1 ? " session" : " sessions");
      var reset = document.createElement("button");
      reset.type = "button";
      reset.className = "session-result-reset";
      reset.textContent = "Reset filter";
      reset.addEventListener("click", function () {
        setSessionTypeFilter("all");
        var allFilter = document.querySelector('[data-session-filter="all"]');
        if (allFilter) allFilter.focus();
      });
      summary.appendChild(summaryText);
      summary.appendChild(reset);
      sessionListEl.appendChild(summary);
    }

    var sessionRenderRowIndex = 0;
    projectModels.forEach(function (entry) {
      var project = entry.project;
      var projectModel = entry.model;
      var appearance = entry.appearance;
      var projectParts = createProjectGroup(projectModel, {
        appearance: appearance,
        current: project.id === state.activeProjectId,
        tabindex: "-1",
      });
      function setProjectExpanded(expanded) {
        if (projectModel.autoExpanded || Boolean(project.collapsed) === !expanded) return false;
        project.collapsed = !expanded;
        refreshSidebar();
        saveWorkspaceSoon();
        return true;
      }
      projectParts.disclosure.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        setProjectExpanded(!projectModel.expanded);
      });
      projectParts.files.addEventListener("pointerdown", function (event) {
        event.stopPropagation();
      });
      projectParts.files.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        showProjectFiles(project.id);
      });
      projectParts.group.addEventListener("click", function (event) {
        if (!targetWithin(event, projectParts.head) ||
            targetWithin(event, projectParts.disclosure)) return;
        clearFocusSet();
        setActiveProject(project.id);
      });
      projectParts.head.addEventListener("contextmenu", function (event) {
        var focusKey = projectParts.group.dataset.treeKey || "";
        if (focusKey) sessionTreeFocusKey = focusKey;
        openSessionContextMenu(
          event,
          projectAppearanceContextActions(project, projectParts.group),
          projectParts.group
        );
      });
      if (projectModel.expanded) {
        projectModel.branches.forEach(function (branchModel) {
        var worktree = branchModel.worktree;
        var branchParts = createBranchGroup(branchModel, {
          active: !worktree.virtual && project.selectedWorktreePath === worktree.path,
          tabindex: "-1",
        });
        function setBranchExpanded(expanded) {
          if (worktree.virtual || worktree.missing || branchModel.autoExpanded ||
              Boolean(worktree.collapsed) === !expanded) return false;
          worktree.collapsed = !expanded;
          refreshSidebar();
          saveWorkspaceSoon();
          return true;
        }
        branchParts.disclosure.addEventListener("click", function (event) {
          event.preventDefault();
          event.stopPropagation();
          setBranchExpanded(!branchModel.expanded);
        });
        branchParts.group.addEventListener("click", async function (event) {
          if (!targetWithin(event, branchParts.head) ||
              targetWithin(event, branchParts.disclosure)) return;
          if (worktree.virtual || worktree.missing) return;
          await activateProjectWorktree(project, worktree.path);
        });
        branchParts.group.addEventListener("dblclick", function (event) {
          if (!targetWithin(event, branchParts.head) ||
              targetWithin(event, branchParts.disclosure)) return;
          if (worktree.virtual || worktree.missing) return;
          event.preventDefault();
          setBranchExpanded(!branchModel.expanded);
        });
        var hiddenThreads = state.threads.filter(function (thread) {
          return thread.projectId === project.id && thread.worktreePath === worktree.path &&
            thread.hidden;
        });
        if (!worktree.virtual && !worktree.missing) {
          branchParts.head.addEventListener("contextmenu", function (event) {
            var actions = [{
              label: "Open Coven CLI",
              run: async function () {
                if (!(await activateProjectWorktree(project, worktree.path))) return;
                await ensureProjectCoven(project);
              },
            }];
            if (hiddenThreads.length > 0) {
              actions.push({
                label: "Show " + hiddenThreads.length + " hidden session" +
                  (hiddenThreads.length === 1 ? "" : "s"),
                run: async function () {
                  await reopenThreadsForWorkspace(project, worktree.path);
                },
              });
            }
            openSessionContextMenu(event, actions);
          });
        }

        if (branchModel.expanded) {
          branchModel.categories.forEach(function (category) {
            var categoryGroup = document.createElement("div");
            categoryGroup.className = "session-category";
            categoryGroup.setAttribute("role", "none");
            categoryGroup.appendChild(createCategoryLabel(category));

            var categoryStart = sessionRenderRowIndex;
            var categoryEnd = categoryStart + category.rows.length;
            sessionRenderRowIndex = categoryEnd;
            categoryGroup.dataset.virtualRowStart = String(categoryStart);
            categoryGroup.dataset.virtualRowCount = String(category.rows.length);
            var categoryWindow = sessionVirtualWindow
              ? virtualRuntime.computeVirtualGroup(
                  categoryStart,
                  category.rows.length,
                  sessionVirtualWindow
                )
              : null;
            if (sessionVirtualWindow) {
              var categoryBeforeCount = categoryWindow.beforeCount;
              if (categoryBeforeCount) {
                categoryGroup.appendChild(createVirtualListSpacer(
                  "before",
                  categoryBeforeCount * sessionRowHeight
                ));
              }
            }

            category.rows.forEach(function (rowModel) {
              if (sessionVisibleKeys && !sessionVisibleKeys.has(rowModel.key)) return;
              var selected = rowModel.selectionKey === selectedKey;
              var rowParts = createSessionRow(rowModel, {
                selected: selected,
                tabindex: "-1",
                tooltip: rowModel.title + " — " + rowModel.meta +
                  " — " + rowModel.status.tooltip,
                query: currentSearchQuery,
                onCanvas: rowModel.source === "psyche" &&
                  onCanvasIds.indexOf(rowModel.id) !== -1,
                sets: rowModel.source === "psyche" ? setsForThread(rowModel.value) : [],
              });
              var row = rowParts.row;
              row.dataset.virtualKey = rowModel.key;
              var wrapper = rowParts.wrapper;
              if (rowModel.source === "coven") {
                var attached = covenRowAttached(state, project.id, rowModel.id);
                row.dataset.sessionId = rowModel.id;
                row.setAttribute("aria-keyshortcuts", "Delete");
                row.title = (attached ? "Focus attachment — " : "Attach — ") + row.title;
                function activateCovenRow() {
                  settings.selectedSessionKey = rowModel.selectionKey;
                  saveSettings();
                  openCovenSession(project, rowModel.value);
                }
                row.addEventListener("click", activateCovenRow);
                var covenClose = document.createElement("button");
                covenClose.type = "button";
                covenClose.className = "session-close";
                covenClose.title = "Stop and close " + rowModel.title;
                covenClose.setAttribute("aria-label", covenClose.title);
                covenClose.setAttribute("tabindex", "-1");
                covenClose.textContent = "×";
                function armCovenClose() {
                  armSessionClose(row, covenClose, rowModel.title, function () {
                    return closeCovenSession(rowModel.value);
                  });
                }
                covenClose.addEventListener("click", function (event) {
                  event.stopPropagation();
                  armCovenClose();
                });
                row.addEventListener("keydown", function (event) {
                  if (event.target !== row || document.activeElement !== row) return;
                  if (event.key !== "Delete") return;
                  event.preventDefault();
                  armCovenClose();
                });
                row.addEventListener("contextmenu", function (event) {
                  openSessionContextMenu(event, [
                    { label: attached ? "Focus attachment" : "Attach", run: activateCovenRow },
                    { label: "Stop and close", danger: true, run: armCovenClose },
                  ]);
                });
                row.appendChild(covenClose);
                categoryGroup.appendChild(wrapper);
                return;
              }

              var thread = rowModel.value;
              var picking = Boolean(setPicking);
              var picked = picking && isPicked(thread.id);
              row.dataset.threadId = thread.id;
              row.setAttribute("aria-keyshortcuts", "Delete");
              if (picking) {
                row.classList.add("is-picking");
                if (picked) row.classList.add("is-picked");
                row.setAttribute("aria-selected", picked ? "true" : "false");
                row.title = (picked ? "Remove " : "Include ") + thread.name + " in the set";
              }
              async function activateLocalRow() {
                if (setPicking) { toggleSetPick(thread.id); return; }
                var liveThread = findFocusableThread(thread.id);
                if (!liveThread) return;
                var liveProject = findProject(liveThread.projectId);
                if (!liveProject) return;
                var worktreePath = liveThread.worktreePath || liveProject.root;
                if ((liveProject.id !== state.activeProjectId ||
                    activeWorkspaceRoot(liveProject) !== worktreePath) &&
                    !(await activateProjectWorktree(
                      liveProject,
                      worktreePath,
                      { refreshStatus: false }
                    ))) return;
                liveThread = findFocusableThread(thread.id);
                liveProject = liveThread && findProject(liveThread.projectId);
                worktreePath = liveThread && liveProject &&
                  (liveThread.worktreePath || liveProject.root);
                if (!liveThread || !liveProject ||
                    liveProject.id !== state.activeProjectId ||
                    activeWorkspaceRoot(liveProject) !== worktreePath) return;
                settings.selectedSessionKey = rowModel.selectionKey;
                saveSettings();
                await focusThreadFromSidebar(liveThread);
              }
              row.addEventListener("click", activateLocalRow);
              row.addEventListener("keydown", function (event) {
                if (event.target !== row || document.activeElement !== row) return;
                if (event.key !== "Delete") return;
                event.preventDefault();
                armLocalClose();
              });
              function beginSessionRename(event) {
                event.stopPropagation();
                editLabelInline(rowParts.title, "sidebar", {
                  initial: thread.name,
                  host: wrapper,
                  hide: row,
                  ariaLabel: "Session name",
                  onCommit: function (value) {
                    if (renameThread(rowModel.id, value) &&
                        state.activeThreadId === rowModel.id) {
                      settings.selectedSessionKey =
                        PsycheSessions.localSidebarSelectionKey(project, thread);
                      saveSettings();
                    }
                  },
                  done: function () {
                    renderSessionList();
                    var replacementRows = sessionListEl.querySelectorAll(".session-row");
                    for (var i = 0; i < replacementRows.length; i++) {
                      if (replacementRows[i].dataset.threadId === thread.id) {
                        replacementRows[i].focus();
                        break;
                      }
                    }
                  },
                });
              }
              row.addEventListener("dblclick", beginSessionRename);
              row.addEventListener("keydown", function (event) {
                if (event.key !== "F2") return;
                event.preventDefault();
                beginSessionRename(event);
              });
              row.addEventListener("contextmenu", function (event) {
                var memberships = setsForThread(thread);
                openSessionContextMenu(event, localSessionContextActions(
                  thread,
                  memberships,
                  {
                    focus: activateLocalRow,
                    showSet: function () { activateFocusSet(memberships[0].id); },
                    removeSet: function () {
                      removeFromFocusSet(memberships[0].id, thread.id);
                    },
                    rename: function () {
                      beginSessionRename({ stopPropagation: function () {} });
                    },
                    duplicate: function () { duplicateThread(thread); },
                    interrupt: function () { sendToThread(thread, "\x03"); },
                    hide: function () { hideThread(thread.id); },
                    close: armLocalClose,
                  }
                ));
              });

              var close = document.createElement("button");
              close.type = "button";
              close.className = "session-close";
              close.title = sessionCloseLabel(thread);
              close.setAttribute("aria-label", close.title);
              close.setAttribute("tabindex", "-1");
              close.textContent = "×";
              function armLocalClose() {
                var resolvesCovenRecovery = thread.launch &&
                  (thread.launch.launchKind === "coven-recovery" ||
                    thread.launch.recoveryRequired === true);
                armSessionClose(
                  row,
                  close,
                  resolvesCovenRecovery
                    ? "inspected Coven recovery for " + thread.name
                    : thread.name,
                  function () {
                    if (thread.launch &&
                        (thread.launch.launchKind === "coven-recovery" ||
                          thread.launch.recoveryRequired === true)) {
                      return resolveCovenLaunchRecovery(thread);
                    }
                    return requestThreadClose(thread);
                  },
                  resolvesCovenRecovery ? "Resolve" : "Close"
                );
              }
              close.addEventListener("click", function (event) {
                event.stopPropagation();
                armLocalClose();
              });
              row.appendChild(close);
              categoryGroup.appendChild(wrapper);
            });
            if (sessionVirtualWindow) {
              var categoryAfterCount = categoryWindow.afterCount;
              if (categoryAfterCount) {
                categoryGroup.appendChild(createVirtualListSpacer(
                  "after",
                  categoryAfterCount * sessionRowHeight
                ));
              }
            }
            branchParts.children.appendChild(categoryGroup);
          });
          branchParts.group.appendChild(branchParts.children);
        }
        projectParts.children.appendChild(branchParts.group);
        });
        projectParts.group.appendChild(projectParts.children);
      }
      sessionListEl.appendChild(projectParts.group);
    });

    if (inlineState) {
      var inline = document.createElement("div");
      inline.className = "session-inline-state " + inlineState.className;
      inline.textContent = inlineState.message;
      sessionListEl.appendChild(inline);
    }

    if (matched === 0 && !inlineState) {
      var empty = document.createElement("div");
      empty.className = "session-empty";
      empty.textContent = sessionTypeFilter !== "all"
        ? "No sessions match the " + sessionTypeFilter + " filter."
        : state.projects.length
          ? "No sessions yet."
          : "No project open — ⌘O to add one.";
      sessionListEl.appendChild(empty);
    }

    var renderedItems = Array.prototype.slice.call(
      sessionListEl.querySelectorAll("[data-tree-item]")
    );
    var replacementProjectFilesButton = !requestedRestoreKey && activeProjectFilesId
      ? Array.prototype.find.call(
          sessionListEl.querySelectorAll("[data-project-files]"),
          function (button) {
            return button.dataset.projectFiles === activeProjectFilesId;
          }
        )
      : null;
    var requestedFocusItem = renderedItems.find(function (item) {
      return requestedRestoreKey && item.dataset.treeKey === requestedRestoreKey;
    });
    var preferred = requestedFocusItem || renderedItems.find(function (item) {
      return focusedKey && item.dataset.treeKey === focusedKey;
    }) || renderedItems.find(function (item) {
      return item.dataset.selectionKey === selectedKey;
    }) || renderedItems.find(function (item) {
      return item.dataset.treeItem === "project"
        && item.classList.contains("is-current");
    }) || renderedItems[0];
    renderedItems.forEach(function (item) {
      item.setAttribute("tabindex", item === preferred ? "0" : "-1");
    });
    if (preferred) {
      sessionTreeFocusKey = preferred.dataset.treeKey || "";
      if (!replacementProjectFilesButton &&
          shouldRestoreTreeFocus && (!requestedRestoreKey || requestedFocusItem)) {
        preferred.focus();
      }
    }
    if (replacementProjectFilesButton) replacementProjectFilesButton.focus();
    virtualState.focusKey = "";
  }

  function applyProjectAppearance(project, patch) {
    var key = PsycheSessions.normalizeProjectAppearanceKey(project && project.root);
    if (!project || !key) return false;
    projectAppearances = PsycheSessions.updateProjectAppearance(
      projectAppearances,
      key,
      patch
    );
    var focusKey = sessionTreeFocusKey;
    saveProjectAppearances();
    renderSessionList();
    if (focusKey) {
      sessionTreeFocusKey = focusKey;
      restoreSessionTreeFocus(focusKey);
    }
    return true;
  }

  function closeProjectAppearancePopover(options) {
    var restoreFocus = !options || options.restoreFocus !== false;
    var restoreKey = projectAppearancePopoverRestoreKey;
    if (projectAppearancePopover && projectAppearancePopover.parentNode) {
      projectAppearancePopover.parentNode.removeChild(projectAppearancePopover);
    }
    projectAppearancePopover = null;
    projectAppearancePopoverRestoreKey = "";
    if (restoreFocus && restoreKey) {
      sessionTreeFocusKey = restoreKey;
      restoreSessionTreeFocus(restoreKey);
    }
  }

  function openProjectAppearancePopover(project, anchor) {
    if (!project || !anchor || typeof anchor.getBoundingClientRect !== "function") return null;
    closeSessionContextMenu({ restoreFocus: false });
    closeProjectAppearancePopover({ restoreFocus: false });

    var appearance = PsycheSessions.resolveProjectAppearance(project, projectAppearances);
    var stored = appearance.override || {};
    var hasOwn = Object.prototype.hasOwnProperty;
    var draftAccent = hasOwn.call(stored, "accent") ? stored.accent : null;
    var draftGlyph = hasOwn.call(stored, "glyph") ? stored.glyph : null;

    var popover = document.createElement("div");
    popover.className = "project-appearance-popover";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "Customize appearance for " + project.name);

    var title = document.createElement("div");
    title.className = "project-appearance-title";
    title.textContent = project.name;
    popover.appendChild(title);

    var accentLabel = document.createElement("div");
    accentLabel.className = "project-appearance-label";
    popover.appendChild(accentLabel);

    var accentGrid = document.createElement("div");
    accentGrid.className = "project-appearance-grid project-appearance-accent-grid";
    popover.appendChild(accentGrid);

    var accentButtons = [];
    PsycheSessions.PROJECT_ACCENTS.forEach(function (accent) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "project-appearance-choice project-appearance-accent";
      button.setAttribute("aria-label", accent.label);
      button.style.setProperty("--project-accent-rgb", accent.rgb);
      var swatch = document.createElement("span");
      swatch.className = "project-appearance-accent-swatch";
      button.appendChild(swatch);
      button.addEventListener("click", function () {
        draftAccent = accent.id;
        syncDraftState();
      });
      accentGrid.appendChild(button);
      accentButtons.push({ id: accent.id, label: accent.label, button: button });
    });

    var glyphLabel = document.createElement("div");
    glyphLabel.className = "project-appearance-label";
    popover.appendChild(glyphLabel);

    var glyphGrid = document.createElement("div");
    glyphGrid.className = "project-appearance-grid project-appearance-glyph-grid";
    popover.appendChild(glyphGrid);

    var glyphButtons = [];
    var noGlyphButton = document.createElement("button");
    noGlyphButton.type = "button";
    noGlyphButton.className = "project-appearance-choice project-appearance-glyph";
    noGlyphButton.textContent = "No glyph";
    noGlyphButton.addEventListener("click", function () {
      draftGlyph = null;
      syncDraftState();
    });
    glyphGrid.appendChild(noGlyphButton);
    glyphButtons.push({ id: null, label: "No glyph", button: noGlyphButton });

    PsycheSessions.PROJECT_GLYPHS.forEach(function (glyph) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "project-appearance-choice project-appearance-glyph";
      button.setAttribute("aria-label", glyph.label);
      var glyphValue = document.createElement("span");
      glyphValue.className = "project-appearance-glyph-value";
      glyphValue.textContent = glyph.value;
      var glyphText = document.createElement("span");
      glyphText.className = "project-appearance-glyph-name";
      glyphText.textContent = glyph.label;
      button.appendChild(glyphValue);
      button.appendChild(glyphText);
      button.addEventListener("click", function () {
        draftGlyph = glyph.id;
        syncDraftState();
      });
      glyphGrid.appendChild(button);
      glyphButtons.push({ id: glyph.id, label: glyph.label, button: button });
    });

    var actions = document.createElement("div");
    actions.className = "project-appearance-actions";
    var reset = document.createElement("button");
    reset.type = "button";
    reset.className = "project-appearance-action";
    reset.textContent = "Reset to automatic";
    reset.addEventListener("click", function () {
      closeProjectAppearancePopover({ restoreFocus: false });
      applyProjectAppearance(project, null);
    });
    var spacer = document.createElement("span");
    spacer.className = "project-appearance-spacer";
    spacer.setAttribute("aria-hidden", "true");
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "project-appearance-action";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", function () {
      closeProjectAppearancePopover();
    });
    var apply = document.createElement("button");
    apply.type = "button";
    apply.className = "project-appearance-action is-primary";
    apply.textContent = "Apply";
    apply.addEventListener("click", function () {
      closeProjectAppearancePopover({ restoreFocus: false });
      applyProjectAppearance(project, { accent: draftAccent, glyph: draftGlyph });
    });
    actions.appendChild(reset);
    actions.appendChild(spacer);
    actions.appendChild(cancel);
    actions.appendChild(apply);
    popover.appendChild(actions);

    function syncDraftState() {
      var accentMatch = PsycheSessions.PROJECT_ACCENTS.find(function (accent) {
        return accent.id === draftAccent;
      }) || appearance.accent;
      accentLabel.textContent = draftAccent
        ? "Accent · " + accentMatch.label
        : "Accent · Automatic (" + appearance.accent.label + ")";
      accentButtons.forEach(function (entry) {
        entry.button.setAttribute("aria-pressed", entry.id === draftAccent ? "true" : "false");
      });
      var glyphMatch = PsycheSessions.PROJECT_GLYPHS.find(function (glyph) {
        return glyph.id === draftGlyph;
      });
      glyphLabel.textContent = glyphMatch
        ? "Glyph · " + glyphMatch.label
        : "Glyph · No glyph";
      glyphButtons.forEach(function (entry) {
        entry.button.setAttribute("aria-pressed", entry.id === draftGlyph ? "true" : "false");
      });
    }

    syncDraftState();
    projectAppearancePopover = popover;
    projectAppearancePopoverRestoreKey =
      (anchor.dataset && anchor.dataset.treeKey) || sessionTreeFocusKey || "";
    document.body.appendChild(popover);
    popover.style.maxWidth = Math.max(0, Math.min(420, window.innerWidth - 16)) + "px";
    var anchorRect = anchor.getBoundingClientRect();
    var popoverRect = popover.getBoundingClientRect();
    popover.style.left = Math.max(8, Math.min(
      window.innerWidth - popoverRect.width - 8,
      anchorRect.left
    )) + "px";
    popover.style.top = Math.max(8, Math.min(
      window.innerHeight - popoverRect.height - 8,
      anchorRect.bottom + 8
    )) + "px";
    var preferredFocus = popover.querySelector('button[aria-pressed="true"]') ||
      popover.querySelector("button");
    if (preferredFocus) preferredFocus.focus();
    return popover;
  }

  if (bgOpacityInput) {
    // `input` fires continuously while dragging so the window responds live;
    // the write to localStorage is deferred to `change` (drag end) so a single
    // drag does not thrash it.
    bgOpacityInput.addEventListener("input", function () {
      applyBgOpacity(bgOpacityInput.value, { persist: false });
    });
    bgOpacityInput.addEventListener("change", function () {
      applyBgOpacity(bgOpacityInput.value);
    });
  }
  if (themeSelectEl) {
    themeSelectEl.addEventListener("change", function () { applyTheme(themeSelectEl.value); });
  }
  if (solidBgEl) {
    solidBgEl.addEventListener("change", function () { applySolidBg(solidBgEl.checked); });
  }
  // Apply whatever was persisted before the first paint settles.
  applyTheme(settings.theme, { persist: false });
  applySolidBg(settings.solidBg, { persist: false });
  applyBgOpacity(settings.bgOpacity, { persist: false });

  if (sessionListEl) {
    sessionListEl.addEventListener("focusin", function (event) {
      if (event.target && event.target.matches &&
          event.target.matches("[data-tree-item]")) {
        sessionTreeFocusKey = event.target.dataset.treeKey || "";
      }
    });
    sessionListEl.addEventListener("keydown", handleSessionTreeKeydown);
  }
  Array.prototype.forEach.call(
    document.querySelectorAll("[data-session-filter]"),
    function (button) {
      button.addEventListener("click", function () {
        setSessionTypeFilter(button.dataset.sessionFilter);
      });
    }
  );
  setSidebarView("sessions");
  setSessionTypeFilter(settings.sessionFilter, { persist: false });

  /**
   * The canvas' zero state. It is also the fastest route back into work, so
   * it carries the same three launchers the new-pane menu offers.
   */
  function renderTerminalEmptyState() {
    var existing = terminalHost.querySelector(".canvas-empty");
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    var layout = activePaneLayout();
    if (layout && layout.root) return;
    var project = activeProject();
    var empty = document.createElement("div");
    empty.className = "canvas-empty";
    empty.innerHTML =
      '<div class="canvas-empty-mark">PSYCHE</div>' +
      '<div class="canvas-empty-title">' +
        (project ? "No panes open in " + escapeHtml(project.name) : "No project open") + "</div>" +
      '<div class="canvas-empty-sub">' +
        (project
          ? "Launch a lane — Coven, a shell, or a browser, each in its own pane on the selected worktree."
          : "Open a project folder (⌘O) to start a pane.") +
      "</div>" +
      '<div class="canvas-empty-actions">' +
        '<button type="button" class="canvas-empty-action" data-empty-action="term">' +
          '<span class="glyph mono">❯_</span>Terminal<span class="key">⌘T</span></button>' +
        '<button type="button" class="canvas-empty-action" data-empty-action="agent">' +
          '<span class="glyph">✳</span>Agent<span class="key">⌘D</span></button>' +
        '<button type="button" class="canvas-empty-action" data-empty-action="web">' +
          '<span class="glyph">◍</span>Browser<span class="key">Web +</span></button>' +
      "</div>";
    empty.addEventListener("click", function (event) {
      var button = event.target.closest("[data-empty-action]");
      if (!button) return;
      if (!activeProject()) { openProjectPicker(); return; }
      var action = button.dataset.emptyAction;
      if (action === "term") createTerminalPane();
      else if (action === "agent") openAgentPicker();
      else openBlankBrowserTab();
    });
    terminalHost.appendChild(empty);
  }

  function waitForProjectCloseRetry(delay) {
    return new Promise(function (resolve) {
      setTimeout(resolve, delay);
    });
  }

  var closingNativeProjectRoots = new Set();
  var pendingNativeProjectRevocations = new Map();
  var pendingNativeProjectRevocationTimer = 0;
  function schedulePendingNativeProjectRevocations(delay) {
    if (pendingNativeProjectRevocationTimer ||
        pendingNativeProjectRevocations.size === 0) {
      return;
    }
    pendingNativeProjectRevocationTimer = setTimeout(function () {
      pendingNativeProjectRevocationTimer = 0;
      retryPendingNativeProjectRevocations().catch(function (error) {
        setStatus(
          "native project authority background cleanup failed: " + String(error),
          "error"
        );
      });
    }, delay);
  }
  function quarantineNativeProjectRevocation(project, error) {
    if (!project || !project.root) return;
    closingNativeProjectRoots.add(project.root);
    pendingNativeProjectRevocations.set(project.root, {
      root: project.root,
      name: project.name || project.root,
      attempts: 3,
      lastError: String(error),
    });
    schedulePendingNativeProjectRevocations(1000);
  }
  async function retryPendingNativeProjectRevocations() {
    var entries = Array.from(pendingNativeProjectRevocations.values());
    for (var index = 0; index < entries.length; index += 1) {
      var entry = entries[index];
      try {
        await invoke("native_project_close", { root: entry.root });
        pendingNativeProjectRevocations.delete(entry.root);
        closingNativeProjectRoots.delete(entry.root);
        setStatus(
          "native project authority cleanup completed for " + entry.name,
          "ok"
        );
      } catch (error) {
        entry.attempts += 1;
        entry.lastError = String(error);
      }
    }
    if (pendingNativeProjectRevocations.size > 0) {
      var attempts = Math.max.apply(null, Array.from(
        pendingNativeProjectRevocations.values(),
        function (entry) { return entry.attempts; }
      ));
      var delay = Math.min(30000, 1000 * Math.pow(2, Math.min(5, attempts - 3)));
      schedulePendingNativeProjectRevocations(delay);
      return false;
    }
    return true;
  }

  async function removeProject(id) {
    var project = findProject(id);
    if (!project || project.closing) return false;
    function hasUnresolvedCovenLaunch() {
      return state.threads.some(function (thread) {
        return thread.projectId === id
          && thread.launch
          && (thread.covenLaunchOutcomeInFlight ||
            thread.covenLaunchAcceptanceInFlight ||
            thread.retryInFlight ||
            thread.launch.launchKind === "coven-recovery" ||
            thread.launch.recoveryRequired === true);
      });
    }
    function refuseUnsettledNativeCreate() {
      if (projectNativeSessionCreateCount(id) === 0) return false;
      setStatus(
        project.name + " cannot be closed while a native session is still being created",
        "error"
      );
      return true;
    }
    if (refuseUnsettledNativeCreate()) return false;
    if (hasUnresolvedCovenLaunch()) {
      setStatus(
        project.name +
          " cannot be closed while a Coven launch outcome is unresolved; " +
          "inspect Coven before closing",
        "error"
      );
      return false;
    }
    var projectOpenFiles = state.openFiles.filter(function (file) {
      return file.projectId === id;
    });
    if (fileNavigationInFlight || fileDecisionInFlight) return false;
    fileNavigationInFlight = true;
    var canRemove;
    try {
      canRemove = await guardDirtyFiles(projectOpenFiles);
    } finally {
      fileNavigationInFlight = false;
    }
    if (!canRemove) return false;
    project = findProject(id);
    if (!project || project.closing) return false;
    if (hasUnresolvedCovenLaunch()) {
      setStatus(
        project.name +
          " cannot be closed because its Coven launch outcome became unresolved; " +
          "inspect Coven before closing",
        "error"
      );
      return false;
    }
    if (refuseUnsettledNativeCreate()) return false;
    project.closing = true;
    if (hasUnresolvedCovenLaunch() || refuseUnsettledNativeCreate()) {
      project.closing = false;
      return false;
    }
    if (project.root) closingNativeProjectRoots.add(project.root);

    var saveSection;
    try {
      saveSection = await beginWorkspaceSaveCriticalSection();
    } catch (error) {
      if (project.root) closingNativeProjectRoots.delete(project.root);
      project.closing = false;
      setStatus(
        "failed to prepare workspace persistence for " + project.name + ": " + String(error),
        "error"
      );
      return false;
    }

    var projectIndex = state.projects.indexOf(project);
    var activeProjectIdSnapshot = state.activeProjectId;
    var activeThreadIdSnapshot = state.activeThreadId;
    var activeFileIdSnapshot = state.activeFileId;
    var lastActiveThreadIdSnapshot = project.lastActiveThreadId;
    var threadSnapshot = state.threads.map(function (thread, index) {
      return thread.projectId === id ? { thread: thread, index: index } : null;
    }).filter(Boolean);
    var originalThreadIds = new Set(threadSnapshot.map(function (entry) {
      return entry.thread.id;
    }));
    var openFileSnapshot = state.openFiles.map(function (file, index) {
      return file.projectId === id ? { file: file, index: index } : null;
    }).filter(Boolean);
    var projectFilesPanes = [];
    if (typeof filesPanes !== "undefined") {
      filesPanes.forEach(function (filesPane, key) {
        if (filesPane.projectId === id) {
          projectFilesPanes.push({
            key: key,
            pane: filesPane,
            activeFileId: filesPane.activeFileId,
            previousFocusedSessionId: filesPane.previousFocusedSessionId,
            hidden: filesPane.hidden,
          });
        }
      });
    }
    var paneLayoutSnapshot = [];
    if (typeof paneLayouts !== "undefined") {
      paneLayouts.forEach(function (layout, key) {
        if (key.indexOf(id + "\u0000") === 0) {
          paneLayoutSnapshot.push([
            key,
            JSON.parse(JSON.stringify(layout)),
          ]);
        }
      });
    }
    var focusSetSnapshot = [];
    if (typeof focusSets !== "undefined") {
      focusSets.forEach(function (set, index) {
        if (set.threadIds.some(function (threadId) {
          return originalThreadIds.has(threadId);
        })) {
          focusSetSnapshot.push({
            index: index,
            set: Object.assign({}, set, { threadIds: set.threadIds.slice() }),
          });
        }
      });
    }
    var transactionSelection = null;

    function restoreProjectState() {
      if (state.projects.indexOf(project) === -1) {
        state.projects.splice(
          Math.max(0, Math.min(projectIndex, state.projects.length)),
          0,
          project
        );
      }
      var restoredThreads = state.threads.slice();
      threadSnapshot.forEach(function (entry) {
        if (restoredThreads.some(function (thread) {
          return thread.id === entry.thread.id;
        })) {
          return;
        }
        var thread = entry.thread;
        thread.closeStarted = false;
        thread.closing = false;
        thread.persistentLive = false;
        thread.spawning = false;
        thread.status = thread.launch &&
          (thread.launch.launchKind === "coven-recovery" ||
            thread.launch.recoveryRequired === true)
          ? "failed"
          : "exited";
        thread.sidebarStatusKey = thread.status === "failed" ? "error" : "done";
        thread.finishedAt = Date.now();
        thread.term = null;
        thread.host = null;
        thread.pane = null;
        thread.terminalController = null;
        thread.ptyStarted = false;
        thread.ptyGeneration = null;
        if (typeof createThreadPtyIoQueue === "function") {
          thread.ptyIoQueue = createThreadPtyIoQueue();
        }
        restoredThreads.splice(
          Math.max(0, Math.min(entry.index, restoredThreads.length)),
          0,
          thread
        );
      });
      state.threads = restoredThreads;
      var restoredFiles = state.openFiles.slice();
      openFileSnapshot.forEach(function (entry) {
        if (restoredFiles.some(function (file) { return file.id === entry.file.id; })) return;
        restoredFiles.splice(
          Math.max(0, Math.min(entry.index, restoredFiles.length)),
          0,
          entry.file
        );
      });
      state.openFiles = restoredFiles;
      if (typeof filesPanes !== "undefined") {
        projectFilesPanes.forEach(function (entry) {
          entry.pane.activeFileId = entry.activeFileId;
          entry.pane.previousFocusedSessionId = entry.previousFocusedSessionId;
          entry.pane.hidden = entry.hidden;
          entry.pane.pane = null;
          entry.pane.host = null;
          filesPanes.set(entry.key, entry.pane);
        });
      }
      if (typeof paneLayouts !== "undefined") {
        Array.from(paneLayouts.keys()).forEach(function (key) {
          if (key.indexOf(id + "\u0000") === 0) paneLayouts.delete(key);
        });
        paneLayoutSnapshot.forEach(function (entry) {
          paneLayouts.set(entry[0], JSON.parse(JSON.stringify(entry[1])));
        });
      }
      if (typeof focusSets !== "undefined") {
        var restoredSetIds = new Set(focusSetSnapshot.map(function (entry) {
          return entry.set.id;
        }));
        for (var setIndex = focusSets.length - 1; setIndex >= 0; setIndex -= 1) {
          if (restoredSetIds.has(focusSets[setIndex].id)) focusSets.splice(setIndex, 1);
        }
        focusSetSnapshot.forEach(function (entry) {
          focusSets.splice(
            Math.max(0, Math.min(entry.index, focusSets.length)),
            0,
            entry.set
          );
        });
      }
      var selectionStillOwnedByRemoval = state.activeProjectId === id ||
        (transactionSelection &&
          state.activeProjectId === transactionSelection.projectId &&
          state.activeThreadId === transactionSelection.threadId &&
          state.activeFileId === transactionSelection.fileId);
      if (selectionStillOwnedByRemoval && activeProjectIdSnapshot === id) {
        if (typeof assignActiveProjectId === "function") assignActiveProjectId(id);
        else Object.assign(state, { activeProjectId: id });
        state.activeThreadId = originalThreadIds.has(activeThreadIdSnapshot)
          ? activeThreadIdSnapshot
          : null;
        state.activeFileId = openFileSnapshot.some(function (entry) {
          return entry.file.id === activeFileIdSnapshot;
        }) ? activeFileIdSnapshot : null;
      }
      project.lastActiveThreadId = lastActiveThreadIdSnapshot;
      project.closing = false;
      if (project.root) closingNativeProjectRoots.delete(project.root);
      renderPaneWorkspace({ preserveTerminalFocus: false });
      var restoredActiveFile = state.activeProjectId === id
        ? state.openFiles.find(function (file) {
          return file.id === state.activeFileId && file.projectId === id;
        })
        : null;
      if (restoredActiveFile && fileViewEl) {
        fileViewEl.hidden = false;
        if (typeof renderFileView === "function") renderFileView();
      }
      refreshSidebar();
      refreshTabs();
      syncProjectBrowser();
    }

    async function failBeforeCommit(message) {
      restoreProjectState();
      try {
        await finishWorkspaceSaveCriticalSection(saveSection);
      } catch (saveError) {
        message += "; restored workspace persistence also failed: " + String(saveError);
      }
      setStatus(message, "error");
      return false;
    }

    covenDiscovery = PsycheSessions.invalidateCovenRequests(covenDiscovery);
    var threadIds = threadSnapshot.map(function (entry) { return entry.thread.id; });
    var closeResults = await Promise.allSettled(threadIds.map(function (threadId) {
      var preserveTerminalFocus = state.activeProjectId !== id;
      return closeThread(threadId, {
        focus: false,
        preserveTerminalFocus: preserveTerminalFocus,
        protectCovenRecovery: true,
        persist: false,
      });
    }));
    var closeFailure = closeResults.find(function (result) {
      return result.status === "rejected" || result.value === false;
    });
    if (closeFailure) {
      return failBeforeCommit(
        "failed to close every pane for " + project.name +
          (closeFailure.status === "rejected"
            ? ": " + String(closeFailure.reason)
            : "")
      );
    }
    if (projectNativeSessionCreateCount(id) !== 0) {
      return failBeforeCommit(
        project.name + " could not be closed because a native session create is unsettled"
      );
    }

    state.projects = state.projects.filter(function (candidate) {
      return candidate.id !== id;
    });
    state.openFiles = state.openFiles.filter(function (file) {
      return file.projectId !== id;
    });
    projectFilesPanes.forEach(function (entry) {
      if (typeof removeFilesPaneNow === "function") removeFilesPaneNow(entry.pane);
      else if (typeof filesPanes !== "undefined") filesPanes.delete(entry.key);
    });
    var removedActiveFile = openFileSnapshot.some(function (entry) {
      return entry.file.id === state.activeFileId;
    });
    if (removedActiveFile) {
      state.activeFileId = null;
      if (fileViewEl) fileViewEl.hidden = true;
      if (terminalHost) terminalHost.hidden = false;
    }
    var sidebarRefreshedByActiveProjectHandoff = false;
    if (state.activeProjectId === id) {
      var next = state.projects[0] || null;
      if (typeof assignActiveProjectId === "function") assignActiveProjectId(null);
      else Object.assign(state, { activeProjectId: null });
      state.activeThreadId = null;
      if (next) {
        sidebarRefreshedByActiveProjectHandoff = await setActiveProject(next.id);
        if (!sidebarRefreshedByActiveProjectHandoff) {
          return failBeforeCommit("failed to select a remaining project after closing " + project.name);
        }
      } else {
        renderPaneWorkspace({ preserveTerminalFocus: false });
        setStatus("no project — click + to open one", "");
      }
      transactionSelection = {
        projectId: state.activeProjectId,
        threadId: state.activeThreadId,
        fileId: state.activeFileId,
      };
    }
    if (!sidebarRefreshedByActiveProjectHandoff) refreshSidebar();
    else refreshTabs();
    if (removedActiveFile) syncPaneMetricsVisibility();
    syncProjectBrowser();

    try {
      await flushWorkspaceSaveCriticalSection(saveSection);
    } catch (error) {
      restoreProjectState();
      var restoreSaveError = null;
      try {
        await finishWorkspaceSaveCriticalSection(saveSection);
      } catch (saveError) {
        restoreSaveError = saveError;
      }
      setStatus(
        "failed to save removal of " + project.name + "; the project was restored: " +
          String(error) +
          (restoreSaveError
            ? "; restored workspace persistence also failed: " + String(restoreSaveError)
            : ""),
        "error"
      );
      return false;
    }
    var finalWorkspaceSaveError = null;
    try {
      await finishWorkspaceSaveCriticalSection(saveSection);
    } catch (error) {
      finalWorkspaceSaveError = error;
    }
    startCovenPolling();

    if (projectNativeSessionCreateCount(id) !== 0) {
      var unsettledCreateError = new Error(
        "native session create remained unsettled after durable project removal"
      );
      quarantineNativeProjectRevocation(project, unsettledCreateError);
      setStatus(
        project.name +
          " was removed from the workspace, but native authority revocation was deferred " +
          "because a native session create is still unsettled and cleanup was queued",
        "error"
      );
      if (typeof refreshStatusController === "function") refreshStatusController();
      return false;
    }
    if (project.root) {
      var revokeError = null;
      for (var attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await invoke("native_project_close", { root: project.root });
          revokeError = null;
          break;
        } catch (error) {
          revokeError = error;
          if (attempt < 3) {
            await waitForProjectCloseRetry(attempt === 1 ? 50 : 150);
          }
        }
      }
      if (revokeError) {
        quarantineNativeProjectRevocation(project, revokeError);
        setStatus(
          project.name +
            " was removed from the workspace, but native project authority revocation " +
            "failed after 3 attempts and was queued for background retry: " +
            String(revokeError) +
            (finalWorkspaceSaveError
              ? "; final workspace persistence also failed: " +
                String(finalWorkspaceSaveError)
              : ""),
          "error"
        );
        if (typeof refreshStatusController === "function") refreshStatusController();
        return false;
      }
      closingNativeProjectRoots.delete(project.root);
    }
    if (finalWorkspaceSaveError) {
      setStatus(
        project.name +
          " was removed and native authority was revoked, but final workspace " +
          "persistence failed: " + String(finalWorkspaceSaveError),
        "error"
      );
      if (typeof refreshStatusController === "function") refreshStatusController();
      return false;
    }
    if (typeof refreshStatusController === "function") refreshStatusController();
    return true;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ============================================================
  // 8. Tab strip render
  // ============================================================

  // Tabs == projects. Opening a project launches or focuses its Coven pane.
  // and clicking the tab restores the project's last-active physical pane.
  // Threads remain project/worktree-scoped and are managed in the sessions rail.
  // ---- File tabs (Files pane) ----

  var fileSurfaceStagingEl = document.getElementById("file-surface-staging");
  var fileViewEl = document.getElementById("file-view");
  var fileViewPathEl = document.getElementById("file-view-path");
  var fileViewMetaEl = document.getElementById("file-view-meta");
  var fileViewTitleEl = document.getElementById("file-view-title");
  var fileDirtyEl = document.getElementById("file-dirty");
  var fileSaveEl = document.getElementById("file-save");
  var fileLanguageEl = document.getElementById("file-language");
  var fileStatusEl = document.getElementById("file-status");
  var fileReadOnlyMessageEl = document.getElementById("file-read-only-message");
  var fileCursorEl = document.getElementById("file-cursor");
  var fileEditorHostEl = document.getElementById("file-editor-host");
  var dirtyFileDialogEl = document.getElementById("dirty-file-dialog");
  var dirtyFileTitleEl = document.getElementById("dirty-file-title");
  var dirtyFileMessageEl = document.getElementById("dirty-file-message");
  var dirtyFileSaveEl = document.getElementById("dirty-file-save");
  var dirtyFileDiscardEl = document.getElementById("dirty-file-discard");
  var dirtyFileCancelEl = document.getElementById("dirty-file-cancel");
  var dirtyFileReloadEl = document.getElementById("dirty-file-reload");
  var dirtyFileKeepEditingEl = document.getElementById("dirty-file-keep-editing");
  var fileCounter = 0;
  var loadedEditorFileId = null;
  var fileDecisionInFlight = null;
  var fileNavigationInFlight = false;

  var fileEditor = window.PsycheCodeEditor.createFileEditor({
    parent: fileEditorHostEl,
    onChange: function (text) {
      var file = findOpenFile(state.activeFileId);
      if (!file || file.id !== loadedEditorFileId || !isEditableFile(file)) return;
      Object.assign(file, window.PsycheCodeEditor.updateFileBuffer(file, text));
      file.saveError = null;
      file.saveState = file.dirty ? "modified" : "clean";
      renderFileChrome(file);
      refreshTabs();
    },
    onSelectionChange: function (position) {
      var file = findOpenFile(state.activeFileId);
      if (!file || file.id !== loadedEditorFileId) return;
      file.selection = { anchor: position.anchor, head: position.head };
      file.cursor = { line: position.line, column: position.column };
      renderFileCursor(file);
    },
  });

  function restoreFileEditorFocus() {
    requestAnimationFrame(function () {
      if (filesPaneHasCanvasFocus() && fileViewEl && !fileViewEl.hidden) fileEditor.focus();
    });
  }

  function showFileDecision({ mode, file }) {
    if (fileDecisionInFlight) return fileDecisionInFlight;
    var conflictMode = mode === "conflict";
    var fallback = conflictMode ? "keep-editing" : "cancel";
    var fileLabel = (file && (file.rel || file.name || file.path)) || "this file";
    dirtyFileTitleEl.textContent = conflictMode ? "File changed on disk" : "Save changes?";
    dirtyFileMessageEl.textContent = conflictMode
      ? fileLabel + " changed outside Psyche. Reload the disk version or keep your unsaved edits."
      : "Save your changes to " + fileLabel + " before continuing?";
    Array.prototype.forEach.call(
      dirtyFileDialogEl.querySelectorAll("[data-decision-mode]"),
      function (actions) { actions.hidden = actions.dataset.decisionMode !== mode; }
    );

    fileDecisionInFlight = new Promise(function (resolve) {
      var settled = false;
      var bindings = [];
      function bind(target, type, handler) {
        target.addEventListener(type, handler);
        bindings.push([target, type, handler]);
      }
      function settle(choice) {
        if (settled) return;
        settled = true;
        bindings.forEach(function (binding) {
          binding[0].removeEventListener(binding[1], binding[2]);
        });
        if (dirtyFileDialogEl.open) dirtyFileDialogEl.close();
        fileDecisionInFlight = null;
        resolve(choice);
      }
      function choose(choice) { return function () { settle(choice); }; }
      bind(dirtyFileSaveEl, "click", choose("save"));
      bind(dirtyFileDiscardEl, "click", choose("discard"));
      bind(dirtyFileCancelEl, "click", choose("cancel"));
      bind(dirtyFileReloadEl, "click", choose("reload"));
      bind(dirtyFileKeepEditingEl, "click", choose("keep-editing"));
      bind(dirtyFileDialogEl, "keydown", function (event) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          settle(fallback);
        }
      });
      bind(dirtyFileDialogEl, "cancel", function (event) {
        event.preventDefault();
        settle(fallback);
      });
      bind(dirtyFileDialogEl, "pointerdown", function (event) {
        if (event.target === dirtyFileDialogEl) settle(fallback);
      });
      dirtyFileDialogEl.showModal();
      requestAnimationFrame(function () {
        (conflictMode ? dirtyFileReloadEl : dirtyFileSaveEl).focus();
      });
    });
    return fileDecisionInFlight;
  }

  function findOpenFile(id) {
    return state.openFiles.filter(function (f) { return f.id === id; })[0] || null;
  }

  function projectFiles(projectId, workspaceRoot) {
    var project = projectId && !workspaceRoot ? findProject(projectId) :
      (!projectId ? activeProject() : null);
    var pid = projectId || (project && project.id) || state.activeProjectId;
    var root = workspaceRoot || (project ? activeWorkspaceRoot(project) : null);
    var model = workspaceModel();
    if (model && typeof model.workspaceFiles === "function") {
      return model.workspaceFiles(state.openFiles, pid, root);
    }
    return state.openFiles.filter(function (file) {
      return file.projectId === pid && file.workspaceRoot === root;
    });
  }

  function filesForPane(filesPane) {
    return filesPane
      ? projectFiles(filesPane.projectId, filesPane.workspaceRoot)
      : [];
  }

  function nextFileIdAfterClose(files, closingId) {
    var model = workspaceModel();
    if (model && typeof model.nextFileIdAfterClose === "function") {
      return model.nextFileIdAfterClose(files, closingId);
    }
    var index = files.findIndex(function (file) { return file.id === closingId; });
    var remaining = files.filter(function (file) { return file.id !== closingId; });
    var next = remaining[Math.min(Math.max(index, 0), remaining.length - 1)];
    return next ? next.id : null;
  }

  function restoreFilesPaneSelection(project, workspaceRoot) {
    var filesPane = project
      ? filesPanes.get(filesPaneKey(project.id, workspaceRoot))
      : null;
    var files = filesForPane(filesPane);
    var active = files.find(function (file) {
      return file.id === filesPane.activeFileId;
    }) || files[0] || null;
    if (filesPane) filesPane.activeFileId = active ? active.id : null;
    state.activeFileId = active ? active.id : null;
    if (fileViewEl) fileViewEl.hidden = !active;
    if (active) renderFileView();
    return active;
  }

  function activeFilesPane() {
    var project = activeProject();
    if (!project) return null;
    return filesPanes.get(filesPaneKey(project.id, activeWorkspaceRoot(project))) || null;
  }

  function rememberFilesPaneReturnThread(filesPane) {
    if (!filesPane) return null;
    var thread = findThread(state.activeThreadId);
    var processBacked = thread && thread.kind !== "web" && thread.kind !== "git" &&
      thread.kind !== "coven-code" && thread.kind !== "coven-attach";
    var live = processBacked && !thread.hidden && !thread.closing &&
      thread.status !== "exited" && thread.status !== "failed";
    if (!live || thread.projectId !== filesPane.projectId ||
        thread.worktreePath !== filesPane.workspaceRoot) {
      return filesPane.previousFocusedSessionId || null;
    }
    filesPane.previousFocusedSessionId = thread.id;
    fileFocus.returnThreadId = thread.id;
    return thread.id;
  }

  function removeFilesPaneNow(filesPane) {
    if (!filesPane) return null;
    var removedActiveFileId = filesPane.activeFileId;
    var removedReturnThreadId = filesPane.previousFocusedSessionId;
    var ownsFileSurface = fileViewEl && fileViewEl.parentElement === filesPane.host;
    var nextSurfaceId = detachThreadPane(filesPane);
    filesPanes.delete(filesPaneKey(filesPane.projectId, filesPane.workspaceRoot));
    if (state.activeFileId === removedActiveFileId) clearFileFocusPresentation();
    if (typeof fileFocus !== "undefined" &&
        fileFocus.returnThreadId === removedReturnThreadId) {
      fileFocus.returnThreadId = null;
    }
    filesPane.activeFileId = null;
    filesPane.previousFocusedSessionId = null;
    if (ownsFileSurface && fileSurfaceStagingEl) fileSurfaceStagingEl.appendChild(fileViewEl);
    if (ownsFileSurface) fileViewEl.hidden = true;
    if (filesPane.pane && typeof filesPane.pane.remove === "function") filesPane.pane.remove();
    filesPane.pane = null;
    filesPane.host = null;
    refreshTabs();
    renderPaneWorkspace();
    if (nextSurfaceId && typeof focusThread === "function") focusThread(nextSurfaceId);
    return nextSurfaceId;
  }

  async function closeFilesPane(filesPane) {
    if (!filesPane || fileNavigationInFlight || fileDecisionInFlight) return false;
    var files = filesForPane(filesPane).slice();
    fileNavigationInFlight = true;
    var canClose;
    try {
      canClose = await guardDirtyFiles(files);
    } finally {
      fileNavigationInFlight = false;
    }
    if (!canClose) return false;
    state.openFiles = state.openFiles.filter(function (file) {
      return files.indexOf(file) === -1;
    });
    removeFilesPaneNow(filesPane);
    return true;
  }

  function fileFocusThreadIsAvailable(thread, root, project, workspaceRoot, allowCoven) {
    return !!thread &&
      !thread.hidden &&
      !thread.closing &&
      thread.status !== "exited" && thread.status !== "failed" &&
      thread.projectId === project.id &&
      thread.worktreePath === workspaceRoot &&
      (allowCoven ||
        (thread.kind !== "coven-code" && thread.kind !== "coven-attach")) &&
      thread.kind !== "web" && thread.kind !== "git" &&
      !!PsychePanes.findLeafByThreadId(root, thread.id);
  }

  function resolveFileFocusThreadId(preferredId, allowPreferredCoven) {
    var project = activeProject();
    var layout = activePaneLayout();
    if (!project || !layout || !layout.root) return null;
    var root = scopedPaneRoot(layout);
    var workspaceRoot = activeWorkspaceRoot(project);
    var preferred = preferredId ? findThread(preferredId) : null;
    if (fileFocusThreadIsAvailable(
      preferred, root, project, workspaceRoot, allowPreferredCoven
    )) {
      return preferred.id;
    }

    var leafIds = PsychePanes.leafIds(root);
    var filesPane = activeFilesPane();
    var filesLeaf = filesPane
      ? PsychePanes.findLeafByThreadId(root, filesPane.id)
      : null;
    var filesIndex = filesLeaf ? leafIds.indexOf(filesLeaf.id) : -1;
    var candidates = [];
    if (filesIndex === -1) {
      candidates = leafIds.slice();
    } else {
      for (var distance = 1; distance < leafIds.length; distance += 1) {
        if (filesIndex - distance >= 0) candidates.push(leafIds[filesIndex - distance]);
        if (filesIndex + distance < leafIds.length) candidates.push(leafIds[filesIndex + distance]);
      }
    }
    for (var i = 0; i < candidates.length; i++) {
      var leaf = PsychePanes.findLeafById(root, candidates[i]);
      var thread = leaf ? findThread(leaf.threadId) : null;
      if (fileFocusThreadIsAvailable(thread, root, project, workspaceRoot, false)) {
        return thread.id;
      }
    }
    return null;
  }

  function enterFileFocus(file) {
    if (!file) return false;
    if (!state.activeFileId) {
      fileFocus.returnThreadId = state.activeThreadId || null;
    }
    state.activeFileId = file.id;
    fileViewEl.hidden = false;
    var filesPane = filesPanes.get(filesPaneKey(file.projectId, file.workspaceRoot));
    if (filesPane) {
      if (typeof rememberFilesPaneReturnThread === "function") {
        rememberFilesPaneReturnThread(filesPane);
      }
      filesPane.activeFileId = file.id;
      focusCanvasSurface(filesPane);
    }
    syncPaneMetricsVisibility();
    syncAllPtyVisibility();
    renderPaneMinimap(activePaneLayout(), file);
    return true;
  }

  function clearFileFocusPresentation() {
    state.activeFileId = null;
    fileFocus.returnThreadId = null;
    fileViewEl.hidden = true;
    syncPaneMetricsVisibility();
    syncAllPtyVisibility();
  }

  function clearPassiveCovenPaneFocus(layout) {
    var activeThread = findThread(state.activeThreadId);
    if (activeThread &&
      (activeThread.kind === "coven-code" || activeThread.kind === "coven-attach")) {
      state.activeThreadId = null;
    }
    layout = layout || activePaneLayout();
    if (!layout || !layout.root) return;
    if (layout.activeSetId) {
      var activeSet = findFocusSet(layout.activeSetId);
      var hasPassiveThread = activeSet && activeSet.threadIds.some(function (threadId) {
        var thread = findThread(threadId);
        return thread && !thread.hidden &&
          thread.kind !== "coven-code" && thread.kind !== "coven-attach" &&
          !!PsychePanes.findLeafByThreadId(layout.root, threadId);
      });
      if (!hasPassiveThread) layout.activeSetId = null;
    }
    ["focusedLeafId", "maximizedLeafId"].forEach(function (key) {
      var leaf = layout[key] ? PsychePanes.findLeafById(layout.root, layout[key]) : null;
      var thread = leaf ? findThread(leaf.threadId) : null;
      if (thread && (thread.kind === "coven-code" || thread.kind === "coven-attach")) {
        layout[key] = null;
      }
    });
  }

  async function returnFromFileFocus(explicitThreadId, maximizeDestination) {
    if (!filesPaneHasCanvasFocus()) return false;
    var activeFile = findOpenFile(state.activeFileId);
    var filesPane = activeFilesPane();
    var destinationId = resolveFileFocusThreadId(
      explicitThreadId || (filesPane
        ? filesPane.previousFocusedSessionId
        : fileFocus.returnThreadId),
      Boolean(explicitThreadId)
    );
    if (destinationId) {
      if (!(await showTerminalView())) return false;
      if (!explicitThreadId) clearPassiveCovenPaneFocus();
      var layout = activePaneLayout();
      var leaf = layout && layout.root
        ? PsychePanes.findLeafByThreadId(layout.root, destinationId)
        : null;
      var previousMaximizedLeafId = layout ? layout.maximizedLeafId : null;
      var previousFocusedLeafId = layout ? layout.focusedLeafId : null;
      if (maximizeDestination && layout && leaf) {
        layout.maximizedLeafId = leaf.id;
        layout.focusedLeafId = leaf.id;
      }
      var focused = await focusThread(destinationId);
      if (!focused && maximizeDestination && layout) {
        layout.maximizedLeafId = previousMaximizedLeafId;
        layout.focusedLeafId = previousFocusedLeafId;
        renderPaneMinimap(layout, activeFile);
      }
      return focused;
    }
    if (!(await showTerminalView())) return false;
    clearPassiveCovenPaneFocus();
    renderPaneWorkspace({ preserveTerminalFocus: false });
    refreshSidebar();
    return true;
  }

  async function openFileTab(path, project) {
    project = project || activeProject();
    if (!project || project.closing) return false;
    var workspaceRoot = activeWorkspaceRoot(project);
    var existing = state.openFiles.filter(function (f) {
      return f.path === path && f.projectId === project.id &&
        f.workspaceRoot === workspaceRoot;
    })[0];
    if (existing) return activateFileTab(existing.id);
    if (fileNavigationInFlight || fileDecisionInFlight) return false;

    var filesPane = ensureFilesPane(project, workspaceRoot);
    if (!filesPane) return false;
    fileCounter += 1;
    var rel = relativeToRoot(workspaceRoot, path);
    var file = {
      id: "f" + fileCounter,
      path: path,
      rel: rel,
      name: rel.split("/").pop() || rel,
      projectId: project.id,
      workspaceRoot: workspaceRoot,
      text: "",
      originalText: "",
      dirty: false,
      saving: false,
      savePromise: null,
      languageId: window.PsycheCodeEditor.languageForPath(rel),
      cursor: { line: 1, column: 1 },
      selection: { anchor: 0, head: 0 },
      truncated: false,
      binary: false,
      size: 0,
      error: null,
      saveError: null,
      saveState: "clean",
      loading: true,
    };
    state.openFiles.push(file);
    filesPane.activeFileId = file.id;
    activateFileTabNow(file.id);
    try {
      var res = await invoke("fs_read_text", { root: workspaceRoot, path: path });
      Object.assign(file, window.PsycheCodeEditor.createFileBuffer(res.text || ""));
      file.truncated = res.truncated;
      file.binary = res.binary;
      file.size = res.size;
    } catch (err) {
      file.error = String(err);
    }
    file.loading = false;
    if (state.activeFileId === file.id) renderFileView({ reload: true });
    return true;
  }

  function activateFileTabNow(id) {
    var file = findOpenFile(id);
    if (!file) return false;
    var project = findProject(file.projectId);
    if (project) {
      assignSelectedWorktreePath(project, file.workspaceRoot);
      if (typeof assignActiveProjectId === "function") assignActiveProjectId(project.id);
      else Object.assign(state, { activeProjectId: project.id });
    }
    var filesPane = project ? ensureFilesPane(project, file.workspaceRoot) : null;
    if (filesPane) filesPane.activeFileId = file.id;
    enterFileFocus(file);
    renderPaneWorkspace();
    markActiveSurface("terminal");
    refreshTabs();
    renderFileView();
    return true;
  }

  function revealFileForDecision(file) {
    if (!file || !findOpenFile(file.id)) return false;
    var project = findProject(file.projectId);
    if (project) {
      var workspaceRoot = file.workspaceRoot || project.root || activeWorkspaceRoot(project);
      assignSelectedWorktreePath(project, workspaceRoot);
      if (typeof assignActiveProjectId === "function") assignActiveProjectId(project.id);
      else Object.assign(state, { activeProjectId: project.id });
      var threads = state.threads.filter(function (thread) {
        return thread.projectId === project.id && !thread.hidden &&
          thread.worktreePath === workspaceRoot &&
          thread.kind !== "coven-code" && thread.kind !== "coven-attach";
      });
      var nextThreadId = project.lastActiveThreadId &&
        threads.some(function (thread) { return thread.id === project.lastActiveThreadId; })
          ? project.lastActiveThreadId
          : (threads[0] ? threads[0].id : null);
      state.activeThreadId = nextThreadId;
      clearPassiveCovenPaneFocus();
      renderPaneWorkspace({ preserveTerminalFocus: false });
      renderGitSurface();
      loadAgentSkills();
      syncProjectBrowser();
      saveWorkspaceSoon();
    }
    activateFileTabNow(file.id);
    refreshSidebar();
    return true;
  }

  async function activateFileTab(id) {
    var file = findOpenFile(id);
    if (!file) return false;
    if (state.activeFileId === id) {
      var project = findProject(file.projectId);
      if (project) ensureFilesPane(project, file.workspaceRoot);
      fileEditor.focus();
      return true;
    }
    return activateFileTabNow(id);
  }

  // Guard a focus transfer back to a canvas session. The Files pane remains
  // mounted and visible; only the active canvas leaf changes.
  async function showTerminalView() {
    if (!filesPaneHasCanvasFocus()) return true;
    clearPassiveCovenPaneFocus();
    renderPaneMinimap(activePaneLayout(), null);
    refreshTabs();
    requestAnimationFrame(function () { scheduleTerminalPaneFits(); });
    return true;
  }

  async function closeFileTab(id) {
    var file = findOpenFile(id);
    if (!file) return false;
    if (fileNavigationInFlight || fileDecisionInFlight) return false;
    fileNavigationInFlight = true;
    var canClose;
    try {
      canClose = await guardDirtyFile(file);
    } finally {
      fileNavigationInFlight = false;
    }
    if (!canClose) return false;
    var filesPane = typeof filesPanes !== "undefined"
      ? filesPanes.get(filesPaneKey(file.projectId, file.workspaceRoot))
      : null;
    var siblings = filesPane
      ? filesForPane(filesPane)
      : projectFiles(file.projectId, file.workspaceRoot);
    var nextId = typeof nextFileIdAfterClose === "function"
      ? nextFileIdAfterClose(siblings, id)
      : ((siblings[siblings.indexOf(file) + 1] || siblings[siblings.indexOf(file) - 1]) || {}).id;
    var paneWasActive = filesPane && filesPane.activeFileId === id;
    var globallyActive = state.activeFileId === id;
    state.openFiles = state.openFiles.filter(function (f) { return f.id !== id; });
    if (filesPane && paneWasActive && nextId) filesPane.activeFileId = nextId;
    var remaining = filesPane
      ? filesForPane(filesPane)
      : projectFiles(file.projectId, file.workspaceRoot);
    if (!remaining.length) {
      if (filesPane && typeof removeFilesPaneNow === "function") {
        removeFilesPaneNow(filesPane);
      } else if (globallyActive) {
        clearFileFocusPresentation();
        clearPassiveCovenPaneFocus();
        refreshTabs();
        renderPaneWorkspace({ preserveTerminalFocus: false });
      }
      return true;
    }
    if (globallyActive && nextId) activateFileTabNow(nextId);
    else refreshTabs();
    return true;
  }

  function isEditableFile(file) {
    return !!file && !file.loading && !file.error && !file.binary && !file.truncated;
  }

  function discardFile(file) {
    if (!file) return;
    Object.assign(file, window.PsycheCodeEditor.createFileBuffer(file.originalText || ""), {
      error: null,
      saveError: null,
      saveState: "clean",
      conflict: false,
    });
    if (state.activeFileId === file.id) renderFileView({ reload: true });
    refreshTabs();
  }

  async function guardDirtyFile(file) {
    if (!file) return true;
    if (file.savePromise) {
      var pendingOutcome = await file.savePromise;
      if (!pendingOutcome.backendSucceeded) {
        revealFileForDecision(file);
        restoreFileEditorFocus();
        return false;
      }
      if (!file.dirty) return true;
    }
    if (!file.dirty) return true;
    var choice = await showFileDecision({ mode: "dirty", file: file });
    if (choice === "cancel") {
      restoreFileEditorFocus();
      return false;
    }
    if (choice === "discard") {
      discardFile(file);
      return true;
    }
    var outcome = await saveFile(file);
    if (!outcome.backendSucceeded) {
      revealFileForDecision(file);
      restoreFileEditorFocus();
      return false;
    }
    if (file.dirty) return guardDirtyFile(file);
    return outcome.canContinue;
  }

  async function guardDirtyFiles(files) {
    for (var index = 0; index < files.length; index += 1) {
      if (!(await guardDirtyFile(files[index]))) return false;
    }
    return true;
  }

  function languageLabel(languageId) {
    var labels = {
      javascript: "JavaScript", typescript: "TypeScript", json: "JSON",
      html: "HTML", xml: "XML", css: "CSS", markdown: "Markdown",
      python: "Python", rust: "Rust", shell: "Shell", yaml: "YAML",
      toml: "TOML", plain: "Plain Text",
    };
    return labels[languageId] || languageId || "Plain Text";
  }

  function renderFileCursor(file) {
    if (!fileCursorEl || !file) return;
    var cursor = file.cursor || { line: 1, column: 1 };
    fileCursorEl.textContent = "Ln " + cursor.line + ", Col " + cursor.column;
  }

  function readOnlyReason(file) {
    if (file.loading) return "Loading…";
    if (file.error) return "Read-only — " + file.error;
    if (file.binary) return "Read-only — binary or invalid UTF-8 file.";
    if (file.truncated) return "Read-only — file exceeds the 512 KiB preview limit.";
    return "";
  }

  function renderFileChrome(file) {
    if (!file) return;
    var editable = isEditableFile(file);
    var lineCount = file.text ? file.text.split("\n").length : 1;
    var lineEnding = file.text.indexOf("\r\n") === -1 ? "LF" : "CRLF";
    var stateLabel = file.loading ? "Loading…" :
      file.error ? "Load failed: " + file.error :
      file.saving ? "Saving…" :
      file.saveError ? "Save failed: " + file.saveError :
      file.dirty ? "Modified" :
      file.saveState === "saved" ? "Saved" :
      editable ? "Clean" : "Read-only";

    fileViewPathEl.textContent = file.rel;
    if (fileViewTitleEl) fileViewTitleEl.textContent = file.name;
    if (fileLanguageEl) fileLanguageEl.textContent = languageLabel(file.languageId);
    if (fileViewMetaEl) {
      fileViewMetaEl.textContent = lineCount + " lines · " + file.size + " bytes" +
        (file.truncated ? " · truncated" : "");
    }
    if (fileDirtyEl) fileDirtyEl.hidden = !file.dirty;
    if (fileSaveEl) {
      fileSaveEl.disabled = !isEditableFile(file) || !file.dirty || file.saving;
      fileSaveEl.innerHTML = file.saving ? "Saving…" : "Save <kbd>⌘S</kbd>";
    }
    if (fileStatusEl) {
      fileStatusEl.textContent = stateLabel + (editable ? " · UTF-8 · " + lineEnding : "");
    }
    if (fileReadOnlyMessageEl) {
      fileReadOnlyMessageEl.hidden = editable;
      fileReadOnlyMessageEl.textContent = readOnlyReason(file);
    }
    renderFileCursor(file);
  }

  function renderFileView(options) {
    options = options || {};
    var file = findOpenFile(state.activeFileId);
    if (!file) return;
    renderFileChrome(file);
    if (loadedEditorFileId !== file.id || options.reload) {
      loadedEditorFileId = file.id;
      fileEditor.setDocument({
        text: file.text,
        languageId: file.languageId,
        readOnly: !isEditableFile(file),
        selection: file.selection,
      });
    }
  }

  async function reloadFile(file) {
    var project = file && findProject(file.projectId);
    if (!file || !project) {
      if (file) file.saveError = "Project is no longer open.";
      restoreFileEditorFocus();
      return false;
    }
    try {
      var loaded = await invoke("fs_read_text", { root: file.workspaceRoot || project.root, path: file.path });
      Object.assign(file, window.PsycheCodeEditor.createFileBuffer(loaded.text || ""), {
        loading: false,
        error: null,
        saveError: null,
        saveState: "clean",
        conflict: false,
        truncated: !!loaded.truncated,
        binary: !!loaded.binary,
        size: loaded.size,
      });
      if (state.activeFileId === file.id) renderFileView({ reload: true });
      refreshTabs();
      restoreFileEditorFocus();
      return true;
    } catch (error) {
      file.saveError = String(error);
      file.saveState = "error";
      if (state.activeFileId === file.id) renderFileChrome(file);
      restoreFileEditorFocus();
      return false;
    }
  }

  function handleFileSaveConflict(file) {
    // Task 5 owns the Reload / Keep Editing prompt. Preserve the conflict on
    // the model so that guard can present it without discarding this buffer.
    file.conflict = true;
  }

  async function performFileSave(file) {
    var project = findProject(file.projectId);
    if (!project) {
      file.saveError = "Project is no longer open.";
      revealFileForDecision(file);
      if (window.PsycheCodeEditor.shouldRenderFileSaveChrome(state.activeFileId, file.id)) {
        renderFileChrome(file);
      }
      return { backendSucceeded: false, canContinue: false };
    }

    file.saving = true;
    file.saveError = null;
    if (window.PsycheCodeEditor.shouldRenderFileSaveChrome(state.activeFileId, file.id)) {
      renderFileChrome(file);
    }
    try {
      var saved = await invoke("fs_write_text", {
        root: file.workspaceRoot || project.root,
        path: file.path,
        text: file.text,
        expectedText: file.originalText,
      });
      var textAfterSave = file.text;
      var saveOutcome = window.PsycheCodeEditor.reconcileFileSave(
        file, saved.text, textAfterSave
      );
      Object.assign(file, saveOutcome.buffer, {
        size: saved.size,
        saving: false,
        error: null,
        saveError: null,
        saveState: saveOutcome.canContinue ? "saved" : "modified",
        conflict: false,
      });
      invalidateProjectDiffs(project.id);
      if (window.PsycheCodeEditor.shouldRenderFileSaveChrome(state.activeFileId, file.id)) {
        renderFileChrome(file);
      }
      refreshTabs();
      var editedWorkspaceRoot = file.workspaceRoot || project.root;
      if (activeProject() && activeProject().id === project.id &&
          activeWorkspaceRoot(project) === editedWorkspaceRoot &&
          gitPaneIsVisible(project)) renderGitSurface({ force: true });
      setTimeout(function () {
        if (!file.dirty && file.saveState === "saved") {
          file.saveState = "clean";
          if (state.activeFileId === file.id) renderFileChrome(file);
        }
      }, 1500);
      return {
        backendSucceeded: true,
        canContinue: saveOutcome.canContinue,
      };
    } catch (error) {
      file.saving = false;
      file.saveError = String(error);
      file.saveState = "error";
      revealFileForDecision(file);
      if (file.saveError.includes("changed on disk")) handleFileSaveConflict(file);
      if (window.PsycheCodeEditor.shouldRenderFileSaveChrome(state.activeFileId, file.id)) {
        renderFileChrome(file);
      }
      if (file.conflict) {
        var conflictChoice = await showFileDecision({ mode: "conflict", file: file });
        if (conflictChoice === "reload") await reloadFile(file);
        else restoreFileEditorFocus();
      } else restoreFileEditorFocus();
      return { backendSucceeded: false, canContinue: false };
    }
  }

  function saveFile(file) {
    if (file && file.savePromise) return file.savePromise;
    if (!file || !file.dirty || file.saving || !isEditableFile(file)) {
      return Promise.resolve({ backendSucceeded: false, canContinue: false });
    }
    var operation = performFileSave(file);
    var trackedOperation = operation.finally(function () {
      if (file.savePromise === trackedOperation) file.savePromise = null;
    });
    file.savePromise = trackedOperation;
    return trackedOperation;
  }

  if (fileSaveEl) {
    fileSaveEl.addEventListener("click", function () {
      saveFile(findOpenFile(state.activeFileId));
    });
  }

  async function handleExplicitFileSave(event) {
    if (!filesPaneHasCanvasFocus()) return false;
    event.preventDefault();
    if (fileDecisionInFlight || fileNavigationInFlight || closeRequestInFlight) return false;
    return saveFile(findOpenFile(state.activeFileId));
  }

  var closeRequestInFlight = false;
  var destroyingWindow = false;
  async function handleWindowCloseRequested(event) {
    if (destroyingWindow) return;
    event.preventDefault();
    if (closeRequestInFlight || fileDecisionInFlight || fileNavigationInFlight) return;
    closeRequestInFlight = true;
    fileNavigationInFlight = true;
    try {
      if (!(await guardDirtyFiles(state.openFiles.slice()))) return;
      destroyingWindow = true;
      await saveWorkspaceNow();
      await currentWindow.destroy();
    } catch (error) {
      destroyingWindow = false;
      setStatus("close failed: " + String(error), "error");
      restoreFileEditorFocus();
    } finally {
      fileNavigationInFlight = false;
      closeRequestInFlight = false;
    }
  }
  if (currentWindow && typeof currentWindow.onCloseRequested === "function") {
    currentWindow.onCloseRequested(handleWindowCloseRequested).catch(function (error) {
      setStatus("close guard unavailable: " + String(error), "warn");
    });
  }

  // Tabs are opened files only — projects live in the sessions sidebar.
  // An empty strip means "terminal", which is the default view.
  // The edge fade is only honest when the strip actually scrolls, so it is
  // driven by measurement rather than applied unconditionally.
  function syncTabStripOverflow() {
    if (!tabStripEl) return false;
    var overflowing = tabStripEl.scrollWidth > tabStripEl.clientWidth + 1;
    tabStripEl.classList.toggle("is-overflowing", overflowing);
    return overflowing;
  }

  // With overflow, the active tab can sit off-screen after a ⌘-number jump.
  function scrollActiveTabIntoView() {
    if (!tabStripEl) return false;
    var active = tabStripEl.querySelector(".tab.active");
    if (!active || typeof active.scrollIntoView !== "function") return false;
    active.scrollIntoView({ block: "nearest", inline: "nearest" });
    return true;
  }

  function focusFileTabControl(fileId) {
    if (!tabStripEl) return false;
    var tabs = tabStripEl.querySelectorAll('[role="tab"]');
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].dataset.fileId === fileId) {
        tabs[i].focus();
        return true;
      }
    }
    return false;
  }

  async function handleFileTabKeydown(event, fileId) {
    var files = projectFiles();
    var currentIndex = files.findIndex(function (file) { return file.id === fileId; });
    if (currentIndex === -1 || files.length === 0) return false;
    var nextIndex;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + files.length) % files.length;
    else if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % files.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = files.length - 1;
    else return false;
    event.preventDefault();
    var nextFile = files[nextIndex];
    if (!(await activateFileTab(nextFile.id))) return false;
    focusFileTabControl(nextFile.id);
    return true;
  }

  function refreshTabs() {
    if (editingContext && editingContext.surface === "tabs") return;
    tabStripEl.innerHTML = "";
    var files = projectFiles();

    // Left empty on purpose: `.tab-strip:empty` collapses the row so the pane
    // canvas owns the full height until a file is actually open.
    if (files.length === 0) {
      scheduleTabMeasurements();
      return;
    }

    files.forEach(function (file, idx) {
      var isActive = state.activeFileId === file.id;
      var item = document.createElement("div");
      item.className = "file-tab-item" + (isActive ? " active" : "");
      item.dataset.fileId = file.id;

      var tab = document.createElement("button");
      tab.type = "button";
      tab.className = "tab" + (isActive ? " active" : "");
      tab.dataset.fileId = file.id;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", isActive ? "true" : "false");
      tab.tabIndex = isActive ? 0 : -1;
      tab.title = file.rel + (idx < 9 ? "  (\u2318" + (idx + 1) + ")" : "");
      var label = document.createElement("span");
      label.className = "label";
      label.textContent = file.name;
      tab.appendChild(label);
      if (file.dirty) {
        var dot = document.createElement("span");
        dot.className = "dot dirty-dot";
        dot.title = "Unsaved changes";
        dot.setAttribute("aria-label", "Unsaved changes");
        tab.appendChild(dot);
      }
      tab.addEventListener("click", async function () { await activateFileTab(file.id); });
      tab.addEventListener("keydown", function (event) {
        handleFileTabKeydown(event, file.id);
      });

      var close = document.createElement("button");
      close.type = "button";
      close.className = "close";
      close.title = "Close file (\u2318W)";
      close.setAttribute("aria-label", "Close " + file.name);
      close.tabIndex = -1;
      close.textContent = "\u00d7";
      close.addEventListener("click", async function (event) {
        event.stopPropagation();
        await closeFileTab(file.id);
      });

      // Middle-click closes, the way every other tab strip behaves.
      item.addEventListener("auxclick", async function (e) {
        if (e.button !== 1) return;
        e.preventDefault();
        await closeFileTab(file.id);
      });
      item.appendChild(tab);
      item.appendChild(close);
      tabStripEl.appendChild(item);
    });
    scheduleTabMeasurements(true);
  }

  // ============================================================
  // 9. Slash command system
  // ============================================================

  function loadRecentCommands() {
    try {
      var saved = JSON.parse(localStorage.getItem(RECENT_COMMANDS_KEY) || "[]");
      return Array.isArray(saved) ? saved.filter(Boolean).slice(0, 6) : [];
    } catch (_) { return []; }
  }
  function saveRecentCommands() {
    try { localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(recentCommands.slice(0, 6))); } catch (_) {}
  }
  function rememberCommand(line) {
    var value = String(line || "").trim();
    if (!value || value === "/help") return;
    recentCommands = [value].concat(recentCommands.filter(function (c) { return c !== value; })).slice(0, 6);
    saveRecentCommands();
  }
  function commandGroupFor(head) {
    if (head === "/preview" || head === "/browser" || head === "/browser-tab") return "Browser";
    if (head === "/open-project" || head === "/rename-project" || head === "/settings") return "Project";
    if (head === "/skills" || head === "/reload-skills") return "Agent";
    return "Psyche";
  }

  async function runNewThreadCommand() {
    return ensureProjectCoven(activeProject());
  }

  async function runNewShellCommand() {
    return createTerminalPane();
  }

  async function runNewPsycheCommand() {
    if (!(await prepareDefaultThreadCreation())) return null;
    return spawnPsycheThread();
  }

  var commands = [
    {
      cmd: "/new-thread",
      desc: "Spawn a new Coven CLI thread",
      run: runNewThreadCommand,
    },
    {
      cmd: "/new-shell",
      desc: "Spawn a plain login shell",
      run: runNewShellCommand,
    },
    {
      cmd: "/new-psyche",
      desc: "Spawn a thread running the psyche TUI",
      run: runNewPsycheCommand,
    },
    {
      cmd: "/close",
      desc: "Close the active thread",
      run: function () { return requestThreadClose(findThread(state.activeThreadId)); },
    },
    {
      cmd: "/preview",
      desc: "Load a URL in the browser pane: /preview localhost:5173",
      run: function (rest) {
        return rest ? navigateBrowser(rest) : openBlankBrowserTab();
      },
    },
    {
      cmd: "/browser-tab",
      desc: "Open a project-scoped browser tab: /browser-tab example.com",
      run: async function (rest) {
        var tab = await openBlankBrowserTab({ requireNew: true });
        if (tab && rest) return navigateBrowser(rest, { tabId: tab.id, replace: true });
      },
    },
    {
      cmd: "/settings",
      desc: "Show or set: projects 8, browser-tabs 6, bg-opacity 70, theme claude-orange, solid on",
      run: function (rest) {
        var parts = rest.split(/\s+/).filter(Boolean);
        function summary() {
          return "projects " + settings.maxProjects + "/" + HARD_MAX_PROJECTS +
            ", browser-tabs " + settings.maxBrowserTabsPerProject + "/" + HARD_MAX_BROWSER_TABS_PER_PROJECT +
            ", bg-opacity " + Math.round(settings.bgOpacity * 100) + "%" +
            ", theme " + settings.theme +
            ", solid " + (settings.solidBg ? "on" : "off");
        }
        if (parts.length === 0) {
          writeToActive("\r\n\x1b[36m[settings]\x1b[0m " + summary() + "\r\n");
          return;
        }
        if (parts.length >= 2 && parts[0] === "projects") {
          settings.maxProjects = clampInt(parts[1], settings.maxProjects, 1, HARD_MAX_PROJECTS);
        } else if (parts.length >= 2 && parts[0] === "browser-tabs") {
          settings.maxBrowserTabsPerProject = clampInt(parts[1], settings.maxBrowserTabsPerProject, 1, HARD_MAX_BROWSER_TABS_PER_PROJECT);
        } else if (parts.length >= 2 && parts[0] === "bg-opacity") {
          // Accept both 0-1 and a 0-100 percentage, since both read naturally.
          var raw = parseFloat(parts[1]);
          if (Number.isFinite(raw) && raw > 1) raw = raw / 100;
          applyBgOpacity(raw);
        } else if (parts.length >= 2 && parts[0] === "theme") {
          if (THEMES.indexOf(parts[1]) === -1) {
            writeToActive("\r\n\x1b[33m[/settings]\x1b[0m themes: " + THEMES.join(", ") + "\r\n");
            return;
          }
          applyTheme(parts[1]);
        } else if (parts.length >= 2 && parts[0] === "solid") {
          applySolidBg(parts[1] === "on" || parts[1] === "true" || parts[1] === "1");
        } else {
          writeToActive("\r\n\x1b[33m[/settings]\x1b[0m try /settings projects 8, browser-tabs 6, bg-opacity 70, theme claude-orange, or solid on\r\n");
          return;
        }
        saveSettings();
        saveWorkspaceSoon();
        writeToActive("\r\n\x1b[36m[settings]\x1b[0m " + summary() + "\r\n");
      },
    },
    {
      cmd: "/browser",
      desc: "Open or focus the Web pane",
      run: function () { openBlankBrowserTab(); },
    },
    {
      cmd: "/git",
      desc: "Open or focus the Git pane",
      run: function () { return openOrFocusGitPane(); },
    },
    {
      cmd: "/terminal",
      desc: "Show the terminal canvas",
      run: function () { return showTerminalView(); },
    },
    {
      cmd: "/run",
      desc: "Type a command into the active terminal: /run pwd",
      run: function (rest) { sendToActive(rest + "\n"); },
    },
    {
      cmd: "/open-project",
      desc: "Open a project folder via the native picker",
      run: function () { openProjectPicker(); },
    },
    {
      cmd: "/rename",
      desc: "Rename the active thread: /rename frontend",
      run: function (rest) {
        if (!state.activeThreadId) return;
        if (!rest) {
          writeToActive("\r\n\x1b[33m[/rename]\x1b[0m needs a name. Try /rename frontend\r\n");
          return;
        }
        if (renameThread(state.activeThreadId, rest)) {
          refreshSidebar();
          refreshTabs();
        }
      },
    },
    {
      cmd: "/rename-project",
      desc: "Rename the active project: /rename-project Backend",
      run: function (rest) {
        var p = activeProject();
        if (!p) return;
        if (!rest) {
          writeToActive(
            "\r\n\x1b[33m[/rename-project]\x1b[0m needs a name. Try /rename-project Backend\r\n"
          );
          return;
        }
        if (renameProject(p.id, rest)) {
          refreshSidebar();
        }
      },
    },
    {
      cmd: "/skills",
      desc: "List skills + plugins discovered for the active agent harness",
      run: function () {
        if (state.agentSkills.length === 0) {
          loadAgentSkills();
          writeToActive(
            "\r\n\x1b[2;90m[skills]\x1b[0m no agent skills discovered yet — " +
            "scanning ~/.claude and project .claude trees.\r\n"
          );
          return;
        }
        var lines = state.agentSkills.map(function (s) {
          var tag = s.source === "plugin" ? "plugin " + s.origin : s.source;
          return "  " + s.name + "  \x1b[2;90m(" + s.kind + " · " + tag + ")\x1b[0m" +
            (s.description ? "  — " + s.description : "");
        });
        writeToActive(
          "\r\n\x1b[36m[" + state.agentSkills.length + " agent skills/plugins]\x1b[0m\r\n" +
          lines.join("\r\n") + "\r\n"
        );
      },
    },
    {
      cmd: "/reload-skills",
      desc: "Re-scan ~/.claude and project .claude for skills + plugins",
      run: function () { loadAgentSkills(true); },
    },
    {
      cmd: "/help",
      desc: "Show this command list",
      run: function () { openPalette("/", true); },
    },
  ];

  /**
   * Load slash commands the active agent harness will recognise (skills,
   * project + user commands, plugin-supplied commands). Currently scoped to
   * the Claude Code harness.
   */
  function loadAgentSkills(verbose) {
    var project = activeProject();
    var workspaceRoot = activeWorkspaceRoot(project);
    invoke("agent_skills", {
      harness: "claude",
      projectRoot: workspaceRoot || null,
      project_root: workspaceRoot || null,
    }).then(function (skills) {
      state.agentSkills = Array.isArray(skills) ? skills : [];
      if (verbose) {
        writeToActive(
          "\r\n\x1b[36m[reload-skills]\x1b[0m discovered " +
          state.agentSkills.length + " entries.\r\n"
        );
      }
      // Re-render the palette in place if it's currently open.
      if (paletteVisible) openPalette();
    }).catch(function (err) {
      if (verbose) {
        writeToActive("\r\n\x1b[31m[reload-skills]\x1b[0m " + err + "\r\n");
      }
    });
  }

  /** `!line` runs in the focused shell pane, or the first open shell in the active project. */
  function runShellSigil(line) {
    if (!line) return;
    var focused = findThread(state.activeThreadId);
    var target = focused && (focused.kind || "shell") === "shell"
      ? focused
      : activeProjectThreads().find(function (thread) {
          return (thread.kind || "shell") === "shell" && thread.status !== "exited";
        });
    if (!target) { toast("No shell pane open — ⌘T opens one"); return; }
    rememberCommand("!" + line);
    focusThread(target.id);
    sendToThread(target, line + "\n");
    toast("Ran in " + target.name);
  }

  /** `%name` jumps to a pane by name, putting it back on the canvas. */
  function runPaneSigil(query) {
    var needle = String(query || "").trim().toLowerCase();
    var candidates = activeProjectThreads();
    var match = needle
      ? candidates.find(function (thread) {
          return thread.name.toLowerCase().indexOf(needle) !== -1;
        })
      : candidates[0];
    if (!match) { toast("No pane matches “" + query + "”"); return; }
    focusThread(match.id);
  }

  function runCommand(line) {
    var trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.charAt(0) === "?") {
      commandInput.value = trimmed;
      openPalette(trimmed, true);
      syncComposerChrome();
      return;
    }
    if (trimmed[0] === "!") { runShellSigil(trimmed.slice(1).trim()); return; }
    if (trimmed[0] === "%") { runPaneSigil(trimmed.slice(1)); return; }
    if (trimmed[0] !== "/") {
      // Not a slash command — it goes to the focused pane.
      var focused = findThread(state.activeThreadId);
      if (!focused) {
        toast("No focused pane to send to");
        return;
      }
      if (focused.kind === "web" || focused.status === "exited" || focused.status === "failed") {
        toast("Focused pane cannot receive text");
        return;
      }
      sendToThread(focused, trimmed + "\n");
      return;
    }
    commandHistory.push(trimmed);
    rememberCommand(trimmed);
    var space = trimmed.indexOf(" ");
    var head = space === -1 ? trimmed : trimmed.slice(0, space);
    var rest = space === -1 ? "" : trimmed.slice(space + 1).trim();
    var match = commands.find(function (c) { return c.cmd === head; });
    if (match) {
      try {
        var commandResult = match.run(rest);
        if (commandResult && typeof commandResult.catch === "function") {
          commandResult.catch(function (e) {
            writeToActive("\r\n[/" + head + " failed: " + e + "]\r\n");
          });
        }
      }
      catch (e) { writeToActive("\r\n[/" + head + " failed: " + e + "]\r\n"); }
      return;
    }
    // Unknown to the Tauri shell — pass the slash command through to the
    // active terminal so the agent harness running there (Claude Code,
    // Codex, etc.) can interpret it as one of its own skills/plugins.
    if (!state.activeThreadId) {
      writeToActive(
        "\r\n\x1b[33m[" + head + "]\x1b[0m no active thread to receive this command\r\n"
      );
      return;
    }
    sendToActive(trimmed + "\n");
  }

  function sendToActive(text) {
    var thread = findThread(state.activeThreadId);
    if (!thread) return;
    sendToThread(thread, text);
  }

  // ---- Composer chrome ----
  //
  // Plain text always lands in the focused pane, so the composer only has to
  // keep the send button and its hint in step with what has been typed.
  function syncComposerChrome() {
    var rawValue = commandInput ? commandInput.value : "";
    var value = rawValue.trim();
    var sessionSearchOpen = rawValue.charAt(0) === "?";
    if (composerSendEl) {
      composerSendEl.hidden = sessionSearchOpen || value.length === 0;
      composerSendEl.firstChild.textContent = value[0] === "/" ? "Run " : "Send ";
    }
    if (composerMicEl) composerMicEl.hidden = rawValue.length > 0;
    if (composerSendHintEl) {
      composerSendHintEl.textContent = sessionSearchOpen || !value
        ? ""
        : value[0] === "/" ? "runs command"
        : value[0] === "!" ? "runs in the focused terminal"
        : value[0] === "%" ? "jumps to a pane"
        : "→ focused pane";
    }
    if (commandInput) {
      commandInput.setAttribute(
        "aria-label",
        sessionSearchOpen
          ? "Search sessions, " + paletteFiltered.length +
            (paletteFiltered.length === 1 ? " result" : " results")
          : "Command composer"
      );
    }
  }

  if (composerSendEl) {
    composerSendEl.addEventListener("click", function () {
      var line = commandInput.value;
      if (!line.trim()) return;
      runCommand(line);
      commandInput.value = "";
      hidePalette();
      syncComposerChrome();
      commandInput.focus();
    });
  }
  if (composerMicEl) {
    composerMicEl.addEventListener("click", function () {
      // Dictation is a system service, not something this shell implements.
      toast("Dictation is a macOS service — press fn twice with the composer focused");
      commandInput.focus();
    });
  }
  function sendToThread(thread, text) {
    if (!thread || thread.kind === "web") return Promise.resolve(false);
    var queue = thread.ptyIoQueue;
    if (!queue) {
      queue = createThreadPtyIoQueue();
      thread.ptyIoQueue = queue;
    }
    var encoded = new TextEncoder().encode(text);
    var pendingBytes = queue.pendingInputBytes;
    var pendingWrites = queue.pendingInputWrites;
    if (queue.closed ||
        pendingBytes + encoded.length > MAX_PENDING_PTY_INPUT_BYTES ||
        pendingWrites >= MAX_PENDING_PTY_INPUT_WRITES) {
      if (thread.terminalController) {
        thread.terminalController.write("\r\n\x1b[31m[pty_write]\x1b[0m input queue is full\r\n");
      }
      return Promise.resolve(false);
    }
    var bytes = Array.from(encoded);
    noteThreadInput(thread, text);
    queue.pendingInputBytes = pendingBytes + bytes.length;
    queue.pendingInputWrites = pendingWrites + 1;
    var previous = queue.inputTail;
    var result = previous.then(function () {
      if (queue.closed) return false;
      var args = {
        threadId: thread.id,
        thread_id: thread.id,
        bytes: bytes,
      };
      var generation = Number.isSafeInteger(thread.ptyGeneration) && thread.ptyGeneration > 0
        ? thread.ptyGeneration
        : null;
      if (generation !== null) args.generation = generation;
      return invoke("pty_write", args).then(function () {
        return true;
      });
    }).catch(function (err) {
      if (thread.terminalController) {
        thread.terminalController.write("\r\n\x1b[31m[pty_write]\x1b[0m " + err + "\r\n");
      }
      return false;
    });
    queue.inputTail = result.then(function (delivered) {
      queue.pendingInputBytes = Math.max(0, queue.pendingInputBytes - bytes.length);
      queue.pendingInputWrites = Math.max(0, queue.pendingInputWrites - 1);
      return delivered;
    });
    return result;
  }
  function writeToActive(text) {
    var thread = findThread(state.activeThreadId);
    if (thread && thread.terminalController) thread.terminalController.write(text);
  }

  // -------- Palette --------
  //
  // Palette entries are normalised to a shared shape so built-in Tauri
  // commands and discovered agent-harness skills/plugins can render in one
  // list:
  //   { cmd, desc, badge, kind: "builtin" | "agent" }

  var paletteIndex = 0;
  var paletteVisible = false;
  var paletteFiltered = [];
  var sessionSearchActivationGeneration = 0;

  function builtinPaletteEntries() {
    return commands.map(function (c) {
      return { cmd: c.cmd, desc: c.desc, badge: "psyche", kind: "builtin", group: commandGroupFor(c.cmd), hint: "Tab" };
    });
  }

  function recentPaletteEntries() {
    return recentCommands.map(function (cmd) {
      var head = cmd.split(/\s+/)[0];
      return { cmd: cmd, desc: "Recent command", badge: "recent", kind: "recent", group: "Recent", hint: "↵" };
    });
  }

  function agentSkillPaletteEntries() {
    return state.agentSkills.map(function (s) {
      // "claude · skill · plugin foo" / "claude · command · user"
      var parts = [s.harness, s.kind];
      if (s.source === "plugin") parts.push("plugin " + s.origin);
      else parts.push(s.source);
      return {
        cmd: s.name,
        desc: s.description || "",
        badge: parts.join(" · "),
        kind: "agent",
        group: "Agent",
        hint: "↵",
      };
    });
  }

  var PALETTE_SIGILS = "/!%?";

  /** `%` lists the project's panes so the composer can jump between them. */
  function panePaletteEntries() {
    var onCanvas = canvasThreadIds();
    return activeProjectThreads().map(function (thread) {
      return {
        cmd: "%" + thread.name,
        desc: (thread.kind || "shell") + " · " + shortenRoot(thread.worktreePath || ""),
        badge: onCanvas.indexOf(thread.id) !== -1
          ? (thread.id === state.activeThreadId ? "focused" : "on canvas")
          : "off canvas",
        kind: "pane",
        group: "Panes — jump",
        hint: "↵",
      };
    });
  }

  /** `!` recalls shell lines already run through the composer. */
  function shellPaletteEntries(rest) {
    var entries = [];
    if (rest) {
      entries.push({
        cmd: "!" + rest,
        desc: "Run now in the focused terminal",
        badge: "shell",
        kind: "shell",
        group: "Shell",
        hint: "↵",
        pinned: true,
      });
    }
    recentCommands.filter(function (cmd) { return cmd[0] === "!"; }).forEach(function (cmd) {
      entries.push({ cmd: cmd, desc: "Recent shell line", badge: "recent", kind: "shell", group: "Shell", hint: "↵" });
    });
    return entries;
  }

  function buildSessionSearchEntries(query) {
    var now = Date.now();
    var selectedThread = findThread(state.activeThreadId);
    var selectedProject = selectedThread && findProject(selectedThread.projectId);
    var selectedKey = selectedThread && selectedProject
      ? PsycheSessions.localSidebarSelectionKey(selectedProject, selectedThread)
      : settings.selectedSessionKey;
    var assignments = covenSessionAssignments();
    var projectModels = state.projects.map(function (project) {
      var projectModel = PsycheSessions.buildSidebarProjectModel({
        project: project,
        localSessions: state.threads.filter(function (thread) {
          return thread.projectId === project.id &&
            !thread.hidden && !isDormantThread(thread);
        }),
        covenSessions: covenSessionsForProject(project, assignments),
        query: query,
        filter: sessionTypeFilter,
        selectedKey: selectedKey,
        now: now,
      });
      return projectModel.visibleCount === 0 ? null : projectModel;
    }).filter(Boolean);

    return PsycheSessions.flattenSidebarSearchResults(projectModels).map(function (result) {
      return {
        cmd: result.title,
        desc: [result.projectTitle, result.branchTitle, result.meta]
          .filter(Boolean).join(" · "),
        badge: result.status.label,
        hint: "↵",
        kind: "session",
        group: "Sessions",
        key: result.key,
        sessionSource: result.source,
        sessionId: result.id,
        selectionKey: result.selectionKey,
        projectId: result.projectId,
      };
    });
  }

  function paletteCorpus(sigil, rest) {
    if (sigil === "%") return panePaletteEntries();
    if (sigil === "!") return shellPaletteEntries(rest);
    return recentPaletteEntries().concat(builtinPaletteEntries(), agentSkillPaletteEntries());
  }

  function openPalette(query, force) {
    var raw = String(query == null ? commandInput.value : query).trim();
    var typedSigil = commandInput.value.charAt(0);
    var sigil = force ? (raw.charAt(0) || "/") : typedSigil;
    if (!force && PALETTE_SIGILS.indexOf(typedSigil) === -1) {
      hidePalette();
      return;
    }
    if (PALETTE_SIGILS.indexOf(sigil) === -1) sigil = "/";
    var rest = raw.slice(1).trim();
    var q = sigil === "/" ? raw.toLowerCase() : rest.toLowerCase();
    if (sigil === "?") {
      paletteFiltered = buildSessionSearchEntries(rest);
    } else {
      paletteFiltered = paletteCorpus(sigil, rest).filter(function (c) {
        if (c.pinned) return true;
        var hay = (c.cmd + " " + (c.desc || "") + " " + (c.badge || "")).toLowerCase();
        return c.cmd.toLowerCase().indexOf(q) === 0 || hay.indexOf(q) !== -1;
      });
    }
    if (paletteFiltered.length === 0 && sigil !== "?") {
      hidePalette();
      return;
    }
    paletteIndex = Math.min(paletteIndex, Math.max(0, paletteFiltered.length - 1));
    commandInput.setAttribute("aria-expanded", "true");
    renderPalette();
    paletteEl.hidden = false;
    paletteVisible = true;
  }
  function hidePalette() {
    paletteEl.hidden = true;
    paletteVisible = false;
    paletteIndex = 0;
    commandInput.setAttribute("aria-expanded", "false");
    commandInput.removeAttribute("aria-activedescendant");
  }
  async function runSessionSearchPick(pick) {
    var project = findProject(pick.projectId);
    if (!project) { toast("Session is no longer available"); return false; }
    if (pick.sessionSource === "psyche") {
      function resolveLocalThread() {
        var candidate = findThread(pick.sessionId);
        if (!candidate || candidate.projectId !== project.id || candidate.hidden ||
            candidate.closing || candidate.closeStarted ||
            isDormantThread(candidate) || candidate.status === "failed") return null;
        return candidate;
      }
      var thread = resolveLocalThread();
      if (!thread) {
        toast("Session is no longer available"); return false;
      }
      if ((project.id !== state.activeProjectId ||
           project.selectedWorktreePath !== thread.worktreePath) &&
          !(await activateProjectWorktree(
            project, thread.worktreePath, { focusTerminal: false }
          ))) return false;
      project = findProject(pick.projectId);
      if (!project) return false;
      thread = resolveLocalThread();
      if (!thread) return false;
      var previousPresentation = snapshotSetScopePresentation(thread);
      var scopeChanged = applySetScopeForThread(thread);
      var appliedPresentation = scopeChanged
        ? snapshotSetScopePresentation(thread)
        : null;
      function restorePreviousPresentation() {
        if (!scopeChanged) return;
        restoreSetScopePresentation(previousPresentation, appliedPresentation);
      }
      var focused = await focusThread(thread.id, { focusTerminal: false });
      if (!focused) {
        restorePreviousPresentation();
        return false;
      }
      thread = resolveLocalThread();
      if (!thread || state.activeThreadId !== thread.id) {
        restorePreviousPresentation();
        return false;
      }
      settings.selectedSessionKey = pick.selectionKey;
      saveSettings();
      return true;
    }
    var session = covenSessionsForProject(project).find(function (candidate) {
      return candidate.id === pick.sessionId;
    });
    if (!session) { toast("Session is no longer available"); return false; }
    var opened = await openCovenSession(project, session, { focusTerminal: false });
    if (!opened) return false;
    settings.selectedSessionKey = pick.selectionKey;
    saveSettings();
    return true;
  }
  async function runPalettePick(pick, mode) {
    if (!pick) return;
    if (pick.kind === "session") {
      var activationGeneration = ++sessionSearchActivationGeneration;
      var activationQuery = commandInput.value;
      var selected = false;
      try {
        selected = await runSessionSearchPick(pick);
      } finally {
        var activationCurrent =
          activationGeneration === sessionSearchActivationGeneration &&
          commandInput.value === activationQuery;
        if (activationCurrent) {
          if (selected) {
            commandInput.value = "";
            hidePalette();
          }
          syncComposerChrome();
          commandInput.focus();
        }
      }
      return;
    }
    var runsImmediately = pick.kind === "agent" || pick.kind === "recent" ||
      pick.kind === "pane" || pick.kind === "shell" || mode === "run";
    if (runsImmediately) {
      runCommand(pick.cmd);
      commandInput.value = "";
      hidePalette();
      syncComposerChrome();
      commandInput.focus();
      return;
    }
    commandInput.value = pick.cmd + " ";
    hidePalette();
    syncComposerChrome();
    commandInput.focus();
  }

  function ensurePaletteActiveVisible() {
    var active = paletteEl.querySelector(".palette-item.active");
    if (!active) return;
    active.scrollIntoView({ block: "nearest" });
  }

  function renderPalette() {
    paletteEl.replaceChildren();
    commandInput.removeAttribute("aria-activedescendant");
    if (paletteFiltered.length === 0 && commandInput.value.charAt(0) === "?") {
      var empty = document.createElement("div");
      empty.className = "palette-empty";
      empty.textContent = "No matching sessions";
      paletteEl.appendChild(empty);
      paletteEl.hidden = false;
      paletteVisible = true;
      return;
    }
    var lastGroup = "";
    paletteFiltered.forEach(function (c, idx) {
      if (c.group !== lastGroup) {
        lastGroup = c.group;
        var heading = document.createElement("div");
        heading.className = "palette-section";
        heading.textContent = lastGroup || "Commands";
        paletteEl.appendChild(heading);
      }
      var div = document.createElement("div");
      var kindClass = c.kind === "session" ? " palette-session" : " palette-" + c.kind;
      div.className = "palette-item" + kindClass + (idx === paletteIndex ? " active" : "");
      div.id = "palette-option-" + idx;
      div.setAttribute("role", "option");
      div.setAttribute("aria-selected", idx === paletteIndex ? "true" : "false");
      div.innerHTML =
        '<span class="cmd">' + escapeHtml(c.cmd) + "</span>" +
        '<span class="desc">' +
          (c.desc ? escapeHtml(c.desc) : "") +
          (c.badge ? '<span class="badge">' + escapeHtml(c.badge) + "</span>" : "") +
        "</span>" +
        '<span class="hint-key">' + escapeHtml(c.hint || "↵") + "</span>";
      div.addEventListener("click", function () { runPalettePick(c); });
      paletteEl.appendChild(div);
      if (idx === paletteIndex) {
        commandInput.setAttribute("aria-activedescendant", div.id);
      }
    });
    ensurePaletteActiveVisible();
  }

  commandInput.addEventListener("input", function () {
    sessionSearchActivationGeneration += 1;
    if (PALETTE_SIGILS.indexOf(commandInput.value.charAt(0)) !== -1) openPalette();
    else hidePalette();
    syncComposerChrome();
  });
  commandInput.addEventListener("keydown", function (e) {
    var sessionSearchOpen = commandInput.value.charAt(0) === "?";
    if (paletteVisible) {
      if (e.key === "ArrowDown") {
        if (paletteFiltered.length > 0) {
          paletteIndex = (paletteIndex + 1) % paletteFiltered.length;
          renderPalette();
        }
        if (sessionSearchOpen) e.stopPropagation();
        e.preventDefault();
        return;
      }
      if (e.key === "ArrowUp") {
        if (paletteFiltered.length > 0) {
          paletteIndex = (paletteIndex - 1 + paletteFiltered.length) % paletteFiltered.length;
          renderPalette();
        }
        if (sessionSearchOpen) e.stopPropagation();
        e.preventDefault();
        return;
      }
      if (e.key === "Enter" && sessionSearchOpen) {
        e.stopPropagation();
        e.preventDefault();
        var sessionPick = paletteFiltered[paletteIndex];
        if (sessionPick) runPalettePick(sessionPick);
        return;
      }
      if (e.key === "Tab") {
        if (sessionSearchOpen) {
          e.stopPropagation();
          e.preventDefault();
          return;
        }
        var pick = paletteFiltered[paletteIndex];
        if (pick.kind === "recent") commandInput.value = pick.cmd;
        else commandInput.value = pick.cmd + (pick.kind === "agent" ? "" : " ");
        hidePalette();
        e.preventDefault();
        return;
      }
      if (e.key === "Escape") {
        if (sessionSearchOpen) {
          commandInput.value = "";
          e.stopPropagation();
        }
        hidePalette();
        syncComposerChrome();
        commandInput.focus();
        e.preventDefault();
        return;
      }
    }
    if (e.key === "Enter") {
      var line = commandInput.value;
      var sigil = line.trim()[0];
      if (paletteVisible && (sigil === "/" || sigil === "%") && line.indexOf(" ") === -1 &&
          paletteFiltered[paletteIndex]) {
        line = paletteFiltered[paletteIndex].cmd;
      }
      runCommand(line);
      commandInput.value = "";
      hidePalette();
      syncComposerChrome();
      e.preventDefault();
    }
  });

  // ============================================================
  // 10. Browser preview (Tauri child Webview)
  // ============================================================

  function browserLabelForTab(project, tab) {
    var projectId = project ? project.id : "default";
    var tabId = tab ? tab.id : "default";
    return projectId + "__" + tabId;
  }
  function browserTabLifecycle(tab) {
    if (!tab) return { closing: false, generation: 0, invalidationGeneration: 0, navigationTail: null, operationGeneration: 0, pendingOperation: null, activationOperation: null, cleanupGeneration: 0, cleanupOperation: null, replacementOperation: null, authorityTransition: false, quarantinedControlGeneration: 0, confirmedAbsentControlGeneration: 0, automationTail: null, automationSource: null, nativeLabel: null, pendingGeneration: 0, pendingUrl: null, pendingNavigationToken: null, pendingTitle: null, pendingTitleUrl: null, pendingTitleGeneration: 0, pendingTitleNavigationToken: null, liveGeneration: 0, liveUrl: null, liveNavigationToken: null, eventUrl: null, viewLive: false, navigationSnapshot: null };
    var lifecycle = browserTabLifecycleStates.get(tab);
    if (!lifecycle) {
      lifecycle = { closing: false, generation: 0, invalidationGeneration: 0, navigationTail: null, operationGeneration: 0, pendingOperation: null, activationOperation: null, cleanupGeneration: 0, cleanupOperation: null, replacementOperation: null, authorityTransition: false, quarantinedControlGeneration: 0, confirmedAbsentControlGeneration: 0, automationTail: null, automationSource: null, nativeLabel: null, pendingGeneration: 0, pendingUrl: null, pendingNavigationToken: null, pendingTitle: null, pendingTitleUrl: null, pendingTitleGeneration: 0, pendingTitleNavigationToken: null, liveGeneration: 0, liveUrl: null, liveNavigationToken: null, eventUrl: null, viewLive: tab.created === true, navigationSnapshot: null };
      browserTabLifecycleStates.set(tab, lifecycle);
    }
    return lifecycle;
  }
  function browserPaneLifecycle(thread) {
    if (!thread) return { tearingDown: false };
    var lifecycle = browserPaneLifecycleStates.get(thread);
    if (!lifecycle) {
      lifecycle = { tearingDown: false };
      browserPaneLifecycleStates.set(thread, lifecycle);
    }
    return lifecycle;
  }
  function browserTabIsClosing(tab) {
    return !!tab && browserTabLifecycle(tab).closing;
  }
  function browserPaneIsClosing(thread) {
    return !!thread && (
      thread.closing ||
      thread.closeStarted ||
      browserPaneLifecycle(thread).tearingDown
    );
  }
  function beginBrowserNavigation(tab) {
    var lifecycle = browserTabLifecycle(tab);
    lifecycle.generation += 1;
    return lifecycle.generation;
  }
  function invalidateBrowserNavigation(tab) {
    var lifecycle = browserTabLifecycle(tab);
    lifecycle.generation += 1;
    lifecycle.invalidationGeneration += 1;
    lifecycle.pendingGeneration = 0;
    lifecycle.pendingUrl = null;
    lifecycle.pendingNavigationToken = null;
    lifecycle.pendingTitle = null;
    lifecycle.pendingTitleUrl = null;
    lifecycle.pendingTitleGeneration = 0;
    lifecycle.pendingTitleNavigationToken = null;
    lifecycle.eventUrl = null;
    lifecycle.navigationSnapshot = null;
    return lifecycle.generation;
  }
  function browserNavigationIsCurrent(context) {
    if (!context || browserTabIsClosing(context.tab) || browserPaneIsClosing(context.pane)) return false;
    if (browserTabLifecycle(context.tab).generation !== context.generation) return false;
    if (context.browser.tabs.indexOf(context.tab) === -1) return false;
    if (context.activeTabReuse && context.browser.activeTabId !== context.tab.id) return false;
    if (ensureBrowserModel(context.project, context.worktreePath) !== context.browser) return false;
    if (findThread(context.pane.id) !== context.pane) return false;
    return findBrowserPane(context.project.id, context.worktreePath) === context.pane;
  }
  function browserNavigationOwnsVisiblePane(context) {
    if (!context || !context.project || state.activeProjectId !== context.project.id) return false;
    if (!context.browser || !context.tab || context.browser.activeTabId !== context.tab.id) return false;
    var project = activeProject();
    if (!project || project !== context.project || project.id !== context.project.id ||
        activeWorkspaceRoot(project) !== context.worktreePath) return false;
    if (findThread(context.pane.id) !== context.pane ||
        findBrowserPane(context.project.id, context.worktreePath) !== context.pane ||
        browserPaneIsClosing(context.pane) || context.pane.hidden) return false;
    return !!visibleBrowserBounds();
  }
  async function discardObsoleteBrowserNavigation(context) {
    var lifecycle = browserTabLifecycle(context.tab);
    var cleanupResolve;
    var cleanupOperation = {
      id: lifecycle.cleanupGeneration + 1,
      promise: new Promise(function (resolve) { cleanupResolve = resolve; }),
    };
    lifecycle.cleanupGeneration = cleanupOperation.id;
    lifecycle.cleanupOperation = cleanupOperation;
    var retireNavigationView = function () {
      if (context.preserveQueuedNavigation) {
        lifecycle.generation += 1;
        lifecycle.pendingGeneration = 0;
        lifecycle.pendingUrl = null;
        lifecycle.pendingNavigationToken = null;
        lifecycle.pendingTitle = null;
        lifecycle.pendingTitleUrl = null;
        lifecycle.pendingTitleGeneration = 0;
        lifecycle.pendingTitleNavigationToken = null;
        lifecycle.eventUrl = null;
        lifecycle.navigationSnapshot = null;
      } else {
        invalidateBrowserNavigation(context.tab);
      }
      lifecycle.nativeLabel = null;
      lifecycle.liveGeneration = 0;
      lifecycle.controlGeneration = 0;
      lifecycle.liveUrl = null;
      lifecycle.liveNavigationToken = null;
      lifecycle.eventUrl = null;
      lifecycle.viewLive = false;
    };
    var restoreTab = function (viewIsDead) {
      if (context.browser.tabs.indexOf(context.tab) === -1) return;
      context.tab.created = viewIsDead ? false : context.previousCreated;
      context.tab.loading = viewIsDead ? false : context.previousLoading;
      context.tab.title = context.previousTitle;
      context.tab.url = context.previousUrl;
      context.tab.history = context.previousHistory.slice();
      context.tab.historyIndex = context.previousHistoryIndex;
      syncProjectBrowser();
      saveWorkspaceSoon();
    };
    try {
      if (lifecycle.nativeLabel) {
        var cleanupControlGeneration =
          lifecycle.controlGeneration || lifecycle.liveGeneration || lifecycle.pendingGeneration;
        var pair = {
          project: context.project,
          worktreePath: context.worktreePath,
          browser: context.browser,
          tab: context.tab,
        };
        var automationInvalidated = false;
        var automationInvalidationError = null;
        try {
          automationInvalidated = await invalidateBrowserAutomation(pair);
        } catch (error) {
          automationInvalidationError = error;
          setStatus("browser automation invalidation failed: " + boundedBrowserError(error), "error");
        }
        if (!automationInvalidated) {
          if (!context.ambiguousAfterDispatch) {
            retireNavigationView();
            restoreTab(true);
          }
          if (!automationInvalidationError) setStatus("browser automation invalidation failed", "error");
          if (!context.ambiguousAfterDispatch) return false;
        } else if (!context.controlResourceRemoved) {
          var resourceRemoved = false;
          var resourceRemovalError = null;
          try {
            resourceRemoved = await removeBrowserControlResource(pair);
          } catch (error) {
            resourceRemovalError = error;
          }
          if (!resourceRemoved) {
            lifecycle.quarantinedControlGeneration = cleanupControlGeneration;
            setStatus(
              "browser automation cleanup failed: " +
                boundedBrowserError(resourceRemovalError ||
                  new Error("browser control resource removal was not confirmed")),
              "error"
            );
          }
        }
      }
      retireNavigationView();
      var destroyed = true;
      try {
        await invoke("browser_destroy", { label: context.label });
      } catch (error) {
        destroyed = false;
        setStatus("obsolete browser navigation cleanup failed for " + context.label + ": " + boundedBrowserError(error), "error");
        if (context.ambiguousAfterDispatch) {
          try {
            await invoke("browser_hide", { label: context.label });
          } catch (_) {}
        }
      }
      restoreTab(true);
      return destroyed;
    } finally {
      if (lifecycle.cleanupOperation === cleanupOperation) {
        lifecycle.cleanupOperation = null;
      }
      cleanupResolve();
    }
  }
  function nativeBrowserLabel(raw) {
    var safe = String(raw || "default").split("").filter(function (c) {
      return /[A-Za-z0-9_-]/.test(c);
    }).join("").slice(0, 64) || "default";
    return "psyche-browser-" + safe;
  }
  function browserControlPairByTabId(tabId, projectRoot) {
    var match = null;
    for (var i = 0; i < state.projects.length; i++) {
      var project = state.projects[i];
      var provider = browserControlProviders.get(project.root);
      if (!provider || !provider.status || provider.status.projectRoot !== projectRoot) continue;
      var browsersByWorktree = project.browsersByWorktree || {};
      var roots = Object.keys(browsersByWorktree);
      for (var w = 0; w < roots.length; w++) {
        var browser = browsersByWorktree[roots[w]];
        var tab = browser.tabs.find(function (candidate) { return candidate.id === tabId; });
        if (!tab) continue;
        if (match) return null;
        match = { project: project, worktreePath: roots[w], browser: browser, tab: tab };
      }
    }
    return match;
  }
  function browserControlViewport(pair) {
    var pane = findBrowserPane(pair.project.id, pair.worktreePath);
    var rect = pane && pane.pane && pane.pane.isConnected && pane.browserBody
      ? pane.browserBody.getBoundingClientRect()
      : null;
    return {
      width: Math.max(1, Math.round(rect && rect.width || 1)),
      height: Math.max(1, Math.round(rect && rect.height || 1)),
    };
  }
  function ensureBrowserControlProvider(project) {
    if (!project || !project.root) return Promise.reject(new Error("browser project is unavailable"));
    var current = browserControlProviders.get(project.root);
    if (current && current.status) return Promise.resolve(current.status);
    if (current && current.flight) return current.flight;
    var entry = current || { status: null, flight: null };
    entry.flight = invoke("control_provider_start", { projectRoot: project.root }).then(function (status) {
      entry.status = status;
      entry.flight = null;
      return status;
    }, function (error) {
      entry.flight = null;
      throw error;
    });
    browserControlProviders.set(project.root, entry);
    return entry.flight;
  }
  function browserControlResource(pair, status) {
    var lifecycle = browserTabLifecycle(pair.tab);
    var resourceUrl = lifecycle.liveUrl || pair.tab.url || lifecycle.pendingUrl || "about:blank";
    return {
      id: pair.tab.id,
      kind: "browser_tab",
      generation: lifecycle.controlGeneration || lifecycle.liveGeneration || lifecycle.pendingGeneration || lifecycle.generation,
      providerId: status.providerId,
      webviewLabel: lifecycle.nativeLabel,
      projectRoot: status.projectRoot,
      worktreeRoot: pair.worktreePath,
      url: resourceUrl,
      title: browserControlTitle(resourceUrl),
      loading: !!pair.tab.loading,
      viewport: browserControlViewport(pair),
    };
  }
  function browserControlTitle(url) {
    try {
      var parsed = new URL(String(url || ""));
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname) {
        return "Browser (" + parsed.hostname.toLowerCase() + ")";
      }
    } catch (_) {}
    return "Browser";
  }
  function publishBrowserControlResource(pair) {
    if (!pair || browserTabIsClosing(pair.tab)) return Promise.resolve(false);
    var lifecycle = browserTabLifecycle(pair.tab);
    if (!lifecycle.nativeLabel || !lifecycle.liveGeneration || lifecycle.pendingGeneration ||
        lifecycle.replacementOperation || lifecycle.authorityTransition ||
        lifecycle.quarantinedControlGeneration) {
      return Promise.resolve(false);
    }
    var nativeGeneration = lifecycle.liveGeneration;
    var nativeLabel = lifecycle.nativeLabel;
    var liveUrl = lifecycle.liveUrl;
    var liveNavigationToken = lifecycle.liveNavigationToken;
    var publishedGeneration =
      lifecycle.controlGeneration || lifecycle.liveGeneration ||
      lifecycle.pendingGeneration || lifecycle.generation;
    lifecycle.confirmedAbsentControlGeneration = 0;
    return ensureBrowserControlProvider(pair.project).then(function (status) {
      var resource = browserControlResource(pair, status);
      if (typeof resource.generation === "number") {
        publishedGeneration = resource.generation;
      }
      return invoke("control_provider_upsert", {
        projectRoot: pair.project.root,
        resource: resource,
      }).then(function (canonical) {
        if (!canonical || typeof canonical.generation !== "number") return false;
        var currentGeneration =
          lifecycle.controlGeneration || lifecycle.liveGeneration ||
          lifecycle.pendingGeneration || lifecycle.generation;
        if (lifecycle.liveGeneration !== nativeGeneration ||
            currentGeneration !== publishedGeneration ||
            lifecycle.pendingGeneration ||
            lifecycle.nativeLabel !== nativeLabel ||
            lifecycle.liveUrl !== liveUrl ||
            lifecycle.liveNavigationToken !== liveNavigationToken ||
            lifecycle.replacementOperation || lifecycle.authorityTransition ||
            lifecycle.quarantinedControlGeneration ||
            canonical.generation < publishedGeneration) {
          return invoke("control_provider_remove", {
            projectRoot: pair.project.root,
            tabId: pair.tab.id,
            generation: canonical.generation,
          }).then(function (result) {
            if (lifecycle.controlGeneration === canonical.generation) {
              lifecycle.controlGeneration = 0;
            }
            if (result === true && !lifecycle.controlGeneration) {
              lifecycle.confirmedAbsentControlGeneration = canonical.generation;
            } else if (result !== true) {
              lifecycle.quarantinedControlGeneration = canonical.generation;
            }
            return false;
          }, function () {
            if (lifecycle.controlGeneration === canonical.generation) {
              lifecycle.controlGeneration = 0;
            }
            lifecycle.quarantinedControlGeneration = canonical.generation;
            return false;
          });
        }
        lifecycle.controlGeneration = canonical.generation;
        lifecycle.confirmedAbsentControlGeneration = 0;
        return true;
      });
    }).catch(function () { return false; });
  }
  function removeBrowserControlResource(pair, expectedGeneration) {
    if (!pair) return Promise.resolve(false);
    var lifecycle = browserTabLifecycle(pair.tab);
    if (expectedGeneration &&
        lifecycle.confirmedAbsentControlGeneration === expectedGeneration &&
        lifecycle.controlGeneration !== expectedGeneration) {
      return Promise.resolve(true);
    }
    if (!expectedGeneration && !lifecycle.controlGeneration &&
        lifecycle.confirmedAbsentControlGeneration) {
      return Promise.resolve(true);
    }
    var generation = expectedGeneration ||
      lifecycle.controlGeneration || lifecycle.liveGeneration || lifecycle.pendingGeneration;
    if (!generation) return Promise.resolve(false);
    return ensureBrowserControlProvider(pair.project).then(function () {
      return invoke("control_provider_remove", {
        projectRoot: pair.project.root,
        tabId: pair.tab.id,
        generation: generation,
      }).then(function (result) {
        if (result !== true) return false;
        if (lifecycle.controlGeneration === generation) {
          lifecycle.controlGeneration = 0;
        }
        if (!lifecycle.controlGeneration) {
          lifecycle.confirmedAbsentControlGeneration = generation;
        }
        return true;
      });
    });
  }
  function invalidateBrowserAutomation(pair) {
    if (!pair) return Promise.resolve(false);
    var lifecycle = browserTabLifecycle(pair.tab);
    if (!lifecycle.nativeLabel) return Promise.resolve(false);
    return invoke("browser_eval", {
      label: browserLabelForTab(pair.project, pair.tab),
      script: "window.__PSYCHE_AUTOMATION__ && window.__PSYCHE_AUTOMATION__.invalidate();",
    }).then(function () { return true; }, function () { return false; });
  }
  async function quarantineBrowserAutomation(pair, destroyChild) {
    if (!pair) return false;
    var lifecycle = browserTabLifecycle(pair.tab);
    var generation = lifecycle.controlGeneration || lifecycle.liveGeneration;
    var label = lifecycle.nativeLabel ? browserLabelForTab(pair.project, pair.tab) : null;
    var invalidateFlight = destroyChild ? Promise.resolve(false) : invalidateBrowserAutomation(pair);
    var removeFlight = removeBrowserControlResource(pair);
    browserAutomationSnapshotRefs.forEach(function (entry, id) {
      if (entry && entry.tabId === pair.tab.id && (!generation || entry.generation === generation)) {
        browserAutomationSnapshotRefs.delete(id);
      }
    });
    invalidateBrowserNavigation(pair.tab);
    lifecycle.controlGeneration = 0;
    lifecycle.liveGeneration = 0;
    lifecycle.nativeLabel = null;
    lifecycle.automationSource = null;
    var destroyFlight = destroyChild && label
      ? invoke("browser_destroy", { label: label }).catch(function () { return false; })
      : Promise.resolve(false);
    var outcomes = await Promise.allSettled([invalidateFlight, removeFlight, destroyFlight]);
    var removal = outcomes[1];
    var removalConfirmed =
      removal && removal.status === "fulfilled" && removal.value === true;
    lifecycle.quarantinedControlGeneration =
      removalConfirmed ? 0 : generation;
    return removalConfirmed;
  }
  function installBrowserAutomationForPair(pair) {
    if (!pair || !window.PsycheControl) return Promise.resolve(false);
    var lifecycle = browserTabLifecycle(pair.tab);
    var expectedGeneration = lifecycle.liveGeneration || lifecycle.pendingGeneration;
    if (!expectedGeneration || !lifecycle.nativeLabel) return Promise.resolve(false);
    var run = function () {
      if ((lifecycle.liveGeneration || lifecycle.pendingGeneration) !== expectedGeneration) return false;
      return invoke("browser_eval", {
        label: browserLabelForTab(pair.project, pair.tab),
        script: lifecycle.automationSource || PsycheControl.browserAutomationSource(),
      }).then(function () { return publishBrowserControlResource(pair); });
    };
    var flight = lifecycle.automationTail ? lifecycle.automationTail.then(run, run) : run();
    lifecycle.automationTail = Promise.resolve(flight).then(function () {}, function () {});
    return Promise.resolve(flight);
  }
  function browserAutomationDispatchScript(effect) {
    var operation = effect.operation || {};
    var request = operation.kind === "action"
      ? { type: "action", snapshotId: resolveBrowserAutomationSnapshotId(effect), action: operation.action }
      : { type: "snapshot" };
    var requestJson = JSON.stringify(request);
    var receiptJson = JSON.stringify({ actionId: effect.actionId, tabId: effect.tabId, generation: effect.generation });
    return "window.__PSYCHE_AUTOMATION__.dispatchAndEmit(" + requestJson + "," + receiptJson + ");";
  }
  function resolveBrowserAutomationSnapshotId(effect) {
    var canonicalId = effect && effect.operation && effect.operation.snapshotId;
    var mapped = typeof canonicalId === "string" ? browserAutomationSnapshotRefs.get(canonicalId) : null;
    if (!mapped || mapped.tabId !== effect.tabId || mapped.generation !== effect.generation || mapped.expiresAt <= Date.now()) {
      if (mapped) browserAutomationSnapshotRefs.delete(canonicalId);
      throw Object.assign(new Error("semantic snapshot is missing or stale"), { code: "snapshot_missing" });
    }
    return mapped.rawSnapshotId;
  }
  function awaitBrowserAutomationResult(effect, timeoutMs) {
    var cancel;
    var promise = new Promise(function (resolve, reject) {
      var settled = false;
      var settle = function (callback, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        browserAutomationWaiters.delete(effect.actionId);
        callback(value);
      };
      var timeout = setTimeout(function () {
        settle(reject, Object.assign(new Error("browser automation timed out"), { code: "effect_unknown", ambiguous: true }));
      }, timeoutMs || 15000);
      browserAutomationWaiters.set(effect.actionId, {
        tabId: effect.tabId,
        generation: effect.generation,
        resolve: function (value) { settle(resolve, value); },
        reject: function (error) { settle(reject, error); },
      });
      cancel = function (error) { settle(reject, error); };
    });
    promise.cancel = function (error) { cancel(error); };
    return promise;
  }
  function completeBrowserProviderEffect(project, result) {
    return invoke("control_provider_complete", { projectRoot: project.root, result: result });
  }
  function canonicalizeBrowserSemanticSnapshot(value, pair, effect, capturedAtMs) {
    var fail = function (message) { throw Object.assign(new Error(message), { code: "automation_failed" }); };
    var plain = function (item) { return !!item && typeof item === "object" && !Array.isArray(item); };
    var exactKeys = function (item, allowed, label) {
      var keys = Object.keys(item);
      for (var i = 0; i < keys.length; i++) if (allowed.indexOf(keys[i]) === -1) fail(label + " has unknown field " + keys[i]);
    };
    if (!plain(value)) fail("snapshot is malformed");
    var encoded = JSON.stringify(value);
    if (new TextEncoder().encode(encoded).length > 1024 * 1024) fail("snapshot exceeds maximum size");
    exactKeys(value, ["schema", "snapshotId", "url", "viewport", "nodes", "truncated"], "snapshot");
    if (value.schema !== "psyche.browser.snapshot/v1" || typeof value.snapshotId !== "string" ||
        typeof value.url !== "string" || !plain(value.viewport) || !Array.isArray(value.nodes) ||
        typeof value.truncated !== "boolean") fail("snapshot is malformed");
    exactKeys(value.viewport, ["width", "height"], "viewport");
    var width = value.viewport.width;
    var height = value.viewport.height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0 || width > 100000 || height > 100000) fail("viewport is malformed");
    if (value.nodes.length > 2000) fail("snapshot exceeds maximum node count");
    var roles = ["button", "link", "textbox", "checkbox", "radio", "combobox", "option", "frame", "img", "heading", "status", "dialog", "menu", "menuitem", "tab", "tabpanel", "switch"];
    var refs = new Set();
    var opaqueFrames = 0;
    var semantics = new Map();
    var nodes = value.nodes.map(function (node) {
      if (!plain(node)) fail("snapshot node is malformed");
      exactKeys(node, ["ref", "role", "name", "bounds", "disabled", "checked", "selected", "submit", "submitMethod", "submitDestination", "value", "secret", "valuePresent", "opaque"], "snapshot node");
      if (typeof node.ref !== "string" || !/^e[1-9][0-9]{0,5}$/.test(node.ref) || refs.has(node.ref) ||
          typeof node.role !== "string" || roles.indexOf(node.role) === -1 || typeof node.name !== "string" || node.name.length > 512 ||
          !plain(node.bounds)) fail("snapshot node is malformed");
      refs.add(node.ref);
      exactKeys(node.bounds, ["x", "y", "width", "height", "clipped"], "snapshot bounds");
      var bounds = {};
      ["x", "y", "width", "height"].forEach(function (key) {
        if (!Number.isFinite(node.bounds[key])) fail("snapshot bounds are malformed");
        bounds[key] = node.bounds[key];
      });
      var projected = { ref: node.ref, role: node.role, name: node.name, bounds: bounds };
      var state = {};
      ["disabled", "checked", "selected", "submit"].forEach(function (key) {
        if (node[key] !== undefined) {
          if (typeof node[key] !== "boolean") fail("snapshot state is malformed");
          state[key] = node[key];
        }
      });
      [["submitMethod", 16], ["submitDestination", 2048]].forEach(function (entry) {
        var key = entry[0];
        if (node[key] !== undefined) {
          if (typeof node[key] !== "string" || node[key].length > entry[1]) fail("snapshot submit metadata is malformed");
          state[key] = node[key];
        }
      });
      if (Object.keys(state).length) projected.state = state;
      if (node.secret === true) projected.value = { kind: "text", secret: true };
      else if (node.value !== undefined) {
        if (typeof node.value !== "string" || node.value.length > 512) fail("snapshot value is malformed");
        projected.value = { kind: "text", value: node.value };
      }
      if (node.opaque === true || node.role === "frame") opaqueFrames += 1;
      semantics.set(node.ref, {
        role: node.role, disabled: node.disabled === true, submit: node.submit === true,
        submitMethod: node.submitMethod, submitDestination: node.submitDestination,
        secret: node.secret === true,
      });
      return projected;
    });
    var capturedAt = new Date(capturedAtMs);
    browserAutomationSnapshotRefs.set(effect.actionId, {
      rawSnapshotId: value.snapshotId,
      tabId: pair.tab.id,
      generation: effect.generation,
      expiresAt: capturedAt.getTime() + 30000,
      refs: new Set(refs),
      semantics: semantics,
    });
    while (browserAutomationSnapshotRefs.size > 128) {
      var oldestSnapshotId = browserAutomationSnapshotRefs.keys().next().value;
      if (!oldestSnapshotId) break;
      browserAutomationSnapshotRefs.delete(oldestSnapshotId);
    }
    return {
      schema: "psyche.browser.snapshot/v1",
      id: effect.actionId,
      tabId: pair.tab.id,
      generation: effect.generation,
      url: String(pair.tab.url || "about:blank").slice(0, 2048),
      title: browserControlTitle(pair.tab.url),
      loading: !!pair.tab.loading,
      viewport: { width: width, height: height },
      capturedAt: capturedAt.toISOString(),
      nodes: nodes,
      truncated: value.truncated,
      opaqueFrames: opaqueFrames,
      expiresAt: new Date(capturedAt.getTime() + 30000).toISOString(),
    };
  }
  function resolveBrowserNativeElementTarget(effect) {
    var operation = effect && effect.operation;
    var action = operation && operation.action;
    var canonicalId = operation && operation.snapshotId;
    var mapped = typeof canonicalId === "string" ? browserAutomationSnapshotRefs.get(canonicalId) : null;
    if (!mapped || mapped.tabId !== effect.tabId || mapped.generation !== effect.generation || mapped.expiresAt <= Date.now()) {
      if (mapped) browserAutomationSnapshotRefs.delete(canonicalId);
      throw Object.assign(new Error("semantic snapshot is missing or stale"), { code: "snapshot_stale" });
    }
    if (!action || typeof action.elementRef !== "string" || !mapped.refs || !mapped.refs.has(action.elementRef)) {
      throw Object.assign(new Error("semantic element reference is missing"), { code: "element_missing" });
    }
    return { rawSnapshotId: mapped.rawSnapshotId, elementRef: action.elementRef };
  }
  function browserProviderOperationPreflight(effect) {
    var operation = effect && effect.operation;
    if (!operation || (operation.kind !== "inspect" && operation.kind !== "action" && operation.kind !== "script")) {
      throw Object.assign(new Error("browser operation is not supported"), { code: "unsupported_operation" });
    }
    if (operation.kind === "inspect" || operation.kind === "script") return "page";
    var action = operation.action;
    if (!action || typeof action !== "object" || Array.isArray(action) || typeof action.kind !== "string") {
      throw Object.assign(new Error("browser action is malformed"), { code: "automation_failed" });
    }
    if (action.kind === "upload" || action.kind === "download") {
      resolveBrowserNativeElementTarget(effect);
      throw Object.assign(new Error("backend_unavailable: native interception is unavailable"), { code: "backend_unavailable" });
    }
    if (action.kind === "permission_response") {
      if (typeof action.permission !== "string" || !action.permission || typeof action.origin !== "string" ||
          !action.origin || (action.decision !== "allow" && action.decision !== "deny")) {
        throw Object.assign(new Error("permission response contract is malformed"), { code: "automation_failed" });
      }
      throw Object.assign(new Error("backend_unavailable: native interception is unavailable"), { code: "backend_unavailable" });
    }
    if (["navigate", "reload", "back", "forward", "close", "screenshot"].indexOf(action.kind) !== -1) return "lifecycle";
    if (!operation.snapshotId || typeof operation.snapshotId !== "string") {
      throw Object.assign(new Error("semantic snapshot identity is required"), { code: "snapshot_missing" });
    }
    return "page";
  }
  function canonicalizeBrowserActionResult(effect, value) {
    var fail = function (message) { throw Object.assign(new Error(message), { code: "automation_failed" }); };
    var plain = value && typeof value === "object" && !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
    if (!plain) fail("browser action result is malformed");
    var action = effect.operation.action;
    var mapped = browserAutomationSnapshotRefs.get(effect.operation.snapshotId);
    var semantic = mapped && mapped.tabId === effect.tabId && mapped.generation === effect.generation && mapped.semantics
      ? mapped.semantics.get(action.elementRef) : null;
    if (!semantic) fail("browser action result snapshot is stale");
    var allowed = {
      click: ["clicked"], type: semantic && semantic.secret ? ["valuePresent", "secret"] : ["typed"], select: ["selected"],
      scroll: ["scrolled"], focus: ["focused"], submit: ["submitted"],
    }[action.kind];
    if (!allowed || Object.keys(value).some(function (key) { return allowed.indexOf(key) === -1; })) fail("browser action result has unknown fields");
    if (action.kind === "click") {
      if (value.clicked !== true) fail("click result is malformed");
      return { clicked: true };
    }
    if (action.kind === "type") {
      if (semantic.secret) {
        if (typeof value.valuePresent !== "boolean" || value.secret !== true) fail("secret input result is malformed");
        return { valuePresent: value.valuePresent, secret: true };
      }
      if (value.typed !== true) fail("type result is malformed");
      return { typed: true };
    }
    if (action.kind === "select") {
      if (value.selected !== true) fail("select result is malformed");
      return { selected: true };
    }
    if (action.kind === "scroll") {
      if (value.scrolled !== true) fail("scroll result is malformed");
      return { scrolled: true };
    }
    if (action.kind === "focus") {
      if (value.focused !== true) fail("focus result is malformed");
      return { focused: true };
    }
    if (action.kind === "submit") {
      if (value.submitted !== true) fail("submit result is malformed");
      return { submitted: true };
    }
    fail("browser action result is unsupported");
  }
  function canonicalizeBrowserScriptResult(value) {
    var plain = value && typeof value === "object" && !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
    if (!plain || Object.keys(value).some(function (key) {
      return ["value", "resultBytes", "durationMs"].indexOf(key) === -1;
    }) || !Number.isSafeInteger(value.resultBytes) || value.resultBytes < 0 || value.resultBytes > 256 * 1024 ||
      !Number.isFinite(value.durationMs) || value.durationMs < 0 || value.durationMs > 5000) {
      throw Object.assign(new Error("browser script result is malformed"), { code: "serialization_failed" });
    }
    var encoded;
    try { encoded = JSON.stringify(value.value); }
    catch (_) { throw Object.assign(new Error("browser script result cannot be encoded"), { code: "serialization_failed" }); }
    if (encoded === undefined || new TextEncoder().encode(encoded).length !== value.resultBytes) {
      throw Object.assign(new Error("browser script result byte count is invalid"), { code: "serialization_failed" });
    }
    return { value: JSON.parse(encoded), resultBytes: value.resultBytes, durationMs: value.durationMs };
  }
  function browserNativeScriptError(error) {
    var message = String(error && error.message || error);
    var allowed = [
      "args_too_large",
      "backend_unavailable",
      "effect_unknown",
      "mutation_not_allowed",
      "mutation_plan_invalid",
      "mutation_target_stale",
      "result_too_large",
      "script_source_too_large",
      "serialization_failed",
      "snapshot_too_large",
      "target_unavailable",
      "automation_failed",
    ];
    var supplied = error && typeof error.code === "string" ? error.code : null;
    var code = allowed.indexOf(supplied) !== -1 ? supplied
      : allowed.find(function (candidate) { return message.indexOf(candidate) !== -1; }) || "automation_failed";
    return Object.assign(new Error("browser script failed: " + code), { code: code, ambiguous: code === "effect_unknown" });
  }
  function ambiguousBrowserLifecycle(message) {
    return Object.assign(new Error(message), { code: "effect_unknown", ambiguous: true });
  }
  function browserProjectContextIsCurrent(project, projectId, worktreePath) {
    return !!project && !!projectId && project.id === projectId &&
      state.activeProjectId === projectId && activeProject() === project &&
      activeWorkspaceRoot(project) === worktreePath;
  }
  async function runBrowserLifecycleOperation(pair, effect) {
    var action = effect.operation.action;
    if (!browserProjectContextIsCurrent(pair.project, pair.project.id, pair.worktreePath)) {
      throw Object.assign(new Error("backend_unavailable: exact browser tab is not active"), { code: "backend_unavailable" });
    }
    if (action.kind === "navigate") {
      var navigated;
      try { navigated = await navigateBrowser(action.url, { tabId: pair.tab.id }); }
      catch (_) { throw ambiguousBrowserLifecycle("browser navigation outcome is unknown"); }
      if (!navigated) throw ambiguousBrowserLifecycle("browser navigation outcome is unknown");
      return { url: pair.tab.url, title: browserControlTitle(pair.tab.url) };
    }
    if (action.kind === "reload") {
      var reloaded;
      try { reloaded = await navigateBrowser(pair.tab.url, { tabId: pair.tab.id, replace: true, preserveHistory: true }); }
      catch (_) { throw ambiguousBrowserLifecycle("browser reload outcome is unknown"); }
      if (!reloaded) throw ambiguousBrowserLifecycle("browser reload outcome is unknown");
      return { url: pair.tab.url, title: browserControlTitle(pair.tab.url) };
    }
    if (action.kind === "back" || action.kind === "forward") {
      var delta = action.kind === "back" ? -1 : 1;
      var index = pair.tab.historyIndex + delta;
      if (index < 0 || index >= pair.tab.history.length) throw Object.assign(new Error("browser history target is unavailable"), { code: "resource_missing" });
      var moved;
      try { moved = await navigateBrowser(pair.tab.history[index], { tabId: pair.tab.id, fromHistory: true, historyIndex: index }); }
      catch (_) { throw ambiguousBrowserLifecycle("browser history navigation outcome is unknown"); }
      if (!moved) throw ambiguousBrowserLifecycle("browser history navigation outcome is unknown");
      return {
        url: pair.tab.url,
        title: browserControlTitle(pair.tab.url),
        historyIndex: pair.tab.historyIndex,
      };
    }
    if (action.kind === "close") {
      var lifecycle = browserTabLifecycle(pair.tab);
      if (lifecycle.navigationTail) await lifecycle.navigationTail;
      var closed;
      try { closed = await closeBrowserTab(pair.project, pair.tab.id); }
      catch (_) { throw ambiguousBrowserLifecycle("browser close outcome is unknown"); }
      if (!closed) throw ambiguousBrowserLifecycle("browser close outcome is unknown");
      return { closed: true };
    }
    if (action.kind === "screenshot") {
      return invoke("browser_snapshot", { label: browserLabelForTab(pair.project, pair.tab) });
    }
    throw Object.assign(new Error("browser lifecycle action is not supported"), { code: "unsupported_operation" });
  }
  async function handleBrowserProviderEffect(event) {
    var effect = event && event.payload || {};
    var pair = browserControlPairByTabId(effect.tabId, effect.projectRoot);
    if (!pair) {
      var owner = state.projects.find(function (project) {
        var provider = browserControlProviders.get(project.root);
        return provider && provider.status && provider.status.projectRoot === effect.projectRoot;
      });
      if (owner) await completeBrowserProviderEffect(owner, {
        actionId: effect.actionId, status: "failed", code: "resource_missing", message: "browser tab is unavailable",
      });
      return false;
    }
    var lifecycle = browserTabLifecycle(pair.tab);
    if (effect.generation !== (lifecycle.controlGeneration || lifecycle.liveGeneration) ||
        lifecycle.pendingGeneration || lifecycle.replacementOperation ||
        lifecycle.authorityTransition ||
        lifecycle.quarantinedControlGeneration) {
      await completeBrowserProviderEffect(pair.project, {
        actionId: effect.actionId,
        status: "failed",
        code: "resource_replaced",
        message: "browser tab generation was replaced",
      });
      return false;
    }
    if (!lifecycle.nativeLabel) {
      await completeBrowserProviderEffect(pair.project, {
        actionId: effect.actionId,
        status: "failed",
        code: "resource_missing",
        message: "browser tab is unavailable",
      });
      return false;
    }
    var completeReplaced = async function () {
      await completeBrowserProviderEffect(pair.project, {
        actionId: effect.actionId,
        status: "failed",
        code: "resource_replaced",
        message: "browser tab generation was replaced",
      });
      return false;
    };
    var exactPairIsCurrent = function () {
      var current = browserControlPairByTabId(effect.tabId, effect.projectRoot);
      if (!current || current.project !== pair.project || current.browser !== pair.browser ||
          current.tab !== pair.tab || current.worktreePath !== pair.worktreePath) return false;
      var currentLifecycle = browserTabLifecycle(current.tab);
      return effect.generation === (currentLifecycle.controlGeneration || currentLifecycle.liveGeneration) &&
        !currentLifecycle.pendingGeneration && !currentLifecycle.replacementOperation &&
        !currentLifecycle.authorityTransition &&
        !currentLifecycle.quarantinedControlGeneration && !!currentLifecycle.nativeLabel;
    };
    var operationClass;
    try {
      operationClass = browserProviderOperationPreflight(effect);
    } catch (preflightError) {
      await completeBrowserProviderEffect(pair.project, {
        actionId: effect.actionId, status: "failed", code: preflightError.code || "automation_failed",
        message: String(preflightError.message || preflightError),
      });
      return true;
    }
    if (operationClass === "lifecycle") {
      try {
        var lifecycleValue = await runBrowserLifecycleOperation(pair, effect);
        await completeBrowserProviderEffect(pair.project, { actionId: effect.actionId, status: "succeeded", value: lifecycleValue });
      } catch (lifecycleError) {
        var lifecycleAmbiguous = !!(lifecycleError && (lifecycleError.ambiguous || lifecycleError.code === "effect_unknown"));
        await completeBrowserProviderEffect(pair.project, {
          actionId: effect.actionId, status: lifecycleAmbiguous ? "unknown" : "failed",
          code: lifecycleAmbiguous ? "effect_unknown" : lifecycleError.code || "automation_failed",
          message: String(lifecycleError.message || lifecycleError),
        });
      }
      return true;
    }
    var runInspect = async function () {
      if (!exactPairIsCurrent()) return completeReplaced();
      try {
        var automationValue;
        if (effect.operation.kind === "script") {
          try {
            automationValue = await invoke("browser_script", {
              label: browserLabelForTab(pair.project, pair.tab),
              request: { source: effect.operation.source, args: effect.operation.args === undefined ? null : effect.operation.args },
            });
          } catch (scriptError) {
            throw browserNativeScriptError(scriptError);
          }
        } else {
          var installed = await installBrowserAutomationForPair(pair);
          if (!installed || !exactPairIsCurrent()) return completeReplaced();
          var resultFlight = awaitBrowserAutomationResult(effect, 15000);
          try {
            await invoke("browser_eval", {
              label: browserLabelForTab(pair.project, pair.tab),
              script: (browserTabLifecycle(pair.tab).automationSource || PsycheControl.browserAutomationSource()) + "\n" + browserAutomationDispatchScript(effect),
              automationReceipt: { actionId: effect.actionId, tabId: effect.tabId, generation: effect.generation },
            });
          } catch (evalError) {
            resultFlight.cancel(evalError);
            await resultFlight.catch(function () {});
            throw evalError;
          }
          automationValue = await resultFlight;
        }
        var value = effect.operation.kind === "inspect"
          ? canonicalizeBrowserSemanticSnapshot(automationValue, pair, effect, Date.now())
          : effect.operation.kind === "script"
            ? canonicalizeBrowserScriptResult(automationValue)
            : canonicalizeBrowserActionResult(effect, automationValue);
        if (!exactPairIsCurrent()) {
          if (effect.operation.kind === "script") {
            await quarantineBrowserAutomation(pair, true);
            await completeBrowserProviderEffect(pair.project, { actionId: effect.actionId, status: "unknown", code: "effect_unknown", message: "browser tab changed during script evaluation" });
            return false;
          }
          return completeReplaced();
        }
        if (effect.operation.kind === "inspect" && effect.operation.includeScreenshot) {
          value.screenshot = await invoke("browser_snapshot", { label: browserLabelForTab(pair.project, pair.tab) });
          if (!exactPairIsCurrent()) return completeReplaced();
        }
        await completeBrowserProviderEffect(pair.project, { actionId: effect.actionId, status: "succeeded", value: value });
      } catch (error) {
        var ambiguous = !!(error && (error.ambiguous || error.code === "effect_unknown"));
        if (ambiguous && effect.operation.kind === "script") {
          await quarantineBrowserAutomation(pair, true);
        }
        var code = ambiguous ? "effect_unknown" : error && error.code || (String(error).indexOf("backend_unavailable") !== -1 ? "backend_unavailable" : "automation_failed");
        var message = ambiguous && effect.operation.kind === "script"
          ? "browser script outcome is unknown"
          : String(error && error.message || error);
        await completeBrowserProviderEffect(pair.project, { actionId: effect.actionId, status: ambiguous ? "unknown" : "failed", code: code, message: message });
      }
      return true;
    };
    var inspect = lifecycle.navigationTail
      ? lifecycle.navigationTail.then(runInspect, runInspect)
      : runInspect();
    lifecycle.navigationTail = Promise.resolve(inspect).then(function () {}, function () {});
    return inspect;
  }
  listen("browser:automation-result", function (event) {
    var payload = event && event.payload || {};
    var waiter = browserAutomationWaiters.get(payload.actionId);
    if (!waiter) return;
    if (waiter.tabId !== payload.tabId || waiter.generation !== payload.generation) return;
    browserAutomationWaiters.delete(payload.actionId);
    if (payload.error) waiter.reject(Object.assign(new Error(payload.error.message), { code: payload.error.code }));
    else waiter.resolve(payload.value);
  }).catch(function () {});
  listen("control:provider-effect-request", handleBrowserProviderEffect).catch(function () {});
  function browserTabForNativeLabel(nativeLabel) {
    for (var i = 0; i < state.projects.length; i++) {
      var project = state.projects[i];
      var browsersByWorktree = project.browsersByWorktree || {};
      var workspaceRoots = Object.keys(browsersByWorktree);
      for (var w = 0; w < workspaceRoots.length; w++) {
        var browser = browsersByWorktree[workspaceRoots[w]];
        for (var j = 0; j < browser.tabs.length; j++) {
          var tab = browser.tabs[j];
          if (nativeBrowserLabel(browserLabelForTab(project, tab)) === nativeLabel) {
            return { project: project, worktreePath: workspaceRoots[w], browser: browser, tab: tab };
          }
        }
      }
    }
    return null;
  }
  function browserUrlsMatch(left, right) {
    if (!left || !right) return left === right;
    try { return new URL(String(left)).href === new URL(String(right)).href; }
    catch (_) { return String(left) === String(right); }
  }
  function browserUrlsShareOrigin(left, right) {
    if (!left || !right) return false;
    try {
      var leftUrl = new URL(String(left));
      var rightUrl = new URL(String(right));
      return leftUrl.origin !== "null" && leftUrl.origin === rightUrl.origin;
    } catch (_) {
      return false;
    }
  }
  function recordBrowserHistoryUrl(tab, url, previousUrl) {
    if (!tab || !url) return;
    var history = Array.isArray(tab.history)
      ? tab.history.filter(Boolean).map(function (entry) { return String(entry); })
      : [];
    var currentIndex = Number.isInteger(tab.historyIndex)
      ? tab.historyIndex
      : history.length - 1;
    currentIndex = Math.max(-1, Math.min(currentIndex, history.length - 1));
    var fallbackCurrentUrl = previousUrl ? String(previousUrl) : null;
    if (fallbackCurrentUrl) {
      var matchingIndex = -1;
      var backwardStart = Math.min(currentIndex, history.length - 1);
      for (var i = backwardStart; i >= 0; i--) {
        if (browserUrlsMatch(history[i], fallbackCurrentUrl)) {
          matchingIndex = i;
          break;
        }
      }
      if (matchingIndex === -1) {
        for (var j = history.length - 1; j > backwardStart; j--) {
          if (browserUrlsMatch(history[j], fallbackCurrentUrl)) {
            matchingIndex = j;
            break;
          }
        }
      }
      if (matchingIndex >= 0) currentIndex = matchingIndex;
    }
    history = history.slice(0, currentIndex + 1);
    var currentUrl = currentIndex >= 0 ? history[currentIndex] : null;
    if (fallbackCurrentUrl &&
        (!currentUrl || !browserUrlsMatch(currentUrl, fallbackCurrentUrl))) {
      history.push(fallbackCurrentUrl);
      currentIndex = history.length - 1;
      currentUrl = history[currentIndex];
    }
    if (currentUrl && browserUrlsMatch(currentUrl, url)) {
      tab.history = history;
      tab.historyIndex = currentIndex;
      return;
    }
    history.push(String(url));
    tab.history = history;
    tab.historyIndex = history.length - 1;
  }
  function normaliseBrowserEventTitle(title) {
    if (title == null) return "";
    var trimmed = String(title).trim();
    return trimmed ? trimmed.slice(0, 512) : "";
  }
  function browserNativeUrl(value) {
    if (typeof value !== "string" || !value) return null;
    try {
      var parsed = new URL(value);
      if (parsed.protocol === "http:" || parsed.protocol === "https:" ||
          parsed.href === "about:blank") return parsed.href;
    } catch (_) {}
    return null;
  }
  function browserNativeEventContext(nativeLabel, url, navigationToken) {
    var pair = browserTabForNativeLabel(nativeLabel);
    if (!pair || findProject(pair.project.id) !== pair.project) return null;
    if (!pair.project.browsersByWorktree ||
        pair.project.browsersByWorktree[pair.worktreePath] !== pair.browser ||
        pair.browser.tabs.indexOf(pair.tab) === -1 ||
        browserTabIsClosing(pair.tab)) return null;
    var pane = findBrowserPane(pair.project.id, pair.worktreePath);
    if (!pane || pane.projectId !== pair.project.id ||
        pane.worktreePath !== pair.worktreePath ||
        findThread(pane.id) !== pane || browserPaneIsClosing(pane)) return null;
    var lifecycle = browserTabLifecycle(pair.tab);
    if (lifecycle.replacementOperation) return null;
    var hasPendingNavigation = lifecycle.pendingGeneration > 0;
    if (hasPendingNavigation && lifecycle.pendingNavigationToken && navigationToken !== lifecycle.pendingNavigationToken) return null;
    if (!hasPendingNavigation && navigationToken && navigationToken !== lifecycle.liveNavigationToken) return null;
    var expectedUrl = hasPendingNavigation ? lifecycle.pendingUrl : lifecycle.liveUrl;
    if (!lifecycle.viewLive || lifecycle.nativeLabel !== nativeLabel ||
        (hasPendingNavigation && lifecycle.pendingGeneration !== lifecycle.generation) ||
        (!pair.tab.created && !hasPendingNavigation) ||
        !(hasPendingNavigation ? lifecycle.pendingGeneration : lifecycle.liveGeneration)) return null;
    if (url && expectedUrl && !browserUrlsMatch(url, expectedUrl) &&
        (!lifecycle.eventUrl || !browserUrlsMatch(url, lifecycle.eventUrl))) return null;
    if (url) lifecycle.eventUrl = url;
    return pair;
  }
  function browserNativeDocumentReplacementContext(nativeLabel, url, phase) {
    var nativeUrl = browserNativeUrl(url);
    if (!nativeUrl) return null;
    var pair = browserNativeEventContext(nativeLabel, null, null);
    if (!pair) return null;
    var lifecycle = browserTabLifecycle(pair.tab);
    if (lifecycle.pendingGeneration || !lifecycle.liveUrl) return null;
    if (phase === "started") return { pair: pair, url: nativeUrl };
    if (browserUrlsMatch(nativeUrl, lifecycle.liveUrl) ||
        (lifecycle.eventUrl && browserUrlsMatch(nativeUrl, lifecycle.eventUrl))) return null;
    return { pair: pair, url: nativeUrl };
  }
  async function rotateBrowserAuthorityForNativeReplacement(pair, reportedUrl) {
    if (!pair) return false;
    var lifecycle = browserTabLifecycle(pair.tab);
    if (lifecycle.replacementOperation) return lifecycle.replacementOperation.promise;
    var reportedNativeUrl = browserNativeUrl(reportedUrl);
    if (!reportedNativeUrl || !lifecycle.nativeLabel || !lifecycle.liveGeneration ||
        lifecycle.pendingGeneration || !lifecycle.liveUrl) return false;
    var previousGeneration =
      lifecycle.controlGeneration || lifecycle.liveGeneration;
    if (!previousGeneration) return false;
    var operation = { url: reportedNativeUrl, promise: null };
    lifecycle.replacementOperation = operation;
    operation.promise = Promise.resolve().then(async function () {
      var replacementUrl = null;
      var quarantineError = null;
      try {
        replacementUrl = browserNativeUrl(await invoke("browser_current_url", {
          label: browserLabelForTab(pair.project, pair.tab),
        }));
        if (!replacementUrl) {
          quarantineError = new Error("native browser URL could not be confirmed");
        }
      } catch (error) {
        quarantineError = error;
      }
      browserAutomationSnapshotRefs.forEach(function (entry, id) {
        if (entry && entry.tabId === pair.tab.id &&
            entry.generation === previousGeneration) {
          browserAutomationSnapshotRefs.delete(id);
        }
      });
      var removalConfirmed = false;
      try {
        var removed = await removeBrowserControlResource(pair, previousGeneration);
        removalConfirmed = removed === true;
        if (!removed && !quarantineError) {
          quarantineError = new Error("browser control resource removal was not confirmed");
        }
      } catch (error) {
        if (!quarantineError) quarantineError = error;
      }
      try {
        await invoke("browser_destroy", {
          label: browserLabelForTab(pair.project, pair.tab),
        });
      } catch (error) {
        if (!quarantineError) quarantineError = error;
        try {
          await invoke("browser_hide", {
            label: browserLabelForTab(pair.project, pair.tab),
          });
        } catch (_) {}
      }
      invalidateBrowserNavigation(pair.tab);
      lifecycle.controlGeneration = 0;
      lifecycle.quarantinedControlGeneration =
        removalConfirmed ? 0 : previousGeneration;
      lifecycle.liveGeneration = 0;
      lifecycle.liveUrl = null;
      lifecycle.liveNavigationToken = null;
      lifecycle.nativeLabel = null;
      lifecycle.automationSource = null;
      lifecycle.eventUrl = null;
      lifecycle.viewLive = false;
      pair.tab.created = false;
      pair.tab.loading = false;
      pair.tab.url = replacementUrl || reportedNativeUrl;
      pair.tab.title = tabTitle(pair.tab.url);
      renderBrowserTabs();
      syncUrlInput();
      saveWorkspaceSoon();
      lifecycle.replacementOperation = null;
      if (quarantineError) {
        setStatus(
          "browser document replacement quarantined: " +
            boundedBrowserError(quarantineError),
          "error"
        );
        return false;
      }
      return navigateBrowser(replacementUrl, { tabId: pair.tab.id });
    }).finally(function () {
      if (lifecycle.replacementOperation === operation) {
        lifecycle.replacementOperation = null;
      }
    });
    return operation.promise;
  }
  function markBrowserTabLoaded(nativeLabel, url, title, navigationToken) {
    var pair = browserNativeEventContext(nativeLabel, url, navigationToken);
    if (!pair) return false;
    var lifecycle = browserTabLifecycle(pair.tab);
    if (lifecycle.pendingGeneration) {
      lifecycle.liveGeneration = lifecycle.pendingGeneration;
      lifecycle.liveUrl = url || lifecycle.pendingUrl;
      lifecycle.liveNavigationToken = lifecycle.pendingNavigationToken;
      lifecycle.pendingGeneration = 0;
      lifecycle.pendingUrl = null;
      lifecycle.pendingNavigationToken = null;
      lifecycle.pendingTitle = null;
      lifecycle.pendingTitleUrl = null;
      lifecycle.pendingTitleGeneration = 0;
      lifecycle.pendingTitleNavigationToken = null;
      lifecycle.navigationSnapshot = null;
      pair.tab.created = true;
    }
    pair.tab.loading = false;
    if (url) pair.tab.url = url;
    if (title && String(title).trim()) pair.tab.title = String(title).trim();
    else pair.tab.title = tabTitle(pair.tab.url);
    if (pair.project.id === state.activeProjectId &&
        activeWorkspaceRoot(pair.project) === pair.worktreePath) {
      renderBrowserTabs(); syncUrlInput();
    }
    saveWorkspaceSoon();
    return true;
  }
  function handleBrowserPageLoad(event) {
    var payload = event.payload || {};
    var replacement = browserNativeDocumentReplacementContext(
      payload.label,
      payload.url,
      payload.phase
    );
    if (replacement) {
      return rotateBrowserAuthorityForNativeReplacement(
        replacement.pair,
        replacement.url
      );
    }
    var pair = browserNativeEventContext(payload.label, payload.url, payload.navigationToken);
    if (!pair) return false;
    if (payload.phase === "started") {
      pair.tab.loading = true;
      if (typeof publishBrowserControlResource === "function") {
        publishBrowserControlResource(pair).catch(function () {});
      }
    } else if (payload.phase === "finished") {
      var loaded = markBrowserTabLoaded(payload.label, payload.url, "", payload.navigationToken);
      if (loaded && typeof installBrowserAutomationForPair === "function") {
        installBrowserAutomationForPair(pair).catch(function () {});
      }
      if (loaded && typeof publishBrowserControlResource === "function") {
        publishBrowserControlResource(pair).catch(function () {});
      }
      return loaded;
    } else {
      return false;
    }
    if (pair.project.id === state.activeProjectId &&
        activeWorkspaceRoot(pair.project) === pair.worktreePath) {
      renderBrowserTabs(); updateBrowserControls();
    }
    return true;
  }
  function browserTitleEventContext(payload) {
    payload = payload || {};
    var nativeUrl = browserNativeUrl(payload.url);
    var title = typeof payload.title === "string" ? payload.title.trim() : "";
    if (!nativeUrl || !title || title.length > 4096 ||
        !Number.isSafeInteger(payload.generation) || payload.generation <= 0 ||
        typeof payload.navigationToken !== "string" || !payload.navigationToken) return null;
    var pair = browserNativeEventContext(
      payload.label,
      null,
      payload.navigationToken
    );
    if (!pair) return null;
    var lifecycle = browserTabLifecycle(pair.tab);
    if (lifecycle.pendingGeneration) {
      if (payload.generation !== lifecycle.pendingGeneration ||
          lifecycle.pendingGeneration !== lifecycle.generation ||
          payload.navigationToken !== lifecycle.pendingNavigationToken) return null;
      return { pair: pair, lifecycle: lifecycle, title: title, url: nativeUrl, pending: true };
    }
    if (payload.generation !== lifecycle.liveGeneration ||
        lifecycle.liveGeneration !== lifecycle.generation ||
        payload.navigationToken !== lifecycle.liveNavigationToken ||
        (lifecycle.liveUrl && !browserUrlsMatch(nativeUrl, lifecycle.liveUrl) &&
          (!lifecycle.eventUrl || !browserUrlsMatch(nativeUrl, lifecycle.eventUrl)))) return null;
    return { pair: pair, lifecycle: lifecycle, title: title, url: nativeUrl, pending: false };
  }
  function handleBrowserTitle(event) {
    var payload = event.payload || {};
    var context = browserTitleEventContext(payload);
    if (!context) return false;
    if (context.pending) {
      context.lifecycle.pendingTitle = context.title;
      context.lifecycle.pendingTitleUrl = context.url;
      context.lifecycle.pendingTitleGeneration = payload.generation;
      context.lifecycle.pendingTitleNavigationToken = payload.navigationToken;
    } else {
      context.pair.tab.title = context.title;
      if (context.pair.project.id === state.activeProjectId &&
          activeWorkspaceRoot(context.pair.project) === context.pair.worktreePath) {
        renderBrowserTabs();
      }
      saveWorkspaceSoon();
    }
    if (typeof publishBrowserControlResource === "function") {
      publishBrowserControlResource(context.pair).catch(function () {});
    }
    return true;
  }
  function browserDocumentEventContext(payload, allowSameOriginRouteAdoption) {
    payload = payload || {};
    allowSameOriginRouteAdoption = allowSameOriginRouteAdoption === true;
    var nativeLabel = payload.label;
    if (typeof nativeLabel !== "string" || !nativeLabel ||
        typeof payload.url !== "string" || !payload.url ||
        !Number.isSafeInteger(payload.generation) || payload.generation <= 0 ||
        typeof payload.navigationToken !== "string" || !payload.navigationToken) return null;
    var nativeUrl = browserNativeUrl(payload.url);
    if (!nativeUrl) return null;
    var pair = browserNativeEventContext(
      nativeLabel,
      null,
      payload.navigationToken
    );
    if (!pair) return null;
    var pane = findBrowserPane(pair.project.id, pair.worktreePath);
    if (!pane || pane.projectId !== pair.project.id ||
        pane.worktreePath !== pair.worktreePath ||
        findThread(pane.id) !== pane) return null;
    var lifecycle = browserTabLifecycle(pair.tab);
    if (!lifecycle.viewLive ||
        lifecycle.nativeLabel !== nativeLabel ||
        !lifecycle.liveGeneration ||
        lifecycle.liveGeneration !== lifecycle.generation ||
        payload.generation !== lifecycle.liveGeneration ||
        !lifecycle.liveNavigationToken ||
        payload.navigationToken !== lifecycle.liveNavigationToken) return null;
    var liveUrl = null;
    var titleUrl = null;
    var replacementUrl = null;
    if (lifecycle.liveUrl &&
        !browserUrlsMatch(nativeUrl, lifecycle.liveUrl) &&
        (!lifecycle.eventUrl || !browserUrlsMatch(nativeUrl, lifecycle.eventUrl))) {
      if (allowSameOriginRouteAdoption &&
          browserUrlsShareOrigin(nativeUrl, lifecycle.liveUrl)) {
        liveUrl = nativeUrl;
        titleUrl = nativeUrl;
      } else {
        replacementUrl = nativeUrl;
      }
    } else if (lifecycle.liveUrl &&
               browserUrlsMatch(nativeUrl, lifecycle.liveUrl)) {
      titleUrl = lifecycle.liveUrl;
    } else if (lifecycle.eventUrl &&
               browserUrlsMatch(nativeUrl, lifecycle.eventUrl)) {
      titleUrl = lifecycle.eventUrl;
    }
    var title = titleUrl ? normaliseBrowserEventTitle(payload.title) : "";
    return {
      pair: pair,
      pane: pane,
      liveUrl: liveUrl,
      replacementUrl: replacementUrl,
      title: title || null,
    };
  }
  function browserFocusEventContext(payload) {
    var context = browserDocumentEventContext(payload, false);
    if (!context) return null;
    if (state.activeProjectId !== context.pair.project.id ||
        activeWorkspaceRoot(context.pair.project) !== context.pair.worktreePath ||
        browserPaneIsClosing(context.pane) ||
        context.pane.hidden) return null;
    return context;
  }
  function adoptBrowserDocumentEvent(context) {
    if (!context) return false;
    var isActiveProjectWorktree =
      context.pair.project.id === state.activeProjectId &&
      activeWorkspaceRoot(context.pair.project) === context.pair.worktreePath;
    if (context.liveUrl) {
      var lifecycle = browserTabLifecycle(context.pair.tab);
      var previousUrl = context.pair.tab.url;
      lifecycle.controlGeneration = Math.max(
        lifecycle.controlGeneration || 0,
        lifecycle.liveGeneration || 0,
        lifecycle.pendingGeneration || 0,
        lifecycle.generation || 0
      ) + 1;
      lifecycle.confirmedAbsentControlGeneration = 0;
      lifecycle.liveUrl = context.liveUrl;
      lifecycle.eventUrl = context.liveUrl;
      recordBrowserHistoryUrl(context.pair.tab, context.liveUrl, previousUrl);
      context.pair.tab.url = context.liveUrl;
      context.pair.tab.title = context.title || tabTitle(context.liveUrl);
      if (isActiveProjectWorktree) {
        renderBrowserTabs();
        syncUrlInput();
      }
      saveWorkspaceSoon();
      return true;
    }
    if (context.title && context.title !== context.pair.tab.title) {
      context.pair.tab.title = context.title;
      if (isActiveProjectWorktree) {
        renderBrowserTabs();
      }
      saveWorkspaceSoon();
    }
    return true;
  }
  function handleBrowserRoute(event) {
    var context = browserDocumentEventContext(event && event.payload || {}, true);
    if (!context) return false;
    if (context.replacementUrl) {
      return rotateBrowserAuthorityForNativeReplacement(
        context.pair,
        context.replacementUrl
      );
    }
    var adopted = adoptBrowserDocumentEvent(context);
    if (typeof publishBrowserControlResource === "function") {
      publishBrowserControlResource(context.pair).catch(function () {});
    }
    return adopted;
  }
  function handleBrowserFocus(event) {
    var context = browserFocusEventContext(event && event.payload || {});
    if (!context) return false;
    if (context.replacementUrl) {
      return rotateBrowserAuthorityForNativeReplacement(
        context.pair,
        context.replacementUrl
      );
    }
    var adopted = adoptBrowserDocumentEvent(context);
    markActiveSurface("browser");
    if (state.activeThreadId !== context.pane.id) focusThread(context.pane.id);
    if (typeof publishBrowserControlResource === "function") {
      publishBrowserControlResource(context.pair).catch(function () {});
    }
    return adopted;
  }
  listen("browser:page-load", handleBrowserPageLoad).catch(function () {});
  listen("browser:route", handleBrowserRoute).catch(function () {});
  listen("browser:title", handleBrowserTitle).catch(function () {});
  listen("browser:focus", handleBrowserFocus).catch(function () {});
  function ensureBrowserModel(project, workspaceRoot) {
    if (!project) return null;
    if (!project.browsersByWorktree) project.browsersByWorktree = {};
    var root = workspaceRoot || activeWorkspaceRoot(project) || project.root;
    if (!project.browsersByWorktree[root]) {
      project.browsersByWorktree[root] = { tabs: [], activeTabId: null };
    }
    return project.browsersByWorktree[root];
  }
  function makeBrowserTabId() { return "bt" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7); }
  var DICE_BROWSER_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ&start_radio=1&pp=ygUJcmljayByb2xsoAcB0gcJCckLAYcqIYzv";
  function tabTitle(url) {
    if (!url || url === "about:blank") return "New tab";
    try { return new URL(url).hostname || url; } catch (_) { return url; }
  }
  function currentBrowserTab(project) {
    project = project || activeProject();
    var browser = ensureBrowserModel(project);
    if (!browser) return null;
    var tab = browser.tabs.find(function (t) { return t.id === browser.activeTabId; });
    return tab || browser.tabs[0] || null;
  }
  function createBrowserTab(project, url, activate, worktreePath) {
    project = project || activeProject();
    if (!project || project.closing) return null;
    worktreePath = worktreePath || activeWorkspaceRoot(project);
    var pane = project && findBrowserPane(project.id, worktreePath);
    if (browserPaneIsClosing(pane)) return null;
    var browser = ensureBrowserModel(project, worktreePath);
    if (!browser) return null;
    var maxTabs = Math.min(settings.maxBrowserTabsPerProject, HARD_MAX_BROWSER_TABS_PER_PROJECT);
    if (browser.tabs.length >= maxTabs) { setStatus("browser tab limit reached (" + maxTabs + "/project)", "warn"); return null; }
    var normalised = url && url !== "about:blank" ? normaliseUrl(url) : "about:blank";
    var tab = { id: makeBrowserTabId(), url: normalised || "about:blank", title: tabTitle(normalised), history: normalised && normalised !== "about:blank" ? [normalised] : [], historyIndex: normalised && normalised !== "about:blank" ? 0 : -1, created: false, loading: false };
    browser.tabs.push(tab);
    if (activate || !browser.activeTabId) { browser.activeTabId = tab.id; markActiveSurface("browser"); }
    renderBrowserTabs(); saveWorkspaceSoon(); return tab;
  }
  async function closeBrowserTab(project, tabId) {
    project = project || activeProject();
    var browser = ensureBrowserModel(project); if (!browser) return false;
    var idx = browser.tabs.findIndex(function (t) { return t.id === tabId; }); if (idx < 0) return false;
    var tab = browser.tabs[idx];
    var lifecycle = browserTabLifecycle(tab);
    if (lifecycle.closing) return false;
    lifecycle.closing = true;
    var closingRoot = Object.keys(project.browsersByWorktree || {}).find(function (root) {
      return project.browsersByWorktree[root] === browser;
    }) || project.root;
    var closingPair = { project: project, worktreePath: closingRoot, browser: browser, tab: tab };
    if (lifecycle.nativeLabel) {
      if (!(await invalidateBrowserAutomation(closingPair))) {
        lifecycle.closing = false;
        setStatus("browser automation invalidation failed", "error");
        return false;
      }
      var closingControlRemoved = false;
      try {
        closingControlRemoved = await removeBrowserControlResource(closingPair);
      } catch (error) {
        lifecycle.closing = false;
        setStatus(
          "browser tab close failed before native teardown: " +
            boundedBrowserError(error),
          "error"
        );
        return false;
      }
      if (!closingControlRemoved) {
        lifecycle.closing = false;
        setStatus(
          "browser tab close failed before native teardown: browser control resource removal was not confirmed",
          "error"
        );
        return false;
      }
    }
    try {
      await invoke("browser_destroy", { label: browserLabelForTab(project, tab) });
      invalidateBrowserNavigation(tab);
    } catch (error) {
      lifecycle.closing = false;
      var closeStatus = "browser tab close failed: " + boundedBrowserError(error);
      try {
        var controlRestored = await installBrowserAutomationForPair(closingPair);
        if (!controlRestored) {
          closeStatus += "; browser control restore was not confirmed";
        }
      } catch (restoreError) {
        closeStatus += "; browser control restore failed: " + boundedBrowserError(restoreError);
      }
      setStatus(closeStatus, "error");
      return false;
    }
    idx = browser.tabs.findIndex(function (t) { return t === tab; });
    if (idx < 0) {
      lifecycle.closing = false;
      return false;
    }
    var next = null;
    browser.tabs.splice(idx, 1);
    if (browser.activeTabId === tabId) { next = browser.tabs[Math.min(idx, browser.tabs.length - 1)] || null; browser.activeTabId = next ? next.id : null; }
    renderBrowserTabs(); syncProjectBrowser(); saveWorkspaceSoon();
    if (next && !next.created) await restoreDormantBrowserTab(project, next);
    lifecycle.closing = false;
    return true;
  }
  async function restoreDormantBrowserTab(project, tab) {
    var worktreePath = activeWorkspaceRoot(project);
    var pane = project && findBrowserPane(project.id, worktreePath);
    if (!tab || browserTabIsClosing(tab) || browserPaneIsClosing(pane) ||
        tab.created || !tab.url || tab.url === "about:blank") return false;
    var navigated = await navigateBrowser(tab.url, { tabId: tab.id, preserveHistory: true });
    pane = project && findBrowserPane(project.id, worktreePath);
    return navigated && !browserTabIsClosing(tab) && !browserPaneIsClosing(pane) &&
      tab.created === true;
  }
  async function activateBrowserTab(project, tabId) {
    project = project || activeProject();
    var browser = ensureBrowserModel(project);
    if (!browser) return false;
    var tab = browser.tabs.find(function (t) { return t.id === tabId; });
    var pane = findBrowserPane(project.id, activeWorkspaceRoot(project));
    if (!tab || browserTabIsClosing(tab) || browserPaneIsClosing(pane)) return false;
    var lifecycle = browserTabLifecycle(tab);
    if (lifecycle.cleanupOperation) {
      tab.created = false;
      tab.loading = false;
    }
    markActiveSurface("browser");
    browser.activeTabId = tabId;
    renderBrowserTabs(); syncProjectBrowser(); saveWorkspaceSoon();
    var activationOperation = lifecycle.activationOperation;
    if (!activationOperation) {
      activationOperation = (async function () {
        while (lifecycle.pendingOperation || lifecycle.cleanupOperation) {
          var pending = lifecycle.pendingOperation || lifecycle.cleanupOperation;
          await pending.promise;
        }
        pane = findBrowserPane(project.id, activeWorkspaceRoot(project));
        if (browser.tabs.indexOf(tab) === -1 || browserTabIsClosing(tab) ||
            browserPaneIsClosing(pane)) return false;
        if (browser.activeTabId === tab.id && !tab.created) {
          await restoreDormantBrowserTab(project, tab);
        }
        pane = findBrowserPane(project.id, activeWorkspaceRoot(project));
        return browser.tabs.indexOf(tab) !== -1 && !browserTabIsClosing(tab) &&
          !browserPaneIsClosing(pane);
      })();
      lifecycle.activationOperation = activationOperation;
    }
    try {
      return await activationOperation;
    } finally {
      if (lifecycle.activationOperation === activationOperation) {
        lifecycle.activationOperation = null;
      }
    }
  }
  async function openBlankBrowserTab(options) {
    options = options || {};
    var project = activeProject();
    if (!project) return null;
    var worktreePath = activeWorkspaceRoot(project);
    var existing = findBrowserPane(project.id, worktreePath);
    if (browserPaneIsClosing(existing)) return null;
    var pane = await createBrowserPane(project);
    if (!pane || browserPaneIsClosing(pane)) return null;
    markActiveSurface("browser");
    var browser = ensureBrowserModel(project, worktreePath);
    var tab = null;
    if (options.requireNew || existing || !browser.tabs.length) {
      tab = createBrowserTab(project, "about:blank", true);
    } else {
      renderBrowserTabs();
    }
    syncProjectBrowser();
    if (!options.requireNew && !tab) {
      var activeTab = currentBrowserTab(project);
      if (activeTab && !activeTab.created) await restoreDormantBrowserTab(project, activeTab);
    }
    if (browserPaneIsClosing(pane)) return null;
    if (urlInput) urlInput.focus();
    return tab || (options.requireNew ? null : currentBrowserTab(project));
  }
  async function openDiceBrowserTab() {
    var tab = await openBlankBrowserTab({ requireNew: true });
    if (!tab) return;
    await navigateBrowser(DICE_BROWSER_URL, { tabId: tab.id });
  }
  listen("browser:shortcut-new-tab", function () {
    openBlankBrowserTab();
  }).catch(function () {});
  listen("browser:shortcut-terminal-pane", function () {
    createTerminalPane();
  }).catch(function () {});
  listen("browser:shortcut-agent-pane", function () {
    openAgentPicker();
  }).catch(function () {});
  listen("browser:shortcut-composer", function () {
    commandInput.focus();
    openPalette("/", true);
  }).catch(function () {});
  function appendBrowserTabAddButton() {
    if (!browserTabStrip) return;
    var add = document.createElement("button"); add.className = "browser-tab-add"; add.textContent = "+"; add.title = "New browser tab for this project"; add.addEventListener("click", openBlankBrowserTab); browserTabStrip.appendChild(add);
  }
  function renderBrowserTabs() {
    if (!browserTabStrip) return;
    var project = activeProject(); var browser = ensureBrowserModel(project); browserTabStrip.innerHTML = "";
    if (!browser || browser.tabs.length === 0) {
      var empty = document.createElement("span"); empty.className = "browser-tab-empty"; empty.textContent = "project browser"; browserTabStrip.appendChild(empty); appendBrowserTabAddButton(); syncUrlInput(); return;
    }
    browser.tabs.forEach(function (tab) {
      var btn = document.createElement("button");
      btn.className = "browser-tab" + (tab.id === browser.activeTabId ? " active" : "") + (tab.loading ? " loading" : "");
      btn.dataset.tabId = tab.id;
      btn.title = tab.url || "New tab";
      btn.innerHTML = '<span class="browser-tab-favicon" aria-hidden="true"></span><span class="browser-tab-title">' + escapeHtml(tab.title || "New tab") + '</span><span class="browser-tab-close">×</span>';
      btn.addEventListener("click", async function (event) { if (event.target && event.target.classList.contains("browser-tab-close")) await closeBrowserTab(project, tab.id); else await activateBrowserTab(project, tab.id); });
      browserTabStrip.appendChild(btn);
    });
    appendBrowserTabAddButton(); syncUrlInput();
  }
  function updateBrowserControls() {
    var tab = currentBrowserTab(); var back = document.getElementById("back"); var forward = document.getElementById("forward"); var reload = document.getElementById("reload"); var external = document.getElementById("open-external");
    if (back) back.disabled = !(tab && tab.historyIndex > 0);
    if (forward) forward.disabled = !(tab && tab.historyIndex < tab.history.length - 1);
    if (reload) { reload.disabled = !(tab && tab.created); reload.classList.toggle("loading", !!(tab && tab.loading)); }
    if (external) external.disabled = !(tab && tab.url && tab.url !== "about:blank");
  }
  function syncUrlInput() {
    var tab = currentBrowserTab();
    if (urlInput) urlInput.value = tab && tab.url !== "about:blank" ? tab.url : "";
    if (previewEmpty) previewEmpty.hidden = !!(tab && tab.created);
    if (preview) preview.classList.toggle("loading", !!(tab && tab.loading));
    updateBrowserControls();
  }
  function visibleBrowserBounds() {
    var project = activeProject();
    var pane = project && findBrowserPane(project.id, activeWorkspaceRoot(project));
    if (!pane || pane.hidden || !pane.pane || !pane.pane.isConnected ||
        !preview.isConnected || browserSurface.parentElement !== pane.browserBody) return null;
    var rect = preview.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
  }
  function syncProjectBrowser() { renderBrowserTabs(); scheduleBrowserBounds(); }
  function syncBrowserBounds() {
    var project = activeProject(); var tab = currentBrowserTab(project); var label = browserLabelForTab(project, tab); var b = visibleBrowserBounds();
    if (!b || !tab || !tab.created) { invoke("browser_hide_all_except", { label: null }).catch(function () {}); return; }
    invoke("browser_hide_all_except", { label: label }).catch(function () {});
    invoke("browser_set_bounds", { label: label, x: b.x, y: b.y, w: b.w, h: b.h }).catch(function () {});
  }
  function scheduleBrowserBounds() {
    var project = activeProject();
    var pane = project && findBrowserPane(project.id, activeWorkspaceRoot(project));
    var tab = currentBrowserTab(project);
    var identity = pane ? pane.id : project && tab ? browserLabelForTab(project, tab) : "visible";
    terminalFrameScheduler.schedule("browser:" + identity + ":bounds", function () {
      var currentProject = activeProject();
      var currentPane = currentProject && findBrowserPane(
        currentProject.id,
        activeWorkspaceRoot(currentProject)
      );
      if (currentProject !== project || currentPane !== pane || currentBrowserTab(currentProject) !== tab) {
        return;
      }
      syncBrowserBounds();
    });
  }
  async function navigateBrowser(rawUrl, opts) {
    opts = opts || {};
    var normalised = normaliseUrl(rawUrl);
    if (!normalised) return false;
    var project = activeProject();
    if (!project) return false;
    return navigateBrowserForContext(normalised, {
      project: project,
      projectId: project.id,
      worktreePath: activeWorkspaceRoot(project) || project.root,
      tabId: opts.tabId,
      replace: opts.replace,
      preserveHistory: opts.preserveHistory,
      fromHistory: opts.fromHistory,
      historyIndex: opts.historyIndex,
    });
  }
  async function navigateBrowserForContext(rawUrl, context) {
    context = context || {};
    var project = context.project;
    var projectId = context.projectId;
    var worktreePath = context.worktreePath;
    if (!project || !projectId || project.id !== projectId || !worktreePath) return false;
    var normalised = normaliseUrl(rawUrl);
    if (!normalised) return false;
    var sourceThread = context.sourceThread || null;
    var sourceThreadId = sourceThread && sourceThread.id;
    var sourceProjectId = sourceThread && sourceThread.projectId;
    var sourceWorktreePath = sourceThread && sourceThread.worktreePath;
    var scopeIsCurrent = function () {
      if (!browserProjectContextIsCurrent(project, projectId, worktreePath) ||
          (typeof findProject === "function" && findProject(projectId) !== project)) return false;
      if (sourceThread && (
        sourceThread.id !== sourceThreadId ||
        sourceThread.projectId !== sourceProjectId ||
        sourceThread.worktreePath !== sourceWorktreePath ||
        sourceProjectId !== projectId ||
        sourceWorktreePath !== worktreePath ||
        findThread(sourceThreadId) !== sourceThread
      )) return false;
      return true;
    };
    if (!scopeIsCurrent()) return false;
    var hasRequestedTab = context.tabId != null;
    var browser = ensureBrowserModel(project, worktreePath);
    var browsersByWorktree = project.browsersByWorktree || null;
    var tab = hasRequestedTab
      ? browser.tabs.find(function (t) { return t.id === context.tabId; })
      : browser.tabs.find(function (t) { return t.id === browser.activeTabId; }) ||
        browser.tabs[0] || null;
    if ((hasRequestedTab && !tab) || browserTabIsClosing(tab)) return false;
    var pane = findBrowserPane(projectId, worktreePath);
    var requestIsCurrent = function () {
      if (!scopeIsCurrent() ||
          (browsersByWorktree
            ? (project.browsersByWorktree !== browsersByWorktree ||
              browsersByWorktree[worktreePath] !== browser)
            : ensureBrowserModel(project, worktreePath) !== browser) ||
          (tab && (
            browser.tabs.indexOf(tab) === -1 ||
            browserTabIsClosing(tab) ||
            (!hasRequestedTab && browser.activeTabId !== tab.id)
          ))) return false;
      if (!pane) return findBrowserPane(projectId, worktreePath) === null;
      return pane.projectId === projectId && pane.worktreePath === worktreePath &&
        findThread(pane.id) === pane &&
        findBrowserPane(projectId, worktreePath) === pane &&
        !browserPaneIsClosing(pane);
    };
    if (!requestIsCurrent()) return false;
    if (pane && tab) {
      if (!(await focusBrowserPaneForNavigation(pane, {
        isCurrent: requestIsCurrent,
      }))) return false;
    } else {
      var creationKey = projectId + "\0" + worktreePath;
      var previousCreation = browserCreationFlights.get(creationKey) || Promise.resolve();
      var resolveTarget = async function () {
        if (!scopeIsCurrent()) return null;
        var targetBrowser = ensureBrowserModel(project, worktreePath);
        var targetBrowsersByWorktree = project.browsersByWorktree || null;
        if (!targetBrowser || (targetBrowsersByWorktree &&
            targetBrowsersByWorktree[worktreePath] !== targetBrowser)) return null;
        var targetPane = findBrowserPane(projectId, worktreePath);
        var resourcesAreCurrent = function () {
          if (!scopeIsCurrent() ||
              (targetBrowsersByWorktree
                ? (project.browsersByWorktree !== targetBrowsersByWorktree ||
                  targetBrowsersByWorktree[worktreePath] !== targetBrowser)
                : ensureBrowserModel(project, worktreePath) !== targetBrowser)) return false;
          if (!targetPane) return findBrowserPane(projectId, worktreePath) === null;
          return targetPane.projectId === projectId &&
            targetPane.worktreePath === worktreePath &&
            findThread(targetPane.id) === targetPane &&
            findBrowserPane(projectId, worktreePath) === targetPane &&
            !browserPaneIsClosing(targetPane);
        };
        if (!resourcesAreCurrent()) return null;
        var paneAlreadyFocused = false;
        if (!targetPane) {
          var createdPane = await createBrowserPane(project, {
            worktreePath: worktreePath,
            isCurrent: scopeIsCurrent,
          });
          if (!createdPane || !scopeIsCurrent()) return null;
          targetBrowser = ensureBrowserModel(project, worktreePath);
          targetBrowsersByWorktree = project.browsersByWorktree || null;
          targetPane = findBrowserPane(projectId, worktreePath);
          paneAlreadyFocused = targetPane === createdPane;
          if (!targetBrowser || !targetPane || !resourcesAreCurrent()) return null;
        }
        if (!(await focusBrowserPaneForNavigation(targetPane, {
          alreadyFocused: paneAlreadyFocused,
          isCurrent: resourcesAreCurrent,
        }))) return null;
        if (!scopeIsCurrent()) return null;
        targetBrowser = ensureBrowserModel(project, worktreePath);
        targetBrowsersByWorktree = project.browsersByWorktree || null;
        targetPane = findBrowserPane(projectId, worktreePath);
        if (!targetBrowser || !targetPane || !resourcesAreCurrent()) return null;
        var targetTab = hasRequestedTab
          ? targetBrowser.tabs.find(function (t) { return t.id === context.tabId; })
          : targetBrowser.tabs.find(function (t) {
              return t.id === targetBrowser.activeTabId;
            }) || targetBrowser.tabs[0] || null;
        if ((hasRequestedTab && !targetTab) || browserTabIsClosing(targetTab)) return null;
        if (!targetTab) {
          targetTab = targetBrowser.tabs.find(function (t) {
            return t.id === targetBrowser.activeTabId;
          }) || targetBrowser.tabs[0] || null;
          if (!targetTab) {
            targetTab = createBrowserTab(
              project,
              "about:blank",
              true,
              worktreePath
            );
          }
        }
        if (!targetTab || browserTabIsClosing(targetTab) ||
            targetBrowser.tabs.indexOf(targetTab) === -1 ||
            (!hasRequestedTab && targetBrowser.activeTabId !== targetTab.id) ||
            !resourcesAreCurrent()) return null;
        return {
          browser: targetBrowser,
          pane: targetPane,
          tab: targetTab,
          requestIsCurrent: function () {
            return resourcesAreCurrent() &&
              targetBrowser.tabs.indexOf(targetTab) !== -1 &&
              !browserTabIsClosing(targetTab) &&
              (hasRequestedTab || targetBrowser.activeTabId === targetTab.id);
          },
        };
      };
      var targetPromise = previousCreation.then(resolveTarget, resolveTarget);
      var creationTail = targetPromise.then(function () {}, function () {});
      browserCreationFlights.set(creationKey, creationTail);
      var target;
      try {
        target = await targetPromise;
      } finally {
        if (browserCreationFlights.get(creationKey) === creationTail) {
          browserCreationFlights.delete(creationKey);
        }
      }
      if (!target) return false;
      browser = target.browser;
      pane = target.pane;
      tab = target.tab;
      requestIsCurrent = target.requestIsCurrent;
    }
    var lifecycle = browserTabLifecycle(tab);
    var invalidationGeneration = lifecycle.invalidationGeneration;
    var runNavigation = async function () {
      if (lifecycle.invalidationGeneration !== invalidationGeneration ||
          !requestIsCurrent()) return false;
      var previousCreated = tab.created;
      var previousLoading = tab.loading;
      var previousTitle = tab.title;
      var previousUrl = tab.url;
      var previousHistory = Array.isArray(tab.history) ? tab.history.slice() : [];
      var previousHistoryIndex = tab.historyIndex;
      var navigationPair = { project: project, worktreePath: worktreePath, browser: browser, tab: tab };
      var removalGeneration = lifecycle.quarantinedControlGeneration || 0;
      if (lifecycle.nativeLabel) {
        var automationInvalidated = false;
        try {
          automationInvalidated = await invalidateBrowserAutomation(navigationPair);
        } catch (error) {
          setStatus("browser navigation failed before dispatch: " + boundedBrowserError(error), "error");
          return false;
        }
        if (!automationInvalidated) {
          setStatus("browser automation invalidation failed", "error");
          return false;
        }
        removalGeneration =
          lifecycle.controlGeneration || lifecycle.liveGeneration || lifecycle.pendingGeneration;
      }
      if (removalGeneration) {
        lifecycle.authorityTransition = true;
        try {
          var controlRemoved = await removeBrowserControlResource(
            navigationPair,
            removalGeneration
          );
          if (!controlRemoved) {
            throw new Error("browser control resource removal was not confirmed");
          }
          lifecycle.quarantinedControlGeneration = 0;
        } catch (error) {
          lifecycle.authorityTransition = false;
          setStatus("browser navigation failed before dispatch: " + boundedBrowserError(error), "error");
          return false;
        }
      }
      if (lifecycle.invalidationGeneration !== invalidationGeneration || !requestIsCurrent()) {
        lifecycle.authorityTransition = false;
        return false;
      }
      var navigationVisible = browserNavigationOwnsVisiblePane({
        project: project,
        worktreePath: worktreePath,
        browser: browser,
        pane: pane,
        tab: tab,
      });
      var b = navigationVisible
        ? visibleBrowserBounds()
        : { x: -10000, y: -10000, w: 1, h: 1 };
      if (!b) {
        lifecycle.authorityTransition = false;
        return false;
      }
      var generation = beginBrowserNavigation(tab);
      lifecycle.controlGeneration = 0;
      var navigationToken = generation + ":" + (globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : Date.now() + ":" + Math.random());
      if (!lifecycle.automationSource) lifecycle.automationSource = PsycheControl.browserAutomationSource();
      var label = browserLabelForTab(project, tab);
      var nativeLabel = nativeBrowserLabel(label);
      lifecycle.nativeLabel = nativeLabel;
      lifecycle.pendingGeneration = generation;
      lifecycle.pendingUrl = normalised;
      lifecycle.pendingNavigationToken = navigationToken;
      lifecycle.pendingTitle = null;
      lifecycle.pendingTitleUrl = null;
      lifecycle.pendingTitleGeneration = 0;
      lifecycle.pendingTitleNavigationToken = null;
      lifecycle.eventUrl = null;
      lifecycle.viewLive = true;
      lifecycle.authorityTransition = false;
      lifecycle.navigationSnapshot = {
        url: previousUrl,
        title: previousTitle,
        history: previousHistory.slice(),
        historyIndex: previousHistoryIndex,
      };
      var navigationContext = {
        project: project,
        worktreePath: worktreePath,
        browser: browser,
        pane: pane,
        tab: tab,
        activeTabReuse: !hasRequestedTab,
        generation: generation,
        label: label,
        previousCreated: previousCreated,
        previousLoading: previousLoading,
        previousTitle: previousTitle,
        previousUrl: previousUrl,
        previousHistory: previousHistory,
        previousHistoryIndex: previousHistoryIndex,
        controlResourceRemoved: removalGeneration > 0,
      };
      tab.loading = true;
      if (!context.preserveHistory) tab.title = tabTitle(normalised);
      renderBrowserTabs(); updateBrowserControls();
      try {
        var nativeNavigation = await invoke("browser_navigate", { label: label, url: normalised, x: b.x, y: b.y, w: b.w, h: b.h, generation: generation, navigationToken: navigationToken, automationSource: lifecycle.automationSource });
        if ((sourceThread && !scopeIsCurrent()) ||
            !browserNavigationIsCurrent(navigationContext)) {
          await discardObsoleteBrowserNavigation(navigationContext);
          return false;
        }
        var terminalUrl = nativeNavigation && nativeNavigation.terminalUrl
          ? String(nativeNavigation.terminalUrl)
          : normalised;
        var completedTitle = lifecycle.pendingTitle &&
          lifecycle.pendingTitleGeneration === generation &&
          lifecycle.pendingTitleNavigationToken === navigationToken &&
          browserUrlsMatch(lifecycle.pendingTitleUrl, terminalUrl)
          ? lifecycle.pendingTitle
          : null;
        tab.created = true;
        tab.url = terminalUrl;
        tab.loading = false;
        lifecycle.liveGeneration = generation;
        lifecycle.liveUrl = terminalUrl;
        lifecycle.liveNavigationToken = navigationToken;
        lifecycle.pendingGeneration = 0;
        lifecycle.pendingUrl = null;
        lifecycle.pendingNavigationToken = null;
        lifecycle.pendingTitle = null;
        lifecycle.pendingTitleUrl = null;
        lifecycle.pendingTitleGeneration = 0;
        lifecycle.pendingTitleNavigationToken = null;
        lifecycle.eventUrl = terminalUrl;
        lifecycle.navigationSnapshot = null;
        lifecycle.viewLive = true;
        if (completedTitle) tab.title = completedTitle;
        else if (!browserUrlsMatch(terminalUrl, normalised)) tab.title = tabTitle(terminalUrl);
        if (context.fromHistory && typeof context.historyIndex === "number") {
          tab.historyIndex = context.historyIndex;
        } else if (!context.fromHistory && !context.preserveHistory) {
          tab.history = context.replace ? [] : tab.history.slice(0, tab.historyIndex + 1);
          tab.history.push(terminalUrl);
          tab.historyIndex = tab.history.length - 1;
        }
        if (browserNavigationOwnsVisiblePane(navigationContext)) syncProjectBrowser();
        else scheduleBrowserBounds();
        var automationInstalled = await Promise.resolve(
          installBrowserAutomationForPair(navigationPair)
        ).catch(function () { return false; });
        if (!automationInstalled) {
          await Promise.resolve(publishBrowserControlResource(navigationPair)).catch(function () { return false; });
        }
        saveWorkspaceSoon();
        return true;
      } catch (err) {
        if (!browserNavigationIsCurrent(navigationContext)) {
          await discardObsoleteBrowserNavigation(Object.assign(
            { ambiguousAfterDispatch: true },
            navigationContext
          ));
          return false;
        }
        await discardObsoleteBrowserNavigation(Object.assign(
          {
            ambiguousAfterDispatch: true,
            preserveQueuedNavigation: true,
          },
          navigationContext
        ));
        setStatus(
          "browser navigation failed: " + boundedBrowserError(err),
          "error"
        );
        return false;
      }
    };
    var operation = {
      id: lifecycle.operationGeneration + 1,
      promise: null,
    };
    lifecycle.operationGeneration = operation.id;
    var navigation = lifecycle.navigationTail
      ? lifecycle.navigationTail.then(runNavigation, runNavigation)
      : runNavigation();
    var navigationSettlement = navigation.then(function () {
      if (lifecycle.pendingOperation === operation) lifecycle.pendingOperation = null;
    }, function () {
      if (lifecycle.pendingOperation === operation) lifecycle.pendingOperation = null;
    });
    operation.promise = navigationSettlement;
    lifecycle.pendingOperation = operation;
    lifecycle.navigationTail = navigationSettlement;
    return navigation;
  }
  function normaliseUrl(value) {
    if (!value) return ""; var trimmed = String(value).trim(); if (!trimmed) return ""; if (trimmed === "about:blank") return trimmed;
    if (trimmed.indexOf("://") === -1) { var local = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\.|::1)/i.test(trimmed); trimmed = (local ? "http://" : "https://") + trimmed; }
    try { new URL(trimmed); return trimmed; } catch (_) { return ""; }
  }
  urlInput.addEventListener("keydown", function (e) { if (e.key === "Enter") navigateBrowser(urlInput.value); });
  document.getElementById("reload").addEventListener("click", function () {
    var project = activeProject(); var tab = currentBrowserTab(project); var pane = project && findBrowserPane(project.id, activeWorkspaceRoot(project));
    if (tab && tab.created && !browserTabIsClosing(tab) && !browserPaneIsClosing(pane)) {
      navigateBrowser(tab.url, { tabId: tab.id, replace: true, preserveHistory: true }).catch(function () {});
    }
  });
  document.getElementById("back").addEventListener("click", function () { var tab = currentBrowserTab(); if (tab && !browserTabIsClosing(tab) && tab.historyIndex > 0) { var index = tab.historyIndex - 1; navigateBrowser(tab.history[index], { tabId: tab.id, fromHistory: true, historyIndex: index }); } });
  document.getElementById("forward").addEventListener("click", function () { var tab = currentBrowserTab(); if (tab && !browserTabIsClosing(tab) && tab.historyIndex < tab.history.length - 1) { var index = tab.historyIndex + 1; navigateBrowser(tab.history[index], { tabId: tab.id, fromHistory: true, historyIndex: index }); } });
  document.getElementById("open-surprise").addEventListener("click", openDiceBrowserTab);
  document.getElementById("open-external").addEventListener("click", function () { var tab = currentBrowserTab(); if (tab && tab.url && tab.url !== "about:blank" && openUrl) openUrl(tab.url).catch(function () {}); });
  if (typeof ResizeObserver === "function") { var ro = new ResizeObserver(function () { scheduleBrowserBounds(); }); ro.observe(preview); ro.observe(detail); }
  function handleWindowBeforeUnload(event) {
    saveWorkspaceNow().catch(function () {});
    if (destroyingWindow || !state.openFiles.some(function (file) {
      return file.dirty || file.savePromise;
    })) return;
    event.preventDefault();
    event.returnValue = true;
    return true;
  }
  window.addEventListener("beforeunload", handleWindowBeforeUnload);
  document.addEventListener("visibilitychange", handleVisibilityChange);

  // ============================================================
  // 11. Keyboard shortcuts
  // ============================================================

  async function prepareDefaultThreadCreation() {
    return showTerminalView();
  }

  async function createTerminalPane() {
    var project = activeProject();
    if (!project || !project.root) {
      setStatus("Open a project before starting a terminal", "warn");
      return null;
    }
    if (project.closing) {
      setStatus(project.name + " is closing; wait before starting a terminal", "warn");
      return null;
    }
    var worktree = selectedWorktree(project);
    if (!worktree || !worktree.path) {
      setStatus("Select an available worktree before starting a terminal", "warn");
      return null;
    }
    if (!(await showTerminalView())) return null;
    if (project.closing) {
      setStatus(project.name + " is closing; wait before starting a terminal", "warn");
      return null;
    }
    return spawnShellThread(project);
  }

  function isTextEntryTarget(target) {
    var tag = String(target && target.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" ||
      Boolean(target && target.isContentEditable);
  }

  function gitPaneShortcutBlocked() {
    return Boolean(
      (dirtyFileDialogEl && dirtyFileDialogEl.open) ||
      agentPickerOpen() ||
      (helpOverlayEl && !helpOverlayEl.hidden)
    );
  }

  function routeGitPaneShortcut(event) {
    if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey ||
        String(event.key).toLowerCase() !== "g" ||
        isTextEntryTarget(event.target) || gitPaneShortcutBlocked()) return false;
    event.preventDefault();
    openOrFocusGitPane().catch(function () {});
    return true;
  }

  function routeFilesShortcut(e) {
    if (!filesPaneHasCanvasFocus()) return false;
    if (e.key === "Escape") {
      e.preventDefault();
      returnFromFileFocus();
      return true;
    }
    var meta = e.metaKey || e.ctrlKey;
    if (!meta) return false;
    var key = String(e.key).toLowerCase();
    if (key === "s") {
      handleExplicitFileSave(e);
      return true;
    }
    if (key === "w") {
      e.preventDefault();
      if (state.activeFileId) closeFileTab(state.activeFileId);
      return true;
    }
    if (e.key === "[") { e.preventDefault(); switchTab(-1); return true; }
    if (e.key === "]") { e.preventDefault(); switchTab(+1); return true; }
    var index = parseInt(e.key, 10);
    if (Number.isInteger(index) && index >= 1 && index <= 9) {
      if (e.ctrlKey && !e.metaKey) return false;
      e.preventDefault();
      var files = projectFiles();
      if (files[index - 1]) {
        activateFileTab(files[index - 1].id);
      }
      return true;
    }
    return false;
  }

  async function routeGlobalShortcut(e) {
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      if (e.code === "KeyT") {
        e.preventDefault();
        await runNewShellCommand();
        return;
      }
      if (e.code === "KeyA") {
        e.preventDefault();
        await runNewThreadCommand();
        return;
      }
    }
    if (routeAgentPickerModalKeydown(e)) return;
    if (routeGitPaneShortcut(e)) return;
    var meta = e.metaKey || e.ctrlKey;
    if (!meta) return;
    if (routeFilesShortcut(e)) return;
    // ⌘T always opens a plain login shell in the terminal canvas.
    if (String(e.key).toLowerCase() === "t") {
      e.preventDefault();
      await createTerminalPane();
      return;
    }
    if (String(e.key).toLowerCase() === "d" && !e.altKey && !e.shiftKey) {
      if (openAgentPicker()) e.preventDefault();
      return;
    }
    // ⌘O opens a new project (folder picker → addProject → Coven).
    if (e.key === "o") { openProjectPicker(); e.preventDefault(); return; }
    // Outside Files, ⌘W keeps its workspace-level project behavior.
    if (e.key === "w") {
      e.preventDefault();
      if (state.activeProjectId) await removeProject(state.activeProjectId);
      return;
    }
    if (String(e.key).toLowerCase() === "f" && !e.altKey && !e.shiftKey) {
      commandInput.focus();
      openPalette("/", true);
      e.preventDefault();
      return;
    }
    // ⌘B collapses the sessions sidebar.
    if (e.code === "KeyB" && !e.altKey && !e.shiftKey) { toggleSidebar(); e.preventDefault(); return; }
    // ⌃1–9 addresses the panes on the canvas; ⌘1–9 stays on file tabs.
    if (e.ctrlKey && !e.metaKey) {
      var paneIndex = parseInt(e.key, 10);
      if (Number.isInteger(paneIndex) && paneIndex >= 1) {
        var shortcutLayout = activePaneLayout();
        var shortcutPaneIds = canvasThreadIds().filter(function (candidateId) {
          return paneFocusEligible(shortcutLayout, candidateId);
        });
        var paneId = shortcutPaneIds[paneIndex - 1];
        if (paneId) { await focusThread(paneId); e.preventDefault(); }
        return;
      }
    }
    // With another surface focused, tab navigation addresses projects.
    if (e.key === "[") { e.preventDefault(); await switchTab(-1); return; }
    if (e.key === "]") { e.preventDefault(); await switchTab(+1); return; }
    var n = parseInt(e.key, 10);
    if (Number.isInteger(n) && n >= 1 && n <= 9) {
      var p = state.projects[n - 1];
      if (p) { e.preventDefault(); await setActiveProject(p.id); }
    }
  }

  document.addEventListener("keydown", function (e) {
    routeGlobalShortcut(e);
  }, true);
  // ---- Side rails ----
  // Each rail button is a click affordance for a shortcut that already exists;
  // They call the same functions the ⌘-handlers above do, so there is no
  // second code path to keep in sync.
  function onRailClick(id, handler) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("click", handler);
  }
  onRailClick("rail-new-tab", function () { toggleNewPaneMenu(); });
  onRailClick("rail-open-project", function () { openProjectPicker(); });
  onRailClick("rail-palette", function () { commandInput.focus(); openPalette("/", true); });

  // ============================================================
  // 11a. Shell chrome — sidebar, new-pane menu, help
  // ============================================================

  var pendingSidebarOpen = null;
  var pendingSidebarWidth = null;
  function sidebarOpen() {
    if (pendingSidebarOpen !== null) return pendingSidebarOpen;
    return !appEl || appEl.dataset.sidebar !== "collapsed";
  }
  function syncSidebarToggleState(collapsed) {
    var titlebarLabel = collapsed ? "Expand sidebar" : "Collapse sidebar";
    if (sidebarCollapseEl) {
      sidebarCollapseEl.setAttribute("title", titlebarLabel + " (⌘B)");
      sidebarCollapseEl.setAttribute("aria-label", titlebarLabel);
      sidebarCollapseEl.setAttribute("aria-pressed", collapsed ? "true" : "false");
    }
    if (sidebarExpandEl) {
      sidebarExpandEl.hidden = !collapsed;
      sidebarExpandEl.setAttribute("title", "Expand sidebar (⌘B)");
      sidebarExpandEl.setAttribute("aria-label", "Expand sidebar");
      sidebarExpandEl.setAttribute("aria-pressed", collapsed ? "true" : "false");
    }
  }
  function setSidebarOpen(open) {
    if (!appEl) return;
    pendingSidebarOpen = Boolean(open);
    if (!open) closeNewPaneMenu();
    scheduleSidebarLayout();
  }
  function scheduleSidebarWidth(width) {
    pendingSidebarWidth = width;
    scheduleSidebarLayout();
  }
  function scheduleSidebarLayout() {
    terminalFrameScheduler.schedule("layout:sidebar", function () {
      var layoutChanged = false;
      if (pendingSidebarOpen !== null) {
        var open = pendingSidebarOpen;
        pendingSidebarOpen = null;
        appEl.dataset.sidebar = open ? "open" : "collapsed";
        if (sidebarMiniEl) sidebarMiniEl.hidden = open;
        syncSidebarToggleState(!open);
        layoutChanged = true;
      }
      if (pendingSidebarWidth !== null) {
        document.documentElement.style.setProperty("--sidebar-w", pendingSidebarWidth + "px");
        pendingSidebarWidth = null;
        layoutChanged = true;
      }
      if (layoutChanged) {
        scheduleTerminalPaneFits();
        scheduleBrowserBounds();
      }
      syncSessionListScroll();
    });
  }
  function toggleSidebar() { setSidebarOpen(!sidebarOpen()); }

  onRailClick("sidebar-collapse", function () { toggleSidebar(); });
  onRailClick("sidebar-expand", function () { setSidebarOpen(true); });
  // Sidebar width is a CSS custom property shared by the grid and the rail.
  if (sidebarResizeEl) {
    sidebarResizeEl.addEventListener("pointerdown", function (event) {
      event.preventDefault();
      event.stopPropagation();
      var startX = event.clientX;
      var startWidth = sidebarEl ? sidebarEl.getBoundingClientRect().width : 276;
      sidebarResizeEl.classList.add("dragging");
      function move(moveEvent) {
        var next = Math.min(440, Math.max(210, startWidth + (moveEvent.clientX - startX)));
        scheduleSidebarWidth(next);
      }
      function up() {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        sidebarResizeEl.classList.remove("dragging");
        scheduleSidebarLayout();
      }
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  function newPaneMenuItems() {
    if (!newPaneMenuEl) return [];
    return Array.prototype.filter.call(
      newPaneMenuEl.querySelectorAll('[role="menuitem"]'),
      function (item) { return !item.disabled; }
    );
  }
  function focusNewPaneMenuItem(index) {
    var items = newPaneMenuItems();
    if (!items.length) return false;
    var next = ((index % items.length) + items.length) % items.length;
    items[next].focus();
    return true;
  }
  function closeNewPaneMenu(restoreTriggerFocus) {
    if (newPaneMenuEl) newPaneMenuEl.hidden = true;
    var trigger = document.getElementById("rail-new-tab");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
    if (restoreTriggerFocus && trigger && trigger.focus) trigger.focus();
  }
  function toggleNewPaneMenu() {
    if (!newPaneMenuEl) { createTerminalPane(); return; }
    var open = newPaneMenuEl.hidden;
    if (open) {
      var project = activeProject();
      var worktree = project ? selectedWorktree(project) : null;
      if (newPaneMenuHeadEl) {
        newPaneMenuHeadEl.textContent = worktree && worktree.branch
          ? "New pane on " + worktree.branch
          : project ? "New pane in " + project.name : "New pane";
      }
    }
    var trigger = document.getElementById("rail-new-tab");
    if (!open) { closeNewPaneMenu(); return; }
    newPaneMenuEl.hidden = false;
    beginCompositorTransition(newPaneMenuEl);
    if (trigger) trigger.setAttribute("aria-expanded", "true");
    focusNewPaneMenuItem(0);
  }
  function handleNewPaneMenuKeydown(event) {
    if (!newPaneMenuEl || newPaneMenuEl.hidden) return false;
    var items = newPaneMenuItems();
    if (!items.length) return false;
    var index = items.indexOf(document.activeElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusNewPaneMenuItem(index < 0 ? 0 : index + 1);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusNewPaneMenuItem(index < 0 ? items.length - 1 : index - 1);
      return true;
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusNewPaneMenuItem(0);
      return true;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusNewPaneMenuItem(items.length - 1);
      return true;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      items[index < 0 ? 0 : index].click();
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (event.stopPropagation) event.stopPropagation();
      closeNewPaneMenu(true);
      return true;
    }
    if (event.key === "Tab") {
      closeNewPaneMenu();
      return false;
    }
    return false;
  }
  function onMenuClick(id, handler) {
    var el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("click", function () { closeNewPaneMenu(); handler(); });
  }

  function focusGitPaneEntry() {
    var surface = document.getElementById("git-surface");
    if (!surface || !surface.isConnected) return false;
    var entry = surface.querySelector("[data-git-tab].is-active") ||
      surface.querySelector("[data-git-tab]") ||
      surface.querySelector("#git-refresh");
    if (!entry || typeof entry.focus !== "function") return false;
    entry.focus();
    return true;
  }

  async function openGitPaneFromNewPaneMenu() {
    var thread = await openOrFocusGitPane();
    if (thread) focusGitPaneEntry();
    return thread;
  }

  onMenuClick("new-pane-term", async function () {
    var thread = await createTerminalPane();
    if (thread) toast("Terminal pane opened");
  });
  onMenuClick("new-pane-agent", async function () {
    var thread = await runNewThreadCommand();
    if (thread) toast("Coven CLI opened");
  });
  onMenuClick("new-pane-web", async function () {
    await openBlankBrowserTab();
    toast("Web pane opened");
  });
  onMenuClick("new-pane-git", openGitPaneFromNewPaneMenu);
  onMenuClick("new-pane-set", function () { beginSetPicking(); });
  onMenuClick("new-pane-project", function () { openProjectPicker(); });
  if (newPaneMenuEl) newPaneMenuEl.addEventListener("keydown", handleNewPaneMenuKeydown);

  function consumeAgentPickerKey(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function focusAgentPickerList() {
    if (
      agentPickerListEl &&
      typeof agentPickerListEl.focus === "function"
    ) {
      agentPickerListEl.focus();
    }
  }

  function handleAgentPickerListKeydown(event) {
    var count = agentLaunchOptions().length;
    if (event.key === "Tab") {
      focusAgentPickerList();
      consumeAgentPickerKey(event);
      return true;
    }
    if (event.key === "ArrowDown") {
      agentPickerIndex = nextAgentPickerIndex(agentPickerIndex, 1, count);
      renderAgentPicker();
      consumeAgentPickerKey(event);
      return true;
    }
    if (event.key === "ArrowUp") {
      agentPickerIndex = nextAgentPickerIndex(agentPickerIndex, -1, count);
      renderAgentPicker();
      consumeAgentPickerKey(event);
      return true;
    }
    if (event.key === "Home") {
      agentPickerIndex = 0;
      renderAgentPicker();
      consumeAgentPickerKey(event);
      return true;
    }
    if (event.key === "End") {
      agentPickerIndex = count ? count - 1 : 0;
      renderAgentPicker();
      consumeAgentPickerKey(event);
      return true;
    }
    if (event.key === "Enter") {
      consumeAgentPickerKey(event);
      launchSelectedAgent();
      return true;
    }
    if (event.key === "Escape") {
      consumeAgentPickerKey(event);
      closeAgentPicker();
      return true;
    }
    return false;
  }

  function routeAgentPickerModalKeydown(event) {
    if (!agentPickerOpen()) return false;
    if (dirtyFileDialogEl && dirtyFileDialogEl.open) return false;
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      String(event.key).toLowerCase() === "d"
    ) {
      consumeAgentPickerKey(event);
      openAgentPicker();
      return true;
    }
    if (handleAgentPickerListKeydown(event)) return true;
    consumeAgentPickerKey(event);
    return true;
  }

  if (agentPickerListEl) {
    agentPickerListEl.addEventListener("keydown", handleAgentPickerListKeydown);
  }
  if (agentPickerOverlayEl) {
    agentPickerOverlayEl.addEventListener("pointerdown", function (event) {
      if (event.target === agentPickerOverlayEl) closeAgentPicker();
    });
  }

  document.addEventListener("pointerdown", function (event) {
    if (newPaneMenuEl && !newPaneMenuEl.hidden &&
        !newPaneMenuEl.contains(event.target) &&
        !event.target.closest("#rail-new-tab")) {
      closeNewPaneMenu();
    }
  });

  // ---- Keyboard shortcuts overlay ----
  var HELP_ROWS = [
    ["Open the composer", "⌘F"],
    ["Toggle the sessions sidebar", "⌘B"],
    ["Focus a pane on the canvas", "⌃1–9"],
    ["Resize a pane split", "drag the divider"],
    ["New shell pane", "⌃T"],
    ["New terminal pane", "⌘T"],
    ["New agent pane (Coven CLI)", "⌃A"],
    ["Choose an agent", "⌘D"],
    ["New browser tab", "Web pane +"],
    ["Open or focus Git", "⌘G"],
    ["Close the focused file or project", "⌘W"],
    ["Rename a session", "double-click"],
    ["Cycle file tabs", "⌘[ · ⌘]"],
    ["Save the focused file", "⌘S"],
    ["Return from the Files pane", "esc"],
    ["This overlay", "?"],
  ];
  function renderHelpRows() {
    if (!helpGridEl || helpGridEl.childElementCount) return;
    HELP_ROWS.forEach(function (entry) {
      var row = document.createElement("div");
      row.className = "help-row";
      row.innerHTML =
        '<span class="help-row-what">' + escapeHtml(entry[0]) + "</span>" +
        '<span class="help-row-key">' + escapeHtml(entry[1]) + "</span>";
      helpGridEl.appendChild(row);
    });
  }
  function setHelpOpen(open) {
    if (!helpOverlayEl) return;
    if (open) renderHelpRows();
    helpOverlayEl.hidden = !open;
  }
  function toggleHelp() { setHelpOpen(helpOverlayEl ? helpOverlayEl.hidden : false); }
  onRailClick("help-toggle", toggleHelp);
  if (helpOverlayEl) {
    helpOverlayEl.addEventListener("click", function () { setHelpOpen(false); });
  }

  // `?` is only a shortcut when nothing text-like has focus.
  document.addEventListener("keydown", async function (event) {
    var tag = (event.target && event.target.tagName ? event.target.tagName : "").toLowerCase();
    var typing = tag === "input" || tag === "textarea" || tag === "select" ||
      (event.target && event.target.isContentEditable);
    // Esc cascade — one key, most-transient layer first, so it never skips
    // past something the user is looking at to undo something they aren't:
    // picker → help → menus → set picking → armed confirm → file return →
    // focus mode.
    if (event.key === "Escape") {
      if (agentPickerOpen()) { closeAgentPicker(); return; }
      if (helpOverlayEl && !helpOverlayEl.hidden) { setHelpOpen(false); return; }
      var menuWasOpen = newPaneMenuEl && !newPaneMenuEl.hidden;
      closeNewPaneMenu(menuWasOpen);
      if (menuWasOpen) return;
      if (cancelSetPicking()) return;
      if (armedSessionClose) { disarmSessionClose(); return; }
      // A call is the most transient thing on screen after a menu, and ending
      // it is always safe: nothing is transmitting.
      if (endCall()) return;
      if (routeFilesShortcut(event)) return;
      if (!typing && exitPaneMaximize()) return;
      return;
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "?") { toggleHelp(); event.preventDefault(); }
  });

  // ============================================================
  // 11b. Right-pane panels: files, diffs, git
  // ============================================================
  //
  // All three read from the active project's root via the Rust commands
  // fs_list_dir / fs_read_text / git_status / git_diff / git_log. Everything is
  // read-only — a panel can never modify an agent's working tree.

  var fileTreeEl = document.getElementById("file-tree");
  var filesCrumbEl = document.getElementById("files-crumb");
  var diffFilesEl = document.getElementById("diff-files");
  var diffRowsEl = document.getElementById("diff-rows");
  var diffMetadataEl = document.getElementById("diff-metadata");
  var diffTruncationEl = document.getElementById("diff-truncation");
  var diffsSummaryEl = document.getElementById("diffs-summary");
  /** Working-tree file count shown on the Git pane's Changes tab. */
  var gitChangesCountEl = document.getElementById("git-changes-count");
  function setGitChangesCount(count) {
    if (gitChangesCountEl) {
      gitChangesCountEl.textContent = String(count || 0);
      gitChangesCountEl.hidden = !count;
    }
  }
  var gitViewEl = document.getElementById("git-view");
  var gitBranchEl = document.getElementById("git-branch");
  var gitOpenRemoteBtn = document.getElementById("git-open-remote");
  var renderedFileRows = [];
  var fileVirtualFocusKey = "";
  var filesPanelGeneration = 0;

  function invalidateFilesPanelRender() {
    filesPanelGeneration += 1;
    return filesPanelGeneration;
  }

  function syncFilesPanelScope() {
    var generation = invalidateFilesPanelRender();
    if (sidebarView !== "files") return false;
    return renderFilesPanel({ generation: generation });
  }

  function filesPanelRequestMatches(generation, projectId, workspaceRoot) {
    var project = activeProject();
    return sidebarView === "files" &&
      generation === filesPanelGeneration &&
      !!project && project.id === projectId &&
      activeWorkspaceRoot(project) === workspaceRoot;
  }

  // Directory paths the user has expanded, so a refresh keeps the tree open.
  var expandedDirs = Object.create(null);
  var selectedDiffKey = null;
  var gitRemoteWebUrl = null;
  var diffCache = window.PsycheCodeEditor.createLruCache(6);
  var diffRequestGate = window.PsycheCodeEditor.createRequestGate();
  var diffPanelRequestGate = window.PsycheCodeEditor.createRequestGate();
  var gitPanelRequestGate = window.PsycheCodeEditor.createRequestGate();
  var gitRefreshRequestGate = window.PsycheCodeEditor.createRequestGate();

  function diffCacheKey(projectId, workspaceRoot, path, staged, context) {
    return projectId + "\0" + workspaceRoot + "\0" + path + "\0" +
      (staged ? "staged" : "unstaged") + "\0" + (context === undefined || context === null ? "default" : context);
  }

  function invalidateProjectDiffs(projectId) {
    diffCache.deleteWhere(function (key) { return key.startsWith(projectId + "\0"); });
    diffRequestGate.next();
  }

  function suspendDiffRequests() {
    diffPanelRequestGate.next();
    diffRequestGate.next();
  }

  function suspendGitRequests() {
    gitRefreshRequestGate.next();
    gitPanelRequestGate.next();
    suspendDiffRequests();
    gitRefreshFlight = null;
    setGitChangesCount(0);
  }

  function gitSurfaceRequestMatches(projectId, workspaceRoot, generation) {
    var project = activeProject();
    return gitRefreshRequestGate.isCurrent(generation) &&
      !!project && project.id === projectId &&
      activeWorkspaceRoot(project) === workspaceRoot &&
      gitPaneIsVisible(project);
  }

  function gitPanelRequestMatches(projectId, workspaceRoot, generation) {
    var project = activeProject();
    return gitPanelRequestGate.isCurrent(generation) &&
      !!project &&
      project.id === projectId &&
      activeWorkspaceRoot(project) === workspaceRoot &&
      gitPaneIsVisible(project);
  }

  function diffPanelRequestMatches(projectId, workspaceRoot, generation) {
    var project = activeProject();
    return diffPanelRequestGate.isCurrent(generation) &&
      !!project &&
      project.id === projectId &&
      activeWorkspaceRoot(project) === workspaceRoot &&
      gitPaneIsVisible(project);
  }

  function prepareGitSurfaceRefresh() {
    if (gitViewEl) panelMessage(gitViewEl, "Loading repository…");
    if (gitBranchEl) gitBranchEl.textContent = "";
    gitRemoteWebUrl = null;
    if (gitOpenRemoteBtn) gitOpenRemoteBtn.disabled = true;
    resetDiffDetail("Loading changes…");
    if (diffFilesEl) panelMessage(diffFilesEl, "Loading changes…");
    if (diffsSummaryEl) diffsSummaryEl.textContent = "loading…";
  }

  function renderGitSurfaceError(error) {
    if (gitViewEl) panelMessage(gitViewEl, String(error), "panel-error");
    if (diffFilesEl) panelMessage(diffFilesEl, String(error), "panel-error");
    clearDiffSelection("");
    if (diffsSummaryEl) diffsSummaryEl.textContent = "error";
  }

  // The tree highlights the selected tab in the mounted Files pane.
  function activeFilePath() {
    var f = findOpenFile(state.activeFileId);
    return f ? f.path : null;
  }

  function panelMessage(el, text, cls) {
    el.innerHTML = "";
    var d = document.createElement("div");
    d.className = cls || "panel-empty";
    d.textContent = text;
    el.appendChild(d);
  }

  // Drop leading path segments until it fits, keeping the basename — the part
  // that identifies the file. CSS ellipsis would eat the basename instead.
  function shortenRelPath(p, max) {
    max = max || 40;
    if (p.length <= max) return p;
    var parts = String(p).split("/");
    var out = parts[parts.length - 1];
    for (var i = parts.length - 2; i >= 0; i--) {
      var next = parts[i] + "/" + out;
      if (next.length + 2 > max) break;
      out = next;
    }
    return "…/" + out;
  }

  function relativeToRoot(root, full) {
    if (root && full.indexOf(root) === 0) {
      var rel = full.slice(root.length);
      return rel.charAt(0) === "/" ? rel.slice(1) : rel;
    }
    return full;
  }

  // ---- Files ----

  async function renderFilesPanel(options) {
    if (!fileTreeEl) return false;
    var generation = options && options.generation !== undefined
      ? options.generation
      : invalidateFilesPanelRender();
    renderedFileRows = [];
    fileVirtualFocusKey = "";
    var project = activeProject();
    if (!project) {
      if (filesCrumbEl) filesCrumbEl.textContent = "";
      panelMessage(fileTreeEl, "No project open — ⌘O to add one.");
      return false;
    }
    var workspaceRoot = activeWorkspaceRoot(project);
    if (filesCrumbEl) filesCrumbEl.textContent = shortenRoot(workspaceRoot);
    panelMessage(fileTreeEl, "Loading files…");
    var fileRows = [];
    await appendDirInto(fileRows, workspaceRoot, workspaceRoot, 0);
    if (!filesPanelRequestMatches(generation, project.id, workspaceRoot)) return false;
    renderedFileRows = fileRows;
    renderFileRows(fileRows);
    if (!fileTreeEl.firstChild) panelMessage(fileTreeEl, "Empty directory.");
    return true;
  }

  async function appendDirInto(fileRows, root, dirPath, depth) {
    var entries;
    try {
      entries = await invoke("fs_list_dir", { root: root, path: dirPath });
    } catch (err) {
      fileRows.push({ error: String(err), key: "error:" + dirPath, depth: depth });
      return;
    }
    for (var entryIndex = 0; entryIndex < entries.length; entryIndex++) {
      var entry = entries[entryIndex];
      fileRows.push({ entry: entry, key: entry.path, depth: depth });
      if (entry.is_dir && expandedDirs[entry.path]) {
        await appendDirInto(fileRows, root, entry.path, depth + 1);
      }
    }
  }

  function renderFileRows(fileRows, options) {
    if (!fileTreeEl) return;
    var preserveFocus = !options || options.preserveFocus !== false;
    var activeFileFocusKey = fileVirtualFocusKey || (preserveFocus &&
      fileTreeEl.contains(document.activeElement) &&
      document.activeElement.dataset
      ? document.activeElement.dataset.virtualKey || ""
      : "");
    var restoreFileFocusKey = options && options.restoreFocusKey;
    var focusedKey = restoreFileFocusKey || activeFileFocusKey;
    var fileActiveIndex = fileRows.findIndex(function (item) {
      return activeFileFocusKey && item.key === activeFileFocusKey;
    });
    var fileVirtualWindow = null;
    var visibleRows = fileRows;
    var fileRowHeight = collectionRowHeight(fileTreeEl, "--file-row-h", 26);
    fileTreeEl.__psycheVirtualRowHeight = fileRowHeight;
    if (ptyRuntime.shouldVirtualize(fileRows.length)) {
      fileVirtualWindow = ptyRuntime.virtualizeItems(fileRows, {
        rowHeight: fileRowHeight,
        viewportHeight: fileTreeEl.clientHeight,
        scrollTop: fileTreeEl.scrollTop,
        overscan: ptyRuntime.VIRTUAL_LIST_OVERSCAN,
        activeIndex: fileActiveIndex >= 0 ? fileActiveIndex : undefined,
        getKey: function (item) { return item.entry ? item.entry.path : item.key; },
      });
      visibleRows = fileVirtualWindow.items.map(function (item) { return item.item; });
    }
    fileTreeEl.replaceChildren();
    if (fileVirtualWindow) {
      fileTreeEl.appendChild(createVirtualListSpacer("before", fileVirtualWindow.before));
    }
    visibleRows.forEach(function (fileRow) {
      if (fileRow.error) {
        var error = document.createElement("div");
        error.className = "panel-error file-row-error";
        error.textContent = fileRow.error;
        error.dataset.virtualKey = fileRow.key;
        error.tabIndex = 0;
        fileTreeEl.appendChild(error);
        return;
      }
      var entry = fileRow.entry;
      var depth = fileRow.depth;
      var row = document.createElement("button");
      row.type = "button";
      var isOpen = !!expandedDirs[entry.path];
      row.className = "file-row" + (entry.is_dir ? " is-dir" : "") +
        (isOpen ? " open" : "") + (activeFilePath() === entry.path ? " selected" : "");
      row.style.paddingLeft = 10 + depth * 12 + "px";
      row.innerHTML =
        '<span class="twisty">' + (entry.is_dir ? "▶" : "") + "</span>" +
        '<span class="file-name">' + escapeHtml(entry.name) + "</span>";
      row.title = entry.path;
      row.dataset.virtualKey = entry.path;
      row.addEventListener("click", async function () {
        if (entry.is_dir) {
          if (expandedDirs[entry.path]) delete expandedDirs[entry.path];
          else expandedDirs[entry.path] = true;
          renderFilesPanel();
        } else {
          await openFileTab(entry.path, activeProject());
        }
      });
      fileTreeEl.appendChild(row);
    });
    if (fileVirtualWindow) {
      fileTreeEl.appendChild(createVirtualListSpacer("after", fileVirtualWindow.after));
    }
    if (focusedKey) {
      var replacement = Array.prototype.find.call(
        fileTreeEl.querySelectorAll("[data-virtual-key]"),
        function (item) { return item.dataset.virtualKey === focusedKey; }
      );
      if (replacement) replacement.focus();
    }
    fileVirtualFocusKey = "";
  }

  function focusLogicalFileRow(key) {
    if (!fileTreeEl) return false;
    var mounted = Array.prototype.find.call(
      fileTreeEl.querySelectorAll("[data-virtual-key]"),
      function (item) { return item.dataset.virtualKey === key; }
    );
    if (mounted) {
      mounted.focus();
      return true;
    }
    var index = renderedFileRows.findIndex(function (item) { return item.key === key; });
    if (index === -1) return false;
    var offset = index * (fileTreeEl.__psycheVirtualRowHeight || 26);
    fileVirtualFocusKey = key;
    fileTreeEl.scrollTop = offset;
    renderFileRows(renderedFileRows);
    return true;
  }

  function handleVirtualFileTreeKeydown(event) {
    var item = event.target && event.target.dataset && event.target.dataset.virtualKey
      ? event.target
      : null;
    if (!item || document.activeElement !== item) return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" &&
        event.key !== "Home" && event.key !== "End") return;
    var index = renderedFileRows.findIndex(function (row) {
      return row.key === item.dataset.virtualKey;
    });
    if (index === -1) return;
    var next = index;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = renderedFileRows.length - 1;
    else if (event.key === "ArrowDown") next = Math.min(renderedFileRows.length - 1, index + 1);
    else next = Math.max(0, index - 1);
    event.preventDefault();
    focusLogicalFileRow(renderedFileRows[next].key);
  }

  if (fileTreeEl) {
    fileTreeEl.addEventListener("keydown", handleVirtualFileTreeKeydown);
    fileTreeEl.addEventListener("scroll", function () {
      if (!ptyRuntime.shouldVirtualize(renderedFileRows.length)) return;
      var fileScrollFocusKey = fileTreeEl.contains(document.activeElement) &&
        document.activeElement.dataset
        ? document.activeElement.dataset.virtualKey || ""
        : "";
      terminalFrameScheduler.schedule("collection:files", function () {
        renderFileRows(renderedFileRows, {
          preserveFocus: false,
          restoreFocusKey: fileScrollFocusKey,
        });
      });
    });
  }

  onRailClick("files-back", function () {
    showSessionsSidebar();
  });
  onRailClick("files-refresh", function () { renderFilesPanel(); });

  // ---- Diffs ----

  function stagedDiffFor(entry) {
    return !!entry.staged && !entry.unstaged;
  }

  function formatDiffBytes(bytes) {
    var value = Number(bytes) || 0;
    if (value < 1024) return value + " B";
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KiB";
    return (value / (1024 * 1024)).toFixed(1) + " MiB";
  }

  function resetDiffDetail(message) {
    parsedDiffFiles = [];
    if (diffRowsEl) diffRowsEl.replaceChildren();
    if (diffMetadataEl) diffMetadataEl.textContent = message || "";
    if (diffTruncationEl) {
      diffTruncationEl.hidden = true;
      diffTruncationEl.textContent = "";
    }
  }

  function clearDiffSelection(message) {
    selectedDiffKey = null;
    diffRequestGate.next();
    resetDiffDetail(message);
    if (diffFilesEl && diffFilesEl.parentNode) {
      diffFilesEl.parentNode.classList.remove("has-detail");
    }
  }

  // Split and stacked are two renderings of one parsed model, so switching is a
  // redraw rather than a re-parse -- which is what lets the toggle keep its
  // place and stay instant on a large diff.
  var diffLayout = "split";
  var parsedDiffFiles = [];

  function diffSegmentsInto(target, segments) {
    (segments || []).forEach(function (segment) {
      var span = document.createElement("span");
      if (segment.changed) span.className = "diff-word";
      span.textContent = segment.text;
      target.appendChild(span);
    });
  }

  // Context lines the viewer last asked git for. null means git's default (3),
  // which is what every diff starts at.
  var diffContext = null;

  function diffSeparatorRow(row) {
    var separator = document.createElement("div");
    separator.className = "diff-sep";
    var mark = document.createElement("span");
    mark.className = "diff-sep-mark";
    mark.textContent = "\u22ef";
    var label = document.createElement("span");
    label.textContent = row.hidden + " unmodified line" + (row.hidden === 1 ? "" : "s");
    separator.appendChild(mark);
    separator.appendChild(label);
    var spacer = document.createElement("span");
    spacer.className = "diff-sep-spacer";
    separator.appendChild(spacer);
    var expand = document.createElement("button");
    expand.type = "button";
    expand.className = "diff-sep-expand";
    expand.textContent = "expand";
    expand.title = "Show the " + row.hidden + " hidden line" +
      (row.hidden === 1 ? "" : "s") + " around this change";
    expand.addEventListener("click", function () {
      // Ask for enough context to close the largest remaining gap, so one
      // click opens the file rather than creeping toward it.
      var widest = row.hidden;
      parsedDiffFiles.forEach(function (file) {
        PsycheDiffs.stackedRows(file).forEach(function (each) {
          if (each.type === "separator" && each.hidden > widest) widest = each.hidden;
        });
      });
      diffContext = Math.min(2000, widest + 3);
      refreshSelectedDiff();
    });
    separator.appendChild(expand);
    return separator;
  }

  function renderStackedDiff(host, rows) {
    rows.forEach(function (row) {
      if (row.type === "separator") { host.appendChild(diffSeparatorRow(row)); return; }
      var line = document.createElement("div");
      line.className = "diff-row diff-" + row.kind;
      var oldNo = document.createElement("span");
      oldNo.className = "diff-gutter";
      oldNo.textContent = row.oldNo === undefined ? "" : String(row.oldNo);
      var newNo = document.createElement("span");
      newNo.className = "diff-gutter diff-gutter-new";
      newNo.textContent = row.newNo === undefined ? "" : String(row.newNo);
      var marker = document.createElement("span");
      marker.className = "diff-marker";
      marker.textContent = row.kind === "add" ? "+" : row.kind === "delete" ? "\u2212" : "";
      var text = document.createElement("span");
      text.className = "diff-text";
      diffSegmentsInto(text, row.segments);
      line.appendChild(oldNo);
      line.appendChild(newNo);
      line.appendChild(marker);
      line.appendChild(text);
      host.appendChild(line);
    });
  }

  function renderSplitDiff(host, rows) {
    rows.forEach(function (row) {
      if (row.type === "separator") { host.appendChild(diffSeparatorRow(row)); return; }
      var line = document.createElement("div");
      line.className = "diff-row diff-split-row";
      [["left", row.left], ["right", row.right]].forEach(function (pair) {
        var side = pair[1];
        var gutter = document.createElement("span");
        gutter.className = "diff-gutter";
        var text = document.createElement("span");
        // An empty cell opposite a pure add or delete is what keeps the two
        // columns aligned; it is styled, not blank, so the gap reads as absence.
        text.className = "diff-text diff-" + (side ? side.kind : "empty");
        if (side) {
          gutter.textContent = side.no === undefined ? "" : String(side.no);
          gutter.classList.add("diff-" + side.kind);
          diffSegmentsInto(text, side.segments);
        }
        line.appendChild(gutter);
        line.appendChild(text);
      });
      host.appendChild(line);
    });
  }

  function paintDiffRows() {
    if (!diffRowsEl) return;
    diffRowsEl.replaceChildren();
    var file = parsedDiffFiles[0];
    if (!file) return;
    if (file.binary) {
      var note = document.createElement("div");
      note.className = "diff-empty";
      note.textContent = "Binary file — no textual diff";
      diffRowsEl.appendChild(note);
      return;
    }
    var rows = diffLayout === "stacked"
      ? PsycheDiffs.stackedRows(file)
      : PsycheDiffs.splitRows(file);
    diffRowsEl.dataset.layout = diffLayout;
    if (diffLayout === "stacked") renderStackedDiff(diffRowsEl, rows);
    else renderSplitDiff(diffRowsEl, rows);
  }

  function setDiffLayout(name) {
    diffLayout = name === "stacked" ? "stacked" : "split";
    [["diff-view-split", "split"], ["diff-view-stacked", "stacked"]].forEach(function (pair) {
      var btn = document.getElementById(pair[0]);
      if (!btn) return;
      var active = pair[1] === diffLayout;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
    paintDiffRows();
    return diffLayout;
  }

  [["diff-view-split", "split"], ["diff-view-stacked", "stacked"]].forEach(function (pair) {
    var btn = document.getElementById(pair[0]);
    if (btn) btn.addEventListener("click", function () { setDiffLayout(pair[1]); });
  });

  function renderDiffResult(result) {
    var text = result && typeof result.text === "string" ? result.text : "";
    var lines = Number(result && result.lines) || 0;
    var bytes = Number(result && result.bytes) || 0;
    parsedDiffFiles = PsycheDiffs.parseUnifiedDiff(text);
    paintDiffRows();
    if (diffMetadataEl) {
      var stat = PsycheDiffs.diffStat(parsedDiffFiles);
      diffMetadataEl.textContent = text.trim()
        ? "+" + stat.additions + " \u2212" + stat.deletions + " · " + lines + " lines · " + formatDiffBytes(bytes)
        : "No textual diff · " + lines + " lines · " + formatDiffBytes(bytes);
    }
    if (diffTruncationEl) {
      diffTruncationEl.hidden = !(result && result.truncated);
      diffTruncationEl.textContent = result && result.truncated
        ? "Capped preview — full diff is " + lines + " lines / " + formatDiffBytes(bytes)
        : "";
    }
  }

  function currentDiffRequestMatches(projectId, workspaceRoot, key, generation) {
    var project = activeProject();
    return diffRequestGate.isCurrent(generation) &&
      selectedDiffKey === key &&
      !!project && project.id === projectId &&
      activeWorkspaceRoot(project) === workspaceRoot &&
      gitPaneIsVisible(project);
  }

  function renderDiffsPanel(project, workspaceRoot, status, panelGeneration, refreshGeneration) {
    if (!diffFilesEl) return;
    var projectId = project.id;
    if (!gitSurfaceRequestMatches(projectId, workspaceRoot, refreshGeneration) ||
        !diffPanelRequestMatches(projectId, workspaceRoot, panelGeneration)) return;
    if (!status.is_repo) {
      panelMessage(diffFilesEl, "Not a git repository.");
      clearDiffSelection("");
      if (diffsSummaryEl) diffsSummaryEl.textContent = "not a repository";
      return;
    }
    if (diffsSummaryEl) {
      diffsSummaryEl.textContent = status.files.length
        ? status.files.length + " changed"
        : "clean";
    }
    if (status.files.length === 0) {
      panelMessage(diffFilesEl, "No uncommitted changes.");
      clearDiffSelection("");
      return;
    }

    diffFilesEl.innerHTML = "";
    status.files.forEach(function (f) {
      var row = document.createElement("button");
      row.type = "button";
      var kind = f.untracked ? "untracked" : f.staged ? "staged" : "unstaged";
      var key = diffCacheKey(projectId, workspaceRoot, f.path, stagedDiffFor(f), diffContext);
      row.className = "diff-row " + kind + (selectedDiffKey === key ? " selected" : "");
      row.title = f.path;
      row.innerHTML =
        '<span class="diff-code">' + escapeHtml(f.code) + "</span>" +
        '<span class="diff-path">' + escapeHtml(shortenRelPath(f.path)) + "</span>";
      row.addEventListener("click", function () {
        showDiff(project, f, { workspaceRoot: workspaceRoot });
      });
      diffFilesEl.appendChild(row);
    });

    // Auto-open the first file so the panel is never a blank list.
    var target = status.files.find(function (f) {
      return diffCacheKey(projectId, workspaceRoot, f.path, stagedDiffFor(f), diffContext) === selectedDiffKey;
    }) || status.files[0];
    showDiff(project, target, { workspaceRoot: workspaceRoot });
  }

  var shownDiffTarget = null;

  /** Re-fetch whatever is on screen, at the current context width. */
  function refreshSelectedDiff() {
    if (!shownDiffTarget) return;
    showDiff(shownDiffTarget.project, shownDiffTarget.entry, {
      keepContext: true,
      workspaceRoot: shownDiffTarget.workspaceRoot,
    });
  }

  async function showDiff(project, entry, options) {
    if (!project || !entry || !diffRowsEl) return;
    var workspaceRoot = options && options.workspaceRoot
      ? options.workspaceRoot
      : activeWorkspaceRoot(project);
    var currentProject = activeProject();
    if (!currentProject || currentProject.id !== project.id ||
        activeWorkspaceRoot(currentProject) !== workspaceRoot ||
        !gitPaneIsVisible(project)) return;
    // A new file starts narrow again: an expansion belongs to the view you
    // expanded, not to the panel.
    if (!(options && options.keepContext)) diffContext = null;
    shownDiffTarget = {
      project: project,
      entry: entry,
      workspaceRoot: workspaceRoot,
    };
    var staged = stagedDiffFor(entry);
    var key = diffCacheKey(project.id, workspaceRoot, entry.path, staged, diffContext);
    var generation = diffRequestGate.next();
    selectedDiffKey = key;
    diffFilesEl.parentNode.classList.add("has-detail");
    Array.prototype.forEach.call(diffFilesEl.children, function (el) {
      el.classList.toggle("selected", el.title === entry.path);
    });
    var cached = diffCache.get(key);
    if (cached !== undefined) {
      if (!currentDiffRequestMatches(project.id, workspaceRoot, key, generation)) return;
      renderDiffResult(cached);
      return;
    }
    resetDiffDetail("Loading diff…");
    try {
      var result = await invoke("git_diff", {
        root: workspaceRoot,
        path: entry.path,
        staged: staged,
        context: diffContext,
      });
      if (!currentDiffRequestMatches(project.id, workspaceRoot, key, generation)) return;
      diffCache.set(key, result);
      renderDiffResult(result);
    } catch (err) {
      if (!currentDiffRequestMatches(project.id, workspaceRoot, key, generation)) return;
      resetDiffDetail("Unable to load diff: " + String(err));
    }
  }

  function refreshDiffs() {
    var project = activeProject();
    if (project) invalidateProjectDiffs(project.id);
    renderGitSurface({ force: true });
  }

  onRailClick("diffs-refresh", refreshDiffs);

  // ---- Git / GitHub ----

  async function renderGitPanel(project, workspaceRoot, status, panelGeneration, refreshGeneration) {
    if (!gitViewEl) return;
    var projectId = project.id;
    if (!gitSurfaceRequestMatches(projectId, workspaceRoot, refreshGeneration) ||
        !gitPanelRequestMatches(projectId, workspaceRoot, panelGeneration)) return;
    var commits;
    try {
      commits = status.is_repo ? await invoke("git_log", { root: workspaceRoot, limit: 30 }) : [];
    } catch (err) {
      if (!gitSurfaceRequestMatches(projectId, workspaceRoot, refreshGeneration) ||
          !gitPanelRequestMatches(projectId, workspaceRoot, panelGeneration)) return;
      panelMessage(gitViewEl, String(err), "panel-error");
      return;
    }
    if (!gitSurfaceRequestMatches(projectId, workspaceRoot, refreshGeneration) ||
        !gitPanelRequestMatches(projectId, workspaceRoot, panelGeneration)) return;
    if (!status.is_repo) { panelMessage(gitViewEl, "Not a git repository."); return; }

    gitViewEl.innerHTML = "";
    gitRemoteWebUrl = status.web_url || null;
    if (gitOpenRemoteBtn) gitOpenRemoteBtn.disabled = !gitRemoteWebUrl;
    if (gitBranchEl) gitBranchEl.textContent = status.branch || "(detached)";
    var head = document.createElement("div");
    head.className = "git-branch-line";
    var track = "";
    if (status.upstream) {
      track = escapeHtml(status.upstream);
      if (status.ahead) track += ' <span class="ahead">↑' + status.ahead + "</span>";
      if (status.behind) track += ' <span class="behind">↓' + status.behind + "</span>";
    } else {
      track = "no upstream";
    }
    head.innerHTML =
      '<span class="git-branch-name">' + escapeHtml(status.branch || "(detached)") + "</span>" +
      '<span class="git-track">' + track + "</span>";
    gitViewEl.appendChild(head);

    var changed = document.createElement("div");
    changed.className = "git-section-head";
    changed.textContent = "Working tree — " +
      (status.files.length ? status.files.length + " changed" : "clean");
    gitViewEl.appendChild(changed);
    status.files.slice(0, 40).forEach(function (f) {
      var row = document.createElement("div");
      row.className = "diff-row " + (f.untracked ? "untracked" : f.staged ? "staged" : "unstaged");
      row.title = f.path;
      row.innerHTML =
        '<span class="diff-code">' + escapeHtml(f.code) + "</span>" +
        '<span class="diff-path">' + escapeHtml(shortenRelPath(f.path)) + "</span>";
      gitViewEl.appendChild(row);
    });

    var commitsHead = document.createElement("div");
    commitsHead.className = "git-section-head";
    commitsHead.textContent = "Recent commits";
    gitViewEl.appendChild(commitsHead);
    if (commits.length === 0) {
      var none = document.createElement("div");
      none.className = "panel-empty";
      none.textContent = "No commits yet.";
      gitViewEl.appendChild(none);
    }
    commits.forEach(function (c) {
      var row = document.createElement("div");
      row.className = "git-commit";
      row.title = c.subject + "\n" + c.author + " — " + c.relative;
      row.innerHTML =
        '<span class="sha">' + escapeHtml(c.short) + "</span>" +
        '<span class="subject">' + escapeHtml(c.subject) + "</span>" +
        '<span class="when">' + escapeHtml(c.relative) + "</span>";
      // Clicking a commit opens it on the remote host when there is one.
      if (gitRemoteWebUrl) {
        row.addEventListener("click", function () {
          if (openUrl) openUrl(gitRemoteWebUrl + "/commit/" + c.hash).catch(function () {});
        });
      }
      gitViewEl.appendChild(row);
    });
  }

  onRailClick("git-refresh", function () { renderGitSurface({ force: true }); });
  onRailClick("git-open-remote", function () {
    if (gitRemoteWebUrl && openUrl) openUrl(gitRemoteWebUrl).catch(function () {});
  });

  async function switchTab(delta) {
    var files = projectFiles();
    if (filesPaneHasCanvasFocus() && files.length) {
      var fi = files.findIndex(function (f) { return f.id === state.activeFileId; });
      if (fi === -1) fi = 0;
      await activateFileTab(files[(fi + delta + files.length) % files.length].id);
      return;
    }
    if (state.projects.length === 0) return;
    var idx = state.projects.findIndex(function (p) { return p.id === state.activeProjectId; });
    if (idx === -1) idx = 0;
    var next = (idx + delta + state.projects.length) % state.projects.length;
    await setActiveProject(state.projects[next].id);
  }

  // ============================================================
  // 12. Boot
  // ============================================================

  async function canonicalProjectPath(rootPath) {
    try {
      return await invoke("canonical_project_path", { root: rootPath });
    } catch (error) {
      setStatus("Project path is unavailable: " + String(error), "error");
      return null;
    }
  }

  function migrateProjectRoot(project, previousRoot, canonicalRoot) {
    function remapPath(path) {
      if (path === previousRoot) return canonicalRoot;
      if (path && path.indexOf(previousRoot + "/") === 0) {
        return canonicalRoot + path.slice(previousRoot.length);
      }
      return path;
    }
    function mergeBrowser(target, incoming, preferIncoming) {
      var tabs = (target.tabs || []).slice();
      var indices = {};
      tabs.forEach(function (tab, index) { indices[tab.id] = index; });
      (incoming.tabs || []).forEach(function (tab) {
        if (indices[tab.id] === undefined) {
          indices[tab.id] = tabs.length;
          tabs.push(tab);
        } else if (preferIncoming) {
          tabs[indices[tab.id]] = tab;
        }
      });
      target.tabs = tabs;
      if (preferIncoming && incoming.activeTabId) target.activeTabId = incoming.activeTabId;
      else if (!target.activeTabId) target.activeTabId = incoming.activeTabId;
      return target;
    }
    var previousSelectedWorktreePath = project.selectedWorktreePath;
    var selectedWorktreePath = remapPath(project.selectedWorktreePath);
    project.root = canonicalRoot;
    project.worktrees = (project.worktrees || []).map(function (worktree) {
      if (!worktree) return worktree;
      return Object.assign({}, worktree, { path: remapPath(worktree.path) });
    });
    var browsers = project.browsersByWorktree || {};
    var migratedBrowsers = {};
    Object.keys(browsers).forEach(function (workspaceRoot) {
      var migratedRoot = remapPath(workspaceRoot);
      var browser = browsers[workspaceRoot];
      if (!migratedBrowsers[migratedRoot]) migratedBrowsers[migratedRoot] = browser;
      else mergeBrowser(
        migratedBrowsers[migratedRoot],
        browser,
        workspaceRoot === previousSelectedWorktreePath
      );
    });
    project.browsersByWorktree = migratedBrowsers;
    assignSelectedWorktreePath(project, selectedWorktreePath);
    return project;
  }

  function mergeRestoredProject(target, incoming, preferIncoming) {
    function mergeBrowser(targetBrowser, incomingBrowser) {
      var tabs = (targetBrowser.tabs || []).slice();
      var tabIndices = {};
      tabs.forEach(function (tab, index) { tabIndices[tab.id] = index; });
      (incomingBrowser.tabs || []).forEach(function (tab) {
        if (tabIndices[tab.id] === undefined) {
          tabIndices[tab.id] = tabs.length;
          tabs.push(tab);
        } else if (preferIncoming) {
          tabs[tabIndices[tab.id]] = tab;
        }
      });
      targetBrowser.tabs = tabs;
      if (preferIncoming && incomingBrowser.activeTabId) {
        targetBrowser.activeTabId = incomingBrowser.activeTabId;
      } else if (!targetBrowser.activeTabId) {
        targetBrowser.activeTabId = incomingBrowser.activeTabId;
      }
      return targetBrowser;
    }
    var targetBrowsers = target.browsersByWorktree || {};
    var incomingBrowsers = incoming.browsersByWorktree || {};
    Object.keys(incomingBrowsers).forEach(function (workspaceRoot) {
      if (!targetBrowsers[workspaceRoot]) targetBrowsers[workspaceRoot] = incomingBrowsers[workspaceRoot];
      else if (targetBrowsers[workspaceRoot] !== incomingBrowsers[workspaceRoot]) {
        mergeBrowser(targetBrowsers[workspaceRoot], incomingBrowsers[workspaceRoot]);
      }
    });
    target.browsersByWorktree = targetBrowsers;

    var worktreesByPath = {};
    target.worktrees = target.worktrees || [];
    target.worktrees.forEach(function (worktree, index) {
      if (worktree && worktree.path) worktreesByPath[worktree.path] = index;
    });
    (incoming.worktrees || []).forEach(function (worktree) {
      if (!worktree || !worktree.path) return;
      var existingIndex = worktreesByPath[worktree.path];
      if (existingIndex === undefined) {
        worktreesByPath[worktree.path] = target.worktrees.length;
        target.worktrees.push(worktree);
      } else if (preferIncoming) {
        target.worktrees[existingIndex] = worktree;
      }
    });
    if (preferIncoming) {
      target.collapsed = incoming.collapsed;
      assignSelectedWorktreePath(target, incoming.selectedWorktreePath);
      target.name = incoming.name;
    }
    return target;
  }

  async function restoreSavedProjects(savedProjects, savedActiveProjectId, limit) {
    var normalized = await Promise.all(savedProjects.map(async function (savedProject) {
      var project = sanitizeSavedProject(savedProject);
      if (!project) return null;
      var previousRoot = project.root;
      var canonicalRoot = await canonicalProjectPath(previousRoot);
      if (!canonicalRoot) return null;
      project = migrateProjectRoot(project, previousRoot, canonicalRoot);
      return {
        project: project,
        sourceId: savedProject.id || project.id,
      };
    }));
    var projects = [];
    var projectsByRoot = {};
    var usedIds = {};
    var activeProjectId = null;
    var activeSourceClaimed = false;
    normalized.filter(Boolean).forEach(function (entry) {
      var isActiveSource = !activeSourceClaimed && entry.sourceId === savedActiveProjectId;
      if (isActiveSource) activeSourceClaimed = true;
      var existing = projectsByRoot[entry.project.root];
      if (existing) {
        mergeRestoredProject(existing, entry.project, isActiveSource);
        if (isActiveSource) activeProjectId = existing.id;
        return;
      }
      while (usedIds[entry.project.id]) entry.project.id = makeProjectId();
      usedIds[entry.project.id] = true;
      projectsByRoot[entry.project.root] = entry.project;
      projects.push(entry.project);
      if (isActiveSource) activeProjectId = entry.project.id;
    });
    projects = projects.slice(0, limit);
    if (!projects.some(function (candidate) { return candidate.id === activeProjectId; })) {
      activeProjectId = projects[0] ? projects[0].id : null;
    }
    return { projects: projects, activeProjectId: activeProjectId };
  }

  function restoredSessionLaunch(descriptor, project) {
    var launchKind = descriptor.launchKind;
    var launch = {
      command: null,
      args: [],
      env: {},
      projectRoot: project.root,
      cwd: descriptor.worktreePath,
      launchKind: launchKind,
    };
    if (launchKind === "coven-attach") {
      launch.covenSessionId = descriptor.covenSessionId || null;
      launch.metricsProvider = launch.covenSessionId ? "coven" : null;
      launch.recoveryRequired = descriptor.recoveryRequired === true;
    } else {
      launch.metricsProvider = null;
    }
    return launch;
  }

  function restoredSessionThread(descriptor, project) {
    var launch = restoredSessionLaunch(descriptor, project);
    var isCovenRecovery = launch.launchKind === "coven-recovery" ||
      launch.recoveryRequired === true;
    return {
      id: descriptor.id,
      projectId: project.id,
      worktreePath: descriptor.worktreePath,
      name: descriptor.name || descriptor.launchKind,
      kind: descriptor.kind || descriptor.launchKind,
      launch: launch,
      hidden: descriptor.hidden === true,
      status: isCovenRecovery ? "failed" : descriptor.status,
      persistentLive: descriptor.persistentLive === true,
      spawning: isCovenRecovery ? false : descriptor.persistentLive === true,
      term: null,
      fit: null,
      host: null,
      pane: null,
      closing: false,
      closeStarted: false,
      startInFlight: false,
      exitDuringStart: false,
      stopRequested: false,
      ptyStarted: false,
      ptyGeneration: null,
      ptyLifecycleToken: 0,
      terminalController: null,
      ptyIoQueue: createThreadPtyIoQueue(),
      metricsGeneration: 0,
      metrics: launch.metricsProvider ? loadingPaneMetrics(launch) : null,
      metricsRefreshTimer: 0,
      lastOutputAt: 0,
      isWorking: false,
      sidebarStatusKey: isCovenRecovery ? "error" : descriptor.persistentLive ? "busy" : "done",
      startedAt: Date.now(),
      finishedAt: isCovenRecovery || !descriptor.persistentLive ? Date.now() : null,
      exitCode: null,
    };
  }

  function restorePersistedPaneLayouts(savedLayouts, restoredIds) {
    paneLayouts.clear();
    (savedLayouts || []).forEach(function (record) {
      if (!record || !record.root) return;
      var project = findProject(record.projectId);
      if (!project) return;
      var threadIds = PsychePanes.leafIds(record.root).map(function (leafId) {
        var leaf = PsychePanes.findLeafById(record.root, leafId);
        return leaf && leaf.threadId;
      }).filter(Boolean);
      if (!threadIds.length || threadIds.some(function (id) { return !restoredIds.has(id); })) return;
      reservePaneTreeIds(record.root);
      paneLayouts.set(paneLayoutKey(project.id, record.worktreePath), {
        root: record.root,
        focusedLeafId: record.focusedLeafId || null,
      });
    });
  }

  function restorePersistedFilesPanes(savedPanes) {
    filesPanes.clear();
    (savedPanes || []).forEach(function (record) {
      if (!record) return;
      var project = findProject(record.projectId);
      if (!project) return;
      var key = filesPaneKey(project.id, record.workspaceRoot);
      if (filesPanes.has(key)) return;
      reservePaneId(record.id);
      filesPanes.set(key, {
        id: record.id,
        kind: "files",
        projectId: project.id,
        workspaceRoot: record.workspaceRoot,
        activeFileId: null,
        previousFocusedSessionId: null,
        hidden: record.hidden === true,
        pane: null,
        host: null,
      });
    });
  }

  function ensureRestoredSessionPlacements(threads) {
    threads.forEach(function (thread) {
      if (thread.hidden) return;
      var layout = paneLayoutFor(thread.projectId, thread.worktreePath);
      if (layout && PsychePanes.findLeafByThreadId(layout.root, thread.id)) return;
      var placement = preparePanePlacement(thread.id, thread.projectId, thread.worktreePath);
      if (placement) commitPanePlacement(placement);
      else thread.hidden = true;
    });
  }

  async function restorePersistedSessions(saved, liveSessionIds) {
    if (!saved || !window.PsycheWorkspace) return { sessions: [], unknownLiveIds: [] };
    var reconciled = PsycheWorkspace.reconcileSessions(saved.sessions || [], liveSessionIds || []);
    var restored = reconciled.sessions.map(function (descriptor) {
      var project = findProject(descriptor.projectId);
      return project ? restoredSessionThread(descriptor, project) : null;
    }).filter(Boolean);
    state.threads = restored;
    var restoredIds = new Set(restored.map(function (thread) { return thread.id; }));
    restorePersistedFilesPanes(saved.filesPanes);
    filesPanes.forEach(function (pane) {
      if (pane && !pane.hidden) restoredIds.add(pane.id);
    });
    restorePersistedPaneLayouts(saved.paneLayouts, restoredIds);
    ensureRestoredSessionPlacements(restored);
    restored.forEach(function (thread) { mountTerminal(thread); });
    for (var i = 0; i < restored.length; i += 1) {
      var thread = restored[i];
      if (!thread.ptyStarted && thread.status === "running") {
        try {
          var capture = await invoke("native_session_capture", { id: thread.id });
          if (thread.term && capture && capture.length) thread.term.write(new Uint8Array(capture));
        } catch (error) {
          console.warn("[native_session_capture] failed for " + thread.id + ": " + String(error));
        }
        attachThreadClientAndResolveRecovery(thread);
      }
    }
    var active = saved.activeThreadId && findThread(saved.activeThreadId);
    state.activeThreadId = active && !active.hidden ? active.id : null;
    state.projects.forEach(function (project) {
      var projectThread = state.threads.find(function (thread) {
        return thread.projectId === project.id && !thread.hidden;
      });
      project.lastActiveThreadId = projectThread ? projectThread.id : null;
    });
    return reconciled;
  }

  async function addProject(rootPath, options) {
    if (!rootPath) return null;
    if (!(options && options.nativeAuthorityReady === true)) {
      rootPath = await canonicalProjectPath(rootPath);
      if (!rootPath) return null;
    }
    if (options) options.canonicalRoot = rootPath;
    function blockedByNativeProjectRevocation() {
      if (closingNativeProjectRoots.has(rootPath)) {
        if (options) options.blockedByClosing = true;
        setStatus(
          "project is still closing for " + rootPath +
            "; retry after native authority revocation completes",
          "error"
        );
        return true;
      }
      if (pendingNativeProjectRevocations.has(rootPath)) {
        if (options) options.blockedByClosing = true;
        setStatus(
          "project authority cleanup is still pending for " + rootPath +
            "; retry after background cleanup completes",
          "error"
        );
        return true;
      }
      return false;
    }
    if (blockedByNativeProjectRevocation()) return null;
    var existing = state.projects.find(function (p) { return p.root === rootPath; });
    if (existing) {
      if (options && options.nativeAuthorityReady === true) {
        existing.nativeAuthorityReady = true;
      }
      return (await setActiveProject(existing.id)) ? existing : null;
    }
    if (state.projects.length >= settings.maxProjects) { setStatus("project limit reached (" + settings.maxProjects + "/" + HARD_MAX_PROJECTS + ")", "warn"); return null; }
    if (!(await showTerminalView())) return null;
    if (blockedByNativeProjectRevocation()) return null;
    existing = state.projects.find(function (p) { return p.root === rootPath; });
    if (existing) {
      if (options && options.nativeAuthorityReady === true) {
        existing.nativeAuthorityReady = true;
      }
      return (await setActiveProject(existing.id)) ? existing : null;
    }
    if (state.projects.length >= settings.maxProjects) {
      setStatus(
        "project limit reached (" + settings.maxProjects + "/" + HARD_MAX_PROJECTS + ")",
        "warn"
      );
      return null;
    }
    var parts = rootPath.split("/");
    var name = parts[parts.length - 1] || rootPath;
    var project = { id: makeProjectId(), name: name, root: rootPath, collapsed: false, selectedWorktreePath: rootPath, worktrees: [], browsersByWorktree: {}, nativeAuthorityReady: !!(options && options.nativeAuthorityReady === true) };
    state.projects.push(project);
    if (typeof assignActiveProjectId === "function") assignActiveProjectId(project.id);
    else Object.assign(state, { activeProjectId: project.id });
    state.activeThreadId = null;
    renderPaneWorkspace();
    refreshSidebar();
    await refreshProjectWorktrees(project);
    syncProjectBrowser();
    saveWorkspaceSoon();
    startCovenPolling();
    installAgentControlUi();
    if (typeof refreshStatusController === "function") refreshStatusController();
    return project;
  }

  async function openProjectPicker() {
    var selected = null;
    var admission = {
      nativeAuthorityReady: true,
      blockedByClosing: false,
    };
    try {
      var defaultPath = (state.env && state.env.home) || undefined;
      selected = await invoke("native_project_open", {
        defaultPath: defaultPath,
      });
      if (!selected || typeof selected !== "string") return; // user cancelled
      await addProject(selected, admission);
    } catch (err) {
      writeToActive("\r\n\x1b[31m[open-project]\x1b[0m " + err + "\r\n");
    } finally {
      var cleanupRoot = admission.canonicalRoot || selected;
      if (
        selected &&
        typeof selected === "string" &&
        !admission.blockedByClosing &&
        !closingNativeProjectRoots.has(cleanupRoot) &&
        !state.projects.some(function (project) {
          return project.root === cleanupRoot;
        })
      ) {
        try {
          await invoke("native_project_close", { root: cleanupRoot });
        } catch (cleanupError) {
          quarantineNativeProjectRevocation(
            { root: cleanupRoot, name: cleanupRoot },
            cleanupError
          );
          writeToActive(
            "\r\n\x1b[31m[open-project cleanup]\x1b[0m failed to revoke native project authority: " +
              cleanupError + "\r\n"
          );
        }
      }
    }
  }

  function agentLaunchOptions() {
    return [
      {
        id: "coven-code",
        label: "Coven CLI",
        command: "coven",
        args: [],
        kind: "coven-code",
        harness: null,
      },
      {
        id: "copilot",
        label: "Copilot CLI",
        command: "coven",
        args: ["run", "copilot"],
        kind: "agent-copilot",
        harness: "copilot",
      },
      {
        id: "codex",
        label: "Codex CLI",
        command: "coven",
        args: ["run", "codex"],
        kind: "agent-codex",
        harness: "codex",
      },
      {
        id: "anthropic",
        label: "Anthropic CLI",
        command: "coven",
        args: ["run", "claude"],
        kind: "agent-anthropic",
        harness: "claude",
      },
      {
        id: "grok-build",
        label: "Grok Build",
        command: "coven",
        args: ["run", "grok"],
        kind: "agent-grok-build",
        harness: "grok",
      },
    ];
  }

  function normalizeCovenLaunchCapabilities(payload) {
    if (!payload || typeof payload !== "object") return null;
    var status = typeof payload.status === "string" ? payload.status : null;
    if (!status) return null;
    var adapters = [];
    if (Array.isArray(payload.adapters)) {
      payload.adapters.forEach(function (adapter) {
        if (!adapter || typeof adapter.id !== "string" || !adapter.id) return;
        adapters.push({
          id: adapter.id,
          label:
            typeof adapter.label === "string" && adapter.label
              ? adapter.label
              : adapter.id,
          available: adapter.available === true,
        });
      });
    }
    return {
      status: status,
      apiVersion: typeof payload.apiVersion === "string" ? payload.apiVersion : null,
      adapters: adapters,
      message: typeof payload.message === "string" ? payload.message : null,
    };
  }

  function covenLaunchCapabilitiesCache() {
    return covenLaunchCapabilitiesSnapshot;
  }

  async function refreshCovenLaunchCapabilities(force) {
    var now = Date.now();
    if (
      !force &&
      covenLaunchCapabilitiesSnapshot &&
      now - covenLaunchCapabilitiesFetchedAt < COVEN_LAUNCH_CAPABILITIES_TTL_MS
    ) {
      return covenLaunchCapabilitiesSnapshot;
    }
    if (covenLaunchCapabilitiesFlight) return covenLaunchCapabilitiesFlight;
    var covenPath = state.env && state.env.coven_path;
    if (!covenPath) {
      covenLaunchCapabilitiesSnapshot = {
        status: "unavailable",
        apiVersion: null,
        adapters: [],
        message: "Coven CLI not found — install @opencoven/cli and restart Psyche",
      };
      covenLaunchCapabilitiesFetchedAt = now;
      return covenLaunchCapabilitiesSnapshot;
    }
    var flight = invoke("coven_launch_capabilities", { covenPath: covenPath })
      .then(function (payload) {
        var normalized =
          normalizeCovenLaunchCapabilities(payload) || {
            status: "error",
            apiVersion: null,
            adapters: [],
            message: "Coven capabilities could not be loaded",
          };
        if (normalized.apiVersion && normalized.apiVersion !== COVEN_LAUNCH_API_VERSION) {
          normalized = {
            status: "incompatible",
            apiVersion: normalized.apiVersion,
            adapters: [],
            message: "Coven daemon API update required",
          };
        }
        covenLaunchCapabilitiesSnapshot = normalized;
        covenLaunchCapabilitiesFetchedAt = Date.now();
        return covenLaunchCapabilitiesSnapshot;
      })
      .catch(function (error) {
        covenLaunchCapabilitiesSnapshot = {
          status: "error",
          apiVersion: null,
          adapters: [],
          message: "Coven capabilities could not be loaded: " + String(error),
        };
        covenLaunchCapabilitiesFetchedAt = Date.now();
        return covenLaunchCapabilitiesSnapshot;
      })
      .finally(function () {
        if (covenLaunchCapabilitiesFlight === flight) covenLaunchCapabilitiesFlight = null;
      });
    covenLaunchCapabilitiesFlight = flight;
    return flight;
  }

  function covenCapabilityFor(harnessId, snapshot) {
    if (!harnessId) return null;
    var resolved = snapshot || covenLaunchCapabilitiesSnapshot;
    if (!resolved || !Array.isArray(resolved.adapters)) return null;
    var capability = resolved.adapters.find(function (adapter) {
      return adapter.id === harnessId;
    });
    return capability || null;
  }

  // Returns null when the entry may launch, or an actionable reason string.
  // The gate reads only capabilities confirmed by the selected Coven
  // executable/profile, so unconfirmed harnesses stay explicitly unavailable
  // before prompt submission.
  function covenLaunchGate(entry, snapshot) {
    if (!entry) return "Unknown agent";
    if (entry.id === "coven-code") {
      return state.env && state.env.coven_path
        ? null
        : "Coven CLI not found — install @opencoven/cli and restart Psyche";
    }
    if (!entry.harness) return "Unknown Coven harness";
    var resolved = snapshot || covenLaunchCapabilitiesSnapshot;
    if (!resolved) return "Checking Coven capabilities — retry in a moment";
    if (resolved.status === "unavailable" || resolved.status === "incompatible") {
      return resolved.message || "Coven daemon is not available";
    }
    if (resolved.status !== "ready") {
      return resolved.message || "Coven capabilities could not be loaded";
    }
    var capability = covenCapabilityFor(entry.harness, resolved);
    if (!capability) {
      return entry.label + " is not offered by this Coven executable";
    }
    if (!capability.available) {
      return (
        entry.label +
        " is unavailable in Coven — run `coven adapter doctor " +
        entry.harness +
        "`"
      );
    }
    return null;
  }

  function covenLaunchOutcome(launchResult) {
    if (launchResult && launchResult.status === "accepted" && launchResult.sessionId) {
      return "accepted";
    }
    if (
      launchResult &&
      (launchResult.status === "unavailable" ||
        launchResult.status === "incompatible" ||
        launchResult.status === "effect_unknown")
    ) {
      return "recovery_required";
    }
    return "failed";
  }

  function covenLaunchFailureStatus(entry, launchResult) {
    var message =
      launchResult && typeof launchResult.message === "string"
        ? launchResult.message
        : null;
    if (covenLaunchOutcome(launchResult) === "recovery_required") {
      return message || "Coven daemon is not available — run `coven daemon start`";
    }
    return entry.label + " launch failed" + (message ? ": " + message : "");
  }

  // Persist only a bounded prompt reference (a short digest) next to the
  // canonical Coven session identity; the raw prompt never enters the launch
  // model.
  async function covenPromptDigest(prompt) {
    if (!prompt) return null;
    try {
      var subtle = globalThis.crypto && globalThis.crypto.subtle;
      if (!subtle) return null;
      var bytes = new TextEncoder().encode(prompt);
      var digest = await subtle.digest("SHA-256", bytes);
      var hex = Array.prototype.map
        .call(new Uint8Array(digest), function (byte) {
          return byte.toString(16).padStart(2, "0");
        })
        .join("");
      return "sha256:" + hex.slice(0, 16);
    } catch (_) {
      return null;
    }
  }

  function nextAgentPickerIndex(current, delta, count) {
    if (!count) return 0;
    return (((current + delta) % count) + count) % count;
  }

  function agentPickerOpen() {
    return Boolean(agentPickerOverlayEl && !agentPickerOverlayEl.hidden);
  }

  function renderAgentPicker() {
    if (!agentPickerListEl) return;
    var entries = agentLaunchOptions();
    agentPickerIndex = nextAgentPickerIndex(agentPickerIndex, 0, entries.length);
    agentPickerListEl.innerHTML = "";
    entries.forEach(function (entry, index) {
      var selected = index === agentPickerIndex;
      var gate = covenLaunchGate(entry);
      var option = document.createElement("button");
      option.type = "button";
      option.id = "agent-picker-option-" + entry.id;
      option.className =
        "agent-picker-option" +
        (selected ? " is-selected" : "") +
        (gate ? " is-unavailable" : "");
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", selected ? "true" : "false");
      if (gate) option.setAttribute("aria-disabled", "true");
      option.tabIndex = -1;
      option.innerHTML =
        '<span class="agent-picker-label">' + escapeHtml(entry.label) + "</span>" +
        (gate
          ? '<span class="agent-picker-option-unavailable">' + escapeHtml(gate) + "</span>"
          : '<span class="agent-picker-option-command">' +
            escapeHtml([entry.command].concat(entry.args || []).join(" ")) +
            "</span>");
      option.addEventListener("pointermove", function () {
        if (agentPickerIndex === index) return;
        agentPickerIndex = index;
        renderAgentPicker();
      });
      option.addEventListener("click", function () {
        var reason = covenLaunchGate(entry);
        if (reason) {
          setStatus(reason, "warn");
          return;
        }
        agentPickerIndex = index;
        launchSelectedAgent();
      });
      agentPickerListEl.appendChild(option);
    });
    if (entries[agentPickerIndex]) {
      agentPickerListEl.setAttribute(
        "aria-activedescendant",
        "agent-picker-option-" + entries[agentPickerIndex].id
      );
    } else {
      agentPickerListEl.removeAttribute("aria-activedescendant");
    }
  }

  function openAgentPicker() {
    if (!agentPickerOverlayEl || !agentPickerListEl) return false;
    if (dirtyFileDialogEl && dirtyFileDialogEl.open) return false;
    if (!agentPickerOpen()) agentPickerPreviousFocus = document.activeElement;
    setHelpOpen(false);
    closeNewPaneMenu();
    closeSessionContextMenu({ restoreFocus: false });
    agentPickerIndex = 0;
    renderAgentPicker();
    agentPickerOverlayEl.hidden = false;
    focusAgentPickerList();
    refreshCovenLaunchCapabilities().then(function () {
      if (agentPickerOpen()) renderAgentPicker();
    });
    return true;
  }

  function closeAgentPicker() {
    if (agentPickerOverlayEl) agentPickerOverlayEl.hidden = true;
    var previousFocus = agentPickerPreviousFocus;
    agentPickerPreviousFocus = null;
    if (
      previousFocus &&
      typeof previousFocus.focus === "function" &&
      (!document.contains || document.contains(previousFocus))
    ) {
      previousFocus.focus();
    }
  }

  async function launchSelectedAgent() {
    var entry = agentLaunchOptions()[agentPickerIndex];
    if (!entry) return null;
    var project = activeProject();
    var gate = covenLaunchGate(entry);
    if (gate) {
      closeAgentPicker();
      setStatus(gate, "warn");
      return null;
    }
    var promptBacked = entry.id !== "coven-code";
    var prompt = promptBacked
      ? String(commandInput && commandInput.value || "").trim()
      : "";
    if (promptBacked && agentLaunchInFlight) {
      closeAgentPicker();
      setStatus("Wait for the current agent launch to finish", "warn");
      return null;
    }
    closeAgentPicker();
    if (promptBacked) agentLaunchInFlight = true;
    try {
      var thread = await spawnAgentThread(entry.id, project, prompt);
      if (!thread) {
        if (
          promptBacked &&
          commandInput &&
          typeof commandInput.focus === "function"
        ) {
          commandInput.focus();
        }
        return null;
      }
      if (
        promptBacked &&
        commandInput &&
        commandInput.value.trim() === prompt
      ) {
        commandInput.value = "";
        hidePalette();
        syncComposerChrome();
      }
      return thread;
    } catch (error) {
      setStatus(entry.label + " failed to start: " + String(error), "error");
      if (
        promptBacked &&
        commandInput &&
        typeof commandInput.focus === "function"
      ) {
        commandInput.focus();
      }
      return null;
    } finally {
      if (promptBacked) agentLaunchInFlight = false;
    }
  }

  async function spawnAgentThread(agentId, project, prompt) {
    project = project || activeProject();
    if (!project || !project.root) {
      setStatus("Open a project before starting an agent", "warn");
      return null;
    }
    if (project.closing) {
      setStatus(project.name + " is closing; wait before starting an agent", "warn");
      return null;
    }
    var worktree = selectedWorktree(project);
    if (!worktree || !worktree.path) {
      setStatus("Select an available worktree before starting an agent", "warn");
      return null;
    }
    var entry = agentLaunchOptions().find(function (option) {
      return option.id === agentId;
    });
    if (!entry) {
      setStatus("Unknown agent: " + agentId, "error");
      return null;
    }
    if (!state.env || !state.env.coven_path) {
      setStatus("Coven CLI not found — install @opencoven/cli and restart Psyche", "error");
      return null;
    }
    if (entry.id === "coven-code") {
      return ensureProjectCoven(project);
    }
    var userPrompt = String(prompt || "").trim();
    if (!userPrompt) {
      setStatus("Enter a prompt before starting an agent", "warn");
      return null;
    }
    if (userPrompt.length > COVEN_LAUNCH_PROMPT_MAX_CHARS) {
      setStatus(
        "Prompt exceeds the " + COVEN_LAUNCH_PROMPT_MAX_CHARS +
          "-character Coven launch limit — shorten it and retry",
        "warn"
      );
      return null;
    }
    if (!(await showTerminalView())) return null;
    if (hasCovenLaunchRecovery(project.id, worktree.path)) {
      setStatus(
        "Coven launch outcome is unknown; inspect Coven sessions before retrying",
        "warn"
      );
      return null;
    }
    var promptDigest = await covenPromptDigest(userPrompt);
    if (project.closing) {
      setStatus(project.name + " is closing; wait before starting an agent", "warn");
      return null;
    }
    var reservation;
    try {
      reservation = await reserveCovenLaunchThread({
        project: project,
        projectRoot: project.root,
        worktreePath: worktree.path,
        name: entry.label,
        promptDigest: promptDigest,
      });
    } catch (error) {
      setStatus(entry.label + " launch was not submitted: " + String(error), "error");
      return null;
    }
    if (!reservation) return null;
    if (project.closing) {
      await releaseCovenLaunchReservation(reservation);
      setStatus(project.name + " is closing; Coven launch was not submitted", "warn");
      return null;
    }
    var finishLaunchOutcome;
    var launchOutcomeInFlight = new Promise(function (resolve) {
      finishLaunchOutcome = resolve;
    });
    reservation.covenLaunchOutcomeInFlight = launchOutcomeInFlight;
    try {
      // The composer prompt rides the daemon launch request body only. It is
      // never placed in process argv and never stored on the launch model; the
      // pane attaches to the canonical Coven session returned by the daemon.
      var launchResult = await invoke("coven_launch_session", {
        request: {
          projectRoot: project.root,
          cwd: worktree.path,
          harness: entry.harness,
          prompt: userPrompt,
          title: entry.label,
        },
      }).catch(function () {
        return {
          status: "effect_unknown",
          message: "Coven launch outcome is unknown; inspect Coven sessions before retrying",
        };
      });
      if (!launchResult) {
        await markCovenLaunchRecoveryRequired(
          reservation,
          "Coven launch outcome is unknown; inspect Coven sessions before retrying"
        );
        return reservation;
      }
      if (covenLaunchOutcome(launchResult) !== "accepted") {
        if (launchResult.status === "effect_unknown") {
          var recoveryMessage = covenLaunchFailureStatus(entry, launchResult);
          await markCovenLaunchRecoveryRequired(reservation, recoveryMessage);
          setStatus(recoveryMessage, "error");
          return reservation;
        }
        await releaseCovenLaunchReservation(reservation);
        setStatus(covenLaunchFailureStatus(entry, launchResult), "error");
        return null;
      }
      return await acceptCovenLaunchReservation(reservation, {
        name: entry.label,
        sessionId: launchResult.sessionId,
        promptDigest: promptDigest,
        harness: launchResult.harness || entry.harness || "coven",
      });
    } finally {
      if (reservation.covenLaunchOutcomeInFlight === launchOutcomeInFlight) {
        reservation.covenLaunchOutcomeInFlight = null;
      }
      finishLaunchOutcome();
    }
  }

  function covenCliLaunch(project, worktreePath) {
    var worktree = worktreePath ? { path: worktreePath } : selectedWorktree(project);
    return {
      command: state.env.coven_path,
      args: [],
      env: {},
      projectRoot: project.root,
      cwd: worktree.path,
      kind: "coven-code",
      launchKind: "coven-code",
    };
  }

  async function spawnCovenThread(project, expectedWorktreePath) {
    project = project || activeProject();
    if (!project || !project.root) return null;
    if (!state.env || !state.env.coven_path) {
      setStatus("Coven CLI not found — install @opencoven/cli and restart Psyche", "error");
      return null;
    }
    var intendedProjectId = project.id;
    var intendedProjectRoot = project.root;
    var intendedWorktree = selectedWorktree(project);
    var intendedWorktreePath = expectedWorktreePath || (intendedWorktree && intendedWorktree.path);
    if (!intendedWorktreePath) return null;
    if (!(await showTerminalView())) return null;
    await new Promise(function (resolve) { requestAnimationFrame(resolve); });
    var currentProject = activeProject();
    var currentWorktree = selectedWorktree(currentProject);
    if (!currentProject || currentProject.id !== intendedProjectId ||
        !currentWorktree || currentWorktree.path !== intendedWorktreePath) return null;
    var launch = covenCliLaunch({ root: intendedProjectRoot }, intendedWorktreePath);
    if (!launch) return null;
    return createThread({
      project: currentProject,
      worktreePath: launch.cwd,
      name: "Coven CLI",
      kind: "coven-code",
      launch: launch,
    });
  }

  function ensureProjectCoven(project) {
    if (!project) return Promise.resolve(null);
    var worktree = selectedWorktree(project);
    if (!worktree || !worktree.path) return Promise.resolve(null);
    var existing = state.threads.find(function (t) {
      return t.projectId === project.id && t.worktreePath === worktree.path &&
        t.kind === "coven-code" &&
        (t.status === "starting" || t.status === "running") &&
        !t.closing && !t.hidden;
    });
    if (existing) {
      return Promise.resolve(focusThread(existing.id)).then(function () { return existing; });
    }
    var flightKey = String(project.id || "") + "\u0000" + String(worktree.path || "");
    var existingFlight = covenEnsureFlights.get(flightKey);
    if (existingFlight) return existingFlight;
    var flight = spawnCovenThread(project, worktree.path);
    var coordinatedFlight = flight.then(function (result) {
      if (covenEnsureFlights.get(flightKey) === coordinatedFlight) {
        covenEnsureFlights.delete(flightKey);
      }
      return result;
    }, function (error) {
      if (covenEnsureFlights.get(flightKey) === coordinatedFlight) {
        covenEnsureFlights.delete(flightKey);
      }
      throw error;
    });
    covenEnsureFlights.set(flightKey, coordinatedFlight);
    return coordinatedFlight;
  }

  function spawnShellThread(project) {
    project = project || activeProject();
    var worktree = selectedWorktree(project);
    return createThread({
      project: project,
      name: "shell " + (state.threads.length + 1),
      kind: "shell",
      command: state.env.default_shell,
      args: state.env.default_shell_args,
      launchKind: "shell",
      projectRoot: project && project.root,
      cwd: worktree && worktree.path,
      worktreePath: worktree && worktree.path,
    });
  }

  function spawnPsycheThread() {
    if (!state.env || !state.env.node_path || !state.env.psyche_entry) {
      writeToActive(
        "\r\n\x1b[33m[/new-psyche]\x1b[0m psyche entry not found.\r\n" +
        "Make sure dist/index.js exists in the worktree (run `pnpm run build`) " +
        "and that node is on PATH.\r\n"
      );
      return null;
    }
    var project = activeProject();
    var worktree = selectedWorktree(project);
    return createThread({
      project: project,
      name: "psyche",
      kind: "psyche",
      command: state.env.node_path,
      args: [state.env.psyche_entry],
      launchKind: "psyche",
      projectRoot: project && project.root,
      cwd: worktree && worktree.path,
      worktreePath: worktree && worktree.path,
      env: tauriPsycheEnv(),
    });
  }

  /**
   * Environment vars that isolate a psyche instance from the user's regular
   * tmux server. We point TMUX_TMPDIR at a Tauri-specific directory; tmux
   * creates its socket there and cannot see / be seen by any tmux running on
   * the default socket. We also clear TMUX so psyche doesn't think it is
   * already inside a tmux session inherited from the parent process.
   */
  function tauriPsycheEnv() {
    var home = (state.env && state.env.home) || "";
    var tmpdir = home ? home + "/.psyche/macos-app/tmux" : "/tmp/psyche-build-tauri";
    return {
      PSYCHE_TAURI: "1",
      PSYCHE_NATIVE_CONTAINER: "1",
      TMUX_TMPDIR: tmpdir,
      TMUX: "",
      npm_config_prefix: "",
      NPM_CONFIG_PREFIX: "",
      PREFIX: "",
    };
  }

  async function boot(env) {
    state.env = env || {};
    await installTerminalImageDrop();
    if (typeof statusController !== "undefined" && statusController) statusController.start();
    flushDeferredStatusMessages();
    var saved = await readSavedWorkspace();
    var project = null;
    isRestoringWorkspace = true;
    try {
      if (saved && saved.projects.length) {
        var restored = await restoreSavedProjects(
          saved.projects,
          saved.activeProjectId,
          Math.min(settings.maxProjects, HARD_MAX_PROJECTS)
        );
        state.projects = restored.projects;
        if (typeof assignActiveProjectId === "function") {
          assignActiveProjectId(restored.activeProjectId, { resetAgentControl: false });
        } else {
          Object.assign(state, { activeProjectId: restored.activeProjectId });
        }
        await invoke("native_project_reconcile", {
          roots: state.projects.map(function (savedProject) { return savedProject.root; }),
        });
        state.projects.forEach(function (savedProject) {
          savedProject.nativeAuthorityReady = true;
        });
        project = activeProject();
        await Promise.all(state.projects.map(function (savedProject) {
          return refreshProjectWorktrees(savedProject);
        }));
      } else {
        await invoke("native_project_reconcile", { roots: [] });
      }
      var liveSessionIds = [];
      if (!legacyWorkspaceMigration.projectsPreserved) {
        try {
          liveSessionIds = await invoke("native_session_list");
        } catch (error) {
          setStatus("native session discovery failed: " + String(error), "error");
        }
      }
      if (saved) await restorePersistedSessions(saved, liveSessionIds);
    } finally {
      isRestoringWorkspace = false;
    }
    if (project) {
      var activeTab = currentBrowserTab(project);
      if (activeTab && activeTab.created && activeTab.url && activeTab.url !== "about:blank") navigateBrowser(activeTab.url, { tabId: activeTab.id, preserveHistory: true });
    }
    renderPaneWorkspace({ preserveTerminalFocus: false });
    refreshSidebar(); refreshTabs(); renderBrowserTabs(); syncProjectBrowser(); loadAgentSkills();
    if (!legacyWorkspaceMigration.projectsPreserved) await saveWorkspaceNow();
    startCovenPolling();
    installAgentControlUi();
    if (paneMetricsPollTimer) clearInterval(paneMetricsPollTimer);
    paneMetricsPollTimer = setInterval(refreshVisiblePaneMetrics, 15000);
    refreshVisiblePaneMetrics();
    if (typeof refreshStatusController === "function") refreshStatusController();
  }

  invoke("app_environment")
    .then(boot)
    .catch(function (err) {
      showBootError("app_environment failed: " + err);
    });
})();
