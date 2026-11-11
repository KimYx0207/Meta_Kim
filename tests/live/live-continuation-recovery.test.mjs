import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { openDurableRunRepository } from "../../src/application/run/open-durable-run-repository.mjs";
import { prepareLiveHostContinuation } from "../../src/application/live/plan-live-continuation.mjs";
import { canonicalDigest } from "../../src/domain/shared/canonical-digest.mjs";
import { createLiveContinuationCommand } from "../../src/domain/live/live-continuation-command.mjs";
import { createLiveContinuationCommandStore } from "../../src/infrastructure/live/live-continuation-command-store.mjs";
import { createLiveRuntimeAdapterRegistry } from "../../src/infrastructure/live/live-runtime-adapter-registry.mjs";
import { runLiveHostContinuationCli } from "../../scripts/live-host-continuation.mjs";
import { getProcessStartIdentity } from "../../scripts/release-state-hardening.mjs";

const runNode = promisify(execFile);
const storeModule = new URL("../../src/infrastructure/live/live-continuation-command-store.mjs", import.meta.url).href;

function command(suffix = "one") {
  return createLiveContinuationCommand({
    commandId: `recovery-command-${suffix}`, action: "resume", runId: "recovery-run", nodeId: `recovery-node-${suffix}`,
    expectedRevision: 1, checkpointId: null, effectState: "none",
    claim: { attemptId: `recovery-attempt-${suffix}`, ownerId: "recovery-owner", leaseExpiresAtMs: 20_000, fenceToken: 1 },
    actor: "recovery-owner", runtimeAdapter: "fake-codex", runtime: "codex", nonce: `recovery-nonce-${suffix}`,
    issuedAtMs: 1_000, expiresAtMs: 10_000, payload: {},
  });
}

async function project(t, beforeRemove = () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-continuation-recovery-"));
  await mkdir(path.join(root, ".git"));
  t.after(async () => { await beforeRemove(); await rm(root, { recursive: true, force: true }); });
  return root;
}

async function leaveInterruptedWriter(root) {
  const source = `
    import { createLiveContinuationCommandStore } from ${JSON.stringify(storeModule)};
    const store = createLiveContinuationCommandStore({ projectRoot: process.argv[1], clock() { process.exit(71); } });
    await store.append(JSON.parse(process.argv[2]));
  `;
  await assert.rejects(runNode(process.execPath, ["--input-type=module", "-e", source, root, JSON.stringify(command())],
    { timeout: 10_000 }), (error) => error.code === 71);
}

test("a new process resumes after a command writer exits while holding its lock", async (t) => {
  const root = await project(t);
  await leaveInterruptedWriter(root);
  const store = createLiveContinuationCommandStore({ projectRoot: root, clock: () => 2_000, lockTimeoutMs: 100 });
  const record = await store.append(command());
  assert.equal(record.revision, 1);
  assert.equal((await store.list()).length, 1);
  assert.equal(await access(`${store.filePath}.lock`).then(() => true, () => false), false);
});

test("two recovering processes keep the command log serialized after the same interrupted writer", async (t) => {
  const root = await project(t);
  await leaveInterruptedWriter(root);
  const source = `
    import { createLiveContinuationCommandStore } from ${JSON.stringify(storeModule)};
    const store = createLiveContinuationCommandStore({ projectRoot: process.argv[1], clock: () => 2000, lockTimeoutMs: 1000 });
    const record = await store.append(JSON.parse(process.argv[2]));
    process.stdout.write(JSON.stringify({ revision: record.revision }));
  `;
  const results = await Promise.all(["one", "two"].map((suffix) => runNode(process.execPath,
    ["--input-type=module", "-e", source, root, JSON.stringify(command(suffix))], { timeout: 10_000 })));
  assert.deepEqual(results.map((result) => JSON.parse(result.stdout).revision).sort(), [1, 2]);
  const store = createLiveContinuationCommandStore({ projectRoot: root, clock: () => 2_000 });
  assert.equal((await store.list()).length, 2, "Both commands remain in the verified hash chain");
});

test("recovery preserves active, foreign and unknown lock owners and explains the next check", async (t) => {
  for (const kind of ["active", "foreign", "unknown"]) {
    await t.test(kind, async (t) => {
      const root = await project(t);
      const store = createLiveContinuationCommandStore({ projectRoot: root, clock: () => 2_000, lockTimeoutMs: 25 });
      let protectedFile = `${store.filePath}.lock`;
      if (kind === "unknown") {
        await mkdir(path.dirname(store.filePath), { recursive: true });
        await writeFile(protectedFile, "");
      } else {
        await leaveInterruptedWriter(root);
        protectedFile = path.join(protectedFile, "owner.json");
        const owner = JSON.parse(await readFile(protectedFile, "utf8"));
        if (kind === "active") Object.assign(owner, { pid: process.pid, processStartIdentity: getProcessStartIdentity(process.pid) });
        else owner.hostname = `different-host-${os.hostname()}`;
        await writeFile(protectedFile, JSON.stringify(owner));
      }
      const before = await readFile(protectedFile);
      await assert.rejects(store.append(command()), (error) => {
        assert.equal(error.code, "LIVE_CONTINUATION_STORE_CAS_BUSY");
        assert.match(error.recovery?.nextAction ?? "", /inspect|wait/iu);
        assert.equal(error.recovery?.reason, `lock_owner_${kind}`);
        return true;
      });
      assert.deepEqual(await readFile(protectedFile), before);
      assert.equal((await store.list()).length, 0);
    });
  }
});

