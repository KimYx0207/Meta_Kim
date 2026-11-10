#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { assert, exists, readJson, repoPath } from "./governance-lib.mjs";

const contract = await readJson("config/contracts/dependency-absorption-contract.json");
const skills = await readJson("config/skills.json");
const registry = await readJson("config/capability-index/dependency-project-registry.json");
const providers = await readJson("config/capability-index/provider-registry.json");
const routeSource = await readFile(repoPath("scripts/run-capability-gap-orchestration.mjs"), "utf8");
const installerSource = await readFile(repoPath("scripts/install-global-skills-all-runtimes.mjs"), "utf8");

assert(contract.contractId === "meta-kim-dependency-absorption-contract", "contract id mismatch");
assert(contract.schemaVersion === 2 && contract.mode === "per_dependency_evidence_gated", "current disposition contract missing");
assert(contract.crossProjectEvidenceReuse === false, "cross-project evidence reuse must be blocked");
const historical = contract.historicalClosures?.find((item) => item.activeItem?.id === "planning-with-files");
assert(historical?.activeItem?.deletionAuthorized === true, "historical deletion authorization lost");
assert(historical?.activeItem?.state === "DEPENDENCY_REMOVED_CLOSED", "historical closure state lost");
assert(historical?.activeItem?.installedState === "removed", "historical removal state lost");
assert(historical?.closureReview?.decision === "REVIEW_PASS", "historical closure review lost");
assert(historical?.closureReview?.independentReviewCount >= 2, "historical review evidence lost");
assert(historical?.closureReview?.nextProjectActivationAuthorized === false, "historical review must not authorize current work");
assert(historical?.nextProjectActivationAllowed === false, "historical next-project boundary changed");

assert(
  !(skills.skills ?? []).some((skill) => skill.id === "planning-with-files"),
  "planning-with-files remains installable",
);

const queue = registry.absorptionQueuePolicy;
assert(queue?.mode === contract.mode, "registry disposition mode mismatch");
assert(queue?.reviewRef === "config/contracts/dependency-absorption-contract.json#currentReview", "registry must point to the existing contract");
assert(queue?.crossProjectEvidenceReuse === false, "registry must block evidence reuse");
assert(queue?.historicalPlanningClosure?.state === "DEPENDENCY_REMOVED_CLOSED", "registry historical closure lost");
const project = registry.projects?.find((entry) => entry.id === "planning-with-files");
assert(project?.source?.inspectionStatus === "absorbed_removed_historical_reference", "historical evidence state missing");
assert(project?.capabilityCard?.routeEligibility === "historical_evidence_only", "retired dependency entered execution route");
assert(project?.interface?.invokeAs === "historical_reference", "retired dependency became invokable");
assert(project?.interface?.requiredRuntime?.length === 0, "retired dependency still requires a runtime");
assert(project?.scoring?.overall === 0, "reference must not receive executable score");
assert(!routeSource.match(/runtimeSkillCandidates[^\n]*planning-with-files/u), "default worker route still carries planning-with-files");
assert(installerSource.includes("retirePlanningWithFiles"), "installer does not retire existing managed copies");
for (const id of ["external-skill-planning-with-files", "plugin-bundle-planning-with-files-hooks"]) {
  assert(!(providers.providers ?? []).some((provider) => provider.id === id), `${id} remains an active provider`);
}

const review = contract.currentReview;
assert(review?.authorizationScope && review.items?.length, "current per-item review missing");
const items = new Map(review.items.map((item) => [item.id, item]));
assert(items.size === review.items.length, "duplicate disposition records");
const pkg = await readJson("package.json");
for (const id of [...Object.keys(pkg.dependencies ?? {}), ...registry.projects.map((item) => item.id)]) {
  assert(items.has(id), `${id} has no individual disposition`);
}
for (const item of review.items) {
  assert(item.reason && item.dependencyKind && item.license, `${item.id} missing evidence-backed disposition`);
  assert(item.localEvidenceRefs?.length, `${item.id} missing local consumer evidence`);
  assert(item.liveExecutionClaim === false, `${item.id} disposition must not mint live proof`);
  for (const ref of item.localEvidenceRefs) assert(await exists(repoPath(ref.split("#")[0])), `${item.id} missing local source ${ref}`);
  if (item.decision.includes("optional") || item.decision === "retain_explicit_reference") {
    const skill = skills.skills.find((entry) => entry.id === item.id);
    if (skill) assert(skill.defaultSelected === false, `${item.id} must be explicitly selected`);
  }
}
for (const item of review.items.filter((entry) => entry.decision === "absorbed_install_retired")) {
  assert(!skills.skills.some((entry) => entry.id === item.id), `${item.id} remains installable`);
  assert(!providers.providers.some((entry) => entry.id === `external-skill-${item.id}`), `${item.id} retains an install provider`);
  assert(item.managedCopyRetirement?.policy === "exact_manifest_owned_unchanged_closure_only", `${item.id} lacks exact ownership retirement`);
  assert(item.managedCopyRetirement?.unknownOrEdited === "preserve" && item.managedCopyRetirement?.projectCopies === "preserve", `${item.id} must preserve independent content`);
  assert(item.managedCopyRetirement?.globalRemovalClaim === false, `${item.id} cannot claim every user's old copy removed`);
}
assert(installerSource.includes("retireAbsorbedDependencyCopies"), "installer missing owned-copy retirement");
for (const id of ["agent-desktop", "agent-browser"]) {
  const engine = registry.projects.find((entry) => entry.id === id);
  assert(engine.capabilityType && engine.interfaces?.length, `${id} must separate capability and interfaces`);
  assert(engine.interface.executableDiscovery.automaticExecution === false && engine.interface.executableDiscovery.automaticInstall === false, `${id} discovery must not run or install an engine`);
  assert(engine.supportEvidence.liveVerified === false, `${id} has no native live proof`);
}
console.log(`dependency absorption valid: historical planning-with-files closed; ${items.size} current dispositions; unknown user copies preserved`);
