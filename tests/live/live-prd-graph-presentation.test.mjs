import test from "node:test";
import assert from "node:assert/strict";
import { buildLivePrdGraph } from "../../src/application/live/live-prd-knowledge-graph.mjs";
import { createPrdKnowledgeGraph } from "../../src/presentation/live/live-prd-knowledge-graph.mjs";
import { LIVE_WORKSPACE_MESSAGES } from "../../src/presentation/live/live-workspace-copy.mjs";

class Element {
  constructor(name) { this.tagName = name; this.children = []; this.dataset = {}; this.attributes = new Map(); this.listeners = new Map(); this.textContent = ""; }
  append(...children) { this.children.push(...children); }
  get lastChild() { return this.children.at(-1); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  click() { this.listeners.get("click")?.(); }
}
const doc = { createElement: name => new Element(name), createElementNS: (_ns, name) => new Element(name) };
const findAll = (root, predicate) => {
  const found = [];
  const visit = node => { if (predicate(node)) found.push(node); for (const child of node.children || []) visit(child); };
  visit(root);
  return found;
};
const fixture = { architecture: { id: "system", title: "业务系统", status: "awaiting_human", moduleIds: ["a", "b", "c"] },
  modules: [{ id: "a", title: "账户", status: "accepted", dependsOn: [] },
    { id: "b", title: "结算", status: "revision_required", dependsOn: ["a"] },
    { id: "c", title: "物流", status: "not_reviewed", dependsOn: ["b"] }], totalModules: 3, nextCursor: null };

test("rendered PRD graph is a real navigable SVG with correctly translated review states", () => {
  const selected = [];
  const graph = buildLivePrdGraph(fixture);
  const view = createPrdKnowledgeGraph({ doc, graph, copy: key => LIVE_WORKSPACE_MESSAGES.zh[key] || key, onSelect: node => selected.push(node.id), onDepthChange() {} });
  assert.equal(view.dataset.livePrdKnowledgeGraph, "architecture");
  const shapes = findAll(view, element => element.tagName === "g" && element.dataset.livePrdGraphNode);
  assert.equal(shapes.length, 4);
  assert.equal(findAll(view, element => element.tagName === "path" && element.attributes.get("class")?.includes("contains")).length, 3);
  assert.equal(findAll(view, element => element.tagName === "path" && element.attributes.get("class")?.includes("required")).length, 2);
  assert.equal(shapes.find(node => node.dataset.livePrdGraphNode === "system").dataset.state, "waiting_human");
  assert.equal(shapes.find(node => node.dataset.livePrdGraphNode === "b").dataset.state, "revised");
  assert.equal(shapes.find(node => node.dataset.livePrdGraphNode === "c").dataset.state, "not_reviewed");
  shapes.find(node => node.dataset.livePrdGraphNode === "b").click();
  assert.deepEqual(selected, ["module:b"]);
  const keyboard = shapes.find(node => node.dataset.livePrdGraphNode === "c");
  keyboard.listeners.get("keydown")({ key: "Enter", preventDefault() {} });
  assert.deepEqual(selected, ["module:b", "module:c"]);
});

test("module graph exposes selected node, depth, explicit truncation and expansion", () => {
  const deep = { architecture: { id: "system", title: "业务系统" },
    modules: Array.from({ length: 46 }, (_, index) => ({ id: `module-${index}`, dependsOn: index ? [`module-${index - 1}`] : [] })) };
  const depth = [];
  let expanded = 0;
  const graph = buildLivePrdGraph(deep, { focusId: "module-44", depth: "all", limit: 40 });
  assert.equal(graph.totalNodes, 46, "all means all prerequisite levels, even if the viewport caps display size");
  const view = createPrdKnowledgeGraph({ doc, graph, copy: key => LIVE_WORKSPACE_MESSAGES.zh[key] || key,
    focusId: "module-44", depth: "all", onSelect() {}, onDepthChange: value => depth.push(value), onExpand: () => expanded++ });
  assert.equal(view.dataset.livePrdKnowledgeFocus, "module-44");
  assert.ok(findAll(view, node => node.dataset.focusCenterX).length > 0);
  const buttons = findAll(view, node => node.dataset.livePrdGraphDepth);
  assert.equal(buttons.find(node => node.dataset.livePrdGraphDepth === "all").attributes.get("aria-pressed"), "true");
  buttons.find(node => node.dataset.livePrdGraphDepth === "3").click();
  assert.deepEqual(depth, [3]);
  assert.match(findAll(view, node => node.textContent.includes("6 个节点暂未显示"))[0].textContent, /6/);
  const expand = findAll(view, node => node.textContent === LIVE_WORKSPACE_MESSAGES.zh.graphExpand)[0];
  expand.click(); assert.equal(expanded, 1);
});

test("unloaded dependencies are visibly disclosed and never drawn as if confirmed", () => {
  const graph = buildLivePrdGraph({ architecture: { id: "sys" }, modules: [{ id: "a", dependsOn: ["missing"] }],
    totalModules: 3, nextCursor: "opaque" });
  const view = createPrdKnowledgeGraph({ doc, graph, copy: key => LIVE_WORKSPACE_MESSAGES.zh[key] || key, onSelect() {}, onDepthChange() {} });
  assert.equal(findAll(view, node => node.tagName === "path" && node.attributes.get("class")?.includes("required")).length, 0);
  assert.ok(findAll(view, node => node.textContent.includes("2 个模块尚未加载")).length);
  assert.ok(findAll(view, node => node.textContent.includes("1 条依赖尚无法确认")).length);
});
