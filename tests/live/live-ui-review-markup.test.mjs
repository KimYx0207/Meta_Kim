import test from "node:test";
import assert from "node:assert/strict";
import { renderLiveWorkspaceSurface } from "../../src/presentation/live/live-workspace-view.mjs";
import { LIVE_WORKSPACE_CSS } from "../../src/presentation/live/live-workspace-styles.mjs";
import { translateAgentUi } from "../../src/presentation/live/live-agent-copy.mjs";

// The page ships static markup and one stylesheet; these checks read them the
// way the browser receives them. Rules are matched per CSS block, not per line.
const cssBlocks = () => LIVE_WORKSPACE_CSS.split("}").map((block) => block.trim()).filter(Boolean);
const blocksFor = (selectorFragment) => cssBlocks().filter((block) => block.split("{")[0].includes(selectorFragment));

test("review #1: the five-step and eight-stage views sit inside one collapsed details block", () => {
  const html = renderLiveWorkspaceSurface();
  const details = html.match(/<details class="uw-run-details"[^>]*>[\s\S]*?<\/details>\s*<\/details>|<details class="uw-run-details"[^>]*>[\s\S]*?<\/details>/u)?.[0] || "";
  assert.ok(details, "A details block wraps the raw progress views");
  assert.doesNotMatch(details.slice(0, details.indexOf(">")), /\sopen\b/u, "Collapsed by default");
  assert.match(details, /data-uw-phases/u, "The five-step strip is inside");
  assert.match(details, /data-uw-stages/u, "The eight-stage strip is inside");
  assert.doesNotMatch(html, /五步治理进度<\/strong>/u, "No second progress heading competes with the six steps");
});

test("review #21: the progress ribbon is laid out on every page, not only the work view", () => {
  const shown = blocksFor(".uw-top-flow-ribbon").filter((block) => /display:\s*flex/u.test(block));
  assert.ok(shown.length >= 1, "A rule lays the ribbon out");
  for (const block of shown) assert.doesNotMatch(block.split("{")[0], /data-work-view/u, "The ribbon is not tied to one view");
  const rows = blocksFor(":has(> .uw-top-flow-ribbon:not(:empty))").filter((block) => /grid-template-rows/u.test(block));
  assert.ok(rows.length >= 1);
  for (const block of rows) assert.doesNotMatch(block.split("{")[0], /data-work-view/u, "Every view reserves the ribbon row");
});

test("review #17: the edge ⊕ stays hidden until its edge is hovered or the ⊕ has keyboard focus", () => {
  const base = blocksFor(".uw-wf-edge-plus").find((block) => block.split("{")[0].trim() === ".uw-wf-edge-plus");
  assert.ok(base, "A base rule exists");
  assert.match(base, /opacity:\s*0(?![.\d])/u, "Hidden by default");
  const reveal = cssBlocks().filter((block) => /opacity:\s*1\b/u.test(block) && block.split("{")[0].includes(".uw-wf-edge-plus"));
  const selectors = reveal.map((block) => block.split("{")[0]).join(",");
  assert.match(selectors, /\.uw-wf-edge-g:hover \.uw-wf-edge-plus/u, "Hovering the edge reveals it");
  assert.match(selectors, /\.uw-wf-edge-plus:focus-visible/u, "Keyboard focus reveals it");
  assert.ok(blocksFor(".uw-wf-edge-hit").some((block) => /pointer-events:\s*stroke/u.test(block)), "The transparent band catches the hover");
});

