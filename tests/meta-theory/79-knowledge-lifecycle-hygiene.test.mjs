import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyKnowledgeLifecycleTransition,
} from "../../src/application/evolution/apply-knowledge-lifecycle-transition.mjs";
import {
  KNOWLEDGE_LIFECYCLE_REGISTRY_REQUIRED_METHODS,
  assertKnowledgeLifecycleRegistryPort,
} from "../../src/application/ports/knowledge-lifecycle-registry-port.mjs";
import {
  applyKnowledgeLifecycleTransitionToRegistry,
  assertKnowledgeLifecycleTransitionCandidate,
  createKnowledgeLifecycleTransitionCandidate,
  validateKnowledgeLifecycleRegistry,
} from "../../src/domain/evolution/knowledge-lifecycle.mjs";
import {
  canonicalizeKnowledgeLifecycleValue,
  digestKnowledgeLifecycleValue,
  validateWardenWritebackApproval,
} from "../../src/domain/evolution/warden-writeback-approval.mjs";
import {
  createJsonKnowledgeLifecycleRegistryRepository,
} from "../../src/data/repositories/json-knowledge-lifecycle-registry-repository.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const REGISTRY_SOURCE = path.join(ROOT, "config/governance/knowledge-lifecycle-registry.json");
const TARGET = "config/governance/decision-pattern-catalog.json";
const REPLACEMENT = "canonical/skills/meta-theory/SKILL.md";

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function tempRepository(t, mutate = (value) => value) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-a11-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const registryPath = path.join(root, "registry.json");
  const registry = mutate(await readJson(REGISTRY_SOURCE));
  const targetPath = path.join(root, ...TARGET.split("/"));
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(path.join(ROOT, ...TARGET.split("/")), targetPath);
  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  return {
    root,
    registryPath,
    repository: createJsonKnowledgeLifecycleRegistryRepository({
      registryPath,
      allowedRoot: root,
    }),
  };
}

function candidateBinding(candidate) {
  return {
    targetRef: candidate.targetRef,
    operation: candidate.operation,
    transitionId: candidate.transitionId,
    candidateDigest: candidate.candidateDigest,
    expectedSourceDigest: candidate.expectedSourceDigest,
    rollbackPlanDigest: candidate.rollbackPlanDigest,
  };
}

function approvalFor(candidate, scope = "knowledge_lifecycle_transition", overrides = {}) {
  return {
    schemaVersion: "warden-approval-v0.2",
    approvalId: `approval:${candidate.transitionId}`,
    approver: "meta-warden",
    approvedAt: "2026-08-12T01:00:00.000Z",
    scope,
    mutationBindings: [candidateBinding(candidate)],
    diffSummary: `${candidate.operation} ${candidate.targetRef}`,
    rollbackPlan: { strategy: "restore_previous_registry_entry" },
    riskReview: { verdict: "bounded", deletionAuthorized: false },
    ...overrides,
  };
}

function propose(repository, operation, transitionId, overrides = {}) {
  return createKnowledgeLifecycleTransitionCandidate({
    registry: repository.read().registry,
    targetRef: TARGET,
    operation,
    transitionId,
    reason: `A11 test ${operation}`,
    evidenceRefs: [`test:79:${transitionId}`],
    proposedAt: "2026-08-12T00:30:00.000Z",
    actor: "test-owner",
    ...overrides,
  });
}

function apply(repository, candidate, appliedAt = "2026-08-12T01:00:01.000Z", options = {}) {
  return applyKnowledgeLifecycleTransition({
    repository,
    candidate,
    approvalPacket: approvalFor(candidate),
    appliedAt,
    ...options,
  });
}

test("79 — contract and registry declare a four-state, no-delete hygiene boundary", async () => {
  const contract = await readJson(path.join(ROOT, "config/contracts/knowledge-lifecycle-hygiene-contract.json"));
  const registry = validateKnowledgeLifecycleRegistry(await readJson(REGISTRY_SOURCE));
  assert.deepEqual(contract.states, ["active", "aging", "deprecated", "retired"]);
  assert.equal(contract.persistence.deleteApi, false);
  assert.equal(contract.persistence.retiredRecords, "preserve_as_tombstone");
  assert.equal(contract.foundationalCapabilityPolicy.automaticDeletion, false);
  assert.equal(contract.referenceOnlyPolicy.promotionByLifecycleTransition, false);
  assert.equal(contract.candidatePolicy.authorityFlags.mayWrite, false);
  assert.equal(registry.policy.automaticDeletion, false);
  assert.equal(registry.entries[TARGET].executionClass, "reference_only");
});

