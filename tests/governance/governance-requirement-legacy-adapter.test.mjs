import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLegacyGovernanceRequirementSnapshot,
  deriveGovernanceTaskFacts,
} from "../../scripts/governed-execution/governance-requirement-legacy-adapter.mjs";

function routeFixture(overrides = {}) {
  const base = {
    workerTaskPackets: [{
      taskPacketId: "task-1",
      externalWriteBoundary: false,
      executionMode: "direct",
      capabilityRequirements: ["local-code"],
    }],
    fetchEvidence: {
      sources: [{ sourceType: "local_contract", source: "config/contracts/core-loop-contract.json" }],
    },
    selectedExecutionRoute: {
      routeExecutionGate: {
        handoffStatus: "ready_for_host_handoff",
      },
    },
    reviewResult: { status: "pass", owner: "meta-prism" },
    verificationResult: { status: "pass", owner: "meta-prism", command: "npm test" },
  };
  return { ...base, ...overrides };
}

function planChallengeFixture(active = false) {
  return {
    planChallengeState: {
      active,
      planChallengeSatisfied: !active,
      pendingUserChoice: active ? { status: "required_not_invoked" } : null,
    },
    unresolvedQuestions: active ? [{ questionId: "q-1" }] : [],
  };
}

test("derives bounded normalized facts from existing classifier and route signals", () => {
  const facts = deriveGovernanceTaskFacts({
    task: "Refactor this internal module and run tests",
    orchestrationReport: routeFixture(),
    planChallengePreview: planChallengeFixture(false),
    requestedSideEffectActions: [],
  });

  assert.equal(facts.schemaVersion, "governance-task-facts-v1");
  assert.equal(facts.intent.executable, true);
  assert.equal(facts.change.behaviorPreservingInternalOnly, true);
  assert.equal(facts.change.externalSideEffect, false);
  assert.equal(facts.decision.internalImplementationOnly, true);
  assert.equal(facts.evidence.currentExternalFactsRequired, false);
  assert.equal(facts.evidence.localEvidenceSufficient, true);
  assert.deepEqual(facts.verification.deterministicChecks, ["check:legacy-verification-command"]);
  assert.doesNotMatch(JSON.stringify(facts), /Refactor this internal module/u);
  assert.equal(Object.isFrozen(facts), true);
  assert.equal(Object.isFrozen(facts.change), true);
});

test("derives research only from a current external-fact demand, not generic route inventory", () => {
  const facts = deriveGovernanceTaskFacts({
    task: "Check the latest third-party SDK and API compatibility",
    orchestrationReport: routeFixture(),
    planChallengePreview: planChallengeFixture(false),
    requestedSideEffectActions: [],
  });
  assert.equal(facts.evidence.currentExternalFactsRequired, true);
  assert.equal(facts.evidence.localEvidenceSufficient, false);
});

test("legacy human-decision parity includes route-native choice requirements", () => {
  const snapshot = buildLegacyGovernanceRequirementSnapshot({
    task: "Refactor this internal module and run tests",
    orchestrationReport: routeFixture({
      selectedExecutionRoute: {
        routeExecutionGate: { handoffStatus: "awaiting_native_choice" },
        entryChoiceDecision: {
          critical: { required: true },
          thinking: { required: false },
        },
      },
    }),
    planChallengePreview: planChallengeFixture(false),
    requestedSideEffectActions: [],
  });
  assert.equal(snapshot.gates.humanDecision.required, true);
});

test("security and side-effect signals conservatively require permission review", () => {
  const facts = deriveGovernanceTaskFacts({
    task: "Deploy the production database migration",
    orchestrationReport: routeFixture({
      workerTaskPackets: [{
        taskPacketId: "task-1",
        externalWriteBoundary: true,
        executionMode: "approval_gate",
        capabilityRequirements: ["database", "deployment"],
      }],
    }),
    planChallengePreview: planChallengeFixture(true),
    requestedSideEffectActions: ["deploy-production"],
  });

  assert.equal(facts.change.externalSideEffect, true);
  assert.equal(facts.change.dataMigration, true);
  assert.equal(facts.security.permission, true);
  assert.equal(facts.security.production, true);
  assert.equal(facts.decision.internalImplementationOnly, false);
  assert(facts.decision.reasonableOptionCount >= 2);
  assert(facts.decision.materialDimensions.includes("risk"));
});

test("legacy snapshot exposes exactly ten mapped booleans with opaque source refs", () => {
  const snapshot = buildLegacyGovernanceRequirementSnapshot({
    task: "Review and publish the release",
    orchestrationReport: routeFixture({
      workerTaskPackets: [{
        taskPacketId: "task-1",
        externalWriteBoundary: true,
        executionMode: "approval_gate",
        capabilityRequirements: ["release"],
      }],
    }),
    planChallengePreview: planChallengeFixture(true),
    requestedSideEffectActions: ["publish-release"],
  });

  const keys = [
    "clarification", "research", "planning", "humanDecision", "permission",
    "review", "metaReview", "securityReview", "verification", "evolution",
  ];
  assert.equal(snapshot.schemaVersion, "governance-requirement-legacy-snapshot-v1");
  assert.equal(snapshot.sourceRef, "legacy:governed-runner-v3");
  assert.deepEqual(Object.keys(snapshot.gates), keys);
  for (const key of keys) {
    assert.equal(typeof snapshot.gates[key].required, "boolean", key);
    assert.equal(typeof snapshot.gates[key].reason, "string", key);
    assert(snapshot.gates[key].evidence.length > 0, key);
    assert(snapshot.gates[key].evidence.every((ref) => /^legacy:[a-z0-9][a-z0-9._/-]*$/u.test(ref)));
  }
  assert.equal(snapshot.gates.humanDecision.required, true);
  assert.equal(snapshot.gates.permission.required, true);
  assert.equal(snapshot.gates.review.required, true);
  assert.equal(snapshot.gates.verification.required, true);
  assert.equal(Object.isFrozen(snapshot), true);
});

test("adapter rejects accessor-bearing and malformed orchestration inputs without reading getters", () => {
  let reads = 0;
  const orchestration = routeFixture();
  Object.defineProperty(orchestration, "workerTaskPackets", {
    enumerable: true,
    get() {
      reads += 1;
      return [];
    },
  });
  assert.throws(
    () => deriveGovernanceTaskFacts({
      task: "Fix code",
      orchestrationReport: orchestration,
      planChallengePreview: planChallengeFixture(false),
    }),
    /data properties|plain object/u,
  );
  assert.equal(reads, 0);
  assert.throws(
    () => buildLegacyGovernanceRequirementSnapshot({
      task: "Fix code",
      orchestrationReport: null,
      planChallengePreview: planChallengeFixture(false),
    }),
    /orchestrationReport/u,
  );
});
