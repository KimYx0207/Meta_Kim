// Pure fixture → governed-artifact loader for the P1.1 Live acceptance run.
//
// The loader is data-driven:
//   - All node/edge/evidence/capability facts come from the JSON fixture.
//   - The loader only wires those facts into the shape buildLiveCompactProjection
//     expects. It owns no domain value of its own.
//   - Time placeholders (`{startBase}`, `{startBase+30s}`, …) resolve against a
//     caller-provided ISO base so re-runs produce a stable, monotonic timeline.
//
// Every artifact this loader produces is stamped as a fixture. The stamp lives
// here rather than in the CLI because this is the only function that turns a
// fixture into an artifact: stamping at the source makes an unmarked fixture
// unrepresentable, instead of depending on each caller to remember. Without it a
// fixture is indistinguishable from a real run once written, and it reads as the
// healthier record of the two, because a fixture declares by construction the
// worker counts and runtime a real activation often has not produced yet.

import { LIVE_ACCEPTANCE_FIXTURE_RECORD_ORIGIN } from "./live-record-origin.mjs";

const PLACEHOLDER_PATTERN = /\{startBase(?:\+(\d+)(s|ms))?\}/gu;

function resolveTimestamp(value, base) {
  if (typeof value !== "string") return value;
  return value.replace(PLACEHOLDER_PATTERN, (_match, offset, unit) => {
    const ms = offset ? Number(offset) * (unit === "ms" ? 1 : 1000) : 0;
    return new Date(Date.parse(base) + ms).toISOString();
  });
}

export function resolveFixture(fixture, baseIso) {
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const out = {};
      for (const [key, child] of Object.entries(value)) out[key] = walk(child);
      return out;
    }
    return resolveTimestamp(value, baseIso);
  };
  return walk(fixture);
}

function templateTitle(template, runId) {
  return typeof template === "string"
    ? template.replace(/\{runId\}/gu, runId)
    : template;
}

function executionDepsFor(workerId, fixtureEdges) {
  return fixtureEdges
    .filter((edge) => edge.kind !== "contains" && edge.to === workerId && edge.from.startsWith("agent:"))
    .map((edge) => edge.from);
}

export function buildWorkerTaskPackets(fixture, depsByWorkerId) {
  return fixture.workers.map((worker) => ({
    taskPacketId: worker.id,
    roleDisplayName: worker.roleDisplayName,
    roleInstanceId: worker.roleInstanceId,
    componentId: worker.componentId || null,
    stage: "execution",
    status: worker.status,
    ownerAgent: worker.ownerAgent,
    capabilityBindings: worker.capabilityBindings || {},
    shardScope: [worker.roleInstanceId],
    dependsOn: depsByWorkerId.get(worker.id) || [],
  }));
}

function evidenceCompletionStatus(worker) {
  // Worker result.workerExecutionEvidence must use `completed` so the projection's
  // terminal-status gate keeps the worker's declared status. The host invocation
  // state (invoked/returned/...) is recorded separately in hostInvocationEvidence.
  if (worker.status === "completed") return "completed";
  if (worker.status === "failed") return "failed";
  if (worker.status === "blocked") return "blocked";
  return "verified";
}

export function buildWorkerResultPackets(fixture, runId) {
  return fixture.workers.map((worker) => {
    const evidenceStatus = evidenceCompletionStatus(worker);
    const terminalRecords = (worker.evidence || []).map((evidence) => ({
      runId,
      taskPacketId: worker.id,
      verifyStepRef: `${evidence.family}:${evidence.providerId}`,
      status: evidenceStatus,
      resultStatus: evidenceStatus,
      observedResult: `${evidence.family} ${evidence.providerId} observed`,
      runAt: evidence.observedAt,
      proofValid: evidence.proofValid,
      synthetic: evidence.synthetic,
      evidenceKind: evidence.family,
    }));
    if (!terminalRecords.length && worker.status !== "pending") {
      terminalRecords.push({
        runId,
        taskPacketId: worker.id,
        verifyStepRef: `${worker.roleDisplayName}-declaration`,
        status: evidenceStatus,
        resultStatus: evidenceStatus,
        observedResult: `${worker.roleDisplayName} declared status ${worker.status}`,
        runAt: worker.startedAt,
        proofValid: true,
        synthetic: false,
        evidenceKind: "declaration",
      });
    }
    return {
      runId,
      taskPacketId: worker.id,
      roleDisplayName: worker.roleDisplayName,
      roleInstanceId: worker.roleInstanceId,
      status: worker.status,
      startedAt: worker.startedAt || null,
      completedAt: worker.completedAt || null,
      workerExecutionEvidence: terminalRecords,
    };
  });
}

