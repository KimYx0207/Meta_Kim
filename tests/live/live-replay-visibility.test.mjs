import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_REPLAY_VISIBILITY_SCHEMA_VERSION,
  resolveReplayNodeView,
  resolveReplayVisibleNodeIds,
  serializeReplayNodeViewResolver,
} from "../../src/application/live/live-replay-visibility.mjs";

const T0 = Date.parse("2026-08-30T10:00:00.000Z");
const at = (offsetSeconds) => new Date(T0 + offsetSeconds * 1000).toISOString();

/**
 * Faithful reproduction of the observed regression payload: eight graph nodes,
 * ten replay events, every event carrying a tool-level kind and an
 * `unavailable` visibility flag. The previous kind-allowlist gate let none of
 * these events through, so only the main node survived on screen.
 */
function toolLevelEventFixture() {
  const nodes = [
    { id: "node-main", isMain: true, status: "running", timing: { startedAt: at(0), completedAt: null } },
    { id: "node-workflow", kind: "workflow", status: "running", timing: { startedAt: at(2), completedAt: null } },
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `node-worker-${index + 1}`,
      kind: "agent",
      status: index < 3 ? "completed" : "running",
      timing: { startedAt: at(4 + index * 3), completedAt: index < 3 ? at(6 + index * 3) : null },
    })),
  ];
  const edges = [
    { id: "edge-contains-workflow", from: "node-main", to: "node-workflow", kind: "contains" },
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `edge-contains-worker-${index + 1}`,
      from: "node-workflow",
      to: `node-worker-${index + 1}`,
      kind: "contains",
    })),
  ];
  const events = Array.from({ length: 10 }, (_, index) => ({
    id: `event-${index}`,
    kind: "tool_start",
    visibility: "unavailable",
    nodeId: null,
    status: "running",
    label: `Read call ${index + 1}`,
    timestamp: at(5 + index * 2),
  }));
  return { nodes, edges, events };
}

test("schema version is declared for cross-layer contract checks", () => {
  assert.equal(LIVE_REPLAY_VISIBILITY_SCHEMA_VERSION, "meta-kim-live-replay-visibility-v1");
});

test("tool-level event streams must not hide the graph when the cursor sits at the end", () => {
  const { nodes, edges, events } = toolLevelEventFixture();
  const view = resolveReplayNodeView({ nodes, edges, events, cursorIndex: events.length - 1 });
  assert.equal(view.replayComplete, true);
  assert.equal(view.visibleNodeIds.length, nodes.length, "every declared node must render at the replay end");
  assert.deepEqual(view.visibleNodeIds, nodes.map((node) => node.id), "visible order must follow declared node order");
});

test("an empty replay stream shows present state rather than an empty canvas", () => {
  const { nodes, edges } = toolLevelEventFixture();
  const view = resolveReplayNodeView({ nodes, edges, events: [], cursorIndex: 0 });
  assert.equal(view.replayComplete, true);
  assert.equal(view.visibleNodeIds.length, nodes.length);
  for (const node of nodes) assert.equal(view.statusByNodeId[node.id], node.status, "present state keeps the declared status");
});

test("visibility never depends on event kind", () => {
  const { nodes, edges, events } = toolLevelEventFixture();
  const cursorIndex = 2;
  const baseline = resolveReplayNodeView({ nodes, edges, events, cursorIndex });
  const renamed = events.map((event) => ({ ...event, kind: "totally_unknown_kind", visibility: "hidden" }));
  const renamedView = resolveReplayNodeView({ nodes, edges, events: renamed, cursorIndex });
  assert.deepEqual(renamedView.visibleNodeIds, baseline.visibleNodeIds, "renaming every event kind must not change visibility");
});

test("mid-scrub hides only work that had not started yet", () => {
  const { nodes, edges, events } = toolLevelEventFixture();
  const cursorIndex = 1;
  const view = resolveReplayNodeView({ nodes, edges, events, cursorIndex });
  assert.equal(view.replayComplete, false);
  assert.equal(view.cursorTime, Date.parse(events[cursorIndex].timestamp));
  assert.ok(view.visibleNodeIds.includes("node-main"));
  assert.ok(view.visibleNodeIds.includes("node-worker-1"), "worker started before the cursor must be on screen");
  assert.ok(
    view.visibleNodeIds.length < nodes.length,
    "negative control: a mid-scrub cursor must genuinely hide later work, otherwise the positive assertions pass vacuously",
  );
  assert.ok(!view.visibleNodeIds.includes("node-worker-6"), "worker starting after the cursor must stay hidden");
});

test("declared-but-unstarted nodes stay on screen as queued", () => {
  const { nodes, edges, events } = toolLevelEventFixture();
  const withPending = [...nodes, { id: "node-pending", kind: "agent", status: "queued", timing: { startedAt: null, completedAt: null } }];
  const view = resolveReplayNodeView({ nodes: withPending, edges, events, cursorIndex: 0 });
  assert.ok(view.visibleNodeIds.includes("node-pending"), "the locked visual contract renders queued work as a dimmed dashed node");
  assert.equal(view.statusByNodeId["node-pending"], "queued");
});

