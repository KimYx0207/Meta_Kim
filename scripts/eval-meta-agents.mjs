import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const rawArgs = process.argv.slice(2);
const requireAllRuntimes = process.argv.includes("--require-all-runtimes");
const evalMode = rawArgs.includes("--live") || rawArgs.includes("--mode=live")
  ? "live"
  : "smoke";
const runtimeArg = rawArgs.find((arg) => arg.startsWith("--runtime="));
const selectedRuntimes = new Set(
  runtimeArg
    ? runtimeArg
        .slice("--runtime=".length)
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
    : ["claude", "codex", "openclaw"]
);
const claudeAgentsDir = path.join(repoRoot, ".claude", "agents");
const openclawLocalConfigPath = path.join(repoRoot, "openclaw", "openclaw.local.json");
const prepareOpenClawScriptPath = path.join(repoRoot, "scripts", "prepare-openclaw-local.mjs");
const activeChildren = new Map();
let cleanupInFlight = false;

function readEnvCliOverride(envKey) {
  const raw = process.env[envKey];
  if (raw == null) {
    return null;
  }
  const trimmed = String(raw).trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Node child processes may inherit a shorter PATH than an interactive terminal
 * (npm global shims are often under `%AppData%\\npm`). These dirs are checked first.
 */
function getWindowsCliSearchDirs() {
  const dirs = [];
  const ap = process.env.APPDATA;
  const lap = process.env.LOCALAPPDATA;
  const up = process.env.USERPROFILE;
  if (ap) {
    dirs.push(path.join(ap, "npm"));
  }
  if (lap) {
    dirs.push(path.join(lap, "Programs"));
    dirs.push(path.join(lap, "Microsoft", "WinGet", "Links"));
    dirs.push(path.join(lap, "npm"));
  }
  if (up) {
    dirs.push(path.join(up, "scoop", "shims"));
    dirs.push(path.join(up, ".local", "bin"));
  }
  return [...new Set(dirs)];
}

function buildWindowsEnrichedPathEnv() {
  const extra = getWindowsCliSearchDirs();
  const existing = (process.env.PATH || "")
    .split(path.delimiter)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const merged = [...extra, ...existing];
  return {
    ...process.env,
    NO_COLOR: "1",
    PATH: merged.join(path.delimiter),
  };
}

function commandSpecFromResolvedPath(resolved) {
  const lower = resolved.toLowerCase();
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    return {
      file: "cmd.exe",
      toArgs: (args) => ["/d", "/c", resolved, ...args.map(String)],
    };
  }
  return { file: resolved, toArgs: (args) => args.map(String) };
}

/**
 * Look for `{name}.cmd` / `{name}.exe` on disk (no reliance on PATH).
 */
async function resolveWindowsCliByWellKnownDirs(unixName) {
  for (const dir of getWindowsCliSearchDirs()) {
    for (const ext of [".cmd", ".exe", ".CMD", ".EXE"]) {
      const full = path.join(dir, `${unixName}${ext}`);
      if (await fileExists(full)) {
        return commandSpecFromResolvedPath(full);
      }
    }
  }
  return null;
}

/**
 * Resolve a CLI to `{ file, toArgs }` so Windows can find `.cmd` / `.exe` shims reliably.
 *
 * @param {{ envKey: string, unixName: string, winWhereCandidates: string[] }} spec
 * @returns {Promise<{ file: string, toArgs: (args: string[]) => string[] }>}
 */
async function resolveCliCommand(spec) {
  const { envKey, unixName, winWhereCandidates } = spec;
  const override = readEnvCliOverride(envKey);
  if (override) {
    if (process.platform === "win32") {
      const lower = override.toLowerCase();
      if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
        return {
          file: "cmd.exe",
          toArgs: (args) => ["/d", "/c", override, ...args.map(String)],
        };
      }
    }
    return { file: override, toArgs: (args) => args.map(String) };
  }

  if (process.platform !== "win32") {
    return { file: unixName, toArgs: (args) => args.map(String) };
  }

  const direct = await resolveWindowsCliByWellKnownDirs(unixName);
  if (direct) {
    return direct;
  }

  const env = buildWindowsEnrichedPathEnv();
  for (const candidate of winWhereCandidates) {
    try {
      const { stdout } = await execFileAsync("where.exe", [candidate], {
        cwd: repoRoot,
        timeout: 20_000,
        env,
      });
      const resolved = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (!resolved) {
        continue;
      }
      return commandSpecFromResolvedPath(resolved);
    } catch {
      // try next candidate
    }
  }

  throw new Error(
    `${unixName} command not found. This Node process may inherit a shorter PATH than your usual shell ` +
      `(npm global shims are often under %APPDATA%\\npm). Set ${envKey} to the full path of the executable, ` +
      `or run the same command from a terminal where "${unixName}" already works.`
  );
}

function isRuntimeSelected(runtimeName) {
  return selectedRuntimes.has(runtimeName);
}

function logProgress(message) {
  process.stderr.write(`[eval:agents:${evalMode}] ${message}\n`);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function markChildActive(child, label) {
  activeChildren.set(child.pid, { child, label });
  child.once("close", () => {
    activeChildren.delete(child.pid);
  });
}

async function killProcessTree(pid, options = {}) {
  const signal = options.signal ?? "SIGTERM";
  if (!pid) {
    return;
  }

  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        cwd: repoRoot,
        timeout: 15_000,
        windowsHide: true,
      });
    } catch {
      // Best-effort cleanup; process may already be gone.
    }
    return;
  }

  const targets = [-pid, pid];
  for (const target of targets) {
    try {
      process.kill(target, signal);
      return;
    } catch {
      // try next target
    }
  }
}

