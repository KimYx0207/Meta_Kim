import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyGraphRelations,
  resolveDependencyGraphLayout,
  resolveGraphEdgePresentation,
  resolveOrthogonalGraphRoute,
  serializeGraphReadabilityResolvers,
} from "../../src/application/live/live-graph-readability.mjs";
import { loadLiveGraphCameraPolicy, resolveOverviewCamera } from "../../src/application/live/live-graph-camera.mjs";
import { loadLiveGraphLayoutPolicy } from "../../src/application/live/live-graph-layout.mjs";

const EXECUTION_KINDS = ["sequence", "depends_on", "dependency", "fork", "join", "blocks", "execution", "invokes"];

// Shape of the real 15-node run that exposed this defect, with portable IDs.
// Ownership is a separate fact, not a predecessor for the nine task roles.
const context = ["owner", "discovery", "design", "implementation", "verification", "closure"];
const workers = ["product-definition", "market-research", "content-strategy", "ux-flow", "frontend-ui", "backend-api", "data-model", "test-qa", "release-ops"];
const nodes = [...context.map((id, index) => ({ id, label: id, kind: index ? "workflow" : "agent", isMain: index === 0, status: "unreported" })),
  ...workers.map((id) => ({ id, label: id, kind: "agent", status: "unreported" }))];
const ownership = [
  ...context.slice(1).map((id) => ["owner", id]),
  ["discovery", "product-definition"], ["discovery", "market-research"],
  ["design", "content-strategy"], ["design", "ux-flow"],
  ["implementation", "frontend-ui"], ["implementation", "backend-api"], ["implementation", "data-model"],
  ["verification", "test-qa"], ["closure", "release-ops"],
];
for (const [parent, child] of ownership) nodes.find((node) => node.id === child).parentId = parent;
const dependency = [
  ["product-definition", "content-strategy"], ["market-research", "content-strategy"],
  ["product-definition", "ux-flow"], ["content-strategy", "ux-flow"], ["ux-flow", "frontend-ui"],
  ["frontend-ui", "test-qa"], ["backend-api", "test-qa"], ["data-model", "test-qa"], ["test-qa", "release-ops"],
];
const edges = [...ownership.map(([from, to]) => ({ from, to, kind: "contains" })),
  ...dependency.map(([from, to]) => ({ from, to, kind: "depends_on" }))].map((edge, index) => ({ ...edge, id: "edge-" + index, status: "unreported" }));

function arrange(canvas, { tier = "cell", scale = 0.28, plan = classifyGraphRelations(nodes, edges, EXECUTION_KINDS), arrangement, nodeHeights } = {}) {
  const policy = loadLiveGraphLayoutPolicy();
  const mode = policy.modes.compact;
  return resolveDependencyGraphLayout({
    plan, canvas, inset: { top: 26, right: 26, bottom: 26, left: 26 }, tier, scale, cellScreenHeight: 64,
    cardWidth: policy.card.entityWidthPx, cardHeight: policy.card.measuredMinHeightPx, nodeHeights,
    columnGap: mode.entityColumnStepPx - policy.card.entityWidthPx, rowGap: mode.entityRowGapPx,
    padding: policy.scenePaddingPx, arrangement,
  });
}

function assertNoOverlap(layout) {
  const positions = [...layout.positions];
  for (let i = 0; i < positions.length; i += 1) for (let j = i + 1; j < positions.length; j += 1) {
    const [leftId, left] = positions[i];
    const [rightId, right] = positions[j];
    assert.ok(left.x + left.width <= right.x || right.x + right.width <= left.x
      || left.y + left.height <= right.y || right.y + right.height <= left.y,
    leftId + " overlaps " + rightId);
  }
}

