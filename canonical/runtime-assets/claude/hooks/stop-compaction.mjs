#!/usr/bin/env node
/**
 * Stop hook: auto-write compaction packet when session ends.
 *
 * Prefers authoritative runtime spine state for stage progress, then uses
 * transcript scanning only as a local-continuity fallback. Structured Review
 * findings are still extracted from the transcript, then written to:
 *   .meta-kim/state/{profile}/compaction/{run-ref}.json
 *
 * Runs on EVERY Stop event — detects governed run in progress by looking for
 * 8-stage spine markers. Always exits 0 — never blocks session stop.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import {
  readSpineState,
  resolveProfileStateDir,
  sanitizeStateProfile,
  STAGE_ORDER,
  STAGE_PUBLIC_LABELS,
} from "./spine-state.mjs";

// ── Read stdin ONCE at top level before anything else ────────────────────────
const STDIN_CHUNKS = [];
for await (const chunk of process.stdin) STDIN_CHUNKS.push(chunk);
const RAW_STDIN = Buffer.concat(STDIN_CHUNKS).toString("utf8").trim();
let INPUT = {};
try { INPUT = JSON.parse(RAW_STDIN || "{}"); } catch { INPUT = {}; }

// ── Constants ───────────────────────────────────────────────────────────────
const REPO_ROOT = path.resolve(INPUT.cwd || process.cwd());

const STAGE_PATTERNS = {
  Critical:     /\b(Critical|clarify|intentPacket|需求澄清|明确意图)\b/gi,
  Fetch:        /\b(Fetch|搜索|capability|能力搜索|findskill)\b/gi,
  Thinking:     /\b(Thinking|规划|dispatchBoard|分派|owner|Task Card)\b/gi,
  Execution:    /\b(Execution|执行|分派执行|dispatch|Worker Task)\b/gi,
  Review:       /\b(Review|审查|reviewPacket|findings|openFindings|CRITICAL|HIGH|MEDIUM|LOW)\b/gi,
  "Meta-Review": /\b(Meta-Review|元审查|review.*standard)\b/gi,
  Verification: /\b(Verification|验证|verified|verify.*gate|closeFindings)\b/gi,
  Evolution:     /\b(Evolution|进化|writeback|evolutionWriteback)\b/gi,
};

const FINDING_SEVERITIES = new Set(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
const PUBLIC_STAGE_TO_KEY = new Map(
  Object.entries(STAGE_PUBLIC_LABELS).map(([key, label]) => [label, key]),
);
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

function publicStageLabels() {
  return STAGE_ORDER.map((stage) => STAGE_PUBLIC_LABELS[stage]);
}

// ── Helpers ────────────────────────────────────────────────────────────────
async function readTranscript(transcriptPath, maxLines = 600) {
  try {
    const fd = await fs.open(transcriptPath, "r");
    const buf = [];
    for await (const line of fd.readLines()) {
      buf.push(line);
      if (buf.length > maxLines) buf.shift();
    }
    fd.close();
    return buf.join("\n");
  } catch {
    return "";
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

function detectCurrentStage(text) {
  let current = "Critical";
  let maxScore = 0;
  for (const [stage, pattern] of Object.entries(STAGE_PATTERNS)) {
    const matches = text.match(pattern) || [];
    if (matches.length > maxScore) {
      maxScore = matches.length;
      current = stage;
    }
  }
  return current;
}

function detectCompletedStages(text) {
  const stages = publicStageLabels();
  const completed = [];
  for (let i = 0; i < stages.length - 1; i++) {
    const laterActive = stages.slice(i + 1).some(
      (s) => (text.match(STAGE_PATTERNS[s]) || []).length > 0,
    );
    const thisActive = (text.match(STAGE_PATTERNS[stages[i]]) || []).length > 0;
    if (thisActive && laterActive) completed.push(stages[i]);
  }
  return [...new Set(completed)];
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeStructuredFinding(finding) {
  if (!isObject(finding)) return null;

  const findingId = nonEmptyString(finding.findingId)
    ? finding.findingId.trim()
    : nonEmptyString(finding.id)
      ? finding.id.trim()
      : "";
  const severity = nonEmptyString(finding.severity)
    ? finding.severity.trim().toUpperCase()
    : "";
  const closeState = nonEmptyString(finding.closeState)
    ? finding.closeState.trim()
    : "";

  if (!findingId || !FINDING_SEVERITIES.has(severity)) return null;
  if (!nonEmptyString(finding.owner)) return null;
  if (!nonEmptyString(finding.sourceProject)) return null;
  if (!nonEmptyString(finding.requiredAction)) return null;
  if (!closeState || /^closed$/i.test(closeState)) return null;

  return {
    id: findingId,
    findingId,
    severity,
    owner: finding.owner.trim(),
    sourceProject: finding.sourceProject.trim(),
    summary: nonEmptyString(finding.summary)
      ? finding.summary.trim()
      : nonEmptyString(finding.description)
        ? finding.description.trim()
        : finding.requiredAction.trim(),
    requiredAction: finding.requiredAction.trim(),
    fixArtifact: nonEmptyString(finding.fixArtifact) ? finding.fixArtifact.trim() : null,
    verifiedBy: nonEmptyString(finding.verifiedBy) ? finding.verifiedBy.trim() : null,
    closeState,
  };
}

function pushStructuredFindings(target, candidates, seen) {
  if (!Array.isArray(candidates)) return;
  for (const candidate of candidates) {
    const normalized = normalizeStructuredFinding(candidate);
    if (!normalized || seen.has(normalized.findingId)) continue;
    seen.add(normalized.findingId);
    target.push(normalized);
  }
}

function collectStructuredFindings(node, target, seen) {
  if (Array.isArray(node)) {
    for (const item of node) collectStructuredFindings(item, target, seen);
    return;
  }
  if (!isObject(node)) return;

  pushStructuredFindings(target, node.reviewPacket?.findings, seen);
  pushStructuredFindings(target, node.compactionPacket?.openFindings, seen);

  for (const value of Object.values(node)) {
    if (isObject(value) || Array.isArray(value)) {
      collectStructuredFindings(value, target, seen);
    }
  }
}

function extractJsonLineObjects(text) {
  const objects = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isObject(parsed)) objects.push(parsed);
    } catch {
      // Transcript prose can contain braces; ignore non-JSON lines.
    }
  }
  return objects;
}

function extractFindings(text) {
  const findings = [];
  const seen = new Set();
  for (const object of extractJsonLineObjects(text)) {
    collectStructuredFindings(object, findings, seen);
    if (findings.length >= 10) break;
  }
  return findings;
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function readProfileSpineState(profile) {
  const safeProfile = sanitizeStateProfile(profile);
  const spinePath = resolveProfileStateDir(
    REPO_ROOT,
    profile,
    "spine",
    "spine-state.json",
  );
  const state = await readJsonIfExists(spinePath);
  if (!state || typeof state !== "object" || state.active === false) return null;
  return state;
}

async function readAuthoritativeSpineState(profile) {
  const safeProfile = sanitizeStateProfile(profile);
  const profileState = await readProfileSpineState(profile);
  if (profileState) return profileState;

  const active = await readSpineState(REPO_ROOT);
  if (!active) return null;

  if (safeProfile === "default" || process.env.META_KIM_SPINE_STATE_DIR) {
    return active;
  }

  return null;
}

function normalizeStageKey(stage) {
  const candidate = String(stage ?? "").trim();
  const lower = candidate.toLowerCase().replace(/[-\s]+/g, "_");
  if (STAGE_ORDER.includes(lower)) return lower;
  const publicKey = PUBLIC_STAGE_TO_KEY.get(candidate);
  return publicKey && STAGE_ORDER.includes(publicKey) ? publicKey : "critical";
}

function stageLabelFromKey(stageKey) {
  return STAGE_PUBLIC_LABELS[normalizeStageKey(stageKey)] ?? STAGE_PUBLIC_LABELS.critical;
}

function deriveStageContext({ text, spineState }) {
  if (spineState && typeof spineState === "object") {
    const currentStageKey = normalizeStageKey(spineState.currentStage);
    const stages = spineState.stages && typeof spineState.stages === "object"
      ? spineState.stages
      : {};
    return {
      sourceAuthority: "runtime_spine_state",
      stage: stageLabelFromKey(currentStageKey),
      completed: STAGE_ORDER
        .filter((stage) => stages?.[stage]?.status === "completed")
        .map(stageLabelFromKey),
    };
  }
  return {
    sourceAuthority: "transcript_heuristic",
    stage: detectCurrentStage(text),
    completed: detectCompletedStages(text),
  };
}

function deriveVerifyGateState({ findings, spineState, sourceAuthority }) {
  if (findings.length > 0) return "pending_verify";
  const verificationStatus = spineState?.stages?.verification?.status;
  const evolutionStatus = spineState?.stages?.evolution?.status;
  if (
    sourceAuthority === "runtime_spine_state" &&
    (verificationStatus === "completed" || evolutionStatus === "completed")
  ) {
    return "verified";
  }
  return "pending_verify";
}

async function writeCompaction({
  stage,
  completed,
  findings,
  runRef,
  profile,
  sourceAuthority,
  spineState,
}) {
  const safeProfile = sanitizeStateProfile(profile);
  const compactionDir = resolveProfileStateDir(
    REPO_ROOT,
    profile,
    "compaction",
  );
  await fs.mkdir(compactionDir, { recursive: true });

  const stageIdx = publicStageLabels().indexOf(stage);
  const verifyGateState = deriveVerifyGateState({ findings, spineState, sourceAuthority });
  const outFile = path.join(compactionDir, `${runRef}.json`);

  const compaction = {
    packetVersion: "1.0",
    runRef,
    profile: safeProfile,
    profileKey: `${safeProfile}-auto`,
    createdAt: new Date().toISOString(),
    stageState: {
      current: stage,
      completed,
      resumeFrom: stage,
      stepNumber: stageIdx + 1,
    },
    authority: "local_continuity_only",
    sourceAuthority,
    stageSource: sourceAuthority,
    sourceAuthorityDetail: {
      runtimeRunId: spineState?.runId ?? null,
      transcriptFallbackUsed: sourceAuthority !== "runtime_spine_state",
      publicReadyClaimAllowed: false,
      note:
        sourceAuthority === "runtime_spine_state"
          ? "Stage progress came from the active runtime spine state."
          : "Stage progress came from transcript heuristics and is not runtime authority.",
    },
    openFindings: findings.map((f) => ({ ...f, sourceFile: null, line: null })),
    pendingRevisions: findings.map((f) => ({
      findingId: f.id,
      plannedFix: null,
      status: "planned",
      owner: null,
    })),
    verifyGateState,
    singleDeliverableState: {
      currentDeliverable: "governed-run",
      closed: false,
      singleDeliverableMaintained: false,
      deliverableChainClosed: false,
    },
    summaryDelta: {
      written: false,
      content: null,
      publicReady: false,
      verifyPassed: verifyGateState === "verified",
      summaryClosed: false,
      source: "local_compaction_no_public_ready_claim",
    },
    writebackDecision: {
      decision: "none",
      targets: [],
      continuityOnly: true,
      continuityTarget: "local-compaction",
      content:
        findings.length > 0
          ? "Review findings captured from transcript for local continuity only. Verify and close findings in next session; this is not an Evolution writeback."
          : "No open findings captured. Compaction packet is local continuity only and is not an Evolution writeback.",
    },
    accepted_risk: null,
    handoffNote:
      `Auto-compaction from Stop hook. Stage=${stage}(${stageIdx + 1}/${STAGE_ORDER.length}), findings=${findings.length}, source=${sourceAuthority}. ` +
      `Auto-generated at session end. Local continuity suggests inspecting from ${stage}; this is not active-run continuation, verification, or public-ready proof.`,
  };

  await fs.writeFile(outFile, JSON.stringify(compaction, null, 2), "utf8");
  await fs.writeFile(
    path.join(compactionDir, "latest.json"),
    JSON.stringify(compaction, null, 2),
    "utf8",
  );

  return path.relative(REPO_ROOT, outFile).replace(/\\/g, "/");
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  // Never block session stop
  process.exitCode = 0;

  // Only run on actual interruptions (not active=true stops)
  if (INPUT.stop_hook_active === true) return;

  const profile = process.env.META_KIM_PROFILE;
  const spineState = await readAuthoritativeSpineState(profile);
  const transcriptPath = INPUT.transcript_path || INPUT.transcriptPath;
  if (!transcriptPath) return;

  const rawText = await readTranscript(transcriptPath);
  const text = stripHookPromptDisplayBlocks(rawText);
  if ((!text || text.length < 200) && !spineState) return; // too short to be a real session

  const stageContext = deriveStageContext({ text, spineState });
  const { stage, completed, sourceAuthority } = stageContext;
  const findings = extractFindings(text);
  const hasActivity = Object.values(STAGE_PATTERNS).some(
    (p) => (text.match(p) || []).length > 0,
  );
  if (!hasActivity && !spineState) return; // no governance activity detected

  const runRef = `run-${Date.now()}`;

  try {
    const relPath = await writeCompaction({
      stage,
      completed,
      findings,
      runRef,
      profile,
      sourceAuthority,
      spineState,
    });
    process.stderr.write(
      `[compaction] auto-written: ${relPath} (stage=${stage}, source=${sourceAuthority}, findings=${findings.length})\n`,
    );
  } catch (e) {
    process.stderr.write(`[compaction] warn: ${e.message}\n`);
  }
}

main().catch(() => { process.exitCode = 0; });
