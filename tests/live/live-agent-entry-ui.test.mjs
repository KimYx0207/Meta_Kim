import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { setImmediate } from "node:timers/promises";
import { createLiveWorkspaceController, LIVE_WORKSPACE_UI_POLICY } from "../../src/presentation/live/live-workspace-client.mjs";
import { LIVE_WORKSPACE_MESSAGES, workspaceArtifactItems, workspaceMaterialIdentity, workspaceMaterialMatches, workspaceMaterialReady, workspaceCommandMessage } from "../../src/presentation/live/live-workspace-model.mjs";
import { renderLiveWorkspaceSurface } from "../../src/presentation/live/live-workspace-view.mjs";
import { LIVE_WORKSPACE_CSS } from "../../src/presentation/live/live-workspace-styles.mjs";

const token = "private-agent-token-123456789";
const hosts = ({ allowed = true, available = true } = {}) => ({
  schemaVersion: "meta-kim-agent-hosts-v1", executionAllowed: allowed,
  hosts: [{ id: "claude", label: "Claude Code", available, launchSupported: true,
    statusLabel: available ? "可生成只读方案" : "未检测到客户端",
    nextAction: available ? "输入目标后生成方案" : "安装或启动 Claude Code 后重新检测" },
    { id: "disabled", label: "尚未连接", available: false, launchSupported: false,
      reason: "客户端未安装", statusLabel: "未检测到客户端", nextAction: "安装后重新检测" }],
});
const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
async function settled() { for (let i = 0; i < 10; i += 1) await setImmediate(); }

function uiNode(initialValue = "") {
  const events = new Map();
  return {
    hidden: false, disabled: false, value: initialValue, dataset: {}, textContent: "", attributes: {},
    addEventListener(type, fn) { events.set(type, fn); },
    dispatch(type) { events.get(type)?.({ preventDefault() {} }); },
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() { this.focused = true; },
  };
}

function harness(fetcher, enabled = true, entryEnabled = true, { desktop } = {}) {
  const selectors = ["entry", "start", "goal", "host", "host-status", "host-list", "submit", "status", "recovery", "verify", "redetect", "new", "result", "output"];
  const ui = Object.fromEntries(selectors.map((name) => [name, uiNode(name === "goal" ? "帮我研究三个方案" : "")]));
  ui["host-list"].items = [];
  Object.defineProperty(ui["host-list"], "textContent", { get() { return ""; }, set(value) { if (value === "") this.items.length = 0; } });
  ui["host-list"].appendChild = (item) => ui["host-list"].items.push(item);
  const calls = [];
  const storage = new Map();
  const intervals = new Map();
  let state;
  const win = {
    location: { origin: "http://127.0.0.1:4319", href: "http://127.0.0.1:4319/" },
    history: { replaceState(_a, _b, url) { win.location.href = url; } },
    crypto: { randomUUID: () => "client-request-1" },
    sessionStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    setInterval: (callback, ms) => { intervals.set(ms, callback); return ms; },
    clearInterval: (ms) => { intervals.delete(ms); }, setTimeout, clearTimeout,
    fetch: async (url, options) => { const call = { url: new URL(url), ...options }; calls.push(call); return fetcher(call); },
  };
  const doc = { defaultView: win, visibilityState: "visible", addEventListener() {}, removeEventListener() {}, createElement() { return uiNode(); } };
  const root = {
    ownerDocument: doc, dataset: {},
    querySelector(selector) { const key = /^\[data-uw-agent-(.+)\]$/.exec(selector)?.[1]; return key ? ui[key] || null : null; },
    querySelectorAll: () => [],
  };
  const app = { querySelector: (selector) => selector === "[data-uw-workspace]" ? root : null, querySelectorAll: () => [] };
  ui.host.options = [];
  Object.defineProperty(ui.host, "textContent", { get() { return ""; }, set(value) { if (value === "") { this.options.length = 0; this.value = ""; } } });
  ui.host.appendChild = (option) => { ui.host.options.push(option); if (!ui.host.value && !option.disabled) ui.host.value = option.value; };
  const context = vm.createContext({ URL, AbortController, TextEncoder, Date, LIVE_WORKSPACE_MESSAGES, workspaceArtifactItems, workspaceMaterialIdentity, workspaceMaterialMatches, workspaceMaterialReady, workspaceCommandMessage,
    ...(desktop ? { createUnifiedAgentDesktop: desktop, createDynamicPrdWorkflowCanvas() {}, buildLivePrdGraph() {}, createPrdKnowledgeGraph() {},
      parseNativeStrategyOptions: () => [], translateAgentUi: (value) => value, formatLiveTime: String } : {}),
    createLiveWorkspaceRenderer: ({ state: controllerState }) => { state = controllerState; return { render() {}, renderMain() {}, detailCloseButton: null, content: { scrollTop: 0, focus() {} } }; },
    options: { app, policy: LIVE_WORKSPACE_UI_POLICY, config: { enabled, agentEntryEnabled: entryEnabled, controlHeader: "x-meta-kim-workspace-token", controlToken: token }, language: () => "zh", showLegacyView() {}, openProjects() {}, openGraph() {} },
  });
  const controller = vm.runInContext("(" + createLiveWorkspaceController.toString() + ")(options)", context);
  controller.update({ snapshot: null, project: { name: "实际项目" }, selection: { projectId: "project-1", runId: "" }, tasks: [], fallbackStages: [], origin: "governed_run" });
  return { controller, ui, calls, root,
    tickAgent: () => intervals.get(LIVE_WORKSPACE_UI_POLICY.agentReceiptPollMs)?.(),
    get state() { return state; } };
}

