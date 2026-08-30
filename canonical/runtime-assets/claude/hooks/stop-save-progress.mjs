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

import { spawn, spawnSync } from "node:child_process";
import { existsSync, promises as fs, readdirSync } from "node:fs";
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
//
// D7: the keyword groups below must stay NON-capturing. `extractUniqueItems` stores
// `match[1] || match[0]`, so a group wrapping only the trigger word throws the
// `[^\n]{3,80}` context away and files the trigger word by itself as a task.
// Measured over 791 transcripts on the pre-D7 hook: 159 of 429 `--done` items (37%)
// were a bare `commit`, and 67 of 163 `--remaining` items (41%) were a bare
// `remaining` / `pending`. The defect hides in Chinese sessions because every Chinese
// keyword here is ≤3 characters and is silently dropped by the `clean.length > 5`
// gate — only `commit` (6), `pending` (7), `remaining` (9) and `in progress` (11)
// clear it. The first pattern keeps its group on purpose: there the group spans
// keyword *and* context, and exists to strip the leading `1. "` list decoration.
const DONE_PATTERNS = [
  /\n\d+\.\s*[`"\u201c]?((?:完成|搞完|搞定|写完|改完|修完|新增|添加|删除|修复|更新)[^`"\n]{5,60})/gi,
  /\b(?:完成|搞定|搞完|写完|改完|修复了|新增了|添加了|删除了|更新了|commit|push)[^\n]{3,80}/gi,
  /\b(?:saved|complete|done|finished|finished|applied|written|pushed|committed)[^\n]{3,80}/gi,
  // Lower bound raised from 0: now that a bare keyword is no longer discarded by the
  // `clean.length > 5` gate, `{0,30}` would store a context-free "完事" at end of line.
  /\b(?:搞定|完成|done|完事)[^\n]{6,30}/gi,
];

// Patterns that indicate a current/remaining task
const REMAINING_PATTERNS = [
  /(?:下一步|待做|还剩|还需要|还没做|remaining|pending|todo|接下来)[^\n]{3,80}/gi,
  /(?:还没|还没完|未完成|进行中|in progress)[^\n]{3,80}/gi,
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

// Injected context wrappers are not speech — they are the harness talking to the
// model, and their contents ("完成", "commit", file paths) trip every task regex.
const INJECTED_CONTEXT_TAGS =
  "system-reminder|task-notification|command-name|command-message|command-args|local-command-stdout";
const INJECTED_CONTEXT_RE = new RegExp(`<(${INJECTED_CONTEXT_TAGS})>[\\s\\S]*?</\\1>`, "g");
// When one of these blocks is quoted inside a larger payload it arrives truncated:
// a sampled summariser prompt carried 2 opening `<task-notification>` tags and 0
// closing ones, so the paired pattern above matched nothing and the notification
// body survived as a "completed task". Drop the unclosed opening — but only as far
// as the paragraph break. The old `[\s\S]*$` ate everything after the tag, so a prose
// line that merely *mentions* `<task-notification>` cost 1199 of 1525 characters (79%)
// of real speech. `(?:^|\n)` requires the tag to open a line, which is what keeps an
// inline backticked mention from matching; the `g` flag is required because `$` here
// means end-of-string (with `m` it would mean end-of-line and stop after one line).
const INJECTED_CONTEXT_OPEN_RE = new RegExp(
  `(?:^|\\n)<(?:${INJECTED_CONTEXT_TAGS})>[\\s\\S]*?(?=\\n\\n|$)`,
  "g",
);

// Claude Code asks for session summaries through a user turn that embeds the whole
// prior conversation. Counting it makes every summarised session re-save the previous
// session's work, so memory echoes forever — but the old `**User:** && **Claude:**`
// heuristic scored 2/3 precision: any post-mortem *about* transcript format carries
// both markers and was deleted whole. Measured over 783 transcripts, the real prompt
// opens its block — 55 hits at offset 0 and 2 at offset 21 (behind a `📝 原始输入`
// display header); the only deeper hits were prose discussing the phrase (offsets
// 2571 / 3455). So: same phrase as SUMMARISER_PROMPT_RE but no `^` anchor — a harness
// prefix defeats an anchor and the echo bug returns — bounded to an opening window.
const SUMMARISER_PROMPT_PHRASE = "below is a conversation log from a claude code";
const SUMMARISER_PROMPT_WINDOW = 200;

function isSummariserPromptBlock(text) {
  // indexOf over the whole text, not a regex against `text.slice(0, N)`: a phrase
  // starting at N-10 would be cut in half by the slice and silently stop matching.
  const index = text.toLowerCase().indexOf(SUMMARISER_PROMPT_PHRASE);
  return index >= 0 && index < SUMMARISER_PROMPT_WINDOW;
}

// Session triggers, acknowledgements, and the summariser's own prompt header say
// nothing about what the session was for.
const TRIVIAL_PROMPTS = new Set([
  "开工", "收工", "继续", "好", "好的", "是", "对", "行", "可以", "嗯",
  "ok", "okay", "yes", "y", "continue", "go", "next",
]);

// Client harnesses inject bracketed headers into the prompt *text itself*, so the
// wrapper arrives as the user's own words. Unlike `<system-reminder>` — an XML block
// `stripInjectedContext` already handles — these carry no closing tag, so nothing
// upstream of here removes them. Measured over 10778 `last-prompt` entries across 432
// transcripts in one operator's ~/.claude/projects: 1589 (14.7%) open with `[`, in
// seven shapes — a Chinese mobile-client notice 828, [UI_ACTION_TRIGGER] 360,
// [From Orca Lead] 292, [From Orca Worker] 72, a Chinese plan-reconciliation header 11,
// [Image #N] 16, [Session context rebuild …] 10.
// Claude Code truncates `lastPrompt` to ~200 characters when writing the transcript,
// and the first four headers exceed that on their own. In the session that prompted
// this fix all 14 entries were the mobile-client boilerplate carrying **zero**
// characters of the actual request: the wrapper does not merely pollute
// `current_task`, it replaces it.
//
// Two shapes need two treatments. A WRAPPER is prose addressed to the model, with the
// user's message after a separator; drop it and keep whatever follows. A LABEL is just
// a marker and the real message starts immediately after it; drop the marker only.
const WRAPPER_PROMPT_PREFIXES = [
  "[客户端说明]",
  "[UI_ACTION_TRIGGER]",
  "[计划对账]",
  "[Session context rebuild",
];
// The plan-reconciliation header ends with its own end-of-notice line (half-width comma
// in the real data); a blank line is the general case. Requiring an *explicit* separator
// is what makes truncation safe: at ~200 chars the wrapper has swallowed the separator
// too, so no body is found and the entry is dropped instead of being filed as the goal.
const WRAPPER_BODY_SEPARATOR_RE = /==\s*对账说明结束[^=]*==|\n\s*\n/;
const LABEL_PROMPT_PREFIX_RE = /^\[(?:Image #\d+|From Orca (?:Lead|Worker))\]\s*/;

// Returns the user's actual words, or "" when the prompt is nothing but harness wrapper.
function stripHarnessPromptPrefix(prompt) {
  const text = prompt.trim();
  if (!text.startsWith("[")) return text;
  const labelStripped = text.replace(LABEL_PROMPT_PREFIX_RE, "");
  if (labelStripped !== text) return labelStripped.trim();
  if (!WRAPPER_PROMPT_PREFIXES.some((p) => text.startsWith(p))) return text;
  const match = WRAPPER_BODY_SEPARATOR_RE.exec(text);
  if (!match) return "";
  return text.slice(match.index + match[0].length).trim();
}

// A session's goal is neither "the first prompt" nor "the last one". Measured over
// 783 transcripts: `--continue` / `/resume` append to the *same* JSONL under the same
// sessionId (0 of 777 files carried a second one), so the first substantive prompt can
// be days old — median 1.25h stale, max 312.9h. But the latest substantive prompt is a
// contentless acknowledgement 33.6% of the time ("按照你的建议来", "额度已恢复 继续",
// "你都帮我搞定吧"), and in those sessions the first prompt held the actual goal.
// D5 ("`firstPrompt` scans the whole file, so `current_task` is median 13.6h stale") was
// investigated over 783 transcripts and **rejected as a fix target** — the measurements
// are in NOTES.md 2026-08-11. Three alternatives to "earliest substantive prompt" were
// run end to end; none dominates, and hand-checks contradict the metric ranking:
//   newest goal-length : staleness 1.25h→0.16h, but displaced the real goal with a
//                        mid-session follow-up in 3 of 5 hand-checked sessions
//   newest substantive : staleness 0.08h, trivial tasks 46→52 (the ack-phrase trap:
//                        33.6% of latest prompts are "按照你的建议来"-shaped)
//   earliest goal-length: trivial 46→45 but noise 11→14
// Staleness was only ever a proxy — a 12-hour-old opening line of a resumed session
// still describes that session, so most of the measured "staleness" is not a defect.
// Keep the earliest substantive prompt until there is a signal better than length.
function pickGoalPrompt(prompts) {
  return prompts[0] || "";
}

function isSubstantivePrompt(prompt) {
  // Strip first, then judge. A wrapper defeats every gate below it: a 200-character
  // client notice ending in "开工" clears `length > 6`, and it is not the literal string
  // "开工" so `TRIVIAL_PROMPTS` misses it — the wrapper smuggles a trivial prompt through
  // as a session goal. Stripping restores the bare trigger word the set was written for.
  const spoken = stripHarnessPromptPrefix(prompt);
  if (spoken.length <= 6) return false;
  if (TRIVIAL_PROMPTS.has(spoken.toLowerCase())) return false;
  return !isSummariserPromptBlock(spoken);
}

function stripInjectedContext(text) {
  return text.replace(INJECTED_CONTEXT_RE, " ").replace(INJECTED_CONTEXT_OPEN_RE, " ").trim();
}

// Only `text` blocks are speech. `thinking` is excluded deliberately, not just as
// noise reduction: HANDOFF_PATTERNS mean "the assistant *announced* a continuation",
// and un-announced plans living in thinking would manufacture phantom handoffs.
// `tool_use` / `tool_result` are where the JS source fragments came from.
function spokenTextBlocks(entry) {
  const content = entry?.message?.content;
  if (typeof content === "string") {
    return content.trim() ? [content] : [];
  }
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type !== "text") continue;
    if (typeof block.text !== "string" || !block.text.trim()) continue;
    out.push(block.text);
  }
  return out;
}

// The transcript is JSONL, and real prose is heavily outnumbered: in a sampled
// session 989 of 1377 entries were `attachment` and only 46 were spoken text.
// Scanning the raw lines meant the task regexes matched JSON payloads instead of
// what was said. Parse first, keep only speech, and cap on *text blocks* — capping
// raw lines would spend the whole window on attachments and silently starve the
// extractor while looking clean.
async function readConversationBlocks(transcriptPath, maxBlocks = 60, maxUserBlocks = 200) {
  const blocks = [];
  // User speech is collected separately and never enters the `blocks` window: inside a
  // 60-block window the median user-block count is 2 and 30% of sessions have none, so
  // `taskFromUser` was a dead branch that returned "" on every measured transcript.
  const userBlocks = [];
  const substantivePrompts = [];
  let lastPrompt = "";
  let fd = null;
  try {
    fd = await fs.open(transcriptPath, "r");
    for await (const line of fd.readLines()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        // Older Claude fixtures and partially written transcripts can contain plain
        // text lines. Preserve the historical extractor behavior for those lines.
        const text = stripInjectedContext(trimmed);
        if (text) {
          blocks.push({ role: "unknown", text });
          if (blocks.length > maxBlocks) blocks.shift();
          userBlocks.push({ role: "unknown", text });
          if (userBlocks.length > maxUserBlocks) userBlocks.shift();
        }
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      // Every user prompt is recorded as its own `last-prompt` entry, so the first
      // substantive one is the session's stated goal in the user's own words — a far
      // better `current_task` than any line the extractor can guess from prose, where
      // the head is a greeting and the tail is a sign-off.
      if (entry.type === "last-prompt") {
        if (typeof entry.lastPrompt === "string" && entry.lastPrompt.trim()) {
          lastPrompt = entry.lastPrompt.trim();
          // Push the stripped form, not the raw one: judging on the user's words but
          // storing the wrapper would file the boilerplate as `current_task` anyway.
          const spoken = stripHarnessPromptPrefix(lastPrompt);
          if (isSubstantivePrompt(spoken)) substantivePrompts.push(spoken);
        }
        continue;
      }
      if (entry.type !== "assistant" && entry.type !== "user") continue;
      // Session summaries and other injected turns describe *previous* work; counting
      // them would make each resumed session re-save the last one's completed list.
      if (entry.isMeta === true) continue;
      for (const raw of spokenTextBlocks(entry)) {
        const text = stripInjectedContext(raw);
        if (!text) continue;
        // After stripping, not before: an injected wrapper sitting ahead of the
        // summariser prompt would otherwise push the phrase past the opening window.
        if (isSummariserPromptBlock(text)) continue;
        blocks.push({ role: entry.type, text });
        if (blocks.length > maxBlocks) blocks.shift();
        if (entry.type === "user") {
          userBlocks.push({ role: "user", text });
          if (userBlocks.length > maxUserBlocks) userBlocks.shift();
        }
      }
    }
  } catch {
    return { blocks: [], userBlocks: [], lastPrompt: "", goalPrompt: "" };
  } finally {
    // D9: always close the descriptor, including read/iteration failures.
    await fd?.close().catch(() => {});
  }
  return { blocks, userBlocks, lastPrompt, goalPrompt: pickGoalPrompt(substantivePrompts) };
}

function proseLines(blocks) {
  const text = stripHookPromptDisplayBlocks(blocks.map((b) => b.text).join("\n"));
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0);
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

// The transcript is raw JSONL — tool results and hook payloads live on the same
// lines the task regexes scan, so a match can be a slice of JSON rather than prose.
const JSON_NOISE_MARKERS = [
  "hookName",
  "toolUseID",
  "stop_reason",
  "stop_sequence",
  "exitCode",
  "tool_use_id",
  "\\n",
  // JSON structural fragments — a task description should never carry these
  '\\"',
  '{"',
  '"}',
  '"]',
];

function looksLikeStructuredNoise(text) {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return true;
  return JSON_NOISE_MARKERS.some((marker) => text.includes(marker));
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
        // Test the untruncated match: noise past char 80 would otherwise be sliced
        // off and the candidate would sail through as clean-looking prose.
        if (looksLikeStructuredNoise(text)) continue;
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
    // Character class, not alternation: the old `[做|干|…]` treated `|` as a member,
    // so every markdown table row matched. `完成` is subsumed by `完`.
    if (/[做干搞写修改完开始]/.test(line) && line.length < 120) {
      const clean = line.trim().slice(0, 100);
      if (looksLikeStructuredNoise(clean)) continue;
      if (clean.length > 5) return clean;
    }
  }
  return "";
}

const DRY_RUN_OFF_VALUES = new Set(["", "0", "false", "no", "off"]);

function isDryRun() {
  const raw = String(process.env.META_KIM_DRY_RUN ?? "").trim().toLowerCase();
  return !DRY_RUN_OFF_VALUES.has(raw);
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

function pythonPathEntries() {
  return String(process.env.PATH || process.env.Path || process.env.path || "")
    .split(path.delimiter)
    .filter(Boolean);
}

function isSafeWindowsPythonPath(candidate) {
  if (!candidate || !path.isAbsolute(candidate)) return false;
  const normalized = candidate.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("/windowsapps/")) return false;
  return /^(?:python|python3|pythonw)\.exe$/iu.test(path.basename(candidate));
}

function pythonCandidates() {
  if (process.platform !== "win32") {
    return ["python3", "python"];
  }

  const candidates = [];
  const addDirectory = (directory) => {
    if (!directory || !path.isAbsolute(directory)) return;
    for (const name of ["python.exe", "python3.exe", "pythonw.exe"]) {
      const candidate = path.join(directory, name);
      if (isSafeWindowsPythonPath(candidate) && existsSync(candidate)) {
        candidates.push(candidate);
      }
    }
  };
  const scanVersionDirectories = (root) => {
    if (!root || !path.isAbsolute(root)) return;
    let names = [];
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    } catch {
      return;
    }
    for (const name of names) {
      if (/^Python\d+(?:-32)?$/iu.test(name)) addDirectory(path.join(root, name));
    }
  };
  for (const envKey of ["META_KIM_PYTHON", "PYTHON", "PYTHON3"]) {
    const value = process.env[envKey];
    if (isSafeWindowsPythonPath(value) && existsSync(value)) candidates.push(value);
  }
  for (const dir of pythonPathEntries()) {
    addDirectory(dir);
  }
  if (process.env.LOCALAPPDATA) {
    scanVersionDirectories(path.join(process.env.LOCALAPPDATA, "Programs", "Python"));
  }
  for (const key of ["ProgramFiles", "ProgramFiles(x86)"]) {
    if (process.env[key]) scanVersionDirectories(process.env[key]);
  }
  scanVersionDirectories("C:\\");

  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

function resolvePythonCommand() {
  for (const candidate of pythonCandidates()) {
    const probe = spawnSync(
      candidate,
      ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 750,
      },
    );
    if (probe.status === 0) return candidate;
  }
  return null;
}

