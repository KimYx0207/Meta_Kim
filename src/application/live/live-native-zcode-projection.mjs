import { createHash } from "node:crypto";
import { nativeZcodeRunId } from "../../infrastructure/live/zcode-native-session-reader.mjs";

const MAX_AGENTS = 255;
const MAX_TOOL_CALLS = 512;
const id = (kind, value) => `${kind}:${createHash("sha256").update(String(value)).digest("hex").slice(0, 20)}`;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const safeText = (value, max = 120) => typeof value === "string"
  ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max)
  : "";
const terminal = (status) => status === "completed" || status === "error";
const emptyLoadout = () => ({ skills: 0, mcp: 0, tools: 0, commands: 0, hooks: 0, plugins: 0, memoryGraph: 0, dependencies: 0,
  skillNames: [], mcpNames: [], toolNames: [], commandNames: [], hookNames: [], pluginNames: [], memoryGraphNames: [], dependencyNames: [] });

function node({ nodeId, taskId, label, owner, runtime, main, at }) {
  const runtimeLabel = runtime === "claude" ? "Claude Code" : "ZCode";
  return {
    id: nodeId, kind: "agent", isMain: main, label, task: main ? `当前 ${runtimeLabel} 会话中观察到的执行` : label,
    taskPacketId: taskId, roleDisplayName: main ? null : owner || label, ownerAgent: owner || null,
    roleInstanceId: taskId, stage: "execution", parentId: null,
    status: "active", active: true, displayState: "active", executionState: "executing", executionObserved: true,
    statusReason: `来自精确绑定的 ${runtimeLabel} 原生会话事件；尚未收到任务验收。`,
    runtime, model: "unavailable", inputTokens: null, outputTokens: null, totalTokens: null,
    timing: { startedAt: at || null, completedAt: null, durationMs: null }, firstAt: at || null, lastAt: at || null,
    durationMs: null, terminalEvidence: [], workerExecutionEvidence: [], toolCalls: [], toolCount: 0,
    loadout: emptyLoadout(), capabilityTruth: [], promptEras: [], provenance: [], evidenceCount: 0,
    summary: "只读原生会话观察；调用返回不代表用户验收。",
  };
}

/** The two native readers share the same observed Agent/tool graph shape. */
export function buildNativeZcodeLiveSnapshot(observation) {
  return buildObservedNativeSnapshot(observation, "zcode", nativeZcodeRunId(observation));
}

export function buildNativeClaudeLiveSnapshot(observation) {
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
  if (!uuid.test(observation?.sessionId || "") || !uuid.test(observation?.turnId || "")) return null;
  return buildObservedNativeSnapshot(observation, "claude", observation.runId || `native-claude-${observation.sessionId}-${observation.turnId}`);
}

