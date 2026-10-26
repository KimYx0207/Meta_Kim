import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import * as host from "../../canonical/runtime-assets/shared/hooks/governed-host-checkpoint.mjs";
import { activateSpineState, createInitialState, readSpineState, recordWorkerLifecycleEvent, terminalizeSpineState, writeSpineState } from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import { createLiveReadRepository } from "../../src/infrastructure/live/live-read-repository.mjs";
import { buildLiveSnapshot } from "../../src/application/live/live-control-room-service.mjs";
import { buildLocalFeedbackText } from "../../src/presentation/live/live-feedback-draft.mjs";

const CHAT = "01900000-0000-7000-8000-000000000001";
const ADAPTER = path.resolve("canonical/runtime-assets/shared/hooks/governed-host-checkpoint.mjs");
const packet = (id, replacesTaskPacketId) => ({ taskPacketId: id, ...(replacesTaskPacketId ? { replacesTaskPacketId } : {}),
  ownerAgent: "javascript-pro", ownerSource: "global inventory", roleDisplayName: "backend", roleInstanceId: "revision-test",
  scope: "Repair revision behavior", expectedOutput: "A corrected result", verification: "node test", mergeOwner: "meta-conductor", weapon: "runtime:apply_patch", dependsOn: [] });
const critical = { realIntent: "Keep revision work in the same run", successCriteria: ["Revision trace is preserved"], nonGoals: [], blockingUnknowns: [], noQuotaClarification: true };
const fetchRecord = { evidence: ["source.mjs"], decisionImpactMap: ["Reuse the spine"], memoryStrategy: "project_only", capabilityDiscovery: { sources: ["global inventory"], matches: ["javascript-pro"] } };
const thinking = (id, replaces) => ({ designFrame: "Existing state machine", chosenRationale: "Preserve identity", consideredLanes: ["backend"], dependencyPolicy: "one owner", reviewStandard: "Fresh checks", workerTaskPackets: [packet(id, replaces)] });

async function fixture(t, initialPackets = [packet("task-first")]) {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-revision-"));
  mkdirSync(path.join(root, ".git"));
  t.after(() => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); rmSync(root, { recursive: true, force: true }); });
  const state = createInitialState({ activationMode: "hook_observed", driverMode: "hook_observed", hookGateMode: "advisory",
    sourceConversation: { runtime: "codex", conversationId: CHAT, matchBasis: "transcript_file_verified" } });
  await activateSpineState(root, state);
  const options = { projectRoot: root, cwd: root, runId: state.runId, conversationId: CHAT };
  const checkpoint = (stage, record, extra = {}) => host.checkpointGovernedHost({ ...options, stage, input: {
    ownerAgent: "meta-conductor", summary: `Actual ${stage} report`, evidenceRefs: ["test-evidence.json"], status: "complete", record, ...extra } });
  await checkpoint("critical", critical); await checkpoint("fetch", fetchRecord); await checkpoint("thinking", { ...thinking("task-first"), workerTaskPackets: initialPackets });
  await checkpoint("execution", { workerResultPackets: initialPackets.map((item) => ({ taskPacketId: item.taskPacketId, ownerAgent: item.ownerAgent, resultStatus: "reported_complete", summary: "First draft", evidenceRefs: ["first.txt"] })) });
  const request = async (extra = {}) => {
    const current = await host.inspectGovernedHostCheckpoint(options);
    return { ownerAgent: "meta-conductor", summary: "Repair the actual finding", evidenceRefs: ["review.json"],
      expectedRevision: current.revision, expectedStage: current.currentStage, expectedStatus: current.currentStageStatus,
      findings: [{ findingId: "finding-a", feedbackId: "feedback-a", taskPacketId: "task-first", summary: "The first result needs correction" }], ...extra };
  };
  return { root, state, options, checkpoint, request };
}

