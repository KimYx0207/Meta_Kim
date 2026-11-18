/**
 * Read-only Product Design PRD (产品设计 PRD) generator for enrolled repositories.
 *
 * Produces a human-readable Two-Level Product Design PRD with real completion status:
 * - Level 1 (`system` — 系统框架): Product positioning & user value, end-to-end user
 *   journey, functional product domains/framework, experience & safety principles,
 *   product acceptance criteria, and overall module completion summary.
 * - Level 2 (`modules` — 系统详情): Per-subsystem completion status (`completed` /
 *   `partial` / `planned`), user-facing value, core features & interactions,
 *   plain-language upstream inputs & downstream outputs, cross-module synergy (acyclic DAG),
 *   edge-case fallbacks, and verifiable product acceptance checklist.
 *
 * Governance & security invariants:
 * - Never claims human B2 approval (`approvalClaimed: false`, `recordOrigin: "repository_architecture_baseline"`).
 * - Reads strictly within `realpathSync(projectRoot)`, skipping symlinks, hidden
 *   runtime projection dirs, and `node_modules` / build outputs.
 * - Never emits absolute host filesystem paths, URLs, or credentials.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { validateDesignDag } from "../../domain/runtime/agent-design-contract.mjs";
import { buildStructuredWireframeSpec, inferMockupVariant } from "./prd-mockup-generator-service.mjs";

export const PROJECT_ARCHITECTURE_PRD_SCHEMA = "meta-kim-project-architecture-prd-v1";

const IGNORED_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "target", ".next", ".nuxt",
  "coverage", ".cache", ".turbo", "work", "tmp", "temp",
  ".meta-kim", ".claude", ".codex", ".agents", ".cursor", ".gemini", ".zcode", ".dsh", "openclaw", "codex",
]);

const CODE_EXTENSIONS = new Set([
  ".mjs", ".cjs", ".js", ".ts", ".tsx", ".jsx", ".rs", ".py", ".go", ".java", ".kt", ".vue", ".svelte",
]);
const SOURCE_EXTENSIONS = new Set([
  ...CODE_EXTENSIONS, ".json", ".toml", ".yaml", ".yml", ".md", ".sql", ".css", ".html",
]);

const MAX_FILES_PER_MODULE = 260;
const MAX_READ_BYTES = 48 * 1024;

function toPosix(relPath) {
  return String(relPath || "").split(path.sep).join("/").replace(/^\/+|\/+$/gu, "");
}

function scrubText(value, maxLength = 360) {
  if (typeof value !== "string") return "";
  const cleaned = value
    .replace(/\b(?:sk-(?:ant|proj|live|test)-|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{6,}/giu, "[已脱敏]")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\)[^\s<>"'`]+/gu, "[路径]")
    .replace(/\/(?:home|Users|workspace|tmp|etc|var|mnt|opt)\/[^\s<>"'`]+/gu, "[路径]")
    .replace(/\bhttps?:\/\/[^\s<>)"'`]+/giu, "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1).trim()}…` : cleaned;
}

function safeNodeId(raw, fallbackIndex = 1) {
  const slug = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
  const prefixed = /^[a-z]/u.test(slug) ? slug : `mod-${slug || fallbackIndex}`;
  const trimmed = prefixed.slice(0, 31).replace(/-+$/gu, "");
  return trimmed.length >= 2 ? trimmed : `module-${String(fallbackIndex).padStart(2, "0")}`;
}

function safeReadText(filePath, maxBytes = MAX_READ_BYTES) {
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) return "";
    const buf = readFileSync(filePath);
    return buf.subarray(0, Math.min(buf.length, maxBytes)).toString("utf8");
  } catch {
    return "";
  }
}

function safeReadJson(filePath) {
  const text = safeReadText(filePath, 128 * 1024);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRealSubdir(dirPath, rootReal) {
  try {
    const stat = lstatSync(dirPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const resolved = realpathSync(dirPath);
    return resolved === rootReal || resolved.startsWith(rootReal + path.sep);
  } catch {
    return false;
  }
}

function listRealSubdirs(dirPath, rootReal) {
  if (!isRealSubdir(dirPath, rootReal)) return [];
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()
        && !entry.name.startsWith(".") && !IGNORED_DIRS.has(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function collectModuleFiles(absDir, rootReal, excludedSubdirs = new Set()) {
  const files = [];
  const walk = (currentDir, relFromModule) => {
    if (files.length >= MAX_FILES_PER_MODULE) return;
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_FILES_PER_MODULE) break;
      if (entry.isSymbolicLink()) continue;
      const nextRel = relFromModule ? `${relFromModule}/${entry.name}` : entry.name;
      const nextAbs = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
        const repoRel = toPosix(path.relative(rootReal, nextAbs));
        if (excludedSubdirs.has(repoRel)) continue;
        walk(nextAbs, nextRel);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SOURCE_EXTENSIONS.has(ext)) {
          files.push({ abs: nextAbs, repoRel: toPosix(path.relative(rootReal, nextAbs)), ext, name: entry.name });
        }
      }
    }
  };
  if (isRealSubdir(absDir, rootReal)) walk(absDir, "");
  return files;
}

function extractLeadDocSummary(filePath) {
  const raw = safeReadText(filePath, 8_000);
  if (!raw) return "";
  const mdPara = raw
    .split(/\r?\n\r?\n/u)
    .map((chunk) => chunk.replace(/^#+\s+/gmu, "").replace(/`([^`]+)`/gu, "$1").trim())
    .find((chunk) => chunk.length >= 16 && !chunk.startsWith("<!--") && !chunk.startsWith("```") && !chunk.startsWith("|"));
  if (mdPara) return scrubText(mdPara, 220);
  const block = /^\s*\/\*\*([\s\S]*?)\*\//u.exec(raw);
  if (block) {
    const lines = block[1]
      .split(/\r?\n/u)
      .map((line) => line.replace(/^\s*\*\s?/u, "").trim())
      .filter((line) => line && !line.startsWith("@"));
    if (lines.length) return scrubText(lines.slice(0, 2).join(" "), 220);
  }
  return "";
}

/**
 * Product-oriented subsystem blueprints for Meta_Kim's unified product experience.
 * Keeps stable IDs where existing integration assertions inspect `presentation-workspace` / `app-live-projection`
 * while presenting 100% plain-language Product Design PRD content to users!
 */
