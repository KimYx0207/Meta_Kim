import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createHostMethodSourceFixture } from "../helpers/host-method-source-fixture.mjs";
import { readOnlyFixtureTaskFacts } from "../helpers/task-design-facts.mjs";
import { discoverDependencyAgentContracts } from "../../scripts/dependency-agent-discovery.mjs";
import { createHostModuleStageExecutors } from "../../scripts/governed-execution/module-stage-host-bindings.mjs";
import { invokeReadOnlyRuntimeWorker } from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import { moduleStageDigest } from "../../scripts/governed-execution/module-stage-execution.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const task = "Read the current bounded module artifact";

async function fixture(t, { runtime = "gemini", mode = "host_reported_files", failure = null, authorized = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-stage-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  const artifactRoot = path.join(root, ".meta-kim/work/stage-results");
  await mkdir(artifactRoot, { recursive: true });
  const dependency = path.join(root, "dependency");
  createHostMethodSourceFixture(dependency);
  const env = { ...process.env, META_KIM_KIM_SERVICE_ROOT: dependency };
  const projects = JSON.parse(readFileSync("config/capability-index/dependency-project-registry.json", "utf8")).projects;
  const discovery = await discoverDependencyAgentContracts({ projects, projectRoot: root, environment: env });
  const owner = discovery.agents.find(item => item.id === "kim-service:package-analyst");
  assert.ok(owner);
  const packet = { taskPacketId: "stage-review-work", owner: owner.id, ownerAgent: owner.id, ownerSource: owner.source,
    ownerSourceRef: owner.sourceRef, ownerBindingMode: owner.ownerBindingMode, ownerContract: owner.ownerContract,
    methodInputs: { facts: "Inspect artifact.txt against current criteria" }, acceptanceCriterionIds: ["criterion-stage"],
    description: task, todayTask: task, taskFacts: readOnlyFixtureTaskFacts(task), taskFactsSubject: task,
    scopeFiles: ["artifact.txt"], dependsOn: [], nonGoals: ["No publication"], externalWriteBoundary: false };
  const content = "Actual local fixture artifact\n";
  await writeFile(path.join(root, "artifact.txt"), content);
  const body = { report: "Current artifacts checked", status: "completed", stopReason: "Current required checks returned",
    artifactRefs: [{ ref: "artifact.txt", sha256: sha(content) }],
    criterionResults: ["criterion-stage", ...(failure === "incomplete_criteria" ? [] : ["criterion-task"])].map(id =>
      ({ id, status: "pass", evidenceRefs: ["artifact.txt"] })), missingCapabilities: [], failures: [] };
  const host = { adapterId: "current-host-stage", maxResultBytes: 256 * 1024, timeoutMs: 3000,
    stageWorkPackets: { Review: packet }, ...(mode ? { stageResultMode: mode } : {}),
    authorize: async () => ({ status: authorized ? "ready" : "waiting" }) };
  const calls = [];
  host.adapterRegistry = { invoke: async (_id, request) => {
    calls.push(request);
    const target = path.join(request.machineResultArtifact.ownedRoot, request.machineResultArtifact.relativePath);
    const binding = failure === "old_binding" ? { ...request.stageBinding, runId: "old-run" } : request.stageBinding;
    const bytes = Buffer.from(JSON.stringify({ binding, output: body }));
    if (failure === "symlink") {
      const outside = path.join(root, "outside-result.json");
      await writeFile(outside, bytes);
      await symlink(outside, target);
    } else if (failure === "symlink_parent") {
      const outside = path.join(root, "redirected-results");
      await mkdir(outside);
      await writeFile(path.join(outside, path.basename(target)), bytes);
      await rm(artifactRoot, { recursive: true });
      await symlink(outside, artifactRoot, "dir");
    } else await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    return { result: { status: "returned", runtime, sessionId: "fixture-stage-worker", messageId: "fixture-result",
      ownerMethodBinding: request.methodSourceBinding,
      machineResultArtifact: { path: failure === "wrong_path" ? path.join(root, "unbound.json") : target,
        sha256: failure === "wrong_hash" ? "0".repeat(64) : sha(bytes), bytes: bytes.length } } };
  } };
  const bind = () => createHostModuleStageExecutors({ host, runtime, projectRoot: root, artifactRoot, env });
  const requestFor = executor => ({
    binding: { runId: "stage-host-run", nodeId: "module-worker-review", graphDigest: sha("graph"), stage: "Review",
      scopeDigest: moduleStageDigest({ kind: "module", moduleId: "worker", revision: 1 }), attemptId: "review-attempt-1", fenceToken: 7,
      ownerId: executor.ownerId, capabilityId: executor.capabilityId, sourceSha256: executor.sourceSha256, inputDigest: sha("current input") },
    node: { nodeId: "module-worker-review", stage: "Review", laneKind: "module_stage", stageContract: { purpose: "Review current module outputs", independentReview: true } },
    scope: { kind: "module", moduleId: "worker", revision: 1 }, runtime, projectRoot: root,
    upstreamResults: [], relatedResults: [{ taskPacketId: "implementation-task", ownerAgent: "separate-producer", sessionId: "fixture-producer" }],
    workerTaskPackets: [{ taskPacketId: "implementation-task", acceptanceCriterionIds: ["criterion-task"] }],
  });
  return { root, dependency, artifactRoot, env, body, host, packet, bind, requestFor, calls };
}

test("Gemini host-reported stage files use the real source and artifact boundary without requiring another client", async t => {
  const f = await fixture(t);
  const executors = await f.bind();
  assert.deepEqual(executors.diagnostics, []);
  const request = f.requestFor(executors.Review);
  const receipt = await executors.Review.invoke(request);
  assert.equal(receipt.verdict, "pass");
  assert.deepEqual(receipt.binding, request.binding);
  assert.deepEqual(receipt.criterionResults.map(row => row.id), ["criterion-stage", "criterion-task"]);
  assert.equal(receipt.hostObservation.evidenceKind, "host_reported_files_verified");
  assert.equal(receipt.hostObservation.nativeInvocationVerified, false);
  assert.equal(receipt.hostObservation.userOutcomeAccepted, false);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].prompt, /SOURCE_METHOD:package-analyst/u);
  assert.match(f.calls[0].prompt, /KNOWLEDGE:package-analyst/u);
  await assert.rejects(executors.Review.invoke(request), /stage_result_artifact_already_exists_or_parent_missing/u);
  assert.equal(f.calls.length, 1, "a repeated fenced attempt cannot dispatch again over its existing result");
});

