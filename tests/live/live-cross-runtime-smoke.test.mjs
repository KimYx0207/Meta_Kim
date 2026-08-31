import assert from "node:assert/strict";
import test from "node:test";

import { buildLiveCompactProjection } from "../../src/application/live/live-control-room-service.mjs";

const BASE_TIME = "2026-08-30T00:00:00.000Z";

function baseArtifact({ runtime, hostSurface, observed, missingReason }) {
  const workerTaskPackets = [
    {
      taskPacketId: "agent:read-source",
      ownerAgent: "frontend-developer",
      status: "active",
      roleDisplayName: "frontend",
      roleInstanceId: "exec-read-source",
      componentId: "comp:source-wiring",
      stage: "execution",
      task: "read PRD",
      capabilityBindings: {
        skills: ["tdd-workflow"],
        tools: ["Read", "Edit"],
        mcp: ["mcp__memory_service__memory_search"],
        commands: ["git status --short"],
      },
      shardScope: ["exec-read-source"],
      dependsOn: [],
    },
  ];
  const workerResultPackets = [
    {
      runId: "cross-runtime-fixture",
      taskPacketId: "agent:read-source",
      roleDisplayName: "frontend",
      roleInstanceId: "exec-read-source",
      status: "active",
      startedAt: BASE_TIME,
      completedAt: null,
      workerExecutionEvidence: observed?.workerEvidence || [],
    },
  ];
  const hostInvocationEvidence = observed?.hostEvidence || [];
  return {
    runId: "cross-runtime-fixture",
    title: "cross-runtime smoke",
    task: "verify per-runtime honesty",
    status: "active",
    currentStage: "execution",
    startedAt: BASE_TIME,
    updatedAt: BASE_TIME,
    completedAt: null,
    language: "zh-CN",
    projectId: "project-cross-runtime",
    sourceConversation: {
      runId: "cross-runtime-fixture",
      conversationId: `session:${runtime}-cross`,
      runtime,
      title: "cross-runtime smoke",
      updatedAt: BASE_TIME,
    },
    conversationLinks: [{
      runId: "cross-runtime-fixture",
      conversationRef: `session:${runtime}-cross-cross-runtime-fixture`,
      sourceRuntime: runtime,
      verified: observed?.conversationVerified === true,
      matchState: observed?.conversationVerified === true ? "verified" : "unverified",
      matchBasis: observed?.conversationVerified === true ? "exact_metadata" : "declared_only",
      title: "cross-runtime smoke",
      updatedAt: BASE_TIME,
    }],
    dispatchEnvelopePacket: { ownerAgent: "meta-conductor", runId: "cross-runtime-fixture" },
    coreLoop: {
      ownerAgent: "meta-conductor",
      capabilityInventory: {
        inventory: [{
          ownerAgent: "meta-conductor",
          capabilityFamilies: ["skill", "mcp", "tool", "command"],
        }],
      },
    },
    workerTaskPackets,
    workerResultPackets,
    hostInvocationEvidence,
    ...(missingReason ? { crossRuntimeNotes: missingReason } : {}),
  };
}

function projectionFor(runtime) {
  const observed = {
    conversationVerified: true,
    workerEvidence: [
      {
        runId: "cross-runtime-fixture",
        taskPacketId: "agent:read-source",
        verifyStepRef: "runtime_tool:Read",
        status: "verified",
        resultStatus: "verified",
        observedResult: "Read tool invoked",
        runAt: BASE_TIME,
        proofValid: true,
        synthetic: false,
        evidenceKind: "runtime_tool",
      },
    ],
    hostEvidence: [
      {
        runId: "cross-runtime-fixture",
        taskPacketId: "agent:read-source",
        bindingRef: "agent:read-source",
        family: "runtime_tool",
        providerId: "Read",
        hostSurface: "claude-code-host",
        runtime: "claude-code",
        model: "claude-sonnet-4-5",
        state: "invoked",
        proofValid: true,
        synthetic: false,
        observedAt: BASE_TIME,
        occurredAt: BASE_TIME,
        filePath: null,
        componentId: "comp:source-wiring",
        eventId: "agent:read-source:runtime_tool:Read",
      },
    ],
  };
  const artifact = baseArtifact({
    runtime,
    hostSurface: runtime === "claude-code" ? "claude-code-host" : `${runtime}-host`,
    observed,
  });
  return { artifact, projection: buildLiveCompactProjection(artifact) };
}