test("the observed mixed run keeps 15 nodes and 23 relations, with ownership excluded from execution ranks", () => {
  const before = JSON.stringify({ nodes, edges });
  const plan = classifyGraphRelations(nodes, edges, EXECUTION_KINDS);
  assert.deepEqual([plan.nodes.length, plan.edges.length, plan.executionNodes.length, plan.contextNodes.length, plan.executionEdges.length, plan.structuralEdges.length], [15, 23, 9, 6, 9, 14]);
  assert.deepEqual(Object.fromEntries(plan.rankById), {
    "backend-api": 0, "data-model": 0, "market-research": 0, "product-definition": 0,
    "content-strategy": 1, "ux-flow": 2, "frontend-ui": 3, "test-qa": 4, "release-ops": 5,
  });
  assert.deepEqual(Object.fromEntries(classifyGraphRelations([...nodes].reverse(), [...edges].reverse(), EXECUTION_KINDS).rankById), Object.fromEntries(plan.rankById));
  assert.equal(JSON.stringify({ nodes, edges }), before, "presentation must not rewrite any raw state, node or edge");
});

test("current short/narrow and desktop canvases fit the honest mixed scene without reducing the camera floor", () => {
  for (const canvas of [{ width: 815, height: 380 }, { width: 1200, height: 300 }, { width: 1500, height: 530 }]) {
    const layout = arrange(canvas);
    assert.equal(layout.positions.size, 15);
    assert.equal(layout.bands[0].group, "context");
    const fit = resolveOverviewCamera(canvas, layout.bounds, layout.inputs.inset, loadLiveGraphCameraPolicy());
    assert.equal(fit.wholeGraphFits, true, JSON.stringify({ canvas, bounds: layout.bounds, fit }));
    assert.ok(fit.scale >= 0.28);
    assertNoOverlap(layout);
    const sourceIds = workers.filter((id) => layout.positions.get(id).source);
    assert.equal(sourceIds.length, 4, "packing must not manufacture more predecessor-free tasks");
    for (const [from, to] of dependency) assert.ok(layout.positions.get(from).x + layout.positions.get(from).width < layout.positions.get(to).x,
      from + " must remain before " + to);
  }
});

test("card LOD restores the separately measured full-card budget, and cell zoom does not claim that budget is a cell", () => {
  const canvas = { width: 815, height: 380 };
  const heights = new Map(nodes.map((node, index) => [node.id, 333 + index * 11]));
  const cell = arrange(canvas, { scale: 0.3, nodeHeights: heights });
  const card = arrange(canvas, { tier: "card", scale: 1.1, nodeHeights: heights });
  assertNoOverlap(cell);
  assertNoOverlap(card);
  for (const node of nodes) {
    assert.equal(cell.positions.get(node.id).height, 64 / 0.3);
    assert.equal(card.positions.get(node.id).height, heights.get(node.id));
  }
  const zoomed = arrange(canvas, { scale: 0.6, arrangement: cell.arrangement, nodeHeights: heights });
  assert.deepEqual(zoomed.arrangement, cell.arrangement, "same-tier zoom preserves the independent-source packing");
  assertNoOverlap(zoomed);
});

function assertClearRoute(route, positions) {
  assert.equal(route.obstructed, false);
  for (let i = 1; i < route.points.length; i += 1) {
    const a = route.points[i - 1];
    const b = route.points[i];
    assert.ok(a[0] === b[0] || a[1] === b[1], "all segments must be orthogonal");
    for (const box of positions.values()) {
      const crosses = a[1] === b[1]
        ? a[1] > box.y + 0.01 && a[1] < box.y + box.height - 0.01 && Math.max(a[0], b[0]) > box.x + 0.01 && Math.min(a[0], b[0]) < box.x + box.width - 0.01
        : a[0] > box.x + 0.01 && a[0] < box.x + box.width - 0.01 && Math.max(a[1], b[1]) > box.y + 0.01 && Math.min(a[1], b[1]) < box.y + box.height - 0.01;
      assert.equal(crosses, false, "route segment crosses a visible node: " + JSON.stringify({ a, b, box }));
    }
  }
}