export function buildHostInvocationEvidence(fixture, runId, baseIso) {
  const rows = [];
  for (const worker of fixture.workers) {
    for (const evidence of worker.evidence || []) {
      rows.push({
        runId,
        taskPacketId: worker.id,
        bindingRef: worker.id,
        family: evidence.family,
        providerId: evidence.providerId,
        hostSurface: evidence.hostSurface,
        runtime: fixture.meta.runtime,
        model: "claude-sonnet-4-5",
        state: evidence.state,
        proofValid: evidence.proofValid,
        synthetic: evidence.synthetic,
        observedAt: evidence.observedAt,
        occurredAt: evidence.observedAt,
        filePath: evidence.filePath || null,
        componentId: worker.componentId || null,
        usage: evidence.usage,
        eventId: `${worker.id}:${evidence.family}:${evidence.providerId}`,
      });
    }
  }
  return rows;
}

// A fixture link declares its standing, because that is the scenario it exists to
// exercise, but it must not declare a `matchBasis`. That field answers "how do we
// know this run belongs to this chat", and the one producer that earns it —
// `canonical/runtime-assets/shared/hooks/conversation-binding.mjs` — earns it from
// eight filesystem checks against the transcript the host named. Nothing in this
// path opens a transcript: the identifier below is templated from the fixture's own
// prefix, so a basis written here is a claim the loader manufactures about itself.
//
// Nothing downstream repeats that claim today. Every reader folds a stored basis
// against one derived from the record's own facts through
// `conversationMatchBasisFor`, and for this link — whose run id equals the run's —
// the derivation is `exact_run_id`, which out-ranks `exact_metadata`; that
// function's clamp separately keeps a stored verifying basis off a record whose
// at-hand facts are unproven. Measured: the record
// `scripts/run-live-acceptance-fixture.mjs` serialises is identical in that field
// with the value and without it.
//
// It is removed at the source anyway, because that fold is what makes the claim
// invisible, not what makes it true. And the claim has reached a reader: a record
// this loader produced earlier the same day names `exact_metadata` on both
// `run.verifiedLinks` and `session.verifiedLinks`, so some revision between this
// function and those two arrays did carry it through.
// `buildSourceConversation` below has always omitted it for the same reason.
export function buildConversationLinks(fixture, runId, baseIso) {
  return [
    {
      runId,
      conversationRef: `${fixture.meta.sessionIdPrefix}-${runId}`,
      sourceRuntime: fixture.meta.runtime,
      verified: true,
      matchState: "verified",
      title: templateTitle(fixture.meta.titleTemplate, runId),
      updatedAt: baseIso,
    },
  ];
}

export function buildSourceConversation(fixture, runId, baseIso) {
  return {
    runId,
    conversationId: `${fixture.meta.sessionIdPrefix}-${runId}`,
    runtime: fixture.meta.runtime,
    title: templateTitle(fixture.meta.titleTemplate, runId),
    updatedAt: baseIso,
  };
}

function depsIndex(fixture) {
  const map = new Map();
  for (const worker of fixture.workers) {
    map.set(worker.id, executionDepsFor(worker.id, fixture.edges));
  }
  return map;
}

export function buildGovernedArtifact(fixture, runId, baseIso) {
  const depsByWorkerId = depsIndex(fixture);
  const title = templateTitle(fixture.meta.titleTemplate, runId);
  return {
    runId,
    title,
    task: fixture.meta.taskTemplate,
    recordOrigin: LIVE_ACCEPTANCE_FIXTURE_RECORD_ORIGIN,
    status: "active",
    currentStage: "execution",
    startedAt: baseIso,
    updatedAt: baseIso,
    completedAt: null,
    language: fixture.meta.language,
    projectId: fixture.meta.projectId,
    sourceConversation: buildSourceConversation(fixture, runId, baseIso),
    conversationLinks: buildConversationLinks(fixture, runId, baseIso),
    dispatchEnvelopePacket: {
      ownerAgent: fixture.mainAgent.ownerAgent,
      runId,
    },
    coreLoop: {
      ownerAgent: fixture.mainAgent.ownerAgent,
      capabilityInventory: {
        inventory: [
          {
            ownerAgent: fixture.mainAgent.ownerAgent,
            capabilityFamilies: Object.keys(fixture.mainAgent.capabilityBindings || {}),
          },
        ],
      },
    },
    workerTaskPackets: buildWorkerTaskPackets(fixture, depsByWorkerId),
    workerResultPackets: buildWorkerResultPackets(fixture, runId),
    hostInvocationEvidence: buildHostInvocationEvidence(fixture, runId, baseIso),
  };
}