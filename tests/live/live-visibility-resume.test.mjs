import test from "node:test";
import assert from "node:assert/strict";

import { renderLiveControlRoomPage } from "../../src/presentation/live/live-control-room-page.mjs";

/**
 * Runs the shipped `visibilitychange` handler against stubs.
 *
 * The handler is sliced out of the rendered page rather than restated here, so a
 * guard cannot pass against a copy that no longer ships. Chrome reports
 * `visibilityState: "hidden"` for every tab of an occluded window — measured on
 * this machine with `document.hasFocus() === true` at the same moment — so this
 * handler is the only place that runs when a person brings the window back to
 * the front, and the 15s catalog poll is skipped for the whole time it is behind
 * another window.
 */
function visibilityHandlerHarness({ eventSource = null, unloading = false, selectedRunId = "run-1" } = {}) {
  const html = renderLiveControlRoomPage();
  const start = html.indexOf('  document.addEventListener("visibilitychange", () => {');
  assert.ok(start >= 0, "the visibility handler is no longer in the shipped client script");
  const end = html.indexOf("\n  });", start);
  assert.ok(end > start, "the visibility handler has no terminator, so the slice is unbounded");
  const source = html.slice(start, end + "\n  });".length);

  const calls = { catalog: [], connect: 0, snapshot: 0, disconnect: 0, timers: 0, catchUp: 0, order: [] };
  const document = {
    hidden: true,
    handler: null,
    addEventListener(type, handler) {
      if (type === "visibilitychange") this.handler = handler;
    },
  };
  const bind = new Function(
    "document",
    "window",
    "setTimeout",
    "STREAM_POLICY",
    "unloading",
    "selectedRunId",
    "eventSource",
    "calls",
    `
      let hiddenSuspendTimer = null;
      const disconnectEvents = () => { calls.disconnect += 1; calls.order.push("disconnect"); };
      const updateConnection = () => {};
      const connectEvents = () => { calls.connect += 1; calls.order.push("connect"); };
      const scheduleSnapshotUpdate = () => { calls.snapshot += 1; calls.order.push("snapshot"); };
      const beginPauseCatchUp = () => { calls.catchUp += 1; calls.order.push("catchUp"); };
      const loadProjectCatalog = (options) => { calls.catalog.push(options); calls.order.push("catalog"); return Promise.resolve(true); };
      ${source}
    `,
  );
  bind(
    document,
    { clearTimeout: () => {} },
    () => { calls.timers += 1; return 1; },
    { hiddenSuspendGraceMs: 1_000 },
    unloading,
    selectedRunId,
    eventSource,
    calls,
  );
  assert.ok(typeof document.handler === "function", "the slice registered no visibilitychange handler");
  return { document, calls };
}

/**
 * Returning to the window is the only catch-up opportunity there is: the poll
 * that maintains the run list refuses to run while the page is hidden, so
 * whatever ran, finished, or lost its chat link in the meantime is missing from
 * the list the person is looking at the moment they look at it.
 */
test("coming back to a visible page catches the run list up", () => {
  const { document, calls } = visibilityHandlerHarness();
  document.hidden = false;
  document.handler();

  assert.deepEqual(calls.catalog, [{ refresh: true }], "becoming visible must refresh the run list exactly once");
});

/**
 * Switching away and straight back keeps the stream, and that path returns
 * early. A catch-up placed after that return would only ever fire for the tab
 * that had already been hidden long enough to lose its stream — the case a
 * person is least likely to be in.
 */
test("the catch-up does not depend on having lost the stream", () => {
  const { document, calls } = visibilityHandlerHarness({ eventSource: { readyState: 1 } });
  document.hidden = false;
  document.handler();

  assert.deepEqual(calls.catalog, [{ refresh: true }], "a page that kept its stream still needs the list refreshed");
  assert.equal(calls.connect, 0, "an open stream must not be reconnected on top of itself");
  // Stream events are still processed while the window is behind another one, so
  // a page that never lost its stream is already current and has nothing to
  // catch up on. Announcing a catch-up here would be a badge for no work.
  assert.equal(calls.catchUp, 0, "a page that kept its stream must not announce a catch-up");
});

/**
 * The stream is dropped after a grace period while hidden, so a page returning
 * from a longer absence has no connection left. Without the reconnect and the
 * snapshot refetch the graph stays frozen at whatever it showed when the person
 * looked away, with a connection badge that claims nothing is wrong.
 */
test("a visible page that lost its stream reconnects and refetches", () => {
  const { document, calls } = visibilityHandlerHarness({ eventSource: null });
  document.hidden = false;
  document.handler();

  assert.equal(calls.connect, 1, "a page with no stream must reconnect on becoming visible");
  assert.equal(calls.snapshot, 1, "reconnecting without a refetch leaves the graph frozen");
});

