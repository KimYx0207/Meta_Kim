import assert from "node:assert/strict";
import test from "node:test";
import { buildLiveSnapshot } from "../../src/application/live/live-control-room-service.mjs";

const runId = "meta-feedback-revision";
const now = "2026-10-26T08:00:00.000Z";
const packet = (id, extra = {}) => ({ taskPacketId: id, ownerAgent: "javascript-pro", roleDisplayName: "frontend", roleInstanceId: "feedback", evidenceLevel: "owner_reported", scope: "src/private/file.mjs", expectedOutput: "反馈可保存并能追踪返工", ...extra });
const artifact = () => ({ runId, updatedAt: now, currentStage: "execution", workerTaskPackets: [packet("task-new", { replacesTaskPacketId: "task-old", logicalTaskPacketId: "task-old" })], workerResultPackets: [] });

test("durable governance activeness survives native evidence uncertainty without promoting execution", () => {
  const raw = artifact();
  const durableStatus = { runId, active: true, lifecycleStatus: "active", currentStage: "execution", updatedAt: "2026-10-25T08:00:00.000Z", workerTaskPackets: raw.workerTaskPackets };
  const snapshot = buildLiveSnapshot({ durableStatus, governedArtifact: raw, observedAt: now });
  assert.equal(snapshot.run.active, false);
  assert.equal(snapshot.run.governance.active, true);
  assert.equal(snapshot.run.governance.currentStage, "execution");
  assert.equal(snapshot.nodes.find((item) => item.isMain === false).task, "反馈可保存并能追踪返工");
  assert.ok(snapshot.nodes.every((item) => item.active !== true));
  assert.ok(snapshot.nodes.every((item) => !item.statusReason?.includes("运行当前不活跃")));
  const stopped = buildLiveSnapshot({ durableStatus: { ...durableStatus, active: false, lifecycleStatus: "session_stopped" }, governedArtifact: raw, observedAt: now });
  assert.equal(stopped.run.governance.active, false);
  const claimed = buildLiveSnapshot({ governedArtifact: { ...raw, governance: { active: true }, active: true }, observedAt: now });
  assert.equal(claimed.run.governance, null);
});

test("the revision view joins current findings with replacement tasks and bounded owner recheck reports", () => {
  const raw = artifact();
  const finding = { runId, findingId: "finding:11111111-1111-4111-8111-111111111111", feedbackId: "feedback:22222222-2222-4222-8222-222222222222", taskPacketId: "task-old", summary: "保存后刷新没有保留" };
  raw.hostRevision = { runId, revisionId: "revision-6", status: "revision_requested", findings: [finding] };
  raw.hostRevisionHistory = [{ revisionId: "revision-6", invalidated: { workerTaskPackets: [packet("task-old")] } }];
  const read = () => buildLiveSnapshot({ governedArtifact: raw, observedAt: now }).revisionReview;
  assert.equal(read().items[0].state, "recorded");
  const response = { runId, revisionId: "revision-6", actionId: "revision-6", findingId: finding.findingId, feedbackId: finding.feedbackId, sourceTaskPacketId: "task-old", taskPacketId: "task-new", summary: "已补保存", status: "reported_revised", nativeInvocationVerified: false };
  raw.revisionResponses = [response];
  assert.equal(read().items[0].state, "pending_verification");
  assert.equal(read().items[0].feedbackId, finding.feedbackId);
  assert.equal(read().items[0].findingRef, finding.findingId);
  assert.notEqual(read().items[0].sourceTaskPacketId, read().items[0].taskPacketId);
  raw.verificationPacket = { verificationResults: [{ ...response, passed: true }] };
  assert.equal(read().items[0].state, "verification_unconfirmed");
  for (const change of [{ runId: "other" }, { revisionId: "revision-foreign" }, { sourceTaskPacketId: "task-unrelated" }, { taskPacketId: "task-unrelated" }]) {
    raw.revisionResponses = [{ ...response, ...change }];
    assert.equal(read().items[0].state, "recorded");
  }
  const oldTarget = `deliverable:${"a".repeat(24)}`;
  const newTarget = `deliverable:${"b".repeat(24)}`;
  const oldVersion = `sha256:${"a".repeat(64)}`;
  const newVersion = `sha256:${"b".repeat(64)}`;
  Object.assign(finding, { deliverableId: oldTarget, contentVersion: oldVersion });
  const revised = { ...response, sourceDeliverableId: oldTarget, sourceContentVersion: oldVersion, deliverableId: newTarget, contentVersion: newVersion };
  raw.revisionResponses = [revised];
  raw.verificationPacket = { verificationResults: [{ ...revised, passed: true }] };
  assert.equal(read().items[0].state, "verification_unconfirmed");
  assert.equal(read().items[0].sourceDeliverableId, oldTarget);
  assert.equal(read().items[0].deliverableId, newTarget);
  raw.verificationPacket.verificationResults[0].contentVersion = oldVersion;
  assert.equal(read().items[0].state, "pending_verification");
  raw.revisionResponses = [{ ...revised, sourceDeliverableId: newTarget }];
  assert.equal(read().items[0].state, "recorded");
});

