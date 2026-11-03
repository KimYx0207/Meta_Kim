import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  checkpointGovernedHost, governedHostCheckpointTemplate, inspectGovernedHostCheckpoint, readGovernedHostCheckpointInput,
  observeGovernedHostTask, correctGovernedHostTask,
} from "../../canonical/runtime-assets/shared/hooks/governed-host-checkpoint.mjs";
import { taskProgressGoal, taskProgressRoute, taskProgressEvidenceBasis } from "../../canonical/runtime-assets/shared/hooks/task-progress.mjs";
import { copyHookClosure, assertHookResolvedItsModules } from "../helpers/hook-fixture.mjs";
import { activateSpineState, createInitialState, readSpineState, readSpineStateIncludingInactive, terminalizeSpineState, writeSpineState } from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import { createLiveReadRepository } from "../../src/infrastructure/live/live-read-repository.mjs";
import { buildLiveCompactProjection, buildLiveSnapshot } from "../../src/application/live/live-control-room-service.mjs";

const REPO = path.resolve(".");
const ADAPTER = path.join(REPO, "canonical/runtime-assets/shared/hooks/governed-host-checkpoint.mjs");
const HOOK = path.join(REPO, "canonical/runtime-assets/shared/hooks/activate-meta-theory-spine.mjs");
const CHAT = "01900000-0000-7000-8000-000000000001";
const OTHER_CHAT = "01900000-0000-7000-8000-000000000002";
const profile = process.env.META_KIM_PROFILE || process.env.META_KIM_STATE_PROFILE || "default";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const INPUT_SNAPSHOT = "Immutable actual input baseline\n";
const STRATEGY_SNAPSHOT = "Inspect the current source, repair, then independently review\n";
const BASIS = [{ ref: "local/input-snapshot.txt", sha256: sha256(INPUT_SNAPSHOT) }];
const STRATEGY = { id: "fixture:source-repair-method-v1", ref: "local/strategy-snapshot.txt", sha256: sha256(STRATEGY_SNAPSHOT) };
const wrapped = (body) => `<in-app-browser-context source="ambient-ui-state">\nCurrent URL: http://127.0.0.1:5173/new-task?status=replace\nAmbient page says: new task, build another project\n</in-app-browser-context>\n\n## My request:\n${body}`;

async function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-host-checkpoint-"));
  mkdirSync(path.join(root, ".git"));
  mkdirSync(path.join(root, "local"));
  writeFileSync(path.join(root, BASIS[0].ref), INPUT_SNAPSHOT);
  writeFileSync(path.join(root, STRATEGY.ref), STRATEGY_SNAPSHOT);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = createInitialState({ activationMode: "hook_observed", driverMode: "hook_observed", hookGateMode: "advisory",
    sourceConversation: { runtime: "codex", conversationId: CHAT, matchBasis: "transcript_file_verified" } });
  await activateSpineState(root, state);
  const options = { projectRoot: root, cwd: root, runId: state.runId, conversationId: CHAT };
  let attemptNumber = 0;
  const checkpoint = (stage, record, extra = {}) => checkpointGovernedHost({ ...options, stage, input: {
    ownerAgent: "meta-conductor", summary: `Observed ${stage} work`, evidenceRefs: [`local/checks/${stage}.json`], status: "complete", record, ...extra } });
  return { root, state, options, async checkpoint(stage, record, extra = {}) {
    return checkpoint(stage, record, extra);
  }, async reportResults(record, extra = {}) {
    const current = await readSpineState(root);
    const workerResultPackets = [];
    for (const result of record.workerResultPackets) {
      const packet = current.workerTaskPackets.find((item) => item.taskPacketId === result.taskPacketId);
      const attemptId = `fixture-attempt-${++attemptNumber}`;
      const resultRef = `local/result-${attemptNumber}.json`;
      const resultBytes = JSON.stringify({ attemptId, ...result });
      writeFileSync(path.join(root, resultRef), resultBytes);
      const classification = result.resultStatus === "reported_complete" ? "progress" : result.resultStatus === "reported_failed" ? "ineffective" : "waiting";
      const progressObservations = [];
      for (const criterionId of packet.acceptanceCriterionIds) {
        const common = { attemptId, criterionId, basisEvidence: packet.progressBasisEvidence, evidenceRefs: [resultRef] };
        if (classification !== "waiting") {
          const inspected = await inspectGovernedHostCheckpoint(options);
          await observeGovernedHostTask({ ...options, input: { ownerAgent: "meta-conductor", summary: "Actual test worker starting", evidenceRefs: [resultRef],
            expectedRevision: inspected.expectedRevision, expectedStage: inspected.expectedStage, expectedStatus: inspected.expectedStatus,
            taskRef: inspected.taskReferences.find((item) => item.taskPacketId === packet.taskPacketId).publicTaskRef,
            progress: { ...common, classification: "running" } } });
        }
        progressObservations.push({ ...common, classification, resultRef, resultDigest: sha256(resultBytes),
          ...(classification === "progress" ? { criterionEvidence: [{ ref: resultRef, sha256: sha256(resultBytes) }] }
            : classification === "ineffective" ? { failureClass: "execution_failed" } : { waitReason: "Waiting on an actual resource" }) });
      }
      workerResultPackets.push({ ...result, progressObservations });
    }
    return checkpoint("execution", { ...record, workerResultPackets }, extra);
  } };
}

const critical = () => ({ realIntent: "Repair the actual user's governed execution", successCriteria: ["Task and owners are recorded against the same run"],
  nonGoals: ["No publication"], blockingUnknowns: [], noQuotaClarification: true });
const fetchRecord = () => ({ evidence: ["canonical/runtime-assets/shared/hooks/activate-meta-theory-spine.mjs"], decisionImpactMap: ["The host needs an execution handoff"],
  capabilityDiscovery: { sources: ["config/capability-index", "host tools"], matches: ["debugger", "runtime:apply_patch"] }, memoryStrategy: "Use targeted local context and preserve history" });
