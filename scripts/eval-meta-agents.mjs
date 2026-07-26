import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  canonicalAgentsDir,
  canonicalRuntimeAssetsDir,
} from "./meta-kim-sync-config.mjs";
import { observeCodexJsonl } from "./live-acceptance/observe-host-events.mjs";
import { readCodexSessionEvidence } from "./live-acceptance/read-codex-session-evidence.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const rawArgs = process.argv.slice(2);
const requireAllRuntimes = process.argv.includes("--require-all-runtimes");
const primaryReleaseFuse = rawArgs.includes("--primary-release-fuse");
const evalMode =
  primaryReleaseFuse || rawArgs.includes("--live") || rawArgs.includes("--mode=live")
    ? "live"
    : "smoke";
const runtimeArg = rawArgs.find((arg) => arg.startsWith("--runtime="));
const agentArg = rawArgs.find((arg) => arg.startsWith("--agent="));
const selectedRuntimes = new Set(
  primaryReleaseFuse
    ? ["claude", "codex"]
    : runtimeArg
    ? runtimeArg
        .slice("--runtime=".length)
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
    : ["claude", "codex", "openclaw", "cursor"],
);
const selectedAgentIds = new Set(
  agentArg
    ? agentArg
        .slice("--agent=".length)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [],
);
const openclawTemplateConfigPath = path.join(
  canonicalRuntimeAssetsDir,
  "openclaw",
  "openclaw.template.json",
);
const openclawMainConfigPath = path.join(
  os.homedir(),
  ".openclaw",
  "openclaw.json",
);
const prepareOpenClawScriptPath = path.join(
  repoRoot,
  "scripts",
  "prepare-openclaw-local.mjs",
);
const windowsProcessTreeGuardPath = path.join(
  repoRoot,
  "scripts",
  "windows-process-tree-guard.ps1",
);
const cursorLiveHarnessContractPath = path.join(
  repoRoot,
  "config",
  "contracts",
  "cursor-live-turn-harness-contract.json",
);
const activeChildren = new Map();
let cleanupInFlight = false;
const CODEX_LIVE_TIMEOUT_MS = 180_000;
const CODEX_SESSION_SETTLE_TIMEOUT_MS = 10_000;
const CODEX_SESSION_SETTLE_INTERVAL_MS = 250;
const PRIMARY_RELEASE_RUNTIME_PROCESS_TIMEOUT_MS = Object.freeze({
  codex: 240_000,
});
const WINDOWS_PROCESS_TREE_GUARD_READY_TIMEOUT_MS = 15_000;
const WINDOWS_PROCESS_TREE_GUARD_EXIT_TIMEOUT_MS = 30_000;

const RUNTIME_FAILURE_TAXONOMY = Object.freeze({
  pass: "pass",
  timeout: "timeout",
  authMissing: "auth_missing",
  nativeHarnessMissing: "native_harness_missing",
  projectionOnly: "projection_only",
  toolUnsupported: "tool_unsupported",
  runtimeUnavailable: "runtime_unavailable",
  structuralFailure: "structural_failure",
  liveIncomplete: "live_incomplete",
  unknownFailure: "unknown_failure",
});

const RUNTIME_EVIDENCE_COMMANDS = Object.freeze({
  claude: {
    smoke: "node scripts/eval-meta-agents.mjs --runtime=claude",
    live: "node scripts/eval-meta-agents.mjs --runtime=claude --live",
  },
  codex: {
    smoke: "node scripts/eval-meta-agents.mjs --runtime=codex",
    live: "node scripts/eval-meta-agents.mjs --runtime=codex --live",
  },
  openclaw: {
    smoke: "node scripts/eval-meta-agents.mjs --runtime=openclaw",
    live: "node scripts/eval-meta-agents.mjs --runtime=openclaw --live",
  },
  cursor: {
    smoke: "node scripts/eval-meta-agents.mjs --runtime=cursor",
    live: "node scripts/eval-meta-agents.mjs --runtime=cursor --live",
  },
});

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

async function readCanonicalAgentIds() {
  return (await fs.readdir(canonicalAgentsDir))
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.replace(/\.md$/, ""))
    .sort();
}

function declaredAgentName(text, extension) {
  const match = extension === ".toml"
    ? String(text).match(/^\s*name\s*=\s*["']([^"']+)["']/mu)
    : String(text).match(/^\s*name\s*:\s*["']?([^\s"']+)["']?\s*$/mu);
  return match?.[1]?.trim() || null;
}

async function readRuntimeAgentDefinitions(runtimeAgentsDirs, extension) {
  const definitions = new Map();
  const sources = [];
  for (const [index, runtimeAgentsDir] of runtimeAgentsDirs.entries()) {
    if (!(await fileExists(runtimeAgentsDir))) continue;
    const sourceCategory = index === 0 ? "project" : "global";
    sources.push(sourceCategory);
    for (const file of (await fs.readdir(runtimeAgentsDir)).filter((entry) => entry.endsWith(extension)).sort()) {
      const filePath = path.join(runtimeAgentsDir, file);
      const sourceText = await fs.readFile(filePath, "utf8");
      const name = declaredAgentName(sourceText, extension);
      if (!name || definitions.has(name)) continue;
      definitions.set(name, {
        name,
        sourceCategory,
        sourceDigest: crypto.createHash("sha256").update(sourceText).digest("hex"),
      });
    }
  }
  return {
    source: sources.length > 0 ? sources.join("+") : "runtime-agent-definitions-missing",
    sources,
    definitions: [...definitions.values()],
    ids: [...definitions.keys()].sort(),
  };
}

function publicRuntimeAgentInventory(discoveredAgents, expectedAgentIds) {
  const required = new Set(expectedAgentIds);
  return {
    ids: discoveredAgents.ids.filter((agentId) => required.has(agentId)),
    definitions: discoveredAgents.definitions.filter((definition) =>
      required.has(definition.name)
    ),
  };
}

async function readTextOrCanonical(primaryPath, fallbackPath) {
  if (await fileExists(primaryPath)) {
    return {
      source: path.relative(repoRoot, primaryPath).replace(/\\/g, "/"),
      text: await fs.readFile(primaryPath, "utf8"),
    };
  }
  return {
    source: path.relative(repoRoot, fallbackPath).replace(/\\/g, "/"),
    text: await fs.readFile(fallbackPath, "utf8"),
  };
}

async function readFilesOrCanonical(primaryDir, fallbackDir, extension) {
  const sourceDir = (await fileExists(primaryDir)) ? primaryDir : fallbackDir;
  return {
    source: path.relative(repoRoot, sourceDir).replace(/\\/g, "/"),
    files: (await fs.readdir(sourceDir))
      .filter((file) => file.endsWith(extension))
      .sort(),
  };
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
    dirs.push(path.join(up, ".local"));
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
      `or run the same command from a terminal where "${unixName}" already works.`,
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

function processTreeCleanupError(error, code, details = {}) {
  const wrapped = new Error("Process-tree cleanup could not be verified", {
    cause: error,
  });
  wrapped.code = code;
  wrapped.processTreeCleanupFailure = true;
  wrapped.processTreeCleanupReason =
    details.reason ?? error?.processTreeCleanupReason ?? "cleanup_unverified";
  wrapped.processTreeSurvivorCount = Number.isSafeInteger(details.survivorCount)
    ? details.survivorCount
    : Number.isSafeInteger(error?.processTreeSurvivorCount)
    ? error.processTreeSurvivorCount
    : null;
  return wrapped;
}

async function killProcessTree(pid, options = {}) {
  const signal = options.signal ?? "SIGTERM";
  if (!pid) {
    return;
  }

  if (process.platform === "win32") {
    const guardDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "meta-kim-process-tree-stop-"),
    );
    const readyPath = path.join(guardDir, "ready");
    const stopPath = path.join(guardDir, "stop");
    const resultPath = path.join(guardDir, "result.json");
    try {
      await fs.writeFile(stopPath, "stop", "utf8");
      await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        windowsProcessTreeGuardPath,
        "-RootPid",
        String(pid),
        "-ReadyPath",
        readyPath,
        "-StopPath",
        stopPath,
        "-ResultPath",
        resultPath,
      ], {
        cwd: repoRoot,
        timeout: WINDOWS_PROCESS_TREE_GUARD_EXIT_TIMEOUT_MS,
        windowsHide: true,
      });
      const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
      if (result?.verified !== true) {
        throw new Error("Windows process-tree guard did not verify cleanup");
      }
    } catch (guardError) {
      // Retain taskkill only as a best-effort emergency action. It cannot prove
      // provider-independent tree cleanup, so callers still receive a failure.
      try {
        await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], {
          cwd: repoRoot,
          timeout: 15_000,
          windowsHide: true,
        });
      } catch {
        // The verified Toolhelp32 result remains the release boundary.
      }
      throw processTreeCleanupError(
        guardError,
        "META_KIM_WINDOWS_PROCESS_TREE_CLEANUP_FAILED",
        { reason: "toolhelp_guard_failed" },
      );
    } finally {
      await fs.rm(guardDir, { recursive: true, force: true });
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
    entries.map(({ child }) => terminateChildTree(child)),
  );
}

async function waitForEvaluatorStartGate() {
  const gatePath = process.env.META_KIM_EVAL_START_GATE;
  if (!gatePath) {
    return;
  }
  delete process.env.META_KIM_EVAL_START_GATE;
  if (!path.isAbsolute(gatePath)) {
    throw new Error("META_KIM_EVAL_START_GATE must be an absolute path");
  }
  const deadline = Date.now() + WINDOWS_PROCESS_TREE_GUARD_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fs.access(gatePath);
      return;
    } catch {
      await delay(25);
    }
  }
  throw new Error("Evaluator start gate was not released by the process-tree guard");
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
        spec.file === "cmd.exe"
          ? spec.toArgs(sampleArgs).slice(0, 3).join(" ")
          : spec.file;
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

function shellQuoteForBash(value) {
  return `'${String(value ?? "").replaceAll("'", "'\"'\"'")}'`;
}

function windowsPathToWslPath(filePath) {
  const normalized = String(filePath ?? "").replaceAll("\\", "/");
  const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (!match) {
    return normalized;
  }
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

function shouldProbeCursorWsl() {
  return process.platform === "win32" && process.env.META_KIM_CURSOR_SKIP_WSL !== "1";
}

async function resolveWslCursorAgentCandidate() {
  if (!shouldProbeCursorWsl()) {
    throw new Error("Cursor WSL probe skipped by host policy or non-Windows platform.");
  }
  const probe = await runCommandWithIgnoredStdin(
    "wsl.exe",
    ["bash", "-lc", "command -v cursor-agent"],
    {
      cwd: repoRoot,
      timeout: 30_000,
      env: { ...process.env, NO_COLOR: "1" },
    },
  );
  if (!probe.stdout.trim()) {
    throw new Error("cursor-agent was not found on the WSL PATH.");
  }
  const wslRepoRoot = windowsPathToWslPath(repoRoot);
  return {
    file: "wsl.exe",
    toArgs: (args) => [
      "bash",
      "-lc",
      `cd ${shellQuoteForBash(wslRepoRoot)} && cursor-agent ${args
        .map(shellQuoteForBash)
        .join(" ")}`,
    ],
  };
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

let resolvedCursorAgentCmdPromise = null;
async function getResolvedCursorAgentCandidates() {
  if (!resolvedCursorAgentCmdPromise) {
    resolvedCursorAgentCmdPromise = (async () => {
      const candidates = [];
      try {
        const direct = await resolveCliCommand({
          envKey: "META_KIM_CURSOR_AGENT_BIN",
          unixName: "cursor-agent",
          winWhereCandidates: [
            "cursor-agent.cmd",
            "cursor-agent",
            "cursor-agent.exe",
          ],
        });
        candidates.push({
          id: "cursor-agent-binary",
          command: direct,
          toArgs: direct.toArgs,
        });
      } catch (error) {
        candidates.push({
          id: "cursor-agent-binary",
          unavailable: true,
          error: error.message,
        });
      }

      try {
        const cursor = await resolveCliCommand({
          envKey: "META_KIM_CURSOR_BIN",
          unixName: "cursor",
          winWhereCandidates: ["cursor.cmd", "cursor", "cursor.exe"],
        });
        candidates.push({
          id: "cursor-agent-subcommand",
          command: cursor,
          toArgs: (args) => cursor.toArgs(["agent", ...args]),
        });
      } catch (error) {
        candidates.push({
          id: "cursor-agent-subcommand",
          unavailable: true,
          error: error.message,
        });
      }

      try {
        const wsl = await resolveWslCursorAgentCandidate();
        candidates.push({
          id: "cursor-agent-wsl",
          command: wsl,
          toArgs: wsl.toArgs,
        });
      } catch (error) {
        candidates.push({
          id: "cursor-agent-wsl",
          unavailable: true,
          error: error.message,
        });
      }
      return candidates;
    })();
  }
  return resolvedCursorAgentCmdPromise;
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
    canonical_skill_root: { type: "string" },
    sync_manifest: { type: "string" },
    has_meta_warden_agent: { type: "boolean" },
    mcp_supported: { type: "boolean" },
    sandbox_configurable: { type: "boolean" },
    approvals_configurable: { type: "boolean" },
  },
  required: [
    "runtime",
    "entrypoint",
    "canonical_skill_root",
    "sync_manifest",
    "has_meta_warden_agent",
    "mcp_supported",
    "sandbox_configurable",
    "approvals_configurable",
  ],
});

const codexLiveOrchestrationSchema = JSON.stringify({
  type: "object",
  additionalProperties: false,
  properties: {
    runtime: { type: "string" },
    governed_entry: { type: "string" },
    warden_entry_gate: { type: "boolean" },
    conductor_orchestration: { type: "boolean" },
    orchestrationTaskBoardPacket: {
      type: "object",
      additionalProperties: false,
      properties: {
        synthesisOwner: { type: "string" },
        route: { type: "string" },
      },
      required: ["synthesisOwner", "route"],
    },
    workerTaskPackets: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          owner: { type: "string" },
          roleDisplayName: { type: "string" },
          deliverable: { type: "string" },
          verificationOwner: { type: "string" },
        },
        required: [
          "owner",
          "roleDisplayName",
          "deliverable",
          "verificationOwner",
        ],
      },
    },
    verificationOwner: { type: "string" },
  },
  required: [
    "runtime",
    "governed_entry",
    "warden_entry_gate",
    "conductor_orchestration",
    "orchestrationTaskBoardPacket",
    "workerTaskPackets",
    "verificationOwner",
  ],
});

