import assert from "node:assert/strict";
import test from "node:test";

import {
  commandCoreForDigest,
  createLiveContinuationCommand,
  digestLiveContinuationCommand,
  isLiveContinuationCommand,
  validateLiveContinuationCommand,
} from "../../src/domain/live/live-continuation-command.mjs";
import { planLiveContinuation } from "../../src/application/live/plan-live-continuation.mjs";
import {
  createFakeLiveRuntimeAdapter,
  createLiveRuntimeAdapterRegistry,
} from "../../src/infrastructure/live/live-runtime-adapter-registry.mjs";
import {
  SDK_AUTHORITY,
  assertValidRuntimeAdapterResult,
  defineRuntimeAdapter,
  normalizeRuntimeObservation,
  runRuntimeAdapter,
} from "../../src/sdk/live/index.mjs";
import {
  buildLiveShareArtifact,
  canonicalizeLiveShareArtifact,
  isLiveShareArtifactValid,
  verifyLiveShareArtifact,
} from "../../src/domain/live/live-share-artifact.mjs";

function command(overrides = {}) {
  return createLiveContinuationCommand({
    action: "resume",
    runId: "run-coverage",
    nodeId: "node-coverage",
    expectedRevision: 4,
    checkpointId: "checkpoint-coverage",
    effectState: "none",
    claim: {
      attemptId: "attempt-coverage",
      ownerId: "owner-coverage",
      leaseExpiresAtMs: 20_000,
      fenceToken: 7,
    },
    actor: "actor-coverage",
    runtimeAdapter: "adapter-coverage",
    runtime: "test",
    nonce: "nonce-coverage",
    issuedAtMs: 1_000,
    expiresAtMs: 10_000,
    payload: {},
    ...overrides,
  });
}

function authority(overrides = {}) {
  return {
    runId: "run-coverage",
    status: "active",
    resumable: true,
    revision: 4,
    cursor: 4,
    headCheckpointId: "checkpoint-coverage",
    checkpointId: "checkpoint-coverage",
    activeClaims: [{
      nodeId: "node-coverage",
      attemptId: "attempt-coverage",
      ownerId: "owner-coverage",
      leaseExpiresAtMs: 20_000,
      fenceToken: 7,
    }],
    effects: [],
    ...overrides,
  };
}

function repository(authorityOverride = authority(), verification = { ok: true, runId: "run-coverage" }) {
  return {
    resumeRun: async () => authorityOverride,
    verifyEventChain: async () => verification,
  };
}

function registry() {
  return createLiveRuntimeAdapterRegistry({
    adapters: [createFakeLiveRuntimeAdapter({
      adapterId: "adapter-coverage",
      runtime: "test",
      capabilities: { resume: true, pause: false },
    })],
  });
}

function expectCode(operation, code) {
  assert.throws(operation, (error) => error?.code === code);
}

test("runtime adapter registry validates aliases, capabilities, bindings, and invocation", async () => {
  const calls = [];
  const adapters = createLiveRuntimeAdapterRegistry();
  const registered = adapters.register({
    id: "adapter-alias",
    runtime: "fixture",
    capabilities: ["live.continuation.resume", "continuation.resume", "pause"],
    invoke: async (request) => {
      calls.push(request);
      return { accepted: true };
    },
  });

  assert.deepEqual(registered.capabilities, ["pause", "resume"]);
  assert.equal(adapters.has("adapter-alias", { runtime: "fixture", action: "resume" }), true);
  assert.equal(adapters.has("missing"), false);
  assert.equal(adapters.get({ id: "adapter-alias" }), registered);
  assert.deepEqual(adapters.list(), [registered]);
  const result = await adapters.invoke("adapter-alias", { action: "resume", runtime: "fixture", marker: "safe" });
  assert.equal(result.result.accepted, true);
  assert.equal(calls[0].adapterId, "adapter-alias");
  assert.equal(calls[0].runtime, "fixture");
});

