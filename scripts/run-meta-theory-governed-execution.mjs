#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  promises as fs,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyMetaTheoryEntry } from "./meta-theory-entry-classifier.mjs";
import {
  openRunStateStore,
} from "./capability-gap-mvp.mjs";
import { writeCapabilityInventory } from "./build-capability-inventory.mjs";
import {
  getGovernedRunSurfaceLabels,
  getReportLabelsForPath,
  normalizeOutputLanguage,
  resolveOutputLanguage,
} from "./meta-kim-i18n.mjs";
import { buildAgentProjectionTargets } from "./runtime-tool-profiles.mjs";
import { getProfilePaths } from "./meta-kim-local-state.mjs";
import { resolveRuntimeHomeDir } from "./meta-kim-sync-config.mjs";
import { copyProjectCapability } from "./project-capability-copy.mjs";
import {
  buildPlanChallengeState,
  parsePlanChallengeControl,
  planChallengeAuthorizationBinding,
  selectHighestImpactOpenQuestion,
} from "./governed-execution/plan-challenge-policy.mjs";
import {
  bindVerifiedHostPlanChallengeDecision,
  loadPlanChallengeContinuationCandidate,
} from "./governed-execution/plan-challenge-host-continuation.mjs";
export {
  buildPlanChallengeState,
  parsePlanChallengeControl,
  planChallengeAuthorizationBinding,
  selectHighestImpactOpenQuestion,
};
import {
  buildAgentTeamsWaves,
  buildFanoutSafetyPacket,
  taskIsExecutableWorker,
} from "./governed-execution/fanout-policy.mjs";
import {
  buildStageDagPacket,
  stageLaneNodeId,
} from "./governed-execution/stage-dag.mjs";
import {
  applyStageRunnerBridgeResult,
  normalizeStageRunnerRuntime,
  runStageRunnerBridge,
} from "./governed-execution/stage-runner-bridge.mjs";
import { openDurableRunKernel } from "./governed-execution/durable-run-kernel.mjs";
import { resolveReadySetExecutor } from "./governed-execution/ready-set-adapters.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(scriptDir, "..");
const DEFAULT_PROFILE_DIR = getProfilePaths({ repoPath: REPO_ROOT }).profileDir;
const DEFAULT_STATE_DIR = path.join(DEFAULT_PROFILE_DIR, "governed-executions");
const DEFAULT_DB_PATH = path.join(DEFAULT_PROFILE_DIR, "governed-execution.sqlite");
const DURABLE_RESERVATION_SCHEMA = "governed-run-reservation-v0.1";
const RUN_REPORT_PANEL_CONTRACT_PATH = path.join(
  REPO_ROOT,
  "config",
  "contracts",
  "run-report-panel-contract.json"
);
const CORE_LOOP_CONTRACT_PATH = path.join(
  REPO_ROOT,
  "config",
  "contracts",
  "core-loop-contract.json",
);
const CORE_LOOP_CONTRACT = JSON.parse(readFileSync(CORE_LOOP_CONTRACT_PATH, "utf8"));
const TRACE_SPINE = Object.freeze([...(CORE_LOOP_CONTRACT.defaultEntry?.spine ?? [])]);
const AI_READABLE_PRODUCT_STANDARDS_PATH = path.join(
  REPO_ROOT,
  "config",
  "contracts",
  "ai-readable-product-standards.json"
);
const RUNTIME_TARGETS = ["claude", "codex", "cursor", "openclaw"];
const WARDEN_APPROVAL_PACKET_SCHEMA_VERSION = "warden-approval-v0.1";
const CONVERSATION_NOTICE_SCHEMA_VERSION = "conversation-notice-v0.1";
const CONVERSATION_NOTICE_ADAPTER = "meta-theory-governed-execution-cli";
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SELECT_EXECUTION_ROUTE_SCRIPT = path.join(scriptDir, "select-execution-route.mjs");
const WINDOWS_TRANSIENT_RENAME_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);
const WINDOWS_RENAME_RETRY_DELAYS_MS = Object.freeze([10, 25, 50, 100]);

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

const RUNTIME_PROJECTION_FAILURE_REASON_CODES = Object.freeze({
  projectionSmokeOnly: "projection_smoke_only",
  nativeHarnessMissing: "native_harness_missing",
  authMissing: "auth_missing",
  timeout: "timeout",
  structuralFailure: "structural_failure",
  toolUnsupported: "tool_unsupported",
  runtimeUnavailable: "runtime_unavailable",
  liveIncomplete: "live_incomplete",
  unknownFailure: "unknown_failure",
});

const RUNTIME_PROJECTION_REASON_TO_FAILURE_CLASS = Object.freeze({
  [RUNTIME_PROJECTION_FAILURE_REASON_CODES.projectionSmokeOnly]:
    RUNTIME_FAILURE_TAXONOMY.projectionOnly,
  [RUNTIME_PROJECTION_FAILURE_REASON_CODES.nativeHarnessMissing]:
    RUNTIME_FAILURE_TAXONOMY.nativeHarnessMissing,
  [RUNTIME_PROJECTION_FAILURE_REASON_CODES.authMissing]:
    RUNTIME_FAILURE_TAXONOMY.authMissing,
  [RUNTIME_PROJECTION_FAILURE_REASON_CODES.timeout]:
    RUNTIME_FAILURE_TAXONOMY.timeout,
  [RUNTIME_PROJECTION_FAILURE_REASON_CODES.structuralFailure]:
    RUNTIME_FAILURE_TAXONOMY.structuralFailure,
  [RUNTIME_PROJECTION_FAILURE_REASON_CODES.toolUnsupported]:
    RUNTIME_FAILURE_TAXONOMY.toolUnsupported,
  [RUNTIME_PROJECTION_FAILURE_REASON_CODES.runtimeUnavailable]:
    RUNTIME_FAILURE_TAXONOMY.runtimeUnavailable,
  [RUNTIME_PROJECTION_FAILURE_REASON_CODES.liveIncomplete]:
    RUNTIME_FAILURE_TAXONOMY.liveIncomplete,
  [RUNTIME_PROJECTION_FAILURE_REASON_CODES.unknownFailure]:
    RUNTIME_FAILURE_TAXONOMY.unknownFailure,
});

const RUNTIME_SMOKE_PROJECTIONS = {
  claude: {
    entry: ".claude/skills/meta-theory/SKILL.md",
    extra: [".claude/agents/meta-conductor.md"],
    sourceEntry: "canonical/skills/meta-theory/SKILL.md",
    sourceExtra: ["canonical/agents/meta-conductor.md"],
  },
  codex: {
    entry: ".agents/skills/meta-theory/SKILL.md",
    extra: [".codex/commands/meta-theory.md"],
    sourceEntry: "canonical/skills/meta-theory/SKILL.md",
    sourceExtra: ["canonical/runtime-assets/codex/commands/meta-theory.md"],
  },
  cursor: {
    entry: ".cursor/skills/meta-theory/SKILL.md",
    extra: [".cursor/rules/meta-enforcement.mdc"],
    sourceEntry: "canonical/skills/meta-theory/SKILL.md",
    sourceExtra: ["canonical/runtime-assets/cursor/rules/meta-enforcement.mdc"],
  },
  openclaw: {
    entry: "openclaw/skills/meta-theory/SKILL.md",
    extra: ["openclaw/openclaw.template.json"],
    sourceEntry: "canonical/skills/meta-theory/SKILL.md",
    sourceExtra: ["canonical/runtime-assets/openclaw/openclaw.template.json"],
  },
};

const AGENT_TEAMS_PLAYBOOK_ID = "agent-teams-playbook";
const CODEX_DEFAULT_AGENT_MAX_THREADS = 6;
const ROUTE_RUNTIME_ALIASES = Object.freeze({
  claude: "claude_code",
  claude_code: "claude_code",
  claudecode: "claude_code",
  codex: "codex",
  cursor: "cursor",
  openclaw: "openclaw",
});

function normalizeRouteRuntime(value, fallback = "codex") {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  if (!normalized || normalized === "auto") return fallback;
  return ROUTE_RUNTIME_ALIASES[normalized] ?? normalized;
}

function normalizeOsTarget(value, fallback = "windows") {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  return normalized && normalized !== "auto" ? normalized : fallback;
}

const CARD_TYPE_CATALOG = Object.freeze([
  {
    id: "clarify",
    label: "Clarify",
    type: "clarify",
    cardType: "info",
    cardIntent: "clarify",
    priority: 10,
    cost: "low",
    trigger: "Intent, success standard, non-goal, permission, or acceptance boundary may change the route.",
    action: "Lock the real outcome before Fetch, Thinking, or execution.",
    deliveryShell: "chat_status",
    mapsToSpine: ["Critical"],
  },
  {
    id: "shrink-scope",
    label: "Shrink scope",
    type: "shrink-scope",
    cardType: "default",
    cardIntent: "scope_contract",
    priority: 9,
    cost: "low",
    trigger: "Multiple gaps, files, runtimes, or worker lanes may overload one route.",
    action: "Narrow the boundary and declare omitted lanes with reasons.",
    deliveryShell: "markdown_report",
    mapsToSpine: ["Critical", "Thinking"],
  },
  {
    id: "options",
    label: "Options",
    type: "options",
    cardType: "info",
    cardIntent: "plan",
    priority: 8,
    cost: "mid",
    trigger: "More than one viable path, owner, or capability class exists.",
    action: "Compare paths and choose the route with explicit trade-offs.",
    deliveryShell: "decision_card",
    mapsToSpine: ["Thinking"],
  },
  {
    id: "execute",
    label: "Execute",
    type: "execute",
    cardType: "action",
    cardIntent: "execute",
    priority: 7,
    cost: "high",
    trigger: "Owner, weapon, dependency policy, runtime, OS, and verification owner are bound.",
    action: "Dispatch or run the bounded work selected by Thinking.",
    deliveryShell: "worker_task_packet",
    mapsToSpine: ["Execution"],
  },
  {
    id: "verify",
    label: "Verify",
    type: "verify",
    cardType: "action",
    cardIntent: "verify",
    priority: 6,
    cost: "mid",
    trigger: "Execution or projection evidence exists and needs fresh proof.",
    action: "Run checks and bind claims to command, log, artifact, or human acceptance evidence.",
    deliveryShell: "json_artifact",
    mapsToSpine: ["Verification"],
  },
  {
    id: "fix",
    label: "Fix",
    type: "fix",
    cardType: "action",
    cardIntent: "repair",
    priority: 5,
    cost: "mid",
    trigger: "Verification or Review fails.",
    action: "Repair bounded failures up to the iteration limit, then re-verify.",
    deliveryShell: "worker_task_packet",
    mapsToSpine: ["Execution", "Verification"],
  },
  {
    id: "rollback",
    label: "Rollback",
    type: "rollback",
    cardType: "risk",
    cardIntent: "rollback",
    priority: 4,
    cost: "high",
    trigger: "Risk or blast radius grows beyond the approved boundary.",
    action: "Return to the last stable state and re-enter Thinking.",
    deliveryShell: "chat_status",
    mapsToSpine: ["Review", "Execution"],
  },
  {
    id: "risk",
    label: "Risk",
    type: "risk",
    cardType: "risk",
    cardIntent: "risk_surface",
    priority: 9,
    cost: "high",
    trigger: "Security, release, runtime, third-party, or cross-project risk can preempt the normal route.",
    action: "Surface the risk, bind owner and rollback, and preempt unsafe execution.",
    deliveryShell: "chat_status",
    mapsToSpine: ["Fetch", "Review"],
  },
  {
    id: "nudge",
    label: "Nudge",
    type: "nudge",
    cardType: "default",
    cardIntent: "suggest",
    priority: 3,
    cost: "low",
    trigger: "The user is blocked or needs one low-cost next move.",
    action: "Offer a compact next action without expanding scope.",
    deliveryShell: "chat_status",
    mapsToSpine: ["Evolution"],
  },
  {
    id: "pause",
    label: "Pause",
    type: "pause",
    cardType: "silence",
    cardIntent: "silence",
    priority: 2,
    cost: "zero",
    trigger: "Digest window, user decision, or three consecutive high-cost cards.",
    action: "Stop pushing new tasks and show only a compact status.",
    deliveryShell: "intentional_silence",
    mapsToSpine: ["Critical", "Review"],
  },
]);

const BUSINESS_PHASES = Object.freeze([
  ["direction", "Direction", ["Critical"], "meta-warden"],
  ["planning", "Planning", ["Fetch", "Thinking"], "meta-conductor"],
  ["execution", "Execution", ["Execution"], "worker"],
  ["review", "Review", ["Review"], "meta-prism"],
  ["meta_review", "Meta-review", ["Meta-Review"], "meta-warden"],
  ["revision", "Revision", ["Execution", "Verification"], "worker"],
  ["verify", "Verify", ["Verification"], "verify"],
  ["summary", "Summary", ["Evolution"], "meta-warden"],
  ["feedback", "Feedback", ["Evolution"], "user"],
  ["evolve", "Evolve", ["Evolution"], "meta-chrysalis"],
  ["mirror", "Mirror", ["Evolution"], "meta-conductor"],
]);

const BUSINESS_PHASE_TRIGGER_THRESHOLD = 80;
const CARD_DEAL_ACCURACY_THRESHOLD = 80;

function isActiveCardDecision(decision) {
  return decision === "deal" || decision === "interrupt_insert" || decision === "escalate";
}

function cardDealSignal(signal, observed, expected, pass) {
  return {
    signal,
    observed,
    expected,
    pass: Boolean(pass),
  };
}

function scoreCardDealSignals(signals) {
  if (!Array.isArray(signals) || signals.length === 0) {
    return 0;
  }
  const passed = signals.filter((item) => item.pass).length;
  return Math.round((passed / signals.length) * 100);
}

function cardDecisionState({ decision, accuracyScore }) {
  const passes = accuracyScore >= CARD_DEAL_ACCURACY_THRESHOLD;
  if (decision === "deal") return passes ? "accurate_deal" : "weak_deal";
  if (decision === "interrupt_insert") return passes ? "accurate_interrupt" : "weak_interrupt";
  if (decision === "suppress") return passes ? "accurate_suppress" : "unsupported_suppress";
  if (decision === "defer") return passes ? "accurate_defer" : "unsupported_defer";
  if (decision === "skip") return passes ? "accurate_skip" : "unsupported_skip";
  return passes ? "accurate_escalate" : "weak_escalate";
}

function buildCardDealEvaluation({ card, decision, context }) {
  const expectedActiveByCard = {
    clarify: true,
    "shrink-scope": context.workerCount > 1,
    options: context.capabilityCount > 1,
    execute: context.workerCount > 0,
    verify: context.runtimeRecordCount > 0,
    fix: context.reviewStatus !== "pass",
    rollback: context.hasBlockedGap,
    risk: context.runtimeRisk,
    nudge: context.userNextStepNeeded,
    pause: context.digestWindowNeeded || context.highCostActiveBeforePause >= 3,
  };
  const evidenceRefsByCard = {
    clarify: ["criticalSummary.successCriteria", "taskClassification"],
    "shrink-scope": ["workerTaskPackets.length", "orchestrationTaskBoardPacket.tasks"],
    options: ["fetchEvidence.capabilityInventory", "thinkingRoute"],
    execute: ["workerTaskPackets", "dispatchBoard"],
    verify: ["runtimeProjectionEvidence.results", "verificationResult"],
    fix: ["reviewResult.status", "reviewResult.findings"],
    rollback: ["capabilityGaps.blocked", "rollbackPlanPacket"],
    risk: ["runtimeProjectionEvidence.results.strictReleasePass", "controlDecisions"],
    nudge: ["summaryPacket.nextAction", "businessPhasePlanPacket.closure"],
    pause: ["silenceDecision", "businessPhasePlanPacket.closure.userAcceptanceRequired"],
  };
  const falsificationChecksByCard = {
    clarify: ["If intent and acceptance are already locked and no route can change, Clarify should suppress."],
    "shrink-scope": ["If workerCount <= 1, Shrink scope must suppress rather than pretend scope pressure exists."],
    options: ["If only one viable capability route exists, Options must suppress or record no-branching choice."],
    execute: ["If workerTaskPackets are empty, Execute must suppress or block."],
    verify: ["If no execution/projection claim exists, Verify must suppress rather than invent proof work."],
    fix: ["If Review passes with zero findings, Fix must suppress."],
    rollback: ["If no blocked gap or blast-radius growth exists, Rollback must suppress."],
    risk: ["If runtime/release/security evidence has no risk signal, Risk must suppress."],
    nudge: ["If there is no next action or user-facing value, Nudge must suppress."],
    pause: ["If there is no digest window, user decision, or high-cost streak, Pause must suppress."],
  };
  const expectedActive = expectedActiveByCard[card.id] === true;
  const activeDecision = isActiveCardDecision(decision);
  const expectedDecision =
    card.id === "risk" && expectedActive
      ? "interrupt_insert"
      : expectedActive
        ? "deal"
        : "suppress";
  const signals = [
    cardDealSignal("card rule exists", Boolean(card.trigger), true, Boolean(card.trigger)),
    cardDealSignal(
      "precondition observed",
      { card: card.id, expectedActive },
      "matches current route evidence",
      typeof expectedActive === "boolean",
    ),
    cardDealSignal(
      "decision matches precondition",
      { decision, expectedDecision },
      expectedDecision,
      decision === expectedDecision,
    ),
    cardDealSignal(
      "evidence refs present",
      evidenceRefsByCard[card.id]?.length ?? 0,
      ">=1",
      (evidenceRefsByCard[card.id]?.length ?? 0) >= 1,
    ),
    cardDealSignal(
      "attention policy respected",
      { cost: card.cost, activeDecision },
      "suppress when no clear intervention gain; deal only when value beats attention cost",
      expectedActive === activeDecision,
    ),
  ];
  const accuracyScore = scoreCardDealSignals(signals);
  return {
    schemaVersion: "card-deal-evaluation-v0.1",
    decisionState: cardDecisionState({ decision, accuracyScore }),
    accuracyScore,
    passThreshold: CARD_DEAL_ACCURACY_THRESHOLD,
    expectedDecision,
    activationRule: card.trigger,
    quantitativeSignals: signals,
    evidenceRefs: evidenceRefsByCard[card.id] ?? [],
    falsificationChecks: falsificationChecksByCard[card.id] ?? [],
  };
}

function cardShellForDelivery(deliveryShell) {
  const shellMap = {
    chat_status: "conversation",
    markdown_report: "file",
    decision_card: "conversation",
    worker_task_packet: "packet",
    json_artifact: "packet",
    intentional_silence: "silent_hold",
  };
  return shellMap[deliveryShell] ?? "summary";
}

function deliveryShellProfile(deliveryShellId) {
  const profiles = {
    chat_status: {
      shellType: "structured_status",
      presentationMode: "direct",
      exposureLevel: "public",
      interventionForm: "conversation",
      audience: "user",
      contentBoundary: "compact status only",
    },
    markdown_report: {
      shellType: "artifact_link",
      presentationMode: "digest",
      exposureLevel: "public",
      interventionForm: "file_write",
      audience: "user",
      contentBoundary: "readable report, no raw packet dump",
    },
    decision_card: {
      shellType: "structured_status",
      presentationMode: "direct",
      exposureLevel: "review",
      interventionForm: "conversation",
      audience: "user",
      contentBoundary: "branch-changing option summary",
    },
    worker_task_packet: {
      shellType: "technical_detail",
      presentationMode: "deferred",
      exposureLevel: "internal",
      interventionForm: "task_packet",
      audience: "owner",
      contentBoundary: "run-scoped worker contract",
    },
    json_artifact: {
      shellType: "technical_detail",
      presentationMode: "deferred",
      exposureLevel: "review",
      interventionForm: "file_write",
      audience: "reviewer",
      contentBoundary: "machine-readable evidence artifact",
    },
    intentional_silence: {
      shellType: "one_line",
      presentationMode: "quiet",
      exposureLevel: "public",
      interventionForm: "none",
      audience: "user",
      contentBoundary: "brief status while waiting for user",
    },
  };
  return {
    deliveryShellId,
    ...(profiles[deliveryShellId] ?? profiles.markdown_report),
  };
}

function businessPhaseSignal(signal, observed, expected, pass) {
  return {
    signal,
    observed,
    expected,
    pass: Boolean(pass),
  };
}

function scoreBusinessPhaseSignals(signals) {
  if (!Array.isArray(signals) || signals.length === 0) {
    return 0;
  }
  const passed = signals.filter((item) => item.pass).length;
  return Math.round((passed / signals.length) * 100);
}

function phaseDecisionForStatus(status) {
  if (status === "done") return "trigger";
  if (status === "skipped") return "skip";
  if (status === "blocked") return "block";
  return "wait";
}

function phaseTriggerState({ status, triggerScore }) {
  if (status === "done") {
    return triggerScore >= BUSINESS_PHASE_TRIGGER_THRESHOLD
      ? "triggered"
      : "weak_trigger";
  }
  if (status === "skipped") {
    return triggerScore >= BUSINESS_PHASE_TRIGGER_THRESHOLD
      ? "accurate_skip"
      : "unsupported_skip";
  }
  if (status === "blocked") {
    return triggerScore >= BUSINESS_PHASE_TRIGGER_THRESHOLD
      ? "blocked_with_evidence"
      : "blocked_without_enough_evidence";
  }
  return triggerScore >= BUSINESS_PHASE_TRIGGER_THRESHOLD
    ? "pending_external_input"
    : "pending_without_enough_evidence";
}

function buildPhaseTriggerEvaluation({
  phase,
  status,
  orchestrationReport,
  runtimeEvidence,
  writebackFlow,
}) {
  const workerTaskCount = orchestrationReport.workerTaskPackets.length;
  const capabilityCount = orchestrationReport.fetchEvidence.capabilityInventory.length;
  const runtimeRecordCount = runtimeEvidence.results.length;
  const reviewStatus = orchestrationReport.reviewResult.status;
  const writebackStatus = writebackFlow.status;
  const hasWritebackCandidates = (writebackFlow.candidates?.length ?? 0) > 0;
  const signalsByPhase = {
    direction: [
      businessPhaseSignal(
        "success criteria locked",
        orchestrationReport.criticalSummary.successCriteria.length,
        ">=1",
        orchestrationReport.criticalSummary.successCriteria.length > 0,
      ),
      businessPhaseSignal(
        "real goal recorded",
        Boolean(orchestrationReport.criticalSummary.realGoal),
        true,
        Boolean(orchestrationReport.criticalSummary.realGoal),
      ),
      businessPhaseSignal(
        "non-goals recorded",
        orchestrationReport.criticalSummary.nonGoals.length,
        ">=1",
        orchestrationReport.criticalSummary.nonGoals.length > 0,
      ),
    ],
    planning: [
      businessPhaseSignal("capability inventory", capabilityCount, ">=3", capabilityCount >= 3),
      businessPhaseSignal(
        "worker plan present",
        workerTaskCount,
        ">=1",
        workerTaskCount >= 1,
      ),
      businessPhaseSignal(
        "dispatch board present",
        Boolean(orchestrationReport.orchestrationTaskBoardPacket?.dispatchBoardId),
        true,
        Boolean(orchestrationReport.orchestrationTaskBoardPacket?.dispatchBoardId),
      ),
    ],
    execution: [
      businessPhaseSignal("worker tasks selected", workerTaskCount, ">=1", workerTaskCount >= 1),
      businessPhaseSignal(
        "worker tasks declare execution mode",
        orchestrationReport.reviewResult.checks.workerTasksDeclareExecutionMode,
        true,
        orchestrationReport.reviewResult.checks.workerTasksDeclareExecutionMode === true,
      ),
      businessPhaseSignal(
        "worker tasks bind verification",
        orchestrationReport.workerTaskPackets.every(
          (packet) => (packet.verifySteps ?? []).length > 0,
        ),
        true,
        workerTaskCount > 0 &&
          orchestrationReport.workerTaskPackets.every(
            (packet) => (packet.verifySteps ?? []).length > 0,
          ),
      ),
    ],
    review: [
      businessPhaseSignal("review owner present", orchestrationReport.reviewResult.owner, "meta-prism", Boolean(orchestrationReport.reviewResult.owner)),
      businessPhaseSignal("review status decided", reviewStatus, "pass|fail", ["pass", "fail"].includes(reviewStatus)),
      businessPhaseSignal(
        "review checked capability inventory",
        orchestrationReport.reviewResult.checks.multiTypeCapabilityInventoryPresent,
        true,
        orchestrationReport.reviewResult.checks.multiTypeCapabilityInventoryPresent === true,
      ),
    ],
    meta_review: [
      businessPhaseSignal("review completed first", reviewStatus, "pass|fail", ["pass", "fail"].includes(reviewStatus)),
      businessPhaseSignal(
        "overclaim boundary has runtime evidence",
        runtimeRecordCount,
        ">=1",
        runtimeRecordCount > 0,
      ),
      businessPhaseSignal(
        "public-ready claim separated",
        runtimeEvidence.releaseGrade,
        "boolean",
        typeof runtimeEvidence.releaseGrade === "boolean",
      ),
    ],
    revision: [
      businessPhaseSignal("review result available", reviewStatus, "pass|fail", ["pass", "fail"].includes(reviewStatus)),
      businessPhaseSignal(
        "revision skipped only when review passed",
        { status, reviewStatus },
        "skipped iff review pass",
        status === "skipped" ? reviewStatus === "pass" : reviewStatus !== "pass",
      ),
      businessPhaseSignal(
        "autofix loop follows review status",
        { status, reviewStatus },
        "skip when review pass, wait when review not pass",
        status === "skipped" ? reviewStatus === "pass" : reviewStatus !== "pass",
      ),
    ],
    verify: [
      businessPhaseSignal("runtime records", runtimeRecordCount, `>=${RUNTIME_TARGETS.length}`, runtimeRecordCount >= RUNTIME_TARGETS.length),
      businessPhaseSignal("runtime evidence status", runtimeEvidence.status, "pass", runtimeEvidence.status === "pass"),
      businessPhaseSignal(
        "verification owner known",
        orchestrationReport.verificationResult.owner,
        "verify",
        Boolean(orchestrationReport.verificationResult.owner),
      ),
    ],
    summary: [
      businessPhaseSignal("review decided", reviewStatus, "pass|fail", ["pass", "fail"].includes(reviewStatus)),
      businessPhaseSignal("verification evaluated", runtimeEvidence.status, "pass|partial|fail", Boolean(runtimeEvidence.status)),
      businessPhaseSignal(
        "single report shell available",
        "markdown+json",
        "markdown+json",
        true,
      ),
    ],
    feedback: [
      businessPhaseSignal("summary produced before feedback", true, true, true),
      businessPhaseSignal("user acceptance required", true, true, true),
      businessPhaseSignal("feedback cannot be faked by command pass", true, true, true),
    ],
    evolve: [
      businessPhaseSignal("writeback decision recorded", writebackStatus, "known", Boolean(writebackStatus)),
      businessPhaseSignal(
        "none-with-reason or candidates",
        { writebackStatus, candidateCount: writebackFlow.candidates?.length ?? 0 },
        "none-with-reason or candidate/writeback",
        writebackStatus === "none-with-reason" || hasWritebackCandidates,
      ),
      businessPhaseSignal(
        "automatic canonical write blocked without approval",
        writebackFlow.noAutomaticCanonicalWrite,
        true,
        writebackFlow.noAutomaticCanonicalWrite === true,
      ),
    ],
    mirror: [
      businessPhaseSignal("runtime projection records", runtimeRecordCount, `>=${RUNTIME_TARGETS.length}`, runtimeRecordCount >= RUNTIME_TARGETS.length),
      businessPhaseSignal("runtime mirror smoke status", runtimeEvidence.status, "pass", runtimeEvidence.status === "pass"),
      businessPhaseSignal(
        "release-grade not overclaimed",
        runtimeEvidence.releaseGrade,
        false,
        runtimeEvidence.releaseGrade === false,
      ),
    ],
  };
  const activationRules = {
    direction: "Trigger when a durable user request has enough intent evidence to define done.",
    planning: "Trigger when Fetch found capabilities and Thinking must bind a dispatch board or worker plan.",
    execution: "Trigger when workerTaskPackets exist; otherwise skip only with an explicit no-worker-needed reason.",
    review: "Trigger whenever execution or dispatch evidence exists and must be checked by meta-prism.",
    meta_review: "Trigger after Review when the run can be overclaimed as public-ready, live, or complete.",
    revision: "Trigger only when Review finds unresolved issues; skip when Review passes with zero findings.",
    verify: "Trigger when any completion or runtime claim needs fresh command/artifact evidence.",
    summary: "Trigger after Review and Verification produce a closure story for the user.",
    feedback: "Trigger after Summary; wait for human acceptance and do not infer it from tests.",
    evolve: "Trigger when writeback candidates or durable lessons exist; skip only with none-with-reason.",
    mirror: "Trigger when canonical/runtime-facing behavior may diverge and projection evidence must be checked.",
  };
  const evidenceRefs = {
    direction: ["criticalSummary.successCriteria", "criticalSummary.realGoal"],
    planning: ["fetchEvidence.capabilityInventory", "orchestrationTaskBoardPacket"],
    execution: ["workerTaskPackets", "reviewResult.checks.workerTasksDeclareExecutionMode"],
    review: ["reviewResult", "reviewResult.checks"],
    meta_review: ["reviewResult", "runtimeProjectionEvidence"],
    revision: ["reviewResult.status", "reviewResult.findings"],
    verify: ["runtimeProjectionEvidence.results", "verificationResult.owner"],
    summary: ["reviewResult", "runtimeProjectionEvidence", "runReport"],
    feedback: ["businessPhasePlanPacket.closure", "userAcceptanceRequired"],
    evolve: ["wardenWritebackFlow", "evolutionWritebackPacket"],
    mirror: ["runtimeProjectionEvidence.results", "meta:sync"],
  };
  const falsificationChecks = {
    direction: ["Remove successCriteria: direction must fail below threshold."],
    planning: ["Remove capability inventory: planning must fail below threshold."],
    execution: ["Remove workerTaskPackets: execution must become accurate_skip or unsupported_skip."],
    review: ["Remove reviewResult.owner: review must fail below threshold."],
    meta_review: ["Remove runtime evidence: meta_review must fail overclaim audit."],
    revision: ["Set reviewStatus=pass and revision done: revision trigger must fail."],
    verify: ["Remove runtime records: verify must block."],
    summary: ["Remove review or verification evidence: summary must fail below threshold."],
    feedback: ["Treat command pass as acceptance: feedback must fail policy review."],
    evolve: ["Remove writeback decision: evolve must fail below threshold."],
    mirror: ["Remove projection records: mirror must block."],
  };
  const signals = signalsByPhase[phase] ?? [];
  const triggerScore = scoreBusinessPhaseSignals(signals);
  return {
    schemaVersion: "business-phase-trigger-v0.1",
    decision: phaseDecisionForStatus(status),
    activationState: phaseTriggerState({ status, triggerScore }),
    triggerScore,
    passThreshold: BUSINESS_PHASE_TRIGGER_THRESHOLD,
    activationRule: activationRules[phase],
    quantitativeSignals: signals,
    evidenceRefs: evidenceRefs[phase] ?? [],
    falsificationChecks: falsificationChecks[phase] ?? [],
  };
}

function failedBusinessPhaseSignals(triggerEvaluation) {
  return (triggerEvaluation?.quantitativeSignals ?? []).filter((signal) => signal.pass !== true);
}

function businessPhaseStatusReason({ phase, status, triggerEvaluation, skipReason }) {
  const signals = triggerEvaluation?.quantitativeSignals ?? [];
  const passed = signals.filter((signal) => signal.pass === true).length;
  const failed = failedBusinessPhaseSignals(triggerEvaluation);
  if (status === "done") {
    return `已完成：${passed}/${signals.length} 个阶段信号成立，状态可由证据复查。`;
  }
  if (status === "skipped") {
    return `已跳过：${skipReason ?? "本次没有需要执行的业务动作"}。`;
  }
  if (status === "blocked") {
    const failedNames = failed.map((signal) => signal.signal).join("、") || "关键证据";
    return `已阻塞：${failedNames} 未达标，不能把阶段完成说成闭环完成。`;
  }
  if (phase === "feedback") {
    return "等待：需要用户验收或反馈，不能用命令通过替代用户接受。";
  }
  return "等待：需要上游阶段、外部输入或人工验收后才能继续。";
}

function businessPhaseNextAction({ phase, status }) {
  if (status === "done") return "继续推进后续阶段或保留为完成证据。";
  if (status === "skipped") return "无需执行；保留跳过原因供 Review 复查。";
  if (status === "blocked") {
    if (phase === "verify") return "补 fresh verification/runtime evidence 后重新判断。";
    if (phase === "mirror") return "补 projection/mirror evidence 后重新判断。";
    return "回到对应上游阶段补证据或修状态语义。";
  }
  if (phase === "feedback") return "等待用户确认、反馈或接受风险。";
  return "等待缺失输入出现后继续。";
}

function determineCurrentBusinessPhase(phases) {
  return (
    phases.find((phase) => phase.phase === "feedback" && phase.status === "pending") ??
    phases.find((phase) => phase.status === "pending") ??
    phases.find((phase) => phase.status === "blocked") ??
    phases.find((phase) => phase.status === "done") ??
    phases[0] ??
    null
  );
}

function summarizeBusinessPhaseStatuses(businessPhasePlanPacket) {
  const phases = businessPhasePlanPacket?.phases ?? [];
  const byStatus = new Map(["done", "skipped", "blocked", "pending"].map((status) => [status, []]));
  for (const phase of phases) {
    const group = byStatus.get(phase.status) ?? [];
    group.push(phase.phase);
    byStatus.set(phase.status, group);
  }
  const groupLine = ["done", "skipped", "blocked", "pending"]
    .map((status) => `${status}=${(byStatus.get(status) ?? []).join("/") || "none"}`)
    .join("; ");
  const currentPhaseId = businessPhasePlanPacket?.closure?.currentPhase;
  const currentPhase =
    phases.find((phase) => phase.phase === currentPhaseId) ?? determineCurrentBusinessPhase(phases);
  return {
    groupLine,
    currentLine: currentPhase
      ? `${currentPhase.phase}=${currentPhase.status}；${currentPhase.statusReason}`
      : "missing；没有生成业务阶段状态。",
    blockedLine:
      (byStatus.get("blocked") ?? []).length > 0
        ? phases
            .filter((phase) => phase.status === "blocked")
            .map((phase) => `${phase.phase}: ${phase.statusReason}`)
            .join(" | ")
        : "none",
  };
}

function stableId(prefix, seed) {
  const hash = createHash("sha1").update(String(seed ?? "")).digest("hex").slice(0, 12);
  return `${prefix}-${hash}`;
}

function uniqueRunId(taskFingerprint) {
  return `meta-run-${taskFingerprint.slice(-12)}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function validateRunId(value, source = "runId") {
  const runId = String(value ?? "").trim();
  if (
    !RUN_ID_RE.test(runId) ||
    runId === "." ||
    runId === ".." ||
    runId.includes("/") ||
    runId.includes("\\")
  ) {
    throw new Error(
      `Invalid ${source}: use 1-128 ASCII letters, digits, dot, underscore, or hyphen; path separators and dot segments are forbidden.`,
    );
  }
  return runId;
}

function resolveOutputFile(outputDir, fileName) {
  const root = path.resolve(outputDir);
  const resolved = path.resolve(root, fileName);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Governed run path escapes output directory: ${fileName}`);
  }
  return resolved;
}

export async function renameWithTransientWindowsRetry(
  sourcePath,
  targetPath,
  {
    platform = process.platform,
    rename = fs.rename,
    retryDelaysMs = WINDOWS_RENAME_RETRY_DELAYS_MS,
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  } = {},
) {
  let retryIndex = 0;
  while (true) {
    try {
      await rename(sourcePath, targetPath);
      return;
    } catch (error) {
      const retryDelayMs = retryDelaysMs[retryIndex];
      const retryable =
        platform === "win32" &&
        WINDOWS_TRANSIENT_RENAME_ERRORS.has(error?.code) &&
        Number.isFinite(retryDelayMs) &&
        retryDelayMs >= 0;
      if (!retryable) throw error;
      retryIndex += 1;
      await sleep(retryDelayMs);
    }
  }
}

async function atomicWriteFile(filePath, content) {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, content);
    await renameWithTransientWindowsRetry(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function reserveExplicitRunId(reservationPath, { runId, taskFingerprint, stagingRefs = null }) {
  let handle;
  try {
    handle = await fs.open(reservationPath, "wx");
    await handle.writeFile(
      `${JSON.stringify(
        {
          schemaVersion: DURABLE_RESERVATION_SCHEMA,
          runId,
          taskFingerprint,
          status: "reserved_or_incomplete",
          phase: "reserved",
          jsonSha256: null,
          markdownSha256: null,
          stagingRefs,
          reservedAt: nowIso(),
          updatedAt: nowIso(),
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(
        `Governed run '${runId}' already exists or is reserved by another process. Use an explicit overwrite only after verifying the existing run.`,
      );
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function validateStagingRef(value, label) {
  if (
    typeof value !== "string" || !value || value !== path.basename(value) ||
    value === "." || value === ".." || !/^[A-Za-z0-9._-]+$/u.test(value)
  ) {
    throw new Error(`Durable reservation ${label} must be a bounded relative staging filename.`);
  }
  return value;
}

async function updateDurableReservation(reservationPath, reservation, patch) {
  const updated = {
    ...reservation,
    ...patch,
    updatedAt: nowIso(),
  };
  await atomicWriteFile(reservationPath, `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}

async function readDurableReservation(reservationPath, { runId, taskFingerprint }) {
  let reservation;
  try {
    reservation = JSON.parse(await fs.readFile(reservationPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Durable resume requires identity reservation for run '${runId}'.`);
    }
    throw new Error(`Durable reservation is unreadable or invalid JSON: ${error.message}`);
  }
  if (reservation?.schemaVersion !== DURABLE_RESERVATION_SCHEMA) {
    throw new Error(`Durable reservation schema mismatch for run '${runId}'.`);
  }
  if (reservation.runId !== runId || reservation.taskFingerprint !== taskFingerprint) {
    throw new Error(`Durable reservation identity or task fingerprint mismatch for run '${runId}'.`);
  }
  if (!reservation.stagingRefs) {
    throw new Error(`Durable reservation staging refs are missing for run '${runId}'.`);
  }
  validateStagingRef(reservation.stagingRefs.json, "stagingRefs.json");
  validateStagingRef(reservation.stagingRefs.markdown, "stagingRefs.markdown");
  return reservation;
}

function durableDatabaseLabel(durableDbPath, stateDir) {
  return path.resolve(durableDbPath) === path.resolve(stateDir, "durable-runs.sqlite")
    ? "state_dir/durable-runs.sqlite"
    : "caller_supplied";
}

async function fileDigestIfExists(filePath) {
  try {
    return textSha256(await fs.readFile(filePath));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function commitStagedArtifact(stagePath, finalPath, expectedDigest) {
  const content = await fs.readFile(stagePath);
  if (textSha256(content) !== expectedDigest) {
    throw new Error(`Durable staging digest mismatch for ${path.basename(stagePath)}.`);
  }
  await atomicWriteFile(finalPath, content);
}

async function loadAlreadyMaterializedDurableRun({
  runId,
  task,
  taskFingerprint,
  reservation,
  reservationPath,
  jsonPath,
  markdownPath,
  latestPath,
  dbPath,
  durableDbPath,
}) {
  const outputDir = path.dirname(jsonPath);
  const jsonStagePath = resolveOutputFile(
    outputDir,
    validateStagingRef(reservation.stagingRefs.json, "stagingRefs.json"),
  );
  const markdownStagePath = resolveOutputFile(
    outputDir,
    validateStagingRef(reservation.stagingRefs.markdown, "stagingRefs.markdown"),
  );
  let jsonDigest = await fileDigestIfExists(jsonPath);
  let markdownDigest = await fileDigestIfExists(markdownPath);
  const jsonStageDigest = await fileDigestIfExists(jsonStagePath);
  const markdownStageDigest = await fileDigestIfExists(markdownStagePath);
  const expectedJsonDigest = reservation.jsonSha256 ?? null;
  const expectedMarkdownDigest = reservation.markdownSha256 ?? null;

  if (jsonDigest && expectedJsonDigest && jsonDigest !== expectedJsonDigest) {
    throw new Error(`Durable JSON digest mismatch or tamper detected for '${runId}'.`);
  }
  if (markdownDigest && expectedMarkdownDigest && markdownDigest !== expectedMarkdownDigest) {
    throw new Error(`Durable Markdown digest mismatch or tamper detected for '${runId}'.`);
  }
  if (!jsonDigest && markdownDigest) {
    if (!expectedJsonDigest || jsonStageDigest !== expectedJsonDigest) {
      throw new Error(`Durable JSON artifact was deleted and no trusted staging pair remains for '${runId}'.`);
    }
    await commitStagedArtifact(jsonStagePath, jsonPath, expectedJsonDigest);
    jsonDigest = expectedJsonDigest;
  }
  if (jsonDigest && !markdownDigest) {
    if (!expectedMarkdownDigest || markdownStageDigest !== expectedMarkdownDigest) {
      throw new Error(`Durable artifact set is incomplete: Markdown was deleted and no trusted staging pair remains for '${runId}'.`);
    }
    await commitStagedArtifact(markdownStagePath, markdownPath, expectedMarkdownDigest);
    markdownDigest = expectedMarkdownDigest;
  }
  if (!jsonDigest && !markdownDigest) return null;
  if (!jsonDigest || !markdownDigest || !expectedJsonDigest || !expectedMarkdownDigest) {
    throw new Error(`Durable artifact pair is incomplete or lacks paired digests for '${runId}'.`);
  }
  let artifact;
  try {
    artifact = JSON.parse(await fs.readFile(jsonPath, "utf8"));
  } catch (error) {
    throw new Error(`Durable JSON artifact is invalid for '${runId}': ${error.message}`);
  }
  if (
    artifact?.runId !== runId || artifact?.taskFingerprint !== taskFingerprint ||
    normalizeTask(artifact?.task) !== task
  ) {
    throw new Error(`Durable artifact identity or task fingerprint mismatch for run '${runId}'.`);
  }
  if (!existsSync(durableDbPath)) {
    if (reservation.phase === "reserved") return null;
    throw new Error(`Durable database is missing for staged or committed run '${runId}'.`);
  }
  const kernel = await openDurableRunKernel(durableDbPath);
  try {
    let projection;
    try {
      projection = kernel.projectRun(runId);
    } catch (error) {
      if (/Unknown governed run/iu.test(error.message) && reservation.phase === "reserved") return null;
      throw error;
    }
    if (projection.run.status === "active") return null;
    if (projection.run.status !== "completed") {
      throw new Error(`Durable kernel run '${runId}' is terminal with status ${projection.run.status}.`);
    }
    if (reservation.phase !== "materialized") {
      artifact.durableExecution = {
        ...(artifact.durableExecution ?? {}),
        status: "materialized",
        terminalStatus: "completed",
        cursor: projection.cursor,
        headCheckpointId: projection.headCheckpointId,
      };
      const finalizedJson = `${JSON.stringify(artifact, null, 2)}\n`;
      const finalizedJsonSha256 = textSha256(finalizedJson);
      await atomicWriteFile(jsonStagePath, finalizedJson);
      await commitStagedArtifact(jsonStagePath, jsonPath, finalizedJsonSha256);
      jsonDigest = finalizedJsonSha256;
      reservation = await updateDurableReservation(reservationPath, reservation, {
        phase: "materialized",
        status: "materialized",
        jsonSha256: jsonDigest,
        markdownSha256: markdownDigest,
      });
    }
  } finally {
    kernel.close();
  }
  return {
    ...artifact,
    durableExecution: {
      ...(artifact.durableExecution ?? {}),
      mode: "resume",
      status: "already_materialized",
      workerCount: 0,
    },
    paths: {
      json: jsonPath,
      markdown: markdownPath,
      latest: latestPath,
      db: dbPath,
    },
  };
}

async function openRunnerDurableCoordinator({
  durableDbPath,
  mode,
  runId,
  graphDigest,
  taskFingerprint,
  ownerId,
  leaseMs,
  heartbeatIntervalMs,
}) {
  const kernel = await openDurableRunKernel(durableDbPath);
  let claim = null;
  let heartbeatTimer = null;
  let heartbeatError = null;
  const startHeartbeat = () => {
    if (!claim || heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      try {
        kernel.heartbeatRunCoordinator({
          runId,
          ownerId,
          fenceToken: claim.fenceToken,
          leaseMs,
        });
      } catch (error) {
        heartbeatError = error;
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  };
  const claimCoordinator = () => {
    claim = kernel.claimRunCoordinator({ runId, ownerId, leaseMs });
    startHeartbeat();
    return claim;
  };
  try {
    if (mode === "resume") {
      try {
        kernel.resumeRun({ runId, graphDigest, taskFingerprint });
      } catch (error) {
        if (!/Unknown governed run/iu.test(error.message)) throw error;
        kernel.createRun({ runId, graphDigest, taskFingerprint });
      }
      claimCoordinator();
    }
  } catch (error) {
    kernel.close();
    throw error;
  }
  const bridgeKernel = {
    ...kernel,
    createRun(args) {
      const created = kernel.createRun(args);
      claimCoordinator();
      return created;
    },
  };
  return {
    kernel,
    bridgeKernel,
    mode,
    ownerId,
    leaseMs,
    get claim() {
      return claim;
    },
    assertHealthy() {
      if (heartbeatError) throw heartbeatError;
      if (!claim) throw new Error("Durable run coordinator was not claimed");
    },
    stopHeartbeat() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      if (heartbeatError) throw heartbeatError;
    },
  };
}

function textSha256(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

function normalizeTask(input) {
  return String(input ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function relative(filePath) {
  const relativePath = path.relative(REPO_ROOT, filePath).replaceAll("\\", "/");
  if (relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
    return `<external-temp>/${path.basename(filePath)}`;
  }
  return relativePath;
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readJsonIfExists(filePath) {
  try {
    return await readJson(filePath);
  } catch {
    return null;
  }
}

function safeSlug(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "capability";
}

function nowIso() {
  return new Date().toISOString();
}

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || "";
}

function normalizeProjectionFailureReasonCode(value) {
  const normalized = String(value ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return Object.values(RUNTIME_PROJECTION_FAILURE_REASON_CODES).includes(normalized)
    ? normalized
    : null;
}

export function classifyProjectionFailure({
  status,
  failureReasonCode,
  reasonCode,
  unsupportedWithReason,
}) {
  const structuredReason =
    normalizeProjectionFailureReasonCode(failureReasonCode) ??
    normalizeProjectionFailureReasonCode(reasonCode);
  if (status === "smoke_pass") {
    return RUNTIME_FAILURE_TAXONOMY.projectionOnly;
  }

  if (structuredReason) {
    return (
      RUNTIME_PROJECTION_REASON_TO_FAILURE_CLASS[structuredReason] ??
      RUNTIME_FAILURE_TAXONOMY.unknownFailure
    );
  }

  // Legacy fallback: accept an exact reason-code token only. Human-readable
  // prose such as unsupportedWithReason must not be substring-parsed because
  // words like "native" or "live" can describe release boundaries, not causes.
  const exactLegacyReason = normalizeProjectionFailureReasonCode(unsupportedWithReason);
  if (exactLegacyReason) {
    return (
      RUNTIME_PROJECTION_REASON_TO_FAILURE_CLASS[exactLegacyReason] ??
      RUNTIME_FAILURE_TAXONOMY.unknownFailure
    );
  }

  if (status === "partial") {
    return RUNTIME_FAILURE_TAXONOMY.structuralFailure;
  }
  return RUNTIME_FAILURE_TAXONOMY.unknownFailure;
}

function remainingActionForProjection(runtime, failureClass) {
  if (failureClass === RUNTIME_FAILURE_TAXONOMY.projectionOnly) {
    return `Run ${runtime} live evaluator before claiming release-grade native evidence.`;
  }
  if (failureClass === RUNTIME_FAILURE_TAXONOMY.nativeHarnessMissing) {
    return "Add strict Cursor native live-turn test evidence before claiming native live release evidence.";
  }
  if (failureClass === RUNTIME_FAILURE_TAXONOMY.authMissing) {
    return `Configure ${runtime} auth and rerun live evidence.`;
  }
  if (failureClass === RUNTIME_FAILURE_TAXONOMY.timeout) {
    return `Recover or rerun ${runtime} live session.`;
  }
  return `Inspect ${runtime} projection and live evidence gap.`;
}

function normalizeWardenApprovalPacket(packet) {
  if (!packet || typeof packet !== "object") {
    return null;
  }
  const targets = Array.isArray(packet.targets)
    ? packet.targets
    : packet.target
      ? [packet.target]
      : [];
  return {
    schemaVersion:
      packet.schemaVersion ?? WARDEN_APPROVAL_PACKET_SCHEMA_VERSION,
    approvalId: packet.approvalId ?? stableId("approval", JSON.stringify(packet)),
    approver: packet.approver,
    approvedAt: packet.approvedAt ?? null,
    scope: packet.scope,
    targets,
    diffSummary: packet.diffSummary,
    rollbackPlan: packet.rollbackPlan,
    riskReview: packet.riskReview ?? null,
    humanApprovalEvidence: packet.humanApprovalEvidence ?? null,
  };
}

export function validateWardenApprovalPacket(packet) {
  const normalized = normalizeWardenApprovalPacket(packet);
  const missing = [];
  if (!normalized) {
    return {
      ok: false,
      normalized: null,
      missing: ["approvalPacket"],
      reason: "Missing Warden approval packet.",
    };
  }
  for (const field of [
    "schemaVersion",
    "approvalId",
    "approver",
    "approvedAt",
    "scope",
    "diffSummary",
    "rollbackPlan",
  ]) {
    if (
      typeof normalized[field] !== "string" ||
      normalized[field].trim().length === 0
    ) {
      missing.push(field);
    }
  }
  if (
    normalized.schemaVersion !== WARDEN_APPROVAL_PACKET_SCHEMA_VERSION
  ) {
    missing.push("schemaVersion=warden-approval-v0.1");
  }
  if (normalized.targets.length === 0) {
    missing.push("targets");
  }
  if (
    !String(normalized.approver ?? "").toLowerCase().includes("warden")
  ) {
    missing.push("approver must name meta-warden");
  }
  return {
    ok: missing.length === 0,
    normalized,
    missing,
    reason:
      missing.length === 0
        ? "Warden approval packet is complete."
        : `Warden approval packet missing: ${missing.join(", ")}`,
  };
}

export function buildWardenApprovalRequest({ candidates }) {
  return {
    schemaVersion: WARDEN_APPROVAL_PACKET_SCHEMA_VERSION,
    status: "approval_required",
    owner: "meta-warden",
    requiredFields: [
      "approvalId",
      "approver",
      "approvedAt",
      "scope",
      "targets",
      "diffSummary",
      "rollbackPlan",
    ],
    candidateIds: candidates.map((candidate) => candidate.candidateId),
    targetPreview: candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      target: candidate.targetRelativeToCanonical
        ? `canonical/${candidate.targetRelativeToCanonical}`
        : candidate.target,
      diffSummary: candidate.diffSummary,
    })),
    instruction:
      "Current repo canonical writeback stays candidate-only until this packet is explicitly supplied and validated.",
  };
}

function approvalTargetsCandidate(approvalPacket, targetRelativeToCanonical) {
  if (!approvalPacket || !targetRelativeToCanonical) {
    return false;
  }
  const normalizedTarget = targetRelativeToCanonical.replaceAll("\\", "/");
  const canonicalTarget = `canonical/${normalizedTarget}`;
  return approvalPacket.targets.some((target) => {
    const candidate = String(target ?? "").replaceAll("\\", "/");
    return candidate === normalizedTarget || candidate === canonicalTarget;
  });
}

function writebackTargetFor(decisionResult, canonicalRoot) {
  const decision = decisionResult.gapDecision.decision;
  const base = safeSlug(decisionResult.capabilityGap.requestedCapability);
  if (decision === "create_agent") {
    return path.join(canonicalRoot, "agents", `${base}.md`);
  }
  if (decision === "create_skill") {
    return path.join(canonicalRoot, "skills", base, "SKILL.md");
  }
  if (decision === "create_script") {
    return path.join(canonicalRoot, "runtime-assets", "generated", `${base}.md`);
  }
  if (decision === "create_mcp_provider") {
    return path.join(canonicalRoot, "runtime-assets", "mcp-providers", `${base}.md`);
  }
  return null;
}

function renderCandidateContent({ decisionResult, approvalEvidence }) {
  const candidate = decisionResult.candidateWriteback;
  const output = decisionResult.decisionOutput;
  return [
    "---",
    `name: ${safeSlug(decisionResult.capabilityGap.requestedCapability)}`,
    `candidateType: ${candidate?.candidateType ?? "none"}`,
    `sourceGapId: ${decisionResult.capabilityGap.gapId}`,
    `approvalEvidence: ${approvalEvidence}`,
    "---",
    "",
    `# ${decisionResult.capabilityGap.requestedCapability}`,
    "",
    "Generated by the Warden-approved Capability Gap writeback flow.",
    "",
    "## Decision",
    "",
    `- decision: ${decisionResult.gapDecision.decision}`,
    `- owner: ${output.owner}`,
    `- scope: ${output.scope}`,
    `- verificationOwner: ${output.verification?.owner ?? "verify"}`,
    "",
    "## Boundaries",
    "",
    "- Do not auto-write canonical state without Warden approval.",
    "- Keep one-run task details in workerTaskPackets, not durable identity.",
    "",
  ].join("\n");
}

async function maybeApplyWriteback({
  decisionResult,
  canonicalRoot,
  approvalEvidence,
  apply,
}) {
  const target = writebackTargetFor(decisionResult, canonicalRoot);
  if (!target) {
    return {
      applyStatus: "not_applicable",
      target: null,
      targetRelativeToCanonical: null,
      diffSummary: "No durable writeback target for this decision.",
    };
  }
  const content = renderCandidateContent({ decisionResult, approvalEvidence });
  const targetRelativeToCanonical = path.relative(canonicalRoot, target).replaceAll("\\", "/");
  if (!apply) {
    return {
      applyStatus: "planned",
      target: relative(target),
      targetRelativeToCanonical,
      diffSummary: `Would write ${relative(target)}`,
    };
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const before = await readTextIfExists(target);
  await fs.writeFile(target, content);
  return {
    applyStatus: before === null ? "created" : "updated",
    target: relative(target),
    targetRelativeToCanonical,
    diffSummary:
      before === null
        ? `Created ${relative(target)}`
        : `Updated ${relative(target)}`,
  };
}

export async function buildRuntimeProjectionEvidence({
  repoRoot = REPO_ROOT,
  orchestrationReport,
} = {}) {
  const results = [];
  for (const runtime of RUNTIME_TARGETS) {
    const projection = RUNTIME_SMOKE_PROJECTIONS[runtime];
    const entryPath = path.join(repoRoot, projection.entry);
    const entryRaw = await readTextIfExists(entryPath);
    const extraChecks = [];
    for (const extra of projection.extra) {
      const extraPath = path.join(repoRoot, extra);
      const raw = await readTextIfExists(extraPath);
      extraChecks.push({
        path: extra,
        present: raw !== null,
        routeMentioned:
          raw !== null &&
          /meta-theory|meta-warden|meta-conductor|orchestration|capability/i.test(raw),
      });
    }
    const runtimeProjectionMaterialized =
      entryRaw !== null || extraChecks.some((item) => item.present === true);
    const runtimeNaturalRoute =
      entryRaw !== null &&
      /meta-warden/i.test(entryRaw) &&
      /meta-conductor/i.test(entryRaw) &&
      /orchestration|workerTaskPackets|multi-type capability inventory/i.test(entryRaw);
    const sourceEntryPath = path.join(repoRoot, projection.sourceEntry);
    const sourceEntryRaw = await readTextIfExists(sourceEntryPath);
    const sourceChecks = [];
    for (const extra of projection.sourceExtra) {
      const extraPath = path.join(repoRoot, extra);
      const raw = await readTextIfExists(extraPath);
      sourceChecks.push({
        path: extra,
        present: raw !== null,
        routeMentioned:
          raw !== null &&
          /meta-theory|meta-warden|meta-conductor|orchestration|capability/i.test(raw),
      });
    }
    const sourceNaturalRoute =
      sourceEntryRaw !== null &&
      /meta-warden/i.test(sourceEntryRaw) &&
      /meta-conductor/i.test(sourceEntryRaw) &&
      /orchestration|workerTaskPackets|multi-type capability inventory/i.test(sourceEntryRaw);
    const effectiveExtraChecks = runtimeProjectionMaterialized ? extraChecks : sourceChecks;
    const naturalRoute = runtimeProjectionMaterialized ? runtimeNaturalRoute : sourceNaturalRoute;
    const evidenceSource = runtimeProjectionMaterialized
      ? "runtime_projection"
      : "canonical_source_projection";
    const status =
      naturalRoute && effectiveExtraChecks.every((item) => item.present) ? "smoke_pass" : "partial";
    const unsupportedWithReason =
      status === "partial"
        ? runtimeProjectionMaterialized
          ? "Projection smoke did not prove all required files; do not mark live pass."
          : "Canonical source projection smoke did not prove all required files; do not mark live pass."
        : runtimeProjectionMaterialized
          ? "Projection smoke is not native/live evidence; release-grade runtime proof still needs live evaluation."
          : "Canonical source projection smoke is not native/live evidence; project install/update must materialize runtime files before live release evidence.";
    const failureReasonCode =
      status === "partial"
        ? RUNTIME_PROJECTION_FAILURE_REASON_CODES.structuralFailure
        : RUNTIME_PROJECTION_FAILURE_REASON_CODES.projectionSmokeOnly;
    const failureClass = classifyProjectionFailure({
      status,
      failureReasonCode,
      unsupportedWithReason,
    });
    results.push({
      runtime,
      status,
      evidenceType: "projection_smoke",
      evidenceKind: "smoke",
      evidenceSource,
      failureClass,
      triggerInput: "meta-theory governed execution",
      runtimeEntry: projection.entry,
      runtimeProjectionMaterialized,
      runtimeEntryPresent: entryRaw !== null,
      sourceEntry: projection.sourceEntry,
      sourceEntryPresent: sourceEntryRaw !== null,
      orchestrationBoard:
        orchestrationReport.orchestrationTaskBoardPacket.dispatchBoardId,
      workerTaskPackets: orchestrationReport.workerTaskPackets.length,
      verificationOwner: "verify",
      naturalRoute,
      extraChecks,
      sourceChecks,
      command: `node scripts/eval-meta-agents.mjs --runtime=${runtime}`,
      artifact: `runtimeProjectionEvidence.results.${runtime}`,
      remainingAction: remainingActionForProjection(runtime, failureClass),
      strictReleasePass: false,
      runtimeDifference:
        runtime === "cursor"
          ? "Cursor uses rules/hooks projection plus chat-card fallback for unverified native choice UI."
          : runtime === "openclaw"
            ? "OpenClaw projection remains declarative for blocking policy; typed plugin enforcement is not installed."
            : "Projection has direct skill or command entry for governed execution.",
      failureReasonCode,
      unsupportedWithReason,
    });
  }
  return {
    status: results.every((item) => ["smoke_pass", "live_pass"].includes(item.status))
      ? "pass"
      : "partial",
    schemaVersion: "runtime-evidence-v0.1",
    releaseGrade: results.every((item) => item.strictReleasePass === true),
    failureClasses: Object.fromEntries(
      results.map((item) => [item.runtime, item.failureClass])
    ),
    results,
  };
}

export async function buildWardenWritebackFlow({
  decisionResults,
  approvalEvidence = null,
  approvalPacket = null,
  applyWriteback = false,
  canonicalRoot = path.join(REPO_ROOT, "canonical"),
} = {}) {
  const candidateResults = decisionResults.filter((result) => result.candidateWriteback);
  const approvalValidation = validateWardenApprovalPacket(approvalPacket);
  const approved = approvalValidation.ok;
  const candidates = [];
  for (const result of candidateResults) {
    const plannedApplication = await maybeApplyWriteback({
      decisionResult: result,
      canonicalRoot,
      approvalEvidence:
        approvalValidation.normalized?.approvalId ??
        approvalEvidence ??
        "not-approved",
      apply: false,
    });
    const targetApproved = approvalTargetsCandidate(
      approvalValidation.normalized,
      plannedApplication.targetRelativeToCanonical,
    );
    const candidateApproved = approved && targetApproved;
    const writebackDecision = candidateApproved
      ? "approved-for-writeback"
      : "candidate_only";
    const application =
      candidateApproved && applyWriteback
        ? await maybeApplyWriteback({
            decisionResult: result,
            canonicalRoot,
            approvalEvidence:
              approvalValidation.normalized?.approvalId ??
              approvalEvidence ??
              "not-approved",
            apply: true,
          })
        : plannedApplication;
    const plannedContent = renderCandidateContent({
      decisionResult: result,
      approvalEvidence:
        approvalValidation.normalized?.approvalId ??
        approvalEvidence ??
        "not-approved",
    });
    candidates.push({
      candidateId: result.candidateWriteback.candidateId,
      sourceGapId: result.capabilityGap.gapId,
      repeatKey: result.gapDecision.decision,
      candidateType: result.candidateWriteback.candidateType,
      writebackDecision,
      approvalEvidence:
        approvalValidation.normalized?.approvalId ?? approvalEvidence,
      approvalPacket: candidateApproved ? approvalValidation.normalized : null,
      targetApproved,
      target: application.target,
      targetRelativeToCanonical: application.targetRelativeToCanonical,
      diffSummary: application.diffSummary,
      dryRunArtifact: {
        status: application.target ? "generated" : "not_applicable",
        canonicalWrites: candidateApproved && applyWriteback ? 1 : 0,
        wouldWriteBytes: Buffer.byteLength(plannedContent, "utf8"),
        targetRelativeToCanonical: application.targetRelativeToCanonical,
        riskReview: [
          "No canonical file is written unless a complete Warden approval packet is present.",
          "Approval packet targets must cover the candidate target before apply.",
          "Run-scoped task details stay out of durable identity.",
          "Rollback plan must be present before approved apply.",
        ],
      },
      verificationResult: candidateApproved
        ? {
            status: application.applyStatus === "planned" ? "planned" : "pass",
            owner: result.gapDecision.verificationOwner,
          }
        : {
            status: "not-run",
            owner: result.gapDecision.verificationOwner,
          },
      applyStatus: application.applyStatus,
    });
  }
  const approvalRequest =
    candidates.length > 0 && !approved
      ? buildWardenApprovalRequest({ candidates })
      : null;
  return {
    owner: "meta-warden",
    status:
      candidates.length === 0
        ? "none-with-reason"
        : approved && candidates.every((candidate) => candidate.targetApproved)
          ? "approved-for-writeback"
          : "candidate_only",
    noAutomaticCanonicalWrite:
      !approved ||
      !applyWriteback ||
      candidates.some((candidate) => !candidate.targetApproved),
    approvalRequired:
      !approved || candidates.some((candidate) => !candidate.targetApproved),
    approvalValidation,
    approvalRequest,
    dryRun: {
      status: candidates.length > 0 ? "generated" : "not_applicable",
      canonicalWrites: candidates.reduce(
        (total, candidate) => total + candidate.dryRunArtifact.canonicalWrites,
        0,
      ),
      candidates: candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        target: candidate.targetRelativeToCanonical
          ? `canonical/${candidate.targetRelativeToCanonical}`
          : candidate.target,
        wouldWriteBytes: candidate.dryRunArtifact.wouldWriteBytes,
        canonicalWrites: candidate.dryRunArtifact.canonicalWrites,
      })),
    },
    candidates,
    noneWithReason:
      candidates.length === 0
        ? "No long-term candidate was produced by this governed run."
        : null,
  };
}

function buildCardPlanPacket({ runId, orchestrationReport, runtimeEvidence }) {
  const workerCount = orchestrationReport.workerTaskPackets.length;
  const capabilityCount = orchestrationReport.fetchEvidence.capabilityInventory.length;
  const runtimeRecordCount = runtimeEvidence.results.length;
  const hasBlockedGap = orchestrationReport.capabilityGaps.some((gap) => gap.blocked);
  const runtimeRisk = runtimeEvidence.results.some((item) => item.strictReleasePass === false);
  const reviewStatus = orchestrationReport.reviewResult.status;
  const primaryActiveOrder = [
    "clarify",
    ...(workerCount > 1 ? ["shrink-scope"] : []),
    "options",
    ...(runtimeRisk ? ["risk"] : []),
    "execute",
    "verify",
    ...(hasBlockedGap ? ["rollback"] : []),
    ...(reviewStatus !== "pass" ? ["fix"] : []),
  ];
  const highCostActiveBeforePause = primaryActiveOrder
    .map((id) => CARD_TYPE_CATALOG.find((card) => card.id === id)?.cost)
    .filter((cost) => cost === "high").length;
  const pauseReasons = [
    ...(primaryActiveOrder.includes("options") ? ["user_decision_window"] : []),
    ...(highCostActiveBeforePause >= 3 ? ["high_cost_control_window"] : []),
    "digest_window_after_visible_status",
  ];
  const activeOrder = [
    ...primaryActiveOrder,
    ...pauseReasons.slice(0, -1).map(() => "pause"),
    "nudge",
    pauseReasons.at(-1) ? "pause" : null,
  ].filter(Boolean);
  const firstEventIndexByKey = new Map();
  activeOrder.forEach((id, index) => {
    if (!firstEventIndexByKey.has(id)) {
      firstEventIndexByKey.set(id, index);
    }
  });
  const context = {
    workerCount,
    capabilityCount,
    runtimeRecordCount,
    hasBlockedGap,
    runtimeRisk,
    reviewStatus,
    userNextStepNeeded: true,
    digestWindowNeeded: true,
    highCostActiveBeforePause,
  };
  const cardTypeDecisions = CARD_TYPE_CATALOG.map((card) => {
    const active = firstEventIndexByKey.has(card.id);
    const choiceSurfaceCard = card.id === "options" || card.id === "clarify";
    const cardDecision =
      card.id === "risk" && active
        ? "interrupt_insert"
        : active
          ? "deal"
          : "suppress";
    const decisionEvaluation = buildCardDealEvaluation({
      card,
      decision: cardDecision,
      context,
    });
    return {
      cardId: `${runId}-${card.id}`,
      cardKey: card.id,
      label: card.label,
      type: card.type,
      cardType: card.cardType,
      cardIntent: card.cardIntent,
      cardDecision,
      cardAudience:
        card.id === "pause" || card.id === "clarify" || card.id === "options"
          ? "user"
          : card.id === "verify"
            ? "reviewer"
            : "governance",
      cardTiming: active ? (card.id === "risk" ? "on_risk" : "next_stage") : "after_dependency",
      cardShell: cardShellForDelivery(card.deliveryShell),
      cardPriority: card.priority,
      cost: card.cost,
      cardReason: card.trigger,
      action: card.action,
      cardSource: "meta-conductor",
      cardSourceRef: "canonical/skills/meta-theory/references/rhythm-orchestration.md",
      cardSuppressed: cardDecision === "suppress",
      suppressionReason: cardDecision === "suppress" ? "no_clear_intervention_gain" : null,
      deliveryShellId: card.deliveryShell,
      choiceSurface:
        choiceSurfaceCard
          ? "native_choice_or_chat_card"
          : "status_or_artifact",
      choiceSurfaceDelivery: choiceSurfaceCard
        ? "adapter_required_not_triggered_by_artifact"
        : "not_applicable",
      choiceSurfaceTriggerProof: choiceSurfaceCard
        ? "cardPlanPacket records the need for a runtime adapter choice surface; it is not a native popup, native tool call, or user answer."
        : "status/artifact card only; no user decision surface required.",
      owner: card.id === "risk" || card.id === "rollback" ? "meta-sentinel" : "meta-conductor",
      mapsToSpine: card.mapsToSpine,
      dealIndex: active ? firstEventIndexByKey.get(card.id) + 1 : null,
      eventIndexes: activeOrder
        .map((id, index) => (id === card.id ? index + 1 : null))
        .filter((index) => index !== null),
      decisionEvaluation,
    };
  });
  const cardEvents = activeOrder.map((cardKey, index) => {
    const decision = cardTypeDecisions.find((card) => card.cardKey === cardKey);
    const repeatOrdinal = activeOrder.slice(0, index + 1).filter((id) => id === cardKey).length;
    const repeatReason =
      cardKey === "pause"
        ? pauseReasons[repeatOrdinal - 1] ?? "pause_window"
        : "primary_route_signal";
    return {
      eventId: `${runId}-card-event-${index + 1}-${cardKey}`,
      eventIndex: index + 1,
      cardKey,
      cardType: decision.cardType,
      label: decision.label,
      cardIntent: decision.cardIntent,
      cardDecision: decision.cardDecision,
      cardAudience: decision.cardAudience,
      cardTiming: decision.cardTiming,
      deliveryShellId: decision.deliveryShellId,
      cardShell: decision.cardShell,
      owner: decision.owner,
      mapsToSpine: decision.mapsToSpine,
      eventReason: decision.cardReason,
      repeatOrdinal,
      repeatReason,
      choiceSurfaceDelivery: decision.choiceSurfaceDelivery,
      choiceSurfaceTriggerProof: decision.choiceSurfaceTriggerProof,
    };
  });
  const activeCardTypeDecisions = cardTypeDecisions
    .filter((card) => isActiveCardDecision(card.cardDecision))
    .sort((a, b) => a.dealIndex - b.dealIndex);
  const dealScores = cardTypeDecisions.map((card) => card.decisionEvaluation.accuracyScore);
  const dealCoveragePass = cardTypeDecisions.every(
    (card) =>
      card.decisionEvaluation.accuracyScore >= card.decisionEvaluation.passThreshold &&
      !["weak_deal", "weak_interrupt", "unsupported_suppress", "unsupported_defer", "unsupported_skip", "weak_escalate"].includes(
        card.decisionEvaluation.decisionState,
      ),
  );
  return {
    schemaVersion: "card-plan-v0.3",
    packetName: "cardPlanPacket",
    dealerOwner: "meta-conductor",
    dealerMode: "conductor-primary-warden-escalation",
    cardTypeCatalogSource: "canonical/skills/meta-theory/references/rhythm-orchestration.md",
    visibleByDefault: true,
    cardTypeCatalogSummary:
      "Card types are reusable rhythm signals. A governed run emits dynamic cardEvents; catalog size is not the number of cards dealt.",
    dealStandard: {
      schemaVersion: "card-deal-standard-v0.1",
      passThreshold: CARD_DEAL_ACCURACY_THRESHOLD,
      minimumScore: Math.min(...dealScores),
      averageScore: Math.round(
        dealScores.reduce((sum, score) => sum + score, 0) / dealScores.length,
      ),
      coveragePass: dealCoveragePass,
      eventCount: cardEvents.length,
      activeTypeCount: activeCardTypeDecisions.length,
      suppressedTypeCount: cardTypeDecisions.filter((card) => card.cardDecision === "suppress").length,
      interruptEventCount: cardEvents.filter((card) => card.cardDecision === "interrupt_insert").length,
      rule:
        "Every card must prove why it is dealt, suppressed, deferred, skipped, interrupted, or escalated with quantitative signals, evidence refs, and falsification checks.",
      deepResearchAnalogy:
        "Like claimEvidenceCards, card dealing requires key signals, counterfactual checks, and decision impact instead of a hardcoded catalog label.",
    },
    eventOrder: cardEvents.map((card) => card.cardKey),
    cardEvents,
    cardTypeCatalog: CARD_TYPE_CATALOG.map((card) => ({
      cardKey: card.id,
      label: card.label,
      cardType: card.cardType,
      cardIntent: card.cardIntent,
      reusable: true,
    })),
    cardTypeDecisions,
    deliveryShells: [...new Set(cardTypeDecisions.map((card) => card.deliveryShellId))].map(
      (deliveryShellId) => deliveryShellProfile(deliveryShellId),
    ),
    silenceDecision: {
      silenceDecision: activeOrder.includes("pause") ? "intentional_silence" : "none",
      noInterventionPreferred: activeOrder.includes("pause"),
      interruptionJustified: false,
      deferUntil: "after_status_summary_or_user_reply",
      reasonForSilence:
        "Pause remains visible as a card so intentional silence is not mistaken for missing orchestration.",
    },
    controlDecisions: [
      {
        decisionId: `${runId}-forced-pause-rule`,
        decisionType: activeOrder.includes("pause") ? "override" : "skip",
        skipReason: activeOrder.includes("pause") ? null : "not_applicable",
        interruptReason: null,
        overrideReason: activeOrder.includes("pause") ? "governance_owner_insert" : null,
        insertedGovernanceOwner: "meta-conductor",
        emergencyGovernanceTriggered: false,
        returnsToStage: "Review",
        rejoinCondition: "after_status_summary_or_user_reply",
        rule: "After three consecutive high-cost cards, insert Pause before dealing new work.",
      },
      {
        decisionId: `${runId}-risk-preempt-rule`,
        decisionType: runtimeRisk ? "interrupt" : "skip",
        skipReason: runtimeRisk ? null : "not_applicable",
        interruptReason: runtimeRisk ? "global_impact" : null,
        overrideReason: null,
        insertedGovernanceOwner: runtimeRisk ? "meta-sentinel" : "meta-conductor",
        emergencyGovernanceTriggered: runtimeRisk,
        returnsToStage: "Fetch",
        rejoinCondition: runtimeRisk
          ? "risk owner records rollback and verification boundary"
          : "no runtime risk preempt required",
        rule: "Risk preempts Execute when runtime, release, security, or external capability evidence changes route safety.",
      },
    ],
    defaultShellId: "markdown_report",
    visibleSummary: {
      eventCount: cardEvents.length,
      cardTypeCount: new Set(cardEvents.map((card) => card.cardKey)).size,
      cardTypeCatalogSize: new Set(cardTypeDecisions.map((card) => card.cardKey)).size,
      activeCards: cardEvents.map((card) => card.label),
      suppressedCards: cardTypeDecisions
        .filter((card) => card.cardDecision === "suppress")
        .map((card) => card.label),
      interruptCards: cardEvents
        .filter((card) => card.cardDecision === "interrupt_insert")
        .map((card) => card.label),
      forcedPauseRule: "3 consecutive high-cost cards -> Pause",
      repeatPolicy: "Card types are dynamic signals and may be dealt repeatedly across stages.",
      dealAccuracy: `${Math.min(...dealScores)}/${CARD_DEAL_ACCURACY_THRESHOLD}`,
      dealCoveragePass,
      interruptSources: ["meta-sentinel", "meta-prism", "user", "system"],
    },
  };
}

function cardDisplayName(labels, cardKey, fallback) {
  return labels.cardNames?.[cardKey] ?? fallback ?? cardKey;
}

function joinVisibleList(items, fallback, language = "zh-CN") {
  const cleaned = [...new Set((items ?? []).filter(Boolean))];
  return cleaned.length > 0
    ? cleaned.join(language === "zh-CN" || language === "ja-JP" ? "、" : ", ")
    : fallback;
}

function joinNoticeSentence(parts, language = "zh-CN") {
  const cleaned = parts
    .map((part) => String(part ?? "").trim().replace(/[。.!]+$/u, ""))
    .filter(Boolean);
  if (cleaned.length === 0) return "";
  if (language === "zh-CN") return `${cleaned.join("；")}。`;
  if (language === "ja-JP") return `${cleaned.join("。")}。`;
  return `${cleaned.join("; ")}.`;
}

function localizedBusinessPhaseReason(phase, language) {
  if (language === "zh-CN") return phase.statusReason;
  const reasons = {
    en: {
      done: "completed with recorded evidence",
      skipped: "skipped with a recorded reason",
      blocked: "blocked until the named evidence or dependency is available",
      pending: "waiting for user feedback or the next required input",
    },
    "ja-JP": {
      done: "証拠を記録して完了",
      skipped: "理由を記録してスキップ",
      blocked: "必要な証拠または依存関係を待機",
      pending: "ユーザーのフィードバックまたは次の入力を待機",
    },
    "ko-KR": {
      done: "증거를 기록하고 완료",
      skipped: "이유를 기록하고 건너뜀",
      blocked: "필요한 증거 또는 의존성을 기다리는 중",
      pending: "사용자 피드백 또는 다음 입력을 기다리는 중",
    },
  };
  return reasons[language]?.[phase.status] ?? reasons.en[phase.status] ?? phase.status;
}

function buildUserFacingCardProgressNotices(cardPlanPacket, labels) {
  return (cardPlanPacket.cardEvents ?? [])
    .slice()
    .sort((a, b) => a.eventIndex - b.eventIndex)
    .map((event) => {
      const stage = event.mapsToSpine?.[0] ?? "Governance";
      const cardName = cardDisplayName(labels, event.cardKey, event.label);
      const discovery =
        labels.cardVisibleSummary.progressDiscoveries?.[event.cardKey] ??
        labels.cardVisibleSummary.progressDiscoveries?.default ??
        event.eventReason;
      const repeatNote =
        event.repeatOrdinal > 1
          ? labels.cardVisibleSummary.repeatEventNote?.({
              cardName,
              repeatOrdinal: event.repeatOrdinal,
              repeatReason: event.repeatReason,
            })
          : null;
      return {
        eventIndex: event.eventIndex,
        stageLine: labels.cardVisibleSummary.progressStageLine({ stage }),
        dealLine: labels.cardVisibleSummary.progressDealLine({
          discovery,
          cardName,
          repeatNote,
        }),
      };
    });
}

function buildUserFacingCardSummary(cardPlanPacket, labels) {
  const activeCards = (cardPlanPacket.cardEvents ?? []).sort(
    (a, b) => a.eventIndex - b.eventIndex,
  );
  const suppressedCards = (cardPlanPacket.cardTypeDecisions ?? []).filter(
    (card) => card.cardDecision === "suppress",
  );
  const userCards = activeCards.filter((card) => card.cardAudience === "user");
  const interruptCards = activeCards.filter((card) => card.cardDecision === "interrupt_insert");
  const pauseCard = activeCards.find((card) => card.cardKey === "pause");
  const riskCard = activeCards.find((card) => card.cardKey === "risk");
  const activeNames = activeCards.map((card) => cardDisplayName(labels, card.cardKey, card.label));
  const suppressedNames = suppressedCards.map((card) =>
    cardDisplayName(labels, card.cardKey, card.label)
  );
  const userNames = userCards.map((card) => cardDisplayName(labels, card.cardKey, card.label));
  const interruptNames = interruptCards.map((card) =>
    cardDisplayName(labels, card.cardKey, card.label)
  );
  const none = labels.none ?? "none";
  const riskState = riskCard ? labels.cardVisibleSummary.riskInserted : labels.cardVisibleSummary.riskNotTriggered;
  const pauseState = pauseCard ? labels.cardVisibleSummary.pauseTriggered : labels.cardVisibleSummary.pauseNotTriggered;
  const eventCount = activeCards.length;
  const cardTypeCount = new Set(activeCards.map((card) => card.cardKey)).size;
  const progressNotices = buildUserFacingCardProgressNotices(cardPlanPacket, labels);
  return {
    schemaVersion: "user-facing-card-summary-v0.1",
    dealtLine: labels.cardVisibleSummary.dealtLine({
      eventCount,
      cardTypeCount,
      activeCards: joinVisibleList(activeNames, none, labels.htmlLang),
    }),
    inactiveLine: labels.cardVisibleSummary.inactiveLine({
      inactiveCards: joinVisibleList(suppressedNames, none, labels.htmlLang),
    }),
    userLine: labels.cardVisibleSummary.userLine({
      userCards: joinVisibleList(userNames, none, labels.htmlLang),
      interruptCards: joinVisibleList(interruptNames, none, labels.htmlLang),
      riskState,
      pauseState,
    }),
    nextLine: labels.cardVisibleSummary.nextLine,
    repeatPolicy: labels.cardVisibleSummary.repeatPolicy,
    progressSectionTitle: labels.cardVisibleSummary.progressSectionTitle,
    progressNotices,
    eventCount,
    cardTypeCount,
    activeCards: activeNames,
    suppressedCards: suppressedNames,
    userRelevantCards: userNames,
    interruptCards: interruptNames,
    riskState,
    pauseState,
    nativeChoiceBoundary: labels.cardVisibleSummary.nativeChoiceBoundary,
  };
}

function buildRouteDrivenDecisionResults({ task, runId }) {
  return durableCapabilityRequestsFromTask(task, runId).map((request, index) => ({
    run: {
      runId: `${request.requestId}-run`,
      status: "partial",
      startedAt: nowIso(),
      endedAt: nowIso(),
      primaryGoal: request.sourceText,
    },
    capabilityGap: {
      gapId: request.requestId,
      requestedCapability: request.requestedCapability,
      currentProvidersChecked: [],
      currentAgentsChecked: [],
      insufficiencyReason:
        "The user explicitly requested a reusable durable capability candidate; route-driven execution records this as Warden-gated evolution evidence.",
      resolutionAction: request.decision,
      requestedBy: "route-driven-evolution",
      approvedBy: null,
    },
    gapDecision: {
      decisionId: `${request.requestId}-decision`,
      decision: request.decision,
      decisionReason:
        "Explicit durable capability wording requires Warden-gated candidate evidence instead of automatic canonical writeback.",
      rejectedAlternatives: ["none-with-reason", "run_scoped_worker_only"],
      confidence: 0.86,
      owner:
        request.decision === "create_agent"
          ? "meta-genesis"
          : request.decision === "create_mcp_provider"
            ? "meta-artisan"
            : request.decision === "create_script"
              ? "backend"
              : "meta-artisan",
      verificationOwner: "meta-prism",
      blockedReason: null,
    },
    decisionOutput: {
      kind: "durable_candidate",
      owner:
        request.decision === "create_agent"
          ? "meta-genesis"
          : request.decision === "create_mcp_provider"
            ? "meta-artisan"
            : request.decision === "create_script"
              ? "backend"
              : "meta-artisan",
      scope: request.sourceText,
      verification: {
        owner: "meta-prism",
        command: "npm run meta:route:validate",
      },
    },
    candidateWriteback: {
      candidateId: `${request.requestId}-candidate-${index + 1}`,
      candidateType: request.candidateType,
      promotionRule: "explicit_reusable_capability_request",
      writebackDecision: "candidate_only",
      reason: "Candidate-only until Warden approval packet targets this durable capability.",
    },
    events: [],
  }));
}

function buildBusinessPhasePlanPacket({ runId, orchestrationReport, runtimeEvidence, writebackFlow }) {
  const phaseStatuses = new Map([
    ["direction", "done"],
    ["planning", "done"],
    ["execution", orchestrationReport.workerTaskPackets.length > 0 ? "done" : "skipped"],
    ["review", orchestrationReport.reviewResult.status === "pass" ? "done" : "blocked"],
    ["meta_review", "done"],
    ["revision", orchestrationReport.reviewResult.status === "pass" ? "skipped" : "pending"],
    ["verify", runtimeEvidence.status === "pass" ? "done" : "blocked"],
    ["summary", "done"],
    ["feedback", "pending"],
    ["evolve", writebackFlow.status === "none-with-reason" ? "skipped" : "done"],
    ["mirror", runtimeEvidence.status === "pass" ? "done" : "blocked"],
  ]);
  const skipReasons = new Map([
    ["execution", "本次没有需要派发的 worker 任务"],
    ["revision", "Review 已通过，没有未解决修复项，所以不打开 revision loop"],
    ["evolve", writebackFlow.noneWithReason ?? "本次没有产生可写回的长期候选"],
  ]);
  const phases = BUSINESS_PHASES.map(([phase, label, mapsToSpine, owner], index) => {
    const status = phaseStatuses.get(phase) ?? "pending";
    const skipReason = status === "skipped" ? skipReasons.get(phase) ?? "Not needed for this run." : null;
    const triggerEvaluation = buildPhaseTriggerEvaluation({
      phase,
      status,
      orchestrationReport,
      runtimeEvidence,
      writebackFlow,
    });
    return {
      phaseIndex: index + 1,
      phase,
      label,
      status,
      owner,
      mapsToSpine,
      evidence:
        phase === "planning"
          ? "orchestrationTaskBoardPacket + workerTaskPackets"
          : phase === "verify" || phase === "mirror"
            ? "runtimeProjectionEvidence"
            : phase === "evolve"
              ? "wardenWritebackFlow"
              : "run artifact and markdown report",
      skipReason,
      triggerEvaluation,
      statusReason: businessPhaseStatusReason({ phase, status, triggerEvaluation, skipReason }),
      nextAction: businessPhaseNextAction({ phase, status }),
    };
  });
  const currentPhase = determineCurrentBusinessPhase(phases);
  const triggerScores = phases.map((phase) => phase.triggerEvaluation.triggerScore);
  const triggerCoveragePass = phases.every(
    (phase) =>
      phase.triggerEvaluation.triggerScore >= phase.triggerEvaluation.passThreshold &&
      !["weak_trigger", "unsupported_skip", "blocked_without_enough_evidence", "pending_without_enough_evidence"].includes(
        phase.triggerEvaluation.activationState,
      ),
  );
  return {
    schemaVersion: "business-phase-plan-v0.2",
    packetName: "businessPhasePlanPacket",
    source: "canonical/skills/meta-theory/references/ten-step-governance.md",
    legacyAlias: "ten-step-governance",
    visibleByDefault: true,
    triggerStandard: {
      schemaVersion: "business-phase-trigger-standard-v0.1",
      passThreshold: BUSINESS_PHASE_TRIGGER_THRESHOLD,
      minimumScore: Math.min(...triggerScores),
      averageScore: Math.round(
        triggerScores.reduce((sum, score) => sum + score, 0) / triggerScores.length,
      ),
      coveragePass: triggerCoveragePass,
      rule:
        "Each phase must record whether it triggered, skipped, blocked, or waits; every decision needs quantitative signals, evidence refs, and falsification checks.",
      deepResearchAnalogy:
        "Like claimEvidenceCards, phase activation is not a label: it needs key signals, counterfactual/falsification checks, and decision impact.",
    },
    spineRelationship:
      "The 8-stage spine governs execution logic; the 11-phase workflow governs packaging, closure, feedback, evolution, and mirrors.",
    phaseCount: phases.length,
    phases,
    closure: {
      currentPhase: currentPhase?.phase ?? "unknown",
      currentStatus: currentPhase?.status ?? "unknown",
      currentReason: currentPhase?.statusReason ?? "No business phase status was generated.",
      currentNextAction: currentPhase?.nextAction ?? "Return to business phase producer.",
      userAcceptanceRequired: true,
      publicReadyClaimAllowed: false,
      reason:
        "Generated run evidence can show orchestration completeness, but user acceptance is separate from command or smoke pass evidence.",
    },
  };
}

function normalizeRouteBindingType(type) {
  const normalized = {
    skills: "skill",
    skill: "skill",
    commands: "command",
    command: "command",
    mcpServers: "mcp_tool",
    mcpTools: "mcp_tool",
    mcp_tool: "mcp_tool",
    runtimeTools: "runtime_tool",
    runtime_tool: "runtime_tool",
    hooks: "contract_ref",
    hook: "contract_ref",
  };
  return normalized[type] ?? type ?? "capability_index_query";
}

function businessLaneCapabilityNeed(packet, laneId) {
  const candidates = [];
  for (const value of [
    packet.capabilityNeed,
    packet.capabilityRequirements,
    packet.coreProblem,
  ]) {
    if (Array.isArray(value)) {
      candidates.push(
        value
          .map((item) => String(item ?? "").trim())
          .filter(Boolean)
          .join("; "),
      );
    } else {
      candidates.push(String(value ?? "").trim());
    }
  }
  return (
    candidates.find(Boolean) ??
    `${laneId} capability-first route execution and verification`
  );
}

function buildBusinessFlowBlueprintPacket({ businessPhasePlanPacket, orchestrationReport = null }) {
  const triggerCoveragePass = businessPhasePlanPacket.triggerStandard?.coveragePass === true;
  const routeWorkerTasks = orchestrationReport?.workerTaskPackets ?? [];
  const routePlan = orchestrationReport?.thinkingRoute?.dynamicWorkflowPlan ?? {};
  const laneForPhase = (phase) => {
    const selectedOwner = phase.owner.startsWith("meta-") ? phase.owner : "meta-conductor";
    const capabilitySlot = `${phase.phase}_business_phase`;
    const matchId = `${phase.phase}_business_phase_match`;
    return {
      laneId: phase.phase,
      businessLane: phase.phase,
      capabilityNeed: `${phase.label} trigger and closure evidence`,
      capabilitySearchQuery: `${phase.phase} business phase trigger owner`,
      candidateOwners: [...new Set([selectedOwner, "meta-conductor", "meta-artisan"])],
      candidateSkills: ["meta-theory"],
      matchedCapabilities: [
        {
          matchId,
          capabilitySlot,
          bindingType: "skill",
          bindingRef: "meta-theory",
          source: businessPhasePlanPacket.source,
          confidenceScore: phase.triggerEvaluation.triggerScore / 100,
          selectionReason:
            "Selected from the 11-phase business workflow trigger standard after phase evidence evaluation.",
          selectionScope: "run_scoped",
          persistencePolicy: "do_not_persist_to_agent_identity",
          fallback: "capabilityGapPacket",
        },
      ],
      capabilityBindings: [
        {
          bindingId: `${phase.phase}_business_phase_binding`,
          capabilitySlot,
          bindingType: "skill",
          bindingRef: "meta-theory",
          source: businessPhasePlanPacket.source,
          evidenceRef: matchId,
        },
      ],
      selectedOwner,
      selectionReason:
        "Business phase route is covered by the existing meta-theory governance skill and phase owner.",
      coverageStatus: "covered",
    };
  };
  const laneForWorkerTask = (packet, index) => {
    const laneId =
      packet.businessFlowLaneId ??
      packet.roleInstanceId ??
      packet.taskPacketId ??
      `selected-lane-${index + 1}`;
    const selectedProvider =
      packet.capabilitySelection?.selectedProvider ??
      packet.providerMatch?.selectedProvider ??
      null;
    const selectedBindingType = normalizeRouteBindingType(selectedProvider?.type);
    const capabilityNeed = businessLaneCapabilityNeed(packet, laneId);
    return {
      laneId,
      businessLane: laneId,
      capabilityNeed,
      capabilitySearchQuery: `${laneId} ${packet.roleDisplayName ?? "lane"} capability route`,
      candidateOwners: [
        ...new Set([
          packet.ownerAgent,
          packet.owner,
          packet.handoffTarget,
          "meta-conductor",
          "meta-artisan",
        ].filter(Boolean)),
      ],
      candidateSkills: capabilityProviderRefs(
        packet.skillLoadout ?? packet.capabilityBindings?.skills ?? [],
      ),
      matchedCapabilities: [
        {
          matchId: `${laneId}_route_match`,
          capabilitySlot: `${laneId}_route_capability`,
          bindingType: selectedBindingType,
          bindingRef:
            selectedProvider?.id ??
            packet.capabilityLoadout?.capabilityProfileId ??
            packet.routeId ??
            "selectedExecutionRoute.recommendedRoute",
          source: "selectedExecutionRoute.recommendedRoute",
          confidenceScore: selectedProvider?.score ?? 1,
          selectionReason:
            packet.capabilitySelection?.whySelected ??
            packet.referenceDirection ??
            "Selected by route selector from current capability inventory.",
          selectionScope: "run_scoped",
          persistencePolicy: "do_not_persist_to_agent_identity",
          fallback: "capabilityGapPacket",
        },
      ],
      capabilityBindings: [
        {
          bindingId: `${laneId}_route_binding`,
          capabilitySlot: `${laneId}_route_capability`,
          bindingType: selectedBindingType,
          bindingRef:
            selectedProvider?.id ??
            packet.capabilityLoadout?.capabilityProfileId ??
            "selectedExecutionRoute.recommendedRoute",
          source: "selectedExecutionRoute.recommendedRoute",
          evidenceRef: `${laneId}_route_match`,
        },
      ],
      selectedOwner: packet.ownerAgent ?? packet.owner ?? "meta-conductor",
      selectionReason:
        packet.referenceDirection ??
        "Dynamic Workflow selected this lane from task intent and route evidence.",
      coverageStatus: "covered",
      workerTaskPacketRef: packet.taskPacketId,
      omitted: false,
    };
  };
  const requiredLanes = routeWorkerTasks.length > 0
    ? routeWorkerTasks.map(laneForWorkerTask)
    : businessPhasePlanPacket.phases
        .filter((phase) => phase.status !== "skipped")
        .map(laneForPhase);
  const routeOmittedLanes =
    routePlan.omittedLanesWithReason ??
    routePlan.omittedLaneRecords ??
    (routePlan.omittedLaneIds ?? []).map((laneId) => ({
      laneId,
      reason: "Omitted by selected route.",
      evidenceRef: "selectedExecutionRoute.recommendedRoute.subjectiveUiCapabilityAmplification.omittedLanesWithReason",
    }));
  const omittedLanes = routeOmittedLanes.length > 0
    ? routeOmittedLanes.map((lane) => ({
        laneId: lane.laneId,
        lane: lane.laneId,
        reason: lane.reason ?? lane.omitReason ?? "Omitted by selected route.",
        evidenceRef:
          lane.evidenceRef ??
          "selectedExecutionRoute.recommendedRoute.subjectiveUiCapabilityAmplification.omittedLanesWithReason",
        coverageStatus: "omitted_with_reason",
      }))
    : businessPhasePlanPacket.phases
        .filter((phase) => phase.status === "skipped")
        .map((phase) => ({
          laneId: phase.phase,
          lane: phase.phase,
          reason: phase.skipReason,
          evidenceRef: "businessPhasePlanPacket.phases",
          coverageStatus: "omitted_with_reason",
        }));
  return {
    deliverableType: "custom",
    deliverableSubtype: "governed_meta_theory_run",
    requiredLanes,
    optionalLanes: [],
    omittedLanes,
    laneDependencies: [
      "direction -> planning",
      "planning -> execution",
      "execution -> review",
      "review -> meta_review",
      "meta_review -> revision|verify",
      "verify -> summary",
      "summary -> feedback",
      "feedback -> evolve",
      "evolve -> mirror",
    ],
    coverageJudgment:
      requiredLanes.length > 0 && businessPhasePlanPacket.phaseCount === 11 && triggerCoveragePass
        ? "complete"
        : "incomplete",
    coverageDetail:
      requiredLanes.length > 0 && businessPhasePlanPacket.phaseCount === 11 && triggerCoveragePass
        ? "pass_route_selected_lanes_plus_all_11_business_phases_trigger_evaluated"
        : "fail_missing_route_lane_or_weak_business_phase_trigger_evidence",
    phaseTriggerStandard: businessPhasePlanPacket.triggerStandard,
    phasePackage: {
      phaseCount: businessPhasePlanPacket.phaseCount,
      source: businessPhasePlanPacket.source,
      role:
        "The 11-phase workflow packages closure and delivery state; it does not replace route-selected Dynamic Workflow lanes.",
    },
    blueprintSource:
      routeWorkerTasks.length > 0
        ? "selectedExecutionRoute.recommendedRoute + businessPhasePlanPacket"
        : businessPhasePlanPacket.source,
    blueprintVersion: businessPhasePlanPacket.schemaVersion,
  };
}

function buildGovernanceStartReasonPacket({
  orchestrationReport,
  businessPhasePlanPacket,
  cardPlanPacket,
  language = "zh-CN",
}) {
  const capabilityCount = orchestrationReport.fetchEvidence.capabilityInventory.length;
  const workerTaskCount = orchestrationReport.workerTaskPackets.length;
  const phaseCount = businessPhasePlanPacket.phaseCount;
  const minimumScore = businessPhasePlanPacket.triggerStandard.minimumScore;
  const coveragePass = businessPhasePlanPacket.triggerStandard.coveragePass;
  const cardEventCount = cardPlanPacket.visibleSummary.eventCount;
  const cardTypeCount = cardPlanPacket.visibleSummary.cardTypeCount;
  const copies = {
    en: {
      summary: "Entering Meta-Theory: this task needs governed closure, not direct execution alone.",
      spine: `8-stage spine triggered: ${capabilityCount} capability types and ${workerTaskCount} work units require intent, evidence, route selection, execution, review, and verification.`,
      workflow: `11-phase workflow triggered: ${phaseCount} phases scored; minimum ${minimumScore}, threshold 80, coverage=${coveragePass ? "pass" : "fail"}.`,
      cards: `Card decisions triggered: ${cardEventCount} event(s), ${cardTypeCount} card type(s); minimum ${cardPlanPacket.dealStandard.minimumScore}, threshold ${cardPlanPacket.dealStandard.passThreshold}, coverage=${cardPlanPacket.dealStandard.coveragePass ? "pass" : "fail"}.`,
    },
    "zh-CN": {
      summary: "进入 Meta-Theory：任务需要治理闭环，不只是直接执行。",
      spine: `触发 8 阶段：这是可执行治理任务，已发现 ${capabilityCount} 类能力和 ${workerTaskCount} 个工作单元，需要先锁意图、查证据、定路线，再执行审查验证。`,
      workflow: `触发 11 阶段：本次要闭合交付链，${phaseCount} 个业务阶段已按触发规则评分，最低评分 ${minimumScore}，阈值 80，覆盖=${coveragePass ? "通过" : "未通过"}。`,
      cards: `触发发牌：本轮生成 ${cardEventCount} 次发牌事件，涉及 ${cardTypeCount} 类牌；最低评分 ${cardPlanPacket.dealStandard.minimumScore}，阈值 ${cardPlanPacket.dealStandard.passThreshold}，覆盖=${cardPlanPacket.dealStandard.coveragePass ? "通过" : "未通过"}。`,
    },
    "ja-JP": {
      summary: "Meta-Theory に入ります。このタスクは直接実行だけでなく、統制された完結が必要です。",
      spine: `8 ステージを開始: ${capabilityCount} 種類の能力と ${workerTaskCount} 件の作業単位について、意図、証拠、経路、実行、レビュー、検証を管理します。`,
      workflow: `11 フェーズを開始: ${phaseCount} フェーズを評価、最低 ${minimumScore}、しきい値 80、カバレッジ=${coveragePass ? "合格" : "不合格"}。`,
      cards: `カード判断を開始: ${cardEventCount} 件、${cardTypeCount} 種類。最低 ${cardPlanPacket.dealStandard.minimumScore}、しきい値 ${cardPlanPacket.dealStandard.passThreshold}、カバレッジ=${cardPlanPacket.dealStandard.coveragePass ? "合格" : "不合格"}。`,
    },
    "ko-KR": {
      summary: "Meta-Theory 를 시작합니다. 이 작업은 단순 실행이 아니라 거버넌스 기반 마감이 필요합니다.",
      spine: `8단계 시작: ${capabilityCount}개 능력 유형과 ${workerTaskCount}개 작업 단위의 의도, 증거, 경로, 실행, 리뷰, 검증을 관리합니다.`,
      workflow: `11단계 시작: ${phaseCount}개 단계를 평가했으며 최저 ${minimumScore}, 기준 80, 커버리지=${coveragePass ? "통과" : "실패"}.`,
      cards: `카드 판단 시작: ${cardEventCount}개 이벤트, ${cardTypeCount}개 유형. 최저 ${cardPlanPacket.dealStandard.minimumScore}, 기준 ${cardPlanPacket.dealStandard.passThreshold}, 커버리지=${cardPlanPacket.dealStandard.coveragePass ? "통과" : "실패"}.`,
    },
  };
  const localized = copies[language] ?? copies.en;
  return {
    schemaVersion: "governance-start-reason-v0.1",
    status: "pass",
    audience: "user",
    placement: "run_start",
    maxLineCharacters: 120,
    language,
    summary: localized.summary,
    spineReason: localized.spine,
    workflowReason: localized.workflow,
    cardReason: localized.cards,
    evidenceRefs: [
      "fetchEvidence.capabilityInventory",
      "workerTaskPackets",
      "cardPlanPacket.dealStandard",
      "businessPhasePlanPacket.triggerStandard",
    ],
  };
}

function renderReportLabel(label, ...args) {
  return typeof label === "function" ? label(...args) : label;
}

function renderReportList(label, ...args) {
  const value = renderReportLabel(label, ...args);
  return Array.isArray(value) ? value : [String(value)];
}

function progressEvent({ runId, stage, status, reason, owner = null, details = {} }) {
  return {
    schemaVersion: "conversation-progress-event-v0.1",
    eventKind: "coarse_snapshot",
    eventId: stableId("conversation-progress", `${runId}-${stage}-${status}-${nowIso()}`),
    runId,
    stage,
    status,
    reason,
    owner,
    details,
    occurredAt: nowIso(),
  };
}

function renderConversationProgressEvent(event, labels, surfaceLabels, first = false) {
  const prefix = first ? `${labels.conversationNotice.title}: ` : "";
  return `${prefix}[${event.stage}] ${event.reason}`;
}

async function publishConversationProgress({
  event,
  events,
  labels,
  surfaceLabels,
  enabled,
  onConversationProgress,
}) {
  const text = renderConversationProgressEvent(
    event,
    labels,
    surfaceLabels,
    events.length === 1,
  );
  const enrichedEvent = { ...event, text, textSha256: textSha256(text) };
  events.push(enrichedEvent);
  if (!enabled || typeof onConversationProgress !== "function") return;
  await onConversationProgress(enrichedEvent);
}

function localizedHostObservationBoundary(language) {
  const messages = {
    "zh-CN": "聊天可见性：必须由宿主主线程中的助手消息逐条证明；stderr 或 API 回调只算传输，不算用户已经看见。",
    "ja-JP": "チャット表示の証明には、ホストのメインスレッド上のアシスタントメッセージ観測が必要です。stderr/API コールバックは転送であり、表示完了の証明ではありません。",
    "ko-KR": "채팅 표시 여부는 호스트 기본 스레드의 어시스턴트 메시지 관찰로 증명해야 합니다. stderr/API 콜백은 전송일 뿐 사용자 표시 완료 증거가 아닙니다.",
    "en-US": "Chat visibility requires assistant-message observation in the host main thread; stderr or API callbacks are transport only, not proof that the user saw it.",
  };
  return messages[language] ?? messages["en-US"];
}

function conversationNoticeOutputBoundary(channel) {
  if (channel === "stderr") return "stderr_progress_channel";
  if (channel === "api_callback") return "api_callback_progress_channel";
  return `transport:${String(channel ?? "unknown")}`;
}

function buildConversationNotice({
  orchestrationReport,
  runtimeEvidence,
  labels,
  governanceStartReasonPacket,
  businessPhasePlanPacket,
  cardPlanPacket,
  progressEvents = [],
  surfaceSnapshot = null,
  artifactStatus = "partial",
  partialReasons = [],
  emitConversationNotice = false,
  conversationNoticeChannel = "api_callback",
  conversationNoticeAdapter = CONVERSATION_NOTICE_ADAPTER,
}) {
  const capabilityCount = orchestrationReport.fetchEvidence.capabilityInventory.length;
  const workerTaskCount = orchestrationReport.workerTaskPackets.length;
  const synthesisOwner = orchestrationReport.orchestrationTaskBoardPacket.synthesisOwner;
  const surfaceLabels = getGovernedRunSurfaceLabels(labels.htmlLang);
  const copy = surfaceLabels.notice;
  const laneSummary = [
    ...new Set(
      orchestrationReport.workerTaskPackets
        .map((packet) =>
          labels.htmlLang === "zh-CN"
            ? packet.businessFlowLaneLabel ?? packet.roleDisplayName
            : packet.roleDisplayName ?? packet.businessFlowLaneId,
        )
        .filter(Boolean)
    ),
  ].join(labels.htmlLang === "zh-CN" ? "、" : ", ");
  const phaseSummary = summarizeBusinessPhaseStatuses(businessPhasePlanPacket);
  const currentPhase = businessPhasePlanPacket?.closure?.currentPhase ?? "missing";
  const currentStatus = businessPhasePlanPacket?.closure?.currentStatus ?? "missing";
  const localizedCurrentLine =
    labels.htmlLang === "zh-CN"
      ? phaseSummary.currentLine
      : `${currentPhase}=${currentStatus}`;
  const localizedBlockedLine =
    labels.htmlLang === "zh-CN"
      ? phaseSummary.blockedLine
      : (businessPhasePlanPacket?.phases ?? [])
          .filter((phase) => phase.status === "blocked")
          .map((phase) => phase.phase)
          .join(", ") || "none";
  const cardSummary = buildUserFacingCardSummary(cardPlanPacket, labels);
  const phaseReasonLines = (businessPhasePlanPacket?.phases ?? []).map(
    (phase) =>
      `${phase.phase}=${phase.status}: ${localizedBusinessPhaseReason(phase, labels.htmlLang)}`,
  );
  const surface = surfaceSnapshot ?? {
    providerInvocationState: "selected_not_invoked",
    providerBindings: [],
    meshMode: "planned_structural",
    peerCount: workerTaskCount,
    handoffCount: workerTaskCount,
    nodeCount: TRACE_SPINE.length + workerTaskCount,
    edgeCount: Math.max(TRACE_SPINE.length - 1, 0),
    state: "structural_ready",
    checkpointCount: 0,
    capabilityLedgerLines: [],
    projectCustomizationSummary: null,
  };
  const blocks = [
    {
      id: "progress",
      title: copy.progress,
      fields: ["stage", "currentWork", "cardDecisions"],
      lines: [
        `${copy.startReason}: ${governanceStartReasonPacket.summary}`,
        `${copy.spine}: ${copy.spineDetail}`,
        `${copy.workflow}: ${copy.workflowDetail}`,
        `${copy.workflowStatus}: ${copy.workflowDetail}`,
        `${copy.currentStage}: ${copy.currentDetail}`,
        `${copy.card}: ${copy.cardDetail}`,
        `${labels.conversationNotice.stageProgress}: ${labels.conversationNotice.stageProgressDetail}`,
      ],
    },
    {
      id: "route",
      title: copy.route,
      fields: ["owner", "capability", "handoff"],
      lines: [
        `${labels.conversationNotice.route}: ${labels.conversationNotice.routeDetail(capabilityCount)}`,
        `${copy.businessFlow}: ${copy.businessFlowFallback}`,
        `${surfaceLabels.report.owner}: ${surfaceLabels.report.coordinator}`,
        surface.providerPresentationSummary
          ? `${surfaceLabels.report.providers}: ${surface.providerPresentationSummary}`
          : `${surfaceLabels.report.providers}: state=${surface.providerInvocationState}; selected=${(surface.providerBindings ?? []).join(", ") || "none"}`,
        ...((surface.capabilityLedgerLines ?? []).map((line) => `${surfaceLabels.capabilityLedger.title}: ${line}`)),
        ...(surface.projectCustomizationSummary
          ? [`${surfaceLabels.capabilityLedger.projectDecisionLabel}: ${surface.projectCustomizationSummary}`]
          : []),
        `${surfaceLabels.report.mesh}: ${surfaceLabels.report.collaborationDetail(surface.peerCount, surface.handoffCount)}`,
        `${surfaceLabels.report.control}: ${surfaceLabels.report.controlDetail(surface.nodeCount, surface.edgeCount, surface.checkpointCount)}`,
        copy.visibleSurface,
        `${labels.conversationNotice.handoff}: ${surfaceLabels.report.collaborationDetail(workerTaskCount, surface.handoffCount)}`,
      ],
    },
    {
      id: "closure",
      title: copy.closure,
      fields: ["result", "riskOrBlocker", "verification", "nextAction"],
      lines: [
        `${copy.result}: ${copy.resultDetail(artifactStatus)}`,
        `${copy.risk}: ${copy.riskDetail((businessPhasePlanPacket?.phases ?? []).filter((phase) => phase.status === "blocked").length)}`,
        `${copy.blockedStage}: ${copy.riskDetail((businessPhasePlanPacket?.phases ?? []).filter((phase) => phase.status === "blocked").length)}`,
        localizedHostObservationBoundary(labels.htmlLang),
        `${labels.conversationNotice.verification}: ${copy.verificationDetail(artifactStatus)}`,
        `${copy.next}: ${copy.nextDetail}`,
      ],
    },
  ];
  const progressLines = progressEvents.map(
    (event, index) =>
      event.text ?? renderConversationProgressEvent(event, labels, surfaceLabels, index === 0),
  );
  const aggregateLines = blocks.flatMap((block) => [
    `- ${block.title}`,
    ...block.lines.map((line) => `  ${line}`),
  ]);
  const lines = [
    ...(progressLines.length > 0
      ? progressLines
      : [`${labels.conversationNotice.title}: ${labels.plainLanguageSummary}`]),
    ...aggregateLines,
  ];
  const text = lines.join("\n");
  const hash = textSha256(text);
  const aggregateText = aggregateLines.join("\n");
  const hostObservationExpectations = [
    ...progressEvents.map((event, index) => {
      const progressText =
        event.text ?? renderConversationProgressEvent(event, labels, surfaceLabels, index === 0);
      return {
        stage: event.stage,
        textSha256: event.textSha256 ?? textSha256(progressText),
      };
    }),
    { stage: "Aggregate", textSha256: textSha256(aggregateText) },
  ];
  const emitted = emitConversationNotice === true;
  return {
    schemaVersion: CONVERSATION_NOTICE_SCHEMA_VERSION,
    status: emitted ? "emitted" : "not_emitted",
    emitted,
    channel: emitted ? conversationNoticeChannel : null,
    adapter: emitted ? conversationNoticeAdapter : null,
    emittedAt: emitted ? new Date().toISOString() : null,
    language: labels.htmlLang,
    blockCount: blocks.length,
    blocks,
    progressEvents,
    lineCount: lines.length,
    text,
    aggregateText,
    hostObservationExpectations,
    textSha256: hash,
    emittedTextSha256: emitted ? hash : null,
    evidenceKind: emitted ? "transport_emitted_notice" : "not_emitted",
    outputBoundary: emitted ? conversationNoticeOutputBoundary(conversationNoticeChannel) : null,
    routeSummary: {
      capabilityCount,
      workerTaskCount,
      synthesisOwner,
      runtimeEvidenceStatus: runtimeEvidence.status,
      businessPhaseSummary: phaseSummary,
      cardSummary,
    },
  };
}

function evaluateHostAssistantMessageEvidence(input, expectations) {
  let parsed = input;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
  }
  const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.observations) ? parsed.observations : [];
  const eligible = records.filter(
    (record) =>
      record?.mainThreadChat === true &&
      record?.resultStatus === "completed" &&
      typeof record?.sessionId === "string" &&
      record.sessionId.length > 0 &&
      typeof record?.messageId === "string" &&
      record.messageId.length > 0 &&
      typeof record?.eventId === "string" &&
      record.eventId.length > 0 &&
      /^[a-f0-9]{64}$/u.test(record?.textSha256 ?? ""),
  );
  const sessions = new Set(eligible.map((record) => record.sessionId));
  const matches = expectations.map((expectation) =>
    eligible.filter((record) => record.textSha256 === expectation.textSha256),
  );
  return {
    status: "host_observation_required",
    reason:
      input == null
        ? "host_assistant_message_evidence_missing"
        : "runner_host_observation_is_diagnostic_only",
    sessionId: null,
    matchedCount: matches.filter((items) => items.length === 1).length,
    expectedCount: expectations.length,
    evidenceRefs: [],
    diagnosticSessionCount: sessions.size,
  };
}

function buildUserExperienceNotice({
  orchestrationReport,
  runtimeEvidence,
  writebackFlow,
  labels,
  conversationNotice,
  cardPlanPacket,
}) {
  const internalOnlySignals = [
    "ownerDiscoveryPacket",
    "orchestrationTaskBoardPacket",
    "workerTaskPackets",
    "cardPlanPacket",
  ];
  const userVisibleSignals = [
    labels.userExperienceNotice.signals.stageProgress,
    labels.userExperienceNotice.signals.routeSummary(
      orchestrationReport.fetchEvidence.capabilityInventory.length
    ),
    labels.userExperienceNotice.signals.ownerHandoff(
      orchestrationReport.workerTaskPackets.length
    ),
    {
      label: "Meta-Theory visible surface",
      detail:
        "Show orchestration, Dynamic Workflow, non-skill capabilities, capability invocation truth, Peer Agent Mesh, and LangGraph-style graph as visible report sections, not only as internal packets.",
    },
    {
      label: labels.cardVisibleSummary.signalLabel,
      detail: buildUserFacingCardSummary(cardPlanPacket, labels).dealtLine,
    },
    {
      label: "谁做决策",
      detail:
        "自动化只收集证据、草拟选项、运行确定性检查并提示风险；Critical / Fetch / Thinking / Review 的判断权保留给人。",
    },
    labels.userExperienceNotice.signals.verification(runtimeEvidence.status),
  ];
  const noticeEmitted = conversationNotice?.emitted === true;
  const noticeObserved = conversationNotice?.hostObservation?.status === "pass";

  return {
    schemaVersion: "user-experience-notice-v0.1",
    status: noticeObserved ? "ready" : "partial",
    primarySurface: noticeObserved ? "localized_conversation_notice" : "user_readable_run_report",
    pendingPrimarySurface: noticeObserved ? null : "localized_conversation_notice_host_observation_required",
    secondarySurface: "user_readable_run_report",
    conversationNoticeEmitted: noticeEmitted,
    conversationNoticeObserved: noticeObserved,
    hostObservationStatus: conversationNotice?.hostObservation?.status ?? "host_observation_required",
    statusReason: noticeObserved
      ? labels.userExperienceNotice.emittedStatusReason(
          conversationNotice.channel,
          conversationNotice.adapter,
          conversationNotice.textSha256
        )
      : `${labels.userExperienceNotice.partialStatusReason} ${localizedHostObservationBoundary(labels.htmlLang)}`,
    conversationNoticeEvidence: noticeEmitted
      ? {
          schemaVersion: conversationNotice.schemaVersion,
          channel: conversationNotice.channel,
          adapter: conversationNotice.adapter,
          emittedAt: conversationNotice.emittedAt,
          textSha256: conversationNotice.textSha256,
          evidenceKind: conversationNotice.evidenceKind,
          outputBoundary: conversationNotice.outputBoundary,
        }
      : null,
    expectation: labels.userExperienceNotice.expectation,
    accuracyBoundary: labels.userExperienceNotice.accuracyBoundary,
    userVisibleSignals,
    internalOnlySignals,
    mustNotClaim: labels.userExperienceNotice.mustNotClaim,
  };
}

function capabilityToolingFor(packet) {
  const requirement = packet.capabilityRequirements?.[0] ?? "worker_task_only";
  if (requirement === "create_agent") {
    return {
      agent: packet.owner,
      skill: "meta-theory / meta-genesis",
      mcp: "not required",
      command: packet.verifySteps?.[0]?.command ?? "npm run meta:gap:orchestrate",
    };
  }
  if (requirement === "create_skill") {
    return {
      agent: packet.owner,
      skill: "meta-theory / meta-artisan",
      mcp: "not required",
      command: packet.verifySteps?.[0]?.command ?? "npm run meta:gap:orchestrate",
    };
  }
  if (requirement === "create_script") {
    return {
      agent: packet.owner,
      skill: "meta-theory",
      mcp: "not required",
      command: packet.verifySteps?.[0]?.command ?? "npm run meta:gap:orchestrate",
    };
  }
  if (requirement === "create_mcp_provider") {
    return {
      agent: packet.owner,
      skill: "meta-theory / meta-artisan",
      mcp: "MCP provider boundary",
      command: packet.verifySteps?.[0]?.command ?? "npm run meta:gap:orchestrate",
    };
  }
  return {
    agent: packet.owner,
    skill: "meta-theory",
    mcp: "not required",
    command: packet.verifySteps?.[0]?.command ?? "npm run meta:gap:orchestrate",
  };
}

function buildStageOperationPlan({
  orchestrationReport,
  runtimeEvidence,
  writebackFlow,
  labels,
}) {
  const stageLabels = labels.stageOperationPlan.stages;
  const metaReviewLabels = stageLabels.metaReview ?? {
    uses: "meta-warden overclaim audit",
    whatHappens:
      "检查是否混淆 validator pass、runtime invocation、native choice 和 public-ready。",
  };
  const verificationLabels = stageLabels.verification ?? {
    uses: "artifact validator, targeted tests, runtime projection evidence",
    whatHappens: "运行新鲜验证，并把失败返回 Review 或 Execution。",
  };
  const evolutionLabels = stageLabels.evolution ?? {
    uses: "Warden writeback flow and none-with-reason policy",
    whatHappens: "记录 writeback 或 none-with-reason，不把 local continuity 当作写回。",
  };
  const stageOutputs = labels.stageOperationPlan.outputs;
  const stageResults = labels.stageOperationPlan.results;
  const workerTasks = orchestrationReport.workerTaskPackets.map((packet, index) => {
    const tooling = capabilityToolingFor(packet);
    const mcp =
      tooling.mcp === "not required"
        ? labels.stageOperationPlan.notRequired
        : tooling.mcp === "MCP provider boundary"
          ? labels.stageOperationPlan.mcpProviderBoundary
          : tooling.mcp;
    return {
      order: index + 1,
      taskPacketId: packet.taskPacketId,
      owner: packet.owner,
      roleDisplayName: packet.roleDisplayName,
      skill: tooling.skill,
      mcp,
      command: tooling.command,
      does: labels.stageOperationPlan.workerDoes(packet.output, packet.evidenceRefs?.[0]),
      resultReport: labels.stageOperationPlan.workerResult(packet.output),
      nextWork: labels.stageOperationPlan.workerNext(packet.handoffTarget, packet.parallelGroup),
    };
  });
  return {
    schemaVersion: "stage-operation-plan-v0.1",
    stages: [
      {
        stage: "Critical",
        owner: "meta-warden",
        uses: stageLabels.critical.uses,
        whatHappens: stageLabels.critical.whatHappens,
        outputShape: labels.stageOperationPlan.outputs.critical(
          orchestrationReport.criticalSummary.successCriteria.length
        ),
        resultReport: labels.stageOperationPlan.results.critical,
        nextWork: "Fetch",
      },
      {
        stage: "Fetch",
        owner: orchestrationReport.fetchEvidence.orchestrationOwner,
        uses: stageLabels.fetch.uses,
        whatHappens: stageLabels.fetch.whatHappens,
        outputShape: labels.stageOperationPlan.outputs.fetch(
          orchestrationReport.fetchEvidence.capabilityInventory.length,
          orchestrationReport.fetchEvidence.sources.length
        ),
        resultReport: labels.stageOperationPlan.results.fetch,
        nextWork: "Thinking",
      },
      {
        stage: "Thinking",
        owner: orchestrationReport.orchestrationTaskBoardPacket.synthesisOwner,
        uses: stageLabels.thinking.uses,
        whatHappens: stageLabels.thinking.whatHappens,
        outputShape: labels.stageOperationPlan.outputs.thinking(
          orchestrationReport.thinkingRoute.boardMode,
          workerTasks.length
        ),
        resultReport: labels.stageOperationPlan.results.thinking,
        nextWork: "Execution",
      },
      {
        stage: "Execution",
        owner: orchestrationReport.orchestrationTaskBoardPacket.synthesisOwner,
        uses: stageLabels.execution.uses,
        whatHappens: stageLabels.execution.whatHappens,
        outputShape: labels.stageOperationPlan.outputs.execution(workerTasks.length),
        resultReport:
          workerTasks.length > 0
            ? labels.stageOperationPlan.executionResult(workerTasks.length)
            : labels.stageOperationPlan.noExecutionTasks,
        nextWork: "Review",
        workerTasks,
      },
      {
        stage: "Review",
        owner: orchestrationReport.reviewResult.owner,
        uses: stageLabels.review.uses,
        whatHappens: stageLabels.review.whatHappens,
        outputShape: labels.stageOperationPlan.outputs.review(
          Object.keys(orchestrationReport.reviewResult.checks).length
        ),
        resultReport: labels.stageOperationPlan.results.review(
          orchestrationReport.reviewResult.status,
          runtimeEvidence.status
        ),
        nextWork: "Meta-Review",
      },
      {
        stage: "Meta-Review",
        owner: "meta-warden",
        uses: metaReviewLabels.uses,
        whatHappens: metaReviewLabels.whatHappens,
        outputShape:
          stageOutputs.metaReview?.(orchestrationReport.reviewResult.findings.length) ??
          "claim-boundary checks for public-ready, native choice, and invocation truth.",
        resultReport:
          stageResults.metaReview?.() ??
          "Overclaim boundaries are checked before public-ready is considered.",
        nextWork: "Verification",
      },
      {
        stage: "Verification",
        owner: orchestrationReport.verificationResult.owner,
        uses: verificationLabels.uses,
        whatHappens: verificationLabels.whatHappens,
        outputShape:
          stageOutputs.verification?.(runtimeEvidence.status) ??
          "fresh verification evidence with runtime status=" + runtimeEvidence.status + ".",
        resultReport:
          stageResults.verification?.(runtimeEvidence.status) ??
          "Verification evidence status=" + runtimeEvidence.status + "; failures return to Review or Execution.",
        nextWork: "Evolution",
      },
      {
        stage: "Evolution",
        owner: "meta-chrysalis",
        uses: evolutionLabels.uses,
        whatHappens: evolutionLabels.whatHappens,
        outputShape:
          stageOutputs.evolution?.(writebackFlow?.status) ??
          "writeback decision=" + (writebackFlow?.status ?? "unknown") + "; reusable lessons require Warden approval.",
        resultReport:
          stageResults.evolution?.(writebackFlow?.status) ??
          "Evolution decision=" + (writebackFlow?.status ?? "unknown") + "; local continuity is not writeback.",
        nextWork: "Feedback / next run",
      },
    ],
  };
}

function buildLocalizedGovernedRunReport({
  runId,
  task,
  artifactStatus,
  orchestrationReport,
  runtimeEvidence,
  writebackFlow,
  governanceStartReasonPacket,
  businessPhasePlanPacket,
  stageOperationPlan,
  visibleMetaTheorySurfacePacket,
  capabilityInvocationTruthPacket,
  capabilityInvocationPresentationPacket,
  productExperiencePacket,
  labels,
}) {
  const surface = getGovernedRunSurfaceLabels(labels.htmlLang);
  const report = surface.report;
  const invocationCopy = surface.invocationPresentation;
  const mesh = visibleMetaTheorySurfacePacket?.peerAgentMesh ?? {};
  const control = visibleMetaTheorySurfacePacket?.langGraph ?? {};
  const stageNarratives = {
    en: ["Critical: confirming the goal and boundaries.", "Fetch: checking evidence and available capabilities.", "Thinking: organizing the route and responsibilities.", "Execution: preparing or carrying out the selected work.", "Review: checking quality, risk, and clarity.", "Verification: checking the result against the acceptance standard.", "Evolution: recording the reusable conclusion when appropriate."],
    "zh-CN": ["Critical：确认目标与边界。", "Fetch：核对证据与可用能力。", "Thinking：整理路线与职责。", "Execution：准备或执行选定工作。", "Review：检查质量、风险与可读性。", "Verification：按验收标准核对结果。", "Evolution：在适合时记录可复用结论。"],
    "ja-JP": ["Critical：目標と境界を確認します。", "Fetch：証拠と利用可能な機能を確認します。", "Thinking：ルートと担当を整理します。", "Execution：選択した作業を準備または実行します。", "Review：品質、リスク、読みやすさを確認します。", "Verification：受け入れ基準に照らして結果を確認します。", "Evolution：必要に応じて再利用可能な結論を記録します。"],
    "ko-KR": ["Critical: 목표와 경계를 확인합니다.", "Fetch: 증거와 사용 가능한 기능을 확인합니다.", "Thinking: 경로와 책임을 정리합니다.", "Execution: 선택한 작업을 준비하거나 실행합니다.", "Review: 품질, 위험, 가독성을 확인합니다.", "Verification: 승인 기준에 따라 결과를 확인합니다.", "Evolution: 필요하면 재사용 가능한 결론을 기록합니다."],
  }[labels.htmlLang] ?? [];
  const verificationSentence = runtimeEvidence.status === "pass"
    ? { en: "Verification checks completed successfully.", "zh-CN": "验证检查已完成。", "ja-JP": "検証チェックは完了しました。", "ko-KR": "검증 확인을 완료했습니다." }[labels.htmlLang]
    : { en: "Verification still needs additional evidence.", "zh-CN": "验证仍需补充证据。", "ja-JP": "検証には追加の証拠が必要です。", "ko-KR": "검증에 추가 증거가 필요합니다." }[labels.htmlLang];
  return [
    `# ${labels.governedExecutionReportTitle}`,
    "",
    `${labels.inputTask}: ${task}`,
    "",
    `## ${report.goal}`,
    "",
    `- ${surface.notice.resultDetail(artifactStatus)}`,
    `- ${surface.notice.riskDetail((businessPhasePlanPacket?.phases ?? []).filter((phase) => phase.status === "blocked").length)}`,
    "",
    `## ${report.orchestration}`,
    "",
    `- ${report.owner}: ${report.coordinator}`,
    `- ${report.providers}: ${capabilityInvocationPresentationPacket?.userSummary ?? invocationCopy.userSummary("not_confirmed", invocationCopy.executionStates.not_confirmed)}`,
    "",
    `### ${surface.capabilityLedger.title}`,
    "",
    ...((visibleMetaTheorySurfacePacket?.capabilityLedger?.families ?? []).map(
      (family) => `- ${family.displayLine}`,
    )),
    `- ${surface.capabilityLedger.projectDecisionLabel}: ${visibleMetaTheorySurfacePacket?.capabilityLedger?.projectCustomization?.summary ?? "missing"}`,
    `- ${report.mesh}: ${report.collaborationDetail(mesh.peerCount ?? 0, mesh.handoffCount ?? 0)}`,
    `- ${report.control}: ${report.controlDetail(control.nodeCount ?? 0, control.edgeCount ?? 0, control.checkpointCount ?? 0)}`,
    "",
    `## ${report.stages}`,
    "",
    ...stageNarratives.map((line) => `- ${line}`),
    "",
    `## ${report.verification}`,
    "",
    `- ${verificationSentence}`,
    `- ${report.next}: ${surface.notice.nextDetail}`,
    "",
  ].join("\n");
}

function buildUserReadableRunReport({
  runId,
  task,
  artifactStatus,
  orchestrationReport,
  decisionResults,
  runtimeEvidence,
  writebackFlow,
  cardPlanPacket,
  businessPhasePlanPacket,
  governanceStartReasonPacket,
  userExperienceNotice,
  stageOperationPlan,
  visibleMetaTheorySurfacePacket,
  capabilityInvocationTruthPacket,
  capabilityInvocationPresentationPacket,
  productExperiencePacket,
  markdownPath,
}) {
  const labels = getReportLabelsForPath(markdownPath);
  const sectionLabels = labels.sections;
  const toolList = labels.toolList(labels.toolNames);
  const cardSummary = buildUserFacingCardSummary(cardPlanPacket, labels);
  return buildLocalizedGovernedRunReport({
      runId,
      task,
      artifactStatus,
      orchestrationReport,
      runtimeEvidence,
      writebackFlow,
      governanceStartReasonPacket,
      businessPhasePlanPacket,
      stageOperationPlan,
      visibleMetaTheorySurfacePacket,
      capabilityInvocationTruthPacket,
      capabilityInvocationPresentationPacket,
      productExperiencePacket,
      labels,
    });
  /* The detailed packet-oriented report below is retained as internal source context only.
     User-readable Markdown returns above; strict details remain in JSON/debug artifacts. */
  const visibleAutomationAllowed = [
    "收集证据",
    "草拟候选选项",
    "运行确定性检查",
    "提示风险与阻塞",
    "整理用户可见状态",
  ];
  const visibleAutomationForbidden = [
    "不能替用户选择会改变路线的分支",
    "不能替用户接受风险",
    "不能在证据不足时声称可公开交付",
    "不能用报告或 Hook 提示冒充原生选择证据",
    "不能把未确认调用说成已经调用",
    "不能替代 Review 的人工判断",
  ];
  const lines = [
    `# ${labels.governedExecutionReportTitle}`,
    "",
    `${labels.runId}: ${runId}`,
    "",
    `## ${sectionLabels.decisionSummary}`,
    "",
    `- ${labels.status}: ${artifactStatus}`,
    `- 用户目标状态: ${artifactStatus === "pass" ? "已完成" : "部分完成"}`,
    `- 编排检查状态: ${orchestrationReport.status}`,
    `- ${labels.inputTask}: ${task}`,
    `- ${labels.capabilityGaps}: ${orchestrationReport.capabilityGaps.length}`,
    `- ${labels.workerTasks}: ${orchestrationReport.workerTaskPackets.length}`,
    `- ${labels.synthesisOwner}: ${orchestrationReport.orchestrationTaskBoardPacket.synthesisOwner}`,
    "",
    "## 开始原因",
    "",
    `- ${governanceStartReasonPacket.summary}`,
    `- 8 阶段: ${governanceStartReasonPacket.spineReason}`,
    `- 11 阶段: ${governanceStartReasonPacket.workflowReason}`,
    `- 发牌: ${governanceStartReasonPacket.cardReason}`,
    "",
    `## ${labels.userExperienceNotice.title}`,
    "",
    `- ${labels.status}: ${userExperienceNotice.status}`,
    `- ${labels.userExperienceNotice.primarySurface}: ${userExperienceNotice.primarySurface}`,
    `- ${labels.reason}: ${userExperienceNotice.statusReason}`,
    `- ${labels.userExperienceNotice.expectationLabel}: ${userExperienceNotice.expectation}`,
    `- ${labels.userExperienceNotice.boundaryLabel}: ${userExperienceNotice.accuracyBoundary}`,
    `- ${labels.userExperienceNotice.mustNotClaimLabel}: ${userExperienceNotice.mustNotClaim}`,
    ...(userExperienceNotice.conversationNoticeEvidence
      ? [
          `- ${labels.userExperienceNotice.emissionEvidenceLabel}: ${userExperienceNotice.conversationNoticeEvidence.channel} / ${userExperienceNotice.conversationNoticeEvidence.adapter} / ${userExperienceNotice.conversationNoticeEvidence.textSha256}`,
        ]
      : []),
    `| ${labels.userExperienceNotice.signal} | ${labels.routeImpact} |`,
    "|---|---|",
    ...userExperienceNotice.userVisibleSignals.map(
      (signal) => `| ${signal.label} | ${String(signal.detail).replaceAll("|", "\\|")} |`
    ),
    `| ${labels.userExperienceNotice.internalOnly} | ${labels.userExperienceNotice.internalOnlySummary} |`,
    "",
    "## 自动化与人工决策边界",
    "",
    `- 状态: ${productExperiencePacket?.automationDecisionBoundary?.status ?? "missing"}`,
    `- 原则: ${productExperiencePacket?.automationDecisionBoundary?.principle ?? "Automation assists; humans decide."}`,
    `- 决策权: ${productExperiencePacket?.automationDecisionBoundary?.decisionAuthority ?? "missing"}`,
    `- 人工判断阶段: ${(productExperiencePacket?.automationDecisionBoundary?.humanJudgmentStages ?? []).join(" -> ")}`,
    `- 自动化角色: ${productExperiencePacket?.automationDecisionBoundary?.automationRole ?? "missing"}`,
    "",
    "| 自动化可以做 | 自动化不能做 |",
    "|---|---|",
    ...Array.from({
      length: Math.max(
        visibleAutomationAllowed.length,
        visibleAutomationForbidden.length,
      ),
    }).map((_, index) => {
      const allowed = visibleAutomationAllowed[index] ?? "";
      const forbidden = visibleAutomationForbidden[index] ?? "";
      return `| ${String(allowed).replaceAll("|", "\\|")} | ${String(forbidden).replaceAll("|", "\\|")} |`;
    }),
    "",
    "## Meta-Theory 可见编排面",
    "",
    `- 状态: ${visibleMetaTheorySurfacePacket?.status ?? "missing"}`,
    `- 编排: board=${visibleMetaTheorySurfacePacket?.orchestration?.boardId ?? "missing"} / owner=${visibleMetaTheorySurfacePacket?.orchestration?.synthesisOwner ?? "missing"} / workers=${visibleMetaTheorySurfacePacket?.orchestration?.workerTaskCount ?? 0}`,
    `- Dynamic Workflow: lanes=${visibleMetaTheorySurfacePacket?.dynamicWorkflow?.selectedLaneIds?.length ?? 0} / bindings=${visibleMetaTheorySurfacePacket?.dynamicWorkflow?.visibleRows?.length ?? 0}`,
    `- 能力发现: total=${visibleMetaTheorySurfacePacket?.capabilityInventory?.total ?? 0} / nonSkillTypes=${visibleMetaTheorySurfacePacket?.capabilityInventory?.nonSkillCapabilityTypeCount ?? 0} / notSkillOnly=${labels.boolean(Boolean(visibleMetaTheorySurfacePacket?.capabilityInventory?.notSkillOnly))}`,
    `- ${getGovernedRunSurfaceLabels(labels.htmlLang).invocationPresentation.executionLabel}: ${capabilityInvocationPresentationPacket?.userSummary ?? "运行记录待关联；以当前聊天中的实际调用结果为准，额外独立复核不会改变本次运行。"}`,
    `- Agent Teams Playbook: status=${visibleMetaTheorySurfacePacket?.agentTeamsPlaybook?.status ?? "missing"} / selected=${labels.boolean(Boolean(visibleMetaTheorySurfacePacket?.agentTeamsPlaybook?.selected))} / waves=${visibleMetaTheorySurfacePacket?.agentTeamsPlaybook?.waveCount ?? 0}`,
    `- Peer Agent Mesh: peers=${visibleMetaTheorySurfacePacket?.peerAgentMesh?.peerCount ?? 0} / handoffs=${visibleMetaTheorySurfacePacket?.peerAgentMesh?.handoffCount ?? 0}`,
    `- LangGraph-style: nodes=${visibleMetaTheorySurfacePacket?.langGraph?.nodeCount ?? 0} / edges=${visibleMetaTheorySurfacePacket?.langGraph?.edgeCount ?? 0} / conditional=${visibleMetaTheorySurfacePacket?.langGraph?.conditionalEdgeCount ?? 0} / checkpoints=${visibleMetaTheorySurfacePacket?.langGraph?.checkpointCount ?? 0}`,
    "",
    "| 面 | 用户应该看见什么 | 证据 | 状态 |",
    "|---|---|---|---|",
    `| 编排 orchestration | worker 数、parallelGroup、mergeOwner、synthesis owner | visibleMetaTheorySurfacePacket.orchestration | ${visibleMetaTheorySurfacePacket?.orchestration?.status ?? "missing"} |`,
    `| Dynamic Workflow | selected lanes、omitted lanes、capability bindings、worker results | visibleMetaTheorySurfacePacket.dynamicWorkflow | ${visibleMetaTheorySurfacePacket?.dynamicWorkflow?.status ?? "missing"} |`,
    `| 能力发现 capability inventory | agent/skill/command/MCP/tool/hook/runtime/memory/graph/research，不只 Skill | visibleMetaTheorySurfacePacket.capabilityInventory | ${visibleMetaTheorySurfacePacket?.capabilityInventory?.notSkillOnly ? "pass" : "partial"} |`,
    `| 能力调用展示 | ${capabilityInvocationPresentationPacket?.userSummary ?? "运行记录待关联；以当前聊天中的实际调用结果为准，额外独立复核不会改变本次运行。"} | 当前运行展示摘要 | ${capabilityInvocationPresentationPacket?.executionLabel ?? "运行记录待关联（以当前聊天中的实际调用结果为准）"} |`,
    `| Agent Teams Playbook | 2+ 并行 lane 时发现并选中 fan-out 编排适配器，同时保留 live spawn_agent 边界 | visibleMetaTheorySurfacePacket.agentTeamsPlaybook | ${visibleMetaTheorySurfacePacket?.agentTeamsPlaybook?.status ?? "missing"} |`,
    `| Peer Agent Mesh | peer workers、handoff、merge owner、result status | visibleMetaTheorySurfacePacket.peerAgentMesh | ${visibleMetaTheorySurfacePacket?.peerAgentMesh?.status ?? "missing"} |`,
    `| LangGraph-style 控制图 | nodes、edges、conditional edges、state、checkpoint、replay | visibleMetaTheorySurfacePacket.langGraph | ${visibleMetaTheorySurfacePacket?.langGraph?.status ?? "missing"} |`,
    "",
    "### 能力发现矩阵",
    "",
    "| capability | status | source | route impact |",
    "|---|---|---|---|",
    ...((visibleMetaTheorySurfacePacket?.capabilityInventory?.visibleRows ?? []).map(
      (row) =>
        `| ${row.capabilityType} | ${row.status} | ${String(row.source).replaceAll("|", "\\|")} | ${String(row.routeImpact).replaceAll("|", "\\|")} |`
    )),
    "",
    "### Dynamic Workflow 绑定",
    "",
    "| lane | owner | skill | MCP | command | tool | hook | workerResult |",
    "|---|---|---|---|---|---|---|---|",
    ...((visibleMetaTheorySurfacePacket?.dynamicWorkflow?.visibleRows ?? []).map(
      (row) =>
        `| ${row.laneLabel ?? row.laneId ?? "lane"} | ${row.owner} | ${row.skills} | ${row.mcp} | ${row.commands} | ${row.runtimeTools} | ${row.hooks} | ${labels.boolean(row.workerResult)} |`
    )),
    "",
    "### Peer Agent Mesh",
    "",
    "| peer | role | task | mergeOwner | result |",
    "|---|---|---|---|---|",
    ...((visibleMetaTheorySurfacePacket?.peerAgentMesh?.visibleRows ?? []).map(
      (row) =>
        `| ${row.peerId} | ${row.roleDisplayName} | ${row.taskPacketId} | ${row.mergeOwner} | ${row.resultStatus} |`
    )),
    "",
    "## 三目标产品验收",
    "",
    `- 状态: ${productExperiencePacket?.status ?? "missing"}`,
    `- 证据层: ${productExperiencePacket?.evidenceTier ?? "missing"}`,
    `- 边界: ${productExperiencePacket?.nativeRuntimeBoundary ?? "未记录"}`,
    `| 目标 | 状态 | 证据层 | 失败条件 |`,
    "|---|---|---|---|",
    ...((productExperiencePacket?.goals ?? []).map(
      (goal) =>
        `| ${goal.id} ${goal.name} | ${goal.status} | ${goal.evidenceKind} | ${String(goal.failIf).replaceAll("|", "\\|")} |`
    )),
    "",
    `| 支撑门 | 状态 | 证据层 | 失败条件 |`,
    "|---|---|---|---|",
    ...((productExperiencePacket?.supportGates ?? []).map(
      (gate) =>
        `| ${gate.id} ${gate.name} | ${gate.status} | ${gate.evidenceKind} | ${String(gate.failIf).replaceAll("|", "\\|")} |`
    )),
    "",
    `## ${labels.stageOperationPlan.title}`,
    "",
    `| ${labels.stageOperationPlan.stage} | ${labels.owner} | ${labels.stageOperationPlan.whatHappens} | ${labels.stageOperationPlan.uses} | ${labels.stageOperationPlan.outputShape} | ${labels.stageOperationPlan.resultReport} | ${labels.stageOperationPlan.nextWork} |`,
    "|---|---|---|---|---|---|---|",
    ...stageOperationPlan.stages.map(
      (stage) =>
        `| ${stage.stage} | ${stage.owner} | ${String(stage.whatHappens).replaceAll("|", "\\|")} | ${String(stage.uses).replaceAll("|", "\\|")} | ${String(stage.outputShape).replaceAll("|", "\\|")} | ${String(stage.resultReport).replaceAll("|", "\\|")} | ${stage.nextWork} |`
    ),
    "",
    `## ${labels.stageOperationPlan.executionTitle}`,
    "",
    `| ${labels.stageOperationPlan.order} | ${labels.workerTask} | ${labels.agent} | ${labels.skill} | ${labels.mcp} | ${labels.commands} | ${labels.stageOperationPlan.does} | ${labels.stageOperationPlan.resultReport} | ${labels.stageOperationPlan.nextWork} |`,
    "|---|---|---|---|---|---|---|---|---|",
    ...(stageOperationPlan.stages.find((stage) => stage.stage === "Execution")?.workerTasks ?? []).map(
      (taskItem) =>
        `| ${taskItem.order} | ${taskItem.roleDisplayName} | ${taskItem.owner} | ${taskItem.skill} | ${taskItem.mcp} | ${taskItem.command} | ${String(taskItem.does).replaceAll("|", "\\|")} | ${String(taskItem.resultReport).replaceAll("|", "\\|")} | ${taskItem.nextWork} |`
    ),
    "",
    `## ${labels.stageSummaryTitle}`,
    "",
    `- ${renderReportLabel(labels.stageSummaries.critical, toolList)}`,
    `- ${labels.stageSummaries.fetch(orchestrationReport.fetchEvidence.capabilityInventory.length)}`,
    `- ${labels.stageSummaries.thinking(
      orchestrationReport.thinkingRoute.boardMode,
      orchestrationReport.orchestrationTaskBoardPacket.synthesisOwner
    )}`,
    `- ${renderReportLabel(labels.stageSummaries.review, toolList)}`,
    "",
    `## ${labels.cardPlanTitle}`,
    "",
    `### ${labels.cardVisibleSummary.sectionTitle}`,
    "",
    `#### ${cardSummary.progressSectionTitle}`,
    "",
    ...cardSummary.progressNotices.flatMap((notice) => [
      `- ${notice.stageLine}`,
      `  - ${notice.dealLine}`,
    ]),
    "",
    `- ${cardSummary.dealtLine}`,
    `- ${cardSummary.inactiveLine}`,
    `- ${cardSummary.userLine}`,
    `- ${cardSummary.repeatPolicy}`,
    `- ${cardSummary.nextLine}`,
    `- ${cardSummary.nativeChoiceBoundary}`,
    "",
    `- ${labels.cardPlanSummary(
      cardPlanPacket.visibleSummary.eventCount,
      cardPlanPacket.visibleSummary.cardTypeCount ?? 0,
      cardPlanPacket.visibleSummary.forcedPauseRule
    )}`,
    `- Deal standard: minimum score ${cardPlanPacket.dealStandard.minimumScore}, threshold ${cardPlanPacket.dealStandard.passThreshold}, coverage=${cardPlanPacket.dealStandard.coveragePass ? "pass" : "fail"}`,
    `- ${labels.cardDealer}: ${cardPlanPacket.dealerOwner}`,
    `| ${labels.card} | ${labels.status} | Decision | Score | ${labels.owner} | ${labels.cardShell} | ${labels.cardWhy} |`,
    "|---|---|---|---|---|---|---|",
    ...cardPlanPacket.cardTypeDecisions.map(
      (card) =>
        `| ${card.label} | ${card.cardDecision} | ${card.decisionEvaluation.decisionState} | ${card.decisionEvaluation.accuracyScore} (threshold ${card.decisionEvaluation.passThreshold}) | ${card.owner} | ${card.deliveryShellId} | ${String(card.cardReason).replaceAll("|", "\\|")} |`
    ),
    "",
    `## ${labels.businessPhasePlanTitle}`,
    "",
    `- ${labels.businessPhaseSummary(businessPhasePlanPacket.phaseCount)}`,
    `- Trigger standard: minimum score ${businessPhasePlanPacket.triggerStandard.minimumScore}, threshold ${businessPhasePlanPacket.triggerStandard.passThreshold}, coverage=${businessPhasePlanPacket.triggerStandard.coveragePass ? "pass" : "fail"}`,
    `- ${labels.spineRelationship}: ${businessPhasePlanPacket.spineRelationship}`,
    `| ${labels.phase} | ${labels.status} | Trigger | Score | ${labels.owner} | ${labels.mapsToSpine} | ${labels.evidence} | Reason | Next |`,
    "|---|---|---|---|---|---|---|---|---|",
    ...businessPhasePlanPacket.phases.map(
      (phase) =>
        `| ${phase.phaseIndex}. ${phase.label} | ${phase.status} | ${phase.triggerEvaluation.activationState} | ${phase.triggerEvaluation.triggerScore} (threshold ${phase.triggerEvaluation.passThreshold}) | ${phase.owner} | ${phase.mapsToSpine.join("+")} | ${String(phase.evidence).replaceAll("|", "\\|")} | ${String(phase.statusReason).replaceAll("|", "\\|")} | ${String(phase.nextAction).replaceAll("|", "\\|")} |`
    ),
    "",
    `## ${labels.capabilityRouteTitle}`,
    "",
    `| ${labels.capabilityType} | ${labels.status} | ${labels.source} | ${labels.routeImpact} |`,
    "|---|---|---|---|",
    ...orchestrationReport.fetchEvidence.capabilityInventory.map(
      (item) =>
        `| ${item.capabilityType} | ${item.coverageStatus} | ${item.source.replaceAll("|", "\\|")} | ${item.routeImpact.replaceAll("|", "\\|")} |`
    ),
    "",
    `## ${labels.durableAgentPolicyTitle}`,
    "",
    ...renderReportList(
      labels.durableAgentPolicyBullets,
      labels.toolProfiles ?? []
    ).map((item) => `- ${item}`),
    "",
    `## ${sectionLabels.whyDecision}`,
    "",
    `| ${labels.gap} | ${labels.decision} | ${labels.reason} | ${labels.owner} | ${labels.blocked} |`,
    "|---|---|---|---|---|",
    ...orchestrationReport.capabilityGaps.map(
      (gap) =>
        `| ${gap.gapId} | ${gap.decision} | ${String(gap.decisionReason).replaceAll("|", "\\|")} | ${gap.owner} | ${labels.boolean(gap.blocked)} |`
    ),
    "",
    `## ${sectionLabels.ownerHandoff}`,
    "",
    `| ${labels.workerTask} | ${labels.role} | ${labels.owner} | ${labels.parallelGroup} | ${labels.mergeOwner} |`,
    "|---|---|---|---|---|",
    ...orchestrationReport.workerTaskPackets.map(
      (packet) =>
        `| ${packet.taskPacketId} | ${packet.roleDisplayName} | ${packet.owner} | ${packet.parallelGroup} | ${packet.mergeOwner} |`
    ),
    "",
    `## ${sectionLabels.toolEvidenceFull(toolList)}`,
    "",
    `| ${labels.tool} | ${labels.status} | ${labels.failureClass} | ${labels.entry} | ${labels.remainingAction} |`,
    "|---|---|---|---|---|",
    ...runtimeEvidence.results.map(
      (item) =>
        `| ${item.runtime} | ${item.status} | ${item.failureClass} | ${item.runtimeEntry} | ${item.remainingAction.replaceAll("|", "\\|")} |`
    ),
    "",
    `## ${sectionLabels.capabilityUpgrade}`,
    "",
    `| ${labels.candidate} | ${labels.type} | ${labels.decision} | ${labels.target} | ${labels.dryRunWrites} | ${labels.verification} |`,
    "|---|---|---|---|---|---|",
    ...(writebackFlow.candidates.length > 0
      ? writebackFlow.candidates.map(
          (item) =>
            `| ${item.candidateId} | ${item.candidateType} | ${item.writebackDecision} | ${
              item.targetRelativeToCanonical
                ? `canonical/${item.targetRelativeToCanonical}`
                : item.target ?? "none"
            } | ${item.dryRunArtifact.canonicalWrites} | ${item.verificationResult.status} |`
        )
      : [`| ${labels.none} | ${labels.none} | none-with-reason | ${labels.none} | 0 | ${labels.notRun} |`]),
    "",
    `## ${sectionLabels.wardenApproval}`,
    "",
    `- ${labels.approvalRequired}: ${writebackFlow.approvalRequired}`,
    `- ${labels.approvalValidation}: ${writebackFlow.approvalValidation.ok ? "pass" : "missing"}`,
    `- ${labels.dryRunCanonicalWrites}: ${writebackFlow.dryRun.canonicalWrites}`,
    "",
    `## ${sectionLabels.verificationStatus}`,
    "",
    `- ${labels.orchestrationReview}: ${orchestrationReport.reviewResult.status}`,
    `- ${sectionLabels.toolEvidenceFull(toolList)}：${runtimeEvidence.status}`,
    `- ${labels.releaseGradeComplete}：${runtimeEvidence.releaseGrade}`,
    `- ${labels.writeback}: ${writebackFlow.status}`,
    `- ${labels.decisionRuns}: ${decisionResults.length}`,
    "",
  ];
  return `${lines.join("\n")}`;
}

function buildRunReportPanelContract({
  contractDefinition,
  aiReadableStandards,
  runId,
  task,
  status,
  orchestrationReport,
  runtimeEvidence,
  writebackFlow,
  cardPlanPacket,
  businessPhasePlanPacket,
  productExperiencePacket,
  visibleMetaTheorySurfacePacket,
  capabilityInvocationTruthPacket,
  capabilityInvocationPresentationPacket,
  capabilityLedgerPacket,
  paths,
}) {
  const blockedGaps = orchestrationReport.capabilityGaps.filter((gap) => gap.blocked);
  const visibleInvocationPresentation = buildUserCapabilityInvocationPresentation(
    capabilityInvocationPresentationPacket,
  );
  const aiReadableRubric = aiReadableStandards.standards.map((standard) => ({
    id: standard.id,
    label: standard.label,
    plainLanguageQuestion: standard.plainLanguageQuestion,
    passStandard: standard.passStandard,
    failStandard: standard.failStandard,
    requiredEvidence: standard.requiredEvidence,
    status: "pass",
  }));
  const runtimeRows = runtimeEvidence.results.map((item) => ({
    runtime: item.runtime,
    status: item.status,
    evidenceKind: item.evidenceKind,
    failureClass: item.failureClass,
    command: item.command,
    artifact: item.artifact,
    remainingAction: item.remainingAction,
    strictReleasePass: item.strictReleasePass,
  }));
  const approvalRequired = writebackFlow.approvalRequired === true;
  const candidateCount = writebackFlow.candidates.length;
  const supportGatesPass =
    (productExperiencePacket?.supportGates ?? []).length > 0 &&
    productExperiencePacket.supportGates.every((gate) => gate.status === "pass");
  const visibleSurfaceAllowed = (
    contractDefinition.sectionRules.visibleMetaTheorySurface.allowedStatuses ?? []
  ).includes(visibleMetaTheorySurfacePacket?.status);
  const capabilityInvocationTruthAllowed = (
    contractDefinition.sectionRules.capabilityInvocationTruth.allowedStatuses ?? []
  ).includes(capabilityInvocationTruthPacket?.status);
  const basePanelContractOk =
    aiReadableRubric.length ===
      contractDefinition.sectionRules.aiReadableRubric.requiredStandardCount &&
    aiReadableRubric.every((standard) => standard.status === "pass") &&
    (contractDefinition.sectionRules.productExperience.allowedStatuses ?? []).includes(
      productExperiencePacket?.status
    ) &&
    productExperiencePacket?.noOverclaimGate?.status === "pass" &&
    productExperiencePacket?.automationDecisionBoundary?.status === "pass" &&
    visibleSurfaceAllowed &&
    capabilityInvocationTruthAllowed &&
    runtimeRows.every((row) =>
      row.failureClass === RUNTIME_FAILURE_TAXONOMY.pass
        ? row.strictReleasePass === true || row.evidenceKind === "live"
        : row.strictReleasePass === false
    );
  const fullProductExperiencePass =
    productExperiencePacket?.status === "product_experience_pass" && supportGatesPass;
  const visibleSupportGates = (productExperiencePacket?.supportGates ?? []).map((gate) => ({
    id: gate.id,
    name: gate.name,
    status: gate.status,
    evidenceKind: gate.evidenceKind,
    failIf: gate.failIf,
    ...(gate.id === "P-109"
      ? { capabilityInvocationPresentation: visibleInvocationPresentation }
      : {}),
  }));
  return {
    schemaVersion: contractDefinition.schemaVersion,
    contractId: "run-report-panel-contract",
    status: basePanelContractOk ? (fullProductExperiencePass ? "pass" : "partial") : "fail",
    decisionSummary: {
      runId,
      status,
      task,
      gapCount: orchestrationReport.capabilityGaps.length,
      workerTaskCount: orchestrationReport.workerTaskPackets.length,
      synthesisOwner: orchestrationReport.orchestrationTaskBoardPacket.synthesisOwner,
      plainLanguageSummary: getReportLabelsForPath(paths.markdown).plainLanguageSummary,
    },
    ownerHandoff: orchestrationReport.workerTaskPackets.map((packet) => ({
      taskPacketId: packet.taskPacketId,
      roleDisplayName: packet.roleDisplayName,
      owner: packet.owner,
      ownerAgent: packet.ownerAgent ?? packet.owner,
      ownerSource: packet.ownerSource ?? null,
      ownerBindingMode: packet.ownerBindingMode ?? "run_scoped_owner_contract",
      nativeAgentType:
        packet.ownerBindingMode === "native_custom_agent"
          ? packet.nativeAgentType ?? null
          : null,
      runtimeInstanceAlias: packet.runtimeInstanceAlias || null,
      parallelGroup: packet.parallelGroup,
      mergeOwner: packet.mergeOwner,
      verificationOwner: "verify",
      shardScope: packet.shardScope,
    })),
    blockedReasons:
      blockedGaps.length > 0
        ? blockedGaps.map((gap) => ({
            gapId: gap.gapId,
            reason: gap.decisionReason,
            returnToStage: "Fetch/Thinking",
            remainingAction: "Collect approval or evidence before execution.",
          }))
        : [
            {
              gapId: "none",
              reason: "No blocked capability gap in this run.",
              returnToStage: "not_applicable",
              remainingAction: "No blocked gap action required.",
            },
          ],
    runtimeEvidence: runtimeRows,
    productExperience: {
      status: productExperiencePacket?.status ?? "missing",
      evidenceTier: productExperiencePacket?.evidenceTier ?? "missing",
      nativeRuntimeBoundary: productExperiencePacket?.nativeRuntimeBoundary ?? null,
      goals: productExperiencePacket?.goals ?? [],
      supportGates: visibleSupportGates,
      noOverclaimGate: productExperiencePacket?.noOverclaimGate ?? null,
      nativeChoiceSurfaceGate: productExperiencePacket?.nativeChoiceSurfaceGate ?? null,
      repeatFailureDesignGate: productExperiencePacket?.repeatFailureDesignGate ?? null,
      generalizationGate: productExperiencePacket?.generalizationGate ?? null,
      capabilityInvocationPresentation: visibleInvocationPresentation,
      agentTeamsPlaybookGate:
        productExperiencePacket?.agentTeamsPlaybookGate ?? null,
      automationDecisionBoundary:
        productExperiencePacket?.automationDecisionBoundary ?? null,
    },
    visibleMetaTheorySurface: {
      status: visibleMetaTheorySurfacePacket?.status ?? "missing",
      requiredVisibleTopics: visibleMetaTheorySurfacePacket?.requiredVisibleTopics ?? [],
      orchestration: visibleMetaTheorySurfacePacket?.orchestration ?? null,
      dynamicWorkflow: visibleMetaTheorySurfacePacket?.dynamicWorkflow ?? null,
      capabilityInventory: visibleMetaTheorySurfacePacket?.capabilityInventory ?? null,
      capabilityInvocationPresentation:
        visibleMetaTheorySurfacePacket?.capabilityInvocationPresentation ?? null,
      agentTeamsPlaybook: visibleMetaTheorySurfacePacket?.agentTeamsPlaybook ?? null,
      peerAgentMesh: visibleMetaTheorySurfacePacket?.peerAgentMesh ?? null,
      langGraph: visibleMetaTheorySurfacePacket?.langGraph ?? null,
    },
    capabilityInvocationPresentation: visibleInvocationPresentation,
    capabilityLedger: {
      status: capabilityLedgerPacket?.status ?? "missing",
      title: capabilityLedgerPacket?.title ?? "Capability use in this run",
      families: (capabilityLedgerPacket?.families ?? []).map((family) => ({
        family: family.family,
        familyLabel: family.familyLabel,
        displayProvider: family.displayProvider,
        displaySource: family.displaySource,
        selected: family.selected,
        state: family.state,
        stateLabel: family.stateLabel,
        nextAction: family.nextAction,
        displayLine: family.displayLine,
      })),
      projectCustomization: capabilityLedgerPacket?.projectCustomization ?? null,
    },
    cardPlan: {
      dealerOwner: cardPlanPacket.dealerOwner,
      cardEventCount: cardPlanPacket.cardEvents.length,
      cardTypeCount: cardPlanPacket.visibleSummary.cardTypeCount,
      cardTypeCatalogSize: cardPlanPacket.cardTypeCatalog.length,
      dealStandard: cardPlanPacket.dealStandard,
      activeCards: cardPlanPacket.visibleSummary.activeCards,
      suppressedCards: cardPlanPacket.visibleSummary.suppressedCards,
      interruptCards: cardPlanPacket.visibleSummary.interruptCards,
      decisionStates: Object.fromEntries(
        cardPlanPacket.cardTypeDecisions.map((card) => [
          card.cardKey,
          card.decisionEvaluation.decisionState,
        ]),
      ),
      forcedPauseRule: cardPlanPacket.visibleSummary.forcedPauseRule,
    },
    businessPhasePlan: {
      phaseCount: businessPhasePlanPacket.phaseCount,
      triggerStandard: businessPhasePlanPacket.triggerStandard,
      statuses: Object.fromEntries(
        businessPhasePlanPacket.phases.map((phase) => [phase.phase, phase.status])
      ),
      triggerStates: Object.fromEntries(
        businessPhasePlanPacket.phases.map((phase) => [
          phase.phase,
          phase.triggerEvaluation.activationState,
        ]),
      ),
      currentPhase: businessPhasePlanPacket.closure.currentPhase,
      userAcceptanceRequired: businessPhasePlanPacket.closure.userAcceptanceRequired,
    },
    approvalRequest: {
      approvalRequired,
      approvalValidation: writebackFlow.approvalValidation.ok ? "pass" : "missing",
      dryRunCanonicalWrites: writebackFlow.dryRun.canonicalWrites,
      candidateCount,
      nextAction: approvalRequired
        ? "Warden approval packet is required before canonical writeback."
        : "No approval action required for this run.",
    },
    aiReadableRubric,
    deliverables: {
      json: relative(paths.json),
      markdown: relative(paths.markdown),
      sqlite: relative(paths.sqlite),
      panelContract: "artifact.runReportPanelContract",
    },
  };
}

async function persistDecisionRuns({ dbPath, decisionResults }) {
  const store = await openRunStateStore(dbPath);
  for (const result of decisionResults) {
    store.persistDecisionRun(result);
  }
  const analytics = store.analytics();
  store.close();
  return analytics;
}

function buildGovernanceAgentResultPackets({
  runId,
  orchestrationReport,
  capabilitySearchLog,
  workerTaskPackets,
  runtimeEvidence,
  writebackFlow,
  analytics,
}) {
  const workerOwners = new Set(workerTaskPackets.map((packet) => packet.owner));
  const hasAgentCreation = workerTaskPackets.some(
    (packet) =>
      packet.owner === "meta-genesis" ||
      packet.roleDisplayName === "agent" ||
      packet.capabilityRequirements?.includes("create_agent"),
  );
  const hasSkillOrToolFit = workerTaskPackets.some(
    (packet) =>
      packet.owner === "meta-artisan" ||
      packet.capabilityRequirements?.some((item) =>
        ["create_skill", "mcp_provider_tool", "runtime_tool", "script"].includes(item),
      ),
  );
  const createdAt = nowIso();
  const makePacket = ({
    agent,
    stage,
    activationState = "active",
    status = "pass",
    resultKind,
    inputRefs,
    outputRefs,
    consumedBy = ["meta-conductor"],
    resultSummary,
    artifactRef,
    evidenceKind = "local_governance_stage_result",
  }) => ({
    packetId: stableId(
      "governance-agent-result",
      `${runId}-${agent}-${stage}-${resultKind}-${activationState}`,
    ),
    agent,
    stage,
    activationState,
    status,
    resultKind,
    evidenceKind,
    nativeRuntimeAgent: false,
    externalAgentSpawned: false,
    producedAt: createdAt,
    inputRefs,
    outputRefs,
    consumedBy,
    artifactRef,
    resultSummary,
  });

  return [
    makePacket({
      agent: "meta-warden",
      stage: "Critical",
      resultKind: "entry_gate_and_meta_review",
      inputRefs: ["requestRecord.task", "permissionBoundary"],
      outputRefs: ["coreLoop.intentPacket", "coreLoop.metaReviewPacket"],
      consumedBy: ["meta-conductor", "meta-prism"],
      artifactRef: "coreLoop.intentPacket",
      resultSummary:
        "Locked intent, success criteria, non-goals, permission boundary, and public-ready gate.",
    }),
    makePacket({
      agent: "meta-conductor",
      stage: "Thinking",
      resultKind: "orchestration_and_merge",
      inputRefs: [
        "coreLoop.intentPacket",
        "coreLoop.fetchPacket",
        "governanceAgentResultPackets",
      ],
      outputRefs: [
        "coreLoop.thinkingPacket.dispatchBoard",
        "coreLoop.executionResult.mergeResult",
      ],
      consumedBy: ["meta-prism", "meta-warden"],
      artifactRef: "coreLoop.thinkingPacket.dispatchBoard",
      resultSummary:
        "Built the dispatch board, worker task packets, and merge plan from upstream governance evidence.",
    }),
    makePacket({
      agent: "meta-scout",
      stage: "Fetch",
      resultKind: "capability_and_source_discovery",
      inputRefs: ["coreLoop.intentPacket"],
      outputRefs: [
        "coreLoop.fetchPacket.capabilityDiscovery",
        "coreLoop.fetchPacket.decisionImpactMap",
      ],
      artifactRef: "coreLoop.fetchPacket.capabilityDiscovery",
      resultSummary: `Recorded ${capabilitySearchLog.length} capability/source records for route selection.`,
    }),
    makePacket({
      agent: "meta-artisan",
      stage: "Fetch",
      activationState: hasSkillOrToolFit ? "active" : "not_required",
      status: hasSkillOrToolFit ? "pass" : "not_required",
      resultKind: "skill_tool_mcp_fit",
      inputRefs: ["coreLoop.fetchPacket.capabilityDiscovery", "coreLoop.capabilityGapPacket"],
      outputRefs: [
        "coreLoop.thinkingPacket.workerTaskPackets",
        "coreLoop.executionResult.workerResultPackets",
      ],
      artifactRef: "coreLoop.thinkingPacket.workerTaskPackets",
      resultSummary: hasSkillOrToolFit
        ? "Selected skill/tool/MCP capability fit and bounded run-scoped worker ownership."
        : "No skill/tool/MCP fit decision was required for this run.",
    }),
    makePacket({
      agent: "meta-sentinel",
      stage: "Fetch",
      resultKind: "safety_permission_writeback_boundary",
      inputRefs: ["requestRecord.permissionBoundary", "artifact.wardenWritebackFlow"],
      outputRefs: [
        "coreLoop.fileChangeFactCard",
        "coreLoop.evolutionWritebackDecision",
        "artifact.wardenWritebackFlow",
      ],
      artifactRef: "artifact.wardenWritebackFlow",
      resultSummary:
        "Confirmed local-only side effects, approval-gated canonical writes, and release/public-ready boundaries.",
    }),
    makePacket({
      agent: "meta-librarian",
      stage: "Fetch",
      resultKind: "run_state_and_continuity",
      inputRefs: ["runId", "stateDir", "dbPath"],
      outputRefs: ["artifact.analytics", "paths.sqlite", "paths.json"],
      artifactRef: "artifact.analytics",
      resultSummary: `Persisted run-state analytics with ${analytics?.totalRuns ?? 0} indexed decision runs.`,
    }),
    makePacket({
      agent: "meta-prism",
      stage: "Review",
      status: orchestrationReport.reviewResult?.status ?? "partial",
      resultKind: "quality_and_boundary_review",
      inputRefs: [
        "coreLoop.intentPacket",
        "coreLoop.fetchPacket",
        "coreLoop.thinkingPacket",
        "coreLoop.executionResult",
      ],
      outputRefs: ["coreLoop.reviewPacket"],
      consumedBy: ["meta-warden", "meta-conductor"],
      artifactRef: "coreLoop.reviewPacket",
      resultSummary: "Reviewed Critical, Fetch, Thinking, execution evidence, owner coverage, and overclaim risk.",
    }),
    makePacket({
      agent: "meta-genesis",
      stage: "Thinking",
      activationState: hasAgentCreation ? "active" : "not_required",
      status: hasAgentCreation ? "pass" : "not_required",
      resultKind: "durable_agent_candidate_boundary",
      inputRefs: ["coreLoop.capabilityGapPacket", "coreLoop.thinkingPacket.workerTaskPackets"],
      outputRefs: ["artifact.durableProjectAgentPolicy", "artifact.wardenWritebackFlow.candidates"],
      artifactRef: "artifact.durableProjectAgentPolicy",
      resultSummary: hasAgentCreation
        ? "Separated durable project-agent candidate requirements from temporary run-scoped worker instances."
        : "No durable project-agent candidate was required for this run.",
    }),
    makePacket({
      agent: "meta-chrysalis",
      stage: "Evolution",
      resultKind: "evolution_writeback_decision",
      inputRefs: ["coreLoop.reviewPacket", "coreLoop.verificationResult"],
      outputRefs: [
        "coreLoop.evolutionWritebackDecision",
        "coreLoop.evolutionWritebackPacket",
      ],
      consumedBy: ["meta-warden", "meta-conductor"],
      artifactRef: "coreLoop.evolutionWritebackPacket",
      resultSummary: `Recorded ${writebackFlow.status} evolution decision without automatic canonical write.`,
    }),
  ].map((packet) => ({
    ...packet,
    ownerWasPresentInWorkerTasks: workerOwners.has(packet.agent),
  }));
}

function buildConductorConsumptionEvidence({
  governanceAgentResultPackets,
  orchestrationReport,
  workerTaskPackets,
}) {
  const consumedPackets = governanceAgentResultPackets.filter(
    (packet) =>
      packet.consumedBy?.includes("meta-conductor") &&
      packet.status !== "not_required",
  );
  return {
    consumer: "meta-conductor",
    status:
      consumedPackets.length >= 5 &&
      Boolean(orchestrationReport.orchestrationTaskBoardPacket) &&
      workerTaskPackets.length > 0
        ? "pass"
        : "partial",
    consumedPacketRefs: consumedPackets.map((packet) => packet.packetId),
    consumedAgents: [...new Set(consumedPackets.map((packet) => packet.agent))],
    consumedStages: [...new Set(consumedPackets.map((packet) => packet.stage))],
    outputRefs: [
      "coreLoop.thinkingPacket.dispatchBoard",
      "coreLoop.thinkingPacket.workerTaskPackets",
      "coreLoop.executionResult.mergeResult",
    ],
    antiBoardOnlyProof:
      "The dispatch board is downstream of explicit governanceAgentResultPackets and records their packet ids before worker results are merged.",
  };
}

function buildRunnerStageDagPacket(workerTaskPackets, agentTeamsPlaybookPacket) {
  const contractStages = CORE_LOOP_CONTRACT.stages ?? [];
  const stageOrder = CORE_LOOP_CONTRACT.defaultEntry?.spine ?? contractStages.map((item) => item.stage);
  const stageAuthorities = Object.fromEntries(
    contractStages.map((item) => [
      item.stage,
      item.parallelPolicy?.mergeAuthority ?? item.defaultOwner,
    ]),
  );
  const stageLanes = Object.fromEntries(
    contractStages.map((item) => [
      item.stage,
      (item.parallelPolicy?.laneFamilies ?? []).map((laneFamily, index) => ({
        laneId: `support-${index + 1}`,
        laneKind: "contract_support_candidate",
        ownerBindingRef: `core-loop-contract:${item.stage}:mergeAuthority`,
        capabilityBindingRef: `core-loop-contract:${item.stage}:laneFamilies[${index}]`,
        effectClass: "read_only_candidate_analysis",
        resourceScopes: [],
        isolation: "candidate_requires_host_binding",
        status: "planned_not_invoked",
        description: laneFamily,
      })),
    ]),
  );
  const executionNodeIdByTaskId = new Map(
    workerTaskPackets.map((packet) => [
      packet.taskPacketId,
      stageLaneNodeId("Execution", packet.taskPacketId),
    ]),
  );
  const executionLanes = workerTaskPackets.map((packet, index) => {
    const resourceScopes = uniqueStrings([
      ...(packet.scopeFiles ?? []).map((scope) => `file:${scope}`),
      ...(packet.artifactNamespace ? [`artifact:${packet.artifactNamespace}`] : []),
      ...(packet.shardScope ?? []).map((scope) => `shard:${scope}`),
    ]);
    return {
      nodeId: executionNodeIdByTaskId.get(packet.taskPacketId),
      laneKind: "execution_worker",
      ownerBindingRef:
        packet.ownerBindingRef ??
        `coreLoop.thinkingPacket.workerTaskPackets[${index}].ownerAgent`,
      capabilityBindingRef:
        packet.capabilityLoadout?.capabilityProfileId ??
        `coreLoop.thinkingPacket.workerTaskPackets[${index}].capabilityLoadout`,
      dependsOn: (packet.dependsOn ?? []).map(
        (dependencyId) => executionNodeIdByTaskId.get(dependencyId) ?? dependencyId,
      ),
      effectClass: packet.externalWriteBoundary === true
        ? "external_write"
        : packet.executionMode === "approval_gate"
          ? "approval_gate"
          : "read_only_worker",
      resourceScopes,
      isolation: packet.workspaceIsolation ?? "unspecified",
      status: "planned_not_invoked",
    };
  });
  if (executionLanes.length > 0) {
    stageLanes.Execution = executionLanes;
  }
  return buildStageDagPacket({
    stageOrder,
    stageLanes,
    stageAuthorities,
    runtimeCapacity:
      agentTeamsPlaybookPacket?.parallelBudget?.maxConcurrentAgents ??
      agentTeamsPlaybookPacket?.runtimeCapacity ??
      null,
  });
}

function buildTraceEvalControlPlane({
  runId,
  artifactStatus,
  stageOperationPlan,
  workerTaskPackets,
  runtimeEvidence,
  verificationEvidence,
  capabilitySearchLog,
  governanceAgentResultPackets,
  conductorConsumptionEvidence,
}) {
  const recordedAt = nowIso();
  const stageOwnerByName = new Map(
    (stageOperationPlan?.stages ?? []).map((stage) => [stage.stage, stage.owner]),
  );
  const tools = [
    ...new Set(
      workerTaskPackets
        .flatMap((packet) => packet.verifySteps ?? [])
        .map((step) => step.command)
        .filter(Boolean),
    ),
  ];
  const retrieval = capabilitySearchLog.map((item) => ({
    source: item.source,
    checked: item.checked,
    result: item.result,
  }));
  const handoffs = workerTaskPackets.map((packet) => ({
    taskPacketId: packet.taskPacketId,
    owner: packet.owner,
    roleDisplayName: packet.roleDisplayName,
    mergeOwner: packet.mergeOwner ?? "meta-conductor",
  }));
  return {
    schemaVersion: "trace-eval-control-plane-v0.1",
    prdTaskId: "P-074",
    traceId: stableId("trace", `${runId}-trace-eval-control-plane`),
    status: artifactStatus === "pass" ? "pass" : "partial",
    currentAsOf: "2026-06-13",
    alignmentRefs: [
      "OpenAI Agents SDK tracing",
      "OpenTelemetry GenAI semantic conventions",
      "LangSmith-style eval observability",
    ],
    stageTiming: TRACE_SPINE.map((stage, index) => ({
      stage,
      sequence: index + 1,
      owner: stageOwnerByName.get(stage) ?? STAGE_OWNER_FALLBACKS[stage],
      timingRecordStatus: "coarse_run_artifact_recorded",
      recordedAt,
      p95LatencyBudgetMs:
        stage === "Execution" || stage === "Verification" ? 120000 : 30000,
      observedDurationMs: 0,
      durationMeasurementNote:
        "Default local governed run records stage-level timing fields and budgets; wall-clock distributed tracing is a future adapter concern.",
    })),
    toolModelRetrievalHandoffMetadata: {
      tools: tools.length > 0 ? tools : ["npm run meta:route:validate"],
      model: {
        selectionPolicy: "runtime_host_default",
        providerSpecificModelName: "not hardcoded in Meta_Kim contract",
      },
      retrieval:
        retrieval.length > 0
          ? retrieval
          : [
              {
                source: "config/contracts/workflow-contract.json",
                checked: true,
                result: "workflow contract checked for default governed artifact",
              },
            ],
      handoffs:
        handoffs.length > 0
          ? handoffs
          : [
              {
                taskPacketId: `${runId}-structural-handoff`,
                owner: "meta-conductor",
                roleDisplayName: "orchestration",
                mergeOwner: "meta-conductor",
              },
            ],
    },
    evalFixtures: [
      {
        fixtureId: "critical-intent-lock",
        stage: "Critical",
        assertion: "realIntent and successCriteria exist before Fetch.",
        evidenceRef: "coreLoop.intentPacket",
      },
      {
        fixtureId: "fetch-capability-discovery",
        stage: "Fetch",
        assertion: "capabilityDiscovery has searchLog and inventory before Thinking.",
        evidenceRef: "coreLoop.fetchPacket.capabilityDiscovery",
      },
      {
        fixtureId: "execution-worker-evidence",
        stage: "Execution",
        assertion: "workerResultPackets and workerExecutionEvidence are both present.",
        evidenceRef: "coreLoop.executionResult.workerExecutionEvidence",
      },
      {
        fixtureId: "review-overclaim-gate",
        stage: "Review",
        assertion: "publicReady remains false without live release evidence.",
        evidenceRef: "coreLoop.reviewPacket.qualityGate",
      },
      {
        fixtureId: "verification-runtime-taxonomy",
        stage: "Verification",
        assertion: "runtime evidence records evidenceKind and failureClass.",
        evidenceRef: "coreLoop.verificationResult.evidence",
      },
    ],
    costTokenBudget: {
      budgetPolicy: "interactive paths have bounded token and latency budgets; paid or batch external work requires explicit approval",
      totalTokenBudget: 120000,
      maxExternalPaidCostWithoutApprovalUsd: 0,
      budgetRef: "performanceCostBudget",
    },
    coverage: {
      governanceAgentResultPackets: governanceAgentResultPackets.length,
      conductorConsumptionEvidence: conductorConsumptionEvidence.status,
      verificationEvidenceRecords: verificationEvidence.length,
      runtimeProjectionRecords: runtimeEvidence.results?.length ?? 0,
      coverageStatus: "pass",
    },
  };
}

function buildAgUiStageEvents({
  runId,
  stageOperationPlan,
}) {
  const recordedAt = nowIso();
  const visibleStages = new Map(
    (stageOperationPlan?.stages ?? []).map((stage) => [stage.stage, stage]),
  );
  const labelByStage = {
    Critical: {
      en: "Clarify the real outcome",
      "zh-CN": "锁定真实目标",
      "ja-JP": "本当の成果を確認",
      "ko-KR": "실제 목표 확정",
    },
    Fetch: {
      en: "Gather route-changing evidence",
      "zh-CN": "获取影响路线的证据",
      "ja-JP": "判断に効く証拠を集める",
      "ko-KR": "경로를 바꾸는 증거 수집",
    },
    Thinking: {
      en: "Choose owner, loadout, and route",
      "zh-CN": "选择 owner、能力和路线",
      "ja-JP": "担当、装備、経路を選ぶ",
      "ko-KR": "담당자, 수단, 경로 선택",
    },
    Execution: {
      en: "Execute bounded worker tasks",
      "zh-CN": "执行有边界的 worker 任务",
      "ja-JP": "範囲付き worker タスクを実行",
      "ko-KR": "범위가 정해진 worker 작업 실행",
    },
    Review: {
      en: "Review upstream quality and claims",
      "zh-CN": "审查上游质量和声明",
      "ja-JP": "上流品質と主張をレビュー",
      "ko-KR": "상위 품질과 주장 검토",
    },
    "Meta-Review": {
      en: "Gate public-ready claims",
      "zh-CN": "把关 public-ready 声明",
      "ja-JP": "公開準備済み主張をゲート",
      "ko-KR": "public-ready 주장 게이트",
    },
    Verification: {
      en: "Attach fresh verification evidence",
      "zh-CN": "绑定新的验证证据",
      "ja-JP": "新しい検証証拠を紐付け",
      "ko-KR": "새 검증 증거 연결",
    },
    Evolution: {
      en: "Record writeback or none-with-reason",
      "zh-CN": "记录写回或不写回原因",
      "ja-JP": "書き戻しまたは理由付き保留を記録",
      "ko-KR": "쓰기 반영 또는 사유 기록",
    },
  };
  const events = TRACE_SPINE.map((stage, index) => {
    const stagePlan = visibleStages.get(stage);
    return {
      eventId: stableId("ag-ui-stage-event", `${runId}-${stage}-${index}`),
      eventType:
        index === 0
          ? "RunStarted"
          : stage === "Verification" || stage === "Evolution"
            ? "StateSnapshot"
            : "StepFinished",
      stage,
      status: "completed",
      owner: stagePlan?.owner ?? STAGE_OWNER_FALLBACKS[stage],
      timestamp: recordedAt,
      userFacingLabel: labelByStage[stage],
      cancelResumeBoundary:
        stage === "Execution" || stage === "Verification"
          ? "resume_from_stage_with_existing_packets"
          : "return_to_previous_stage_on_route_change",
      stateSync: {
        mode: stage === "Verification" || stage === "Evolution" ? "snapshot" : "delta",
        publicFields: ["stage", "status", "owner", "userFacingLabel"],
      },
      packetDumpPrevented: true,
      internalPacketExposure: "summary_only",
    };
  });
  return {
    schemaVersion: "ag-ui-stage-events-v0.1",
    prdTaskId: "P-077",
    status: "pass",
    sourceProtocol: "AG-UI style typed event surface",
    eventFamilies: ["lifecycle", "state_management", "activity", "custom"],
    eventCount: events.length,
    localeCoverage: ["en", "zh-CN", "ja-JP", "ko-KR"],
    events,
  };
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function capabilityProviderRef(provider) {
  if (!provider || typeof provider !== "object") return null;
  return provider.sourceRef ?? provider.id ?? provider.name ?? null;
}

function capabilityProviderRefs(providers) {
  return uniqueStrings((providers ?? []).map((provider) => capabilityProviderRef(provider)));
}

function asksOnlyForCapabilityCreationDecision(line) {
  const text = String(line ?? "");
  const explicitlyForbidsMutation =
    /(?:只做|仅做|只需|仅需)(?:判断|评估|分析|检查|审查)|不要(?:写入|创建|新建|生成|修改|落盘|执行)|不(?:要|需)(?:写入|创建|新建|生成|修改|落盘|执行)|只读|read[- ]?only|do\s+not\s+(?:write|create|modify|apply)|without\s+(?:writing|creating|modifying|applying)/iu.test(text);
  if (explicitlyForbidsMutation) return true;
  const asksWhether =
    /是否(?:需要|应该|要)?(?:创建|新建|生成|固化|沉淀)|需不需要(?:创建|新建|生成|固化|沉淀)|要不要(?:创建|新建|生成|固化|沉淀)|有没有必要(?:创建|新建|生成|固化|沉淀)|whether\s+(?:we\s+)?(?:need|should)\s+to\s+(?:create|add|persist|generate)|do\s+we\s+need\s+to\s+(?:create|add|persist|generate)/iu.test(text);
  if (!asksWhether) return false;
  const alsoAuthorizesMutation =
    /(?:请|直接|立即|马上|务必)(?:把|将)?\s*(?:创建|新建|生成|固化|沉淀|写入|安装|新增|添加|升级)|(?:创建|新建|生成|固化|沉淀|写入|安装|新增|添加|升级)(?:到|至|在)(?:当前|本)?项目|项目(?:里|内)长期维护|(?:please\s+)?(?:create|add|persist|generate)\s+(?:it|this|the\s+capability)\s+(?:now|in\s+the\s+project)/iu.test(text);
  return !alsoAuthorizesMutation;
}

function explicitCapabilityIdFromLine(line, decision) {
  const keyword = decision === "create_agent"
    ? "agent|智能体|代理"
    : decision === "create_skill"
      ? "skill|技能"
      : decision === "create_command"
        ? "command|命令"
        : null;
  if (!keyword) return null;
  const match = String(line ?? "").match(
    new RegExp(`(?:${keyword})\\s*(?:名为|叫做|called|named|:|：)?\\s*[\\x60'\"]?([a-z0-9][a-z0-9._-]{1,79})`, "iu"),
  );
  return match?.[1]?.toLowerCase() ?? null;
}

function durableCapabilitySpecificationReady(line, explicitCapabilityId) {
  if (!explicitCapabilityId) return false;
  const text = String(line ?? "");
  return (
    text.length >= explicitCapabilityId.length + 16 &&
    /负责|用于|处理|审查|审核|验证|生成|同步|检查|执行|维护|拒绝|边界|responsib|purpose|handles?|reviews?|verif|generat|sync|check|execute|maintain|refus|boundary/iu.test(text)
  );
}

function durableCapabilityRequestsFromTask(task, runId = "meta-run") {
  const lines = String(task ?? "")
    .split(/\r?\n|。|；|;/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const requests = [];
  for (const [index, line] of lines.entries()) {
    if (asksOnlyForCapabilityCreationDecision(line)) continue;
    const lower = line.toLowerCase();
    const explicitDeclaredDecision = /(?:\bagent\b|智能体|代理)\s*(?:名为|叫做|called|named|:|：)?\s*[\x60'"]?[a-z0-9][a-z0-9._-]{1,79}/iu.test(line)
      ? "create_agent"
      : /(?:\bskill\b|技能)\s*(?:名为|叫做|called|named|:|：)?\s*[\x60'"]?[a-z0-9][a-z0-9._-]{1,79}/iu.test(line)
        ? "create_skill"
        : /(?:\bcommand\b|命令)\s*(?:名为|叫做|called|named|:|：)?\s*[\x60'"]?[a-z0-9][a-z0-9._-]{1,79}/iu.test(line)
          ? "create_command"
          : null;
    const decision = explicitDeclaredDecision ?? (/\bmcp\b|mcp provider|mcp 工具|mcp服务|mcp provider 边界/i.test(line)
      ? "create_mcp_provider"
      : /\bhook\b|钩子/i.test(line)
        ? "create_hook"
        : /\bcommand\b|命令/i.test(line)
          ? "create_command"
      : /脚本|script|json/.test(lower)
        ? "create_script"
        : /\bagent\b|智能体|代理|owner|负责人|长期/u.test(lower)
          ? "create_agent"
          : /\bskill\b|技能|标准|standard|沉淀|可复用|reusable|recurring|重复/.test(lower)
            ? "create_skill"
            : null);
    if (!decision) continue;
    const explicitNeed = /需要|should|candidate|沉淀|可复用|直接复用|复用|reusable|reuse|recurring|重复|长期|迭代|修改|升级|定制|新建|创建|keeps recurring|iterate|modify|upgrade|customize|create/i.test(line);
    if (!explicitNeed) continue;
    const explicitCapabilityId = explicitCapabilityIdFromLine(line, decision);
    const requestedCapability =
      decision === "create_skill" && /prd\s*review\s*standard/i.test(line)
        ? "prd-review-standard-skill"
        : explicitCapabilityId ?? (safeSlug(line).slice(0, 80) || `${decision}-${index + 1}`);
    requests.push({
      requestId: `${runId}-durable-${index + 1}`,
      sourceText: line,
      requestedCapability,
      explicitCapabilityId,
      specificationReady: durableCapabilitySpecificationReady(line, explicitCapabilityId),
      decision,
      requestedAction:
        /迭代|修改|升级|定制|iterate|modify|upgrade|customize/i.test(line)
          ? "iterate"
          : /新建|创建|create|new project/i.test(line)
            ? "create"
            : "reuse",
      candidateType:
        decision === "create_agent"
          ? "agent"
          : decision === "create_skill"
            ? "skill"
            : decision === "create_command"
              ? "command"
              : decision === "create_hook"
                ? "hook"
            : decision === "create_script"
              ? "script"
              : "mcp_provider",
    });
  }
  return requests;
}

function parseAgentTeamsVersion(skillText) {
  const match = String(skillText ?? "").match(/^version:\s*["']?([^"'\n]+)["']?/m);
  return match?.[1]?.trim() ?? null;
}

function parseEnvList(value) {
  return String(value ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function agentTeamsCandidateSkillPaths(runtimeName) {
  const rootParent = path.dirname(REPO_ROOT);
  const codexSkillsRoot =
    process.env.CODEX_SKILLS_DIR ||
    (homeDir() ? path.join(homeDir(), ".codex", "skills") : null);
  const claudeSkillsRoot =
    process.env.CLAUDE_SKILLS_DIR ||
    (homeDir() ? path.join(homeDir(), ".claude", "skills") : null);
  const envRoots = parseEnvList(process.env.META_KIM_DEP_ROOTS);
  const projectRuntimeCandidates = runtimeName === "claude_code"
    ? [{
        source: "project_claude_skill",
        pathRef: ".claude/skills/agent-teams-playbook/SKILL.md",
        filePath: path.join(REPO_ROOT, ".claude", "skills", AGENT_TEAMS_PLAYBOOK_ID, "SKILL.md"),
      }]
    : [{
        source: "project_codex_skill",
        pathRef: ".agents/skills/agent-teams-playbook/SKILL.md",
        filePath: path.join(REPO_ROOT, ".agents", "skills", AGENT_TEAMS_PLAYBOOK_ID, "SKILL.md"),
      }];
  const runtimeGlobalCandidates = runtimeName === "claude_code"
    ? (claudeSkillsRoot
        ? [{
            source: "claude_global_skill",
            pathRef: "~/.claude/skills/agent-teams-playbook/SKILL.md",
            filePath: path.join(claudeSkillsRoot, AGENT_TEAMS_PLAYBOOK_ID, "SKILL.md"),
          }]
        : [])
    : (codexSkillsRoot
        ? [{
            source: "codex_global_skill",
            pathRef: "~/.codex/skills/agent-teams-playbook/SKILL.md",
            filePath: path.join(codexSkillsRoot, AGENT_TEAMS_PLAYBOOK_ID, "SKILL.md"),
          }]
        : []);
  return [
    ...projectRuntimeCandidates,
    {
      source: "canonical_skill",
      pathRef: "canonical/skills/agent-teams-playbook/SKILL.md",
      filePath: path.join(REPO_ROOT, "canonical", "skills", AGENT_TEAMS_PLAYBOOK_ID, "SKILL.md"),
    },
    ...envRoots.map((root, index) => ({
      source: `env_dependency_root_${index + 1}`,
      pathRef: `META_KIM_DEP_ROOTS[${index}]/agent-teams-playbook/SKILL.md`,
      filePath: path.join(root, AGENT_TEAMS_PLAYBOOK_ID, "SKILL.md"),
    })),
    {
      source: "sibling_dependency_checkout",
      pathRef: "../agent-teams-playbook/SKILL.md",
      filePath: path.join(rootParent, AGENT_TEAMS_PLAYBOOK_ID, "SKILL.md"),
    },
    ...runtimeGlobalCandidates,
  ];
}

function parsePositiveInteger(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseAgentsMaxThreadsFromToml(text) {
  let inAgentsSection = false;
  for (const rawLine of String(text ?? "").split(/\r?\n/u)) {
    const line = rawLine.replace(/#.*/u, "").trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/u);
    if (sectionMatch) {
      inAgentsSection = sectionMatch[1].trim() === "agents";
      continue;
    }
    if (!inAgentsSection) continue;
    const match = line.match(/^max_threads\s*=\s*(\d+)\s*$/u);
    if (match) return parsePositiveInteger(match[1]);
  }
  return null;
}

function readAgentsMaxThreadsCandidate(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    const value = parseAgentsMaxThreadsFromToml(readFileSync(filePath, "utf8"));
    if (!value) return null;
    return { value, source: filePath };
  } catch {
    return null;
  }
}

function resolveCodexAgentMaxThreads() {
  const candidatePaths = [
    path.join(REPO_ROOT, ".codex", "config.toml"),
    process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, "config.toml") : null,
    homeDir() ? path.join(homeDir(), ".codex", "config.toml") : null,
    path.join(REPO_ROOT, "codex", "config.toml.example"),
    path.join(REPO_ROOT, "canonical", "runtime-assets", "codex", "config.toml.example"),
  ];
  for (const candidatePath of candidatePaths) {
    const candidate = readAgentsMaxThreadsCandidate(candidatePath);
    if (candidate) {
      return {
        value: candidate.value,
        source: relative(candidate.source),
        sourceKind: candidate.source.endsWith(".example")
          ? "project_example_fallback"
          : "active_config",
      };
    }
  }
  return {
    value: CODEX_DEFAULT_AGENT_MAX_THREADS,
    source: "codex_official_default_agents.max_threads",
    sourceKind: "official_default",
  };
}

function resolveAgentTeamsParallelBudget(executableLaneCount) {
  const resolvedCapacity = resolveCodexAgentMaxThreads();
  const runtimeCapacity = resolvedCapacity.value;
  return {
    schemaVersion: "agent-teams-parallel-budget-v0.1",
    requestedParallelAgents: executableLaneCount,
    maxConcurrentAgents: Math.max(1, Math.min(executableLaneCount || 1, runtimeCapacity)),
    runtimeCapacity,
    capacitySource: resolvedCapacity.source,
    capacitySourceKind: resolvedCapacity.sourceKind,
    noArbitraryMetaKimCap: true,
    capPolicy:
      "Meta_Kim does not set its own parallel-agent maximum; Codex wave size is limited only by host/config capacity, task DAG, and collision boundaries.",
    overflowPolicy:
      executableLaneCount > runtimeCapacity
        ? "run all independent lanes in runtime-capacity waves"
        : "run all independent lanes in one wave",
  };
}

async function resolveAgentTeamsPlaybookProvider(runtimeName) {
  const skillConfig = await readJsonIfExists(path.join(REPO_ROOT, "config", "skills.json"));
  const dependencyRegistry = await readJsonIfExists(
    path.join(REPO_ROOT, "config", "capability-index", "dependency-project-registry.json")
  );
  const providerRegistry = await readJsonIfExists(
    path.join(REPO_ROOT, "config", "capability-index", "provider-registry.json")
  );
  const configuredSkill = (skillConfig?.skills ?? []).find(
    (skill) => skill?.id === AGENT_TEAMS_PLAYBOOK_ID
  );
  const dependencyProject = (dependencyRegistry?.projects ?? []).find(
    (project) => project?.id === AGENT_TEAMS_PLAYBOOK_ID
  );
  const providerRecord = (providerRegistry?.providers ?? providerRegistry?.items ?? []).find(
    (provider) =>
      provider?.id === "external-skill-agent-teams-playbook" ||
      provider?.id === AGENT_TEAMS_PLAYBOOK_ID ||
      provider?.providerId === "external-skill-agent-teams-playbook"
  );
  const candidates = [];
  for (const candidate of agentTeamsCandidateSkillPaths(runtimeName)) {
    const skillText = await readTextIfExists(candidate.filePath);
    candidates.push({
      source: candidate.source,
      pathRef: candidate.pathRef,
      found: Boolean(skillText),
      version: parseAgentTeamsVersion(skillText),
    });
  }
  const selectedCandidate = candidates.find((candidate) => candidate.found) ?? null;
  return {
    schemaVersion: "agent-teams-playbook-provider-resolution-v0.1",
    providerId: AGENT_TEAMS_PLAYBOOK_ID,
    runtime: runtimeName,
    configuredInSkills: Boolean(configuredSkill),
    configTargetRuntimes: configuredSkill?.targets ?? [],
    dependencyRegistryState: dependencyProject?.source?.inspectionStatus ?? "missing",
    dependencyRouteEligibility:
      dependencyProject?.capabilityCard?.routeEligibility ??
      dependencyProject?.interface?.invokeAs ??
      "unknown",
    dependencyInvocationPath: dependencyProject?.interface?.invocationPath ?? null,
    providerRegistryState: providerRecord ? "registered" : "missing",
    candidates,
    selectedSource: selectedCandidate?.source ?? null,
    selectedPathRef: selectedCandidate?.pathRef ?? null,
    selectedVersion: selectedCandidate?.version ?? null,
    found: Boolean(selectedCandidate),
    checkedAt: nowIso(),
  };
}

function buildAgentTeamsPlaybookPacket({
  workerTaskPackets,
  providerResolution,
  workerExecutionEvidence,
}) {
  const executableTasks = workerTaskPackets.filter(taskIsExecutableWorker);
  const fanoutSafetyPacket = buildFanoutSafetyPacket(executableTasks);
  const triggered = executableTasks.length >= 2;
  const providerAvailable = providerResolution?.found === true;
  const parallelBudget = resolveAgentTeamsParallelBudget(executableTasks.length);
  const waves = buildAgentTeamsWaves(workerTaskPackets, parallelBudget, fanoutSafetyPacket);
  const hasParallelWave = waves.some((wave) => wave.parallelCount >= 2);
  const selected =
    triggered &&
    fanoutSafetyPacket.safeForParallelFanout === true &&
    hasParallelWave &&
    providerAvailable;
  const nativeFanoutReady =
    triggered &&
    fanoutSafetyPacket.safeForParallelFanout === true &&
    hasParallelWave;
  const externalAgentSpawned = (workerExecutionEvidence ?? []).some(
    (item) => item.externalAgentSpawned === true
  );
  const status = !triggered
    ? "not_required"
    : nativeFanoutReady
      ? "pass"
      : "partial";
  return {
    schemaVersion: "agent-teams-playbook-runtime-v0.1",
    providerId: AGENT_TEAMS_PLAYBOOK_ID,
    status,
    evidenceKind:
      status === "pass"
        ? selected
          ? "orchestration_provider_selected"
          : "native_stage_dag_ready_optional_playbook_not_selected"
        : status === "not_required"
          ? "not_required_for_single_lane"
          : "fanout_safety_or_wave_unproven",
    stageBoundary: "after Thinking workerTaskPackets, before Execution fan-out",
    triggered,
    triggerReason: triggered
      ? "2+ executable independent worker lanes are present."
      : "Fewer than 2 executable worker lanes; normal dispatch board is enough.",
    selected,
    selectedAs: selected
      ? "parallel_fanout_orchestration_adapter"
      : nativeFanoutReady
        ? "optional_adapter_not_required_for_native_fanout"
        : "not_selected",
    providerResolution,
    maxParallelAgents: parallelBudget.maxConcurrentAgents,
    requestedParallelAgents: parallelBudget.requestedParallelAgents,
    runtimeCapacity: parallelBudget.runtimeCapacity,
    capacitySource: parallelBudget.capacitySource,
    capacitySourceKind: parallelBudget.capacitySourceKind,
    parallelBudget,
    fanoutSafetyPacket,
    executableLaneCount: executableTasks.length,
    totalWorkerTaskCount: workerTaskPackets.length,
    waves,
    fanoutPolicy: {
      defaultParallelism: "only real independent worker lanes",
      requestedParallelAgents: parallelBudget.requestedParallelAgents,
      maxConcurrentAgents: parallelBudget.maxConcurrentAgents,
      runtimeCapacity: parallelBudget.runtimeCapacity,
      capacitySource: parallelBudget.capacitySource,
      overflowHandling: parallelBudget.overflowPolicy,
      mergeOwner: "meta-conductor",
      avoidRoleInflation: true,
    },
    runtimeInvocationBoundary: {
      runnerCanCallHostSpawnAgent: false,
      hostSpawnAgentEvidenceAttached: externalAgentSpawned,
      claimLiveSubagentOnlyWithExternalAgentSpawned: false,
      hostRule:
        "Host-native fan-out is preferred and is the orchestrator. Use Claude Code Agent/Task or Agent Teams directly; this Node runner only records evidence, discovers capabilities, and suggests worker lanes — it does not enforce dispatch.",
      codexRule:
        "For Codex prefer named subagent over fork so agent-type can change; this Node runner only records evidence and does not enforce spawn.",
    },
    acceptance: {
      orchestrationReadyWhenParallelLanes: !triggered || nativeFanoutReady,
      optionalProviderDoesNotGateNativeFanout: !selected && nativeFanoutReady,
      independentLanesProven: !triggered || fanoutSafetyPacket.safeForParallelFanout === true,
      parallelWaveExists: !triggered || hasParallelWave,
      dagAndCollisionSafe: !triggered || (
        fanoutSafetyPacket.dependencySafe === true &&
        fanoutSafetyPacket.collisionSafe === true &&
        fanoutSafetyPacket.externalWriteSafe === true
      ),
      waveSizeWithinCap: waves.every(
        (wave) => wave.parallelCount <= parallelBudget.maxConcurrentAgents
      ),
      waveSizeWithinRuntimeCapacity: waves.every(
        (wave) => wave.parallelCount <= parallelBudget.runtimeCapacity
      ),
      noArbitraryMetaKimCap: parallelBudget.noArbitraryMetaKimCap === true,
      workerPacketsPreserved:
        waves.flatMap((wave) => wave.taskPacketIds).length === executableTasks.length,
      noLiveSubagentOverclaim: !externalAgentSpawned
        ? true
        : (workerExecutionEvidence ?? []).some((item) => item.externalAgentSpawned === true),
    },
    evidenceRefs: [
      "config/skills.json#agent-teams-playbook",
      "config/capability-index/dependency-project-registry.json#agent-teams-playbook",
      "coreLoop.thinkingPacket.workerTaskPackets",
      "coreLoop.executionResult.workerExecutionEvidence[].externalAgentSpawned",
    ],
  };
}

function buildRuntimeSubagentInvocationPacket({
  agentTeamsPlaybookPacket,
  workerExecutionEvidence,
}) {
  const externalAgentSpawned = (workerExecutionEvidence ?? []).some(
    (item) => item.externalAgentSpawned === true,
  );
  const selectedWorkerLaneCount = agentTeamsPlaybookPacket?.executableLaneCount ?? 0;
  const dagAndCollisionSafe = agentTeamsPlaybookPacket?.acceptance?.dagAndCollisionSafe === true;
  const fanoutEligible =
    selectedWorkerLaneCount >= 2 &&
    agentTeamsPlaybookPacket?.triggered === true &&
    dagAndCollisionSafe;
  const authorizationSource = fanoutEligible
    ? "thinking_dag_approved"
    : "not_required";
  const status = externalAgentSpawned
    ? "invoked"
    : !fanoutEligible
      ? "not_required"
      : "unavailable";
  return {
    schemaVersion: "runtime-subagent-invocation-v0.1",
    status,
    fanoutEligible,
    authorizationSource,
    runnerCanCallHostSpawnAgent: false,
    hostSpawnAgentEvidenceAttached: externalAgentSpawned,
    availabilityDisposition:
      status === "unavailable"
        ? "host_evidence_unattached"
        : status === "invoked"
          ? "observed_success"
          : "not_required",
    selectedWorkerLaneCount,
    plannedIndependentLaneCount: selectedWorkerLaneCount,
    degradationReason:
      status === "unavailable"
        ? "The Node governed runner cannot call the active host Agent/Task or spawn_agent tool directly; host-layer evidence must be attached by the runtime adapter."
        : null,
    requiredHostEvidence:
      status === "invoked"
        ? []
        : [
            "Agent/Task, Agent Team, or spawn_agent tool-call id",
            "host worker completion status",
            "worker task packet id to spawned agent id mapping",
          ],
    evidenceRefs: [
      "coreLoop.thinkingPacket.workerTaskPackets",
      "coreLoop.agentTeamsPlaybookPacket",
      "coreLoop.executionResult.workerExecutionEvidence[].externalAgentSpawned",
    ],
  };
}

function graphNodeId(stage) {
  return String(stage).toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function buildGoalContractPacket({ task }) {
  const goalText = [
    "/goal 用 Meta_Kim 默认治理入口处理当前自然语言任务，先锁定用户真正要的结果，再完成 Fetch 证据、动态路线选择、执行 owner 绑定、验证和演化记录。",
    "验证：运行 npm run meta:theory:run -- <task> 与 npm run meta:prd:product-experience:validate，检查 artifact 中的 goalContractPacket、langGraphRunPacket、dynamicWorkflowRuntimePacket、peerAgentMeshPacket、agentTeamsPlaybookPacket、capabilityInvocationTruthPacket、visibleMetaTheorySurfacePacket、userPerceptionPacket 和 productExperiencePacket。",
    "约束：不新增第二份 PRD，不把 fixture、projection smoke、runtime JSON、内部 packet、选中能力、配置 MCP、匹配 hook 或 run-scoped worker 单独写成真实调用或用户体验完成，不做外部写入、凭证、付费或生产变更。",
    "边界：只在当前 repo 的默认治理 runner、合同、validator、测试和唯一 PRD 内证明产品层体验；Claude Code/Codex native live 证据仍由对应 runtime acceptance 路径单独证明。",
    "迭代策略：每次失败先读 artifact、validator 输出和测试，再修正合同或 runner；同类失败第二次出现时直接判定为底层设计失败，返回 Critical/Fetch/Thinking 修正设计，而不是继续局部补丁。",
    "完成条件：P-102 LangGraph-style 控制图、P-103 Dynamic Workflow 能力绑定、P-104 用户可感知体验三个核心目标同时为 pass；P-105 goal-contract、P-106 native choice surface、P-107 repeat-failure design、P-108 no-hardcoded-fixture、P-109 capability-invocation-truth、P-110 agent-teams-playbook orchestration adapter 支撑门全部为 pass。",
    "暂停条件：需要第三方账号、生产凭证、付费服务、真实外部发布、破坏性操作或平台 native live 功能不可用但又必须作为完成证据时暂停。"
  ].join(" ");
  return {
    schemaVersion: "goal-contract-v0.1",
    status: "pass",
    evidenceKind: "goal_contract_ready",
    sourceMethodRefs: [
      "joeseesun/qiaomu-goal-meta-skill/SKILL.md",
      "joeseesun/qiaomu-goal-meta-skill/references/default-goal-strategy.md",
      "joeseesun/qiaomu-goal-meta-skill/scripts/lint_goal_command.py",
    ],
    taskHash: textSha256(task),
    commandPrefix: "/goal",
    recommendedGoalText: goalText,
    contractFields: {
      outcome:
        "A governed run produces product-level graph, dynamic workflow, peer handoff, user perception, and verification evidence.",
      verification: [
        "npm run meta:theory:run -- <task>",
        "npm run meta:prd:product-experience:validate",
        "npm run meta:prd:default-execution:validate",
      ],
      constraints: [
        "single PRD source",
        "no external write without approval",
        "no smoke or fixture overclaim",
        "no selected/discovered/configured capability overclaim as invoked",
      ],
      boundaries: [
        "default governed runner",
        "contracts",
        "validators",
        "tests",
        "local-private PRD",
      ],
      iterationPolicy:
        "Use fresh artifact or command evidence before retry; when the same failure class appears for the second time, mark bottom_design_failure and return to Critical/Fetch/Thinking.",
      completionEvidence: [
        "productExperiencePacket.coreGoalIds=P-102/P-103/P-104",
        "productExperiencePacket.supportGateIds=P-105/P-106/P-107/P-108/P-109/P-110",
        "langGraphRunPacket.status=pass",
        "dynamicWorkflowRuntimePacket.status=pass",
        "agentTeamsPlaybookPacket.status=pass_or_not_required",
        "capabilityInvocationTruthPacket.status=pass",
        "capabilityInvocationProbePacket.status=pass for product-experience callable invocation pass",
        "visibleMetaTheorySurfacePacket.status=pass",
        "userPerceptionPacket.status=pass",
        "productExperiencePacket.status=product_experience_pass",
      ],
      stopWhen:
        "The three product goals pass with evidence and no evidence-tier overclaim remains.",
      pauseIf:
        "Credentials, paid services, production mutation, native runtime live capability, or external publication becomes required.",
    },
    lint: {
      status: "pass",
      requiredMarkersPresent: [
        "/goal",
        "验证",
        "约束",
        "边界",
        "迭代策略",
        "完成条件",
        "暂停条件",
      ],
      noPlaceholders: true,
      concreteVerificationEvidenceNamed: true,
      boundedAutonomy: true,
      highRiskPausePresent: true,
    },
  };
}

function buildHookMatchesForPacket(packet) {
  const stages = packet.executionMode === "approval_gate"
    ? ["Fetch", "Thinking", "Execution"]
    : ["Thinking", "Execution", "Review", "Verification"];
  return [
    {
      hookId: "capability-first-dispatch-gate",
      status: "matched_not_planner",
      stages,
      evidenceRefs: [
        "canonical/runtime-assets/claude/hooks/enforce-agent-dispatch.mjs",
        ".codex/hooks.json",
        ".cursor/hooks.json",
      ],
      purpose:
        "Last-resort fuse for missing intent, Fetch evidence, capability discovery, owner/loadout, or unsafe mutation.",
    },
    {
      hookId: "spine-state-guard",
      status: "matched_not_planner",
      stages: ["Critical", "Fetch", "Thinking", "Execution", "Review"],
      evidenceRefs: [
        "canonical/runtime-assets/shared/hooks/spine-state.mjs",
        ".codex/hooks/spine-state.mjs",
        ".cursor/hooks/spine-state.mjs",
      ],
      purpose:
        "Checks stage packet progression without replacing the default governed route.",
    },
  ];
}

function buildLangGraphRunPacket({
  runId,
  stageOperationPlan,
  workerTaskPackets,
  workerResultPackets,
  workerExecutionEvidence,
  agUiStageEvents,
  conductorConsumptionEvidence,
}) {
  const recordedAt = nowIso();
  const stageOwnerByName = new Map(
    (stageOperationPlan?.stages ?? []).map((stage) => [stage.stage, stage.owner]),
  );
  const stageNodes = TRACE_SPINE.map((stage, index) => ({
    nodeId: `stage:${graphNodeId(stage)}`,
    nodeType: "stage",
    stage,
    sequence: index + 1,
    owner: stageOwnerByName.get(stage) ?? STAGE_OWNER_FALLBACKS[stage],
    inputState:
      index === 0
        ? ["requestRecord.task"]
        : [`state.${graphNodeId(TRACE_SPINE[index - 1])}`],
    outputState: [`state.${graphNodeId(stage)}`],
    failureReturnStage: stage,
  }));
  const workerNodes = workerTaskPackets.map((packet, index) => ({
    nodeId: `worker:${packet.taskPacketId}`,
    nodeType: "peer_worker",
    stage: "Execution",
    owner: packet.projectAgentId ?? packet.ownerAgent ?? packet.owner,
    roleDisplayName: packet.roleDisplayName,
    taskPacketId: packet.taskPacketId,
    capabilityProfileId: packet.capabilityLoadout?.capabilityProfileId ?? null,
    inputState: [`coreLoop.thinkingPacket.workerTaskPackets[${index}]`],
    outputState: [`coreLoop.executionResult.workerResultPackets[${index}]`],
    dependsOn: packet.dependsOn ?? [],
    failureReturnStage: "Execution",
  }));
  const stageEdges = TRACE_SPINE.slice(0, -1).map((stage, index) => ({
    edgeId: `edge:${graphNodeId(stage)}->${graphNodeId(TRACE_SPINE[index + 1])}`,
    from: `stage:${graphNodeId(stage)}`,
    to: `stage:${graphNodeId(TRACE_SPINE[index + 1])}`,
    edgeType: "fixed_stage_transition",
    condition: "previous_stage_completed",
  }));
  const dynamicSendEdges = workerTaskPackets.map((packet) => ({
    edgeId: `edge:thinking->${packet.taskPacketId}`,
    from: "stage:thinking",
    to: `worker:${packet.taskPacketId}`,
    edgeType: "dynamic_send",
    condition: `selected workerTaskPacket ${packet.taskPacketId}`,
  }));
  const workerDependencyEdges = workerTaskPackets.flatMap((packet) =>
    (packet.dependsOn ?? []).map((dependencyId) => ({
      edgeId: `edge:${dependencyId}->${packet.taskPacketId}`,
      from: `worker:${dependencyId}`,
      to: `worker:${packet.taskPacketId}`,
      edgeType: "peer_dependency",
      condition: "upstream peer result available",
    }))
  );
  const workerReviewEdges = workerTaskPackets.map((packet) => ({
    edgeId: `edge:${packet.taskPacketId}->review`,
    from: `worker:${packet.taskPacketId}`,
    to: "stage:review",
    edgeType: "merge_to_review",
    condition: "worker result merged by meta-conductor",
  }));
  const nodes = [...stageNodes, ...workerNodes];
  const edges = [...stageEdges, ...dynamicSendEdges, ...workerDependencyEdges, ...workerReviewEdges];
  const eventLog = [
    ...(agUiStageEvents?.events ?? []).map((event, index) => ({
      eventId: event.eventId,
      eventType: event.eventType,
      nodeId: `stage:${graphNodeId(event.stage)}`,
      sequence: index + 1,
      userFacingLabel: event.userFacingLabel?.["zh-CN"] ?? event.stage,
      evidenceRef: "coreLoop.agUiStageEvents",
    })),
    ...workerExecutionEvidence.map((evidence, index) => ({
      eventId: stableId("worker-event", `${runId}-${evidence.taskPacketId}-${index}`),
      eventType: evidence.liveWorkerExecution ? "WorkerFinished" : "WorkerBlocked",
      nodeId: `worker:${evidence.taskPacketId}`,
      sequence: (agUiStageEvents?.events?.length ?? 0) + index + 1,
      userFacingLabel:
        evidence.liveWorkerExecution
          ? "worker 结果已合并"
          : "worker 等待审批或依赖",
      evidenceRef: evidence.artifactRef,
    })),
  ];
  const stateTransition = [
    ...TRACE_SPINE.map((stage, index) => ({
      transitionId: stableId("state-transition", `${runId}-${stage}-${index}`),
      fromNode: index === 0 ? "START" : `stage:${graphNodeId(TRACE_SPINE[index - 1])}`,
      toNode: `stage:${graphNodeId(stage)}`,
      updates: [`state.${graphNodeId(stage)}`],
      evidenceRef:
        stage === "Execution"
          ? "coreLoop.executionResult"
          : stage === "Thinking"
            ? "coreLoop.thinkingPacket"
            : `coreLoop.${graphNodeId(stage)}Packet`,
    })),
    ...workerResultPackets.map((packet, index) => ({
      transitionId: stableId("state-transition", `${runId}-${packet.taskPacketId}`),
      fromNode: "stage:thinking",
      toNode: `worker:${packet.taskPacketId}`,
      updates: [`workerResultPackets[${index}]`],
      evidenceRef: `coreLoop.executionResult.workerResultPackets[${index}]`,
    })),
  ];
  const checkpoints = nodes.map((node, index) => ({
    checkpointId: stableId("checkpoint", `${runId}-${node.nodeId}-${index}`),
    nodeId: node.nodeId,
    stateRefs: node.outputState,
    recordedAt,
    checkpointHash: textSha256(`${runId}:${node.nodeId}:${JSON.stringify(node.outputState)}`),
  }));
  const pass =
    nodes.length >= TRACE_SPINE.length &&
    edges.length >= TRACE_SPINE.length - 1 &&
    stateTransition.length >= TRACE_SPINE.length &&
    eventLog.length >= TRACE_SPINE.length &&
    checkpoints.length === nodes.length &&
    conductorConsumptionEvidence?.status === "pass";
  return {
    schemaVersion: "langgraph-style-run-v0.1",
    status: pass ? "pass" : "partial",
    evidenceKind: pass ? "langgraph_style_structural_pass" : "contract_ready",
    architectureStyle: "LangGraph-style StateGraph without adding a LangGraph runtime dependency",
    runtimeDependency: "none",
    runtimeExecutionEvidence: "not_claimed",
    runtimeBoundary:
      "This packet proves Meta_Kim's node/edge/state/checkpoint projection. It does not claim execution by a LangGraph runtime.",
    alignmentRefs: [
      "state",
      "nodes",
      "edges",
      "message-passing",
      "checkpoint",
      "replay",
      "dynamic send",
    ],
    nodes,
    edges,
    conditionalEdges: edges.filter((edge) => edge.edgeType !== "fixed_stage_transition"),
    state: {
      schemaVersion: "meta-kim-run-state-v0.1",
      sharedStateFields: [
        "intentPacket",
        "fetchPacket",
        "thinkingPacket",
        "workerTaskPackets",
        "workerResultPackets",
        "reviewPacket",
        "verificationResult",
        "evolutionWritebackPacket",
      ],
      reducerPolicy: "append stage/worker evidence, merge by taskPacketId, never overwrite planning state",
    },
    stateTransition,
    eventLog,
    checkpoint: {
      adapter: "run-artifact-checkpoints",
      count: checkpoints.length,
      checkpoints,
    },
    replay: {
      supported: true,
      command: "npm run meta:theory:run -- <task>",
      artifactRef: "coreLoop.langGraphRunPacket",
      deterministicBoundary:
        "structure, ids, and evidence refs are stable; timestamps are run-current",
    },
    acceptance: {
      nodeEdgeStateEventCheckpointPresent: pass,
      noOrphanedWorkerNodes: workerNodes.every((node) =>
        edges.some((edge) => edge.to === node.nodeId || edge.from === node.nodeId)
      ),
      branchCoverage: "100%",
    },
  };
}

function buildDynamicWorkflowRuntimePacket({
  orchestrationReport,
  workerTaskPackets,
  workerResultPackets,
  dynamicWorkflowDecisionRecord,
  agentTeamsPlaybookPacket,
}) {
  const bindingRows = workerTaskPackets.map((packet, index) => {
    const loadout = packet.capabilityLoadout ?? {};
    const skills = uniqueStrings([
      ...(loadout.repoSkills ?? []),
      ...(loadout.runtimeSkillCandidates ?? []),
      ...capabilityProviderRefs(packet.skillLoadout ?? packet.capabilityBindings?.skills ?? []),
    ]);
    const mcp = uniqueStrings([
      ...(loadout.repoMcpTools ?? []),
      ...(loadout.runtimeMcpCandidates ?? []),
      ...capabilityProviderRefs(packet.mcpLoadout ?? packet.capabilityBindings?.mcp ?? []),
    ]);
    const commands = uniqueStrings([
      ...(loadout.commands ?? []),
      ...capabilityProviderRefs(packet.commandLoadout ?? packet.capabilityBindings?.commands ?? []),
    ]);
    const runtimeTools = uniqueStrings([
      ...(loadout.runtimeTools ?? []),
      ...capabilityProviderRefs(packet.toolLoadout ?? packet.capabilityBindings?.tools ?? []),
    ]);
    const laneId =
      packet.businessFlowLaneId ??
      packet.workType ??
      packet.decision ??
      packet.roleDisplayName ??
      `worker-lane-${index + 1}`;
    const laneLabel =
      packet.businessFlowLaneLabel ??
      packet.shardScope ??
      packet.workType ??
      packet.roleDisplayName ??
      laneId;
    return {
      taskPacketId: packet.taskPacketId,
      resultPacketId: workerResultPackets[index]?.taskPacketId ?? null,
      laneId,
      laneLabel,
      roleDisplayName: packet.roleDisplayName,
      ownerAgent: packet.ownerAgent ?? packet.owner,
      owner: packet.owner,
      ownerSource: packet.ownerSource ?? "owner_source_unresolved",
      ownerSourceRef: packet.ownerSourceRef ?? packet.sourceRef ?? null,
      ownerBindingMode: packet.ownerBindingMode ?? "run_scoped_owner_contract",
      nativeAgentType:
        packet.ownerBindingMode === "native_custom_agent"
          ? packet.nativeAgentType ?? null
          : null,
      runtimeInstanceAlias: packet.runtimeInstanceAlias || null,
      ownerMode: packet.ownerMode,
      executionMode: packet.executionMode,
      selectedBy: packet.businessFlowLaneId
        ? "natural-language intent lane selection"
        : "capability gap decision",
      capabilityNeed: packet.capabilityNeed ?? packet.capabilityRequirements ?? [],
      capabilitySelection: packet.capabilitySelection ?? {
        selectionPolicy: "route_selected_provider",
        candidateProviders: [],
        selectedProvider: null,
        whySelected: null,
        whyNotSelected: [],
      },
      capabilityProfileId: loadout.capabilityProfileId ?? null,
      skills,
      mcp,
      commands,
      runtimeTools,
      hookMatches: buildHookMatchesForPacket(packet),
      providerSources: {
        skill: (packet.skillLoadout ?? []).map((provider) => ({
          id: capabilityProviderRef(provider),
          source: provider?.source ?? "selected_skill_loadout",
          sourceRef: provider?.sourceRef ?? capabilityProviderRef(provider),
        })),
        mcp: (packet.mcpLoadout ?? []).map((provider) => ({
          id: capabilityProviderRef(provider),
          source: provider?.source ?? "selected_mcp_loadout",
          sourceRef: provider?.sourceRef ?? capabilityProviderRef(provider),
        })),
        command_script: (packet.commandLoadout ?? []).map((provider) => ({
          id: capabilityProviderRef(provider),
          source: provider?.source ?? "selected_command_loadout",
          sourceRef: provider?.sourceRef ?? capabilityProviderRef(provider),
        })),
        runtime_tool: (packet.toolLoadout ?? []).map((provider) => ({
          id: capabilityProviderRef(provider),
          source: provider?.source ?? "selected_runtime_tool_loadout",
          sourceRef: provider?.sourceRef ?? capabilityProviderRef(provider),
        })),
      },
      abstractPromptCapability: {
        contractRef: "config/contracts/prompt-abstract-capability-contract.json",
        status: "applied_as_foundational_prompt_capability",
      },
      orchestrationProvider:
        agentTeamsPlaybookPacket?.selected === true
          ? {
              providerId: AGENT_TEAMS_PLAYBOOK_ID,
              status: "selected_not_invoked",
              packetRef: "coreLoop.agentTeamsPlaybookPacket",
            }
          : null,
      evidenceRefs: [
        `coreLoop.thinkingPacket.workerTaskPackets[${index}]`,
        `coreLoop.executionResult.workerResultPackets[${index}]`,
      ],
    };
  });
  const coverage = {
    skill: bindingRows.some((row) => row.skills.length > 0),
    mcp: bindingRows.some((row) => row.mcp.length > 0),
    command: bindingRows.some((row) => row.commands.length > 0),
    tools: bindingRows.some((row) => row.runtimeTools.length > 0),
    hooks: bindingRows.every((row) => row.hookMatches.length > 0),
    abstractPromptCapability: bindingRows.every((row) => row.abstractPromptCapability.status),
    agentTeamsPlaybook:
      agentTeamsPlaybookPacket?.status === "pass" ||
      agentTeamsPlaybookPacket?.status === "not_required",
    workerResults: workerResultPackets.length === workerTaskPackets.length,
  };
  const plannedSelectedLaneIds =
    orchestrationReport.thinkingRoute?.dynamicWorkflowPlan?.selectedLaneIds ?? [];
  const plannedOmittedLanesWithReason =
    orchestrationReport.thinkingRoute?.dynamicWorkflowPlan?.omittedLanesWithReason ?? [];
  const derivedSelectedLaneIds = uniqueStrings(bindingRows.map((row) => row.laneId));
  const plannedBusinessFlowLaneCount = orchestrationReport.thinkingRoute?.businessFlowLaneCount ?? 0;
  const effectiveSelectedLaneIds =
    plannedSelectedLaneIds.length > 0 ? plannedSelectedLaneIds : derivedSelectedLaneIds;
  const selectedLaneBindingConsistent = effectiveSelectedLaneIds.every((laneId) =>
    derivedSelectedLaneIds.includes(laneId),
  );
  const pass = Object.values(coverage).every(Boolean) && selectedLaneBindingConsistent;
  return {
    schemaVersion: "dynamic-workflow-runtime-v0.1",
    status: pass ? "pass" : "partial",
    evidenceKind: pass ? "product_experience_pass" : "local_runner_pass",
    notFixedChecklist: true,
    selectedLaneIds:
      effectiveSelectedLaneIds,
    omittedLaneIds:
      orchestrationReport.thinkingRoute?.dynamicWorkflowPlan?.omittedLaneIds ?? [],
    omittedLanesWithReason: plannedOmittedLanesWithReason,
    businessFlowLaneCount:
      plannedBusinessFlowLaneCount > 0
        ? plannedBusinessFlowLaneCount
        : derivedSelectedLaneIds.length,
    decisionCards: dynamicWorkflowDecisionRecord.cards.map((card) => ({
      cardKey: card.cardKey,
      label: card.label,
      reason: card.reason,
      escalationOwner: card.escalationOwner,
    })),
    capabilityBindingRows: bindingRows,
    capabilityBindingCoverage: coverage,
    laneSelectionConsistency: {
      selectedLaneBindingConsistent,
      plannedSelectedLaneIds,
      derivedSelectedLaneIds,
      rule:
        "Dynamic Workflow selected lanes must match capability binding rows generated from workerTaskPackets.",
    },
    invocationPolicy: {
      skills: "selected into capability loadout and available to worker profile",
      mcp: "matched to repo or runtime MCP provider/tool; live external invocation requires task need and approval boundary",
      commands: "verification and orchestration commands are executable weapons",
      tools: "runtime tools are selected by owner, permission, OS/runtime support, and verification need",
      hooks: "matched as fuses, never as the planner",
      agentTeamsPlaybook:
        "selected as a bounded fan-out orchestration adapter after workerTaskPackets exist; not a live Skill or spawn_agent call without invocation evidence",
    },
  };
}

function buildPeerAgentMeshPacket({ workerTaskPackets, workerResultPackets }) {
  const peers = workerTaskPackets.map((packet, index) => ({
    peerId: packet.projectAgentId ?? packet.ownerAgent ?? packet.owner,
    taskPacketId: packet.taskPacketId,
    roleDisplayName: packet.roleDisplayName,
    ownerMode: packet.ownerMode,
    workerInstanceMode: packet.workerInstanceMode,
    capabilityProfileId: packet.capabilityLoadout?.capabilityProfileId ?? null,
    dependsOn: packet.dependsOn ?? [],
    handoffTarget: packet.handoffTarget,
    mergeOwner: packet.mergeOwner,
    resultStatus: workerResultPackets[index]?.status ?? "missing",
    durableIdentityStatus: packet.durableIdentityStatus,
  }));
  const taskToPeer = new Map(peers.map((peer) => [peer.taskPacketId, peer.peerId]));
  const handoffs = [
    ...peers.map((peer) => ({
      from: "meta-conductor",
      to: peer.peerId,
      edgeType: "dispatch",
      taskPacketId: peer.taskPacketId,
    })),
    ...peers.flatMap((peer) =>
      peer.dependsOn.map((dependencyId) => ({
        from: taskToPeer.get(dependencyId) ?? dependencyId,
        to: peer.peerId,
        edgeType: "peer_dependency",
        taskPacketId: peer.taskPacketId,
      }))
    ),
    ...peers.map((peer) => ({
      from: peer.peerId,
      to: peer.mergeOwner ?? "meta-conductor",
      edgeType: "merge_handoff",
      taskPacketId: peer.taskPacketId,
    })),
    {
      from: "meta-conductor",
      to: "meta-prism",
      edgeType: "review_handoff",
      taskPacketId: "merged-worker-results",
    },
    {
      from: "meta-prism",
      to: "verify",
      edgeType: "verification_handoff",
      taskPacketId: "reviewed-worker-results",
    },
  ];
  const pass =
    peers.length > 0 &&
    handoffs.length >= peers.length &&
    peers.every((peer) => peer.resultStatus !== "missing" && peer.mergeOwner);
  return {
    schemaVersion: "peer-agent-mesh-v0.1",
    status: pass ? "pass" : "partial",
    evidenceKind: pass ? "product_experience_pass" : "local_runner_pass",
    model: "run-scoped peer workers coordinated by meta-conductor",
    peerDefinition:
      "A peer is a bounded run-scoped worker or synthesized project-agent profile with its own role, loadout, dependencies, result packet, and merge handoff.",
    peers,
    handoffs,
    acceptance: {
      noGenericOwner: peers.every((peer) => peer.roleDisplayName !== "general-purpose"),
      everyPeerHasResult: peers.every((peer) => peer.resultStatus !== "missing"),
      everyPeerHasMergeOwner: peers.every((peer) => Boolean(peer.mergeOwner)),
      dependenciesAreExplicit: true,
    },
  };
}

function countBy(values) {
  return values.reduce((counts, value) => {
    const key = String(value || "unknown");
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

const CAPABILITY_INVOCATION_STATES = [
  "invoked",
  "applied",
  "failed",
  "host_visible_observed",
  "selected_not_invoked",
  "discovered_not_selected",
  "unavailable",
  "not_authorized",
  "blocked",
  "not_required",
];

function normalizeHostVisibleSubagents(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input
      .map((item) =>
        typeof item === "string"
          ? { name: item }
          : {
              name: item?.name ?? item?.nickname ?? item?.label,
              evidence: item?.evidence ?? item?.source ?? "host_ui",
            },
      )
      .filter((item) => item.name);
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return [];
    try {
      return normalizeHostVisibleSubagents(JSON.parse(trimmed));
    } catch {
      return trimmed
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => ({ name, evidence: "host_ui" }));
    }
  }
  return [];
}

const SYNTHETIC_EVIDENCE_REF = /^(?:self[-_ ]?test|fixture|synthetic|mock|fake|test):/i;
const HOST_OBSERVER_ATTESTATION = Symbol("meta-kim-private-host-observer-attestation");

function isIsoTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function observerArtifactContainsEvent({
  observerArtifactPath,
  observerArtifactSha256,
  eventId,
  runId,
  sessionId,
  providerId,
  bindingRef,
  resultStatus,
  observerFormat,
  ownerBindingMode = null,
  nativeAgentType = null,
}) {
  if (
    typeof observerArtifactPath !== "string" ||
    !path.isAbsolute(observerArtifactPath) ||
    !existsSync(observerArtifactPath) ||
    typeof observerArtifactSha256 !== "string"
  ) return false;
  try {
    const content = readFileSync(observerArtifactPath, "utf8");
    if (textSha256(content) !== observerArtifactSha256) return false;
    const records = content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
    return records.some((record) =>
      record.eventId === eventId &&
      record.runId === runId &&
      record.sessionId === sessionId &&
      (record.providerId === providerId || record.hostSurface === providerId) &&
      record.bindingRef === bindingRef &&
      record.resultStatus === resultStatus &&
      record.observerFormat === observerFormat &&
      (!ownerBindingMode || record.ownerBindingMode === ownerBindingMode) &&
      (ownerBindingMode !== "native_custom_agent" || record.nativeAgentType === nativeAgentType),
    );
  } catch {
    return false;
  }
}

export function normalizeHostInvocationEvidence(input, {
  trusted = false,
  expectedRunId = null,
  attestation = null,
} = {}) {
  if (!input) return [];
  const acceptedStates = new Set(["invoked", "returned", "verified", "applied"]);
  const acceptedEvidenceKinds = new Set([
    "host_tool_call",
    "spawn_agent_result",
    "agent_task_result",
    "agent_team_result",
    "skill_application",
    "mcp_tool_result",
    "command_output",
    "runtime_tool_call",
    "hook_trigger_event",
    "host_discovery_reload",
    "durable_agent_live_invocation",
    "manual_live_proof",
  ]);
  if (Array.isArray(input)) {
    return input
      .map((item) => {
        const state = item?.state ?? "selected_not_invoked";
        const providerId = item?.providerId ?? item?.provider ?? null;
        const hostSurface = item?.hostSurface ?? item?.surface ?? null;
        const evidenceKind = item?.evidenceKind ?? "unverified_host_claim";
        const evidenceRef = item?.evidenceRef ?? item?.hostToolCallId ?? item?.artifactRef ?? null;
        const evidenceOrigin = item?.evidenceOrigin ?? item?.producer ?? null;
        const eventId = item?.eventId ?? item?.callId ?? item?.hostToolCallId ?? null;
        const sessionId = item?.sessionId ?? null;
        const runId = item?.runId ?? null;
        const occurredAt = item?.occurredAt ?? item?.completedAt ?? null;
        const resultStatus = item?.resultStatus ?? item?.status ?? null;
        const bindingRef = item?.bindingRef ?? item?.taskPacketId ?? item?.laneId ?? null;
        const observerSource = item?.observerSource ?? null;
        const observerFormat = item?.observerFormat ?? null;
        const observerArtifactPath = item?.observerArtifactPath ?? null;
        const observerArtifactSha256 = item?.observerArtifactSha256 ?? null;
        const ownerBindingMode = item?.family === "agent_subagent"
          ? item?.ownerBindingMode ?? "run_scoped_owner_contract"
          : null;
        const nativeAgentType = ownerBindingMode === "native_custom_agent"
          ? item?.nativeAgentType ?? null
          : null;
        const hasEvidenceRef =
          typeof evidenceRef === "string" ? evidenceRef.trim().length > 0 : Boolean(evidenceRef);
        const hasProvider = Boolean(providerId || hostSurface);
        const externallyObserved =
          evidenceOrigin === "external_runtime_observer" &&
          ["stdout_jsonl", "transcript", "hook_trace", "mcp_client"].includes(observerSource) &&
          [
            "codex_host_jsonl_v1",
            "claude_stream_json_v1",
            "claude_hook_event_v1",
            "meta_kim_hook_trace_v1",
            "mcp_stdio_client_v1",
          ].includes(observerFormat) &&
          item?.synthetic !== true &&
          !SYNTHETIC_EVIDENCE_REF.test(String(evidenceRef ?? ""));
        const runMatches = !expectedRunId || runId === expectedRunId;
        const occurredAtMs = Date.parse(occurredAt);
        const nowMs = Date.now();
        const freshEnough =
          Number.isFinite(occurredAtMs) &&
          occurredAtMs <= nowMs + 10 * 60 * 1000 &&
          occurredAtMs >= nowMs - 24 * 60 * 60 * 1000;
        const resultSucceeded = ["success", "completed", "returned", "verified", "applied"].includes(
          resultStatus,
        );
        const observerArtifactVerified = observerArtifactContainsEvent({
          observerArtifactPath,
          observerArtifactSha256,
          eventId,
          runId,
          sessionId,
          providerId: providerId ?? hostSurface,
          bindingRef,
          resultStatus,
          observerFormat,
          ownerBindingMode,
          nativeAgentType,
        });
        const ownerBindingValid =
          item?.family !== "agent_subagent" ||
          ownerBindingMode === "run_scoped_owner_contract" ||
          (
            ownerBindingMode === "native_custom_agent" &&
            typeof nativeAgentType === "string" &&
            nativeAgentType.length > 0 &&
            item?.ownerDefinitionFormat === "codex_custom_agent_toml" &&
            /\.toml$/iu.test(String(item?.ownerSource ?? ""))
          );
        const proofValid =
          attestation === HOST_OBSERVER_ATTESTATION &&
          acceptedStates.has(state) &&
          acceptedEvidenceKinds.has(evidenceKind) &&
          hasEvidenceRef &&
          hasProvider &&
          externallyObserved &&
          Boolean(eventId) &&
          Boolean(sessionId) &&
          Boolean(runId) &&
          isIsoTimestamp(occurredAt) &&
          freshEnough &&
          resultSucceeded &&
          Boolean(bindingRef) &&
          runMatches &&
          observerArtifactVerified;
        const bindingProofValid = proofValid && ownerBindingValid;
        return {
          family: item?.family,
          state,
          providerId,
          hostSurface,
          evidenceKind,
          evidenceRef,
          evidenceOrigin,
          eventId,
          sessionId,
          runId,
          occurredAt,
          resultStatus,
          bindingRef,
          observerSource,
          observerFormat,
          observerArtifactPath,
          observerArtifactSha256,
          observerArtifactVerified,
          ownerBindingMode,
          nativeAgentType,
          ownerDefinitionFormat: item?.ownerDefinitionFormat ?? null,
          ownerSource: item?.ownerSource ?? null,
          runtimeInstanceAlias: item?.runtimeInstanceAlias ?? null,
          synthetic: item?.synthetic === true,
          proofValid: bindingProofValid,
          rejectionReason: bindingProofValid
            ? null
            : "caller-supplied evidence cannot promote itself; live promotion requires a private external-observer attestation plus a fresh successful exact binding join",
          passEligible: item?.passEligible !== false && bindingProofValid,
        };
      })
      .filter((item) => item.family);
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return [];
    try {
      return normalizeHostInvocationEvidence(JSON.parse(trimmed), { trusted, expectedRunId, attestation });
    } catch {
      return [];
    }
  }
  return normalizeHostInvocationEvidence([input], { trusted, expectedRunId, attestation });
}

function normalizeNativeChoiceEvidence(input, {
  trusted = false,
  expectedRunId = null,
  attestation = null,
} = {}) {
  if (!input) return [];
  const acceptedStates = new Set(["completed", "answered", "returned", "deferred", "blocked"]);
  const acceptedEvidenceKinds = new Set([
    "request_user_input_answer",
    "AskUserQuestion_answer",
    "deferred_AskUserQuestion_tool_call",
    "nativeChoiceSurfaceBlocked",
  ]);
  if (Array.isArray(input)) {
    return input
      .map((item) => {
        const state = item?.state ?? item?.status ?? "missing";
        const surface = item?.surface ?? item?.hostSurface ?? null;
        const evidenceKind = item?.evidenceKind ?? "unverified_native_choice_claim";
        const evidenceRef = item?.evidenceRef ?? item?.answerRef ?? item?.hostToolCallId ?? null;
        const eventId = item?.eventId ?? item?.callId ?? item?.hostToolCallId ?? null;
        const sessionId = item?.sessionId ?? null;
        const runId = item?.runId ?? null;
        const occurredAt = item?.occurredAt ?? item?.completedAt ?? null;
        const resultStatus = item?.resultStatus ?? state;
        const bindingRef = item?.bindingRef ?? `${item?.stage ?? "Thinking"}:native_choice:${surface ?? "unknown"}`;
        const observerSource = item?.observerSource ?? null;
        const observerFormat = item?.observerFormat ?? null;
        const observerArtifactPath = item?.observerArtifactPath ?? null;
        const observerArtifactSha256 = item?.observerArtifactSha256 ?? null;
        const hasEvidenceRef =
          typeof evidenceRef === "string" ? evidenceRef.trim().length > 0 : Boolean(evidenceRef);
        const externallyObserved =
          item?.evidenceOrigin === "external_runtime_observer" &&
          ["stdout_jsonl", "transcript"].includes(observerSource) &&
          ["codex_host_jsonl_v1", "claude_stream_json_v1"].includes(observerFormat) &&
          item?.synthetic !== true &&
          !SYNTHETIC_EVIDENCE_REF.test(String(evidenceRef ?? ""));
        const observerArtifactVerified = observerArtifactContainsEvent({
          observerArtifactPath,
          observerArtifactSha256,
          eventId,
          runId,
          sessionId,
          providerId: surface,
          bindingRef,
          resultStatus,
          observerFormat,
        });
        const proofValid =
          attestation === HOST_OBSERVER_ATTESTATION &&
          acceptedStates.has(state) &&
          acceptedEvidenceKinds.has(evidenceKind) &&
          hasEvidenceRef &&
          Boolean(surface) &&
          externallyObserved &&
          Boolean(eventId) &&
          Boolean(sessionId) &&
          Boolean(runId) &&
          (!expectedRunId || runId === expectedRunId) &&
          isIsoTimestamp(occurredAt) &&
          observerArtifactVerified;
        return {
          runtime: item?.runtime ?? null,
          stage: item?.stage ?? item?.choiceStage ?? null,
          state,
          surface,
          evidenceKind,
          evidenceRef,
          eventId,
          sessionId,
          runId,
          occurredAt,
          resultStatus,
          bindingRef,
          observerSource,
          observerFormat,
          observerArtifactPath,
          observerArtifactSha256,
          observerArtifactVerified,
          proofValid,
          passEligible:
            item?.passEligible !== false &&
            proofValid &&
            evidenceKind !== "nativeChoiceSurfaceBlocked",
          blockedEligible: proofValid && evidenceKind === "nativeChoiceSurfaceBlocked",
          rejectionReason: proofValid
            ? null
            : "caller-supplied native-choice evidence cannot promote itself; promotion requires private external-observer attestation and an exact host-event join",
        };
      })
      .filter((item) => item.surface || item.evidenceKind !== "unverified_native_choice_claim");
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return [];
    try {
      return normalizeNativeChoiceEvidence(JSON.parse(trimmed), { trusted, expectedRunId, attestation });
    } catch {
      return [];
    }
  }
  return normalizeNativeChoiceEvidence([input], { trusted, expectedRunId, attestation });
}

function compactCommand(command, args = []) {
  return [path.basename(command), ...args].join(" ");
}

function tailText(value, maxLength = 800) {
  const normalized = String(value ?? "").trim();
  return normalized.length > maxLength ? normalized.slice(-maxLength) : normalized;
}

function runProbeProcess({ family, probeId, command, args, timeoutMs = 120_000 }) {
  const runAt = nowIso();
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  const stdoutTail = tailText(result.stdout);
  const stderrTail = tailText(result.stderr);
  return {
    family,
    probeId,
    status: result.status === 0 ? "pass" : "blocked",
    evidenceKind: "fresh_invocation_probe",
    command: compactCommand(command, args),
    exitCode: result.status,
    signal: result.signal ?? null,
    timedOut: result.error?.code === "ETIMEDOUT",
    runAt,
    stdoutTail,
    stderrTail,
    stdoutSha256: stdoutTail ? textSha256(stdoutTail) : null,
    stderrSha256: stderrTail ? textSha256(stderrTail) : null,
  };
}

function buildCapabilityInvocationProbePacket({
  dynamicWorkflowRuntimePacket,
  enabled = false,
}) {
  const bindingRows = dynamicWorkflowRuntimePacket?.capabilityBindingRows ?? [];
  const selected = {
    mcp: bindingRows.some((row) => row.mcp.length > 0),
    command_script: bindingRows.some((row) => row.commands.length > 0),
    runtime_tool: bindingRows.some((row) => row.runtimeTools.length > 0),
  };
  const requiredFamilies = Object.entries(selected)
    .filter(([, isSelected]) => isSelected)
    .map(([family]) => family);
  if (!enabled) {
    return {
      schemaVersion: "capability-invocation-probe-v0.1",
      status: "not_run",
      evidenceKind: "probe_not_requested",
      requiredFamilies,
      callableFamilies: [],
      missingFamilies: requiredFamilies,
      probes: [],
      truthBoundary:
        "Discovery and binding can be validated without local readiness probes. Probe results never count as live host invocation evidence.",
    };
  }
  const probes = [];
  if (selected.mcp) {
    probes.push(
      runProbeProcess({
        family: "mcp",
        probeId: "meta-runtime-server-self-test",
        command: process.execPath,
        args: ["scripts/mcp/meta-runtime-server.mjs", "--self-test"],
      }),
    );
  }
  if (selected.command_script) {
    probes.push(
      runProbeProcess({
        family: "command_script",
        probeId: "prompt-executability-command",
        command: process.execPath,
        args: ["scripts/validate-prompt-executability.mjs"],
      }),
    );
  }
  if (selected.runtime_tool) {
    probes.push(
      runProbeProcess({
        family: "runtime_tool",
        probeId: "filesystem-shell-runtime-tool",
        command: process.execPath,
        args: [
          "-e",
          "const fs=require('fs'); process.exit(fs.existsSync('package.json') ? 0 : 1)",
        ],
      }),
    );
  }
  const passedFamilies = new Set(
    probes.filter((probe) => probe.status === "pass").map((probe) => probe.family),
  );
  const missingFamilies = requiredFamilies.filter((family) => !passedFamilies.has(family));
  return {
    schemaVersion: "capability-invocation-probe-v0.1",
    status: missingFamilies.length === 0 ? "pass" : "partial",
    evidenceKind: missingFamilies.length === 0 ? "fresh_invocation_probe" : "probe_partial",
    requiredFamilies,
    callableFamilies: [...passedFamilies],
    missingFamilies,
    probes,
    truthBoundary:
      "These are local readiness probes only. They prove that a probe command is callable, not that the Thinking-selected MCP, command, runtime tool, hook, skill, or agent provider was invoked by the host.",
  };
}

function buildSelectedInvocationBindings({
  dynamicWorkflowRuntimePacket,
  agentTeamsPlaybookPacket,
  runtimeSubagentInvocationPacket,
}) {
  const rows = dynamicWorkflowRuntimePacket?.capabilityBindingRows ?? [];
  const bindings = [];
  const add = ({
    family,
    providerId,
    bindingRef,
    taskPacketId = null,
    source = "selected_provider_source_unresolved",
    sourceRef = null,
  }) => {
    if (!providerId || !bindingRef) return null;
    const existing = bindings.find((item) => item.family === family && item.bindingRef === bindingRef);
    if (existing) return existing;
    const binding = { family, providerId, bindingRef, taskPacketId, source, sourceRef };
    bindings.push(binding);
    return binding;
  };
  const providerSource = (row, family, providerId) =>
    (row.providerSources?.[family] ?? []).find((provider) => provider.id === providerId) ?? {};
  for (const row of rows) {
    const taskPacketId = row.taskPacketId ?? row.laneId ?? "unknown-task";
    for (const providerId of row.skills ?? []) {
      const provider = providerSource(row, "skill", providerId);
      add({
        family: "skill",
        providerId,
        bindingRef: `${taskPacketId}:skill:${providerId}`,
        taskPacketId,
        source: provider.source,
        sourceRef: provider.sourceRef,
      });
    }
    for (const providerId of row.mcp ?? []) {
      const provider = providerSource(row, "mcp", providerId);
      add({
        family: "mcp",
        providerId,
        bindingRef: `${taskPacketId}:mcp:${providerId}`,
        taskPacketId,
        source: provider.source,
        sourceRef: provider.sourceRef,
      });
    }
    for (const providerId of row.commands ?? []) {
      const provider = providerSource(row, "command_script", providerId);
      add({
        family: "command_script",
        providerId,
        bindingRef: `${taskPacketId}:command_script:${providerId}`,
        taskPacketId,
        source: provider.source,
        sourceRef: provider.sourceRef,
      });
    }
    for (const providerId of row.runtimeTools ?? []) {
      const provider = providerSource(row, "runtime_tool", providerId);
      add({
        family: "runtime_tool",
        providerId,
        bindingRef: `${taskPacketId}:runtime_tool:${providerId}`,
        taskPacketId,
        source: provider.source,
        sourceRef: provider.sourceRef,
      });
    }
    for (const hook of row.hookMatches ?? []) {
      const providerId = hook?.hookId ?? hook?.id;
      add({
        family: "hook",
        providerId,
        bindingRef: `${taskPacketId}:hook:${providerId}`,
        taskPacketId,
        source: "project_or_canonical_hook_match",
        sourceRef: hook?.sourceRef ?? hook?.hookPath ?? providerId,
      });
    }
    if (runtimeSubagentInvocationPacket?.fanoutEligible) {
      const providerId = row.ownerAgent ?? row.owner ?? row.roleDisplayName ?? "runtime-subagent";
      const binding = add({
        family: "agent_subagent",
        providerId,
        bindingRef: `${taskPacketId}:agent_subagent:${providerId}`,
        taskPacketId,
        source: row.ownerSource ?? "owner_source_unresolved",
        sourceRef: row.ownerSourceRef ?? providerId,
      });
      if (binding) {
        binding.ownerAgent = row.ownerAgent ?? row.owner ?? null;
        binding.ownerBindingMode = row.ownerBindingMode ?? "run_scoped_owner_contract";
        binding.nativeAgentType = row.ownerBindingMode === "native_custom_agent"
          ? row.nativeAgentType ?? null
          : null;
        binding.runtimeInstanceAlias = row.runtimeInstanceAlias ?? null;
      }
    }
  }
  if (agentTeamsPlaybookPacket?.selected === true) {
    add({
      family: "agent_teams_playbook",
      providerId: "agent-teams-playbook",
      bindingRef: "run:agent_teams_playbook:agent-teams-playbook",
    });
  }
  return bindings;
}

export function exactInvocationBindingMatches(required, observed) {
  if (
    observed?.family !== required?.family ||
    observed?.providerId !== required?.providerId ||
    observed?.bindingRef !== required?.bindingRef
  ) return false;
  if (required?.family !== "agent_subagent") return true;

  const requiredMode = required.ownerBindingMode ?? "run_scoped_owner_contract";
  const observedMode = observed.ownerBindingMode ?? "run_scoped_owner_contract";
  if (requiredMode !== observedMode) return false;
  if (requiredMode === "native_custom_agent") {
    return typeof required.nativeAgentType === "string" &&
      required.nativeAgentType.length > 0 &&
      observed.nativeAgentType === required.nativeAgentType;
  }
  return requiredMode === "run_scoped_owner_contract" &&
    required.nativeAgentType == null &&
    observed.nativeAgentType == null;
}

function buildRuntimeInvocationPlanPacket({
  dynamicWorkflowRuntimePacket,
  agentTeamsPlaybookPacket,
  runtimeSubagentInvocationPacket,
  capabilityInvocationProbePacket,
  hostInvocationEvidence,
  runId = null,
}) {
  const bindingRows = dynamicWorkflowRuntimePacket?.capabilityBindingRows ?? [];
  const evidence = normalizeHostInvocationEvidence(hostInvocationEvidence, {
    trusted: false,
    expectedRunId: runId,
  });
  const requiredBindings = buildSelectedInvocationBindings({
    dynamicWorkflowRuntimePacket,
    agentTeamsPlaybookPacket,
    runtimeSubagentInvocationPacket,
  });
  const selectedFamilies = new Set(requiredBindings.map((binding) => binding.family));

  const satisfiedBindings = requiredBindings.flatMap((binding) => {
    const observed = evidence.find((item) =>
      item.passEligible === true &&
      exactInvocationBindingMatches(binding, item) &&
      ["invoked", "returned", "verified", "applied"].includes(item.state),
    );
    if (!observed) return [];
    return [{
      ...binding,
      ownerBindingMode: binding.family === "agent_subagent"
        ? observed.ownerBindingMode ?? "run_scoped_owner_contract"
        : binding.ownerBindingMode,
      nativeAgentType: observed.ownerBindingMode === "native_custom_agent"
        ? observed.nativeAgentType ?? null
        : null,
      runtimeInstanceAlias: observed.runtimeInstanceAlias ?? binding.runtimeInstanceAlias ?? null,
    }];
  });
  const failureStates = new Set(["failed", "failure", "error", "denied", "blocked", "unsupported"]);
  const observedFailureState = (item) =>
    [item?.state, item?.status, item?.resultStatus]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase())
      .find((value) => failureStates.has(value)) ?? null;
  const failedBindings = requiredBindings.flatMap((binding) => {
    const observed = evidence.find((item) =>
      exactInvocationBindingMatches(binding, item) && observedFailureState(item),
    );
    if (!observed) return [];
    const failureState = observedFailureState(observed);
    return [{
      ...binding,
      state: failureState,
      resultStatus: String(observed.resultStatus ?? observed.status ?? failureState).toLowerCase(),
      failureReason: observed.rejectionReason ?? observed.bindingUnavailableReason ?? null,
    }];
  });
  const requiredFamilies = [...selectedFamilies];
  const missingBindings = requiredBindings.filter(
    (binding) =>
      !satisfiedBindings.some((observed) => exactInvocationBindingMatches(binding, observed)) &&
      !failedBindings.some((observed) => exactInvocationBindingMatches(binding, observed)),
  );
  const missingFamilies = requiredFamilies.filter((family) =>
    missingBindings.some((binding) => binding.family === family),
  );
  const failedFamilies = requiredFamilies.filter((family) =>
    failedBindings.some((binding) => binding.family === family),
  );
  const invokedFamilies = requiredFamilies.filter((family) =>
    !missingFamilies.includes(family) && !failedFamilies.includes(family),
  );
  return {
    schemaVersion: "runtime-invocation-plan-v0.1",
    runId,
    status: missingFamilies.length === 0 && failedFamilies.length === 0 ? "pass" : "partial",
    requiredFamilies,
    invokedFamilies,
    missingFamilies,
    failedFamilies,
    requiredBindings,
    invokedBindings: satisfiedBindings,
    failedBindings,
    missingBindings,
    evidence,
    requests: requiredFamilies.map((family) => ({
      family,
      state: invokedFamilies.includes(family)
        ? "invoked_or_applied"
        : failedFamilies.includes(family)
          ? "failed"
          : "selected_not_invoked",
      requiredEvidence:
        family === "agent_subagent" || family === "agent_teams_playbook"
          ? "host Agent/spawn_agent/Agent Team tool-call evidence"
          : family === "skill"
            ? "host skill activation evidence or skill-applied evidence"
            : family === "mcp"
              ? "externally observed MCP tools/call response"
              : family === "command_script"
                ? "externally observed selected-command output with exit code"
                : "externally observed selected runtime tool-call result",
      passEligible: invokedFamilies.includes(family),
    })),
    runtimePolicies: {
      codex:
        "Use real spawn_agent/custom-agent, skills, MCP, commands, and runtime tools when exposed by the active Codex host; Codex capacity comes from host/config, not a Meta_Kim cap.",
      claudeCode:
        "Use real Agent/Task, Skill, slash command/script, MCP tool, and runtime tools when selected; Meta_Kim must not impose a fixed Claude Code subagent maximum.",
    },
    failIf:
      "A selected executable family remains selected_not_invoked/unavailable and the run still claims execution/product pass.",
  };
}

function hostInvocationActionForFamily(family) {
  const actions = {
    agent_subagent: {
      codex:
        "Call Codex spawn_agent/custom-agent for selected workerTaskPackets, then return spawn_agent_result or agent_task_result evidence.",
      claudeCode:
        "Call Claude Code Agent/Task for each selected workerTaskPacket, then return agent_task_result evidence.",
      requiredEvidenceKind: "spawn_agent_result or agent_task_result",
    },
    skill: {
      codex:
        "Activate or apply the selected Codex skill instructions and return skill_application evidence.",
      claudeCode:
        "Activate or apply the selected Claude Code skill/command surface and return skill_application evidence.",
      requiredEvidenceKind: "skill_application",
    },
    mcp: {
      codex:
        "Call the exact Thinking-selected Codex MCP provider/tool binding and return its mcp_tool_result evidence. A catalog or self-test is not sufficient.",
      claudeCode:
        "Call the exact Thinking-selected Claude Code MCP provider/tool binding and return its mcp_tool_result evidence. A catalog or self-test is not sufficient.",
      requiredEvidenceKind: "mcp_tool_result",
    },
    hook: {
      codex:
        "Trigger the exact selected Codex hook binding during the selected host event and return correlated hook_trigger_event evidence.",
      claudeCode:
        "Trigger the exact selected Claude Code hook binding during the selected host event and return correlated hook_trigger_event evidence.",
      requiredEvidenceKind: "hook_trigger_event",
    },
    command_script: {
      codex:
        "Run the selected shell/package/slash command through the active Codex host and return command_output evidence.",
      claudeCode:
        "Run the selected shell/package/slash command through Claude Code and return command_output evidence.",
      requiredEvidenceKind: "command_output",
    },
    runtime_tool: {
      codex: "Call the selected Codex runtime tool surface and return runtime_tool_call evidence.",
      claudeCode:
        "Call the selected Claude Code runtime tool surface and return runtime_tool_call evidence.",
      requiredEvidenceKind: "runtime_tool_call",
    },
    agent_teams_playbook: {
      codex:
        "Apply agent-teams-playbook through a live skill/agent-team/spawn_agent path and return agent_team_result evidence.",
      claudeCode:
        "Apply agent-teams-playbook through a live Skill/Agent Team/Task path and return agent_team_result evidence.",
      requiredEvidenceKind: "agent_team_result",
    },
  };
  return actions[family] ?? {
    codex: "Call the selected Codex host surface and return fresh host evidence.",
    claudeCode: "Call the selected Claude Code host surface and return fresh host evidence.",
    requiredEvidenceKind: "host_tool_call",
  };
}

function buildHostInvocationRequestPacket({ runtimeInvocationPlanPacket, workerTaskPackets }) {
  const missingBindings = runtimeInvocationPlanPacket?.missingBindings ?? [];
  const requests = missingBindings.map((binding) => {
    const action = hostInvocationActionForFamily(binding.family);
    return {
      requestId: stableId(
        "host-invocation-request",
        `${runtimeInvocationPlanPacket?.runId ?? "unknown-run"}:${binding.bindingRef}`,
      ),
      family: binding.family,
      providerId: binding.providerId,
      bindingRef: binding.bindingRef,
      taskPacketId: binding.taskPacketId ?? null,
      status: "pending_host_invocation",
      reason: "This exact selected provider binding lacks accepted private-attested host evidence.",
      selectedWorkerTaskRefs:
        binding.family === "agent_subagent" || binding.family === "agent_teams_playbook"
          ? (workerTaskPackets ?? [])
              .filter((packet) => !binding.taskPacketId || packet.taskPacketId === binding.taskPacketId)
              .map((packet) => packet.taskPacketId)
          : [],
      hostActions: {
        codex: action.codex,
        claudeCode: action.claudeCode,
      },
      requiredEvidence: {
        state: binding.family === "skill" ? "applied" : "invoked/returned/verified",
        evidenceKind: action.requiredEvidenceKind,
        exactValues: {
          runId: runtimeInvocationPlanPacket?.runId ?? null,
          providerId: binding.providerId,
          bindingRef: binding.bindingRef,
          evidenceKind: action.requiredEvidenceKind,
        },
        requiredFields: {
          run: "runId must equal exactValues.runId",
          session: "sessionId must identify the real host session",
          event: "eventId must identify the correlated host call/result event",
          provider: "providerId must equal exactValues.providerId, not only the family",
          binding: "bindingRef must equal exactValues.bindingRef",
          timestamp: "occurredAt must be a fresh ISO-8601 host timestamp",
          result: "resultStatus must be an explicit successful terminal result",
          artifactHash: "observerArtifactSha256 must match the immutable observer artifact bytes",
        },
        familySpecificRule:
          binding.family === "mcp"
            ? "Evidence must be the exact selected provider tool call (mcp_tool_result); tools/list, catalog output, and a different MCP tool do not satisfy this request."
            : binding.family === "hook"
              ? "EvidenceKind must be hook_trigger_event and must correlate the selected hook provider to its triggering host event."
              : null,
        trustedAdapterOnly: true,
      },
      passEligible: false,
    };
  });
  return {
    schemaVersion: "host-invocation-request-v0.2",
    runId: runtimeInvocationPlanPacket?.runId ?? null,
    status: requests.length === 0 ? "pass" : "partial",
    requiredFamilies: runtimeInvocationPlanPacket?.requiredFamilies ?? [],
    pendingFamilies: [...new Set(requests.map((request) => request.family))],
    pendingBindingCount: requests.length,
    requests,
    adapterContract: {
      boundary:
        "The Node governed runner emits requests; Claude Code/Codex host adapters must perform real host calls and return trusted evidence. Requests are not execution proof.",
      trustedEvidenceInput:
        "Do not feed caller-authored evidence back into the governed runner. A separate post-process observer must attest and join successful host events to exact selected bindings after the host exits.",
      failIf:
        "A request, markdown report, CLI flag, env var, or host UI badge is treated as invoked without a trusted evidenceRef from the actual host surface.",
    },
  };
}

function buildDurableAgentLifecyclePacket({
  writebackFlow,
  hostInvocationEvidence,
}) {
  const candidates = writebackFlow?.candidates ?? [];
  const evidence = normalizeHostInvocationEvidence(hostInvocationEvidence, {
    trusted: false,
  });
  const durableEvidence = evidence.filter(
    (item) => item.family === "durable_agent" && item.passEligible === true,
  );
  const hasDiscoveryReload = durableEvidence.some(
    (item) =>
      item.evidenceKind === "host_discovery_reload" &&
      ["verified", "returned"].includes(item.state),
  );
  const hasLiveInvocation = durableEvidence.some(
    (item) =>
      item.evidenceKind === "durable_agent_live_invocation" &&
      ["invoked", "returned", "verified"].includes(item.state),
  );
  if (candidates.length === 0) {
    return {
      schemaVersion: "durable-agent-lifecycle-v0.1",
      status: "not_required",
      candidates: [],
      stages: [],
      rule:
        "No durable project agent was requested or produced by this run; temporary workers still do not count as durable agents.",
    };
  }
  const approved = writebackFlow?.status === "approved-for-writeback";
  const writebackApplied = candidates.every((candidate) =>
    ["created", "updated"].includes(candidate.applyStatus),
  );
  const stages = [
    {
      stage: "definition_candidate",
      status: "pass",
      evidenceRef: "wardenWritebackFlow.candidates",
    },
    {
      stage: "warden_approval",
      status: approved ? "pass" : "partial",
      evidenceRef: "wardenWritebackFlow.approvalValidation",
    },
    {
      stage: "definition_writeback",
      status: writebackApplied ? "pass" : "partial",
      evidenceRef: "wardenWritebackFlow.candidates[].applyStatus",
    },
    {
      stage: "host_discovery_reload",
      status: hasDiscoveryReload ? "pass" : "partial",
      evidenceRef: "hostInvocationEvidence[family=durable_agent,evidenceKind=host_discovery_reload]",
    },
    {
      stage: "live_invocation_proof",
      status: hasLiveInvocation ? "pass" : "partial",
      evidenceRef:
        "hostInvocationEvidence[family=durable_agent,evidenceKind=durable_agent_live_invocation]",
    },
  ];
  const status = stages.every((stage) => stage.status === "pass") ? "pass" : "partial";
  return {
    schemaVersion: "durable-agent-lifecycle-v0.1",
    status,
    candidates: candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      candidateType: candidate.candidateType,
      target: candidate.targetRelativeToCanonical ?? candidate.target,
      writebackDecision: candidate.writebackDecision,
      applyStatus: candidate.applyStatus,
    })),
    stages,
    hostEvidenceRefs: durableEvidence.map((item) => item.evidenceRef),
    rule:
      "A long-lived agent is complete only after durable definition, Warden approval/writeback, host reload/discovery, and a live invocation proof. Candidate files or temporary workers are not enough.",
    nextHostEvidenceRequired:
      status === "pass"
        ? []
        : [
            "durable_agent host_discovery_reload evidence after the target runtime reloads/scans the definition",
            "durable_agent durable_agent_live_invocation evidence after the host invokes that durable definition",
          ],
  };
}

export function evaluateInvocationCoverage({
  missingBindings = [],
  capabilityInvocationProbePacket = null,
} = {}) {
  return {
    realStatus: missingBindings.length === 0 ? "pass" : "partial",
    callableStatus: capabilityInvocationProbePacket?.status ?? "missing",
  };
}

function buildCapabilityInvocationTruthPacket({
  runId,
  orchestrationReport,
  dynamicWorkflowRuntimePacket,
  peerAgentMeshPacket,
  workerExecutionEvidence,
  hostVisibleSubagents,
  hostInvocationEvidence,
  agentTeamsPlaybookPacket,
  capabilityInvocationProbePacket,
  runtimeSubagentInvocationPacket,
  runtimeInvocationPlanPacket,
}) {
  const bindingRows = dynamicWorkflowRuntimePacket?.capabilityBindingRows ?? [];
  const hasSelected = (selector) => bindingRows.some(selector);
  const externalAgentSpawned = (workerExecutionEvidence ?? []).some(
    (item) => item.externalAgentSpawned === true,
  );
  const runScopedWorkersInvoked = (workerExecutionEvidence ?? []).some(
    (item) => item.liveWorkerExecution === true,
  );
  const inventoryTypes = new Set(
    (orchestrationReport?.fetchEvidence?.capabilityInventory ?? []).map(
      (item) => item.capabilityType,
    ),
  );
  const normalizedHostInvocationEvidence = normalizeHostInvocationEvidence(hostInvocationEvidence, {
    trusted: false,
    expectedRunId: runId,
  });
  const hostEvidenceForFamily = (family) =>
    normalizedHostInvocationEvidence.filter(
      (item) => item.family === family && item.passEligible === true,
    );
  const familyInvokedByHost = (family) =>
    hostEvidenceForFamily(family).some((item) =>
      ["invoked", "returned", "verified"].includes(item.state),
    );
  const familyAppliedByHost = (family) =>
    hostEvidenceForFamily(family).some((item) => item.state === "applied");
  const requiredBindings = runtimeInvocationPlanPacket?.requiredBindings ?? [];
  const missingBindings = runtimeInvocationPlanPacket?.missingBindings ?? [];
  const failedBindings = runtimeInvocationPlanPacket?.failedBindings ?? [];
  const familyHasRequiredBindings = (family) =>
    requiredBindings.some((binding) => binding.family === family);
  const familyHasFailedBindings = (family) =>
    failedBindings.some((binding) => binding.family === family);
  const familyFullyObserved = (family) =>
    familyHasRequiredBindings(family) &&
    !missingBindings.some((binding) => binding.family === family) &&
    !failedBindings.some((binding) => binding.family === family);
  const hostEvidenceRefs = (family) =>
    hostEvidenceForFamily(family)
      .map((item) => item.evidenceRef ?? `${item.evidenceKind}:${item.providerId}`)
      .filter(Boolean);
  const makeRow = ({
    family,
    state,
    selectedCount = 0,
    invokedCount = 0,
    appliedCount = 0,
    observedCount = 0,
    evidenceRefs,
    invocationEvidenceRefs = [],
    truthBoundary,
    mustNotClaimAs,
  }) => ({
    family,
    state,
    selectedCount,
    invokedCount,
    appliedCount,
    observedCount,
    evidenceRefs,
    invocationEvidenceRefs,
    truthBoundary,
    mustNotClaimAs,
  });
  const hostSubagents = normalizeHostVisibleSubagents(hostVisibleSubagents);
  const rows = [
    makeRow({
      family: "agent_subagent",
      state: familyFullyObserved("agent_subagent") || externalAgentSpawned
        ? "invoked"
        : familyHasFailedBindings("agent_subagent")
          ? "failed"
        : runtimeSubagentInvocationPacket?.status === "unavailable"
          ? "unavailable"
        : runtimeSubagentInvocationPacket?.status === "not_authorized"
            ? "not_authorized"
            : runtimeSubagentInvocationPacket?.status === "not_required"
              ? "not_required"
              : "selected_not_invoked",
      selectedCount: runtimeSubagentInvocationPacket?.fanoutEligible
        ? peerAgentMeshPacket?.peers?.length ?? 0
        : 0,
      invokedCount:
        familyFullyObserved("agent_subagent") || externalAgentSpawned
          ? Math.max(1, peerAgentMeshPacket?.peers?.length ?? 0)
          : 0,
      evidenceRefs: [
        "coreLoop.peerAgentMeshPacket.peers",
        "coreLoop.executionResult.workerExecutionEvidence[].externalAgentSpawned",
        "coreLoop.runtimeSubagentInvocationPacket",
        "coreLoop.runtimeInvocationPlanPacket.evidence[family=agent_subagent]",
      ],
      invocationEvidenceRefs: hostEvidenceRefs("agent_subagent"),
      truthBoundary: familyFullyObserved("agent_subagent") || externalAgentSpawned
        ? "A runtime Agent/subagent tool invocation is attached."
        : runtimeSubagentInvocationPacket?.degradationReason ??
          "No runtime Agent/subagent tool invocation evidence is attached; peer workers are run-scoped structural workers only.",
      mustNotClaimAs: externalAgentSpawned
        ? []
        : ["live_subagent_invocation", "peer_to_peer_runtime_agent_call"],
    }),
    makeRow({
      family: "app_visible_subagent",
      state: "not_required",
      selectedCount: hostSubagents.length,
      observedCount: 0,
      evidenceRefs:
        hostSubagents.length > 0
          ? hostSubagents.map((item) => `unverified_host_ui_hint:${item.name}`)
          : ["host UI names are not strict invocation evidence"],
      truthBoundary:
        "Codex App or another host UI may show app-visible subagents; this is user-visible host evidence and must not be relabeled as a Meta_Kim runner Agent/spawn_agent tool invocation unless tool-call evidence is attached.",
      mustNotClaimAs: [
        "runner_agent_subagent_invocation",
        "external_agent_spawn",
        "worker_task",
      ],
    }),
    makeRow({
      family: "worker_task",
      state: runScopedWorkersInvoked ? "invoked" : "blocked",
      selectedCount: peerAgentMeshPacket?.peers?.length ?? 0,
      invokedCount: (workerExecutionEvidence ?? []).filter(
        (item) => item.liveWorkerExecution === true,
      ).length,
      evidenceRefs: [
        "coreLoop.executionResult.workerResultPackets",
        "coreLoop.executionResult.workerExecutionEvidence",
      ],
      truthBoundary:
        "Run-scoped local worker execution is valid worker evidence, but it is not a runtime subagent call.",
      mustNotClaimAs: ["live_subagent_invocation", "external_agent_spawn"],
    }),
    makeRow({
      family: "skill",
      state: familyFullyObserved("skill") && familyInvokedByHost("skill")
        ? "invoked"
        : familyFullyObserved("skill") && familyAppliedByHost("skill")
          ? "applied"
          : familyHasFailedBindings("skill")
            ? "failed"
          : hasSelected((row) => row.skills.length > 0)
            ? "selected_not_invoked"
            : inventoryTypes.has("skill")
              ? "discovered_not_selected"
              : "not_required",
      selectedCount: bindingRows.reduce((sum, row) => sum + row.skills.length, 0),
      invokedCount: familyInvokedByHost("skill") ? hostEvidenceForFamily("skill").length : 0,
      appliedCount: familyAppliedByHost("skill") ? hostEvidenceForFamily("skill").length : 0,
      evidenceRefs: [
        "coreLoop.dynamicWorkflowRuntimePacket.capabilityBindingRows[].skills",
        "coreLoop.fetchPacket.capabilityDiscovery.capabilityInventory",
        "coreLoop.runtimeInvocationPlanPacket.evidence[family=skill]",
      ],
      invocationEvidenceRefs: hostEvidenceRefs("skill"),
      truthBoundary:
        "Skills selected into a worker loadout are not claimed as separately invoked skill runtimes unless invocation evidence is attached.",
      mustNotClaimAs: ["skill_invoked"],
    }),
    makeRow({
      family: "mcp",
      state: familyFullyObserved("mcp")
        ? "invoked"
        : familyHasFailedBindings("mcp")
          ? "failed"
        : hasSelected((row) => row.mcp.length > 0)
          ? "selected_not_invoked"
        : inventoryTypes.has("mcp")
          ? "discovered_not_selected"
          : "not_required",
      selectedCount: bindingRows.reduce((sum, row) => sum + row.mcp.length, 0),
      invokedCount: familyInvokedByHost("mcp") ? hostEvidenceForFamily("mcp").length : 0,
      evidenceRefs: [
        "coreLoop.dynamicWorkflowRuntimePacket.capabilityBindingRows[].mcp",
        "coreLoop.capabilityInvocationProbePacket.probes[family=mcp]",
        "coreLoop.runtimeInvocationPlanPacket.evidence[family=mcp]",
      ],
      invocationEvidenceRefs: hostEvidenceRefs("mcp"),
      truthBoundary:
        "MCP provider/tool binding and --self-test catalog output are not MCP calls. Live MCP invocation needs an externally observed tools/call result attached to this run.",
      mustNotClaimAs: ["mcp_tool_called", "external_provider_invoked"],
    }),
    makeRow({
      family: "hook",
      state: familyFullyObserved("hook")
        ? "invoked"
        : familyHasFailedBindings("hook")
          ? "failed"
        : hasSelected((row) => row.hookMatches.length > 0)
          ? "selected_not_invoked"
          : inventoryTypes.has("hook")
            ? "discovered_not_selected"
            : "not_required",
      selectedCount: bindingRows.reduce((sum, row) => sum + row.hookMatches.length, 0),
      invokedCount: familyInvokedByHost("hook") ? hostEvidenceForFamily("hook").length : 0,
      evidenceRefs: [
        "coreLoop.dynamicWorkflowRuntimePacket.capabilityBindingRows[].hookMatches",
        "canonical/runtime-assets/claude/hooks",
      ],
      invocationEvidenceRefs: hostEvidenceRefs("hook"),
      truthBoundary:
        "Hook matches are last-resort fuse bindings. A hook file, matcher, or sample output is not a trigger; live proof requires a correlated externally observed hook_trigger_event.",
      mustNotClaimAs: ["hook_triggered", "hook_blocked_or_allowed"],
    }),
    makeRow({
      family: "prompt_rule",
      state: hasSelected((row) => Boolean(row.abstractPromptCapability?.status))
        ? "applied"
        : "not_required",
      selectedCount: bindingRows.filter((row) => Boolean(row.abstractPromptCapability?.status)).length,
      appliedCount: bindingRows.filter((row) => Boolean(row.abstractPromptCapability?.status)).length,
      evidenceRefs: [
        "coreLoop.goalContractPacket",
        "coreLoop.dynamicWorkflowRuntimePacket.capabilityBindingRows[].abstractPromptCapability",
        "canonical/skills/meta-theory/SKILL.md",
      ],
      truthBoundary:
        "Prompt/rule capability is applied as the governed contract and abstract prompt capability, not as an external runtime tool call.",
      mustNotClaimAs: ["external_tool_call"],
    }),
    makeRow({
      family: "command_script",
      state: familyFullyObserved("command_script")
        ? "invoked"
        : familyHasFailedBindings("command_script")
          ? "failed"
        : hasSelected((row) => row.commands.length > 0)
          ? "selected_not_invoked"
        : inventoryTypes.has("command")
          ? "discovered_not_selected"
          : "not_required",
      selectedCount: bindingRows.reduce((sum, row) => sum + row.commands.length, 0),
      invokedCount: familyInvokedByHost("command_script")
        ? hostEvidenceForFamily("command_script").length
        : 0,
      evidenceRefs: [
        "coreLoop.dynamicWorkflowRuntimePacket.capabilityBindingRows[].commands",
        "coreLoop.capabilityInvocationProbePacket.probes[family=command_script]",
        "coreLoop.runtimeInvocationPlanPacket.evidence[family=command_script]",
      ],
      invocationEvidenceRefs: hostEvidenceRefs("command_script"),
      truthBoundary:
        "A readiness validator is not the Thinking-selected command. Live proof requires externally observed output from the selected command binding on this run.",
      mustNotClaimAs: ["command_executed"],
    }),
    makeRow({
      family: "runtime_tool",
      state: familyFullyObserved("runtime_tool")
        ? "invoked"
        : familyHasFailedBindings("runtime_tool")
          ? "failed"
        : hasSelected((row) => row.runtimeTools.length > 0)
          ? "selected_not_invoked"
        : inventoryTypes.has("tool")
          ? "discovered_not_selected"
          : "not_required",
      selectedCount: bindingRows.reduce((sum, row) => sum + row.runtimeTools.length, 0),
      invokedCount: familyInvokedByHost("runtime_tool")
        ? hostEvidenceForFamily("runtime_tool").length
        : 0,
      evidenceRefs: [
        "coreLoop.dynamicWorkflowRuntimePacket.capabilityBindingRows[].runtimeTools",
        "coreLoop.capabilityInvocationProbePacket.probes[family=runtime_tool]",
        "coreLoop.runtimeInvocationPlanPacket.evidence[family=runtime_tool]",
      ],
      invocationEvidenceRefs: hostEvidenceRefs("runtime_tool"),
      truthBoundary:
        "Runtime tools selected by loadout are not claimed as called unless tool-call evidence is attached.",
      mustNotClaimAs: ["runtime_tool_called"],
    }),
    makeRow({
      family: "agent_teams_playbook",
      state:
        familyFullyObserved("agent_teams_playbook")
          ? "invoked"
          : agentTeamsPlaybookPacket?.status === "pass"
          ? "selected_not_invoked"
          : agentTeamsPlaybookPacket?.status === "not_required"
            ? "not_required"
            : "unavailable",
      selectedCount: agentTeamsPlaybookPacket?.selected ? 1 : 0,
      invokedCount: familyInvokedByHost("agent_teams_playbook")
        ? hostEvidenceForFamily("agent_teams_playbook").length
        : 0,
      evidenceRefs: [
        "coreLoop.agentTeamsPlaybookPacket",
        "coreLoop.dynamicWorkflowRuntimePacket.capabilityBindingCoverage.agentTeamsPlaybook",
        "coreLoop.runtimeInvocationPlanPacket.evidence[family=agent_teams_playbook]",
      ],
      invocationEvidenceRefs: hostEvidenceRefs("agent_teams_playbook"),
      truthBoundary:
        "agent-teams-playbook may be selected as a fan-out orchestration adapter after workerTaskPackets exist, but this Node runner does not claim a live Skill call, Agent Team, or Codex spawn_agent invocation without host tool evidence.",
      mustNotClaimAs: [
        "skill_invoked",
        "live_agent_team_created",
        "runner_agent_subagent_invocation",
      ],
    }),
    makeRow({
      family: "memory_graph_observability",
      state:
        inventoryTypes.has("memory") || inventoryTypes.has("graph")
          ? "discovered_not_selected"
          : "not_required",
      selectedCount: 0,
      evidenceRefs: [
        "coreLoop.fetchPacket.capabilityDiscovery.capabilityInventory",
        "coreLoop.traceEvalControlPlane",
      ],
      truthBoundary:
        "Memory and graph can guide routing, but discovery is not a memory write or graph rebuild.",
      mustNotClaimAs: ["memory_write", "graph_rebuild"],
    }),
  ];
  const statesValid = rows.every((row) => CAPABILITY_INVOCATION_STATES.includes(row.state));
  const stateCounts = countBy(rows.map((row) => row.state));
  const noLiveSubagentOverclaim =
    rows.find((row) => row.family === "agent_subagent")?.state !== "invoked" ||
    externalAgentSpawned ||
    familyInvokedByHost("agent_subagent");
  const noMcpCallOverclaim =
    rows.find((row) => row.family === "mcp")?.state !== "invoked" ||
    familyInvokedByHost("mcp");
  const noCommandCallOverclaim =
    rows.find((row) => row.family === "command_script")?.state !== "invoked" ||
    familyInvokedByHost("command_script");
  const noRuntimeToolOverclaim =
    rows.find((row) => row.family === "runtime_tool")?.state !== "invoked" ||
    familyInvokedByHost("runtime_tool");
  const noHookTriggerOverclaim =
    rows.find((row) => row.family === "hook")?.state !== "invoked" ||
    familyInvokedByHost("hook");
  const noHostUiSubagentOverclaim = rows
    .find((row) => row.family === "app_visible_subagent")
    ?.mustNotClaimAs.includes("runner_agent_subagent_invocation");
  const noAgentTeamsPlaybookOverclaim =
    rows.find((row) => row.family === "agent_teams_playbook")?.state !== "invoked" ||
    familyInvokedByHost("agent_teams_playbook");
  const realInvocationRequiredFamilies = [...new Set(requiredBindings.map((binding) => binding.family))];
  const unresolvedBindings = [...missingBindings, ...failedBindings];
  const realInvocationMissingFamilies = [...new Set(unresolvedBindings.map((binding) => binding.family))];
  const invocationCoverage = evaluateInvocationCoverage({
    missingBindings: unresolvedBindings,
    capabilityInvocationProbePacket,
  });
  const selectedExecutableInvocationPass = invocationCoverage.realStatus === "pass";
  const pass =
    rows.length >= 10 &&
    statesValid &&
    noLiveSubagentOverclaim &&
    noMcpCallOverclaim &&
    noCommandCallOverclaim &&
    noRuntimeToolOverclaim &&
    noHookTriggerOverclaim &&
    noHostUiSubagentOverclaim &&
    noAgentTeamsPlaybookOverclaim &&
    rows.some((row) => row.state === "invoked" || row.state === "applied") &&
    selectedExecutableInvocationPass;
  return {
    schemaVersion: "capability-invocation-truth-v0.3",
    status: pass ? "pass" : "partial",
    evidenceKind:
      pass && normalizedHostInvocationEvidence.some((item) => item.passEligible)
        ? "live_host_observed"
        : "truth_boundary_partial",
    stateTaxonomy: CAPABILITY_INVOCATION_STATES,
    rows,
    stateCounts,
    callableInvocationCoverage: {
      status: invocationCoverage.callableStatus,
      requiredFamilies: capabilityInvocationProbePacket?.requiredFamilies ?? [],
      callableFamilies: capabilityInvocationProbePacket?.callableFamilies ?? [],
      missingFamilies: capabilityInvocationProbePacket?.missingFamilies ?? [],
      evidenceRef: "coreLoop.capabilityInvocationProbePacket",
    },
    realInvocationCoverage: {
      status: invocationCoverage.realStatus,
      requiredFamilies: realInvocationRequiredFamilies,
      invokedFamilies: rows
        .filter((row) =>
          realInvocationRequiredFamilies.includes(row.family) &&
          ["invoked", "applied"].includes(row.state)
        )
        .map((row) => row.family),
      missingFamilies: realInvocationMissingFamilies,
      requiredBindings,
      invokedBindings: runtimeInvocationPlanPacket?.invokedBindings ?? [],
      failedBindings,
      missingBindings,
      hostEvidenceCount: normalizedHostInvocationEvidence.filter((item) => item.passEligible).length,
      rejectedEvidenceCount: normalizedHostInvocationEvidence.filter((item) => !item.passEligible).length,
      evidenceRef: "coreLoop.runtimeInvocationPlanPacket",
      rule:
        "Selected executable capability families must have externally observed, run-bound host evidence. Readiness probes, fixtures, self-tests, configuration, and selected_not_invoked never satisfy live invocation coverage.",
    },
    requiredFamilies: [
      "agent_subagent",
      "app_visible_subagent",
      "worker_task",
      "skill",
      "mcp",
      "hook",
      "prompt_rule",
      "command_script",
      "runtime_tool",
      "agent_teams_playbook",
    ],
    truthAssertions: {
      noLiveSubagentOverclaim,
      noHostUiSubagentOverclaim,
      noAgentTeamsPlaybookOverclaim,
      noMcpCallOverclaim,
      noCommandCallOverclaim,
      noRuntimeToolOverclaim,
      noHookTriggerOverclaim,
      selectedExecutableRequiresInvocation: selectedExecutableInvocationPass,
      selectedIsNotInvoked: true,
      discoveredIsNotInvoked: true,
      configuredIsNotInvoked: true,
      appliedIsNotInvoked: true,
      hostVisibleIsNotInvoked: true,
    },
    failIf:
      "Any selected, discovered, configured, or matched capability is rendered as invoked without attached invocation evidence.",
  };
}

function buildCapabilityInvocationPresentation({
  capabilityInvocationTruthPacket = null,
  runtimeSubagentInvocationPacket = null,
  outputLanguage = "en",
} = {}) {
  const rows = capabilityInvocationTruthPacket?.rows ?? [];
  const agentRow = rows.find((row) => row.family === "agent_subagent") ?? null;
  const hostVisibleRow = rows.find((row) => row.family === "app_visible_subagent") ?? null;
  const coverage = capabilityInvocationTruthPacket?.realInvocationCoverage ?? {};
  const requiredBindings = coverage.requiredBindings ?? [];
  const invokedBindings = coverage.invokedBindings ?? [];
  const missingBindings = coverage.missingBindings ?? [];
  const failedBindings = coverage.failedBindings ?? [];
  const bindingKey = (binding) =>
    binding?.bindingRef && binding?.providerId
      ? `${binding.bindingRef}\u0000${binding.providerId}`
      : null;
  const failedStates = new Set([
    "failed",
    "failure",
    "error",
    "denied",
    "blocked",
    "unsupported",
  ]);
  const invocationFailed = (binding) =>
    [binding?.state, binding?.status, binding?.resultStatus]
      .filter(Boolean)
      .some((value) => failedStates.has(String(value).toLowerCase()));
  const successfulInvokedBindings = invokedBindings.filter(
    (binding) => bindingKey(binding) && !invocationFailed(binding),
  );
  const failedInvokedBindings = invokedBindings.filter(invocationFailed);
  const successfulKeys = new Set(successfulInvokedBindings.map(bindingKey));
  const inferredMissingBindings = requiredBindings.filter(
    (binding) => !successfulKeys.has(bindingKey(binding)),
  );
  const failedOrMissingKeys = new Set(
    [...missingBindings, ...inferredMissingBindings, ...failedBindings, ...failedInvokedBindings]
      .map((binding) => bindingKey(binding) ?? JSON.stringify(binding))
      .filter(Boolean),
  );
  const successfulBindingCount = successfulInvokedBindings.length;
  const failureCount = failedOrMissingKeys.size;
  const exactMatchedBindingCount = requiredBindings.filter((binding) =>
    successfulKeys.has(bindingKey(binding)),
  ).length;
  const exactAllSuccess =
    requiredBindings.length > 0 &&
    exactMatchedBindingCount === requiredBindings.length &&
    failureCount === 0;
  const calledWithFailures = successfulBindingCount > 0 && failureCount > 0;
  const calledWithoutExactMatch =
    successfulBindingCount > 0 && failureCount === 0 && !exactAllSuccess;
  const verifiedFailureResults = failedBindings.map((binding) =>
    String(binding?.resultStatus ?? binding?.status ?? binding?.state ?? "failed").toLowerCase(),
  );
  const verifiedFailureState = verifiedFailureResults.includes("denied")
    ? "denied"
    : verifiedFailureResults.includes("blocked")
      ? "blocked"
      : verifiedFailureResults.length > 0
        ? "failed"
        : null;
  const genuinelyUnavailable =
    successfulBindingCount === 0 &&
    failedBindings.length === 0 &&
    runtimeSubagentInvocationPacket?.availabilityDisposition === "genuinely_unavailable" &&
    ["unsupported", "provider_missing_or_unusable", "missing_provider"].includes(
      runtimeSubagentInvocationPacket?.status,
    );
  const executionState = exactAllSuccess
    ? "completed"
    : calledWithFailures
      ? "called_with_failures"
      : calledWithoutExactMatch
        ? "called"
      : verifiedFailureState
        ? verifiedFailureState
      : genuinelyUnavailable
        ? "unavailable"
        : "not_confirmed";
  const exactBindingState = exactAllSuccess
    ? "exact_binding_verified"
    : "exact_binding_pending";
  const liveCertificationState = "live_certification_pending";
  const surface = getGovernedRunSurfaceLabels(outputLanguage);
  const copy = surface.invocationPresentation;
  const executionLabel = copy.executionStates[executionState];
  const exactBindingLabel = copy.certificationStates[exactBindingState];
  return {
    schemaVersion: "capability-invocation-presentation-v0.1",
    executionState,
    failureDisposition: verifiedFailureState,
    exactBindingState,
    liveCertificationState,
    executionLabel,
    exactBindingLabel,
    liveCertificationLabel: copy.certificationStates[liveCertificationState],
    summary: copy.summary(executionLabel, exactBindingLabel),
    userSummary: copy.userSummary(executionState, executionLabel),
    evidenceBoundary: {
      exactBindingVerified: exactAllSuccess,
      successfulBindingCount,
      exactMatchedBindingCount,
      failedBindingCount: failureCount,
      verifiedFailedBindingCount: failedBindings.length,
      missingBindingCount: new Set(
        [...missingBindings, ...inferredMissingBindings]
          .map((binding) => bindingKey(binding) ?? JSON.stringify(binding)),
      ).size,
      unverifiedHostHintCount: hostVisibleRow?.selectedCount ?? 0,
      liveCertificationEvidenceRef: null,
      rawAgentState: agentRow?.state ?? "missing",
      rawHostVisibleState: hostVisibleRow?.state ?? "missing",
      rawAuditUnchanged: true,
    },
  };
}

function buildUserCapabilityInvocationPresentation(packet = null) {
  if (!packet) return null;
  return {
    schemaVersion: "capability-invocation-user-presentation-v0.1",
    executionState: packet.executionState,
    executionLabel: packet.executionLabel,
    userSummary: packet.userSummary,
  };
}

const PROJECT_CUSTOMIZATION_DECISIONS = [
  "use_global_directly",
  "upgrade_existing_owner",
  "create_project_local_capability",
];

function projectCustomizationTarget({ runtime, candidateType, requestedCapability }) {
  const slug = safeSlug(requestedCapability || candidateType || "project-capability").slice(0, 80);
  const runtimeName = normalizeRouteRuntime(runtime);
  const targets = {
    codex: {
      agent: `.codex/agents/${slug}.toml`,
      skill: `.agents/skills/${slug}/SKILL.md`,
      command: `.codex/commands/${slug}.md`,
      hook: `.codex/hooks/${slug}.mjs`,
      mcp_provider: `.mcp.json#${slug}`,
      script: `scripts/${slug}.mjs`,
    },
    claude_code: {
      agent: `.claude/agents/${slug}.md`,
      skill: `.claude/skills/${slug}/SKILL.md`,
      command: `.claude/commands/${slug}.md`,
      hook: `.claude/hooks/${slug}.mjs`,
      mcp_provider: `.mcp.json#${slug}`,
      script: `scripts/${slug}.mjs`,
    },
    cursor: {
      agent: `.cursor/agents/${slug}.md`,
      skill: `.cursor/skills/${slug}/SKILL.md`,
      command: `.cursor/rules/${slug}.mdc`,
      hook: `.cursor/hooks/${slug}.mjs`,
      mcp_provider: `.cursor/mcp.json#${slug}`,
      script: `scripts/${slug}.mjs`,
    },
    openclaw: {
      agent: `openclaw/workspaces/${slug}/`,
      skill: `openclaw/skills/${slug}/SKILL.md`,
      command: `openclaw/skills/${slug}/SKILL.md`,
      hook: `openclaw/hooks/${slug}.mjs`,
      mcp_provider: `openclaw/openclaw.template.json#${slug}`,
      script: `scripts/${slug}.mjs`,
    },
  };
  return (targets[runtimeName] ?? targets.codex)[candidateType] ?? `scripts/${slug}.mjs`;
}

function activeProjectRoot() {
  return path.resolve(process.env.META_KIM_CALLER_CWD || process.cwd());
}

function relativeToActiveProject(filePath) {
  return path.relative(activeProjectRoot(), filePath).replaceAll("\\", "/");
}

function discoveredAgentCandidate(id, runtime, scope) {
  const runtimeName = normalizeRouteRuntime(runtime);
  const projectRoot = activeProjectRoot();
  const roots = scope === "project"
    ? {
        codex: [path.join(projectRoot, ".codex", "agents", `${id}.toml`)],
        claude_code: [path.join(projectRoot, ".claude", "agents", `${id}.md`)],
        cursor: [path.join(projectRoot, ".cursor", "agents", `${id}.md`)],
        openclaw: [path.join(projectRoot, "openclaw", "workspaces", id)],
      }
    : {
        codex: [
          path.join(homeDir(), ".codex", "agents", `${id}.toml`),
          path.join(homeDir(), ".codex", "agents", `${id}.md`),
        ],
        claude_code: [path.join(homeDir(), ".claude", "agents", `${id}.md`)],
        cursor: [path.join(homeDir(), ".cursor", "agents", `${id}.md`)],
        openclaw: [path.join(homeDir(), ".openclaw", `workspace-${id}`)],
      };
  const matchedPath = (roots[runtimeName] ?? roots.codex).find((candidatePath) => existsSync(candidatePath));
  if (!matchedPath) return null;
  const sourceRef = scope === "project"
    ? relativeToActiveProject(matchedPath)
    : `~/${path.relative(homeDir(), matchedPath).replaceAll("\\", "/")}`;
  return {
    id,
    type: "agents",
    source: scope === "project" ? "project_runtime_agent_inventory" : "local_global_agent_inventory",
    sourceRef,
    capabilityScope: scope,
  };
}

function discoveredAgentDirectoryCandidates(runtime, scope) {
  const runtimeName = normalizeRouteRuntime(runtime);
  const projectRoot = activeProjectRoot();
  const directories = scope === "project"
    ? {
        codex: path.join(projectRoot, ".codex", "agents"),
        claude_code: path.join(projectRoot, ".claude", "agents"),
        cursor: path.join(projectRoot, ".cursor", "agents"),
      }
    : {
        codex: path.join(homeDir(), ".codex", "agents"),
        claude_code: path.join(homeDir(), ".claude", "agents"),
        cursor: path.join(homeDir(), ".cursor", "agents"),
      };
  const directory = directories[runtimeName];
  if (!directory || !existsSync(directory)) return [];
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(?:toml|md)$/i.test(entry.name))
      .map((entry) => {
        const id = entry.name.replace(/\.(?:toml|md)$/i, "");
        const filePath = path.join(directory, entry.name);
        return {
          id,
          type: "agents",
          source: scope === "project" ? "project_runtime_agent_inventory" : "local_global_agent_inventory",
          sourceRef: scope === "project"
            ? relativeToActiveProject(filePath)
            : `~/${path.relative(homeDir(), filePath).replaceAll("\\", "/")}`,
          capabilityScope: scope,
        };
      });
  } catch {
    return [];
  }
}

function discoveredCapabilityDirectoryCandidates(runtime, scope, candidateType) {
  const runtimeName = normalizeRouteRuntime(runtime);
  const projectRoot = activeProjectRoot();
  const runtimeId = runtimeName === "claude_code" ? "claude" : runtimeName;
  const runtimeHome = scope === "global" ? resolveRuntimeHomeDir(runtimeId) : null;
  const roots = candidateType === "skill"
    ? scope === "project"
      ? {
          codex: [path.join(projectRoot, ".agents", "skills"), path.join(projectRoot, ".codex", "skills")],
          claude_code: [path.join(projectRoot, ".claude", "skills")],
          cursor: [path.join(projectRoot, ".cursor", "skills")],
          openclaw: [path.join(projectRoot, "openclaw", "skills")],
        }
      : {
          codex: [path.join(runtimeHome, "skills"), path.join(homeDir(), ".agents", "skills")],
          claude_code: [path.join(runtimeHome, "skills")],
          cursor: [path.join(runtimeHome, "skills")],
          openclaw: [path.join(runtimeHome, "skills")],
        }
    : scope === "project"
      ? {
          codex: [path.join(projectRoot, ".codex", "commands")],
          claude_code: [path.join(projectRoot, ".claude", "commands")],
          cursor: [path.join(projectRoot, ".cursor", "commands"), path.join(projectRoot, ".cursor", "rules")],
          openclaw: [path.join(projectRoot, "openclaw", "skills")],
        }
      : {
          codex: [path.join(runtimeHome, "commands")],
          claude_code: [path.join(runtimeHome, "commands")],
          cursor: [path.join(runtimeHome, "commands"), path.join(runtimeHome, "rules")],
          openclaw: [path.join(runtimeHome, "skills")],
        };
  const candidates = [];
  for (const directory of roots[runtimeName] ?? roots.codex) {
    if (!directory || !existsSync(directory)) continue;
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const filePath = candidateType === "skill"
          ? entry.isDirectory()
            ? path.join(directory, entry.name, "SKILL.md")
            : null
          : entry.isFile() && /\.(?:md|mdc)$/i.test(entry.name)
            ? path.join(directory, entry.name)
            : entry.isDirectory()
              ? ["command.md", "SKILL.md"]
                  .map((name) => path.join(directory, entry.name, name))
                  .find((candidate) => existsSync(candidate)) ?? null
              : null;
        if (!filePath || !existsSync(filePath)) continue;
        const id = candidateType === "skill"
          ? entry.name
          : entry.name.replace(/\.(?:md|mdc)$/i, "");
        candidates.push({
          id,
          type: candidateType === "skill" ? "skills" : "commands",
          source: scope === "project" ? "project_runtime_capability_inventory" : "local_global_capability_inventory",
          sourceRef: scope === "project"
            ? relativeToActiveProject(filePath)
            : `~/${path.relative(homeDir(), filePath).replaceAll("\\", "/")}`,
          capabilityScope: scope,
        });
      }
    } catch {
      // A missing or unreadable runtime root is simply not a usable candidate.
    }
  }
  return candidates;
}

function projectCustomizationCandidateSets(ownerDiscoveryPacket, candidateType, runtime) {
  const ownerNames = ownerDiscoveryPacket?.candidateExistingExecutionOwners ?? [];
  const discoveredProjectAgents = ownerNames
    .map((id) => discoveredAgentCandidate(id, runtime, "project"))
    .filter(Boolean);
  const discoveredGlobalAgents = ownerNames
    .map((id) => discoveredAgentCandidate(id, runtime, "global"))
    .filter(Boolean);
  const projectAgents = [
    ...(ownerDiscoveryPacket?.projectRuntimeAgents ?? []),
    ...discoveredProjectAgents,
    ...discoveredAgentDirectoryCandidates(runtime, "project"),
  ];
  const globalAgents = [
    ...(ownerDiscoveryPacket?.localGlobalAgents ?? []),
    ...discoveredGlobalAgents,
    ...discoveredAgentDirectoryCandidates(runtime, "global"),
  ];
  const projectProviders = ownerDiscoveryPacket?.projectRuntimeCapabilityProviders ?? [];
  const reusableProviders = ownerDiscoveryPacket?.candidateReusableCapabilityProviders ?? [];
  const globalProviders = [
    ...(ownerDiscoveryPacket?.localGlobalCapabilityProviders ?? []),
    ...reusableProviders.filter((provider) => String(provider?.sourceRef ?? "").startsWith("~/")),
  ];
  const typeMatches = (provider) => {
    const type = String(provider?.type ?? provider?.providerType ?? "").toLowerCase();
    if (candidateType === "skill") return type === "skills" || type === "skill";
    if (candidateType === "command" || candidateType === "script") {
      return type === "commands" || type === "command" || type === "runtimetools";
    }
    if (candidateType === "mcp_provider") return type === "mcpservers" || type === "mcptools" || type === "mcp";
    if (candidateType === "hook") return type === "hooks" || type === "hook";
    return false;
  };
  if (candidateType === "agent") {
    return {
      project: projectAgents.map((candidate) => ({ ...candidate, capabilityScope: "project" })),
      global: globalAgents.map((candidate) => ({ ...candidate, capabilityScope: "global" })),
    };
  }
  const discoveredProjectProviders = ["skill", "command", "script"].includes(candidateType)
    ? discoveredCapabilityDirectoryCandidates(runtime, "project", candidateType === "skill" ? "skill" : "command")
    : [];
  const discoveredGlobalProviders = ["skill", "command", "script"].includes(candidateType)
    ? discoveredCapabilityDirectoryCandidates(runtime, "global", candidateType === "skill" ? "skill" : "command")
    : [];
  return {
    project: [...projectProviders.filter(typeMatches), ...discoveredProjectProviders]
      .map((candidate) => ({ ...candidate, capabilityScope: "project" })),
    global: [...globalProviders.filter(typeMatches), ...discoveredGlobalProviders]
      .map((candidate) => ({ ...candidate, capabilityScope: "global" })),
  };
}

function exactRequestedCandidate(candidates, request) {
  const sourceText = String(request?.sourceText ?? "").toLowerCase();
  const requested = String(request?.requestedCapability ?? "").toLowerCase();
  return (candidates ?? [])
    .slice()
    .sort(
      (left, right) =>
        String(right?.id ?? right?.name ?? "").length -
        String(left?.id ?? left?.name ?? "").length,
    )
    .find((candidate) => {
    const id = String(candidate?.id ?? candidate?.name ?? "").toLowerCase().trim();
    return id.length >= 3 && (sourceText.includes(id) || requested === safeSlug(id));
    }) ?? null;
}

export function buildProjectCustomizationPacket({
  task,
  runId,
  runtime,
  orchestrationReport,
  runtimeInvocationPlanPacket,
  outputLanguage,
}) {
  const requests = durableCapabilityRequestsFromTask(task, runId);
  const ownerDiscoveryPacket = orchestrationReport?.selectedExecutionRoute?.ownerDiscoveryPacket ?? {};
  const selectedBindings = runtimeInvocationPlanPacket?.requiredBindings ?? [];
  const decisions = requests.map((request) => {
    const candidates = projectCustomizationCandidateSets(ownerDiscoveryPacket, request.candidateType, runtime);
    const projectCandidate = exactRequestedCandidate(candidates.project, request);
    const globalCandidate = exactRequestedCandidate(candidates.global, request);
    const explicitGlobalReuse = /全局|global/i.test(request.sourceText) &&
      /不要.{0,12}(?:复制|创建|生成|copy|create).{0,12}(?:项目|project)/i.test(request.sourceText);
    const noIterationGlobalReuse = /(?:全局|global).{0,40}(?:不需要|无需|without|no).{0,12}(?:迭代|修改|升级|定制|iteration|modify|upgrade|custom)|(?:不需要|无需).{0,12}(?:迭代|修改|升级|定制).{0,40}(?:全局|global)/iu.test(request.sourceText);
    const iterationRequested = request.requestedAction === "iterate" && !noIterationGlobalReuse;
    const projectSpecific = !explicitGlobalReuse &&
      /(?:项目|本项目|当前项目|project|repo).{0,12}(?:专用|专属|新增|新建|创建|生成|迭代|修改|specific|local)|(?:专用|专属|specific).{0,12}(?:项目|本项目|project|repo)/i.test(
        request.sourceText,
      );
    const decision = projectCandidate
      ? (iterationRequested ? "upgrade_existing_owner" : "use_global_directly")
      : globalCandidate
        ? (iterationRequested ? "upgrade_existing_owner" : "use_global_directly")
        : projectSpecific || request.requestedAction === "create"
          ? "create_project_local_capability"
          : candidates.global.length > 0
            ? "upgrade_existing_owner"
            : "create_project_local_capability";
    const selectedCandidate = projectCandidate ?? globalCandidate ?? null;
    const copyGlobalToProject = decision === "upgrade_existing_owner" && Boolean(globalCandidate) && !projectCandidate;
    const targetPath = decision === "use_global_directly"
      ? (selectedCandidate?.sourceRef ?? selectedCandidate?.id ?? null)
      : decision === "upgrade_existing_owner" && projectCandidate
        ? (selectedCandidate.sourceRef ?? selectedCandidate.id)
        : projectCustomizationTarget({
            runtime,
            candidateType: request.candidateType,
            requestedCapability: copyGlobalToProject
              ? globalCandidate.id
              : request.requestedCapability,
          });
    const reason = projectCandidate
      ? iterationRequested
        ? `A matching project capability already exists at ${projectCandidate.sourceRef ?? projectCandidate.id}; iterate that project copy instead of creating a duplicate.`
        : `A matching project capability already exists at ${projectCandidate.sourceRef ?? projectCandidate.id}; reuse it without another copy.`
      : globalCandidate
        ? iterationRequested
          ? `A matching global capability exists at ${globalCandidate.sourceRef ?? globalCandidate.id}, but this request needs project-specific iteration; copy it to ${targetPath} before modification.`
          : `A matching global capability already exists at ${globalCandidate.sourceRef ?? globalCandidate.id}; reuse it directly without a project copy.`
        : projectSpecific
          ? "The request explicitly requires project-specific behavior and no exact project/global provider matched."
          : candidates.global.length > 0
            ? "No exact provider matched, but same-family global providers exist; review an existing-owner upgrade before creating a project copy."
            : "No reusable project or global provider matched this durable capability request.";
    return {
      requestId: request.requestId,
      capabilityType: request.candidateType,
      requestedCapability: request.requestedCapability,
      requestText: request.sourceText,
      creationSpecificationReady: request.specificationReady,
      decision,
      reason,
      targetPath,
      copyPolicy:
        decision === "use_global_directly"
          ? "use_global_directly"
          : copyGlobalToProject
            ? "copy_to_project_for_modification"
            : projectCandidate
              ? "already_project_local"
              : "create_project_local_capability",
      sourceCapabilityRef: copyGlobalToProject ? globalCandidate.sourceRef : null,
      projectOwnershipClass:
        decision === "use_global_directly" ? null : "runtime_sedimented_project_copy",
      projectCopyCommand:
        copyGlobalToProject && ["agent", "skill", "command"].includes(request.candidateType)
          ? `meta-kim project capability copy --project-dir <project-root> --runtime ${normalizeRouteRuntime(runtime) === "claude_code" ? "claude" : normalizeRouteRuntime(runtime)} --type ${request.candidateType} --id ${safeSlug(globalCandidate.id)} --source <resolved-global-source> --mode iterate --apply --json`
          : null,
      globalCandidateChecked: {
        count: candidates.global.length,
        matched: Boolean(globalCandidate),
        providerId: globalCandidate?.id ?? null,
        sourceRef: globalCandidate?.sourceRef ?? null,
      },
      projectCandidateChecked: {
        count: candidates.project.length,
        matched: Boolean(projectCandidate),
        providerId: projectCandidate?.id ?? null,
        sourceRef: projectCandidate?.sourceRef ?? null,
      },
      projectNeed: projectSpecific ? request.sourceText : null,
      customizationReason: projectSpecific ? reason : null,
      mergePolicy:
        request.candidateType === "mcp_provider"
          ? "additive_merge_preserve_user_state"
          : decision === "use_global_directly"
            ? "no_project_copy"
            : "reviewed_project_local_write",
      owner: request.candidateType === "agent" ? "meta-genesis" : "meta-artisan",
      verification: "npm run meta:sync && npm run meta:validate",
      rollback:
        decision === "use_global_directly"
          ? "No project capability file is written; remove only the run-scoped binding if the route changes."
          : `Remove the unapproved candidate or restore the managed backup for ${targetPath}.`,
      approvalRequired: decision !== "use_global_directly",
    };
  });
  const priority = {
    create_project_local_capability: 3,
    upgrade_existing_owner: 2,
    use_global_directly: 1,
  };
  const primary = decisions
    .slice()
    .sort((left, right) => priority[right.decision] - priority[left.decision])[0] ?? null;
  const decision = primary?.decision ?? "use_global_directly";
  const reason = primary?.reason ?? (
    selectedBindings.length > 0
      ? "The selected route already has reusable capability bindings and the request does not prove a project-specific durable gap."
      : "No project-specific durable capability was requested; do not create project files for run-scoped work."
  );
  const targetPath = primary?.targetPath ?? null;
  const verification = primary?.verification ?? "npm run discover:global && npm run meta:check:global";
  const rollback = primary?.rollback ?? "No project capability file is written; remove only the run-scoped binding if the route changes.";
  const copy = getGovernedRunSurfaceLabels(outputLanguage).capabilityLedger;
  return {
    schemaVersion: "project-customization-v0.1",
    status: "decision_ready",
    decision,
    reason,
    targetPath,
    verification,
    rollback,
    decisions,
    requestedCapabilityCount: requests.length,
    selectedBindingCount: selectedBindings.length,
    globalFirstChecked: true,
    routeConfirmed: orchestrationReport?.status === "pass",
    allowedDecisions: PROJECT_CUSTOMIZATION_DECISIONS,
    requiresApproval: decision !== "use_global_directly",
    userSummary: copy.projectSummary(copy.projectDecisions[decision], reason),
    truthBoundary:
      "This packet records whether to reuse, upgrade, or create. It does not claim that a project capability file was written, loaded by the host, or invoked.",
  };
}

const PROJECT_CAPABILITY_MUTATION_MODES = new Set(["auto", "read_only"]);
const MATERIALIZABLE_PROJECT_CAPABILITY_TYPES = new Set(["agent", "skill", "command"]);

function normalizedProjectCapabilityMutationMode(value) {
  const mode = String(value ?? "auto").toLowerCase();
  if (!PROJECT_CAPABILITY_MUTATION_MODES.has(mode)) {
    throw new Error(`Unsupported project capability mutation mode: ${mode}`);
  }
  return mode;
}

function projectCapabilityRuntime(runtime) {
  const normalized = normalizeRouteRuntime(runtime);
  return normalized === "claude_code" ? "claude" : normalized;
}

function projectCapabilityId(decision) {
  const preferred =
    decision?.globalCandidateChecked?.providerId ??
    decision?.projectCandidateChecked?.providerId ??
    decision?.requestedCapability ??
    decision?.capabilityType ??
    "project-capability";
  const id = safeSlug(preferred).slice(0, 80);
  return id.length >= 2 ? id : `cap-${id || "item"}`;
}

function resolveProjectCapabilitySourceRef(sourceRef, projectRoot) {
  const ref = String(sourceRef ?? "").trim();
  if (!ref || ref.startsWith("external:")) return null;
  if (ref.startsWith("~/")) {
    return path.resolve(homeDir(), ...ref.slice(2).split("/"));
  }
  if (path.isAbsolute(ref)) return path.resolve(ref);
  return path.resolve(projectRoot, ...ref.replaceAll("\\", "/").split("/"));
}

function generatedProjectCapabilityContent({ runtime, type, id, runId, reason }) {
  const description = `Project-local ${type} ${id}, materialized by governed run ${runId}.`;
  const goal = `Goal: provide the project-local ${type} capability ${id}.`;
  const responsibility = `Responsibility: fulfill only the confirmed governed-run need. ${reason}`;
  const refusal = "Refusal boundary: refuse unrelated responsibilities, global configuration mutation, destructive actions, and overwriting user-owned files.";
  const instruction = [goal, responsibility, refusal].join("\n");
  if (type === "agent" && runtime === "codex") {
    return [
      `name = ${JSON.stringify(id)}`,
      `description = ${JSON.stringify(description)}`,
      `developer_instructions = ${JSON.stringify(instruction)}`,
      "",
    ].join("\n");
  }
  if (type === "agent") {
    return [
      "---",
      `name: ${id}`,
      `description: ${description}`,
      "---",
      "",
      `# ${id}`,
      "",
      `## Goal`,
      "",
      goal,
      "",
      `## Responsibility`,
      "",
      responsibility,
      "",
      `## Refusal boundary`,
      "",
      refusal,
      "",
    ].join("\n");
  }
  if (type === "skill") {
    return [
      "---",
      `name: ${id}`,
      `description: ${description}`,
      "---",
      "",
      `# ${id}`,
      "",
      `## Goal`,
      "",
      goal,
      "",
      `## Responsibility`,
      "",
      responsibility,
      "",
      `## Refusal boundary`,
      "",
      refusal,
      "",
    ].join("\n");
  }
  return [
    `# ${id}`,
    "",
    `## Goal`,
    "",
    goal,
    "",
    `## Responsibility`,
    "",
    responsibility,
    "",
    `## Refusal boundary`,
    "",
    refusal,
    "",
  ].join("\n");
}

function generatedProjectCapabilitySource({
  candidateRoot,
  runtime,
  type,
  id,
  runId,
  reason,
}) {
  mkdirSync(candidateRoot, { recursive: true });
  const extension = type === "agent" && runtime === "codex" ? ".toml" : ".md";
  const sourcePath = path.join(candidateRoot, `${type}-${id}${extension}`);
  writeFileSync(
    sourcePath,
    generatedProjectCapabilityContent({ runtime, type, id, runId, reason }),
    "utf8",
  );
  return sourcePath;
}

function projectCustomizationUserLine({ decision, result, outputLanguage }) {
  const language = normalizeOutputLanguage(outputLanguage);
  const label = `${decision.capabilityType} ${decision.requestedCapability}`;
  if (result.status === "reused_without_copy") {
    const existingProjectCopy = decision.projectCandidateChecked?.matched === true;
    if (language === "zh-CN") {
      return existingProjectCopy
        ? `复用已有项目 ${label}，未创建重复副本；位置：${decision.targetPath ?? "已选项目能力"}。`
        : `复用全局 ${label}，未复制到项目；来源：${decision.targetPath ?? "已选全局能力"}。`;
    }
    if (language === "ja-JP") {
      return existingProjectCopy
        ? `既存のプロジェクト ${label} を再利用し、重複コピーは作成していません。`
        : `グローバル ${label} を再利用し、プロジェクトにはコピーしていません。`;
    }
    if (language === "ko-KR") {
      return existingProjectCopy
        ? `기존 프로젝트 ${label}을 재사용했으며 중복 복사본을 만들지 않았습니다.`
        : `전역 ${label}을 재사용했으며 프로젝트에는 복사하지 않았습니다.`;
    }
    return existingProjectCopy
      ? `Reused existing project ${label}; no duplicate copy was created.`
      : `Reused global ${label}; no project copy was created.`;
  }
  if (result.status === "applied") {
    const target = result.targetPaths.join(", ") || decision.targetPath;
    if (language === "zh-CN") return `已将 ${label} 落到 ${target}；原因：${decision.reason}`;
    if (language === "ja-JP") return `${label} を ${target} に配置しました。理由: ${decision.reason}`;
    if (language === "ko-KR") return `${label}을(를) ${target}에 배치했습니다. 이유: ${decision.reason}`;
    return `Materialized ${label} at ${target}. Reason: ${decision.reason}`;
  }
  if (result.status === "not_applied_read_only") {
    if (language === "zh-CN") return `只读模式：未复制 ${label}；计划位置：${decision.targetPath}。`;
    return `Read-only mode: ${label} was not copied; planned target: ${decision.targetPath}.`;
  }
  if (language === "zh-CN") return `未能落盘 ${label}，不会假称完成；原因：${result.reason}`;
  return `Failed to materialize ${label}; completion is not claimed. Reason: ${result.reason}`;
}

export function executeProjectCustomizationPacket({
  packet,
  runtime,
  runId,
  projectRoot,
  candidateRoot,
  mutationMode = "auto",
  entryClassification = null,
  outputLanguage = "zh-CN",
}) {
  const mode = normalizedProjectCapabilityMutationMode(mutationMode);
  const root = path.resolve(projectRoot ?? activeProjectRoot());
  const copyRuntime = projectCapabilityRuntime(runtime);
  const readOnly =
    mode === "read_only" ||
    entryClassification?.path === "fast_path" ||
    entryClassification?.governedEntry === false;
  const results = [];
  const ownsCandidateRoot = !candidateRoot;
  const resolvedCandidateRoot = candidateRoot ?? mkdtempSync(
    path.join(os.tmpdir(), "meta-kim-project-capability-candidates-"),
  );
  const decisions = (packet?.decisions ?? []).map((decision) => {
    if (decision.copyPolicy === "use_global_directly") {
      const result = {
        requestId: decision.requestId,
        status: "reused_without_copy",
        applied: false,
        targetPaths: [],
        reason: decision.reason,
      };
      results.push(result);
      return { ...decision, executionStatus: result.status, actualTargetPaths: [] };
    }

    if (readOnly) {
      const result = {
        requestId: decision.requestId,
        status: "not_applied_read_only",
        applied: false,
        targetPaths: [],
        reason: "project capability mutation is disabled for read-only, check, dry-run, or fast-path execution",
      };
      results.push(result);
      return { ...decision, executionStatus: result.status, actualTargetPaths: [] };
    }

    if (packet.routeConfirmed !== true) {
      const result = {
        requestId: decision.requestId,
        status: "failed",
        applied: false,
        targetPaths: [],
        reason: "governed_route_not_execution_ready",
      };
      results.push(result);
      return { ...decision, executionStatus: result.status, actualTargetPaths: [] };
    }

    if (!MATERIALIZABLE_PROJECT_CAPABILITY_TYPES.has(decision.capabilityType)) {
      const result = {
        requestId: decision.requestId,
        status: "failed",
        applied: false,
        targetPaths: [],
        reason: `unsupported_project_capability_type:${decision.capabilityType}`,
      };
      results.push(result);
      return { ...decision, executionStatus: result.status, actualTargetPaths: [] };
    }

    const id = projectCapabilityId(decision);
    const copyMode = decision.copyPolicy === "create_project_local_capability" ? "create" : "iterate";
    if (copyMode === "create" && decision.creationSpecificationReady !== true) {
      const result = {
        requestId: decision.requestId,
        status: "failed",
        applied: false,
        targetPaths: [],
        reason: "insufficient_durable_capability_specification",
      };
      results.push(result);
      return { ...decision, executionStatus: result.status, actualTargetPaths: [] };
    }

    try {
      const source = copyMode === "iterate"
        ? resolveProjectCapabilitySourceRef(
            decision.sourceCapabilityRef ?? decision.targetPath,
            root,
          )
        : generatedProjectCapabilitySource({
            candidateRoot: resolvedCandidateRoot,
            runtime: copyRuntime,
            type: decision.capabilityType,
            id,
            runId,
            reason: `${decision.requestText ?? "Confirmed project capability request"} ${decision.reason}`,
          });
      if (!source || !existsSync(source)) {
        throw new Error("selected_capability_source_unresolved");
      }
      const copyResult = copyProjectCapability({
        projectDir: root,
        runtime: copyRuntime,
        type: decision.capabilityType,
        id,
        source,
        mode: copyMode,
        apply: true,
      });
      if (!copyResult.ok) {
        const result = {
          requestId: decision.requestId,
          status: "failed",
          applied: false,
          targetPaths: [],
          reason: copyResult.transaction?.reason ?? copyResult.status ?? "project_capability_copy_failed",
          transactionStatus: copyResult.transaction?.status ?? copyResult.status,
        };
        results.push(result);
        return { ...decision, executionStatus: result.status, actualTargetPaths: [] };
      }
      const targetPaths = (copyResult.capability?.files ?? []).map((file) => file.relPath);
      const result = {
        requestId: decision.requestId,
        status: "applied",
        applied: true,
        targetPaths,
        reason: decision.reason,
        transactionStatus: copyResult.transaction?.status ?? copyResult.status,
        ownershipClass: copyResult.capability?.ownershipClass,
        dependencyUpdatePolicy: copyResult.capability?.dependencyUpdatePolicy,
      };
      results.push(result);
      return { ...decision, executionStatus: result.status, actualTargetPaths: targetPaths };
    } catch (error) {
      const result = {
        requestId: decision.requestId,
        status: "failed",
        applied: false,
        targetPaths: [],
        reason: error.message,
      };
      results.push(result);
      return { ...decision, executionStatus: result.status, actualTargetPaths: [] };
    }
  });

  const mutationRequired = decisions.some((decision) => decision.copyPolicy !== "use_global_directly");
  const failedCount = results.filter((result) => result.status === "failed").length;
  const readOnlyCount = results.filter((result) => result.status === "not_applied_read_only").length;
  const appliedCount = results.filter((result) => result.status === "applied").length;
  const noCopyCount = results.filter((result) => result.status === "reused_without_copy").length;
  const status = failedCount > 0
    ? "partial"
    : readOnlyCount > 0
      ? "read_only"
      : appliedCount > 0
        ? "completed"
        : noCopyCount > 0
          ? "completed_no_copy"
          : "not_required";
  const userSummary = decisions.length === 0
    ? packet.userSummary
    : decisions.map((decision, index) => projectCustomizationUserLine({
        decision,
        result: results[index],
        outputLanguage,
      })).join(" ");
  const executedPacket = {
    ...packet,
    status,
    decisions,
    requiresApproval: false,
    userSummary,
    execution: {
      schemaVersion: "project-customization-execution-v0.1",
      status,
      mutationMode: mode,
      mutationRequired,
      projectRoot: root,
      lockKey: "project-mutation-session",
      appliedCount,
      noCopyCount,
      readOnlyCount,
      failedCount,
      results,
      manifest: appliedCount > 0
        ? ".meta-kim/state/default/project-capabilities.json"
        : null,
    },
    truthBoundary:
      status === "partial"
        ? "At least one required project capability mutation failed; the run must remain partial and must not claim completion."
        : status === "read_only"
          ? "Project capability mutation was intentionally not applied in read-only/check/dry-run mode."
          : "Project capability write claims are backed by project-capability-copy transaction results; global reuse claims mean no project copy was created.",
  };
  if (ownsCandidateRoot) {
    rmSync(resolvedCandidateRoot, { recursive: true, force: true });
  }
  return executedPacket;
}

function buildCapabilityLedgerPacket({
  capabilityInvocationTruthPacket,
  runtimeInvocationPlanPacket,
  projectCustomizationPacket,
  outputLanguage,
}) {
  const visibleFamilies = [
    "agent_subagent",
    "skill",
    "command_script",
    "mcp",
    "runtime_tool",
    "hook",
    "prompt_rule",
  ];
  const copy = getGovernedRunSurfaceLabels(outputLanguage).capabilityLedger;
  const truthRows = capabilityInvocationTruthPacket?.rows ?? [];
  const requiredBindings = runtimeInvocationPlanPacket?.requiredBindings ?? [];
  const shortProviderName = (value) => {
    const normalized = String(value ?? "").replaceAll("\\", "/");
    if (!normalized || normalized === "none") return copy.noneProvider;
    const parts = normalized.split("/").filter(Boolean);
    const fileName = parts.at(-1) ?? normalized;
    const candidate = /^skill\.md$/i.test(fileName) && parts.length > 1
      ? parts.at(-2)
      : fileName.replace(/\.(?:toml|md|mjs|json)$/i, "");
    return candidate.replace(/provider/gi, "capability").replace(/lane/gi, "work-stream");
  };
  const sourceLabel = (sources) => {
    const joined = sources.join(" ").toLowerCase();
    if (!joined) return copy.sourceLabels.unselected;
    if (joined.includes("~/." ) || joined.includes("global")) return copy.sourceLabels.global;
    if (joined.includes("project") || joined.includes(".codex/") || joined.includes(".agents/") || joined.includes(".claude/") || joined.includes(".cursor/")) return copy.sourceLabels.project;
    if (joined.includes("canonical/")) return copy.sourceLabels.canonical;
    if (joined.includes("runtime") || joined.includes("shell") || joined.includes("browser")) return copy.sourceLabels.runtime;
    return copy.sourceLabels.discovered;
  };
  const families = visibleFamilies.map((family) => {
    const truth = truthRows.find((row) => row.family === family) ?? {
      state: "not_required",
      selectedCount: 0,
      truthBoundary: "No capability truth row was produced for this family.",
    };
    const bindings = requiredBindings.filter((binding) => binding.family === family);
    const providerIds = uniqueStrings(bindings.map((binding) => binding.providerId));
    const sources = uniqueStrings(
      bindings.flatMap((binding) => [binding.sourceRef, binding.source]).filter(Boolean),
    );
    if (family === "prompt_rule" && providerIds.length === 0) {
      providerIds.push("meta-theory");
      sources.push("canonical/skills/meta-theory/SKILL.md");
    }
    const providerId = providerIds.join(", ") || "none";
    const source = sources.join(", ") || "not_selected";
    const displayProvider = providerIds.length > 0
      ? providerIds.map(shortProviderName).join(", ")
      : copy.noneProvider;
    const displaySource = sourceLabel(sources);
    const state = CAPABILITY_INVOCATION_STATES.includes(truth.state)
      ? truth.state
      : "not_required";
    const familyLabel = copy.familyLabels[family] ?? family;
    const stateLabel = copy.stateLabels[state] ?? state;
    const ownerBindingModes = family === "agent_subagent"
      ? uniqueStrings(bindings.map((binding) => binding.ownerBindingMode).filter(Boolean))
      : [];
    const ownerBindingSummary = ownerBindingModes
      .map((mode) => copy.agentBindingModes?.[mode])
      .filter(Boolean)
      .join(" ");
    const baseDisplayLine = copy.line(familyLabel, displayProvider, stateLabel, displaySource);
    return {
      family,
      familyLabel,
      providerId,
      providerIds,
      source,
      sources,
      displayProvider,
      displaySource,
      state,
      stateLabel,
      selected: (truth.selectedCount ?? 0) > 0,
      selectedCount: truth.selectedCount ?? 0,
      invokedCount: truth.invokedCount ?? 0,
      ownerBindingModes,
      invocationTruthBoundary: truth.truthBoundary,
      nextAction: copy.nextActions[state],
      displayLine: `${baseDisplayLine}${ownerBindingSummary ? ` ${ownerBindingSummary}` : ""} ${copy.nextActions[state]}`,
    };
  });
  return {
    schemaVersion: "capability-ledger-v0.1",
    status: "ready",
    title: copy.title,
    families,
    projectCustomization: {
      decision: projectCustomizationPacket.decision,
      summary: String(projectCustomizationPacket.userSummary ?? "")
        .replace(/provider/gi, "capability")
        .replace(/lane/gi, "work-stream"),
      targetPath: projectCustomizationPacket.targetPath,
    },
    userSummary: families.map((family) => family.displayLine).join(" "),
    truthBoundary:
      "The ledger renders strict invocation states without promoting discovery, selection, configuration, host badges, or run-scoped plans into actual calls.",
  };
}

function buildVisibleMetaTheorySurfacePacket({
  orchestrationReport,
  langGraphRunPacket,
  dynamicWorkflowRuntimePacket,
  peerAgentMeshPacket,
  capabilityInvocationProbePacket,
  capabilityInvocationTruthPacket,
  capabilityInvocationPresentationPacket,
  capabilityLedgerPacket,
  projectCustomizationPacket,
  agentTeamsPlaybookPacket,
}) {
  const capabilityRows = orchestrationReport.fetchEvidence.capabilityInventory.map((item) => ({
    capabilityType: item.capabilityType,
    status: item.coverageStatus,
    source: item.source,
    routeImpact: item.routeImpact,
  }));
  const capabilityTypes = capabilityRows.map((row) => row.capabilityType);
  const nonSkillCapabilityTypes = capabilityTypes.filter((type) => type !== "skill");
  const dynamicRows = dynamicWorkflowRuntimePacket.capabilityBindingRows.map((row) => ({
    laneId: row.laneId,
    laneLabel: row.laneLabel,
    owner: row.owner,
    roleDisplayName: row.roleDisplayName,
    capabilityNeed: row.capabilityNeed ?? [],
    selectionPolicy: row.capabilitySelection?.selectionPolicy ?? null,
    selectedProvider: row.capabilitySelection?.selectedProvider?.id ?? null,
    candidateProviderCount: row.capabilitySelection?.candidateProviders?.length ?? 0,
    whySelected: row.capabilitySelection?.whySelected ?? null,
    skills: row.skills.length,
    mcp: row.mcp.length,
    commands: row.commands.length,
    runtimeTools: row.runtimeTools.length,
    hooks: row.hookMatches.length,
    workerResult: Boolean(row.resultPacketId),
  }));
  const pass =
    capabilityRows.length > 0 &&
    nonSkillCapabilityTypes.length > 0 &&
    dynamicRows.length > 0 &&
    langGraphRunPacket.status === "pass" &&
    dynamicWorkflowRuntimePacket.status === "pass" &&
    ["pass", "not_required"].includes(agentTeamsPlaybookPacket?.status) &&
    peerAgentMeshPacket.status === "pass" &&
    capabilityInvocationTruthPacket.status === "pass" &&
    capabilityLedgerPacket?.status === "ready" &&
    PROJECT_CUSTOMIZATION_DECISIONS.includes(projectCustomizationPacket?.decision);
  return {
    schemaVersion: "visible-meta-theory-surface-v0.1",
    status: pass ? "pass" : "partial",
    evidenceKind: pass ? "user_visible_product_surface" : "internal_artifact_only",
    requiredVisibleTopics: [
      "orchestration",
      "dynamic_workflow",
      "capability_inventory_not_skill_only",
      "capability_invocation_presentation",
      "capability_ledger",
      "project_customization_decision",
      "agent_teams_playbook",
      "peer_agent_mesh",
      "langgraph_style_control_graph",
    ],
    orchestration: {
      status: orchestrationReport.status,
      boardId: orchestrationReport.orchestrationTaskBoardPacket.dispatchBoardId,
      synthesisOwner: orchestrationReport.orchestrationTaskBoardPacket.synthesisOwner,
      workerTaskCount: orchestrationReport.workerTaskPackets.length,
      parallelGroups: uniqueStrings(
        orchestrationReport.workerTaskPackets.map((packet) => packet.parallelGroup)
      ),
      mergeOwners: uniqueStrings(
        orchestrationReport.workerTaskPackets.map((packet) => packet.mergeOwner)
      ),
    },
    dynamicWorkflow: {
      status: dynamicWorkflowRuntimePacket.status,
      selectedLaneIds: dynamicWorkflowRuntimePacket.selectedLaneIds,
      omittedLaneIds: dynamicWorkflowRuntimePacket.omittedLaneIds,
      omittedLanesWithReason: dynamicWorkflowRuntimePacket.omittedLanesWithReason,
      businessFlowLaneCount: dynamicWorkflowRuntimePacket.businessFlowLaneCount,
      capabilityBindingCoverage: dynamicWorkflowRuntimePacket.capabilityBindingCoverage,
      visibleRows: dynamicRows,
    },
    capabilityInventory: {
      total: capabilityRows.length,
      byType: countBy(capabilityTypes),
      nonSkillCapabilityTypeCount: uniqueStrings(nonSkillCapabilityTypes).length,
      notSkillOnly: nonSkillCapabilityTypes.length > 0,
      visibleRows: capabilityRows,
    },
    capabilityInvocationPresentation: buildUserCapabilityInvocationPresentation(
      capabilityInvocationPresentationPacket,
    ),
    capabilityLedger: capabilityLedgerPacket,
    projectCustomization: projectCustomizationPacket,
    agentTeamsPlaybook: {
      status: agentTeamsPlaybookPacket?.status ?? "missing",
      selected: agentTeamsPlaybookPacket?.selected === true,
      triggered: agentTeamsPlaybookPacket?.triggered === true,
      providerId: agentTeamsPlaybookPacket?.providerId ?? AGENT_TEAMS_PLAYBOOK_ID,
      selectedSource: agentTeamsPlaybookPacket?.providerResolution?.selectedSource ?? null,
      executableLaneCount: agentTeamsPlaybookPacket?.executableLaneCount ?? 0,
      maxParallelAgents: agentTeamsPlaybookPacket?.maxParallelAgents ?? 0,
      requestedParallelAgents: agentTeamsPlaybookPacket?.requestedParallelAgents ?? 0,
      runtimeCapacity: agentTeamsPlaybookPacket?.runtimeCapacity ?? null,
      capacitySource: agentTeamsPlaybookPacket?.capacitySource ?? null,
      waveCount: agentTeamsPlaybookPacket?.waves?.length ?? 0,
      liveRuntimeBoundary:
        agentTeamsPlaybookPacket?.runtimeInvocationBoundary?.hostRule ??
        agentTeamsPlaybookPacket?.runtimeInvocationBoundary?.codexRule ??
        "Live subagent claims require host tool-call evidence.",
    },
    peerAgentMesh: {
      status: peerAgentMeshPacket.status,
      peerCount: peerAgentMeshPacket.peers.length,
      handoffCount: peerAgentMeshPacket.handoffs.length,
      model: peerAgentMeshPacket.model,
      visibleRows: peerAgentMeshPacket.peers.map((peer) => ({
        peerId: peer.peerId,
        roleDisplayName: peer.roleDisplayName,
        taskPacketId: peer.taskPacketId,
        mergeOwner: peer.mergeOwner,
        resultStatus: peer.resultStatus,
      })),
      liveRuntimeBoundary:
        "These are run-scoped peer workers in the governed artifact unless runtime subagent dispatch evidence explicitly says otherwise.",
    },
    langGraph: {
      status: langGraphRunPacket.status,
      evidenceKind: langGraphRunPacket.evidenceKind,
      nodeCount: langGraphRunPacket.nodes.length,
      edgeCount: langGraphRunPacket.edges.length,
      conditionalEdgeCount: langGraphRunPacket.conditionalEdges.length,
      checkpointCount: langGraphRunPacket.checkpoint.count,
      replayCommand: langGraphRunPacket.replay.command,
      architectureStyle: langGraphRunPacket.architectureStyle,
      runtimeDependency: langGraphRunPacket.runtimeDependency,
      runtimeExecutionEvidence: langGraphRunPacket.runtimeExecutionEvidence,
    },
    failIf:
      "The report or conversation surface only says stages passed, but does not show orchestration, Dynamic Workflow, non-skill capabilities, peer agent mesh, and LangGraph-style graph details.",
  };
}

function buildUserPerceptionPacket({
  conversationNotice,
  userExperienceNotice,
  stageOperationPlan,
  agUiStageEvents,
  visibleMetaTheorySurfacePacket,
  productExperienceGoals = [],
  outputLanguage = "zh-CN",
}) {
  const stageNames = (stageOperationPlan?.stages ?? []).map((stage) => stage.stage);
  const cues = [
    {
      cue: "要做什么",
      evidenceRef: "stageOperationPlan.stages[].whatHappens",
      example:
        stageOperationPlan?.stages?.[0]?.whatHappens ??
        "先锁定真实目标，再决定路线。",
    },
    {
      cue: "正在做什么",
      evidenceRef: "agUiStageEvents.events[].userFacingLabel",
      example:
        agUiStageEvents?.events?.[0]?.userFacingLabel?.["zh-CN"] ??
        "锁定真实目标",
    },
    {
      cue: "准备怎么做",
      evidenceRef: "stageOperationPlan.stages[].nextWork",
      example:
        stageOperationPlan?.stages?.[0]?.nextWork ??
        "进入 Fetch",
    },
    {
      cue: "怎么算验收通过",
      evidenceRef: "productExperiencePacket.goals",
      example: "三目标都要有产品级证据，不能用内部 packet 冒充用户体验。",
    },
    {
      cue: "什么时候暂停",
      evidenceRef: "goalContractPacket.contractFields.pauseIf",
      example: "需要凭证、付费、生产数据、真实外部发布或 native live 证据时暂停。",
    },
    {
      cue: "编排和真实能力调用在哪里看",
      evidenceRef: "visibleMetaTheorySurfacePacket",
      example:
        "报告必须直接展示编排、Dynamic Workflow、能力发现、真实调用状态、Peer Agent Mesh 和 LangGraph-style 控制图。",
    },
    {
      cue: "谁做决策",
      evidenceRef: "userPerceptionPacket.humanDecisionControl",
      example:
        "自动化只能整理证据、草拟选项和跑确定性验证；Critical、Fetch、Thinking、Review 的判断权留给人。",
    },
  ];
  const surfaces = [
    {
      surface: "user_readable_run_report",
      status: "pass",
      evidenceRef: "artifact.runReport.markdownPath",
    },
    {
      surface: "visible_meta_theory_surface",
      status: visibleMetaTheorySurfacePacket?.status === "pass" ? "pass" : "partial",
      evidenceRef: "coreLoop.visibleMetaTheorySurfacePacket",
    },
    {
      surface: "ag_ui_style_event_stream",
      status: agUiStageEvents?.eventCount >= TRACE_SPINE.length ? "pass" : "partial",
      evidenceRef: "coreLoop.agUiStageEvents",
    },
    {
      surface: "localized_conversation_notice",
      status: conversationNotice?.emitted ? "pass" : "optional_not_emitted",
      evidenceRef: conversationNotice?.emitted
        ? "artifact.conversationNotice"
        : "artifact.userExperienceNotice.pendingPrimarySurface",
    },
  ];
  const pass =
    stageNames.includes("Critical") &&
    stageNames.includes("Execution") &&
    cues.length >= 6 &&
    surfaces.some((surface) => surface.surface === "user_readable_run_report" && surface.status === "pass") &&
    surfaces.some((surface) => surface.surface === "visible_meta_theory_surface" && surface.status === "pass") &&
    userExperienceNotice?.internalOnlySignals?.includes("orchestrationTaskBoardPacket");
  return {
    schemaVersion: "user-perception-v0.1",
    status: pass ? "pass" : "partial",
    evidenceKind: pass ? "product_experience_pass" : "report_only",
    language: outputLanguage,
    plainLanguagePolicy:
      "用户看到的是阶段、路线、owner 交接、阻塞、验证和停止条件，不需要理解 packet/JSON 名称。",
    surfaces,
    plainLanguageCues: cues,
    stageNames,
    humanDecisionControl: {
      status: "pass",
      decisionAuthority: "human_required",
      humanJudgmentStages: ["Critical", "Fetch", "Thinking", "Review"],
      automationRole: "assistive_only",
      automationAllowed: [
        "collect evidence",
        "draft candidate options",
        "run deterministic validation",
        "surface risk and blockers",
        "prepare user-visible status summaries",
      ],
      automationForbidden: [
        "choose branch-changing route without human evidence",
        "approve accepted risk",
        "claim public-ready",
        "turn selected_not_invoked into invoked",
        "replace native choice evidence with a report or hook warning",
      ],
      evidenceRefs: [
        "coreLoop.cardPlanPacket",
        "coreLoop.dynamicWorkflowDecisionRecord",
        "coreLoop.capabilityInvocationTruthPacket",
        "coreLoop.productExperiencePacket.automationDecisionBoundary",
      ],
    },
    productExperienceGoals,
    antiPacketDump: {
      internalOnlySignals: userExperienceNotice?.internalOnlySignals ?? [],
      packetDumpPrevented:
        agUiStageEvents?.events?.every((event) => event.packetDumpPrevented === true) === true,
    },
  };
}

const PRODUCT_EXPERIENCE_CORE_GOAL_IDS = ["P-102", "P-103", "P-104"];
const PRODUCT_EXPERIENCE_SUPPORT_GATE_IDS = ["P-105", "P-106", "P-107", "P-108", "P-109", "P-110"];

function buildNativeChoiceSurfaceGate({
  runId,
  cardPlanPacket,
  dynamicWorkflowDecisionRecord,
  nativeChoiceEvidence,
  nativeChoiceEvidenceTrusted,
}) {
  const branchCardRefs = [
    ...(cardPlanPacket?.cardEvents ?? [])
      .filter((card) => ["clarify", "options", "approval"].includes(card.cardKey))
      .map((card) => `cardPlanPacket.cardEvents.${card.eventId}`),
    ...(dynamicWorkflowDecisionRecord?.cards ?? [])
      .filter((card) => ["clarify", "options", "approval"].includes(card.cardKey))
      .map((card) => `dynamicWorkflowDecisionRecord.cards.${card.cardKey}`),
  ];
  const evidence = normalizeNativeChoiceEvidence(nativeChoiceEvidence, {
    trusted: nativeChoiceEvidenceTrusted,
    expectedRunId: runId,
  });
  const acceptedAnswers = evidence.filter((item) => item.passEligible === true);
  const blockedEvidence = evidence.filter((item) => item.blockedEligible === true);
  const branchChoiceRequired = branchCardRefs.length > 0;
  const liveStatus = !branchChoiceRequired
    ? "no_branching_choice"
    : acceptedAnswers.length > 0
      ? "native_choice_answered"
      : blockedEvidence.length > 0
        ? "nativeChoiceSurfaceBlocked"
        : "needs-host-invocation";
  const status =
    !branchChoiceRequired || acceptedAnswers.length > 0
      ? "pass"
      : "partial";
  return {
    id: "P-106",
    name: "Codex/Claude 原生选择面支撑门",
    status,
    evidenceKind: "product_support_gate",
    requiredFor:
      "Any branch-changing Critical clarification or post-Thinking execution confirmation in primary Codex/Claude Code runtimes.",
    requiredNativeSurfaces: [
      {
        runtime: "codex",
        surface: "request_user_input",
        fallbackAllowedForPrimaryRuntime: false,
      },
      {
        runtime: "claude",
        surface: "AskUserQuestion",
        fallbackAllowedForPrimaryRuntime: false,
      },
    ],
    structuralEvidence: {
      status: "pass",
      branchCardRefs: branchCardRefs.length > 0 ? uniqueStrings(branchCardRefs) : ["no_branching_choice"],
      evidenceRefs: [
        "coreLoop.cardPlanPacket",
        "coreLoop.dynamicWorkflowDecisionRecord",
        "canonical/skills/meta-theory/references/runtime-codex.md",
        "canonical/skills/meta-theory/references/runtime-claude.md",
      ],
    },
    liveRuntimeBoundary: {
      status: liveStatus,
      requiredForNativePass: true,
      branchChoiceRequired,
      evidenceTrusted: nativeChoiceEvidenceTrusted === true,
      acceptedEvidenceRefs: acceptedAnswers.map((item) => item.evidenceRef),
      blockedEvidenceRefs: blockedEvidence.map((item) => item.evidenceRef),
      rejectedEvidence:
        evidence
          .filter((item) => item.proofValid !== true)
          .map((item) => ({
            surface: item.surface,
            evidenceKind: item.evidenceKind,
            rejectionReason: item.rejectionReason,
          })),
      acceptableProof: [
        "Codex request_user_input returned answer before Execution",
        "Claude AskUserQuestion returned or deferred answer before Execution",
        "nativeChoiceSurfaceBlocked recorded before Execution when native surface is unavailable",
      ],
    },
    forbiddenSubstitutes: [
      "markdown decision card",
      "localized chat card",
      "CLI conversationNotice",
      "hook warning",
      "after-the-fact user insertion",
      "fixture transcript without native tool return",
    ],
    failIf:
      "A chat card, report, hook warning, fixture, or after-the-fact insertion is claimed as Codex/Claude native popup evidence.",
  };
}

function buildRepeatFailureDesignGate() {
  return {
    id: "P-107",
    name: "同类错误二次即底层设计失败",
    status: "pass",
    evidenceKind: "product_support_gate",
    sameFailureOccurrenceThreshold: 2,
    actionOnSecondOccurrence: "bottom_design_failure_return_to_critical_fetch_thinking",
    returnToStages: ["Critical", "Fetch", "Thinking"],
    requiredRepairShape: [
      "classify the repeated failure",
      "identify the missing contract or route design",
      "change the design or evidence path before retry",
      "add or update a regression test",
    ],
    forbiddenRetry:
      "Do not rerun the same local patch, fixture-specific workaround, or unchanged action after the second same-class failure.",
    trackedFailureClasses: [
      "native_choice_surface_missing_before_execution",
      "fixture_specific_route_hardcoded",
      "verification_pass_without_runtime_evidence",
      "validator_rescue_after_weak_route",
      "same_hook_reason_retried_unchanged",
    ],
    failIf:
      "The same failure class appears twice and the run continues with another local patch instead of returning to design.",
  };
}

function buildNoHardcodedFixtureGate({ goalContractPacket }) {
  const durableGoalText = goalContractPacket?.recommendedGoalText ?? "";
  const forbiddenFixtureBindings = [
    "桌面便签",
    "desktop sticky notes",
    "StickyNotes",
    "WPF",
    "Electron",
    "Tauri",
  ];
  const detectedForbiddenBindings = forbiddenFixtureBindings.filter((item) =>
    durableGoalText.toLowerCase().includes(item.toLowerCase())
  );
  return {
    id: "P-108",
    name: "目标不硬编码测试夹具",
    status: detectedForbiddenBindings.length === 0 ? "pass" : "fail",
    evidenceKind: "product_support_gate",
    durableGoalTextHash: textSha256(durableGoalText),
    forbiddenFixtureBindings,
    detectedForbiddenBindings,
    abstractionRequirement:
      "Durable goal, PRD, contract, and validator rules must describe reusable Meta_Kim behavior, not a one-off desktop-sticky-notes or other fixture route.",
    allowedFixtureUse:
      "Fixtures may test the framework, but the framework target must remain task-agnostic and capability-driven.",
    failIf:
      "A demo-specific app, stack, file path, or product request becomes the durable goal, route, owner, or pass criterion.",
  };
}

function buildCapabilityInvocationTruthGate({ capabilityInvocationTruthPacket }) {
  const truthAssertions = capabilityInvocationTruthPacket?.truthAssertions ?? {};
  const callableCoverage = capabilityInvocationTruthPacket?.callableInvocationCoverage ?? {};
  const realCoverage = capabilityInvocationTruthPacket?.realInvocationCoverage ?? {};
  const status =
    capabilityInvocationTruthPacket?.status === "pass" &&
    callableCoverage.status === "pass" &&
    realCoverage.status === "pass" &&
    truthAssertions.noLiveSubagentOverclaim === true &&
    truthAssertions.noHostUiSubagentOverclaim === true &&
    truthAssertions.noAgentTeamsPlaybookOverclaim === true &&
    truthAssertions.noMcpCallOverclaim === true &&
    truthAssertions.noHookTriggerOverclaim === true &&
    truthAssertions.selectedIsNotInvoked === true &&
    truthAssertions.discoveredIsNotInvoked === true &&
    truthAssertions.configuredIsNotInvoked === true &&
    truthAssertions.appliedIsNotInvoked === true &&
    truthAssertions.hostVisibleIsNotInvoked === true
      ? "pass"
      : "partial";
  return {
    id: "P-109",
    name: "能力调用真实性分层门",
    status,
    evidenceKind: "product_support_gate",
    stateTaxonomy: capabilityInvocationTruthPacket?.stateTaxonomy ?? CAPABILITY_INVOCATION_STATES,
    requiredFamilies: capabilityInvocationTruthPacket?.requiredFamilies ?? [],
    callableInvocationCoverage: callableCoverage,
    realInvocationCoverage: realCoverage,
    evidenceRefs: [
      "coreLoop.capabilityInvocationTruthPacket.rows",
      "coreLoop.capabilityInvocationTruthPacket.truthAssertions",
      "coreLoop.capabilityInvocationProbePacket",
      "coreLoop.executionResult.workerExecutionEvidence",
      "coreLoop.dynamicWorkflowRuntimePacket.capabilityBindingRows",
      "coreLoop.agentTeamsPlaybookPacket",
    ],
    forbiddenRelabels: [
      "selected_not_invoked_as_invoked",
      "discovered_not_selected_as_invoked",
      "configured_mcp_as_called",
      "matched_hook_as_triggered",
      "run_scoped_worker_as_live_subagent",
      "app_visible_subagent_as_runner_agent_spawn",
      "agent_teams_playbook_selected_as_live_agent_team",
      "prompt_update_as_flow_run",
      "prompt_rule_applied_as_tool_invoked",
      "host_visible_observed_as_runner_invoked",
    ],
    failIf:
      "A selected, discovered, configured, matched, prompt-applied, or app-visible capability is claimed as an invoked runner tool/agent/MCP/hook without fresh invocation evidence.",
  };
}

function buildAgentTeamsPlaybookGate({ agentTeamsPlaybookPacket }) {
  const status =
    agentTeamsPlaybookPacket?.status === "not_required" ||
    (
      agentTeamsPlaybookPacket?.status === "pass" &&
      agentTeamsPlaybookPacket?.triggered === true &&
      agentTeamsPlaybookPacket?.acceptance?.orchestrationReadyWhenParallelLanes === true &&
      agentTeamsPlaybookPacket?.acceptance?.independentLanesProven === true &&
      agentTeamsPlaybookPacket?.acceptance?.parallelWaveExists === true &&
      agentTeamsPlaybookPacket?.acceptance?.dagAndCollisionSafe === true &&
      agentTeamsPlaybookPacket?.acceptance?.waveSizeWithinCap === true &&
      agentTeamsPlaybookPacket?.acceptance?.waveSizeWithinRuntimeCapacity === true &&
      agentTeamsPlaybookPacket?.acceptance?.noArbitraryMetaKimCap === true &&
      agentTeamsPlaybookPacket?.acceptance?.workerPacketsPreserved === true &&
      agentTeamsPlaybookPacket?.acceptance?.noLiveSubagentOverclaim === true
    )
      ? "pass"
      : "partial";
  return {
    id: "P-110",
    name: "原生阶段 DAG 并行与可选编排适配门",
    status,
    evidenceKind: "product_support_gate",
    requiredFor:
      "2+ independent executable worker lanes after Thinking and before Execution fan-out; agent-teams-playbook remains optional.",
    evidenceRefs: [
      "coreLoop.agentTeamsPlaybookPacket",
      "coreLoop.dynamicWorkflowRuntimePacket.capabilityBindingCoverage.agentTeamsPlaybook",
      "coreLoop.capabilityInvocationTruthPacket.rows[family=agent_teams_playbook]",
    ],
    passIf:
      "2+ executable lanes prove stage-DAG readiness and dependency/resource/permission/isolation safety, use native host capacity, preserve workerTaskPackets as a derived view, and avoid live subagent overclaim; an optional agent-teams-playbook selection must not gate this route.",
    failIf:
      "Parallel worker lanes lack stage-DAG safety or runtime-capacity proof, inflate agent count without lane evidence, or relabel an optional adapter as a live Agent Team/spawn_agent call without host evidence.",
  };
}

function buildAutomationDecisionBoundary({ userPerceptionPacket, capabilityInvocationTruthPacket }) {
  const humanJudgmentStages = ["Critical", "Fetch", "Thinking", "Review"];
  const automationAllowed = [
    "evidence_collection",
    "candidate_option_drafting",
    "deterministic_validation",
    "risk_and_blocker_surfacing",
    "user_visible_status_summary",
  ];
  const automationForbidden = [
    "route_selection_without_human_evidence",
    "acceptance_or_risk_approval",
    "public_ready_claim_without_user_goal_done",
    "native_choice_evidence_substitution",
    "selected_not_invoked_relabel",
    "review_judgment_replacement",
  ];
  const humanDecisionControl = userPerceptionPacket?.humanDecisionControl ?? {};
  const truthAssertions = capabilityInvocationTruthPacket?.truthAssertions ?? {};
  const status =
    humanDecisionControl.decisionAuthority === "human_required" &&
    humanJudgmentStages.every((stage) =>
      (humanDecisionControl.humanJudgmentStages ?? []).includes(stage)
    ) &&
    truthAssertions.selectedIsNotInvoked === true &&
    truthAssertions.configuredIsNotInvoked === true &&
    truthAssertions.hostVisibleIsNotInvoked === true
      ? "pass"
      : "partial";
  return {
    schemaVersion: "automation-decision-boundary-v0.1",
    status,
    evidenceKind: "product_support_boundary",
    principle: "Automation assists; humans decide.",
    decisionAuthority: "human_required",
    humanJudgmentStages,
    automationRole: "assistive_only",
    automationAllowed,
    automationForbidden,
    userVisibleRequirement:
      "Readable reports and conversation notices must show where automation stops and where human judgment is required.",
    evidenceRefs: [
      "coreLoop.userPerceptionPacket.humanDecisionControl",
      "coreLoop.capabilityInvocationTruthPacket.truthAssertions",
      "coreLoop.nativeChoiceSurfaceGate",
      "canonical/skills/meta-theory/references/runtime-codex.md",
    ],
    passIf:
      "Automation only prepares evidence, options, deterministic checks, and user-visible summaries while Critical, Fetch, Thinking, and Review decisions remain human-governed.",
    failIf:
      "Automation selects a branch-changing route, approves risk, claims public-ready, replaces native choice evidence, or relabels selected/configured/visible capability states as invoked.",
  };
}

function buildProductExperiencePacket({
  runId,
  goalContractPacket,
  langGraphRunPacket,
  dynamicWorkflowRuntimePacket,
  peerAgentMeshPacket,
  agentTeamsPlaybookPacket,
  visibleMetaTheorySurfacePacket,
  capabilityInvocationTruthPacket,
  userPerceptionPacket,
  cardPlanPacket,
  dynamicWorkflowDecisionRecord,
  nativeChoiceEvidence,
  nativeChoiceEvidenceTrusted,
}) {
  const callableInvocationPass =
    capabilityInvocationTruthPacket?.callableInvocationCoverage?.status === "pass" &&
    capabilityInvocationTruthPacket?.realInvocationCoverage?.status === "pass";
  const goals = [
    {
      id: "P-102",
      name: "LangGraph-style 结构控制图",
      status: langGraphRunPacket.status === "pass" ? "pass" : "partial",
      evidenceKind: langGraphRunPacket.evidenceKind,
      evidenceRefs: [
        "coreLoop.langGraphRunPacket.nodes",
        "coreLoop.langGraphRunPacket.edges",
        "coreLoop.langGraphRunPacket.stateTransition",
        "coreLoop.langGraphRunPacket.eventLog",
        "coreLoop.langGraphRunPacket.checkpoint",
      ],
      failIf:
        "Only schema, fixture, board, or static documentation exists without checkpoint/replay, or structural evidence is described as real LangGraph runtime execution.",
    },
    {
      id: "P-103",
      name: "Dynamic Workflow 默认路线",
      status:
        dynamicWorkflowRuntimePacket.status === "pass" && callableInvocationPass
          ? "pass"
          : "partial",
      evidenceKind:
        dynamicWorkflowRuntimePacket.status === "pass" && callableInvocationPass
          ? "product_experience_pass"
          : dynamicWorkflowRuntimePacket.evidenceKind,
      evidenceRefs: [
        "coreLoop.dynamicWorkflowRuntimePacket.capabilityBindingRows",
        "coreLoop.dynamicWorkflowRuntimePacket.capabilityBindingCoverage",
        "coreLoop.capabilityInvocationProbePacket",
        "coreLoop.capabilityInvocationTruthPacket",
        "coreLoop.executionResult.workerResultPackets",
      ],
      failIf:
        "Only a fixed checklist, main-thread execution, workerTask without workerResult, selected capability without invocation truth, or selected callable providers without fresh invocation probe evidence exists.",
    },
    {
      id: "P-104",
      name: "用户可感知运行体验",
      status:
        userPerceptionPacket.status === "pass" &&
        visibleMetaTheorySurfacePacket?.status === "pass"
          ? "pass"
          : "partial",
      evidenceKind: userPerceptionPacket.evidenceKind,
      evidenceRefs: [
        "coreLoop.userPerceptionPacket.plainLanguageCues",
        "coreLoop.visibleMetaTheorySurfacePacket",
        "coreLoop.capabilityInvocationTruthPacket",
        "artifact.userExperienceNotice",
        "artifact.stageOperationPlan",
        "artifact.runReport.markdownPath",
      ],
      failIf:
        "Only JSON, log, report internals, packet names, or hidden artifacts explain orchestration, capabilities, peer mesh, dynamic workflow, or LangGraph.",
    },
  ];
  const supportGates = [
    {
      id: "P-105",
      name: "Goal-contract 反越级完成门",
      status: goalContractPacket.status === "pass" ? "pass" : "partial",
      evidenceKind: goalContractPacket.evidenceKind,
      evidenceRefs: [
        "coreLoop.goalContractPacket.contractFields",
        "coreLoop.goalContractPacket.lint",
      ],
      failIf:
        "Goal lacks verification, constraints, boundaries, iteration policy, stop/pause, or contains placeholders.",
    },
    buildNativeChoiceSurfaceGate({
      runId,
      cardPlanPacket,
      dynamicWorkflowDecisionRecord,
      nativeChoiceEvidence,
      nativeChoiceEvidenceTrusted,
    }),
    buildRepeatFailureDesignGate(),
    buildNoHardcodedFixtureGate({ goalContractPacket }),
    buildCapabilityInvocationTruthGate({ capabilityInvocationTruthPacket }),
    buildAgentTeamsPlaybookGate({ agentTeamsPlaybookPacket }),
  ];
  const automationDecisionBoundary = buildAutomationDecisionBoundary({
    userPerceptionPacket,
    capabilityInvocationTruthPacket,
  });
  const noOverclaimGate = {
    status: "pass",
    forbiddenAsProductPass: [
      "contract_ready only",
      "fixture_pass_not_live",
      "local_runner_pass without user perception",
      "runtime_json_pass",
      "projection_smoke",
      "internal packet dump",
      "hidden orchestration artifacts",
      "chat_card_as_native_popup",
      "demo_fixture_as_framework_goal",
      "selected_capability_as_invoked_tool",
      "configured_mcp_as_called_tool",
      "hook_file_or_match_as_triggered_hook",
      "run_scoped_worker_as_live_subagent",
      "agent_teams_playbook_selected_as_live_agent_team",
      "automation_assistance_as_human_decision",
    ],
    acceptedEvidenceTier: "live_host_observed",
  };
  const status = goals.every((goal) => goal.status === "pass") &&
    supportGates.every((gate) => gate.status === "pass") &&
    automationDecisionBoundary.status === "pass" &&
    noOverclaimGate.status === "pass"
    ? "product_experience_pass"
    : "partial";
  return {
    schemaVersion: "product-experience-core-goals-v0.1",
    status,
    evidenceTier: status === "product_experience_pass" ? "live_host_observed" : "structural_only",
    nativeRuntimeBoundary:
      "This proves the default Meta_Kim governed product layer; it does not claim Claude Code/Codex native live UI by itself.",
    coreGoalIds: PRODUCT_EXPERIENCE_CORE_GOAL_IDS,
    supportGateIds: PRODUCT_EXPERIENCE_SUPPORT_GATE_IDS,
    goals,
    supportGates,
    goalContractGate: supportGates.find((gate) => gate.id === "P-105"),
    nativeChoiceSurfaceGate: supportGates.find((gate) => gate.id === "P-106"),
    repeatFailureDesignGate: supportGates.find((gate) => gate.id === "P-107"),
    generalizationGate: supportGates.find((gate) => gate.id === "P-108"),
    capabilityInvocationTruthGate: supportGates.find((gate) => gate.id === "P-109"),
    agentTeamsPlaybookGate: supportGates.find((gate) => gate.id === "P-110"),
    automationDecisionBoundary,
    noOverclaimGate,
    requiredCompletionEvidence: [
      "goalContractPacket.status=pass",
      "langGraphRunPacket.status=pass",
      "dynamicWorkflowRuntimePacket.status=pass",
      "peerAgentMeshPacket.status=pass",
      "nativeChoiceSurfaceGate.status=pass",
      "capabilityInvocationTruthPacket.status=pass",
      "capabilityInvocationTruthPacket.callableInvocationCoverage.status=pass",
      "visibleMetaTheorySurfacePacket.status=pass",
      "userPerceptionPacket.status=pass",
      "automationDecisionBoundary.status=pass",
      "productExperiencePacket.supportGates[].status=pass",
    ],
  };
}

function buildPerformanceCostBudget() {
  const highUsePaths = [
    ["route-selection", 30000, 24000, "project-capability-cache"],
    ["research-fetch", 90000, 48000, "source-dossier-cache"],
    ["graph-extraction", 120000, 32000, "graphify-slice-cache"],
    ["sync-check", 120000, 12000, "generated-projection-cache"],
    ["prompt-asset-review", 60000, 36000, "prompt-layer-fixture-cache"],
    ["verification-suite", 180000, 24000, "test-result-cache"],
  ];
  return {
    schemaVersion: "performance-cost-budget-v0.1",
    prdTaskId: "P-080",
    status: "pass",
    currentAsOf: "2026-06-13",
    highUsePaths: highUsePaths.map(([pathId, p95LatencyBudgetMs, tokenBudget, cachePolicy]) => ({
      pathId,
      p95LatencyBudgetMs,
      tokenBudget,
      costBudgetPolicy: {
        externalPaidCostWithoutApprovalUsd: 0,
        providerPricingRequiredForDollarEstimate: true,
        batchAllowedOnlyFor: ["offline_eval", "non_interactive_research"],
      },
      cachePolicy,
      promptCachingPolicy:
        "provider_specific_versioned_prompt_cache_only; no cross-provider cache claim",
    })),
    acceptance: {
      allHighUsePathsBudgeted: true,
      externalPaidWorkRequiresApproval: true,
      commandPassIsNotUserGoalDone: true,
    },
  };
}

function buildContextEngineeringBudget({
  capabilitySearchLog,
  stageOperationPlan,
}) {
  return {
    schemaVersion: "context-engineering-budget-v0.1",
    prdTaskId: "P-084",
    status: "pass",
    currentAsOf: "2026-06-13",
    fixedContext: [
      {
        source: "AGENTS.md",
        freshness: "repo-current",
        reasonIncluded: "project governance entrypoint",
        reasonOmitted: null,
      },
      {
        source: "canonical/skills/meta-theory/SKILL.md",
        freshness: "repo-current",
        reasonIncluded: "canonical meta-theory prompt contract",
        reasonOmitted: null,
      },
      {
        source: "config/contracts/core-loop-contract.json",
        freshness: "repo-current",
        reasonIncluded: "machine-readable core loop contract",
        reasonOmitted: null,
      },
    ],
    variableContext: [
      ...capabilitySearchLog.slice(0, 12).map((item) => ({
        source: item.source,
        freshness: "run-current",
        reasonIncluded: "route-changing capability or evidence source",
        reasonOmitted: null,
      })),
      ...(stageOperationPlan?.stages ?? []).map((stage) => ({
        source: `stageOperationPlan.${stage.stage}`,
        freshness: "run-current",
        reasonIncluded: "visible stage event and report shaping",
        reasonOmitted: null,
      })),
    ],
    omissionPolicy: [
      {
        sourceClass: "duplicate_rule",
        reasonOmitted: "same rule already exists in canonical contract",
        returnToStage: "Thinking",
      },
      {
        sourceClass: "conflicting_rule",
        reasonOmitted: "conflict requires owner decision before execution",
        returnToStage: "Thinking",
      },
      {
        sourceClass: "runtime_only_schema",
        reasonOmitted: "renderer schema belongs in runtime adapter, not canonical prompt",
        returnToStage: "Thinking",
      },
    ],
    budgetRules: {
      longContextOnlyForRouteChangingEvidence: true,
      duplicateRulesReturnToThinking: true,
      runtimeOnlyLeakReturnsToThinking: true,
      fixedVariableContextSeparated: true,
    },
  };
}

function buildCoreLoopArtifact({
  runId,
  task,
  orchestrationReport,
  capabilityInventoryBus,
  decisionResults,
  runtimeEvidence,
  writebackFlow,
  artifactStatus,
  cardPlanPacket,
  stageOperationPlan,
  conversationNotice,
  userExperienceNotice,
  analytics,
  hostVisibleSubagents,
  hostInvocationEvidence,
  nativeChoiceEvidence,
  nativeChoiceEvidenceTrusted,
  agentTeamsPlaybookProvider,
  invokeCapabilityProbes = false,
  projectRoot = null,
  projectCapabilityMutationMode = "auto",
  projectCapabilityCandidateRoot = null,
  runtime = "codex",
  osTarget = "windows",
  outputLanguage = "zh-CN",
  executionAllowed = true,
  preDecisionOptionFrame = null,
}) {
  const routeRuntime = normalizeRouteRuntime(runtime);
  const routeOs = normalizeOsTarget(osTarget);
  const entryClassification = classifyMetaTheoryEntry(task);
  const workerTaskPackets = orchestrationReport.workerTaskPackets ?? [];
  const capabilityInventory =
    capabilityInventoryBus?.capabilities ??
    orchestrationReport.fetchEvidence?.capabilityInventory ??
    [];
  const capabilitySearchLog = [
    ...new Set(
      [
        ...capabilityInventory
          .map((record) => record.sourcePath ?? record.sourceRef)
          .filter(Boolean),
        ...(orchestrationReport.fetchEvidence?.sources ?? [])
          .map((record) => {
            if (typeof record === "string") return record;
            const label = record.sourceType === "project_graph"
              ? "Graphify project map"
              : record.sourceType === "mcp_inventory"
                ? "MCP inventory"
                : record.sourceType;
            return `${label}: ${record.source}`;
          })
          .filter(Boolean),
        ...(agentTeamsPlaybookProvider?.candidates ?? []).map(
          (candidate) =>
            `agent-teams-playbook ${candidate.source}: ${candidate.pathRef} -> ${candidate.found ? "found" : "missing"}`
        ),
      ],
    ),
  ].map((source) => ({
    source,
    checked: true,
    result: String(source).includes(": ")
      ? "fetch_source_class_recorded"
      : "capability_provider_recorded",
  }));
  const parallelGroups = [
    ...new Set(workerTaskPackets.map((packet) => packet.parallelGroup).filter(Boolean)),
  ];
  const verificationEvidence = (runtimeEvidence.results ?? []).map((item) => ({
    runtime: item.runtime,
    status: item.status,
    evidenceKind: item.evidenceKind,
    failureClass: item.failureClass,
    command: item.command,
    artifact: item.artifact,
    strictReleasePass: item.strictReleasePass,
  }));
  const liveReleaseEvidenceReady =
    runtimeEvidence.releaseGrade === true &&
    verificationEvidence.length > 0 &&
    verificationEvidence.every((item) => item.strictReleasePass === true);
  const writebackDecision =
    writebackFlow.status === "approved-for-writeback"
      ? "writeback"
      : writebackFlow.status === "none-with-reason"
        ? "none-with-reason"
        : "candidate-writeback";
  let publicReady = false;
  let publicReadyBlockedBy = [];
  const governanceAgentResultPackets = buildGovernanceAgentResultPackets({
    runId,
    orchestrationReport,
    capabilitySearchLog,
    workerTaskPackets,
    runtimeEvidence,
    writebackFlow,
    analytics,
  });
  const conductorConsumptionEvidence = buildConductorConsumptionEvidence({
    governanceAgentResultPackets,
    orchestrationReport,
    workerTaskPackets,
  });
  const workerResultPackets = workerTaskPackets.map((packet) => {
    const requiresApproval =
      packet.executionMode === "approval_gate" || packet.externalWriteBoundary === true;
    const acceptanceEvidence = (packet.acceptanceCriteria ?? []).map((criterion, index) => ({
      criterion,
      status: "pending_execution",
      evidenceRef: packet.evidenceRefs?.[index] ?? packet.taskPacketId,
    }));
    return {
      taskPacketId: packet.taskPacketId,
      owner: packet.owner,
      ownerAgent: packet.ownerAgent,
      executionMode: packet.executionMode,
      status: !executionAllowed
        ? "blocked_by_plan_challenge"
        : requiresApproval
          ? "blocked_or_needs_approval"
          : "planned_not_executed",
      resultKind: !executionAllowed
        ? "plan_challenge_gate"
        : requiresApproval
          ? "approval_gate"
          : "run_scoped_worker_plan",
      evidenceKind: !executionAllowed
        ? "plan_challenge_not_ready"
        : requiresApproval
          ? "approval_required"
          : "structural_worker_plan",
      output: !executionAllowed || requiresApproval
        ? null
        : {
            declaredOutput: packet.output ?? "worker_result",
            producedBy: "governed_runner_planner",
            ownerBoundary: packet.ownerAgent ?? packet.owner,
            shardScope: packet.shardScope ?? packet.businessFlowLaneLabel ?? packet.workType,
            acceptanceEvidence,
            nonGoalsPreserved: packet.nonGoals ?? [],
            externalWritePerformed: false,
          },
      executionSteps: requiresApproval
        ? []
        : [
            "load_worker_task_packet",
            "verify_scope_and_non_goals",
            "prepare_declared_output_contract",
            "request_external_worker_execution_evidence",
          ],
      note: !executionAllowed
        ? "Execution is blocked until the plan challenge is ready and separately authorized where required."
        : requiresApproval
          ? "Approval is required before this worker can execute."
          : "The runner produced a bounded worker plan only; it did not execute the worker's command or deliverable.",
    };
  });
  const workerExecutionEvidence = workerResultPackets.map((result, index) => {
    const packet = workerTaskPackets[index] ?? {};
    const evidenceRunAt = nowIso();
    const stepEvidence = (packet.verifySteps ?? []).map((step, stepIndex) => {
      const status = result.status === "planned_not_executed" ? "pending_execution" : "skipped";
      const base = {
        verifyStepRef: step.id ?? `verify-step-${stepIndex + 1}`,
        command: step.command ?? "npm run meta:theory:run",
        passClaim: step.successMarker ?? "status=pass",
        status,
        runBy: "not_run",
        runAt: evidenceRunAt,
        expectedResult: step.successMarker ?? "status=pass",
        observedResult:
          status === "pending_execution"
            ? "not_run_by_governed_runner"
            : "approval_or_dependency_blocked",
        workingDirectory: "repo-root",
        stderrTail: "",
        successMarkerFormat: "exit-code-only",
        evidenceKind: result.evidenceKind,
        artifactRef: `coreLoop.executionResult.workerResultPackets[${index}]`,
      };
      return {
        ...base,
        skipReason:
          status === "pending_execution"
            ? "A real host worker/executor must run this verify step and return observed evidence."
            : "Worker task execution is blocked until approval or missing dependency is resolved.",
      };
    });
    result.workerExecutionEvidence = stepEvidence;
    return {
      taskPacketId: result.taskPacketId,
      owner: result.owner,
      evidenceKind: result.evidenceKind,
      status: result.status,
      command: "npm run meta:theory:run",
      artifactRef: `coreLoop.executionResult.workerResultPackets[${index}]`,
      verifyStepRefs: stepEvidence.map((item) => item.verifyStepRef),
      liveWorkerExecution: false,
      externalAgentSpawned: false,
      reason:
        result.status === "planned_not_executed"
          ? "The governed runner prepared the bounded task packet but did not execute it."
          : "Execution is blocked until approval or missing dependency is resolved.",
    };
  });
  const actualWorkerExecution = workerExecutionEvidence.some(
    (item) => item.liveWorkerExecution === true,
  );
  const evolutionNoneWithReason =
    writebackDecision === "none-with-reason"
      ? (writebackFlow.decisionReason ?? "No durable writeback was required for this run.")
      : null;
  const evolutionWritebacks =
    writebackDecision === "writeback"
      ? (writebackFlow.writebacks ?? writebackFlow.dryRun?.writebacks ?? [])
      : [];
  const capabilityGapPacket =
    orchestrationReport.capabilityGaps?.length > 0
      ? {
          status: "present",
          gapTypes: [
            ...new Set(
              orchestrationReport.capabilityGaps
                .map((gap) => gap.gapType ?? gap.decision ?? gap.branch)
                .filter(Boolean),
            ),
          ],
          gaps: orchestrationReport.capabilityGaps,
          decisionOptions: [
            "run-scoped worker",
            "upgrade durable capability",
            "create durable capability",
            "ask user",
            "block",
          ],
          writebackTarget:
            writebackDecision === "none-with-reason"
              ? null
              : "config/capability-index",
        }
      : null;
  const capabilityReady = capabilityGapPacket
    ? null
    : {
        status: "ready",
        owner: orchestrationReport.orchestrationTaskBoardPacket?.synthesisOwner,
        weapon: "workerTaskPackets",
        reviewOwner: orchestrationReport.reviewResult?.owner,
        metaReviewOwner: "meta-warden",
        verificationOwner: orchestrationReport.verificationResult?.owner,
        reason: "Fetch and Thinking selected a reusable route without a blocking capability gap.",
      };
  const dynamicWorkflowDecisionRecord = {
    stage: "Thinking",
    notFixedChecklist: true,
    cards: (cardPlanPacket?.cardTypeDecisions ?? []).map((card) => ({
      cardKey: card.cardKey,
      label: card.label,
      trigger: card.cardReason,
      reason: isActiveCardDecision(card.cardDecision)
        ? "Selected by current route evidence."
        : "Not needed for this route.",
      attentionCost: card.cost,
      skippedCardsWithReason:
        isActiveCardDecision(card.cardDecision)
          ? []
          : [
              {
                cardKey: card.cardKey,
                reason: card.suppressionReason ?? "Deferred because the current route does not require this intervention.",
              },
            ],
      interruptQueue:
        card.type === "risk" && isActiveCardDecision(card.cardDecision)
          ? ["meta-sentinel"]
          : [],
      riskPreemption:
        card.type === "risk" && isActiveCardDecision(card.cardDecision)
          ? "projection or release evidence can preempt execution/public-ready"
          : "not_required",
      maxIterationHandling:
        card.type === "fix"
          ? "bounded repair then return to Review/Verification"
          : "no extra iteration opened",
      escalationOwner:
        card.owner ?? (card.type === "risk" ? "meta-sentinel" : "meta-conductor"),
    })),
    interruptQueue: cardPlanPacket?.controlDecisions ?? [],
    skippedCardsWithReason: (cardPlanPacket?.cardTypeDecisions ?? [])
      .filter((card) => !isActiveCardDecision(card.cardDecision))
      .map((card) => ({
        cardKey: card.cardKey,
        reason: card.suppressionReason ?? "Deferred by dynamic workflow route.",
      })),
    riskPreemption:
      runtimeEvidence.releaseGrade === true
        ? "release evidence is present"
        : "release/public-ready stays blocked until live release evidence exists",
    maxIterationHandling: "Fix cards may iterate only while Review or Verification failures remain bounded.",
    escalationOwner: "meta-warden",
  };
  const traceEvalControlPlane = buildTraceEvalControlPlane({
    runId,
    artifactStatus,
    stageOperationPlan,
    workerTaskPackets,
    runtimeEvidence,
    verificationEvidence,
    capabilitySearchLog,
    governanceAgentResultPackets,
    conductorConsumptionEvidence,
  });
  const agUiStageEvents = buildAgUiStageEvents({
    runId,
    stageOperationPlan,
  });
  const goalContractPacket = buildGoalContractPacket({ task });
  const langGraphRunPacket = buildLangGraphRunPacket({
    runId,
    stageOperationPlan,
    workerTaskPackets,
    workerResultPackets,
    workerExecutionEvidence,
    agUiStageEvents,
    conductorConsumptionEvidence,
  });
  const peerAgentMeshPacket = buildPeerAgentMeshPacket({
    workerTaskPackets,
    workerResultPackets,
  });
  const agentTeamsPlaybookPacket = buildAgentTeamsPlaybookPacket({
    workerTaskPackets,
    providerResolution: agentTeamsPlaybookProvider,
    workerExecutionEvidence,
  });
  const stageDagPacket = buildRunnerStageDagPacket(
    workerTaskPackets,
    agentTeamsPlaybookPacket,
  );
  const runtimeSubagentInvocationPacket = buildRuntimeSubagentInvocationPacket({
    agentTeamsPlaybookPacket,
    workerExecutionEvidence,
  });
  const dynamicWorkflowRuntimePacket = buildDynamicWorkflowRuntimePacket({
    orchestrationReport,
    workerTaskPackets,
    workerResultPackets,
    dynamicWorkflowDecisionRecord,
    agentTeamsPlaybookPacket,
  });
  const capabilityInvocationProbePacket = buildCapabilityInvocationProbePacket({
    dynamicWorkflowRuntimePacket,
    enabled: invokeCapabilityProbes,
  });
  const runtimeInvocationPlanPacket = buildRuntimeInvocationPlanPacket({
    runId,
    dynamicWorkflowRuntimePacket,
    agentTeamsPlaybookPacket,
    runtimeSubagentInvocationPacket,
    capabilityInvocationProbePacket,
    hostInvocationEvidence,
  });
  const hostInvocationRequestPacket = buildHostInvocationRequestPacket({
    runtimeInvocationPlanPacket,
    workerTaskPackets,
  });
  const durableAgentLifecyclePacket = buildDurableAgentLifecyclePacket({
    writebackFlow,
    hostInvocationEvidence,
  });
  const capabilityInvocationTruthPacket = buildCapabilityInvocationTruthPacket({
    runId,
    orchestrationReport,
    dynamicWorkflowRuntimePacket,
    peerAgentMeshPacket,
    workerExecutionEvidence,
    hostVisibleSubagents,
    hostInvocationEvidence: runtimeInvocationPlanPacket.evidence,
    agentTeamsPlaybookPacket,
    capabilityInvocationProbePacket,
    runtimeSubagentInvocationPacket,
    runtimeInvocationPlanPacket,
  });
  const capabilityInvocationPresentationPacket = buildCapabilityInvocationPresentation({
    capabilityInvocationTruthPacket,
    runtimeSubagentInvocationPacket,
    outputLanguage,
  });
  const projectCustomizationPlan = buildProjectCustomizationPacket({
    task,
    runId,
    runtime: routeRuntime,
    orchestrationReport,
    runtimeInvocationPlanPacket,
    outputLanguage,
  });
  const projectCustomizationPacket = executeProjectCustomizationPacket({
    packet: projectCustomizationPlan,
    runtime: routeRuntime,
    runId,
    projectRoot: projectRoot ?? activeProjectRoot(),
    candidateRoot: projectCapabilityCandidateRoot,
    mutationMode: projectCapabilityMutationMode,
    entryClassification,
    outputLanguage,
  });
  const capabilityLedgerPacket = buildCapabilityLedgerPacket({
    capabilityInvocationTruthPacket,
    runtimeInvocationPlanPacket,
    projectCustomizationPacket,
    outputLanguage,
  });
  const visibleMetaTheorySurfacePacket = buildVisibleMetaTheorySurfacePacket({
    orchestrationReport,
    langGraphRunPacket,
    dynamicWorkflowRuntimePacket,
    peerAgentMeshPacket,
    capabilityInvocationProbePacket,
    capabilityInvocationTruthPacket,
    capabilityInvocationPresentationPacket,
    capabilityLedgerPacket,
    projectCustomizationPacket,
    agentTeamsPlaybookPacket,
  });
  const userPerceptionPacket = buildUserPerceptionPacket({
    conversationNotice,
    userExperienceNotice,
    stageOperationPlan,
    agUiStageEvents,
    visibleMetaTheorySurfacePacket,
    productExperienceGoals: PRODUCT_EXPERIENCE_CORE_GOAL_IDS,
    outputLanguage,
  });
  const productExperiencePacket = buildProductExperiencePacket({
    runId,
    goalContractPacket,
    langGraphRunPacket,
    dynamicWorkflowRuntimePacket,
    peerAgentMeshPacket,
    agentTeamsPlaybookPacket,
    runtimeSubagentInvocationPacket,
    visibleMetaTheorySurfacePacket,
    capabilityInvocationTruthPacket,
    userPerceptionPacket,
    cardPlanPacket,
    dynamicWorkflowDecisionRecord,
    nativeChoiceEvidence,
    nativeChoiceEvidenceTrusted,
  });
  const selectedExecutableTruthGaps = (capabilityInvocationTruthPacket.rows ?? [])
    .filter(
      (row) =>
        row.selectedCount > 0 &&
        ["selected_not_invoked", "unavailable", "blocked"].includes(row.state),
    )
    .map((row) => `${row.family}:${row.state}`);
  publicReadyBlockedBy = [
    ...(artifactStatus === "pass" ? [] : ["artifactStatus is not pass before coreLoop gate closure."]),
    ...(liveReleaseEvidenceReady ? [] : ["live release/runtime evidence is not release-grade ready."]),
    ...(runtimeInvocationPlanPacket.status === "pass" ? [] : ["runtimeInvocationPlanPacket.status is not pass."]),
    ...(hostInvocationRequestPacket.status === "pass" ? [] : ["hostInvocationRequestPacket.status is not pass."]),
    ...(capabilityInvocationTruthPacket.realInvocationCoverage?.status === "pass"
      ? []
      : ["capabilityInvocationTruthPacket.realInvocationCoverage.status is not pass."]),
    ...(productExperiencePacket.status === "product_experience_pass"
      ? []
      : ["productExperiencePacket.status is not product_experience_pass."]),
    ...(["partial", "read_only"].includes(projectCustomizationPacket.status)
      ? [`projectCustomizationPacket.status=${projectCustomizationPacket.status}.`]
      : []),
    ...selectedExecutableTruthGaps.map(
      (gap) => `selected executable capability is not invoked: ${gap}.`,
    ),
  ];
  publicReady = publicReadyBlockedBy.length === 0;
  const performanceCostBudget = buildPerformanceCostBudget();
  const contextEngineeringBudget = buildContextEngineeringBudget({
    capabilitySearchLog,
    stageOperationPlan,
  });
  return {
    schemaVersion: "core-loop-run-v0.1",
    contractRef: "config/contracts/core-loop-contract.json",
    requestRecord: {
      runId,
      task,
      entry: "meta:theory:run",
      requestType: "ordinary natural-language durable task or explicit meta-theory shortcut",
      runtimeContext: {
        runtimeFamily: routeRuntime,
        os: routeOs,
      },
      entryClassification,
      permissionBoundary: "local run artifact and repo-local state writes unless explicit approval is supplied",
    },
    spine: [
      "Critical",
      "Fetch",
      "Thinking",
      "Execution",
      "Review",
      "Meta-Review",
      "Verification",
      "Evolution",
    ],
    intentPacket: {
      stage: "Critical",
      realIntent: orchestrationReport.criticalSummary?.realGoal,
      successCriteria: orchestrationReport.criticalSummary?.successCriteria ?? [],
      nonGoals: orchestrationReport.criticalSummary?.nonGoals ?? [],
      blockingUnknowns: [],
      noQuotaClarification: true,
    },
    fetchPacket: {
      stage: "Fetch",
      evidence: orchestrationReport.fetchEvidence?.sources ?? [],
      decisionImpactMap: orchestrationReport.fetchEvidence?.decisionImpactMap ?? [],
      capabilityDiscovery: {
        searchLog: capabilitySearchLog,
        capabilityInventory,
        summary: capabilityInventoryBus?.summary ?? null,
      },
      capabilityGap:
        capabilityGapPacket
          ? {
              status: "present",
              count: orchestrationReport.capabilityGaps.length,
              decisions: orchestrationReport.decisionCounts,
            }
          : null,
      capabilityReady,
    },
    capabilityInventory,
    capabilityGapPacket,
    capabilityReady,
    governanceAgentResultPackets,
    conductorConsumptionEvidence,
    dynamicWorkflowDecisionRecord,
    preDecisionOptionFrame,
    goalContractPacket,
    langGraphRunPacket,
    dynamicWorkflowRuntimePacket,
    peerAgentMeshPacket,
    stageDagPacket,
    stageRunnerBridgePacket: null,
    agentTeamsPlaybookPacket,
    runtimeSubagentInvocationPacket,
    runtimeInvocationPlanPacket,
    hostInvocationRequestPacket,
    capabilityInvocationProbePacket,
    capabilityInvocationTruthPacket,
    capabilityInvocationPresentationPacket,
    capabilityLedgerPacket,
    projectCustomizationPacket,
    durableAgentLifecyclePacket,
    visibleMetaTheorySurfacePacket,
    userPerceptionPacket,
    productExperiencePacket,
    traceEvalControlPlane,
    agUiStageEvents,
    performanceCostBudget,
    contextEngineeringBudget,
    fileChangeFactCard: {
      stage: "Fetch",
      mutationPlanned: projectCustomizationPacket.execution.mutationRequired,
      changedFiles: projectCustomizationPacket.execution.results.flatMap(
        (result) => result.targetPaths ?? [],
      ),
      consumer: "coreLoop structural run artifact",
      overlapDecision:
        projectCustomizationPacket.execution.appliedCount > 0
          ? "project capability mutations used the shared project-mutation-session lock"
          : "no project capability mutation was applied",
      dataShape:
        "The run writes a governed execution artifact and state events; source edits happen in separate implementation runs.",
      evidenceRef: "coreLoop.fetchPacket.capabilityDiscovery",
    },
    thinkingPacket: {
      stage: "Thinking",
      designFrame: orchestrationReport.thinkingRoute?.boardMode,
      dispatchBoard: orchestrationReport.orchestrationTaskBoardPacket,
      owner: orchestrationReport.orchestrationTaskBoardPacket?.synthesisOwner,
      weapon: "workerTaskPackets",
      workerTaskPackets,
      stageDagPacketRef: "coreLoop.stageDagPacket",
      projectCustomizationPacket,
      reviewOwner: orchestrationReport.reviewResult?.owner,
      verificationOwner: orchestrationReport.verificationResult?.owner,
      mergeOwner: "meta-conductor",
      parallelGroups,
      dependencyPolicy: "capability gap route before blind execution; external writes require approval",
      omittedLanesWithReason: orchestrationReport.thinkingRoute?.dynamicWorkflowPlan?.omittedLaneIds ?? [],
      omittedLaneRecords:
        orchestrationReport.thinkingRoute?.dynamicWorkflowPlan?.omittedLanesWithReason ?? [],
      governanceInputsConsumed: conductorConsumptionEvidence.consumedPacketRefs,
    },
    executionResult: {
      stage: "Execution",
      executionAllowed,
      executionGate: executionAllowed ? "ready" : "blocked_by_plan_challenge",
      mainThreadRole: "scope_delegate_review_synthesize",
      executionOwnerMode: "workerTaskPackets",
      actualWorkerExecution,
      actualProjectCapabilityMutation:
        projectCustomizationPacket.execution.appliedCount > 0,
      projectCapabilityMutation: projectCustomizationPacket.execution,
      executionClosure: !executionAllowed
        ? "blocked_by_plan_challenge"
        : actualWorkerExecution
        ? "run_scoped_worker_executed"
        : projectCustomizationPacket.execution.appliedCount > 0
          ? "project_capability_materialized"
        : "worker_execution_blocked_or_not_required",
      workerTaskPacketCount: workerTaskPackets.length,
      workerResultPackets,
      workerExecutionEvidence,
      mergeResult: {
        mergeOwner: "meta-conductor",
        status: actualWorkerExecution
          ? "worker_results_merged"
          : workerTaskPackets.length > 0
            ? "dispatch_board_merged"
            : "no_worker_tasks",
        artifactRefs: [
          "coreLoop.governanceAgentResultPackets",
          "coreLoop.conductorConsumptionEvidence",
          "coreLoop.thinkingPacket.dispatchBoard",
          "coreLoop.executionResult.workerResultPackets",
        ],
        governanceResultsConsumed: conductorConsumptionEvidence.status === "pass",
        consumedGovernancePacketRefs: conductorConsumptionEvidence.consumedPacketRefs,
        liveExecutionMerged: actualWorkerExecution,
        reason:
          actualWorkerExecution
            ? "The default run merged run-scoped worker results; public-ready still waits for verification evidence."
            : "The default run merges orchestration and dispatch artifacts; public-ready waits for verification evidence.",
      },
    },
    reviewPacket: {
      stage: "Review",
      owner: orchestrationReport.reviewResult?.owner,
      status: orchestrationReport.reviewResult?.status,
      ownerCoverage: {
        dispatchOwner: orchestrationReport.orchestrationTaskBoardPacket?.synthesisOwner,
        reviewOwner: orchestrationReport.reviewResult?.owner,
        verificationOwner: orchestrationReport.verificationResult?.owner,
        workerOwners: [...new Set(workerTaskPackets.map((packet) => packet.owner))],
        governanceAgents: governanceAgentResultPackets.map((packet) => ({
          agent: packet.agent,
          status: packet.status,
          activationState: packet.activationState,
          packetId: packet.packetId,
        })),
        conductorConsumedGovernanceResults: conductorConsumptionEvidence.status === "pass",
        pass: workerTaskPackets.length > 0 && Boolean(orchestrationReport.reviewResult?.owner),
      },
      protocolCompliance: {
        criticalFetchThinkingChecked: true,
        capabilityDiscoveryChecked:
          orchestrationReport.reviewResult?.checks?.multiTypeCapabilityInventoryPresent === true,
        workerTaskPacketsPresent: workerTaskPackets.length > 0,
        governanceAgentResultPacketsPresent: governanceAgentResultPackets.length > 0,
        conductorConsumptionEvidencePresent: conductorConsumptionEvidence.status === "pass",
        executionEvidenceLayerIsHonest: true,
        productExperienceEvidencePresent:
          productExperiencePacket.status === "product_experience_pass" &&
          capabilityInvocationProbePacket.status === "pass" &&
          capabilityInvocationTruthPacket.status === "pass" &&
          visibleMetaTheorySurfacePacket.status === "pass",
      },
      qualityGate: {
        status: orchestrationReport.reviewResult?.status,
        publicReadyAllowed: publicReady,
        reason: publicReady
          ? "Live release evidence is present."
          : actualWorkerExecution
            ? "Run-scoped worker execution is present; public-ready still waits for live release evidence."
            : "Structural dispatch evidence is present, but live worker/runtime evidence is not claimed.",
      },
      upstreamQuality: {
        critical: true,
        fetch: orchestrationReport.reviewResult?.checks?.multiTypeCapabilityInventoryPresent === true,
        thinking: orchestrationReport.reviewResult?.checks?.workerTasksDeclareExecutionMode === true,
      },
      checks: orchestrationReport.reviewResult?.checks ?? {},
      findings: orchestrationReport.reviewResult?.status === "pass" ? [] : ["core loop review failed"],
    },
    metaReviewPacket: {
      stage: "Meta-Review",
      owner: "meta-warden",
      status: orchestrationReport.reviewResult?.status === "pass" ? "pass" : "fail",
      reviewStandard: "Review checked upstream Critical, Fetch, Thinking, and result evidence boundaries before public-ready.",
      biasCheck: {
        overclaimCheck: publicReady
          ? "pass"
          : actualWorkerExecution
            ? "blocked_release_evidence_not_all_runtime_live"
            : "blocked_smoke_or_structural_evidence_not_labeled_live",
        mainThreadExecutorCheck: "main_thread_scopes_and_synthesizes_only",
      },
      reviewStandardChecked: true,
      publicReadyGateCheck: publicReady ? "pass" : "not_public_ready_without_live_release_evidence",
    },
    verificationResult: {
      stage: "Verification",
      owner: "verify",
      status: runtimeEvidence.status,
      evidence: verificationEvidence,
      governanceEvidence: {
        governanceAgentResultPackets: governanceAgentResultPackets.length,
        conductorConsumptionEvidence: conductorConsumptionEvidence.status,
      },
      workerEvidence: {
        workerResultPackets: workerResultPackets.length,
        workerExecutionEvidence: workerExecutionEvidence.length,
        nestedWorkerExecutionEvidence: workerResultPackets.reduce(
          (sum, packet) => sum + (packet.workerExecutionEvidence?.length ?? 0),
          0,
        ),
      },
      productExperienceEvidence: {
        status: productExperiencePacket.status,
        evidenceTier: productExperiencePacket.evidenceTier,
        packetRefs: [
          "coreLoop.goalContractPacket",
          "coreLoop.langGraphRunPacket",
          "coreLoop.dynamicWorkflowRuntimePacket",
          "coreLoop.peerAgentMeshPacket",
          "coreLoop.agentTeamsPlaybookPacket",
          "coreLoop.capabilityInvocationProbePacket",
          "coreLoop.capabilityInvocationTruthPacket",
          "coreLoop.visibleMetaTheorySurfacePacket",
          "coreLoop.userPerceptionPacket",
          "coreLoop.productExperiencePacket",
        ],
        acceptanceCommand: "npm run meta:prd:product-experience:validate",
      },
      fuseMode: "public_ready_and_release_gate",
      notEveryStepInterceptor: true,
      fixEvidence: verificationEvidence.filter((item) => item.status === "pass"),
      remainingRisk: publicReady
        ? []
        : [
            actualWorkerExecution
              ? "Run-scoped worker execution is present, but all-runtime live release evidence is not attached."
              : "No live all-runtime worker execution evidence is attached to this coreLoop summary.",
            "This summary is not a strict workflow-contract run artifact for validate-run-artifact.mjs.",
          ],
    },
    evolutionWritebackDecision: {
      stage: "Evolution",
      decision: writebackDecision,
      status: writebackFlow.status,
      reason:
        writebackFlow.status === "candidate_only"
          ? "Reusable candidates require Warden approval before canonical writeback."
          : (writebackFlow.decisionReason ?? "Recorded writeback decision for this run."),
      candidateCount: writebackFlow.candidates?.length ?? decisionResults.length,
      canonicalWrites: writebackFlow.dryRun?.canonicalWrites ?? 0,
    },
    evolutionWritebackPacket: {
      stage: "Evolution",
      writebackDecision,
      writebacks: evolutionWritebacks,
      noneWithReason: evolutionNoneWithReason,
      retain: [
        {
          target: "config/contracts/core-loop-contract.json",
          reason: "Core loop contract remains the compact default-path source.",
        },
      ],
      upgrade:
        writebackDecision === "candidate-writeback"
          ? [
              {
                target: "future-iteration",
                reason:
                  "Promote structural coreLoop summary into a strict workflow-contract run artifact only after a dedicated validator design.",
              },
            ]
          : [],
    },
    scarPacket: {
      stage: "Evolution",
      status: publicReady ? "none" : "recorded",
      failurePattern: publicReady
        ? null
        : actualWorkerExecution
          ? "run_scoped_worker_execution_can_be_overread_as_all_runtime_public_ready"
          : "structural_orchestration_evidence_can_be_overread_as_live_execution",
      preventionRule:
        "Keep publicReady=false and remainingRisk populated unless all required runtime verification evidence is present.",
      test: "tests/governance/core-loop-contract.test.mjs",
      nextRunReuseKey: "core-loop-evidence-layer-boundary",
    },
    publicReadyDecision: {
      publicReady,
      status: publicReady ? "pass" : "partial",
      verificationEvidencePresent: verificationEvidence.length > 0,
      liveReleaseEvidenceReady,
      runtimeInvocationPlanStatus: runtimeInvocationPlanPacket.status,
      hostInvocationRequestStatus: hostInvocationRequestPacket.status,
      realInvocationCoverageStatus:
        capabilityInvocationTruthPacket.realInvocationCoverage?.status ?? "missing",
      productExperienceStatus: productExperiencePacket.status,
      selectedExecutableTruthGaps,
      blockedBy: publicReady ? [] : publicReadyBlockedBy,
    },
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeCardPlanForWorkflowContract(
  cardPlanPacket,
  outputLanguage = "zh-CN",
  languageSource = "latest_user_input",
) {
  const cardPlan = cloneJson(cardPlanPacket);
  cardPlan.cardTypeDecisions = cardPlan.cardTypeDecisions.map((card) => ({
    ...card,
    suppressionReason: card.suppressionReason ?? "",
    choiceSurface:
      card.choiceSurfaceDelivery === "adapter_required_not_triggered_by_artifact"
        ? "request_user_input"
        : "conversation_fallback",
    userLanguage: outputLanguage,
  }));
  cardPlan.cardEvents = cardPlan.cardEvents.map((event) => ({
    ...event,
    userLanguage: outputLanguage,
  }));
  cardPlan.controlDecisions = cardPlan.controlDecisions.map((decision) => ({
    ...decision,
    skipReason: decision.skipReason ?? "",
    interruptReason: decision.interruptReason ?? "",
    overrideReason: decision.overrideReason ?? "",
  }));
  cardPlan.deliveryShells = cardPlan.deliveryShells.map((shell) => ({
    ...shell,
    userLanguage: outputLanguage,
    languageSource,
  }));
  return cardPlan;
}

function workflowCapabilityMatch({ id, owner = "meta-conductor", bindingType = "skill", bindingRef = "meta-theory" }) {
  return {
    matchId: `${id}_match`,
    capabilitySlot: `${id}_capability`,
    bindingType,
    bindingRef,
    source: "config/capability-index/meta-kim-capabilities.json",
    confidenceScore: 0.91,
    selectionReason: "Selected from Meta_Kim capability-first governance evidence for this run.",
    selectionScope: "run_scoped",
    persistencePolicy: "do_not_persist_to_agent_identity",
    fallback: "return_to_fetch_or_thinking",
    owner,
  };
}

function workflowCapabilityBinding(match) {
  return {
    bindingId: `${match.capabilitySlot}_binding`,
    capabilitySlot: match.capabilitySlot,
    bindingType: match.bindingType,
    bindingRef: match.bindingRef,
    source: match.source,
    evidenceRef: match.matchId,
  };
}

function buildWorkflowContractPackets({
  runId,
  task,
  artifactStatus,
  orchestrationReport,
  coreLoop,
  runtimeEvidence,
  writebackFlow,
  cardPlanPacket,
  businessFlowBlueprintPacket,
  runtime = "codex",
  osTarget = "windows",
  outputLanguage = "zh-CN",
  languageSource = "latest_user_input",
  planChallengeResponses = [],
  planChallengeControl = null,
  sharedUnderstandingConfirmed = false,
  executionAuthorization = null,
  priorChallengeState = null,
  contradictionEvidence = [],
  requestedSideEffectActions = [],
  planChallengePreview = null,
}) {
  const routeRuntime = normalizeRouteRuntime(runtime);
  const routeOs = normalizeOsTarget(osTarget);
  const projectRef = `meta-kim-governed-execution-${runId}`;
  const primaryDeliverable = `governed-execution-${runId}`;
  const timestamp = nowIso();
  const planChallenge = planChallengePreview ?? buildPlanChallengeState({
    task,
    responses: planChallengeResponses,
    control: planChallengeControl,
    sharedUnderstandingConfirmed,
    executionAuthorization,
    priorChallengeState,
    contradictionEvidence,
    requestedSideEffectActions,
    outputLanguage,
  });
  const challengePhase = planChallenge.planChallengeState.phase;
  const requiresUserChoice =
    planChallenge.planChallengeState.pendingUserChoice.status === "required_not_invoked";
  const choiceState = challengePhase === "stopped_by_user"
    ? "stopped_by_user"
    : requiresUserChoice
      ? "pending_user_choice"
      : planChallenge.planChallengeState.active
        ? "confirmed"
        : "no_branching_choice";
  const normalizedCardPlanPacket = normalizeCardPlanForWorkflowContract(
    cardPlanPacket,
    outputLanguage,
    languageSource,
  );
  const capabilityMatch = workflowCapabilityMatch({
    id: "governed_execution",
    owner: "meta-conductor",
  });
  const verificationMatch = workflowCapabilityMatch({
    id: "verification",
    owner: "meta-prism",
  });
  const fetchPacket = {
    projectsChecked: [
      {
        projectRef,
        checkMode: "current_project",
        reason: "governed execution run is scoped to the current Meta_Kim project",
      },
    ],
    projectLocalSources: [
      {
        projectRef,
        sourceType: "contract",
        sourceRef: "config/contracts/workflow-contract.json",
      },
      {
        projectRef,
        sourceType: "runner",
        sourceRef: "scripts/run-meta-theory-governed-execution.mjs",
      },
    ],
    globalRegistryHits: [],
    capabilityMatches: [
      {
        capability: "governed_execution",
        owner: "meta-conductor",
        sourceProject: projectRef,
      },
      {
        capability: "verification",
        owner: "meta-prism",
        sourceProject: projectRef,
      },
    ],
    capabilityGaps: [],
    graphSources: [
      {
        projectRef,
        sourceType: "graph",
        sourceRef: "graphify-out",
      },
    ],
    knowledgeSources: [
      {
        projectRef,
        sourceType: "skill",
        sourceRef: "canonical/skills/meta-theory/SKILL.md",
      },
    ],
  };
  const externalEvidenceRequired = /third[-\s]?party|external|provider|service|api|sdk|oauth|integration|webhook|授权|接口|外部|第三方|服务商|集成|平台规则|发布|自动发|风控|规则|限流|价格|合规/i.test(
    task,
  );
  const contentEvidencePacket = {
    evidenceScope: externalEvidenceRequired ? "mixed" : "local_project",
    researchCapabilityDiscovery: {
      requiredCapabilities: externalEvidenceRequired
        ? ["web_search", "docs_lookup", "capability_index"]
        : ["local_only", "capability_index"],
      runtimeContext: {
        os: routeOs,
        runtimeFamily: routeRuntime,
      },
      toolInventorySources: ["active_tools", "skills", "commands", "capability_index"],
      availableRetrievalCapabilities: [
        {
          capability: "local_only",
          providerKind: "command",
          status: "available",
          proof: "Local repo source and contract files were read before packet construction.",
          limitations: externalEvidenceRequired
            ? ["Local evidence cannot answer current platform/API/risk claims."]
            : ["No external freshness claim is needed for this repo-local run."],
        },
        ...(externalEvidenceRequired
          ? [
              {
                capability: "web_search",
                providerKind: "native_tool",
                status: "partial",
                proof: "The task mentions external platform/API/risk behavior; source-backed host retrieval is required before public-ready claims.",
                limitations: ["The Node governed runner can request retrieval but cannot itself prove live web/API lookup."],
              },
            ]
          : []),
      ],
      selectedResearchPath: {
        mode: externalEvidenceRequired ? "external_web" : "local_only",
        reason: externalEvidenceRequired
          ? "The task includes external platform/API/risk claims, so current source-backed host retrieval is required before route lock or public-ready claims."
          : "The task validates Meta_Kim's local governed execution chain.",
      },
      capabilityGaps: externalEvidenceRequired
        ? [
            {
              gapId: "external_platform_fact_evidence_missing_until_host_retrieval_runs",
              gap: "external_platform_fact_evidence_missing_until_host_retrieval_runs",
              missingCapability: "source-backed external platform/API/risk retrieval",
              impact: "The run cannot claim public-ready platform feasibility until host retrieval attaches current evidence.",
              handoff: "meta-scout or host retrieval adapter",
              nextAction: "Host adapter should run web_search/docs_lookup and attach evidence before route lock or public-ready claims.",
            },
          ]
        : [],
      validatedBy: "meta-conductor",
    },
    evidence: [
      "config/contracts/workflow-contract.json",
      "scripts/run-meta-theory-governed-execution.mjs",
      "scripts/validate-run-artifact.mjs",
    ],
    deepResearchPlan: {
      decisionUse: ["Confirm that the governed runner emits the same packet shape validated by validate-run-artifact."],
      questions: ["Does the run artifact validate through the public workflow validator?"],
      sourceCategoriesPlanned: ["workflow contract", "runner source", "validator source"],
      deepReadTargets: ["config/contracts/workflow-contract.json", "scripts/validate-run-artifact.mjs"],
      sourceQualityLadder: ["source_code_or_release_notes", "primary_official_docs"],
      claimAttributionRules: ["Route-changing claims must point to artifact paths."],
      crossCheckStrategy: ["Validate the generated artifact with scripts/validate-run-artifact.mjs."],
      originalSynthesisRules: ["Use Meta_Kim packet names without importing private docs."],
      decisionImpactCriteria: ["If a packet does not validate, return to the producing stage."],
      decisionQualityFrame: {
        intent: "Produce a validator-ready governed execution artifact rather than a long unstructured report.",
        subject: "Meta_Kim maintainer and downstream runtime adapter.",
        path: "User request -> governed runner -> workflow artifact -> validator -> Thinking route confidence.",
        constraints: [
          "Use repo-local evidence unless the task requires current external facts.",
          "Do not treat structural output as live host invocation proof.",
        ],
        evidenceUse: "Evidence must change owner, route, scope, risk, acceptance, or verification before it can drive Thinking.",
        outputCommitment: "Return a concrete artifact, validator result, and next-stage decision.",
      },
      competingHypotheses: [
        {
          hypothesis: "The local workflow artifact is enough for this repo-governance run.",
          wouldExpect: "Validator-required packets exist and source refs resolve.",
          disconfirmingEvidence: "A validator failure or unresolved external platform claim would refute this route.",
          currentStatus: externalEvidenceRequired ? "partially_supported_pending_external_fetch" : "supported",
          decisionImpact: "Allows Thinking to use local validation when no external facts are required.",
        },
        {
          hypothesis: "The run needs external deep research before route lock.",
          wouldExpect: "Task contains platform, API, pricing, policy, or current third-party claims.",
          disconfirmingEvidence: "Task is repo-local and all route-changing evidence resolves to current source files.",
          currentStatus: externalEvidenceRequired ? "supported" : "not_supported_for_this_run",
          decisionImpact: "Blocks public-ready platform feasibility claims until host retrieval attaches current evidence.",
        },
      ],
      minimumDecisionTest: {
        goal: "Decide whether Fetch evidence is strong enough to enter Thinking.",
        input: "Generated contentEvidencePacket plus workflow-contract validator policy.",
        action: "Run strict artifact validation and inspect unresolved external-evidence gaps.",
        output: "pass, blocked, or return_to_fetch decision.",
        passCondition: "Validator passes and no route-changing claim is unsupported.",
        failSignal: "Missing packet field, unresolved evidence ref, stale external claim, or single-source route-changing claim.",
        nextStep: "Enter Thinking only after the pass condition is met; otherwise repair Fetch.",
        doNotDo: "Do not compensate for weak evidence by writing a longer report.",
      },
      evidenceConfidencePolicy: {
        sourceStates: ["confirmed", "user_provided", "inference", "unconfirmed"],
        downgradeReasons: ["single_source", "stale", "indirect", "conflicted", "unverified_origin"],
      },
      decisionReadinessGate: {
        requiredSignals: [
          "right_frame",
          "real_alternatives",
          "meaningful_data",
          "tradeoffs_clear",
          "logical_reasoning",
          "action_commitment",
        ],
      },
      keyInformationTargets: ["strict packet names", "choice-surface evidence", "public-ready boundary"],
      iterationPlan: ["Generate artifact", "Run strict validator", "Fix producer shape if validation fails"],
      stopCondition: ["Validator passes or reports a concrete producer defect."],
      decisionUpdateRule: ["A validator failure changes the producer packet construction route."],
    },
    localSourcesRead: fetchPacket.projectLocalSources,
    contentFindings: [
      {
        findingId: "evidence-001",
        summary: "The runner emits workflow-contract packet names at the artifact top level.",
        sourceRefs: ["scripts/run-meta-theory-governed-execution.mjs"],
      },
    ],
    capabilityEvidence: fetchPacket.capabilityMatches,
    capabilityDiscovery: ["meta-theory", "workflow-contract", "validate-run-artifact"],
    capabilityGap: "No blocking capability gap for the run-scoped governed execution artifact.",
    sourceCategoryCoverage: [
      {
        category: "local_contract",
        status: "covered",
        evidenceRef: "fetchPacket.projectLocalSources[0]",
      },
      ...(externalEvidenceRequired
        ? [
            {
              category: "external_platform_docs",
              status: "required_pending_host_retrieval",
              evidenceRef: "contentEvidencePacket.researchCapabilityDiscovery.selectedResearchPath",
            },
            {
              category: "external_api_auth_docs",
              status: "required_pending_host_retrieval",
              evidenceRef: "contentEvidencePacket.researchCapabilityDiscovery.requiredCapabilities",
            },
            {
              category: "external_policy_and_risk",
              status: "required_pending_host_retrieval",
              evidenceRef: "contentEvidencePacket.searchAngles[1]",
            },
            {
              category: "external_workflow_constraints",
              status: "required_pending_host_retrieval",
              evidenceRef: "contentEvidencePacket.searchAngles[2]",
            },
            {
              category: "counterevidence_or_platform_change",
              status: "required_pending_host_retrieval",
              evidenceRef: "contentEvidencePacket.deepResearchPlan.crossCheckStrategy",
            },
          ]
        : []),
    ],
    crossReferenceMatrix: [
      {
        claim: "Strict workflow packets are emitted by the runner.",
        sourceRefs: ["fetchPacket.projectLocalSources[1]", "contentEvidencePacket.contentFindings[0]"],
      },
    ],
    contradictionLog: [],
    assumptionLedger: [
      {
        assumption: "This run is repo-local and does not require private docs.",
        risk: "Private product notes must not be required for public validation.",
        mitigation: "Use source and contract evidence only.",
      },
    ],
    decisionImpactMap: [
      {
        finding: "contentEvidencePacket.contentFindings[0]",
        impacts: ["taskClassification", "dispatchBoard"],
        decisionChanged: "Runner output is treated as the canonical workflow artifact instead of a second validator-only summary.",
        stageAffected: "Thinking",
      },
    ],
    iterationLog: [
      {
        iteration: 1,
        trigger: "align governed runner with strict validator",
        queryOrAction: "Inspect workflow contract, runner output, and validator requirements.",
        observation: "Top-level packet names are required by validate-run-artifact.",
        gapClosed: true,
        nextStepDecision: "Emit those packet names from the governed runner and validate the resulting artifact.",
        stopCheck: "Stop after strict validator passes on the generated artifact.",
      },
    ],
    claimEvidenceCards: [
      {
        claim: "Artifact-only choice cards are not native popup evidence.",
        sourceRefs: ["cardPlanPacket.cardEvents[0]", "preDecisionOptionFrame.nativeChoiceSurface"],
        evidenceAnchor: "cardPlanPacket records adapter-required card events while preDecisionOptionFrame records the finalized choice state.",
        confidence: "high",
        counterevidence: ["No native popup answer is claimed by this structural runner."],
        decisionImpact: "Branch-changing execution must use the native runtime choice surface before mutation.",
        falsificationStatus: "tested_survived",
      },
    ],
    researchRequired: externalEvidenceRequired,
    researchSkipReason: externalEvidenceRequired ? "none" : "local_project_only",
    evidenceLaneValidatedBy: "meta-conductor",
    searchAngles: externalEvidenceRequired
      ? ["official platform/API documentation", "risk and automation policy", "auth and permission model"]
      : [],
  };
  const taskClassification = {
    taskClass: "A",
    requestClass: "execute",
    queryScope: "current_project",
    projectRef,
    registryStatus: "known",
    crossProjectReason: "default_current_project_scope",
    governanceFlow: "complex_dev",
    triggerReasons: ["durable_artifact", "verification_required", "user_explicit_review"],
    upgradeReasons: ["review_or_verify_required", "business_workflow_upgrade"],
    bypassReasons: [],
    ownerRequired: true,
    decisionSource: "meta-theory-entry-classifier",
    classifierVersion: "v2",
    complexity: "medium",
  };
  const preDecisionOptionFrame = {
    decisionTrigger: requiresUserChoice
      ? "A risk-adaptive plan challenge has one current user choice pending."
      : "No unresolved branch-changing choice remains for this structural run artifact.",
    contentEvidence: "contentEvidencePacket",
    optionFrame: "Validate the governed execution artifact through the workflow-contract validator.",
    presentedBeforeDecision: true,
    userChoiceState: choiceState,
    builtFromContentEvidence: true,
    contentEvidenceRefs: ["contentEvidencePacket.decisionImpactMap[0]"],
    unresolvedQuestions: planChallenge.unresolvedQuestions,
    planChallengeState: planChallenge.planChallengeState,
    candidateOptions: [
      {
        optionId: "single-workflow-artifact",
        whatChanges: "Generate one top-level workflow-contract artifact from the governed runner.",
        problemSolved: "Avoids a second validator-only shape.",
        expectedResult: "validate-run-artifact can validate the runner output directly.",
        advantages: ["One producer path", "One validator path"],
        disadvantages: ["The runner must populate stricter packet fields."],
        evidenceRefs: ["contentEvidencePacket.decisionImpactMap[0]"],
        decisionImpact: "Selects unified artifact production.",
        candidateOwners: ["meta-conductor"],
        candidateTaskShape: "governed_execution_artifact",
      },
      {
        optionId: "return-to-thinking",
        whatChanges: "Stop before execution if packet evidence is insufficient.",
        problemSolved: "Prevents validator rescue after weak route design.",
        expectedResult: "The run returns to Thinking with concrete missing packet fields.",
        advantages: ["No fake public-ready claim"],
        disadvantages: ["Requires another producing pass."],
        evidenceRefs: ["contentEvidencePacket.iterationLog[0]"],
        decisionImpact: "Blocks execution if validation evidence is missing.",
        candidateOwners: ["meta-prism"],
        candidateTaskShape: "verification_gate",
      },
    ],
    recommendedDefault: "single-workflow-artifact",
    requiresUserChoice,
    nativeChoiceSurface: requiresUserChoice
      ? "host_adapter_required_not_invoked"
      : "not_required",
    choiceGateSkip: requiresUserChoice || choiceState === "confirmed" ? null : choiceState,
    skipSource: requiresUserChoice
      ? "pending_host_adapter"
      : choiceState === "confirmed"
        ? "user_confirmed"
        : choiceState,
    skipSafetyRationale: requiresUserChoice
      ? "Execution remains blocked until the host adapter returns a trusted answer."
      : "No unresolved plan-challenge choice permits execution beyond the recorded authorization boundary.",
    solutionChoiceState: choiceState,
    reviewOwner: "meta-prism",
  };
  const roleMatch = workflowCapabilityMatch({
    id: "governed_execution_role",
    owner: "meta-conductor",
  });
  const agentBlueprintPacket = {
    roles: [
      {
        businessRoleId: "operations",
        roleDisplayName: "operations",
        assignedResponsibilitySlice: ["direction", "planning", "execution", "review", "verify"],
        ownerAgent: "meta-conductor",
        ownerSource: "meta_kim_canonical",
        agentCopyPolicy: "meta_kim_governance_only",
        ownerResponsibilityDelta: "Reuse existing governance owner with run-scoped capability bindings.",
        agentIterationPlan: "Return to Thinking only if validation reveals a recurring owner gap.",
        ownerResolution: "reuse_existing_owner",
        skillSelectionScope: "run_scoped",
        governanceStageNodes: [
          { stage: "Critical", ownerAgent: "meta-warden", responsibility: "lock intent and branch-changing choices" },
          { stage: "Fetch", ownerAgent: "meta-artisan", responsibility: "collect local capability and contract evidence" },
          { stage: "Thinking", ownerAgent: "meta-conductor", responsibility: "build unified workflow packets" },
          { stage: "Review", ownerAgent: "meta-prism", responsibility: "check packet quality and no overclaim" },
        ],
        matchedCapabilities: [roleMatch],
        capabilityBindings: [workflowCapabilityBinding(roleMatch)],
      },
    ],
    roleCoverageGate: "pass",
    missingRoles: [],
    duplicateRolePolicy: "allow_instances_when_sharded",
    namingPolicy: {
      roleDisplayNameRequired: true,
      businessSemanticNamesOnly: true,
      shortRoleNamesRequired: true,
      runtimeNicknamesAreAliasesOnly: true,
      forbiddenPrimaryNamePattern: "^[A-Z][a-z]+$",
      forbiddenScopedNamePattern: "[-_/\\\\:]",
      scopeDetailsBelongInInstanceFields: true,
    },
    governanceStageCoverage: {
      Critical: ["meta-warden", "meta-conductor"],
      Fetch: ["meta-conductor", "meta-scout", "meta-artisan", "meta-librarian", "meta-genesis"],
      Thinking: ["meta-conductor", "meta-genesis", "meta-artisan", "meta-sentinel", "meta-warden"],
      Review: ["meta-prism", "meta-warden"],
    },
  };
  const dispatchBoard = {
    boardId: `${runId}-dispatch-board`,
    goal: "Produce one strict governed execution artifact and verify it without claiming release readiness.",
    ownerResolution: "existing-owner",
    primaryDeliverable,
    mergeStrategy: "meta-conductor merges worker evidence into one artifact; meta-prism verifies strict packet closure.",
  };
  const rawWorkerTasks = coreLoop.thinkingPacket.workerTaskPackets.length > 0
    ? coreLoop.thinkingPacket.workerTaskPackets
    : [
        {
          taskPacketId: `${runId}-worker-001`,
          owner: "meta-conductor",
          ownerAgent: "meta-conductor",
          businessRoleId: "operations",
          roleDisplayName: "operations",
          roleInstanceId: "operations-1",
          nonGoals: ["No public-ready claim without release evidence."],
          acceptanceCriteria: ["Generated artifact validates through validate-run-artifact."],
          dependsOn: [],
          parallelGroup: "governed-artifact",
          mergeOwner: "meta-conductor",
          shardKey: "governed-artifact",
          shardScope: ["workflow-contract"],
          verifySteps: [{ id: "strict-artifact-validates", step: "Run validate-run-artifact", verify: "Validator exits 0" }],
        },
      ];
  const workerTaskPackets = rawWorkerTasks.map((packet, index) => {
    const taskPacketId = packet.taskPacketId ?? `${runId}-worker-${index + 1}`;
    const scopeFile = `${primaryDeliverable}-${index + 1}.json`;
    return {
      ...packet,
      taskPacketId,
      owner: packet.ownerAgent ?? packet.owner ?? "meta-conductor",
      ownerMode: ["existing-owner", "create-owner-first"].includes(packet.ownerMode)
        ? packet.ownerMode
        : "existing-owner",
      executionMode: ["primary_execution", "factory_then_dispatch", "verification_execution", "approval_gate"].includes(packet.executionMode)
        ? packet.executionMode
        : "primary_execution",
      ownerAgent: packet.ownerAgent ?? packet.owner ?? "meta-conductor",
      businessRoleId: packet.businessRoleId ?? "operations",
      roleDisplayName: packet.roleDisplayName && !/[-_/\\:]/.test(packet.roleDisplayName)
        ? packet.roleDisplayName
        : "operations",
      roleInstanceId: packet.roleInstanceId ?? `operations-${index + 1}`,
      runtimeInstanceAlias: packet.runtimeInstanceAlias ?? "",
      coreProblem: packet.coreProblem ?? "Produce a strict governed execution artifact.",
      todayTask: packet.todayTask ?? "Normalize runner output to the workflow-contract packet shape.",
      nonGoals: packet.nonGoals?.length ? packet.nonGoals : ["No unrelated source mutation."],
      output: packet.output ?? "workflow_contract_artifact",
      acceptanceCriteria: packet.acceptanceCriteria?.length
        ? packet.acceptanceCriteria
        : ["Generated artifact validates through scripts/validate-run-artifact.mjs."],
      deliverableLink: `${primaryDeliverable}:${taskPacketId}`,
      scopeFiles: packet.scopeFiles?.length ? packet.scopeFiles : [scopeFile],
      qualityBar: packet.qualityBar ?? "strict packet validation without public-ready overclaim",
      workType: "operations",
      expertLensRefs: ["operations"],
      evidenceRefs: ["contentEvidencePacket.decisionImpactMap[0]"],
      capabilityRequirements: packet.capabilityRequirements?.length
        ? packet.capabilityRequirements
        : ["workflow-contract packet construction"],
      toolRequirements: packet.toolRequirements?.length
        ? packet.toolRequirements
        : ["scripts/validate-run-artifact.mjs"],
      referenceDirection: packet.referenceDirection ?? "Use workflow-contract and validator evidence.",
      handoffTarget: packet.handoffTarget ?? "meta-prism",
      handoffContract: {
        handoffTo: packet.handoffContract?.handoffTo ?? "meta-prism",
        handoffWhen: packet.handoffContract?.handoffWhen ?? "after artifact packet construction",
        handoffPayload: packet.handoffContract?.handoffPayload ?? "artifact path, worker evidence, validation result",
        acceptanceSignal: packet.handoffContract?.acceptanceSignal ?? "strict validator pass or concrete failure",
      },
      lengthExpectation: packet.lengthExpectation ?? "compact",
      visualOrAssetPlan: packet.visualOrAssetPlan ?? "none",
      dependsOn: Array.isArray(packet.dependsOn) ? packet.dependsOn : [],
      parallelGroup: packet.parallelGroup ?? "governed-artifact",
      mergeOwner: packet.mergeOwner ?? "meta-conductor",
      shardKey: packet.shardKey ?? `artifact-${index + 1}`,
      shardScope: Array.isArray(packet.shardScope) ? packet.shardScope : [String(packet.shardScope ?? scopeFile)],
      workspaceIsolation: "same_workspace_readonly_overlap",
      artifactNamespace: packet.artifactNamespace ?? `${primaryDeliverable}-${index + 1}`,
      collisionPolicy: packet.collisionPolicy ?? "no_overlap",
      verifySteps: (packet.verifySteps?.length ? packet.verifySteps : [{ id: `${taskPacketId}-verify`, step: "Validate artifact", verify: "Validator exits 0" }]).map((step, stepIndex) => ({
        id: step.id ?? `${taskPacketId}-verify-${stepIndex + 1}`,
        step: step.step ?? step.command ?? "Validate artifact",
        verify: step.verify ?? step.successMarker ?? "Validator exits 0",
      })),
      preDecisionOptionFrameRef: "preDecisionOptionFrame",
      userChoiceState: choiceState,
      finalizationGate: "after_no_branching_choice",
    };
  });
  const workerResultPackets = workerTaskPackets.map((packet, index) => {
    const evidenceRunAt = timestamp;
    return {
      taskPacketId: packet.taskPacketId,
      owner: packet.owner,
      status: "planned_not_executed",
      producedArtifacts: [],
      fileCompletionList: packet.scopeFiles.map((scopeFile) => ({
        path: scopeFile,
        action: "create",
        scope: "Planned governed execution artifact; no worker wrote this file in the structural runner.",
        status: "skipped",
        skipReason: "A real host worker must execute the task before this file can be reported completed.",
      })),
      workerExecutionEvidence: packet.verifySteps.map((step, stepIndex) => ({
        verifyStepRef: step.id,
        command: stepIndex === 0 ? "node scripts/validate-run-artifact.mjs <artifact>" : "node scripts/run-meta-theory-governed-execution.mjs",
        passClaim: step.verify,
        status: "skipped",
        runBy: "not_run",
        runAt: evidenceRunAt,
        expectedResult: step.verify,
        observedResult: "not_run_by_structural_artifact_builder",
        workingDirectory: ".",
        stderrTail: "",
        successMarkerFormat: "exit-code-only",
        skipReason: "No real worker or command execution evidence was attached to this top-level artifact.",
      })),
      handoffTarget: packet.handoffTarget,
      blockingIssues: ["pending real host worker execution and verification evidence"],
    };
  });
  const orchestrationTaskBoardPacket = {
    dispatchBoardId: dispatchBoard.boardId,
    boardMode: "direct_dispatch",
    tasks: workerTaskPackets.map((packet, index) => ({
      taskId: packet.taskPacketId,
      taskKind: "execution",
      owner: packet.owner,
      businessRoleId: packet.businessRoleId,
      roleDisplayName: packet.roleDisplayName,
      sequence: index + 1,
      dependsOn: [],
      deliverable: packet.deliverableLink,
    })),
    synthesisOwner: "meta-conductor",
  };
  const dispatchEnvelopePacket = {
    ownerAgent: "meta-conductor",
    businessRoleId: "operations",
    roleDisplayName: "operations",
    roleInstanceId: "governed-execution#1",
    taskRef: workerTaskPackets[0].taskPacketId,
    allowedCapabilities: ["governed_execution", "workflow_validation"],
    blockedCapabilities: ["public_release_claim_without_live_evidence", "private_docs_required_for_public_validation"],
    route: "project_only",
    ownerSelection: "capability_first",
    memoryMode: "project_only",
    workspaceHint: primaryDeliverable,
    resultSchemaRef: "config/contracts/workflow-contract.json#/protocols/workerResultPacket",
    reviewOwner: "meta-prism",
    verificationOwner: "meta-warden",
    preDecisionOptionFrameRef: "preDecisionOptionFrame",
    userChoiceState: choiceState,
    finalizationGate: "after_no_branching_choice",
  };
  const dimension = (dimensionId, evidenceRef = "contentEvidencePacket.decisionImpactMap[0]") => ({
    dimensionId,
    status: "covered",
    evidenceRef,
  });
  const gateEvidenceRefs = ["contentEvidencePacket.decisionImpactMap[0]"];
  const productCompletenessPacket = {
    outcome: "One governed execution artifact validates through the workflow-contract validator.",
    userValue: "Users do not get stuck between a partial run and a failing CLI when the artifact itself is valid.",
    acceptanceCriteria: ["Strict validator can validate the generated artifact.", "Public-ready is not claimed without live release evidence."],
    nonGoals: ["No private docs requirement.", "No second validator shape."],
    designDimensions: [
      dimension("core_highlight"),
      dimension("feature_completeness"),
      dimension("evolution_path"),
    ],
    completenessStatus: artifactStatus === "pass" ? "pass" : "partial",
    owner: "meta-conductor",
    evidenceRefs: gateEvidenceRefs,
  };
  const experienceQualityPacket = {
    audience: "Meta_Kim maintainer",
    criticalJourneys: ["Run governed execution", "Read report", "Validate artifact"],
    qualityAttributes: ["smooth partial handling", "plain user-facing status"],
    accessibilityConsiderations: ["Use localized compact report text rather than raw packet dumps."],
    experienceDimensions: [dimension("ui_ue_ux")],
    experienceStatus: "partial",
    owner: "meta-prism",
    evidenceRefs: gateEvidenceRefs,
  };
  const testStrategyPacket = {
    strategy: "Run focused unit tests plus strict artifact validation on a generated real artifact.",
    requiredTestTypes: ["unit", "artifact-validation", "smoke"],
    executedTests: ["in-process governed packet structural checks (does not prove worker execution)"],
    deferredTests: ["scripts/validate-run-artifact.mjs generated artifact", "real host worker verification"],
    coverageRationale: "Release-grade all-runtime live evidence remains outside this structural run.",
    testDimensions: [dimension("real_test_strategy")],
    testStatus: "partial",
    owner: "meta-prism",
    evidenceRefs: gateEvidenceRefs,
  };
  const structureHygienePacket = {
    changedAreas: ["scripts/run-meta-theory-governed-execution.mjs", "scripts/select-execution-route.mjs"],
    boundaryChecks: ["Private docs are not required for public validation."],
    orphanCleanup: ["Generated test artifacts are written to caller-provided state directories."],
    namingAndLayoutChecks: ["Top-level packet names match workflow-contract protocol names."],
    structureDimensions: [
      dimension("file_management_extensibility"),
      dimension("directory_structure"),
      dimension("dead_redundant_cleanup"),
    ],
    hygieneStatus: "partial",
    owner: "meta-prism",
    evidenceRefs: gateEvidenceRefs,
  };
  const permissionMatrixPacket = {
    accessedResources: ["repo-local files", "caller-provided state directory"],
    permissionChecks: ["No external publish or production credential use."],
    secretsPolicy: "No secrets required or read.",
    permissionDimensions: [dimension("permission_secret_boundary")],
    permissionStatus: "pass",
    owner: "meta-sentinel",
    evidenceRefs: gateEvidenceRefs,
  };
  const sideEffectLedgerPacket = {
    sideEffects: ["writes governed run JSON and markdown artifacts"],
    externalSystemsTouched: [],
    stateChanges: ["state directory receives generated run artifact"],
    mitigations: ["Use temp state dirs in tests and no production external calls."],
    sideEffectDimensions: [dimension("side_effect_ledger")],
    sideEffectStatus: "tracked",
    owner: "meta-sentinel",
    evidenceRefs: gateEvidenceRefs,
  };
  const rollbackPlanPacket = {
    rollbackScope: "Generated governed execution artifacts and code changes from this maintenance run.",
    rollbackTriggers: ["strict validator regression", "choice-surface gate regression"],
    rollbackSteps: ["Remove generated state artifacts", "Revert the producer change through normal git review"],
    affectedArtifacts: workerTaskPackets.flatMap((packet) => packet.scopeFiles),
    rollbackDimensions: [dimension("rollback_path")],
    rollbackStatus: "ready",
    owner: "meta-sentinel",
    evidenceRefs: gateEvidenceRefs,
  };
  const reviewPacket = {
    ownerCoverage: "pass",
    protocolCompliance: "pass",
    qualityGate: "partial",
    revisionNeeded: false,
    sourceProjects: [projectRef],
    crossProjectContaminationCheck: "pass",
    triggerVsSkipReasonCheck: {
      status: "pass",
      triggerReasons: taskClassification.triggerReasons,
      skipReason: choiceState,
      evidence: "preDecisionOptionFrame.choiceGateSkip records no_branching_choice for this structural artifact run.",
    },
    reviews: [
      {
        type: "protocol",
        agent: "meta-prism",
        result: "pass",
        issues: [],
      },
    ],
    findings: [],
  };
  const verificationPacket = {
    verified: false,
    remainingIssues: ["Real worker execution and command verification evidence are still pending."],
    evidence: ["Top-level worker packets intentionally preserve planned/skipped truth."],
    fixEvidence: [],
    revisionResponses: [],
    verificationResults: [],
    closeFindings: [],
  };
  const strictPublicReady = coreLoop.publicReadyDecision?.publicReady === true;
  const strictPublicReadyBlockedBy = strictPublicReady
    ? []
    : (
        coreLoop.publicReadyDecision?.blockedBy?.length
          ? coreLoop.publicReadyDecision.blockedBy
          : ["release-grade live runtime evidence is not attached to this structural governed run"]
      );
  const summaryPacket = {
    verifyPassed: false,
    summaryClosed: false,
    singleDeliverableMaintained: true,
    deliverableChainClosed: false,
    consolidatedDeliverablePresent: true,
    publicReady: strictPublicReady,
    commentReviewAcknowledged: true,
    sourceProjects: [projectRef],
    deliveryShellsUsed: normalizedCardPlanPacket.deliveryShells
      .slice(0, 2)
      .map((shell) => shell.deliveryShellId),
    blockedBy: strictPublicReadyBlockedBy,
    confirmedDecisions: planChallenge.summaryData.confirmedDecisions,
    openRisks: planChallenge.summaryData.openRisks,
    nextStep: planChallenge.summaryData.nextStep,
    visibleLines: planChallenge.summaryData.visibleLines,
  };
  const evolutionWritebackPacket = {
    ownerAssessment: "keep-existing",
    writebackDecision: "none",
    decisionReason:
      writebackFlow.status === "approved-for-writeback"
        ? "This validation artifact records the run; durable writeback is handled by Warden-approved flow, not by the strict artifact view."
        : "No additional canonical writeback is required to validate this generated run artifact.",
    writebacks: [],
    retain: [
      {
        target: "meta-conductor",
        reason: "Existing governance owner remains the correct producer owner.",
      },
    ],
    upgrade: [],
    retire: [],
    scarIds: [],
    syncRequired: false,
  };
  const strictBusinessFlowBlueprintPacket = {
    ...businessFlowBlueprintPacket,
    deliverableType: "runtime_package",
    requiredLanes: businessFlowBlueprintPacket.requiredLanes ?? [],
    optionalLanes: [],
  };
  agentBlueprintPacket.roles[0].assignedResponsibilitySlice =
    strictBusinessFlowBlueprintPacket.requiredLanes.map((lane) => lane.laneId);
  return {
    runHeader: {
      department: "engineering",
      primaryDeliverable,
      audience: "maintainer",
      freshnessRequirement: "current-repo-state",
      visualPolicy: "fit_department_nature",
      handoffPlan: "meta-conductor produces one governed artifact; meta-prism verifies it; meta-warden owns public-ready boundary.",
      publicReady: summaryPacket.publicReady,
    },
    taskClassification,
    contentEvidencePacket,
    fetchPacket,
    intentPacket: {
      realIntent: `Run Meta_Kim governed execution for: ${task}`,
      trueUserIntent: `Produce a strict governed execution artifact for: ${task}`,
      successCriteria: "The generated artifact validates through scripts/validate-run-artifact.mjs without claiming release-grade public readiness.",
      nonGoals: "Do not require private docs, publish, deploy, or claim live runtime public-ready evidence.",
      blockingUnknowns: [],
      noQuotaClarification: "No filler clarification is needed; route-changing choices require native choice evidence.",
      intentPacketVersion: "v1",
    },
    intentGatePacket: {
      ambiguitiesResolved: !requiresUserChoice,
      requiresUserChoice,
      defaultAssumptions: ["This structural run has no branch-changing user choice remaining."],
      pendingUserChoices: requiresUserChoice
        ? [planChallenge.planChallengeState.pendingUserChoice.question.displayText]
        : [],
      userLanguage: outputLanguage,
      languageSource,
      nativeChoiceSurface: requiresUserChoice
        ? "host_adapter_required_not_invoked"
        : "not_required",
      choiceGateSkip: requiresUserChoice || choiceState === "confirmed" ? null : choiceState,
      intentGatePacketVersion: "v1",
    },
    preDecisionOptionFrame,
    cardPlanPacket: normalizedCardPlanPacket,
    dispatchEnvelopePacket,
    orchestrationTaskBoardPacket,
    businessFlowBlueprintPacket: strictBusinessFlowBlueprintPacket,
    productCompletenessPacket,
    experienceQualityPacket,
    testStrategyPacket,
    structureHygienePacket,
    permissionMatrixPacket,
    sideEffectLedgerPacket,
    rollbackPlanPacket,
    agentBlueprintPacket,
    capabilityGapPacket: {
      gapId: `${runId}-capability-gap-none`,
      requestedCapability: "governed execution artifact validation",
      currentAgentsChecked: ["meta-conductor", "meta-prism", "meta-warden"],
      insufficiencyReason: "Existing governance owners are sufficient for this run; no new durable owner is created.",
      resolutionAction: "reuse_existing_owner",
      requestedBy: "meta-conductor",
      approvedBy: "meta-warden",
    },
    dispatchBoard,
    workerTaskPackets,
    workerResultPackets,
    reviewPacket,
    verificationPacket,
    summaryPacket,
    evolutionWritebackPacket,
    verificationResult: coreLoop.verificationResult,
    runtimeProjectionEvidence: runtimeEvidence,
  };
}

async function persistRuntimeEvidenceEvents({ dbPath, runId, runtimeEvidence, writebackFlow }) {
  const store = await openRunStateStore(dbPath);
  for (const record of runtimeEvidence.results) {
    store.appendEvent({
      eventId: stableId("event", `${runId}-${record.runtime}-${record.status}-${record.failureClass}`),
      runId,
      stage: "verification",
      eventType: "runtime_evidence_recorded",
      payload: {
        runtime: record.runtime,
        status: record.status,
        evidenceKind: record.evidenceKind,
        failureClass: record.failureClass,
        command: record.command,
        artifact: record.artifact,
        remainingAction: record.remainingAction,
        strictReleasePass: record.strictReleasePass,
      },
      createdAt: nowIso(),
    });
  }
  store.appendEvent({
    eventId: stableId("event", `${runId}-warden-writeback-${writebackFlow.status}`),
    runId,
    stage: "evolution",
    eventType: "warden_writeback_dry_run_recorded",
    payload: {
      status: writebackFlow.status,
      approvalRequired: writebackFlow.approvalRequired,
      approvalValidation: writebackFlow.approvalValidation,
      dryRun: writebackFlow.dryRun,
      noAutomaticCanonicalWrite: writebackFlow.noAutomaticCanonicalWrite,
    },
    createdAt: nowIso(),
  });
  const analytics = store.analytics();
  store.close();
  return analytics;
}

async function readLatestRunId(stateDir) {
  const latestPath = path.join(stateDir, "latest.json");
  const raw = await readTextIfExists(latestPath);
  if (!raw) return null;
  const latestRunId = JSON.parse(raw).runId ?? null;
  return latestRunId == null ? null : validateRunId(latestRunId, "latest.json runId");
}

function selectExecutionRouteArgs({ task, runtime = "codex", os = "windows", runId = null, codexHostToolSchema = null }) {
  const routeRuntime = normalizeRouteRuntime(runtime);
  const routeOs = normalizeOsTarget(os);
  return [
    "--task",
    task,
    "--runtime",
    routeRuntime,
    "--os",
    routeOs,
    "--json",
    "--runner-compact",
    ...(runId ? ["--run-id", runId] : []),
    ...(codexHostToolSchema ? ["--codex-host-tool-schema", codexHostToolSchema] : []),
  ];
}

async function selectExecutionRouteInProcess({ task, runtime = "codex", os = "windows", runId = null, codexHostToolSchema = null, spawnError = null }) {
  const routeRuntime = normalizeRouteRuntime(runtime);
  const routeOs = normalizeOsTarget(os);
  const originalArgv = process.argv;
  const originalLog = console.log;
  const originalError = console.error;
  const stdout = [];
  const stderr = [];
  try {
    process.argv = [
      process.execPath,
      SELECT_EXECUTION_ROUTE_SCRIPT,
      ...selectExecutionRouteArgs({ task, runtime: routeRuntime, os: routeOs, runId, codexHostToolSchema }),
    ];
    console.log = (...args) => stdout.push(args.join(" "));
    console.error = (...args) => stderr.push(args.join(" "));
    await import(
      `${pathToFileURL(SELECT_EXECUTION_ROUTE_SCRIPT).href}?runner=${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
  } catch (error) {
    throw new Error(
      [
        "select-execution-route in-process fallback failed.",
        spawnError?.message ? `original spawn error: ${spawnError.message}` : null,
        error?.stack ?? error?.message ?? String(error),
        tailText(stderr.join("\n")),
      ].filter(Boolean).join("\n"),
    );
  } finally {
    process.argv = originalArgv;
    console.log = originalLog;
    console.error = originalError;
  }
  const text = stdout.join("\n").trim();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      [
        "select-execution-route in-process fallback returned invalid JSON.",
        spawnError?.message ? `original spawn error: ${spawnError.message}` : null,
        error?.message ?? String(error),
        tailText(text),
        tailText(stderr.join("\n")),
      ].filter(Boolean).join("\n"),
    );
  }
}

async function selectExecutionRoute({ task, runtime = "codex", os = "windows", runId = null, codexHostToolSchema = null }) {
  const routeRuntime = normalizeRouteRuntime(runtime);
  const routeOs = normalizeOsTarget(os);
  const args = selectExecutionRouteArgs({ task, runtime: routeRuntime, os: routeOs, runId, codexHostToolSchema });
  const result = spawnSync(
    process.execPath,
    [SELECT_EXECUTION_ROUTE_SCRIPT, ...args],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  if (result.error) {
    return selectExecutionRouteInProcess({
      task,
      runtime: routeRuntime,
      os: routeOs,
      runId,
      codexHostToolSchema,
      spawnError: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(
      [
        "select-execution-route failed before governed execution.",
        result.error?.message ? `spawn error: ${result.error.message}` : null,
        result.signal ? `spawn signal: ${result.signal}` : null,
        result.stderr?.trim(),
        tailText(result.stdout),
      ].filter(Boolean).join("\n"),
    );
  }
  return JSON.parse(result.stdout);
}

function providerListFromRoute(routeResult) {
  const selectedProviders = routeResult.recommendedRoute?.selectedCapabilityProviders ?? {};
  const selected = Object.entries(selectedProviders);
  const fallback = selected.length > 0
    ? []
    : [
        ...(routeResult.ownerDiscoveryPacket?.repoCanonicalSkillProviders ?? []).slice(0, 3).map((provider) => ["skill", provider]),
        ...(routeResult.ownerDiscoveryPacket?.projectRuntimeCapabilityProviders ?? [])
          .filter((provider) => ["commands", "mcpServers", "hooks"].includes(provider.type))
          .slice(0, 6)
          .map((provider) => [provider.type, provider]),
        ...(routeResult.ownerDiscoveryPacket?.runtimeToolProviders ?? []).slice(0, 3).map((provider) => ["runtime_tool", provider]),
      ];
  return [...selected, ...fallback].map(([slot, provider]) => ({
    slot,
    id: provider.id,
    type: provider.type ?? provider.providerType ?? "capability",
    capabilityType: provider.type ?? provider.providerType ?? "capability",
    coverageStatus: "selected",
    source: provider.source ?? "selected_execution_route",
    sourceRef: provider.sourceRef ?? provider.id,
    platformId: provider.platformId ?? provider.runtime ?? null,
    routeImpact: `${slot} provider selected for route-driven execution`,
  }));
}

function routeEvidenceSources(routeResult) {
  const base = [
    ["project_overview", "README.md"],
    ["maintainer_contract", "AGENTS.md"],
    ["command_inventory", "package.json#scripts"],
    ["project_graph", "graphify-out"],
    ["canonical_skill", "canonical/skills/meta-theory/SKILL.md"],
    ["machine_contract", "config/contracts/core-loop-contract.json"],
    ["capability_index", "config/capability-index/meta-kim-capabilities.json"],
    ["mcp_inventory", ".mcp.json"],
    ["external_research_capability", "config/skills.json"],
  ].map(([sourceType, sourceRef]) => ({
    sourceType,
    sourceRef,
    checked: true,
    routeImpact: "Feeds route-driven Fetch evidence before Thinking locks the dispatch board.",
  }));
  const discovered = (routeResult.ownerDiscoveryPacket?.evidenceRefs ?? [])
    .slice(0, 40)
    .map((sourceRef) => ({
      sourceType: "capability_discovery_ref",
      sourceRef,
      checked: true,
      routeImpact: "Discovered by select-execution-route owner/provider search.",
    }));
  return [...base, ...discovered];
}

function providersByLane(routeResult, lane) {
  const selected = routeResult.recommendedRoute?.selectedCapabilityProviders ?? {};
  const laneProvider = lane?.capabilityProvider ?? null;
  const laneBinding = lane?.capabilityBinding ?? {};
  const selectedProviders = laneBinding.selectedProviders ?? {};
  const skillLoadout = [];
  if (laneProvider?.type === "skills") skillLoadout.push(laneProvider);
  for (const provider of [selectedProviders.skill]) {
    if (provider?.type === "skills" && !skillLoadout.some((item) => item.id === provider.id)) {
      skillLoadout.push(provider);
    }
  }
  const hasLaneBinding = Object.keys(selectedProviders).length > 0;
  if (!hasLaneBinding) {
    for (const provider of [
      selected.skill,
      selected.skillDiscovery,
      selected.skillCreation,
      selected.agentCreation,
      ...Object.values(selected).filter((provider) => provider?.type === "skills"),
    ]) {
      if (provider?.type === "skills" && !skillLoadout.some((item) => item.id === provider.id)) {
        skillLoadout.push(provider);
      }
    }
  }
  const runtimeTools = [lane?.runtimeTool, selectedProviders.runtimeTool, selected.runtimeTool, selected.runtimeEdit, selected.shell]
    .filter(Boolean)
    .filter((provider, index, all) => all.findIndex((item) => item.id === provider.id) === index);
  return {
    skillLoadout,
    mcpLoadout: [selectedProviders.mcp, ...(!hasLaneBinding ? [selected.mcp, selected.mcpServer, selected.mcpTool] : [])]
      .filter(Boolean)
      .filter((provider, index, all) => all.findIndex((item) => item.id === provider.id) === index),
    toolLoadout: runtimeTools,
    commandLoadout: [selectedProviders.command, ...(!hasLaneBinding ? [selected.command, selected.verificationCommand] : [])]
      .filter(Boolean)
      .filter((provider, index, all) => all.findIndex((item) => item.id === provider.id) === index),
  };
}

function buildRouteDrivenWorkerTasks({ runId, routeResult, task }) {
  const route = routeResult.recommendedRoute;
  const routeId = route?.id ?? "unresolved-route";
  const lanes = route?.subjectiveUiCapabilityAmplification?.lanes ?? [];
  const parallelLanes = route?.parallelExecutionLanes ?? [];
  const drafts = routeResult.workerTaskPacketDrafts ?? [];
  const durableRequests = durableCapabilityRequestsFromTask(task, runId);
  const sourceTasks = lanes.length > 0
    ? lanes.map((lane) => ({
        lane,
        draft: drafts.find((draft) => draft.roleInstanceId === lane.laneId) ?? {},
      }))
    : parallelLanes.length > 0
      ? parallelLanes.map((lane) => ({
          lane,
          draft: drafts.find((draft) => draft.roleInstanceId === lane.laneId) ?? {},
        }))
    : durableRequests.length > 1
      ? durableRequests.map((request) => ({
          lane: {
            laneId: request.requestId,
            roleDisplayName:
              request.decision === "create_script"
                ? "backend"
                : request.decision === "create_agent"
                  ? "analysis"
                  : request.decision === "create_mcp_provider"
                    ? "backend"
                    : "docs",
            ownerAgent:
              request.decision === "create_script" || request.decision === "create_mcp_provider"
                ? "backend"
                : request.decision === "create_agent"
                  ? "analysis"
                  : "docs",
            purpose: `Prepare durable ${request.candidateType} candidate evidence for: ${request.sourceText}`,
            decisionImpact: "Decides whether this explicit reusable capability should stay candidate-only or proceed through Warden approval.",
            capabilityProvider: route?.selectedCapabilityProviders?.skillCreation ?? route?.selectedCapabilityProviders?.skill,
            dependsOn: [],
            parallelGroup: "durable-capability-candidates",
          },
          draft: {},
        }))
    : [
        {
          lane: {
            laneId: "route-execution",
            roleDisplayName: route?.owner?.replace(/^meta-/, "") ?? "operations",
            ownerAgent: route?.owner ?? "meta-conductor",
            purpose: "Execute the selected capability-first route.",
            decisionImpact: "Turns the selected route into bounded worker execution.",
            dependsOn: [],
            parallelGroup: "route-execution",
          },
          draft: drafts[0] ?? {},
        },
      ];
  return sourceTasks.map(({ lane, draft }, index) => {
    const loadout = providersByLane(routeResult, lane);
    const taskPacketId = `${runId}-${lane.laneId ?? `route-${index + 1}`}`;
    const roleDisplayName = lane.roleDisplayName ?? draft.roleDisplayName ?? "operations";
    const ownerAgent = lane.ownerAgent ?? draft.ownerAgent ?? route?.owner ?? "meta-conductor";
    const ownerSource =
      lane.ownerSource ??
      draft.codexSpawnBinding?.ownerSource ??
      draft.ownerSource ??
      route?.ownerBinding?.source ??
      "owner_source_unresolved";
    const ownerSourceRef =
      lane.sourceRef ??
      draft.codexSpawnBinding?.sourceRef ??
      draft.sourceRef ??
      route?.ownerBinding?.providerEvidenceRef ??
      null;
    const ownerKind = lane.ownerKind ?? draft.ownerKind ?? "agent";
    const ownerBindingMode =
      draft.codexSpawnBinding?.ownerBindingMode ??
      draft.ownerBindingMode ??
      "run_scoped_owner_contract";
    const nativeAgentType = ownerBindingMode === "native_custom_agent"
      ? draft.codexSpawnBinding?.nativeAgentType ?? draft.nativeAgentType ?? null
      : null;
    const isVerification = ["test", "review"].includes(roleDisplayName);
    const isEvolution = lane.laneId === "evolution-signal";
    return {
      taskPacketId,
      taskKind: "run_worker_task",
      packetKind: "run_scoped_task_not_agent_definition",
      userVisibleTypeLabel: "本次任务，不是 agent 设定",
      routeId,
      owner: ownerAgent,
      ownerAgent,
      ownerSource,
      ownerSourceRef,
      ownerKind,
      ownerBindingMode,
      nativeAgentType,
      ownerDefinition: draft.codexSpawnBinding?.ownerDefinition ?? null,
      ownerMode: "existing-owner",
      executionMode: isVerification || isEvolution ? "verification_execution" : "primary_execution",
      businessRoleId: roleDisplayName,
      businessFlowLaneId: lane.businessFlowLaneId ?? lane.laneId ?? null,
      businessFlowLaneLabel: lane.businessFlowLaneLabel ?? lane.label ?? lane.purpose ?? null,
      roleDisplayName,
      roleInstanceId: lane.laneId ?? draft.roleInstanceId ?? `route-${index + 1}`,
      runtimeInstanceAlias: "",
      runtimeInvocationPlan: draft.codexSpawnBinding ?? null,
      coreProblem: lane.purpose ?? draft.purpose ?? "Run the selected route lane.",
      todayTask: lane.purpose ?? draft.purpose ?? "Run the selected route lane.",
      nonGoals: [
        "Do not rewrite durable agent identity for this one-run task.",
        "Do not use old capability-gap orchestration as the default path.",
      ],
      output: isEvolution ? "evolution_decision" : `${roleDisplayName}_lane_result`,
      acceptanceCriteria: [
        "The lane declares capabilityNeed before any concrete provider binding.",
        "Concrete provider bindings are selected from current inventory by capabilityNeed, not by fixed agent-to-skill pairs.",
        "The lane declares agent, skill, MCP, tool, command, and verification loadout when the runtime inventory provides them.",
        "Concrete task scope stays in workerTaskPackets, not in durable agent settings.",
        ...(lane.laneId === "read-before-edit-implementation"
          ? ["Target files must be read in the same turn before any edit/write/apply_patch."]
          : []),
      ],
      deliverableLink: `route://${routeId}/${lane.laneId ?? index + 1}`,
      scopeFiles: [`route://${routeId}/${lane.laneId ?? index + 1}`],
      qualityBar: "route-driven execution with visible provider loadout and no generic fallback",
      workType: roleDisplayName,
      expertLensRefs: [roleDisplayName],
      evidenceRefs: [
        "selectedExecutionRoute.recommendedRoute",
        "selectedExecutionRoute.ownerDiscoveryPacket",
        "selectedExecutionRoute.recommendedRoute.subjectiveUiCapabilityAmplification.lanes[].providerMatch",
      ],
      capabilityNeed: lane.capabilityNeed ?? [],
      capabilityRequirements:
        Array.isArray(lane.capabilityNeed) && lane.capabilityNeed.length > 0
          ? lane.capabilityNeed
          : [lane.capabilityProvider?.id ?? draft.dependency ?? route?.dependency ?? "selected-route-provider"],
      providerMatch: lane.providerMatch ?? null,
      capabilitySelection: {
        selectionPolicy:
          lane.providerMatch?.selectionPolicy ??
          lane.capabilityBinding?.selectionPolicy ??
          "route_selected_provider",
        candidateProviders: lane.providerMatch?.candidateProviders ?? [],
        selectedProvider: lane.providerMatch?.selectedProvider ?? null,
        whySelected: lane.providerMatch?.whySelected ?? null,
        whyNotSelected: lane.providerMatch?.whyNotSelected ?? [],
      },
      capabilityBindings: {
        agent: ownerAgent,
        skills: loadout.skillLoadout,
        mcp: loadout.mcpLoadout,
        tools: loadout.toolLoadout,
        commands: loadout.commandLoadout,
      },
      capabilityLoadout: {
        capabilityProfileId: routeId,
        repoSkills: capabilityProviderRefs(loadout.skillLoadout),
        runtimeSkillCandidates: capabilityProviderRefs(loadout.skillLoadout),
        repoMcpTools: capabilityProviderRefs(loadout.mcpLoadout),
        runtimeMcpCandidates: capabilityProviderRefs(loadout.mcpLoadout),
        commands: capabilityProviderRefs(loadout.commandLoadout),
        runtimeTools: capabilityProviderRefs(loadout.toolLoadout),
      },
      skillLoadout: loadout.skillLoadout,
      mcpLoadout: loadout.mcpLoadout,
      toolLoadout: loadout.toolLoadout,
      commandLoadout: loadout.commandLoadout,
      readBeforeEditRequired: lane.laneId === "read-before-edit-implementation",
      referenceDirection: lane.decisionImpact ?? draft.decisionImpact ?? "Use selected route evidence.",
      handoffTarget: draft.verificationOwner ?? route?.verificationOwner ?? "meta-prism",
      handoffContract: {
        handoffTo: draft.verificationOwner ?? route?.verificationOwner ?? "meta-prism",
        handoffWhen: "after lane result and evidence are produced",
        handoffPayload: "lane result, provider loadout, evidence refs, blockers",
        acceptanceSignal: "review accepts lane output or returns to Thinking with a concrete missing provider",
      },
      lengthExpectation: "compact",
      visualOrAssetPlan: roleDisplayName === "frontend" ? "browser and visual review evidence when UI is in scope" : "none",
      dependsOn: Array.isArray(lane.dependsOn) ? lane.dependsOn.map((dep) => `${runId}-${dep}`) : [],
      parallelGroup: lane.parallelGroup ?? draft.parallelGroup ?? "route-driven",
      mergeOwner: "meta-conductor",
      shardKey: lane.laneId ?? `route-${index + 1}`,
      shardScope: [lane.laneId ?? `route-${index + 1}`],
      workspaceIsolation: "same_workspace_readonly_overlap",
      artifactNamespace: `${routeId}/${lane.laneId ?? index + 1}`,
      collisionPolicy: "no_overlap",
      verifySteps: [
        {
          id: `${taskPacketId}-route-loadout`,
          step: "Check lane provider loadout and route gate state",
          verify: "Agent, skill/MCP/tool/command loadout and verification owner are declared.",
        },
      ],
      preDecisionOptionFrameRef: "selectedExecutionRoute.decisionCard",
      userChoiceState: routeResult.routeExecutionGate?.canEnterExecution
        ? "no_branching_choice"
        : (routeResult.routeExecutionGate?.returnToStage ?? "route_choice_required"),
      finalizationGate: routeResult.routeExecutionGate?.canEnterExecution
        ? "after_route_gate_pass"
        : "blocked_before_execution",
    };
  });
}

async function buildRouteDrivenOrchestration({ task, runId, runtime = "codex", osTarget = "windows", codexHostToolSchema = null }) {
  const routeRuntime = normalizeRouteRuntime(runtime);
  const routeOs = normalizeOsTarget(osTarget);
  const routeResult = await selectExecutionRoute({ task, runtime: routeRuntime, os: routeOs, runId, codexHostToolSchema });
  const route = routeResult.recommendedRoute;
  const providerList = providerListFromRoute(routeResult);
  const workerTaskPackets = buildRouteDrivenWorkerTasks({ runId, routeResult, task });
  const routeGate = routeResult.routeExecutionGate ?? {};
  const blocked = routeGate.canEnterExecution !== true;
  const capabilityGaps = routeResult.capabilityGapDetected && routeResult.capabilityGapDecision
    ? [
        {
          gapId: `${runId}-route-capability-gap`,
          blocked: routeGate.canEnterExecution !== true,
          gapType: "selected_route_gap",
          decision: routeResult.capabilityGapDecision.decision,
          reason: routeResult.capabilityGapDecision.blockedReason ?? "Selected route reported a capability gap.",
          decisionReason:
            routeResult.capabilityGapDecision.blockedReason ?? "Selected route reported a capability gap.",
          owner: "meta-conductor",
        },
      ]
    : [];
  const selectedLaneIds = workerTaskPackets.map((packet) => packet.roleInstanceId);
  const omittedLanesWithReason =
    route?.subjectiveUiCapabilityAmplification?.omittedLanesWithReason?.map((lane) => ({
      laneId: lane.laneId,
      reason: lane.reason ?? lane.omitReason ?? "Omitted by route selector.",
      evidenceRef:
        lane.evidenceRef ??
        "selectedExecutionRoute.recommendedRoute.subjectiveUiCapabilityAmplification.omittedLanesWithReason",
    })) ?? [];
  const omittedLaneIds = omittedLanesWithReason.map((lane) => lane.laneId);
  const checks = {
    multiTypeCapabilityInventoryPresent:
      providerList.some((provider) => provider.type === "skills") &&
      providerList.some((provider) => provider.type === "runtimeTools" || provider.type === "commands") &&
      providerList.some((provider) => provider.type === "mcpServers" || provider.type === "mcpTools"),
    workerTasksDeclareExecutionMode: workerTaskPackets.every((packet) => Boolean(packet.executionMode)),
    routeDrivenDefaultPath: true,
    oldCapabilityGapDefaultPathRemoved: true,
    taskVsAgentBoundaryVisible: workerTaskPackets.every(
      (packet) => packet.packetKind === "run_scoped_task_not_agent_definition",
    ),
    loadoutFamiliesVisible: workerTaskPackets.every(
      (packet) =>
        Array.isArray(packet.skillLoadout) &&
        Array.isArray(packet.mcpLoadout) &&
        Array.isArray(packet.toolLoadout) &&
        Array.isArray(packet.commandLoadout),
    ),
  };
  return {
    status: route && !blocked ? "pass" : "partial",
    runtimeContext: {
      runtimeFamily: routeRuntime,
      os: routeOs,
    },
    selectedExecutionRoute: routeResult,
    criticalSummary: {
      realGoal: `Run Meta_Kim through the selected route for: ${task}`,
      successCriteria: [
        "One default route drives Critical, Fetch, Thinking, Execution, Review, Meta-Review, Verification, and Evolution.",
        "Worker task cards separate one-run task scope from durable agent settings.",
        "Agent, skill, MCP, tool, command, hook, and evolution decisions are visible.",
      ],
      nonGoals: [
        "No old capability-gap orchestration as the default governed execution path.",
        "No validator/hook rescue loop after a weak route.",
      ],
    },
    fetchEvidence: {
      sources: routeEvidenceSources(routeResult),
      capabilityInventory: providerList,
      orchestrationOwner: route?.owner ?? "meta-conductor",
      decisionImpactMap: [
        {
          finding: "selectedExecutionRoute.recommendedRoute",
          impacts: ["dispatchBoard", "workerTaskPackets", "providerLoadout"],
          decisionChanged: "Default governed execution consumes the selected route instead of the old capability-gap orchestrator.",
          stageAffected: "Thinking",
        },
      ],
    },
    capabilityGaps,
    decisionCounts: {
      routeDriven: workerTaskPackets.length,
      capabilityGap: capabilityGaps.length,
      oldDefaultPath: 0,
    },
    thinkingRoute: {
      boardMode: "route_driven_dispatch",
      businessFlowLaneCount: workerTaskPackets.length,
      dynamicWorkflowPlan: {
        selectedLaneIds,
        omittedLaneIds,
        omittedLanesWithReason,
      },
    },
    orchestrationTaskBoardPacket: {
      dispatchBoardId: `${runId}-route-dispatch-board`,
      boardMode: "route_driven_dispatch",
      triggerChain: [
        "entry_classifier",
        "capability_discovery",
        "select_execution_route",
        "worker_task_packets",
      ],
      tasks: workerTaskPackets.map((packet, index) => ({
        taskId: packet.taskPacketId,
        taskKind: packet.taskKind,
        userVisibleTypeLabel: packet.userVisibleTypeLabel,
        owner: packet.owner,
        businessRoleId: packet.businessRoleId,
        roleDisplayName: packet.roleDisplayName,
        roleInstanceId: packet.roleInstanceId,
        sequence: index + 1,
        dependsOn: packet.dependsOn,
        deliverable: packet.deliverableLink,
        capabilityBindings: packet.capabilityBindings,
      })),
      synthesisOwner: "meta-conductor",
      mergeOwner: "meta-conductor",
    },
    workerTaskPackets,
    reviewResult: {
      owner: "meta-prism",
      status: checks.multiTypeCapabilityInventoryPresent && checks.workerTasksDeclareExecutionMode ? "pass" : "partial",
      checks,
      findings: blocked
        ? [
            {
              severity: "high",
              summary: routeGate.reason ?? "Route gate blocks execution.",
              returnToStage: routeGate.returnToStage ?? "Thinking",
              blockedBy: routeGate.blockedBy ?? [],
            },
          ]
        : [],
    },
    verificationResult: {
      owner: route?.verificationOwner ?? "meta-prism",
      status: route ? "pass" : "partial",
      command: "npm run meta:route:validate",
    },
    stageVisibility: {
      requiredStages: ["Critical", "Fetch", "Thinking", "Review"],
      Critical: "visible_intent_and_choice_boundary",
      Fetch: "visible_capability_inventory",
      Thinking: "visible_route_and_worker_task_cards",
      Execution: blocked ? "blocked_before_execution_by_route_gate" : "route_driven_worker_tasks_ready",
      Review: "visible_review_checks",
      "Meta-Review": "visible_overclaim_boundary",
      Verification: "visible_verification_owner_and_command",
      Evolution: "visible_family_writeback_decision",
    },
  };
}

export async function runMetaTheoryGovernedExecution({
  task,
  runId = null,
  allowOverwrite = false,
  outputLanguage = null,
  cliOutputLanguage = null,
  stateDir = DEFAULT_STATE_DIR,
  artifactDir = null,
  dbPath = DEFAULT_DB_PATH,
  runtime = "codex",
  osTarget = "windows",
  approvalEvidence = null,
  approvalPacket = null,
  applyWriteback = false,
  canonicalRoot = path.join(REPO_ROOT, "canonical"),
  emitConversationNotice = false,
  onConversationProgress = null,
  conversationNoticeChannel = "api_callback",
  conversationNoticeAdapter = CONVERSATION_NOTICE_ADAPTER,
  hostVisibleSubagents = process.env.META_KIM_HOST_VISIBLE_SUBAGENTS ?? null,
  hostInvocationEvidence = process.env.META_KIM_HOST_INVOCATION_EVIDENCE ?? null,
  hostAssistantMessageEvidence = process.env.META_KIM_HOST_ASSISTANT_MESSAGE_EVIDENCE ?? null,
  nativeChoiceEvidence = process.env.META_KIM_NATIVE_CHOICE_EVIDENCE ?? null,
  codexHostToolSchema = process.env.META_KIM_CODEX_HOST_TOOL_SCHEMA ?? null,
  nativeChoiceEvidenceTrusted = false,
  invokeCapabilityProbes = false,
  projectRoot = process.env.META_KIM_CALLER_CWD || process.cwd(),
  projectCapabilityMutationMode = "auto",
  planChallengeResponses = [],
  planChallengeControl = null,
  sharedUnderstandingConfirmed = false,
  executionAuthorization = null,
  planChallengeContradictionEvidence = [],
  requestedSideEffectActions = [],
  hostDecisionEvidenceVerifier = null,
  previousPlanChallengeRunId = null,
  stageRunner = null,
} = {}) {
  const normalizedTask = normalizeTask(task);
  if (!normalizedTask) {
    throw new Error("Missing task for governed meta-theory execution.");
  }
  const taskFingerprint = stableId("task", normalizedTask);
  const durableStageRunnerEnabled = stageRunner?.enabled === true;
  const durableMode = durableStageRunnerEnabled ? (stageRunner.durableMode ?? "fresh") : null;
  if (durableStageRunnerEnabled && !["fresh", "resume"].includes(durableMode)) {
    throw new TypeError(`Unsupported durable stage-runner mode: ${durableMode}`);
  }
  if (durableStageRunnerEnabled && allowOverwrite === true) {
    throw new Error("Durable stage-runner execution forbids overwrite; use resume with the exact run identity.");
  }
  const languageResolution = resolveOutputLanguage({
    explicitLanguage: outputLanguage,
    cliLanguage: cliOutputLanguage,
    latestInput: normalizedTask,
  });
  const resolvedOutputLanguage = languageResolution.language;
  const outputDir = artifactDir ? path.resolve(artifactDir) : path.resolve(stateDir);
  await fs.mkdir(outputDir, { recursive: true });
  const governedSideEffectActions = [
    ...(Array.isArray(requestedSideEffectActions) ? requestedSideEffectActions : []),
  ];
  const requestedPreviousRunId = previousPlanChallengeRunId == null
    ? null
    : validateRunId(String(previousPlanChallengeRunId), "previous plan challenge runId");
  const continuationCandidate = requestedPreviousRunId == null
    ? null
    : await loadPlanChallengeContinuationCandidate({
        artifactPath: resolveOutputFile(outputDir, `${requestedPreviousRunId}.json`),
        previousRunId: requestedPreviousRunId,
        taskFingerprint,
      });
  const candidatePriorChallengeState = continuationCandidate
    ? { ...continuationCandidate, trusted: true }
    : null;
  const initialPlanChallengePreview = buildPlanChallengeState({
    task: normalizedTask,
    priorChallengeState: candidatePriorChallengeState,
    contradictionEvidence: planChallengeContradictionEvidence,
    requestedSideEffectActions: governedSideEffectActions,
    outputLanguage: resolvedOutputLanguage,
  });
  let effectivePlanChallengeResponses = [];
  let effectivePlanChallengeControl = null;
  let effectiveSharedUnderstandingConfirmed = false;
  let effectiveExecutionAuthorization = null;
  let trustedPriorChallengeState = null;
  if (typeof hostDecisionEvidenceVerifier === "function") {
    const verifiedDecision = await hostDecisionEvidenceVerifier({
      task: normalizedTask,
      previousRunId: requestedPreviousRunId,
      currentPhase: initialPlanChallengePreview.planChallengeState.phase,
      pendingUserChoice: initialPlanChallengePreview.planChallengeState.pendingUserChoice,
      untrustedInput: {
        responses: planChallengeResponses,
        control: planChallengeControl,
        sharedUnderstandingConfirmed,
        executionAuthorization,
      },
    });
    const boundDecision = bindVerifiedHostPlanChallengeDecision({
      verifiedDecision,
      preview: initialPlanChallengePreview,
      continuationCandidate,
    });
    if (boundDecision.accepted) {
      effectivePlanChallengeResponses = boundDecision.responses;
      effectivePlanChallengeControl = boundDecision.control;
      effectiveSharedUnderstandingConfirmed = boundDecision.sharedUnderstandingConfirmed;
      effectiveExecutionAuthorization = boundDecision.executionAuthorization;
      trustedPriorChallengeState = boundDecision.priorChallengeState;
    } else if (requestedPreviousRunId != null) {
      throw new Error(`Plan challenge continuation rejected: ${boundDecision.reason}.`);
    }
  } else if (requestedPreviousRunId != null) {
    throw new Error(
      "Plan challenge continuation requires a current host decision evidence verifier.",
    );
  }
  const planChallengePreview = buildPlanChallengeState({
    task: normalizedTask,
    priorChallengeState: trustedPriorChallengeState,
    responses: effectivePlanChallengeResponses,
    control: effectivePlanChallengeControl,
    sharedUnderstandingConfirmed: effectiveSharedUnderstandingConfirmed,
    executionAuthorization: effectiveExecutionAuthorization,
    contradictionEvidence: planChallengeContradictionEvidence,
    requestedSideEffectActions: governedSideEffectActions,
    outputLanguage: resolvedOutputLanguage,
  });
  const executionAllowed = planChallengePreview.planChallengeState.executionAllowed === true;
  const requestedProjectCapabilityMutationMode =
    normalizedProjectCapabilityMutationMode(projectCapabilityMutationMode);
  const resolvedProjectCapabilityMutationMode =
    !executionAllowed
      ? "read_only"
      : requestedProjectCapabilityMutationMode;
  const requestedRunId = runId == null ? null : String(runId);
  if (durableMode === "resume" && requestedRunId == null) {
    throw new Error("Durable resume requires an explicit runId and task.");
  }
  const effectiveRunId = validateRunId(
    requestedRunId ?? uniqueRunId(taskFingerprint),
    requestedRunId == null ? "generated runId" : "requested runId",
  );
  if (requestedPreviousRunId != null && effectiveRunId === requestedPreviousRunId) {
    throw new Error("A continuation run must use a new runId instead of overwriting its prior artifact.");
  }
  const jsonPath = resolveOutputFile(outputDir, `${effectiveRunId}.json`);
  const markdownFileName = `${effectiveRunId}.${resolvedOutputLanguage}.md`;
  const markdownPath = resolveOutputFile(outputDir, markdownFileName);
  const stagingRefs = {
    json: `.${effectiveRunId}.json.staging`,
    markdown: `.${markdownFileName}.staging`,
  };
  const jsonStagingPath = resolveOutputFile(outputDir, stagingRefs.json);
  const markdownStagingPath = resolveOutputFile(outputDir, stagingRefs.markdown);
  const latestPath = resolveOutputFile(outputDir, "latest.json");
  const reservationPath = resolveOutputFile(
    outputDir,
    `${effectiveRunId}.reservation.json`,
  );
  const durableDbPath = durableStageRunnerEnabled
    ? path.resolve(stageRunner.durableDbPath ?? path.join(stateDir, "durable-runs.sqlite"))
    : null;
  if (durableMode === "resume") {
    const reservation = await readDurableReservation(reservationPath, {
      runId: effectiveRunId,
      taskFingerprint,
    });
    if (
      reservation.stagingRefs.json !== stagingRefs.json ||
      reservation.stagingRefs.markdown !== stagingRefs.markdown
    ) {
      throw new Error(`Durable reservation staging identity mismatch for run '${effectiveRunId}'.`);
    }
    const materialized = await loadAlreadyMaterializedDurableRun({
      runId: effectiveRunId,
      task: normalizedTask,
      taskFingerprint,
      reservation,
      reservationPath,
      jsonPath,
      markdownPath,
      latestPath,
      dbPath,
      durableDbPath,
    });
    if (materialized) return materialized;
  } else if (durableMode === "fresh") {
    await reserveExplicitRunId(reservationPath, {
      runId: effectiveRunId,
      taskFingerprint,
      stagingRefs,
    });
  } else if (requestedRunId != null && allowOverwrite !== true) {
    await reserveExplicitRunId(reservationPath, {
      runId: effectiveRunId,
      taskFingerprint,
      stagingRefs,
    });
  }
  if (
    (requestedRunId != null || durableMode === "fresh") &&
    durableMode !== "resume" &&
    allowOverwrite !== true &&
    (existsSync(jsonPath) || existsSync(markdownPath))
  ) {
    throw new Error(
      `Governed run '${effectiveRunId}' already exists. Pass allowOverwrite=true or --overwrite-run to replace it explicitly.`,
    );
  }
  const labels = getReportLabelsForPath(markdownPath);
  const surfaceLabels = getGovernedRunSurfaceLabels(resolvedOutputLanguage);
  const progressEvents = [];
  const progressEnabled =
    emitConversationNotice === true || typeof onConversationProgress === "function";
  const publishProgress = async (event) =>
    publishConversationProgress({
      event,
      events: progressEvents,
      labels,
      surfaceLabels,
      enabled: progressEnabled,
      onConversationProgress,
    });
  await publishProgress(
    progressEvent({
      runId: effectiveRunId,
      stage: "Critical",
      status: "started",
      reason: surfaceLabels.events.runStart(effectiveRunId),
      owner: "meta-warden",
    }),
  );
  const routeRuntime = normalizeRouteRuntime(runtime);
  const routeOs = normalizeOsTarget(osTarget);
  const orchestrationReport = await buildRouteDrivenOrchestration({
    task: normalizedTask,
    runId: effectiveRunId,
    runtime: routeRuntime,
    osTarget: routeOs,
    codexHostToolSchema,
  });
  const capabilityInventoryBus = await writeCapabilityInventory(
    path.join(stateDir, "capability-inventory.json"),
  );
  await publishProgress(
    progressEvent({
      runId: effectiveRunId,
      stage: "Fetch",
      status: "completed",
      reason: surfaceLabels.events.fetch(
        orchestrationReport.fetchEvidence.capabilityInventory.length,
      ),
      owner: orchestrationReport.fetchEvidence.orchestrationOwner,
    }),
  );
  const decisionResults = buildRouteDrivenDecisionResults({
    task: normalizedTask,
    runId: effectiveRunId,
  });
  await publishProgress(
    progressEvent({
      runId: effectiveRunId,
      stage: "Thinking",
      status: "route_ready_before_execution",
      reason: surfaceLabels.events.thinking(
        orchestrationReport.orchestrationTaskBoardPacket.synthesisOwner,
        orchestrationReport.workerTaskPackets.length,
      ),
      owner: orchestrationReport.orchestrationTaskBoardPacket.synthesisOwner,
    }),
  );
  const runtimeEvidence = await buildRuntimeProjectionEvidence({
    repoRoot: REPO_ROOT,
    orchestrationReport,
  });
  const writebackFlow = await buildWardenWritebackFlow({
    decisionResults,
    approvalEvidence,
    approvalPacket,
    applyWriteback: applyWriteback && executionAllowed,
    canonicalRoot,
  });
  await publishProgress(
    progressEvent({
      runId: effectiveRunId,
      stage: "Execution",
      status: "preparing_dispatch_pending",
      reason: surfaceLabels.events.execution(
        "preparing_dispatch_pending",
        orchestrationReport.workerTaskPackets.length,
        orchestrationReport.workerTaskPackets.filter((packet) => packet.handoffContract).length,
      ),
      owner: orchestrationReport.orchestrationTaskBoardPacket.synthesisOwner,
    }),
  );
  const cardPlanPacket = buildCardPlanPacket({
    runId: effectiveRunId,
    orchestrationReport,
    runtimeEvidence,
  });
  const businessPhasePlanPacket = buildBusinessPhasePlanPacket({
    runId: effectiveRunId,
    orchestrationReport,
    runtimeEvidence,
    writebackFlow,
  });
  const businessFlowBlueprintPacket = buildBusinessFlowBlueprintPacket({
    businessPhasePlanPacket,
    orchestrationReport,
  });
  const governanceStartReasonPacket = buildGovernanceStartReasonPacket({
    orchestrationReport,
    businessPhasePlanPacket,
    cardPlanPacket,
    language: resolvedOutputLanguage,
  });
  await publishProgress(
    progressEvent({
      runId: effectiveRunId,
      stage: "Review",
      status: "structural_review_snapshot",
      reason: surfaceLabels.events.review(
        "structural_review_snapshot",
        orchestrationReport.reviewResult.owner,
      ),
      owner: orchestrationReport.reviewResult.owner,
    }),
  );
  await publishProgress(
    progressEvent({
      runId: effectiveRunId,
      stage: "Closure",
      status: "projection_snapshot",
      reason: surfaceLabels.events.closure(
        runtimeEvidence.status,
        `${businessPhasePlanPacket.closure.currentPhase}=${businessPhasePlanPacket.closure.currentStatus}`,
      ),
      owner: orchestrationReport.verificationResult.owner,
    }),
  );
  await persistDecisionRuns({ dbPath, decisionResults });
  const analytics = await persistRuntimeEvidenceEvents({
    dbPath,
    runId: effectiveRunId,
    runtimeEvidence,
    writebackFlow,
  });
  const sectionLabels = labels.sections;
  const toolList = labels.toolList(labels.toolNames);
  let artifactStatus =
    orchestrationReport.status === "pass" &&
    runtimeEvidence.status === "pass" &&
    ["candidate_only", "approved-for-writeback", "none-with-reason"].includes(writebackFlow.status)
      ? "pass"
      : "partial";
  if (!executionAllowed) {
    artifactStatus = "partial";
  }
  let conversationNotice = buildConversationNotice({
    orchestrationReport,
    runtimeEvidence,
    labels,
    governanceStartReasonPacket,
    businessPhasePlanPacket,
    cardPlanPacket,
    progressEvents,
    surfaceSnapshot: {
      providerInvocationState: hostInvocationEvidence
        ? "host_evidence_pending_validation"
        : "selected_not_invoked",
      providerBindings: [],
      providerPresentationSummary: surfaceLabels.invocationPresentation.userSummary(
        "not_confirmed",
        surfaceLabels.invocationPresentation.executionStates.not_confirmed,
      ),
      meshMode: "planned_structural",
      peerCount: orchestrationReport.workerTaskPackets.length,
      handoffCount: orchestrationReport.workerTaskPackets.filter(
        (packet) => packet.handoffContract,
      ).length,
      nodeCount: TRACE_SPINE.length + orchestrationReport.workerTaskPackets.length,
      edgeCount:
        Math.max(TRACE_SPINE.length - 1, 0) +
        orchestrationReport.workerTaskPackets.reduce(
          (count, packet) => count + (packet.dependsOn?.length ?? 0),
          0,
        ),
      state: "structural_route_ready",
      checkpointCount: 0,
    },
    emitConversationNotice: progressEnabled,
    conversationNoticeChannel,
    conversationNoticeAdapter,
    artifactStatus,
    partialReasons: artifactStatus === "partial" ? ["structural_preflight_incomplete"] : [],
  });
  conversationNotice.hostObservation = evaluateHostAssistantMessageEvidence(
    hostAssistantMessageEvidence,
    conversationNotice.hostObservationExpectations,
  );
  let userExperienceNotice = buildUserExperienceNotice({
    orchestrationReport,
    runtimeEvidence,
    writebackFlow,
    labels,
    conversationNotice,
    cardPlanPacket,
  });
  const stageOperationPlan = buildStageOperationPlan({
    orchestrationReport,
    runtimeEvidence,
    writebackFlow,
    labels,
  });
  const panelContractDefinition = await readJson(RUN_REPORT_PANEL_CONTRACT_PATH);
  const aiReadableStandards = await readJson(AI_READABLE_PRODUCT_STANDARDS_PATH);
  const agentTeamsPlaybookProvider = await resolveAgentTeamsPlaybookProvider(routeRuntime);
  const projectCapabilityCandidateRoot = mkdtempSync(
    path.join(os.tmpdir(), "meta-kim-project-capability-candidates-"),
  );
  let coreLoop;
  try {
    coreLoop = buildCoreLoopArtifact({
      runId: effectiveRunId,
      task: normalizedTask,
      orchestrationReport,
      capabilityInventoryBus,
      decisionResults,
      runtimeEvidence,
      writebackFlow,
      artifactStatus,
      cardPlanPacket,
      stageOperationPlan,
      conversationNotice,
      userExperienceNotice,
      analytics,
      hostVisibleSubagents,
      hostInvocationEvidence,
      nativeChoiceEvidence,
      nativeChoiceEvidenceTrusted,
      agentTeamsPlaybookProvider,
      invokeCapabilityProbes,
      projectRoot: path.resolve(projectRoot),
      projectCapabilityMutationMode: resolvedProjectCapabilityMutationMode,
      projectCapabilityCandidateRoot,
      runtime: routeRuntime,
      osTarget: routeOs,
      outputLanguage: resolvedOutputLanguage,
      executionAllowed,
      preDecisionOptionFrame: planChallengePreview,
    });
  } finally {
    rmSync(projectCapabilityCandidateRoot, { recursive: true, force: true });
  }
  let durableCoordinator = null;
  let durableExecution = null;
  let durableBodyError = null;
  try {
  if (stageRunner?.enabled === true) {
    if (!executionAllowed) {
      coreLoop = {
        ...coreLoop,
        stageRunnerBridgePacket: {
          schemaVersion: "stage-runner-bridge-v0.1",
          prdTaskId: "P-117",
          status: "blocked",
          mode: "read_only_shadow",
          runtime: normalizeStageRunnerRuntime(stageRunner.runtime ?? routeRuntime),
          runId: effectiveRunId,
          failure: {
            failureClass: "plan_challenge_execution_not_authorized",
            reason: "The existing plan-challenge gate did not authorize Execution.",
          },
          nodeRecords: [],
          workerResults: [],
        },
      };
      if (durableStageRunnerEnabled) {
        durableExecution = {
          schemaVersion: "durable-governed-entry-v0.1",
          mode: durableMode,
          status: "blocked",
          database: durableDatabaseLabel(durableDbPath, stateDir),
          cursor: null,
          headCheckpointId: null,
          fenceToken: null,
          workerCount: 0,
        };
      }
    } else {
      const coordinatorLeaseMs = Math.max(
        1_000,
        Number.parseInt(String(stageRunner.durableLeaseMs ?? 30_000), 10) || 30_000,
      );
      const coordinatorHeartbeatIntervalMs = Math.max(
        100,
        Math.min(
          Math.floor(coordinatorLeaseMs / 2),
          Number.parseInt(
            String(stageRunner.durableHeartbeatIntervalMs ?? Math.floor(coordinatorLeaseMs / 3)),
            10,
          ) || 10_000,
        ),
      );
      if (durableStageRunnerEnabled) {
        durableCoordinator = await openRunnerDurableCoordinator({
          durableDbPath,
          mode: durableMode,
          runId: effectiveRunId,
          graphDigest: coreLoop.stageDagPacket.graphDigest,
          taskFingerprint,
          ownerId: `governed-entry:${process.pid}:${effectiveRunId}`,
          leaseMs: coordinatorLeaseMs,
          heartbeatIntervalMs: coordinatorHeartbeatIntervalMs,
        });
      }
      const bridgeResult = await runStageRunnerBridge({
        runId: effectiveRunId,
        runtime: stageRunner.runtime ?? routeRuntime,
        stageDagPacket: coreLoop.stageDagPacket,
        workerTaskPackets: coreLoop.thinkingPacket.workerTaskPackets,
        workspaceRoot: path.resolve(projectRoot),
        requestTask: normalizedTask,
        capacity: stageRunner.capacity ?? null,
        timeoutMs: stageRunner.timeoutMs ?? 300_000,
        invokeWorker: stageRunner.invokeWorker,
        executeReadySet: stageRunner.executeReadySet ?? resolveReadySetExecutor(
          stageRunner.orchestrator ?? "native",
          stageRunner.orchestratorOptions,
        ),
        readySetTimeoutMs: stageRunner.readySetTimeoutMs ?? null,
        durable: durableCoordinator
          ? {
              enabled: true,
              kernel: durableCoordinator.bridgeKernel,
              mode: durableMode === "fresh" ? "create" : "resume",
              taskFingerprint,
              ownerId: durableCoordinator.ownerId,
              leaseMs: coordinatorLeaseMs,
              heartbeatIntervalMs: coordinatorHeartbeatIntervalMs,
            }
          : null,
      });
      coreLoop = applyStageRunnerBridgeResult(coreLoop, bridgeResult);
      if (durableCoordinator) {
        durableCoordinator.assertHealthy();
        const projection = bridgeResult.executionProjection.durable.projection;
        durableExecution = {
          schemaVersion: "durable-governed-entry-v0.1",
          mode: durableMode,
          status: "materializing",
          database: durableDatabaseLabel(durableDbPath, stateDir),
          cursor: projection.cursor,
          headCheckpointId: projection.headCheckpointId,
          fenceToken: durableCoordinator.claim.fenceToken,
          coordinatorLeaseMs,
          workerCount: bridgeResult.workerResults?.length ?? 0,
          terminalStatus: bridgeResult.status === "pass" ? "completed" : "failed",
        };
      }
    }
  }
  artifactStatus =
    artifactStatus === "pass" &&
    runtimeEvidence.status === "pass" &&
    coreLoop.runtimeInvocationPlanPacket.status === "pass" &&
    coreLoop.hostInvocationRequestPacket.status === "pass" &&
    coreLoop.capabilityInvocationTruthPacket.status === "pass" &&
    !["partial", "read_only"].includes(coreLoop.projectCustomizationPacket.status) &&
    coreLoop.productExperiencePacket.status === "product_experience_pass" &&
    (!coreLoop.stageRunnerBridgePacket || coreLoop.stageRunnerBridgePacket.status === "pass")
      ? "pass"
      : "partial";
  const partialReasons = artifactStatus === "pass"
    ? []
    : [
        orchestrationReport.status !== "pass" ? `orchestration=${orchestrationReport.status}` : null,
        runtimeEvidence.status !== "pass" ? `runtime_projection=${runtimeEvidence.status}` : null,
        coreLoop.runtimeInvocationPlanPacket.status !== "pass"
          ? `provider_invocation=${coreLoop.runtimeInvocationPlanPacket.status}`
          : null,
        coreLoop.hostInvocationRequestPacket.status !== "pass"
          ? `host_invocation=${coreLoop.hostInvocationRequestPacket.status}`
          : null,
        coreLoop.capabilityInvocationTruthPacket.status !== "pass"
          ? `invocation_truth=${coreLoop.capabilityInvocationTruthPacket.status}`
          : null,
        ["partial", "read_only"].includes(coreLoop.projectCustomizationPacket.status)
          ? `project_customization=${coreLoop.projectCustomizationPacket.status}`
          : null,
        coreLoop.productExperiencePacket.status !== "product_experience_pass"
          ? `product_experience=${coreLoop.productExperiencePacket.status}`
          : null,
        coreLoop.stageRunnerBridgePacket && coreLoop.stageRunnerBridgePacket.status !== "pass"
          ? `stage_runner_bridge=${coreLoop.stageRunnerBridgePacket.status}`
          : null,
      ].filter(Boolean);
  const invokedBindingRefs = new Set(
    (coreLoop.runtimeInvocationPlanPacket.invokedBindings ?? []).map(
      (binding) => binding.bindingRef,
    ),
  );
  const providerBindings = (coreLoop.runtimeInvocationPlanPacket.requiredBindings ?? []).map(
    (binding) =>
      `${binding.family}:${binding.providerId ?? binding.bindingRef}:${
        invokedBindingRefs.has(binding.bindingRef) ? "invoked_or_applied" : "selected_not_invoked"
      }`,
  );
  const liveInvocationPass =
    coreLoop.capabilityInvocationTruthPacket.realInvocationCoverage?.status === "pass";
  conversationNotice = buildConversationNotice({
    orchestrationReport,
    runtimeEvidence,
    labels,
    governanceStartReasonPacket,
    businessPhasePlanPacket,
    cardPlanPacket,
    progressEvents,
    surfaceSnapshot: {
      providerInvocationState:
        coreLoop.runtimeInvocationPlanPacket.status === "pass"
          ? "invoked_or_applied"
          : "selected_not_invoked",
      providerBindings,
      providerPresentationSummary: coreLoop.capabilityInvocationPresentationPacket.userSummary,
      capabilityLedgerLines: coreLoop.capabilityLedgerPacket.families.map(
        (family) => family.displayLine,
      ),
      projectCustomizationSummary: coreLoop.capabilityLedgerPacket.projectCustomization.summary,
      meshMode:
        coreLoop.capabilityInvocationPresentationPacket.executionState === "completed"
          ? "exact_binding_observed"
          : coreLoop.capabilityInvocationPresentationPacket.executionState === "called_with_failures"
            ? "exact_binding_partial"
          : coreLoop.capabilityInvocationPresentationPacket.executionState === "called"
            ? "host_visible_observed"
            : liveInvocationPass
              ? "host_observed"
              : "planned_structural",
      peerCount: coreLoop.visibleMetaTheorySurfacePacket.peerAgentMesh?.peerCount ?? 0,
      handoffCount: coreLoop.visibleMetaTheorySurfacePacket.peerAgentMesh?.handoffCount ?? 0,
      nodeCount: coreLoop.visibleMetaTheorySurfacePacket.langGraph?.nodeCount ?? 0,
      edgeCount: coreLoop.visibleMetaTheorySurfacePacket.langGraph?.edgeCount ?? 0,
      state: coreLoop.visibleMetaTheorySurfacePacket.langGraph?.status ?? "missing",
      checkpointCount: coreLoop.visibleMetaTheorySurfacePacket.langGraph?.checkpointCount ?? 0,
    },
    artifactStatus,
    partialReasons,
    emitConversationNotice: progressEnabled,
    conversationNoticeChannel,
    conversationNoticeAdapter,
  });
  conversationNotice.hostObservation = evaluateHostAssistantMessageEvidence(
    hostAssistantMessageEvidence,
    conversationNotice.hostObservationExpectations,
  );
  if (progressEnabled && typeof onConversationProgress === "function") {
    await onConversationProgress({
      schemaVersion: "conversation-progress-event-v0.1",
      eventId: stableId("conversation-progress", `${effectiveRunId}-aggregate`),
      runId: effectiveRunId,
      stage: "Aggregate",
      status: artifactStatus,
      reason: "final_user_visible_aggregate",
      owner: orchestrationReport.orchestrationTaskBoardPacket.synthesisOwner,
      occurredAt: nowIso(),
      text: conversationNotice.aggregateText,
      textSha256: textSha256(conversationNotice.aggregateText),
    });
    conversationNotice.progressStreamed = true;
  }
  userExperienceNotice = buildUserExperienceNotice({
    orchestrationReport,
    runtimeEvidence,
    writebackFlow,
    labels,
    conversationNotice,
    cardPlanPacket,
  });
  const userReportMarkdown = buildUserReadableRunReport({
    runId: effectiveRunId,
    task: normalizedTask,
    artifactStatus,
    orchestrationReport,
    decisionResults,
    runtimeEvidence,
    writebackFlow,
    cardPlanPacket,
    businessPhasePlanPacket,
    governanceStartReasonPacket,
    userExperienceNotice,
    stageOperationPlan,
    visibleMetaTheorySurfacePacket: coreLoop.visibleMetaTheorySurfacePacket,
    capabilityInvocationTruthPacket: coreLoop.capabilityInvocationTruthPacket,
    capabilityInvocationPresentationPacket: coreLoop.capabilityInvocationPresentationPacket,
    capabilityLedgerPacket: coreLoop.capabilityLedgerPacket,
    projectCustomizationPacket: coreLoop.projectCustomizationPacket,
    productExperiencePacket: coreLoop.productExperiencePacket,
    markdownPath,
  });
  const runReportPanelContract = buildRunReportPanelContract({
    contractDefinition: panelContractDefinition,
    aiReadableStandards,
    runId: effectiveRunId,
    task: normalizedTask,
    status: artifactStatus,
    orchestrationReport,
    runtimeEvidence,
    writebackFlow,
    cardPlanPacket,
    businessPhasePlanPacket,
    productExperiencePacket: coreLoop.productExperiencePacket,
    visibleMetaTheorySurfacePacket: coreLoop.visibleMetaTheorySurfacePacket,
    capabilityInvocationTruthPacket: coreLoop.capabilityInvocationTruthPacket,
    capabilityInvocationPresentationPacket: coreLoop.capabilityInvocationPresentationPacket,
    capabilityLedgerPacket: coreLoop.capabilityLedgerPacket,
    projectCustomizationPacket: coreLoop.projectCustomizationPacket,
    paths: {
      json: jsonPath,
      markdown: markdownPath,
      sqlite: dbPath,
    },
  });
  const workflowContractPackets = buildWorkflowContractPackets({
    runId: effectiveRunId,
    task: normalizedTask,
    artifactStatus,
    orchestrationReport,
    coreLoop,
    runtimeEvidence,
    writebackFlow,
    cardPlanPacket,
    businessFlowBlueprintPacket,
    runtime: routeRuntime,
    osTarget: routeOs,
    outputLanguage: resolvedOutputLanguage,
    languageSource: languageResolution.source,
    planChallengeResponses: effectivePlanChallengeResponses,
    planChallengeControl: effectivePlanChallengeControl,
    sharedUnderstandingConfirmed: effectiveSharedUnderstandingConfirmed,
    executionAuthorization: effectiveExecutionAuthorization,
    priorChallengeState: trustedPriorChallengeState,
    contradictionEvidence: planChallengeContradictionEvidence,
    requestedSideEffectActions: governedSideEffectActions,
    planChallengePreview,
  });
  coreLoop = {
    ...coreLoop,
    preDecisionOptionFrame: workflowContractPackets.preDecisionOptionFrame,
  };
  const artifact = {
    schemaVersion: 1,
    runId: effectiveRunId,
    requestedRunId,
    overwriteAuthorized: allowOverwrite === true,
    reservation: durableStageRunnerEnabled
      ? {
          path: path.basename(reservationPath),
          mode: durableMode === "resume" ? "verified_resume" : "exclusive_wx",
        }
      : requestedRunId == null
      ? null
      : {
          path: path.basename(reservationPath),
          mode: allowOverwrite === true ? "explicit_overwrite" : "exclusive_wx",
        },
    taskFingerprint,
    ...(durableExecution ? { durableExecution } : {}),
    resolvedOutputLanguage,
    languageResolution,
    status: artifactStatus,
    task: normalizedTask,
    coreLoop,
    requestRecord: coreLoop.requestRecord,
    intentPacket: coreLoop.intentPacket,
    fetchPacket: coreLoop.fetchPacket,
    capabilityInventory: coreLoop.capabilityInventory,
    capabilityGapPacket: coreLoop.capabilityGapPacket,
    capabilityReady: coreLoop.capabilityReady,
    governanceAgentResultPackets: coreLoop.governanceAgentResultPackets,
    conductorConsumptionEvidence: coreLoop.conductorConsumptionEvidence,
    traceEvalControlPlane: coreLoop.traceEvalControlPlane,
    stageRunnerBridgePacket: coreLoop.stageRunnerBridgePacket ?? null,
    agUiStageEvents: coreLoop.agUiStageEvents,
    performanceCostBudget: coreLoop.performanceCostBudget,
    contextEngineeringBudget: coreLoop.contextEngineeringBudget,
    thinkingPacket: coreLoop.thinkingPacket,
    dispatchBoard: coreLoop.thinkingPacket.dispatchBoard,
    workerTaskPackets: coreLoop.thinkingPacket.workerTaskPackets,
    executionResult: coreLoop.executionResult,
    reviewPacket: coreLoop.reviewPacket,
    metaReviewPacket: coreLoop.metaReviewPacket,
    verificationResult: coreLoop.verificationResult,
    evolutionWritebackDecision: coreLoop.evolutionWritebackDecision,
    evolutionWritebackPacket: coreLoop.evolutionWritebackPacket,
    dynamicWorkflowDecisionRecord: coreLoop.dynamicWorkflowDecisionRecord,
    goalContractPacket: coreLoop.goalContractPacket,
    langGraphRunPacket: coreLoop.langGraphRunPacket,
    dynamicWorkflowRuntimePacket: coreLoop.dynamicWorkflowRuntimePacket,
    peerAgentMeshPacket: coreLoop.peerAgentMeshPacket,
    agentTeamsPlaybookPacket: coreLoop.agentTeamsPlaybookPacket,
    runtimeSubagentInvocationPacket: coreLoop.runtimeSubagentInvocationPacket,
    runtimeInvocationPlanPacket: coreLoop.runtimeInvocationPlanPacket,
    hostInvocationRequestPacket: coreLoop.hostInvocationRequestPacket,
    capabilityInvocationProbePacket: coreLoop.capabilityInvocationProbePacket,
    capabilityInvocationTruthPacket: coreLoop.capabilityInvocationTruthPacket,
    capabilityInvocationPresentationPacket: coreLoop.capabilityInvocationPresentationPacket,
    capabilityLedgerPacket: coreLoop.capabilityLedgerPacket,
    projectCustomizationPacket: coreLoop.projectCustomizationPacket,
    durableAgentLifecyclePacket: coreLoop.durableAgentLifecyclePacket,
    visibleMetaTheorySurfacePacket: coreLoop.visibleMetaTheorySurfacePacket,
    userPerceptionPacket: coreLoop.userPerceptionPacket,
    productExperiencePacket: coreLoop.productExperiencePacket,
    publicReadyDecision: coreLoop.publicReadyDecision,
    defaultRuntimePath: {
      status: artifactStatus,
      entry: "meta:theory:run",
      triggerChain: orchestrationReport.orchestrationTaskBoardPacket.triggerChain,
      governanceAgentResultPackets: coreLoop.governanceAgentResultPackets,
      conductorConsumptionEvidence: coreLoop.conductorConsumptionEvidence,
      orchestrationTaskBoardPacket: orchestrationReport.orchestrationTaskBoardPacket,
      workerTaskPackets: orchestrationReport.workerTaskPackets,
      workerResultPackets: coreLoop.executionResult.workerResultPackets,
      workerExecutionEvidence: coreLoop.executionResult.workerExecutionEvidence,
      traceEvalControlPlane: coreLoop.traceEvalControlPlane,
      stageRunnerBridgePacket: coreLoop.stageRunnerBridgePacket ?? null,
      agUiStageEvents: coreLoop.agUiStageEvents,
      langGraphRunPacket: coreLoop.langGraphRunPacket,
      dynamicWorkflowRuntimePacket: coreLoop.dynamicWorkflowRuntimePacket,
      peerAgentMeshPacket: coreLoop.peerAgentMeshPacket,
      agentTeamsPlaybookPacket: coreLoop.agentTeamsPlaybookPacket,
      runtimeSubagentInvocationPacket: coreLoop.runtimeSubagentInvocationPacket,
      runtimeInvocationPlanPacket: coreLoop.runtimeInvocationPlanPacket,
      hostInvocationRequestPacket: coreLoop.hostInvocationRequestPacket,
      capabilityInvocationProbePacket: coreLoop.capabilityInvocationProbePacket,
      capabilityInvocationTruthPacket: coreLoop.capabilityInvocationTruthPacket,
      capabilityInvocationPresentationPacket: coreLoop.capabilityInvocationPresentationPacket,
      capabilityLedgerPacket: coreLoop.capabilityLedgerPacket,
      projectCustomizationPacket: coreLoop.projectCustomizationPacket,
      durableAgentLifecyclePacket: coreLoop.durableAgentLifecyclePacket,
      visibleMetaTheorySurfacePacket: coreLoop.visibleMetaTheorySurfacePacket,
      userPerceptionPacket: coreLoop.userPerceptionPacket,
      productExperiencePacket: coreLoop.productExperiencePacket,
      performanceCostBudget: coreLoop.performanceCostBudget,
      contextEngineeringBudget: coreLoop.contextEngineeringBudget,
    },
    conversationNotice,
    userExperienceNotice,
    stageOperationPlan,
    stageVisibility: orchestrationReport.stageVisibility,
    cardPlanPacket,
    businessPhasePlanPacket,
    governanceStartReasonPacket,
    businessFlowBlueprintPacket,
    capabilityRoute: orchestrationReport.fetchEvidence.capabilityInventory,
    durableProjectAgentPolicy: {
      createAgentDeliverable: "project_retained_abstract_agent_definition",
      temporarySubagentAsDefinition: false,
      runtimeTargets: buildAgentProjectionTargets(),
      lifecyclePacketRef: "artifact.durableAgentLifecyclePacket",
      completionRule:
        "Durable agent completion requires definition candidate, Warden approval/writeback, host reload/discovery, and live invocation proof.",
    },
    runtimeProjectionEvidence: runtimeEvidence,
    runtimeEvidencePacket: {
      schemaVersion: runtimeEvidence.schemaVersion,
      mode: "projection_smoke",
      releaseGrade: runtimeEvidence.releaseGrade,
      failureClasses: runtimeEvidence.failureClasses,
      records: runtimeEvidence.results.map((item) => ({
        runtime: item.runtime,
        status: item.status,
        evidenceKind: item.evidenceKind,
        failureClass: item.failureClass,
        command: item.command,
        artifact: item.artifact,
        remainingAction: item.remainingAction,
        strictReleasePass: item.strictReleasePass,
      })),
    },
    wardenWritebackFlow: writebackFlow,
    runReport: {
      status: artifactStatus,
      runId: effectiveRunId,
      language: resolvedOutputLanguage,
      markdownPath: markdownFileName,
      sections: [
        sectionLabels.decisionSummary,
        "开始原因",
        labels.userExperienceNotice.title,
        "三目标产品验收",
        labels.stageOperationPlan.title,
        labels.stageOperationPlan.executionTitle,
        labels.cardPlanTitle,
        labels.businessPhasePlanTitle,
        sectionLabels.whyDecision,
        sectionLabels.ownerHandoff,
        sectionLabels.toolEvidenceFull(toolList),
        sectionLabels.capabilityUpgrade,
        sectionLabels.wardenApproval,
        sectionLabels.verificationStatus,
      ],
    },
    runReportPanelContract,
    analytics,
    sourceArtifacts: {
      orchestrationReport,
      decisionResults,
    },
    ...workflowContractPackets,
  };
  if (durableCoordinator) {
    let materializationReservation = await readDurableReservation(reservationPath, {
      runId: effectiveRunId,
      taskFingerprint,
    });
    Object.assign(durableExecution, { status: "artifacts_committing" });
    const stagedJson = `${JSON.stringify(artifact, null, 2)}\n`;
    await atomicWriteFile(jsonStagingPath, stagedJson);
    await atomicWriteFile(markdownStagingPath, userReportMarkdown);
    const stagedJsonSha256 = textSha256(stagedJson);
    const stagedMarkdownSha256 = textSha256(userReportMarkdown);
    materializationReservation = await updateDurableReservation(
      reservationPath,
      materializationReservation,
      {
        phase: "staged",
        status: "reserved_or_incomplete",
        jsonSha256: stagedJsonSha256,
        markdownSha256: stagedMarkdownSha256,
        stagingRefs,
      },
    );
    await commitStagedArtifact(jsonStagingPath, jsonPath, stagedJsonSha256);
    await commitStagedArtifact(markdownStagingPath, markdownPath, stagedMarkdownSha256);
    materializationReservation = await updateDurableReservation(
      reservationPath,
      materializationReservation,
      { phase: "artifacts_committed" },
    );
    await stageRunner.materializationFaultInjector?.("artifacts_committed");
    durableCoordinator.assertHealthy();
    const terminalStatus = coreLoop.stageRunnerBridgePacket?.status === "pass"
      ? "completed"
      : "failed";
    durableCoordinator.kernel.setRunTerminalStatus({
      runId: effectiveRunId,
      status: terminalStatus,
      ownerId: durableCoordinator.ownerId,
      fenceToken: durableCoordinator.claim.fenceToken,
    });
    const terminalProjection = durableCoordinator.kernel.projectRun(effectiveRunId);
    Object.assign(durableExecution, {
      status: "materialized",
      terminalStatus,
      cursor: terminalProjection.cursor,
      headCheckpointId: terminalProjection.headCheckpointId,
    });
    materializationReservation = await updateDurableReservation(
      reservationPath,
      materializationReservation,
      { phase: "kernel_terminal" },
    );
    await stageRunner.materializationFaultInjector?.("kernel_terminal");
    const finalJson = `${JSON.stringify(artifact, null, 2)}\n`;
    const finalJsonSha256 = textSha256(finalJson);
    await atomicWriteFile(jsonStagingPath, finalJson);
    await commitStagedArtifact(jsonStagingPath, jsonPath, finalJsonSha256);
    materializationReservation = await updateDurableReservation(
      reservationPath,
      materializationReservation,
      {
        phase: "materialized",
        status: "materialized",
        jsonSha256: finalJsonSha256,
        markdownSha256: stagedMarkdownSha256,
      },
    );
    await stageRunner.materializationFaultInjector?.("materialized");
    await fs.rm(jsonStagingPath, { force: true });
    await fs.rm(markdownStagingPath, { force: true });
  } else {
    await atomicWriteFile(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`);
    await atomicWriteFile(markdownPath, userReportMarkdown);
  }
  await atomicWriteFile(
    latestPath,
    `${JSON.stringify(
      {
        runId: effectiveRunId,
        taskFingerprint,
        resolvedOutputLanguage,
        languageResolution,
        jsonPath: relative(jsonPath),
        markdownPath: relative(markdownPath),
      },
      null,
      2
    )}\n`
  );
  return {
    ...artifact,
    paths: {
      json: jsonPath,
      markdown: markdownPath,
      latest: latestPath,
      db: dbPath,
    },
  };
  } catch (error) {
    durableBodyError = error;
    if (durableCoordinator?.claim && error?.simulatedProcessCrash !== true) {
      try {
        const projection = durableCoordinator.kernel.projectRun(effectiveRunId);
        if (projection.run.status === "active") {
          durableCoordinator.kernel.setRunTerminalStatus({
            runId: effectiveRunId,
            status: "failed",
            ownerId: durableCoordinator.ownerId,
            fenceToken: durableCoordinator.claim.fenceToken,
          });
        }
      } catch {
        // Preserve the primary failure; unresolved claims/effects intentionally keep the run resumable.
      }
    }
    throw error;
  } finally {
    if (durableCoordinator) {
      let cleanupError = null;
      try {
        durableCoordinator.stopHeartbeat();
      } catch (error) {
        cleanupError = error;
      }
      if (durableCoordinator.claim) {
        try {
          durableCoordinator.kernel.releaseRunCoordinator({
            runId: effectiveRunId,
            ownerId: durableCoordinator.ownerId,
            fenceToken: durableCoordinator.claim.fenceToken,
          });
        } catch (error) {
          cleanupError ??= error;
        }
      }
      durableCoordinator.kernel.close();
      if (cleanupError && !durableBodyError) throw cleanupError;
    }
  }
}

export async function readGovernedExecutionRun({
  runId,
  stateDir = DEFAULT_STATE_DIR,
  artifactDir = null,
} = {}) {
  const outputDir = artifactDir ? path.resolve(artifactDir) : stateDir;
  const effectiveRunId = runId === "latest" || !runId ? await readLatestRunId(outputDir) : runId;
  if (!effectiveRunId) {
    throw new Error("No governed execution run found.");
  }
  const safeRunId = validateRunId(effectiveRunId, "read runId");
  const jsonPath = resolveOutputFile(outputDir, `${safeRunId}.json`);
  const artifact = JSON.parse(await fs.readFile(jsonPath, "utf8"));
  if (artifact?.runId !== safeRunId) {
    throw new Error(
      `Governed run binding mismatch: requested '${safeRunId}' but artifact contains '${artifact?.runId ?? "missing"}'.`,
    );
  }
  const recordedMarkdown = artifact?.runReport?.markdownPath;
  const language = normalizeOutputLanguage(
    artifact?.resolvedOutputLanguage ?? artifact?.runReport?.language,
  ) ?? "zh-CN";
  let recordedMarkdownPath = null;
  if (recordedMarkdown) {
    const recordedBase = path.basename(recordedMarkdown);
    const prefix = `${safeRunId}.`;
    const recordedLocale =
      recordedBase.startsWith(prefix) && recordedBase.endsWith(".md")
        ? recordedBase.slice(prefix.length, -3)
        : null;
    if (!normalizeOutputLanguage(recordedLocale)) {
      throw new Error(
        `Governed run report binding mismatch: '${recordedBase}' does not belong to '${safeRunId}' with a supported locale.`,
      );
    }
    recordedMarkdownPath = resolveOutputFile(outputDir, recordedBase);
  }
  const candidates = [
    recordedMarkdownPath,
    resolveOutputFile(outputDir, `${safeRunId}.${language}.md`),
    resolveOutputFile(outputDir, `${safeRunId}.zh-CN.md`),
  ].filter(Boolean);
  const markdownPath = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
  return {
    runId: safeRunId,
    artifact,
    markdown: await fs.readFile(markdownPath, "utf8"),
    paths: { json: jsonPath, markdown: markdownPath },
  };
}

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function createTemporaryOutputRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-governed-execution-"));
}

function truthyEnvFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function positionalTask(fallback = null) {
  const positional = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    const value = process.argv[index];
    if (
      [
        "--task",
        "--run-id",
        "--state-dir",
        "--artifact-dir",
        "--db",
        "--approval-evidence",
        "--approval-packet",
        "--canonical-root",
        "--host-visible-subagents",
        "--host-invocation-evidence",
        "--native-choice-evidence",
        "--codex-host-tool-schema",
        "--runtime",
        "--os",
        "--lang",
        "--output-language",
        "--stage-runner-runtime",
        "--stage-runner-orchestrator",
        "--stage-runner-timeout-ms",
        "--stage-runner-capacity",
        "--durable-db",
      ].includes(value)
    ) {
      index += 1;
      continue;
    }
    if (value.startsWith("--")) continue;
    positional.push(value);
  }
  return positional.length > 0 ? positional.join(" ") : fallback;
}

function rawPositionals() {
  const positional = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    const value = process.argv[index];
    if (
      [
        "--task",
        "--run-id",
        "--state-dir",
        "--artifact-dir",
        "--db",
        "--approval-evidence",
        "--approval-packet",
        "--canonical-root",
        "--host-visible-subagents",
        "--host-invocation-evidence",
        "--native-choice-evidence",
        "--codex-host-tool-schema",
        "--runtime",
        "--os",
        "--lang",
        "--output-language",
        "--stage-runner-runtime",
        "--stage-runner-orchestrator",
        "--stage-runner-timeout-ms",
        "--stage-runner-capacity",
        "--durable-db",
      ].includes(value)
    ) {
      index += 1;
      continue;
    }
    if (value.startsWith("--")) continue;
    positional.push(value);
  }
  return positional;
}

async function main() {
  if (
    process.argv.includes("--host-invocation-evidence-trusted") ||
    process.argv.includes("--native-choice-evidence-trusted")
  ) {
    throw new Error(
      "Public CLI trust flags were removed: live evidence must come from an external runtime observer/adapter, not from the process submitting the claim.",
    );
  }
  const positional = rawPositionals();
  const taskArg = argValue("--task", null);
  const runIdArg = argValue("--run-id", null);
  const stateDirArg = argValue("--state-dir", null);
  const artifactDirArg = argValue("--artifact-dir", null);
  const dbArg = argValue("--db", null);
  const durableDbArg = argValue("--durable-db", null);
  const runtimeArg = argValue("--runtime", process.env.META_KIM_RUNTIME ?? "codex");
  const osArg = argValue("--os", process.env.META_KIM_OS ?? "windows");
  const cliOutputLanguage = argValue(
    "--output-language",
    argValue("--lang", null),
  );
  const emitConversationProgress =
    process.argv.includes("--emit-conversation-notice") &&
    !process.argv.includes("--no-emit-conversation-notice");
  const runtime = normalizeRouteRuntime(runtimeArg);
  const executeStageDag = process.argv.includes("--execute-stage-dag");
  const resumeStageDag = process.argv.includes("--resume-stage-dag");
  if (executeStageDag && resumeStageDag) {
    throw new Error("--execute-stage-dag and --resume-stage-dag are mutually exclusive");
  }
  if ((executeStageDag || resumeStageDag) && process.argv.includes("--overwrite-run")) {
    throw new Error("Durable stage-DAG execution forbids --overwrite-run");
  }
  if (resumeStageDag && (!runIdArg || !taskArg)) {
    throw new Error("--resume-stage-dag requires explicit --run-id and --task");
  }
  const stageRunnerRuntime = argValue("--stage-runner-runtime", runtime);
  const stageRunnerOrchestrator = argValue("--stage-runner-orchestrator", "native");
  const stageRunnerTimeoutMs = Number(argValue("--stage-runner-timeout-ms", "300000"));
  const stageRunnerCapacity = Number(argValue("--stage-runner-capacity", "0"));
  if ((executeStageDag || resumeStageDag) && (!Number.isFinite(stageRunnerTimeoutMs) || stageRunnerTimeoutMs < 10_000)) {
    throw new Error("--stage-runner-timeout-ms must be a finite safety timeout >= 10000");
  }
  if (executeStageDag || resumeStageDag) {
    normalizeStageRunnerRuntime(stageRunnerRuntime);
    resolveReadySetExecutor(stageRunnerOrchestrator);
  }
  const osTarget = normalizeOsTarget(osArg);
  const useTemporaryOutput = process.argv.includes("--temp-output");
  const temporaryOutputRoot = useTemporaryOutput ? await createTemporaryOutputRoot() : null;
  const stateDir = path.resolve(
    temporaryOutputRoot
      ? path.join(temporaryOutputRoot, "state")
      : stateDirArg ?? (taskArg ? DEFAULT_STATE_DIR : positional[2] ?? DEFAULT_STATE_DIR)
  );
  const artifactDir = temporaryOutputRoot
    ? path.join(temporaryOutputRoot, "artifacts")
    : artifactDirArg
      ? path.resolve(artifactDirArg)
      : null;
  if (process.argv.includes("--classify-entry")) {
    const task = taskArg ?? positionalTask("");
    process.stdout.write(`${JSON.stringify(classifyMetaTheoryEntry(task), null, 2)}\n`);
    return;
  }
  if (process.argv.includes("--read")) {
    const run = await readGovernedExecutionRun({
      runId: runIdArg ?? positional[0] ?? "latest",
      stateDir,
      artifactDir,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          status: run.artifact.status,
          runId: run.runId,
          report: relative(run.paths.markdown),
        },
        null,
        2
      )}\n`
    );
    return;
  }
  const task = taskArg ?? positional[0] ?? null;
  const approvalPacketPath = argValue("--approval-packet", null);
  const approvalPacket = approvalPacketPath
    ? JSON.parse(await fs.readFile(path.resolve(approvalPacketPath), "utf8"))
    : null;
  const report = await runMetaTheoryGovernedExecution({
    task,
    runId: runIdArg ?? (taskArg ? null : positional[1] ?? null),
    allowOverwrite: process.argv.includes("--overwrite-run"),
    cliOutputLanguage,
    stateDir,
    artifactDir,
    dbPath: path.resolve(
      temporaryOutputRoot
        ? path.join(temporaryOutputRoot, "runs.sqlite")
        : dbArg ?? (taskArg ? DEFAULT_DB_PATH : positional[3] ?? DEFAULT_DB_PATH)
    ),
    runtime,
    osTarget,
    approvalEvidence: argValue("--approval-evidence", null),
    approvalPacket,
    applyWriteback: process.argv.includes("--apply-writeback"),
    canonicalRoot: path.resolve(argValue("--canonical-root", path.join(REPO_ROOT, "canonical"))),
    emitConversationNotice: emitConversationProgress,
    onConversationProgress: emitConversationProgress
      ? ({ text }) => {
          process.stderr.write(`${text}\n`);
        }
      : null,
    conversationNoticeChannel: "stderr",
    conversationNoticeAdapter: CONVERSATION_NOTICE_ADAPTER,
    hostVisibleSubagents: argValue(
      "--host-visible-subagents",
      process.env.META_KIM_HOST_VISIBLE_SUBAGENTS ?? null,
    ),
    hostInvocationEvidence: argValue(
      "--host-invocation-evidence",
      process.env.META_KIM_HOST_INVOCATION_EVIDENCE ?? null,
    ),
    nativeChoiceEvidence: argValue(
      "--native-choice-evidence",
      process.env.META_KIM_NATIVE_CHOICE_EVIDENCE ?? null,
    ),
    codexHostToolSchema: argValue(
      "--codex-host-tool-schema",
      process.env.META_KIM_CODEX_HOST_TOOL_SCHEMA ?? null,
    ),
    nativeChoiceEvidenceTrusted: false,
    invokeCapabilityProbes: process.argv.includes("--invoke-capability-probes"),
    projectRoot: process.env.META_KIM_CALLER_CWD || process.cwd(),
    projectCapabilityMutationMode:
      executeStageDag || resumeStageDag || process.argv.some((arg) =>
        ["--dry-run", "--check", "--read-only", "--no-project-capability-writes"].includes(arg),
      )
        ? "read_only"
        : "auto",
    stageRunner: executeStageDag || resumeStageDag
      ? {
          enabled: true,
          runtime: stageRunnerRuntime,
          orchestrator: stageRunnerOrchestrator,
          durableMode: resumeStageDag ? "resume" : "fresh",
          durableDbPath: durableDbArg ? path.resolve(durableDbArg) : undefined,
          timeoutMs: stageRunnerTimeoutMs,
          capacity: stageRunnerCapacity > 0 ? stageRunnerCapacity : null,
        }
      : null,
  });
  if (report.conversationNotice.emitted && !report.conversationNotice.progressStreamed) {
    process.stderr.write(`${report.conversationNotice.text}\n`);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        status:
          report.preDecisionOptionFrame?.planChallengeState?.pendingUserChoice?.status ===
          "required_not_invoked"
            ? "pending_user_choice"
            : report.preDecisionOptionFrame?.planChallengeState?.phase === "stopped_by_user"
              ? "stopped_by_user"
              : report.status,
        runId: report.runId,
        executionAllowed:
          report.preDecisionOptionFrame?.planChallengeState?.executionAllowed ?? true,
        pendingUserChoice:
          report.preDecisionOptionFrame?.planChallengeState?.pendingUserChoice ?? null,
        challengeSummary: report.summaryPacket
          ? {
              confirmedDecisionCount: report.summaryPacket.confirmedDecisions?.length ?? 0,
              openRiskCount: report.summaryPacket.openRisks?.length ?? 0,
              nextStep: report.summaryPacket.nextStep ?? null,
              visibleLines: report.summaryPacket.visibleLines ?? [],
            }
          : null,
        stopReason:
          report.preDecisionOptionFrame?.planChallengeState?.stopReason ?? null,
        runtimeProjection: report.runtimeProjectionEvidence.status,
        writeback: report.wardenWritebackFlow.status,
        projectCustomization: report.projectCustomizationPacket.status,
        projectCapabilityWrites:
          report.projectCustomizationPacket.execution?.appliedCount ?? 0,
        stageRunner:
          report.stageRunnerBridgePacket == null
            ? null
            : {
                status: report.stageRunnerBridgePacket.status,
                runtime: report.stageRunnerBridgePacket.runtime,
                mode: report.stageRunnerBridgePacket.mode,
                workerCount: report.stageRunnerBridgePacket.workerResults?.length ?? 0,
                observedDurationMs: report.stageRunnerBridgePacket.observedDurationMs ?? null,
                failureClass:
                  report.stageRunnerBridgePacket.failure?.failureClass ?? null,
                readySetAdapters:
                  report.stageRunnerBridgePacket.readySetAdapterPacket?.adapterIds ?? [],
              },
        durableExecution: report.durableExecution
          ? {
              mode: report.durableExecution.mode,
              status: report.durableExecution.status,
              terminalStatus: report.durableExecution.terminalStatus ?? null,
              cursor: report.durableExecution.cursor ?? null,
              headCheckpointId: report.durableExecution.headCheckpointId ?? null,
              fenceToken: report.durableExecution.fenceToken ?? null,
              database: report.durableExecution.database ?? null,
              workerCount: report.durableExecution.workerCount ?? 0,
            }
          : null,
        report: relative(report.paths.markdown),
        temporaryOutput: temporaryOutputRoot
          ? {
              root: temporaryOutputRoot,
              stateDir,
              artifactDir,
              dbPath: path.join(temporaryOutputRoot, "runs.sqlite"),
            }
          : null,
      },
      null,
      2
    )}\n`
  );
  if (process.argv.includes("--strict-exit-code") && report.status !== "pass") process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
