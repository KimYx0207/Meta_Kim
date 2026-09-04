import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runMetaTheoryGovernedExecution } from "../../scripts/run-meta-theory-governed-execution.mjs";

test("formal governed entrypoint records a synthetic bridge result without claiming native execution", async (t) => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-p117-governed-test-"));
  t.after(async () => fs.rm(outputRoot, { recursive: true, force: true }));
  const task = "Run meta-theory: inspect package.json and produce a durable verification report of the exact package name and version. Do not modify files.";
  const prompts = [];
  const report = await runMetaTheoryGovernedExecution({
    task,
    runId: "p117-governed-entry-test",
    runtime: "codex",
    osTarget: "windows",
    stateDir: outputRoot,
    artifactDir: outputRoot,
    dbPath: path.join(outputRoot, "runs.sqlite"),
    projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
    emitConversationNotice: false,
    stageRunner: {
      enabled: true,
      runtime: "codex",
      durableMode: "fresh",
      durableDbPath: path.join(outputRoot, "durable-runs.sqlite"),
      capacity: 1,
      timeoutMs: 30_000,
      evidenceKind: "governed_entry_test_double",
      invokeWorker: async ({ runtime, prompt, packet }) => {
        prompts.push(prompt);
        return {
          status: "pass",
          runtime,
          exitCode: 0,
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: 5,
          sessionId: `session-${packet.taskPacketId}`,
          messageId: `message-${packet.taskPacketId}`,
          outputText: "meta-kim 2.9.0",
          outputSha256: "a".repeat(64),
          rawOutputSha256: "b".repeat(64),
          hostEventCount: 1,
          toolEventCount: 1,
          stderrTail: "",
        };
      },
    },
  });
  assert.equal(report.stageRunnerBridgePacket.status, "pass");
  assert.equal(report.stageRunnerBridgePacket.executionProjection.durable.enabled, true);
  assert.equal(report.stageRunnerBridgePacket.executionProjection.durable.resumed, false);
  assert.equal(
    report.stageRunnerBridgePacket.executionProjection.invocationTruth.bridgeCallbackCompleted,
    true,
  );
  assert.equal(
    report.stageRunnerBridgePacket.executionProjection.invocationTruth.nativeRuntimeInvoked,
    false,
  );
  assert.ok(report.stageRunnerBridgePacket.stageDagPacket.nodes
    .filter((node) => node.stage === "Execution" && node.laneKind === "execution_worker")
    .every((node) => node.effectClass === "read_only_worker"));
  assert.equal(report.durableExecution.mode, "fresh");
  assert.equal(report.durableExecution.status, "materialized");
  assert.equal(report.durableExecution.fenceToken, 1);
  assert.ok(Number.isInteger(report.durableExecution.cursor));
  assert.ok(report.durableExecution.headCheckpointId);
  assert.equal(JSON.stringify(report.durableExecution).includes(outputRoot), false);
  assert.equal((await fs.stat(path.join(outputRoot, "p117-governed-entry-test.reservation.json"))).isFile(), true);
  assert.equal((await fs.stat(path.join(outputRoot, "durable-runs.sqlite"))).isFile(), true);
  assert.equal(report.executionResult.actualWorkerExecution, false);
  assert.ok(report.executionResult.workerExecutionEvidence.every(
    (item) =>
      item.status === "executed" &&
      item.liveWorkerExecution === false &&
      item.runtimeProcessInvoked === false,
  ));
  assert.equal(report.langGraphRunPacket.runtimeExecutionEvidence, "synthetic_stage_runner_bridge");
  assert.ok(report.traceEvalControlPlane.stageTiming.find(
    (item) => item.stage === "Execution",
  ).observedDurationMs > 0);
  assert.ok(prompts.length > 0);
  assert.ok(prompts.every((prompt) => prompt.includes(`Original user task: ${task}`)));
});

function stageStatuses(stages) {
  return Object.fromEntries(Object.entries(stages).map(([stage, value]) => [stage, value.status]));
}

async function governedRunnerSpineFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-runner-spine-project-"));
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-runner-spine-output-"));
  t.after(async () => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(outputRoot, { recursive: true, force: true }),
  ]));
  const spine = await import("../../canonical/runtime-assets/shared/hooks/spine-state.mjs");
  return { root, outputRoot, spine };
}

function governedRunnerSpineRun({ root, outputRoot, runId, hostEnv }) {
  return runMetaTheoryGovernedExecution({
    task: "Inspect package metadata and prepare a read-only verification summary.",
    runId,
    runtime: "codex",
    osTarget: "windows",
    stateDir: outputRoot,
    artifactDir: outputRoot,
    dbPath: path.join(outputRoot, "runs.sqlite"),
    projectRoot: root,
    projectCapabilityMutationMode: "read_only",
    emitConversationNotice: false,
    ...(hostEnv ? { hostEnv } : {}),
  });
}

const HOST_PROVENANCE_CHAT_ID = "b5799d00-ef7a-4882-818d-d9053cacba71";