test("archived rechecks stay with their original revision and exact output/source bindings", () => {
  const raw = artifact();
  const oldTarget = `deliverable:${"a".repeat(24)}`;
  const target = `deliverable:${"b".repeat(24)}`;
  const oldVersion = `sha256:${"a".repeat(64)}`;
  const contentVersion = `sha256:${"b".repeat(64)}`;
  const finding = { runId, findingId: "finding-old", taskPacketId: "task-old", summary: "Old issue", deliverableId: oldTarget, contentVersion: oldVersion };
  const response = { runId, revisionId: "revision-6", actionId: "revision-6", findingId: finding.findingId, sourceTaskPacketId: "task-old", taskPacketId: "task-new", sourceDeliverableId: oldTarget, sourceContentVersion: oldVersion, deliverableId: target, contentVersion, status: "reported_revised" };
  const newResponse = { ...response, revisionId: "revision-12", actionId: "revision-12", sourceTaskPacketId: "task-new", taskPacketId: "task-latest", sourceDeliverableId: target, sourceContentVersion: contentVersion, contentVersion: `sha256:${"c".repeat(64)}` };
  raw.hostRevision = { runId, revisionId: "revision-12", findings: [{ ...finding, taskPacketId: "task-new", deliverableId: target, contentVersion, summary: "Current issue" }] };
  raw.workerTaskPackets = [packet("task-latest", { replacesTaskPacketId: "task-new", revisionId: "revision-12" })];
  raw.hostRevisionHistory = [
    { runId, revisionId: "revision-6", findings: [finding], invalidated: { workerTaskPackets: [packet("task-old")] } },
    { runId, revisionId: "revision-12", findings: raw.hostRevision.findings, invalidated: { previousRevision: { runId, revisionId: "revision-6" }, workerTaskPackets: [packet("task-new", { replacesTaskPacketId: "task-old", revisionId: "revision-6" })], records: { verificationPacket: { runId, revisionId: "revision-6", actionId: "revision-6", checks: [{ ...response, passed: true }], verificationResults: [{ ...response, passed: true }] } } } },
  ];
  raw.revisionResponses = [response, newResponse];
  const read = () => Object.fromEntries(buildLiveSnapshot({ governedArtifact: raw, observedAt: now }).revisionReview.items.map((item) => [item.summary, item.state]));
  assert.deepEqual(read(), { "Old issue": "verification_unconfirmed", "Current issue": "pending_verification" });
  const archived = raw.hostRevisionHistory[1].invalidated.records.verificationPacket;
  for (const change of [{ runId: "meta-foreign" }, { revisionId: "revision-12" }, { actionId: "revision-12" }, { taskPacketId: "task-latest" }, { sourceTaskPacketId: "task-wrong" }, { sourceDeliverableId: target }, { sourceContentVersion: contentVersion }, { deliverableId: oldTarget }, { contentVersion: oldVersion }]) {
    archived.checks = archived.verificationResults = [{ ...response, passed: true, ...change }];
    assert.deepEqual(read(), { "Old issue": "pending_verification", "Current issue": "pending_verification" });
  }
  archived.checks = archived.verificationResults = [{ ...newResponse, passed: true }];
  assert.deepEqual(read(), { "Old issue": "pending_verification", "Current issue": "pending_verification" }, "new revision records in the old archive cannot recheck the new work");
  archived.checks = archived.verificationResults = [{ ...response, passed: true }];
  archived.runId = "meta-foreign";
  assert.deepEqual(read(), { "Old issue": "pending_verification", "Current issue": "pending_verification" });
});