function runPythonSave(args, diagnostics) {
  // Verifying this hook means running it against real transcripts. Without a dry
  // run that would write to the very memory file the fix is meant to clean, and a
  // polluted file is indistinguishable from a bug.
  // D8: the old check was `if (process.env.META_KIM_DRY_RUN)`, so exporting
  // `META_KIM_DRY_RUN=0` — the obvious way to turn it off — is a truthy string that
  // turns it *on*, and the hook then silently stops saving anything forever.
  if (isDryRun()) {
    console.log(JSON.stringify({ dryRun: true, args, ...(diagnostics || {}) }));
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  }
  return resolvePythonHook().then((pythonHook) => new Promise((resolve) => {
    if (!pythonHook) {
      resolve({ code: 0, stdout: "", stderr: "memory helper missing", skipped: true });
      return;
    }
    const pythonCommand = resolvePythonCommand();
    if (!pythonCommand) {
      resolve({ code: -1, stdout: "", stderr: "no safe Python interpreter found" });
      return;
    }
    const proc = spawn(pythonCommand, [pythonHook, ...args], {
      cwd: process.cwd(),
      timeout: 8000,
      windowsHide: true,
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

  const { blocks, userBlocks, lastPrompt, goalPrompt } = await readConversationBlocks(transcriptPath);
  // Was `< 2`, which silently dropped 34% of sessions that had real content: once the
  // summariser turn is filtered out a genuine session can be a single block, and that
  // block is often the whole session summary. `effectiveLines.length < 5` below is the
  // real content gate; this one only needs to catch an empty parse.
  if (blocks.length < 1) {
    process.exit(0);
    return;
  }

  const effectiveLines = proseLines(blocks);
  const userLines = proseLines(userBlocks);
  const text = effectiveLines.join("\n");
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
  // Measured on 33 real transcripts: line-picking gives the greeting when it scans
  // forward and the sign-off when it scans backward, so it is a fallback, not the
  // primary source. `goalPrompt` — the user's own words — wins when there is one.
  const taskFromUser = extractCurrentTask(userLines);
  const taskFromAll = extractCurrentTask(effectiveLines);
  // `taskFromAll` is deliberately not in the chain: on 33 transcripts it landed on a
  // sign-off ("建议现在 /clear 重开") 11 times out of 20. A confident wrong task misleads
  // the next session; a bare "收工" does not, and the content lives in completed/remaining.
  // D10: `lastPrompt` is the raw final prompt, never filtered by `isSubstantivePrompt`
  // — `goalPrompt` is. So when a session's only prompts are the summariser turn, the
  // fallback filed "Below is a conversation log from a Claude Code…" as the task and
  // the next session read the *previous* session's goal: the memory echo D3 exists to
  // kill, re-entering through the back door. Measured over 791 transcripts: 27 sessions
  // on the pre-D7 hook, 32 after D7 raised recall. Guard the fallback, not the
  // assignment — `taskVariants.lastPrompt` stays raw so the diagnostic still shows it.
  const lastPromptFallback = isSubstantivePrompt(lastPrompt) ? stripHarnessPromptPrefix(lastPrompt) : "";
  const currentTask = goalPrompt || taskFromUser || lastPromptFallback;
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

  const result = await runPythonSave(args, {
    blockCount: blocks.length,
    proseLineCount: effectiveLines.length,
    taskVariants: { goalPrompt, fromUser: taskFromUser, fromAll: taskFromAll, lastPrompt },
  });

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