const thinking = () => ({ designFrame: "Reuse the existing spine authority", chosenRationale: "Small host adapter", consideredLanes: ["implementation", "review"],
  dependencyPolicy: "Disjoint files and one merge owner", reviewStandard: "Reproduce the actual entry and refuse synthetic proof", workerTaskPackets: [{
    taskPacketId: "task-host-entry", ownerAgent: "debugger", ownerSource: "host runtime inventory", roleDisplayName: "backend", roleInstanceId: "host-entry",
    scope: "Implement the host handoff", expectedOutput: "Adapter and regression tests", verification: "node --test", mergeOwner: "meta-conductor", weapon: "runtime:apply_patch", dependsOn: [],
    capabilityId: "runtime:source-repair", methodCapabilityId: "method:source-repair", strategyRef: STRATEGY,
    acceptanceCriterionIds: taskProgressGoal(critical()).criteria.map((criterion) => criterion.criterionId), progressBasisEvidence: BASIS,
  }] });

test("owner checkpoints advance exactly one stage on the same run and publish planned tasks without native proof", async (t) => {
  const f = await fixture(t);
  await f.checkpoint("critical", critical());
  assert.equal((await readSpineState(f.root)).currentStage, "fetch");
  await f.checkpoint("fetch", fetchRecord());
  await f.checkpoint("thinking", thinking());
  const state = await readSpineState(f.root);
  assert.equal(state.runId, f.state.runId);
  assert.equal(state.currentStage, "execution");
  assert.equal(state.hostCheckpointRevision, 3);
  assert.equal(state.workerTaskPackets[0].invocationState, "selected_not_invoked");
  assert.equal(state.workerLifecycle[0].status, "queued");
  assert.equal(state.workerLifecycle[0].terminalEvidence.length, 0);
  assert.equal(state.hostCheckpointSummary.evidenceLevel, "owner_reported");
  const status = JSON.parse(readFileSync(path.join(f.root, ".meta-kim/state", profile, "runs", state.runId, "status.json")));
  assert.equal(status.substanceClass, "substantive");
  assert.equal(status.workerTaskPackets[0].taskPacketId, "task-host-entry");
  assert.equal(status.publicReadyAuthority, false);
});

test("Critical publishes an owner-authored title through stopped envelope-only Live readback", async (t) => {
  const f = await fixture(t);
  const publicTitle = "让任务进度和结果一目了然";
  await f.checkpoint("critical", { ...critical(), publicTitle, realIntent: "PRIVATE ORIGINAL OBJECTIVE must remain outside public status" });
  const current = await readSpineState(f.root);
  assert.equal(current.publicSummary.title, publicTitle);
  assert.equal(current.criticalRecord.publicTitle, publicTitle);
  await f.checkpoint("fetch", fetchRecord()); await f.checkpoint("thinking", thinking());
  await terminalizeSpineState(f.root, { expectedRunId: f.state.runId, reason: "session_stop" });
  rmSync(path.join(f.root, ".meta-kim/state", profile, "spine", "spine-state.json"), { force: true });
  const durable = await createLiveReadRepository({ projectRoot: f.root, cwd: f.root, profile }).readDurableStatus();
  assert.equal(durable.publicSummary.title, publicTitle);
  assert.equal(durable.active, false);
  assert.doesNotMatch(JSON.stringify(durable), /PRIVATE ORIGINAL OBJECTIVE/u);
  assert.equal(Object.hasOwn(durable, "task"), false);
  const snapshot = buildLiveSnapshot({ durableStatus: durable, observedAt: new Date().toISOString() });
  assert.equal(snapshot.run.title, publicTitle);
  assert.equal(snapshot.run.task, publicTitle);
  assert.equal(snapshot.run.completionEvidenceState, "unproven");
  assert.equal(snapshot.counts.executionEvidence, 0);
  assert.equal(durable.publicReadyAuthority, false);
});

test("blank legacy Critical titles preserve existing public identity and missing titles are not inferred", async (t) => {
  assert.equal(governedHostCheckpointTemplate("critical").record.publicTitle, "");
  const f = await fixture(t);
  const initial = await readSpineState(f.root);
  initial.publicSummary = { title: "已有公开标题" };
  await writeSpineState(f.root, initial);
  await f.checkpoint("critical", { ...critical(), publicTitle: "   " }, { status: "in_progress" });
  assert.equal((await readSpineState(f.root)).publicSummary.title, initial.publicSummary.title);
  await f.checkpoint("critical", critical(), { status: "in_progress" });
  assert.equal((await readSpineState(f.root)).publicSummary.title, initial.publicSummary.title);
  const legacy = await fixture(t);
  await legacy.checkpoint("critical", critical());
  assert.equal((await readSpineState(legacy.root)).publicSummary, undefined);
});

test("invalid Critical public titles leave persisted state unchanged without reading accessors", async (t) => {
  const f = await fixture(t);
  await f.checkpoint("critical", { ...critical(), publicTitle: "保留此公开标题" }, { status: "in_progress" });
  const statePath = path.join(f.root, ".meta-kim/state", profile, "spine", "spine-state.json");
  const before = readFileSync(statePath, "utf8");
  for (const publicTitle of [null, undefined, 42, {}, [], true, "界".repeat(121), "标题\n不可换行", "标题\u0000不可控制", "\t"]) {
    await assert.rejects(f.checkpoint("critical", { ...critical(), publicTitle }), /critical_public_title_invalid/);
    assert.equal(readFileSync(statePath, "utf8"), before);
  }
  let reads = 0;
  const record = Object.defineProperty(critical(), "publicTitle", { enumerable: true, get() { reads += 1; return "不应被读取"; } });
  await assert.rejects(f.checkpoint("critical", record), /critical_public_title_invalid/);
  assert.equal(reads, 0);
  assert.equal(readFileSync(statePath, "utf8"), before);
});