async function terminateChildTree(child, options = {}) {
  const pid = child?.pid;
  if (!pid || child.exitCode !== null) {
    return;
  }

  const graceMs = options.graceMs ?? 5_000;
  await killProcessTree(pid, { signal: "SIGTERM" });

  for (let waited = 0; waited < graceMs; waited += 100) {
    if (child.exitCode !== null) {
      return;
    }
    await delay(100);
  }

  await killProcessTree(pid, { signal: "SIGKILL" });
}

async function cleanupActiveChildren(reason) {
  if (cleanupInFlight) {
    return;
  }
  cleanupInFlight = true;

  const entries = [...activeChildren.values()];
  if (entries.length > 0) {
    logProgress(`${reason}; cleaning ${entries.length} child process(es)`);
  }

  await Promise.allSettled(
    entries.map(({ child }) => terminateChildTree(child))
  );
}

function installSignalCleanup() {
  const handleSignal = (signal) => {
    void cleanupActiveChildren(`received ${signal}`).finally(() => {
      process.exitCode = 130;
      process.exit();
    });
  };

  process.once("SIGINT", () => handleSignal("SIGINT"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));
}

/** Only resolve CLIs and print JSON — same logic as eval, no smoke tests. */
async function probeClisOnly() {
  const winWhere = {
    claude: ["claude.cmd", "claude", "claude.exe"],
    codex: ["codex.cmd", "codex", "codex.exe"],
    openclaw: ["openclaw.cmd", "openclaw", "openclaw.exe"],
  };

  async function describeOne(unixName, envKey) {
    const override = readEnvCliOverride(envKey);
    const directHits = [];
    if (process.platform === "win32") {
      for (const dir of getWindowsCliSearchDirs()) {
        for (const ext of [".cmd", ".exe", ".CMD", ".EXE"]) {
          const full = path.join(dir, `${unixName}${ext}`);
          if (await fileExists(full)) {
            directHits.push(full);
          }
        }
      }
    }

    try {
      const spec = await resolveCliCommand({
        envKey,
        unixName,
        winWhereCandidates: winWhere[unixName],
      });
      const sampleArgs = unixName === "openclaw" ? ["--help"] : ["--version"];
      const argv0 =
        spec.file === "cmd.exe" ? spec.toArgs(sampleArgs).slice(0, 3).join(" ") : spec.file;
      return {
        name: unixName,
        found: true,
        envOverride: override,
        directFileHits: directHits,
        resolvedLauncher: spec.file,
        probeArgvPreview: argv0,
      };
    } catch (error) {
      return {
        name: unixName,
        found: false,
        envOverride: override,
        directFileHits: directHits,
        error: error.message,
      };
    }
  }

  const out = {
    platform: process.platform,
    searchDirs: process.platform === "win32" ? getWindowsCliSearchDirs() : [],
    claude: await describeOne("claude", "META_KIM_CLAUDE_BIN"),
    codex: await describeOne("codex", "META_KIM_CODEX_BIN"),
    openclaw: await describeOne("openclaw", "META_KIM_OPENCLAW_BIN"),
  };

  console.log(JSON.stringify(out, null, 2));
  const allFound = out.claude.found && out.codex.found && out.openclaw.found;
  process.exitCode = allFound ? 0 : 1;
}

let resolvedClaudeCmdPromise = null;
function getResolvedClaudeCommand() {
  if (!resolvedClaudeCmdPromise) {
    resolvedClaudeCmdPromise = resolveCliCommand({
      envKey: "META_KIM_CLAUDE_BIN",
      unixName: "claude",
      winWhereCandidates: ["claude.cmd", "claude", "claude.exe"],
    });
  }
  return resolvedClaudeCmdPromise;
}

let resolvedCodexCmdPromise = null;
function getResolvedCodexCommand() {
  if (!resolvedCodexCmdPromise) {
    resolvedCodexCmdPromise = resolveCliCommand({
      envKey: "META_KIM_CODEX_BIN",
      unixName: "codex",
      winWhereCandidates: ["codex.cmd", "codex", "codex.exe"],
    });
  }
  return resolvedCodexCmdPromise;
}

const claudeSchema = JSON.stringify({
  type: "object",
  properties: {
    agent: { type: "string" },
    owns: { type: "array", items: { type: "string" } },
    refuses: { type: "array", items: { type: "string" } },
    artifact: { type: "string" },
    delegates_to: { type: "array", items: { type: "string" } },
  },
  required: ["agent", "owns", "refuses", "artifact", "delegates_to"],
});

const codexSmokeSchema = JSON.stringify({
  type: "object",
  additionalProperties: false,
  properties: {
    runtime: { type: "string" },
    entrypoint: { type: "string" },
    project_skill_root: { type: "string" },
    compat_skill_mirror: { type: "string" },
    has_meta_warden_agent: { type: "boolean" },
    mcp_supported: { type: "boolean" },
    sandbox_configurable: { type: "boolean" },
    approvals_configurable: { type: "boolean" },
  },
  required: [
    "runtime",
    "entrypoint",
    "project_skill_root",
    "compat_skill_mirror",
    "has_meta_warden_agent",
    "mcp_supported",
    "sandbox_configurable",
    "approvals_configurable",
  ],
});

