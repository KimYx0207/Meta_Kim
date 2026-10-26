import assert from "node:assert/strict";
import test from "node:test";
import { renderLiveControlRoomPage } from "../../src/presentation/live/live-control-room-page.mjs";
import * as lifecycle from "../../src/presentation/live/live-run-overview.mjs";
import {
  classifyGraphRelations, resolveDependencyGraphLayout, resolveOrthogonalGraphRoute,
} from "../../src/application/live/live-graph-readability.mjs";
import { loadLiveGraphLayoutPolicy, resolveFanoutArrangement } from "../../src/application/live/live-graph-layout.mjs";
import { resolveReplayNodeView } from "../../src/application/live/live-replay-visibility.mjs";

const html = renderLiveControlRoomPage();
const css = html.match(/<style>([\s\S]*?)<\/style>/u)[1];

/** Execute the shipped browser helpers, without starting a browser or a server. */
function shippedHelper(name) {
  const start = html.indexOf("  function " + name + "(");
  assert.ok(start >= 0, name + " must be shipped");
  const end = Math.min(...["\n  function ", "\n  async function "].map((token) => html.indexOf(token, start + 1)).filter((index) => index > start));
  return html.slice(start, end);
}

/** A small SVG/DOM tree retains parent ownership so detached motions are testable. */
function element(tagName, className = "", textContent = "") {
  return {
    tagName, className, textContent, dataset: {}, style: {}, attributes: new Map(), children: [],
    append(...items) { items.forEach((item) => { item.parentNode = this; this.children.push(item); }); },
    replaceChildren() { this.children.forEach((item) => { item.parentNode = null; }); this.children = []; },
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    getAttribute(name) { return this.attributes.get(name); },
    removeAttribute(name) { this.attributes.delete(name); },
    querySelectorAll(selector) {
      const key = { "[data-stage-focus]": "stageFocus", "[data-node-id]": "nodeId", "[data-replay-index]": "replayIndex" }[selector];
      return descendants(this).filter((item) => key in item.dataset);
    },
    addEventListener() {},
    get childElementCount() { return this.children.length; },
    get offsetWidth() { return parseFloat(this.style.width) || 252; },
    get offsetHeight() { return parseFloat(this.style.minHeight) || 333; },
  };
}

function descendants(root, tagName) {
  return root.children.flatMap((item) => [...(!tagName || item.tagName === tagName ? [item] : []), ...descendants(item, tagName)]);
}

/** Render real cards and edges; only unrelated inspector/camera side effects are stubs. */
function graphHarness({ reduced = false } = {}) {
  const env = {
    ...lifecycle, classifyGraphRelations, resolveOrthogonalGraphRoute, resolveReplayNodeView,
    currentLanguage: "zh", relationMode: "dependency", relationModeExplicit: false,
    camera: { scale: 1 }, graph: { dataset: { semanticZoom: "card" }, clientWidth: 1400, clientHeight: 700 },
    currentSnapshot: null, currentReplayIndex: 0, replayFollowingLive: false, selectedNodeId: null, graphFollowing: false,
    replayRange: null, replayProgress: null, replayStatus: null, replayEvents: null, replayPrev: null, replayNext: null, replayLive: null,
    STRUCTURAL_EDGE_KINDS: new Set(["contains"]), centerGraphNode() {}, updateSelectedNodeRelations() {},
    graphState: {}, graphScene: { style: {} }, nodeList: element("section"), edgeLayer: element("svg"),
    graphMinimapScene: null, graphEmpty: null, DISPLAY_FORMAT: {},
    reducedMotion: { matches: reduced }, window: { innerWidth: 1440 },
    EXECUTION_EDGE_KINDS: new Set(["sequence", "fork", "depends_on"]),
    document: { createElementNS: (_ns, tag) => element(tag) }, makeElement: element,
    clearChildren: (item) => item?.replaceChildren(), nodeClass: (state) => state === "active" ? "running" : state,
    resolveNodeTaskLine: (node) => node.task || "", graphNodeReadingLabel: (node) => node.label,
    nodeStateCopy: (node, runId) => lifecycle.liveTaskLifecycleCopy(lifecycle.resolveLiveTaskLifecycle(node, runId)).label,
    nodeShortStateCopy: (node, runId) => lifecycle.liveTaskLifecycleCopy(lifecycle.resolveLiveTaskLifecycle(node, runId)).label,
    nodeStateDetailCopy: (node, runId) => lifecycle.liveTaskLifecycleCopy(lifecycle.resolveLiveTaskLifecycle(node, runId)).detail,
    formatLiveTokenCount: String, usefulNodeMeta: () => false, formatDuration: () => "", localize: (value) => value,
    syncLayoutToRenderedCards() {}, relayoutWarrantedAfterMeasurement: () => false,
    updateCamera() {}, updateGraphRelationPresentation() {}, updateSelectedNodeVisuals() {}, observeGraphCardSizes() {},
    updateGraphRelationControls() {},
    layoutGraph(snapshot) {
      const positions = new Map(snapshot.nodes.map((node, index) => [node.id, { x: 44 + index * 430, y: 70 + index % 2 * 460, width: 252, height: 333 }]));
      return { positions, kind: "layered", bounds: { width: 3000, height: 1100 } };
    },
  };
  const names = ["graphNodesForSnapshot", "graphEdgesForSnapshot", "edgeMarkerId", "edgePortSlot", "edgeGeometry", "visibleGraphPositions", "refreshGraphEdgeGeometry", "setRootEntryGeometry", "setGraphRelationMode", "createGraphEdgeMotion", "renderGraph", "updateReplayPosition"];
  const api = new Function("env", "with (env) {\n" + names.map(shippedHelper).join("\n")
    + "\nreturn { renderGraph, refreshGraphEdgeGeometry, setGraphRelationMode, updateReplayPosition };\n}")(env);
  return { env, ...api, renderGraph(snapshot) { env.currentSnapshot = snapshot; api.renderGraph(snapshot); } };
}