test("Claude Code runtime: real observed host evidence must surface as actual invocation", () => {
  const { projection } = projectionFor("claude-code");
  assert.equal(projection.session.runtime, "claude-code");
  const worker = projection.nodes.find((node) => node.roleInstanceId === "exec-read-source");
  assert.ok(worker, "worker node must appear");
  const toolTruth = (worker.capabilityTruth || []).find((entry) => entry.kind === "runtime_tool");
  assert.ok(toolTruth, "runtime_tool truth row must exist");
  assert.equal(toolTruth.state, "observed");
  assert.ok((toolTruth.actualNames || []).includes("Read"));
  assert.ok((projection.toolCalls || []).length >= 1, "toolCalls must surface observed host evidence");
  const evidence = projection.evidence.find((entry) => entry.evidenceKind === "runtime_tool");
  assert.equal(evidence?.proofValid, true);
  assert.notEqual(evidence?.synthetic, true);
});

test("Codex runtime: filesystem-watcher-only surface must NOT claim observed invocation", () => {
  const observed = {
    conversationVerified: false,
    workerEvidence: [],
    hostEvidence: [
      {
        runId: "cross-runtime-fixture",
        taskPacketId: "agent:read-source",
        bindingRef: "agent:read-source",
        family: "fs_watch",
        providerId: "fs.watch",
        hostSurface: "codex-host",
        runtime: "codex",
        model: "codex-runtime",
        state: "returned",
        proofValid: false,
        synthetic: false,
        observedAt: BASE_TIME,
        occurredAt: BASE_TIME,
        filePath: "src/application/live/live-control-room-service.mjs",
        componentId: "comp:source-wiring",
        eventId: "agent:read-source:fs_watch:fs.watch",
      },
    ],
  };
  const artifact = baseArtifact({
    runtime: "codex",
    hostSurface: "codex-host",
    observed,
    missingReason: "Codex runtime surface in this build is fs.watch only; no host invocation evidence reaches the Live projection pipeline.",
  });
  const projection = buildLiveCompactProjection(artifact);
  assert.notEqual(projection.session.runtime, "codex", "codex fs.watch-only evidence must not promote session.runtime to codex as observed");
  assert.equal(projection.session.runtime, "unavailable", "codex must surface as unavailable when only untrusted fs.watch evidence is present");
  const worker = projection.nodes.find((node) => node.roleInstanceId === "exec-read-source");
  assert.ok(worker, "codex worker node must still surface as declared");
  const toolTruth = (worker.capabilityTruth || []).find((entry) => entry.kind === "runtime_tool");
  assert.ok(toolTruth, "runtime_tool truth row must still exist (declared)");
  assert.notEqual(toolTruth.state, "observed", "codex fs.watch evidence must not promote capability to observed");
  assert.equal((projection.toolCalls || []).length, 0, "no real host invocation tool calls must leak");
  const observedEvidence = (projection.evidence || []).filter((entry) => entry?.proofValid === true && entry?.synthetic !== true);
  assert.equal(observedEvidence.length, 0, "fs.watch evidence is unverified and must not enter the observed set");
});

test("Cursor runtime: declared-only artifact must surface as planned capability with explicit reason", () => {
  const observed = {
    conversationVerified: false,
    workerEvidence: [
      {
        runId: "cross-runtime-fixture",
        taskPacketId: "agent:read-source",
        verifyStepRef: "frontend-developer-declaration",
        status: "verified",
        resultStatus: "verified",
        observedResult: "frontend declared status active",
        runAt: BASE_TIME,
        proofValid: true,
        synthetic: false,
        evidenceKind: "declaration",
      },
    ],
    hostEvidence: [
      {
        runId: "cross-runtime-fixture",
        taskPacketId: "agent:read-source",
        bindingRef: "agent:read-source",
        family: "tool",
        providerId: "Read",
        hostSurface: "cursor-host",
        runtime: "cursor",
        model: "cursor-runtime",
        state: "declared",
        proofValid: false,
        synthetic: false,
        observedAt: BASE_TIME,
        occurredAt: BASE_TIME,
        filePath: null,
        componentId: "comp:source-wiring",
        eventId: "agent:read-source:tool:Read",
      },
    ],
  };
  const artifact = baseArtifact({
    runtime: "cursor",
    hostSurface: "cursor-host",
    observed,
    missingReason: "Cursor runtime adapter ships as a partial projection in this build; no host invocation bridge is wired yet, so capabilityTruth remains planned.",
  });
  const projection = buildLiveCompactProjection(artifact);
  assert.notEqual(projection.session.runtime, "cursor", "cursor without trusted host evidence must not be presented as an observed runtime");
  assert.equal(projection.session.runtime, "unavailable", "cursor projection must honestly mark runtime as unavailable when no host evidence is trusted");
  const worker = projection.nodes.find((node) => node.roleInstanceId === "exec-read-source");
  const toolTruth = (worker.capabilityTruth || []).find((entry) => entry.kind === "runtime_tool");
  assert.ok(toolTruth, "runtime_tool truth row must still exist");
  assert.equal(toolTruth.state, "planned", "cursor with no host evidence must stay in planned state");
  assert.deepEqual(toolTruth.actualNames || [], []);
  assert.equal((projection.toolCalls || []).length, 0, "cursor without host invocation must not leak tool calls");
  const observedEvidence = (projection.evidence || []).filter((entry) => entry?.proofValid === true && entry?.synthetic !== true && entry?.evidenceKind !== "declaration");
  assert.equal(observedEvidence.length, 0, "only declaration evidence may exist for cursor; no fake host rows");
});