function buildObservedNativeSnapshot(observation, runtime, runId) {
  if (observation?.state !== "observed" || observation.binding?.projectRootMatched !== true
    || observation.binding?.sessionMetadataVerified !== true || observation.binding?.userTurnAnchorVerified !== true
    || typeof observation.sessionId !== "string" || typeof observation.turnId !== "string") return null;
  if (!runId || !RUN_ID.test(runId)) return null;
  const runtimeLabel = runtime === "claude" ? "Claude Code" : "ZCode";
  const mainId = id("agent", `${runId}:main`);
  const mainTaskId = id(`${runtime}-task`, `${runId}:main`);
  const main = node({ nodeId: mainId, taskId: mainTaskId, label: runtimeLabel, owner: runtime, runtime, main: true, at: observation.startedAt });
  const nodes = [main];
  const edges = [];
  const replay = [];
  const toolCalls = [];
  const addClaudeReturn = (target, returned) => {
    if (runtime !== "claude" || !returned) return;
    target.nativeReturnEvidence = { runId, taskPacketId: target.taskPacketId, nodeId: target.id,
      evidenceKind: "native_host_observation", sourceKind: "claude_native_session", executionObserved: true, synthetic: false,
      sourceEventId: `${returned.sourceEventId}:return`, sourceDigest: returned.sourceDigest, observedAt: returned.observedAt };
  };
  const agents = Array.isArray(observation.agents) ? observation.agents.slice(0, MAX_AGENTS) : [];
  for (const [index, agent] of agents.entries()) {
    const taskId = id(`${runtime}-task`, `${runId}:${agent.id}`);
    const nodeId = id("agent", `${runId}:${agent.id}`);
    const owner = safeText(agent.owner, 80) || null;
    const label = safeText(agent.taskName) || owner || `子任务 ${index + 1}`;
    const child = node({ nodeId, taskId, label, owner, runtime, main: false, at: agent.at });
    child.parentId = mainId;
    child.task = label;
    child.nativeTaskOrdinal = index + 1;
    child.nativeTaskCaption = owner || "subtask";
    if (owner && ["running", "completed", "error"].includes(agent.status)) {
      child.capabilityTruth.push({ kind: "agent", state: "observed", observation: "trusted_host_evidence", plannedNames: [], actualNames: [owner] });
    }
    if (terminal(agent.status)) {
      child.status = agent.status === "error" ? "failed" : "in_doubt";
      child.active = false;
      child.displayState = "in_doubt";
      child.executionState = "executed";
      child.statusReason = agent.status === "error"
        ? `${runtimeLabel} 原生记录标记该子任务调用出错；任务结果尚未验收。`
        : `${runtimeLabel} 原生记录标记该子任务调用已返回；任务结果尚未验收。`;
      child.timing.completedAt = agent.completedAt || null;
      child.lastAt = agent.completedAt || child.lastAt;
      if (agent.status === "completed") addClaudeReturn(child, agent.returnEvidence);
    } else if (agent.status === "unknown") {
      child.status = "in_doubt";
      child.active = false;
      child.displayState = "in_doubt";
      child.executionState = "unknown";
      child.statusReason = safeText(agent.statusReason) || `${runtimeLabel} 原生子任务记录缺少可信状态。`;
    }
    child.provenance.push({ kind: `${runtime}_native_agent_call`, state: "observed", sourceCallId: safeText(agent.id, 180) });
    nodes.push(child);
    edges.push({ id: id("edge", `${runId}:${agent.id}`), runId, source: mainId, target: nodeId, from: mainId, to: nodeId,
      kind: "invokes", label: "Agent", status: agent.status, at: agent.at || null });
    replay.push({ id: id("event", `${agent.id}:dispatch`), type: "agent_spawned", kind: "agent", nodeId, at: agent.at || null,
      status: agent.status === "running" ? "active" : agent.status === "error" ? "failed" : "executed", label,
      summary: `${runtimeLabel} 原生 Agent 调用；调用状态不代表任务验收。` });
  }
  for (const call of (Array.isArray(observation.toolCalls) ? observation.toolCalls : []).slice(0, MAX_TOOL_CALLS)) {
    const name = safeText(call.name, 80);
    if (!name) continue;
    const status = ["running", "completed", "error"].includes(call.status) ? call.status : "unknown";
    const tool = { id: id("tool", call.id), callId: safeText(call.id, 180), name, toolName: name,
      status: status === "error" ? "failed" : status === "unknown" ? "in_doubt" : status,
      at: call.at || null, endedAt: call.endedAt || null, executionObserved: true, runId, taskPacketId: mainTaskId, nodeId: mainId,
      summary: safeText(call.statusReason) || (status === "error" ? `${runtimeLabel} 原生工具记录为错误；命令和输出正文未读取。` : `${runtimeLabel} 原生工具调用已观察；参数和输出正文未读取。`) };
    main.toolCalls.push(tool);
    toolCalls.push(tool);
    replay.push({ id: id("event", call.id), type: "tool_returned", kind: "tool", nodeId: mainId, at: call.endedAt || call.at || null,
      status: status === "error" ? "failed" : status === "running" ? "active" : "executed", label: name, summary: tool.summary });
  }
  main.toolCount = main.toolCalls.length;
  main.loadout.tools = new Set(main.toolCalls.map((call) => call.name)).size;
  main.loadout.toolNames = [...new Set(main.toolCalls.map((call) => call.name))];
  const observedToolNames = [...new Set(toolCalls.filter((call) => ["running", "completed", "failed"].includes(call.status)).map((call) => call.name))];
  if (observedToolNames.length) {
    main.capabilityTruth.push({ kind: "runtime_tool", state: "observed", observation: "trusted_host_evidence", plannedNames: [], actualNames: observedToolNames });
    main.capabilityTruth.push({ kind: "agent", state: "observed", observation: "trusted_host_evidence", plannedNames: [], actualNames: [runtime] });
  }
  main.childCount = nodes.length - 1;
  if (observation.turnComplete) {
    main.status = "in_doubt";
    main.active = false;
    main.displayState = "in_doubt";
    main.executionState = "executed";
    main.statusReason = `${runtimeLabel} 原生 turn 已结束；结果尚未独立验证或验收。`;
    if (runtime === "claude" && !observation.turnError) {
      main.timing.completedAt = observation.turnReturnEvidence?.observedAt || null;
      main.lastAt = main.timing.completedAt || main.lastAt;
      addClaudeReturn(main, observation.turnReturnEvidence);
    }
  }
  if (!agents.length && !toolCalls.length) {
    main.status = "pending";
    main.active = false;
    main.displayState = "pending";
    main.executionState = "not_observed";
    main.executionObserved = false;
    main.statusReason = `当前精确绑定的 ${runtimeLabel} turn 尚无可展示的工具或 Agent 调用。`;
  }
  if (observation.turnError) {
    main.status = "failed";
    main.displayState = "failed";
    main.active = false;
    main.executionState = "failed";
    main.executionObserved = true;
    main.statusReason = `${runtimeLabel} 返回执行错误；尚未产生可验收结果。`;
    replay.push({ id: id("event", `${runId}:error`), nodeId: mainId, type: "runtime_error", kind: "failure", status: "failed", at: observation.updatedAt, label: `${runtimeLabel} 执行错误`, summary: main.statusReason });
  }
  const returnedAgentCount = agents.filter((agent) => terminal(agent.status)).length;
  const failedAgentCount = agents.filter((agent) => agent.status === "error").length;
  const failedToolCount = toolCalls.filter((tool) => tool.status === "failed").length;
  const executionSummary = { observedAgentCount: agents.length, returnedAgentCount, failedAgentCount, unconfirmedAgentCount: agents.length - returnedAgentCount,
    returnedToolCount: toolCalls.filter((tool) => terminal(tool.status) || tool.status === "failed").length, failedToolCount, acceptanceState: "unproven" };
  const hasRunningWork = agents.some((agent) => agent.status === "running") || toolCalls.some((tool) => tool.status === "running");
  const hasObservedWork = agents.length > 0 || toolCalls.length > 0;
  const runActive = !observation.turnError && !observation.turnComplete && (runtime === "claude" ? hasObservedWork : hasRunningWork);
  const status = observation.turnError ? "failed" : runActive ? "active"
    : runtime === "claude" && observation.turnComplete ? "completed" : observation.turnComplete || hasObservedWork ? "in_doubt" : "pending";
  return {
    schemaVersion: "meta-kim-live-snapshot-v2",
    source: { kind: `${runtime}_native_session`, observedAt: observation.observedAt || observation.updatedAt || observation.startedAt || null, stale: false },
    run: { runId, title: safeText(observation.title) || `${runtimeLabel} 原生会话记录`, task: `当前 ${runtimeLabel} turn 的原生工具与 Agent 调用；不代表验收。`,
      status, active: runActive,
      displayState: status, statusReason: observation.turnError ? main.statusReason : observation.turnComplete ? "原生 turn 已结束，任务结果尚未验收。" : `正在读取精确绑定的 ${runtimeLabel} 原生 turn；任务结果尚未验收。`,
      currentStage: "execution", stageProgressEvidence: "native_execution_only", sourceRuntime: runtime, observationKind: "native_execution", executionSummary,
      executionEvidenceState: toolCalls.length || agents.length ? "recorded" : "not_observed", completionEvidenceState: "unproven",
      acceptanceState: "unproven", conversationLinkState: "verified", conversationRef: observation.sessionId,
      conversationId: observation.sessionId, startedAt: observation.startedAt || null, updatedAt: observation.updatedAt || null,
      observationCoverage: observation.coverage || null },
    session: { sessionId: observation.sessionId, runId, runtime, title: safeText(observation.title) || `${runtimeLabel} 原生会话记录`,
      conversationId: observation.sessionId, turnId: observation.turnId, status, active: runActive,
      startedAt: observation.startedAt || null, updatedAt: observation.updatedAt || null, nodeCount: nodes.length, eventCount: replay.length },
    nodes, edges, evidence: [], replay, prompts: [], toolCalls, provenance: [], repository: null, workspace: null,
    contextTransfers: [], deliverables: [], scheduling: null, nonGoalConstraints: [], declaredPlan: null,
    eventIndex: replay.length, eventCount: replay.length,
    counts: { nodes: nodes.length, edges: edges.length, evidence: 0, executionEvidence: 0, planningEvidence: 0,
      events: replay.length, toolCalls: toolCalls.length, prompts: 0, provenance: 0, contextTransfers: 0 },
    graphAvailability: { state: nodes.length > 1 || toolCalls.length || observation.turnError ? "available" : "no_graph_evidence",
      reason: nodes.length > 1 || toolCalls.length || observation.turnError ? `${runtime}_native_turn_observed` : "no_tool_or_agent_calls_observed" },
    permissions: { projectionOnly: true, executionAllowed: false, mutationAllowed: false, controlEnabled: false },
  };
}

export function nativeZcodeSessionCatalogRow(snapshot) {
  if (!snapshot?.session || !snapshot?.run) return null;
  return { sessionId: snapshot.session.sessionId, runId: snapshot.run.runId, title: snapshot.run.title,
    titleSource: "native_observation", identificationState: "identified", recordOrigin: "native_observation",
    sourceRuntime: snapshot.run.sourceRuntime, runtime: snapshot.run.sourceRuntime, conversationLinkState: "verified", status: snapshot.run.status,
    displayState: snapshot.run.displayState, statusReason: snapshot.run.statusReason,
    updatedAt: snapshot.run.updatedAt, updatedAtBasis: "native_event", startedAt: snapshot.run.startedAt,
    active: snapshot.run.active, workerCount: Math.max(0, snapshot.nodes.length - 1), nodeCount: snapshot.nodes.length, eventCount: snapshot.eventCount,
    countsAvailability: { state: "measured", reason: `${snapshot.run.sourceRuntime}_native_event_observation` },
    executionSummary: snapshot.run.executionSummary, observationCoverage: snapshot.run.observationCoverage };
}