test("runtime adapter registry rejects malformed definitions and incompatible bindings", async () => {
  for (const build of [
    () => createLiveRuntimeAdapterRegistry({ adapters: {} }),
    () => createLiveRuntimeAdapterRegistry({ adapters: [null] }),
    () => createLiveRuntimeAdapterRegistry({ adapters: [{ adapterId: "bad/path", runtime: "test", capabilities: ["resume"], execute() {} }] }),
    () => createLiveRuntimeAdapterRegistry({ adapters: [{ adapterId: "valid", runtime: "unknown", capabilities: ["resume"], execute() {} }] }),
    () => createLiveRuntimeAdapterRegistry({ adapters: [{ adapterId: "valid", runtime: "test", capabilities: [], execute() {} }] }),
    () => createLiveRuntimeAdapterRegistry({ adapters: [{ adapterId: "valid", runtime: "test", capabilities: [1], execute() {} }] }),
    () => createLiveRuntimeAdapterRegistry({ adapters: [{ adapterId: "valid", runtime: "test", capabilities: ["delete"], execute() {} }] }),
    () => createLiveRuntimeAdapterRegistry({ adapters: [{ adapterId: "valid", runtime: "test", capabilities: ["resume"] }] }),
    () => createLiveRuntimeAdapterRegistry({ adapters: [{ adapterId: "valid", runtime: "test", capabilities: ["resume"], execute: true }] }),
    () => createLiveRuntimeAdapterRegistry({ adapters: [{ adapterId: "valid", runtime: "test", capabilities: ["resume"], execute() {}, sideEffectMode: "implicit" }] }),
  ]) assert.throws(build);

  const adapters = createLiveRuntimeAdapterRegistry({ adapters: [createFakeLiveRuntimeAdapter({
    adapterId: "bound",
    runtime: "test",
    capabilities: ["resume"],
  })] });
  expectCode(() => adapters.register(createFakeLiveRuntimeAdapter({ adapterId: "bound", runtime: "test" })), "LIVE_RUNTIME_ADAPTER_DUPLICATE");
  expectCode(() => adapters.resolve(null), "LIVE_RUNTIME_ADAPTER_REQUIRED");
  expectCode(() => adapters.resolve("missing"), "LIVE_RUNTIME_ADAPTER_UNKNOWN");
  expectCode(() => adapters.resolve("bound", { runtime: "fake" }), "LIVE_RUNTIME_ADAPTER_RUNTIME_MISMATCH");
  expectCode(() => adapters.resolve("bound", { action: "pause" }), "LIVE_RUNTIME_ADAPTER_CAPABILITY_MISSING");
  await assert.rejects(adapters.invoke("bound", { action: "delete" }), (error) => error?.code === "LIVE_RUNTIME_ADAPTER_ACTION_UNSUPPORTED");
});

test("continuation command supports documented aliases and produces stable digest helpers", () => {
  const value = createLiveContinuationCommand({
    action: "pause",
    runId: "run-alias",
    nodeId: "node-alias",
    expectedRevision: 0,
    checkpointId: null,
    effectState: "reconciled",
    attemptId: null,
    leaseOwner: "owner-alias",
    leaseExpiresAt: "2026-01-01T00:00:20.000Z",
    fenceToken: 1,
    actor: { id: "actor-alias" },
    runtimeAdapter: { id: "adapter-alias", runtime: "fixture" },
    nonce: "nonce-alias",
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:00:10.000Z",
    payload: { nested: [null, true, 3, { safe: "value" }] },
  });

  assert.match(value.commandId, /^continuation-/u);
  assert.equal(value.runtime, "fixture");
  assert.equal(value.claim.attemptId, null);
  assert.equal(validateLiveContinuationCommand(value).commandDigest, value.commandDigest);
  assert.equal(digestLiveContinuationCommand(value), value.commandDigest);
  assert.equal(commandCoreForDigest(value).runId, "run-alias");
  assert.equal(isLiveContinuationCommand(value), true);
  assert.equal(isLiveContinuationCommand({}), false);
});

