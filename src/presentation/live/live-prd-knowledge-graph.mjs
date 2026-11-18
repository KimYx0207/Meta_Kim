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
  const headerControls = el("div", "uw-knowledge-controls");
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
    headerControls.append(controls);
  }
  const cameraTools = el("div", "uw-knowledge-camera");
  cameraTools.setAttribute("role", "group");
  cameraTools.setAttribute("aria-label", copy("prdGraphTitle"));
  const zoomOutBtn = el("button", "uw-knowledge-tool", "−");
  zoomOutBtn.type = "button";
  zoomOutBtn.dataset.uwKgZoom = "out";
  zoomOutBtn.title = "缩小画布";
  zoomOutBtn.setAttribute("aria-label", "缩小画布");
  const zoomResetBtn = el("button", "uw-knowledge-tool uw-knowledge-scale", "100%");
  zoomResetBtn.type = "button";
  zoomResetBtn.dataset.uwKgZoom = "reset";
  zoomResetBtn.title = "重置缩放与节点位置";
  zoomResetBtn.setAttribute("aria-label", "重置缩放与节点位置");
  const zoomInBtn = el("button", "uw-knowledge-tool", "+");
  zoomInBtn.type = "button";
  zoomInBtn.dataset.uwKgZoom = "in";
  zoomInBtn.title = "放大画布";
  zoomInBtn.setAttribute("aria-label", "放大画布");
  const maxBtn = el("button", "uw-knowledge-tool", "最大化");
  maxBtn.type = "button";
  maxBtn.dataset.uwKgMaximize = "true";
  maxBtn.setAttribute("aria-pressed", "false");
  maxBtn.title = "最大化或还原图谱画布";
  maxBtn.setAttribute("aria-label", "最大化或还原图谱画布");
  cameraTools.append(zoomOutBtn, zoomResetBtn, zoomInBtn, maxBtn);
  headerControls.append(cameraTools);
  header.append(headerControls);
  root.append(header);
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  root.dataset.livePrdKnowledgeNodeCount = String(nodes.length);
  if (!nodes.length) {
    root.append(el("p", "uw-knowledge-empty", copy("noGraphNodes")));
    return root;
  }

  const cardWidth = 200, cardHeight = 72, verticalGap = 24;
  const byId = new Map(nodes.map(node => [node.id, node]));
  const positions = new Map();
  let width, height;
  const architecture = nodes.find(node => node.kind === "architecture");
  if (!focusId) {
    const modules = nodes.filter(node => node.kind !== "architecture");
    const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(modules.length))));
    const xGap = 40;
    // Avoid reserving 620px for a two-column graph on a narrow reading surface.
    // The CSS camera fits small maps while keeping large maps horizontally scrollable.
    width = Math.max(cardWidth + 48, columns * (cardWidth + xGap) + xGap);
    if (architecture) positions.set(architecture.id, { x: (width - cardWidth) / 2, y: 22 });
    const firstRow = architecture ? 138 : 22;
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
    // A two-node dependency should be a compact relationship strip, not a
    // 300px tall empty diagram. Both dimensions follow the visible nodes.
    width = Math.max(320, columns.length * (cardWidth + 54) + 24);
    height = Math.max(132, Math.max(...groups.map(group => group.length)) * (cardHeight + 18) + 32);
    groups.forEach((group, column) => group.forEach((node, index) => positions.set(node.id, {
      x: 18 + column * (cardWidth + 54), y: (height - group.length * (cardHeight + 18) + 18) / 2 + index * (cardHeight + 18),
    })));
  }
  const canvas = el("div", "uw-knowledge-canvas");
  canvas.setAttribute("role", "region");
  canvas.setAttribute("aria-label", copy("prdGraphTitle"));
  canvas.tabIndex = 0;
  const focusNode = focusId ? nodes.find(node => node.sourceId === focusId || node.id === focusId || node.id === `module:${focusId}`) : architecture;
  const focusPoint = positions.get(focusNode?.id);
  if (focusPoint) canvas.dataset.focusCenterX = String(focusPoint.x + cardWidth / 2);
  // Narrow screens pan the map instead of shrinking 11px labels to illegibility.
  // The companion module index deliberately narrows the map on desktop;
  // let compact diagrams fit that column fully instead of clipping node cards.
  const readableFloor = width > 760 ? 760 : Math.min(width, focusId ? 480 : 360);
  const initialPositions = new Map([...positions.entries()].map(([k, v]) => [k, { x: v.x, y: v.y }]));
  let panX = 0, panY = 0, zoomScale = 1;
  const baseStyle = `--uw-graph-content-width:${width}px;--uw-graph-readable-width:${readableFloor}px`;
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width, height,
    style: baseStyle,
    role: "group", "aria-label": copy("prdGraphTitle") });
  const syncSvgCamera = () => {
    const hasTransform = panX !== 0 || panY !== 0 || zoomScale !== 1;
    svg.setAttribute("style", hasTransform
      ? `${baseStyle};transform:translate(${Math.round(panX)}px,${Math.round(panY)}px) scale(${zoomScale.toFixed(3)});transform-origin:center top`
      : baseStyle);
    zoomResetBtn.textContent = `${Math.round(zoomScale * 100)}%`;
  };
  const computeEdgePath = (edge) => {
    const start = positions.get(edge.from), end = positions.get(edge.to);
    if (!start || !end) return "";
    const containment = edge.type === "containment";
    const isHorizontal = !containment && Math.abs(end.x - start.x) >= cardWidth + 6;
    const direction = end.x >= start.x ? 1 : -1;
    const descending = end.y >= start.y;
    const sx = containment ? start.x + cardWidth / 2 : isHorizontal ? start.x + (direction > 0 ? cardWidth : 0) : start.x + cardWidth / 2;
    const sy = containment ? start.y + cardHeight : isHorizontal ? start.y + cardHeight / 2 : start.y + (descending ? cardHeight : 0);
    const tx = containment ? end.x + cardWidth / 2 : isHorizontal ? end.x + (direction > 0 ? 0 : cardWidth) : end.x + cardWidth / 2;
    const ty = containment ? end.y : isHorizontal ? end.y + cardHeight / 2 : end.y + (descending ? 0 : cardHeight);
    return containment ? `M${sx} ${sy} C${sx} ${sy + 34},${tx} ${ty - 34},${tx} ${ty}`
      : isHorizontal ? `M${sx} ${sy} C${sx + direction * 42} ${sy},${tx - direction * 42} ${ty},${tx} ${ty}`
      : `M${sx} ${sy} C${sx} ${sy + (descending ? 35 : -35)},${tx} ${ty + (descending ? -35 : 35)},${tx} ${ty}`;
  };
  const defs = svgEl("defs");
  const arrow = svgEl("marker", { id: "uw-prd-edge-arrow", markerWidth: 9, markerHeight: 9, refX: 7, refY: 3.5, orient: "auto", markerUnits: "userSpaceOnUse" });
  arrow.append(svgEl("path", { d: "M0 0L7 3.5L0 7", class: "uw-kg-arrow-head" }));
  defs.append(arrow); svg.append(defs);
  const activeNodeIds = new Set(nodes.filter(node => ["running", "active", "in_progress"].includes(workspaceStatusKey(node.status))).map(node => node.id));
  const edgeRecords = [];
  for (const edge of edges) {
    const d = computeEdgePath(edge);
    if (!d) continue;
    const containment = edge.type === "containment";
    const path = svgEl("path", { d, class: `uw-kg-edge ${containment ? "contains" : "required"}` });
    if (!containment) path.setAttribute("marker-end", "url(#uw-prd-edge-arrow)");
    if (!containment && activeNodeIds.has(edge.to)) path.setAttribute("data-activity", "observed-running");
    path.append(svgEl("title"));
    path.lastChild.textContent = containment ? copy("includesModule") : copy("requiredDependency");
    svg.append(path);
    edgeRecords.push({ edge, path });
  }
  const nodeGroups = new Map();
  let activeNodeDrag = null;
  let suppressNextNodeClick = false;
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
    group.addEventListener("pointerdown", event => {
      if (!event || (typeof event.button === "number" && event.button !== 0)) return;
      event.stopPropagation?.();
      const cur = positions.get(node.id) || { x: 0, y: 0 };
      activeNodeDrag = { nodeId: node.id, group, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origX: cur.x, origY: cur.y, moved: false };
      group.setPointerCapture?.(event.pointerId);
    });
    group.addEventListener("pointermove", event => {
      if (!activeNodeDrag || activeNodeDrag.nodeId !== node.id || event.pointerId !== activeNodeDrag.pointerId) return;
      const dx = (event.clientX - activeNodeDrag.startX) / (zoomScale || 1);
      const dy = (event.clientY - activeNodeDrag.startY) / (zoomScale || 1);
      if (!activeNodeDrag.moved && Math.hypot(event.clientX - activeNodeDrag.startX, event.clientY - activeNodeDrag.startY) > 4) {
        activeNodeDrag.moved = true;
        group.dataset.dragging = "true";
      }
      if (!activeNodeDrag.moved) return;
      const nx = Math.round(activeNodeDrag.origX + dx);
      const ny = Math.round(activeNodeDrag.origY + dy);
      positions.set(node.id, { x: nx, y: ny });
      group.setAttribute("transform", `translate(${nx},${ny})`);
      for (const rec of edgeRecords) {
        if (rec.edge.from === node.id || rec.edge.to === node.id) rec.path.setAttribute("d", computeEdgePath(rec.edge));
      }
    });
    const finishNodeDrag = event => {
      if (!activeNodeDrag || activeNodeDrag.nodeId !== node.id) return;
      if (activeNodeDrag.moved) suppressNextNodeClick = true;
      delete group.dataset.dragging;
      group.releasePointerCapture?.(event?.pointerId);
      activeNodeDrag = null;
    };
    group.addEventListener("pointerup", finishNodeDrag);
    group.addEventListener("pointercancel", finishNodeDrag);
    group.addEventListener("click", event => {
      if (suppressNextNodeClick) { suppressNextNodeClick = false; event?.preventDefault?.(); event?.stopPropagation?.(); return; }
      onSelect(node);
    });
    group.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(node); } });
    svg.append(group);
    nodeGroups.set(node.id, group);
  }
  let canvasPan = null;
  canvas.addEventListener("pointerdown", event => {
    if (!event || (typeof event.button === "number" && event.button !== 0) || activeNodeDrag) return;
    if (event.target?.closest?.(".uw-kg-node, button")) return;
    canvasPan = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, baseX: panX, baseY: panY };
    canvas.dataset.panning = "true";
    canvas.setPointerCapture?.(event.pointerId);
  });
  canvas.addEventListener("pointermove", event => {
    if (!canvasPan || event.pointerId !== canvasPan.pointerId) return;
    panX = canvasPan.baseX + (event.clientX - canvasPan.startX);
    panY = canvasPan.baseY + (event.clientY - canvasPan.startY);
    syncSvgCamera();
  });
  const endCanvasPan = event => {
    if (!canvasPan) return;
    delete canvas.dataset.panning;
    canvas.releasePointerCapture?.(event?.pointerId);
    canvasPan = null;
  };
  canvas.addEventListener("pointerup", endCanvasPan);
  canvas.addEventListener("pointercancel", endCanvasPan);
  canvas.addEventListener("wheel", event => {
    if (!event) return;
    if (event.ctrlKey || event.metaKey || root.dataset.maximized === "true" || zoomScale !== 1) {
      event.preventDefault?.();
      const factor = event.deltaY < 0 ? 1.12 : 0.89;
      zoomScale = Math.min(2.6, Math.max(0.45, zoomScale * factor));
      syncSvgCamera();
    }
  }, { passive: false });
  zoomInBtn.addEventListener("click", () => { zoomScale = Math.min(2.6, zoomScale * 1.18); syncSvgCamera(); });
  zoomOutBtn.addEventListener("click", () => { zoomScale = Math.max(0.45, zoomScale / 1.18); syncSvgCamera(); });
  zoomResetBtn.addEventListener("click", () => {
    panX = 0; panY = 0; zoomScale = 1;
    for (const [id, orig] of initialPositions.entries()) {
      positions.set(id, { x: orig.x, y: orig.y });
      nodeGroups.get(id)?.setAttribute("transform", `translate(${orig.x},${orig.y})`);
    }
    for (const rec of edgeRecords) rec.path.setAttribute("d", computeEdgePath(rec.edge));
    syncSvgCamera();
  });
  maxBtn.addEventListener("click", () => {
    const next = root.dataset.maximized !== "true";
    root.dataset.maximized = String(next);
    maxBtn.setAttribute("aria-pressed", String(next));
    maxBtn.textContent = next ? "还原" : "最大化";
  });
  canvas.append(svg);
  const legend = el("div", "uw-knowledge-legend");
  legend.append(el("span", "contains", copy("includesModule")), el("span", "required", copy("requiredDependency")));
  const map = el("div", "uw-knowledge-map");
  map.append(canvas, legend);
  const index = el("aside", "uw-knowledge-index");
  index.setAttribute("aria-label", copy(focusId ? "moduleRelations" : "prdModules"));
  const indexHeading = el("div", "uw-knowledge-index-heading");
  const indexLabel = el("span", "uw-knowledge-index-kicker", copy(focusId ? "moduleRelations" : "prdModules"));
  const moduleNodes = nodes.filter(node => node.kind !== "architecture");
  indexHeading.append(indexLabel, el("strong", "uw-knowledge-index-count", String(moduleNodes.length).padStart(2, "0")));
  index.append(indexHeading);
  const list = el("div", "uw-knowledge-index-list");
  for (const [indexNumber, node] of moduleNodes.entries()) {
    const row = el("button", "uw-knowledge-index-row");
    row.type = "button";
    row.dataset.livePrdGraphIndexNode = String(node.sourceId || node.id);
    row.dataset.state = workspaceStatusKey(node.status);
    row.dataset.selected = String(Boolean(focusId && (node.sourceId === focusId || node.id === focusId || node.id === `module:${focusId}`)));
    const number = el("span", "uw-knowledge-index-number", String(indexNumber + 1).padStart(2, "0"));
    const detail = el("span", "uw-knowledge-index-copy");
    detail.append(el("strong", "", node.title || node.sourceId || node.id));
    if (node.summary) detail.append(el("small", "", node.summary));
    const prerequisites = edges
      .filter(edge => edge.type !== "containment" && edge.to === node.id)
      .map(edge => byId.get(edge.from)?.title)
      .filter(Boolean);
    if (prerequisites.length) detail.append(el("small", "uw-knowledge-index-links",
      `${copy("requiredDependency")}：${prerequisites.join(" · ")}`));
    const status = el("span", "uw-knowledge-index-state", copy(workspaceStatusKey(node.status)));
    row.append(number, detail, status);
    row.addEventListener("click", () => onSelect(node));
    list.append(row);
  }
  index.append(list);
  const surface = el("div", "uw-knowledge-surface");
  surface.append(map, index);
  root.append(surface);
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
    map.append(counts);
  }
  const unknownEdges = (graph?.omissions || []).filter(row => ["unknown_dependency", "unloaded_dependency"].includes(row.type)).length;
  if (unknownEdges) map.append(el("p", "uw-knowledge-warning", copy("graphUnknownEdges").replace("{count}", String(unknownEdges))));
  const note = el("p", "uw-knowledge-note", copy(unloaded ? "graphPartial" : "graphHint"));
  map.append(note);
  return root;
}