async function assertLiveRevisionProjection(f, expectedState) {
  const repository = createLiveReadRepository({ projectRoot: f.root, cwd: f.root });
  const durable = await repository.readDurableStatus();
  const direct = buildLiveSnapshot({ durableStatus: durable, observedAt: new Date().toISOString() });
  const check = (snapshot) => {
    if (typeof expectedState === "string") assert.equal(snapshot.revisionReview.items[0].state, expectedState);
    else assert.deepEqual(Object.fromEntries(snapshot.revisionReview.items.map((item) => [item.summary, item.state])), expectedState);
    assert.ok(snapshot.revisionReview.items.every((item) => item.state !== "verified"));
  };
  check(direct);
  assert.equal(direct.run.governance.active, true);
  assert.equal(direct.run.publicReadyAuthority, undefined);
  const source = path.resolve(durable.__sourcePath);
  assert.ok(source.startsWith(path.resolve(f.root) + path.sep));
  assert.equal(path.basename(source), "spine-state.json");
  // Force the real repository's existing active-run fallback, retaining the authoritative file.
  renameSync(source, source + ".retained");
  try {
    const projected = await repository.readDurableStatus();
    assert.equal(path.basename(projected.__sourcePath), "active-run.json");
    assert.equal(projected.hostRevision.revisionId, durable.hostRevision.revisionId);
    assert.equal(projected.hostCheckpointRevision, durable.hostCheckpointRevision);
    assert.equal(projected.publicReadyAuthority, false);
    check(buildLiveSnapshot({ durableStatus: projected, observedAt: new Date().toISOString() }));
  } finally { renameSync(source + ".retained", source); }
}

test("same run can revise twice, preserve old reports and invalidate descendant completion", async (t) => {
  const f = await fixture(t);
  assert.equal(typeof host.returnGovernedHostToStage, "function");
  await f.checkpoint("review", { upstreamAssessment: "Actual draft reviewed", verdict: "revision", findings: ["Result differs from goal"] }, { status: "in_progress" });
  const completedOldWorker = recordWorkerLifecycleEvent(await readSpineState(f.root), { taskPacketId: "task-first", status: "completed", runtime: "codex", invocationId: "invocation-first" }, { trustedHostEvent: true });
  await writeSpineState(f.root, completedOldWorker);
  const first = await host.returnGovernedHostToStage({ ...f.options, targetStage: "thinking", input: await f.request() });
  assert.equal(first.currentStage, "thinking");
  let state = await readSpineState(f.root);
  assert.equal(state.runId, f.state.runId);
  assert.equal(state.stages.critical.status, "completed");
  assert.equal(state.stages.fetch.status, "completed");
  assert.equal(state.stages.execution.status, "pending");
  assert.equal(state.executionRecord, undefined);
  assert.equal(state.workerTaskPackets.length, 0);
  assert.equal(state.workerLifecycle.length, 0);
  assert.equal(state.hostRevisionHistory[0].invalidated.records.executionRecord.workerResultPackets[0].summary, "First draft");
  assert.equal(state.hostRevisionHistory[0].invalidated.records.reviewPacket.verdict, "revision");
  assert.equal(state.hostRevisionHistory[0].invalidated.workerLifecycle[0].status, "completed");
  assert.deepEqual(state.hostRevisionHistory[0].invalidated.workerLifecycle[0].invocationIds, ["invocation-first"]);
  await assertLiveRevisionProjection(f, "recorded");
  await assert.rejects(f.checkpoint("thinking", thinking("task-first")), /revision_task_identity_reused/);
  await f.checkpoint("thinking", thinking("task-second", "task-first"));
  assert.equal((await readSpineState(f.root)).workerLifecycle[0].status, "queued");
  const response = { findingId: "finding-a", taskPacketId: "task-second", summary: "Corrected second draft", evidenceRefs: ["second.txt"] };
  await f.checkpoint("execution", { workerResultPackets: [{ taskPacketId: "task-second", ownerAgent: "javascript-pro", resultStatus: "reported_complete", summary: "Second draft", evidenceRefs: ["second.txt"] }], revisionResponses: [response] });
  await f.checkpoint("review", { upstreamAssessment: "Second draft reviewed", verdict: "pass", findings: [] });
  await f.checkpoint("meta-review", { upstreamAssessment: "Review boundary confirmed", verdict: "pass", findings: [] });
  await f.checkpoint("verification", { checks: [{ name: "Second draft test", observedResult: "Passed", passed: true, evidenceRefs: ["test.json"], findingId: "finding-a", taskPacketId: "task-second" }] });
  state = await readSpineState(f.root);
  assert.equal(state.hostRevision.status, "verification_reported");
  assert.equal(state.workerResultPackets[0].nativeInvocationVerified, false);
  await assertLiveRevisionProjection(f, "verification_unconfirmed");
  const secondInput = await f.request({ findings: [{ findingId: "finding-b", feedbackId: "feedback-b", taskPacketId: "task-second", summary: "Follow-up correction" }], workerTaskPackets: [packet("task-third", "task-second")] });
  const second = await host.returnGovernedHostToStage({ ...f.options, targetStage: "execution", input: secondInput });
  assert.notEqual(second.revisionId, first.revisionId);
  state = await readSpineState(f.root);
  assert.equal(state.hostRevisionHistory.length, 2);
  assert.equal(state.hostRevisionHistory[1].invalidated.records.executionRecord.workerResultPackets[0].summary, "Second draft");
  assert.equal(state.stages.verification.status, "pending");
  assert.equal(state.verificationPacket, undefined);
  assert.equal(state.workerTaskPackets[0].logicalTaskPacketId, "task-first");
  assert.equal(state.workerTaskPackets[0].replacesTaskPacketId, "task-second");
  await assertLiveRevisionProjection(f, { "The first result needs correction": "verification_unconfirmed", "Follow-up correction": "recorded" });
  assert.equal(recordWorkerLifecycleEvent(state, { taskPacketId: "task-second", status: "completed", runtime: "codex" }, { trustedHostEvent: true }).workerLifecycle[0].status, "queued");
  await f.checkpoint("execution", { workerResultPackets: [{ taskPacketId: "task-third", ownerAgent: "javascript-pro", resultStatus: "reported_complete", summary: "Third draft", evidenceRefs: ["third.txt"] }], revisionResponses: [{ findingId: "finding-b", taskPacketId: "task-third", summary: "Follow-up repaired", evidenceRefs: ["third.txt"] }] });
  await f.checkpoint("review", { upstreamAssessment: "Third draft reviewed", verdict: "pass", findings: [] });
  await f.checkpoint("meta-review", { upstreamAssessment: "Actual review accepted", verdict: "pass", findings: [] });
  await f.checkpoint("verification", { checks: [{ name: "Third draft test", observedResult: "Passed", passed: true, evidenceRefs: ["test-3.json"], findingId: "finding-b", taskPacketId: "task-third" }] });
  await assertLiveRevisionProjection(f, { "The first result needs correction": "verification_unconfirmed", "Follow-up correction": "verification_unconfirmed" });
  await f.checkpoint("evolution", { decision: "none-with-reason", reason: "No further reusable gap" });
  state = await readSpineState(f.root);
  assert.equal(state.stages.evolution.status, "completed");
  assert.equal(state.revisionResponses.length, 2);
  assert.ok(state.revisionResponses.every((r) => r.nativeInvocationVerified === false && r.status === "reported_revised"));
  await host.returnGovernedHostToStage({ ...f.options, targetStage: "thinking", input: await f.request({ findings: [{ findingId: "finding-c", taskPacketId: "task-third", summary: "Unrelated third revision" }] }) });
  await assertLiveRevisionProjection(f, { "The first result needs correction": "verification_unconfirmed", "Follow-up correction": "verification_unconfirmed", "Unrelated third revision": "recorded" });
});

