/**
 * Dependency-free presentation for the Meta_Kim Live control room.
 *
 * The page is deliberately a shell: the browser reads the bounded live snapshot
 * from the local API and listens for refresh hints over SSE. Snapshot values
 * are only ever placed into DOM text nodes by the client script. This keeps a
 * compromised or malformed observer payload from becoming executable markup.
 */

export const LIVE_SNAPSHOT_SCHEMA_VERSION = "meta-kim-live-snapshot-v2";

const DEFAULT_SNAPSHOT_ENDPOINT = "/api/snapshot";
const DEFAULT_EVENTS_ENDPOINT = "/api/events";
const DEFAULT_PROJECTS_ENDPOINT = "/api/projects";
const DEFAULT_REPLAY_ENDPOINT = "/api/replay";
const DEFAULT_SHARE_ENDPOINT = "/api/share";
const DEFAULT_CONTROL_ENDPOINT = "/api/commands";
const LIVE_CONTROL_ACTIONS = ["pause", "resume", "reassign", "handoff"];
const LIVE_CONTROL_HEADER = "x-meta-kim-control-token";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeEndpoint(value, fallback) {
  if (typeof value !== "string") return fallback;
  const endpoint = value.trim();
  if (
    endpoint.length < 1 ||
    endpoint.length > 512 ||
    !endpoint.startsWith("/") ||
    endpoint.startsWith("//") ||
    /[\u0000-\u001f\u007f]/u.test(endpoint)
  ) {
    return fallback;
  }
  return endpoint;
}

function safeJsonForHtml(value) {
  let serialized = "null";
  try {
    const candidate = value && typeof value === "object" ? value : null;
    serialized = JSON.stringify(candidate) ?? "null";
  } catch {
    serialized = "null";
  }

  // The initial snapshot is inside an inert JSON script element. Escaping the
  // HTML-significant characters makes even a hostile string unable to close
  // that element. The client parses it as JSON and then uses textContent.
  return serialized
    .replaceAll("<", "\\u003C")
    .replaceAll(">", "\\u003E")
    .replaceAll("&", "\\u0026")
    .replaceAll("=", "\\u003D")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function isAvailableCapability(value) {
  if (value === true) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return value.available === true || value.enabled === true;
}

function normalizeControlToken(value) {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 256 ||
    !/^[A-Za-z0-9._~+/=-]+$/u.test(value)
  ) return null;
  return value;
}

function normalizeControlConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const enabled = value.controlEnabled === true || value.enabled === true;
  const capabilities = value.capabilities && typeof value.capabilities === "object"
    ? value.capabilities
    : value.commandCapabilities && typeof value.commandCapabilities === "object"
      ? value.commandCapabilities
      : {};
  const controlHeader = value.controlHeader === LIVE_CONTROL_HEADER ? LIVE_CONTROL_HEADER : null;
  const controlToken = normalizeControlToken(value.controlToken);
  if (!enabled || !controlHeader || !controlToken || !LIVE_CONTROL_ACTIONS.every((action) => isAvailableCapability(capabilities[action]))) return null;
  return {
    controlEnabled: true,
    controlHeader,
    controlToken,
    capabilities: Object.fromEntries(LIVE_CONTROL_ACTIONS.map((action) => [action, { available: true }])),
  };
}

