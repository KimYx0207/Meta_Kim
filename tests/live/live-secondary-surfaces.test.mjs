import test from "node:test";
import assert from "node:assert/strict";
import { renderLiveControlRoomPage } from "../../src/presentation/live/live-control-room-page.mjs";

const html = renderLiveControlRoomPage();

function helper(name) {
  const start = html.indexOf("  function " + name + "(");
  assert.ok(start >= 0, name + " must be shipped");
  const end = Math.min(...["\n  function ", "\n  async function "].map((prefix) => html.indexOf(prefix, start + 1)).filter((index) => index > start));
  return html.slice(start, end);
}

function element(tag, className = "", text = "") {
  return {
    tag, className, text, children: [], dataset: {}, listeners: {},
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this[name] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
  };
}

const clearChildren = (target) => { if (target) target.children = []; };
const usefulNodeMeta = (value) => typeof value === "string" && value.trim() && !["unknown", "unavailable", "—"].includes(value);
const allText = (target) => [target.text, ...target.children.map(allText)].join(" ");

test("repository shows observed facts and one honest empty message instead of missing-field rows", () => {
  const repositoryFacts = element("div");
  const api = new Function("deps", `
    const { repositoryFacts, makeElement, clearChildren, usefulNodeMeta } = deps;
    const currentLanguage = "zh", repositoryTitle = null, repositoryBoundary = null, repositorySessions = null;
    const projectForSelection = () => ({ displayName: "Meta_Kim", sessions: [] });
    const setText = () => {};
    const localize = (value) => value;
    const sessionGroups = () => ({ ordered: [], foreground: [], background: [] });
    ${helper("appendOperationalRow")}
    ${helper("renderRepositoryView")}
    return renderRepositoryView;
  `)({ repositoryFacts, makeElement: element, clearChildren, usefulNodeMeta });
  api({ repository: { branch: { state: "unavailable", summary: "Branch unavailable" } } });
  assert.equal(repositoryFacts.children.length, 1);
  assert.equal(allText(repositoryFacts).trim(), "此记录没有仓库信息");
  api({ repository: {
    branch: { state: "observed", summary: "codex/current" },
    worktree: { state: "unavailable", summary: "Worktree unavailable" },
  } });
  assert.equal(repositoryFacts.children.length, 1);
  assert.equal(repositoryFacts.children[0].dataset.state, "observed");
  assert.match(allText(repositoryFacts), /codex\/current/u);
  assert.doesNotMatch(allText(repositoryFacts), /Unavailable|unavailable|没有仓库/u);
});

test("run rows keep selection and independently expandable identities without nested controls", () => {
  const sessionList = element("div");
  const selections = [];
  const api = new Function("deps", `
    const { sessionList, makeElement, clearChildren, selections } = deps;
    const expandedSessionRecords = new Set();
    const currentLanguage = "zh", selectedProjectId = "project", selectedRunId = "run-current";
    let showUnlinkedSessions = false, sessionSearchQuery = "";
    const sessionGroups = (sessions) => ({ ordered: sessions });
    const sessionIsForeground = () => true;
    const sessionDisplayTitle = (session) => session.title;
    const sessionRecordOrigin = () => "governed_run";
    const sessionOriginCopy = () => "";
    const sourceRuntimeLabel = () => "Codex";
    const conversationLinkCopyFor = () => "已确认关联";
    const conversationChatIdentityCopy = () => "聊天 chat-full-123";
    const conversationChatIdentityValue = () => "chat-full-123";
    const sessionTimeCopy = () => ({ text: "10/27 03:22", hint: "recorded timestamp" });
    const sessionShortId = (session) => session.runId;
    const formatSessionTime = () => "10/27 03:22";
    const informativeValue = (value, absent) => value || absent;
    const localize = (value) => value;
    const switchSelection = (...args) => selections.push(args);
    ${helper("renderSessionCards")}
    return renderSessionCards;
  `)({ sessionList, makeElement: element, clearChildren, selections });
  const sessions = [{ runId: "run-current", title: "修复界面布局", active: true, currentStage: "execution", workerCount: 9, eventCount: 114 }];
  api(sessions);
  let row = sessionList.children.find((item) => item.className === "session-card");
  assert.equal(row.tag, "article");
  const open = row.children.find((item) => item.className === "session-card-open");
  const details = row.children.find((item) => item.tag === "details");
  assert.equal(open.tag, "button");
  assert.equal(details.open, false);
  assert.match(allText(open), /修复界面布局.*10\/27 03:22.*Codex/u);
  assert.doesNotMatch(allText(open), /114|chat-full|已确认关联/u);
  assert.match(allText(details), /114.*chat-full-123/u);
  open.listeners.click();
  assert.deepEqual(selections[0], ["project", "run-current", { updateUrl: true }]);
  details.open = true;
  details.listeners.toggle();
  api(sessions);
  row = sessionList.children.find((item) => item.className === "session-card");
  assert.equal(row.children.find((item) => item.tag === "details").open, true, "catalog refresh must preserve the expanded row");
});

