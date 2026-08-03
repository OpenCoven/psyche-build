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
  function activeProjectThreads() {
    var p = activeProject();
    if (!p) return [];
    return state.threads.filter(function (t) { return t.projectId === p.id; });
  }
  async function setActiveProject(id) {
    if (state.activeProjectId === id) return true;
    if (!(await showTerminalView())) return false;
    state.activeProjectId = id;
    var project = findProject(id);
    if (!project) return false;
    restoreProjectLayout(project);
    // Refresh agent skill suggestions for the new project's `.claude` tree.
    loadAgentSkills();
    // Restore the project's last-focused thread, falling back to its first.
    var threads = state.threads.filter(function (t) { return t.projectId === id; });
    var nextId = project.lastActiveThreadId &&
      threads.some(function (t) { return t.id === project.lastActiveThreadId; })
        ? project.lastActiveThreadId
        : (threads[0] ? threads[0].id : null);
    if (nextId) {
      await focusThread(nextId);
    } else {
      state.activeThreadId = null;
      Array.prototype.forEach.call(terminalHost.children, function (el) {
        el.classList.remove("active");
      });
      refreshSidebar();
      refreshTabs();
      syncProjectBrowser();
      ensureProjectPsyche(project);
      setStatus("no pane — launching psyche…", "");
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

  function persistableProject(project) {
    return { id: project.id, name: project.name, root: project.root, layout: ensureProjectLayout(project), browser: ensureBrowserModel(project) };
  }
  function saveWorkspaceNow() {
    if (isRestoringWorkspace) return;
    try {
      localStorage.setItem(WORKSPACE_STATE_KEY, JSON.stringify({ version: 1, activeProjectId: state.activeProjectId || null, projects: state.projects.map(persistableProject).slice(0, HARD_MAX_PROJECTS) }));
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
      layout: {
        mode: saved.layout && saved.layout.mode ? saved.layout.mode : "terminal",
        side: saved.layout && saved.layout.side ? saved.layout.side : "right",
        splitFrac: typeof (saved.layout && saved.layout.splitFrac) === "number" ? saved.layout.splitFrac : 0.6,
      },
      browser: { tabs: [], activeTabId: null },
    };
    var savedBrowser = saved.browser || {};
    if (Array.isArray(savedBrowser.tabs)) {
      project.browser.tabs = savedBrowser.tabs.slice(0, HARD_MAX_BROWSER_TABS_PER_PROJECT).map(function (tab) {
        var url = tab.url || "about:blank";
        var history = Array.isArray(tab.history) ? tab.history.filter(Boolean).slice(-50) : [];
        return { id: tab.id || makeBrowserTabId(), url: url, title: tab.title || tabTitle(url), history: history, historyIndex: clampInt(tab.historyIndex, history.length ? history.length - 1 : -1, -1, Math.max(-1, history.length - 1)), created: !!tab.created && url !== "about:blank", loading: false };
      });
    }
    project.browser.activeTabId = savedBrowser.activeTabId || (project.browser.tabs[0] && project.browser.tabs[0].id) || null;
    return project;
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
  var browserPane = document.querySelector(".browser-pane");
  var activeSurface = "terminal";

  function markActiveSurface(surface) {
    activeSurface = surface === "browser" ? "browser" : "terminal";
    if (detail) detail.dataset.activeSurface = activeSurface;
  }

  if (terminalArea) {
    terminalArea.addEventListener("pointerdown", function () { markActiveSurface("terminal"); }, true);
    terminalArea.addEventListener("focusin", function () { markActiveSurface("terminal"); }, true);
  }
  if (browserPane) {
    browserPane.addEventListener("pointerdown", function () { markActiveSurface("browser"); }, true);
    browserPane.addEventListener("focusin", function () { markActiveSurface("browser"); }, true);
  }

  function setStatus(text, level) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = "status-pill " + (level || "");
  }
  function setProjectStatus(project, level) {
    project = project || activeProject();
    var statusLevel = level || "ok";
    if (statusLevel === "ok") setStatus("psyche is ready", "ok");
    else if (statusLevel === "") setStatus(project ? project.name : "ready", "");
    else setStatus(project ? project.name : "ready", statusLevel);
  }

  // ============================================================
  // 4. Layout — single collapse trigger replaces the 3-button switcher.
  //    State is split across two data attributes on `#detail`:
  //      data-layout       = "terminal" | "split" | "browser"
  //      data-browser-side = "right" | "bottom" | "left" | "top"
  //    `--split-frac` is always the fraction of the *terminal* pane in split.
  // ============================================================

  // Every [data-browser-toggle] control (titlebar chrome button + right rail)
  // reflects and drives the same split/terminal state.
  var browserToggleBtns = Array.prototype.slice.call(
    document.querySelectorAll("[data-browser-toggle]")
  );
  var browserCollapseBtn = document.getElementById("browser-collapse");
  var BROWSER_SIDES = ["right", "bottom", "left", "top"];
  var PANELS = ["browser", "files", "diffs", "git"];
  var detailStyleRule = null;

  function currentLayout() { return detail.dataset.layout || "terminal"; }
  function currentSide()   { return detail.dataset.browserSide || "right"; }
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
    if (!project.layout) project.layout = { mode: "terminal", side: "right", splitFrac: 0.6 };
    return project.layout;
  }
  function rememberProjectLayout(project) {
    project = project || activeProject();
    var layout = ensureProjectLayout(project);
    if (!layout) return;
    layout.mode = currentLayout();
    layout.side = currentSide();
    layout.splitFrac = currentSplitFrac();
    layout.panel = currentPanel();
    saveWorkspaceSoon();
  }
  function restoreProjectLayout(project) {
    var layout = ensureProjectLayout(project);
    if (!layout) return;
    var previousLayout = currentLayout();
    setDetailSplitFrac(layout.splitFrac || 0.6);
    // Set the panel before the layout so syncBrowserBounds sees the right one.
    setPanel(layout.panel || project.panel || "browser", { render: false });
    applyLayout(layout.mode || "terminal", { side: layout.side || "right", persist: false });
    // Panels read from the project root, so re-render for the project we just
    // switched to rather than showing the previous one's tree/diff/log.
    if (previousLayout === "split" && currentLayout() === "split") {
      renderPanel(currentPanel());
    }
  }

  function applyLayout(layout, opts) {
    var previousLayout = currentLayout();
    var side = (opts && opts.side) || currentSide();
    // Back-compat: older slash commands still pass "splitV" — treat as split-right.
    if (layout === "splitV") { layout = "split"; side = "right"; }
    detail.dataset.layout = layout;
    detail.dataset.browserSide = side;
    if (layout === "browser") markActiveSurface("browser");
    else if (layout === "terminal") markActiveSurface("terminal");
    if (!opts || opts.persist !== false) rememberProjectLayout();
    browserToggleBtns.forEach(function (btn) {
      btn.setAttribute("aria-pressed", layout === "split" ? "true" : "false");
    });
    syncPanelButtons();
    // For role="separator", orientation describes the line: vertical for
    // a left/right divider, horizontal for a top/bottom divider.
    var splitterEl = document.getElementById("splitter");
    if (splitterEl) {
      var isHorizontalDivider = side === "bottom" || side === "top";
      splitterEl.setAttribute("aria-orientation", isHorizontalDivider ? "horizontal" : "vertical");
    }
    handlePanelLayoutTransition(previousLayout, layout);
    requestAnimationFrame(function () {
      fitActiveTerm();
      syncBrowserBounds();
    });
  }

  function handlePanelLayoutTransition(previousLayout, nextLayout) {
    var panel = currentPanel();
    if (previousLayout === "split" && nextLayout !== "split" && panel === "diffs") {
      suspendDiffRequests();
    }
    if (previousLayout !== "split" && nextLayout === "split") {
      renderPanel(panel);
    }
  }

  function toggleBrowser() {
    applyLayout(currentLayout() === "split" ? "terminal" : "split");
  }
  function cycleBrowserSide(direction) {
    var idx = BROWSER_SIDES.indexOf(currentSide());
    if (idx < 0) idx = 0;
    var step = direction === -1 ? -1 : 1;
    var next = BROWSER_SIDES[(idx + step + BROWSER_SIDES.length) % BROWSER_SIDES.length];
    applyLayout("split", { side: next });
  }

  browserToggleBtns.forEach(function (btn) {
    btn.addEventListener("click", toggleBrowser);
    // Right-click cycles side without changing visibility on/off.
    btn.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      cycleBrowserSide(e.shiftKey ? -1 : 1);
    });
  });
  if (browserCollapseBtn) {
    browserCollapseBtn.addEventListener("click", function () {
      applyLayout("terminal");
    });
  }
  // ---- Right-rail panel switching ----
  // The rail is a radio group over the right pane's four panels. Clicking the
  // panel that is already showing collapses the pane, so one button both opens
  // and closes — the usual activity-bar behaviour.
  function currentPanel() {
    var p = detail.dataset.panel;
    return PANELS.indexOf(p) === -1 ? "browser" : p;
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
    if (PANELS.indexOf(name) === -1) name = "browser";
    detail.dataset.panel = name;
    var project = activeProject();
    if (project) project.panel = name;
    if (!opts || opts.render !== false) renderPanel(name);
    // The browser is a native child webview layered over the DOM — it has to be
    // hidden whenever a different panel owns the pane, or it paints on top.
    syncBrowserBounds();
    syncPanelButtons();
  }
  function renderPanel(name) {
    if (name === "files") renderFilesPanel();
    else if (name === "diffs") renderDiffsPanel();
    else if (name === "git") renderGitPanel();
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
    if (thread && thread.term) {
      thread.term.write(bytes);
    } else {
      var arr = pendingDataBuffers.get(payload.thread_id) || [];
      arr.push(bytes);
      pendingDataBuffers.set(payload.thread_id, arr);
    }
  }).catch(function () {});

  listen("pty:exit", function (event) {
    var payload = event.payload || {};
    var thread = findThread(payload.thread_id);
    if (!thread) return;
    thread.status = "exited";
    if (thread.term) {
      thread.term.write("\r\n\x1b[2;90m[process exited]\x1b[0m\r\n");
    }
    refreshSidebar();
    refreshTabs();
    if (state.activeThreadId === thread.id) {
      setProjectStatus(findProject(thread.projectId), "warn");
    }
  }).catch(function () {});

  function findThread(id) {
    for (var i = 0; i < state.threads.length; i++) {
      if (state.threads[i].id === id) return state.threads[i];
    }
    return null;
  }

  // ============================================================
  // 6. Threads — create / focus / close
  // ============================================================

  var threadCounter = 0;
  function makeThreadId() {
    threadCounter += 1;
    return "t" + Date.now().toString(36) + "-" + threadCounter;
  }

  function createThread(opts) {
    var id = makeThreadId();
    var project = opts.project || activeProject();
    var thread = {
      id: id,
      projectId: project ? project.id : null,
      name: opts.name || "thread " + (state.threads.length + 1),
      kind: opts.kind || "shell",
      command: opts.command,
      args: opts.args || [],
      env: opts.env || {},
      status: "starting",
      spawning: true,
      term: null,
      fit: null,
      host: null,
    };
    state.threads.push(thread);
    refreshSidebar();
    refreshTabs();
    mountTerminal(thread);
    focusThread(id);
    // Run fit() now so the PTY starts at the actual visible size, not at
    // xterm.js's default 80x24. Otherwise psyche/Ink draw the first frame at
    // the wrong size and leave artifacts.
    requestAnimationFrame(function () {
      try { if (thread.fit) thread.fit.fit(); } catch (_) {}
      spawnPty(thread, opts.projectRoot || (project && project.root));
    });
    return thread;
  }

  function spawnPty(thread, projectRoot) {
    invoke("pty_start", {
      options: {
        threadId: thread.id,
        thread_id: thread.id,
        projectRoot: projectRoot || null,
        project_root: projectRoot || null,
        command: thread.command,
        args: thread.args,
        cols: thread.term ? thread.term.cols : 120,
        rows: thread.term ? thread.term.rows : 40,
        env: thread.env,
      },
    }).then(function () {
      thread.status = "running";
      thread.spawning = false;
      refreshSidebar();
      refreshTabs();
      if (state.activeThreadId === thread.id) {
        setProjectStatus(findProject(thread.projectId), "ok");
      }
      // Flush any data that arrived before the xterm was mounted.
      var pending = pendingDataBuffers.get(thread.id);
      if (pending && thread.term) {
        for (var i = 0; i < pending.length; i++) thread.term.write(pending[i]);
        pendingDataBuffers.delete(thread.id);
      }
    }).catch(function (err) {
      thread.status = "exited";
      thread.spawning = false;
      var msg = String(err);
      if (msg.indexOf("already running") !== -1) {
        thread.status = "running";
      } else {
        if (thread.term) {
          thread.term.write("\r\n\x1b[31m[pty_start error]\x1b[0m " + msg + "\r\n");
        }
        if (state.activeThreadId === thread.id) {
          setStatus("start failed", "error");
        }
      }
      refreshSidebar();
      refreshTabs();
    });
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

  function mountTerminal(thread) {
    var container = document.createElement("div");
    container.className = "term-instance";
    container.dataset.threadId = thread.id;
    terminalHost.appendChild(container);

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

    term.onData(function (data) {
      var bytes = Array.from(new TextEncoder().encode(data));
      invoke("pty_write", { threadId: thread.id, thread_id: thread.id, bytes: bytes }).catch(
        function (err) {
          term.write("\r\n\x1b[31m[pty_write]\x1b[0m " + err + "\r\n");
        }
      );
    });
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
    thread.host = container;
  }

  async function focusThread(id) {
    var thread = findThread(id);
    if (!thread) return false;
    if (!(await showTerminalView())) return false;
    markActiveSurface("terminal");
    state.activeThreadId = id;
    // Make the thread's project the active one so the sidebar/tabs
    // stay in sync if the user clicked into a different project's thread.
    if (thread.projectId && state.activeProjectId !== thread.projectId) {
      state.activeProjectId = thread.projectId;
    }
    var project = findProject(thread.projectId);
    if (project) project.lastActiveThreadId = id;

    Array.prototype.forEach.call(terminalHost.children, function (el) {
      el.classList.toggle("active", el.dataset.threadId === id);
    });
    refreshSidebar();
    requestAnimationFrame(function () {
      fitActiveTerm();
      if (thread.term) thread.term.focus();
    });

    setProjectStatus(project, statusLevel(thread.status));
    return true;
  }

  function statusLevel(s) {
    if (s === "running") return "ok";
    if (s === "starting") return "";
    return "warn";
  }

  function closeThread(id, options) {
    var thread = findThread(id);
    if (!thread) return;
    invoke("pty_stop", { threadId: id, thread_id: id }).catch(function () {});
    if (thread.host && thread.host.parentNode) {
      thread.host.parentNode.removeChild(thread.host);
    }
    if (thread.term && thread.term.dispose) {
      try { thread.term.dispose(); } catch (_) {}
    }
    var closingProjectId = thread.projectId;
    state.threads = state.threads.filter(function (t) { return t.id !== id; });
    if (state.activeThreadId === id) {
      // Prefer the next thread in the same project so closing a tab doesn't
      // teleport the user into a different project.
      var siblings = state.threads.filter(function (t) {
        return t.projectId === closingProjectId;
      });
      var next = siblings[siblings.length - 1] || state.threads[state.threads.length - 1] || null;
      state.activeThreadId = null;
      if (next && (!options || options.focus !== false)) {
        focusThread(next.id);
      } else {
        Array.prototype.forEach.call(terminalHost.children, function (el) {
          el.classList.remove("active");
        });
        setProjectStatus(findProject(closingProjectId), "");
      }
    }
    refreshSidebar();
    refreshTabs();
  }

  function fitActiveTerm() {
    var thread = findThread(state.activeThreadId);
    if (!thread || !thread.fit) return;
    try { thread.fit.fit(); } catch (_) {}
  }
  window.addEventListener("resize", function () {
    fitActiveTerm();
    syncBrowserBounds();
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
   * Replace `el`'s text with an <input>, focused and selected. Calls
   * onCommit(value) on Enter / blur if the value changed; Escape cancels.
   * Sets editingContext so the surface's refresh loop pauses until the edit
   * settles, then runs `done()` (which usually re-renders).
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

    el.replaceChildren(input);
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

  function refreshSidebar() { refreshTabs(); renderSessionList(); renderTerminalEmptyState(); }

  // ============================================================
  // 7b. Sessions sidebar
  // ============================================================

  // One row per thread, grouped under its project. Threads are the "sessions"
  // — state.threads is the source of truth, so this renders from the same data
  // the tab strip and terminal host use rather than tracking its own copy.

  var themeSelectEl = document.getElementById("theme-select");
  var solidBgEl = document.getElementById("solid-bg");
  var bgOpacityInput = document.getElementById("bg-opacity");
  var bgOpacityValueEl = document.getElementById("bg-opacity-value");
  var sessionListEl = document.getElementById("session-list");
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

  function sessionStatusClass(thread) {
    if (thread.spawning || thread.status === "starting") return "starting";
    if (thread.status === "running") return "running";
    if (thread.status === "exited") return "exited";
    return "";
  }

  function renderSessionList() {
    if (!sessionListEl) return;
    if (editingContext && editingContext.surface === "sidebar") return;
    sessionListEl.innerHTML = "";

    var needle = sessionFilter.trim().toLowerCase();
    var matched = 0;

    state.projects.forEach(function (project) {
      var threads = state.threads.filter(function (t) { return t.projectId === project.id; });
      if (needle) {
        var projectHit = project.name.toLowerCase().indexOf(needle) !== -1;
        threads = threads.filter(function (t) {
          return projectHit || String(t.name).toLowerCase().indexOf(needle) !== -1;
        });
      }
      if (threads.length === 0) return;
      matched += threads.length;

      var group = document.createElement("div");
      group.className = "session-group";

      var head = document.createElement("div");
      head.className = "session-group-head";
      head.textContent = project.name;
      head.title = project.root || project.name;
      group.appendChild(head);

      threads.forEach(function (thread) {
        var row = document.createElement("button");
        row.type = "button";
        row.className = "session-row " + sessionStatusClass(thread) +
          (state.activeThreadId === thread.id ? " active" : "");
        row.dataset.threadId = thread.id;
        row.setAttribute("role", "treeitem");
        row.setAttribute("aria-selected", state.activeThreadId === thread.id ? "true" : "false");
        row.title = thread.name + " — " + (project.root || "");
        row.innerHTML =
          '<span class="session-dot"></span>' +
          '<span class="session-text">' +
            '<span class="session-title">' + escapeHtml(thread.name) + "</span>" +
            '<span class="session-sub">' + escapeHtml(shortenRoot(project.root)) + "</span>" +
          "</span>" +
          '<button class="session-close" title="Close session" aria-label="Close session">×</button>';

        row.addEventListener("click", async function (e) {
          if (e.target && e.target.classList.contains("session-close")) return;
          // Switching project first keeps layout/browser state consistent, then
          // focus the specific thread the user clicked.
          if (project.id !== state.activeProjectId && !(await setActiveProject(project.id))) return;
          await focusThread(thread.id);
        });
        row.querySelector(".session-close").addEventListener("click", function (e) {
          e.stopPropagation();
          closeThread(thread.id);
        });
        var titleEl = row.querySelector(".session-title");
        titleEl.addEventListener("dblclick", function (e) {
          e.stopPropagation();
          editLabelInline(titleEl, "sidebar", {
            initial: thread.name,
            onCommit: function (v) { renameThread(thread.id, v); },
            done: function () { renderSessionList(); },
          });
        });
        group.appendChild(row);
      });

      sessionListEl.appendChild(group);
    });

    if (matched === 0) {
      var empty = document.createElement("div");
      empty.className = "session-empty";
      empty.textContent = needle
        ? "No sessions match “" + sessionFilter.trim() + "”"
        : state.projects.length
          ? "No sessions yet — ⌘T opens one."
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

  function renderTerminalEmptyState() {
    var existing = terminalHost.querySelector(".terminal-empty");
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    if (activeProjectThreads().length > 0) return;
    var empty = document.createElement("div");
    empty.className = "terminal-empty";
    empty.textContent = activeProject() ? "No terminal pane yet — opening Psyche…" : "Drop/open a project to begin";
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
    if (state.activeProjectId === id) {
      var next = state.projects[0] || null;
      // Force setActiveProject to do its restore work even though the id
      // matches — clear first.
      state.activeProjectId = null;
      if (next) {
        await setActiveProject(next.id);
      } else {
        state.activeThreadId = null;
        Array.prototype.forEach.call(terminalHost.children, function (el) {
          el.classList.remove("active");
        });
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

  // Tabs == projects. Each project tab spawns psyche on add (`spawnDefaultThreadIn`)
  // and clicking the tab restores the project's last-active thread. Threads
  // themselves are managed inside the embedded psyche/tmux UI — they aren't
  // surfaced as separate tabs at the shell level.
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

  async function openFileTab(path, project) {
    project = project || activeProject();
    if (!project) return;
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
    var rel = relativeToRoot(project.root, path);
    var file = {
      id: "f" + fileCounter,
      path: path,
      rel: rel,
      name: rel.split("/").pop() || rel,
      projectId: project.id,
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
      var res = await invoke("fs_read_text", { root: project.root, path: path });
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
    state.activeFileId = id;
    markActiveSurface("terminal");
    if (fileViewEl) fileViewEl.hidden = false;
    if (terminalHost) terminalHost.hidden = true;
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
      Array.prototype.forEach.call(terminalHost.children, function (element) {
        element.classList.toggle("active", element.dataset.threadId === nextThreadId);
      });
      restoreProjectLayout(project);
      // A stored browser-only layout hides the terminal area that owns the
      // editor. Change only the live surface; keep the project's saved layout.
      applyLayout("terminal", { side: currentSide(), persist: false });
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
    state.activeFileId = null;
    if (fileViewEl) fileViewEl.hidden = true;
    if (terminalHost) terminalHost.hidden = false;
    refreshTabs();
    requestAnimationFrame(function () { fitActiveTerm(); });
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
      state.activeFileId = null;
      if (fileViewEl) fileViewEl.hidden = true;
      if (terminalHost) terminalHost.hidden = false;
      refreshTabs();
      requestAnimationFrame(function () { fitActiveTerm(); });
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
      var loaded = await invoke("fs_read_text", { root: project.root, path: file.path });
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
        root: project.root,
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

  function refreshTabs() {
    if (editingContext && editingContext.surface === "tabs") return;
    tabStripEl.innerHTML = "";
    var files = projectFiles();

    if (files.length === 0) {
      var empty = document.createElement("div");
      empty.className = "tab-empty";
      empty.textContent = activeProject()
        ? "No files open — pick one from the Files panel"
        : "Drop/open a project to begin";
      tabStripEl.appendChild(empty);
      return;
    }

    files.forEach(function (file, idx) {
      var isActive = state.activeFileId === file.id;
      var tab = document.createElement("div");
      tab.className = "tab" + (isActive ? " active" : "");
      tab.dataset.fileId = file.id;
      tab.title = file.rel + (idx < 9 ? "  (\u2318" + (idx + 1) + ")" : "");
      tab.innerHTML =
        '<span class="label">' + escapeHtml(file.name) + "</span>" +
        (file.dirty ? '<span class="dot dirty-dot" title="Unsaved changes" aria-label="Unsaved changes"></span>' : "") +
        '<button class="close" title="Close file (\u2318W)">\u00d7</button>';
      tab.addEventListener("click", async function (e) {
        if (e.target.classList.contains("close")) return;
        await activateFileTab(file.id);
      });
      tab.querySelector(".close").addEventListener("click", async function (e) {
        e.stopPropagation();
        await closeFileTab(file.id);
      });
      tabStripEl.appendChild(tab);
    });
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

  var commands = [
    {
      cmd: "/new-thread",
      desc: "Spawn a new shell thread",
      run: function () { spawnDefaultThread(); },
    },
    {
      cmd: "/new-psyche",
      desc: "Spawn a thread running the psyche TUI",
      run: function () { spawnPsycheThread(); },
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
      desc: "Toggle between terminal-only and split layout",
      run: function () { toggleBrowser(); },
    },
    {
      cmd: "/browser",
      desc: "Switch to browser-only layout",
      run: function () { applyLayout("browser"); },
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
    invoke("agent_skills", {
      harness: "claude",
      projectRoot: project ? project.root : null,
      project_root: project ? project.root : null,
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

  function runCommand(line) {
    var trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed[0] !== "/") {
      // Not a slash command — pipe to the active terminal as a typed command.
      sendToActive(trimmed + "\n");
      return;
    }
    commandHistory.push(trimmed);
    rememberCommand(trimmed);
    var space = trimmed.indexOf(" ");
    var head = space === -1 ? trimmed : trimmed.slice(0, space);
    var rest = space === -1 ? "" : trimmed.slice(space + 1).trim();
    var match = commands.find(function (c) { return c.cmd === head; });
    if (match) {
      try { match.run(rest); }
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
    var bytes = Array.from(new TextEncoder().encode(text));
    invoke("pty_write", { threadId: thread.id, thread_id: thread.id, bytes: bytes }).catch(
      function () {}
    );
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

  function paletteCorpus() {
    return recentPaletteEntries().concat(builtinPaletteEntries(), agentSkillPaletteEntries());
  }

  function openPalette(query, force) {
    if (!force && commandInput.value.trim()[0] !== "/") {
      hidePalette();
      return;
    }
    var q = (query || commandInput.value).trim().toLowerCase();
    paletteFiltered = paletteCorpus().filter(function (c) {
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
    if (pick.kind === "agent" || pick.kind === "recent" || mode === "run") {
      runCommand(pick.cmd);
      commandInput.value = "";
      hidePalette();
      commandInput.focus();
      return;
    }
    commandInput.value = pick.cmd + " ";
    hidePalette();
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
    if (commandInput.value.trim()[0] === "/") openPalette();
    else hidePalette();
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
      if (paletteVisible && line.trim()[0] === "/" && line.indexOf(" ") === -1) {
        line = paletteFiltered[paletteIndex].cmd;
      }
      runCommand(line);
      commandInput.value = "";
      hidePalette();
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
      var browser = ensureBrowserModel(project);
      for (var j = 0; j < browser.tabs.length; j++) {
        var tab = browser.tabs[j];
        if (nativeBrowserLabel(browserLabelForTab(project, tab)) === nativeLabel) {
          return { project: project, tab: tab };
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
    if (pair.project.id === state.activeProjectId) { renderBrowserTabs(); syncUrlInput(); }
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
    if (pair.project.id === state.activeProjectId) { renderBrowserTabs(); updateBrowserControls(); }
  }).catch(function () {});
  listen("browser:title", function (event) {
    var payload = event.payload || {};
    markBrowserTabLoaded(payload.label, payload.url, payload.title);
  }).catch(function () {});
  listen("browser:focus", function () {
    markActiveSurface("browser");
  }).catch(function () {});
  function ensureBrowserModel(project) {
    if (!project) return null;
    if (!project.browser) project.browser = { tabs: [], activeTabId: null };
    return project.browser;
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
  function openBlankBrowserTab() { markActiveSurface("browser"); createBrowserTab(activeProject(), "about:blank", true); applyLayout("split"); syncProjectBrowser(); if (urlInput) urlInput.focus(); }
  listen("browser:shortcut-new-tab", function () {
    markActiveSurface("browser");
    openBlankBrowserTab();
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
  function visibleBrowserBounds() { var rect = preview.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) return null; if (detail.dataset.layout === "terminal") return null; if (currentPanel() !== "browser") return null; return { x: rect.left, y: rect.top, w: rect.width, h: rect.height }; }
  function syncProjectBrowser() { renderBrowserTabs(); syncBrowserBounds(); }
  function syncBrowserBounds() {
    var project = activeProject(); var tab = currentBrowserTab(project); var label = browserLabelForTab(project, tab); var b = visibleBrowserBounds();
    if (!b || !tab || !tab.created) { invoke("browser_hide_all_except", { label: null }).catch(function () {}); return; }
    invoke("browser_hide_all_except", { label: label }).catch(function () {});
    invoke("browser_set_bounds", { label: label, x: b.x, y: b.y, w: b.w, h: b.h }).catch(function () {});
  }
  function navigateBrowser(rawUrl, opts) {
    opts = opts || {}; var project = activeProject(); if (!project) return;
    var browser = ensureBrowserModel(project); var tab = opts.tabId ? browser.tabs.find(function (t) { return t.id === opts.tabId; }) : currentBrowserTab(project);
    if (!tab) tab = createBrowserTab(project, rawUrl || "about:blank", true); if (!tab) return;
    browser.activeTabId = tab.id;
    var b = visibleBrowserBounds(); if (!b) { applyLayout("split"); b = visibleBrowserBounds(); if (!b) return; }
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
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") saveWorkspaceNow(); });

  // -------- Resizable splitter between terminal-area and browser-pane --------
  //
  // Pointer-events implementation with axis-aware clamping. The clamp picks
  // x or y mins from CSS based on `data-browser-side`, so the splitter
  // physically resists collapse on whichever axis is active.
  //
  // Overflow note: while dragging, `.detail.resizing` disables the
  // grid-template transition so the layout snaps instantly to each
  // fraction, keeping the painted child WKWebView in sync with the DOM.

  var splitter = document.getElementById("splitter");
  if (splitter) {
    var dragging = false;
    var splitFrame = 0;

    function splitClampBounds() {
      var rect = detail.getBoundingClientRect();
      var styles = window.getComputedStyle(detail);
      var side = currentSide();
      var horizontal = side === "right" || side === "left";
      var size = horizontal ? rect.width : rect.height;
      var termMin = parseFloat(styles.getPropertyValue(horizontal ? "--terminal-min" : "--terminal-min-y"))
                    || (horizontal ? 220 : 160);
      var brMin   = parseFloat(styles.getPropertyValue(horizontal ? "--browser-min"  : "--browser-min-y"))
                    || (horizontal ? 220 : 160);
      var splitW  = parseFloat(styles.getPropertyValue("--splitter-w")) || 10;
      var min = Math.max(0.2, termMin / size);
      var max = Math.min(0.85, (size - brMin - splitW) / size);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
        min = 0.2; max = 0.85;
      }
      return { rect: rect, min: min, max: max, side: side, horizontal: horizontal };
    }

    function scheduleSplitLayoutSync() {
      if (splitFrame) return;
      splitFrame = requestAnimationFrame(function () {
        splitFrame = 0;
        fitActiveTerm();
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
      if (b.side === "right")  return (e.clientX - b.rect.left)   / b.rect.width;
      if (b.side === "left")   return (b.rect.right - e.clientX)  / b.rect.width;
      if (b.side === "bottom") return (e.clientY - b.rect.top)    / b.rect.height;
      if (b.side === "top")    return (b.rect.bottom - e.clientY) / b.rect.height;
      return 0.6;
    }

    splitter.addEventListener("pointerdown", function (e) {
      if (currentLayout() !== "split") return;
      dragging = true;
      splitter.classList.add("dragging");
      detail.classList.add("resizing");
      var side = currentSide();
      var axis = (side === "bottom" || side === "top") ? "y" : "x";
      document.body.classList.add("split-resizing");
      document.body.dataset.axis = axis;
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
      var side = currentSide();
      var grow, shrink;
      if      (side === "right")  { grow = "ArrowRight"; shrink = "ArrowLeft"; }
      else if (side === "left")   { grow = "ArrowLeft";  shrink = "ArrowRight"; }
      else if (side === "bottom") { grow = "ArrowDown";  shrink = "ArrowUp"; }
      else                        { grow = "ArrowUp";    shrink = "ArrowDown"; }
      if (e.key === shrink)    { setSplitFrac(current - step); e.preventDefault(); }
      else if (e.key === grow) { setSplitFrac(current + step); e.preventDefault(); }
    });
    setSplitFrac(currentSplitFrac());
  }

  // ============================================================
  // 11. Keyboard shortcuts
  // ============================================================

  function createContextualTab() {
    if (currentLayout() === "browser") markActiveSurface("browser");
    else if (currentLayout() === "terminal") markActiveSurface("terminal");
    if (activeSurface === "browser") openBlankBrowserTab(); else spawnDefaultThread();
  }

  document.addEventListener("keydown", async function (e) {
    var meta = e.metaKey || e.ctrlKey;
    if (!meta) return;
    if (String(e.key).toLowerCase() === "s") {
      await handleExplicitFileSave(e);
      return;
    }
    // ⌘T is contextual: browser tab from the browser side, terminal pane otherwise.
    if (String(e.key).toLowerCase() === "t") {
      createContextualTab();
      e.preventDefault(); return;
    }
    // ⌘O opens a new project (folder picker → addProject → psyche).
    if (e.key === "o") { openProjectPicker(); e.preventDefault(); return; }
    // ⌘W closes the active file tab; with none open it closes the project.
    if (e.key === "w") {
      e.preventDefault();
      if (state.activeFileId) await closeFileTab(state.activeFileId);
      else if (state.activeProjectId) await removeProject(state.activeProjectId);
      return;
    }
    if (e.key === "k") { commandInput.focus(); openPalette("/", true); e.preventDefault(); return; }
    if (e.key === "\\") { toggleBrowser(); e.preventDefault(); return; }
    // ⌘⌥B toggles browser; ⌘⇧B cycles side. We match by `code` so option-B
    // (which produces ∫ on macOS) still resolves to KeyB.
    if (e.code === "KeyB" && e.altKey)   { toggleBrowser(); e.preventDefault(); return; }
    if (e.code === "KeyB" && e.shiftKey) { cycleBrowserSide(1); e.preventDefault(); return; }
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
  // they call the same functions the ⌘-handlers above do, so there is no second
  // code path to keep in sync. #rail-browser-toggle is wired via
  // [data-browser-toggle] alongside the titlebar button.
  function onRailClick(id, handler) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("click", handler);
  }
  onRailClick("rail-new-tab", function () { createContextualTab(); });
  onRailClick("rail-open-project", function () { openProjectPicker(); });
  onRailClick("rail-palette", function () { commandInput.focus(); openPalette("/", true); });

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
  var diffEditorHostEl = document.getElementById("diff-editor-host");
  var diffMetadataEl = document.getElementById("diff-metadata");
  var diffTruncationEl = document.getElementById("diff-truncation");
  var diffsSummaryEl = document.getElementById("diffs-summary");
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
  var diffViewer = window.PsycheCodeEditor.createDiffViewer({ parent: diffEditorHostEl });

  function diffCacheKey(projectId, path, staged) {
    return projectId + "\0" + path + "\0" + (staged ? "staged" : "unstaged");
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
    return currentLayout() === "split" && currentPanel() === panel;
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
    if (filesCrumbEl) filesCrumbEl.textContent = shortenRoot(project.root);
    fileTreeEl.innerHTML = "";
    await appendDirInto(fileTreeEl, project.root, project.root, 0);
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
    diffViewer.clear();
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

  function renderDiffResult(result) {
    var text = result && typeof result.text === "string" ? result.text : "";
    var lines = Number(result && result.lines) || 0;
    var bytes = Number(result && result.bytes) || 0;
    diffViewer.setDiff({ text: text });
    if (diffMetadataEl) {
      diffMetadataEl.textContent = text.trim()
        ? lines + " lines · " + formatDiffBytes(bytes)
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
      status = await invoke("git_status", { root: project.root });
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
      var key = diffCacheKey(project.id, f.path, stagedDiffFor(f));
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
      return diffCacheKey(project.id, f.path, stagedDiffFor(f)) === selectedDiffKey;
    }) || status.files[0];
    showDiff(project, target);
  }

  async function showDiff(project, entry) {
    if (!project || !entry || !diffEditorHostEl) return;
    if (!activeProject() || activeProject().id !== project.id || !panelIsVisible("diffs")) return;
    var staged = stagedDiffFor(entry);
    var key = diffCacheKey(project.id, entry.path, staged);
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
        root: project.root,
        path: entry.path,
        staged: staged,
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
      status = await invoke("git_status", { root: project.root });
      commits = status.is_repo ? await invoke("git_log", { root: project.root, limit: 30 }) : [];
    } catch (err) {
      panelMessage(gitViewEl, String(err), "panel-error");
      return;
    }
    if (!status.is_repo) { panelMessage(gitViewEl, "Not a git repository."); return; }

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

  async function addProject(rootPath) {
    if (!rootPath) return null;
    var existing = state.projects.find(function (p) { return p.root === rootPath; });
    if (existing) return (await setActiveProject(existing.id)) ? existing : null;
    if (state.projects.length >= settings.maxProjects) { setStatus("project limit reached (" + settings.maxProjects + "/" + HARD_MAX_PROJECTS + ")", "warn"); return null; }
    if (!(await showTerminalView())) return null;
    var parts = rootPath.split("/");
    var name = parts[parts.length - 1] || rootPath;
    var project = { id: makeProjectId(), name: name, root: rootPath, collapsed: false, layout: { mode: "terminal", side: "right", splitFrac: 0.6 }, browser: { tabs: [], activeTabId: null } };
    state.projects.push(project);
    state.activeProjectId = project.id;
    restoreProjectLayout(project);
    refreshSidebar();
    syncProjectBrowser();
    saveWorkspaceSoon();
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
        ensureProjectPsyche(project);
        setProjectStatus(project, "ok");
      }
    } catch (err) {
      writeToActive("\r\n\x1b[31m[open-project]\x1b[0m " + err + "\r\n");
    }
  }

  function ensureProjectPsyche(project) {
    if (!project) return null;
    var existing = state.threads.find(function (t) { return t.projectId === project.id && t.kind === "psyche" && t.status !== "exited"; });
    if (existing) { focusThread(existing.id); return existing; }
    return spawnDefaultThreadIn(project);
  }

  function spawnDefaultThreadIn(project) {
    if (state.env && state.env.psyche_entry && state.env.node_path) {
      var shell = (state.env.default_shell) || "/bin/zsh";
      var quoted = function (s) {
        return "'" + String(s).replace(/'/g, "'\\''") + "'";
      };
      var cmd = "exec " + quoted(state.env.node_path) + " " + quoted(state.env.psyche_entry);
      createThread({
        project: project,
        name: "psyche",
        kind: "psyche",
        command: shell,
        args: ["-l", "-c", cmd],
        projectRoot: project.root,
        env: tauriPsycheEnv(),
      });
    } else {
      createThread({
        project: project,
        name: "shell",
        kind: "shell",
        command: state.env && state.env.default_shell ? state.env.default_shell : "/bin/zsh",
        args: ["-l"],
        projectRoot: project.root,
      });
    }
  }

  function spawnDefaultThread() {
    var project = activeProject();
    return createThread({
      project: project,
      name: "shell " + (state.threads.length + 1),
      kind: "shell",
      command: state.env && state.env.default_shell ? state.env.default_shell : "/bin/zsh",
      args: ["-l"],
      projectRoot: project && project.root,
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
    return createThread({
      name: "psyche",
      kind: "psyche",
      command: shell,
      args: ["-l", "-c", cmd],
      projectRoot: state.env.repo_root,
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

  invoke("app_environment")
    .then(async function (env) {
      state.env = env || {};
      var saved = readSavedWorkspace();
      var bootRoot = state.env.repo_root || state.env.home || "/";
      var project = null;
      if (saved && saved.projects.length) {
        isRestoringWorkspace = true;
        state.projects = saved.projects.map(sanitizeSavedProject).filter(Boolean).slice(0, Math.min(settings.maxProjects, HARD_MAX_PROJECTS));
        state.activeProjectId = saved.activeProjectId && state.projects.some(function (p) { return p.id === saved.activeProjectId; }) ? saved.activeProjectId : (state.projects[0] && state.projects[0].id);
        project = activeProject();
        if (project) restoreProjectLayout(project);
        isRestoringWorkspace = false;
      }
      if (!project) project = await addProject(bootRoot);
      if (project) {
        ensureProjectPsyche(project);
        var activeTab = currentBrowserTab(project);
        if (activeTab && activeTab.created && activeTab.url && activeTab.url !== "about:blank") navigateBrowser(activeTab.url, { tabId: activeTab.id, preserveHistory: true });
        restoreProjectLayout(project);
      }
      refreshSidebar(); refreshTabs(); renderBrowserTabs(); syncProjectBrowser(); loadAgentSkills(); saveWorkspaceNow();
    })
    .catch(function (err) {
      showBootError("app_environment failed: " + err);
    });
})();
