/**
 * Presentation-only graph semantics, compact arrangement and obstacle routing.
 * These resolvers are serialized into the dependency-free Live page. Keep them
 * self-contained so the browser and the behavioral tests execute the same code.
 */

/** Classify declared relations without deriving execution from ownership. */
export function classifyGraphRelations(nodes, edges, executionKinds) {
  const kinds = new Set(executionKinds);
  const ids = new Set(nodes.map((node) => node.id));
  const relations = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  const executionEdges = relations.filter((edge) => kinds.has(edge.kind || "sequence"));
  const structuralEdges = relations.filter((edge) => edge.kind === "contains");
  const otherEdges = relations.filter((edge) => edge.kind !== "contains" && !kinds.has(edge.kind || "sequence"));
  const participants = new Set(executionEdges.flatMap((edge) => [edge.from, edge.to]));
  const otherParticipants = new Set(otherEdges.flatMap((edge) => [edge.from, edge.to]));
  const contextNodes = nodes.filter((node) => !participants.has(node.id) && !otherParticipants.has(node.id)
    && !node.taskPacketId && (node.isMain === true || ["workflow", "group", "main_agent"].includes(node.kind)));
  const contextIds = new Set(contextNodes.map((node) => node.id));
  const executionNodes = nodes.filter((node) => participants.has(node.id));
  const unlinkedNodes = nodes.filter((node) => !participants.has(node.id) && !contextIds.has(node.id));
  const upstream = new Map(executionNodes.map((node) => [node.id, []]));
  const downstream = new Map(executionNodes.map((node) => [node.id, []]));
  for (const edge of executionEdges) {
    upstream.get(edge.to).push(edge.from);
    downstream.get(edge.from).push(edge.to);
  }
  const remaining = new Map([...upstream].map(([id, from]) => [id, from.length]));
  const queue = executionNodes.filter((node) => remaining.get(node.id) === 0).map((node) => node.id).sort();
  const rankById = new Map(queue.map((id) => [id, 0]));
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    for (const target of downstream.get(id)) {
      rankById.set(target, Math.max(rankById.get(target) || 0, rankById.get(id) + 1));
      remaining.set(target, remaining.get(target) - 1);
      if (remaining.get(target) === 0) queue.push(target);
    }
  }
  const cyclic = queue.length !== executionNodes.length;
  // Cyclic participants stay present, but receive no invented execution rank.
  if (cyclic) for (const node of executionNodes) if (remaining.get(node.id) > 0) rankById.delete(node.id);
  return { nodes, edges: relations, executionNodes, contextNodes, unlinkedNodes,
    executionEdges, structuralEdges, otherEdges, rankById, cyclic };
}

/**
 * Search independent-source and context-band shapes against the actual canvas.
 * A source block can wrap; every subsequent rank stays after its predecessors.
 * Cell height is a screen-space reading budget expressed in world coordinates.
 * Complete-card heights remain an independent reservation for the card tier.
 */
