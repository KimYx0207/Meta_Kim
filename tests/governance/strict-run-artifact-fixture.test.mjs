import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const fixturePath = "tests/fixtures/run-artifacts/valid-strict-governance-run.json";

function runStrict(inputPath = fixturePath) {
  return spawnSync(process.execPath, [
    "scripts/validate-intent-amplification.mjs",
    "--strict",
    "--input",
    inputPath,
  ], { encoding: "utf8" });
}

function writeMutatedFixture(t, mutate) {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  mutate(fixture);
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-strict-context-"));
  const tempPath = path.join(tempDir, "fixture.json");
  writeFileSync(tempPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  return tempPath;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

test("strict run artifact fixture validates userGoalDone separately from command pass", () => {
  const result = runStrict();
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("strict public-ready rejects missing context packet and decision fields", (t) => {
  const tempPath = writeMutatedFixture(t, (fixture) => {
    delete fixture.contextEngineeringBudget;
    delete fixture.publicReadyDecision.contextEngineeringBudgetStatus;
    delete fixture.publicReadyDecision.contextEngineeringBudgetBlockedBy;
  });
  const result = runStrict(tempPath);
  assert.notEqual(result.status, 0, "missing context evidence must fail strict validation");
  assert.match(result.stderr, /public-ready requires contextEngineeringBudget/);
});

test("strict public-ready rejects coreLoop context masking top-level failure", (t) => {
  const tempPath = writeMutatedFixture(t, (fixture) => {
    fixture.coreLoop = {
      contextEngineeringBudget: cloneJson(fixture.contextEngineeringBudget),
      publicReadyDecision: cloneJson(fixture.publicReadyDecision),
    };
    fixture.contextEngineeringBudget.status = "partial";
  });
  const result = runStrict(tempPath);
  assert.notEqual(result.status, 0, "coreLoop pass must not mask top-level context failure");
  assert.match(
    result.stderr,
    /contextEngineeringBudget must match coreLoop\.contextEngineeringBudget/,
  );
});

test("strict public-ready rejects coreLoop decision masking top-level mismatch", (t) => {
  const tempPath = writeMutatedFixture(t, (fixture) => {
    fixture.coreLoop = {
      contextEngineeringBudget: cloneJson(fixture.contextEngineeringBudget),
      publicReadyDecision: cloneJson(fixture.publicReadyDecision),
    };
    fixture.publicReadyDecision.contextEngineeringBudgetStatus = "partial";
  });
  const result = runStrict(tempPath);
  assert.notEqual(result.status, 0, "coreLoop pass must not mask top-level decision mismatch");
  assert.match(
    result.stderr,
    /publicReadyDecision must match coreLoop\.publicReadyDecision/,
  );
});

test("strict public-ready accepts context truth at a single coreLoop location", (t) => {
  const tempPath = writeMutatedFixture(t, (fixture) => {
    fixture.coreLoop = {
      contextEngineeringBudget: fixture.contextEngineeringBudget,
      publicReadyDecision: fixture.publicReadyDecision,
    };
    delete fixture.contextEngineeringBudget;
    delete fixture.publicReadyDecision;
  });
  const result = runStrict(tempPath);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("strict public-ready rejects context status, measurement, source, and decision drift", (t) => {
  const testCases = [
    ["status", (fixture) => { fixture.contextEngineeringBudget.status = "partial"; }, /status=pass/],
    ["blockedBy", (fixture) => { fixture.contextEngineeringBudget.blockedBy = ["not_observed"]; }, /blockedBy to be empty/],
    ["host observed", (fixture) => { fixture.contextEngineeringBudget.measurement.hostObservedContextLoad = false; }, /hostObservedContextLoad=true/],
    ["input tokens", (fixture) => { fixture.contextEngineeringBudget.measurement.actualInputTokens = -1; }, /finite nonnegative number/],
    ["duplicate scan", (fixture) => { fixture.contextEngineeringBudget.measurement.duplicateRuleScanStatus = "not_run"; }, /duplicateRuleScanStatus=pass/],
    ["conflict scan", (fixture) => { fixture.contextEngineeringBudget.measurement.conflictingRuleScanStatus = "not_run"; }, /conflictingRuleScanStatus=pass/],
    ["omission check", (fixture) => { fixture.contextEngineeringBudget.measurement.omissionVerificationStatus = "not_verified"; }, /omissionVerificationStatus=pass/],
    ["source state", (fixture) => { fixture.contextEngineeringBudget.fixedContext[0].evidenceState = "declared_not_host_observed"; }, /evidenceState must be observed/],
    ["source ref", (fixture) => { delete fixture.contextEngineeringBudget.variableContext[0].evidenceRef; }, /evidenceRef must be a non-empty string/],
    ["decision status", (fixture) => { fixture.publicReadyDecision.contextEngineeringBudgetStatus = "partial"; }, /contextEngineeringBudgetStatus must match/],
    ["decision blockers", (fixture) => { fixture.publicReadyDecision.contextEngineeringBudgetBlockedBy = ["stale"]; }, /contextEngineeringBudgetBlockedBy must match/],
  ];

  for (const [name, mutate, expected] of testCases) {
    const tempPath = writeMutatedFixture(t, mutate);
    const result = runStrict(tempPath);
    assert.notEqual(result.status, 0, `${name} must fail strict validation`);
    assert.match(result.stderr, expected, name);
  }
});

test("strict non-public-ready does not require context budget", (t) => {
  const tempPath = writeMutatedFixture(t, (fixture) => {
    fixture.publicReady = false;
    fixture.publicReadyScore = 80;
    fixture.publicReadyDecision.publicReady = false;
    fixture.publicReadyDecision.status = "partial";
    fixture.publicReadyDecision.blockedBy = ["context evidence not attached"];
    delete fixture.contextEngineeringBudget;
    delete fixture.publicReadyDecision.contextEngineeringBudgetStatus;
    delete fixture.publicReadyDecision.contextEngineeringBudgetBlockedBy;
  });
  const result = runStrict(tempPath);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
