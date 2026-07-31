import { promises as fs } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { getProfilePaths } from "./meta-kim-local-state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(__dirname, "..");
export const stateDir = getProfilePaths().profileDir;
export const GOVERNANCE_ACTIONS = [
  "clarify_intent",
  "fetch_platform_capability",
  "fetch_dependency_capability",
  "discover_lens",
  "select_best_path",
  "ask_user_choice",
  "dispatch_owner_weapon",
  "execute_task",
  "review_output",
  "verify_user_goal",
  "evolve_writeback",
];
export const RUNTIMES = ["claude_code", "codex", "openclaw", "cursor"];
export const OS_TARGETS = ["macos", "windows", "linux", "wsl2"];
export const SUPPORT = ["native", "partial", "unsupported", "unknown"];
export const CONFIDENCE = [
  "verified_docs",
  "verified_local",
  "repo_claim",
  "unverified",
];
export const GOVERNANCE_OWNERS = [
  "meta-warden",
  "meta-conductor",
  "meta-genesis",
  "meta-artisan",
  "meta-sentinel",
  "meta-librarian",
  "meta-prism",
  "meta-scout",
  "meta-chrysalis",
];

export function repoPath(relativePath) {
  return path.join(repoRoot, relativePath);
}

export function toPosix(filePath) {
  return String(filePath).replace(/\\/g, "/");
}

export function annotateCrossScopeAgentCollisions(agents, runtime) {
  if (runtime !== "codex") return agents;
  const groups = new Map();
  for (const agent of agents) {
    const group = groups.get(agent.id) ?? [];
    group.push(agent);
    groups.set(agent.id, group);
  }
  return agents.map((agent) => {
    const group = groups.get(agent.id) ?? [agent];
    const provenance = group.flatMap((candidate) =>
      Array.isArray(candidate.provenance) && candidate.provenance.length > 0
        ? candidate.provenance
        : [{
            id: candidate.id,
            inventoryId: candidate.inventoryId ?? candidate.id,
            sourceClass: candidate.sourceClass ?? "unknown",
            sourceRef: candidate.sourceRef ?? null,
            contentDigest: candidate.contentDigest ?? null,
            nativeIdentity: candidate.nativeIdentity ?? candidate.id,
            sourcePriority: candidate.sourcePriority ?? null,
            sourceKey: candidate.sourceKey ?? null,
            sourceValid: candidate.validCustomAgentDefinition !== false,
          }],
    );
    const uniqueSources = [...new Map(
      provenance.map((entry) => [entry.sourceKey ?? `${entry.sourceRef}:${entry.contentDigest}`, entry]),
    ).values()];
    const distinctDigests = [...new Set(uniqueSources.map((entry) => entry.contentDigest).filter(Boolean))];
    const conflicting = distinctDigests.length > 1;
    const explicitlySelected = agent.sourceSelectedExplicitly === true;
    const routeEligible = (!conflicting || explicitlySelected) &&
      agent.validCustomAgentDefinition !== false;
    if (uniqueSources.length <= 1 && agent.collision == null) return agent;
    const collision = {
      detected: uniqueSources.length > 1,
      kind: uniqueSources.length <= 1
        ? "none"
        : conflicting
          ? "conflicting_definitions"
          : "exact_duplicate",
      candidateCount: uniqueSources.length,
      distinctContentDigests: distinctDigests,
      exactDuplicate: uniqueSources.length > 1 && !conflicting,
      ambiguous: conflicting,
      routeEligible,
      evidenceSource: "live_project_and_global_filesystem",
    };
    return {
      ...agent,
      provenance: uniqueSources,
      collision,
      routeEligible,
      ambiguousNativeIdentity: conflicting,
    };
  });
}

