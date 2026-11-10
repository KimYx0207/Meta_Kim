import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import * as runtimeClaims from "../../scripts/runtime-capability-claims.mjs";
import { evaluateRouteExecutionGate } from "../../scripts/runtime-execution-gate.mjs";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
import { fixtureCritical, fixtureReadWorkOrder, refreshFixtureSourcePins, runWithFixtureHostThinking } from "../helpers/host-reasoning-fixture.mjs";
import { localProtocolFixtureTaskFacts } from "../helpers/task-design-facts.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function claim(overrides = {}) {
  return {
    hostSupport: "native",
    metaKimIntegration: "host_only",
    acceptanceRequirement: "required",
    acceptanceState: "not_run",
    routeEligibility: "host_handoff_eligible",
    evidenceRefs: ["fixture.host-contract"],
    ...overrides,
  };
}

function matrixWith(claimOverrides = {}) {
  const interactiveClaim = claim(claimOverrides);
  return {
    platforms: [{
      platform: "codex",
      capabilities: ["shell"].map((capability) => ({
        capability,
        claimsByMode: { interactive_host: structuredClone(interactiveClaim) },
      })),
    }],
  };
}

test("reviewer PoC: host handoff eligibility is independent from historical execution acceptance", () => {
  assert.equal(typeof runtimeClaims.claimIsHostHandoffEligible, "function");
  assert.equal(runtimeClaims.claimIsHostHandoffEligible(claim()), true);
  assert.equal(runtimeClaims.claimIsExecutable(claim()), false);
  assert.equal(
    runtimeClaims.claimIsHostHandoffEligible(claim({ routeEligibility: "executable" })),
    true,
  );
  for (const ineligible of [
    claim({ routeEligibility: "not_executable" }),
    claim({ routeEligibility: "reference_only" }),
    claim({ hostSupport: "unknown" }),
    claim({ metaKimIntegration: "projected_unaccepted" }),
  ]) {
    assert.equal(runtimeClaims.claimIsHostHandoffEligible(ineligible), false);
  }
});

test("reviewer PoC: missing acceptance allows host handoff while not_executable remains blocked", () => {
  const handoff = evaluateRouteExecutionGate({
    runtime: "codex",
    taskShape: "default_executable",
    effectiveMatrix: matrixWith(),
  });
  assert.equal(handoff.routeCompatible, true, handoff.blockers.join("\n"));
  assert.equal(handoff.handoffStatus, "ready_for_host_handoff");
  assert.equal(handoff.allowed, false);
  assert.match(handoff.checks.flatMap((item) => item.advisories).join("\n"), /acceptance/iu);

  const blocked = evaluateRouteExecutionGate({
    runtime: "codex",
    taskShape: "default_executable",
    effectiveMatrix: matrixWith({ routeEligibility: "not_executable" }),
  });
  assert.equal(blocked.routeCompatible, false);
  assert.equal(blocked.handoffStatus, "blocked");
});

test("reviewer PoC: Claude and Codex static interactive claims use the legal handoff enum", () => {
  const matrix = JSON.parse(
    readFileSync(path.join(repoRoot, "config", "runtime-capability-matrix.json"), "utf8"),
  );
  const platform = (runtime) => new Map(
    matrix.platforms.find((item) => item.platform === runtime).capabilities
      .map((item) => [item.capability, item.claimsByMode?.interactive_host]),
  );
  const expectedHandoff = ["agent", "subagent", "shell", "filesystem", "apply_patch / edit"];
  for (const runtime of ["claude_code", "codex"]) {
    const capabilities = platform(runtime);
    for (const capability of expectedHandoff) {
      assert.equal(
        capabilities.get(capability)?.routeEligibility,
        "host_handoff_eligible",
        `${runtime}.${capability}`,
      );
    }
  }
  assert.equal(
    platform("claude_code").get("native choice surface")?.routeEligibility,
    "host_handoff_eligible",
  );
  assert.equal(
    platform("codex").get("native choice surface")?.routeEligibility,
    "not_executable",
  );
});

test("reviewer PoC: an unexecuted worker plan is attributed to host handoff, not plan challenge", async (t) => {
  const fixture = createGovernanceRuntimeFixtureScope(t);
  refreshFixtureSourcePins(fixture);
  const { runMetaTheoryGovernedExecution } = await fixture.import("scripts/run-meta-theory-governed-execution.mjs");
  const task = "请检查当前项目架构并给出只读改进建议。";
  const criticalInput = fixtureCritical({ task, successCriteria: [{ id: "source-advice", condition: task, evidenceRequired: "Current package metadata and source-bound architecture advice" }] });
  const governanceTaskFacts = localProtocolFixtureTaskFacts(task);
  const report = await runWithFixtureHostThinking(runMetaTheoryGovernedExecution, {
      task,
      runId: "round10-worker-attribution",
      projectRoot: fixture.repoRoot,
      stateDir: path.join(fixture.root, "state"),
      dbPath: path.join(fixture.root, "runs.sqlite"),
      projectCapabilityMutationMode: "read_only",
    }, {
      criticalInput, governanceTaskFacts,
      workOrders: preparation => [fixtureReadWorkOrder(preparation, { id: "architecture-source-read", owner: "analysis", todayTask: task,
        output: "Source-bound architecture advice", criterionIds: ["source-advice"], taskFacts: governanceTaskFacts })],
    });
    assert.equal(report.preDecisionOptionFrame.planChallengeState.active, false);
    assert.equal(report.coreLoop.executionResult.actualWorkerExecution, false);
    assert.equal(report.coreLoop.executionResult.executionGate, "host_native_handoff_required");
    assert.equal(report.coreLoop.executionResult.executionAllowed, false);
    assert.ok(report.coreLoop.executionResult.workerResultPackets.length > 0);
    assert.equal(
      report.coreLoop.executionResult.workerResultPackets.every(
        (item) =>
          item.status === "planned_not_executed" &&
          item.resultKind === "planned_not_executed_by_runner",
      ),
      true,
    );
});
