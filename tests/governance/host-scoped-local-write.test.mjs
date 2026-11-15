import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostMethodSourceFixture } from "../helpers/host-method-source-fixture.mjs";
import { discoverDependencyAgentContracts } from "../../scripts/dependency-agent-discovery.mjs";
import { buildTaskGoalContract } from "../../src/domain/governance/task-outcome.mjs";
import { buildStageDagPacket } from "../../scripts/governed-execution/stage-dag.mjs";
import { openDurableRunKernel } from "../../scripts/governed-execution/durable-run-kernel.mjs";
import { advanceGovernedGoal } from "../../scripts/governed-execution/advance-goal.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
async function fixture(t, failure = null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meta-host-write-"));
  const projectRoot = path.join(root, "project"), dependencyRoot = path.join(root, "dependency"), artifactRoot = path.join(root, "results");
  await fs.mkdir(projectRoot); await fs.mkdir(artifactRoot);
  createHostMethodSourceFixture(dependencyRoot);
  const env = { ...process.env, META_KIM_KIM_SERVICE_ROOT: dependencyRoot };
  const projects = JSON.parse(readFileSync("config/capability-index/dependency-project-registry.json", "utf8")).projects;
  const discovery = await discoverDependencyAgentContracts({ projects, projectRoot, environment: env });
  const owner = discovery.agents.find((item) => item.id === "kim-service:package-analyst");
  assert.ok(owner);
  const packet = { taskPacketId: "bounded-writer", ownerAgent: owner.id, ownerSource: owner.source, ownerSourceRef: owner.sourceRef,
    ownerBindingMode: owner.ownerBindingMode, ownerContract: owner.ownerContract, todayTask: "Write the approved local draft",
    methodInputs: { facts: "Write exactly the supplied draft to target.txt under the current host tool binding" },
    acceptanceCriterionIds: ["draft"], scopeFiles: ["target.txt"], mutationPolicy: "scoped_local_writes_only", externalWriteBoundary: false, dependsOn: [] };
  const graph = buildStageDagPacket({ stageOrder: ["Execution"], stageLanes: { Execution: [{ laneId: packet.taskPacketId,
    laneKind: "execution_worker", ownerBindingRef: owner.id, capabilityBindingRef: "fixture:bounded-write", effectClass: "local_write",
    resourceScopes: ["file:target.txt"], isolation: "current_host_scoped_files" }] } });
  const goal = buildTaskGoalContract({ task: "Write a bounded local draft", acceptanceCriteria: [
    { id: "draft", description: "Target contains the approved draft", kind: "deterministic", required: true }] });
  await fs.writeFile(path.join(projectRoot, "target.txt"), "original\n");
  const kernel = await openDurableRunKernel(path.join(root, "run.sqlite"));
  t.after(async () => { kernel.close(); await fs.rm(root, { recursive: true, force: true }); });
  let invocations = 0;
  const host = { ownerId: "current-gemini-host", adapterId: "current-host-tools", methodResultMode: "host_reported_files", maxResultBytes: 256 * 1024,
    authorize: async ({ node, phase }) => !node || node.laneKind === "stage_merge" ? { status: "ready" } : ({ status: "ready", effectClass: "local_write",
      allowedLocalWritePaths: failure === "outside_scope" ? ["elsewhere.txt"] : failure === "outside_project" ? ["../outside.txt"]
        : failure === "revoked" && phase === "verify_local_write_result" ? [] : ["target.txt"] }),
    adapterRegistry: { invoke: async (_adapter, request) => {
      invocations += 1;
      assert.equal(request.runtime, "gemini");
      assert.deepEqual(request.authorizedLocalWritePaths, ["target.txt"]);
      assert.match(request.prompt, /SOURCE_METHOD:package-analyst/);
      assert.match(request.prompt, /KNOWLEDGE:package-analyst/);
      // This is a real, controlled host tool write in the temporary project.
      // No model or paid client is invoked by this transport behavior test.
      await fs.writeFile(path.join(projectRoot, request.authorizedLocalWritePaths[0]), "approved draft\n");
      const output = { report: "Current approved draft written", status: "produced",
        artifactRefs: [{ ref: failure === "outside_receipt" ? "elsewhere.txt" : "target.txt", sha256: sha("approved draft\n") }],
        handoff: { nextOwner: owner.id, requiresDecision: false } };
      const binding = { ...request.methodBinding, ...(failure === "stale_run" ? { runId: "old-run" } : {}) };
      const bytes = Buffer.from(JSON.stringify({ binding, output }));
      const target = path.join(request.machineResultArtifact.ownedRoot, request.machineResultArtifact.relativePath);
      await fs.writeFile(target, bytes, { flag: "wx" });
      return { result: { status: "pass", runtime: "gemini", ownerMethodBinding: request.methodSourceBinding,
        machineResultArtifact: { path: target, sha256: failure === "wrong_hash" ? "0".repeat(64) : sha(bytes), bytes: bytes.length } } };
    } } };
  const advance = (overrides = {}) => advanceGovernedGoal({ runId: "local-write", goalContract: goal, stageDagPacket: graph,
    workerTaskPackets: [packet], projectRoot, artifactRoot, runtime: "gemini", host, kernel, taskFingerprint: "bounded-write-v1", env, ...overrides });
  return { root, projectRoot, artifactRoot, kernel, graph, goal, packet, host, advance, invocations: () => invocations };
}

