import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { setImmediate } from "node:timers/promises";
import { createLiveWorkspaceController, LIVE_WORKSPACE_UI_POLICY } from "../../src/presentation/live/live-workspace-client.mjs";
import { LIVE_WORKSPACE_MESSAGES, workspaceStatusKey, workspaceArtifactItems, workspaceMaterialIdentity, workspaceMaterialMatches, workspaceMaterialReady, workspaceReviewForArtifact, workspaceCommandMessage } from "../../src/presentation/live/live-workspace-model.mjs";
import { renderLiveControlRoomPage } from "../../src/presentation/live/live-control-room-page.mjs";
import { createLiveWorkspaceRenderer } from "../../src/presentation/live/live-workspace-renderer.mjs";

const token = "workspace-test-token-123456789";
const architecture = { id: "outline", artifactId: "prd:outline", version: 1, sha256: "a".repeat(64), title: "系统总纲" };
const module = (id) => ({ id, artifactId: "prd:" + id, version: 1, sha256: "b".repeat(64), title: id });
const review = (item) => ({ decisionId: "review:" + item.id, revision: 1, artifactId: item.artifactId, version: item.version, sha256: item.sha256, state: "awaiting_human", available: true, options: [{ id: "accept" }, { id: "revise" }, { id: "return" }] });
const workspace = (overrides = {}) => ({ schemaVersion: "meta-kim-live-workspace-v1", projectId: "project", runId: "run", available: true, revision: 2, design: { version: 1, architecture, modules: [], totalModules: 0, nextCursor: null }, reviews: [review(architecture)], requests: [], stages: [{ id: "meta-review", label: "复审", status: "waiting" }], capabilities: { review: { available: true }, feedback: { available: true }, host: { available: false, mode: "current_host_pull" } }, source: { recordOrigin: "acceptance_fixture", version: 1 }, ...overrides });
const reply = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
const readMaterial = (item) => ({ identity: workspaceMaterialIdentity(item), verified: true, sha256: item.sha256, text: "已读取的一页", sourceState: "current" });
async function settled() { for (let index = 0; index < 8; index += 1) await setImmediate(); }

function harness(fetcher) {
  const calls = [];
  const storage = new Map();
  const listeners = new Map();
  let state;
  let actions;
  let nonce = 0;
  const win = {
    location: { origin: "http://127.0.0.1:4331", href: "http://127.0.0.1:4331/" },
    history: { replaceState(_a, _b, url) { win.location.href = url; } },
    crypto: { randomUUID: () => "nonce-" + ++nonce },
    sessionStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout,
    fetch: async (url, options) => { const call = { url: new URL(url), ...options }; calls.push(call); return fetcher(call); },
  };
  const doc = { defaultView: win, visibilityState: "visible", addEventListener: (key, value) => listeners.set(key, value), removeEventListener: (key) => listeners.delete(key) };
  const root = { ownerDocument: doc, querySelector: () => null, querySelectorAll: () => [] };
  const app = { querySelector: (selector) => selector === "[data-uw-workspace]" ? root : null, querySelectorAll: () => [] };
  const context = vm.createContext({ URL, AbortController, TextEncoder, Date, LIVE_WORKSPACE_MESSAGES, workspaceArtifactItems, workspaceMaterialIdentity, workspaceMaterialMatches, workspaceMaterialReady, workspaceCommandMessage,
    createLiveWorkspaceRenderer: (input) => { state = input.state; actions = input.actions; return { render() {}, renderMain() {}, detailCloseButton: null, content: { scrollTop: 0, focus() {} } }; },
    options: { app, policy: { ...LIVE_WORKSPACE_UI_POLICY, refreshCoalesceMs: 0 }, config: { enabled: true, controlHeader: "x-meta-kim-workspace-token", controlToken: token }, language: () => "zh", showLegacyView() {}, openProjects() {}, openGraph() {} },
  });
  const controller = vm.runInContext("(" + createLiveWorkspaceController.toString() + ")(options)", context);
  const update = (runId = "run") => controller.update({ snapshot: { run: { id: runId, title: "真实任务", status: "running" } }, project: { displayName: "项目" }, selection: { projectId: "project", runId }, tasks: [], fallbackStages: [], origin: "governed_run" });
  return { controller, calls, update, get state() { return state; }, get actions() { return actions; } };
}

