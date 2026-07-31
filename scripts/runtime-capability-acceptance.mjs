import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProfileName } from "./meta-kim-local-state.mjs";
import { canonicalJson, sha256 as auditSha256 } from "./audit-release-binding.mjs";
import { resolveProjectRoot } from "../canonical/runtime-assets/shared/hooks/project-root.mjs";
import { observeClaudeJsonl, observeCodexJsonl } from "./live-acceptance/observe-host-events.mjs";
import { observeCodexDesktopEngineeringSlice } from "./live-acceptance/read-codex-session-evidence.mjs";
import { assertExactStandardRuntimeObservationSet } from "./runtime-execution-gate.mjs";
import { assertExactMarkerEventLifecycles } from "./live-acceptance/validate-marker-lifecycle.mjs";
import { packedProductProofComplete } from "./packed-product-proof.mjs";

export const ACCEPTANCE_ATTEMPT_SCHEMA_VERSION = "meta-kim-runtime-capability-acceptance-attempt-v1";
export const ACCEPTANCE_INDEX_SCHEMA_VERSION = "meta-kim-runtime-capability-acceptance-index-v1";
export const PRODUCER_RECEIPT_SCHEMA_VERSION = "meta-kim-runtime-capability-producer-receipt-v1";
const CLAIM_SCHEMA_VERSION = 2;
const LIVE_FUSE_CAPABILITIES = new Set(["agent", "subagent", "custom agent"]);
const PACKED_CAPABILITIES = new Set([
  "global install",
  "project install",
  "skill discovery",
  "hook discovery",
  "MCP",
]);
const CONTROLLED_PRODUCER_BY_CAPABILITY = Object.freeze({
  agent: "meta-kim.live-agent.agent",
  subagent: "meta-kim.live-agent.subagent",
  shell: "meta-kim.runtime-native-engineering.shell",
  filesystem: "meta-kim.runtime-native-engineering.filesystem",
  "apply_patch / edit": "meta-kim.runtime-native-engineering.apply-patch-edit",
});
const CODEX_DESKTOP_COMPOSITE_PRODUCER_ID = "meta-kim.codex-home-sessions.agent-subagent";
const CODEX_ENGINEERING_COMPOSITE_PRODUCER_ID = "meta-kim.codex-engineering.shell-filesystem-edit";
const CODEX_DESKTOP_ENGINEERING_PRODUCER_ID = "meta-kim.codex-desktop-engineering.shell-filesystem-edit";
const CONTROLLED_WRITE_TOKEN = Symbol("meta-kim-controlled-producer-write");
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function inside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertSafeId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return value;
}