test("OpenClaw runtime: declared-only artifact must surface as planned capability with explicit reason", () => {
  const observed = {
    conversationVerified: false,
    workerEvidence: [
      {
        runId: "cross-runtime-fixture",
        taskPacketId: "agent:read-source",
        verifyStepRef: "frontend-developer-declaration",
        status: "verified",
        resultStatus: "verified",
        observedResult: "frontend declared status active",
        runAt: BASE_TIME,
        proofValid: true,
        synthetic: false,
        evidenceKind: "declaration",
      },
    ],
    hostEvidence: [
      {
        runId: "cross-runtime-fixture",
        taskPacketId: "agent:read-source",
        bindingRef: "agent:read-source",
        family: "tool",
        providerId: "Read",
        hostSurface: "openclaw-host",
        runtime: "openclaw",
        model: "openclaw-runtime",
        state: "declared",
        proofValid: false,
        synthetic: false,
        observedAt: BASE_TIME,
        occurredAt: BASE_TIME,
        filePath: null,
        componentId: "comp:source-wiring",
        eventId: "agent:read-source:tool:Read",
      },
    ],
  };
  const artifact = baseArtifact({
    runtime: "openclaw",
    hostSurface: "openclaw-host",
    observed,
    missingReason: "OpenClaw runtime ships declaratively; no observed host bridge feeds the Live projection yet.",
  });
  const projection = buildLiveCompactProjection(artifact);
  assert.notEqual(projection.session.runtime, "openclaw", "openclaw without trusted host evidence must not be presented as an observed runtime");
  assert.equal(projection.session.runtime, "unavailable", "openclaw projection must honestly mark runtime as unavailable when no host evidence is trusted");
  const worker = projection.nodes.find((node) => node.roleInstanceId === "exec-read-source");
  const toolTruth = (worker.capabilityTruth || []).find((entry) => entry.kind === "runtime_tool");
  assert.ok(toolTruth, "runtime_tool truth row must still exist");
  assert.equal(toolTruth.state, "planned", "openclaw without host evidence must stay in planned state");
  assert.deepEqual(toolTruth.actualNames || [], []);
  assert.equal((projection.toolCalls || []).length, 0, "openclaw without host invocation must not leak tool calls");
});

test("Cross-runtime: synthetic evidence must never promote capability to observed", () => {
  const observed = {
    conversationVerified: true,
    workerEvidence: [],
    hostEvidence: [
      {
        runId: "cross-runtime-fixture",
        taskPacketId: "agent:read-source",
        bindingRef: "agent:read-source",
        family: "tool",
        providerId: "Read",
        hostSurface: "fake-host",
        runtime: "claude-code",
        model: "claude-sonnet-4-5",
        state: "invoked",
        proofValid: true,
        synthetic: true,
        observedAt: BASE_TIME,
        occurredAt: BASE_TIME,
        filePath: null,
        componentId: "comp:source-wiring",
        eventId: "agent:read-source:tool:Read",
      },
    ],
  };
  const artifact = baseArtifact({
    runtime: "claude-code",
    hostSurface: "fake-host",
    observed,
    missingReason: "synthetic evidence is filtered out before reaching capability truth",
  });
  const projection = buildLiveCompactProjection(artifact);
  const worker = projection.nodes.find((node) => node.roleInstanceId === "exec-read-source");
  const toolTruth = (worker.capabilityTruth || []).find((entry) => entry.kind === "runtime_tool");
  assert.notEqual(toolTruth.state, "observed", "synthetic evidence must not promote runtime_tool to observed");
  assert.equal((projection.toolCalls || []).length, 0, "synthetic evidence must not leak into toolCalls");
});