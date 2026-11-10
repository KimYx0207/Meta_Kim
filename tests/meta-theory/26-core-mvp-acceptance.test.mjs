import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
let runtimeFixture, runCoreMvpAcceptance;
before(async () => {
  runtimeFixture = createGovernanceRuntimeFixtureScope(null, { graph: true });
  ({ runCoreMvpAcceptance } = await runtimeFixture.import("scripts/run-core-mvp-acceptance.mjs"));
});
after(() => runtimeFixture?.cleanup());

describe("26 — Core MVP acceptance report", async () => {
  test("keeps acceptance pending until the current host supplies Critical and Thinking evidence", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-core-acceptance-"));
    try {
      const jsonPath = path.join(tempDir, "acceptance.json");
      const markdownPath = path.join(tempDir, "acceptance.md");
      const report = await runCoreMvpAcceptance({ jsonPath, markdownPath });
      assert.equal(report.artifactKind, "host_preparation");
      assert.equal(report.status, "partial");
      assert.equal(report.preparation.status, "needs_thinking");
      assert.equal(report.summary.consumer, "core_mvp_acceptance");
      assert.equal(report.nextAction.stage, "Critical");
      assert.equal(report.nextAction.producer, "current_host_ai");
      assert.deepEqual(report.workerTaskPackets, []);
      assert.equal(report.coreLoop.stageDagPacket, undefined);
      assert.equal(report.publicReadyDecision.publicReady, false);
      assert.equal(report.frChecks, undefined, "Fixture replay alone cannot certify product acceptance");
      assert.equal(report.metricChecks, undefined);
      const saved = JSON.parse(await readFile(jsonPath, "utf8"));
      assert.equal(saved.preparation.bindingDigest, report.preparation.bindingDigest);
      const markdown = await readFile(markdownPath, "utf8");
      assert.equal(markdown, await readFile(report.paths.markdown, "utf8"));
      assert.match(markdown, /needs_thinking/u);
      assert.match(markdown, /尚未形成正式执行工单/u);
      // The paired source survives the diagnostic's temporary replay cleanup.
      assert.equal(JSON.parse(await readFile(report.paths.json, "utf8")).runId, report.runId);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