test("copied opaque task references resolve only the exact current work order in the bound run", async (t) => {
  const f = await fixture(t, [packet("task-first"), packet("task-another")]);
  const before = JSON.stringify(await readSpineState(f.root));
  const live = buildLiveSnapshot({ durableStatus: await readSpineState(f.root), observedAt: new Date().toISOString() });
  const displayed = live.nodes.filter((node) => !node.isMain && node.taskPacketId);
  assert.equal(displayed.length, 2);
  assert.equal(new Set(displayed.map((node) => node.task)).size, 1);
  const inspected = await host.inspectGovernedHostCheckpoint(f.options);
  assert.equal(inspected.taskReferences?.length, 2, "inspect must expose the actual public-to-raw reference bridge");
  assert.equal(typeof host.resolveGovernedHostTaskReference, "function");
  assert.deepEqual(new Set(inspected.taskReferences.map((item) => item.publicTaskRef)), new Set(displayed.map((node) => node.taskPacketId)));
  for (const entry of inspected.taskReferences) {
    const result = await host.resolveGovernedHostTaskReference({ ...f.options, taskRef: entry.publicTaskRef });
    assert.equal(result.taskReference.taskPacketId, entry.taskPacketId);
    assert.equal(result.taskReference.current, true);
    assert.equal(result.expectedRevision, inspected.revision);
    assert.equal(result.expectedStage, inspected.currentStage);
    assert.equal(result.expectedStatus, inspected.currentStageStatus);
    assert.equal(result.publicReadyAuthority, false);
  }
  const target = inspected.taskReferences.find((item) => item.taskPacketId === "task-another");
  const cli = (extra) => spawnSync(process.execPath, [ADAPTER, "--project-root", f.root, "--run-id", f.state.runId, "--conversation-id", CHAT, ...extra], { cwd: f.root, encoding: "utf8" });
  const resolvedTasks = inspected.taskReferences.map((entry, i) => {
    const copied = buildLocalFeedbackText({ runId: f.state.runId, taskPacketId: entry.publicTaskRef, findingId: `finding-ref-${i}` }, `Correction ${i}`);
    assert.match(copied, /--resolve-task-ref/u);
    const copiedReference = copied.match(/task:[a-f0-9]{20}/u)?.[0];
    const resolved = cli(["--resolve-task-ref", copiedReference]);
    assert.equal(resolved.status, 0, resolved.stderr);
    const result = JSON.parse(resolved.stdout);
    assert.equal(result.taskReference.taskPacketId, entry.taskPacketId);
    assert.equal(result.expectedRevision, inspected.revision);
    return { ...result.taskReference, findingId: `finding-ref-${i}`, summary: `Correction ${i}` };
  });
  for (const change of [{ runId: "meta-foreign" }, { conversationId: "foreign-chat" }, { cwd: path.resolve(".") }, { taskRef: "task:00000000000000000000" }, { taskRef: "task-another" }]) {
    await assert.rejects(host.resolveGovernedHostTaskReference({ ...f.options, taskRef: target.publicTaskRef, ...change }));
  }
  assert.notEqual(cli(["--inspect", "--resolve-task-ref", target.publicTaskRef]).status, 0);
  assert.equal(JSON.stringify(await readSpineState(f.root)), before, "all mapping reads and refusals are read-only");
  await host.returnGovernedHostToStage({ ...f.options, targetStage: "thinking", input: await f.request({ findings: resolvedTasks.map((entry) => ({ findingId: entry.findingId, taskPacketId: entry.taskPacketId, summary: entry.summary })) }) });
  await f.checkpoint("thinking", { ...thinking("task-first-r2", "task-first"), workerTaskPackets: resolvedTasks.map((entry) => packet(`${entry.taskPacketId}-r2`, entry.taskPacketId)) });
  await assert.rejects(host.resolveGovernedHostTaskReference({ ...f.options, taskRef: target.publicTaskRef }), /task_reference_unknown/);
  const current = await host.inspectGovernedHostCheckpoint(f.options);
  assert.ok(current.taskReferences.every((entry) => entry.logicalTaskPacketId && entry.replacesTaskPacketId && entry.current === true));
  await f.checkpoint("execution", {
    workerResultPackets: resolvedTasks.map((entry) => ({ taskPacketId: `${entry.taskPacketId}-r2`, ownerAgent: entry.ownerAgent, resultStatus: "reported_complete", summary: "Corrected result", evidenceRefs: ["corrected.txt"] })),
    revisionResponses: resolvedTasks.map((entry) => ({ findingId: entry.findingId, taskPacketId: `${entry.taskPacketId}-r2`, summary: entry.summary, evidenceRefs: ["corrected.txt"] })),
  });
  await f.checkpoint("review", { upstreamAssessment: "Both exact work orders reviewed", verdict: "pass", findings: [] });
  await f.checkpoint("meta-review", { upstreamAssessment: "Reference and revision boundaries reviewed", verdict: "pass", findings: [] });
  const checks = resolvedTasks.map((entry) => ({ findingId: entry.findingId, taskPacketId: `${entry.taskPacketId}-r2`, name: entry.summary, observedResult: "Corrected", passed: true, evidenceRefs: ["recheck.json"] }));
  await assert.rejects(f.checkpoint("verification", { checks: checks.map((check, i) => ({ ...check, taskPacketId: checks[1 - i].taskPacketId })) }), /revision_verification_binding_invalid/);
  await f.checkpoint("verification", { checks });
  await assertLiveRevisionProjection(f, { "Correction 0": "verification_unconfirmed", "Correction 1": "verification_unconfirmed" });
});

