import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createLiveWorkspaceService } from "../../src/application/live/live-workspace-service.mjs";
import { createWorkspaceReview, workspaceDigest } from "../../src/domain/live/live-workspace.mjs";
import { loadLiveWorkspacePolicy, normalizeLiveWorkspacePolicy } from "../../src/application/live/live-workspace-policy.mjs";
import { buildLocalReviewClaim, claimHostAnswer } from "../../src/domain/decision/decision.mjs";
import { activateSpineState, createInitialState, readSpineState, createMetaRunStatusEnvelope } from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import { inspectLiveWorkspaceGate } from "../../canonical/runtime-assets/shared/hooks/live-workspace-gate.mjs";
import { buildGovernedHostHandoff, checkpointGovernedHost, inspectGovernedHostCheckpoint } from "../../canonical/runtime-assets/shared/hooks/governed-host-checkpoint.mjs";
import { taskProgressGoal } from "../../canonical/runtime-assets/shared/hooks/task-progress.mjs";
import { buildLiveSnapshot } from "../../src/application/live/live-control-room-service.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(REPO, "scripts/live-workspace-host.mjs");
const CHAT = "01900000-0000-7000-8000-000000000092";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const critical = { realIntent: "Review the actual bound system design", successCriteria: ["Preserve original material and exact review versions"] };
const detailed = id => ({ implementationNotes: `Implement ${id} against the current interfaces`, businessRules: ["Preserve object identity"],
  states: [{ name: "empty", behavior: "Explain the next step" }, { name: "failed", behavior: "Preserve user input" }] });
function designInput({ full = false, dependent = false } = {}) {
  return { schemaVersion: 1, design: { mode: "exploration", userJourneys: [], interfaces: [], sharedState: [], taskSlices: [], settledDecisionRefs: [],
    softwareDesign: { schemaVersion: 1, architecture: { id: "review-system", revision: 1, summary: "Private outline canary WORKSPACE_ONLY_27", decisionRefs: [], technologyChoices: [], constraints: [], moduleIds: ["alpha", "beta"] },
      modules: [{ id: "alpha", purpose: "Preserve input", ...(full ? detailed("alpha") : {}) },
        { id: "beta", purpose: "Review output", ...(dependent ? { dependsOn: ["alpha"] } : {}), ...(full ? detailed("beta") : {}) }] } } };
}
async function fixture(t, { runId, clock, profile = "default" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-live-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, ".meta-kim/work"), { recursive: true });
  await mkdir(path.join(root, "outputs"));
  const state = createInitialState({ activationMode: "hook_observed", driverMode: "hook_observed", hookGateMode: "advisory",
    sourceConversation: { runtime: "codex", conversationId: CHAT, matchBasis: "transcript_file_verified" } });
  if (runId) { state.runId = runId; state.sourceConversation.runId = runId; }
  if (profile !== "default") state.profile = profile;
  state.recordOrigin = "acceptance_fixture";
  state.currentStage = "thinking"; state.stages.critical.status = "completed"; state.stages.fetch.status = "completed";
  state.stages.thinking.status = "in_progress"; state.criticalRecord = critical;
  await activateSpineState(root, state);
  const service = createLiveWorkspaceService({ projectRoot: root, profile, ...(clock ? { now: clock } : {}) });
  const overview = () => service.getOverview({ runId: state.runId });
  const publish = async input => service.publishDesign({ runId: state.runId, conversationId: CHAT,
    expectedRevision: (await overview()).revision, input });
  const vote = async (kind, choice = "accept", nonce = `vote-${Math.random().toString(16).slice(2)}`) => {
    const current = await overview();
    const review = current.reviews.find(item => kind === "outline" ? item.kind === "outline" : item.moduleId === kind);
    const input = { runId: state.runId, decisionId: review.decisionId, expectedRevision: review.revision,
      expectedWorkspaceRevision: current.revision, artifactId: review.artifactId, version: review.version, choice, nonce };
    return { input, result: await service.review(input) };
  };
  return { root, runId: state.runId, state, service, overview, publish, vote };
}

test("real host CLI and spine Decision review continue outline to modules without model invocation", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, ".meta-kim/work/design.json"), JSON.stringify(designInput()));
  const cli = spawnSync(process.execPath, [CLI, "--project-root", f.root, "--run-id", f.runId,
    "--conversation-id", CHAT, "--publish-design", "--input", ".meta-kim/work/design.json", "--expected-revision", "0"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  const registered = JSON.parse(cli.stdout);
  assert.equal(registered.nextAction.kind, "awaiting_review");
  assert.equal(registered.nativeInvocationVerified, false);
  const accepted = await f.vote("outline");
  assert.equal(accepted.result.nextAction.moduleId, "alpha");
  const snapshot = await f.overview();
  assert.equal(snapshot.source.recordOrigin, "acceptance_fixture");
  const claim = await f.service.claimRequest({ runId: f.runId, conversationId: CHAT, expectedRevision: snapshot.revision,
    commandId: accepted.result.nextAction.commandId });
  assert.equal(claim.status, "host_claimed");
  assert.equal(claim.completionVerified, false);
  const input = designInput(); Object.assign(input.design.softwareDesign.modules[0], detailed("alpha"));
  await f.publish(input);
  assert.equal((await f.overview()).design.architecture.status, "accepted", "unchanged outline acceptance remains current");
  await writeFile(path.join(f.root, "outputs/alpha.txt"), "Actual host acceptance fixture output\n");
  const report = await f.service.completeRequest({ runId: f.runId, conversationId: CHAT, expectedRevision: (await f.overview()).revision,
    commandId: claim.commandId, claimToken: claim.claimToken, input: { outcome: "produced", summary: "File was written by the fixture host",
      evidenceRefs: [{ ref: "outputs/alpha.txt", sha256: sha("Actual host acceptance fixture output\n") }] } });
  assert.equal(report.status, "host_reported"); assert.equal(report.nativeInvocationVerified, false);
  assert.equal((await f.vote("alpha")).result.nextAction.moduleId, "beta");
  const state = await readSpineState(f.root);
  const inspection = await inspectGovernedHostCheckpoint({ projectRoot: f.root, cwd: f.root, runId: f.runId, conversationId: CHAT });
  assert.equal(inspection.workspaceNextAction.moduleId, "beta");
  const envelope = createMetaRunStatusEnvelope(state);
  const publicSnapshot = buildLiveSnapshot({ durableStatus: envelope });
  assert.equal(envelope.recordOrigin, "acceptance_fixture");
  assert.ok(!JSON.stringify(envelope).includes("WORKSPACE_ONLY_27"));
  assert.ok(!JSON.stringify(publicSnapshot).includes("WORKSPACE_ONLY_27"));
});