const CLIENT_SCRIPT = String.raw`(() => {
  "use strict";

  const app = document.getElementById("live-app");
  if (!app) return;

  const snapshotEndpoint = app.dataset.snapshotEndpoint || "/api/snapshot";
  const eventsEndpoint = app.dataset.eventsEndpoint || "/api/events";
  const projectsEndpoint = app.dataset.projectsEndpoint || "/api/projects";
  const replayEndpoint = app.dataset.replayEndpoint || "/api/replay";
  const shareEndpoint = app.dataset.shareEndpoint || "/api/share";
  const controlEndpoint = app.dataset.controlEndpoint || "/api/commands";
  const initialElement = document.getElementById("live-initial-snapshot");
  const initialCatalogElement = document.getElementById("live-initial-catalog");
  const controlConfigElement = document.getElementById("live-control-config");
  const reducedMotion = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : { matches: false };

  const LANGUAGE_STORAGE_KEY = "meta-kim-live-language";
  const WORK_VIEW_STORAGE_KEY = "meta-kim-live-work-view";
  const WORK_VIEWS = ["repository", "workspace", "run"];
  const INSPECTOR_TABS = ["summary", "conversation", "terminal", "changes", "evidence", "context"];
  const zhText = new Map(Object.entries({
    "Connecting…": "正在连接…",
    "Streaming": "实时连接中",
    "Reconnecting": "正在重新连接",
    "Polling snapshot": "正在轮询运行快照",
    "Snapshot unavailable": "运行快照不可用",
    "No run observed": "尚未观测到运行",
    "Live": "实时",
    "In doubt": "存疑",
    "Stale": "未更新",
    "running": "运行中",
    "completed": "已完成",
    "skipped": "已跳过",
    "failed": "失败",
    "blocked": "已阻塞",
    "in doubt": "存疑",
    "queued": "排队中",
    "active": "进行中",
    "pending": "待开始",
    "cancelled": "已取消",
    "session_stopped": "已停止",
    "archived": "已归档",
    "upcoming": "待开始",
    "current": "当前",
    "critical": "目标确认",
    "Critical": "目标确认",
    "fetch": "证据收集",
    "Fetch": "证据收集",
    "thinking": "方案设计",
    "Thinking": "方案设计",
    "execution": "执行",
    "Execution": "执行",
    "review": "结果审查",
    "Review": "结果审查",
    "meta-review": "复审",
    "Meta-Review": "复审",
    "verification": "验收",
    "Verification": "验收",
    "evolution": "经验沉淀",
    "Evolution": "经验沉淀",
    "Live execution": "Meta_Kim 治理运行",
    "local observer": "本地观察器",
    "durable_status": "运行状态记录",
    "No active workers": "当前没有执行者在运行",
    "Role": "角色",
    "Agent": "智能体",
    "Runtime": "运行时",
    "No evidence has been observed yet.": "尚未观测到证据。",
    "No replay events in this snapshot.": "当前快照中没有回放事件。",
    "Waiting for replay data": "正在等待回放数据",
    "Play": "播放",
    "Pause": "暂停",
    "Resume": "继续",
    "Reassign": "重新分配",
    "Handoff": "移交",
    "Pause run": "暂停运行",
    "Resume run": "继续运行",
    "Reassign run": "重新分配运行",
    "Handoff run": "移交运行",
    "Controls are enabled by the local service; every command remains pending verification.": "本机服务已启用控制；每条命令仍需通过验证。",
    "Preparing a local JSON export…": "正在准备本地 JSON 导出…",
    "JSON export prepared locally; nothing was uploaded.": "JSON 已在本地准备完成，没有上传任何内容。",
    "JSON export unavailable; the local share endpoint did not provide a safe artifact.": "无法导出 JSON；本地分享接口没有提供安全产物。",
    "Preparing a local share card…": "正在准备本地分享卡片…",
    "PR card copied locally.": "PR 卡片已复制到本地剪贴板。",
    "README embed copied locally.": "README 嵌入内容已复制到本地剪贴板。",
    "Share copy unavailable; the local endpoint or clipboard was not ready.": "无法复制分享内容；本地接口或剪贴板尚未就绪。",
    "No registered projects": "没有已登记的项目",
    "No governed runs yet": "暂无治理运行",
    "Select a project first": "请先选择项目",
    "Local project catalog": "本地项目目录",
    "Choose a registered Meta_Kim project to inspect its governed runs.": "请选择一个已登记的 Meta_Kim 项目查看治理运行。",
    "No project selected": "尚未选择项目",
    "This project has no governed runs yet. Start a Meta_Kim task and its session will appear here.": "这个项目还没有治理运行。启动一个 Meta_Kim 任务后，会话会显示在这里。",
    "Loading the selected run…": "正在加载选中的运行…",
    "No Meta_Kim projects are registered yet. Install or update Meta_Kim in a project, then start a governed run.": "尚未登记 Meta_Kim 项目。请先在项目中安装或更新 Meta_Kim，再启动治理运行。",
    "No registered projects · the Hub never scans your disk": "没有已登记项目 · Hub 不会扫描你的磁盘",
    "Project catalog refresh paused · showing the last verified list": "项目目录刷新已暂停 · 正在显示上次验证的列表",
    "Current project mode · global catalog unavailable": "当前项目模式 · 全局目录不可用",
    "Waiting for a run snapshot": "正在等待运行快照",
    "No governed run has been observed in this project yet.": "这个项目中尚未观测到治理运行。",
    "The local observer is not serving a snapshot yet.": "本地观察器尚未提供运行快照。",
    "The embedded snapshot could not be read.": "无法读取页面内嵌的运行快照。",
    "Select a node to inspect provenance": "选择节点查看来源与依据",
    "Evidence stays visible in the drawer": "证据会持续显示在抽屉中",
    "Status · —": "状态 · —",
    "Owner · —": "负责人 · —",
    "Runtime · —": "运行时 · —",
    "Select a node to inspect its execution summary.": "选择节点查看执行摘要。",
    "No evidence detail is linked to this node yet.": "该节点尚未关联证据详情。",
    "Evidence details appear when a node is selected.": "选择节点后将在这里显示证据详情。",
    "Download local share JSON": "下载本地分享 JSON",
    "Meta_Kim Live header": "Meta_Kim Live 顶栏",
    "Meta_Kim project and session selection": "Meta_Kim 项目与会话选择",
    "Choose a Meta_Kim project": "选择 Meta_Kim 项目",
    "Choose a governed session": "选择治理会话",
    "Run facts": "运行事实",
    "Live execution workspace": "实时执行工作区",
    "Toggle graph layout": "切换运行图布局",
    "Fit graph to viewport": "让运行图适应视口",
    "Follow active node": "跟随当前节点",
    "Zoom graph out": "缩小运行图",
    "Zoom graph in": "放大运行图",
    "Read-only execution graph": "只读执行运行图",
    "Execution nodes": "执行节点",
    "Graph minimap": "运行图小地图",
    "Open inspector": "打开检查器",
    "Close inspector": "关闭检查器",
    "Toggle evidence drawer": "展开或收起证据抽屉",
    "Observed evidence": "已观测证据",
    "Previous replay event": "上一个回放事件",
    "Play replay": "播放回放",
    "Next replay event": "下一个回放事件",
    "Go to live replay position": "回到实时回放位置",
    "Reset replay": "重置回放",
    "Replay position": "回放位置",
    "Replay events": "回放事件"
    ,"Overview": "总览"
    ,"Follow": "跟随"
    ,"Manual": "手动"
    ,"Relayout": "重排"
    ,"Inspector": "检查器"
    ,"Camera": "相机"
    ,"Mode": "模式"
    ,"Workers": "执行者"
    ,"Events": "事件"
    ,"Snapshots": "快照"
    ,"Terminal": "终态"
    ,"Proof": "证据状态"
    ,"Prompt summary": "任务摘要"
    ,"Loadout": "能力装载"
    ,"Declared capability loadout": "已声明能力装载"
    ,"observed": "已观测"
    ,"planned snapshot": "计划快照"
    ,"structural evidence only": "仅结构化证据"
    ,"Prompt summary withheld": "提示词摘要未展示"
    ,"No accepted host execution evidence": "没有已接受的主机执行证据"
  }));
  let currentLanguage = (() => {
    try { return window.localStorage?.getItem(LANGUAGE_STORAGE_KEY) === "en" ? "en" : "zh"; }
    catch { return "zh"; }
  })();

  function localize(value) {
    const text = display(value);
    if (currentLanguage === "en" || !text) return text;
    const direct = zhText.get(text);
    if (direct) return direct;
    let match = text.match(/^Run ([A-Z0-9-]+)$/u);
    if (match) return "任务 " + match[1];
    match = text.match(/^(.*) · (\d+) runs$/u);
    if (match) return match[1] + " · " + match[2] + " 次运行";
    match = text.match(/^(.*) · no runs$/u);
    if (match) return match[1] + " · 暂无运行";
    match = text.match(/^(.*) · (\d+) observed sessions$/u);
    if (match) return match[1] + " · 已观测 " + match[2] + " 个会话";
    match = text.match(/^(\d+) of (\d+) steps complete$/u);
    if (match) return "已完成 " + match[1] + " / " + match[2] + " 个步骤";
    match = text.match(/^(\d+) active workers?$/u);
    if (match) return match[1] + " 个执行者正在工作";
    match = text.match(/^(\d+) nodes?$/u);
    if (match) return match[1] + " 个节点";
    match = text.match(/^Event (\d+) of (\d+)$/u);
    if (match) return "事件 " + match[1] + " / " + match[2];
    match = text.match(/^(\d+) tools?$/u);
    if (match) return match[1] + " 次工具调用";
    match = text.match(/^(\d+) tokens?$/u);
    if (match) return match[1] + " 输出 token";
    match = text.match(/^(.*) · waiting for its first governed run$/u);
    if (match) return match[1] + " · 等待首次治理运行";
    match = text.match(/^Event (\d+) of (\d+): (.*)$/u);
    if (match) return "事件 " + match[1] + " / " + match[2] + "：" + match[3];
    match = text.match(/^(\d+) linked evidence items?$/u);
    if (match) return "已关联 " + match[1] + " 条证据";
    if (text.startsWith("Live · ")) return "实时 · " + text.slice(7);
    if (text.startsWith("Selected · ")) return "已选择 · " + text.slice(11);
    if (text.startsWith("Run · ")) return "任务 · " + text.slice(6);
    if (text.startsWith("Status · ")) return "状态 · " + localize(text.slice(9));
    if (text.startsWith("Owner · ")) return "负责人 · " + text.slice(8);
    if (text.startsWith("Runtime · ")) return "运行时 · " + text.slice(10);
    if (text.startsWith("Model · ")) return "模型 · " + text.slice(8);
    if (text.startsWith("Duration · ")) return "耗时 · " + text.slice(11);
    if (text.startsWith("Tools · ")) return "工具 · " + text.slice(8);
    if (text.startsWith("Tokens · ")) return "输出 · " + text.slice(9);
    if (text.startsWith("Prompt era · ")) return "提示词阶段 · " + text.slice(13);
    if (text.startsWith("Source · ")) return "来源 · " + text.slice(9);
    if (text.startsWith("Run snapshot updated: ")) return "运行快照已更新：" + text.slice(22);
    if (text.startsWith("Last observed ")) return "最近观测 " + text.slice(14);
    if (text.startsWith("Selected node: ")) return "已选择节点：" + text.slice(15);
    if (text.startsWith("Replay ")) return "回放 " + text.slice(7);
    if (text.startsWith("Stage state projected from")) return "阶段状态来自运行记录";
    if (text.endsWith(" evidence")) return text.slice(0, -9) + " 证据";
    match = text.match(/^(planned|observed) · (\d+) evidence$/u);
    if (match) return (match[1] === "planned" ? "计划" : "已观测") + " · " + match[2] + " 条证据";
    if (text === "planned · awaiting host evidence") return "计划 · 等待主机证据";
    if (text === "no evidence linked") return "未关联证据";
    if (text.startsWith("↳ from ")) return "↳ 来自 " + text.slice(7);
    return text;
  }

  function applyLanguage() {
    document.documentElement.lang = currentLanguage === "zh" ? "zh-CN" : "en";
    document.title = currentLanguage === "zh" ? "Meta_Kim Live · 控制中心" : "Meta_Kim Live · Control room";
    document.querySelectorAll("[data-i18n-en][data-i18n-zh]").forEach((element) => {
      element.textContent = currentLanguage === "zh" ? element.dataset.i18nZh : element.dataset.i18nEn;
    });
    document.querySelectorAll("[aria-label]").forEach((element) => {
      if (!element.dataset.i18nAriaEn) element.dataset.i18nAriaEn = element.getAttribute("aria-label") || "";
      element.setAttribute("aria-label", currentLanguage === "zh" ? localize(element.dataset.i18nAriaEn) : element.dataset.i18nAriaEn);
    });
    const toggle = app.querySelector("[data-live-language-toggle]");
    if (toggle) {
      toggle.textContent = currentLanguage === "zh" ? "EN" : "中文";
      toggle.setAttribute("aria-label", currentLanguage === "zh" ? "切换到英文" : "Switch to Chinese");
      toggle.title = currentLanguage === "zh" ? "切换到英文" : "Switch to Chinese";
    }
  }

  const connectionLabel = app.querySelector("[data-live-connection]");
  const connectionDot = app.querySelector("[data-live-connection-dot]");
  const projectSelect = app.querySelector("[data-live-project-select]");
  const sessionSelect = app.querySelector("[data-live-session-select]");
  const sessionList = app.querySelector("[data-live-session-list]");
  const hubStatus = app.querySelector("[data-live-hub-status]");
  const workViewTabs = [...app.querySelectorAll("[data-live-work-view]")];
  const repositoryView = app.querySelector("[data-live-repository-view]");
  const repositoryTitle = app.querySelector("[data-live-repository-title]");
  const repositoryBoundary = app.querySelector("[data-live-repository-boundary]");
  const repositoryFacts = app.querySelector("[data-live-repository-facts]");
  const repositorySessions = app.querySelector("[data-live-repository-sessions]");
  const workspaceView = app.querySelector("[data-live-workspace-view]");
  const workspaceTitle = app.querySelector("[data-live-workspace-title]");
  const workspaceBoundary = app.querySelector("[data-live-workspace-boundary]");
  const workspaceFacts = app.querySelector("[data-live-workspace-facts]");
  const stateLabel = app.querySelector("[data-live-state-label]");
  const stateChip = app.querySelector("[data-live-state]");
  const title = app.querySelector(".top-run-context [data-live-run-title]");
  const contextTitle = app.querySelector("[data-live-context-title]");
  const runId = app.querySelector("[data-live-run-id]");
  const stage = app.querySelector("[data-live-run-stage]");
  const started = app.querySelector("[data-live-run-started]");
  const updated = app.querySelector("[data-live-run-updated]");
  const source = app.querySelector("[data-live-source]");
  const graph = app.querySelector("[data-live-graph]");
  const stageRail = app.querySelector("[data-live-stage-rail]");
  const graphScene = app.querySelector("[data-live-graph-scene]");
  const edgeLayer = app.querySelector("[data-live-edge-layer]");
  const nodeList = app.querySelector("[data-live-node-list]");
  const graphEmpty = app.querySelector("[data-live-graph-empty]");
  const graphMinimap = app.querySelector("[data-live-graph-minimap]");
  const graphMinimapScene = app.querySelector("[data-live-minimap-scene]");
  const graphMinimapViewport = app.querySelector("[data-live-minimap-viewport]");
  const selectedNodeLabel = app.querySelector("[data-live-selected-node-label]");
  const selectedNodeEvidence = app.querySelector("[data-live-selected-node-evidence]");
  const selectedNodeStatus = app.querySelector("[data-live-selected-node-status]");
  const selectedNodeOwner = app.querySelector("[data-live-selected-node-owner]");
  const selectedNodeRuntime = app.querySelector("[data-live-selected-node-runtime]");
  const selectedNodeModel = app.querySelector("[data-live-selected-node-model]");
  const selectedNodeDuration = app.querySelector("[data-live-selected-node-duration]");
  const selectedNodeTools = app.querySelector("[data-live-selected-node-tools]");
  const selectedNodeTokens = app.querySelector("[data-live-selected-node-tokens]");
  const selectedNodeLoadout = app.querySelector("[data-live-selected-node-loadout]");
  const selectedNodeSummary = app.querySelector("[data-live-selected-node-summary]");
  const selectedNodeEvidenceDetail = app.querySelector("[data-live-selected-node-evidence-detail]");
  const selectedNodeProvenance = app.querySelector("[data-live-selected-node-provenance]");
  const selectedNodePrompt = app.querySelector("[data-live-selected-node-prompt]");
  const evidenceList = app.querySelector("[data-live-evidence-list]");
  const evidenceCount = app.querySelector("[data-live-evidence-count]");
  const evidenceToggle = app.querySelector("[data-evidence-toggle]");
  const evidencePanel = app.querySelector("[data-live-inspector]");
  const evidenceClose = app.querySelector("[data-live-inspector-close]");
  const inspectorTabs = [...app.querySelectorAll("[data-live-inspector-tab]")];
  const inspectorPanels = [...app.querySelectorAll("[data-live-inspector-panel]")];
  const conversationList = app.querySelector("[data-live-conversation-list]");
  const terminalList = app.querySelector("[data-live-terminal-list]");
  const changesList = app.querySelector("[data-live-changes-list]");
  const contextTransferList = app.querySelector("[data-live-context-transfer-list]");
  const graphFollow = app.querySelector("[data-live-graph-follow]");
  const cameraModeLabel = app.querySelector("[data-live-camera-mode]");
  const sessionsDialog = app.querySelector("[data-live-sessions-dialog]");
  const helpDialog = app.querySelector("[data-live-help-dialog]");
  const infoDialog = app.querySelector("[data-live-info-dialog]");
  const infoTools = app.querySelector("[data-live-info-tools]");
  const infoFacts = app.querySelector("[data-live-info-facts]");
  const replayRange = app.querySelector("[data-replay-range]");
  const replayEvents = app.querySelector("[data-replay-events]");
  const replayProgress = app.querySelector("[data-replay-progress]");
  const replayPlay = app.querySelector("[data-replay-play]");
  const replayPlayLabel = app.querySelector("[data-replay-play-label]");
  const replayPrev = app.querySelector("[data-replay-prev]");
  const replayNext = app.querySelector("[data-replay-next]");
  const replayLive = app.querySelector("[data-replay-live]");
  const replayStatus = app.querySelector("[data-replay-status]");
  const emptyState = app.querySelector("[data-live-empty]");
  const liveRegion = app.querySelector("[data-live-region]");
  const lastUpdate = app.querySelector("[data-live-last-update]");
  const runProgress = app.querySelector("[data-live-run-progress]");
  const runWorkers = app.querySelector("[data-live-run-workers]");
  const statusTitle = app.querySelector("[data-live-status-title]");
  const nodeCount = app.querySelector("[data-live-node-count]");
  const contextTask = app.querySelector("[data-live-context-task]");
  const contextStage = app.querySelector("[data-live-context-stage]");
  const contextStatus = app.querySelector("[data-live-context-status]");
  const contextUpdated = app.querySelector("[data-live-context-updated]");
  const contextSource = app.querySelector("[data-live-context-source]");
  const contextNodes = app.querySelector("[data-live-context-nodes]");
  const contextEvents = app.querySelector("[data-live-context-events]");
  const contextEvidence = app.querySelector("[data-live-context-evidence]");
  const workspace = app.querySelector(".workspace-grid");
  const replayPanel = app.querySelector(".replay-panel");
  const shareStatus = app.querySelector("[data-live-share-status]");
  const controlPanel = app.querySelector("[data-live-control-panel]");
  const controlStatus = app.querySelector("[data-live-control-status]");
  const controlError = app.querySelector("[data-live-control-error]");
  const controlResult = app.querySelector("[data-live-control-result]");

  let currentSnapshot = null;
  let currentReplayIndex = 0;
  let replayTimer = null;
  let eventSource = null;
  let abortController = null;
  let snapshotCoalesceTimer = null;
  let pendingSnapshot = null;
  let refreshQueued = false;
  let snapshotRequestInFlight = false;
  let refreshAfterRequest = false;
  let unloading = false;
  let controlBusy = false;
  let initialControlConfig = null;
  let selectedNodeId = null;
  let replayFollowingLive = true;
  let layoutMode = "compact";
  // Start in a full-graph overview so the run topology is legible before the
  // user opts into following a replay target.
  let graphFollowing = false;
  let cameraMode = "overview";
  let graphState = {
    positions: new Map(),
    nodeElements: new Map(),
    edgeElements: new Map(),
    bounds: { width: 1, height: 1 },
  };
  let camera = { x: 0, y: 0, scale: 1 };
  let pointerPan = null;
  let projectCatalog = [];
  let selectedProjectId = "";
  let selectedRunId = "";
  let catalogAvailable = false;
  let catalogRequestInFlight = false;
  let catalogRefreshTimer = null;
  let selectionGeneration = 0;
  let dialogOpener = null;
  let currentWorkView = "run";
  let currentInspectorTab = "summary";

  const statuses = new Set(["live", "stale", "in_doubt"]);
  const nodeStatuses = new Set(["running", "completed", "skipped", "failed", "blocked", "in_doubt", "queued"]);
  const controlActions = ["pause", "resume", "reassign", "handoff"];
  const SNAPSHOT_COALESCE_MS = 75;

  function safeIdentifier(value) {
    if (typeof value !== "string") return "";
    const normalized = value.normalize("NFKC").trim();
    if (!normalized || normalized.length > 160 || /[\u0000-\u001f\u007f]/u.test(normalized)) return "";
    return normalized;
  }

  function endpointForSelection(endpoint, { includeRun = true } = {}) {
    const url = new URL(endpoint, window.location.origin);
    const params = new URLSearchParams(url.search);
    if (selectedProjectId) params.set("projectId", selectedProjectId);
    else params.delete("projectId");
    if (includeRun && selectedRunId) params.set("runId", selectedRunId);
    else params.delete("runId");
    url.search = params.toString();
    return url.pathname + url.search + url.hash;
  }

  function selectionFromLocation() {
    const params = new URL(window.location.href).searchParams;
    return {
      projectId: safeIdentifier(params.get("projectId") || ""),
      runId: safeIdentifier(params.get("runId") || ""),
    };
  }

  function updateSelectionUrl() {
    const url = new URL(window.location.href);
    const params = new URLSearchParams(url.search);
    if (selectedProjectId) params.set("projectId", selectedProjectId);
    else params.delete("projectId");
    if (selectedRunId) params.set("runId", selectedRunId);
    else params.delete("runId");
    url.search = params.toString();
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }

  function capabilityAvailable(value) {
    return value === true || Boolean(value && typeof value === "object" && !Array.isArray(value) && (value.available === true || value.enabled === true));
  }

  function normalizeControlToken(value) {
    if (typeof value !== "string" || value.length < 16 || value.length > 256 || !/^[A-Za-z0-9._~+/=-]+$/u.test(value)) return null;
    return value;
  }

  function normalizeControlConfig(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const enabled = value.controlEnabled === true || value.enabled === true;
    const capabilities = value.capabilities && typeof value.capabilities === "object"
      ? value.capabilities
      : value.commandCapabilities && typeof value.commandCapabilities === "object"
        ? value.commandCapabilities
        : {};
    const controlHeader = value.controlHeader === "x-meta-kim-control-token" ? "x-meta-kim-control-token" : null;
    const controlToken = normalizeControlToken(value.controlToken);
    if (!enabled || !controlHeader || !controlToken || !controlActions.every((action) => capabilityAvailable(capabilities[action]))) return null;
    return { controlEnabled: true, controlHeader, controlToken, capabilities: Object.fromEntries(controlActions.map((action) => [action, { available: true }])) };
  }

  function readEmbeddedControlConfig() {
    const text = controlConfigElement?.textContent?.trim();
    if (!text || text === "null") return null;
    try {
      return normalizeControlConfig(JSON.parse(text));
    } catch {
      return null;
    }
  }

  initialControlConfig = readEmbeddedControlConfig();

  function display(value, fallback) {
    if (value === null || value === undefined || value === "") return fallback || "—";
    const text = String(value).normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
    return text.slice(0, 240) || (fallback || "—");
  }

  function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function nullableCount(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function firstValue(record, keys, fallback) {
    if (!record || typeof record !== "object") return fallback;
    for (const key of keys) {
      if (record[key] !== undefined && record[key] !== null && record[key] !== "") {
        return record[key];
      }
    }
    return fallback;
  }

  function normalizedStatus(value) {
    const status = display(value, "stale").toLowerCase().replace(/[\s-]+/gu, "_");
    if (["active", "in_progress", "running", "started"].includes(status)) return "live";
    if (["unknown", "uncertain"].includes(status)) return "in_doubt";
    return statuses.has(status) ? status : "stale";
  }

  function normalizedNodeStatus(value) {
    const status = display(value, "queued").toLowerCase().replace(/[\s-]+/gu, "_");
    if (["active", "in_progress", "executing", "running"].includes(status)) return "running";
    if (["done", "success", "succeeded", "complete", "completed"].includes(status)) return "completed";
    if (["error", "errored", "failure", "failed"].includes(status)) return "failed";
    if (status === "in_doubt") return "in_doubt";
    if (status === "blocked") return "blocked";
    return nodeStatuses.has(status) ? status : "queued";
  }

  function summarizeTerminalEvidence(value) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return display(value, "");
    const records = (Array.isArray(value) ? value : [value])
      .slice(0, 24)
      .filter((item) => item && typeof item === "object" && !Array.isArray(item))
      .map((item) => ({
        label: display(firstValue(item, ["label", "title", "kind", "type"], ""), ""),
        status: normalizedNodeStatus(firstValue(item, ["status", "state", "result"], "in_doubt")),
      }));
    const trusted = records.filter((item) => ["completed", "failed", "blocked"].includes(item.status));
    if (!trusted.length) return "";
    if (trusted.length === 1) return [trusted[0].label, trusted[0].status].filter(Boolean).join(" · ");
    const counts = new Map();
    trusted.forEach((item) => counts.set(item.status, (counts.get(item.status) || 0) + 1));
    return trusted.length + " terminal evidence · " + [...counts].map(([status, count]) => status + " " + count).join(" · ");
  }

  function normalizedAvailability(value, fallbackSummary) {
    if (value === true) return { state: "observed", summary: fallbackSummary || "Observed" };
    if (value === false || value === null || value === undefined) {
      return { state: "unavailable", summary: fallbackSummary || "Telemetry unavailable" };
    }
    if (typeof value === "string" || typeof value === "number") {
      return { state: "observed", summary: display(value, fallbackSummary || "Observed") };
    }
    if (typeof value !== "object" || Array.isArray(value)) {
      return { state: "unavailable", summary: fallbackSummary || "Telemetry unavailable" };
    }
    const rawState = display(firstValue(value, ["state", "status", "availability"], "unavailable"), "unavailable")
      .toLowerCase().replace(/[\s-]+/gu, "_");
    const state = ["observed", "accepted", "completed", "available", "active"].includes(rawState)
      ? "observed"
      : rawState === "planned" || rawState === "pending"
        ? "planned"
        : "unavailable";
    return {
      state,
      summary: display(firstValue(value, ["value", "summary", "label", "detail", "message"], fallbackSummary), fallbackSummary || "Telemetry unavailable"),
      count: Math.max(0, numberOr(firstValue(value, ["count", "total", "items"], 0), 0)),
    };
  }

  function normalizeSnapshot(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const hasRun = Boolean(input.run && typeof input.run === "object" && !Array.isArray(input.run));
    const runInput = hasRun ? input.run : {};
    const sourceInput = input.source && typeof input.source === "object" ? input.source : {};
    const sessionCandidate = input.sessionInfo ?? input.session;
    const sessionInput = sessionCandidate && typeof sessionCandidate === "object" && !Array.isArray(sessionCandidate) ? sessionCandidate : {};
    const nodeInput = Array.isArray(input.nodes) ? input.nodes : [];
    const edgeInput = Array.isArray(input.edges) ? input.edges : [];
    const evidenceInput = Array.isArray(input.evidence) ? input.evidence : [];
    const promptInput = Array.isArray(input.prompts) ? input.prompts : [];
    const toolCallInput = Array.isArray(input.toolCalls) ? input.toolCalls : [];
    const provenanceInput = Array.isArray(input.provenance) ? input.provenance : [];
    const repositoryInput = input.repository && typeof input.repository === "object" && !Array.isArray(input.repository) ? input.repository : {};
    const workspaceInput = input.workspace && typeof input.workspace === "object" && !Array.isArray(input.workspace) ? input.workspace : {};
    const contextTransferInput = Array.isArray(input.contextTransfers) ? input.contextTransfers : [];
    const replayInput = Array.isArray(input.replay)
      ? { events: input.replay }
      : input.replay && typeof input.replay === "object"
        ? input.replay
        : {};
    const replayInputEvents = Array.isArray(replayInput.events)
      ? replayInput.events
      : Array.isArray(replayInput.timeline)
        ? replayInput.timeline
        : [];
    const hasControlInput = Object.prototype.hasOwnProperty.call(input, "control") || Object.prototype.hasOwnProperty.call(input, "controls");
    const controlInput = Object.prototype.hasOwnProperty.call(input, "control") ? input.control : input.controls;
    const control = hasControlInput
      ? (normalizeControlConfig(controlInput) || { controlEnabled: false, capabilities: {} })
      : null;

    // The observer projects safe summaries, never raw transcripts or tool
    // payloads. Every collection remains bounded so long runs cannot grow the
    // DOM without limit.
    const nodes = nodeInput.slice(0, 128).map((node, index) => {
      const item = node && typeof node === "object" ? node : {};
      return {
        id: display(firstValue(item, ["id", "nodeId"], "node-" + (index + 1)), "node-" + (index + 1)),
        label: display(firstValue(item, ["label", "title", "name", "nodeId"], "Untitled task"), "Untitled task"),
        kind: display(firstValue(item, ["kind", "nodeKind", "type"], "worker"), "worker").toLowerCase().replace(/[\s-]+/gu, "_"),
        status: normalizedNodeStatus(firstValue(item, ["status", "state"], "queued")),
        role: display(firstValue(item, ["roleDisplayName", "role", "ownerRole"], "worker"), "worker"),
        agent: display(firstValue(item, ["agent", "ownerAgent", "owner"], "—"), "—"),
        runtime: display(firstValue(item, ["runtime", "runtimeId", "runtimeInstanceAlias"], "local"), "local"),
        modelName: display(firstValue(item, ["modelName", "model", "providerModel"], ""), ""),
        summary: display(firstValue(item, ["summary", "description", "message"], "No task detail available"), "No task detail available"),
        description: display(firstValue(item, ["description", "summary", "message"], "No task detail available"), "No task detail available"),
        parentId: display(firstValue(item, ["parentId", "parentNodeId", "spawnedByNodeId"], ""), ""),
        model: display(firstValue(item, ["model", "modelName", "providerModel"], ""), ""),
        inputTokens: Math.max(0, numberOr(firstValue(item, ["inputTokens"], 0), 0)),
        outputTokens: Math.max(0, numberOr(firstValue(item, ["outputTokens", "tokens", "tokenCount"], 0), 0)),
        totalTokens: Math.max(0, numberOr(firstValue(item, ["totalTokens"], 0), 0)),
        firstAt: display(firstValue(item, ["firstAt", "startedAt", "createdAt"], ""), ""),
        lastAt: display(firstValue(item, ["lastAt", "endedAt", "updatedAt"], ""), ""),
        terminalEvidence: summarizeTerminalEvidence(firstValue(item, ["terminalEvidence", "completionEvidence", "resultSummary"], "")),
        toolCount: Math.max(0, numberOr(firstValue(item, ["toolCount", "toolsUsed", "toolCalls"], 0), 0)),
        latestTool: display(firstValue(item, ["latestTool", "lastTool", "activeTool"], ""), ""),
        loadout: (() => {
          const value = item.loadout && typeof item.loadout === "object" ? item.loadout : {};
          return {
            skills: Math.max(0, numberOr(value.skills, 0)),
            mcp: Math.max(0, numberOr(value.mcp, 0)),
            tools: Math.max(0, numberOr(value.tools, 0)),
            commands: Math.max(0, numberOr(value.commands, 0)),
            skillNames: Array.isArray(value.skillNames) ? value.skillNames.slice(0, 24).map((item) => display(item, "")).filter(Boolean) : [],
            mcpNames: Array.isArray(value.mcpNames) ? value.mcpNames.slice(0, 24).map((item) => display(item, "")).filter(Boolean) : [],
            toolNames: Array.isArray(value.toolNames) ? value.toolNames.slice(0, 24).map((item) => display(item, "")).filter(Boolean) : [],
            commandNames: Array.isArray(value.commandNames) ? value.commandNames.slice(0, 24).map((item) => display(item, "")).filter(Boolean) : [],
          };
        })(),
        evidenceCount: Math.max(0, numberOr(firstValue(item, ["evidenceCount", "evidenceItems"], 0), 0)),
        progress: numberOr(firstValue(item, ["progress", "progressPercent"], null), null),
        task: display(firstValue(item, ["task", "scope", "purpose"], ""), ""),
      };
    });

    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const explicitEdges = edgeInput.slice(0, 256).map((edge, index) => {
      const item = edge && typeof edge === "object" ? edge : {};
      const targetId = display(firstValue(item, ["to", "target", "targetId"], ""), "");
      const explicitStatus = firstValue(item, ["status", "state"], null);
      return {
        id: display(firstValue(item, ["id", "edgeId"], "edge-" + (index + 1)), "edge-" + (index + 1)),
        from: display(firstValue(item, ["from", "source", "sourceId"], ""), ""),
        to: targetId,
        // Services commonly omit edge status. The target node is the source
        // of truth for liveness in that case, so running edges still flow.
        status: explicitStatus === null || explicitStatus === undefined || explicitStatus === ""
          ? (nodeById.get(targetId)?.status || "queued")
          : normalizedNodeStatus(explicitStatus),
      };
    }).filter((edge) => edge.from && edge.to);
    const edgeKeys = new Set(explicitEdges.map((edge) => edge.from + "\u0000" + edge.to));
    const inferredEdges = nodes.filter((node) => node.parentId && nodeById.has(node.parentId) && !edgeKeys.has(node.parentId + "\u0000" + node.id)).map((node, index) => ({
      id: "parent-edge-" + (index + 1),
      from: node.parentId,
      to: node.id,
      status: node.status,
    }));
    const edges = [...explicitEdges, ...inferredEdges].slice(0, 256);

    const evidence = evidenceInput.slice(0, 256).map((item, index) => {
      const record = item && typeof item === "object" ? item : {};
      return {
        id: display(firstValue(record, ["id", "evidenceId", "ref"], "evidence-" + (index + 1)), "evidence-" + (index + 1)),
        label: display(firstValue(record, ["label", "title", "kind", "type"], "Evidence item"), "Evidence item"),
        status: display(firstValue(record, ["status", "assessment", "state"], "observed"), "observed"),
        detail: display(firstValue(record, ["summary", "detail", "message", "description"], "Observed by the local runtime"), "Observed by the local runtime"),
        nodeId: display(firstValue(record, ["nodeId", "node", "ownerNodeId"], ""), ""),
        at: display(firstValue(record, ["timestamp", "observedAt", "occurredAt", "createdAt"], ""), ""),
        sourceRef: display(firstValue(record, ["sourceRef", "source", "ref"], ""), ""),
      };
    });

    const prompts = promptInput.slice(0, 256).map((item, index) => {
      const record = item && typeof item === "object" ? item : {};
      return {
        id: display(firstValue(record, ["id", "promptId", "eraId"], "prompt-" + (index + 1)), "prompt-" + (index + 1)),
        label: display(firstValue(record, ["label", "title", "era", "kind"], "Prompt era " + (index + 1)), "Prompt era " + (index + 1)),
        excerpt: display(firstValue(record, ["excerpt", "summary", "safeExcerpt", "description"], "Prompt content withheld"), "Prompt content withheld"),
        nodeId: display(firstValue(record, ["nodeId", "agentNodeId", "ownerNodeId"], ""), ""),
        at: display(firstValue(record, ["at", "timestamp", "createdAt", "startedAt"], ""), ""),
      };
    });

    const toolCalls = toolCallInput.slice(0, 512).map((item, index) => {
      const record = item && typeof item === "object" ? item : {};
      return {
        id: display(firstValue(record, ["id", "toolCallId"], "tool-" + (index + 1)), "tool-" + (index + 1)),
        nodeId: display(firstValue(record, ["nodeId", "agentNodeId", "ownerNodeId"], ""), ""),
        name: display(firstValue(record, ["name", "tool", "toolName", "kind"], "Tool call"), "Tool call"),
        summary: display(firstValue(record, ["summary", "safeSummary", "description", "label"], "Tool activity observed"), "Tool activity observed"),
        startedAt: display(firstValue(record, ["startedAt", "occurredAt", "at", "timestamp"], ""), ""),
        endedAt: display(firstValue(record, ["endedAt", "completedAt", "updatedAt", "occurredAt"], ""), ""),
        state: normalizedNodeStatus(firstValue(record, ["state", "status"], "queued")),
        promptId: display(firstValue(record, ["promptId", "triggerPromptId", "eraId"], ""), ""),
      };
    });

    const provenance = provenanceInput.slice(0, 256).map((item) => {
      const record = item && typeof item === "object" ? item : {};
      return {
        nodeId: display(firstValue(record, ["nodeId", "agentNodeId"], ""), ""),
        triggerPromptId: display(firstValue(record, ["triggerPromptId", "promptId", "eraId"], ""), ""),
        reasoningExcerpt: display(firstValue(record, ["reasoningExcerpt", "summary", "safeExcerpt"], [
          firstValue(record, ["ownerBindingMode"], ""),
          firstValue(record, ["state", "status"], ""),
        ].filter(Boolean).join(" · ")), ""),
      };
    }).filter((item) => item.nodeId);

    const replay = replayInputEvents.slice(0, 512).map((item, index) => {
      const record = item && typeof item === "object" ? item : {};
      return {
        id: display(firstValue(record, ["id", "eventId"], "event-" + (index + 1)), "event-" + (index + 1)),
        label: display(firstValue(record, ["label", "title", "message", "type"], "Run event"), "Run event"),
        nodeId: display(firstValue(record, ["nodeId", "node", "taskId"], ""), ""),
        at: display(firstValue(record, ["timestamp", "occurredAt", "at", "time"], ""), ""),
        status: normalizedNodeStatus(firstValue(record, ["status", "state"], "queued")),
        kind: display(firstValue(record, ["kind", "type", "eventType"], "status"), "status").toLowerCase().replace(/[\s-]+/gu, "_"),
        toolCallId: display(firstValue(record, ["toolCallId", "toolId"], ""), ""),
        promptId: display(firstValue(record, ["promptId", "eraId"], ""), ""),
        visibility: display(firstValue(record, ["visibility", "action"], ""), ""),
        eventType: display(firstValue(record, ["eventType", "type", "kind"], "status"), "status"),
        stage: display(firstValue(record, ["stage", "phase", "chapter"], ""), "").toLowerCase().replace(/[\s_]+/gu, "-"),
        chapter: display(firstValue(record, ["chapter", "stage", "phase"], ""), "").toLowerCase().replace(/[\s_]+/gu, "-"),
      };
    });

    const eventCount = Math.max(replay.length, numberOr(firstValue(runInput, ["eventCount", "totalEvents"], replay.length), replay.length));
    const eventIndex = Math.max(0, Math.min(eventCount, numberOr(firstValue(runInput, ["eventIndex", "currentEventIndex"], replay.length), replay.length)));

    return {
      schemaVersion: display(input.schemaVersion, "unknown"),
      source: display(firstValue(sourceInput, ["label", "name", "kind"], input.source), "local observer"),
      run: hasRun ? {
        id: display(firstValue(runInput, ["id", "runId", "key"], input.runId), "unidentified run"),
        title: display(firstValue(runInput, ["title", "name", "label"], "Live execution"), "Live execution"),
        task: display(firstValue(runInput, ["task", "description", "summary"], input.task), "Governed execution"),
        status: normalizedStatus(firstValue(runInput, ["status", "state", "runStatus"], input.status)),
        stage: display(firstValue(runInput, ["stage", "currentStage", "phase"], "Observing"), "Observing"),
        currentStage: display(firstValue(runInput, ["currentStage", "stage", "phase"], "Observing"), "Observing"),
        startedAt: display(firstValue(runInput, ["startedAt", "startTime"], "—"), "—"),
        updatedAt: display(firstValue(runInput, ["updatedAt", "lastUpdatedAt", "observedAt"], "—"), "—"),
        transport: display(firstValue(runInput, ["transport", "sourceTransport"], "snapshot"), "snapshot"),
        eventIndex,
        eventCount,
      } : null,
      sessionInfo: {
        title: display(firstValue(sessionInput, ["title", "name"], firstValue(runInput, ["title", "name"], "Live execution")), "Live execution"),
        activity: display(firstValue(sessionInput, ["activity", "latestActivity", "summary"], ""), ""),
        workerCount: Math.max(0, numberOr(firstValue(sessionInput, ["workerCount", "agentCount", "nodeCount"], nodes.filter((node) => node.kind !== "stage").length), 0)),
        eventCount: Math.max(0, numberOr(firstValue(sessionInput, ["eventCount", "totalEvents"], eventCount), eventCount)),
        runtime: display(firstValue(sessionInput, ["runtime", "transport"], firstValue(runInput, ["transport"], "local")), "local"),
        mode: display(firstValue(sessionInput, ["mode", "sessionMode"], "observed"), "observed"),
        lastPromptSummary: display(firstValue(sessionInput, ["lastPromptSummary", "promptSummary"], "Prompt summary withheld"), "Prompt summary withheld"),
        fileChangeCount: Math.max(0, numberOr(firstValue(sessionInput, ["fileChangeCount", "fileSnapshots"], 0), 0)),
        artifactCount: Math.max(0, numberOr(firstValue(sessionInput, ["artifactCount", "artifacts"], 0), 0)),
        plannedCount: Math.max(0, numberOr(firstValue(sessionInput, ["plannedCount"], 0), 0)),
        completedCount: Math.max(0, numberOr(firstValue(sessionInput, ["completedCount"], 0), 0)),
        failedCount: Math.max(0, numberOr(firstValue(sessionInput, ["failedCount"], 0), 0)),
        blockedCount: Math.max(0, numberOr(firstValue(sessionInput, ["blockedCount"], 0), 0)),
        proofState: display(firstValue(sessionInput, ["proofState"], "structural evidence only"), "structural evidence only"),
      },
      repository: {
        name: normalizedAvailability(repositoryInput.name, "Repository name unavailable"),
        branch: normalizedAvailability(repositoryInput.branch, "Branch unavailable"),
        worktree: normalizedAvailability(repositoryInput.worktree, "Worktree unavailable"),
        pullRequest: normalizedAvailability(repositoryInput.pullRequest, "Pull request unavailable"),
        diff: normalizedAvailability(repositoryInput.diff, "Diff telemetry unavailable"),
      },
      workspace: {
        name: normalizedAvailability(workspaceInput.name, "Workspace name unavailable"),
        workspaceId: normalizedAvailability(workspaceInput.workspaceId, "Workspace identifier unavailable"),
        transcript: normalizedAvailability(workspaceInput.transcript, "Conversation transcript unavailable"),
        terminal: normalizedAvailability(workspaceInput.terminal, "Terminal adapter telemetry unavailable"),
      },
      contextTransfers: contextTransferInput.slice(0, 256).map((item, index) => {
        const record = item && typeof item === "object" && !Array.isArray(item) ? item : {};
        const rawState = display(firstValue(record, ["state", "status", "deliveryState"], "planned"), "planned").toLowerCase().replace(/[\s-]+/gu, "_");
        const state = ["observed", "accepted"].includes(rawState) ? rawState : "planned";
        return {
          id: display(firstValue(record, ["id", "transferId"], "transfer-" + (index + 1)), "transfer-" + (index + 1)),
          state,
          fromNodeId: display(firstValue(record, ["fromNodeId", "sourceNodeId"], "unavailable"), "unavailable"),
          toNodeId: display(firstValue(record, ["toNodeId", "targetNodeId"], "unavailable"), "unavailable"),
          kind: display(firstValue(record, ["kind"], "context_handoff"), "context_handoff"),
          summaryCount: nullableCount(record.summaryCount),
          decisionCount: nullableCount(record.decisionCount),
          fileCount: nullableCount(record.fileCount),
          evidenceCount: nullableCount(record.evidenceCount),
          observedAt: display(firstValue(record, ["observedAt"], ""), ""),
          digest: display(firstValue(record, ["digest"], ""), ""),
          bytes: nullableCount(record.bytes),
          compactionState: display(firstValue(record, ["compactionState"], "unavailable"), "unavailable"),
          omittedCount: nullableCount(record.omittedCount),
          omissionReason: display(firstValue(record, ["omissionReason"], ""), ""),
          downstreamAcceptanceState: display(firstValue(record, ["downstreamAcceptanceState"], "unavailable"), "unavailable"),
          evidenceRefs: Array.isArray(record.evidenceRefs) ? record.evidenceRefs.slice(0, 24).map((value) => display(value, "")).filter(Boolean) : [],
        };
      }),
      nodes,
      edges,
      evidence,
      prompts,
      toolCalls,
      provenance,
      replay,
      control,
      permissions: input.permissions && typeof input.permissions === "object" ? input.permissions : {},
    };
  }

  function clearChildren(element) {
    if (!element) return;
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  function setText(element, value, fallback) {
    if (element) element.textContent = localize(display(value, fallback));
  }

  function makeElement(tagName, className, value) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = localize(display(value));
    return element;
  }

  function formatTime(value) {
    const text = display(value, "—");
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) {
      try {
        return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
      } catch {
        return text;
      }
    }
    return text;
  }

  function formatDuration(firstAt, lastAt) {
    const startedAt = new Date(display(firstAt, ""));
    const endedAt = new Date(display(lastAt, ""));
    if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) return "—";
    const milliseconds = Math.max(0, endedAt.getTime() - startedAt.getTime());
    if (milliseconds < 1000) return milliseconds + " ms";
    const seconds = Math.round(milliseconds / 1000);
    if (seconds < 60) return seconds + " s";
    const minutes = Math.floor(seconds / 60);
    return minutes + "m " + String(seconds % 60).padStart(2, "0") + "s";
  }

  function formatSessionTime(value) {
    const date = new Date(display(value, ""));
    if (Number.isNaN(date.getTime())) return currentLanguage === "zh" ? "时间未知" : "Unknown time";
    try {
      return new Intl.DateTimeFormat(currentLanguage === "zh" ? "zh-CN" : "en", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(date);
    } catch {
      return display(value, currentLanguage === "zh" ? "时间未知" : "Unknown time");
    }
  }

  function stateCopy(status) {
    if (status === "live") return localize("Live");
    if (status === "in_doubt") return localize("In doubt");
    if (status === "completed") return localize("Completed");
    if (status === "running") return localize("Running");
    if (status === "pending" || status === "queued") return localize("Queued");
    if (status === "failed") return localize("Failed");
    if (status === "blocked") return localize("Blocked");
    if (status === "skipped") return localize("Skipped");
    return localize("Stale");
  }

  function updateConnection(kind, message) {
    if (connectionLabel) connectionLabel.textContent = localize(message);
    if (connectionDot) connectionDot.dataset.connection = kind;
  }

  function updateHeader(snapshot) {
    setText(title, snapshot.run.title, "Live execution");
    setText(contextTitle, snapshot.run.title, "Live execution");
    setText(statusTitle, snapshot.run.title, "Live execution");
    setText(runId, "Run · " + snapshot.run.id.slice(-8), "unidentified run");
    setText(stage, snapshot.run.stage, "Observing");
    setText(started, formatTime(snapshot.run.startedAt), "—");
    setText(updated, formatTime(snapshot.run.updatedAt), "—");
    setText(source, snapshot.source, "local observer");
    const activeWorkers = new Set(graphNodesForSnapshot(snapshot)
      .filter((node) => ["running", "active"].includes(node.status))
      .map((node) => node.agent)
      .filter(Boolean));
    setText(runProgress, "Event " + snapshot.run.eventIndex + " of " + snapshot.run.eventCount, "—");
    setText(runWorkers, activeWorkers.size
      ? activeWorkers.size + " active worker" + (activeWorkers.size === 1 ? "" : "s")
      : "No active workers", "—");
    setText(nodeCount, graphNodesForSnapshot(snapshot).length + " nodes", "0 nodes");
    setText(contextTask, snapshot.run.task, "Governed execution");
    setText(contextStage, snapshot.run.stage, "in_doubt");
    setText(contextStatus, stateCopy(snapshot.run.status), "In doubt");
    setText(contextUpdated, formatTime(snapshot.run.updatedAt), "—");
    setText(contextSource, snapshot.source, "local observer");
    setText(contextNodes, String(graphNodesForSnapshot(snapshot).length), "0");
    setText(contextEvents, String(snapshot.run.eventCount || snapshot.replay.length || 0), "0");
    setText(contextEvidence, String(snapshot.evidence.length || 0), "0");
    const status = snapshot.run.status;
    if (stateChip) stateChip.dataset.state = status;
    setText(stateLabel, stateCopy(status), "Stale");
    if (liveRegion) liveRegion.textContent = localize("Run snapshot updated: " + snapshot.run.title);
    if (lastUpdate) lastUpdate.textContent = localize("Last observed " + formatTime(snapshot.run.updatedAt));
  }

  function nodeClass(status) {
    return status === "in_doubt" ? "in-doubt" : status;
  }

  function usefulNodeMeta(value) {
    const normalized = display(value, "").trim().toLowerCase();
    return normalized && !["—", "unknown", "unavailable", "in_doubt", "in doubt", "unassigned", "local"].includes(normalized);
  }

  function edgeMarkerId(status) {
    return "live-edge-arrow-" + nodeClass(status);
  }

  const STAGE_ORDER = [
    "critical",
    "fetch",
    "thinking",
    "execution",
    "review",
    "meta-review",
    "verification",
    "evolution",
  ];
  const STAGE_MATCH_ORDER = [...STAGE_ORDER].sort((left, right) => right.length - left.length);

  function stageIndex(node) {
    const text = (String(node.id) + " " + String(node.label)).toLowerCase().replace(/[\s_]+/gu, "-");
    const matched = STAGE_MATCH_ORDER.find((stageName) => text === stageName || text.startsWith(stageName + "-") || text.endsWith("-" + stageName) || text.includes("-" + stageName + "-"));
    return matched ? STAGE_ORDER.indexOf(matched) : -1;
  }

  function graphNodesForSnapshot(snapshot) {
    const executionNodes = snapshot.nodes.filter((node) => !["stage", "chapter", "stage_summary"].includes(node.kind));
    return executionNodes.length ? executionNodes : snapshot.nodes;
  }

  function graphEdgesForSnapshot(snapshot, nodes = graphNodesForSnapshot(snapshot)) {
    const ids = new Set(nodes.map((node) => node.id));
    return snapshot.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  }

  function layoutGraph(snapshot) {
    const nodes = graphNodesForSnapshot(snapshot);
    const graphEdges = graphEdgesForSnapshot(snapshot, nodes);
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const parentById = new Map(graphEdges.map((edge) => [edge.to, edge.from]));
    const stageNodes = new Map();
    const stageFor = new Map();
    const branchSlots = new Map();
    const positions = new Map();
    const cardWidth = 168;
    const cardHeight = 116;
    const spineColumns = layoutMode === "compact" ? 4 : 8;
    const columnGap = layoutMode === "compact" ? 220 : 184;
    const rowGap = layoutMode === "compact" ? 150 : 126;
    const top = 38;
    const spineRows = Math.ceil(STAGE_ORDER.length / spineColumns);
    const branchTop = top + spineRows * rowGap + 32;
    // A live projection is an entity graph whenever it has explicit edges or
    // parent links. Older snapshots omitted kind on some nodes, which made
    // the previous heuristic fall through to the stage layout and stack all
    // workers into one branch slot.
    const entityGraph = graphEdges.length > 0
      || nodes.some((node) => node.parentId)
      || nodes.some((node) => ["agent", "worker", "workflow", "group", "main_agent", "subagent"].includes(node.kind));

    if (entityGraph) {
      const depthById = new Map();
      function depthFor(id, seen = new Set()) {
        if (depthById.has(id)) return depthById.get(id);
        if (seen.has(id)) return 0;
        seen.add(id);
        const parentId = parentById.get(id) || nodeById.get(id)?.parentId;
        const depth = parentId && nodeById.has(parentId) ? depthFor(parentId, seen) + 1 : 0;
        depthById.set(id, depth);
        return depth;
      }
      const lanes = new Map();
      for (const node of nodes) {
        const depth = depthFor(node.id);
        const lane = lanes.get(depth) || [];
        lane.push(node);
        lanes.set(depth, lane);
      }
      for (const [depth, lane] of lanes) {
        lane.sort((left, right) => String(left.firstAt || "").localeCompare(String(right.firstAt || "")) || left.label.localeCompare(right.label));
        const sqrtColumns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(lane.length))));
        const laneColumns = depth === 0 ? 1 : depth === 1 ? 1 : Math.max(sqrtColumns, Math.min(4, lane.length));
        const laneStartX = [...lanes.entries()]
          .filter(([candidateDepth]) => candidateDepth < depth)
          .sort(([left], [right]) => left - right)
          .reduce((offset, [, candidateLane]) => {
            const candidateColumns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(candidateLane.length))));
            return offset + Math.max(238, candidateColumns * 210 + 28);
          }, 44);
        lane.forEach((node, index) => {
          positions.set(node.id, {
            x: laneStartX + (index % laneColumns) * 210,
            y: 42 + Math.floor(index / laneColumns) * 144,
            width: 184,
            height: cardHeight,
            spine: depth === 0,
          });
        });
      }
      let maxX = 0;
      let maxY = 0;
      for (const position of positions.values()) {
        maxX = Math.max(maxX, position.x + position.width);
        maxY = Math.max(maxY, position.y + position.height);
      }
      return {
        positions,
        bounds: { width: Math.max(680, maxX + 54), height: Math.max(360, maxY + 54) },
      };
    }

    function inheritedStage(id, seen = new Set()) {
      if (stageFor.has(id)) return stageFor.get(id);
      if (seen.has(id)) return -1;
      seen.add(id);
      const own = stageIndex(nodeById.get(id) || { id, label: "" });
      if (own >= 0) {
        stageFor.set(id, own);
        return own;
      }
      const parent = parentById.get(id);
      const inherited = parent ? inheritedStage(parent, seen) : -1;
      stageFor.set(id, inherited);
      return inherited;
    }

    for (const node of nodes) {
      const stage = inheritedStage(node.id);
      if (stage >= 0 && !stageNodes.has(stage)) stageNodes.set(stage, node.id);
    }
    nodes.forEach((node, index) => {
      let column = inheritedStage(node.id);
      if (column < 0) column = Math.min(STAGE_ORDER.length - 1, Math.max(0, index));
      const isSpine = stageNodes.get(column) === node.id;
      if (isSpine) {
        const row = Math.floor(column / spineColumns);
        const withinRow = column % spineColumns;
        const visualColumn = row % 2 === 0 ? withinRow : spineColumns - 1 - withinRow;
        positions.set(node.id, {
          x: 40 + visualColumn * columnGap,
          y: top + row * rowGap,
          width: cardWidth,
          height: cardHeight,
          spine: true,
        });
      } else {
        const slot = branchSlots.get(column) || 0;
        branchSlots.set(column, slot + 1);
        const row = Math.floor(column / spineColumns);
        const withinRow = column % spineColumns;
        const visualColumn = row % 2 === 0 ? withinRow : spineColumns - 1 - withinRow;
        const branchDirection = visualColumn >= spineColumns / 2 ? -1 : 1;
        const branchColumn = Math.max(
          0,
          Math.min(spineColumns - 1, visualColumn + branchDirection * slot),
        );
        positions.set(node.id, {
          x: 40 + branchColumn * columnGap,
          y: branchTop,
          width: cardWidth,
          height: cardHeight,
          spine: false,
        });
      }
    });

    let maxX = 0;
    let maxY = 0;
    for (const position of positions.values()) {
      maxX = Math.max(maxX, position.x + position.width);
      maxY = Math.max(maxY, position.y + position.height);
    }
    return {
      positions,
      bounds: {
        width: Math.max(680, maxX + 42),
        height: Math.max(300, maxY + 42),
      },
    };
  }

  function edgeGeometry(from, to) {
    const fromCenterX = from.x + from.width / 2;
    const fromCenterY = from.y + from.height / 2;
    const toCenterX = to.x + to.width / 2;
    const toCenterY = to.y + to.height / 2;
    const deltaX = toCenterX - fromCenterX;
    const deltaY = toCenterY - fromCenterY;
    const vertical = Math.abs(deltaY) > Math.abs(deltaX) * .72;
    if (vertical) {
      const direction = deltaY >= 0 ? 1 : -1;
      const x1 = fromCenterX;
      const y1 = direction > 0 ? from.y + from.height : from.y;
      const x2 = toCenterX;
      const y2 = direction > 0 ? to.y : to.y + to.height;
      const distance = Math.max(30, Math.abs(y2 - y1) * .48);
      return {
        x1,
        y1,
        x2,
        y2,
        path: "M " + x1 + " " + y1 + " C " + x1 + " " + (y1 + distance * direction) + ", " + x2 + " " + (y2 - distance * direction) + ", " + x2 + " " + y2,
      };
    }
    const direction = deltaX >= 0 ? 1 : -1;
    const x1 = direction > 0 ? from.x + from.width : from.x;
    const y1 = fromCenterY;
    const x2 = direction > 0 ? to.x : to.x + to.width;
    const y2 = toCenterY;
    const distance = Math.max(30, Math.abs(x2 - x1) * .48);
    return {
      x1,
      y1,
      x2,
      y2,
      path: "M " + x1 + " " + y1 + " C " + (x1 + distance * direction) + " " + y1 + ", " + (x2 - distance * direction) + " " + y2 + ", " + x2 + " " + y2,
    };
  }

  function updateCamera(nextCamera = camera) {
    camera = {
      x: Number.isFinite(nextCamera.x) ? nextCamera.x : 0,
      y: Number.isFinite(nextCamera.y) ? nextCamera.y : 0,
      scale: Math.max(.28, Math.min(1.6, Number.isFinite(nextCamera.scale) ? nextCamera.scale : 1)),
    };
    if (graphScene) {
      graphScene.style.transform = "translate(" + camera.x + "px, " + camera.y + "px) scale(" + camera.scale + ")";
    }
    if (graph) graph.dataset.semanticZoom = camera.scale < .42 ? "cell" : "card";
    updateMinimap();
  }

  function setCameraMode(mode) {
    cameraMode = ["overview", "follow", "manual"].includes(mode) ? mode : "manual";
    graphFollowing = cameraMode === "follow";
    if (graphFollow) {
      graphFollow.dataset.active = graphFollowing ? "true" : "false";
      graphFollow.setAttribute("aria-pressed", String(graphFollowing));
    }
    if (graph) graph.dataset.following = graphFollowing ? "true" : "false";
    setText(cameraModeLabel, cameraMode[0].toUpperCase() + cameraMode.slice(1), "Manual");
  }

  function setGraphFollowing(active) {
    setCameraMode(active ? "follow" : "manual");
  }

  function centerGraphNode(nodeId) {
    if (!graph || !nodeId) return;
    const card = graphState.nodeElements.get(nodeId);
    if (window.matchMedia?.("(max-width: 720px)").matches && card) {
      graph.scrollTo({
        top: Math.max(0, card.offsetTop - graph.clientHeight / 2 + card.offsetHeight / 2),
        left: 0,
        behavior: reducedMotion.matches ? "auto" : "smooth",
      });
      return;
    }
    const position = graphState.positions.get(nodeId);
    if (!position) return;
    updateCamera({
      ...camera,
      x: graph.clientWidth / 2 - (position.x + position.width / 2) * camera.scale,
      y: graph.clientHeight / 2 - (position.y + position.height / 2) * camera.scale,
    });
  }

  function setInspectorOpen(open) {
    if (!evidencePanel) return;
    const active = Boolean(open);
    const changed = evidencePanel.dataset.open !== (active ? "true" : "false");
    evidencePanel.dataset.open = active ? "true" : "false";
    evidencePanel.setAttribute("aria-hidden", String(!active));
    if ("inert" in evidencePanel) evidencePanel.inert = !active;
    evidenceToggle?.setAttribute("aria-expanded", String(active));
    workspace?.setAttribute("data-inspector-open", active ? "true" : "false");
    if (changed) repositionCameraAfterInspector(active);
  }

  function safeStoredChoice(key, allowed, fallback) {
    try {
      const sessionValue = window.sessionStorage?.getItem(key);
      if (allowed.includes(sessionValue)) return sessionValue;
      const localValue = window.localStorage?.getItem(key);
      if (allowed.includes(localValue)) return localValue;
    } catch {}
    return fallback;
  }

  function persistStoredChoice(key, value) {
    try { window.sessionStorage?.setItem(key, value); } catch {}
    try { window.localStorage?.setItem(key, value); } catch {}
  }

  function setWorkView(view, { focus = false, persist = true } = {}) {
    currentWorkView = WORK_VIEWS.includes(view) ? view : "run";
    workViewTabs.forEach((tab) => {
      const selected = tab.dataset.liveWorkView === currentWorkView;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      tab.dataset.active = selected ? "true" : "false";
      if (selected && focus) tab.focus();
    });
    const graphPanel = app.querySelector("[data-live-run-view]");
    if (repositoryView) repositoryView.hidden = currentWorkView !== "repository";
    if (workspaceView) workspaceView.hidden = currentWorkView !== "workspace";
    if (graphPanel) graphPanel.hidden = currentWorkView !== "run";
    workspace?.setAttribute("data-work-view", currentWorkView);
    if (currentWorkView !== "run") setInspectorOpen(false);
    if (persist) persistStoredChoice(WORK_VIEW_STORAGE_KEY, currentWorkView);
    if (currentWorkView === "run" && currentSnapshot) {
      const refreshCamera = () => reconcileCamera();
      if (window.requestAnimationFrame) window.requestAnimationFrame(refreshCamera);
      else refreshCamera();
    }
  }

  function setInspectorTab(tabName, { focus = false } = {}) {
    currentInspectorTab = INSPECTOR_TABS.includes(tabName) ? tabName : "summary";
    inspectorTabs.forEach((tab) => {
      const selected = tab.dataset.liveInspectorTab === currentInspectorTab;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    });
    inspectorPanels.forEach((panel) => {
      const selected = panel.dataset.liveInspectorPanel === currentInspectorTab;
      panel.hidden = !selected;
      if (selected) setText(evidenceCount, String(Number(panel.dataset.itemCount) || 0).padStart(2, "0"), "00");
    });
  }

  function bindRovingTabs(tabs, values, select) {
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => select(tab.dataset.liveWorkView || tab.dataset.liveInspectorTab, { focus: false }));
      tab.addEventListener("keydown", (event) => {
        const current = values.indexOf(tab.dataset.liveWorkView || tab.dataset.liveInspectorTab);
        if (current < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home"
          ? 0
          : event.key === "End"
            ? values.length - 1
            : (current + (event.key === "ArrowRight" ? 1 : -1) + values.length) % values.length;
        select(values[next], { focus: true });
      });
    });
  }

  function repositionCameraAfterInspector(active) {
    const reposition = () => reconcileCamera({ inspectorOpen: active });
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(() => window.requestAnimationFrame(reposition));
    } else {
      window.setTimeout(reposition, 0);
    }
    workspace?.addEventListener("transitionend", reposition, { once: true });
  }

  function followTargetId() {
    return selectedNodeId
      || currentSnapshot?.replay[currentReplayIndex]?.nodeId
      || currentSnapshot?.nodes.find((node) => node.status === "running")?.id
      || null;
  }

  function reconcileCamera({ inspectorOpen = evidencePanel?.dataset.open === "true" } = {}) {
    if (!graph || !currentSnapshot) return;
    if (cameraMode === "overview") {
      fitGraph();
      return;
    }
    if (cameraMode === "follow") {
      if (inspectorOpen && camera.scale < .68) updateCamera({ ...camera, scale: .68 });
      centerGraphNode(followTargetId());
      return;
    }
    updateMinimap();
  }

  function setDialogOpen(dialog, open) {
    if (!dialog) return;
    const active = Boolean(open);
    if (active) {
      for (const other of [sessionsDialog, helpDialog, infoDialog]) {
        if (other && other !== dialog) {
          other.hidden = true;
          other.setAttribute("aria-hidden", "true");
        }
      }
      dialogOpener = document.activeElement;
    }
    dialog.hidden = !active;
    dialog.setAttribute("aria-hidden", String(!active));
    if (active) dialog.querySelector("button, select, [tabindex]")?.focus();
    else if (dialogOpener && typeof dialogOpener.focus === "function") {
      dialogOpener.focus();
      dialogOpener = null;
    }
  }

  function closeTransientUi() {
    for (const dialog of [sessionsDialog, helpDialog, infoDialog]) setDialogOpen(dialog, false);
  }

  function updateMinimap() {
    if (!graphMinimap || !graphMinimapScene || !graphMinimapViewport) return;
    const graphWidth = Math.max(1, graph?.clientWidth || 760);
    const graphHeight = Math.max(1, graph?.clientHeight || 420);
    const overflowing = graphState.bounds.width > graphWidth * 1.05 || graphState.bounds.height > graphHeight * 1.05;
    graphMinimap.hidden = !overflowing;
    if (!overflowing) return;
    const miniWidth = Math.max(1, graphMinimap.clientWidth || 180);
    const miniHeight = Math.max(1, graphMinimap.clientHeight || 100);
    const miniScale = Math.min((miniWidth - 12) / Math.max(1, graphState.bounds.width), (miniHeight - 12) / Math.max(1, graphState.bounds.height));
    graphMinimapScene.style.width = graphState.bounds.width + "px";
    graphMinimapScene.style.height = graphState.bounds.height + "px";
    graphMinimapScene.style.transform = "scale(" + miniScale + ")";
    const viewportWidth = (graph?.clientWidth || miniWidth) / camera.scale * miniScale;
    const viewportHeight = (graph?.clientHeight || miniHeight) / camera.scale * miniScale;
    graphMinimapViewport.style.width = Math.max(8, viewportWidth) + "px";
    graphMinimapViewport.style.height = Math.max(8, viewportHeight) + "px";
    graphMinimapViewport.style.left = Math.max(0, -camera.x / camera.scale * miniScale) + "px";
    graphMinimapViewport.style.top = Math.max(0, -camera.y / camera.scale * miniScale) + "px";
  }

  function fitGraph() {
    if (!graph || !graphState.bounds.width) return;
    const width = graph.clientWidth || 760;
    const height = graph.clientHeight || 420;
    const padding = 26;
    const scale = Math.max(.42, Math.min(1.1, Math.min((width - padding * 2) / graphState.bounds.width, (height - padding * 2) / graphState.bounds.height)));
    updateCamera({
      scale,
      x: (width - graphState.bounds.width * scale) / 2,
      y: (height - graphState.bounds.height * scale) / 2,
    });
    setCameraMode("overview");
  }

  function zoomGraph(factor, anchorX, anchorY) {
    if (!graph) return;
    const localX = Number.isFinite(anchorX) ? anchorX : graph.clientWidth / 2;
    const localY = Number.isFinite(anchorY) ? anchorY : graph.clientHeight / 2;
    const worldX = (localX - camera.x) / camera.scale;
    const worldY = (localY - camera.y) / camera.scale;
    const scale = Math.max(.28, Math.min(1.6, camera.scale * factor));
    updateCamera({ scale, x: localX - worldX * scale, y: localY - worldY * scale });
    setCameraMode("manual");
  }

  function updateSelectedNodeVisuals() {
    const selected = currentSnapshot?.nodes.find((node) => node.id === selectedNodeId) || null;
    for (const [id, card] of graphState.nodeElements.entries()) {
      const active = Boolean(selected && id === selected.id);
      card.dataset.selected = active ? "true" : "false";
      card.setAttribute("aria-selected", String(active));
    }
    const linked = selected
      ? currentSnapshot.evidence.filter((item) => item.nodeId === selected.id)
      : [];
    const provenance = selected
      ? currentSnapshot.provenance.find((item) => item.nodeId === selected.id) || null
      : null;
    const promptIds = new Set([
      provenance?.triggerPromptId,
      ...currentSnapshot?.toolCalls.filter((item) => selected && item.nodeId === selected.id).map((item) => item.promptId) || [],
    ].filter(Boolean));
    const prompts = selected
      ? currentSnapshot.prompts.filter((item) => item.nodeId === selected.id || promptIds.has(item.id))
      : [];
    const activePrompt = prompts.at(-1) || null;
    const nodeTools = selected ? currentSnapshot.toolCalls.filter((item) => item.nodeId === selected.id) : [];
    const nodeEvents = selected ? currentSnapshot.replay.filter((item) => item.nodeId === selected.id) : [];
    const toolCount = selected ? Math.max(selected.toolCount, nodeTools.length) : 0;
    setText(selectedNodeLabel, selected ? "Selected · " + selected.label : "Select a node to inspect provenance", "Select a node to inspect provenance");
    setText(selectedNodeEvidence, selected ? linked.length + " linked evidence item" + (linked.length === 1 ? "" : "s") + " · " + nodeTools.length + " tools · " + nodeEvents.length + " events" : "Evidence stays visible in the drawer", "Evidence stays visible in the drawer");
    setText(selectedNodeStatus, selected ? "Status · " + selected.status : "Status · —", "Status · —");
    setText(selectedNodeOwner, selected ? "Owner · " + selected.agent : "Owner · —", "Owner · —");
    setText(selectedNodeRuntime, selected ? "Runtime · " + selected.runtime : "Runtime · —", "Runtime · —");
    setText(selectedNodeModel, selected ? "Model · " + (selected.model || "—") : "Model · —", "Model · —");
    setText(selectedNodeDuration, selected ? "Duration · " + formatDuration(selected.firstAt, selected.lastAt) : "Duration · —", "Duration · —");
    setText(selectedNodeTools, selected ? "Tools · " + toolCount + (usefulNodeMeta(selected.latestTool) ? " · " + selected.latestTool : "") : "Tools · —", "Tools · —");
    setText(selectedNodeTokens, selected ? "Tokens · " + selected.outputTokens : "Tokens · —", "Tokens · —");
    if (selectedNodeLoadout) {
      const loadout = selected?.loadout || {};
      const labels = [
        ["skills", loadout.skillNames, "skills"],
        ["mcp", loadout.mcpNames, "MCP"],
        ["tools", loadout.toolNames, "tools"],
        ["commands", loadout.commandNames, "commands"],
      ].filter(([, names, key]) => Number(loadout[key]) > 0 || names?.length);
      const detail = labels.map(([, names, key]) => {
        const count = Number(loadout[key]) || names?.length || 0;
        return key.toUpperCase() + " " + count + (names?.length ? " · " + names.slice(0, 4).join(", ") : "");
      }).join(" | ");
      setText(selectedNodeLoadout, selected ? "Loadout · " + (detail || "—") : "Loadout · —", "Loadout · —");
    }
    setText(selectedNodeSummary, selected ? selected.summary : "Select a node to inspect its execution summary.", "Select a node to inspect its execution summary.");
    setText(selectedNodeEvidenceDetail, selected?.terminalEvidence || linked[0]?.detail || (selected ? "No terminal evidence is linked to this node yet." : "Evidence details appear when a node is selected."), "Evidence details appear when a node is selected.");
    setText(selectedNodeProvenance, selected ? "Source · " + (provenance?.reasoningExcerpt || (selected.parentId ? "spawned by " + selected.parentId : "run root")) : "Source · —", "Source · —");
    setText(selectedNodePrompt, selected ? "Prompt era · " + (activePrompt ? activePrompt.label + " · " + activePrompt.excerpt : "—") : "Prompt era · —", "Prompt era · —");
    renderInspectorHistory({ selected, linked, prompts, nodeTools, nodeEvents });
  }

  function renderInspectorHistory({ selected, linked, prompts, nodeTools, nodeEvents }) {
    const renderItems = (list, panelName, items, emptyMessage) => {
      clearChildren(list);
      const panel = inspectorPanels.find((item) => item.dataset.liveInspectorPanel === panelName);
      if (panel) panel.dataset.itemCount = String(items.length);
      if (!items.length) {
        list?.append(makeElement("p", "panel-empty", emptyMessage));
        return;
      }
      items.forEach((item) => {
      const entry = makeElement("article", "evidence-item history-item history-" + item.kind);
      entry.dataset.evidenceId = item.id;
      entry.dataset.nodeId = item.nodeId || selected?.id || "";
      entry.dataset.associated = selected && entry.dataset.nodeId === selected.id ? "true" : "false";
      entry.dataset.historyKind = item.kind;
      if (item.transferState) {
        entry.dataset.transferState = item.transferState;
        entry.dataset.deliveryObserved = item.transferState === "observed" || item.transferState === "accepted" ? "true" : "false";
      }
      entry.setAttribute("role", "listitem");
      const top = makeElement("div", "evidence-item-top");
      const label = makeElement("span", "evidence-kind", item.kind + " · " + item.label);
      top.append(label, makeElement("time", "evidence-time", formatTime(item.at)));
      const detail = makeElement("p", "evidence-detail", item.detail);
      const footer = makeElement("div", "history-footer");
      footer.append(makeElement("span", "evidence-status evidence-status-" + nodeClass(normalizedNodeStatus(item.status)), item.status));
      if (item.sourceRef) footer.append(makeElement("span", "history-source", item.sourceRef));
      entry.append(top, detail, footer);
        list?.append(entry);
      });
    };
    const selectedEvidence = selected ? linked : currentSnapshot?.evidence || [];
    const conversation = (selected ? prompts : currentSnapshot?.prompts || []).map((item) => ({
      id: item.id, kind: "prompt_summary", label: item.label, detail: "Prompt summary · " + item.excerpt, at: item.at, status: "observed", sourceRef: item.id, nodeId: item.nodeId,
    }));
    if (!conversation.length && currentSnapshot?.workspace.transcript.state === "observed") {
      conversation.push({ id: "transcript-availability", kind: "conversation", label: "Transcript availability", detail: currentSnapshot.workspace.transcript.summary, at: currentSnapshot.run.updatedAt, status: "observed", nodeId: selected?.id || "" });
    }
    const terminal = [
      ...(selected?.terminalEvidence ? [{ id: selected.id + "-terminal", kind: "terminal", label: "Terminal evidence", detail: selected.terminalEvidence, at: selected.lastAt, status: selected.status, nodeId: selected.id }] : []),
    ];
    if (!terminal.length && currentSnapshot?.workspace.terminal.state === "observed") {
      terminal.push({ id: "terminal-availability", kind: "terminal", label: "Terminal telemetry", detail: currentSnapshot.workspace.terminal.summary, at: currentSnapshot.run.updatedAt, status: "observed", nodeId: selected?.id || "" });
    }
    const changes = [];
    const changeCount = currentSnapshot?.sessionInfo.fileChangeCount || 0;
    if (currentSnapshot?.repository.diff.state === "observed") changes.push({ id: "diff-observed", kind: "diff", label: "Diff telemetry", detail: currentSnapshot.repository.diff.summary, at: currentSnapshot.run.updatedAt, status: "observed", nodeId: selected?.id || "" });
    if (changeCount > 0) changes.push({ id: "file-snapshots-observed", kind: "file_snapshots", label: changeCount + " file snapshots", detail: "Snapshot count observed; file diff content is not included", at: currentSnapshot?.run.updatedAt, status: "observed", nodeId: selected?.id || "" });
    const evidence = [
      ...selectedEvidence.map((item) => ({ id: item.id, kind: "evidence", label: item.label, detail: item.detail, at: item.at, status: item.status, sourceRef: item.sourceRef, nodeId: item.nodeId })),
      ...(selected ? nodeTools : currentSnapshot?.toolCalls || []).map((item) => ({ id: item.id, kind: "tool_activity", label: item.name, detail: item.summary, at: item.startedAt || item.endedAt, status: item.state, sourceRef: item.promptId, nodeId: item.nodeId })),
    ];
    const transfers = (currentSnapshot?.contextTransfers || [])
      .filter((item) => !selected || item.fromNodeId === selected.id || item.toNodeId === selected.id)
      .map((item) => {
        const counts = [["summaries", item.summaryCount], ["decisions", item.decisionCount], ["files", item.fileCount], ["evidence", item.evidenceCount]].filter(([, value]) => Number.isFinite(value)).map(([label, value]) => value + " " + label).join(" · ");
        const compact = item.compactionState === "omitted"
          ? "omitted " + (Number.isFinite(item.omittedCount) ? item.omittedCount : "") + (item.omissionReason ? " · " + item.omissionReason : "")
          : item.compactionState;
        const proof = [item.downstreamAcceptanceState, counts, compact, Number.isFinite(item.bytes) ? item.bytes + " bytes" : "", item.digest ? "digest " + item.digest.slice(0, 12) : "", item.evidenceRefs.length ? "evidence refs " + item.evidenceRefs.join(", ") : ""].filter(Boolean).join(" · ");
        return { id: item.id, kind: item.kind, label: item.fromNodeId + " → " + item.toNodeId, detail: proof || (item.state === "planned" ? "Planned dependency; delivery not observed" : "Context delivery observed"), at: item.observedAt, status: item.state, sourceRef: item.state === "planned" ? "planned · delivery not observed" : item.state + " · delivery observed", nodeId: item.toNodeId, transferState: item.state };
      });
    renderItems(conversationList, "conversation", conversation, "Conversation transcript unavailable for this selection.");
    renderItems(terminalList, "terminal", terminal, "Terminal adapter telemetry unavailable for this selection.");
    renderItems(changesList, "changes", changes, "Diff telemetry unavailable for this selection.");
    renderItems(evidenceList, "evidence", evidence, "No observed evidence is linked to this selection.");
    renderItems(contextTransferList, "context", transfers, "No context transfer records are available for this selection.");
    const summaryPanel = inspectorPanels.find((item) => item.dataset.liveInspectorPanel === "summary");
    if (summaryPanel) summaryPanel.dataset.itemCount = selected ? "1" : "0";
    setInspectorTab(currentInspectorTab);
  }

  function selectNode(nodeId, { focus = false } = {}) {
    if (!currentSnapshot || !currentSnapshot.nodes.some((node) => node.id === nodeId)) return;
    selectedNodeId = nodeId;
    updateSelectedNodeVisuals();
    setInspectorOpen(true);
    if (graphFollowing) centerGraphNode(nodeId);
    const node = currentSnapshot.nodes.find((item) => item.id === nodeId);
    if (liveRegion && node) liveRegion.textContent = localize("Selected node: " + node.label);
    if (focus) graphState.nodeElements.get(nodeId)?.focus();
  }

  function handleNodeKeydown(event, nodeId) {
    const ids = currentSnapshot?.nodes.map((node) => node.id) || [];
    const index = ids.indexOf(nodeId);
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectNode(nodeId);
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) || index < 0) return;
    event.preventDefault();
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? ids.length - 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? Math.max(0, index - 1)
          : Math.min(ids.length - 1, index + 1);
    selectNode(ids[next], { focus: true });
  }

  function renderGraph(snapshot) {
    const graphNodes = graphNodesForSnapshot(snapshot);
    const graphEdges = graphEdgesForSnapshot(snapshot, graphNodes);
    clearChildren(nodeList);
    clearChildren(edgeLayer);
    clearChildren(graphMinimapScene);
    if (!graphNodes.length) {
      if (graphEmpty) graphEmpty.hidden = false;
      graphState = { positions: new Map(), nodeElements: new Map(), edgeElements: new Map(), bounds: { width: 1, height: 1 } };
      return;
    }
    if (graphEmpty) graphEmpty.hidden = true;

    const layout = layoutGraph(snapshot);
    graphState = { positions: layout.positions, nodeElements: new Map(), edgeElements: new Map(), bounds: layout.bounds };
    if (graphScene) {
      graphScene.style.width = layout.bounds.width + "px";
      graphScene.style.height = layout.bounds.height + "px";
    }
    if (edgeLayer) {
      edgeLayer.setAttribute("viewBox", "0 0 " + layout.bounds.width + " " + layout.bounds.height);
      const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      const markerColors = { running: "#87d787", completed: "#d7af00", skipped: "#585858", failed: "#e06c75", "in-doubt": "#e06c75", blocked: "#f0d56a", queued: "#777777" };
      for (const [status, color] of Object.entries(markerColors)) {
        const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
        marker.id = edgeMarkerId(status);
        marker.setAttribute("viewBox", "0 0 10 10");
        marker.setAttribute("refX", "8");
        marker.setAttribute("refY", "5");
        marker.setAttribute("markerWidth", "5");
        marker.setAttribute("markerHeight", "5");
        marker.setAttribute("orient", "auto-start-reverse");
        const markerPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        markerPath.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
        markerPath.setAttribute("fill", color);
        marker.append(markerPath);
        defs.append(marker);
      }
      edgeLayer.append(defs);
    }
    graphNodes.forEach((node) => {
      const card = makeElement("article", "node-card node-" + nodeClass(node.status));
      card.dataset.nodeId = node.id;
      card.dataset.status = node.status;
      card.dataset.replayStatus = node.status;
      card.dataset.selected = "false";
      card.title = node.task || node.label;
      card.setAttribute("role", "option");
      card.setAttribute("aria-selected", "false");
      card.setAttribute("aria-label", node.label + ", " + localize(node.status.replaceAll("_", " ")) + ", " + node.toolCount + " tools, " + node.outputTokens + " tokens");
      card.tabIndex = 0;
      const position = layout.positions.get(node.id) || { x: 32, y: 32, width: 132, height: 76 };
      card.style.left = position.x + "px";
      card.style.top = position.y + "px";
      card.style.width = position.width + "px";
      card.style.minHeight = position.height + "px";
      const top = makeElement("div", "node-card-top");
      const marker = makeElement("span", "node-marker", "");
      marker.setAttribute("aria-hidden", "true");
      top.append(marker, makeElement("span", "node-status", localize(node.status.replaceAll("_", " "))));
      const heading = makeElement("h3", "node-title", node.label);
      const summary = makeElement("p", "node-summary", node.summary);
      const proof = makeElement(
        "div",
        "node-proof",
        node.evidenceCount
          ? (["pending", "queued"].includes(node.status) ? "planned · " : "observed · ") + node.evidenceCount + " evidence"
          : ["pending", "queued"].includes(node.status) ? "planned · awaiting host evidence" : "no evidence linked",
      );
      const meta = makeElement("div", "node-meta activity-chips");
      const role = makeElement("span", "node-meta-item activity-chip chip-role", node.role);
      role.title = localize("Role");
      const agent = makeElement("span", "node-meta-item activity-chip chip-owner", node.agent);
      agent.title = localize("Agent");
      const runtime = makeElement("span", "node-meta-item activity-chip chip-runtime", node.runtime);
      runtime.title = localize("Runtime");
      const model = makeElement("span", "node-meta-item activity-chip chip-model", node.model || "model unavailable");
      model.title = localize("Model");
      const tools = makeElement("span", "node-meta-item activity-chip chip-tools", node.toolCount + " tools" + (usefulNodeMeta(node.latestTool) ? " · " + node.latestTool : ""));
      tools.title = localize("Tool activity");
      const tokens = makeElement("span", "node-meta-item activity-chip chip-tokens", node.outputTokens + " tok");
      tokens.title = localize("Output tokens");
      const evidence = makeElement("span", "node-meta-item activity-chip chip-evidence", node.evidenceCount + " evidence");
      evidence.title = localize("Observed evidence");
      const loadout = node.loadout || {};
      const loadoutTotal = [loadout.skills, loadout.mcp, loadout.tools, loadout.commands]
        .map((value) => Number(value) || 0)
        .reduce((sum, value) => sum + value, 0);
      const loadoutChip = makeElement("span", "node-meta-item activity-chip chip-loadout", loadoutTotal + " loadout");
      loadoutChip.title = "Declared capability loadout";
      if (usefulNodeMeta(role.textContent)) meta.append(role);
      if (usefulNodeMeta(agent.textContent)) meta.append(agent);
      if (usefulNodeMeta(runtime.textContent)) meta.append(runtime);
      if (usefulNodeMeta(node.model)) meta.append(model);
      if (node.toolCount || usefulNodeMeta(node.latestTool)) meta.append(tools);
      if (node.outputTokens) meta.append(tokens);
      if (node.evidenceCount) meta.append(evidence);
      if (loadoutTotal) meta.append(loadoutChip);
      if (usefulNodeMeta(node.firstAt) || usefulNodeMeta(node.lastAt)) meta.append(makeElement("span", "node-meta-item activity-chip chip-duration", formatDuration(node.firstAt, node.lastAt)));
      if (!meta.childElementCount) meta.hidden = true;
      card.append(top, heading, summary, proof, meta);
      const parent = graphEdges.find((edge) => edge.to === node.id);
      if (parent) {
        const parentNode = graphNodes.find((candidate) => candidate.id === parent.from);
        const linkHint = makeElement("p", "node-connection", localize("↳ from " + (parentNode?.label || parent.from)));
        card.append(linkHint);
      }
      if (node.progress !== null) {
        const progress = makeElement("div", "node-progress");
        const bar = makeElement("span", "node-progress-bar");
        bar.style.width = Math.max(0, Math.min(100, node.progress)) + "%";
        progress.append(bar);
        card.append(progress);
      }
      card.addEventListener("click", () => selectNode(node.id));
      card.addEventListener("keydown", (event) => handleNodeKeydown(event, node.id));
      nodeList.append(card);
      graphState.nodeElements.set(node.id, card);
    });

    for (const edge of graphEdges) {
      const from = layout.positions.get(edge.from);
      const to = layout.positions.get(edge.to);
      if (!from || !to || !edgeLayer) continue;
      const geometry = edgeGeometry(from, to);
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", geometry.path);
      path.setAttribute("class", "edge edge-" + nodeClass(edge.status));
      path.setAttribute("data-edge-id", edge.id);
      path.setAttribute("marker-end", "url(#" + edgeMarkerId(edge.status) + ")");
      path.setAttribute("vector-effect", "non-scaling-stroke");
      edgeLayer.append(path);
      graphState.edgeElements.set(edge.id, path);
    }

    for (const node of graphNodes) {
      const position = layout.positions.get(node.id);
      if (!position || !graphMinimapScene) continue;
      const miniNode = makeElement("span", "minimap-node minimap-node-" + nodeClass(node.status));
      miniNode.dataset.nodeId = node.id;
      miniNode.style.left = position.x + "px";
      miniNode.style.top = position.y + "px";
      miniNode.style.width = position.width + "px";
      miniNode.style.height = position.height + "px";
      graphMinimapScene.append(miniNode);
    }
    updateCamera(camera);
    updateSelectedNodeVisuals();
  }

  function renderStageRail(snapshot) {
    if (!stageRail) return;
    clearChildren(stageRail);
    const current = String(snapshot.run?.currentStage || "").toLowerCase();
    const currentIndex = STAGE_ORDER.indexOf(current);
    const terminalRun = ["completed", "failed", "blocked"].includes(String(snapshot.run?.status || "").toLowerCase());
    const events = snapshot.replay || [];
    STAGE_ORDER.forEach((stageName, index) => {
      const stageEvents = events.filter((event) => String(event.stage || event.chapter || "").toLowerCase() === stageName);
      const latest = stageEvents.at(-1);
      const state = currentIndex >= 0
        ? index < currentIndex || (index === currentIndex && terminalRun) ? "completed" : index === currentIndex ? "current" : "upcoming"
        : latest?.status === "completed" ? "completed" : "upcoming";
      const item = makeElement("li", "stage-step");
      item.dataset.state = state;
      item.setAttribute("role", "listitem");
      item.append(
        makeElement("span", "stage-step-marker", String(index + 1).padStart(2, "0")),
        makeElement("span", "stage-step-copy", ""),
      );
      const copy = item.lastElementChild;
      copy.append(makeElement("span", "stage-step-name", localize(stageName)), makeElement("span", "stage-step-state", localize(state)));
      stageRail.append(item);
    });
  }

  function renderEvidence(snapshot) {
    clearChildren(evidenceList);
    setText(evidenceCount, String(snapshot.evidence.length).padStart(2, "0"), "00");
    if (!snapshot.evidence.length) {
      const empty = makeElement("p", "panel-empty", "No evidence has been observed yet.");
      evidenceList.append(empty);
      return;
    }
    snapshot.evidence.forEach((item) => {
      const entry = makeElement("article", "evidence-item");
      entry.dataset.evidenceId = item.id;
      entry.dataset.nodeId = item.nodeId;
      entry.dataset.associated = "false";
      entry.setAttribute("role", "button");
      entry.setAttribute("aria-label", localize(item.label + " evidence"));
      entry.tabIndex = 0;
      const top = makeElement("div", "evidence-item-top");
      top.append(makeElement("span", "evidence-kind", item.label), makeElement("time", "evidence-time", formatTime(item.at)));
      const detail = makeElement("p", "evidence-detail", item.detail);
      const status = makeElement("span", "evidence-status evidence-status-" + item.status.toLowerCase().replace(/[^a-z0-9_-]/gu, "-"), item.status);
      entry.append(top, detail, status);
      entry.addEventListener("click", () => selectNode(item.nodeId));
      entry.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        selectNode(item.nodeId);
      });
      evidenceList.append(entry);
    });
    updateSelectedNodeVisuals();
  }

  function renderSessionInfo(snapshot) {
    if (!infoFacts) return;
    clearChildren(infoFacts);
    const session = snapshot.sessionInfo || {};
    const loadoutTotals = snapshot.nodes.reduce((totals, node) => {
      const loadout = node.loadout || {};
      totals.skills += Number(loadout.skills) || 0;
      totals.mcp += Number(loadout.mcp) || 0;
      totals.tools += Number(loadout.tools) || 0;
      totals.commands += Number(loadout.commands) || 0;
      return totals;
    }, { skills: 0, mcp: 0, tools: 0, commands: 0 });
    const facts = [
      ["Mode", session.mode],
      ["Runtime", session.runtime],
      ["Workers", String(session.workerCount) + " total · " + String(session.completedCount) + " completed · " + String(session.plannedCount) + " queued"],
      ["Events", String(snapshot.replay.length) + " replay events · " + String(snapshot.evidence.length) + " evidence"],
      ["Snapshots", String(session.fileChangeCount) + " file snapshots · " + String(session.artifactCount) + " artifacts"],
      ["Loadout", loadoutTotals.skills + " skills · " + loadoutTotals.mcp + " MCP · " + loadoutTotals.tools + " tools · " + loadoutTotals.commands + " commands"],
      ["Terminal", String(session.failedCount) + " failed · " + String(session.blockedCount) + " blocked"],
      ["Proof", session.proofState],
    ];
    facts.forEach(([label, value]) => {
      const row = makeElement("div", "info-fact-row");
      row.append(makeElement("span", "info-fact-label", localize(label)), makeElement("span", "info-fact-value", display(value, "—")));
      infoFacts.append(row);
    });
    const prompt = makeElement("div", "info-fact-prompt");
    prompt.append(makeElement("span", "info-fact-label", localize("Prompt summary")), makeElement("p", "info-fact-value", session.lastPromptSummary));
    infoFacts.append(prompt);
  }

  function appendOperationalRow(container, label, value, state = "unavailable") {
    if (!container) return;
    const row = makeElement("div", "operational-row");
    row.dataset.state = state;
    row.append(makeElement("span", "operational-label", label), makeElement("strong", "operational-value", value));
    container.append(row);
  }

  function renderRepositoryView(snapshot) {
    const project = projectForSelection();
    const repository = snapshot.repository || {};
    setText(repositoryTitle, repository.name?.state === "observed" ? repository.name.summary : project?.displayName || "Registered project", "Registered project");
    setText(repositoryBoundary, "Repository boundary · " + (project?.projectId || "unavailable"), "Repository boundary unavailable");
    clearChildren(repositoryFacts);
    for (const [label, fact] of [
      ["Branch", repository.branch],
      ["Worktree", repository.worktree],
      ["Pull request", repository.pullRequest],
      ["Diff", repository.diff],
    ]) appendOperationalRow(repositoryFacts, label, fact?.summary || "Unavailable", fact?.state || "unavailable");
    clearChildren(repositorySessions);
    const sessions = project?.sessions || [];
    if (!sessions.length) {
      repositorySessions?.append(makeElement("p", "panel-empty", "No observed workspace sessions."));
      return;
    }
    sessions.forEach((session) => {
      const row = makeElement("button", "workspace-child");
      row.type = "button";
      row.dataset.runId = session.runId;
      row.dataset.active = session.runId === selectedRunId ? "true" : "false";
      row.append(
        makeElement("span", "workspace-child-title", session.title),
        makeElement("span", "workspace-child-meta", (session.active ? "Active workspace" : "Observed workspace") + " · " + session.currentStage + " · " + formatSessionTime(session.updatedAt)),
      );
      row.addEventListener("click", () => switchSelection(selectedProjectId, session.runId, { updateUrl: true }));
      repositorySessions?.append(row);
    });
  }

  function renderWorkspaceView(snapshot) {
    const selectedSession = projectForSelection()?.sessions.find((session) => session.runId === selectedRunId) || null;
    const workspaceData = snapshot.workspace || {};
    const session = snapshot.sessionInfo || {};
    setText(workspaceTitle, workspaceData.name?.state === "observed" ? workspaceData.name.summary : selectedSession?.title || snapshot.run.title, "Observed workspace");
    setText(workspaceBoundary, "Workspace boundary · " + (workspaceData.workspaceId?.state === "observed" ? workspaceData.workspaceId.summary : snapshot.run.id), "Workspace boundary unavailable");
    clearChildren(workspaceFacts);
    const plan = session.plannedCount || session.completedCount
      ? { state: "observed", summary: session.completedCount + " completed · " + session.plannedCount + " queued" }
      : { state: "unavailable", summary: "Plan telemetry unavailable" };
    const thread = workspaceData.transcript;
    const terminal = workspaceData.terminal;
    const changes = snapshot.repository.diff.state === "observed"
      ? snapshot.repository.diff
      : { state: "unavailable", summary: session.fileChangeCount ? session.fileChangeCount + " file snapshots observed · diff telemetry unavailable" : "Diff telemetry unavailable" };
    const review = snapshot.replay.some((event) => event.stage === "review" || event.chapter === "review")
        ? { state: "observed", summary: "Review-stage activity observed" }
        : { state: "unavailable", summary: "Review telemetry unavailable" };
    for (const [label, fact] of [["Plan", plan], ["Conversation", thread], ["Terminal", terminal], ["Changes", changes], ["Review", review]]) {
      appendOperationalRow(workspaceFacts, label, fact?.summary || "Telemetry unavailable", fact?.state || "unavailable");
    }
  }

  function renderReplay(snapshot) {
    const events = snapshot.replay;
    clearChildren(replayEvents);
    const max = Math.max(0, events.length - 1);
    if (replayPlay) replayPlay.disabled = events.length < 2;
    if (events.length < 2) stopReplay();
    if (replayFollowingLive) currentReplayIndex = max;
    if (replayRange) {
      replayRange.max = String(max);
      replayRange.value = String(Math.min(currentReplayIndex, max));
      replayRange.disabled = events.length < 2;
    }
    if (!events.length) {
      replayEvents.append(makeElement("li", "replay-empty", "No replay events in this snapshot."));
      setText(replayStatus, "Waiting for replay data", "Waiting for replay data");
      if (replayPrev) replayPrev.disabled = true;
      if (replayNext) replayNext.disabled = true;
      if (replayLive) replayLive.disabled = true;
      return;
    }
    events.forEach((event, index) => {
      const item = makeElement("li", "replay-event");
      item.dataset.replayIndex = String(index);
      item.dataset.status = event.status;
      item.dataset.kind = event.kind;
      const nearbyToolActivity = events.slice(Math.max(0, index - 2), Math.min(events.length, index + 3)).filter((candidate) => candidate.kind === "tool_start" || candidate.kind === "tool_end" || candidate.toolCallId).length;
      item.dataset.toolDensity = String(Math.min(4, nearbyToolActivity));
      const marker = makeElement("span", "replay-event-marker", "");
      marker.setAttribute("aria-hidden", "true");
      marker.title = localize(event.kind.replaceAll("_", " "));
      item.append(marker, makeElement("span", "replay-event-time", formatTime(event.at)), makeElement("span", "replay-event-label", event.label));
      item.tabIndex = 0;
      item.setAttribute("role", "button");
      item.setAttribute("aria-label", localize("Replay " + event.label));
      item.addEventListener("click", () => {
        replayFollowingLive = false;
        updateReplayPosition(index);
      });
      item.addEventListener("keydown", (keyboardEvent) => {
        if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") return;
        keyboardEvent.preventDefault();
        replayFollowingLive = false;
        updateReplayPosition(index);
      });
      replayEvents.append(item);
    });
    updateReplayPosition(currentReplayIndex);
  }

  const controlActionLabels = {
    pause: "Pause",
    resume: "Resume",
    reassign: "Reassign",
    handoff: "Handoff",
  };

  function effectiveControlConfig(snapshot) {
    if (!snapshot) return null;
    return snapshot.control || initialControlConfig;
  }

  function setControlMessage(element, message) {
    if (element) element.textContent = localize(message);
  }

  function updateControlBusyState() {
    if (!controlPanel) return;
    controlPanel.setAttribute("aria-busy", String(controlBusy));
    controlPanel.querySelectorAll("[data-live-control-action]").forEach((button) => {
      button.disabled = controlBusy;
    });
  }

  function renderControlPanel(snapshot) {
    if (!controlPanel) return;
    const config = effectiveControlConfig(snapshot);
    const enabled = Boolean(config && config.controlEnabled === true && config.controlHeader === "x-meta-kim-control-token" && normalizeControlToken(config.controlToken) && controlActions.every((action) => config.capabilities?.[action]?.available === true));
    controlPanel.hidden = !enabled;
    if (!enabled) {
      updateControlBusyState();
      return;
    }

    const actions = controlPanel.querySelector("[data-live-control-actions]");
    if (actions) {
      for (const action of controlActions) {
        let button = actions.querySelector("[data-live-control-action=\"" + action + "\"]");
        if (!button) {
          button = document.createElement("button");
          button.type = "button";
          button.className = "replay-button control-button";
          button.dataset.liveControlAction = action;
          button.setAttribute("data-live-control-action", action);
          button.setAttribute("aria-label", localize(controlActionLabels[action] + " run"));
          button.textContent = localize(controlActionLabels[action]);
          actions.append(button);
        }
        if (button.dataset.controlBound !== "true") {
          button.addEventListener("click", () => requestControl(action));
          button.dataset.controlBound = "true";
        }
      }
    }
    setControlMessage(controlStatus, "Controls are enabled by the local service; every command remains pending verification.");
    setControlMessage(controlError, "");
    setControlMessage(controlResult, "");
    updateControlBusyState();
  }

  async function requestControl(action) {
    if (!currentSnapshot || !controlActions.includes(action) || controlBusy) return;
    const runIdentifier = display(currentSnapshot.run?.id, "");
    const controlConfig = effectiveControlConfig(currentSnapshot);
    if (!runIdentifier || !controlConfig || controlConfig.controlHeader !== "x-meta-kim-control-token" || !normalizeControlToken(controlConfig.controlToken)) return;
    if (typeof window.confirm === "function" && !window.confirm("Confirm " + controlActionLabels[action] + " for this run?")) {
      setControlMessage(controlStatus, "Command cancelled; durable state was not changed.");
      return;
    }
    controlBusy = true;
    setControlMessage(controlError, "");
    setControlMessage(controlResult, "");
    setControlMessage(controlStatus, "Sending " + controlActionLabels[action] + " command…");
    updateControlBusyState();
    const controlRequestMethod = "POST";
    try {
      const controlHeaders = {
        accept: "application/json",
        "content-type": "application/json",
      };
      controlHeaders[controlConfig.controlHeader] = controlConfig.controlToken;
      const response = await fetch(endpointForSelection(controlEndpoint), {
        method: controlRequestMethod,
        headers: controlHeaders,
        body: JSON.stringify({ action, runId: runIdentifier }),
      });
      if (!response.ok) throw new Error("control request failed");
      const payload = await response.json().catch(() => null);
      if (!payload || typeof payload !== "object") throw new Error("control response unavailable");
      setControlMessage(controlResult, "Command observed by the local endpoint; durable execution still requires verification.");
      setControlMessage(controlStatus, "Command accepted for local handling; no completion claim was made.");
    } catch {
      setControlMessage(controlError, "Command could not be sent; this page did not change durable state.");
      setControlMessage(controlStatus, "Control request unavailable.");
    } finally {
      controlBusy = false;
      updateControlBusyState();
    }
  }

  function setShareStatus(message) {
    setControlMessage(shareStatus, message);
  }

  function shareRequestEndpoint(format = "") {
    const url = new URL(endpointForSelection(shareEndpoint), window.location.origin);
    const params = new URLSearchParams(url.search);
    if (currentSnapshot?.run?.id) params.set("runId", display(currentSnapshot.run.id, ""));
    if (format) params.set("format", format);
    url.search = params.toString();
    return url.pathname + url.search + url.hash;
  }

  async function loadSharePayload() {
    const response = await fetch(shareRequestEndpoint(), { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("share request failed");
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("share response unavailable");
    return payload;
  }

  async function loadShareText(format) {
    const response = await fetch(shareRequestEndpoint(format), { headers: { accept: "text/markdown" } });
    if (!response.ok) throw new Error("share card request failed");
    const value = await response.text();
    if (typeof value !== "string" || !value.trim() || value.length > 200000) throw new Error("share card unavailable");
    return value;
  }

  async function loadShareMarkdown() {
    return loadShareText("markdown");
  }

  async function loadShareReadme() {
    return loadShareText("readme");
  }

  function shareArtifactFrom(payload) {
    const artifact = payload.artifact || payload.shareArtifact || (
      payload.schemaVersion === "meta-kim-live-share-v1" && payload.kind === "live_share_artifact" ? payload : null
    );
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) throw new Error("share artifact unavailable");
    return artifact;
  }

  async function exportShareJson() {
    setShareStatus("Preparing a local JSON export…");
    try {
      const payload = await loadSharePayload();
      const artifact = shareArtifactFrom(payload);
      const serialized = JSON.stringify(artifact, null, 2);
      if (typeof Blob !== "function" || !window.URL?.createObjectURL) throw new Error("download unavailable");
      const url = window.URL.createObjectURL(new Blob([serialized], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "meta-kim-live-share.json";
      link.setAttribute("aria-label", localize("Download local share JSON"));
      document.body.append(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      setShareStatus("JSON export prepared locally; nothing was uploaded.");
    } catch {
      setShareStatus("JSON export unavailable; the local share endpoint did not provide a safe artifact.");
    }
  }

  async function copyShareValue(kind) {
    setShareStatus("Preparing a local share card…");
    try {
      const value = kind === "pr"
        ? await loadShareMarkdown()
        : await loadShareReadme();
      if (typeof value !== "string" || !value.trim() || value.length > 200000) throw new Error("share text unavailable");
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setShareStatus(kind === "pr" ? "PR card copied locally." : "README embed copied locally.");
    } catch {
      setShareStatus("Share copy unavailable; the local endpoint or clipboard was not ready.");
    }
  }

  function updateReplayPosition(index) {
    if (!currentSnapshot) return;
    const events = currentSnapshot.replay;
    const max = Math.max(0, events.length - 1);
    currentReplayIndex = Math.max(0, Math.min(Number(index) || 0, max));
    if (replayRange) replayRange.value = String(currentReplayIndex);
    if (replayProgress) replayProgress.style.width = (max ? (currentReplayIndex / max) * 100 : 0) + "%";
    if (replayStatus) replayStatus.textContent = localize(events.length
      ? "Event " + (currentReplayIndex + 1) + " of " + events.length + ": " + events[currentReplayIndex].label
      : "Waiting for replay data");
    replayEvents?.querySelectorAll("[data-replay-index]").forEach((element) => {
      const active = Number(element.dataset.replayIndex) === currentReplayIndex;
      element.dataset.active = active ? "true" : "false";
      if (active) element.scrollIntoView?.({ behavior: "auto", block: "nearest", inline: "nearest" });
    });
    if (replayPrev) replayPrev.disabled = currentReplayIndex <= 0 || events.length < 2;
    if (replayNext) replayNext.disabled = currentReplayIndex >= max || events.length < 2;
    if (replayLive) {
      replayLive.disabled = events.length < 1;
      replayLive.dataset.active = replayFollowingLive ? "true" : "false";
    }
    const visibleNodeIds = new Set();
    for (const event of events.slice(0, currentReplayIndex + 1)) {
      if (event.nodeId && (event.visibility === "visible" || ["agent", "workflow", "spawn", "stage"].includes(event.kind))) {
        visibleNodeIds.add(event.nodeId);
      }
    }
    const mainNode = currentSnapshot.nodes.find((node) => node.isMain);
    if (mainNode && currentReplayIndex >= 0) visibleNodeIds.add(mainNode.id);
    nodeList?.querySelectorAll("[data-node-id]").forEach((element) => {
      const active = events[currentReplayIndex]?.nodeId && element.dataset.nodeId === events[currentReplayIndex].nodeId;
      element.dataset.replayActive = active ? "true" : "false";
      const visible = visibleNodeIds.has(element.dataset.nodeId);
      element.dataset.replayVisible = visible ? "true" : "false";
      element.setAttribute("aria-hidden", String(!visible));
      let replayState = visible ? "queued" : "queued";
      for (const event of events.slice(0, currentReplayIndex + 1)) {
        if (event.nodeId === element.dataset.nodeId) replayState = event.status;
      }
      element.dataset.replayStatus = replayState;
    });
    if (events[currentReplayIndex]?.nodeId && currentSnapshot.nodes.some((node) => node.id === events[currentReplayIndex].nodeId)) {
      selectedNodeId = events[currentReplayIndex].nodeId;
      updateSelectedNodeVisuals();
      if (graphFollowing) centerGraphNode(selectedNodeId);
    }
    for (const edge of currentSnapshot.edges) {
      const path = graphState.edgeElements.get(edge.id);
      if (!path) continue;
      const edgeVisible = visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to);
      path.dataset.replayVisible = edgeVisible ? "true" : "false";
      path.style.opacity = edgeVisible ? "" : "0";
      let replayState = edge.status;
      let hasReplayState = false;
      for (const event of events.slice(0, currentReplayIndex + 1)) {
        if (event.nodeId === edge.to) {
          replayState = event.status;
          hasReplayState = true;
        }
      }
      if (!hasReplayState) replayState = edge.status;
      path.setAttribute("class", "edge edge-" + nodeClass(replayState));
      path.setAttribute("marker-end", "url(#" + edgeMarkerId(replayState) + ")");
    }
  }

  function stopReplay() {
    if (replayTimer !== null) {
      window.clearInterval(replayTimer);
      replayTimer = null;
    }
    if (replayPlay) replayPlay.dataset.playing = "false";
    if (replayPlayLabel) replayPlayLabel.textContent = localize("Play");
  }

  function toggleReplay() {
    if (!currentSnapshot || currentSnapshot.replay.length < 2) return;
    replayFollowingLive = false;
    if (replayTimer !== null) {
      stopReplay();
      return;
    }
    if (currentReplayIndex >= currentSnapshot.replay.length - 1) updateReplayPosition(0);
    if (replayPlay) replayPlay.dataset.playing = "true";
    if (replayPlayLabel) replayPlayLabel.textContent = localize("Pause");
    replayTimer = window.setInterval(() => {
      if (!currentSnapshot) return stopReplay();
      if (currentReplayIndex >= currentSnapshot.replay.length - 1) return stopReplay();
      updateReplayPosition(currentReplayIndex + 1);
    }, reducedMotion.matches ? 900 : 600);
  }

  function normalizeCatalog(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const rawProjects = Array.isArray(input.projects) ? input.projects : [];
    const projects = rawProjects.slice(0, 128).map((item) => {
      const project = item && typeof item === "object" && !Array.isArray(item) ? item : {};
      const projectId = safeIdentifier(project.projectId);
      if (!projectId) return null;
      const rawSessions = Array.isArray(project.sessions) ? project.sessions : [];
      const sessions = rawSessions.slice(0, 256).map((sessionItem) => {
        const session = sessionItem && typeof sessionItem === "object" && !Array.isArray(sessionItem) ? sessionItem : {};
        const runId = safeIdentifier(session.runId || session.sessionId);
        if (!runId) return null;
        return {
          sessionId: safeIdentifier(session.sessionId) || runId,
          runId,
          title: display(session.title, "Session " + runId.slice(0, 12)),
          status: display(session.status, "observed"),
          currentStage: display(session.currentStage, "—"),
          runtime: display(session.runtime, "local"),
          updatedAt: display(session.updatedAt, ""),
          activity: display(firstValue(session, ["activity", "latestActivity", "summary"], session.currentStage), "—"),
          workerCount: Math.max(0, numberOr(firstValue(session, ["workerCount", "agentCount", "nodeCount"], 0), 0)),
          eventCount: Math.max(0, numberOr(firstValue(session, ["eventCount", "totalEvents"], 0), 0)),
          active: session.active === true,
        };
      }).filter(Boolean);
      return {
        projectId,
        displayName: display(project.displayName, "Meta_Kim project"),
        status: display(project.status, "observed"),
        activeSessionId: safeIdentifier(project.activeSessionId),
        sessionCount: Number.isFinite(Number(project.sessionCount)) ? Number(project.sessionCount) : sessions.length,
        updatedAt: display(project.updatedAt, ""),
        sessions,
      };
    }).filter(Boolean);
    const selected = input.selected && typeof input.selected === "object" && !Array.isArray(input.selected)
      ? {
          projectId: safeIdentifier(input.selected.projectId),
          runId: safeIdentifier(input.selected.runId || input.selected.sessionId),
        }
      : { projectId: "", runId: "" };
    projects.sort((left, right) => {
      const activeOrder = Number(right.status === "active" || right.sessions.some((session) => session.active))
        - Number(left.status === "active" || left.sessions.some((session) => session.active));
      if (activeOrder !== 0) return activeOrder;
      return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""))
        || left.projectId.localeCompare(right.projectId);
    });
    return { projects, selected };
  }

  function replaceSelectOptions(select, options, selectedValue, emptyLabel) {
    if (!select) return;
    clearChildren(select);
    if (!options.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = localize(emptyLabel);
      select.append(option);
      select.disabled = true;
      return;
    }
    select.disabled = false;
    for (const item of options) {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = localize(item.label);
      if (item.value === selectedValue) option.selected = true;
      select.append(option);
    }
  }

  function projectForSelection() {
    return projectCatalog.find((project) => project.projectId === selectedProjectId) || null;
  }

  function populateProjectSelect() {
    replaceSelectOptions(
      projectSelect,
      projectCatalog.map((project) => ({
        value: project.projectId,
        label: project.displayName + (project.sessionCount ? " · " + project.sessionCount + " runs" : " · no runs"),
      })),
      selectedProjectId,
      "No registered projects",
    );
  }

  function populateSessionSelect() {
    const project = projectForSelection();
    const sessions = project?.sessions || [];
    replaceSelectOptions(
      sessionSelect,
      sessions.map((session) => ({
        value: session.runId,
        label: (session.active ? "Live · " : "")
          + formatSessionTime(session.updatedAt)
          + " · " + localize(session.currentStage)
          + " · " + session.title
          + (session.workerCount ? " · " + session.workerCount + " workers" : "")
          + (session.eventCount ? " · " + session.eventCount + " events" : "")
          + " · #" + session.runId.slice(-6),
      })),
      selectedRunId,
      project ? "No governed runs yet" : "Select a project first",
    );
    renderSessionCards(sessions);
  }

  function renderSessionCards(sessions) {
    clearChildren(sessionList);
    if (!sessionList) return;
    if (!sessions.length) {
      sessionList.append(makeElement("p", "panel-empty", "No governed runs yet"));
      return;
    }
    const visibleSessions = sessions.slice(0, 64);
    visibleSessions.forEach((session) => {
      const card = makeElement("button", "session-card");
      card.type = "button";
      card.dataset.runId = session.runId;
      card.dataset.active = session.runId === selectedRunId ? "true" : "false";
      const heading = makeElement("span", "session-card-title", session.title);
      const activity = makeElement("span", "session-card-activity", session.activity || session.currentStage || "Observed");
      const facts = makeElement("span", "session-card-facts");
      facts.append(
        makeElement("span", "", formatSessionTime(session.updatedAt)),
        makeElement("span", "", session.workerCount + " workers"),
        makeElement("span", "", session.eventCount + " events"),
        makeElement("span", "", session.runtime),
      );
      card.append(heading, activity, facts);
      card.addEventListener("click", () => switchSelection(selectedProjectId, session.runId, { updateUrl: true }));
      sessionList.append(card);
    });
    if (sessions.length > visibleSessions.length) {
      sessionList.append(makeElement(
        "p",
        "panel-empty",
        currentLanguage === "zh"
          ? "显示最近 " + visibleSessions.length + "/" + sessions.length + " 个会话"
          : "Showing the newest " + visibleSessions.length + " of " + sessions.length + " sessions",
      ));
    }
  }

  function defaultSessionFor(project, preferredRunId = "") {
    if (!project) return "";
    if (preferredRunId && project.sessions.some((session) => session.runId === preferredRunId)) return preferredRunId;
    if (project.activeSessionId) {
      const activeById = project.sessions.find((session) => session.sessionId === project.activeSessionId || session.runId === project.activeSessionId);
      if (activeById) return activeById.runId;
    }
    return project.sessions.find((session) => session.active)?.runId || project.sessions[0]?.runId || "";
  }

  function setHubStatus(message) {
    setText(hubStatus, message, "Local project catalog");
  }

  function disconnectEvents() {
    if (eventSource) eventSource.close();
    eventSource = null;
  }

  async function switchSelection(projectId, runIdentifier, { updateUrl = true } = {}) {
    const generation = ++selectionGeneration;
    if (snapshotCoalesceTimer !== null) {
      window.clearTimeout(snapshotCoalesceTimer);
      snapshotCoalesceTimer = null;
    }
    pendingSnapshot = null;
    refreshQueued = false;
    refreshAfterRequest = false;
    snapshotRequestInFlight = false;
    selectedNodeId = null;
    currentReplayIndex = 0;
    replayFollowingLive = true;
    selectedProjectId = safeIdentifier(projectId);
    const project = projectCatalog.find((item) => item.projectId === selectedProjectId) || null;
    selectedRunId = defaultSessionFor(project, safeIdentifier(runIdentifier));
    populateProjectSelect();
    populateSessionSelect();
    if (updateUrl) updateSelectionUrl();
    stopReplay();
    currentSnapshot = null;
    if (controlPanel) controlPanel.hidden = true;
    setControlMessage(controlError, "");
    setControlMessage(controlResult, "");
    disconnectEvents();
    abortController?.abort();
    if (!project) {
      showEmpty("Choose a registered Meta_Kim project to inspect its governed runs.");
      setHubStatus("No project selected");
      return;
    }
    if (!selectedRunId) {
      showEmpty("This project has no governed runs yet. Start a Meta_Kim task and its session will appear here.");
      setHubStatus(project.displayName + " · waiting for its first governed run");
      return;
    }
    showEmpty("Loading the selected run…");
    setHubStatus(project.displayName + " · " + project.sessions.length + " observed sessions");
    await loadSnapshot(false, generation);
    if (generation === selectionGeneration) connectEvents(generation);
  }

  async function applyProjectCatalog(catalog, { refresh = false } = {}) {
      catalogAvailable = true;
      projectCatalog = catalog.projects;
      if (refresh && selectedProjectId) {
        const currentProject = projectCatalog.find((item) => item.projectId === selectedProjectId) || null;
        if (currentProject && currentProject.sessions.some((session) => session.runId === selectedRunId)) {
          populateProjectSelect();
          populateSessionSelect();
          setHubStatus(currentProject.displayName + " · " + currentProject.sessions.length + " observed sessions");
          return true;
        }
      }
      const requested = selectionFromLocation();
      const preferredProjectId = requested.projectId || catalog.selected.projectId;
      const project = projectCatalog.find((item) => item.projectId === preferredProjectId)
        || projectCatalog.find((item) => item.status === "live" || item.sessions.some((session) => session.active))
        || projectCatalog[0]
        || null;
      if (!project) {
        populateProjectSelect();
        populateSessionSelect();
        showEmpty("No Meta_Kim projects are registered yet. Install or update Meta_Kim in a project, then start a governed run.");
        setHubStatus("No registered projects · the Hub never scans your disk");
        return false;
      }
      const preferredRunId = requested.runId || (project.projectId === catalog.selected.projectId ? catalog.selected.runId : "");
      await switchSelection(project.projectId, preferredRunId, { updateUrl: true });
      return true;
  }

  async function loadProjectCatalog({ refresh = false } = {}) {
    if (catalogRequestInFlight) return catalogAvailable;
    catalogRequestInFlight = true;
    try {
      const response = await fetch(projectsEndpoint, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("project catalog request failed");
      const catalog = normalizeCatalog(await response.json());
      if (!catalog) throw new Error("project catalog unavailable");
      return await applyProjectCatalog(catalog, { refresh });
    } catch {
      if (refresh && catalogAvailable) {
        setHubStatus("Project catalog refresh paused · showing the last verified list");
        return true;
      }
      catalogAvailable = false;
      projectCatalog = [];
      populateProjectSelect();
      populateSessionSelect();
      setHubStatus("Current project mode · global catalog unavailable");
      return false;
    } finally {
      catalogRequestInFlight = false;
    }
  }

  function showEmpty(message) {
    if (emptyState) emptyState.hidden = false;
    for (const element of [workspace, replayPanel]) {
      if (element) element.hidden = true;
    }
    if (message) setText(app.querySelector("[data-live-empty-message]"), message, "Waiting for a run snapshot");
  }

  function hideEmpty() {
    if (emptyState) emptyState.hidden = true;
    for (const element of [workspace, replayPanel]) {
      if (element) element.hidden = false;
    }
  }

  function renderSnapshot(input) {
    const selectedSession = projectForSelection()?.sessions.find((session) => session.runId === selectedRunId) || null;
    const inputRun = input?.run && typeof input.run === "object" && !Array.isArray(input.run) ? input.run : null;
    const genericTitle = ["", "Live execution", "Observed execution"].includes(display(inputRun?.title, ""));
    const enrichedInput = selectedSession && input && typeof input === "object" && !Array.isArray(input)
      ? {
          ...input,
          run: {
            ...(inputRun || {}),
            title: genericTitle ? selectedSession.title : inputRun?.title,
            stage: selectedSession.currentStage || inputRun?.stage,
            status: selectedSession.active ? "live" : inputRun?.status,
            updatedAt: selectedSession.updatedAt || inputRun?.updatedAt,
          },
        }
      : input;
    const snapshot = normalizeSnapshot(enrichedInput);
    if (!snapshot) {
      showEmpty("Waiting for a run snapshot");
      updateConnection("stale", "Snapshot unavailable");
      return;
    }
    if (!snapshot.run) {
      currentSnapshot = null;
      showEmpty("No governed run has been observed in this project yet.");
      updateConnection("stale", "No run observed");
      return;
    }
    const firstSnapshot = !currentSnapshot;
    currentSnapshot = snapshot;
    hideEmpty();
    updateHeader(snapshot);
    renderStageRail(snapshot);
    renderGraph(snapshot);
    renderEvidence(snapshot);
    renderSessionInfo(snapshot);
    renderRepositoryView(snapshot);
    renderWorkspaceView(snapshot);
    renderReplay(snapshot);
    renderControlPanel(snapshot);
    setWorkView(currentWorkView, { persist: false });
    if (firstSnapshot) {
      const establishInitialCamera = () => {
        fitGraph();
        setCameraMode("overview");
        if (window.matchMedia?.("(max-width: 720px)").matches) {
          graph?.scrollTo({ top: 0, left: 0, behavior: "auto" });
        }
      };
      if (window.requestAnimationFrame) window.requestAnimationFrame(establishInitialCamera);
      else establishInitialCamera();
    } else if (cameraMode === "follow") {
      if (window.requestAnimationFrame) window.requestAnimationFrame(() => reconcileCamera());
      else reconcileCamera();
    }
    updateConnection(snapshot.run.status === "live" ? "live" : "stale", snapshot.run.status === "live" ? "Streaming" : "Snapshot loaded");
  }

  function parseEventData(data) {
    if (typeof data !== "string" || !data.trim()) return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  function flushSnapshotUpdate() {
    snapshotCoalesceTimer = null;
    if (unloading) return;
    const snapshot = pendingSnapshot;
    const shouldRefresh = refreshQueued;
    pendingSnapshot = null;
    refreshQueued = false;
    if (snapshot) {
      renderSnapshot(snapshot);
      return;
    }
    if (shouldRefresh) loadSnapshot(true);
  }

  function scheduleSnapshotUpdate(snapshot = null) {
    if (unloading) return;
    if (snapshot && typeof snapshot === "object") pendingSnapshot = snapshot;
    else refreshQueued = true;
    if (snapshotCoalesceTimer === null) {
      snapshotCoalesceTimer = window.setTimeout(flushSnapshotUpdate, SNAPSHOT_COALESCE_MS);
    }
  }

  function handleEvent(event) {
    const payload = parseEventData(event?.data);
    if (payload && payload.snapshot && typeof payload.snapshot === "object") {
      scheduleSnapshotUpdate(payload.snapshot);
      return;
    }
    if (payload && payload.run && Array.isArray(payload.nodes)) {
      scheduleSnapshotUpdate(payload);
      return;
    }
    // Events are refresh hints. Fetching the canonical snapshot keeps the
    // control room from treating an incomplete SSE event as authoritative.
    scheduleSnapshotUpdate();
  }

  async function loadSnapshot(silent, generation = selectionGeneration) {
    if (generation !== selectionGeneration) return;
    if (snapshotRequestInFlight) {
      refreshAfterRequest = true;
      return;
    }
    snapshotRequestInFlight = true;
    if (abortController) abortController.abort();
    abortController = new AbortController();
    try {
      const response = await fetch(endpointForSelection(snapshotEndpoint), {
        headers: { accept: "application/json" },
        signal: abortController.signal,
      });
      if (generation !== selectionGeneration) return;
      if (!response.ok) throw new Error("snapshot request failed");
      let payload = await response.json();
      if (generation !== selectionGeneration) return;
      if (selectedRunId) {
        try {
          const replayResponse = await fetch(endpointForSelection(replayEndpoint), {
            headers: { accept: "application/json" },
            signal: abortController.signal,
          });
          if (replayResponse.ok) {
            const replayPayload = await replayResponse.json();
            if (generation !== selectionGeneration) return;
            if (replayPayload && typeof replayPayload === "object" && Array.isArray(replayPayload.replay)) {
              payload = { ...payload, replay: replayPayload.replay };
            }
          }
        } catch (error) {
          if (error?.name === "AbortError") throw error;
        }
      }
      if (generation !== selectionGeneration) return;
      if (silent) scheduleSnapshotUpdate(payload);
      else renderSnapshot(payload);
    } catch (error) {
      if (error?.name === "AbortError") return;
      updateConnection("stale", "Reconnecting");
      if (!silent) showEmpty("The local observer is not serving a snapshot yet.");
    } finally {
      if (generation !== selectionGeneration) return;
      snapshotRequestInFlight = false;
      if (refreshAfterRequest && !unloading) {
        refreshAfterRequest = false;
        scheduleSnapshotUpdate();
      }
    }
  }

  function connectEvents(generation = selectionGeneration) {
    if (generation !== selectionGeneration) return;
    if (!window.EventSource) {
      updateConnection("stale", "Polling snapshot");
      return;
    }
    try {
      eventSource = new EventSource(endpointForSelection(eventsEndpoint));
      const handleScopedEvent = (event) => {
        if (generation === selectionGeneration) handleEvent(event);
      };
      eventSource.addEventListener("open", () => {
        if (generation === selectionGeneration) updateConnection("live", "Streaming");
      });
      eventSource.addEventListener("snapshot", handleScopedEvent);
      eventSource.addEventListener("event", handleScopedEvent);
      eventSource.addEventListener("message", handleScopedEvent);
      eventSource.addEventListener("error", () => {
        if (generation === selectionGeneration) updateConnection("stale", "Reconnecting");
      });
    } catch {
      updateConnection("stale", "Polling snapshot");
    }
  }

  evidenceToggle?.addEventListener("click", () => setInspectorOpen(evidencePanel?.dataset.open !== "true"));
  evidenceClose?.addEventListener("click", () => setInspectorOpen(false));
  app.querySelector("[data-live-open-sessions]")?.addEventListener("click", () => setDialogOpen(sessionsDialog, true));
  app.querySelector("[data-live-open-help]")?.addEventListener("click", () => setDialogOpen(helpDialog, true));
  app.querySelector("[data-live-open-info]")?.addEventListener("click", () => setDialogOpen(infoDialog, true));
  app.querySelectorAll("[data-live-dialog-close]").forEach((button) => button.addEventListener("click", () => setDialogOpen(button.closest("[data-live-dialog]"), false)));
  app.querySelectorAll("[data-live-dialog]").forEach((dialog) => dialog.addEventListener("pointerdown", (event) => {
    if (event.target === dialog) setDialogOpen(dialog, false);
  }));
  graphFollow?.addEventListener("click", () => {
    setCameraMode("follow");
    centerGraphNode(selectedNodeId || currentSnapshot?.replay[currentReplayIndex]?.nodeId || currentSnapshot?.nodes.find((node) => node.status === "running")?.id);
  });
  app.addEventListener("keydown", (event) => {
    const target = event.target;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
    if (event.key === "Escape") {
      closeTransientUi();
      selectedNodeId = null;
      updateSelectedNodeVisuals();
      setInspectorOpen(false);
      document.activeElement?.blur?.();
      return;
    }
    const interactive = target?.closest?.('button, a, [role="button"], [role="option"], [contenteditable="true"]');
    const dialogActive = [sessionsDialog, helpDialog, infoDialog].some((dialog) => dialog && !dialog.hidden);
    if (event.defaultPrevented || typing || interactive || dialogActive) return;
    const key = event.key.toLowerCase();
    if (key === "o") { event.preventDefault(); fitGraph(); return; }
    if (key === "f") {
      event.preventDefault();
      setCameraMode("follow");
      centerGraphNode(selectedNodeId || currentSnapshot?.replay[currentReplayIndex]?.nodeId || currentSnapshot?.nodes.find((node) => node.status === "running")?.id);
      return;
    }
    if (key === "r") {
      event.preventDefault();
      layoutMode = layoutMode === "flow" ? "compact" : "flow";
      if (currentSnapshot) { renderGraph(currentSnapshot); fitGraph(); }
      return;
    }
    if (event.key === " ") { event.preventDefault(); toggleReplay(); return; }
    if (event.key === "[") { event.preventDefault(); replayFollowingLive = false; stopReplay(); updateReplayPosition(currentReplayIndex - 1); return; }
    if (event.key === "]") { event.preventDefault(); replayFollowingLive = false; stopReplay(); updateReplayPosition(currentReplayIndex + 1); return; }
    if (event.key === "End") { event.preventDefault(); replayFollowingLive = true; stopReplay(); updateReplayPosition(currentSnapshot?.replay.length ? currentSnapshot.replay.length - 1 : 0); return; }
    if (event.key === "?") { event.preventDefault(); setDialogOpen(helpDialog, true); return; }
    if (key === "i") { event.preventDefault(); setDialogOpen(infoDialog, true); }
  });
  replayPlay?.addEventListener("click", toggleReplay);
  replayPrev?.addEventListener("click", () => {
    replayFollowingLive = false;
    stopReplay();
    updateReplayPosition(currentReplayIndex - 1);
  });
  replayNext?.addEventListener("click", () => {
    replayFollowingLive = false;
    stopReplay();
    updateReplayPosition(currentReplayIndex + 1);
  });
  replayLive?.addEventListener("click", () => {
    replayFollowingLive = true;
    stopReplay();
    updateReplayPosition(currentSnapshot?.replay.length ? currentSnapshot.replay.length - 1 : 0);
  });
  app.querySelector("[data-replay-reset]")?.addEventListener("click", () => {
    replayFollowingLive = false;
    stopReplay();
    updateReplayPosition(0);
  });
  replayRange?.addEventListener("input", (event) => {
    replayFollowingLive = false;
    updateReplayPosition(event.target.value);
  });
  replayRange?.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
      window.setTimeout(() => updateReplayPosition(replayRange.value), 0);
    }
  });
  app.querySelector("[data-live-share-export-json]")?.addEventListener("click", exportShareJson);
  app.querySelector("[data-live-share-copy-pr]")?.addEventListener("click", () => copyShareValue("pr"));
  app.querySelector("[data-live-share-copy-readme]")?.addEventListener("click", () => copyShareValue("readme"));
  app.querySelector("[data-live-language-toggle]")?.addEventListener("click", () => {
    currentLanguage = currentLanguage === "zh" ? "en" : "zh";
    try { window.localStorage?.setItem(LANGUAGE_STORAGE_KEY, currentLanguage); } catch {}
    window.location.reload();
  });
  projectSelect?.addEventListener("change", () => {
    void switchSelection(projectSelect.value, "", { updateUrl: true });
  });
  sessionSelect?.addEventListener("change", () => {
    void switchSelection(selectedProjectId, sessionSelect.value, { updateUrl: true });
  });
  bindRovingTabs(workViewTabs, WORK_VIEWS, setWorkView);
  bindRovingTabs(inspectorTabs, INSPECTOR_TABS, setInspectorTab);

  app.querySelector("[data-live-graph-fit]")?.addEventListener("click", fitGraph);
  app.querySelector("[data-live-graph-zoom-in]")?.addEventListener("click", () => zoomGraph(1.18));
  app.querySelector("[data-live-graph-zoom-out]")?.addEventListener("click", () => zoomGraph(.84));
  app.querySelector("[data-live-graph-layout]")?.addEventListener("click", () => {
    layoutMode = layoutMode === "flow" ? "compact" : "flow";
    if (currentSnapshot) {
      renderGraph(currentSnapshot);
      fitGraph();
    }
  });
  graph?.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (target?.closest?.("[data-node-id], button, .graph-minimap")) return;
    pointerPan = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, cameraX: camera.x, cameraY: camera.y };
    setCameraMode("manual");
    graph.setPointerCapture?.(event.pointerId);
    graph.dataset.panning = "true";
  });
  graph?.addEventListener("pointermove", (event) => {
    if (!pointerPan || pointerPan.pointerId !== event.pointerId) return;
    updateCamera({ ...camera, x: pointerPan.cameraX + event.clientX - pointerPan.x, y: pointerPan.cameraY + event.clientY - pointerPan.y });
  });
  const stopPointerPan = (event) => {
    if (!pointerPan || (event.pointerId !== undefined && pointerPan.pointerId !== event.pointerId)) return;
    graph?.releasePointerCapture?.(pointerPan.pointerId);
    pointerPan = null;
    if (graph) graph.dataset.panning = "false";
  };
  graph?.addEventListener("pointerup", stopPointerPan);
  graph?.addEventListener("pointercancel", stopPointerPan);
  graph?.addEventListener("wheel", (event) => {
    if (event.target?.closest?.(".graph-minimap")) return;
    event.preventDefault();
    setCameraMode("manual");
    const rect = graph.getBoundingClientRect();
    zoomGraph(event.deltaY < 0 ? 1.1 : .9, event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });
  window.addEventListener("resize", reconcileCamera, { passive: true });
  if (window.ResizeObserver && graph) {
    const graphResizeObserver = new ResizeObserver(() => reconcileCamera());
    graphResizeObserver.observe(graph);
    window.addEventListener("beforeunload", () => graphResizeObserver.disconnect(), { once: true });
  }

  applyLanguage();
  for (const panel of app.querySelectorAll(".share-panel, .control-panel")) infoTools?.append(panel);
  currentWorkView = safeStoredChoice(WORK_VIEW_STORAGE_KEY, WORK_VIEWS, "run");
  setWorkView(currentWorkView, { persist: false });
  setInspectorTab("summary");
  setCameraMode("overview");
  setInspectorOpen(false);
  closeTransientUi();
  const snapshotText = initialElement?.textContent?.trim();
  if (snapshotText && snapshotText !== "null") {
    try {
      renderSnapshot(JSON.parse(snapshotText));
    } catch {
      showEmpty("The embedded snapshot could not be read.");
    }
  } else {
    showEmpty("Waiting for a run snapshot");
  }
  void (async () => {
    let startedFromCatalog = false;
    const initialCatalogText = initialCatalogElement?.textContent?.trim();
    if (initialCatalogText && initialCatalogText !== "null") {
      try {
        const initialCatalog = normalizeCatalog(JSON.parse(initialCatalogText));
        if (initialCatalog) startedFromCatalog = await applyProjectCatalog(initialCatalog);
      } catch {
        startedFromCatalog = false;
      }
    }
    if (!startedFromCatalog) startedFromCatalog = await loadProjectCatalog();
    else void loadProjectCatalog({ refresh: true });
    if (!startedFromCatalog && !catalogAvailable) {
      await loadSnapshot(false);
      connectEvents();
    }
    catalogRefreshTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadProjectCatalog({ refresh: true });
    }, 15000);
  })();

  window.addEventListener("beforeunload", () => {
    unloading = true;
    if (catalogRefreshTimer !== null) window.clearInterval(catalogRefreshTimer);
    pendingSnapshot = null;
    refreshQueued = false;
    refreshAfterRequest = false;
    if (snapshotCoalesceTimer !== null) {
      window.clearTimeout(snapshotCoalesceTimer);
      snapshotCoalesceTimer = null;
    }
    stopReplay();
    abortController?.abort();
    if (eventSource) eventSource.close();
  }, { once: true });
})();`;