test("all 23 actual relations use distinct clear routes, including long backend/data dependencies", () => {
  for (const [tier, scale] of [["cell", 0.28], ["cell", 0.55], ["card", 1.1]]) {
    const layout = arrange({ width: 815, height: 380 }, { tier, scale });
    const paths = new Set();
    for (const [index, edge] of edges.entries()) {
      const from = layout.positions.get(edge.from);
      const to = layout.positions.get(edge.to);
      const route = resolveOrthogonalGraphRoute(from, to, { routeIndex: index, routeCount: edges.length, obstacles: layout.positions });
      assertClearRoute(route, layout.positions);
      assert.deepEqual([route.x1, route.y1, route.x2, route.y2], [from.x + from.width, from.y + from.height / 2, to.x, to.y + to.height / 2]);
      assert.match(route.path, /^M [\d.]+ [\d.]+ H /u, "source uses a right port");
      assert.match(route.path, / H [\d.]+$/u, "target uses a left port and keeps its original direction");
      assert.equal(resolveOrthogonalGraphRoute(from, to, { routeIndex: index, routeCount: edges.length, obstacles: layout.positions }).path, route.path, "redrawing must not jitter a port/channel");
      paths.add(route.path);
    }
    assert.equal(paths.size, 23);
  }
});

test("relation toggles retain all nodes and positions; selection never overrides replay absence", () => {
  const plan = classifyGraphRelations(nodes, edges, EXECUTION_KINDS);
  const layout = arrange({ width: 815, height: 380 }, { plan });
  const positions = JSON.stringify([...layout.positions]);
  const options = { executionKinds: EXECUTION_KINDS, selectedNodeId: "backend-api", focusActive: true };
  const dependencyViews = edges.map((edge) => resolveGraphEdgePresentation(edge, { ...options, mode: "dependency" }));
  assert.equal(dependencyViews.filter((view) => view.visible).length, 9);
  assert.equal(edges.filter((edge) => resolveGraphEdgePresentation(edge, { ...options, mode: "all" }).visible).length, 23);
  const backend = edges.find((edge) => edge.from === "backend-api" && edge.kind === "depends_on");
  assert.equal(resolveGraphEdgePresentation(backend, { ...options, mode: "dependency" }).focus, "near");
  assert.equal(resolveGraphEdgePresentation(backend, { ...options, mode: "dependency", replayVisible: false }).visible, false);
  assert.equal(resolveGraphEdgePresentation(edges[0], { ...options, mode: "dependency" }).visible, false);
  assert.equal(JSON.stringify([...layout.positions]), positions);
  assert.equal(layout.positions.size, 15);
});

test("unknown relations, isolated workers, structure-only data and cycles remain explicit and reachable", () => {
  const isolated = { id: "isolated", kind: "worker", label: "Unmapped worker", status: "unreported" };
  const unknown = { id: "unknown", from: "owner", to: "isolated", kind: "future_relation" };
  const mixed = classifyGraphRelations([...nodes, isolated], [...edges, unknown], EXECUTION_KINDS);
  assert.equal(mixed.otherEdges.length, 1);
  assert.equal(mixed.executionEdges.length, 9);
  assert.ok(mixed.unlinkedNodes.some((node) => node.id === "isolated"));
  const layout = arrange({ width: 815, height: 380 }, { plan: mixed });
  assert.equal(layout.positions.size, 16);
  assert.ok(layout.bands.some((band) => band.group === "unlinked"));
  assert.equal(resolveGraphEdgePresentation(unknown, { mode: "dependency", executionKinds: EXECUTION_KINDS }).visible, false);
  assert.equal(resolveGraphEdgePresentation(unknown, { mode: "all", executionKinds: EXECUTION_KINDS }).visible, true);
  const structureOnly = classifyGraphRelations(nodes, edges.filter((edge) => edge.kind === "contains"), EXECUTION_KINDS);
  assert.equal(structureOnly.executionEdges.length, 0);
  assert.equal(structureOnly.edges.length, 14);
  const cycle = classifyGraphRelations(nodes, [...edges, { id: "cycle", from: "release-ops", to: "backend-api", kind: "depends_on" }], EXECUTION_KINDS);
  assert.equal(cycle.cyclic, true);
  const cyclicLayout = arrange({ width: 815, height: 380 }, { plan: cycle });
  assert.equal(cyclicLayout.positions.size, 15);
  assertNoOverlap(cyclicLayout);
  const reverse = resolveOrthogonalGraphRoute(cyclicLayout.positions.get("release-ops"), cyclicLayout.positions.get("backend-api"), { obstacles: cyclicLayout.positions, routeIndex: 23, routeCount: 24 });
  assertClearRoute(reverse, cyclicLayout.positions);
});

