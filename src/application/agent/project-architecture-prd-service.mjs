/**
 * Read-only repository architecture & module-organization PRD extractor.
 *
 * Produces a genuine Two-Level System Design PRD baseline for the bound project:
 * - Level 1 (`system`): System positioning, layered architectural framework,
 *   end-to-end control/data flow, tech stack, global boundaries, and acceptance gates.
 * - Level 2 (`modules`): Subsystem/module decomposition, responsibilities,
 *   directories & entrypoints, input/output contracts, measured cross-module
 *   import dependencies (guaranteed acyclic DAG), boundaries, and test gates.
 *
 * Security & honesty invariants:
 * - Never claims human B2 approval (`approvalClaimed: false`, `recordOrigin: "repository_architecture_baseline"`).
 * - Reads strictly within `realpathSync(projectRoot)`, skipping symlinks, hidden
 *   runtime projection dirs, and `node_modules` / build outputs.
 * - Never emits absolute host filesystem paths, URLs, or credentials.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { validateDesignDag } from "../../domain/runtime/agent-design-contract.mjs";

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

function extractLeadDocComment(filePath) {
  const raw = safeReadText(filePath, 6_000);
  if (!raw) return "";
  const block = /^\s*\/\*\*([\s\S]*?)\*\//u.exec(raw);
  if (block) {
    const lines = block[1]
      .split(/\r?\n/u)
      .map((line) => line.replace(/^\s*\*\s?/u, "").trim())
      .filter((line) => line && !line.startsWith("@"));
    if (lines.length) return scrubText(lines.slice(0, 2).join(" "), 220);
  }
  const mdPara = raw
    .split(/\r?\n\r?\n/u)
    .map((chunk) => chunk.replace(/^#+\s+/gmu, "").trim())
    .find((chunk) => chunk.length >= 16 && !chunk.startsWith("<!--") && !chunk.startsWith("```"));
  return mdPara ? scrubText(mdPara, 220) : "";
}

const KNOWN_MODULE_BLUEPRINTS = [
  {
    dir: "canonical",
    id: "canonical-governance",
    title: "Canonical 治理真值核",
    layer: "治理真值与契约层",
    layerShort: "治理真值层",
    layerRank: 0,
    objective: "维护跨运行时唯一的元治理角色（9 个 meta-* Agent）、八阶段 meta-theory 协议与宿主投影资产源。",
    inputContract: ["人类自然语言目标与显式治理请求", "阶段推进协议（Critical → Fetch → Thinking → Review）"],
    outputContract: ["canonical/agents 角色规格", "meta-theory 核心技能与分宿主参考规范", "canonical/runtime-assets 原生钩子源"],
    boundaries: ["单一持久行为真值源；禁止在生成投影目录直接手改分叉", "自身不直接持有运行时会话状态"],
    testHint: "tests/governance",
  },
  {
    dir: "config",
    id: "config-contracts",
    title: "契约与能力索引中心",
    layer: "治理真值与契约层",
    layerShort: "契约索引层",
    layerRank: 0,
    objective: "集中管理跨宿主能力矩阵、Provider 注册表、外部专业依赖契约、启动白名单与架构模式目录。",
    inputContract: ["宿主兼容性与安全策略声明", "外部专业能力哈希索引与契约 Schema"],
    outputContract: ["capability-index 能力发现注册表", "contracts 结构化校验契约", "agent-hosts 受控客户端白名单"],
    boundaries: ["仅声明静态登记与契约真值，绝不等同于运行时已连接或已调用证据"],
    testHint: "tests/contracts",
  },
  {
    dir: "src/sdk",
    id: "sdk-live-contracts",
    title: "Live SDK 与回放契约",
    layer: "治理真值与契约层",
    layerShort: "SDK 基础层",
    layerRank: 0,
    objective: "提供无副作用的证据卡片模型、运行时适配器抽象接口、主题令牌与公共类型校验原语。",
    inputContract: ["原始运行回执、节点状态与适配器元数据"],
    outputContract: ["标准化证据卡结构", "RuntimeAdapter 契约接口", "回放与视觉基础原语"],
    boundaries: ["零 I/O 与零进程派生；供领域层、应用层与表现层安全复用"],
    testHint: "tests/live",
  },
  {
    dir: "src/domain",
    id: "domain-models",
    title: "领域模型与设计契约",
    layer: "领域与数据持久层",
    layerShort: "领域模型层",
    layerRank: 1,
    objective: "定义 B1–B4 决策状态机、两级 PRD 设计契约（DAG 无环校验与审批失效传播）、宿主诊断与运行实体不变量。",
    inputContract: ["待校验的方案选择、两级系统/模块设计变更与宿主探测信号"],
    outputContract: ["经过范式化与幂等摘要绑定的领域实体", "上下游审批级联失效规则与无环依赖图保证"],
    boundaries: ["纯确定性领域规则；严禁直接发起子进程、HTTP 请求或文件系统改写"],
    testHint: "tests/live",
  },
  {
    dir: "src/data",
    id: "data-repositories",
    title: "SQLite 与工作台仓储",
    layer: "领域与数据持久层",
    layerShort: "数据仓储层",
    layerRank: 1,
    objective: "封装本地 SQLite 事务运行时、工作台版本状态仓储与正式交付物持久化读写。",
    inputContract: ["经应用层核验的投影记录、审阅命令与交付物元数据"],
    outputContract: ["ACID 事务保护的工作台快照、分页材料游标与审计历史记录"],
    boundaries: ["仅持久化已验证结构化记录；不向上层暴露裸 SQL 拼接或越权目录访问"],
    testHint: "tests/live",
  },
  {
    dir: "src/application/agent",
    id: "app-agent-workflow",
    title: "Agent B1-B4 编排引擎",
    layer: "应用编排与投影层",
    layerShort: "Agent 编排层",
    layerRank: 2,
    objective: "串联本地受控 CLI 只读研究、B1 方案人工拍板、B2 两级 PRD 设计审阅、交接封存、B3 原生执行与 B4 验收合入闭环。",
    inputContract: ["人类任务目标、B1/B2/B3/B4 签名决策请求与受控宿主探测结果"],
    outputContract: ["幂等绑定的工作流状态回执、两级架构 PRD 实测基线与本地能力目录聚合"],
    boundaries: ["严格隔离于只读 Live Hub 静态导入图之外；未经人工里程碑确认绝不自动执行代码写入"],
    testHint: "tests/live",
  },
  {
    dir: "src/application/live",
    id: "app-live-projection",
    title: "Live 投影与图谱模型",
    layer: "应用编排与投影层",
    layerShort: "Live 投影层",
    layerRank: 2,
    objective: "将治理运行状态、阶段演进、两级 PRD 依赖图、排版间距预算与后续续跑规划投影为统一工作台只读模型。",
    inputContract: ["仓储快照、运行节点事件流、设计契约与视口预算参数"],
    outputContract: ["统一工作台视图模型、两级 PRD 拓扑图数据（buildLivePrdGraph）与可验证续跑计划"],
    boundaries: ["纯投影与规划计算，不修改底层源仓库代码或伪造未观测到的 Subagent 执行"],
    testHint: "tests/live",
  },
  {
    dir: "src/infrastructure",
    id: "infra-live-runtime",
    title: "控制室服务与会话适配",
    layer: "基础设施与服务层",
    layerShort: "基础设施层",
    layerRank: 3,
    objective: "承载本地回环 HTTP/SSE 控制室服务端、多项目目录发现、Claude/Codex/ZCode 原生会话读取与守护进程生命周期。",
    inputContract: ["仅限本机 Loopback + Workspace Token 鉴权请求、本地 `.meta-kim` 运行记录与原生会话日志"],
    outputContract: ["/api/workspace、/api/projects、/api/agent/* 安全 JSON 接口与实时 SSE 快照推送"],
    boundaries: ["强制同源与本机权威校验；阻断跨站请求、任意路径穿越与未授权外部写入"],
    testHint: "tests/live",
  },
  {
    dir: "src/presentation",
    id: "presentation-workspace",
    title: "统一工作台与可视化层",
    layer: "工作台表现与交互层",
    layerShort: "工作台表现层",
    layerRank: 4,
    objective: "构建左导栏 + 侧边能力大面板 + Agent 对话决策流 + 两级架构 PRD 图谱 + 完整八阶段运行图的多语言响应式工作台。",
    inputContract: ["控制室 API 快照、两级 PRD 图谱模型、能力目录与用户圈选/拖拽/审批交互"],
    outputContract: ["实时同步的双栏/全宽自适应工作台界面、可缩放拖拽的一二级 PRD 图谱与多语言本地化视图"],
    boundaries: ["严格按真实证据级别渲染状态，严禁把未派发规划或静态客户端配置伪装为已执行节点"],
    testHint: "tests/live",
  },
  {
    dir: "scripts",
    id: "cli-sync-scripts",
    title: "多宿主投影同步与 CLI",
    layer: "CLI 同步与原生桌面层",
    layerShort: "CLI 与投影层",
    layerRank: 5,
    objective: "提供 `setup.mjs`、`meta:sync`、`meta:check`、`meta-kim-agent` / `meta-kim-live` 命令行入口及六大宿主配置同步流水线。",
    inputContract: ["Canonical 真值源、用户安装范围参数（global / project）与环境变量配置"],
    outputContract: ["各 AI 宿主原生投影文件、不可变运行时包缓存与架构一致性校验报告"],
    boundaries: ["保护用户自有配置与项目沉淀副本（runtime_sedimented_project_copy），不越界清理未知文件"],
    testHint: "tests",
  },
  {
    dir: "desktop",
    id: "desktop-tauri-shell",
    title: "Tauri v2 原生桌面端",
    layer: "CLI 同步与原生桌面层",
    layerShort: "原生桌面端",
    layerRank: 5,
    objective: "封装独立原生桌面窗口、系统托盘与受控本地服务守护生命周期，提供免浏览器地址栏的产品级桌面体验。",
    inputContract: ["Rust/Tauri 窗口事件、本机工作台端口握手与桌面安全策略（CSP）"],
    outputContract: ["独立桌面客户端进程与安全隔离的本地控制中心 WebView 容器"],
    boundaries: ["仅连接本机受控回环服务，不开放远程任意脚本注入"],
    testHint: "desktop/src-tauri",
  },
];

function inferGenericLayer(relDir) {
  const lower = relDir.toLowerCase();
  if (/(?:^|\/)(?:schema|contract|proto|types|sdk|shared|common|core-types)(?:\/|$)/u.test(lower)) {
    return { layer: "基础契约与共享层", layerShort: "基础契约层", layerRank: 0 };
  }
  if (/(?:^|\/)(?:domain|model|entities|core|db|data|database|prisma|migrations|storage|repositories)(?:\/|$)/u.test(lower)) {
    return { layer: "领域与数据持久层", layerShort: "领域数据层", layerRank: 1 };
  }
  if (/(?:^|\/)(?:application|service|services|usecase|workflow|engine|orchestrator|worker)(?:\/|$)/u.test(lower)) {
    return { layer: "应用业务与编排层", layerShort: "业务编排层", layerRank: 2 };
  }
  if (/(?:^|\/)(?:infra|infrastructure|adapter|adapters|server|api|gateway|provider|providers|transport)(?:\/|$)/u.test(lower)) {
    return { layer: "基础设施与接口层", layerShort: "基础设施层", layerRank: 3 };
  }
  if (/(?:^|\/)(?:presentation|ui|web|frontend|client|views|components|pages|app)(?:\/|$)/u.test(lower)) {
    return { layer: "前端表现与交互层", layerShort: "表现交互层", layerRank: 4 };
  }
  return { layer: "入口与工具支撑层", layerShort: "入口支撑层", layerRank: 5 };
}

function discoverCandidateSubsystems(rootReal) {
  const matchedKnown = KNOWN_MODULE_BLUEPRINTS.filter((item) =>
    isRealSubdir(path.join(rootReal, item.dir), rootReal));

  // If this repository matches a rich multi-layer architecture (>= 4 known dirs), use them
  // plus any additional top-level workspace packages under `packages/*` or `apps/*`.
  if (matchedKnown.length >= 4) {
    return matchedKnown.map((bp) => ({ ...bp }));
  }

  // Generic discovery for any arbitrary repository!
  const candidates = [];
  const containerDirs = ["apps", "packages", "services", "crates", "modules"];
  for (const container of containerDirs) {
    const absContainer = path.join(rootReal, container);
    for (const child of listRealSubdirs(absContainer, rootReal)) {
      const rel = `${container}/${child}`;
      const tier = inferGenericLayer(rel);
      candidates.push({
        dir: rel,
        id: safeNodeId(`${container}-${child}`, candidates.length + 1),
        title: `${child}（${container}）`,
        ...tier,
      });
    }
  }
  const srcAbs = path.join(rootReal, "src");
  const srcChildren = listRealSubdirs(srcAbs, rootReal);
  if (srcChildren.length >= 2) {
    for (const child of srcChildren) {
      const rel = `src/${child}`;
      const tier = inferGenericLayer(rel);
      candidates.push({
        dir: rel,
        id: safeNodeId(`src-${child}`, candidates.length + 1),
        title: `${child} 模块`,
        ...tier,
      });
    }
  } else if (isRealSubdir(srcAbs, rootReal)) {
    const tier = inferGenericLayer("src");
    candidates.push({ dir: "src", id: "src-core", title: "核心源码模块（src）", ...tier });
  }

  for (const top of listRealSubdirs(rootReal, rootReal)) {
    if (["src", "tests", "test", "__tests__", "docs", "doc", "examples", "scripts", ...containerDirs].includes(top)) continue;
    const tier = inferGenericLayer(top);
    candidates.push({
      dir: top,
      id: safeNodeId(top, candidates.length + 1),
      title: `${top} 子系统`,
      ...tier,
    });
  }
  if (isRealSubdir(path.join(rootReal, "scripts"), rootReal)) {
    candidates.push({
      dir: "scripts",
      id: "cli-scripts",
      title: "构建与自动化脚本（scripts）",
      layer: "入口与工具支撑层",
      layerShort: "脚本入口层",
      layerRank: 5,
    });
  }
  return candidates.slice(0, 14);
}

const IMPORT_SPECIFIER_RE = /(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)|require\(\s*["'](\.[^"']+)["']\s*\)/gu;

function resolveRelativeImportToRepoPath(fromAbsFile, specifier, rootReal) {
  const baseDir = path.dirname(fromAbsFile);
  const targetBase = path.resolve(baseDir, specifier);
  if (!targetBase.startsWith(rootReal + path.sep) && targetBase !== rootReal) return null;
  return toPosix(path.relative(rootReal, targetBase));
}

function detectTechStack(rootReal, pkg) {
  const stack = [];
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (pkg.type === "module") stack.push("Node.js ESM");
    else stack.push("Node.js");
    if (deps.typescript || existsSync(path.join(rootReal, "tsconfig.json"))) stack.push("TypeScript");
    if (deps.react) stack.push("React");
    if (deps.vue) stack.push("Vue");
    if (deps.next) stack.push("Next.js");
    if (deps.vite) stack.push("Vite");
    if (deps["better-sqlite3"] || deps.sqlite3 || existsSync(path.join(rootReal, "src/data/sqlite"))) stack.push("SQLite（node:sqlite）");
    if (deps.playwright || deps["@playwright/test"]) stack.push("Playwright");
  }
  if (existsSync(path.join(rootReal, "desktop/src-tauri/Cargo.toml")) || existsSync(path.join(rootReal, "Cargo.toml"))) {
    stack.push("Rust / Tauri v2");
  }
  if (existsSync(path.join(rootReal, "pyproject.toml")) || existsSync(path.join(rootReal, "requirements.txt"))) {
    stack.push("Python");
  }
  if (existsSync(path.join(rootReal, "go.mod"))) {
    stack.push("Go");
  }
  if (existsSync(path.join(rootReal, "src/presentation/live"))) {
    stack.push("零第三方依赖原生 SVG 图谱与响应式工作台");
  }
  return stack.length ? stack.join(" · ") : "本地源码工程（未声明包管理器清单）";
}

function extractProjectGoal(rootReal, pkg) {
  if (pkg?.name === "meta-kim" && existsSync(path.join(rootReal, "AGENTS.md"))) {
    return "跨运行时意图放大与智能体治理架构系统：围绕真实目标完成能力发现、多方案证据比选、B1–B4 人工里程碑拍板、两级系统设计契约、受控执行编排与结果核验沉淀。";
  }
  const zhSummary = extractLeadDocComment(path.join(rootReal, "README.zh-CN.md"));
  if (zhSummary.length >= 16) return zhSummary;
  if (pkg?.description) {
    const desc = scrubText(pkg.description, 260);
    if (desc.length >= 12) return desc;
  }
  for (const docName of ["README.md", "AGENTS.md"]) {
    const summary = extractLeadDocComment(path.join(rootReal, docName));
    if (summary.length >= 16) return summary;
  }
  return "围绕当前代码仓库提供清晰的一级系统分层框架与二级模块职责、接口契约及依赖治理组织。";
}

function enforceAcyclicDependencies(rawModules) {
  // Break any mutual import cycle deterministically along architectural rank (higher layerRank depends on lower layerRank),
  // preserving full honesty by recording decoupled callback/reverse references in `boundaries`.
  const byId = new Map(rawModules.map((m) => [m.id, m]));
  for (const mod of rawModules) {
    mod.dependencies = mod.dependencies.filter((depId) => depId !== mod.id && byId.has(depId));
  }

  // First remove direct 2-cycles using layerRank + source order
  const indexMap = new Map(rawModules.map((m, idx) => [m.id, idx]));
  const shouldKeepEdge = (fromMod, toMod) => {
    // `fromMod` depends on `toMod` (meaning `toMod` is prerequisite of `fromMod`).
    // Higher layerRank (e.g. presentation=4) SHOULD depend on lower layerRank (e.g. application=2).
    if (fromMod.layerRank !== toMod.layerRank) return fromMod.layerRank > toMod.layerRank;
    return indexMap.get(fromMod.id) > indexMap.get(toMod.id);
  };

  for (const mod of rawModules) {
    const kept = [];
    for (const depId of mod.dependencies) {
      const target = byId.get(depId);
      if (!target) continue;
      if (target.dependencies.includes(mod.id) && !shouldKeepEdge(mod, target)) {
        mod.reverseCouplingNotes.push(`与「${target.title}」存在双向协作引用，主依赖方向归一为 ${target.id} 依赖 ${mod.id}`);
        continue;
      }
      kept.push(depId);
    }
    mod.dependencies = kept;
  }

  // General DFS cycle breaker in case of >=3-node cycle
  const state = new Map();
  const visit = (id) => {
    state.set(id, "visiting");
    const mod = byId.get(id);
    const safeDeps = [];
    for (const depId of mod.dependencies) {
      const depState = state.get(depId);
      if (depState === "visiting") {
        const target = byId.get(depId);
        mod.reverseCouplingNotes.push(`已解耦与「${target?.title || depId}」的回环引用以保持架构 DAG 单向性`);
        continue;
      }
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
  const rawName = scrubText(pkg?.name || path.basename(rootReal) || "Project", 72);
  const displayName = rawName === "meta-kim" && existsSync(path.join(rootReal, "AGENTS.md")) ? "Meta_Kim" : rawName;

  const candidates = discoverCandidateSubsystems(rootReal);
  const allCandidateDirs = new Set(candidates.map((c) => toPosix(c.dir)));

  const enriched = [];
  const usedIds = new Set();
  for (const [idx, candidate] of candidates.entries()) {
    const relDir = toPosix(candidate.dir);
    const absDir = path.join(rootReal, relDir);
    // Exclude nested candidate directories so parent dirs don't double-count child subsystems
    const nestedDirs = new Set([...allCandidateDirs].filter((other) => other !== relDir && other.startsWith(`${relDir}/`)));
    const files = collectModuleFiles(absDir, rootReal, nestedDirs);
    if (files.length === 0) continue;

    let id = safeNodeId(candidate.id || relDir, idx + 1);
    while (usedIds.has(id)) id = safeNodeId(`${id}-${idx + 1}`, idx + 1);
    usedIds.add(id);

    const codeFiles = files.filter((f) => CODE_EXTENSIONS.has(f.ext));
    const entryFiles = (codeFiles.length ? codeFiles : files)
      .slice()
      .sort((a, b) => {
        const score = (f) => (/^(?:index|main|app|server|setup|SKILL)\./iu.test(f.name) ? 0
          : /service|controller|renderer|desktop|graph|contract|runtime/iu.test(f.name) ? 1 : 2);
        return score(a) - score(b) || a.repoRel.length - b.repoRel.length;
      })
      .slice(0, 4)
      .map((f) => f.repoRel);

    const docSummary = entryFiles.map((rel) => extractLeadDocComment(path.join(rootReal, rel))).find(Boolean) || "";
    const objective = candidate.objective
      || docSummary
      || `负责 ${relDir} 目录下的模块组织与核心职责实现（共 ${files.length} 个受管源文件）。`;

    const hasMatchingTest = candidate.testHint && existsSync(path.join(rootReal, candidate.testHint));
    const acceptance = [];
    if (hasMatchingTest) acceptance.push(`通过 ${candidate.testHint} 关联自动化测试套件校验`);
    if (pkg?.scripts?.["meta:check"] && (relDir === "canonical" || relDir === "config" || relDir === "scripts")) {
      acceptance.push("通过 `npm run meta:check` 跨宿主投影与契约一致性门禁");
    }
    if (pkg?.scripts?.test) acceptance.push("通过 `npm test` 回归验证且不破坏上下游模块契约");
    if (!acceptance.length) acceptance.push(`核验 ${relDir} 导出契约与边界完整性`);

    enriched.push({
      id,
      title: scrubText(candidate.title, 120),
      layer: candidate.layer || "核心模块层",
      layerShort: candidate.layerShort || "模块层",
      layerRank: Number.isInteger(candidate.layerRank) ? candidate.layerRank : 2,
      directory: relDir,
      fileCount: files.length,
      entrypoints: entryFiles,
      objective: scrubText(objective, 600),
      inputContract: (candidate.inputContract || [`来自上游模块调用参数与 ${relDir} 配置输入`]).map((s) => scrubText(s, 300)),
      outputContract: (candidate.outputContract || [
        entryFiles.length ? `核心导出入口：${entryFiles.slice(0, 3).join("、")}` : `${relDir} 模块公开接口`,
      ]).map((s) => scrubText(s, 300)),
      baseBoundaries: (candidate.boundaries || [`职责收敛于 ${relDir}，禁止跨层反向侵入或隐式全局可变状态`]).map((s) => scrubText(s, 300)),
      acceptance: acceptance.slice(0, 6).map((s) => scrubText(s, 300)),
      files,
      rawDeps: new Set(),
      reverseCouplingNotes: [],
    });
  }

  // Fallback minimal single module if repository has root files only
  if (enriched.length === 0) {
    enriched.push({
      id: "core-repository",
      title: `${displayName} 核心模块`,
      layer: "核心实现层",
      layerShort: "核心层",
      layerRank: 1,
      directory: ".",
      fileCount: 1,
      entrypoints: ["package.json"].filter((f) => existsSync(path.join(rootReal, f))),
      objective: `承载 ${displayName} 当前仓库的核心业务逻辑与配置组织。`,
      inputContract: ["用户输入与工程配置"],
      outputContract: ["模块执行结果与对外接口"],
      baseBoundaries: ["保持模块职责单一与可测试性"],
      acceptance: ["通过工程基础构建与校验"],
      files: [],
      rawDeps: new Set(),
      reverseCouplingNotes: [],
    });
  }

  // Measure real cross-module static imports!
  // Sort longest directory prefix first so `src/application/agent` matches before `src/application`
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
    // Also link `canonical-governance` / `config-contracts` logically where manifest/canonical paths are read via URL/path.join
    if (mod.id === "cli-sync-scripts" || mod.id === "app-agent-workflow") {
      if (usedIds.has("config-contracts")) mod.rawDeps.add("config-contracts");
    }
    if (mod.id === "cli-sync-scripts" && usedIds.has("canonical-governance")) {
      mod.rawDeps.add("canonical-governance");
    }
    if (mod.id === "desktop-tauri-shell" && usedIds.has("infra-live-runtime")) {
      mod.rawDeps.add("infra-live-runtime");
    }
    mod.dependencies = [...mod.rawDeps];
  }

  enforceAcyclicDependencies(enriched);

  // Order modules cleanly by architectural layerRank ascending, then dependency count
  enriched.sort((a, b) => a.layerRank - b.layerRank || a.dependencies.length - b.dependencies.length);

  const modules = enriched.map((mod) => ({
    id: mod.id,
    title: mod.title,
    layer: mod.layer,
    layerShort: mod.layerShort,
    layerRank: mod.layerRank,
    directory: mod.directory,
    fileCount: mod.fileCount,
    entrypoints: mod.entrypoints,
    objective: mod.objective,
    inputContract: mod.inputContract,
    outputContract: mod.outputContract,
    boundaries: [...mod.baseBoundaries, ...mod.reverseCouplingNotes].slice(0, 8),
    acceptance: mod.acceptance,
    dependencies: mod.dependencies,
  }));

  // Group layers for Level-1 System Framework
  const layerMap = new Map();
  for (const mod of modules) {
    const key = `${mod.layerRank}:${mod.layer}`;
    if (!layerMap.has(key)) {
      layerMap.set(key, { rank: mod.layerRank, label: mod.layer, shortLabel: mod.layerShort, moduleIds: [], moduleTitles: [] });
    }
    const group = layerMap.get(key);
    group.moduleIds.push(mod.id);
    group.moduleTitles.push(mod.title);
  }
  const layers = [...layerMap.values()].sort((a, b) => a.rank - b.rank);
  const architectureFlow = layers
    .map((layer, index) => `L${index + 1} ${layer.label}（${layer.moduleTitles.join(" / ")}）`)
    .join(" → ");

  const scriptGates = [];
  if (pkg?.scripts?.["meta:check"]) scriptGates.push("`npm run meta:check`：校验 Canonical 真值源与各宿主投影、治理契约零漂移");
  if (pkg?.scripts?.["meta:sync"]) scriptGates.push("`npm run meta:sync`：按目标宿主确定性生成本地运行时投影");
  if (pkg?.scripts?.test) scriptGates.push("`npm test`：执行全量领域契约、服务边界与工作台交互回归测试");
  if (!scriptGates.length) scriptGates.push("全量模块接口契约核验与无环依赖图（DAG）校验通过");

  const systemBoundaries = existsSync(path.join(rootReal, "AGENTS.md"))
    ? [
      "单一真值源边界：`canonical/` 与 `config/` 为持久治理源，各宿主目录（`.claude/.codex/.cursor/.gemini/.zcode/openclaw`）均为生成投影",
      "证据诚实性边界：静态能力登记、规划草稿与真实观测到的运行节点/Subagent 回执严格区分，绝不混同",
      "本机安全权威边界：控制室仅绑定本机 Loopback 并强制校验同源与 Workspace Token，关键节点 B1–B4 由人工拍板",
      "无环分层依赖边界：上层表现/入口单向依赖应用层、领域层与契约层，全图通过 `validateDesignDag` 无环核验",
    ]
    : [
      "分层单向依赖边界：高层入口与表现层单向调用业务编排与底层模型，禁止跨层循环耦合",
      "源码实测基线边界：当前视图由受管源码目录与真实 `import` 依赖实测生成，不等同于人工已审批的 B2 变更记录",
    ];

  const system = {
    id: "system-architecture",
    title: `${displayName} · 系统整体框架`,
    goal: extractProjectGoal(rootReal, pkg),
    architecture: architectureFlow,
    techStack: detectTechStack(rootReal, pkg),
    boundaries: systemBoundaries,
    acceptance: scriptGates,
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
