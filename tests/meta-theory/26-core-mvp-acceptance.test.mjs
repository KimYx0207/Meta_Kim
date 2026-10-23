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
  test("maps PRD FRs and quantitative metrics to executable evidence", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-core-acceptance-"));
    try {
      const jsonPath = path.join(tempDir, "acceptance.json");
      const markdownPath = path.join(tempDir, "acceptance.md");
      const report = await runCoreMvpAcceptance({ jsonPath, markdownPath });

      assert.equal(report.status, "pass");
      assert.equal(report.frChecks.length, 11);
      assert.deepEqual(
        report.frChecks.map((check) => check.id),
        [
          "FR-001",
          "FR-002",
          "FR-003",
          "FR-004",
          "FR-005",
          "FR-006",
          "FR-007",
          "FR-008",
          "FR-009",
          "FR-010",
          "FR-011",
        ]
      );
      for (const check of [...report.frChecks, ...report.metricChecks]) {
        assert.equal(check.passed, true, `${check.id} must pass`);
        assert.ok(check.evidence, `${check.id} must carry replayable evidence`);
      }

      assert.equal(report.summary.decisionsCovered, 6);
      assert.equal(report.summary.branchesCovered, 6);
      assert.equal(report.summary.agentDesignEvaluation, "pass");
      assert.equal(report.summary.governanceProcessMvp, "pass");
      assert.equal(report.summary.stationPacketsCovered, 5);
      assert.equal(report.summary.completeProductMvp, "pass");
      assert.equal(report.summary.analyticsMetrics, 6);
      assert.ok(
        report.evidence.commands.includes("npm run meta:core:mvp:acceptance")
      );
      assert.ok(
        report.evidence.commands.includes("npm run meta:gap:complete-product:acceptance")
      );
      for (const metricId of [
        "complete_product_mvp_pass",
        "analytics_decision_distribution",
        "analytics_user_corrections",
        "analytics_candidate_acceptance",
        "analytics_repeat_keys",
        "analytics_owner_failure_rate",
      ]) {
        assert.ok(
          report.metricChecks.some((check) => check.id === metricId),
          `${metricId} metric missing`
        );
      }

      const markdown = await readFile(markdownPath, "utf8");
      assert.match(markdown, /# Meta_Kim Core MVP 验收报告/);
      assert.match(markdown, /FR-009/);
      assert.match(markdown, /langgraph_branch_coverage/);
      assert.match(markdown, /station_output_coverage/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
