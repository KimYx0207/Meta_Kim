import test from "node:test";
import assert from "node:assert/strict";
import { createUnifiedAgentDesktop } from "../../src/presentation/live/live-agent-desktop.mjs";
import { buildLivePrdGraph } from "../../src/application/live/live-prd-knowledge-graph.mjs";
import { renderLiveWorkspaceSurface } from "../../src/presentation/live/live-workspace-view.mjs";
import { LIVE_WORKSPACE_CSS } from "../../src/presentation/live/live-workspace-styles.mjs";

function fakeNode(tag = "div", name = "") {
  const handlers = new Map();
  return {
    tagName: tag.toUpperCase(), className: "", textContent: "", value: "", hidden: false,
    disabled: false, open: false, children: [], dataset: name ? { uwLiveMode: name } : {}, attributes: {},
    scrollHeight: 250, clientHeight: 200, scrollTop: 0,
    addEventListener(event, listener) { handlers.set(event, listener); },
    dispatch(event, extras = {}) { handlers.get(event)?.({ preventDefault() {}, key: "", ...extras }); },
    click() { this.dispatch("click"); },
    append(...items) { this.children.push(...items); },
    insertBefore(item, reference) { const position = this.children.indexOf(reference);
      this.children.splice(position < 0 ? this.children.length : position, 0, item); },
    replaceChildren(...items) { this.children = items; },
    setAttribute(key, value) { this.attributes[key] = String(value); },
    focus() { this.focused = true; },
  };
}
function walk(element, predicate) {
  const found = [];
  if (predicate(element)) found.push(element);
  for (const child of element.children || []) found.push(...walk(child, predicate));
  return found;
}
const byClass = (node, name) => walk(node, child => child.className?.split(" ").includes(name));
const byText = (node, fragment) => walk(node, child => String(child.textContent || "").includes(fragment));
const findButton = (node, fragment) => byText(node, fragment).find(child => child.tagName === "BUTTON");

