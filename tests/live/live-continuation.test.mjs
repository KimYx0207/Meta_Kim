import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LIVE_CONTINUATION_ACTIONS,
  LIVE_CONTINUATION_COMMAND_SCHEMA_VERSION,
  createLiveContinuationCommand,
  validateLiveContinuationCommand,
} from "../../src/domain/live/live-continuation-command.mjs";
import {
  createLiveContinuationPlanner,
  executeLiveContinuation,
  planLiveContinuation,
} from "../../src/application/live/plan-live-continuation.mjs";
import { createLiveContinuationCommandStore } from "../../src/infrastructure/live/live-continuation-command-store.mjs";
import {
  createLiveRuntimeAdapterRegistry,
  createFakeLiveRuntimeAdapter,
} from "../../src/infrastructure/live/live-runtime-adapter-registry.mjs";

const DIGEST = "sha256:" + "a".repeat(64);

function command(overrides = {}) {
  return createLiveContinuationCommand({
    commandId: "continuation-command-1",
    action: "resume",
    runId: "run-live-1",
    nodeId: "node-live-1",
    expectedRevision: 1,
    checkpointId: "checkpoint-live-1",
    effectState: "none",
    claim: {
      attemptId: "attempt-live-1",
      ownerId: "worker-a",
      leaseExpiresAtMs: 20_000,
      fenceToken: 3,
    },
    actor: "actor-a",
    runtimeAdapter: "fake-codex",
    runtime: "codex",
    nonce: "nonce-live-1",
    expiresAtMs: 10_000,
    issuedAtMs: 1_000,
    payload: {},
    ...overrides,
  });
}

function authority(overrides = {}) {
  return {
    runId: "run-live-1",
    graphDigest: "graph-live-1",
    taskFingerprint: "task-live-1",
    cursor: 1,
    revision: 1,
    headCheckpointId: "checkpoint-live-1",
    status: "active",
    resumable: true,
    activeClaims: [{
      runId: "run-live-1",
      nodeId: "node-live-1",
      attemptId: "attempt-live-1",
      fenceToken: 3,
      leaseOwner: "worker-a",
      leaseExpiresAtMs: 20_000,
    }],
    blockingEffects: [],
    ...overrides,
  };
}

function repository(overrides = {}) {
  let effectId = null;
  return {
    resumeRun() { return authority(); },
    verifyEventChain() { return { ok: true }; },
    appendEvent() { return { eventSeq: 2 }; },
    prepareEffect(input) {
      effectId = input.effectId;
      return { effectId, state: "prepared" };
    },
    markEffectDispatchStarted(input) {
      return { effectId: input.effectId, state: "dispatch_started" };
    },
    markUnresolvedEffectsInDoubt({ runId }) {
      return { runId, effectIds: effectId ? [effectId] : [] };
    },
    ...overrides,
  };
}

test("M3-L03 red contract: command schema binds action, authority, lease, actor, adapter and expiry", () => {
  assert.deepEqual(LIVE_CONTINUATION_ACTIONS, ["pause", "resume", "reassign", "handoff"]);
  const value = command();
  assert.equal(value.schemaVersion, LIVE_CONTINUATION_COMMAND_SCHEMA_VERSION);
  assert.equal(value.runId, "run-live-1");
  assert.equal(value.nodeId, "node-live-1");
  assert.equal(value.claim.fenceToken, 3);
  assert.equal(value.runtimeAdapter, "fake-codex");
  assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(validateLiveContinuationCommand(value), value);
});

test("M3-L03 red contract: malformed and expired commands fail closed", () => {
  for (const invalid of [
    { ...command(), action: "unknown" },
    { ...command(), runId: "../outside" },
    { ...command(), expectedRevision: -1 },
    { ...command(), claim: { ...command().claim, fenceToken: 0 } },
    { ...command(), effectState: "dispatch_started" },
    { ...command(), expiresAtMs: 1_000 },
  ]) {
    assert.throws(() => validateLiveContinuationCommand(invalid));
  }
});

test("M3-L03 red contract: planner reuses durable authority and produces a bounded resume plan", async () => {
  const planned = await planLiveContinuation({
    command: command(),
    repository: repository(),
    adapterRegistry: createLiveRuntimeAdapterRegistry({ adapters: [createFakeLiveRuntimeAdapter({ adapterId: "fake-codex", runtime: "codex" })] }),
    nowMs: 2_000,
  });
  assert.equal(planned.status, "planned");
  assert.equal(planned.resumePlan.runId, "run-live-1");
  assert.equal(planned.resumePlan.checkpointId, "checkpoint-live-1");
  assert.equal(planned.resumePlan.executionAllowed, false);
  assert.equal(planned.resumePlan.schedulerAuthority, "durable_run_repository");
});

