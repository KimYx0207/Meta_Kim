#!/usr/bin/env node
/**
 * Stop hook: auto-save project task progress when session ends.
 *
 * Reads the session transcript, extracts task descriptions and context,
 * then calls mcp_memory_global.py --mode save with the detected state.
 *
 * Reads stdin for session path, extracts recent task-related messages,
 * and invokes save-progress with minimal friction.
 *
 * Always exits 0 — never blocks session stop.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ── Read stdin ONCE at top level ─────────────────────────────────────────
const STDIN_CHUNKS = [];
for await (const chunk of process.stdin) STDIN_CHUNKS.push(chunk);
const RAW_STDIN = Buffer.concat(STDIN_CHUNKS).toString("utf8").trim();
let INPUT = {};
try { INPUT = JSON.parse(RAW_STDIN || "{}"); } catch { INPUT = {}; }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_ROOT = path.resolve(__dirname, "..");
const PYTHON_HOOK_CANDIDATES = [
  path.join(HOOKS_ROOT, "mcp_memory_global.py"),
  path.join(HOOKS_ROOT, "memory-hooks", "mcp_memory_global.py"),
  path.join(__dirname, "mcp_memory_global.py"),
];
const HOOKPROMPT_BLOCK_START_PATTERNS = [
  /MANDATORY_FORMAT_INSTRUCTION/,
  /(?:^|\s)📝?\s*原始输入[:：]?/,
  /(?:^|\s)🔄?\s*优化后的理解[:：]?/,
  /(?:^|\s)✅?\s*优化后的完整提示词[:：]?/,
  /#\s*提示词优化元提示词/,
];
const HOOKPROMPT_BLOCK_END_RE = /^\s*(?:---+|<\/MANDATORY_FORMAT_INSTRUCTION>)\s*$/;
const HOOKPROMPT_INLINE_END_PATTERNS = [
  /(?:\\r?\\n|\r?\n)\s*---+\s*(?:\\r?\\n|\r?\n|$)/,
  /<\/MANDATORY_FORMAT_INSTRUCTION>/,
];

// ── Task extraction patterns ────────────────────────────────────────────────

// Patterns that indicate a completed task
const DONE_PATTERNS = [
  /\n\d+\.\s*[`"\u201c]?((?:完成|搞完|搞定|写完|改完|修完|新增|添加|删除|修复|更新)[^`"\n]{5,60})/gi,
  /\b(完成|搞定|搞完|写完|改完|修复了|新增了|添加了|删除了|更新了|commit|push)[^\n]{3,80}/gi,
  /\b(?:saved|complete|done|finished|finished|applied|written|pushed|committed)[^\n]{3,80}/gi,
  /\b(搞定|完成|done|完事)[^\n]{0,30}/gi,
];

// Patterns that indicate a current/remaining task
const REMAINING_PATTERNS = [
  /(下一步|待做|还剩|还需要|还没做|remaining|pending|todo|接下来)[^\n]{3,80}/gi,
  /(还没|还没完|未完成|进行中|in progress)[^\n]{3,80}/gi,
  /(?:再|然后|接着|继续)\s*(?:Critical|Fetch|Thinking|Execution|Review|Meta-Review|Verification|Evolution|执行|推进|处理|做)[^\n]{0,80}/gi,
];

const VISIBLE_PROGRESS_HANDOFF_RE =
  /(?:已|已经|刚才|本轮)[^\n。]{1,60}(?:完成|读完|查完|检查完|确认|验证)[^\n。]{0,60}(?:下一步|接下来|继续|还需要)/i;
const TASK_BOOKKEEPING_HANDOFF_RE =
  /(?:任务清单|任务列表|任务单|todo\s*list|task\s*list)[^\n。]{0,80}(?:再|然后|接着|继续|fetch|执行|推进|跑|做)/i;

// Patterns that indicate an unfinished handoff after visible progress.
// The assistant announced a continuation but the turn is ending — flag it for the next turn.
const HANDOFF_PATTERNS = [
  VISIBLE_PROGRESS_HANDOFF_RE,
  /我先(?![^\n。]{0,40}(?:任务清单|任务列表|任务单|todo\s*list|task\s*list))[^\n。]{1,30}(?:再|然后|继续|接着)/i,
  /(?:接下来|下一步|再|然后|接着|继续)\s*(?:fetch|执行|推进|跑|做)/i,
];

// Patterns that describe what was just done
const TASK_PATTERNS = [
  /[*-]\s+(.{10,80})/g,  // bullet points
  /`([^`]{5,80})`/g,      // inline code (file paths, commands)
  /#\s+(.{5,60})/g,       // headings
];

// ── Helpers ──────────────────────────────────────────────────────────────

async function readTranscriptLines(transcriptPath, maxLines = 400) {
  try {
    const fd = await fs.open(transcriptPath, "r");
    const buf = [];
    for await (const line of fd.readLines()) {
      buf.push(line);
      if (buf.length > maxLines) buf.shift();
    }
    fd.close();
    return buf;
  } catch {
    return [];
  }
}

function stripHookPromptDisplayBlocks(text) {
  if (!text) return "";
  const kept = [];
  let droppingHookPromptBlock = false;

  for (const line of text.split(/\r?\n/)) {
    const hookPromptStart = firstHookPromptStartIndex(line);
    if (!droppingHookPromptBlock && hookPromptStart >= 0) {
      if (
        isStructuredTranscriptLine(line) ||
        hasInlineHookPromptEnd(line, hookPromptStart) ||
        hookPromptStart > 0
      ) {
        const stripped = stripHookPromptSegmentsFromLine(line);
        if (stripped.trim().length > 0) kept.push(stripped);
        continue;
      }
      droppingHookPromptBlock = true;
      continue;
    }

    if (droppingHookPromptBlock) {
      if (HOOKPROMPT_BLOCK_END_RE.test(line)) {
        droppingHookPromptBlock = false;
      }
      continue;
    }

    kept.push(line);
  }

  return kept.join("\n");
}

function firstHookPromptStartIndex(line) {
  let first = -1;
  for (const pattern of HOOKPROMPT_BLOCK_START_PATTERNS) {
    const index = line.search(pattern);
    if (index >= 0 && (first === -1 || index < first)) first = index;
  }
  return first;
}

function isStructuredTranscriptLine(line) {
  const trimmed = line.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[") || line.includes("\\n");
}

function hasInlineHookPromptEnd(line, startIndex) {
  return inlineHookPromptEndIndex(line, startIndex) < line.length;
}

function inlineHookPromptEndIndex(line, startIndex) {
  const tail = line.slice(startIndex);
  let best = null;
  for (const pattern of HOOKPROMPT_INLINE_END_PATTERNS) {
    const match = pattern.exec(tail);
    if (!match) continue;
    const end = startIndex + match.index + match[0].length;
    if (best === null || end < best) best = end;
  }
  return best ?? line.length;
}

function stripHookPromptSegmentsFromLine(line) {
  let output = line;
  for (let guard = 0; guard < 10; guard += 1) {
    const start = firstHookPromptStartIndex(output);
    if (start < 0) break;
    const end = inlineHookPromptEndIndex(output, start);
    output = `${output.slice(0, start).trimEnd()} ${output.slice(end).trimStart()}`.trim();
  }
  return output;
}

function extractUniqueItems(lines, patterns, maxItems = 5) {
  const seen = new Set();
  const items = [];

  for (const line of lines) {
    for (const pattern of patterns) {
      let match;
      const regex = new RegExp(pattern.source, pattern.flags);
      while ((match = regex.exec(line)) !== null) {
        const text = match[1] || match[0];
        const clean = text.trim().slice(0, 80);
        if (clean.length > 5 && !seen.has(clean)) {
          seen.add(clean);
          items.push(clean);
          if (items.length >= maxItems) return items;
        }
      }
    }
  }
  return items;
}

function extractCurrentTask(lines) {
  // Look for the most recent task description in user messages
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Look for task-related lines in user/assistant turns
    if (/[做|干|搞|写|修|改|完|完成|开始]/.test(line) && line.length < 120) {
      const clean = line.trim().slice(0, 100);
      if (clean.length > 5) return clean;
    }
  }
  return "";
}

async function pathExists(candidate) {
  return fs.stat(candidate).then(() => true).catch(() => false);
}

async function resolvePythonHook() {
  for (const candidate of PYTHON_HOOK_CANDIDATES) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

function runPythonSave(args) {
  return resolvePythonHook().then((pythonHook) => new Promise((resolve) => {
    if (!pythonHook) {
      resolve({ code: 0, stdout: "", stderr: "memory helper missing", skipped: true });
      return;
    }
    const proc = spawn("python3", [pythonHook, ...args], {
      cwd: process.cwd(),
      timeout: 8000,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    proc.on("error", () => {
      resolve({ code: -1, stdout: "", stderr: "spawn error" });
    });
  }));
}

async function isLikelyProjectRoot(projectRoot) {
  const markers = [
    ".git",
    "AGENTS.md",
    "CLAUDE.md",
    "package.json",
    ".codex",
    ".cursor",
    "openclaw",
    ".meta-kim",
  ];
  for (const marker of markers) {
    if (await pathExists(path.join(projectRoot, marker))) return true;
  }
  return false;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const transcriptPath = INPUT.transcript_path || INPUT.transcriptPath || "";

  if (!transcriptPath) {
    // No transcript path — can't extract tasks, skip silently
    console.error("stop-save-progress: no transcript path in stdin");
    process.exit(0);
    return;
  }

  const lines = await readTranscriptLines(transcriptPath, 400);
  if (lines.length < 5) {
    process.exit(0);
    return;
  }

  const rawText = lines.join("\n");
  const text = stripHookPromptDisplayBlocks(rawText);
  const effectiveLines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (effectiveLines.length < 5) {
    process.exit(0);
    return;
  }
  const taskBookkeepingOnlyHandoff =
    TASK_BOOKKEEPING_HANDOFF_RE.test(text) && !VISIBLE_PROGRESS_HANDOFF_RE.test(text);
  const handoffMatched =
    !taskBookkeepingOnlyHandoff && HANDOFF_PATTERNS.some((re) => re.test(text));

  // Only save if there's meaningful work done
  const hasMeaningfulContent = (
    text.includes("完成") || text.includes("搞定") ||
    text.includes("commit") || text.includes("push") ||
    text.includes("写") || text.includes("改") ||
    text.includes("fix") || text.includes("add") ||
    text.includes("save-progress") ||
    text.includes("进度") ||
    text.includes("继续") ||
    handoffMatched
  );

  if (!hasMeaningfulContent) {
    // Session was too short or trivial — skip
    process.exit(0);
    return;
  }

  // Extract tasks
  const completed = extractUniqueItems(effectiveLines, DONE_PATTERNS, 5);
  const remaining = extractUniqueItems(effectiveLines, REMAINING_PATTERNS, 3);
  const currentTask = extractCurrentTask(effectiveLines);
  if (handoffMatched && remaining.length === 0) {
    remaining.push(currentTask || "continuation handoff detected");
  }

  if (completed.length === 0 && remaining.length === 0 && !handoffMatched) {
    // Nothing extractable — skip silently
    process.exit(0);
    return;
  }

  // Build python args
  const args = ["--mode", "save"];
  if (currentTask) args.push("--task", currentTask);
  for (const item of completed) args.push("--done", item);
  for (const item of remaining) args.push("--remaining", item);
  args.push("--note", `auto-save from Stop hook, ${effectiveLines.length} transcript lines`);

  const result = await runPythonSave(args);

  if (result.skipped) {
    console.error("stop-save-progress: memory helper missing, continuation check still ran");
  } else if (result.code === 0) {
    // Success — result.stdout has the JSON
    console.error(`stop-save-progress: saved ${completed.length} done, ${remaining.length} remaining`);
  } else {
    console.error(`stop-save-progress: failed (${result.code}): ${result.stderr}`);
  }

  // ── Continuation handoff flag ────────────────────────────────────────
  // If the assistant announced an unfinished handoff after visible progress
  // and there are remaining tasks, write a continuationRequired flag into the
  // project's .claude/project-task-state.json so the next turn can auto-resume.
  // Scoped to cwd: when the hook runs outside a project, this is a no-op.
  try {
    if (handoffMatched && remaining.length > 0) {
      const projectRoot = process.cwd();
      const claudeDir = path.join(projectRoot, ".claude");
      const statePath = path.join(claudeDir, "project-task-state.json");
      if (await isLikelyProjectRoot(projectRoot)) {
        await fs.mkdir(claudeDir, { recursive: true });
        let prev = {};
        try {
          const raw = await fs.readFile(statePath, "utf8");
          prev = JSON.parse(raw);
        } catch {
          prev = {};
        }
        prev.meta_kim = true;
        prev.continuationRequired = true;
        prev.continuationAuthority = "local_continuity_only";
        prev.mustNotClaimActiveRun = true;
        prev.continuationHandoff = {
          matched: true,
          ts: new Date().toISOString(),
          source: "stop-save-progress",
          remainingCount: remaining.length,
          currentTask: currentTask || null,
          authority: "local_continuity_only",
          mustNotClaimActiveRun: true,
        };
        prev.updated_at = new Date().toISOString();
        await fs.writeFile(statePath, JSON.stringify(prev, null, 2), "utf8");
        console.error(
          `stop-save-progress: continuationRequired=true (${remaining.length} remaining, cwd=${projectRoot})`
        );
      }
    }
  } catch (err) {
    console.error(`stop-save-progress: continuation flag skipped: ${err.message}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(`stop-save-progress: ${err.message}`);
  process.exit(0);
});