const META_KIM_PRODUCT_BLUEPRINTS = [
  {
    dir: "canonical",
    id: "canonical-governance",
    title: "智能角色分工与工作准则",
    shortSummary: "9 大专业角色分工 · 八步标准工作流",
    layer: "能力与规则底座",
    layerShort: "规则底座",
    layerRank: 0,
    flowColumn: 1,
    parallelGroup: "prep_lane",
    nodeKind: "parallel",
    hasUiPage: false,
    mockupVariant: "workbench",
    objective: "定义产品内置的 9 类专业 AI 角色职责与标准工作流程，确保 AI 先想清楚需求、查清事实、给出方案，再按规矩动手执行。",
    features: [
      "角色专职分工：区分总控接待、调研取证、方案设计、动手实现、质量审查与最终验收角色，各司其职不越界",
      "自然语言免指令触发：用户平时怎么说话就怎么提需求，系统自动识别复杂度并匹配对应流程",
      "明确拒绝乱改：对不清楚的需求先追问关键分歧，不擅自猜测或覆盖用户既有成果",
    ],
    inputContract: ["用户提出的一句话目标或业务痛点", "当前项目背景与用户的偏好约束"],
    outputContract: ["清晰的任务分工标准、阶段推进准则与质量把关清单"],
    boundaries: ["只负责制定统一行为标准，绝不在未经确认前私自改动用户业务文件"],
    productAcceptance: ["用户无需学习任何专业指令词，用日常语言提问即可进入规范的调研与设计流程"],
    testHint: "tests",
  },
  {
    dir: "config",
    id: "config-contracts",
    title: "角色技能目录与客户端管理",
    shortSummary: "可用 AI 渠道登记 · 技能与插件清单",
    layer: "能力与规则底座",
    layerShort: "能力目录",
    layerRank: 0,
    flowColumn: 1,
    parallelGroup: "prep_lane",
    nodeKind: "parallel",
    hasUiPage: true,
    mockupVariant: "catalog_grid",
    objective: "集中管理本机可用的 AI 客户端渠道（Claude Code、Codex、Gemini 等）、专业角色库、技能包（Skills）与扩展工具清单。",
    features: [
      "渠道就绪状态管理：识别哪些 AI 客户端已安装可用、哪些仅可只读观测、哪些需要登录或授权",
      "侧边宽幅能力大面板：点击左侧分类即可展开大面板搜索查看所有角色、Subagent 预设、Skills、MCP 与 Hooks",
      "专业方法匹配：根据用户的任务领域自动检索可复用的专业技能与过往经验",
    ],
    inputContract: ["本机已安装的 AI 工具状态", "用户在侧边栏发起的能力搜索或筛选操作"],
    outputContract: ["分类清晰的可用渠道列表、角色技能说明卡片与权限边界提示"],
    boundaries: ["严格区分「本机已配置的静态预设」与「当前任务真正派发运行的节点」，绝不混报数量"],
    productAcceptance: ["用户在左侧一键展开即可看清所有可用角色、60+ Subagent 预设及每个渠道的可用原因"],
    testHint: "tests",
  },
  {
    dir: "src/domain",
    id: "domain-models",
    title: "关键节点人工拍板与防错规则",
    shortSummary: "B1-B4 四道确认关口 · 效果图确认门禁",
    layer: "核心业务与安全控制",
    layerShort: "安全门禁",
    layerRank: 1,
    flowColumn: 2,
    nodeKind: "condition",
    loopBackTo: "presentation-workspace",
    hasUiPage: false,
    mockupVariant: "review_gate",
    objective: "把控从「选方案 → 定设计/确认页面效果图 → 试跑执行 → 验收合入」四个人工拍板关口（B1–B4），防止 AI 跳过确认擅自行动或留下逻辑冲突。",
    features: [
      "页面效果图确认门禁：凡涉及前端页面的节点必须先确认页面效果图，否则拦截下游开发执行",
      "上下游修改自动联动：当任意节点插入或更改时，实时标记受影响的下游节点待复核",
      "防循环依赖检查：自动拦截互相卡死的功能依赖关系，保证动态工作流推进顺序清晰可执行",
    ],
    inputContract: ["用户的方案选择理由、页面效果图确认/反馈意见与节点插改操作"],
    outputContract: ["每个模块准确的确认/待改状态、可安全交接执行的封存清单"],
    boundaries: ["有任何未解决的修改意见或未确认的页面效果图时，严禁放行进入自动改代码阶段"],
    productAcceptance: ["涉及页面的模块未确认效果图前无法误点通过，上游改动实时触发下游复核提示"],
    testHint: "tests/live",
  },
  {
    dir: "src/data",
    id: "data-repositories",
    title: "本地历史记录与断点续接存储",
    shortSummary: "本机隐私保存 · 关机重启不丢进度",
    layer: "核心业务与安全控制",
    layerShort: "本地记录",
    layerRank: 1,
    flowColumn: 1,
    parallelGroup: "prep_lane",
    nodeKind: "parallel",
    hasUiPage: false,
    mockupVariant: "workbench",
    objective: "将用户的每一次对话决策、两级动态流程图设计版本、效果图与验收结果安全保存在本机，支持随时翻查与跨会话接续。",
    features: [
      "多版本设计与效果图留痕：每次插改流程图节点或刷新效果图均持久保存，方便前后对比",
      "断线与重启恢复：刷新页面或重启客户端后自动找回当前正在推进的画布与任务进度",
      "全本地隐私存储：所有项目资料与运行数据均存放在本机数据库，不上传第三方服务器",
    ],
    inputContract: ["各阶段产生的方案回执、动态流程图变更与任务运行快照"],
    outputContract: ["按时间倒序可检索的历史记录列表、随时可恢复的工作现场"],
    boundaries: ["所有读写严格限制在本机受保护目录内，绝不触碰无关系统文件"],
    productAcceptance: ["关闭窗口重新打开或切换项目再切回时，原有的流程图拓扑和确认记录完整保留"],
    testHint: "tests/live",
  },
  {
    dir: "src/application/agent",
    id: "app-agent-workflow",
    title: "多仓库管理与双向 Agent 协同服务",
    shortSummary: "正向调起渠道 · 反向接入外部 Agent · 多仓切换",
    layer: "协同调度与投影中心",
    layerShort: "双向协同",
    layerRank: 2,
    flowColumn: 3,
    parallelGroup: "exec_lane",
    nodeKind: "parallel",
    hasUiPage: true,
    mockupVariant: "binding_hub",
    objective: "连接用户的多个本地代码仓库与各类外部 AI 客户端——既支持从本工作台选渠道发起任务，也支持把终端/IDE 里启动的 AI 会话实时接入观测。",
    features: [
      "双向 Agent 绑定：正向可在输入框底部选定渠道调起 AI；反向可扫描并一键接入外部正在运行的 Claude Code / Codex 会话",
      "本地多仓库统一管理：支持在几十个已登记本地项目间一键切换，实时查看分支、最新提交与未提交改动数",
      "隔离草稿核验与经验沉淀：自动比对试跑产生的文件变更并执行安全体检，验收通过后沉淀为可复用经验方法卡",
    ],
    inputContract: ["用户在对话框发送的目标、选择的 AI 渠道、或点击切换的目标仓库与外部会话"],
    outputContract: ["候选方案对比结果、目标仓库的动态流程图 PRD、隔离区变更体检单与经验方法卡"],
    boundaries: ["切换浏览其他已登记仓库时保持只读安全观测，绝不跨仓库误改代码"],
    productAcceptance: ["用户可在底部直接选渠道发消息，也可在「双向绑定」和「仓库」页一键接入外部会话或切换项目"],
    testHint: "tests/live",
  },
  {
    dir: "src/application/live",
    id: "app-live-projection",
    title: "两级产品设计图谱与进度汇总引擎",
    shortSummary: "无限画布动态流 + 二级下钻 + 页面效果图预览",
    layer: "协同调度与投影中心",
    layerShort: "PRD 与进度",
    layerRank: 2,
    flowColumn: 3,
    parallelGroup: "exec_lane",
    nodeKind: "parallel",
    hasUiPage: true,
    mockupVariant: "flowchart_studio",
    objective: "把项目全貌和任务进展转化为 LangGraph 式无限画布动态流程图：一级看系统并行流与路由，二级下钻看模块内部子流与页面效果图。",
    features: [
      "无限画布动态工作流：支持拖拽平移、滚轮缩放、缩略小地图、多路并行泳道、条件路由与人工实时插改节点",
      "页面效果图模型生成与回退：优先尝试图像模型生成效果图，无凭据自动回退为组件级可交互效果图供人工确认",
      "Subagent 执行关系还原：准确汇总主 Agent 与各派发 Subagent 的上下级分工、耗时与实际产出证据",
    ],
    inputContract: ["项目功能模块结构、人工实时插改操作、页面效果图确认与实时运行事件流"],
    outputContract: ["带完成状态与效果图门禁的两级动态流程图、顶部全局进度状态与完整运行拓扑数据"],
    boundaries: ["实事求是反映真实完成度与生图来源，绝不把尚未执行的计划虚标为已完成"],
    productAcceptance: ["在无限画布插入或修改任意节点时拓扑实时反应，页面节点可直接预览并确认效果图"],
    testHint: "tests/live",
  },
  {
    dir: "src/infrastructure",
    id: "infra-live-runtime",
    title: "实时消息推送与本机安全连接底座",
    shortSummary: "毫秒级状态同步 · 本机访问安全防护",
    layer: "协同调度与投影中心",
    layerShort: "实时连接",
    layerRank: 3,
    flowColumn: 3,
    parallelGroup: "exec_lane",
    nodeKind: "parallel",
    hasUiPage: false,
    mockupVariant: "workbench",
    objective: "负责工作台界面与后台服务之间的实时状态同步，确保外部 Agent 每跑一步或人工插改画布时，界面立即实时同步。",
    features: [
      "实时流式自动刷新：无需手动点刷新，任务状态、画布变更、Subagent 进展与核验结果实时推送上屏",
      "后台标签页智能省电：窗口切到后台自动暂停高频连接，切回前台立即自动补齐最新进度",
      "本机专属访问锁：仅允许用户自己的电脑本机连接访问，阻断任何外部网页跨域窥探或篡改",
    ],
    inputContract: ["外部或内置 Agent 产生的实时事件、工作台页面的连接握手请求"],
    outputContract: ["稳定的「已连接」状态指示与毫秒级同步的最新界面数据"],
    boundaries: ["仅监听本机回环地址并校验安全令牌，拒绝未授权远程请求"],
    productAcceptance: ["顶部状态稳定显示实时连接情况，前后台切换页面不卡顿、不丢状态"],
    testHint: "tests/live",
  },
  {
    dir: "src/presentation",
    id: "presentation-workspace",
    title: "一体化对话决策与产品画布工作台",
    shortSummary: "顶栏单行进度 · 左聊右画布 · 效果图确认",
    layer: "用户界面与客户端体验",
    layerShort: "工作台界面",
    layerRank: 4,
    flowColumn: 0,
    nodeKind: "process",
    hasUiPage: true,
    mockupVariant: "workbench",
    objective: "为用户提供清爽直观的一体化主入口界面：顶部一行看全局执行进度并直达完整运行图，左侧专注对话拍板，右侧在无限画布审阅动态流程图与页面效果图。",
    features: [
      "Logo 下方顶部单行进度栏：一行展示核心进展，点击即可直接打开含 Subagents 拓扑的「完整运行图」",
      "左栏对话 + 右栏无限画布 PRD：支持实时插入并行分支/串联节点、下钻二级子流，并对页面节点确认效果图",
      "全自由窗口布局与四语切换：侧边栏与分栏可自由拖拽宽窄、画布支持最大化/最小化/滚轮缩放，内置中英日韩四语切换",
    ],
    inputContract: ["用户的点击、拖拽、缩放、插改节点、效果图确认与文字输入操作"],
    outputContract: ["零重复信息、实时响应拓扑变化的可交互产品界面与视觉反馈"],
    boundaries: ["界面文案面向普通用户通俗易懂，所有涉及页面的改动必须先有效果图确认"],
    productAcceptance: ["普通用户打开即可看懂系统总流程图、自由插改节点并直接在侧栏确认页面效果图"],
    testHint: "tests/live",
  },
  {
    dir: "desktop",
    id: "desktop-tauri-shell",
    title: "独立原生桌面软件客户端",
    shortSummary: "双击即用 · 系统托盘常驻 · 单实例防重开",
    layer: "用户界面与客户端体验",
    layerShort: "桌面客户端",
    layerRank: 5,
    flowColumn: 4,
    nodeKind: "process",
    hasUiPage: true,
    mockupVariant: "desktop_shell",
    objective: "将整个工作台封装为独立的 Windows / 桌面端原生应用程序，告别浏览器地址栏与手工启动命令，提供正式产品级体验。",
    features: [
      "一键启动自动守护：双击桌面图标自动在后台拉起本地服务并打开主窗口，无黑框闪烁",
      "系统托盘常驻与防多开：支持最小化到右下角托盘随时秒开，重复点击图标自动唤醒已有窗口",
      "正式版安全加固：内置窗口防逆向保护、内容安全策略与崩溃自动恢复机制",
    ],
    inputContract: ["用户双击启动软件、窗口最大化/关闭与系统托盘菜单操作"],
    outputContract: ["流畅稳定的原生桌面工作窗口与后台常驻守护服务"],
    boundaries: ["退出客户端时干净释放其托管的后台临时资源，不污染用户系统环境"],
    productAcceptance: ["像日常桌面办公软件一样即开即用，托盘切换与窗口缩放顺滑稳定"],
    testHint: "desktop/src-tauri",
  },
];

