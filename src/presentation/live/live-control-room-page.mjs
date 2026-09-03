/**
 * Dependency-free presentation for the Meta_Kim Live control room.
 *
 * The page is deliberately a shell: the browser reads the bounded live snapshot
 * from the local API and listens for refresh hints over SSE. Snapshot values
 * are only ever placed into DOM text nodes by the client script. This keeps a
 * compromised or malformed observer payload from becoming executable markup.
 */

import { LIVE_GRAPH_AVAILABILITY_REASONS } from "../../application/live/live-control-room-service.mjs";
import {
  serializeConversationDiscoveryCopyForClient,
  serializeConversationLinkRefusalCopyForClient,
} from "../../application/live/live-conversation-link-vocabulary.mjs";
import {
  loadLiveDefaultSelectionPolicy,
  serializeDefaultSelectionPolicyForClient,
  serializeDefaultSelectionResolvers,
} from "../../application/live/live-default-selection.mjs";
import {
  loadLiveDisplayFormat,
  serializeIdentifierShortener,
  serializeNodeTaskLineResolver,
} from "../../application/live/live-display-format.mjs";
import {
  loadLiveGraphCameraPolicy,
  serializeCameraLegibilityCustomProperties,
  serializeGraphCameraPolicyForClient,
  serializeOverviewCameraResolver,
  serializeSemanticZoomResolver,
} from "../../application/live/live-graph-camera.mjs";
import {
  LIVE_DEFAULT_RECORD_ORIGIN,
  LIVE_RECORD_ORIGINS,
} from "../../application/live/live-record-origin.mjs";
import { serializeReplayNodeViewResolver } from "../../application/live/live-replay-visibility.mjs";
import {
  loadLiveSpacingScale,
  serializeSpacingCustomProperties,
} from "../../application/live/live-spacing-scale.mjs";
import {
  loadLiveStreamPolicy,
  serializeLiveStreamPolicyForClient,
} from "../../application/live/live-stream-policy.mjs";
import {
  loadLiveTypographyScale,
  serializeTypographyCustomProperties,
} from "../../application/live/live-typography-scale.mjs";
import {
  loadLiveChromeBudget,
  loadLiveDockBudget,
  loadLiveReplayTickBand,
  serializeChromeBudgetCustomProperties,
  serializeDockBudgetCustomProperties,
  serializeReplayTickBandForClient,
  serializeReplayTickCountResolver,
  serializeReplayTickOffsetsResolver,
  serializeViewportBudgetForClient,
} from "../../application/live/live-viewport-budget.mjs";

export const LIVE_SNAPSHOT_SCHEMA_VERSION = "meta-kim-live-snapshot-v2";

const REPLAY_NODE_VIEW_SOURCE = serializeReplayNodeViewResolver();
const IDENTIFIER_SHORTENER_SOURCE = serializeIdentifierShortener();
const NODE_TASK_LINE_SOURCE = serializeNodeTaskLineResolver();

/**
 * The display-format policy is resolved once at module load: it is inlined into
 * the client bundle as a literal, and the pre-hydration HTML shell renders the
 * same placeholder glyph so the first paint cannot disagree with the first
 * client render.
 */
const PAGE_DISPLAY_FORMAT = loadLiveDisplayFormat();
const DISPLAY_FORMAT_LITERAL = JSON.stringify(PAGE_DISPLAY_FORMAT);
const EMPTY_PLACEHOLDER = PAGE_DISPLAY_FORMAT.emptyPlaceholder;

/**
 * Copy for every reason the snapshot service can give for an empty graph. The
 * keys come from the service's own vocabulary rather than from string literals
 * repeated here, so renaming a reason cannot leave the page printing a generic
 * sentence for a cause the server took the trouble to distinguish.
 */
const GRAPH_EMPTY_REASON_COPY = Object.freeze({
  [LIVE_GRAPH_AVAILABILITY_REASONS.noReadableRunRecord]:
    "No run record could be read for this session.",
  [LIVE_GRAPH_AVAILABILITY_REASONS.noGovernedArtifactForRun]:
    "This session only recorded its activation. No governed run artifact was written, so there is nothing to draw.",
  [LIVE_GRAPH_AVAILABILITY_REASONS.artifactDeclaredNoNodes]:
    "This run wrote a governed artifact, and that artifact declares no task nodes.",
});
const GRAPH_EMPTY_REASON_LITERAL = JSON.stringify(GRAPH_EMPTY_REASON_COPY);

/**
 * Why a run has no chat link, in the reader's terms.
 *
 * The generic sentence is honest but unactionable: every unlinked run reads the
 * same whether the runtime never reported a chat id or the transcript was
 * deleted afterwards. The reasons come from the shared vocabulary rather than
 * literals repeated here, so a reason the hook can write cannot silently lose
 * its sentence.
 */
const CONVERSATION_REFUSAL_LITERAL = JSON.stringify(serializeConversationLinkRefusalCopyForClient());

/**
 * How far the chat lookup got, for the runs that carry no refusal at all.
 *
 * Only a run that attempted a binding records a refusal, so every record written
 * before that hook falls straight through to the generic sentence. The catalog
 * still reports whether the run ever named a tool, which separates "there was
 * nowhere to look" from "only what the run saved was read" — the reader's next
 * step differs, and one sentence for both hid that.
 */
const CONVERSATION_DISCOVERY_LITERAL = JSON.stringify(serializeConversationDiscoveryCopyForClient());

/**
 * What a row says about where its record came from.
 *
 * A real governed run carries no badge, because badging everything makes the
 * badge stop meaning anything. Every other origin has to say so on the row: a
 * fixture projection reaches the browser through the same catalog as a real run
 * and is shaped the same way, and a fixture always carries the worker counts and
 * resolved runtime a real activation often lacks, so an unlabelled fixture reads
 * as the healthiest row in the panel.
 *
 * The keys come from the shared vocabulary rather than from literals repeated
 * here, and a newly declared origin with no copy fails the render instead of
 * shipping an unmarked row that asserts the record is real.
 */
const RECORD_ORIGIN_COPY = Object.freeze({
  governed_run: "",
  acceptance_fixture: "Acceptance fixture, not a real run",
  demo: "Demo data, not a real run",
});
const RECORD_ORIGIN_LITERAL = JSON.stringify(
  Object.fromEntries(LIVE_RECORD_ORIGINS.map((origin) => {
    if (typeof RECORD_ORIGIN_COPY[origin] !== "string") {
      const error = new TypeError(`Live control room page: record origin ${origin} has no visible copy`);
      error.code = "LIVE_PAGE_RECORD_ORIGIN_COPY_MISSING";
      throw error;
    }
    return [origin, RECORD_ORIGIN_COPY[origin]];
  })),
);

/**
 * Every text size in the stylesheet is derived from this ladder. Emitting it
 * into the same `:root` block that carries the colour tokens keeps one place
 * where a reader can see the whole design contract, and keeps the size tokens
 * from being defined after a rule that already consumed them.
 */
const TYPOGRAPHY_TOKENS = serializeTypographyCustomProperties(loadLiveTypographyScale());

/**
 * Distances the stylesheet is allowed to use, as custom properties. Sizing text
 * and spacing boxes are separate axes with separate failure modes - a readable
 * size crammed against its container edge still reads as painful - so the
 * ladders stay separate documents rather than one table of "design tokens".
 */
const SPACING_TOKENS = serializeSpacingCustomProperties(loadLiveSpacingScale());

/**
 * Band heights the stylesheet shares with the vertical budget, as custom
 * properties. Writing them as literals gave one quantity two authorities, and
 * the literal for the replay row was the drawer's open height charged to the
 * canvas while the drawer sat collapsed.
 */
const PAGE_CHROME_BUDGET = loadLiveChromeBudget();
const CHROME_BUDGET_TOKENS = serializeChromeBudgetCustomProperties(PAGE_CHROME_BUDGET);

/**
 * The width of the collapsed replay summary. The open dock header derives its
 * left inset from this token, because the inset exists only to clear the
 * absolutely positioned summary — as two literals they drifted apart and
 * overlapped the header's first control.
 */
const DOCK_BUDGET_TOKENS = serializeDockBudgetCustomProperties(loadLiveDockBudget());

/**
 * The eight-stage rail costs 66px of canvas height while expanded. Shipping it
 * expanded is a height decision taken without knowing the viewport, and at
 * 1024x768 it left the canvas at 337px against a declared 360px floor — the run's
 * shape rendered off-screen in the default view. The rail therefore ships
 * collapsed and the client expands it only above this measured threshold.
 */
const VIEWPORT_BUDGET_LITERAL = JSON.stringify(serializeViewportBudgetForClient(PAGE_CHROME_BUDGET));

/**
 * Camera bounds and the two resolvers that consume them. The resolvers are
 * inlined by their own source rather than reimplemented here, so the fit
 * arithmetic the tests exercise is byte-for-byte the arithmetic the browser
 * runs.
 *
 * The policy is read once and shared by the client literal and the stylesheet
 * tokens. Two reads would let the CSS the reader sees drift from the bounds the
 * client enforces, and the divisor in the cell rules is the same number as the
 * floor the client clamps to.
 */
const PAGE_GRAPH_CAMERA = loadLiveGraphCameraPolicy();
const GRAPH_CAMERA_LITERAL = JSON.stringify(serializeGraphCameraPolicyForClient(PAGE_GRAPH_CAMERA));
const CAMERA_LEGIBILITY_TOKENS = serializeCameraLegibilityCustomProperties(PAGE_GRAPH_CAMERA);
const OVERVIEW_CAMERA_SOURCE = serializeOverviewCameraResolver();
const SEMANTIC_ZOOM_SOURCE = serializeSemanticZoomResolver();

/**
 * Which run the page opens on when the URL names none.
 *
 * The client had its own fallback chain — first live project, then first
 * session — and that chain is what put an activation receipt on screen instead
 * of a graph. It now shares the hub's ordering by inlining the same functions,
 * because a second copy of the rule in this file would be free to disagree with
 * the copy the hub serves and the tests exercise.
 */
const DEFAULT_SELECTION_LITERAL = JSON.stringify(
  serializeDefaultSelectionPolicyForClient(loadLiveDefaultSelectionPolicy()),
);
const DEFAULT_SELECTION_SOURCE = serializeDefaultSelectionResolvers();

/**
 * The two network waits. The snapshot fetch was unbounded and the event stream
 * lived as long as its tab, so a handful of open tabs consumed the origin's
 * connection allowance and the next page's fetch was queued instead of refused:
 * no error, no repaint, "Loading the selected run..." forever.
 */
const STREAM_POLICY_LITERAL = JSON.stringify(serializeLiveStreamPolicyForClient(loadLiveStreamPolicy()));

/**
 * The replay axis used to ship nine labels written into the markup, reading
 * `00:00` through `02:00` no matter how long the run took, and the ninth was
 * clipped at 1024x768. Both the count and the values are now resolved at render
 * time: the count from the width the band actually has, the values from the
 * run's own first and last replay timestamps.
 */
