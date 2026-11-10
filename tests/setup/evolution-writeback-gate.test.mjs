import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  gateDecision,
  processEvolutionPacket,
  validateFiveCriteria,
  validatePrinStPrinciples,
  checkRecursiveRisk,
} from "../../scripts/evolution-writeback-gate.mjs";
import {
  assertReverseSyncSourcePrestate,
  buildReverseSyncCandidateArtifact,
  buildReverseSyncMutationCandidate,
  rollbackReverseSyncPriorStates,
} from "../../scripts/sync-runtimes.mjs";

describe("evolution writeback gate", () => {
  const candidate = {
    targetRef: "canonical/agents/meta-warden.md",
    operation: "replace",
    transitionId: `sha256:${"a".repeat(64)}`,
    candidateDigest: `sha256:${"b".repeat(64)}`,
    expectedSourceDigest: `sha256:${"c".repeat(64)}`,
    rollbackPlanDigest: `sha256:${"d".repeat(64)}`,
  };

  function approvalFor(binding = candidate) {
    return {
      schemaVersion: "warden-approval-v0.2",
      approvalId: "approval-a11-001",
      approver: "meta-warden",
      approvedAt: "2026-08-12T00:00:00.000Z",
      scope: "canonical_reverse_sync",
      mutationBindings: [{ ...binding }],
      diffSummary: "Review one exact canonical reverse-sync mutation.",
      rollbackPlan: "Restore the exact prior bytes bound by expectedSourceDigest.",
      riskReview: { status: "accepted", owner: "meta-sentinel", qualityChecks: Object.fromEntries(Object.entries({
        fiveCriteria: ["independent", "smallEnough", "clearBoundaries", "replaceable", "reusable"],
        prinSt: ["prinSt01", "prinSt02", "prinSt03", "prinSt04", "prinSt05"],
        recursiveRisk: ["circularDependency", "transitiveOverflow", "thresholdGaming", "identityDrift"],
      }).map(([section, names]) => [section, Object.fromEntries(names.map((name) => [name, {
        verdict: "pass", reason: "Synthetic reviewer assessment for this exact test candidate", evidenceRefs: ["fixture:review-evidence"],
      }]))])) },
    };
  }

  test("keeps a structurally valid writeback candidate-only without exact Warden approval", async () => {
    const packet = {
      writebackDecision: "writeback",
      decisionReason: "durable pattern should be captured",
      writebacks: ["meta-warden"],
      mutationCandidates: [candidate],
      signalSummary: { totalSignals: 1 },
    };

    const five = await validateFiveCriteria(packet);
    const prin = await validatePrinStPrinciples(packet);
    const decision = await gateDecision(packet);

    assert.equal(five.all, false);
    assert.equal(prin.all, false);
    assert.equal(five.replaceable.status, "not_evaluated");
    assert.equal(five.replaceable.pass, null);
    assert.equal(prin.prinSt03.status, "not_evaluated");
    assert.equal(decision.decision, "candidate_only");
    assert.equal(decision.riskLevel, "medium");
    assert.equal(decision.qualityStatus, "not_evaluated");
    assert.equal(decision.approvalValidation.status, "approval_required");
  });

  test("approves only an exact Warden v0.2 mutation binding", async () => {
    const packet = {
      writebackDecision: "writeback",
      decisionReason: "durable pattern should be captured",
      writebacks: ["meta-warden"],
      mutationCandidates: [candidate],
      signalSummary: { totalSignals: 1 },
    };
    const decision = await gateDecision(packet, {
      approvalPacket: approvalFor(),
      mutationCandidates: [candidate],
    });

    assert.equal(decision.decision, "approve");
    assert.equal(decision.approvalValidation.ok, true);
    assert.equal(decision.fiveCriteria.replaceable.evidenceLevel, "reviewer_reported");
    assert.equal(decision.fiveCriteria.replaceable.evidenceContentVerified, false);
    assert.equal(decision.qualityStatus, "reviewed");
  });

  test("binds approvals to the calling writeback scope", async () => {
    const packet = {
      writebackDecision: "writeback",
      decisionReason: "cross-scope approval must remain inert",
      writebacks: ["meta-warden"],
      mutationCandidates: [candidate],
      signalSummary: { totalSignals: 1 },
    };
    const wrongScope = approvalFor();
    wrongScope.scope = "knowledge_lifecycle_transition";
    const decision = await gateDecision(packet, {
      approvalPacket: wrongScope,
      mutationCandidates: [candidate],
      requiredApprovalScope: "canonical_reverse_sync",
    });
    assert.equal(decision.decision, "candidate_only");
    assert.equal(decision.approvalValidation.ok, false);
    assert.match(decision.approvalValidation.errors.join(" "), /scope must be canonical_reverse_sync/u);
  });

  test("exports auditable reverse-sync bindings and rejects a changed source before rename", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-reverse-a11-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const canonicalPath = path.join(root, "meta-warden.md");
    await fs.writeFile(canonicalPath, "before\n", "utf8");
    const signal = {
      canonicalPath,
      canonicalContent: "before\n",
      runtimeContent: "after\n",
      type: "modified",
    };
    const mutation = buildReverseSyncMutationCandidate(signal);
    const artifact = buildReverseSyncCandidateArtifact([mutation]);
    assert.deepEqual(artifact.mutationCandidates, [mutation]);
    assert.equal(artifact.approvalPacketTemplate.scope, "canonical_reverse_sync");
    assert.deepEqual(artifact.approvalPacketTemplate.mutationBindings, [mutation]);
    assert.equal(artifact.approvalPacketTemplate.riskReview.qualityChecks.fiveCriteria.replaceable.verdict, "not_evaluated");
    assert.equal(await assertReverseSyncSourcePrestate(signal, mutation), "before\n");
    await fs.writeFile(canonicalPath, "concurrent user edit\n", "utf8");
    await assert.rejects(
      assertReverseSyncSourcePrestate(signal, mutation),
      /changed after approval candidate creation/u,
    );
  });

  test("reverse-sync rollback restores exact bytes and continues after one restore fails", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-reverse-rollback-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const first = path.join(root, "first.md");
    const second = path.join(root, "second.md");
    const firstBytes = "\uFEFFfirst\r\n";
    const secondBytes = "second\r\n";
    await fs.writeFile(first, "changed", "utf8");
    await fs.writeFile(second, "changed", "utf8");
    await rollbackReverseSyncPriorStates([
      { path: first, priorContent: firstBytes },
      { path: second, priorContent: secondBytes },
    ]);
    assert.equal(await fs.readFile(first, "utf8"), firstBytes);
    assert.equal(await fs.readFile(second, "utf8"), secondBytes);

    await fs.writeFile(first, "changed-again", "utf8");
    await fs.writeFile(second, "changed-again", "utf8");
    await assert.rejects(
      rollbackReverseSyncPriorStates(
        [
          { path: first, priorContent: firstBytes },
          { path: second, priorContent: secondBytes },
        ],
        { faultInjector: async ({ path: current }) => { if (current === second) throw new Error("injected restore failure"); } },
      ),
      AggregateError,
    );
    assert.equal(await fs.readFile(first, "utf8"), firstBytes, "later restore attempts must still run");
    assert.equal(await fs.readFile(second, "utf8"), "changed-again", "failed restore remains diagnosable");
  });

  test("force cannot substitute for exact Warden approval", async () => {
    const packet = {
      writebackDecision: "writeback",
      decisionReason: "force must remain conflict-only",
      writebacks: ["meta-warden"],
      mutationCandidates: [candidate],
      signalSummary: { totalSignals: 1 },
    };
    const result = await processEvolutionPacket(packet, {
      force: true,
      apply: true,
      mutationCandidates: [candidate],
    });

    assert.equal(result.decision, "candidate_only");
    assert.equal(result.canonicalWrites, 0);
    assert.equal(result.approved, false);
  });

  test("accepts none-with-reason as a no-writeback closure", async () => {
    const packet = {
      writebackDecision: "none-with-reason",
      decisionReason: "one-off run; no reusable governance pattern",
      writebacks: [],
      signalSummary: { totalSignals: 0 },
    };

    const decision = await processEvolutionPacket(packet);

    assert.equal(decision.decision, "approve");
    assert.equal(decision.noWriteback, true);
    assert.equal(decision.fiveCriteria.all, true);
    assert.equal(decision.prinSt.all, true);
  });

  test("rejects no-writeback decisions that still include writeback targets", async () => {
    const packet = {
      writebackDecision: "none-with-reason",
      decisionReason: "one-off run; no reusable governance pattern",
      writebacks: ["meta-warden"],
      signalSummary: { totalSignals: 0 },
    };

    const five = await validateFiveCriteria(packet);
    const decision = await gateDecision(packet);

    assert.equal(five.all, false);
    assert.equal(five.independent.pass, false);
    assert.equal(five.clearBoundaries.pass, false);
    assert.equal(decision.decision, "reject");
    assert.equal(decision.riskLevel, "high");
    assert.match(decision.reason, /No-writeback decisions cannot include writeback targets/u);
    await assert.rejects(
      processEvolutionPacket(packet),
      /No-writeback decisions cannot include writeback targets/u
    );
  });

  test("rejects self-evolution writebacks even when target is object-shaped", async () => {
    const packet = {
      writebackDecision: "writeback",
      decisionReason: "self evolution should not be allowed",
      writebacks: [{ target: "meta-chrysalis" }],
      signalSummary: { totalSignals: 1 },
    };

    const decision = await gateDecision(packet);

    assert.equal(decision.decision, "reject");
    assert.equal(decision.riskLevel, "critical");
    assert.equal(decision.recursiveRisk.selfEvolution.detected, true);
  });

  test("escalates duplicate writeback targets", async () => {
    const packet = {
      writebackDecision: "writeback",
      decisionReason: "duplicate targets should be merged first",
      writebacks: ["meta-warden", { target: "meta-warden" }],
      signalSummary: { totalSignals: 2 },
    };

    const decision = await gateDecision(packet);

    assert.equal(decision.decision, "escalate");
    assert.equal(decision.prinSt.prinSt02.pass, false);
  });

  test("zero signals and absent semantic review never report quality or risk checks passed", async () => {
    const packet = { writebackDecision: "writeback", decisionReason: "audit", writebacks: ["meta-warden"],
      mutationCandidates: [candidate], signalSummary: { totalSignals: 0 } };
    const decision = await gateDecision(packet, { approvalPacket: approvalFor() });
    assert.equal(decision.fiveCriteria.reusable.pass, false);
    assert.equal(decision.decision, "escalate");
    const unassessed = await checkRecursiveRisk(packet);
    for (const name of ["circularDependency", "transitiveOverflow", "identityDrift", "thresholdGaming"]) {
      assert.equal(unassessed[name].detected, null);
      assert.equal(unassessed[name].status, "not_evaluated");
    }
    assert.equal(unassessed.fullyEvaluated, false);
  });

  test("approval without quality evidence remains a preservable candidate and stale approval cannot import review", async () => {
    const packet = { writebackDecision: "writeback", decisionReason: "audit", writebacks: ["meta-warden"],
      mutationCandidates: [candidate], signalSummary: { totalSignals: 1 } };
    const missing = approvalFor();
    delete missing.riskReview.qualityChecks;
    const absent = await processEvolutionPacket(packet, { approvalPacket: missing });
    assert.equal(absent.approvalValidation.ok, true);
    assert.equal(absent.decision, "candidate_only");
    assert.equal(absent.canonicalWrites, 0);
    assert.equal(absent.approved, false);
    const incomplete = approvalFor();
    incomplete.riskReview.qualityChecks.fiveCriteria.replaceable.evidenceRefs = [];
    assert.equal((await gateDecision(packet, { approvalPacket: incomplete })).decision, "candidate_only");
    const stale = approvalFor({ ...candidate, candidateDigest: `sha256:${"e".repeat(64)}` });
    const rejected = await gateDecision(packet, { approvalPacket: stale });
    assert.equal(rejected.approvalValidation.ok, false);
    assert.equal(rejected.fiveCriteria.replaceable.status, "not_evaluated");
  });

  test("no-writeback cannot hide mutation candidates and canonical-path self evolution is blocked", async () => {
    const hidden = await gateDecision({ writebackDecision: "none-with-reason", decisionReason: "none", writebacks: [],
      mutationCandidates: [candidate] });
    assert.equal(hidden.decision, "reject");
    const emptyOverride = await gateDecision({ writebackDecision: "none-with-reason", decisionReason: "none", writebacks: [],
      mutationCandidates: [candidate] }, { mutationCandidates: [] });
    assert.equal(emptyOverride.decision, "reject", "An empty option cannot erase a declared candidate");
    const malformed = await gateDecision({ writebackDecision: "none-with-reason", decisionReason: "none", writebacks: [],
      mutationCandidates: { ...candidate } });
    assert.equal(malformed.decision, "reject");
    const self = await gateDecision({ writebackDecision: "writeback", decisionReason: "self", writebacks: ["canonical/agents/meta-chrysalis.md"] });
    assert.equal(self.decision, "reject");
    assert.equal(self.recursiveRisk.selfEvolution.detected, true);
    const actualSelf = { ...candidate, targetRef: "canonical/agents/META-CHRYSALIS.MD" };
    const mislabeled = await gateDecision({ writebackDecision: "writeback", decisionReason: "mislabeled candidate", writebacks: ["meta-warden"],
      mutationCandidates: [actualSelf], signalSummary: { totalSignals: 1 } }, { approvalPacket: approvalFor(actualSelf) });
    assert.equal(mislabeled.decision, "reject", "The hard recursive protection reads actual mutation targets, not just display labels");
  });

  test("reviewed recursive risks block or merge without authorizing canonical writes", async () => {
    const packet = { writebackDecision: "writeback", decisionReason: "audit", writebacks: ["meta-warden"],
      mutationCandidates: [candidate], signalSummary: { totalSignals: 1 } };
    for (const name of ["circularDependency", "transitiveOverflow", "identityDrift"]) {
      const approval = approvalFor();
      approval.riskReview.qualityChecks.recursiveRisk[name].verdict = "fail";
      assert.equal((await gateDecision(packet, { approvalPacket: approval })).decision, "reject");
    }
    const merge = approvalFor();
    merge.riskReview.qualityChecks.recursiveRisk.thresholdGaming.verdict = "fail";
    const result = await processEvolutionPacket(packet, { approvalPacket: merge });
    assert.equal(result.decision, "merge");
    assert.equal(result.approved, false);
    assert.equal(result.canonicalWrites, 0);
  });
});
