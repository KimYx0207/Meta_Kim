/** Retain source records across discovered runtimes within a publication budget. */
export function selectRuntimeAgentEvidence(agents, limit, selectedIds = new Set()) {
  if (agents.length <= limit) return [...agents];
  const groups = new Map();
  const retained = new Set();
  const retain = (index) => {
    if (retained.size >= limit) return;
    retained.add(index);
  };
  agents.forEach((agent, index) => {
    const runtime = agent?.runtime;
    if (!groups.has(runtime)) groups.set(runtime, { indexes: [], selected: [], cursor: 0, selectedCursor: 0 });
    const group = groups.get(runtime);
    group.indexes.push(index);
    if (selectedIds.has(agent?.id)) group.selected.push(index);
  });
  // Native names can repeat across runtimes and source paths. Preserve records
  // by their inventory positions instead of collapsing them by agent id.
  const runtimeGroups = [...groups.values()];
  // If there are more runtimes than slots, full representation is impossible:
  // selected groups take precedence, with discovery order as the tie-breaker.
  const orderedGroups = runtimeGroups.length > limit
    ? [...runtimeGroups.filter(group => group.selected.length), ...runtimeGroups.filter(group => !group.selected.length)]
    : runtimeGroups;
  for (const group of orderedGroups) {
    retain(group.selected[0] ?? group.indexes[0]);
  }
  const fill = (key, cursorKey) => {
    let progressed = true;
    while (retained.size < Math.min(limit, agents.length) && progressed) {
      progressed = false;
      for (const group of orderedGroups) {
        if (retained.size >= limit) break;
        while (group[cursorKey] < group[key].length && retained.has(group[key][group[cursorKey]])) group[cursorKey] += 1;
        if (group[cursorKey] < group[key].length) {
          retain(group[key][group[cursorKey]++]);
          progressed = true;
        }
      }
    }
  };
  fill("selected", "selectedCursor");
  fill("indexes", "cursor");
  return [...retained].sort((a, b) => a - b).map((index) => agents[index]);
}
