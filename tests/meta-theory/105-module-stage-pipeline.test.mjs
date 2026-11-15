import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildStageDagPacket, stageLaneNodeId, moduleStageNodeId, selectMaximalSafeReadySet, stageDagGraphDigest,
  validateStageDagPacket } from "../../scripts/governed-execution/stage-dag.mjs";
import { runStageRunnerBridge } from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import { openDurableRunKernel } from "../../scripts/governed-execution/durable-run-kernel.mjs";
import { readOnlyWorkerPacket } from "../helpers/read-only-worker-packet.mjs";
import { buildRunnerStageDagPacket } from "../../scripts/run-meta-theory-governed-execution.mjs";
import { moduleNodeInRequestedScope } from "../../scripts/governed-execution/module-stage-execution.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const plan = (shared = false) => ({ schemaVersion: 1, architecture: { id: "arch", revision: 1, basisDigest: sha("arch") },
  modules: ["a", "b"].map((id) => ({ id, revision: 1, basisDigest: sha(id), taskIds: [id, ...(shared ? ["shared"] : [])], dependsOn: [] })) });
const packet = (id) => readOnlyWorkerPacket({ taskPacketId: id, ownerAgent: `author:${id}`, description: `Read the ${id} source`,
  output: "Observed source", externalWriteBoundary: false, executionMode: "primary_execution", dependsOn: [], acceptanceCriterionIds: [`criterion:${id}`] });
function graph({ shared = false, emptyB = false } = {}) {
  const scope = plan(shared);
  if (emptyB) scope.modules[1].taskIds = [];
  const ids = ["a", ...(!emptyB ? ["b"] : []), ...(shared ? ["shared"] : [])];
  return buildStageDagPacket({ moduleScopePlan: scope, runtimeCapacity: 2, stageLanes: { Execution: ids.map((id) => ({
    laneId: id, laneKind: "execution_worker", ownerBindingRef: `author:${id}`, capabilityBindingRef: `read:${id}`,
    effectClass: "read_only_worker", resourceScopes: [`file:${id}.txt`], isolation: "shared_read_only" })) } });
}
function executors(onStage = () => {}) {
  return Object.fromEntries(["Critical", "Fetch", "Thinking", "Review", "Meta-Review", "Verification", "Evolution"].map((stage) => [stage, {
    ownerId: `reviewer:${stage}`, capabilityId: `stage:${stage}`, sourceRef: `fixture:method:${stage}`, sourceSha256: sha(stage),
    toolBinding: "fixture:observed_callback", invoke: async (request) => {
      const override = await onStage(request);
      const evidence = `fixture:receipt:${request.node.nodeId}`;
      const ids = [...new Set([`stage:${stage}`, ...request.workerTaskPackets.flatMap((item) => item.acceptanceCriterionIds)])];
      return { binding: request.binding, verdict: "pass", evidenceRefs: [{ ref: evidence, sha256: sha(evidence) }],
        criterionResults: ids.map((id) => ({ id, status: "pass", evidenceRefs: [evidence] })), summary: "Fixture observation, not native acceptance", ...override };
    },
  }]));
}
async function fixture(t, options = {}) {
  const kernel = await openDurableRunKernel();
  t.after(() => kernel.close());
  const dag = graph(options);
  const ids = dag.nodes.filter((node) => node.laneKind === "execution_worker").map((node) =>
    ["a", "b", "shared"].find((id) => stageLaneNodeId("Execution", id) === node.nodeId));
  const calls = [];
  return { kernel, dag, calls, options: { runId: "module-fixture", runtime: "claude", stageDagPacket: dag, workerTaskPackets: ids.map(packet),
    workspaceRoot: process.cwd(), evidenceKind: "synthetic_transport", stageExecutors: executors(),
    durable: { enabled: true, kernel, mode: "create", taskFingerprint: "module-task", leaseMs: 30_000 },
    invokeWorker: async ({ packet: work }) => { calls.push(work.taskPacketId); return { status: "pass", durationMs: 1,
      outputText: work.taskPacketId, outputSha256: sha(work.taskPacketId), outputTextComplete: true }; } } };
}

