import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
import {
  agentCapabilityProfileDigest,
  agentProfileOwnerBinding,
  readAgentCapabilityProfiles,
  resolveAgentCapabilityProfile,
  saveAgentCapabilityProfiles,
} from "../../scripts/agent-capability-profile.mjs";

const hash = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function write(root, ref, value) {
  const file = path.join(root, ref);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return { ref, contentDigest: hash(readFileSync(file)) };
}
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-agent-profile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source-A");
  const projectRoot = path.join(root, "business-B");
  mkdirSync(sourceRoot); mkdirSync(projectRoot);
  const source = write(sourceRoot, "frontend.toml", 'name = "frontend"\ndescription = "Implement React and Vue frontend applications."\ndeveloper_instructions = "Preserve the project stack. Refuse backend schema changes."\n');
  const owner = { id: "frontend", runtime: "codex", source: "local_global_agent_inventory", sourceClass: "personal", sourceRef: path.join(sourceRoot, source.ref), sourceRoot,
    contentDigest: source.contentDigest.slice(7), metadata: { developer_instructions: "Implement React and Vue. Refuse backend schema changes." } };
  const evidence = write(projectRoot, "package.json", { dependencies: { vue: "3.5.0" } });
  const method = write(projectRoot, "docs/vue-method.md", "Keep Vue components and the current interaction contract.");
  const baseRef = write(sourceRoot, "defaults.json", { capabilityLoadout: { slots: [{ capabilitySlot: "frontend-ui-design", bindingType: "skill", providerId: "react-method", mode: "default" }] } });
  const profile = { capabilityProfileId: "frontend-project", capabilityProfileVersion: "1", owner: agentProfileOwnerBinding(owner),
    projectEvidenceRefs: [evidence], referenceDirection: "Apply the verified Vue project contract.", materialRefs: [method],
    baseProfileRef: { ...baseRef, sourceRoot },
    capabilityLoadout: { slots: [{ capabilitySlot: "frontend-ui-design", bindingType: "skill", providerId: "vue-method", mode: "default" }] } };
  const providers = ["react-method", "vue-method"].map((id) => ({ id, type: "skills", runtime: "codex", routeEligible: true }));
  const context = { profileSelections: [], fitAssessments: [], approvalRefs: [] };
  const adopt = (next = profile, expectedOldHash = null) => {
    const preview = saveAgentCapabilityProfiles({ projectRoot, profiles: [next], expectedOldHash });
    const approval = write(projectRoot, `reviews/adopt-${next.capabilityProfileVersion}-${expectedOldHash ?? "missing"}.json`, {
      scope: "project_capability_profile", status: "approved", projectRoot, candidateDigest: preview.contentDigest, expectedOldHash,
      evidenceClass: "fixture_artifact_only_not_host_approval",
    });
    return saveAgentCapabilityProfiles({ projectRoot, profiles: [next], expectedOldHash, approvalRefs: [approval], apply: true });
  };
  const fit = (next = profile, resolution = "reuse_existing_owner", extra = {}) => {
    const assessment = { projectRoot, owner: next.owner, capabilityProfileId: next.capabilityProfileId,
      capabilityProfileVersion: next.capabilityProfileVersion, profileDigest: agentCapabilityProfileDigest(next),
      ownerResolution: resolution, evidenceRefs: next.projectEvidenceRefs, rationale: "The real owner contract covers the verified project stack; only defaults change.", hardConflicts: [], ...extra };
    const assessmentRef = write(projectRoot, "reviews/fit.json", assessment);
    const approvalRef = write(projectRoot, "reviews/fit-approval.json", { scope: "project_agent_fit", status: "approved", projectRoot, assessmentDigest: assessmentRef.contentDigest });
    context.fitAssessments = [{ owner: next.owner, assessmentRef }]; context.approvalRefs = [approvalRef];
    return assessment;
  };
  const resolve = (options = {}) => resolveAgentCapabilityProfile({ projectRoot, owner, providers, context, runtime: "codex", capabilityNeed: ["frontend-ui-design"], ...options });
  return { root, sourceRoot, projectRoot, owner, profile, providers, context, evidence, method, adopt, fit, resolve };
}