function assertPlainDirectory(directoryPath, label) {
  const stats = lstatSync(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a plain directory, not a symlink, junction, or reparse point`);
  }
  return realpathSync.native(directoryPath);
}

function ensurePlainDirectory(directoryPath, label, containmentRoot = null) {
  mkdirSync(directoryPath, { recursive: true });
  const real = assertPlainDirectory(directoryPath, label);
  if (containmentRoot && !inside(real, containmentRoot)) {
    throw new Error(`${label} escapes its project/profile state root`);
  }
  return real;
}

export function resolveRuntimeCapabilityAcceptancePaths({
  projectRoot,
  profile = process.env.META_KIM_PROFILE,
} = {}) {
  const explicit = projectRoot ?? process.env.META_KIM_CALLER_CWD ?? null;
  const selectedRoot = resolveProjectRoot({
    cwd: process.cwd(),
    explicitDeclarations: explicit ? [explicit] : [],
  });
  if (!selectedRoot) throw new Error("runtime capability acceptance requires a trusted explicit or marker-backed project root");
  const resolvedProjectRoot = realpathSync.native(path.resolve(selectedRoot));
  const safeProfile = resolveProfileName(profile);
  const profileRoot = path.join(resolvedProjectRoot, ".meta-kim", "state", safeProfile);
  const root = path.join(profileRoot, "runtime-capability-acceptance");
  return {
    projectRoot: resolvedProjectRoot,
    profile: safeProfile,
    profileRoot,
    root,
    attemptsDir: path.join(root, "attempts"),
    indexPath: path.join(root, "index.json"),
  };
}

export function prepareRuntimeCapabilityAcceptanceStore(options = {}) {
  const paths = resolveRuntimeCapabilityAcceptancePaths(options);
  ensurePlainDirectory(paths.profileRoot, "runtime capability profile state root", paths.projectRoot);
  const realRoot = ensurePlainDirectory(paths.root, "runtime capability acceptance root", paths.projectRoot);
  const realAttempts = ensurePlainDirectory(paths.attemptsDir, "runtime capability acceptance attempts root", realRoot);
  return { ...paths, realRoot, realAttempts };
}

function readJson(filePath, label) {
  let value;
  try {
    value = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function readDigestBoundBytes(filePath, allowedRoot, label) {
  const requested = path.resolve(filePath);
  const stats = lstatSync(requested);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  const real = realpathSync.native(requested);
  if (!inside(real, allowedRoot)) throw new Error(`${label} escapes the allowed profile state root`);
  const handle = openSync(real, "r");
  let bytes;
  try {
    const before = fstatSync(handle);
    if (!before.isFile()) throw new Error(`${label} changed before it could be read`);
    bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(handle, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== bytes.length) throw new Error(`${label} changed while it was read`);
    const after = fstatSync(handle);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || before.dev !== after.dev) {
      throw new Error(`${label} changed while it was read`);
    }
  } finally {
    closeSync(handle);
  }
  return { real, bytes, sha256: digest(bytes) };
}

function readDigestBoundFile(filePath, allowedRoot, label) {
  const loaded = readDigestBoundBytes(filePath, allowedRoot, label);
  let value;
  try { value = JSON.parse(loaded.bytes.toString("utf8")); }
  catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return { ...loaded, value };
}

function readBoundSessionLines(sessionFile, snapshotSize, bindings, sessionsRoot, label) {
  const requested = path.resolve(sessionFile);
  const stats = lstatSync(requested);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  const real = realpathSync.native(requested);
  if (real !== requested || !inside(real, sessionsRoot)) throw new Error(`${label} escapes trusted Codex sessions`);
  const wanted = new Map(bindings.map((entry) => [entry.lineNumber, entry.sha256]));
  const captured = new Map();
  const handle = openSync(real, "r");
  try {
    const before = fstatSync(handle);
    if (!before.isFile() || before.size < snapshotSize) throw new Error(`${label} is shorter than its bound snapshot`);
    const chunk = Buffer.alloc(64 * 1024);
    let position = 0;
    let pending = Buffer.alloc(0);
    let lineNumber = 0;
    while (position < snapshotSize && captured.size < wanted.size) {
      const count = readSync(handle, chunk, 0, Math.min(chunk.length, snapshotSize - position), position);
      if (count === 0) break;
      position += count;
      pending = Buffer.concat([pending, chunk.subarray(0, count)]);
      let newline;
      while ((newline = pending.indexOf(0x0a)) >= 0) {
        const lineBytes = pending.subarray(0, newline + 1);
        pending = pending.subarray(newline + 1);
        lineNumber += 1;
        if (wanted.has(lineNumber)) {
          if (digest(lineBytes) !== wanted.get(lineNumber)) throw new Error(`${label} source line ${lineNumber} digest mismatch`);
          captured.set(lineNumber, lineBytes.subarray(0, lineBytes.length - 1).toString("utf8").replace(/\r$/u, ""));
        }
      }
    }
    const after = fstatSync(handle);
    if (before.ino !== after.ino || before.dev !== after.dev || after.size < snapshotSize) throw new Error(`${label} changed while it was read`);
  } finally {
    closeSync(handle);
  }
  if (captured.size !== wanted.size) throw new Error(`${label} source line binding is incomplete`);
  return bindings.map((entry) => captured.get(entry.lineNumber));
}

function validateCodexDesktopSourceBindings(receipt, rawText) {
  const lifecycle = receipt.compositeLifecycle;
  const configuredHome = receipt.testOnly === true ? (process.env.CODEX_HOME || path.join(os.homedir(), ".codex")) : path.join(os.homedir(), ".codex");
  const home = assertPlainDirectory(path.resolve(configuredHome), "trusted Codex home");
  if (home !== path.resolve(configuredHome)) throw new Error("trusted Codex home cannot be a symlink or junction");
  const sessions = assertPlainDirectory(path.join(home, "sessions"), "trusted Codex sessions");
  if (!inside(sessions, home)) throw new Error("trusted Codex sessions escape Codex home");
  for (const ref of [lifecycle.parentSessionRef, lifecycle.childSessionRef]) {
    if (path.isAbsolute(ref) || ref.includes("\\") || ref.split("/").includes("..")) throw new Error("Codex Desktop session reference is unsafe");
  }
  const parentLines = readBoundSessionLines(
    path.join(sessions, ...lifecycle.parentSessionRef.split("/")),
    lifecycle.parentSnapshotSize,
    lifecycle.parentSourceLines,
    sessions,
    "Codex Desktop parent session",
  );
  const childLines = readBoundSessionLines(
    path.join(sessions, ...lifecycle.childSessionRef.split("/")),
    lifecycle.childSnapshotSize,
    lifecycle.childSourceLines,
    sessions,
    "Codex Desktop child session",
  );
  const parentFragment = `${parentLines.join("\n")}\n`;
  const childFragment = `${childLines.join("\n")}\n`;
  if (digest(parentFragment) !== lifecycle.parentFragmentDigest || digest(childFragment) !== lifecycle.childFragmentDigest) {
    throw new Error("Codex Desktop session fragment digest mismatch");
  }
  if (`${parentFragment}${childFragment}` !== rawText || digest(rawText) !== lifecycle.rawCompositeDigest) throw new Error("Codex Desktop composite raw source mismatch");
  const parentEvents = observeCodexJsonl(parentFragment).filter((event) =>
    event.eventId === lifecycle.eventId && event.sessionId === lifecycle.threadId &&
    event.childSessionId === lifecycle.childSessionId && event.hostSurface === "collaboration.spawn_agent" &&
    event.completionBoundary === "returned_child_final" && event.resultStatus === "returned");
  if (parentEvents.length !== 1) throw new Error("Codex Desktop parent lifecycle no longer proves native spawn and return");
  const childRecords = childLines.map((line) => JSON.parse(line));
  const childMeta = childRecords.find((entry) => entry?.type === "session_meta")?.payload;
  const final = childRecords.filter((entry) => entry?.type === "event_msg" && entry?.payload?.type === "agent_message" && entry?.payload?.phase === "final_answer" && entry?.payload?.message === receipt.capabilityMarker);
  const complete = childRecords.filter((entry) => entry?.type === "event_msg" && entry?.payload?.type === "task_complete" && entry?.payload?.last_agent_message === receipt.capabilityMarker);
  if (childMeta?.id !== lifecycle.childSessionId || childMeta?.source?.subagent?.thread_spawn?.parent_thread_id !== lifecycle.threadId || final.length !== 1 || complete.length !== 1) {
    throw new Error("Codex Desktop child session no longer proves the exact completed marker");
  }
  const expected = receipt.eventEvidence[0];
  const sourceLines = rawText.split(/\r?\n/u);
  const selectedText = expected.sourceLines.map((line) => sourceLines[line - 1] ?? "").join("\n");
  if (!selectedText.includes(receipt.capabilityMarker) && receipt.capability === "subagent") throw new Error("Codex Desktop subagent facet is not marker-bound");
  if (receipt.capability === "agent" && (!selectedText.includes("spawn_agent") || !selectedText.includes(lifecycle.childSessionId))) throw new Error("Codex Desktop agent facet is not parent-spawn-bound");
}

function validateCodexDesktopEngineeringBindings(receipt, rawText, profileRoot, { portableAdvisorySnapshot = false } = {}) {
  const lifecycle = receipt.compositeLifecycle;
  if (path.isAbsolute(lifecycle.workspaceRef) || lifecycle.workspaceRef.includes("\\") || lifecycle.workspaceRef.split("/").includes("..")) {
    throw new Error("Codex Desktop engineering workspace reference is unsafe");
  }
  const workspacePath = path.resolve(profileRoot, ...lifecycle.workspaceRef.split("/"));
  if (!inside(workspacePath, profileRoot) || (!portableAdvisorySnapshot && digest(workspacePath.replaceAll("\\", "/").toLowerCase()) !== lifecycle.workspaceDigest)) {
    throw new Error("Codex Desktop engineering workspace binding mismatch");
  }
  const configuredHome = receipt.testOnly === true ? (process.env.CODEX_HOME || path.join(os.homedir(), ".codex")) : path.join(os.homedir(), ".codex");
  const home = assertPlainDirectory(path.resolve(configuredHome), "trusted Codex home");
  const sessions = assertPlainDirectory(path.join(home, "sessions"), "trusted Codex sessions");
  if (path.isAbsolute(lifecycle.parentSessionRef) || lifecycle.parentSessionRef.includes("\\") || lifecycle.parentSessionRef.split("/").includes("..")) {
    throw new Error("Codex Desktop engineering session reference is unsafe");
  }
  const parentLines = readBoundSessionLines(
    path.join(sessions, ...lifecycle.parentSessionRef.split("/")),
    lifecycle.parentSnapshotSize,
    lifecycle.parentSourceLines,
    sessions,
    "Codex Desktop engineering parent session",
  );
  const fragment = `${parentLines.join("\n")}\n`;
  if (digest(fragment) !== lifecycle.parentFragmentDigest || fragment !== rawText) throw new Error("Codex Desktop engineering fragment binding mismatch");
  const meta = JSON.parse(parentLines[0]);
  if (meta?.type !== "session_meta" || meta?.payload?.id !== lifecycle.threadId || meta?.payload?.originator !== "Codex Desktop" || meta?.payload?.source !== "vscode") {
    throw new Error("Codex Desktop engineering parent source is invalid");
  }
  // A packed read-only snapshot intentionally relocates the profile root. The
  // immutable raw/session digests remain exact, but the original absolute
  // workspace path is historical and cannot equal the isolated project path.
  // This branch can only feed advisory observations; the execution gate never
  // treats it as current-host authority.
  if (portableAdvisorySnapshot) return;
  const events = observeCodexDesktopEngineeringSlice(fragment, { marker: receipt.capabilityMarker, workspacePath });
  const ordered = [events.shell, events.patchAdd, events.filesystemBefore, events.patchUpdate, events.filesystemAfter];
  if (JSON.stringify(ordered.map((entry) => entry.eventId)) !== JSON.stringify(lifecycle.orderedEventIds)) {
    throw new Error("Codex Desktop engineering event order binding mismatch");
  }
  const expectedById = new Map(receipt.eventEvidence.map((entry) => [entry.eventId, entry]));
  for (const actual of ordered.filter((entry) => expectedById.has(entry.eventId))) {
    const expected = expectedById.get(actual.eventId);
    for (const field of ["family", "hostSurface", "providerId", "resultStatus", "inputDigest", "outputDigest", "facet"]) {
      if (actual[field] !== expected[field]) throw new Error(`Codex Desktop engineering event ${actual.eventId} ${field} mismatch`);
    }
    if (JSON.stringify(actual.sourceLines) !== JSON.stringify(expected.sourceLines)) throw new Error(`Codex Desktop engineering event ${actual.eventId} source line mismatch`);
  }
}

function runtimeKey(runtime) {
  return runtime === "claude_code" ? "claude" : runtime;
}

export function normalizeRuntimeCapabilityRuntimeId(runtime) {
  return runtime === "claude" ? "claude_code" : runtime;
}

function runtimeVersionFrom(report, runtime) {
  const key = runtimeKey(runtime);
  const runtimeReport = report[key] ?? {};
  return runtimeReport.runtimeVersion ??
    runtimeReport.cliVersion ??
    runtimeReport.sample?.runtime_session_evidence?.cliVersion ??
    runtimeReport.sample?.runtime_smoke?.cliVersion ??
    report.runtimeVersions?.[runtime] ??
    report.runtimeVersions?.[key] ??
    null;
}

function validateLiveFuseReport(report, runtime, capability) {
  const key = runtimeKey(runtime);
  const record = report.runtimeEvidencePacket?.records?.find((entry) => entry.runtime === key);
  const runtimeReport = report[key];
  if (
    report.mode !== "live" ||
    report.primaryReleaseFuse !== true ||
    report.runtimeEvidencePacket?.schemaVersion !== "runtime-evidence-v0.1" ||
    record?.strictReleasePass !== true ||
    record?.evidenceKind !== "live" ||
    runtimeReport?.status !== "passed" ||
    runtimeReport?.releaseFuseInvocationObserved !== true ||
    runtimeReport?.fixture === true ||
    runtimeReport?.recoveredFromTimeout === true
  ) {
    throw new Error("runtime live-fuse report is not a strict live pass");
  }
  if (!LIVE_FUSE_CAPABILITIES.has(capability)) {
    throw new Error(`runtime live-fuse cannot attest capability ${capability}`);
  }
  const observedAt = report.timestamp;
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error("runtime live-fuse report timestamp is invalid");
  const runtimeVersion = runtimeVersionFrom(report, runtime);
  return { observedAt, runtimeVersion: typeof runtimeVersion === "string" && runtimeVersion.trim() ? runtimeVersion : "unreported", reportSchemaVersion: "runtime-evidence-v0.1" };
}

function validateVerificationAttemptHash(report) {
  if (report.schemaVersion !== "meta-kim-verification-report-v2" || typeof report.attemptRecordHash !== "string") {
    throw new Error("packed verification report is not a v2 digest-bound attempt");
  }
  const { attemptRecordHash, ...withoutHash } = report;
  if (digest(JSON.stringify(withoutHash)) !== attemptRecordHash) {
    throw new Error("packed verification report attempt hash is invalid");
  }
}

function validatePackedReport(report, runtime, capability) {
  validateVerificationAttemptHash(report);
  const proof = report.releasePreflight?.packedUserProof;
  const globalProof = report.releasePreflight?.globalTargetProof;
  if (
    report.ok !== true ||
    report.releaseGrade !== true ||
    !packedProductProofComplete(proof) ||
    globalProof?.status !== "passed" ||
    !globalProof.targets?.map(normalizeRuntimeCapabilityRuntimeId).includes(normalizeRuntimeCapabilityRuntimeId(runtime))
  ) {
    throw new Error("packed update/global readback report is not release-grade and runtime-complete");
  }
  if (!PACKED_CAPABILITIES.has(capability)) {
    throw new Error(`packed update/global readback cannot attest capability ${capability}`);
  }
  const runtimeVersion = runtimeVersionFrom(report, runtime);
  return {
    observedAt: report.completedAt,
    runtimeVersion: typeof runtimeVersion === "string" && runtimeVersion.trim() ? runtimeVersion : "unreported",
    reportSchemaVersion: report.schemaVersion,
  };
}

function validateControlledProducerReceipt(receipt, runtime, capability, mode) {
  if (
    receipt.schemaVersion !== PRODUCER_RECEIPT_SCHEMA_VERSION ||
    receipt.attestationAuthority !== "controlled_producer" ||
    receipt.outcome !== "pass" ||
    typeof receipt.recordHash !== "string"
  ) throw new Error("controlled producer receipt shape is invalid");
  const { recordHash, ...withoutHash } = receipt;
  if (digest(JSON.stringify(withoutHash)) !== recordHash) throw new Error("controlled producer receipt hash is invalid");
  for (const [field, expected] of [["runtime", runtime], ["capability", capability], ["mode", mode]]) {
    if (receipt[field] !== expected) throw new Error(`controlled producer receipt ${field} binding mismatch`);
  }
  const composite = [CODEX_DESKTOP_COMPOSITE_PRODUCER_ID, CODEX_ENGINEERING_COMPOSITE_PRODUCER_ID, CODEX_DESKTOP_ENGINEERING_PRODUCER_ID].includes(receipt.producer?.id);
  if (!composite && receipt.producer?.id !== CONTROLLED_PRODUCER_BY_CAPABILITY[capability]) {
    throw new Error("controlled producer id is not allowlisted");
  }
  if (!/^\d+\.\d+\.\d+$/u.test(String(receipt.producer?.version ?? ""))) throw new Error("controlled producer version is invalid");
  if (!Number.isFinite(Date.parse(receipt.observedAt)) || !receipt.runtimeVersion) throw new Error("controlled producer receipt lacks observedAt/runtimeVersion");
  if (!receipt.hostInvocation?.requestDigest || !receipt.hostInvocation?.resultDigest || receipt.hostInvocation?.exitCode !== 0) {
    throw new Error("controlled producer receipt lacks a successful host invocation binding");
  }
  const executableIdentity = receipt.hostInvocation?.executableIdentity;
  const setupInventoryIdentity = executableIdentity?.bindingSource === "setup_or_host_adapter" ||
    (executableIdentity?.bindingSource === "setup_runtime_launch_inventory" && executableIdentity?.executionAuthority === false);
  if (!composite && Number.parseInt(receipt.producer.version, 10) >= 2 && (!executableIdentity || typeof executableIdentity.realpath !== "string" || !/^[a-f0-9]{64}$/u.test(String(executableIdentity.sha256 ?? "")) ||
      (receipt.testOnly !== true && (!path.isAbsolute(executableIdentity.realpath) || !setupInventoryIdentity)))) {
    throw new Error("controlled producer receipt lacks a setup launch-inventory executable identity");
  }
  if (!Array.isArray(receipt.eventEvidence) || receipt.eventEvidence.length === 0 || receipt.eventEvidence.some((entry) => !entry.eventId || !entry.inputDigest || !entry.outputDigest || !["accepted", "completed", "returned"].includes(entry.resultStatus) || !Array.isArray(entry.sourceLines))) {
    throw new Error("controlled producer receipt lacks completed capability-specific event evidence");
  }
  if (!composite && receipt.eventEvidence.some((entry) =>
    !(entry.resultTextSha256 === null || /^[a-f0-9]{64}$/u.test(String(entry.resultTextSha256 ?? ""))) ||
    !Array.isArray(entry.resultSourceLines) ||
    typeof entry.lifecycleEvidence !== "string" || !entry.lifecycleEvidence ||
    typeof entry.completionBoundary !== "string" || !entry.completionBoundary ||
    typeof entry.activityCompletionObserved !== "boolean"
  )) throw new Error("controlled producer receipt lacks replay-complete event evidence");
  if (!receipt.rawArtifact?.path || !/^[a-f0-9]{64}$/iu.test(String(receipt.rawArtifact?.sha256 ?? ""))) throw new Error("controlled producer receipt lacks raw artifact binding");
  if (!/^[0-9a-f-]{36}$/iu.test(String(receipt.capabilityNonce ?? ""))) throw new Error("controlled producer receipt lacks capability nonce");
  const expectedMarker = receipt.producer?.id === CODEX_DESKTOP_COMPOSITE_PRODUCER_ID
    ? `META_KIM_CAPABILITY_SUBAGENT_${receipt.capabilityNonce}`
    : [CODEX_ENGINEERING_COMPOSITE_PRODUCER_ID, CODEX_DESKTOP_ENGINEERING_PRODUCER_ID].includes(receipt.producer?.id)
      ? `META_KIM_CAPABILITY_ENGINEERING_${receipt.capabilityNonce}`
    : `META_KIM_CAPABILITY_${capability.replace(/[^a-z0-9]+/giu, "_").toUpperCase()}_${receipt.capabilityNonce}`;
  if (receipt.capabilityMarker !== expectedMarker) throw new Error("controlled producer capability marker mismatch");
  if (digest(JSON.stringify(receipt.hostInvocation.request)) !== receipt.hostInvocation.requestDigest || digest(JSON.stringify(receipt.hostInvocation.result)) !== receipt.hostInvocation.resultDigest) throw new Error("controlled producer host invocation digest mismatch");
  if (receipt.hostInvocation.result.stdoutSha256 !== receipt.rawArtifact.sha256) throw new Error("controlled producer stdout/raw artifact binding mismatch");
  if (["agent", "subagent"].includes(capability) && receipt.eventEvidence.some((entry) =>
    typeof entry.childSessionId !== "string" || !entry.childSessionId || entry.childSessionId.length > 256 || /[\u0000-\u001f\u007f]/u.test(entry.childSessionId) ||
    typeof entry.sessionId !== "string" || !entry.sessionId || entry.sessionId.length > 256 || /[\u0000-\u001f\u007f]/u.test(entry.sessionId)
  )) throw new Error("agent/subagent producer receipt lacks valid parent/child session binding");
  if (!composite && ["agent", "subagent"].includes(capability) && receipt.eventEvidence.some((entry) =>
    entry.resultTextSha256 !== digest(receipt.capabilityMarker) ||
    entry.resultSourceLines.length === 0
  )) throw new Error("agent/subagent producer receipt result is not the exact capability marker");
  if (receipt.producer?.id === CODEX_DESKTOP_COMPOSITE_PRODUCER_ID) validateCodexDesktopCompositeReceipt(receipt, runtime, capability);
  if (receipt.producer?.id === CODEX_ENGINEERING_COMPOSITE_PRODUCER_ID) validateCodexEngineeringCompositeReceipt(receipt, runtime, capability);
  if (receipt.producer?.id === CODEX_DESKTOP_ENGINEERING_PRODUCER_ID) validateCodexDesktopEngineeringReceipt(receipt, runtime, capability);
  const flags = receipt.flags ?? {};
  for (const field of ["fixture", "recoveredFromTimeout", "blockedFromRelease"]) if (typeof flags[field] !== "boolean") throw new Error(`controlled producer receipt flag ${field} must be explicit`);
  if (flags.fixture || flags.recoveredFromTimeout || flags.blockedFromRelease || receipt.failureClass != null) throw new Error("controlled producer receipt is not promotion eligible");
  if (receipt.promotion != null) {
    const promotion = receipt.promotion;
    if (
      promotion.kind !== "published_bound" ||
      typeof promotion.baseAttemptId !== "string" ||
      promotion.fromAttemptId !== promotion.baseAttemptId ||
      (promotion.parentPromotionAttemptId !== null && typeof promotion.parentPromotionAttemptId !== "string") ||
      !Number.isSafeInteger(promotion.generation) || promotion.generation < 1 ||
      typeof promotion.releaseAuditAttemptId !== "string" ||
      typeof promotion.verificationAttemptId !== "string"
    ) throw new Error("controlled producer promotion lineage is invalid");
  }
  return { observedAt: receipt.observedAt, runtimeVersion: receipt.runtimeVersion, reportSchemaVersion: receipt.schemaVersion };
}

function validLineBindings(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 32 && value.every((entry) =>
    Number.isSafeInteger(entry?.lineNumber) && entry.lineNumber > 0 && /^[a-f0-9]{64}$/u.test(String(entry?.sha256 ?? "")));
}

function validateCodexDesktopCompositeReceipt(receipt, runtime, capability) {
  const lifecycle = receipt.compositeLifecycle;
  const event = receipt.eventEvidence?.[0];
  const binding = lifecycle?.facetBindings?.[capability];
  const agentBinding = lifecycle?.facetBindings?.agent;
  const subagentBinding = lifecycle?.facetBindings?.subagent;
  if (
    runtime !== "codex" || !["agent", "subagent"].includes(capability) ||
    receipt.mode !== "interactive_host" || receipt.hostInvocation?.runtimeIsolation !== "codex_desktop_current_session" ||
    receipt.producer?.family !== "agent_subagent" || JSON.stringify(receipt.producer?.compositeFacets) !== JSON.stringify(["agent", "subagent"]) ||
    lifecycle?.allowlisted !== true || lifecycle?.facet !== capability ||
    JSON.stringify(lifecycle?.facets) !== JSON.stringify(["agent", "subagent"]) ||
    lifecycle?.sourceCategory !== "codex_home_sessions" ||
    lifecycle?.markerDigest !== digest(receipt.capabilityMarker) ||
    lifecycle?.observedAt !== receipt.observedAt || !Number.isFinite(Date.parse(lifecycle?.observedAt ?? "")) ||
    lifecycle?.childSessionId !== event?.childSessionId || binding?.eventId !== event?.eventId || JSON.stringify(binding?.sourceLines) !== JSON.stringify(event?.sourceLines) ||
    event?.family !== "agent_subagent" || event?.facet !== capability || receipt.eventEvidence.length !== 1 ||
    (capability === "agent" && (event?.sessionId !== lifecycle?.threadId || event?.hostSurface !== "collaboration.spawn_agent" || event?.resultStatus !== "accepted" || event?.completionBoundary !== "parent_spawn_accepted_and_started")) ||
    (capability === "subagent" && (event?.sessionId !== lifecycle?.childSessionId || event?.hostSurface !== "codex.child.task_complete" || event?.resultStatus !== "completed" || event?.completionBoundary !== "child_final_and_task_complete")) ||
    !agentBinding?.eventId || !subagentBinding?.eventId || agentBinding.eventId === subagentBinding.eventId || agentBinding.sourceLines.some((line) => subagentBinding.sourceLines.includes(line)) ||
    lifecycle?.rawCompositeDigest !== receipt.rawArtifact.sha256 ||
    !/^[0-9a-f-]{36}$/u.test(String(lifecycle?.threadId ?? "")) || !/^[0-9a-f-]{36}$/u.test(String(lifecycle?.childSessionId ?? "")) ||
    !/^[a-f0-9]{64}$/u.test(String(lifecycle?.childFragmentDigest ?? "")) ||
    !Number.isSafeInteger(lifecycle?.parentSnapshotSize) || lifecycle.parentSnapshotSize <= 0 ||
    !Number.isSafeInteger(lifecycle?.childSnapshotSize) || lifecycle.childSnapshotSize <= 0 ||
    !validLineBindings(lifecycle?.parentSourceLines) || !validLineBindings(lifecycle?.childSourceLines) ||
    typeof lifecycle?.parentSessionRef !== "string" || typeof lifecycle?.childSessionRef !== "string"
  ) throw new Error("Codex Desktop composite producer lifecycle is invalid");
}

function validateCodexEngineeringCompositeReceipt(receipt, runtime, capability) {
  const lifecycle = receipt.compositeLifecycle;
  const facets = ["shell", "filesystem", "apply_patch / edit"];
  const bindings = lifecycle?.eventBindings;
  const allBoundIds = facets.flatMap((facet) => bindings?.[facet] ?? []);
  const expectedIds = bindings?.[capability] ?? [];
  const receiptIds = receipt.eventEvidence?.map((entry) => entry.eventId) ?? [];
  if (
    runtime !== "codex" || !facets.includes(capability) || receipt.mode !== "interactive_host" ||
    receipt.producer?.family !== "runtime_tool" || JSON.stringify(receipt.producer?.compositeFacets) !== JSON.stringify(facets) ||
    lifecycle?.allowlisted !== true || lifecycle?.facet !== capability || JSON.stringify(lifecycle?.facets) !== JSON.stringify(facets) ||
    lifecycle?.sourceCategory !== "codex_single_host_invocation" || lifecycle?.markerDigest !== digest(receipt.capabilityMarker) ||
    lifecycle?.observedAt !== receipt.observedAt || !Number.isFinite(Date.parse(lifecycle?.observedAt ?? "")) ||
    !lifecycle?.lifecycleId || JSON.stringify(receiptIds) !== JSON.stringify(expectedIds) ||
    bindings?.shell?.length !== 1 || bindings?.filesystem?.length !== 2 || bindings?.["apply_patch / edit"]?.length !== 1 ||
    allBoundIds.length !== 4 || new Set(allBoundIds).size !== 4 || JSON.stringify(lifecycle?.orderedEventIds) !== JSON.stringify([
      bindings.shell[0], bindings.filesystem[0], bindings["apply_patch / edit"][0], bindings.filesystem[1],
    ]) ||
    lifecycle?.beforeContentSha256 !== digest(`before-${receipt.capabilityMarker}`) ||
    lifecycle?.finalContentSha256 !== digest(`after-${receipt.capabilityMarker}`) ||
    receipt.workspaceOutcome?.kind !== "bounded_file" || receipt.workspaceOutcome?.contentSha256 !== lifecycle?.finalContentSha256 ||
    receipt.eventEvidence.some((entry) => entry.facet !== capability || entry.family !== "runtime_tool" || entry.sessionId == null)
  ) throw new Error("Codex engineering composite producer lifecycle is invalid");
}

function validateCodexDesktopEngineeringReceipt(receipt, runtime, capability) {
  const lifecycle = receipt.compositeLifecycle;
  const facets = ["shell", "filesystem", "apply_patch / edit"];
  const bindings = lifecycle?.eventBindings;
  const expectedIds = bindings?.[capability] ?? [];
  const receiptIds = receipt.eventEvidence?.map((entry) => entry.eventId) ?? [];
  const allIds = facets.flatMap((facet) => bindings?.[facet] ?? []);
  if (
    runtime !== "codex" || !facets.includes(capability) || receipt.mode !== "interactive_host" ||
    receipt.producer?.family !== "runtime_tool" || JSON.stringify(receipt.producer?.compositeFacets) !== JSON.stringify(facets) ||
    lifecycle?.allowlisted !== true || lifecycle?.facet !== capability || JSON.stringify(lifecycle?.facets) !== JSON.stringify(facets) ||
    lifecycle?.sourceCategory !== "codex_desktop_sessions" || lifecycle?.markerDigest !== digest(receipt.capabilityMarker) ||
    lifecycle?.observedAt !== receipt.observedAt || !Number.isFinite(Date.parse(lifecycle?.observedAt ?? "")) ||
    !/^[0-9a-f-]{36}$/u.test(String(lifecycle?.threadId ?? "")) || !lifecycle?.workspaceDigest || typeof lifecycle?.workspaceRef !== "string" ||
    bindings?.shell?.length !== 1 || bindings?.filesystem?.length !== 2 || bindings?.["apply_patch / edit"]?.length !== 2 ||
    allIds.length !== 5 || new Set(allIds).size !== 5 || JSON.stringify(receiptIds) !== JSON.stringify(expectedIds) ||
    JSON.stringify(lifecycle?.orderedEventIds) !== JSON.stringify([bindings.shell[0], bindings["apply_patch / edit"][0], bindings.filesystem[0], bindings["apply_patch / edit"][1], bindings.filesystem[1]]) ||
    lifecycle?.beforeContentSha256 !== digest(`before-${receipt.capabilityMarker}\n`) || lifecycle?.finalContentSha256 !== digest(`after-${receipt.capabilityMarker}\n`) ||
    receipt.workspaceOutcome?.contentSha256 !== lifecycle?.finalContentSha256 || lifecycle?.parentFragmentDigest !== receipt.rawArtifact.sha256 ||
    !Number.isSafeInteger(lifecycle?.parentSnapshotSize) || !validLineBindings(lifecycle?.parentSourceLines) || typeof lifecycle?.parentSessionRef !== "string" ||
    receipt.hostInvocation?.runtimeIsolation !== "codex_desktop_current_session" ||
    receipt.eventEvidence.some((entry) => entry.facet !== capability || entry.family !== "runtime_tool" || entry.resultStatus !== "completed")
  ) throw new Error("Codex Desktop engineering composite producer lifecycle is invalid");
}

function rawEventProvesCapability(runtime, capability, event, sourceText, marker) {
  const surface = String(event?.hostSurface ?? "").toLowerCase();
  if (["agent", "subagent"].includes(capability)) return event?.family === "agent_subagent" &&
    /agent|task|spawn/u.test(surface) &&
    Boolean(event.childSessionId) &&
    event.resultTextSha256 === digest(marker);
  if (capability === "shell") return event?.family === "runtime_tool" && /bash|shell|command/u.test(surface);
  if (capability === "filesystem") {
    if (runtime === "claude_code") return event?.family === "runtime_tool" && /^(read|glob|grep)$/u.test(surface);
    return event?.family === "runtime_tool" && /shell|command/u.test(surface) && /\b(?:get-content|cat|type|read)\b/iu.test(sourceText) && !/(?:>|set-content|out-file|remove-item|del\b|rm\b)/iu.test(sourceText);
  }
  if (capability === "apply_patch / edit") return event?.family === "runtime_tool" && (runtime === "codex" ? /file_change|apply_patch|patch/u.test(surface) : /edit|write|patch/u.test(surface));
  return false;
}

function assertNoMarkerBoundFailure(rawText, marker) {
  for (const line of String(rawText).split(/\r?\n/u)) {
    if (!line.includes(marker)) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const payload = record?.payload ?? record;
    const item = record?.item ?? payload?.item ?? payload;
    const status = String(item?.status ?? payload?.status ?? "").toLowerCase();
    const exitCode = item?.exit_code ?? payload?.exit_code ?? payload?.exitCode;
    const failed = ["declined", "failed", "cancelled", "canceled", "error"].includes(status) ||
      (Number.isInteger(exitCode) && exitCode !== 0) || item?.is_error === true || payload?.is_error === true ||
      (payload?.type === "patch_apply_end" && payload?.success === false) ||
      (payload?.type === "tool_result" && payload?.is_error === true);
    if (failed) throw new Error("marker-bound host lifecycle contains declined, failed, cancelled, or nonzero evidence");
  }
}

function validateCodexEngineeringCompositeRaw(receipt, observedEvents, rawText) {
  const lifecycle = receipt.compositeLifecycle;
  const byId = new Map(observedEvents.map((event) => [event.eventId, event]));
  const lines = rawText.split(/\r?\n/u);
  const source = (event) => (event?.sourceLines ?? []).map((line) => lines[line - 1] ?? "").join("\n");
  const [shellId, beforeReadId, editId, afterReadId] = lifecycle.orderedEventIds;
  const shell = byId.get(shellId);
  const beforeRead = byId.get(beforeReadId);
  const edit = byId.get(editId);
  const afterRead = byId.get(afterReadId);
  const start = (event) => Math.min(...(event?.sourceLines ?? []).filter(Number.isSafeInteger));
  const order = [shell, beforeRead, edit, afterRead].map(start);
  const filePattern = /meta-kim-engineering-probe\.txt/iu;
  const shellSource = source(shell);
  const beforeSource = source(beforeRead);
  const editSource = source(edit);
  const afterSource = source(afterRead);
  if (
    [shell, beforeRead, edit, afterRead].some((event) => !event || event.family !== "runtime_tool" || event.resultStatus !== "completed") ||
    order.some((line) => !Number.isFinite(line)) || order.some((line, index) => index > 0 && line <= order[index - 1]) ||
    !/shell|command/u.test(String(shell?.hostSurface ?? "").toLowerCase()) || !filePattern.test(shellSource) ||
    !/set-content|out-file|writealltext|(?:^|\s)>/iu.test(shellSource) || !shellSource.includes(`before-${receipt.capabilityMarker}`) ||
    !/shell|command/u.test(String(beforeRead?.hostSurface ?? "").toLowerCase()) || !filePattern.test(beforeSource) ||
    !/get-content|readalltext|\bcat\b|\btype\b/iu.test(beforeSource) || !beforeSource.includes(`before-${receipt.capabilityMarker}`) || beforeSource.includes(`after-${receipt.capabilityMarker}`) ||
    !/file_change|apply_patch|patch|edit/u.test(String(edit?.hostSurface ?? "").toLowerCase()) || !filePattern.test(editSource) ||
    !editSource.includes(`before-${receipt.capabilityMarker}`) || !editSource.includes(`after-${receipt.capabilityMarker}`) ||
    !/shell|command/u.test(String(afterRead?.hostSurface ?? "").toLowerCase()) || !filePattern.test(afterSource) ||
    !/get-content|readalltext|\bcat\b|\btype\b/iu.test(afterSource) || !afterSource.includes(`after-${receipt.capabilityMarker}`)
  ) throw new Error("Codex engineering composite raw lifecycle is invalid");
}

function loadSafetyContract() {
  return readJson(path.join(packageRoot, "config", "contracts", "runtime-execution-safety-contract.json"), "runtime execution safety contract");
}

function validateReleaseAudit(report) {
  if (
    report.status !== "published_bound" ||
    report.promotionEligible !== true ||
    typeof report.attemptId !== "string" ||
    typeof report.recordHash !== "string"
  ) {
    throw new Error("release-grade acceptance requires a published-bound release audit attempt");
  }
  const { recordHash, ...withoutHash } = report;
  if (auditSha256(canonicalJson(withoutHash)) !== recordHash) {
    throw new Error("release audit attempt hash is invalid");
  }
  return report;
}

function validateExactReleaseBinding({ audit, verification, verificationSha256, runtimeVersion }) {
  const commit = verification.releasePreflight?.sourceSnapshot?.end?.head ?? null;
  const packageDigest = verification.releasePreflight?.packedUserProof?.currentPackage?.packageSha256 ?? null;
  if (!/^[a-f0-9]{40,64}$/iu.test(String(commit ?? "")) || !/^[a-f0-9]{64}$/iu.test(String(packageDigest ?? ""))) {
    throw new Error("release-grade acceptance is missing exact commit/package bindings");
  }
  if (
    audit.evidence?.git?.peeledCommitSha !== commit ||
    audit.evidence?.packageAsset?.sha256 !== packageDigest ||
    audit.evidence?.verification?.sha256 !== verificationSha256 ||
    audit.evidence?.verification?.exact !== true
  ) {
    throw new Error("release audit does not exactly bind the verification commit/package/report");
  }
  return {
    runtimeVersion,
    commit,
    packageDigest,
    releaseAuditAttemptId: audit.attemptId,
    verificationAttemptId: verification.attemptId,
  };
}

function readExistingAttempts(paths) {
  if (!existsSync(paths.attemptsDir)) return [];
  const attempts = [];
  const quarantineDir = path.join(paths.root, "quarantine");
  for (const entry of readdirSync(paths.attemptsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const attemptPath = path.join(paths.attemptsDir, entry.name);
    try {
      attempts.push(readRuntimeCapabilityAcceptanceAttempt(attemptPath, {
        allowedRoot: paths.realRoot ?? realpathSync.native(paths.root),
      }));
    } catch {
      ensurePlainDirectory(quarantineDir, "runtime capability acceptance quarantine root", paths.realRoot ?? realpathSync.native(paths.root));
      renameSync(attemptPath, path.join(quarantineDir, `${entry.name}.${randomUUID()}.invalid`));
    }
  }
  return attempts;
}

function atomicWrite(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = openSync(temporary, "wx", 0o600);
    writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    renameSync(temporary, filePath);
  } finally {
    if (handle !== undefined) closeSync(handle);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function acquireStoreLock(paths) {
  const lockPath = path.join(paths.realRoot, "write.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    let handle;
    try {
      handle = openSync(lockPath, "wx", 0o600);
      writeFileSync(handle, `${JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
      fsyncSync(handle);
      return { handle, lockPath, token };
    } catch (error) {
      if (handle !== undefined) closeSync(handle);
      if (error?.code !== "EEXIST") throw error;
      let snapshot;
      try { snapshot = readFileSync(lockPath, "utf8"); } catch { continue; }
      let stale = false;
      try {
        const current = JSON.parse(snapshot);
        const age = Date.now() - Date.parse(current.createdAt);
        let alive = true;
        try { process.kill(current.pid, 0); } catch (probeError) { alive = probeError?.code === "EPERM"; }
        stale = !alive || !Number.isFinite(age) || age > 300_000;
      } catch { stale = true; }
      if (!stale) throw new Error("runtime capability acceptance store is locked by another writer");
      try {
        if (readFileSync(lockPath, "utf8") === snapshot) unlinkSync(lockPath);
      } catch {}
    }
  }
  throw new Error("runtime capability acceptance store lock could not be safely recovered");
}