const PAGE_CSS = String.raw`
:root {
  color-scheme: dark;
  --ink: #eef2ff;
  --muted: #8d99b8;
  --subtle: #596682;
  --line: rgba(155, 169, 205, .16);
  --panel: rgba(14, 19, 34, .84);
  --panel-strong: #11192d;
  --canvas: #070b16;
  --cyan: #55e6d0;
  --blue: #6d8dff;
  --amber: #ffca73;
  --red: #ff7e92;
  --green: #75e5aa;
  --shadow: 0 24px 80px rgba(0, 0, 0, .34);
  font-family: "IBM Plex Sans", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  font-synthesis: none;
}

* { box-sizing: border-box; }
html { min-width: 320px; background: var(--canvas); }
body { min-width: 320px; min-height: 100vh; margin: 0; color: var(--ink); background: radial-gradient(circle at 70% -10%, rgba(57, 90, 172, .2), transparent 34rem), var(--canvas); }
button, input, select { font: inherit; }
button { cursor: pointer; }
button:focus-visible, [type="range"]:focus-visible, [tabindex]:focus-visible, a:focus-visible { outline: 2px solid var(--cyan); outline-offset: 4px; }
.skip-link { position: fixed; z-index: 20; top: 1rem; left: 1rem; padding: .65rem .9rem; color: var(--canvas); background: var(--cyan); border-radius: .55rem; transform: translateY(-160%); transition: transform .2s ease; }
.skip-link:focus { transform: translateY(0); }
.ambient { position: fixed; inset: 0; z-index: -1; pointer-events: none; opacity: .32; background-image: linear-gradient(rgba(104, 125, 183, .05) 1px, transparent 1px), linear-gradient(90deg, rgba(104, 125, 183, .05) 1px, transparent 1px); background-size: 36px 36px; mask-image: linear-gradient(to bottom, black, transparent 80%); }
.shell { width: min(1440px, 100%); margin: 0 auto; padding: 0 2.2rem 2rem; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-height: 88px; border-bottom: 1px solid var(--line); }
.topbar-actions { display: flex; align-items: center; gap: .7rem; }
.language-toggle { min-width: 3rem; min-height: 2rem; border: 1px solid var(--line); border-radius: .55rem; color: var(--ink); background: rgba(15, 24, 45, .78); font: inherit; font-size: .72rem; font-weight: 750; letter-spacing: .04em; cursor: pointer; }
.language-toggle:hover, .language-toggle:focus-visible { border-color: var(--cyan); color: var(--cyan); outline: none; }
.brand { display: flex; align-items: center; gap: .75rem; }
.brand-mark { display: grid; width: 2rem; height: 2rem; place-items: center; color: var(--canvas); background: linear-gradient(145deg, var(--cyan), #8ad7ff); border-radius: .55rem; box-shadow: 0 0 34px rgba(85, 230, 208, .28); }
.eyebrow, .brand-title { margin: 0; }
.eyebrow { color: var(--muted); font-size: .68rem; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
.brand-title { margin-top: .15rem; font-size: .95rem; font-weight: 650; letter-spacing: .01em; }
.connection { display: inline-flex; align-items: center; gap: .52rem; color: var(--muted); font-size: .78rem; }
.connection-dot, .status-pulse { width: .48rem; height: .48rem; border-radius: 50%; background: var(--amber); box-shadow: 0 0 0 5px rgba(255, 202, 115, .1); }
.connection-dot[data-connection="live"] { background: var(--cyan); box-shadow: 0 0 0 5px rgba(85, 230, 208, .1); animation: pulse 2.2s ease-in-out infinite; }
.connection-dot[data-connection="stale"] { background: var(--amber); }
.hub-switcher { display: grid; grid-template-columns: minmax(180px, .8fr) minmax(260px, 1.2fr) minmax(180px, auto); align-items: end; gap: .8rem; margin-top: 1rem; padding: .85rem; background: rgba(14, 19, 34, .62); border: 1px solid var(--line); border-radius: .9rem; }
.hub-field { display: grid; min-width: 0; gap: .38rem; color: var(--subtle); font-size: .64rem; font-weight: 750; letter-spacing: .11em; text-transform: uppercase; }
.hub-select { width: 100%; min-height: 42px; padding: .58rem 2rem .58rem .72rem; overflow: hidden; color: var(--ink); background: var(--panel-strong); border: 1px solid rgba(155, 169, 205, .24); border-radius: .6rem; text-overflow: ellipsis; white-space: nowrap; }
.hub-select:focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; }
.hub-select:disabled { color: var(--subtle); cursor: not-allowed; }
.hub-status { min-width: 0; margin: 0; padding: .6rem .2rem; overflow-wrap: anywhere; color: var(--muted); font-size: .72rem; line-height: 1.45; }
.main { padding-top: 2.2rem; }
.run-hero { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 2rem; padding: 1.25rem 0 2rem; }
.run-hero > * { min-width: 0; }
.kicker { margin: 0 0 .65rem; color: var(--cyan); font-size: .7rem; font-weight: 800; letter-spacing: .2em; text-transform: uppercase; }
.run-title { max-width: 850px; margin: 0; color: var(--ink); font-size: clamp(1.8rem, 3.5vw, 3.25rem); font-weight: 650; line-height: 1.04; letter-spacing: -.04em; text-wrap: balance; }
.run-subtitle { display: flex; flex-wrap: wrap; gap: .55rem 1rem; margin: 1rem 0 0; color: var(--muted); font-size: .88rem; }
.run-subtitle span { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
.run-subtitle span + span::before { margin-right: 1rem; color: var(--subtle); content: "/"; }
.run-stage-primary { color: var(--cyan); font-weight: 750; }
.state-chip { display: inline-flex; align-items: center; gap: .58rem; padding: .62rem .82rem; color: var(--amber); background: rgba(255, 202, 115, .08); border: 1px solid rgba(255, 202, 115, .26); border-radius: 999px; font-size: .78rem; font-weight: 720; white-space: nowrap; }
.state-chip[data-state="live"] { color: var(--cyan); background: rgba(85, 230, 208, .08); border-color: rgba(85, 230, 208, .26); }
.state-chip[data-state="in_doubt"] { color: var(--red); background: rgba(255, 126, 146, .08); border-color: rgba(255, 126, 146, .26); }
.state-chip[data-state="live"] .status-pulse { background: var(--cyan); box-shadow: 0 0 0 5px rgba(85, 230, 208, .1); animation: pulse 2.2s ease-in-out infinite; }
.state-chip[data-state="in_doubt"] .status-pulse { background: var(--red); box-shadow: 0 0 0 5px rgba(255, 126, 146, .1); }
.run-facts { display: grid; grid-template-columns: repeat(4, minmax(115px, 1fr)); gap: .55rem; margin: 0; padding: 0; }
.run-fact { min-width: 0; padding: .8rem .9rem; background: rgba(14, 19, 34, .6); border: 1px solid var(--line); border-radius: .7rem; }
.run-fact dt { margin-bottom: .35rem; color: var(--subtle); font-size: .63rem; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
.run-fact dd { margin: 0; overflow: hidden; color: var(--muted); font-size: .78rem; text-overflow: ellipsis; white-space: nowrap; }
.run-fact-primary { border-color: rgba(85, 230, 208, .28); background: rgba(85, 230, 208, .06); }
.run-fact-primary dd { color: var(--ink); font-weight: 700; }
.stage-overview { margin: .75rem 0 1rem; padding: .9rem 1rem 1rem; background: rgba(14, 19, 34, .62); border: 1px solid var(--line); border-radius: .9rem; }
.stage-overview-header { display: flex; align-items: end; justify-content: space-between; gap: 1rem; margin-bottom: .75rem; }
.stage-overview-header .kicker { margin-bottom: .22rem; }
.stage-overview-header h2 { margin: 0; font-size: .95rem; }
.stage-overview-header > span { color: var(--subtle); font-size: .68rem; }
.stage-rail { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: .35rem; margin: 0; padding: 0; list-style: none; }
.stage-step { position: relative; display: flex; align-items: center; min-width: 0; gap: .45rem; padding: .48rem .5rem; color: var(--subtle); background: rgba(7, 11, 22, .45); border: 1px solid transparent; border-radius: .55rem; }
.stage-step[role="button"] { cursor: pointer; }
.stage-step[role="button"]:hover, .stage-step[role="button"]:focus-visible { color: var(--ink); border-color: rgba(85, 230, 208, .38); }
.stage-step[data-state="current"] { color: var(--ink); background: rgba(85, 230, 208, .1); border-color: rgba(85, 230, 208, .36); }
.stage-step[data-state="completed"] { color: var(--muted); }
.stage-step-marker { display: grid; flex: 0 0 1.35rem; width: 1.35rem; height: 1.35rem; place-items: center; color: var(--subtle); background: rgba(109, 141, 255, .12); border-radius: 50%; font-size: .58rem; font-weight: 800; }
.stage-step[data-state="completed"] .stage-step-marker { color: #06130e; background: var(--green); }
.stage-step[data-state="current"] .stage-step-marker { color: #061512; background: var(--cyan); box-shadow: 0 0 0 5px rgba(85, 230, 208, .1); }
.stage-step-copy { display: grid; min-width: 0; gap: .1rem; }
.stage-step-name { overflow: hidden; font-size: .67rem; text-overflow: ellipsis; white-space: nowrap; }
.stage-step-state { color: inherit; font-size: .55rem; font-weight: 650; opacity: .7; }
.workspace-grid { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(280px, .7fr); align-items: start; gap: 1rem; }
.panel { position: relative; min-width: 0; background: linear-gradient(150deg, rgba(22, 29, 51, .88), rgba(10, 14, 27, .9)); border: 1px solid var(--line); border-radius: 1.1rem; box-shadow: var(--shadow); }
.panel-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1.05rem 1.15rem; border-bottom: 1px solid var(--line); }
.panel-title { margin: 0; color: var(--ink); font-size: .92rem; font-weight: 700; letter-spacing: -.01em; }
.panel-note { margin: .35rem 0 0; color: var(--subtle); font-size: .72rem; }
.panel-count { color: var(--cyan); font-family: "SFMono-Regular", Consolas, monospace; font-size: .72rem; }
.graph-stage { position: relative; min-height: 470px; overflow: hidden; padding: 1.1rem; }
.edge-layer { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.edge { stroke: rgba(109, 141, 255, .32); stroke-width: 1.4; stroke-dasharray: 5 7; }
.edge-running { stroke: var(--cyan); stroke-dasharray: 1 7; animation: dash 1.5s linear infinite; }
.edge-completed { stroke: rgba(117, 229, 170, .48); }
.node-list { position: relative; z-index: 1; display: grid; grid-template-columns: repeat(2, minmax(180px, 1fr)); gap: .7rem; }
.node-card { min-width: 0; padding: .85rem; background: rgba(18, 25, 45, .94); border: 1px solid rgba(140, 159, 207, .16); border-radius: .8rem; box-shadow: 0 10px 30px rgba(0, 0, 0, .15); transition: border-color .2s ease, transform .2s ease, background .2s ease; }
.node-card:hover, .node-card:focus-visible { background: rgba(25, 36, 63, .98); border-color: rgba(85, 230, 208, .42); transform: translateY(-2px); }
.node-card[data-replay-active="true"] { border-color: var(--cyan); box-shadow: 0 0 0 1px rgba(85, 230, 208, .25), 0 14px 40px rgba(45, 214, 192, .12); }
.node-card[data-replay-status="completed"] { border-left-color: var(--green); }
.node-card[data-replay-status="failed"], .node-card[data-replay-status="in_doubt"] { border-left-color: var(--red); }
.node-card[data-replay-status="running"] { border-left-color: var(--cyan); }
.node-card-top, .evidence-item-top { display: flex; align-items: center; justify-content: space-between; gap: .6rem; }
.node-marker { display: inline-block; width: .48rem; height: .48rem; margin-right: .38rem; border-radius: 50%; background: var(--subtle); vertical-align: middle; }
.node-status { color: var(--muted); font-size: .63rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.node-running .node-marker { background: var(--cyan); box-shadow: 0 0 13px rgba(85, 230, 208, .8); animation: pulse 1.6s ease-in-out infinite; }
.node-completed .node-marker { background: var(--green); }
.node-failed .node-marker, .node-in-doubt .node-marker { background: var(--red); }
.node-blocked .node-marker { background: var(--amber); }
.node-title { margin: .7rem 0 .35rem; overflow: hidden; color: var(--ink); font-size: .94rem; font-weight: 680; text-overflow: ellipsis; white-space: nowrap; }
.node-summary { min-height: 2.45em; margin: 0; overflow: hidden; color: var(--muted); font-size: .73rem; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.node-meta { display: flex; flex-wrap: wrap; gap: .3rem; margin-top: .85rem; }
.node-meta-item { max-width: 100%; padding: .25rem .42rem; overflow: hidden; color: var(--subtle); background: rgba(5, 9, 18, .42); border-radius: .35rem; font-family: "SFMono-Regular", Consolas, monospace; font-size: .61rem; text-overflow: ellipsis; white-space: nowrap; }
.node-progress { height: 3px; margin-top: .8rem; overflow: hidden; background: rgba(141, 153, 184, .15); border-radius: 4px; }
.node-progress-bar { display: block; height: 100%; background: linear-gradient(90deg, var(--blue), var(--cyan)); border-radius: inherit; transition: width .45s ease; }
.graph-empty, .panel-empty, .replay-empty { color: var(--subtle); font-size: .8rem; }
.graph-empty { position: absolute; inset: 0; display: grid; place-items: center; padding: 2rem; text-align: center; }
.evidence-panel { overflow: hidden; }
.drawer-toggle, .replay-button { display: inline-flex; align-items: center; gap: .45rem; color: var(--muted); background: transparent; border: 1px solid var(--line); border-radius: .55rem; font-size: .73rem; }
.drawer-toggle { padding: .45rem .6rem; }
.drawer-toggle:hover, .replay-button:hover { color: var(--ink); border-color: rgba(85, 230, 208, .45); }
.evidence-drawer { max-height: 530px; overflow: auto; padding: .65rem; }
.evidence-list { display: grid; gap: .5rem; margin: 0; }
.evidence-item { padding: .75rem; background: rgba(7, 11, 22, .44); border: 1px solid rgba(140, 159, 207, .11); border-radius: .7rem; }
.evidence-kind { color: var(--ink); font-size: .75rem; font-weight: 650; }
.evidence-time { color: var(--subtle); font-family: "SFMono-Regular", Consolas, monospace; font-size: .62rem; }
.evidence-detail { margin: .55rem 0; color: var(--muted); font-size: .72rem; line-height: 1.45; }
.evidence-status { display: inline-block; padding: .24rem .42rem; color: var(--cyan); background: rgba(85, 230, 208, .08); border-radius: .32rem; font-size: .62rem; font-weight: 700; }
.evidence-status-in\ doubt, .evidence-status-rejected { color: var(--red); background: rgba(255, 126, 146, .08); }
.replay-panel { margin-top: 1rem; }
.replay-controls { display: flex; align-items: center; gap: .55rem; }
.replay-button { padding: .44rem .62rem; }
.replay-button[data-playing="true"] { color: var(--cyan); border-color: rgba(85, 230, 208, .4); }
.replay-range-wrap { display: grid; gap: .5rem; padding: 1rem 1.15rem .3rem; }
.replay-range { width: 100%; accent-color: var(--cyan); }
.replay-track { position: relative; height: 3px; background: rgba(141, 153, 184, .15); border-radius: 99px; }
.replay-progress { position: absolute; inset: 0 auto 0 0; width: 0; background: linear-gradient(90deg, var(--blue), var(--cyan)); border-radius: inherit; }
.replay-events { display: flex; gap: .8rem; margin: 0; padding: 1rem 1.15rem 1.15rem; overflow-x: auto; list-style: none; }
.replay-event { display: grid; grid-template-columns: auto auto; gap: .2rem .45rem; min-width: 145px; padding: .6rem .68rem; color: var(--muted); background: rgba(7, 11, 22, .42); border: 1px solid var(--line); border-radius: .6rem; }
.replay-event[data-active="true"] { color: var(--ink); border-color: rgba(85, 230, 208, .46); background: rgba(85, 230, 208, .08); }
.replay-event-marker { grid-row: span 2; align-self: center; width: .48rem; height: .48rem; border-radius: 50%; background: var(--subtle); }
.replay-event[data-active="true"] .replay-event-marker { background: var(--cyan); box-shadow: 0 0 10px rgba(85, 230, 208, .7); }
.replay-event-time { color: var(--subtle); font-family: "SFMono-Regular", Consolas, monospace; font-size: .6rem; }
.replay-event-label { overflow: hidden; font-size: .7rem; text-overflow: ellipsis; white-space: nowrap; }
.replay-status { margin: 0; color: var(--muted); font-size: .72rem; }
.share-panel, .control-panel { margin-top: 1rem; }
.share-content, .control-content { padding: 1rem 1.15rem 1.15rem; }
.share-actions, .control-actions { display: flex; flex-wrap: wrap; gap: .55rem; }
.share-status, .control-status, .control-result, .control-error { margin: .8rem 0 0; color: var(--muted); font-size: .72rem; line-height: 1.45; }
.control-result { color: var(--cyan); }
.control-error { color: var(--red); }
.control-button:disabled { cursor: wait; opacity: .55; }
.control-panel[hidden] { display: none; }
.empty-state { margin-top: 1rem; padding: 2.4rem; text-align: center; background: rgba(14, 19, 34, .72); border: 1px dashed rgba(141, 153, 184, .25); border-radius: 1rem; }
.empty-state[hidden], .graph-empty[hidden], .evidence-drawer[hidden] { display: none; }
.empty-glyph { display: inline-grid; width: 2.3rem; height: 2.3rem; place-items: center; margin-bottom: .8rem; color: var(--cyan); background: rgba(85, 230, 208, .1); border-radius: .7rem; }
.empty-title { margin: 0; font-size: 1rem; }
.empty-copy { max-width: 36rem; margin: .5rem auto 0; color: var(--muted); font-size: .8rem; line-height: 1.5; }
.footer { display: flex; justify-content: space-between; gap: 1rem; padding: 1.2rem 0 0; color: var(--subtle); font-size: .68rem; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.main { padding-top: 1.15rem; }
.run-hero { padding: .55rem 0 .7rem; gap: 1rem; }
.run-title { max-width: 980px; font-size: clamp(1.45rem, 2.2vw, 2.15rem); line-height: 1.12; letter-spacing: -.03em; }
.run-subtitle { margin-top: .65rem; font-size: .78rem; }
.run-facts { margin-bottom: .65rem; }
.stage-overview { margin-top: .55rem; padding: .72rem .8rem .8rem; }
.stage-overview-header { margin-bottom: .55rem; }
.workspace-grid { grid-template-columns: minmax(0, 3fr) minmax(260px, 300px); align-items: stretch; height: 560px; }
.graph-panel { display: grid; grid-template-rows: auto minmax(0, 1fr); height: 560px; overflow: hidden; }
.evidence-panel { display: grid; grid-template-rows: auto auto minmax(0, 1fr); height: 560px; min-height: 0; overflow: hidden; }
.evidence-drawer { min-height: 0; max-height: none; overflow: auto; }
.graph-header-actions { display: inline-flex; align-items: center; gap: .35rem; }
.graph-tool-button { min-width: 2rem; padding: .35rem .5rem; color: var(--muted); background: rgba(7, 11, 22, .45); border: 1px solid var(--line); border-radius: .45rem; font-size: .68rem; }
.graph-tool-button:hover { color: var(--ink); border-color: rgba(85, 230, 208, .5); }
.graph-stage { min-height: 0; height: 100%; padding: 0; background: rgba(5, 9, 18, .24); }
.graph-canvas { position: relative; min-height: 0; height: 100%; overflow: hidden; cursor: grab; background: radial-gradient(circle at 15% 18%, rgba(85, 230, 208, .065), transparent 22rem), linear-gradient(rgba(113, 135, 190, .045) 1px, transparent 1px), linear-gradient(90deg, rgba(113, 135, 190, .045) 1px, transparent 1px); background-size: auto, 28px 28px, 28px 28px; }
.graph-canvas[data-panning="true"] { cursor: grabbing; }
.graph-scene { position: absolute; top: 0; left: 0; transform-origin: 0 0; will-change: transform; }
.edge-layer { inset: 0; width: 100%; height: 100%; }
.edge { fill: none; color: rgba(109, 141, 255, .36); stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-dasharray: 3 8; }
.edge-running { color: var(--cyan); stroke-width: 2.1; stroke-dasharray: 1 8; animation: edge-flow 1.05s linear infinite; }
.edge-completed { color: var(--green); stroke-dasharray: 5 6; opacity: .7; }
.edge-failed, .edge-in-doubt { color: var(--red); stroke-dasharray: 2 5; }
.edge-blocked { color: var(--amber); stroke-dasharray: 2 6; }
.edge-queued { color: rgba(109, 141, 255, .32); }
.node-list { position: absolute; inset: 0; display: block; }
.node-card { position: absolute; height: 96px; min-height: 96px; overflow: hidden; padding: .52rem .65rem; border-radius: .7rem; box-shadow: 0 8px 22px rgba(0, 0, 0, .24); }
.node-card:hover, .node-card:focus-visible { transform: translateY(-2px) scale(1.015); }
.node-card[data-selected="true"] { border-color: var(--cyan); box-shadow: 0 0 0 1px rgba(85, 230, 208, .45), 0 12px 32px rgba(45, 214, 192, .18); }
.node-card[data-selected="true"]::after { position: absolute; top: -.3rem; right: .5rem; width: .35rem; height: .35rem; content: ""; background: var(--cyan); border-radius: 50%; box-shadow: 0 0 0 4px rgba(85, 230, 208, .13); }
.node-title { margin: .34rem 0 .14rem; font-size: .88rem; }
.node-summary { min-height: 1.25em; font-size: .68rem; -webkit-line-clamp: 1; }
.node-meta { flex-wrap: nowrap; gap: .12rem; margin-top: .3rem; }
.node-meta-item { min-width: 0; padding: .12rem .22rem; font-size: .53rem; }
.node-agent { max-width: 100%; color: var(--muted); background: rgba(109, 141, 255, .09); }
.node-progress { margin-top: .15rem; }
.node-connection { display: none; margin: .22rem 0 0; overflow: hidden; color: var(--blue); font-size: .58rem; text-overflow: ellipsis; white-space: nowrap; }
.graph-minimap { position: absolute; right: .75rem; bottom: .75rem; z-index: 3; width: 190px; height: 104px; overflow: hidden; background: rgba(7, 11, 22, .8); border: 1px solid rgba(140, 159, 207, .28); border-radius: .55rem; box-shadow: 0 8px 26px rgba(0, 0, 0, .28); pointer-events: none; }
.minimap-scene { position: absolute; top: 6px; left: 6px; transform-origin: 0 0; }
.minimap-node { position: absolute; display: block; background: rgba(109, 141, 255, .55); border: 1px solid rgba(210, 220, 255, .4); border-radius: 2px; }
.minimap-node-running { background: var(--cyan); box-shadow: 0 0 6px rgba(85, 230, 208, .9); }
.minimap-node-completed { background: var(--green); }
.minimap-node-failed, .minimap-node-in-doubt { background: var(--red); }
.minimap-node-blocked { background: var(--amber); }
.minimap-viewport { position: absolute; z-index: 2; display: block; border: 1px solid var(--cyan); border-radius: 2px; box-shadow: 0 0 0 1px rgba(85, 230, 208, .2); }
.selected-node-summary { display: grid; gap: .3rem; padding: .7rem .8rem; color: var(--muted); background: rgba(7, 11, 22, .38); border-bottom: 1px solid var(--line); font-size: .69rem; }
.selected-node-summary strong { overflow: hidden; color: var(--ink); font-size: .73rem; text-overflow: ellipsis; white-space: nowrap; }
.selected-node-facts { display: flex; flex-wrap: wrap; gap: .28rem .55rem; color: var(--subtle); font-family: "SFMono-Regular", Consolas, monospace; font-size: .59rem; }
.selected-node-summary p { margin: 0; overflow: hidden; color: var(--muted); line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.evidence-item[data-associated="true"] { border-color: rgba(85, 230, 208, .42); background: rgba(85, 230, 208, .08); }
.replay-panel { margin-top: .55rem; }
.replay-range-wrap { padding-top: .55rem; }
.replay-events { gap: .5rem; padding-top: .55rem; padding-bottom: .65rem; }
@keyframes pulse { 0%, 100% { opacity: .55; transform: scale(.85); } 50% { opacity: 1; transform: scale(1.15); } }
@keyframes dash { to { stroke-dashoffset: -16; } }
@keyframes edge-flow { to { stroke-dashoffset: -18; } }
@media (max-width: 980px) { .hub-switcher { grid-template-columns: repeat(2, minmax(0, 1fr)); } .hub-status { grid-column: 1 / -1; } .run-hero { grid-template-columns: 1fr; gap: 1.2rem; } .run-facts { max-width: 700px; } .workspace-grid { grid-template-columns: 1fr; height: auto; } .graph-panel { height: 430px; } .evidence-panel { height: auto; max-height: 360px; } .evidence-drawer { max-height: 210px; } }
@media (max-width: 620px) { .shell { padding: 0 1rem 1.4rem; } .topbar { min-height: 72px; } .hub-switcher { grid-template-columns: 1fr; } .hub-status { grid-column: auto; } .connection [data-live-connection] { display: none; } .run-title { font-size: clamp(1.65rem, 10vw, 2.65rem); } .run-subtitle span { flex-basis: 100%; } .run-subtitle span + span::before { display: none; } .run-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); } .state-chip { justify-self: start; } .graph-panel .panel-header { flex-wrap: wrap; } .graph-header-actions { width: 100%; justify-content: flex-end; } .graph-header-actions .panel-count, .graph-header-actions [data-live-graph-layout] { display: none; } .graph-tool-button, .replay-button { min-width: 44px; min-height: 44px; } .graph-panel { height: auto; } .graph-stage, .graph-canvas { min-height: 330px; height: auto; } .graph-canvas { overflow: auto; cursor: default; } .graph-scene { position: relative; width: 100% !important; height: auto !important; transform: none !important; } .node-list { position: relative; inset: auto; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .4rem; padding: .55rem; } .node-card { position: relative !important; top: auto !important; left: auto !important; width: auto !important; height: auto !important; min-height: 92px !important; max-height: none; } .node-summary { -webkit-line-clamp: 1; } .node-connection { display: block; } .edge-layer, .graph-minimap { display: none; } .panel-header { padding: .9rem; } .replay-events, .replay-range-wrap { padding-left: .9rem; padding-right: .9rem; } .footer { flex-direction: column; } }
@media (max-width: 980px) { .stage-rail { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
@media (max-width: 620px) { .stage-overview-header { align-items: start; flex-direction: column; } .stage-rail { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; } }
`;