const claudeCases = {
  "meta-warden": {
    ownGroups: [
      [
        "统筹",
        "协调",
        "编排",
        "orchestration",
        "coordination",
        "质量标准",
        "quality standard",
        "quality gate arbitration",
        "final gate",
        "final gate decision",
        "arbitration",
        "final synthesis",
        "CEO",
      ],
      [
        "quality gate",
        "质量门禁",
        "质量门槛",
        "门禁",
        "验收",
        "审查",
        "meta-review",
        "verification",
        "commission",
        "dispatch approval",
        "闸门",
        "校验",
        "验证闭环",
      ],
      [
        "综合",
        "合成",
        "整合",
        "审计",
        "CEO报告",
        "最终",
        "final synthesis",
        "synthesis",
        "report",
        "audit",
        "evolution backlog",
        "evolution writeback",
        "writeback gate",
      ],
    ],
    refuseGroups: [
      ["具体分析", "质量分析", "技术分析", "analysis", "quality forensics", "forensics", "code implementation", "business code", "业务代码", "debugging", "build", "test execution"],
      ["工具发现", "tool discovery", "Scout", "scout", "SOUL", "soul", "prompting", "prompting design", "prompt 设计", "prompt 架构", "agent prompt", "新 agent", "workflow dispatch", "workflow", "dispatch sequencing", "sequencing", "Conductor", "conductor", "外部工具", "接入外部工具", "技能发现", "外部工具与技能"],
    ],
    artifactGroups: [
      ["报告", "report", "综合", "合成", "协调", "产物", "synthesis", "go/no-go", "仲裁", "wardenGateDecision"],
    ],
  },
  "meta-genesis": {
    ownGroups: [
      ["SOUL", "soul", "提示词", "prompt"],
      [
        "人格",
        "灵魂",
        "身份",
        "identity",
        "boundary",
        "责任边界",
        "system",
        "系统",
        "stress testing",
        "behavioral anchors",
      ],
      [
        "架构",
        "设计",
        "design",
        "decision rules",
        "thinking framework",
        "anti-ai-slop",
      ],
    ],
    refuseGroups: [
      [
        "Hook",
        "hook",
        "权限",
        "安全",
        "security",
        "memory",
        "配置",
        "路由审批",
        "approval",
        "final configuration",
        "coordinate",
        "coordination",
        "协调",
        "cross-agent",
        "跨 agent",
        "把关",
        "quality gate",
        "quality gates",
        "质量门禁",
        "final synthesis",
        "最终综合",
        "最终合成",
      ],
      [
        "MCP",
        "skill",
        "技能",
        "记忆",
        "memory",
        "matching",
        "external tools",
        "tool discovery",
        "工具发现",
        "evolution writeback",
        "writeback",
        "演化回写",
        "回写",
        "演化信号",
        "编排",
      ],
    ],
    artifactGroups: [["SOUL", "soul", "prompt", "提示词"]],
  },
  "meta-artisan": {
    ownGroups: [
      ["skill", "技能"],
      ["MCP", "工具", "ROI", "评分", "精选", "tool"],
      ["匹配", "装备", "能力", "matching", "loadout", "capability"],
    ],
    refuseGroups: [
      ["SOUL", "prompt", "提示词"],
      ["记忆", "memory", "Hook", "hook", "钩子", "安全", "security"],
    ],
    artifactGroups: [["skill", "MCP", "能力清单", "映射", "report"]],
  },
  "meta-sentinel": {
    ownGroups: [
      ["安全", "风险", "权限", "security", "threat"],
      ["Hook", "hook", "守卫"],
      ["回滚", "rollback", "边界", "策略", "三级", "CAN", "CANNOT", "NEVER"],
    ],
    refuseGroups: [
      ["SOUL", "prompt", "提示词", "业务代码", "code implementation", "implementation"],
      [
        "工具发现",
        "tool discovery",
        "skill",
        "技能",
        "内部逻辑",
        "internal logic",
        "工作流",
        "编排",
        "workflow",
        "orchestration",
      ],
    ],
    artifactGroups: [
      [
        "Hook",
        "hook",
        "回滚",
        "rollback",
        "安全规则",
        "security rules",
        "守卫",
        "audit",
      ],
    ],
  },
  "meta-librarian": {
    ownGroups: [
      ["记忆", "memory", "知识", "MEMORY"],
      ["连续性", "沉淀", "架构", "architecture", "continuity", "persistence"],
      [
        "上下文",
        "档案",
        "索引",
        "保质期",
        "淘汰规则",
        "protocol",
        "strategy",
        "expiration",
        "身份",
        "规范来源",
        "一致性",
        "source-of-truth",
        "canonical",
      ],
    ],
    refuseGroups: [
      ["SOUL", "prompt", "提示词", "design"],
      [
        "skill",
        "技能",
        "Hook",
        "hook",
        "权限",
        "security",
        "workflow",
        "编排",
        "运行时行为",
        "orchestration",
      ],
    ],
    artifactGroups: [["记忆", "索引", "档案", "memory"]],
  },
  "meta-conductor": {
    ownGroups: [
      ["编排", "workflow", "工作流", "orchestration", "stage sequencing", "dispatch board", "business-flow"],
      ["阶段", "phase", "节奏", "rhythm", "节拍"],
      [
        "牌组",
        "卡牌",
        "card deck",
        "发牌",
        "调度",
        "分发",
        "协作",
        "分工",
        "delivery shell",
        "交付外壳",
        "handoff",
        "sequencing",
        "任务路由",
        "交接契约",
        "执行路径",
        "跨 agent",
        "交接",
        "cross-agent task routing",
      ],
    ],
    refuseGroups: [
      [
        "SOUL",
        "prompt",
        "提示词",
        "final gate",
        "approval",
        "arbitration",
        "agent team coordination",
        "coordination",
        "quality gates",
        "quality gate",
        "final synthesis",
      ],
      [
        "技能匹配",
        "技能到 agent",
        "skill→agent",
        "matching",
        "安全",
        "权限",
        "记忆",
        "security",
        "memory",
        "loadout",
        "skill/tool loadout",
        "code implementation",
        "execution work",
        "实际执行",
        "专属职责",
        "external tools",
        "tool discovery",
        "capability gaps",
        "quality review judgment",
        "review judgment",
        "自演化",
        "写回",
        "版本治理",
        "evolution writeback",
        "AGENTS",
        "规范源文件",
      ],
    ],
    artifactGroups: [
      [
        "workflow",
        "工作流",
        "计划",
        "编排",
        "orchestration",
        "牌组",
        "card deck",
        "dispatchBoard",
        "dispatch board",
      ],
    ],
  },
  "meta-prism": {
    ownGroups: [
      ["质量", "审查", "review", "quality", "forensics"],
      ["slop", "漂移", "缺陷", "defect", "evolution signal"],
      [
        "验证",
        "回归",
        "verification",
        "regression",
        "assertion",
        "tracking",
        "accept/reject",
        "findings",
        "verdict",
        "iterative review",
        "role boundaries",
        "boundary consistency",
        "boundaries",
        "边界守门",
        "边界",
      ],
    ],
    refuseGroups: [
      ["工具发现", "tool discovery", "Scout", "scout", "canonical", "源文件", "SOUL/AGENTS", "修改"],
      ["统筹", "coordination", "Warden", "warden", "SOUL", "soul", "design"],
    ],
    artifactGroups: [["审查", "报告", "缺陷", "review", "report", "analysis"]],
  },
  "meta-scout": {
    ownGroups: [
      [
        "发现",
        "discovery",
        "扫描",
        "baseline",
        "基线",
        "capability",
        "能力基线",
      ],
      ["工具", "tool", "skill", "MCP", "ROI"],
      ["生态", "外部", "引入", "external", "candidate", "adoption"],
    ],
    refuseGroups: [
      [
        "质量法医",
        "质量审查",
        "质量审计",
        "quality forensics",
        "quality audit",
        "AI_slop",
        "slop",
        "Prism",
        "prism",
        "final security",
        "permission policy",
        "execute",
        "execution",
        "runtime action",
        "tool execution",
        "执行",
        "直接执行",
        "工具操作",
        "具体工具",
      ],
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
        "协调",
        "协调管理",
        "管理",
        "coordinate",
        "coordination",
        "workflow",
        "synthesis",
      ],
    ],
    artifactGroups: [
      ["清单", "地图", "调研", "扫描", "报告", "发现报告", "分析报告", "report", "recommendation", "capabilityDiscoveryPacket"],
    ],
  },
  "meta-chrysalis": {
    ownGroups: [
      [
        "evolution",
        "writeback",
        "演化",
        "进化",
        "写回",
        "沉淀",
        "permanence",
      ],
      [
        "signal",
        "signals",
        "aggregation",
        "scar",
        "pattern",
        "reuse",
        "boundary drift",
        "信号",
        "疤痕",
        "模式",
      ],
      [
        "Warden",
        "gate",
        "recursive",
        "self-evolution",
        "five criteria",
        "递归",
        "自我演化",
        "五项标准",
      ],
    ],
    refuseGroups: [
      [
        "直接修改",
        "direct edit",
        "actual SOUL",
        "SOUL",
        "canonical modification",
        "self-evolution",
        "evolve itself",
      ],
      [
        "implementation",
        "执行工作",
        "coding",
        "tests",
        "security review",
        "quality gate",
        "public-display",
      ],
    ],
    artifactGroups: [
      [
        "evolutionWritebackPacket",
        "writeback packet",
        "演化写回包",
        "evolution",
        "writeback",
        "scar",
      ],
    ],
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

    const parsedLines = parseJsonLines(raw);
    if (parsedLines.length > 0) {
      return parsedLines.at(-1);
    }

    for (
      let index = trimmed.lastIndexOf("{");
      index >= 0;
      index = trimmed.lastIndexOf("{", index - 1)
    ) {
      try {
        return JSON.parse(trimmed.slice(index));
      } catch {}
    }
    return null;
  }
}

function parseJsonObjectFromText(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}

  const anchored = extractJsonObjectByAnchor(text, "\"agent\"");
  if (anchored) {
    try {
      const parsed = JSON.parse(anchored);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {}
  }

  const trailingObject = extractLastCompleteJsonObject(text);
  if (trailingObject) {
    try {
      const parsed = JSON.parse(trailingObject);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {}
  }

  return null;
}

function extractClaudeStructured(raw) {
  const parsed = parseLastJson(raw);
  if (!parsed) {
    throw new Error("Claude output was not valid JSON.");
  }
  const candidate = parsed.structured_output ?? parsed.result ?? parsed;
  if (typeof candidate === "string") {
    const nested = parseJsonObjectFromText(candidate);
    if (nested) {
      return nested.structured_output ?? nested.result ?? nested;
    }
  }
  return candidate;
}

function extractCodexReply(raw) {
  const events = parseJsonLines(raw);
  const lastMessage = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "item.completed" && event.item?.type === "agent_message",
    );

  if (!lastMessage?.item?.text) {
    throw new Error("Codex did not emit a final agent message.");
  }

  try {
    return JSON.parse(lastMessage.item.text);
  } catch {
    return { raw: lastMessage.item.text };
  }
}

function tryExtractCodexReply(raw) {
  try {
    return extractCodexReply(raw);
  } catch {
    return null;
  }
}

function extractCodexThreadId(raw) {
  const events = parseJsonLines(raw);
  const started = events.filter(
    (event) =>
      event.type === "thread.started" &&
      typeof event.thread_id === "string" &&
      event.thread_id.length > 0,
  );
  return started.length === 1 ? started[0].thread_id : null;
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
  const parsed = anchoredObject
    ? JSON.parse(anchoredObject)
    : parseLastJson(raw);
  if (!parsed) {
    return { raw: raw.trim() };
  }

  const payloadText = parsed.payloads?.[0]?.text;
  if (typeof payloadText === "string" && payloadText.trim()) {
    const payloadObject = parseJsonObjectFromText(payloadText);
    if (payloadObject) {
      return {
        ...payloadObject,
        wrapper: parsed,
      };
    }
    return {
      raw: payloadText.trim(),
      wrapper: parsed,
    };
  }

  const textCandidate =
    parsed.reply?.text ||
    parsed.output?.text ||
    parsed.message?.text ||
    parsed.response?.text ||
    parsed.text ||
    "";

  if (typeof textCandidate === "string" && textCandidate.trim()) {
    const payloadObject = parseJsonObjectFromText(textCandidate);
    if (payloadObject) {
      return {
        ...payloadObject,
        wrapper: parsed,
      };
    }
    return { raw: textCandidate.trim(), wrapper: parsed };
  }

  return parsed;
}

async function readOpenClawSessionPayload(
  agentId,
  sessionId,
  sinceMs = 0,
  sessionDirs = [],
) {
  const defaultSessionsDir = path.join(
    os.homedir(),
    ".openclaw",
    "agents",
    agentId,
    "sessions",
  );

  const candidatePaths = [];
  for (const sessionsDir of [
    ...new Set([...sessionDirs.filter(Boolean), defaultSessionsDir]),
  ]) {
    candidatePaths.push(path.join(sessionsDir, `${sessionId}.jsonl`));
    try {
      const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
      const jsonlStats = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map(async (entry) => {
            const fullPath = path.join(sessionsDir, entry.name);
            const stat = await fs.stat(fullPath);
            return { fullPath, mtimeMs: stat.mtimeMs };
          }),
      );
      candidatePaths.push(
        ...jsonlStats
          .sort((a, b) => b.mtimeMs - a.mtimeMs)
          .slice(0, 20)
          .map((item) => item.fullPath),
      );
    } catch (error) {
      if (error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  for (const sessionPath of [...new Set(candidatePaths)]) {
    let raw;
    try {
      raw = await fs.readFile(sessionPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        continue;
      }
      throw error;
    }

    const events = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const matchingEvents = [];
    const recentEvents = [];
    let currentSessionId = null;
    for (const event of events) {
      if (event.type === "session" && typeof event.id === "string") {
        currentSessionId = event.id;
      }
      const eventMs = Date.parse(event.timestamp ?? "");
      if (Number.isFinite(eventMs) && eventMs >= sinceMs - 1_000) {
        recentEvents.push(event);
      }
      if (
        currentSessionId === sessionId ||
        event.data?.sessionId === sessionId ||
        event.data?.runId === sessionId
      ) {
        matchingEvents.push(event);
      }
    }

    const payload = extractOpenClawPayloadFromSessionEvents(
      matchingEvents,
      sessionPath,
    );
    if (payload) {
      return payload;
    }

    if (sinceMs > 0) {
      const recentPayload = extractOpenClawPayloadFromSessionEvents(
        recentEvents,
        sessionPath,
      );
      if (recentPayload) {
        return recentPayload;
      }
    }
  }

  return null;
}

function isOpenClawBoundaryPayload(payload) {
  return (
    payload &&
    typeof payload === "object" &&
    typeof payload.agent === "string" &&
    Array.isArray(payload.owns) &&
    Array.isArray(payload.refuses) &&
    typeof payload.artifact === "string" &&
    Array.isArray(payload.delegates_to)
  );
}

function extractOpenClawPayloadFromSessionEvents(events, sessionPath) {
  const bootstrapFull = events.some(
    (event) => event.customType === "openclaw:bootstrap-context:full",
  );
  const assistantEvents = [...events]
    .reverse()
    .filter((event) => event.message?.role === "assistant");

  for (const assistantEvent of assistantEvents) {
    const content = assistantEvent.message?.content ?? [];
    const hasToolCall = content.some((item) => item?.type === "toolCall");
    const textItems = content.filter(
      (item) => item?.type === "text" && typeof item.text === "string",
    );

    for (const item of textItems) {
      const payloadObject = parseJsonObjectFromText(item.text);
      if (isOpenClawBoundaryPayload(payloadObject)) {
        return {
          ...payloadObject,
          sessionRecovery: {
            recoveredFromSession: true,
            sessionPath,
            bootstrapFull,
          },
        };
      }
    }

    if (hasToolCall) {
      continue;
    }
  }

  return null;
}

function normalizeOpenClawAgentPayload(agentId, payload) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  if (typeof payload.agent === "string" && payload.agent.trim()) {
    return payload;
  }
  return {
    agent: agentId,
    ...payload,
  };
}

async function runOpenClawAgentTurn(command, args, options) {
  const sessionPollMs = 1_000;
  const heartbeatMs = 30_000;
  const sessionTimeoutMs = options.sessionTimeoutMs ?? 90_000;
  const startedAtMs = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.toArgs(args), {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    markChildActive(child, `${command.file} ${command.toArgs(args).join(" ")}`);

    let stdout = "";
    let stderr = "";
    let finished = false;
    let pollInFlight = false;

    async function settle(error, result) {
      if (finished) {
        return;
      }
      finished = true;
      clearInterval(pollId);
      clearInterval(heartbeatId);
      clearTimeout(timeoutId);
      if (result?.recoveredFromSession && child.exitCode === null) {
        void terminateChildTree(child, { graceMs: 1_000 });
      }
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    }

    async function recoverFromSession() {
      const payload = await readOpenClawSessionPayload(
        options.agentId,
        options.sessionId,
        startedAtMs,
        options.sessionDirs ?? [],
      );
      if (!payload) {
        return null;
      }
      return {
        stdout,
        stderr,
        payload,
        recoveredFromSession: true,
      };
    }

    const pollId = setInterval(() => {
      if (finished || pollInFlight) {
        return;
      }
      pollInFlight = true;
      recoverFromSession()
        .then((result) => {
          if (result) {
            void settle(null, result);
          }
        })
        .catch((error) => {
          void settle(error);
        })
        .finally(() => {
          pollInFlight = false;
        });
    }, sessionPollMs);

    const heartbeatId = setInterval(() => {
      if (finished) {
        return;
      }
      const elapsedSeconds = Math.round((Date.now() - startedAtMs) / 1_000);
      logProgress(
        `OpenClaw live turn still running for ${options.agentId} (${elapsedSeconds}s, session ${options.sessionId})`,
      );
    }, heartbeatMs);

    const timeoutId = setTimeout(() => {
      recoverFromSession()
        .then((result) => {
          if (result) {
            void settle(null, result);
            return;
          }
          void terminateChildTree(child, { graceMs: 1_000 });
          const failureDetails = mergeCommandOutput(stdout, stderr);
          void settle(
            new Error(
              `Command timed out after ${sessionTimeoutMs}ms: ${command.file} ${command.toArgs(args).join(" ")}${
                failureDetails ? `\n${failureDetails}` : ""
              }`,
            ),
          );
        })
        .catch((error) => {
          void settle(error);
        });
    }, sessionTimeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      void settle(error);
    });
    child.on("close", (code, signal) => {
      if (finished) {
        return;
      }
      if (code === 0) {
        recoverFromSession()
          .then((result) => {
            if (result) {
              void settle(null, result);
              return;
            }
            try {
              void settle(null, {
                stdout,
                stderr,
                payload: extractOpenClawReply(mergeCommandOutput(stdout, stderr)),
                recoveredFromSession: false,
              });
            } catch (error) {
              void settle(error);
            }
          })
          .catch((error) => {
            void settle(error);
          });
        return;
      }

      recoverFromSession()
        .then((result) => {
          if (result) {
            void settle(null, result);
            return;
          }
          const failureDetails = [stderr.trim(), stdout.trim()]
            .filter(Boolean)
            .join("\n");
          const suffix = signal ? ` (signal: ${signal})` : "";
          void settle(
            new Error(
              `Command failed: ${command.file} ${command.toArgs(args).join(" ")}${suffix}${
                failureDetails ? `\n${failureDetails}` : ""
              }`,
            ),
          );
        })
        .catch((error) => {
          void settle(error);
        });
    });
  });
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

