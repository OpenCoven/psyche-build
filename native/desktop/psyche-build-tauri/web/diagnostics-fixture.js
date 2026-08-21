(function () {
  "use strict";

  var paneCount = Number(new URLSearchParams(window.location.search).get("paneCount"));
  if ([1, 6, 12, 24].indexOf(paneCount) === -1) paneCount = 1;
  var title = "Psyche render diagnostics · " + paneCount + " panes";
  document.title = title;

  var canvas = document.getElementById("diagnostics-canvas");
  var gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
  var frame = 0;
  function draw() {
    frame += 1;
    if (gl) {
      gl.clearColor((frame % 255) / 255, paneCount / 24, 0.5, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);

  function reportContextStatus(status) {
    document.title = status;
    try {
      var core = window.__TAURI__ && window.__TAURI__.core;
      var invoke = core && core.invoke;
      if (typeof invoke === "function") {
        Promise.resolve(
          invoke("browser_report_title", { title: status })
        ).catch(function () {});
      }
    } catch (_) {}
  }

  window.losePsycheDiagnosticsContext = function () {
    var extension = gl && gl.getExtension("WEBGL_lose_context");
    if (!extension) {
      reportContextStatus(title + " · context-unavailable");
      return false;
    }
    reportContextStatus(title + " · context-lost");
    extension.loseContext();
    return true;
  };
})();