const CANVAS_FIRST_CSS = String.raw`
:root {
  --ink: #f3f4f6;
  --muted: #a1a6b0;
  --subtle: #707681;
  --line: rgba(255, 255, 255, .1);
  --line-strong: rgba(255, 255, 255, .17);
  --panel: #111318;
  --panel-strong: #171a20;
  --canvas: #090a0d;
  --cyan: #48d8c6;
  --blue: #7aa2ff;
  --amber: #e9b85f;
  --red: #f27689;
  --green: #72d99c;
  --shadow: 0 18px 48px rgba(0, 0, 0, .3);
}

html, body { height: 100%; }
body { overflow-x: hidden; background: var(--canvas); }
.ambient { opacity: .18; background-size: 48px 48px; mask-image: linear-gradient(to bottom, black, transparent 68%); }
.shell { width: 100%; min-height: 100dvh; padding: 0 .9rem .8rem; }
.topbar { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; min-height: 62px; gap: .9rem; padding: .55rem 0; border-bottom: 1px solid var(--line); }
.brand { min-width: 146px; gap: .6rem; }
.brand-mark { width: 1.8rem; height: 1.8rem; color: #06110f; background: var(--cyan); border-radius: 6px; box-shadow: none; font-size: .72rem; font-weight: 900; }
.eyebrow { color: var(--subtle); font-size: .56rem; letter-spacing: .11em; }
.brand-title { margin-top: .08rem; font-size: .78rem; }
.topbar-actions { justify-content: flex-end; }
.language-toggle { min-width: 2.5rem; min-height: 34px; border-radius: 6px; background: transparent; }
.connection { font-size: .7rem; white-space: nowrap; }
.connection-dot, .status-pulse { width: .42rem; height: .42rem; box-shadow: none; }
.connection-dot[data-connection="live"], .state-chip[data-state="live"] .status-pulse { box-shadow: 0 0 0 4px rgba(72, 216, 198, .09); }
.hub-switcher { display: grid; grid-template-columns: minmax(150px, .72fr) minmax(260px, 1.28fr); gap: .55rem; min-width: 0; margin: 0; padding: 0; background: transparent; border: 0; border-radius: 0; }
.hub-field { gap: .2rem; font-size: .53rem; letter-spacing: .08em; }
.hub-select { min-height: 36px; padding: .42rem 1.8rem .42rem .58rem; color: var(--ink); background: #13161c; border-color: var(--line); border-radius: 6px; font-size: .7rem; }
.hub-status { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
.main { padding-top: .65rem; }
.run-hero { display: grid; grid-template-columns: minmax(240px, 1fr) minmax(440px, auto) auto; align-items: center; gap: .85rem; min-height: 70px; padding: .45rem .6rem .6rem; border-bottom: 1px solid var(--line); }
.run-heading { min-width: 0; }
.kicker { margin: 0 0 .25rem; color: var(--cyan); font-size: .55rem; letter-spacing: .1em; }
.run-title { max-width: none; font-size: 1.05rem; line-height: 1.2; letter-spacing: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.run-subtitle { gap: .25rem .65rem; margin-top: .3rem; font-size: .65rem; }
.run-subtitle span + span::before { margin-right: .65rem; }
.state-chip { justify-self: end; padding: .42rem .58rem; border-radius: 999px; font-size: .66rem; }
.run-facts { grid-template-columns: repeat(4, minmax(90px, 1fr)); gap: 0; margin: 0; border-left: 1px solid var(--line); }
.run-fact { padding: .3rem .65rem; background: transparent; border: 0; border-right: 1px solid var(--line); border-radius: 0; }
.run-fact-primary { background: transparent; }
.run-fact dt { margin-bottom: .18rem; font-size: .51rem; letter-spacing: .08em; }
.run-fact dd { color: var(--ink); font-size: .66rem; }
.workspace-grid { position: relative; display: block; height: clamp(560px, calc(100dvh - 150px), 980px); min-height: 560px; margin-top: .65rem; overflow: hidden; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: none; }
.graph-panel { display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; width: 100%; height: 100%; overflow: hidden; }
.panel-header { min-height: 48px; padding: .62rem .75rem; }
.panel-title { font-size: .78rem; letter-spacing: 0; }
.panel-note { margin-top: .15rem; font-size: .61rem; }
.graph-header { background: #101216; }
.graph-header-actions { flex-wrap: nowrap; }
.graph-tool-button { display: inline-grid; min-width: 32px; min-height: 32px; padding: .28rem .45rem; place-items: center; color: var(--muted); background: transparent; border-color: var(--line); border-radius: 6px; }
.graph-tool-button:hover, .graph-tool-button:focus-visible, .graph-tool-button[data-active="true"] { color: var(--cyan); border-color: rgba(72, 216, 198, .44); background: rgba(72, 216, 198, .06); }
.stage-overview { margin: 0; padding: .45rem .55rem; overflow-x: auto; background: #0d0f13; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; }
.stage-rail { grid-template-columns: repeat(8, minmax(112px, 1fr)); gap: .28rem; min-width: 930px; }
.stage-step { min-height: 34px; padding: .34rem .4rem; background: transparent; border: 1px solid transparent; border-radius: 6px; }
.stage-step::after { position: absolute; top: 50%; right: -.3rem; width: .3rem; height: 1px; background: var(--line-strong); content: ""; }
.stage-step:last-child::after { display: none; }
.stage-step[data-state="current"] { background: rgba(72, 216, 198, .07); border-color: rgba(72, 216, 198, .32); }
.stage-step-marker { flex-basis: 1.15rem; width: 1.15rem; height: 1.15rem; font-size: .5rem; }
.stage-step-name { font-size: .59rem; }
.stage-step-state { font-size: .49rem; }
.graph-stage { min-height: 0; height: 100%; background: #0b0d11; }
.graph-canvas { min-height: 0; height: 100%; background: radial-gradient(circle at 50% 35%, rgba(72, 216, 198, .045), transparent 34rem), linear-gradient(rgba(255, 255, 255, .028) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 255, 255, .028) 1px, transparent 1px); background-size: auto, 32px 32px, 32px 32px; }
.graph-canvas[data-following="true"] .graph-scene { transition: transform .24s cubic-bezier(.2, .75, .3, 1); }
.node-card { height: 100px; min-height: 100px; padding: .55rem .65rem; background: #171a21; border-color: rgba(255,255,255,.11); border-radius: 7px; box-shadow: 0 10px 26px rgba(0, 0, 0, .24); }
.node-card::before { position: absolute; inset: 0 auto 0 0; width: 2px; background: var(--subtle); content: ""; }
.node-running::before { background: var(--cyan); }
.node-completed::before { background: var(--green); }
.node-failed::before, .node-in-doubt::before { background: var(--red); }
.node-blocked::before { background: var(--amber); }
.node-card:hover, .node-card:focus-visible { transform: translateY(-1px); background: #1b1f27; border-color: var(--line-strong); }
.node-card[data-selected="true"], .node-card[data-replay-active="true"] { border-color: rgba(72, 216, 198, .68); box-shadow: 0 0 0 1px rgba(72, 216, 198, .18), 0 14px 32px rgba(0, 0, 0, .32); }
.node-card[data-replay-active="true"]::after { position: absolute; inset: -1px; border: 1px solid rgba(72, 216, 198, .55); border-radius: 7px; content: ""; animation: node-breathe 1.4s ease-in-out infinite; pointer-events: none; }
.node-title { margin: .45rem 0 .25rem; font-size: .78rem; }
.node-summary { min-height: 1.35em; font-size: .61rem; line-height: 1.35; -webkit-line-clamp: 1; }
.node-meta { margin-top: .45rem; }
.node-meta-item { padding: .18rem .3rem; color: var(--muted); background: #0e1014; border: 1px solid rgba(255,255,255,.07); border-radius: 4px; font-size: .52rem; }
.node-progress { margin-top: .45rem; }
.edge { color: rgba(122, 162, 255, .38); stroke-width: 1.35; }
.edge-running { color: var(--cyan); stroke-width: 2; animation: edge-flow .9s linear infinite; }
.graph-minimap { right: .65rem; bottom: .65rem; width: 158px; height: 86px; background: rgba(12, 14, 18, .92); border-color: var(--line-strong); border-radius: 6px; box-shadow: 0 10px 26px rgba(0,0,0,.3); }
.evidence-panel { position: absolute; z-index: 9; top: 56px; right: .65rem; display: grid; grid-template-rows: auto auto minmax(0, 1fr); width: min(360px, calc(100% - 1.3rem)); height: calc(100% - 174px); min-height: 0; overflow: hidden; background: rgba(17, 19, 24, .98); border-color: var(--line-strong); box-shadow: var(--shadow); transform: translateX(calc(100% + 1.2rem)); opacity: 0; pointer-events: none; transition: transform .22s ease, opacity .16s ease; }
.evidence-panel[data-open="true"] { transform: translateX(0); opacity: 1; pointer-events: auto; }
.evidence-panel .kicker { margin-bottom: .18rem; }
.selected-node-summary { gap: .55rem; padding: .75rem; background: #14171d; }
.selected-node-summary strong { font-size: .78rem; white-space: normal; }
.selected-node-summary p { color: var(--muted); font-size: .66rem; line-height: 1.45; white-space: normal; overflow: visible; }
.selected-node-facts { gap: .35rem; }
.evidence-drawer { min-height: 0; max-height: none; padding: .55rem; }
.evidence-item { border-radius: 6px; }
.replay-panel { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(230px, auto) minmax(0, 1fr); grid-template-rows: auto auto; min-height: 112px; margin: 0; }
.replay-dock { margin: 0; background: #101216; border: 0; border-top: 1px solid var(--line); border-radius: 0; }
.replay-dock-header { grid-row: 1 / span 2; display: flex; align-items: center; justify-content: space-between; gap: .75rem; padding: .48rem .65rem; border-right: 1px solid var(--line); }
.replay-current { display: flex; min-width: 0; align-items: baseline; gap: .55rem; }
.replay-current .panel-note { max-width: 520px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.replay-controls { gap: .3rem; }
.replay-button { min-height: 32px; padding: .3rem .48rem; border-radius: 6px; font-size: .62rem; }
.replay-play { min-width: 34px; justify-content: center; }
.replay-range-wrap, .replay-events { grid-column: 2; }
.replay-range-wrap { gap: .28rem; padding: .35rem .65rem .2rem; }
.replay-range { height: 12px; margin: 0; }
.replay-events { gap: .35rem; padding: .3rem .65rem .55rem; scrollbar-width: thin; }
.replay-event { grid-template-columns: auto minmax(0, 1fr); min-width: 128px; max-width: 180px; padding: .38rem .45rem; background: transparent; border-radius: 5px; }
.replay-event-time { font-size: .5rem; }
.replay-event-label { font-size: .58rem; }
.graph-minimap[hidden] { display: none; }
.share-panel, .control-panel { margin-top: .55rem; border-color: rgba(255,255,255,.08); box-shadow: none; }
.share-panel .panel-header, .control-panel .panel-header { min-height: 42px; }
.share-content, .control-content { display: flex; align-items: center; justify-content: space-between; gap: .75rem; padding: .55rem .7rem; }
.share-status, .control-status, .control-result, .control-error { margin: 0; }
.empty-state { border-radius: 8px; }
.footer { padding-top: .65rem; }

@keyframes node-breathe { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }

@media (max-width: 1100px) {
  .topbar { grid-template-columns: auto minmax(0, 1fr); }
  .topbar-actions { grid-column: 1 / -1; position: absolute; top: .9rem; right: .9rem; }
  .hub-switcher { padding-right: 7.5rem; }
  .run-hero { grid-template-columns: minmax(220px, 1fr) minmax(400px, auto) auto; }
  .run-facts { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
  .run-fact:nth-child(2) { border-right: 0; }
  .run-fact:nth-child(n+3) { border-top: 1px solid var(--line); }
}

@media (max-width: 760px) {
  .shell { padding: 0 .55rem .7rem; }
  .topbar { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: .45rem; min-height: 0; padding: .55rem 0; }
  .brand { min-width: 0; }
  .topbar-actions { position: static; grid-column: 2; grid-row: 1; }
  .connection [data-live-connection] { display: none; }
  .hub-switcher { grid-column: 1 / -1; grid-row: 2; grid-template-columns: 1fr; width: 100%; padding: 0; }
  .hub-field { grid-template-columns: 64px minmax(0, 1fr); align-items: center; gap: .45rem; }
  .hub-field > span { padding-left: .15rem; }
  .hub-select { min-height: 38px; }
  .main { padding-top: .4rem; }
  .run-hero { grid-template-columns: minmax(0, 1fr) auto; gap: .5rem; min-height: 0; padding: .4rem .2rem .5rem; }
  .run-heading { grid-column: 1; }
  .run-title { font-size: .94rem; }
  .run-subtitle { font-size: .59rem; }
  .state-chip { grid-column: 2; grid-row: 1; }
  .run-facts { grid-column: 1 / -1; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; border-top: 1px solid var(--line); border-left: 0; }
  .run-fact { padding: .35rem .45rem; }
  .run-fact:nth-child(1), .run-fact:nth-child(3) { border-left: 0; }
  .workspace-grid { height: calc(100dvh - 272px); min-height: 500px; margin-top: .4rem; }
  .graph-panel { grid-template-rows: auto auto minmax(240px, 1fr) auto; }
  .graph-header { flex-wrap: nowrap; padding: .5rem; }
  .graph-header .panel-note { display: none; }
  .graph-header-actions { gap: .2rem; }
  .graph-header-actions [data-live-graph-layout] { display: none; }
  .graph-tool-button, .replay-button { min-width: 44px; min-height: 44px; }
  .stage-overview { padding: .35rem .4rem; }
  .stage-rail { display: flex; min-width: max-content; }
  .stage-step { width: 108px; }
  .graph-canvas { overflow: auto; cursor: default; }
  .graph-scene { position: relative; width: 100% !important; height: auto !important; transform: none !important; }
  .node-list { position: relative; inset: auto; display: grid; grid-template-columns: 1fr; gap: .45rem; padding: .55rem; }
  .node-card { position: relative !important; top: auto !important; left: auto !important; width: auto !important; height: auto !important; min-height: 88px !important; max-height: none; }
  .node-summary { -webkit-line-clamp: 2; }
  .node-connection { display: block; }
  .edge-layer, .graph-minimap { display: none; }
  .replay-panel { grid-template-columns: 1fr; min-height: 126px; }
  .replay-dock-header { grid-row: auto; align-items: flex-start; padding: .4rem .5rem; border-right: 0; border-bottom: 1px solid var(--line); }
  .replay-range-wrap, .replay-events { grid-column: 1; }
  .replay-current { display: grid; gap: .1rem; }
  .replay-controls { flex-wrap: wrap; justify-content: flex-end; }
  .replay-reset { display: none; }
  .replay-events { display: none; padding-inline: .5rem; }
  .evidence-panel { position: fixed; top: auto; right: .5rem; bottom: .5rem; left: .5rem; width: auto; max-height: min(72dvh, 620px); transform: translateY(calc(100% + 1rem)); }
  .evidence-panel[data-open="true"] { transform: translateY(0); }
  .share-content, .control-content { align-items: flex-start; flex-direction: column; }
  .footer { flex-direction: column; }
}

@media (max-width: 420px) {
  .workspace-grid { height: calc(100dvh - 288px); min-height: 470px; }
  .run-facts { display: flex; overflow-x: auto; }
  .run-fact { flex: 0 0 132px; border-top: 0 !important; }
  .run-fact + .run-fact { border-left: 1px solid var(--line); }
  .graph-header-actions [data-live-graph-zoom-out], .graph-header-actions [data-live-graph-zoom-in] { display: none; }
  .replay-current .panel-note { max-width: 150px; }
}

@media (prefers-reduced-motion: reduce) {
  .graph-canvas[data-following="true"] .graph-scene, .evidence-panel { transition: none !important; }
  .node-card[data-replay-active="true"]::after { animation: none !important; opacity: 1; }
}
`;