test("M3-L03 red contract: planner rejects stale authority, lease/fence mismatch, effects, adapter and runtime", async () => {
  const registry = createLiveRuntimeAdapterRegistry({ adapters: [createFakeLiveRuntimeAdapter({ adapterId: "fake-codex", runtime: "codex" })] });
  const cases = [
    { nowMs: 30_000 },
    { repository: repository({ resumeRun() { return authority({ cursor: 2, revision: 2 }); } }) },
    { repository: repository({ resumeRun() { return authority({ activeClaims: [{ ...authority().activeClaims[0], fenceToken: 4 }] }); } }) },
    { repository: repository({ resumeRun() { return authority({ blockingEffects: [{ effectId: "effect-1", state: "in_doubt" }] }); } }) },
    { command: command({ runtimeAdapter: "missing" }) },
    { command: command({ runtime: "unsupported" }) },
  ];
  for (const fixture of cases) {
    await assert.rejects(() => planLiveContinuation({
      command: fixture.command ?? command(),
      repository: fixture.repository ?? repository(),
      adapterRegistry: registry,
      nowMs: fixture.nowMs ?? 2_000,
    }));
  }
});

test("M3-L03 execution revalidates authority drift after planning before invoking the adapter", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "meta-kim-live-drift-"));
  await mkdir(path.join(projectRoot, ".git"));
  await mkdir(path.join(projectRoot, ".meta-kim"));
  let currentAuthority = authority();
  let preparedEffectId = null;
  const durableRepository = {
    resumeRun() { return currentAuthority; },
    verifyEventChain() { return { ok: true, runId: "run-live-1" }; },
    prepareEffect({ effectId }) { preparedEffectId = effectId; return { effectId, state: "prepared" }; },
    markEffectDispatchStarted({ effectId }) { return { effectId, state: "dispatch_started" }; },
    markUnresolvedEffectsInDoubt({ runId }) { return { runId, effectIds: preparedEffectId ? [preparedEffectId] : [] }; },
  };
  const calls = [];
  const registry = createLiveRuntimeAdapterRegistry({ adapters: [createFakeLiveRuntimeAdapter({
    adapterId: "fake-codex",
    runtime: "codex",
    execute(request) { calls.push(request); return { accepted: true }; },
  })] });
  const commandStore = createLiveContinuationCommandStore({ projectRoot, clock: () => 2_000 });
  const drifts = [
    authority({ revision: 2, cursor: 2 }),
    authority({ activeClaims: [{ ...authority().activeClaims[0], fenceToken: 4 }] }),
    authority({ activeClaims: [{ ...authority().activeClaims[0], leaseExpiresAtMs: 1_500 }] }),
    authority({ blockingEffects: [{ effectId: "effect-1", state: "in_doubt" }] }),
  ];
  try {
    for (const [index, drift] of drifts.entries()) {
      const planned = await planLiveContinuation({
        command: command({ commandId: `continuation-drift-${index}`, nonce: `nonce-drift-${index}` }),
        repository: durableRepository,
        adapterRegistry: registry,
        nowMs: 2_000,
      });
      currentAuthority = drift;
      await assert.rejects(() => executeLiveContinuation({
        plan: planned,
        durableRepository,
        adapterRegistry: registry,
        commandStore,
        nowMs: 2_000,
      }));
      currentAuthority = authority();
    }
    assert.equal(calls.length, 0);
    assert.equal((await commandStore.list()).length, 0);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("M3-L03 red contract: project-local command log is path-safe, append-only and CAS guarded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-kim-live-continuation-"));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, ".meta-kim"));
  try {
    const store = createLiveContinuationCommandStore({ projectRoot: root, profile: "default", clock: () => 2_000 });
    const first = await store.append(command());
    assert.equal(first.revision, 1);
    await assert.rejects(() => store.append(command({ commandId: "continuation-command-2", nonce: "nonce-live-1" })), /nonce/iu);
    await assert.rejects(() => store.append(command({ commandId: "continuation-command-2", nonce: "nonce-live-2", expectedRevision: 2 }), { expectedRevision: 0 }), /CAS|revision/iu);
    const records = await store.list();
    assert.equal(records.length, 1);
    assert.equal((await readFile(store.filePath, "utf8")).trim().split("\n").length, 1);
    assert.throws(() => createLiveContinuationCommandStore({ projectRoot: root, filePath: path.join(root, "outside.jsonl") }), /path|local|safe/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("M3-L03 red contract: only an explicitly capable injected adapter may produce a side effect", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "meta-kim-live-execution-"));
  await mkdir(path.join(projectRoot, ".git"));
  await mkdir(path.join(projectRoot, ".meta-kim"));
  const calls = [];
  const adapter = createFakeLiveRuntimeAdapter({
    adapterId: "fake-codex",
    runtime: "codex",
    capabilities: ["resume"],
    execute(request) {
      calls.push(request);
      return { accepted: true, requestId: "fake-request-1" };
    },
  });
  const registry = createLiveRuntimeAdapterRegistry({ adapters: [adapter] });
  const durableRepository = repository();
  const commandStore = createLiveContinuationCommandStore({ projectRoot, clock: () => 2_000 });
  try {
    const planner = createLiveContinuationPlanner({ repository: durableRepository, adapterRegistry: registry, nowMs: 2_000 });
    const planned = await planner.plan(command());
    await assert.rejects(() => executeLiveContinuation({ plan: planned, adapterRegistry: registry, durableRepository, nowMs: 2_000 }), /store/iu);
    const result = await executeLiveContinuation({ plan: planned, adapterRegistry: registry, durableRepository, commandStore, nowMs: 2_000 });
    assert.equal(result.status, "adapter_invoked");
    assert.equal(result.result.accepted, true);
    assert.equal(result.adapterInvocationObserved, true);
    assert.equal(result.effectState, "in_doubt");
    assert.equal(result.completionVerified, false);
    assert.equal(calls.length, 1);
    await assert.rejects(() => executeLiveContinuation({ plan: planned, adapterRegistry: createLiveRuntimeAdapterRegistry(), durableRepository, commandStore, nowMs: 2_000 }));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("M3-L03 execution requires the durable effect protocol and rejects authority injection", async () => {
  const registry = createLiveRuntimeAdapterRegistry({ adapters: [createFakeLiveRuntimeAdapter({ adapterId: "fake-codex", runtime: "codex" })] });
  await assert.rejects(() => planLiveContinuation({
    command: command(),
    repository: repository(),
    adapterRegistry: registry,
    authority: authority({ cursor: 99, revision: 99 }),
    nowMs: 2_000,
  }), /authority injection/iu);

  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "meta-kim-live-effect-required-"));
  await mkdir(path.join(projectRoot, ".git"));
  await mkdir(path.join(projectRoot, ".meta-kim"));
  const durableRepository = {
    resumeRun() { return authority(); },
    verifyEventChain() { return { ok: true, runId: "run-live-1" }; },
  };
  const commandStore = createLiveContinuationCommandStore({ projectRoot, clock: () => 2_000 });
  try {
    const planned = await planLiveContinuation({ command: command(), repository: durableRepository, adapterRegistry: registry, nowMs: 2_000 });
    await assert.rejects(() => executeLiveContinuation({ plan: planned, durableRepository, adapterRegistry: registry, commandStore, nowMs: 2_000 }), /prepareEffect/iu);
    assert.equal((await commandStore.list()).length, 0);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("M3-L03 adapter failure leaves an auditable in-doubt effect and consumes the command nonce", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "meta-kim-live-effect-failure-"));
  await mkdir(path.join(projectRoot, ".git"));
  await mkdir(path.join(projectRoot, ".meta-kim"));
  let preparedEffectId = null;
  const effectStates = [];
  const durableRepository = {
    resumeRun() { return authority(); },
    verifyEventChain() { return { ok: true, runId: "run-live-1" }; },
    prepareEffect({ effectId }) { preparedEffectId = effectId; effectStates.push("prepared"); return { effectId, state: "prepared" }; },
    markEffectDispatchStarted({ effectId }) { effectStates.push("dispatch_started"); return { effectId, state: "dispatch_started" }; },
    markUnresolvedEffectsInDoubt({ runId }) { effectStates.push("in_doubt"); return { runId, effectIds: [preparedEffectId] }; },
  };
  let adapterCalls = 0;
  const registry = createLiveRuntimeAdapterRegistry({ adapters: [createFakeLiveRuntimeAdapter({
    adapterId: "fake-codex",
    runtime: "codex",
    execute() { adapterCalls += 1; throw new Error("fake adapter unavailable"); },
  })] });
  const commandStore = createLiveContinuationCommandStore({ projectRoot, clock: () => 2_000 });
  try {
    const planned = await planLiveContinuation({ command: command(), repository: durableRepository, adapterRegistry: registry, nowMs: 2_000 });
    await assert.rejects(() => executeLiveContinuation({ plan: planned, durableRepository, adapterRegistry: registry, commandStore, nowMs: 2_000 }), (error) => {
      assert.equal(error.code, "LIVE_CONTINUATION_ADAPTER_INVOCATION_FAILED");
      assert.equal(error.executionResult.status, "adapter_failed");
      assert.equal(error.executionResult.effectState, "in_doubt");
      assert.equal(error.executionResult.completionVerified, false);
      return true;
    });
    assert.deepEqual(effectStates, ["prepared", "dispatch_started", "in_doubt"]);
    assert.equal((await commandStore.list()).length, 1);
    await assert.rejects(() => executeLiveContinuation({ plan: planned, durableRepository, adapterRegistry: registry, commandStore, nowMs: 2_000 }), /nonce|replay/iu);
    assert.equal(adapterCalls, 1);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
