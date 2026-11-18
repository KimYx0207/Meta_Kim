import test from "node:test";
import assert from "node:assert/strict";
import { createUnifiedAgentDesktop } from "../../src/presentation/live/live-agent-desktop.mjs";

function fakeElement(tag = "div") {
  const handlers = new Map();
  return {
    tagName: tag.toUpperCase(), className: "", textContent: "", value: "", title: "", open: false,
    children: [], dataset: {}, attributes: {}, scrollHeight: 500, scrollTop: 0, clientHeight: 220,
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener(name, callback) { handlers.set(name, callback); },
    dispatch(name) { handlers.get(name)?.({ preventDefault() {} }); },
    click() { this.dispatch("click"); },
    focus() { this.focused = true; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; },
  };
}
const visit = (node, predicate) => (predicate(node) ? [node] : []).concat(
  ...(node.children || []).map(child => visit(child, predicate)));
const classNodes = (node, name) => visit(node, child => String(child.className).split(" ").includes(name));
const textNodes = (node, value) => visit(node, child => String(child.textContent).includes(value));

function setup(callbacks = {}) {
  const elements = Object.fromEntries(["agent-chat", "chat-thread", "chat-form", "chat-input",
    "chat-send", "chat-project", "chat-connection", "chat-guidance", "chat-target", "chat-target-text",
    "chat-target-clear", "live-viewport", "live-caption", "live-count", "live-source", "agent-status",
    "chat-announcement", "agent-inventory"].map(name => [name, fakeElement()]));
  const tabs = ["flow", "knowledge", "agents"].map(value => {
    const tab = fakeElement("button"); tab.dataset.uwLiveMode = value; return tab;
  });
  const doc = { createElement: fakeElement, createElementNS: (_namespace, tag) => fakeElement(tag) };
  const root = { ownerDocument: doc,
    querySelector(selector) { return elements[/^\[data-uw-(.+)\]$/u.exec(selector)?.[1]] || null; },
    querySelectorAll(selector) { return selector === "[data-uw-live-mode]" ? tabs : []; } };
  const source = {
    id: "node-1", kind: "agent", isMain: false, runId: "run-1", taskPacketId: "task-1",
    roleDisplayName: "conductor", ownerAgent: "meta-conductor", parentId: "node-main", task: "统筹分工",
    summary: "Worker state projected from governed evidence", status: "in_doubt",
    ownerReport: { evidenceLevel: "owner_reported", runId: "run-1", taskPacketId: "task-1",
      ownerAgent: "meta-conductor", nativeInvocationVerified: false, resultStatus: "reported_complete",
      reportedAt: "2026-11-17T01:00:00Z", summary: "已汇总三个可选路径，等待审核。" },
    capabilityTruth: [
      { kind: "skill", state: "planned", plannedNames: ["agent-teams-playbook"], actualNames: ["do-not-believe"] },
      { kind: "mcp", state: "observed", plannedNames: ["filesystem"], actualNames: ["filesystem"] },
    ],
  };
  const state = { origin: "governed_run", agentServerProjectLabel: "真实 Run 测试", selection: { runId: "run-1" },
    workspace: { runId: "run-1", stages: [] },
    tasks: [{ id: "node-1", title: "设计执行次序", owner: "meta-conductor", status: "in_progress", source }],
    capabilityCatalog: { evidenceLevel: "registered_only", agents: [
      { id: "meta-conductor", label: "meta-conductor", role: "运行调度", registrationState: "registered" },
      { id: "meta-prism", label: "meta-prism", role: "质量检查", registrationState: "registered" },
    ], skills: [
      { id: "agent-teams-playbook", label: "agent-teams-playbook", registrationState: "registered" },
      { id: "meta-overview", label: "meta-overview", registrationState: "registered", referenceOnly: true },
    ], mcpServers: [{ id: "filesystem", label: "filesystem", registrationState: "registered" }],
    hooks: [{ id: "preflight", label: "preflight", registrationState: "registered" }] },
  };
  const agent = { status: "idle", pending: null, hosts: [] };
  const desktop = createUnifiedAgentDesktop({ root, state, agent,
    design: { snapshot: null }, nativeDraft: { snapshot: null }, handoff: { snapshot: null },
    buildGraph: () => ({ nodes: [], edges: [] }), createGraph: () => fakeElement(), callbacks });
  return { desktop, state, source, elements, tabs, agent };
}