export function resolveDependencyGraphLayout(input) {
  const { plan } = input;
  const width = input.cardWidth;
  const heights = input.nodeHeights || new Map();
  const tier = input.tier === "cell" ? "cell" : "card";
  const scale = Math.max(0.01, Number(input.scale) || 1);
  const heightOf = (node) => tier === "cell" ? input.cellScreenHeight / scale
    : Math.max(input.cardHeight, heights.get(node.id) || 0);
  const compare = (a, b) => String(a.firstAt || "").localeCompare(String(b.firstAt || ""))
    || String(a.label || a.id).localeCompare(String(b.label || b.id)) || a.id.localeCompare(b.id);
  const context = input.includeContext === false ? [] : [...plan.contextNodes].sort(compare);
  const unlinked = [...plan.unlinkedNodes].sort(compare);
  const sources = plan.executionNodes.filter((node) => plan.cyclic || (plan.rankById.get(node.id) || 0) === 0).sort(compare);
  const lanes = new Map();
  for (const node of plan.executionNodes) {
    const rank = plan.cyclic ? 0 : plan.rankById.get(node.id) || 0;
    if (rank === 0) continue;
    const lane = lanes.get(rank) || [];
    lane.push(node);
    lanes.set(rank, lane);
  }
  for (const lane of lanes.values()) lane.sort(compare);
  // Cells have no capability grid. Their gutters can use half the full-card
  // spacing, while a 48px world gutter still leaves two 24px port channels.
  const gapX = tier === "cell" ? Math.max(48, input.columnGap / 2) : input.columnGap;
  const gapY = tier === "cell" ? input.rowGap / 2 : input.rowGap;
  const pad = input.padding;
  const labelHeight = 18 / scale;
  const sectionGap = Math.max(32, gapY * 0.65);
  const sourceCount = Math.max(1, sources.length);
  const contextCount = Math.max(1, context.length);
  const inset = input.inset || {};
  const availableWidth = Math.max(1, (input.canvas?.width || 760) - (inset.left || 0) - (inset.right || 0));
  const availableHeight = Math.max(1, (input.canvas?.height || 420) - (inset.top || 0) - (inset.bottom || 0));
  let best = null;
  const sourceChoices = input.arrangement ? [input.arrangement.sourceColumns] : Array.from({ length: sourceCount }, (_, index) => index + 1);
  const contextChoices = input.arrangement ? [input.arrangement.contextColumns] : Array.from({ length: contextCount }, (_, index) => index + 1);
  for (const sourceColumns of sourceChoices) for (const contextColumns of contextChoices) {
    const positions = new Map();
    const bands = [];
    let top = pad.top;
    let right = pad.left;
    const placeGrid = (items, columns, x, y, group) => {
      const rows = Math.ceil(items.length / columns);
      const rowHeights = Array.from({ length: rows }, (_, row) => Math.max(...items.slice(row * columns, (row + 1) * columns).map(heightOf)));
      let rowTop = y;
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const node = items[row * columns + column];
          if (!node) continue;
          positions.set(node.id, { x: x + column * (width + gapX), y: rowTop, width,
            height: heightOf(node), group, rank: plan.rankById.get(node.id), source: group === "execution" && (plan.rankById.get(node.id) || 0) === 0 });
        }
        rowTop += rowHeights[row] + (row + 1 < rows ? gapY : 0);
      }
      right = Math.max(right, x + Math.min(columns, items.length) * width + Math.max(0, Math.min(columns, items.length) - 1) * gapX);
      return rowTop;
    };
    if (context.length) {
      bands.push({ group: "context", x: pad.left, y: top, height: labelHeight });
      top = placeGrid(context, contextColumns, pad.left, top + labelHeight, "context") + sectionGap;
    }
    const executionTop = top;
    const sourceBottom = placeGrid(sources, sourceColumns, pad.left, top, "execution");
    let bottom = sourceBottom;
    const sourceWidth = Math.min(sourceColumns, sourceCount) * width + Math.max(0, Math.min(sourceColumns, sourceCount) - 1) * gapX;
    const sourceHeight = Math.max(0, sourceBottom - executionTop);
    for (const [rank, lane] of [...lanes].sort(([a], [b]) => a - b)) {
      const laneHeight = lane.reduce((sum, node) => sum + heightOf(node), 0) + Math.max(0, lane.length - 1) * gapY;
      const x = pad.left + sourceWidth + gapX + (rank - 1) * (width + gapX);
      bottom = Math.max(bottom, placeGrid(lane, 1, x, executionTop + Math.max(0, (sourceHeight - laneHeight) / 2), "execution"));
    }
    if (unlinked.length) {
      const columns = Math.max(1, Math.min(unlinked.length, Math.max(sourceColumns, lanes.size + 1)));
      bands.push({ group: "unlinked", x: pad.left, y: bottom + sectionGap, height: labelHeight });
      bottom = placeGrid(unlinked, columns, pad.left, bottom + sectionGap + labelHeight, "unlinked");
    }
    const bounds = { width: Math.max(1, right + pad.right), height: Math.max(1, bottom + pad.bottom) };
    const score = Math.min(availableWidth / bounds.width, availableHeight / bounds.height);
    const candidate = { kind: "dependency", positions, bounds, bands, relationPlan: plan, tier, scale,
      arrangement: { sourceColumns, contextColumns }, score, inputs: input };
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && bounds.width * bounds.height < best.bounds.width * best.bounds.height)) best = candidate;
  }
  return best;
}

/**
 * Route from a stable right port to a stable left port through empty gutters.
 * Every candidate is checked against the current visible rectangles, including
 * the endpoints except for their own first/last segment. Longer edges can use
 * the outer lane without crossing intermediate cards. Original direction stays
 * intact for backward edges and cycles as well.
 */