function isCommandTimeoutFailure(error) {
  return (
    error?.code === "META_KIM_COMMAND_TIMEOUT" ||
    String(error?.message || "").toLowerCase().includes("timed out after")
  );
}

function tailText(value, maxChars = 2_000) {
  const text = String(value || "").trim();
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(-maxChars);
}

function diagnosticSha256(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
}

function shouldForceCodexLiveTimeoutFixture() {
  return process.env.META_KIM_CODEX_LIVE_TIMEOUT_FIXTURE === "1";
}

function shouldForceCodexLiveNonzeroFixture() {
  return ["returned", "weak"].includes(
    process.env.META_KIM_CODEX_LIVE_NONZERO_FIXTURE,
  );
}

function shouldForceCodexLiveWeakNormalFixture() {
  return process.env.META_KIM_CODEX_LIVE_WEAK_NORMAL_FIXTURE === "1";
}

function buildCodexLiveTimeoutFixtureStdout() {
  return [
    JSON.stringify({
      type: "thread.started",
      thread_id: "codex-live-timeout-fixture-thread",
    }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: JSON.stringify({
          runtime: "codex",
          governed_entry: "meta-theory",
          warden_entry_gate: true,
          conductor_orchestration: true,
          orchestrationTaskBoardPacket: {
            synthesisOwner: "meta-conductor",
            route:
              "Warden -> Conductor -> orchestrationTaskBoardPacket -> workerTaskPackets",
          },
          workerTaskPackets: [
            {
              owner: "meta-artisan",
              roleDisplayName: "docs",
              deliverable:
                "Timeout fixture proves recoverable Codex live orchestration evidence.",
              verificationOwner: "meta-prism",
            },
          ],
          verificationOwner: "meta-prism",
        }),
      },
    }),
  ].join("\n");
}

function buildCodexLiveTimeoutFixtureError() {
  const error = new Error(
    "Command timed out after 1ms: codex fixture live orchestration",
  );
  error.code = "META_KIM_COMMAND_TIMEOUT";
  error.timeoutMs = 1;
  error.command = "codex fixture live orchestration";
  error.stdout = buildCodexLiveTimeoutFixtureStdout();
  error.stderr = "fixture stderr tail";
  return error;
}

function buildCodexLiveNonzeroFixtureError(
  fixtureShape = process.env.META_KIM_CODEX_LIVE_NONZERO_FIXTURE,
) {
  const runtimePayload = {
    runtime: "codex",
    governed_entry: "meta-theory",
    warden_entry_gate: true,
    conductor_orchestration: true,
    orchestrationTaskBoardPacket: {
      synthesisOwner: "meta-conductor",
      route: "Warden -> Conductor -> board -> workerTaskPackets",
    },
    workerTaskPackets: [
      {
        owner: "meta-prism",
        roleDisplayName: "review",
        deliverable: "Verify completed work after a nonzero wrapper exit.",
        verificationOwner: "meta-warden",
      },
    ],
    verificationOwner: "meta-warden",
  };
  const childSessionId = "nonzero-fixture-child";
  const taskPath = "/root/nonzero-fixture-child";
  const callId = "nonzero-fixture-spawn";
  const weakCall = {
    id: callId,
    type: "collab_tool_call",
    tool: "spawn_agent",
    receiver_thread_id: childSessionId,
  };
  const returnedChildRecords = [
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        namespace: "collaboration",
        call_id: callId,
        arguments: JSON.stringify({
          message: "review through a run-scoped owner contract",
        }),
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: callId,
        output: "accepted",
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "sub_agent_activity",
        event_id: callId,
        kind: "started",
        agent_thread_id: childSessionId,
        agent_path: taskPath,
      },
    },
    {
      type: "response_item",
      payload: {
        type: "agent_message",
        author: taskPath,
        recipient: "/root",
        content: [
          {
            type: "input_text",
            text: "The child returned its completed review.",
          },
        ],
      },
    },
  ];
  const weakDispatchOnlyRecords = [
    { type: "item.started", item: weakCall },
    {
      type: "item.completed",
      item: {
        ...weakCall,
        status: "completed",
        result: "dispatch accepted but child return is absent",
      },
    },
  ];
  const error = new Error(
    "Command failed after completed Codex fixture invocation",
  );
  error.code = "META_KIM_CHILD_COMMAND_FAILED";
  error.stdout = [
    JSON.stringify({
      type: "thread.started",
      thread_id: "codex-live-nonzero-fixture-thread",
    }),
    ...(fixtureShape === "returned"
      ? returnedChildRecords
      : weakDispatchOnlyRecords
    ).map((record) => JSON.stringify(record)),
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "nonzero-fixture-final-json",
        type: "agent_message",
        status: "completed",
        text: JSON.stringify(runtimePayload),
      },
    }),
  ].join("\n");
  error.stderr = "fixture wrapper exited nonzero";
  return error;
}