const GRAPH_FIRST_CSS = String.raw`
:root { color-scheme: dark; --ink: #11100f; --panel: #1b1a18; --panel-2: #23211e; --gold: #a68d5e; --gold-bright: #cfbd96; --accent: #58c8c0; --teal: #62aaa0; --green: #76b88d; --dim: #77736b; --line-soft: #2b2a27; --line: #3a3833; --line-strong: #524e44; --text: #e5e1d9; --muted: #9f9a90; --danger: #c97079; --radius-sm: 4px; --radius: 6px; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
html, body { width: 100%; min-width: 0; height: 100%; margin: 0; overflow: hidden; background: var(--ink); color: var(--text); }
body { letter-spacing: 0; }
button, select, input { font: inherit; }
button { color: inherit; }
[hidden] { display: none !important; }
.skip-link { position: fixed; z-index: 100; top: .5rem; left: .5rem; transform: translateY(-160%); padding: .55rem .75rem; border-radius: var(--radius); background: var(--gold); color: #111; }
.skip-link:focus { transform: none; }
.sr-only { position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important; margin: -1px !important; overflow: hidden !important; clip: rect(0,0,0,0) !important; white-space: nowrap !important; border: 0 !important; }
.shell { height: 100dvh; min-width: 0; display: grid; grid-template-rows: 44px minmax(0, 1fr); background: var(--ink); }
.topbar { min-width: 0; display: flex; align-items: center; gap: .75rem; padding: 0 .75rem; border-bottom: 1px solid var(--line); background: #171614; }
.brand { flex: 0 0 auto; display: flex; align-items: center; gap: .55rem; }
.brand-mark { display: grid; place-items: center; width: 24px; height: 24px; border: 1px solid var(--gold); border-radius: var(--radius-sm); color: var(--gold-bright); font: 700 12px/1 monospace; }
.brand-title { margin: 0; font-size: .78rem; font-weight: 700; }
.top-run-context { min-width: 0; display: flex; align-items: center; gap: .45rem; color: var(--muted); font-size: .72rem; }
.top-run-context strong { min-width: 0; max-width: min(40vw, 560px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-weight: 600; }
.work-view-switcher { flex: 0 0 auto; display: inline-grid; grid-template-columns: repeat(3, minmax(0,1fr)); padding: 2px; border: 1px solid var(--line); border-radius: var(--radius); background: #12110f; }
.work-view-tab { min-width: 76px; min-height: 27px; padding: 0 .5rem; border: 0; border-right: 1px solid var(--line-soft); background: transparent; color: var(--muted); font-size: .62rem; cursor: pointer; }
.work-view-tab:last-child { border-right: 0; }
.work-view-tab[aria-selected="true"] { border-radius: var(--radius-sm); background: rgba(88,200,192,.08); color: var(--accent); box-shadow: inset 0 -2px 0 var(--accent); }
.work-view-tab:focus-visible, .inspector-tabs button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.topbar-actions { margin-left: auto; display: flex; align-items: center; gap: .25rem; }
.connection { display: flex; align-items: center; gap: .35rem; min-width: 0; margin-right: .3rem; color: var(--muted); font-size: .68rem; white-space: nowrap; }
.connection-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dim); }
.connection-dot[data-connection="live"] { background: var(--green); box-shadow: 0 0 8px rgba(118,184,141,.42); }
.connection-dot[data-connection="stale"] { background: var(--gold); }
.topbar-button, .graph-tool-button, .replay-button { min-height: 30px; border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent; color: var(--muted); cursor: pointer; }
.topbar-button { padding: 0 .55rem; font-size: .7rem; }
.topbar-button:hover, .topbar-button:focus-visible, .graph-tool-button:hover, .graph-tool-button:focus-visible, .replay-button:hover, .replay-button:focus-visible { border-color: rgba(88,200,192,.5); background: rgba(88,200,192,.06); color: var(--accent); outline: none; }
.main { min-width: 0; min-height: 0; overflow: hidden; display: grid; grid-template-rows: auto minmax(0, 1fr); }
.run-context { min-width: 0; display: grid; grid-template-columns: minmax(280px, 1.35fr) minmax(420px, 2fr) minmax(150px, .55fr); align-items: center; gap: .9rem; padding: .55rem .75rem .62rem; border-bottom: 1px solid var(--line); background: #171614; }
.run-context-heading { min-width: 0; }
.context-kicker { display: block; margin-bottom: .2rem; color: var(--gold); font: .55rem/1 monospace; text-transform: uppercase; }
.run-context-title { min-width: 0; margin: 0; overflow: hidden; color: var(--text); font-size: .98rem; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
.run-context-task { min-width: 0; margin: .25rem 0 0; overflow: hidden; color: var(--muted); font-size: .65rem; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.run-context-facts { min-width: 0; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); border-left: 1px solid var(--line); }
.context-fact { min-width: 0; display: grid; gap: .18rem; padding: .08rem .55rem; border-right: 1px solid var(--line); }
.context-fact span, .run-context-source span { color: var(--muted); font: .52rem/1 monospace; text-transform: uppercase; }
.context-fact strong { min-width: 0; overflow: hidden; color: var(--gold-bright); font: 600 .65rem/1.15 monospace; text-overflow: ellipsis; white-space: nowrap; }
.run-context-source { min-width: 0; display: grid; gap: .18rem; padding-left: .3rem; }
.run-context-source strong { min-width: 0; overflow: hidden; color: var(--muted); font: .58rem/1.15 monospace; text-overflow: ellipsis; white-space: nowrap; }
.run-context { min-width: 0; display: grid; grid-template-columns: minmax(280px, 1.35fr) minmax(420px, 2fr) minmax(150px, .55fr); align-items: center; gap: .9rem; padding: .55rem .75rem .62rem; border-bottom: 1px solid var(--line); background: #171614; }
.run-context-heading { min-width: 0; }
.context-kicker { display: block; margin-bottom: .2rem; color: var(--gold); font: .55rem/1 monospace; text-transform: uppercase; }
.run-context-title { min-width: 0; margin: 0; overflow: hidden; color: var(--text); font-size: .98rem; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
.run-context-task { min-width: 0; margin: .25rem 0 0; overflow: hidden; color: var(--muted); font-size: .65rem; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.run-context-facts { min-width: 0; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); border-left: 1px solid var(--line); }
.context-fact { min-width: 0; display: grid; gap: .18rem; padding: .08rem .55rem; border-right: 1px solid var(--line); }
.context-fact span, .run-context-source span { color: var(--muted); font: .52rem/1 monospace; text-transform: uppercase; }
.context-fact strong { min-width: 0; overflow: hidden; color: var(--gold-bright); font: 600 .65rem/1.15 monospace; text-overflow: ellipsis; white-space: nowrap; }
.run-context-source { min-width: 0; display: grid; gap: .18rem; padding-left: .3rem; }
.run-context-source strong { min-width: 0; overflow: hidden; color: var(--muted); font: .58rem/1.15 monospace; text-overflow: ellipsis; white-space: nowrap; }
.workspace-grid { position: relative; min-width: 0; min-height: 0; height: 100%; display: grid; grid-template-columns: minmax(0, 1fr) 0; overflow: hidden; transition: grid-template-columns .18s ease; }
.workspace-grid[data-work-view="repository"], .workspace-grid[data-work-view="workspace"] { grid-template-columns: minmax(0,1fr) 0; }
.work-surface-view { min-width: 0; min-height: 0; overflow: auto; background: #12110f; }
.work-surface-header { min-width: 0; display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; padding: 1.15rem 1.25rem; border-bottom: 1px solid var(--line); background: #171614; }
.work-surface-header h2 { margin: 0; color: var(--text); font-size: 1rem; }
.work-surface-header p { max-width: 72ch; margin: .32rem 0 0; overflow-wrap: anywhere; color: var(--muted); font: .62rem/1.45 monospace; }
.surface-state { flex: 0 0 auto; padding: .25rem .4rem; border: 1px solid #5b503c; border-radius: var(--radius-sm); color: var(--gold-bright); background: rgba(166,141,94,.06); font: .55rem/1.2 monospace; text-transform: uppercase; }
.repository-layout { display: grid; grid-template-columns: minmax(260px,.72fr) minmax(0,1.28fr); min-height: calc(100% - 82px); }
.operational-section { min-width: 0; padding: 1rem 1.25rem; }
.operational-section + .operational-section { border-left: 1px solid var(--line); }
.operational-section h3 { margin: 0 0 .7rem; color: var(--muted); font: 600 .6rem/1 monospace; text-transform: uppercase; }
.operational-list { border-top: 1px solid var(--line); }
.operational-row { min-width: 0; display: grid; grid-template-columns: minmax(92px,.4fr) minmax(0,1fr); gap: .75rem; align-items: center; padding: .72rem 0; border-bottom: 1px solid var(--line); }
.operational-label { color: var(--muted); font-size: .64rem; }
.operational-value { min-width: 0; overflow-wrap: anywhere; color: var(--text); font-size: .7rem; font-weight: 600; }
.operational-row[data-state="unavailable"] .operational-value { color: #777; font-weight: 500; }
.operational-row[data-state="planned"] .operational-value { color: var(--gold-bright); }
.workspace-children { display: grid; border-top: 1px solid var(--line); }
.workspace-child { min-width: 0; display: grid; gap: .24rem; padding: .72rem 0; text-align: left; border: 0; border-bottom: 1px solid var(--line); background: transparent; color: inherit; }
.workspace-child:hover, .workspace-child:focus-visible, .workspace-child[data-active="true"] { background: rgba(88,200,192,.05); outline: none; box-shadow: inset 3px 0 0 var(--accent); }
.workspace-child-title { overflow: hidden; color: var(--text); font-size: .72rem; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.workspace-child-meta { overflow: hidden; color: var(--muted); font: .56rem/1.35 monospace; text-overflow: ellipsis; white-space: nowrap; }
.workspace-availability { max-width: 920px; }
.workspace-grid[data-inspector-open="true"] { grid-template-columns: minmax(280px, 30%) minmax(0, 70%); }
.workspace-grid[data-inspector-open="true"] .replay-panel { grid-template-columns: minmax(0,1fr); }
.workspace-grid[data-inspector-open="true"] .replay-dock-header { grid-column: 1; grid-row: 1; min-width: 0; display: flex; justify-content: center; border-right: 0; border-bottom: 1px solid var(--line); }
.workspace-grid[data-inspector-open="true"] .replay-current { display: none; }
.workspace-grid[data-inspector-open="true"] .replay-range-wrap { grid-column: 1; grid-row: 2; }
.workspace-grid[data-inspector-open="true"] .replay-events { grid-column: 1; grid-row: 3; }
.workspace-grid[data-inspector-open="true"] .replay-live, .workspace-grid[data-inspector-open="true"] .replay-reset { display: none; }
.workspace-grid[data-inspector-open="true"] .status-title, .workspace-grid[data-inspector-open="true"] .status-nodes, .workspace-grid[data-inspector-open="true"] .status-camera { display: none; }
.graph-panel { min-width: 0; min-height: 0; display: grid; grid-template-rows: minmax(0, 1fr) 92px 24px; border: 0; background: #12110f; overflow: hidden; }
.graph-stage { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.graph-toolbar { position: absolute; z-index: 8; top: .55rem; right: .55rem; display: flex; flex-wrap: wrap; gap: .22rem; max-width: calc(100% - 1.1rem); padding: .25rem; border: 1px solid var(--line); border-radius: var(--radius); background: rgba(27,26,24,.96); box-shadow: 0 8px 20px rgba(0,0,0,.28); }
.graph-tool-button { min-width: 31px; padding: 0 .48rem; font-size: .68rem; }
.graph-tool-button[data-active="true"], .replay-button[data-active="true"] { border-color: var(--accent); color: var(--accent); background: rgba(88,200,192,.07); }
.graph-canvas { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden; cursor: grab; background-color: #12110f; background-image: linear-gradient(#201e1a 1px, transparent 1px), linear-gradient(90deg, #201e1a 1px, transparent 1px); background-size: 24px 24px; touch-action: none; }
.graph-canvas[data-panning="true"] { cursor: grabbing; }
.graph-scene { position: absolute; top: 0; left: 0; transform-origin: 0 0; transition: transform .16s ease-out; }
.edge-layer, .node-list { position: absolute; inset: 0; width: 100%; height: 100%; }
.edge { fill: none; stroke: #69655d; stroke-width: 1.5; opacity: .72; }
.edge-running { stroke: var(--teal); stroke-dasharray: 8 8; animation: live-flow 1.2s linear infinite; }
.edge-completed { stroke: var(--gold); }
.edge-skipped, .edge-queued { stroke: #69655d; }
.edge-failed, .edge-in-doubt { stroke: var(--danger); }
.edge-blocked { stroke: var(--gold-bright); }
@keyframes live-flow { to { stroke-dashoffset: -16; } }
.node-card { position: absolute; display: grid; grid-template-rows: auto auto minmax(0,1fr) auto auto; gap: .28rem; width: 184px; min-height: 116px; max-height: 128px; padding: .58rem; overflow: hidden; border: 1px solid var(--line); border-left: 3px solid #6e6a62; border-radius: var(--radius); background: #1c1b19; color: var(--text); box-shadow: 0 6px 16px rgba(0,0,0,.24); cursor: pointer; }
.node-card:hover, .node-card:focus-visible, .node-card[data-selected="true"] { border-color: var(--accent); outline: none; box-shadow: 0 0 0 1px rgba(88,200,192,.2), 0 8px 24px rgba(0,0,0,.35); }
.node-running { border-left-color: var(--teal); }
.node-completed { border-left-color: var(--gold); }
.node-skipped { border-left-color: #585858; opacity: .72; }
.node-failed, .node-in-doubt { border-left-color: var(--danger); }
.node-blocked { border-left-color: var(--gold-bright); }
.node-card-top { display: flex; align-items: center; gap: .3rem; color: var(--muted); font: 600 .58rem/1 monospace; text-transform: uppercase; }
.node-marker { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.node-running .node-marker { color: var(--teal); }
.node-completed .node-marker { color: var(--gold); }
.node-title { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .76rem; }
.node-summary { margin: 0; display: -webkit-box; overflow: hidden; color: var(--muted); font-size: .63rem; line-height: 1.35; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.node-proof { min-width: 0; overflow: hidden; color: var(--gold-bright); font: .52rem/1.2 monospace; text-overflow: ellipsis; white-space: nowrap; }
.activity-chips { display: flex; flex-wrap: wrap; gap: .18rem; min-width: 0; max-height: 31px; overflow: hidden; }
.activity-chip { min-width: 0; max-width: 62%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: .12rem .25rem; border: 1px solid var(--line); border-radius: var(--radius-sm); color: #bdb8ae; background: #171614; font: .5rem/1.2 monospace; }
.chip-owner { color: var(--gold-bright); }
.chip-runtime { color: var(--green); }
.chip-tools { color: #e5c07b; }.chip-tokens { color: #8ecae6; }.chip-evidence { color: var(--gold-bright); }.chip-loadout { color: #c8a96b; }
.node-connection, .node-progress { display: none; }
.graph-canvas[data-semantic-zoom="cell"] .node-card { height: 116px !important; min-height: 116px !important; padding: 0; overflow: visible; border: 0; background: transparent; box-shadow: none; }
.graph-canvas[data-semantic-zoom="cell"] .node-card::after { content: ""; position: absolute; top: 35px; right: 0; left: 0; height: 26px; border-left: 8px solid #666; background: #292929; }
.graph-canvas[data-semantic-zoom="cell"] .node-running::after { border-left-color: var(--teal); }.graph-canvas[data-semantic-zoom="cell"] .node-completed::after { border-left-color: var(--gold); }.graph-canvas[data-semantic-zoom="cell"] .node-failed::after,.graph-canvas[data-semantic-zoom="cell"] .node-blocked::after { border-left-color: var(--danger); }
.graph-canvas[data-semantic-zoom="cell"] .node-card > * { visibility: hidden; }
.graph-canvas[data-semantic-zoom="cell"] .node-card .node-title { position: absolute; z-index: 1; top: 35px; right: 0; left: 8px; height: 26px; visibility: visible; padding: .4rem .45rem; font: 700 11px/1 monospace; }
.graph-minimap { position: absolute; z-index: 7; top: .55rem; right: .55rem; width: 166px; height: 92px; overflow: hidden; border: 1px solid var(--line-strong); border-radius: var(--radius); background: rgba(20,19,17,.92); pointer-events: none; }
.minimap-scene { position: absolute; transform-origin: 0 0; }
.minimap-node { position: absolute; border-radius: 1px; background: #666; }
.minimap-node-running { background: var(--teal); }.minimap-node-completed { background: var(--gold); }.minimap-node-failed,.minimap-node-blocked { background: var(--danger); }
.minimap-viewport { position: absolute; border: 1px solid var(--accent); background: rgba(88,200,192,.07); }
.graph-empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--muted); }
.replay-panel { min-width: 0; display: grid; grid-template-columns: 300px minmax(0,1fr); grid-template-rows: 34px 28px 28px; border-top: 1px solid var(--line); background: #191816; }
.replay-dock-header { grid-row: 1 / -1; min-width: 300px; display: grid; grid-template-columns: minmax(74px,1fr) auto; align-items: center; gap: .45rem; padding: .45rem .55rem; border-right: 1px solid var(--line); }
.replay-current { min-width: 74px; overflow: hidden; }
.replay-current .panel-title { white-space: nowrap; }
.replay-current .panel-note { display: none; }
.panel-title { display: block; color: var(--text); font-size: .68rem; font-weight: 700; }
.panel-note { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: .58rem; }
.replay-controls { display: flex; flex: 0 0 auto; gap: .15rem; white-space: nowrap; }
.replay-button { min-width: 27px; min-height: 27px; padding: 0 .38rem; font-size: .62rem; }
.replay-range-wrap { position: relative; grid-column: 2; grid-row: 1; display: flex; align-items: center; padding: 0 .65rem; border-bottom: 1px solid var(--line-soft); }
.replay-range { position: absolute; inset: 0 .65rem; width: calc(100% - 1.3rem); opacity: 0; cursor: ew-resize; z-index: 2; }
.replay-track { width: 100%; height: 4px; border-radius: var(--radius-sm); background: var(--line); }
.replay-progress { display: block; height: 100%; background: var(--accent); }
.replay-events { grid-column: 2; grid-row: 2 / 4; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(70px,1fr); gap: 1px; margin: 0; padding: 5px .65rem; overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; list-style: none; }
.replay-event { position: relative; min-width: 0; border-top: 5px solid #69655d; color: transparent; }
.replay-event[data-active="true"] { border-color: var(--accent); background: rgba(88,200,192,.08); }
.replay-event[data-status="running"] { border-color: var(--teal); }.replay-event[data-status="completed"] { border-color: var(--gold); }.replay-event[data-status="failed"] { border-color: var(--danger); }
.replay-event[data-kind="prompt"] { border-top-style: double; border-color: #8ecae6; }.replay-event[data-kind="spawn"] { border-color: var(--gold-bright); }.replay-event[data-kind="failure"],.replay-event[data-kind="tool_error"] { border-color: var(--danger); }
.replay-event[data-kind^="tool_"]::after { position: absolute; right: 2px; bottom: 2px; left: 2px; height: calc(1px + var(--tool-density, 1) * 1px); background: var(--green); opacity: .72; content: ""; }
.replay-event[data-tool-density="0"] { --tool-density: 0; }.replay-event[data-tool-density="1"] { --tool-density: 1; }.replay-event[data-tool-density="2"] { --tool-density: 2; }.replay-event[data-tool-density="3"] { --tool-density: 3; }.replay-event[data-tool-density="4"] { --tool-density: 4; }
.status-bar { min-width: 0; display: flex; align-items: center; gap: .65rem; padding: 0 .55rem; overflow: hidden; border-top: 1px solid var(--line); background: #12110f; color: var(--muted); font: .58rem/1 monospace; }
.status-bar > span { min-width: 0; white-space: nowrap; }
.status-bar .status-title { flex: 1; overflow: hidden; text-overflow: ellipsis; color: var(--text); }
.status-bar strong { color: var(--gold-bright); font-weight: 600; }
.evidence-panel { min-width: 0; min-height: 0; display: grid; grid-template-rows: 48px auto minmax(0,1fr); overflow: hidden; border-left: 1px solid var(--line); background: var(--panel); }
.evidence-panel[data-open="false"] { visibility: hidden; }
.panel-header { display: flex; align-items: center; justify-content: space-between; gap: .5rem; min-width: 0; padding: .55rem .7rem; border-bottom: 1px solid var(--line); }
.inspector-tabs { min-width: 0; display: grid; grid-template-columns: repeat(6,minmax(0,1fr)); border-bottom: 1px solid var(--line); overflow-x: auto; }
.inspector-tabs button { min-width: 62px; min-height: 34px; padding: 0 .32rem; border: 0; border-right: 1px solid var(--line-soft); background: #171614; color: var(--muted); font-size: .55rem; cursor: pointer; }
.inspector-tabs button[aria-selected="true"] { color: var(--accent); box-shadow: inset 0 -2px 0 var(--accent); }
.inspector-panel { min-width: 0; min-height: 0; overflow: auto; }
.kicker { margin: 0 0 .12rem; color: var(--gold); font: .55rem/1 monospace; text-transform: uppercase; }
.panel-count { color: var(--gold-bright); font: .6rem/1 monospace; }
.selected-node-summary { padding: .8rem; border-bottom: 1px solid var(--line); }
.selected-node-summary strong { display: block; color: var(--gold-bright); font-size: .82rem; }
.selected-node-summary p { color: var(--muted); font-size: .68rem; line-height: 1.5; }
.selected-node-facts { display: flex; flex-wrap: wrap; gap: .3rem; margin-top: .5rem; }
.selected-node-facts span, [data-live-selected-node-evidence] { padding: .2rem .35rem; border: 1px solid var(--line); border-radius: var(--radius-sm); color: #c0bbb1; background: #171614; font: .56rem/1.2 monospace; }
.selected-node-summary [data-live-selected-node-provenance], .selected-node-summary [data-live-selected-node-prompt] { margin: .38rem 0 0; padding-left: .45rem; border-left: 2px solid #444; overflow-wrap: anywhere; }
.evidence-drawer { min-height: 0; overflow: auto; padding: .55rem; }
.evidence-list { display: grid; gap: .35rem; }
.evidence-item { padding: .55rem; border: 1px solid var(--line); border-left: 2px solid #69655d; border-radius: var(--radius-sm); background: #191816; }
.evidence-item[data-associated="true"] { border-left-color: var(--accent); }
.evidence-item[data-transfer-state="planned"] { border-left-style: dashed; border-left-color: var(--dim); background: #171614; }
.evidence-item[data-transfer-state="planned"] .evidence-status { color: #aaa; }
.evidence-item[data-delivery-observed="true"] { border-left-color: var(--green); }
.history-prompt { border-left-color: #8ecae6; }.history-tool { border-left-color: var(--green); }.history-failure,.history-tool_error { border-left-color: var(--danger); }
.history-footer { display: flex; align-items: center; justify-content: space-between; gap: .4rem; }.history-source { min-width: 0; overflow: hidden; color: #777; font: .52rem/1.2 monospace; text-overflow: ellipsis; white-space: nowrap; }
.empty-state { height: 100%; display: grid; place-content: center; text-align: center; color: var(--muted); }
.empty-title { color: var(--text); }
.live-dialog { position: fixed; z-index: 40; inset: 0; display: grid; place-items: center; padding: 1rem; background: rgba(0,0,0,.72); }
.dialog-card { width: min(640px,100%); max-height: min(78dvh,720px); overflow: auto; border: 1px solid var(--line-strong); border-radius: var(--radius); background: var(--panel); box-shadow: 0 24px 80px rgba(0,0,0,.6); }
.dialog-header { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; padding: .65rem .8rem; border-bottom: 1px solid var(--line); background: var(--panel); }
.dialog-title { margin: 0; font-size: .82rem; }
.dialog-body { padding: .8rem; }
.node-card[data-replay-visible="false"] { opacity: 0; pointer-events: none; visibility: hidden; }
.info-facts { display: grid; gap: .45rem; margin: .2rem 0 1rem; padding: .7rem; border: 1px solid var(--line); border-radius: var(--radius); background: rgba(255,255,255,.018); }
.info-fact-row { display: grid; grid-template-columns: 8rem minmax(0,1fr); gap: .75rem; align-items: baseline; padding-bottom: .35rem; border-bottom: 1px solid rgba(255,255,255,.06); }
.info-fact-row:last-child { border-bottom: 0; padding-bottom: 0; }
.info-fact-label { color: var(--subtle); font-size: .68rem; text-transform: uppercase; letter-spacing: .04em; }
.info-fact-value { min-width: 0; color: var(--bright); font-size: .76rem; overflow-wrap: anywhere; }
.info-fact-prompt { display: grid; gap: .35rem; margin-top: .25rem; }
.info-fact-prompt p { margin: 0; line-height: 1.45; }
.hub-switcher { display: grid; grid-template-columns: 1fr 1fr; gap: .7rem; }
.hub-field { display: grid; gap: .3rem; color: var(--muted); font-size: .65rem; }
.hub-select { width: 100%; min-width: 0; height: 36px; padding: 0 .5rem; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); background: #131210; color: var(--text); }
.hub-status { grid-column: 1 / -1; margin: 0; color: var(--muted); font-size: .65rem; }
.session-list { display: grid; gap: .38rem; margin-top: .7rem; }.session-card { width: 100%; display: grid; grid-template-columns: minmax(0,1fr) auto; gap: .28rem .7rem; padding: .65rem; border: 1px solid var(--line); border-left: 3px solid #69655d; border-radius: var(--radius); background: #171614; color: var(--text); text-align: left; cursor: pointer; }.session-card:hover,.session-card:focus-visible,.session-card[data-active="true"] { border-color: var(--accent); background: rgba(88,200,192,.04); outline: none; }.session-card-title { min-width: 0; overflow: hidden; font-size: .72rem; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }.session-card-activity { color: var(--gold-bright); font: .58rem/1.2 monospace; }.session-card-facts { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: .35rem; color: var(--muted); font: .56rem/1.2 monospace; }.session-card-facts span + span::before { margin-right: .35rem; color: var(--dim); content: "·"; }
.shortcut-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: .35rem .8rem; margin: 0; }
.shortcut-grid div { display: flex; justify-content: space-between; gap: 1rem; padding: .35rem 0; border-bottom: 1px solid var(--line-soft); color: var(--muted); font-size: .68rem; }
kbd { min-width: 28px; padding: .16rem .3rem; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); background: #131210; color: var(--gold-bright); text-align: center; font: .58rem/1.2 monospace; }
.share-panel, .control-panel { margin-top: .7rem; border: 1px solid var(--line); }
.share-content, .control-content { padding: .7rem; }.share-actions,.control-actions { display: flex; flex-wrap: wrap; gap: .3rem; }.share-status,.control-status,.control-result,.control-error { color: var(--muted); font-size: .65rem; overflow-wrap: anywhere; }.control-error { color: var(--danger); }
.stage-overview { flex: 0 0 auto; margin: 0; padding: .42rem .55rem .5rem; overflow-x: auto; background: #0d0f13; border: 0; border-bottom: 1px solid #2e2e2e; border-radius: 0; }
.stage-overview-header { display: flex; align-items: baseline; justify-content: space-between; gap: .8rem; margin-bottom: .38rem; }
.stage-overview-header .kicker { margin: 0; color: var(--gold-bright); font: 600 .55rem/1 monospace; letter-spacing: .08em; }
.stage-overview-header h2 { margin: 0; color: var(--text); font: 600 .7rem/1.1 monospace; }
.stage-overview-header > span { color: var(--muted); font: .53rem/1 monospace; }
.stage-rail { display: grid; grid-template-columns: repeat(8, minmax(110px, 1fr)); gap: .25rem; min-width: 900px; margin: 0; padding: 0; list-style: none; }
.stage-step { position: relative; display: flex; align-items: center; gap: .35rem; min-width: 0; padding: .3rem .34rem; color: var(--muted); background: #181715; border: 1px solid var(--line-soft); border-radius: var(--radius-sm); }
.stage-step[data-state="current"] { color: var(--text); border-color: var(--accent); background: rgba(88,200,192,.07); }
.stage-step[data-state="completed"] { color: var(--gold-bright); border-color: #5a4b08; }
.stage-step-marker { display: grid; flex: 0 0 1.2rem; width: 1.2rem; height: 1.2rem; place-items: center; color: #111; background: #555; border-radius: 50%; font: 700 .52rem/1 monospace; }
.stage-step[data-state="current"] .stage-step-marker { background: var(--accent); }.stage-step[data-state="completed"] .stage-step-marker { background: var(--gold); }
.stage-step-copy { display: grid; min-width: 0; gap: .08rem; }
.stage-step-name { overflow: hidden; color: inherit; font: 600 .57rem/1 monospace; text-overflow: ellipsis; white-space: nowrap; }
.stage-step-state { color: var(--muted); font: .5rem/1 monospace; }
@media (max-width: 720px) {
  .shell { grid-template-rows: 78px minmax(0,1fr); }
  .top-run-context, .connection span:last-child { display: none; }
  .topbar { display: grid; grid-template-columns: auto minmax(0,1fr) auto; grid-template-rows: 40px 32px; gap: 0 .35rem; padding-inline: .4rem; }
  .brand { min-width: 0; }
  .work-view-switcher { grid-column: 1 / -1; grid-row: 2; justify-self: stretch; width: 100%; }
  .work-view-tab { min-width: 0; }
  .topbar-actions { grid-column: 3; grid-row: 1; min-width: 0; flex: 0 0 auto; gap: .12rem; }
  .connection { margin: 0 .1rem 0 0; }
  .topbar-button { min-width: 30px; padding-inline: .3rem; }
  .workspace-grid, .workspace-grid[data-inspector-open="true"] { display: block; }
  .work-surface-view { height: 100%; }
  .work-surface-header { padding: .8rem; }
  .repository-layout { grid-template-columns: 1fr; }
  .operational-section { padding: .8rem; }
  .operational-section + .operational-section { border-top: 1px solid var(--line); border-left: 0; }
  .run-context { grid-template-columns: minmax(0, 1fr) auto; gap: .45rem; padding: .45rem .5rem .5rem; }
  .run-context-title { font-size: .82rem; }
  .run-context-task { font-size: .59rem; }
  .run-context-facts { grid-column: 1 / -1; grid-template-columns: repeat(3, minmax(0, 1fr)); border-left: 0; border-top: 1px solid var(--line); padding-top: .4rem; }
  .context-fact { padding: .08rem .4rem; }
  .run-context-source { justify-self: end; padding-left: 0; }
  .run-context-source strong { max-width: 86px; text-align: right; }
  .graph-panel { height: 100%; grid-template-rows: minmax(0,1fr) 104px 26px; }
  .graph-toolbar { top: .4rem; left: .4rem; right: .4rem; width: auto; overflow-x: auto; flex-wrap: nowrap; }
  .graph-tool-button { min-width: 40px; min-height: 40px; }
  [data-live-graph-fit], [data-live-graph-layout], [data-live-graph-zoom-out], [data-live-graph-zoom-in] { display: none; }
  .graph-canvas { overflow: auto; touch-action: pan-y; }
  .graph-scene { position: relative; width: 100% !important; height: auto !important; transform: none !important; }
  .node-list { position: relative; inset: auto; display: grid; gap: .45rem; padding: 3.4rem .5rem .6rem; }
  .node-card { position: relative !important; top: auto !important; left: auto !important; width: 100% !important; min-height: 84px !important; max-height: none; }
  .graph-canvas[data-semantic-zoom="cell"] .node-card { min-height: 84px !important; height: auto !important; padding: .6rem; overflow: hidden; border: 1px solid var(--line); border-left-width: 3px; border-radius: var(--radius); background: #1c1b19; }
  .graph-canvas[data-semantic-zoom="cell"] .node-card::after { display: none; }
  .graph-canvas[data-semantic-zoom="cell"] .node-card > * { visibility: visible; }
  .graph-canvas[data-semantic-zoom="cell"] .node-card .node-title { position: static; height: auto; padding: 0; font: inherit; }
  .edge-layer, .graph-minimap { display: none; }
  .replay-panel { grid-template-columns: 1fr; grid-template-rows: 42px 28px 34px; }
  .replay-dock-header { grid-row: 1; min-width: 0; grid-template-columns: minmax(64px,1fr) auto; border-right: 0; border-bottom: 1px solid var(--line); }
  .replay-range-wrap { grid-column: 1; grid-row: 2; }
  .replay-events { grid-column: 1; grid-row: 3; }
  .evidence-panel { position: fixed; z-index: 30; right: 0; bottom: 0; left: 0; height: min(76dvh,660px); border: 1px solid var(--line-strong); border-radius: var(--radius) var(--radius) 0 0; transform: translateY(102%); transition: transform .18s ease; visibility: visible !important; }
  .evidence-panel[data-open="true"] { transform: translateY(0); }
  .inspector-tabs { grid-template-columns: repeat(6,minmax(72px,1fr)); }
  .status-bar { gap: .45rem; }.status-bar .status-nodes,.status-bar .status-transport { display: none; }
  .hub-switcher, .shortcut-grid { grid-template-columns: 1fr; }
  .hub-status { grid-column: 1; }
}
@media (max-width: 380px) { .brand-title { display: none; }.top-run-context strong { max-width: 24vw; }.topbar-button { font-size: .62rem; }.status-bar .status-camera { display: none; }.operational-row { grid-template-columns: 82px minmax(0,1fr); }.work-surface-header { gap: .5rem; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; } }
`;

