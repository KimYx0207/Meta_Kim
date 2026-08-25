import { createHash } from "node:crypto";
import {
  evaluateGovernanceRequirements,
  validateGovernanceTaskFacts,
} from "../../src/domain/governance/governance-requirements.mjs";

const SHADOW_SCHEMA_VERSION = "governance-requirements-shadow-v1";

const LEGACY_AUTHORITY_REFS = Object.freeze([
  "sourceArtifacts.orchestrationReport.selectedExecutionRoute.entryChoiceDecision",
  "sourceArtifacts.orchestrationReport.selectedExecutionRoute.routeExecutionGate",
  "coreLoop.preDecisionOptionFrame",
]);

const SHADOW_AUTHORITY = Object.freeze({
  gatesExecution: false,
  changesArtifactStatus: false,
  changesCoreLoop: false,
  changesRouteGate: false,
  changesChoiceDecision: false,
  changesPreDecision: false,
  triggersNativeChoice: false,
  writesState: false,
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function factsFingerprint(facts) {
  return `sha256:${createHash("sha256").update(canonicalJson(facts)).digest("hex")}`;
}

function shadowRecord({ evaluationStatus, facts = null, evaluation = null }) {
  return Object.freeze({
    schemaVersion: SHADOW_SCHEMA_VERSION,
    mode: "shadow_only",
    evaluationStatus,
    facts: Object.freeze({
      schemaVersion: facts?.schemaVersion ?? null,
      fingerprint: facts ? factsFingerprint(facts) : null,
    }),
    evaluation,
    authority: SHADOW_AUTHORITY,
    legacyAuthorityRefs: LEGACY_AUTHORITY_REFS,
  });
}

/**
 * Isolates the pure Governance Requirements evaluator from the legacy runner.
 * This adapter never derives facts from raw task text, modifies a legacy gate,
 * or retains rejected input/error values in persisted artifacts.
 */
export function buildGovernanceRequirementsShadow({ governanceTaskFacts = null, legacyGate = null } = {}) {
  if (governanceTaskFacts == null) {
    return shadowRecord({
      evaluationStatus: "not_evaluated_missing_normalized_facts",
    });
  }

  try {
    const facts = validateGovernanceTaskFacts(governanceTaskFacts);
    return shadowRecord({
      evaluationStatus: "evaluated",
      facts,
      evaluation: evaluateGovernanceRequirements(facts, { legacyGate }),
    });
  } catch {
    return shadowRecord({
      evaluationStatus: "not_evaluated_invalid_normalized_facts",
    });
  }
}
