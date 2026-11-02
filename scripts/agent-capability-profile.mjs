import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { executeSafeManagedFileTransaction, inspectTrustedPath, sha256ManagedFile } from "./safe-managed-file-operations.mjs";

const policy = JSON.parse(readFileSync(new URL("../config/contracts/workflow-contract.json", import.meta.url), "utf8"))
  .protocols.agentBlueprintPacket.projectCapabilityProfilePolicy;
const registeredProviders = JSON.parse(readFileSync(new URL("../config/capability-index/provider-registry.json", import.meta.url), "utf8")).providers ?? [];
const object = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const canonical = (value) => JSON.stringify(value, (_, item) => object(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const ownerIdentity = ({ contentDigest, ...binding }) => canonical(binding);
const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const normalizedDigest = (value) => String(value ?? "").replace(/^sha256:/u, "").toLowerCase();
const samePath = (a, b) => {
  const key = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return typeof a === "string" && typeof b === "string" && key(a) === key(b);
};
const failure = (code) => { throw new Error(`agent_profile_${code}`); };
const expandHome = (ref, homeRoot) => String(ref).startsWith("~/") ? path.join(homeRoot, String(ref).slice(2)) : ref;

/** Existing owner identity/source fields, never a runtime alias or a new Agent identity. */
export function agentProfileOwnerBinding(owner, { projectRoot } = {}) {
  // Verified dependency discovery publishes both paths relative to its explicit
  // consumer project (dependency-agent-discovery.mjs), not to the package root.
  const dependency = owner.source === "dependency_agent_contract";
  return {
    ownerAgent: owner.id ?? owner.ownerAgent,
    runtime: owner.runtime ?? ({ claudeCode: "claude_code", codexapp: "codex" }[owner.platformId] ?? owner.platformId ?? (dependency ? "shared" : null)),
    scope: owner.scope ?? (owner.source === "project_runtime_agent_inventory" ? "project" : owner.source === "dependency_agent_contract" ? "dependency" : "global"),
    source: owner.source,
    sourceRef: dependency && projectRoot ? path.resolve(projectRoot, owner.sourceRef) : owner.sourceRef,
    sourceRoot: dependency && projectRoot ? path.resolve(projectRoot, owner.sourceRoot) : owner.sourceRoot ?? null,
    contentDigest: `sha256:${normalizedDigest(owner.contentDigest)}`,
  };
}

/** Digest only the configuration, excluding its derived hash and approval reference. */
export function agentCapabilityProfileDigest(profile) {
  const { contentDigest, ...content } = profile;
  return digest(canonical(content));
}

function readReference(root, reference) {
  if (!object(reference) || typeof reference.ref !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(reference.contentDigest ?? "")) failure("reference_required");
  const rel = path.isAbsolute(reference.ref) ? path.relative(root, reference.ref) : reference.ref;
  const checked = inspectTrustedPath(root, rel);
  if (!checked || !lstatSync(checked.target).isFile()) failure("unsafe_reference");
  const bytes = readFileSync(checked.target);
  if (!bytes.length || digest(bytes) !== reference.contentDigest) failure("reference_digest_mismatch");
  return { sourceRef: reference.ref, contentDigest: reference.contentDigest, content: bytes.toString("utf8") };
}

function checkApprovals(projectRoot, refs, binding) {
  for (const reference of refs ?? []) {
    const source = readReference(projectRoot, reference);
    const record = JSON.parse(source.content);
    if (record.status === "approved" && Object.entries(binding).every(([key, value]) => canonical(record[key]) === canonical(value))) return source;
  }
  failure("content_bound_approval_required");
}

function inspectProfile(profile) {
  if (!object(profile) || policy.profileFields.some((key) => profile[key] == null) ||
      Object.keys(profile).some((key) => ![...policy.profileFields, ...policy.profileOptionalFields].includes(key)) ||
      typeof profile.capabilityProfileId !== "string" || !profile.capabilityProfileId.trim() ||
      typeof profile.capabilityProfileVersion !== "string" || !profile.capabilityProfileVersion.trim() ||
      typeof profile.referenceDirection !== "string" || !profile.referenceDirection.trim() ||
      !object(profile.owner) || policy.ownerBindingFields.some((key) => typeof profile.owner[key] !== "string" || !profile.owner[key].trim()) ||
      !/^sha256:[a-f0-9]{64}$/u.test(profile.owner.contentDigest) ||
      !Array.isArray(profile.projectEvidenceRefs) || !profile.projectEvidenceRefs.length ||
      !Array.isArray(profile.capabilityLoadout?.slots)) failure("invalid_profile");
  for (const entry of profile.capabilityLoadout.slots) {
    if (!object(entry) || policy.slotFields.some((key) => typeof entry[key] !== "string" || !entry[key].trim()) ||
        !policy.bindingTypes.includes(entry.bindingType) || !policy.selectionModes.includes(entry.mode) ||
        (entry.appliesTo != null && (!Array.isArray(entry.appliesTo) || entry.appliesTo.some((need) => typeof need !== "string")))) failure("invalid_slot");
  }
  if (profile.contentDigest && profile.contentDigest !== agentCapabilityProfileDigest(profile)) failure("profile_digest_mismatch");
}

function inspectDocument(document, projectRoot) {
  if (document?.schemaVersion !== policy.schemaVersion || !samePath(document.projectRoot, projectRoot) || !Array.isArray(document.profiles) ||
      Object.keys(document).some((key) => !["schemaVersion", "projectRoot", "profiles", "approvalRefs"].includes(key))) failure("invalid_schema_or_project_binding");
  const seen = new Set();
  const profileIds = new Set();
  for (const profile of document.profiles) {
    inspectProfile(profile);
    const key = ownerIdentity(profile.owner);
    if (seen.has(key) || profileIds.has(profile.capabilityProfileId)) failure("duplicate_owner_or_profile_id");
    seen.add(key);
    profileIds.add(profile.capabilityProfileId);
  }
}

/** Read private project configuration; absence never creates state or attests fit. */
export function readAgentCapabilityProfiles({ projectRoot }) {
  const root = path.resolve(projectRoot);
  const checked = inspectTrustedPath(root, policy.path, { allowMissing: true });
  if (!checked) failure("unsafe_configuration_path");
  if (!existsSync(checked.target)) return { status: "not_configured", projectRoot: root, path: checked.target, fileHash: null, document: null };
  const bytes = readFileSync(checked.target);
  const document = JSON.parse(bytes.toString("utf8"));
  inspectDocument(document, root);
  const { approvalRefs, ...content } = document;
  checkApprovals(root, approvalRefs, { scope: "project_capability_profile", projectRoot: root, candidateDigest: digest(canonical(content)) });
  return { status: "configured", projectRoot: root, path: checked.target, fileHash: normalizedDigest(digest(bytes)), document: structuredClone(document) };
}

/** Preview/apply uses the existing project transaction; no ordinary run calls apply. */
export function saveAgentCapabilityProfiles({ projectRoot, profiles, approvalRefs = [], expectedOldHash, apply = false, readOnly = false }) {
  const root = path.resolve(projectRoot);
  if (readOnly) return { status: "not_applied_read_only", projectRoot: root };
  const current = readAgentCapabilityProfiles({ projectRoot: root });
  if (expectedOldHash !== undefined && current.fileHash !== expectedOldHash) failure("old_hash_mismatch");
  const normalized = structuredClone(profiles).map((profile) => ({ ...profile, contentDigest: agentCapabilityProfileDigest(profile) }));
  const content = { schemaVersion: policy.schemaVersion, projectRoot: root, profiles: normalized };
  inspectDocument(content, root);
  for (const profile of normalized) {
    profile.projectEvidenceRefs.forEach((ref) => readReference(root, ref));
    (profile.materialRefs ?? []).forEach((ref) => readReference(root, ref));
    const sourceRoot = expandHome(profile.owner.sourceRoot, process.env.USERPROFILE ?? process.env.HOME ?? os.homedir());
    if (!path.isAbsolute(sourceRoot)) failure("owner_source_root_required");
    const sourceRef = expandHome(profile.owner.sourceRef, process.env.USERPROFILE ?? process.env.HOME ?? os.homedir());
    readReference(sourceRoot, { ref: sourceRef, contentDigest: profile.owner.contentDigest });
    if (profile.baseProfileRef) {
      if (!samePath(expandHome(profile.baseProfileRef.sourceRoot, process.env.USERPROFILE ?? process.env.HOME ?? os.homedir()), sourceRoot)) failure("base_source_root_mismatch");
      readReference(sourceRoot, profile.baseProfileRef);
    }
    const previous = current.document?.profiles.find((entry) => entry.capabilityProfileId === profile.capabilityProfileId);
    if (previous?.capabilityProfileVersion === profile.capabilityProfileVersion && agentCapabilityProfileDigest(previous) !== agentCapabilityProfileDigest(profile)) failure("same_version_content_changed");
  }
  const contentDigest = digest(canonical(content));
  const result = { status: "planned", projectRoot: root, contentDigest, expectedOldHash: current.fileHash };
  if (!apply) return result;
  if (expectedOldHash === undefined) failure("expected_old_hash_required");
  checkApprovals(root, approvalRefs, { scope: "project_capability_profile", projectRoot: root, candidateDigest: contentDigest, expectedOldHash });
  if (current.document && canonical({ ...current.document, approvalRefs: [] }) === canonical({ ...content, approvalRefs: [] })) return { ...result, status: "unchanged" };
  const transaction = executeSafeManagedFileTransaction({
    trustedRoot: root, backupRoot: path.join(root, ".meta-kim/backups/agent-capability-profiles"),
    transactionLabel: "agent-capability-profile", lockKey: "project-mutation-session",
    operations: [{ kind: "write", relPath: policy.path, expectedOldHash, phase: "content",
      content: `${JSON.stringify({ ...content, approvalRefs }, null, 2)}\n` }],
  });
  return { ...result, status: transaction.status, transaction };
}

function verifyOwnerSource(owner, binding, projectRoot, homeRoot) {
  if (canonical(binding) !== canonical(agentProfileOwnerBinding(owner, { projectRoot }))) failure("owner_binding_mismatch");
  const declaredRoot = expandHome(binding.sourceRoot, homeRoot);
  if (!path.isAbsolute(declaredRoot)) failure("owner_source_root_required");
  const ref = expandHome(binding.sourceRef, homeRoot);
  const target = path.isAbsolute(ref) ? ref : path.resolve(declaredRoot, ref);
  const source = readReference(declaredRoot, { ref: target, contentDigest: binding.contentDigest });
  if (binding.scope === "project" && !samePath(declaredRoot, projectRoot)) failure("owner_project_root_mismatch");
  return { source, sourceRoot: declaredRoot };
}

function fitForOwner({ context, binding, profile, projectRoot }) {
  const matches = (context.fitAssessments ?? []).filter((entry) => object(entry.owner) && ownerIdentity(entry.owner) === ownerIdentity(binding));
  if (!matches.length) return null;
  if (matches.length !== 1) failure("ambiguous_fit_assessment");
  const source = readReference(projectRoot, matches[0].assessmentRef);
  const assessment = JSON.parse(source.content);
  if (!samePath(assessment.projectRoot, projectRoot) || canonical(assessment.owner) !== canonical(binding) ||
      !policy.fitResolutions.includes(assessment.ownerResolution) || !assessment.rationale?.trim() ||
      !Array.isArray(assessment.evidenceRefs) || !assessment.evidenceRefs.length ||
      assessment.profileDigest !== (profile ? agentCapabilityProfileDigest(profile) : null) ||
      assessment.capabilityProfileId !== (profile?.capabilityProfileId ?? null) ||
      assessment.capabilityProfileVersion !== (profile?.capabilityProfileVersion ?? null)) failure("fit_binding_mismatch");
  assessment.evidenceRefs.forEach((ref) => readReference(projectRoot, ref));
  if (profile && canonical(assessment.evidenceRefs) !== canonical(profile.projectEvidenceRefs)) failure("fit_project_evidence_mismatch");
  checkApprovals(projectRoot, context.approvalRefs, { scope: "project_agent_fit", projectRoot, assessmentDigest: source.contentDigest });
  return { ...assessment, assessmentRef: matches[0].assessmentRef };
}

function eligibleProvider(candidate, types, { runtime, osTarget, providerEligible }) {
  const runtimeSupport = typeof candidate.runtimeSupport === "string" ? candidate.runtimeSupport
    : candidate.runtimeSupport?.[runtime]?.status ?? candidate.runtimeSupport?.[runtime];
  const declaredSupport = candidate.support?.runtimes?.[runtime] ?? candidate.support?.[runtime] ?? candidate.support?.default;
  if (!types.includes(candidate.type) || candidate.routeEligible === false || candidate.executionBlock === true ||
      candidate.executionEligible === false || ["blocked", "unsupported"].includes(runtimeSupport) ||
      ["blocked", "unsupported"].includes(declaredSupport?.status ?? declaredSupport?.state) ||
      candidate.osSupport?.[osTarget] === "unsupported" ||
      (candidate.runtime && ![runtime, "shared"].includes(candidate.runtime)) || !providerEligible(candidate)) return false;
  return !registeredProviders.filter((record) => record.id === candidate.id || record.mappings?.skillsJsonIds?.includes(candidate.id))
    .some((record) => { const support = record.support?.runtimes?.[runtime] ?? record.support?.default;
      return ["blocked", "unsupported"].includes(support?.status) || ["blocked", "unsupported"].includes(support?.state) || support?.os?.[osTarget] === "unsupported"; });
}

/** Resolve real sources into a run snapshot. This checks bindings, not professional judgment or permissions. */
export function resolveAgentCapabilityProfile({ projectRoot, owner, providers = [], context = {}, runtime, capabilityNeed = [],
  providerEligible = () => true, fallbackProviders = [], skillAuthoring = false, osTarget = null, homeRoot = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir() }) {
  const root = path.resolve(projectRoot);
  const binding = agentProfileOwnerBinding(owner, { projectRoot: root });
  let profile = null;
  const empty = { status: "not_configured", fitStatus: "not_evaluated", owner: binding, ownerResolution: null, selectedProviders: [], slots: [], materials: [], blockedReasons: [] };
  try {
    const stored = readAgentCapabilityProfiles({ projectRoot: root });
    profile = stored.document?.profiles.find((entry) => ownerIdentity(entry.owner) === ownerIdentity(binding)) ??
      stored.document?.profiles.find((entry) => ["ownerAgent", "runtime", "scope", "source"].every((key) => entry.owner[key] === binding[key])) ?? null;
    const selections = (context.profileSelections ?? []).filter((entry) => object(entry.owner) && ownerIdentity(entry.owner) === ownerIdentity(binding));
    if (selections.length > 1) failure("ambiguous_profile_selection");
    if (selections.length && (!profile || ["capabilityProfileId", "capabilityProfileVersion", "contentDigest"].some((key) => selections[0][key] !== (key === "contentDigest" ? agentCapabilityProfileDigest(profile) : profile[key])))) failure("profile_selection_mismatch");
    const fit = fitForOwner({ context, binding, profile, projectRoot: root });
    if (!profile && !fit) return empty;
    if (binding.runtime !== runtime && binding.runtime !== "shared") failure("owner_runtime_mismatch");
    const verifiedOwner = verifyOwnerSource(owner, profile?.owner ?? binding, root, homeRoot);
    if (!fit) failure("fit_assessment_required");
    if (fit.ownerResolution !== "reuse_existing_owner" || fit.hardConflicts?.length) return { ...empty, status: "capability_gap", fitStatus: "host_assessed_sources_current", ownerResolution: fit.ownerResolution,
      blockedReasons: fit.hardConflicts?.length ? fit.hardConflicts : ["Type B owner decision requires the deferred identity lane"], fitAssessment: fit };
    if (!profile) return { ...empty, status: "ready", fitStatus: "host_assessed_sources_current", ownerResolution: fit.ownerResolution, fitAssessment: fit };
    profile.projectEvidenceRefs.forEach((ref) => readReference(root, ref));
    let base = null;
    if (profile.baseProfileRef) {
      if (!samePath(expandHome(profile.baseProfileRef.sourceRoot, homeRoot), verifiedOwner.sourceRoot)) failure("base_source_root_mismatch");
      base = JSON.parse(readReference(verifiedOwner.sourceRoot, profile.baseProfileRef).content);
      inspectProfile({ ...profile, contentDigest: undefined, capabilityLoadout: base.capabilityLoadout });
    }
    const merged = new Map();
    const overrides = selections[0]?.capabilityLoadout?.slots ?? [];
    inspectProfile({ ...profile, contentDigest: undefined, capabilityLoadout: { slots: overrides } });
    if (overrides.length && fit.runLoadoutDigest !== digest(canonical(selections[0].capabilityLoadout))) failure("run_loadout_assessment_required");
    for (const entries of [base?.capabilityLoadout?.slots ?? [], profile.capabilityLoadout.slots, overrides]) {
      for (const entry of entries) {
        const key = entry.capabilitySlot;
        const previous = merged.get(key);
        // appliesTo is an OR predicate. Lower layers may broaden a required
        // predicate, but cannot hide an unconditional or existing condition.
        const narrowsRequired = entry.appliesTo?.length && (!previous?.appliesTo?.length ||
          previous.appliesTo.some((need) => !entry.appliesTo.includes(need)));
        if (previous?.mode === "required" && (previous.bindingType !== entry.bindingType ||
            previous.providerId !== entry.providerId || entry.mode !== "required" || narrowsRequired)) failure("required_slot_override");
        merged.set(key, structuredClone(entry));
      }
    }
    const selected = [];
    const slots = [];
    const rejected = [];
    for (const entry of merged.values()) {
      const triggered = entry.appliesTo?.length ? entry.appliesTo.some((need) => capabilityNeed.includes(need)) : entry.mode !== "optional";
      if (!triggered) continue;
      const type = { skill: ["skills", "skill"], mcp_tool: ["mcpServers", "mcpTools", "mcp_tool"], command: ["commands", "command"], runtime_tool: ["runtimeTools", "runtime_tool"] }[entry.bindingType];
      const eligible = (candidate) => eligibleProvider(candidate, type, { runtime, osTarget, providerEligible });
      let provider = providers.find((candidate) => candidate.id === entry.providerId && eligible(candidate));
      if (!provider) {
        rejected.push({ providerId: entry.providerId, reason: "profile provider unavailable or ineligible" });
        if (entry.mode === "required") failure("selected_provider_ineligible");
        provider = entry.mode === "default" ? fallbackProviders.find((candidate) => fit.fallbackProviderIds?.includes(candidate.id) && eligible(candidate)) : null;
        if (!provider && entry.mode === "default") failure("selected_provider_ineligible");
        if (!provider) continue;
      }
      if (entry.capabilitySlot === "skill-agent-tool-creation" && provider.id !== "meta-skill-creator") failure("meta_skill_creator_required");
      selected.push(structuredClone(provider)); slots.push({ ...entry, provider: structuredClone(provider) });
    }
    if (skillAuthoring && !selected.some((provider) => provider.type === "skills" && provider.id === "meta-skill-creator")) {
      const creator = providers.find((candidate) => candidate.id === "meta-skill-creator" && eligibleProvider(candidate, ["skills"], { runtime, osTarget, providerEligible }));
      if (!creator) failure("meta_skill_creator_required");
      selected.push(structuredClone(creator));
      slots.push({ capabilitySlot: "skill-agent-tool-creation", bindingType: "skill", providerId: creator.id, mode: "required", provider: structuredClone(creator) });
    }
    const materials = [
      ...(base?.materialRefs ?? []).map((ref) => readReference(verifiedOwner.sourceRoot, ref)),
      ...(profile.materialRefs ?? []).map((ref) => readReference(root, ref)),
    ];
    return { ...empty, status: "ready", fitStatus: "host_assessed_sources_current", ownerResolution: fit.ownerResolution,
      capabilityProfileId: profile.capabilityProfileId, capabilityProfileVersion: profile.capabilityProfileVersion,
      contentDigest: agentCapabilityProfileDigest(profile), configurationDigest: `sha256:${stored.fileHash}`,
      referenceDirection: profile.referenceDirection, projectEvidenceRefs: structuredClone(profile.projectEvidenceRefs),
      selectedProviders: selected, slots, materials, rejected, fitAssessment: fit,
      evidenceTier: "source_bound_artifact_not_native_or_semantic_fit_proof" };
  } catch (error) {
    return { ...empty, status: "capability_gap", blockedReasons: [error.message],
      ...(profile ? { capabilityProfileId: profile.capabilityProfileId, capabilityProfileVersion: profile.capabilityProfileVersion } : {}) };
  }
}