function releaseStoreLock(lock) {
  if (!lock) return;
  closeSync(lock.handle);
  try {
    const current = JSON.parse(readFileSync(lock.lockPath, "utf8"));
    if (current.token === lock.token) unlinkSync(lock.lockPath);
  } catch {}
}

function pointerFor(record) {
  return {
    attemptId: record.attemptId,
    correlationId: record.correlationId,
    record: `attempts/${record.attemptId}.json`,
    recordHash: record.recordHash,
    runtime: record.runtime,
    capability: record.capability,
    mode: record.mode,
    observedAt: record.observedAt,
    releaseGrade: record.releaseGrade,
  };
}

export function readRuntimeCapabilityAcceptanceAttempt(filePath, { allowedRoot } = {}) {
  const root = allowedRoot ?? realpathSync.native(path.dirname(path.dirname(filePath)));
  const loaded = readDigestBoundFile(filePath, root, "runtime capability acceptance attempt");
  const record = loaded.value;
  if (
    record.schemaVersion !== ACCEPTANCE_ATTEMPT_SCHEMA_VERSION ||
    record.claimSchemaVersion !== CLAIM_SCHEMA_VERSION ||
    record.digestBoundSnapshot !== true ||
    record.outcome !== "pass" ||
    typeof record.recordHash !== "string"
  ) {
    throw new Error("runtime capability acceptance attempt shape is invalid");
  }
  assertSafeId(record.attemptId, "acceptance attemptId");
  assertSafeId(record.correlationId, "acceptance correlationId");
  const { recordHash, ...withoutHash } = record;
  if (digest(JSON.stringify(withoutHash)) !== recordHash) {
    throw new Error("runtime capability acceptance attempt record hash is invalid");
  }
  if (record.artifactSha256 !== loaded.sha256) {
    // artifactSha256 is populated only in the in-memory observation projection;
    // the stored record cannot recursively hash itself.
    if (record.artifactSha256 != null) throw new Error("acceptance attempt contains a recursive artifact digest");
  }
  return { ...record, artifactPath: loaded.real, artifactFileSha256: loaded.sha256 };
}