test("explicit host file mode performs a real scoped write, preserves rollback and never repeats a completed claim", async (t) => {
  const f = await fixture(t);
  const result = await f.advance();
  assert.equal(await fs.readFile(path.join(f.projectRoot, "target.txt"), "utf8"), "approved draft\n");
  const completed = result.calls.find((call) => call.evidenceKind === "current_host_reported_files_verified");
  assert.ok(completed, JSON.stringify(result));
  assert.equal(completed.nativeInvocationVerified, false);
  assert.equal(await fs.readFile(completed.rollbackEvidence[0].backupRef, "utf8"), "original\n");
  assert.equal(f.kernel.projectRun("local-write").effects[0].state, "reconciled_completed");
  const resumed = await f.advance({ observations: [{ criterionId: "draft", taskHash: f.goal.taskHash,
    acceptanceDigest: f.goal.acceptanceDigest, verdict: "pass", evidenceKind: "deterministic_check", evidenceRef: "fixture:actual-target-read" }] });
  assert.equal(resumed.status, "completed", JSON.stringify(resumed));
  assert.equal(f.invocations(), 1);
});

for (const failure of ["outside_scope", "outside_project"]) {
  test(`local writer rejects ${failure} before any tool invocation`, async (t) => {
    const f = await fixture(t, failure); const result = await f.advance();
    assert.equal(result.status, "blocked"); assert.equal(f.invocations(), 0);
    assert.equal(await fs.readFile(path.join(f.projectRoot, "target.txt"), "utf8"), "original\n");
  });
}

for (const failure of ["stale_run", "wrong_hash", "outside_receipt", "revoked"]) {
  test(`local writer keeps ${failure} unresolved and does not replay a possibly completed write`, async (t) => {
    const f = await fixture(t, failure); const result = await f.advance();
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.equal(f.invocations(), 1);
    assert.equal(f.kernel.projectRun("local-write").effects[0].state, "in_doubt");
    const resumed = await f.advance();
    assert.equal(resumed.reason, "existing_claim_or_unresolved_effect");
    assert.equal(f.invocations(), 1);
  });
}

test("the existing read-only path still refuses local writes without the explicit host file mode", async (t) => {
  const f = await fixture(t); delete f.host.methodResultMode;
  const result = await f.advance();
  assert.equal(result.status, "blocked"); assert.equal(f.invocations(), 0);
  assert.equal(await fs.readFile(path.join(f.projectRoot, "target.txt"), "utf8"), "original\n");
});

test("reconciling one local attempt leaves a concurrent attempt's effect unchanged", async (t) => {
  const kernel = await openDurableRunKernel(); t.after(() => kernel.close());
  kernel.createRun({ runId: "scope-effects", graphDigest: sha("graph"), taskFingerprint: "effects" });
  const claims = ["a", "b"].map((id) => kernel.claimNode({ runId: "scope-effects", nodeId: id, ownerId: "host",
    nodeDefinitionHash: sha(id), inputHash: sha(id), dependencyOutputHash: sha(""), leaseMs: 30_000 }));
  for (const [index, claim] of claims.entries()) {
    const id = ["a", "b"][index];
    const effect = kernel.prepareEffect({ ...claim, runId: "scope-effects", nodeId: id, ownerId: "host", effectId: `effect:${id}`,
      logicalEffectKey: `write:${id}`, fingerprint: sha(id), idempotencyKey: id, providerBinding: { localWritePaths: [`${id}.txt`] } });
    kernel.markEffectDispatchStarted({ effectId: effect.effectId, attemptId: claim.attemptId, fenceToken: claim.fenceToken, ownerId: "host" });
  }
  const changed = kernel.markUnresolvedEffectsInDoubt({ runId: "scope-effects", attemptId: claims[0].attemptId });
  assert.deepEqual(changed.effectIds, ["effect:a"]);
  const effects = kernel.projectRun("scope-effects").effects;
  assert.equal(effects.find((effect) => effect.effectId === "effect:a").state, "in_doubt");
  assert.equal(effects.find((effect) => effect.effectId === "effect:b").state, "dispatch_started");
});