function verifiedChatSpineState(spine) {
  return spine.createInitialState({
    triggerReason: "user_invocation",
    sourceConversation: {
      runtime: "claude",
      sessionId: HOST_PROVENANCE_CHAT_ID,
      matchBasis: "transcript_file_verified",
    },
  });
}

test("real governed runner publishes its exact worker task IDs into the host-activated spine run", async (t) => {
  const { root, outputRoot, spine } = await governedRunnerSpineFixture(t);
  const activated = spine.createInitialState({ triggerReason: "user_invocation", sourceRuntime: "codex" });
  const activation = await spine.activateSpineState(root, activated);
  assert.equal(activation.activated, true);
  const report = await governedRunnerSpineRun({ root, outputRoot, runId: activated.runId });
  const state = await spine.readSpineState(root);
  const taskPacketIds = report.workerTaskPackets.map((packet) => packet.taskPacketId);
  assert.equal(report.coreLoop.runnerSpineBindingPacket.status, "published");
  assert.equal(state.runId, activated.runId);
  assert.deepEqual(state.workerTaskPackets.map((packet) => packet.taskPacketId), taskPacketIds);
  assert.deepEqual(state.runnerDispatchBindingEnvelope.taskPacketIds, taskPacketIds);
  assert.equal(state.currentStage, activated.currentStage);
  assert.deepEqual(stageStatuses(state.stages), stageStatuses(activated.stages));
});

test("governed runner never mints a spine run when the host has not activated one", async (t) => {
  const { root, outputRoot, spine } = await governedRunnerSpineFixture(t);
  const report = await governedRunnerSpineRun({ root, outputRoot, runId: "meta-runner-spine-unbound-1" });
  assert.equal(report.coreLoop.runnerSpineBindingPacket.status, "not_published");
  assert.equal(report.coreLoop.runnerSpineBindingPacket.reason, "no_active_spine_run");
  assert.equal(await spine.readSpineStateIncludingInactive(root), null);
});

test("governed runner reports a runId outside the canonical spine namespace instead of coercing it", async (t) => {
  const { root, outputRoot, spine } = await governedRunnerSpineFixture(t);
  const activated = spine.createInitialState({ triggerReason: "user_invocation", sourceRuntime: "codex" });
  await spine.activateSpineState(root, activated);
  const report = await governedRunnerSpineRun({ root, outputRoot, runId: "P118-Runner-Spine-Artifact" });
  assert.equal(report.coreLoop.runnerSpineBindingPacket.status, "not_published");
  assert.equal(
    report.coreLoop.runnerSpineBindingPacket.reason,
    "run_id_outside_canonical_spine_namespace",
  );
  const state = await spine.readSpineState(root);
  assert.equal(state.runId, activated.runId);
  assert.equal(Object.hasOwn(state, "runnerDispatchBindingEnvelope"), false);
});

test("a governed run under a live chat records that chat and the host it came from", async (t) => {
  const { root, outputRoot, spine } = await governedRunnerSpineFixture(t);
  const activated = verifiedChatSpineState(spine);
  assert.equal(activated.conversationLinkState, "verified");
  await spine.activateSpineState(root, activated);

  const report = await governedRunnerSpineRun({
    root,
    outputRoot,
    runId: "meta-runner-hostprov-linked-1",
    hostEnv: {},
  });

  assert.equal(report.conversationLinkState, "verified");
  assert.equal(report.sourceRuntime, "claude");
  assert.equal(report.sourceConversation.conversationId, HOST_PROVENANCE_CHAT_ID);
  assert.equal(report.sourceConversation.runId, "meta-runner-hostprov-linked-1");
  assert.equal(report.sourceConversation.matchBasis, "transcript_file_verified");
  assert.equal(report.requestRecord.runtimeContext.runtimeFamily, "claude");
  assert.equal(report.coreLoop.requestRecord.runtimeContext.runtimeFamily, "claude");
  // Which host produced the record and which runtime the route plans against are
  // two questions. Collapsing them is what stamped every run as Codex.
  assert.equal(report.requestRecord.runtimeContext.routeTarget, "codex");
  assert.equal(report.sourceArtifacts.orchestrationReport.runtimeContext.runtimeFamily, "codex");

  // The panel reads the compact projection, not the artifact. An artifact that
  // names the chat while the projection drops it leaves every row reading
  // "unlinked" exactly as before.
  const projection = JSON.parse(await fs.readFile(
    path.join(outputRoot, "meta-runner-hostprov-linked-1.live.json"),
    "utf8",
  ));
  assert.equal(projection.run.conversationLinkState, "verified");
  assert.equal(projection.run.sourceRuntime, "claude");
  assert.equal(projection.run.conversationRef, HOST_PROVENANCE_CHAT_ID);
});