async function hostFixture(t) {
  let kernel;
  const root = await project(t, () => kernel?.close());
  const db = path.join(root, "kernel.sqlite");
  kernel = await openDurableRunRepository(db);
  const nowMs = Date.now();
  const binding = { runId: "artifact-run", graphDigest: "artifact-graph", taskFingerprint: "artifact-task" };
  kernel.createRun({ ...binding, nowMs });
  const claim = kernel.claimNode({ runId: binding.runId, nodeId: "artifact-node", ownerId: "artifact-owner",
    nodeDefinitionHash: "definition", inputHash: "input", dependencyOutputHash: "dependencies", leaseMs: 300_000, nowMs });
  const current = kernel.resumeRun(binding);
  const workOrder = "Continue the existing fixture and preserve its verified result.";
  const input = createLiveContinuationCommand({ action: "handoff", runId: binding.runId, nodeId: "artifact-node",
    expectedRevision: current.cursor, checkpointId: current.headCheckpointId, effectState: "none",
    claim: { attemptId: claim.attemptId, ownerId: "artifact-owner", fenceToken: claim.fenceToken, leaseExpiresAtMs: nowMs + 300_000 },
    actor: "artifact-owner", runtimeAdapter: "codex-host-threads", runtime: "codex", nonce: "artifact-event",
    issuedAtMs: nowMs, expiresAtMs: nowMs + 240_000,
    payload: { ...binding, targetActorId: "artifact-thread", targetThreadId: "artifact-thread",
      approvalRef: "artifact-approval", workOrderRef: "artifact-work-order", workOrderDigest: canonicalDigest(workOrder) } });
  return { root, db, kernel, binding, workOrder, input, nowMs };
}

test("a missing prepared host request is restored for reconciliation without another dispatch", async (t) => {
  const { root, db, kernel, binding, workOrder, input } = await hostFixture(t);
  const exchange = path.join(root, ".meta-kim/work/exchange");
  await mkdir(exchange, { recursive: true });
  const inputFile = path.join(exchange, "command.json");
  const outputFile = path.join(exchange, "request.json");
  const workOrderFile = path.join(exchange, "work-order.txt");
  await writeFile(inputFile, JSON.stringify(input));
  await writeFile(workOrderFile, workOrder);
  const sharedArgs = ["--project-root", root, "--db", db];
  const args = ["prepare", ...sharedArgs, "--input", inputFile, "--output", outputFile, "--work-order", workOrderFile,
    "--authorized-command-digest", input.commandDigest, "--approval-ref", input.payload.approvalRef];
  assert.equal((await runLiveHostContinuationCli(args)).status, "prepared");
  const original = JSON.parse(await readFile(outputFile, "utf8"));
  const cursor = kernel.projectRun(binding.runId).cursor;
  await rm(outputFile);
  const recovered = await runLiveHostContinuationCli(args);
  assert.equal(recovered.status, "already_prepared");
  assert.equal(recovered.mayDispatch, false);
  assert.equal(recovered.requestArtifactState, "restored");
  assert.equal(recovered.nextAction, "reconcile_original_host_return");
  const restored = JSON.parse(await readFile(outputFile, "utf8"));
  assert.equal(JSON.stringify(restored.request), JSON.stringify(original.request));
  assert.equal(restored.requestDigest, original.requestDigest);
  assert.equal(restored.effect.effectId, original.effect.effectId);
  assert.equal(restored.mayDispatch, false);
  assert.equal(kernel.projectRun(binding.runId).cursor, cursor, "Restoring a file does not mutate the durable run");
  assert.equal(kernel.projectRun(binding.runId).effects.length, 1);
  const receipt = path.join(exchange, "return.json");
  await writeFile(receipt, JSON.stringify({ structuredContent: { threadId: input.payload.targetThreadId } }));
  const committed = await runLiveHostContinuationCli(["commit", ...sharedArgs, "--input", receipt, "--request", outputFile, "--outcome", "returned"]);
  assert.equal(committed.status, "receipt_recorded", "The original receipt can complete reconciliation through the restored artifact");
  assert.equal(committed.completionVerified, false);
});

