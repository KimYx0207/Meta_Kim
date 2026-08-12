import {
  applyKnowledgeLifecycleTransitionToRegistry,
  assertKnowledgeLifecycleTransitionCandidate,
} from "../../domain/evolution/knowledge-lifecycle.mjs";
import {
  validateWardenWritebackApproval,
} from "../../domain/evolution/warden-writeback-approval.mjs";
import {
  assertKnowledgeLifecycleRegistryPort,
} from "../ports/knowledge-lifecycle-registry-port.mjs";

/**
 * Apply one precomputed lifecycle candidate through the application port.
 * Candidate generation grants no authority; this use case requires a Warden
 * v0.2 exact binding and delegates the only durable mutation to repository CAS.
 */
export function applyKnowledgeLifecycleTransition({
  repository,
  candidate,
  approvalPacket,
  appliedAt = new Date().toISOString(),
  onWriteStep,
} = {}) {
  const port = assertKnowledgeLifecycleRegistryPort(repository);
  const mutation = assertKnowledgeLifecycleTransitionCandidate(candidate);
  const approval = validateWardenWritebackApproval({
    approvalPacket,
    candidates: [{
      targetRef: mutation.targetRef,
      operation: mutation.operation,
      transitionId: mutation.transitionId,
      candidateDigest: mutation.candidateDigest,
      expectedSourceDigest: mutation.expectedSourceDigest,
      rollbackPlanDigest: mutation.rollbackPlanDigest,
    }],
  });
  if (!approval.ok) {
    return Object.freeze({
      status: approval.status,
      applied: false,
      idempotent: false,
      authorization: approval,
    });
  }
  if (approval.normalized.scope !== "knowledge_lifecycle_transition") {
    return Object.freeze({
      status: "invalid",
      applied: false,
      idempotent: false,
      authorization: {
        ...approval,
        ok: false,
        status: "invalid",
        errors: ["approval scope does not authorize a knowledge lifecycle transition"],
      },
    });
  }
  const snapshot = port.read();
  const actualSourceDigest = port.readSourceDigest(mutation.targetRef);
  const approvedSourceDigest = mutation.operation === "upgrade"
    ? mutation.proposedSourceDigest
    : mutation.expectedSourceDigest;
  if (actualSourceDigest !== approvedSourceDigest) {
    return Object.freeze({
      status: "source_drift",
      applied: false,
      idempotent: false,
      authorization: approval,
    });
  }
  const reduced = applyKnowledgeLifecycleTransitionToRegistry({
    registry: snapshot.registry,
    candidate: mutation,
    approvalDigest: approval.approvalDigest,
    appliedAt,
  });
  if (reduced.idempotent) {
    return Object.freeze({
      status: "idempotent",
      applied: false,
      idempotent: true,
      authorization: approval,
      registry: reduced.registry,
      revision: reduced.registry.revision,
      registryDigest: snapshot.digest,
    });
  }
  const persisted = port.compareAndSwap({
    expectedRevision: mutation.expectedRegistryRevision,
    expectedRegistryDigest: mutation.expectedRegistryDigest,
    transitionId: mutation.transitionId,
    candidateDigest: mutation.candidateDigest,
    nextRegistry: reduced.registry,
    onWriteStep,
  });
  return Object.freeze({
    status: persisted.idempotent ? "idempotent" : "applied",
    applied: persisted.applied,
    idempotent: persisted.idempotent,
    authorization: approval,
    registry: persisted.registry,
    revision: persisted.revision,
    registryDigest: persisted.digest,
  });
}