test("the serialized browser resolvers have no module closure and return the same plan/layout/routes", () => {
  const browser = new Function(serializeGraphReadabilityResolvers() + "\nreturn {classifyGraphRelations, resolveDependencyGraphLayout, resolveOrthogonalGraphRoute, resolveGraphEdgePresentation};")();
  const plan = browser.classifyGraphRelations(nodes, edges, EXECUTION_KINDS);
  const serverLayout = arrange({ width: 815, height: 380 });
  const browserLayout = browser.resolveDependencyGraphLayout({ ...serverLayout.inputs, plan });
  assert.deepEqual([...browserLayout.positions], [...serverLayout.positions]);
  const edge = edges.at(-1);
  const params = [serverLayout.positions.get(edge.from), serverLayout.positions.get(edge.to), { obstacles: serverLayout.positions, routeIndex: 22, routeCount: 23 }];
  assert.deepEqual(browser.resolveOrthogonalGraphRoute(...params), resolveOrthogonalGraphRoute(...params));
  assert.deepEqual(browser.resolveGraphEdgePresentation(edge, { mode: "dependency", executionKinds: EXECUTION_KINDS }), resolveGraphEdgePresentation(edge, { mode: "dependency", executionKinds: EXECUTION_KINDS }));
});

test("dependency mode collapses only organization nodes, restoring them with all relations", () => {
  const isolated = { id: "independent-real-task", kind: "worker", label: "真实独立任务" };
  const plan = classifyGraphRelations([...nodes, isolated], edges, EXECUTION_KINDS);
  const original = arrange({ width: 1000, height: 400 }, { plan });
  const collapsed = resolveDependencyGraphLayout({ ...original.inputs, includeContext: false });
  assert.equal(collapsed.positions.size, 10);
  for (const id of workers) assert.ok(collapsed.positions.has(id));
  assert.ok(collapsed.positions.has(isolated.id));
  for (const id of context) assert.equal(collapsed.positions.has(id), false);
  assert.equal(plan.nodes.length, 16, "collapse changes presentation, not the observed graph");
  assert.equal(plan.edges.length, 23);
  assert.equal(collapsed.bands.some((band) => band.group === "context"), false);
  const expanded = resolveDependencyGraphLayout({ ...collapsed.inputs, includeContext: true });
  assert.equal(expanded.positions.size, 16);
  assertNoOverlap(expanded);
  assert.ok(expanded.bounds.height > collapsed.bounds.height);
});

test("contains does not turn an explicitly bound task or an ordinary agent into organization", () => {
  const taskParent = { id: "task-parent", kind: "agent", taskPacketId: "task:parent" };
  const agentParent = { id: "agent-parent", kind: "agent" };
  const taskWorkflow = { id: "task-workflow", kind: "workflow", taskPacketId: "task:workflow" };
  const plan = classifyGraphRelations([...nodes, taskParent, agentParent, taskWorkflow], [...edges,
    { from: taskParent.id, to: workers[0], kind: "contains" },
    { from: agentParent.id, to: workers[1], kind: "contains" },
  ], EXECUTION_KINDS);
  for (const task of [taskParent, agentParent, taskWorkflow]) {
    assert.equal(plan.contextNodes.includes(task), false);
    assert.equal(plan.unlinkedNodes.includes(task), true);
  }
  const original = arrange({ width: 1000, height: 400 }, { plan });
  const collapsed = resolveDependencyGraphLayout({ ...original.inputs, includeContext: false });
  for (const task of [taskParent, agentParent, taskWorkflow]) assert.ok(collapsed.positions.has(task.id));
});