const claudeCases = {
  "meta-warden": {
    ownGroups: [["统筹", "协调", "编排", "orchestration", "coordination", "质量标准", "quality standard", "CEO"], ["quality gate", "meta-review", "verification", "commission", "dispatch approval", "闸门", "校验", "验证闭环"], ["综合", "合成", "整合", "审计", "CEO报告", "最终", "final synthesis", "synthesis", "report", "audit", "evolution backlog"]],
    refuseGroups: [["具体分析", "质量分析", "技术分析", "analysis"], ["工具发现", "tool discovery", "Scout", "scout", "SOUL", "soul"]],
    artifactGroups: [["报告", "report", "综合", "synthesis", "go/no-go", "仲裁"]],
  },
  "meta-genesis": {
    ownGroups: [["SOUL", "soul", "提示词", "prompt"], ["人格", "灵魂", "identity", "system", "系统", "stress testing", "behavioral anchors"], ["架构", "设计", "design", "decision rules", "thinking framework", "anti-ai-slop"]],
    refuseGroups: [["Hook", "hook", "权限", "安全", "security", "memory"], ["MCP", "skill", "技能", "记忆", "memory", "matching"]],
    artifactGroups: [["SOUL", "soul", "prompt", "提示词"]],
  },
  "meta-artisan": {
    ownGroups: [["skill", "技能"], ["MCP", "工具", "ROI", "评分", "精选", "tool"], ["匹配", "装备", "能力", "matching", "loadout", "capability"]],
    refuseGroups: [["SOUL", "prompt", "提示词"], ["记忆", "memory", "Hook", "hook", "钩子", "安全", "security"]],
    artifactGroups: [["skill", "MCP", "能力清单", "映射", "report"]],
  },
  "meta-sentinel": {
    ownGroups: [["安全", "风险", "权限", "security", "threat"], ["Hook", "hook", "守卫"], ["回滚", "rollback", "边界", "策略", "三级", "CAN", "CANNOT", "NEVER"]],
    refuseGroups: [["SOUL", "prompt", "提示词"], ["工具发现", "tool discovery", "skill", "技能", "工作流", "编排", "workflow", "orchestration"]],
    artifactGroups: [["Hook", "hook", "回滚", "rollback", "安全规则", "security rules", "守卫", "audit"]],
  },
  "meta-librarian": {
    ownGroups: [["记忆", "memory", "知识", "MEMORY"], ["连续性", "沉淀", "架构", "architecture", "continuity", "persistence"], ["上下文", "档案", "索引", "保质期", "淘汰规则", "protocol", "strategy", "expiration"]],
    refuseGroups: [["SOUL", "prompt", "提示词", "design"], ["skill", "技能", "Hook", "hook", "权限", "security", "workflow"]],
    artifactGroups: [["记忆", "索引", "档案", "memory"]],
  },
  "meta-conductor": {
    ownGroups: [["编排", "workflow", "工作流", "orchestration"], ["阶段", "phase", "节奏", "rhythm", "节拍"], ["牌组", "卡牌", "card deck", "发牌", "调度", "分发", "协作", "分工", "delivery shell", "交付外壳", "handoff", "sequencing"]],
    refuseGroups: [["SOUL", "prompt", "提示词"], ["技能匹配", "技能到 agent", "skill→agent", "matching", "安全", "权限", "记忆", "security", "memory"]],
    artifactGroups: [["workflow", "工作流", "计划", "编排", "orchestration", "牌组", "card deck"]],
  },
  "meta-prism": {
    ownGroups: [["质量", "审查", "review", "quality", "forensics"], ["slop", "漂移", "缺陷", "defect", "evolution signal"], ["验证", "回归", "verification", "regression", "assertion", "tracking"]],
    refuseGroups: [["工具发现", "tool discovery", "Scout", "scout"], ["统筹", "coordination", "Warden", "warden", "SOUL", "soul", "design"]],
    artifactGroups: [["审查", "报告", "缺陷", "review", "report", "analysis"]],
  },
  "meta-scout": {
    ownGroups: [
      ["发现", "discovery", "扫描", "baseline", "基线", "capability", "能力基线"],
      ["工具", "tool", "skill", "MCP", "ROI"],
      ["生态", "外部", "引入", "external", "candidate", "adoption"],
    ],
    refuseGroups: [
      ["质量法医", "质量审查", "quality forensics", "Prism", "prism"],
      [
        "安全",
        "final security",
        "Hook",
        "hook",
        "SOUL",
        "Artisan",
        "artisan",
        "Conductor",
        "conductor",
        "loadout",
        "发牌",
        "sequencing",
        "dispatch",
      ],
    ],
    artifactGroups: [["清单", "地图", "调研", "扫描", "分析报告", "report", "recommendation"]],
  },
};

/** meta-scout: phrases in `owns` indicate boundary bleed into Artisan / Conductor. */
const META_SCOUT_OWNS_DRIFT_MARKERS = [
  "skill loadout",
  "loadout from soul",
  "dispatch board",
  "stage-card lanes",
  "skill→agent",
  "skill to agent",
  "orchestration design",
  "工作流编排",
  "发牌调度",
];

function metaScoutOwnsDriftsArtisanOrConductor(payload) {
  const owns = normalize(payload?.owns).toLowerCase();
  if (!owns.trim()) {
    return false;
  }
  return META_SCOUT_OWNS_DRIFT_MARKERS.some((marker) => owns.includes(marker));
}

function normalize(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item)).join(" ");
  }
  return String(value || "")
    .toLowerCase()
    .replace(/[_\-\/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function keywordGroupMatched(text, keywords) {
  return keywords.some((keyword) => text.includes(normalize(keyword)));
}

function parseJsonLines(raw) {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const parsed = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {}
  }
  return parsed;
}

function extractLastCompleteJsonObject(raw) {
  const text = String(raw || "");
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let last = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        last = text.slice(start, index + 1);
        start = -1;
      }
    }
  }

  return last;
}