test("the new agent input is the original Live work surface and stays responsive", () => {
  const markup = renderLiveWorkspaceSurface();
  assert.match(markup, /data-uw-agent-start/);
  assert.match(markup, /说出你想做的事/);
  assert.match(markup, /生成方案/);
  assert.match(markup, /并说明推荐理由/);
  assert.doesNotMatch(markup, /开始处理|做出可以验收的结果/);
  assert.match(markup, /切换页面中的项目不会改变执行位置/);
  assert.match(markup, /data-uw-agent-goal/);
  assert.match(markup, /data-uw-agent-host/);
  assert.match(markup, /data-uw-agent-host-status/);
  assert.match(markup, /查看客户端连接情况/);
  assert.match(markup, /data-uw-agent-result/);
  assert.match(markup, /data-uw-agent-output/);
  assert.match(markup, /aria-live="polite"/);
  assert.match(markup, /data-uw-stages/);
  assert.match(LIVE_WORKSPACE_CSS, /\.uw-workspace\[data-view="prd"\] \.uw-agent-entry/);
  assert.match(LIVE_WORKSPACE_CSS, /\.uw-workspace:not\(\[data-agent-entry-enabled="true"\]\)/);
  assert.match(LIVE_WORKSPACE_CSS, /@media \(max-width: 767px\) \{ \.uw-agent-entry/);
});

test("read-only Agent desktop reads only the safe capability index, never probes or launches native hosts", async (t) => {
  const h = harness(({ url }) => {
    assert.equal(url.pathname, "/api/agent/capabilities");
    return reply({ schemaVersion: 1, evidenceLevel: "registered_only", observedRuntime: false,
      agents: [{ id: "meta-scout", label: "meta-scout", registrationState: "registered", invocationState: "not_observed" }],
      skills: [], hooks: [], mcpServers: [] });
  }, false);
  t.after(() => h.controller.dispose());
  await settled();
  assert.deepEqual(h.calls.map(({ url, method }) => [url.pathname, method]), [["/api/agent/capabilities", "GET"]]);
  assert.equal(h.state.capabilityCatalog.agents[0].id, "meta-scout");
  assert.equal(h.ui.submit.disabled, true);
  assert.equal(h.ui.host.disabled, true);
  assert.match(h.ui.status.textContent, /私有控制权限/);
  h.ui.start.dispatch("submit"); await settled();
  assert.equal(h.calls.length, 1);
});

test("launch uses one private same-origin request and accepts without claiming execution", async (t) => {
  const h = harness(({ url }) => reply(url.pathname.endsWith("/hosts") ? hosts() : { status: "accepted", requestId: "request-1" }));
  t.after(() => h.controller.dispose());
  await settled();
  assert.equal(h.ui.host.value, "claude");
  assert.equal(h.ui.host.options[1].disabled, true);
  assert.equal(h.ui["host-status"].hidden, false);
  assert.match(h.ui["host-list"].items[1].textContent, /未检测到客户端.*安装后重新检测/);
  assert.equal(h.ui.submit.disabled, false);
  h.ui.start.dispatch("submit"); await settled();
  const launches = h.calls.filter(({ url }) => url.pathname.endsWith("/start"));
  assert.equal(launches.length, 1);
  assert.equal(launches[0].url.origin, "http://127.0.0.1:4319");
  assert.equal(launches[0].headers["x-meta-kim-workspace-token"], token);
  assert.equal(launches[0].credentials, "same-origin");
  assert.equal(launches[0].method, "POST");
  assert.deepEqual(JSON.parse(launches[0].body), { goal: "帮我研究三个方案", hostId: "claude", idempotencyKey: "client-request-1" });
  assert.match(h.ui.status.textContent, /等待客户端建立会话/);
  assert.doesNotMatch(h.ui.status.textContent, /开始运行|执行中|已完成/);
  h.ui.start.dispatch("submit"); await settled();
  assert.equal(h.calls.filter(({ url }) => url.pathname.endsWith("/start")).length, 1, "Repeated click cannot re-launch accepted work");
  assert.equal(h.ui.new.hidden, true, "An accepted task must keep its recovery key and poller");
  h.ui.new.dispatch("click");
  assert.equal(h.ui.goal.value, "帮我研究三个方案");
  assert.equal(h.ui.goal.focused, undefined);
});

test("no available client expands visible setup guidance instead of hiding reasons in a disabled option", async (t) => {
  const h = harness(({ url }) => reply(url.pathname.endsWith("/hosts") ? hosts({ available: false }) : {}));
  t.after(() => h.controller.dispose());
  await settled();
  assert.equal(h.ui["host-status"].open, true);
  assert.equal(h.ui.submit.disabled, true);
  assert.match(h.ui["host-list"].items[0].textContent, /未检测到客户端.*安装或启动 Claude Code 后重新检测/);
  assert.match(h.ui["host-list"].items[1].textContent, /安装后重新检测/);
});

test("the accepted receipt explains when an actual Kim_Service professional method was hash-bound", async (t) => {
  const h = harness(({ url }) => reply(url.pathname.endsWith("/hosts") ? hosts()
    : { status: "accepted", requestId: "request-1", runId: null,
      capabilityState: { status: "verified_local_method_bound", ownerAgent: "product-listing-writer", methodProvidedToRuntime: true } }));
  t.after(() => h.controller.dispose());
  await settled();
  h.ui.start.dispatch("submit"); await settled();
  assert.match(h.ui.status.textContent, /Kim_Service.*专业方法已关联/u);
  assert.doesNotMatch(h.ui.status.textContent, /已完成|验收通过/u);
});

test("confirmed running is reported only after a valid native receipt", async (t) => {
  const h = harness(({ url }) => {
    if (url.pathname.endsWith("/hosts")) return reply(hosts());
    if (url.pathname.endsWith("/start")) return reply({ status: "accepted", requestId: "request-1" });
    if (url.pathname.endsWith("/requests")) return reply({ schemaVersion: "meta-kim-agent-request-v1", status: "running", requestId: "request-1", runId: "native-run-1" });
    throw new Error("Unexpected endpoint");
  });
  t.after(() => h.controller.dispose());
  await settled();
  h.ui.start.dispatch("submit"); await settled();
  assert.match(h.ui.status.textContent, /等待客户端建立会话/);
  h.ui.verify.dispatch("click"); await settled();
  assert.match(h.ui.status.textContent, /已确认开始运行/);
  assert.equal(h.ui.new.hidden, true, "A running task cannot be discarded before its receipt arrives");
  h.ui.new.dispatch("click");
  h.ui.verify.dispatch("click"); await settled();
  assert.match(h.ui.status.textContent, /已确认开始运行/, "A user click cannot orphan the running request");
  const verify = h.calls.find(({ url }) => url.pathname.endsWith("/requests"));
  assert.equal(verify.url.searchParams.get("idempotencyKey"), "client-request-1");
  assert.equal(verify.headers["x-meta-kim-workspace-token"], token);
});

test("completed native read-only advice is shown as text, not promoted to verified delivery", async (t) => {
  const untrustedPreview = "建议检查现有项目。<script>alert('unsafe')</script>";
  const h = harness(({ url }) => {
    if (url.pathname.endsWith("/hosts")) return reply(hosts());
    if (url.pathname.endsWith("/start")) return reply({ status: "accepted", requestId: "request-1", runId: null });
    if (url.pathname.endsWith("/requests")) return reply({ schemaVersion: "meta-kim-agent-request-v1", status: "completed", requestId: "request-1", runId: null, resultPreview: untrustedPreview });
    throw new Error("Unexpected endpoint");
  });
  t.after(() => h.controller.dispose());
  await settled();
  h.ui.start.dispatch("submit"); await settled();
  h.ui.verify.dispatch("click"); await settled();
  assert.equal(h.ui.result.hidden, false);
  assert.equal(h.ui.result.open, true);
  assert.equal(h.ui.output.textContent, untrustedPreview);
  assert.match(h.ui.status.textContent, /只读研究已返回建议/);
  assert.doesNotMatch(h.ui.status.textContent, /交付已完成|项目验收通过/);
  assert.equal(h.ui.new.hidden, false, "A completed request can release its receipt key for the next task");
  h.ui.new.dispatch("click");
  assert.equal(h.ui.goal.value, "");
  assert.equal(h.ui.goal.focused, true);
});

test("receipts refresh automatically while running and stop after the native reply", async (t) => {
  let checked = 0;
  const h = harness(({ url }) => {
    if (url.pathname.endsWith("/hosts")) return reply(hosts());
    if (url.pathname.endsWith("/start")) return reply({ status: "accepted", requestId: "request-1", runId: null });
    if (url.pathname.endsWith("/requests")) {
      checked += 1;
      return reply({ schemaVersion: "meta-kim-agent-request-v1", status: checked === 1 ? "running" : "completed",
        requestId: "request-1", runId: null, resultPreview: "调查结论：建议选择方案 B。" });
    }
    throw new Error("Unexpected endpoint");
  });
  t.after(() => h.controller.dispose());
  await settled();
  h.ui.start.dispatch("submit"); await settled();
  assert.equal(checked, 0);
  h.tickAgent(); await settled();
  assert.equal(checked, 1);
  assert.match(h.ui.status.textContent, /已确认开始运行/);
  h.tickAgent(); await settled();
  assert.equal(checked, 2);
  assert.equal(h.ui.output.textContent, "调查结论：建议选择方案 B。");
  h.tickAgent(); await settled();
  assert.equal(checked, 2, "No more polling once native planning has finished");
});

test("network ambiguity checks the same key and retries idempotently", async (t) => {
  let launches = 0;
  const h = harness(({ url }) => {
    if (url.pathname.endsWith("/hosts")) return reply(hosts());
    if (url.pathname.endsWith("/requests")) return reply({ schemaVersion: "meta-kim-agent-request-v1", status: "unknown" });
    if (url.pathname.endsWith("/start")) {
      launches += 1;
      if (launches === 1) throw new Error("A reply was lost after sending");
      return reply({ status: "accepted", requestId: "request-1" });
    }
    throw new Error("Unexpected endpoint");
  });
  t.after(() => h.controller.dispose());
  await settled();
  h.ui.start.dispatch("submit"); await settled();
  assert.match(h.ui.status.textContent, /尚未查到/);
  assert.equal(h.ui.redetect.dataset.action, "retry");
  assert.equal(h.ui.goal.value, "帮我研究三个方案", "The original draft remains available");
  h.ui.redetect.dispatch("click"); await settled();
  assert.match(h.ui.status.textContent, /等待客户端建立会话/);
  const posts = h.calls.filter(({ url }) => url.pathname.endsWith("/start"));
  assert.equal(posts.length, 2);
  assert.equal(JSON.parse(posts[0].body).idempotencyKey, JSON.parse(posts[1].body).idempotencyKey);
  assert.equal(h.ui.submit.disabled, true);
});

test("capability denial disables submission rather than presenting simulated success", async (t) => {
  const h = harness(({ url }) => {
    if (url.pathname.endsWith("/hosts")) return reply(hosts({ allowed: false }));
    throw new Error("A denied host cannot start");
  });
  t.after(() => h.controller.dispose());
  await settled();
  assert.equal(h.ui.submit.disabled, true);
  assert.match(h.ui.status.textContent, /未开放客户端启动权限/);
  h.ui.start.dispatch("submit"); await settled();
  assert.equal(h.calls.some(({ url }) => url.pathname.endsWith("/start")), false);
});

test("rejected launch keeps the task text and offers a plain-language recovery", async (t) => {
  const h = harness(({ url }) => reply(url.pathname.endsWith("/hosts") ? hosts() : { error: { message: "Forbidden" } }, url.pathname.endsWith("/hosts") ? 200 : 403));
  t.after(() => h.controller.dispose());
  await settled();
  h.ui.start.dispatch("submit"); await settled();
  assert.equal(h.ui.goal.value, "帮我研究三个方案");
  assert.match(h.ui.status.textContent, /无权启动客户端/);
  assert.equal(h.ui.redetect.dataset.action, "redetect");
  assert.equal(h.ui.submit.disabled, false, "The user can revise or retry after deterministic refusal");
});

test("unavailable hosts cannot appear launchable", async (t) => {
  const h = harness(({ url }) => {
    if (url.pathname.endsWith("/hosts")) return reply(hosts({ available: false }));
    throw new Error("Unavailable host must not receive a POST");
  });
  t.after(() => h.controller.dispose());
  await settled();
  assert.equal(h.ui.submit.disabled, true);
  assert.match(h.ui.status.textContent, /暂未找到可启动的客户端/);
  assert.equal(h.ui.redetect.dataset.action, "redetect");
  h.ui.start.dispatch("submit"); await settled();
  assert.equal(h.calls.filter(({ url }) => url.pathname.endsWith("/hosts")).length, 1);
  assert.equal(h.calls.filter(({ url }) => url.pathname.endsWith("/start")).length, 0,
    "a registered capability directory does not enable a host launch");
});

test("Hub without explicit agent entry capability never exposes launch", async (t) => {
  const h = harness(() => { throw new Error("Disabled entry must not contact the agent API"); }, true, false);
  t.after(() => h.controller.dispose());
  await settled();
  assert.equal(h.ui.entry.hidden, true);
  assert.equal(h.root.dataset.agentEntryEnabled, "false");
  assert.equal(h.calls.length, 0);
  h.ui.start.dispatch("submit"); await settled();
  assert.equal(h.calls.length, 0);
});

test("review #24: opening the full run graph tab keeps the chat beside it", () => {
  let callbacks = null;
  const desktop = (options) => { callbacks = options.callbacks; return { render() {}, mode: "live-run" }; };
  const h = harness(({ url }) => reply(url.pathname.endsWith("/hosts") ? hosts() : {}), true, true, { desktop });
  assert.ok(callbacks?.onLiveModeChange, "the controller hands the desktop a tab-change callback");
  h.root.dataset.paneLayout = "split";
  callbacks.onLiveModeChange("live-run", "flow");
  assert.equal(h.root.dataset.paneLayout, "split", "the chat column must stay open when the run graph tab opens");
  callbacks.onLiveModeChange("flow", "live-run");
  assert.equal(h.root.dataset.paneLayout, "split");
});
