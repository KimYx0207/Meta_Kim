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
  const slots = new Set();
  for (const entry of profile.capabilityLoadout.slots) {
    if (!object(entry) || policy.slotFields.some((key) => typeof entry[key] !== "string" || !entry[key].trim()) ||
        !policy.bindingTypes.includes(entry.bindingType) || !policy.selectionModes.includes(entry.mode) ||
        (entry.appliesTo != null && (!Array.isArray(entry.appliesTo) || entry.appliesTo.some((need) => typeof need !== "string")))) failure("invalid_slot");
    if (slots.has(entry.capabilitySlot)) failure("duplicate_capability_slot");
    slots.add(entry.capabilitySlot);
  }
  if (profile.contentDigest && profile.contentDigest !== agentCapabilityProfileDigest(profile)) failure("profile_digest_mismatch");
}

function inspectDocument(document, projectRoot) {
  if (document?.schemaVersion !== policy.schemaVersion || !samePath(document.projectRoot, projectRoot) || !Array.isArray(document.profiles) ||
      Object.keys(document).some((key) => !["schemaVersion", "projectRoot", "profiles", "fitAssessments", "approvalRefs"].includes(key)) ||
      (document.fitAssessments !== undefined && !Array.isArray(document.fitAssessments))) failure("invalid_schema_or_project_binding");
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
  const approval = checkApprovals(root, approvalRefs, { scope: "project_capability_profile", projectRoot: root, candidateDigest: digest(canonical(content)) });
  return { status: "configured", projectRoot: root, path: checked.target, fileHash: normalizedDigest(digest(bytes)), document: structuredClone(document),
    approvalRef: { ref: approval.sourceRef, contentDigest: approval.contentDigest } };
}