function extractBalancedJsonFromIndex(text, startIndex) {
  if (startIndex < 0 || startIndex >= text.length || text[startIndex] !== "{") {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function extractJsonObjectByAnchor(raw, anchor) {
  const text = String(raw || "");
  let anchorIndex = text.lastIndexOf(anchor);

  while (anchorIndex !== -1) {
    let startIndex = text.lastIndexOf("{", anchorIndex);

    while (startIndex !== -1) {
      const candidate = extractBalancedJsonFromIndex(text, startIndex);
      if (candidate) {
        return candidate;
      }
      startIndex = text.lastIndexOf("{", startIndex - 1);
    }

    anchorIndex = text.lastIndexOf(anchor, anchorIndex - 1);
  }

  return null;
}

function parseLastJson(raw) {
  const parsedLines = parseJsonLines(raw);
  if (parsedLines.length > 0) {
    return parsedLines.at(-1);
  }

  const trimmed = String(raw || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const trailingObject = extractLastCompleteJsonObject(trimmed);
    if (trailingObject) {
      try {
        return JSON.parse(trailingObject);
      } catch {}
    }

    for (let index = trimmed.lastIndexOf("{"); index >= 0; index = trimmed.lastIndexOf("{", index - 1)) {
      try {
        return JSON.parse(trimmed.slice(index));
      } catch {}
    }
    return null;
  }
}

function extractClaudeStructured(raw) {
  const parsed = parseLastJson(raw);
  if (!parsed) {
    throw new Error("Claude output was not valid JSON.");
  }
  return parsed.structured_output || parsed.result || parsed;
}

function extractCodexReply(raw) {
  const events = parseJsonLines(raw);
  const lastMessage = [...events]
    .reverse()
    .find((event) => event.type === "item.completed" && event.item?.type === "agent_message");

  if (!lastMessage?.item?.text) {
    throw new Error("Codex did not emit a final agent message.");
  }

  try {
    return JSON.parse(lastMessage.item.text);
  } catch {
    return { raw: lastMessage.item.text };
  }
}

async function resolveOpenClawCommand() {
  return resolveCliCommand({
    envKey: "META_KIM_OPENCLAW_BIN",
    unixName: "openclaw",
    winWhereCandidates: ["openclaw.cmd", "openclaw", "openclaw.exe"],
  });
}

function extractOpenClawReply(raw) {
  const anchoredObject = extractJsonObjectByAnchor(raw, '"payloads"');
  const parsed = anchoredObject ? JSON.parse(anchoredObject) : parseLastJson(raw);
  if (!parsed) {
    return { raw: raw.trim() };
  }

  const payloadText = parsed.payloads?.[0]?.text;
  if (typeof payloadText === "string" && payloadText.trim()) {
    try {
      return {
        ...JSON.parse(payloadText),
        wrapper: parsed,
      };
    } catch {
      return {
        raw: payloadText.trim(),
        wrapper: parsed,
      };
    }
  }

  const textCandidate =
    parsed.reply?.text ||
    parsed.output?.text ||
    parsed.message?.text ||
    parsed.response?.text ||
    parsed.text ||
    "";

  if (typeof textCandidate === "string" && textCandidate.trim()) {
    try {
      return JSON.parse(textCandidate);
    } catch {
      return { raw: textCandidate.trim(), wrapper: parsed };
    }
  }

  return parsed;
}

function mergeCommandOutput(stdout, stderr) {
  const merged = [String(stdout || "").trim(), String(stderr || "").trim()]
    .filter(Boolean)
    .join("\n");
  return merged;
}

function isRetryableClaudeFailure(message) {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("timed out after") ||
    normalized.includes("负载已经达到上限") ||
    normalized.includes("rate limit") ||
    normalized.includes("overload") ||
    normalized.includes("service unavailable") ||
    normalized.includes("try again later") ||
    normalized.includes("api error: 500")
  );
}

function isRetryableCodexFailure(message) {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("usage limit") ||
    normalized.includes("purchase more credits") ||
    normalized.includes("try again at") ||
    normalized.includes("rate limit") ||
    normalized.includes("overload") ||
    normalized.includes("service unavailable")
  );
}

function isOptionalRuntimeUnavailable(message) {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("enoent") ||
    normalized.includes("not recognized as an internal or external command") ||
    normalized.includes("command not found") ||
    normalized.includes("openclaw command not found") ||
    normalized.includes("codex command not found") ||
    normalized.includes("claude command not found") ||
    normalized.includes("could not locate openclaw")
  );
}

function summarizeClaudeRuntime(discovery, results) {
  const allRetryableSkipped =
    results.length > 0 && results.every((result) => result.skipped === true && result.retryable === true);
  const hardFailures = results.filter((result) => result.ok === false && result.skipped !== true);
  const partialRetryableSkips = results.filter(
    (result) => result.skipped === true && result.retryable === true
  );

  if (!discovery.ok || hardFailures.length > 0) {
    return {
      status: "failed",
      ok: false,
      discovery,
      results,
    };
  }

  if (allRetryableSkipped) {
    return {
      status: "skipped",
      ok: false,
      discovery,
      results,
      reason: "claude_runtime_unavailable",
    };
  }

  if (partialRetryableSkips.length > 0) {
    return {
      status: "skipped",
      ok: false,
      discovery,
      results,
      reason: "claude_runtime_incomplete",
      detail: `${partialRetryableSkips.length} agent self-checks were skipped after a retryable Claude runtime failure.`,
    };
  }

  return {
    status: "passed",
    ok: true,
    discovery,
    results,
  };
}

function summarizeRuntimeReport(runtimeName, report) {
  if (!report) {
    return { runtime: runtimeName, status: "failed" };
  }

  if (report.status) {
    return { runtime: runtimeName, status: report.status };
  }

  return {
    runtime: runtimeName,
    status: report.ok === true ? "passed" : "failed",
  };
}