test("reported results reject an old binding, wrong hash, different path and redirected result", async t => {
  for (const failure of ["old_binding", "wrong_hash", "wrong_path", "symlink", "symlink_parent"]) {
    await t.test(failure, { skip: failure.startsWith("symlink") && process.platform === "win32" }, async subtest => {
      const f = await fixture(subtest, { failure });
      const executors = await f.bind();
      await assert.rejects(executors.Review.invoke(f.requestFor(executors.Review)));
    });
  }
});

test("partial criteria and changed artifact bytes cannot satisfy a reported module stage", async t => {
  for (const failure of ["incomplete_criteria", "changed_artifact"]) {
    await t.test(failure, async subtest => {
      const f = await fixture(subtest, { failure });
      const executors = await f.bind();
      if (failure === "changed_artifact") await writeFile(path.join(f.root, "artifact.txt"), "Changed current bytes\n");
      const receipt = await executors.Review.invoke(f.requestFor(executors.Review));
      assert.equal(receipt.verdict, "blocked");
      assert.ok(receipt.criterionResults.every(row => row.status === "blocked"));
      assert.equal(receipt.hostObservation.nativeInvocationVerified, false);
    });
  }
});

test("authorization, absent criteria and unsupported observers retain specific gaps without dispatch", async t => {
  const f = await fixture(t, { authorized: false });
  let executors = await f.bind();
  await assert.rejects(executors.Review.invoke(f.requestFor(executors.Review)), /stage_host_authorization_not_ready/u);
  assert.equal(f.calls.length, 0);
  delete f.host.stageResultMode;
  executors = await f.bind();
  assert.equal(executors.Review, undefined);
  assert.equal(executors.diagnostics[0].reason, "stage_machine_result_observer_unavailable");
  f.host.stageResultMode = "host_reported_files";
  f.host.stageWorkPackets.Invalid = { ...f.packet, acceptanceCriterionIds: [] };
  executors = await f.bind();
  assert.ok(executors.Review);
  assert.equal(executors.Invalid, undefined);
  assert.ok(executors.diagnostics.some(row => row.key === "Invalid" && row.reason === "stage_work_packet_criteria_required"));
});

