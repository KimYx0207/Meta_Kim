import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import * as runtimeClaims from "../../scripts/runtime-capability-claims.mjs";
import { evaluateRouteExecutionGate } from "../../scripts/runtime-execution-gate.mjs";
import { runMetaTheoryGovernedExecution } from "../../scripts/run-meta-theory-governed-execution.mjs";

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

function projectFixture(prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const projectRoot = path.join(root, "project");
  mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
  writeFileSync(path.join(projectRoot, "package.json"), '{"name":"p130-round10"}\n', "utf8");
  return {
    root,
    projectRoot,
    stateDir: path.join(root, "state"),
    dbPath: path.join(root, "state", "runs.sqlite"),
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

test("reviewer PoC: an unexecuted worker plan is attributed to host handoff, not plan challenge", async () => {
  const fixture = projectFixture("meta-kim-round10-worker-attribution-");
  try {
    const report = await runMetaTheoryGovernedExecution({
      task: "请检查当前项目架构并给出只读改进建议。",
      runId: "round10-worker-attribution",
      projectRoot: fixture.projectRoot,
      stateDir: fixture.stateDir,
      dbPath: fixture.dbPath,
      projectCapabilityMutationMode: "read_only",
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
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