export function writeRuntimeCapabilityAcceptanceAttempt({
  projectRoot,
  profile,
  reportPath,
  sourceKind,
  runtime,
  capability,
  mode = "interactive_host",
  attemptId = `${new Date().toISOString().replace(/[-:.]/gu, "")}-${randomUUID()}`,
  correlationId = randomUUID(),
  releaseGrade = false,
  releaseAuditPath = null,
  releaseVerificationPath = null,
  _controlledWriteToken = null,
} = {}) {
  if (!["claude_code", "codex", "openclaw", "cursor"].includes(runtime)) throw new Error("unsupported runtime acceptance target");
  if (!["project_projection", "global_install", "interactive_host", "headless_live", "compatibility_smoke"].includes(mode)) throw new Error("unsupported runtime acceptance mode");
  if (sourceKind === "controlled_producer_receipt" && _controlledWriteToken !== CONTROLLED_WRITE_TOKEN) throw new Error("controlled producer receipts require the internal attester path");
  const paths = prepareRuntimeCapabilityAcceptanceStore({ projectRoot, profile });
  const reportRoot = assertPlainDirectory(paths.profileRoot, "runtime capability profile state root");
  const loadedReport = readDigestBoundFile(reportPath, reportRoot, "runtime capability source report");
  const reportResult = sourceKind === "controlled_producer_receipt"
    ? validateControlledProducerReceipt(loadedReport.value, runtime, capability, mode)
    : sourceKind === "runtime_live_fuse"
    ? validateLiveFuseReport(loadedReport.value, runtime, capability)
    : sourceKind === "packed_update_global_readback"
      ? validatePackedReport(loadedReport.value, runtime, capability)
      : (() => { throw new Error(`unsupported runtime acceptance sourceKind ${sourceKind}`); })();
  const observedMs = Date.parse(reportResult.observedAt);
  if (!Number.isFinite(observedMs)) throw new Error("source report observedAt is invalid");
  const lock = acquireStoreLock(paths);
  try {
    const existing = readExistingAttempts(paths);
    assertSafeId(attemptId, "acceptance attemptId");
    assertSafeId(correlationId, "acceptance correlationId");
    if (existing.some((entry) => entry.attemptId === attemptId)) throw new Error("acceptance attemptId already exists");
    if (existing.some((entry) => entry.correlationId === correlationId)) throw new Error("acceptance correlationId already exists");

    let releaseBinding = null;
    let releaseEvidence = null;
    if (releaseGrade) {
      if (!releaseAuditPath) throw new Error("release-grade acceptance requires releaseAuditPath");
      const loadedAudit = readDigestBoundFile(releaseAuditPath, reportRoot, "release audit attempt");
      const audit = validateReleaseAudit(loadedAudit.value);
      const loadedVerification = sourceKind === "packed_update_global_readback"
        ? loadedReport
        : releaseVerificationPath
          ? readDigestBoundFile(releaseVerificationPath, reportRoot, "release verification attempt")
          : (() => { throw new Error("release-grade live acceptance requires releaseVerificationPath"); })();
      validateVerificationAttemptHash(loadedVerification.value);
      const verification = loadedVerification.value;
      releaseBinding = validateExactReleaseBinding({
        audit,
        verification,
        verificationSha256: loadedVerification.sha256,
        runtimeVersion: reportResult.runtimeVersion,
      });
      releaseEvidence = {
        verificationPath: path.relative(paths.profileRoot, loadedVerification.real).replaceAll("\\", "/"),
        verificationSha256: loadedVerification.sha256,
        auditPath: path.relative(paths.profileRoot, loadedAudit.real).replaceAll("\\", "/"),
        auditSha256: loadedAudit.sha256,
      };
    }

    const createdAt = new Date().toISOString();
    const recordWithoutHash = {
    schemaVersion: ACCEPTANCE_ATTEMPT_SCHEMA_VERSION,
    claimSchemaVersion: CLAIM_SCHEMA_VERSION,
    digestBoundSnapshot: true,
    attemptId,
    correlationId,
    createdAt,
    observedAt: reportResult.observedAt,
    runtime,
    runtimeVersion: reportResult.runtimeVersion,
    capability,
    mode,
      outcome: "pass",
      attestationAuthority: sourceKind === "controlled_producer_receipt" ? "controlled_producer" : "external_reference",
      producer: sourceKind === "controlled_producer_receipt" ? loadedReport.value.producer : null,
      testOnly: sourceKind === "controlled_producer_receipt" ? loadedReport.value.testOnly === true : false,
      rawArtifactSha256: sourceKind === "controlled_producer_receipt" ? loadedReport.value.rawArtifact.sha256 : null,
      compositeLifecycle: sourceKind === "controlled_producer_receipt" ? loadedReport.value.compositeLifecycle ?? null : null,
      promotion: sourceKind === "controlled_producer_receipt" ? loadedReport.value.promotion ?? null : null,
    sourceReport: {
      kind: sourceKind,
      path: path.relative(paths.profileRoot, loadedReport.real).replaceAll("\\", "/"),
      sha256: loadedReport.sha256,
      schemaVersion: reportResult.reportSchemaVersion,
      observedAt: reportResult.observedAt,
    },
    releaseGrade: releaseGrade === true,
      releaseBinding,
      releaseEvidence,
    };
    const record = { ...recordWithoutHash, recordHash: digest(JSON.stringify(recordWithoutHash)) };
    const recordPath = path.join(paths.attemptsDir, `${attemptId}.json`);
    if (existsSync(recordPath)) throw new Error("acceptance attemptId already exists");
    atomicWrite(recordPath, record);
    const stored = readRuntimeCapabilityAcceptanceAttempt(recordPath, { allowedRoot: paths.realRoot });
    const all = [...existing, stored].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)) || left.attemptId.localeCompare(right.attemptId));
    const latestByClaim = {};
    for (const entry of all) latestByClaim[`${entry.runtime}:${entry.capability}:${entry.mode}`] = pointerFor(entry);
    atomicWrite(paths.indexPath, {
      schemaVersion: ACCEPTANCE_INDEX_SCHEMA_VERSION,
      claimSchemaVersion: CLAIM_SCHEMA_VERSION,
      updatedAt: createdAt,
      attemptCount: all.length,
      latestByClaim,
    });
    return { record: stored, recordPath, indexPath: paths.indexPath, paths };
  } finally {
    releaseStoreLock(lock);
  }
}