test("revoked authorization or a changed method cannot turn a returned file into accepted stage work", async t => {
  await t.test("pause after the actual return", async subtest => {
    const f = await fixture(subtest);
    f.host.authorize = async request => ({ status: request.phase === "result" ? "waiting" : "ready" });
    const executors = await f.bind();
    await assert.rejects(executors.Review.invoke(f.requestFor(executors.Review)), /stage_host_authorization_changed/u);
    assert.equal(f.calls.length, 1, "the original return remains available for reconciliation without redispatch");
  });
  await t.test("source changes after binding", async subtest => {
    const f = await fixture(subtest);
    const executors = await f.bind();
    await writeFile(path.join(f.dependency, "agents/package-analyst/AGENT.md"), "changed source\n");
    await assert.rejects(executors.Review.invoke(f.requestFor(executors.Review)));
    assert.equal(f.calls.length, 0);
  });
});

test("concurrent or uncertain repeats cannot launch the same fenced stage again", async t => {
  await t.test("concurrent call before the first result file exists", async subtest => {
    const f = await fixture(subtest);
    const original = f.host.adapterRegistry.invoke;
    let release;
    let announce;
    const admitted = new Promise(resolve => { announce = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    f.host.adapterRegistry.invoke = async (...args) => { announce(); await pending; return original(...args); };
    const executors = await f.bind();
    const request = f.requestFor(executors.Review);
    const first = executors.Review.invoke(request);
    await admitted;
    await assert.rejects(executors.Review.invoke(request), /stage_attempt_already_invoked_reconcile_original_return/u);
    release();
    assert.equal((await first).verdict, "pass");
    assert.equal(f.calls.length, 1);
  });
  await t.test("lost return with no published file", async subtest => {
    const f = await fixture(subtest);
    let invoked = 0;
    f.host.adapterRegistry.invoke = async () => { invoked += 1; throw new Error("fixture_transport_return_unknown"); };
    const executors = await f.bind();
    const request = f.requestFor(executors.Review);
    await assert.rejects(executors.Review.invoke(request), /fixture_transport_return_unknown/u);
    await assert.rejects(executors.Review.invoke(request), /stage_attempt_already_invoked_reconcile_original_return/u);
    assert.equal(invoked, 1);
  });
});

test("the observed-runtime mode still requires its private same-process result observation", async t => {
  const f = await fixture(t, { runtime: "codex", mode: "observed_runtime" });
  f.host.adapterRegistry.invoke = async () => ({ result: { status: "pass", runtime: "codex", nativeInvocationVerified: true } });
  let executors = await f.bind();
  await assert.rejects(executors.Review.invoke(f.requestFor(executors.Review)), /machine_result_not_observed_by_host_invoker/u);

  // Real local subprocess transport with authored fixture JSON only. No model,
  // account or network call is made, so this is not native model certification.
  const wire = [{ type: "thread.started", thread_id: "fixture-observed-stage" },
    { type: "item.completed", item: { id: "fixture-final", type: "agent_message", text: JSON.stringify(f.body) } },
    { type: "turn.completed", usage: {} }].map(row => JSON.stringify(row)).join("\n") + "\n";
  const program = `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(wire)}));`;
  if (process.platform === "win32") {
    await writeFile(path.join(f.root, "fake-codex.mjs"), program);
    await writeFile(path.join(f.root, "codex.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.mjs" %*\r\n`);
  } else {
    await writeFile(path.join(f.root, "codex"), `#!/usr/bin/env node\n${program}`);
    await chmod(path.join(f.root, "codex"), 0o700);
  }
  f.env.PATH = `${f.root}${path.delimiter}${process.env.PATH}`;
  f.host.adapterRegistry.invoke = async (_id, request) => ({ result: await invokeReadOnlyRuntimeWorker(request) });
  executors = await f.bind();
  const receipt = await executors.Review.invoke(f.requestFor(executors.Review));
  assert.equal(receipt.verdict, "pass");
  assert.equal(receipt.hostObservation.evidenceKind, "observed_runtime_stage_result_with_current_artifact_checks");
  assert.equal(receipt.hostObservation.nativeInvocationVerified, false);
  assert.equal(receipt.hostObservation.sessionId, "fixture-observed-stage");
  assert.equal(JSON.parse(await readFile(receipt.hostObservation.resultArtifact.path, "utf8")).report, f.body.report);
});
