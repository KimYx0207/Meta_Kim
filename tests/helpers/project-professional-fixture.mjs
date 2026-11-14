import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { agentCapabilityProfileDigest, agentProfileOwnerBinding, saveAgentCapabilityProfiles } from "../../scripts/agent-capability-profile.mjs";

const digest = value => "sha256:" + createHash("sha256").update(value).digest("hex");
const write = (root, ref, value) => {
  const file = path.join(root, ref); mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return { ref, contentDigest: digest(readFileSync(file)) };
};

/** Explicit test-host authored project source and reviewed fit fixtures.
 * This tests consumption/persistence, not real model authorship or approval. */
export function createProjectProfessionalFixture(projectRoot, { id = "package-maintainer", instructions = "Maintain this repository package metadata. Preserve dependency versions and the package release boundary; report source evidence for every correction.",
  description = "Project package maintenance specialist",
  rulesText = "Project boundary: package metadata corrections keep the documented release version and dependency pins; publishing stays with the release owner.",
  fitRationale = "Disposable test-host judgment: this project source owns the package boundary and consumes the recorded project rule." } = {}) {
  write(projectRoot, `.codex/agents/${id}.toml`, `name = ${JSON.stringify(id)}\ndescription = ${JSON.stringify(description)}\ndeveloper_instructions = ${JSON.stringify(instructions)}\n`);
  const rules = write(projectRoot, `project-methods/${id}.md`, rulesText);
  return { id, rules, instructions, fitRationale };
}

export function persistProjectProfessionalFixture(projectRoot, owner, fixture) {
  const binding = agentProfileOwnerBinding(owner, { projectRoot });
  const profile = { capabilityProfileId: fixture.id + "-profile", capabilityProfileVersion: "1", owner: binding,
    projectEvidenceRefs: [fixture.rules], materialRefs: [fixture.rules], referenceDirection: fixture.instructions,
    capabilityLoadout: { slots: [] } };
  const assessmentRef = write(projectRoot, `project-methods/${fixture.id}-fit.json`, { projectRoot, owner: binding,
    capabilityProfileId: profile.capabilityProfileId, capabilityProfileVersion: profile.capabilityProfileVersion,
    profileDigest: agentCapabilityProfileDigest(profile), ownerResolution: "reuse_existing_owner", evidenceRefs: [fixture.rules],
    rationale: fixture.fitRationale ?? "Disposable test-host judgment: this project source owns the package boundary and consumes the recorded project rule.",
    hardConflicts: [], evidenceClass: "fixture_binding_not_native_or_professional_acceptance" });
  const fitApproval = write(projectRoot, `project-methods/${fixture.id}-fit-review.json`, { scope: "project_agent_fit", status: "approved", projectRoot,
    assessmentDigest: assessmentRef.contentDigest, evidenceClass: "fixture_binding_only" });
  const fitAssessments = [{ owner: binding, assessmentRef }];
  const preview = saveAgentCapabilityProfiles({ projectRoot, profiles: [profile], fitAssessments, expectedOldHash: null });
  const approval = write(projectRoot, `project-methods/${fixture.id}-profile-review.json`, { scope: "project_capability_profile", status: "approved", projectRoot,
    candidateDigest: preview.contentDigest, expectedOldHash: null, evidenceClass: "fixture_binding_only" });
  return saveAgentCapabilityProfiles({ projectRoot, profiles: [profile], fitAssessments, expectedOldHash: null, approvalRefs: [approval, fitApproval], apply: true });
}
