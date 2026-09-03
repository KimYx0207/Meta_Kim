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

  const calls = { catalog: [], connect: 0, snapshot: 0, disconnect: 0, timers: 0 };
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
      const disconnectEvents = () => { calls.disconnect += 1; };
      const updateConnection = () => {};
      const connectEvents = () => { calls.connect += 1; };
      const scheduleSnapshotUpdate = () => { calls.snapshot += 1; };
      const loadProjectCatalog = (options) => { calls.catalog.push(options); return Promise.resolve(true); };
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
