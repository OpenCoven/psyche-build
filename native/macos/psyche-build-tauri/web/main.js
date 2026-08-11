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
        "Launch it with:\n  cd native/macos/psyche-build-tauri\n  pnpm dev\n\n" +
        "Opening web/index.html as file:// or in a normal browser will not inject window.__TAURI__."
    );
    return;
  }

  var invoke = window.__TAURI__.core.invoke;
  var listen = window.__TAURI__.event.listen;
  var openUrl = (window.__TAURI__.opener && window.__TAURI__.opener.openUrl) || null;
  var dialogOpen = (window.__TAURI__.dialog && window.__TAURI__.dialog.open) || null;
  var currentWindow = window.__TAURI__.window && window.__TAURI__.window.getCurrentWindow
    ? window.__TAURI__.window.getCurrentWindow()
    : null;

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
  var covenDiscoveryFlight = null;
  var covenPollTimer = null;
  var COVEN_POLL_MS = 5000;
  var paneCounter = 0;
  var visiblePaneFitFrame = 0;
  // Matches --pane-min-w / --pane-min-h: the tree's arithmetic and the pane's
  // own CSS floor have to agree, or a layout the tree calls valid renders
  // overflowing. 200x110 is the density the redesign tiles at.
  var PANE_MINIMUMS = { width: 200, height: 110, separator: 6 };

  function handleVisibilityChange() {
    if (document.visibilityState === "hidden") {
      saveWorkspaceNow();
      stopCovenPolling();
    } else {
      startCovenPolling();
    }
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
    project.selectedWorktreePath = worktreePath;
    var layout = paneLayoutFor(project.id, worktreePath);
    var leaf = layout && PsychePanes.findLeafById(layout.root, layout.focusedLeafId);
    var thread = leaf && findThread(leaf.threadId);
    state.activeThreadId = thread ? thread.id : null;
    if (thread) project.lastActiveThreadId = thread.id;
  }
  async function activateProjectWorktree(project, worktreePath, options) {
    if (!project || !(await showTerminalView())) return false;
    var previousWorktreePath = project.selectedWorktreePath;
    project.selectedWorktreePath = worktreePath;
    if (project.id !== state.activeProjectId) {
      if (!(await setActiveProject(project.id, options))) {
        project.selectedWorktreePath = previousWorktreePath;
        return false;
      }
    } else {
      activatePaneLayoutFocus(project, worktreePath);
    }
    renderPaneWorkspace();
    renderPanel(currentPanel());
    loadAgentSkills();
    refreshSidebar();
    syncProjectBrowser();
    saveWorkspaceSoon();
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
    var root = current && current.root
      ? PsychePanes.insertBelow(
          current.root,
          current.focusedLeafId,
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
  function covenSessionsForProject(project) {
    var roots = [project.root].concat(
      (project.worktrees || []).map(function (worktree) { return worktree.path; })
    ).filter(function (root, index, candidates) {
      return root && candidates.indexOf(root) === index;
    });
    return roots.reduce(function (sessions, root) {
      return sessions.concat(covenDiscovery.sessionsByProject.get(root) || []);
    }, []);
  }
  async function refreshCovenSessions() {
    if (document.visibilityState === "hidden" || state.projects.length === 0) {
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
    if (covenDiscoveryFlight && covenDiscoveryFlight.key === requestKey) {
      return covenDiscoveryFlight.promise;
    }
    var started = PsycheSessions.beginCovenRequest(covenDiscovery);
    covenDiscovery = started.state;
    renderSessionList();
    var flight = { key: requestKey, promise: null };
    covenDiscoveryFlight = flight;
    flight.promise = (async function () {
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
      } catch (_) {
        covenDiscovery = PsycheSessions.applyCovenResponse(
          covenDiscovery,
          started.requestId,
          { status: "error", sessions: [], message: "Coven sessions could not be loaded" }
        );
      } finally {
        if (covenDiscoveryFlight === flight) covenDiscoveryFlight = null;
      }
      renderSessionList();
      return covenDiscovery;
    })();
    return flight.promise;
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
    if (state.env && state.env.native_workspace_v2 === false) {
      project.worktrees = mergeWorktreePresentationState(project, [{
        path: project.root, branch: null, is_main: true, dirty: false, missing: false,
      }]);
      project.selectedWorktreePath = project.root;
      refreshSidebar();
      refreshCovenSessions();
      return Promise.resolve(project.worktrees);
    }
    return invoke("git_worktrees", { root: project.root }).then(function (worktrees) {
      project.worktrees = mergeWorktreePresentationState(project, worktrees);
      var selected = selectedWorktree(project);
      project.selectedWorktreePath = selected ? selected.path : project.root;
      refreshSidebar();
      saveWorkspaceSoon();
      refreshCovenSessions();
      return project.worktrees;
    }).catch(function () {
      project.worktrees = mergeWorktreePresentationState(project, [{
        path: project.root, branch: null, is_main: true, dirty: false, missing: false,
      }]);
      project.selectedWorktreePath = project.root;
      refreshSidebar();
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
    if (state.activeProjectId === id) return true;
    if (!(await showTerminalView())) return false;
    state.activeProjectId = id;
    var project = findProject(id);
    if (!project) return false;
    restoreProjectLayout(project);
    // Refresh agent skill suggestions for the new project's `.claude` tree.
    loadAgentSkills();
    // Restore the project's last-focused thread, falling back to its first.
    var workspaceRoot = activeWorkspaceRoot(project);
    var threads = state.threads.filter(function (t) {
      return t.projectId === id && t.worktreePath === workspaceRoot && !t.hidden;
    });
    var nextId = project.lastActiveThreadId &&
      threads.some(function (t) { return t.id === project.lastActiveThreadId; })
        ? project.lastActiveThreadId
        : (threads[0] ? threads[0].id : null);
    if (nextId) {
      await focusThread(nextId);
    } else {
      state.activeThreadId = null;
      renderPaneWorkspace();
      refreshSidebar();
      refreshTabs();
      syncProjectBrowser();
      if (!options || options.ensureCoven !== false) {
        var covenThread = await ensureProjectCoven(project);
        if (covenThread) setStatus("no pane — launching Coven…", "");
      }
    }
    syncProjectBrowser();
    saveWorkspaceSoon();
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
    var defaults = { maxProjects: 10, maxBrowserTabsPerProject: 10, bgOpacity: DEFAULT_BG_OPACITY, theme: DEFAULT_THEME, solidBg: false };
    try {
      var saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      return {
        maxProjects: clampInt(saved.maxProjects, defaults.maxProjects, 1, HARD_MAX_PROJECTS),
        maxBrowserTabsPerProject: clampInt(saved.maxBrowserTabsPerProject, defaults.maxBrowserTabsPerProject, 1, HARD_MAX_BROWSER_TABS_PER_PROJECT),
        bgOpacity: clampFloat(saved.bgOpacity, defaults.bgOpacity, MIN_BG_OPACITY, MAX_BG_OPACITY),
        theme: THEMES.indexOf(saved.theme) === -1 ? defaults.theme : saved.theme,
        solidBg: saved.solidBg === true,
      };
    } catch (_) { return defaults; }
  }
  function saveSettings() {
    settings.maxProjects = clampInt(settings.maxProjects, 10, 1, HARD_MAX_PROJECTS);
    settings.maxBrowserTabsPerProject = clampInt(settings.maxBrowserTabsPerProject, 10, 1, HARD_MAX_BROWSER_TABS_PER_PROJECT);
    settings.bgOpacity = clampFloat(settings.bgOpacity, DEFAULT_BG_OPACITY, MIN_BG_OPACITY, MAX_BG_OPACITY);
    if (THEMES.indexOf(settings.theme) === -1) settings.theme = DEFAULT_THEME;
    settings.solidBg = settings.solidBg === true;
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
    return { id: project.id, name: project.name, root: project.root, selectedWorktreePath: project.selectedWorktreePath, worktreePresentation: (project.worktrees || []).map(function (worktree) { return { path: worktree.path, collapsed: !!worktree.collapsed }; }), layout: ensureProjectLayout(project), browsersByWorktree: persistableBrowsers(project) };
  }
  function saveWorkspaceNow() {
    if (isRestoringWorkspace) return;
    try {
      localStorage.setItem(WORKSPACE_STATE_KEY, JSON.stringify({ version: 2, activeProjectId: state.activeProjectId || null, projects: state.projects.map(persistableProject).slice(0, HARD_MAX_PROJECTS) }));
    } catch (_) {}
  }
  function saveWorkspaceSoon() {
    if (isRestoringWorkspace) return;
    if (saveWorkspaceTimer) cancelAnimationFrame(saveWorkspaceTimer);
    saveWorkspaceTimer = requestAnimationFrame(function () { saveWorkspaceTimer = 0; saveWorkspaceNow(); });
  }
  function readSavedWorkspace() {
    try { var saved = JSON.parse(localStorage.getItem(WORKSPACE_STATE_KEY) || "null"); return saved && Array.isArray(saved.projects) ? saved : null; } catch (_) { return null; }
  }
  function sanitizeSavedProject(saved) {
    if (!saved || !saved.root) return null;
    var project = {
      id: saved.id || makeProjectId(),
      name: saved.name || String(saved.root).split("/").pop() || saved.root,
      root: saved.root,
      collapsed: false,
      selectedWorktreePath: saved.selectedWorktreePath || saved.root,
      worktrees: Array.isArray(saved.worktreePresentation) ? saved.worktreePresentation : [],
      layout: {
        mode: saved.layout && saved.layout.mode ? saved.layout.mode : "terminal",
        side: saved.layout && saved.layout.side ? saved.layout.side : "right",
        splitFrac: typeof (saved.layout && saved.layout.splitFrac) === "number" ? saved.layout.splitFrac : 0.6,
      },
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
        return { id: tab.id || makeBrowserTabId(), url: url, title: tab.title || tabTitle(url), history: history, historyIndex: clampInt(tab.historyIndex, history.length ? history.length - 1 : -1, -1, Math.max(-1, history.length - 1)), created: !!tab.created && url !== "about:blank", loading: false };
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
  var dockMiniEl = document.getElementById("rail-right");
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
  var scopeBtnEl = document.getElementById("scope-btn");
  var scopeLabelEl = document.getElementById("scope-label");
  var scopeMenuEl = document.getElementById("scope-menu");
  var composerSendEl = document.getElementById("composer-send");
  var composerSendHintEl = document.getElementById("composer-send-hint");
  var composerMicEl = document.getElementById("composer-mic");
  var dockGitCountEl = document.getElementById("dock-git-count");

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

  // ---- Toast ----
  // Short-lived confirmation for actions whose effect happens off-screen
  // (a pane spawned behind a maximised pane, a dock panel switched, …).
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
  // 4. Layout — canvas plus an optional Git dock.
  //    `--split-frac` is always the fraction of the canvas in split.
  // ============================================================

  var PANELS = ["git"];
  // Diffs used to be its own tab. It now lives inside the git panel, so every
  // stored layout naming it, and every `panelIsVisible("diffs")` gate, resolves
  // to the tab that actually shows it.
  var PANEL_ALIASES = { diffs: "git" };
  function resolvePanelName(name) {
    return Object.prototype.hasOwnProperty.call(PANEL_ALIASES, name)
      ? PANEL_ALIASES[name]
      : name;
  }
  var detailStyleRule = null;

  function currentLayout() { return detail.dataset.layout || "terminal"; }
  function getDetailStyleRule() {
    if (detailStyleRule) return detailStyleRule;
    for (var i = 0; i < document.styleSheets.length; i++) {
      var rules;
      try { rules = document.styleSheets[i].cssRules; } catch (_) { continue; }
      for (var j = 0; j < rules.length; j++) {
        if (rules[j].selectorText === ".detail") {
          detailStyleRule = rules[j];
          return detailStyleRule;
        }
      }
    }
    return null;
  }
  function setDetailSplitFrac(value) {
    var rule = getDetailStyleRule();
    if (rule) rule.style.setProperty("--split-frac", String(value));
    else detail.style.setProperty("--split-frac", String(value));
  }
  function currentSplitFrac() {
    var rule = getDetailStyleRule();
    var value = rule ? rule.style.getPropertyValue("--split-frac") : "";
    if (!value) value = window.getComputedStyle(detail).getPropertyValue("--split-frac");
    return parseFloat(value) || 0.6;
  }
  function ensureProjectLayout(project) {
    if (!project) return null;
    // A new project opens with the tools dock showing Git: the dock is a
    // first-class surface now, not an occasional overlay. Saved projects keep
    // whatever layout they were left in.
    if (!project.layout) {
      project.layout = { mode: "split", splitFrac: 0.62, panel: "git" };
    }
    return project.layout;
  }
  function rememberProjectLayout(project) {
    project = project || activeProject();
    var layout = ensureProjectLayout(project);
    if (!layout) return;
    layout.mode = currentLayout();
    layout.splitFrac = currentSplitFrac();
    layout.panel = currentPanel();
    saveWorkspaceSoon();
  }
  function restoreProjectLayout(project) {
    var layout = ensureProjectLayout(project);
    if (!layout) return;
    var previousLayout = currentLayout();
    setDetailSplitFrac(layout.splitFrac || 0.6);
    setPanel(layout.panel || project.panel || "git", { render: false });
    applyLayout(layout.mode === "split" ? "split" : "terminal", { persist: false });
    // Panels read from the project root, so re-render for the project we just
    // switched to rather than showing the previous one's tree/diff/log.
    if (previousLayout === "split" && currentLayout() === "split") {
      renderPanel(currentPanel());
    }
  }

  function applyLayout(layout, opts) {
    var previousLayout = currentLayout();
    if (layout === "splitV") layout = "split";
    if (layout !== "split") layout = "terminal";
    detail.dataset.layout = layout;
    if (!opts || opts.persist !== false) rememberProjectLayout();
    syncPanelButtons();
    var splitterEl = document.getElementById("splitter");
    if (splitterEl) splitterEl.setAttribute("aria-orientation", "vertical");
    syncDockChrome();
    handlePanelLayoutTransition(previousLayout, layout);
    requestAnimationFrame(function () {
      scheduleVisiblePaneFit();
      syncBrowserBounds();
    });
  }

  // Collapsing the Git dock hands its column to the mini rail.
  function syncDockChrome() {
    var open = currentLayout() !== "terminal";
    if (appEl) appEl.dataset.dock = open ? "open" : "collapsed";
    if (dockMiniEl) dockMiniEl.hidden = open;
  }

  function handlePanelLayoutTransition(previousLayout, nextLayout) {
    var panel = currentPanel();
    if (previousLayout === "split" && nextLayout !== "split" && panel === "git") {
      suspendDiffRequests();
    }
    if (previousLayout !== "split" && nextLayout === "split") {
      renderPanel(panel);
    }
  }

  function toggleDock() {
    applyLayout(currentLayout() === "split" ? "terminal" : "split");
  }
  // ---- Right-rail panel switching ----
  // The rail is a radio group over the dock's panels. Clicking the
  // panel that is already showing collapses the pane, so one button both opens
  // and closes — the usual activity-bar behaviour.
  function currentPanel() {
    var p = detail.dataset.panel;
    return PANELS.indexOf(p) === -1 ? PANELS[0] : p;
  }
  function syncPanelButtons() {
    var open = currentLayout() === "split";
    var panel = currentPanel();
    Array.prototype.forEach.call(
      document.querySelectorAll("[data-panel-btn]"),
      function (btn) {
        btn.setAttribute(
          "aria-pressed",
          open && btn.dataset.panelBtn === panel ? "true" : "false"
        );
      }
    );
  }
  function setPanel(name, opts) {
    name = resolvePanelName(name);
    if (PANELS.indexOf(name) === -1) name = PANELS[0];
    detail.dataset.panel = name;
    var project = activeProject();
    if (project) project.panel = name;
    if (!opts || opts.render !== false) renderPanel(name);
    syncBrowserBounds();
    syncPanelButtons();
  }
  function renderPanel(name) {
    if (name === "git") {
      // One tab, two sections: repository state above, changed files below.
      renderGitPanel();
      renderDiffsPanel();
    }
  }
  Array.prototype.forEach.call(
    document.querySelectorAll("[data-panel-btn]"),
    function (btn) {
      btn.addEventListener("click", function () {
        var name = btn.dataset.panelBtn;
        if (currentLayout() === "split" && currentPanel() === name) {
          applyLayout("terminal");
          return;
        }
        var panelWasVisible = currentLayout() === "split";
        setPanel(name, { render: false });
        applyLayout("split");
        if (panelWasVisible) renderPanel(name);
      });
    }
  );

  // ============================================================
  // 5. PTY event plumbing
  // ============================================================

  var pendingDataBuffers = new Map(); // threadId → array of Uint8Array (pre-mount)

  listen("pty:data", function (event) {
    var payload = event.payload || {};
    if (!payload.thread_id || !payload.bytes) return;
    var bytes = new Uint8Array(payload.bytes);
    var thread = findThread(payload.thread_id);
    if (!thread || thread.closing) return;
    if (thread.term) {
      thread.term.write(bytes);
    } else {
      var arr = pendingDataBuffers.get(payload.thread_id) || [];
      arr.push(bytes);
      pendingDataBuffers.set(payload.thread_id, arr);
    }
  }).catch(function () {});

  function handlePtyExit(payload) {
    payload = payload || {};
    var thread = findThread(payload.thread_id);
    if (!thread || thread.closing || thread.closeStarted) return false;
    thread.ptyStarted = false;
    if (thread.startInFlight) {
      thread.exitDuringStart = true;
    }
    thread.stopRequested = false;
    thread.spawning = false;
    thread.status = "exited";
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
      && thread.status !== "exited";
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
    if (!thread) return;
    attentionTracker.forget(thread.id);
    applyThreadAttention(thread, { needsAttention: false, reason: null });
  }

  function sampleThreadAttention() {
    var now = Date.now();
    var tracked = [];
    state.threads.forEach(function (thread) {
      if (!threadWantsAttentionTracking(thread) || !thread.term) {
        if (thread && thread.needsAttention) clearThreadAttention(thread);
        return;
      }
      tracked.push(thread.id);
      applyThreadAttention(
        thread,
        attentionTracker.observe(thread.id, terminalTail(thread.term, ATTENTION_TAIL_LINES), now)
      );
    });
    attentionTracker.retain(tracked);
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
    };
    commitPanePlacement(placement);
    state.threads.push(thread);
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
      await focusThread(existing.id);
      return existing;
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
    mountBrowserPane(pane);
    await focusThread(id);
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
    thread.stopRequested = false;
    thread.exitDuringStart = false;
    thread.startInFlight = true;
    thread.status = "starting";
    thread.spawning = true;
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
        thread.status = "exited";
        thread.spawning = false;
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
        for (var i = 0; i < pending.length; i++) thread.term.write(pending[i]);
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
        thread.status = "exited";
        thread.spawning = false;
        syncThreadPaneMetadata(thread);
        refreshSidebar();
        refreshTabs();
        return false;
      }
      thread.spawning = false;
      if (msg.indexOf("already running") !== -1) {
        thread.ptyStarted = true;
        thread.status = "running";
        thread.stopRequested = false;
        if (state.activeThreadId === thread.id) {
          setProjectStatus(findProject(thread.projectId), "ok");
        }
        if (launch.launchKind === "coven-chat") refreshCovenSessions();
        var pending = pendingDataBuffers.get(thread.id);
        if (pending && thread.term) {
          for (var i = 0; i < pending.length; i++) thread.term.write(pending[i]);
          pendingDataBuffers.delete(thread.id);
        }
      } else {
        thread.ptyStarted = false;
        thread.status = "failed";
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
  // The git surface is a single element with two possible homes: the dock, or a
  // pane. Moving it rather than rendering it twice is what keeps the two in
  // sync -- there is only ever one of it, so there is nothing to diverge.

  var gitSurfaceEl = document.getElementById("git-surface");
  var gitPanelEl = document.querySelector(".panel-git");
  var gitPoppedNoteEl = document.getElementById("git-popped-note");

  /** The thread holding the git pane, if it is popped out. */
  function gitPaneThread() {
    for (var i = 0; i < state.threads.length; i++) {
      if (state.threads[i].kind === "git" && !state.threads[i].closing) return state.threads[i];
    }
    return null;
  }

  function syncGitDockChrome() {
    var popped = Boolean(gitPaneThread());
    if (gitPoppedNoteEl) gitPoppedNoteEl.hidden = !popped;
    var popBtn = document.getElementById("git-pop-out");
    if (popBtn) popBtn.hidden = popped;
  }

  /** Put the surface back in the dock, wherever it currently is. */
  function dockGitSurface() {
    if (gitSurfaceEl && gitPanelEl && gitSurfaceEl.parentElement !== gitPanelEl) {
      gitPanelEl.appendChild(gitSurfaceEl);
    }
    syncGitDockChrome();
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
    pane.setAttribute("aria-labelledby", title.id);
    var meta = document.createElement("span");
    meta.className = "terminal-pane-meta";
    label.appendChild(title);
    label.appendChild(meta);
    var status = document.createElement("span");
    status.className = "terminal-pane-status";
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
    close.title = "Return Git to the dock";
    close.setAttribute("aria-label", "Return Git to the dock");
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
    header.appendChild(status);
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
    thread.host = body;
    thread.toolBody = body;
    thread.paneTitle = title;
    thread.paneMeta = meta;
    thread.paneStatus = status;
    thread.paneSpan = span;
    thread.paneMax = maximize;
    thread.paneClose = close;
    syncThreadPaneMetadata(thread);
    renderPaneWorkspace();
  }

  /**
   * Open Git as a pane. `dropTarget` optionally places it next to an existing
   * pane, which is how a drag from the dock lands where it was dropped.
   */
  async function popOutGitPane(dropTarget) {
    var existing = gitPaneThread();
    if (existing) { await focusThread(existing.id); return existing; }
    var project = activeProject();
    if (!project) { setStatus("No project open", "warn"); return null; }
    var worktreePath = activeWorkspaceRoot(project);
    var id = makeThreadId();
    var placement = preparePanePlacement(id, project.id, worktreePath);
    if (!placement) {
      setStatus("Not enough space for another pane", "warn");
      return null;
    }
    var thread = {
      id: id,
      projectId: project.id,
      worktreePath: worktreePath,
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
    state.threads.push(thread);
    mountToolPane(thread);
    if (dropTarget && dropTarget.threadId && dropTarget.position) {
      movePaneTo(id, dropTarget.threadId, dropTarget.position);
    }
    await focusThread(id);
    syncGitDockChrome();
    refreshSidebar();
    return thread;
  }

  /** Close the pane and hand the surface back to the dock. */
  function closeToolPane(thread) {
    if (!thread || thread.closeStarted) return;
    thread.closeStarted = true;
    thread.closing = true;
    // Move the surface home before the pane is torn down, or it would be
    // removed from the document along with its container.
    dockGitSurface();
    forgetThreadInSets(thread.id);
    var nextThreadId = detachThreadPane(thread);
    state.threads = state.threads.filter(function (t) { return t.id !== thread.id; });
    if (thread.pane && thread.pane.parentNode) thread.pane.parentNode.removeChild(thread.pane);
    if (state.activeThreadId === thread.id) state.activeThreadId = nextThreadId;
    syncGitDockChrome();
    renderPaneWorkspace();
    refreshSidebar();
    saveWorkspaceSoon();
  }

  // Click pops out; dragging the same control onto the canvas pops out where it
  // lands. One affordance, two gestures, so the tab does not need a second
  // control for the second gesture.
  var gitPopOutBtn = document.getElementById("git-pop-out");
  if (gitPopOutBtn) {
    gitPopOutBtn.addEventListener("click", function () { popOutGitPane(); });
    gitPopOutBtn.addEventListener("dragstart", function (event) {
      if (!event.dataTransfer) return;
      event.dataTransfer.setData("text/x-psyche-tool", "git");
      event.dataTransfer.effectAllowed = "move";
      document.body.classList.add("is-tool-dragging");
    });
    gitPopOutBtn.addEventListener("dragend", function () {
      document.body.classList.remove("is-tool-dragging");
      clearPaneDropIndicator();
    });
  }
  var gitDockBackBtn = document.getElementById("git-dock-back");
  if (gitDockBackBtn) {
    gitDockBackBtn.addEventListener("click", function () {
      var thread = gitPaneThread();
      if (thread) closeToolPane(thread);
    });
  }

  function toolDropTargetAt(clientX, clientY) {
    var hit = paneElementAt(clientX, clientY);
    if (!hit) return null;
    return {
      threadId: hit.thread.id,
      position: paneDropZone(hit.rect, clientX, clientY),
      rect: hit.rect,
    };
  }

  if (terminalHost) {
    terminalHost.addEventListener("dragover", function (event) {
      if (!event.dataTransfer || event.dataTransfer.types.indexOf("text/x-psyche-tool") === -1) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      var target = toolDropTargetAt(event.clientX, event.clientY);
      // Reuse the pane-drag indicator so a tool lands with the same affordance
      // as moving a pane; a second visual language here would be noise.
      if (target) showPaneDropIndicator(target.rect, target.position);
      else clearPaneDropIndicator();
    });
    terminalHost.addEventListener("dragleave", function (event) {
      if (event.target === terminalHost) clearPaneDropIndicator();
    });
    terminalHost.addEventListener("drop", function (event) {
      if (!event.dataTransfer || event.dataTransfer.getData("text/x-psyche-tool") !== "git") return;
      event.preventDefault();
      var target = toolDropTargetAt(event.clientX, event.clientY);
      clearPaneDropIndicator();
      document.body.classList.remove("is-tool-dragging");
      popOutGitPane(target);
    });
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
    pane.setAttribute("aria-labelledby", title.id);
    var meta = document.createElement("span");
    meta.className = "terminal-pane-meta";
    label.appendChild(title);
    label.appendChild(meta);
    var status = document.createElement("span");
    status.className = "terminal-pane-status";
    applyPaneStatus(status, thread.status);
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
    header.appendChild(status);
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
    pane.addEventListener("pointerdown", function (event) {
      handlePanePointerDown(thread, body, close, event);
    });
    thread.pane = pane;
    thread.host = body;
    thread.browserBody = body;
    thread.paneTitle = title;
    thread.paneMeta = meta;
    thread.paneStatus = status;
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
    pane.setAttribute("aria-labelledby", title.id);
    var meta = document.createElement("span");
    meta.className = "terminal-pane-meta";
    label.appendChild(title);
    label.appendChild(meta);
    var status = document.createElement("span");
    status.className = "terminal-pane-status";
    applyPaneStatus(status, thread.status);
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
    header.appendChild(status);
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
    pane.addEventListener("pointerdown", function (event) {
      handlePanePointerDown(thread, body, close, event);
    });
    thread.pane = pane;
    thread.host = container;
    thread.paneTitle = title;
    thread.paneMeta = meta;
    thread.paneStatus = status;
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

  // Status never travels as colour alone: starting, exited and failed are
  // worded chips. Running is the one exception, and only because it is the
  // steady state of nearly every pane — it gets a static green dot, and the
  // word stays in the title and aria-label so nothing is lost without colour.
  function applyPaneStatus(element, status) {
    if (!element) return;
    var label = status || "";
    element.className = "terminal-pane-status " + label;
    element.textContent = label === "running" ? "" : label;
    element.title = label;
    element.setAttribute("aria-label", label);
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
  // dragging a tool out of the dock -- so the two gestures read identically.
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
    var second = document.createElement("div");
    second.className = "terminal-pane-branch";
    second.style.flexGrow = String(1 - ratio);
    second.appendChild(renderPaneNode(node.second, splitRatios));
    split.appendChild(first);
    split.appendChild(createPaneDivider(node, ratio));
    split.appendChild(second);
    return split;
  }

  function renderPaneWorkspace() {
    if (!terminalHost) return;
    stageBrowserSurface();
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

  async function focusThread(id) {
    var thread = findThread(id);
    if (!thread) return false;
    if (!(await showTerminalView())) return false;
    markActiveSurface(thread.kind === "web" ? "browser" : "terminal");
    state.activeThreadId = id;
    // Make the thread's project the active one so the sidebar/tabs
    // stay in sync if the user clicked into a different project's thread.
    if (thread.projectId && state.activeProjectId !== thread.projectId) {
      state.activeProjectId = thread.projectId;
    }
    var project = findProject(thread.projectId);
    if (project) {
      project.lastActiveThreadId = id;
      project.selectedWorktreePath = thread.worktreePath;
    }
    var layout = paneLayoutFor(thread.projectId, thread.worktreePath);
    var leaf = layout && PsychePanes.findLeafByThreadId(layout.root, id);
    if (layout && leaf) layout.focusedLeafId = leaf.id;
    renderPaneWorkspace();
    refreshSidebar();
    requestAnimationFrame(function () {
      scheduleVisiblePaneFit();
      if (thread.term) thread.term.focus();
      syncBrowserBounds();
    });

    setProjectStatus(project, statusLevel(thread.status));
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
    if (thread.paneStatus) {
      applyPaneStatus(thread.paneStatus, thread.status);
    }
    var layout = paneLayoutForThread(thread);
    var leaf = layout && layout.root
      ? PsychePanes.findLeafByThreadId(layout.root, thread.id)
      : null;
    if (layout) {
      syncPaneSpanControl(thread, layout, leaf);
      syncPaneMaxControl(thread, layout, leaf);
    }
    if (thread.paneClose) {
      thread.paneClose.setAttribute(
        "aria-label",
        thread.kind === "web" ? "Close Web pane" : "Stop and close " + thread.name
      );
    }
  }

  function detachThreadPane(thread) {
    if (!thread) return null;
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

  function closeBrowserPane(thread) {
    if (!thread || thread.kind !== "web") return false;
    var wasActive = state.activeThreadId === thread.id;
    stageBrowserSurface();
    var closed = closeThread(thread.id);
    if (closed && wasActive) markActiveSurface("terminal");
    return closed;
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
        if (nextThread) project.selectedWorktreePath = nextThread.worktreePath;
      }
    }
    return true;
  }

  function closeThread(id, options) {
    var thread = findThread(id);
    if (!thread || thread.closeStarted) return false;
    if (thread.kind === "web" && state.activeThreadId === id) {
      markActiveSurface("terminal");
    }
    thread.closeStarted = true;
    thread.closing = true;
    pendingDataBuffers.delete(id);
    // A set must never point at a thread that no longer exists, or scoping the
    // canvas to it would silently show fewer panes than it claims.
    forgetThreadInSets(id);
    var nextThreadId = detachThreadPane(thread);
    if (thread.kind !== "web" && !thread.startInFlight) stopThreadPty(thread);
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
    var nextThreadId = detachThreadPane(thread);
    thread.hidden = true;
    if (state.activeThreadId === id) {
      state.activeThreadId = null;
      if (!retainFileFocusAfterThreadRemoval(id, nextThreadId, thread.projectId) && nextThreadId) {
        focusThread(nextThreadId);
      }
    }
    renderPaneWorkspace();
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
    thread.hidden = false;
    commitPanePlacement(placement);
    project.lastActiveThreadId = thread.id;
    state.activeThreadId = thread.id;
    renderPaneWorkspace();
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

  function duplicateThread(thread) {
    if (!thread || thread.status === "exited") return null;
    return createThread({
      project: findProject(thread.projectId),
      name: thread.name + " copy",
      kind: thread.kind,
      worktreePath: thread.worktreePath,
      launch: thread.launch,
    });
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
    syncBrowserBounds();
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
  var sidebarTab = "sessions";

  // The file tree renders lazily: switching to it is the only thing that has to
  // ask the filesystem, and the sessions rail should not pay for that.
  function setSidebarTab(name) {
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

  /** Sidebar and menu glyph for a pane kind. */
  function paneGlyphFor(kind) {
    if (kind === "shell") return "❯_";
    if (kind === "web") return "◍";
    return "✳";
  }

  /**
   * The row's leading glyph. It reports the lane's git state rather than the
   * pane's kind, because "has this lane got uncommitted work in it" is the
   * question the sidebar gets scanned for — the kind is one line below.
   * Colour is never the only carrier: the glyph shape and the tooltip both
   * say the same thing.
   */
  function sessionGitState(worktree) {
    if (worktree && worktree.dirty) {
      return { glyph: "±", className: "git-dirty", tip: "Uncommitted changes" };
    }
    return { glyph: "⎇", className: "git-clean", tip: "Clean working tree" };
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

  function disarmSessionClose() {
    if (!armedSessionClose) return;
    var armed = armedSessionClose;
    armedSessionClose = null;
    clearInterval(armed.timer);
    armed.confirm.remove();
    if (armed.close.isConnected) armed.close.hidden = false;
  }

  /**
   * Closing a pane stops a process, so it never happens on a single click. The
   * × swaps for a countdown pill that has to be clicked again, and that cancels
   * itself when the timer runs out — the guard costs nothing if you meant it
   * and everything if you didn't.
   */
  function armSessionClose(wrapper, close, thread) {
    disarmSessionClose();
    var left = SESSION_CLOSE_SECONDS;
    var confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "session-close-confirm";
    confirm.title = "Click to confirm — auto-cancels when the timer runs out";
    function paint() {
      confirm.textContent = "Close · " + left;
      confirm.setAttribute("aria-label", "Confirm closing " + thread.name);
    }
    paint();
    confirm.addEventListener("click", function (event) {
      event.stopPropagation();
      disarmSessionClose();
      closeThread(thread.id);
    });
    close.hidden = true;
    wrapper.appendChild(confirm);
    var timer = setInterval(function () {
      left -= 1;
      if (left <= 0) { disarmSessionClose(); return; }
      paint();
    }, 1000);
    armedSessionClose = { timer: timer, confirm: confirm, close: close };
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

  function findCovenAttachment(project, session, threadId) {
    return state.threads.find(function (thread) {
      return (!threadId || thread.id === threadId)
        && thread.projectId === project.id
        && thread.covenSessionId === session.id
        && !thread.closeStarted;
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
          project, existing.worktreePath, { ensureCoven: false }
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
      if (!(await activateProjectWorktree(project, worktree.path, { ensureCoven: false }))) return null;
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
      });
    }).finally(function () {
      covenAttachInFlight.delete(key);
    });
    covenAttachInFlight.set(key, opening);
    return opening;
  }

  function createCovenSessionRow(project, session) {
    var presentation = PsycheSessions.statusPresentation(session.status);
    var attached = state.threads.some(function (thread) {
      return thread.projectId === project.id
        && thread.covenSessionId === session.id
        && !thread.closeStarted;
    });
    var row = document.createElement("button");
    row.type = "button";
    row.className = "session-coven-row";
    row.dataset.sessionId = session.id;
    row.title = attached ? "Focus attachment" : "Attach";
    var title = document.createElement("span");
    title.className = "session-coven-title";
    title.textContent = session.title || session.id;
    var meta = document.createElement("span");
    meta.className = "session-coven-meta coven-tone-" + presentation.tone;
    meta.textContent = [session.harness, presentation.label].filter(Boolean).join(" · ");
    row.appendChild(title);
    row.appendChild(meta);
    if (presentation.label === "waiting") {
      var badge = document.createElement("span");
      badge.className = "session-attention-badge";
      badge.textContent = "!";
      badge.title = "Waiting for input";
      row.appendChild(badge);
    }
    row.addEventListener("click", function () {
      openCovenSession(project, session);
    });
    return row;
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

  function renderSessionList() {
    if (!sessionListEl) return;
    if (editingContext && editingContext.surface === "sidebar") return;
    // A re-render would strand an armed confirm on a row that no longer exists,
    // and an armed confirm is a question the user has not answered — drop it.
    disarmSessionClose();
    sessionListEl.innerHTML = "";

    var currentSearchQuery = sessionFilter;
    var needle = currentSearchQuery.trim().toLowerCase();
    var matched = 0;
    var inlineState = covenInlineState(covenDiscovery);
    // Walked once per render: every row tests membership against this list.
    var onCanvasIds = canvasThreadIds();

    state.projects.forEach(function (project) {
      var localRows = state.threads.filter(function (t) {
        return t.projectId === project.id && !t.hidden && !isDormantThread(t);
      });
      var remoteRows = covenSessionsForProject(project);
      var railModel = PsycheSessions.buildProjectRailModel(
        project, localRows, remoteRows, currentSearchQuery
      );
      var visibleWorktrees = railModel.worktrees.filter(function (entry) {
        return entry.rows.length > 0;
      });
      if (railModel.projectRows.length > 0) {
        visibleWorktrees.push({
          worktree: {
            path: "",
            branch: "Unresolved sessions",
            is_main: false,
            dirty: false,
            missing: true,
            collapsed: false,
            virtual: true,
          },
          matches: true,
          rows: railModel.projectRows,
        });
      }
      if (visibleWorktrees.length === 0) return;
      matched += visibleWorktrees.length + visibleWorktrees.reduce(function (count, entry) {
        return count + entry.rows.length;
      }, 0);

      var group = document.createElement("div");
      group.className = "session-group";

      var head = document.createElement("button");
      head.type = "button";
      head.className = "session-group-head";
      head.textContent = project.name;
      head.title = project.root || project.name;
      var projectAttention = visibleWorktrees.reduce(function (count, entry) {
        return count + entry.rows.filter(function (row) { return row.needsAttention; }).length;
      }, 0);
      if (projectAttention > 0) {
        var projectBadge = document.createElement("span");
        projectBadge.className = "session-attention-badge";
        projectBadge.textContent = String(projectAttention);
        projectBadge.setAttribute("aria-label", projectAttention + " sessions need attention");
        head.appendChild(projectBadge);
      }
      // The project header is the "show me everything again" affordance: it is
      // the one row that is above any set.
      head.addEventListener("click", function () {
        clearFocusSet();
        setActiveProject(project.id);
      });
      group.appendChild(head);

      visibleWorktrees.forEach(function (entry) {
        var worktree = entry.worktree;
        var threads = entry.rows
          .filter(function (row) { return row.source === "psyche"; })
          .map(function (row) { return row.value; });
        var covenSessions = entry.rows
          .filter(function (row) { return row.source === "coven"; })
          .map(function (row) { return row.value; });

        var worktreeGroup = document.createElement("div");
        worktreeGroup.className = "session-worktree-group" +
          (!worktree.virtual && project.selectedWorktreePath === worktree.path ? " selected" : "") +
          (worktree.missing ? " missing" : "");
        var worktreeHead = document.createElement("button");
        worktreeHead.type = "button";
        worktreeHead.className = "session-worktree-head";
        var worktreeName = worktree.branch || (worktree.is_main ? "main checkout" : shortenRoot(worktree.path));
        worktreeHead.innerHTML =
          '<span class="worktree-twisty">' + (worktree.collapsed ? "▶" : "▼") + "</span>" +
          '<span class="worktree-name">' + escapeHtml(worktreeName) + "</span>" +
          (worktree.dirty ? '<span class="worktree-state" title="Uncommitted changes">●</span>' : "") +
          (worktree.missing ? '<span class="worktree-warning" title="Worktree is missing">!</span>' : "");
        var worktreeAttention = entry.rows.filter(function (row) {
          return row.needsAttention;
        }).length;
        if (worktreeAttention > 0) {
          var worktreeBadge = document.createElement("span");
          worktreeBadge.className = "session-attention-badge";
          worktreeBadge.textContent = String(worktreeAttention);
          worktreeBadge.setAttribute(
            "aria-label", worktreeAttention + " sessions need attention in this worktree"
          );
          worktreeHead.appendChild(worktreeBadge);
        }
        worktreeHead.title = worktree.virtual ? "Sessions with no available worktree" : worktree.path;
        worktreeHead.disabled = Boolean(worktree.virtual);
        worktreeHead.addEventListener("click", async function () {
          if (worktree.virtual) return;
          if (!(await activateProjectWorktree(project, worktree.path))) return;
          worktree.collapsed = false;
        });
        worktreeHead.addEventListener("dblclick", function (event) {
          if (worktree.virtual) return;
          event.preventDefault();
          worktree.collapsed = !worktree.collapsed;
          refreshSidebar();
          saveWorkspaceSoon();
        });
        worktreeHead.addEventListener("keydown", function (event) {
          if (worktree.virtual || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
          var collapse = event.key === "ArrowLeft";
          if (worktree.collapsed === collapse) return;
          event.preventDefault();
          worktree.collapsed = collapse;
          refreshSidebar();
          saveWorkspaceSoon();
          requestAnimationFrame(function () {
            var heads = sessionListEl.querySelectorAll(".session-worktree-head");
            for (var i = 0; i < heads.length; i++) {
              if (heads[i].title === worktree.path) { heads[i].focus(); break; }
            }
          });
        });
        var hiddenThreads = state.threads.filter(function (thread) {
          return thread.projectId === project.id && thread.worktreePath === worktree.path &&
            thread.hidden;
        });
        if (!worktree.virtual) {
          worktreeHead.addEventListener("contextmenu", function (event) {
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
                run: async function () { await reopenThreadsForWorkspace(project, worktree.path); },
              });
            }
            openSessionContextMenu(event, actions);
          });
        }
        worktreeGroup.appendChild(worktreeHead);

        // Rows are grouped by what the pane actually is, so a worktree with a
        // mix of agent harnesses and plain shells reads at a glance.
        var groupedThreads = [];
        // A tool pane is neither an agent nor a shell: filing Git under Agents
        // would claim a model is running in it.
        var TOOL_KINDS = ["git", "web"];
        [["Agents", function (t) {
           var kind = t.kind || "shell";
           return kind !== "shell" && TOOL_KINDS.indexOf(kind) === -1;
         }],
         ["Tools", function (t) { return TOOL_KINDS.indexOf(t.kind || "shell") !== -1; }],
         ["Shells", function (t) { return (t.kind || "shell") === "shell"; }]]
          .forEach(function (kindGroup) {
            var hits = threads.filter(kindGroup[1]);
            if (!hits.length) return;
            groupedThreads.push({ label: kindGroup[0] });
            hits.forEach(function (thread) { groupedThreads.push({ thread: thread }); });
          });

        if (!worktree.collapsed) groupedThreads.forEach(function (entry) {
          if (entry.label) {
            var kindLabel = document.createElement("div");
            kindLabel.className = "session-subsection-label";
            kindLabel.textContent = entry.label;
            worktreeGroup.appendChild(kindLabel);
            return;
          }
          var thread = entry.thread;
          var onCanvas = onCanvasIds.indexOf(thread.id) !== -1;
          var wrapper = document.createElement("div");
          wrapper.className = "session-row-wrap";
          var row = document.createElement("button");
          row.type = "button";
          var kind = thread.kind || "shell";
          var picking = Boolean(setPicking);
          var picked = picking && isPicked(thread.id);
          var attentionLabel = thread.needsAttention
            ? PsycheSessions.attentionLabel(thread.attentionReason)
            : "";
          row.className = "session-row " + sessionStatusClass(thread) +
            " kind-" + (kind === "shell" ? "shell" : "agent") +
            (state.activeThreadId === thread.id ? " active" : "") +
            (thread.needsAttention ? " needs-attention" : "") +
            (picking ? " is-picking" : "") + (picked ? " is-picked" : "");
          row.dataset.threadId = thread.id;
          if (state.activeThreadId === thread.id) row.setAttribute("aria-current", "true");
          if (picking) row.setAttribute("aria-pressed", picked ? "true" : "false");
          row.title = picking
            ? (picked ? "Remove " : "Include ") + thread.name + " in the set"
            : thread.name + " — " + worktree.path +
              (attentionLabel ? " · " + attentionLabel : "") +
              (onCanvas ? " · on the canvas" : " · click to put it back on the canvas") +
              " · double-click to rename";
          var chipMarkup = "";
          if (thread.status === "exited") {
            chipMarkup = '<span class="session-chip muted">exited</span>';
          } else if (thread.spawning || thread.status === "starting") {
            chipMarkup = '<span class="session-chip">starting</span>';
          }
          var git = sessionGitState(worktree);
          row.innerHTML =
            '<span class="session-glyph ' + git.className + '" title="' + escapeHtml(git.tip) +
              '" aria-label="' + escapeHtml(git.tip) + '">' + escapeHtml(git.glyph) + "</span>" +
            '<span class="session-text">' +
              '<span class="session-title-row">' +
                '<span class="session-title">' + escapeHtml(thread.name) + "</span>" +
                // Same `!` the Coven rows and the group counts use, so one mark
                // means one thing throughout the rail. It rides in the title
                // row rather than the status column because the title is the
                // part of the row that survives every width.
                (attentionLabel
                  ? '<span class="session-attention-badge" title="' + escapeHtml(attentionLabel) +
                    '" aria-label="' + escapeHtml(attentionLabel) + '">!</span>'
                  : "") +
                (onCanvas
                  ? '<span class="session-oncanvas" title="On the canvas" aria-label="On the canvas">' +
                      '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">' +
                      '<rect x="1" y="1" width="10" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
                      '<rect x="3.2" y="3.2" width="5.6" height="5.6" rx="1" fill="currentColor"/></svg></span>'
                  : "") +
                sessionSetSwatches(thread) +
              "</span>" +
              '<span class="session-sub">' +
                escapeHtml(kind + " · " + sessionLaneLabel(worktree)) +
              "</span>" +
            "</span>" +
            '<span class="session-state"><span class="session-dot"></span>' + chipMarkup + "</span>";

          row.addEventListener("click", async function () {
            // While picking, a row is a checkbox — it must not also focus the
            // pane, or selecting would keep yanking the canvas around.
            if (setPicking) { toggleSetPick(thread.id); return; }
            if (project.id !== state.activeProjectId && !(await setActiveProject(project.id))) return;
            applySetScopeForThread(thread);
            await focusThread(thread.id);
          });
          var titleEl = row.querySelector(".session-title");
          function beginSessionRename(e) {
            e.stopPropagation();
            editLabelInline(titleEl, "sidebar", {
              initial: thread.name,
              host: wrapper,
              hide: row,
              ariaLabel: "Session name",
              onCommit: function (v) { renameThread(thread.id, v); },
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
          row.addEventListener("keydown", function (e) {
            if (e.key !== "F2") return;
            e.preventDefault();
            beginSessionRename(e);
          });
          row.addEventListener("contextmenu", function (event) {
            var memberships = setsForThread(thread);
            openSessionContextMenu(event, [
              { label: "Focus", run: function () { focusThread(thread.id); } },
              memberships.length
                ? { label: "Show only " + memberships[0].name, run: function () {
                    activateFocusSet(memberships[0].id);
                  } }
                : null,
              memberships.length
                ? { label: "Remove from " + memberships[0].name, run: function () {
                    removeFromFocusSet(memberships[0].id, thread.id);
                  } }
                : null,
              { label: "Rename…", run: function () {
                beginSessionRename({ stopPropagation: function () {} });
              } },
              thread.status !== "exited"
                ? { label: "Duplicate", run: function () { duplicateThread(thread); } }
                : null,
              thread.status !== "exited"
                ? { label: "Interrupt", run: function () { sendToThread(thread, "\x03"); } }
                : null,
              { label: "Hide", run: function () { hideThread(thread.id); } },
              // Stopping a session kills a process, so it never lands on one
              // click: the row arms a countdown that has to be confirmed and
              // cancels itself if it isn't.
              { label: "Stop and close", danger: true, run: function () {
                armSessionClose(wrapper, close, thread);
              } },
            ]);
          });

          var close = document.createElement("button");
          close.type = "button";
          close.className = "session-close";
          // Inside a set, × means "not part of this set" — the narrower, more
          // likely intent when the canvas is already scoped. Outside one it
          // detaches the pane's leaf from the tree and hides the row; the PTY
          // keeps running and the worktree menu reopens it. Both are reversible
          // and frequent, so both stay a single click. The timed confirm guards
          // "Stop and close", which is neither.
          var scopingSet = activeFocusSet();
          var inScopingSet = Boolean(scopingSet) &&
            scopingSet.threadIds.indexOf(thread.id) !== -1;
          close.title = inScopingSet
            ? "Remove from " + scopingSet.name + " — the pane stays open"
            : onCanvas
              ? "Hide the pane — the session keeps running"
              : "Hide session";
          close.setAttribute("aria-label", close.title);
          close.textContent = "×";
          close.addEventListener("click", function (e) {
            e.stopPropagation();
            if (inScopingSet) removeFromFocusSet(scopingSet.id, thread.id);
            else hideThread(thread.id);
          });
          wrapper.appendChild(row);
          wrapper.appendChild(close);
          worktreeGroup.appendChild(wrapper);
        });

        if (!worktree.collapsed && covenSessions.length > 0) {
          var covenLabel = document.createElement("div");
          covenLabel.className = "session-subsection-label";
          covenLabel.textContent = "Coven";
          worktreeGroup.appendChild(covenLabel);
        }

        if (!worktree.collapsed) covenSessions.forEach(function (session) {
          worktreeGroup.appendChild(createCovenSessionRow(project, session));
        });

        group.appendChild(worktreeGroup);
      });

      sessionListEl.appendChild(group);
    });

    if (inlineState) {
      var inline = document.createElement("div");
      inline.className = "session-inline-state " + inlineState.className;
      inline.textContent = inlineState.message;
      sessionListEl.appendChild(inline);
      matched += 1;
    }

    if (matched === 0) {
      var empty = document.createElement("div");
      empty.className = "session-empty";
      empty.textContent = needle
        ? "No sessions match “" + sessionFilter.trim() + "”"
        : state.projects.length
          ? "No matching projects, worktrees, or panes."
          : "No project open — ⌘O to add one.";
      sessionListEl.appendChild(empty);
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
    sessionSearchEl.addEventListener("input", function () {
      sessionFilter = sessionSearchEl.value || "";
      renderSessionList();
    });
    // Escape clears the filter rather than bubbling to the terminal.
    sessionSearchEl.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        sessionSearchEl.value = "";
        sessionFilter = "";
        renderSessionList();
        sessionSearchEl.blur();
        e.stopPropagation();
      }
    });
  }
  if (sessionListEl) {
    sessionListEl.addEventListener("keydown", function (event) {
      if (["ArrowDown", "ArrowUp", "Home", "End"].indexOf(event.key) === -1) return;
      var items = Array.prototype.filter.call(
        sessionListEl.querySelectorAll(
          ".session-group-head, .session-worktree-head:not(:disabled), .session-row, " +
          ".session-coven-row, .session-close"
        ),
        function (item) { return item.offsetParent !== null; }
      );
      if (!items.length) return;
      var current = items.indexOf(document.activeElement);
      var next = current;
      if (event.key === "Home") next = 0;
      else if (event.key === "End") next = items.length - 1;
      else if (event.key === "ArrowDown") next = Math.min(items.length - 1, current + 1);
      else next = current <= 0 ? 0 : current - 1;
      event.preventDefault();
      items[next].focus();
    });
  }

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
    threadIds.forEach(function (tid) { closeThread(tid, { focus: false }); });
    // Its file tabs go with it — they are scoped to the project.
    var dropped = state.openFiles.filter(function (f) { return f.projectId === id; });
    state.openFiles = state.openFiles.filter(function (f) { return f.projectId !== id; });
    if (dropped.some(function (f) { return f.id === state.activeFileId; })) {
      state.activeFileId = null;
      if (fileViewEl) fileViewEl.hidden = true;
      if (terminalHost) terminalHost.hidden = false;
    }
    // Remove the project from state.
    state.projects = state.projects.filter(function (p) { return p.id !== id; });
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
        renderPaneWorkspace();
        setStatus("no project — click + to open one", "");
      }
    }
    refreshTabs();
    syncProjectBrowser();
    saveWorkspaceSoon();
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

  function fileFocusThreadIsAvailable(thread, root, project, workspaceRoot) {
    return !!thread &&
      !thread.hidden &&
      thread.projectId === project.id &&
      thread.worktreePath === workspaceRoot &&
      !!PsychePanes.findLeafByThreadId(root, thread.id);
  }

  function resolveFileFocusThreadId(preferredId) {
    var project = activeProject();
    var layout = activePaneLayout();
    if (!project || !layout || !layout.root) return null;
    var root = scopedPaneRoot(layout);
    var workspaceRoot = activeWorkspaceRoot(project);
    var preferred = preferredId ? findThread(preferredId) : null;
    if (fileFocusThreadIsAvailable(preferred, root, project, workspaceRoot)) {
      return preferred.id;
    }

    var focused = layout.focusedLeafId
      ? PsychePanes.findLeafById(root, layout.focusedLeafId)
      : null;
    var focusedThread = focused ? findThread(focused.threadId) : null;
    if (fileFocusThreadIsAvailable(focusedThread, root, project, workspaceRoot)) {
      return focusedThread.id;
    }

    var leafIds = PsychePanes.leafIds(root);
    for (var i = 0; i < leafIds.length; i++) {
      var leaf = PsychePanes.findLeafById(root, leafIds[i]);
      var thread = leaf ? findThread(leaf.threadId) : null;
      if (fileFocusThreadIsAvailable(thread, root, project, workspaceRoot)) {
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
    renderPaneMinimap(activePaneLayout(), file);
    return true;
  }

  function clearFileFocusPresentation() {
    state.activeFileId = null;
    fileFocus.returnThreadId = null;
    terminalArea.classList.remove("is-file-focused");
    fileViewEl.hidden = true;
    terminalHost.hidden = false;
  }

  async function returnFromFileFocus(explicitThreadId, maximizeDestination) {
    if (!state.activeFileId) return false;
    var activeFile = findOpenFile(state.activeFileId);
    var destinationId = resolveFileFocusThreadId(
      explicitThreadId || fileFocus.returnThreadId
    );
    if (destinationId) {
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
      var threads = state.threads.filter(function (thread) {
        return thread.projectId === project.id;
      });
      var nextThreadId = project.lastActiveThreadId &&
        threads.some(function (thread) { return thread.id === project.lastActiveThreadId; })
          ? project.lastActiveThreadId
          : (threads[0] ? threads[0].id : null);
      state.activeThreadId = nextThreadId;
      renderPaneWorkspace();
      restoreProjectLayout(project);
      applyLayout("terminal", { persist: false });
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
      if (panelIsVisible("diffs")) renderDiffsPanel();
      if (currentPanel() === "git") renderGitPanel();
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
      saveWorkspaceNow();
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
    return spawnCovenThread();
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
      run: function () { if (state.activeThreadId) closeThread(state.activeThreadId); },
    },
    {
      cmd: "/preview",
      desc: "Load a URL in the browser pane: /preview localhost:5173",
      run: function (rest) {
        if (!rest) { applyLayout("split"); return; }
        applyLayout("split");
        navigateBrowser(rest);
      },
    },
    {
      cmd: "/browser-tab",
      desc: "Open a project-scoped browser tab: /browser-tab example.com",
      run: function (rest) {
        var tab = createBrowserTab(activeProject(), rest || "about:blank", true);
        applyLayout("split");
        if (tab && rest) navigateBrowser(rest, { tabId: tab.id, replace: true });
        else syncProjectBrowser();
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
      cmd: "/split",
      desc: "Toggle the Git tools dock",
      run: function () { toggleDock(); },
    },
    {
      cmd: "/browser",
      desc: "Open or focus the Web pane",
      run: function () { openBlankBrowserTab(); },
    },
    {
      cmd: "/terminal",
      desc: "Switch to terminal-only layout",
      run: function () { applyLayout("terminal"); },
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

  /** `!line` runs in the nearest shell pane regardless of composer scope. */
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
      // Not a slash command — pipe it to whatever the composer scope names.
      sendToScope(trimmed + "\n");
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

  // ---- Composer scope ----
  //
  // Plain text needs an explicit destination once several panes are visible at
  // once, so the composer carries a scope chip: the focused pane, every pane in
  // the project, or only the agent panes.
  var composerScope = "pane";
  var SCOPE_LABELS = { pane: "Pane", project: "Project", agents: "All agents" };

  function scopeTargets() {
    var project = activeProject();
    if (composerScope === "pane") {
      var focused = findThread(state.activeThreadId);
      return focused ? [focused] : [];
    }
    return state.threads.filter(function (thread) {
      if (!project || thread.projectId !== project.id) return false;
      if (thread.hidden || thread.status === "exited") return false;
      if (composerScope === "agents") return (thread.kind || "shell") !== "shell";
      return true;
    });
  }

  function sendToScope(text) {
    var targets = scopeTargets();
    if (!targets.length) {
      toast(composerScope === "pane" ? "No focused pane to send to" : "No pane matches this scope");
      return;
    }
    targets.forEach(function (thread) { sendToThread(thread, text); });
    if (targets.length > 1) toast("Sent to " + targets.length + " panes");
  }

  function syncComposerChrome() {
    var project = activeProject();
    var focused = findThread(state.activeThreadId);
    if (scopeBtnEl) scopeBtnEl.dataset.scope = composerScope;
    if (scopeLabelEl) {
      scopeLabelEl.textContent = composerScope === "pane"
        ? "Pane · " + (focused ? focused.name : "—")
        : composerScope === "project"
          ? "Project · " + (project ? project.name : "—")
          : "All agents · " + scopeTargets().length;
    }
    var paneDesc = document.getElementById("scope-desc-pane");
    if (paneDesc) {
      paneDesc.textContent = focused
        ? "Typed into " + focused.name
        : "Typed into the focused pane";
    }
    var projectDesc = document.getElementById("scope-desc-project");
    if (projectDesc && project) projectDesc.textContent = "Every pane in " + project.name;
    if (scopeMenuEl) {
      Array.prototype.forEach.call(scopeMenuEl.querySelectorAll("[data-scope]"), function (item) {
        item.setAttribute("aria-checked", item.dataset.scope === composerScope ? "true" : "false");
      });
    }
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
        : "→ " + (SCOPE_LABELS[composerScope] || "pane").toLowerCase();
    }
  }

  function closeScopeMenu() {
    if (scopeMenuEl) scopeMenuEl.hidden = true;
    if (scopeBtnEl) scopeBtnEl.setAttribute("aria-expanded", "false");
  }
  if (scopeBtnEl && scopeMenuEl) {
    scopeBtnEl.addEventListener("click", function () {
      var open = scopeMenuEl.hidden;
      if (open) { closeNewPaneMenu(); hidePalette(); syncComposerChrome(); }
      scopeMenuEl.hidden = !open;
      scopeBtnEl.setAttribute("aria-expanded", open ? "true" : "false");
    });
    Array.prototype.forEach.call(scopeMenuEl.querySelectorAll("[data-scope]"), function (item) {
      item.addEventListener("click", function () {
        composerScope = item.dataset.scope;
        closeScopeMenu();
        syncComposerChrome();
      });
    });
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
  function nativeBrowserLabel(raw) {
    var safe = String(raw || "default").split("").filter(function (c) {
      return /[A-Za-z0-9_-]/.test(c);
    }).join("").slice(0, 64) || "default";
    return "psyche-browser-" + safe;
  }
  function browserTabForNativeLabel(nativeLabel) {
    for (var i = 0; i < state.projects.length; i++) {
      var project = state.projects[i];
      ensureBrowserModel(project);
      var workspaceRoots = Object.keys(project.browsersByWorktree);
      for (var w = 0; w < workspaceRoots.length; w++) {
        var browser = project.browsersByWorktree[workspaceRoots[w]];
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
  function markBrowserTabLoaded(nativeLabel, url, title) {
    var pair = browserTabForNativeLabel(nativeLabel);
    if (!pair) return;
    pair.tab.loading = false;
    if (url) pair.tab.url = url;
    if (title && String(title).trim()) pair.tab.title = String(title).trim();
    else pair.tab.title = tabTitle(pair.tab.url);
    if (pair.project.id === state.activeProjectId && pair.browser === ensureBrowserModel(pair.project)) {
      renderBrowserTabs(); syncUrlInput();
    }
    saveWorkspaceSoon();
  }
  listen("browser:page-load", function (event) {
    var payload = event.payload || {};
    var pair = browserTabForNativeLabel(payload.label);
    if (!pair) return;
    if (payload.phase === "started") {
      pair.tab.loading = true;
    } else if (payload.phase === "finished") {
      markBrowserTabLoaded(payload.label, payload.url, "");
    }
    if (pair.project.id === state.activeProjectId && pair.browser === ensureBrowserModel(pair.project)) {
      renderBrowserTabs(); updateBrowserControls();
    }
  }).catch(function () {});
  listen("browser:title", function (event) {
    var payload = event.payload || {};
    markBrowserTabLoaded(payload.label, payload.url, payload.title);
  }).catch(function () {});
  listen("browser:focus", function (event) {
    markActiveSurface("browser");
    var payload = event.payload || {};
    var pair = browserTabForNativeLabel(payload.label);
    var pane = pair && findBrowserPane(pair.project.id, pair.worktreePath);
    if (pane && state.activeThreadId !== pane.id) focusThread(pane.id);
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
    var browser = ensureBrowserModel(project);
    if (!browser) return null;
    var maxTabs = Math.min(settings.maxBrowserTabsPerProject, HARD_MAX_BROWSER_TABS_PER_PROJECT);
    if (browser.tabs.length >= maxTabs) { setStatus("browser tab limit reached (" + maxTabs + "/project)", "warn"); return null; }
    var normalised = url && url !== "about:blank" ? normaliseUrl(url) : "about:blank";
    var tab = { id: makeBrowserTabId(), url: normalised || "about:blank", title: tabTitle(normalised), history: normalised && normalised !== "about:blank" ? [normalised] : [], historyIndex: normalised && normalised !== "about:blank" ? 0 : -1, created: false, loading: false };
    browser.tabs.push(tab);
    if (activate || !browser.activeTabId) { browser.activeTabId = tab.id; markActiveSurface("browser"); }
    renderBrowserTabs(); saveWorkspaceSoon(); return tab;
  }
  function closeBrowserTab(project, tabId) {
    project = project || activeProject();
    var browser = ensureBrowserModel(project); if (!browser) return;
    var idx = browser.tabs.findIndex(function (t) { return t.id === tabId; }); if (idx < 0) return;
    browser.tabs.splice(idx, 1);
    if (browser.activeTabId === tabId) { var next = browser.tabs[Math.min(idx, browser.tabs.length - 1)] || null; browser.activeTabId = next ? next.id : null; }
    renderBrowserTabs(); syncProjectBrowser(); saveWorkspaceSoon();
  }
  function activateBrowserTab(project, tabId) {
    project = project || activeProject();
    var browser = ensureBrowserModel(project);
    if (!browser || !browser.tabs.some(function (t) { return t.id === tabId; })) return;
    markActiveSurface("browser");
    browser.activeTabId = tabId;
    renderBrowserTabs(); syncProjectBrowser(); saveWorkspaceSoon();
  }
  async function openBlankBrowserTab() {
    var project = activeProject();
    if (!project) return null;
    var worktreePath = activeWorkspaceRoot(project);
    var existing = findBrowserPane(project.id, worktreePath);
    var pane = await createBrowserPane(project);
    if (!pane) return null;
    markActiveSurface("browser");
    var browser = ensureBrowserModel(project, worktreePath);
    var tab = null;
    if (existing || !browser.tabs.length) {
      tab = createBrowserTab(project, "about:blank", true);
    } else {
      renderBrowserTabs();
    }
    syncProjectBrowser();
    if (urlInput) urlInput.focus();
    return tab || currentBrowserTab(project);
  }
  listen("browser:shortcut-new-tab", function () {
    markActiveSurface("browser");
    var browser = ensureBrowserModel(project, worktreePath);
    var tab = null;
    if (existing || !browser.tabs.length) {
      tab = createBrowserTab(project, "about:blank", true);
    } else {
      renderBrowserTabs();
    }
    syncProjectBrowser();
    if (urlInput) urlInput.focus();
    return tab || currentBrowserTab(project);
  }
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
      btn.addEventListener("click", function (event) { if (event.target && event.target.classList.contains("browser-tab-close")) closeBrowserTab(project, tab.id); else activateBrowserTab(project, tab.id); });
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
  function syncProjectBrowser() { renderBrowserTabs(); syncBrowserBounds(); }
  function syncBrowserBounds() {
    var project = activeProject(); var tab = currentBrowserTab(project); var label = browserLabelForTab(project, tab); var b = visibleBrowserBounds();
    if (!b || !tab || !tab.created) { invoke("browser_hide_all_except", { label: null }).catch(function () {}); return; }
    invoke("browser_hide_all_except", { label: label }).catch(function () {});
    invoke("browser_set_bounds", { label: label, x: b.x, y: b.y, w: b.w, h: b.h }).catch(function () {});
  }
  async function navigateBrowser(rawUrl, opts) {
    opts = opts || {}; var project = activeProject(); if (!project) return;
    var pane = await createBrowserPane(project); if (!pane) return;
    var browser = ensureBrowserModel(project); var tab = opts.tabId ? browser.tabs.find(function (t) { return t.id === opts.tabId; }) : currentBrowserTab(project);
    if (!tab) tab = createBrowserTab(project, rawUrl || "about:blank", true); if (!tab) return;
    browser.activeTabId = tab.id;
    var b = visibleBrowserBounds(); if (!b) return;
    var normalised = normaliseUrl(rawUrl); if (!normalised) return;
    tab.loading = true; tab.title = tabTitle(normalised); renderBrowserTabs(); updateBrowserControls();
    var label = browserLabelForTab(project, tab);
    invoke("browser_navigate", { label: label, url: normalised, x: b.x, y: b.y, w: b.w, h: b.h }).then(function () {
      tab.created = true; tab.url = normalised;
      if (!opts.fromHistory && !opts.preserveHistory) { tab.history = opts.replace ? [] : tab.history.slice(0, tab.historyIndex + 1); tab.history.push(normalised); tab.historyIndex = tab.history.length - 1; }
      if (previewEmpty) previewEmpty.hidden = true;
      renderBrowserTabs(); syncUrlInput(); saveWorkspaceSoon(); invoke("browser_hide_all_except", { label: label }).catch(function () {});
      setTimeout(function () {
        if (tab.loading && tab.url === normalised) markBrowserTabLoaded(nativeBrowserLabel(label), normalised, "");
      }, 4500);
    }).catch(function (err) { tab.loading = false; renderBrowserTabs(); updateBrowserControls(); writeToActive("\r\n\x1b[31m[browser_navigate]\x1b[0m " + err + "\r\n"); });
  }
  function normaliseUrl(value) {
    if (!value) return ""; var trimmed = String(value).trim(); if (!trimmed) return ""; if (trimmed === "about:blank") return trimmed;
    if (trimmed.indexOf("://") === -1) { var local = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\.|::1)/i.test(trimmed); trimmed = (local ? "http://" : "https://") + trimmed; }
    try { new URL(trimmed); return trimmed; } catch (_) { return ""; }
  }
  urlInput.addEventListener("keydown", function (e) { if (e.key === "Enter") navigateBrowser(urlInput.value); });
  document.getElementById("reload").addEventListener("click", function () {
    var project = activeProject(); var tab = currentBrowserTab(project);
    if (tab && tab.created) { tab.loading = true; renderBrowserTabs(); updateBrowserControls(); invoke("browser_reload", { label: browserLabelForTab(project, tab) }).catch(function () {}).finally(function () { setTimeout(function () { tab.loading = false; renderBrowserTabs(); updateBrowserControls(); }, 350); }); }
  });
  document.getElementById("back").addEventListener("click", function () { var tab = currentBrowserTab(); if (tab && tab.historyIndex > 0) { tab.historyIndex -= 1; navigateBrowser(tab.history[tab.historyIndex], { fromHistory: true }); saveWorkspaceSoon(); } });
  document.getElementById("forward").addEventListener("click", function () { var tab = currentBrowserTab(); if (tab && tab.historyIndex < tab.history.length - 1) { tab.historyIndex += 1; navigateBrowser(tab.history[tab.historyIndex], { fromHistory: true }); saveWorkspaceSoon(); } });
  document.getElementById("open-external").addEventListener("click", function () { var tab = currentBrowserTab(); if (tab && tab.url && tab.url !== "about:blank" && openUrl) openUrl(tab.url).catch(function () {}); });
  if (typeof ResizeObserver === "function") { var ro = new ResizeObserver(function () { syncBrowserBounds(); }); ro.observe(preview); ro.observe(detail); }
  window.addEventListener("beforeunload", saveWorkspaceNow);
  document.addEventListener("visibilitychange", handleVisibilityChange);

  // -------- Resizable splitter between canvas and Git dock --------
  //
  // Pointer events use horizontal clamping so neither side can collapse past
  // its CSS minimum while the divider is dragged.
  //
  // Overflow note: while dragging, `.detail.resizing` disables the
  // grid-template transition so the layout snaps instantly to each
  // fraction, keeping the painted child WKWebView in sync with the DOM.

  var splitter = document.getElementById("splitter");
  if (splitter) {
    var dragging = false;
    var splitFrame = 0;

    // The splitter only ever divides the canvas from the tools dock now, so
    // the clamp is always horizontal.
    function splitClampBounds() {
      var rect = detail.getBoundingClientRect();
      var styles = window.getComputedStyle(detail);
      var size = rect.width;
      var termMin = parseFloat(styles.getPropertyValue("--terminal-min")) || 220;
      var brMin   = parseFloat(styles.getPropertyValue("--browser-min")) || 220;
      var splitW  = parseFloat(styles.getPropertyValue("--splitter-w")) || 10;
      var min = Math.max(0.2, termMin / size);
      var max = Math.min(0.85, (size - brMin - splitW) / size);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
        min = 0.2; max = 0.85;
      }
      return { rect: rect, min: min, max: max };
    }

    function scheduleSplitLayoutSync() {
      if (splitFrame) return;
      splitFrame = requestAnimationFrame(function () {
        splitFrame = 0;
        scheduleVisiblePaneFit();
        syncBrowserBounds();
      });
    }

    function setSplitFrac(frac) {
      var bounds = splitClampBounds();
      var next = Math.max(bounds.min, Math.min(bounds.max, frac));
      setDetailSplitFrac(next.toFixed(4));
      splitter.setAttribute("aria-valuenow", String(Math.round(next * 100)));
      rememberProjectLayout();
      scheduleSplitLayoutSync();
      return next;
    }

    // `--split-frac` is always the *terminal* pane's share. Inverted on
    // leading-edge sides (left/top) so the divider always tracks the pointer.
    function splitFracFromEvent(e) {
      var b = splitClampBounds();
      return (e.clientX - b.rect.left) / b.rect.width;
    }

    splitter.addEventListener("pointerdown", function (e) {
      if (currentLayout() !== "split") return;
      dragging = true;
      splitter.classList.add("dragging");
      detail.classList.add("resizing");
      document.body.classList.add("split-resizing");
      document.body.dataset.axis = "x";
      try { splitter.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    splitter.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      setSplitFrac(splitFracFromEvent(e));
      e.preventDefault();
    });
    function endSplitDrag(e) {
      if (!dragging) return;
      dragging = false;
      splitter.classList.remove("dragging");
      detail.classList.remove("resizing");
      document.body.classList.remove("split-resizing");
      delete document.body.dataset.axis;
      if (e && typeof e.pointerId === "number") {
        try { splitter.releasePointerCapture(e.pointerId); } catch (_) {}
      }
      scheduleSplitLayoutSync();
    }
    splitter.addEventListener("pointerup", endSplitDrag);
    splitter.addEventListener("pointercancel", endSplitDrag);

    // Keyboard on focused splitter: arrow keys shift --split-frac. Direction
    // tracks the side so the splitter feels physical. Shift halves the step.
    splitter.addEventListener("keydown", function (e) {
      if (currentLayout() !== "split") return;
      var current = currentSplitFrac();
      var step = e.shiftKey ? 0.01 : 0.04;
      var grow = "ArrowRight", shrink = "ArrowLeft";
      if (e.key === shrink)    { setSplitFrac(current - step); e.preventDefault(); }
      else if (e.key === grow) { setSplitFrac(current + step); e.preventDefault(); }
    });
    setSplitFrac(currentSplitFrac());
  }

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

  document.addEventListener("keydown", async function (e) {
    if (routeAgentPickerModalKeydown(e)) return;
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
    if (e.key === "\\") { toggleDock(); e.preventDefault(); return; }
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
    // ⌘⌥B toggles the Git tools dock. Match by code so option-B (which
    // produces ∫ on macOS) still resolves to KeyB.
    if (e.code === "KeyB" && e.altKey) { toggleDock(); e.preventDefault(); return; }
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
  // 11a. Shell chrome — sidebar, dock, new-pane menu, help
  // ============================================================

  function sidebarOpen() { return !appEl || appEl.dataset.sidebar !== "collapsed"; }
  function setSidebarOpen(open) {
    if (!appEl) return;
    appEl.dataset.sidebar = open ? "open" : "collapsed";
    if (sidebarMiniEl) sidebarMiniEl.hidden = open;
    if (!open) closeNewPaneMenu();
    requestAnimationFrame(function () {
      scheduleVisiblePaneFit();
      syncBrowserBounds();
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
  onRailClick("dock-collapse", function () { applyLayout("terminal"); });

  // Sidebar width is a CSS custom property so the grid, the rails and the
  // splitter clamps all read one number.
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
        requestAnimationFrame(function () { scheduleVisiblePaneFit(); syncBrowserBounds(); });
      }
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  function closeNewPaneMenu() {
    if (newPaneMenuEl) newPaneMenuEl.hidden = true;
    var trigger = document.getElementById("rail-new-tab");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
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
      closeScopeMenu();
    }
    newPaneMenuEl.hidden = !open;
    var trigger = document.getElementById("rail-new-tab");
    if (trigger) trigger.setAttribute("aria-expanded", open ? "true" : "false");
  }
  function onMenuClick(id, handler) {
    var el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("click", function () { closeNewPaneMenu(); handler(); });
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
  onMenuClick("new-pane-set", function () { beginSetPicking(); });
  onMenuClick("new-pane-project", function () { openProjectPicker(); });

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
    if (scopeMenuEl && !scopeMenuEl.hidden &&
        !scopeMenuEl.contains(event.target) &&
        !event.target.closest("#scope-btn")) {
      closeScopeMenu();
    }
  });

  // ---- Keyboard shortcuts overlay ----
  var HELP_ROWS = [
    ["Open the composer", "⌘K"],
    ["Toggle the sessions sidebar", "⌘B"],
    ["Toggle the tools dock", "⌘⌥B"],
    ["Focus a pane on the canvas", "⌃1–9"],
    ["Resize a pane split", "drag the divider"],
    ["New terminal pane", "⌘T"],
    ["Choose an agent", "⌘P"],
    ["New browser tab", "Web pane +"],
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
      var menuWasOpen = (newPaneMenuEl && !newPaneMenuEl.hidden) ||
        (scopeMenuEl && !scopeMenuEl.hidden);
      closeNewPaneMenu();
      closeScopeMenu();
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
  /** Working-tree file count, mirrored onto the dock's Git tab. */
  var gitChangesCountEl = document.getElementById("git-changes-count");
  function setDockGitCount(count) {
    // The count rides both the dock tab and the Changes tab, so the number of
    // pending changes is legible whether or not the panel is open.
    if (gitChangesCountEl) {
      gitChangesCountEl.textContent = String(count || 0);
      gitChangesCountEl.hidden = !count;
    }
    if (!dockGitCountEl) return;
    dockGitCountEl.textContent = String(count || 0);
    dockGitCountEl.hidden = !count;
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

  function panelIsVisible(panel) {
    return currentLayout() === "split" && currentPanel() === resolvePanelName(panel);
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

  function currentDiffRequestMatches(projectId, key, generation) {
    var project = activeProject();
    return diffRequestGate.isCurrent(generation) &&
      selectedDiffKey === key &&
      !!project && project.id === projectId &&
      panelIsVisible("diffs");
  }

  async function renderDiffsPanel() {
    if (!diffFilesEl) return;
    if (!panelIsVisible("diffs")) return;
    var panelGeneration = diffPanelRequestGate.next();
    diffRequestGate.next();
    var project = activeProject();
    if (!project) {
      panelMessage(diffFilesEl, "No project open — ⌘O to add one.");
      clearDiffSelection("");
      if (diffsSummaryEl) diffsSummaryEl.textContent = "";
      return;
    }
    resetDiffDetail("Loading changes…");
    panelMessage(diffFilesEl, "Loading changes…");
    if (diffsSummaryEl) diffsSummaryEl.textContent = "loading…";
    var projectId = project.id;
    var status;
    try {
      status = await invoke("git_status", { root: activeWorkspaceRoot(project) });
    } catch (err) {
      if (!diffPanelRequestGate.isCurrent(panelGeneration) ||
          !activeProject() || activeProject().id !== projectId ||
          !panelIsVisible("diffs")) return;
      panelMessage(diffFilesEl, String(err), "panel-error");
      clearDiffSelection("");
      if (diffsSummaryEl) diffsSummaryEl.textContent = "error";
      return;
    }
    if (!diffPanelRequestGate.isCurrent(panelGeneration) ||
        !activeProject() || activeProject().id !== projectId ||
        !panelIsVisible("diffs")) return;
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
    setDockGitCount(status.files.length);
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
      var key = diffCacheKey(project.id, activeWorkspaceRoot(project), f.path, stagedDiffFor(f), diffContext);
      row.className = "diff-row " + kind + (selectedDiffKey === key ? " selected" : "");
      row.title = f.path;
      row.innerHTML =
        '<span class="diff-code">' + escapeHtml(f.code) + "</span>" +
        '<span class="diff-path">' + escapeHtml(shortenRelPath(f.path)) + "</span>";
      row.addEventListener("click", function () { showDiff(project, f); });
      diffFilesEl.appendChild(row);
    });

    // Auto-open the first file so the panel is never a blank list.
    var target = status.files.find(function (f) {
      return diffCacheKey(project.id, activeWorkspaceRoot(project), f.path, stagedDiffFor(f), diffContext) === selectedDiffKey;
    }) || status.files[0];
    showDiff(project, target);
  }

  var shownDiffTarget = null;

  /** Re-fetch whatever is on screen, at the current context width. */
  function refreshSelectedDiff() {
    if (!shownDiffTarget) return;
    showDiff(shownDiffTarget.project, shownDiffTarget.entry, { keepContext: true });
  }

  async function showDiff(project, entry, options) {
    if (!project || !entry || !diffRowsEl) return;
    // A new file starts narrow again: an expansion belongs to the view you
    // expanded, not to the panel.
    if (!(options && options.keepContext)) diffContext = null;
    shownDiffTarget = { project: project, entry: entry };
    if (!activeProject() || activeProject().id !== project.id || !panelIsVisible("diffs")) return;
    var staged = stagedDiffFor(entry);
    var key = diffCacheKey(project.id, activeWorkspaceRoot(project), entry.path, staged, diffContext);
    var generation = diffRequestGate.next();
    selectedDiffKey = key;
    diffFilesEl.parentNode.classList.add("has-detail");
    Array.prototype.forEach.call(diffFilesEl.children, function (el) {
      el.classList.toggle("selected", el.title === entry.path);
    });
    var cached = diffCache.get(key);
    if (cached !== undefined) {
      if (!currentDiffRequestMatches(project.id, key, generation)) return;
      renderDiffResult(cached);
      return;
    }
    resetDiffDetail("Loading diff…");
    try {
      var result = await invoke("git_diff", {
        root: activeWorkspaceRoot(project),
        path: entry.path,
        staged: staged,
        context: diffContext,
      });
      if (!currentDiffRequestMatches(project.id, key, generation)) return;
      diffCache.set(key, result);
      renderDiffResult(result);
    } catch (err) {
      if (!currentDiffRequestMatches(project.id, key, generation)) return;
      resetDiffDetail("Unable to load diff: " + String(err));
    }
  }

  function refreshDiffs() {
    var project = activeProject();
    if (project) invalidateProjectDiffs(project.id);
    renderDiffsPanel();
  }

  onRailClick("diffs-refresh", refreshDiffs);

  // ---- Git / GitHub ----

  async function renderGitPanel() {
    if (!gitViewEl) return;
    var project = activeProject();
    if (!project) { panelMessage(gitViewEl, "No project open — ⌘O to add one."); return; }
    gitViewEl.innerHTML = "";
    if (gitBranchEl) gitBranchEl.textContent = "";
    gitRemoteWebUrl = null;
    if (gitOpenRemoteBtn) gitOpenRemoteBtn.disabled = true;

    var status, commits;
    try {
      var workspaceRoot = activeWorkspaceRoot(project);
      status = await invoke("git_status", { root: workspaceRoot });
      commits = status.is_repo ? await invoke("git_log", { root: workspaceRoot, limit: 30 }) : [];
    } catch (err) {
      panelMessage(gitViewEl, String(err), "panel-error");
      return;
    }
    if (!status.is_repo) { panelMessage(gitViewEl, "Not a git repository."); return; }

    gitRemoteWebUrl = status.web_url || null;
    if (gitOpenRemoteBtn) gitOpenRemoteBtn.disabled = !gitRemoteWebUrl;
    if (gitBranchEl) gitBranchEl.textContent = status.branch || "(detached)";
    setDockGitCount((status.files || []).length);

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

  onRailClick("git-refresh", function () { renderGitPanel(); });
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
    project.root = canonicalRoot;
    project.selectedWorktreePath = remapPath(project.selectedWorktreePath);
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
      target.selectedWorktreePath = incoming.selectedWorktreePath;
      target.layout = incoming.layout;
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
    ensureProjectLayout(project);
    state.projects.push(project);
    state.activeProjectId = project.id;
    restoreProjectLayout(project);
    refreshSidebar();
    await refreshProjectWorktrees(project);
    syncProjectBrowser();
    saveWorkspaceSoon();
    startCovenPolling();
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
      var project = await addProject(selected);
      if (project) {
        var covenThread = await ensureProjectCoven(project);
        if (covenThread) setProjectStatus(project, "ok");
      }
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
    closeScopeMenu();
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
      command = state.env && state.env.coven_path;
      if (!command) {
        setStatus("Coven CLI not found — install @opencoven/cli and restart Psyche", "error");
        return null;
      }
    }
    if (!(await showTerminalView())) return null;
    return createThread({
      project: project,
      worktreePath: worktree.path,
      name: entry.label,
      kind: entry.kind,
      command: command,
      args: entry.args.slice(),
      launchKind: entry.kind === "coven-chat" ? entry.kind : null,
      projectRoot: project.root,
      cwd: worktree.path,
    });
  }

  function covenChatLaunch(project, worktreePath) {
    var worktree = worktreePath ? { path: worktreePath } : selectedWorktree(project);
    return {
      command: state.env.coven_path,
      args: ["chat"],
      env: {},
      projectRoot: project.root,
      cwd: worktree.path,
      kind: "coven-chat",
      launchKind: "coven-chat",
      covenSessionId: null,
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
        t.kind === "coven-chat" && t.status !== "exited" && !t.hidden;
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
      command: state.env && state.env.default_shell ? state.env.default_shell : "/bin/zsh",
      args: ["-l"],
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
    // Spawn psyche through a login shell so it inherits your full user
    // environment. Wrap with a tmux socket isolation so the embedded psyche
    // doesn't collide with any tmux server already running outside the app.
    var shell = (state.env.default_shell) || "/bin/zsh";
    var quoted = function (s) {
      return "'" + String(s).replace(/'/g, "'\\''") + "'";
    };
    var cmd = "exec " + quoted(state.env.node_path) + " " + quoted(state.env.psyche_entry);
    var project = activeProject();
    var worktree = selectedWorktree(project);
    return createThread({
      project: project,
      name: "psyche",
      kind: "psyche",
      command: shell,
      args: ["-l", "-c", cmd],
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
    var saved = readSavedWorkspace();
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
      if (project) restoreProjectLayout(project);
      isRestoringWorkspace = false;
      await Promise.all(state.projects.map(function (savedProject) {
        return refreshProjectWorktrees(savedProject);
      }));
    }
    if (!project) project = await addProject(bootRoot);
    if (project) {
      await ensureProjectCoven(project);
      var activeTab = currentBrowserTab(project);
      if (activeTab && activeTab.created && activeTab.url && activeTab.url !== "about:blank") navigateBrowser(activeTab.url, { tabId: activeTab.id, preserveHistory: true });
      restoreProjectLayout(project);
    }
    refreshSidebar(); refreshTabs(); renderBrowserTabs(); syncProjectBrowser(); loadAgentSkills(); saveWorkspaceNow();
    startCovenPolling();
  }

  invoke("app_environment")
    .then(boot)
    .catch(function (err) {
      showBootError("app_environment failed: " + err);
    });
})();
