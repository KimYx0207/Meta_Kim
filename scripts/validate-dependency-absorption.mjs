#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { assert, readJson, repoPath } from "./governance-lib.mjs";

const contract = await readJson("config/contracts/dependency-absorption-contract.json");
const skills = await readJson("config/skills.json");
const registry = await readJson("config/capability-index/dependency-project-registry.json");
const providers = await readJson("config/capability-index/provider-registry.json");
const routeSource = await readFile(repoPath("scripts/run-capability-gap-orchestration.mjs"), "utf8");
const installerSource = await readFile(repoPath("scripts/install-global-skills-all-runtimes.mjs"), "utf8");

assert(contract.contractId === "meta-kim-dependency-absorption-contract", "contract id mismatch");
assert(contract.mode === "single_project_sequential", "absorption must be sequential");
assert(contract.maxActiveResearch === 1, "only one dependency may be active");
assert(contract.crossProjectEvidenceReuse === false, "cross-project evidence reuse must be blocked");
assert(contract.nextProjectActivationAllowed === false, "next dependency must remain blocked");
assert(contract.activeItem?.id === "planning-with-files", "planning-with-files closed item record mismatch");
assert(contract.activeItem?.deletionAuthorized === true, "single dependency deletion authorization missing");
assert(contract.activeItem?.state === "DEPENDENCY_REMOVED_CLOSED", "closed removal state mismatch");
assert(contract.activeItem?.installedState === "removed", "dependency remains installed by contract");
assert(contract.closureReview?.decision === "REVIEW_PASS", "closure review did not pass");
assert(contract.closureReview?.independentReviewCount >= 2, "independent closure review evidence is incomplete");
assert(contract.closureReview?.nextProjectActivationAuthorized === false, "closure review activated the next dependency");

assert(
  !(skills.skills ?? []).some((skill) => skill.id === "planning-with-files"),
  "planning-with-files remains installable",
);

const queue = registry.absorptionQueuePolicy;
assert(queue?.maxActiveResearch === 1, "registry queue must be single-item");
assert(queue?.activeProjectId === null, "registry must have no active dependency after closure");
assert(queue?.state === "DEPENDENCY_REMOVED_CLOSED", "registry closed state mismatch");
assert(queue?.crossProjectEvidenceReuse === false, "registry must block evidence reuse");
assert(queue?.nextProjectActivationAllowed === false, "registry must block next item");
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

console.log("dependency absorption valid: planning-with-files closed; next dependency blocked");
