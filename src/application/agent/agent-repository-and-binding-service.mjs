/**
 * Read-only repository facts & bidirectional external Agent session discovery/binding.
 *
 * Security & privacy invariants:
 * - Operates ONLY on already-enrolled `projectRoot` paths resolved by the server's
 *   trusted `hubCatalog` or startup `projectRoot` — never raw client path strings.
 * - Uses shell-free `execFileSync` with bounded timeout and `windowsHide: true`.
 * - Scrubs credentials, URLs, and raw OS home/drive paths before returning JSON.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildProjectRef,
  listLiveNativeCodexBindings,
  listLiveNativeZcodeBindings,
  registerLiveNativeCodexBinding,
  registerLiveNativeZcodeBinding,
} from "../../../scripts/project-registry.mjs";

export const AGENT_REPOSITORY_FACTS_SCHEMA = "meta-kim-agent-repository-facts-v1";
export const AGENT_BINDINGS_SCHEMA = "meta-kim-agent-bindings-v1";

const UUID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const ZCODE_SESS_RE = /^sess_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const ZCODE_TURN_RE = /^turn_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;

function scrubPublic(value, maxLen = 200) {
  if (typeof value !== "string") return "";
  const cleaned = value
    .replace(/\b(?:sk-(?:ant|proj|live|test)-|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{6,}/giu, "[已脱敏]")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\)[^\s<>"'`]+/gu, "[本地路径]")
    .replace(/\/(?:home|Users|workspace|tmp|etc|var|mnt|opt)\/[^\s<>"'`]+/gu, "[本地路径]")
    .replace(/\bhttps?:\/\/[^\s<>)"'`]+/giu, "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1).trim()}…` : cleaned;
}

function runGitSafe(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 1_500,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function detectRepoHooks(rootReal) {
  const hooks = [];
  if (existsSync(path.join(rootReal, ".claude/hooks")) || existsSync(path.join(rootReal, ".claude/settings.json"))) {
    hooks.push({ id: "claude", label: "Claude Code", autoSync: existsSync(path.join(rootReal, ".claude/hooks")) });
  }
  if (existsSync(path.join(rootReal, ".codex/hooks.json")) || existsSync(path.join(rootReal, ".codex/agents"))) {
    hooks.push({ id: "codex", label: "Codex CLI", autoSync: existsSync(path.join(rootReal, ".codex/hooks.json")) });
  }
  if (existsSync(path.join(rootReal, ".cursor/hooks.json")) || existsSync(path.join(rootReal, ".cursor/agents"))) {
    hooks.push({ id: "cursor", label: "Cursor", autoSync: existsSync(path.join(rootReal, ".cursor/hooks.json")) });
  }
  if (existsSync(path.join(rootReal, ".gemini/settings.json")) || existsSync(path.join(rootReal, ".gemini/hooks"))) {
    hooks.push({ id: "gemini", label: "Gemini CLI", autoSync: existsSync(path.join(rootReal, ".gemini/hooks")) });
  }
  if (existsSync(path.join(rootReal, ".zcode/config.json")) || existsSync(path.join(rootReal, ".zcode/agents"))) {
    hooks.push({ id: "zcode", label: "ZCode", autoSync: false });
  }
  return hooks;
}

export function inspectRepositoryFacts({ projectRoot, startupProjectRoot = null } = {}) {
  if (typeof projectRoot !== "string" || !projectRoot.trim()) return null;
  let rootReal;
  try {
    rootReal = realpathSync(projectRoot);
  } catch {
    return null;
  }
  let startupReal = null;
  if (typeof startupProjectRoot === "string" && startupProjectRoot.trim()) {
    try { startupReal = realpathSync(startupProjectRoot); } catch { startupReal = null; }
  }

  const hasGit = existsSync(path.join(rootReal, ".git"));
  const branch = hasGit ? scrubPublic(runGitSafe(rootReal, ["rev-parse", "--abbrev-ref", "HEAD"]), 80) : "";
  const headRaw = hasGit ? runGitSafe(rootReal, ["log", "-1", "--pretty=format:%h · %s (%cr)"]) : "";
  const headCommit = scrubPublic(headRaw, 160);
  const statusRaw = hasGit ? runGitSafe(rootReal, ["status", "--porcelain"]) : "";
  let stagedCount = 0;
  let modifiedCount = 0;
  let untrackedCount = 0;
  if (statusRaw) {
    for (const line of statusRaw.split(/\r?\n/u)) {
      if (!line) continue;
      const xy = line.slice(0, 2);
      if (xy === "??") untrackedCount += 1;
      else {
        if (xy[0] && xy[0] !== " ") stagedCount += 1;
        if (xy[1] && xy[1] !== " ") modifiedCount += 1;
      }
    }
  }
  const totalChanges = stagedCount + modifiedCount + untrackedCount;
  const hooks = detectRepoHooks(rootReal);
  const manifests = ["package.json", "Cargo.toml", "pyproject.toml", "go.mod", "AGENTS.md", "CLAUDE.md", "README.md"]
    .filter((f) => existsSync(path.join(rootReal, f)));

  return {
    schemaVersion: AGENT_REPOSITORY_FACTS_SCHEMA,
    projectId: buildProjectRef({ repoPath: rootReal }),
    projectName: scrubPublic(path.basename(rootReal) || "Repository", 80),
    isExecutionBoundRepo: Boolean(startupReal && startupReal.toLowerCase() === rootReal.toLowerCase()),
    hasGit,
    branch: branch || null,
    headCommit: headCommit || null,
    worktree: {
      state: !hasGit ? "no_git" : totalChanges === 0 ? "clean" : "dirty",
      totalChanges,
      stagedCount,
      modifiedCount,
      untrackedCount,
    },
    manifests,
    enrolledRuntimes: hooks,
  };
}

function normalizePathCompare(p) {
  return path.resolve(String(p || "")).replace(/\\/gu, "/").toLowerCase();
}

function scanRecentCodexSessionsForRepo(rootReal, homeDir) {
  const sessionsRoot = path.join(homeDir, ".codex", "sessions");
  if (!existsSync(sessionsRoot)) return [];
  const targetNorm = normalizePathCompare(rootReal);
  const found = [];
  try {
    const years = readdirSync(sessionsRoot).sort().reverse().slice(0, 2);
    for (const y of years) {
      const yDir = path.join(sessionsRoot, y);
      if (!lstatSync(yDir).isDirectory()) continue;
      const months = readdirSync(yDir).sort().reverse().slice(0, 3);
      for (const m of months) {
        const mDir = path.join(yDir, m);
        if (!lstatSync(mDir).isDirectory()) continue;
        const days = readdirSync(mDir).sort().reverse().slice(0, 7);
        for (const d of days) {
          const dDir = path.join(mDir, d);
          if (!lstatSync(dDir).isDirectory()) continue;
          const files = readdirSync(dDir).filter((f) => f.endsWith(".jsonl")).sort().reverse().slice(0, 12);
          for (const file of files) {
            if (found.length >= 8) return found;
            const fullPath = path.join(dDir, file);
            const stat = lstatSync(fullPath);
            if (!stat.isFile() || stat.isSymbolicLink()) continue;
            const head = readFileSync(fullPath).subarray(0, 24 * 1024).toString("utf8");
            const lines = head.split(/\r?\n/u).filter(Boolean);
            let threadId = null;
            let cwdMatch = false;
            let turnId = null;
            let title = "";
            for (const line of lines.slice(0, 20)) {
              try {
                const obj = JSON.parse(line);
                if (obj.type === "session_meta" && obj.payload) {
                  if (normalizePathCompare(obj.payload.cwd || "") === targetNorm) {
                    cwdMatch = true;
                    threadId = obj.payload.id || null;
                  } else {
                    break;
                  }
                }
                if (cwdMatch && !turnId && UUID_RE.test(obj?.payload?.turn_id || "")) {
                  turnId = obj.payload.turn_id.toLowerCase();
                }
                if (cwdMatch && !title && obj?.type === "response_item" && obj?.payload?.role === "user") {
                  const textPart = Array.isArray(obj.payload.content)
                    ? obj.payload.content.find((c) => typeof c?.text === "string" && !c.text.startsWith("<"))?.text
                    : "";
                  if (textPart) title = scrubPublic(textPart, 90);
                }
              } catch { /* ignore partial line */ }
            }
            if (cwdMatch && UUID_RE.test(threadId || "")) {
              found.push({
                runtime: "codex",
                runtimeLabel: "Codex CLI",
                sessionId: threadId.toLowerCase(),
                turnId,
                title: title || `Codex 会话 ${threadId.slice(0, 8)}`,
                updatedAt: stat.mtime.toISOString(),
                bindable: Boolean(turnId),
              });
            }
          }
        }
      }
    }
  } catch {
    return found;
  }
  return found;
}