function codexRecoveryHasReturnedChildFinal(evidence) {
  const invocation = evidence?.nativeInvocation;
  return (
    evidence?.behaviorDiagnosticOk === true &&
    evidence?.nativeInvocationObserved === true &&
    invocation?.completionBoundary === "returned_child_final" &&
    typeof invocation?.resultMessageId === "string" &&
    invocation.resultMessageId.length > 0 &&
    typeof invocation?.resultTextSha256 === "string" &&
    invocation.resultTextSha256.length > 0
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
    results.length > 0 &&
    results.every(
      (result) => result.skipped === true && result.retryable === true,
    );
  const hardFailures = results.filter(
    (result) => result.ok === false && result.skipped !== true,
  );
  const partialRetryableSkips = results.filter(
    (result) => result.skipped === true && result.retryable === true,
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
    nativeInvocationObserved:
      results.length > 0 &&
      results.every(
        (result) => result.ok === true && result.nativeInvocationObserved === true,
      ),
    releaseFuseInvocationObserved:
      results.length > 0 &&
      results.every(
        (result) => result.ok === true && result.nativeInvocationObserved === true,
      ),
    nativeInvocationKind: "claude_main_session_custom_agent_binding",
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

function runtimeReason(report) {
  return String(
    report?.reason ??
      report?.unsupportedWithReason ??
      report?.error ??
      report?.detail ??
      report?.runtimeAuthHydration?.reason ??
      report?.sample?.runtime_live?.reason ??
      report?.sample?.runtime_smoke?.reason ??
      "",
  );
}

function classifyRuntimeFailure(runtimeName, report, mode) {
  const status = report?.status ?? (report?.ok === true ? "passed" : "failed");
  const reason = runtimeReason(report).toLowerCase();
  if (
    typeof report?.failureClass === "string" &&
    Object.values(RUNTIME_FAILURE_TAXONOMY).includes(report.failureClass)
  ) {
    return report.failureClass;
  }

  if (status === "passed") {
    if (mode !== "live") return RUNTIME_FAILURE_TAXONOMY.projectionOnly;
    return report?.releaseFuseInvocationObserved === true &&
        report?.fixture !== true &&
        report?.recoveredFromTimeout !== true
      ? RUNTIME_FAILURE_TAXONOMY.pass
      : RUNTIME_FAILURE_TAXONOMY.liveIncomplete;
  }
  if (reason.includes("timeout")) {
    return RUNTIME_FAILURE_TAXONOMY.timeout;
  }
  if (reason.includes("auth") || reason.includes("apikey") || reason.includes("api key")) {
    return RUNTIME_FAILURE_TAXONOMY.authMissing;
  }
  if (
    reason.includes("live_harness_unavailable") ||
    reason.includes("native live-turn harness") ||
    (runtimeName === "cursor" && status === "skipped")
  ) {
    return RUNTIME_FAILURE_TAXONOMY.nativeHarnessMissing;
  }
  if (reason.includes("command not found") || reason.includes("enoent")) {
    return RUNTIME_FAILURE_TAXONOMY.toolUnsupported;
  }
  if (reason.includes("runtime_unavailable")) {
    return RUNTIME_FAILURE_TAXONOMY.runtimeUnavailable;
  }
  if (reason.includes("incomplete")) {
    return RUNTIME_FAILURE_TAXONOMY.liveIncomplete;
  }
  if (status === "skipped") {
    return RUNTIME_FAILURE_TAXONOMY.runtimeUnavailable;
  }
  if (status === "failed") {
    return RUNTIME_FAILURE_TAXONOMY.structuralFailure;
  }
  return RUNTIME_FAILURE_TAXONOMY.unknownFailure;
}

function runtimeEvidenceKind(status, mode, failureClass) {
  if (status === "passed" && mode === "live") {
    return "live";
  }
  if (status === "passed") {
    return "smoke";
  }
  if (failureClass === RUNTIME_FAILURE_TAXONOMY.nativeHarnessMissing) {
    return "unsupported";
  }
  if (status === "skipped") {
    return "skipped";
  }
  if (status === "failed") {
    return "failed";
  }
  return "unknown";
}

function runtimeRemainingAction(runtimeName, failureClass, mode) {
  if (failureClass === RUNTIME_FAILURE_TAXONOMY.pass) {
    return "No remaining runtime action for this eval scope.";
  }
  if (failureClass === RUNTIME_FAILURE_TAXONOMY.projectionOnly) {
    return `Run ${runtimeName} with --live before claiming native live release evidence.`;
  }
  if (failureClass === RUNTIME_FAILURE_TAXONOMY.timeout) {
    return "Recover the live session or retry with the recorded retryCommand/threadId evidence.";
  }
  if (failureClass === RUNTIME_FAILURE_TAXONOMY.authMissing) {
    return `Configure ${runtimeName} auth and rerun the live evaluator.`;
  }
  if (failureClass === RUNTIME_FAILURE_TAXONOMY.nativeHarnessMissing) {
    return "Add strict native live-turn test evidence before claiming native live release evidence.";
  }
  if (failureClass === RUNTIME_FAILURE_TAXONOMY.toolUnsupported) {
    return `Install or expose the ${runtimeName} CLI/tool before rerunning.`;
  }
  if (failureClass === RUNTIME_FAILURE_TAXONOMY.liveIncomplete) {
    return "Rerun the incomplete shard set and keep skipped shards out of release pass.";
  }
  if (mode === "live") {
    return `Inspect ${runtimeName} live report and rerun after fixing the reported failure.`;
  }
  return `Inspect ${runtimeName} smoke report and fix projection/config evidence.`;
}

function buildRuntimeEvidenceRecord(runtimeName, report, mode) {
  const status = report?.status ?? (report?.ok === true ? "passed" : "failed");
  const failureClass = classifyRuntimeFailure(runtimeName, report, mode);
  const evidenceKind = runtimeEvidenceKind(status, mode, failureClass);
  const strictReleasePass =
    status === "passed" &&
    mode === "live" &&
    failureClass === RUNTIME_FAILURE_TAXONOMY.pass &&
    report?.releaseFuseInvocationObserved === true &&
    report?.fixture !== true &&
    report?.recoveredFromTimeout !== true;
  return {
    runtime: runtimeName,
    mode,
    status,
    evidenceKind,
    failureClass,
    reason: runtimeReason(report) || null,
    command:
      RUNTIME_EVIDENCE_COMMANDS[runtimeName]?.[mode] ??
      `node scripts/eval-meta-agents.mjs --runtime=${runtimeName}`,
    artifact: `report.${runtimeName}`,
    remainingAction:
      report?.remainingAction ?? runtimeRemainingAction(runtimeName, failureClass, mode),
    strictReleasePass,
    blockedFromRelease:
      !strictReleasePass ||
      status === "skipped" ||
      status === "failed" ||
      failureClass !== RUNTIME_FAILURE_TAXONOMY.pass,
  };
}

function buildRuntimeEvidencePacket(report, runtimeStatuses) {
  const records = runtimeStatuses.map((item) =>
    buildRuntimeEvidenceRecord(item.runtime, report[item.runtime], report.mode),
  );
  const failureClasses = Object.fromEntries(
    records.map((record) => [record.runtime, record.failureClass]),
  );
  return {
    schemaVersion: "runtime-evidence-v0.1",
    generatedAt: report.timestamp,
    mode: report.mode,
    strictRuntimesRequired: requireAllRuntimes || primaryReleaseFuse,
    records,
    failureClasses,
    summary: {
      livePass: records
        .filter((record) => record.evidenceKind === "live" && record.strictReleasePass)
        .map((record) => record.runtime),
      smokeOnly: records
        .filter((record) => record.failureClass === RUNTIME_FAILURE_TAXONOMY.projectionOnly)
        .map((record) => record.runtime),
      skippedOrUnsupported: records
        .filter((record) => ["skipped", "unsupported"].includes(record.evidenceKind))
        .map((record) => record.runtime),
      failed: records
        .filter((record) => record.status === "failed")
        .map((record) => record.runtime),
      releaseGrade:
        records.length > 0 &&
        records.every((record) => record.strictReleasePass === true),
    },
  };
}

function codexLivePayloadOk(structuralOk, runtimePayload) {
  return (
    structuralOk &&
    runtimePayload?.runtime === "codex" &&
    runtimePayload?.governed_entry === "meta-theory" &&
    runtimePayload?.warden_entry_gate === true &&
    runtimePayload?.conductor_orchestration === true &&
    runtimePayload?.orchestrationTaskBoardPacket?.synthesisOwner ===
      "meta-conductor" &&
    Array.isArray(runtimePayload?.workerTaskPackets) &&
    runtimePayload.workerTaskPackets.length > 0 &&
    typeof runtimePayload?.verificationOwner === "string" &&
    runtimePayload.verificationOwner.trim().length > 0
  );
}

function inspectCodexLiveEvidence(
  stdout,
  {
    structuralOk,
    representativeAgentId,
    fixture = false,
    hostEventText = stdout,
    sessionEvidence = null,
    sessionLookupFailure = null,
  },
) {
  const runtimePayload = tryExtractCodexReply(stdout);
  const behaviorDiagnosticOk = codexLivePayloadOk(structuralOk, runtimePayload);
  const observedEvents = fixture ? [] : observeCodexJsonl(hostEventText);
  const rootSessionIds = new Set(
    observedEvents.map((event) => event.sessionId).filter(Boolean),
  );
  const matchingNativeInvocations = observedEvents.filter(
    (event) =>
      event.family === "agent_subagent" &&
      /(?:^|\.)spawn_agent$/u.test(String(event.hostSurface ?? "")) &&
      (event.nativeAgentType == null ||
        event.nativeAgentType === representativeAgentId) &&
      (event.nativeAgentType === representativeAgentId
        ? event.ownerBindingMode === "native_custom_agent"
        : event.ownerBindingMode === "run_scoped_owner_contract") &&
      typeof event.childSessionId === "string" &&
      event.childSessionId.length > 0 &&
      typeof event.sessionId === "string" &&
      event.sessionId.length > 0 &&
      ["completed", "returned"].includes(event.resultStatus) &&
      event.completionBoundary === "returned_child_final" &&
      typeof event.resultMessageId === "string" &&
      event.resultMessageId.length > 0 &&
      typeof event.resultTextSha256 === "string" &&
      event.resultTextSha256.length > 0 &&
      typeof event.outputDigest === "string" &&
      event.outputDigest.length > 0,
  );
  const nativeInvocation =
    !fixture &&
    structuralOk &&
    behaviorDiagnosticOk &&
    rootSessionIds.size === 1 &&
    matchingNativeInvocations.length === 1
      ? matchingNativeInvocations[0]
      : null;
  return {
    runtimePayload,
    behaviorDiagnosticOk,
    nativeInvocation,
    nativeInvocationObserved: nativeInvocation != null,
    customAgentInvocationObserved:
      nativeInvocation?.nativeAgentType === representativeAgentId,
    releaseFuseInvocationObserved: nativeInvocation != null,
    sessionEvidence,
    sessionLookupFailure,
  };
}

function publicCodexSessionEvidence(evidence) {
  if (!evidence) return null;
  return {
    threadId: evidence.threadId,
    childSessionId: evidence.childSessionId,
    sessionDigest: evidence.sessionDigest,
    childSessionDigest: evidence.childSessionDigest,
    sourceCategory: evidence.sourceCategory,
    cliVersion: evidence.cliVersion,
  };
}

async function inspectCodexLiveEvidenceWithSessionFallback(
  stdout,
  {
    structuralOk,
    representativeAgentId,
    fixture = false,
    sinceMs,
    sessionSettleTimeoutMs = 0,
  },
) {
  const directEvidence = inspectCodexLiveEvidence(stdout, {
    structuralOk,
    representativeAgentId,
    fixture,
  });
  if (fixture || directEvidence.nativeInvocationObserved) return directEvidence;

  const threadId = extractCodexThreadId(stdout);
  if (!threadId) return directEvidence;
  const settleDeadline = Date.now() + Math.max(0, sessionSettleTimeoutMs);
  let latestEvidence = directEvidence;
  do {
    try {
      const sessionEvidence = await readCodexSessionEvidence({
        codexHome: process.env.CODEX_HOME,
        threadId,
        sinceMs,
      });
      latestEvidence = inspectCodexLiveEvidence(stdout, {
        structuralOk,
        representativeAgentId,
        hostEventText: sessionEvidence.parentSessionText,
        sessionEvidence: publicCodexSessionEvidence(sessionEvidence),
      });
      if (latestEvidence.nativeInvocationObserved) return latestEvidence;
    } catch (error) {
      latestEvidence = {
        ...directEvidence,
        sessionLookupFailure:
          typeof error?.code === "string"
            ? error.code
            : "codex_session_lookup_failed",
      };
    }
    if (Date.now() >= settleDeadline) return latestEvidence;
    await delay(CODEX_SESSION_SETTLE_INTERVAL_MS);
  } while (true);
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
        void terminateChildTree(child).then(() => {
          const error = new Error(
            `Command timed out after ${options.timeout}ms: ${file} ${args.join(" ")}`,
          );
          error.code = "META_KIM_COMMAND_TIMEOUT";
          error.timeoutMs = options.timeout;
          error.command = `${file} ${args.join(" ")}`;
          error.stdout = stdout;
          error.stderr = stderr;
          settle(error);
        }).catch((cleanupError) => {
          const error = new Error(
            `Command timed out and process-tree cleanup failed: ${file} ${args.join(" ")}`,
            { cause: cleanupError },
          );
          error.code = "META_KIM_COMMAND_TIMEOUT_CLEANUP_FAILED";
          error.processTreeCleanupFailure = true;
          error.processTreeCleanupReason = "timeout_cleanup_failed";
          error.timeoutMs = options.timeout;
          error.command = `${file} ${args.join(" ")}`;
          error.stdout = stdout;
          error.stderr = stderr;
          settle(error);
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

      const failureDetails = [stderr.trim(), stdout.trim()]
        .filter(Boolean)
        .join("\n");
      const suffix = signal ? ` (signal: ${signal})` : "";
      const error = new Error(
        `Command failed: ${file} ${args.join(" ")}${suffix}${
          failureDetails ? `\n${failureDetails}` : ""
        }`,
      );
      error.code = "META_KIM_CHILD_COMMAND_FAILED";
      error.stdout = stdout;
      error.stderr = stderr;
      settle(error);
    });
  });
}

async function runWindowsGuardedCommand(file, args, options = {}) {
  const guardDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "meta-kim-process-tree-guard-"),
  );
  const gatePath = path.join(guardDir, "start");
  const readyPath = path.join(guardDir, "ready");
  const stopPath = path.join(guardDir, "stop");
  const resultPath = path.join(guardDir, "result.json");
  let child;
  let guardian;
  let childClosed = false;
  let guardianClosed = false;
  let childStdout = "";
  let childStderr = "";
  let guardianStdout = "";
  let guardianStderr = "";
  let childOutcome;
  let guardianOutcome;

  try {
    child = spawn(file, args, {
      cwd: options.cwd,
      env: {
        ...options.env,
        META_KIM_EVAL_START_GATE: gatePath,
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    markChildActive(child, `${file} ${args.join(" ")}`);
    child.stdout.on("data", (chunk) => {
      childStdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      childStderr += chunk.toString();
    });

    childOutcome = new Promise((resolve) => {
      child.once("error", (error) => {
        childClosed = true;
        resolve({ error, code: null, signal: null });
      });
      child.once("close", (code, signal) => {
        childClosed = true;
        resolve({ error: null, code, signal });
      });
    });

    guardian = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        windowsProcessTreeGuardPath,
        "-RootPid",
        String(child.pid),
        "-ReadyPath",
        readyPath,
        "-StopPath",
        stopPath,
        "-ResultPath",
        resultPath,
      ],
      {
        cwd: repoRoot,
        env: process.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    guardian.stdout.on("data", (chunk) => {
      guardianStdout += chunk.toString();
    });
    guardian.stderr.on("data", (chunk) => {
      guardianStderr += chunk.toString();
    });
    guardianOutcome = new Promise((resolve) => {
      guardian.once("error", (error) => {
        guardianClosed = true;
        resolve({ error, code: null, signal: null });
      });
      guardian.once("close", (code, signal) => {
        guardianClosed = true;
        resolve({ error: null, code, signal });
      });
    });

    const readyDeadline = Date.now() + WINDOWS_PROCESS_TREE_GUARD_READY_TIMEOUT_MS;
    while (Date.now() < readyDeadline) {
      try {
        await fs.access(readyPath);
        break;
      } catch {
        if (childClosed || guardianClosed) {
          throw new Error("Windows process-tree guard exited before readiness");
        }
        await delay(25);
      }
    }
    try {
      await fs.access(readyPath);
    } catch {
      throw new Error("Windows process-tree guard readiness timed out");
    }
    await fs.writeFile(gatePath, "start", "utf8");

    let timeoutId;
    const firstOutcome = await Promise.race([
      childOutcome.then((outcome) => ({ kind: "child", outcome })),
      guardianOutcome.then((outcome) => ({ kind: "guardian", outcome })),
      new Promise((resolve) => {
        timeoutId = setTimeout(
          () => resolve({ kind: "timeout", outcome: null }),
          options.timeout,
        );
      }),
    ]);
    clearTimeout(timeoutId);
    const timedOut = firstOutcome.kind === "timeout";
    if (timedOut || firstOutcome.kind === "guardian") {
      await fs.writeFile(stopPath, "stop", "utf8");
    }

    if (
      firstOutcome.kind === "guardian" &&
      (firstOutcome.outcome.error || firstOutcome.outcome.code !== 0) &&
      !childClosed
    ) {
      await terminateChildTree(child, { graceMs: 1_000 });
    }

    let drainOutcome = await Promise.race([
      Promise.all([childOutcome, guardianOutcome]).then(
        ([settledChild, settledGuardian]) => ({
          timedOut: false,
          child: settledChild,
          guardian: settledGuardian,
        }),
      ),
      delay(WINDOWS_PROCESS_TREE_GUARD_EXIT_TIMEOUT_MS).then(() => ({
        timedOut: true,
      })),
    ]);
    if (drainOutcome.timedOut) {
      if (!guardianClosed) {
        guardian.kill();
        await Promise.race([guardianOutcome, delay(5_000)]);
      }
      if (!childClosed) {
        await terminateChildTree(child, { graceMs: 1_000 });
      }
      drainOutcome = await Promise.race([
        Promise.all([childOutcome, guardianOutcome]).then(
          ([settledChild, settledGuardian]) => ({
            timedOut: false,
            child: settledChild,
            guardian: settledGuardian,
          }),
        ),
        delay(5_000).then(() => ({ timedOut: true })),
      ]);
      if (drainOutcome.timedOut || !childClosed || !guardianClosed) {
        const error = processTreeCleanupError(
          null,
          "META_KIM_WINDOWS_PROCESS_TREE_DRAIN_FAILED",
          { reason: "child_or_guardian_exit_unverified" },
        );
        throw error;
      }
    }

    const outcome = drainOutcome.child;
    const guardOutcome = drainOutcome.guardian;
    if (guardOutcome.error || guardOutcome.code !== 0) {
      let failedGuardResult = null;
      try {
        failedGuardResult = JSON.parse(await fs.readFile(resultPath, "utf8"));
      } catch {
        // Absence is itself a fail-closed diagnostic, never pass evidence.
      }
      const error = new Error(
        `Windows process-tree guard failed${
          guardianStderr.trim() || guardianStdout.trim()
            ? `: ${guardianStderr.trim() || guardianStdout.trim()}`
            : ""
        }`,
      );
      error.code = "META_KIM_WINDOWS_PROCESS_TREE_GUARD_FAILED";
      error.processTreeCleanupFailure = true;
      error.processTreeCleanupReason =
        failedGuardResult?.reason ?? "guard_result_unavailable";
      error.processTreeSurvivorCount = Number.isSafeInteger(
        failedGuardResult?.survivorCount,
      )
        ? failedGuardResult.survivorCount
        : null;
      throw error;
    }
    const guardResult = JSON.parse(await fs.readFile(resultPath, "utf8"));
    if (guardResult?.verified !== true) {
      const error = new Error("Windows process-tree guard did not verify cleanup");
      error.code = "META_KIM_WINDOWS_PROCESS_TREE_GUARD_UNVERIFIED";
      error.processTreeCleanupFailure = true;
      error.processTreeCleanupReason =
        guardResult?.reason ?? "guard_result_unverified";
      error.processTreeSurvivorCount = Number.isSafeInteger(
        guardResult?.survivorCount,
      )
        ? guardResult.survivorCount
        : null;
      throw error;
    }

    if (timedOut) {
      const error = new Error(
        `Command timed out after ${options.timeout}ms: ${file} ${args.join(" ")}`,
      );
      error.code = "META_KIM_COMMAND_TIMEOUT";
      error.timeoutMs = options.timeout;
      error.command = `${file} ${args.join(" ")}`;
      error.stdout = childStdout;
      error.stderr = childStderr;
      error.processTreeCleanupVerified = true;
      throw error;
    }
    if (outcome.error) {
      throw outcome.error;
    }
    if (outcome.code !== 0) {
      const suffix = outcome.signal ? ` (signal: ${outcome.signal})` : "";
      const details = [childStderr.trim(), childStdout.trim()]
        .filter(Boolean)
        .join("\n");
      const error = new Error(
        `Command failed: ${file} ${args.join(" ")}${suffix}${
          details ? `\n${details}` : ""
        }`,
      );
      error.code = "META_KIM_CHILD_COMMAND_FAILED";
      error.stdout = childStdout;
      error.stderr = childStderr;
      error.processTreeCleanupVerified = true;
      throw error;
    }
    return {
      stdout: childStdout,
      stderr: childStderr,
      processTreeCleanupVerified: true,
    };
  } finally {
    let finalCleanupError = null;
    if (child && !childClosed) {
      try {
        await fs.writeFile(stopPath, "stop", "utf8");
      } catch {
        // The guarded cleanup attempt below remains authoritative.
      }
      try {
        await terminateChildTree(child, { graceMs: 1_000 });
      } catch (error) {
        finalCleanupError = processTreeCleanupError(
          error,
          "META_KIM_WINDOWS_PROCESS_TREE_FINAL_CLEANUP_FAILED",
          { reason: "finally_child_cleanup_failed" },
        );
      }
    }
    if (guardian && !guardianClosed) {
      try {
        guardian.kill();
        if (guardianOutcome) {
          await Promise.race([guardianOutcome, delay(5_000)]);
        }
        if (!guardianClosed) {
          throw new Error("guardian exit was not observed");
        }
      } catch (error) {
        finalCleanupError ??= processTreeCleanupError(
          error,
          "META_KIM_WINDOWS_PROCESS_TREE_FINAL_CLEANUP_FAILED",
          { reason: "finally_guardian_cleanup_failed" },
        );
      }
    }
    let guardDirRemovalError = null;
    try {
      await fs.rm(guardDir, { recursive: true, force: true });
    } catch (error) {
      guardDirRemovalError = error;
    }
    if (finalCleanupError) {
      throw finalCleanupError;
    }
    if (guardDirRemovalError) {
      throw guardDirRemovalError;
    }
  }
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
  const artifactOk =
    typeof artifact === "string" && artifact.trim().length >= 4;

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
  const files = (await fs.readdir(canonicalAgentsDir))
    .filter((file) => file.endsWith(".md"))
    .sort();

  return files.map((file) => file.replace(/\.md$/, ""));
}

function filterSelectedAgentIds(agentIds) {
  if (selectedAgentIds.size === 0) {
    return agentIds;
  }
  return agentIds.filter((agentId) => selectedAgentIds.has(agentId));
}

function defaultOpenClawEvalModel() {
  const override = readEnvCliOverride("META_KIM_OPENCLAW_EVAL_MODEL");
  if (override) {
    return override;
  }
  const mainConfigModel = openClawMainDefaultModel();
  if (mainConfigModel) {
    return mainConfigModel;
  }
  const minimaxModel = openClawLocalModelRefForProvider("minimax-cn", [
    "MiniMax-M3",
    "minimax-m3",
  ]);
  if (minimaxModel && openClawLocalAuthProfileHasProvider("minimax-cn")) {
    return minimaxModel;
  }
  if (hasCodexCliAuth()) {
    return "codex-cli/gpt-5.4";
  }
  const codexModel = openClawLocalModelRefForProvider("codex", [
    "gpt-5.4-mini",
    "gpt-5.4",
  ]);
  if (codexModel && openClawLocalAuthProfileHasProvider("codex")) {
    return codexModel;
  }
  return readEnvCliOverride("OPENAI_API_KEY")
    ? "openai/gpt-5.4"
      : "openai-codex/gpt-5.4";
}

function readOpenClawMainConfig() {
  try {
    return JSON.parse(readFileSync(openclawMainConfigPath, "utf8"));
  } catch {
    return null;
  }
}

function openClawMainDefaultModel() {
  const parsed = readOpenClawMainConfig();
  const model = parsed?.agents?.defaults?.model;
  if (typeof model === "string" && model.trim()) {
    return model.trim();
  }
  if (typeof model?.primary === "string" && model.primary.trim()) {
    return model.primary.trim();
  }
  return null;
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function ensureOpenClawModelRefInProviders(modelsConfig, modelRef) {
  const models = cloneJson(modelsConfig) ?? {};
  const [providerId, modelId] = String(modelRef || "").split("/");
  if (!providerId || !modelId) {
    return models;
  }

  models.providers = models.providers ?? {};
  const provider = models.providers[providerId] ?? {};
  const providerModels = Array.isArray(provider.models) ? provider.models : [];
  if (providerModels.some((model) => model?.id === modelId)) {
    models.providers[providerId] = {
      ...provider,
      models: providerModels,
    };
    return models;
  }

  const matchingModel = Object.values(models.providers)
    .flatMap((candidate) =>
      Array.isArray(candidate?.models) ? candidate.models : [],
    )
    .find((model) => model?.id === modelId);
  models.providers[providerId] = {
    ...provider,
    models: [
      ...providerModels,
      matchingModel
        ? cloneJson(matchingModel)
        : {
            id: modelId,
            name: modelId,
            input: ["text"],
          },
    ],
  };
  return models;
}

function hasCodexCliAuth() {
  try {
    readFileSync(path.join(os.homedir(), ".codex", "auth.json"), "utf8");
    return true;
  } catch {
    return false;
  }
}

function shouldUseIsolatedCodexHome(modelRef) {
  const normalized = String(modelRef || "").trim().toLowerCase();
  return !(
    normalized.startsWith("openai-codex/") ||
    normalized.startsWith("codex-cli/") ||
    normalized.startsWith("codex/")
  );
}

function readOpenClawLocalProbeAgentJson(fileName) {
  const filePath = path.join(
    os.homedir(),
    ".openclaw",
    "agents",
    "meta-artisan",
    "agent",
    fileName,
  );
  const raw = readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function openClawLocalAuthProfileHasProvider(providerId) {
  try {
    const parsed = readOpenClawLocalProbeAgentJson("auth-profiles.json");
    return Object.values(parsed.profiles ?? {}).some(
      (profile) => profile?.provider === providerId,
    );
  } catch {
    return false;
  }
}

function openClawLocalModelRefForProvider(providerId, preferredModelIds = []) {
  try {
    const parsed = readOpenClawLocalProbeAgentJson("models.json");
    const models = parsed.providers?.[providerId]?.models;
    if (!Array.isArray(models)) {
      return null;
    }
    const modelIds = models
      .map((model) => (typeof model?.id === "string" ? model.id.trim() : ""))
      .filter(Boolean);
    const modelId =
      preferredModelIds.find((preferredId) => modelIds.includes(preferredId)) ??
      modelIds[0] ??
      null;
    return modelId ? `${providerId}/${modelId}` : null;
  } catch {
    return null;
  }
}

async function copyFileIfExists(sourcePath, targetPath) {
  if (!(await fileExists(sourcePath))) {
    return false;
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
  return true;
}

async function findOpenClawAuthSourceAgentDir(agentIds) {
  const agentsRoot = path.join(os.homedir(), ".openclaw", "agents");
  const candidates = ["main", "meta-artisan", ...agentIds];
  for (const agentId of [...new Set(candidates)]) {
    const agentDir = path.join(agentsRoot, agentId, "agent");
    const hasAuth =
      (await fileExists(path.join(agentDir, "auth-profiles.json"))) ||
      (await fileExists(path.join(agentDir, "auth.json")));
    const hasModels = await fileExists(path.join(agentDir, "models.json"));
    if (hasAuth && hasModels) {
      return agentDir;
    }
  }
  return null;
}

async function hydrateOpenClawEvalAuthState(stateDir, agentIds) {
  const agentsRoot = path.join(os.homedir(), ".openclaw", "agents");
  const fallbackSourceDir = await findOpenClawAuthSourceAgentDir(agentIds);
  const authFiles = [
    "auth.json",
    "auth-profiles.json",
    "auth-state.json",
    "models.json",
  ];

  for (const agentId of ["main", ...agentIds]) {
    const sourceDir = path.join(agentsRoot, agentId, "agent");
    const effectiveSourceDir =
      (await fileExists(path.join(sourceDir, "models.json")))
        ? sourceDir
        : fallbackSourceDir;
    if (!effectiveSourceDir) {
      continue;
    }
    const targetDir = path.join(stateDir, "agents", agentId, "agent");
    for (const fileName of authFiles) {
      await copyFileIfExists(
        path.join(effectiveSourceDir, fileName),
        path.join(targetDir, fileName),
      );
    }
  }
}

function applyOpenClawEvalDefaults(config) {
  const existingAgents = config.agents ?? {};
  const existingDefaults = existingAgents.defaults ?? {};
  const existingModel =
    typeof existingDefaults.model === "string"
      ? { primary: existingDefaults.model }
      : existingDefaults.model ?? {};
  const existingModels =
    existingDefaults.models && typeof existingDefaults.models === "object"
      ? existingDefaults.models
      : {};
  const primaryModel = existingModel.primary ?? defaultOpenClawEvalModel();
  const modelAlias =
    existingModels[primaryModel]?.alias ??
    primaryModel.split("/").pop() ??
    primaryModel;

  return {
    ...config,
    agents: {
      ...existingAgents,
      defaults: {
        ...existingDefaults,
        bootstrapMaxChars: existingDefaults.bootstrapMaxChars ?? 1_200,
        bootstrapTotalMaxChars: existingDefaults.bootstrapTotalMaxChars ?? 4_000,
        contextLimits: {
          ...(existingDefaults.contextLimits ?? {}),
          memoryGetMaxChars:
            existingDefaults.contextLimits?.memoryGetMaxChars ?? 2_000,
          memoryGetDefaultLines:
            existingDefaults.contextLimits?.memoryGetDefaultLines ?? 80,
          toolResultMaxChars:
            existingDefaults.contextLimits?.toolResultMaxChars ?? 4_000,
          postCompactionMaxChars:
            existingDefaults.contextLimits?.postCompactionMaxChars ?? 2_000,
        },
        model: {
          ...existingModel,
          primary: primaryModel,
          fallbacks: Array.isArray(existingModel.fallbacks)
            ? existingModel.fallbacks
            : [],
        },
        models: {
          ...existingModels,
          [primaryModel]: {
            ...(existingModels[primaryModel] ?? {}),
            alias: modelAlias,
          },
        },
        skills: Array.isArray(existingDefaults.skills)
          ? existingDefaults.skills
          : ["meta-theory"],
        startupContext: {
          ...(existingDefaults.startupContext ?? {}),
          enabled: false,
        },
      },
    },
  };
}

function openClawChildEnv(extra = {}) {
  const homeDir = os.homedir();
  const parsedHome = path.parse(homeDir);
  const drive = parsedHome.root.replace(/[\\/]+$/, "");
  const homePath = drive && homeDir.startsWith(drive)
    ? homeDir.slice(drive.length)
    : process.env.HOMEPATH;

  return {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    ...(drive ? { HOMEDRIVE: drive } : {}),
    ...(homePath ? { HOMEPATH: homePath } : {}),
    NO_COLOR: "1",
    ...extra,
  };
}

function shouldKeepOpenClawEvalTemp() {
  return Boolean(readEnvCliOverride("META_KIM_KEEP_OPENCLAW_EVAL_TEMP"));
}

async function cleanupOpenClawEvalTemp(tempConfig) {
  if (!tempConfig?.tempDir) {
    return;
  }
  if (shouldKeepOpenClawEvalTemp()) {
    return;
  }
  try {
    await fs.rm(tempConfig.tempDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 250,
    });
  } catch (error) {
    if (["EBUSY", "ENOTEMPTY", "EPERM"].includes(error.code)) {
      logProgress(
        `OpenClaw eval temp cleanup left locked files: ${tempConfig.tempDir}`,
      );
      return;
    }
    throw error;
  }
}

async function createOpenClawEvalConfig() {
  const rawConfig = JSON.parse(
    await fs.readFile(openclawTemplateConfigPath, "utf8"),
  );
  const hydrateRepoRoot = (value) => {
    if (typeof value === "string") {
      return value
        .replace("__REPO_ROOT__\\", `${repoRoot}\\`)
        .replace("__REPO_ROOT__/", `${repoRoot}/`);
    }
    if (Array.isArray(value)) {
      return value.map((item) => hydrateRepoRoot(item));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, hydrateRepoRoot(item)]),
      );
    }
    return value;
  };

  const hydratedConfig = hydrateRepoRoot(rawConfig);
  const evalModel = defaultOpenClawEvalModel();
  const mainConfig = readOpenClawMainConfig() ?? {};
  const evalModels = ensureOpenClawModelRefInProviders(
    mainConfig.models,
    evalModel,
  );
  const codexCommand = evalModel.startsWith("codex-cli/")
    ? await resolveCodexBackendCommand()
    : null;
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "meta-kim-openclaw-"),
  );
  const stateDir = path.join(tempDir, "state");
  const homeDir = path.join(tempDir, "home");
  const sessionRootDir = path.join(tempDir, "sessions");
  const logFile = path.join(tempDir, "openclaw.eval.log");
  const skillsRootDir = path.join(repoRoot, "openclaw", "skills");
  const agentIds = (rawConfig.agents?.list ?? [])
    .map((agent) => agent.id)
    .filter((agentId) => typeof agentId === "string" && agentId.trim());
  await fs.mkdir(path.join(stateDir, "skills"), { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });
  await hydrateOpenClawEvalAuthState(stateDir, agentIds);
  const config = applyOpenClawEvalDefaults({
    ...hydratedConfig,
    auth: {
      ...(mainConfig.auth ?? {}),
      ...(hydratedConfig.auth ?? {}),
    },
    models: {
      ...evalModels,
      ...(hydratedConfig.models ?? {}),
    },
    logging: {
      ...(hydratedConfig.logging ?? {}),
      level: hydratedConfig.logging?.level ?? "warn",
      consoleLevel: hydratedConfig.logging?.consoleLevel ?? "warn",
      file: hydratedConfig.logging?.file ?? logFile,
    },
    env: {
      ...(hydratedConfig.env ?? {}),
      shellEnv: {
        ...(hydratedConfig.env?.shellEnv ?? {}),
        enabled: false,
        timeoutMs: 0,
      },
    },
    plugins: {
      enabled: true,
      allow: ["minimax", "openai"],
      load: {
        paths: [],
      },
      slots: {
        memory: "none",
        contextEngine: "none",
      },
      entries: {
        minimax: {
          enabled: true,
        },
        openai: {
          enabled: true,
        },
      },
    },
    skills: {
      ...(hydratedConfig.skills ?? {}),
      allowBundled: [],
      load: {
        ...(hydratedConfig.skills?.load ?? {}),
        extraDirs: [skillsRootDir],
        watch: false,
      },
      limits: {
        ...(hydratedConfig.skills?.limits ?? {}),
        maxCandidatesPerRoot: 25,
        maxSkillsLoadedPerSource: 8,
        maxSkillsInPrompt: 2,
        maxSkillsPromptChars: 12_000,
        maxSkillFileBytes: 60_000,
      },
    },
    session: {
      ...(hydratedConfig.session ?? {}),
      store: path.join(sessionRootDir, "{agentId}", "sessions.json"),
    },
    agents: {
      ...hydratedConfig.agents,
      defaults: {
        ...(hydratedConfig.agents?.defaults ?? {}),
        cliBackends: {
          ...(hydratedConfig.agents?.defaults?.cliBackends ?? {}),
          ...(codexCommand
            ? {
                "codex-cli": {
                  ...(hydratedConfig.agents?.defaults?.cliBackends?.[
                    "codex-cli"
                  ] ?? {}),
                  command: codexCommand,
                },
              }
            : {}),
        },
      },
      list: (rawConfig.agents?.list ?? []).map((agent) =>
        hydrateRepoRoot({
          ...agent,
          model: agent.model ?? evalModel,
          skills: agent.skills ?? ["meta-theory"],
          tools: {
            ...(agent.tools ?? {}),
            profile: agent.tools?.profile ?? "minimal",
            allow: Array.isArray(agent.tools?.allow) ? agent.tools.allow : [],
          },
        }),
      ),
    },
  });

  const codexHomeDir = path.join(tempDir, "codex-home");
  await fs.mkdir(codexHomeDir, { recursive: true });
  const configPath = path.join(tempDir, "openclaw.eval.json");
  await fs.writeFile(
    configPath,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );

  return {
    tempDir,
    stateDir,
    homeDir,
    sessionRootDir,
    logFile,
    configPath,
    codexHomeDir,
    evalModel: config.agents.defaults.model.primary,
  };
}

