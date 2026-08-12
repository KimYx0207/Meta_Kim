import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildReadOnlyRunProjectionSurfacesAdapter } from "../../scripts/governed-execution/read-only-run-projection-surfaces-adapter.mjs";
import { isAttestedDurableRunProjection, isAttestedDurableRunResume, openDurableRunKernel } from "../../scripts/governed-execution/durable-run-kernel.mjs";
import { runStageRunnerBridge } from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import { buildStageDagPacket } from "../../scripts/governed-execution/stage-dag.mjs";
import { buildReadOnlyRunAuthoritySnapshot, digestReadOnlyRunAuthoritySnapshotPayload, normalizeReadOnlyRunAuthoritySnapshot } from "../../src/data/projections/read-only-run-authority-snapshot.mjs";
import { assertValidReadOnlyRunProjectionModel, buildReadOnlyRunProjectionModel } from "../../src/domain/presentation/read-only-run-projection-surfaces.mjs";
import { canonicalDigest } from "../../src/domain/shared/canonical-digest.mjs";
import { renderReadOnlyRunSurfaces } from "../../src/presentation/run-surfaces/read-only-run-surface-renderers.mjs";

const IDS = ["M3-A01", "M3-A02", "M3-A03", "M3-A04", "M3-A05", "M3-A06", "M3-A07"];
const copy = Object.freeze({ title: "Governed run", runLabel: "Run", statusLabel: "Status", stageLabel: "Stage", projectionStatusLabel: "Projection", completedColumnLabel: "Completed", pendingColumnLabel: "Pending", blockedColumnLabel: "Blocked", inDoubtColumnLabel: "Needs review" });
const statusColumnMap = Object.freeze([
  { status: "complete", columnId: "completed" }, { status: "completed", columnId: "completed" },
  { status: "pending", columnId: "pending" }, { status: "running", columnId: "pending" },
  { status: "planned_not_invoked", columnId: "pending" }, { status: "blocked", columnId: "blocked" },
  { status: "failed", columnId: "blocked" }, { status: "in_doubt", columnId: "in_doubt" },
]);
function binding() { return { runId: "run:m3-a08", taskFingerprint: canonicalDigest("task"), graphDigest: canonicalDigest("graph"), durableCursor: 7, headEventHash: canonicalDigest("event"), headCheckpointId: canonicalDigest("checkpoint"), policyDigest: canonicalDigest("policy") }; }
function snapshotBuilderInput() {
  const root = binding();
  return {
    binding: root,
    currentness: "fresh_bound_same_settlement",
    eventChainState: "verified",
    runStatus: "active",
    currentStage: "Review",
    stageDag: { graphDigest: root.graphDigest, nodes: [{ nodeId: "Execution", status: "completed" }, { nodeId: "Review", status: "pending" }, { nodeId: "Verification", status: "blocked" }] },
    durableHead: { ...root },
    canonicalProjectionEnvelopes: IDS.map(() => null),
  };
}
function snapshot() { return domainSnapshot("in_doubt"); }
function domainSnapshot(evaluationStatus = "evaluated") { const input = snapshotBuilderInput(); const settlementBindingDigest = canonicalDigest(input.binding); return { ...input, canonicalProjections: IDS.map((projectionId) => ({ projectionId, evaluationStatus, resultDigest: canonicalDigest(projectionId), sourceBindingDigest: evaluationStatus === "evaluated" ? canonicalDigest(`${projectionId}:binding`) : null, settlementBindingDigest })), snapshotDigest: canonicalDigest("domain-fixture") }; }
function deepFrozen(value) { if (value && typeof value === "object") { assert.equal(Object.isFrozen(value), true); Object.values(value).forEach(deepFrozen); } }
function rebindIntent(result) {
  result.semanticDigest = canonicalDigest(result.semantic);
  result.eventIntents[0].intentDigest = canonicalDigest({ bindingDigest: result.bindingDigest, sourceSnapshotDigest: result.sourceSnapshotDigest, semanticDigest: result.semanticDigest });
}