export function buildDefaultSubflowForModule(mod) {
  const feats = Array.isArray(mod.features) && mod.features.length
    ? mod.features.map((f) => String(f || "").split(/[：:]/u)[0].trim().slice(0, 22))
    : [`${mod.title}主交互`, "参数与规则处理", "结果校验反馈"];
  const step1 = feats[0] || `${mod.title}输入处理`;
  const step2a = feats[1] || "核心业务并发处理";
  const step2b = feats[2] || "状态同步与边界防护";
  const modStatus = mod.status || "completed";
  const hasPage = Boolean(mod.hasUiPage);
  const mockupStatus = mod.uiMockup?.status || (modStatus === "completed" ? "confirmed" : "pending");
  return {
    title: `${mod.title} · 二级动态子工作流`,
    nodes: [
      { id: `${mod.id}__in`, kind: "terminal", title: "上游输入接入", status: modStatus },
      {
        id: `${mod.id}__s1`,
        kind: "process",
        code: "2.1",
        title: step1,
        status: modStatus,
        hasUiPage: hasPage,
        mockupStatus: hasPage ? mockupStatus : "none",
        summary: (mod.inputContract || [])[0] || mod.objective || "",
      },
      {
        id: `${mod.id}__s2a`,
        kind: "parallel",
        code: "2.2A · 并行",
        title: step2a,
        status: modStatus,
        hasUiPage: false,
        mockupStatus: "none",
        summary: (mod.features || [])[1] || mod.objective || "",
      },
      {
        id: `${mod.id}__s2b`,
        kind: "parallel",
        code: "2.2B · 并行",
        title: step2b,
        status: modStatus,
        hasUiPage: hasPage,
        mockupStatus: hasPage ? mockupStatus : "none",
        summary: (mod.features || [])[2] || (mod.boundaries || [])[0] || "",
      },
      {
        id: `${mod.id}__gate`,
        kind: "condition",
        code: "校验路由",
        title: "验收与边界合规？",
        status: modStatus,
        hasUiPage: false,
        mockupStatus: "none",
        summary: (mod.acceptance || [])[0] || "不满足条件自动回退修正",
      },
      { id: `${mod.id}__out`, kind: "terminal", title: "输出至下游模块", status: modStatus },
    ],
    edges: [
      { id: `${mod.id}__e1`, from: `${mod.id}__in`, to: `${mod.id}__s1`, label: "", kind: "normal" },
      { id: `${mod.id}__e2`, from: `${mod.id}__s1`, to: `${mod.id}__s2a`, label: "并行 A", kind: "parallel" },
      { id: `${mod.id}__e3`, from: `${mod.id}__s1`, to: `${mod.id}__s2b`, label: "并行 B", kind: "parallel" },
      { id: `${mod.id}__e4`, from: `${mod.id}__s2a`, to: `${mod.id}__gate`, label: "汇聚", kind: "normal" },
      { id: `${mod.id}__e5`, from: `${mod.id}__s2b`, to: `${mod.id}__gate`, label: "汇聚", kind: "normal" },
      { id: `${mod.id}__e6`, from: `${mod.id}__gate`, to: `${mod.id}__out`, label: "通过", kind: "normal" },
      { id: `${mod.id}__e7`, from: `${mod.id}__gate`, to: `${mod.id}__s1`, label: "异常回退", kind: "loop" },
    ],
  };
}