test("real current-host handoff routes a non-default profile without environment or default fallback", async t => {
  const profile = "team-example";
  const f = await fixture(t, { profile });
  await f.publish(designInput());
  const state = await readSpineState(f.root, { profile });
  assert.equal(state.liveWorkspace.profile, profile);
  const build = source => buildGovernedHostHandoff({ state: source, projectRoot: f.root,
    adapterPath: path.join(REPO, "canonical/runtime-assets/shared/hooks/governed-host-checkpoint.mjs"),
    skillPath: path.join(REPO, "canonical/skills/meta-theory/SKILL.md"), language: "en" });
  const parse = content => JSON.parse(content.split("\n").find(line => line.startsWith("Current private Live workspace handoff: "))
    .slice("Current private Live workspace handoff: ".length));
  const handoff = parse(build(state));
  assert.equal(handoff.profile, profile);
  assert.equal(handoff.arguments[handoff.arguments.indexOf("--profile") + 1], profile);
  const invoked = spawnSync(process.execPath, [handoff.hostEntry, ...handoff.arguments], {
    encoding: "utf8", env: { ...process.env, META_KIM_PROFILE: "wrong-profile", META_KIM_STATE_PROFILE: "wrong-profile" } });
  assert.equal(invoked.status, 0, invoked.stderr);
  assert.equal(JSON.parse(invoked.stdout).runId, f.runId);
  assert.equal(JSON.parse(invoked.stdout).designStatus, "in_progress");
  const wrongArguments = [...handoff.arguments]; wrongArguments[wrongArguments.indexOf("--profile") + 1] = "default";
  const wrong = spawnSync(process.execPath, [handoff.hostEntry, ...wrongArguments], {
    encoding: "utf8", env: { ...process.env, META_KIM_PROFILE: profile } });
  assert.equal(wrong.status, 1);
  assert.equal(JSON.parse(wrong.stderr).code, "workspace_current_run_unavailable");
  const unbound = structuredClone(state); delete unbound.liveWorkspace.profile;
  const unavailable = parse(build(unbound));
  assert.equal(unavailable.reason, "workspace_profile_unbound");
  assert.equal(unavailable.arguments, undefined, "missing profile must not emit an ambiguous default command");
});