test("agent profile reads source A and project B, saves only approved defaults and freezes actual material", (t) => {
  const f = fixture(t);
  assert.equal(f.resolve().fitStatus, "not_evaluated");
  const saved = f.adopt(); assert.equal(saved.status, "committed");
  f.fit();
  const result = f.resolve();
  assert.equal(result.status, "ready"); assert.equal(result.fitStatus, "host_assessed_sources_current");
  assert.equal(result.selectedProviders[0].id, "vue-method");
  assert.equal(result.materials[0].content, "Keep Vue components and the current interaction contract.");
  assert.equal(result.capabilityProfileVersion, "1");
  assert.equal(existsSync(path.join(f.projectRoot, ".codex/agents/frontend.toml")), false);
  assert.equal(existsSync(path.join(f.projectRoot, ".meta-kim/state/default/project-capabilities.json")), false);
  const oldText = result.materials[0].content;
  write(f.projectRoot, f.method.ref, "Changed project method.");
  assert.equal(result.materials[0].content, oldText, "an active run keeps its actual read snapshot");
  assert.equal(f.resolve().status, "capability_gap", "a changed source cannot reuse an old fit");
});

test("agent profile approval, readonly, same-version and CAS boundaries preserve the current private config", (t) => {
  const f = fixture(t);
  assert.throws(() => saveAgentCapabilityProfiles({ projectRoot: f.projectRoot, profiles: [f.profile], apply: true, expectedOldHash: null, approved: true }), /approval/u);
  assert.equal(saveAgentCapabilityProfiles({ projectRoot: f.projectRoot, profiles: [f.profile], apply: true, readOnly: true }).status, "not_applied_read_only");
  const saved = f.adopt();
  const current = readAgentCapabilityProfiles({ projectRoot: f.projectRoot });
  const bytes = readFileSync(current.path, "utf8");
  assert.equal(f.adopt(f.profile, current.fileHash).status, "unchanged");
  assert.throws(() => f.adopt({ ...f.profile, referenceDirection: "Silently changed same version" }, current.fileHash), /same_version/u);
  const renamed = write(f.sourceRoot, "frontend-renamed.toml", readFileSync(f.owner.sourceRef, "utf8"));
  assert.throws(() => saveAgentCapabilityProfiles({ projectRoot: f.projectRoot, profiles: [{ ...f.profile,
    owner: { ...f.profile.owner, sourceRef: path.join(f.sourceRoot, renamed.ref) } }], expectedOldHash: current.fileHash }), /same_version/u,
  "changing owner provenance is also a configuration change and needs a new profile version");
  assert.throws(() => f.adopt({ ...f.profile, capabilityProfileVersion: "2" }, "0".repeat(64)), /old_hash/u);
  assert.equal(readFileSync(current.path, "utf8"), bytes);
  assert.equal(saved.projectRoot, f.projectRoot);
});

test("agent profile fit and final required provider cannot be replaced by JSON labels or unsupported candidates", (t) => {
  const f = fixture(t); f.adopt();
  f.context.fitAssessments = [{ owner: f.profile.owner, ownerResolution: "reuse_existing_owner", approved: true }];
  assert.equal(f.resolve().status, "capability_gap");
  f.fit();
  assert.equal(f.resolve({ providers: f.providers.map((p) => ({ ...p, routeEligible: false })) }).status, "capability_gap");
  assert.equal(f.resolve({ providers: f.providers.map((p) => ({ ...p, runtimeSupport: { codex: "unsupported" } })) }).status, "capability_gap");
  const assessment = f.fit(f.profile, "upgrade_existing_owner");
  assert.equal(f.resolve().ownerResolution, assessment.ownerResolution);
  assert.equal(f.resolve().status, "capability_gap");
  f.fit(); write(f.projectRoot, f.evidence.ref, { dependencies: { react: "19.0.0" } });
  assert.equal(f.resolve().status, "capability_gap");
});