test("continuation command rejects malformed envelopes and sensitive payload material", () => {
  const valid = command();
  const invalid = [
    null,
    [],
    { ...valid, unsupported: true },
    { ...valid, schemaVersion: "old" },
    { ...valid, kind: "other" },
    { ...valid, checkpointId: undefined },
    { ...valid, claim: undefined },
    { ...valid, actor: undefined },
    { ...valid, runtimeAdapter: undefined },
    { ...valid, runtime: "Bad Runtime" },
    { ...valid, nonce: "https://example.test" },
    { ...valid, issuedAtMs: "not-a-date" },
    { ...valid, expiresAtMs: -1 },
    { ...valid, payload: { password: "redacted" } },
    { ...valid, payload: { safe: "ghp_0123456789abcdef" } },
    { ...valid, payload: { safe: Number.NaN } },
    { ...valid, payload: new Date() },
    { ...valid, commandDigest: "sha256:wrong" },
  ];
  for (const value of invalid) assert.throws(() => validateLiveContinuationCommand(value));

  const withoutCheckpoint = { ...valid };
  delete withoutCheckpoint.checkpointId;
  assert.throws(() => validateLiveContinuationCommand(withoutCheckpoint), /checkpointId/iu);
  const withoutDigest = { ...valid };
  delete withoutDigest.commandDigest;
  assert.throws(() => validateLiveContinuationCommand(withoutDigest), /commandDigest/iu);
});

test("continuation planner rejects every contradictory durable-authority boundary", async () => {
  const adapters = registry();
  const cases = [
    [repository(null), "LIVE_CONTINUATION_AUTHORITY_UNAVAILABLE"],
    [repository(authority({ runId: "other-run" })), "LIVE_CONTINUATION_AUTHORITY_MISMATCH"],
    [repository(authority({ revision: undefined, cursor: undefined })), "LIVE_CONTINUATION_AUTHORITY_UNAVAILABLE"],
    [repository(authority({ headCheckpointId: "other", checkpointId: "other" })), "LIVE_CONTINUATION_CHECKPOINT_MISMATCH"],
    [repository(authority(), { ok: false }), "LIVE_CONTINUATION_EVENT_CHAIN_UNVERIFIED"],
    [repository(authority(), { ok: true, runId: "other-run" }), "LIVE_CONTINUATION_AUTHORITY_MISMATCH"],
    [repository(authority({ revision: 4, cursor: 5 })), "LIVE_CONTINUATION_AUTHORITY_CONTRADICTORY"],
    [repository(authority({ headCheckpointId: "checkpoint-coverage", checkpointId: "other" })), "LIVE_CONTINUATION_AUTHORITY_CONTRADICTORY"],
    [repository(authority({ status: "completed" })), "LIVE_CONTINUATION_RUN_NOT_ACTIVE"],
    [repository(authority({ resumable: false })), "LIVE_CONTINUATION_NOT_RESUMABLE"],
    [repository(authority({ effects: [{ state: "dispatch_started" }] })), "LIVE_CONTINUATION_EFFECT_UNRECONCILED"],
    [repository(authority({ activeClaims: [] })), "LIVE_CONTINUATION_CLAIM_CONTRADICTORY"],
    [repository(authority({ activeClaims: [authority().activeClaims[0], authority().activeClaims[0]] })), "LIVE_CONTINUATION_CLAIM_CONTRADICTORY"],
    [repository(authority({ activeClaims: [{ ...authority().activeClaims[0], leaseExpiresAtMs: 1_500 }] })), "LIVE_CONTINUATION_LEASE_EXPIRED"],
    [repository(authority({ activeClaims: [{ ...authority().activeClaims[0], attemptId: "other" }] })), "LIVE_CONTINUATION_CLAIM_MISMATCH"],
    [repository(authority({ activeClaims: [{ ...authority().activeClaims[0], ownerId: "other" }] })), "LIVE_CONTINUATION_LEASE_MISMATCH"],
    [repository(authority({ activeClaims: [{ ...authority().activeClaims[0], fenceToken: 8 }] })), "LIVE_CONTINUATION_FENCE_MISMATCH"],
  ];

  for (const [durableRepository, code] of cases) {
    await assert.rejects(
      planLiveContinuation({ command: command(), repository: durableRepository, adapterRegistry: adapters, nowMs: 2_000 }),
      (error) => error?.code === code,
      code,
    );
  }
});

