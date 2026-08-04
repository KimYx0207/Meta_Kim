import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  buildChangedFileImpactGraph,
  buildChangedFileImpactMap,
  buildFocusedRegressionSelectors,
  buildReleaseVerificationPlan,
  RELEASE_VERIFICATION_TIER_CONTRACT,
  validateReleaseVerificationTierContract,
} from "../../scripts/plan-release-verification.mjs";
import { STAGES } from "../../scripts/run-verify-all.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const CONTRACT_PATH = path.join(
  REPO_ROOT,
  "config",
  "contracts",
  "release-verification-tier-contract.json",
);
const PLANNER_PATH = path.join(REPO_ROOT, "scripts", "plan-release-verification.mjs");

test("release verification tier contract retains smoke, narrow, and full boundaries", () => {
  const rawContract = JSON.parse(readFileSync(CONTRACT_PATH, "utf8"));
  assert.equal(validateReleaseVerificationTierContract(rawContract), true);
  assert.equal(rawContract.contractId, "meta-kim-release-verification-tier-contract");
  assert.deepEqual(rawContract.tiers.narrow.requiredCheckIds, [
    "version",
    "sync",
    "packaging",
    "focused_regression",
  ]);
  assert.equal(rawContract.claimBoundary.smoke.releaseGradeClaimable, false);
  assert.equal(rawContract.claimBoundary.narrow.releaseGradeClaimable, false);
  assert.equal(rawContract.authority.full.packageScript, "meta:verify:all");
  assert.equal(rawContract.authority.full.entrypoint, "scripts/run-verify-all.mjs");
  assert.deepEqual(rawContract.tiers.full.requiredStageNames, STAGES.map(({ name }) => name));
  assert.deepEqual(
    RELEASE_VERIFICATION_TIER_CONTRACT.tiers.full.requiredStageNames,
    STAGES.map(({ name }) => name),
  );
});

test("changed-file impact map is deterministic and maps canonical, sync, and test inputs", () => {
  const impactMap = buildChangedFileImpactMap([
    "./config\\contracts\\example.json",
    "scripts/sync-runtimes.mjs",
    "tests/governance/example.test.mjs",
    ".meta-kim/state/default/verification-report.json",
    "unknown/new-input.txt",
  ]);
  assert.deepEqual(
    impactMap.map((entry) => entry.file),
    [
      ".meta-kim/state/default/verification-report.json",
      "config/contracts/example.json",
      "scripts/sync-runtimes.mjs",
      "tests/governance/example.test.mjs",
      "unknown/new-input.txt",
    ],
  );
  const contractEntry = impactMap.find((entry) => entry.file === "config/contracts/example.json");
  assert.ok(contractEntry.ruleIds.includes("canonical-governance"));
  assert.equal(contractEntry.ignored, false);
  assert.ok(contractEntry.impacts.includes("sync"));
  assert.ok(contractEntry.impacts.includes("focused_regression"));
  const stateEntry = impactMap.find((entry) => entry.file.startsWith(".meta-kim/"));
  assert.equal(stateEntry.ignored, true);
  assert.equal(stateEntry.requiresFull, false);
  const unknownEntry = impactMap.find((entry) => entry.file === "unknown/new-input.txt");
  assert.equal(unknownEntry.requiresFull, true);
  assert.deepEqual(unknownEntry.escalationReasons, ["unknown_file"]);
});

test("impact graph connects changed files to verification impacts without executing them", () => {
  const impactMap = buildChangedFileImpactMap(["config/contracts/example.json"]);
  const graph = buildChangedFileImpactGraph(impactMap);
  assert.ok(graph.nodes.some((node) => node.id === "file:config/contracts/example.json"));
  assert.ok(graph.nodes.some((node) => node.id === "impact:sync"));
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.from === "file:config/contracts/example.json" &&
        edge.to === "impact:sync" &&
        edge.relation === "matches",
    ),
  );
});

test("narrow plan always retains version, sync, packaging, and focused regression", () => {
  const plan = buildReleaseVerificationPlan([
    "config/contracts/example.json",
    "tests/governance/example.test.mjs",
  ]);
  assert.equal(plan.tier, "narrow");
  assert.equal(plan.releaseGradeClaimable, false);
  assert.deepEqual(plan.requiredCheckIds.slice(0, 4), [
    "version",
    "sync",
    "packaging",
    "focused_regression",
  ]);
  assert.ok(plan.checks.find((check) => check.id === "version").commands.some((command) => command.includes("verify-packed-user-install-update.mjs")));
  assert.ok(plan.checks.find((check) => check.id === "sync").commands.some((command) => command.includes("meta:sync")));
  assert.ok(plan.checks.find((check) => check.id === "packaging").commands.some((command) => command.includes("verify-packed-user-install-update.mjs")));
  assert.ok(plan.focusedRegressionSelectors.includes("tests/governance/example.test.mjs"));
  assert.equal(plan.claimBoundary.neverEquivalentTo.includes("full"), true);
});

test("high-risk and unknown impacts recommend full without relabeling the narrow plan", () => {
  const packagePlan = buildReleaseVerificationPlan(["package.json"]);
  assert.equal(packagePlan.tier, "narrow");
  assert.equal(packagePlan.requiresFull, true);
  assert.equal(packagePlan.recommendedTier, "full");
  assert.ok(packagePlan.escalationReasons.includes("full_only_impact"));
  assert.equal(packagePlan.releaseGradeClaimable, false);

  const unknownPlan = buildReleaseVerificationPlan(["new-area/unmapped.txt"]);
  assert.equal(unknownPlan.tier, "narrow");
  assert.equal(unknownPlan.recommendedTier, "full");
  assert.equal(unknownPlan.requiresFull, true);
  assert.ok(unknownPlan.escalationReasons.includes("unknown_file"));
});

test("smoke and full plans keep their distinct commands and claim boundaries", () => {
  const smoke = buildReleaseVerificationPlan(["README.md"], { tier: "smoke" });
  assert.equal(smoke.tier, "smoke");
  assert.equal(smoke.command, "npm run meta:release:smoke");
  assert.equal(smoke.releaseGradeClaimable, false);
  assert.equal(smoke.requiredCheckIds.includes("packaging"), false);

  const full = buildReleaseVerificationPlan(["README.md"], { tier: "full" });
  assert.equal(full.tier, "full");
  assert.equal(full.command, "npm run meta:verify:all");
  assert.equal(full.releaseGradeClaimable, false);
  assert.deepEqual(full.standardStageNames, STAGES.map(({ name }) => name));
  assert.equal(full.claimBoundary.requiredEvidenceOwner, "scripts/run-verify-all.mjs");
});

test("focused selectors fall back to the planner regression test and include changed test files", () => {
  const selectors = buildFocusedRegressionSelectors(["scripts/unrelated-helper.mjs"]);
  assert.ok(selectors.includes("tests/governance/release-verification-tier.test.mjs"));
  const changedTestSelectors = buildFocusedRegressionSelectors(["tests/governance/custom.test.mjs"]);
  assert.ok(changedTestSelectors.includes("tests/governance/custom.test.mjs"));
});

test("planner CLI emits a plan only and does not change package wiring", () => {
  const result = spawnSync(
    process.execPath,
    [PLANNER_PATH, "--tier", "narrow", "--files", "config/contracts/example.json,tests/governance/example.test.mjs"],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000, windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.tier, "narrow");
  assert.equal(plan.releaseGradeClaimable, false);
  assert.equal(plan.planner.mode, "plan_only");
  assert.equal(result.stderr, "");
});