const PAGE_REPLAY_TICK_BAND = loadLiveReplayTickBand();
const REPLAY_TICK_BAND_LITERAL = JSON.stringify(serializeReplayTickBandForClient(PAGE_REPLAY_TICK_BAND));
const REPLAY_TICK_COUNT_SOURCE = serializeReplayTickCountResolver();
const REPLAY_TICK_OFFSETS_SOURCE = serializeReplayTickOffsetsResolver();

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

  const resolveReplayNodeView = ${REPLAY_NODE_VIEW_SOURCE};

  const DISPLAY_FORMAT = ${DISPLAY_FORMAT_LITERAL};
  const GRAPH_EMPTY_REASON_TEXT = ${GRAPH_EMPTY_REASON_LITERAL};
  const CONVERSATION_REFUSAL_TEXT = ${CONVERSATION_REFUSAL_LITERAL};
  const CONVERSATION_DISCOVERY_TEXT = ${CONVERSATION_DISCOVERY_LITERAL};
  const RECORD_ORIGIN_TEXT = ${RECORD_ORIGIN_LITERAL};
  const shortenIdentifier = ${IDENTIFIER_SHORTENER_SOURCE};
  const resolveNodeTaskLine = ${NODE_TASK_LINE_SOURCE};

  const GRAPH_CAMERA = ${GRAPH_CAMERA_LITERAL};
  const resolveOverviewCamera = ${OVERVIEW_CAMERA_SOURCE};
  const resolveSemanticZoom = ${SEMANTIC_ZOOM_SOURCE};

  const DEFAULT_SELECTION = ${DEFAULT_SELECTION_LITERAL};
  ${DEFAULT_SELECTION_SOURCE}

  const REPLAY_TICK_BAND = ${REPLAY_TICK_BAND_LITERAL};
  const resolveReplayTickCount = ${REPLAY_TICK_COUNT_SOURCE};
  const resolveReplayTickOffsetsMs = ${REPLAY_TICK_OFFSETS_SOURCE};

  const STREAM_POLICY = ${STREAM_POLICY_LITERAL};

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
  const WORK_VIEW_STORAGE_KEY = "meta-kim-live-work-view-v3";
  const WORK_VIEWS = ["repository", "workspace", "run"];
  const INSPECTOR_TABS = ["summary", "evidence", "terminal", "context"];
  const GRAPH_TOOLS_STORAGE_KEY = "meta-kim-live-graph-tools-position-v1";
  const GRAPH_TOOLS_KEYBOARD_STEP = 12;
  const GRAPH_TOOLS_EDGE_MARGIN = 8;
  const GRAPH_TOOLS_DRAG_THRESHOLD = 3;
  const zhText = new Map(Object.entries({
    "Started": "开始于",
    "File time": "文件时间",
    "This record reports no time of its own; the value shown is when its file was last written.": "这条记录本身没有报告时间，显示的是记录文件最后一次写入的时间。",
    "Time reported by the record": "记录报告的时间",
    "The record does not say where this time came from.": "记录没有说明这个时间的来源。",
    "The tool that started this run did not identify itself": "没认出这次运行是哪个工具发起的",
    "No chat id came through when this run started": "这次运行启动时没拿到聊天编号",
    "The tool did not say where the chat transcript is": "工具没说聊天记录存在哪里",
    "The chat transcript path was not a full path": "聊天记录的路径不是完整路径",
    "The transcript on record belongs to a different chat": "记录里的聊天记录属于另一个会话",
    "The chat transcript file is no longer on disk": "聊天记录文件已经不在磁盘上了",
    "The chat transcript file was empty": "聊天记录文件是空的",
    "No tool was recorded for this run, so there is no chat to look up": "没记下是哪个工具跑的，无从查起",
    "Only the run record was checked, not the tool chat history": "只查了运行记录，没查工具里的聊天",
    "Connecting…": "正在连接…",
    "Streaming": "实时连接中",
    "Reconnecting": "正在重新连接",
    "Polling snapshot": "正在轮询运行快照",
    "Paused while hidden": "标签页隐藏，已暂停连接",
    "Catching up after pause": "正在补齐暂停期间的进度",
    "The snapshot request timed out. Other open control room tabs hold this origin's connections. Close one, or wait for them to release.": "快照请求超时。其他已打开的控制室标签页占用了本源的连接，关掉一个，或等它们释放。",
    "Snapshot loaded": "已载入快照",
    "Snapshot unavailable": "运行快照不可用",
    "State demo": "状态演示",
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
    "Chat id copied locally.": "聊天标识已复制到本地剪贴板。",
    "Chat id copy unavailable; the clipboard was not ready.": "无法复制聊天标识：剪贴板未就绪。",
    "Copy the full chat id": "复制完整聊天标识",
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
    "No observation recorded yet": "尚未记录观测",
    "No governed run has been observed in this project yet.": "这个项目中尚未观测到治理运行。",
    "The local observer is not serving a snapshot yet.": "本地观察器尚未提供运行快照。",
    "The embedded snapshot could not be read.": "无法读取页面内嵌的运行快照。",
    "Select a node to inspect provenance": "选择节点查看来源与依据",
    "Evidence stays visible in the drawer": "证据会持续显示在抽屉中",
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
    "Move graph controls: drag, or arrow keys to nudge, Enter to dock": "移动图控件：拖动，或用方向键微调，回车归位",
    "Drag to move · arrow keys to nudge · Enter to dock": "拖动移动 · 方向键微调 · 回车归位",
    "Graph camera controls": "运行图相机控件",
    "Overview (O)": "总览（O）",
    "Follow (F)": "跟随（F）",
    "Relayout (R)": "重排（R）",
    "Relayout graph": "重排运行图",
    "Follow live execution": "跟随实时执行",
    "Reset graph camera": "重置运行图相机",
    "Zoom out": "缩小",
    "Zoom in": "放大",
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
    ,"Overview · partial": "总览 · 局部"
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
    ,"No worker report": "未收到执行者回报"
    ,"No event report": "未收到事件回报"
    ,"Stage unconfirmed": "阶段未确认"
    ,"Observed run": "已观测运行"
    ,"Background run records": "次要运行记录"
    ,"Acceptance fixture, not a real run": "验收样例数据，不是真实运行"
    ,"Demo data, not a real run": "演示数据，不是真实运行"
    ,"Activation only, or no chat link": "只登记了启动，或没有聊天关联"
    ,"No task nodes in this snapshot.": "当前快照中没有任务节点。"
    ,"This run registered stages but never reported execution nodes.": "这次运行登记了阶段，但没有回报执行节点。"
    ,"Nodes were dropped to stay inside the snapshot budget.": "为控制快照体积，部分节点未被下发。"
    ,"No run record could be read for this session.": "这个会话读不到运行记录。"
    ,"This session only recorded its activation. No governed run artifact was written, so there is nothing to draw.": "这个会话只登记了启动，没有写出受治理的运行产物，所以没有可画的内容。"
    ,"This run wrote a governed artifact, and that artifact declares no task nodes.": "这次运行写出了受治理的产物，产物里没有声明任务节点。"
  }));
  let currentLanguage = initialLanguage();

  /**
   * A stored value is the reader's own answer and outranks everything else, but
   * only when it names a language this page renders — any other string is not a
   * choice the toggle ever wrote. With nothing stored, the browser has already
   * stated a preference, and defaulting to Chinese regardless made an English
   * visitor hunt for the toggle to repeat what the browser had said. Locale tags
   * arrive region-coded ("zh-Hans-CN", "en-GB"), so the primary subtag decides.
   * A browser that states no locale at all falls to the shipped default.
   */
  function initialLanguage() {
    const PAGE_LANGUAGES = ["zh", "en"];
    const DEFAULT_LANGUAGE = PAGE_LANGUAGES[0];
    let stored = null;
    try { stored = window.localStorage?.getItem(LANGUAGE_STORAGE_KEY); }
    catch { stored = null; }
    if (PAGE_LANGUAGES.includes(stored)) return stored;
    const offered = window.navigator?.languages?.length
      ? window.navigator.languages
      : [window.navigator?.language];
    const stated = offered.map((tag) => String(tag || "").trim().toLowerCase()).filter(Boolean);
    if (!stated.length) return DEFAULT_LANGUAGE;
    return stated[0].split("-")[0] === "zh" ? "zh" : "en";
  }

  function localize(value) {
    const text = display(value);
    if (currentLanguage === "en" || !text) return text;
    const direct = zhText.get(text);
    if (direct) return direct;
    let match = text.match(/^Run ([A-Z0-9-]+)$/u);
    if (match) return "任务 " + match[1];
    match = text.match(/^(.*) · (\d+) of (\d+) runs$/u);
    if (match) return match[1] + " · 共 " + match[3] + " 次运行（可打开 " + match[2] + " 条）";
    match = text.match(/^\+ (\d+) runs without an openable record$/u);
    if (match) return "另有 " + match[1] + " 条没有可打开的记录";
    match = text.match(/^(.*) · (\d+) runs$/u);
    if (match) return match[1] + " · " + match[2] + " 次运行";
    match = text.match(/^(.*) · no runs$/u);
    if (match) return match[1] + " · 暂无运行";
    match = text.match(/^(.*) · (\d+) observed run records$/u);
    if (match) return match[1] + " · 已观测 " + match[2] + " 条运行记录";
    match = text.match(/^(\d+) of (\d+) steps complete$/u);
    if (match) return "已完成 " + match[1] + " / " + match[2] + " 个步骤";
    match = text.match(/^(\d+) active workers?$/u);
    if (match) return match[1] + " 个执行者正在工作";
    match = text.match(/^(\d+) workers?$/u);
    if (match) return match[1] + " 个执行者";
    match = text.match(/^(\d+) events?$/u);
    if (match) return match[1] + " 条事件";
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
    if (text.startsWith("Run ID · ")) return "运行 ID · " + text.slice(9);
    if (text.startsWith("Status · ")) return "状态 · " + localize(text.slice(9));
    if (text.startsWith("Owner · ")) return "负责人 · " + text.slice(8);
    if (text.startsWith("Runtime · ")) return "运行时 · " + text.slice(10);
    if (text.startsWith("Model · ")) return "模型 · " + text.slice(8);
    if (text.startsWith("Duration · ")) return "耗时 · " + text.slice(11);
    if (text.startsWith("Tools · ")) return "工具 · " + text.slice(8);
    if (text.startsWith("Tokens · ")) return "输出 · " + text.slice(9);
    if (text.startsWith("Loadout · ")) return "能力装载 · " + localize(text.slice(10));
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
    // A control whose affordance is an icon carries its instruction in aria and
    // title only, so leaving titles English-only would hide that instruction
    // from a Chinese reader entirely. Unmapped text passes through unchanged.
    document.querySelectorAll("[title]").forEach((element) => {
      if (!element.dataset.i18nTitleEn) element.dataset.i18nTitleEn = element.getAttribute("title") || "";
      element.setAttribute("title", currentLanguage === "zh" ? localize(element.dataset.i18nTitleEn) : element.dataset.i18nTitleEn);
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
  const sessionSearch = app.querySelector("[data-live-session-search]");
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
  const workspaceSessionList = app.querySelector("[data-live-workspace-session-list]");
  const workspaceBoard = app.querySelector("[data-live-workspace-board]");
  const workspaceDetail = app.querySelector("[data-live-workspace-detail]");
  const workspaceOpenSessions = app.querySelector("[data-live-workspace-open-sessions]");
  const workspaceOpenRunMap = app.querySelector("[data-live-workspace-open-run-map]");
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
  const graphStage = app.querySelector("[data-live-graph-viewport]");
  const graphTools = app.querySelector("[data-live-graph-tools]");
  const graphToolsHandle = app.querySelector("[data-live-graph-tools-handle]");
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
  const replayTicks = app.querySelector("[data-replay-ticks]");
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
  const contextChat = app.querySelector("[data-live-context-chat]");
  const contextChatCopy = app.querySelector("[data-live-context-chat-copy]");

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
  // True from the moment a page that lost its stream becomes visible again until
  // the replacement snapshot paints or the refetch fails. The graph on screen for
  // that stretch is whatever it showed when the person looked away, and the
  // stream reports itself open before its replacement arrives, so this is what
  // keeps the connection badge from claiming live over pre-pause numbers.
  let catchingUpAfterPause = false;
  let unloading = false;
  let controlBusy = false;
  let initialControlConfig = null;
  let selectedNodeId = null;
  let replayFollowingLive = true;
  // The events the axis was last drawn from, so a resize can recount labels
  // against the new band width without waiting for the next snapshot.
  let replayTickEvents = [];
  let layoutMode = "compact";
  // Start in a full-graph overview so the run topology is legible before the
  // user opts into following a replay target.
  let graphFollowing = false;
  let cameraMode = "overview";
  let graphState = {
    positions: new Map(),
    nodeElements: new Map(),
    edgeElements: new Map(),
    edgeEffects: new Map(),
    bounds: { width: 1, height: 1 },
  };
  let camera = { x: 0, y: 0, scale: 1 };
  let pointerPan = null;
  let graphToolsPosition = null;
  let graphToolsDrag = null;
  let graphToolsClickEndsDrag = false;
  let projectCatalog = [];
  let selectedProjectId = "";
  let selectedRunId = "";
  let sessionSearchQuery = "";
  let showUnlinkedSessions = false;
  let catalogAvailable = false;
  let catalogRequestInFlight = false;
  let catalogRefreshTimer = null;
  let selectionGeneration = 0;
  let dialogOpener = null;
  let activeDialog = null;
  const modalBackgroundState = new Map();
  let currentWorkView = "run";
  let currentInspectorTab = "summary";
  const demoMode = new URL(window.location.href).searchParams.get("demo") === "states" ? "states" : "";

  const statuses = new Set(["live", "stale", "in_doubt"]);
  const nodeStatuses = new Set(["running", "completed", "skipped", "failed", "blocked", "in_doubt", "queued"]);
  const EXECUTION_EDGE_KINDS = new Set(["sequence", "depends_on", "dependency", "fork", "join", "blocks", "execution", "invokes"]);
  const STRUCTURAL_EDGE_KINDS = new Set(["contains"]);
  const controlActions = ["pause", "resume", "reassign", "handoff"];
  const SNAPSHOT_COALESCE_MS = 75;
  const FOCUSABLE_DIALOG_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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

  /**
   * Render a snapshot value as text. The fallback argument is honoured verbatim,
   * including an empty string: a caller that asks for "nothing when absent"
   * must not get
   * the placeholder glyph back. Substituting the placeholder for every absent
   * value is what put stray dashes inside structural spans, let "—" flow into
   * URL parameters and Date parsing, and forced downstream guards to filter the
   * placeholder string back out in order to recognise a real value.
   */
  function display(value, fallback) {
    const placeholder = fallback === undefined ? DISPLAY_FORMAT.emptyPlaceholder : fallback;
    if (value === null || value === undefined || value === "") return placeholder;
    const text = String(value).normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
    return text.slice(0, 240) || placeholder;
  }

  function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function nullableCount(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  /**
   * Absent and zero are different observations. Collapsing a missing count into 0
   * made "we never received a worker report" read as "this run had no workers",
   * which is the one claim the page must not invent.
   */
  function nullableCountOf(record, keys) {
    const raw = firstValue(record, keys, null);
    return raw === null ? null : nullableCount(Number(raw));
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

  function normalizedRunDisplayState(runInput, fallback) {
    const state = display(firstValue(runInput, ["displayState", "publicState"], fallback), "unknown")
      .toLowerCase().replace(/[\s-]+/gu, "_");
    if (state === "unknown" && runInput?.active !== true) return "unreported";
    return state;
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

  function capabilityNames(value) {
    return Array.isArray(value)
      ? [...new Set(value.slice(0, 24).map((item) => display(item, "")).filter(Boolean))]
      : [];
  }

  const NODE_CAPABILITY_KINDS = ["agent", "skill", "mcp", "command", "runtime_tool", "hook", "plugin", "memory_graph", "dependency"];

  function normalizeNodeCapabilityTruth(item, loadout) {
    const rawInput = item?.capabilityTruth;
    const input = Array.isArray(rawInput)
      ? rawInput
      : rawInput && typeof rawInput === "object"
        ? Object.entries(rawInput).map(([kind, record]) => ({ kind, ...(record && typeof record === "object" ? record : {}) }))
        : [];
    const agentName = display(firstValue(item, ["agent", "ownerAgent", "owner"], ""), "");
    const plannedDefaults = {
      agent: usefulNodeMeta(agentName) ? [agentName] : [],
      skill: loadout.skillNames,
      mcp: loadout.mcpNames,
      command: loadout.commandNames,
      runtime_tool: loadout.toolNames,
      hook: loadout.hookNames,
      plugin: loadout.pluginNames,
      memory_graph: loadout.memoryGraphNames,
      dependency: loadout.dependencyNames,
    };
    return NODE_CAPABILITY_KINDS.flatMap((kind) => {
      const record = input.find((candidate) => candidate?.kind === kind) || {};
      const explicitPlannedNames = capabilityNames(record.plannedNames);
      const plannedNames = explicitPlannedNames.length ? explicitPlannedNames : capabilityNames(plannedDefaults[kind]);
      const actualNames = record.state === "observed" && record.observation === "trusted_host_evidence"
        ? capabilityNames(record.actualNames)
        : [];
      const downgradedNames = actualNames.length
        ? plannedNames
        : capabilityNames([...plannedNames, ...capabilityNames(record.actualNames)]);
      if (!downgradedNames.length && !actualNames.length) return [];
      return [{
        kind,
        state: actualNames.length ? "observed" : downgradedNames.length ? "planned" : "unavailable",
        plannedNames: downgradedNames,
        actualNames,
      }];
    });
  }

  /**
   * Re-normalize the scheduling block the observer sent.
   *
   * The page never infers wave order. It only renders what the projection
   * already resolved, and it pins the provenance label to "planned" locally too:
   * a wave list is a declared order, so no payload may talk the page into
   * presenting it as observed execution.
   */
  function normalizeScheduling(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const capacityInput = input.capacity && typeof input.capacity === "object" && !Array.isArray(input.capacity) ? input.capacity : {};
    const waves = (Array.isArray(input.waves) ? input.waves : []).slice(0, 32).map((item, index) => {
      const wave = item && typeof item === "object" && !Array.isArray(item) ? item : {};
      const nodeIds = (Array.isArray(wave.nodeIds) ? wave.nodeIds : []).slice(0, 32)
        .map((value) => display(value, ""))
        .filter(Boolean);
      return {
        waveId: display(wave.waveId, "wave-" + (index + 1)),
        waveIndex: Math.max(1, numberOr(wave.waveIndex, index + 1)),
        mode: display(wave.mode, "unspecified_wave"),
        declaredParallelCount: nullableCount(wave.declaredParallelCount),
        nodeIds,
        mappedCount: nodeIds.length,
        unmappedCount: Math.max(0, numberOr(wave.unmappedCount, 0)),
        mergeOwner: display(wave.mergeOwner, ""),
      };
    });
    if (!waves.length && !Number.isFinite(nullableCount(capacityInput.maxParallelAgents))) return null;
    return {
      provenance: "planned",
      capacity: {
        maxParallelAgents: nullableCount(capacityInput.maxParallelAgents),
        requestedParallelAgents: nullableCount(capacityInput.requestedParallelAgents),
        runtimeCapacity: nullableCount(capacityInput.runtimeCapacity),
        capacitySourceKind: display(capacityInput.capacitySourceKind, "unspecified"),
        throttled: capacityInput.throttled === true,
      },
      waves,
      waveCount: waves.length,
      declaredWaveCount: Math.max(waves.length, numberOr(input.declaredWaveCount, waves.length)),
      coverage: {
        declaredTaskCount: Math.max(0, numberOr(input.coverage?.declaredTaskCount, 0)),
        mappedNodeCount: waves.reduce((total, wave) => total + wave.mappedCount, 0),
        complete: input.coverage?.complete === true,
      },
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
    const availabilityInput = input.graphAvailability && typeof input.graphAvailability === "object" && !Array.isArray(input.graphAvailability) ? input.graphAvailability : {};
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
      const loadoutValue = item.loadout && typeof item.loadout === "object" ? item.loadout : {};
      const loadout = {
        skills: Math.max(0, numberOr(loadoutValue.skills, 0)),
        mcp: Math.max(0, numberOr(loadoutValue.mcp, 0)),
        tools: Math.max(0, numberOr(loadoutValue.tools, 0)),
        commands: Math.max(0, numberOr(loadoutValue.commands, 0)),
        hooks: Math.max(0, numberOr(loadoutValue.hooks, 0)),
        plugins: Math.max(0, numberOr(loadoutValue.plugins, 0)),
        memoryGraph: Math.max(0, numberOr(loadoutValue.memoryGraph, 0)),
        dependencies: Math.max(0, numberOr(loadoutValue.dependencies, 0)),
        skillNames: capabilityNames(loadoutValue.skillNames),
        mcpNames: capabilityNames(loadoutValue.mcpNames),
        toolNames: capabilityNames(loadoutValue.toolNames),
        commandNames: capabilityNames(loadoutValue.commandNames),
        hookNames: capabilityNames(loadoutValue.hookNames),
        pluginNames: capabilityNames(loadoutValue.pluginNames),
        memoryGraphNames: capabilityNames(loadoutValue.memoryGraphNames),
        dependencyNames: capabilityNames(loadoutValue.dependencyNames),
      };
      return {
        id: display(firstValue(item, ["id", "nodeId"], "node-" + (index + 1)), "node-" + (index + 1)),
        label: display(firstValue(item, ["label", "title", "name", "nodeId"], "Untitled task"), "Untitled task"),
        kind: display(firstValue(item, ["kind", "nodeKind", "type"], "worker"), "worker").toLowerCase().replace(/[\s-]+/gu, "_"),
        isMain: item.isMain === true,
        stage: display(firstValue(item, ["stage", "chapter", "phase"], ""), "").toLowerCase().replace(/[\s_]+/gu, "-"),
        status: normalizedNodeStatus(firstValue(item, ["status", "state"], "queued")),
        displayState: display(firstValue(item, ["displayState", "publicState"], firstValue(item, ["status", "state"], "unknown")), "unknown").toLowerCase().replace(/[\s-]+/gu, "_"),
        statusReason: display(firstValue(item, ["statusReason", "stateReason"], ""), ""),
        active: item.active === true,
        role: display(firstValue(item, ["roleDisplayName", "role", "ownerRole"], "worker"), "worker"),
        agent: display(firstValue(item, ["agent", "ownerAgent", "owner"])),
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
        loadout,
        capabilityTruth: normalizeNodeCapabilityTruth(item, loadout),
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
        kind: display(firstValue(item, ["kind", "relation", "type"], "sequence"), "sequence").toLowerCase().replace(/[\s-]+/gu, "_"),
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
      kind: "contains",
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
    // Rebuilt on the same terms as the session row's copy below: the wire value is
    // untrusted and a header only needs the reason. It has to be named explicitly
    // because the run object here is built field by field, so a field this
    // normalizer omits is gone before the header renders — indistinguishable from
    // a server that never sent one, which lands back on the generic sentence.
    const discoveryInput = firstValue(runInput, ["conversationDiscovery"], firstValue(sessionInput, ["conversationDiscovery"], null));
    const runConversationDiscovery = discoveryInput && typeof discoveryInput === "object"
      ? { state: display(discoveryInput.state, ""), reason: display(discoveryInput.reason, "") }
      : null;

    return {
      schemaVersion: display(input.schemaVersion, "unknown"),
      source: display(firstValue(sourceInput, ["label", "name", "kind"], input.source), "local observer"),
      run: hasRun ? {
        id: display(firstValue(runInput, ["id", "runId", "key"], input.runId), "unidentified run"),
        title: display(firstValue(runInput, ["title", "name", "label"], "Live execution"), "Live execution"),
        task: display(firstValue(runInput, ["task", "description", "summary"], input.task), "Governed execution"),
        status: normalizedStatus(firstValue(runInput, ["status", "state", "runStatus"], input.status)),
        displayState: normalizedRunDisplayState(runInput, firstValue(runInput, ["status", "state", "runStatus"], input.status)),
        statusReason: display(firstValue(runInput, ["statusReason", "stateReason"], ""), ""),
        active: runInput.active === true,
        sourceRuntime: display(firstValue(runInput, ["sourceRuntime", "runtime"], firstValue(sessionInput, ["sourceRuntime", "runtime"], "unknown")), "unknown"),
        conversationLinkState: display(firstValue(runInput, ["conversationLinkState"], firstValue(sessionInput, ["conversationLinkState"], "unlinked")), "unlinked").toLowerCase(),
        conversationLinkRefusal: display(firstValue(runInput, ["conversationLinkRefusal"], firstValue(sessionInput, ["conversationLinkRefusal"], "")), ""),
        // Named for the same reason as the link state above, and measurably
        // needed: the server ships run.conversationRef, this normalizer omitted
        // it, so the header could only ever print the verdict and never the chat
        // it points at. Passed through safeIdentifier because it reaches the DOM.
        conversationRef: safeIdentifier(firstValue(runInput, ["conversationRef", "threadId", "conversationId"], firstValue(sessionInput, ["conversationRef", "threadId", "conversationId"], ""))),
        conversationTitle: display(firstValue(runInput, ["conversationTitle"], firstValue(sessionInput, ["conversationTitle"], "")), ""),
        conversationDiscovery: runConversationDiscovery,
        verifiedLinks: Array.isArray(runInput.verifiedLinks) ? runInput.verifiedLinks.slice(0, 16) : [],
        candidateLinks: Array.isArray(runInput.candidateLinks) ? runInput.candidateLinks.slice(0, 16) : [],
        stage: display(firstValue(runInput, ["stage", "currentStage", "phase"], "Observing"), "Observing"),
        currentStage: display(firstValue(runInput, ["currentStage", "stage", "phase"], "Observing"), "Observing"),
        startedAt: display(firstValue(runInput, ["startedAt", "startTime"])),
        updatedAt: display(firstValue(runInput, ["updatedAt", "lastUpdatedAt", "observedAt"])),
        transport: display(firstValue(runInput, ["transport", "sourceTransport"], "snapshot"), "snapshot"),
        eventIndex,
        eventCount,
        demoMode: runInput.demoMode === true,
        executionEvidenceState: display(firstValue(runInput, ["executionEvidenceState"], "unavailable"), "unavailable"),
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
      scheduling: normalizeScheduling(input.scheduling),
      graphAvailability: {
        state: display(firstValue(availabilityInput, ["state"], "unavailable"), "unavailable"),
        reason: display(firstValue(availabilityInput, ["reason"], ""), ""),
      },
      truncated: { applied: input.truncated?.applied === true },
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

  /**
   * Compose one "Label · value" inspector fact. An absent value renders the
   * configured placeholder, so the inspector cannot disagree with the rest of
   * the page about what "no value" looks like.
   *
   * The separator stays literal here on purpose: localize() recognises these
   * facts by their English prefix and slices past it by a fixed offset, so a
   * configurable separator would silently break every one of those branches.
   */
  function labeledFact(label, value) {
    return label + " · " + display(value);
  }

  function makeElement(tagName, className, value) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = localize(display(value));
    return element;
  }

  /**
   * Format an observed timestamp, or return an empty string when none was
   * observed. Minting the placeholder here pushed the glyph into time elements,
   * aria labels and concatenated sentences, where it reads as though a time had
   * been recorded. Callers that want a visible empty slot ask for one.
   */
  function formatTime(value) {
    const text = display(value, "");
    if (text === "") return "";
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

  /**
   * Append the observed time of a row, and nothing at all when the row carries no
   * timestamp. An empty time element has no machine-readable value and announces
   * the placeholder glyph as if it were a time.
   */
  function appendObservedTime(parent, value) {
    const iso = display(value, "");
    if (!parent || iso === "") return;
    const element = makeElement("time", "evidence-time", formatTime(iso));
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) element.dateTime = parsed.toISOString();
    parent.append(element);
  }

  function formatDuration(firstAt, lastAt) {
    const startedAt = new Date(display(firstAt, ""));
    const endedAt = new Date(display(lastAt, ""));
    if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) return DISPLAY_FORMAT.emptyPlaceholder;
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

  function generatedRunTitle(title) {
    const value = display(title, "").trim();
    return !value || /^(?:run\s+[a-z0-9-]{6,}|active governed run|governed task|live execution|observed execution)$/iu.test(value);
  }

  function sessionIsIdentified(session) {
    return session?.identificationState === "descriptive"
      || session?.conversationLinkState === "verified"
      || (!generatedRunTitle(session?.title) && session?.titleSource !== "generated_run_id");
  }

  /**
   * The read model always hands over a task string, so absence arrives here as
   * one of its substitutes rather than as an empty value: "Governed execution"
   * when the record named no task, and the redaction marker when the text was
   * withheld. Printing either verbatim would caption a silent record with what
   * reads as its summary, so each is named for what it is.
   */
  function runTaskCopy(task) {
    const text = display(task, "").trim();
    if (!text || text === "Governed execution") {
      return currentLanguage === "zh" ? "未保存任务摘要" : "No task summary saved";
    }
    if (text === "[path omitted]" || text === "redacted") {
      return currentLanguage === "zh" ? "任务摘要因含敏感内容未显示" : "Task summary withheld as sensitive";
    }
    return text;
  }

  function conversationLinkCopy(state, refusal, discovery) {
    if (state === "verified") return currentLanguage === "zh" ? "已确认关联" : "Verified link";
    if (state === "candidate") return currentLanguage === "zh" ? "可能相关 · 未验证" : "Possible match · unverified";
    // A recorded reason replaces the generic sentence rather than joining it: the
    // reason already says no link exists, and stacking both doubles the row for
    // no added fact.
    const reason = CONVERSATION_REFUSAL_TEXT[refusal];
    if (reason) return localize(reason);
    // A refusal names the step that failed and only exists once a binding was
    // attempted. Discovery names how far the lookup could reach at all, so it is
    // the coarser answer and yields to a refusal whenever a run carries both.
    const reach = discovery && typeof discovery === "object" ? CONVERSATION_DISCOVERY_TEXT[discovery.reason] : null;
    if (reach) return localize(reach);
    // No record in this history stored a conversation id, so no link was lost —
    // one was never written. Saying which is the difference between a reader
    // hunting for a broken link and a reader knowing there is nothing to find.
    return currentLanguage === "zh" ? "这次运行没有保存聊天标识" : "No chat id was saved for this run";
  }

  /**
   * The run header and the session card print the same fact about the same run,
   * and each used to assemble the arguments itself. The header passed two of the
   * three, so 42 of 46 measured rows said "only the run record was checked" in
   * the list and "no chat id was saved" in the header — a run contradicting
   * itself on two surfaces a reader sees at once. Taking the record instead of
   * loose fields is what makes "this call site forgot one" unrepresentable, so
   * this is the only place allowed to call conversationLinkCopy.
   */
  function conversationLinkCopyFor(record) {
    return conversationLinkCopy(
      record && record.conversationLinkState,
      record && record.conversationLinkRefusal,
      record && record.conversationDiscovery,
    );
  }

  /**
   * The whole chat id behind a verified or candidate link. The label below prints
   * a shortened form so it fits a fact row, which leaves a reader who wants to
   * open that chat with nothing to search on. Keeping the full value in one
   * helper is what stops the shortened form from becoming the only stored answer,
   * and what stops the two surfaces from normalising the field differently.
   */
  function conversationChatIdentityValue(record) {
    const state = record && record.conversationLinkState;
    if (state !== "verified" && state !== "candidate") return "";
    const ref = record && record.conversationRef;
    return typeof ref === "string" ? ref.trim() : "";
  }

  /**
   * Name the chat a verified or candidate link points at. Without it the verdict
   * is a claim the reader cannot check: the one verified row measured in the
   * browser rendered no chat id anywhere on the page and offered nothing to
   * click, so the only way to see which chat had been found was to read the
   * projection off disk. Empty for every other state, and empty when the state
   * says verified but no ref was saved — a placeholder there would move the
   * uncheckable claim one layer down instead of removing it.
   */
  function conversationChatIdentityCopy(record) {
    const ref = shortenIdentifier(conversationChatIdentityValue(record), DISPLAY_FORMAT.identifierShortForm);
    if (ref === "") return "";
    return (currentLanguage === "zh" ? "聊天 " : "Chat ") + ref;
  }

  function nodeDisplayState(node) {
    const state = display(node?.displayState, "").toLowerCase().replace(/[\s-]+/gu, "_");
    if (["active", "queued", "completed", "failed", "blocked", "cancelled", "unreported"].includes(state)) return state;
    // Legacy structural records often carry a generic unknown value. Once the
    // run is inactive, the exact public truth is that no execution writeback
    // was received, rather than an unexplained status.
    if (state === "unknown" && node?.active !== true && !["completed", "failed", "blocked", "cancelled"].includes(node?.status)) return "unreported";
    if (state === "unknown") return "unknown";
    if (node?.active === true && ["pending", "queued"].includes(node?.status)) return "queued";
    // Inactive pending data is structural planning, not a live queue entry.
    if (node?.active !== true && ["pending", "queued"].includes(node?.status)) return "unreported";
    if (node?.status === "running") return "active";
    if (["completed", "failed", "blocked", "cancelled"].includes(node?.status)) return node.status;
    return "unknown";
  }

  function nodeStateCopy(node) {
    const state = nodeDisplayState(node);
    if (state === "unreported") return currentLanguage === "zh" ? "未收到执行回写" : "No execution report";
    if (state === "unknown") return currentLanguage === "zh" ? "状态未知" : "Unknown state";
    if (state === "active") return currentLanguage === "zh" ? "执行中" : "Running";
    if (state === "cancelled") return currentLanguage === "zh" ? "已取消" : "Cancelled";
    return stateCopy(state);
  }

  function sourceRuntimeLabel(value) {
    const runtime = display(value, "unavailable").toLowerCase();
    if (runtime === "demo") return currentLanguage === "zh" ? "本地状态演示" : "Local state demo";
    if (runtime === "claude") return "Claude Code";
    if (runtime === "codex") return "Codex";
    if (runtime === "cursor") return "Cursor";
    if (runtime === "openclaw") return "OpenClaw";
    // The runtime is either absent from the record or a name this surface is not
    // allowed to attribute. Either way the honest statement is about the record,
    // not about a source that supposedly exists but cannot be identified.
    return currentLanguage === "zh" ? "未记录运行来源" : "Runtime not recorded";
  }

  function sessionDisplayTitle(session) {
    if (sessionIsIdentified(session)) return session.title;
    return currentLanguage === "zh" ? "没有保存聊天标识的运行记录" : "Run without a saved chat id";
  }

  function sessionShortId(session) {
    return shortenIdentifier(display(session?.runId, ""), DISPLAY_FORMAT.identifierShortForm);
  }

  /**
   * The substance judgement is made upstream and shipped on the catalog session,
   * so no surface here re-derives a threshold for "did anything happen".
   */
  function sessionIsSubstantive(session) {
    return session?.substanceClass !== "activation_only";
  }

  /**
   * Which origin a row is allowed to claim. An origin nobody registered ranks
   * and renders as a real governed run, so a record cannot promote itself by
   * declaring a label of its own, and an absent origin means a real run so
   * existing history needs no migration.
   */
  function sessionRecordOrigin(session) {
    const declared = display(session?.recordOrigin, "");
    return typeof RECORD_ORIGIN_TEXT[declared] === "string" ? declared : "${LIVE_DEFAULT_RECORD_ORIGIN}";
  }

  function sessionIsGovernedRun(session) {
    return sessionRecordOrigin(session) === "${LIVE_DEFAULT_RECORD_ORIGIN}";
  }

  function sessionOriginCopy(session) {
    const copy = RECORD_ORIGIN_TEXT[sessionRecordOrigin(session)];
    return copy ? localize(copy) : "";
  }

  function sessionIsForeground(session) {
    return sessionIsIdentified(session) && sessionIsSubstantive(session);
  }

  /**
   * One tally for every surface that prints how many runs a project has. Three
   * renderers each derived their own: the project option printed the shipped
   * session count, the run picker printed how many rows survived
   * sessionIsIdentified, and the run list printed how many failed
   * sessionIsForeground. Measured on the real repository with the panel open,
   * that read "Meta_Kim · 36 次运行" beside a picker holding 23 rows, and nothing
   * on the panel named the other 13.
   */
  function projectRunTally(project) {
    const sessions = Array.isArray(project?.sessions) ? project.sessions : [];
    const openable = sessions.filter(sessionIsIdentified).length;
    return {
      held: sessions.length,
      openable,
      unopenable: Math.max(0, sessions.length - openable),
    };
  }

  /**
   * The picker is the only control a run can be opened from, so the label reports
   * what it can reach alongside what the project holds. The plain form survives
   * for a project withholding nothing: "4 of 4 runs" reads as a withheld run that
   * does not exist.
   */
  function projectOptionLabel(project) {
    const tally = projectRunTally(project);
    const name = project?.displayName || "";
    if (!tally.held) return name + " · no runs";
    if (!tally.unopenable) return name + " · " + tally.held + " runs";
    return name + " · " + tally.openable + " of " + tally.held + " runs";
  }

  /**
   * Named inside the picker itself. The run list explains the same records, but
   * only after the reader opens a disclosure at the bottom of a different list,
   * so the picker used to look complete rather than filtered.
   */
  function unopenableRunNoticeLabel(count) {
    return "+ " + count + " runs without an openable record";
  }

  /**
   * One ordering and one grouping rule for every session list. The repository
   * view sorted by nothing and the session cards sorted by identity alone, so the
   * two lists disagreed about which run mattered and a run that only recorded its
   * activation could outrank one that actually executed.
   *
   * The order is the configured default-selection policy, not a second comparator
   * written to match it. A hand-written twin held only the terms it happened to
   * carry, so it ignored liveness entirely and ranked a stale record above the run
   * still executing -- while the run this panel actually opens was chosen by the
   * policy. The row at the top of the list has to be the row that opens.
   */
  function sessionGroups(sessions) {
    const ordered = [...(sessions || [])]
      .map((session) => sessionSelectionRow(session, { identified: sessionIsIdentified(session) }))
      .sort((left, right) => compareSelectionRows(left, right, DEFAULT_SELECTION))
      .map((row) => row.session);
    return {
      ordered,
      foreground: ordered.filter(sessionIsForeground),
      background: ordered.filter((session) => !sessionIsForeground(session)),
    };
  }

  /**
   * What a run row is allowed to claim about its own outcome. The catalog has
   * already judged the record, so displayState leads and the raw status is only
   * a fallback for rows that predate the judgement. A row whose record states an
   * executed, verified, release-refused run must not read as an unjudged one,
   * and a row that states no outcome drops the segment rather than borrowing
   * the shared fallback word, which would put a verdict on a silent record.
   */
  function sessionStateCopy(session) {
    const state = display(session?.displayState, "") || display(session?.status, "");
    return state ? stateCopy(state) : "";
  }

  function sessionRowMeta(session) {
    return [
      session.active ? "Running" : "Observed run",
      informativeValue(session.currentStage, "Stage unconfirmed"),
      formatSessionTime(session.updatedAt),
    ].filter(Boolean).map(localize).concat(sessionStateCopy(session) || []).join(" · ");
  }

  // The updatedAt value carries two very different claims. Either the run
  // reported that time, or the run reported none and the value is when its record
  // file was last written. Counted on the panel itself, not on the artifact
  // directory: 22 of the 37 rows this repo's own project publishes are the second
  // kind, and they read as plausible only by luck — rewriting one of those files
  // today would make its row claim the run was touched just now.
  function sessionTimeCopy(session) {
    const shown = formatSessionTime(session?.updatedAt);
    const hint = [];
    const started = display(session?.startedAt, "");
    if (started) hint.push(localize("Started") + " " + formatSessionTime(started));
    const basis = display(session?.updatedAtBasis, "");
    if (basis === "record_file_write_time") {
      hint.push(localize("This record reports no time of its own; the value shown is when its file was last written."));
      return { text: localize("File time") + " " + shown, hint: hint.join(" · ") };
    }
    // An unstated basis is an open question, not a reported time. Reading it as
    // reported is the one direction that turns a missing field into reassurance.
    hint.push(basis === "recorded"
      ? localize("Time reported by the record")
      : localize("The record does not say where this time came from."));
    return { text: shown, hint: hint.join(" · ") };
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
    if (status === "partial") return currentLanguage === "zh" ? "已执行并验证 · 未达发布标准" : "Executed and verified · below release bar";
    if (status === "superseded") return currentLanguage === "zh" ? "被新任务替代" : "Replaced by a newer task";
    if (status === "archived_legacy") return currentLanguage === "zh" ? "早期版本的归档记录" : "Archived record from an earlier version";
    if (status === "unreported") return currentLanguage === "zh" ? "未收到执行回写" : "No execution report";
    // Reserved for records that really do say nothing decisive. Every outcome the
    // record does name has its own branch above, so this reaching the screen means
    // the record is genuinely silent rather than merely unread.
    if (status === "unknown") return currentLanguage === "zh" ? "记录不足以判断" : "Record is not enough to judge";
    if (status === "cancelled") return currentLanguage === "zh" ? "已取消" : "Cancelled";
    if (status === "active") return currentLanguage === "zh" ? "执行中" : "Running";
    return localize("Stale");
  }

  function updateConnection(kind, message) {
    if (connectionLabel) {
      // The transport status is clipped at narrow widths, so the full text has
      // to stay reachable on hover. The markup declares an i18n text pair for the
      // initial "Connecting…", which every later status invalidates: refreshing
      // the pair keeps the declared translation matching the rendered text, so a
      // second applyLanguage() pass could not resurrect the initial status. The
      // message must be the English source with its translation in zhText — a
      // caller that localizes first would cache Chinese as the English original.
      connectionLabel.dataset.i18nEn = message;
      connectionLabel.dataset.i18nZh = zhText.get(message) || message;
      connectionLabel.dataset.i18nTitleEn = message;
      connectionLabel.textContent = localize(message);
      connectionLabel.title = localize(message);
    }
    if (connectionDot) connectionDot.dataset.connection = kind;
  }

  function updateHeader(snapshot) {
    setText(title, snapshot.run.title, "Live execution");
    setText(contextTitle, snapshot.run.title, "Live execution");
    setText(statusTitle, snapshot.run.title, "Live execution");
    const shortRunId = shortenIdentifier(snapshot.run.id, DISPLAY_FORMAT.identifierShortForm);
    setText(runId, shortRunId === "" ? "" : "Run ID · " + shortRunId, "unidentified run");
    setText(stage, informativeValue(snapshot.run.stage, "Observing"), "Observing");
    setText(started, formatTime(snapshot.run.startedAt));
    setText(updated, formatTime(snapshot.run.updatedAt));
    setText(source, snapshot.source, "local observer");
    const activeWorkers = new Set(graphNodesForSnapshot(snapshot)
      .filter((node) => ["running", "active"].includes(node.status))
      .map((node) => node.agent)
      .filter(Boolean));
    setText(runProgress, "Event " + snapshot.run.eventIndex + " of " + snapshot.run.eventCount);
    setText(runWorkers, activeWorkers.size
      ? activeWorkers.size + " active worker" + (activeWorkers.size === 1 ? "" : "s")
      : "No active workers");
    setText(nodeCount, graphNodesForSnapshot(snapshot).length + " nodes", "0 nodes");
    setText(contextTask, runTaskCopy(snapshot.run.task));
    setText(contextStage, informativeValue(snapshot.run.stage, "Stage unconfirmed"), "Stage unconfirmed");
    setText(contextStatus, stateCopy(snapshot.run.status), "In doubt");
    setText(contextUpdated, formatTime(snapshot.run.updatedAt));
    // Joined from the parts that exist rather than a fixed two-part string: the
    // chat id is absent for every run that was never bound, and a trailing
    // separator in front of nothing reads as a value that failed to load.
    const contextSourceParts = [
      sourceRuntimeLabel(snapshot.run.sourceRuntime),
      conversationLinkCopyFor(snapshot.run),
    ].filter((part) => part !== "");
    setText(contextSource, snapshot.run.demoMode
      ? (currentLanguage === "zh" ? "演示数据 · 非真实运行" : "Demo data · not a real run")
      : contextSourceParts.join(" · "), "local observer");
    // The id lives in its own row rather than the source sentence because a
    // reader who wants to open that chat needs the whole value, and the sentence
    // can only carry the shortened form. Hidden rather than emptied: an empty
    // control still takes focus and reads as an id that failed to load.
    const chatIdentity = conversationChatIdentityValue(snapshot.run);
    if (contextChat) contextChat.hidden = snapshot.run.demoMode === true || chatIdentity === "";
    if (contextChatCopy) {
      contextChatCopy.textContent = conversationChatIdentityCopy(snapshot.run);
      contextChatCopy.dataset.chatId = chatIdentity;
    }
    setText(contextNodes, String(graphNodesForSnapshot(snapshot).length), "0");
    setText(contextEvents, String(snapshot.run.eventCount || snapshot.replay.length || 0), "0");
    setText(contextEvidence, String(snapshot.evidence.length || 0), "0");
    const status = snapshot.run.displayState || snapshot.run.status;
    if (stateChip) stateChip.dataset.state = status;
    setText(stateLabel, stateCopy(status), "Stale");
    if (liveRegion) liveRegion.textContent = localize("Run snapshot updated: " + snapshot.run.title);
    if (lastUpdate) {
      const observedAt = formatTime(snapshot.run.updatedAt);
      lastUpdate.textContent = observedAt === ""
        ? localize("No observation recorded yet")
        : localize("Last observed " + observedAt);
    }
  }

  function buildStateDemoSnapshot() {
    const now = new Date().toISOString();
    const nodes = [
      {
        id: "demo-owner",
        isMain: true,
        label: currentLanguage === "zh" ? "任务已受理" : "Request accepted",
        kind: "main_agent",
        status: "completed",
        displayState: "completed",
        roleDisplayName: "operator",
        ownerAgent: "meta-warden",
        summary: currentLanguage === "zh" ? "目标与验收标准已确认" : "Goal and acceptance criteria confirmed",
        task: currentLanguage === "zh" ? "建立可验证的混合状态执行图" : "Build a verifiable mixed-state execution graph",
        evidenceCount: 1,
      },
      {
        id: "demo-requirements",
        parentId: "demo-owner",
        label: currentLanguage === "zh" ? "需求分析" : "Requirements analysis",
        kind: "worker",
        status: "completed",
        displayState: "completed",
        roleDisplayName: "analysis",
        ownerAgent: "business-analyst",
        summary: currentLanguage === "zh" ? "已完成 · 结果已回写" : "Completed · result written back",
        task: currentLanguage === "zh" ? "确认业务目标和展示范围" : "Confirm goals and display scope",
        firstAt: "2026-08-31T00:00:01.000Z",
        evidenceCount: 2,
      },
      {
        id: "demo-plan",
        parentId: "demo-requirements",
        label: currentLanguage === "zh" ? "执行编排" : "Execution orchestration",
        kind: "workflow",
        status: "completed",
        displayState: "completed",
        roleDisplayName: "conductor",
        ownerAgent: "meta-conductor",
        summary: currentLanguage === "zh" ? "串行主链 + 2 条并行执行分支" : "Serial spine with two parallel execution branches",
        task: currentLanguage === "zh" ? "按真实依赖编排执行顺序" : "Orchestrate execution by real dependencies",
        evidenceCount: 1,
      },
      {
        id: "demo-running-ui",
        parentId: "demo-plan",
        label: currentLanguage === "zh" ? "界面实现" : "UI implementation",
        kind: "worker",
        status: "running",
        displayState: "active",
        active: true,
        roleDisplayName: "frontend",
        ownerAgent: "frontend-developer",
        summary: currentLanguage === "zh" ? "执行中 · 正在还原界面" : "Running · implementing the interface",
        task: currentLanguage === "zh" ? "实现节点布局与状态视觉" : "Implement node layout and state visuals",
        firstAt: "2026-08-31T00:00:02.000Z",
        toolCount: 2,
        latestTool: "apply_patch",
      },
      {
        id: "demo-running-test",
        parentId: "demo-plan",
        label: currentLanguage === "zh" ? "状态验证" : "State verification",
        kind: "worker",
        status: "running",
        displayState: "active",
        active: true,
        roleDisplayName: "test",
        ownerAgent: "test-automator",
        summary: currentLanguage === "zh" ? "执行中 · 检查状态与连线" : "Running · checking states and edges",
        task: currentLanguage === "zh" ? "验证动画只出现在真实执行分支" : "Verify animation only appears on active branches",
        firstAt: "2026-08-31T00:00:03.000Z",
        toolCount: 1,
        latestTool: "browser",
      },
      {
        id: "demo-queued",
        parentId: "demo-running-test",
        label: currentLanguage === "zh" ? "独立审查" : "Independent review",
        kind: "worker",
        status: "queued",
        displayState: "queued",
        active: true,
        roleDisplayName: "review",
        ownerAgent: "meta-prism",
        summary: currentLanguage === "zh" ? "排队 · 等待实现完成" : "Queued · waiting for implementation",
        task: currentLanguage === "zh" ? "检查布局、状态真值和交互" : "Review layout, state truth, and interaction",
        firstAt: "2026-08-31T00:00:04.000Z",
      },
      {
        id: "demo-blocked",
        parentId: "demo-queued",
        label: currentLanguage === "zh" ? "发布验收" : "Release acceptance",
        kind: "worker",
        status: "blocked",
        displayState: "blocked",
        roleDisplayName: "verify",
        ownerAgent: "meta-sentinel",
        summary: currentLanguage === "zh" ? "已阻塞 · 等待审查证据" : "Blocked · waiting for review evidence",
        statusReason: currentLanguage === "zh" ? "前置审查尚未完成" : "Prerequisite review has not completed",
        task: currentLanguage === "zh" ? "完成最终发布验收" : "Complete final release acceptance",
        firstAt: "2026-08-31T00:00:05.000Z",
      },
    ];
    return {
      schemaVersion: "state-demo-v1",
      source: { kind: "demo", label: currentLanguage === "zh" ? "本地状态演示" : "Local state demo" },
      run: {
        id: "demo-mixed-states",
        title: currentLanguage === "zh" ? "状态演示 · 完成、执行中、排队与阻塞" : "State demo · completed, running, queued, and blocked",
        task: currentLanguage === "zh" ? "这是一条只用于验证界面状态和连线动画的演示数据，不是真实任务。" : "This is demo data for validating UI states and edge animation, not a real task.",
        status: "live",
        displayState: "live",
        active: true,
        demoMode: true,
        sourceRuntime: "demo",
        conversationLinkState: "unlinked",
        stage: "Execution",
        currentStage: "Execution",
        startedAt: now,
        updatedAt: now,
        eventIndex: 5,
        eventCount: 7,
      },
      nodes,
      edges: [
        { id: "demo-edge-1", from: "demo-owner", to: "demo-requirements", kind: "sequence", status: "completed" },
        { id: "demo-edge-2", from: "demo-requirements", to: "demo-plan", kind: "sequence", status: "completed" },
        { id: "demo-edge-3", from: "demo-plan", to: "demo-running-ui", kind: "fork", status: "running" },
        { id: "demo-edge-4", from: "demo-plan", to: "demo-running-test", kind: "fork", status: "running" },
        { id: "demo-edge-5", from: "demo-running-ui", to: "demo-queued", kind: "depends_on", status: "queued" },
        { id: "demo-edge-6", from: "demo-running-test", to: "demo-queued", kind: "depends_on", status: "queued" },
        { id: "demo-edge-7", from: "demo-queued", to: "demo-blocked", kind: "depends_on", status: "blocked" },
      ],
      evidence: [
        { id: "demo-evidence-1", label: currentLanguage === "zh" ? "需求分析结果" : "Requirements result", status: "verified", nodeId: "demo-requirements", summary: currentLanguage === "zh" ? "演示完成态证据" : "Demo completion evidence" },
      ],
      replay: { events: [nodes[0], nodes[1], nodes[2], nodes[5], nodes[6], nodes[3], nodes[4]].map((node, index) => ({ id: "demo-event-" + index, nodeId: node.id, label: node.summary, status: node.status, kind: node.kind, visibility: "visible", timestamp: new Date(Date.now() - (nodes.length - index) * 15000).toISOString() })) },
      permissions: { readOnly: true, canMutate: false },
    };
  }

  function nodeClass(status) {
    if (["active", "in_progress", "executing"].includes(status)) return "running";
    return status === "in_doubt" ? "in-doubt" : status;
  }

  function usefulNodeMeta(value) {
    const normalized = display(value, "").trim().toLowerCase();
    if (!normalized || normalized === DISPLAY_FORMAT.emptyPlaceholder) return false;
    return !DISPLAY_FORMAT.nonInformativeValues.includes(normalized);
  }

  /**
   * Machine sentinels such as "in_doubt" and "unknown" are already listed as
   * non-informative for node chips. Session rows, repository rows and the run
   * context printed them verbatim, so the same policy has to gate them too
   * rather than each surface keeping its own idea of an empty value.
   */
  function informativeValue(value, absentCopy) {
    return usefulNodeMeta(value) ? value : absentCopy;
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

  function nodeCapabilityCount(node) {
    return Array.isArray(node?.capabilityTruth)
      ? node.capabilityTruth.filter((record) => record && ["planned", "observed"].includes(record.state)
        && (record.plannedNames?.length || record.actualNames?.length)).length
      : 0;
  }

  function estimatedNodeCardHeight(node) {
    const capabilityRows = Math.ceil(nodeCapabilityCount(node) / 2);
    // Reserve the measured desktop height so the centred fanout child does
    // not get nudged onto a different row after the cards render.
    return Math.max(220, 112 + capabilityRows * 40);
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
    const cardWidth = 228;
    const entityCardWidth = 252;
    const entityColumnStep = layoutMode === "compact" ? 356 : 384;
    const entityRowGap = layoutMode === "compact" ? 88 : 104;
    const spineColumns = layoutMode === "compact" ? 4 : 8;
    const columnGap = layoutMode === "compact" ? 276 : 248;
    const rowGap = layoutMode === "compact" ? 206 : 190;
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
      // A high-fanout execution packet reads best as an organisation chart:
      // the owner chain stays centred above one ordered row of parallel work.
      // Keeping siblings on a single row makes their edge order monotonic, so
      // branch curves cannot cross one another or pass behind sibling cards.
      const childrenByParent = new Map();
      for (const edge of graphEdges) {
        const children = childrenByParent.get(edge.from) || [];
        children.push(nodeById.get(edge.to));
        childrenByParent.set(edge.from, children.filter(Boolean));
      }
      const fanoutEntry = [...childrenByParent.entries()]
        .filter(([, children]) => children.length >= 4)
        .sort((left, right) => right[1].length - left[1].length)[0];
      if (fanoutEntry) {
        const [hubId, fanoutChildren] = fanoutEntry;
        const ancestorIds = [];
        const ancestorSeen = new Set([hubId]);
        let ancestorId = parentById.get(hubId) || nodeById.get(hubId)?.parentId;
        while (ancestorId && nodeById.has(ancestorId) && !ancestorSeen.has(ancestorId)) {
          ancestorSeen.add(ancestorId);
          ancestorIds.unshift(ancestorId);
          ancestorId = parentById.get(ancestorId) || nodeById.get(ancestorId)?.parentId;
        }
        const accountedIds = new Set([...ancestorIds, hubId, ...fanoutChildren.map((node) => node.id)]);
        if (accountedIds.size === nodes.length) {
          fanoutChildren.sort((left, right) => String(left.firstAt || "").localeCompare(String(right.firstAt || "")) || left.label.localeCompare(right.label));
          const childStep = layoutMode === "compact" ? 328 : 356;
          const childStartX = 44;
          const childSpan = (fanoutChildren.length - 1) * childStep + entityCardWidth;
          const centerX = childStartX + childSpan / 2 - entityCardWidth / 2;
          const chain = [...ancestorIds.map((id) => nodeById.get(id)).filter(Boolean), nodeById.get(hubId)].filter(Boolean);
          let chainY = 44;
          for (const node of chain) {
            const height = estimatedNodeCardHeight(node);
            positions.set(node.id, { x: centerX, y: chainY, width: entityCardWidth, height, spine: true });
            chainY += height + (layoutMode === "compact" ? 104 : 124);
          }
          const childY = chainY + (layoutMode === "compact" ? 28 : 44);
          fanoutChildren.forEach((node, index) => {
            positions.set(node.id, {
              x: childStartX + index * childStep,
              y: childY,
              width: entityCardWidth,
              height: estimatedNodeCardHeight(node),
              spine: false,
            });
          });
          const maxChildHeight = Math.max(...fanoutChildren.map(estimatedNodeCardHeight));
          return {
            kind: "fanout",
            positions,
            bounds: {
              width: Math.max(760, childStartX + childSpan + 96),
              height: Math.max(420, childY + maxChildHeight + 96),
            },
          };
        }
      }
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
      const orderedLanes = [...lanes.entries()].sort(([left], [right]) => left - right);
      // Execution depth reads from left to right. Only nodes that truly share
      // the same dependency depth are stacked in one column, so the graph
      // distinguishes serial work from real parallel branches at a glance.
      const laneHeights = new Map(orderedLanes.map(([depth, lane]) => [
        depth,
        lane.reduce((total, node) => total + estimatedNodeCardHeight(node), 0)
          + Math.max(0, lane.length - 1) * entityRowGap,
      ]));
      const maxLaneHeight = Math.max(estimatedNodeCardHeight(nodes[0]), ...laneHeights.values());
      for (const [depth, lane] of orderedLanes) {
        lane.sort((left, right) => String(left.firstAt || "").localeCompare(String(right.firstAt || "")) || left.label.localeCompare(right.label));
        const laneHeight = laneHeights.get(depth) || estimatedNodeCardHeight(lane[0]);
        const laneX = 52 + depth * entityColumnStep;
        let laneY = 44 + (maxLaneHeight - laneHeight) / 2;
        lane.forEach((node) => {
          const height = estimatedNodeCardHeight(node);
          positions.set(node.id, {
            x: laneX,
            y: laneY,
            width: entityCardWidth,
            height,
            spine: lane.length === 1,
          });
          laneY += height + entityRowGap;
        });
      }
      let maxX = 0;
      let maxY = 0;
      for (const position of positions.values()) {
        maxX = Math.max(maxX, position.x + position.width);
        maxY = Math.max(maxY, position.y + position.height);
      }
      return {
        kind: "layered",
        positions,
        bounds: { width: Math.max(760, maxX + 96), height: Math.max(420, maxY + 96) },
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
          height: estimatedNodeCardHeight(node),
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
          height: estimatedNodeCardHeight(node),
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
      kind: "stage",
      positions,
      bounds: {
        width: Math.max(760, maxX + 48),
        height: Math.max(300, maxY + 42),
      },
    };
  }

  function syncLayoutToRenderedCards(layout) {
    const columns = new Map();
    for (const [nodeId, position] of layout.positions) {
      const card = graphState.nodeElements.get(nodeId);
      if (!card) continue;
      position.height = Math.max(position.height, Math.ceil(card.scrollHeight), Math.ceil(card.getBoundingClientRect().height));
      const column = columns.get(position.x) || [];
      column.push({ card, position });
      columns.set(position.x, column);
    }
    for (const column of columns.values()) {
      column.sort((left, right) => left.position.y - right.position.y);
      let nextY = column[0]?.position.y || 0;
      for (const item of column) {
        item.position.y = Math.max(item.position.y, nextY);
        item.card.style.top = item.position.y + "px";
        item.card.style.minHeight = item.position.height + "px";
        nextY = item.position.y + item.position.height + 88;
      }
    }
    let maxX = 0;
    let maxY = 0;
    for (const position of layout.positions.values()) {
      maxX = Math.max(maxX, position.x + position.width);
      maxY = Math.max(maxY, position.y + position.height);
    }
    layout.bounds = { width: Math.max(760, maxX + 96), height: Math.max(420, maxY + 96) };
    graphState.bounds = layout.bounds;
    if (graphScene) {
      graphScene.style.width = layout.bounds.width + "px";
      graphScene.style.height = layout.bounds.height + "px";
    }
    if (edgeLayer) edgeLayer.setAttribute("viewBox", "0 0 " + layout.bounds.width + " " + layout.bounds.height);
  }

  function edgePortSlot(index, count, span) {
    if (count <= 1) return span / 2;
    const margin = Math.min(42, Math.max(24, span * .18));
    return margin + ((span - margin * 2) * index) / Math.max(1, count - 1);
  }

  function edgeGeometry(from, to, ports = {}) {
    const sourceIndex = Math.max(0, Number(ports.sourceIndex) || 0);
    const sourceCount = Math.max(1, Number(ports.sourceCount) || 1);
    const targetIndex = Math.max(0, Number(ports.targetIndex) || 0);
    const targetCount = Math.max(1, Number(ports.targetCount) || 1);
    const fromCenterX = from.x + from.width / 2;
    const fromCenterY = from.y + from.height / 2;
    const toCenterX = to.x + to.width / 2;
    const toCenterY = to.y + to.height / 2;
    const deltaX = toCenterX - fromCenterX;
    const deltaY = toCenterY - fromCenterY;
    const vertical = (ports.layoutKind === "fanout" && deltaY >= 0 && from.spine === true && to.spine === false)
      || Math.abs(deltaY) > Math.abs(deltaX) * .72;
    if (vertical) {
      const direction = deltaY >= 0 ? 1 : -1;
      const x1 = from.x + edgePortSlot(sourceIndex, sourceCount, from.width);
      const y1 = direction > 0 ? from.y + from.height : from.y;
      const x2 = to.x + edgePortSlot(targetIndex, targetCount, to.width);
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
    const y1 = from.y + edgePortSlot(sourceIndex, sourceCount, from.height);
    const x2 = direction > 0 ? to.x : to.x + to.width;
    const y2 = to.y + edgePortSlot(targetIndex, targetCount, to.height);
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
      scale: Math.max(GRAPH_CAMERA.minScale, Math.min(GRAPH_CAMERA.maxScale, Number.isFinite(nextCamera.scale) ? nextCamera.scale : 1)),
    };
    if (graphScene) {
      graphScene.style.transform = "translate(" + camera.x + "px, " + camera.y + "px) scale(" + camera.scale + ")";
    }
    if (graph) {
      graph.dataset.semanticZoom = resolveSemanticZoom(camera.scale, GRAPH_CAMERA);
      graph.style.setProperty("--camera-scale", String(camera.scale));
    }
    updateMinimap();
  }

  /**
   * wholeGraphFits defaults to true because every mode other than overview
   * makes no claim about showing the whole graph. Overview does, so a clipped
   * overview says so in the status bar rather than reading identically to a
   * complete one.
   */
  function setCameraMode(mode, wholeGraphFits = true) {
    cameraMode = ["overview", "follow", "manual"].includes(mode) ? mode : "manual";
    graphFollowing = cameraMode === "follow";
    if (graphFollow) {
      graphFollow.dataset.active = graphFollowing ? "true" : "false";
      graphFollow.setAttribute("aria-pressed", String(graphFollowing));
    }
    if (graph) graph.dataset.following = graphFollowing ? "true" : "false";
    const overviewClipped = cameraMode === "overview" && wholeGraphFits === false;
    if (graph) graph.dataset.overviewClipped = overviewClipped ? "true" : "false";
    const label = cameraMode[0].toUpperCase() + cameraMode.slice(1);
    setText(cameraModeLabel, overviewClipped ? "Overview · partial" : label, "Manual");
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

  /**
   * A stored point is user-authored state that survives reloads, so a corrupted
   * or hand-edited entry has to degrade to the default placement rather than
   * throw during startup and leave the rest of the controller unwired.
   */
  function safeStoredPoint(key) {
    const readPoint = (raw) => {
      if (typeof raw !== "string" || raw === "") return null;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return null;
        if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null;
        return { x: parsed.x, y: parsed.y };
      } catch {
        return null;
      }
    };
    try {
      const sessionPoint = readPoint(window.sessionStorage?.getItem(key));
      if (sessionPoint) return sessionPoint;
      return readPoint(window.localStorage?.getItem(key));
    } catch {}
    return null;
  }

  function persistStoredPoint(key, point) {
    const raw = point === null ? null : JSON.stringify({ x: Math.round(point.x), y: Math.round(point.y) });
    try {
      if (raw === null) window.sessionStorage?.removeItem(key);
      else window.sessionStorage?.setItem(key, raw);
    } catch {}
    try {
      if (raw === null) window.localStorage?.removeItem(key);
      else window.localStorage?.setItem(key, raw);
    } catch {}
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
    app.querySelector(".work-view-menu")?.removeAttribute("open");
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

  /**
   * The cluster is positioned against the graph stage because that is its nearest
   * positioned ancestor, but it may only travel inside the canvas viewport, which
   * begins below the stage bar. Bounds are therefore derived from the canvas rect
   * and expressed in stage coordinates.
   */
  function graphToolsBounds() {
    if (!graphStage || !graph || !graphTools) return null;
    const stageRect = graphStage.getBoundingClientRect();
    const canvasRect = graph.getBoundingClientRect();
    const toolsRect = graphTools.getBoundingClientRect();
    if (!canvasRect.width || !canvasRect.height) return null;
    const minX = canvasRect.left - stageRect.left + GRAPH_TOOLS_EDGE_MARGIN;
    const minY = canvasRect.top - stageRect.top + GRAPH_TOOLS_EDGE_MARGIN;
    return {
      minX,
      minY,
      maxX: Math.max(minX, minX + canvasRect.width - toolsRect.width - GRAPH_TOOLS_EDGE_MARGIN * 2),
      maxY: Math.max(minY, minY + canvasRect.height - toolsRect.height - GRAPH_TOOLS_EDGE_MARGIN * 2),
    };
  }

  function clampGraphToolsPoint(point) {
    const bounds = graphToolsBounds();
    if (!bounds) return point;
    return {
      x: Math.min(Math.max(point.x, bounds.minX), bounds.maxX),
      y: Math.min(Math.max(point.y, bounds.minY), bounds.maxY),
    };
  }

  /** Current on-screen offset of the cluster in stage coordinates, docked or not. */
  function graphToolsStagePoint() {
    if (!graphStage || !graphTools) return { x: 0, y: 0 };
    const stageRect = graphStage.getBoundingClientRect();
    const toolsRect = graphTools.getBoundingClientRect();
    return { x: toolsRect.left - stageRect.left, y: toolsRect.top - stageRect.top };
  }

  function applyGraphToolsPosition() {
    if (!graphTools) return;
    if (!graphToolsPosition) {
      graphTools.dataset.floating = "false";
      graphTools.style.removeProperty("--tools-x");
      graphTools.style.removeProperty("--tools-y");
      return;
    }
    graphTools.dataset.floating = "true";
    graphTools.style.setProperty("--tools-x", Math.round(graphToolsPosition.x) + "px");
    graphTools.style.setProperty("--tools-y", Math.round(graphToolsPosition.y) + "px");
  }

  function announceGraphTools(message) {
    if (liveRegion) liveRegion.textContent = message;
  }

  function moveGraphTools(point, { persist = true } = {}) {
    graphToolsPosition = clampGraphToolsPoint(point);
    applyGraphToolsPosition();
    if (persist) persistStoredPoint(GRAPH_TOOLS_STORAGE_KEY, graphToolsPosition);
  }

  function dockGraphTools() {
    graphToolsPosition = null;
    applyGraphToolsPosition();
    persistStoredPoint(GRAPH_TOOLS_STORAGE_KEY, null);
    announceGraphTools(currentLanguage === "zh" ? "图控件已回到工具条" : "Graph controls docked to the bar");
  }

  /** Keep a floating cluster reachable after the canvas viewport changes size. */
  function reclampGraphTools() {
    if (!graphToolsPosition) return;
    moveGraphTools(graphToolsPosition, { persist: false });
  }

  function nudgeGraphTools(dx, dy) {
    const origin = graphToolsPosition || graphToolsStagePoint();
    moveGraphTools({ x: origin.x + dx, y: origin.y + dy });
    if (!graphToolsPosition) return;
    const x = Math.round(graphToolsPosition.x);
    const y = Math.round(graphToolsPosition.y);
    announceGraphTools(currentLanguage === "zh"
      ? "图控件位置 " + x + " × " + y
      : "Graph controls at " + x + " by " + y);
  }

  function reconcileCamera({ inspectorOpen = evidencePanel?.dataset.open === "true" } = {}) {
    reclampGraphTools();
    if (!graph || !currentSnapshot) return;
    if (cameraMode === "overview") {
      fitGraph();
      return;
    }
    if (cameraMode === "follow") {
      if (inspectorOpen && camera.scale < GRAPH_CAMERA.semanticZoomCellMaxScale) updateCamera({ ...camera, scale: GRAPH_CAMERA.semanticZoomCellMaxScale });
      centerGraphNode(followTargetId());
      return;
    }
    updateMinimap();
  }

  function modalBackgroundElements() {
    const skipLink = document.querySelector(".skip-link");
    return [skipLink, ...Array.from(app.children).filter((child) => !child.matches("[data-live-dialog]"))]
      .filter(Boolean);
  }

  function setModalBackgroundIsolated(active) {
    for (const background of modalBackgroundElements()) {
      if (active && !modalBackgroundState.has(background)) {
        modalBackgroundState.set(background, {
          ariaHidden: background.getAttribute("aria-hidden"),
          inert: background.inert,
        });
      }
      background.inert = active;
      if (active) background.setAttribute("aria-hidden", "true");
    }
  }

  function restoreModalBackground() {
    for (const [background, state] of modalBackgroundState) {
      background.inert = state.inert;
      if (state.ariaHidden === null) background.removeAttribute("aria-hidden");
      else background.setAttribute("aria-hidden", state.ariaHidden);
    }
    modalBackgroundState.clear();
  }

  function dialogFocusables(dialog) {
    return Array.from(dialog?.querySelectorAll(FOCUSABLE_DIALOG_SELECTOR) || [])
      .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
  }

  function trapDialogFocus(event) {
    if (event.key !== "Tab" || !activeDialog || activeDialog.hidden) return;
    const focusable = dialogFocusables(activeDialog);
    if (!focusable.length) {
      event.preventDefault();
      activeDialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const focusInside = activeDialog.contains(document.activeElement);
    if (event.shiftKey && (!focusInside || document.activeElement === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (!focusInside || document.activeElement === last)) {
      event.preventDefault();
      first.focus();
    }
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
      if (!activeDialog) dialogOpener = document.activeElement;
      activeDialog = dialog;
      setModalBackgroundIsolated(true);
    }
    dialog.hidden = !active;
    dialog.setAttribute("aria-hidden", String(!active));
    if (active) dialog.querySelector("button, select, [tabindex]")?.focus();
    else if (activeDialog === dialog) {
      activeDialog = null;
      restoreModalBackground();
      if (dialogOpener && typeof dialogOpener.focus === "function") dialogOpener.focus();
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

  /**
   * The minimap is an overlay pinned to the bottom-right of the canvas, so a
   * symmetric fit padding parks the last node card underneath it. Reserving its
   * measured box keeps the overview state clear of it; the axis that loses the
   * smaller share of the canvas carries the reserve, because a short canvas can
   * afford the width and a narrow one can afford the height.
   */
  function graphFitInset() {
    const pad = GRAPH_CAMERA.fitPaddingPx;
    const inset = { top: pad, right: pad, bottom: pad, left: pad };
    if (!graph || !graphMinimap || graphMinimap.offsetParent === null) return inset;
    const canvas = graph.getBoundingClientRect?.();
    const overlay = graphMinimap.getBoundingClientRect?.();
    if (!canvas?.width || !canvas?.height || !overlay?.width || !overlay?.height) return inset;
    const right = canvas.right - overlay.left + pad;
    const bottom = canvas.bottom - overlay.top + pad;
    if (right / canvas.width <= bottom / canvas.height) {
      return { ...inset, right: Math.max(inset.right, right) };
    }
    return { ...inset, bottom: Math.max(inset.bottom, bottom) };
  }

  /**
   * Overview shows the whole run. The scale it needs comes from the shared
   * resolver, and when even the floor cannot fit the graph the caller is told so
   * the status bar can say "partial" instead of claiming an overview it is not
   * showing.
   */
  function fitGraph() {
    if (!graph || !graphState.bounds.width) return;
    const canvas = { width: graph.clientWidth || 760, height: graph.clientHeight || 420 };
    const fit = resolveOverviewCamera(canvas, graphState.bounds, graphFitInset(), GRAPH_CAMERA);
    updateCamera({ scale: fit.scale, x: fit.x, y: fit.y });
    setCameraMode("overview", fit.wholeGraphFits);
  }

  function zoomGraph(factor, anchorX, anchorY) {
    if (!graph) return;
    const localX = Number.isFinite(anchorX) ? anchorX : graph.clientWidth / 2;
    const localY = Number.isFinite(anchorY) ? anchorY : graph.clientHeight / 2;
    const worldX = (localX - camera.x) / camera.scale;
    const worldY = (localY - camera.y) / camera.scale;
    const scale = Math.max(GRAPH_CAMERA.minScale, Math.min(GRAPH_CAMERA.maxScale, camera.scale * factor));
    updateCamera({ scale, x: localX - worldX * scale, y: localY - worldY * scale });
    setCameraMode("manual");
  }

  function updateSelectedNodeVisuals() {
    const selected = currentSnapshot?.nodes.find((node) => node.id === selectedNodeId) || null;
    for (const [id, card] of graphState.nodeElements.entries()) {
      const active = Boolean(selected && id === selected.id);
      card.dataset.selected = active ? "true" : "false";
      const identityButton = card.querySelector(".node-identity-button");
      if (active) identityButton?.setAttribute("aria-current", "true");
      else identityButton?.removeAttribute("aria-current");
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
    setText(selectedNodeStatus, labeledFact("Status", selected ? nodeStateCopy(selected) : ""));
    setText(selectedNodeOwner, labeledFact("Owner", selected ? selected.agent : ""));
    setText(selectedNodeRuntime, labeledFact("Runtime", selected ? selected.runtime : ""));
    setText(selectedNodeModel, labeledFact("Model", selected ? selected.model : ""));
    setText(selectedNodeDuration, labeledFact("Duration", selected ? formatDuration(selected.firstAt, selected.lastAt) : ""));
    setText(selectedNodeTools, labeledFact("Tools", selected ? toolCount + (usefulNodeMeta(selected.latestTool) ? " · " + selected.latestTool : "") : ""));
    setText(selectedNodeTokens, labeledFact("Tokens", selected ? selected.outputTokens : ""));
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
      setText(selectedNodeLoadout, labeledFact("Loadout", selected ? detail : ""));
    }
    setText(selectedNodeSummary, selected ? selected.summary : "Select a node to inspect its execution summary.", "Select a node to inspect its execution summary.");
    setText(selectedNodeEvidenceDetail, selected?.terminalEvidence || linked[0]?.detail || selected?.statusReason || (selected ? "No terminal evidence is linked to this node yet." : "Evidence details appear when a node is selected."), "Evidence details appear when a node is selected.");
    setText(selectedNodeProvenance, labeledFact("Source", selected ? (provenance?.reasoningExcerpt || (selected.parentId ? "spawned by " + selected.parentId : "run root")) : ""));
    setText(selectedNodePrompt, labeledFact("Prompt era", selected && activePrompt ? activePrompt.label + " · " + activePrompt.excerpt : ""));
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
      // A projection may carry a row without a kind. Concatenating it produced the
      // literal class name history-null, the dataset value "null", and a heading
      // that read "null · Worker evidence 1"; compose only the parts that exist.
      const kindText = display(item.kind, "");
      const entry = makeElement("article", "evidence-item history-item" + (kindText === "" ? "" : " history-" + kindText));
      entry.dataset.evidenceId = item.id;
      entry.dataset.nodeId = item.nodeId || selected?.id || "";
      entry.dataset.associated = selected && entry.dataset.nodeId === selected.id ? "true" : "false";
      if (kindText !== "") entry.dataset.historyKind = kindText;
      if (item.transferState) {
        entry.dataset.transferState = item.transferState;
        entry.dataset.deliveryObserved = item.transferState === "observed" || item.transferState === "accepted" ? "true" : "false";
      }
      entry.setAttribute("role", "listitem");
      const top = makeElement("div", "evidence-item-top");
      const labelText = display(item.label, "");
      const label = makeElement("span", "evidence-kind", kindText === "" ? labelText : kindText + " · " + labelText);
      top.append(label);
      appendObservedTime(top, item.at);
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
    // Scheduling rows sit in the context tab because a planned wave is run
    // context, not observed execution. They carry no timestamp on purpose: a
    // declared order has no observation time, and inventing one would let the
    // row read like something that was watched happening.
    const scheduling = currentSnapshot?.scheduling || null;
    const schedulingRows = [];
    if (scheduling) {
      const capacity = scheduling.capacity || {};
      const capacityParts = [
        Number.isFinite(capacity.maxParallelAgents) ? (currentLanguage === "zh" ? "上限 " : "limit ") + capacity.maxParallelAgents : "",
        Number.isFinite(capacity.requestedParallelAgents) ? (currentLanguage === "zh" ? "申请 " : "requested ") + capacity.requestedParallelAgents : "",
        Number.isFinite(capacity.runtimeCapacity) ? (currentLanguage === "zh" ? "运行时容量 " : "runtime capacity ") + capacity.runtimeCapacity : "",
        capacity.capacitySourceKind,
        capacity.throttled ? (currentLanguage === "zh" ? "申请数超过上限，已受限" : "requested above limit; throttled") : "",
        scheduling.declaredWaveCount > scheduling.waveCount
          ? (currentLanguage === "zh"
            ? "记录 " + scheduling.declaredWaveCount + " 个波次，可显示 " + scheduling.waveCount + " 个"
            : scheduling.declaredWaveCount + " waves recorded, " + scheduling.waveCount + " shown")
          : "",
      ].filter(Boolean).join(" · ");
      if (capacityParts) {
        schedulingRows.push({
          id: "scheduling-capacity",
          kind: "scheduling_capacity",
          label: currentLanguage === "zh" ? "并行容量" : "Parallel capacity",
          detail: capacityParts,
          at: "",
          status: "planned",
          sourceRef: currentLanguage === "zh" ? "计划 · 记录的容量配置，非观测执行" : "planned · recorded capacity configuration",
          nodeId: selected?.id || "",
        });
      }
      scheduling.waves
        .filter((wave) => !selected || wave.nodeIds.includes(selected.id))
        .forEach((wave) => {
          const declared = wave.mappedCount + wave.unmappedCount;
          schedulingRows.push({
            id: wave.waveId,
            kind: "scheduling_wave",
            label: (currentLanguage === "zh" ? "波次 " : "Wave ") + wave.waveIndex + "/" + scheduling.waveCount,
            detail: [
              wave.mode,
              Number.isFinite(wave.declaredParallelCount) ? wave.declaredParallelCount + (currentLanguage === "zh" ? " 个声明并行" : " declared in parallel") : "",
              wave.mergeOwner ? (currentLanguage === "zh" ? "合并负责人 " : "merge owner ") + wave.mergeOwner : "",
              wave.mappedCount + "/" + declared + (currentLanguage === "zh" ? " 个成员对应到图上节点" : " members resolve to graph nodes"),
            ].filter(Boolean).join(" · "),
            at: "",
            status: "planned",
            sourceRef: currentLanguage === "zh" ? "计划 · 声明顺序，非观测执行" : "planned · declared order, not observed execution",
            nodeId: selected?.id || "",
          });
        });
    }
    renderItems(conversationList, "conversation", conversation, "Conversation transcript unavailable for this selection.");
    renderItems(terminalList, "terminal", terminal, "Terminal adapter telemetry unavailable for this selection.");
    renderItems(changesList, "changes", changes, "Diff telemetry unavailable for this selection.");
    renderItems(evidenceList, "evidence", evidence, "No observed evidence is linked to this selection.");
    renderItems(contextTransferList, "context", schedulingRows.concat(transfers), "No context transfer records are available for this selection.");
    const summaryPanel = inspectorPanels.find((item) => item.dataset.liveInspectorPanel === "summary");
    if (summaryPanel) summaryPanel.dataset.itemCount = selected ? "1" : "0";
    setInspectorTab(currentInspectorTab);
  }

  function selectNode(nodeId, { focus = false, inspectorTab = null } = {}) {
    if (!currentSnapshot || !currentSnapshot.nodes.some((node) => node.id === nodeId)) return;
    selectedNodeId = nodeId;
    if (INSPECTOR_TABS.includes(inspectorTab)) currentInspectorTab = inspectorTab;
    updateSelectedNodeVisuals();
    setInspectorOpen(true);
    if (graphFollowing) centerGraphNode(nodeId);
    const node = currentSnapshot.nodes.find((item) => item.id === nodeId);
    if (liveRegion && node) liveRegion.textContent = localize("Selected node: " + node.label);
    if (focus) graphState.nodeElements.get(nodeId)?.querySelector(".node-identity-button")?.focus();
  }

  function handleNodeKeydown(event, nodeId) {
    if (event.target !== event.currentTarget) return;
    const ids = currentSnapshot?.nodes.map((node) => node.id) || [];
    const index = ids.indexOf(nodeId);
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

  /**
   * Several unrelated facts used to print the same "no task nodes" sentence: a
   * run with nothing recorded, a run that only registered stages, a run whose
   * artifact declares nothing, and a projection that dropped nodes to stay
   * inside the byte budget. The actionable causes are named first, and the
   * server's own reason is used for the rest, so the operator is never left to
   * guess whether the run was empty or the payload was trimmed.
   */
  function graphEmptyReason(snapshot) {
    if (snapshot?.truncated?.applied === true) return "Nodes were dropped to stay inside the snapshot budget.";
    if (snapshot?.run?.executionEvidenceState === "structural_planning_only") return "This run registered stages but never reported execution nodes.";
    const reason = snapshot?.graphAvailability?.reason;
    return GRAPH_EMPTY_REASON_TEXT[reason] || "No task nodes in this snapshot.";
  }

  function showGraphEmpty(copy) {
    graphEmpty.hidden = false;
    const paragraph = graphEmpty.firstElementChild || graphEmpty.appendChild(document.createElement("p"));
    if (paragraph.dataset.i18nEn === copy) return;
    paragraph.dataset.i18nEn = copy;
    paragraph.dataset.i18nZh = zhText.get(copy) || copy;
    paragraph.textContent = localize(copy);
    if (liveRegion) liveRegion.textContent = localize(copy);
  }

  function renderGraph(snapshot) {
    const graphNodes = graphNodesForSnapshot(snapshot);
    const graphEdges = graphEdgesForSnapshot(snapshot, graphNodes);
    const graphNodeById = new Map(graphNodes.map((node) => [node.id, node]));
    // Wave membership is read from the projection, never inferred from graph
    // shape. The page cannot observe scheduling order, so a node the projection
    // did not place in a wave simply gets no wave chip instead of a guessed one.
    const waveByNodeId = new Map();
    (snapshot.scheduling?.waves || []).forEach((wave) => {
      (wave.nodeIds || []).forEach((nodeId) => {
        if (!waveByNodeId.has(nodeId)) waveByNodeId.set(nodeId, wave);
      });
    });
    const totalWaveCount = snapshot.scheduling?.waveCount || 0;
    const terminalRun = ["completed", "failed", "blocked", "cancelled"].includes(String(snapshot.run?.status || "").toLowerCase());
    clearChildren(nodeList);
    clearChildren(edgeLayer);
    clearChildren(graphMinimapScene);
    if (!graphNodes.length) {
      if (graphEmpty) showGraphEmpty(graphEmptyReason(snapshot));
      graphState = { positions: new Map(), nodeElements: new Map(), edgeElements: new Map(), edgeEffects: new Map(), bounds: { width: 1, height: 1 } };
      return;
    }
    if (graphEmpty) graphEmpty.hidden = true;

    const layout = layoutGraph(snapshot);
    graphState = { positions: layout.positions, nodeElements: new Map(), edgeElements: new Map(), edgeEffects: new Map(), bounds: layout.bounds };
    if (graph) graph.dataset.layoutKind = layout.kind || "layered";
    if (graphScene) {
      graphScene.style.width = layout.bounds.width + "px";
      graphScene.style.height = layout.bounds.height + "px";
    }
    if (edgeLayer) {
      edgeLayer.setAttribute("viewBox", "0 0 " + layout.bounds.width + " " + layout.bounds.height);
      const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      const markerColors = { running: "#58d4cf", active: "#58d4cf", completed: "#5b8cff", skipped: "#585858", failed: "#e06c75", "in-doubt": "#e06c75", blocked: "#a98bff", cancelled: "#697386", queued: "#8996aa", unreported: "#d7a94a", unknown: "#697386", "stage-live": "#58d4cf", "stage-recorded": "#d8a84e" };
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
      const publicState = nodeDisplayState(node);
      const taskLine = resolveNodeTaskLine(node, DISPLAY_FORMAT);
      const card = makeElement("article", "node-card node-" + nodeClass(publicState));
      card.dataset.nodeId = node.id;
      card.dataset.status = node.status;
      card.dataset.displayState = publicState;
      card.dataset.replayStatus = node.status;
      card.dataset.selected = "false";
      card.title = taskLine || node.label;
      card.setAttribute("role", "listitem");
      const position = layout.positions.get(node.id) || { x: 32, y: 32, width: 132, height: 76 };
      card.style.left = position.x + "px";
      card.style.top = position.y + "px";
      card.style.width = position.width + "px";
      card.style.minHeight = position.height + "px";
      const top = makeElement("div", "node-card-top");
      const marker = makeElement("span", "node-marker");
      marker.setAttribute("aria-hidden", "true");
      top.append(marker, makeElement("span", "node-status", nodeStateCopy(node)));
      const nodeWave = waveByNodeId.get(node.id);
      if (nodeWave) {
        // The badge lives in the status strip, not in .node-meta: that chip row
        // is display:none in the current card layout, so a wave annotation put
        // there would exist in the DOM and be invisible on screen.
        const waveBadge = makeElement("span", "node-wave-badge",
          (currentLanguage === "zh" ? "波" : "W") + nodeWave.waveIndex + "/" + totalWaveCount + (currentLanguage === "zh" ? " 计划" : " plan"));
        waveBadge.title = currentLanguage === "zh"
          ? "计划并行波次 " + nodeWave.waveIndex + "/" + totalWaveCount + " · 声明顺序，不是观测到的执行顺序"
          : "Planned parallel wave " + nodeWave.waveIndex + "/" + totalWaveCount + " · declared order, not observed execution";
        waveBadge.dataset.waveId = nodeWave.waveId;
        waveBadge.dataset.waveIndex = String(nodeWave.waveIndex);
        waveBadge.dataset.waveProvenance = "planned";
        card.dataset.waveIndex = String(nodeWave.waveIndex);
        top.append(waveBadge);
      }
      const heading = makeElement("span", "node-title", node.label);
      const summary = makeElement("span", "node-summary", node.summary);
      const identity = makeElement("button", "node-identity-row node-identity-button");
      identity.type = "button";
      identity.setAttribute("aria-label", node.label + ", " + nodeStateCopy(node) + ", " + node.toolCount + " tools, " + node.outputTokens + " tokens");
      const glyph = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      glyph.setAttribute("class", "node-glyph");
      glyph.setAttribute("viewBox", "0 0 40 40");
      glyph.setAttribute("aria-hidden", "true");
      const glyphPaths = [
        ["circle", { cx: "20", cy: "10", r: "3" }],
        ["circle", { cx: "10", cy: "29", r: "3" }],
        ["circle", { cx: "30", cy: "29", r: "3" }],
        ["path", { d: "M20 13v7M20 20H10v6M20 20h10v6" }],
      ];
      glyphPaths.forEach(([tag, attributes]) => {
        const part = document.createElementNS("http://www.w3.org/2000/svg", tag);
        Object.entries(attributes).forEach(([name, value]) => part.setAttribute(name, value));
        glyph.append(part);
      });
      const identityCopy = makeElement("div", "node-identity-copy");
      identityCopy.append(heading, summary);
      identity.append(glyph, identityCopy);
      identity.addEventListener("click", () => selectNode(node.id, { inspectorTab: "summary" }));
      identity.addEventListener("keydown", (event) => handleNodeKeydown(event, node.id));
      const ownerLine = makeElement("div", "node-owner-line");
      if (usefulNodeMeta(node.role)) ownerLine.append(makeElement("span", "node-owner-role", (currentLanguage === "zh" ? "角色 · " : "Role · ") + node.role));
      if (usefulNodeMeta(node.agent)) ownerLine.append(makeElement("span", "node-owner-agent", (currentLanguage === "zh" ? "AI 执行者 · " : "AI worker · ") + node.agent));
      const outgoingRelations = graphEdges.filter((edge) => edge.from === node.id);
      const ownershipOnly = outgoingRelations.length > 0 && outgoingRelations.every((edge) => edge.kind === "contains");
      const proof = makeElement("div", "node-proof", ownershipOnly
        ? (currentLanguage === "zh" ? "结构归属关系 · 不代表所有任务同时执行" : "Structural ownership · does not mean every task runs at once")
        : node.statusReason || (
          publicState === "unreported"
          ? (currentLanguage === "zh" ? "结构已规划，但没有可信执行回写" : "Structurally planned; no trusted execution report")
          : publicState === "queued"
            ? (currentLanguage === "zh" ? "当前运行活跃，等待执行" : "Active run; waiting to execute")
            : node.evidenceCount
              ? "observed · " + node.evidenceCount + " evidence"
              : (currentLanguage === "zh" ? "暂无可信证据" : "No trusted evidence linked")
        ));
      const task = taskLine === "" ? null : makeElement("p", "node-task", taskLine);
      if (task) task.title = taskLine;
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
      const loadoutTotal = [loadout.skills, loadout.mcp, loadout.tools, loadout.commands, loadout.hooks, loadout.plugins, loadout.memoryGraph, loadout.dependencies]
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
      if (usefulNodeMeta(node.firstAt) && usefulNodeMeta(node.lastAt)) meta.append(makeElement("span", "node-meta-item activity-chip chip-duration", formatDuration(node.firstAt, node.lastAt)));
      if (!meta.childElementCount) meta.hidden = true;
      const capabilityStrip = makeElement("div", "node-capability-strip");
      capabilityStrip.setAttribute("aria-label", currentLanguage === "zh" ? "节点能力与调用概况" : "Node capability and call summary");
      const capabilityLabels = { agent: "Agent", skill: "Skill", mcp: "MCP", command: "Command", runtime_tool: "Tool", hook: "Hook", plugin: "Plugin", memory_graph: "Memory/Graph", dependency: "Dependency" };
      const capabilityRecords = (node.capabilityTruth || []).map((truth) => {
        const kind = truth.kind;
        const names = truth.state === "observed" ? truth.actualNames : truth.plannedNames;
        return {
          kind,
          label: capabilityLabels[kind] || kind,
          names,
          count: names.length,
          state: truth.state,
          tab: ["mcp", "command", "runtime_tool", "hook"].includes(kind)
            ? "terminal"
            : ["memory_graph", "dependency"].includes(kind)
              ? "context"
              : "summary",
        };
      }).filter((record) => record.count > 0 && ["observed", "planned"].includes(record.state));
      capabilityRecords.forEach((record) => {
        const button = makeElement("button", "node-capability node-capability-" + record.kind);
        button.type = "button";
        button.dataset.capabilityKind = record.kind;
        button.dataset.capabilityState = record.state;
        const stateLabel = record.state === "observed"
          ? (currentLanguage === "zh" ? "已观测" : "observed")
          : record.state === "planned"
            ? (currentLanguage === "zh" ? "计划" : "planned")
            : (currentLanguage === "zh" ? "未记录" : "not recorded");
        const value = record.names[0] || (record.count ? String(record.count) : stateLabel);
        const remainder = Math.max(0, record.count - (record.names[0] ? 1 : 0));
        button.append(
          makeElement("span", "node-capability-kind", record.label),
          makeElement("span", "node-capability-value", value + (remainder ? " +" + remainder : "")),
          makeElement("span", "node-capability-state", stateLabel),
        );
        button.title = record.label + " · " + stateLabel + (record.names.length ? " · " + record.names.join(", ") : "");
        button.setAttribute("aria-label", record.label + ": " + (record.names.join(", ") || stateLabel) + ". " + stateLabel);
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          selectNode(node.id, { inspectorTab: record.tab });
        });
        capabilityStrip.append(button);
      });
      card.append(top, identity);
      if (task) card.append(task);
      if (ownerLine.childElementCount) card.append(ownerLine);
      card.append(proof);
      if (capabilityStrip.childElementCount) card.append(capabilityStrip);
      card.append(meta);
      card.addEventListener("click", (event) => {
        if (event.target?.closest?.("button")) return;
        selectNode(node.id, { inspectorTab: "summary" });
      });
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
      nodeList.append(card);
      graphState.nodeElements.set(node.id, card);
    });

    syncLayoutToRenderedCards(layout);

    const outgoingEdges = new Map();
    const incomingEdges = new Map();
    for (const edge of graphEdges) {
      const outgoing = outgoingEdges.get(edge.from) || [];
      outgoing.push(edge);
      outgoingEdges.set(edge.from, outgoing);
      const incoming = incomingEdges.get(edge.to) || [];
      incoming.push(edge);
      incomingEdges.set(edge.to, incoming);
    }
    const sortEdgesByOtherEndpoint = (edges, endpoint) => edges.sort((left, right) => {
      const leftPosition = layout.positions.get(left[endpoint]) || { x: 0, y: 0 };
      const rightPosition = layout.positions.get(right[endpoint]) || { x: 0, y: 0 };
      return leftPosition.y - rightPosition.y || leftPosition.x - rightPosition.x || left.id.localeCompare(right.id);
    });
    outgoingEdges.forEach((edges) => sortEdgesByOtherEndpoint(edges, "to"));
    incomingEdges.forEach((edges) => sortEdgesByOtherEndpoint(edges, "from"));

    for (const edge of graphEdges) {
      const from = layout.positions.get(edge.from);
      const to = layout.positions.get(edge.to);
      if (!from || !to || !edgeLayer) continue;
      const outgoing = outgoingEdges.get(edge.from) || [edge];
      const incoming = incomingEdges.get(edge.to) || [edge];
      const geometry = edgeGeometry(from, to, {
        sourceIndex: Math.max(0, outgoing.indexOf(edge)),
        sourceCount: outgoing.length,
        targetIndex: Math.max(0, incoming.indexOf(edge)),
        targetCount: incoming.length,
        layoutKind: layout.kind,
      });
      const executionRelation = EXECUTION_EDGE_KINDS.has(edge.kind || "sequence");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", geometry.path);
      path.setAttribute("class", "edge edge-" + (executionRelation ? nodeClass(edge.status) : "structural"));
      path.setAttribute("data-edge-id", edge.id);
      path.dataset.edgeKind = edge.kind || "sequence";
      const targetNode = graphNodeById.get(edge.to);
      const targetState = nodeDisplayState(targetNode);
      const targetTerminal = ["completed", "failed", "blocked", "cancelled", "skipped"].includes(nodeDisplayState(targetNode));
      const stageFocusState = executionRelation && snapshot.run?.active && !terminalRun && !targetTerminal && targetState === "active" ? "live" : "none";
      path.dataset.stageFocus = stageFocusState;
      path.dataset.liveFocus = stageFocusState;
      path.setAttribute("marker-end", "url(#" + edgeMarkerId(executionRelation ? (stageFocusState === "none" ? edge.status : "stage-" + stageFocusState) : "queued") + ")");
      path.setAttribute("vector-effect", "non-scaling-stroke");
      const effectGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
      effectGroup.setAttribute("class", "edge-effects");
      effectGroup.dataset.edgeId = edge.id;
      effectGroup.dataset.stageFocus = stageFocusState;
      const glow = document.createElementNS("http://www.w3.org/2000/svg", "path");
      glow.setAttribute("d", geometry.path);
      glow.setAttribute("class", "edge-flow-glow");
      glow.dataset.stageFocus = stageFocusState;
      glow.setAttribute("vector-effect", "non-scaling-stroke");
      const tracer = document.createElementNS("http://www.w3.org/2000/svg", "path");
      tracer.setAttribute("d", geometry.path);
      tracer.setAttribute("class", "edge-flow-tracer");
      tracer.dataset.stageFocus = stageFocusState;
      tracer.setAttribute("vector-effect", "non-scaling-stroke");
      effectGroup.append(glow, tracer);
      if (stageFocusState !== "none" && !reducedMotion.matches) {
        const particle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        particle.setAttribute("r", stageFocusState === "live" ? "4" : "3.5");
        particle.setAttribute("class", "edge-flow-particle");
        particle.dataset.stageFocus = stageFocusState;
        const motion = document.createElementNS("http://www.w3.org/2000/svg", "animateMotion");
        motion.setAttribute("dur", stageFocusState === "live" ? "1.35s" : "1.8s");
        motion.setAttribute("repeatCount", "indefinite");
        motion.setAttribute("path", geometry.path);
        particle.append(motion);
        effectGroup.append(particle);
      }
      edgeLayer.append(path, effectGroup);
      graphState.edgeElements.set(edge.id, path);
      graphState.edgeEffects.set(edge.id, effectGroup);
    }

    if (edgeLayer) {
      const childIds = new Set(graphEdges.map((edge) => edge.to));
      for (const rootNode of graphNodes.filter((node) => !childIds.has(node.id))) {
        const position = layout.positions.get(rootNode.id);
        if (!position) continue;
        const originX = Math.max(18, position.x - 54);
        const originY = position.y + Math.min(34, position.height / 3);
        const targetY = position.y + position.height / 2;
        const bendX = Math.max(originX + 10, position.x - 18);
        const rootPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        rootPath.setAttribute("d", "M " + originX + " " + originY + " H " + bendX + " V " + targetY + " H " + position.x);
        rootPath.setAttribute("class", "root-entry-path");
        rootPath.setAttribute("vector-effect", "non-scaling-stroke");
        const rootHalo = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        rootHalo.setAttribute("cx", String(originX));
        rootHalo.setAttribute("cy", String(originY));
        rootHalo.setAttribute("r", "18");
        rootHalo.setAttribute("class", "root-entry-halo");
        const rootDot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        rootDot.setAttribute("cx", String(originX));
        rootDot.setAttribute("cy", String(originY));
        rootDot.setAttribute("r", "6");
        rootDot.setAttribute("class", "root-entry-dot");
        edgeLayer.append(rootPath, rootHalo, rootDot);
      }
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
    const stageIconPaths = [
      "M8 1v3M8 12v3M1 8h3M12 8h3M8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
      "M1.5 4.5h5l1.4 1.5h6.6v7.5h-13Z M1.5 4.5V3h4l1.2 1.5",
      "M8 1.5 4.5 14M8 1.5 11.5 14M5.5 10h5M3 14h3M10 14h3",
      "M4 2.5 13 8 4 13.5Z",
      "M2 2h10v12H2Z M5 8l2 2 4-5",
      "M12.5 5A5 5 0 1 0 13 10M12.5 5V1.5M12.5 5H9",
      "M8 1.5 13 3.5v4.2c0 3-2 5.2-5 6.8-3-1.6-5-3.8-5-6.8V3.5Z M6 8l1.4 1.4L10.5 6",
      "M2 4c0-1.4 2.7-2.5 6-2.5s6 1.1 6 2.5-2.7 2.5-6 2.5S2 5.4 2 4Zm0 0v4c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V4M2 8v4c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V8",
    ];
    const makeStageIcon = (index) => {
      const wrap = makeElement("span", "stage-step-icon");
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 16 16");
      svg.setAttribute("aria-hidden", "true");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", stageIconPaths[index]);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "1.25");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      svg.append(path);
      wrap.append(svg);
      return wrap;
    };
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
        makeStageIcon(index),
        makeElement("span", "stage-step-copy"),
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
      top.append(makeElement("span", "evidence-kind", item.label));
      appendObservedTime(top, item.at);
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
      row.append(makeElement("span", "info-fact-label", localize(label)), makeElement("span", "info-fact-value", display(value)));
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
    const foldedAway = Number(project?.omittedSessionCount) > 0
      ? Number(project.omittedSessionCount)
      : 0;
    // A fold is reported, never silent: the read layer hides activation receipts
    // past their retention window, so the count of what it hid stays on screen.
    const appendFoldNote = () => {
      if (!foldedAway) return;
      repositorySessions?.append(makeElement(
        "p",
        "workspace-session-note",
        currentLanguage === "zh"
          ? foldedAway + " 条仅激活记录已折叠（超出保留窗口，可用 npm run meta:live:compact 归档）"
          : foldedAway + " activation-only records folded away (outside the retention window)",
      ));
    };
    const groups = sessionGroups(project?.sessions);
    if (!groups.ordered.length) {
      repositorySessions?.append(makeElement("p", "panel-empty", "No observed workspace sessions."));
      appendFoldNote();
      return;
    }
    const appendSessionRow = (parent, session) => {
      const row = makeElement("button", "workspace-child");
      row.type = "button";
      row.dataset.runId = session.runId;
      row.dataset.active = session.runId === selectedRunId ? "true" : "false";
      row.append(
        makeElement("span", "workspace-child-title", sessionDisplayTitle(session)),
        makeElement("span", "workspace-child-meta", sessionRowMeta(session)),
      );
      row.addEventListener("click", () => switchSelection(selectedProjectId, session.runId, { updateUrl: true }));
      parent?.append(row);
    };
    groups.foreground.forEach((session) => appendSessionRow(repositorySessions, session));
    if (!groups.background.length) {
      appendFoldNote();
      return;
    }

    // Background records stay one click away with their count on screen. Dropping
    // them silently is what made the repository view disagree with the session
    // list about how many runs the project has.
    const collapsed = makeElement("details", "workspace-child-group");
    const summary = makeElement("summary", "workspace-child-group-summary");
    summary.append(
      makeElement("span", "", "Background run records"),
      makeElement("span", "", String(groups.background.length)),
    );
    collapsed.append(summary);
    groups.background.forEach((session) => appendSessionRow(collapsed, session));
    repositorySessions?.append(collapsed);
    appendFoldNote();
  }

  function workspaceColumnForStatus(status) {
    if (status === "completed" || status === "skipped") return "done";
    if (status === "blocked" || status === "failed" || status === "in_doubt") return "review";
    if (status === "running") return "doing";
    return "todo";
  }

  function appendWorkspaceTag(parent, value, className = "") {
    if (!parent || !usefulNodeMeta(value)) return;
    parent.append(makeElement("span", "work-item-tag" + (className ? " " + className : ""), value));
  }

  function renderWorkspaceSessions(project, selectedSession) {
    clearChildren(workspaceSessionList);
    const sessions = project?.sessions || [];
    const visible = sessions.filter((session) => session.runId === selectedRunId || sessionIsIdentified(session)).slice(0, 24);
    if (!visible.length) {
      workspaceSessionList?.append(makeElement("p", "workspace-session-note", currentLanguage === "zh" ? "还没有保存标题和聊天标识的任务。" : "No tasks with a saved title and chat identity yet."));
      return;
    }
    visible.forEach((session) => {
      const button = makeElement("button", "workspace-session-item");
      button.type = "button";
      button.dataset.active = session.runId === selectedRunId ? "true" : "false";
      button.dataset.running = session.active ? "true" : "false";
      button.append(
        makeElement("span", "workspace-session-title", sessionDisplayTitle(session)),
        makeElement("span", "workspace-session-meta", sessionRowMeta(session)),
      );
      button.addEventListener("click", () => switchSelection(selectedProjectId, session.runId, { updateUrl: true }));
      workspaceSessionList?.append(button);
    });
    const hidden = Math.max(0, sessions.length - visible.length);
    if (hidden) workspaceSessionList?.append(makeElement("p", "workspace-session-note", currentLanguage === "zh" ? hidden + " 条无聊天信息的历史运行已隐藏" : hidden + " historical runs without chat metadata hidden"));
  }

  function renderWorkspaceBoard(snapshot) {
    clearChildren(workspaceBoard);
    const columns = [
      ["todo", currentLanguage === "zh" ? "待处理" : "To do"],
      ["doing", currentLanguage === "zh" ? "执行中" : "In progress"],
      ["review", currentLanguage === "zh" ? "审查 / 阻塞" : "Review / blocked"],
      ["done", currentLanguage === "zh" ? "已完成" : "Done"],
    ];
    const grouped = new Map(columns.map(([key]) => [key, []]));
    snapshot.nodes.forEach((node) => grouped.get(workspaceColumnForStatus(node.status))?.push(node));
    columns.forEach(([key, label]) => {
      const column = makeElement("section", "work-column");
      column.dataset.column = key;
      const header = makeElement("header", "work-column-header");
      header.append(makeElement("span", "", label), makeElement("span", "work-column-count", String(grouped.get(key).length)));
      const list = makeElement("div", "work-column-list");
      const nodes = grouped.get(key);
      if (!nodes.length) {
        const message = key === workspaceColumnForStatus(snapshot.run.status === "live" ? "running" : snapshot.run.status) && !snapshot.nodes.length
          ? (currentLanguage === "zh" ? "当前只采集到运行状态，尚无工作项明细。" : "Only run status is available; work-item telemetry has not been captured.")
          : (currentLanguage === "zh" ? "暂无工作项" : "No work items");
        list.append(makeElement("p", "work-board-empty", message));
      }
      nodes.forEach((node) => {
        const card = makeElement("button", "work-item-card");
        card.type = "button";
        card.dataset.nodeId = node.id;
        card.dataset.status = node.status;
        card.dataset.selected = node.id === selectedNodeId ? "true" : "false";
        const kicker = makeElement("span", "work-item-kicker");
        kicker.append(makeElement("span", "", node.kind || "work item"), makeElement("span", "", localize(node.status)));
        const tags = makeElement("span", "work-item-tags");
        appendWorkspaceTag(tags, node.agent, "work-item-tag-owner");
        appendWorkspaceTag(tags, node.runtime);
        appendWorkspaceTag(tags, node.latestTool, "work-item-tag-tool");
        card.append(kicker, makeElement("h3", "work-item-title", node.label), makeElement("p", "work-item-summary", node.summary), tags);
        card.addEventListener("click", () => {
          selectedNodeId = node.id;
          updateSelectedNodeVisuals();
          renderWorkspaceView(currentSnapshot);
        });
        list.append(card);
      });
      column.append(header, list);
      workspaceBoard?.append(column);
    });
  }

  function appendWorkspaceDetailRow(parent, label, value) {
    const row = makeElement("div", "workspace-detail-row");
    const labelText = display(label, "");
    // A label is structure, not observed data. An absent one used to render the
    // placeholder in the label column, so the row read as though "—" were the
    // name of the fact; drop the column instead and let the value span the row.
    if (labelText === "") row.dataset.unlabelled = "true";
    else row.append(makeElement("span", "", labelText));
    row.append(makeElement("strong", "", usefulNodeMeta(value) ? value : DISPLAY_FORMAT.emptyPlaceholder));
    parent?.append(row);
  }

  function renderWorkspaceDetail(snapshot) {
    clearChildren(workspaceDetail);
    const selected = snapshot.nodes.find((node) => node.id === selectedNodeId) || null;
    const hero = makeElement("section", "workspace-detail-hero");
    const detailTitle = selected?.label || snapshot.run.title;
    const detailSummary = selected?.summary || snapshot.run.task || (currentLanguage === "zh" ? "这条运行没有保存可读的任务说明。" : "This run did not preserve a readable task brief.");
    const tags = makeElement("div", "workspace-detail-tags");
    appendWorkspaceTag(tags, localize(selected?.status || snapshot.run.status), "work-item-tag-owner");
    appendWorkspaceTag(tags, selected?.agent || snapshot.sessionInfo?.runtime);
    appendWorkspaceTag(tags, selected?.latestTool, "work-item-tag-tool");
    hero.append(makeElement("h3", "", detailTitle), makeElement("p", "", detailSummary), tags);
    workspaceDetail?.append(hero);

    const factsSection = makeElement("section", "workspace-detail-section");
    factsSection.append(makeElement("h3", "", currentLanguage === "zh" ? "运行信息" : "Run information"));
    const facts = makeElement("div", "workspace-detail-list");
    appendWorkspaceDetailRow(facts, currentLanguage === "zh" ? "负责人" : "Owner", selected?.agent);
    appendWorkspaceDetailRow(facts, currentLanguage === "zh" ? "运行时" : "Runtime", selected?.runtime || snapshot.sessionInfo?.runtime);
    appendWorkspaceDetailRow(facts, currentLanguage === "zh" ? "当前阶段" : "Stage", informativeValue(snapshot.run.stage, "Stage unconfirmed"));
    appendWorkspaceDetailRow(facts, currentLanguage === "zh" ? "当前工具" : "Current tool", selected?.latestTool);
    appendWorkspaceDetailRow(facts, currentLanguage === "zh" ? "上级工作项" : "Depends on", selected?.parentId);
    factsSection.append(facts);
    workspaceDetail?.append(factsSection);

    const relevantEvents = (selected ? snapshot.replay.filter((event) => event.nodeId === selected.id) : snapshot.replay).slice(-8).reverse();
    const activitySection = makeElement("section", "workspace-detail-section");
    activitySection.append(makeElement("h3", "", currentLanguage === "zh" ? "最新活动" : "Latest activity"));
    const activity = makeElement("div", "workspace-detail-list");
    if (!relevantEvents.length) activity.append(makeElement("p", "panel-empty", currentLanguage === "zh" ? "尚未采集到工具、交接或评审活动。" : "No tool, handoff, or review activity has been captured."));
    relevantEvents.forEach((event) => {
      const item = makeElement("article", "workspace-activity");
      item.dataset.kind = event.kind;
      const copy = makeElement("div", "");
      const kindCopy = localize(display(event.kind, "").replaceAll("_", " "));
      const observedAt = formatTime(event.at);
      copy.append(
        makeElement("strong", "", event.label),
        makeElement("span", "", [kindCopy, observedAt].filter((part) => part !== "").join(" · ")),
      );
      item.append(copy);
      activity.append(item);
    });
    activitySection.append(activity);
    workspaceDetail?.append(activitySection);

    const linkedEvidence = selected ? snapshot.evidence.filter((item) => item.nodeId === selected.id) : snapshot.evidence;
    const outputSection = makeElement("section", "workspace-detail-section");
    outputSection.append(makeElement("h3", "", currentLanguage === "zh" ? "产出与证据" : "Outputs and evidence"));
    const outputs = makeElement("div", "workspace-detail-list");
    if (snapshot.repository.diff?.state === "observed") appendWorkspaceDetailRow(outputs, currentLanguage === "zh" ? "代码变更" : "Changes", snapshot.repository.diff.summary);
    // The projection may omit the kind while still carrying a row label.
    // Preferring the kind and falling back to the label keeps a real name in the
    // label column instead of discarding it and printing the placeholder there.
    linkedEvidence.slice(0, 6).forEach((item) => appendWorkspaceDetailRow(
      outputs,
      localize(display(usefulNodeMeta(item.kind) ? item.kind : item.label, "")),
      item.detail,
    ));
    if (!outputs.children.length) outputs.append(makeElement("p", "panel-empty", currentLanguage === "zh" ? "尚未关联交付物或验证证据。" : "No deliverable or verification evidence is linked yet."));
    outputSection.append(outputs);
    workspaceDetail?.append(outputSection);

    if (!snapshot.nodes.length || (!snapshot.replay.length && !snapshot.evidence.length)) {
      workspaceDetail?.append(makeElement("p", "workspace-telemetry-warning", currentLanguage === "zh"
        ? "这是一条旧式状态记录：只能确认运行阶段和更新时间，无法还原参与的 Agent、工具过程和产出。新运行会保存这些信息。"
        : "This is a legacy status-only record. It confirms stage and update time, but cannot reconstruct agents, tools, or outputs. New runs preserve that telemetry."));
    }
  }

  function renderWorkspaceView(snapshot) {
    const project = projectForSelection();
    const selectedSession = project?.sessions.find((session) => session.runId === selectedRunId) || null;
    const workspaceData = snapshot.workspace || {};
    const session = snapshot.sessionInfo || {};
    setText(workspaceTitle, workspaceData.name?.state === "observed" ? workspaceData.name.summary : selectedSession?.title || snapshot.run.title, "Observed workspace");
    setText(workspaceBoundary, (session.workerCount || snapshot.nodes.length) + (currentLanguage === "zh" ? " 个工作节点" : " work nodes") + " · " + localize(informativeValue(snapshot.run.stage, "Stage unconfirmed")) + " · " + stateCopy(snapshot.run.status), "Workspace telemetry unavailable");
    clearChildren(workspaceFacts);
    appendOperationalRow(workspaceFacts, "Work items", String(snapshot.nodes.length), snapshot.nodes.length ? "observed" : "unavailable");
    appendOperationalRow(workspaceFacts, "Events", String(snapshot.replay.length), snapshot.replay.length ? "observed" : "unavailable");
    renderWorkspaceSessions(project, selectedSession);
    renderWorkspaceBoard(snapshot);
    renderWorkspaceDetail(snapshot);
  }

  /**
   * One axis label, as elapsed time from the run's first replay event.
   *
   * The unit is chosen from the whole run and applied to every label, so the
   * axis reads consistently: minutes and seconds for a run under an hour, hours
   * and minutes beyond that. Both forms stay inside the label width the tick
   * budget declares, which is what keeps the last label on screen.
   */
  function formatTickOffset(offsetMs, durationMs) {
    const totalSeconds = Math.max(0, Math.round(offsetMs / 1000));
    if (durationMs >= 3600000) {
      return Math.floor(totalSeconds / 3600) + ":" + String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
    }
    return String(Math.floor(totalSeconds / 60)).padStart(2, "0") + ":" + String(totalSeconds % 60).padStart(2, "0");
  }

  /**
   * Draw the replay axis from the run's own timeline.
   *
   * The band used to carry nine labels written into the markup, so a run of any
   * length displayed the same two-minute ruler and the ninth label was clipped by
   * the band's own overflow rule. Both numbers are now resolved: the count from
   * the width the band actually has, the values from the observed first and last
   * event. Below the declared minimum the axis renders nothing, because a clipped
   * axis is worse than no axis.
   */
  function renderReplayTicks() {
    if (!replayTicks) return;
    clearChildren(replayTicks);
    const events = replayTickEvents;
    if (events.length < 2) return;
    const startedAt = new Date(display(events[0].at, ""));
    const endedAt = new Date(display(events[events.length - 1].at, ""));
    if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) return;
    const durationMs = Math.max(0, endedAt.getTime() - startedAt.getTime());
    const count = resolveReplayTickCount(replayTicks.clientWidth, REPLAY_TICK_BAND);
    resolveReplayTickOffsetsMs(durationMs, count).forEach((offsetMs) => {
      replayTicks.append(makeElement("span", "", formatTickOffset(offsetMs, durationMs)));
    });
  }

  function renderReplay(snapshot) {
    const events = snapshot.replay;
    replayTickEvents = events;
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
    renderReplayTicks();
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
      const marker = makeElement("span", "replay-event-marker");
      marker.setAttribute("aria-hidden", "true");
      marker.title = localize(event.kind.replaceAll("_", " "));
      item.append(marker);
      const observedAt = formatTime(event.at);
      if (observedAt !== "") item.append(makeElement("span", "replay-event-time", observedAt));
      item.append(makeElement("span", "replay-event-label", event.label));
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

  /**
   * Hand the reader the whole chat id. The row shows a shortened form so it fits
   * one line, which is enough to recognise a chat and not enough to open one, so
   * what gets copied is deliberately the untruncated id rather than the text on
   * screen. Silent when nothing is bound: a status line claiming a copy happened
   * would be the same uncheckable claim this row exists to remove.
   */
  async function copyChatIdentity() {
    const ref = conversationChatIdentityValue(currentSnapshot && currentSnapshot.run);
    if (ref === "") return;
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(ref);
      if (liveRegion) liveRegion.textContent = localize("Chat id copied locally.");
    } catch {
      if (liveRegion) liveRegion.textContent = localize("Chat id copy unavailable; the clipboard was not ready.");
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
    const replayView = resolveReplayNodeView({
      nodes: currentSnapshot.nodes,
      edges: currentSnapshot.edges,
      events,
      cursorIndex: currentReplayIndex,
      structuralEdgeKinds: Array.from(STRUCTURAL_EDGE_KINDS),
    });
    const visibleNodeIds = new Set(replayView.visibleNodeIds);
    nodeList?.querySelectorAll("[data-node-id]").forEach((element) => {
      const active = events[currentReplayIndex]?.nodeId && element.dataset.nodeId === events[currentReplayIndex].nodeId;
      element.dataset.replayActive = active ? "true" : "false";
      const visible = visibleNodeIds.has(element.dataset.nodeId);
      element.dataset.replayVisible = visible ? "true" : "false";
      element.setAttribute("aria-hidden", String(!visible));
      element.dataset.replayStatus = replayView.statusByNodeId[element.dataset.nodeId] || "queued";
    });
    if (events[currentReplayIndex]?.nodeId && currentSnapshot.nodes.some((node) => node.id === events[currentReplayIndex].nodeId)) {
      selectedNodeId = events[currentReplayIndex].nodeId;
      updateSelectedNodeVisuals();
      if (graphFollowing) centerGraphNode(selectedNodeId);
    }
    for (const edge of currentSnapshot.edges) {
      const path = graphState.edgeElements.get(edge.id);
      if (!path) continue;
      const effects = graphState.edgeEffects.get(edge.id);
      const edgeVisible = visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to);
      path.dataset.replayVisible = edgeVisible ? "true" : "false";
      path.style.opacity = edgeVisible ? "" : "0";
      if (effects) {
        effects.dataset.replayVisible = edgeVisible ? "true" : "false";
        effects.style.opacity = edgeVisible ? "" : "0";
      }
      let replayState = edge.status;
      let hasReplayState = false;
      for (const event of events.slice(0, currentReplayIndex + 1)) {
        if (event.nodeId === edge.to) {
          replayState = event.status;
          hasReplayState = true;
        }
      }
      if (!hasReplayState) replayState = edge.status;
      const executionRelation = EXECUTION_EDGE_KINDS.has(edge.kind || "sequence");
      path.setAttribute("class", "edge edge-" + (executionRelation ? nodeClass(replayState) : "structural"));
      const replayFocus = executionRelation && !replayFollowingLive && edgeVisible && events[currentReplayIndex]?.nodeId === edge.to
        ? "recorded"
        : executionRelation ? (path.dataset.liveFocus || "none") : "none";
      path.dataset.stageFocus = replayFocus;
      if (effects) {
        effects.dataset.stageFocus = replayFocus;
        effects.querySelectorAll("[data-stage-focus]").forEach((effect) => { effect.dataset.stageFocus = replayFocus; });
      }
      const stageMarkerState = !executionRelation
        ? "queued"
        : replayFocus === "live"
          ? "stage-live"
        : replayFocus === "recorded"
          ? "stage-recorded"
          : replayState;
      path.setAttribute("marker-end", "url(#" + edgeMarkerId(stageMarkerState) + ")");
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
          titleSource: display(session.titleSource, generatedRunTitle(session.title) ? "generated_run_id" : "unknown"),
          identificationState: display(session.identificationState, generatedRunTitle(session.title) ? "unlinked" : "descriptive"),
          conversationRef: safeIdentifier(session.conversationRef || session.threadId || session.conversationId),
          conversationTitle: display(session.conversationTitle, ""),
          conversationLinkState: display(session.conversationLinkState, session.conversationRef ? "candidate" : "unlinked").toLowerCase(),
          conversationLinkRefusal: display(session.conversationLinkRefusal, ""),
          // Rebuilt rather than passed through: the wire value is untrusted, and
          // a row only ever needs the reason. Dropping it here would leave every
          // pre-refusal record reading as if the server had sent no reason at all.
          conversationDiscovery: session.conversationDiscovery && typeof session.conversationDiscovery === "object"
            ? { state: display(session.conversationDiscovery.state, ""), reason: display(session.conversationDiscovery.reason, "") }
            : null,
          verifiedLinks: Array.isArray(session.verifiedLinks) ? session.verifiedLinks.slice(0, 16) : [],
          candidateLinks: Array.isArray(session.candidateLinks) ? session.candidateLinks.slice(0, 16) : [],
          sourceRuntime: safeIdentifier(session.sourceRuntime) || "unknown",
          status: display(session.status, "observed"),
          // The catalog judges a record once and ships the verdict. Dropping it
          // here would leave the row re-deriving an outcome from a raw status the
          // server already decided was not the whole story.
          displayState: display(session.displayState, ""),
          currentStage: display(session.currentStage),
          runtime: display(session.runtime, "local"),
          updatedAt: display(session.updatedAt, ""),
          // Kept beside the value it qualifies: a row that drops this shows a
          // file's write time and a run's own report as the same bare chip.
          updatedAtBasis: display(session.updatedAtBasis, ""),
          startedAt: display(session.startedAt, ""),
          activity: display(firstValue(session, ["activity", "latestActivity", "summary"], session.currentStage)),
          workerCount: nullableCountOf(session, ["workerCount", "agentCount", "nodeCount"]),
          eventCount: nullableCountOf(session, ["eventCount", "totalEvents"]),
          substanceClass: display(session.substanceClass, "unclassified"),
          // Kept as its own field even though workerCount already folds it in:
          // a measured node count is the strongest drawability signal the default
          // choice has, and collapsing it into a display counter left the client
          // ordering blind to the one fact that decides whether a graph exists.
          nodeCount: nullableCountOf(session, ["nodeCount"]),
          recordOrigin: sessionRecordOrigin(session),
          active: session.active === true,
        };
      }).filter(Boolean);
      return {
        projectId,
        displayName: display(project.displayName, "Meta_Kim project"),
        status: display(project.status, "observed"),
        activeSessionId: safeIdentifier(project.activeSessionId),
        sessionCount: Number.isFinite(Number(project.sessionCount)) ? Number(project.sessionCount) : sessions.length,
        omittedSessionCount: Number.isFinite(Number(project.omittedSessionCount))
          ? Math.max(0, Number(project.omittedSessionCount))
          : 0,
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
    // The catalog order is the same question the default view answers, so it runs
    // through the same policy. The inline "active first, then newest" comparator
    // this replaces is the exact ordering that policy rejects: it put a project
    // whose only activity was an activation receipt above one holding real runs.
    const ranked = projects
      .map((project) => projectSelectionRow(project, DEFAULT_SELECTION))
      .sort((left, right) => compareSelectionRows(left, right, DEFAULT_SELECTION))
      .map((row) => row.project);
    return { projects: ranked, selected };
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
      // A notice row states what the list withholds. It carries no value, so
      // selecting it cannot navigate anywhere and cannot become a run id.
      if (item.selectable === false) {
        option.disabled = true;
        option.value = "";
      } else if (item.value === selectedValue) option.selected = true;
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
        label: projectOptionLabel(project),
      })),
      selectedProjectId,
      "No registered projects",
    );
  }

  function populateSessionSelect() {
    const project = projectForSelection();
    const sessions = project?.sessions || [];
    const selectedSession = sessions.find((session) => session.runId === selectedRunId);
    const selectableSessions = sessions.filter(sessionIsIdentified);
    if (selectedSession && !selectableSessions.some((session) => session.runId === selectedSession.runId)) {
      selectableSessions.unshift(selectedSession);
    }
    const withheld = projectRunTally(project).unopenable;
    replaceSelectOptions(
      sessionSelect,
      [
        ...selectableSessions.map((session) => ({
          value: session.runId,
          label: (session.runId === selectedRunId && !sessionIsIdentified(session) ? (currentLanguage === "zh" ? "当前运行 · " : "Current run · ") : session.active ? "Live · " : "")
            + formatSessionTime(session.updatedAt)
            + " · " + sessionDisplayTitle(session)
            + " · " + localize(informativeValue(session.currentStage, "Stage unconfirmed"))
            + (session.workerCount === null ? "" : " · " + localize(session.workerCount + " workers"))
            + (session.eventCount === null ? "" : " · " + localize(session.eventCount + " events"))
            + " · " + sessionShortId(session),
        })),
        ...(projectRunTally(project).unopenable
          ? [{ value: "", selectable: false, label: unopenableRunNoticeLabel(projectRunTally(project).unopenable) }]
          : []),
      ],
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
    const query = sessionSearchQuery.trim().toLocaleLowerCase();
    const matchingSessions = sessions.filter((session) => !query || [
      session.title,
      session.runId,
      session.currentStage,
      session.status,
      session.runtime,
      session.sourceRuntime,
      session.conversationTitle,
      session.conversationRef,
      formatSessionTime(session.updatedAt),
    ].join(" ").toLocaleLowerCase().includes(query));
    if (!matchingSessions.length) {
      sessionList.append(makeElement("p", "panel-empty", currentLanguage === "zh" ? "没有找到匹配的运行记录" : "No matching run records"));
      return;
    }
    const orderedSessions = sessionGroups(matchingSessions).ordered;
    const identifiedSessions = orderedSessions.filter(sessionIsForeground);
    const unlinkedSessions = orderedSessions.filter((session) => !sessionIsForeground(session));
    const shouldShowUnlinked = Boolean(query) || showUnlinkedSessions;
    const visibleSessions = [...identifiedSessions, ...(shouldShowUnlinked ? unlinkedSessions : [])].slice(0, 64);
    if (!identifiedSessions.length && unlinkedSessions.length && !shouldShowUnlinked) {
      const empty = makeElement("section", "session-identity-empty");
      empty.append(
        makeElement("strong", "", currentLanguage === "zh" ? "还没有可识别的聊天记录" : "No identifiable chat records yet"),
        makeElement("p", "", currentLanguage === "zh"
          ? "这些运行要么只登记了启动，要么没有保存聊天标题和会话标识，因此无法按标题告诉你对应的是哪次聊天。"
          : "These runs either only recorded an activation or did not preserve a chat title and conversation identifier, so they cannot be located by title."),
      );
      const reveal = makeElement("button", "session-unlinked-toggle", currentLanguage === "zh"
        ? "仍要查看 " + unlinkedSessions.length + " 条次要运行记录"
        : "Show " + unlinkedSessions.length + " background run records anyway");
      reveal.type = "button";
      reveal.dataset.liveShowUnlinked = "true";
      reveal.addEventListener("click", () => {
        showUnlinkedSessions = true;
        renderSessionCards(sessions);
      });
      empty.append(reveal);
      sessionList.append(empty);
      return;
    }
    let lastGroup = "";
    visibleSessions.forEach((session) => {
      const group = sessionIsForeground(session) ? "identified" : "unlinked";
      if (!query && group !== lastGroup) {
        const groupHeading = makeElement("div", "session-group-heading");
        groupHeading.append(
          makeElement("strong", "", group === "identified"
            ? (currentLanguage === "zh" ? "可识别的聊天 / 任务" : "Identified chats / tasks")
            : "Background run records"),
          makeElement("span", "", group === "identified"
            ? (currentLanguage === "zh" ? "可按标题定位" : "Locate by title")
            : "Activation only, or no chat link"),
        );
        sessionList.append(groupHeading);
        lastGroup = group;
      }
      const card = makeElement("button", "session-card");
      card.type = "button";
      card.dataset.runId = session.runId;
      card.dataset.active = session.runId === selectedRunId ? "true" : "false";
      card.dataset.identity = group;
      card.dataset.recordOrigin = sessionRecordOrigin(session);
      const heading = makeElement("span", "session-card-title", sessionDisplayTitle(session));
      const sourceLabel = sourceRuntimeLabel(session.sourceRuntime);
      const activity = makeElement("span", "session-card-activity", sourceLabel + " · " + conversationLinkCopyFor(session));
      activity.dataset.linkState = session.conversationLinkState;
      const originCopy = sessionOriginCopy(session);
      const facts = makeElement("span", "session-card-facts");
      // The tool name and the link verdict already sit in the activity line above.
      // Repeating them here printed both twice on all 21 measured cards, so the
      // row carries the chat id instead — the one fact that line cannot show, and
      // the only thing that makes a verified verdict checkable rather than a claim.
      const chatIdentity = conversationChatIdentityCopy(session);
      const timeCopy = sessionTimeCopy(session);
      const timeFact = makeElement("span", "", timeCopy.text);
      timeFact.title = timeCopy.hint;
      facts.append(
        timeFact,
        makeElement("span", "", (currentLanguage === "zh" ? "运行 ID " : "Run ID ") + sessionShortId(session)),
        makeElement("span", "", localize(informativeValue(session.currentStage, "Stage unconfirmed"))),
        makeElement("span", "", session.workerCount === null ? "No worker report" : session.workerCount + " workers"),
        makeElement("span", "", session.eventCount === null ? "No event report" : session.eventCount + " events"),
      );
      if (chatIdentity) {
        // The card is itself a button, so the id cannot host a second control
        // here. It carries the whole value on the element instead: hover and
        // selection reach it, and the run header keeps the control that copies it.
        const chatFact = makeElement("span", "", chatIdentity);
        chatFact.dataset.chatId = conversationChatIdentityValue(session);
        chatFact.title = chatFact.dataset.chatId;
        facts.append(chatFact);
      }
      card.append(heading, activity);
      if (originCopy) card.append(makeElement("span", "session-card-origin", originCopy));
      card.append(facts);
      card.addEventListener("click", () => switchSelection(selectedProjectId, session.runId, { updateUrl: true }));
      sessionList.append(card);
    });
    if (unlinkedSessions.length && !shouldShowUnlinked) {
      const reveal = makeElement("button", "session-unlinked-toggle", currentLanguage === "zh"
        ? "另有 " + unlinkedSessions.length + " 条只登记了启动或没有聊天关联的运行记录（默认收起）"
        : unlinkedSessions.length + " runs that only recorded an activation or have no chat link, hidden by default");
      reveal.type = "button";
      reveal.dataset.liveShowUnlinked = "true";
      reveal.addEventListener("click", () => {
        showUnlinkedSessions = true;
        renderSessionCards(sessions);
      });
      sessionList.append(reveal);
    } else if (unlinkedSessions.length && showUnlinkedSessions && !query) {
      const hide = makeElement("button", "session-unlinked-toggle", currentLanguage === "zh" ? "收起这些运行记录" : "Hide these runs");
      hide.type = "button";
      hide.addEventListener("click", () => {
        showUnlinkedSessions = false;
        renderSessionCards(sessions);
      });
      sessionList.append(hide);
    }
    if (matchingSessions.length > visibleSessions.length) {
      sessionList.append(makeElement(
        "p",
        "panel-empty",
        currentLanguage === "zh"
          ? "显示最近 " + visibleSessions.length + "/" + matchingSessions.length + " 条运行记录"
          : "Showing the newest " + visibleSessions.length + " of " + matchingSessions.length + " run records",
      ));
    }
  }

  // An explicit runId still wins, because a shared link has to land where it
  // points. Everything else defers to the shared ordering: the previous chain
  // read project.activeSessionId first, and the hub derives that field from
  // sessions.find((session) => session.active), so the liveness term the policy
  // already ranks below drawability was silently overriding it here.
  function defaultSessionFor(project, preferredRunId = "") {
    if (!project) return "";
    if (preferredRunId && project.sessions.some((session) => session.runId === preferredRunId)) return preferredRunId;
    const row = pickDefaultRow(
      project.sessions.map((session) => sessionSelectionRow(session)),
      DEFAULT_SELECTION,
    );
    return row?.identity || "";
  }

  function setHubStatus(message) {
    setText(hubStatus, message, "Local project catalog");
  }

  function disconnectEvents() {
    if (eventSource) eventSource.close();
    eventSource = null;
  }

  let hiddenSuspendTimer = null;

  document.addEventListener("visibilitychange", () => {
    // A browser allows about six connections per origin and an open stream holds
    // one for the life of its tab, so tabs left in the background were spending
    // the allowance the foreground page needed to fetch its first snapshot. A
    // stream nobody is looking at is given back; the grace period exists because
    // switching away and straight back should not cost a reconnect and a refetch.
    if (hiddenSuspendTimer !== null) {
      window.clearTimeout(hiddenSuspendTimer);
      hiddenSuspendTimer = null;
    }
    if (document.hidden) {
      hiddenSuspendTimer = setTimeout(() => {
        hiddenSuspendTimer = null;
        if (!document.hidden) return;
        disconnectEvents();
        updateConnection("stale", "Paused while hidden");
      }, STREAM_POLICY.hiddenSuspendGraceMs);
      return;
    }
    if (unloading) return;
    // The poll that maintains the run list skips every tick while the page is
    // hidden, and Chrome calls a tab hidden whenever its window sits behind
    // another one, so coming back to the window is the only catch-up there is.
    // It runs before the stream check because switching away and straight back
    // keeps the stream and would otherwise take that early return — leaving the
    // list stale for exactly the person who just looked at it.
    void loadProjectCatalog({ refresh: true });
    if (!selectedRunId || eventSource) return;
    // Order matters: the reconnect reports itself open before the snapshot that
    // replaces the pre-pause graph arrives, so the catch-up is marked first and
    // the badge stays honest until something paints.
    beginPauseCatchUp();
    connectEvents();
    scheduleSnapshotUpdate();
  });

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
    setHubStatus(project.displayName + " · " + project.sessions.length + " observed run records");
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
          setHubStatus(currentProject.displayName + " · " + currentProject.sessions.length + " observed run records");
          return true;
        }
      }
      const requested = selectionFromLocation();
      const preferredProjectId = requested.projectId || catalog.selected.projectId;
      const project = pickDefaultRow(
        projectCatalog.map((item) => projectSelectionRow(item, DEFAULT_SELECTION)),
        DEFAULT_SELECTION,
        preferredProjectId,
      )?.project || null;
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
    // Any paint ends the catch-up: every branch below writes the badge from what
    // it actually put on screen, so holding the flag past this point would keep
    // suppressing the badge for the rest of the page's life.
    catchingUpAfterPause = false;
    const selectedSession = projectForSelection()?.sessions.find((session) => session.runId === selectedRunId) || null;
    const inputRun = input?.run && typeof input.run === "object" && !Array.isArray(input.run) ? input.run : null;
    const genericTitle = generatedRunTitle(inputRun?.title);
    const genericTask = generatedRunTitle(inputRun?.task);
    const enrichedInput = selectedSession && input && typeof input === "object" && !Array.isArray(input)
      ? {
          ...input,
          run: {
            ...(inputRun || {}),
            title: genericTitle ? sessionDisplayTitle(selectedSession) : inputRun?.title,
            task: genericTask && !sessionIsIdentified(selectedSession)
              ? (currentLanguage === "zh"
                  ? "这条运行记录没有保存聊天标题或首条用户消息，只能按时间和运行 ID 定位。"
                  : "This run did not preserve a chat title or first user message; locate it by time and run ID.")
              : inputRun?.task,
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
    if (!selectedNodeId || !snapshot.nodes.some((node) => node.id === selectedNodeId)) {
      selectedNodeId = snapshot.nodes.find((node) => node.status === "running")?.id || snapshot.nodes[0]?.id || null;
    }
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
      setInspectorOpen(false);
      const establishInitialCamera = () => {
        fitGraph();
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

  function beginPauseCatchUp() {
    catchingUpAfterPause = true;
    updateConnection("stale", "Catching up after pause");
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
    // Coalescing absorbs bursts of stream events, which arrive faster than anyone
    // can read them. A catch-up has no burst to absorb — one refetch, then the
    // payload it returns — and someone is watching the badge, so both of those
    // hops skip the window. An already-armed timer is left to fire into a drained
    // queue rather than cancelled, which costs one no-op callback.
    if (catchingUpAfterPause) {
      flushSnapshotUpdate();
      return;
    }
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
    // Two different reasons abort this controller and both surface as AbortError,
    // so the reason is recorded before the abort. A superseded request must stay
    // silent because a newer selection is already painting; a timed-out request
    // must replace the loading copy, because nothing else will.
    const snapshotRequestController = abortController;
    let snapshotTimedOut = false;
    const snapshotRequestTimer = setTimeout(() => {
      snapshotTimedOut = true;
      snapshotRequestController.abort();
    }, STREAM_POLICY.snapshotRequestTimeoutMs);
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
      // A catch-up that failed is over. The badge below is written from the
      // failure, which is honest about the pre-pause graph still being on screen,
      // and leaving the flag set would suppress every later live report.
      catchingUpAfterPause = false;
      if (snapshotTimedOut) {
        updateConnection("stale", "Reconnecting");
        // A background refresh that times out while a snapshot is on screen must
        // leave it there: stale content plus a stale badge is more use than a
        // blank panel. The message is for the case that has nothing to keep.
        if (!currentSnapshot) {
          showEmpty("The snapshot request timed out. Other open control room tabs hold this origin's connections. Close one, or wait for them to release.");
        }
        return;
      }
      if (error?.name === "AbortError") return;
      updateConnection("stale", "Reconnecting");
      if (!silent) showEmpty("The local observer is not serving a snapshot yet.");
    } finally {
      clearTimeout(snapshotRequestTimer);
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
        if (generation !== selectionGeneration) return;
        // The stream is genuinely open, but during a catch-up the graph under the
        // badge is still the pre-pause one. Whatever paints next owns the badge.
        if (catchingUpAfterPause) return;
        updateConnection("live", "Streaming");
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
  app.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (evidencePanel?.dataset.open !== "true" || evidencePanel.contains(target)) return;
    if (target?.closest?.("[data-node-id], [data-evidence-toggle]")) return;
    setInspectorOpen(false);
  });
  app.querySelector("[data-live-open-sessions]")?.addEventListener("click", () => setDialogOpen(sessionsDialog, true));
  workspaceOpenSessions?.addEventListener("click", () => setDialogOpen(sessionsDialog, true));
  workspaceOpenRunMap?.addEventListener("click", () => setWorkView("run", { focus: true }));
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
  app.querySelector("[data-live-graph-live]")?.addEventListener("click", () => {
    setCameraMode("follow");
    centerGraphNode(selectedNodeId || currentSnapshot?.replay[currentReplayIndex]?.nodeId || currentSnapshot?.nodes.find((node) => node.status === "running")?.id);
  });
  app.querySelector("[data-live-graph-reset]")?.addEventListener("click", fitGraph);
  app.addEventListener("keydown", (event) => {
    trapDialogFocus(event);
    if (event.defaultPrevented) return;
    const target = event.target;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
    if (event.key === "Escape") {
      const hadOpenDialog = Boolean(activeDialog);
      event.preventDefault();
      closeTransientUi();
      selectedNodeId = null;
      updateSelectedNodeVisuals();
      setInspectorOpen(false);
      if (!hadOpenDialog) document.activeElement?.blur?.();
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
  contextChatCopy?.addEventListener("click", () => void copyChatIdentity());
  app.querySelector("[data-live-language-toggle]")?.addEventListener("click", () => {
    currentLanguage = currentLanguage === "zh" ? "en" : "zh";
    try { window.localStorage?.setItem(LANGUAGE_STORAGE_KEY, currentLanguage); } catch {}
    window.location.reload();
  });
  projectSelect?.addEventListener("change", () => {
    showUnlinkedSessions = false;
    void switchSelection(projectSelect.value, "", { updateUrl: true });
  });
  sessionSelect?.addEventListener("change", () => {
    void switchSelection(selectedProjectId, sessionSelect.value, { updateUrl: true });
  });
  sessionSearch?.addEventListener("input", () => {
    sessionSearchQuery = display(sessionSearch.value, "").slice(0, 120);
    renderSessionCards(projectForSelection()?.sessions || []);
  });
  bindRovingTabs(workViewTabs, WORK_VIEWS, setWorkView);
  bindRovingTabs(inspectorTabs, INSPECTOR_TABS, setInspectorTab);

  app.querySelector("[data-live-graph-fit]")?.addEventListener("click", fitGraph);
  app.querySelector("[data-live-graph-zoom-in]")?.addEventListener("click", () => zoomGraph(GRAPH_CAMERA.zoomInFactor));
  app.querySelector("[data-live-graph-zoom-out]")?.addEventListener("click", () => zoomGraph(GRAPH_CAMERA.zoomOutFactor));
  app.querySelector("[data-live-graph-layout]")?.addEventListener("click", () => {
    layoutMode = layoutMode === "flow" ? "compact" : "flow";
    if (currentSnapshot) {
      renderGraph(currentSnapshot);
      fitGraph();
    }
  });
  graph?.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (graphToolsDrag) return;
    if (target?.closest?.("[data-node-id], button, .graph-canvas-tools")) return;
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
    if (event.target?.closest?.(".graph-canvas-tools")) return;
    event.preventDefault();
    setCameraMode("manual");
    const rect = graph.getBoundingClientRect();
    const factor = event.deltaY < 0 ? GRAPH_CAMERA.wheelZoomInFactor : GRAPH_CAMERA.wheelZoomOutFactor;
    zoomGraph(factor, event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });
  graphToolsHandle?.addEventListener("pointerdown", (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    const origin = graphToolsPosition || graphToolsStagePoint();
    graphToolsDrag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      originX: origin.x,
      originY: origin.y,
      moved: false,
    };
    if (graphTools) graphTools.dataset.dragging = "true";
    graphToolsHandle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    graphToolsHandle.focus?.();
  });
  graphToolsHandle?.addEventListener("pointermove", (event) => {
    if (!graphToolsDrag || graphToolsDrag.pointerId !== event.pointerId) return;
    const dx = event.clientX - graphToolsDrag.x;
    const dy = event.clientY - graphToolsDrag.y;
    if (!graphToolsDrag.moved && Math.abs(dx) + Math.abs(dy) < GRAPH_TOOLS_DRAG_THRESHOLD) return;
    graphToolsDrag = { ...graphToolsDrag, moved: true };
    moveGraphTools({ x: graphToolsDrag.originX + dx, y: graphToolsDrag.originY + dy }, { persist: false });
  });
  const stopGraphToolsDrag = (event) => {
    if (!graphToolsDrag || (event.pointerId !== undefined && graphToolsDrag.pointerId !== event.pointerId)) return;
    graphToolsHandle?.releasePointerCapture?.(graphToolsDrag.pointerId);
    const dragged = graphToolsDrag.moved;
    graphToolsDrag = null;
    graphToolsClickEndsDrag = dragged;
    if (graphTools) graphTools.dataset.dragging = "false";
    if (dragged && graphToolsPosition) persistStoredPoint(GRAPH_TOOLS_STORAGE_KEY, graphToolsPosition);
  };
  graphToolsHandle?.addEventListener("pointerup", stopGraphToolsDrag);
  graphToolsHandle?.addEventListener("pointercancel", stopGraphToolsDrag);
  graphToolsHandle?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (graphToolsClickEndsDrag) {
      graphToolsClickEndsDrag = false;
      return;
    }
    dockGraphTools();
  });
  graphToolsHandle?.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? GRAPH_TOOLS_KEYBOARD_STEP * 3 : GRAPH_TOOLS_KEYBOARD_STEP;
    const nudges = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const nudge = nudges[event.key];
    if (nudge) {
      event.preventDefault();
      nudgeGraphTools(nudge[0], nudge[1]);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      dockGraphTools();
    }
  });
  /**
   * The eight-stage rail is a disclosure widget whose expanded height competes
   * with the graph canvas. Its default state is resolved from the same measured
   * chrome budget the viewport contract asserts, so a short viewport never opens
   * with the run's shape pushed off-screen. An explicit user toggle wins for the
   * rest of the session and is deliberately not persisted: a stored preference
   * would reintroduce the too-small canvas on the next visit to a short display.
   */
  const stageOverview = app.querySelector("details.stage-overview");
  const viewportBudget = ${VIEWPORT_BUDGET_LITERAL};
  let stageRailUserChoice = null;
  let stageRailBudgetState = null;

  function applyStageRailBudget() {
    if (!stageOverview || stageRailUserChoice !== null) return;
    const next = window.innerHeight >= viewportBudget.stageOverviewOpenMinViewportHeightPx;
    stageRailBudgetState = next;
    if (stageOverview.open === next) return;
    stageOverview.open = next;
    reconcileCamera();
  }

  stageOverview?.addEventListener("toggle", () => {
    if (stageOverview.open === stageRailBudgetState) return;
    stageRailUserChoice = stageOverview.open;
    reconcileCamera();
  });
  applyStageRailBudget();

  window.addEventListener("resize", () => {
    applyStageRailBudget();
    reconcileCamera();
    renderReplayTicks();
  }, { passive: true });
  if (window.ResizeObserver && graph) {
    const graphResizeObserver = new ResizeObserver(() => reconcileCamera());
    graphResizeObserver.observe(graph);
    window.addEventListener("beforeunload", () => graphResizeObserver.disconnect(), { once: true });
  }
  // The axis label count depends on the band's own width, which changes when the
  // drawer is disclosed as well as when the window resizes. Observing the band
  // covers both without a second code path, and appending labels does not change
  // the band's box, so this cannot feed itself.
  if (window.ResizeObserver && replayTicks) {
    const tickResizeObserver = new ResizeObserver(() => renderReplayTicks());
    tickResizeObserver.observe(replayTicks);
    window.addEventListener("beforeunload", () => tickResizeObserver.disconnect(), { once: true });
  }

  applyLanguage();
  for (const panel of app.querySelectorAll(".share-panel, .control-panel")) infoTools?.append(panel);
  currentWorkView = safeStoredChoice(WORK_VIEW_STORAGE_KEY, WORK_VIEWS, "run");
  graphToolsPosition = safeStoredPoint(GRAPH_TOOLS_STORAGE_KEY);
  applyGraphToolsPosition();
  setWorkView(currentWorkView, { persist: false });
  setInspectorTab("summary");
  setCameraMode("overview");
  setInspectorOpen(false);
  closeTransientUi();
  const snapshotText = initialElement?.textContent?.trim();
  if (demoMode === "states") {
    renderSnapshot(buildStateDemoSnapshot());
    setHubStatus(currentLanguage === "zh" ? "演示数据 · 不连接真实项目或聊天" : "Demo data · not connected to a real project or chat");
    updateConnection("live", "State demo");
  } else if (snapshotText && snapshotText !== "null") {
    try {
      renderSnapshot(JSON.parse(snapshotText));
    } catch {
      showEmpty("The embedded snapshot could not be read.");
    }
  } else {
    showEmpty("Waiting for a run snapshot");
  }
  if (!demoMode) void (async () => {
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

const GRAPH_FIRST_CSS = String.raw`
:root { color-scheme: dark; --ink: #0b0e14; --panel: #111620; --panel-2: #151b26; --completion: #68a4ff; --completion-bright: #a7c7ff; --accent: #4fd1c5; --running: #4fd1c5; --green: #63ca9b; --amber: #d8a84e; --dim: #606b7d; --line-soft: #1d2634; --line: #273043; --line-strong: #3a465c; --text: #e8edf5; --muted: #929db0; --danger: #df7a8f; --radius-sm: 7px; --radius: 11px; --clamp-lines-title: 2; --clamp-lines-hero: 3; ${TYPOGRAPHY_TOKENS} ${SPACING_TOKENS} ${CAMERA_LEGIBILITY_TOKENS} ${CHROME_BUDGET_TOKENS} ${DOCK_BUDGET_TOKENS} font-family: "Segoe UI Variable Text", "Segoe UI", Inter, ui-sans-serif, system-ui, sans-serif; }
* { box-sizing: border-box; }
html, body { width: 100%; min-width: 0; height: 100%; margin: 0; overflow: hidden; background: var(--ink); color: var(--text); }
body { font-size: var(--fs-body); letter-spacing: 0; }
button, select, input { font: inherit; }
button { color: inherit; }
[hidden] { display: none !important; }
.skip-link { position: fixed; z-index: 100; top: .5rem; left: .5rem; transform: translateY(-160%); padding: var(--sp-cozy) var(--sp-default); border-radius: var(--radius); background: var(--completion); color: #07101f; }
.skip-link:focus { transform: none; }
.sr-only { position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important; margin: -1px !important; overflow: hidden !important; clip: rect(0,0,0,0) !important; white-space: nowrap !important; border: 0 !important; }
.shell { height: 100dvh; min-width: 0; display: grid; grid-template-rows: 60px minmax(0, 1fr); background: var(--ink); }
.topbar { min-width: 0; display: flex; align-items: center; gap: var(--sp-roomy); padding: 0 var(--sp-section); border-bottom: 1px solid var(--line); background: #0d121b; }
.brand { flex: 0 0 auto; display: flex; align-items: center; gap: var(--sp-cozy); }
.brand-mark { display: block; width: 30px; height: 30px; object-fit: contain; background: transparent; border-radius: 0; box-shadow: none; filter: brightness(0) saturate(100%) invert(87%) sepia(29%) saturate(1025%) hue-rotate(120deg) brightness(96%) contrast(90%); }
.brand-title { margin: 0; font-size: var(--fs-view-title); font-weight: 720; line-height: var(--lh-display); letter-spacing: .01em; }
.top-run-context { min-width: 0; display: flex; align-items: center; gap: var(--sp-cozy); color: var(--muted); font-size: var(--fs-body); }
.top-run-context strong { min-width: 0; max-width: min(40vw, 560px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-weight: 600; }
.work-view-switcher { flex: 0 0 auto; display: inline-grid; grid-template-columns: repeat(3, minmax(0,1fr)); padding: var(--sp-hairline); border: 1px solid var(--line); border-radius: 8px; background: #0b1018; }
.work-view-tab { min-width: 92px; min-height: 34px; padding: 0 var(--sp-default); border: 0; border-right: 1px solid var(--line-soft); background: transparent; color: var(--muted); font-size: var(--fs-body); cursor: pointer; }
.work-view-tab:last-child { border-right: 0; }
.work-view-tab[aria-selected="true"] { border-radius: var(--radius-sm); background: rgba(88,212,207,.08); color: var(--accent); box-shadow: inset 0 -2px 0 var(--accent); }
.work-view-tab:focus-visible, .inspector-tabs button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.topbar-actions { margin-left: auto; display: flex; align-items: center; gap: var(--sp-snug); }
.connection { display: flex; align-items: center; gap: var(--sp-snug); min-width: 0; margin-right: var(--sp-tight); color: var(--muted); font-size: var(--fs-label); white-space: nowrap; }
.connection span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.connection-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dim); }
.connection-dot[data-connection="live"] { background: var(--green); box-shadow: 0 0 8px rgba(118,184,141,.42); }
.connection-dot[data-connection="stale"] { background: var(--completion); }
.topbar-button, .graph-tool-button, .replay-button { min-height: 30px; border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent; color: var(--muted); cursor: pointer; }
.ui-icon, .empty-state-icon { width: 1rem; height: 1rem; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.topbar-button { padding: 0 var(--sp-cozy); font-size: var(--fs-body); }
.topbar-button:hover, .topbar-button:focus-visible, .graph-tool-button:hover, .graph-tool-button:focus-visible, .replay-button:hover, .replay-button:focus-visible { border-color: rgba(88,212,207,.5); background: rgba(88,212,207,.06); color: var(--accent); outline: none; }
.main { min-width: 0; min-height: 0; overflow: hidden; display: grid; grid-template-rows: auto minmax(0, 1fr); }
.run-context { min-width: 0; display: grid; grid-template-columns: minmax(min(100%, 18rem), 1fr) auto auto; align-items: center; gap: var(--sp-section); padding: var(--sp-default) var(--sp-section); border-bottom: 1px solid var(--line); background: #0f141d; }
.run-context-heading { min-width: 0; }
.context-kicker { display: block; margin-bottom: var(--sp-tight); color: var(--completion); font-size: var(--fs-label); line-height: var(--lh-flat); font-family: monospace; text-transform: uppercase; letter-spacing: .08em; }
.run-context-title { min-width: 0; margin: 0; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: var(--clamp-lines-hero); overflow: hidden; color: var(--text); font-size: var(--fs-hero); font-weight: 730; line-height: var(--lh-snug); overflow-wrap: anywhere; }
.run-context-task { min-width: 0; margin: var(--sp-cozy) 0 0; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: var(--clamp-lines-title); overflow: hidden; color: var(--muted); font-size: var(--fs-entity-body); line-height: var(--lh-normal); white-space: normal; overflow-wrap: anywhere; }
.run-context-facts { min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-cozy) var(--sp-section); padding-left: var(--sp-section); border-left: 1px solid var(--line); }
.context-fact { min-width: 0; display: flex; align-items: baseline; gap: var(--sp-cozy); }
.context-fact span, .run-context-source span { color: var(--muted); font-size: var(--fs-label); line-height: var(--lh-flat); font-family: monospace; text-transform: uppercase; }
.context-fact strong { min-width: 0; color: var(--text); font-weight: 650; font-size: var(--fs-body); line-height: var(--lh-snug); font-family: monospace; overflow-wrap: anywhere; }
.context-fact-copy { min-width: 0; padding: 0; border: 0; border-bottom: 1px dashed var(--line-strong); background: none; color: var(--text); font-weight: 650; font-size: var(--fs-body); line-height: var(--lh-snug); font-family: monospace; overflow-wrap: anywhere; cursor: pointer; }
.context-fact-copy:hover, .context-fact-copy:focus-visible { border-bottom-color: var(--accent); color: var(--accent); outline: none; }
.run-context-source { min-width: 0; display: flex; align-items: baseline; gap: var(--sp-cozy); padding-left: var(--sp-section); border-left: 1px solid var(--line); }
.run-context-source strong { min-width: 0; color: var(--muted); font-size: var(--fs-label); line-height: var(--lh-flat); font-family: monospace; overflow-wrap: anywhere; }
.workspace-grid { position: relative; min-width: 0; min-height: 0; height: 100%; display: grid; grid-template-columns: minmax(0, 1fr) 0; overflow: hidden; transition: grid-template-columns .18s ease; }
.workspace-grid[data-work-view="repository"], .workspace-grid[data-work-view="workspace"] { grid-template-columns: minmax(0,1fr) 0; }
.work-surface-view { min-width: 0; min-height: 0; overflow: auto; background: #0f1623; }
.work-surface-header { min-width: 0; display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-roomy); padding: var(--sp-roomy) var(--sp-section); border-bottom: 1px solid var(--line); background: #101725; }
.work-surface-header h2 { margin: 0; color: var(--text); font-size: var(--fs-view-title); }
.work-surface-header p { max-width: 72ch; margin: var(--sp-snug) 0 0; overflow-wrap: anywhere; color: var(--muted); font-size: var(--fs-entity-body); line-height: var(--lh-normal); font-family: monospace; }
.surface-state { flex: 0 0 auto; padding: var(--sp-tight) var(--sp-snug); border: 1px solid #385275; border-radius: var(--radius-sm); color: var(--completion-bright); background: rgba(91,140,255,.08); font-size: var(--fs-label); line-height: var(--lh-flat); font-family: monospace; text-transform: uppercase; }
.repository-view { display: grid; grid-template-rows: auto minmax(0, 1fr); }
.repository-layout { display: grid; grid-template-columns: minmax(260px,.72fr) minmax(0,1.28fr); min-height: 0; }
.operational-section { --section-inline: var(--sp-section); min-width: 0; padding: var(--sp-roomy) var(--section-inline); }
.operational-section + .operational-section { border-left: 1px solid var(--line); }
.operational-section h3 { margin: 0 0 var(--sp-default); color: var(--muted); font-weight: 600; font-size: var(--fs-label); line-height: var(--lh-flat); font-family: monospace; text-transform: uppercase; }
.operational-list { border-top: 1px solid var(--line); }
.operational-row { min-width: 0; display: grid; grid-template-columns: minmax(92px,.4fr) minmax(0,1fr); gap: var(--sp-default); align-items: center; padding: var(--sp-default) 0; border-bottom: 1px solid var(--line); }
.operational-label { color: var(--muted); font-size: var(--fs-label); }
.operational-value { min-width: 0; overflow-wrap: anywhere; color: var(--text); font-size: var(--fs-body); font-weight: 600; }
.operational-row[data-state="unavailable"] .operational-value { color: #777; font-weight: 500; }
.operational-row[data-state="planned"] .operational-value { color: var(--completion-bright); }
.workspace-children { display: grid; margin-inline: calc(var(--section-inline, 0px) * -1); border-top: 1px solid var(--line); }
.workspace-child { min-width: 0; display: grid; gap: var(--sp-cozy); padding: var(--sp-default) var(--section-inline, 0px); text-align: left; border: 0; border-bottom: 1px solid var(--line); background: transparent; color: inherit; }
.workspace-child:hover, .workspace-child[data-active="true"] { background: rgba(88,212,207,.05); box-shadow: inset 3px 0 0 var(--accent); }
.workspace-child:focus-visible { background: rgba(88,212,207,.05); outline: 2px solid var(--accent); outline-offset: -2px; }
.workspace-child-title { overflow: hidden; color: var(--text); font-size: var(--fs-entity-title); font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.workspace-child-meta { overflow: hidden; color: var(--muted); font-size: var(--fs-micro); line-height: var(--lh-flat); font-family: monospace; text-overflow: ellipsis; white-space: nowrap; }
.workspace-availability { max-width: 920px; }
.workspace-view { min-width: 0; min-height: 0; height: 100%; overflow: hidden; }
.company-workspace { min-width: 0; min-height: 0; height: 100%; display: grid; grid-template-columns: 228px minmax(0,1fr) 348px; background: #0b1018; }
.company-session-rail, .company-context-panel { min-width: 0; min-height: 0; display: grid; grid-template-rows: auto minmax(0,1fr); background: #0d131c; }
.company-session-rail { border-right: 1px solid var(--line); }
.company-context-panel { border-left: 1px solid var(--line); }
.company-rail-header, .company-context-header, .company-board-header { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: var(--sp-default); min-height: 66px; padding: var(--sp-default) var(--sp-default); border-bottom: 1px solid var(--line); background: #0f1621; }
.company-rail-header h2, .company-context-header h2, .company-board-header h2 { min-width: 0; margin: 0; overflow: hidden; color: var(--text); font-size: var(--fs-view-title); text-overflow: ellipsis; white-space: nowrap; }
.company-board-header p { max-width: 72ch; margin: var(--sp-tight) 0 0; overflow: hidden; color: var(--muted); font-size: var(--fs-micro); line-height: var(--lh-flat); font-family: monospace; text-overflow: ellipsis; white-space: nowrap; }
.company-board-actions { flex: 0 0 auto; display: flex; align-items: center; gap: var(--sp-snug); }
.workspace-secondary-button { min-height: 30px; padding: 0 var(--sp-cozy); border: 1px solid var(--line); border-radius: var(--radius-sm); background: #121a27; color: var(--muted); font-size: var(--fs-label); cursor: pointer; }
.workspace-secondary-button:hover, .workspace-secondary-button:focus-visible { border-color: var(--accent); color: var(--accent); outline: none; }
.workspace-session-list { min-height: 0; display: grid; align-content: start; gap: var(--sp-snug); padding: var(--sp-cozy); overflow: auto; }
.workspace-session-item { min-width: 0; display: grid; gap: var(--sp-cozy); padding: var(--sp-cozy); border: 1px solid transparent; border-left: 3px solid transparent; border-radius: var(--radius-sm); background: transparent; color: var(--text); text-align: left; cursor: pointer; }
.workspace-session-item:hover, .workspace-session-item:focus-visible { background: #121a27; outline: none; }
.workspace-session-item[data-active="true"] { border-color: #403831; border-left-color: var(--accent); background: #171b21; }
.workspace-session-title { min-width: 0; overflow: hidden; font-size: var(--fs-entity-title); font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
.workspace-session-meta { display: flex; align-items: center; gap: var(--sp-snug); color: var(--muted); font-size: var(--fs-micro); line-height: var(--lh-flat); font-family: monospace; }
.workspace-session-meta::before { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--dim); content: ""; }
.workspace-session-item[data-running="true"] .workspace-session-meta::before { background: var(--green); }
.workspace-session-note { margin: var(--sp-snug); color: var(--muted); font-size: var(--fs-micro); line-height: var(--lh-normal); }
.company-board-shell { min-width: 0; min-height: 0; display: grid; grid-template-rows: auto minmax(0,1fr); background: #0b1018; }
.company-board { min-width: 0; min-height: 0; display: grid; grid-template-columns: repeat(4,minmax(190px,1fr)); gap: var(--sp-cozy); padding: var(--sp-cozy); overflow: auto; }
.work-column { min-width: 190px; min-height: 100%; display: grid; grid-template-rows: auto minmax(0,1fr); border: 1px solid var(--line); border-radius: var(--radius-sm); background: #0d141e; }
.work-column-header { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-cozy); min-height: 38px; padding: 0 var(--sp-cozy); border-bottom: 1px solid var(--line); color: var(--muted); font-weight: 600; font-size: var(--fs-label); line-height: var(--lh-flat); font-family: monospace; text-transform: uppercase; letter-spacing: .04em; }
.work-column-header span:first-child { display: inline-flex; align-items: center; gap: var(--sp-snug); }
.work-column-header span:first-child::before { width: 6px; height: 6px; border-radius: 50%; background: var(--dim); content: ""; }
.work-column[data-column="doing"] .work-column-header span:first-child::before { background: var(--accent); }
.work-column[data-column="review"] .work-column-header span:first-child::before { background: var(--amber); }
.work-column[data-column="done"] .work-column-header span:first-child::before { background: var(--green); }
.work-column-count { display: grid; min-width: 20px; height: 20px; place-items: center; border: 1px solid var(--line); border-radius: 50%; color: var(--text); background: #090e15; }
.work-column-list { display: grid; align-content: start; gap: var(--sp-snug); padding: var(--sp-cozy); overflow: auto; }
.work-item-card { min-width: 0; display: grid; gap: var(--sp-snug); padding: var(--sp-cozy); border: 1px solid #2a3445; border-left: 3px solid #53647e; border-radius: var(--radius-sm); background: #141b25; color: var(--text); text-align: left; cursor: pointer; }
.work-item-card:hover, .work-item-card:focus-visible, .work-item-card[data-selected="true"] { border-color: var(--accent); background: #17222d; outline: none; }
.work-item-card[data-status="running"] { border-left-color: var(--accent); }
.work-item-card[data-status="completed"] { border-left-color: var(--green); }
.work-item-card[data-status="blocked"], .work-item-card[data-status="failed"], .work-item-card[data-status="in_doubt"] { border-left-color: var(--amber); }
.work-item-kicker { display: flex; justify-content: space-between; gap: var(--sp-snug); color: var(--muted); font-size: var(--fs-micro); line-height: var(--lh-flat); font-family: monospace; text-transform: uppercase; }
.work-item-title { margin: 0; overflow-wrap: anywhere; font-size: var(--fs-entity-title); line-height: var(--lh-snug); }
.work-item-summary { margin: 0; display: -webkit-box; overflow: hidden; color: var(--muted); font-size: var(--fs-entity-body); line-height: var(--lh-normal); -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.work-item-tags { display: flex; flex-wrap: wrap; gap: var(--sp-snug); }
.work-item-tag { max-width: 100%; padding: var(--sp-hairline) var(--sp-tight); overflow: hidden; border: 1px solid var(--line); border-radius: 4px; color: #b7c7dd; font-size: var(--fs-micro); line-height: var(--lh-flat); font-family: monospace; text-overflow: ellipsis; white-space: nowrap; }
.work-item-tag-owner { color: var(--accent); border-color: rgba(79,209,197,.34); }
.work-item-tag-tool { color: var(--green); }
.work-board-empty { margin: var(--sp-snug); padding: var(--sp-default); border: 1px dashed var(--line); border-radius: var(--radius-sm); color: var(--muted); font-size: var(--fs-micro); line-height: var(--lh-normal); }
.company-context-body { min-height: 0; overflow: auto; }
.workspace-detail-hero { display: grid; gap: var(--sp-cozy); padding: var(--sp-default); border-bottom: 1px solid var(--line); }
.workspace-detail-hero h3 { margin: 0; overflow-wrap: anywhere; color: var(--text); font-size: var(--fs-view-title); line-height: var(--lh-snug); }
.workspace-detail-hero p { margin: 0; color: var(--muted); font-size: var(--fs-entity-body); line-height: var(--lh-normal); }
.workspace-detail-tags { display: flex; flex-wrap: wrap; gap: var(--sp-snug); }
.workspace-detail-section { padding: var(--sp-default) var(--sp-default); border-bottom: 1px solid var(--line); }
.workspace-detail-section h3 { margin: 0 0 var(--sp-cozy); color: var(--muted); font-weight: 600; font-size: var(--fs-label); line-height: var(--lh-flat); font-family: monospace; text-transform: uppercase; letter-spacing: .05em; }
.workspace-detail-list { display: grid; gap: var(--sp-snug); }
.workspace-detail-row { display: grid; grid-template-columns: 74px minmax(0,1fr); gap: var(--sp-cozy); color: var(--muted); font-size: var(--fs-entity-body); line-height: var(--lh-normal); }
.workspace-detail-row[data-unlabelled="true"] { grid-template-columns: minmax(0,1fr); }
.workspace-detail-row strong { min-width: 0; overflow-wrap: anywhere; color: var(--text); font-weight: 600; }
.workspace-activity { display: grid; grid-template-columns: 9px minmax(0,1fr); gap: var(--sp-cozy); padding: var(--sp-snug) 0; border-bottom: 1px solid var(--line-soft); }
.workspace-activity::before { width: 7px; height: 7px; margin-top: var(--sp-tight); border-radius: 50%; background: var(--dim); content: ""; }
.workspace-activity[data-kind^="tool"]::before { background: var(--green); }
.workspace-activity[data-kind="failure"]::before, .workspace-activity[data-kind="tool_error"]::before { background: var(--danger); }
.workspace-activity strong { display: block; color: var(--text); font-size: var(--fs-entity-body); line-height: var(--lh-snug); }
.workspace-activity span { color: var(--muted); font-size: var(--fs-micro); line-height: var(--lh-snug); font-family: monospace; }
.workspace-telemetry-warning { margin: var(--sp-default); padding: var(--sp-default); border: 1px solid rgba(216,168,78,.35); border-radius: var(--radius-sm); background: rgba(216,168,78,.06); color: #d9bb78; font-size: var(--fs-entity-body); line-height: var(--lh-normal); }
.workspace-grid[data-inspector-open="true"] { grid-template-columns: minmax(0, 1fr) clamp(320px, 26vw, 420px); }
.graph-panel { min-width: 0; min-height: 0; display: grid; grid-template-rows: minmax(0, 1fr) auto var(--h-status-bar); border: 0; background: var(--ink); overflow: hidden; }
.graph-stage { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.graph-stage-bar { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: var(--sp-roomy); min-height: 40px; padding: var(--sp-cozy) var(--sp-default); border-bottom: 1px solid var(--line-soft); background: #0e141e; }
.graph-canvas-title { display: inline-flex; align-items: center; gap: var(--sp-cozy); color: var(--text); font-size: var(--fs-view-title); font-weight: 720; }
.graph-canvas-title .ui-icon { width: 1.05rem; height: 1.05rem; color: var(--muted); }
.graph-edge-legend { min-width: 0; margin-right: auto; color: var(--muted); font-size: var(--fs-label); line-height: var(--lh-snug); }
.graph-edge-legend::before { content: ""; display: inline-block; width: 24px; margin-right: var(--sp-snug); border-top: 1px dashed #53647e; vertical-align: middle; }
.graph-canvas-tools { min-width: 0; flex: 0 1 auto; display: flex; align-items: stretch; gap: var(--sp-snug); transition: box-shadow .18s ease; }
.graph-canvas-tools[data-floating="true"] { position: absolute; z-index: 9; top: var(--tools-y, 0px); left: var(--tools-x, 0px); }
.graph-canvas-tools[data-dragging="true"] { box-shadow: 0 12px 30px rgba(0,0,0,.45); }
.graph-tools-handle { flex: 0 0 auto; min-width: 22px; display: inline-flex; align-items: center; justify-content: center; padding: 0 var(--sp-tight); border: 1px solid var(--line); border-radius: 6px; background: rgba(17,22,32,.94); color: var(--muted); font-size: var(--fs-label); line-height: var(--lh-flat); cursor: grab; touch-action: none; user-select: none; }
.graph-tools-handle:hover { color: var(--text); border-color: var(--line-strong); }
.graph-tools-handle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.graph-canvas-tools[data-dragging="true"] .graph-tools-handle { cursor: grabbing; color: var(--accent); }
.graph-toolbar { display: flex; flex-wrap: wrap; gap: var(--sp-snug); max-width: 100%; padding: var(--sp-tight); border: 1px solid var(--line); border-radius: 9px; background: rgba(17,22,32,.94); box-shadow: 0 8px 24px rgba(0,0,0,.24); pointer-events: auto; }
.graph-tool-button { min-width: 34px; display: inline-flex; align-items: center; justify-content: center; gap: var(--sp-snug); padding: 0 var(--sp-cozy); font-size: var(--fs-label); }
.graph-tool-button[data-active="true"], .replay-button[data-active="true"] { border-color: var(--accent); color: var(--accent); background: rgba(88,212,207,.07); }
.graph-canvas { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden; cursor: grab; background-color: #0d131d; background-image: linear-gradient(rgba(39,48,67,.48) 1px, transparent 1px), linear-gradient(90deg, rgba(39,48,67,.48) 1px, transparent 1px); background-size: 28px 28px; touch-action: none; }
.graph-canvas[data-panning="true"] { cursor: grabbing; }
.graph-scene { position: absolute; top: 0; left: 0; transform-origin: 0 0; transition: transform .16s ease-out; }
.edge-layer, .node-list { position: absolute; inset: 0; width: 100%; height: 100%; }
.edge { fill: none; stroke: #53647e; stroke-width: 1.5; opacity: .72; }
.edge-running { animation: none; }
.edge[data-edge-kind="contains"], .edge-structural { stroke: #40506a; stroke-width: 1.25; stroke-dasharray: 2 9; opacity: .4; animation: none; }
.edge[data-stage-focus="recorded"] { stroke: #8f753d; stroke-width: 2.1; opacity: .88; }
.edge[data-stage-focus="live"], .edge-running { stroke: #3faaa8; stroke-width: 2.35; opacity: .95; }
.edge-completed { stroke: var(--green); stroke-width: 2.1; stroke-dasharray: none; opacity: .9; }
.edge-skipped, .edge-queued { stroke: #53647e; stroke-width: 1.35; stroke-dasharray: 5 9; opacity: .38; }
.edge-failed, .edge-in-doubt { stroke: var(--danger); }
.edge-blocked { stroke: var(--amber); stroke-width: 2.1; stroke-dasharray: 3 6; opacity: .9; }
.edge-effects { pointer-events: none; }
.edge-flow-glow, .edge-flow-tracer { fill: none; stroke-linecap: round; opacity: 0; pointer-events: none; }
.edge-flow-glow[data-stage-focus="recorded"] { stroke: #d8a84e; stroke-width: 10; opacity: .18; filter: blur(3px); }
.edge-flow-glow[data-stage-focus="live"] { stroke: #58d4cf; stroke-width: 11; opacity: .24; filter: blur(3px); }
.edge-flow-tracer { stroke-width: 3.4; stroke-dasharray: 24 96; stroke-dashoffset: 0; }
.edge-flow-tracer[data-stage-focus="recorded"] { stroke: #ffd86b; opacity: 1; filter: drop-shadow(0 0 4px rgba(255,216,107,.95)); animation: stage-route-flow 1.35s linear infinite; }
.edge-flow-tracer[data-stage-focus="live"] { stroke: #b8fffb; opacity: 1; filter: drop-shadow(0 0 5px rgba(88,212,207,1)); animation: live-flow .95s linear infinite; }
.edge-flow-particle { opacity: 0; pointer-events: none; }
.edge-flow-particle[data-stage-focus="recorded"] { fill: #fff3b5; stroke: #d8a84e; stroke-width: 1.5; opacity: 1; filter: drop-shadow(0 0 6px rgba(255,216,107,1)); }
.edge-flow-particle[data-stage-focus="live"] { fill: #e9fffd; stroke: #58d4cf; stroke-width: 1.5; opacity: 1; filter: drop-shadow(0 0 7px rgba(88,212,207,1)); }
@keyframes live-flow { to { stroke-dashoffset: -120; } }
@keyframes stage-route-flow { to { stroke-dashoffset: -120; } }
.node-card { position: absolute; display: grid; grid-template-rows: auto auto minmax(0,1fr) auto auto; gap: var(--sp-snug); width: 232px; min-height: 140px; max-height: 152px; padding: var(--sp-default); overflow: hidden; border: 1px solid var(--line); border-left: 3px solid #53647e; border-radius: var(--radius); background: #151d29; color: var(--text); box-shadow: 0 8px 24px rgba(0,0,0,.28); cursor: pointer; transition: border-color .18s ease, background .18s ease, box-shadow .18s ease, opacity .18s ease; }
.node-card:hover, .node-card:focus-visible, .node-card[data-selected="true"] { border-color: var(--accent); outline: none; box-shadow: 0 0 0 1px rgba(88,212,207,.2), 0 8px 24px rgba(0,0,0,.35); }
.node-running { z-index: 2; border-color: rgba(88,212,207,.9); border-left-color: var(--running); background: linear-gradient(135deg, rgba(88,212,207,.16), #151d29 58%); box-shadow: 0 0 0 1px rgba(88,212,207,.3), 0 0 30px rgba(88,212,207,.2), 0 10px 28px rgba(0,0,0,.42); animation: active-node-pulse 1.8s ease-in-out infinite; }
.node-completed { border-color: rgba(99,202,155,.5); border-left-color: var(--green); background: linear-gradient(135deg, rgba(99,202,155,.09), #151d29 58%); }
.node-card[data-display-state="running"] .node-card-top { color: var(--running); }
.node-card[data-display-state="completed"] .node-card-top { color: var(--green); }
.node-card[data-display-state="queued"], .node-card[data-display-state="unreported"] { border-color: rgba(83,100,126,.5); border-left-color: #53647e; background: #111925; opacity: .66; }
.node-card[data-display-state="unreported"] .node-card-top { color: #d8a84e; }
.node-skipped { border-left-color: #585858; opacity: .72; }
.node-failed, .node-in-doubt { border-left-color: var(--danger); }
.node-blocked { border-color: rgba(216,168,78,.72); border-left-color: var(--amber); background: linear-gradient(135deg, rgba(216,168,78,.13), #181a21 60%); box-shadow: 0 0 0 1px rgba(216,168,78,.12), 0 8px 24px rgba(0,0,0,.32); }
.node-card-top { display: flex; align-items: center; gap: var(--sp-snug); color: var(--muted); font-weight: 600; font-size: var(--fs-label); line-height: var(--lh-flat); font-family: monospace; text-transform: uppercase; }
.node-marker { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.node-running .node-marker { width: 9px; height: 9px; color: var(--running); box-shadow: 0 0 0 5px rgba(88,212,207,.1), 0 0 14px rgba(88,212,207,.95); }
.node-completed .node-marker { color: var(--green); box-shadow: 0 0 0 3px rgba(99,202,155,.1); }
.node-blocked .node-marker { color: var(--amber); box-shadow: 0 0 0 3px rgba(216,168,78,.1); }
.node-wave-badge { flex: 0 0 auto; margin-left: auto; padding: 0 var(--sp-hairline); border-radius: 3px; color: #9aa7bd; background: rgba(154,167,189,.1); font: inherit; }
.node-card[data-wave-index] .node-status { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@keyframes active-node-pulse { 0%,100% { box-shadow: 0 0 0 1px rgba(88,212,207,.25), 0 0 22px rgba(88,212,207,.14), 0 10px 28px rgba(0,0,0,.42); } 50% { box-shadow: 0 0 0 2px rgba(88,212,207,.55), 0 0 38px rgba(88,212,207,.28), 0 10px 30px rgba(0,0,0,.46); } }
.node-title { margin: 0; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: var(--clamp-lines-title); overflow: hidden; white-space: normal; font-size: var(--fs-entity-title); line-height: var(--lh-snug); overflow-wrap: anywhere; }
.node-summary { margin: 0; display: -webkit-box; overflow: hidden; color: var(--muted); font-size: var(--fs-entity-body); line-height: var(--lh-normal); -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.node-task { min-width: 0; margin: 0; overflow: hidden; color: var(--completion-bright); font-size: var(--fs-label); line-height: var(--lh-flat); font-family: monospace; text-overflow: ellipsis; white-space: nowrap; }
.node-identity-row { min-width: 0; display: grid; grid-template-columns: 48px minmax(0,1fr); gap: var(--sp-default); align-items: center; }
.node-identity-copy { min-width: 0; display: grid; gap: var(--sp-cozy); }
.node-glyph { display: block; width: 42px; height: 42px; padding: var(--sp-cozy); color: var(--accent); border: 1px solid rgba(88,212,207,.34); border-radius: 50%; background: rgba(88,212,207,.08); fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.root-entry-path { fill: none; stroke: var(--accent); stroke-width: 1.4; stroke-linecap: round; stroke-dasharray: 2 5; opacity: .78; }
.root-entry-halo { fill: rgba(79,209,197,.05); stroke: rgba(79,209,197,.28); stroke-width: 1; }
.root-entry-dot { fill: var(--accent); stroke: #0e151f; stroke-width: 3; filter: drop-shadow(0 0 5px rgba(79,209,197,.72)); }
.node-proof { min-width: 0; overflow: hidden; color: var(--completion-bright); font-size: var(--fs-micro); line-height: var(--lh-flat); font-family: monospace; text-overflow: ellipsis; white-space: nowrap; }
.activity-chips { display: flex; flex-wrap: wrap; gap: var(--sp-snug); min-width: 0; max-height: 31px; overflow: hidden; }
.activity-chip { min-width: 0; max-width: 62%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: var(--sp-hairline) var(--sp-tight); border: 1px solid var(--line); border-radius: var(--radius-sm); color: #b5c4dd; background: #101725; font-size: var(--fs-micro); line-height: var(--lh-flat); font-family: monospace; }
.chip-owner { color: var(--completion-bright); }
.chip-runtime { color: var(--green); }
.chip-tools { color: #7cc7ef; }.chip-tokens { color: #8ecae6; }.chip-evidence { color: var(--completion-bright); }.chip-loadout { color: #9fb8e8; }
.node-connection, .node-progress { display: none; }
.graph-canvas[data-semantic-zoom="cell"] .node-card { --cell-title-fs: max(var(--fs-entity-body), calc(var(--min-onscreen-text-px) / var(--camera-scale))); --cell-band-h: max(26px, calc(var(--cell-title-fs) * var(--lh-flat) + var(--sp-snug) * 2)); --cell-band-box-h: calc(var(--cell-band-h) + (var(--clamp-lines-title) - 1) * var(--cell-title-fs) * var(--lh-flat)); height: 140px !important; min-height: 140px !important; padding: 0; overflow: visible; border: 0; background: transparent; box-shadow: none; }
.graph-canvas[data-semantic-zoom="cell"] .node-card::after { content: ""; position: absolute; top: 35px; right: 0; left: 0; height: var(--cell-band-box-h); border-left: 8px solid #666; background: #292929; }
.graph-canvas[data-semantic-zoom="cell"] .node-running::after { border-left-color: var(--running); background: rgba(88,212,207,.2); box-shadow: 0 0 18px rgba(88,212,207,.5); }.graph-canvas[data-semantic-zoom="cell"] .node-completed::after { border-left-color: var(--green); background: rgba(99,202,155,.14); }.graph-canvas[data-semantic-zoom="cell"] .node-failed::after,.graph-canvas[data-semantic-zoom="cell"] .node-blocked::after { border-left-color: var(--amber); background: rgba(216,168,78,.14); }
.graph-canvas[data-semantic-zoom="cell"] .node-card > * { visibility: hidden; }
.graph-canvas[data-semantic-zoom="cell"] .node-card .node-title { position: absolute; z-index: 1; top: 35px; right: 0; left: 8px; height: var(--cell-band-box-h); visibility: visible; padding: var(--sp-snug) var(--sp-cozy); font-weight: 700; font-size: var(--cell-title-fs); line-height: var(--lh-flat); font-family: monospace; }
.graph-minimap { position: absolute; z-index: 7; right: .75rem; bottom: .75rem; width: 166px; height: 92px; overflow: hidden; border: 1px solid var(--line-strong); border-radius: var(--radius); background: rgba(13,18,27,.94); pointer-events: none; }
.minimap-scene { position: absolute; transform-origin: 0 0; }
.minimap-node { position: absolute; border-radius: 1px; background: #666; }
.minimap-node-running { background: var(--running); }.minimap-node-completed { background: var(--completion); }.minimap-node-failed,.minimap-node-blocked { background: var(--danger); }
.minimap-viewport { position: absolute; border: 1px solid var(--accent); background: rgba(88,212,207,.07); }
.graph-empty { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; color: var(--muted); font-size: var(--fs-label); }
.replay-panel { min-width: 0; width: 100%; max-width: 100%; grid-template-columns: 330px minmax(0,1fr); grid-template-rows: 40px 34px minmax(0,1fr); overflow: hidden; contain: inline-size; background: #111823; }
.replay-dock-header { grid-row: 1 / -1; min-width: 0; width: 330px; max-width: 100%; display: grid; grid-template-columns: minmax(88px,1fr) auto; align-items: center; gap: var(--sp-cozy); padding: var(--sp-cozy) var(--sp-default); overflow: hidden; border-right: 1px solid var(--line); }
.replay-current { min-width: 74px; overflow: hidden; }
.replay-current .panel-title { white-space: nowrap; }
.replay-current .panel-note { display: none; }
.panel-title { display: block; color: var(--text); font-size: var(--fs-entity-title); font-weight: 700; }
.panel-note { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: var(--fs-entity-body); }
.replay-controls { display: flex; flex: 0 0 auto; gap: var(--sp-snug); white-space: nowrap; }
.replay-button { min-width: 27px; min-height: 27px; padding: 0 var(--sp-snug); font-size: var(--fs-label); line-height: var(--lh-flat); }
.replay-range-wrap { position: relative; grid-column: 2; grid-row: 1; min-width: 0; max-width: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; overflow: hidden; padding: 0 var(--sp-default); border-bottom: 1px solid var(--line-soft); }
.replay-range { position: absolute; inset: 0 .65rem; width: calc(100% - 1.3rem); max-width: calc(100% - 1.3rem); opacity: 0; cursor: ew-resize; z-index: 2; }
.replay-track { min-width: 0; width: 100%; max-width: 100%; height: 4px; overflow: hidden; border-radius: var(--radius-sm); background: var(--line); }
.replay-progress { display: block; height: 100%; background: var(--accent); }
.replay-ticks { min-width: 0; width: 100%; max-width: 100%; display: flex; justify-content: space-between; overflow: hidden; color: var(--muted); font-size: var(--fs-micro); line-height: var(--lh-flat); font-family: monospace; pointer-events: none; }
.replay-ticks span::before { display: block; width: 1px; height: 7px; margin: 0 auto var(--sp-tight); background: #53647e; content: ""; }
.replay-events { grid-column: 2; grid-row: 2 / 4; min-width: 0; width: 100%; max-width: 100%; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(70px,1fr); gap: var(--sp-snug); margin: 0; padding: var(--sp-snug) var(--sp-default); overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; list-style: none; }
.replay-event { position: relative; min-width: 0; border-top: 5px solid #53647e; color: transparent; }
.replay-event[data-active="true"] { border-color: var(--accent); background: rgba(88,212,207,.08); }
.replay-event[data-status="running"] { border-color: var(--running); }.replay-event[data-status="completed"] { border-color: var(--completion); }.replay-event[data-status="failed"] { border-color: var(--danger); }
.replay-event[data-kind="prompt"] { border-top-style: double; border-color: #8ecae6; }.replay-event[data-kind="spawn"] { border-color: var(--completion-bright); }.replay-event[data-kind="failure"],.replay-event[data-kind="tool_error"] { border-color: var(--danger); }
.replay-event[data-kind^="tool_"]::after { position: absolute; right: 2px; bottom: 2px; left: 2px; height: calc(1px + var(--tool-density, 1) * 1px); background: var(--green); opacity: .72; content: ""; }
.replay-event[data-tool-density="0"] { --tool-density: 0; }.replay-event[data-tool-density="1"] { --tool-density: 1; }.replay-event[data-tool-density="2"] { --tool-density: 2; }.replay-event[data-tool-density="3"] { --tool-density: 3; }.replay-event[data-tool-density="4"] { --tool-density: 4; }
.status-bar { min-width: 0; display: flex; align-items: center; gap: var(--sp-default); padding: 0 var(--sp-default); overflow: hidden; border-top: 1px solid var(--line); background: #0d121b; color: var(--muted); font-size: var(--fs-label); line-height: var(--lh-flat); font-family: monospace; }
.status-bar > span { min-width: 0; white-space: nowrap; }
.status-bar .status-title { flex: 1; overflow: hidden; text-overflow: ellipsis; color: var(--text); font-size: var(--fs-entity-title); line-height: var(--lh-display); }
.status-bar strong { color: var(--completion-bright); font-weight: 600; }
.evidence-panel { position: relative; z-index: 20; min-width: 0; min-height: 0; display: grid; grid-template-rows: 54px 40px minmax(0,1fr); overflow: hidden; border-left: 1px solid var(--line); background: var(--panel); }
.evidence-panel[data-open="false"] { visibility: hidden; }
.panel-header { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-cozy); min-width: 0; padding: var(--sp-cozy) var(--sp-default); border-bottom: 1px solid var(--line); }
.evidence-panel .panel-header { position: sticky; top: 0; z-index: 3; background: var(--panel); }
.evidence-panel [data-live-inspector-close] { position: relative; z-index: 4; display: grid; flex: 0 0 36px; width: 36px; min-width: 36px; height: 36px; min-height: 36px; padding: 0; place-items: center; border: 1px solid var(--line-strong); color: var(--accent); background: #101722; font-size: var(--fs-view-title); line-height: var(--lh-display); }
.inspector-tabs { min-width: 0; display: grid; grid-template-columns: repeat(6,minmax(0,1fr)); border-bottom: 1px solid var(--line); overflow-x: auto; }
.inspector-tabs button { min-width: 62px; min-height: 34px; padding: 0 var(--sp-snug); border: 0; border-right: 1px solid var(--line-soft); background: #101725; color: var(--muted); font-size: var(--fs-label); line-height: var(--lh-flat); cursor: pointer; }
.inspector-tabs button[aria-selected="true"] { color: var(--accent); box-shadow: inset 0 -2px 0 var(--accent); }
.inspector-panel { min-width: 0; min-height: 0; overflow: auto; }
.kicker { margin: 0 0 var(--sp-hairline); color: var(--completion); font-size: var(--fs-label); line-height: var(--lh-flat); font-family: monospace; text-transform: uppercase; }
.panel-count { color: var(--completion-bright); font-size: var(--fs-label); line-height: var(--lh-flat); font-family: monospace; }
.selected-node-summary { padding: var(--sp-default); border-bottom: 1px solid var(--line); }
.selected-node-summary strong { display: block; color: var(--completion-bright); font-size: var(--fs-view-title); }
.selected-node-summary p { color: var(--muted); font-size: var(--fs-body); line-height: var(--lh-normal); }
.selected-node-facts { display: flex; flex-wrap: wrap; gap: var(--sp-snug); margin-top: var(--sp-cozy); }
.selected-node-facts span, [data-live-selected-node-evidence] { padding: var(--sp-tight) var(--sp-snug); border: 1px solid var(--line); border-radius: var(--radius-sm); color: #bdd0ec; background: #101725; font-size: var(--fs-label); line-height: var(--lh-flat); font-family: monospace; }
.selected-node-summary [data-live-selected-node-provenance], .selected-node-summary [data-live-selected-node-prompt] { margin: var(--sp-snug) 0 0; padding-left: var(--sp-cozy); border-left: 2px solid #444; overflow-wrap: anywhere; }
.evidence-drawer { min-height: 0; overflow: auto; padding: var(--sp-cozy); }
.evidence-list { display: grid; gap: var(--sp-snug); }
.evidence-item { padding: var(--sp-cozy); border: 1px solid var(--line); border-left: 2px solid #53647e; border-radius: var(--radius-sm); background: #121a29; }
.evidence-item[data-associated="true"] { border-left-color: var(--accent); }
.evidence-item[data-transfer-state="planned"] { border-left-style: dashed; border-left-color: var(--dim); background: #101725; }
.evidence-item[data-transfer-state="planned"] .evidence-status { color: #aaa; }
.evidence-item[data-delivery-observed="true"] { border-left-color: var(--green); }
.history-prompt { border-left-color: #8ecae6; }.history-tool { border-left-color: var(--green); }.history-failure,.history-tool_error { border-left-color: var(--danger); }
.history-footer { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-snug); }.history-source { min-width: 0; overflow: hidden; color: #777; font-size: var(--fs-micro); line-height: var(--lh-flat); font-family: monospace; text-overflow: ellipsis; white-space: nowrap; }
.empty-state { height: 100%; display: grid; place-content: center; text-align: center; color: var(--muted); font-size: var(--fs-micro); }
.empty-glyph { display: grid; width: 52px; height: 44px; margin: 0 auto var(--sp-default); place-items: center; border: 1px solid var(--line); border-radius: var(--radius); background: #111925; color: var(--muted); }
.empty-state-icon { width: 1.65rem; height: 1.65rem; }
.empty-title { color: var(--text); font-size: var(--fs-view-title); }.empty-copy { margin: 0; font-size: var(--fs-micro); }
.live-dialog { position: fixed; z-index: 40; inset: 0; display: grid; place-items: center; padding: clamp(20px,3vw,36px); overflow: auto; background: rgba(0,0,0,.72); }
.dialog-card { width: min(640px,calc(100vw - 48px)); max-height: calc(100dvh - 48px); display: grid; grid-template-rows: auto minmax(0,1fr); overflow: hidden; border: 1px solid var(--line-strong); border-radius: var(--radius); background: var(--panel); background-clip: padding-box; box-shadow: 0 24px 80px rgba(0,0,0,.6); }
.dialog-header { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; padding: var(--sp-default) var(--sp-default); border-bottom: 1px solid var(--line); background: var(--panel); }
.dialog-title { margin: 0; font-size: var(--fs-view-title); }
.dialog-body { min-height: 0; padding: var(--sp-default); overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
.node-card[data-replay-visible="false"] { opacity: 0; pointer-events: none; visibility: hidden; }
.info-facts { display: grid; gap: var(--sp-cozy); margin: var(--sp-tight) 0 var(--sp-roomy); padding: var(--sp-default); border: 1px solid var(--line); border-radius: var(--radius); background: rgba(255,255,255,.018); }
.info-fact-row { display: grid; grid-template-columns: 8rem minmax(0,1fr); gap: var(--sp-default); align-items: baseline; padding-bottom: var(--sp-snug); border-bottom: 1px solid rgba(255,255,255,.06); }
.info-fact-row:last-child { border-bottom: 0; padding-bottom: 0; }
.info-fact-label { color: var(--subtle); font-size: var(--fs-label); text-transform: uppercase; letter-spacing: .04em; }
.info-fact-value { min-width: 0; color: var(--bright); font-size: var(--fs-body); overflow-wrap: anywhere; }
.info-fact-prompt { display: grid; gap: var(--sp-cozy); margin-top: var(--sp-tight); }
.info-fact-prompt p { margin: 0; line-height: var(--lh-normal); }
.hub-switcher { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-default); }
.run-record-dialog { width: min(760px,100%); }
.run-record-guide { display: grid; gap: var(--sp-cozy); margin-bottom: var(--sp-default); padding: var(--sp-default) var(--sp-default); border: 1px solid rgba(79,209,197,.28); border-radius: var(--radius); background: rgba(79,209,197,.055); }
.run-record-guide strong { color: var(--text); font-size: var(--fs-entity-title); }
.run-record-guide span { color: var(--muted); font-size: var(--fs-entity-body); line-height: var(--lh-normal); }
.hub-search { grid-column: 1 / -1; }
.hub-field { display: grid; gap: var(--sp-cozy); color: var(--muted); font-size: var(--fs-body); }
.hub-select { width: 100%; min-width: 0; height: 36px; padding: 0 var(--sp-cozy); border: 1px solid var(--line-strong); border-radius: var(--radius-sm); background: #0f1726; color: var(--text); }
.hub-status { grid-column: 1 / -1; margin: 0; color: var(--muted); font-size: var(--fs-body); }
.session-list { display: grid; gap: var(--sp-snug); margin-top: var(--sp-default); }.session-group-heading { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-default); margin-top: var(--sp-cozy); padding: var(--sp-cozy) var(--sp-hairline) var(--sp-tight); border-bottom: 1px solid var(--line); }.session-group-heading strong { color: var(--text); font-size: var(--fs-entity-title); }.session-group-heading span { color: var(--muted); font-size: var(--fs-label); }.session-card { width: 100%; display: grid; grid-template-columns: minmax(0,1fr) auto; gap: var(--sp-cozy) var(--sp-default); padding: var(--sp-default); border: 1px solid var(--line); border-left: 3px solid #53647e; border-radius: var(--radius); background: #101725; color: var(--text); text-align: left; cursor: pointer; }.session-card[data-identity="unlinked"] { border-left-color: var(--amber); background: rgba(216,168,78,.035); }.session-card:hover,.session-card:focus-visible,.session-card[data-active="true"] { border-color: var(--accent); background: rgba(88,212,207,.05); outline: none; }.session-card-title { min-width: 0; overflow: hidden; font-size: var(--fs-entity-title); font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }.session-card-activity { color: var(--completion-bright); font-size: var(--fs-label); line-height: var(--lh-flat); font-family: monospace; }.session-card[data-identity="unlinked"] .session-card-activity { color: var(--amber); }.session-card-origin { grid-column: 1 / -1; justify-self: start; padding: var(--sp-hairline) var(--sp-tight); border: 1px solid var(--amber); border-radius: var(--radius-sm); color: var(--amber); font-size: var(--fs-micro); line-height: var(--lh-flat); }.session-card-facts { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: var(--sp-snug); color: var(--muted); font-size: var(--fs-micro); line-height: var(--lh-flat); font-family: monospace; }.session-card-facts span + span::before { margin-right: var(--sp-snug); color: var(--dim); content: "·"; }
.session-identity-empty { display: grid; justify-items: start; gap: var(--sp-cozy); padding: var(--sp-roomy); border: 1px dashed var(--line-strong); border-radius: var(--radius); background: #101725; }
.session-identity-empty strong { color: var(--text); font-size: var(--fs-view-title); }.session-identity-empty p { max-width: 64ch; margin: 0; color: var(--muted); font-size: var(--fs-body); line-height: var(--lh-normal); }
.session-unlinked-toggle { width: 100%; min-height: 36px; padding: var(--sp-cozy) var(--sp-default); border: 1px solid var(--line-strong); border-radius: var(--radius-sm); background: transparent; color: var(--muted); text-align: left; font-size: var(--fs-body); cursor: pointer; }
.session-unlinked-toggle:hover,.session-unlinked-toggle:focus-visible { border-color: var(--accent); color: var(--accent); background: rgba(88,212,207,.05); outline: 2px solid rgba(88,212,207,.22); outline-offset: 2px; }
.shortcut-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: var(--sp-snug) var(--sp-default); margin: 0; }
.shortcut-grid div { display: flex; justify-content: space-between; gap: var(--sp-roomy); padding: var(--sp-cozy) 0; border-bottom: 1px solid var(--line-soft); color: var(--muted); font-size: var(--fs-body); }
kbd { min-width: 28px; padding: var(--sp-hairline) var(--sp-tight); border: 1px solid var(--line-strong); border-radius: var(--radius-sm); background: #0f1726; color: var(--completion-bright); text-align: center; font-size: var(--fs-label); line-height: var(--lh-flat); font-family: monospace; }
.share-panel, .control-panel { margin-top: var(--sp-default); border: 1px solid var(--line); }
.share-content, .control-content { padding: var(--sp-default); }.share-actions,.control-actions { display: flex; flex-wrap: wrap; gap: var(--sp-snug); }.share-status,.control-status,.control-result,.control-error { color: var(--muted); font-size: var(--fs-body); overflow-wrap: anywhere; }.control-error { color: var(--danger); }
.stage-rail { display: grid; grid-template-columns: repeat(8, minmax(128px, 1fr)); gap: var(--sp-snug); min-width: min-content; margin: 0; padding: 0; list-style: none; }
.stage-step { position: relative; display: flex; align-items: center; gap: var(--sp-cozy); min-width: 0; min-height: 48px; padding: var(--sp-snug) var(--sp-cozy); color: var(--muted); background: #121923; border: 1px solid var(--line-soft); border-radius: 8px; }
.stage-step[data-state="current"] { color: var(--text); border-color: var(--accent); background: rgba(88,212,207,.07); }
.stage-step[data-state="completed"] { color: var(--completion-bright); border-color: #3b5381; }
.stage-step-marker { display: grid; flex: 0 0 1.2rem; width: 1.2rem; height: 1.2rem; place-items: center; color: #111; background: #555; border-radius: 50%; font-weight: 700; font-size: var(--fs-micro); line-height: var(--lh-flat); font-family: monospace; }
.stage-step[data-state="current"] .stage-step-marker { background: var(--accent); }.stage-step[data-state="completed"] .stage-step-marker { background: var(--completion); }
.stage-step-copy { display: grid; min-width: 0; gap: var(--sp-cozy); }
.stage-step-name { overflow: hidden; color: inherit; font-weight: 600; font-size: var(--fs-body); line-height: var(--lh-flat); font-family: monospace; text-overflow: ellipsis; white-space: nowrap; }
.stage-step-state { color: var(--muted); font-size: var(--fs-micro); line-height: var(--lh-flat); font-family: monospace; }
@media (min-width: 901px) and (min-height: 720px) {
  .shell { --line: #2c3749; --line-soft: #202a39; --text: #eef2f8; --muted: #9aa5b7; grid-template-rows: 60px minmax(0,1fr); background: #0b1018; }
  .topbar { position: relative; gap: var(--sp-section); padding: 0 var(--sp-section); background: #0c121b; }
  .brand { gap: var(--sp-default); }
  .brand-mark { width: 31px; height: 31px; }
  .workspace-grid, .workspace-grid[data-inspector-open="true"] { grid-template-columns: minmax(0,1fr) 428px; gap: var(--sp-cozy); padding: 0 var(--sp-section); background: #0b1018; }
  .workspace-grid[data-inspector-open="false"] { grid-template-columns: minmax(0,1fr) 0; }
  .graph-panel { display: contents; }
  .graph-stage { grid-column: 1; grid-row: 1; margin-left: 0; overflow: visible; }
  .stage-rail { grid-template-columns: repeat(8,minmax(0,1fr)); gap: var(--sp-cozy); min-width: 0; }
  .stage-step { min-height: 60px; gap: var(--sp-cozy); padding: var(--sp-cozy) var(--sp-default); border-color: #2a3445; border-radius: 4px; background: #121923; }
  .stage-step[data-state="current"] { border-color: var(--accent); box-shadow: inset 0 3px 0 rgba(79,209,197,.55); }
  .stage-step-marker { flex-basis: 1.25rem; width: 1.25rem; height: 1.25rem; }
  .stage-step-icon { flex: 0 0 1.55rem; color: #7f8999; font: 400 1.35rem/1 monospace; text-align: center; }
  .stage-step-icon svg { display: block; width: 1.55rem; height: 1.55rem; }
  .stage-step[data-state="current"] .stage-step-icon { color: var(--accent); }
  .stage-step-state { display: none; }
  .graph-canvas { border: 1px solid var(--line); border-radius: 3px; background-color: #0e151f; background-size: 28px 28px; }
  .graph-stage-bar { padding: var(--sp-cozy) var(--sp-roomy); }
  .graph-toolbar { padding: 0; border-radius: 3px; background: #111925; box-shadow: none; }
  .graph-toolbar > .graph-tool-button { flex: 1 1 0; }
  .graph-tool-button { min-height: 34px; padding-inline: var(--sp-default); border-right: 1px solid var(--line-soft); border-radius: 0; }
  .graph-tool-button:last-child { border-right: 0; }
  .graph-precision-control, .graph-toolbar [data-evidence-toggle] { display: none; }
  .graph-minimap { display: none; }
  .node-card { width: 256px; padding: var(--sp-default); border-radius: 5px; background: #17202d; }
  .replay-panel { margin-top: 0; border: 1px solid var(--line); border-radius: 3px; background: #101722; }
  .replay-dock-header { width: 300px; min-width: 0; max-width: 100%; padding: var(--sp-default) var(--sp-default); }
  .replay-range-wrap { grid-column: 2; grid-row: 1; }
  .replay-events { grid-column: 2 / 4; grid-row: 2 / 4; border-top: 0; }
  .replay-empty { display: grid; grid-column: 1 / -1; place-items: center; align-self: end; height: 28px; min-height: 0; margin: var(--sp-band) 0 0 calc(100% - 410px); padding: 0 var(--sp-cozy); overflow: hidden; border: 1px solid var(--line); color: var(--muted); font-size: var(--fs-micro); text-overflow: ellipsis; white-space: nowrap; }
  .status-bar { grid-column: 1 / -1; grid-row: 3; width: calc(100% + 48px); margin-left: calc(var(--sp-section) * -1); padding: 0 var(--sp-section); border-top: 1px solid var(--line); }
  .evidence-panel { z-index: 20; grid-column: 2; grid-row: 1; align-self: stretch; min-height: 0; border: 1px solid var(--line); border-radius: 3px; background: #121925; }
  .evidence-panel .panel-header { height: 50px; padding: var(--sp-default) var(--sp-roomy); }
  .evidence-panel .panel-header .kicker { display: none; }
  .evidence-panel .panel-count { display: none; }
  .inspector-tabs { grid-template-columns: repeat(4,minmax(0,1fr)); }
  .inspector-tabs button { min-height: 40px; }
  .selected-node-summary { padding: var(--sp-roomy); }
}
@media (max-width: 1180px) {
  .company-workspace { grid-template-columns: 200px minmax(0,1fr) 300px; }
  .company-board { grid-template-columns: repeat(4,minmax(176px,1fr)); }
  .work-column { min-width: 176px; }
}
@media (max-width: 720px) {
  .shell { grid-template-rows: 78px minmax(0,1fr); }
  .connection span:last-child { display: none; }
  .topbar { display: grid; grid-template-columns: auto minmax(0,1fr) auto; grid-template-rows: 40px 32px; gap: 0 var(--sp-snug); padding-inline: var(--sp-snug); }
  .brand { min-width: 0; }
  .work-view-tab { min-width: 0; }
  .topbar-actions { grid-column: 3; grid-row: 1; min-width: 0; flex: 0 0 auto; gap: var(--sp-snug); }
  .connection { margin: 0 var(--sp-hairline) 0 0; }
  .topbar-button { min-width: 30px; padding-inline: var(--sp-tight); }
  .workspace-grid, .workspace-grid[data-inspector-open="true"] { display: block; }
  .company-workspace { height: auto; min-height: 100%; grid-template-columns: 1fr; grid-template-rows: auto minmax(520px,1fr) auto; }
  .company-session-rail { max-height: 190px; border-right: 0; border-bottom: 1px solid var(--line); }
  .workspace-session-list { display: flex; overflow-x: auto; }
  .workspace-session-item { flex: 0 0 210px; }
  .company-board { grid-template-columns: repeat(4,minmax(210px,1fr)); }
  .company-context-panel { min-height: 360px; border-top: 1px solid var(--line); border-left: 0; }
  .company-board-header { align-items: flex-start; }
  .company-board-actions .surface-state { display: none; }
  .work-surface-view { height: 100%; }
  .work-surface-header { padding: var(--sp-default); }
  .repository-layout { grid-template-columns: 1fr; }
  .operational-section { --section-inline: var(--sp-default); padding: var(--sp-default) var(--section-inline); }
  .operational-section + .operational-section { border-top: 1px solid var(--line); border-left: 0; }
  .run-context-facts { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--line); padding-left: 0; padding-top: var(--sp-cozy); }
  .run-context-source { justify-self: end; padding-left: 0; border-left: 0; }
  .run-context-source strong { max-width: 86px; text-align: right; }
  .graph-panel { height: 100%; }
  .graph-stage-bar { flex-wrap: wrap; gap: var(--sp-snug); padding: var(--sp-snug); }
  .graph-canvas-tools { flex: 1 1 100%; }
  .graph-canvas-title { display: none; }
  .graph-toolbar { width: 100%; max-width: none; overflow-x: auto; flex-wrap: nowrap; }
  .graph-tool-button { min-width: 40px; min-height: 40px; }
  [data-live-graph-fit], [data-live-graph-layout], [data-live-graph-zoom-out], [data-live-graph-zoom-in] { display: none; }
  [data-live-graph-live], [data-live-graph-reset] { display: none; }
  .graph-canvas { overflow: auto; touch-action: pan-y; }
  .graph-scene { position: relative; width: 100% !important; height: auto !important; transform: none !important; }
  .node-list { position: relative; inset: auto; display: grid; gap: var(--sp-cozy); padding: var(--sp-cozy) var(--sp-cozy); }
  .node-card { position: relative !important; top: auto !important; left: auto !important; width: 100% !important; min-height: 84px !important; }
  .graph-canvas[data-semantic-zoom="cell"] .node-card { min-height: 84px !important; height: auto !important; padding: var(--sp-cozy); overflow: hidden; border: 1px solid var(--line); border-left-width: 3px; border-radius: var(--radius); background: #172131; }
  .graph-canvas[data-semantic-zoom="cell"] .node-card::after { display: none; }
  .graph-canvas[data-semantic-zoom="cell"] .node-card > * { visibility: visible; }
  .graph-canvas[data-semantic-zoom="cell"] .node-card .node-title { position: static; height: auto; padding: 0; font: inherit; }
  .edge-layer, .graph-minimap { display: none; }
  .replay-dock-header { grid-row: 1; width: 100%; min-width: 0; grid-template-columns: minmax(64px,1fr) auto; border-right: 0; border-bottom: 1px solid var(--line); }
  .replay-range-wrap { grid-column: 1; grid-row: 2; }
  .replay-events { grid-column: 1; grid-row: 3; }
  .evidence-panel { position: fixed; z-index: 30; right: 0; bottom: 0; left: 0; height: min(76dvh,660px); border: 1px solid var(--line-strong); border-radius: var(--radius) var(--radius) 0 0; transform: translateY(102%); transition: transform .18s ease; visibility: visible !important; }
  .evidence-panel[data-open="true"] { transform: translateY(0); }
  .inspector-tabs { grid-template-columns: repeat(4,minmax(72px,1fr)); }
  .status-bar { gap: var(--sp-cozy); }.status-bar .status-nodes,.status-bar .status-transport { display: none; }
  .hub-switcher, .shortcut-grid { grid-template-columns: 1fr; }
  .hub-status { grid-column: 1; }
}
/* Flow-first surface: secondary views, stages, replay, and records stay available
   without competing with the execution graph. */
.work-view-menu { position: relative; z-index: 40; flex: 0 0 auto; }
.work-view-menu > summary { display: inline-flex; align-items: center; justify-content: center; list-style: none; cursor: pointer; }
.work-view-menu > summary::-webkit-details-marker { display: none; }
.work-view-menu > summary::after { margin-left: var(--sp-snug); content: "⌄"; color: var(--subtle); }
.work-view-menu[open] > summary { border-color: var(--accent); color: var(--accent); }
.work-view-menu .work-view-switcher { position: absolute; top: calc(100% + .45rem); right: 0; left: auto; width: 164px; height: auto; display: grid; grid-template-columns: 1fr; padding: var(--sp-tight); border: 1px solid var(--line-strong); border-radius: var(--radius); background: #101722; box-shadow: 0 16px 40px rgba(0,0,0,.42); transform: none; }
.work-view-menu .work-view-tab { width: 100%; min-width: 0; min-height: 36px; border: 0; border-radius: var(--radius-sm); text-align: left; }
.work-view-menu .work-view-tab[aria-selected="true"] { box-shadow: inset 2px 0 0 var(--accent); }
.run-context-heading .context-kicker { display: none; }
.stage-overview { flex: 0 0 auto; width: 100%; height: auto; margin: 0; padding: 0; overflow: visible; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; background: #0c1119; }
.stage-overview-toggle, .replay-collapse-summary { min-height: 34px; display: flex; align-items: center; justify-content: space-between; gap: var(--sp-default); padding: 0 var(--sp-default); list-style: none; color: var(--muted); background: #101722; cursor: pointer; font-weight: 600; font-size: var(--fs-label); line-height: var(--lh-flat); font-family: monospace; }
.stage-overview-toggle::-webkit-details-marker, .replay-collapse-summary::-webkit-details-marker { display: none; }
.stage-overview-toggle span:last-child, .replay-collapse-summary span:last-child { color: var(--accent); font-weight: 500; }
.stage-overview-body { padding: var(--sp-cozy) var(--sp-default) var(--sp-default); overflow-x: auto; }
.stage-overview-toggle [data-stage-rail-state] { color: var(--accent); font-weight: 500; }
.stage-overview-toggle [data-stage-rail-state="expand"] { display: none; }
.stage-overview:not([open]) .stage-overview-toggle [data-stage-rail-state="collapse"] { display: none; }
.stage-overview:not([open]) .stage-overview-toggle [data-stage-rail-state="expand"] { display: inline; }
.workspace-grid, .workspace-grid[data-inspector-open="true"] { grid-template-rows: minmax(0, 1fr); }
.node-card { min-height: 176px; max-height: none; height: auto; grid-template-rows: auto auto auto auto; overflow: visible; }
.node-owner-line { min-width: 0; display: flex; flex-wrap: wrap; gap: var(--sp-cozy); color: var(--muted); font-weight: 600; font-size: var(--fs-label); line-height: var(--lh-flat); font-family: monospace; }
.node-owner-line span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.node-identity-row { grid-template-columns: 34px minmax(0,1fr); gap: var(--sp-cozy); }
.node-identity-button { width: 100%; padding: 0; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.node-identity-button:hover .node-title, .node-identity-button:focus-visible .node-title { color: var(--accent); }
.node-identity-button:focus-visible { border-radius: 4px; outline: 2px solid rgba(79,209,197,.42); outline-offset: 2px; }
.node-glyph { width: 32px; height: 32px; padding: var(--sp-snug); }
.node-summary { -webkit-line-clamp: 1; }
.node-capability-strip { min-width: 0; display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: var(--sp-snug); overflow: visible; }
.node-capability:last-child:nth-child(odd) { grid-column: 1 / -1; }
.node-capability { min-width: 0; max-width: 100%; min-height: 36px; display: grid; grid-template-columns: minmax(0,1fr) auto; grid-template-rows: auto auto; align-items: center; gap: var(--sp-snug); padding: var(--sp-tight) var(--sp-snug); overflow: hidden; border: 1px solid var(--line); border-radius: 4px; background: #101722; color: var(--text); text-align: left; cursor: pointer; }
.node-capability:hover, .node-capability:focus-visible { border-color: var(--accent); background: rgba(79,209,197,.06); outline: 2px solid rgba(79,209,197,.2); outline-offset: 1px; }
.node-capability-kind { min-width: 0; overflow: hidden; color: var(--completion-bright); font-weight: 700; font-size: var(--fs-label); line-height: var(--lh-flat); font-family: monospace; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }
.node-capability-value { grid-column: 1 / -1; min-width: 0; max-width: none; overflow: hidden; color: var(--text); font-weight: 600; font-size: var(--fs-entity-body); line-height: var(--lh-flat); font-family: monospace; text-overflow: ellipsis; white-space: nowrap; }
.node-capability-state { color: var(--muted); font-size: var(--fs-label); line-height: var(--lh-flat); font-family: monospace; }
.node-capability[data-capability-state="planned"] .node-capability-state { color: var(--completion-bright); }
.node-capability[data-capability-state="observed"] .node-capability-state { color: var(--green); }
.node-meta { display: none; }
.replay-panel { position: relative; min-height: var(--h-replay-collapsed); height: var(--h-replay-collapsed); display: block; border-top: 1px solid var(--line); }
.replay-panel:not([open]) > :not(summary) { display: none !important; }
.replay-panel[open] { height: var(--h-replay-open); display: grid; }
.replay-panel::details-content { display: contents; }
.replay-collapse-summary { position: absolute; z-index: 4; top: 0; left: 0; width: 100%; height: var(--h-replay-collapsed); }
.replay-collapse-summary span { white-space: nowrap; }
.replay-collapse-summary [data-replay-dock-state] { color: var(--accent); font-weight: 500; }
.replay-collapse-summary [data-replay-dock-state="collapse"] { display: none; }
.replay-panel[open] .replay-collapse-summary { width: var(--w-replay-collapse); border-right: 1px solid var(--line); }
.replay-panel[open] .replay-collapse-summary [data-replay-dock-state="expand"] { display: none; }
.replay-panel[open] .replay-collapse-summary [data-replay-dock-state="collapse"] { display: inline; }
.replay-panel[open] .replay-dock-header { padding-left: calc(var(--w-replay-collapse) + var(--sp-cozy)); }

@media (min-width: 901px) and (min-height: 720px) {
  .topbar { gap: var(--sp-default); }
  .work-view-menu { margin-left: auto; }
  .topbar-actions { margin-left: 0; }
  .workspace-grid, .workspace-grid[data-inspector-open="true"] { grid-template-rows: minmax(0, 1fr) auto var(--h-status-bar); }
  .stage-overview { z-index: 12; }
  .stage-overview-body { padding: var(--sp-cozy) 0; }
  .stage-step { min-height: 52px; }
  .node-card { min-height: 176px; max-height: none; overflow: visible; }
  .replay-panel { grid-column: 1 / -1; grid-row: 2; height: var(--h-replay-collapsed); grid-template-columns: minmax(0,300px) minmax(0,1fr) minmax(0,410px); grid-template-rows: 43px 34px minmax(0,1fr); }
}

@media (max-width: 720px) {
  .shell { grid-template-rows: 58px minmax(0,1fr); }
  .topbar { display: flex; min-height: 58px; padding-inline: var(--sp-cozy); }
  .top-run-context { display: none; }
  .work-view-menu { margin-left: auto; }
  .work-view-menu .work-view-switcher { right: 0; width: 150px; }
  .topbar-actions { margin-left: 0; }
  .connection, [data-live-open-help], [data-live-open-info] { display: none; }
  .run-context { min-height: 42px; display: flex; align-items: center; gap: var(--sp-cozy); padding: var(--sp-tight) var(--sp-cozy); }
  .run-context-heading { flex: 1; }
  .run-context-facts, .run-context-source { display: none; }
  .stage-overview-toggle { min-height: 32px; }
  .node-list { grid-template-columns: 1fr; }
  .node-card, .graph-canvas[data-semantic-zoom="cell"] .node-card { min-height: 166px !important; }
  .node-capability-strip { grid-template-columns: 1fr; }
  .node-capability { min-height: 34px; }
  .node-capability-kind, .node-capability-value, .node-capability-state { font-size: var(--fs-entity-body); }
  .replay-panel, .replay-panel:not([open]) { min-height: var(--h-replay-collapsed); height: var(--h-replay-collapsed); }
  .replay-panel[open] { height: auto; grid-template-columns: 1fr; grid-template-rows: 42px 28px auto; }
  .replay-panel[open] .replay-dock-header { padding-left: calc(var(--w-replay-collapse) + var(--sp-cozy)); }
}
@media (max-width: 380px) { .brand-title { display: none; }.topbar-button { font-size: var(--fs-label); }.status-bar .status-camera { display: none; }.operational-row { grid-template-columns: 82px minmax(0,1fr); }.work-surface-header { gap: var(--sp-cozy); } }
@media (min-width: 721px) and (max-width: 1024px) {
  .node-card { padding: var(--sp-roomy); gap: var(--sp-cozy); }
  .node-summary { display: none; }
  .node-owner-line { display: grid; grid-template-columns: minmax(0,1fr); gap: var(--sp-cozy); }
  .node-card-top, .node-owner-line, .node-task, .node-proof { font-size: var(--fs-entity-body); }
  .node-capability-strip { gap: var(--sp-snug); }
  .node-capability { min-height: 38px; padding: var(--sp-snug) var(--sp-cozy); }
  .node-capability-kind, .node-capability-value, .node-capability-state { font-size: var(--fs-entity-body); }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; } }
`;

const FIXED_UI_ICONS = Object.freeze({
  overview: '<rect x="4" y="4" width="5" height="5" rx="1"/><rect x="15" y="4" width="5" height="5" rx="1"/><rect x="4" y="15" width="5" height="5" rx="1"/><rect x="15" y="15" width="5" height="5" rx="1"/>',
  follow: '<circle cx="12" cy="12" r="5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="1.5"/>',
  relayout: '<path d="M7 5v14M17 5v14M4 8h6M14 16h6"/><path d="m5 6 2-2 2 2M15 18l2 2 2-2"/>',
  live: '<path d="M2 13h4l2.2-6 3.4 11L15 9l2 4h5"/>',
  reset: '<path d="M4 8V3m0 0h5M4 3l4 4"/><path d="M5.5 17.5A8 8 0 1 0 6 6"/>',
  graph: '<circle cx="5" cy="12" r="2"/><circle cx="12" cy="5" r="2"/><circle cx="19" cy="12" r="2"/><path d="m7 11 3.5-4.5M13.5 6.5 17 11M7 13h10"/>',
  grip: '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
  previous: '<path d="m15 6-6 6 6 6"/><path d="M7 6v12"/>',
  play: '<path d="m9 6 9 6-9 6Z"/>',
  next: '<path d="m9 6 6 6-6 6"/><path d="M17 6v12"/>',
  inbox: '<path d="M5 4h14l2 9v7H3v-7Z"/><path d="M3 13h5l2 3h4l2-3h5"/>',
});

function fixedUiIcon(name, className = "ui-icon") {
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${FIXED_UI_ICONS[name] || ""}</svg>`;
}

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
        <img class="brand-mark" src="/assets/meta-kim-k-mark.png" alt="" aria-hidden="true" width="30" height="30">
        <p class="brand-title">Meta_Kim Live</p>
      </div>
      <div class="top-run-context"><strong data-live-run-title>正在等待运行快照</strong><span data-live-run-id>未识别运行</span></div>
      <details class="work-view-menu"><summary class="topbar-button" data-i18n-en="Other views" data-i18n-zh="其他视图">其他视图</summary><div class="work-view-switcher" role="tablist" aria-label="Optional work surface views"><button class="work-view-tab" id="work-view-run" type="button" role="tab" aria-controls="run-view" aria-selected="true" data-live-work-view="run" data-i18n-en="Flow map" data-i18n-zh="流程图">流程图</button><button class="work-view-tab" id="work-view-workspace" type="button" role="tab" aria-controls="workspace-view" aria-selected="false" tabindex="-1" data-live-work-view="workspace" data-i18n-en="Workspace" data-i18n-zh="工作台">工作台</button><button class="work-view-tab" id="work-view-repository" type="button" role="tab" aria-controls="repository-view" aria-selected="false" tabindex="-1" data-live-work-view="repository" data-i18n-en="Repository" data-i18n-zh="仓库">仓库</button></div></details>
      <div class="topbar-actions"><div class="connection" aria-live="polite"><span class="connection-dot" data-live-connection-dot aria-hidden="true"></span><span data-live-connection data-i18n-en="Connecting…" data-i18n-zh="正在连接…">正在连接…</span></div><button class="topbar-button" type="button" data-live-open-sessions data-i18n-en="Run records" data-i18n-zh="运行记录">运行记录</button><button class="topbar-button" type="button" data-live-language-toggle aria-label="Switch to English">EN</button><button class="topbar-button" type="button" data-live-open-help aria-label="Help" title="Help">?</button><button class="topbar-button" type="button" data-live-open-info aria-label="Session info" title="Session info">i</button></div>
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
          <div class="context-fact" role="listitem"><span data-i18n-en="Stage" data-i18n-zh="阶段">阶段</span><strong data-live-context-stage>${EMPTY_PLACEHOLDER}</strong></div>
          <div class="context-fact" role="listitem"><span data-i18n-en="Nodes" data-i18n-zh="节点">节点</span><strong data-live-context-nodes>0</strong></div>
          <div class="context-fact" role="listitem"><span data-i18n-en="Events" data-i18n-zh="事件">事件</span><strong data-live-context-events>0</strong></div>
          <div class="context-fact" role="listitem"><span data-i18n-en="Evidence" data-i18n-zh="证据">证据</span><strong data-live-context-evidence>0</strong></div>
          <div class="context-fact" role="listitem"><span data-i18n-en="Updated" data-i18n-zh="更新">更新</span><strong data-live-context-updated>${EMPTY_PLACEHOLDER}</strong></div>
          <div class="context-fact" role="listitem" data-live-context-chat hidden><button class="context-fact-copy" type="button" data-live-context-chat-copy title="Copy the full chat id">${EMPTY_PLACEHOLDER}</button></div>
        </div>
        <div class="run-context-source"><span data-i18n-en="Source" data-i18n-zh="来源">来源</span><strong data-live-context-source>local observer</strong></div>
      </section>
      <section class="workspace-grid" data-inspector-open="false" aria-label="Live execution workspace">
        <section class="work-surface-view repository-view" id="repository-view" role="tabpanel" aria-labelledby="work-view-repository" data-live-repository-view hidden><header class="work-surface-header"><div><span class="context-kicker" data-i18n-en="Repository" data-i18n-zh="仓库">仓库</span><h2 data-live-repository-title>已登记项目</h2><p data-live-repository-boundary>仓库边界不可用</p></div><span class="surface-state" data-i18n-en="Observed catalog" data-i18n-zh="已观测目录">已观测目录</span></header><div class="repository-layout"><section class="operational-section" aria-labelledby="repository-facts-title"><h3 id="repository-facts-title" data-i18n-en="Repository facts" data-i18n-zh="仓库事实">仓库事实</h3><div class="operational-list" data-live-repository-facts></div></section><section class="operational-section" aria-labelledby="repository-workspaces-title"><h3 id="repository-workspaces-title" data-i18n-en="Workspace sessions" data-i18n-zh="工作区会话">工作区会话</h3><div class="workspace-children" data-live-repository-sessions></div></section></div></section>
        <section class="work-surface-view workspace-view" id="workspace-view" role="tabpanel" aria-labelledby="work-view-workspace" data-live-workspace-view hidden>
          <div class="company-workspace">
            <aside class="company-session-rail" aria-labelledby="workspace-sessions-title">
              <header class="company-rail-header"><div><span class="context-kicker" data-i18n-en="Chats" data-i18n-zh="任务与会话">任务与会话</span><h2 id="workspace-sessions-title" data-i18n-en="Recent work" data-i18n-zh="最近工作">最近工作</h2></div><button class="workspace-secondary-button" type="button" data-live-workspace-open-sessions data-i18n-en="All runs" data-i18n-zh="全部运行">全部运行</button></header>
              <div class="workspace-session-list" data-live-workspace-session-list role="list" aria-label="Recent governed work"></div>
            </aside>
            <main class="company-board-shell">
              <header class="company-board-header"><div><span class="context-kicker" data-i18n-en="Workspace" data-i18n-zh="工作台">工作台</span><h2 data-live-workspace-title>正在等待任务</h2><p data-live-workspace-boundary>等待真实运行数据</p></div><div class="company-board-actions"><span class="surface-state" data-i18n-en="Run-scoped" data-i18n-zh="运行范围">运行范围</span><button class="workspace-secondary-button" type="button" data-live-workspace-open-run-map data-i18n-en="Run map" data-i18n-zh="查看运行图">查看运行图</button></div></header>
              <div class="company-board" data-live-workspace-board aria-label="Run work-item board"></div>
            </main>
            <aside class="company-context-panel" aria-labelledby="workspace-detail-title">
              <header class="company-context-header"><span class="context-kicker" data-i18n-en="Selected work" data-i18n-zh="当前任务">当前任务</span><h2 id="workspace-detail-title" data-i18n-en="Task details" data-i18n-zh="任务详情">任务详情</h2></header>
              <div class="company-context-body" data-live-workspace-detail></div>
            </aside>
          </div>
          <div class="sr-only" data-live-workspace-facts></div>
        </section>
        <section class="graph-panel" id="run-view" role="tabpanel" aria-labelledby="work-view-run" data-live-run-view aria-label="Run view">
          <div class="graph-stage" data-live-graph-viewport>
            <h1 class="sr-only" id="graph-title" data-i18n-en="Execution graph" data-i18n-zh="实时运行图">实时运行图</h1>
            <details class="stage-overview" aria-label="Stage progress"><summary class="stage-overview-toggle"><span data-i18n-en="Eight-stage flow" data-i18n-zh="八阶段流程">八阶段流程</span><span data-stage-rail-state="collapse" data-i18n-en="Collapse" data-i18n-zh="收起">收起</span><span data-stage-rail-state="expand" data-i18n-en="Expand" data-i18n-zh="展开">展开</span></summary><div class="stage-overview-body"><ol class="stage-rail" data-live-stage-rail></ol></div></details>
            <div class="graph-stage-bar"><span class="graph-canvas-title" aria-hidden="true">${fixedUiIcon("graph")}<span data-i18n-en="Live execution graph" data-i18n-zh="实时运行图">实时运行图</span></span><span class="graph-edge-legend" data-i18n-en="Glow = running · Green solid = done · Gray dashed = queued · Amber dashed = blocked · Dotted = ownership" data-i18n-zh="青色流光＝进行中 · 绿色实线＝已完成 · 灰色虚线＝排队 · 琥珀虚线＝阻塞 · 点线＝结构归属">青色流光＝进行中 · 绿色实线＝已完成 · 灰色虚线＝排队 · 琥珀虚线＝阻塞 · 点线＝结构归属</span><div class="graph-canvas-tools" data-live-graph-tools data-floating="false"><button class="graph-tools-handle" type="button" data-live-graph-tools-handle aria-label="Move graph controls: drag, or arrow keys to nudge, Enter to dock" title="Drag to move · arrow keys to nudge · Enter to dock">${fixedUiIcon("grip")}</button><div class="graph-toolbar" role="group" aria-label="Graph camera controls"><button class="graph-tool-button" type="button" data-live-graph-fit aria-label="Overview" title="Overview (O)">${fixedUiIcon("overview")}<span data-i18n-en="Overview" data-i18n-zh="总览">总览</span></button><button class="graph-tool-button" type="button" data-live-graph-follow data-active="false" aria-pressed="false" aria-label="Follow active node" title="Follow (F)">${fixedUiIcon("follow")}<span data-i18n-en="Follow" data-i18n-zh="跟随">跟随</span></button><button class="graph-tool-button" type="button" data-live-graph-layout aria-label="Relayout graph" title="Relayout (R)">${fixedUiIcon("relayout")}<span data-i18n-en="Relayout" data-i18n-zh="重排">重排</span></button><button class="graph-tool-button" type="button" data-live-graph-live aria-label="Follow live execution">${fixedUiIcon("live")}<span data-i18n-en="Live" data-i18n-zh="实时">实时</span></button><button class="graph-tool-button" type="button" data-live-graph-reset aria-label="Reset graph camera">${fixedUiIcon("reset")}<span data-i18n-en="Reset" data-i18n-zh="重置">重置</span></button><button class="graph-tool-button graph-precision-control" type="button" data-live-graph-zoom-out aria-label="Zoom graph out" title="Zoom out">−</button><button class="graph-tool-button graph-precision-control" type="button" data-live-graph-zoom-in aria-label="Zoom graph in" title="Zoom in">+</button><button class="graph-tool-button" type="button" data-evidence-toggle aria-controls="live-inspector" aria-expanded="false" aria-label="Open inspector" title="Inspector" data-i18n-en="Inspector" data-i18n-zh="检查器">检查器</button></div></div></div>
            <div class="graph-canvas" data-live-graph role="region" aria-label="Read-only execution graph" tabindex="0">
              <div class="graph-scene" data-live-graph-scene>
                <svg class="edge-layer" data-live-edge-layer aria-hidden="true" focusable="false"></svg>
                <div class="node-list" data-live-node-list role="list" aria-label="Execution nodes"></div>
              </div>
              <div class="graph-minimap" data-live-graph-minimap aria-label="Graph minimap" role="img"><div class="minimap-scene" data-live-minimap-scene></div><span class="minimap-viewport" data-live-minimap-viewport aria-hidden="true"></span></div>
              <div class="graph-empty" data-live-graph-empty hidden><p data-i18n-en="No task nodes in this snapshot." data-i18n-zh="当前快照中没有任务节点。">当前快照中没有任务节点。</p></div>
            </div>
          </div>
          <details class="replay-panel replay-dock" aria-labelledby="replay-title">
            <summary class="replay-collapse-summary"><span data-i18n-en="Replay" data-i18n-zh="回放">回放</span><span data-replay-dock-state="expand" data-i18n-en="Open timeline" data-i18n-zh="展开时间线">展开时间线</span><span data-replay-dock-state="collapse" data-i18n-en="Collapse" data-i18n-zh="收起">收起</span></summary>
            <header class="replay-dock-header"><div class="replay-current"><span class="panel-title" id="replay-title" data-i18n-en="Replay timeline" data-i18n-zh="回放时间线">回放时间线</span><span class="panel-note" data-replay-status>正在等待回放数据</span></div><div class="replay-controls"><button class="replay-button" type="button" data-replay-prev aria-label="Previous replay event" title="Previous">${fixedUiIcon("previous")}</button><button class="replay-button replay-play" type="button" data-replay-play aria-label="Play replay">${fixedUiIcon("play")}<span class="sr-only" data-replay-play-label>播放</span></button><button class="replay-button" type="button" data-replay-next aria-label="Next replay event" title="Next">${fixedUiIcon("next")}</button><button class="replay-button" type="button" data-replay-live aria-label="Go to live replay position">${fixedUiIcon("live")}<span data-i18n-en="Live" data-i18n-zh="实时">实时</span></button><button class="replay-button replay-reset" type="button" data-replay-reset aria-label="Reset replay">${fixedUiIcon("reset")}<span data-i18n-en="Reset" data-i18n-zh="重置">重置</span></button></div></header>
            <div class="replay-range-wrap"><label class="sr-only" for="replay-range" data-i18n-en="Replay position" data-i18n-zh="回放位置">回放位置</label><input class="replay-range" id="replay-range" data-replay-range type="range" min="0" max="0" value="0" step="1" aria-label="Replay position" disabled><div class="replay-track" data-replay-track aria-hidden="true"><span class="replay-progress" data-replay-progress></span></div><div class="replay-ticks" data-replay-ticks aria-hidden="true"></div></div>
            <ol class="replay-events" data-replay-events data-replay-timeline aria-label="Replay events"></ol>
          </details>
          <div class="status-bar" role="status"><span class="status-transport"><span data-live-state data-state="stale"><span data-live-state-label>未更新</span></span></span><span class="status-title" data-live-status-title>等待运行</span><span><strong data-live-run-progress>${EMPTY_PLACEHOLDER}</strong> · <span data-live-run-stage>观测中</span></span><span class="status-nodes"><span data-live-run-workers>${EMPTY_PLACEHOLDER}</span> · <span data-live-node-count>0 个节点</span></span><span class="status-camera"><span data-i18n-en="Camera" data-i18n-zh="相机">相机</span> <strong data-live-camera-mode>跟随</strong></span><span class="sr-only" data-live-run-started>${EMPTY_PLACEHOLDER}</span><span class="sr-only" data-live-run-updated>${EMPTY_PLACEHOLDER}</span><span class="sr-only" data-live-source>本地观察器</span></div>
        </section>
        <aside class="panel evidence-panel" id="live-inspector" data-live-inspector data-open="false" aria-hidden="true" aria-labelledby="evidence-title">
          <header class="panel-header"><div><p class="kicker" data-i18n-en="Inspector" data-i18n-zh="检查器">检查器</p><h2 class="panel-title" id="evidence-title" data-i18n-en="Inspector" data-i18n-zh="检查器">检查器</h2></div><div class="replay-controls"><span class="panel-count" data-live-evidence-count>00</span><button class="graph-tool-button" type="button" data-live-inspector-close aria-label="Close inspector" title="Close inspector">×</button></div></header>
          <div class="inspector-tabs" role="tablist" aria-label="Inspector sections"><button type="button" role="tab" id="inspector-tab-summary" aria-controls="inspector-panel-summary" aria-selected="true" data-live-inspector-tab="summary" data-i18n-en="Summary" data-i18n-zh="摘要">摘要</button><button type="button" role="tab" id="inspector-tab-evidence" aria-controls="inspector-panel-evidence" aria-selected="false" tabindex="-1" data-live-inspector-tab="evidence" data-i18n-en="Evidence" data-i18n-zh="证据">证据</button><button type="button" role="tab" id="inspector-tab-terminal" aria-controls="inspector-panel-terminal" aria-selected="false" tabindex="-1" data-live-inspector-tab="terminal" data-i18n-en="Tools" data-i18n-zh="工具">工具</button><button type="button" role="tab" id="inspector-tab-context" aria-controls="inspector-panel-context" aria-selected="false" tabindex="-1" data-live-inspector-tab="context" data-i18n-en="Decisions" data-i18n-zh="决策">决策</button></div>
          <div class="inspector-panel" id="inspector-panel-summary" role="tabpanel" aria-labelledby="inspector-tab-summary" data-live-inspector-panel="summary" data-item-count="0"><div class="selected-node-summary" data-live-selected-node aria-live="polite"><strong data-live-selected-node-label>选择节点查看来源与依据</strong><div class="selected-node-facts"><span data-live-selected-node-status>状态 · ${EMPTY_PLACEHOLDER}</span><span data-live-selected-node-owner>负责人 · ${EMPTY_PLACEHOLDER}</span><span data-live-selected-node-runtime>运行时 · ${EMPTY_PLACEHOLDER}</span><span data-live-selected-node-model>模型 · ${EMPTY_PLACEHOLDER}</span><span data-live-selected-node-duration>耗时 · ${EMPTY_PLACEHOLDER}</span><span data-live-selected-node-tools>工具 · ${EMPTY_PLACEHOLDER}</span><span data-live-selected-node-tokens>输出 · ${EMPTY_PLACEHOLDER}</span></div><p data-live-selected-node-summary>选择节点查看执行摘要。</p><p data-live-selected-node-evidence-detail>选择节点后将在这里显示终态依据。</p><p data-live-selected-node-provenance>来源 · ${EMPTY_PLACEHOLDER}</p><p data-live-selected-node-prompt>提示词阶段 · ${EMPTY_PLACEHOLDER}</p><p data-live-selected-node-loadout>能力装载 · ${EMPTY_PLACEHOLDER}</p><span data-live-selected-node-evidence>证据会持续显示在抽屉中</span></div></div>
          <div class="inspector-panel evidence-drawer" id="inspector-panel-terminal" role="tabpanel" aria-labelledby="inspector-tab-terminal" data-live-inspector-panel="terminal" data-item-count="0" hidden><div class="evidence-list" data-live-terminal-list role="list" aria-label="Terminal evidence"></div></div>
          <div class="inspector-panel evidence-drawer" id="inspector-panel-evidence" role="tabpanel" aria-labelledby="inspector-tab-evidence" data-live-inspector-panel="evidence" data-item-count="0" data-evidence-drawer hidden><div class="evidence-list" data-live-conversation-list role="list" aria-label="Conversation summaries"></div><div class="evidence-list" data-live-changes-list role="list" aria-label="Observed changes"></div><div class="evidence-list" data-live-evidence-list role="list" aria-label="Observed evidence"></div></div>
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
      <section class="empty-state" data-live-empty hidden aria-labelledby="empty-title"><span class="empty-glyph" aria-hidden="true">${fixedUiIcon("inbox", "empty-state-icon")}</span><h2 class="empty-title" id="empty-title" data-i18n-en="No live snapshot yet" data-i18n-zh="尚无实时快照">尚无实时快照</h2><p class="empty-copy" data-live-empty-message>正在等待本地观察器发布运行快照。</p></section>
    </main>
    <section class="live-dialog" data-live-dialog data-live-sessions-dialog role="dialog" aria-modal="true" aria-labelledby="sessions-title" aria-hidden="true" hidden>
      <div class="dialog-card run-record-dialog">
        <header class="dialog-header"><h2 class="dialog-title" id="sessions-title" data-i18n-en="Run records" data-i18n-zh="运行记录">运行记录</h2><button class="graph-tool-button" type="button" data-live-dialog-close aria-label="Close run records">×</button></header>
        <div class="dialog-body">
          <div class="run-record-guide"><strong data-i18n-en="These are Meta_Kim run records, not your chat list." data-i18n-zh="这里显示的是 Meta_Kim 运行记录，不是聊天列表。">这里显示的是 Meta_Kim 运行记录，不是聊天列表。</strong><span data-i18n-en="Claude Code, Codex, Cursor, and OpenClaw records are linked only when the runtime saved a title and conversation identifier. Otherwise they stay in the unlinked group and can be located by time and run ID." data-i18n-zh="Claude Code、Codex、Cursor、OpenClaw 只有在运行时保存了标题和会话标识后才会关联；否则会留在未关联分组，只能按时间和运行 ID 定位。">Claude Code、Codex、Cursor、OpenClaw 只有在运行时保存了标题和会话标识后才会关联；否则会留在未关联分组，只能按时间和运行 ID 定位。</span></div>
          <section class="hub-switcher" aria-label="Meta_Kim project and run record selection">
            <label class="hub-field" for="live-project-select"><span data-i18n-en="Project" data-i18n-zh="项目">项目</span><select class="hub-select" id="live-project-select" data-live-project-select aria-label="Choose a Meta_Kim project"><option value="">正在加载已登记项目…</option></select></label>
            <label class="hub-field" for="live-session-select"><span data-i18n-en="Current run record" data-i18n-zh="当前运行记录">当前运行记录</span><select class="hub-select" id="live-session-select" data-live-session-select aria-label="Choose a governed run record" disabled><option value="">请先选择项目</option></select></label>
            <label class="hub-field hub-search" for="live-session-search"><span data-i18n-en="Search title, date, or run ID" data-i18n-zh="搜索标题、日期或运行 ID">搜索标题、日期或运行 ID</span><input class="hub-select" id="live-session-search" data-live-session-search type="search" maxlength="120" autocomplete="off" placeholder="例如：课程、08/30、E126426F"></label>
            <p class="hub-status" data-live-hub-status role="status" aria-live="polite">正在加载本地项目目录…</p>
          </section>
          <div class="session-list" data-live-session-list role="list" aria-label="Governed run records"></div>
        </div>
      </div>
    </section>
    <section class="live-dialog" data-live-dialog data-live-help-dialog role="dialog" aria-modal="true" aria-labelledby="help-title" aria-hidden="true" hidden><div class="dialog-card"><header class="dialog-header"><h2 class="dialog-title" id="help-title" data-i18n-en="Keyboard and camera" data-i18n-zh="键盘与相机">键盘与相机</h2><button class="graph-tool-button" type="button" data-live-dialog-close aria-label="Close help">×</button></header><div class="dialog-body"><div class="shortcut-grid"><div><span>Overview</span><kbd>O</kbd></div><div><span>Follow active</span><kbd>F</kbd></div><div><span>Relayout</span><kbd>R</kbd></div><div><span>Play / pause</span><kbd>Space</kbd></div><div><span>Previous event</span><kbd>[</kbd></div><div><span>Next event</span><kbd>]</kbd></div><div><span>Jump live</span><kbd>End</kbd></div><div><span>Session info</span><kbd>I</kbd></div><div><span>Close</span><kbd>Esc</kbd></div><div><span>Help</span><kbd>?</kbd></div></div></div></div></section>
    <section class="live-dialog" data-live-dialog data-live-info-dialog role="dialog" aria-modal="true" aria-labelledby="info-title" aria-hidden="true" hidden><div class="dialog-card"><header class="dialog-header"><h2 class="dialog-title" id="info-title" data-i18n-en="Session info and local tools" data-i18n-zh="会话信息与本地工具">会话信息与本地工具</h2><button class="graph-tool-button" type="button" data-live-dialog-close aria-label="Close session info">×</button></header><div class="dialog-body"><p class="panel-note"><span data-i18n-en="Local observer" data-i18n-zh="本地观察器">本地观察器</span> · <span data-live-last-update>最近观测 ${EMPTY_PLACEHOLDER}</span> · <span data-i18n-en="Read-only by default" data-i18n-zh="默认只读">默认只读</span></p><div class="info-facts" data-live-info-facts></div><div data-live-info-tools></div></div></div></section>
  </div>
  <script type="application/json" id="live-initial-snapshot">${initialJson}</script>
  <script type="application/json" id="live-initial-catalog">${initialCatalogJson}</script>
  <script type="application/json" id="live-control-config">${controlConfigJson}</script>
  <script>${CLIENT_SCRIPT}</script>
</body>
</html>`;
}