test("a page going hidden refreshes nothing", () => {
  const { document, calls } = visibilityHandlerHarness();
  document.hidden = true;
  document.handler();

  assert.deepEqual(calls.catalog, [], "a hidden page must not spend a request on a list nobody is reading");
  assert.equal(calls.connect, 0);
  assert.equal(calls.timers, 1, "going hidden still schedules the stream suspension");
});

test("a page on its way out refreshes nothing", () => {
  const { document, calls } = visibilityHandlerHarness({ unloading: true });
  document.hidden = false;
  document.handler();

  assert.deepEqual(calls.catalog, [], "a page being torn down must not start a request that outlives it");
});

/**
 * The graph on screen when a person comes back is whatever it showed when they
 * looked away. The stream's `open` event lands well before the snapshot that
 * replaces it — measured on this machine at 75ms of coalescing plus an ~85ms
 * refetch — so the reconnect must not be what speaks first. Marking the catch-up
 * before connecting is the whole point: reversed, the badge says the page is live
 * while the numbers under it stopped moving when the window went behind another.
 */
test("a resumed page marks the catch-up before it reconnects", () => {
  const { document, calls } = visibilityHandlerHarness({ eventSource: null });
  document.hidden = false;
  document.handler();

  assert.equal(calls.catchUp, 1, "a page that lost its stream must announce the catch-up exactly once");
  assert.deepEqual(
    calls.order,
    ["catalog", "catchUp", "connect", "snapshot"],
    "the catch-up must be marked before the stream opens, or the badge claims live over pre-pause numbers",
  );
});

/**
 * Slices a named helper out of the shipped client script, bounded by the next
 * top-level helper, so a guard cannot pass against a copy that no longer ships.
 */
function shippedHelper(html, name) {
  const start = html.indexOf("  function " + name + "(");
  assert.ok(start >= 0, name + "() is no longer in the shipped client script");
  const end = html.indexOf("\n  function ", start + 1);
  assert.ok(end > start, name + "() must be followed by another shipped helper");
  return html.slice(start, end);
}

/**
 * `connectEvents` is the last helper in the script, so it has no following
 * helper to bound the slice; its own two-space closing brace is the terminator.
 */
function shippedTailHelper(html, name) {
  const start = html.indexOf("  function " + name + "(");
  assert.ok(start >= 0, name + "() is no longer in the shipped client script");
  const end = html.indexOf("\n  }", start);
  assert.ok(end > start, name + "() has no terminator, so the slice is unbounded");
  return html.slice(start, end + "\n  }".length);
}

/**
 * Runs the shipped coalescing pair against stubs. The window is deliberately not
 * 75ms here: a fixture reusing the shipped constant cannot tell reading the
 * constant apart from writing the number back in by hand.
 */
const FIXTURE_COALESCE_MS = 4242;

function coalesceHarness({ catchingUp }) {
  const html = renderLiveControlRoomPage();
  const source = shippedHelper(html, "flushSnapshotUpdate") + shippedHelper(html, "scheduleSnapshotUpdate");
  const calls = { rendered: [], load: 0, armed: [] };
  const build = new Function(
    "window",
    "unloading",
    "SNAPSHOT_COALESCE_MS",
    "catchingUpAfterPause",
    "renderSnapshot",
    "loadSnapshot",
    "calls",
    `
      let snapshotCoalesceTimer = null;
      let pendingSnapshot = null;
      let refreshQueued = false;
      ${source}
      return { scheduleSnapshotUpdate, flushSnapshotUpdate };
    `,
  );
  const api = build(
    { setTimeout: (fn, ms) => { calls.armed.push(ms); return 7; }, clearTimeout: () => {} },
    false,
    FIXTURE_COALESCE_MS,
    catchingUp,
    (snapshot) => { calls.rendered.push(snapshot); },
    () => { calls.load += 1; },
    calls,
  );
  return { ...api, calls };
}

/**
 * Coalescing exists to absorb bursts of stream events, which arrive faster than
 * anyone can read. It is the wrong tool for someone who just brought the window
 * back and is watching the badge: there is nothing to batch, only a wait to add.
 */
test("an ordinary refresh request waits out the coalesce window", () => {
  const { scheduleSnapshotUpdate, calls } = coalesceHarness({ catchingUp: false });
  scheduleSnapshotUpdate();

  assert.equal(calls.load, 0, "an ordinary refresh must not fetch before the window closes");
  assert.deepEqual(calls.armed, [FIXTURE_COALESCE_MS], "the window length must come from the shipped constant");
});