function scanRecentClaudeSessionsForRepo(rootReal, homeDir) {
  const projectsDir = path.join(homeDir, ".claude", "projects");
  if (!existsSync(projectsDir)) return [];
  // Claude Code encodes `D:\KimProject\Meta_Kim` as `D--KimProject-Meta-Kim` or similar
  const encodedGuess = rootReal.replace(/[:\\/]/gu, "-");
  const found = [];
  try {
    const dirs = readdirSync(projectsDir).filter((name) =>
      name.toLowerCase() === encodedGuess.toLowerCase()
      || name.toLowerCase() === encodedGuess.replace(/_/gu, "-").toLowerCase());
    for (const dirName of dirs.slice(0, 2)) {
      const fullDir = path.join(projectsDir, dirName);
      if (!lstatSync(fullDir).isDirectory()) continue;
      const files = readdirSync(fullDir)
        .filter((f) => f.endsWith(".jsonl") && UUID_RE.test(f.replace(/\.jsonl$/iu, "")))
        .map((f) => ({ name: f, full: path.join(fullDir, f), stat: lstatSync(path.join(fullDir, f)) }))
        .filter((item) => item.stat.isFile() && !item.stat.isSymbolicLink())
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
        .slice(0, 8);
      for (const item of files) {
        const sessionId = item.name.replace(/\.jsonl$/iu, "").toLowerCase();
        const head = readFileSync(item.full).subarray(0, 16 * 1024).toString("utf8");
        let title = "";
        let branch = "";
        for (const line of head.split(/\r?\n/u).slice(0, 16)) {
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            if (!branch && typeof obj.gitBranch === "string") branch = scrubPublic(obj.gitBranch, 48);
            if (!title && obj.type === "user" && obj.message) {
              const rawMsg = typeof obj.message.content === "string"
                ? obj.message.content
                : Array.isArray(obj.message.content)
                  ? obj.message.content.find((c) => typeof c?.text === "string")?.text || ""
                  : "";
              if (rawMsg && !rawMsg.startsWith("<")) title = scrubPublic(rawMsg, 90);
            }
          } catch { /* ignore partial */ }
        }
        found.push({
          runtime: "claude",
          runtimeLabel: "Claude Code",
          sessionId,
          turnId: null,
          branch: branch || null,
          title: title || `Claude Code 会话 ${sessionId.slice(0, 8)}`,
          updatedAt: item.stat.mtime.toISOString(),
          bindable: false,
          autoHookManaged: true,
        });
      }
    }
  } catch {
    return found;
  }
  return found;
}