test("sidebar derives distinct agent insignias and runtime conclusions from bound evidence", () => {
  const { desktop, elements, tabs } = setup();
  const sidebar = elements["agent-inventory"];
  assert.equal(classNodes(sidebar, "uw-agent-inventory-agent").length, 2,
    "one runtime Agent and one remaining registered Agent, no duplicate identity");
  assert.equal(visit(sidebar, item => item.tagName === "SVG").length, 2,
    "known roles are rendered as semantic vector insignias");
  assert.ok(textNodes(sidebar, "负责人回报").length);
  assert.ok(textNodes(sidebar, "Subagents").length);
  assert.ok(textNodes(sidebar, "Skills").length);
  assert.ok(textNodes(sidebar, "MCP").length);
  assert.ok(textNodes(sidebar, "Hooks").length);
  const quicknav = classNodes(sidebar, "uw-agent-inventory-quicknav");
  assert.equal(quicknav.length, 1, "high-priority capability families must remain visible at the top");
  assert.deepEqual(classNodes(quicknav[0], "uw-agent-inventory-shortcut").map(item => item.dataset.targetSection),
    ["run", "subagents", "native-hosts", "registered-agents", "professional-agents", "skill", "mcp", "hook"]);
  const skillsSection = visit(sidebar, item => item.dataset.section === "skill")[0];
  assert.equal(skillsSection.open, false, "long directories stay collapsed until requested");
  classNodes(quicknav[0], "uw-agent-inventory-shortcut")[5].click();
  assert.equal(skillsSection.open, true, "one click reveals the real registered entries in-place");
  tabs[2].click();
  assert.ok(textNodes(elements["live-viewport"], "已汇总三个可选路径，等待审核。").length);
  assert.equal(textNodes(elements["live-viewport"], "已观测调用").length, 0,
    "capabilities are only expanded after selecting a runtime task");
  classNodes(elements["live-viewport"], "uw-agent-runtime-card-heading")[0].click();
  assert.ok(textNodes(elements["live-viewport"], "filesystem · 已观测调用").length);
  assert.ok(textNodes(elements["live-viewport"], "agent-teams-playbook · 已选择未观测调用").length);
  assert.equal(textNodes(elements["live-viewport"], "do-not-believe · 已观测调用").length, 0,
    "a planned-only record cannot launder an actualName into an invocation");
  assert.ok(textNodes(sidebar, "参考资料 · 非可调用能力").length);
  assert.equal(desktop.mode, "agents");
});

test("verified Kim_Service professional Agents are distinct from governance roles and never claim a runtime conclusion", () => {
  const { desktop, state, elements } = setup();
  state.capabilityCatalog.professionalSourceStatus = "verified_local";
  state.capabilityCatalog.professionalAgents = [{ id: "kim-service:product-listing-writer", label: "商品详情页专业方法",
    registrationState: "verified_source_only", invocationState: "not_observed" }];
  desktop.render();
  const sidebar = elements["agent-inventory"];
  const section = visit(sidebar, item => item.dataset.section === "professional-agents")[0];
  assert.ok(section);
  assert.ok(textNodes(section, "商品详情页专业方法").length);
  assert.ok(textNodes(section, "来源哈希已核验 · 未观测调用").length);
  assert.equal(textNodes(section, "负责人回报").length, 0);
  assert.equal(classNodes(sidebar, "uw-agent-inventory-agent").length, 3);
  assert.equal(classNodes(sidebar, "uw-agent-inventory-shortcut").length, 8,
    "source status changes update capability shortcuts in the same sidebar");
});