test("review CAS and nonce enforce replay, conflicting votes, stale tabs and project isolation", async t => {
  const f = await fixture(t, { runId: "meta-workspace-shared-identity" });
  const other = await fixture(t, { runId: f.runId });
  await f.publish(designInput({ full: true })); await other.publish(designInput({ full: true }));
  const first = await f.vote("outline", "accept", "same-review-nonce");
  assert.equal((await f.service.review(first.input)).replay, true);
  await assert.rejects(f.service.review({ ...first.input, choice: "return" }), { code: "workspace_nonce_conflict" });
  await assert.rejects(other.service.review(first.input), { code: "workspace_review_binding_conflict" });
  const current = await f.overview(); const review = current.reviews.find(item => item.moduleId === "alpha");
  const body = { runId: f.runId, decisionId: review.decisionId, expectedRevision: review.revision, expectedWorkspaceRevision: current.revision,
    artifactId: review.artifactId, version: review.version, choice: "accept", nonce: "concurrent-vote-a" };
  const races = await Promise.allSettled([f.service.review(body), f.service.review({ ...body, nonce: "concurrent-vote-b", choice: "revise" })]);
  assert.equal(races.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(races.find(result => result.status === "rejected").reason.code, "workspace_revision_conflict");
  await assert.rejects(f.service.review({ ...body, nonce: "late-tab-review" }), { code: "workspace_revision_conflict" });
});

test("paged immutable UTF-8 material survives source edits while approval and claims reject drift", async t => {
  const f = await fixture(t);
  const source = "\ufeff" + "a".repeat(loadLiveWorkspacePolicy().materialPageBytes - 3) + "\ufeff# 私有原文\r\n" + "😀中文保真\\\"\r\n".repeat(11000);
  await writeFile(path.join(f.root, "outputs/outline.md"), source);
  const input = designInput(); input.materialRefs = { outline: "outputs/outline.md" };
  await f.publish(input);
  const view = await f.overview(), material = view.design.architecture;
  let cursor = null, reconstructed = "", pages = 0;
  do {
    const page = await f.service.getMaterial({ runId: f.runId, artifactId: material.artifactId, version: material.version, cursor });
    assert.ok(Buffer.byteLength(page.text) <= loadLiveWorkspacePolicy().materialPageBytes);
    reconstructed += page.text; cursor = page.nextCursor; pages += 1;
  } while (cursor);
  assert.ok(pages > 1); assert.equal(sha(reconstructed), sha(source));
  await writeFile(path.join(f.root, "outputs/outline.md"), "Unpublished change\n");
  const old = await f.service.getMaterial({ runId: f.runId, artifactId: material.artifactId, version: material.version });
  assert.equal(old.sourceState, "changed"); assert.equal(old.text, source.slice(0, old.text.length));
  await assert.rejects(f.vote("outline"), { code: "workspace_material_changed" });
  assert.equal((await f.overview()).design.architecture.status, "material_changed");
  await assert.rejects(f.service.getMaterial({ runId: f.runId, artifactId: material.artifactId, version: "sha256:" + "0".repeat(64) }),
    { code: "workspace_material_version_conflict" });
  await symlink(path.join(f.root, "outputs/outline.md"), path.join(f.root, "outputs/redirect.md"));
  input.materialRefs.outline = "outputs/redirect.md";
  await assert.rejects(f.publish(input), { code: "workspace_material_path_untrusted" });
});

test("feedback keeps exact original, invalidates actual Decision and has one consumable work order", async t => {
  const f = await fixture(t);
  await f.publish(designInput({ full: true })); await f.vote("outline"); await f.vote("alpha"); await f.vote("beta");
  const before = await f.overview(), target = before.design.modules[0];
  const original = "  用户原话\r\n请保留全部\\引号\"与😀\n  ";
  const input = { runId: f.runId, moduleId: target.id, artifactId: target.artifactId, version: target.version,
    original, expectedWorkspaceRevision: before.revision, nonce: "feedback-exact-original" };
  const result = await f.service.feedback(input);
  assert.equal(result.status, "waiting_host");
  assert.equal((await f.service.feedback(input)).replay, true);
  const after = await f.overview();
  assert.equal(after.reviews.find(review => review.moduleId === "alpha").state, "invalidated");
  assert.equal(after.nextAction.commandId, result.commandId);
  const pendingAlpha = after.requests.filter(request => request.targetId === "alpha" && request.status === "waiting_host");
  assert.equal(pendingAlpha.length, 1, "feedback must not enqueue an additional revise-module command");
  const claim = await f.service.claimRequest({ runId: f.runId, conversationId: CHAT, commandId: result.commandId, expectedRevision: after.revision });
  assert.equal(await readFile(path.join(f.root, claim.workOrder.feedback.ref), "utf8"), original);
  assert.equal((await f.service.feedback(input)).status, "host_claimed", "idempotent submit returns the actual current receipt status");
  await assert.rejects(f.service.feedback({ ...input, nonce: "feedback-over-budget", original: "x".repeat(loadLiveWorkspacePolicy().maxFeedbackBytes + 1) }),
    { code: "workspace_feedback_limit" });
});

test("module replacement preserves independent reviews, invalidates dependency bases and archives old runs read-only", async t => {
  const f = await fixture(t);
  const input = designInput({ full: true });
  await f.publish(input); await f.vote("outline"); await f.vote("alpha"); await f.vote("beta");
  const before = await f.overview();
  input.design.softwareDesign.modules[0].implementationNotes += " Revised actual detail.";
  await f.publish(input);
  let after = await f.overview();
  assert.equal(after.design.architecture.status, "accepted");
  assert.equal(after.design.modules[0].status, "awaiting_human");
  assert.equal(after.design.modules[1].status, "accepted");
  assert.equal(after.design.modules[1].decisionId, before.design.modules[1].decisionId);
  const earlier = await f.service.getMaterial({ runId: f.runId, artifactId: before.design.modules[0].artifactId, version: before.design.modules[0].version });
  assert.equal(earlier.historical, true); assert.equal(earlier.current, false);
  assert.ok(!earlier.text.includes("Revised actual detail."), "only the exact historically reviewed blob is returned");
  const next = createInitialState({ sourceConversation: { runtime: "codex", conversationId: CHAT, matchBasis: "transcript_file_verified" } });
  next.recordOrigin = "acceptance_fixture";
  const activation = await activateSpineState(f.root, next, { replaceActive: true, expectedRunId: f.runId });
  assert.equal(activation.activated, true);
  after = await f.overview();
  assert.equal(after.source.kind, "archived_spine_projection"); assert.equal(after.capabilities.feedback.available, false);
  assert.equal(after.design.modules[1].status, "accepted");
  await assert.rejects(f.vote("alpha"), { code: "workspace_current_run_unavailable" });
  const oldMaterial = await f.service.getMaterial({ runId: f.runId, artifactId: after.design.modules[0].artifactId, version: after.design.modules[0].version });
  assert.match(oldMaterial.text, /Revised actual detail/u);
  const dependent = await fixture(t); const bound = designInput({ full: true, dependent: true });
  await dependent.publish(bound); await dependent.vote("outline");
  await assert.rejects(dependent.vote("beta"), { code: "workspace_dependency_review_required" });
  await dependent.vote("alpha"); await dependent.vote("beta");
  bound.design.softwareDesign.modules[0].implementationNotes += " Changed interface detail.";
  await dependent.publish(bound);
  assert.equal((await dependent.overview()).design.modules[1].status, "awaiting_human");
});

test("expired host claims remain in doubt and an exact late receipt reconciles without redispatch", async t => {
  let time = Date.now(); const f = await fixture(t, { clock: () => new Date(time).toISOString() });
  await f.publish(designInput()); const accepted = await f.vote("outline");
  const claim = await f.service.claimRequest({ runId: f.runId, conversationId: CHAT, commandId: accepted.result.nextAction.commandId,
    expectedRevision: (await f.overview()).revision });
  time += loadLiveWorkspacePolicy().hostLeaseMs + 1;
  const requests = await f.service.getRequests({ runId: f.runId, commandId: claim.commandId });
  assert.equal(requests.requests[0].status, "in_doubt");
  await assert.rejects(f.service.claimRequest({ runId: f.runId, conversationId: CHAT, commandId: claim.commandId,
    expectedRevision: (await f.overview()).revision }), { code: "workspace_request_not_claimable" });
  await writeFile(path.join(f.root, "outputs/receipt.txt"), "Actual file evidence\n");
  const input = { outcome: "blocked", summary: "Original host reports its actual blockage", evidenceRefs: [{ ref: "outputs/receipt.txt", sha256: sha("Actual file evidence\n") }] };
  const common = { runId: f.runId, conversationId: CHAT, commandId: claim.commandId, claimToken: claim.claimToken, input };
  const originalRevision = (await f.overview()).revision;
  assert.equal((await f.service.completeRequest({ ...common, expectedRevision: originalRevision })).status, "host_reported");
  assert.equal((await f.service.completeRequest({ ...common, expectedRevision: originalRevision })).replay, true);
  await assert.rejects(f.service.completeRequest({ ...common, expectedRevision: (await f.overview()).revision, input: { ...input, summary: "Different return" } }),
    { code: "workspace_host_receipt_replay_conflict" });
});

test("the existing Thinking checkpoint waits for outline and module reviews then advances the same run", async t => {
  const f = await fixture(t);
  await f.publish(designInput({ full: true }));
  await writeFile(path.join(f.root, "outputs/strategy.txt"), "Current implementation approach\n");
  await writeFile(path.join(f.root, "outputs/basis.txt"), "Current user input evidence\n");
  const record = { designFrame: "Use the accepted system design", chosenRationale: "One current spine authority",
    consideredLanes: ["implementation", "review"], dependencyPolicy: "Current versioned module contracts", reviewStandard: "Current artifact evidence",
    workerTaskPackets: [{ taskPacketId: "task-workspace-checkpoint", ownerAgent: "backend", ownerSource: "explicit acceptance fixture owner",
      roleDisplayName: "backend", roleInstanceId: "workspace-proof", scope: "Inspect one bound module", expectedOutput: "Verified result",
      verification: "Inspect actual file evidence", mergeOwner: "parent", weapon: "runtime:read", capabilityId: "runtime:source-inspection",
      strategyRef: { id: "method:workspace-acceptance", ref: "outputs/strategy.txt", sha256: sha("Current implementation approach\n") },
      dependsOn: [], acceptanceCriterionIds: taskProgressGoal(critical).criteria.map(item => item.criterionId),
      progressBasisEvidence: [{ ref: "outputs/basis.txt", sha256: sha("Current user input evidence\n") }] }] };
  const options = { projectRoot: f.root, cwd: f.root, runId: f.runId, conversationId: CHAT, stage: "thinking",
    input: { ownerAgent: "meta-conductor", summary: "Current design checkpoint", evidenceRefs: ["outputs/basis.txt"], status: "complete", record } };
  const held = await checkpointGovernedHost(options);
  assert.equal(held.currentStage, "thinking"); assert.equal(held.workspaceGate.ready, false);
  const thinkingView = (await f.overview()).stages.find(stage => stage.id === "thinking");
  assert.deepEqual(thinkingView.evidenceRefs, ["outputs/basis.txt"]); assert.equal(thinkingView.evidenceLevel, "owner_reported");
  await f.vote("outline"); await f.vote("alpha"); await f.vote("beta");
  assert.equal((await inspectLiveWorkspaceGate(await readSpineState(f.root), f.root)).ready, true);
  const acceptedState = await readSpineState(f.root);
  const materialRef = acceptedState.liveWorkspace.materials[acceptedState.liveWorkspace.modules[0].artifactId].ref;
  const materialFile = path.join(f.root, materialRef), original = await readFile(materialFile);
  await writeFile(materialFile, "Changed after human acceptance\n");
  assert.equal((await inspectLiveWorkspaceGate(await readSpineState(f.root), f.root)).reason, "live_design_material_changed");
  await writeFile(materialFile, original);
  const continued = await checkpointGovernedHost(options);
  assert.equal(continued.currentStage, "execution"); assert.equal(continued.workspaceGate.ready, true);
  assert.equal(continued.nativeInvocationVerified, false);
});

test("an existing governed softwareDesign remains privately readable without inventing Live acceptance", async t => {
  const f = await fixture(t);
  const executionRoot = path.join(f.root, ".meta-kim/state/default/governed-executions");
  await mkdir(executionRoot, { recursive: true });
  const artifact = { schemaVersion: "governed-execution-v1", runId: f.runId, recordOrigin: "acceptance_fixture",
    productDesignPacket: designInput({ full: true }).design };
  const file = path.join(executionRoot, `${f.runId}.json`);
  await writeFile(file, JSON.stringify(artifact));
  const view = await f.overview();
  assert.equal(view.source.kind, "governed_design_artifact");
  assert.equal(view.design.status, "unregistered"); assert.equal(view.capabilities.review.available, false);
  const module = view.design.modules[0];
  const page = await f.service.getMaterial({ runId: f.runId, artifactId: module.artifactId, version: module.version });
  assert.match(page.text, /Implement alpha/u);
  assert.equal(page.sha256, module.sha256);
  assert.equal((await readSpineState(f.root)).liveWorkspace, undefined, "read APIs never register or mutate a legacy design");
  artifact.runId = "meta-other-run";
  await writeFile(file, JSON.stringify(artifact));
  assert.equal((await f.overview()).design.status, "not_registered", "a different run's artifact cannot be borrowed");
});

test("module pagination keeps global review capability and rejects a changed design cursor", async t => {
  const f = await fixture(t);
  const input = designInput({ full: true }); await f.publish(input); await f.vote("outline"); await f.vote("alpha");
  const service = createLiveWorkspaceService({ projectRoot: f.root, policy: { ...loadLiveWorkspacePolicy(), modulePageSize: 1 } });
  const page1 = await service.getOverview({ runId: f.runId });
  assert.equal(page1.design.modules.length, 1); assert.equal(page1.design.modules[0].status, "accepted");
  assert.equal(page1.capabilities.review.available, true, "capability is independent of this page's pending rows");
  const page2 = await service.getOverview({ runId: f.runId, cursor: page1.design.nextCursor });
  assert.equal(page2.design.modules[0].id, "beta"); assert.equal(page2.reviews.find(review => review.moduleId === "beta").available, true);
  input.design.softwareDesign.modules[0].implementationNotes += " A new version.";
  await f.publish(input);
  await assert.rejects(service.getOverview({ runId: f.runId, cursor: page1.design.nextCursor }), { code: "workspace_cursor_version_conflict" });
});

test("host claims reject an unpublished outline edit and invalidated dependency reviews but allow independent modules", async t => {
  const source = await fixture(t); const sourceInput = designInput();
  await writeFile(path.join(source.root, "outputs/outline.md"), "Bound outline\n");
  sourceInput.materialRefs = { outline: "outputs/outline.md" };
  await source.publish(sourceInput); const accepted = await source.vote("outline");
  await writeFile(path.join(source.root, "outputs/outline.md"), "Unpublished outline edit\n");
  await assert.rejects(source.service.claimRequest({ runId: source.runId, conversationId: CHAT,
    expectedRevision: (await source.overview()).revision, commandId: accepted.result.nextAction.commandId }), { code: "workspace_material_changed" });
  for (const dependent of [true, false]) {
    const f = await fixture(t); const input = designInput({ dependent });
    Object.assign(input.design.softwareDesign.modules[0], detailed("alpha"));
    await f.publish(input); await f.vote("outline"); const alpha = await f.vote("alpha");
    assert.equal(alpha.result.nextAction.moduleId, "beta");
    const before = await f.overview(), target = before.design.modules[0];
    await f.service.feedback({ runId: f.runId, moduleId: target.id, artifactId: target.artifactId, version: target.version,
      original: "Alpha needs a scoped correction", expectedWorkspaceRevision: before.revision, nonce: "scoped-alpha-feedback" });
    const claim = { runId: f.runId, conversationId: CHAT, expectedRevision: (await f.overview()).revision,
      commandId: alpha.result.nextAction.commandId };
    if (dependent) await assert.rejects(f.service.claimRequest(claim), { code: "workspace_dependency_review_required" });
    else assert.equal((await f.service.claimRequest(claim)).status, "host_claimed");
  }
});

test("all request history has bounded revision-bound pages and capacity refuses without dropping records", async t => {
  const f = await fixture(t); await f.publish(designInput()); await f.vote("outline");
  for (let index = 0; index < 34; index++) {
    const current = await f.overview(), module = current.design.modules[0];
    await f.service.feedback({ runId: f.runId, moduleId: module.id, artifactId: module.artifactId, version: module.version,
      original: `Private feedback original ${index}`, expectedWorkspaceRevision: current.revision, nonce: `history-feedback-${index}` });
  }
  const first = await f.service.getRequests({ runId: f.runId });
  assert.equal(first.requests.length, loadLiveWorkspacePolicy().requestPageSize);
  assert.equal(first.order, "newest_first"); assert.ok(first.nextCursor); assert.ok(first.total > 32);
  const second = await f.service.getRequests({ runId: f.runId, cursor: first.nextCursor });
  assert.equal(new Set([...first.requests, ...second.requests].map(request => request.commandId)).size, first.total);
  assert.equal(second.nextCursor, null);
  const baseArguments = [CLI, "--project-root", f.root, "--profile", "default", "--run-id", f.runId, "--conversation-id", CHAT];
  const inspectProcess = spawnSync(process.execPath, [...baseArguments, "--inspect"], { encoding: "utf8" });
  assert.equal(inspectProcess.status, 0, inspectProcess.stderr);
  const inspection = JSON.parse(inspectProcess.stdout);
  assert.equal(inspection.requestsTotal, first.total);
  assert.equal(inspection.requestsTruncated, true);
  assert.equal(inspection.requestsNextCursor, first.nextCursor);
  assert.deepEqual(inspection.requests.map(request => request.commandId), first.requests.map(request => request.commandId));
  const nextPageProcess = spawnSync(process.execPath, [inspection.boundedRequestRead.hostEntry, ...inspection.boundedRequestRead.arguments], { encoding: "utf8" });
  assert.equal(nextPageProcess.status, 0, nextPageProcess.stderr);
  const nextPage = JSON.parse(nextPageProcess.stdout);
  assert.deepEqual(nextPage, second);
  assert.ok([...inspection.requests, ...nextPage.requests].filter(request => request.kind === "apply_feedback")
    .every(request => request.status === "waiting_host" && request.completionVerified === false), "reading all pages never applies feedback");
  const oldest = second.requests.at(-1);
  const exactProcess = spawnSync(process.execPath, [...baseArguments, "--list-requests", "--command-id", oldest.commandId], { encoding: "utf8" });
  assert.equal(exactProcess.status, 0, exactProcess.stderr);
  assert.equal(JSON.parse(exactProcess.stdout).requests[0].commandId, oldest.commandId);
  const unboundArguments = [...baseArguments]; unboundArguments[unboundArguments.indexOf("--conversation-id") + 1] = "wrong-conversation";
  const unboundProcess = spawnSync(process.execPath, [...unboundArguments, "--list-requests"], { encoding: "utf8" });
  assert.equal(unboundProcess.status, 1);
  assert.equal(JSON.parse(unboundProcess.stderr).code, "workspace_host_scope_or_revision_conflict");
  assert.equal((await f.service.getRequests({ runId: f.runId, nonce: "history-feedback-0" })).total, 1);
  const before = await f.overview(), module = before.design.modules[0];
  const payload = { runId: f.runId, moduleId: module.id, artifactId: module.artifactId, version: module.version,
    original: "Preserve this after rejection", expectedWorkspaceRevision: before.revision, nonce: "history-newest-attempt" };
  const limited = createLiveWorkspaceService({ projectRoot: f.root, policy: { ...loadLiveWorkspacePolicy(), maxRequests: first.total } });
  await assert.rejects(limited.feedback(payload), { code: "workspace_request_capacity_reached" });
  assert.equal((await f.service.getRequests({ runId: f.runId })).total, first.total);
  await f.service.feedback(payload);
  await assert.rejects(f.service.getRequests({ runId: f.runId, cursor: first.nextCursor }), { code: "workspace_cursor_version_conflict" });
  const stalePageProcess = spawnSync(process.execPath, [inspection.boundedRequestRead.hostEntry, ...inspection.boundedRequestRead.arguments], { encoding: "utf8" });
  assert.equal(stalePageProcess.status, 1);
  assert.equal(JSON.parse(stalePageProcess.stderr).code, "workspace_cursor_version_conflict");
});

test("configured maximum normal module lifecycle fits request/state budgets and UTF-8 pages always progress", async t => {
  const policy = loadLiveWorkspacePolicy();
  assert.ok(policy.maxRequests >= 2 * policy.maxModules + 2);
  assert.throws(() => normalizeLiveWorkspacePolicy({ ...policy, materialPageBytes: 1 }), /Inconsistent/u);
  assert.throws(() => normalizeLiveWorkspacePolicy({ ...policy, materialPageBytes: 3 }), /Inconsistent/u);
  assert.throws(() => normalizeLiveWorkspacePolicy({ ...policy, maxRequests: 2 * policy.maxModules }), /Inconsistent/u);
  const f = await fixture(t), input = designInput({ full: true });
  input.design.softwareDesign.modules = Array.from({ length: policy.maxModules }, (_, index) => ({ id: `module-${index}`,
    purpose: `模块${index}保留用户输入并交付可核验结果`, ...detailed(`module-${index}`) }));
  input.design.softwareDesign.architecture.moduleIds = input.design.softwareDesign.modules.map(module => module.id);
  await f.publish(input);
  await f.vote("outline", "accept", "maximum-outline-review");
  // Budget proof only: construct the ordinary final record shape in memory.
  // No invented human answer is persisted and no model/worker is invoked.
  const workspace = JSON.parse(JSON.stringify((await readSpineState(f.root)).liveWorkspace));
  const at = new Date().toISOString();
  for (let index = 0; index < workspace.reviews.length; index++) {
    const review = workspace.reviews[index];
    if (!review.decision.hostAnswerClaim) review.decision = claimHostAnswer(review.decision, { at, claim: buildLocalReviewClaim(review.decision,
      { source: "live_local_review", requestRef: `request:${sha(`request-${index}`)}`, claimRef: `claim:${sha(`claim-${index}`)}`,
        issuedAt: review.issuedAt, expiresAt: review.expiresAt, claimedAt: at, selectedOptionId: "option:accept", answerDigest: `sha256:${sha(`answer-${index}`)}` }) });
    review.localReview = { source: "same_origin_live_ui", nonce: `maximum-budget-${index}`, inputDigest: sha(String(index)), consumedAt: at,
      nativeHostAuthenticated: false, executionAuthorized: false };
  }
  const example = workspace.requests[0];
  workspace.requests = Array.from({ length: 2 * policy.maxModules + 2 }, (_, index) => ({ ...example,
    commandId: `command:${sha(`command-${index}`).slice(0, 32)}`, nonce: `maximum-request-${index}`, inputDigest: sha(String(index)),
    ...(index % 2 ? { kind: "design_module", status: "host_reported", claim: { tokenSha256: sha(String(index)), conversationDigest: sha(CHAT), claimedAt: at, expiresAt: at },
      receiptDigest: sha(String(index)), receiptMaterial: { ref: workspace.designRef.ref, sha256: workspace.designRef.sha256, bytes: workspace.designRef.bytes, format: "json" },
      receipt: { evidenceLevel: "host_reported_files_verified", evidenceCount: 1, completionVerified: false, nativeInvocationVerified: false, publicReadyAuthority: false } } : {}) }));
  const bytes = Buffer.byteLength(JSON.stringify(workspace));
  assert.ok(bytes <= policy.maxWorkspaceStateBytes, `normal ${policy.maxModules}-module lifecycle needs ${bytes} bytes`);
  t.diagnostic(`normal lifecycle budget: modules=${policy.maxModules}, requests=${workspace.requests.length}, stateBytes=${bytes}, limit=${policy.maxWorkspaceStateBytes}; in-memory shape only`);
});

test("external dependency bytes invalidate only their consumers, including paged review visibility", async t => {
  const f = await fixture(t);
  const input = designInput({ full: true, dependent: true });
  input.design.softwareDesign.architecture.moduleIds.push("gamma", "independent");
  input.design.softwareDesign.modules.push({ id: "gamma", purpose: "Transitive consumer", dependsOn: ["beta"], ...detailed("gamma") },
    { id: "independent", purpose: "Unrelated output", ...detailed("independent") });
  input.materialRefs = { modules: { alpha: "outputs/alpha.md" } };
  await writeFile(path.join(f.root, "outputs/alpha.md"), "Actual registered interface v1\n");
  await f.publish(input); await f.vote("outline"); await f.vote("alpha"); await f.vote("beta");
  const before = await f.overview();
  const paged = createLiveWorkspaceService({ projectRoot: f.root, policy: { ...f.service.policy, modulePageSize: 1 } });
  let page = await paged.getOverview({ runId: f.runId });
  page = await paged.getOverview({ runId: f.runId, cursor: page.design.nextCursor });
  const gammaCursor = page.design.nextCursor;
  await writeFile(path.join(f.root, "outputs/alpha.md"), "Actual registered interface v2\n");
  page = await paged.getOverview({ runId: f.runId, cursor: gammaCursor });
  assert.equal(page.design.modules[0].id, "gamma");
  assert.equal(page.design.modules[0].status, "material_changed");
  assert.equal(page.reviews.find(review => review.moduleId === "gamma").available, false,
    "a source on an earlier page cannot leave its transitive consumer review enabled");
  const independent = await paged.getOverview({ runId: f.runId, cursor: page.design.nextCursor });
  assert.equal(independent.reviews.find(review => review.moduleId === "independent").available, true);
  await f.publish(input);
  const after = await f.overview();
  assert.equal(after.design.architecture.status, "accepted");
  assert.equal(after.design.modules[1].status, "awaiting_human", "external bytes invalidate accepted dependent review");
  assert.notEqual(after.design.modules[2].decisionId, before.design.modules[2].decisionId, "transitive review is renewed");
  assert.equal(after.design.modules[3].decisionId, before.design.modules[3].decisionId, "independent review is preserved");
});

test("continuing the governed run verifies every accepted module source before claim", async t => {
  const f = await fixture(t);
  const input = designInput({ full: true });
  input.materialRefs = { modules: { beta: "outputs/beta.md" } };
  await writeFile(path.join(f.root, "outputs/beta.md"), "Accepted module design\n");
  await f.publish(input); await f.vote("outline"); await f.vote("alpha");
  const accepted = await f.vote("beta");
  assert.equal(accepted.result.nextAction.kind, "continue_governed_run");
  const revision = (await f.overview()).revision;
  await writeFile(path.join(f.root, "outputs/beta.md"), "Unreviewed replacement\n");
  await assert.rejects(f.service.claimRequest({ runId: f.runId, conversationId: CHAT, expectedRevision: revision,
    commandId: accepted.result.nextAction.commandId }), { code: "workspace_material_changed" });
});

test("synthetic host CLI reads repository material, rejects foreign sessions, and recovers the exact file receipt", async t => {
  const f = await fixture(t);
  const cli = (args, { conversation = CHAT, runId = f.runId, success = true } = {}) => {
    const result = spawnSync(process.execPath, [CLI, "--project-root", f.root, "--profile", "default",
      "--run-id", runId, "--conversation-id", conversation, ...args], { encoding: "utf8" });
    assert.equal(result.status, success ? 0 : 1, result.stderr);
    return JSON.parse(success ? result.stdout : result.stderr);
  };
  const original = await readFile(path.join(REPO, "docs/live-workspace.md"), "utf8");
  await writeFile(path.join(f.root, "outputs/module.md"), original);
  const input = designInput({ full: true });
  input.materialRefs = { modules: { alpha: "outputs/module.md" } };
  await writeFile(path.join(f.root, ".meta-kim/work/design.json"), JSON.stringify(input));
  cli(["--publish-design", "--input", ".meta-kim/work/design.json", "--expected-revision", "0"]);
  await f.vote("outline");
  const before = await f.overview();
  const module = before.design.modules[0];
  const feedback = await f.service.feedback({ runId: f.runId, moduleId: module.id, artifactId: module.artifactId,
    version: module.version, original: "Extract the documented current-host CLI entrypoint as a repository-backed artifact.",
    expectedWorkspaceRevision: before.revision, nonce: "repository-material-feedback" });
  const inspect = cli(["--inspect"]);
  const claimArgs = ["--claim-request", "--command-id", feedback.commandId, "--expected-revision", String(inspect.revision)];
  assert.equal(cli(claimArgs, { conversation: "foreign-conversation", success: false }).code, "workspace_host_scope_or_revision_conflict");
  assert.equal(cli(["--inspect"], { runId: "foreign-run", success: false }).code, "workspace_current_run_unavailable");
  const claim = cli(claimArgs);
  assert.equal(claim.workOrder.targetId, "alpha");
  const bound = await readFile(path.join(f.root, claim.workOrder.material.ref), "utf8");
  assert.equal(sha(bound), sha(original));
  assert.match(bound, /scripts\/live-workspace-host\.mjs/u);
  // A real deterministic local transformation of repository text, with an
  // explicitly synthetic host identity; this does not certify a native model.
  const output = JSON.stringify({ sourceSha256: sha(bound), entrypoint: "scripts/live-workspace-host.mjs",
    source: "docs/live-workspace.md", recordOrigin: "acceptance_fixture" }) + "\n";
  await writeFile(path.join(f.root, "outputs/entrypoint.json"), output);
  const receipt = { outcome: "produced", summary: "Extracted and checked the repository-documented host entrypoint",
    evidenceRefs: [{ ref: "outputs/entrypoint.json", sha256: sha(output) }] };
  await writeFile(path.join(f.root, ".meta-kim/work/receipt.json"), JSON.stringify(receipt));
  const completeArgs = ["--complete-request", "--command-id", claim.commandId, "--claim-token", claim.claimToken,
    "--input", ".meta-kim/work/receipt.json", "--expected-revision", String(claim.revision)];
  assert.equal(cli(completeArgs, { conversation: "foreign-conversation", success: false }).code, "workspace_host_scope_or_revision_conflict");
  const returned = cli(completeArgs);
  assert.equal(returned.status, "host_reported"); assert.equal(returned.completionVerified, false);
  assert.equal(cli(completeArgs).replay, true, "a restarted CLI records the exact receipt without re-executing work");
  assert.equal(cli(["--claim-request", "--command-id", claim.commandId, "--expected-revision", String(returned.revision)],
    { success: false }).code, "workspace_request_not_claimable");
  const observed = cli(["--list-requests", "--command-id", claim.commandId]).requests[0];
  assert.deepEqual(observed.receipt.evidenceRefs, receipt.evidenceRefs);
  assert.equal(sha(await readFile(path.join(f.root, observed.receipt.ref))), observed.receipt.sha256);
  assert.equal(observed.receipt.nativeInvocationVerified, false);
  assert.equal((await f.overview()).requests.find(request => request.commandId === claim.commandId).receipt.sha256, observed.receipt.sha256);
});

test("a copied workspace cannot be consumed under another project authority", async t => {
  const f = await fixture(t);
  await f.publish(designInput());
  const state = await f.service.repository.readState();
  const copied = createLiveWorkspaceService({ repository: { ...f.service.repository, projectRoot: path.join(f.root, "another-project"),
    readState: async () => state } });
  await assert.rejects(copied.hostInspect({ runId: f.runId, conversationId: CHAT }), { code: "workspace_project_binding_conflict" });
  const wrongProfile = createLiveWorkspaceService({ repository: { ...f.service.repository, profile: "another-profile",
    readState: async () => state } });
  await assert.rejects(wrongProfile.hostInspect({ runId: f.runId, conversationId: CHAT }), { code: "workspace_project_binding_conflict" });
});

test("global readiness sees off-page sources and outline drift without erasing stored acceptance", async t => {
  const f = await fixture(t);
  const input = designInput({ full: true });
  input.materialRefs = { outline: "outputs/outline.md", modules: { beta: "outputs/beta.md" } };
  await writeFile(path.join(f.root, "outputs/outline.md"), "Original system outline\n");
  await writeFile(path.join(f.root, "outputs/beta.md"), "Original beta design\n");
  await f.publish(input); await f.vote("outline"); await f.vote("alpha"); await f.vote("beta");
  const paged = createLiveWorkspaceService({ projectRoot: f.root, policy: { ...f.service.policy, modulePageSize: 1 } });
  await writeFile(path.join(f.root, "outputs/beta.md"), "Changed off-page beta\n");
  let page = await paged.getOverview({ runId: f.runId });
  assert.equal(page.design.modules[0].id, "alpha");
  assert.equal(page.design.modules[0].status, "accepted", "independent visible module remains accepted");
  assert.equal(page.design.status, "material_changed");
  assert.equal(page.nextAction.kind, "refresh_design_material", "off-page drift cannot advertise continuation");
  const inspected = await f.service.hostInspect({ runId: f.runId, conversationId: CHAT });
  assert.equal(inspected.designStatus, "material_changed");
  assert.equal(inspected.nextAction.kind, "refresh_design_material", "host discovery receives the same current evidence as Live");
  await writeFile(path.join(f.root, "outputs/beta.md"), "Original beta design\n");
  await writeFile(path.join(f.root, "outputs/outline.md"), "Changed system outline\n");
  page = await paged.getOverview({ runId: f.runId });
  assert.equal(page.design.architecture.status, "material_changed");
  assert.equal(page.design.modules[0].status, "material_changed");
  assert.equal(page.nextAction.kind, "refresh_design_material");
  assert.ok(page.reviews.every(review => review.available === false));
  await writeFile(path.join(f.root, "outputs/outline.md"), "Original system outline\n");
  page = await paged.getOverview({ runId: f.runId });
  assert.equal(page.design.status, "accepted", "read-only drift projection does not destroy exact stored acceptance");
});

test("display polling caches stable file hashes while mutation verification stays fresh", async t => {
  const f = await fixture(t);
  const bytes = "large actual material\n".repeat(50000);
  await writeFile(path.join(f.root, "outputs/cache.md"), bytes);
  const material = await f.service.repository.putSource(f.runId, "outputs/cache.md", "markdown");
  assert.equal((await f.service.repository.verifyMaterialForDisplay(material)).cached, false);
  assert.equal((await f.service.repository.verifyMaterialForDisplay(material)).cached, true);
  assert.equal((await f.service.repository.verifyMaterial(material)).cached, undefined, "claim/review verification never uses display cache");
  // Same-length changes still change ctime/mtime identity and recheck content.
  await writeFile(path.join(f.root, "outputs/cache.md"), bytes.replace("large", "other"));
  await assert.rejects(f.service.repository.verifyMaterialForDisplay(material), { code: "workspace_material_changed" });
  await assert.rejects(f.service.repository.verifyMaterial(material), { code: "workspace_material_changed" });
  await writeFile(path.join(f.root, "outputs/cache.md"), bytes);
  assert.equal((await f.service.repository.verifyMaterialForDisplay(material)).sha256, sha(bytes));
});

test("host inspection projects one state snapshot and publishing cannot rebind copied reviews", async t => {
  const f = await fixture(t);
  await f.publish(designInput({ full: true }));
  const first = await f.service.repository.readState();
  const second = structuredClone(first);
  second.hostCheckpointRevision += 1;
  second.liveWorkspace.nextAction = { kind: "concurrent-new-action" };
  let reads = 0;
  const inspecting = createLiveWorkspaceService({ repository: { ...f.service.repository,
    readState: async () => ++reads === 1 ? first : second } });
  const result = await inspecting.hostInspect({ runId: f.runId, conversationId: CHAT });
  assert.equal(reads, 1, "revision, requests, and nextAction must use the same state snapshot");
  assert.equal(result.revision, first.hostCheckpointRevision);
  assert.deepEqual(result.nextAction, JSON.parse(JSON.stringify(first.liveWorkspace.nextAction)));
  let writes = 0;
  for (const mismatch of [{ projectRoot: path.join(f.root, "copied-project") }, { profile: "copied-profile" }]) {
    const copying = createLiveWorkspaceService({ repository: { ...f.service.repository, ...mismatch,
      readState: async () => first, writeState: async () => { writes += 1; } } });
    await assert.rejects(copying.publishDesign({ runId: f.runId, conversationId: CHAT,
      expectedRevision: first.hostCheckpointRevision, input: designInput({ full: true }) }), { code: "workspace_project_binding_conflict" });
  }
  assert.equal(writes, 0, "publishing cannot inherit foreign Decision records under a new project binding");
});

test("legacy accepted Decisions survive unchanged registration but never a dependency file change", async t => {
  const f = await fixture(t);
  const input = designInput({ full: true, dependent: true });
  input.materialRefs = { modules: { alpha: "outputs/legacy-alpha.md" } };
  await writeFile(path.join(f.root, "outputs/legacy-alpha.md"), "Registered legacy dependency\n");
  await f.publish(input);
  // Reproduce the exact v3.12 Decision contract without a git dependency in
  // packaged tests; actual baseline-source upgrade is also checked separately.
  const state = await f.service.repository.readState();
  const next = JSON.parse(JSON.stringify(state)), workspace = next.liveWorkspace;
  const stored = JSON.parse(await readFile(path.join(f.root, workspace.designRef.ref), "utf8"));
  for (const module of workspace.modules) {
    const structured = stored.softwareDesign.modules.find(item => item.id === module.id);
    const basisDigest = workspaceDigest([workspace.architecture.basisDigest, structured,
      (module.dependsOn || []).slice().sort().map(id => stored.softwareDesign.modules.find(item => item.id === id))]);
    const review = createWorkspaceReview({ runId: `${workspace.projectBinding}:${f.runId}`, targetId: module.id,
      moduleId: module.id, material: workspace.materials[module.artifactId], basisDigest,
      generation: workspace.generation, at: new Date().toISOString(), policy: f.service.policy });
    workspace.reviews = workspace.reviews.filter(item => item.decisionId !== module.decisionId);
    workspace.reviews.push(review); module.decisionId = review.decisionId;
  }
  await f.service.repository.writeState(state, next);
  await f.vote("outline"); await f.vote("alpha"); await f.vote("beta");
  const before = JSON.parse(JSON.stringify((await f.service.repository.readState()).liveWorkspace));
  await f.publish(input); await f.publish(input);
  const unchanged = JSON.parse(JSON.stringify((await f.service.repository.readState()).liveWorkspace));
  assert.equal(unchanged.designStatus, "accepted");
  for (const module of before.modules) {
    assert.equal(unchanged.modules.find(item => item.id === module.id).decisionId, module.decisionId);
    assert.deepEqual(unchanged.reviews.find(item => item.decisionId === module.decisionId),
      before.reviews.find(item => item.decisionId === module.decisionId), "preserve the actual old Decision, not a migrated artificial approval");
  }
  await writeFile(path.join(f.root, "outputs/legacy-alpha.md"), "Changed legacy dependency\n");
  await f.publish(input);
  const changed = await f.overview();
  assert.equal(changed.design.architecture.status, "accepted");
  assert.ok(changed.design.modules.every(module => module.status === "awaiting_human"));
  assert.ok(changed.design.modules.every(module => module.decisionId !== before.modules.find(item => item.id === module.id).decisionId));
});

function taskBoundDesign() {
  const input = designInput({ full: true });
  const criterionId = taskProgressGoal(critical).criteria[0].criterionId;
  input.design.taskSlices = ['alpha', 'beta'].map(id => ({ id: `task-${id}`, outcome: `Inspect ${id}`, scopeFiles: [`outputs/${id}.txt`],
    criterionIds: [criterionId], dependsOn: [], verification: [{ criterionId, procedure: `Read ${id}`, expectedEvidence: 'Actual file hash' }] }));
  for (const module of input.design.softwareDesign.modules) module.taskIds = [`task-${module.id}`];
  return input;
}

test('synthetic Live task contract change invalidates only affected module reviews', async t => {
  const f = await fixture(t), input = taskBoundDesign();
  await f.publish(input); await f.vote('outline'); await f.vote('alpha'); await f.vote('beta');
  const before = await f.overview();
  input.design.taskSlices[0].verification[0].procedure = 'Read bytes and validate actual identity';
  await f.publish(input);
  const after = await f.overview();
  assert.notEqual(after.design.modules[0].decisionId, before.design.modules[0].decisionId);
  assert.equal(after.design.modules[0].status, 'awaiting_human');
  assert.equal(after.design.modules[1].status, 'accepted');
});

test('synthetic Live gate binds proposed worker tasks to reviewed task dependencies and criteria', async t => {
  const f = await fixture(t), input = taskBoundDesign();
  input.design.taskSlices[1].dependsOn = ['task-alpha'];
  await f.publish(input); await f.vote('outline'); await f.vote('alpha'); await f.vote('beta');
  const state = await readSpineState(f.root);
  const packets = input.design.taskSlices.map(task => ({ taskPacketId: `worker-${task.id}`, roleInstanceId: task.id,
    acceptanceCriterionIds: task.criterionIds, progressBasisEvidence: [state.liveWorkspace.designRef], dependsOn: task.dependsOn.map(id => `worker-${id}`) }));
  const gate = workerTaskPackets => inspectLiveWorkspaceGate(state, f.root, { workerTaskPackets });
  assert.equal((await gate([])).ready, false);
  assert.equal((await gate(packets)).ready, true);
  assert.equal((await gate(packets.map(p => ({ ...p, progressBasisEvidence: [] })))).ready, false);
  assert.equal((await gate(packets.map(p => ({ ...p, dependsOn: [] })))).ready, false);
  assert.equal((await gate(packets.map(p => ({ ...p, acceptanceCriterionIds: [] })))).ready, false);
  assert.equal((await gate([...packets, { taskPacketId: 'unrelated', roleInstanceId: 'unrelated' }])).ready, false);
});

test('synthetic task-bound external material exposes reviewed contracts and preserves source drift checks', async t => {
  const f = await fixture(t), input = taskBoundDesign();
  input.design.taskSlices[1].dependsOn = ['task-alpha'];
  await writeFile(path.join(f.root, 'outputs/alpha.md'), '# Actual alpha source\n');
  input.materialRefs = { modules: { alpha: 'outputs/alpha.md' } };
  await f.publish(input);
  const view = await f.overview(), alpha = view.design.modules[0];
  const page = await f.service.getMaterial({ runId: f.runId, artifactId: alpha.artifactId, version: alpha.version });
  assert.match(page.text, /Actual alpha source/); assert.match(page.text, /Reviewed task contracts/); assert.match(page.text, /Read alpha/);
  assert.deepEqual(view.design.modules[1].dependsOn, ['alpha']);
  await f.vote('outline'); await f.vote('alpha'); await f.vote('beta');
  assert.equal((await inspectLiveWorkspaceGate(await readSpineState(f.root), f.root)).ready, true);
  input.design.taskSlices[0].scopeFiles = ['outputs/changed.txt'];
  await f.publish(input);
  const changed = await f.overview();
  assert.notEqual(changed.design.modules[0].version, alpha.version);
  assert.equal(changed.design.modules[1].status, 'awaiting_human');
  await f.vote('alpha'); await f.vote('beta');
  await writeFile(path.join(f.root, 'outputs/alpha.md'), '# Changed source\n');
  assert.equal((await inspectLiveWorkspaceGate(await readSpineState(f.root), f.root)).reason, 'live_design_material_changed');
});

test('synthetic task graph rejects duplicate identities and cycles before any registration', async t => {
  const f = await fixture(t), input = taskBoundDesign();
  input.design.taskSlices[1].id = input.design.taskSlices[0].id;
  await assert.rejects(f.publish(input), { code: 'workspace_task_identity_invalid' });
  const cyclic = taskBoundDesign();
  cyclic.design.taskSlices[0].dependsOn = ['task-beta']; cyclic.design.taskSlices[1].dependsOn = ['task-alpha'];
  await assert.rejects(f.publish(cyclic), { code: 'workspace_task_dependency_cycle' });
  assert.equal((await f.overview()).revision, 0);
});

test('synthetic legacy task reviews remain historical while only task modules request supplementary review', async t => {
  const f = await fixture(t), input = taskBoundDesign();
  input.design.taskSlices.pop(); input.design.softwareDesign.modules[1].taskIds = [];
  await f.publish(input); await f.vote('outline'); await f.vote('alpha'); await f.vote('beta');
  const state = await readSpineState(f.root), oldReviews = JSON.stringify(state.liveWorkspace.reviews);
  delete state.liveWorkspace.taskContractVersion;
  await f.service.repository.writeState(await readSpineState(f.root), state);
  const view = await f.overview();
  assert.equal(view.design.architecture.status, 'accepted');
  assert.equal(view.design.modules[0].status, 'material_changed');
  assert.equal(view.design.modules[1].status, 'accepted');
  assert.equal(view.nextAction.kind, 'refresh_design_material');
  assert.equal((await inspectLiveWorkspaceGate(state, f.root)).reason, 'live_design_task_review_required');
  assert.equal(JSON.stringify((await readSpineState(f.root)).liveWorkspace.reviews), oldReviews);
});


test('synthetic task verification rejects null and primitive checks with the workspace input error', async t => {
  const f = await fixture(t);
  for (const check of [null, false, 7, 'read file']) {
    const input = taskBoundDesign();
    input.design.taskSlices[0].verification = [check];
    await assert.rejects(f.publish(input), { code: 'workspace_task_contract_invalid', status: 400 });
  }
  assert.equal((await f.overview()).revision, 0);
});