function fixture() {
  const elements = Object.fromEntries(["agent-chat", "chat-thread", "chat-form", "chat-input", "chat-send",
    "chat-project", "chat-connection", "chat-guidance", "chat-target", "chat-target-text", "chat-target-clear",
    "live-viewport", "live-caption", "live-count", "live-source", "agent-status", "chat-announcement"]
    .map(name => [name, fakeNode(name === "chat-input" ? "textarea" : "div")]));
  const tabs = ["flow", "knowledge", "agents"].map(name => fakeNode("button", name));
  const doc = { createElement: tag => fakeNode(tag) };
  const navigationInventory = fakeNode();
  const shell = { querySelector(selector) { return selector === "[data-uw-agent-inventory]" ? navigationInventory : null; } };
  const root = { ownerDocument: doc,
    closest(selector) { return selector === "[data-unified-workspace]" ? shell : null; },
    querySelector(selector) { return elements[/^\[data-uw-(.+)\]$/u.exec(selector)?.[1]] || null; },
    querySelectorAll(selector) { return selector === "[data-uw-live-mode]" ? tabs : []; } };
  const state = { origin: "acceptance_fixture", agentServerProjectLabel: "验收测试项目",
    selection: { runId: "different-run" }, workspace: { runId: "different-run", stages: [{ id: "fake-run", status: "running" }] },
    tasks: [{ id: "other-run-agent", owner: "not-this-task", status: "running" }] };
  const agent = { status: "idle", pending: null, hosts: [
    { id: "claude", label: "Claude Code", available: true, launchSupported: true },
    { id: "codex", label: "Codex CLI", available: true, launchSupported: true },
  ] };
  const design = { snapshot: null, busy: false, error: null };
  const nativeDraft = { snapshot: null, busy: false, error: null, sourceApplied: true };
  const handoff = { snapshot: null, busy: false, error: null };
  const calls = [];
  const draft = {
    system: { title: "跨境经营工具", goal: "数据与知识一体化", architecture: "数据采集 → 检索 → 分析", techStack: "Node / SQLite",
      acceptance: ["数据可追溯"], approval: { state: "pending" } },
    modules: [
      { id: "collector", title: "数据采集", objective: "收集业务数据", inputContract: ["ERP 事件"], outputContract: ["清洗后的数据"], boundaries: ["隔离客户"], acceptance: ["质量核验"], dependencies: [], approval: { state: "pending" } },
      { id: "retrieval", title: "知识检索", objective: "混合检索", inputContract: ["资料查询"], outputContract: ["有依据的答案"], boundaries: ["客户隔离"], acceptance: ["召回测试"], dependencies: ["collector"], approval: { state: "pending" } },
    ],
  };
  const strategyOptions = { summary: "候选方案均需核验", recommendedStrategyId: "B", openQuestions: [], strategies: [
    { id: "A", title: "先采集", approach: "逐步搭建", tradeoffs: "慢", evidenceSummary: "待验证数据", risks: "成本高" },
    { id: "B", title: "先检索", approach: "先核对答案", tradeoffs: "覆盖有限", evidenceSummary: "待验证资料", risks: "遗漏" },
  ] };
  let desktop;
  const callbacks = {
    parseStrategies: preview => preview ? strategyOptions : null,
    startGoal: goal => { calls.push(["start", goal]); return true; },
    adopt: (choice, reason) => { calls.push(["adopt", choice, reason]); agent.pending.decision = { state: "adopted_for_design", selectedStrategy: choice, selectionReason: reason }; desktop.render(); return true; },
    revise: reason => { calls.push(["revise", reason]); return true; },
    reject: () => calls.push(["reject"]),
    redetect: () => calls.push(["redetect"]),
    verifyRequest: () => calls.push(["verifyRequest"]),
    reconcileDecision: () => calls.push(["reconcileDecision"]),
    newTask: () => { agent.pending = null; agent.status = "idle"; return true; },
    saveDraft: () => { calls.push(["saveDraft"]); design.snapshot = { ...structuredClone(draft), version: 1, status: "draft", history: [], pendingReviewNotes: [] }; desktop.render(); },
    retryDraft: () => calls.push(["retryDraft"]),
    approveNode: (kind, id) => calls.push(["approve", kind, id]),
    requestRevision: (kind, id, feedback) => {
      calls.push(["request_revision", kind, id, feedback]);
      const note = { noteId: "review-1", target: kind === "system" ? { kind } : { kind, moduleId: id }, feedback };
      design.snapshot = { ...design.snapshot, version: design.snapshot.version + 1, status: "reviewing",
        pendingReviewNotes: [note], history: [...design.snapshot.history, { version: 2, reviewNote: note }] };
      desktop.render();
      return true;
    },
    reviseField: (kind, id, label, value) => { calls.push(["revise_field", kind, id, label, value]); return true; },
    reconcileDesign: () => calls.push(["reconcileDesign"]),
    prepareHandoff: () => calls.push(["prepareHandoff"]),
    reconcileHandoff: () => calls.push(["reconcileHandoff"]),
  };
  desktop = createUnifiedAgentDesktop({ root, state, agent, design, nativeDraft, handoff,
    copy: key => key, buildGraph: buildLivePrdGraph,
    createGraph: ({ graph, onSelect, onDepthChange }) => {
      const wrapper = fakeNode();
      for (const node of graph.nodes) {
        const element = fakeNode("button"); element.className = "stub-graph-node"; element.textContent = node.title;
        element.addEventListener("click", () => onSelect(node)); wrapper.append(element);
      }
      const deeper = fakeNode("button"); deeper.className = "stub-depth"; deeper.addEventListener("click", () => onDepthChange(3)); wrapper.append(deeper);
      return wrapper;
    }, callbacks });
  return { elements, tabs, state, agent, design, nativeDraft, handoff, callbacks, calls, desktop, navigationInventory };
}

test("the sibling navigation renders its own Agent/Skill/MCP/Hook inventory", () => {
  const env = fixture();
  env.state.capabilityCatalog = {
    agents: [{ id: "warden", label: "Warden", registrationState: "registered" }],
    skills: [{ id: "review", label: "Review Skill", registrationState: "registered" }],
    mcpServers: [{ id: "source", label: "Source MCP", registrationState: "registered" }],
    hooks: [{ id: "quality", label: "Quality Hook", registrationState: "registered" }],
    nativeHosts: [{ id: "pi", label: "Pi", status: "not_probed" }],
    nativeCapabilities: [{ id: "pi-custom-agent", hostId: "pi", kind: "agent", label: "Pi Custom Agent", installationState: "configured" }],
  };
  env.desktop.render();
  const inventory = env.navigationInventory;
  assert.equal(byClass(inventory, "uw-agent-inventory-body").length, 1);
  for (const text of ["Agents", "Skills", "MCP", "Hooks", "Warden", "Review Skill", "Source MCP", "Quality Hook", "Pi Custom Agent"])
    assert.ok(byText(inventory, text).length, `missing sidebar entry ${text}`);
});