function snapshotFixture(kind = "contains") {
  const runId = "demo-status-appearance";
  const nodes = [
    { id: "owner", status: "running", displayState: "active", isMain: true, kind: "main_agent" },
    { id: "waiting", status: "queued", displayState: "queued", declaredNotStarted: true },
    { id: "working", status: "running", displayState: "active" },
    { id: "returned", status: "completed", displayState: "completed" },
    { id: "blocked", status: "blocked", displayState: "blocked" },
    { id: "failed", status: "failed", displayState: "failed" },
    { id: "unknown", status: "in_doubt", displayState: "unknown" },
  ].map((node, index) => ({ label: "演示 · " + node.id, task: "演示任务 " + index, kind: "worker", runId,
    summary: "仅验证视觉，不是真实执行", toolCount: 0, evidenceCount: 0, capabilityTruth: [], ...node }));
  return { run: { id: runId, active: true, status: "active", demoMode: true }, nodes,
    edges: nodes.slice(1).map((node) => ({ id: "edge-" + node.id, from: "owner", to: node.id, kind, status: node.status })) };
}

function declarations(body) {
  return Object.fromEntries(body.split(";").map((part) => part.split(/:(.*)/su).slice(0, 2).map((value) => value.trim())).filter(([key, value]) => key && value));
}

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = css.match(new RegExp("(?:^|[}\\n])\\s*" + escaped + "\\s*\\{([^}]*)\\}", "u"));
  assert.ok(match, "shipped style rule for " + selector);
  return declarations(match[1]);
}

const rootTokens = Object.assign({}, ...[...css.matchAll(/:root\s*\{([^}]*)\}/gu)].map((match) => declarations(match[1])));
function resolveValue(value, tokens) {
  return value.replace(/var\((--[\w-]+)\)/gu, (_match, token) => {
    assert.ok(tokens[token], "declared token " + token);
    return resolveValue(tokens[token], tokens);
  });
}

