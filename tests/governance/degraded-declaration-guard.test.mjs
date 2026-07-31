import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateFanoutGate,
  validateDegradedDeclaration,
} from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import {
  evaluateFanoutGate as evaluateFanoutGateFromGates,
  validateDegradedDeclaration as validateDegradedDeclarationFromGates,
} from "../../canonical/runtime-assets/shared/hooks/spine-state-gates.mjs";

// Same-type failure fix: SKILL.md Degraded Mode requires capabilityGapPacket,
// but no hook enforces it. This guard closes the escape hatch so a run cannot
// declare `degradedMode: true` without prior capability search evidence.

const baseExecutionState = {
  currentStage: "execution",
  dispatchedAgents: [],
  workerTaskPackets: [{ id: "w1" }, { id: "w2" }],
};

test("spine-state facade preserves degraded and fan-out gate exports", () => {
  assert.equal(validateDegradedDeclaration, validateDegradedDeclarationFromGates);
  assert.equal(evaluateFanoutGate, evaluateFanoutGateFromGates);
});

test("validateDegradedDeclaration: rejects degraded=true when capability search never ran", () => {
  const r = validateDegradedDeclaration({
    ...baseExecutionState,
    degradedMode: true,
    fetchRecord: { capabilitySearchPerformed: false },
  });
  assert.equal(r.valid, false);
  assert.ok(
    r.reason.includes("capabilitySearchPerformed"),
    `reason must name missing evidence: ${r.reason}`,
  );
});

test("validateDegradedDeclaration: rejects degraded=true when capabilityMatches list is empty", () => {
  const r = validateDegradedDeclaration({
    ...baseExecutionState,
    degradedMode: true,
    fetchRecord: {
      capabilitySearchPerformed: true,
      capabilityMatches: [],
    },
  });
  assert.equal(r.valid, false);
  assert.ok(r.reason.includes("capabilityMatches"));
});

test("validateDegradedDeclaration: rejects degraded=true when fewer than 3 agents were checked", () => {
  const r = validateDegradedDeclaration({
    ...baseExecutionState,
    degradedMode: true,
    fetchRecord: {
      capabilitySearchPerformed: true,
      capabilityMatches: [
        { agent: "frontend-developer" },
        { agent: "backend-architect" },
      ],
    },
  });
  assert.equal(r.valid, false);
  assert.ok(r.reason.includes("3"));
});

test("validateDegradedDeclaration: accepts degraded=true when >=3 agents checked + search performed", () => {
  const r = validateDegradedDeclaration({
    ...baseExecutionState,
    degradedMode: true,
    fetchRecord: {
      capabilitySearchPerformed: true,
      capabilityMatches: [
        { agent: "meta-warden" },
        { agent: "meta-prism" },
        { agent: "meta-conductor" },
      ],
    },
  });
  assert.equal(r.valid, true);
  assert.equal(r.reason, null);
});

test("validateDegradedDeclaration: returns valid=true when degradedMode is false", () => {
  const r = validateDegradedDeclaration({
    ...baseExecutionState,
    degradedMode: false,
    fetchRecord: { capabilitySearchPerformed: false },
  });
  assert.equal(r.valid, true);
});

test("validateDegradedDeclaration: returns valid=true when degradedMode is undefined", () => {
  const r = validateDegradedDeclaration(baseExecutionState);
  assert.equal(r.valid, true);
});

test("validateDegradedDeclaration: does not throw on null / empty / malformed state", () => {
  assert.equal(validateDegradedDeclaration(null).valid, true);
  assert.equal(validateDegradedDeclaration(undefined).valid, true);
  assert.equal(validateDegradedDeclaration({}).valid, true);
});

test("evaluateFanoutGate: now triggers when degraded=true but declaration is invalid", () => {
  const state = {
    ...baseExecutionState,
    degradedMode: true,
    fetchRecord: { capabilitySearchPerformed: false },
  };
  const r = evaluateFanoutGate(state);
  assert.equal(
    r.triggered,
    true,
    "degraded with no capability evidence must still trigger fan-out gate",
  );
  assert.equal(
    r.degraded,
    false,
    "degraded flag is false because the declaration was rejected",
  );
  assert.ok(r.reason && r.reason.includes("degraded"));
});

test("evaluateFanoutGate: stays untriggered when degraded=true and declaration is valid", () => {
  const state = {
    ...baseExecutionState,
    degradedMode: true,
    fetchRecord: {
      capabilitySearchPerformed: true,
      capabilityMatches: [
        { agent: "a" },
        { agent: "b" },
        { agent: "c" },
      ],
    },
  };
  const r = evaluateFanoutGate(state);
  assert.equal(r.triggered, false);
  assert.equal(r.degraded, true);
});

test("evaluateFanoutGate: still triggers when not degraded (legacy behavior preserved)", () => {
  const r = evaluateFanoutGate({
    ...baseExecutionState,
    degradedMode: false,
  });
  assert.equal(r.triggered, true);
});

test("evaluateFanoutGate: still skips single-lane + dispatched + non-execution paths", () => {
  const cases = [
    { ...baseExecutionState, workerTaskPackets: [] },
    { ...baseExecutionState, dispatchedAgents: ["x"] },
    { ...baseExecutionState, currentStage: "critical" },
  ];
  for (const c of cases) {
    assert.equal(evaluateFanoutGate(c).triggered, false);
  }
});