async function resolveCodexBackendCommand() {
  try {
    const command = await getResolvedCodexCommand();
    if (command.file === "cmd.exe") {
      const args = command.toArgs([]);
      return args[2] ?? null;
    }
    return command.file;
  } catch {
    return null;
  }
}

async function runClaudeDiscovery(agentIds) {
  logProgress(
    `Claude discovery: checking ${agentIds.length} registered agent(s)`,
  );
  const discoveredAgents = await readRuntimeAgentDefinitions(
    [
      path.join(repoRoot, ".claude", "agents"),
      path.join(os.homedir(), ".claude", "agents"),
    ],
    ".md",
  );
  const installedAgents = new Set(discoveredAgents.ids);
  const missing = agentIds.filter((agentId) => !installedAgents.has(agentId));
  const publicInventory = publicRuntimeAgentInventory(discoveredAgents, agentIds);
  return {
    ok: missing.length === 0,
    missing,
    ids: publicInventory.ids,
    definitions: publicInventory.definitions,
    source: discoveredAgents.source,
    sources: discoveredAgents.sources,
    expectedInventorySource: "canonical/agents",
    discoveryKind: "declared_runtime_agent_definitions",
    diagnosticOnlyCommand: "claude agents",
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
      let finalResult = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const scoutInstruction =
          agentId === "meta-scout"
            ? "meta-scout 的 owns 必须分别覆盖：能力基线/发现，tool-skill-MCP/ROI，外部候选/采纳建议；refuses 必须分别覆盖：不直接执行工具或运行时动作，不负责协调/dispatch/loadout/final approval。"
            : "owns 必须覆盖自身定义里三个不同责任族；refuses 必须覆盖不执行业务任务和跨 owner 边界。";
        const prompt =
          "你正在做 Meta_Kim 元 agent 角色边界自检。先依据当前 Claude Code 已加载的 agent 定义、frontmatter、AGENTS/CLAUDE 上下文和边界说明，不要凭通用 agent 印象补写。" +
          "只返回符合 schema 的 JSON，不要解释。JSON 必须包含 agent、owns、refuses、artifact、delegates_to。" +
          `agent 字段必须精确写 ${agentId}；` +
          "owns 写 3 个短语，每条必须来自不同责任族；refuses 写 2 个短语，每条必须是明确拒绝边界；" +
          scoutInstruction +
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
          },
        );

        const payload = extractClaudeStructured(stdout);
        const { score, matchedGroups, missedGroups } = scoreClaudeCase(
          caseConfig,
          payload,
        );
        const scoutDrift =
          agentId === "meta-scout" &&
          metaScoutOwnsDriftsArtisanOrConductor(payload);
        finalResult = {
          agentId,
          ok: payload.agent === agentId && score >= 0.8 && !scoutDrift,
          nativeInvocationObserved: true,
          nativeInvocationKind: "claude_main_session_custom_agent_binding",
          nativeInvocationCommand: `claude -p --agent ${agentId}`,
          score,
          matchedGroups,
          missedGroups,
          attempts: attempt,
          ...(scoutDrift ? { scoutArtisanConductorDrift: true } : {}),
          sample: payload,
        };
        if (finalResult.ok) break;
        logProgress(`Claude live case ${agentId} attempt ${attempt}/2 scored ${score}`);
      }
      results.push(finalResult);
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

async function runClaudeLive(expectedAgentIds, probeAgentIds = expectedAgentIds) {
  const discovery = await runClaudeDiscovery(expectedAgentIds);
  const results = await runClaudeCases(probeAgentIds);
  return summarizeClaudeRuntime(discovery, results);
}