test("module graph binds identities/bases, deduplicates shared tasks, and preserves legacy graphs", () => {
  const dag = graph({ shared: true });
  assert.equal(dag.nodes.filter((node) => node.nodeId === stageLaneNodeId("Execution", "shared")).length, 1);
  const shared = dag.nodes.find((node) => node.nodeId === stageLaneNodeId("Execution", "shared"));
  assert.ok(shared.dependsOn.includes(moduleStageNodeId("a", "Thinking", "merge")));
  assert.ok(shared.dependsOn.includes(moduleStageNodeId("b", "Thinking", "merge")));
  const changed = structuredClone(dag); changed.moduleScopePlan.modules[0].basisDigest = sha("changed");
  assert.notEqual(stageDagGraphDigest(changed), dag.graphDigest);
  assert.throws(() => validateStageDagPacket(changed), /stale module basis/);
  assert.deepEqual(buildStageDagPacket({ stageOrder: ["Execution"] }), buildStageDagPacket({ stageOrder: ["Execution"], moduleScopePlan: null }));
});

test("a running conflicting resource continues to block ready work across stages", () => {
  const dag = buildStageDagPacket({ stageOrder: ["Execution"], stageLanes: { Execution: ["a", "b", "c"].map((id) => ({
    laneId: id, effectClass: "local_write", resourceScopes: [`file:${id === "c" ? "other" : "same"}.txt`] })) } });
  const ready = selectMaximalSafeReadySet(dag, { runningNodeIds: [stageLaneNodeId("Execution", "a")], capacity: 2 });
  assert.deepEqual(ready.readyNodeIds, [stageLaneNodeId("Execution", "c")]);
});

test("the actual builder maps Live design identities exactly and aggregate handoff keeps the full graph", () => {
  const packets = ["a", "b"].map(id => ({ ...packet(`packet-${id}`), roleInstanceId: id, mutationPolicy: "read_only" }));
  const dag = buildRunnerStageDagPacket(packets, null, null, plan());
  assert.deepEqual(dag.moduleScopePlan.modules[0].taskBindings, [{ designTaskId: "a", taskPacketId: "packet-a" }]);
  const task = dag.nodes.find(node => node.nodeId === stageLaneNodeId("Execution", "packet-a"));
  assert.equal(moduleNodeInRequestedScope(task, { kind: "module", moduleIds: ["a"], requiredModuleIds: ["a"], taskIds: ["a"] }, packets), true);
  const aggregate = { kind: "aggregate", moduleIds: ["a", "b"], requiredModuleIds: ["a", "b"], taskIds: ["a", "b"] };
  assert.ok(dag.nodes.every(node => moduleNodeInRequestedScope(node, aggregate, packets)));
  assert.equal(dag.graphDigest, buildRunnerStageDagPacket(packets, null, null, plan()).graphDigest, "Dispatch scope never forks graph identity");
  assert.throws(() => buildRunnerStageDagPacket(packets.slice(1), null, null, plan()), /unambiguous current worker/u);
  assert.throws(() => buildRunnerStageDagPacket([...packets, { ...packets[0], taskPacketId: "ambiguous-a" }], null, null, plan()), /unambiguous current worker/u);
});

test("fast module reaches actual Review while an independent worker remains in flight", async (t) => {
  const f = await fixture(t); const order = [];
  let releaseB;
  const waitB = new Promise((resolve) => { releaseB = resolve; });
  const timeout = setTimeout(() => releaseB(), 3000); t.after(() => clearTimeout(timeout));
  const result = await runStageRunnerBridge({ ...f.options,
    stageExecutors: executors((request) => { order.push(`${request.scope.moduleId ?? request.scope.kind}:${request.node.stage}`);
      if (request.scope.moduleId === "a" && request.node.stage === "Review") releaseB(); }),
    invokeWorker: async ({ packet: work }) => { order.push(`${work.taskPacketId}:start`);
      if (work.taskPacketId === "b") await waitB;
      order.push(`${work.taskPacketId}:end`); return { status: "pass", outputText: work.taskPacketId, outputSha256: sha(work.taskPacketId), durationMs: 1 }; },
  });
  assert.equal(result.status, "pass", JSON.stringify(result.failure));
  assert.ok(order.indexOf("a:Review") < order.indexOf("b:end"), JSON.stringify(order));
  assert.equal(result.executionProjection.moduleProgress.aggregateCompleted, true);
  assert.ok(result.nodeRecords.filter((node) => node.laneKind === "module_stage").every((node) => node.nativeInvocationVerified === false));
});