async function runCommandWithIgnoredStdin(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    markChildActive(child, `${file} ${args.join(" ")}`);

    let stdout = "";
    let stderr = "";
    let finished = false;
    let timeoutId = null;

    function settle(error, result) {
      if (finished) {
        return;
      }
      finished = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    }

    if (typeof options.timeout === "number" && options.timeout > 0) {
      timeoutId = setTimeout(() => {
        void terminateChildTree(child).finally(() => {
          settle(
            new Error(
              `Command timed out after ${options.timeout}ms: ${file} ${args.join(" ")}`
            )
          );
        });
      }, options.timeout);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      settle(error);
    });

    child.on("close", (code, signal) => {
      if (finished) {
        return;
      }
      if (code === 0) {
        settle(null, { stdout, stderr });
        return;
      }

      const failureDetails = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
      const suffix = signal ? ` (signal: ${signal})` : "";
      settle(
        new Error(
          `Command failed: ${file} ${args.join(" ")}${suffix}${
            failureDetails ? `\n${failureDetails}` : ""
          }`
        )
      );
    });
  });
}

function openClawStructuredPayloadLooksReal(agentId, payload) {
  if (!payload || typeof payload !== "object" || payload.agent !== agentId) {
    return false;
  }
  const owns = payload.owns;
  const refuses = payload.refuses;
  const delegates = payload.delegates_to;
  const artifact = payload.artifact;

  const ownsOk =
    Array.isArray(owns) &&
    owns.length >= 3 &&
    owns.every((item) => String(item ?? "").trim().length >= 2);
  const refusesOk =
    Array.isArray(refuses) &&
    refuses.length >= 2 &&
    refuses.every((item) => String(item ?? "").trim().length >= 2);
  const delegatesOk =
    Array.isArray(delegates) &&
    delegates.length >= 2 &&
    delegates.every((item) => String(item ?? "").trim().length >= 1);
  const artifactOk = typeof artifact === "string" && artifact.trim().length >= 4;

  return ownsOk && refusesOk && delegatesOk && artifactOk;
}

const OPENCLAW_BOUNDARY_SCORE_MIN = 0.72;

function scoreClaudeCase(caseConfig, payload) {
  const joined = [
    payload.agent,
    normalize(payload.owns),
    normalize(payload.refuses),
    payload.artifact,
    normalize(payload.delegates_to),
  ]
    .join(" ")
    .toLowerCase();

  const matchedGroups = [];
  const missedGroups = [];

  for (const [label, groups] of Object.entries({
    own: caseConfig.ownGroups,
    refuse: caseConfig.refuseGroups,
    artifact: caseConfig.artifactGroups,
  })) {
    groups.forEach((group, index) => {
      const hit = keywordGroupMatched(joined, group);
      const entry = `${label}:${index + 1}`;
      if (hit) {
        matchedGroups.push(entry);
      } else {
        missedGroups.push(entry);
      }
    });
  }

  const totalGroups = matchedGroups.length + missedGroups.length;
  const score = totalGroups === 0 ? 1 : matchedGroups.length / totalGroups;
  return {
    score,
    matchedGroups,
    missedGroups,
  };
}

async function loadClaudeAgentIds() {
  const files = (await fs.readdir(claudeAgentsDir))
    .filter((file) => file.endsWith(".md"))
    .sort();

  return files.map((file) => file.replace(/\.md$/, ""));
}

async function runClaudeDiscovery(agentIds) {
  logProgress(`Claude discovery: checking ${agentIds.length} registered agent(s)`);
  const cmd = await getResolvedClaudeCommand();
  const { stdout } = await runCommandWithIgnoredStdin(cmd.file, cmd.toArgs(["agents"]), {
    cwd: repoRoot,
    timeout: 120_000,
    env: { ...process.env, NO_COLOR: "1" },
  });

  const missing = agentIds.filter((agentId) => !stdout.includes(agentId));
  return {
    ok: missing.length === 0,
    missing,
  };
}

async function runClaudeSmoke(agentIds) {
  const discovery = await runClaudeDiscovery(agentIds);
  return {
    status: discovery.ok ? "passed" : "failed",
    ok: discovery.ok,
    discovery,
    mode: "smoke",
  };
}

async function runClaudeCases(agentIds) {
  const results = [];

  for (let index = 0; index < agentIds.length; index += 1) {
    const agentId = agentIds[index];
    logProgress(`Claude live case ${index + 1}/${agentIds.length}: ${agentId}`);
    const caseConfig = claudeCases[agentId];
    if (!caseConfig) {
      results.push({
        agentId,
        ok: false,
        error: "No eval case configured.",
      });
      continue;
    }

    try {
      const prompt =
        "你正在做 Meta_Kim 元 agent 角色边界自检。只返回符合 schema 的 JSON，不要解释。" +
        "agent 写你的 agent id；owns 写你只负责的 3 个短语；refuses 写你明确不负责的 2 个短语；" +
        "artifact 写你最核心的产物；delegates_to 写跨边界时最常升级/委派的 2 个 agent id。";

      const cmd = await getResolvedClaudeCommand();
      const { stdout } = await runCommandWithIgnoredStdin(
        cmd.file,
        cmd.toArgs([
          "-p",
          "--output-format",
          "json",
          "--agent",
          agentId,
          "--json-schema",
          claudeSchema,
          prompt,
        ]),
        {
          cwd: repoRoot,
          timeout: 150_000,
          env: { ...process.env, NO_COLOR: "1" },
        }
      );

      const payload = extractClaudeStructured(stdout);
      const { score, matchedGroups, missedGroups } = scoreClaudeCase(caseConfig, payload);
      const scoutDrift =
        agentId === "meta-scout" && metaScoutOwnsDriftsArtisanOrConductor(payload);
      results.push({
        agentId,
        ok: payload.agent === agentId && score >= 0.8 && !scoutDrift,
        score,
        matchedGroups,
        missedGroups,
        ...(scoutDrift ? { scoutArtisanConductorDrift: true } : {}),
        sample: payload,
      });
    } catch (error) {
      if (isRetryableClaudeFailure(error.message)) {
        results.push({
          agentId,
          ok: false,
          skipped: true,
          retryable: true,
          reason: "claude_runtime_unavailable",
          error: error.message,
        });

        for (const remainingAgentId of agentIds.slice(index + 1)) {
          results.push({
            agentId: remainingAgentId,
            ok: false,
            skipped: true,
            retryable: true,
            reason: "claude_runtime_unavailable",
            error: `Skipped after ${agentId} hit a retryable Claude runtime failure.`,
          });
        }
        break;
      }

      results.push({
        agentId,
        ok: false,
        error: error.message,
      });
    }
  }

  return results;
}