test("native CLI hosts and user Subagent presets are visible without claiming a native invocation", () => {
  let redetections = 0;
  const { desktop, state, elements, agent } = setup({ redetect() { redetections += 1; } });
  state.capabilityCatalog.nativeHosts = [
    { id: "claude", label: "Claude Code", status: "detected", version: "2.1.319" },
    { id: "codex", label: "Codex", status: "not_found", connectionLabel: "仅 CLI 诊断",
      blockedReason: "client_not_installed", nextAction: "请检查安装" },
    { id: "pi", label: "Pi", status: "not_probed", connectionLabel: "兼容配置候选" },
  ];
  state.capabilityCatalog.nativeCapabilities = [
    { key: "claude:agent:architect", id: "architect", label: "架构助手", kind: "agent", hostId: "claude",
      installationState: "configured", loadState: "unknown", invocationState: "not_observed" },
    { key: "claude:subagent:researcher", id: "researcher", label: "researcher", kind: "subagent_config", hostId: "claude",
      installationState: "configured", loadState: "unknown", invocationState: "not_observed" },
    { key: "claude:skill:product", id: "product", label: "产品评估", kind: "skill", hostId: "claude",
      installationState: "configured", loadState: "unknown", invocationState: "not_observed" },
    { key: "codex:mcp:filesystem", id: "filesystem", label: "filesystem", kind: "mcp", hostId: "codex",
      installationState: "configured", loadState: "unknown", invocationState: "not_observed" },
    { key: "codex:hook:safety", id: "safety", label: "safety", kind: "hook", hostId: "codex",
      installationState: "configured", loadState: "unknown", invocationState: "not_observed" },
  ];
  agent.hosts = [{ id: "claude", label: "Claude Code", available: true, launchSupported: true,
    statusLabel: "可用于只读研究", version: "2.1.319" }];
  desktop.render();
  const quicknav = classNodes(elements["agent-inventory"], "uw-agent-inventory-quicknav")[0];
  classNodes(quicknav, "uw-agent-inventory-shortcut")[2].click();
  const section = visit(elements["agent-inventory"], item => item.dataset.section === "native-hosts")[0];
  assert.ok(section.open, "clicking the hosts shortcut expands native hosts while detailed lists remain collapsed");
  assert.equal(classNodes(section, "uw-native-host").length, 2,
    "two distinct installed/probed clients and no duplicate host for the same id");
  const candidates = classNodes(section, "uw-native-host-candidates");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].open, false, "unprobed compatibility clients start inside one collapsed group");
  assert.ok(textNodes(candidates[0], "Pi").length, "Pi stays discoverable without claiming it was installed");
  assert.ok(textNodes(section, "Claude Code").length);
  assert.ok(textNodes(section, "Codex").length);
  assert.ok(textNodes(section, "可用于只读研究 · 执行需授权").length);
  assert.ok(textNodes(section, "未检测到 · 需安装或配置").length);
  assert.ok(textNodes(section, "当前服务端没有检测到该客户端").length);
  assert.ok(textNodes(section, "仅 CLI 诊断").length);
  assert.ok(textNodes(section, "Subagent 预设 1").length);
  assert.ok(textNodes(section, "产品评估").length);
  assert.ok(textNodes(section, "已发现配置 · 未确认加载").length);
  assert.equal(textNodes(section, "本轮已观测调用").length, 0,
    "registered native skills must not be counted as loaded or invoked");
  const marks = classNodes(section, "uw-native-host-mark");
  assert.deepEqual(marks.map(item => item.textContent), ["CL", "CX"]);
  assert.ok(marks.every(item => item.title.includes("非第三方官方 Logo")));
  classNodes(section, "uw-native-host-detect")[0].click();
  assert.equal(redetections, 1, "one user action refreshes actual CLI detection without running anything");
  assert.ok(textNodes(section, "云端扫描不代表连接了您的 Windows 电脑").length,
    "cloud service inventory must not be presented as the user's actual Windows computer");
  const runSubagents = visit(elements["agent-inventory"], item => item.dataset.section === "subagents")[0];
  assert.equal(classNodes(runSubagents, "uw-agent-inventory-capability").length, 1,
    "the one actual Run child must not acquire another row from a configured Subagent preset");
  assert.equal(textNodes(runSubagents, "researcher").length, 0,
    "configured-only Subagent presets never become invented child execution tasks");
});

test("sidebar and agent conclusions update on receipt changes, and hide other runs", () => {
  const { desktop, elements, source, state, tabs } = setup();
  tabs[2].click();
  source.ownerReport.summary = "第二版已经补齐模块依赖。";
  desktop.render();
  assert.ok(textNodes(elements["live-viewport"], "第二版已经补齐模块依赖。").length,
    "the Live canvas must not cache a stale conclusion with an unchanged task status");
  state.selection.runId = "another-run";
  desktop.render();
  assert.equal(textNodes(elements["live-viewport"], "第二版已经补齐模块依赖。").length, 0);
  assert.equal(textNodes(elements["agent-inventory"], "负责人回报").length, 0);
  assert.ok(textNodes(elements["agent-inventory"], "已注册 Agent").length,
    "registry identities remain inspectable but are never conflated with run evidence");
});

test("planning-only unstarted nodes never inflate Subagents or active execution counts, and shortcut uses literal Subagents", () => {
  const { desktop, elements, state } = setup();
  state.snapshot = { run: { id: "run-1", executionEvidenceState: "structural_planning_only" } };
  state.tasks = [{
    id: "route-execution",
    title: "route-execution",
    owner: "meta-scout",
    status: "not_started",
    source: {
      id: "route-execution",
      kind: "worker",
      isMain: false,
      runId: "run-1",
      parentId: "root-plan",
      ownerAgent: "meta-scout",
      declaredNotStarted: true,
      executionState: "not_executed",
      status: "not_started",
    },
  }];
  desktop.render();
  const sidebar = elements["agent-inventory"];
  assert.ok(textNodes(sidebar, "仅规划 · 未执行").length, "planning-only snapshots must not claim 1 active task");
  assert.equal(textNodes(sidebar, "1 个执行任务").length, 0);
  const quicknav = classNodes(sidebar, "uw-agent-inventory-quicknav")[0];
  assert.equal(textNodes(quicknav, "结论").length, 0, "confusing '结论' badge removed in favor of clear active run label");
  assert.equal(textNodes(quicknav, "子任务").length, 0, "must literally say Subagents instead of 子任务");
  const shortcuts = classNodes(sidebar, "uw-agent-inventory-shortcut");
  const runShortcut = shortcuts.find(item => item.dataset.targetSection === "run");
  const subagentShortcut = shortcuts.find(item => item.dataset.targetSection === "subagents");
  assert.equal(runShortcut.attributes["aria-label"], "本轮活跃 0");
  assert.equal(subagentShortcut.attributes["aria-label"], "Subagents 0");
});