test("session information omits unknown values and empty diagnostic categories", () => {
  const infoFacts = element("div");
  const api = new Function("deps", `
    const { infoFacts, makeElement, clearChildren, usefulNodeMeta } = deps;
    const currentLanguage = "zh", localize = (value) => value, display = (value) => value;
    ${helper("renderSessionInfo")}
    return renderSessionInfo;
  `)({ infoFacts, makeElement: element, clearChildren, usefulNodeMeta });
  api({ sessionInfo: {}, nodes: [], replay: [], evidence: [] });
  assert.equal(allText(infoFacts).trim(), "此记录没有更多会话信息。");
  api({ sessionInfo: { runtime: "Codex", workerCount: 2 }, nodes: [], replay: [{}], evidence: [] });
  assert.match(allText(infoFacts), /Codex.*2 个执行者.*1 条活动/u);
  assert.doesNotMatch(allText(infoFacts), /undefined|null|NaN|快照|Snapshots|Terminal/u);
  api({ sessionInfo: { lastPromptSummary: "Prompt summary withheld" }, nodes: [{ loadout: { tools: 5 } }], replay: [], evidence: [] });
  assert.match(allText(infoFacts), /5 工具.*未记录可显示的提示词摘要/u);
  assert.doesNotMatch(allText(infoFacts), /0 |skills|commands|Prompt summary withheld/u);
  api({ sessionInfo: { fileChangeCount: null, artifactCount: 2, blockedCount: 1 }, nodes: [], replay: [], evidence: [] });
  assert.match(allText(infoFacts), /2 个产出.*1 项受阻/u);
  assert.doesNotMatch(allText(infoFacts), /文件快照|项失败|undefined|null/u);
  api({ sessionInfo: { fileChangeCount: 0, artifactCount: 2, failedCount: 0, blockedCount: 1 }, nodes: [], replay: [], evidence: [] });
  assert.match(allText(infoFacts), /0 个文件快照.*2 个产出.*0 项失败.*1 项受阻/u);
  api({ sessionInfo: { fileChangeCount: -1, artifactCount: 2.5, failedCount: "0" }, nodes: [], replay: [], evidence: [] });
  assert.equal(allText(infoFacts).trim(), "此记录没有更多会话信息。", "only recorded non-negative safe integers may become count facts");
});

test("ordinary run row metadata uses the real Chinese dictionary and reports the state once", () => {
  const literal = html.match(/const zhText = new Map\(Object\.entries\((\{[\s\S]*?\})\)\);/u);
  assert.ok(literal);
  const dictionary = new Map(Object.entries(new Function("return " + literal[1])()));
  for (const [source, translated] of [
    ["Conversation transcript unavailable for this selection.", "此任务没有可查看的对话记录。"],
    ["Diff telemetry unavailable for this selection.", "此任务没有代码变更记录。"],
    ["Terminal adapter telemetry unavailable for this selection.", "此任务没有工具执行记录。"],
    ["No context transfer records are available for this selection.", "此任务没有上下文交接记录。"],
    ["executed", "已执行"],
    ["native observed", "原生运行观察"],
    ["native execution observed; task acceptance unproven", "已观察到执行，任务结果尚未验收"],
    ["Prompt summary", "提示词摘要"],
  ]) assert.equal(dictionary.get(source), translated);
  const rowMeta = new Function("zhText", `
    const currentLanguage = "zh";
    const display = (value, fallback = "") => value === null || value === undefined ? fallback : String(value);
    const informativeValue = (value, absent) => value || absent;
    const formatSessionTime = () => "10/27 03:22";
    ${helper("localize")}
    ${helper("stateCopy")}
    ${helper("sessionStateCopy")}
    ${helper("sessionRowMeta")}
    return sessionRowMeta;
  `)(dictionary);
  const completed = rowMeta({ active: false, displayState: "completed", currentStage: "Execution" });
  assert.equal(completed, "已完成 · 执行 · 10/27 03:22");
  const active = rowMeta({ active: true, displayState: "active", currentStage: "Execution" });
  assert.equal(active, "进行中 · 执行 · 10/27 03:22");
  assert.doesNotMatch(active + completed, /Running|Completed|Observed run/u);
});