test("a governed run outside any live chat records the host without inventing a link", async (t) => {
  const { root, outputRoot } = await governedRunnerSpineFixture(t);

  const report = await governedRunnerSpineRun({
    root,
    outputRoot,
    runId: "meta-runner-hostprov-unlinked-1",
    hostEnv: { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" },
  });

  assert.equal(report.conversationLinkState, "unlinked");
  assert.equal(report.sourceConversation, undefined);
  assert.equal(report.sourceRuntime, "claude");
  assert.equal(report.requestRecord.runtimeContext.runtimeFamily, "claude");
  assert.equal(report.hostProvenancePacket.conversationBindingRefusal, "no_spine_state");
  // A known host with no chat to attach is a different sentence from a host that
  // never identified itself, and the panel already has copy for both.
  assert.equal(report.conversationLinkRefusal, "conversation_id_not_identified");
});

test("a deactivated chat is not lent to a later governed run", async (t) => {
  const { root, outputRoot, spine } = await governedRunnerSpineFixture(t);
  const activated = verifiedChatSpineState(spine);
  await spine.activateSpineState(root, activated);
  await spine.terminalizeSpineState(root, { expectedRunId: activated.runId });
  const stored = await spine.readSpineStateIncludingInactive(root);
  assert.equal(stored.active, false);
  assert.equal(stored.sourceConversation.conversationId, HOST_PROVENANCE_CHAT_ID);

  const report = await governedRunnerSpineRun({
    root,
    outputRoot,
    runId: "meta-runner-hostprov-stale-1",
    hostEnv: {},
  });

  assert.equal(report.conversationLinkState, "unlinked");
  assert.equal(report.sourceConversation, undefined);
  assert.equal(
    report.hostProvenancePacket.conversationBindingRefusal,
    "spine_conversation_host_session_absent",
  );
  // No host marker and no live binding leaves the run unattributed, which the
  // panel already has copy for. A vendor name here would be a guess.
  assert.equal(report.sourceRuntime, "unavailable");
  assert.equal(report.requestRecord.runtimeContext.runtimeFamily, "unavailable");
  assert.equal(report.conversationLinkRefusal, "runtime_not_identified");
});

test("a deactivated chat is not lent to a host running under a different chat", async (t) => {
  const { root, outputRoot, spine } = await governedRunnerSpineFixture(t);
  const activated = verifiedChatSpineState(spine);
  await spine.activateSpineState(root, activated);
  await spine.terminalizeSpineState(root, { expectedRunId: activated.runId });

  // The concrete case is a long-lived daemon started from another session: it
  // keeps exporting that session's chat id for as long as it lives, so equality
  // against the recorded chat is the only thing separating it from the real host.
  const report = await governedRunnerSpineRun({
    root,
    outputRoot,
    runId: "meta-runner-hostprov-otherchat-1",
    hostEnv: {
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "39a0b1c2-0000-4000-8000-000000000000",
    },
  });

  assert.equal(report.conversationLinkState, "unlinked");
  assert.equal(report.sourceConversation, undefined);
  assert.equal(
    report.hostProvenancePacket.conversationBindingRefusal,
    "spine_conversation_host_session_mismatch",
  );
  assert.equal(report.sourceRuntime, "claude");
  assert.equal(report.conversationLinkRefusal, "conversation_id_not_identified");
});

/**
 * Claude Code's `Stop` hook fires at every turn boundary rather than at session
 * end, so a spine terminalized with `session_stop` routinely belongs to a chat
 * that is still open. Refusing all of them is what left every governed run after
 * the first turn boundary reading "unlinked" on the panel.
 */
test("a deactivated chat is revived for a host provably running under that same chat", async (t) => {
  const { root, outputRoot, spine } = await governedRunnerSpineFixture(t);
  const activated = verifiedChatSpineState(spine);
  await spine.activateSpineState(root, activated);
  await spine.terminalizeSpineState(root, { expectedRunId: activated.runId });
  const stored = await spine.readSpineStateIncludingInactive(root);
  assert.equal(stored.active, false);
  assert.equal(stored.deactivationReason, "session_stop");

  const report = await governedRunnerSpineRun({
    root,
    outputRoot,
    runId: "meta-runner-hostprov-revived-1",
    hostEnv: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: HOST_PROVENANCE_CHAT_ID },
  });

  assert.equal(report.conversationLinkState, "verified");
  assert.equal(report.sourceConversation.conversationId, HOST_PROVENANCE_CHAT_ID);
  assert.equal(report.sourceConversation.runId, "meta-runner-hostprov-revived-1");
  assert.equal(report.sourceConversation.matchBasis, "transcript_file_verified");
  // The record has to say which route proved it, or a reader cannot tell a live
  // binding from a revived one.
  assert.equal(
    report.hostProvenancePacket.conversationBindingBasis,
    "revived_host_session_binding",
  );
  assert.equal(report.hostProvenancePacket.provenanceBasis, "revived_host_session_binding");
  assert.equal(report.sourceRuntime, "claude");
  assert.equal(report.requestRecord.runtimeContext.routeTarget, "codex");

  const projection = JSON.parse(await fs.readFile(
    path.join(outputRoot, "meta-runner-hostprov-revived-1.live.json"),
    "utf8",
  ));
  assert.equal(projection.run.conversationLinkState, "verified");
  assert.equal(projection.run.conversationRef, HOST_PROVENANCE_CHAT_ID);
});