test("only the winning Critical CAS may update a public title", async (t) => {
  const f = await fixture(t);
  await f.checkpoint("critical", { ...critical(), publicTitle: "原公开标题" }, { status: "in_progress" });
  const titles = ["并发标题甲", "并发标题乙"];
  const results = await Promise.allSettled(titles.map((publicTitle) => f.checkpoint("critical", { ...critical(), publicTitle })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const state = await readSpineState(f.root);
  assert.equal(state.publicSummary.title, titles[results.findIndex((result) => result.status === "fulfilled")]);
  assert.equal(state.currentStage, "fetch");
  assert.equal(state.hostCheckpointRevision, 2);
});

test("fresh host checkpoints keep an older active run current through the real Live repository and snapshot", async (t) => {
  const f = await fixture(t);
  const stale = await readSpineState(f.root);
  stale.triggeredAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  stale.stageRuntimeControl.createdAt = stale.triggeredAt;
  await writeSpineState(f.root, stale);
  await f.checkpoint("critical", critical()); await f.checkpoint("fetch", fetchRecord()); await f.checkpoint("thinking", thinking());
  const durable = await createLiveReadRepository({ projectRoot: f.root, cwd: f.root, profile }).readDurableStatus();
  assert.equal(durable.criticalRecord.realIntent, critical().realIntent);
  assert.equal(Object.hasOwn(durable, "task"), false, "the raw task-field privacy boundary remains intact");
  assert.equal(durable.ownerAgent, "meta-conductor");
  assert.equal(durable.updatedAt, durable.hostCheckpointSummary.recordedAt);
  const snapshot = buildLiveSnapshot({ durableStatus: durable, observedAt: new Date(Date.parse(durable.updatedAt) + 1000).toISOString() });
  assert.equal(snapshot.source.stale, false);
  assert.equal(snapshot.run.runId, f.state.runId);
  assert.equal(snapshot.run.active, true);
  assert.equal(snapshot.run.currentStage, "execution");
  assert.equal(snapshot.run.task, critical().realIntent);
  assert.ok(snapshot.nodes.some((node) => !node.isMain && node.ownerAgent === "debugger" && node.task === "Adapter and regression tests"));
  assert.equal(snapshot.nodes.some((node) => !node.isMain && node.ownerAgent === "debugger" && node.status === "in_doubt"), false);
  assert.equal(snapshot.nodes.find((node) => node.isMain)?.ownerAgent, "meta-conductor");
});

test("Live distinguishes exact owner-reported results from unstarted declarations and native completion", async (t) => {
  const f = await fixture(t);
  await f.checkpoint("critical", critical()); await f.checkpoint("fetch", fetchRecord()); await f.checkpoint("thinking", thinking());
  for (const resultStatus of ["reported_complete", "reported_failed", "reported_blocked"]) {
    await f.reportResults({ workerResultPackets: [{ taskPacketId: "task-host-entry", ownerAgent: "debugger", resultStatus,
      summary: `Actual owner report ${resultStatus}`, evidenceRefs: ["local/source-and-test-receipt.json"] }] }, { status: "in_progress" });
    const durable = await createLiveReadRepository({ projectRoot: f.root, cwd: f.root, profile }).readDurableStatus();
    const now = new Date(Date.parse(durable.updatedAt) + 1000).toISOString();
    const direct = buildLiveSnapshot({ durableStatus: durable, observedAt: now });
    const compact = buildLiveCompactProjection(durable);
    const reopened = buildLiveSnapshot({ governedArtifact: compact, observedAt: now });
    for (const snapshot of [direct, reopened]) {
      const worker = snapshot.nodes.find((node) => !node.isMain && node.ownerAgent === "debugger");
      assert.equal(worker.ownerReport.resultStatus, resultStatus);
      assert.equal(worker.status, "in_doubt");
      assert.equal(worker.executionState, "unreported");
      assert.equal(worker.declaredNotStarted, false);
      assert.equal(worker.statusReason, "负责人已回报，待独立验证。");
      assert.equal(worker.summary, `Actual owner report ${resultStatus}`);
      assert.equal(worker.terminalEvidence.length, 0);
      assert.equal(snapshot.run.completionEvidenceState, "unproven");
      assert.equal(snapshot.counts.executionEvidence, 0);
    }
    for (const mismatch of [{ runId: "meta-other" }, { taskPacketId: "different-task" }, { ownerAgent: "someone-else" }, { nativeInvocationVerified: true }]) {
      const wrong = structuredClone(durable);
      Object.assign(wrong.workerResultPackets[0], mismatch);
      const snapshot = buildLiveSnapshot({ durableStatus: wrong, observedAt: now });
      assert.equal(snapshot.nodes.some((node) => node.ownerReport), false);
      assert.equal(snapshot.run.completionEvidenceState, "unproven");
    }
  }
});

test("skips, stale runs, another chat, unverified chats and inactive runs cannot checkpoint", async (t) => {
  const f = await fixture(t);
  const input = { ownerAgent: "meta-conductor", summary: "summary", evidenceRefs: ["evidence"], status: "complete", record: critical() };
  for (const overrides of [{ stage: "thinking" }, { runId: "meta-old-run" }, { conversationId: OTHER_CHAT }]) {
    await assert.rejects(checkpointGovernedHost({ ...f.options, stage: "critical", input, ...overrides }), /checkpoint_/);
  }
  const state = await readSpineState(f.root);
  const unverified = { ...state, conversationLinkState: "unlinked" };
  delete unverified.sourceConversation;
  await writeSpineState(f.root, unverified);
  await assert.rejects(checkpointGovernedHost({ ...f.options, stage: "critical", input }), /conversation_binding/);
  await terminalizeSpineState(f.root, { expectedRunId: state.runId });
  await assert.rejects(checkpointGovernedHost({ ...f.options, stage: "critical", input }), /active_run_mismatch/);
});

test("current cwd wins over a requested different project", async (t) => {
  const f = await fixture(t);
  await assert.rejects(inspectGovernedHostCheckpoint({ ...f.options, cwd: REPO }), /project_root_binding_mismatch/);
});

test("unsettled critical questions and missing discovery never silently complete a stage", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.checkpoint("critical", { ...critical(), blockingUnknowns: ["Unresolved material scope"] }), /unsettled/);
  assert.equal((await readSpineState(f.root)).currentStage, "critical");
  await f.checkpoint("critical", critical());
  await assert.rejects(f.checkpoint("fetch", { ...fetchRecord(), capabilityDiscovery: { sources: [], matches: [] } }), /capability_discovery_missing/);
  assert.equal((await readSpineState(f.root)).currentStage, "fetch");
});