test("a visible worker pulls in its structural parent lane", () => {
  const nodes = [
    { id: "node-main", isMain: true, status: "running", timing: { startedAt: at(0) } },
    { id: "node-lane", kind: "workflow", status: "running", timing: { startedAt: at(90) } },
    { id: "node-worker", kind: "agent", status: "running", timing: { startedAt: at(1) } },
  ];
  const edges = [{ id: "e1", from: "node-lane", to: "node-worker", kind: "contains" }];
  const events = [
    { id: "a", kind: "tool_start", nodeId: null, status: "running", timestamp: at(2) },
    { id: "b", kind: "tool_start", nodeId: null, status: "running", timestamp: at(200) },
  ];
  const view = resolveReplayNodeView({ nodes, edges, events, cursorIndex: 0 });
  assert.ok(view.visibleNodeIds.includes("node-worker"));
  assert.ok(view.visibleNodeIds.includes("node-lane"), "a worker must never float without its lane");

  const withoutStructuralEdge = resolveReplayNodeView({ nodes, edges: [], events, cursorIndex: 0 });
  assert.ok(
    !withoutStructuralEdge.visibleNodeIds.includes("node-lane"),
    "negative control: without the contains edge the late lane stays hidden, proving closure did the work",
  );
});

test("the cursor timestamp is read from the field the client normalizer emits", () => {
  const { nodes, edges, events } = toolLevelEventFixture();
  const normalized = events.map((event) => {
    const { timestamp, ...rest } = event;
    return { ...rest, at: timestamp };
  });
  const cursorIndex = 1;
  const fromAt = resolveReplayNodeView({ nodes, edges, events: normalized, cursorIndex });
  const fromTimestamp = resolveReplayNodeView({ nodes, edges, events, cursorIndex });
  assert.equal(fromAt.cursorTime, Date.parse(events[cursorIndex].timestamp), "the `at` field must resolve the cursor time");
  assert.deepEqual(fromAt.visibleNodeIds, fromTimestamp.visibleNodeIds, "`at` and `timestamp` payloads must agree");
  assert.ok(
    fromAt.visibleNodeIds.length < nodes.length,
    "negative control: reading the wrong field would fail open to all-visible and hide this regression",
  );
});

test("an unparseable cursor timestamp fails open instead of blanking the graph", () => {
  const { nodes, edges, events } = toolLevelEventFixture();
  const broken = events.map((event, index) => (index === 1 ? { ...event, timestamp: "not-a-timestamp" } : event));
  const view = resolveReplayNodeView({ nodes, edges, events: broken, cursorIndex: 1 });
  assert.equal(view.cursorTime, null);
  assert.equal(view.visibleNodeIds.length, nodes.length, "a missing timestamp must never hide nodes");
});

test("replay status prefers the latest event, then falls back to timing", () => {
  const nodes = [
    { id: "node-main", isMain: true, status: "running", timing: { startedAt: at(0) } },
    { id: "node-done", kind: "agent", status: "completed", timing: { startedAt: at(1), completedAt: at(3) } },
    { id: "node-busy", kind: "agent", status: "completed", timing: { startedAt: at(2), completedAt: at(400) } },
    { id: "node-later", kind: "agent", status: "completed", timing: { startedAt: at(300), completedAt: at(400) } },
    { id: "node-tagged", kind: "agent", status: "completed", timing: { startedAt: at(1), completedAt: at(400) } },
  ];
  const events = [
    { id: "a", kind: "tool_start", nodeId: "node-tagged", status: "blocked", timestamp: at(5) },
    { id: "b", kind: "tool_start", nodeId: null, status: "running", timestamp: at(500) },
  ];
  const view = resolveReplayNodeView({ nodes, edges: [], events, cursorIndex: 0 });
  assert.equal(view.statusByNodeId["node-tagged"], "blocked", "an event that names the node wins");
  assert.equal(view.statusByNodeId["node-done"], "completed", "finished before the cursor keeps its declared status");
  assert.equal(view.statusByNodeId["node-busy"], "running", "started but not yet finished reads as running");
  assert.equal(view.statusByNodeId["node-later"], "queued", "work starting after the cursor reads as queued");
});

test("malformed input degrades to an empty view instead of throwing", () => {
  assert.deepEqual(resolveReplayVisibleNodeIds(null), []);
  assert.deepEqual(resolveReplayVisibleNodeIds({ nodes: "nope", events: 7 }), []);
  assert.deepEqual(resolveReplayVisibleNodeIds({ nodes: [{ id: "" }, {}, null, { id: "ok" }], events: [] }), ["ok"]);
});

test("the serialized resolver is self-contained enough to run in the browser bundle", () => {
  const source = serializeReplayNodeViewResolver();
  assert.doesNotMatch(source, /\bimport\b|\brequire\(/u, "serialized source must not reference a module system");
  assert.doesNotMatch(source, /`/u, "serialized source must not contain backticks; it is inlined into a template literal");
  assert.doesNotMatch(source, /\$\{/u, "serialized source must not contain template substitutions");

  const isolated = new Function(`return (${source});`)();
  const { nodes, edges, events } = toolLevelEventFixture();
  const isolatedView = isolated({ nodes, edges, events, cursorIndex: 3 });
  const moduleView = resolveReplayNodeView({ nodes, edges, events, cursorIndex: 3 });
  assert.deepEqual(isolatedView, moduleView, "the inlined copy must behave identically to the module copy");
});