export function renderLiveControlRoomPage({
  snapshot = null,
  catalog = null,
  snapshotEndpoint = DEFAULT_SNAPSHOT_ENDPOINT,
  eventsEndpoint = DEFAULT_EVENTS_ENDPOINT,
  projectsEndpoint = DEFAULT_PROJECTS_ENDPOINT,
  replayEndpoint = DEFAULT_REPLAY_ENDPOINT,
  shareEndpoint = DEFAULT_SHARE_ENDPOINT,
  controlEndpoint = DEFAULT_CONTROL_ENDPOINT,
  controlEnabled = false,
  commandCapabilities = null,
  controlHeader = null,
  controlToken = null,
} = {}) {
  const safeSnapshotEndpoint = normalizeEndpoint(snapshotEndpoint, DEFAULT_SNAPSHOT_ENDPOINT);
  const safeEventsEndpoint = normalizeEndpoint(eventsEndpoint, DEFAULT_EVENTS_ENDPOINT);
  const safeProjectsEndpoint = normalizeEndpoint(projectsEndpoint, DEFAULT_PROJECTS_ENDPOINT);
  const safeReplayEndpoint = normalizeEndpoint(replayEndpoint, DEFAULT_REPLAY_ENDPOINT);
  const safeShareEndpoint = normalizeEndpoint(shareEndpoint, DEFAULT_SHARE_ENDPOINT);
  const safeControlEndpoint = normalizeEndpoint(controlEndpoint, DEFAULT_CONTROL_ENDPOINT);
  const hasSnapshotControl = Boolean(snapshot && typeof snapshot === "object" && (Object.prototype.hasOwnProperty.call(snapshot, "control") || Object.prototype.hasOwnProperty.call(snapshot, "controls")));
  const snapshotControl = hasSnapshotControl ? normalizeControlConfig(snapshot.control ?? snapshot.controls) : null;
  const configuredControl = normalizeControlConfig({ controlEnabled, commandCapabilities, controlHeader, controlToken });
  const safeControlConfig = hasSnapshotControl ? snapshotControl : configuredControl;
  const initialJson = safeJsonForHtml(snapshot);
  const initialCatalogJson = safeJsonForHtml(catalog);
  const controlConfigJson = safeJsonForHtml(safeControlConfig);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#121212">
  <meta name="description" content="Meta_Kim Live 只读实时运行控制中心">
  <link rel="icon" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHZpZXdCb3g9JzAgMCAzMiAzMic+PHJlY3Qgd2lkdGg9JzMyJyBoZWlnaHQ9JzMyJyByeD0nOCcgZmlsbD0nIzA3MGIxNicvPjxwYXRoIGQ9J004IDIyVjEwaDRsNCA1IDQtNWg0djEyaC00di02bC00IDUtNC01djZ6JyBmaWxsPScjNmVlN2ZmJy8+PC9zdmc+">
  <title>Meta_Kim Live · 控制中心</title>
  <style>${GRAPH_FIRST_CSS}</style>
</head>
<body>
  <a class="skip-link" id="skip-to-content" href="#live-main" data-i18n-en="Skip to content" data-i18n-zh="跳到主要内容">跳到主要内容</a>
  <div id="live-app" class="shell" data-snapshot-endpoint="${escapeHtml(safeSnapshotEndpoint)}" data-events-endpoint="${escapeHtml(safeEventsEndpoint)}" data-projects-endpoint="${escapeHtml(safeProjectsEndpoint)}" data-replay-endpoint="${escapeHtml(safeReplayEndpoint)}" data-share-endpoint="${escapeHtml(safeShareEndpoint)}" data-control-endpoint="${escapeHtml(safeControlEndpoint)}">
    <header class="topbar" aria-label="Meta_Kim Live header">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">M</span>
        <p class="brand-title">Meta_Kim Live</p>
      </div>
      <div class="top-run-context"><strong data-live-run-title>正在等待运行快照</strong><span data-live-run-id>未识别运行</span></div>
      <div class="work-view-switcher" role="tablist" aria-label="Work surface view"><button class="work-view-tab" id="work-view-repository" type="button" role="tab" aria-controls="repository-view" aria-selected="false" tabindex="-1" data-live-work-view="repository" data-i18n-en="Repository" data-i18n-zh="仓库">仓库</button><button class="work-view-tab" id="work-view-workspace" type="button" role="tab" aria-controls="workspace-view" aria-selected="false" tabindex="-1" data-live-work-view="workspace" data-i18n-en="Workspace" data-i18n-zh="工作区">工作区</button><button class="work-view-tab" id="work-view-run" type="button" role="tab" aria-controls="run-view" aria-selected="true" data-live-work-view="run" data-i18n-en="Run" data-i18n-zh="运行">运行</button></div>
      <div class="topbar-actions"><div class="connection" aria-live="polite"><span class="connection-dot" data-live-connection-dot aria-hidden="true"></span><span data-live-connection data-i18n-en="Connecting…" data-i18n-zh="正在连接…">正在连接…</span></div><button class="topbar-button" type="button" data-live-open-sessions data-i18n-en="Sessions" data-i18n-zh="会话">会话</button><button class="topbar-button" type="button" data-live-language-toggle aria-label="Switch to English">EN</button><button class="topbar-button" type="button" data-live-open-help aria-label="Help" title="Help">?</button><button class="topbar-button" type="button" data-live-open-info aria-label="Session info" title="Session info">i</button></div>
    </header>
    <main class="main" id="live-main" tabindex="-1">
      <div class="sr-only" data-live-region aria-live="polite"></div>
      <section class="run-context" aria-label="Run context">
        <div class="run-context-heading">
          <span class="context-kicker" data-i18n-en="Current run" data-i18n-zh="当前运行">当前运行</span>
          <h1 class="run-context-title" data-live-context-title>正在等待运行快照</h1>
          <p class="run-context-task" data-live-context-task>正在等待任务摘要</p>
        </div>
        <div class="run-context-facts" role="list" aria-label="Run facts">
          <div class="context-fact" role="listitem"><span data-i18n-en="Status" data-i18n-zh="状态">状态</span><strong data-live-context-status>存疑</strong></div>
          <div class="context-fact" role="listitem"><span data-i18n-en="Stage" data-i18n-zh="阶段">阶段</span><strong data-live-context-stage>—</strong></div>
          <div class="context-fact" role="listitem"><span data-i18n-en="Nodes" data-i18n-zh="节点">节点</span><strong data-live-context-nodes>0</strong></div>
          <div class="context-fact" role="listitem"><span data-i18n-en="Events" data-i18n-zh="事件">事件</span><strong data-live-context-events>0</strong></div>
          <div class="context-fact" role="listitem"><span data-i18n-en="Evidence" data-i18n-zh="证据">证据</span><strong data-live-context-evidence>0</strong></div>
          <div class="context-fact" role="listitem"><span data-i18n-en="Updated" data-i18n-zh="更新">更新</span><strong data-live-context-updated>—</strong></div>
        </div>
        <div class="run-context-source"><span data-i18n-en="Source" data-i18n-zh="来源">来源</span><strong data-live-context-source>local observer</strong></div>
      </section>
      <section class="workspace-grid" data-inspector-open="false" aria-label="Live execution workspace">
        <section class="work-surface-view repository-view" id="repository-view" role="tabpanel" aria-labelledby="work-view-repository" data-live-repository-view hidden><header class="work-surface-header"><div><span class="context-kicker" data-i18n-en="Repository" data-i18n-zh="仓库">仓库</span><h2 data-live-repository-title>已登记项目</h2><p data-live-repository-boundary>仓库边界不可用</p></div><span class="surface-state" data-i18n-en="Observed catalog" data-i18n-zh="已观测目录">已观测目录</span></header><div class="repository-layout"><section class="operational-section" aria-labelledby="repository-facts-title"><h3 id="repository-facts-title" data-i18n-en="Repository facts" data-i18n-zh="仓库事实">仓库事实</h3><div class="operational-list" data-live-repository-facts></div></section><section class="operational-section" aria-labelledby="repository-workspaces-title"><h3 id="repository-workspaces-title" data-i18n-en="Workspace sessions" data-i18n-zh="工作区会话">工作区会话</h3><div class="workspace-children" data-live-repository-sessions></div></section></div></section>
        <section class="work-surface-view workspace-view" id="workspace-view" role="tabpanel" aria-labelledby="work-view-workspace" data-live-workspace-view hidden><header class="work-surface-header"><div><span class="context-kicker" data-i18n-en="Workspace" data-i18n-zh="工作区">工作区</span><h2 data-live-workspace-title>已观测工作区</h2><p data-live-workspace-boundary>工作区边界不可用</p></div><span class="surface-state" data-i18n-en="Run-scoped" data-i18n-zh="运行范围">运行范围</span></header><section class="operational-section workspace-availability" aria-labelledby="workspace-availability-title"><h3 id="workspace-availability-title" data-i18n-en="Available surfaces" data-i18n-zh="可用界面">可用界面</h3><div class="operational-list" data-live-workspace-facts></div></section></section>
        <section class="graph-panel" id="run-view" role="tabpanel" aria-labelledby="work-view-run" data-live-run-view aria-label="Run view">
          <div class="graph-stage" data-live-graph-viewport>
            <h1 class="sr-only" id="graph-title" data-i18n-en="Execution graph" data-i18n-zh="实时运行图">实时运行图</h1>
            <div class="graph-toolbar" aria-label="Graph camera controls"><button class="graph-tool-button" type="button" data-live-graph-fit aria-label="Overview" title="Overview (O)" data-i18n-en="Overview" data-i18n-zh="总览">总览</button><button class="graph-tool-button" type="button" data-live-graph-follow data-active="true" aria-pressed="true" aria-label="Follow active node" title="Follow (F)" data-i18n-en="Follow" data-i18n-zh="跟随">跟随</button><button class="graph-tool-button" type="button" data-live-graph-layout aria-label="Relayout graph" title="Relayout (R)" data-i18n-en="Relayout" data-i18n-zh="重排">重排</button><button class="graph-tool-button" type="button" data-live-graph-zoom-out aria-label="Zoom graph out" title="Zoom out">−</button><button class="graph-tool-button" type="button" data-live-graph-zoom-in aria-label="Zoom graph in" title="Zoom in">+</button><button class="graph-tool-button" type="button" data-evidence-toggle aria-controls="live-inspector" aria-expanded="false" aria-label="Open inspector" title="Inspector" data-i18n-en="Inspector" data-i18n-zh="检查器">检查器</button></div>
            <section class="stage-overview" aria-label="Stage progress"><div class="stage-overview-header"><div><p class="kicker" data-i18n-en="Eight-stage spine" data-i18n-zh="八阶段主线">八阶段主线</p><h2 data-i18n-en="Critical to Evolution" data-i18n-zh="从目标确认到经验沉淀">从目标确认到经验沉淀</h2></div><span data-i18n-en="Replay-backed state" data-i18n-zh="状态来自回放事件">状态来自回放事件</span></div><ol class="stage-rail" data-live-stage-rail></ol></section>
            <div class="graph-canvas" data-live-graph role="region" aria-label="Read-only execution graph" tabindex="0">
              <div class="graph-scene" data-live-graph-scene>
                <svg class="edge-layer" data-live-edge-layer aria-hidden="true" focusable="false"></svg>
                <div class="node-list" data-live-node-list role="listbox" aria-label="Execution nodes"></div>
              </div>
              <div class="graph-minimap" data-live-graph-minimap aria-label="Graph minimap" role="img"><div class="minimap-scene" data-live-minimap-scene></div><span class="minimap-viewport" data-live-minimap-viewport aria-hidden="true"></span></div>
            </div>
            <div class="graph-empty" data-live-graph-empty hidden><p data-i18n-en="No task nodes in this snapshot." data-i18n-zh="当前快照中没有任务节点。">当前快照中没有任务节点。</p></div>
          </div>
          <section class="replay-panel replay-dock" aria-labelledby="replay-title">
            <header class="replay-dock-header"><div class="replay-current"><span class="panel-title" id="replay-title" data-i18n-en="Replay timeline" data-i18n-zh="回放时间线">回放时间线</span><span class="panel-note" data-replay-status>正在等待回放数据</span></div><div class="replay-controls"><button class="replay-button" type="button" data-replay-prev aria-label="Previous replay event" title="Previous">‹</button><button class="replay-button replay-play" type="button" data-replay-play aria-label="Play replay"><span aria-hidden="true">▶</span><span class="sr-only" data-replay-play-label>播放</span></button><button class="replay-button" type="button" data-replay-next aria-label="Next replay event" title="Next">›</button><button class="replay-button" type="button" data-replay-live aria-label="Go to live replay position" data-i18n-en="Live" data-i18n-zh="实时">实时</button><button class="replay-button replay-reset" type="button" data-replay-reset aria-label="Reset replay" data-i18n-en="Reset" data-i18n-zh="重置">重置</button></div></header>
            <div class="replay-range-wrap"><label class="sr-only" for="replay-range" data-i18n-en="Replay position" data-i18n-zh="回放位置">回放位置</label><input class="replay-range" id="replay-range" data-replay-range type="range" min="0" max="0" value="0" step="1" aria-label="Replay position" disabled><div class="replay-track" data-replay-track aria-hidden="true"><span class="replay-progress" data-replay-progress></span></div></div>
            <ol class="replay-events" data-replay-events data-replay-timeline aria-label="Replay events"></ol>
          </section>
          <div class="status-bar" role="status"><span class="status-transport"><span data-live-state data-state="stale"><span data-live-state-label>未更新</span></span></span><span class="status-title" data-live-status-title>等待运行</span><span><strong data-live-run-progress>—</strong> · <span data-live-run-stage>观测中</span></span><span class="status-nodes"><span data-live-run-workers>—</span> · <span data-live-node-count>0 个节点</span></span><span class="status-camera"><span data-i18n-en="Camera" data-i18n-zh="相机">相机</span> <strong data-live-camera-mode>跟随</strong></span><span class="sr-only" data-live-run-started>—</span><span class="sr-only" data-live-run-updated>—</span><span class="sr-only" data-live-source>本地观察器</span></div>
        </section>
        <aside class="panel evidence-panel" id="live-inspector" data-live-inspector data-open="false" aria-hidden="true" aria-labelledby="evidence-title">
          <header class="panel-header"><div><p class="kicker" data-i18n-en="Inspector" data-i18n-zh="检查器">检查器</p><h2 class="panel-title" id="evidence-title" data-i18n-en="Node provenance" data-i18n-zh="节点来源与依据">节点来源与依据</h2></div><div class="replay-controls"><span class="panel-count" data-live-evidence-count>00</span><button class="graph-tool-button" type="button" data-live-inspector-close aria-label="Close inspector" title="Close inspector">×</button></div></header>
          <div class="inspector-tabs" role="tablist" aria-label="Inspector sections"><button type="button" role="tab" id="inspector-tab-summary" aria-controls="inspector-panel-summary" aria-selected="true" data-live-inspector-tab="summary" data-i18n-en="Summary" data-i18n-zh="摘要">摘要</button><button type="button" role="tab" id="inspector-tab-conversation" aria-controls="inspector-panel-conversation" aria-selected="false" tabindex="-1" data-live-inspector-tab="conversation" data-i18n-en="Conversation" data-i18n-zh="对话">对话</button><button type="button" role="tab" id="inspector-tab-terminal" aria-controls="inspector-panel-terminal" aria-selected="false" tabindex="-1" data-live-inspector-tab="terminal" data-i18n-en="Terminal" data-i18n-zh="终端">终端</button><button type="button" role="tab" id="inspector-tab-changes" aria-controls="inspector-panel-changes" aria-selected="false" tabindex="-1" data-live-inspector-tab="changes" data-i18n-en="Changes" data-i18n-zh="变更">变更</button><button type="button" role="tab" id="inspector-tab-evidence" aria-controls="inspector-panel-evidence" aria-selected="false" tabindex="-1" data-live-inspector-tab="evidence" data-i18n-en="Evidence" data-i18n-zh="证据">证据</button><button type="button" role="tab" id="inspector-tab-context" aria-controls="inspector-panel-context" aria-selected="false" tabindex="-1" data-live-inspector-tab="context" data-i18n-en="Context" data-i18n-zh="上下文">上下文</button></div>
          <div class="inspector-panel" id="inspector-panel-summary" role="tabpanel" aria-labelledby="inspector-tab-summary" data-live-inspector-panel="summary" data-item-count="0"><div class="selected-node-summary" data-live-selected-node aria-live="polite"><strong data-live-selected-node-label>选择节点查看来源与依据</strong><div class="selected-node-facts"><span data-live-selected-node-status>状态 · —</span><span data-live-selected-node-owner>负责人 · —</span><span data-live-selected-node-runtime>运行时 · —</span><span data-live-selected-node-model>模型 · —</span><span data-live-selected-node-duration>耗时 · —</span><span data-live-selected-node-tools>工具 · —</span><span data-live-selected-node-tokens>输出 · —</span></div><p data-live-selected-node-summary>选择节点查看执行摘要。</p><p data-live-selected-node-evidence-detail>选择节点后将在这里显示终态依据。</p><p data-live-selected-node-provenance>来源 · —</p><p data-live-selected-node-prompt>提示词阶段 · —</p><p data-live-selected-node-loadout>能力装载 · —</p><span data-live-selected-node-evidence>证据会持续显示在抽屉中</span></div></div>
          <div class="inspector-panel evidence-drawer" id="inspector-panel-conversation" role="tabpanel" aria-labelledby="inspector-tab-conversation" data-live-inspector-panel="conversation" data-item-count="0" hidden><div class="evidence-list" data-live-conversation-list role="list" aria-label="Conversation summaries"></div></div>
          <div class="inspector-panel evidence-drawer" id="inspector-panel-terminal" role="tabpanel" aria-labelledby="inspector-tab-terminal" data-live-inspector-panel="terminal" data-item-count="0" hidden><div class="evidence-list" data-live-terminal-list role="list" aria-label="Terminal evidence"></div></div>
          <div class="inspector-panel evidence-drawer" id="inspector-panel-changes" role="tabpanel" aria-labelledby="inspector-tab-changes" data-live-inspector-panel="changes" data-item-count="0" hidden><div class="evidence-list" data-live-changes-list role="list" aria-label="Observed changes"></div></div>
          <div class="inspector-panel evidence-drawer" id="inspector-panel-evidence" role="tabpanel" aria-labelledby="inspector-tab-evidence" data-live-inspector-panel="evidence" data-item-count="0" data-evidence-drawer hidden><div class="evidence-list" data-live-evidence-list role="list" aria-label="Observed evidence"></div></div>
          <div class="inspector-panel evidence-drawer" id="inspector-panel-context" role="tabpanel" aria-labelledby="inspector-tab-context" data-live-inspector-panel="context" data-item-count="0" hidden><div class="evidence-list" data-live-context-transfer-list role="list" aria-label="Context transfers"></div></div>
        </aside>
      </section>
      <section class="panel share-panel" aria-labelledby="share-title">
        <header class="panel-header"><div><h2 class="panel-title" id="share-title" data-i18n-en="Share locally" data-i18n-zh="本地分享">本地分享</h2><p class="panel-note" data-i18n-en="No upload, no external assets, no mutation." data-i18n-zh="不上传、不加载外部资源、不修改运行。">不上传、不加载外部资源、不修改运行。</p></div><span class="panel-count" data-i18n-en="LOCAL ONLY" data-i18n-zh="仅限本地">仅限本地</span></header>
        <div class="share-content"><div class="share-actions"><button class="replay-button share-button" type="button" data-live-share-export-json data-i18n-en="Export JSON" data-i18n-zh="导出 JSON">导出 JSON</button><button class="replay-button share-button" type="button" data-live-share-copy-pr data-i18n-en="Copy PR card" data-i18n-zh="复制 PR 卡片">复制 PR 卡片</button><button class="replay-button share-button" type="button" data-live-share-copy-readme data-i18n-en="README embed" data-i18n-zh="README 嵌入">README 嵌入</button></div><p class="share-status" id="meta-kim-live-share-status" data-live-share-status role="status" aria-live="polite" data-i18n-en="Share actions stay local and require the local /api/share endpoint." data-i18n-zh="分享操作仅在本地进行，并使用本地 /api/share 接口。">分享操作仅在本地进行，并使用本地 /api/share 接口。</p></div>
      </section>
      <section class="panel control-panel" data-live-control-panel aria-labelledby="control-title" aria-busy="false"${safeControlConfig ? "" : " hidden"}>
        <header class="panel-header"><div><h2 class="panel-title" id="control-title" data-i18n-en="Continuation controls" data-i18n-zh="继续执行控制">继续执行控制</h2><p class="panel-note" data-i18n-en="Opt-in commands require explicit local capabilities and durable verification." data-i18n-zh="可选控制命令需要明确的本地能力与耐久验证。">可选控制命令需要明确的本地能力与耐久验证。</p></div><span class="panel-count" data-i18n-en="AUTHORITY-BOUND" data-i18n-zh="受权限约束">受权限约束</span></header>
        <div class="control-content"><div class="control-actions" data-live-control-actions>${safeControlConfig ? LIVE_CONTROL_ACTIONS.map((action) => `<button class="replay-button control-button" type="button" data-live-control-action="${action}" aria-label="${action[0].toUpperCase() + action.slice(1)} run">${action[0].toUpperCase() + action.slice(1)}</button>`).join("") : ""}</div><p class="control-status" data-live-control-status role="status" aria-live="polite" data-i18n-en="Controls are read-only until the local service declares every action available." data-i18n-zh="在本地服务明确声明所有操作可用前，控制功能保持只读。">在本地服务明确声明所有操作可用前，控制功能保持只读。</p><p class="control-result" data-live-control-result role="status" aria-live="polite"></p><p class="control-error" data-live-control-error role="alert" aria-live="assertive"></p></div>
      </section>
      <section class="empty-state" data-live-empty hidden aria-labelledby="empty-title"><span class="empty-glyph" aria-hidden="true">◌</span><h2 class="empty-title" id="empty-title" data-i18n-en="No live snapshot yet" data-i18n-zh="尚无实时快照">尚无实时快照</h2><p class="empty-copy" data-live-empty-message>正在等待本地观察器发布运行快照。</p></section>
    </main>
    <section class="live-dialog" data-live-dialog data-live-sessions-dialog role="dialog" aria-modal="true" aria-labelledby="sessions-title" aria-hidden="true" hidden><div class="dialog-card"><header class="dialog-header"><h2 class="dialog-title" id="sessions-title" data-i18n-en="Sessions" data-i18n-zh="会话">会话</h2><button class="graph-tool-button" type="button" data-live-dialog-close aria-label="Close sessions">×</button></header><div class="dialog-body"><section class="hub-switcher" aria-label="Meta_Kim project and session selection"><label class="hub-field" for="live-project-select"><span data-i18n-en="Project" data-i18n-zh="项目">项目</span><select class="hub-select" id="live-project-select" data-live-project-select aria-label="Choose a Meta_Kim project"><option value="">正在加载已登记项目…</option></select></label><label class="hub-field" for="live-session-select"><span data-i18n-en="Session / run" data-i18n-zh="会话 / 运行">会话 / 运行</span><select class="hub-select" id="live-session-select" data-live-session-select aria-label="Choose a governed session" disabled><option value="">请先选择项目</option></select></label><p class="hub-status" data-live-hub-status role="status" aria-live="polite">正在加载本地项目目录…</p></section><div class="session-list" data-live-session-list role="list" aria-label="Governed sessions"></div></div></div></section>
    <section class="live-dialog" data-live-dialog data-live-help-dialog role="dialog" aria-modal="true" aria-labelledby="help-title" aria-hidden="true" hidden><div class="dialog-card"><header class="dialog-header"><h2 class="dialog-title" id="help-title" data-i18n-en="Keyboard and camera" data-i18n-zh="键盘与相机">键盘与相机</h2><button class="graph-tool-button" type="button" data-live-dialog-close aria-label="Close help">×</button></header><div class="dialog-body"><div class="shortcut-grid"><div><span>Overview</span><kbd>O</kbd></div><div><span>Follow active</span><kbd>F</kbd></div><div><span>Relayout</span><kbd>R</kbd></div><div><span>Play / pause</span><kbd>Space</kbd></div><div><span>Previous event</span><kbd>[</kbd></div><div><span>Next event</span><kbd>]</kbd></div><div><span>Jump live</span><kbd>End</kbd></div><div><span>Session info</span><kbd>I</kbd></div><div><span>Close</span><kbd>Esc</kbd></div><div><span>Help</span><kbd>?</kbd></div></div></div></div></section>
    <section class="live-dialog" data-live-dialog data-live-info-dialog role="dialog" aria-modal="true" aria-labelledby="info-title" aria-hidden="true" hidden><div class="dialog-card"><header class="dialog-header"><h2 class="dialog-title" id="info-title" data-i18n-en="Session info and local tools" data-i18n-zh="会话信息与本地工具">会话信息与本地工具</h2><button class="graph-tool-button" type="button" data-live-dialog-close aria-label="Close session info">×</button></header><div class="dialog-body"><p class="panel-note"><span data-i18n-en="Local observer" data-i18n-zh="本地观察器">本地观察器</span> · <span data-live-last-update>最近观测 —</span> · <span data-i18n-en="Read-only by default" data-i18n-zh="默认只读">默认只读</span></p><div class="info-facts" data-live-info-facts></div><div data-live-info-tools></div></div></div></section>
  </div>
  <script type="application/json" id="live-initial-snapshot">${initialJson}</script>
  <script type="application/json" id="live-initial-catalog">${initialCatalogJson}</script>
  <script type="application/json" id="live-control-config">${controlConfigJson}</script>
  <script>${CLIENT_SCRIPT}</script>
</body>
</html>`;
}

export const buildLiveControlRoomPage = renderLiveControlRoomPage;
export const renderLivePage = renderLiveControlRoomPage;
