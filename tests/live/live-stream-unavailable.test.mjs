import assert from "node:assert/strict";
import test from "node:test";

import { renderLiveControlRoomPage } from "../../src/presentation/live/live-control-room-page.mjs";

/**
 * "The stream cannot open" was the one connection state no test constructed.
 * Every other branch — open, error, hidden-suspend, resume — had a guard, and
 * this one was covered only by reading the source and agreeing it looked right.
 * That is the shape of an assertion that would stay green if the branch were
 * deleted: a browser without `EventSource`, or one that throws constructing it,
 * would report a badge nobody had ever watched.
 *
 * The handler is sliced out of the rendered page rather than restated here, so
 * this cannot pass against a copy that no longer ships.
 */
function connectEventsHarness({ eventSourceCtor = undefined } = {}) {
  const html = renderLiveControlRoomPage();
  const start = html.indexOf("  function connectEvents(generation = selectionGeneration) {");
  assert.ok(start >= 0, "connectEvents() is no longer in the shipped client script");
  const end = html.indexOf("\n  }\n", start);
  assert.ok(end > start, "connectEvents() has no terminator, so the slice is unbounded");
  const source = html.slice(start, end + "\n  }".length);

  const calls = { connection: [], constructed: 0 };
  // In a browser `window.EventSource` and the bare `EventSource` are the same
  // binding. They are split here on purpose: the constructor is always a spy, so
  // the harness can see whether the handler *tried* to construct. Without that
  // split the feature-detection branch and the catch branch are indistinguishable
  // — both end at the same badge — and deleting the detection would stay green.
  const constructorSpy = function EventSourceSpy(...args) {
    calls.constructed += 1;
    if (typeof eventSourceCtor === "function") return Reflect.construct(eventSourceCtor, args);
    throw new TypeError("EventSource is not a constructor");
  };
  const bind = new Function(
    "window",
    "EventSource",
    "calls",
    `
      const selectionGeneration = 1;
      let eventSource = null;
      let catchingUpAfterPause = false;
      const eventsEndpoint = "/live/events";
      const endpointForSelection = (endpoint) => endpoint;
      const handleEvent = () => {};
      const updateConnection = (kind, message) => { calls.connection.push([kind, message]); };
      // The shipped handler now arms a real interval on this branch. The stub
      // records that the fallback was reached without giving this harness a
      // clock; the poll's own behavior is pinned in the page test suite.
      const startPollingFallback = () => { calls.pollingFallbackArmed = true; };
      const stopPollingFallback = () => {};
      ${source}
      return connectEvents;
    `,
  );
  const connectEvents = bind({ EventSource: eventSourceCtor }, constructorSpy, calls);
  connectEvents();
  return calls;
}

test("a browser with no EventSource is told the page fell back to polling, without attempting a connection", () => {
  const calls = connectEventsHarness({ eventSourceCtor: undefined });

  assert.deepEqual(
    calls.connection,
    [["stale", "Polling snapshot"]],
    "a page that cannot open a stream must say so instead of leaving the badge on its last value",
  );
  assert.equal(
    calls.constructed,
    0,
    "the absent-EventSource state must be detected, not discovered by constructing one and catching the failure",
  );
  assert.equal(calls.pollingFallbackArmed, true, "the badge must name a fallback that actually exists");
});

test("a constructor that throws lands in the same reported state, not an unhandled rejection", () => {
  const calls = connectEventsHarness({
    eventSourceCtor: function ThrowingEventSource() {
      throw new Error("SecurityError: connection refused by policy");
    },
  });

  assert.equal(calls.constructed, 1, "a present EventSource must actually be attempted");
  assert.deepEqual(calls.connection, [["stale", "Polling snapshot"]]);
  assert.equal(calls.pollingFallbackArmed, true, "a refused constructor must land in the same real polling fallback");
});

/**
 * The badge alone is not the deliverable. `switchSelection()` paints "Loading
 * the selected run…" and then awaits the snapshot *before* it touches the
 * stream, so the run still reaches the screen on a stream-less browser. If those
 * two were ever reordered — connect first, load after — a browser without
 * `EventSource` would sit on the loading copy with nothing on its way.
 */
test("the snapshot is awaited before the stream is attempted, so a stream-less browser still paints", () => {
  const html = renderLiveControlRoomPage();
  const start = html.indexOf("  async function switchSelection(projectId, runIdentifier, { updateUrl = true } = {}) {");
  assert.ok(start >= 0, "switchSelection() is no longer in the shipped client script");
  const body = html.slice(start, html.indexOf("\n  }\n", start));

  const loading = body.indexOf('showEmpty("Loading the selected run…")');
  const load = body.indexOf("await loadSnapshot(false, generation)");
  const connect = body.indexOf("connectEvents(generation)");
  assert.ok(loading >= 0 && load >= 0 && connect >= 0, "the selection path must keep all three steps");
  assert.ok(loading < load, "the loading copy must be shown before the snapshot is requested");
  assert.ok(
    load < connect,
    "the snapshot must be awaited before the stream is attempted, or a stream-less browser stalls on the loading copy",
  );
});

test("the polling fallback copy is translated, so the Chinese page does not report in English", () => {
  const html = renderLiveControlRoomPage();

  assert.match(html, /"Polling snapshot":\s*"正在轮询运行快照"/u);
});