export async function discoverBidirectionalAgentSessions({
  projectRoot,
  homeDir = os.homedir(),
  profile = "default",
} = {}) {
  if (typeof projectRoot !== "string" || !projectRoot.trim()) return null;
  let rootReal;
  try {
    rootReal = realpathSync(projectRoot);
  } catch {
    return null;
  }
  const projectRef = buildProjectRef({ repoPath: rootReal });
  const [codexBound, zcodeBound] = await Promise.all([
    listLiveNativeCodexBindings({ homeDir, profile, projectRef }).catch(() => []),
    listLiveNativeZcodeBindings({ homeDir, profile, projectRef }).catch(() => []),
  ]);
  const codexBoundIds = new Set(codexBound.map((b) => `${b.threadId}:${b.turnId || ""}`.toLowerCase()));
  const codexDiscovered = scanRecentCodexSessionsForRepo(rootReal, homeDir).map((s) => ({
    ...s,
    alreadyBound: codexBoundIds.has(`${s.sessionId}:${s.turnId || ""}`),
    runId: s.turnId ? `native-codex-${s.sessionId}-${s.turnId}` : null,
  }));
  const claudeDiscovered = scanRecentClaudeSessionsForRepo(rootReal, homeDir);
  const hooks = detectRepoHooks(rootReal);

  return {
    schemaVersion: AGENT_BINDINGS_SCHEMA,
    projectId: projectRef,
    projectName: scrubPublic(path.basename(rootReal) || "Project", 80),
    bidirectionalModes: {
      forwardCallFromApp: true,
      reverseAttachFromExternalAgent: true,
    },
    enrolledRuntimes: hooks,
    boundCount: codexBound.length + zcodeBound.length,
    externalSessions: [...codexDiscovered, ...claudeDiscovered]
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .slice(0, 12),
    reverseAttachGuide: [
      "在 Claude Code / Codex / Cursor 中进入该仓库直接对话：已投影的 Meta_Kim Hook 会自动将运行与 Subagent 状态同步到本控制台",
      "若外部 Codex 会话尚未自动挂载，可在下方列表点击「接入实时观测」一键绑定到当前视图",
    ],
  };
}