export function resolveOrthogonalGraphRoute(from, to, ports) {
  const slot = (index, count, span) => {
    if (count <= 1) return span / 2;
    const margin = Math.min(42, Math.max(24, span * 0.18));
    return margin + (span - margin * 2) * index / Math.max(1, count - 1);
  };
  const x1 = from.x + from.width;
  const y1 = from.y + slot(ports.sourceIndex || 0, ports.sourceCount || 1, from.height);
  const x2 = to.x;
  const y2 = to.y + slot(ports.targetIndex || 0, ports.targetCount || 1, to.height);
  const obstacles = [...(ports.obstacles?.values?.() || [])];
  const index = Math.max(0, ports.routeIndex || 0);
  const count = Math.max(1, ports.routeCount || 1);
  const offset = 10 + 14 * (index + 1) / (count + 1);
  const epsilon = 0.05;
  const intersects = (a, b, box) => {
    if (Math.abs(a[1] - b[1]) < epsilon) return a[1] > box.y + epsilon && a[1] < box.y + box.height - epsilon
      && Math.max(a[0], b[0]) > box.x + epsilon && Math.min(a[0], b[0]) < box.x + box.width - epsilon;
    return a[0] > box.x + epsilon && a[0] < box.x + box.width - epsilon
      && Math.max(a[1], b[1]) > box.y + epsilon && Math.min(a[1], b[1]) < box.y + box.height - epsilon;
  };
  const clear = (points) => points.slice(1).every((point, i) => obstacles.every((box) => !intersects(points[i], point, box)));
  const exitX = x1 + offset;
  const entryX = x2 - offset;
  const candidates = [];
  if (x2 > x1) {
    const middle = (x1 + x2) / 2 + (index - count / 2) * 1.5;
    candidates.push([[x1, y1], [middle, y1], [middle, y2], [x2, y2]]);
  }
  const laneYs = new Set([Math.min(from.y, to.y) - offset, Math.max(from.y + from.height, to.y + to.height) + offset]);
  for (const box of obstacles) {
    laneYs.add(box.y - offset);
    laneYs.add(box.y + box.height + offset);
  }
  for (const laneY of laneYs) candidates.push([[x1, y1], [exitX, y1], [exitX, laneY], [entryX, laneY], [entryX, y2], [x2, y2]]);
  const length = (points) => points.slice(1).reduce((sum, point, i) => sum + Math.abs(point[0] - points[i][0]) + Math.abs(point[1] - points[i][1]), 0);
  const valid = candidates.filter(clear).sort((a, b) => length(a) - length(b));
  let points = valid[0];
  if (!points) {
    // Visibility graph over gutters. This bounded fallback is needed when a
    // context row and a source grid leave no single clear horizontal lane.
    const xs = [...new Set([x1, x2, exitX, entryX, ...obstacles.flatMap((box) => [box.x - offset, box.x + box.width + offset])])].sort((a, b) => a - b);
    const ys = [...new Set([y1, y2, ...laneYs])].sort((a, b) => a - b);
    const start = xs.indexOf(x1) * ys.length + ys.indexOf(y1);
    const end = xs.indexOf(x2) * ys.length + ys.indexOf(y2);
    const distance = new Map([[start, 0]]);
    const previous = new Map();
    const open = new Set([start]);
    const settled = new Set();
    const at = (id) => [xs[Math.floor(id / ys.length)], ys[id % ys.length]];
    while (open.size) {
      let id;
      let bestScore = Infinity;
      for (const candidate of open) {
        const p = at(candidate);
        const score = distance.get(candidate) + Math.abs(p[0] - x2) + Math.abs(p[1] - y2);
        if (score < bestScore) { id = candidate; bestScore = score; }
      }
      open.delete(id);
      if (id === end) break;
      settled.add(id);
      const xi = Math.floor(id / ys.length);
      const yi = id % ys.length;
      const next = [[xi - 1, yi], [xi + 1, yi], [xi, yi - 1], [xi, yi + 1]];
      for (const [nx, ny] of next) {
        if (nx < 0 || nx >= xs.length || ny < 0 || ny >= ys.length) continue;
        const target = nx * ys.length + ny;
        if (settled.has(target)) continue;
        const a = at(id);
        const b = at(target);
        // Port direction is part of the contract, including a reverse edge.
        if (id === start && (b[0] <= x1 || b[1] !== y1)) continue;
        if (target === end && (a[0] >= x2 || a[1] !== y2)) continue;
        if (!clear([a, b])) continue;
        const cost = distance.get(id) + Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + 0.01;
        if (cost >= (distance.get(target) ?? Infinity)) continue;
        distance.set(target, cost);
        previous.set(target, id);
        open.add(target);
      }
    }
    if (distance.has(end)) {
      const reverse = [end];
      while (reverse.at(-1) !== start) reverse.push(previous.get(reverse.at(-1)));
      points = reverse.reverse().map(at);
    }
  }
  // A malformed overlapping input is still renderable; expose the refusal so
  // callers/tests can distinguish a safe route from a best-effort straight line.
  const obstructed = !points;
  if (!points) points = [[x1, y1], [exitX, y1], [exitX, y2], [x2, y2]];
  const path = points.slice(1).reduce((text, point, index) => text + (point[1] === points[index][1] ? " H " + point[0] : " V " + point[1]), "M " + x1 + " " + y1);
  return { x1, y1, x2, y2, points, path, obstructed };
}

/** One combination rule: relation focus can never override replay visibility. */
export function resolveGraphEdgePresentation(edge, { mode, executionKinds, selectedNodeId, focusActive, replayVisible = true }) {
  const execution = new Set(executionKinds).has(edge.kind || "sequence");
  const relationVisible = mode === "all" || execution;
  const adjacent = !focusActive || !selectedNodeId || edge.from === selectedNodeId || edge.to === selectedNodeId;
  return { execution, relationVisible, visible: relationVisible && replayVisible, focus: adjacent ? "near" : "far" };
}

/** Serialize definitions together; no browser implementation may drift from tests. */
export function serializeGraphReadabilityResolvers() {
  return [classifyGraphRelations, resolveDependencyGraphLayout, resolveOrthogonalGraphRoute, resolveGraphEdgePresentation]
    .map((resolver) => resolver.toString()).join("\n");
}
