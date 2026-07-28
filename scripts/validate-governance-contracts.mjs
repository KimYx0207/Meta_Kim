#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { GOVERNANCE_ACTIONS, GOVERNANCE_OWNERS, assert, exists, readJson, repoPath } from "./governance-lib.mjs";

const triggerMap = await readJson("config/governance/trigger-action-map.json");
const weapons = await readJson("config/capability-index/weapon-registry.json");
const dependencies = await readJson("config/capability-index/dependency-project-registry.json");
const runtimeMatrix = await readJson("config/runtime-capability-matrix.json");
const osMatrix = await readJson("config/os-compatibility-matrix.json");
const coreLoop = await readJson("config/contracts/core-loop-contract.json");
const lensCatalog = await readJson("config/governance/lens-seed-catalog.json");
const lensPolicy = await readJson("config/governance/lens-discovery-policy.json");
const choicePolicy = await readJson("config/governance/choice-surface-policy.json");
const decisionPatterns = await readJson("config/governance/decision-pattern-catalog.json");
const pkg = await readJson("package.json");

const expectedCoreStages = [
  "Critical",
  "Fetch",
  "Thinking",
  "Execution",
  "Review",
  "Meta-Review",
  "Verification",
  "Evolution",
];

assert(coreLoop.contractId === "meta-kim-core-loop-contract", "core loop contract id mismatch");
assert(
  coreLoop.defaultEntry?.entryScript === "scripts/run-meta-theory-governed-execution.mjs" &&
    coreLoop.defaultEntry?.packageScript === "meta:theory:run" &&
    pkg.scripts?.["meta:theory:run"] === "node scripts/run-meta-theory-governed-execution.mjs --emit-conversation-notice",
  "core loop contract default entry must point to the real meta:theory:run script",
);
assert(
  (coreLoop.stages ?? []).map((stage) => stage.stage).join("|") ===
    expectedCoreStages.join("|"),
  "core loop contract must preserve the eight-stage order",
);
for (const stage of coreLoop.stages ?? []) {
  for (const field of [
    "requiredInputs",
    "requiredOutputs",
    "skipConditions",
    "gateConditions",
    "blockingGates",
    "warningGates",
    "defaultOwner",
  ]) {
    assert(stage[field] !== undefined, `core loop stage ${stage.stage} missing ${field}`);
  }
}
for (const source of [
  "canonical/agents",
  "runtime agent mirrors",
  "tools, scripts, and package commands",
  "MCP servers and config",
  "hooks",
  "Graphify/project map",
  "global capability inventory",
]) {
  assert(
    coreLoop.capabilityDiscovery?.minimumSources?.includes(source),
    `core loop capability discovery missing ${source}`,
  );
}
assert(
  coreLoop.verificationPolicy?.notEveryStepInterceptor === true &&
    coreLoop.verificationPolicy?.hooksAreLastResortFuse === true,
  "core loop verification policy must keep verification as fuse, not every-step interception",
);
assert(
  coreLoop.publicReadyClaim?.requiresVerificationEvidence === true,
  "core loop public-ready claim must require verification evidence",
);

const actionMap = new Map((triggerMap.actions ?? []).map((action) => [action.id, action]));
for (const id of GOVERNANCE_ACTIONS) {
  const action = actionMap.get(id);
  assert(action, `trigger-action-map missing ${id}`);
  for (const field of ["triggerCondition", "executionAction", "governanceOwner", "requiredWeapons", "outputPacket", "resultArtifact", "correctIf", "wrongIf", "doneIf"]) {
    assert(action[field] !== undefined, `${id} missing ${field}`);
  }
  assert(GOVERNANCE_OWNERS.includes(action.governanceOwner), `${id} has unknown governanceOwner`);
}

for (const weapon of weapons.weapons ?? []) {
  for (const field of ["runtimeSupport", "osSupport", "howToTrigger", "risk", "verification"]) {
    assert(weapon[field], `${weapon.id} missing ${field}`);
  }
  assert(weapon.ownerCandidates?.length, `${weapon.id} has no owner candidates`);
}

