import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  analyzeFitnessResults,
  buildTrialPlan,
  governanceInstructionsForGroup,
  runFitnessLab,
  validateFitnessLabDefinition,
} from "../../scripts/run-harness-fitness-lab.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const contract = JSON.parse(
  await readFile(
    path.join(repoRoot, "config/contracts/harness-fitness-ablation-contract.json"),
    "utf8",
  ),
);
const scenarios = JSON.parse(
  await readFile(
    path.join(repoRoot, "config/evals/harness-fitness-ablation-tasks.json"),
    "utf8",
  ),
);

let tempRoot;
before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "meta-kim-fitness-ablation-test-"));
});
after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

test("62 — P-135 defines a four-group cumulative component ladder and 36-trial matrix", () => {
  assert.deepEqual(validateFitnessLabDefinition(contract, scenarios), { ok: true, errors: [] });
  assert.equal(contract.prdTaskId, "P-135");
  assert.equal(contract.primaryRuntime, "codex");
  assert.equal(contract.experiment.expectedLiveTrialCount, 36);
  assert.deepEqual(
    contract.experiment.groups.map((group) => group.id),
    ["baseline", "slim", "reviewed", "full"],
  );
  assert.deepEqual(
    contract.experiment.componentComparisons.map((comparison) => comparison.id),
    ["core_governance", "review_chain", "evolution", "full_vs_slim"],
  );
  assert.equal(contract.latestFormalResult.status, "decision_ready");
  assert.equal(contract.latestFormalResult.completedTrialCount, 36);
  assert.deepEqual(contract.latestFormalResult.decisions, {
    core_governance: "degrade_to_conditional",
    review_chain: "degrade_to_conditional",
    evolution: "remove_from_default_scaffold",
  });
  assert.equal(contract.truthBoundary.fixtureRunsCountAsProductEvidence, false);
  assert.equal(contract.truthBoundary.dockerRunsCountAsProductEvidence, false);
  assert.match(contract.componentDecisionPolicy.preservationBoundary, /must not delete/);
});

test("62 — every held-out behavior check maps to one visible requirement", () => {
  for (const task of scenarios.tasks) {
    assert.equal(task.requirements.length, 5);
    assert.equal(task.blindChecks.length, 5);
    const requirementIds = new Set(task.requirements.map((requirement) => requirement.id));
    assert.equal(requirementIds.size, 5);
    for (const check of task.blindChecks) {
      assert.ok(requirementIds.has(check.requirementId));
      assert.match(check.command, /^node --test /);
    }
  }

  const invalid = structuredClone(scenarios);
  invalid.tasks[0].blindChecks[0].requirementId = "hidden-only-requirement";
  const result = validateFitnessLabDefinition(contract, invalid);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /lacks a visible requirement mapping/.test(error)));
});

