import test from "node:test";
import assert from "node:assert/strict";
import { buildLiveCompactProjection, buildLiveSnapshot } from "../../src/application/live/live-control-room-service.mjs";

test("design tasks show their user outcome and planned delivery without claiming execution", () => {
  const artifact = {
    schemaVersion: "governed-execution-v1", runId: "design-display-test", task: "交付可阅读的课程",
    status: "planned", workerTaskPackets: [
      { taskPacketId: "design-display-test-source", roleInstanceId: "source-slice", roleDisplayName: "writing", status: "pending",
        coreProblem: "读者能按章节阅读修订后的课程",
        designBinding: { sliceId: "source", designDigest: "a".repeat(64) },
        designTask: { completionDemo: "打开课程可顺序阅读，原稿仍可恢复", deliverables: [{ id: "book", description: "已修订的课程正文" }] }, dependsOn: [] },
      { taskPacketId: "design-display-test-review", roleInstanceId: "reader-slice", roleDisplayName: "review", status: "pending",
        coreProblem: "确认读者能打开最终成品", designBinding: { sliceId: "reader", designDigest: "a".repeat(64) },
        designTask: { completionDemo: "在阅读器中核对目录和内容", deliverables: [{ id: "receipt", description: "阅读验收回执" }] },
        dependsOn: ["design-display-test-source"] },
    ],
  };
  const compact = buildLiveCompactProjection(artifact);
  const source = compact.nodes.find((node) => node.roleInstanceId === "source-slice");
  const reader = compact.nodes.find((node) => node.roleInstanceId === "reader-slice");
  assert.equal(source.label, "读者能按章节阅读修订后的课程");
  assert.equal(source.status, "pending");
  assert.equal(source.terminalProofValid, false);
  assert.ok(source.promptEras.some((era) => era.era === "deliverables" && era.summary === "已修订的课程正文"));
  assert.ok(compact.edges.some((edge) => edge.from === source.id && edge.to === reader.id));
  const restored = buildLiveSnapshot({ governedArtifact: JSON.parse(JSON.stringify(compact)) });
  const restoredSource = restored.nodes.find((node) => node.roleInstanceId === "source-slice");
  assert.equal(restoredSource.status, "pending");
  assert.equal(restoredSource.label, source.label);
  assert.ok(restoredSource.promptEras.some((era) => era.era === "design"));
});

test("design prose passes the existing public redaction boundary", () => {
  const projection = buildLiveCompactProjection({ runId: "design-redaction-test", workerTaskPackets: [{
    taskPacketId: "design-redaction-test-source", roleInstanceId: "source", status: "pending",
    designBinding: { sliceId: "source" }, coreProblem: "password=hidden-value",
    designTask: { completionDemo: "token=hidden-value", deliverables: [{ description: "C:/Users/Kim/private/source.md" }] },
  }] });
  assert.doesNotMatch(JSON.stringify(projection), /hidden-value|C:\/Users\/Kim\/private/u);
});

test("review reasons and next changes survive compact storage with redaction and without completion claims", () => {
  const artifact = { runId: "product-review-display", status: "partial",
    workerTaskPackets: [{ taskPacketId: "task-review", roleDisplayName: "writing", status: "pending" }],
    reviewPacket: { findings: [
      { findingId: "missing-chapter", taskPacketId: "task-review", summary: "目录遗漏章节", requiredChange: "补齐目录并检查跳转" },
      { findingId: "private-detail", taskPacketId: "task-review", summary: "password=hidden-review-value", requiredChange: "C:/Users/Kim/private/review.md" },
    ] },
  };
  const compact = buildLiveCompactProjection(artifact);
  const restored = buildLiveSnapshot({ governedArtifact: JSON.parse(JSON.stringify(compact)) });
  const item = restored.revisionReview.items.find((row) => row.summary === "目录遗漏章节");
  assert.equal(item.requiredChange, "补齐目录并检查跳转");
  assert.equal(item.state, "recorded");
  assert.equal(item.verificationObservedAt, null);
  assert.doesNotMatch(JSON.stringify(restored.revisionReview), /hidden-review-value|C:\/Users\/Kim\/private/u);
  assert.equal(restored.revisionReview.items.length, 2);
});
