import assert from "node:assert/strict";
import test from "node:test";
import { buildLiveCompactProjection, buildLiveSnapshot } from "../../src/application/live/live-control-room-service.mjs";
import { resolveLiveRunOverview, resolveLiveNodeTaskLifecycle, resolveLiveRunTaskLifecycle, serializeLiveRunOverviewResolvers } from "../../src/presentation/live/live-run-overview.mjs";
import { publicTaskBinding } from "../../canonical/runtime-assets/shared/hooks/governed-task-reference.mjs";

const runId = "product-outcome-current";
const review = () => ({ schemaVersion: 1, runId, status: "fail", reviewDigest: "a".repeat(64), reviewRef: "fixture:current-review",
  outcomeEvaluation: { status: "fail", results: [{ criterionId: "K1", required: true, status: "fail" }, { criterionId: "K2", required: true, status: "pass" }, { criterionId: "K3", required: false, status: "fail" }] },
  coveredTaskCriteria: [{ taskId: "producer", criterionId: "K1", required: true, verdict: "fail" }, { taskId: "independent", criterionId: "K2", required: true, verdict: "pass" }, { taskId: "independent", criterionId: "K3", required: false, verdict: "fail" }],
  revisionRequests: [], nextAction: { action: "prepare_revision", stage: "Review", taskIds: ["producer"], criterionIds: ["K1"] } });
const artifact = () => ({ schemaVersion: "governed-execution-v1", runId, task: "Review the actual deliverable", status: "partial",
  workerTaskPackets: ["producer", "independent"].map(id => ({ taskPacketId: id, roleInstanceId: id, roleDisplayName: "backend", status: "pending" })), outcomeReviewPacket: review() });
const completedNode = id => ({ id, runId, kind: "worker", taskPacketId: publicTaskBinding(id), status: "completed", active: false });

test("product outcome survives compact persistence with required/optional and exact task binding", () => {
  const compact = buildLiveCompactProjection(artifact());
  assert.equal(compact.productOutcomeReview?.status, "fail");
  const snapshot = buildLiveSnapshot({ governedArtifact: JSON.parse(JSON.stringify(compact)) });
  assert.equal(snapshot.productOutcomeReview.status, "fail");
  assert.equal(snapshot.productOutcomeReview.criteria.find(row => row.criterionId === "K3").required, false);
  assert.deepEqual(snapshot.productOutcomeReview.nextAction.taskPacketIds, [publicTaskBinding("producer")]);
  assert.equal(snapshot.productOutcomeReview.nativeInvocationVerified, false);
  assert.equal(snapshot.productOutcomeReview.publicReady, false);
});

test("current failed required criterion reopens only its task and the aggregate, preserving independent results", () => {
  const compact = buildLiveCompactProjection(artifact());
  const snapshot = { run: { id: runId, status: "completed", active: false }, nodes: [completedNode("producer"), completedNode("independent")], productOutcomeReview: compact.productOutcomeReview };
  assert.equal(resolveLiveNodeTaskLifecycle(snapshot.nodes[0], snapshot).detail, "outcome_revision_required");
  assert.equal(resolveLiveNodeTaskLifecycle(snapshot.nodes[1], snapshot).state, "completed");
  assert.equal(resolveLiveRunTaskLifecycle(snapshot).state, "in_progress");
  assert.equal(resolveLiveRunTaskLifecycle(snapshot).completedCount, 1);
  assert.equal(resolveLiveRunOverview(snapshot).state, "blocked");
  const client = new Function(serializeLiveRunOverviewResolvers() + "; return resolveLiveNodeTaskLifecycle;")();
  assert.deepEqual(client(snapshot.nodes[0], snapshot), resolveLiveNodeTaskLifecycle(snapshot.nodes[0], snapshot));
});

test("missing task mapping cannot hide a failed product review; optional failures alone add no mandatory gate", () => {
  const source = artifact(); source.outcomeReviewPacket.coveredTaskCriteria = []; source.outcomeReviewPacket.nextAction.taskIds = [];
  const snapshot = { run: { id: runId, status: "completed" }, nodes: [completedNode("independent")], productOutcomeReview: buildLiveCompactProjection(source).productOutcomeReview };
  assert.equal(resolveLiveRunTaskLifecycle(snapshot).detail, "outcome_revision_required");
  source.outcomeReviewPacket.status = "pass";
  source.outcomeReviewPacket.outcomeEvaluation = { status: "pass", results: [{ criterionId: "K3", required: false, status: "fail" }] };
  snapshot.productOutcomeReview = buildLiveCompactProjection(source).productOutcomeReview;
  assert.equal(resolveLiveRunTaskLifecycle(snapshot).state, "completed");
  assert.equal(resolveLiveRunTaskLifecycle({ ...snapshot, productOutcomeReview: null }).state, "completed");
});

test("a required failure beyond the compact detail budget still blocks aggregate completion", () => {
  const source = artifact();
  source.outcomeReviewPacket.coveredTaskCriteria = [];
  source.outcomeReviewPacket.nextAction.taskIds = [];
  source.outcomeReviewPacket.outcomeEvaluation.results = Array.from({ length: 129 }, (_, i) => ({ criterionId: `K${i + 1}`, required: true, status: i === 128 ? "fail" : "pass" }));
  const compact = buildLiveCompactProjection(source);
  assert.equal(compact.productOutcomeReview.criteria.length, 128);
  assert.equal(compact.productOutcomeReview.criteria.some(row => row.status === "fail"), false);
  const snapshot = { run: { id: runId, status: "completed" }, nodes: [completedNode("independent")], productOutcomeReview: compact.productOutcomeReview };
  assert.equal(resolveLiveRunTaskLifecycle(snapshot).detail, "outcome_revision_required");
  assert.equal(resolveLiveRunOverview(snapshot).state, "blocked");
  assert.equal(resolveLiveNodeTaskLifecycle(snapshot.nodes[0], snapshot).state, "completed", "An unmapped failure cannot invent a failed task");
});