test("inspector keeps reading content visible and long diagnostics in a closed disclosure", () => {
  const technical = html.match(/<details class="selected-node-technical">([\s\S]*?)<\/details>/u);
  assert.ok(technical, "diagnostics must be available through a native keyboard-accessible disclosure");
  assert.doesNotMatch(technical[0], /<details[^>]*\sopen(?:\s|>)/u);
  for (const marker of ["runtime", "model", "duration", "tools", "tokens", "relations", "evidence-detail", "provenance", "prompt", "loadout"]) {
    assert.match(technical[1], new RegExp("data-live-selected-node-" + marker, "u"));
  }
  const panelStart = html.indexOf('<div class="inspector-panel" id="inspector-panel-summary"');
  const panelEnd = html.indexOf('<div class="inspector-panel evidence-drawer"', panelStart);
  assert.ok(panelStart >= 0 && panelEnd > panelStart);
  const panel = html.slice(panelStart, panelEnd);
  const readingContent = panel.replace(technical[0], "");
  assert.match(readingContent, /data-live-selected-node-label/u);
  assert.match(readingContent, /data-live-selected-node-status/u);
  assert.match(readingContent, /data-live-selected-node-summary/u);
  assert.match(readingContent, /data-live-selected-node-state-note/u);
  assert.doesNotMatch(readingContent, /data-live-selected-node-relations/u);
  assert.match(readingContent, /data-live-feedback-host/u);
});

test("inspector duration distinguishes missing observations from a real zero", () => {
  const duration = new Function("usefulNodeMeta", `
    const DISPLAY_FORMAT = { emptyPlaceholder: "—" };
    const display = (value, fallback = "") => value === null || value === undefined ? fallback : String(value);
    ${helper("formatDuration")}
    ${helper("inspectorNodeDuration")}
    return inspectorNodeDuration;
  `)(usefulNodeMeta);
  const at = "2026-10-27T03:22:00.000Z";
  assert.equal(duration({ executionState: "executing", firstAt: at, lastAt: at }), "");
  assert.equal(duration({ executionState: "unreported", firstAt: at, lastAt: at }), "");
  assert.equal(duration({ executionState: "executing", durationMs: 0 }), "0 ms", "an explicitly reported zero is real data");
  assert.equal(duration({ executionState: "executed", firstAt: at, lastAt: at }), "0 ms", "a finished observed zero interval remains visible");
  assert.equal(duration({ executionState: "executed", firstAt: "", lastAt: at }), "");
  assert.equal(duration({ executionState: "executed", firstAt: at, lastAt: "2026-10-26T03:22:00.000Z" }), "");
  assert.equal(duration({ durationMs: 1.25 }), "1.25 ms");
  assert.equal(duration({ durationMs: 1500 }), "2 s");
});

test("empty inspector outputs use one honest line while available files remain actionable", () => {
  const parent = element("div");
  const render = new Function("makeElement", `
    const currentLanguage = "zh";
    const liveDeliverablesForNode = (items) => items;
    const deliverableOpenHref = (item) => "/api/deliverable?id=" + item.id;
    const observeDeliverableRead = () => {};
    ${helper("appendLiveDeliverables")}
    return appendLiveDeliverables;
  `)(element);
  render(parent, { run: { id: "run" }, deliverables: [] }, null, { compactEmpty: true });
  assert.equal(parent.children.length, 1);
  assert.match(allText(parent), /未附可打开的文件.*不代表已通过验收/u);
  clearChildren(parent);
  render(parent, { run: { id: "run" }, deliverables: [{ id: "file", label: "结果文件", availability: "available" }] }, null, { compactEmpty: true });
  assert.equal(parent.children[0].children[0].tag, "a");
  assert.equal(parent.children[0].children[0].href, "/api/deliverable?id=file");
  assert.match(allText(parent), /结果文件.*仍需核对结果/u);
});