test("the workspace client is valid in the actual page and uses its independent private token", () => {
  const html = renderLiveControlRoomPage({ workspaceConfig: { enabled: true, controlHeader: "x-meta-kim-workspace-token", controlToken: token } });
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  const config = JSON.parse(html.match(/id="live-workspace-config">([^<]+)<\/script>/)[1]);
  assert.equal(config.controlToken, token);
  assert.equal(config.enabled, true);
  assert.match(html, /data-live-workspace-root/);
  assert.match(html, /data-workspace-revision=""/);
  assert.match(html, /root\.dataset\.workspaceRevision = state\.workspace\?\.revision/);
  assert.match(html, /data-live-workspace-nav="prd"/);
  const refused = renderLiveControlRoomPage({ workspaceConfig: { enabled: true, controlHeader: "x-untrusted", controlToken: token } });
  assert.equal(JSON.parse(refused.match(/id="live-workspace-config">([^<]+)<\/script>/)[1]).enabled, false);
});

test("every workspace message exists in all four locales and host reports never become completion", () => {
  const keys = Object.keys(LIVE_WORKSPACE_MESSAGES.zh).sort();
  for (const language of ["en", "ja", "ko"]) assert.deepEqual(Object.keys(LIVE_WORKSPACE_MESSAGES[language]).sort(), keys, language);
  assert.equal(workspaceStatusKey("in_doubt"), "unproven");
  assert.equal(workspaceStatusKey("host_reported"), "host_reported");
  assert.equal(workspaceCommandMessage("host_reported", "feedback"), "hostReported");
  assert.match(LIVE_WORKSPACE_MESSAGES.zh.hostReported, /仍需验证/);
  assert.equal(workspaceCommandMessage("superseded", "feedback"), "supersededMessage");
});

test("private overview, material, and request GETs all carry the workspace token", async (t) => {
  const h = harness(({ url }) => {
    if (url.pathname.endsWith("/material")) return reply({ artifactId: architecture.artifactId, version: 1, sha256: architecture.sha256, text: "# 总纲\n内容", totalBytes: 20, nextCursor: null });
    if (url.pathname.endsWith("/requests")) return reply({ requests: [] });
    return reply(workspace());
  });
  t.after(() => h.controller.dispose());
  h.update(); await settled();
  h.actions.setPrdMode("overview");
  await h.actions.loadMaterial(architecture, false);
  h.state.command = { nonce: "receipt-test", status: "pending_verification", targetIdentity: workspaceMaterialIdentity(architecture) };
  await h.actions.verifyCommand();
  await settled();
  for (const call of h.calls) {
    assert.equal(call.headers["x-meta-kim-workspace-token"], token, call.url.pathname);
    if (call.method === "GET") assert.equal(call.headers["content-type"], undefined);
  }
  assert.ok(h.calls.some((call) => call.url.pathname.endsWith("/material")));
  assert.ok(h.calls.some((call) => call.url.pathname.endsWith("/requests")));
  assert.equal(h.state.origin, "acceptance_fixture");
});

test("module pagination retains prior reviews and selected modules after a background refresh", async (t) => {
  const first = module("alpha"); const second = module("beta");
  const h = harness(({ url }) => {
    if (url.pathname.endsWith("/material")) return reply({ artifactId: second.artifactId, version: 1, sha256: second.sha256, text: "beta", nextCursor: null });
    const isSecond = url.searchParams.get("cursor") === "page-two";
    return reply(workspace({ design: { version: 1, architecture, modules: [isSecond ? second : first], totalModules: 2, nextCursor: isSecond ? null : "page-two" }, reviews: [review(isSecond ? second : first)] }));
  });
  t.after(() => h.controller.dispose());
  h.update(); await settled();
  await h.actions.loadModules(); await settled();
  assert.deepEqual(Array.from(h.state.workspace.design.modules, (item) => item.id), ["alpha", "beta"]);
  assert.deepEqual(Array.from(h.state.workspace.reviews, (item) => item.decisionId), ["review:alpha", "review:beta"]);
  h.actions.selectModule("beta"); await settled();
  h.update(); await settled();
  assert.equal(h.state.selectedModuleId, "beta");
  assert.equal(h.state.workspace.design.nextCursor, null);
  assert.deepEqual(Array.from(h.state.workspace.design.modules, (item) => item.id), ["alpha", "beta"]);
  assert.equal(workspaceReviewForArtifact(h.state.workspace, second).decisionId, "review:beta");
});