test("blocked checkpoint persists its owner report without advancing", async (t) => {
  const f = await fixture(t);
  await f.checkpoint("critical", { ...critical(), blockingUnknowns: ["Need actual permission"] }, { status: "blocked", summary: "Waiting for a material answer" });
  const state = await readSpineState(f.root);
  assert.equal(state.currentStage, "critical");
  assert.equal(state.blockedOn, "Waiting for a material answer");
  assert.equal(state.stages.critical.status, "in_progress");
});

test("empty blocked or in-progress records retain uncertainty without inventing capabilities or clearing workers", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.checkpoint("critical", {}), /field_required/);
  await f.checkpoint("critical", critical());
  await f.checkpoint("fetch", {}, { status: "blocked", summary: "No matching execution provider found yet" });
  const blocked = await readSpineState(f.root);
  assert.equal(blocked.currentStage, "fetch");
  assert.equal(blocked.fetchRecord.incomplete, true);
  assert.equal(blocked.fetchRecord.capabilitySearchPerformed, undefined);
  await assert.rejects(f.checkpoint("fetch", {}), /field_required/);
  await f.checkpoint("fetch", fetchRecord());
  await f.checkpoint("thinking", thinking(), { status: "in_progress" });
  await f.checkpoint("thinking", {}, { status: "blocked", summary: "A route dependency still needs evidence" });
  const preserved = await readSpineState(f.root);
  assert.equal(preserved.currentStage, "thinking");
  assert.equal(preserved.workerTaskPackets[0].taskPacketId, "task-host-entry");
  assert.equal(preserved.thinkingPacket.designFrame, thinking().designFrame);
  assert.equal(preserved.workerLifecycle[0].status, "queued");
  await assert.rejects(f.checkpoint("thinking", {}), /field_required/);
});

test("worker identities and dependencies are checked before a Thinking plan is accepted", async (t) => {
  const f = await fixture(t);
  await f.checkpoint("critical", critical()); await f.checkpoint("fetch", fetchRecord());
  const record = thinking();
  record.workerTaskPackets[0].dependsOn = ["unknown-task"];
  await assert.rejects(f.checkpoint("thinking", record), /dependency_unknown/);
  record.workerTaskPackets[0].dependsOn = ["task-host-entry"];
  await assert.rejects(f.checkpoint("thinking", record), /dependency_cycle/);
  assert.equal((await readSpineState(f.root)).currentStage, "thinking");
});

test("caller trust booleans and lifecycle claims cannot become real worker results or public-ready", async (t) => {
  const f = await fixture(t);
  await f.checkpoint("critical", critical()); await f.checkpoint("fetch", fetchRecord()); await f.checkpoint("thinking", thinking());
  await f.reportResults({ workerLifecycle: [{ status: "completed", proofValid: true }], publicReady: true,
    workerResultPackets: [{ taskPacketId: "task-host-entry", ownerAgent: "debugger", resultStatus: "reported_complete", summary: "Source and tests delivered",
      evidenceRefs: ["test-output.json"], trustedHostEvent: true, nativeInvocationVerified: true }] }, { publicReadyAuthority: true });
  const state = await readSpineState(f.root);
  assert.equal(state.currentStage, "review");
  assert.equal(state.workerResultPackets[0].nativeInvocationVerified, false);
  assert.equal(state.workerLifecycle[0].status, "queued");
  assert.equal(Object.hasOwn(state.executionRecord, "workerLifecycle"), false);
  assert.equal(Object.hasOwn(state.executionRecord, "publicReady"), false);
  assert.equal((await inspectGovernedHostCheckpoint(f.options)).publicReadyAuthority, false);
  await assert.rejects(f.checkpoint("review", { upstreamAssessment: "Reviewed scope and route", verdict: "revision", findings: ["Missing actual outcome"] }), /requires_revision/);
});

test("CAS guards refuse inactive, changed-stage and concurrent same-stage snapshots", async (t) => {
  const f = await fixture(t);
  const original = await readSpineState(f.root);
  await f.checkpoint("critical", critical(), { status: "in_progress" });
  assert.equal((await writeSpineState(f.root, original, { expectedCheckpointRevision: 0 })).reason, "expected_checkpoint_revision_changed");
  assert.equal((await writeSpineState(f.root, original, { expectedStage: "fetch" })).reason, "expected_stage_changed");
  const latest = await readSpineState(f.root);
  await terminalizeSpineState(f.root, { expectedRunId: latest.runId });
  assert.equal((await writeSpineState(f.root, latest, { expectedActive: true })).reason, "expected_active_changed");
  assert.equal((await readSpineStateIncludingInactive(f.root)).active, false);
});