function writeControlledRuntimeCapabilityAcceptanceAttempt(options = {}) {
  return writeRuntimeCapabilityAcceptanceAttempt({
    ...options,
    reportPath: options.receiptPath,
    sourceKind: "controlled_producer_receipt",
    _controlledWriteToken: CONTROLLED_WRITE_TOKEN,
  });
}

export function writeTestOnlyControlledRuntimeCapabilityAcceptanceAttempt(options = {}) {
  const paths = prepareRuntimeCapabilityAcceptanceStore({ projectRoot: options.projectRoot, profile: options.profile });
  const receipt = readDigestBoundFile(options.receiptPath, paths.profileRoot, "test-only controlled producer receipt").value;
  if (receipt.testOnly !== true) throw new Error("public test helper cannot write a production controlled acceptance");
  return writeControlledRuntimeCapabilityAcceptanceAttempt(options);
}

/** Formal product boundary. Callers choose a supported source; producer and writer stay fixed internally. */
export async function produceRuntimeCapabilityAcceptance(options = {}) {
  const allowed = new Set(["live_controlled", "codex_desktop_agent_subagent", "codex_desktop_engineering"]);
  if (!allowed.has(options.source)) throw new Error("unsupported controlled production source");
  if (Object.hasOwn(options, "executor") || Object.hasOwn(options, "reader") || Object.hasOwn(options, "codexHome")) {
    throw new Error("production capability API does not accept injected executor, reader, or codexHome");
  }
  const producer = await import("./runtime-capability-producers.mjs");
  return producer.produceRuntimeCapabilityWithAcceptanceWriter(options, writeControlledRuntimeCapabilityAcceptanceAttempt);
}

