import { scopeComparisonKey, scopeKeysAreProvablyDisjoint } from "../task-scope-comparison.mjs";

function arrayOfStrings(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim())
    : [];
}

export function taskIsExecutableWorker(packet) {
  return packet?.executionMode !== "approval_gate" && packet?.externalWriteBoundary !== true;
}

export function taskDependencyIds(packet) {
  return arrayOfStrings(packet?.dependsOn).filter(
    (value, index, array) => array.indexOf(value) === index,
  );
}

function taskCollisionScopes(packet) {
  const scopeFiles = arrayOfStrings(packet?.scopeFiles).map(scopeComparisonKey);
  if (scopeFiles.some((scope) => scope === null)) return [];
  if (scopeFiles.length > 0) return scopeFiles.map((scope) => `file:${scope}`);
  if (packet?.artifactNamespace && ["run_scoped", "isolated_worktree", "isolated_workspace"].includes(packet.workspaceIsolation)) {
    return [`artifact:${packet.artifactNamespace}`];
  }
  return [];
}

function knownPolicy(value) {
  return typeof value === "string" && value.trim() && !["unknown", "unspecified", "unproven"].includes(value);
}

function scopesOverlap(left, right) {
  if (left === right) return true;
  if (!left.startsWith("file:") || !right.startsWith("file:")) return false;
  return !scopeKeysAreProvablyDisjoint(left.slice("file:".length), right.slice("file:".length));
}

function detectDependencyCycles(tasks) {
  const taskIds = new Set(tasks.map((packet) => packet.taskPacketId));
  const visiting = new Set();
  const visited = new Set();
  const cycleTaskIds = new Set();
  const visit = (taskId, stack = []) => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) {
      for (const id of stack.slice(stack.indexOf(taskId))) cycleTaskIds.add(id);
      return;
    }
    visiting.add(taskId);
    const task = tasks.find((packet) => packet.taskPacketId === taskId);
    for (const dependencyId of taskDependencyIds(task).filter((id) => taskIds.has(id))) {
      visit(dependencyId, [...stack, taskId]);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.taskPacketId);
  return [...cycleTaskIds];
}