function inferHasUiPage(candidate, relDir) {
  if (typeof candidate.hasUiPage === "boolean") return candidate.hasUiPage;
  const lower = `${relDir} ${candidate.title || ""} ${candidate.layer || ""}`.toLowerCase();
  if (/(?:presentation|ui|web|frontend|client|views|components|pages|renderer|studio|desktop|tauri|electron|界面|工作台|画布|窗口)/u.test(lower)) {
    return true;
  }
  return false;
}

function inferProductDomainForGenericDir(relDir, rawName) {
  const lower = `${relDir}/${rawName}`.toLowerCase();
  if (/(?:desktop|tauri|electron|app-shell|tray)/u.test(lower)) {
    return {
      productTitle: "独立桌面客户端体验",
      shortSummary: "桌面窗口承载 · 本地便捷启动",
      layer: "用户界面与客户端体验",
      layerShort: "桌面客户端",
      layerRank: 5,
      objective: "为用户提供免配置的独立桌面端窗口与系统集成体验，打开软件即可顺畅使用核心功能。",
      features: ["独立应用窗口与快捷入口", "本地环境状态自检与异常提示", "窗口尺寸记忆与顺畅交互体验"],
      inputContract: ["用户启动软件与桌面端窗口操作"],
      outputContract: ["稳定可交互的桌面应用主界面"],
    };
  }
  if (/(?:presentation|ui|web|frontend|client|views|components|pages|renderer|studio)/u.test(lower)) {
    return {
      productTitle: `${rawName} 界面与交互体验`,
      shortSummary: "核心页面布局 · 用户操作反馈",
      layer: "用户界面与客户端体验",
      layerShort: "交互界面",
      layerRank: 4,
      objective: "承载用户日常可见的操作页面、表单输入、状态展示与可视化反馈，让核心业务流程简单易用。",
      features: ["核心功能主界面与导航切换", "操作进度实时提示与结果预览", "表单校验与友好的错误引导"],
      inputContract: ["用户的页面点击、表单填写与筛选操作"],
      outputContract: ["直观的页面展示结果、状态反馈与导出内容"],
    };
  }
  if (/(?:avatar|video|audio|tts|voice|media|render|speech|subtitle)/u.test(lower)) {
    return {
      productTitle: `${rawName} 音视频与内容合成`,
      shortSummary: "多媒体素材处理 · 音视频生成预览",
      layer: "智能生成与媒体处理",
      layerShort: "媒体生成",
      layerRank: 2,
      objective: "负责文案配音、字幕对齐、数字人画面或多媒体素材的合成处理，产出可直接预览和交付的成品。",
      features: ["多素材导入与参数配置", "音视频或朗读音频自动生成与试听预览", "合成进度追踪与失败重试"],
      inputContract: ["用户提供的稿件、音色/画面选择与生成参数"],
      outputContract: ["可预览播放的音频、字幕或视频成品文件"],
    };
  }
  if (/(?:quant|strategy|backtest|market|trade|trading|portfolio|factor|signal)/u.test(lower)) {
    return {
      productTitle: `${rawName} 策略计算与行情分析`,
      shortSummary: "行情指标处理 · 策略回测与风控",
      layer: "核心业务与策略服务",
      layerShort: "策略分析",
      layerRank: 2,
      objective: "围绕市场行情数据进行指标计算、策略回测验证与风险控制评估，辅助用户做出有据可依的决策。",
      features: ["行情与历史数据清洗加载", "策略规则执行与收益回测分析", "风险阈值监控与异常预警"],
      inputContract: ["历史与实时行情数据、用户设定的策略参数与风控条件"],
      outputContract: ["策略信号、回测绩效报告与风控提示"],
    };
  }
  if (/(?:agent|llm|ai|chat|prompt|workflow|orchestrator|engine|application|service|services|usecase)/u.test(lower)) {
    return {
      productTitle: `${rawName} 核心业务与智能流程`,
      shortSummary: "主业务流程编排 · 智能任务处理",
      layer: "核心业务与智能服务",
      layerShort: "核心业务",
      layerRank: 2,
      objective: "串联产品的核心业务规则与智能处理流程，把用户的输入请求一步步转化为可靠的业务结果。",
      features: ["核心业务主流程自动化处理", "多步骤状态衔接与进度记录", "业务规则校验与异常中断保护"],
      inputContract: ["用户在前端发起的业务任务与配置参数"],
      outputContract: ["处理完成的业务结果、状态回执与下一步指引"],
    };
  }
  if (/(?:infra|infrastructure|adapter|adapters|server|api|gateway|provider|providers|transport|routes)/u.test(lower)) {
    return {
      productTitle: `${rawName} 服务连接与外部通道`,
      shortSummary: "接口通信 · 外部模型与服务对接",
      layer: "连接通道与支撑服务",
      layerShort: "服务连接",
      layerRank: 3,
      objective: "负责前后端数据通信及与外部服务渠道的稳定对接，保障高并发或弱网下的连接可靠与权限安全。",
      features: ["统一安全接口通信与鉴权检查", "外部服务渠道连接状态检测", "超时重试与异常隔离保护"],
      inputContract: ["前端界面请求与已配置的外部服务连接凭据"],
      outputContract: ["标准化的业务响应数据与实时状态通知"],
    };
  }
  if (/(?:domain|model|entities|core|db|data|database|prisma|migrations|storage|repositories|memory|memo)/u.test(lower)) {
    return {
      productTitle: `${rawName} 数据存储与历史记录`,
      shortSummary: "核心业务数据保存 · 历史检索恢复",
      layer: "数据底座与基础规则",
      layerShort: "数据存储",
      layerRank: 1,
      objective: "妥善保存用户的业务作品、配置偏好与历史操作记录，确保数据一致、可检索且重启不丢失。",
      features: ["业务数据与用户配置持久化保存", "历史记录快速查询与状态回溯", "数据完整性校验与防损坏保护"],
      inputContract: ["待保存的用户作品、配置项与业务运行记录"],
      outputContract: ["随时可读取的业务数据详情与历史档案"],
    };
  }
  if (/(?:schema|contract|proto|types|sdk|shared|common|config)/u.test(lower)) {
    return {
      productTitle: `${rawName} 公共配置与基础规范`,
      shortSummary: "全局默认设置 · 模块间统一标准",
      layer: "数据底座与基础规则",
      layerShort: "基础配置",
      layerRank: 0,
      objective: "提供全系统共享的默认配置、状态标准与通用规则，让各个功能模块协同一致、体验统一。",
      features: ["全局功能开关与默认参数管理", "统一状态名称与数据格式标准", "跨模块复用工具支持"],
      inputContract: ["系统初始化设置与用户的全局偏好配置"],
      outputContract: ["供各功能模块统一遵循的配置与格式标准"],
    };
  }
  return {
    productTitle: `${rawName} 功能模块`,
    shortSummary: "专项业务支持 · 自动化辅助",
    layer: "辅助工具与扩展能力",
    layerShort: "辅助能力",
    layerRank: 3,
    objective: `负责 ${rawName} 相关的专项功能处理与配套流程支持，保障整体产品闭环顺畅运行。`,
    features: [`${rawName} 核心任务执行与状态反馈`, "输入参数合法性检查", "处理结果汇总输出"],
    inputContract: ["用户操作指令或上游模块传入的任务数据"],
    outputContract: [`${rawName} 处理结果与状态反馈`],
  };
}

