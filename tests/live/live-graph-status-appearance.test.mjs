import assert from "node:assert/strict";
import test from "node:test";
import { renderLiveControlRoomPage } from "../../src/presentation/live/live-control-room-page.mjs";
import * as lifecycle from "../../src/presentation/live/live-run-overview.mjs";
import {
  classifyGraphRelations, resolveDependencyGraphLayout, resolveOrthogonalGraphRoute,
} from "../../src/application/live/live-graph-readability.mjs";
import { loadLiveGraphLayoutPolicy, resolveFanoutArrangement } from "../../src/application/live/live-graph-layout.mjs";
import { resolveReplayNodeView } from "../../src/application/live/live-replay-visibility.mjs";
import { evaluateMediaCondition, extractMediaBlocks } from "./_viewport-profiles.mjs";

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
  const names = ["graphNodesForSnapshot", "graphEdgesForSnapshot", "edgeMarkerId", "edgePortSlot", "edgeGeometry", "visibleGraphPositions", "refreshGraphEdgeGeometry", "setRootEntryGeometry", "setGraphRelationMode", "graphNodeIsActuallyRunning", "createGraphEdgeMotion", "renderGraph", "updateReplayPosition"];
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

test("only status words use red for in progress, yellow for completed and green for not started on neutral dark cards", () => {
  const view = graphHarness();
  view.renderGraph(snapshotFixture());
  const paint = rule('.graph-canvas .node-card[data-task-state], .graph-canvas[data-semantic-zoom] .node-card[data-task-state]');
  const statusPaint = rule('.graph-canvas[data-semantic-zoom] .node-card[data-task-state] .node-status, .graph-canvas[data-semantic-zoom] .node-card[data-task-state] .node-state-short');
  const inks = [];
  for (const [id, expectedState] of [["working", "in_progress"], ["returned", "completed"], ["waiting", "not_started"]]) {
    const card = view.env.graphState.nodeElements.get(id);
    assert.equal(card.dataset.taskState, expectedState);
    const tokens = { ...rootTokens, ...rule('.node-card[data-task-state="' + card.dataset.taskState + '"]'), ...paint };
    const fill = resolveValue(paint.background, tokens);
    inks.push(rgb(resolveValue(statusPaint.color, tokens)));
    for (const ink of [paint.color, tokens["--muted"], tokens["--node-state-ink"]]) {
      assert.ok(contrast(fill, resolveValue(ink, tokens)) >= 4.5, id + " text must remain readable on the dark neutral fill");
    }
    assert.ok(luminance(fill) < .04, "all states keep the same dark card surface");
    assert.equal(paint["--text"], undefined, "status styling cannot replace title or capability text tokens");
    assert.doesNotMatch(paint.border, /task-|node-state/u, "card borders stay neutral");
    assert.equal(card.dataset.status, snapshotFixture().nodes.find((node) => node.id === id).status, "raw source state is untouched");
  }
  assert.ok(inks[0][0] > inks[0][1] && inks[0][0] > inks[0][2], "in progress text is pale red");
  assert.ok(inks[1][0] > inks[1][2] + 20 && inks[1][1] > inks[1][2] + 20, "completed text is pale yellow");
  assert.ok(inks[2][1] > inks[2][0] && inks[2][1] > inks[2][2], "not started text is pale green");
  assert.ok(luminance(rule(".node-capability").background) < .04, "capability chips retain their original dark fill");
  assert.doesNotMatch(css, /node-card\[data-task-state\][^\n]*\s\.node-(?:title|glyph|capability)\b/u, "status state must not recolor titles, glyphs or capability contents");
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
      if (id === "waiting") assert.match(paint["stroke-dasharray"], /var\(--camera-scale, 1\)/u, "waiting dashes retain visible screen lengths at every zoom");
      else assert.equal(paint["stroke-dasharray"], "none");
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

test("dark card focus keeps the original accent instead of borrowing a task state color", () => {
  const focus = rule('.graph-canvas[data-semantic-zoom] .node-card[data-task-state]:is(:hover, :focus-visible, :focus-within, [data-selected="true"])');
  assert.equal(focus["border-color"], "var(--accent)");
  assert.ok(contrast(resolveValue(focus["border-color"], rootTokens), "#151d29") >= 3);
  assert.match(rule(".node-identity-button:focus-visible").outline, /rgba\(79,209,197/u, "the original internal focus appearance remains available");
});

test("actual running evidence gives the native main a large gold indicator without lighting unknown or queued children", () => {
  const view = graphHarness();
  const fixture = snapshotFixture();
  fixture.run.demoMode = false;
  fixture.run.observationKind = "native_execution";
  Object.assign(fixture.nodes[0], { status: "active", displayState: "active", active: true, executionState: "executing", executionObserved: true });
  Object.assign(fixture.nodes.find((node) => node.id === "unknown"), { active: true });
  Object.assign(fixture.nodes.find((node) => node.id === "waiting"), { active: true, declaredNotStarted: false });
  view.renderGraph(fixture);
  assert.equal(view.env.graphState.nodeElements.get("owner").dataset.runningObserved, "true");
  assert.equal(view.env.graphState.nodeElements.get("working").dataset.runningObserved, "true");
  for (const id of ["unknown", "waiting", "returned", "failed", "blocked"]) {
    assert.equal(view.env.graphState.nodeElements.get(id).dataset.runningObserved, "false", id + " must not get the gold running dot");
    assert.equal(view.env.graphState.edgeRoutes.get("edge-" + id).motion, null);
  }
  const indicator = rule('.graph-canvas[data-semantic-zoom] .node-card[data-running-observed="true"] .node-marker');
  const particle = rule('.edge-flow-particle[data-stage-focus="recorded"], .edge-flow-particle[data-stage-focus="live"]');
  assert.ok(Number(indicator.width.match(/calc\(([\d.]+)px/u)[1]) >= 14, "the node indicator is at least 14 screen pixels across");
  assert.ok(Number(particle.r.match(/calc\(([\d.]+)px/u)[1]) >= 5, "the routed dot is at least 10 screen pixels across");
  assert.equal(indicator.background, "var(--task-flow-ink)");
});

test("running markers keep screen dimensions in the mobile reading stack and the transformed desktop scene", () => {
  const selector = '.graph-canvas[data-semantic-zoom] .node-card[data-running-observed="true"] .node-marker';
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const mediaBlocks = extractMediaBlocks(css);
  const markerRules = [...css.matchAll(new RegExp(escaped + "\\s*\\{([^}]*)\\}", "gu"))].map((match) => ({
    paint: declarations(match[1]),
    media: mediaBlocks.find((block) => match.index >= block.startIndex
      && match.index < css.indexOf("{", block.startIndex) + 1 + block.body.length),
  }));
  for (const widthPx of [390, 720, 721, 884, 1440]) {
    const profile = { widthPx, heightPx: 871 };
    const applies = (block) => evaluateMediaCondition(block.condition, profile).applies;
    const untransformed = mediaBlocks.filter(applies).some((block) => /\.graph-scene\s*\{[^}]*transform:\s*none\s*!important/u.test(block.body));
    assert.equal(untransformed, widthPx <= 720, "the marker follows the shipped scene's mobile transform boundary");
    const paint = Object.assign({}, ...markerRules.filter(({ media }) => !media || applies(media)).map((entry) => entry.paint));
    for (const cameraScale of [.28, .45, 1]) {
      const screenLength = (value) => {
        const compensated = /^calc\(([\d.]+)px \/ var\(--camera-scale, 1\)\)$/u.exec(value);
        const cssPixels = compensated ? Number(compensated[1]) / cameraScale : parseFloat(value);
        return cssPixels * (untransformed ? 1 : cameraScale);
      };
      for (const value of [paint.width, paint.height, paint.flex.replace(/^0 0\s+/u, "")]) {
        assert.ok(Math.abs(screenLength(value) - 14) < .001, widthPx + "px viewport keeps a 14px running dot at camera scale " + cameraScale);
      }
      const halo = [...paint["box-shadow"].matchAll(/calc\([\d.]+px \/ var\(--camera-scale, 1\)\)|[\d.]+px/gu)].map(([value]) => screenLength(value));
      assert.equal(halo.length, 2);
      for (const [index, expected] of [4, 10].entries()) assert.ok(Math.abs(halo[index] - expected) < .001, "the visible halo follows the marker's screen scale");
    }
  }
});

test("native main gold indicators require current bound observed execution and reject contradictory or later terminal facts", () => {
  const base = snapshotFixture();
  base.run.demoMode = false;
  base.run.observationKind = "native_execution";
  Object.assign(base.nodes[0], { active: true, status: "active", displayState: "active", executionState: "executing", executionObserved: true });
  const cases = [
    ["completed main", { status: "completed", displayState: "completed" }],
    ["failed main", { status: "failed" }],
    ["blocked main", { displayState: "blocked" }],
    ["cancelled main", { status: "cancelled" }],
    ["unknown main", { status: "unknown", displayState: "unknown" }],
    ["in-doubt main", { status: "in_doubt" }],
    ["planned main", { status: "planned" }],
    ["not executed main", { executionState: "not_executed" }],
    ["missing executing state", { executionState: undefined }],
    ["missing actual observation", { executionObserved: false }],
    ["cross-run main", { runId: "another-run" }],
    ["unbound main", { runId: undefined }],
    ["inactive main", { active: false }],
    ["newer completion metadata", { timing: { startedAt: "2026-10-27T00:00:00Z", completedAt: "2026-10-27T00:01:00Z" } }],
    ["inactive run", {}, { active: false }],
    ["completed run", {}, { status: "completed" }],
    ["newer terminal display", {}, { displayState: "failed" }],
    ["unknown run", {}, { status: "unknown" }],
  ];
  for (const [label, nodePatch, runPatch] of cases) {
    const fixture = structuredClone(base);
    Object.assign(fixture.nodes[0], nodePatch);
    Object.assign(fixture.run, runPatch);
    const view = graphHarness();
    view.renderGraph(fixture);
    assert.equal(view.env.graphState.nodeElements.get("owner").dataset.runningObserved, "false", label + " cannot produce a gold node indicator");
  }
  const demo = graphHarness();
  demo.renderGraph(snapshotFixture());
  assert.equal(demo.env.graphState.nodeElements.get("owner").dataset.runningObserved, "true", "explicit demo running states remain usable for visible acceptance");
});

test("waiting edges retain clearly separated light gray dashes at the minimum camera scale", () => {
  const view = graphHarness();
  view.renderGraph(snapshotFixture());
  const waiting = view.env.graphState.edgeElements.get("edge-waiting");
  const paint = rule('.edge[data-task-state="' + waiting.dataset.taskState + '"]');
  const ink = resolveValue(paint.stroke, rootTokens);
  assert.ok(Math.max(...rgb(ink)) - Math.min(...rgb(ink)) < 40, "waiting lines remain neutral gray");
  assert.ok(contrast(ink, "#0e151f") >= 5, "waiting lines are visible on the dark grid without glow");
  const dashLengths = [...paint["stroke-dasharray"].matchAll(/calc\(([\d.]+)px \/ var\(--camera-scale, 1\)\)/gu)].map((match) => Number(match[1]));
  assert.equal(dashLengths.length, 2, "dash and gap are both compensated for the enclosing camera transform");
  assert.ok(dashLengths[0] >= 8 && dashLengths[1] >= 6, "the painted dash and gap stay distinct on screen");
  assert.ok(parseFloat(paint["--edge-screen-width"]) >= 2, "the gray route has a visible screen-space stroke");
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

test("the narrow-pane overview retains clear screen gaps without shrinking complete cards or lowering the zoom floor", () => {
  const policy = loadLiveGraphLayoutPolicy();
  const arrangement = resolveFanoutArrangement({ childCount: 9, chainLength: 1, mode: "compact", canvas: { width: 868.67, height: 360 },
    inset: { top: 26, right: 26, bottom: 26, left: 26 }, childWidth: policy.card.entityWidthPx, childHeight: policy.card.measuredMinHeightPx,
    chainWidth: policy.card.entityWidthPx, chainHeight: policy.card.measuredMinHeightPx }, policy);
  const mode = policy.modes.compact;
  assert.equal(policy.card.entityWidthPx, 252);
  assert.equal(policy.card.measuredMinHeightPx, 333);
  assert.ok(arrangement.fittedScale >= .28);
  assert.equal(arrangement.rows, 2);
  assert.ok((mode.childColumnStepPx - policy.card.entityWidthPx) * arrangement.fittedScale >= 56, "sibling cards have a clear horizontal screen gutter");
  assert.ok(mode.childRowGapPx * arrangement.fittedScale >= 50, "the reserved row gutter remains visible after fitting");
  assert.ok(arrangement.chainGap * arrangement.fittedScale >= 30, "the owner bus retains its own visible route lane");
});