test("77 — pure canonical digest matches the platform SHA-256 implementation", () => {
  const value = { b: 2, a: 1 };
  const expected = `sha256:${createHash("sha256").update('{"a":1,"b":2}', "utf8").digest("hex")}`;
  assert.equal(canonicalDigest(value), expected);
});

test("77 — pure bounded model produces four deterministic same-semantic surfaces", () => {
  const model = buildReadOnlyRunProjectionModel({ authoritySnapshot: domainSnapshot("in_doubt") });
  const first = { model, surfaces: renderReadOnlyRunSurfaces({ model, copy, statusColumnMap }) };
  const second = { model, surfaces: renderReadOnlyRunSurfaces({ model, copy, statusColumnMap }) };
  assert.deepEqual(first, second);
  assertValidReadOnlyRunProjectionModel(first.model);
  assert.equal(first.model.status, "in_doubt");
  assert.equal(first.model.semantic.projectionStates.length, 7);
  assert.deepEqual(Object.keys(first.surfaces).sort(), ["html", "kanban", "markdown", "nativePanel"]);
  assert.ok(Object.values(first.surfaces).every((surface) => surface.semanticDigest === first.model.semanticDigest));
  assert.deepEqual(first.surfaces.nativePanel.rows.map((row) => row.nodeId), ["Execution", "Review", "Verification"]);
  assert.match(first.surfaces.markdown.content, /Execution: completed/u);
  assert.match(first.surfaces.markdown.content, /Projection: in_doubt/u);
  assert.match(first.surfaces.html.content, /Verification: blocked/u);
  assert.match(first.surfaces.html.content, /data-projection-status="in_doubt"/u);
  assert.deepEqual(first.surfaces.kanban.columns.map((column) => column.cards.length), [1, 1, 1, 0]);
  assert.ok(Object.values(first.model.authorization).every((value) => value === false));
  deepFrozen(first.model);
  deepFrozen(first.surfaces);
});

test("77 — pure Domain and Presentation projected fixture stays same-semantic without gaining authority", () => {
  const model = buildReadOnlyRunProjectionModel({ authoritySnapshot: domainSnapshot() });
  const surfaces = renderReadOnlyRunSurfaces({ model, copy, statusColumnMap });
  assert.equal(model.status, "projected");
  assert.ok(Object.values(surfaces).every((surface) => surface.projectionStatus === "projected" && surface.semanticDigest === model.semanticDigest));
  assert.ok(Object.values(model.authorization).every((value) => value === false));
});