test("native capability graph links configured Subagents, Skills, MCP and Hooks to their real host", () => {
  const env = fixture();
  env.desktop.render();
  env.tabs[1].click();
  findButton(env.elements["live-viewport"], "客户端能力").click();
  assert.equal(byText(env.elements["live-viewport"], "Pi Coding Agent").length, 0);
  // The directory may arrive asynchronously after the operator has already
  // opened this layer; rendering must update the graph without a tab switch.
  env.state.capabilityCatalog = {
    nativeHosts: [{ id: "pi", label: "Pi Coding Agent", status: "not_probed" }],
    nativeCapabilities: [
      { id: "research", label: "research", hostId: "pi", scope: "project", kind: "subagent_config" },
      { id: "analysis", label: "analysis", hostId: "pi", scope: "global", kind: "skill" },
      { id: "semantic", label: "semantic", hostId: "pi", scope: "project", kind: "mcp" },
      { id: "post-tool", label: "post-tool", hostId: "pi", scope: "project", kind: "hook" },
    ],
  };
  env.desktop.render();
  for (const entry of ["Pi Coding Agent", "Subagent · research", "Skill · analysis", "MCP · semantic", "Hook · post-tool"]) {
    assert.ok(byText(env.elements["live-viewport"], entry).length, `graph missing ${entry}`);
  }
  findButton(env.elements["live-viewport"], "Pi Coding Agent").click();
  for (const entry of ["Subagent · research", "Skill · analysis", "MCP · semantic", "Hook · post-tool"]) {
    assert.ok(byText(env.elements["live-viewport"], entry).length, `host focus lost ${entry}`);
  }
});

test("inventory search narrows native capabilities and a host opens its own graph with a way back", () => {
  const env = fixture();
  const nativeCapabilities = Array.from({ length: 42 }, (_, index) => ({
    id: `event-${index}`, label: `Event Hook ${index}`, hostId: "claude", kind: "hook", scope: "project", installationState: "configured",
  }));
  nativeCapabilities.push({ id: "special", label: "Unique Review Skill", hostId: "claude", kind: "skill", scope: "global", installationState: "configured" });
  env.state.capabilityCatalog = {
    agents: [{ id: "warden", label: "Warden", registrationState: "registered" }],
    nativeHosts: [{ id: "claude", label: "Claude Code", status: "detected" }],
    nativeCapabilities,
  };
  env.desktop.render();
  let inventory = env.navigationInventory;
  assert.equal(byClass(inventory, "uw-native-host-capability").length, 43);
  assert.equal(byClass(inventory, "uw-native-host-family").length, 2);
  assert.ok(byClass(inventory, "uw-native-host-family").every(group => group.open === false),
    "large capability groups should begin collapsed");
  assert.equal(byText(inventory, "已发现配置 · 未确认加载").length, 1,
    "configuration truth remains visible once per host rather than crowding every native capability row");

  let search = byClass(inventory, "uw-agent-inventory-search")[0];
  inventory.scrollTop = 320;
  search.value = "Unique Review Skill";
  search.dispatch("input");
  inventory = env.navigationInventory;
  search = byClass(inventory, "uw-agent-inventory-search")[0];
  assert.equal(search.value, "Unique Review Skill");
  assert.equal(inventory.scrollTop, 0, "search results must not be stranded below the scroll position of a long catalog");
  assert.ok(byText(inventory, "已筛出").length);
  assert.equal(byClass(inventory, "uw-native-host-capability").length, 1);
  assert.equal(byClass(inventory, "uw-native-host-family").length, 1);
  assert.equal(byClass(inventory, "uw-native-host-family")[0].open, true,
    "the matching group should expand while searching");
  assert.ok(byClass(inventory, "uw-agent-inventory-section").some(section => section.hidden),
    "empty unrelated sections should disappear during search");

  findButton(inventory, "查看能力关系").click();
  assert.equal(env.desktop.mode, "knowledge");
  assert.ok(byText(env.elements["live-viewport"], "Claude Code").length,
    "the host graph should open with the detected client in focus");
  findButton(env.elements["live-viewport"], "返回完整图谱").click();
  assert.ok(byText(env.elements["live-viewport"], "Claude Code").length);
  byClass(env.navigationInventory, "uw-native-host-capability")[0].click();
  assert.ok(byText(env.elements["live-viewport"], "Unique Review Skill").length,
    "the search hit should open its exact graph node even when its source index exceeds the overview limit");
  for (const fact of ["配置范围", "用户配置", "尚未从原生客户端确认", "当前目录记录未证明实际调用"])
    assert.ok(byText(env.elements["live-viewport"], fact).length, `a selected capability must reveal ${fact}`);
});

