import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildTaskGoalContract, evaluateTaskOutcome } from "../../src/domain/governance/task-outcome.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const rule = overrides => ({ kind: "duration", unit: "ms", scope: "all selected inputs",
  conditions: "same input, machine and cache state", comparison: "lte", target: 1000, minimumSamples: 2, ...overrides });
function goal(measurement = rule()) {
  return buildTaskGoalContract({ task: "Complete the requested operation within the agreed limits.",
    acceptanceCriteria: [{ id: "measured-result", description: "Every accepted run meets the numerical target.",
      kind: "deterministic", measurement }] });
}
function sample(id, values) {
  const record = { id, ...values };
  return { ...record, evidenceRef: `evidence:${id}`, evidenceDigest: hash(record) };
}
function observation(contract, samples, overrides = {}) {
  const measurement = contract.acceptanceCriteria[0].measurement;
  return { criterionId: "measured-result", taskHash: contract.taskHash, acceptanceDigest: contract.acceptanceDigest,
    evidenceKind: "deterministic_check", evidenceRef: "evidence:complete-measurement-report", verdict: "pass",
    measurement: { unit: measurement.unit, scope: measurement.scope, conditions: measurement.conditions, samples }, ...overrides };
}

test("a reported pass cannot replace missing numerical evidence", () => {
  const contract = goal();
  const report = evaluateTaskOutcome(contract, [observation(contract, [], { measurement: undefined })]);
  assert.equal(report.status, "incomplete");
  assert.equal(report.results[0].reason, "numeric_measurement_missing");
});

test("duration is calculated from timestamps and every repeated run must meet the limit", () => {
  const contract = goal();
  const records = [sample("first", { startedAt: 10, finishedAt: 210 }), sample("second", { startedAt: 1000, finishedAt: 2200 })];
  const report = evaluateTaskOutcome(contract, [observation(contract, records)]);
  assert.equal(report.status, "fail");
  assert.deepEqual(report.results[0].measurement.samples.map(s => s.value), [200, 1200]);
  assert.equal(report.results[0].reason, "numeric_target_not_met");
});

test("two measured runs can meet the target without claiming authenticated execution", () => {
  const contract = goal();
  const report = evaluateTaskOutcome(contract, [observation(contract, [
    sample("first", { startedAt: 0, finishedAt: 999 }), sample("second", { startedAt: 2000, finishedAt: 3000 }),
  ])]);
  assert.equal(report.status, "pass");
  assert.equal(report.executionVerified, false);
  assert.equal(report.nativeInvocationVerified, false);
  assert.equal(report.publicReady, false);
});

test("a single good run does not satisfy two required measurements", () => {
  const contract = goal();
  const report = evaluateTaskOutcome(contract, [observation(contract, [sample("first", { startedAt: 0, finishedAt: 900 })])]);
  assert.equal(report.status, "incomplete");
  assert.equal(report.results[0].reason, "numeric_sample_count_not_met");
});

test("renaming a sample or evidence path cannot reuse the same evidence as an independent run", () => {
  const contract = goal();
  const first = sample("first", { startedAt: 0, finishedAt: 100 });
  const report = evaluateTaskOutcome(contract, [observation(contract, [first, { ...first, id: "renamed", evidenceRef: "evidence:other-path" }])]);
  assert.equal(report.status, "fail");
  assert.equal(report.results[0].reason, "numeric_sample_replayed");
});

test("event counters deduplicate identities instead of accepting a supplied count", () => {
  const contract = goal(rule({ kind: "count", unit: "requests", target: 2, comparison: "eq", minimumSamples: 1 }));
  const record = sample("counter", { eventIds: ["request-a", "request-a", "request-b"], value: 999 });
  const report = evaluateTaskOutcome(contract, [observation(contract, [record])]);
  assert.equal(report.status, "pass");
  assert.equal(report.results[0].measurement.samples[0].value, 2);
});

test("coverage uses the agreed denominator and cannot substitute a smaller reported total", () => {
  const contract = goal(rule({ kind: "ratio", unit: "percent", target: 100, comparison: "gte", minimumSamples: 1, expectedTotal: 4 }));
  const record = sample("coverage", { itemIds: ["a", "a", "b"], expectedTotal: 2, value: 100 });
  const report = evaluateTaskOutcome(contract, [observation(contract, [record])]);
  assert.equal(report.status, "fail");
  assert.equal(report.results[0].measurement.samples[0].value, 50);
  assert.equal(report.results[0].measurement.expectedTotal, 4);
});