test("the task reference bridge refuses an ambiguous idempotent public reference", async (t) => {
  const f = await fixture(t);
  const live = buildLiveSnapshot({ durableStatus: await readSpineState(f.root), observedAt: new Date().toISOString() });
  const reference = live.nodes.find((node) => !node.isMain && node.taskPacketId).taskPacketId;
  const state = await readSpineState(f.root);
  state.workerTaskPackets.push(packet(reference));
  await writeSpineState(f.root, state);
  await assert.rejects(host.resolveGovernedHostTaskReference({ ...f.options, taskRef: reference }), /task_reference_ambiguous/);
});

test("return refuses wrong binding, stale CAS, skip transitions and incomplete feedback without mutation", async (t) => {
  const f = await fixture(t);
  assert.equal(typeof host.returnGovernedHostToStage, "function");
  const input = await f.request();
  const before = JSON.stringify(await readSpineState(f.root));
  assert.equal((await writeSpineState(f.root, await readSpineState(f.root), { expectedStageStatus: "completed" })).reason, "expected_stage_status_changed");
  for (const [options, error] of [
    [{ conversationId: "wrong-chat" }, /conversation_binding_mismatch/],
    [{ runId: "meta-other" }, /active_run_mismatch/],
    [{ input: { ...input, expectedRevision: input.expectedRevision - 1 } }, /revision_conflict/],
    [{ input: { ...input, expectedStage: "execution" } }, /stage_conflict/],
    [{ input: { ...input, expectedStatus: "completed" } }, /status_conflict/],
    [{ targetStage: "verification" }, /return_stage_invalid/],
    [{ input: { ...input, findings: [] } }, /revision_findings_missing/],
    [{ input: { ...input, findings: [{ findingId: "finding-a", runId: "meta-other", summary: "Foreign" }] } }, /revision_finding_binding/],
    [{ input: { ...input, findings: [{ findingId: "finding-a", taskPacketId: "not-this-task", summary: "Foreign" }] } }, /revision_finding_binding/],
  ]) {
    await assert.rejects(host.returnGovernedHostToStage({ ...f.options, targetStage: "thinking", input, ...options }), error);
    assert.equal(JSON.stringify(await readSpineState(f.root)), before);
  }
  const concurrent = await Promise.allSettled([1, 2].map(() => host.returnGovernedHostToStage({ ...f.options, targetStage: "thinking", input })));
  assert.equal(concurrent.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await readSpineState(f.root)).hostRevisionHistory.length, 1);
  await terminalizeSpineState(f.root, { expectedRunId: f.state.runId });
  await assert.rejects(host.returnGovernedHostToStage({ ...f.options, targetStage: "fetch", input }), /active_run_mismatch/);
});