test("77 — stale, cross-run, incomplete, raw, secret, and digest-tampered snapshots fail closed without echo", () => {
  const mutations = [
    (value) => { value.currentness = "stale"; },
    (value) => { value.binding.runId = "sk-live-do-not-echo"; },
    (value) => { value.binding.runId = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789TOKEN"; },
    (value) => { value.stageDag.nodes[0].rawOutput = "secret"; },
    (value) => { value.canonicalProjectionEnvelopes.pop(); },
    (value) => { value.canonicalProjectionEnvelopes[0] = { evaluationStatus: "evaluated", result: {} }; },
  ];
  for (const mutate of mutations) {
    const input = snapshotBuilderInput(); mutate(input);
    assert.throws(() => buildReadOnlyRunAuthoritySnapshot(input));
    const envelope = buildReadOnlyRunProjectionSurfacesAdapter({}, { authoritySnapshot: input, copy, statusColumnMap });
    assert.equal(envelope.result, null);
    assert.equal(envelope.disposition, "in_doubt");
    assert.equal(JSON.stringify(envelope).includes("sk-live-do-not-echo"), false);
  }
  const selfSigned = structuredClone(snapshot());
  selfSigned.snapshotDigest = digestReadOnlyRunAuthoritySnapshotPayload(Object.fromEntries(Object.entries(selfSigned).filter(([key]) => key !== "snapshotDigest")));
  assert.throws(() => normalizeReadOnlyRunAuthoritySnapshot(selfSigned), /trusted authority builder/u);
  assert.equal(buildReadOnlyRunProjectionSurfacesAdapter({}, { authoritySnapshot: selfSigned, copy, statusColumnMap }).result, null);
});

test("77 — legacy or caller-controlled envelopes cannot guess currentness, copy, action, or authority", () => {
  for (const [normalized, options] of [
    [{ ready: true }, { authoritySnapshot: snapshot(), copy, statusColumnMap }],
    [{}, { authoritySnapshot: snapshot(), copy }],
    [{}, { authoritySnapshot: snapshot(), copy, statusColumnMap, action: "dispatch" }],
    [{}, { runReportPanelContract: { status: "pass" }, copy, statusColumnMap }],
  ]) {
    const envelope = buildReadOnlyRunProjectionSurfacesAdapter(normalized, options);
    assert.equal(envelope.result, null);
    assert.equal(envelope.disposition, "in_doubt");
    assert.ok(Object.entries(envelope.authority).filter(([field]) => field.endsWith("Allowed")).every(([, value]) => value === false));
  }
});

test("77 — presentation copy is configured and every renderer preserves the same run semantics", () => {
  const localized = { ...copy, title: "运行投影", runLabel: "运行", statusLabel: "状态", stageLabel: "阶段", projectionStatusLabel: "投影状态", completedColumnLabel: "已完成", pendingColumnLabel: "待处理", blockedColumnLabel: "已阻塞", inDoubtColumnLabel: "待确认" };
  const model = buildReadOnlyRunProjectionModel({ authoritySnapshot: domainSnapshot() });
  const surfaces = renderReadOnlyRunSurfaces({ model, copy: localized, statusColumnMap });
  assert.equal(surfaces.nativePanel.title, localized.title);
  assert.equal(surfaces.kanban.title, localized.title);
  assert.match(surfaces.markdown.content, /运行投影/u);
  assert.match(surfaces.html.content, /运行投影/u);
  assert.equal(JSON.stringify(surfaces).includes("Run projection"), false);
  for (const secretTitle of ["sk-live-x", "api-key-x", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789TOKEN", "C:\\Users\\Kim\\private\\run.json", "See C:\\Users\\Kim\\private\\run.json", "artifact at /Users/Kim/private/run.json"]) {
    const envelope = buildReadOnlyRunProjectionSurfacesAdapter({}, { authoritySnapshot: snapshot(), copy: { ...localized, title: secretTitle }, statusColumnMap });
    assert.equal(envelope.result, null);
    assert.equal(JSON.stringify(envelope).includes(secretTitle), false);
  }
});

test("77 — incomplete canonical evaluation remains explicitly in doubt", () => {
  const model = buildReadOnlyRunProjectionModel({ authoritySnapshot: domainSnapshot("in_doubt") });
  const surfaces = renderReadOnlyRunSurfaces({ model, copy, statusColumnMap });
  assert.equal(model.status, "in_doubt");
  assert.equal(surfaces.nativePanel.runStatus, "active");
  assert.ok(Object.values(model.authorization).every((value) => value === false));
});

test("77 — result validation rejects semantic, authority, event, and snapshot reference forgery", () => {
  const result = buildReadOnlyRunProjectionModel({ authoritySnapshot: domainSnapshot() });
  for (const mutate of [
    (value) => { value.semantic.currentStage = "Execution"; },
    (value) => { value.authorization.executionAllowed = true; },
    (value) => { value.eventIntents[0].persisted = true; },
    (value) => { value.sourceSnapshotDigest = canonicalDigest("other"); value.eventIntents[0].intentDigest = canonicalDigest({ bindingDigest: value.bindingDigest, sourceSnapshotDigest: value.sourceSnapshotDigest, semanticDigest: value.semanticDigest }); },
    (value) => { value.semantic.nodeStates[0].rawOutput = "forged"; rebindIntent(value); },
    (value) => { value.semantic.projectionStates[0].projectionId = "M3-A07"; rebindIntent(value); },
    (value) => { value.semantic.projectionStates[6].evaluationStatus = "in_doubt"; rebindIntent(value); },
  ]) {
    const forged = structuredClone(result); mutate(forged);
    assert.throws(() => assertValidReadOnlyRunProjectionModel(forged));
  }
});

async function bridgeVariant(enabled) {
  const runId = "m3-a08-bridge-parity";
  const stageDagPacket = buildStageDagPacket({ stageOrder: ["Execution", "Review"], stageLanes: { Execution: [{ laneId: "projection-worker", laneKind: "execution_worker", ownerBindingRef: "owner:projection-worker", capabilityBindingRef: "capability:projection-worker", dependsOn: [], effectClass: "read_only_worker", resourceScopes: ["file:package.json"], isolation: "shared_read_only", status: "planned_not_invoked" }], Review: [] }, runtimeCapacity: 1 });
  const kernel = await openDurableRunKernel(); let calls = 0;
  try {
    const assessment = (state) => { const core = { state, evidenceRefs: [] }; return { ...core, assessmentDigest: canonicalDigest(core) }; };
    const controlCore = { state: "none", controlRef: null, evidenceRefs: [] };
    const policyDigest = canonicalDigest("bridge-policy:a08");
    const result = await runStageRunnerBridge({ runId, runtime: "codex", stageDagPacket, workerTaskPackets: [{ taskPacketId: "projection-worker", ownerAgent: "test-automator", description: "Observe projection parity", output: "projection observed", dependsOn: [], executionMode: "primary_execution", externalWriteBoundary: false }], workspaceRoot: process.cwd(), durable: { enabled: true, kernel, mode: "create", taskFingerprint: `task:${runId}`, ownerId: `owner:${runId}`, leaseMs: 10_000 }, evidenceTransitionShadow: { policyDigest, evidenceClaims: [{ claimId: "claim:bridge-a08", producerRef: "producer:bridge-a08", evidenceType: "test_result", subjectRef: "subject:bridge-a08", payloadDigest: canonicalDigest("bridge-payload:a08") }], validatorAssessments: [{ claimId: "claim:bridge-a08", validatorRef: "validator:bridge-a08", assessment: "verified", assessmentDigest: canonicalDigest("bridge-assessment:a08"), reasonCode: "independent_check_passed" }], decisionDependencies: [], transitionRequest: { proposalId: "proposal:bridge-a08", fromStage: "execution", toStage: "review", requiredClaimIds: ["claim:bridge-a08"] } }, continuationPolicyShadow: { policyDigest, evaluationRevision: 0, goalAssessment: assessment("unfinished"), workAssessment: assessment("executable_candidate_present"), evidenceAssessment: assessment("new_valid_evidence_expected"), blockerAssessment: assessment("none"), humanDecisionAssessment: assessment("not_required"), scopeAssessment: assessment("inside"), repeatAssessment: assessment("novel"), controlAssessment: { ...controlCore, assessmentDigest: canonicalDigest(controlCore) } }, todoDependencySafeProgressShadow: {}, schedulerAuthorityReuseShadow: {}, leaseClaimAuthorityShadow: {}, runtimeHealthProjection: {}, quotaUsageProjection: {}, ...(enabled ? { readOnlyRunProjectionSurfaces: { copy, statusColumnMap } } : {}), evidenceKind: "test_double", invokeWorker: async ({ runtime }) => { calls += 1; return { status: "pass", runtime, exitCode: 0, startedAt: "2026-08-12T00:00:00.000Z", endedAt: "2026-08-12T00:00:00.001Z", durationMs: 1, sessionId: `session:${runId}`, messageId: `message:${runId}`, outputText: "meta-kim", outputSha256: "a".repeat(64), rawOutputSha256: "b".repeat(64), hostEventCount: 1, toolEventCount: 1, stderrTail: "" }; } });
    const projection = kernel.projectRun(runId);
    const resume = kernel.resumeRun({ runId, graphDigest: stageDagPacket.graphDigest, taskFingerprint: `task:${runId}` });
    return { result, calls, attested: { projection: isAttestedDurableRunProjection(projection), resume: isAttestedDurableRunResume(resume), clonedProjection: isAttestedDurableRunProjection(structuredClone(projection)), clonedResume: isAttestedDurableRunResume(structuredClone(resume)) }, legacy: { status: result.status, nodeRecords: result.nodeRecords.map(({ nodeId, status, outputSha256 }) => ({ nodeId, status, outputSha256 })), cursor: projection.cursor, eventTypes: projection.events.map((item) => item.eventType), checkpointId: projection.headCheckpointId, completedNodeIds: projection.completedNodes.map((item) => item.nodeId) } };
  } finally { kernel.close(); }
}

test("77 — bridge opt-in is the trusted producer and preserves durable legacy truth", async () => {
  const off = await bridgeVariant(false); const on = await bridgeVariant(true);
  assert.equal(Object.hasOwn(off.result, "readOnlyRunProjectionSurfaces"), false);
  assert.equal(Object.hasOwn(on.result, "readOnlyRunProjectionSurfaces"), true);
  assert.deepEqual(on.legacy, off.legacy);
  assert.equal(off.calls, 1); assert.equal(on.calls, 1);
  assert.deepEqual(on.attested, { projection: true, resume: true, clonedProjection: false, clonedResume: false });
  const projection = on.result.readOnlyRunProjectionSurfaces;
  assert.equal(projection.evaluationStatus, "evaluated");
  assert.equal(projection.result.model.status, "projected");
  assert.equal(projection.result.model.semantic.projectionStates.every((item) => item.evaluationStatus === "evaluated"), true);
  assert.match(projection.result.surfaces.markdown.content, /Projection: projected/u);
  assert.ok(Object.entries(projection.authority).filter(([field]) => field.endsWith("Allowed")).every(([, value]) => value === false));
  assert.equal(JSON.stringify(on.legacy).includes("readOnlyRunProjection"), false);
});

test("77 — machine contract and source graph enforce Domain/Application/Data/Presentation separation", () => {
  const contract = JSON.parse(readFileSync("config/contracts/read-only-run-projection-surfaces-contract.json", "utf8"));
  assert.deepEqual(contract.authoritySnapshot.canonicalBindingKeys, IDS);
  assert.equal(contract.invariants.fourSurfacesShareSemanticDigest, true);
  assert.match(contract.statusRule.in_doubt, /not_evaluated|in_doubt/u);
  assert.equal(contract.layers.sharedDigest.module, "src/domain/shared/canonical-digest.mjs");
  const domain = readFileSync("src/domain/presentation/read-only-run-projection-surfaces.mjs", "utf8");
  const application = readFileSync("src/application/presentation/build-read-only-run-projection-surfaces.mjs", "utf8");
  const data = readFileSync("src/data/projections/read-only-run-authority-snapshot.mjs", "utf8");
  const presentation = readFileSync("src/presentation/run-surfaces/read-only-run-surface-renderers.mjs", "utf8");
  const bridge = readFileSync("scripts/governed-execution/stage-runner-bridge.mjs", "utf8");
  assert.doesNotMatch(domain, /node:|\b(?:HTML|Markdown|locale|i18n)\b/u);
  assert.doesNotMatch(`${domain}\n${application}\n${data}\n${presentation}`, /\b(?:appendEvent|claimNode|completeNode|resumeRun|projectRun|dispatch|TaskCreate|TodoWrite)\s*\(/u);
  assert.match(application, /normalizeReadOnlyRunAuthoritySnapshot/u);
  assert.match(application, /buildReadOnlyRunProjectionModel/u);
  assert.match(application, /renderReadOnlyRunSurfaces/u);
  assert.match(bridge, /buildReadOnlyRunAuthoritySnapshot/u);
  assert.match(bridge, /readOnlyRunProjectionSurfaces/u);
  assert.doesNotMatch(presentation, /node:(?:fs|path|process|net|http|https)|\.meta-kim\/state|sqlite/u);
});
