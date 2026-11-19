/**
 * Self-contained LangGraph-style Infinite Dynamic Workflow PRD Canvas.
 *
 * Serialized into the browser client via `createDynamicPrdWorkflowCanvas.toString()`,
 * so all helpers MUST live inside the exported function with zero external imports
 * and build DOM/SVG nodes strictly via `doc.createElement` / `doc.createElementNS`.
 */
export function createDynamicPrdWorkflowCanvas({
  doc,
  workflow,
  blueprint,
  selectedNodeId = null,
  busy = false,
  errorMessage = "",
  onSelectNode,
  onMutateWorkflow,
} = {}) {
  const ns = "http://www.w3.org/2000/svg";
  const el = (tag, className = "", text = "") => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null && text !== "") node.textContent = String(text);
    return node;
  };
  const svgEl = (tag, attrs = {}) => {
    const node = doc.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined && v !== null) node.setAttribute(k, String(v));
    }
    return node;
  };
  const trunc = (val, max = 14) => {
    const chars = Array.from(String(val || "").trim());
    return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
  };
  // Node titles and edge labels are measured, never cut: a wide CJK glyph is
  // about one em and a Latin glyph about 0.6 em at the same font size.
  const CJK_RANGE = "⺀-鿿豈-﫿＀-￯　-〿";
  const textUnits = (text) => Array.from(String(text || "")).reduce((sum, ch) => sum + (new RegExp(`[${CJK_RANGE}]`, "u").test(ch) ? 1 : 0.6), 0);
  const wrapTitle = (val, maxUnits) => {
    const tokens = String(val || "").trim().match(new RegExp(`[${CJK_RANGE}]|[^\\s${CJK_RANGE}]+|\\s+`, "gu")) || [];
    const lines = [];
    let line = "";
    for (const token of tokens) {
      if (/^\s+$/u.test(token)) { if (line) line += " "; continue; }
      if (line.trim() && textUnits(line + token) > maxUnits) { lines.push(line.trim()); line = ""; }
      line += token;
    }
    if (line.trim()) lines.push(line.trim());
    return lines.length ? lines : [""];
  };
  const TITLE_LAYOUT = { terminal: { w: 128, fontSize: 12, lineHeight: 15, baseHeight: 44 },
    condition: { w: 168, fontSize: 11.5, lineHeight: 16, baseHeight: 92 },
    process: { w: 196, fontSize: 13, lineHeight: 16, baseHeight: 94 } };
  const layoutKind = (node) => (node.kind === "terminal" ? "terminal" : node.kind === "condition" ? "condition" : "process");
  const titleLines = (node) => {
    const spec = TITLE_LAYOUT[layoutKind(node)];
    const usable = layoutKind(node) === "condition" ? spec.w * 0.56 : spec.w - 22;
    return wrapTitle(node.title, usable / spec.fontSize);
  };
  const EDGE_LABEL_FONT = 10.5;
  const PORT_CLEARANCE = 16;
  const edgeLabelWidth = (label) => textUnits(label) * EDGE_LABEL_FONT;

  // Normalize fallback workflow when only `blueprint` is passed (e.g. in unit tests or B2 drafts)
  const buildFallbackWorkflow = () => {
    const rawMods = Array.isArray(blueprint?.raw?.modules) && blueprint.raw.modules.length
      ? blueprint.raw.modules
      : (Array.isArray(blueprint?.design?.modules) ? blueprint.design.modules : []);
    const byId = new Map(rawMods.map((m) => [m.id, m]));
    const depthMemo = new Map();
    const visiting = new Set();
    const getCol = (id) => {
      if (depthMemo.has(id)) return depthMemo.get(id);
      if (visiting.has(id)) return 0;
      visiting.add(id);
      const m = byId.get(id);
      let c = Number.isInteger(m?.flowColumn) ? m.flowColumn : 0;
      if (!Number.isInteger(m?.flowColumn)) {
        for (const dep of (m?.dependencies || m?.dependsOn || [])) {
          if (byId.has(dep)) c = Math.max(c, getCol(dep) + 1);
        }
      }
      visiting.delete(id);
      depthMemo.set(id, c);
      return c;
    };
    rawMods.forEach((m) => getCol(m.id));
    const cols = [...new Set([...depthMemo.values()])].sort((a, b) => a - b);
    const colIdxMap = new Map(cols.map((c, idx) => [c, idx]));
    const grouped = new Map();
    for (const m of rawMods) {
      const ci = colIdxMap.get(depthMemo.get(m.id)) ?? 0;
      if (!grouped.has(ci)) grouped.set(ci, []);
      grouped.get(ci).push(m);
    }

    const nodes = [{ id: "start", kind: "terminal", code: "START", title: "开始 · 用户入口", status: "completed", column: -1, hasUiPage: false }];
    const sortedCols = [...grouped.keys()].sort((a, b) => a - b);
    for (const ci of sortedCols) {
      const list = grouped.get(ci);
      const isPar = list.length >= 2;
      list.forEach((m, li) => {
        const hasPage = typeof m.hasUiPage === "boolean"
          ? m.hasUiPage
          : /(?:界面|工作台|画布|页面|目录|窗口|前端|ui|web|page|studio|desktop)/iu.test(`${m.id} ${m.title || ""}`);
        const st = m.approval?.state === "approved" ? "completed" : (m.status || "planned");
        nodes.push({
          id: m.id,
          kind: m.nodeKind === "condition" ? "condition" : (isPar ? "parallel" : "process"),
          code: m.nodeKind === "condition" ? "条件路由" : (isPar ? `0${ci + 1}${String.fromCharCode(65 + li)} · 并行` : `0${ci + 1}`),
          title: m.title || m.id,
          objective: m.objective || m.summary || "",
          features: m.features || [],
          status: st,
          column: ci,
          hasUiPage: hasPage,
          uiMockup: hasPage
            ? (m.uiMockup || {
                status: st === "completed" || st === "accepted" ? "confirmed" : "pending",
                version: 1,
                mode: "wireframe_fallback",
                variant: "workbench",
                wireframeSpec: {
                  layoutType: "workbench",
                  version: 1,
                  headerTitle: `${m.title || m.id} · 页面预览 v1`,
                  badgeText: "标准响应式布局",
                  dualColumn: false,
                  summaryLine: m.objective || m.summary || `${m.title || m.id}核心界面`,
                  featurePills: (m.features || ["核心操作面板", "实时状态反馈", "提交与下一步"]).slice(0, 3),
                  primaryCta: "确认并流转",
                },
              })
            : null,
          subflow: m.subflow || null,
        });
      });
    }
    nodes.push({ id: "end", kind: "terminal", code: "END", title: "闭环交付", status: "planned", column: (sortedCols.at(-1) ?? 0) + 1, hasUiPage: false });
    const edges = [];
    let es = 1;
    if (sortedCols.length) {
      for (const m of grouped.get(sortedCols[0])) edges.push({ id: `fb_e${es++}`, from: "start", to: m.id, label: "", kind: "normal" });
      for (let i = 0; i < sortedCols.length - 1; i += 1) {
        const g1 = grouped.get(sortedCols[i]);
        const g2 = grouped.get(sortedCols[i + 1]);
        for (const u of g1) {
          for (const d of g2) {
            if (g1.length > 1 && g2.length > 1 && g1.indexOf(u) !== 0 && !(d.dependencies || d.dependsOn || []).includes(u.id)) continue;
            edges.push({ id: `fb_e${es++}`, from: u.id, to: d.id, label: g2.length > 1 ? "并行" : "", kind: g2.length > 1 ? "parallel" : "normal" });
          }
        }
      }
      for (const m of grouped.get(sortedCols.at(-1))) edges.push({ id: `fb_e${es++}`, from: m.id, to: "end", label: "", kind: "normal" });
    }
    return {
      systemTitle: blueprint?.design?.architecture?.title || blueprint?.raw?.system?.title || "系统总流程图",
      nodes,
      edges,
      lastMutationNote: null,
    };
  };

  const wfData = workflow && Array.isArray(workflow.nodes) && workflow.nodes.length ? workflow : buildFallbackWorkflow();

  const root = el("section", "uw-wf-shell");
  root.dataset.livePrdWorkflowCanvas = "true";
  root.dataset.livePrdKnowledgeGraph = selectedNodeId ? "module" : "architecture";

  let activeSubflowNodeId = null;
  const businessNodes = wfData.nodes.filter((n) => n.kind !== "terminal");
  let currentSelectedId = selectedNodeId && wfData.nodes.some((n) => n.id === selectedNodeId)
    ? selectedNodeId
    : (wfData.selectedNodeId && wfData.nodes.some((n) => n.id === wfData.selectedNodeId)
      ? wfData.selectedNodeId
      : (businessNodes.find((n) => n.hasUiPage && n.uiMockup?.status !== "confirmed")?.id
        || businessNodes.find((n) => n.hasUiPage)?.id
        || businessNodes[0]?.id
        || "start"));
  let inspectorTab = "mockup";
  let panX = 0;
  let panY = 0;
  let scale = 1;
  const nodePositions = new Map();

  // Header Bar
  const head = el("header", "uw-wf-head");
  const crumbWrap = el("div", "uw-wf-crumbs");
  // The project name already heads the window; the crumb only names the level.
  const rootCrumbBtn = el("button", "uw-wf-crumb-root", "一级 · 系统框架");
  rootCrumbBtn.type = "button";
  rootCrumbBtn.setAttribute("title", wfData.systemTitle || "系统总流程图");
  rootCrumbBtn.dataset.uwWfRootCrumb = "true";
  const subCrumbSep = el("span", "uw-wf-crumb-sep", "/");
  subCrumbSep.hidden = true;
  const subCrumbBadge = el("span", "uw-wf-crumb-sub", "");
  subCrumbBadge.hidden = true;
  const gateSummaryBadge = el("span", "uw-wf-gate-pill", "");
  gateSummaryBadge.dataset.uwWfMockupSummary = "true";
  crumbWrap.append(rootCrumbBtn, subCrumbSep, subCrumbBadge, gateSummaryBadge);

  const camWrap = el("div", "uw-wf-cam-tools");
  const zOutBtn = el("button", "uw-knowledge-tool", "−");
  zOutBtn.type = "button"; zOutBtn.dataset.uwWfZoom = "out"; zOutBtn.title = "缩小画布";
  const zScaleBtn = el("button", "uw-knowledge-tool uw-knowledge-scale", "100%");
  zScaleBtn.type = "button"; zScaleBtn.dataset.uwWfZoom = "reset"; zScaleBtn.title = "重置缩放";
  const zInBtn = el("button", "uw-knowledge-tool", "+");
  zInBtn.type = "button"; zInBtn.dataset.uwWfZoom = "in"; zInBtn.title = "放大画布";
  const fitBtn = el("button", "uw-knowledge-tool", "自适应");
  fitBtn.type = "button"; fitBtn.dataset.uwWfFit = "true";
  const maxBtn = el("button", "uw-knowledge-tool", "最大化");
  maxBtn.type = "button"; maxBtn.dataset.uwKgMaximize = "true"; maxBtn.setAttribute("aria-pressed", "false");
  camWrap.append(zOutBtn, zScaleBtn, zInBtn, fitBtn, maxBtn);
  head.append(crumbWrap, camWrap);
  root.append(head);

  // Main Split Surface: Left Infinite Canvas + Right Page Mockup & Mutation Drawer
  const surface = el("div", "uw-wf-surface");
  const canvasWrap = el("div", "uw-wf-canvas-wrap");
  canvasWrap.dataset.uwWfViewport = "true";
  const svg = svgEl("svg", { class: "uw-wf-svg", viewBox: "0 0 980 420", role: "group", "aria-label": "动态工作流系统流程图" });
  const defs = svgEl("defs");
  for (const [id, color] of [
    ["uw-wf-arr-norm", "#64748b"],
    ["uw-wf-arr-act", "#38bdf8"],
    ["uw-wf-arr-done", "#34d399"],
    ["uw-wf-arr-warn", "#fbbf24"],
  ]) {
    const marker = svgEl("marker", { id, viewBox: "0 0 10 10", refX: "8.2", refY: "5", markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse" });
    marker.append(svgEl("path", { d: "M 0 1.5 L 9 5 L 0 8.5 z", fill: color }));
    defs.append(marker);
  }
  svg.append(defs);
  const viewportG = svgEl("g", { class: "uw-wf-viewport-g" });
  const lanesLayer = svgEl("g", { class: "uw-wf-lanes" });
  const edgesLayer = svgEl("g", { class: "uw-wf-edges" });
  const nodesLayer = svgEl("g", { class: "uw-wf-nodes" });
  viewportG.append(lanesLayer, edgesLayer, nodesLayer);
  svg.append(viewportG);
  canvasWrap.append(svg);

  // Live Reaction Toast inside Canvas
  const toastEl = el("div", "uw-wf-toast");
  toastEl.dataset.uwWfToast = "true";
  if (wfData.lastMutationNote) {
    toastEl.textContent = `⚡ ${wfData.lastMutationNote}`;
  } else {
    toastEl.hidden = true;
  }
  canvasWrap.append(toastEl);

  // Bottom-Left Minimap
  const minimapWrap = el("div", "uw-wf-minimap");
  const minimapSvg = svgEl("svg", { width: "108", height: "58", viewBox: "0 0 1200 620" });
  minimapSvg.append(svgEl("rect", { x: "0", y: "0", width: "1200", height: "620", rx: "28", fill: "#070b12" }));
  const minimapNodesG = svgEl("g");
  const minimapRect = svgEl("rect", { x: "0", y: "0", width: "420", height: "260", rx: "16", fill: "rgba(56,189,248,0.12)", stroke: "#38bdf8", "stroke-width": "14" });
  minimapSvg.append(minimapNodesG, minimapRect);
  minimapWrap.append(minimapSvg);
  canvasWrap.append(minimapWrap);

  // Bottom-Right Legend
  const legendEl = el("div", "uw-wf-legend");
  for (const [cls, txt] of [
    ["done", "已确认/完成"],
    ["pending", "待先确认效果图"],
    ["parallel", "并行泳道"],
  ]) {
    const item = el("span", `uw-wf-legend-item ${cls}`, txt);
    legendEl.append(item);
  }
  canvasWrap.append(legendEl);

  // Right Docked Inspector Panel (Page Mockup Gate + Live Node Mutation)
  const inspector = el("aside", "uw-wf-inspector");
  inspector.dataset.uwWfInspector = "true";
  const inspTabs = el("div", "uw-wf-insp-tabs");
  const tabMockBtn = el("button", "uw-wf-insp-tab", "🖼 页面效果图");
  tabMockBtn.type = "button"; tabMockBtn.dataset.uwWfTab = "mockup";
  const tabEditBtn = el("button", "uw-wf-insp-tab", "⚙ 改节点/下钻");
  tabEditBtn.type = "button"; tabEditBtn.dataset.uwWfTab = "edit";
  inspTabs.append(tabMockBtn, tabEditBtn);
  const inspBody = el("div", "uw-wf-insp-body");
  inspector.append(inspTabs, inspBody);

  surface.append(canvasWrap, inspector);
  root.append(surface);

  // Bottom Human Real-Time Insertion & Mutation Bar
  const actionBar = el("div", "uw-wf-action-bar");
  const quickInput = el("input", "uw-wf-quick-input");
  quickInput.type = "text";
  quickInput.placeholder = "输入新节点名（可留空用默认名），点右侧按钮实时插入画布…";
  quickInput.dataset.uwWfQuickInput = "true";

  const addParBtn = el("button", "uw-wf-act-btn uw-wf-act-parallel", "+ 插入并行分支");
  addParBtn.type = "button"; addParBtn.dataset.uwWfAddParallel = "logic"; addParBtn.disabled = busy;

  const addUiBtn = el("button", "uw-wf-act-btn uw-wf-act-ui", "+ 插入页面节点（含效果图）");
  addUiBtn.type = "button"; addUiBtn.dataset.uwWfAddParallel = "ui"; addUiBtn.disabled = busy;

  const drillBtn = el("button", "uw-wf-act-btn", "↘ 下钻二级子流");
  drillBtn.type = "button"; drillBtn.dataset.uwWfDrill = "true";

  const resetBtn = el("button", "uw-wf-act-btn uw-wf-act-muted", "↺ 还原初始图");
  resetBtn.type = "button"; resetBtn.dataset.uwWfReset = "true"; resetBtn.disabled = busy;

  actionBar.append(quickInput, addParBtn, addUiBtn, drillBtn, resetBtn);
  root.append(actionBar);
  if (errorMessage) {
    const errorLine = el("p", "uw-wf-error", errorMessage);
    errorLine.dataset.uwWfError = "true";
    errorLine.setAttribute("role", "alert");
    root.append(errorLine);
  }

  const activeGraphData = () => {
    if (activeSubflowNodeId) {
      const parent = wfData.nodes.find((n) => n.id === activeSubflowNodeId);
      if (parent?.subflow?.nodes?.length) {
        return {
          isSubflow: true,
          parentNode: parent,
          title: parent.subflow.title || `${parent.title} · 二级子流`,
          nodes: parent.subflow.nodes.map((sn, idx) => ({
            ...sn,
            column: sn.id.endsWith("__in") ? -1
              : sn.id.endsWith("__s1") ? 0
              : sn.kind === "parallel" ? 1
              : sn.kind === "condition" ? 2
              : sn.id.endsWith("__out") ? 3 : idx,
            uiMockup: sn.hasUiPage ? (parent.uiMockup || { status: "pending", version: 1, mode: "wireframe_fallback" }) : null,
          })),
          edges: parent.subflow.edges || [],
        };
      }
    }
    return { isSubflow: false, parentNode: null, title: wfData.systemTitle, nodes: wfData.nodes, edges: wfData.edges };
  };

  const computeLayout = (gData) => {
    const cols = new Map();
    for (const n of gData.nodes) {
      const c = Number.isInteger(n.column) ? n.column : 0;
      if (!cols.has(c)) cols.set(c, []);
      cols.get(c).push(n);
    }
    const sortedCols = [...cols.keys()].sort((a, b) => a - b);
    const gapY = 26;
    const heightOf = (n) => {
      const spec = TITLE_LAYOUT[layoutKind(n)];
      return spec.baseHeight + (titleLines(n).length - 1) * spec.lineHeight;
    };
    const spanOf = (group) => group.reduce((acc, n) => acc + heightOf(n), 0) + Math.max(0, group.length - 1) * gapY;
    // Loop edges arc above the tallest column; reserve that band at the top.
    const loopRoom = (gData.edges || []).some((edge) => edge.kind === "loop") ? 56 : 0;
    const totalH = Math.max(360, Math.max(...[...cols.values()].map(spanOf)) + 64) + loopRoom;
    const columnOf = new Map(gData.nodes.map((n) => [n.id, Number.isInteger(n.column) ? n.column : 0]));
    let curX = 28;
    for (const c of sortedCols) {
      const group = cols.get(c);
      const isTerm = group.every((n) => n.kind === "terminal");
      const isCond = group.every((n) => n.kind === "condition");
      const w = isTerm ? TITLE_LAYOUT.terminal.w : isCond ? TITLE_LAYOUT.condition.w : TITLE_LAYOUT.process.w;
      let curY = loopRoom + Math.round((totalH - loopRoom - spanOf(group)) / 2);
      group.forEach((n) => {
        const h = heightOf(n);
        const key = `${activeSubflowNodeId || "root"}:${n.id}`;
        const existing = nodePositions.get(key) || n.customPos;
        if (existing) {
          nodePositions.set(key, { x: existing.x, y: existing.y, w, h });
        } else {
          nodePositions.set(key, { x: curX, y: curY, w, h });
        }
        curY += h + gapY;
      });
      // A label sits at the middle of its edge, so the gap must hold the
      // widest label leaving this column plus clearance on both ports.
      const labelNeed = Math.max(0, ...(gData.edges || [])
        .filter((edge) => edge.kind !== "loop" && edge.label && columnOf.get(edge.from) === c)
        .map((edge) => edgeLabelWidth(edge.label) + PORT_CLEARANCE * 2));
      curX += w + Math.max(isTerm ? 58 : 74, Math.ceil(labelNeed));
    }
    return { contentW: curX + 24, contentH: totalH };
  };

  let lastDims = { contentW: 920, contentH: 420 };
  // Once the canvas is measured one SVG unit is one screen pixel, so the
  // default zoom shows every label at its own font size.
  let viewW = 920;
  let viewH = 420;
  const measureViewport = () => {
    const w = Math.round(Number(canvasWrap.clientWidth) || 0);
    const h = Math.round(Number(canvasWrap.clientHeight) || 0);
    if (w < 120 || h < 120 || (w === viewW && h === viewH)) return false;
    viewW = w;
    viewH = h;
    return true;
  };
  const syncCamera = (dims) => {
    if (dims?.contentW && dims?.contentH) lastDims = dims;
    svg.setAttribute("viewBox", `0 0 ${viewW} ${viewH}`);
    viewportG.setAttribute("transform", `translate(${Math.round(panX)}, ${Math.round(panY)}) scale(${scale.toFixed(3)})`);
    zScaleBtn.textContent = `${Math.round(scale * 100)}%`;
    const gData = activeGraphData();
    minimapNodesG.replaceChildren?.();
    if (minimapNodesG.children) minimapNodesG.children.length = 0;
    const sx = 1140 / Math.max(880, lastDims.contentW);
    const sy = 560 / Math.max(400, lastDims.contentH);
    for (const n of gData.nodes) {
      const box = nodePositions.get(`${activeSubflowNodeId || "root"}:${n.id}`);
      if (!box) continue;
      const fill = n.hasUiPage && n.uiMockup?.status !== "confirmed"
        ? "#f59e0b"
        : n.status === "completed" || n.status === "accepted" ? "#34d399" : "#38bdf8";
      minimapNodesG.append(svgEl("rect", {
        x: Math.round(box.x * sx) + 20,
        y: Math.round(box.y * sy) + 20,
        width: Math.max(24, Math.round(box.w * sx)),
        height: Math.max(16, Math.round(box.h * sy)),
        rx: "8",
        fill,
        "fill-opacity": "0.82",
      }));
    }
    const vx = Math.max(0, Math.round((-panX / scale) * sx));
    const vy = Math.max(0, Math.round((-panY / scale) * sy));
    minimapRect.setAttribute("x", String(Math.min(1020, vx)));
    minimapRect.setAttribute("y", String(Math.min(480, vy)));
    minimapRect.setAttribute("width", String(Math.min(1180, Math.round((viewW / scale) * sx))));
    minimapRect.setAttribute("height", String(Math.min(600, Math.round((viewH / scale) * sy))));
  };

  // The default view never shrinks below 100%: a wide graph is panned, and
  // 「自适应」 still fits everything on demand.
  const setReadableInitialCamera = () => {
    const dims = computeLayout(activeGraphData());
    scale = 1;
    panX = dims.contentW <= viewW ? Math.round((viewW - dims.contentW) / 2) : 12;
    panY = dims.contentH <= viewH ? Math.round((viewH - dims.contentH) / 2) : 12;
    syncCamera(dims);
  };

  const fitViewport = () => {
    const dims = computeLayout(activeGraphData());
    scale = Math.max(0.46, Math.min(1, Math.min((viewW - 24) / dims.contentW, (viewH - 24) / dims.contentH)));
    panX = Math.max(10, Math.round((viewW - dims.contentW * scale) / 2));
    panY = Math.max(10, Math.round((viewH - dims.contentH * scale) / 2));
    syncCamera(dims);
  };

  const clearChildren = (target) => {
    if (typeof target.replaceChildren === "function") target.replaceChildren();
    else if (Array.isArray(target.children)) target.children.length = 0;
  };

  const buildVisualWireframeCard = (node) => {
    const mock = node.uiMockup || {};
    const spec = mock.wireframeSpec || {
      layoutType: mock.variant || "workbench",
      version: mock.version || 1,
      headerTitle: `${node.title} · 页面预览 v${mock.version || 1}`,
      badgeText: "组件级效果图",
      dualColumn: (mock.version || 1) >= 2,
      summaryLine: node.objective || "",
      featurePills: (node.features || ["主交互区", "实时校验", "确认提交"]).slice(0, 3),
      primaryCta: "保存并继续",
    };

    const wrap = el("div", "uw-wf-wireframe");
    wrap.dataset.uwWfWireframe = spec.layoutType || "workbench";

    // If real model image URL exists, render the model image first with automatic error fallback to wireframe!
    if (mock.mode === "model_image" && mock.imageUrl) {
      const modelTag = el("div", "uw-wf-source-tag uw-wf-source-model", `✨ 模型生图 · ${mock.provider || "image-model"} · v${mock.version || 1}`);
      const img = el("img", "uw-wf-mockup-img");
      img.setAttribute("src", mock.imageUrl);
      img.setAttribute("alt", `${node.title} 页面效果图`);
      wrap.append(modelTag, img);
      return wrap;
    }

    const fbTag = el("div", "uw-wf-source-tag uw-wf-source-fallback",
      `页面示意图 v${mock.version || 1}`);
    wrap.append(fbTag);

    const frame = el("div", "uw-wf-mock-window");
    const winBar = el("div", "uw-wf-mock-winbar");
    winBar.append(
      el("span", "uw-wf-mock-wintitle", trunc(spec.headerTitle || node.title, 24)),
      el("span", "uw-wf-mock-winbadge", spec.badgeText || "响应式页面"),
    );
    frame.append(winBar);

    const bodyGrid = el("div", spec.dualColumn ? "uw-wf-mock-cols uw-wf-mock-dual" : "uw-wf-mock-cols");
    if (spec.dualColumn) {
      const leftPane = el("div", "uw-wf-mock-pane");
      leftPane.append(
        el("strong", "", "左栏：输入与上下文对照"),
        el("small", "", trunc((node.inputContract || [])[0] || spec.summaryLine || "上游输入与参数面板", 34)),
      );
      const rightPane = el("div", "uw-wf-mock-pane uw-wf-mock-pane-accent");
      rightPane.append(
        el("strong", "", "右栏：实时预览与交互区"),
        el("small", "", trunc(spec.feedbackApplied ? `已应用：${spec.feedbackApplied}` : (spec.featurePills?.[0] || "核心可视化工作区"), 36)),
      );
      bodyGrid.append(leftPane, rightPane);
    } else {
      const heroPane = el("div", "uw-wf-mock-pane uw-wf-mock-pane-accent");
      heroPane.append(
        el("strong", "", trunc(node.title, 22)),
        el("small", "", trunc(spec.summaryLine || node.objective || "核心可视化操作区", 44)),
      );
      bodyGrid.append(heroPane);
    }
    frame.append(bodyGrid);

    const pillsRow = el("div", "uw-wf-mock-pills");
    for (const pText of (spec.featurePills || []).slice(0, 3)) {
      pillsRow.append(el("span", "uw-wf-mock-pill", trunc(pText, 18)));
    }
    frame.append(pillsRow);

    const footRow = el("div", "uw-wf-mock-foot");
    footRow.append(
      el("span", "uw-wf-mock-hint", spec.feedbackApplied ? `改版记录：${trunc(spec.feedbackApplied, 20)}` : "交互组件与状态反馈已就绪"),
      el("span", "uw-wf-mock-cta", spec.primaryCta || "确认操作"),
    );
    frame.append(footRow);
    wrap.append(frame);
    return wrap;
  };

  const renderInspector = () => {
    clearChildren(inspBody);
    const gData = activeGraphData();
    const node = gData.nodes.find((n) => n.id === currentSelectedId && n.kind !== "terminal")
      || gData.nodes.find((n) => n.kind !== "terminal")
      || gData.nodes[0];

    tabMockBtn.setAttribute("aria-pressed", String(inspectorTab === "mockup"));
    tabEditBtn.setAttribute("aria-pressed", String(inspectorTab === "edit"));
    if (!node) return;

    if (inspectorTab === "mockup") {
      const titleRow = el("div", "uw-wf-insp-title-row");
      titleRow.append(el("strong", "", node.title));
      if (node.hasUiPage) {
        const confirmed = node.uiMockup?.status === "confirmed";
        const stBadge = el("span", confirmed ? "uw-wf-badge-ok" : "uw-wf-badge-warn",
          confirmed ? "✓ 已确认放行" : "⏸ 待先确认效果图");
        titleRow.append(stBadge);
      }
      inspBody.append(titleRow);

      if (!node.hasUiPage) {
        const box = el("div", "uw-wf-no-ui-box");
        box.append(
          el("p", "", "⚙ 此节点为纯后台处理 / 条件路由节点，不涉及前端页面，无需页面效果图确认。"),
          el("small", "", node.objective || node.summary || ""),
        );
        if (!gData.isSubflow && typeof onMutateWorkflow === "function") {
          const makeUiBtn = el("button", "uw-wf-act-btn uw-wf-act-ui uw-wf-full-btn", "+ 设为页面节点并生成效果图");
          makeUiBtn.type = "button";
          makeUiBtn.disabled = busy;
          makeUiBtn.addEventListener("click", () => {
            onMutateWorkflow({ action: "update_node", nodeId: node.id, hasUiPage: true });
          });
          box.append(makeUiBtn);
        }
        inspBody.append(box);
        return;
      }

      inspBody.append(buildVisualWireframeCard(node));

      if (!gData.isSubflow && typeof onMutateWorkflow === "function") {
        const fbRow = el("div", "uw-wf-fb-row");
        const fbInput = el("input", "uw-wf-fb-input");
        fbInput.type = "text";
        fbInput.placeholder = "提改图意见（先试模型生图，无则回退改版）…";
        fbInput.dataset.uwWfMockupInput = "true";
        const genBtn = el("button", "uw-wf-act-btn uw-wf-act-parallel", "🎨 生成/改图");
        genBtn.type = "button";
        genBtn.dataset.uwWfGenerateMockup = "true";
        genBtn.disabled = busy;
        genBtn.addEventListener("click", () => {
          onMutateWorkflow({
            action: "revise_mockup",
            nodeId: node.id,
            feedback: fbInput.value.trim() || "优化双栏对照与核心交互层级",
          });
        });
        fbRow.append(fbInput, genBtn);
        inspBody.append(fbRow);

        const isConfirmed = node.uiMockup?.status === "confirmed";
        const confirmBtn = el("button", isConfirmed ? "uw-wf-confirm-btn confirmed" : "uw-wf-confirm-btn pending",
          isConfirmed ? "✓ 页面效果图已确认（点击可撤回重审）" : "✓ 确认此页面效果图 · 允许进入开发");
        confirmBtn.type = "button";
        confirmBtn.dataset.uwWfConfirmMockup = node.id;
        confirmBtn.disabled = busy;
        confirmBtn.addEventListener("click", () => {
          onMutateWorkflow({
            action: "confirm_mockup",
            nodeId: node.id,
            confirmed: !isConfirmed,
          });
        });
        inspBody.append(confirmBtn);
      }
      return;
    }

    // Tab 2: Live Node Edit / Drill-down / Delete
    const editWrap = el("div", "uw-wf-edit-wrap");
    const nameLabel = el("label", "uw-wf-field-label", "节点名称（修改后拓扑与下游实时响应）");
    const nameInput = el("input", "uw-wf-fb-input");
    nameInput.type = "text";
    nameInput.value = node.title || "";
    nameInput.dataset.uwWfEditTitle = "true";

    const objLabel = el("label", "uw-wf-field-label", "业务定位与流转职责");
    const objInput = el("textarea", "uw-wf-textarea");
    objInput.rows = 2;
    objInput.value = node.objective || node.summary || "";

    const saveBtn = el("button", "uw-wf-act-btn uw-wf-act-parallel uw-wf-full-btn", "保存节点变更（触发下游复核）");
    saveBtn.type = "button";
    saveBtn.dataset.uwWfSaveNode = "true";
    saveBtn.disabled = busy || gData.isSubflow;
    saveBtn.addEventListener("click", () => {
      onMutateWorkflow?.({
        action: "update_node",
        nodeId: node.id,
        title: nameInput.value.trim() || node.title,
        objective: objInput.value.trim() || node.objective,
      });
    });

    const rowBtns = el("div", "uw-wf-edit-actions");
    const subBtn = el("button", "uw-wf-act-btn", gData.isSubflow ? "← 返回一级总图" : "↘ 下钻二级子流");
    subBtn.type = "button";
    subBtn.addEventListener("click", () => {
      if (gData.isSubflow) {
        activeSubflowNodeId = null;
      } else {
        activeSubflowNodeId = node.id;
      }
      fitViewport();
      drawAll();
    });

    const delBtn = el("button", "uw-wf-act-btn uw-wf-act-danger", "✕ 删除并自动重连");
    delBtn.type = "button";
    delBtn.dataset.uwWfDeleteNode = node.id;
    delBtn.disabled = busy || gData.isSubflow || businessNodes.length <= 1;
    delBtn.addEventListener("click", () => {
      onMutateWorkflow?.({ action: "delete_node", nodeId: node.id });
    });

    rowBtns.append(subBtn, delBtn);
    editWrap.append(nameLabel, nameInput, objLabel, objInput, saveBtn, rowBtns);
    inspBody.append(editWrap);
  };

  const drawGraphSvg = () => {
    const gData = activeGraphData();
    const dims = computeLayout(gData);
    clearChildren(lanesLayer);
    clearChildren(edgesLayer);
    clearChildren(nodesLayer);

    // Update top gate summary & breadcrumbs
    const uiList = wfData.nodes.filter((n) => n.kind !== "terminal" && n.hasUiPage);
    const okUiCount = uiList.filter((n) => n.uiMockup?.status === "confirmed").length;
    gateSummaryBadge.textContent = `🖼 页面效果图已确认 ${okUiCount}/${uiList.length}`;
    gateSummaryBadge.dataset.allConfirmed = String(okUiCount === uiList.length);

    subCrumbSep.hidden = !gData.isSubflow;
    subCrumbBadge.hidden = !gData.isSubflow;
    if (gData.isSubflow) subCrumbBadge.textContent = `二级 · ${gData.title}`;
    drillBtn.textContent = gData.isSubflow ? "← 返回一级总流程图" : "↘ 下钻二级子流";

    // Draw Parallel Swimlanes backdrop
    const byCol = new Map();
    for (const n of gData.nodes) {
      if (n.kind === "terminal") continue;
      if (!byCol.has(n.column)) byCol.set(n.column, []);
      byCol.get(n.column).push(n);
    }
    for (const [, group] of byCol.entries()) {
      if (group.length < 2) continue;
      const boxes = group.map((n) => nodePositions.get(`${activeSubflowNodeId || "root"}:${n.id}`)).filter(Boolean);
      if (boxes.length < 2) continue;
      const minX = Math.min(...boxes.map((b) => b.x)) - 14;
      const minY = Math.min(...boxes.map((b) => b.y)) - 28;
      const maxX = Math.max(...boxes.map((b) => b.x + b.w)) + 14;
      const maxY = Math.max(...boxes.map((b) => b.y + b.h)) + 14;
      lanesLayer.append(
        svgEl("rect", {
          x: minX, y: minY, width: maxX - minX, height: maxY - minY, rx: "14",
          fill: "rgba(56,189,248,0.045)", stroke: "rgba(56,189,248,0.3)", "stroke-dasharray": "6 4",
        }),
        Object.assign(svgEl("text", { x: minX + 12, y: minY + 17, fill: "#7dd3fc", "font-size": "11", "font-weight": "600" }), {
          textContent: `⚡ 并行执行泳道（${group.length} 路并发）`,
        }),
      );
    }

    // Draw Edges + '+' Live Insertion Handles
    const edgeRefreshers = [];
    for (const edge of gData.edges) {
      const bFrom = nodePositions.get(`${activeSubflowNodeId || "root"}:${edge.from}`);
      const bTo = nodePositions.get(`${activeSubflowNodeId || "root"}:${edge.to}`);
      if (!bFrom || !bTo) continue;

      const edgeG = svgEl("g", { class: "uw-wf-edge-g" });
      const pathEl = svgEl("path", { fill: "none" });
      // A thin line is hard to hover; this transparent band reveals the ⊕.
      const hitPath = svgEl("path", { fill: "none", stroke: "transparent", "stroke-width": "16", class: "uw-wf-edge-hit" });
      const labelEl = edge.label ? svgEl("text", { "text-anchor": "middle", fill: "#cbd5e1", "font-size": String(EDGE_LABEL_FONT) }) : null;
      if (labelEl) labelEl.textContent = edge.label;

      let plusG = null;
      if (edge.kind !== "loop" && !gData.isSubflow && typeof onMutateWorkflow === "function") {
        plusG = svgEl("g", { class: "uw-wf-edge-plus", role: "button", tabindex: "0" });
        plusG.dataset.uwWfInsertEdge = edge.id;
        const cEl = svgEl("circle", { r: "9.5", fill: "#0f172a", stroke: "#38bdf8", "stroke-width": "1.5" });
        const tEl = svgEl("text", { "text-anchor": "middle", fill: "#7dd3fc", "font-size": "13", "font-weight": "700" });
        tEl.textContent = "+";
        const titleHint = svgEl("title");
        titleHint.textContent = "点击在此连线处实时插入新节点";
        plusG.append(cEl, tEl, titleHint);
        plusG.addEventListener("pointerdown", (ev) => ev?.stopPropagation?.());
        const insertOnEdge = (ev) => {
          ev?.stopPropagation?.();
          const customTitle = quickInput.value.trim();
          if (customTitle) quickInput.value = "";
          onMutateWorkflow({
            action: "insert_on_edge",
            edgeId: edge.id,
            title: customTitle || undefined,
            hasUiPage: true,
          });
        };
        plusG.addEventListener("click", insertOnEdge);
        plusG.addEventListener("keydown", (ev) => {
          if (ev?.key !== "Enter" && ev?.key !== " ") return;
          ev.preventDefault?.();
          insertOnEdge(ev);
        });
      }

      const updateGeometry = () => {
        const f = nodePositions.get(`${activeSubflowNodeId || "root"}:${edge.from}`);
        const t = nodePositions.get(`${activeSubflowNodeId || "root"}:${edge.to}`);
        if (!f || !t) return;
        if (edge.kind === "loop") {
          const sx = f.x + f.w / 2;
          const sy = f.y;
          const tx = t.x + t.w / 2;
          const ty = t.y;
          // Clear every node the loop passes over, not only its two ends.
          const prefix = `${activeSubflowNodeId || "root"}:`;
          const spanTop = Math.min(sy, ty, ...[...nodePositions.entries()]
            .filter(([key, b]) => key.startsWith(prefix) && b.x + b.w >= Math.min(sx, tx) && b.x <= Math.max(sx, tx))
            .map(([, b]) => b.y));
          const arcY = spanTop - 48;
          const d = `M ${sx} ${sy} C ${sx} ${arcY}, ${tx} ${arcY}, ${tx} ${ty}`;
          pathEl.setAttribute("d", d);
          hitPath.setAttribute("d", d);
          pathEl.setAttribute("stroke", "#fbbf24");
          pathEl.setAttribute("stroke-width", "1.8");
          pathEl.setAttribute("stroke-dasharray", "6 4");
          pathEl.setAttribute("marker-end", "url(#uw-wf-arr-warn)");
          if (labelEl) {
            labelEl.setAttribute("x", String(Math.round((sx + tx) / 2)));
            labelEl.setAttribute("y", String(arcY + 12));
            labelEl.setAttribute("fill", "#fcd34d");
          }
          return;
        }
        const sx = f.x + f.w;
        const sy = f.y + f.h / 2;
        const tx = t.x;
        const ty = t.y + t.h / 2;
        const dx = Math.max(44, Math.abs(tx - sx) * 0.46);
        const d = `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
        pathEl.setAttribute("d", d);
        hitPath.setAttribute("d", d);
        const isPar = edge.kind === "parallel";
        pathEl.setAttribute("stroke", isPar ? "#38bdf8" : "#64748b");
        pathEl.setAttribute("stroke-width", "2.1");
        pathEl.setAttribute("marker-end", isPar ? "url(#uw-wf-arr-act)" : "url(#uw-wf-arr-norm)");
        if (isPar) pathEl.setAttribute("class", "uw-wf-wire-anim");
        const mx = Math.round((sx + tx) / 2);
        const my = Math.round((sy + ty) / 2);
        if (labelEl) {
          labelEl.setAttribute("x", String(mx));
          labelEl.setAttribute("y", String(my - 13));
        }
        if (plusG) {
          plusG.setAttribute("transform", `translate(${mx}, ${my})`);
        }
      };

      updateGeometry();
      edgeG.append(pathEl, hitPath);
      if (labelEl) edgeG.append(labelEl);
      if (plusG) edgeG.append(plusG);
      edgesLayer.append(edgeG);
      edgeRefreshers.push(updateGeometry);
    }

    // Draw Nodes
    let activeDrag = null;
    let suppressClick = false;
    for (const node of gData.nodes) {
      const key = `${activeSubflowNodeId || "root"}:${node.id}`;
      const box = nodePositions.get(key);
      if (!box) continue;
      const isSel = node.id === currentSelectedId;
      const isStartAnchor = node.id === "start" || node.id.endsWith("__in");
      const isKgNode = isStartAnchor || node.kind !== "terminal";
      const g = svgEl("g", {
        class: `uw-wf-node${isKgNode ? " uw-kg-node" : ""}${node.reacted ? " uw-wf-node-reacted" : ""}`,
        transform: `translate(${box.x}, ${box.y})`,
        tabindex: "0",
        role: "button",
      });
      g.dataset.livePrdGraphNode = node.id;
      g.dataset.uwWfNode = node.id;
      g.dataset.kind = isStartAnchor ? "architecture" : (node.kind === "terminal" ? "terminal" : "module");
      g.dataset.wfKind = node.kind;
      g.dataset.selected = String(isSel);

      if (node.kind === "terminal") {
        const isStart = node.id.includes("start") || node.id.endsWith("__in");
        const spec = TITLE_LAYOUT.terminal;
        const lines = titleLines(node);
        const firstY = box.h / 2 + 4 - ((lines.length - 1) * spec.lineHeight) / 2;
        g.append(
          svgEl("rect", {
            x: "0", y: "0", width: box.w, height: box.h, rx: "22",
            fill: isStart ? "#064e3b" : "#1e293b",
            stroke: isSel ? "#f8fafc" : (isStart ? "#34d399" : "#64748b"),
            "stroke-width": isSel ? "2.5" : "1.7",
          }),
          ...lines.map((line, index) => Object.assign(svgEl("text", {
            x: box.w / 2, y: Math.round(firstY + index * spec.lineHeight), "text-anchor": "middle", fill: "#f8fafc",
            "font-size": String(spec.fontSize), "font-weight": "600",
          }), { textContent: line })),
        );
      } else if (node.kind === "condition") {
        const spec = TITLE_LAYOUT.condition;
        const lines = titleLines(node);
        const cx = box.w / 2;
        const cy = box.h / 2;
        const codeY = cy - 6 - ((lines.length - 1) * spec.lineHeight) / 2;
        g.append(
          svgEl("polygon", {
            points: `${cx},0 ${box.w},${cy} ${cx},${box.h} 0,${cy}`,
            fill: "#1e1b2e",
            stroke: isSel ? "#f8fafc" : "#a78bfa",
            "stroke-width": isSel ? "2.6" : "1.9",
          }),
          Object.assign(svgEl("text", {
            x: cx, y: Math.round(codeY), "text-anchor": "middle", fill: "#ddd6fe", "font-size": "10.5", "font-weight": "700",
          }), { textContent: `◇ ${node.code || "条件路由"}` }),
          ...lines.map((line, index) => Object.assign(svgEl("text", {
            x: cx, y: Math.round(codeY + 17 + index * spec.lineHeight), "text-anchor": "middle", fill: "#f8fafc",
            "font-size": String(spec.fontSize), "font-weight": "600",
          }), { textContent: line })),
        );
      } else {
        const spec = TITLE_LAYOUT.process;
        const lines = titleLines(node);
        const extra = (lines.length - 1) * spec.lineHeight;
        const done = node.status === "completed" || node.status === "accepted";
        const pendingUi = node.hasUiPage && node.uiMockup?.status !== "confirmed";
        const stroke = isSel
          ? "#f8fafc"
          : node.reacted
            ? "#fbbf24"
            : pendingUi
              ? "#f59e0b"
              : done
                ? "#34d399"
                : "#38bdf8";
        const statusLabel = node.reacted ? "⚡ 待复核"
          : ({ completed: "✓ 已完成", accepted: "✓ 已验收", identified: "◇ 已识别", running: "● 运行中", partial: "◐ 进行中" })[node.status] || "○ 待开始";

        g.append(
          svgEl("rect", {
            x: "0", y: "0", width: box.w, height: box.h, rx: "12",
            fill: "#111827", stroke, "stroke-width": isSel ? "2.8" : "1.8",
          }),
          svgEl("circle", { cx: "0", cy: box.h / 2, r: "4.2", fill: "#0f172a", stroke, "stroke-width": "1.8" }),
          svgEl("circle", { cx: box.w, cy: box.h / 2, r: "4.2", fill: "#0f172a", stroke, "stroke-width": "1.8" }),
          Object.assign(svgEl("text", { x: "11", y: "19", fill: "#94a3b8", "font-size": "10.5", "font-weight": "600" }), {
            textContent: node.code || "模块",
          }),
          Object.assign(svgEl("text", {
            x: box.w - 10, y: "19", "text-anchor": "end",
            fill: node.reacted ? "#fcd34d" : (done ? "#6ee7b7" : "#7dd3fc"),
            "font-size": "10.5", "font-weight": "600",
          }), { textContent: statusLabel }),
          ...lines.map((line, index) => Object.assign(svgEl("text", {
            x: "11", y: String(43 + index * spec.lineHeight), fill: "#f8fafc", "font-size": String(spec.fontSize), "font-weight": "700",
          }), { textContent: line })),
        );

        // The drill-down hint shares the bottom row so the title keeps the full width.
        const drillable = !gData.isSubflow && Boolean(node.subflow);
        const badgeW = box.w - 20 - (drillable ? 44 : 0);
        const badgeY = 60 + extra;
        if (node.hasUiPage) {
          const ok = node.uiMockup?.status === "confirmed";
          const ver = node.uiMockup?.version || 1;
          g.append(
            svgEl("rect", {
              x: "10", y: String(badgeY), width: badgeW, height: "22", rx: "6",
              fill: ok ? "#064e3b" : "#451a03",
              stroke: ok ? "#10b981" : "#f59e0b",
              "stroke-width": "1.1",
            }),
            Object.assign(svgEl("text", {
              x: 10 + badgeW / 2, y: String(badgeY + 14.5), "text-anchor": "middle",
              fill: ok ? "#a7f3d0" : "#fde68a",
              "font-size": "10.5", "font-weight": "600",
            }), {
              textContent: ok ? `🖼 示意图 v${ver} 已确认` : `🖼 待确认示意图 v${ver}`,
            }),
          );
        } else {
          g.append(
            svgEl("rect", {
              x: "10", y: String(badgeY), width: badgeW, height: "21", rx: "6",
              fill: "#0f172a", stroke: "#334155", "stroke-width": "1",
            }),
            Object.assign(svgEl("text", {
              x: 10 + badgeW / 2, y: String(badgeY + 14), "text-anchor": "middle", fill: "#94a3b8", "font-size": "10.5",
            }), { textContent: "⚙ 后台模块（无页面）" }),
          );
        }
        if (drillable) {
          g.append(Object.assign(svgEl("text", { x: box.w - 10, y: String(badgeY + 14.5), "text-anchor": "end", fill: "#38bdf8", "font-size": "10.5" }), {
            textContent: "二级↘",
          }));
        }
      }

      const fullTip = svgEl("title");
      fullTip.textContent = `${node.title}${node.objective ? ` · ${node.objective}` : ""}（双击可下钻二级子流）`;
      g.append(fullTip);

      g.addEventListener("pointerdown", (ev) => {
        if (!ev || (typeof ev.button === "number" && ev.button !== 0)) return;
        ev.stopPropagation?.();
        const cur = nodePositions.get(key);
        activeDrag = {
          pid: ev.pointerId, sx: ev.clientX, sy: ev.clientY,
          ox: cur.x, oy: cur.y, w: cur.w, h: cur.h, moved: false,
        };
        g.setPointerCapture?.(ev.pointerId);
      });
      g.addEventListener("pointermove", (ev) => {
        if (!activeDrag || ev.pointerId !== activeDrag.pid) return;
        const dx = (ev.clientX - activeDrag.sx) / (scale || 1);
        const dy = (ev.clientY - activeDrag.sy) / (scale || 1);
        if (!activeDrag.moved && Math.hypot(ev.clientX - activeDrag.sx, ev.clientY - activeDrag.sy) > 4) {
          activeDrag.moved = true;
        }
        if (!activeDrag.moved) return;
        const nx = Math.round(activeDrag.ox + dx);
        const ny = Math.round(activeDrag.oy + dy);
        nodePositions.set(key, { x: nx, y: ny, w: activeDrag.w, h: activeDrag.h });
        g.setAttribute("transform", `translate(${nx}, ${ny})`);
        for (const fn of edgeRefreshers) fn();
        syncCamera(dims);
      });
      const stopNodeDrag = (ev) => {
        if (!activeDrag) return;
        if (activeDrag.moved) suppressClick = true;
        g.releasePointerCapture?.(ev?.pointerId);
        activeDrag = null;
      };
      g.addEventListener("pointerup", stopNodeDrag);
      g.addEventListener("pointercancel", stopNodeDrag);
      const selectThisNode = () => {
        currentSelectedId = node.id;
        if (node.hasUiPage) inspectorTab = "mockup";
        drawAll();
        if (!gData.isSubflow && node.kind !== "terminal") {
          onSelectNode?.({ id: node.id, sourceId: node.id, title: node.title, kind: "module" });
        }
      };
      g.addEventListener("click", (ev) => {
        if (suppressClick) { suppressClick = false; ev?.stopPropagation?.(); return; }
        selectThisNode();
      });
      g.addEventListener("keydown", (ev) => {
        if (ev?.key !== "Enter" && ev?.key !== " ") return;
        ev.preventDefault?.();
        selectThisNode();
      });
      g.addEventListener("dblclick", (ev) => {
        ev?.stopPropagation?.();
        if (!gData.isSubflow && node.kind !== "terminal") {
          activeSubflowNodeId = node.id;
          currentSelectedId = node.subflow?.nodes?.[1]?.id || `${node.id}__s1`;
          fitViewport();
          drawAll();
        }
      });
      nodesLayer.append(g);
    }

    syncCamera(dims);
  };

  const drawAll = () => {
    drawGraphSvg();
    renderInspector();
  };

  // Infinite Canvas Background Pan & Wheel Zoom
  let panState = null;
  canvasWrap.addEventListener("pointerdown", (ev) => {
    if (!ev || (typeof ev.button === "number" && ev.button !== 0)) return;
    if (ev.target?.closest?.(".uw-wf-node, .uw-wf-edge-plus, button")) return;
    panState = { pid: ev.pointerId, sx: ev.clientX, sy: ev.clientY, bx: panX, by: panY };
    canvasWrap.setPointerCapture?.(ev.pointerId);
  });
  canvasWrap.addEventListener("pointermove", (ev) => {
    if (!panState || ev.pointerId !== panState.pid) return;
    panX = panState.bx + (ev.clientX - panState.sx);
    panY = panState.by + (ev.clientY - panState.sy);
    syncCamera();
  });
  const endPan = (ev) => {
    if (!panState) return;
    canvasWrap.releasePointerCapture?.(ev?.pointerId);
    panState = null;
  };
  canvasWrap.addEventListener("pointerup", endPan);
  canvasWrap.addEventListener("pointercancel", endPan);
  canvasWrap.addEventListener("wheel", (ev) => {
    if (!ev) return;
    ev.preventDefault?.();
    const factor = ev.deltaY < 0 ? 1.11 : 0.9;
    scale = Math.max(0.42, Math.min(1.85, scale * factor));
    syncCamera();
  }, { passive: false });

  // Toolbar & Action Buttons
  rootCrumbBtn.addEventListener("click", () => {
    if (activeSubflowNodeId) {
      currentSelectedId = activeSubflowNodeId;
      activeSubflowNodeId = null;
      fitViewport();
      drawAll();
    } else {
      onSelectNode?.({ id: "system-architecture", sourceId: "system-architecture", title: wfData.systemTitle, kind: "architecture" });
    }
  });
  zInBtn.addEventListener("click", () => { scale = Math.min(1.85, scale + 0.12); syncCamera(); });
  zOutBtn.addEventListener("click", () => { scale = Math.max(0.42, scale - 0.12); syncCamera(); });
  zScaleBtn.addEventListener("click", () => { scale = 1; panX = 16; panY = 16; syncCamera(); });
  fitBtn.addEventListener("click", fitViewport);
  maxBtn.addEventListener("click", () => {
    const next = root.dataset.maximized !== "true";
    root.dataset.maximized = String(next);
    maxBtn.setAttribute("aria-pressed", String(next));
    maxBtn.textContent = next ? "还原" : "最大化";
  });
  tabMockBtn.addEventListener("click", () => { inspectorTab = "mockup"; renderInspector(); });
  tabEditBtn.addEventListener("click", () => { inspectorTab = "edit"; renderInspector(); });

  addParBtn.addEventListener("click", () => {
    const customTitle = quickInput.value.trim();
    if (customTitle) quickInput.value = "";
    onMutateWorkflow?.({
      action: "add_parallel",
      title: customTitle || undefined,
      hasUiPage: false,
    });
  });
  addUiBtn.addEventListener("click", () => {
    const customTitle = quickInput.value.trim();
    if (customTitle) quickInput.value = "";
    onMutateWorkflow?.({
      action: "add_parallel",
      title: customTitle || undefined,
      hasUiPage: true,
    });
  });
  drillBtn.addEventListener("click", () => {
    if (activeSubflowNodeId) {
      currentSelectedId = activeSubflowNodeId;
      activeSubflowNodeId = null;
    } else {
      const candidate = wfData.nodes.find((n) => n.id === currentSelectedId && n.kind !== "terminal")
        || businessNodes[0];
      if (candidate) activeSubflowNodeId = candidate.id;
    }
    fitViewport();
    drawAll();
  });
  resetBtn.addEventListener("click", () => {
    nodePositions.clear();
    activeSubflowNodeId = null;
    onMutateWorkflow?.({ action: "reset_baseline" });
  });

  let cameraMeasured = measureViewport();
  setReadableInitialCamera();
  drawAll();
  // The canvas is measured again once the host attaches it, and the viewBox
  // follows later panel resizes without changing the user's zoom. A canvas built
  // inside a hidden or collapsed pane has nothing to measure yet, so its readable
  // camera waits for the first measurement that succeeds.
  const win = doc.defaultView;
  win?.requestAnimationFrame?.(() => { if (measureViewport()) { cameraMeasured = true; setReadableInitialCamera(); drawAll(); } });
  if (typeof win?.ResizeObserver === "function") {
    const resizeWatch = new win.ResizeObserver(() => {
      if (!canvasWrap.isConnected) { resizeWatch.disconnect(); return; }
      if (!measureViewport()) return;
      if (cameraMeasured) { syncCamera(); return; }
      cameraMeasured = true;
      setReadableInitialCamera();
      drawAll();
    });
    resizeWatch.observe(canvasWrap);
  }
  return root;
}