test("template and inspect modes are read-only and do not initialize missing state", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-host-inspect-"));
  mkdirSync(path.join(root, ".git"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const template = spawnSync(process.execPath, [ADAPTER, "--template", "critical"], { cwd: root, encoding: "utf8" });
  assert.equal(template.status, 0, template.stderr);
  assert.deepEqual(JSON.parse(template.stdout), governedHostCheckpointTemplate("critical"));
  await assert.rejects(inspectGovernedHostCheckpoint({ projectRoot: root, cwd: root, runId: "meta-absent", conversationId: CHAT }), /active_run_mismatch/);
  assert.equal(existsSync(path.join(root, ".meta-kim")), false);
});

test("CLI accepts bounded stdin and project-local files and refuses oversized or redirected input", async (t) => {
  const f = await fixture(t);
  const input = { ownerAgent: "meta-conductor", summary: "Goal and standards checked", evidenceRefs: ["AGENTS.md"], status: "complete", record: critical() };
  const args = [ADAPTER, "--project-root", f.root, "--run-id", f.state.runId, "--conversation-id", CHAT, "--stage", "critical", "--input", "-"];
  const applied = spawnSync(process.execPath, args, { cwd: f.root, encoding: "utf8", input: JSON.stringify(input) });
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).currentStage, "fetch");
  const file = path.join(f.root, "checkpoint.json");
  writeFileSync(file, JSON.stringify(input));
  assert.deepEqual(readGovernedHostCheckpointInput(file, f.root), input);
  assert.throws(() => readGovernedHostCheckpointInput("../outside.json", f.root), /outside_project/);
  writeFileSync(file, " ".repeat(65537));
  assert.throws(() => readGovernedHostCheckpointInput(file, f.root), /too_large/);
  const huge = spawnSync(process.execPath, args, { cwd: f.root, encoding: "utf8", input: " ".repeat(65537) });
  assert.notEqual(huge.status, 0);
  assert.match(huge.stderr, /too_large/);
  const link = path.join(f.root, "redirect.json");
  try { symlinkSync(file, link); } catch (error) { if (error.code === "EPERM") return; throw error; }
  assert.throws(() => readGovernedHostCheckpointInput(link, f.root), /redirected/);
});

test("a natural-language entry always hands the current run to its host, even with Live disabled", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-host-entry-"));
  mkdirSync(path.join(root, ".git"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const transcript = path.join(root, CHAT + ".jsonl");
  writeFileSync(transcript, "{}\n");
  const invoke = (prompt, chat = CHAT) => spawnSync(process.execPath, [HOOK, "--runtime", "codex", "--package-root", REPO], {
    cwd: root, encoding: "utf8", input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt, session_id: chat, transcript_path: chat === CHAT ? transcript : path.join(root, OTHER_CHAT + ".jsonl") }),
    env: { ...process.env, META_KIM_POST_COPY_AUTO: "off", META_KIM_LIVE_AUTO: "off" },
  });
  const first = invoke("帮我修复Hook代码并运行测试");
  assert.equal(first.status, 0, first.stderr);
  const context = JSON.parse(first.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /后台执行接续/); assert.match(context, /governed-host-checkpoint\.mjs/);
  assert.match(context, /--run-id/); assert.match(context, /--conversation-id/); assert.match(context, /立即读取并应用已安装技能/);
  assert.match(context, /owner_reported/); assert.doesNotMatch(context, /Meta_Kim Live/);
});

test("verified same-chat continuation, status and additional constraints keep a checkpointed run", async (t) => {
  const f = await fixture(t);
  await f.checkpoint("critical", critical());
  const transcript = path.join(f.root, CHAT + ".jsonl"); writeFileSync(transcript, "{}\n");
  const stop = spawnSync(process.execPath, [path.join(REPO, "canonical/runtime-assets/shared/hooks/stop-spine-cleanup.mjs")], {
    cwd: f.root, encoding: "utf8", input: JSON.stringify({ hook_event_name: "Stop", runtime: "codex", session_id: CHAT, transcript_path: transcript }),
    env: { ...process.env, META_KIM_HOOK_RUNTIME: "codex" },
  });
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal((await readSpineState(f.root)).active, true, "an ordinary turn Stop preserves the unfinished checkpointed run");
  const invoke = (prompt, chat = CHAT) => spawnSync(process.execPath, [HOOK, "--runtime", "codex", "--package-root", REPO], {
    cwd: f.root, encoding: "utf8", input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt, session_id: chat, transcript_path: path.join(f.root, chat + ".jsonl") }),
    env: { ...process.env, META_KIM_POST_COPY_AUTO: "off", META_KIM_LIVE_AUTO: "off" },
  });
  for (const prompt of ["继续修复并验证", "现在进度到哪了？", "进度怎么样", "现在怎么样", "你自己修啊", "补充条件：不要改数字人业务",
    "那你都修复好了吗？修复好了以后提交推送gitGitHub了吗", "我要的是修好呀，你得先仔细分析问题，然后帮我修复呀", "hookprompt没有在对话里显示呢 感觉不对啊"] ) {
    const result = invoke(prompt);
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, new RegExp(f.state.runId));
    const current = await readSpineState(f.root);
    assert.equal(current.runId, f.state.runId); assert.equal(current.currentStage, "fetch");
    assert.equal(current.hostCheckpointRevision, 1); assert.equal(current.lastUserSteering.kind, "same_conversation_followup");
  }
  const rawContinuation = invoke("继续修复");
  assert.equal(rawContinuation.status, 0, rawContinuation.stderr);
  const rawFingerprint = (await readSpineState(f.root)).lastUserSteering.taskFingerprint;
  for (const body of ["继续修复", "进度怎么样"]) {
    const result = invoke(wrapped(body));
    assert.equal(result.status, 0, result.stderr);
    const current = await readSpineState(f.root);
    assert.equal(current.runId, f.state.runId); assert.equal(current.currentStage, "fetch");
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, new RegExp(f.state.runId));
    if (body === "继续修复") assert.equal(current.lastUserSteering.taskFingerprint, rawFingerprint, "ambient URLs do not change task identity");
  }
  writeFileSync(path.join(f.root, OTHER_CHAT + ".jsonl"), "{}\n");
  const other = invoke("现在进度到哪了？", OTHER_CHAT);
  assert.equal(other.status, 0, other.stderr); assert.equal(other.stdout.trim(), "");
  const query = invoke("状态机是什么意思？");
  assert.equal(query.status, 0, query.stderr); assert.equal(query.stdout.trim(), "");
  const wrappedQuery = invoke(wrapped("状态机是什么意思？"));
  assert.equal(wrappedQuery.status, 0, wrappedQuery.stderr); assert.equal(wrappedQuery.stdout.trim(), "");
  const wrappedOther = invoke(wrapped("继续修复"), OTHER_CHAT);
  assert.equal(wrappedOther.status, 0, wrappedOther.stderr); assert.equal(wrappedOther.stdout.trim(), "");
  const switched = invoke(wrapped("新任务：帮我实现网站登录并验证"));
  assert.equal(switched.status, 0, switched.stderr);
  assert.notEqual((await readSpineState(f.root)).runId, f.state.runId);
});

