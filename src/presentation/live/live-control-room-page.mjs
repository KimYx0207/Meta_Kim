/**
 * Dependency-free presentation for the Meta_Kim Live control room.
 *
 * The page is deliberately a shell: the browser reads the frozen v1 snapshot
 * from the local API and listens for refresh hints over SSE. Snapshot values
 * are only ever placed into DOM text nodes by the client script. This keeps a
 * compromised or malformed observer payload from becoming executable markup.
 */

export const LIVE_SNAPSHOT_SCHEMA_VERSION = "meta-kim-live-snapshot-v1";

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
  const controlConfigElement = document.getElementById("live-control-config");
  const reducedMotion = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : { matches: false };

  const LANGUAGE_STORAGE_KEY = "meta-kim-live-language";
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
    "Zoom graph out": "缩小运行图",
    "Zoom graph in": "放大运行图",
    "Read-only execution graph": "只读执行运行图",
    "Execution nodes": "执行节点",
    "Graph minimap": "运行图小地图",
    "Toggle evidence drawer": "展开或收起证据抽屉",
    "Observed evidence": "已观测证据",
    "Previous replay event": "上一个回放事件",
    "Play replay": "播放回放",
    "Next replay event": "下一个回放事件",
    "Go to live replay position": "回到实时回放位置",
    "Reset replay": "重置回放",
    "Replay position": "回放位置",
    "Replay events": "回放事件"
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
    if (text.startsWith("Run snapshot updated: ")) return "运行快照已更新：" + text.slice(22);
    if (text.startsWith("Last observed ")) return "最近观测 " + text.slice(14);
    if (text.startsWith("Selected node: ")) return "已选择节点：" + text.slice(15);
    if (text.startsWith("Replay ")) return "回放 " + text.slice(7);
    if (text.startsWith("Stage state projected from")) return "阶段状态来自运行记录";
    if (text.endsWith(" evidence")) return text.slice(0, -9) + " 证据";
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
  const hubStatus = app.querySelector("[data-live-hub-status]");
  const stateLabel = app.querySelector("[data-live-state-label]");
  const stateChip = app.querySelector("[data-live-state]");
  const title = app.querySelector("[data-live-run-title]");
  const runId = app.querySelector("[data-live-run-id]");
  const stage = app.querySelector("[data-live-run-stage]");
  const started = app.querySelector("[data-live-run-started]");
  const updated = app.querySelector("[data-live-run-updated]");
  const source = app.querySelector("[data-live-source]");
  const graph = app.querySelector("[data-live-graph]");
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
  const selectedNodeSummary = app.querySelector("[data-live-selected-node-summary]");
  const selectedNodeEvidenceDetail = app.querySelector("[data-live-selected-node-evidence-detail]");
  const evidenceList = app.querySelector("[data-live-evidence-list]");
  const evidenceCount = app.querySelector("[data-live-evidence-count]");
  const evidenceDrawer = app.querySelector("[data-evidence-drawer]");
  const evidenceToggle = app.querySelector("[data-evidence-toggle]");
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
  const runHero = app.querySelector(".run-hero");
  const runFacts = app.querySelector(".run-facts");
  const stageRail = app.querySelector("[data-live-stage-rail]");
  const runProgress = app.querySelector("[data-live-run-progress]");
  const runWorkers = app.querySelector("[data-live-run-workers]");
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
  let layoutMode = "flow";
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
  let catalogRefreshTimer = null;
  let selectionGeneration = 0;

  const statuses = new Set(["live", "stale", "in_doubt"]);
  const nodeStatuses = new Set(["running", "completed", "failed", "blocked", "in_doubt", "queued"]);
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

  function normalizeSnapshot(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const hasRun = Boolean(input.run && typeof input.run === "object" && !Array.isArray(input.run));
    const runInput = hasRun ? input.run : {};
    const sourceInput = input.source && typeof input.source === "object" ? input.source : {};
    const nodeInput = Array.isArray(input.nodes) ? input.nodes : [];
    const edgeInput = Array.isArray(input.edges) ? input.edges : [];
    const evidenceInput = Array.isArray(input.evidence) ? input.evidence : [];
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

    // The browser is a live observer, not a transcript dump. Keep the graph
    // bounded so a noisy run cannot grow one DOM card per event forever.
    const nodes = nodeInput.slice(0, 128).map((node, index) => {
      const item = node && typeof node === "object" ? node : {};
      return {
        id: display(firstValue(item, ["id", "nodeId"], "node-" + (index + 1)), "node-" + (index + 1)),
        label: display(firstValue(item, ["label", "title", "name", "nodeId"], "Untitled task"), "Untitled task"),
        status: normalizedNodeStatus(firstValue(item, ["status", "state"], "queued")),
        role: display(firstValue(item, ["roleDisplayName", "role", "ownerRole"], "worker"), "worker"),
        agent: display(firstValue(item, ["agent", "ownerAgent", "owner"], "—"), "—"),
        runtime: display(firstValue(item, ["runtime", "runtimeId", "runtimeInstanceAlias"], "local"), "local"),
        summary: display(firstValue(item, ["summary", "description", "message"], "No task detail available"), "No task detail available"),
        progress: numberOr(firstValue(item, ["progress", "progressPercent"], null), null),
      };
    });

    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const edges = edgeInput.slice(0, 256).map((edge, index) => {
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

    const evidence = evidenceInput.slice(0, 256).map((item, index) => {
      const record = item && typeof item === "object" ? item : {};
      return {
        id: display(firstValue(record, ["id", "evidenceId", "ref"], "evidence-" + (index + 1)), "evidence-" + (index + 1)),
        label: display(firstValue(record, ["label", "title", "kind", "type"], "Evidence item"), "Evidence item"),
        status: display(firstValue(record, ["status", "assessment", "state"], "observed"), "observed"),
        detail: display(firstValue(record, ["summary", "detail", "message", "description"], "Observed by the local runtime"), "Observed by the local runtime"),
        nodeId: display(firstValue(record, ["nodeId", "node", "ownerNodeId"], ""), ""),
        at: display(firstValue(record, ["timestamp", "occurredAt", "createdAt"], ""), ""),
      };
    });

    const replay = replayInputEvents.slice(0, 512).map((item, index) => {
      const record = item && typeof item === "object" ? item : {};
      return {
        id: display(firstValue(record, ["id", "eventId"], "event-" + (index + 1)), "event-" + (index + 1)),
        label: display(firstValue(record, ["label", "title", "message", "type"], "Run event"), "Run event"),
        nodeId: display(firstValue(record, ["nodeId", "node", "taskId"], ""), ""),
        at: display(firstValue(record, ["timestamp", "occurredAt", "at", "time"], ""), ""),
        status: normalizedNodeStatus(firstValue(record, ["status", "state"], "queued")),
      };
    });

    return {
      schemaVersion: display(input.schemaVersion, "unknown"),
      source: display(firstValue(sourceInput, ["label", "name", "kind"], input.source), "local observer"),
      run: hasRun ? {
        id: display(firstValue(runInput, ["id", "runId", "key"], input.runId), "unidentified run"),
        title: display(firstValue(runInput, ["title", "name", "label"], "Live execution"), "Live execution"),
        status: normalizedStatus(firstValue(runInput, ["status", "state", "runStatus"], input.status)),
        stage: display(firstValue(runInput, ["stage", "currentStage", "phase"], "Observing"), "Observing"),
        startedAt: display(firstValue(runInput, ["startedAt", "startTime"], "—"), "—"),
        updatedAt: display(firstValue(runInput, ["updatedAt", "lastUpdatedAt", "observedAt"], "—"), "—"),
      } : null,
      nodes,
      edges,
      evidence,
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
    return localize("Stale");
  }

  function updateConnection(kind, message) {
    if (connectionLabel) connectionLabel.textContent = localize(message);
    if (connectionDot) connectionDot.dataset.connection = kind;
  }

  function updateHeader(snapshot) {
    setText(title, snapshot.run.title, "Live execution");
    setText(runId, "Run · " + snapshot.run.id.slice(-8), "unidentified run");
    setText(stage, snapshot.run.stage, "Observing");
    setText(started, formatTime(snapshot.run.startedAt), "—");
    setText(updated, formatTime(snapshot.run.updatedAt), "—");
    setText(source, snapshot.source, "local observer");
    const completedSteps = snapshot.nodes.filter((node) => node.status === "completed").length;
    const activeWorkers = new Set(snapshot.nodes
      .filter((node) => ["running", "active"].includes(node.status))
      .map((node) => node.agent)
      .filter(Boolean));
    setText(runProgress, completedSteps + " of " + snapshot.nodes.length + " steps complete", "—");
    setText(runWorkers, activeWorkers.size
      ? activeWorkers.size + " active worker" + (activeWorkers.size === 1 ? "" : "s")
      : "No active workers", "—");
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
    return normalized && !["—", "unknown", "in_doubt", "in doubt", "unassigned", "local"].includes(normalized);
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

  function renderStageRail(snapshot) {
    clearChildren(stageRail);
    if (!stageRail) return;
    const currentIndex = stageIndex({ id: snapshot.run.stage, label: snapshot.run.stage });
    const nodeByStage = new Map();
    for (const node of snapshot.nodes) {
      const index = stageIndex(node);
      if (index >= 0 && !nodeByStage.has(index)) nodeByStage.set(index, node);
    }
    STAGE_ORDER.forEach((stageName, index) => {
      const node = nodeByStage.get(index) || null;
      const state = node?.status === "completed"
        ? "completed"
        : index === currentIndex || ["running", "active"].includes(node?.status)
          ? "current"
          : index < currentIndex
            ? "completed"
            : "upcoming";
      const item = makeElement("li", "stage-step");
      item.dataset.state = state;
      const marker = makeElement("span", "stage-step-marker", String(index + 1));
      marker.setAttribute("aria-hidden", "true");
      const copy = makeElement("span", "stage-step-copy");
      copy.append(
        makeElement("strong", "stage-step-name", stageName),
        makeElement("small", "stage-step-state", state === "current" ? "running" : state),
      );
      item.append(marker, copy);
      if (node) {
        item.tabIndex = 0;
        item.setAttribute("role", "button");
        item.addEventListener("click", () => selectNode(node.id));
        item.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") selectNode(node.id, { focus: true });
        });
      }
      stageRail.append(item);
    });
  }

  function layoutGraph(snapshot) {
    const nodes = snapshot.nodes;
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const parentById = new Map(snapshot.edges.map((edge) => [edge.to, edge.from]));
    const stageNodes = new Map();
    const stageFor = new Map();
    const branchSlots = new Map();
    const positions = new Map();
    const cardWidth = 168;
    const cardHeight = 96;
    const spineColumns = layoutMode === "compact" ? 8 : 4;
    const columnGap = layoutMode === "compact" ? 150 : 190;
    const rowGap = 126;
    const top = 38;
    const spineRows = Math.ceil(STAGE_ORDER.length / spineColumns);
    const branchTop = top + spineRows * rowGap + 32;

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
    updateMinimap();
  }

  function updateMinimap() {
    if (!graphMinimap || !graphMinimapScene || !graphMinimapViewport) return;
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
    const scale = Math.max(.28, Math.min(1.1, Math.min((width - padding * 2) / graphState.bounds.width, (height - padding * 2) / graphState.bounds.height)));
    updateCamera({
      scale,
      x: (width - graphState.bounds.width * scale) / 2,
      y: (height - graphState.bounds.height * scale) / 2,
    });
  }

  function zoomGraph(factor, anchorX, anchorY) {
    if (!graph) return;
    const localX = Number.isFinite(anchorX) ? anchorX : graph.clientWidth / 2;
    const localY = Number.isFinite(anchorY) ? anchorY : graph.clientHeight / 2;
    const worldX = (localX - camera.x) / camera.scale;
    const worldY = (localY - camera.y) / camera.scale;
    const scale = Math.max(.28, Math.min(1.6, camera.scale * factor));
    updateCamera({ scale, x: localX - worldX * scale, y: localY - worldY * scale });
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
    setText(selectedNodeLabel, selected ? "Selected · " + selected.label : "Select a node to inspect provenance", "Select a node to inspect provenance");
    setText(selectedNodeEvidence, selected ? linked.length + " linked evidence item" + (linked.length === 1 ? "" : "s") : "Evidence stays visible in the drawer", "Evidence stays visible in the drawer");
    setText(selectedNodeStatus, selected ? "Status · " + selected.status : "Status · —", "Status · —");
    setText(selectedNodeOwner, selected ? "Owner · " + selected.agent : "Owner · —", "Owner · —");
    setText(selectedNodeRuntime, selected ? "Runtime · " + selected.runtime : "Runtime · —", "Runtime · —");
    setText(selectedNodeSummary, selected ? selected.summary : "Select a node to inspect its execution summary.", "Select a node to inspect its execution summary.");
    setText(selectedNodeEvidenceDetail, linked[0]?.detail || (selected ? "No evidence detail is linked to this node yet." : "Evidence details appear when a node is selected."), "Evidence details appear when a node is selected.");
    evidenceList?.querySelectorAll("[data-evidence-id]").forEach((entry) => {
      const associated = Boolean(selected && entry.dataset.nodeId === selected.id);
      entry.dataset.associated = associated ? "true" : "false";
    });
  }

  function selectNode(nodeId, { focus = false } = {}) {
    if (!currentSnapshot || !currentSnapshot.nodes.some((node) => node.id === nodeId)) return;
    selectedNodeId = nodeId;
    updateSelectedNodeVisuals();
    if (evidenceDrawer?.hidden) {
      evidenceDrawer.hidden = false;
      evidenceToggle?.setAttribute("aria-expanded", "true");
    }
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
    clearChildren(nodeList);
    clearChildren(edgeLayer);
    clearChildren(graphMinimapScene);
    if (!snapshot.nodes.length) {
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
      const markerColors = { running: "#55e6d0", completed: "#75e5aa", failed: "#ff7e92", "in-doubt": "#ff7e92", blocked: "#ffca73", queued: "#6d8dff" };
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
    snapshot.nodes.forEach((node) => {
      const card = makeElement("article", "node-card node-" + nodeClass(node.status));
      card.dataset.nodeId = node.id;
      card.dataset.status = node.status;
      card.dataset.replayStatus = node.status;
      card.dataset.selected = "false";
      card.setAttribute("role", "option");
      card.setAttribute("aria-selected", "false");
      card.setAttribute("aria-label", node.label + ", " + localize(node.status.replaceAll("_", " ")));
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
      const meta = makeElement("div", "node-meta");
      const agent = makeElement("span", "node-meta-item node-agent", node.agent);
      agent.title = localize("Agent");
      if (usefulNodeMeta(agent.textContent)) meta.append(agent);
      if (!meta.childElementCount) meta.hidden = true;
      card.append(top, heading, summary, meta);
      const parent = snapshot.edges.find((edge) => edge.to === node.id);
      if (parent) {
        const parentNode = snapshot.nodes.find((candidate) => candidate.id === parent.from);
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

    for (const edge of snapshot.edges) {
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

    for (const node of snapshot.nodes) {
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
      const marker = makeElement("span", "replay-event-marker", "");
      marker.setAttribute("aria-hidden", "true");
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
    });
    if (replayPrev) replayPrev.disabled = currentReplayIndex <= 0 || events.length < 2;
    if (replayNext) replayNext.disabled = currentReplayIndex >= max || events.length < 2;
    if (replayLive) {
      replayLive.disabled = events.length < 1;
      replayLive.dataset.active = replayFollowingLive ? "true" : "false";
    }
    nodeList?.querySelectorAll("[data-node-id]").forEach((element) => {
      const active = events[currentReplayIndex]?.nodeId && element.dataset.nodeId === events[currentReplayIndex].nodeId;
      element.dataset.replayActive = active ? "true" : "false";
      let replayState = element.dataset.status || "queued";
      for (const event of events.slice(0, currentReplayIndex + 1)) {
        if (event.nodeId === element.dataset.nodeId) replayState = event.status;
      }
      element.dataset.replayStatus = replayState;
    });
    if (events[currentReplayIndex]?.nodeId && currentSnapshot.nodes.some((node) => node.id === events[currentReplayIndex].nodeId)) {
      selectedNodeId = events[currentReplayIndex].nodeId;
      updateSelectedNodeVisuals();
    }
    for (const edge of currentSnapshot.edges) {
      const path = graphState.edgeElements.get(edge.id);
      if (!path) continue;
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
          + " · #" + session.runId.slice(-6),
      })),
      selectedRunId,
      project ? "No governed runs yet" : "Select a project first",
    );
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

  async function loadProjectCatalog({ refresh = false } = {}) {
    try {
      const response = await fetch(projectsEndpoint, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("project catalog request failed");
      const catalog = normalizeCatalog(await response.json());
      if (!catalog) throw new Error("project catalog unavailable");
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
    }
  }

  function showEmpty(message) {
    if (emptyState) emptyState.hidden = false;
    for (const element of [runHero, runFacts, workspace, replayPanel]) {
      if (element) element.hidden = true;
    }
    if (message) setText(app.querySelector("[data-live-empty-message]"), message, "Waiting for a run snapshot");
  }

  function hideEmpty() {
    if (emptyState) emptyState.hidden = true;
    for (const element of [runHero, runFacts, workspace, replayPanel]) {
      if (element) element.hidden = false;
    }
  }

  function renderSnapshot(input) {
    const selectedSession = projectForSelection()?.sessions.find((session) => session.runId === selectedRunId) || null;
    const inputRun = input?.run && typeof input.run === "object" && !Array.isArray(input.run) ? input.run : null;
    const genericTitle = ["", "Live execution", "Observed execution"].includes(display(inputRun?.title, ""));
    const selectedStageIndex = STAGE_ORDER.indexOf(display(selectedSession?.currentStage, "").toLowerCase());
    const readableNodes = selectedStageIndex >= 0 && Array.isArray(input?.nodes)
      ? input.nodes.map((node) => {
          const index = stageIndex(node && typeof node === "object" ? node : {});
          const status = display(node?.status || node?.state, "in_doubt").toLowerCase();
          if (index < 0 || !["in_doubt", "in doubt", "queued", "pending"].includes(status)) return node;
          return {
            ...node,
            status: index < selectedStageIndex
              ? "completed"
              : index === selectedStageIndex && selectedSession.active
                ? "running"
                : "queued",
          };
        })
      : input?.nodes;
    const enrichedInput = selectedSession && input && typeof input === "object" && !Array.isArray(input)
      ? {
          ...input,
          nodes: readableNodes,
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
    renderReplay(snapshot);
    renderControlPanel(snapshot);
    if (firstSnapshot) {
      if (window.requestAnimationFrame) window.requestAnimationFrame(fitGraph);
      else fitGraph();
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

  evidenceToggle?.addEventListener("click", () => {
    const next = evidenceDrawer?.hidden !== false;
    if (evidenceDrawer) evidenceDrawer.hidden = !next;
    evidenceToggle.setAttribute("aria-expanded", String(next));
  });
  app.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    selectedNodeId = null;
    updateSelectedNodeVisuals();
    if (evidenceDrawer) evidenceDrawer.hidden = true;
    evidenceToggle?.setAttribute("aria-expanded", "false");
    document.activeElement?.blur?.();
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
    const rect = graph.getBoundingClientRect();
    zoomGraph(event.deltaY < 0 ? 1.1 : .9, event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });
  window.addEventListener("resize", updateMinimap, { passive: true });

  applyLanguage();
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
    const startedFromCatalog = await loadProjectCatalog();
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

export function renderLiveControlRoomPage({
  snapshot = null,
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
  const controlConfigJson = safeJsonForHtml(safeControlConfig);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#070b16">
  <meta name="description" content="Meta_Kim Live 只读实时运行控制中心">
  <link rel="icon" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHZpZXdCb3g9JzAgMCAzMiAzMic+PHJlY3Qgd2lkdGg9JzMyJyBoZWlnaHQ9JzMyJyByeD0nOCcgZmlsbD0nIzA3MGIxNicvPjxwYXRoIGQ9J004IDIyVjEwaDRsNCA1IDQtNWg0djEyaC00di02bC00IDUtNC01djZ6JyBmaWxsPScjNmVlN2ZmJy8+PC9zdmc+">
  <title>Meta_Kim Live · 控制中心</title>
  <style>${PAGE_CSS}</style>
</head>
<body>
  <a class="skip-link" id="skip-to-content" href="#live-main" data-i18n-en="Skip to content" data-i18n-zh="跳到主要内容">跳到主要内容</a>
  <div class="ambient" aria-hidden="true"></div>
  <div id="live-app" class="shell" data-snapshot-endpoint="${escapeHtml(safeSnapshotEndpoint)}" data-events-endpoint="${escapeHtml(safeEventsEndpoint)}" data-projects-endpoint="${escapeHtml(safeProjectsEndpoint)}" data-replay-endpoint="${escapeHtml(safeReplayEndpoint)}" data-share-endpoint="${escapeHtml(safeShareEndpoint)}" data-control-endpoint="${escapeHtml(safeControlEndpoint)}">
    <header class="topbar" aria-label="Meta_Kim Live header">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">✦</span>
        <div><p class="eyebrow">Meta_Kim / Live</p><p class="brand-title" data-i18n-en="Control room" data-i18n-zh="控制中心">控制中心</p></div>
      </div>
      <div class="topbar-actions"><button class="language-toggle" type="button" data-live-language-toggle aria-label="Switch to English">EN</button><div class="connection" aria-live="polite"><span class="connection-dot" data-live-connection-dot aria-hidden="true"></span><span data-live-connection data-i18n-en="Connecting…" data-i18n-zh="正在连接…">正在连接…</span></div></div>
    </header>
    <section class="hub-switcher" aria-label="Meta_Kim project and session selection">
      <label class="hub-field" for="live-project-select"><span data-i18n-en="Project" data-i18n-zh="项目">项目</span><select class="hub-select" id="live-project-select" data-live-project-select aria-label="Choose a Meta_Kim project"><option value="">正在加载已登记项目…</option></select></label>
      <label class="hub-field" for="live-session-select"><span data-i18n-en="Session / run" data-i18n-zh="会话 / 运行">会话 / 运行</span><select class="hub-select" id="live-session-select" data-live-session-select aria-label="Choose a governed session" disabled><option value="">请先选择项目</option></select></label>
      <p class="hub-status" data-live-hub-status role="status" aria-live="polite">正在加载本地项目目录…</p>
    </section>
    <main class="main" id="live-main" tabindex="-1">
      <section class="run-hero" aria-labelledby="run-title">
        <div>
          <p class="kicker" data-i18n-en="What is happening now" data-i18n-zh="当前任务">当前任务</p>
          <h1 class="run-title" id="run-title" data-live-run-title>正在等待运行快照</h1>
          <p class="run-subtitle"><span class="run-stage-primary" data-live-run-stage>观测中</span><span data-live-source>本地观察器</span><span data-live-run-id>未识别运行</span></p>
        </div>
        <div class="state-chip" data-live-state data-state="stale"><span class="status-pulse" aria-hidden="true"></span><span data-live-state-label>未更新</span></div>
      </section>
      <dl class="run-facts" aria-label="Run facts">
        <div class="run-fact run-fact-primary"><dt data-i18n-en="Overall progress" data-i18n-zh="整体进度">整体进度</dt><dd data-live-run-progress>—</dd></div>
        <div class="run-fact"><dt data-i18n-en="Working now" data-i18n-zh="正在执行">正在执行</dt><dd data-live-run-workers>—</dd></div>
        <div class="run-fact"><dt data-i18n-en="Started" data-i18n-zh="开始时间">开始时间</dt><dd data-live-run-started>—</dd></div>
        <div class="run-fact"><dt data-i18n-en="Last update" data-i18n-zh="最近更新">最近更新</dt><dd data-live-run-updated>—</dd></div>
      </dl>
      <section class="stage-overview" aria-labelledby="stage-overview-title">
        <header class="stage-overview-header"><div><p class="kicker" data-i18n-en="Eight-stage path" data-i18n-zh="执行路径">执行路径</p><h2 id="stage-overview-title" data-i18n-en="Where this task is now" data-i18n-zh="这项任务现在走到哪一步">这项任务现在走到哪一步</h2></div><span data-i18n-en="Select a step to inspect it" data-i18n-zh="点击步骤查看详情">点击步骤查看详情</span></header>
        <ol class="stage-rail" data-live-stage-rail aria-label="Run progress"></ol>
      </section>
      <div class="sr-only" data-live-region aria-live="polite"></div>
      <section class="workspace-grid" aria-label="Live execution workspace">
        <section class="panel graph-panel" aria-labelledby="graph-title">
          <header class="panel-header"><div><h2 class="panel-title" id="graph-title" data-i18n-en="Execution graph" data-i18n-zh="实时运行图">实时运行图</h2><p class="panel-note" data-i18n-en="Main stages on top; live execution branches below." data-i18n-zh="上方是主流程，下方是正在执行的工作分支。">上方是主流程，下方是正在执行的工作分支。</p></div><div class="graph-header-actions"><button class="graph-tool-button" type="button" data-live-graph-layout aria-label="Toggle graph layout" data-i18n-en="Layout" data-i18n-zh="布局">布局</button><button class="graph-tool-button" type="button" data-live-graph-fit aria-label="Fit graph to viewport" data-i18n-en="Fit" data-i18n-zh="适应">适应</button><button class="graph-tool-button" type="button" data-live-graph-zoom-out aria-label="Zoom graph out">−</button><button class="graph-tool-button" type="button" data-live-graph-zoom-in aria-label="Zoom graph in">+</button></div></header>
          <div class="graph-stage" data-live-graph-viewport>
            <div class="graph-canvas" data-live-graph role="region" aria-label="Read-only execution graph" tabindex="0">
              <div class="graph-scene" data-live-graph-scene>
                <svg class="edge-layer" data-live-edge-layer aria-hidden="true" focusable="false"></svg>
                <div class="node-list" data-live-node-list role="listbox" aria-label="Execution nodes"></div>
              </div>
              <div class="graph-minimap" data-live-graph-minimap aria-label="Graph minimap" role="img"><div class="minimap-scene" data-live-minimap-scene></div><span class="minimap-viewport" data-live-minimap-viewport aria-hidden="true"></span></div>
            </div>
            <div class="graph-empty" data-live-graph-empty hidden><p data-i18n-en="No task nodes in this snapshot." data-i18n-zh="当前快照中没有任务节点。">当前快照中没有任务节点。</p></div>
          </div>
        </section>
        <aside class="panel evidence-panel" aria-labelledby="evidence-title">
          <header class="panel-header"><div><h2 class="panel-title" id="evidence-title" data-i18n-en="Evidence" data-i18n-zh="证据">证据</h2><p class="panel-note" data-i18n-en="What the observer can substantiate." data-i18n-zh="观察器能够证明的事实。">观察器能够证明的事实。</p></div><div class="replay-controls"><span class="panel-count" data-live-evidence-count>00</span><button class="drawer-toggle" type="button" data-evidence-toggle aria-controls="evidence-drawer" aria-expanded="true" aria-label="Toggle evidence drawer" data-i18n-en="Details" data-i18n-zh="详情">详情</button></div></header>
          <div class="selected-node-summary" data-live-selected-node aria-live="polite"><strong data-live-selected-node-label>选择节点查看来源与依据</strong><div class="selected-node-facts"><span data-live-selected-node-status>状态 · —</span><span data-live-selected-node-owner>负责人 · —</span><span data-live-selected-node-runtime>运行时 · —</span></div><p data-live-selected-node-summary>选择节点查看执行摘要。</p><p data-live-selected-node-evidence-detail>选择节点后将在这里显示证据详情。</p><span data-live-selected-node-evidence>证据会持续显示在抽屉中</span></div>
          <div class="evidence-drawer" id="evidence-drawer" data-evidence-drawer><div class="evidence-list" data-live-evidence-list role="list" aria-label="Observed evidence"></div></div>
        </aside>
      </section>
      <section class="panel replay-panel" aria-labelledby="replay-title">
          <header class="panel-header"><div><h2 class="panel-title" id="replay-title" data-i18n-en="Replay timeline" data-i18n-zh="回放时间线">回放时间线</h2><p class="panel-note" data-replay-status>正在等待回放数据</p></div><div class="replay-controls"><button class="replay-button" type="button" data-replay-prev aria-label="Previous replay event" data-i18n-en="Prev" data-i18n-zh="上一个">上一个</button><button class="replay-button" type="button" data-replay-play aria-label="Play replay"><span aria-hidden="true">▶</span><span data-replay-play-label>播放</span></button><button class="replay-button" type="button" data-replay-next aria-label="Next replay event" data-i18n-en="Next" data-i18n-zh="下一个">下一个</button><button class="replay-button" type="button" data-replay-live aria-label="Go to live replay position" data-i18n-en="Live" data-i18n-zh="实时">实时</button><button class="replay-button" type="button" data-replay-reset aria-label="Reset replay" data-i18n-en="Reset" data-i18n-zh="重置">重置</button></div></header>
        <div class="replay-range-wrap"><label class="sr-only" for="replay-range" data-i18n-en="Replay position" data-i18n-zh="回放位置">回放位置</label><input class="replay-range" id="replay-range" data-replay-range type="range" min="0" max="0" value="0" step="1" aria-label="Replay position" disabled><div class="replay-track" data-replay-track aria-hidden="true"><span class="replay-progress" data-replay-progress></span></div></div>
        <ol class="replay-events" data-replay-events data-replay-timeline aria-label="Replay events"></ol>
      </section>
      <section class="panel share-panel" aria-labelledby="share-title">
        <header class="panel-header"><div><h2 class="panel-title" id="share-title" data-i18n-en="Share locally" data-i18n-zh="本地分享">本地分享</h2><p class="panel-note" data-i18n-en="No upload, no external assets, no mutation." data-i18n-zh="不上传、不加载外部资源、不修改运行。">不上传、不加载外部资源、不修改运行。</p></div><span class="panel-count" data-i18n-en="LOCAL ONLY" data-i18n-zh="仅限本地">仅限本地</span></header>
        <div class="share-content"><div class="share-actions"><button class="replay-button share-button" type="button" data-live-share-export-json data-i18n-en="Export JSON" data-i18n-zh="导出 JSON">导出 JSON</button><button class="replay-button share-button" type="button" data-live-share-copy-pr data-i18n-en="Copy PR card" data-i18n-zh="复制 PR 卡片">复制 PR 卡片</button><button class="replay-button share-button" type="button" data-live-share-copy-readme data-i18n-en="README embed" data-i18n-zh="README 嵌入">README 嵌入</button></div><p class="share-status" id="meta-kim-live-share-status" data-live-share-status role="status" aria-live="polite" data-i18n-en="Share actions stay local and require the local /api/share endpoint." data-i18n-zh="分享操作仅在本地进行，并使用本地 /api/share 接口。">分享操作仅在本地进行，并使用本地 /api/share 接口。</p></div>
      </section>
      <section class="panel control-panel" data-live-control-panel aria-labelledby="control-title" aria-busy="false"${safeControlConfig ? "" : " hidden"}>
        <header class="panel-header"><div><h2 class="panel-title" id="control-title" data-i18n-en="Continuation controls" data-i18n-zh="继续执行控制">继续执行控制</h2><p class="panel-note" data-i18n-en="Opt-in commands require explicit local capabilities and durable verification." data-i18n-zh="可选控制命令需要明确的本地能力与耐久验证。">可选控制命令需要明确的本地能力与耐久验证。</p></div><span class="panel-count" data-i18n-en="AUTHORITY-BOUND" data-i18n-zh="受权限约束">受权限约束</span></header>
        <div class="control-content"><div class="control-actions" data-live-control-actions>${safeControlConfig ? LIVE_CONTROL_ACTIONS.map((action) => `<button class="replay-button control-button" type="button" data-live-control-action="${action}" aria-label="${action[0].toUpperCase() + action.slice(1)} run">${action[0].toUpperCase() + action.slice(1)}</button>`).join("") : ""}</div><p class="control-status" data-live-control-status role="status" aria-live="polite" data-i18n-en="Controls are read-only until the local service declares every action available." data-i18n-zh="在本地服务明确声明所有操作可用前，控制功能保持只读。">在本地服务明确声明所有操作可用前，控制功能保持只读。</p><p class="control-result" data-live-control-result role="status" aria-live="polite"></p><p class="control-error" data-live-control-error role="alert" aria-live="assertive"></p></div>
      </section>
      <section class="empty-state" data-live-empty hidden aria-labelledby="empty-title"><span class="empty-glyph" aria-hidden="true">◌</span><h2 class="empty-title" id="empty-title" data-i18n-en="No live snapshot yet" data-i18n-zh="尚无实时快照">尚无实时快照</h2><p class="empty-copy" data-live-empty-message>正在等待本地观察器发布 Frozen v1 快照。</p></section>
    </main>
    <footer class="footer"><span><span data-i18n-en="Local observer" data-i18n-zh="本地观察器">本地观察器</span> · <span data-live-last-update>最近观测 —</span></span><span data-i18n-en="Read-only surface · no run mutations" data-i18n-zh="只读界面 · 不修改运行">只读界面 · 不修改运行</span></footer>
  </div>
  <script type="application/json" id="live-initial-snapshot">${initialJson}</script>
  <script type="application/json" id="live-control-config">${controlConfigJson}</script>
  <script>${CLIENT_SCRIPT}</script>
</body>
</html>`;
}

export const buildLiveControlRoomPage = renderLiveControlRoomPage;
export const renderLivePage = renderLiveControlRoomPage;