export function buildFanoutSafetyPacket(executableTasks) {
  const taskIds = new Set(executableTasks.map((packet) => packet.taskPacketId));
  const rows = executableTasks.map((packet) => {
    const dependencyIds = taskDependencyIds(packet);
    return {
      taskPacketId: packet.taskPacketId,
      parallelGroup: packet.parallelGroup ?? null,
      dependsOn: dependencyIds,
      collisionPolicy: packet.collisionPolicy ?? "unspecified",
      workspaceIsolation: packet.workspaceIsolation ?? "unspecified",
      mutationPolicy: packet.mutationPolicy ?? "unproven",
      safetyStatus: packet.safetyEvidence?.status ?? null,
      mutationScopes: taskCollisionScopes(packet),
      externalWriteBoundary: packet.externalWriteBoundary === true,
      externalWriteSafe: packet.externalWriteBoundary !== true &&
        (packet.externalWritePolicy === "forbidden" || (packet.externalWritePolicy == null && packet.externalWriteBoundary === false)),
    };
  });
  const missingDependencies = rows.flatMap((row) =>
    row.dependsOn
      .filter((dependencyId) => !taskIds.has(dependencyId))
      .map((dependencyId) => ({ taskPacketId: row.taskPacketId, dependencyId })),
  );
  const selfDependencies = rows
    .filter((row) => row.dependsOn.includes(row.taskPacketId))
    .map((row) => row.taskPacketId);
  const cycleTaskIds = detectDependencyCycles(executableTasks);
  const dependsTransitively = (taskId, dependencyId, seen = new Set()) => {
    if (seen.has(taskId)) return false;
    seen.add(taskId);
    return (rows.find((row) => row.taskPacketId === taskId)?.dependsOn ?? [])
      .some((id) => id === dependencyId || dependsTransitively(id, dependencyId, seen));
  };
  const collisionConflicts = rows.flatMap((row, index) => rows.slice(index + 1).flatMap((other) => {
    const readOnly = (entry) => ["read_only", "read_only_target"].includes(entry.mutationPolicy);
    if ((readOnly(row) && readOnly(other)) || dependsTransitively(row.taskPacketId, other.taskPacketId) || dependsTransitively(other.taskPacketId, row.taskPacketId)) return [];
    const scope = row.mutationScopes.find((left) => other.mutationScopes.some((right) => scopesOverlap(left, right)));
    return scope ? [{ scope, taskPacketIds: [row.taskPacketId, other.taskPacketId] }] : [];
  }));
  const explicitParallelMetadata = rows.every(
    (row) => Boolean(row.parallelGroup) &&
      knownPolicy(row.collisionPolicy) && knownPolicy(row.workspaceIsolation) && knownPolicy(row.mutationPolicy) &&
      row.safetyStatus !== "unproven" && row.mutationScopes.length > 0,
  );
  const initialReadyLaneCount = rows.filter((row) => row.dependsOn.length === 0).length;
  const safeForParallelFanout = rows.length >= 2 &&
    explicitParallelMetadata &&
    missingDependencies.length === 0 &&
    selfDependencies.length === 0 &&
    cycleTaskIds.length === 0 &&
    collisionConflicts.length === 0 &&
    rows.every((row) => row.externalWriteSafe && !row.externalWriteBoundary);
  return {
    schemaVersion: "agent-teams-fanout-safety-v0.1",
    status: safeForParallelFanout ? "pass" : rows.length >= 2 ? "partial" : "not_required",
    executableLaneCount: rows.length,
    initialReadyLaneCount,
    explicitParallelMetadata,
    missingDependencies,
    selfDependencies,
    cycleTaskIds,
    collisionConflicts,
    dependencySafe:
      missingDependencies.length === 0 && selfDependencies.length === 0 && cycleTaskIds.length === 0,
    collisionSafe: rows.every((row) => row.mutationScopes.length > 0) && collisionConflicts.length === 0,
    externalWriteSafe: rows.every((row) => row.externalWriteSafe && !row.externalWriteBoundary),
    safeForParallelFanout,
    rows,
  };
}

export function buildAgentTeamsWaves(workerTaskPackets, parallelBudget, fanoutSafetyPacket = null) {
  const executableTasks = workerTaskPackets.filter(taskIsExecutableWorker);
  if (!parallelBudget) throw new TypeError("parallelBudget is required");
  const safetyPacket = fanoutSafetyPacket ?? buildFanoutSafetyPacket(executableTasks);
  if (!safetyPacket.safeForParallelFanout) return [];
  const waves = [];
  const remaining = new Map(executableTasks.map((task) => [task.taskPacketId, task]));
  const completed = new Set();
  while (remaining.size > 0) {
    const readyTasks = [...remaining.values()].filter((task) =>
      taskDependencyIds(task).every(
        (dependencyId) => completed.has(dependencyId) || !remaining.has(dependencyId),
      ),
    );
    if (readyTasks.length === 0) break;
    const tasks = readyTasks.slice(0, parallelBudget.maxConcurrentAgents);
    waves.push({
      waveId: `agent-team-wave-${waves.length + 1}`,
      mode: waves.length === 0 ? "primary_parallel_wave" : "followup_parallel_wave",
      taskPacketIds: tasks.map((packet) => packet.taskPacketId),
      roleDisplayNames: tasks.map((packet) => packet.roleDisplayName),
      parallelCount: tasks.length,
      requestedParallelAgents: parallelBudget.requestedParallelAgents,
      runtimeCapacity: parallelBudget.runtimeCapacity,
      capacitySource: parallelBudget.capacitySource,
      capacitySourceKind: parallelBudget.capacitySourceKind,
      mergeOwner: "meta-conductor",
    });
    for (const task of tasks) {
      completed.add(task.taskPacketId);
      remaining.delete(task.taskPacketId);
    }
  }
  return waves;
}
