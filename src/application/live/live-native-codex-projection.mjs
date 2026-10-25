import { createHash } from "node:crypto";

const id = (kind, value) => `${kind}:${createHash("sha256").update(String(value)).digest("hex").slice(0, 20)}`;
const emptyLoadout = () => ({ skills: 0, mcp: 0, tools: 0, commands: 0, hooks: 0, plugins: 0, memoryGraph: 0, dependencies: 0, skillNames: [], mcpNames: [], toolNames: [], commandNames: [], hookNames: [], pluginNames: [], memoryGraphNames: [], dependencyNames: [] });

function baseNode({ nodeId, taskId, label, owner, main = false, at }) {
  return {
    id: nodeId, kind: "agent", isMain: main, label, task: main ? "当前 Codex 会话中实际观察到的工具和子任务执行" : "原生派发的子任务",
    taskPacketId: taskId, roleDisplayName: main ? null : label, ownerAgent: owner || null,
    roleInstanceId: taskId, stage: "execution", parentId: null,
    status: "active", active: true, displayState: "active", executionState: "executing", executionObserved: true,
    statusReason: "已观察到当前原生会话的执行事件；任务结果尚未验收。",
    runtime: "codex", model: "unavailable", inputTokens: null, outputTokens: null, totalTokens: null,
    timing: { startedAt: at || null, completedAt: null, durationMs: null }, firstAt: at || null, lastAt: at || null,
    durationMs: null, terminalEvidence: [], workerExecutionEvidence: [], toolCalls: [], toolCount: 0,
    loadout: emptyLoadout(), capabilityTruth: [], promptEras: [], provenance: [], evidenceCount: 0,
    summary: "来自只读原生事件观察；没有将调用结束解释为用户验收。",
  };
}

function evidence({ runId, taskId, nodeId, eventId, at, sha256, label }) {
  return {
    id: id("native-proof", eventId), type: "execution", label, status: "executed",
    evidenceKind: "native_host_observation", executionObserved: true, synthetic: false,
    runId, taskPacketId: taskId, nodeId, observedAt: at, sourceEventId: eventId,
    sourceDigest: sha256, sourceKind: "codex_desktop_native_session",
    detail: "原生事件已观察；这不是任务验收证据。",
  };
}