test("62 — the scaffold ladder adds only the intended governance bundles", () => {
  const baseline = governanceInstructionsForGroup("baseline");
  const slim = governanceInstructionsForGroup("slim");
  const reviewed = governanceInstructionsForGroup("reviewed");
  const full = governanceInstructionsForGroup("full");

  assert.match(baseline, /does not use Meta_Kim governance/);
  for (const stage of ["Critical", "Fetch", "Thinking", "Execution", "Verification"]) {
    assert.match(slim, new RegExp(`## ${stage}`));
  }
  assert.doesNotMatch(slim, /## Review|## Meta-Review|## Evolution/);
  assert.match(reviewed, /## Review/);
  assert.match(reviewed, /## Meta-Review/);
  assert.doesNotMatch(reviewed, /## Evolution/);
  assert.match(full, /## Review/);
  assert.match(full, /## Meta-Review/);
  assert.match(full, /## Evolution/);
});

test("62 — planner gives every P-135 task/group three deterministic repetitions", () => {
  const plan = buildTrialPlan(contract, scenarios, { trials: 3, seed: "p135-plan-test" });
  assert.equal(plan.length, 36);
  for (const task of scenarios.tasks) {
    for (const group of contract.experiment.groups) {
      assert.equal(
        plan.filter((item) => item.taskId === task.id && item.groupId === group.id).length,
        3,
      );
    }
  }
  assert.deepEqual(
    plan,
    buildTrialPlan(contract, scenarios, { trials: 3, seed: "p135-plan-test" }),
  );
});

test("62 — fixture gold solutions pass all behavior checks but stay diagnostic", async () => {
  const run = await runFitnessLab({
    experimentId: "p135",
    mode: "run",
    provider: "fixture",
    trials: 1,
    seed: "p135-fixture-test",
    runId: "p135-fixture-test",
    stateRoot: tempRoot,
    workspaceRoot: path.join(tempRoot, "workspaces"),
    timeoutMs: 120000,
    maxCases: null,
    model: null,
  });
  assert.equal(run.report.prdTaskId, "P-135");
  assert.equal(run.report.status, "diagnostic_only");
  assert.equal(run.report.countsTowardProductEvidence, false);
  assert.equal(run.report.results.length, 12);
  assert.ok(run.report.results.every((result) => result.environmentOutcomeSuccess));
  assert.ok(run.report.results.every((result) => result.blindQuality.score === 5));
  assert.ok(
    run.report.results.every((result) =>
      result.blindQuality.checks.every((check) => check.requirementId && check.passed),
    ),
  );
});

test("62 — completed fixture trials resume after the provider result became structured", async () => {
  const options = {
    experimentId: "p135",
    mode: "run",
    provider: "fixture",
    trials: 1,
    seed: "p135-resume-test",
    runId: "p135-resume-test",
    stateRoot: tempRoot,
    workspaceRoot: path.join(tempRoot, "resume-workspaces"),
    timeoutMs: 120000,
    maxCases: null,
    model: null,
  };
  const first = await runFitnessLab(options);
  const second = await runFitnessLab(options);
  assert.deepEqual(
    second.report.results.map((result) => result.completedAt),
    first.report.results.map((result) => result.completedAt),
  );
  assert.ok(second.report.results.every((result) => typeof result.provider === "object"));
});

function syntheticResults({ saturated = false, equalCosts = false } = {}) {
  const plan = buildTrialPlan(contract, scenarios, { trials: 3, seed: "p135-analysis-test" });
  const costs = {
    baseline: 100,
    slim: 120,
    reviewed: 144,
    full: 240,
  };
  return {
    plan,
    results: plan.map((item) => {
      const baselineHardClass =
        item.groupId === "baseline" && item.taskClass !== "fuzzy_product_task";
      const success = saturated ? true : !baselineHardClass;
      const score = saturated ? 5 : baselineHardClass ? 3 : 5;
      return {
        ...item,
        countsTowardProductEvidence: true,
        environmentOutcomeSuccess: success,
        blindQuality: { score },
        metrics: {
          wallClockMs: equalCosts ? 100 : costs[item.groupId],
          inputTokens: equalCosts ? 100 : costs[item.groupId],
          outputTokens: 10,
          toolCallCount: 2,
          reworkCount: 0,
          failureType: success ? null : "held_out_environment_failure",
        },
      };
    }),
  };
}

test("62 — a discriminative full matrix emits keep/degrade/remove decisions", () => {
  const { plan, results } = syntheticResults();
  const report = analyzeFitnessResults(contract, plan, results, "codex");
  assert.equal(report.status, "decision_ready");
  assert.equal(report.summary.benchmarkDiscriminationPass, true);
  assert.ok(report.taskClassDiscrimination.every((item) => item.discriminative));
  assert.deepEqual(
    Object.fromEntries(report.componentComparisons.map((item) => [item.id, item.decision])),
    {
      core_governance: "keep",
      review_chain: "degrade_to_conditional",
      evolution: "remove_from_default_scaffold",
      full_vs_slim: "comparison_only",
    },
  );
});

test("62 — a saturated full matrix is invalid and cannot decide components", () => {
  const { plan, results } = syntheticResults({ saturated: true, equalCosts: true });
  const report = analyzeFitnessResults(contract, plan, results, "codex");
  assert.equal(report.status, "invalid_saturation");
  assert.equal(report.summary.benchmarkDiscriminationPass, false);
  assert.ok(report.taskClassDiscrimination.every((item) => !item.discriminative));
  assert.ok(
    report.componentComparisons
      .filter((item) => item.id !== "full_vs_slim")
      .every((item) => item.decision === "insufficient_evidence"),
  );
});

test("62 — equal perfect outcomes can prove overhead without claiming quality benefit", () => {
  const { plan, results } = syntheticResults({ saturated: true });
  const report = analyzeFitnessResults(contract, plan, results, "codex");
  assert.equal(report.status, "decision_ready");
  assert.ok(report.taskClassDiscrimination.every((item) => item.costDiscriminative));
  assert.ok(report.taskClassDiscrimination.every((item) => !item.outcomeOrQualityDiscriminative));
});

test("62 — a one-repetition full ladder can calibrate discrimination without deciding policy", () => {
  const plan = buildTrialPlan(contract, scenarios, { trials: 1, seed: "p135-calibration-test" });
  const results = plan.map((item) => {
    const baselineHardClass =
      item.groupId === "baseline" && item.taskClass !== "fuzzy_product_task";
    return {
      ...item,
      countsTowardProductEvidence: true,
      environmentOutcomeSuccess: !baselineHardClass,
      blindQuality: { score: baselineHardClass ? 3 : 5 },
      metrics: {
        wallClockMs: 100,
        inputTokens: 100,
        outputTokens: 10,
        toolCallCount: 2,
        reworkCount: 0,
        failureType: baselineHardClass ? "held_out_environment_failure" : null,
      },
    };
  });
  const report = analyzeFitnessResults(contract, plan, results, "codex");
  assert.equal(report.status, "pilot_incomplete");
  assert.equal(report.summary.calibrationDiscriminationPass, true);
  assert.equal(report.summary.benchmarkDiscriminationPass, false);
  assert.ok(
    report.componentComparisons
      .filter((item) => item.id !== "full_vs_slim")
      .every((item) => item.decision === "insufficient_evidence"),
  );
});

test("62 — package exposes P-135 validation, fixture, pilot, and formal commands", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.match(pkg.scripts["meta:fitness:ablation:validate"], /--experiment=p135 --validate/);
  assert.match(pkg.scripts["meta:fitness:ablation:plan"], /--experiment=p135 --plan --trials 3/);
  assert.match(pkg.scripts["meta:fitness:ablation:fixture"], /--experiment=p135/);
  assert.match(pkg.scripts["meta:fitness:ablation:pilot"], /--provider=codex --trials 1/);
  assert.match(pkg.scripts["meta:fitness:ablation:run"], /--provider=codex --trials 3/);
  assert.match(
    pkg.scripts["meta:verify:governance:core"],
    /meta:fitness:ablation:validate/,
  );
});
