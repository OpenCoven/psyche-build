export function createAgentControlPoller({
  captureContext, contextMatches, load, accept, fail, clear,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval, intervalMs = 1_000,
}) {
  let timer = null;
  let flight = null;
  let pending = false;
  let generation = 0;

  function refresh() {
    if (flight) {
      pending = true;
      return flight;
    }
    const context = captureContext();
    if (!context) return Promise.resolve();
    const capturedGeneration = generation;
    let request;
    try { request = Promise.resolve(load(context)); }
    catch (error) { request = Promise.reject(error); }
    const run = request.then((response) => {
      if (capturedGeneration === generation && contextMatches(context)) accept(response, context);
    }, () => {
      if (capturedGeneration === generation && contextMatches(context)) fail(context);
    }).finally(() => {
      if (flight === run) {
        flight = null;
        if (pending) {
          pending = false;
          void refresh();
        }
      }
    });
    flight = run;
    return run;
  }

  function start() {
    if (timer !== null) clearIntervalFn(timer);
    void refresh();
    timer = setIntervalFn(refresh, intervalMs);
  }

  function stop(reason = 'stopped') {
    if (timer !== null) clearIntervalFn(timer);
    timer = null;
    pending = false;
    generation += 1;
    clear(reason);
  }

  return Object.freeze({ refresh, start, stop });
}
