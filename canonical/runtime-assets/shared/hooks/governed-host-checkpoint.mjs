#!/usr/bin/env node

import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveProjectRoot } from "./project-root.mjs";
import { publicTaskBinding } from "./governed-task-reference.mjs";
import { completeStage, readSpineState, STAGE_ORDER, writeSpineState } from "./spine-state.mjs";

const MAX_INPUT_BYTES = 64 * 1024;
const REPORT_FIELDS = Object.freeze({
  critical: "criticalRecord", fetch: "fetchRecord", thinking: "thinkingPacket", execution: "executionRecord",
  review: "reviewPacket", "meta-review": "metaReviewPacket", verification: "verificationPacket", evolution: "evolutionWritebackPacket",
});
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const texts = (value, allowEmpty = false) => Array.isArray(value) && (allowEmpty || value.length > 0) && value.every(text);
const identity = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9:._-]{2,159}$/iu.test(value);
const contentVersion = (value) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/iu.test(value);
const returnTargets = (stage) => ["fetch", "thinking", "execution"].filter((target) => STAGE_ORDER.indexOf(target) < STAGE_ORDER.indexOf(stage));

function requireValue(condition, reason) {
  if (!condition) throw new Error(reason);
}

function checkedProjectRoot(projectRoot, cwd = process.cwd()) {
  requireValue(typeof projectRoot === "string" && path.isAbsolute(projectRoot), "project_root_not_absolute");
  const root = path.resolve(projectRoot);
  const resolved = resolveProjectRoot({ cwd, runtimeCandidates: [root] });
  requireValue(resolved && samePath(path.resolve(resolved), root), "project_root_binding_mismatch");
  requireValue(samePath(realpathSync(root), root), "project_root_redirected");
  return root;
}

function boundedRead(descriptor) {
  const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
  let count = 0;
  while (count < buffer.length) {
    const bytes = readSync(descriptor, buffer, count, buffer.length - count, null);
    if (!bytes) break;
    count += bytes;
  }
  requireValue(count <= MAX_INPUT_BYTES, "checkpoint_input_too_large");
  return buffer.subarray(0, count).toString("utf8");
}