async function runCodexSmoke(expectedAgentIds) {
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
      },
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
  const codexAgents = await readRuntimeAgentDefinitions(
    [
      path.join(repoRoot, ".codex", "agents"),
      path.join(os.homedir(), ".codex", "agents"),
    ],
    ".toml",
  );
  const publicCodexAgents = publicRuntimeAgentInventory(
    codexAgents,
    expectedAgentIds,
  );
  const payload = {
    runtime: "codex",
    cli_version: versionStdout.trim(),
    entrypoint: "AGENTS.md",
    canonical_skill_root: "canonical/skills/meta-theory",
    sync_manifest: "config/sync.json",
    custom_agents: publicCodexAgents.ids,
    custom_agents_source: codexAgents.source,
    custom_agent_definitions: publicCodexAgents.definitions,
    expected_inventory_source: "canonical/agents",
    custom_agent_inventory_kind: "definitions_only_not_live_loaded",
    mcp_supported: configExample.includes("[mcp_servers.meta_kim_runtime]"),
    sandbox_configurable: configExample.includes("sandbox_mode"),
    approvals_configurable: configExample.includes("approval_policy"),
    suppresses_unstable_feature_warning: configExample.includes(
      "suppress_unstable_features_warning = true",
    ),
    request_user_input_default_mode:
      configExample.includes("[features]") &&
      configExample.includes("default_mode_request_user_input = true"),
  };

  const structuralOk =
    payload.runtime === "codex" &&
    payload.entrypoint === "AGENTS.md" &&
    payload.canonical_skill_root === "canonical/skills/meta-theory" &&
    payload.sync_manifest === "config/sync.json" &&
    expectedAgentIds.every((agentId) => payload.custom_agents.includes(agentId)) &&
    payload.mcp_supported === true &&
    payload.sandbox_configurable === true &&
    payload.approvals_configurable === true &&
    payload.suppresses_unstable_feature_warning === true &&
    payload.request_user_input_default_mode === true;

  return {
    status: structuralOk ? "passed" : "failed",
    ok: structuralOk,
    mode: "smoke",
    sample: payload,
  };
}

async function runCodexLive(expectedAgentIds, representativeAgentId = "meta-prism") {
  const forceTimeoutFixture = shouldForceCodexLiveTimeoutFixture();
  const forceNonzeroFixture = shouldForceCodexLiveNonzeroFixture();
  const forceWeakNormalFixture = shouldForceCodexLiveWeakNormalFixture();
  const codexCmd =
    forceTimeoutFixture || forceNonzeroFixture || forceWeakNormalFixture
    ? { file: "codex-fixture", toArgs: (args) => args.map(String) }
    : await getResolvedCodexCommand();
  let versionStdout;
  try {
    logProgress("Codex live: probing CLI and running repository smoke prompt");
    if (
      forceTimeoutFixture ||
      forceNonzeroFixture ||
      forceWeakNormalFixture
    ) {
      versionStdout = forceTimeoutFixture
        ? "codex-cli timeout-fixture"
        : forceNonzeroFixture
        ? "codex-cli nonzero-fixture"
        : "codex-cli weak-normal-fixture";
    } else {
      ({ stdout: versionStdout } = await runCommandWithIgnoredStdin(
        codexCmd.file,
        codexCmd.toArgs(["--version"]),
        {
          cwd: repoRoot,
          timeout: 30_000,
          env: { ...process.env, NO_COLOR: "1" },
        },
      ));
    }
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
  const codexAgents = await readRuntimeAgentDefinitions(
    [
      path.join(repoRoot, ".codex", "agents"),
      path.join(os.homedir(), ".codex", "agents"),
    ],
    ".toml",
  );
  const publicCodexAgents = publicRuntimeAgentInventory(
    codexAgents,
    expectedAgentIds,
  );
  const payload = {
    runtime: "codex",
    cli_version: versionStdout.trim(),
    entrypoint: "AGENTS.md",
    canonical_skill_root: "canonical/skills/meta-theory",
    sync_manifest: "config/sync.json",
    custom_agents: publicCodexAgents.ids,
    custom_agents_source: codexAgents.source,
    custom_agent_definitions: publicCodexAgents.definitions,
    expected_inventory_source: "canonical/agents",
    custom_agent_inventory_kind: "definitions_only_not_live_loaded",
    mcp_supported: configExample.includes("[mcp_servers.meta_kim_runtime]"),
    sandbox_configurable: configExample.includes("sandbox_mode"),
    approvals_configurable: configExample.includes("approval_policy"),
    suppresses_unstable_feature_warning: configExample.includes(
      "suppress_unstable_features_warning = true",
    ),
    request_user_input_default_mode:
      configExample.includes("[features]") &&
      configExample.includes("default_mode_request_user_input = true"),
  };

  const structuralOk =
    payload.runtime === "codex" &&
    payload.entrypoint === "AGENTS.md" &&
    payload.canonical_skill_root === "canonical/skills/meta-theory" &&
    payload.sync_manifest === "config/sync.json" &&
    expectedAgentIds.every((agentId) => payload.custom_agents.includes(agentId)) &&
    payload.mcp_supported === true &&
    payload.sandbox_configurable === true &&
    payload.approvals_configurable === true &&
    payload.suppresses_unstable_feature_warning === true &&
    payload.request_user_input_default_mode === true;

  const schemaDir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-codex-"));
  const schemaPath = path.join(schemaDir, "codex-live-orchestration.schema.json");
  await fs.writeFile(schemaPath, codexLiveOrchestrationSchema, "utf8");

  let liveEvidence = null;
  let commandStartedAtMs = null;
  try {
    const prompt =
      `Use the native spawn_agent collaboration tool exactly once. If its active schema exposes agent_type, set it to ${representativeAgentId}; otherwise omit the selector and use a run-scoped owner contract. ` +
      "Never use task_name or a nickname as proof of owner identity. " +
      "Ask that child to review whether the words primary runtime evidence are precise, wait for the child result, then return JSON only. " +
      "Do not claim the child ran unless the tool call completed. " +
      'Set runtime to "codex" and governed_entry to "meta-theory". ' +
      "Set warden_entry_gate and conductor_orchestration true only if the route is Warden -> Conductor. " +
      'orchestrationTaskBoardPacket.synthesisOwner must be "meta-conductor" and route must mention Warden -> Conductor -> board -> workerTaskPackets. ' +
      "workerTaskPackets must contain one bounded task with owner, deliverable, and verificationOwner. " +
      "Do not modify files and do not explain outside JSON.";

    const codexExecArgs = codexCmd.toArgs([
      "exec",
      "--ignore-user-config",
      "--enable",
      "multi_agent",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--output-schema",
      schemaPath,
      "--cd",
      repoRoot,
      prompt,
    ]);
    commandStartedAtMs = Date.now();
    if (forceTimeoutFixture) {
      throw buildCodexLiveTimeoutFixtureError();
    }
    if (forceNonzeroFixture) {
      throw buildCodexLiveNonzeroFixtureError();
    }
    let stdout;
    if (forceWeakNormalFixture) {
      stdout = buildCodexLiveNonzeroFixtureError("weak").stdout;
    } else {
      ({ stdout } = await runCommandWithIgnoredStdin(
        codexCmd.file,
        codexExecArgs,
        {
          cwd: repoRoot,
          timeout: CODEX_LIVE_TIMEOUT_MS,
          env: { ...process.env, NO_COLOR: "1" },
        },
      ));
    }

    liveEvidence = await inspectCodexLiveEvidenceWithSessionFallback(stdout, {
      structuralOk,
      representativeAgentId,
      fixture: forceTimeoutFixture,
      sinceMs: commandStartedAtMs,
    });
  } catch (error) {
    if (isCommandTimeoutFailure(error)) {
      const timeoutEvidence = await inspectCodexLiveEvidenceWithSessionFallback(
        error.stdout,
        {
          structuralOk,
          representativeAgentId,
          fixture: forceTimeoutFixture,
          sinceMs: commandStartedAtMs,
          sessionSettleTimeoutMs: CODEX_SESSION_SETTLE_TIMEOUT_MS,
        },
      );
      if (codexRecoveryHasReturnedChildFinal(timeoutEvidence)) {
        return {
          status: "passed",
          ok: true,
          releaseFuseInvocationObserved: true,
          nativeInvocationObserved:
            timeoutEvidence.customAgentInvocationObserved === true,
          customAgentInvocationObserved:
            timeoutEvidence.customAgentInvocationObserved === true,
          nativeInvocationKind: "codex_spawn_agent_child_completion",
          ownerBindingMode: timeoutEvidence.nativeInvocation.ownerBindingMode,
          nativeAgentType: timeoutEvidence.nativeInvocation.nativeAgentType,
          wrapperTimedOutAfterCompletedInvocation: true,
          sample: {
            ...payload,
            runtime_smoke: timeoutEvidence.runtimePayload,
            runtime_native_invocation: timeoutEvidence.nativeInvocation,
            runtime_session_evidence: timeoutEvidence.sessionEvidence,
            runtime_recovery: {
              wrapperTimedOutAfterCompletedInvocation: true,
              reason: "codex_wrapper_timeout_after_completed_native_invocation",
              errorClass: "codex_wrapper_timeout_after_completed_invocation",
              stage: "codex_exec_orchestration_prompt",
              timeoutMs: error.timeoutMs ?? CODEX_LIVE_TIMEOUT_MS,
              threadId: extractCodexThreadId(error.stdout),
              stdoutSha256: diagnosticSha256(error.stdout),
              stderrSha256: diagnosticSha256(error.stderr),
              sessionLookupFailure:
                timeoutEvidence.sessionLookupFailure ?? null,
            },
          },
        };
      }
      const recoveredPayload = timeoutEvidence.runtimePayload;
      const recoveredDiagnosticOk = timeoutEvidence.behaviorDiagnosticOk;
      if (recoveredDiagnosticOk) {
        return {
          status: "skipped",
          ok: false,
          skipped: true,
          retryable: true,
          reason: "codex_live_timeout_recovered_diagnostic_only",
          recoveredFromTimeout: true,
          nativeInvocationObserved: false,
          sample: {
            ...payload,
            runtime_smoke: recoveredPayload,
            runtime_session_evidence: timeoutEvidence.sessionEvidence,
            runtime_recovery: {
              recoveredFromTimeout: true,
              reason: "codex_live_timeout_recovered",
              stage: "codex_exec_orchestration_prompt",
              timeoutMs: error.timeoutMs ?? CODEX_LIVE_TIMEOUT_MS,
              threadId: extractCodexThreadId(error.stdout),
              retryCommand:
                "node scripts/eval-meta-agents.mjs --runtime=codex --live",
              promptContract:
                "Warden -> Conductor -> orchestrationTaskBoardPacket -> workerTaskPackets",
              errorClass: "command_timeout",
              stdoutSha256: diagnosticSha256(error.stdout),
              stderrSha256: diagnosticSha256(error.stderr),
              sessionLookupFailure:
                timeoutEvidence.sessionLookupFailure ?? null,
            },
          },
        };
      }
      return {
        status: "skipped",
        ok: structuralOk,
        skipped: true,
        retryable: true,
        reason: "codex_live_timeout",
        sample: {
          ...payload,
          runtime_live: {
            skipped: true,
            reason: "codex_live_timeout",
            stage: "codex_exec_orchestration_prompt",
            timeoutMs: error.timeoutMs ?? CODEX_LIVE_TIMEOUT_MS,
            threadId: extractCodexThreadId(error.stdout),
            retryCommand:
              "node scripts/eval-meta-agents.mjs --runtime=codex --live",
            sessionRecoveryHint:
              "Use the Codex session record for threadId when stdout contains a thread.started event.",
            promptContract:
              "Warden -> Conductor -> orchestrationTaskBoardPacket -> workerTaskPackets",
            errorClass: "command_timeout",
            stdoutSha256: diagnosticSha256(error.stdout),
            stderrSha256: diagnosticSha256(error.stderr),
            sessionLookupFailure:
              timeoutEvidence.sessionLookupFailure ?? null,
          },
        },
      };
    }
    if (
      error?.code === "META_KIM_CHILD_COMMAND_FAILED" &&
      typeof error?.stdout === "string"
    ) {
      const completedEvidence =
        await inspectCodexLiveEvidenceWithSessionFallback(error.stdout, {
          structuralOk,
          representativeAgentId,
          fixture: false,
          sinceMs: commandStartedAtMs,
          sessionSettleTimeoutMs: CODEX_SESSION_SETTLE_TIMEOUT_MS,
        });
      if (codexRecoveryHasReturnedChildFinal(completedEvidence)) {
        return {
          status: "passed",
          ok: true,
          releaseFuseInvocationObserved: true,
          nativeInvocationObserved:
            completedEvidence.customAgentInvocationObserved === true,
          customAgentInvocationObserved:
            completedEvidence.customAgentInvocationObserved === true,
          nativeInvocationKind: "codex_spawn_agent_child_completion",
          ownerBindingMode:
            completedEvidence.nativeInvocation.ownerBindingMode,
          nativeAgentType: completedEvidence.nativeInvocation.nativeAgentType,
          wrapperFailedAfterCompletedInvocation: true,
          sample: {
            ...payload,
            runtime_smoke: completedEvidence.runtimePayload,
            runtime_native_invocation: completedEvidence.nativeInvocation,
            runtime_session_evidence: completedEvidence.sessionEvidence,
            runtime_recovery: {
              wrapperFailedAfterCompletedInvocation: true,
              reason:
                "codex_wrapper_failed_after_completed_native_invocation",
              errorClass:
                "codex_wrapper_nonzero_after_completed_invocation",
              stage: "codex_exec_orchestration_prompt",
              threadId: extractCodexThreadId(error.stdout),
              stdoutSha256: diagnosticSha256(error.stdout),
              stderrSha256: diagnosticSha256(error.stderr),
              sessionLookupFailure:
                completedEvidence.sessionLookupFailure ?? null,
            },
          },
        };
      }
    }
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
            errorClass: error?.code ?? "codex_runtime_unavailable",
            stdoutSha256: diagnosticSha256(error?.stdout),
            stderrSha256: diagnosticSha256(error?.stderr),
          },
        },
      };
    }
    throw error;
  } finally {
    await fs.rm(schemaDir, { recursive: true, force: true });
  }

  const runtimePayload = liveEvidence?.runtimePayload ?? null;
  const nativeInvocation = liveEvidence?.nativeInvocation ?? null;
  const releaseFuseInvocationObserved =
    liveEvidence?.releaseFuseInvocationObserved === true;
  const customAgentInvocationObserved =
    liveEvidence?.customAgentInvocationObserved === true;
  const liveOk =
    liveEvidence?.behaviorDiagnosticOk === true && releaseFuseInvocationObserved;

  return {
    status: liveOk ? "passed" : "failed",
    ok: liveOk,
    reason: liveOk ? null : "codex_release_fuse_spawn_not_observed",
    releaseFuseInvocationObserved,
    nativeInvocationObserved: customAgentInvocationObserved,
    customAgentInvocationObserved: customAgentInvocationObserved,
    nativeInvocationKind: "codex_spawn_agent_child_completion",
    ownerBindingMode: nativeInvocation?.ownerBindingMode ?? null,
    nativeAgentType: nativeInvocation?.nativeAgentType ?? null,
    sample: {
      ...payload,
      runtime_smoke: runtimePayload,
      runtime_native_invocation: nativeInvocation,
      runtime_session_evidence: liveEvidence?.sessionEvidence ?? null,
      runtime_session_lookup_failure:
        liveEvidence?.sessionLookupFailure ?? null,
    },
  };
}