export function selectVerificationBoundControlledAttempts(attempts, controlledProducerEvidence) {
  const boundResults = controlledProducerEvidence?.results;
  if (controlledProducerEvidence?.ok !== true || controlledProducerEvidence?.readOnly !== true || !Array.isArray(controlledProducerEvidence?.missing) || controlledProducerEvidence.missing.length !== 0 || !Array.isArray(boundResults) || boundResults.length === 0) {
    throw new Error("release verification does not contain a complete read-only controlled producer status");
  }
  assertExactStandardRuntimeObservationSet(boundResults);
  const eligible = new Map(attempts.filter((entry) => entry.attestationAuthority === "controlled_producer" && entry.testOnly !== true && entry.releaseGrade !== true).map((entry) => [entry.attemptId, entry]));
  const selected = [];
  const claims = new Set();
  for (const binding of boundResults) {
    const attempt = eligible.get(binding.attemptId);
    const key = `${binding.runtime}:${binding.capability}:${binding.mode}`;
    if (claims.has(key)) throw new Error(`release verification duplicates controlled producer claim ${key}`);
    claims.add(key);
    if (!attempt || attempt.runtime !== binding.runtime || attempt.capability !== binding.capability || attempt.mode !== binding.mode || attempt.sourceReport.sha256 !== binding.receiptSha256 || attempt.producer?.id !== binding.producer || attempt.sourceReport.kind !== binding.source) {
      throw new Error(`release verification controlled producer binding mismatch for ${key}`);
    }
    selected.push(attempt);
  }
  return selected;
}