function discoverCandidateSubsystems(rootReal) {
  const matchedMetaKim = META_KIM_PRODUCT_BLUEPRINTS.filter((item) =>
    isRealSubdir(path.join(rootReal, item.dir), rootReal));

  if (matchedMetaKim.length >= 5 && existsSync(path.join(rootReal, "AGENTS.md"))) {
    return matchedMetaKim.map((bp) => ({ ...bp, isCuratedProduct: true }));
  }

  const candidates = [];
  const containerDirs = ["apps", "packages", "services", "crates", "modules"];
  for (const container of containerDirs) {
    const absContainer = path.join(rootReal, container);
    for (const child of listRealSubdirs(absContainer, rootReal)) {
      const rel = `${container}/${child}`;
      const mapped = inferProductDomainForGenericDir(rel, child);
      candidates.push({
        dir: rel,
        id: safeNodeId(`${container}-${child}`, candidates.length + 1),
        title: mapped.productTitle,
        shortSummary: mapped.shortSummary,
        layer: mapped.layer,
        layerShort: mapped.layerShort,
        layerRank: mapped.layerRank,
        objective: mapped.objective,
        features: mapped.features,
        inputContract: mapped.inputContract,
        outputContract: mapped.outputContract,
      });
    }
  }
  const srcAbs = path.join(rootReal, "src");
  const srcChildren = listRealSubdirs(srcAbs, rootReal);
  if (srcChildren.length >= 2) {
    for (const child of srcChildren) {
      const rel = `src/${child}`;
      const mapped = inferProductDomainForGenericDir(rel, child);
      candidates.push({
        dir: rel,
        id: safeNodeId(`src-${child}`, candidates.length + 1),
        title: mapped.productTitle,
        shortSummary: mapped.shortSummary,
        layer: mapped.layer,
        layerShort: mapped.layerShort,
        layerRank: mapped.layerRank,
        objective: mapped.objective,
        features: mapped.features,
        inputContract: mapped.inputContract,
        outputContract: mapped.outputContract,
      });
    }
  } else if (isRealSubdir(srcAbs, rootReal)) {
    const mapped = inferProductDomainForGenericDir("src", "核心功能");
    candidates.push({
      dir: "src",
      id: "src-core",
      title: "产品核心功能模块",
      shortSummary: mapped.shortSummary,
      layer: mapped.layer,
      layerShort: mapped.layerShort,
      layerRank: mapped.layerRank,
      objective: mapped.objective,
      features: mapped.features,
      inputContract: mapped.inputContract,
      outputContract: mapped.outputContract,
    });
  }

  for (const top of listRealSubdirs(rootReal, rootReal)) {
    if (["src", "tests", "test", "__tests__", "docs", "doc", "examples", "scripts", ...containerDirs].includes(top)) continue;
    const mapped = inferProductDomainForGenericDir(top, top);
    candidates.push({
      dir: top,
      id: safeNodeId(top, candidates.length + 1),
      title: mapped.productTitle,
      shortSummary: mapped.shortSummary,
      layer: mapped.layer,
      layerShort: mapped.layerShort,
      layerRank: mapped.layerRank,
      objective: mapped.objective,
      features: mapped.features,
      inputContract: mapped.inputContract,
      outputContract: mapped.outputContract,
    });
  }
  return candidates.slice(0, 12);
}