async function runClaudeLive(agentIds) {
  const discovery = await runClaudeDiscovery(agentIds);
  const results = await runClaudeCases(agentIds);
  return summarizeClaudeRuntime(discovery, results);
}

async function runCodexSmoke() {
  const codexCmd = await getResolvedCodexCommand();
  let versionStdout;
  try {
    logProgress("Codex smoke: probing CLI and structural repo wiring");
    ({ stdout: versionStdout } = await runCommandWithIgnoredStdin(
      codexCmd.file,
      codexCmd.toArgs(["--version"]),
      {
        cwd: repoRoot,
        timeout: 30_000,
        env: { ...process.env, NO_COLOR: "1" },
      }
    ));
  } catch (error) {
    if (isOptionalRuntimeUnavailable(error.message)) {
      return {
        status: "skipped",
        ok: false,
        retryable: true,
        reason: "codex_runtime_unavailable",
        error: error.message,
      };
    }
    throw error;
  }

  const configExamplePath = path.join(repoRoot, "codex", "config.toml.example");
  const configExample = await fs.readFile(configExamplePath, "utf8");
  const codexAgentFiles = (await fs.readdir(path.join(repoRoot, ".codex", "agents")))
    .filter((file) => file.endsWith(".toml"))
    .sort();
  const payload = {
    runtime: "codex",
    cli_version: versionStdout.trim(),
    entrypoint: "AGENTS.md",
    project_skill_root: ".agents/skills/meta-theory",
    compat_skill_mirror: ".codex/skills/meta-theory.md",
    custom_agents: codexAgentFiles.map((file) => file.replace(/\.toml$/, "")),
    mcp_supported: configExample.includes("[mcp_servers.meta_kim_runtime]"),
    sandbox_configurable: configExample.includes("sandbox_mode"),
    approvals_configurable: configExample.includes("approval_policy"),
  };

  const structuralOk =
    payload.runtime === "codex" &&
    payload.entrypoint === "AGENTS.md" &&
    payload.project_skill_root === ".agents/skills/meta-theory" &&
    payload.compat_skill_mirror === ".codex/skills/meta-theory.md" &&
    payload.custom_agents.includes("meta-warden") &&
    payload.mcp_supported === true &&
    payload.sandbox_configurable === true &&
    payload.approvals_configurable === true;

  return {
    status: structuralOk ? "passed" : "failed",
    ok: structuralOk,
    mode: "smoke",
    sample: payload,
  };
}

async function runCodexLive() {
  const codexCmd = await getResolvedCodexCommand();
  let versionStdout;
  try {
    logProgress("Codex live: probing CLI and running repository smoke prompt");
    ({ stdout: versionStdout } = await runCommandWithIgnoredStdin(
      codexCmd.file,
      codexCmd.toArgs(["--version"]),
      {
        cwd: repoRoot,
        timeout: 30_000,
        env: { ...process.env, NO_COLOR: "1" },
      }
    ));
  } catch (error) {
    if (isOptionalRuntimeUnavailable(error.message)) {
      return {
        status: "skipped",
        ok: false,
        retryable: true,
        reason: "codex_runtime_unavailable",
        error: error.message,
      };
    }
    throw error;
  }

  const configExamplePath = path.join(repoRoot, "codex", "config.toml.example");
  const configExample = await fs.readFile(configExamplePath, "utf8");
  const codexAgentFiles = (await fs.readdir(path.join(repoRoot, ".codex", "agents")))
    .filter((file) => file.endsWith(".toml"))
    .sort();
  const payload = {
    runtime: "codex",
    cli_version: versionStdout.trim(),
    entrypoint: "AGENTS.md",
    project_skill_root: ".agents/skills/meta-theory",
    compat_skill_mirror: ".codex/skills/meta-theory.md",
    custom_agents: codexAgentFiles.map((file) => file.replace(/\.toml$/, "")),
    mcp_supported: configExample.includes("[mcp_servers.meta_kim_runtime]"),
    sandbox_configurable: configExample.includes("sandbox_mode"),
    approvals_configurable: configExample.includes("approval_policy"),
  };

  const structuralOk =
    payload.runtime === "codex" &&
    payload.entrypoint === "AGENTS.md" &&
    payload.project_skill_root === ".agents/skills/meta-theory" &&
    payload.compat_skill_mirror === ".codex/skills/meta-theory.md" &&
    payload.custom_agents.includes("meta-warden") &&
    payload.mcp_supported === true &&
    payload.sandbox_configurable === true &&
    payload.approvals_configurable === true;

  const schemaDir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-codex-"));
  const schemaPath = path.join(schemaDir, "codex-smoke.schema.json");
  await fs.writeFile(schemaPath, codexSmokeSchema, "utf8");

  let runtimePayload = null;
  try {
    const prompt =
      "Read the current Meta_Kim repository and reply with JSON only. " +
      'runtime must be "codex". entrypoint must be "AGENTS.md". ' +
      'project_skill_root must be ".agents/skills/meta-theory". ' +
      'compat_skill_mirror must be ".codex/skills/meta-theory.md". ' +
      "has_meta_warden_agent must be true only if the repo exposes that custom agent. " +
      "mcp_supported, sandbox_configurable, and approvals_configurable must reflect the repository configuration. " +
      "Do not modify files.";

    const { stdout } = await runCommandWithIgnoredStdin(
      codexCmd.file,
      codexCmd.toArgs([
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--output-schema",
        schemaPath,
        "--cd",
        repoRoot,
        prompt,
      ]),
      {
        cwd: repoRoot,
        timeout: 180_000,
        env: { ...process.env, NO_COLOR: "1" },
      }
    );

    runtimePayload = extractCodexReply(stdout);
  } catch (error) {
    if (isRetryableCodexFailure(error.message)) {
      return {
        status: "skipped",
        ok: structuralOk,
        skipped: true,
        retryable: true,
        reason: "codex_runtime_unavailable",
        sample: {
          ...payload,
          runtime_smoke: {
            skipped: true,
            reason: "codex_runtime_unavailable",
            error: error.message,
          },
        },
      };
    }
    throw error;
  } finally {
    await fs.rm(schemaDir, { recursive: true, force: true });
  }

  const ok =
    structuralOk &&
    runtimePayload?.runtime === "codex" &&
    runtimePayload?.entrypoint === "AGENTS.md" &&
    runtimePayload?.project_skill_root === ".agents/skills/meta-theory" &&
    runtimePayload?.compat_skill_mirror === ".codex/skills/meta-theory.md" &&
    runtimePayload?.has_meta_warden_agent === true &&
    runtimePayload?.mcp_supported === true &&
    runtimePayload?.sandbox_configurable === true &&
    runtimePayload?.approvals_configurable === true;

  return {
    status: ok ? "passed" : "failed",
    ok,
    sample: {
      ...payload,
      runtime_smoke: runtimePayload,
    },
  };
}
 