/** Preview/apply uses the existing project transaction; no ordinary run calls apply. */
export function saveAgentCapabilityProfiles({ projectRoot, profiles, fitAssessments, approvalRefs = [], expectedOldHash, apply = false, readOnly = false }) {
  const root = path.resolve(projectRoot);
  if (readOnly) return { status: "not_applied_read_only", projectRoot: root };
  const current = readAgentCapabilityProfiles({ projectRoot: root });
  if (expectedOldHash !== undefined && current.fileHash !== expectedOldHash) failure("old_hash_mismatch");
  const normalized = structuredClone(profiles).map((profile) => ({ ...profile, contentDigest: agentCapabilityProfileDigest(profile) }));
  const persistedFits = fitAssessments ?? current.document?.fitAssessments;
  const content = { schemaVersion: policy.schemaVersion, projectRoot: root, profiles: normalized,
    ...(persistedFits !== undefined ? { fitAssessments: structuredClone(persistedFits) } : {}) };
  inspectDocument(content, root);
  for (const profile of normalized) {
    profile.projectEvidenceRefs.forEach((ref) => readReference(root, ref));
    (profile.materialRefs ?? []).forEach((ref) => readReference(root, ref));
    const sourceRoot = expandHome(profile.owner.sourceRoot, process.env.USERPROFILE ?? process.env.HOME ?? os.homedir());
    if (!path.isAbsolute(sourceRoot)) failure("owner_source_root_required");
    const sourceRef = expandHome(profile.owner.sourceRef, process.env.USERPROFILE ?? process.env.HOME ?? os.homedir());
    readReference(sourceRoot, { ref: sourceRef, contentDigest: profile.owner.contentDigest });
    if (profile.baseProfileRef) {
      readBaseProfile(profile.baseProfileRef, sourceRoot, root, process.env.USERPROFILE ?? process.env.HOME ?? os.homedir());
    }
    const previous = current.document?.profiles.find((entry) => entry.capabilityProfileId === profile.capabilityProfileId);
    if (previous?.capabilityProfileVersion === profile.capabilityProfileVersion && agentCapabilityProfileDigest(previous) !== agentCapabilityProfileDigest(profile)) failure("same_version_content_changed");
  }
  const contentDigest = digest(canonical(content));
  const result = { status: "planned", projectRoot: root, contentDigest, expectedOldHash: current.fileHash };
  if (!apply) return result;
  if (expectedOldHash === undefined) failure("expected_old_hash_required");
  checkApprovals(root, approvalRefs, { scope: "project_capability_profile", projectRoot: root, candidateDigest: contentDigest, expectedOldHash });
  for (const entry of content.fitAssessments ?? []) {
    const profile = normalized.find(candidate => ownerIdentity(candidate.owner) === ownerIdentity(entry.owner));
    fitForOwner({ context: { fitAssessments: content.fitAssessments, approvalRefs }, binding: entry.owner, profile, projectRoot: root });
  }
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

function readBaseProfile(reference, ownerRoot, projectRoot, homeRoot) {
  const baseRoot = expandHome(reference.sourceRoot, homeRoot);
  if (!path.isAbsolute(baseRoot)) failure("base_source_root_required");
  if (!samePath(baseRoot, ownerRoot)) {
    const binding = reference.sourceOwner;
    if (!object(binding) || !reference.sourceVersion?.trim() || !samePath(expandHome(binding.sourceRoot, homeRoot), baseRoot)) failure("base_source_root_mismatch");
    verifyOwnerSource({ ...binding, id: binding.ownerAgent }, binding, projectRoot, homeRoot);
  }
  return JSON.parse(readReference(baseRoot, reference).content);
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
  const approval = checkApprovals(projectRoot, context.approvalRefs, { scope: "project_agent_fit", projectRoot, assessmentDigest: source.contentDigest });
  return { ...assessment, assessmentRef: matches[0].assessmentRef,
    approvalRef: { ref: approval.sourceRef, contentDigest: approval.contentDigest } };
}

function profileSourceReadBindings({ root, binding, profile, stored, fit, base, homeRoot }) {
  const refs = [];
  const add = (sourceRoot, reference) => {
    if (!reference) return;
    sourceRoot = expandHome(sourceRoot, homeRoot);
    const ref = expandHome(reference.ref, homeRoot);
    const observed = readReference(sourceRoot, { ref, contentDigest: reference.contentDigest });
    refs.push({ sourceRoot, ref, contentDigest: observed.contentDigest });
  };
  add(binding.sourceRoot, { ref: binding.sourceRef, contentDigest: binding.contentDigest });
  add(root, fit.assessmentRef); add(root, fit.approvalRef);
  for (const reference of fit.evidenceRefs) add(root, reference);
  if (stored.fileHash) add(root, { ref: policy.path, contentDigest: `sha256:${stored.fileHash}` });
  add(root, stored.approvalRef);
  for (const reference of [...(profile?.projectEvidenceRefs ?? []), ...(profile?.materialRefs ?? [])]) add(root, reference);
  if (profile?.baseProfileRef) {
    const source = profile.baseProfileRef;
    add(source.sourceRoot, source);
    if (source.sourceOwner) add(source.sourceOwner.sourceRoot, { ref: source.sourceOwner.sourceRef, contentDigest: source.sourceOwner.contentDigest });
    for (const reference of base?.materialRefs ?? []) add(source.sourceRoot, reference);
  }
  return [...new Map(refs.map(ref => [canonical(ref), ref])).values()];
}

/** Reopen every source that qualified this exact run; a coherent stale snapshot
 * alone cannot authorize handing revoked project rules to a worker. */
export function verifyAgentCapabilityProfileSnapshot(profile) {
  if (profile?.status !== "ready") return;
  if (!Array.isArray(profile.sourceReadBindings) || !profile.sourceReadBindings.length) failure("profile_source_bindings_required");
  for (const reference of profile.sourceReadBindings) readReference(reference.sourceRoot, reference);
  for (const material of profile.materials ?? []) {
    const reference = profile.sourceReadBindings.find(ref => ref.ref === material.sourceRef && ref.contentDigest === material.contentDigest &&
      (!material.sourceRoot || samePath(ref.sourceRoot, material.sourceRoot)));
    if (!reference || digest(material.content ?? "") !== material.contentDigest) failure("profile_material_snapshot_changed");
  }
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
    // Reuse the same reviewed project source across sessions. An explicit
    // current assessment replaces its saved counterpart, never its approval.
    const explicitFits = context.fitAssessments ?? [];
    context = { ...context, fitAssessments: [...(stored.document?.fitAssessments ?? []).filter(saved =>
      !explicitFits.some(entry => object(entry.owner) && ownerIdentity(entry.owner) === ownerIdentity(saved.owner))), ...explicitFits],
      approvalRefs: [...(stored.document?.approvalRefs ?? []), ...(context.approvalRefs ?? [])] };
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
      blockedReasons: fit.hardConflicts?.length ? fit.hardConflicts : ["Project identity adaptation requires reviewed source, rediscovery and current fit"], fitAssessment: fit };
    if (!profile) return { ...empty, status: "ready", fitStatus: "host_assessed_sources_current", ownerResolution: fit.ownerResolution, fitAssessment: fit,
      sourceReadBindings: profileSourceReadBindings({ root, binding, profile, stored, fit, homeRoot }) };
    profile.projectEvidenceRefs.forEach((ref) => readReference(root, ref));
    let base = null;
    if (profile.baseProfileRef) {
      base = readBaseProfile(profile.baseProfileRef, verifiedOwner.sourceRoot, root, homeRoot);
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
      ...(base?.materialRefs ?? []).map((ref) => ({ ...readReference(expandHome(profile.baseProfileRef.sourceRoot, homeRoot), ref), sourceRoot: expandHome(profile.baseProfileRef.sourceRoot, homeRoot) })),
      ...(profile.materialRefs ?? []).map((ref) => ({ ...readReference(root, ref), sourceRoot: root })),
    ];
    return { ...empty, status: "ready", fitStatus: "host_assessed_sources_current", ownerResolution: fit.ownerResolution,
      capabilityProfileId: profile.capabilityProfileId, capabilityProfileVersion: profile.capabilityProfileVersion,
      contentDigest: agentCapabilityProfileDigest(profile), configurationDigest: `sha256:${stored.fileHash}`,
      referenceDirection: profile.referenceDirection, projectEvidenceRefs: structuredClone(profile.projectEvidenceRefs),
      selectedProviders: selected, slots, materials, rejected, fitAssessment: fit,
      sourceReadBindings: profileSourceReadBindings({ root, binding, profile, stored, fit, base, homeRoot }),
      evidenceTier: "source_bound_artifact_not_native_or_semantic_fit_proof" };
  } catch (error) {
    return { ...empty, status: "capability_gap", blockedReasons: [error.message],
      ...(profile ? { capabilityProfileId: profile.capabilityProfileId, capabilityProfileVersion: profile.capabilityProfileVersion } : {}) };
  }
}