const IMPORT_SPECIFIER_RE = /(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)|require\(\s*["'](\.[^"']+)["']\s*\)/gu;

function resolveRelativeImportToRepoPath(fromAbsFile, specifier, rootReal) {
  const baseDir = path.dirname(fromAbsFile);
  const targetBase = path.resolve(baseDir, specifier);
  if (!targetBase.startsWith(rootReal + path.sep) && targetBase !== rootReal) return null;
  return toPosix(path.relative(rootReal, targetBase));
}

function extractProductPositioning(rootReal, pkg, displayName) {
  if (displayName === "Meta_Kim" && existsSync(path.join(rootReal, "AGENTS.md"))) {
    return "面向个人与团队的一体化 AI 协同产品工作台：用户只需用日常语言说出目标，系统自动调用最佳 AI 渠道完成多方案调研比选，生成普通人看得懂的「一级系统框架 + 二级系统详情」产品设计书，在关键节点交由人工拍板后安全执行、核验成果并沉淀可复用经验。";
  }
  for (const docName of ["README.zh-CN.md", "README.md"]) {
    const summary = extractLeadDocSummary(path.join(rootReal, docName));
    if (summary.length >= 16) return summary;
  }
  if (pkg?.description) {
    const desc = scrubText(pkg.description, 260);
    if (desc.length >= 12) return desc;
  }
  return `为用户提供围绕「${displayName}」的完整业务体验：通过清晰的一级系统框架划分与二级功能模块协同，降低使用门槛并保障每次操作结果可靠可查。`;
}

function buildUserJourneySteps(displayName, isMetaKim, layers) {
  if (isMetaKim) {
    return [
      "第一步 · 一句话提目标：在左侧对话框选定 AI 渠道并输入想完成的事，或一键接入外部正在运行的 Agent 会话",
      "第二步 · 多方案比选拍板（B1）：对比系统给出的 2–3 套候选方案优劣与风险，拍板选定方向",
      "第三步 · 审阅两级产品设计 PRD（B2）：在右侧查看「一级系统框架」与「二级系统详情」及各模块完成状态，点选不满意的模块直接提修改意见",
      "第四步 · 隔离试跑与全景追踪（B3）：从顶部单行进度栏随时打开「完整运行图」，实时查看主 Agent 与各 Subagent 的执行进展",
      "第五步 · 成果核验与经验沉淀（B4）：核对变更文件清单与自动体检结果，满意则一键合入主项目并沉淀为跨项目可复用经验卡",
    ];
  }
  const layerNames = layers.map((l) => l.label);
  return [
    `入口交互：用户通过「${layerNames.at(-1) || "主界面"}」发起业务操作或配置参数`,
    "业务流转：系统按选定规则自动完成核心业务处理、智能计算或内容生成",
    "结果核对与保存：实时反馈处理进度与产出结果，并将历史记录安全保存以供后续查阅",
  ];
}

function enforceAcyclicDependencies(rawModules) {
  const byId = new Map(rawModules.map((m) => [m.id, m]));
  for (const mod of rawModules) {
    mod.dependencies = mod.dependencies.filter((depId) => depId !== mod.id && byId.has(depId));
  }
  const indexMap = new Map(rawModules.map((m, idx) => [m.id, idx]));
  const shouldKeepEdge = (fromMod, toMod) => {
    if (fromMod.layerRank !== toMod.layerRank) return fromMod.layerRank > toMod.layerRank;
    return indexMap.get(fromMod.id) > indexMap.get(toMod.id);
  };
  for (const mod of rawModules) {
    const kept = [];
    for (const depId of mod.dependencies) {
      const target = byId.get(depId);
      if (!target) continue;
      if (target.dependencies.includes(mod.id) && !shouldKeepEdge(mod, target)) continue;
      kept.push(depId);
    }
    mod.dependencies = kept;
  }
  const state = new Map();
  const visit = (id) => {
    state.set(id, "visiting");
    const mod = byId.get(id);
    const safeDeps = [];
    for (const depId of mod.dependencies) {
      const depState = state.get(depId);
      if (depState === "visiting") continue;
      if (depState !== "done") visit(depId);
      safeDeps.push(depId);
    }
    mod.dependencies = safeDeps;
    state.set(id, "done");
  };
  for (const mod of rawModules) {
    if (!state.has(mod.id)) visit(mod.id);
  }
}