test("agent profile refuses source-root escape, bad format and another owner without assigning the profile", (t) => {
  const f = fixture(t); f.adopt(); f.fit();
  assert.equal(f.resolve({ owner: { ...f.owner, id: "review" } }).fitStatus, "not_evaluated");
  const current = readAgentCapabilityProfiles({ projectRoot: f.projectRoot });
  assert.throws(() => f.adopt({ ...f.profile, capabilityProfileVersion: "2", baseProfileRef: { ...f.profile.baseProfileRef, ref: "../business-B/package.json" } }, current.fileHash), /unsafe_reference/u);
  symlinkSync(f.sourceRoot, path.join(f.projectRoot, "source-link"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => f.adopt({ ...f.profile, capabilityProfileVersion: "2", materialRefs: [{ ref: "source-link/frontend.toml", contentDigest: f.profile.owner.contentDigest }] }, current.fileHash), /unsafe_reference/u);
  writeFileSync(current.path, JSON.stringify({ schemaVersion: 900, projectRoot: f.projectRoot, profiles: [] }));
  assert.throws(() => readAgentCapabilityProfiles({ projectRoot: f.projectRoot }), /schema/u);
});

test("agent profile default replacement needs source-bound fit and required/optional slots keep their distinct behavior", (t) => {
  const f = fixture(t); f.adopt(); f.fit();
  const available = f.providers.filter((entry) => entry.id === "react-method");
  assert.equal(f.resolve({ providers: available, fallbackProviders: available }).status, "capability_gap", "a discovered alternative is not evidence that it fits this project");
  f.fit(f.profile, "reuse_existing_owner", { fallbackProviderIds: ["react-method"] });
  const fallback = f.resolve({ providers: available, fallbackProviders: available });
  assert.equal(fallback.selectedProviders[0].id, "react-method");
  assert.equal(fallback.rejected[0].providerId, "vue-method");
  f.context.profileSelections = [{ owner: f.profile.owner, capabilityProfileId: f.profile.capabilityProfileId, capabilityProfileVersion: "1",
    contentDigest: agentCapabilityProfileDigest(f.profile), capabilityLoadout: { slots: [{ ...f.profile.capabilityLoadout.slots[0], providerId: "react-method" }] } }];
  assert.deepEqual(f.resolve().blockedReasons, ["agent_profile_run_loadout_assessment_required"]);
  const required = fixture(t);
  required.profile.capabilityLoadout.slots[0].mode = "required";
  required.adopt(); required.fit(required.profile, "reuse_existing_owner", { fallbackProviderIds: ["react-method"] });
  assert.equal(required.resolve({ providers: available, fallbackProviders: available }).status, "capability_gap");
  const optional = fixture(t);
  optional.profile.capabilityLoadout.slots[0] = { ...optional.profile.capabilityLoadout.slots[0], mode: "optional", appliesTo: ["browser-qa"] };
  optional.adopt(); optional.fit();
  assert.deepEqual(optional.resolve({ providers: [] }).selectedProviders, [], "an unrelated optional method is not loaded");
});

function slotLayers(t, { base, project, run }) {
  const f = fixture(t);
  f.profile.baseProfileRef = { ...write(f.sourceRoot, "defaults.json", { capabilityLoadout: { slots: base } }), sourceRoot: f.sourceRoot };
  f.profile.capabilityLoadout.slots = project;
  f.providers.push({ id: "vue-command", type: "commands", runtime: "codex" }, { id: "vue-mcp", type: "mcpTools", runtime: "codex" });
  f.adopt();
  const extra = {};
  if (run) {
    const capabilityLoadout = { slots: run };
    const canonical = JSON.stringify(capabilityLoadout, (_, value) => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
    extra.runLoadoutDigest = hash(canonical);
    f.context.profileSelections = [{ owner: f.profile.owner, capabilityProfileId: f.profile.capabilityProfileId, capabilityProfileVersion: "1",
      contentDigest: agentCapabilityProfileDigest(f.profile), capabilityLoadout }];
  }
  f.fit(f.profile, "reuse_existing_owner", extra);
  return f;
}

test("agent profile required conditions cannot be narrowed by project or run overrides", (t) => {
  const required = { capabilitySlot: "frontend-ui-design", bindingType: "skill", providerId: "react-method", mode: "required" };
  for (const layer of ["project", "run"]) {
    for (const appliesTo of [undefined, ["frontend-ui-design"]]) {
      const original = { ...required, ...(appliesTo ? { appliesTo } : {}) };
      const narrowed = { ...required, appliesTo: ["unrelated-need"] };
      const f = slotLayers(t, layer === "project" ? { base: [original], project: [narrowed] }
        : { base: [], project: [original], run: [narrowed] });
      const result = f.resolve();
      assert.equal(result.status, "capability_gap", `${layer} cannot hide ${appliesTo ? "conditional" : "unconditional"} required`);
      assert.deepEqual(result.blockedReasons, ["agent_profile_required_slot_override"]);
    }
    const conditional = { ...required, appliesTo: ["frontend-ui-design"] };
    const broadened = { ...required, appliesTo: ["frontend-ui-design", "browser-qa"] };
    const valid = slotLayers(t, layer === "project" ? { base: [conditional], project: [broadened] }
      : { base: [], project: [conditional], run: [broadened] });
    const result = valid.resolve();
    assert.equal(result.status, "ready");
    assert.deepEqual(result.selectedProviders.map((provider) => provider.id), ["react-method"]);
    assert.deepEqual(valid.resolve({ capabilityNeed: ["unrelated-need"] }).selectedProviders, [], "an untriggered conditional required stays conditional");
  }
});

test("agent profile capability slots replace defaults across binding types and keep required type constraints", (t) => {
  const slot = (bindingType, providerId, mode = "default") => ({ capabilitySlot: "frontend-ui-design", bindingType, providerId, mode });
  for (const layer of ["project", "run"]) {
    for (const [previous, next] of [
      [slot("skill", "react-method"), slot("command", "vue-command")],
      [slot("command", "vue-command"), slot("mcp_tool", "vue-mcp")],
      [slot("mcp_tool", "vue-mcp"), slot("skill", "vue-method")],
    ]) {
      const f = slotLayers(t, layer === "project" ? { base: [previous], project: [next] } : { base: [], project: [previous], run: [next] });
      const result = f.resolve();
      assert.equal(result.status, "ready", JSON.stringify(result.blockedReasons));
      assert.deepEqual(result.slots.map(({ capabilitySlot, bindingType, providerId }) => ({ capabilitySlot, bindingType, providerId })),
        [{ capabilitySlot: next.capabilitySlot, bindingType: next.bindingType, providerId: next.providerId }], `${layer} replaces the one capability slot`);
      assert.deepEqual(result.selectedProviders.map((provider) => provider.id), [next.providerId]);
    }
    const required = slot("skill", "react-method", "required");
    const changedType = slot("command", "react-method", "required");
    const f = slotLayers(t, layer === "project" ? { base: [required], project: [changedType] } : { base: [], project: [required], run: [changedType] });
    f.providers.push({ id: "react-method", type: "commands", runtime: "codex" });
    assert.deepEqual(f.resolve().blockedReasons, ["agent_profile_required_slot_override"], `${layer} cannot evade a required binding type`);
  }
});

test("agent profile skill creation cannot bypass missing MetaSC or the registry's unsupported runtime", (t) => {
  const f = fixture(t); f.profile.capabilityLoadout.slots = []; f.adopt(); f.fit();
  assert.deepEqual(f.resolve({ skillAuthoring: true }).blockedReasons, ["agent_profile_meta_skill_creator_required"]);
  const creator = { id: "meta-skill-creator", type: "skills", runtime: "codex" };
  const ready = f.resolve({ skillAuthoring: true, providers: [...f.providers, creator] });
  assert.equal(ready.status, "ready", JSON.stringify(ready.blockedReasons));
  assert.equal(ready.slots.find((slot) => slot.capabilitySlot === "skill-agent-tool-creation").provider.id, "meta-skill-creator");
  const wrong = fixture(t);
  wrong.profile.capabilityLoadout.slots = [{ capabilitySlot: "skill-agent-tool-creation", bindingType: "skill", providerId: "react-method", mode: "required" }];
  wrong.adopt(); wrong.fit();
  assert.deepEqual(wrong.resolve({ skillAuthoring: true, providers: [...wrong.providers, creator] }).blockedReasons, ["agent_profile_meta_skill_creator_required"]);
  const unsupported = fixture(t);
  unsupported.owner.runtime = "cursor"; unsupported.profile.owner = agentProfileOwnerBinding(unsupported.owner);
  unsupported.profile.capabilityLoadout.slots = []; unsupported.adopt(); unsupported.fit();
  assert.deepEqual(unsupported.resolve({ runtime: "cursor", skillAuthoring: true, providers: [...unsupported.providers.map((provider) => ({ ...provider, runtime: "cursor" })), { ...creator, runtime: "cursor" }] }).blockedReasons, ["agent_profile_meta_skill_creator_required"]);
});

test("agent profile failed commit restores private config and absence in a clone is not automatic recovery", (t) => {
  const f = fixture(t); f.adopt(); f.fit();
  const current = readAgentCapabilityProfiles({ projectRoot: f.projectRoot });
  const bytes = readFileSync(current.path, "utf8");
  const prior = process.env.META_KIM_TEST_FAIL_MANAGED_COMMIT_AT;
  process.env.META_KIM_TEST_FAIL_MANAGED_COMMIT_AT = "1";
  try {
    const result = f.adopt({ ...f.profile, capabilityProfileVersion: "2" }, current.fileHash);
    assert.equal(result.transaction.ok, false);
    assert.equal(readFileSync(current.path, "utf8"), bytes);
  } finally {
    if (prior === undefined) delete process.env.META_KIM_TEST_FAIL_MANAGED_COMMIT_AT;
    else process.env.META_KIM_TEST_FAIL_MANAGED_COMMIT_AT = prior;
  }
  const clone = path.join(f.root, "clone"); mkdirSync(clone);
  assert.equal(readAgentCapabilityProfiles({ projectRoot: clone }).status, "not_configured");
  assert.equal(existsSync(path.join(clone, ".meta-kim")), false);
});

test("agent profile upstream owner changes cannot silently fall back to an unconfigured legacy route", (t) => {
  const f = fixture(t); f.adopt(); f.fit();
  const changed = write(f.sourceRoot, "frontend.toml", `${readFileSync(f.owner.sourceRef, "utf8")}\n# Changed upstream source.\n`);
  const result = f.resolve({ owner: { ...f.owner, contentDigest: changed.contentDigest.slice(7) }, context: {} });
  assert.equal(result.status, "capability_gap");
  assert.deepEqual(result.blockedReasons, ["agent_profile_owner_binding_mismatch"]);
});

test("agent profile route consumes actual A/B sources through selector, runner API, Codex message and read-only bridge", { timeout: 180_000 }, async (t) => {
  const runtime = createGovernanceRuntimeFixtureScope(t);
  const projectRoot = path.join(runtime.root, "business-B");
  mkdirSync(projectRoot); mkdirSync(path.join(projectRoot, ".git"));
  const evidence = write(projectRoot, "package.json", { dependencies: { vue: "3.5.0" } });
  const material = write(projectRoot, "docs/project-method.md", "Use the Vue interaction contract; preserve pending state until the matching response.");
  const task = "Fix frontend code in src/Editor.vue and preserve the Vue pending state.";
  const cli = (context) => runtime.run(["scripts/select-execution-route.mjs", "--task", task, "--runtime", "codex", "--os", "windows", "--project-root", projectRoot, "--json",
    ...(context ? ["--agent-profile-context-json", JSON.stringify(context)] : [])]);
  // Official fixture-only preparation, never a production claim or ledger edit.
  const refreshed = runtime.run(["scripts/refresh-runtime-evidence-pins.mjs"]);
  assert.equal(refreshed.status, 0, refreshed.stderr || refreshed.stdout);
  const initial = cli(); assert.equal(initial.status, 0, initial.stderr || initial.stdout);
  const before = JSON.parse(initial.stdout);
  assert.equal(before.recommendedRoute.owner, "frontend");
  assert.equal(before.recommendedRoute.agentCapabilityProfile.fitStatus, "not_evaluated");
  const owner = before.ownerDiscoveryPacket.localGlobalAgents.find((entry) => entry.id === "frontend");
  assert.ok(owner, "use the actual discovered source, not a hand-authored route owner");
  const module = await runtime.import("scripts/agent-capability-profile.mjs");
  const sourceRoot = path.join(runtime.home, ".codex/agents");
  const baseMaterial = write(sourceRoot, "frontend-method.md", "Source A method: preserve the project's framework and report evidence, never expand permissions.");
  const baseProfileRef = { ...write(sourceRoot, "frontend-defaults.json", { capabilityLoadout: { slots: [] }, materialRefs: [baseMaterial] }), sourceRoot };
  const profile = { capabilityProfileId: "vue-project", capabilityProfileVersion: "1", owner: module.agentProfileOwnerBinding(owner),
    baseProfileRef, projectEvidenceRefs: [evidence], materialRefs: [material], referenceDirection: "Apply the actual Vue project interaction rules.",
    capabilityLoadout: { slots: [{ capabilitySlot: "frontend-ui-design", bindingType: "skill", providerId: "design-html", mode: "default" }] } };
  const preview = module.saveAgentCapabilityProfiles({ projectRoot, profiles: [profile], expectedOldHash: null });
  const approval = write(projectRoot, "reviews/adoption.json", { scope: "project_capability_profile", status: "approved", projectRoot,
    candidateDigest: preview.contentDigest, expectedOldHash: null, evidenceClass: "fixture_only_not_native_host_approval" });
  assert.equal(module.saveAgentCapabilityProfiles({ projectRoot, profiles: [profile], expectedOldHash: null, approvalRefs: [approval], apply: true }).status, "committed");
  const assessmentRef = write(projectRoot, "reviews/fit.json", { projectRoot, owner: profile.owner, capabilityProfileId: profile.capabilityProfileId,
    capabilityProfileVersion: "1", profileDigest: module.agentCapabilityProfileDigest(profile), ownerResolution: "reuse_existing_owner", evidenceRefs: [evidence],
    rationale: "Fixture Thinking judgment: this bounded frontend owner fits; only project defaults and facts differ.", hardConflicts: [] });
  const fitApproval = write(projectRoot, "reviews/fit-approval.json", { scope: "project_agent_fit", status: "approved", projectRoot, assessmentDigest: assessmentRef.contentDigest });
  const context = { profileSelections: [], fitAssessments: [{ owner: profile.owner, assessmentRef }], approvalRefs: [fitApproval] };
  const direct = module.resolveAgentCapabilityProfile({ projectRoot, owner, runtime: "codex", context, providers: [
    { id: "design-html", type: "skills", runtime: "codex" },
  ] });
  assert.equal(direct.status, "ready", JSON.stringify(direct.blockedReasons));
  const routed = cli(context); assert.equal(routed.status, 0, routed.stderr || routed.stdout);
  const selected = JSON.parse(routed.stdout);
  assert.equal(selected.recommendedRoute.owner, "frontend", JSON.stringify({ beforeOwner: before.recommendedRoute?.owner, taskShape: selected.taskShape,
    gap: selected.capabilityGapPacket, rejected: selected.rejectedRoutes, profile: selected.recommendedRoute?.agentCapabilityProfile }));
  assert.equal(selected.recommendedRoute.agentCapabilityProfile.contentDigest, module.agentCapabilityProfileDigest(profile));
  assert.equal(selected.recommendedRoute.selectedCapabilityProviders.skill.id, "design-html");
  const topMessage = JSON.parse(selected.recommendedRoute.codexSpawnBinding.message);
  assert.equal(topMessage.agentCapabilityProfile?.contentDigest, module.agentCapabilityProfileDigest(profile), "the public top-level binding also consumes the read snapshot");
  const codexMessage = JSON.parse(selected.workerTaskPacketDrafts[0].codexSpawnBinding.message);
  assert.equal(codexMessage.agentCapabilityProfile.capabilityProfileId, "vue-project");
  assert.equal(codexMessage.requiredMaterials.find((entry) => entry.sourceRef === material.ref).content, readFileSync(path.join(projectRoot, material.ref), "utf8"));
  assert.equal(codexMessage.requiredMaterials.find((entry) => entry.sourceRef === baseMaterial.ref).content, readFileSync(path.join(sourceRoot, baseMaterial.ref), "utf8"));
  const runner = await runtime.import("scripts/run-meta-theory-governed-execution.mjs");
  const api = await runner.runMetaTheoryGovernedExecution({ task, projectRoot, runId: "agent-profile-api", artifactDir: path.join(runtime.root, "artifacts"),
    stateDir: path.join(runtime.root, "state"), dbPath: path.join(runtime.root, "state.sqlite"), agentCapabilityProfileContext: context,
    projectCapabilityMutationMode: "read_only", emitConversationNotice: false });
  const packet = api.coreLoop.thinkingPacket.workerTaskPackets.find((entry) => entry.ownerAgent === "frontend");
  assert.equal(packet.agentCapabilityProfile.contentDigest, module.agentCapabilityProfileDigest(profile));
  assert.equal(packet.capabilityLoadout.capabilityProfileId, "vue-project");
  const bridge = await runtime.import("scripts/governed-execution/stage-runner-bridge.mjs");
  const prompt = bridge.buildReadOnlyWorkerPrompt({ runId: "agent-profile-api", runtime: "codex", node: { nodeId: "fixture" }, packet });
  assert.ok(prompt.includes(readFileSync(path.join(projectRoot, material.ref), "utf8")));
  assert.ok(prompt.includes(readFileSync(path.join(sourceRoot, baseMaterial.ref), "utf8")), "the read-only worker receives source-A content without reading outside business B");
  assert.match(prompt, /Do not edit, create, delete, install/u);
  const prepared = await bridge.prepareReadOnlyRuntimeInvocation({ runtime: "codex", workspaceRoot: projectRoot, packet, prompt });
  assert.equal(prepared.input, prompt);
  assert.ok(prepared.args.includes("read-only"));
  const profileOnly = runner.buildProjectCustomizationPacket({ task: "需要迭代全局 frontend agent 的默认方法，不改变角色职责。", runtime: "codex", runId: "profile-only",
    projectRoot, orchestrationReport: { selectedExecutionRoute: selected }, runtimeInvocationPlanPacket: { requiredBindings: [] }, outputLanguage: "zh-CN" });
  assert.equal(profileOnly.decisions[0].decision, "use_global_directly", "changing defaults does not copy a stable identity");
  const secondary = runner.buildRouteDrivenWorkerTasks({ runId: "two-owner-profile", task, routeResult: {
    ...selected, workerTaskPacketDrafts: [], recommendedRoute: { ...selected.recommendedRoute, parallelExecutionLanes: [
      { laneId: "frontend", ownerAgent: "frontend", agentCapabilityProfile: selected.recommendedRoute.agentCapabilityProfile },
      { laneId: "review", ownerAgent: "review" },
    ] },
  } });
  assert.equal(secondary[0].agentCapabilityProfile.capabilityProfileId, "vue-project");
  assert.equal(secondary[1].agentCapabilityProfile, null, "a primary-owner profile is not broadcast to review");
  assert.equal(existsSync(path.join(projectRoot, ".meta-kim/state/default/project-capabilities.json")), false);
  assert.equal(existsSync(path.join(projectRoot, ".codex/agents")), false);
  const reviewOwner = before.ownerDiscoveryPacket.localGlobalAgents.find((entry) => entry.id === "review");
  const reviewMaterial = write(projectRoot, "docs/review-method.md", "Review the exact response-state evidence; do not modify project files.");
  const reviewProfile = { capabilityProfileId: "review-project", capabilityProfileVersion: "1", owner: module.agentProfileOwnerBinding(reviewOwner),
    capabilityLoadout: { slots: [{ capabilitySlot: "verification-eval-and-release", bindingType: "skill", providerId: "e2e-testing", mode: "default" }] },
    projectEvidenceRefs: [evidence], materialRefs: [reviewMaterial], referenceDirection: "Independently review the project evidence." };
  const oldConfig = module.readAgentCapabilityProfiles({ projectRoot });
  const twoPreview = module.saveAgentCapabilityProfiles({ projectRoot, profiles: [profile, reviewProfile], expectedOldHash: oldConfig.fileHash });
  const twoApproval = write(projectRoot, "reviews/adopt-two.json", { scope: "project_capability_profile", status: "approved", projectRoot,
    candidateDigest: twoPreview.contentDigest, expectedOldHash: oldConfig.fileHash });
  assert.equal(module.saveAgentCapabilityProfiles({ projectRoot, profiles: [profile, reviewProfile], expectedOldHash: oldConfig.fileHash, approvalRefs: [twoApproval], apply: true }).status, "committed");
  const reviewFitRef = write(projectRoot, "reviews/review-fit.json", { projectRoot, owner: reviewProfile.owner, capabilityProfileId: reviewProfile.capabilityProfileId,
    capabilityProfileVersion: "1", profileDigest: module.agentCapabilityProfileDigest(reviewProfile), ownerResolution: "reuse_existing_owner", evidenceRefs: [evidence],
    rationale: "Fixture review owner retains its read-only boundary and uses the current project evidence.", hardConflicts: [] });
  const reviewApproval = write(projectRoot, "reviews/review-fit-approval.json", { scope: "project_agent_fit", status: "approved", projectRoot, assessmentDigest: reviewFitRef.contentDigest });
  const twoContext = { profileSelections: [], fitAssessments: [...context.fitAssessments, { owner: reviewProfile.owner, assessmentRef: reviewFitRef }], approvalRefs: [fitApproval, reviewApproval] };
  const parallel = runtime.run(["scripts/select-execution-route.mjs", "--task", "并行：frontend 检查代码 src/Editor.vue；review 审查代码 server/api.py。", "--runtime", "codex", "--os", "windows", "--project-root", projectRoot, "--json", "--agent-profile-context-json", JSON.stringify(twoContext)]);
  assert.equal(parallel.status, 0, parallel.stderr || parallel.stdout);
  const parallelRoute = JSON.parse(parallel.stdout);
  const lanes = parallelRoute.recommendedRoute?.parallelExecutionLanes;
  assert.deepEqual(lanes?.map((lane) => [lane.ownerAgent, lane.agentCapabilityProfile.capabilityProfileId]), [["frontend", "vue-project"], ["review", "review-project"]]);
  const parallelPackets = runner.buildRouteDrivenWorkerTasks({ runId: "two-real-owners", routeResult: parallelRoute, task: "independent read-only code review" });
  assert.deepEqual(parallelPackets.map((entry) => [entry.ownerAgent, entry.capabilityLoadout.capabilityProfileId]), [["frontend", "vue-project"], ["review", "review-project"]]);
  write(runtime.repoRoot, ".codex/agents/framework-only-pro.toml", 'name = "framework-only-pro"\ndescription = "Fixture only"\ndeveloper_instructions = "Read fixture evidence."\n');
  const businessAgent = write(projectRoot, ".codex/agents/business-vue.toml", 'name = "business-vue"\ndescription = "Implement Vue frontend code."\ndeveloper_instructions = "Preserve Vue and refuse backend work."\n');
  const businessDiscovery = cli(twoContext); assert.equal(businessDiscovery.status, 0, businessDiscovery.stderr || businessDiscovery.stdout);
  const discoveredIds = JSON.parse(businessDiscovery.stdout).ownerDiscoveryPacket.projectRuntimeAgents.map((entry) => entry.id);
  assert.ok(discoveredIds.includes("business-vue"));
  assert.equal(discoveredIds.includes("framework-only-pro"), false, "framework A's project identity is not business B's inventory");
  assert.equal(hash(readFileSync(path.join(projectRoot, businessAgent.ref))), businessAgent.contentDigest);
  write(projectRoot, material.ref, "Changed project source after the reviewed snapshot.");
  const stale = cli(context); assert.equal(stale.status, 0, stale.stderr || stale.stdout);
  assert.equal(JSON.parse(stale.stdout).recommendedRoute, null, "stale requested profile sources return a real gap rather than another unassessed owner");
  assert.ok(JSON.parse(stale.stdout).capabilityGapPacket);
  const opaque = write(runtime.repoRoot, ".meta-kim/state/default/agent-capability-profiles.json", "private user configuration, unknown version: preserve verbatim\n");
  const resync = runtime.run(["scripts/sync-runtimes.mjs", "--scope", "project", "--targets", "codex"]);
  assert.equal(resync.status, 0, resync.stderr || resync.stdout);
  assert.equal(hash(readFileSync(path.join(runtime.repoRoot, opaque.ref))), opaque.contentDigest, "existing isolated project sync preserves unknown private profile bytes");
});