test("more covered identities than the agreed population are rejected", () => {
  const contract = goal(rule({ kind: "ratio", unit: "ratio", target: 1, minimumSamples: 1, expectedTotal: 1 }));
  const report = evaluateTaskOutcome(contract, [observation(contract, [sample("coverage", { itemIds: ["a", "b"] })])]);
  assert.equal(report.status, "fail");
  assert.equal(report.results[0].reason, "numeric_coverage_exceeds_population");
});

test("units, scope and input conditions are bound to the acceptance definition", () => {
  const contract = goal();
  for (const [key, value] of [["unit", "s"], ["scope", "one small input"], ["conditions", "different cache state"]]) {
    const supplied = observation(contract, [sample("first", { startedAt: 0, finishedAt: 100 })]);
    supplied.measurement[key] = value;
    const report = evaluateTaskOutcome(contract, [supplied]);
    assert.equal(report.status, "fail", key);
    assert.equal(report.results[0].reason, "numeric_measurement_context_mismatch");
  }
});

test("reverse clocks and missing sample provenance cannot pass", () => {
  const contract = goal(rule({ minimumSamples: 1 }));
  for (const [record, reason] of [
    [sample("backwards", { startedAt: 20, finishedAt: 10 }), "numeric_clock_invalid"],
    [{ id: "no-source", startedAt: 0, finishedAt: 1 }, "numeric_sample_evidence_missing"],
  ]) {
    const report = evaluateTaskOutcome(contract, [observation(contract, [record])]);
    assert.equal(report.status, "fail");
    assert.equal(report.results[0].reason, reason);
  }
});

test("duration seconds and scalar units have explicit measurement semantics", () => {
  const seconds = goal(rule({ unit: "s", target: 1, minimumSamples: 1 }));
  const duration = evaluateTaskOutcome(seconds, [observation(seconds, [sample("seconds", { startedAt: 0, finishedAt: 1000 })])]);
  assert.equal(duration.status, "pass");
  assert.equal(duration.results[0].measurement.samples[0].value, 1);
  const scalar = goal(rule({ kind: "value", unit: "MiB", target: 32, minimumSamples: 1 }));
  assert.equal(evaluateTaskOutcome(scalar, [observation(scalar, [sample("memory", { value: 33 })])]).status, "fail");
});

test("a changed measurement goal invalidates prior acceptance evidence", () => {
  const original = goal();
  const changed = goal(rule({ target: 2000 }));
  assert.notEqual(original.acceptanceDigest, changed.acceptanceDigest);
  const report = evaluateTaskOutcome(changed, [observation(original, [sample("first", { startedAt: 0, finishedAt: 1500 })])]);
  assert.equal(report.status, "fail");
  assert.equal(report.results[0].reason, "acceptance_binding_mismatch");
});

test("numeric success cannot override an independent failed assessment", () => {
  const contract = goal(rule({ minimumSamples: 1 }));
  const report = evaluateTaskOutcome(contract, [observation(contract, [sample("first", { startedAt: 0, finishedAt: 1 })], {
    evidenceKind: "independent_review", producer: "builder", reviewer: "reviewer", verdict: "fail",
  })]);
  assert.equal(report.status, "fail");
});

test("missing measurements do not erase an already reported failure", () => {
  const contract = goal();
  const report = evaluateTaskOutcome(contract, [observation(contract, [], { verdict: "fail", measurement: undefined })]);
  assert.equal(report.status, "fail");
});

test("invalid measurement definitions fail at the existing goal input boundary", () => {
  for (const changes of [{ target: NaN }, { minimumSamples: 0 }, { comparison: "about" }, { conditions: "" },
    { kind: "ratio", unit: "ratio", target: 1 }, { kind: "duration", unit: "minutes" },
    { kind: "count", unit: "events", target: -1 }, { expectedTotal: 2 }]) {
    assert.throws(() => goal(rule(changes)), TypeError);
  }
  assert.throws(() => buildTaskGoalContract({ task: "Assess quality", acceptanceCriteria: [
    { id: "quality", description: "A reviewed result", kind: "semantic", measurement: rule() },
  ] }), /deterministic/u);
});
