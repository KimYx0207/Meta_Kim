/** A human-facing diagram of the CURRENT PRD, not a second knowledge store.
 * Nodes retain the design's stable IDs; Graphify's code graph remains separate.
 * No third-party graph code, styles or data are embedded here. */
import { workspaceStatusKey } from "./live-workspace-model.mjs";
export function createPrdKnowledgeGraph({ doc, graph, copy, focusId = null, depth = 2, onSelect, onDepthChange, onExpand }) {
  const ns = "http://www.w3.org/2000/svg";
  const el = (tag, className = "", value = "") => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined && value !== null) node.textContent = String(value);
    return node;
  };
  const svgEl = (tag, attrs = {}) => {
    const node = doc.createElementNS(ns, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    return node;
  };
  const root = el("section", "uw-knowledge-graph");
  root.dataset.livePrdKnowledgeGraph = focusId ? "module" : "architecture";
  root.dataset.livePrdKnowledgeFocus = focusId || "architecture";
  root.dataset.livePrdKnowledgeDepth = String(depth);
  const header = el("header", "uw-knowledge-head");
  const heading = el("div", "uw-knowledge-heading");
  heading.append(el("span", "uw-knowledge-kicker", copy(focusId ? "prdSecondLayer" : "prdFirstLayer")),
    el("h3", "", copy(focusId ? "moduleRelations" : "systemRelations")));
  header.append(heading);
  if (focusId) {
    const controls = el("div", "uw-knowledge-depth");
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", copy("relationDepth"));
    for (const level of [1, 2, 3, "all"]) {
      const choice = el("button", "", level === "all" ? copy("allRelations") : String(level));
      choice.type = "button";
      choice.dataset.livePrdGraphDepth = String(level);
      choice.setAttribute("aria-pressed", String(level === depth));
      choice.setAttribute("aria-label", (level === "all" ? copy("allRelations") : `${level} ${copy("relationDepth")}`));
      choice.addEventListener("click", () => onDepthChange(level));
      controls.append(choice);
    }
    header.append(controls);
  }
  root.append(header);
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  if (!nodes.length) {
    root.append(el("p", "uw-knowledge-empty", copy("noGraphNodes")));
    return root;
  }

  const cardWidth = 200, cardHeight = 72, verticalGap = 32;
  const byId = new Map(nodes.map(node => [node.id, node]));
  const positions = new Map();
  let width, height;
  const architecture = nodes.find(node => node.kind === "architecture");
  if (!focusId) {
    const modules = nodes.filter(node => node.kind !== "architecture");
    const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(modules.length))));
    const xGap = 40;
    width = Math.max(620, columns * (cardWidth + xGap) + xGap);
    if (architecture) positions.set(architecture.id, { x: (width - cardWidth) / 2, y: 22 });
    const firstRow = architecture ? 170 : 22;
    for (const [index, node] of modules.entries()) positions.set(node.id, {
      x: (width - columns * (cardWidth + xGap) + xGap) / 2 + index % columns * (cardWidth + xGap),
      y: firstRow + Math.floor(index / columns) * (cardHeight + verticalGap),
    });
    height = firstRow + Math.ceil(modules.length / columns) * (cardHeight + verticalGap) + 18;
  } else {
    const selected = nodes.find(node => node.sourceId === focusId || node.id === focusId || node.id === `module:${focusId}`);
    const source = selected?.id;
    const upstream = new Map(), downstream = new Map();
    for (const edge of edges.filter(edge => edge.type !== "containment")) {
      if (!upstream.has(edge.to)) upstream.set(edge.to, []);
      upstream.get(edge.to).push(edge.from);
      if (!downstream.has(edge.from)) downstream.set(edge.from, []);
      downstream.get(edge.from).push(edge.to);
    }
    const levels = new Map(source ? [[source, 0]] : []);
    const visit = (adjacency, sign, maxDistance) => {
      if (!source) return;
      const visited = new Set([source]);
      let frontier = [source];
      for (let distance = 1; frontier.length && distance <= maxDistance; distance += 1) {
        const next = [];
        for (const id of frontier) for (const neighbor of adjacency.get(id) || []) {
          if (!byId.has(neighbor) || visited.has(neighbor)) continue;
          visited.add(neighbor); levels.set(neighbor, distance * sign); next.push(neighbor);
        }
        frontier = next;
      }
    };
    visit(upstream, -1, depth === "all" ? nodes.length : Number(depth) || 2);
    visit(downstream, 1, 1);
    for (const node of nodes) if (!levels.has(node.id)) levels.set(node.id, node.kind === "architecture" ? -1 : 1);
    const columns = [...new Set(levels.values())].sort((a, b) => a - b);
    const groups = columns.map(level => nodes.filter(node => levels.get(node.id) === level));
    width = Math.max(620, columns.length * (cardWidth + 76) + 44);
    height = Math.max(300, Math.max(...groups.map(group => group.length)) * (cardHeight + verticalGap) + 68);
    groups.forEach((group, column) => group.forEach((node, index) => positions.set(node.id, {
      x: 28 + column * (cardWidth + 76), y: (height - group.length * (cardHeight + verticalGap) + verticalGap) / 2 + index * (cardHeight + verticalGap),
    })));
  }
  const canvas = el("div", "uw-knowledge-canvas");
  canvas.setAttribute("role", "region");
  canvas.setAttribute("aria-label", copy("prdGraphTitle"));
  canvas.tabIndex = 0;
  const focusNode = focusId ? nodes.find(node => node.sourceId === focusId || node.id === focusId || node.id === `module:${focusId}`) : architecture;
  const focusPoint = positions.get(focusNode?.id);
  if (focusPoint) canvas.dataset.focusCenterX = String(focusPoint.x + cardWidth / 2);
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width, height, role: "group", "aria-label": copy("prdGraphTitle") });
  const defs = svgEl("defs");
  const arrow = svgEl("marker", { id: "uw-prd-edge-arrow", markerWidth: 9, markerHeight: 9, refX: 7, refY: 3.5, orient: "auto", markerUnits: "userSpaceOnUse" });
  arrow.append(svgEl("path", { d: "M0 0L7 3.5L0 7", fill: "none", stroke: "#d5b67f", "stroke-width": 1.5 }));
  defs.append(arrow); svg.append(defs);
  for (const edge of edges) {
    const start = positions.get(edge.from), end = positions.get(edge.to);
    if (!start || !end) continue;
    const containment = edge.type === "containment";
    const isHorizontal = !containment && Math.abs(end.x - start.x) >= cardWidth + 6;
    const direction = end.x >= start.x ? 1 : -1;
    const descending = end.y >= start.y;
    const sx = containment ? start.x + cardWidth / 2 : isHorizontal ? start.x + (direction > 0 ? cardWidth : 0) : start.x + cardWidth / 2;
    const sy = containment ? start.y + cardHeight : isHorizontal ? start.y + cardHeight / 2 : start.y + (descending ? cardHeight : 0);
    const tx = containment ? end.x + cardWidth / 2 : isHorizontal ? end.x + (direction > 0 ? 0 : cardWidth) : end.x + cardWidth / 2;
    const ty = containment ? end.y : isHorizontal ? end.y + cardHeight / 2 : end.y + (descending ? 0 : cardHeight);
    const d = containment ? `M${sx} ${sy} C${sx} ${sy + 34},${tx} ${ty - 34},${tx} ${ty}`
      : isHorizontal ? `M${sx} ${sy} C${sx + direction * 42} ${sy},${tx - direction * 42} ${ty},${tx} ${ty}`
      : `M${sx} ${sy} C${sx} ${sy + (descending ? 35 : -35)},${tx} ${ty + (descending ? -35 : 35)},${tx} ${ty}`;
    const path = svgEl("path", { d, class: `uw-kg-edge ${containment ? "contains" : "required"}` });
    if (!containment) path.setAttribute("marker-end", "url(#uw-prd-edge-arrow)");
    path.append(svgEl("title"));
    path.lastChild.textContent = containment ? copy("includesModule") : copy("requiredDependency");
    svg.append(path);
  }
  for (const node of nodes) {
    const point = positions.get(node.id);
    if (!point) continue;
    const selected = Boolean(focusId && (node.sourceId === focusId || node.id === focusId || node.id === `module:${focusId}`));
    const displayStatus = workspaceStatusKey(node.status);
    const group = svgEl("g", { class: "uw-kg-node", transform: `translate(${point.x},${point.y})`, tabindex: 0, role: "button",
      "aria-pressed": selected, "aria-label": [node.title || node.sourceId || node.id, copy(displayStatus)].join(" · ") });
    group.dataset.livePrdGraphNode = String(node.sourceId || node.id);
    group.dataset.kind = node.kind;
    group.dataset.selected = String(selected);
    group.dataset.state = /^[a-z_]+$/iu.test(displayStatus) ? displayStatus : "unknown";
    group.append(svgEl("rect", { x: 0, y: 0, width: cardWidth, height: cardHeight, rx: 11 }));
    const kind = svgEl("text", { x: 14, y: 21, class: "uw-kg-node-kind" });
    kind.textContent = copy(node.kind === "architecture" ? "prdFirstLayer" : "prdSecondLayer");
    const status = svgEl("text", { x: cardWidth - 14, y: 21, "text-anchor": "end", class: "uw-kg-node-state" });
    status.textContent = copy(displayStatus);
    const title = svgEl("text", { x: 14, y: 48, class: "uw-kg-node-title" });
    const fullTitle = String(node.title || node.sourceId || node.id);
    title.textContent = Array.from(fullTitle).length > 14 ? Array.from(fullTitle).slice(0, 13).join("") + "…" : fullTitle;
    const tooltip = svgEl("title");
    tooltip.textContent = [fullTitle, node.summary || "", copy(displayStatus)].filter(Boolean).join(" · ");
    group.append(kind, status, title, tooltip);
    group.addEventListener("click", () => onSelect(node));
    group.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(node); } });
    svg.append(group);
  }
  canvas.append(svg);
  const legend = el("div", "uw-knowledge-legend");
  legend.append(el("span", "contains", copy("includesModule")), el("span", "required", copy("requiredDependency")));
  root.append(canvas, legend);
  const clipped = Math.max(0, (graph?.totalNodes || 0) - nodes.length);
  const unloaded = Math.max(0, (graph?.totalModules || 0) - (graph?.loadedModules || 0));
  if (clipped || unloaded) {
    const counts = el("div", "uw-knowledge-boundaries");
    if (clipped) {
      counts.append(el("span", "", copy("graphHiddenCount").replace("{count}", String(clipped))));
      if (typeof onExpand === "function") {
        const more = el("button", "uw-knowledge-more", copy("graphExpand"));
        more.type = "button";
        more.addEventListener("click", onExpand);
        counts.append(more);
      }
    }
    if (unloaded) counts.append(el("span", "", copy("graphUnloadedCount").replace("{count}", String(unloaded))));
    root.append(counts);
  }
  const unknownEdges = (graph?.omissions || []).filter(row => ["unknown_dependency", "unloaded_dependency"].includes(row.type)).length;
  if (unknownEdges) root.append(el("p", "uw-knowledge-warning", copy("graphUnknownEdges").replace("{count}", String(unknownEdges))));
  const note = el("p", "uw-knowledge-note", copy(unloaded ? "graphPartial" : "graphHint"));
  root.append(note);
  return root;
}