test("direct execution return requires same-design fresh work orders and preserves the logical chain", async (t) => {
  const f = await fixture(t);
  assert.equal(typeof host.returnGovernedHostToStage, "function");
  const base = await f.request();
  await assert.rejects(host.returnGovernedHostToStage({ ...f.options, targetStage: "execution", input: base }), /replacement_tasks_required/);
  await assert.rejects(host.returnGovernedHostToStage({ ...f.options, targetStage: "execution", input: { ...base, workerTaskPackets: [packet("task-first", "task-first")] } }), /revision_task_identity_reused/);
  await assert.rejects(host.returnGovernedHostToStage({ ...f.options, targetStage: "execution", input: { ...base, workerTaskPackets: [{ ...packet("task-second", "task-first"), scope: "Change the entire design" }] } }), /revision_design_changed/);
  const result = await host.returnGovernedHostToStage({ ...f.options, targetStage: "execution", input: { ...base, workerTaskPackets: [packet("task-second", "task-first")] } });
  assert.equal(result.workerTaskPackets[0].taskPacketId, "task-second");
  assert.equal(result.workerTaskPackets[0].logicalTaskPacketId, "task-first");
  assert.equal(result.nativeInvocationVerified, false);
  assert.equal(result.publicReadyAuthority, false);
});

test("CLI exposes a read-only return template and requires the same revision input", async (t) => {
  const f = await fixture(t);
  const before = JSON.stringify(await readSpineState(f.root));
  const template = spawnSync(process.execPath, [ADAPTER, "--template-return"], { cwd: f.root, encoding: "utf8" });
  assert.equal(template.status, 0, template.stderr);
  assert.equal(JSON.parse(template.stdout).expectedRevision, null);
  assert.equal(JSON.stringify(await readSpineState(f.root)), before);
  const input = { ...await f.request(), expectedStatus: "in_progress" };
  const result = spawnSync(process.execPath, [ADAPTER, "--project-root", f.root, "--run-id", f.state.runId, "--conversation-id", CHAT, "--return-to", "thinking", "--input", "-"], { cwd: f.root, encoding: "utf8", input: JSON.stringify(input) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).currentStage, "thinking");
  assert.equal(JSON.parse(result.stdout).revisionId, (await readSpineState(f.root)).hostRevision.revisionId);
});

