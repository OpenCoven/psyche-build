// psyche — Tauri prototype workspace shell
// One module, no bundler. Uses UMD globals (Terminal, FitAddon) and the
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

  var statusController = null;
  var invokeNative = window.__TAURI__.core.invoke;
  var listen = window.__TAURI__.event.listen;
  var opener = window.__TAURI__.opener || null;
  var clipboardManager = window.__TAURI__.clipboardManager || null;
  var openUrl = (opener && opener.openUrl) || null;
  var dialogOpen = (window.__TAURI__.dialog && window.__TAURI__.dialog.open) || null;
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
   *                             term, fit, host, lastBytes }
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
    /** Files opened from the Files panel. These are the *only* things the main
     *  tab strip shows; projects are switched from the sessions sidebar.
     *  { id, path, rel, name, projectId, text, originalText, dirty, saving,
     *    languageId, cursor, selection, truncated, binary, size, error, saveError } */
    openFiles: [],
    /** Non-null while a file tab owns the main area instead of the terminal. */
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
  var paneCounter = 0;
  var visiblePaneFitFrame = 0;
  var PANE_METRICS_POLL_MS = 15000;
  var paneMetricsPollTimer = 0;
  var paneFooterPopoverCleanup = null;
  var paneFooterPopover = null;
  var paneFooterPopoverOwner = null;
  var paneFooterPopoverTrigger = null;
  var paneFooterPopoverThreadId = null;
  var browserTabLifecycleStates = new WeakMap();
  var browserPaneLifecycleStates = new WeakMap();
  // Matches --pane-min-w / --pane-min-h: the tree's arithmetic and the pane's
  // own CSS floor have to agree, or a layout the tree calls valid renders
  // overflowing. 200x137 includes the fixed 27px footer rail.
  var PANE_MINIMUMS = { width: 200, height: 137, separator: 6 };

  function handleVisibilityChange() {
    if (document.hidden || document.visibilityState === "hidden") {
      saveWorkspaceNow();
      stopCovenPolling();
      if (typeof stopAgentControlPolling === "function") stopAgentControlPolling("hidden");
    } else {
      startCovenPolling();
      if (typeof startAgentControlPolling === "function" && activeProject()) startAgentControlPolling();
      if (typeof refreshStatusController === "function") refreshStatusController();
    }
    syncPaneMetricsVisibility();
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
  function scheduleAgentControlRefresh() {
    if (typeof setTimeout !== "function") return;
    setTimeout(function () {
      if (typeof refreshAgentControlState === "function") refreshAgentControlState();
    }, 0);
  }
  function selectAgentControlWorktree(project, worktreePath, replacementWorktrees) {
    if (!project) return false;
    function effectiveRoot(worktrees, selectedPath) {
      var available = (Array.isArray(worktrees) ? worktrees : []).filter(function (worktree) {
        return worktree && !worktree.missing && !worktree.prunable && !worktree.bare;
      });
      var selected = available.find(function (worktree) { return worktree.path === selectedPath; }) ||
        available.find(function (worktree) { return worktree.is_main; }) || available[0];
      return selected ? selected.path : project.root;
    }
    var previousEffectiveRoot = effectiveRoot(project.worktrees, project.selectedWorktreePath);
    var nextEffectiveRoot = effectiveRoot(replacementWorktrees || project.worktrees, worktreePath);
    var changed = previousEffectiveRoot !== nextEffectiveRoot;
    var active = changed && state.activeProjectId === project.id;
    if (active && typeof invalidateAgentControlContext === "function") invalidateAgentControlContext();
    if (replacementWorktrees) project.worktrees = replacementWorktrees;
    project.selectedWorktreePath = worktreePath;
    if (active) scheduleAgentControlRefresh();
    return changed;
  }
  function nextPaneId(prefix) {
    paneCounter += 1;
    return prefix + "-" + paneCounter;
  }
  function paneLayoutKey(projectId, worktreePath) {
    return String(projectId || "") + "\u0000" + String(worktreePath || "");
  }
  function paneLayoutFor(projectId, worktreePath) {
    return paneLayouts.get(paneLayoutKey(projectId, worktreePath)) || null;
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
    if (typeof selectAgentControlWorktree === "function") selectAgentControlWorktree(project, worktreePath);
    else project.selectedWorktreePath = worktreePath;
    var layout = paneLayoutFor(project.id, worktreePath);
    var leaf = layout && PsychePanes.findLeafById(layout.root, layout.focusedLeafId);
    var thread = leaf && findThread(leaf.threadId);
    var activeThread = thread &&
      thread.kind !== "coven-chat" && thread.kind !== "coven-attach"
        ? thread
        : null;
    state.activeThreadId = activeThread ? activeThread.id : null;
    if (activeThread) project.lastActiveThreadId = activeThread.id;
    clearPassiveCovenPaneFocus(layout);
  }
  async function activateProjectWorktree(project, worktreePath, options) {
    var refreshStatus = !options || options.refreshStatus !== false;
    if (!project || !(await showTerminalView())) return false;
    var previousWorktreePath = project.selectedWorktreePath;
    var projectChanged = project.id !== state.activeProjectId;
    if (typeof selectAgentControlWorktree === "function") selectAgentControlWorktree(project, worktreePath);
    else project.selectedWorktreePath = worktreePath;
    if (projectChanged) {
      var projectOptions = Object.assign({}, options || {}, { refreshStatus: false });
      if (!(await setActiveProject(project.id, projectOptions))) {
        if (typeof selectAgentControlWorktree === "function") selectAgentControlWorktree(project, previousWorktreePath);
        else project.selectedWorktreePath = previousWorktreePath;
        return false;
      }
    } else {
      activatePaneLayoutFocus(project, worktreePath);
    }
    if (!projectChanged) {
      renderPaneWorkspace();
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
  function commitPanePlacement(placement) {
    paneLayouts.set(placement.key, placement.value);
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
      var nativeWorktrees = mergeWorktreePresentationState(project, [{
        path: project.root, branch: null, is_main: true, dirty: false, missing: false,
      }]);
      if (typeof selectAgentControlWorktree === "function") selectAgentControlWorktree(project, project.root, nativeWorktrees);
      else { project.worktrees = nativeWorktrees; project.selectedWorktreePath = project.root; }
      invalidateChangedDiffScope();
      refreshSidebar();
      if (typeof refreshStatusController === "function") refreshStatusController();
      refreshCovenSessions();
      return Promise.resolve(project.worktrees);
    }
    return invoke("git_worktrees", { root: project.root }).then(function (worktrees) {
      var mergedWorktrees = mergeWorktreePresentationState(project, worktrees);
      var selected = selectedWorktree(Object.assign({}, project, { worktrees: mergedWorktrees }));
      if (typeof selectAgentControlWorktree === "function") {
        selectAgentControlWorktree(project, selected ? selected.path : project.root, mergedWorktrees);
      } else {
        project.worktrees = mergedWorktrees;
        project.selectedWorktreePath = selected ? selected.path : project.root;
      }
      invalidateChangedDiffScope();
      refreshSidebar();
      saveWorkspaceSoon();
      if (typeof refreshStatusController === "function") refreshStatusController();
      refreshCovenSessions();
      return project.worktrees;
    }).catch(function () {
      var fallbackWorktrees = mergeWorktreePresentationState(project, [{
        path: project.root, branch: null, is_main: true, dirty: false, missing: false,
      }]);
      if (typeof selectAgentControlWorktree === "function") selectAgentControlWorktree(project, project.root, fallbackWorktrees);
      else { project.worktrees = fallbackWorktrees; project.selectedWorktreePath = project.root; }
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
    if (typeof invalidateAgentControlContext === "function") invalidateAgentControlContext();
    state.activeProjectId = id;
    if (typeof scheduleAgentControlRefresh === "function") scheduleAgentControlRefresh();
    clearPassiveCovenPaneFocus();
    // Refresh agent skill suggestions for the new project's `.claude` tree.
    loadAgentSkills();
    // Restore the project's last-focused thread, falling back to its first.
    var workspaceRoot = activeWorkspaceRoot(project);
    var threads = state.threads.filter(function (t) {
      return t.projectId === id && t.worktreePath === workspaceRoot && !t.hidden &&
        t.kind !== "coven-chat" && t.kind !== "coven-attach";
    });
    var rememberedThread = project.lastActiveThreadId && state.threads.find(function (thread) {
      return thread.id === project.lastActiveThreadId;
    });
    if (rememberedThread &&
        (rememberedThread.kind === "coven-chat" || rememberedThread.kind === "coven-attach")) {
      project.lastActiveThreadId = null;
    }
    var nextId = project.lastActiveThreadId &&
      threads.some(function (t) { return t.id === project.lastActiveThreadId; })
        ? project.lastActiveThreadId
        : (threads[0] ? threads[0].id : null);
    if (nextId) {
      var focusOptions = Object.assign({}, options || {}, { refreshStatus: false });
      await focusThread(nextId, focusOptions);
    } else {
      state.activeThreadId = null;
      renderPaneWorkspace();
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
  var WORKSPACE_STATE_KEY = "psyche.tauri.workspace.v1";
  var settings = loadSettings();
  var isRestoringWorkspace = false;
  var saveWorkspaceTimer = 0;

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
  function loadSettings() {
    var defaults = {
      maxProjects: 10,
      maxBrowserTabsPerProject: 10,
      bgOpacity: DEFAULT_BG_OPACITY,
      theme: DEFAULT_THEME,
      solidBg: false,
      sidebarTab: "sessions",
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
        sidebarTab: saved.sidebarTab === "files" ? "files" : "sessions",
        sessionFilter: PsycheSessions.normalizeSidebarFilter(saved.sessionFilter),
        selectedSessionKey: typeof saved.selectedSessionKey === "string" ? saved.selectedSessionKey.slice(0, 1024) : "",
      };
    } catch (_) { return defaults; }
  }
  function saveSettings() {
    settings.maxProjects = clampInt(settings.maxProjects, 10, 1, HARD_MAX_PROJECTS);
    settings.maxBrowserTabsPerProject = clampInt(settings.maxBrowserTabsPerProject, 10, 1, HARD_MAX_BROWSER_TABS_PER_PROJECT);
    settings.bgOpacity = clampFloat(settings.bgOpacity, DEFAULT_BG_OPACITY, MIN_BG_OPACITY, MAX_BG_OPACITY);
    if (THEMES.indexOf(settings.theme) === -1) settings.theme = DEFAULT_THEME;
    settings.solidBg = settings.solidBg === true;
    settings.sidebarTab = settings.sidebarTab === "files" ? "files" : "sessions";
    settings.sessionFilter = PsycheSessions.normalizeSidebarFilter(settings.sessionFilter);
    settings.selectedSessionKey = typeof settings.selectedSessionKey === "string" ? settings.selectedSessionKey.slice(0, 1024) : "";
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
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
  function workspaceModel() {
    return window.PsycheWorkspace || null;
  }
  function workspaceSnapshotV2() {
    return { version: 2, activeProjectId: state.activeProjectId || null, projects: state.projects.map(persistableProject).slice(0, HARD_MAX_PROJECTS) };
  }
  var workspaceSaveQueue = Promise.resolve();
  function saveWorkspaceNow() {
    if (isRestoringWorkspace) return workspaceSaveQueue;
    var snapshot = workspaceSnapshotV2();
    try {
      localStorage.setItem(WORKSPACE_STATE_KEY, JSON.stringify(snapshot));
    } catch (_) {}
    // The native store is authoritative on load; localStorage above stays as a
    // fallback for webviews where the command is unavailable.
    var model = workspaceModel();
    if (!model) return workspaceSaveQueue;
    var workspace = model.importWorkspaceV2(snapshot);
    workspaceSaveQueue = workspaceSaveQueue.then(function () {
      return invoke("workspace_save", { workspace: workspace });
    }).catch(function (error) {
      setStatus("workspace save failed: " + String(error), "error");
    });
    return workspaceSaveQueue;
  }
  function saveWorkspaceSoon() {
    if (isRestoringWorkspace) return;
    if (saveWorkspaceTimer) cancelAnimationFrame(saveWorkspaceTimer);
    saveWorkspaceTimer = requestAnimationFrame(function () {
      saveWorkspaceTimer = 0;
      saveWorkspaceNow();
    });
  }
  function readSavedWorkspace() {
    try { var saved = JSON.parse(localStorage.getItem(WORKSPACE_STATE_KEY) || "null"); return saved && Array.isArray(saved.projects) ? saved : null; } catch (_) { return null; }
  }
  async function loadSavedWorkspace() {
    var model = workspaceModel();
    if (model) {
      try {
        var native = model.sanitizeWorkspaceV3(await invoke("workspace_load"));
        if (native && native.projects.length) {
          return { version: 2, activeProjectId: native.activeProjectId, projects: native.projects };
        }
      } catch (_) {}
    }
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
  var sidebarResizeEl = document.getElementById("sidebar-resize");
  var newPaneMenuEl = document.getElementById("new-pane-menu");
  var newPaneMenuHeadEl = document.getElementById("new-pane-menu-head");
  var toastEl = document.getElementById("toast");
  var helpOverlayEl = document.getElementById("help-overlay");
  var agentPickerOverlayEl = document.getElementById("agent-picker-overlay");
  var agentPickerListEl = document.getElementById("agent-picker-list");
  var agentPickerIndex = 0;
  var agentPickerPreviousFocus = null;
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
  function toast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.hidden = true;
      toastTimer = 0;
    }, 2600);
  }

  function showPanePlacementWarning(message) {
    setStatus(message, "warn");
    toast(message);
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

  var pendingDataBuffers = new Map(); // threadId → buffered output + acknowledgement callbacks (pre-mount)

  function acknowledgePtyBatch(threadId, sequence) {
    return invoke("pty_ack", {
      threadId: threadId,
      thread_id: threadId,
      sequence: sequence,
    }).catch(function (error) {
      console.warn("[pty_ack] failed for " + threadId + ": " + String(error));
    });
  }

  listen("pty:data-batch", function (event) {
    var payload = event.payload || {};
    var threadId = payload.threadId || payload.thread_id;
    if (!threadId || !payload.bytes) return;
    var bytes = new Uint8Array(payload.bytes);
    var acknowledge = function () { acknowledgePtyBatch(threadId, payload.sequence); };
    var thread = findThread(threadId);
    if (!isLiveThread(thread)) { acknowledge(); return; }
    thread.lastOutputAt = Date.now();
    if (typeof noteStatusPtyData === "function") noteStatusPtyData(threadId, bytes);
    if (thread.term) {
      thread.term.write(bytes, acknowledge);
    } else {
      var arr = pendingDataBuffers.get(threadId) || [];
      arr.push({ bytes: bytes, acknowledge: acknowledge });
      pendingDataBuffers.set(threadId, arr);
    }
    schedulePaneMetricsRefresh(thread, 1200);
  }).catch(function () {});

  function handlePtyExit(payload) {
    payload = payload || {};
    var thread = findThread(payload.thread_id);
    if (!thread || thread.closing || thread.closeStarted) return false;
    var stoppedByUser = thread.stopRequested;
    thread.ptyStarted = false;
    if (thread.startInFlight) {
      thread.exitDuringStart = true;
    }
    thread.stopRequested = false;
    thread.spawning = false;
    thread.finishedAt = Date.now();
    thread.exitCode = payload.code == null ? null : payload.code;
    thread.status = "exited";
    thread.isWorking = false;
    if (!stoppedByUser && payload.code != null && payload.code !== 0) {
      thread.status = "failed";
    }
    // An exited pane is not waiting on an answer, it is over. Leaving the badge
    // would send the user to a pane with nothing to say.
    clearThreadAttention(thread);
    syncThreadPaneMetadata(thread);
    if (thread.term) {
      thread.term.write("\r\n\x1b[2;90m[process exited]\x1b[0m\r\n");
    }
    refreshSidebar();
    refreshTabs();
    if (state.activeThreadId === thread.id) {
      setProjectStatus(findProject(thread.projectId), "warn");
    }
    if (typeof refreshStatusController === "function") refreshStatusController();
    return true;
  }

  listen("pty:exit", function (event) {
    handlePtyExit(event.payload || {});
  }).catch(function () {});

  function findThread(id) {
    for (var i = 0; i < state.threads.length; i++) {
      if (state.threads[i].id === id) return state.threads[i];
    }
    return null;
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
   * The last `lines` non-empty rows of what the terminal is actually showing.
   * Read off the buffer rather than accumulated PTY bytes so redraws, cursor
   * moves and cleared spinners are already resolved into what the user sees.
   */
  function terminalTail(term, lines) {
    if (!term || !term.buffer || !term.buffer.active) return "";
    var buffer = term.buffer.active;
    var end = buffer.baseY + buffer.cursorY;
    var out = [];
    for (var row = end; row >= 0 && out.length < lines; row--) {
      var line = buffer.getLine(row);
      if (!line) continue;
      var text = line.translateToString(true);
      if (!text.trim() && out.length === 0) continue;
      out.push(text);
    }
    return out.reverse().join("\n");
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
      if (!thread || !thread.term) return;
      var tail = terminalTail(thread.term, ATTENTION_TAIL_LINES);
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
  function makeCovenSessionId() {
    var cryptoApi = window.crypto;
    if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
      try {
        return cryptoApi.randomUUID();
      } catch (_) {}
    }
    if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
      try {
        var bytes = new Uint8Array(16);
        cryptoApi.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        var hex = "";
        for (var i = 0; i < bytes.length; i++) {
          hex += bytes[i].toString(16).padStart(2, "0");
        }
        return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" +
          hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
      } catch (_) {}
    }
    setStatus("Secure session ID generation is unavailable", "error");
    return null;
  }
  function isLiveThread(thread) {
    return !!thread && !thread.closing && state.threads.indexOf(thread) !== -1;
  }

  function threadCovenSessionId(thread) {
    return thread && thread.launch && thread.launch.covenSessionId || null;
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

  function createThread(opts) {
    var id = makeThreadId();
    var project = opts.project || activeProject();
    var sourceLaunch = opts.launch || {
      command: opts.command,
      args: opts.args || [],
      env: opts.env || {},
      projectRoot: opts.projectRoot || (project && project.root),
      cwd: opts.cwd || opts.worktreePath || opts.projectRoot,
      launchKind: opts.launchKind || null,
      covenSessionId: opts.covenSessionId || null,
      metricsProvider: opts.metricsProvider || null,
    };
    var launch = {
      command: sourceLaunch.command,
      args: Array.isArray(sourceLaunch.args) ? sourceLaunch.args.slice() : [],
      env: Object.assign({}, sourceLaunch.env || {}),
      projectRoot: sourceLaunch.projectRoot || (project && project.root) || null,
      cwd: sourceLaunch.cwd || opts.worktreePath || sourceLaunch.projectRoot ||
        (project && activeWorkspaceRoot(project)) || null,
      launchKind: sourceLaunch.launchKind || null,
      covenSessionId: sourceLaunch.covenSessionId || null,
      metricsProvider: sourceLaunch.metricsProvider || opts.metricsProvider || null,
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
      fit: null,
      host: null,
      pane: null,
      closing: false,
      closeStarted: false,
      startInFlight: false,
      exitDuringStart: false,
      stopRequested: false,
      ptyStarted: false,
      metricsGeneration: 0,
      metrics: launch.launchKind === "coven-chat" && launch.covenSessionId
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
    commitPanePlacement(placement);
    state.threads.push(thread);
    if (typeof noteStatusActivity === "function") noteStatusActivity();
    refreshSidebar();
    refreshTabs();
    mountTerminal(thread);
    focusThread(id);
    // Run fit() now so the PTY starts at the actual visible size, not at
    // xterm.js's default 80x24. Otherwise psyche/Ink draw the first frame at
    // the wrong size and leave artifacts.
    requestAnimationFrame(function () {
      if (!isLiveThread(thread)) return;
      try { if (thread.fit) thread.fit.fit(); } catch (_) {}
      spawnPty(thread);
    });
    return thread;
  }

  async function createBrowserPane(project) {
    project = project || activeProject();
    if (!project) return null;
    if (!(await showTerminalView())) return null;
    var worktreePath = activeWorkspaceRoot(project);
    var existing = findBrowserPane(project.id, worktreePath);
    if (existing) {
      if (browserPaneIsClosing(existing)) return null;
      await focusThread(existing.id);
      return browserPaneIsClosing(existing) ? null : existing;
    }
    await new Promise(function (resolve) { requestAnimationFrame(resolve); });
    var id = makeThreadId();
    var placement = preparePanePlacement(id, project.id, worktreePath);
    if (!placement) {
      setStatus("Not enough space for another pane", "warn");
      return null;
    }
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
    };
    commitPanePlacement(placement);
    state.threads.push(pane);
    if (typeof noteStatusActivity === "function") noteStatusActivity();
    mountBrowserPane(pane);
    await focusThread(id);
    if (browserPaneIsClosing(pane)) return null;
    refreshSidebar();
    refreshTabs();
    return pane;
  }

  function stopThreadPty(thread) {
    if (!thread || thread.stopRequested) return Promise.resolve(false);
    thread.stopRequested = true;
    return invoke("pty_stop", {
      threadId: thread.id,
      thread_id: thread.id,
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
        cols: thread.term ? thread.term.cols : 120,
        rows: thread.term ? thread.term.rows : 40,
        env: launch.env,
      },
    }).then(function () {
      thread.startInFlight = false;
      if (!isLiveThread(thread)) {
        pendingDataBuffers.delete(thread.id);
        return stopThreadPty(thread).then(function () { return false; });
      }
      if (thread.exitDuringStart) {
        thread.exitDuringStart = false;
        thread.ptyStarted = false;
        thread.spawning = false;
        thread.isWorking = false;
        syncThreadPaneMetadata(thread);
        refreshSidebar();
        refreshTabs();
        return false;
      }
      thread.ptyStarted = true;
      thread.status = "running";
      thread.spawning = false;
      syncThreadPaneMetadata(thread);
      refreshSidebar();
      refreshTabs();
      if (state.activeThreadId === thread.id) {
        setProjectStatus(findProject(thread.projectId), "ok");
      }
      if (launch.launchKind === "coven-chat") refreshCovenSessions();
      // Flush any data that arrived before the xterm was mounted.
      var pending = pendingDataBuffers.get(thread.id);
      if (pending && thread.term) {
        for (var i = 0; i < pending.length; i++) {
          thread.term.write(pending[i].bytes, pending[i].acknowledge);
        }
        pendingDataBuffers.delete(thread.id);
      }
      return true;
    }).catch(function (err) {
      thread.startInFlight = false;
      var msg = String(err);
      if (!isLiveThread(thread)) {
        pendingDataBuffers.delete(thread.id);
        if (msg.indexOf("already running") !== -1) {
          thread.ptyStarted = true;
          return stopThreadPty(thread).then(function () { return false; });
        }
        return false;
      }
      if (thread.exitDuringStart) {
        thread.exitDuringStart = false;
        thread.ptyStarted = false;
        thread.spawning = false;
        thread.isWorking = false;
        syncThreadPaneMetadata(thread);
        refreshSidebar();
        refreshTabs();
        return false;
      }
      thread.spawning = false;
      if (msg.indexOf("cleanup in progress") !== -1) {
        thread.ptyStarted = false;
        if (thread.terminalController) thread.terminalController.stopPtyDelivery();
        thread.ptyClient = null;
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
        if (state.activeThreadId === thread.id) {
          setProjectStatus(findProject(thread.projectId), "ok");
        }
        if (launch.launchKind === "coven-chat") refreshCovenSessions();
        var pending = pendingDataBuffers.get(thread.id);
        if (pending && thread.term) {
          for (var i = 0; i < pending.length; i++) {
            thread.term.write(pending[i].bytes, pending[i].acknowledge);
          }
          pendingDataBuffers.delete(thread.id);
        }
      } else {
        thread.ptyStarted = false;
        thread.status = "failed";
        thread.isWorking = false;
        thread.finishedAt = Date.now();
        thread.exitCode = null;
        if (thread.term) {
          thread.term.write("\r\n\x1b[31m[pty_start error]\x1b[0m " + msg + "\r\n");
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

  async function retryThread(id) {
    var thread = findThread(id);
    if (!thread || thread.startInFlight || thread.closeStarted) return false;
    if (thread.status !== "exited" && thread.status !== "failed") return false;
    if (thread.launch.launchKind === "coven-attach") {
      var project = findProject(thread.projectId);
      await refreshCovenSessions();
      var stillExists = project
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
    return spawnPty(thread);
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

  function terminalLinksForLine(text, y) {
    var links = [];
    var match;
    TERMINAL_URL_RE.lastIndex = 0;
    while ((match = TERMINAL_URL_RE.exec(text)) !== null) {
      var raw = match[0];
      var url = trimTerminalUrl(raw);
      if (!normaliseUrl(url)) continue;
      links.push(createTerminalLink(url, match.index + 1, y));
    }
    return links;
  }

  function createTerminalLink(url, x, y) {
    return {
      text: url,
      range: {
        start: { x: x, y: y },
        end: { x: x + url.length - 1, y: y },
      },
      activate: function (event) {
        openTerminalLink(url, event);
      },
    };
  }

  function openTerminalLink(url, event) {
    var normalised = normaliseUrl(url);
    if (!normalised) return;
    var external = event && (event.button === 2 || event.type === "contextmenu");
    if (external) {
      if (openUrl) openUrl(normalised).catch(function () {});
      return;
    }
    navigateBrowser(normalised);
  }

  function terminalUrlAtEvent(term, event) {
    var screen = term.element && term.element.querySelector(".xterm-screen");
    var dimensions = term._core && term._core._renderService && term._core._renderService.dimensions;
    var cell = dimensions && dimensions.css && dimensions.css.cell;
    if (!screen || !cell || !cell.width || !cell.height) return "";
    var rect = screen.getBoundingClientRect();
    var x = Math.floor((event.clientX - rect.left) / cell.width) + 1;
    var screenY = Math.floor((event.clientY - rect.top) / cell.height) + 1;
    if (x < 1 || screenY < 1 || x > term.cols || screenY > term.rows) return "";
    var y = terminalViewportY(term) + screenY;
    var links = terminalLinksForLine(terminalLineText(term, y), y);
    for (var i = 0; i < links.length; i++) {
      if (links[i].range.start.x <= x && links[i].range.end.x >= x) return links[i].text;
    }
    return "";
  }

  function registerTerminalLinkHandling(term, container) {
    if (typeof term.registerLinkProvider === "function") {
      term.registerLinkProvider({
        provideLinks: function (y, callback) {
          callback(terminalLinksForLine(terminalLineText(term, y), y));
        },
      });
    }
    container.addEventListener("contextmenu", function (event) {
      var url = terminalUrlAtEvent(term, event);
      if (!url) return;
      event.preventDefault();
      event.stopPropagation();
      openTerminalLink(url, event);
    }, true);
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
    var span = document.createElement("button");
    span.type = "button";
    span.className = "terminal-pane-span";
    span.addEventListener("click", function (event) {
      event.stopPropagation();
      cyclePaneSpan(thread);
    });
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
    header.appendChild(span);
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
    thread.paneSpan = span;
    thread.paneMax = maximize;
    thread.paneClose = close;
    syncThreadPaneMetadata(thread);
    renderPaneWorkspace();
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
    var span = document.createElement("button");
    span.type = "button";
    span.className = "terminal-pane-span";
    span.addEventListener("click", function (event) {
      event.stopPropagation();
      cyclePaneSpan(thread);
    });
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
    header.appendChild(span);
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
    thread.paneSpan = span;
    thread.paneMax = maximize;
    thread.paneClose = close;
    syncThreadPaneMetadata(thread);
    renderPaneWorkspace();
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
    var span = document.createElement("button");
    span.type = "button";
    span.className = "terminal-pane-span";
    span.addEventListener("click", function (event) {
      event.stopPropagation();
      cyclePaneSpan(thread);
    });
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
    header.appendChild(span);
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
    thread.paneSpan = span;
    thread.paneMax = maximize;
    thread.paneClose = close;
    syncThreadPaneMetadata(thread);
    renderPaneWorkspace();

    var term = new window.Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.18,
      // Fully transparent canvas: the terminal's tint comes from
      // .terminal-area's CSS background, which already tracks --bg-opacity.
      // Driving it through the xterm theme instead left .xterm-viewport
      // painted an opaque black that ignored the setting.
      allowTransparency: true,
      theme: {
        background: "rgba(0, 0, 0, 0)",
        foreground: "#ece9f5",
        cursor: "#a78bfa",
        selectionBackground: "rgba(167,139,250,0.30)",
      },
      cursorBlink: true,
      convertEol: false,
      allowProposedApi: true,
    });
    var fit = window.FitAddon ? new window.FitAddon.FitAddon() : null;
    if (fit) term.loadAddon(fit);
    term.open(container);
    registerTerminalLinkHandling(term, container);
    container.addEventListener("pointerdown", function () {
      if (state.activeThreadId !== thread.id) {
        focusThread(thread.id);
      } else {
        term.focus();
      }
    });

    // Premium upgrade: try the WebGL renderer for sharp text + truecolor.
    // Fall back silently to the default canvas renderer if WebGL is
    // unavailable (e.g. virtualised GPU).
    try {
      if (window.WebglAddon && window.WebglAddon.WebglAddon) {
        var webgl = new window.WebglAddon.WebglAddon();
        webgl.onContextLoss(function () { try { webgl.dispose(); } catch (_) {} });
        term.loadAddon(webgl);
      }
    } catch (_) { /* canvas fallback is fine */ }

    term.onData(function (data) { sendToThread(thread, data); });
    // Agents ring the bell for exactly one reason -- they want the user back --
    // so it is trusted immediately instead of waiting for the tail to settle.
    if (typeof term.onBell === "function") {
      term.onBell(function () {
        if (!threadWantsAttentionTracking(thread)) return;
        applyThreadAttention(thread, attentionTracker.bell(thread.id));
      });
    }
    term.onResize(function (size) {
      invoke("pty_resize", {
        threadId: thread.id,
        thread_id: thread.id,
        cols: size.cols,
        rows: size.rows,
      }).catch(function () {});
    });

    thread.term = term;
    thread.fit = fit;
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

  function paneElementAt(clientX, clientY) {
    var ids = canvasThreadIds();
    for (var i = 0; i < ids.length; i++) {
      var thread = findThread(ids[i]);
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
    scheduleVisiblePaneFit();
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
    if (canvasThreadIds().length < 2) return;

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
        updateActiveSplit(node.id, nextRatio, dragLayout);
      }
      function stopPointerResize(endEvent) {
        if (endEvent && endEvent.pointerId !== undefined && endEvent.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", stopPointerResize);
        window.removeEventListener("pointercancel", stopPointerResize);
        window.removeEventListener("blur", stopPointerResize);
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
      updateActiveSplit(
        node.id,
        ratio + (event.key === shrinkKey ? -step : step),
        activePaneLayout(),
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

  function updateActiveSplit(splitId, ratio, expectedLayout, restoreFocus) {
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
    renderPaneWorkspace();
    if (restoreFocus) focusPaneDivider(splitId);
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
    var scoped = PsychePanes.retainThreads(layout.root, set.threadIds);
    if (!scoped) {
      layout.activeSetId = null;
      return layout.root;
    }
    return scoped;
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

  function paneLayoutForThread(thread) {
    return thread ? paneLayoutFor(thread.projectId, thread.worktreePath) : null;
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
    var sets = setsForThread(thread);
    if (!sets.length) return clearFocusSet();
    var layout = paneLayoutForThread(thread);
    if (layout && layout.activeSetId === sets[0].id) return false;
    return activateFocusSet(sets[0].id);
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

  function cyclePaneSpan(thread) {
    var layout = paneLayoutForThread(thread);
    if (!layout || !layout.root) return;
    var leaf = PsychePanes.findLeafByThreadId(layout.root, thread.id);
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
    if (state.activeThreadId !== thread.id) {
      focusThread(thread.id);
      return;
    }
    renderPaneWorkspace();
  }

  function togglePaneMaximize(thread) {
    var layout = paneLayoutForThread(thread);
    if (!layout || !layout.root) return;
    var leaf = PsychePanes.findLeafByThreadId(layout.root, thread.id);
    if (!leaf) return;
    layout.maximizedLeafId = layout.maximizedLeafId === leaf.id ? null : leaf.id;
    layout.focusedLeafId = leaf.id;
    if (state.activeThreadId !== thread.id) {
      focusThread(thread.id);
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

  var SPAN_GLYPHS = { column: "▥", row: "▤" };
  var SPAN_TITLES = {
    tiled: "Span this pane — full column (⇥ full row, ⇥ tiled)",
    column: "Spanning a full column — click for a full row",
    row: "Spanning a full row — click to return to tiled",
  };

  function syncPaneSpanControl(thread, layout, leaf) {
    if (!thread.paneSpan) return;
    var spanned = Boolean(leaf) && layout.spanMode && layout.focusedLeafId === leaf.id;
    var mode = spanned ? layout.spanMode : "tiled";
    thread.paneSpan.textContent = spanned ? SPAN_GLYPHS[layout.spanMode] : "▦";
    thread.paneSpan.title = SPAN_TITLES[mode];
    thread.paneSpan.setAttribute("aria-label", SPAN_TITLES[mode]);
    thread.paneSpan.setAttribute("aria-pressed", spanned ? "true" : "false");
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

  function renderPaneNode(node, splitRatios) {
    if (node.type === "leaf") {
      var thread = findThread(node.threadId);
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
    split.appendChild(first);
    split.appendChild(createPaneDivider(node, ratio));
    split.appendChild(second);
    return split;
  }

  function renderPaneWorkspace() {
    if (!terminalHost) return;
    stageBrowserSurface();
    stageGitSurface();
    terminalHost.replaceChildren();
    var layout = activePaneLayout();
    if (!layout || !layout.root) {
      renderTerminalEmptyState();
      renderPaneMinimap(layout, findOpenFile(state.activeFileId));
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
      var thread = leaf && findThread(leaf.threadId);
      if (!thread || !thread.pane) return;
      thread.pane.classList.toggle("focused", thread.id === state.activeThreadId);
      syncPanePicking(thread);
      syncThreadPaneMetadata(thread);
    });
    renderSetPickBar();
    renderPaneMinimap(layout, findOpenFile(state.activeFileId));
    scheduleVisiblePaneFit();
    requestAnimationFrame(syncBrowserBounds);
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
      var thread = leaf && findThread(leaf.threadId);
      if (!thread) return;
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
      entry.title = item.kind === "file"
        ? item.detail + " · current file"
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
          restoreFileEditorFocus();
        });
      } else {
        entry.addEventListener("click", async function () {
          var leaf = PsychePanes.findLeafByThreadId(layout.root, item.thread.id);
          if (!leaf) return;
          if (state.activeFileId) {
            await returnFromFileFocus(item.thread.id, true);
            return;
          }
          layout.maximizedLeafId = leaf.id;
          layout.focusedLeafId = leaf.id;
          focusThread(item.thread.id);
        });
      }
      rail.appendChild(entry);
    });
  }

  async function focusThread(id, options) {
    var thread = findThread(id);
    if (!thread) return false;
    if (!(await showTerminalView())) return false;
    var project = findProject(thread.projectId);
    var projectChanged = state.activeProjectId !== thread.projectId;
    var scopeChanged = projectChanged ||
      !project || activeWorkspaceRoot(project) !== thread.worktreePath;
    if (projectChanged && typeof invalidateAgentControlContext === "function") invalidateAgentControlContext();
    markActiveSurface(thread.kind === "web" ? "browser" : "terminal");
    state.activeThreadId = id;
    if (project) {
      if (thread.kind !== "coven-chat" && thread.kind !== "coven-attach") {
        project.lastActiveThreadId = id;
      }
      if (typeof selectAgentControlWorktree === "function") selectAgentControlWorktree(project, thread.worktreePath);
      else project.selectedWorktreePath = thread.worktreePath;
    }
    // Make the thread's project active only after its worktree context has
    // invalidated old authority and selected the exact new workspace.
    if (thread.projectId && state.activeProjectId !== thread.projectId) state.activeProjectId = thread.projectId;
    if (projectChanged && typeof scheduleAgentControlRefresh === "function") scheduleAgentControlRefresh();
    var layout = paneLayoutFor(thread.projectId, thread.worktreePath);
    var leaf = layout && PsychePanes.findLeafByThreadId(layout.root, id);
    if (layout && leaf) layout.focusedLeafId = leaf.id;
    renderPaneWorkspace();
    if (scopeChanged) renderGitSurface();
    refreshSidebar();
    requestAnimationFrame(function () {
      scheduleVisiblePaneFit();
      if (thread.term) thread.term.focus();
      Promise.resolve(syncBrowserBounds()).catch(function () {});
    });

    setProjectStatus(project, statusLevel(thread.status));
    if ((!options || options.refreshStatus !== false) &&
        typeof refreshStatusController === "function") {
      refreshStatusController();
    }
    return true;
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
      syncPaneSpanControl(thread, layout, leaf);
      syncPaneMaxControl(thread, layout, leaf);
    }
    if (thread.paneClose) {
      var closeLabel = sessionCloseLabel(thread);
      thread.paneClose.title = closeLabel;
      thread.paneClose.setAttribute("aria-label", closeLabel);
    }
  }

  function detachThreadPane(thread) {
    if (!thread) return null;
    if (typeof paneFooterPopoverThreadId !== "undefined" &&
        paneFooterPopoverThreadId === thread.id &&
        typeof closePaneFooterPopovers === "function") {
      closePaneFooterPopovers(false);
    }
    if (typeof closePaneFooterMenu === "function") closePaneFooterMenu(thread, false);
    if (thread.paneFooterObserver) thread.paneFooterObserver.disconnect();
    thread.paneFooterObserver = null;
    thread.paneFooter = null;
    thread.paneFooterItems = null;
    thread.paneFooterOverflow = null;
    thread.paneFooterMenuTrigger = null;
    thread.createPaneFooterButton = null;
    var key = paneLayoutKey(thread.projectId, thread.worktreePath);
    var layout = paneLayouts.get(key);
    if (!layout || !layout.root) return null;
    var leaf = PsychePanes.findLeafByThreadId(layout.root, thread.id);
    if (!leaf) return null;
    var removed = PsychePanes.removeLeaf(layout.root, leaf.id);
    if (!removed.root) {
      paneLayouts.delete(key);
      return null;
    }
    layout.root = removed.root;
    if (layout.focusedLeafId === leaf.id) {
      layout.focusedLeafId = removed.nextLeafId;
    }
    paneLayouts.set(key, layout);
    var nextLeaf = PsychePanes.findLeafById(removed.root, removed.nextLeafId);
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
        tabLifecycle.eventUrl = null;
        tabLifecycle.viewLive = false;
        tabLifecycle.navigationSnapshot = null;
        if (skippedLabels.has(label)) continue;
        if (!savedTab) continue;
        try {
          await invoke("browser_navigate", {
            tabId: currentTab.id,
            generation: tabLifecycle.generation + 1,
            label: savedTab.label,
            url: savedTab.url,
            x: -10000,
            y: -10000,
            w: 1,
            h: 1,
          });
          currentTab.created = true;
          currentTab.loading = false;
          tabLifecycle.generation += 1;
          tabLifecycle.nativeLabel = nativeBrowserLabel(savedTab.label);
          tabLifecycle.liveGeneration = tabLifecycle.generation;
          tabLifecycle.liveUrl = savedTab.url;
          tabLifecycle.viewLive = true;
          tabLifecycle.nativeBounds = { x: -10000, y: -10000, w: 1, h: 1 };
          if (typeof publishBrowserResource === "function") await publishBrowserResource({ project: project,
            worktreePath: thread.worktreePath, browser: browser, tab: currentTab });
          recreated += 1;
        } catch (recoveryError) {
          currentTab.created = false;
          currentTab.loading = false;
          recoveryErrors.push(savedTab.id + ": " + String(recoveryError));
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
    browser.tabs.forEach(function (tab) {
      invalidateBrowserNavigation(tab);
    });
    if (typeof invalidateBrowserAutomation === "function") {
      await Promise.all(browser.tabs.map(function (tab) { return invalidateBrowserAutomation(tab); }));
    }
    browser.tabs.forEach(function (tab) { browserTabLifecycle(tab).publicationSequence += 1; });
    var publicationTails = browser.tabs.map(function (tab) { return browserTabLifecycle(tab).publicationTail; })
      .filter(function (tail) { return !!tail; });
    if (publicationTails.length) await Promise.all(publicationTails);
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
      var transportStatus = "browser pane close failed before structured teardown outcome: " + String(error);
      if (missingLiveLabels.size) {
        var transportRecovery = await recoverAffectedLiveTabs(missingLiveLabels, new Set());
        transportStatus += "; recreated " + transportRecovery.recreated + "/" +
          transportRecovery.affectedLiveTabs + " missing live tabs";
        if (transportRecovery.recoveryErrors.length) {
          transportStatus += "; recreation failures: " + transportRecovery.recoveryErrors.join(", ");
        }
      }
      setStatus(transportStatus, "error");
      return false;
    }
    var destroyed = new Set(Array.isArray(outcome && outcome.destroyed) ? outcome.destroyed : []);
    var failures = Array.isArray(outcome && outcome.failures)
      ? outcome.failures.map(function (failure) {
          return {
            label: failure && typeof failure.label === "string" ? failure.label : "",
            error: failure && failure.error != null ? String(failure.error) : "unknown close error",
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
      var recovery = await recoverAffectedLiveTabs(destroyed, failedLabels);
      var closeErrors = failures.map(function (failure) {
        return failure.label + ": " + failure.error;
      });
      var recoveryStatus = "browser pane close failed; native close failures: " + closeErrors.join(", ");
      recoveryStatus += "; recreated " + recovery.recreated + "/" + recovery.affectedLiveTabs + " confirmed-destroyed live tabs";
      if (recovery.recoveryErrors.length) recoveryStatus += "; recreation failures: " + recovery.recoveryErrors.join(", ");
      setStatus(recoveryStatus, "error");
      return false;
    }
    if (typeof removeBrowserResource === "function") {
      await Promise.all(browser.tabs.map(function (tab) { return removeBrowserResource(project, tab); }));
    }
    var wasActive = state.activeThreadId === thread.id;
    browser.tabs.forEach(function (tab) {
      tab.created = false;
      tab.loading = false;
      var lifecycle = browserTabLifecycle(tab);
      lifecycle.nativeLabel = null;
      lifecycle.pendingGeneration = 0;
      lifecycle.pendingUrl = null;
      lifecycle.liveGeneration = 0;
      lifecycle.liveUrl = null;
      lifecycle.eventUrl = null;
      lifecycle.viewLive = false;
      lifecycle.navigationSnapshot = null;
    });
    saveWorkspaceSoon();
    stageBrowserSurface();
    var closed = closeThread(thread.id);
    if (closed && wasActive) markActiveSurface("terminal");
    return closed;
    } finally {
      paneLifecycle.tearingDown = false;
    }
  }

  function retainFileFocusAfterThreadRemoval(removedThreadId, nextThreadId, projectId) {
    if (!state.activeFileId) return false;
    state.activeThreadId = nextThreadId || null;
    if (fileFocus.returnThreadId === removedThreadId) {
      fileFocus.returnThreadId = nextThreadId || null;
    }
    var project = findProject(projectId);
    if (project) {
      project.lastActiveThreadId = nextThreadId || null;
      if (nextThreadId) {
        var nextThread = findThread(nextThreadId);
        if (nextThread) {
          if (typeof selectAgentControlWorktree === "function") selectAgentControlWorktree(project, nextThread.worktreePath);
          else project.selectedWorktreePath = nextThread.worktreePath;
        }
      }
    }
    return true;
  }

  function closeThread(id, options) {
    var thread = findThread(id);
    if (!thread || thread.closeStarted) return false;
    if (thread.kind === "git") {
      suspendGitRequests();
      stageGitSurface();
    }
    if (thread.kind === "web" && state.activeThreadId === id) {
      markActiveSurface("terminal");
    }
    thread.closeStarted = true;
    thread.closing = true;
    thread.metricsGeneration += 1;
    if (thread.metricsRefreshTimer) {
      clearTimeout(thread.metricsRefreshTimer);
      thread.metricsRefreshTimer = 0;
    }
    if (typeof noteStatusActivity === "function") noteStatusActivity();
    pendingDataBuffers.delete(id);
    // A set must never point at a thread that no longer exists, or scoping the
    // canvas to it would silently show fewer panes than it claims.
    forgetThreadInSets(id);
    var nextThreadId = detachThreadPane(thread);
    if (thread.kind !== "web" && thread.kind !== "git" && !thread.startInFlight) {
      stopThreadPty(thread);
    }
    if (thread.term && thread.term.dispose) {
      try { thread.term.dispose(); } catch (_) {}
    }
    var closingProjectId = thread.projectId;
    state.threads = state.threads.filter(function (t) { return t.id !== id; });
    if (state.activeThreadId === id) {
      // Prefer the next thread in the same project so closing a tab doesn't
      // teleport the user into a different project.
      state.activeThreadId = null;
      if (retainFileFocusAfterThreadRemoval(id, nextThreadId, closingProjectId)) {
        renderPaneWorkspace();
        if (!nextThreadId) setProjectStatus(findProject(closingProjectId), "");
      } else if (nextThreadId && (!options || options.focus !== false)) {
        focusThread(nextThreadId);
      } else {
        renderPaneWorkspace();
        setProjectStatus(findProject(closingProjectId), "");
      }
    } else {
      renderPaneWorkspace();
    }
    refreshSidebar();
    refreshTabs();
    return true;
  }

  function hideThread(id) {
    var thread = findThread(id);
    if (!thread || thread.hidden) return false;
    if (thread.kind === "git") suspendGitRequests();
    thread.metricsGeneration += 1;
    if (thread.metricsRefreshTimer) {
      clearTimeout(thread.metricsRefreshTimer);
      thread.metricsRefreshTimer = 0;
    }
    if (typeof noteStatusActivity === "function") noteStatusActivity();
    var nextThreadId = detachThreadPane(thread);
    thread.hidden = true;
    if (state.activeThreadId === id) {
      state.activeThreadId = null;
      if (!retainFileFocusAfterThreadRemoval(id, nextThreadId, thread.projectId) && nextThreadId) {
        focusThread(nextThreadId);
      }
    }
    renderPaneWorkspace();
    if (thread.kind === "git") stageGitSurface();
    refreshSidebar();
    refreshTabs();
    return true;
  }

  function reopenThread(id) {
    var thread = findThread(id);
    if (!thread || !thread.hidden) return false;
    var project = findProject(thread.projectId);
    if (state.activeProjectId !== thread.projectId || !project ||
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
    if (thread.kind !== "coven-chat" && thread.kind !== "coven-attach") {
      project.lastActiveThreadId = thread.id;
    }
    state.activeThreadId = thread.id;
    if (thread.kind === "git") revealGitPane(thread);
    renderPaneWorkspace();
    if (thread.kind === "git") renderGitSurface();
    refreshSidebar();
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
    if (launch && launch.launchKind === "coven-chat") {
      launch = covenChatLaunch(project || { root: launch.projectRoot }, thread.worktreePath || launch.cwd);
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
    return "Stop and close" + (thread && thread.name ? " " + thread.name : "");
  }

  /** Context actions are capability-based: tool panes never receive PTY actions. */
  function localSessionContextActions(thread, memberships, callbacks) {
    var isTool = threadIsToolPane(thread);
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
      if (thread.status !== "exited") {
        actions.push({ label: "Duplicate", run: callbacks.duplicate });
        actions.push({ label: "Interrupt", run: callbacks.interrupt });
      }
    }
    actions.push({ label: "Hide", run: callbacks.hide });
    actions.push({
      label: isTool ? sessionCloseLabel(thread) : "Stop and close",
      danger: true,
      run: callbacks.close,
    });
    return actions;
  }

  var sessionContextMenu = null;
  function closeSessionContextMenu() {
    if (sessionContextMenu && sessionContextMenu.parentNode) {
      sessionContextMenu.parentNode.removeChild(sessionContextMenu);
    }
    sessionContextMenu = null;
  }
  function openSessionContextMenu(event, actions) {
    event.preventDefault();
    event.stopPropagation();
    closeSessionContextMenu();
    var menu = document.createElement("div");
    menu.className = "session-context-menu";
    menu.setAttribute("role", "menu");
    menu.style.left = Math.max(8, event.clientX) + "px";
    menu.style.top = Math.max(8, event.clientY) + "px";
    actions.forEach(function (action) {
      if (!action) return;
      var item = document.createElement("button");
      item.type = "button";
      item.className = "session-context-item" + (action.danger ? " danger" : "");
      item.setAttribute("role", "menuitem");
      item.textContent = action.label;
      item.addEventListener("click", function () {
        closeSessionContextMenu();
        action.run();
      });
      menu.appendChild(item);
    });
    document.body.appendChild(menu);
    sessionContextMenu = menu;
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

  function fitVisiblePanes() {
    visiblePaneFitFrame = 0;
    if (!terminalHost || terminalHost.hidden) return;
    var layout = activePaneLayout();
    if (!layout || !layout.root) return;
    var projected = PsychePanes.layoutRects(
      effectivePaneRoot(layout),
      measuredTerminalHost(),
      PANE_MINIMUMS
    );
    projected.leaves.forEach(function (leaf) {
      var thread = findThread(leaf.threadId);
      if (!thread || !thread.fit) return;
      try { thread.fit.fit(); } catch (err) { console.warn("terminal pane fit failed", err); }
    });
  }

  function scheduleVisiblePaneFit() {
    if (visiblePaneFitFrame) return;
    visiblePaneFitFrame = requestAnimationFrame(fitVisiblePanes);
  }
  window.addEventListener("resize", function () {
    scheduleVisiblePaneFit();
    Promise.resolve(syncBrowserBounds()).catch(function () {});
    // Whether the strip overflows is a function of width, not of its contents.
    syncTabStripOverflow();
    syncSessionListScroll();
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
  var sessionListEl = document.getElementById("session-list");
  var sidebarFilesEl = document.getElementById("sidebar-files");
  if (sessionListEl) {
    sessionListEl.addEventListener("scroll", function () { syncSessionListScroll(); });
  }
  var sidebarTab = settings.sidebarTab;

  // The file tree renders lazily: switching to it is the only thing that has to
  // ask the filesystem, and the sessions rail should not pay for that.
  function setSidebarTab(name, options) {
    sidebarTab = name === "files" ? "files" : "sessions";
    if (sessionListEl) sessionListEl.hidden = sidebarTab !== "sessions";
    if (sidebarFilesEl) sidebarFilesEl.hidden = sidebarTab !== "files";
    Array.prototype.forEach.call(
      document.querySelectorAll("[data-sidebar-tab]"),
      function (btn) {
        var active = btn.dataset.sidebarTab === sidebarTab;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-selected", active ? "true" : "false");
      }
    );
    if (sidebarTab === "files") renderFilesPanel();
    settings.sidebarTab = sidebarTab;
    if (!options || options.persist !== false) saveSettings();
    return sidebarTab;
  }

  Array.prototype.forEach.call(
    document.querySelectorAll("[data-sidebar-tab]"),
    function (btn) {
      btn.addEventListener("click", function () {
        setSidebarTab(btn.dataset.sidebarTab);
      });
    }
  );

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
  var sessionSearchEl = document.getElementById("session-search");
  var sessionFilter = "";
  var sessionTypeFilter = settings.sessionFilter;
  var sessionTreeFocusKey = "";
  var sessionSearchRestoreKey = "";

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
    }).filter(Boolean);
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
      && thread.launch.launchKind === "coven-chat"
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
      && thread.launch.launchKind === "coven-chat"
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

  function armSessionClose(host, close, label, onConfirm) {
    disarmSessionClose();
    var expiresAt = Date.now() + SESSION_CLOSE_SECONDS * 1000;
    var confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "session-close-confirm";
    confirm.title = "Click to confirm — auto-cancels when the timer runs out";
    function paint() {
      var left = Math.ceil(Math.max(0, expiresAt - Date.now()) / 1000);
      confirm.textContent = "Close · " + left;
      confirm.setAttribute("aria-label", "Confirm closing " + label);
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

  function openCovenSession(project, session) {
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
        if (!(await activateProjectWorktree(
          project, existing.worktreePath
        ))) return null;
        existing = findCovenAttachment(project, session, existingId);
        if (!existing) return null;
        await waitForTerminalLayout();
        existing = findCovenAttachment(project, session, existingId);
        if (!existing) return null;
        if (existing.hidden && !reopenThread(existing.id)) return null;
        existing = findCovenAttachment(project, session, existingId);
        if (!existing || !(await focusThread(existing.id))) return null;
        return findCovenAttachment(project, session, existingId);
      });
    }

    var key = covenAttachKey(project, session);
    if (covenAttachInFlight.has(key)) return covenAttachInFlight.get(key);

    var opening = Promise.resolve().then(async function () {
      var worktree = covenWorktreeForSession(project, session);
      if (!worktree || !worktree.path) return null;
      if (!(await activateProjectWorktree(project, worktree.path))) return null;
      await waitForTerminalLayout();
      return createThread({
        project: project,
        name: session.title || "Coven " + session.id.slice(0, 8),
        kind: "coven-attach",
        command: state.env.coven_path,
        args: ["attach", session.id],
        projectRoot: project.root,
        cwd: session.cwd || worktree.path,
        worktreePath: worktree.path,
        launchKind: "coven-attach",
        covenSessionId: session.id,
        metricsProvider: session.harness || "coven",
      });
    }).finally(function () {
      covenAttachInFlight.delete(key);
    });
    covenAttachInFlight.set(key, opening);
    return opening;
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
    var group = document.createElement("section");
    group.className = "session-project session-group"
      + (options.current ? " is-current" : "");
    group.dataset.treeItem = "project";
    group.dataset.treeKey = projectModel.key;
    group.setAttribute("role", "treeitem");
    group.setAttribute("aria-level", "1");
    group.setAttribute("tabindex", options.tabindex);
    group.setAttribute("aria-expanded", projectModel.expanded ? "true" : "false");

    var head = document.createElement("div");
    head.className = "session-project-head session-group-head";
    var disclosure = createDisclosure(
      projectModel.title,
      projectModel.expanded,
      projectModel.autoExpanded
    );
    var title = document.createElement("span");
    title.className = "session-project-name";
    appendHighlightedText(title, projectModel.title, projectModel.titleMatches);
    if (options.current) {
      var current = document.createElement("span");
      current.className = "session-current-badge";
      current.textContent = "CURRENT";
      title.appendChild(current);
    }
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
    head.appendChild(disclosure);
    head.appendChild(title);
    head.appendChild(count);
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

  function renderSessionList() {
    if (!sessionListEl) return;
    if (editingContext && editingContext.surface === "sidebar") return;
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
    var activeTreeKey = (document.activeElement && document.activeElement.dataset
      ? document.activeElement.dataset.treeKey
      : "") || armedCloseTreeKey;
    var shouldRestoreTreeFocus = Boolean(activeTreeKey);
    if (activeTreeKey) sessionTreeFocusKey = activeTreeKey;
    var focusedKey = sessionTreeFocusKey;
    sessionListEl.setAttribute("role", "tree");
    sessionListEl.setAttribute(
      "aria-label",
      "Sessions by project, branch, and category"
    );
    if (setPicking) sessionListEl.setAttribute("aria-multiselectable", "true");
    else sessionListEl.removeAttribute("aria-multiselectable");
    sessionListEl.replaceChildren();

    var currentSearchQuery = sessionFilter;
    var needle = currentSearchQuery.trim().toLowerCase();
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
      var localRows = state.threads.filter(function (t) {
        return t.projectId === project.id && !t.hidden && !isDormantThread(t);
      });
      // This branch calls buildSidebarProjectModel instead of reaching for
      // buildProjectRailModel directly; the rail model still exists and
      // sidebar-model.mjs builds on it. The sidebar model also carries the
      // query/filter/selection that used to be applied afterwards here, which
      // is why the surrounding code reads projectModel.visibleCount rather than
      // filtering worktrees itself. main's covenAssignments argument survives the
      // swap: it hoists the assignment map out of the per-project loop, which
      // covenSessionsForProject would otherwise rebuild once per project.
      var remoteRows = covenSessionsForProject(project, covenAssignments);
      var projectModel = PsycheSessions.buildSidebarProjectModel({
        project: project,
        localSessions: localRows,
        covenSessions: remoteRows,
        query: currentSearchQuery,
        filter: sessionTypeFilter,
        selectedKey: selectedKey,
        now: now,
      });
      if (projectModel.visibleCount === 0) return;
      matched += projectModel.visibleCount;
      projectModels.push({ project: project, model: projectModel });
    });

    if (needle || sessionTypeFilter !== "all") {
      var summary = document.createElement("div");
      summary.className = "session-result-summary";
      summary.setAttribute("role", "status");
      summary.setAttribute("aria-live", "polite");
      var summaryText = document.createElement("span");
      summaryText.textContent = matched + (matched === 1 ? " session" : " sessions");
      var reset = document.createElement("button");
      reset.type = "button";
      reset.className = "session-result-reset";
      if (needle) {
        reset.textContent = "Clear search";
        reset.addEventListener("click", function () {
          sessionSearchEl.value = "";
          sessionFilter = "";
          renderSessionList();
          sessionSearchEl.focus();
        });
      } else {
        reset.textContent = "Reset filter";
        reset.addEventListener("click", function () {
          setSessionTypeFilter("all");
          var allFilter = document.querySelector('[data-session-filter="all"]');
          if (allFilter) allFilter.focus();
        });
      }
      summary.appendChild(summaryText);
      summary.appendChild(reset);
      sessionListEl.appendChild(summary);
    }

    projectModels.forEach(function (entry) {
      var project = entry.project;
      var projectModel = entry.model;
      var projectParts = createProjectGroup(projectModel, {
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
      projectParts.group.addEventListener("click", function (event) {
        if (!targetWithin(event, projectParts.head) ||
            targetWithin(event, projectParts.disclosure)) return;
        clearFocusSet();
        setActiveProject(project.id);
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
              label: "Open Coven Terminal",
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

            category.rows.forEach(function (rowModel) {
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
                settings.selectedSessionKey = rowModel.selectionKey;
                saveSettings();
                if (project.id !== state.activeProjectId &&
                    !(await setActiveProject(project.id))) return;
                applySetScopeForThread(thread);
                await focusThread(thread.id);
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
                    focus: function () { focusThread(thread.id); },
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
                armSessionClose(row, close, thread.name, function () {
                  return requestThreadClose(thread);
                });
              }
              close.addEventListener("click", function (event) {
                event.stopPropagation();
                armLocalClose();
              });
              row.appendChild(close);
              categoryGroup.appendChild(wrapper);
            });
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
      empty.textContent = needle
        ? "No sessions match “" + sessionFilter.trim() + "”"
        : sessionTypeFilter !== "all"
          ? "No sessions match the " + sessionTypeFilter + " filter."
          : state.projects.length
            ? "No sessions yet."
            : "No project open — ⌘O to add one.";
      sessionListEl.appendChild(empty);
    }

    var renderedItems = Array.prototype.slice.call(
      sessionListEl.querySelectorAll("[data-tree-item]")
    );
    var preferred = renderedItems.find(function (item) {
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
      if (shouldRestoreTreeFocus) preferred.focus();
    }
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

  if (sessionSearchEl) {
    sessionSearchEl.addEventListener("focus", function () {
      sessionSearchRestoreKey = sessionTreeFocusKey;
    });
    sessionSearchEl.addEventListener("input", function () {
      sessionFilter = sessionSearchEl.value || "";
      renderSessionList();
    });
    // Escape clears the filter rather than bubbling to the terminal.
    sessionSearchEl.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        sessionSearchEl.value = "";
        sessionFilter = "";
        renderSessionList();
        restoreSessionTreeFocus(sessionSearchRestoreKey);
      }
    });
  }
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
  document.addEventListener("keydown", function (event) {
    var target = event.target;
    var editing = target && (
      target.tagName === "INPUT" || target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" || target.isContentEditable
    );
    if (event.key === "/" && !editing && sidebarTab === "sessions") {
      event.preventDefault();
      sessionSearchRestoreKey = sessionTreeFocusKey;
      sessionSearchEl.focus();
      sessionSearchEl.select();
    }
  });
  setSidebarTab(settings.sidebarTab, { persist: false });
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
          '<span class="glyph">✳</span>Agent<span class="key">⌘P</span></button>' +
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

  async function removeProject(id) {
    var project = findProject(id);
    if (!project) return false;
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
    covenDiscovery = PsycheSessions.invalidateCovenRequests(covenDiscovery);
    // Close every thread that belongs to this project.
    var threadIds = state.threads
      .filter(function (t) { return t.projectId === id; })
      .map(function (t) { return t.id; });
    var closeResults = await Promise.all(threadIds.map(async function (tid) {
      var thread = findThread(tid);
      var closed = thread && thread.kind === "web" ? await closeBrowserPane(thread) : await Promise.resolve(closeThread(tid, { focus: false }));
      return { threadId: tid, closed: closed !== false };
    }));
    var failedCloses = closeResults.filter(function (result) { return !result.closed; });
    if (failedCloses.length) {
      if (typeof replayBrowserResources === "function") await replayBrowserResources(project.root).catch(function () {});
      var closedCount = closeResults.length - failedCloses.length;
      setStatus("project removal partially completed: " + closedCount + " pane(s) closed; " +
        failedCloses.length + " failed (" + failedCloses.map(function (result) { return result.threadId; }).join(", ") + "); project retained", "error");
      return false;
    }
    if (typeof invalidateAgentControlContext === "function") invalidateAgentControlContext();
    var providerStopError = null;
    if (typeof invoke === "function") {
      try { await invoke("control_provider_stop", { projectRoot: project.root }); }
      catch (error) { providerStopError = error; }
    }
    if (typeof browserControlProviders !== "undefined") {
      if (typeof resetBrowserControlProvider === "function") resetBrowserControlProvider(project.root);
      else delete browserControlProviders[project.root];
    }
    // Its file tabs go with it — they are scoped to the project.
    var dropped = state.openFiles.filter(function (f) { return f.projectId === id; });
    state.openFiles = state.openFiles.filter(function (f) { return f.projectId !== id; });
    var restoredTerminalView = false;
    if (dropped.some(function (f) { return f.id === state.activeFileId; })) {
      state.activeFileId = null;
      if (fileViewEl) fileViewEl.hidden = true;
      if (terminalHost) terminalHost.hidden = false;
      restoredTerminalView = true;
    }
    // Remove the project from state.
    state.projects = state.projects.filter(function (p) { return p.id !== id; });
    if (typeof invalidateAgentControlContext === "function") invalidateAgentControlContext();
    startCovenPolling();
    if (state.activeProjectId === id) {
      var next = state.projects[0] || null;
      // Force setActiveProject to do its restore work even though the id
      // matches — clear first.
      state.activeProjectId = null;
      if (next) {
        await setActiveProject(next.id);
      } else {
        state.activeThreadId = null;
        if (typeof stopAgentControlPolling === "function") stopAgentControlPolling("teardown");
        renderPaneWorkspace();
        setStatus("no project — click + to open one", "");
      }
    }
    refreshTabs();
    if (restoredTerminalView) syncPaneMetricsVisibility();
    syncProjectBrowser();
    saveWorkspaceSoon();
    if (providerStopError) setStatus("project removed after control provider stop failed: " + String(providerStopError), "warn");
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
  // ---- File tabs (main area) ----

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
      if (state.activeFileId && fileViewEl && !fileViewEl.hidden) fileEditor.focus();
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

  function fileFocusThreadIsAvailable(thread, root, project, workspaceRoot, allowCoven) {
    return !!thread &&
      !thread.hidden &&
      thread.projectId === project.id &&
      thread.worktreePath === workspaceRoot &&
      (allowCoven ||
        (thread.kind !== "coven-chat" && thread.kind !== "coven-attach")) &&
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

    var focused = layout.focusedLeafId
      ? PsychePanes.findLeafById(root, layout.focusedLeafId)
      : null;
    var focusedThread = focused ? findThread(focused.threadId) : null;
    if (fileFocusThreadIsAvailable(focusedThread, root, project, workspaceRoot, false)) {
      return focusedThread.id;
    }

    var leafIds = PsychePanes.leafIds(root);
    for (var i = 0; i < leafIds.length; i++) {
      var leaf = PsychePanes.findLeafById(root, leafIds[i]);
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
    terminalArea.classList.add("is-file-focused");
    fileViewEl.hidden = false;
    terminalHost.hidden = true;
    syncPaneMetricsVisibility();
    renderPaneMinimap(activePaneLayout(), file);
    return true;
  }

  function clearFileFocusPresentation() {
    state.activeFileId = null;
    fileFocus.returnThreadId = null;
    terminalArea.classList.remove("is-file-focused");
    fileViewEl.hidden = true;
    terminalHost.hidden = false;
    syncPaneMetricsVisibility();
  }

  function clearPassiveCovenPaneFocus(layout) {
    var activeThread = findThread(state.activeThreadId);
    if (activeThread &&
      (activeThread.kind === "coven-chat" || activeThread.kind === "coven-attach")) {
      state.activeThreadId = null;
    }
    layout = layout || activePaneLayout();
    if (!layout || !layout.root) return;
    if (layout.activeSetId) {
      var activeSet = findFocusSet(layout.activeSetId);
      var hasPassiveThread = activeSet && activeSet.threadIds.some(function (threadId) {
        var thread = findThread(threadId);
        return thread && !thread.hidden &&
          thread.kind !== "coven-chat" && thread.kind !== "coven-attach" &&
          !!PsychePanes.findLeafByThreadId(layout.root, threadId);
      });
      if (!hasPassiveThread) layout.activeSetId = null;
    }
    ["focusedLeafId", "maximizedLeafId"].forEach(function (key) {
      var leaf = layout[key] ? PsychePanes.findLeafById(layout.root, layout[key]) : null;
      var thread = leaf ? findThread(leaf.threadId) : null;
      if (thread && (thread.kind === "coven-chat" || thread.kind === "coven-attach")) {
        layout[key] = null;
      }
    });
  }

  async function returnFromFileFocus(explicitThreadId, maximizeDestination) {
    if (!state.activeFileId) return false;
    var activeFile = findOpenFile(state.activeFileId);
    var destinationId = resolveFileFocusThreadId(
      explicitThreadId || fileFocus.returnThreadId,
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
    renderPaneWorkspace();
    refreshSidebar();
    return true;
  }

  async function openFileTab(path, project) {
    project = project || activeProject();
    if (!project) return;
    var workspaceRoot = activeWorkspaceRoot(project);
    var existing = state.openFiles.filter(function (f) {
      return f.path === path && f.projectId === project.id;
    })[0];
    if (existing) return activateFileTab(existing.id);
    if (fileNavigationInFlight || fileDecisionInFlight) return false;
    fileNavigationInFlight = true;
    var canOpen;
    try {
      canOpen = await guardDirtyFile(findOpenFile(state.activeFileId));
    } finally {
      fileNavigationInFlight = false;
    }
    if (!canOpen) return false;

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
    enterFileFocus(file);
    markActiveSurface("terminal");
    refreshTabs();
    renderFileView();
    return true;
  }

  function revealFileForDecision(file) {
    if (!file || !findOpenFile(file.id)) return false;
    var project = findProject(file.projectId);
    if (project) {
      state.activeProjectId = project.id;
      var workspaceRoot = activeWorkspaceRoot(project);
      var threads = state.threads.filter(function (thread) {
        return thread.projectId === project.id && !thread.hidden &&
          thread.worktreePath === workspaceRoot &&
          thread.kind !== "coven-chat" && thread.kind !== "coven-attach";
      });
      var nextThreadId = project.lastActiveThreadId &&
        threads.some(function (thread) { return thread.id === project.lastActiveThreadId; })
          ? project.lastActiveThreadId
          : (threads[0] ? threads[0].id : null);
      state.activeThreadId = nextThreadId;
      clearPassiveCovenPaneFocus();
      renderPaneWorkspace();
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
      fileEditor.focus();
      return true;
    }
    if (fileNavigationInFlight || fileDecisionInFlight) return false;
    fileNavigationInFlight = true;
    var canActivate;
    try {
      canActivate = await guardDirtyFile(findOpenFile(state.activeFileId));
    } finally {
      fileNavigationInFlight = false;
    }
    if (!canActivate) return false;
    return activateFileTabNow(id);
  }

  // Hands the main area back to the terminal. Called whenever a session is
  // focused, so clicking a sidebar row always lands you on its terminal.
  async function showTerminalView() {
    if (!state.activeFileId) return true;
    if (fileNavigationInFlight || fileDecisionInFlight) return false;
    fileNavigationInFlight = true;
    var canShowTerminal;
    try {
      canShowTerminal = await guardDirtyFile(findOpenFile(state.activeFileId));
    } finally {
      fileNavigationInFlight = false;
    }
    if (!canShowTerminal) return false;
    clearFileFocusPresentation();
    clearPassiveCovenPaneFocus();
    renderPaneMinimap(activePaneLayout(), null);
    refreshTabs();
    requestAnimationFrame(function () { scheduleVisiblePaneFit(); });
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
    var siblings = projectFiles(file.projectId);
    var idx = siblings.indexOf(file);
    state.openFiles = state.openFiles.filter(function (f) { return f.id !== id; });
    if (state.activeFileId !== id) { refreshTabs(); return true; }
    var remaining = projectFiles(file.projectId);
    var next = remaining[Math.min(idx, remaining.length - 1)];
    if (next) activateFileTabNow(next.id);
    else {
      clearFileFocusPresentation();
      clearPassiveCovenPaneFocus();
      refreshTabs();
      renderPaneWorkspace();
    }
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
  function projectFiles(projectId) {
    var pid = projectId || state.activeProjectId;
    return state.openFiles.filter(function (f) { return f.projectId === pid; });
  }

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

  function refreshTabs() {
    if (editingContext && editingContext.surface === "tabs") return;
    tabStripEl.innerHTML = "";
    var files = projectFiles();

    // Left empty on purpose: `.tab-strip:empty` collapses the row so the pane
    // canvas owns the full height until a file is actually open.
    if (files.length === 0) return;

    files.forEach(function (file, idx) {
      var isActive = state.activeFileId === file.id;
      var tab = document.createElement("div");
      tab.className = "tab" + (isActive ? " active" : "");
      tab.dataset.fileId = file.id;
      tab.title = file.rel + (idx < 9 ? "  (\u2318" + (idx + 1) + ")" : "");
      // Dot and close share one 16px slot so revealing the close button on
      // hover cannot shift the strip sideways.
      tab.innerHTML =
        '<span class="label">' + escapeHtml(file.name) + "</span>" +
        '<span class="tab-end">' +
        (file.dirty ? '<span class="dot dirty-dot" title="Unsaved changes" aria-label="Unsaved changes"></span>' : "") +
        '<button class="close" title="Close file (\u2318W)" aria-label="Close ' +
        escapeHtml(file.name) + '">\u00d7</button>' +
        "</span>";
      tab.addEventListener("click", async function (e) {
        if (e.target.classList.contains("close")) return;
        await activateFileTab(file.id);
      });
      // Middle-click closes, the way every other tab strip behaves.
      tab.addEventListener("auxclick", async function (e) {
        if (e.button !== 1) return;
        e.preventDefault();
        await closeFileTab(file.id);
      });
      tab.querySelector(".close").addEventListener("click", async function (e) {
        e.stopPropagation();
        await closeFileTab(file.id);
      });
      tabStripEl.appendChild(tab);
    });
    syncTabStripOverflow();
    scrollActiveTabIntoView();
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
      desc: "Spawn a new Coven chat thread",
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
    var value = commandInput ? commandInput.value.trim() : "";
    if (composerSendEl) {
      composerSendEl.hidden = value.length === 0;
      composerSendEl.firstChild.textContent = value[0] === "/" ? "Run " : "Send ";
    }
    if (composerMicEl) composerMicEl.hidden = value.length > 0;
    if (composerSendHintEl) {
      composerSendHintEl.textContent = !value
        ? ""
        : value[0] === "/" ? "runs command"
        : value[0] === "!" ? "runs in the focused terminal"
        : value[0] === "%" ? "jumps to a pane"
        : "→ focused pane";
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
    noteThreadInput(thread, text);
    var bytes = Array.from(new TextEncoder().encode(text));
    return invoke("pty_write", {
      threadId: thread.id,
      thread_id: thread.id,
      bytes: bytes,
    }).then(function () {
      return true;
    }).catch(function (err) {
      if (thread.term) {
        thread.term.write("\r\n\x1b[31m[pty_write]\x1b[0m " + err + "\r\n");
      }
      return false;
    });
  }
  function writeToActive(text) {
    var thread = findThread(state.activeThreadId);
    if (thread && thread.term) thread.term.write(text);
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

  var PALETTE_SIGILS = "/!%";

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

  function paletteCorpus(sigil, rest) {
    if (sigil === "%") return panePaletteEntries();
    if (sigil === "!") return shellPaletteEntries(rest);
    return recentPaletteEntries().concat(builtinPaletteEntries(), agentSkillPaletteEntries());
  }

  function openPalette(query, force) {
    var raw = (query || commandInput.value).trim();
    var sigil = raw[0] || "/";
    if (!force && PALETTE_SIGILS.indexOf(commandInput.value.trim()[0]) === -1) {
      hidePalette();
      return;
    }
    if (PALETTE_SIGILS.indexOf(sigil) === -1) sigil = "/";
    var rest = raw.slice(1).trim();
    var q = sigil === "/" ? raw.toLowerCase() : rest.toLowerCase();
    paletteFiltered = paletteCorpus(sigil, rest).filter(function (c) {
      if (c.pinned) return true;
      var hay = (c.cmd + " " + (c.desc || "") + " " + (c.badge || "")).toLowerCase();
      return c.cmd.toLowerCase().indexOf(q) === 0 || hay.indexOf(q) !== -1;
    });
    if (paletteFiltered.length === 0) {
      hidePalette();
      return;
    }
    paletteIndex = Math.min(paletteIndex, paletteFiltered.length - 1);
    renderPalette();
    paletteEl.hidden = false;
    paletteVisible = true;
  }
  function hidePalette() {
    paletteEl.hidden = true;
    paletteVisible = false;
    paletteIndex = 0;
  }
  function runPalettePick(pick, mode) {
    if (!pick) return;
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
    paletteEl.innerHTML = "";
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
      div.className =
        "palette-item palette-" + c.kind + (idx === paletteIndex ? " active" : "");
      div.innerHTML =
        '<span class="cmd">' + escapeHtml(c.cmd) + "</span>" +
        '<span class="desc">' +
          (c.desc ? escapeHtml(c.desc) : "") +
          (c.badge ? '<span class="badge">' + escapeHtml(c.badge) + "</span>" : "") +
        "</span>" +
        '<span class="hint-key">' + escapeHtml(c.hint || "↵") + "</span>";
      div.addEventListener("click", function () { runPalettePick(c); });
      paletteEl.appendChild(div);
    });
    ensurePaletteActiveVisible();
  }

  commandInput.addEventListener("input", function () {
    if (PALETTE_SIGILS.indexOf(commandInput.value.trim()[0]) !== -1) openPalette();
    else hidePalette();
    syncComposerChrome();
  });
  commandInput.addEventListener("keydown", function (e) {
    if (paletteVisible) {
      if (e.key === "ArrowDown") {
        paletteIndex = (paletteIndex + 1) % paletteFiltered.length;
        renderPalette(); e.preventDefault(); return;
      }
      if (e.key === "ArrowUp") {
        paletteIndex = (paletteIndex - 1 + paletteFiltered.length) % paletteFiltered.length;
        renderPalette(); e.preventDefault(); return;
      }
      if (e.key === "Tab") {
        var pick = paletteFiltered[paletteIndex];
        if (pick.kind === "recent") commandInput.value = pick.cmd;
        else commandInput.value = pick.cmd + (pick.kind === "agent" ? "" : " ");
        hidePalette();
        e.preventDefault();
        return;
      }
      if (e.key === "Escape") { hidePalette(); e.preventDefault(); return; }
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
    if (!tab) return { closing: false, generation: 0, invalidationGeneration: 0, navigationTail: null, nativeLabel: null, pendingGeneration: 0, pendingUrl: null, liveGeneration: 0, liveUrl: null, eventUrl: null, viewLive: false, navigationSnapshot: null, controlGeneration: 0, controlLabel: null, publicationSequence: 0, publicationTail: null, nativeBounds: null, documentId: null, documentSequence: 0 };
    var lifecycle = browserTabLifecycleStates.get(tab);
    if (!lifecycle) {
      lifecycle = { closing: false, generation: 0, invalidationGeneration: 0, navigationTail: null, nativeLabel: null, pendingGeneration: 0, pendingUrl: null, liveGeneration: 0, liveUrl: null, eventUrl: null, viewLive: tab.created === true, navigationSnapshot: null, controlGeneration: 0, controlLabel: null, publicationSequence: 0, publicationTail: null, nativeBounds: null, documentId: null, documentSequence: 0 };
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
    lifecycle.eventUrl = null;
    lifecycle.navigationSnapshot = null;
    return lifecycle.generation;
  }
  function browserNavigationIsCurrent(context) {
    if (!context || browserTabIsClosing(context.tab) || browserPaneIsClosing(context.pane)) return false;
    if (browserTabLifecycle(context.tab).generation !== context.generation) return false;
    if (context.browser.tabs.indexOf(context.tab) === -1) return false;
    if (ensureBrowserModel(context.project, context.worktreePath) !== context.browser) return false;
    if (findThread(context.pane.id) !== context.pane) return false;
    return findBrowserPane(context.project.id, context.worktreePath) === context.pane;
  }
  function browserNavigationOwnsVisiblePane(context) {
    if (!context || !context.project || state.activeProjectId !== context.project.id) return false;
    var project = activeProject();
    if (!project || project !== context.project || project.id !== context.project.id ||
        activeWorkspaceRoot(project) !== context.worktreePath) return false;
    if (findThread(context.pane.id) !== context.pane ||
        findBrowserPane(context.project.id, context.worktreePath) !== context.pane ||
        browserPaneIsClosing(context.pane) || context.pane.hidden) return false;
    return !!visibleBrowserBounds();
  }
  async function discardObsoleteBrowserNavigation(context) {
    invalidateBrowserNavigation(context.tab);
    var lifecycle = browserTabLifecycle(context.tab);
    lifecycle.nativeLabel = null;
    lifecycle.liveGeneration = 0;
    lifecycle.liveUrl = null;
    lifecycle.viewLive = false;
    try {
      await invoke("browser_destroy", { tabId: context.tab.id });
    } catch (error) {
      setStatus("obsolete browser navigation cleanup failed for " + context.label + ": " + String(error), "error");
      return false;
    }
    if (context.browser.tabs.indexOf(context.tab) !== -1) {
      context.tab.created = false;
      context.tab.loading = false;
      context.tab.title = context.previousTitle;
      syncProjectBrowser();
      saveWorkspaceSoon();
    }
    return true;
  }
  function nativeBrowserLabel(raw) {
    var safe = String(raw || "default").split("").filter(function (c) {
      return /[A-Za-z0-9_-]/.test(c);
    }).join("").slice(0, 64) || "default";
    return "psyche-browser-" + safe;
  }
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
  function browserNativeEventContext(nativeLabel, url) {
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
    var hasPendingNavigation = lifecycle.pendingGeneration > 0;
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
  function markBrowserTabLoaded(nativeLabel, url, title) {
    var pair = browserNativeEventContext(nativeLabel, url);
    if (!pair) return false;
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
  function boundedBrowserResourceText(value, limit) {
    var text = String(value || "");
    if (typeof TextEncoder === "undefined" || new TextEncoder().encode(text).byteLength <= limit) return text.slice(0, limit);
    var low = 0; var high = text.length;
    while (low < high) {
      var middle = Math.ceil((low + high) / 2);
      if (new TextEncoder().encode(text.slice(0, middle)).byteLength <= limit) low = middle;
      else high = middle - 1;
    }
    if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1])) low -= 1;
    return text.slice(0, low);
  }
  function browserResource(pair) {
    if (!pair || !pair.project || !pair.tab) return null;
    var lifecycle = browserTabLifecycle(pair.tab);
    var bounds = lifecycle.nativeBounds || { w: 0, h: 0 };
    return { id: pair.tab.id, kind: "browser_tab", generation: lifecycle.controlGeneration || 0,
      projectRoot: pair.project.root, worktreeRoot: pair.worktreePath,
      providerId: "", webviewLabel: lifecycle.nativeLabel,
      url: boundedBrowserResourceText(pair.tab.url || "about:blank", 2048),
      title: boundedBrowserResourceText(pair.tab.title || "New tab", 512),
      loading: !!pair.tab.loading, viewport: { width: Math.max(0, Math.round(bounds.w)), height: Math.max(0, Math.round(bounds.h)) } };
  }
  var browserControlProviders = {};
  var browserControlReplayNeeded = {};
  function resetBrowserControlProvider(projectRoot) {
    delete browserControlProviders[projectRoot];
    var project = activeProject();
    if (project && project.root === projectRoot && typeof invalidateAgentControlContext === "function") {
      invalidateAgentControlContext();
    }
  }
  function ensureBrowserControlProvider(projectRoot) {
    if (!browserControlProviders[projectRoot]) {
      browserControlReplayNeeded[projectRoot] = true;
      browserControlProviders[projectRoot] = invoke("control_provider_start", { projectRoot: projectRoot })
        .then(function (provider) {
          return provider;
        })
        .catch(function (error) {
          if (typeof resetBrowserControlProvider === "function") resetBrowserControlProvider(projectRoot);
          else delete browserControlProviders[projectRoot];
          throw error;
        });
    }
    return browserControlProviders[projectRoot];
  }
  async function replayBrowserResources(projectRoot, excludeTab) {
    var project = state.projects.find(function (candidate) { return candidate.root === projectRoot; });
    if (!project) return false;
    var pairs = [];
    Object.keys(project.browsersByWorktree || {}).forEach(function (worktreePath) {
      var browser = project.browsersByWorktree[worktreePath];
      browser.tabs.forEach(function (tab) {
        if (tab !== excludeTab && tab.created && browserTabLifecycle(tab).nativeLabel && !browserTabIsClosing(tab)) {
          pairs.push({ project: project, worktreePath: worktreePath, browser: browser, tab: tab });
        }
      });
    });
    await Promise.all(pairs.map(function (pair) { return publishBrowserResource(pair); }));
    return true;
  }
  function publishBrowserResource(pair) {
    var resource = browserResource(pair); if (!resource || !resource.webviewLabel) return Promise.resolve({ status: "deferred" });
    var lifecycle = browserTabLifecycle(pair.tab);
    var publicationSequence = ++lifecycle.publicationSequence;
    var label = resource.webviewLabel;
    var run = function () {
      if (lifecycle.closing || lifecycle.nativeLabel !== label) return { status: "deferred" };
      if (publicationSequence !== lifecycle.publicationSequence) return { status: "superseded" };
      var upsert = function (retry) {
        return ensureBrowserControlProvider(pair.project.root).then(function (provider) {
          resource.providerId = provider.providerId;
          return invoke("control_provider_upsert", { projectRoot: pair.project.root, resource: resource });
        }).catch(function (error) {
          if (typeof resetBrowserControlProvider === "function") resetBrowserControlProvider(pair.project.root);
          else delete browserControlProviders[pair.project.root];
          if (retry) return upsert(false);
          throw error;
        });
      };
      return upsert(true).then(async function (canonical) {
        if (lifecycle.closing || lifecycle.nativeLabel !== label) return { status: "deferred" };
        if (publicationSequence !== lifecycle.publicationSequence) return { status: "superseded" };
        if (!canonical || canonical.webviewLabel !== label) return { status: "deferred" };
        await invoke("browser_bind_control_generation", { tabId: pair.tab.id, generation: canonical.generation });
        lifecycle.controlGeneration = canonical.generation;
        lifecycle.controlLabel = canonical.webviewLabel;
        if (browserControlReplayNeeded[pair.project.root]) {
          browserControlReplayNeeded[pair.project.root] = false;
          await replayBrowserResources(pair.project.root, pair.tab);
        }
        return { status: "published", generation: canonical.generation };
      }, function (error) {
        if (typeof resetBrowserControlProvider === "function") resetBrowserControlProvider(pair.project.root);
        else delete browserControlProviders[pair.project.root];
        lifecycle.controlGeneration = 0;
        lifecycle.controlLabel = null;
        setTimeout(function () {
          if (!lifecycle.closing && lifecycle.nativeLabel === label) publishBrowserResource(pair).catch(function () {});
        }, 250);
        return { status: "deferred", error: String(error) };
      });
    };
    var publication = lifecycle.publicationTail ? lifecycle.publicationTail.then(run, run) : run();
    lifecycle.publicationTail = publication.then(function () {}, function () {});
    return publication;
  }
  function removeBrowserResource(project, tab) {
    if (!project || !tab) return Promise.resolve(false);
    var remove = function (retry) {
      return invoke("control_provider_remove", { projectRoot: project.root, tabId: tab.id })
        .catch(async function (error) {
          var message = String(error).trim().replace(/^Error:\s*/, "");
          if (message === "browser resource is not registered") return { removed: true };
          if (typeof resetBrowserControlProvider === "function") resetBrowserControlProvider(project.root);
          else delete browserControlProviders[project.root];
          if (retry) {
            await ensureBrowserControlProvider(project.root);
            await replayBrowserResources(project.root);
            return remove(false);
          }
          var lifecycle = browserTabLifecycle(tab);
          lifecycle.controlGeneration = 0;
          lifecycle.controlLabel = null;
          return false;
        });
    };
    return remove(true).then(function (result) { return result !== false; });
  }
  function invalidateBrowserAutomation(tab) {
    var lifecycle = browserTabLifecycle(tab);
    lifecycle.documentId = null;
    lifecycle.documentSequence += 1;
    if (!lifecycle.nativeLabel || !lifecycle.controlGeneration) return Promise.resolve(false);
    return invoke("browser_action", { request: { tabId: tab.id, generation: lifecycle.controlGeneration,
      snapshotId: "", expectedRisk: {}, action: { kind: "invalidate" } } }).then(function () { return true; });
  }
  function queueBrowserAutomationInvalidation(pair) {
    var lifecycle = browserTabLifecycle(pair.tab);
    lifecycle.invalidationGeneration += 1;
    var run = function () { return invalidateBrowserAutomation(pair.tab); };
    var invalidation = lifecycle.navigationTail ? lifecycle.navigationTail.then(run, run) : run();
    lifecycle.navigationTail = invalidation.then(function () {}, function () {});
    return invalidation;
  }
  function installBrowserAutomationCompatibility(pair) {
    var lifecycle = browserTabLifecycle(pair.tab);
    if (!lifecycle.nativeLabel) return Promise.resolve(false);
    return invoke("browser_install_automation", { tabId: pair.tab.id, generation: lifecycle.generation })
      .then(function () { return true; }, function () { return false; });
  }
  function validatePendingBrowserInspection(pending) {
    var lifecycle = browserTabLifecycle(pending.pair.tab);
    if (lifecycle.closing || lifecycle.nativeLabel !== pending.label || lifecycle.controlLabel !== pending.label ||
        lifecycle.controlGeneration !== pending.generation || lifecycle.documentId !== pending.documentId ||
        !pending.documentId || (pending.snapshotId && !String(pending.snapshotId))) throw new Error("snapshot_stale");
    return lifecycle;
  }
  async function queueBrowserInspection(pair, request) {
    var lifecycle = browserTabLifecycle(pair.tab);
    var run = async function () {
      if (lifecycle.publicationTail) await lifecycle.publicationTail;
      var pending = { pair: pair, label: request.label, generation: request.generation,
        documentId: lifecycle.documentId, snapshotId: null };
      validatePendingBrowserInspection(pending);
      var inspected = await invoke("browser_inspect", { request: { tabId: pair.tab.id,
        generation: request.generation, documentId: pending.documentId } });
      var snapshot;
      try { snapshot = JSON.parse(inspected.snapshotJson); } catch (_) { throw new Error("invalid_snapshot"); }
      pending.snapshotId = snapshot.snapshotId;
      validatePendingBrowserInspection(pending);
      if (!request.includeScreenshot) return snapshot;
      var screenshot = await invoke("browser_snapshot", { tabId: pair.tab.id, generation: request.generation });
      if (screenshot.navigationEpoch !== inspected.navigationEpoch ||
          screenshot.navigationUrl !== inspected.navigationUrl) throw new Error("snapshot_stale");
      validatePendingBrowserInspection(pending);
      return { snapshot: snapshot, screenshot: screenshot };
    };
    var inspection = lifecycle.navigationTail ? lifecycle.navigationTail.then(run, run) : run();
    lifecycle.navigationTail = inspection.then(function () {}, function () {});
    return inspection;
  }
  function providerBrowserError(code, message) {
    var error = new Error(message); error.code = code; return error;
  }
  async function queueBrowserProviderNavigation(pair, operation) {
    var lifecycle = browserTabLifecycle(pair.tab);
    var run = async function () {
      if (lifecycle.closing || lifecycle.controlGeneration <= 0 ||
          lifecycle.controlLabel !== lifecycle.nativeLabel) throw providerBrowserError("snapshot_stale", "browser tab is stale");
      var url = operation.kind === "navigate" ? normaliseUrl(operation.url) : null;
      var historyIndex = pair.tab.historyIndex;
      if (operation.kind === "back") historyIndex -= 1;
      if (operation.kind === "forward") historyIndex += 1;
      if (operation.kind === "back" || operation.kind === "forward") url = pair.tab.history[historyIndex];
      if (!url) throw providerBrowserError("invalid_action", "browser navigation target is unavailable");
      var bounds = lifecycle.nativeBounds || { x: -10000, y: -10000, w: 1, h: 1 };
      await invalidateBrowserAutomation(pair.tab);
      await invoke("browser_navigate", { tabId: pair.tab.id, generation: lifecycle.controlGeneration,
        label: browserLabelForTab(pair.project, pair.tab), url: url,
        x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h });
      pair.tab.created = true; pair.tab.loading = true; pair.tab.url = url; pair.tab.title = tabTitle(url);
      lifecycle.liveUrl = url; lifecycle.eventUrl = null; lifecycle.documentId = null;
      if (operation.kind === "back" || operation.kind === "forward") pair.tab.historyIndex = historyIndex;
      else { pair.tab.history = pair.tab.history.slice(0, pair.tab.historyIndex + 1); pair.tab.history.push(url);
        pair.tab.historyIndex = pair.tab.history.length - 1; }
      saveWorkspaceSoon();
      await publishBrowserResource(pair);
      return { url: url, title: pair.tab.title };
    };
    var navigation = lifecycle.navigationTail ? lifecycle.navigationTail.then(run, run) : run();
    lifecycle.navigationTail = navigation.then(function () {}, function () {});
    return navigation;
  }
  async function queueBrowserProviderAction(pair, request) {
    var action = request.operation.action || {};
    var lifecycle = browserTabLifecycle(pair.tab);
    var invalidationGeneration = lifecycle.invalidationGeneration;
    if (["upload", "download", "permission_response"].includes(action.kind)) {
      throw providerBrowserError("backend_unavailable", action.kind + " native interception is unavailable");
    }
    var pane = findBrowserPane(pair.project.id, pair.worktreePath);
    if (!pane || browserPaneIsClosing(pane)) throw providerBrowserError("provider_unavailable", "browser pane is unavailable");
    if (action.kind === "reload") return queueBrowserReload(pair.project, pair.tab, pane).then(function (ok) {
      if (!ok) throw providerBrowserError("backend_unavailable", "browser reload failed");
      return { url: pair.tab.url || "", title: pair.tab.title || "" };
    });
    if (action.kind === "close") {
      var closeRun = async function () {
        if (!(await closeBrowserTab(pair.project, pair.tab.id, pair.worktreePath))) {
          throw providerBrowserError("backend_unavailable", "browser close failed");
        }
        return { closed: true };
      };
      var closePending = lifecycle.navigationTail ? lifecycle.navigationTail.then(closeRun, closeRun) : closeRun();
      lifecycle.navigationTail = closePending.then(function () {}, function () {});
      return closePending;
    }
    if (["navigate", "back", "forward"].includes(action.kind)) return queueBrowserProviderNavigation(pair, action);
    if (action.kind === "screenshot") return invoke("browser_snapshot", {
      tabId: pair.tab.id, generation: request.generation,
    });
    var run = async function () {
      if (!request.operation.snapshotId || lifecycle.closing ||
          lifecycle.invalidationGeneration !== invalidationGeneration ||
          lifecycle.controlGeneration !== request.generation || lifecycle.controlLabel !== lifecycle.nativeLabel) {
        throw providerBrowserError("snapshot_stale", "browser action binding is stale");
      }
      var nativeAction = {};
      Object.keys(action).forEach(function (key) { if (key !== "semantic") nativeAction[key] = action[key]; });
      return invoke("browser_action", { request: { tabId: pair.tab.id, generation: request.generation,
        snapshotId: request.operation.snapshotId, expectedRisk: request.operation.expectedRisk || {}, action: nativeAction } });
    };
    var pending = lifecycle.navigationTail ? lifecycle.navigationTail.then(run, run) : run();
    lifecycle.navigationTail = pending.then(function () {}, function () {});
    return pending;
  }
  async function queueBrowserProviderResolve(pair, request) {
    var operation = request.operation;
    var lifecycle = browserTabLifecycle(pair.tab);
    var run = function () {
      if (!operation.snapshotId || !operation.elementRef || lifecycle.closing ||
          lifecycle.controlGeneration !== request.generation || lifecycle.controlLabel !== lifecycle.nativeLabel) {
        throw providerBrowserError("snapshot_stale", "browser element binding is stale");
      }
      return invoke("browser_action", { request: { tabId: pair.tab.id, generation: request.generation,
        snapshotId: operation.snapshotId, action: { kind: "resolve", elementRef: operation.elementRef,
          actionKind: operation.actionKind } } });
    };
    var pending = lifecycle.navigationTail ? lifecycle.navigationTail.then(run, run) : run();
    lifecycle.navigationTail = pending.then(function () {}, function () {});
    return pending;
  }
  var BROWSER_PROVIDER_FAILURE_CODES = new Set([
    "approval_identity_mismatch", "snapshot_stale", "element_missing", "element_disabled",
    "element_hidden", "invalid_action", "backend_unavailable", "invalid_snapshot",
    "unsupported_operation", "result_too_large", "effect_unknown", "action_failed",
  ]);
  function browserProviderFailureCode(error) {
    var candidate = error && typeof error.code === "string" ? error.code :
      String(error && error.message || error || "");
    return BROWSER_PROVIDER_FAILURE_CODES.has(candidate) ? candidate : "action_failed";
  }
  function handleBrowserProviderEffect(event) {
    var payload = event.payload || {}; var operation = payload.operation || {};
    if (operation.kind !== "inspect" && operation.kind !== "action" && operation.kind !== "resolve") return false;
    var pair = state.projects.reduce(function (found, project) {
      if (found || project.root !== payload.projectRoot) return found; var roots = Object.keys(project.browsersByWorktree || {});
      for (var i = 0; i < roots.length; i++) { var browser = project.browsersByWorktree[roots[i]];
        var tab = browser.tabs.find(function (candidate) { return candidate.id === payload.tabId; });
        if (tab) return { project: project, worktreePath: roots[i], browser: browser, tab: tab }; }
      return null;
    }, null);
    if (!pair || pair.tab.id !== payload.tabId) {
      invoke("control_provider_complete", { projectRoot: payload.projectRoot, requestId: payload.requestId,
        result: { actionId: payload.actionId, status: "failed", code: "provider_unavailable", message: "exact browser tab is unavailable" } }).catch(function () {});
      return false;
    }
    var lifecycle = browserTabLifecycle(pair.tab);
    // lifecycle.generation !== payload.generation is intentionally not the trust boundary;
    // the provider-returned control generation is authoritative.
    if (lifecycle.controlGeneration !== payload.generation || lifecycle.controlLabel !== lifecycle.nativeLabel) {
      invoke("control_provider_complete", { projectRoot: payload.projectRoot, requestId: payload.requestId,
        result: { actionId: payload.actionId, status: "failed", code: "snapshot_stale", message: "browser tab generation is stale" } }).catch(function () {});
      return false;
    }
    var effect = operation.kind === "inspect"
      ? queueBrowserInspection(pair, { requestId: payload.requestId, generation: payload.generation,
        label: lifecycle.nativeLabel, includeScreenshot: operation.includeScreenshot === true })
      : operation.kind === "resolve" ? queueBrowserProviderResolve(pair, payload) : queueBrowserProviderAction(pair, payload);
    effect.then(function (value) {
      var completedSnapshot = value && value.snapshot ? value.snapshot : value;
      var completionLifecycle = browserTabLifecycle(pair.tab);
      if (operation.kind === "inspect" && (!completedSnapshot || completionLifecycle.closing || completionLifecycle.nativeLabel !== lifecycle.nativeLabel ||
          completionLifecycle.controlLabel !== lifecycle.nativeLabel || completionLifecycle.controlGeneration !== payload.generation ||
          completionLifecycle.documentId !== completedSnapshot.documentId)) throw new Error("snapshot_stale");
      return invoke("control_provider_complete", { projectRoot: pair.project.root, requestId: payload.requestId,
        result: { actionId: payload.actionId, status: "succeeded", value: value } });
    }).catch(function (error) {
      invoke("control_provider_complete", { projectRoot: pair.project.root, requestId: payload.requestId,
        result: { actionId: payload.actionId, status: "failed",
          code: browserProviderFailureCode(error),
          message: String(error) } }).catch(function () {});
    }); return true;
  }
  function handleBrowserPageLoad(event) {
    var payload = event.payload || {};
    var pair = browserNativeEventContext(payload.label, payload.url);
    if (!pair) return false;
    if (payload.phase === "started") {
      if (typeof queueBrowserAutomationInvalidation === "function") queueBrowserAutomationInvalidation(pair);
      pair.tab.loading = true;
    } else if (payload.phase === "finished") {
      var loaded = markBrowserTabLoaded(payload.label, payload.url, "");
      var lifecycle = typeof browserTabLifecycle === "function" ? browserTabLifecycle(pair.tab) : null;
      if (lifecycle) lifecycle.documentId = lifecycle.nativeLabel + ":" + (++lifecycle.documentSequence) + ":" +
        (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "document");
      var installed = lifecycle && typeof installBrowserAutomationCompatibility === "function"
        ? installBrowserAutomationCompatibility(pair) : Promise.resolve(true);
      // queueBrowserInspection is dispatched only for a provider effect, never as a synthetic load inspection.
      if (typeof publishBrowserResource === "function") installed.then(function () {
        return publishBrowserResource(pair);
      }).catch(function (error) { setStatus("browser resource publish failed: " + String(error), "error"); });
      return loaded;
    } else {
      return false;
    }
    if (pair.project.id === state.activeProjectId &&
        activeWorkspaceRoot(pair.project) === pair.worktreePath) {
      renderBrowserTabs(); updateBrowserControls();
    }
    if (typeof publishBrowserResource === "function") publishBrowserResource(pair)
      .catch(function (error) { setStatus("browser resource publish failed: " + String(error), "error"); });
    return true;
  }
  function handleBrowserTitle(event) {
    var payload = event.payload || {};
    var loaded = markBrowserTabLoaded(payload.label, payload.url, payload.title);
    if (loaded && typeof publishBrowserResource === "function") {
      var pair = browserTabForNativeLabel(payload.label);
      if (pair) publishBrowserResource(pair)
        .catch(function (error) { setStatus("browser resource publish failed: " + String(error), "error"); });
    }
    return loaded;
  }
  listen("browser:page-load", handleBrowserPageLoad).catch(function () {});
  listen("control:provider-effect-request", handleBrowserProviderEffect).catch(function () {});
  listen("browser:title", handleBrowserTitle).catch(function () {});
  listen("browser:focus", function (event) {
    markActiveSurface("browser");
    var payload = event.payload || {};
    var pair = browserTabForNativeLabel(payload.label);
    var pane = pair && findBrowserPane(pair.project.id, pair.worktreePath);
    if (pane && state.activeThreadId !== pane.id) focusThread(pane.id);
    if (pair && typeof syncBrowserBounds === "function") syncBrowserBounds().catch(function () {});
  }).catch(function () {});
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
  function createBrowserTab(project, url, activate) {
    project = project || activeProject();
    var worktreePath = activeWorkspaceRoot(project);
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
  async function closeBrowserTab(project, tabId, exactWorktreePath) {
    project = project || activeProject();
    var browser = ensureBrowserModel(project, exactWorktreePath); if (!browser) return false;
    var idx = browser.tabs.findIndex(function (t) { return t.id === tabId; }); if (idx < 0) return false;
    var tab = browser.tabs[idx];
    var lifecycle = browserTabLifecycle(tab);
    if (lifecycle.closing) return false;
    lifecycle.closing = true;
    lifecycle.publicationSequence += 1;
    if (lifecycle.publicationTail) await lifecycle.publicationTail;
    invalidateBrowserNavigation(tab);
    if (typeof invalidateBrowserAutomation === "function") await invalidateBrowserAutomation(tab);
    try {
      await invoke("browser_destroy", { tabId: tab.id });
    } catch (error) {
      lifecycle.closing = false;
      lifecycle.documentId = lifecycle.nativeLabel + ":" + (++lifecycle.documentSequence) + ":" +
        (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "recovered");
      if (typeof installBrowserAutomationCompatibility === "function") await installBrowserAutomationCompatibility({
        project: project, worktreePath: activeWorkspaceRoot(project), browser: browser, tab: tab }).catch(function () {});
      if (typeof publishBrowserResource === "function") await publishBrowserResource({ project: project,
        worktreePath: activeWorkspaceRoot(project), browser: browser, tab: tab }).catch(function () {});
      setStatus("browser tab close failed: " + String(error), "error");
      return false;
    }
    if (typeof removeBrowserResource === "function") await removeBrowserResource(project, tab);
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
        tab.created || !tab.url) return false;
    var navigated = await navigateBrowser(tab.url, { tabId: tab.id, preserveHistory: true });
    pane = project && findBrowserPane(project.id, worktreePath);
    if (typeof publishBrowserResource === "function") await publishBrowserResource({ project: project,
      worktreePath: worktreePath, browser: ensureBrowserModel(project, worktreePath), tab: tab });
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
    markActiveSurface("browser");
    browser.activeTabId = tabId;
    renderBrowserTabs();
    if (tab.created && typeof syncBrowserBounds === "function") await syncBrowserBounds();
    if (tab.created && typeof publishBrowserResource === "function") await publishBrowserResource({ project: project,
      worktreePath: activeWorkspaceRoot(project), browser: browser, tab: tab });
    if (!tab.created) syncProjectBrowser();
    saveWorkspaceSoon();
    if (!tab.created) await restoreDormantBrowserTab(project, tab);
    pane = findBrowserPane(project.id, activeWorkspaceRoot(project));
    return browser.tabs.indexOf(tab) !== -1 && !browserTabIsClosing(tab) &&
      !browserPaneIsClosing(pane);
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
    if (tab && !tab.created) await restoreDormantBrowserTab(project, tab);
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
  function syncProjectBrowser() { renderBrowserTabs(); Promise.resolve(syncBrowserBounds()).catch(function () {}); }
  var browserBoundsSyncTail = Promise.resolve();
  function queueBrowserBoundsSync(run) {
    var pending = browserBoundsSyncTail.then(run, run);
    browserBoundsSyncTail = pending.catch(function (error) {
      setStatus("browser bounds sync failed: " + String(error), "error");
    });
    return pending;
  }
  function syncBrowserBounds() { return queueBrowserBoundsSync(applyBrowserBoundsSync); }
  async function applyBrowserBoundsSync() {
    var project = activeProject(); var tab = currentBrowserTab(project); var label = tab ? browserLabelForTab(project, tab) : null; var b = visibleBrowserBounds();
    var allPairs = [];
    var projects = typeof state !== "undefined" && state.projects ? state.projects : (project ? [project] : []);
    projects.forEach(function (candidateProject) {
      Object.keys(candidateProject.browsersByWorktree || {}).forEach(function (worktreePath) {
        var candidateBrowser = candidateProject.browsersByWorktree[worktreePath];
        candidateBrowser.tabs.forEach(function (candidate) {
          if (candidate.created) allPairs.push({ project: candidateProject, worktreePath: worktreePath,
            browser: candidateBrowser, tab: candidate });
        });
      });
    });
    if (!b || !tab || !tab.created) {
      await invoke("browser_hide_all_except", { label: null });
      allPairs.forEach(function (pair) { browserTabLifecycle(pair.tab).nativeBounds = { x: -10000, y: -10000, w: 1, h: 1 }; });
      if (typeof publishBrowserResource === "function") await Promise.all(allPairs.map(function (pair) { return publishBrowserResource(pair); }));
      return;
    }
    var hide = invoke("browser_hide_all_except", { label: label });
    var resize = invoke("browser_set_bounds", { label: label, x: b.x, y: b.y, w: b.w, h: b.h });
    if (!project.browsersByWorktree) { await Promise.all([hide, resize]); return; }
    var worktreePath = Object.keys(project.browsersByWorktree || {}).find(function (root) {
      return project.browsersByWorktree[root].tabs.indexOf(tab) !== -1;
    });
    if (!worktreePath) { await Promise.all([hide, resize]); return; }
    var browser = project.browsersByWorktree[worktreePath];
    var changed = allPairs;
    await Promise.all([hide, resize]);
    changed.forEach(function (pair) {
      if (pair.tab !== tab) browserTabLifecycle(pair.tab).nativeBounds = { x: -10000, y: -10000, w: 1, h: 1 };
    });
    browserTabLifecycle(tab).nativeBounds = { x: b.x, y: b.y, w: b.w, h: b.h };
    if (typeof publishBrowserResource !== "function") return;
    await Promise.all(changed.map(function (pair) { return publishBrowserResource(pair); }));
  }
  async function navigateBrowser(rawUrl, opts) {
    opts = opts || {}; var project = activeProject(); if (!project) return false;
    var projectId = project.id;
    var worktreePath = activeWorkspaceRoot(project) || project.root;
    var browser = ensureBrowserModel(project, worktreePath); var hasRequestedTab = opts.tabId != null; var tab = hasRequestedTab ? browser.tabs.find(function (t) { return t.id === opts.tabId; }) : currentBrowserTab(project);
    var browsersByWorktree = project.browsersByWorktree || null;
    if ((hasRequestedTab && !tab) || browserTabIsClosing(tab)) return false;
    var pane = findBrowserPane(projectId, worktreePath);
    var requestIsCurrent = function () {
      if (project.id !== projectId || state.activeProjectId !== projectId ||
          activeProject() !== project || activeWorkspaceRoot(project) !== worktreePath ||
          (browsersByWorktree
            ? (project.browsersByWorktree !== browsersByWorktree ||
              browsersByWorktree[worktreePath] !== browser)
            : ensureBrowserModel(project, worktreePath) !== browser) ||
          (tab && (browser.tabs.indexOf(tab) === -1 || browserTabIsClosing(tab)))) return false;
      if (!pane) return findBrowserPane(projectId, worktreePath) === null;
      return pane.projectId === projectId && pane.worktreePath === worktreePath &&
        findThread(pane.id) === pane && findBrowserPane(projectId, worktreePath) === pane &&
        !browserPaneIsClosing(pane);
    };
    if (!requestIsCurrent()) return false;
    if (!pane) {
      pane = await createBrowserPane(project);
      if (!pane || !requestIsCurrent()) return false;
    }
    if (!tab) {
      if (!requestIsCurrent()) return false;
      tab = createBrowserTab(project, rawUrl || "about:blank", true);
      if (!tab || !requestIsCurrent()) return false;
    }
    var normalised = normaliseUrl(rawUrl); if (!normalised) return false;
    var lifecycle = browserTabLifecycle(tab);
    var invalidationGeneration = lifecycle.invalidationGeneration;
    var runNavigation = async function () {
      if (lifecycle.invalidationGeneration !== invalidationGeneration ||
          !requestIsCurrent()) return false;
      var b = visibleBrowserBounds(); if (!b) return false;
      var previousTitle = tab.title;
      var previousUrl = tab.url;
      var previousView = {
        nativeLabel: lifecycle.nativeLabel,
        liveGeneration: lifecycle.liveGeneration,
        liveUrl: lifecycle.liveUrl,
        eventUrl: lifecycle.eventUrl,
        viewLive: lifecycle.viewLive,
      };
      var generation = beginBrowserNavigation(tab);
      if (typeof invalidateBrowserAutomation === "function") await invalidateBrowserAutomation(tab);
      var label = browserLabelForTab(project, tab);
      var nativeLabel = nativeBrowserLabel(label);
      lifecycle.nativeLabel = nativeLabel;
      lifecycle.pendingGeneration = generation;
      lifecycle.pendingUrl = normalised;
      lifecycle.eventUrl = null;
      lifecycle.viewLive = true;
      lifecycle.nativeBounds = { x: b.x, y: b.y, w: b.w, h: b.h };
      lifecycle.navigationSnapshot = {
        url: previousUrl,
        title: previousTitle,
        history: Array.isArray(tab.history) ? tab.history.slice() : [],
        historyIndex: tab.historyIndex,
      };
      var context = {
        project: project,
        worktreePath: worktreePath,
        browser: browser,
        pane: pane,
        tab: tab,
        generation: generation,
        label: label,
        previousTitle: previousTitle,
      };
      tab.loading = true; tab.title = tabTitle(normalised); renderBrowserTabs(); updateBrowserControls();
      try {
        await invoke("browser_navigate", { tabId: tab.id, generation: generation,
          label: label, url: normalised, x: b.x, y: b.y, w: b.w, h: b.h });
        if (!browserNavigationIsCurrent(context)) {
          await discardObsoleteBrowserNavigation(context);
          return false;
        }
        var committedUrl = lifecycle.eventUrl || normalised;
        tab.created = true; tab.url = committedUrl;
        lifecycle.pendingGeneration = 0;
        lifecycle.pendingUrl = null;
        lifecycle.liveGeneration = generation;
        lifecycle.liveUrl = committedUrl;
        lifecycle.viewLive = true;
        lifecycle.navigationSnapshot = null;
        if (opts.fromHistory && typeof opts.historyIndex === "number") {
          tab.historyIndex = opts.historyIndex;
        } else if (!opts.fromHistory && !opts.preserveHistory) {
          tab.history = opts.replace ? [] : tab.history.slice(0, tab.historyIndex + 1);
          tab.history.push(normalised);
          tab.historyIndex = tab.history.length - 1;
        }
        if (browserNavigationOwnsVisiblePane(context)) renderBrowserTabs();
        await syncBrowserBounds();
        saveWorkspaceSoon();
        if (typeof publishBrowserResource === "function") {
          await publishBrowserResource({ project: project, worktreePath: worktreePath, browser: browser, tab: tab });
        }
        setTimeout(function () {
          if (browserNavigationIsCurrent(context) && tab.loading &&
              browserUrlsMatch(tab.url, normalised)) {
            markBrowserTabLoaded(nativeBrowserLabel(label), normalised, "");
          }
        }, 4500);
        return true;
      } catch (err) {
        if (!browserNavigationIsCurrent(context)) {
          await discardObsoleteBrowserNavigation(context);
          return false;
        }
        lifecycle.nativeLabel = previousView.nativeLabel;
        lifecycle.pendingGeneration = 0;
        lifecycle.pendingUrl = null;
        lifecycle.liveGeneration = previousView.liveGeneration;
        lifecycle.liveUrl = previousView.liveUrl;
        lifecycle.eventUrl = previousView.eventUrl;
        lifecycle.viewLive = previousView.viewLive;
        lifecycle.navigationSnapshot = null;
        tab.loading = false;
        tab.title = previousTitle;
        tab.url = previousUrl;
        if (browserNavigationOwnsVisiblePane(context)) renderBrowserTabs();
        try { await syncBrowserBounds(); } catch (_) {}
        writeToActive("\r\n\x1b[31m[browser_navigate]\x1b[0m " + err + "\r\n");
        return false;
      }
    };
    var navigation = lifecycle.navigationTail
      ? lifecycle.navigationTail.then(runNavigation, runNavigation)
      : runNavigation();
    lifecycle.navigationTail = navigation.then(function () {}, function () {});
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
    if (tab && tab.created && !browserTabIsClosing(tab) && !browserPaneIsClosing(pane)) queueBrowserReload(project, tab, pane);
  });
  async function queueBrowserReload(project, tab, pane) {
    var lifecycle = browserTabLifecycle(tab);
    var run = async function () {
      if (browserTabIsClosing(tab) || browserPaneIsClosing(pane)) return false;
      await invalidateBrowserAutomation(tab);
      tab.loading = true; renderBrowserTabs(); updateBrowserControls();
      await invoke("browser_reload", { tabId: tab.id, generation: lifecycle.controlGeneration });
      return true;
    };
    var reload = lifecycle.navigationTail ? lifecycle.navigationTail.then(run, run) : run();
    lifecycle.navigationTail = reload.then(function () {}, function () {});
    return reload.catch(function () { return false; });
  }
  document.getElementById("back").addEventListener("click", function () { var tab = currentBrowserTab(); if (tab && !browserTabIsClosing(tab) && tab.historyIndex > 0) { var index = tab.historyIndex - 1; navigateBrowser(tab.history[index], { fromHistory: true, historyIndex: index }); } });
  document.getElementById("forward").addEventListener("click", function () { var tab = currentBrowserTab(); if (tab && !browserTabIsClosing(tab) && tab.historyIndex < tab.history.length - 1) { var index = tab.historyIndex + 1; navigateBrowser(tab.history[index], { fromHistory: true, historyIndex: index }); } });
  document.getElementById("open-surprise").addEventListener("click", openDiceBrowserTab);
  document.getElementById("open-external").addEventListener("click", function () { var tab = currentBrowserTab(); if (tab && tab.url && tab.url !== "about:blank" && openUrl) openUrl(tab.url).catch(function () {}); });
  if (typeof ResizeObserver === "function") { var ro = new ResizeObserver(function () { Promise.resolve(syncBrowserBounds()).catch(function () {}); }); ro.observe(preview); ro.observe(detail); }
  window.addEventListener("beforeunload", function () {
    saveWorkspaceNow();
    if (typeof stopAgentControlPolling === "function") stopAgentControlPolling("unload");
    if (statusController) statusController.stop();
  });
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
    var worktree = selectedWorktree(project);
    if (!worktree || !worktree.path) {
      setStatus("Select an available worktree before starting a terminal", "warn");
      return null;
    }
    if (!(await showTerminalView())) return null;
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

  async function routeGlobalShortcut(e) {
    if (routeAgentPickerModalKeydown(e)) return;
    if (routeGitPaneShortcut(e)) return;
    var meta = e.metaKey || e.ctrlKey;
    if (!meta) return;
    if (String(e.key).toLowerCase() === "s") {
      await handleExplicitFileSave(e);
      return;
    }
    // ⌘T always opens a plain login shell in the terminal canvas.
    if (String(e.key).toLowerCase() === "t") {
      e.preventDefault();
      await createTerminalPane();
      return;
    }
    if (String(e.key).toLowerCase() === "p") {
      if (openAgentPicker()) e.preventDefault();
      return;
    }
    // ⌘O opens a new project (folder picker → addProject → Coven).
    if (e.key === "o") { openProjectPicker(); e.preventDefault(); return; }
    // ⌘W closes the active file tab; with none open it closes the project.
    if (e.key === "w") {
      e.preventDefault();
      if (state.activeFileId) await closeFileTab(state.activeFileId);
      else if (state.activeProjectId) await removeProject(state.activeProjectId);
      return;
    }
    if (e.key === "k") { commandInput.focus(); openPalette("/", true); e.preventDefault(); return; }
    // ⌘B collapses the sessions sidebar.
    if (e.code === "KeyB" && !e.altKey && !e.shiftKey) { toggleSidebar(); e.preventDefault(); return; }
    // ⌃1–9 addresses the panes on the canvas; ⌘1–9 stays on file tabs.
    if (e.ctrlKey && !e.metaKey) {
      var paneIndex = parseInt(e.key, 10);
      if (Number.isInteger(paneIndex) && paneIndex >= 1) {
        var paneId = canvasThreadIds()[paneIndex - 1];
        if (paneId) { await focusThread(paneId); e.preventDefault(); }
        return;
      }
    }
    // The tab strip shows files, so ⌘[ / ⌘] and ⌘1-9 address file tabs. With
    // no files open they fall back to projects, which the sidebar also drives.
    if (e.key === "[") { e.preventDefault(); await switchTab(-1); return; }
    if (e.key === "]") { e.preventDefault(); await switchTab(+1); return; }
    var n = parseInt(e.key, 10);
    if (Number.isInteger(n) && n >= 1 && n <= 9) {
      var files = projectFiles();
      if (files.length) {
        if (files[n - 1]) { e.preventDefault(); await activateFileTab(files[n - 1].id); }
        return;
      }
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

  function sidebarOpen() { return !appEl || appEl.dataset.sidebar !== "collapsed"; }
  function setSidebarOpen(open) {
    if (!appEl) return;
    appEl.dataset.sidebar = open ? "open" : "collapsed";
    if (sidebarMiniEl) sidebarMiniEl.hidden = open;
    if (!open) closeNewPaneMenu();
    requestAnimationFrame(function () {
      scheduleVisiblePaneFit();
      Promise.resolve(syncBrowserBounds()).catch(function () {});
    });
  }
  function toggleSidebar() { setSidebarOpen(!sidebarOpen()); }

  onRailClick("sidebar-collapse", function () { setSidebarOpen(false); });
  onRailClick("sidebar-expand", function () { setSidebarOpen(true); });
  if (sidebarMiniEl) {
    sidebarMiniEl.addEventListener("click", function (event) {
      if (event.target.closest("#sidebar-expand")) return;
      setSidebarOpen(true);
    });
  }
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
        document.documentElement.style.setProperty("--sidebar-w", next + "px");
      }
      function up() {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        sidebarResizeEl.classList.remove("dragging");
        requestAnimationFrame(function () { scheduleVisiblePaneFit(); Promise.resolve(syncBrowserBounds()).catch(function () {}); });
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
  onMenuClick("new-pane-agent", function () {
    openAgentPicker();
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
      String(event.key).toLowerCase() === "p"
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
    ["Open the composer", "⌘K"],
    ["Toggle the sessions sidebar", "⌘B"],
    ["Focus a pane on the canvas", "⌃1–9"],
    ["Resize a pane split", "drag the divider"],
    ["New terminal pane", "⌘T"],
    ["Choose an agent", "⌘P"],
    ["New browser tab", "Web pane +"],
    ["Open or focus Git", "⌘G"],
    ["Close the focused file / project", "⌘W"],
    ["Rename a session", "double-click"],
    ["Cycle file tabs", "⌘[ · ⌘]"],
    ["Save the open file", "⌘S"],
    ["Leave a fullscreen file", "esc"],
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
    if (event.defaultPrevented) return;
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
      if (state.activeFileId) {
        event.preventDefault();
        await returnFromFileFocus();
        return;
      }
      if (!typing && exitPaneMaximize()) return;
      return;
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "?") { toggleHelp(); event.preventDefault(); }
  });

  // ---- Agent control: daemon state projection + typed operator commands ----
  var agentControlOverlayEl = document.getElementById("agent-control-overlay");
  var agentControlDrawerEl = document.getElementById("agent-control-drawer");
  var agentControlContentEl = document.getElementById("agent-control-content");
  var agentControlToggleEl = document.getElementById("agent-control-toggle");
  var agentControlCloseEl = document.getElementById("agent-control-close");
  var agentControlCountEl = document.getElementById("agent-control-count");
  var browserAgentControlBadgesEl = document.getElementById("browser-agent-control-badges");
  var agentControlModel = window.PsycheControl.normalizeAgentControlState({}, { operator: true });
  var agentControlProjectRoot = null;
  var agentControlContextSerial = 0;
  var agentControlPoller = null;

  function agentControlContextToken(root, ownerEpoch) {
    var project = activeProject();
    return [agentControlContextSerial, root || "", project ? activeWorkspaceRoot(project) : "",
      Number.isSafeInteger(ownerEpoch) ? ownerEpoch : "none"].join(":");
  }

  function invalidateAgentControlContext() {
    agentControlContextSerial += 1;
    agentControlProjectRoot = null;
    agentControlModel = window.PsycheControl.normalizeAgentControlState({}, {
      operator: true, contextToken: agentControlContextToken(null, null),
    });
    if (agentControlContentEl) renderAgentControl();
    if (!activeProject() && agentControlOverlayEl && !agentControlOverlayEl.hidden) setAgentControlOpen(false);
  }

  function operatorOutcomeError(response) {
    if (response && response.type === "error" && typeof response.code === "string" &&
        typeof response.message === "string") return response.code + ": " + response.message;
    var outcome = response && response.outcome;
    if (outcome && outcome.status !== "succeeded") {
      if (typeof outcome.message === "string") return outcome.message;
      if (typeof outcome.code === "string") return outcome.code;
      return "Operator command failed";
    }
    return null;
  }

  async function submitAgentControlOperator(kind, payload) {
    var project = activeProject();
    if (!project || project.root !== agentControlProjectRoot) throw new Error("Agent control project changed");
    var response = await invoke("control_operator_submit", {
      projectRoot: project.root,
      command: { kind: kind, payload: payload },
    });
    var failure = operatorOutcomeError(response);
    if (failure) throw new Error(failure);
    await refreshAgentControlState();
    return response;
  }

  var agentControlDrawer = window.PsycheControl.createAgentControlDrawer({
    root: agentControlContentEl,
    dialog: agentControlDrawerEl,
    closeButton: agentControlCloseEl,
    opener: agentControlToggleEl,
    getContextToken: function () { return agentControlModel.contextToken; },
    onClose: function () { setAgentControlOpen(false); },
    onGrant: function (payload) { return submitAgentControlOperator("lease.grant", payload); },
    onDeny: function (payload) { return submitAgentControlOperator("approval.resolve", {
      approvalId: payload.approvalId, payloadDigest: payload.payloadDigest, decision: "deny",
    }); },
    onApprove: function (payload) { return submitAgentControlOperator("approval.resolve", {
      approvalId: payload.approvalId, payloadDigest: payload.payloadDigest, decision: "approve",
    }); },
    onRevoke: function (payload) { return submitAgentControlOperator("lease.revoke", {
      leaseId: payload.leaseId,
    }); },
  });

  function renderAgentControlBadgeList(host, badges) {
    if (!host) return;
    host.replaceChildren();
    badges.forEach(function (badge) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "agent-control-badge";
      button.textContent = badge.agent + " · " + badge.task;
      button.setAttribute("aria-label", window.PsycheControl.badgeAccessibleName(badge));
      button.title = badge.capabilities.join(" · ") + " · expires " + badge.expiresAt;
      button.dataset.leaseId = badge.leaseId;
      button.dataset.leaseRevision = String(badge.revision);
      button.dataset.resourceId = badge.id;
      button.dataset.resourceGeneration = String(badge.generation);
      button.addEventListener("click", function (event) { event.stopPropagation(); setAgentControlOpen(true); });
      host.appendChild(button);
    });
    host.hidden = badges.length === 0;
  }

  function renderAgentControlBadges() {
    var project = activeProject();
    state.threads.forEach(function (thread) {
      if (!thread.pane) return;
      var badgeEl = thread.agentControlBadges;
      if (!badgeEl) {
        badgeEl = document.createElement("span");
        badgeEl.className = "agent-control-badges";
        badgeEl.hidden = true;
        var label = thread.pane.querySelector(".terminal-pane-label");
        if (label) label.appendChild(badgeEl);
        thread.agentControlBadges = badgeEl;
      }
      var inScope = project && thread.projectId === project.id && thread.worktreePath === activeWorkspaceRoot(project);
      var resource = inScope && agentControlModel.currentResourceFor
        ? agentControlModel.currentResourceFor("pane", thread.id) : null;
      renderAgentControlBadgeList(badgeEl, resource ? agentControlModel.resourceBadgesFor(resource) : []);
    });
    var tab = currentBrowserTab(project);
    var browserBadge = null;
    if (tab) {
      var lifecycle = browserTabLifecycle(tab);
      browserBadge = window.PsycheControl.resourceBadgeFor(agentControlModel, {
        kind: "browser_tab", id: tab.id, generation: lifecycle.controlGeneration,
      });
    }
    renderAgentControlBadgeList(browserAgentControlBadgesEl, browserBadge ?
      agentControlModel.resourceBadgesFor({ kind: "browser_tab", id: tab.id,
        generation: browserTabLifecycle(tab).controlGeneration }) : []);
  }

  function renderAgentControl() {
    agentControlDrawer.render(agentControlModel);
    var count = agentControlModel.pendingCount;
    agentControlCountEl.hidden = count === 0;
    agentControlCountEl.textContent = String(count);
    agentControlToggleEl.setAttribute("aria-label", count
      ? "Agent control, " + count + " pending"
      : "Agent control, no pending requests");
    renderAgentControlBadges();
  }

  function captureAgentControlContext() {
    var project = activeProject();
    var root = project && project.root;
    if (!root) return null;
    var worktreeRoot = activeWorkspaceRoot(project);
    if (agentControlProjectRoot !== root) {
      agentControlProjectRoot = root;
      agentControlModel = window.PsycheControl.normalizeAgentControlState({}, {
        operator: false, projectRoot: root, worktreeRoot: worktreeRoot,
        contextToken: agentControlContextToken(root, null),
      });
      renderAgentControl();
    }
    return {
      serial: agentControlContextSerial, projectRoot: root, worktreeRoot: worktreeRoot,
      ownerEpoch: agentControlModel.ownerEpoch,
      contextToken: agentControlModel.contextToken || agentControlContextToken(root, agentControlModel.ownerEpoch),
    };
  }

  function agentControlContextMatches(context) {
    var project = activeProject();
    return !!project && context.serial === agentControlContextSerial && project.root === context.projectRoot
      && activeWorkspaceRoot(project) === context.worktreeRoot;
  }

  agentControlPoller = window.PsycheControl.createAgentControlPoller({
    captureContext: captureAgentControlContext,
    contextMatches: agentControlContextMatches,
    load: async function (context) {
      await ensureBrowserControlProvider(context.projectRoot);
      return invoke("control_state", { projectRoot: context.projectRoot });
    },
    accept: function (response, context) {
      var snapshot = response && response.snapshot || response || {};
      agentControlModel = window.PsycheControl.normalizeAgentControlState(response, {
        operator: true, projectRoot: context.projectRoot, worktreeRoot: context.worktreeRoot,
        contextToken: agentControlContextToken(context.projectRoot, snapshot.ownerEpoch),
      });
      renderAgentControl();
    },
    fail: function (context) {
      var snapshot = Number.isSafeInteger(context.ownerEpoch) ? { ownerEpoch: context.ownerEpoch } : {};
      agentControlModel = window.PsycheControl.normalizeAgentControlState(snapshot, {
        operator: false, projectRoot: context.projectRoot, worktreeRoot: context.worktreeRoot,
        contextToken: context.contextToken,
        fetchError: "Agent control state is temporarily unavailable",
      });
      renderAgentControl();
    },
    clear: function (reason) {
      var project = activeProject();
      var root = project && project.root;
      var worktreeRoot = project ? activeWorkspaceRoot(project) : "";
      var ownerEpoch = agentControlModel.ownerEpoch;
      agentControlModel = window.PsycheControl.normalizeAgentControlState(
        Number.isSafeInteger(ownerEpoch) ? { ownerEpoch: ownerEpoch } : {}, {
          operator: false, projectRoot: root || "", worktreeRoot: worktreeRoot,
          contextToken: agentControlModel.contextToken || agentControlContextToken(root, ownerEpoch),
          fetchError: reason === "hidden" ? "Agent control paused while the window is hidden" : "",
        });
      renderAgentControl();
    },
  });

  function refreshAgentControlState() {
    return agentControlPoller ? agentControlPoller.refresh() : Promise.resolve();
  }

  function setAgentControlOpen(open) {
    agentControlOverlayEl.hidden = !open;
    agentControlToggleEl.setAttribute("aria-expanded", String(open));
    if (open) {
      agentControlDrawer.open();
      refreshAgentControlState();
    } else {
      agentControlDrawer.close();
      agentControlToggleEl.focus();
    }
  }

  agentControlToggleEl.addEventListener("click", function () { setAgentControlOpen(true); });
  agentControlCloseEl.addEventListener("click", function () { setAgentControlOpen(false); });
  agentControlOverlayEl.addEventListener("pointerdown", function (event) {
    if (event.target === agentControlOverlayEl) setAgentControlOpen(false);
  });
  function startAgentControlPolling() {
    if (agentControlPoller) agentControlPoller.start();
  }
  function stopAgentControlPolling(reason) {
    if (agentControlPoller) agentControlPoller.stop(reason || "stopped");
  }

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

  // The tree highlights whichever file currently owns the main area.
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

  async function renderFilesPanel() {
    if (!fileTreeEl) return;
    var project = activeProject();
    if (!project) { panelMessage(fileTreeEl, "No project open — ⌘O to add one."); return; }
    var workspaceRoot = activeWorkspaceRoot(project);
    if (filesCrumbEl) filesCrumbEl.textContent = shortenRoot(workspaceRoot);
    fileTreeEl.innerHTML = "";
    await appendDirInto(fileTreeEl, workspaceRoot, workspaceRoot, 0);
    if (!fileTreeEl.firstChild) panelMessage(fileTreeEl, "Empty directory.");
  }

  async function appendDirInto(container, root, dirPath, depth) {
    var entries;
    try {
      entries = await invoke("fs_list_dir", { root: root, path: dirPath });
    } catch (err) {
      var e = document.createElement("div");
      e.className = "panel-error";
      e.textContent = String(err);
      container.appendChild(e);
      return;
    }
    entries.forEach(function (entry) {
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
      row.addEventListener("click", async function () {
        if (entry.is_dir) {
          if (expandedDirs[entry.path]) delete expandedDirs[entry.path];
          else expandedDirs[entry.path] = true;
          renderFilesPanel();
        } else {
          await openFileTab(entry.path, activeProject());
        }
      });
      container.appendChild(row);
      if (entry.is_dir && isOpen) {
        // Children render inline under the row, indented one level.
        var slot = document.createElement("div");
        container.appendChild(slot);
        appendDirInto(slot, root, entry.path, depth + 1);
      }
    });
  }

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
    if (files.length) {
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
    var migratedWorktreePath = remapPath(project.selectedWorktreePath);
    if (typeof state !== "undefined" && state.activeProjectId === project.id &&
        migratedWorktreePath !== project.selectedWorktreePath &&
        typeof invalidateAgentControlContext === "function") invalidateAgentControlContext();
    project.root = canonicalRoot;
    if (typeof selectAgentControlWorktree === "function") selectAgentControlWorktree(project, migratedWorktreePath);
    else project.selectedWorktreePath = migratedWorktreePath;
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
      if (typeof selectAgentControlWorktree === "function") selectAgentControlWorktree(target, incoming.selectedWorktreePath);
      else target.selectedWorktreePath = incoming.selectedWorktreePath;
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
      return {
        project: migrateProjectRoot(project, previousRoot, canonicalRoot),
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

  async function addProject(rootPath) {
    if (!rootPath) return null;
    rootPath = await canonicalProjectPath(rootPath);
    if (!rootPath) return null;
    var existing = state.projects.find(function (p) { return p.root === rootPath; });
    if (existing) return (await setActiveProject(existing.id)) ? existing : null;
    if (state.projects.length >= settings.maxProjects) { setStatus("project limit reached (" + settings.maxProjects + "/" + HARD_MAX_PROJECTS + ")", "warn"); return null; }
    if (!(await showTerminalView())) return null;
    var parts = rootPath.split("/");
    var name = parts[parts.length - 1] || rootPath;
    var project = { id: makeProjectId(), name: name, root: rootPath, collapsed: false, selectedWorktreePath: rootPath, worktrees: [], browsersByWorktree: {} };
    state.projects.push(project);
    state.activeProjectId = project.id;
    state.activeThreadId = null;
    renderPaneWorkspace();
    refreshSidebar();
    await refreshProjectWorktrees(project);
    syncProjectBrowser();
    saveWorkspaceSoon();
    startCovenPolling();
    startAgentControlPolling();
    if (typeof refreshStatusController === "function") refreshStatusController();
    return project;
  }

  async function openProjectPicker() {
    if (!dialogOpen) {
      writeToActive(
        "\r\n\x1b[33m[/open-project]\x1b[0m dialog plugin missing — rebuild required.\r\n"
      );
      return;
    }
    try {
      var defaultPath = (state.env && state.env.home) || undefined;
      var selected = await dialogOpen({
        directory: true,
        multiple: false,
        title: "Open project",
        defaultPath: defaultPath,
      });
      if (!selected || typeof selected !== "string") return; // user cancelled
      await addProject(selected);
    } catch (err) {
      writeToActive("\r\n\x1b[31m[open-project]\x1b[0m " + err + "\r\n");
    }
  }

  function agentLaunchOptions() {
    return [
      { id: "coven-code", label: "Coven Code", command: null, args: ["chat"], kind: "coven-chat" },
      { id: "copilot", label: "Copilot CLI", command: "copilot", args: [], kind: "agent-copilot" },
      { id: "codex", label: "Codex CLI", command: "codex", args: [], kind: "agent-codex" },
      { id: "anthropic", label: "Anthropic CLI", command: "claude", args: [], kind: "agent-anthropic" },
      { id: "grok-build", label: "Grok Build", command: "grok", args: [], kind: "agent-grok-build" },
    ];
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
      var option = document.createElement("button");
      option.type = "button";
      option.id = "agent-picker-option-" + entry.id;
      option.className = "agent-picker-option" + (selected ? " is-selected" : "");
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", selected ? "true" : "false");
      option.tabIndex = -1;
      option.innerHTML =
        '<span class="agent-picker-label">' + escapeHtml(entry.label) + "</span>" +
        '<span class="agent-picker-option-command">' +
          escapeHtml(entry.id === "coven-code" ? "coven chat" : (entry.command || "")) +
        "</span>";
      option.addEventListener("pointermove", function () {
        if (agentPickerIndex === index) return;
        agentPickerIndex = index;
        renderAgentPicker();
      });
      option.addEventListener("click", function () {
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
    closeSessionContextMenu();
    agentPickerIndex = 0;
    renderAgentPicker();
    agentPickerOverlayEl.hidden = false;
    focusAgentPickerList();
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

  function launchSelectedAgent() {
    var entry = agentLaunchOptions()[agentPickerIndex];
    if (!entry) return null;
    closeAgentPicker();
    return spawnAgentThread(entry.id);
  }

  async function spawnAgentThread(agentId, project) {
    project = project || activeProject();
    if (!project || !project.root) {
      setStatus("Open a project before starting an agent", "warn");
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
    var command = entry.command;
    if (entry.id === "coven-code") {
      if (!state.env || !state.env.coven_path) {
        setStatus("Coven CLI not found — install @opencoven/cli and restart Psyche", "error");
        return null;
      }
      return ensureProjectCoven(project);
    }
    if (!(await showTerminalView())) return null;
    return createThread({
      project: project,
      worktreePath: worktree.path,
      name: entry.label,
      kind: entry.kind,
      command: command,
      args: entry.args.slice(),
      launchKind: null,
      projectRoot: project.root,
      cwd: worktree.path,
    });
  }

  function covenChatLaunch(project, worktreePath) {
    var worktree = worktreePath ? { path: worktreePath } : selectedWorktree(project);
    var sessionId = makeCovenSessionId();
    if (!sessionId) return null;
    return {
      command: state.env.coven_path,
      args: ["code", "--session-id", sessionId],
      env: { COVEN_SESSION_SOURCE: "psyche-build" },
      projectRoot: project.root,
      cwd: worktree.path,
      kind: "coven-chat",
      launchKind: "coven-chat",
      covenSessionId: sessionId,
      metricsProvider: "coven",
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
    var launch = covenChatLaunch({ root: intendedProjectRoot }, intendedWorktreePath);
    if (!launch) return null;
    return createThread({
      project: currentProject,
      worktreePath: launch.cwd,
      name: "Coven",
      kind: "coven-chat",
      launch: launch,
    });
  }

  function ensureProjectCoven(project) {
    if (!project) return Promise.resolve(null);
    var worktree = selectedWorktree(project);
    if (!worktree || !worktree.path) return Promise.resolve(null);
    var existing = state.threads.find(function (t) {
      return t.projectId === project.id && t.worktreePath === worktree.path &&
        t.kind === "coven-chat" &&
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
    var saved = await loadSavedWorkspace();
    var bootRoot = state.env.repo_root || state.env.home || "/";
    var project = null;
    if (saved && saved.projects.length) {
      isRestoringWorkspace = true;
      var restored = await restoreSavedProjects(
        saved.projects,
        saved.activeProjectId,
        Math.min(settings.maxProjects, HARD_MAX_PROJECTS)
      );
      state.projects = restored.projects;
      state.activeProjectId = restored.activeProjectId;
      project = activeProject();
      isRestoringWorkspace = false;
      await Promise.all(state.projects.map(function (savedProject) {
        return refreshProjectWorktrees(savedProject);
      }));
    }
    if (!project) project = await addProject(bootRoot);
    if (project) {
      var activeTab = currentBrowserTab(project);
      if (activeTab && activeTab.created && activeTab.url && activeTab.url !== "about:blank") navigateBrowser(activeTab.url, { tabId: activeTab.id, preserveHistory: true });
    }
    refreshSidebar(); refreshTabs(); renderBrowserTabs(); syncProjectBrowser(); loadAgentSkills(); saveWorkspaceNow();
    startCovenPolling();
    startAgentControlPolling();
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