test("79 — transition candidates are candidate-only and grant zero authority", async (t) => {
  const { repository } = await tempRepository(t);
  const candidate = propose(repository, "mark_aging", "transition:candidate-only");
  assert.equal(candidate.authorizationState, "candidate_only");
  assert.deepEqual(candidate.authorization, {
    approved: false,
    mayWrite: false,
    mayDelete: false,
    mayAuthorizeExecution: false,
  });
  assert.equal(repository.read().revision, 0);
  assert.equal(assertKnowledgeLifecycleTransitionCandidate(candidate).candidateDigest, candidate.candidateDigest);
  assert.throws(
    () => assertKnowledgeLifecycleTransitionCandidate({ ...candidate, executionClass: "execution_eligible" }),
    /unsupported or missing fields/u,
  );
});

test("79 — foundational capabilities can only retain, upgrade, or restore", async () => {
  const registry = validateKnowledgeLifecycleRegistry(await readJson(REGISTRY_SOURCE));
  assert.throws(
    () => createKnowledgeLifecycleTransitionCandidate({
      registry,
      targetRef: "canonical/skills/meta-theory/SKILL.md",
      operation: "mark_aging",
      transitionId: "transition:forbidden-foundational-aging",
      reason: "must remain foundational",
      evidenceRefs: ["test:79:foundational"],
      proposedAt: "2026-08-12T00:30:00.000Z",
      actor: "test-owner",
    }),
    /foundational capabilities may only be retained, upgraded, or restored/u,
  );
});

test("79 — legal state chain retires to a retained tombstone and restores reversibly", async (t) => {
  const { repository } = await tempRepository(t);
  const aging = propose(repository, "mark_aging", "transition:aging");
  assert.equal(apply(repository, aging).status, "applied");
  const deprecated = propose(repository, "deprecate", "transition:deprecated", {
    replacementRefs: [REPLACEMENT],
  });
  assert.equal(apply(repository, deprecated, "2026-08-12T01:00:02.000Z").status, "applied");
  const retired = propose(repository, "retire", "transition:retired");
  assert.equal(apply(repository, retired, "2026-08-12T01:00:03.000Z").status, "applied");
  const retiredEntry = repository.read().registry.entries[TARGET];
  assert.equal(retiredEntry.status, "retired");
  assert.equal(retiredEntry.executionClass, "reference_only");
  assert.equal(retiredEntry.tombstone.retained, true);
  assert.equal(retiredEntry.tombstone.deletionAuthorized, false);
  assert.deepEqual(retiredEntry.tombstone.replacementRefs, [REPLACEMENT]);

  const restored = propose(repository, "restore", "transition:restored");
  assert.equal(apply(repository, restored, "2026-08-12T01:00:04.000Z").status, "applied");
  const activeEntry = repository.read().registry.entries[TARGET];
  assert.equal(activeEntry.status, "active");
  assert.equal(activeEntry.executionClass, "reference_only");
  assert.equal(activeEntry.tombstone, undefined);
  assert.equal(repository.read().registry.history.length, 4);
});

test("79 — illegal shortcuts, missing replacements, and source mutation without upgrade fail", async (t) => {
  const { repository } = await tempRepository(t);
  assert.throws(() => propose(repository, "deprecate", "transition:skip-aging"), /not legal from active/u);
  const aging = propose(repository, "mark_aging", "transition:negative-aging");
  apply(repository, aging);
  assert.throws(
    () => propose(repository, "deprecate", "transition:no-replacement", { replacementRefs: [] }),
    /require at least one replacement/u,
  );
  assert.throws(
    () => propose(repository, "retain", "transition:source-smuggle", {
      proposedSourceDigest: digestKnowledgeLifecycleValue("changed"),
    }),
    /only upgrade may change sourceDigest/u,
  );
});

