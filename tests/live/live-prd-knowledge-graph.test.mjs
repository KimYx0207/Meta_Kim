import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildLivePrdGraph } from "../../src/application/live/live-prd-knowledge-graph.mjs";

const module = (id, dependsOn = [], more = {}) => ({ id, title: `模块 ${id}`, purpose: `${id} 的目标`, dependsOn, ...more });
const design = (modules, more = {}) => ({
  architecture: { id: "system", title: "系统设计", summary: "架构总纲", status: "awaiting_human" },
  modules, totalModules: modules.length, nextCursor: null, ...more,
});

test("overview uses stable, collision-safe IDs and distinguishes containment from required dependencies", () => {
  const source = design([module("system", []), module("orders", ["system"], { status: "accepted" })]);
  const original = structuredClone(source);
  const graph = buildLivePrdGraph(source);
  assert.equal(graph.focusId, "architecture:system");
  assert.deepEqual(graph.nodes.map(node => node.id), ["architecture:system", "module:system", "module:orders"]);
  assert.deepEqual(graph.nodes.map(node => node.kind), ["architecture", "module", "module"]);
  assert.equal(graph.nodes[0].status, "awaiting_human");
  assert.equal(graph.nodes[1].status, null, "Never manufacture review or approval status");
  assert.equal(graph.nodes[2].status, "accepted");
  assert.deepEqual(graph.edges.map(({ from, to, type }) => ({ from, to, type })), [
    { from: "architecture:system", to: "module:system", type: "containment" },
    { from: "architecture:system", to: "module:orders", type: "containment" },
    { from: "module:system", to: "module:orders", type: "required_dependency" },
  ]);
  assert.equal(graph.hasMore, false);
  assert.deepEqual(source, original, "The graph is a pure display projection, not a second state authority");
});

test("selected module shows upstream depth levels, one downstream level and correct directional edges", () => {
  const source = design([module("a"), module("b", ["a"]), module("c", ["b"]), module("d", ["c"]), module("e", ["d"]), module("other")]);
  const graph = buildLivePrdGraph(source, { focusId: "c", depth: 2 });
  assert.equal(graph.focusId, "module:c");
  assert.deepEqual(graph.nodes.map(node => node.id), ["module:a", "module:b", "module:c", "module:d"]);
  assert.deepEqual(graph.nodes.map(node => node.depth), [-2, -1, 0, 1]);
  assert.deepEqual(graph.edges.map(({ from, to, type }) => [from, to, type]), [
    ["module:a", "module:b", "required_dependency"],
    ["module:b", "module:c", "required_dependency"],
    ["module:c", "module:d", "required_dependency"],
  ]);
  const immediate = buildLivePrdGraph(source, { focusId: "module:c", depth: 1 });
  assert.deepEqual(immediate.nodes.map(node => node.id), ["module:b", "module:c", "module:d"]);
  assert.equal(immediate.hasMore, false, "Intentional depth filtering is not missing pagination");
});

test("architecture focus always gives the declared outline with its containment links", () => {
  const source = design([module("b"), module("a")], { architecture: { id: "arch", title: "总纲", moduleIds: ["a", "b"] } });
  const graph = buildLivePrdGraph(source, { focusId: "architecture:arch" });
  assert.equal(graph.focusId, "architecture:arch");
  assert.deepEqual(graph.nodes.map(node => node.sourceId), ["arch", "a", "b"]);
  assert.deepEqual(graph.edges.map(edge => edge.type), ["containment", "containment"]);
});

test("paginated dependencies are reported as unloaded, never quietly fabricated or rejected as missing", () => {
  const source = design([module("child", ["parent"])], { totalModules: 33, nextCursor: "opaque-page-two" });
  const graph = buildLivePrdGraph(source, { focusId: "child" });
  assert.deepEqual(graph.nodes.map(node => node.id), ["module:child"]);
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.hasMore, true);
  assert.ok(graph.omissions.some(item => item.type === "unloaded_modules" && item.count === 32));
  assert.ok(graph.omissions.some(item => item.type === "unloaded_dependency" && item.moduleId === "child" && item.dependencyId === "parent"));
  assert.ok(!graph.omissions.some(item => item.type === "unknown_dependency"));
});

test("fully loaded unknown/self dependencies and nonexistent focus are explicit audit omissions", () => {
  const source = design([module("a", ["missing", "a"])]);
  const graph = buildLivePrdGraph(source, { focusId: "a" });
  assert.ok(graph.omissions.some(item => item.type === "unknown_dependency" && item.dependencyId === "missing"));
  assert.ok(graph.omissions.some(item => item.type === "self_dependency" && item.moduleId === "a"));
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.hasMore, false);
  const wrong = buildLivePrdGraph(source, { focusId: "not-here" });
  assert.equal(wrong.focusId, "architecture:system");
  assert.ok(wrong.omissions.some(item => item.type === "unknown_focus" && item.focusId === "not-here"));
});

test("cycles are audited; the graph does not invent a valid execution order", () => {
  const graph = buildLivePrdGraph(design([module("a", ["c"]), module("b", ["a"]), module("c", ["b"])]), { focusId: "a" });
  assert.ok(graph.omissions.some(item => item.type === "dependency_cycle" && item.moduleIds.length === 3));
  assert.equal(graph.edges.filter(edge => edge.type === "required_dependency").length, 3);
  assert.equal(graph.nodes.length, 3);
});

test("large graphs cap visible nodes, keep the selected node and report omitted counts", () => {
  const source = design(Array.from({ length: 90 }, (_, index) => module(`m${String(index).padStart(3, "0")}`)));
  const overview = buildLivePrdGraph(source, { limit: 40 });
  assert.equal(overview.nodes.length, 40);
  assert.equal(overview.nodes[0].kind, "architecture");
  assert.ok(overview.omissions.some(item => item.type === "visibility_limit" && item.count === 51));
  assert.equal(overview.hasMore, true);
  const focused = buildLivePrdGraph(source, { focusId: "m089", limit: 1 });
  assert.deepEqual(focused.nodes.map(node => node.id), ["module:m089"]);
  assert.equal(focused.hasMore, false);
});

test("invalid repeated relationships have explicit omissions and do not double-render edges", () => {
  const graph = buildLivePrdGraph(design([module("a"), module("b", ["a", "a"])]));
  assert.equal(graph.edges.filter(edge => edge.type === "required_dependency").length, 1);
  assert.ok(graph.omissions.some(item => item.type === "duplicate_dependency" && item.moduleId === "b"));
});

test("the pure model also works when serialized into the dependency-free Live browser page", () => {
  const browserModel = vm.runInNewContext(`(${buildLivePrdGraph.toString()})`);
  const graph = browserModel(design([module("a"), module("b", ["a"])]), { focusId: "b" });
  assert.equal(graph.focusId, "module:b");
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges[0].from, "module:a");
  assert.equal(graph.edges[0].to, "module:b");
});