test("protected attempts survive readback, reject status laundering, and require scoped reviewed correction", async (t) => {
  const f = await fixture(t);
  await f.checkpoint("critical", critical()); await f.checkpoint("fetch", fetchRecord());
  const plan = thinking();
  plan.workerTaskPackets.push({ ...plan.workerTaskPackets[0], taskPacketId: "independent-task", roleInstanceId: "independent" });
  await f.checkpoint("thinking", plan);
  const result = (taskPacketId, resultStatus) => ({ taskPacketId, ownerAgent: "debugger", resultStatus, summary: "Actual result", evidenceRefs: ["local/result.json"] });
  await f.reportResults({ workerResultPackets: [result("independent-task", "reported_complete")] }, { status: "in_progress" });
  const independent = (await readSpineState(f.root)).workerResultPackets.find((entry) => entry.taskPacketId === "independent-task");
  await f.reportResults({ workerResultPackets: [result("task-host-entry", "reported_blocked")] }, { status: "in_progress" });
  const before = await inspectGovernedHostCheckpoint(f.options);
  assert.equal(before.taskReferences.find((entry) => entry.taskPacketId === "task-host-entry").progress.terminalAttempts, 0);
  await assert.rejects(f.checkpoint("execution", { workerResultPackets: [{ ...result("task-host-entry", "reported_failed"), progress: {
    classification: "progress", criterionId: before.goalCriteria[0].criterionId, attemptId: "made-up", basisEvidence: BASIS, evidenceRefs: ["x"],
  } }] }, { status: "in_progress" }), /result_status_mismatch/);
  for (let attempt = 0; attempt < 2; attempt += 1) await f.reportResults({ workerResultPackets: [result("task-host-entry", "reported_failed")] }, { status: "in_progress" });
  const reopened = await inspectGovernedHostCheckpoint({ ...f.options });
  const target = reopened.taskReferences.find((entry) => entry.taskPacketId === "task-host-entry");
  assert.equal(target.progress.terminalAttempts, 2);
  assert.equal(target.progress.pendingCorrections.length, 1);
  assert.equal(target.progress.nativeInvocationVerified, false);
  const persisted = await readSpineState(f.root);
  const previous = persisted.workerTaskPackets.find((entry) => entry.taskPacketId === "task-host-entry");
  const strategyBytes = "Use the existing recovered data, compare artifacts, then reroute\n";
  writeFileSync(path.join(f.root, "local/strategy-v2.txt"), strategyBytes);
  const replacement = { ...previous, taskPacketId: "task-host-replanned", replacesTaskPacketId: previous.taskPacketId,
    strategyRef: { ...previous.strategyRef, ref: "local/strategy-v2.txt", sha256: sha256(strategyBytes) } };
  const request = { ownerAgent: "meta-conductor", summary: "Thinking selected a reviewed changed method", evidenceRefs: ["local/strategy-v2.txt"],
    expectedRevision: reopened.expectedRevision, expectedStage: reopened.expectedStage, expectedStatus: reopened.expectedStatus,
    taskRef: target.publicTaskRef, rationale: "The old route repeated without evidence gains", basisEvidence: BASIS, replacement };
  await assert.rejects(correctGovernedHostTask({ ...f.options, input: request }), /evidence_invalid/);
  const decision = { schemaVersion: 1, kind: "task_progress_correction_review", verdict: "approved", producer: "meta-conductor", reviewer: "code-reviewer",
    rationale: "Compared the actual unchanged failures with the new method", goalDigest: target.progress.goalDigest,
    taskPacketId: previous.taskPacketId, logicalTaskPacketId: previous.taskPacketId, replacementTaskPacketId: replacement.taskPacketId,
    triggerEventIds: target.progress.pendingCorrections.map((entry) => entry.triggerEventId), routeDigest: taskProgressRoute(replacement),
    evidenceBasisDigest: taskProgressEvidenceBasis(BASIS) };
  const decisionBytes = JSON.stringify(decision);
  writeFileSync(path.join(f.root, "local/correction-review.json"), decisionBytes);
  request.decisionRef = { ref: "local/correction-review.json", sha256: sha256(decisionBytes) };
  const corrected = await correctGovernedHostTask({ ...f.options, input: request });
  assert.equal(corrected.currentStage, "execution");
  const after = await readSpineState(f.root);
  assert.deepEqual(after.workerResultPackets.find((entry) => entry.taskPacketId === "independent-task"), independent);
  assert.equal(after.workerTaskPackets.some((entry) => entry.taskPacketId === previous.taskPacketId), false);
  assert.equal(after.taskProgressLedger.corrections[0].reviewedDecision.sha256, request.decisionRef.sha256);
  assert.equal(after.taskProgressLedger.corrections[0].reviewedDecision.nativeInvocationVerified, false);
  assert.equal((await inspectGovernedHostCheckpoint(f.options)).taskReferences.find((entry) => entry.taskPacketId === replacement.taskPacketId).progress.pendingCorrections.length, 0);
  await assert.rejects(correctGovernedHostTask({ ...f.options, input: request }), /revision_conflict/);
});

