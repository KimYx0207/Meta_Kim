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

// Review #17: at the default zoom a card title is read whole. SVG text does not
// wrap, so a long title is laid out over two lines instead of being cut.
test("review #17: a long module title wraps onto a second line instead of being cut", () => {
  const mixed = "多仓库管理与双向 Agent 协同交接";
  const cjk = "两级产品设计图谱与进度汇总引擎";
  const titles = { a: mixed, b: cjk };
  const graph = buildLivePrdGraph({ ...fixture, modules: fixture.modules.map((item) => titles[item.id] ? { ...item, title: titles[item.id] } : item) });
  const view = createPrdKnowledgeGraph({ doc, graph, copy: key => LIVE_WORKSPACE_MESSAGES.zh[key] || key, onSelect() {}, onDepthChange() {} });
  const card = (id) => findAll(view, element => element.tagName === "g" && element.dataset.livePrdGraphNode === id)[0];
  const linesOf = (id) => card(id).children.find(element => element.attributes.get("class") === "uw-kg-node-title")
    .children.filter(element => element.tagName === "tspan").map(element => element.textContent);
  assert.deepEqual(linesOf("a"), ["多仓库管理与双向", "Agent 协同交接"], "the break falls at the space, never inside the Latin word");
  assert.equal(linesOf("b").join(""), cjk, "every character of the title is shown");
  assert.ok(linesOf("b").every(line => Array.from(line).length >= 3), "neither line is left with a stray character: " + linesOf("b").join(" / "));
  const height = Number(card("a").children.find(element => element.tagName === "rect").attributes.get("height"));
  assert.ok(16 * 2 + 44 <= height, "the card is tall enough for both lines");
});

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
  const index = findAll(view, node => node.dataset.livePrdGraphIndexNode);
  assert.equal(index.length, 3, "Every visible module also appears in the real-data navigation index");
  assert.equal(index.find(node => node.dataset.livePrdGraphIndexNode === "b").dataset.state, "revised");
  const downstream = findAll(index.find(node => node.dataset.livePrdGraphIndexNode === "c"), node => node.className === "uw-knowledge-index-links");
  assert.equal(downstream.length, 1, "The responsive module list keeps factual dependency context even without the diagram");
  assert.match(downstream[0].textContent, /结算/u);
  index.find(node => node.dataset.livePrdGraphIndexNode === "a").click();
  assert.deepEqual(selected, ["module:b", "module:c", "module:a"], "Index rows open the same current module as SVG nodes");
});

test("a sparse module relationship uses content-based graph height instead of a 300px blank viewport", () => {
  const graph = buildLivePrdGraph(fixture, { focusId: "b", depth: 1 });
  const view = createPrdKnowledgeGraph({ doc, graph, focusId: "b", depth: 1,
    copy: key => LIVE_WORKSPACE_MESSAGES.zh[key] || key, onSelect() {}, onDepthChange() {} });
  const svg = findAll(view, node => node.tagName === "svg" && node.attributes.has("viewBox"))[0];
  const height = Number(svg.attributes.get("height"));
  assert.ok(height < 190, `Sparse dependencies should be a compact context strip, got ${height}px`);
  assert.equal(findAll(view, node => node.dataset.livePrdGraphIndexNode).length, 3);
  assert.equal(findAll(view, node => node.dataset.livePrdGraphIndexNode === "b")[0].dataset.selected, "true");
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

test("small PRD maps no longer reserve 620px while large maps keep readable scroll width", () => {
  const small = createPrdKnowledgeGraph({ doc, graph: buildLivePrdGraph(fixture),
    copy: key => LIVE_WORKSPACE_MESSAGES.zh[key] || key, onSelect() {}, onDepthChange() {} });
  const smallSvg = findAll(small, node => node.tagName === "svg" && node.attributes.has("viewBox"))[0];
  assert.equal(smallSvg.attributes.get("width"), "520");
  assert.match(smallSvg.attributes.get("style"), /--uw-graph-content-width:520px;--uw-graph-readable-width:360px/u);

  const moduleIds = Array.from({ length: 16 }, (_, index) => `module-${index}`);
  const largeDesign = { architecture: { id: "system", moduleIds },
    modules: moduleIds.map(id => ({ id, title: "模块" })) };
  const large = createPrdKnowledgeGraph({ doc, graph: buildLivePrdGraph(largeDesign),
    copy: key => LIVE_WORKSPACE_MESSAGES.zh[key] || key, onSelect() {}, onDepthChange() {} });
  const largeSvg = findAll(large, node => node.tagName === "svg" && node.attributes.has("viewBox"))[0];
  assert.match(largeSvg.attributes.get("style"), /--uw-graph-readable-width:760px/u);
});

test("animated dependency edges require an observed running target, not invented progress", () => {
  const design = { architecture: { id: "system", moduleIds: ["a", "b", "c"] },
    modules: [{ id: "a", status: "accepted", dependsOn: [] },
      { id: "b", status: "in_progress", dependsOn: ["a"] },
      { id: "c", status: "not_reviewed", dependsOn: ["b"] }] };
  const view = createPrdKnowledgeGraph({ doc, graph: buildLivePrdGraph(design),
    copy: key => LIVE_WORKSPACE_MESSAGES.zh[key] || key, onSelect() {}, onDepthChange() {} });
  const dependencies = findAll(view, node => node.tagName === "path" && node.attributes.get("class")?.includes("required"));
  assert.equal(dependencies.length, 2);
  assert.equal(dependencies.filter(node => node.attributes.get("data-activity") === "observed-running").length, 1);
});