export function nextControlledPromotionLineage(base, attempts, { releaseAuditAttemptId, verificationAttemptId } = {}) {
  if (!base?.attemptId || !base?.runtime || !base?.capability || !base?.mode || !releaseAuditAttemptId || !verificationAttemptId) {
    throw new Error("controlled promotion lineage inputs are incomplete");
  }
  const prior = attempts
    .filter((entry) => entry.releaseGrade === true && entry.runtime === base.runtime && entry.capability === base.capability && entry.mode === base.mode && entry.promotion?.baseAttemptId === base.attemptId)
    .sort((left, right) => left.promotion.generation - right.promotion.generation);
  for (let index = 0; index < prior.length; index += 1) {
    const expectedGeneration = index + 1;
    const expectedParent = index === 0 ? null : prior[index - 1].attemptId;
    if (prior[index].promotion.generation !== expectedGeneration || prior[index].promotion.parentPromotionAttemptId !== expectedParent) {
      throw new Error("controlled promotion lineage is not consecutive");
    }
  }
  return {
    kind: "published_bound",
    fromAttemptId: base.attemptId,
    baseAttemptId: base.attemptId,
    parentPromotionAttemptId: prior.at(-1)?.attemptId ?? null,
    generation: prior.length + 1,
    releaseAuditAttemptId,
    verificationAttemptId,
  };
}

export function promoteControlledRuntimeCapabilityAcceptancesForPublishedRelease({
  projectRoot,
  profile,
  auditRecordPath,
} = {}) {
  const paths = prepareRuntimeCapabilityAcceptanceStore({ projectRoot, profile });
  const auditRoot = path.join(paths.profileRoot, "release-binding-audit");
  const auditAttemptsRoot = path.join(auditRoot, "attempts");
  const loadedAudit = readDigestBoundFile(auditRecordPath, assertPlainDirectory(auditAttemptsRoot, "release audit attempts root"), "release audit attempt");
  const audit = validateReleaseAudit(loadedAudit.value);
  const pointer = readJson(path.join(auditRoot, "latest-published-bound.json"), "latest published release audit pointer");
  if (pointer.attemptId !== audit.attemptId || pointer.recordHash !== audit.recordHash || path.resolve(auditRecordPath) !== path.join(auditAttemptsRoot, `${audit.attemptId}.json`)) {
    throw new Error("release promotion requires the current published-bound audit pointer");
  }
  const verificationRoot = assertPlainDirectory(path.join(paths.profileRoot, "verification-reports", "attempts"), "verification report attempts root");
  const expectedVerificationSha = audit.evidence?.verification?.sha256;
  const verificationFile = readdirSync(verificationRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(verificationRoot, entry.name))
    .find((candidate) => readDigestBoundBytes(candidate, verificationRoot, "verification attempt candidate").sha256 === expectedVerificationSha);
  if (!verificationFile) throw new Error("published audit verification digest has no exact local verification attempt");
  const verification = readDigestBoundFile(verificationFile, verificationRoot, "release verification attempt");
  validateVerificationAttemptHash(verification.value);
  const store = loadRuntimeCapabilityAcceptanceAttempts({ projectRoot: paths.projectRoot, profile: paths.profile });
  const producerStage = verification.value.results?.find((entry) => entry.name === "meta:runtime:produce");
  const selected = selectVerificationBoundControlledAttempts(store.attempts, producerStage?.controlledProducerEvidence);
  const promoted = [];
  for (const base of selected) {
    const baseReceipt = readDigestBoundFile(path.resolve(paths.profileRoot, base.sourceReport.path), paths.profileRoot, "base controlled producer receipt").value;
    validateControlledProducerReceipt(baseReceipt, base.runtime, base.capability, base.mode);
    const promotionAttemptId = `${new Date().toISOString().replace(/[-:.]/gu, "")}-${randomUUID()}`;
    const promotionCorrelationId = randomUUID();
    const promotion = nextControlledPromotionLineage(base, store.attempts, {
      releaseAuditAttemptId: audit.attemptId,
      verificationAttemptId: verification.value.attemptId,
    });
    const { recordHash: _baseHash, ...receiptBody } = baseReceipt;
    const promotedWithoutHash = {
      ...receiptBody,
      attemptId: promotionAttemptId,
      correlationId: promotionCorrelationId,
      promotion,
    };
    const promotedReceipt = { ...promotedWithoutHash, recordHash: digest(JSON.stringify(promotedWithoutHash)) };
    const receiptPath = path.join(paths.profileRoot, "runtime-capability-producers", "receipts", `${promotionAttemptId}.json`);
    ensurePlainDirectory(path.dirname(receiptPath), "runtime capability producer receipts root", paths.profileRoot);
    atomicWrite(receiptPath, promotedReceipt);
    const result = writeControlledRuntimeCapabilityAcceptanceAttempt({
      projectRoot: paths.projectRoot,
      profile: paths.profile,
      receiptPath,
      runtime: base.runtime,
      capability: base.capability,
      mode: base.mode,
      attemptId: promotionAttemptId,
      correlationId: promotionCorrelationId,
      releaseGrade: true,
      releaseVerificationPath: verificationFile,
      releaseAuditPath: loadedAudit.real,
    });
    promoted.push({ attemptId: result.record.attemptId, runtime: base.runtime, capability: base.capability, mode: base.mode, promotion });
  }
  assertExactStandardRuntimeObservationSet(promoted);
  return { status: "promoted", auditAttemptId: audit.attemptId, verificationAttemptId: verification.value.attemptId, promoted };
}