test("duplicate criteria are refused and a partial multi-criterion result cannot complete execution", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.checkpoint("critical", { ...critical(), successCriteria: ["same criterion", " same criterion "] }), /duplicate_goal_criterion/);
  const criteria = ["Target date is updated", "Existing user data remains intact"];
  await f.checkpoint("critical", { ...critical(), successCriteria: criteria });
  await f.checkpoint("fetch", fetchRecord());
  const plan = thinking();
  plan.workerTaskPackets[0].acceptanceCriterionIds = taskProgressGoal({ ...critical(), successCriteria: criteria }).criteria.map((entry) => entry.criterionId);
  await f.checkpoint("thinking", plan);
  const inspected = await inspectGovernedHostCheckpoint(f.options);
  const packet = (await readSpineState(f.root)).workerTaskPackets[0];
  const resultRef = "local/current-result.json";
  const bytes = "Actual evidence for the first criterion only\n";
  writeFileSync(path.join(f.root, resultRef), bytes);
  const common = { attemptId: "multi-actual", criterionId: packet.acceptanceCriterionIds[0], basisEvidence: BASIS, evidenceRefs: [resultRef] };
  await observeGovernedHostTask({ ...f.options, input: { ownerAgent: "meta-conductor", summary: "One real task starting", evidenceRefs: [resultRef],
    expectedRevision: inspected.expectedRevision, expectedStage: inspected.expectedStage, expectedStatus: inspected.expectedStatus,
    taskRef: inspected.taskReferences[0].publicTaskRef, progress: { ...common, classification: "running" } } });
  const observation = { ...common, classification: "progress", resultRef, resultDigest: sha256(bytes), criterionEvidence: [{ ref: resultRef, sha256: sha256(bytes) }] };
  const terminalResult = { taskPacketId: packet.taskPacketId, ownerAgent: packet.ownerAgent, resultStatus: "reported_complete",
    summary: "Only the first criterion is evidenced", evidenceRefs: [resultRef], progressObservations: [observation] };
  await assert.rejects(f.checkpoint("execution", { workerResultPackets: [{ ...terminalResult, progressObservations: [observation, observation] }] }), /duplicate_or_mixed_attempt/);
  const partial = await f.checkpoint("execution", { workerResultPackets: [terminalResult] });
  assert.deepEqual(partial.incompleteTaskCriteria, [packet.taskPacketId]);
  assert.equal((await readSpineState(f.root)).currentStage, "execution");
  await assert.rejects(f.checkpoint("execution", { workerResultPackets: [{ ...terminalResult, progressObservations: [{ ...observation, classification: "ineffective", failureClass: "criterion_not_met" }] }] }), /attempt_conflict/);
});