function rgb(hex) { return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)); }
function luminance(hex) {
  const channels = rgb(hex).map((channel) => channel / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
function contrast(a, b) { return (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05); }

test("rendered task states select red, yellow and green card fills with dark readable text in both camera tiers", () => {
  const view = graphHarness();
  view.renderGraph(snapshotFixture());
  const paint = rule('.graph-canvas .node-card[data-task-state], .graph-canvas[data-semantic-zoom] .node-card[data-task-state]');
  const fills = [];
  for (const [id, expectedState] of [["waiting", "not_started"], ["working", "in_progress"], ["returned", "completed"]]) {
    const card = view.env.graphState.nodeElements.get(id);
    assert.equal(card.dataset.taskState, expectedState);
    const tokens = { ...rootTokens, ...rule('.node-card[data-task-state="' + card.dataset.taskState + '"]'), ...paint };
    const fill = resolveValue(paint.background, tokens);
    fills.push(rgb(fill));
    for (const ink of [paint.color, tokens["--muted"], tokens["--node-state-ink"]]) {
      assert.ok(contrast(fill, resolveValue(ink, tokens)) >= 4.5, id + " text must remain readable on its pale fill");
    }
    assert.equal(card.dataset.status, snapshotFixture().nodes.find((node) => node.id === id).status, "raw source state is untouched");
  }
  assert.ok(fills[0][0] > fills[0][1] && fills[0][0] > fills[0][2], "not started is pale red");
  assert.ok(fills[1][0] > fills[1][2] + 20 && fills[1][1] > fills[1][2] + 20, "in progress is pale yellow");
  assert.ok(fills[2][1] > fills[2][0] && fills[2][1] > fills[2][2], "completed is pale green");
  assert.ok(rule('.graph-canvas[data-semantic-zoom] .node-card[data-task-state]:is(:hover, :focus-visible, :focus-within, [data-selected="true"])').outline, "focus and selection remain visible independently of fill");
});

test("ownership-only snapshots show real associations by default and respect an explicit dependency filter", () => {
  const view = graphHarness();
  const fixture = snapshotFixture();
  view.renderGraph(fixture);
  assert.equal(view.env.relationMode, "all");
  for (const edge of view.env.graphState.edgeElements.values()) {
    assert.equal(edge.dataset.edgeKind, "contains");
    assert.equal(edge.getAttribute("marker-end"), undefined, "ownership has no dependency arrow");
  }
  view.setGraphRelationMode("dependency");
  view.renderGraph(fixture);
  assert.equal(view.env.relationMode, "dependency", "redrawing cannot override the viewer's choice");
  assert.deepEqual(fixture, snapshotFixture(), "rendering never changes relations or execution truth");
});

test("graph captions use the native task display label and keep source wording in tooltips", () => {
  const view = graphHarness();
  const fixture = snapshotFixture();
  Object.assign(fixture.nodes[2], { nativeTaskCaption: "javascript-pro", nativeTaskOrdinal: 2, label: "internal_graph_alias", task: "internal_task_alias" });
  view.renderGraph(fixture);
  const card = view.env.graphState.nodeElements.get("working");
  const heading = descendants(card, "span").find((item) => item.className === "node-title");
  const task = descendants(card, "p").find((item) => item.className === "node-task");
  assert.equal(heading.textContent, "代码实现 2");
  assert.equal(task.textContent, "代码实现 2");
  assert.equal(heading.title, "internal_graph_alias");
  assert.equal(task.title, "internal_task_alias");
  assert.match(card.title, /internal_graph_alias.*internal_task_alias/u);
});

test("only an actively progressing target gets a gold particle on its own route; terminal and uncertain work stays static", () => {
  for (const kind of ["contains", "depends_on"]) {
    const view = graphHarness();
    view.renderGraph(snapshotFixture(kind));
    for (const [id, expected] of [["waiting", "not_started"], ["working", "in_progress"], ["returned", "completed"]]) {
      const route = view.env.graphState.edgeRoutes.get("edge-" + id);
      const path = route.paths[0];
      assert.equal(path.dataset.taskState, expected);
      const paint = rule('.edge[data-task-state="' + expected + '"]');
      assert.equal(paint["stroke-dasharray"], id === "waiting" ? "5 9" : "none");
      assert.equal(paint.animation, "none", "the moving object is not a rolling dash");
      assert.equal(Boolean(route.motion), id === "working");
      if (route.motion) {
        assert.equal(route.motion.getAttribute("path"), path.getAttribute("d"));
        assert.equal(route.motion.getAttribute("repeatCount"), "indefinite");
        assert.equal(route.motion.getAttribute("calcMode"), "linear");
        const [start, end] = route.motion.getAttribute("keyPoints").split(";").map(Number);
        assert.ok(start > 0 && end < 1 && end > start, "particle keeps clear of the endpoint arrows and cards");
      }
    }
    for (const id of ["blocked", "failed", "unknown"]) assert.equal(view.env.graphState.edgeRoutes.get("edge-" + id).motion, null, id + " must not imply advancement");
  }
});

test("uncertain work has neutral static lines and arrows, while stale running relations honor failed or blocked targets", () => {
  const view = graphHarness();
  const fixture = snapshotFixture("depends_on");
  fixture.edges.forEach((edge) => { edge.status = "running"; });
  view.renderGraph(fixture);
  const unknown = view.env.graphState.edgeElements.get("edge-unknown");
  assert.equal(unknown.dataset.taskDetail, "unconfirmed");
  assert.equal(unknown.getAttribute("marker-end"), "url(#live-edge-arrow-unknown)");
  const neutral = rule('.edge[data-task-state="in_progress"][data-task-detail="unconfirmed"], .edge[data-task-state="in_progress"][data-task-detail="result_unconfirmed"]');
  assert.notEqual(resolveValue(neutral.stroke, rootTokens), resolveValue("var(--task-flow-ink)", rootTokens));
  assert.equal(neutral["stroke-dasharray"], "3 6");
  for (const state of ["failed", "blocked"]) {
    const edge = view.env.graphState.edgeElements.get("edge-" + state);
    assert.equal(edge.dataset.taskDetail, state);
    assert.equal(edge.getAttribute("marker-end"), "url(#live-edge-arrow-" + state + ")");
    assert.equal(view.env.graphState.edgeRoutes.get("edge-" + state).motion, null);
  }
  const native = fixture.nodes.find((node) => node.id === "returned");
  Object.assign(native, { status: "in_doubt", displayState: "unknown", executionState: "executed", active: false, taskPacketId: "native-task:returned",
    nativeReturnEvidence: { runId: fixture.run.id, nodeId: native.id, taskPacketId: "native-task:returned", evidenceKind: "native_host_observation",
      sourceKind: "codex_desktop_native_session", executionObserved: true, synthetic: false, sourceEventId: "demo-native:return",
      observedAt: "2026-10-27T00:00:00Z", sourceDigest: "a".repeat(64) } });
  view.renderGraph(fixture);
  const returned = view.env.graphState.edgeElements.get("edge-returned");
  assert.equal(returned.dataset.taskState, "completed");
  assert.equal(returned.dataset.taskDetail, "result_unconfirmed");
  assert.equal(returned.getAttribute("marker-end"), "url(#live-edge-arrow-completed)");
});

test("keyboard focus on the actual card buttons uses an opaque outline with contrast on every pale fill", () => {
  const focus = rule('.graph-canvas[data-semantic-zoom] .node-card[data-task-state] .node-identity-button:focus-visible, .graph-canvas[data-semantic-zoom] .node-card[data-task-state] .node-capability:focus-visible');
  const ink = focus.outline.split(" ").at(-1);
  assert.match(ink, /^#[a-f0-9]{6}$/u);
  for (const state of ["not_started", "in_progress", "completed"]) {
    const tokens = { ...rootTokens, ...rule('.node-card[data-task-state="' + state + '"]') };
    assert.ok(contrast(ink, resolveValue("var(--node-state-bg)", tokens)) >= 3, state + " internal button focus remains distinguishable");
  }
});

test("replay lazily animates a recorded active transition from a completed snapshot and reuses that route safely", () => {
  for (const kind of ["contains", "depends_on"]) for (const reduced of [false, true]) {
    const view = graphHarness({ reduced });
    const fixture = snapshotFixture(kind);
    Object.assign(fixture.run, { status: "completed", active: false });
    fixture.nodes.find((node) => node.id === "working").status = "completed";
    fixture.nodes.find((node) => node.id === "working").displayState = "completed";
    fixture.edges.find((edge) => edge.to === "working").status = "completed";
    fixture.replay = [
      { nodeId: "owner", status: "active", label: "owner starts" },
      ...["queued", "running", "unknown", "failed", "completed"].map((status) => ({ nodeId: "working", status, label: status })),
    ];
    view.renderGraph(fixture);
    const route = view.env.graphState.edgeRoutes.get("edge-working");
    assert.equal(route.motion, null, "a completed snapshot creates no live motion");
    view.updateReplayPosition(1);
    assert.equal(route.motion, null, "future active events must not advance a queued task");
    view.updateReplayPosition(2);
    assert.equal(Boolean(route.motion), !reduced, "only the recorded active transition can create motion");
    assert.equal(route.paths[0].dataset.stageFocus, "recorded");
    if (!reduced) assert.equal(route.motion.getAttribute("path"), route.paths[0].getAttribute("d"));
    view.updateReplayPosition(3);
    assert.equal(route.paths[0].dataset.stageFocus, "none");
    assert.equal(route.paths[0].dataset.taskDetail, "unconfirmed");
    if (kind === "depends_on") assert.equal(route.paths[0].getAttribute("marker-end"), "url(#live-edge-arrow-unknown)");
    view.updateReplayPosition(4);
    assert.equal(route.paths[0].dataset.stageFocus, "none");
    assert.equal(route.paths[0].dataset.taskDetail, "failed");
    view.updateReplayPosition(2);
    assert.equal(descendants(view.env.edgeLayer, "animateMotion").length, reduced ? 0 : 1, "seeking reuses a single animation");
    view.updateReplayPosition(5);
    assert.equal(route.paths[0].dataset.stageFocus, "none");
    assert.equal(route.paths[0].dataset.taskState, "completed");
    assert.ok(view.env.graphState.edgeEffects.get("edge-working").querySelectorAll("[data-stage-focus]").every((part) => part.dataset.stageFocus === "none"));
  }
});

test("geometry changes update the registered moving point and redraw detaches every previous animation", () => {
  const view = graphHarness();
  view.renderGraph(snapshotFixture());
  const previous = view.env.graphState.edgeRoutes.get("edge-working");
  const oldPath = previous.motion.getAttribute("path");
  view.env.graphState.positions.get("working").y += 170;
  view.env.graphState.edgeGeometryKey = null;
  view.refreshGraphEdgeGeometry();
  assert.notEqual(previous.motion.getAttribute("path"), oldPath);
  assert.equal(previous.motion.getAttribute("path"), previous.paths[0].getAttribute("d"));
  const movedPath = previous.motion.getAttribute("path");
  view.env.graphState.nodeElements.get("working").style.minHeight = "170px";
  view.env.graph.dataset.semanticZoom = "cell";
  view.env.camera.scale = .45;
  view.refreshGraphEdgeGeometry();
  assert.notEqual(previous.motion.getAttribute("path"), movedPath, "cell ports follow the visible card at its new scale");
  assert.equal(previous.motion.getAttribute("path"), previous.paths[0].getAttribute("d"));
  assert.equal(view.env.graphState.positions.get("working").height, 333, "semantic zoom preserves the complete-card reservation");
  const oldEffects = view.env.graphState.edgeEffects.get("edge-working");
  for (let index = 0; index < 4; index += 1) view.renderGraph(snapshotFixture());
  assert.equal(oldEffects.parentNode, null, "the old SVG animation subtree was detached");
  assert.equal(descendants(view.env.edgeLayer, "animateMotion").length, 1, "redraw never accumulates motion elements");
  assert.notEqual(view.env.graphState.edgeRoutes.get("edge-working").motion, previous.motion);
  view.renderGraph({ run: snapshotFixture().run, nodes: [], edges: [] });
  assert.equal(descendants(view.env.edgeLayer, "animateMotion").length, 0);
  assert.equal(view.env.graphState.edgeRoutes.size, 0);
});

test("reduced motion removes route animations while preserving line state and contrast", () => {
  const view = graphHarness({ reduced: true });
  view.renderGraph(snapshotFixture());
  assert.equal(descendants(view.env.edgeLayer, "animateMotion").length, 0);
  assert.equal(view.env.graphState.edgeElements.get("edge-working").dataset.taskState, "in_progress");
  const reducedRule = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reducedRule, /\.edge-flow-particle[^}]*display:\s*none/u, "changing the OS preference also hides existing SVG motion immediately");
  for (const state of ["not_started", "in_progress", "completed"]) {
    const ink = resolveValue(rule('.edge[data-task-state="' + state + '"]').stroke, rootTokens);
    assert.ok(contrast(ink, "#0e151f") >= 3, state + " line remains visible without glow");
  }
});

test("configured gutters keep complete cards separate in card and cell dependency layouts", () => {
  const policy = loadLiveGraphLayoutPolicy();
  const fixture = snapshotFixture("depends_on");
  const plan = classifyGraphRelations(fixture.nodes, fixture.edges, new Set(["depends_on"]));
  for (const mode of Object.values(policy.modes)) for (const tier of ["card", "cell"]) {
    const layout = resolveDependencyGraphLayout({ plan, canvas: { width: 1400, height: 700 }, inset: {},
      cardWidth: policy.card.entityWidthPx, cardHeight: policy.card.measuredMinHeightPx,
      tier, scale: .5, cellScreenHeight: 64, columnGap: mode.entityColumnStepPx - policy.card.entityWidthPx,
      rowGap: mode.entityRowGapPx, padding: policy.scenePaddingPx });
    const boxes = [...layout.positions.values()];
    for (let left = 0; left < boxes.length; left += 1) for (let right = left + 1; right < boxes.length; right += 1) {
      const a = boxes[left], b = boxes[right];
      const horizontalGap = Math.max(b.x - a.x - a.width, a.x - b.x - b.width);
      const verticalGap = Math.max(b.y - a.y - a.height, a.y - b.y - b.height);
      assert.ok(horizontalGap >= 62 || verticalGap >= 62, "boxes retain at least a visible routing gutter in either axis");
    }
  }
  const fanout = resolveFanoutArrangement({ childCount: 15, chainLength: 2, mode: "compact", canvas: { width: 1651.3, height: 333.8 },
    inset: { top: 26, right: 26, bottom: 26, left: 26 }, childWidth: 252, childHeight: 333, chainWidth: 252, chainHeight: 333 }, policy);
  assert.equal(fanout.rows, 2);
  assert.ok(fanout.chainGap >= 64, "the ownership bus has its own lane");
});
