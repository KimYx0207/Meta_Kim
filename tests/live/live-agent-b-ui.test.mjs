import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { setImmediate } from "node:timers/promises";
import { createLiveWorkspaceController, LIVE_WORKSPACE_UI_POLICY, serializeLiveWorkspaceClient } from "../../src/presentation/live/live-workspace-client.mjs";
import { LIVE_WORKSPACE_MESSAGES, workspaceArtifactItems, workspaceMaterialIdentity, workspaceMaterialMatches, workspaceMaterialReady, workspaceCommandMessage } from "../../src/presentation/live/live-workspace-model.mjs";
import { projectLiveUserPhases } from "../../src/presentation/live/live-workspace-renderer.mjs";
import { renderLiveWorkspaceSurface } from "../../src/presentation/live/live-workspace-view.mjs";
import { LIVE_WORKSPACE_CSS } from "../../src/presentation/live/live-workspace-styles.mjs";

const digest = "a".repeat(64);
const nativeDraftKey = "native-draft-0000000002";
const token = "private-agent-token-123456789";
const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const hosts = (extra = {}) => ({ schemaVersion: "meta-kim-agent-hosts-v1", executionAllowed: true,
  executionScope: { kind: "server_bound", projectLabel: "Meta_Kim 本地根目录", projectFingerprint: digest },
  recommendedHostId: "claude", hosts: [
    { id: "claude", label: "Claude Code", available: true, launchSupported: true },
    { id: "codex", label: "Codex CLI", available: true, launchSupported: true },
  ], ...extra });
async function settled() { for (let i = 0; i < 10; i += 1) await setImmediate(); }

function uiNode(initial = "", tag = "div") {
  const listeners = new Map();
  return { tagName: tag.toUpperCase(), hidden: false, disabled: false, dataset: {}, attributes: {}, value: initial, textContent: "", children: [],
    addEventListener(name, cb) { listeners.set(name, cb); },
    dispatch(name) { listeners.get(name)?.({ preventDefault() {} }); },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    appendChild(child) { this.children.push(child); return child; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; },
    focus() { this.focused = true; },
  };
}

function harness(fetcher, storage = new Map(), { designUI = false, draftUI = false, optionsUI = false, handoffUI = false,
  followthroughUI = false, captureHostRetries = false } = {}) {
  const keys = ["entry", "start", "goal", "host", "host-status", "host-list", "submit", "status", "recovery", "verify", "redetect", "new", "result", "output", "result-summary", "scope", "scope-note", "decision", "feedback", "strategy", "choice-reason", "adopt", "revise", "reject", "decision-receipt", "decision-reconcile",
    ...(designUI ? ["design", "design-body", "design-status", "design-refresh"] : []),
    ...(draftUI ? ["draft", "draft-status", "draft-generate", "draft-manual", "draft-reconcile"] : []),
    ...(handoffUI ? ["transfer", "transfer-status", "transfer-check", "transfer-prepare", "transfer-reconcile", "transfer-receipt"] : []),
    ...(followthroughUI ? ["execution", "execution-status", "execution-evidence", "execution-records", "acceptance", "acceptance-status", "acceptance-evidence"] : []),
    ...(optionsUI ? ["options"] : [])];
  const ui = Object.fromEntries(keys.map((key) => [key, uiNode(key === "goal" ? "研究现有项目的三种方案" : "")]));
  const calls = [];
  const hostRetries = [];
  let openedProjects = 0;
  const win = { location: { origin: "http://127.0.0.1:4331", href: "http://127.0.0.1:4331/" }, history: { replaceState() {} },
    crypto: { randomUUID: (() => { let n = 0; return () => ++n === 2 && draftUI ? nativeDraftKey : `random-${n}`; })() },
    sessionStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    setInterval: () => 1, clearInterval() {},
    setTimeout: (fn, delay) => captureHostRetries && [1200, 2400].includes(delay)
      ? (hostRetries.push(fn), `host-retry-${hostRetries.length}`) : setTimeout(fn, delay),
    clearTimeout: (id) => { if (typeof id !== "string") clearTimeout(id); },
    fetch: async (url, options) => { const call = { url: new URL(url), ...options }; calls.push(call); return fetcher(call); },
  };
  const doc = { defaultView: win, visibilityState: "visible", addEventListener() {}, removeEventListener() {}, createElement(tag) { return uiNode("", tag); } };
  const root = { ownerDocument: doc, dataset: {}, querySelector(selector) {
    const key = /^\[data-uw-agent-(.+)\]$/.exec(selector)?.[1]; return key ? ui[key] || null : null;
  }, querySelectorAll: () => [] };
  const app = { querySelector: (selector) => selector === "[data-uw-workspace]" ? root : null, querySelectorAll: () => [] };
  const context = vm.createContext({ URL, AbortController, TextEncoder, Date, LIVE_WORKSPACE_MESSAGES, workspaceArtifactItems, workspaceMaterialIdentity, workspaceMaterialMatches, workspaceMaterialReady, workspaceCommandMessage,
    createLiveWorkspaceRenderer: () => ({ render() {}, renderMain() {}, detailCloseButton: null, content: { scrollTop: 0, focus() {} } }),
    options: { app, policy: LIVE_WORKSPACE_UI_POLICY, config: { enabled: true, agentEntryEnabled: true, controlHeader: "x-meta-kim-workspace-token", controlToken: token }, language: () => "zh", showLegacyView() {}, openProjects() { openedProjects += 1; }, openGraph() {} },
  });
  const controller = vm.runInContext("(" + createLiveWorkspaceController.toString() + ")(options)", context);
  controller.update({ snapshot: null, project: { displayName: "侧栏选中的其他项目" }, selection: { projectId: "other-project", runId: "" }, tasks: [], fallbackStages: [], origin: "governed_run" });
  return { ui, calls, storage, controller, runHostRetry: () => hostRetries.shift()?.(), openedProjects: () => openedProjects };
}