export function validateRuntimeCapabilityAcceptanceAttemptEvidence(attempt, {
  profileRoot,
  now = new Date().toISOString(),
  releaseResolution = false,
  freshnessMs,
  releaseFreshnessMs,
  portableAdvisorySnapshot = false,
} = {}) {
  const issues = [];
  const contract = loadSafetyContract();
  const root = assertPlainDirectory(profileRoot, "runtime capability profile state root");
  const nowMs = Date.parse(now);
  const observedMs = Date.parse(attempt.observedAt);
  const createdMs = Date.parse(attempt.createdAt);
  const maxAge = releaseResolution
    ? (releaseFreshnessMs ?? contract.releaseAcceptanceFreshnessMs)
    : (freshnessMs ?? contract.acceptanceFreshnessMs);
  if (!Number.isFinite(nowMs) || !Number.isFinite(observedMs) || !Number.isFinite(createdMs)) issues.push("acceptance timestamps are invalid");
  else {
    if (observedMs > nowMs || createdMs > nowMs) issues.push("acceptance timestamps are future-dated");
    if (nowMs - observedMs > maxAge) issues.push("acceptance source observation is stale");
  }
  try {
    const source = readDigestBoundFile(path.resolve(root, attempt.sourceReport.path), root, "runtime capability source report");
    if (source.sha256 !== attempt.sourceReport.sha256) throw new Error("source report SHA-256 mismatch");
    const result = attempt.sourceReport.kind === "controlled_producer_receipt"
      ? validateControlledProducerReceipt(source.value, attempt.runtime, attempt.capability, attempt.mode)
      : attempt.sourceReport.kind === "runtime_live_fuse"
      ? validateLiveFuseReport(source.value, attempt.runtime, attempt.capability)
      : attempt.sourceReport.kind === "packed_update_global_readback"
        ? validatePackedReport(source.value, attempt.runtime, attempt.capability)
        : (() => { throw new Error("unsupported acceptance source kind"); })();
    if (result.observedAt !== attempt.observedAt || result.observedAt !== attempt.sourceReport.observedAt) issues.push("source report observedAt binding mismatch");
    if (result.runtimeVersion !== attempt.runtimeVersion) issues.push("source report runtimeVersion binding mismatch");
    if (attempt.sourceReport.kind === "controlled_producer_receipt") {
      const raw = readDigestBoundBytes(path.resolve(root, source.value.rawArtifact.path), root, "controlled producer raw artifact");
      if (raw.sha256 !== source.value.rawArtifact.sha256 || raw.sha256 !== attempt.rawArtifactSha256) issues.push("controlled producer raw artifact SHA-256 mismatch");
      const rawText = raw.bytes.toString("utf8");
      assertNoMarkerBoundFailure(rawText, source.value.capabilityMarker);
      const observedEvents = attempt.runtime === "codex" ? observeCodexJsonl(rawText) : observeClaudeJsonl(rawText);
      if (source.value.producer?.id === CODEX_DESKTOP_ENGINEERING_PRODUCER_ID) {
        validateCodexDesktopEngineeringBindings(source.value, rawText, root, { portableAdvisorySnapshot });
      } else if (source.value.producer?.id === CODEX_DESKTOP_COMPOSITE_PRODUCER_ID) {
        validateCodexDesktopSourceBindings(source.value, rawText);
      } else {
        assertExactMarkerEventLifecycles(rawText, source.value.capabilityMarker);
        for (const expected of source.value.eventEvidence) {
          const actual = observedEvents.find((entry) => entry.eventId === expected.eventId);
          const arraysMatch = (left, right) => JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
          if (
            !actual ||
            actual.family !== expected.family ||
            actual.hostSurface !== expected.hostSurface ||
            actual.providerId !== expected.providerId ||
            actual.inputDigest !== expected.inputDigest ||
            actual.outputDigest !== expected.outputDigest ||
            actual.resultStatus !== expected.resultStatus ||
            actual.sessionId !== expected.sessionId ||
            actual.childSessionId !== expected.childSessionId ||
            !arraysMatch(actual.sourceLines, expected.sourceLines) ||
            (Object.hasOwn(expected, "resultTextSha256") && actual.resultTextSha256 !== expected.resultTextSha256) ||
            (Object.hasOwn(expected, "resultSourceLines") && !arraysMatch(actual.resultSourceLines, expected.resultSourceLines)) ||
            (Object.hasOwn(expected, "lifecycleEvidence") && actual.lifecycleEvidence !== expected.lifecycleEvidence) ||
            (Object.hasOwn(expected, "completionBoundary") && actual.completionBoundary !== expected.completionBoundary) ||
            (Object.hasOwn(expected, "activityCompletionObserved") && actual.activityCompletionObserved !== expected.activityCompletionObserved)
          ) {
            issues.push(`controlled producer event ${expected.eventId} does not match raw host evidence`);
          }
          if (["agent", "subagent"].includes(attempt.capability) && actual?.resultTextSha256 !== digest(source.value.capabilityMarker)) {
            issues.push(`controlled producer event ${expected.eventId} child result is not the exact capability marker`);
          }
          const sourceLines = expected.sourceLines.map((line) => rawText.split(/\r?\n/u)[line - 1] ?? "").join("\n");
          if (!sourceLines.includes(source.value.capabilityMarker)) issues.push(`controlled producer event ${expected.eventId} is not capability-marker-bound`);
          if (!rawEventProvesCapability(attempt.runtime, attempt.capability, actual, sourceLines, source.value.capabilityMarker)) issues.push(`controlled producer event ${expected.eventId} does not prove ${attempt.capability}`);
        }
      }
      if (source.value.producer?.id === CODEX_ENGINEERING_COMPOSITE_PRODUCER_ID) validateCodexEngineeringCompositeRaw(source.value, observedEvents, rawText);
    }
  } catch (error) {
    issues.push(error.message);
  }
  if (releaseResolution) {
    if (attempt.releaseGrade !== true || !attempt.releaseBinding || !attempt.releaseEvidence) issues.push("release resolution requires release-grade acceptance");
    else {
      for (const field of contract.releasePolicy.requiredBindings) if (!attempt.releaseBinding[field]) issues.push(`release binding missing ${field}`);
      try {
        const verification = readDigestBoundFile(path.resolve(root, attempt.releaseEvidence.verificationPath), root, "release verification attempt");
        if (verification.sha256 !== attempt.releaseEvidence.verificationSha256) throw new Error("release verification SHA-256 mismatch");
        validateVerificationAttemptHash(verification.value);
        const audit = readDigestBoundFile(path.resolve(root, attempt.releaseEvidence.auditPath), root, "release audit attempt");
        if (audit.sha256 !== attempt.releaseEvidence.auditSha256) throw new Error("release audit SHA-256 mismatch");
        validateReleaseAudit(audit.value);
        const binding = validateExactReleaseBinding({
          audit: audit.value,
          verification: verification.value,
          verificationSha256: verification.sha256,
          runtimeVersion: attempt.runtimeVersion,
        });
        if (JSON.stringify(binding) !== JSON.stringify(attempt.releaseBinding)) throw new Error("stored release binding does not match current exact evidence");
      } catch (error) {
        issues.push(error.message);
      }
    }
  }
  return { valid: issues.length === 0, issues };
}

export function loadRuntimeCapabilityAcceptanceAttempts(options = {}) {
  const paths = resolveRuntimeCapabilityAcceptancePaths(options);
  if (!existsSync(paths.root)) return { paths, attempts: [], index: null };
  const realRoot = assertPlainDirectory(paths.root, "runtime capability acceptance root");
  const realAttempts = assertPlainDirectory(paths.attemptsDir, "runtime capability acceptance attempts root");
  if (!inside(realAttempts, realRoot)) throw new Error("runtime capability attempts escape acceptance root");
  const attempts = readExistingAttempts({ ...paths, realRoot, realAttempts });
  const attemptIds = new Set();
  const correlations = new Set();
  const rawArtifacts = new Map();
  for (const attempt of attempts) {
    if (attemptIds.has(attempt.attemptId)) throw new Error("duplicate runtime capability acceptance attemptId");
    if (correlations.has(attempt.correlationId)) throw new Error("duplicate runtime capability acceptance correlationId");
    attemptIds.add(attempt.attemptId);
    correlations.add(attempt.correlationId);
    if (attempt.rawArtifactSha256) {
      const prior = rawArtifacts.get(attempt.rawArtifactSha256);
      if (prior && (prior.capability !== attempt.capability || prior.runtime !== attempt.runtime || prior.mode !== attempt.mode)) {
        const pair = new Set([prior.capability, attempt.capability]);
        const allowedDesktopReuse = prior.runtime === "codex" && attempt.runtime === "codex" &&
          prior.mode === "interactive_host" && attempt.mode === "interactive_host" &&
          prior.producer?.id === CODEX_DESKTOP_COMPOSITE_PRODUCER_ID && attempt.producer?.id === CODEX_DESKTOP_COMPOSITE_PRODUCER_ID &&
          prior.compositeLifecycle?.allowlisted === true && attempt.compositeLifecycle?.allowlisted === true &&
          prior.compositeLifecycle?.lifecycleId === attempt.compositeLifecycle?.lifecycleId &&
          prior.compositeLifecycle?.facet === prior.capability && attempt.compositeLifecycle?.facet === attempt.capability &&
          pair.size === 2 && pair.has("agent") && pair.has("subagent");
        const engineeringFacets = new Set(["shell", "filesystem", "apply_patch / edit"]);
        const engineeringCompositeIds = new Set([CODEX_ENGINEERING_COMPOSITE_PRODUCER_ID, CODEX_DESKTOP_ENGINEERING_PRODUCER_ID]);
        const allowedEngineeringReuse = prior.runtime === "codex" && attempt.runtime === "codex" &&
          prior.mode === "interactive_host" && attempt.mode === "interactive_host" &&
          prior.producer?.id === attempt.producer?.id && engineeringCompositeIds.has(prior.producer?.id) &&
          prior.compositeLifecycle?.allowlisted === true && attempt.compositeLifecycle?.allowlisted === true &&
          prior.compositeLifecycle?.lifecycleId === attempt.compositeLifecycle?.lifecycleId &&
          prior.compositeLifecycle?.facet === prior.capability && attempt.compositeLifecycle?.facet === attempt.capability &&
          prior.capability !== attempt.capability && engineeringFacets.has(prior.capability) && engineeringFacets.has(attempt.capability);
        if (!allowedDesktopReuse && !allowedEngineeringReuse) throw new Error("controlled producer raw artifact cannot be reused across capability claims");
      }
      rawArtifacts.set(attempt.rawArtifactSha256, attempt);
    }
  }
  let index = null;
  const indexIssues = [];
  if (existsSync(paths.indexPath)) {
    try { index = readJson(paths.indexPath, "runtime capability acceptance index"); }
    catch (error) { indexIssues.push(error.message); }
  }
  if (index) {
    if (index.schemaVersion !== ACCEPTANCE_INDEX_SCHEMA_VERSION || index.claimSchemaVersion !== CLAIM_SCHEMA_VERSION) indexIssues.push("runtime capability acceptance index shape is invalid");
    if (index.attemptCount !== attempts.length) indexIssues.push("runtime capability acceptance index attemptCount mismatch");
    const expectedLatest = {};
    for (const attempt of [...attempts].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)) || left.attemptId.localeCompare(right.attemptId))) {
      expectedLatest[`${attempt.runtime}:${attempt.capability}:${attempt.mode}`] = pointerFor(attempt);
    }
    for (const [key, expected] of Object.entries(expectedLatest)) {
      const pointer = index.latestByClaim?.[key];
      if (!pointer || pointer.attemptId !== expected.attemptId || pointer.recordHash !== expected.recordHash || pointer.record !== expected.record) indexIssues.push(`runtime capability acceptance index latest pointer mismatch for ${key}`);
    }
    if (Object.keys(index.latestByClaim ?? {}).length !== Object.keys(expectedLatest).length) indexIssues.push("runtime capability acceptance index claim set mismatch");
    if (indexIssues.length > 0) index = null;
  }
  return { paths: { ...paths, realRoot, realAttempts }, attempts, index, indexIssues };
}