test("one blocked design does not prevent another module's verification; final integration stays pending", async (t) => {
  const f = await fixture(t);
  const result = await runStageRunnerBridge({ ...f.options, stageExecutors: executors((request) =>
    request.scope.moduleId === "b" && request.node.stage === "Thinking" ? { verdict: "blocked", summary: "Current user decision is pending" } : {}) });
  assert.equal(result.status, "partial");
  assert.deepEqual(f.calls, ["a"]);
  const progress = result.executionProjection.moduleProgress;
  assert.equal(progress.modules.find((module) => module.moduleId === "a").completed, true);
  assert.equal(progress.modules.find((module) => module.moduleId === "b").completed, false);
  assert.equal(progress.aggregateCompleted, false);
  const resumed = await runStageRunnerBridge({ ...f.options, durable: { ...f.options.durable, mode: "resume" } });
  assert.equal(resumed.status, "pass", JSON.stringify(resumed.failure));
  assert.deepEqual(f.calls, ["a", "b"], "a new decision resumes B without rerunning completed A");
});

test("empty task decomposition waits honestly while the other module proceeds", async (t) => {
  const f = await fixture(t, { emptyB: true });
  const result = await runStageRunnerBridge(f.options);
  assert.equal(result.status, "partial"); assert.deepEqual(f.calls, ["a"]);
  assert.equal(result.executionProjection.moduleProgress.modules[0].completed, true);
  assert.equal(result.executionProjection.moduleProgress.modules[1].completed, false);
});

test("shared work executes once; resume preserves completed stage receipts without invoking them again", async (t) => {
  const f = await fixture(t, { shared: true });
  const result = await runStageRunnerBridge(f.options);
  assert.equal(result.status, "pass", JSON.stringify(result.failure));
  assert.equal(f.calls.filter((id) => id === "shared").length, 1);
  const resumed = await runStageRunnerBridge({ ...f.options, durable: { ...f.options.durable, mode: "resume" },
    stageExecutors: executors(() => { throw new Error("completed stage must not re-run"); }),
    invokeWorker: async () => { throw new Error("completed task must not re-run"); } });
  assert.equal(resumed.status, "pass", JSON.stringify(resumed.failure));
});

test("stale scoped receipts fail only their module while independent work continues", async (t) => {
  const f = await fixture(t);
  const result = await runStageRunnerBridge({ ...f.options, stageExecutors: executors((request) =>
    request.scope.moduleId === "a" && request.node.stage === "Review"
      ? { binding: { ...request.binding, scopeDigest: sha("stale") } } : {}) });
  assert.equal(result.status, "failed");
  assert.equal(result.executionProjection.moduleProgress.modules.find((module) => module.moduleId === "b").completed, true);
  assert.equal(result.executionProjection.moduleProgress.aggregateCompleted, false);
});

test("a callback cannot rewrite the expected binding in place to accept a stale receipt", async (t) => {
  const f = await fixture(t);
  const result = await runStageRunnerBridge({ ...f.options, stageExecutors: executors((request) => {
    if (request.scope.moduleId === "a" && request.node.stage === "Review") request.binding.scopeDigest = sha("mutated");
  }) });
  assert.equal(result.status, "failed");
  assert.equal(result.executionProjection.moduleProgress.modules.find((module) => module.moduleId === "b").completed, true);
});

test("missing stage binding and same-author review cannot manufacture completion", async (t) => {
  const f = await fixture(t);
  const blocked = await runStageRunnerBridge({ ...f.options, stageExecutors: {} });
  assert.equal(blocked.status, "partial"); assert.deepEqual(f.calls, []);
  const bindings = executors(); bindings.Review.ownerId = "author:a";
  const result = await runStageRunnerBridge({ ...f.options, stageExecutors: bindings, durable: { ...f.options.durable, mode: "resume" } });
  assert.equal(result.status, "failed");
  assert.equal(result.executionProjection.moduleProgress.aggregateCompleted, false);
});