test("correcting A preserves independent C and holds dependent B until fresh prerequisite results", async (t) => {
  const f = await fixture(t);
  await f.checkpoint("critical", critical()); await f.checkpoint("fetch", fetchRecord());
  const plan = thinking();
  plan.workerTaskPackets.push({ ...plan.workerTaskPackets[0], taskPacketId: "dependent-b", roleInstanceId: "dependent-b", dependsOn: ["task-host-entry"] },
    { ...plan.workerTaskPackets[0], taskPacketId: "independent-c", roleInstanceId: "independent-c" });
  await f.checkpoint("thinking", plan);
  const result = (taskPacketId, resultStatus) => ({ taskPacketId, ownerAgent: "debugger", resultStatus, summary: `Actual ${taskPacketId} result`, evidenceRefs: ["local/report.json"] });
  await f.reportResults({ workerResultPackets: [result("task-host-entry", "reported_complete")] }, { status: "in_progress" });
  await f.reportResults({ workerResultPackets: [result("dependent-b", "reported_failed")] }, { status: "in_progress" });
  for (let index = 0; index < 2; index += 1) await f.reportResults({ workerResultPackets: [result("task-host-entry", "reported_failed")] }, { status: "in_progress" });
  let inspected = await inspectGovernedHostCheckpoint(f.options);
  const bRef = inspected.taskReferences.find((entry) => entry.taskPacketId === "dependent-b").publicTaskRef;
  const bCriterion = inspected.goalCriteria[0].criterionId;
  const bStart = { attemptId: "b-original-in-flight", criterionId: bCriterion, classification: "running", basisEvidence: BASIS, evidenceRefs: [BASIS[0].ref] };
  const cas = (view) => ({ expectedRevision: view.expectedRevision, expectedStage: view.expectedStage, expectedStatus: view.expectedStatus });
  await observeGovernedHostTask({ ...f.options, input: { ownerAgent: "meta-conductor", summary: "Original B attempt is in flight", evidenceRefs: [BASIS[0].ref],
    ...cas(inspected), taskRef: bRef, progress: bStart } });
  const original = await readSpineState(f.root);
  const a = original.workerTaskPackets.find((entry) => entry.taskPacketId === "task-host-entry");
  const newStrategyBytes = "Compare a different implementation before the next original-owner action\n";
  writeFileSync(path.join(f.root, "local/a-new-method.txt"), newStrategyBytes);
  const replacement = { ...a, taskPacketId: "a-replanned", replacesTaskPacketId: a.taskPacketId,
    strategyRef: { ...a.strategyRef, ref: "local/a-new-method.txt", sha256: sha256(newStrategyBytes) } };
  const aProgress = inspected.taskReferences.find((entry) => entry.taskPacketId === a.taskPacketId).progress;
  const decision = { schemaVersion: 1, kind: "task_progress_correction_review", verdict: "approved", producer: "meta-conductor", reviewer: "code-reviewer",
    rationale: "Only A changes; preserve independent work and B's original invocation", goalDigest: aProgress.goalDigest,
    taskPacketId: a.taskPacketId, logicalTaskPacketId: a.taskPacketId, replacementTaskPacketId: replacement.taskPacketId,
    triggerEventIds: aProgress.pendingCorrections.map((entry) => entry.triggerEventId), routeDigest: taskProgressRoute(replacement), evidenceBasisDigest: taskProgressEvidenceBasis(BASIS) };
  const reviewBytes = JSON.stringify(decision);
  writeFileSync(path.join(f.root, "local/a-review.json"), reviewBytes);
  const correction = async () => {
    const current = await inspectGovernedHostCheckpoint(f.options);
    return correctGovernedHostTask({ ...f.options, input: { ownerAgent: "meta-conductor", summary: "Apply the reviewed A correction", evidenceRefs: ["local/a-review.json"],
      ...cas(current), taskRef: current.taskReferences.find((entry) => entry.taskPacketId === a.taskPacketId).publicTaskRef,
      rationale: decision.rationale, basisEvidence: BASIS, replacement, decisionRef: { ref: "local/a-review.json", sha256: sha256(reviewBytes) } } });
  };
  await assert.rejects(correction(), /correction_waits_for_affected_active_attempt/);
  assert.equal((await readSpineState(f.root)).taskProgressLedger.observations.find((entry) => entry.attemptId === bStart.attemptId).classification, "running");
  await f.reportResults({ workerResultPackets: [result("independent-c", "reported_complete")] }, { status: "in_progress" });
  const cBefore = await readSpineState(f.root);
  const cPacket = cBefore.workerTaskPackets.find((entry) => entry.taskPacketId === "independent-c");
  const cResult = cBefore.workerResultPackets.find((entry) => entry.taskPacketId === "independent-c");
  const unknownBytes = "The original B invocation reached its unknown transport boundary\n";
  writeFileSync(path.join(f.root, "local/b-unknown.txt"), unknownBytes);
  await f.checkpoint("execution", { workerResultPackets: [{ ...result("dependent-b", "reported_failed"), progressObservations: [{ ...bStart,
    classification: "unresolved", resultRef: "local/b-unknown.txt", resultDigest: sha256(unknownBytes), evidenceRefs: ["local/b-unknown.txt"], waitReason: "Actual original transport ended unknown" }] }] }, { status: "in_progress" });
  await correction();
  inspected = await inspectGovernedHostCheckpoint(f.options);
  let b = inspected.taskReferences.find((entry) => entry.taskPacketId === "dependent-b");
  assert.equal(b.dependencyReadiness.ready, false);
  assert.deepEqual(b.dependencyReadiness.blockedTaskIds, [replacement.taskPacketId]);
  assert.equal(b.progress.ineffectiveAttempts, 0);
  assert.equal(b.progress.counterScope, "current_dependency_context");
  assert.notEqual(b.progress.contextId, "initial");
  await assert.rejects(observeGovernedHostTask({ ...f.options, input: { ownerAgent: "meta-conductor", summary: "B must wait", evidenceRefs: [BASIS[0].ref],
    ...cas(inspected), taskRef: b.publicTaskRef, progress: { ...bStart, attemptId: "must-not-start-b" } } }), /dependency_stale:a-replanned/);
  const hookDir = path.join(f.root, "local/hooks");
  mkdirSync(hookDir);
  copyHookClosure(REPO, hookDir, ["enforce-agent-dispatch.mjs"]);
  const gate = spawnSync(process.execPath, [path.join(hookDir, "enforce-agent-dispatch.mjs")], {
    cwd: f.root, encoding: "utf8", input: JSON.stringify({ tool_name: "Write", tool_input: { taskPacketId: "dependent-b", file_path: "local/unused.txt", content: "not executed" } }),
    env: { ...process.env, META_KIM_CAPABILITY_GATE: "block" } });
  assertHookResolvedItsModules(gate, "enforce-agent-dispatch");
  assert.match(gate.stdout + gate.stderr, /Task progress dependency wait/);
  const after = await readSpineState(f.root);
  assert.deepEqual(after.workerTaskPackets.find((entry) => entry.taskPacketId === "independent-c"), cPacket);
  assert.deepEqual(after.workerResultPackets.find((entry) => entry.taskPacketId === "independent-c"), cResult);
  assert.equal(after.taskProgressLedger.observations.filter((entry) => entry.taskPacketId === "dependent-b").length, 2);
  await f.reportResults({ workerResultPackets: [result(replacement.taskPacketId, "reported_complete")] }, { status: "in_progress" });
  b = (await inspectGovernedHostCheckpoint(f.options)).taskReferences.find((entry) => entry.taskPacketId === "dependent-b");
  assert.equal(b.dependencyReadiness.ready, true);
  await f.reportResults({ workerResultPackets: [result("dependent-b", "reported_failed")] }, { status: "in_progress" });
  b = (await inspectGovernedHostCheckpoint(f.options)).taskReferences.find((entry) => entry.taskPacketId === "dependent-b");
  assert.equal(b.progress.ineffectiveAttempts, 1);
  assert.equal(b.progress.sameBasisIneffectiveCount, 1);
  assert.equal(b.progress.pendingCorrections.length, 0);
  assert.equal((await readSpineState(f.root)).taskProgressLedger.observations.filter((entry) => entry.taskPacketId === "dependent-b").length, 3);
});