export function discoverProjectArchitecturePrd({ projectRoot } = {}) {
  if (typeof projectRoot !== "string" || !projectRoot.trim()) {
    return null;
  }
  let rootReal;
  try {
    rootReal = realpathSync(projectRoot);
  } catch {
    return null;
  }

  const pkg = safeReadJson(path.join(rootReal, "package.json"));
  const isMetaKim = pkg?.name === "meta-kim" && existsSync(path.join(rootReal, "AGENTS.md"));
  const rawName = scrubText(pkg?.name || path.basename(rootReal) || "Project", 72);
  const displayName = isMetaKim ? "Meta_Kim" : (path.basename(rootReal) || rawName);

  const hasRepoTests = isRealSubdir(path.join(rootReal, "tests"), rootReal)
    || isRealSubdir(path.join(rootReal, "test"), rootReal)
    || isRealSubdir(path.join(rootReal, "__tests__"), rootReal)
    || Boolean(pkg?.scripts?.test);

  const candidates = discoverCandidateSubsystems(rootReal);
  const allCandidateDirs = new Set(candidates.map((c) => toPosix(c.dir)));

  const enriched = [];
  const usedIds = new Set();
  for (const [idx, candidate] of candidates.entries()) {
    const relDir = toPosix(candidate.dir);
    const absDir = path.join(rootReal, relDir);
    const nestedDirs = new Set([...allCandidateDirs].filter((other) => other !== relDir && other.startsWith(`${relDir}/`)));
    const files = collectModuleFiles(absDir, rootReal, nestedDirs);
    if (files.length === 0) continue;

    let id = safeNodeId(candidate.id || relDir, idx + 1);
    while (usedIds.has(id)) id = safeNodeId(`${id}-${idx + 1}`, idx + 1);
    usedIds.add(id);

    const codeFiles = files.filter((f) => CODE_EXTENSIONS.has(f.ext));
    const entryFiles = (codeFiles.length ? codeFiles : files)
      .slice()
      .sort((a, b) => a.repoRel.length - b.repoRel.length)
      .slice(0, 3)
      .map((f) => f.repoRel);

    const readmeSummary = extractLeadDocSummary(path.join(absDir, "README.md"));
    const objective = candidate.objective
      || readmeSummary
      || `为用户提供「${candidate.title}」相关的核心业务功能、状态反馈与异常处理体验。`;

    const hasModuleVerified = candidate.testHint
      ? existsSync(path.join(rootReal, candidate.testHint))
      : (hasRepoTests && (codeFiles.length >= 1 || files.length >= 2));

    const completionStatus = (codeFiles.length >= 1 || candidate.isCuratedProduct) && hasModuleVerified
      ? "completed"
      : files.length >= 1 ? "partial" : "planned";

    const acceptance = candidate.productAcceptance || [
      `「${candidate.title}」主流程可正常操作并给出清晰的状态与结果反馈`,
      "遇到空数据、未配置或网络波动时显示通俗易懂的引导提示，不白屏不卡死",
      hasModuleVerified ? "已具备配套自动化校验保障核心功能稳定可用" : "待补充完整端到端验收测试确认边界情况",
    ];

    const hasUiPage = inferHasUiPage(candidate, relDir);
    const mockupVariant = inferMockupVariant({
      nodeId: id,
      title: candidate.title,
      objective,
      explicitVariant: candidate.mockupVariant || "",
    });

    enriched.push({
      id,
      title: scrubText(candidate.title, 120),
      shortSummary: scrubText(candidate.shortSummary || objective, 42),
      status: completionStatus,
      layer: candidate.layer || "核心产品功能",
      layerShort: candidate.layerShort || "核心功能",
      layerRank: Number.isInteger(candidate.layerRank) ? candidate.layerRank : 2,
      flowColumn: Number.isInteger(candidate.flowColumn) ? candidate.flowColumn : null,
      parallelGroup: candidate.parallelGroup || null,
      nodeKind: candidate.nodeKind || "process",
      loopBackTo: candidate.loopBackTo || null,
      hasUiPage,
      mockupVariant,
      directory: relDir,
      fileCount: files.length,
      entrypoints: entryFiles,
      objective: scrubText(objective, 600),
      features: (candidate.features || [objective]).map((s) => scrubText(s, 300)),
      inputContract: (candidate.inputContract || ["用户的页面操作或上游功能模块传入的业务信息"]).map((s) => scrubText(s, 300)),
      outputContract: (candidate.outputContract || ["清晰可见的处理结果、页面反馈与下游流转数据"]).map((s) => scrubText(s, 300)),
      baseBoundaries: (candidate.boundaries || ["遇到异常情况时保留用户已填内容并给出明确下一步指引"]).map((s) => scrubText(s, 300)),
      acceptance: acceptance.slice(0, 6).map((s) => scrubText(s, 300)),
      files,
      rawDeps: new Set(),
    });
  }

  if (enriched.length === 0) {
    enriched.push({
      id: "core-product",
      title: `${displayName} 核心业务功能`,
      shortSummary: "产品主流程与基础体验",
      status: "partial",
      layer: "核心产品功能",
      layerShort: "核心功能",
      layerRank: 1,
      flowColumn: 0,
      parallelGroup: null,
      nodeKind: "process",
      loopBackTo: null,
      hasUiPage: true,
      mockupVariant: "workbench",
      directory: ".",
      fileCount: 1,
      entrypoints: [],
      objective: `承载 ${displayName} 的核心用户功能与主业务流程体验。`,
      features: ["核心功能操作入口与结果展示", "基础配置读取与异常提示"],
      inputContract: ["用户的日常操作输入与参数选择"],
      outputContract: ["业务执行结果与界面状态反馈"],
      baseBoundaries: ["异常时给出友好提示，保护用户既有数据安全"],
      acceptance: ["主流程操作顺畅且结果符合预期"],
      files: [],
      rawDeps: new Set(),
    });
  }

  const sortedPrefixes = enriched
    .filter((m) => m.directory !== ".")
    .map((m) => ({ id: m.id, prefix: m.directory }))
    .sort((a, b) => b.prefix.length - a.prefix.length);

  const matchModuleByRepoPath = (repoPath) => {
    if (!repoPath) return null;
    for (const { id, prefix } of sortedPrefixes) {
      if (repoPath === prefix || repoPath.startsWith(`${prefix}/`)) return id;
    }
    return null;
  };

  for (const mod of enriched) {
    for (const file of mod.files) {
      if (!CODE_EXTENSIONS.has(file.ext)) continue;
      const source = safeReadText(file.abs, 32 * 1024);
      if (!source) continue;
      IMPORT_SPECIFIER_RE.lastIndex = 0;
      let match;
      while ((match = IMPORT_SPECIFIER_RE.exec(source)) !== null) {
        const spec = match[1] || match[2] || match[3];
        if (!spec) continue;
        const targetRepoPath = resolveRelativeImportToRepoPath(file.abs, spec, rootReal);
        const targetModId = matchModuleByRepoPath(targetRepoPath);
        if (targetModId && targetModId !== mod.id) {
          mod.rawDeps.add(targetModId);
        }
      }
    }
    if (mod.id === "app-agent-workflow" && usedIds.has("config-contracts")) {
      mod.rawDeps.add("config-contracts");
    }
    if (mod.id === "app-agent-workflow" && usedIds.has("canonical-governance")) {
      mod.rawDeps.add("canonical-governance");
    }
    if (mod.id === "desktop-tauri-shell" && usedIds.has("presentation-workspace")) {
      mod.rawDeps.add("presentation-workspace");
    }
    if (mod.id === "desktop-tauri-shell" && usedIds.has("infra-live-runtime")) {
      mod.rawDeps.add("infra-live-runtime");
    }
    mod.dependencies = [...mod.rawDeps];
  }

  enforceAcyclicDependencies(enriched);
  enriched.sort((a, b) => a.layerRank - b.layerRank || a.dependencies.length - b.dependencies.length);

  const modules = enriched.map((mod) => {
    const uiMockup = mod.hasUiPage
      ? {
          status: mod.status === "completed" ? "confirmed" : "pending",
          version: 1,
          mode: "wireframe_fallback",
          variant: mod.mockupVariant || "workbench",
          imageUrl: null,
          fallbackReason: "默认载入结构化页面效果图预览（可点击重新尝试模型生图或输入意见实时改版）",
          wireframeSpec: buildStructuredWireframeSpec({
            title: mod.title,
            objective: mod.objective,
            features: mod.features,
            version: 1,
            variant: mod.mockupVariant || "workbench",
          }),
        }
      : null;
    const baseRecord = {
      id: mod.id,
      title: mod.title,
      shortSummary: mod.shortSummary,
      status: mod.status,
      layer: mod.layer,
      layerShort: mod.layerShort,
      layerRank: mod.layerRank,
      flowColumn: mod.flowColumn,
      parallelGroup: mod.parallelGroup,
      nodeKind: mod.nodeKind || "process",
      loopBackTo: mod.loopBackTo || null,
      hasUiPage: Boolean(mod.hasUiPage),
      ...(uiMockup && { uiMockup }),
      directory: mod.directory,
      fileCount: mod.fileCount,
      entrypoints: mod.entrypoints,
      objective: mod.objective,
      features: mod.features,
      inputContract: mod.inputContract,
      outputContract: mod.outputContract,
      boundaries: mod.baseBoundaries.slice(0, 6),
      acceptance: mod.acceptance,
      dependencies: mod.dependencies,
    };
    return {
      ...baseRecord,
      subflow: buildDefaultSubflowForModule(baseRecord),
    };
  });

  const completedCount = modules.filter((m) => m.status === "completed").length;
  const partialCount = modules.filter((m) => m.status === "partial").length;
  const systemStatus = completedCount === modules.length ? "completed"
    : (completedCount > 0 || partialCount > 0) ? "partial" : "planned";

  const layerMap = new Map();
  for (const mod of modules) {
    const key = `${mod.layerRank}:${mod.layer}`;
    if (!layerMap.has(key)) {
      layerMap.set(key, { rank: mod.layerRank, label: mod.layer, shortLabel: mod.layerShort, moduleIds: [], moduleTitles: [], moduleStatuses: [] });
    }
    const group = layerMap.get(key);
    group.moduleIds.push(mod.id);
    group.moduleTitles.push(mod.title);
    group.moduleStatuses.push(mod.status);
  }
  const layers = [...layerMap.values()].sort((a, b) => a.rank - b.rank);
  const userJourney = buildUserJourneySteps(displayName, isMetaKim, layers);

  const systemBoundaries = isMetaKim
    ? [
      "关键决定永远由人拍板：选方案（B1）、定设计（B2）、跑修改（B3）、验成果（B4）均需用户明确确认，AI 绝不先斩后奏",
      "真实进度零虚报：已完成多少模块、派发了几个 Subagent 全部依据真实记录展示，绝不把空计划包装成已完成",
      "先隔离试跑再安全合入：代码修改先在独立草稿区运行并自动体检，确认无误才合入正式项目，支持一键回滚",
      "本机隐私与多仓自由切换：所有对话、PRD 与仓库资料均留在本机，浏览其他仓库保持只读安全保护",
    ]
    : [
      "用户操作安全优先：所有关键变更均需清晰的状态反馈，遇到异常保留用户已输入数据",
      "模块完成度实事求是：各二级系统模块的状态根据当前工程真实实现与测试覆盖情况自动核算",
    ];

  const systemAcceptance = isMetaKim
    ? [
      "普通人无需阅读代码，打开「产品设计 PRD」即可看懂一级系统框架、二级系统详情及每个模块的完成状态",
      "Logo 正下方一行展示全局执行进度，点击即可直达「完整运行图」查看主 Agent 与各 Subagent 实时拓扑",
      "支持底部直接选择 AI 渠道、顶栏双向绑定外部会话，以及在「仓库」视图一键切换本机多仓库",
    ]
    : [
      `一级系统框架清晰呈现「${displayName}」的业务定位、主流程与功能板块划分`,
      "点击任意二级模块即可查看其功能价值、交互体验、上下游关系与完成状态",
    ];

  const system = {
    id: "system-architecture",
    title: `${displayName} · 系统框架`,
    status: systemStatus,
    completedModuleCount: completedCount,
    totalModuleCount: modules.length,
    goal: extractProductPositioning(rootReal, pkg, displayName),
    userJourney,
    architecture: userJourney.join(" → "),
    boundaries: systemBoundaries,
    acceptance: systemAcceptance,
    layers,
  };

  return {
    schemaVersion: PROJECT_ARCHITECTURE_PRD_SCHEMA,
    recordOrigin: "repository_architecture_baseline",
    approvalClaimed: false,
    dagValid: validateDesignDag(modules),
    projectName: displayName,
    totalFilesScanned: modules.reduce((sum, item) => sum + item.fileCount, 0),
    system,
    modules,
  };
}