async function collectOpenClawBaseStatus() {
  logProgress("OpenClaw smoke: preparing local config and validating hooks");
  await runCommandWithIgnoredStdin(
    "node",
    [prepareOpenClawScriptPath],
    {
      cwd: repoRoot,
      timeout: 120_000,
      env: { ...process.env, NO_COLOR: "1" },
    }
  );

  const command = await resolveOpenClawCommand();
  const env = {
    ...process.env,
    NO_COLOR: "1",
    OPENCLAW_CONFIG_PATH: openclawLocalConfigPath,
  };

  const validation = await runCommandWithIgnoredStdin(
    command.file,
    command.toArgs(["config", "validate"]),
    {
      cwd: repoRoot,
      timeout: 60_000,
      env,
    }
  );
  const validationOutput = mergeCommandOutput(validation.stdout, validation.stderr);

  let hooksDiscovery = {
    ok: false,
    output: "",
  };
  try {
    const hooks = await runCommandWithIgnoredStdin(
      command.file,
      command.toArgs(["hooks", "list", "--verbose"]),
      {
        cwd: repoRoot,
        timeout: 60_000,
        env,
      }
    );
    const hooksOutput = mergeCommandOutput(hooks.stdout, hooks.stderr);
    const hooksLower = hooksOutput.toLowerCase();
    const hooksNormalized = hooksLower.replace(/\s+/g, " ");
    hooksDiscovery = {
      ok:
        hooksNormalized.includes("boot-md") &&
        hooksNormalized.includes("command-") &&
        hooksNormalized.includes("logger") &&
        hooksNormalized.includes("session-") &&
        hooksNormalized.includes("memory"),
      output: hooksOutput,
    };
  } catch (error) {
    hooksDiscovery = {
      ok: false,
      output: error.message,
    };
  }

  return {
    command,
    env,
    validationOutput,
    hooksDiscovery,
  };
}

async function runOpenClawSmoke() {
  const baseStatus = await collectOpenClawBaseStatus();
  const ok =
    baseStatus.validationOutput.toLowerCase().includes("config valid") &&
    baseStatus.hooksDiscovery.ok;

  return {
    status: ok ? "passed" : "failed",
    ok,
    mode: "smoke",
    configOk: baseStatus.validationOutput.toLowerCase().includes("config valid"),
    hooksOk: baseStatus.hooksDiscovery.ok,
    hooksDiscovery: baseStatus.hooksDiscovery.output,
    validation: baseStatus.validationOutput,
  };
}

