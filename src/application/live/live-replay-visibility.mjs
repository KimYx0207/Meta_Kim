/**
 * Replay-cursor node view for the Meta_Kim Live execution graph.
 *
 * `resolveReplayNodeView` is deliberately self-contained: the control-room page
 * serializes it into the shipped client bundle so the browser and the server
 * share one implementation instead of two drifting copies. It must therefore
 * reference nothing outside its own body except JS built-ins, and it resolves
 * projection field candidates through nested helpers rather than shared
 * module-scope utilities.
 *
 * Visibility rules, in order:
 *   1. No replay events -> the whole graph is present state, show everything.
 *   2. Cursor at (or past) the last event -> replay finished, show everything.
 *   3. The main run owner is always on screen; it is the graph entry point.
 *   4. A node referenced by any event up to the cursor is on screen.
 *   5. A node with no start timestamp is declared-but-unstarted work. The locked
 *      visual contract renders that as a dimmed dashed node, so it stays on
 *      screen rather than disappearing.
 *   6. A node that started at or before the cursor timestamp is on screen.
 *   7. Structural parents of any visible node are pulled in, so a worker never
 *      floats without its lane.
 *
 * Node visibility is never derived from event `kind`. A tool-level event stream
 * carries no node-spawn semantics, and gating on a kind allowlist silently hides
 * every node whose activity was reported by a kind outside the list.
 *
 * The resolver fails open: when the cursor event carries no parseable timestamp
 * the time comparison is skipped and the node stays visible. A missing timestamp
 * must never blank the graph.
 *
 * Timestamps are read through candidate field lists because the client
 * normalizer emits `at` while raw fixtures and the demo payload use `timestamp`.
 * Reading a single field name is how the previous gate silently disabled itself.
 */
export const LIVE_REPLAY_VISIBILITY_SCHEMA_VERSION = "meta-kim-live-replay-visibility-v1";

export const LIVE_DEFAULT_STRUCTURAL_EDGE_KINDS = Object.freeze(["contains"]);

export function resolveReplayNodeView(input) {
  const source = input && typeof input === "object" ? input : {};
  const nodes = Array.isArray(source.nodes) ? source.nodes : [];
  const events = Array.isArray(source.events) ? source.events : [];
  const edges = Array.isArray(source.edges) ? source.edges : [];
  const structuralKinds = Array.isArray(source.structuralEdgeKinds) && source.structuralEdgeKinds.length > 0
    ? source.structuralEdgeKinds
    : ["contains"];
  const pendingStatus = typeof source.pendingStatus === "string" && source.pendingStatus !== ""
    ? source.pendingStatus
    : "queued";
  const activeStatus = typeof source.activeStatus === "string" && source.activeStatus !== ""
    ? source.activeStatus
    : "running";

  const millis = (value) => {
    if (typeof value !== "string" || value === "") return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const firstTimestamp = (candidates) => {
    for (const candidate of candidates) {
      const parsed = millis(candidate);
      if (parsed !== null) return parsed;
    }
    return null;
  };
  const startOf = (node) => firstTimestamp([node.startedAt, node.timing && node.timing.startedAt, node.firstAt]);
  const endOf = (node) => firstTimestamp([node.completedAt, node.timing && node.timing.completedAt, node.lastAt]);
  const timeOf = (event) => firstTimestamp([event.at, event.timestamp, event.occurredAt, event.time]);

  const identified = nodes.filter((node) => node && typeof node.id === "string" && node.id !== "");
  const rawCursor = Number(source.cursorIndex);
  const cursorIndex = Number.isFinite(rawCursor) ? Math.trunc(rawCursor) : events.length - 1;
  const replayComplete = events.length === 0 || cursorIndex >= events.length - 1;
  const cursorTime = !replayComplete && cursorIndex >= 0 && events[cursorIndex]
    ? timeOf(events[cursorIndex])
    : null;

  const latestEventStatus = new Map();
  const referenced = new Set();
  const lastIndex = replayComplete ? events.length - 1 : cursorIndex;
  for (let index = 0; index <= lastIndex && index < events.length; index += 1) {
    const event = events[index];
    if (!event || typeof event.nodeId !== "string" || event.nodeId === "") continue;
    referenced.add(event.nodeId);
    if (typeof event.status === "string" && event.status !== "") latestEventStatus.set(event.nodeId, event.status);
  }

  const visible = new Set();
  const statusByNodeId = {};
  for (const node of identified) {
    const startedMs = startOf(node);
    const completedMs = endOf(node);
    const eventStatus = latestEventStatus.has(node.id) ? latestEventStatus.get(node.id) : null;
    const declaredStatus = typeof node.status === "string" && node.status !== "" ? node.status : pendingStatus;

    if (replayComplete) {
      visible.add(node.id);
      statusByNodeId[node.id] = eventStatus || declaredStatus;
      continue;
    }

    const startedByCursor = startedMs === null || cursorTime === null || startedMs <= cursorTime;
    if (node.isMain === true || referenced.has(node.id) || startedByCursor) visible.add(node.id);

    if (eventStatus) statusByNodeId[node.id] = eventStatus;
    else if (startedMs === null) statusByNodeId[node.id] = pendingStatus;
    else if (cursorTime === null) statusByNodeId[node.id] = declaredStatus;
    else if (completedMs !== null && completedMs <= cursorTime) statusByNodeId[node.id] = declaredStatus;
    else if (startedMs <= cursorTime) statusByNodeId[node.id] = activeStatus;
    else statusByNodeId[node.id] = pendingStatus;
  }

  if (!replayComplete) {
    const parents = new Map();
    for (const edge of edges) {
      if (!edge || typeof edge.from !== "string" || typeof edge.to !== "string") continue;
      if (!structuralKinds.includes(edge.kind)) continue;
      const existing = parents.get(edge.to);
      if (existing) existing.push(edge.from);
      else parents.set(edge.to, [edge.from]);
    }
    const known = new Set(identified.map((node) => node.id));
    const pending = Array.from(visible);
    while (pending.length > 0) {
      const current = pending.pop();
      const ancestors = parents.get(current);
      if (!ancestors) continue;
      for (const ancestor of ancestors) {
        if (known.has(ancestor) && !visible.has(ancestor)) {
          visible.add(ancestor);
          pending.push(ancestor);
        }
      }
    }
  }

  return {
    replayComplete,
    cursorIndex,
    cursorTime,
    visibleNodeIds: identified.map((node) => node.id).filter((id) => visible.has(id)),
    statusByNodeId,
  };
}

/** Convenience read of the visible-node set. Server-side only; not serialized. */
export function resolveReplayVisibleNodeIds(input) {
  return resolveReplayNodeView(input).visibleNodeIds;
}

/** Serialize the resolver for inlining into the browser bundle. */
export function serializeReplayNodeViewResolver() {
  return resolveReplayNodeView.toString();
}
