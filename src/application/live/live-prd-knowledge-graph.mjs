/**
 * Read-only knowledge/dependency view of an already projected Live PRD.
 *
 * This module deliberately owns no project state, approval decision, task order,
 * persistence or editor. In particular, a paginated overview is not proof that
 * a referenced module is absent: its dependency is recorded as unloaded.
 *
 * Edge direction: architecture -> contained module; prerequisite -> dependent.
 * Node identity: architecture:<source id> / module:<source id>.
 */
/**
 * @param {object|null} design - Live's existing design descriptor (possibly paginated).
 * @param {{focusId?:string|null,depth?:number,limit?:number}} options
 * @returns {{focusId:string|null,focusKind:string,nodes:Array,edges:Array,omissions:Array,
 *   hasMore:boolean,totalNodes:number,loadedModules:number,totalModules:number}}
 */
export function buildLivePrdGraph(design, { focusId = null, depth = 2, limit = 40 } = {}) {
  // The Live HTML embeds this function with .toString(), so its complete model
  // logic must remain inside the exported function and require no imports.
  const present = value => typeof value === "string" && value.trim().length > 0;
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const label = (value, fallback) => present(value) ? value.trim() : fallback;
  const boundedInteger = (value, fallback, minimum) => Number.isSafeInteger(value) && value >= minimum ? value : fallback;
  const moduleKey = id => `module:${id}`;
  const architectureKey = id => `architecture:${id}`;
  const dependencyCycles = (modules, prerequisites) => {
    const completed = new Set();
    const active = new Map();
    const found = new Set();
    const cycles = [];
    for (const start of modules.keys()) {
      if (completed.has(start)) continue;
      const frames = [{ id: start, index: 0, links: prerequisites.get(start) || [] }];
      while (frames.length) {
        const frame = frames.at(-1);
        if (!active.has(frame.id)) active.set(frame.id, frames.length - 1);
        if (frame.index === frame.links.length) {
          completed.add(frame.id);
          active.delete(frame.id);
          frames.pop();
          continue;
        }
        const prerequisite = frame.links[frame.index++];
        if (active.has(prerequisite)) {
          const members = frames.slice(active.get(prerequisite)).map(item => item.id);
          const signature = [...members].sort().join("\u001f");
          if (!found.has(signature)) {
            found.add(signature);
            cycles.push({ type: "dependency_cycle", moduleIds: members });
          }
        } else if (!completed.has(prerequisite)) {
          frames.push({ id: prerequisite, index: 0, links: prerequisites.get(prerequisite) || [] });
        }
      }
    }
    return cycles;
  };
  const omissions = [];
  const architecture = object(design?.architecture) && present(design.architecture.id) ? design.architecture : null;
  if (!architecture) omissions.push({ type: "missing_architecture" });
  const inputModules = Array.isArray(design?.modules) ? design.modules : [];
  if (!Array.isArray(design?.modules)) omissions.push({ type: "missing_modules" });

  // Preserve source ordering and source status; display descriptors never become
  // substitutes for the validated software-design or Live review authority.
  const modules = new Map();
  for (const row of inputModules) {
    if (!object(row) || !present(row.id)) {
      omissions.push({ type: "invalid_module" });
    } else if (modules.has(row.id)) {
      omissions.push({ type: "duplicate_module", moduleId: row.id });
    } else {
      modules.set(row.id, row);
    }
  }
  const ordered = [];
  if (Array.isArray(architecture?.moduleIds)) {
    for (const id of architecture.moduleIds) if (modules.has(id) && !ordered.includes(id)) ordered.push(id);
  }
  for (const id of modules.keys()) if (!ordered.includes(id)) ordered.push(id);
  const sourceOrder = new Map(ordered.map((id, index) => [id, index]));
  const compareOrder = (a, b) => sourceOrder.get(a) - sourceOrder.get(b);

  const loadedModules = modules.size;
  const totalModules = boundedInteger(design?.totalModules, loadedModules, loadedModules);
  const hasNextPage = present(design?.nextCursor);
  const partial = totalModules > loadedModules || hasNextPage;
  if (partial) omissions.push({ type: "unloaded_modules", count: Math.max(0, totalModules - loadedModules),
    continuationAvailable: hasNextPage });

  const prerequisites = new Map([...modules.keys()].map(id => [id, []]));
  const dependents = new Map([...modules.keys()].map(id => [id, []]));
  for (const [moduleId, row] of modules) {
    if (row.dependsOn !== undefined && !Array.isArray(row.dependsOn)) {
      omissions.push({ type: "invalid_dependencies", moduleId });
      continue;
    }
    const unique = new Set();
    for (const dependencyId of row.dependsOn || []) {
      if (!present(dependencyId)) {
        omissions.push({ type: "invalid_dependency", moduleId });
      } else if (unique.has(dependencyId)) {
        omissions.push({ type: "duplicate_dependency", moduleId, dependencyId });
      } else if (dependencyId === moduleId) {
        omissions.push({ type: "self_dependency", moduleId });
      } else if (!modules.has(dependencyId)) {
        omissions.push({ type: partial ? "unloaded_dependency" : "unknown_dependency", moduleId, dependencyId });
      } else {
        unique.add(dependencyId);
        prerequisites.get(moduleId).push(dependencyId);
        dependents.get(dependencyId).push(moduleId);
      }
    }
  }
  for (const ids of prerequisites.values()) ids.sort(compareOrder);
  for (const ids of dependents.values()) ids.sort(compareOrder);
  omissions.push(...dependencyCycles(modules, prerequisites));

  // The architecture view is the safe default, including for a not-yet-loaded
  // selection; a blank graph should never masquerade as a completed dependency.
  let selectedModuleId = null;
  if (present(focusId) && !["architecture", architecture?.id, architecture && architectureKey(architecture.id)]
    .includes(focusId)) {
    const requested = focusId.startsWith("module:") ? focusId.slice("module:".length) : focusId;
    if (modules.has(requested)) selectedModuleId = requested;
    else omissions.push({ type: partial ? "unloaded_focus" : "unknown_focus", focusId });
  } else if (present(focusId) && modules.has(focusId) && focusId !== "architecture") {
    // A module may legally share its raw ID with the architecture. Prefer the
    // explicitly namespaced architecture ID if the user intends the overview.
    selectedModuleId = focusId;
  }
  if (present(focusId) && focusId.startsWith("module:") && modules.has(focusId.slice(7))) {
    selectedModuleId = focusId.slice(7);
  }

  const maxNodes = boundedInteger(limit, 40, 1);
  const maxAncestors = depth === "all" ? modules.size : boundedInteger(depth, 2, 0);
  const relative = new Map();
  if (selectedModuleId !== null) {
    relative.set(selectedModuleId, 0);
    let current = [selectedModuleId];
    for (let distance = 1; distance <= maxAncestors && current.length; distance += 1) {
      const next = [];
      for (const id of current) for (const prerequisite of prerequisites.get(id) || []) {
        if (relative.has(prerequisite)) continue;
        relative.set(prerequisite, -distance);
        next.push(prerequisite);
      }
      current = next;
    }
    for (const dependent of dependents.get(selectedModuleId) || []) if (!relative.has(dependent)) relative.set(dependent, 1);
  }

  let candidates;
  if (selectedModuleId !== null) {
    candidates = [...relative.keys()];
    // Prioritize the focus and nearest context when clipping a large local DAG;
    // return in stable source order for predictable layout and click targets.
    candidates.sort((a, b) => Math.abs(relative.get(a)) - Math.abs(relative.get(b)) || compareOrder(a, b));
  } else {
    candidates = [...ordered];
  }
  const projectedCount = candidates.length + (selectedModuleId === null && architecture ? 1 : 0);
  const allowance = Math.max(0, maxNodes - (selectedModuleId === null && architecture ? 1 : 0));
  const visibleIds = new Set(candidates.slice(0, allowance));
  const omittedCount = Math.max(0, projectedCount - maxNodes);
  if (omittedCount) omissions.push({ type: "visibility_limit", count: omittedCount, limit: maxNodes });

  const nodes = [];
  const edges = [];
  if (selectedModuleId === null && architecture) {
    const archNode = { id: architectureKey(architecture.id), sourceId: architecture.id,
      title: label(architecture.title, architecture.id), status: architecture.status ?? null,
      summary: label(architecture.summary, ""), kind: "architecture", depth: 0 };
    if (present(architecture.progressNote)) archNode.progressNote = architecture.progressNote.trim();
    nodes.push(archNode);
  }
  for (const id of ordered) {
    if (!visibleIds.has(id)) continue;
    const row = modules.get(id);
    const nodeRecord = { id: moduleKey(id), sourceId: id, title: label(row.title, id), status: row.status ?? null,
      summary: label(row.summary, label(row.purpose, "")), kind: "module",
      depth: selectedModuleId === null ? 1 : relative.get(id) };
    if (present(row.shortSummary)) nodeRecord.shortSummary = row.shortSummary.trim();
    if (present(row.layer)) nodeRecord.layer = row.layer.trim();
    if (present(row.layerShort)) nodeRecord.layerShort = row.layerShort.trim();
    if (Number.isInteger(row.layerRank)) nodeRecord.layerRank = row.layerRank;
    if (present(row.directory)) nodeRecord.directory = row.directory.trim();
    if (Number.isInteger(row.fileCount)) nodeRecord.fileCount = row.fileCount;
    nodes.push(nodeRecord);
    if (selectedModuleId === null && architecture) edges.push({ from: architectureKey(architecture.id), to: moduleKey(id), type: "containment" });
  }
  for (const dependentId of ordered) {
    if (!visibleIds.has(dependentId)) continue;
    for (const prerequisiteId of prerequisites.get(dependentId) || []) {
      if (visibleIds.has(prerequisiteId)) edges.push({ from: moduleKey(prerequisiteId),
        to: moduleKey(dependentId), type: "required_dependency" });
    }
  }
  return { focusId: selectedModuleId !== null ? moduleKey(selectedModuleId) : architecture ? architectureKey(architecture.id) : null,
    focusKind: selectedModuleId !== null ? "module" : architecture ? "architecture" : "none",
    nodes, edges, omissions, hasMore: partial || omittedCount > 0,
    totalNodes: projectedCount, loadedModules, totalModules };
}