async function runOpenClawLive() {
  const baseStatus = await collectOpenClawBaseStatus();

  const smokeAgents = await loadClaudeAgentIds();
  const agentResults = [];

  for (const agentId of smokeAgents) {
    try {
      logProgress(`OpenClaw live case ${agentResults.length + 1}/${smokeAgents.length}: ${agentId}`);
      const caseConfig = claudeCases[agentId];
      const prompt =
        "你正在做 Meta_Kim 元 agent 角色边界自检。只输出一段 JSON，不要解释。" +
        `agent 必须精确写 ${agentId}（不能翻译、不能改写、不能写角色名）。` +
        "owns：字符串数组，恰好 3 条，每条是你明确负责的短句；" +
        "refuses：字符串数组，恰好 2 条，每条是你明确不负责的短句；" +
        "artifact：一个字符串，你最核心的产物；" +
        "delegates_to：字符串数组，恰好 2 个 agent id，跨边界时最常委派给谁。";
      const sessionId = `eval-${agentId}-${crypto.randomUUID()}`;
      const { stdout, stderr } = await runCommandWithIgnoredStdin(
        baseStatus.command.file,
        baseStatus.command.toArgs([
          "agent",
          "--local",
          "--agent",
          agentId,
          "--session-id",
          sessionId,
          "--message",
          prompt,
          "--json",
          "--timeout",
          "120",
        ]),
        {
          cwd: repoRoot,
          timeout: 180_000,
          env: baseStatus.env,
        }
      );

      const payload = extractOpenClawReply(mergeCommandOutput(stdout, stderr));
      const injectionOk =
        payload.wrapper?.meta?.systemPromptReport?.injectedWorkspaceFiles?.every(
          (item) => item.missing === false
        ) ?? false;
      const injectedWorkspaceFiles =
        payload.wrapper?.meta?.systemPromptReport?.injectedWorkspaceFiles?.map((item) => ({
          name: item.name,
          missing: item.missing,
          truncated: item.truncated,
        })) ?? [];

      const structuralOk = openClawStructuredPayloadLooksReal(agentId, payload);
      const scored = caseConfig
        ? scoreClaudeCase(caseConfig, payload)
        : { score: 0, matchedGroups: [], missedGroups: ["missing-case-config"] };
      const scoutDrift =
        agentId === "meta-scout" && metaScoutOwnsDriftsArtisanOrConductor(payload);
      const boundaryOk =
        structuralOk &&
        caseConfig != null &&
        scored.score >= OPENCLAW_BOUNDARY_SCORE_MIN &&
        !scoutDrift;

      agentResults.push({
        agentId,
        ok: boundaryOk && injectionOk,
        injectionOk,
        structuralOk,
        boundaryScore: scored.score,
        matchedGroups: scored.matchedGroups,
        missedGroups: scored.missedGroups,
        ...(scoutDrift ? { scoutArtisanConductorDrift: true } : {}),
        sample: {
          agent: payload.agent ?? null,
          owns: payload.owns ?? null,
          refuses: payload.refuses ?? null,
          artifact: payload.artifact ?? null,
          delegates_to: payload.delegates_to ?? null,
          injectedWorkspaceFiles,
        },
      });
    } catch (error) {
      agentResults.push({
        agentId,
        ok: false,
        error: error.message,
      });
    }
  }

  return {
    status:
      baseStatus.validationOutput.toLowerCase().includes("config valid") &&
      baseStatus.hooksDiscovery.ok &&
      agentResults.every((result) => result.ok && result.injectionOk)
        ? "passed"
        : "failed",
    ok:
      baseStatus.validationOutput.toLowerCase().includes("config valid") &&
      baseStatus.hooksDiscovery.ok &&
      agentResults.every((result) => result.ok && result.injectionOk),
    configOk: baseStatus.validationOutput.toLowerCase().includes("config valid"),
    hooksOk: baseStatus.hooksDiscovery.ok,
    hooksDiscovery: baseStatus.hooksDiscovery.output,
    validation: baseStatus.validationOutput,
    agentResults,
  };
}

async function main() {
  installSignalCleanup();
  for (const runtimeName of selectedRuntimes) {
    if (!["claude", "codex", "openclaw"].includes(runtimeName)) {
      throw new Error(`Unknown runtime filter: ${runtimeName}`);
    }
  }
  logProgress(`starting ${evalMode} evaluation for ${[...selectedRuntimes].join(", ")}`);

  const agentIds = await loadClaudeAgentIds();
  const report = {
    timestamp: new Date().toISOString(),
    mode: evalMode,
    requestedRuntimes: [...selectedRuntimes],
    claude: null,
    codex: null,
    openclaw: null,
  };

  try {
    if (isRuntimeSelected("claude")) {
      try {
        report.claude =
          evalMode === "live"
            ? await runClaudeLive(agentIds)
            : await runClaudeSmoke(agentIds);
      } catch (error) {
        report.claude = isOptionalRuntimeUnavailable(error.message)
          ? {
              status: "skipped",
              ok: false,
              retryable: true,
              reason: "claude_runtime_unavailable",
              error: error.message,
            }
          : {
              status: "failed",
              ok: false,
              error: error.message,
            };
      }

      logProgress(`Claude result: ${report.claude.status}`);
    }

    if (isRuntimeSelected("codex")) {
      try {
        report.codex =
          evalMode === "live"
            ? await runCodexLive()
            : await runCodexSmoke();
      } catch (error) {
        report.codex = isOptionalRuntimeUnavailable(error.message)
          ? {
              status: "skipped",
              ok: false,
              retryable: true,
              reason: "codex_runtime_unavailable",
              error: error.message,
            }
          : {
              status: "failed",
              ok: false,
              error: error.message,
            };
      }

      logProgress(`Codex result: ${report.codex.status}`);
    }

    if (isRuntimeSelected("openclaw")) {
      try {
        report.openclaw =
          evalMode === "live"
            ? await runOpenClawLive()
            : await runOpenClawSmoke();
      } catch (error) {
        report.openclaw = isOptionalRuntimeUnavailable(error.message)
          ? {
              status: "skipped",
              ok: false,
              retryable: true,
              reason: "openclaw_runtime_unavailable",
              error: error.message,
            }
          : {
              status: "failed",
              ok: false,
              error: error.message,
            };
      }

      logProgress(`OpenClaw result: ${report.openclaw.status}`);
    }
  } finally {
    await cleanupActiveChildren("final sweep");
  }

  const runtimeStatuses = [
    isRuntimeSelected("claude") ? summarizeRuntimeReport("claude", report.claude) : null,
    isRuntimeSelected("codex") ? summarizeRuntimeReport("codex", report.codex) : null,
    isRuntimeSelected("openclaw") ? summarizeRuntimeReport("openclaw", report.openclaw) : null,
  ].filter(Boolean);

  report.summary = {
    passed: runtimeStatuses.filter((item) => item.status === "passed").map((item) => item.runtime),
    skipped: runtimeStatuses.filter((item) => item.status === "skipped").map((item) => item.runtime),
    failed: runtimeStatuses.filter((item) => item.status === "failed").map((item) => item.runtime),
    strictRuntimesRequired: requireAllRuntimes,
  };

  const overallOk =
    report.summary.failed.length === 0 &&
    (!requireAllRuntimes || report.summary.skipped.length === 0);

  console.log(JSON.stringify(report, null, 2));
  if (!overallOk) {
    process.exitCode = 1;
  }
}

if (process.argv.includes("--probe-clis-only")) {
  await probeClisOnly();
} else {
  await main();
}