test("a command recorded before its effect reservation fails returns a bounded recovery instruction", async (t) => {
  const { root, kernel, binding, workOrder, input, nowMs } = await hostFixture(t);
  const commandStore = createLiveContinuationCommandStore({ projectRoot: root });
  let dispatchCount = 0;
  const adapterRegistry = createLiveRuntimeAdapterRegistry({ adapters: [{ adapterId: "codex-host-threads", runtime: "codex",
    capabilities: ["handoff", "resume"], execute() { dispatchCount += 1; throw new Error("Host dispatch is not part of this test"); } }] });
  const authorize = async ({ command: value }) => ({ status: "ready", commandDigest: value.commandDigest,
    targetThreadId: value.payload.targetThreadId, workOrderDigest: value.payload.workOrderDigest, approvalRef: value.payload.approvalRef });
  const options = { command: input, workOrder, commandStore, adapterRegistry, durableRepository: kernel, authorize, nowMs };
  const interrupted = new Proxy(kernel, { get(target, key) {
    if (key === "prepareEffect") return () => { throw new Error("Interruption before the durable effect transaction"); };
    const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
  } });
  await assert.rejects(prepareLiveHostContinuation({ ...options, durableRepository: interrupted }), /Interruption/);
  const cursor = kernel.projectRun(binding.runId).cursor;
  await assert.rejects(prepareLiveHostContinuation(options), (error) => {
    assert.equal(error.code, "LIVE_CONTINUATION_EFFECT_RESERVATION_INCOMPLETE");
    assert.equal(error.recovery.commandId, input.commandId);
    assert.equal(error.recovery.commandDigest, input.commandDigest);
    assert.equal(error.recovery.mayDispatch, false);
    assert.match(error.recovery.nextAction, /reconcile.*receipt.*before a new dispatch/iu);
    return true;
  });
  assert.equal((await commandStore.list()).length, 1, "The original nonce and audit record are preserved");
  assert.equal(kernel.projectRun(binding.runId).effects.length, 0, "Recovery does not manufacture missing authority");
  assert.equal(kernel.projectRun(binding.runId).cursor, cursor);
  assert.equal(dispatchCount, 0);
});

test("CLI parse failures identify the exchange role without exposing its contents", async (t) => {
  const cases = [
    ["input", "LIVE_HOST_INPUT_JSON_INVALID"],
    ["existing", "LIVE_HOST_EXISTING_EXCHANGE_JSON_INVALID"],
    ["request", "LIVE_HOST_REQUEST_JSON_INVALID"],
  ];
  for (const [role, expectedCode] of cases) {
    await t.test(role, async (t) => {
      const { root, db, kernel, binding, workOrder, input } = await hostFixture(t);
      const exchange = path.join(root, ".meta-kim/work/exchange");
      await mkdir(exchange, { recursive: true });
      const inputFile = path.join(exchange, "input.json");
      const outputFile = path.join(exchange, "request.json");
      const workOrderFile = path.join(exchange, "work-order.txt");
      const sentinel = "PRIVATE_TOOL_COMMAND_DO_NOT_EMIT";
      await writeFile(inputFile, role === "input" ? sentinel : JSON.stringify(input));
      await writeFile(workOrderFile, workOrder);
      if (role !== "input") await writeFile(outputFile, sentinel);
      const cursor = kernel.projectRun(binding.runId).cursor;
      const args = role === "request"
        ? ["commit", "--project-root", root, "--db", db, "--input", inputFile, "--request", outputFile]
        : ["prepare", "--project-root", root, "--db", db, "--input", inputFile, "--output", outputFile,
          "--work-order", workOrderFile, "--authorized-command-digest", input.commandDigest, "--approval-ref", input.payload.approvalRef];
      await assert.rejects(runNode(process.execPath, [path.resolve("scripts/live-host-continuation.mjs"), ...args],
        { timeout: 10_000 }), (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, "");
        assert.ok(!error.stderr.includes(sentinel.slice(0, 10)), "Even a parser's shortened source excerpt must stay private");
        const envelope = JSON.parse(error.stderr.trim().split("\n").find((line) => line.startsWith('{"status":')));
        assert.equal(envelope.code, expectedCode);
        assert.equal(envelope.recovery.artifactRole, role);
        assert.equal(envelope.recovery.mayDispatch, false);
        assert.equal(envelope.recovery.readOnly, true);
        return true;
      });
      assert.equal(kernel.projectRun(binding.runId).cursor, cursor);
      assert.equal(kernel.projectRun(binding.runId).effects.length, 0, "Parsing never reserves or dispatches an effect");
      assert.equal((await createLiveContinuationCommandStore({ projectRoot: root }).list()).length, 0);
      assert.equal(await readFile(role === "input" ? inputFile : outputFile, "utf8"), sentinel);
    });
  }
});
