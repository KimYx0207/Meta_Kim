// Pure fixture → governed-artifact loader for the P1.1 Live acceptance run.
//
// The loader is data-driven:
//   - All node/edge/evidence/capability facts come from the JSON fixture.
//   - The loader only wires those facts into the shape buildLiveCompactProjection
//     expects. It owns no domain value of its own.
//   - Time placeholders (`{startBase}`, `{startBase+30s}`, …) resolve against a
//     caller-provided ISO base so re-runs produce a stable, monotonic timeline.

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

export function buildConversationLinks(fixture, runId, baseIso) {
  return [
    {
      runId,
      conversationRef: `${fixture.meta.sessionIdPrefix}-${runId}`,
      sourceRuntime: fixture.meta.runtime,
      verified: true,
      matchState: "verified",
      matchBasis: "exact_metadata",
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