test("a catch-up refresh skips the coalesce window", () => {
  const { scheduleSnapshotUpdate, calls } = coalesceHarness({ catchingUp: true });
  scheduleSnapshotUpdate();

  assert.equal(calls.load, 1, "a person waiting on a catch-up must not be batched behind a timer");
  assert.deepEqual(calls.armed, [], "a catch-up that arms a timer has not skipped the window");
});

/**
 * The catch-up's second hop is the payload the refetch returns. Both hops go
 * through the same scheduler, so a rule that only covered the first one would
 * still leave the person waiting out a window before the new graph paints.
 */
test("the snapshot a catch-up fetched paints without waiting", () => {
  const { scheduleSnapshotUpdate, calls } = coalesceHarness({ catchingUp: true });
  const payload = { run: { id: "run-1" }, nodes: [] };
  scheduleSnapshotUpdate(payload);

  assert.deepEqual(calls.rendered, [payload], "the fetched snapshot must paint on arrival during a catch-up");
  assert.deepEqual(calls.armed, [], "the returned payload must not be held behind a timer either");
});

function connectEventsHarness({ catchingUp }) {
  const html = renderLiveControlRoomPage();
  const listeners = new Map();
  const calls = { connection: [] };
  const build = new Function(
    "window",
    "selectionGeneration",
    "EventSource",
    "endpointForSelection",
    "eventsEndpoint",
    "handleEvent",
    "updateConnection",
    "catchingUpAfterPause",
    `
      let eventSource = null;
      ${shippedTailHelper(html, "connectEvents")}
      return connectEvents;
    `,
  );
  build(
    { EventSource: true },
    1,
    class {
      constructor(url) {
        this.url = url;
      }

      addEventListener(type, handler) {
        listeners.set(type, handler);
      }
    },
    (endpoint) => endpoint,
    "/api/live/events",
    () => {},
    (kind, message) => { calls.connection.push([kind, message]); },
    catchingUp,
  )();
  assert.ok(typeof listeners.get("open") === "function", "the slice registered no open handler");
  return { listeners, calls };
}

test("an opened stream reports itself live when nothing is being caught up", () => {
  const { listeners, calls } = connectEventsHarness({ catchingUp: false });
  listeners.get("open")();

  assert.deepEqual(calls.connection, [["live", "Streaming"]], "an ordinary connect must report the live stream");
});

/**
 * The stream really is open at this point, so the claim is not false in itself —
 * it is false about what the person is looking at. Whatever paints next owns the
 * badge: `renderSnapshot` sets it from the run's own status on every paint.
 */
test("an opened stream stays quiet while a catch-up is outstanding", () => {
  const { listeners, calls } = connectEventsHarness({ catchingUp: true });
  listeners.get("open")();

  assert.deepEqual(calls.connection, [], "opening the stream must not claim live over pre-pause numbers");
});

/**
 * Same slice shape as `shippedHelper`, for the one helper below that is declared
 * async and so does not match that needle.
 */
function shippedAsyncHelper(html, name) {
  const start = html.indexOf("  async function " + name + "(");
  assert.ok(start >= 0, name + "() is no longer in the shipped client script");
  const end = html.indexOf("\n  function ", start + 1);
  assert.ok(end > start, name + "() must be followed by another shipped helper");
  return html.slice(start, end);
}

/**
 * Builds a harness around one shipped helper with the catch-up already in
 * progress.
 *
 * The flag is a binding inside the built function rather than one of its
 * parameters, so the slice's own assignment to it is what `isCatchingUp` reads.
 * The stub list is derived from the stub object itself: a dependency added to the
 * slice later is then a named `ReferenceError` instead of a silent pass.
 */
function catchUpHarness(source, env) {
  const build = new Function(
    "env",
    `
      let { ${Object.keys(env).join(", ")} } = env;
      let catchingUpAfterPause = true;
      ${source}
      return { run: ${source.includes("function renderSnapshot(") ? "renderSnapshot" : "loadSnapshot"}, isCatchingUp: () => catchingUpAfterPause };
    `,
  );
  return build(env);
}

/**
 * Nothing clears the catch-up on the way in — the flag is set before the stream
 * reconnects and the reconnect itself never clears it — so whatever ends up on
 * screen has to. These stubs stand in for the painting the real helper does; what
 * is under test is that the flag is released and the badge written from the
 * result, not the drawing.
 */