test("continuation planner validates dependencies, clock, targets, and command lease bounds", async () => {
  const adapters = registry();
  await assert.rejects(planLiveContinuation({ command: command(), adapterRegistry: adapters, nowMs: 2_000 }), /repository/iu);
  await assert.rejects(planLiveContinuation({ command: command(), repository: {}, adapterRegistry: adapters, nowMs: 2_000 }), /resumeRun/iu);
  await assert.rejects(planLiveContinuation({ command: command(), repository: repository(), adapterRegistry: {}, nowMs: 2_000 }), /registry/iu);
  await assert.rejects(planLiveContinuation({ command: command(), repository: repository(), adapterRegistry: adapters, nowMs: -1 }), /clock/iu);
  await assert.rejects(planLiveContinuation({ command: command(), repository: repository(), adapterRegistry: adapters, authority: {}, nowMs: 2_000 }), /injection/iu);
  await assert.rejects(planLiveContinuation(command({ action: "reassign" }), { repository: repository(), adapterRegistry: adapters, nowMs: 2_000 }), /target/iu);
  await assert.rejects(planLiveContinuation(command({ action: "handoff" }), { repository: repository(), adapterRegistry: adapters, nowMs: 2_000 }), /target/iu);
  await assert.rejects(planLiveContinuation({
    command: command({ expiresAtMs: 10_000, claim: { ...command().claim, leaseExpiresAtMs: 9_000 } }),
    repository: repository(authority({ activeClaims: [{ ...authority().activeClaims[0], leaseExpiresAtMs: 9_000 }] })),
    adapterRegistry: adapters,
    nowMs: 2_000,
  }), (error) => error?.code === "LIVE_CONTINUATION_LEASE_MISMATCH");
});

test("public runtime SDK normalizes aliases, optional events, and nullable stages", async () => {
  const observation = normalizeRuntimeObservation({
    status: "active",
    stage: null,
    observedAt: "2026-08-24T10:00:00Z",
    summary: "",
    events: [
      { at: "2026-08-24T10:00:01Z", kind: "stage", status: "passed", label: "Stage passed" },
      { at: "2026-08-24T10:00:02Z", kind: "error", status: "error", label: "Safe failure" },
    ],
  });
  assert.equal(observation.status, "running");
  assert.equal(observation.stage, null);
  assert.deepEqual(observation.events.map(({ status }) => status), ["completed", "failed"]);

  const adapter = defineRuntimeAdapter({
    id: "coverage-runtime",
    version: "1.2.3-beta.1",
    label: "Coverage runtime",
    capabilities: ["project", "normalize"],
    normalize: async () => ({
      status: "pass",
      stage: "verification",
      observedAt: "2026-08-24T10:00:00Z",
      summary: "verified",
    }),
  });
  const result = await runRuntimeAdapter(adapter, {});
  assert.equal(result.observation.status, "completed");
  assert.deepEqual(assertValidRuntimeAdapterResult(result), result);
  assert.deepEqual(result.authority, SDK_AUTHORITY);
});