test("an exactly bound pending research Run exposes real main/subagent evidence and isolates unrelated Runs", () => {
  const env = fixture();
  const { state, agent, desktop, tabs, elements, navigationInventory } = env;
  state.origin = "governed_run";
  state.selection.runId = "real-research-run";
  state.snapshot = { run: { id: "real-research-run" } };
  state.workspace.runId = "real-research-run";
  state.tasks = [
    { id: "main-a", title: "主 Agent 检索", status: "completed", source: {
      kind: "agent", isMain: true, runId: "real-research-run", ownerAgent: "Claude Code", role: "Research",
      taskPacketId: "packet-a", ownerReport: { evidenceLevel: "owner_reported", summary: "检索已完成，来源需独立核验",
        nativeInvocationVerified: false, runId: "real-research-run", taskPacketId: "packet-a", ownerAgent: "Claude Code" },
    } },
    { id: "child-a", title: "子 Agent 对比", status: "running", source: {
      kind: "worker", isMain: false, runId: "real-research-run", ownerAgent: "Scout", role: "Verifier",
      parentId: "main-a", nativeTaskCaption: "独立核对", capabilityTruth: [{ kind: "mcp", state: "observed", actualNames: ["GitHub"] }],
    } },
  ];
  agent.pending = { goal: "调研", runId: "real-research-run" };
  desktop.render();
  tabs[2].click();
  assert.equal(byClass(elements["live-viewport"], "uw-agent-runtime-card").length, 2);
  assert.ok(byText(elements["live-viewport"], "主 Agent · Research").length);
  assert.ok(byText(elements["live-viewport"], "检索已完成，来源需独立核验").length);
  assert.ok(byText(navigationInventory, "Subagents · 编排与回执").length);
  assert.ok(byText(navigationInventory, "独立核对").length || byText(navigationInventory, "子 Agent 对比").length);
  agent.pending = { goal: "另一项请求", runId: "other-run" };
  desktop.render();
  assert.equal(byClass(elements["live-viewport"], "uw-agent-runtime-card").length, 0,
    "a selected Run must never be joined to an unrelated pending request");
});

test("agent desktop has one visible composer contract, real tabs and fixture provenance", () => {
  const markup = renderLiveWorkspaceSurface();
  assert.equal((markup.match(/data-uw-chat-input/g) || []).length, 1);
  assert.match(markup, /class="uw-agent-legacy" hidden/);
  assert.match(markup, /role="tab" aria-controls="uw-live-content"/);
  assert.match(LIVE_WORKSPACE_CSS, /uw-chat-review-details/);
  const env = fixture();
  assert.equal(env.desktop.mode, "flow");
  assert.equal(env.elements["live-source"].textContent, "模拟验收数据 · 未调用真实 Agent");
  assert.equal(byClass(env.elements["live-viewport"], "uw-agent-flow-node").length, 6);
  assert.equal(byText(env.elements["live-viewport"], "fake-run").length, 0);
  env.tabs[1].dispatch("keydown", { key: "ArrowRight" });
  assert.equal(env.desktop.mode, "agents");
  env.tabs[0].dispatch("keydown", { key: "ArrowRight" });
  assert.equal(env.desktop.mode, "knowledge");
  assert.equal(env.elements["live-viewport"].attributes["aria-labelledby"], "uw-live-tab-knowledge");
});