function renderSnapshotHarness(overrides = {}) {
  const calls = { connection: [], empty: [], painted: [] };
  const paints = (name) => () => { calls.painted.push(name); };
  const env = {
    projectForSelection: () => null,
    selectedRunId: "run-1",
    generatedRunTitle: () => false,
    sessionDisplayTitle: () => "",
    sessionIsIdentified: () => true,
    currentLanguage: "en",
    normalizeSnapshot: (value) => value,
    showEmpty: (message) => { calls.empty.push(message); },
    updateConnection: (kind, message) => { calls.connection.push([kind, message]); },
    hideEmpty: paints("hideEmpty"),
    updateHeader: paints("updateHeader"),
    renderStageRail: paints("renderStageRail"),
    renderGraph: paints("renderGraph"),
    renderEvidence: paints("renderEvidence"),
    renderSessionInfo: paints("renderSessionInfo"),
    renderRepositoryView: paints("renderRepositoryView"),
    renderWorkspaceView: paints("renderWorkspaceView"),
    renderReplay: paints("renderReplay"),
    renderControlPanel: paints("renderControlPanel"),
    setWorkView: paints("setWorkView"),
    setInspectorOpen: paints("setInspectorOpen"),
    fitGraph: paints("fitGraph"),
    reconcileCamera: paints("reconcileCamera"),
    currentWorkView: "graph",
    cameraMode: "manual",
    graph: null,
    currentSnapshot: null,
    selectedNodeId: null,
    window: { matchMedia: () => ({ matches: false }) },
    ...overrides,
  };
  const api = catchUpHarness(shippedHelper(renderLiveControlRoomPage(), "renderSnapshot"), env);
  return { ...api, calls };
}

/**
 * The clear sits above every branch on purpose. A snapshot that will not normalize
 * paints nothing, but it is still the end of the catch-up: the badge it writes is
 * the honest report, and a flag left set here would silence every later one for
 * the rest of the page's life.
 */
test("a snapshot that will not normalize still ends the catch-up", () => {
  const harness = renderSnapshotHarness({ normalizeSnapshot: () => null });
  assert.equal(harness.isCatchingUp(), true, "the harness must start from a catch-up in progress");

  harness.run({ run: { id: "run-1" } });

  assert.equal(harness.isCatchingUp(), false, "a snapshot that painted nothing must still release the flag");
  assert.deepEqual(
    harness.calls.connection,
    [["stale", "Snapshot unavailable"]],
    "the badge must report the unusable snapshot rather than stay on the catch-up message",
  );
});

test("the snapshot that ends a catch-up owns the badge", () => {
  const harness = renderSnapshotHarness();
  assert.equal(harness.isCatchingUp(), true, "the harness must start from a catch-up in progress");

  harness.run({ run: { id: "run-1", status: "live" }, nodes: [{ id: "node-1", status: "running" }] });

  assert.equal(harness.isCatchingUp(), false, "the paint that replaced the pre-pause graph must end the catch-up");
  assert.deepEqual(
    harness.calls.connection,
    [["live", "Streaming"]],
    "the badge may claim live only once the graph under it is the one that was fetched",
  );
});

/**
 * A refetch that fails leaves the pre-pause graph on screen, so the catch-up is
 * over with nothing to show for it. The badge below the clear says so. Holding the
 * flag through a failure is the worst case of the three: the page keeps running,
 * and every later report about the stream is suppressed.
 */
function loadSnapshotHarness(overrides = {}) {
  const calls = { connection: [], empty: [], rendered: [], scheduled: 0 };
  const env = {
    selectionGeneration: 1,
    snapshotRequestInFlight: false,
    refreshAfterRequest: false,
    abortController: null,
    AbortController,
    setTimeout: () => 1,
    clearTimeout: () => {},
    STREAM_POLICY: { snapshotRequestTimeoutMs: 5_000 },
    fetch: () => Promise.reject(new Error("the observer is not answering")),
    endpointForSelection: (endpoint) => endpoint,
    snapshotEndpoint: "/api/live/snapshot",
    replayEndpoint: "/api/live/replay",
    selectedRunId: "run-1",
    scheduleSnapshotUpdate: () => { calls.scheduled += 1; },
    renderSnapshot: (snapshot) => { calls.rendered.push(snapshot); },
    updateConnection: (kind, message) => { calls.connection.push([kind, message]); },
    currentSnapshot: null,
    showEmpty: (message) => { calls.empty.push(message); },
    unloading: false,
    ...overrides,
  };
  const api = catchUpHarness(shippedAsyncHelper(renderLiveControlRoomPage(), "loadSnapshot"), env);
  return { ...api, calls };
}

test("a catch-up whose refetch fails ends the catch-up", async () => {
  const harness = loadSnapshotHarness();
  assert.equal(harness.isCatchingUp(), true, "the harness must start from a catch-up in progress");

  await harness.run(false);

  assert.equal(harness.isCatchingUp(), false, "a failed refetch must release the flag, not strand it set");
  assert.deepEqual(
    harness.calls.connection,
    [["stale", "Reconnecting"]],
    "a failed catch-up must report the failure instead of leaving the catch-up message up",
  );
});