export async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(repoPath(relativePath), "utf8"));
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function quoteWindowsCommand(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export function commandProbe(command) {
  const whereCommand = process.platform === "win32" ? "where.exe" : "which";
  const where = spawnSync(whereCommand, [command], { encoding: "utf8" });
  const source = where.status === 0 ? where.stdout.split(/\r?\n/)[0] : null;
  let version = null;
  if (source) {
    const result =
      process.platform === "win32"
        ? spawnSync(
            process.env.ComSpec || "cmd.exe",
            ["/d", "/s", "/c", `${quoteWindowsCommand(source)} --version`],
            { encoding: "utf8", shell: false },
          )
        : spawnSync(source, ["--version"], {
            encoding: "utf8",
            shell: false,
          });
    version =
      result.status === 0
        ? (result.stdout || result.stderr).split(/\r?\n/).find(Boolean) ?? null
        : null;
  }
  return { command, available: Boolean(source), source, version };
}

export function detectHostOs() {
  const platform = process.platform;
  const release = os.release().toLowerCase();
  const isWsl =
    platform === "linux" &&
    (release.includes("microsoft") ||
      process.env.WSL_DISTRO_NAME ||
      process.env.WSL_INTEROP);
  return {
    platform,
    normalized: isWsl
      ? "wsl2"
      : platform === "darwin"
        ? "macos"
        : platform === "win32"
          ? "windows"
          : "linux",
    isWsl2: Boolean(isWsl),
    arch: process.arch,
    release: os.release(),
    homeDir: os.homedir(),
  };
}

export async function listFiles(root, predicate = () => true, bucket = []) {
  if (!(await exists(root))) {
    return bucket;
  }
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await listFiles(filePath, predicate, bucket);
    } else if (entry.isFile() && predicate(filePath)) {
      bucket.push(filePath);
    }
  }
  return bucket;
}

export function scriptExists(scriptPath) {
  return execFileSync(process.execPath, ["-e", `process.exit(require("fs").existsSync(${JSON.stringify(scriptPath)})?0:1)`], {
    stdio: "ignore",
  });
}

export function classifyTaskShape(task) {
  const text = String(task ?? "").toLowerCase();
  const runtimePlatformSignal =
    /hook|runtime|codex|claude|cursor|openclaw|windows|mac|wsl|钩子|运行时|安装|更新|配置|沙盒|权限|审批/.test(text) ||
    /平台.{0,12}(key|adapter|适配|注册|路由|hook|钩子|mcp|权限|配置|安装|更新|同步|投影)|(?:key|adapter|hook|mcp|权限|配置|安装|更新|同步|投影).{0,12}平台/.test(text);
  const businessContentSignal =
    /内容|营销|增长|推广|投放|标题|文案|封面|素材|受众|转化|流量|传播|图文|视频|campaign|content|copy|audience|creative|conversion/.test(text);
  if (runtimePlatformSignal && !businessContentSignal) {
    return "platform_governance";
  }
  if (/goal\s*prompt|loop\s*prompt|goalpro|goal\s*contract|intent amplification|目标契约|目标合同|意图放大|循环提示词/.test(text)) {
    return "goal_contract";
  }
  if (/strategy|growth|moneti[sz]e|pricing|business|product|pmf|conversion|decision|judge|判断|决策|选择|取舍|pass.?kill|策略|增长|商业化|变现|定价|产品|转化|留存|分发|用户路径|高流量/.test(text)) {
    return "strategy_product_decision";
  }
  if (/refactor|code|test|api|database|bug|integration|重构|代码|测试|接口|数据库|缺陷|集成/.test(text)) {
    return "engineering_execution";
  }
  if (/content|article|story|copy|narrative|内容|文章|叙事|文案|传播/.test(text)) {
    return "content_creation";
  }
  return "fuzzy_complex_task";
}

export function scoreRoute({ intentFit, ownerFit, weaponFit, dependencyFit, runtimeSupport, osSupport, verification, riskClarity }) {
  return Math.round(
    intentFit * 0.2 +
      ownerFit * 0.15 +
      weaponFit * 0.15 +
      dependencyFit * 0.15 +
      runtimeSupport * 0.1 +
      osSupport * 0.1 +
      verification * 0.1 +
      riskClarity * 0.05,
  );
}

export function supportScore(value) {
  return value === "native" || value === "supported"
    ? 100
    : value === "partial"
      ? 65
      : value === "unknown"
        ? 35
        : 0;
}

export function fail(message) {
  throw new Error(message);
}

export function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}