/** Qualify the already selected owner for this project's actual deliverable.
 * This consumes host judgment and existing source bindings; it neither invents
 * a professional identity nor writes a package or grants execution permission. */
export function assessProjectCapabilityBinding({ projectRoot, owner, workOrder, profile, providers = [] }) {
  const intent = workOrder.projectCapabilityIntent ?? { mode: workOrder.effectClass === "read_only_support" ? "preparation" : "project_owned" };
  const result = { mode: intent.mode, completion: false, evidenceTier: "source_bound_not_semantic_or_native_proof" };
  const gap = (status, reason, action) => ({ ...result, status, blockedReasons: [reason], nextAction: {
    stage: "Thinking", action, ownerSource: owner ? agentProfileOwnerBinding(owner, { projectRoot }) : null,
    requiredOutput: "A project-owned professional source with domain rules and acceptance, reviewed through the existing creationArtifact lifecycle; rediscover and assess its current bytes before delivery.",
  } });
  const readOnly = ["read_only_worker", "read_only_support"].includes(workOrder.effectClass);
  if (!["project_owned", "preparation", "shared_foundation"].includes(intent.mode)) return gap("capability_gap", "unknown_project_capability_intent", "assess_project_delivery_scope");
  if (intent.mode !== "project_owned") {
    if (!readOnly) return gap("capability_gap", "project_delivery_cannot_use_shared_or_preparation_owner", "prepare_project_capability_from_discovered_source");
    const implicitSupport = workOrder.effectClass === "read_only_support" && !workOrder.projectCapabilityIntent;
    if (!implicitSupport && (!intent.rationale?.trim() || !Array.isArray(intent.evidenceRefs) || !intent.evidenceRefs.length)) {
      return gap("capability_gap", "project_preparation_scope_evidence_required", "assess_project_delivery_scope");
    }
    if (intent.mode === "shared_foundation" && (workOrder.effectClass !== "read_only_support" ||
        !["meta-warden", "meta-conductor", "meta-scout", "meta-genesis", "meta-artisan", "meta-sentinel", "meta-librarian", "meta-prism", "meta-chrysalis"].includes(owner?.id))) {
      return gap("capability_gap", "shared_foundation_cannot_replace_project_professional_owner", "prepare_project_capability_from_discovered_source");
    }
    if (intent.mode === "preparation" && !implicitSupport && !["diagnostic", "decision_probe", "capability_preparation"].includes(intent.purpose)) {
      return gap("capability_gap", "bounded_project_preparation_purpose_required", "assess_project_delivery_scope");
    }
    return { ...result, status: "preparation_only", blockedReasons: [],
      claimBoundary: "Bounded discovery/diagnosis or capability preparation; this does not fulfill an independent project capability deliverable." };
  }
  const root = path.resolve(projectRoot);
  const requiredAgents = (workOrder.projectCapabilityRequirements ?? []).filter(requirement => !requirement.capabilityType || requirement.capabilityType === "agent");
  if (requiredAgents.length > 1) return gap("project_capability_required", "task_project_roles_require_explicit_assignment", "assign_project_roles_to_bounded_work_orders");
  if (requiredAgents.length === 1 && (owner?.id ?? owner?.ownerAgent) !== requiredAgents[0].role) {
    return gap("project_capability_required", "required_project_role_unavailable:" + requiredAgents[0].role, "prepare_or_select_required_project_role");
  }
  const local = owner && (owner.source === "project_runtime_agent_inventory" || owner.scope === "project");
  if (!local) return gap("project_capability_required", "project_owned_professional_source_required", "prepare_project_capability_from_discovered_source");
  if (profile?.status !== "ready" || profile.fitStatus !== "host_assessed_sources_current") {
    return gap("project_fit_required", "current_project_source_fit_required", "assess_current_project_capability_and_materials");
  }
  try {
    const binding = agentProfileOwnerBinding(owner, { projectRoot: root });
    if (canonical(profile.owner) !== canonical(binding)) failure("project_fit_owner_binding_mismatch");
    verifyAgentCapabilityProfileSnapshot(profile);
    const source = verifyOwnerSource(owner, binding, root, process.env.USERPROFILE ?? process.env.HOME ?? os.homedir()).source;
    const capabilitySources = [], capabilityProviders = [];
    for (const requirement of (workOrder.projectCapabilityRequirements ?? []).filter(row => ["skill", "command"].includes(row.capabilityType))) {
      const expectedRef = requirement.capabilityType === "skill" && !/[/\\]SKILL\.md$/iu.test(requirement.targetPath)
        ? path.join(requirement.targetPath, "SKILL.md") : requirement.targetPath;
      const expectedSource = requirement.capabilityType === "skill" ? "project_runtime_skill_inventory" : "project_runtime_command_inventory";
      const provider = providers.find(candidate => candidate.id === requirement.role && candidate.source === expectedSource &&
        path.resolve(root, candidate.sourceRef) === path.resolve(root, expectedRef) && samePath(candidate.sourceRoot, root));
      if (!provider) return gap("project_capability_required", "required_project_capability_unavailable:" + requirement.role, "prepare_or_select_required_project_capability");
      const material = readReference(root, { ref: expectedRef, contentDigest: `sha256:${normalizedDigest(provider.contentDigest)}` });
      capabilitySources.push({ ...material, sourceRoot: root, role: requirement.role, capabilityType: requirement.capabilityType });
      capabilityProviders.push(structuredClone(provider));
    }
    return { ...result, status: "project_owned_ready", projectCapabilityReady: true, blockedReasons: [], owner: binding,
      requiredRoles: requiredAgents.map(requirement => requirement.role),
      capabilitySources, capabilityProviders,
      ownerSource: source, materials: structuredClone(profile.materials ?? []),
      claimBoundary: "Current project source and assessed materials loaded; professional quality and actual invocation require their own observed results." };
  } catch (error) { return gap("capability_gap", error.message, "reassess_changed_project_capability_source"); }
}

export function verifyProjectCapabilityBindingSnapshot(binding) {
  for (const source of binding?.capabilitySources ?? []) {
    const observed = readReference(source.sourceRoot, { ref: source.sourceRef, contentDigest: source.contentDigest });
    if (observed.content !== source.content) failure("project_capability_source_snapshot_changed");
  }
}