export function readGovernedHostCheckpointInput(inputPath, projectRoot) {
  if (inputPath === "-") return JSON.parse(boundedRead(0));
  requireValue(text(inputPath), "checkpoint_input_missing");
  const candidate = path.resolve(projectRoot, inputPath);
  const relative = path.relative(projectRoot, candidate);
  requireValue(relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "checkpoint_input_outside_project");
  let cursor = projectRoot;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    requireValue(!lstatSync(cursor).isSymbolicLink(), "checkpoint_input_redirected");
  }
  requireValue(samePath(realpathSync(candidate), candidate), "checkpoint_input_redirected");
  const before = lstatSync(candidate);
  requireValue(before.isFile() && !before.isSymbolicLink(), "checkpoint_input_not_plain_file");
  let descriptor;
  try {
    descriptor = openSync(candidate, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(descriptor);
    requireValue(stat.isFile() && stat.nlink === 1 && stat.ino === before.ino && stat.dev === before.dev
      && samePath(realpathSync(candidate), candidate), "checkpoint_input_not_plain_file");
    requireValue(stat.size <= MAX_INPUT_BYTES, "checkpoint_input_too_large");
    return JSON.parse(boundedRead(descriptor));
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function governedHostCheckpointTemplate(stage) {
  requireValue(STAGE_ORDER.includes(stage), "checkpoint_stage_invalid");
  const records = {
    critical: { realIntent: "", successCriteria: [""], nonGoals: [], blockingUnknowns: [], noQuotaClarification: true },
    fetch: { evidence: [""], decisionImpactMap: [""], capabilityDiscovery: { sources: [""], matches: [""] }, memoryStrategy: "" },
    thinking: { designFrame: "", chosenRationale: "", consideredLanes: [""], dependencyPolicy: "", reviewStandard: "", workerTaskPackets: [{ taskPacketId: "", ownerAgent: "", ownerSource: "", roleDisplayName: "", roleInstanceId: "", scope: "", expectedOutput: "", verification: "", mergeOwner: "", weapon: "", dependsOn: [] }] },
    execution: { workerResultPackets: [{ taskPacketId: "", ownerAgent: "", resultStatus: "reported_complete", summary: "", evidenceRefs: [""] }] },
    review: { upstreamAssessment: "", verdict: "pass", findings: [] },
    "meta-review": { upstreamAssessment: "", verdict: "pass", findings: [] },
    verification: { checks: [{ name: "", observedResult: "", passed: false, evidenceRefs: [""] }] },
    evolution: { decision: "none-with-reason", reason: "" },
  };
  return { ownerAgent: "", summary: "", evidenceRefs: [""], status: "complete", record: records[stage] };
}

function checkedWorkerPackets(packets, state = {}) {
  requireValue(Array.isArray(packets) && packets.length > 0 && packets.length <= 32, "thinking_worker_packets_missing");
  const ids = new Set();
  const selected = packets.map((packet) => {
    requireValue(object(packet), "thinking_worker_packet_invalid");
    const fields = ["taskPacketId", "ownerAgent", "ownerSource", "roleDisplayName", "roleInstanceId", "scope", "expectedOutput", "verification", "mergeOwner", "weapon"];
    requireValue(fields.every((key) => text(packet[key])), "thinking_worker_packet_incomplete");
    requireValue(/^[a-z0-9][a-z0-9:._-]{2,159}$/iu.test(packet.taskPacketId) && !ids.has(packet.taskPacketId), "thinking_worker_identity_invalid");
    requireValue(texts(packet.dependsOn, true), "thinking_worker_dependencies_invalid");
    ids.add(packet.taskPacketId);
    const selected = { ...Object.fromEntries(fields.map((key) => [key, packet[key]])), dependsOn: packet.dependsOn,
      ownerBindingMode: "run_scoped_owner_contract", invocationState: "selected_not_invoked", evidenceLevel: "owner_reported" };
    if (state.hostRevision) {
      const history = state.hostRevisionHistory || [];
      const prior = history.flatMap((entry) => entry.invalidated.workerTaskPackets || []);
      requireValue(!prior.some((old) => old.taskPacketId === packet.taskPacketId), "revision_task_identity_reused");
      const previous = history.at(-1)?.invalidated.workerTaskPackets || [];
      if (packet.replacesTaskPacketId !== undefined) {
        const replaced = previous.find((old) => old.taskPacketId === packet.replacesTaskPacketId);
        requireValue(replaced, "revision_replaced_task_unknown");
        selected.replacesTaskPacketId = replaced.taskPacketId;
        selected.logicalTaskPacketId = replaced.logicalTaskPacketId || replaced.taskPacketId;
      } else selected.logicalTaskPacketId = packet.taskPacketId;
      selected.revisionId = state.hostRevision.revisionId;
    }
    return selected;
  });
  const visited = new Set();
  const visiting = new Set();
  function visit(id) {
    requireValue(!visiting.has(id), "thinking_worker_dependency_cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of selected.find((packet) => packet.taskPacketId === id).dependsOn) {
      requireValue(ids.has(dependency), "thinking_worker_dependency_unknown");
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of ids) visit(id);
  const replacements = selected.map((packet) => packet.replacesTaskPacketId).filter(Boolean);
  requireValue(new Set(replacements).size === replacements.length, "revision_replacement_duplicated");
  return selected;
}

function checkedFinding(finding, state) {
  requireValue(object(finding) && identity(finding.findingId) && text(finding.summary), "revision_finding_incomplete");
  requireValue((finding.runId === undefined || finding.runId === state.runId)
    && (finding.taskPacketId === undefined || (state.workerTaskPackets || []).some((packet) => packet.taskPacketId === finding.taskPacketId)), "revision_finding_binding_invalid");
  const selected = { runId: state.runId, findingId: finding.findingId, summary: finding.summary };
  for (const key of ["feedbackId", "taskPacketId", "deliverableId"]) {
    if (finding[key] !== undefined) { requireValue(identity(finding[key]), `revision_finding_invalid:${key}`); selected[key] = finding[key]; }
  }
  if (finding.contentVersion !== undefined) {
    requireValue(contentVersion(finding.contentVersion), "revision_content_version_invalid"); selected.contentVersion = finding.contentVersion;
  }
  return selected;
}

function checkedRevisionResponses(raw, state, completing) {
  if (!state.hostRevision) return [];
  requireValue(Array.isArray(raw) || !completing, "revision_responses_missing");
  const ids = new Set();
  const responses = (raw || []).map((response) => {
    const finding = state.hostRevision.findings.find((item) => item.findingId === response?.findingId);
    const packet = (state.workerTaskPackets || []).find((item) => item.taskPacketId === response?.taskPacketId);
    requireValue(finding && packet && !ids.has(finding.findingId)
      && (!finding.taskPacketId || packet.replacesTaskPacketId === finding.taskPacketId)
      && (response.sourceTaskPacketId === undefined || response.sourceTaskPacketId === finding.taskPacketId)
      && (response.feedbackId === undefined || response.feedbackId === finding.feedbackId)
      && (response.runId === undefined || response.runId === state.runId)
      && (response.revisionId === undefined || response.revisionId === state.hostRevision.revisionId), "revision_response_binding_invalid");
    requireValue(text(response.summary) && texts(response.evidenceRefs), "revision_response_incomplete");
    requireValue(response.sourceDeliverableId === undefined || response.sourceDeliverableId === finding.deliverableId, "revision_response_deliverable_mismatch");
    requireValue(response.sourceContentVersion === undefined || response.sourceContentVersion === finding.contentVersion, "revision_response_source_version_mismatch");
    ids.add(finding.findingId);
    const selected = { runId: state.runId, revisionId: state.hostRevision.revisionId, actionId: state.hostRevision.revisionId,
      findingId: finding.findingId, ...(finding.feedbackId ? { feedbackId: finding.feedbackId } : {}),
      ...(finding.taskPacketId ? { sourceTaskPacketId: finding.taskPacketId } : {}),
      ...(finding.contentVersion ? { sourceContentVersion: finding.contentVersion } : {}),
      taskPacketId: packet.taskPacketId, logicalTaskPacketId: packet.logicalTaskPacketId || packet.taskPacketId,
      summary: response.summary, evidenceRefs: response.evidenceRefs, status: "reported_revised", evidenceLevel: "owner_reported", nativeInvocationVerified: false };
    if (finding.deliverableId || response.deliverableId !== undefined) {
      requireValue(identity(response.deliverableId)
        && (!finding.deliverableId || response.deliverableId === finding.deliverableId || response.sourceDeliverableId === finding.deliverableId)
        && (response.sourceDeliverableId === undefined || response.sourceDeliverableId === finding.deliverableId), "revision_response_deliverable_mismatch");
      selected.deliverableId = response.deliverableId;
      if (finding.deliverableId) selected.sourceDeliverableId = finding.deliverableId;
    }
    if (finding.contentVersion || response.contentVersion !== undefined) {
      requireValue(contentVersion(response.contentVersion), "revision_response_version_missing");
      selected.contentVersion = response.contentVersion;
    }
    return selected;
  });
  requireValue(!completing || ids.size === state.hostRevision.findings.length, "revision_responses_unsettled");
  return responses;
}

function checkedRecord(stage, raw, state, completing) {
  requireValue(object(raw), "checkpoint_stage_record_missing");
  if (!completing && Object.keys(raw).length === 0) return { incomplete: true };
  // Whitelist stage content. Caller-supplied trust, native proof, public-ready,
  // lifecycle and runtime-control fields never become authoritative state.
  const record = {};
  const take = (key, predicate = text) => {
    requireValue(predicate(raw[key]), `checkpoint_field_required:${key}`);
    record[key] = raw[key];
  };
  if (stage === "critical") {
    take("realIntent"); take("successCriteria", texts); take("nonGoals", (v) => texts(v, true));
    take("blockingUnknowns", (v) => texts(v, true)); take("noQuotaClarification", (v) => v === true);
    requireValue(!completing || record.blockingUnknowns.length === 0, "critical_blocking_unknowns_unsettled");
  } else if (stage === "fetch") {
    take("evidence", texts); take("decisionImpactMap", texts); take("memoryStrategy");
    requireValue(object(raw.capabilityDiscovery) && texts(raw.capabilityDiscovery.sources) && texts(raw.capabilityDiscovery.matches), "fetch_capability_discovery_missing");
    record.capabilityDiscovery = { sources: raw.capabilityDiscovery.sources, matches: raw.capabilityDiscovery.matches };
    record.capabilityMatches = raw.capabilityDiscovery.matches;
    record.capabilitySearchPerformed = true;
  } else if (stage === "thinking") {
    for (const key of ["designFrame", "chosenRationale", "dependencyPolicy", "reviewStandard"]) take(key);
    take("consideredLanes", texts);
    record.workerTaskPackets = checkedWorkerPackets(raw.workerTaskPackets, state);
    requireValue(!completing || !state.hostRevision || state.hostRevision.findings.every((finding) => !finding.taskPacketId
      || record.workerTaskPackets.some((packet) => packet.replacesTaskPacketId === finding.taskPacketId)), "revision_finding_replacement_missing");
  } else if (stage === "execution") {
    requireValue(Array.isArray(raw.workerResultPackets) && raw.workerResultPackets.length > 0, "execution_results_missing");
    const packets = state.workerTaskPackets || [];
    const resultIds = new Set();
    record.workerResultPackets = raw.workerResultPackets.map((result) => {
      const packet = packets.find((p) => p.taskPacketId === result?.taskPacketId && p.ownerAgent === result?.ownerAgent);
      requireValue(packet && !resultIds.has(packet.taskPacketId), "execution_result_binding_invalid");
      requireValue(["reported_complete", "reported_failed", "reported_blocked"].includes(result.resultStatus)
        && text(result.summary) && texts(result.evidenceRefs), "execution_result_incomplete");
      resultIds.add(packet.taskPacketId);
      return { runId: state.runId, taskPacketId: packet.taskPacketId, ownerAgent: packet.ownerAgent, resultStatus: result.resultStatus,
        status: "in_doubt", summary: result.summary, evidenceRefs: result.evidenceRefs, evidenceLevel: "owner_reported", nativeInvocationVerified: false };
    });
    requireValue(!completing || (packets.length === resultIds.size && record.workerResultPackets.every((result) => result.resultStatus === "reported_complete")), "execution_results_unsettled");
    if (state.hostRevision) record.revisionResponses = checkedRevisionResponses(raw.revisionResponses, state, completing);
  } else if (stage === "review" || stage === "meta-review") {
    take("upstreamAssessment"); take("findings", (v) => texts(v, true));
    take("verdict", (v) => ["pass", "revision"].includes(v));
    requireValue(!completing || record.verdict === "pass", "review_requires_revision");
  } else if (stage === "verification") {
    if (state.hostRevision) Object.assign(record, { runId: state.runId, revisionId: state.hostRevision.revisionId, actionId: state.hostRevision.revisionId });
    requireValue(Array.isArray(raw.checks) && raw.checks.length > 0, "verification_checks_missing");
    record.checks = raw.checks.map((check) => {
      requireValue(text(check?.name) && text(check.observedResult) && typeof check.passed === "boolean" && texts(check.evidenceRefs), "verification_check_incomplete");
      const selected = { name: check.name, observedResult: check.observedResult, passed: check.passed, evidenceRefs: check.evidenceRefs, evidenceLevel: "owner_reported" };
      if (state.hostRevision && check.findingId !== undefined) {
        const response = (state.revisionResponses || []).findLast((item) => item.revisionId === state.hostRevision.revisionId && item.findingId === check.findingId);
        requireValue(response && check.taskPacketId === response.taskPacketId
          && check.deliverableId === response.deliverableId && check.contentVersion === response.contentVersion
          && ["runId", "revisionId", "actionId", "sourceTaskPacketId", "sourceDeliverableId", "sourceContentVersion", "feedbackId"]
            .every((key) => check[key] === undefined || check[key] === response[key]), "revision_verification_binding_invalid");
        Object.assign(selected, { runId: state.runId, revisionId: response.revisionId, actionId: response.actionId, findingId: response.findingId,
          taskPacketId: response.taskPacketId, ...(response.deliverableId ? { deliverableId: response.deliverableId } : {}),
          ...(response.contentVersion ? { contentVersion: response.contentVersion } : {}),
          ...Object.fromEntries(["sourceTaskPacketId", "sourceDeliverableId", "sourceContentVersion", "feedbackId"].filter((key) => response[key] !== undefined).map((key) => [key, response[key]])),
          nativeInvocationVerified: false });
      }
      return selected;
    });
    requireValue(!completing || record.checks.every((check) => check.passed), "verification_checks_failed");
    if (state.hostRevision) {
      requireValue(!completing || state.hostRevision.findings.every((finding) => record.checks.some((check) => check.findingId === finding.findingId && check.passed)), "revision_verification_unsettled");
      record.verificationResults = record.checks.filter((check) => check.findingId);
    }
  } else {
    take("decision", (v) => ["writeback", "none-with-reason"].includes(v)); take("reason");
    if (record.decision === "writeback") take("evidenceRefs", texts);
  }
  return record;
}

async function boundState({ projectRoot, runId, conversationId, cwd }) {
  const root = checkedProjectRoot(projectRoot, cwd);
  const state = await readSpineState(root);
  requireValue(state?.active === true && state.runId === runId, "checkpoint_active_run_mismatch");
  requireValue(state.conversationLinkState === "verified" && state.sourceConversation?.conversationId === conversationId
    && state.sourceConversation?.runId === runId && state.sourceConversation?.matchBasis === "transcript_file_verified", "checkpoint_conversation_binding_mismatch");
  return { root, state };
}

function checkpointInspection(state) {
  return { runId: state.runId, conversationId: state.sourceConversation.conversationId, currentStage: state.currentStage,
    currentStageStatus: state.stages[state.currentStage].status, active: state.active,
    revisionId: state.hostRevision?.revisionId || null, hostRevision: state.hostRevision || null, returnTargets: returnTargets(state.currentStage),
    revision: state.hostCheckpointRevision || 0, evidenceLevel: "owner_reported", publicReadyAuthority: false,
    expectedRevision: state.hostCheckpointRevision || 0, expectedStage: state.currentStage, expectedStatus: state.stages[state.currentStage].status };
}

function currentTaskReferences(state) {
  const packets = state.workerTaskPackets || [];
  requireValue(Array.isArray(packets) && packets.length <= 32, "task_reference_inventory_invalid");
  return packets.filter((packet) => identity(packet?.taskPacketId) && (!packet.runId || packet.runId === state.runId)).map((packet) => ({
    publicTaskRef: publicTaskBinding(packet.taskPacketId), taskPacketId: packet.taskPacketId, current: true,
    logicalTaskPacketId: identity(packet.logicalTaskPacketId) ? packet.logicalTaskPacketId : packet.taskPacketId,
    replacesTaskPacketId: identity(packet.replacesTaskPacketId) ? packet.replacesTaskPacketId : null,
    revisionId: identity(packet.revisionId) ? packet.revisionId : null,
    ownerAgent: typeof packet.ownerAgent === "string" ? packet.ownerAgent.slice(0, 160) : null,
  }));
}

/** Bound read-only mapping of current work orders; no label or owner inference. */
export async function inspectGovernedHostCheckpoint(options) {
  const { state } = await boundState(options);
  const references = currentTaskReferences(state);
  return { ...checkpointInspection(state), taskReferences: references.map((entry) => ({ ...entry,
    resolution: references.filter((item) => item.publicTaskRef === entry.publicTaskRef).length === 1 ? "unique" : "ambiguous" })),
  template: governedHostCheckpointTemplate(state.currentStage) };
}

/** Resolve one copied display reference against only this bound run's current packets. */
export async function resolveGovernedHostTaskReference(options) {
  const { state } = await boundState(options);
  requireValue(/^task:[a-f0-9]{20}$/u.test(options.taskRef || ""), "task_reference_invalid");
  const matches = currentTaskReferences(state).filter((entry) => entry.publicTaskRef === options.taskRef);
  requireValue(matches.length > 0, "task_reference_unknown");
  requireValue(matches.length === 1, "task_reference_ambiguous");
  return { ...checkpointInspection(state), taskReference: matches[0] };
}

/** Read-only input shape; callers must copy fresh CAS values from --inspect. */
export function governedHostReturnTemplate() {
  return { ownerAgent: "", summary: "", evidenceRefs: [""], expectedRevision: null, expectedStage: "", expectedStatus: "",
    findings: [{ findingId: "", feedbackId: "", taskPacketId: "", summary: "" }] };
}

/** Return within the bound run. Archive invalidated evidence before replacing its active projection. */
export async function returnGovernedHostToStage(options) {
  const { root, state } = await boundState(options);
  const request = options.input;
  requireValue(object(request) && Buffer.byteLength(JSON.stringify(request)) <= MAX_INPUT_BYTES, "checkpoint_input_invalid");
  requireValue(text(request.ownerAgent) && text(request.summary) && texts(request.evidenceRefs), "checkpoint_report_incomplete");
  requireValue(Number.isSafeInteger(request.expectedRevision) && request.expectedRevision === (state.hostCheckpointRevision || 0), "revision_conflict");
  requireValue(request.expectedStage === state.currentStage, "revision_stage_conflict");
  requireValue(request.expectedStatus === state.stages[state.currentStage].status, "revision_status_conflict");
  requireValue(returnTargets(state.currentStage).includes(options.targetStage), "return_stage_invalid");
  requireValue(Array.isArray(request.findings) && request.findings.length > 0 && request.findings.length <= 64, "revision_findings_missing");
  const findings = request.findings.map((finding) => checkedFinding(finding, state));
  requireValue(new Set(findings.map((finding) => finding.findingId)).size === findings.length, "revision_finding_duplicated");
  const now = new Date().toISOString();
  const revision = (state.hostCheckpointRevision || 0) + 1;
  const revisionId = `revision-${revision}`;
  const affected = STAGE_ORDER.slice(STAGE_ORDER.indexOf(options.targetStage));
  const invalidated = { stages: {}, records: {}, hostStageReports: {}, workerTaskPackets: state.workerTaskPackets || [],
    workerResultPackets: state.workerResultPackets || [], workerLifecycle: state.workerLifecycle || [],
    previousRevision: state.hostRevision || null, derived: {} };
  const next = structuredClone(state);
  for (const stage of affected) {
    invalidated.stages[stage] = state.stages[stage];
    if (state[REPORT_FIELDS[stage]]) invalidated.records[REPORT_FIELDS[stage]] = state[REPORT_FIELDS[stage]];
    if (state.hostStageReports?.[stage]) invalidated.hostStageReports[stage] = state.hostStageReports[stage];
    delete next[REPORT_FIELDS[stage]];
    if (next.hostStageReports) delete next.hostStageReports[stage];
    next.stages[stage] = { status: stage === options.targetStage ? "in_progress" : "pending", completedAt: null,
      ...(stage === options.targetStage ? { startedAt: now } : {}), revisionId };
  }
  // These are projections of invalidated execution/review outcomes, never upstream intent.
  for (const key of ["dispatchedAgents", "dispatchChain", "executionStarted", "verificationResults", "fixEvidence", "summaryPacket", "publicReady", "publicReadyEvidence", "deliverableChain", "executionLease"]) {
    if (Object.hasOwn(next, key)) { invalidated.derived[key] = next[key]; delete next[key]; }
  }
  next.dispatchedAgents = [];
  next.dispatchChain = {};
  next.workerTaskPackets = [];
  next.workerResultPackets = [];
  next.workerLifecycle = [];
  next.hostRevision = { runId: state.runId, revisionId, parentRevisionId: state.hostRevision?.revisionId || null,
    fromStage: state.currentStage, targetStage: options.targetStage, findings, status: "revision_requested", requestedAt: now,
    ownerAgent: request.ownerAgent, summary: request.summary, evidenceRefs: request.evidenceRefs,
    evidenceLevel: "owner_reported", nativeInvocationVerified: false };
  next.hostRevisionHistory = [...(state.hostRevisionHistory || []), { ...next.hostRevision, invalidated }];
  if (options.targetStage === "execution") {
    requireValue(Array.isArray(request.workerTaskPackets) && request.workerTaskPackets.length > 0, "revision_replacement_tasks_required");
    const replacements = checkedWorkerPackets(request.workerTaskPackets, next);
    const oldPackets = state.workerTaskPackets || [];
    requireValue(replacements.length === oldPackets.length && replacements.every((packet) => packet.replacesTaskPacketId), "revision_replacement_tasks_required");
    const replacementIds = new Map(replacements.map((packet) => [packet.replacesTaskPacketId, packet.taskPacketId]));
    for (const packet of replacements) {
      const old = oldPackets.find((item) => item.taskPacketId === packet.replacesTaskPacketId);
      requireValue(old && ["ownerAgent", "ownerSource", "roleDisplayName", "roleInstanceId", "scope", "expectedOutput", "verification", "mergeOwner", "weapon"].every((key) => packet[key] === old[key])
        && JSON.stringify(packet.dependsOn) === JSON.stringify(old.dependsOn.map((id) => replacementIds.get(id))), "revision_design_changed_return_to_thinking");
    }
    next.workerTaskPackets = replacements;
  } else requireValue(request.workerTaskPackets === undefined, "revision_tasks_require_thinking");
  next.currentStage = options.targetStage;
  next.updatedAt = now;
  next.blockedOn = null;
  next.gateState = "pending";
  next.hostCheckpointRevision = revision;
  next.hostCheckpointSummary = { stage: options.targetStage, status: "in_progress", revision, revisionId,
    ownerAgent: request.ownerAgent, summary: request.summary, evidenceRefs: request.evidenceRefs, recordedAt: now,
    evidenceLevel: "owner_reported", nativeInvocationVerified: false };
  const write = await writeSpineState(root, next, { expectedRunId: state.runId, expectedActive: true, expectedStage: request.expectedStage,
    expectedStageStatus: request.expectedStatus, expectedCheckpointRevision: request.expectedRevision });
  requireValue(write.written === true, `checkpoint_write_rejected:${write.reason}`);
  return { written: true, runId: state.runId, currentStage: next.currentStage, revision, revisionId, workerTaskPackets: next.workerTaskPackets,
    evidenceLevel: "owner_reported", nativeInvocationVerified: false, publicReadyAuthority: false };
}

export async function checkpointGovernedHost(options) {
  const { root, state } = await boundState(options);
  requireValue(STAGE_ORDER.includes(options.stage) && options.stage === state.currentStage, "checkpoint_stage_out_of_order");
  requireValue(state.stages[options.stage]?.status !== "completed", "checkpoint_stage_already_completed");
  const request = options.input;
  requireValue(object(request) && Buffer.byteLength(JSON.stringify(request)) <= MAX_INPUT_BYTES, "checkpoint_input_invalid");
  requireValue(text(request.ownerAgent) && text(request.summary) && texts(request.evidenceRefs), "checkpoint_report_incomplete");
  requireValue(["complete", "blocked", "in_progress"].includes(request.status), "checkpoint_status_invalid");
  const completing = request.status === "complete";
  const record = checkedRecord(options.stage, request.record, state, completing);
  const report = { stage: options.stage, ownerAgent: request.ownerAgent, summary: request.summary, evidenceRefs: request.evidenceRefs,
    status: request.status, evidenceLevel: "owner_reported", nativeInvocationVerified: false, recordedAt: new Date().toISOString() };
  const next = structuredClone(state);
  next.updatedAt = report.recordedAt;
  if (!next.ownerAgent) next.ownerAgent = report.ownerAgent;
  next[REPORT_FIELDS[options.stage]] = { ...(record.incomplete ? next[REPORT_FIELDS[options.stage]] : {}), ...record, ...report };
  next.hostStageReports = { ...next.hostStageReports, [options.stage]: report };
  next.hostCheckpointRevision = (state.hostCheckpointRevision || 0) + 1;
  next.hostCheckpointSummary = { ...report, revision: next.hostCheckpointRevision };
  next.blockedOn = request.status === "blocked" ? request.summary : null;
  if (options.stage === "thinking" && Array.isArray(record.workerTaskPackets)) {
    next.workerTaskPackets = record.workerTaskPackets;
    next.reviewStandard = record.reviewStandard;
  }
  if (options.stage === "execution" && Array.isArray(record.workerResultPackets)) next.workerResultPackets = record.workerResultPackets.map((result) => ({ ...result, reportedAt: report.recordedAt }));
  if (Array.isArray(record.revisionResponses)) {
    next.revisionResponses = [...(next.revisionResponses || []), ...record.revisionResponses.map((response) => ({ ...response, revisedAt: report.recordedAt }))];
    if (completing) next.hostRevision.status = "revision_reported";
  }
  if (options.stage === "verification" && completing && next.hostRevision) next.hostRevision.status = "verification_reported";
  const updated = completing ? completeStage(next, options.stage) : next;
  if (completing) {
    updated.stages[options.stage].evidenceLevel = "owner_reported";
    updated.stages[options.stage].evidenceRefs = report.evidenceRefs;
  }
  const write = await writeSpineState(root, updated, { expectedRunId: state.runId, expectedActive: true,
    expectedStage: state.currentStage, expectedStageStatus: state.stages[state.currentStage].status, expectedCheckpointRevision: state.hostCheckpointRevision || 0 });
  requireValue(write.written === true, `checkpoint_write_rejected:${write.reason}`);
  return { written: true, runId: state.runId, currentStage: updated.currentStage, revision: next.hostCheckpointRevision,
    evidenceLevel: "owner_reported", nativeInvocationVerified: false, publicReadyAuthority: false };
}

export function buildGovernedHostHandoff({ state, projectRoot, adapterPath, skillPath, language = "zh-CN" }) {
  const conversationId = state?.sourceConversation?.conversationId;
  const verified = state?.conversationLinkState === "verified" && text(conversationId);
  const command = `node ${JSON.stringify(adapterPath)} --project-root ${JSON.stringify(projectRoot)} --run-id ${JSON.stringify(state.runId)}${verified ? ` --conversation-id ${JSON.stringify(conversationId)}` : " --conversation-id <verified-conversation-required>"} --stage <current-stage> --input <project-local-JSON-file-or->`;
  if (language !== "zh-CN") return [
    "Meta_Kim host execution handoff: backstage instructions, not a user-facing rewritten prompt or a completion receipt.",
    `Continue existing runId=${state.runId}; project=${projectRoot}; current stage=${state.currentStage}; conversation=${verified ? conversationId : "unverified; gather binding evidence before writing"}. Do not mint a parallel run or substitute a historical task.`,
    `Read and apply the installed skill ${skillPath}. The current host owns governance and dispatches actual work to discovered capabilities.`,
    `Write stage records through ${adapterPath}. Use --inspect for the current template or --template <stage> for lightweight input.`,
    "For review or feedback rework, inspect fresh revision/stage/status, then explicitly --return-to fetch|thinking|execution with findings and that CAS. Preserve the same run; use fresh taskPacketIds linked by replacesTaskPacketId. --template-return describes the input.",
    `Invocation: ${command}`,
    "Record the actual goal, acceptance and unresolved decisions, then actual evidence and capability discovery, then the Thinking route and workerTaskPackets. Execute, review and verify those same work orders. Checkpoint after each stage, not a fabricated retrospective pass.",
    "Records remain owner_reported. Native worker returns require actual host evidence; JSON, booleans, a planned-only runner or tool exits cannot certify the eight stages, user acceptance or public-ready.",
  ].join("\n");
  return [
    "Meta_Kim 后台执行接续：这不是用户可见的提示词成稿，也不是任务完成回执。",
    `沿用既有 runId=${state.runId}；项目=${projectRoot}；当前阶段=${state.currentStage}；会话=${verified ? conversationId : "尚未验证，先只读取证并补齐绑定"}。不要新建平行 run 或换用历史任务。`,
    `立即读取并应用已安装技能 ${skillPath}，由当前主线程承接治理并按能力分派实际工作。`,
    `阶段记录通过 ${adapterPath} 写回同一任务。先用 --inspect 读取当前模板，或 --template <stage> 获取轻量输入。`,
    "审查或反馈需要返工时，先inspect取得revision/stage/status，再用--return-to fetch|thinking|execution提交发现与这组CAS；沿用同一run，新工单用replacesTaskPacketId关联旧版。--template-return提供输入模板。",
    `调用：${command}`,
    "先记录真实目标、标准和未决项，再记录实际检索及能力发现，再提交Thinking方案与workerTaskPackets，随后按同一工单执行、审查、验证并记录结果。每阶段完成后立刻checkpoint，不能最后补写一套假通过。",
    "这些是owner_reported阶段/结果；原生调用返回仍须真实宿主证据，不能用JSON、布尔值、planned-only runner或工具退出推断八阶段通过、用户验收或public-ready。",
  ].join("\n");
}

async function main() {
  const arg = (key) => { const i = process.argv.indexOf(key); return i < 0 ? null : process.argv[i + 1]; };
  if (process.argv.includes("--help")) {
    process.stdout.write("Usage: node governed-host-checkpoint.mjs --project-root <root> --run-id <existing run> --conversation-id <verified chat> [--inspect | --resolve-task-ref <task:20hex> | --stage <current stage> --input <project JSON file or -> | --return-to fetch|thinking|execution --input <project JSON file or ->]\n--inspect provides current public/raw task references and fresh CAS; --resolve-task-ref resolves exactly one current task without writing. Historical references are refused. --template <stage> and --template-return are read-only. Returns require fresh expectedRevision/expectedStage/expectedStatus and findings. Reports are owner_reported, never native invocation or public-ready proof.\n");
    return;
  }
  if (arg("--template")) { process.stdout.write(JSON.stringify(governedHostCheckpointTemplate(arg("--template")), null, 2) + "\n"); return; }
  if (process.argv.includes("--template-return")) { process.stdout.write(JSON.stringify(governedHostReturnTemplate(), null, 2) + "\n"); return; }
  const options = { projectRoot: arg("--project-root"), runId: arg("--run-id"), conversationId: arg("--conversation-id"), stage: arg("--stage") };
  requireValue(["--inspect", "--resolve-task-ref", "--stage", "--return-to"].reduce((count, flag) => count + process.argv.filter((value) => value === flag).length, 0) === 1, "checkpoint_operation_ambiguous");
  if (process.argv.includes("--inspect")) { process.stdout.write(JSON.stringify(await inspectGovernedHostCheckpoint(options), null, 2) + "\n"); return; }
  if (process.argv.includes("--resolve-task-ref")) { process.stdout.write(JSON.stringify(await resolveGovernedHostTaskReference({ ...options, taskRef: arg("--resolve-task-ref") }), null, 2) + "\n"); return; }
  const root = checkedProjectRoot(options.projectRoot);
  options.input = readGovernedHostCheckpointInput(arg("--input"), root);
  requireValue(!(arg("--return-to") && options.stage), "checkpoint_operation_ambiguous");
  process.stdout.write(JSON.stringify(arg("--return-to")
    ? await returnGovernedHostToStage({ ...options, targetStage: arg("--return-to") })
    : await checkpointGovernedHost(options)) + "\n");
}

if (process.argv[1] && samePath(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  main().catch((error) => { process.stderr.write(`Meta_Kim checkpoint refused: ${error.message}\n`); process.exitCode = 1; });
}