/** Build a standalone observed run without altering any governed planning run. */
export function buildNativeCodexLiveSnapshot(observation) {
  if (observation?.state !== "observed" || !observation?.binding?.projectRootMatched) return null;
  const runId = `native-codex-${observation.threadId}-${observation.turnId}`;
  const mainId = id("agent", `${runId}:main`);
  const mainTaskId = id("native-task", `${runId}:main`);
  const main = baseNode({ nodeId: mainId, taskId: mainTaskId, label: "Codex", owner: "codex", main: true, at: observation.startedAt });
  const nodes = [main];
  const edges = [];
  const replay = [];
  const allEvidence = [];
  const toolCalls = [];
  const addEvidence = (node, record) => {
    node.workerExecutionEvidence.push(record);
    node.evidenceCount += 1;
    allEvidence.push(record);
  };
  for (const call of observation.pairedToolCalls || []) {
    if (call.namespace === "collaboration" && call.name === "spawn_agent") continue;
    // Typed commands describe work inside a batch. Pure JavaScript batches
    // still count as observed host calls when no inner command was emitted.
    if (call.namespace === "functions" && call.name === "exec" && (observation.commands || []).some((command) => command.at >= call.at && command.at <= call.endedAt)) continue;
    const tool = {
      id: id("tool", call.id), callId: call.id, name: [call.namespace, call.name].filter(Boolean).join("."),
      toolName: [call.namespace, call.name].filter(Boolean).join("."), status: "returned", at: call.at,
      executionObserved: true, runId, taskPacketId: mainTaskId, nodeId: mainId,
      summary: "原生工具调用已返回；输出正文未公开。", sourceDigest: call.sha256,
    };
    main.toolCalls.push(tool);
    toolCalls.push(tool);
    addEvidence(main, evidence({ runId, taskId: mainTaskId, nodeId: mainId, eventId: call.id, at: call.at, sha256: call.sha256, label: "原生工具调用已返回" }));
    replay.push({ id: id("event", call.id), type: "tool_returned", kind: "tool", nodeId: mainId, at: call.at, status: "executed", label: tool.name, summary: tool.summary });
  }
  for (const command of observation.commands || []) {
    const failed = command.exitCode !== null && command.exitCode !== 0;
    const tool = {
      id: id("tool", command.id), callId: command.id, name: "shell", toolName: "shell", status: failed ? "failed" : command.exitCode === 0 ? "completed" : "returned",
      at: command.at, exitCode: command.exitCode, durationMs: command.durationMs, executionObserved: true,
      runId, taskPacketId: mainTaskId, nodeId: mainId, sourceDigest: command.sha256,
      summary: command.exitCode === null ? "原生命令事件已记录，退出码未提供。" : `原生命令退出码 ${command.exitCode}；命令和输出正文未公开。`,
    };
    main.toolCalls.push(tool);
    toolCalls.push(tool);
    addEvidence(main, evidence({ runId, taskId: mainTaskId, nodeId: mainId, eventId: command.id, at: command.at, sha256: command.sha256, label: failed ? "原生命令失败记录" : "原生命令执行记录" }));
    replay.push({ id: id("event", command.id), type: "command_returned", kind: "tool", nodeId: mainId, at: command.at, status: failed ? "failed" : "executed", label: "shell", summary: tool.summary });
  }
  for (const agent of observation.agents || []) {
    const childSource = agent.observationBasis === "verified_child_parent_turn" && agent.childMetadataVerified === true && agent.spawnReturned !== true;
    const taskId = id("native-task", agent.id);
    const nodeId = id("agent", `${runId}:${agent.id}`);
    const node = baseNode({ nodeId, taskId, label: agent.role || agent.owner || "worker", owner: agent.owner, at: agent.at });
    node.parentId = mainId;
    node.task = agent.taskName || (childSource ? "子会话源已观察的任务" : "原生派发的子任务");
    node.provenance.push({ kind: childSource ? "source_parent_link" : "native_spawn", state: "observed",
      ...(childSource ? { sourceEventId: agent.id, parentDispatchCovered: false } : { sourceCallId: agent.id }),
      sourceThreadId: observation.threadId, childThreadId: agent.childThreadId });
    if (agent.completed && agent.childMetadataVerified) {
      node.status = "in_doubt";
      node.active = false;
      node.displayState = "in_doubt";
      node.executionState = "executed";
      node.statusReason = childSource ? "子会话源已验证本轮父任务关联与返回；父派发记录未覆盖，任务结果尚未验收。" : "同一父会话派发的子任务已返回；任务结果尚未验收。";
      node.timing.completedAt = agent.completedAt;
      node.lastAt = agent.completedAt;
    } else {
      node.status = "in_doubt";
      node.active = false;
      node.displayState = "in_doubt";
      node.executionState = "unknown";
      node.statusReason = childSource ? "子会话源已验证本轮父任务关联；父派发记录未覆盖，当前返回状态尚未确认。" : "已观察到原生派发，但尚未确认返回；子任务当前执行状态未知。";
    }
    addEvidence(node, evidence({ runId, taskId, nodeId, eventId: agent.id, at: agent.at, sha256: agent.sha256, label: childSource ? "子会话源已观察，父派发记录未覆盖" : "原生子任务已派发" }));
    if (agent.completed && agent.childMetadataVerified) {
      addEvidence(node, evidence({ runId, taskId, nodeId, eventId: `${agent.id}:return`, at: agent.completedAt, sha256: agent.completionSha256, label: "原生子任务已返回" }));
    }
    nodes.push(node);
    edges.push({ id: id("edge", agent.id), from: mainId, to: nodeId, kind: childSource ? "source_parent_link" : "spawned" });
    replay.push({ id: id("event", agent.id), type: childSource ? "child_source_observed" : "agent_spawned", kind: "agent", nodeId, at: agent.at, status: "observed", label: node.label,
      summary: childSource ? "原生子会话元数据及task_started已关联本轮；父派发事件不在观察范围内。" : "来自同一原生父会话的派发事件；当前是否仍在执行未确认。" });
    if (agent.completed && agent.childMetadataVerified) replay.push({ id: id("event", `${agent.id}:return`), type: "agent_returned", kind: "agent", nodeId, at: agent.completedAt, status: "executed", label: node.label, summary: node.statusReason });
  }
  main.toolCount = main.toolCalls.length;
  main.loadout.tools = new Set(main.toolCalls.map((tool) => tool.name)).size;
  main.loadout.toolNames = [...new Set(main.toolCalls.map((tool) => tool.name))];
  main.childCount = nodes.length - 1;
  if (observation.turnComplete) {
    main.status = "in_doubt";
    main.displayState = "in_doubt";
    main.executionState = "executed";
    main.active = false;
  }
  const hasExecution = allEvidence.length > 0;
  if (!hasExecution) {
    main.executionObserved = false;
    main.executionState = "not_observed";
    main.status = "pending";
    main.displayState = "pending";
    main.active = false;
    main.statusReason = "当前已绑定原生会话；这个 turn 尚无执行观察。";
  }
  replay.sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id));
  const updatedAt = replay.at(-1)?.at || observation.startedAt;
  const active = hasExecution && !observation.turnComplete;
  const state = !hasExecution ? "pending" : active ? "active" : "in_doubt";
  const statusReason = !hasExecution ? "当前已绑定原生会话；这个 turn 尚无执行观察。" : active ? "正在观察当前 Codex 原生执行；任务结果尚未验收。" : "已观察到本轮原生执行结束；任务结果尚未验收。";
  // Execution returning and the user's result being accepted are separate facts.
  // The latter is deliberately never inferred from a native terminal event.
  const agents = observation.agents || [];
  const returnedAgentCount = agents.filter((agent) => agent.completed && agent.childMetadataVerified).length;
  const executionSummary = { observedAgentCount: agents.length, returnedAgentCount, unconfirmedAgentCount: agents.length - returnedAgentCount, returnedToolCount: toolCalls.length, failedToolCount: toolCalls.filter((tool) => tool.status === "failed").length, acceptanceState: "unproven" };
  const conversation = { sourceRuntime: "codex", conversationLinkState: "verified", conversationRef: observation.threadId, conversationDiscovery: { state: "verified", runtime: "codex", reason: "explicit_thread_turn_and_native_cwd_match" }, verifiedLinks: [{ sourceRuntime: "codex", conversationRef: observation.threadId, matchBasis: "native_session_metadata" }], candidateLinks: [] };
  return {
    schemaVersion: "meta-kim-live-snapshot-v1",
    source: { kind: "codex_desktop_native_session", observedAt: observation.observedAt, stale: false, readOnly: true, limitations: observation.limitations, coverage: observation.coverage || null },
    run: { runId, title: "当前 Codex 真实执行记录", task: "当前会话中实际观察到的工具调用与子任务；不代表用户验收。", status: state, active, displayState: state, statusReason, currentStage: "execution", stageProgressEvidence: "native_execution_only", observationKind: "native_execution", executionSummary, observationCoverage: observation.coverage || null, executionEvidenceState: hasExecution ? "recorded" : "not_observed", completionEvidenceState: "unproven", recordOrigin: "governed_run", substanceClass: "substantive", startedAt: observation.startedAt, updatedAt, ...conversation },
    session: { sessionId: id("session", runId), title: "当前 Codex 真实执行记录", status: state, active, displayState: state, statusReason, runtime: "codex", mode: "native observed", executionSummary, nodeCount: nodes.length, eventCount: replay.length, plannedCount: 0, completedCount: 0, failedCount: 0, blockedCount: 0, proofState: "native execution observed; task acceptance unproven", ...conversation },
    nodes, edges, evidence: allEvidence, replay, prompts: [], toolCalls, provenance: [], repository: null, workspace: null, contextTransfers: [], deliverables: [], scheduling: null, nonGoalConstraints: [], declaredPlan: null,
    eventIndex: replay.length, eventCount: replay.length,
    counts: { nodes: nodes.length, edges: edges.length, evidence: allEvidence.length, executionEvidence: allEvidence.length, planningEvidence: 0, events: replay.length, toolCalls: toolCalls.length, prompts: 0, provenance: 0, contextTransfers: 0 },
    permissions: { projectionOnly: true, executionAllowed: false, mutationAllowed: false, controlEnabled: false },
  };
}

/** Safe catalog row for the same observed snapshot. */
export function nativeCodexSessionCatalogRow(snapshot) {
  return { sessionId: snapshot.session.sessionId, ...snapshot.run, runId: snapshot.run.runId, titleSource: "native_observation", identificationState: "identified", workerCount: snapshot.nodes.length - 1, nodeCount: snapshot.nodes.length, eventCount: snapshot.eventCount, countsAvailability: { state: "measured", reason: "native_event_observation" }, updatedAtBasis: "native_event", runtime: "codex" };
}