test("ambiguous POST verifies the original nonce and never sends a duplicate request", async (t) => {
  const h = harness(({ url, method }) => {
    if (method === "POST") throw new Error("connection reset after send");
    if (url.pathname.endsWith("/requests")) return reply({ requests: [] });
    return reply(workspace());
  });
  t.after(() => h.controller.dispose());
  h.update(); await settled();
  h.state.material = readMaterial(architecture);
  h.actions.review(review(architecture), architecture, "accept"); await settled();
  assert.equal(h.state.command.status, "pending_verification");
  const nonce = h.state.command.nonce;
  assert.ok(h.calls.some((call) => call.url.searchParams.get("nonce") === nonce));
  h.actions.review(review(architecture), architecture, "accept"); await settled();
  assert.equal(h.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(h.state.command.nonce, nonce);
  assert.match(h.state.command.message, /待核实|待核|未核实/);
});

test("a recovered recorded receipt reports waiting for the host and preserves the original feedback", async (t) => {
  const original = "  请修改这里😀\n其他部分保留。  ";
  let saved;
  const h = harness(({ url, method, body }) => {
    if (method === "POST") { saved = JSON.parse(body); throw new Error("response lost"); }
    if (url.pathname.endsWith("/requests")) return reply({ requests: [{ nonce: saved.nonce, commandId: "receipt-1", status: "waiting_host" }] });
    return reply(workspace());
  });
  t.after(() => h.controller.dispose());
  h.update(); await settled();
  h.state.material = readMaterial(architecture);
  h.actions.feedback(architecture, original); await settled();
  assert.equal(saved.original, original);
  assert.equal(saved.expectedWorkspaceRevision, 2);
  assert.equal(h.state.command.commandId, "receipt-1");
  assert.equal(h.state.command.status, "waiting_host");
  assert.match(h.state.command.message, /等待/);
  await h.actions.verifyCommand();
  assert.ok(h.calls.some((call) => call.url.searchParams.get("commandId") === "receipt-1"));
});

test("a changed material hash cannot be appended to a previously read Unicode page", async (t) => {
  const h = harness(({ url }) => {
    if (url.pathname.endsWith("/material")) return reply({ artifactId: architecture.artifactId, version: 1, sha256: url.searchParams.has("cursor") ? "c".repeat(64) : architecture.sha256, text: url.searchParams.has("cursor") ? "WRONG" : "第一部分😀\n", totalBytes: 100, nextCursor: "opaque-next" });
    return reply(workspace());
  });
  t.after(() => h.controller.dispose());
  h.update(); await settled();
  await h.actions.loadMaterial(architecture, false);
  assert.equal(h.state.material.text, "第一部分😀\n");
  await h.actions.loadMaterial(architecture, true);
  assert.equal(h.state.material.text, "第一部分😀\n");
  assert.equal(h.state.material.conflict, true);
  assert.equal(workspaceMaterialReady(architecture, h.state.material), false);
  assert.doesNotMatch(h.state.material.text, /WRONG/);
});

test("a stale selection response cannot replace the current run", async (t) => {
  let resolveFirst;
  const h = harness(({ url }) => url.searchParams.get("runId") === "run"
    ? new Promise((resolve) => { resolveFirst = resolve; })
    : reply(workspace({ runId: "new-run" })));
  t.after(() => h.controller.dispose());
  h.update(); await settled();
  h.update("new-run"); await settled();
  resolveFirst(reply(workspace())); await settled();
  assert.equal(h.state.workspace.runId, "new-run");
  assert.equal(h.state.selection.runId, "new-run");
});

test("the next-action entry opens the bound PRD without inventing execution tasks", async (t) => {
  const beta = module("beta");
  const h = harness(({ url }) => url.pathname.endsWith("/material")
    ? reply({ artifactId: url.searchParams.get("artifactId"), version: 1, sha256: url.searchParams.get("artifactId") === architecture.artifactId ? architecture.sha256 : beta.sha256, text: "当前材料", nextCursor: null })
    : reply(workspace({ design: { version: 1, architecture, modules: [beta], totalModules: 1, nextCursor: null } })));
  t.after(() => h.controller.dispose());
  h.update(); await settled();
  h.actions.openNextAction({ kind: "awaiting_review", moduleId: null }); await settled();
  assert.equal(h.state.view, "prd");
  assert.equal(h.state.prdMode, "overview");
  assert.equal(h.state.material.identity, workspaceMaterialIdentity(architecture));
  h.actions.openNextAction({ kind: "design_module", moduleId: "beta" }); await settled();
  assert.equal(h.state.selectedModuleId, "beta");
  assert.equal(h.state.material.identity, workspaceMaterialIdentity(beta));
  assert.equal(h.state.tasks.length, 0);
});

test("a malformed refresh keeps the last valid workspace visible", async (t) => {
  let malformed = false;
  const h = harness(() => reply(malformed ? workspace({ reviews: "bad-shape" }) : workspace()));
  t.after(() => h.controller.dispose());
  h.update(); await settled();
  const valid = h.state.workspace;
  malformed = true; h.update(); await settled();
  assert.equal(h.state.workspace, valid);
  assert.ok(h.state.error);
});

test("review and feedback require a successfully read current page, while later-page failure preserves readiness", async (t) => {
  let initialFailure = true;
  const h = harness(({ url, method, body }) => {
    if (method === "POST") return reply({ commandId: "decision-1", nonce: JSON.parse(body).nonce, status: "recorded" });
    if (url.pathname.endsWith("/material")) {
      if (initialFailure) return reply({ message: "not found" }, 404);
      if (url.searchParams.has("cursor")) return reply({ message: "temporary page failure" }, 503);
      return reply({ artifactId: architecture.artifactId, version: 1, sha256: architecture.sha256, text: "\uFEFF首段😀", nextCursor: "next-page", totalBytes: 500, sourceState: "current" });
    }
    return reply(workspace());
  });
  t.after(() => h.controller.dispose());
  h.update(); await settled();
  h.actions.review(review(architecture), architecture, "accept");
  h.actions.feedback(architecture, "原文"); await settled();
  assert.equal(h.calls.filter((call) => call.method === "POST").length, 0);
  await h.actions.loadMaterial(architecture, false);
  assert.equal(workspaceMaterialReady(architecture, h.state.material), false);
  h.actions.review(review(architecture), architecture, "accept"); await settled();
  assert.equal(h.calls.filter((call) => call.method === "POST").length, 0);
  initialFailure = false;
  await h.actions.loadMaterial(architecture, false);
  assert.equal(h.state.material.text, "\uFEFF首段😀");
  assert.equal(workspaceMaterialReady(architecture, h.state.material), true);
  await h.actions.loadMaterial(architecture, true);
  assert.equal(h.state.material.text, "\uFEFF首段😀");
  assert.equal(workspaceMaterialReady(architecture, h.state.material), true);
  h.actions.review(review(architecture), architecture, "accept"); await settled();
  assert.equal(h.calls.filter((call) => call.method === "POST").length, 1);
});

test("private record history reaches beyond the overview page and survives polling until explicit revision refresh", async (t) => {
  let revision = 2;
  const records = () => Array.from({ length: revision === 2 ? 70 : 71 }, (_, index) => ({ commandId: "record-" + ((revision === 2 ? 70 : 71) - index), nonce: "n-" + index, status: "recorded", kind: "review" }));
  const h = harness(({ url }) => {
    if (url.pathname.endsWith("/requests")) {
      const offset = Number(url.searchParams.get("cursor") || 0);
      const all = records();
      return reply({ schemaVersion: "meta-kim-live-workspace-requests-v1", runId: "run", revision, requests: all.slice(offset, offset + 32), total: all.length, nextCursor: offset + 32 < all.length ? String(offset + 32) : null, order: "newest_first" });
    }
    return reply(workspace({ revision, requests: records().slice(0, 32), requestsTotal: records().length }));
  });
  t.after(() => h.controller.dispose());
  h.update(); await settled();
  h.actions.openRecords(); await settled();
  assert.equal(h.state.history.rows.length, 32);
  await h.actions.loadRecords(true); await settled();
  assert.equal(h.state.history.rows.length, 64);
  assert.equal(h.state.history.total, 70);
  assert.ok(h.state.history.rows.some((row) => row.commandId === "record-7"));
  h.update(); await settled();
  assert.equal(h.state.history.rows.length, 64);
  assert.equal(h.state.history.nextCursor, "64");
  revision = 3; h.update(); await settled();
  assert.equal(h.state.history.stale, true);
  assert.equal(h.state.history.rows.length, 64);
  const calls = h.calls.length;
  await h.actions.loadRecords(true);
  assert.equal(h.calls.length, calls);
  await h.actions.loadRecords(false); await settled();
  assert.equal(h.state.history.stale, false);
  assert.equal(h.state.history.revision, 3);
  assert.equal(h.state.history.rows[0].commandId, "record-71");
  assert.equal(h.state.history.total, 71);
});

test("a history cursor conflict preserves loaded records and exposes an explicit refresh", async (t) => {
  const h = harness(({ url }) => {
    if (url.pathname.endsWith("/requests")) return url.searchParams.has("cursor")
      ? reply({ error: "workspace_cursor_version_conflict" }, 409)
      : reply({ schemaVersion: "meta-kim-live-workspace-requests-v1", runId: "run", revision: 2, requests: [{ commandId: "kept", status: "recorded" }], total: 2, nextCursor: "opaque-next", order: "newest_first" });
    return reply(workspace());
  });
  t.after(() => h.controller.dispose());
  h.update(); await settled();
  h.actions.openRecords(); await settled();
  await h.actions.loadRecords(true);
  assert.equal(h.state.history.rows.length, 1);
  assert.equal(h.state.history.rows[0].commandId, "kept");
  assert.equal(h.state.history.stale, true);
  assert.match(h.state.history.error, /刷新记录/);
});

test("recorded mutations stay locked until the private overview confirms their receipt", async (t) => {
  let posted;
  let resolveOverview;
  const h = harness(({ url, method, body }) => {
    if (method === "POST") { posted = JSON.parse(body); return reply({ commandId: "acknowledged", nonce: posted.nonce, status: "recorded" }); }
    if (posted) return new Promise((resolve) => { resolveOverview = resolve; });
    return reply(workspace());
  });
  t.after(() => h.controller.dispose());
  h.update(); await settled();
  h.state.material = readMaterial(architecture);
  h.actions.review(review(architecture), architecture, "accept"); await settled();
  assert.equal(h.state.command.awaitingRefresh, true);
  assert.equal(h.state.command.busy, false);
  h.actions.feedback(architecture, "不能在旧版本继续提交"); await settled();
  assert.equal(h.calls.filter((call) => call.method === "POST").length, 1);
  resolveOverview(reply(workspace({ revision: 3, requests: [{ commandId: "acknowledged", nonce: posted.nonce, kind: "review", status: "recorded" }] })));
  await settled();
  assert.equal(h.state.workspace.revision, 3);
  assert.equal(h.state.command.awaitingRefresh, false);
});

test("capacity refusal is explicit, preserves the draft, and is not treated as uncertain completion", async (t) => {
  const h = harness(({ method }) => method === "POST" ? reply({ error: "workspace_request_capacity_reached" }, 413) : reply(workspace()));
  t.after(() => h.controller.dispose());
  h.update(); await settled();
  h.state.material = readMaterial(architecture);
  h.state.drafts.set("draft", "保留原文");
  h.actions.feedback(architecture, "保留原文"); await settled();
  assert.equal(h.state.command.status, "rejected");
  assert.match(h.state.command.message, /容量已满/);
  assert.equal(h.state.drafts.get("draft"), "保留原文");
  assert.equal(h.calls.filter((call) => call.url.pathname.endsWith("/requests")).length, 0);
});

// Minimal DOM storage for exercising the production renderer, without a browser
// or a second implementation of its presentation decisions.
function presentationHarness({ language = "zh", mode = "overview" } = {}) {
  class Element {
    constructor(tag = "div") { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = new Map(); this.hidden = false; this.scrollTop = 0; this.textContent = ""; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    addEventListener() {}
    querySelectorAll() { return []; }
  }
  const nodes = new Map();
  const doc = { createElement: (tag) => new Element(tag), activeElement: null };
  const root = new Element(); root.ownerDocument = doc;
  root.querySelector = (selector) => { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); };
  const fullVersion = "sha256:" + "0123456789abcdef".repeat(4);
  const outline = { ...architecture, version: fullVersion, summary: "完整系统的范围" };
  const detail = { ...module("alpha"), version: fullVersion, purpose: "模块负责的范围" };
  const state = { snapshot: { run: { title: "同一任务", task: "同一任务", status: "running" } }, project: { displayName: "项目" },
    workspace: workspace({ source: { version: fullVersion }, design: { architecture: outline, modules: [detail], totalModules: 1 }, reviews: [], stages: [] }),
    view: "prd", prdMode: mode, selectedModuleId: "alpha", drafts: new Map(), selectionKey: "project:run", language, tasks: [], canWrite: false };
  const selected = mode === "overview" ? outline : detail;
  state.material = { ...readMaterial(selected), text: "完整正文", totalBytes: 12, loadedBytes: 12 };
  const renderer = createLiveWorkspaceRenderer({ app: { querySelector: () => null }, root, state, copy: (key) => LIVE_WORKSPACE_MESSAGES[language][key] || key, actions: {} });
  return { state, renderer, fullVersion, node: (name) => root.querySelector("[data-uw-" + name + "]"), article: () => root.querySelector("[data-uw-content]").children[0] };
}

test("rendered version labels are compact while full material bindings and accessible titles remain exact", () => {
  const h = presentationHarness();
  const originalIdentity = workspaceMaterialIdentity(h.state.workspace.design.architecture);
  h.renderer.render();
  assert.ok(h.node("update").textContent.length < 45);
  assert.equal(h.node("update").title, h.fullVersion);
  const version = h.article().children[0].children.find((node) => node.className === "uw-version");
  assert.ok(version.textContent.length < 45);
  assert.equal(version.title, h.fullVersion);
  assert.equal(version.attributes.get("aria-label"), LIVE_WORKSPACE_MESSAGES.zh.version + " " + h.fullVersion);
  const body = h.article().children.find((node) => node.className === "uw-document-body");
  assert.equal(body.dataset.version, h.fullVersion);
  assert.equal(workspaceMaterialIdentity(h.state.workspace.design.architecture), originalIdentity);
  h.state.workspace.source.version = "release-2026.11-beta";
  h.renderer.render();
  assert.match(h.node("update").textContent, /release-2026\.11-beta/);
});

test("rendered overview suppresses only a subtitle equal to its title and restores a distinct next action", () => {
  const h = presentationHarness();
  h.renderer.render();
  assert.equal(h.node("next").hidden, true);
  h.state.snapshot.run.task = "请审阅新的系统边界";
  h.renderer.render();
  assert.equal(h.node("next").hidden, false);
  assert.equal(h.node("next").textContent, "请审阅新的系统边界");
});

test("rendered module summaries use module-specific headings in all four languages", () => {
  for (const [language, expected] of Object.entries({ zh: "模块说明", en: "Module summary", ja: "モジュール概要", ko: "모듈 설명" })) {
    const h = presentationHarness({ language, mode: "module" });
    h.renderer.render();
    assert.equal(h.article().children[1].children[0].textContent, expected, language);
    h.state.prdMode = "overview";
    h.renderer.render();
    assert.equal(h.article().children[1].children[0].textContent, LIVE_WORKSPACE_MESSAGES[language].overview, language);
  }
});

for (const [language, expected] of Object.entries({
  en: { outline: "Review the current system outline", module: "Review module: {module}", design: "Continue detailed design: {module}",
    reviseOutline: "Recheck or revise the system outline", reviseModule: "Revise or recheck module: {module}",
    continue: "Designs are adopted. The current host completes the design gate and continues the workflow.",
    register: "Read the existing design. The current host must register it before human review.",
    refresh: "The material changed. Ask the current host to register its current version.",
    feedback: "Feedback recorded; awaiting the current host." },
  ja: { outline: "現在のシステム概要を確認してください", module: "モジュールを確認：{module}", design: "詳細設計を続ける：{module}",
    reviseOutline: "システム概要を再確認または修正してください", reviseModule: "モジュールを修正または再確認：{module}",
    continue: "設計はすべて採用済みです。現在のホストが設計段階を完了し、ワークフローを続行します。",
    register: "既存の設計を閲覧できます。人による審査の前に、現在のホストが登録する必要があります。",
    refresh: "資料が変更されました。現在のホストに最新版の登録を依頼してください。",
    feedback: "修正意見を記録しました。現在の実行ホストによる対応待ちです。" },
  ko: { outline: "현재 시스템 개요를 검토해 주세요", module: "모듈 검토: {module}", design: "상세 설계 계속: {module}",
    reviseOutline: "시스템 개요를 다시 확인하거나 수정해 주세요", reviseModule: "모듈 수정 또는 재확인: {module}",
    continue: "모든 설계가 채택되었습니다. 현재 실행기가 설계 단계를 마무리하고 워크플로를 계속합니다.",
    register: "기존 설계는 읽을 수 있습니다. 사람의 검토를 시작하려면 현재 실행기가 먼저 등록해야 합니다.",
    refresh: "자료가 변경되었습니다. 현재 실행기에 최신 버전 등록을 요청해 주세요.",
    feedback: "수정 의견이 기록되었습니다. 현재 실행기의 처리를 기다립니다." },
})) {
  test(`rendered ${language} system next steps are localized while business text and unknown actions remain exact`, () => {
    const h = presentationHarness({ language });
    h.state.view = "work"; h.state.query = ""; h.state.taskFilter = "all";
    h.state.snapshot.run.task = "";
    h.state.workspace.stages = [{ id: "thinking", label: "Thinking", summary: "业务原文不翻译" }];
    h.state.detail = { kind: "stage", id: "thinking" };
    const moduleTitle = "付款 $& {module} 🚀";
    h.state.workspace.design.modules[0].title = moduleTitle;
    const scenarios = [
      ["awaiting_review", null, expected.outline], ["awaiting_review", "alpha", expected.module],
      ["design_module", "alpha", expected.design], ["revise_outline", null, expected.reviseOutline],
      ["revise_module", "alpha", expected.reviseModule], ["continue_governed_run", null, expected.continue],
      ["register_design_review", null, expected.register], ["refresh_design_material", null, expected.refresh],
      ["apply_feedback", "alpha", expected.feedback],
      ["future_business_action", null, "请审阅当前系统模块大纲"], ["constructor", null, "请审阅当前系统模块大纲"],
    ];
    for (const [kind, moduleId, template] of scenarios) {
      h.state.workspace.nextAction = { kind, moduleId, summary: "请审阅当前系统模块大纲" };
      const before = JSON.stringify(h.state.workspace);
      const message = template.replace("{module}", () => moduleTitle);
      h.renderer.render();
      assert.equal(h.article().children[1].textContent, message, kind + " work card");
      assert.equal(h.node("next").textContent, message, kind + " overview");
      assert.equal(h.node("detail-body").children.at(-1).children[1].textContent, message, kind + " stage detail");
      assert.equal(h.node("detail-body").children[1].children[1].textContent, "业务原文不翻译");
      assert.equal(JSON.stringify(h.state.workspace), before, "presentation does not mutate the authoritative data");
    }
    h.state.workspace.nextAction = { kind: "design_module", moduleId: "unloaded-module", summary: "中文摘要" };
    h.renderer.render();
    assert.equal(h.article().children[1].textContent, expected.design.replace("{module}", "unloaded-module"));
    h.state.workspace.design.architecture.status = "expired";
    h.state.workspace.nextAction = { kind: "awaiting_review", moduleId: null, summary: "系统模块大纲需要重新核对或修订" };
    h.renderer.render();
    assert.equal(h.article().children[1].textContent, expected.reviseOutline, "expired material still calls for rechecking");
    h.state.snapshot.run.task = "用户自己写的任务正文";
    h.renderer.render();
    assert.equal(h.node("next").textContent, "用户自己写的任务正文", "business subtitle retains its original text");
  });
}

test("record timeline displays the actual bounded file and immutable receipt hashes", () => {
  const h = presentationHarness();
  h.state.view = "records"; h.state.recordPage = 0; h.state.pageSize = 10;
  h.state.history = { rows: [], total: 1, revision: 2 };
  h.state.workspace.requests = [{ commandId: "actual-receipt", status: "host_reported", kind: "feedback",
    summary: "Host supplied file evidence", receipt: { ref: ".meta-kim/work/receipt.json", sha256: "a".repeat(64),
      evidenceRefs: [{ ref: "outputs/module.md", sha256: "b".repeat(64) }], evidenceOmitted: 2 } }];
  h.renderer.render();
  const texts = node => [node.textContent, ...node.children.flatMap(texts)].join("\n");
  const rendered = texts(h.node("content"));
  assert.match(rendered, /outputs\/module\.md/u);
  assert.match(rendered, /\.meta-kim\/work\/receipt\.json/u);
  assert.ok(rendered.includes("a".repeat(64)) && rendered.includes("b".repeat(64)));
  assert.ok(rendered.includes(LIVE_WORKSPACE_MESSAGES.zh.evidenceMore.replace("{count}", "2")));
});