test("B1 choice, B2 graph annotation, approval review and direct field revision share the single composer", async () => {
  const env = fixture();
  const { agent, design, nativeDraft, elements, tabs, calls, desktop } = env;
  agent.status = "completed";
  agent.pending = { goal: "分析跨境经营知识库", resultPreview: '{"schemaVersion":"fixture"}', decision: { state: "awaiting_human" } };
  desktop.render();
  assert.equal(byClass(elements["chat-thread"], "uw-chat-option").length, 2);
  byClass(elements["chat-thread"], "uw-chat-option")[1].click();
  elements["chat-input"].value = "先检索验证";
  elements["chat-form"].dispatch("submit");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.at(-1), ["adopt", "B：先检索", "先检索验证"]);

  design.snapshot = { status: "not_started", version: 0, modules: [] };
  nativeDraft.snapshot = { status: "completed", design: structuredClone({ system: { title: "跨境经营工具", goal: "数据分析" }, modules: [
    { id: "collector", title: "数据采集", objective: "收集" }, { id: "retrieval", title: "知识检索", objective: "检索" },
  ] }) };
  desktop.render();
  findButton(elements["chat-thread"], "保存设计草稿").click();
  assert.deepEqual(calls.at(-1), ["saveDraft"]);
  const approve = findButton(elements["chat-thread"], "确认「跨境经营工具」");
  assert.equal(approve.disabled, true, "approval requires full PRD read");
  const details = byClass(elements["chat-thread"], "uw-chat-review-details")[0];
  details.open = true; details.dispatch("toggle");
  assert.equal(findButton(elements["chat-thread"], "确认「跨境经营工具」").disabled, false);

  tabs[1].click();
  assert.equal(byClass(elements["live-viewport"], "stub-graph-node").length, 3);
  findButton(elements["live-viewport"], "知识检索").click();
  assert.equal(elements["chat-target"].hidden, false);
  elements["chat-input"].value = "这个模块需要补充数据隔离测试";
  elements["chat-form"].dispatch("submit");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.at(-1), ["request_revision", "module", "retrieval", "这个模块需要补充数据隔离测试"]);
  assert.equal(design.snapshot.pendingReviewNotes.length, 1);
  assert.equal(elements["chat-target"].hidden, true);
  assert.match(byText(elements["chat-thread"], "数据隔离测试")[0].textContent, /数据隔离测试/);

  findButton(elements["live-viewport"], "知识检索").click();
  elements["chat-input"].value = "验收改为：召回率≥90%；数据隔离通过";
  elements["chat-form"].dispatch("submit");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.at(-1), ["revise_field", "module", "retrieval", "验收", "召回率≥90%；数据隔离通过"]);
  assert.equal(elements["chat-input"].value, "");

  findButton(elements["live-viewport"], "知识检索").click();
  assert.ok(byClass(elements["live-viewport"], "uw-live-node-inspector").length);
  assert.ok(byText(elements["live-viewport"], "待修改").length);
  findButton(elements["live-viewport"], "方案与依据")?.click();
  const strategyTab = findButton(elements["live-viewport"], "方案与依据");
  if (strategyTab) strategyTab.click();
  assert.equal(byClass(elements["live-viewport"], "stub-graph-node").length, 3);
});

test("an unstructured plan is not silently adopted, and unsupported nodes do not create fake comments", async () => {
  const env = fixture();
  const { agent, elements, calls, desktop } = env;
  agent.status = "completed";
  agent.pending = { goal: "计划", resultPreview: "普通计划", decision: { state: "awaiting_human" } };
  env.callbacks.parseStrategies = () => null; // Existing contract parser owns invalid and unstructured cases.
  // Recreate because the callback collection is stable and live.
  desktop.render();
  elements["chat-input"].value = "采纳：逐步推进｜因为可以按模块检查";
  elements["chat-form"].dispatch("submit");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.at(-1), ["adopt", "逐步推进", "因为可以按模块检查"]);
  desktop.selectNode({ kind: "stage", id: "acceptance", title: "最终验收" });
  elements["chat-input"].value = "把验收改成生产验收";
  elements["chat-form"].dispatch("submit");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements["chat-input"].value, "把验收改成生产验收", "unsupported mutation must preserve user text");
  assert.ok(byText(elements["chat-thread"], "当前仅能查看").length);
});

test("rejected or unconfirmed Agent decisions keep the original composer text and target", async () => {
  const env = fixture();
  const { agent, elements, desktop } = env;
  agent.status = "completed";
  agent.pending = { goal: "计划", resultPreview: "待核验", decision: { state: "awaiting_human" } };
  env.callbacks.revise = () => false;
  desktop.selectNode({ kind: "stage", id: "decision", title: "方案选择" });
  elements["chat-input"].value = "请补充各个方案的真实验证依据";
  elements["chat-form"].dispatch("submit");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements["chat-input"].value, "请补充各个方案的真实验证依据");
  assert.equal(elements["chat-target"].hidden, false);
  assert.ok(byText(elements["chat-thread"], "你的文字已保留").length);
});