test("public runtime SDK rejects hostile records, arrays, manifests, and authority claims", async () => {
  const hostilePrototype = new Proxy({}, { getPrototypeOf() { throw new Error("hostile"); } });
  const symbolRecord = { status: "running", stage: "execution", observedAt: "2026-08-24T10:00:00Z", summary: "safe" };
  symbolRecord[Symbol("hidden")] = true;
  const accessorRecord = { status: "running", stage: "execution", observedAt: "2026-08-24T10:00:00Z" };
  Object.defineProperty(accessorRecord, "summary", { enumerable: true, get() { return "unsafe"; } });
  const hostileEvents = [];
  hostileEvents.extra = true;

  for (const [label, value] of [
    ["hostile prototype", hostilePrototype],
    ["symbol record", symbolRecord],
    ["accessor record", accessorRecord],
    ["unknown status", { status: "unknown-status", stage: "execution", observedAt: "2026-08-24T10:00:00Z", summary: "safe" }],
    ["unsafe stage", { status: "running", stage: "Bad Stage", observedAt: "2026-08-24T10:00:00Z", summary: "safe" }],
    ["bad timestamp", { status: "running", stage: "execution", observedAt: "bad-date", summary: "safe" }],
    ["hostile events", { status: "running", stage: "execution", observedAt: "2026-08-24T10:00:00Z", summary: "safe", events: hostileEvents }],
  ]) assert.throws(() => normalizeRuntimeObservation(value), undefined, label);

  await assert.rejects(runRuntimeAdapter(null, {}), /defineRuntimeAdapter/iu);
  const adapter = defineRuntimeAdapter({
    id: "sdk-hostile-check",
    version: "1.0.0",
    label: "SDK hostile check",
    capabilities: ["normalize"],
    normalize: () => ({ status: "running", stage: "execution", observedAt: "2026-08-24T10:00:00Z", summary: "safe" }),
  });
  await assert.rejects(runRuntimeAdapter({ ...adapter, schemaVersion: "old" }, {}), /unsupported/iu);
  await assert.rejects(runRuntimeAdapter({
    ...adapter,
    capabilityDeclaration: { ...adapter.capabilityDeclaration, authority: "authoritative" },
  }, {}), /projection/iu);
  await assert.rejects(runRuntimeAdapter({
    ...adapter,
    capabilityDeclaration: { ...adapter.capabilityDeclaration, capabilities: ["project", "normalize"] },
  }, {}), /canonical/iu);
});

test("share verification and canonicalization fail closed for non-record and hostile inputs", () => {
  for (const value of [null, [], "share", 1]) {
    assert.equal(verifyLiveShareArtifact(value).valid, false);
    assert.throws(() => canonicalizeLiveShareArtifact(value), /object/iu);
  }

  const snapshot = {
    schemaVersion: "meta-kim-live-snapshot-v1",
    source: { kind: "local", observedAt: "2026-08-24T10:00:00Z", stale: true },
    run: { runId: "coverage-share", status: "active", currentStage: null, updatedAt: null },
    nodes: [],
    edges: [],
    evidence: [],
    replay: { schemaVersion: "meta-kim-live-replay-v1", events: [] },
  };
  const artifact = buildLiveShareArtifact({ snapshot });
  assert.equal(verifyLiveShareArtifact(artifact).valid, true);
  assert.equal(isLiveShareArtifactValid(artifact), true);
  assert.equal(isLiveShareArtifactValid({}), false);
  assert.equal(canonicalizeLiveShareArtifact(artifact).run.runId, "coverage-share");

  const symbolSnapshot = { ...snapshot, [Symbol("hidden")]: true };
  assert.throws(() => buildLiveShareArtifact({ snapshot: symbolSnapshot }), /symbol/iu);
  const sparseReplay = { ...snapshot, replay: [] };
  sparseReplay.replay.length = 1;
  assert.throws(() => buildLiveShareArtifact({ snapshot: sparseReplay }), /dense|data property/iu);
  assert.throws(() => buildLiveShareArtifact({ snapshot: { ...snapshot, replay: { schemaVersion: "old", events: [] } } }), /schema/iu);
});
