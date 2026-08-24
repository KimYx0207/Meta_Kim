import { canonicalDigest } from "../../domain/shared/canonical-digest.mjs";
import {
  createLiveContinuationCommand,
  validateLiveContinuationCommand,
} from "../../domain/live/live-continuation-command.mjs";

export const LIVE_CONTINUATION_PLAN_SCHEMA_VERSION =
  "meta-kim-live-continuation-plan-v1";
export const LIVE_CONTINUATION_PLAN_KIND = "live_continuation_resume_plan";
export const LIVE_CONTINUATION_AUTHORITY = "durable_run_repository";

function fail(message, code = "LIVE_CONTINUATION_PLAN_BLOCKED") {
  const error = new Error(`Live continuation planner: ${message}`);
  error.code = code;
  throw error;
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function repositoryFor(options) {
  const repository = options.repository ?? options.runRepository ?? options.durableRepository;
  if (!repository || typeof repository !== "object") {
    fail("durable run repository is required", "LIVE_CONTINUATION_AUTHORITY_REQUIRED");
  }
  for (const method of ["resumeRun", "verifyEventChain"]) {
    if (typeof repository[method] !== "function") {
      fail(`durable run repository is missing ${method}`, "LIVE_CONTINUATION_AUTHORITY_REQUIRED");
    }
  }
  return repository;
}

function registryFor(options) {
  const registry = options.adapterRegistry ?? options.runtimeAdapterRegistry;
  if (!registry || typeof registry.resolve !== "function") {
    fail("runtime adapter registry is required", "LIVE_CONTINUATION_ADAPTER_REQUIRED");
  }
  return registry;
}

function blockingEffects(authority) {
  const values = Array.isArray(authority?.blockingEffects)
    ? authority.blockingEffects
    : Array.isArray(authority?.effects)
      ? authority.effects.filter((effect) => !["reconciled_absent", "reconciled_completed", "reconciled", "none"].includes(effect?.state))
      : [];
  return values.filter((effect) => !["reconciled_absent", "reconciled_completed", "reconciled", "none"].includes(effect?.state));
}

function authorityRevision(authority) {
  const revision = authority?.revision ?? authority?.evaluationRevision ?? authority?.cursor;
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function authorityCheckpoint(authority) {
  return authority?.headCheckpointId ?? authority?.checkpointId ?? null;
}

function authorityClaims(authority) {
  if (!Array.isArray(authority?.activeClaims)) return [];
  return authority.activeClaims;
}

function claimMatches(command, authority, nowMs) {
  const claims = authorityClaims(authority);
  const matchingClaims = claims.filter((candidate) => candidate?.nodeId === command.nodeId);
  if (matchingClaims.length !== 1) {
    fail("authoritative claim set is missing or contradictory", "LIVE_CONTINUATION_CLAIM_CONTRADICTORY");
  }
  const claim = matchingClaims[0];
  if (!claim) fail("command node has no authoritative active claim", "LIVE_CONTINUATION_CLAIM_MISSING");
  const owner = claim.leaseOwner ?? claim.ownerId;
  const expiresAtMs = claim.leaseExpiresAtMs ?? claim.expiresAtMs;
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) {
    fail("node lease is expired", "LIVE_CONTINUATION_LEASE_EXPIRED");
  }
  if (command.claim.leaseExpiresAtMs <= nowMs) {
    fail("command lease binding is expired", "LIVE_CONTINUATION_LEASE_EXPIRED");
  }
  if (command.claim.attemptId !== null && command.claim.attemptId !== claim.attemptId) {
    fail("command attempt does not match the authoritative claim", "LIVE_CONTINUATION_CLAIM_MISMATCH");
  }
  if (command.claim.ownerId !== owner) {
    fail("command lease owner does not match the authoritative claim", "LIVE_CONTINUATION_LEASE_MISMATCH");
  }
  if (command.claim.fenceToken !== claim.fenceToken) {
    fail("command fence does not match the authoritative claim", "LIVE_CONTINUATION_FENCE_MISMATCH");
  }
  if (command.claim.leaseExpiresAtMs > expiresAtMs) {
    fail("command lease exceeds the authoritative lease window", "LIVE_CONTINUATION_LEASE_MISMATCH");
  }
  return {
    attemptId: claim.attemptId ?? null,
    ownerId: owner,
    leaseExpiresAtMs: expiresAtMs,
    fenceToken: claim.fenceToken,
  };
}

function targetRequirements(command) {
  const payload = command.payload ?? {};
  if (command.action === "reassign") {
    const target = payload.targetActorId ?? payload.targetOwnerId ?? payload.targetAgentId;
    if (typeof target !== "string" || !target) fail("reassign requires a target actor", "LIVE_CONTINUATION_TARGET_REQUIRED");
  }
  if (command.action === "handoff") {
    const target = payload.targetActorId ?? payload.targetOwnerId ?? payload.targetRuntimeAdapter;
    if (typeof target !== "string" || !target) fail("handoff requires a target owner or adapter", "LIVE_CONTINUATION_TARGET_REQUIRED");
  }
}

async function callResume(repository, command, options) {
  const payload = command.payload ?? {};
  const args = {
    runId: command.runId,
    graphDigest: options.graphDigest ?? payload.graphDigest,
    taskFingerprint: options.taskFingerprint ?? payload.taskFingerprint,
  };
  // The existing SQLite kernel requires graph/task bindings. A test double or
  // an already-bound repository may only need runId, so omit absent fields.
  for (const key of ["graphDigest", "taskFingerprint"]) if (args[key] === undefined) delete args[key];
  return repository.resumeRun(args);
}

async function callVerify(repository, command) {
  return repository.verifyEventChain(command.runId);
}

function normalizedAuthority(authority, command) {
  if (!authority || typeof authority !== "object" || Array.isArray(authority)) {
    fail("durable resume authority is unavailable", "LIVE_CONTINUATION_AUTHORITY_UNAVAILABLE");
  }
  if (authority.runId !== command.runId) fail("authority runId does not match command", "LIVE_CONTINUATION_AUTHORITY_MISMATCH");
  const revision = authorityRevision(authority);
  if (revision === null) fail("authority revision is unavailable", "LIVE_CONTINUATION_AUTHORITY_UNAVAILABLE");
  const checkpointId = authorityCheckpoint(authority);
  if (checkpointId !== command.checkpointId) fail("checkpoint binding does not match durable authority", "LIVE_CONTINUATION_CHECKPOINT_MISMATCH");
  return { revision, checkpointId };
}

function cloneAuthority(authority, command, claim) {
  return {
    runId: command.runId,
    status: authority.status ?? authority.lifecycleStatus ?? "unknown",
    revision: authorityRevision(authority),
    checkpointId: authorityCheckpoint(authority),
    claim: {
      attemptId: claim.attemptId,
      ownerId: claim.ownerId,
      leaseExpiresAtMs: claim.leaseExpiresAtMs,
      fenceToken: claim.fenceToken,
    },
    blockingEffectCount: blockingEffects(authority).length,
    authority: LIVE_CONTINUATION_AUTHORITY,
  };
}

function makePlan(command, authority, claim, adapter) {
  const core = {
    runId: command.runId,
    nodeId: command.nodeId,
    action: command.action,
    expectedRevision: command.expectedRevision,
    checkpointId: command.checkpointId,
    effectState: command.effectState,
    commandDigest: command.commandDigest,
    actor: command.actor,
    runtimeAdapter: command.runtimeAdapter,
    runtime: command.runtime,
  };
  const resumePlan = {
    ...core,
    claim,
    executionAllowed: false,
    schedulerAuthority: LIVE_CONTINUATION_AUTHORITY,
    runAuthority: LIVE_CONTINUATION_AUTHORITY,
    schedulerCreated: false,
    durableCursorAdvance: false,
    checkpointMutation: false,
    externalModelQuota: false,
  };
  const plan = {
    schemaVersion: LIVE_CONTINUATION_PLAN_SCHEMA_VERSION,
    kind: LIVE_CONTINUATION_PLAN_KIND,
    status: "planned",
    command,
    commandDigest: command.commandDigest,
    authority: cloneAuthority(authority, command, claim),
    resumePlan,
    adapter: {
      adapterId: adapter.adapterId,
      runtime: adapter.runtime,
      capabilities: [...adapter.capabilities],
      sideEffectMode: adapter.sideEffectMode,
    },
    sideEffects: {
      plannedOnly: true,
      executionRequested: false,
      externalModelQuota: false,
      persisted: false,
    },
    planDigest: canonicalDigest({
      commandDigest: command.commandDigest,
      authority: cloneAuthority(authority, command, claim),
      resumePlan,
      adapterId: adapter.adapterId,
    }),
  };
  return freeze(plan);
}

function planDigestFor(plan) {
  return canonicalDigest({
    commandDigest: plan?.commandDigest,
    authority: plan?.authority,
    resumePlan: plan?.resumePlan,
    adapterId: plan?.adapter?.adapterId,
  });
}

function executionRepositoryFor(value) {
  const repository = value?.durableRepository ?? value?.repository ?? value?.runRepository;
  if (!repository || typeof repository !== "object" || typeof repository.resumeRun !== "function" || typeof repository.verifyEventChain !== "function") {
    fail("durable run repository is required for execution", "LIVE_CONTINUATION_AUTHORITY_REQUIRED");
  }
  for (const method of ["prepareEffect", "markEffectDispatchStarted", "markUnresolvedEffectsInDoubt"]) {
    if (typeof repository[method] !== "function") {
      fail(`durable run repository is missing ${method}`, "LIVE_CONTINUATION_EFFECT_PROTOCOL_REQUIRED");
    }
  }
  return repository;
}

function executionStoreFor(value) {
  if (!value?.commandStore || typeof value.commandStore.append !== "function") {
    fail("command store is required for execution", "LIVE_CONTINUATION_STORE_REQUIRED");
  }
  return value.commandStore;
}

function effectBindingFor(command, plan) {
  const attemptId = command.claim?.attemptId;
  if (typeof attemptId !== "string" || !attemptId) {
    fail("effect dispatch requires a concrete claim attempt", "LIVE_CONTINUATION_EFFECT_CLAIM_REQUIRED");
  }
  const adapter = plan?.adapter;
  if (!adapter || adapter.adapterId !== command.runtimeAdapter || adapter.runtime !== command.runtime) {
    fail("effect provider binding does not match the planned adapter", "LIVE_CONTINUATION_EFFECT_BINDING_MISMATCH");
  }
  const claimBinding = {
    runId: command.runId,
    nodeId: command.nodeId,
    attemptId,
    ownerId: command.claim.ownerId,
    fenceToken: command.claim.fenceToken,
  };
  const providerBinding = {
    adapterId: adapter.adapterId,
    runtime: adapter.runtime,
    action: command.action,
    capabilities: [...adapter.capabilities],
    sideEffectMode: adapter.sideEffectMode,
  };
  const logicalEffectKey = `live-continuation:${canonicalDigest({ claimBinding, providerBinding, action: command.action })}`;
  const idempotencyKey = `live-continuation:${canonicalDigest({ commandId: command.commandId, nonce: command.nonce, commandDigest: command.commandDigest })}`;
  const fingerprint = canonicalDigest({ commandDigest: command.commandDigest, planDigest: plan.planDigest, claimBinding, providerBinding });
  const effectId = `live-continuation:${canonicalDigest({ logicalEffectKey, fingerprint, idempotencyKey })}`;
  return freeze({
    effectId,
    logicalEffectKey,
    fingerprint,
    idempotencyKey,
    providerBinding,
    claimBinding,
  });
}

async function markEffectInDoubt(repository, command, effectId, nowMs) {
  const result = await repository.markUnresolvedEffectsInDoubt({ runId: command.runId, nowMs });
  if (!Array.isArray(result?.effectIds) || !result.effectIds.includes(effectId)) {
    fail("durable effect protocol did not mark the dispatched effect in doubt", "LIVE_CONTINUATION_EFFECT_IN_DOUBT_UNCONFIRMED");
  }
  return result;
}

/**
 * Build a continuation plan from the current durable run authority. This
 * function is deliberately read/validate-only; it never creates a scheduler,
 * mutates the run repository, or calls a runtime adapter.
 */
export async function planLiveContinuation(optionsOrCommand = {}, maybeOptions = {}) {
  const options = optionsOrCommand?.action && optionsOrCommand?.runId
    ? { ...maybeOptions, command: optionsOrCommand }
    : optionsOrCommand;
  if (Object.hasOwn(options, "authority")) {
    fail("authority injection is forbidden; use durable repository resumeRun", "LIVE_CONTINUATION_AUTHORITY_INJECTION_FORBIDDEN");
  }
  const command = validateLiveContinuationCommand(options.command, { nowMs: Number(options.nowMs ?? Date.now()) });
  const nowMs = Number(options.nowMs ?? Date.now());
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail("planner clock is invalid");
  if (command.expiresAtMs <= nowMs) fail("command has expired", "LIVE_CONTINUATION_COMMAND_EXPIRED");
  const repository = repositoryFor(options);
  const registry = registryFor(options);
  targetRequirements(command);
  const adapter = registry.resolve(command.runtimeAdapter, { runtime: command.runtime, action: command.action });
  const authority = await callResume(repository, command, options);
  const verified = await callVerify(repository, command);
  if (!verified || verified.ok !== true) fail("durable event chain is not verified", "LIVE_CONTINUATION_EVENT_CHAIN_UNVERIFIED");
  if (verified.runId !== undefined && verified.runId !== command.runId) {
    fail("event-chain verification belongs to a different run", "LIVE_CONTINUATION_AUTHORITY_MISMATCH");
  }
  const bound = normalizedAuthority(authority, command);
  if (
    Number.isSafeInteger(authority.revision) &&
    Number.isSafeInteger(authority.cursor) &&
    authority.revision !== authority.cursor
  ) {
    fail("durable authority exposes conflicting revision and cursor", "LIVE_CONTINUATION_AUTHORITY_CONTRADICTORY");
  }
  if (
    authority.headCheckpointId !== undefined &&
    authority.checkpointId !== undefined &&
    authority.headCheckpointId !== authority.checkpointId
  ) {
    fail("durable authority exposes conflicting checkpoint bindings", "LIVE_CONTINUATION_AUTHORITY_CONTRADICTORY");
  }
  if (bound.revision !== command.expectedRevision) {
    fail("expected revision does not match durable authority", "LIVE_CONTINUATION_REVISION_MISMATCH");
  }
  const status = authority.status ?? authority.lifecycleStatus;
  if (status !== "active") fail("terminal or unknown runs cannot be continued", "LIVE_CONTINUATION_RUN_NOT_ACTIVE");
  if (authority.resumable === false) fail("durable authority does not permit resumption", "LIVE_CONTINUATION_NOT_RESUMABLE");
  const unresolved = blockingEffects(authority);
  if (unresolved.length > 0) fail("unreconciled effect blocks continuation", "LIVE_CONTINUATION_EFFECT_UNRECONCILED");
  const claim = claimMatches(command, authority, nowMs);
  if (command.expiresAtMs > claim.leaseExpiresAtMs) {
    fail("command expiry exceeds the authoritative lease window", "LIVE_CONTINUATION_LEASE_MISMATCH");
  }
  return makePlan(command, authority, claim, adapter);
}

/** Execute only a previously validated plan through its injected adapter. */
export async function executeLiveContinuation({
  plan,
  adapterRegistry,
  commandStore,
  durableRepository,
  repository,
  expectedStoreRevision,
  nowMs = Date.now(),
} = {}) {
  if (!plan || plan.schemaVersion !== LIVE_CONTINUATION_PLAN_SCHEMA_VERSION || plan.status !== "planned") {
    fail("only a planned continuation may execute", "LIVE_CONTINUATION_PLAN_INVALID");
  }
  const executionNowMs = Number(nowMs);
  if (!Number.isSafeInteger(executionNowMs) || executionNowMs < 0) {
    fail("execution clock is invalid", "LIVE_CONTINUATION_EXECUTION_CLOCK_INVALID");
  }
  const command = validateLiveContinuationCommand(plan.command, { nowMs: executionNowMs });
  if (command.expiresAtMs <= executionNowMs) fail("command has expired", "LIVE_CONTINUATION_COMMAND_EXPIRED");
  if (!adapterRegistry || typeof adapterRegistry.invoke !== "function") {
    fail("runtime adapter registry is required", "LIVE_CONTINUATION_ADAPTER_REQUIRED");
  }
  const store = executionStoreFor({ commandStore });
  const authorityRepository = executionRepositoryFor({ durableRepository, repository });

  if (
    plan.commandDigest !== command.commandDigest ||
    plan.command?.commandDigest !== command.commandDigest ||
    plan.planDigest !== planDigestFor(plan)
  ) {
    fail("planned command or digest does not bind execution", "LIVE_CONTINUATION_PLAN_INVALID");
  }

  // Re-read first so already-stale plans fail before persistence. The durable
  // effect protocol below then transactionally rechecks the active claim and
  // fence while reserving dispatch. The external adapter call cannot share
  // that transaction, so its outcome is deliberately recorded as in_doubt.
  const freshPlan = await planLiveContinuation({
    command,
    repository: authorityRepository,
    adapterRegistry,
    nowMs: executionNowMs,
  });
  if (
    freshPlan.planDigest !== plan.planDigest ||
    freshPlan.commandDigest !== command.commandDigest ||
    planDigestFor(freshPlan) !== freshPlan.planDigest
  ) {
    fail("durable authority changed after planning", "LIVE_CONTINUATION_PLAN_STALE");
  }

  const effect = effectBindingFor(command, freshPlan);

  let storeRevision = expectedStoreRevision;
  if (storeRevision === undefined && typeof store.list === "function") {
    const records = await store.list();
    storeRevision = records.at(-1)?.revision ?? 0;
  }
  const appendOptions = storeRevision === undefined ? {} : { expectedRevision: storeRevision };
  await store.append(command, appendOptions);
  await authorityRepository.prepareEffect({
    ...effect,
    runId: command.runId,
    nodeId: command.nodeId,
    attemptId: command.claim.attemptId,
    fenceToken: command.claim.fenceToken,
    ownerId: command.claim.ownerId,
    nowMs: executionNowMs,
  });
  const started = await authorityRepository.markEffectDispatchStarted({
    effectId: effect.effectId,
    attemptId: command.claim.attemptId,
    fenceToken: command.claim.fenceToken,
    ownerId: command.claim.ownerId,
    nowMs: executionNowMs,
  });
  if (started?.state !== "dispatch_started") {
    fail("durable effect protocol did not enter dispatch_started", "LIVE_CONTINUATION_EFFECT_DISPATCH_NOT_STARTED");
  }

  let invocation;
  let adapterError = null;
  try {
    invocation = await adapterRegistry.invoke(command.runtimeAdapter, {
      action: command.action,
      runtime: command.runtime,
      command,
      plan: freshPlan,
      ...effect,
    });
  } catch (error) {
    adapterError = error;
  }
  await markEffectInDoubt(authorityRepository, command, effect.effectId, executionNowMs);
  if (adapterError) {
    const failure = new Error("runtime adapter invocation failed; effect is in doubt");
    failure.code = "LIVE_CONTINUATION_ADAPTER_INVOCATION_FAILED";
    failure.cause = adapterError;
    failure.executionResult = freeze({
      schemaVersion: LIVE_CONTINUATION_PLAN_SCHEMA_VERSION,
      status: "adapter_failed",
      persisted: true,
      authorityRevalidated: true,
      atomicAuthorityRevalidation: false,
      durableEffectFenced: true,
      externalSideEffectAtomic: false,
      executionConsistency: "durable_effect_fenced_external_in_doubt",
      adapterInvocationObserved: false,
      effectState: "in_doubt",
      completionVerified: false,
      effect,
      error: "adapter_invocation_failed",
      externalModelQuota: false,
    });
    throw failure;
  }
  return freeze({
    schemaVersion: LIVE_CONTINUATION_PLAN_SCHEMA_VERSION,
    status: "adapter_invoked",
    commandDigest: command.commandDigest,
    persisted: true,
    authorityRevalidated: true,
    atomicAuthorityRevalidation: false,
    durableEffectFenced: true,
    externalSideEffectAtomic: false,
    executionConsistency: "durable_effect_fenced_external_in_doubt",
    freshPlanDigest: freshPlan.planDigest,
    adapterInvocationObserved: true,
    effectState: "in_doubt",
    completionVerified: false,
    effect,
    adapter: { adapterId: invocation.adapterId, runtime: invocation.runtime, action: invocation.action },
    result: invocation.result,
    externalModelQuota: false,
  });
}

export function createLiveContinuationPlanner(options = {}) {
  return Object.freeze({
    async plan(command, overrides = {}) {
      return planLiveContinuation({ ...options, ...overrides, command });
    },
    async execute(plan, overrides = {}) {
      return executeLiveContinuation({
        ...options,
        ...overrides,
        plan,
        durableRepository: overrides.durableRepository ?? options.durableRepository ?? options.repository ?? options.runRepository,
      });
    },
  });
}

export const buildLiveContinuationPlan = planLiveContinuation;
export const buildLiveContinuationResumePlan = planLiveContinuation;
export const planContinuation = planLiveContinuation;