async function runCursorSmoke() {
  logProgress("Cursor smoke: checking generated projection files");
  const cursorAgentsDir = path.join(repoRoot, ".cursor", "agents");
  const cursorSkillPath = path.join(
    repoRoot,
    ".cursor",
    "skills",
    "meta-theory",
    "SKILL.md",
  );
  const cursorHooksPath = path.join(repoRoot, ".cursor", "hooks.json");
  const cursorRulesDir = path.join(repoRoot, ".cursor", "rules");
  const cursorAgents = await readRuntimeAgentDefinitions(
    [cursorAgentsDir, path.join(os.homedir(), ".cursor", "agents")],
    ".md",
  );
  const skill = await readTextOrCanonical(
    cursorSkillPath,
    path.join(canonicalAgentsDir, "..", "skills", "meta-theory", "SKILL.md"),
  );
  const hooks = await readTextOrCanonical(
    cursorHooksPath,
    path.join(canonicalRuntimeAssetsDir, "cursor", "hooks.json"),
  );
  const rules = await readFilesOrCanonical(
    cursorRulesDir,
    path.join(canonicalRuntimeAssetsDir, "cursor", "rules"),
    ".mdc",
  );
  const payload = {
    runtime: "cursor",
    mode: "smoke",
    entrypoint: "AGENTS.md",
    canonical_skill_root: "canonical/skills/meta-theory",
    generated_skill: ".cursor/skills/meta-theory/SKILL.md",
    generated_hooks: ".cursor/hooks.json",
    generated_rules: rules.files.map((file) => `.cursor/rules/${file}`),
    custom_agents: cursorAgents.ids,
    custom_agents_source: cursorAgents.source,
    skill_source: skill.source,
    hooks_source: hooks.source,
    rules_source: rules.source,
    skill_mentions_warden: /meta-warden/i.test(skill.text),
    skill_mentions_conductor: /meta-conductor/i.test(skill.text),
    hook_surface_configured: /preToolUse|postToolUse|failClosed/i.test(hooks.text),
    native_live_turn_harness: false,
  };
  const ok =
    payload.custom_agents.includes("meta-warden") &&
    payload.skill_mentions_warden &&
    payload.skill_mentions_conductor &&
    payload.hook_surface_configured &&
    payload.generated_rules.length > 0;
  return {
    status: ok ? "passed" : "failed",
    ok,
    mode: "smoke",
    sample: payload,
  };
}

async function readCursorLiveHarnessContract() {
  return JSON.parse(
    await fs.readFile(cursorLiveHarnessContractPath, "utf8"),
  );
}

function helpSupportsCursorHarness(helpText, contractCandidate) {
  const text = String(helpText ?? "");
  return (contractCandidate.requiredHelpPatterns ?? []).every((pattern) =>
    text.includes(pattern),
  );
}

function cursorLivePayloadOk(payload) {
  return (
    payload?.runtime === "cursor" &&
    payload?.governed_entry === "meta-theory" &&
    payload?.warden_entry_gate === true &&
    payload?.conductor_orchestration === true &&
    payload?.orchestrationTaskBoardPacket?.synthesisOwner ===
      "meta-conductor" &&
    Array.isArray(payload?.workerTaskPackets) &&
    payload.workerTaskPackets.length > 0 &&
    typeof payload?.verificationOwner === "string" &&
    payload.verificationOwner.trim().length > 0
  );
}

function buildCursorLiveSuccessFixture({ smoke, contract }) {
  const payload = {
    runtime: "cursor",
    governed_entry: "meta-theory",
    warden_entry_gate: true,
    conductor_orchestration: true,
    orchestrationTaskBoardPacket: {
      synthesisOwner: "meta-conductor",
      route: "Warden -> Conductor -> board -> workerTaskPackets",
    },
    workerTaskPackets: [
      {
        owner: "meta-artisan",
        roleDisplayName: "backend",
        deliverable: "Cursor native live success fixture",
        verificationOwner: "verify",
      },
    ],
    verificationOwner: "verify",
  };
  return {
    status: "passed",
    ok: true,
    mode: "live",
    fixture: true,
    contract: {
      schemaVersion: contract.schemaVersion,
      path: "config/contracts/cursor-live-turn-harness-contract.json",
    },
    localProbe: {
      selectedHarness: "cursor-agent-success-fixture",
      candidates: [
        {
          id: "cursor-agent-success-fixture",
          ok: true,
          command: "fixture cursor-agent",
          missingHelpPatterns: [],
          helpTail: "--print --output-format json stream-json",
        },
      ],
    },
    sample: {
      runtime_smoke: payload,
    },
    smoke,
  };
}

async function probeCursorAgentHarness(contract) {
  const candidates = await getResolvedCursorAgentCandidates();
  const contractCandidates = new Map(
    (contract.nativeHarnessCandidates ?? []).map((candidate) => [
      candidate.id,
      candidate,
    ]),
  );
  const probes = [];
  for (const candidate of candidates) {
    const contractCandidate = contractCandidates.get(candidate.id);
    if (!contractCandidate) {
      continue;
    }
    if (candidate.unavailable) {
      probes.push({
        id: candidate.id,
        ok: false,
        unavailable: true,
        reason: "cursor_agent_command_not_found",
        error: candidate.error,
      });
      continue;
    }
    try {
      const help = await runCommandWithIgnoredStdin(
        candidate.command.file,
        candidate.toArgs(["--help"]),
        {
          cwd: repoRoot,
          timeout: 30_000,
          env: { ...process.env, NO_COLOR: "1" },
        },
      );
      const helpOutput = mergeCommandOutput(help.stdout, help.stderr);
      const ok = helpSupportsCursorHarness(helpOutput, contractCandidate);
      probes.push({
        id: candidate.id,
        ok,
        command: contractCandidate.command,
        missingHelpPatterns: (contractCandidate.requiredHelpPatterns ?? []).filter(
          (pattern) => !helpOutput.includes(pattern),
        ),
        helpTail: tailText(helpOutput, 1200),
      });
      if (ok) {
        return {
          ok: true,
          selected: {
            ...candidate,
            contractCandidate,
          },
          probes,
        };
      }
    } catch (error) {
      probes.push({
        id: candidate.id,
        ok: false,
        command: contractCandidate.command,
        reason: "cursor_agent_help_failed",
        error: error.message,
      });
    }
  }
  return {
    ok: false,
    probes,
  };
}

async function runCursorLive() {
  const smoke = await runCursorSmoke();
  const contract = await readCursorLiveHarnessContract();
  if (process.env.META_KIM_CURSOR_LIVE_SUCCESS_FIXTURE === "1") {
    return buildCursorLiveSuccessFixture({ smoke, contract });
  }
  const harnessProbe = await probeCursorAgentHarness(contract);
  if (!harnessProbe.ok) {
    return {
      status: "blocked",
      ok: false,
      blocked: true,
      retryable: true,
      reason: "cursor_live_harness_blocked",
      unsupportedWithReason: contract.unsupportedWithReason,
      failureClass: "native_harness_missing",
      contract: {
        schemaVersion: contract.schemaVersion,
        path: "config/contracts/cursor-live-turn-harness-contract.json",
        officialEvidence: contract.officialEvidence,
        passCriteria: contract.passCriteria,
        blockedCriteria: contract.blockedCriteria,
        releaseBoundary: contract.releaseBoundary,
      },
      localProbe: {
        cursorVersionCommand: "cursor --version",
        candidates: harnessProbe.probes,
      },
      remainingAction:
        "Install or expose Cursor Agent CLI (`cursor-agent`) on the host or official Windows WSL path, or expose a `cursor agent` subcommand with -p/--print and --output-format support, authenticate it, then rerun `node scripts/eval-meta-agents.mjs --runtime=cursor --live`.",
      smoke,
    };
  }

  const prompt =
    "Return JSON only. Prove the governed Meta_Kim Cursor route for one tiny task: " +
    "identify whether a reusable skill should be created for repeated release report formatting. " +
    'Set runtime to "cursor" and governed_entry to "meta-theory". ' +
    "Set warden_entry_gate and conductor_orchestration true only if the route is Warden -> Conductor. " +
    'orchestrationTaskBoardPacket.synthesisOwner must be "meta-conductor" and route must mention Warden -> Conductor -> board -> workerTaskPackets. ' +
    "workerTaskPackets must contain one bounded task with owner, deliverable, and verificationOwner. " +
    "Do not modify files and do not explain outside JSON.";

  try {
    const selected = harnessProbe.selected;
    const { stdout, stderr } = await runCommandWithIgnoredStdin(
      selected.command.file,
      selected.toArgs([...selected.contractCandidate.runArgs, prompt]),
      {
        cwd: repoRoot,
        timeout: 120_000,
        env: { ...process.env, NO_COLOR: "1" },
      },
    );
    const payload = parseJsonObjectFromText(mergeCommandOutput(stdout, stderr));
    const ok = cursorLivePayloadOk(payload);
    return {
      status: ok ? "passed" : "failed",
      ok,
      mode: "live",
      contract: {
        schemaVersion: contract.schemaVersion,
        path: "config/contracts/cursor-live-turn-harness-contract.json",
      },
      localProbe: {
        selectedHarness: selected.id,
        candidates: harnessProbe.probes,
      },
      sample: {
        runtime_smoke: payload,
      },
      smoke,
    };
  } catch (error) {
    return {
      status: "blocked",
      ok: false,
      blocked: true,
      retryable: true,
      reason: isCommandTimeoutFailure(error)
        ? "cursor_live_timeout"
        : "cursor_live_harness_blocked",
      unsupportedWithReason:
        "Cursor native agent CLI was detected, but the live run did not return parseable governed JSON.",
      failureClass: isCommandTimeoutFailure(error) ? "timeout" : "native_harness_missing",
      contract: {
        schemaVersion: contract.schemaVersion,
        path: "config/contracts/cursor-live-turn-harness-contract.json",
      },
      localProbe: {
        selectedHarness: harnessProbe.selected?.id,
        candidates: harnessProbe.probes,
        error: error.message,
        stdoutTail: tailText(error.stdout),
        stderrTail: tailText(error.stderr),
      },
      remainingAction:
        "Fix Cursor Agent CLI auth/output mode or rerun after confirming it can return JSON in non-interactive mode.",
      smoke,
    };
  }
}

async function collectOpenClawBaseStatus({ useMainConfig = false } = {}) {
  logProgress("OpenClaw smoke: preparing local config and validating hooks");
  await runCommandWithIgnoredStdin("node", [prepareOpenClawScriptPath], {
    cwd: repoRoot,
    timeout: 120_000,
    env: openClawChildEnv(),
  });

  const command = await resolveOpenClawCommand();
  const tempConfig = useMainConfig
    ? {
        tempDir: null,
        stateDir: null,
        homeDir: null,
        sessionRootDir: null,
        logFile: null,
        configPath: openclawMainConfigPath,
        codexHomeDir: null,
        configSource: "main",
        evalModel: openClawMainDefaultModel() ?? defaultOpenClawEvalModel(),
      }
    : await createOpenClawEvalConfig();
  const env = useMainConfig
    ? openClawChildEnv()
    : openClawChildEnv({
        OPENCLAW_CONFIG_PATH: tempConfig.configPath,
        OPENCLAW_STATE_DIR: tempConfig.stateDir,
        OPENCLAW_HOME: tempConfig.homeDir,
        ...(shouldUseIsolatedCodexHome(tempConfig.evalModel)
          ? { CODEX_HOME: tempConfig.codexHomeDir }
          : {}),
      });

  const validation = await runCommandWithIgnoredStdin(
    command.file,
    command.toArgs(["config", "validate"]),
    {
      cwd: repoRoot,
      timeout: 60_000,
      env,
    },
  );
  const validationOutput = mergeCommandOutput(
    validation.stdout,
    validation.stderr,
  );

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
        timeout: 20_000,
        env: { ...env, CI: "1", NO_COLOR: "1" },
      },
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
    tempConfig,
    validationOutput,
    hooksDiscovery,
  };
}

function isMissingOpenClawAuthError(error) {
  return String(error?.message ?? "").includes("Missing source OpenClaw auth file:");
}

async function runOpenClawStructuralSmoke(authError) {
  const template = JSON.parse(
    await fs.readFile(openclawTemplateConfigPath, "utf8"),
  );
  const agentIds = await loadClaudeAgentIds();
  const templateAgents = new Set(
    (template.agents?.list ?? []).map((agent) => agent.id),
  );
  const missingAgents = agentIds.filter((agentId) => !templateAgents.has(agentId));
  const workspaces = await Promise.all(
    agentIds.map((agentId) =>
      fileExists(path.join(repoRoot, "openclaw", "workspaces", agentId, "AGENTS.md")),
    ),
  );
  const hasAllWorkspaces = workspaces.every(Boolean);
  const hooks = template.hooks?.internal?.entries ?? {};
  const hasRequiredHooks =
    template.hooks?.internal?.enabled === true &&
    hooks["boot-md"]?.enabled === true &&
    hooks["command-logger"]?.enabled === true &&
    hooks["session-memory"]?.enabled === true;
  const allowList = template.tools?.agentToAgent?.allow ?? [];
  const allowsAllAgents = agentIds.every((agentId) => allowList.includes(agentId));
  const skillsExtraDirs = template.skills?.load?.extraDirs ?? [];
  const hasSkillsExtraDir = skillsExtraDirs.some((entry) =>
    String(entry).includes("openclaw"),
  );
  const ok =
    missingAgents.length === 0 &&
    hasAllWorkspaces &&
    hasRequiredHooks &&
    allowsAllAgents &&
    hasSkillsExtraDir;

  return {
    status: ok ? "passed" : "failed",
    ok,
    mode: "smoke",
    source: "structural-template",
    runtimeAuthHydration: {
      skipped: true,
      reason: "openclaw_auth_not_configured",
      error: authError.message,
    },
    missingAgents,
    workspacesOk: hasAllWorkspaces,
    hooksOk: hasRequiredHooks,
    allowListOk: allowsAllAgents,
    skillsExtraDirOk: hasSkillsExtraDir,
  };
}

async function runOpenClawSmoke() {
  let baseStatus;
  try {
    baseStatus = await collectOpenClawBaseStatus({ useMainConfig: true });
  } catch (error) {
    if (isMissingOpenClawAuthError(error)) {
      return runOpenClawStructuralSmoke(error);
    }
    throw error;
  }
  try {
    const configOk = baseStatus.validationOutput
      .toLowerCase()
      .includes("config valid");
    let hooksOk = baseStatus.hooksDiscovery.ok;
    let hooksDiscoveryOutput = baseStatus.hooksDiscovery.output;
    let smokeSource = "binary-hooks-list";

    if (!hooksOk) {
      // hooks list failed (e.g. Windows cmd.exe /d /c nesting incompatibility with openclaw.cmd batch wrapper).
      // Fall back to structural template validation (file-system only, no openclaw.cmd invocation).
      const structural = await runOpenClawStructuralSmoke(
        new Error(baseStatus.hooksDiscovery.output || "openclaw hooks list unavailable"),
      );
      hooksOk = Boolean(structural.hooksOk);
      hooksDiscoveryOutput = `structural fallback (binary hooks list failed: ${baseStatus.hooksDiscovery.output}); structural hooksOk=${structural.hooksOk}`;
      smokeSource = "structural-fallback";
    }

    const ok = configOk && hooksOk;
    return {
      status: ok ? "passed" : "failed",
      ok,
      mode: "smoke",
      source: smokeSource,
      evalModel: baseStatus.tempConfig.evalModel,
      configSource: baseStatus.tempConfig.configSource,
      configOk,
      hooksOk,
      hooksDiscovery: hooksDiscoveryOutput,
      validation: baseStatus.validationOutput,
      ...(shouldKeepOpenClawEvalTemp()
        ? {
            diagnosticTemp: {
              tempDir: baseStatus.tempConfig.tempDir,
              stateDir: baseStatus.tempConfig.stateDir,
              logFile: baseStatus.tempConfig.logFile,
            },
          }
        : {}),
    };
  } finally {
    await cleanupOpenClawEvalTemp(baseStatus.tempConfig);
  }
}