test("revision response and verification require exact finding/task/artifact bindings and never grant caller trust", async (t) => {
  const f = await fixture(t);
  const oldVersion = `sha256:${"1".repeat(64)}`;
  const newVersion = `sha256:${"2".repeat(64)}`;
  await host.returnGovernedHostToStage({ ...f.options, targetStage: "thinking", input: await f.request({
    findings: [{ findingId: "finding-a", taskPacketId: "task-first", feedbackId: "feedback-a", summary: "Wrong artifact", deliverableId: "output-a", contentVersion: oldVersion }],
    nativeInvocationVerified: true, publicReady: true,
  }) });
  await assert.rejects(f.checkpoint("thinking", thinking("task-second")), /revision_finding_replacement_missing/);
  await f.checkpoint("thinking", thinking("task-second", "task-first"));
  const results = [{ taskPacketId: "task-second", ownerAgent: "javascript-pro", resultStatus: "reported_complete", summary: "Corrected artifact", evidenceRefs: ["second.txt"] }];
  const response = { findingId: "finding-a", taskPacketId: "task-second", summary: "Revised output", evidenceRefs: ["second.txt"], deliverableId: "output-a", contentVersion: newVersion };
  for (const [responses, error] of [
    [undefined, /revision_responses_missing/],
    [[], /revision_responses_unsettled/],
    [[{ ...response, taskPacketId: "task-first" }], /revision_response_binding_invalid/],
    [[{ ...response, sourceTaskPacketId: "task-other" }], /revision_response_binding_invalid/],
    [[{ ...response, findingId: "finding-other" }], /revision_response_binding_invalid/],
    [[{ ...response, revisionId: "revision-old" }], /revision_response_binding_invalid/],
    [[{ ...response, deliverableId: "output-other" }], /revision_response_deliverable_mismatch/],
    [[{ ...response, sourceDeliverableId: "output-other" }], /revision_response_deliverable_mismatch/],
    [[{ ...response, sourceContentVersion: newVersion }], /revision_response_source_version_mismatch/],
    [[{ ...response, contentVersion: undefined }], /revision_response_version_missing/],
  ]) await assert.rejects(f.checkpoint("execution", { workerResultPackets: results, revisionResponses: responses }), error);
  await f.checkpoint("execution", { workerResultPackets: results, revisionResponses: [{ ...response, sourceDeliverableId: "output-a", deliverableId: "output-new", sourceContentVersion: oldVersion, status: "verified", nativeInvocationVerified: true, publicReady: true }] });
  await f.checkpoint("review", { upstreamAssessment: "Review actual revision", verdict: "pass", findings: [] });
  await f.checkpoint("meta-review", { upstreamAssessment: "Review reviewed", verdict: "pass", findings: [] });
  const check = { name: "Artifact test", observedResult: "Passed", passed: true, evidenceRefs: ["check.json"], findingId: "finding-a", taskPacketId: "task-second", deliverableId: "output-new", contentVersion: newVersion };
  await assert.rejects(f.checkpoint("verification", { checks: [{ name: "Unrelated test", observedResult: "Passed", passed: true, evidenceRefs: ["other.json"] }] }), /revision_verification_unsettled/);
  for (const override of [{ findingId: "finding-other" }, { taskPacketId: "task-first" }, { contentVersion: oldVersion }, { deliverableId: "output-other" },
    { runId: "meta-other" }, { revisionId: "revision-other" }, { actionId: "revision-other" }, { sourceTaskPacketId: "task-other" }, { sourceDeliverableId: "output-other" }, { sourceContentVersion: newVersion }]) {
    await assert.rejects(f.checkpoint("verification", { checks: [{ ...check, ...override }] }), /revision_verification_binding_invalid/);
  }
  const result = await f.checkpoint("verification", { checks: [{ ...check, nativeInvocationVerified: true, publicReady: true }] });
  const state = await readSpineState(f.root);
  assert.equal(result.publicReadyAuthority, false);
  assert.equal(state.publicReady, undefined);
  assert.equal(state.revisionResponses[0].status, "reported_revised");
  assert.equal(state.revisionResponses[0].nativeInvocationVerified, false);
  assert.equal(state.revisionResponses[0].sourceContentVersion, oldVersion);
  assert.equal(state.revisionResponses[0].sourceDeliverableId, "output-a");
  assert.equal(state.revisionResponses[0].deliverableId, "output-new");
  assert.equal(state.verificationPacket.verificationResults[0].nativeInvocationVerified, false);
});