test("79 — Warden v0.2 accepts exact generic bindings for both scopes", async (t) => {
  const { repository } = await tempRepository(t);
  const candidate = propose(repository, "mark_aging", "transition:scope-validation");
  const binding = candidateBinding(candidate);
  for (const scope of ["knowledge_lifecycle_transition", "canonical_reverse_sync"]) {
    const result = validateWardenWritebackApproval({
      approvalPacket: approvalFor(candidate, scope),
      candidates: [binding],
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "approved");
    assert.match(result.approvalDigest, /^sha256:[a-f0-9]{64}$/u);
  }
  assert.equal(
    canonicalizeKnowledgeLifecycleValue({ b: 2, a: 1 }),
    canonicalizeKnowledgeLifecycleValue({ a: 1, b: 2 }),
  );
});

test("79 — approval review objects and target bindings are non-empty and unambiguous", async (t) => {
  const { repository } = await tempRepository(t);
  const first = propose(repository, "mark_aging", "transition:approval-shape");
  const second = {
    ...candidateBinding(first),
    transitionId: digestKnowledgeLifecycleValue("transition:same-target-second"),
    candidateDigest: digestKnowledgeLifecycleValue("candidate:same-target-second"),
  };
  for (const override of [{ rollbackPlan: null }, { riskReview: null }]) {
    const validation = validateWardenWritebackApproval({
      approvalPacket: approvalFor(first, "knowledge_lifecycle_transition", override),
      candidates: [first],
    });
    assert.equal(validation.ok, false);
    assert.equal(validation.status, "invalid");
  }
  const duplicateTarget = validateWardenWritebackApproval({
    approvalPacket: {
      ...approvalFor(first),
      mutationBindings: [candidateBinding(first), second],
    },
    candidates: [candidateBinding(first), second],
  });
  assert.equal(duplicateTarget.ok, false);
  assert.match(duplicateTarget.errors.join(" "), /multiple mutations for one targetRef/u);
});

test("79 — missing, legacy, loose, duplicate, and mismatched approvals cannot authorize", async (t) => {
  const { repository } = await tempRepository(t);
  const candidate = propose(repository, "mark_aging", "transition:approval-negative");
  const binding = candidateBinding(candidate);
  assert.equal(validateWardenWritebackApproval({ candidates: [binding] }).status, "approval_required");
  assert.equal(validateWardenWritebackApproval({
    approvalPacket: { schemaVersion: "warden-approval-v0.1" },
    candidates: [binding],
  }).status, "legacy_unbound");
  assert.equal(validateWardenWritebackApproval({
    approvalPacket: { ...approvalFor(candidate), unexpected: true },
    candidates: [binding],
  }).status, "invalid");
  assert.equal(validateWardenWritebackApproval({
    approvalPacket: {
      ...approvalFor(candidate),
      mutationBindings: [binding, binding],
    },
    candidates: [binding],
  }).status, "invalid");
  assert.equal(validateWardenWritebackApproval({
    approvalPacket: {
      ...approvalFor(candidate),
      mutationBindings: [{ ...binding, expectedSourceDigest: digestKnowledgeLifecycleValue("wrong") }],
    },
    candidates: [binding],
  }).status, "invalid");
  assert.equal(validateWardenWritebackApproval({
    approvalPacket: approvalFor(candidate),
    candidates: [{ ...binding, extra: true }],
  }).status, "invalid");
});

test("79 — lifecycle application refuses a canonical reverse-sync approval scope", async (t) => {
  const { repository } = await tempRepository(t);
  const candidate = propose(repository, "mark_aging", "transition:wrong-application-scope");
  const result = applyKnowledgeLifecycleTransition({
    repository,
    candidate,
    approvalPacket: approvalFor(candidate, "canonical_reverse_sync"),
    appliedAt: "2026-08-12T01:00:01.000Z",
  });
  assert.equal(result.status, "invalid");
  assert.equal(result.applied, false);
  assert.equal(repository.read().revision, 0);
});

test("79 — exact retries are idempotent while stale or conflicting CAS is rejected", async (t) => {
  const { repository } = await tempRepository(t);
  const first = propose(repository, "mark_aging", "transition:idempotent");
  const stale = propose(repository, "mark_aging", "transition:stale");
  assert.equal(apply(repository, first).status, "applied");
  const retry = apply(repository, first);
  assert.equal(retry.status, "idempotent");
  assert.equal(retry.applied, false);
  assert.equal(repository.read().revision, 1);
  assert.throws(() => apply(repository, stale), /compare-and-set precondition failed/u);

  const snapshot = repository.read();
  const conflict = structuredClone(first);
  conflict.reason = "different mutation under the same transition id";
  conflict.candidateDigest = digestKnowledgeLifecycleValue({ conflict: true });
  assert.throws(
    () => repository.compareAndSwap({
      expectedRevision: snapshot.revision,
      expectedRegistryDigest: snapshot.digest,
      transitionId: first.transitionId,
      candidateDigest: conflict.candidateDigest,
      nextRegistry: snapshot.registry,
    }),
    /different candidate/u,
  );
});

test("79 — actual source drift invalidates an already approved lifecycle transition", async (t) => {
  const { root, repository } = await tempRepository(t);
  const candidate = propose(repository, "mark_aging", "transition:source-drift");
  await fs.appendFile(path.join(root, ...TARGET.split("/")), "\nuser concurrent edit\n", "utf8");
  const result = apply(repository, candidate);
  assert.equal(result.status, "source_drift");
  assert.equal(result.applied, false);
  assert.equal(repository.read().revision, 0);
});

test("79 — injected failures before and after rename restore the exact prior bytes", async (t) => {
  for (const step of ["before_rename", "after_rename"]) {
    const { repository, registryPath } = await tempRepository(t);
    const candidate = propose(repository, "mark_aging", `transition:rollback:${step}`);
    const before = await fs.readFile(registryPath, "utf8");
    assert.throws(
      () => apply(repository, candidate, "2026-08-12T01:00:01.000Z", {
        onWriteStep(current) {
          if (current === step) throw new Error(`injected ${step}`);
        },
      }),
      new RegExp(`injected ${step}`, "u"),
    );
    assert.equal(await fs.readFile(registryPath, "utf8"), before);
    assert.equal(repository.read().revision, 0);
  }
});

test("79 — unknown top-level and per-entry user state survives a transition", async (t) => {
  const { repository } = await tempRepository(t, (registry) => {
    registry.userOwnedTopLevel = { keep: true, nested: [1, 2, 3] };
    registry.entries[TARGET].userOwnedEntryState = { note: "preserve me" };
    return registry;
  });
  const candidate = propose(repository, "mark_aging", "transition:preserve-unknown");
  apply(repository, candidate);
  const after = repository.read().registry;
  assert.deepEqual(after.userOwnedTopLevel, { keep: true, nested: [1, 2, 3] });
  assert.deepEqual(after.entries[TARGET].userOwnedEntryState, { note: "preserve me" });
});

test("79 — repository port has no delete authority and rejects implicit or escaping paths", async (t) => {
  const { root, registryPath, repository } = await tempRepository(t);
  assert.equal(assertKnowledgeLifecycleRegistryPort(repository), repository);
  assert.deepEqual(KNOWLEDGE_LIFECYCLE_REGISTRY_REQUIRED_METHODS, ["read", "readSourceDigest", "compareAndSwap"]);
  assert.equal(repository.delete, undefined);
  assert.equal(repository.remove, undefined);
  assert.throws(
    () => createJsonKnowledgeLifecycleRegistryRepository({ registryPath: "registry.json", allowedRoot: root }),
    /explicit absolute path/u,
  );
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-a11-outside-"));
  t.after(() => fs.rm(outsideRoot, { recursive: true, force: true }));
  const outsideRegistry = path.join(outsideRoot, "registry.json");
  await fs.copyFile(registryPath, outsideRegistry);
  assert.throws(
    () => createJsonKnowledgeLifecycleRegistryRepository({ registryPath: outsideRegistry, allowedRoot: root }),
    /escapes allowedRoot/u,
  );
});

test("79 — domain reducer preserves reference-only authority and records exact approval binding", async () => {
  const registry = validateKnowledgeLifecycleRegistry(await readJson(REGISTRY_SOURCE));
  const candidate = createKnowledgeLifecycleTransitionCandidate({
    registry,
    targetRef: TARGET,
    operation: "mark_aging",
    transitionId: "transition:pure-reducer",
    reason: "pure reducer coverage",
    evidenceRefs: ["test:79:pure-reducer"],
    proposedAt: "2026-08-12T00:30:00.000Z",
    actor: "test-owner",
  });
  const approvalDigest = digestKnowledgeLifecycleValue(approvalFor(candidate));
  const result = applyKnowledgeLifecycleTransitionToRegistry({
    registry,
    candidate,
    approvalDigest,
    appliedAt: "2026-08-12T01:00:00.000Z",
  });
  assert.equal(result.registry.entries[TARGET].executionClass, "reference_only");
  assert.equal(result.registry.appliedTransitions[candidate.transitionId].approvalDigest, approvalDigest);
  assert.equal(result.registry.entries[TARGET].status, "aging");
});