export async function bindExternalAgentSession({
  projectRoot,
  homeDir = os.homedir(),
  profile = "default",
  runtime,
  sessionId,
  turnId,
} = {}) {
  if (typeof projectRoot !== "string" || !projectRoot.trim()) {
    return { status: "blocked", reason: "invalid_project" };
  }
  let rootReal;
  try {
    rootReal = realpathSync(projectRoot);
  } catch {
    return { status: "blocked", reason: "project_not_found" };
  }
  if (runtime === "codex") {
    if (!UUID_RE.test(sessionId || "") || !UUID_RE.test(turnId || "")) {
      return { status: "blocked", reason: "invalid_codex_identifiers" };
    }
    const cleanThread = sessionId.toLowerCase();
    const cleanTurn = turnId.toLowerCase();
    await registerLiveNativeCodexBinding({
      homeDir,
      profile,
      projectRoot: rootReal,
      threadId: cleanThread,
      turnId: cleanTurn,
    });
    return {
      status: "bound",
      runtime: "codex",
      projectId: buildProjectRef({ repoPath: rootReal }),
      runId: `native-codex-${cleanThread}-${cleanTurn}`,
    };
  }
  if (runtime === "zcode") {
    if (!ZCODE_SESS_RE.test(sessionId || "") || !ZCODE_TURN_RE.test(turnId || "")) {
      return { status: "blocked", reason: "invalid_zcode_identifiers" };
    }
    await registerLiveNativeZcodeBinding({
      homeDir,
      profile,
      projectRoot: rootReal,
      sessionId,
      turnId,
    });
    return {
      status: "bound",
      runtime: "zcode",
      projectId: buildProjectRef({ repoPath: rootReal }),
      runId: `native-zcode-${sessionId}-${turnId}`,
    };
  }
  return { status: "blocked", reason: "unsupported_binding_runtime" };
}
