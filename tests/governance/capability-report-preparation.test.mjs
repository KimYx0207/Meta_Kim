import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";

let fixture, runCapabilityGapCompleteProduct, runCoreMvpAcceptance;
before(async () => {
  fixture = createGovernanceRuntimeFixtureScope(null);
  ({ runCapabilityGapCompleteProduct } = await fixture.import("scripts/run-capability-gap-complete-product.mjs"));
  ({ runCoreMvpAcceptance } = await fixture.import("scripts/run-core-mvp-acceptance.mjs"));
});
after(() => fixture?.cleanup());

async function assertPendingReport(report, { jsonPath, markdownPath, consumer }) {
  assert.equal(report.artifactKind, "host_preparation");
  assert.equal(report.status, "partial");
  assert.equal(report.preparation.status, "needs_thinking");
  assert.equal(report.summary.consumer, consumer);
  assert.equal(report.nextAction.action, "produce_current_critical_understanding");
  assert.deepEqual(report.nextAction, report.hostInvocationRequestPacket.nextAction);
  assert.deepEqual(report.workerTaskPackets, []);
  assert.equal(report.coreLoop.stageDagPacket, undefined);
  assert.equal(report.coreLoop.executionResult.actualWorkerExecution, false);
  assert.equal(report.hostInvocationRequestPacket.executionAllowed, false);
  assert.equal(report.publicReadyDecision.publicReady, false);
  const source = JSON.parse(await readFile(report.paths.json, "utf8"));
  assert.equal(source.runId, report.runId);
  assert.deepEqual(source.hostInvocationRequestPacket, report.hostInvocationRequestPacket);
  const sourceMarkdown = await readFile(report.paths.markdown, "utf8");
  assert.equal(await readFile(markdownPath, "utf8"), sourceMarkdown);
  const saved = JSON.parse(await readFile(jsonPath, "utf8"));
  assert.equal(saved.preparation.bindingDigest, source.preparation.bindingDigest);
  assert.deepEqual(saved.nextAction, source.hostInvocationRequestPacket.nextAction);
}

test("a natural-language capability report preserves the real host preparation and existing diagnostic database", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-kim-capability-report-preparation-"));
  try {
    const options = {
      task: "我想做一个帮助小团队整理客户反馈的工具，先帮我明确该怎么设计。",
      jsonPath: path.join(root, "report.json"), markdownPath: path.join(root, "report.md"),
      dbPath: path.join(root, "existing.sqlite"),
    };
    const priorDatabase = "existing diagnostic state must remain untouched before host reasoning";
    await writeFile(options.dbPath, priorDatabase);
    const report = await runCapabilityGapCompleteProduct(options);
    assert.equal(report.task, options.task, "prepare the actual user request instead of a hardcoded acceptance scenario");
    await assertPendingReport(report, { ...options, consumer: "capability_gap_complete_product" });
    assert.equal(await readFile(options.dbPath, "utf8"), priorDatabase);
    assert.equal(report.requirementChecks, undefined, "preparation does not manufacture a formal acceptance report");
    assert.equal(report.governedExecutionEvidence, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the Core MVP report returns the same pending host action while retaining readable preparation sources", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-kim-core-report-preparation-"));
  try {
    const options = { jsonPath: path.join(root, "report.json"), markdownPath: path.join(root, "report.md") };
    const report = await runCoreMvpAcceptance(options);
    await assertPendingReport(report, { ...options, consumer: "core_mvp_acceptance" });
    assert.equal(report.frChecks, undefined);
    assert.equal(report.metricChecks, undefined);
    assert.equal(report.summary.completeProductMvp, undefined, "pending understanding is not product acceptance");
  } finally { await rm(root, { recursive: true, force: true }); }
});