for (const project of dependencies.projects ?? []) {
  if (project.id === "kim-decision") {
    assert(project.capabilityCard?.routeEligibility === "reference_only", "Kim_Decision dependency registry entry must remain reference_only");
    assert(project.interface?.invokeAs === "reference" || project.interface?.invokeAs === "notInvokable", "Kim_Decision must not be an invokable dependency");
  }
  assert(project.capabilityCard, `${project.id} missing capabilityCard`);
  assert(project.interface, `${project.id} missing interface`);
  assert(project.capabilityCard.inputContract && project.capabilityCard.outputContract, `${project.id} missing IO contract`);
}
assert(decisionPatterns.sourceBoundary?.notInvokable === true, "decision pattern catalog must mark reference source as not invokable");
assert(decisionPatterns.stagePatterns?.some((pattern) => pattern.stage === "critical"), "decision patterns must include Critical data");
assert(decisionPatterns.stagePatterns?.some((pattern) => pattern.stage === "fetch"), "decision patterns must include Fetch data");
assert(decisionPatterns.stagePatterns?.some((pattern) => pattern.stage === "thinking"), "decision patterns must include Thinking data");
assert(decisionPatterns.stagePatterns?.some((pattern) => pattern.stage === "review"), "decision patterns must include Review data");

export function assertRuntimeMatrixGovernanceShape(matrix) {
  const modeFields = [
    "hostSupport",
    "hostConfidence",
    "metaKimIntegration",
    "acceptanceRequirement",
    "acceptanceState",
    "routeEligibility",
  ];
  for (const platform of matrix.platforms ?? []) {
    const records = [...(platform.capabilities ?? [])];
    for (const record of records) {
      const context = `${platform.platform}.${record.capability}`;
      assert(
        record.support &&
          record.confidence &&
          record.trigger &&
          Array.isArray(record.evidenceRefs) &&
          record.evidenceRefs.length > 0 &&
          record.claimsByMode &&
          Object.keys(record.claimsByMode).length > 0,
        `${context} missing support/confidence/trigger/evidenceRefs/claimsByMode`,
      );
      assert(
        !(record.support === "native" && record.confidence === "unverified"),
        `${context} native cannot be unverified`,
      );
      for (const mode of record.runtimeModes ?? []) {
        const claim = record.claimsByMode[mode];
        assert(claim, `${context}.${mode} missing mode claim`);
        for (const field of modeFields) {
          assert(claim[field] !== undefined, `${context}.${mode} missing ${field}`);
        }
        assert(
          Array.isArray(claim.evidenceRefs) && claim.evidenceRefs.length > 0,
          `${context}.${mode} missing evidenceRefs`,
        );
      }
    }
  }
}
assertRuntimeMatrixGovernanceShape(runtimeMatrix);
assert(osMatrix.operatingSystems?.some((entry) => entry.id === "macos"), "OS matrix missing macOS");
assert(osMatrix.operatingSystems?.some((entry) => entry.id === "windows"), "OS matrix missing Windows");
assert(osMatrix.operatingSystems?.some((entry) => entry.id === "linux"), "OS matrix missing Linux");
assert(osMatrix.operatingSystems?.some((entry) => entry.id === "wsl2"), "OS matrix missing WSL2");

assert((lensCatalog.seeds ?? []).length >= 30, "Lens seed catalog must include >= 30 seeds");
assert(lensCatalog.seedOnlyDefault === true, "Lens seeds must not be default-enabled");
for (const seed of lensCatalog.seeds) {
  for (const field of ["useWhen", "notFor", "outputImpact"]) assert(seed[field], `${seed.id} missing ${field}`);
}
assert(lensPolicy.selectedLensMax <= 7, "Lens policy must select no more than 7 lenses");
assert(choicePolicy.fallback === "chat_decision_card", "Choice fallback must be chat decision card");

const forbiddenOwners = triggerMap.fakeOwnerRejectionPolicy?.forbiddenOwnerValues ?? [];
for (const forbidden of ["general-purpose", "temporary_owner"]) {
  assert(forbiddenOwners.includes(forbidden), `fake owner policy must forbid ${forbidden}`);
}

const scriptRefs = Object.entries(pkg.scripts ?? {})
  .flatMap(([name, script]) => [...String(script).matchAll(/node\s+([^\s&|]+)/g)].map((match) => [name, match[1].replace(/^"|"$/g, "")]));
for (const [name, scriptPath] of scriptRefs) {
  if (scriptPath.startsWith("-")) continue;
  assert(await exists(repoPath(scriptPath)), `package script ${name} references missing script ${scriptPath}`);
}

console.log("governance contracts valid");