test("user-facing five phases are a conservative projection of the original eight", () => {
  const phases = projectLiveUserPhases([
    { id: "critical", status: "completed" }, { id: "fetch", status: "running" },
    { id: "thinking", status: "awaiting_human" }, { id: "execution", status: "completed" },
    { id: "review", status: "completed" }, // meta-review not recorded: not complete.
    { id: "verification", status: "completed" }, { id: "evolution", status: "planned" },
  ]);
  assert.equal(phases.length, 5);
  assert.deepEqual(phases.map(({ status }) => status), ["completed", "running", "waiting_human", "partial", "partial"]);
  assert.equal(projectLiveUserPhases([]).every(({ status }) => status === "unknown"), true);
  assert.equal(projectLiveUserPhases([{ id: "meta-review", status: "running" }])[3].status, "running");
  const markup = renderLiveWorkspaceSurface();
  assert.match(markup, /data-uw-phases/);
  // Review #1 moved the five phases and eight stages into one collapsed details
  // block; the six-step ribbon is the only user progress.
  assert.match(markup, /详情 · 所选 Run 的原始阶段记录/);
  assert.match(markup, /研究草稿 · 尚未进入正式 Run/);
  assert.match(markup, /上方研究草稿或采纳回执不会直接推进这里/);
  assert.match(markup, /href="#uw-user-flow"/);
  assert.match(markup, /<details class="uw-run-details">[\s\S]*data-uw-stages[\s\S]*<\/details>/);
  assert.match(markup, /data-uw-agent-decision-receipt/);
  assert.match(markup, /data-uw-agent-strategy/);
  assert.match(markup, /data-uw-agent-choice-reason/);
  assert.match(serializeLiveWorkspaceClient(), /function projectLiveUserPhases\(/);
  assert.match(LIVE_WORKSPACE_CSS, /\.uw-phase\[data-state="running"\]/);
  assert.match(LIVE_WORKSPACE_CSS, /\.uw-agent-decision\[hidden\] \{ display: none; \}/);
  assert.doesNotMatch(LIVE_WORKSPACE_CSS, /\.uw-agent-entry \{[^}]*max-height:/);
  assert.match(LIVE_WORKSPACE_CSS, /\.uw-workspace\[data-agent-entry-enabled="true"\]\[data-view="work"\] \{[^}]*overflow-y: auto/);
  assert.match(LIVE_WORKSPACE_CSS, /@media \(max-width: 767px\) \{ \.uw-phase-strip \{ grid-template-columns: repeat\(2/);
});

test("fixed server execution scope is visible, auto chooses supported research and Codex is disabled", async (t) => {
  const h = harness(({ url }) => reply(url.pathname.endsWith("/hosts") ? hosts() : { status: "accepted", requestId: "request-1" }));
  t.after(() => h.controller.dispose());
  await settled();
  assert.equal(h.ui.scope.textContent, "Meta_Kim 本地根目录");
  assert.match(h.ui["scope-note"].textContent, /左侧切换的项目仅用于查看记录/);
  assert.equal(h.ui.host.value, "auto");
  assert.equal(h.ui.host.children.find((option) => option.value === "codex").disabled, true);
  h.ui.start.dispatch("submit"); await settled();
  assert.equal(JSON.parse(h.calls.find(({ url }) => url.pathname.endsWith("/start")).body).hostId, "auto");
});

test("cold-start host discovery retries twice and then exposes a real supported client", async (t) => {
  let hostsChecked = 0;
  const h = harness(({ url }) => {
    if (url.pathname.endsWith("/hosts")) {
      hostsChecked += 1;
      if (hostsChecked < 3) throw new Error("local listener is still starting");
      return reply(hosts());
    }
    throw new Error("No native research was authorized");
  }, new Map(), { captureHostRetries: true });
  t.after(() => h.controller.dispose());
  await settled();
  assert.match(h.ui.status.textContent, /正在自动重试（1\/2）/);
  assert.equal(h.ui.submit.disabled, true);
  h.runHostRetry(); await settled();
  assert.match(h.ui.status.textContent, /正在自动重试（2\/2）/);
  h.runHostRetry(); await settled();
  assert.equal(hostsChecked, 3);
  assert.equal(h.ui.host.value, "auto");
  assert.equal(h.ui.status.hidden, true);
  assert.equal(h.calls.some(({ url }) => url.pathname.endsWith("/start")), false);
});

test("a restored pending plan also recovers after a transient host-discovery failure", async (t) => {
  const storage = new Map([["meta-kim-agent-planning:v1", JSON.stringify({ pending: {
    key: "previous-native-key", goal: "已有任务", hostId: "claude", projectFingerprint: digest,
  } })]]);
  let attempts = 0;
  const h = harness(({ url }) => {
    if (url.pathname.endsWith("/hosts")) {
      if (++attempts === 1) throw new Error("server waking");
      return reply(hosts());
    }
    if (url.pathname.endsWith("/requests")) return reply(agentRequest({ status: "completed" }));
    throw new Error("A restored request must only GET, never launch");
  }, storage, { captureHostRetries: true });
  t.after(() => h.controller.dispose());
  await settled();
  assert.equal(h.calls.filter(({ url }) => url.pathname.endsWith("/requests")).length, 0,
    "Old request must not be fetched before project identity is known");
  h.runHostRetry(); await settled();
  assert.equal(h.calls.filter(({ url }) => url.pathname.endsWith("/requests")).length, 1);
  assert.equal(h.calls.some(({ url }) => url.pathname.endsWith("/start")), false);
  assert.match(h.ui.status.textContent, /只读研究结束/);
});

test("an unsupported Gemini headless research client is visible but cannot start", async (t) => {
  const h = harness(({ url }) => reply(url.pathname.endsWith("/hosts") ? hosts({ recommendedHostId: null, hosts: [
    { id: "claude", label: "Claude Code", available: false, launchSupported: false, statusLabel: "未安装", nextAction: "安装后重试" },
    { id: "gemini", label: "Gemini CLI", available: true, launchSupported: false,
      reason: "gemini_noninteractive_plan_auto_execution_risk", statusLabel: "非交互式只读安全性未核验", nextAction: "暂不开放自动研究" },
  ] }) : { status: "accepted" }));
  t.after(() => h.controller.dispose());
  await settled();
  assert.match(h.ui.status.textContent, /暂未找到可启动的客户端/);
  assert.equal(h.ui.host.children.find((child) => child.value === "gemini").disabled, true);
  assert.match(h.ui["host-list"].children.map((item) => item.textContent).join(" "), /非交互式只读安全性未核验/);
  assert.equal(h.ui.submit.disabled, true);
  assert.equal(h.calls.some(({ url }) => url.pathname.endsWith("/start")), false);
});

test("a read-only plan without version digest cannot be approved", async (t) => {
  const h = harness(({ url }) => {
    if (url.pathname.endsWith("/hosts")) return reply(hosts());
    if (url.pathname.endsWith("/start")) return reply({ status: "accepted", requestId: "request-1" });
    return reply({ schemaVersion: "meta-kim-agent-request-v1", status: "completed", requestId: "request-1", resultPreview: "研究方案 B" });
  });
  t.after(() => h.controller.dispose());
  await settled(); h.ui.start.dispatch("submit"); await settled(); h.ui.verify.dispatch("click"); await settled();
  assert.equal(h.ui.result.hidden, false);
  assert.equal(h.ui.decision.hidden, true);
  assert.equal(h.ui.adopt.disabled, true);
  assert.equal(h.calls.some(({ url }) => url.pathname.endsWith("/decisions")), false);
});

test("adopting a versioned plan records the choice, not execution, with the original request identity", async (t) => {
  const h = harness(({ url }) => {
    if (url.pathname.endsWith("/hosts")) return reply(hosts());
    if (url.pathname.endsWith("/start")) return reply({ status: "accepted", requestId: "request-1" });
    if (url.pathname.endsWith("/requests")) return reply({ schemaVersion: "meta-kim-agent-request-v1", status: "completed", requestId: "request-1", planDigest: digest, resultPreview: "方案 B：先调研再设计。" });
    if (url.pathname.endsWith("/decisions")) return reply({ schemaVersion: "meta-kim-agent-decision-v1", status: "recorded", runId: null, executionAuthorized: false, decision: { state: "adopted_for_design", action: "adopt" } });
    throw new Error("Unexpected endpoint");
  });
  t.after(() => h.controller.dispose());
  await settled(); h.ui.start.dispatch("submit"); await settled(); h.ui.verify.dispatch("click"); await settled();
  assert.equal(h.ui.decision.hidden, false);
  assert.equal(h.ui.adopt.disabled, true, "Explicit strategy and reason must be supplied, not fabricated");
  assert.equal(h.ui.revise.disabled, true, "A revision needs explicit feedback");
  h.ui.strategy.value = "方案 B — 分阶段接入"; h.ui.strategy.dispatch("input");
  h.ui["choice-reason"].value = "先验证最关键的连接，再逐步迁移，能控制上线风险"; h.ui["choice-reason"].dispatch("input");
  assert.equal(h.ui.adopt.disabled, false);
  h.ui.adopt.dispatch("click"); await settled();
  const decisionCall = h.calls.find(({ url }) => url.pathname.endsWith("/decisions"));
  assert.equal(decisionCall.method, "POST");
  assert.equal(decisionCall.headers["x-meta-kim-workspace-token"], token);
  assert.deepEqual(JSON.parse(decisionCall.body), { idempotencyKey: "random-1", requestId: "request-1", planDigest: digest, action: "adopt",
    selectedStrategy: "方案 B — 分阶段接入", selectionReason: "先验证最关键的连接，再逐步迁移，能控制上线风险", decisionKey: "random-2" });
  assert.match(h.ui["decision-receipt"].textContent, /尚未授权代码执行/);
  assert.match(h.ui.status.textContent, /没有启动实际执行或验收/);
  assert.equal(h.ui.adopt.disabled, true);
  assert.equal(h.calls.filter(({ url }) => url.pathname.endsWith("/start")).length, 1);
});

test("requesting a revision sends the actual feedback; ambiguity preserves a same-key retry", async (t) => {
  let posted = 0;
  const h = harness(({ url }) => {
    if (url.pathname.endsWith("/hosts")) return reply(hosts());
    if (url.pathname.endsWith("/start")) return reply({ status: "accepted", requestId: "request-1" });
    if (url.pathname.endsWith("/requests")) return reply({ schemaVersion: "meta-kim-agent-request-v1", status: "completed", requestId: "request-1", planDigest: digest, resultPreview: "原始方案" });
    if (url.pathname.endsWith("/decisions")) {
      posted += 1;
      if (posted === 1) throw new Error("The response was lost");
      return reply({ schemaVersion: "meta-kim-agent-decision-v1", status: "recorded", executionAuthorized: false, decision: { state: "revision_requested", action: "revise", feedback: "补充风险边界" } });
    }
    throw new Error("Unexpected endpoint");
  });
  t.after(() => h.controller.dispose());
  await settled(); h.ui.start.dispatch("submit"); await settled(); h.ui.verify.dispatch("click"); await settled();
  h.ui.feedback.value = "补充风险边界"; h.ui.feedback.dispatch("input");
  assert.equal(h.ui.revise.disabled, false);
  h.ui.revise.dispatch("click"); await settled();
  assert.equal(h.ui["decision-reconcile"].hidden, false);
  assert.equal(h.ui.adopt.disabled, true);
  assert.equal(h.ui.new.hidden, true, "An unresolved decision cannot discard its reconciliation key");
  h.ui["decision-reconcile"].dispatch("click"); await settled();
  const decisions = h.calls.filter(({ url }) => url.pathname.endsWith("/decisions")).map(({ body }) => JSON.parse(body));
  assert.equal(decisions.length, 2);
  assert.equal(decisions[0].decisionKey, decisions[1].decisionKey);
  assert.equal(decisions[0].feedback, "补充风险边界");
  assert.match(h.ui["decision-receipt"].textContent, /已记录修改意见/);
});

test("a tab reload reconciles its durable receipt instead of issuing another start or decision POST", async (t) => {
  const sharedStorage = new Map();
  const fetcher = ({ url }) => {
    if (url.pathname.endsWith("/hosts")) return reply(hosts());
    if (url.pathname.endsWith("/start")) return reply({ status: "accepted", requestId: "request-1" });
    if (url.pathname.endsWith("/requests")) return reply({ schemaVersion: "meta-kim-agent-request-v1", status: "completed", requestId: "request-1", planDigest: digest,
      resultPreview: "方案 B", decision: { state: "adopted_for_design", action: "adopt", planDigest: digest, decisionKey: "random-2" } });
    throw new Error("No other endpoints should run on a fresh tab");
  };
  const first = harness(fetcher, sharedStorage);
  t.after(() => first.controller.dispose());
  await settled(); first.ui.start.dispatch("submit"); await settled();
  assert.equal(first.calls.filter(({ url }) => url.pathname.endsWith("/start")).length, 1);
  const second = harness(fetcher, sharedStorage);
  t.after(() => second.controller.dispose());
  await settled();
  assert.equal(second.ui.goal.value, "研究现有项目的三种方案");
  assert.equal(second.calls.filter(({ url }) => url.pathname.endsWith("/start")).length, 0);
  assert.equal(second.calls.filter(({ url }) => url.pathname.endsWith("/requests")).length, 1);
  assert.match(second.ui["decision-receipt"].textContent, /已记录采纳/);
  assert.equal(second.ui.adopt.disabled, true);
});

function nodesOf(node) {
  return [node, ...(node?.children || []).flatMap(nodesOf)];
}
function nodeWithText(root, tag, text) {
  const found = nodesOf(root).find((node) => node.tagName === tag.toUpperCase() && node.textContent === text);
  assert.ok(found, `Missing ${tag} with text ${text}`);
  return found;
}
function writeDesignInput(root, label, value) {
  const field = nodesOf(root).find((node) => node.tagName === "LABEL" && node.children[0]?.textContent === label);
  assert.ok(field, `Missing design field: ${label}`);
  field.children[1].value = value;
  field.children[1].dispatch("input");
}
function agentRequest(extra = {}) {
  return { schemaVersion: "meta-kim-agent-request-v1", status: "completed", requestId: "request-01", planDigest: digest,
    executionScope: hosts().executionScope, resultPreview: "方案 B：先分阶段开发", decision: {
      state: "adopted_for_design", action: "adopt", decisionKey: "choice-accepted-001",
      selectedStrategy: "方案 B", selectionReason: "先控制风险", planDigest: digest,
    }, ...extra };
}
function designSnapshot(version = 0, extra = {}) {
  const system = { title: "一人公司任务中枢", goal: "从意图到可审阅产物", architecture: "分层，数据单一来源",
    techStack: "Node / DOM", acceptance: ["有人工批准证据"], approval: { state: "pending", version: null, at: null, reason: null } };
  const modules = [{ id: "module-01", title: "任务路由", objective: "提取需求边界", inputContract: ["输入用户意图"],
    outputContract: ["输出任务建议"], boundaries: [], acceptance: ["拒绝缺失身份的操作"], dependencies: [],
    approval: { state: "pending", version: null, at: null, reason: null } }];
  return { schemaVersion: "meta-kim-agent-design-v1", status: version === 0 ? "not_started" : "draft", version,
    basis: { projectFingerprint: digest, idempotencyKey: "random-1", requestId: "request-01", planDigest: digest,
      decisionKey: "choice-accepted-001", selectedStrategy: "方案 B", selectionReason: "先控制风险" },
    system: version === 0 ? null : system, modules: version === 0 ? [] : modules,
    history: [], reviewComplete: false, readyForExecution: false, executionAuthorized: false, runId: null, ...extra };
}

function nativeDesignDraft(status = "not_started", extra = {}) {
  const fromDesign = designSnapshot(1);
  const nativeSystem = Object.fromEntries(Object.entries(fromDesign.system).filter(([name]) => name !== "approval"));
  const nativeModules = fromDesign.modules.map((module) => Object.fromEntries(Object.entries(module).filter(([name]) => name !== "approval")));
  return {
    schemaVersion: "meta-kim-agent-design-draft-v1", status, basis: designSnapshot().basis,
    draftSource: "native_readonly_unverified", nativeEvidenceVerified: false,
    executionAuthorized: false, runId: null,
    ...(status !== "not_started" && { draftKey: nativeDraftKey }),
    ...(status === "completed" && { draftDigest: "b".repeat(64), design: { system: nativeSystem, modules: nativeModules } }),
    ...extra,
  };
}

test("native structured candidates are clearly unverified, selectable and never silently approved", async (t) => {
  const strategies = [{ id: "A", title: "集中发布", approach: "一次上线", tradeoffs: "快但回退难", evidenceSummary: "模型自述，不是经核验引证", risks: "故障集中" },
    { id: "B", title: "分阶段迁移", approach: "先做一个服务", tradeoffs: "慢但风险可控", evidenceSummary: "需重新查证", risks: "迁移成本" }];
  const nativeOptions = JSON.stringify({ schemaVersion: "meta-kim-agent-strategy-options-v1", provenance: "native_plan_unverified",
    evidenceVerified: false, summary: "两个可行方向", strategies, recommendedStrategyId: "A", openQuestions: ["预算范围是什么？"] });
  const h = harness(({ url }) => {
    if (url.pathname.endsWith("/hosts")) return reply(hosts());
    if (url.pathname.endsWith("/start")) return reply({ status: "accepted", requestId: "request-01" });
    if (url.pathname.endsWith("/requests")) return reply(agentRequest({ decision: { state: "awaiting_human" }, resultPreview: nativeOptions }));
    throw new Error("Unexpected endpoint");
  }, new Map(), { optionsUI: true });
  t.after(() => h.controller.dispose());
  await settled(); h.ui.start.dispatch("submit"); await settled(); h.ui.verify.dispatch("click"); await settled();
  assert.equal(h.ui.options.hidden, false);
  assert.match(nodesOf(h.ui.options).map((node) => node.textContent).join(" "), /待核验/);
  const cards = nodesOf(h.ui.options).filter((node) => node.tagName === "BUTTON");
  assert.equal(cards.length, 2);
  assert.equal(cards[0].dataset.selected, "false", "Model recommendation is not the human choice");
  cards[1].dispatch("click");
  assert.equal(h.ui.strategy.value, "B：分阶段迁移");
  assert.equal(cards[1].dataset.selected, "true");
  assert.equal(h.ui.adopt.disabled, true, "Human reason is still required");
  assert.equal(h.ui["choice-reason"].focused, true);
  assert.match(h.ui.output.textContent, /evidenceVerified/);
});

test("unstructured or invalid strategy options keep original text without invented candidates", async (t) => {
  const h = harness(({ url }) => {
    if (url.pathname.endsWith("/hosts")) return reply(hosts());
    if (url.pathname.endsWith("/start")) return reply({ status: "accepted", requestId: "request-01" });
    if (url.pathname.endsWith("/requests")) return reply(agentRequest({ resultPreview: JSON.stringify({ schemaVersion: "meta-kim-agent-strategy-options-v1", evidenceVerified: true }) }));
    throw new Error("Unexpected endpoint");
  }, new Map(), { optionsUI: true });
  t.after(() => h.controller.dispose());
  await settled(); h.ui.start.dispatch("submit"); await settled(); h.ui.verify.dispatch("click"); await settled();
  assert.equal(h.ui.options.hidden, true);
  assert.match(h.ui.output.textContent, /evidenceVerified/);
});

test("a restored task from another server-bound project is isolated before any old decision can be reused", async (t) => {
  const storage = new Map();
  const original = harness(({ url }) => {
    if (url.pathname.endsWith("/hosts")) return reply(hosts());
    if (url.pathname.endsWith("/start")) return reply({ status: "accepted", requestId: "request-01" });
    throw new Error("Unexpected endpoint");
  }, storage);
  t.after(() => original.controller.dispose());
  await settled(); original.ui.start.dispatch("submit"); await settled();
  assert.equal(JSON.parse(storage.get("meta-kim-agent-planning:v1")).pending.projectFingerprint, digest);
  const changedProject = harness(({ url }) => {
    if (url.pathname.endsWith("/hosts")) return reply(hosts({ executionScope: { kind: "server_bound", projectLabel: "别的本地项目", projectFingerprint: "b".repeat(64) } }));
    if (url.pathname.endsWith("/requests")) return reply(agentRequest({ executionScope: { kind: "server_bound", projectLabel: "别的本地项目", projectFingerprint: "b".repeat(64) } }));
    throw new Error("Cross-project mutation must never happen");
  }, storage);
  t.after(() => changedProject.controller.dispose());
  await settled();
  assert.equal(storage.has("meta-kim-agent-planning:v1"), false);
  assert.equal(changedProject.calls.some(({ url }) => url.pathname.endsWith("/requests")), false,
    "Restored receipt is not queried before the new server-bound project was checked");
  assert.match(changedProject.ui.status.textContent, /旧项目的研究与审批回执已隔离/);
  assert.equal(changedProject.ui.decision.hidden, true);
  assert.equal(changedProject.calls.some(({ url }) => url.pathname.endsWith("/decisions")), false);
  assert.equal(changedProject.ui.scope.textContent, "别的本地项目");
});

test("B2 starts with genuine empty design, plain-language system/module inputs, and a bound CAS write", async (t) => {
  let current = designSnapshot();
  const h = harness(({ url, method, body }) => {
    if (url.pathname.endsWith("/hosts")) return reply(hosts());
    if (url.pathname.endsWith("/start")) return reply({ status: "accepted", requestId: "request-01" });
    if (url.pathname.endsWith("/requests")) return reply(agentRequest());
    if (url.pathname.endsWith("/designs")) {
      if (method === "POST") {
        const sent = JSON.parse(body);
        assert.equal(sent.action, "submit");
        assert.equal(sent.expectedVersion, 0);
        assert.equal(sent.idempotencyKey, "random-1");
        assert.equal(sent.decisionKey, "choice-accepted-001");
        assert.equal(sent.design.system.title, "一人公司任务中枢");
        assert.equal(sent.design.modules[0].inputContract[0], "输入用户意图");
        current = designSnapshot(1, { system: { ...sent.design.system, approval: { state: "pending" } },
          modules: sent.design.modules.map((module) => ({ ...module, approval: { state: "pending" } })) });
      }
      return reply(current);
    }
    throw new Error(`Unexpected endpoint ${url.pathname}`);
  }, new Map(), { designUI: true });
  t.after(() => h.controller.dispose());
  await settled(); h.ui.start.dispatch("submit"); await settled(); h.ui.verify.dispatch("click"); await settled();
  assert.equal(h.ui.design.hidden, false);
  assert.match(h.ui["design-status"].textContent, /尚无真实设计/);
  assert.ok(nodesOf(h.ui["design-body"]).some((node) => node.tagName === "INPUT" || node.tagName === "TEXTAREA"));
  assert.match(renderLiveWorkspaceSurface(), /B2 设计/);
  assert.match(renderLiveWorkspaceSurface(), /保存设计不会启动代码执行或发布/);
  writeDesignInput(h.ui["design-body"], "系统名称", "一人公司任务中枢");
  writeDesignInput(h.ui["design-body"], "系统目标", "从意图到可审阅产物");
  writeDesignInput(h.ui["design-body"], "架构和技术边界", "分层，数据单一来源");
  writeDesignInput(h.ui["design-body"], "技术栈", "Node / DOM");
  writeDesignInput(h.ui["design-body"], "系统验收标准", "有人工批准证据");
  writeDesignInput(h.ui["design-body"], "模块名称", "任务路由");
  writeDesignInput(h.ui["design-body"], "模块目标", "提取需求边界");
  writeDesignInput(h.ui["design-body"], "输入契约", "输入用户意图");
  writeDesignInput(h.ui["design-body"], "输出契约", "输出任务建议");
  writeDesignInput(h.ui["design-body"], "模块验收标准", "拒绝缺失身份的操作");
  nodeWithText(h.ui["design-body"], "button", "保存设计并进入人工审阅").dispatch("click");
  await settled();
  assert.equal(h.calls.filter(({ url, method }) => url.pathname.endsWith("/designs") && method === "POST").length, 1);
  assert.match(h.ui["design-status"].textContent, /设计版本 1 · 真实设计已保存/);
  assert.equal(h.calls.some(({ url }) => url.pathname.endsWith("/agent/run")), false);
});

test("B2 automatically requests a native read-only draft once, prepopulates editable two-level PRD, and binds provenance", async (t) => {
  let draftGets = 0;
  let saved = null;
  const h = harness(({ url, method, body }) => {
    if (url.pathname.endsWith("/hosts")) return reply(hosts());
    if (url.pathname.endsWith("/start")) return reply({ status: "accepted", requestId: "request-01" });
    if (url.pathname.endsWith("/requests")) return reply(agentRequest());
    if (url.pathname.endsWith("/designs")) {
      if (method === "POST") {
        saved = JSON.parse(body);
        return reply(designSnapshot(1, { system: { ...saved.design.system, approval: { state: "pending" } },
          modules: saved.design.modules.map((module) => ({ ...module, approval: { state: "pending" } })) }));
      }
      return reply(designSnapshot());
    }
    if (url.pathname.endsWith("/design-drafts")) {
      if (method === "POST") {
        const input = JSON.parse(body);
        assert.deepEqual(input, { idempotencyKey: "random-1", requestId: "request-01", planDigest: digest,
          decisionKey: "choice-accepted-001", draftKey: nativeDraftKey,
          goal: "研究现有项目的三种方案" });
        return reply(nativeDesignDraft("accepted"));
      }
      draftGets += 1;
      return reply(draftGets === 1 ? nativeDesignDraft() : nativeDesignDraft("completed"));
    }
    throw new Error(`Unexpected endpoint ${url.pathname}`);
  }, new Map(), { designUI: true, draftUI: true });
  t.after(() => h.controller.dispose());
  await settled(); h.ui.start.dispatch("submit"); await settled(); h.ui.verify.dispatch("click"); await settled();
  assert.equal(h.calls.filter(({ url, method }) => url.pathname.endsWith("/design-drafts") && method === "POST").length, 1);
  assert.equal(h.ui.draft.hidden, false);
  assert.match(h.ui["draft-status"].textContent, /正在生成系统级 PRD/);
  assert.equal(nodesOf(h.ui["design-body"]).some((node) => ["INPUT", "TEXTAREA"].includes(node.tagName)), false,
    "There is no unrequested blank 11-field form while native generation runs");

  h.ui["design-refresh"].dispatch("click"); await settled();
  assert.match(h.ui["draft-status"].textContent, /未经独立核验/);
  assert.match(nodesOf(h.ui["design-body"]).map((node) => node.value || "").join(" "), /一人公司任务中枢/);
  writeDesignInput(h.ui["design-body"], "系统目标", "用户审阅后确认的最终目标");
  nodeWithText(h.ui["design-body"], "button", "保存设计并进入人工审阅").dispatch("click"); await settled();
  assert.equal(saved.sourceDraftDigest, "b".repeat(64));
  assert.equal(saved.design.system.goal, "用户审阅后确认的最终目标");
  assert.equal(saved.action, "submit");
  assert.equal(h.calls.filter(({ url, method }) => url.pathname.endsWith("/design-drafts") && method === "POST").length, 1,
    "Refreshing design must not launch a second native generation");
  assert.equal(h.calls.some(({ url }) => url.pathname.endsWith("/run")), false);
});

test("B2 failed native generation remains honest, offers an explicit retry or a usable manual form", async (t) => {
  let drafts = 0;
  const h = harness(({ url, method }) => {
    if (url.pathname.endsWith("/hosts")) return reply(hosts());
    if (url.pathname.endsWith("/start")) return reply({ status: "accepted", requestId: "request-01" });
    if (url.pathname.endsWith("/requests")) return reply(agentRequest());
    if (url.pathname.endsWith("/designs")) return reply(designSnapshot());
    if (url.pathname.endsWith("/design-drafts")) {
      if (method === "POST") { drafts += 1; return reply(nativeDesignDraft("failed", { reason: "native_design_schema_invalid" })); }
      return reply(drafts ? nativeDesignDraft("failed", { reason: "native_design_schema_invalid" }) : nativeDesignDraft());
    }
    throw new Error(`Unexpected endpoint ${url.pathname}`);
  }, new Map(), { designUI: true, draftUI: true });
  t.after(() => h.controller.dispose());
  await settled(); h.ui.start.dispatch("submit"); await settled(); h.ui.verify.dispatch("click"); await settled();
  assert.equal(drafts, 1);
  assert.match(h.ui["draft-status"].textContent, /自动草稿未生成/);
  assert.equal(h.ui["draft-generate"].hidden, false);
  assert.equal(h.ui["draft-manual"].hidden, false);
  h.ui["draft-manual"].dispatch("click"); await settled();
  assert.match(h.ui["draft-status"].textContent, /手工编辑已展开/);
  assert.ok(nodesOf(h.ui["design-body"]).some((node) => node.tagName === "INPUT" || node.tagName === "TEXTAREA"));
  assert.equal(h.ui["draft-generate"].hidden, true, "Choosing manual mode never secretly retries the native model");
  assert.equal(drafts, 1);
});

test("B2 ambiguous draft POST keeps the same key and never automatically re-launches native generation", async (t) => {
  let posts = 0;
  const h = harness(({ url, method }) => {
    if (url.pathname.endsWith("/hosts")) return reply(hosts());
    if (url.pathname.endsWith("/start")) return reply({ status: "accepted", requestId: "request-01" });
    if (url.pathname.endsWith("/requests")) return reply(agentRequest());
    if (url.pathname.endsWith("/designs")) return reply(designSnapshot());
    if (url.pathname.endsWith("/design-drafts")) {
      if (method === "POST") { posts += 1; if (posts === 1) throw new Error("native response lost"); return reply(nativeDesignDraft("accepted")); }
      return reply(nativeDesignDraft("not_started"));
    }
    throw new Error(`Unexpected endpoint ${url.pathname}`);
  }, new Map(), { designUI: true, draftUI: true });
  t.after(() => h.controller.dispose());
  await settled(); h.ui.start.dispatch("submit"); await settled(); h.ui.verify.dispatch("click"); await settled();
  assert.equal(posts, 1);
  assert.equal(h.ui["draft-generate"].hidden, true);
  assert.equal(h.ui["draft-reconcile"].hidden, false);
  assert.equal(JSON.parse(h.storage.get("meta-kim-agent-planning:v1")).draftPendingKey.key, nativeDraftKey);
  h.ui["draft-reconcile"].dispatch("click"); await settled();
  assert.equal(posts, 2);
  const calls = h.calls.filter(({ url, method }) => url.pathname.endsWith("/design-drafts") && method === "POST");
  assert.equal(JSON.parse(calls[0].body).draftKey, JSON.parse(calls[1].body).draftKey);
  assert.equal(h.ui["draft-reconcile"].hidden, true, "Accepted native request is now polled, not relaunched");
});

test("B2 rejects a fabricated or dependency-cyclic native draft instead of filling the PRD", async (t) => {
  const invalid = nativeDesignDraft("completed");
  invalid.design.modules[0].dependencies = ["module-01"];
  const h = harness(({ url, method }) => {
    if (url.pathname.endsWith("/hosts")) return reply(hosts());
    if (url.pathname.endsWith("/start")) return reply({ status: "accepted", requestId: "request-01" });
    if (url.pathname.endsWith("/requests")) return reply(agentRequest());
    if (url.pathname.endsWith("/designs")) return reply(designSnapshot());
    if (url.pathname.endsWith("/design-drafts") && method === "GET") return reply(invalid);
    throw new Error("Invalid native design must not auto-POST or approve anything");
  }, new Map(), { designUI: true, draftUI: true });
  t.after(() => h.controller.dispose());
  await settled(); h.ui.start.dispatch("submit"); await settled(); h.ui.verify.dispatch("click"); await settled();
  assert.match(h.ui["draft-status"].textContent, /无法检查原生设计草稿/);
  assert.equal(h.ui["draft-generate"].hidden, true, "A failed GET must not trigger new native starts without a known server state");
  assert.equal(h.ui["draft-manual"].hidden, false);
  assert.equal(nodesOf(h.ui["design-body"]).some((node) => ["INPUT", "TEXTAREA"].includes(node.tagName)), false);
  assert.equal(h.calls.some(({ url, method }) => url.pathname.endsWith("/design-drafts") && method === "POST"), false);
});

test("B2 in-doubt recovery never automatically retries after a service restart", async (t) => {
  const storage = new Map([["meta-kim-agent-planning:v1", JSON.stringify({
    pending: { key: "random-1", goal: "研究现有项目的三种方案", hostId: "claude", projectFingerprint: digest },
    draftPendingKey: { key: nativeDraftKey },
  })]]);
  const h = harness(({ url, method }) => {
    if (url.pathname.endsWith("/hosts")) return reply(hosts());
    if (url.pathname.endsWith("/requests")) return reply(agentRequest());
    if (url.pathname.endsWith("/designs")) return reply(designSnapshot());
    if (url.pathname.endsWith("/design-drafts") && method === "GET") return reply(nativeDesignDraft("unknown", {
      recoveryState: "in_doubt", reason: "native_draft_outcome_not_confirmed",
    }));
    throw new Error("A restarted service may only be queried, not re-launched");
  }, storage, { designUI: true, draftUI: true });
  t.after(() => h.controller.dispose());
  await settled();
  assert.match(h.ui["draft-status"].textContent, /结果尚未确定/);
  assert.equal(h.ui["draft-generate"].hidden, true);
  assert.equal(h.ui["draft-reconcile"].hidden, false);
  h.ui["draft-reconcile"].dispatch("click"); await settled();
  assert.equal(h.calls.some(({ url, method }) => url.pathname.endsWith("/design-drafts") && method === "POST"), false);
  assert.equal(JSON.parse(storage.get("meta-kim-agent-planning:v1")).draftPendingKey.key, nativeDraftKey);
});

test("B2 preserves server approvals and revision-invalidated modules without treating approval as execution", async (t) => {
  const snapshot = designSnapshot(5, { status: "reviewing", system: { ...designSnapshot(1).system, approval: { state: "approved", version: 2 } },
    modules: [{ ...designSnapshot(1).modules[0], approval: { state: "invalidated", version: null, reason: "system_changed" } }] });
  let latest = snapshot;
  const h = harness(({ url, method, body }) => {
    if (url.pathname.endsWith("/hosts")) return reply(hosts());
    if (url.pathname.endsWith("/start")) return reply({ status: "accepted", requestId: "request-01" });
    if (url.pathname.endsWith("/requests")) return reply(agentRequest());
    if (url.pathname.endsWith("/designs")) {
      if (method === "POST") {
        const sent = JSON.parse(body);
        assert.equal(sent.action, "approve");
        assert.deepEqual(sent.target, { kind: "module", moduleId: "module-01" });
        assert.equal(sent.expectedVersion, 5);
        latest = designSnapshot(6, { status: "approved", reviewComplete: true,
          system: snapshot.system, modules: [{ ...snapshot.modules[0], approval: { state: "approved", version: 6 } }] });
      }
      return reply(latest);
    }
    throw new Error(`Unexpected ${url.pathname}`);
  }, new Map(), { designUI: true });
  t.after(() => h.controller.dispose());
  await settled(); h.ui.start.dispatch("submit"); await settled(); h.ui.verify.dispatch("click"); await settled();
  assert.ok(nodesOf(h.ui["design-body"]).some((node) => node.textContent.includes("已失效，需重新确认")));
  assert.match(h.ui["design-status"].textContent, /设计审阅中/);
  const moduleApproval = nodeWithText(h.ui["design-body"], "button", "批准模块设计");
  assert.equal(moduleApproval.disabled, false);
  moduleApproval.dispatch("click"); await settled();
  assert.match(h.ui["design-status"].textContent, /均已确认 · 尚未执行/);
  assert.equal(h.calls.some(({ method, url }) => method === "POST" && url.pathname.endsWith("/start") && JSON.parse(h.calls.find((call) => call.url.pathname.endsWith("/start")).body).goal !== "研究现有项目的三种方案"), false);
});

test("B2 detects a newer version during editing and preserves the draft until explicit discard", async (t) => {
  let server = designSnapshot(1);
  const h = harness(({ url, method }) => {
    if (url.pathname.endsWith("/hosts")) return reply(hosts());
    if (url.pathname.endsWith("/start")) return reply({ status: "accepted", requestId: "request-01" });
    if (url.pathname.endsWith("/requests")) return reply(agentRequest());
    if (url.pathname.endsWith("/designs") && method === "GET") return reply(server);
    throw new Error("A stale editor must never silently POST");
  }, new Map(), { designUI: true });
  t.after(() => h.controller.dispose());
  await settled(); h.ui.start.dispatch("submit"); await settled(); h.ui.verify.dispatch("click"); await settled();
  nodeWithText(h.ui["design-body"], "button", "修改系统").dispatch("click");
  writeDesignInput(h.ui["design-body"], "系统目标", "我尚未保存的真实修改");
  server = designSnapshot(2, { system: { ...designSnapshot(1).system, goal: "服务器上别人的新版本" } });
  h.ui["design-refresh"].dispatch("click"); await settled();
  assert.match(h.ui["design-status"].textContent, /服务器设计版本已变化/);
  assert.equal(nodeWithText(h.ui["design-body"], "button", "保存系统修改").disabled, true);
  const localField = nodesOf(h.ui["design-body"]).find((node) => ["INPUT", "TEXTAREA"].includes(node.tagName) && node.value === "我尚未保存的真实修改");
  assert.ok(localField, "The editor remains on screen while the conflict is presented");
  nodeWithText(h.ui["design-body"], "button", "舍弃本地编辑并读取最新版本").dispatch("click");
  assert.match(h.ui["design-status"].textContent, /设计版本 2/);
  assert.match(nodesOf(h.ui["design-body"]).map((node) => node.textContent).join(" "), /服务器上别人的新版本/);
  assert.equal(nodeWithText(h.ui["design-body"], "button", "修改系统").disabled, false);
});

test("B-path vertical layout never shrinks the title, plan form or formal phases into overlapping grid rows", () => {
  assert.match(LIVE_WORKSPACE_CSS, /\.uw-workspace\[data-agent-entry-enabled="true"\]\[data-view="work"\] \{[^}]*grid-template-rows: max-content max-content max-content max-content minmax\(380px,1fr\) max-content/);
  assert.match(LIVE_WORKSPACE_CSS, /\.uw-workspace\[data-agent-entry-enabled="true"\]\[data-view="work"\] \{[^}]*overflow-y: auto/);
  assert.match(LIVE_WORKSPACE_CSS, /@media \(max-width: 767px\) \{ \.uw-agent-design-form \{ grid-template-columns: minmax\(0,1fr\)/);
  assert.doesNotMatch(LIVE_WORKSPACE_CSS, /\.uw-agent-entry \{[^}]*overflow-y:/);
  assert.match(LIVE_WORKSPACE_CSS, /\.uw-workspace > \.uw-body \{ grid-row: 5; \}/);
  assert.match(LIVE_WORKSPACE_CSS, /\.uw-workspace\[data-view="prd"\][^}]*grid-template-rows: max-content 0 max-content max-content minmax\(0,1fr\) max-content/);
});

function handoffSnapshot(status = "eligible", extra = {}) {
  return { schemaVersion: "meta-kim-agent-handoff-v1", status,
    executionScope: hosts().executionScope,
    basis: designSnapshot().basis,
    designVersion: 5,
    designDigest: "c".repeat(64),
    handoffDigest: status === "prepared" ? "e".repeat(64) : null,
    envelope: status === "eligible" ? {} : null,
    receipt: status === "prepared" ? { handoffKey: "random-2", handoffDigest: "e".repeat(64), preparedAt: "2026-11-17T01:00:00Z" } : null,
    history: status === "prepared" ? [{ handoffKey: "random-2", designVersion: 5 }] : [],
    requiresNativeHostConfirmation: true, readyForExecution: false, executionAuthorized: false, runId: null, ...extra };
}

test("B3 preparation seals a genuine version-bound handoff without inventing a Run or host execution", async (t) => {
  let state = handoffSnapshot();
  const design = designSnapshot(5, { status: "approved", reviewComplete: true, designDigest: "c".repeat(64),
    system: { ...designSnapshot(1).system, approval: { state: "approved", version: 2 } },
    modules: [{ ...designSnapshot(1).modules[0], approval: { state: "approved", version: 5 } }] });
  const h = harness(({ url, method, body }) => {
    if (url.pathname.endsWith("/hosts")) return reply(hosts());
    if (url.pathname.endsWith("/start")) return reply({ status: "accepted", requestId: "request-01" });
    if (url.pathname.endsWith("/requests")) return reply(agentRequest());
    if (url.pathname.endsWith("/designs")) return reply(design);
    if (url.pathname.endsWith("/handoff")) {
      if (method === "POST") {
        const sent = JSON.parse(body);
        assert.equal(sent.idempotencyKey, "random-1");
        assert.equal(sent.designVersion, 5);
        assert.equal(sent.designDigest, "c".repeat(64));
        assert.equal(sent.decisionKey, "choice-accepted-001");
        assert.equal(sent.handoffKey, "random-2");
        state = handoffSnapshot("prepared");
      }
      return reply(state);
    }
    throw new Error(`Unexpected endpoint ${url.pathname}`);
  }, new Map(), { designUI: true, handoffUI: true });
  t.after(() => h.controller.dispose());
  await settled(); h.ui.start.dispatch("submit"); await settled(); h.ui.verify.dispatch("click"); await settled();
  assert.equal(h.ui.transfer.hidden, false);
  assert.match(h.ui["transfer-status"].textContent, /可封存当前版本/);
  assert.equal(h.ui["transfer-prepare"].disabled, false);
  h.ui["transfer-prepare"].dispatch("click"); await settled();
  assert.equal(h.calls.filter(({ url, method }) => url.pathname.endsWith("/handoff") && method === "POST").length, 1);
  assert.match(h.ui["transfer-status"].textContent, /交接摘要已封存/);
  assert.match(nodesOf(h.ui["transfer-receipt"]).map((node) => node.textContent).join(" "), /未执行/);
  assert.match(renderLiveWorkspaceSurface(), /准备交接材料（未执行）/);
  assert.equal(h.ui["transfer-prepare"].hidden, true);
});

test("B3 and B4 remain transparent evidence gates until the true Run and host authorization exist", async (t) => {
  let transfer = handoffSnapshot();
  const approvedDesign = designSnapshot(5, { status: "approved", reviewComplete: true, designDigest: "c".repeat(64),
    system: { ...designSnapshot(1).system, approval: { state: "approved", version: 2 } },
    modules: [{ ...designSnapshot(1).modules[0], approval: { state: "approved", version: 5 } }] });
  const h = harness(({ url, method }) => {
    if (url.pathname.endsWith("/hosts")) return reply(hosts());
    if (url.pathname.endsWith("/start")) return reply({ status: "accepted", requestId: "request-01" });
    if (url.pathname.endsWith("/requests")) return reply(agentRequest());
    if (url.pathname.endsWith("/designs")) return reply(approvedDesign);
    if (url.pathname.endsWith("/handoff")) {
      if (method === "POST") transfer = handoffSnapshot("prepared");
      return reply(transfer);
    }
    throw new Error("B3/B4 must never launch an unverified side effect or final acceptance");
  }, new Map(), { designUI: true, handoffUI: true, followthroughUI: true });
  t.after(() => h.controller.dispose());
  await settled(); h.ui.start.dispatch("submit"); await settled(); h.ui.verify.dispatch("click"); await settled();
  assert.equal(h.ui.execution.hidden, false);
  assert.equal(h.ui.acceptance.hidden, false);
  assert.match(h.ui["execution-status"].textContent, /还不足以执行/);
  h.ui["transfer-prepare"].dispatch("click"); await settled();
  assert.match(h.ui["execution-status"].textContent, /没有授权任何写入、发布、付费/);
  const executionRows = nodesOf(h.ui["execution-evidence"]).map((node) => node.textContent).join(" ");
  assert.match(executionRows, /仅静态材料已封存/);
  assert.match(executionRows, /未关联经过核验的正式 Run/);
  assert.match(executionRows, /B3 副作用授权/);
  assert.match(h.ui["acceptance-status"].textContent, /不能标记完成/);
  assert.match(nodesOf(h.ui["acceptance-evidence"]).map((node) => node.textContent).join(" "), /没有通过 B4 最终接受/);
  assert.equal(h.ui["execution-records"].textContent, "选择正式 Run 查看记录");
  h.ui["execution-records"].dispatch("click");
  assert.equal(h.openedProjects(), 1, "The only B3 action navigates to a real Run selector");
  assert.match(renderLiveWorkspaceSurface(), /B4 用户验收/);
  assert.match(LIVE_WORKSPACE_CSS, /@media \(max-width: 767px\) \{ \.uw-agent-gate button \{ min-height: 44px/);
  assert.equal(h.calls.some(({ url }) => url.pathname.endsWith("/agent/execute") || url.pathname.endsWith("/agent/accept")), false);
});

test("B3 lost response retains one handoff key and reconciles instead of creating a new execution", async (t) => {
  let posted = 0;
  const design = designSnapshot(5, { status: "approved", reviewComplete: true, designDigest: "c".repeat(64),
    system: { ...designSnapshot(1).system, approval: { state: "approved", version: 2 } },
    modules: [{ ...designSnapshot(1).modules[0], approval: { state: "approved", version: 5 } }] });
  const h = harness(({ url, method }) => {
    if (url.pathname.endsWith("/hosts")) return reply(hosts());
    if (url.pathname.endsWith("/start")) return reply({ status: "accepted", requestId: "request-01" });
    if (url.pathname.endsWith("/requests")) return reply(agentRequest());
    if (url.pathname.endsWith("/designs")) return reply(design);
    if (url.pathname.endsWith("/handoff")) {
      if (method === "POST") {
        posted += 1;
        if (posted === 1) throw new Error("network response lost");
        return reply(handoffSnapshot("prepared"));
      }
      return reply(handoffSnapshot());
    }
    throw new Error(`Unexpected endpoint ${url.pathname}`);
  }, new Map(), { designUI: true, handoffUI: true });
  t.after(() => h.controller.dispose());
  await settled(); h.ui.start.dispatch("submit"); await settled(); h.ui.verify.dispatch("click"); await settled();
  h.ui["transfer-prepare"].dispatch("click"); await settled();
  assert.equal(h.ui["transfer-reconcile"].hidden, false);
  assert.equal(h.ui["transfer-prepare"].hidden, true);
  h.ui["transfer-reconcile"].dispatch("click"); await settled();
  const posts = h.calls.filter(({ url, method }) => url.pathname.endsWith("/handoff") && method === "POST").map(({ body }) => JSON.parse(body));
  assert.equal(posts.length, 2);
  assert.equal(posts[0].handoffKey, posts[1].handoffKey);
  assert.match(h.ui["transfer-status"].textContent, /交接摘要已封存/);
});