test("review #8: the page title names Meta_Kim once and leads with any other project", async () => {
  const { liveDocumentTitle } = await import("../../src/presentation/live/live-ui-copy.mjs");
  const { renderLiveControlRoomPage } = await import("../../src/presentation/live/live-control-room-page.mjs");
  assert.equal(typeof liveDocumentTitle, "function");
  assert.equal(liveDocumentTitle("Meta_Kim"), "Meta_Kim");
  assert.equal(liveDocumentTitle(""), "Meta_Kim");
  assert.equal(liveDocumentTitle("Kim Digital Human"), "Kim Digital Human · Meta_Kim");
  const html = renderLiveControlRoomPage();
  assert.match(html, /<title>Meta_Kim<\/title>/u);
  assert.doesNotMatch(html, /Meta_Kim Live · 控制中心/u);
  assert.match(html, /document\.title = liveDocumentTitle\(/u, "The shipped page applies the same rule");
});

const INTERNAL_WORDS = ["已载入快照", "双向绑定", "宿主", "渠道", "未收到执行回写", "仅结构化证据", "经验沉淀", "未配置生图模型", "Main governed run", "worker task"];

test("review #12: the shipped workspace markup carries none of the internal words", async () => {
  const { renderLiveWorkspaceNavigation } = await import("../../src/presentation/live/live-workspace-view.mjs");
  const html = renderLiveWorkspaceSurface() + renderLiveWorkspaceNavigation();
  assert.deepEqual(INTERNAL_WORDS.filter((word) => html.includes(word)), []);
});

function shippedZhLocalize(html) {
  const helper = (name) => {
    const start = html.indexOf("  function " + name + "(");
    assert.ok(start >= 0, name + " is shipped");
    return html.slice(start, html.indexOf("\n  function ", start + 1));
  };
  const zhStart = html.indexOf("  const zhText = new Map(Object.entries({");
  const zhSource = html.slice(zhStart, html.indexOf("}));", zhStart) + 4);
  return new Function(`const currentLanguage = "zh"; const LIVE_UI_COPY = { ja: {} }; const translateLiveUiCopy = (value) => value;
const DISPLAY_FORMAT = { emptyPlaceholder: "" };
${zhSource}
${helper("display")}
${helper("localize")}
return localize;`)();
}

test("review #12/#15: the Chinese page turns record sentences into plain Chinese without mixing languages", async () => {
  const { renderLiveControlRoomPage } = await import("../../src/presentation/live/live-control-room-page.mjs");
  const localize = shippedZhLocalize(renderLiveControlRoomPage());
  assert.equal(localize("Snapshot loaded"), "已读取最新进度");
  assert.equal(localize("structural evidence only"), "只有结构记录，还没有运行结果");
  assert.equal(localize("Evolution"), "总结经验");
  assert.equal(localize("Main governed run owner · 修复界面"), "主任务负责人 · 修复界面");
  assert.equal(localize("1 worker task · declared route"), "1 个 worker 任务 · 按计划路线");
  assert.equal(localize("3 worker tasks · declared route"), "3 个 worker 任务 · 按计划路线");
  assert.equal(localize("Execution lanes"), "执行分组");
  assert.equal(localize("Workflow lane 2"), "工作线 2");
  assert.equal(localize("Run · opened"), "Run 已开启");
  assert.equal(localize("Execution lanes · queued"), "执行分组 已排队");
  assert.equal(localize("observed · 3 evidence"), "已观测 · 3 条证据");
  assert.equal(localize("planned · 2 evidence"), "计划 · 2 条证据");
});

test("review #16: the chat bar button that opens the run records is named 运行记录", () => {
  const html = renderLiveWorkspaceSurface();
  const button = html.match(/<button[^>]*data-uw-chat-switch-repo[^>]*>([^<]*)<\/button>/u);
  assert.equal(button?.[1], "运行记录 ▾");
  assert.doesNotMatch(html, /切换仓库 ▾/u);
});

test("review #14: a shown time is local month/day hour:minute, never the raw ISO string", async () => {
  const { formatLiveTime } = await import("../../src/presentation/live/live-ui-copy.mjs");
  assert.equal(typeof formatLiveTime, "function");
  const at = "2026-11-18T23:20:53.394Z";
  const local = new Date(at);
  const two = (n) => String(n).padStart(2, "0");
  assert.equal(formatLiveTime(at, "zh"), `${two(local.getMonth() + 1)}/${two(local.getDate())} ${two(local.getHours())}:${two(local.getMinutes())}`);
  for (const language of ["en", "ja", "ko"]) assert.doesNotMatch(formatLiveTime(at, language), /T\d|Z|\.\d{3}/u);
  assert.equal(formatLiveTime("not a time", "zh"), "");
  assert.equal(formatLiveTime(null, "zh"), "");
});

test("review #9: the run graph explains structural ownership once in its legend, not on every card", async () => {
  const { renderLiveControlRoomPage } = await import("../../src/presentation/live/live-control-room-page.mjs");
  const html = renderLiveControlRoomPage();
  const legend = html.match(/class="graph-edge-legend" data-i18n-en="([^"]*)" data-i18n-zh="([^"]*)"/u);
  assert.ok(legend, "The legend exists");
  assert.match(legend[2], /结构归属不代表所有任务同时执行/u);
  assert.match(legend[1], /does not mean every task runs at once/u);
  assert.doesNotMatch(html, /结构归属关系 · 不代表所有任务同时执行/u, "No card repeats it");
  assert.match(html, /localize\("observed · " \+ node\.evidenceCount \+ " evidence"\)/u, "A card's evidence phrase goes through the language helper");
});

test("review #10: repositories with runs or recent use come first, the rest fold away, names are deduplicated and searchable", async () => {
  const { organizeRepositoryCatalog, serializeLiveWorkspaceModel } = await import("../../src/presentation/live/live-workspace-model.mjs");
  const now = Date.parse("2026-11-19T12:00:00Z");
  const day = 24 * 3600 * 1000;
  const project = (projectId, displayName, sessionCount, ageDays) => ({ projectId, displayName, sessionCount,
    sessions: ageDays === null ? [] : [{ runId: projectId + "-run", updatedAt: new Date(now - ageDays * day).toISOString() }] });
  const catalog = [
    project("p-old", "old-tool", 0, 90),
    project("p-meta", "Meta_Kim", 3, 1),
    project("p-kdh", "Kim Digital Human", 5, 0.2),
    project("p-recent", "recent-sketch", 0, 2),
    project("p-dup-a", "ashare-quant-lab", 2, 5),
    project("p-dup-b", "ashare-quant-lab", 0, 40),
    project("p-empty", "draft-1234abcd", 0, null),
    { projectId: "p-foreign", displayName: "foreign-only", sessionCount: 0,
      sessions: [{ runId: "p-foreign-run", updatedAt: new Date(now - 0.1 * day).toISOString(), attribution: "unattributed" }] },
  ];
  const view = organizeRepositoryCatalog(catalog, { selectedProjectId: "p-meta", now });
  assert.equal(view.total, 7, "Two entries with one name collapse into one");
  assert.deepEqual(view.front.map((item) => item.projectId), ["p-meta", "p-kdh", "p-dup-a", "p-recent"],
    "Selected first, then runs and recent use by latest activity");
  assert.deepEqual(view.rest.map((item) => item.projectId).sort(), ["p-empty", "p-foreign", "p-old"],
    "A run recorded in another folder does not make a repository look recently used");
  const searched = organizeRepositoryCatalog(catalog, { selectedProjectId: "p-meta", now, query: "OLD" });
  assert.deepEqual([...searched.front, ...searched.rest].map((item) => item.projectId), ["p-old"], "Search covers folded repositories");
  assert.match(serializeLiveWorkspaceModel(), /function organizeRepositoryCatalog\(/u, "The page receives the same helper");
});

test("review #10: the repository page uses the ordering helper, a search box and a fold for the rest", async () => {
  const { serializeLiveWorkspaceClient } = await import("../../src/presentation/live/live-workspace-client.mjs");
  const client = serializeLiveWorkspaceClient();
  assert.match(client, /organizeRepositoryCatalog\(allCatalog/u);
  assert.match(client, /显示其余 \$\{repoGroups\.rest\.length\} 个/u);
  assert.match(client, /search\.placeholder = "搜索仓库名"/u);
});

const dialogMarkup = (html, marker) => {
  const start = html.indexOf(`<section class="live-dialog" data-live-dialog ${marker}`);
  return start < 0 ? "" : html.slice(start, html.indexOf("</section>", start) + "</section>".length);
};

test("review #11: the i dialog speaks plainly and folds the export tools under 开发者工具", async () => {
  const { renderLiveControlRoomPage } = await import("../../src/presentation/live/live-control-room-page.mjs");
  const dialog = dialogMarkup(renderLiveControlRoomPage(), "data-live-info-dialog");
  assert.match(dialog, /data-i18n-zh="这个 Run 的概况"/u);
  assert.doesNotMatch(dialog, /会话信息与本地工具|本地观察器/u);
  const dev = dialog.match(/<details class="info-dev-tools">([\s\S]*?)<\/details>/u);
  assert.ok(dev, "Developer tools are folded and closed by default");
  assert.match(dev[1], /开发者工具/u);
  assert.match(dev[1], /data-live-info-tools/u, "Export JSON, PR card and README embed live inside");
  assert.match(dev[1], /data-live-info-tech-facts/u, "Technical facts live inside");
});

test("review #11: the ? dialog explains each page and B1–B4 before the shortcuts", async () => {
  const { renderLiveControlRoomPage } = await import("../../src/presentation/live/live-control-room-page.mjs");
  const dialog = dialogMarkup(renderLiveControlRoomPage(), "data-live-help-dialog");
  const guide = dialog.indexOf("help-guide");
  assert.ok(guide > 0 && guide < dialog.indexOf("shortcut-grid"), "The guide comes before the shortcuts");
  for (const page of ["工作", "PRD", "仓库", "记录", "运行图"]) assert.match(dialog, new RegExp(`data-i18n-zh="${page}：`, "u"), page);
  for (const gate of ["B1", "B2", "B3", "B4"]) assert.match(dialog, new RegExp(`data-i18n-zh="${gate}：`, "u"), gate);
});

test("review #11: technical run facts go to the developer section, plain facts stay in view", async () => {
  const { renderLiveControlRoomPage } = await import("../../src/presentation/live/live-control-room-page.mjs");
  const html = renderLiveControlRoomPage();
  const start = html.indexOf("  function renderSessionInfo(");
  const helper = html.slice(start, html.indexOf("\n  function ", start + 1));
  const holder = () => ({ children: [], append(...items) { this.children.push(...items); } });
  const infoFacts = holder();
  const infoTechFacts = holder();
  const render = new Function("infoFacts", "infoTechFacts", `const currentLanguage = "zh"; const localize = (value) => value; const display = (value) => String(value);
const usefulNodeMeta = (value) => value !== undefined && value !== null && value !== "";
const clearChildren = (node) => { node.children = []; };
const makeElement = (tag, className, text) => ({ tag, className, textContent: text ?? "", children: [], append(...items) { this.children.push(...items); } });
${helper}
return renderSessionInfo;`)(infoFacts, infoTechFacts);
  render({ sessionInfo: { mode: "governed", runtime: "claude", workerCount: 2, proofState: "structural_only" }, nodes: [], replay: [{}], evidence: [] });
  const labels = (node) => node.children.map((row) => row.children?.[0]?.textContent).filter(Boolean);
  assert.deepEqual(labels(infoTechFacts).sort(), ["Mode", "Proof", "Runtime"]);
  assert.ok(labels(infoFacts).includes("Workers"));
  assert.ok(!labels(infoFacts).some((label) => ["Mode", "Runtime", "Proof", "Loadout"].includes(label)));
});

const exactBlock = (selector) => cssBlocks().find((block) => block.split("{")[0].trim() === selector) || "";

test("review #18: the default split gives the canvas more room than the chat", () => {
  const rule = exactBlock('.uw-workspace[data-agent-entry-enabled="true"][data-view="work"]:has(> .uw-agent-entry > .uw-agent-chat)');
  assert.match(rule, /grid-template-columns:\s*minmax\(320px, var\(--uw-chat-share, 36%\)\) 6px minmax\(420px, 1fr\)/u);
});

test("review #19: the Run binding chip appears only on hover or keyboard focus and takes no space", () => {
  assert.match(exactBlock(".uw-agent-live-header"), /height:\s*0/u);
  const chip = exactBlock(".uw-agent-live-source");
  assert.match(chip, /opacity:\s*0(?![.\d])/u);
  assert.match(chip, /pointer-events:\s*none/u);
  const reveal = cssBlocks().filter((block) => block.split("{")[0].includes(".uw-agent-live-source") && /opacity:\s*1\b/u.test(block))
    .map((block) => block.split("{")[0]).join(",");
  assert.match(reveal, /:hover/u);
  assert.match(reveal, /:focus-within/u);
});

test("review #22: PRD body text matches the left column and the run title is not oversized", () => {
  assert.match(exactBlock(".uw-document-body p, .uw-document-body li"), /font-size:\s*var\(--fs-label\)/u);
  const title = exactBlock('.shell[data-work-view="workspace"] .uw-overview h1');
  assert.doesNotMatch(title, /--fs-hero/u);
  assert.match(title, /font-size:\s*var\(--fs-view-title\)/u);
});

test("review #23: the language picker is one bordered control with its arrow inside", async () => {
  const { renderLiveControlRoomPage } = await import("../../src/presentation/live/live-control-room-page.mjs");
  const rule = renderLiveControlRoomPage().match(/\.topbar-button\[data-live-language-select\] \{[^}]*\}/u)?.[0] || "";
  assert.match(rule, /appearance:\s*none/u);
  assert.match(rule, /border:\s*1px solid/u);
  assert.match(rule, /background:[^;]*url\(/u);
});

test("review #25/#15: every next-step button of the chat flow reads in the chosen language", () => {
  const labels = ["确认该模块页面效果图", "核对原交接回执", "核对原设计修改回执", "核对原决策回执", "查询原请求回执", "重新检测可用客户端",
    "重新生成只读设计草稿", "核对原 B3 授权", "重新检测 B3 入口", "开始另一个任务", "准备交接材料（不执行）", "批准 B3 · 启动受限草稿",
    "通过 B4 验收并合入主项目", "立即核验隔离区产物", "保存设计草稿，进入人工审阅", "回滚本次合入", "查看原生任务状态"];
  const untranslated = labels.flatMap((label) => ["en", "ja", "ko"].filter((language) => translateAgentUi(label, language) === label).map((language) => language + " " + label));
  assert.deepEqual(untranslated, []);
});

// Review #2: the catalog marks a run whose recorded working folder lies outside
// the project, or which recorded none, as attribution "unattributed". Such a run
// belongs to another workspace, so no count, picker row or default choice may
// include it; the run list keeps it reachable in a collapsed group of its own.
function pageFunction(html, name) {
  const regular = html.indexOf("  function " + name + "(");
  const start = regular >= 0 ? regular : html.indexOf("  async function " + name + "(");
  assert.ok(start >= 0, name + "() must be shipped");
  const end = Math.min(...["\n  function ", "\n  async function "].map((prefix) => html.indexOf(prefix, start + 1)).filter((index) => index > start));
  return html.slice(start, end);
}

const projectRuns = () => [
  { runId: "meta-elsewhere", title: "量化回测", attribution: "unattributed" },
  { runId: "meta-own", title: "修复界面布局", attribution: "project" },
  { runId: "meta-unclaimed", title: "整理发布清单" },
  { runId: "meta-own-unlinked", title: "meta-own-unlinked", attribution: "project", identificationState: "unlinked" },
];

test("review #2: a run recorded outside the project is left out of the counts, the run picker and the default choice", async () => {
  const { renderLiveControlRoomPage } = await import("../../src/presentation/live/live-control-room-page.mjs");
  const html = renderLiveControlRoomPage();
  const project = { projectId: "project-current", displayName: "Meta_Kim", sessions: projectRuns() };
  const hub = [];
  const pickerRows = [];
  const api = new Function("project", "hub", "pickerRows", `
    let projectCatalog = [project], selectedProjectId = "", selectedRunId = "", catalogAvailable = false;
    let currentSnapshot = null, selectionGeneration = 0, snapshotCoalesceTimer = null,
      pendingSnapshot, refreshQueued, refreshAfterRequest, snapshotRequestInFlight,
      selectedNodeId, currentReplayIndex, replayFollowingLive;
    const currentLanguage = "en", controlPanel = null, controlError = null, controlResult = null, abortController = null;
    const DEFAULT_SELECTION = null, sessionSelect = null;
    const safeIdentifier = (value) => value;
    const sessionIsIdentified = (session) => session.identificationState !== "unlinked";
    const sessionSelectionRow = (session) => ({ identity: session.runId });
    const pickDefaultRow = (rows) => rows[0] || null;
    const projectForSelection = () => project;
    const replaceSelectOptions = (select, rows) => pickerRows.push(rows.map((row) => row.value));
    const formatSessionTime = () => "", sessionDisplayTitle = (session) => session.title,
      informativeValue = (value, absent) => value || absent, sessionShortId = (session) => session.runId,
      localize = (value) => value, renderSessionCards = () => {};
    const populateProjectSelect = () => {}, stopReplay = () => {}, setControlMessage = () => {},
      disconnectEvents = () => {}, connectEvents = () => {}, renderRunOverview = () => {},
      updateSelectionUrl = () => {}, showEmpty = () => {};
    let showUnlinkedSessions = false, showOutsideSessions = false;
    const setHubStatus = (message) => hub.push(message);
    const loadSnapshot = async () => { currentSnapshot = { run: { id: selectedRunId } }; };
    ${["projectRunTally", "projectOptionLabel", "unopenableRunNoticeLabel", "populateSessionSelect", "defaultSessionFor", "switchSelection", "applyProjectCatalog"].map((name) => pageFunction(html, name)).join("\n")}
    return { projectOptionLabel, switchSelection, applyProjectCatalog, selected: () => selectedRunId,
      expandOutside: () => { showOutsideSessions = true; }, outsideShown: () => showOutsideSessions };
  `)(project, hub, pickerRows);

  assert.equal(api.projectOptionLabel(project), "Meta_Kim · 2 of 3 runs", "the label counts only the project's own runs");
  await api.switchSelection("project-current", "");
  assert.equal(api.selected(), "meta-own", "the run opened by default must belong to the project");
  assert.deepEqual(pickerRows.at(-1), ["meta-own", "meta-unclaimed", ""], "the picker offers the project's own openable runs and names the one it cannot open");
  assert.equal(hub.at(-1), "Meta_Kim · 3 observed run records");
  await api.applyProjectCatalog({ projects: [project] }, { refresh: true });
  assert.equal(hub.at(-1), "Meta_Kim · 3 observed run records", "a catalog refresh reports the same count");
  // A shared link still lands on the run it names, and the picker shows what is open.
  await api.switchSelection("project-current", "meta-elsewhere");
  assert.equal(api.selected(), "meta-elsewhere");
  assert.deepEqual(pickerRows.at(-1), ["meta-elsewhere", "meta-own", "meta-unclaimed", ""]);
  // Expanded groups belong to the project they were opened in.
  api.expandOutside();
  await api.switchSelection("project-current", "meta-own");
  assert.equal(api.outsideShown(), true, "staying in the project keeps its groups as the reader left them");
  await api.switchSelection("project-other", "");
  assert.equal(api.outsideShown(), false, "another project opens with its own groups collapsed");
});

function sessionListHarness(html) {
  const node = (tag, className = "", text = "") => ({
    tag, className, text, children: [], dataset: {}, listeners: {},
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this[name] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
  });
  const list = node("div");
  const render = new Function("sessionList", "makeElement", `
    const expandedSessionRecords = new Set();
    const currentLanguage = "zh", selectedProjectId = "project-current", selectedRunId = "";
    let showUnlinkedSessions = false, showOutsideSessions = false, sessionSearchQuery = "";
    const clearChildren = (target) => { target.children = []; };
    const sessionGroups = (sessions) => ({ ordered: sessions });
    const sessionIsForeground = () => true;
    const sessionDisplayTitle = (session) => session.title;
    const sessionRecordOrigin = () => "governed_run", sessionOriginCopy = () => "", sourceRuntimeLabel = () => "Codex";
    const conversationLinkCopyFor = () => "", conversationChatIdentityCopy = () => "", conversationChatIdentityValue = () => "";
    const sessionTimeCopy = () => ({ text: "11/19 08:00", hint: "" });
    const sessionShortId = (session) => session.runId, formatSessionTime = () => "11/19 08:00";
    const informativeValue = (value, absent) => value || absent, localize = (value) => value, switchSelection = () => {};
    ${pageFunction(html, "renderSessionCards")}
    return renderSessionCards;
  `)(list, node);
  const textOf = (target) => [target.text, ...target.children.map(textOf)].join(" ");
  return {
    list,
    render,
    textOf,
    cards: () => list.children.filter((child) => child.className === "session-card"),
    find: (predicate) => list.children.find(predicate),
  };
}

test("review #2: runs from other folders sit after the project's own runs, collapsed until asked for", async () => {
  const { renderLiveControlRoomPage } = await import("../../src/presentation/live/live-control-room-page.mjs");
  const view = sessionListHarness(renderLiveControlRoomPage());
  const ids = () => view.cards().map((card) => card.dataset.runId);
  view.render(projectRuns().slice(0, 3));
  assert.deepEqual(ids(), ["meta-own", "meta-unclaimed"], "a run from another folder stays out of the list until asked for");
  const reveal = view.find((child) => child.dataset.liveShowOutside === "true");
  assert.equal(reveal?.text, "显示 1 条不属于本项目的运行记录");
  reveal.listeners.click();
  assert.deepEqual(ids(), ["meta-own", "meta-unclaimed", "meta-elsewhere"], "once shown it sits after the project's own runs");
  const headings = view.list.children.filter((child) => child.className === "session-group-heading").map(view.textOf);
  assert.match(headings.at(-1), /不属于本项目的运行/u);
  const hide = view.find((child) => child.dataset.liveShowOutside === "false");
  assert.equal(hide?.text, "收起不属于本项目的运行记录");
  hide.listeners.click();
  assert.deepEqual(ids(), ["meta-own", "meta-unclaimed"]);
  view.render([projectRuns()[0]]);
  assert.deepEqual(ids(), []);
  assert.ok(view.find((child) => child.className === "panel-empty" && child.text === "No governed runs yet"), "a project whose only runs came from elsewhere says it has none of its own");
  assert.ok(view.find((child) => child.dataset.liveShowOutside === "true"));
});

test("review #24: a run row silent for six hours or more says how long", async () => {
  const { renderLiveControlRoomPage } = await import("../../src/presentation/live/live-control-room-page.mjs");
  const view = sessionListHarness(renderLiveControlRoomPage());
  view.render([{ runId: "meta-stale", title: "等待人工确认", staleIdleHours: 9 }, { runId: "meta-fresh", title: "修复界面布局", staleIdleHours: null }]);
  const card = (runId) => view.cards().find((child) => child.dataset.runId === runId);
  assert.match(view.textOf(card("meta-stale")), /已 9 小时没有新进展/u);
  assert.doesNotMatch(view.textOf(card("meta-fresh")), /小时没有新进展/u);
});

test("review #2/#24: the client keeps the attribution and staleness the catalog ships", async () => {
  const { renderLiveControlRoomPage } = await import("../../src/presentation/live/live-control-room-page.mjs");
  const normalize = new Function("safeIdentifier", "display", "firstValue", "nullableCountOf", "generatedRunTitle",
    "sessionRecordOrigin", "projectSelectionRow", "compareSelectionRows", "DEFAULT_SELECTION",
    `${pageFunction(renderLiveControlRoomPage(), "normalizeCatalog")}
    return normalizeCatalog;`,
  )(
    (value) => (typeof value === "string" && value ? value : ""),
    (value, fallback = "") => (value === undefined || value === null || value === "" ? fallback : String(value)),
    (source, keys, fallback = "") => keys.map((key) => source?.[key]).find(Boolean) ?? fallback,
    () => null, () => false, () => "governed_run", (project) => ({ project }), () => 0, {},
  );
  const sessions = normalize({ projects: [{ projectId: "project-a", sessions: [
    { runId: "run-elsewhere", attribution: "unattributed", attributionBasis: "cwd_outside_project", staleness: { stale: false, idleHours: 1 } },
    { runId: "run-stale", attribution: "project", staleness: { stale: true, idleHours: 9 } },
    { runId: "run-forged", attribution: "somewhere", staleness: { stale: true, idleHours: "9" } },
  ] }] }).projects[0].sessions;
  assert.deepEqual(sessions.map((session) => [session.runId, session.attribution, session.staleIdleHours]), [
    ["run-elsewhere", "unattributed", null],
    ["run-stale", "project", 9],
    ["run-forged", "", null],
  ]);
});

test("review #2/#24: the new run-list wording reads in Japanese and Korean", async () => {
  const { translateLiveUiCopy } = await import("../../src/presentation/live/live-ui-copy.mjs");
  const texts = ["Runs from other folders", "Recorded outside this project, or no folder recorded", "Show 3 runs from other folders", "Hide runs from other folders", "No progress for 9 h"];
  const untranslated = texts.flatMap((text) => ["ja", "ko"]
    .filter((language) => !/[぀-ヿ一-鿿가-힯]/u.test(translateLiveUiCopy(text, language)))
    .map((language) => language + " " + text));
  assert.deepEqual(untranslated, []);
  assert.match(translateLiveUiCopy("Show 3 runs from other folders", "ja"), /3/u);
  assert.match(translateLiveUiCopy("No progress for 9 h", "ko"), /9/u);
});