async function runOpenClawLive() {
  let baseStatus;
  try {
    baseStatus = await collectOpenClawBaseStatus();
  } catch (error) {
    if (isMissingOpenClawAuthError(error)) {
      const structuralSmoke = await runOpenClawStructuralSmoke(error);
      return {
        status: "skipped",
        ok: false,
        skipped: true,
        retryable: true,
        reason: "openclaw_auth_not_configured",
        needsAuth: true,
        mode: "live",
        authProbe: {
          status: "needs_auth",
          missing: path.join(
            os.homedir(),
            ".openclaw",
            "agents",
            "main",
            "agent",
            "auth.json",
          ),
          error: error.message,
        },
        structuralSmoke,
      };
    }
    throw error;
  }
  try {
    const smokeAgents = filterSelectedAgentIds(await loadClaudeAgentIds());
    if (smokeAgents.length === 0) {
      throw new Error(
        `No canonical agent matched --agent=${[...selectedAgentIds].join(",")}`,
      );
    }
    const agentResults = [];

    for (const agentId of smokeAgents) {
      try {
        logProgress(
          `OpenClaw live case ${agentResults.length + 1}/${smokeAgents.length}: ${agentId}`,
        );
        const caseConfig = claudeCases[agentId];
        const refusalInstruction =
          agentId === "meta-scout"
            ? "refuses：字符串数组，恰好 2 个独立字符串；第一条说明你不直接执行工具或运行时动作，第二条说明你不负责协调、统筹或综合；不要把两条合并成一个字符串；"
            : "refuses：字符串数组，恰好 2 个独立字符串，每条是你明确不负责的短句；不要把两条合并成一个字符串；";
        const prompt =
          "你正在做 Meta_Kim 元 agent 角色边界自检。先依据已注入的 SOUL.md、IDENTITY.md、AGENTS.md 和 frontmatter，不要凭通用 agent 印象补写。" +
          "只输出一段 JSON，不要解释。JSON 必须包含 agent、owns、refuses、artifact、delegates_to 这 5 个字段。" +
          `agent 字段必须精确写 ${agentId}（不能翻译、不能改写、不能写角色名）。` +
          "owns：字符串数组，恰好 3 条，优先来自 SOUL.md 的 Own、Responsibility Boundary、Primary stage 或 Core Truths；" +
          refusalInstruction +
          "refuses 必须优先来自 SOUL.md/frontmatter 的 Do Not Touch、Must not execute in、Refuses 或 CANNOT/NEVER 边界，不要用泛泛的 meta-agent 职责代替；" +
          "artifact：一个字符串，优先来自 SOUL.md 中该 agent 的核心产物或 artifact 描述；" +
          "delegates_to：字符串数组，恰好 2 个 agent id，优先来自 SOUL.md 的 Handoff owner、Do Not Touch 或协作边界。";
            let turn = null;
            let lastTurnError = null;
            let turnAttempt = 0;
            for (let attempt = 1; attempt <= 2; attempt += 1) {
              const sessionId = `eval-${agentId}-${crypto.randomUUID()}`;
              turnAttempt = attempt;
              try {
                turn = await runOpenClawAgentTurn(
                  baseStatus.command,
                  [
                    "agent",
                    "--local",
                    "--agent",
                    agentId,
                    "--thinking",
                    "off",
                    "--session-id",
                    sessionId,
                    "--message",
                    prompt,
                    "--json",
                    "--timeout",
                    "300",
                  ],
                  {
                    cwd: repoRoot,
                    env: baseStatus.env,
                    agentId,
                    sessionId,
                    sessionDirs: [
                      path.join(baseStatus.tempConfig.sessionRootDir, agentId),
                      path.join(
                        baseStatus.tempConfig.stateDir,
                        "agents",
                        agentId,
                        "sessions",
                      ),
                    ],
                    sessionTimeoutMs: 390_000,
                  },
                );
                break;
              } catch (error) {
                lastTurnError = error;
                logProgress(
                  `OpenClaw live case ${agentId} attempt ${attempt}/2 failed: ${error.message}`,
                );
              }
            }
            if (!turn) {
              throw lastTurnError ?? new Error("OpenClaw live turn failed.");
            }

        const payload = normalizeOpenClawAgentPayload(agentId, turn.payload);
        const injectionOk =
          payload.wrapper?.meta?.systemPromptReport?.injectedWorkspaceFiles?.every(
            (item) => item.missing === false,
          ) ??
          payload.sessionRecovery?.bootstrapFull === true;
        const injectedWorkspaceFiles =
          payload.wrapper?.meta?.systemPromptReport?.injectedWorkspaceFiles?.map(
            (item) => ({
              name: item.name,
              missing: item.missing,
              truncated: item.truncated,
            }),
          ) ??
          (payload.sessionRecovery?.bootstrapFull
            ? [{ name: "session-jsonl-bootstrap-context", missing: false, truncated: false }]
            : []);

        const structuralOk = openClawStructuredPayloadLooksReal(
          agentId,
          payload,
        );
        const scored = caseConfig
          ? scoreClaudeCase(caseConfig, payload)
          : {
              score: 0,
              matchedGroups: [],
              missedGroups: ["missing-case-config"],
            };
        const scoutDrift =
          agentId === "meta-scout" &&
          metaScoutOwnsDriftsArtisanOrConductor(payload);
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
              recoveredFromSession: turn.recoveredFromSession === true,
              attempts: turnAttempt,
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
      evalModel: baseStatus.tempConfig.evalModel,
      configOk: baseStatus.validationOutput
        .toLowerCase()
        .includes("config valid"),
      hooksOk: baseStatus.hooksDiscovery.ok,
      hooksDiscovery: baseStatus.hooksDiscovery.output,
      validation: baseStatus.validationOutput,
      ...(shouldKeepOpenClawEvalTemp()
        ? {
            diagnosticTemp: {
              tempDir: baseStatus.tempConfig.tempDir,
              stateDir: baseStatus.tempConfig.stateDir,
              logFile: baseStatus.tempConfig.logFile,
            },
          }
        : {}),
      agentResults,
    };
  } finally {
    await cleanupOpenClawEvalTemp(baseStatus.tempConfig);
  }
}

async function runPrimaryReleaseRuntimeIsolated(runtimeName) {
  const timeout = PRIMARY_RELEASE_RUNTIME_PROCESS_TIMEOUT_MS[runtimeName];
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error(`Unsupported primary release runtime: ${runtimeName}`);
  }

  const runner =
    process.platform === "win32"
      ? runWindowsGuardedCommand
      : runCommandWithIgnoredStdin;
  const attemptEvidence = [];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    logProgress(
      `${runtimeName} primary fuse: starting isolated runtime process attempt ${attempt}/2`,
    );
    try {
      const { stdout, processTreeCleanupVerified } = await runner(
        process.execPath,
        [
          fileURLToPath(import.meta.url),
          `--runtime=${runtimeName}`,
          "--live",
        ],
        {
          cwd: repoRoot,
          env: process.env,
          timeout,
        },
      );
      const childReport = JSON.parse(stdout);
      const runtimeReport = childReport?.[runtimeName];
      const exactRuntimeScope =
        Array.isArray(childReport?.requestedRuntimes) &&
        childReport.requestedRuntimes.length === 1 &&
        childReport.requestedRuntimes[0] === runtimeName;
      const releaseGrade =
        childReport?.mode === "live" &&
        exactRuntimeScope &&
        runtimeReport?.status === "passed" &&
        childReport?.runtimeEvidencePacket?.summary?.releaseGrade === true;
      if (releaseGrade) {
        return {
          ...runtimeReport,
          primaryReleaseProcessIsolation: "runtime_subprocess",
          primaryReleaseProcessAttempts: attempt,
          priorAttemptEvidence: attemptEvidence,
          processTreeCleanupVerified:
            process.platform === "win32"
              ? processTreeCleanupVerified === true
              : "posix_process_group",
        };
      }

      const runtimeStatus = ["failed", "skipped", "blocked"].includes(
        runtimeReport?.status,
      )
        ? runtimeReport.status
        : "invalid";
      attemptEvidence.push({
        attempt,
        outcome: "non_release_grade_report",
        runtimeStatus,
        failureClass:
          childReport?.runtimeEvidencePacket?.records?.find(
            (record) => record?.runtime === runtimeName,
          )?.failureClass ?? "unknown_failure",
        reasonDigest: diagnosticSha256(runtimeReport?.reason ?? "missing_reason"),
        processTreeCleanupVerified:
          process.platform === "win32"
            ? processTreeCleanupVerified === true
            : "posix_process_group",
      });
    } catch (error) {
      if (
        error?.code === "META_KIM_CHILD_COMMAND_FAILED" &&
        (process.platform !== "win32" ||
          error?.processTreeCleanupVerified === true)
      ) {
        let childReport = null;
        try {
          childReport = JSON.parse(error.stdout);
        } catch {
          // A non-JSON child failure falls through to the generic safe digest below.
        }
        const runtimeReport = childReport?.[runtimeName];
        const exactRuntimeScope =
          childReport?.mode === "live" &&
          Array.isArray(childReport?.requestedRuntimes) &&
          childReport.requestedRuntimes.length === 1 &&
          childReport.requestedRuntimes[0] === runtimeName;
        if (exactRuntimeScope && runtimeReport) {
          attemptEvidence.push({
            attempt,
            outcome: "non_release_grade_child_exit",
            runtimeStatus: ["failed", "skipped", "blocked"].includes(
              runtimeReport.status,
            )
              ? runtimeReport.status
              : "invalid",
            failureClass:
              childReport?.runtimeEvidencePacket?.records?.find(
                (record) => record?.runtime === runtimeName,
              )?.failureClass ?? "unknown_failure",
            reasonDigest: diagnosticSha256(
              runtimeReport?.reason ?? "missing_reason",
            ),
            processTreeCleanupVerified:
              process.platform === "win32"
                ? true
                : "posix_process_group",
          });
          continue;
        }
      }
      const processTreeCleanupFailure =
        error?.processTreeCleanupFailure === true ||
        String(error?.code ?? "").startsWith(
          "META_KIM_WINDOWS_PROCESS_TREE_",
        ) ||
        error?.code === "META_KIM_COMMAND_TIMEOUT_CLEANUP_FAILED";
      const errorClass =
        error?.code === "META_KIM_COMMAND_TIMEOUT"
          ? "runtime_process_timeout"
          : processTreeCleanupFailure
          ? "process_tree_cleanup_failure"
          : "runtime_process_failure";
      attemptEvidence.push({
        attempt,
        outcome: "runtime_process_error",
        errorClass,
        errorDigest: diagnosticSha256(error?.message ?? error),
        ...(processTreeCleanupFailure
          ? {
              processTreeCleanupVerified: false,
              processTreeCleanupReason:
                error?.processTreeCleanupReason ?? "cleanup_unverified",
              processTreeSurvivorCount: Number.isSafeInteger(
                error?.processTreeSurvivorCount,
              )
                ? error.processTreeSurvivorCount
                : null,
            }
          : {}),
      });
      if (processTreeCleanupFailure) {
        break;
      }
    }
  }

  const lastAttempt = attemptEvidence.at(-1) ?? null;
  return {
    status: "failed",
    ok: false,
    reason: "isolated_primary_runtime_probe_failed",
    errorClass:
      lastAttempt?.errorClass ?? "runtime_report_not_release_grade",
    errorDigest: diagnosticSha256(JSON.stringify(attemptEvidence)),
    primaryReleaseProcessIsolation: "runtime_subprocess",
    primaryReleaseProcessAttempts: attemptEvidence.length,
    attemptEvidence,
    ...(lastAttempt?.processTreeCleanupVerified === false
      ? {
          processTreeCleanupVerified: false,
          processTreeCleanupReason:
            lastAttempt.processTreeCleanupReason ?? "cleanup_unverified",
          processTreeSurvivorCount: lastAttempt.processTreeSurvivorCount ?? null,
        }
      : {}),
  };
}

async function main() {
  installSignalCleanup();
  if (primaryReleaseFuse && (runtimeArg || agentArg)) {
    throw new Error(
      "--primary-release-fuse fixes runtime scope to claude,codex and forbids --runtime/--agent filters.",
    );
  }
  if (
    primaryReleaseFuse &&
    (shouldForceCodexLiveTimeoutFixture() ||
      shouldForceCodexLiveNonzeroFixture() ||
      shouldForceCodexLiveWeakNormalFixture())
  ) {
    throw new Error(
      "--primary-release-fuse forbids Codex live failure fixtures.",
    );
  }
  for (const runtimeName of selectedRuntimes) {
    if (!["claude", "codex", "openclaw", "cursor"].includes(runtimeName)) {
      throw new Error(`Unknown runtime filter: ${runtimeName}`);
    }
  }
  logProgress(
    `starting ${evalMode} evaluation for ${[...selectedRuntimes].join(", ")}`,
  );

  const allAgentIds = await loadClaudeAgentIds();
  const unknownAgentIds = [...selectedAgentIds].filter(
    (agentId) => !allAgentIds.includes(agentId),
  );
  if (unknownAgentIds.length > 0) {
    throw new Error(`Unknown agent filter(s): ${unknownAgentIds.join(", ")}`);
  }
  const agentIds = filterSelectedAgentIds(allAgentIds);
  const representativeAgentId = allAgentIds.includes("meta-prism")
    ? "meta-prism"
    : allAgentIds[0];
  const report = {
    timestamp: new Date().toISOString(),
    mode: evalMode,
    primaryReleaseFuse,
    requestedRuntimes: [...selectedRuntimes],
    requestedAgents: selectedAgentIds.size > 0 ? [...selectedAgentIds] : "all",
    claude: null,
    codex: null,
    openclaw: null,
    cursor: null,
  };

  try {
    if (isRuntimeSelected("claude")) {
      try {
        report.claude =
          evalMode === "live"
            ? await runClaudeLive(
                primaryReleaseFuse ? allAgentIds : agentIds,
                primaryReleaseFuse ? [representativeAgentId] : agentIds,
              )
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
          primaryReleaseFuse
            ? await runPrimaryReleaseRuntimeIsolated("codex")
            : evalMode === "live"
            ? await runCodexLive(
                agentIds,
                representativeAgentId,
              )
            : await runCodexSmoke(agentIds);
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

    if (isRuntimeSelected("cursor")) {
      try {
        report.cursor =
          evalMode === "live" ? await runCursorLive() : await runCursorSmoke();
      } catch (error) {
        report.cursor = {
          status: "failed",
          ok: false,
          error: error.message,
        };
      }

      logProgress(`Cursor result: ${report.cursor.status}`);
    }
  } finally {
    await cleanupActiveChildren("final sweep");
  }

  const runtimeStatuses = [
    isRuntimeSelected("claude")
      ? summarizeRuntimeReport("claude", report.claude)
      : null,
    isRuntimeSelected("codex")
      ? summarizeRuntimeReport("codex", report.codex)
      : null,
    isRuntimeSelected("openclaw")
      ? summarizeRuntimeReport("openclaw", report.openclaw)
      : null,
    isRuntimeSelected("cursor")
      ? summarizeRuntimeReport("cursor", report.cursor)
      : null,
  ].filter(Boolean);
  report.runtimeEvidencePacket = buildRuntimeEvidencePacket(
    report,
    runtimeStatuses,
  );

  report.summary = {
    passed: runtimeStatuses
      .filter((item) => item.status === "passed")
      .map((item) => item.runtime),
    skipped: runtimeStatuses
      .filter((item) => item.status === "skipped")
      .map((item) => item.runtime),
    failed: runtimeStatuses
      .filter((item) => item.status === "failed")
      .map((item) => item.runtime),
    blocked: runtimeStatuses
      .filter((item) => !["passed", "skipped", "failed"].includes(item.status))
      .map((item) => item.runtime),
    strictRuntimesRequired: requireAllRuntimes || primaryReleaseFuse,
    releaseGrade: report.runtimeEvidencePacket.summary.releaseGrade,
    failureClasses: report.runtimeEvidencePacket.failureClasses,
  };

  const overallOk =
    report.summary.failed.length === 0 &&
    report.summary.blocked.length === 0 &&
    (!requireAllRuntimes || report.summary.skipped.length === 0) &&
    (!primaryReleaseFuse ||
      (report.requestedRuntimes.length === 2 &&
        report.requestedRuntimes.includes("claude") &&
        report.requestedRuntimes.includes("codex") &&
        report.runtimeEvidencePacket.summary.releaseGrade === true));

  console.log(JSON.stringify(report, null, 2));
  if (!overallOk) {
    process.exitCode = 1;
  }
}

if (process.argv.includes("--probe-clis-only")) {
  await waitForEvaluatorStartGate();
  await probeClisOnly();
} else {
  await waitForEvaluatorStartGate();
  await main();
}
