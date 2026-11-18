/**
 * Interactive LangGraph-style Dynamic Workflow PRD Canvas Service.
 *
 * Combines repository Product Design PRD baselines with live human graph mutations
 * (inserting sequential/parallel nodes, rewiring/deleting nodes, downstream impact
 * propagation, and model-first / wireframe-fallback Page Effect Mockup confirmation).
 */
import { randomUUID } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";

import { buildDefaultSubflowForModule, discoverProjectArchitecturePrd } from "./project-architecture-prd-service.mjs";
import {
  buildStructuredWireframeSpec,
  generatePageEffectMockup,
  inferMockupVariant,
  readStoredMockupImage,
} from "./prd-mockup-generator-service.mjs";

export const PRD_WORKFLOW_CANVAS_SCHEMA = "meta-kim-prd-workflow-canvas-v1";

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_STATE_BYTES = 512 * 1024;
const NODE_ID_RE = /^[a-z][a-z0-9_-]{1,39}$/u;

function cleanText(value, maxLen = 240) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, maxLen);
}

export function ensureWorkflowStateDir(projectRoot, profile = "default") {
  const realRoot = realpathSync(projectRoot);
  let current = realRoot;
  for (const seg of [".meta-kim", "state", profile, "prd-workflow"]) {
    current = path.join(current, seg);
    try { mkdirSync(current, { mode: 0o700 }); } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new TypeError("PRD workflow state path must not contain symlinks");
    }
  }
  return current;
}

function readCanvasState(workflowStateDir) {
  const target = path.join(workflowStateDir, "canvas-state.json");
  if (!existsSync(target)) return null;
  let fd = null;
  try {
    if (lstatSync(target).isSymbolicLink()) return null;
    fd = openSync(target, constants.O_RDONLY | O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_STATE_BYTES) return null;
    const parsed = JSON.parse(readFileSync(fd, "utf8"));
    return parsed && typeof parsed === "object" && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)
      ? parsed
      : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function writeCanvasState(workflowStateDir, stateObj) {
  const target = path.join(workflowStateDir, "canvas-state.json");
  const payload = JSON.stringify(stateObj);
  if (Buffer.byteLength(payload, "utf8") > MAX_STATE_BYTES) {
    throw new RangeError("PRD workflow state exceeds bounded size");
  }
  const tmp = path.join(workflowStateDir, `canvas-state.${randomUUID()}.tmp`);
  let fd = null;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
    writeFileSync(fd, payload, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, target);
  } finally {
    if (fd !== null) closeSync(fd);
    if (existsSync(tmp)) {
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
}

function computeTopologicalColumns(modules) {
  const byId = new Map(modules.map((m) => [m.id, m]));
  const memo = new Map();
  const visiting = new Set();
  const depthOf = (id) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const mod = byId.get(id);
    let col = Number.isInteger(mod?.flowColumn) ? mod.flowColumn : 0;
    if (!Number.isInteger(mod?.flowColumn)) {
      for (const dep of mod?.dependencies || []) {
        if (byId.has(dep)) col = Math.max(col, depthOf(dep) + 1);
      }
    }
    visiting.delete(id);
    memo.set(id, col);
    return col;
  };
  for (const mod of modules) depthOf(mod.id);
  return memo;
}

function buildInitialWorkflowFromPrd(prd) {
  const rawModules = Array.isArray(prd?.modules) ? prd.modules : [];
  const colMap = computeTopologicalColumns(rawModules);
  const uniqueCols = [...new Set([...colMap.values()])].sort((a, b) => a - b);
  const normalizedColIndex = new Map(uniqueCols.map((c, idx) => [c, idx]));

  const byCol = new Map();
  for (const mod of rawModules) {
    const col = normalizedColIndex.get(colMap.get(mod.id)) ?? 0;
    if (!byCol.has(col)) byCol.set(col, []);
    byCol.get(col).push(mod);
  }

  const colKeys = [...byCol.keys()].sort((a, b) => a - b);
  const nodes = [
    {
      id: "start",
      kind: "terminal",
      code: "START",
      title: "开始 · 用户意图输入",
      status: "completed",
      column: -1,
      hasUiPage: false,
      uiMockup: null,
    },
  ];

  let stepCounter = 1;
  for (const col of colKeys) {
    const group = byCol.get(col);
    const isParallel = group.length >= 2;
    group.forEach((mod, laneIdx) => {
      const code = mod.nodeKind === "condition"
        ? "条件路由"
        : isParallel
          ? `0${col + 1}${String.fromCharCode(65 + laneIdx)} · 并行`
          : `0${col + 1}`;
      stepCounter += 1;
      nodes.push({
        id: mod.id,
        kind: mod.nodeKind === "condition" ? "condition" : (isParallel ? "parallel" : "process"),
        code,
        title: mod.title,
        shortSummary: mod.shortSummary || "",
        objective: mod.objective || "",
        features: mod.features || [],
        inputContract: mod.inputContract || [],
        outputContract: mod.outputContract || [],
        boundaries: mod.boundaries || [],
        acceptance: mod.acceptance || [],
        status: mod.status || "completed",
        column: col,
        parallelGroup: isParallel ? (mod.parallelGroup || `lane_${col}`) : null,
        hasUiPage: Boolean(mod.hasUiPage),
        uiMockup: mod.hasUiPage
          ? (mod.uiMockup || {
              status: mod.status === "completed" ? "confirmed" : "pending",
              version: 1,
              mode: "wireframe_fallback",
              variant: inferMockupVariant({ nodeId: mod.id, title: mod.title, objective: mod.objective }),
              imageUrl: null,
              fallbackReason: "默认结构化效果图预览",
              wireframeSpec: buildStructuredWireframeSpec({
                title: mod.title,
                objective: mod.objective,
                features: mod.features,
                version: 1,
              }),
            })
          : null,
        reacted: false,
        subflow: mod.subflow || buildDefaultSubflowForModule(mod),
      });
    });
  }

  const maxCol = colKeys.length ? Math.max(...colKeys) : 0;
  nodes.push({
    id: "end",
    kind: "terminal",
    code: "END",
    title: "闭环交付",
    status: prd?.system?.status || "completed",
    column: maxCol + 1,
    hasUiPage: false,
    uiMockup: null,
  });

  // Build clean flow edges across consecutive stages + explicit loop-backs
  const edges = [];
  let edgeSeq = 1;
  const addEdge = (from, to, label = "", kind = "normal") => {
    if (from === to) return;
    if (edges.some((e) => e.from === from && e.to === to && e.kind === kind)) return;
    edges.push({ id: `wf_e${edgeSeq++}`, from, to, label, kind });
  };

  if (colKeys.length > 0) {
    const firstGroup = byCol.get(colKeys[0]);
    for (const m of firstGroup) {
      addEdge("start", m.id, firstGroup.length > 1 ? "并发启动" : "进入主流程", firstGroup.length > 1 ? "parallel" : "normal");
    }
    for (let i = 0; i < colKeys.length - 1; i += 1) {
      const curGroup = byCol.get(colKeys[i]);
      const nextGroup = byCol.get(colKeys[i + 1]);
      if (curGroup.length > 1 && nextGroup.length > 1) {
        // Connect matching lanes cleanly via first/condition anchor to avoid N*M spaghetti
        const hub = curGroup[0];
        for (const up of curGroup) {
          for (const down of nextGroup) {
            if ((down.dependencies || []).includes(up.id)) {
              addEdge(up.id, down.id, "协同流转", "parallel");
            }
          }
        }
        for (const down of nextGroup) {
          if (!edges.some((e) => e.to === down.id)) {
            addEdge(hub.id, down.id, "并行分叉", "parallel");
          }
        }
        for (const up of curGroup) {
          if (!edges.some((e) => e.from === up.id)) {
            addEdge(up.id, nextGroup[0].id, "并行汇入", "parallel");
          }
        }
      } else {
        for (const up of curGroup) {
          for (const down of nextGroup) {
            const label = up.nodeKind === "condition" ? "门禁放行"
              : nextGroup.length > 1 ? "并行分叉"
              : curGroup.length > 1 ? "汇聚" : "";
            addEdge(up.id, down.id, label, nextGroup.length > 1 || curGroup.length > 1 ? "parallel" : "normal");
          }
        }
      }
    }
    const lastGroup = byCol.get(colKeys.at(-1));
    for (const m of lastGroup) {
      addEdge(m.id, "end", "验收交付", "normal");
    }
  } else {
    addEdge("start", "end", "", "normal");
  }

  for (const mod of rawModules) {
    if (mod.loopBackTo && nodes.some((n) => n.id === mod.loopBackTo)) {
      addEdge(mod.id, mod.loopBackTo, "未确认/返工打回", "loop");
    }
  }

  return {
    schemaVersion: PRD_WORKFLOW_CANVAS_SCHEMA,
    revision: 1,
    projectName: prd?.projectName || "Project",
    systemTitle: prd?.system?.title || "系统总流程图",
    systemGoal: prd?.system?.goal || "",
    lastMutationNote: null,
    nodes,
    edges,
  };
}

function markDownstreamImpacted(stateObj, startNodeId) {
  const visited = new Set();
  const queue = [startNodeId];
  const impacted = [];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const edge of stateObj.edges) {
      if (edge.from === cur && edge.kind !== "loop" && !visited.has(edge.to)) {
        visited.add(edge.to);
        const target = stateObj.nodes.find((n) => n.id === edge.to);
        if (target && target.kind !== "terminal") {
          target.reacted = true;
          if (target.status === "completed") target.status = "partial";
          impacted.push(target.id);
        }
        queue.push(edge.to);
      }
    }
  }
  return impacted;
}

export function getOrBuildPrdWorkflowCanvas({ projectRoot, profile = "default" } = {}) {
  const prd = discoverProjectArchitecturePrd({ projectRoot });
  if (!prd) return null;
  const workflowStateDir = ensureWorkflowStateDir(projectRoot, profile);
  const saved = readCanvasState(workflowStateDir);
  if (saved && saved.schemaVersion === PRD_WORKFLOW_CANVAS_SCHEMA) {
    return decorateSummary(saved);
  }
  const fresh = buildInitialWorkflowFromPrd(prd);
  return decorateSummary(fresh);
}

function decorateSummary(stateObj) {
  const businessNodes = stateObj.nodes.filter((n) => n.kind !== "terminal");
  const uiNodes = businessNodes.filter((n) => n.hasUiPage);
  const confirmedUiNodes = uiNodes.filter((n) => n.uiMockup?.status === "confirmed");
  const completedNodes = businessNodes.filter((n) => n.status === "completed");
  return {
    ...stateObj,
    summary: {
      totalNodes: businessNodes.length,
      completedNodes: completedNodes.length,
      uiPageNodes: uiNodes.length,
      confirmedMockupNodes: confirmedUiNodes.length,
      allMockupsConfirmed: uiNodes.every((n) => n.uiMockup?.status === "confirmed"),
    },
  };
}

export async function mutatePrdWorkflowCanvas({
  projectRoot,
  projectId = "",
  profile = "default",
  mutation = {},
  environment = process.env,
  execFileImpl,
  fetchImpl,
} = {}) {
  const workflowStateDir = ensureWorkflowStateDir(projectRoot, profile);
  const prd = discoverProjectArchitecturePrd({ projectRoot });
  if (!prd) throw new Error("project_prd_unavailable");

  if (mutation.action === "reset_baseline") {
    const target = path.join(workflowStateDir, "canvas-state.json");
    if (existsSync(target)) {
      try { unlinkSync(target); } catch { /* ignore */ }
    }
    const fresh = buildInitialWorkflowFromPrd(prd);
    return decorateSummary(fresh);
  }

  const current = readCanvasState(workflowStateDir) || buildInitialWorkflowFromPrd(prd);
  for (const n of current.nodes) n.reacted = false;

  const action = mutation.action;
  if (action === "insert_on_edge") {
    const edge = current.edges.find((e) => e.id === mutation.edgeId);
    if (!edge) throw new Error("workflow_edge_not_found");
    const fromNode = current.nodes.find((n) => n.id === edge.from);
    const toNode = current.nodes.find((n) => n.id === edge.to);
    if (!fromNode || !toNode) throw new Error("workflow_edge_endpoints_missing");

    const title = cleanText(mutation.title, 80) || (mutation.hasUiPage !== false ? "新增页面确认节点" : "新增业务处理节点");
    const hasUiPage = mutation.hasUiPage !== false;
    const objective = cleanText(mutation.objective, 300) || `人工在「${fromNode.title} → ${toNode.title}」之间实时插入的${hasUiPage ? "前端页面" : "后台处理"}节点。`;
    const newId = `node_${randomUUID().slice(0, 8)}`;
    const insertCol = (Number.isInteger(fromNode.column) ? fromNode.column : 0) + 1;

    for (const n of current.nodes) {
      if (n.id !== fromNode.id && Number.isInteger(n.column) && n.column >= insertCol) {
        n.column += 1;
      }
    }

    let uiMockup = null;
    if (hasUiPage) {
      const gen = await generatePageEffectMockup({
        workflowStateDir,
        projectId,
        projectName: current.projectName,
        nodeId: newId,
        title,
        objective,
        features: [objective],
        version: 1,
        tryModelFirst: mutation.tryModelFirst !== false,
        environment,
        ...(execFileImpl && { execFileImpl }),
        ...(fetchImpl && { fetchImpl }),
      });
      uiMockup = { ...gen, status: "pending" };
    }

    const newNode = {
      id: newId,
      kind: mutation.nodeKind === "condition" ? "condition" : "process",
      code: `新增 · ${current.revision + 1}`,
      title,
      shortSummary: cleanText(objective, 40),
      objective,
      features: [objective, hasUiPage ? "已挂载页面效果图确认门禁" : "自动接入上下游数据流"],
      inputContract: [`承接「${fromNode.title}」输出`],
      outputContract: [`确认后流向「${toNode.title}」`],
      boundaries: [hasUiPage ? "未确认页面效果图前阻断进入开发" : "异常时保留上游上下文"],
      acceptance: [`「${title}」流转正常且下游衔接无误`],
      status: "planned",
      column: insertCol,
      parallelGroup: null,
      hasUiPage,
      uiMockup,
      reacted: true,
    };
    newNode.subflow = buildDefaultSubflowForModule(newNode);
    current.nodes.splice(current.nodes.length - 1, 0, newNode);
    current.edges = current.edges.filter((e) => e.id !== edge.id);
    current.edges.push(
      { id: `wf_e_${newId}_in`, from: fromNode.id, to: newId, label: edge.label || "流转", kind: "normal" },
      { id: `wf_e_${newId}_out`, from: newId, to: toNode.id, label: hasUiPage ? "确认放行" : "完成流转", kind: "normal" },
    );
    const impacted = markDownstreamImpacted(current, newId);
    current.revision += 1;
    current.selectedNodeId = newId;
    current.lastMutationNote = `已实时插入节点「${title}」，联动更新下游 ${impacted.length} 个关联节点`;
  } else if (action === "add_parallel") {
    const hasUiPage = Boolean(mutation.hasUiPage);
    const title = cleanText(mutation.title, 80) || (hasUiPage ? "并行封面与视觉包装台" : "并行合规与风控审查");
    const objective = cleanText(mutation.objective, 300) || `与同级分支并发运行的${hasUiPage ? "可视化操作台（需先确认页面效果图）" : "自动化后台检查分支"}。`;
    const newId = `par_${randomUUID().slice(0, 8)}`;

    const existingParallel = current.nodes.filter((n) => n.kind === "parallel");
    const targetCol = Number.isInteger(mutation.column)
      ? mutation.column
      : (existingParallel[0]?.column ?? 1);

    const upstreamCandidates = current.nodes.filter((n) => n.column < targetCol);
    const downstreamCandidates = current.nodes.filter((n) => n.column > targetCol);
    const fromNode = current.nodes.find((n) => n.id === mutation.fromId)
      || upstreamCandidates.at(-1)
      || current.nodes[0];
    const toNode = current.nodes.find((n) => n.id === mutation.toId)
      || downstreamCandidates[0]
      || current.nodes.at(-1);

    let uiMockup = null;
    if (hasUiPage) {
      const gen = await generatePageEffectMockup({
        workflowStateDir,
        projectId,
        projectName: current.projectName,
        nodeId: newId,
        title,
        objective,
        features: [objective],
        version: 1,
        tryModelFirst: mutation.tryModelFirst !== false,
        environment,
        ...(execFileImpl && { execFileImpl }),
        ...(fetchImpl && { fetchImpl }),
      });
      uiMockup = { ...gen, status: "pending" };
    }

    const peerCount = current.nodes.filter((n) => n.column === targetCol && n.kind !== "terminal").length;
    for (const peer of current.nodes.filter((n) => n.column === targetCol && n.kind === "process")) {
      peer.kind = "parallel";
      if (!peer.code?.includes("并行")) peer.code = `${peer.code || "02"} · 并行`;
    }

    const newNode = {
      id: newId,
      kind: "parallel",
      code: `0${targetCol + 1}${String.fromCharCode(65 + peerCount)} · 并行`,
      title,
      shortSummary: cleanText(objective, 40),
      objective,
      features: [objective, "与同泳道节点并发执行并在下游路由汇聚"],
      inputContract: [`与同级分支共享「${fromNode.title}」输出`],
      outputContract: [`并发完成后汇入「${toNode.title}」`],
      boundaries: [hasUiPage ? "涉及前端界面，须先确认页面效果图" : "独立并发隔离，失败可单独重试"],
      acceptance: [`并行分支「${title}」正常汇入下游总检节点`],
      status: "planned",
      column: targetCol,
      parallelGroup: `lane_${targetCol}`,
      hasUiPage,
      uiMockup,
      reacted: true,
    };
    newNode.subflow = buildDefaultSubflowForModule(newNode);
    current.nodes.splice(current.nodes.length - 1, 0, newNode);
    current.edges.push(
      { id: `wf_ep_${newId}_in`, from: fromNode.id, to: newId, label: "并行分叉", kind: "parallel" },
      { id: `wf_ep_${newId}_out`, from: newId, to: toNode.id, label: "并行汇入", kind: "parallel" },
    );
    const impacted = markDownstreamImpacted(current, newId);
    current.revision += 1;
    current.selectedNodeId = newId;
    current.lastMutationNote = `已插入并行分支「${title}」（当前泳道 ${peerCount + 1} 路并发），下游 ${impacted.length} 个节点已同步标记复核`;
  } else if (action === "update_node") {
    const node = current.nodes.find((n) => n.id === mutation.nodeId && n.kind !== "terminal");
    if (!node) throw new Error("workflow_node_not_found");
    if (typeof mutation.title === "string" && cleanText(mutation.title, 80)) {
      node.title = cleanText(mutation.title, 80);
    }
    if (typeof mutation.objective === "string" && cleanText(mutation.objective, 400)) {
      node.objective = cleanText(mutation.objective, 400);
      node.shortSummary = cleanText(mutation.objective, 40);
    }
    if (typeof mutation.hasUiPage === "boolean" && mutation.hasUiPage !== node.hasUiPage) {
      node.hasUiPage = mutation.hasUiPage;
      if (node.hasUiPage && !node.uiMockup) {
        const gen = await generatePageEffectMockup({
          workflowStateDir,
          projectId,
          projectName: current.projectName,
          nodeId: node.id,
          title: node.title,
          objective: node.objective,
          features: node.features,
          version: 1,
          tryModelFirst: mutation.tryModelFirst !== false,
          environment,
          ...(execFileImpl && { execFileImpl }),
          ...(fetchImpl && { fetchImpl }),
        });
        node.uiMockup = { ...gen, status: "pending" };
      } else if (!node.hasUiPage) {
        node.uiMockup = null;
      }
    }
    node.reacted = true;
    node.subflow = buildDefaultSubflowForModule(node);
    const impacted = markDownstreamImpacted(current, node.id);
    current.revision += 1;
    current.selectedNodeId = node.id;
    current.lastMutationNote = `已更新节点「${node.title}」，下游 ${impacted.length} 个关联节点已实时响应`;
  } else if (action === "delete_node") {
    const businessCount = current.nodes.filter((n) => n.kind !== "terminal").length;
    if (businessCount <= 1) throw new Error("workflow_minimum_node_required");
    const target = current.nodes.find((n) => n.id === mutation.nodeId && n.kind !== "terminal");
    if (!target) throw new Error("workflow_node_not_found");
    const incoming = current.edges.filter((e) => e.to === target.id && e.kind !== "loop");
    const outgoing = current.edges.filter((e) => e.from === target.id && e.kind !== "loop");
    current.nodes = current.nodes.filter((n) => n.id !== target.id);
    current.edges = current.edges.filter((e) => e.from !== target.id && e.to !== target.id);
    for (const inc of incoming) {
      for (const out of outgoing) {
        if (inc.from !== out.to && !current.edges.some((e) => e.from === inc.from && e.to === out.to)) {
          current.edges.push({
            id: `wf_re_${randomUUID().slice(0, 6)}`,
            from: inc.from,
            to: out.to,
            label: "自动重连",
            kind: inc.kind === "parallel" || out.kind === "parallel" ? "parallel" : "normal",
          });
        }
      }
    }
    for (const out of outgoing) {
      const down = current.nodes.find((n) => n.id === out.to);
      if (down && down.kind !== "terminal") down.reacted = true;
    }
    current.revision += 1;
    current.selectedNodeId = current.nodes.find((n) => n.kind !== "terminal")?.id || "start";
    current.lastMutationNote = `已删除节点「${target.title}」并自动缝合上下游连线`;
  } else if (action === "generate_mockup" || action === "revise_mockup") {
    const node = current.nodes.find((n) => n.id === mutation.nodeId && n.kind !== "terminal");
    if (!node) throw new Error("workflow_node_not_found");
    node.hasUiPage = true;
    const nextVer = (node.uiMockup?.version || 0) + 1;
    const feedback = cleanText(mutation.feedback, 300);
    const gen = await generatePageEffectMockup({
      workflowStateDir,
      projectId,
      projectName: current.projectName,
      nodeId: node.id,
      title: node.title,
      objective: node.objective,
      features: node.features,
      feedback,
      version: nextVer,
      explicitVariant: node.uiMockup?.variant || "",
      tryModelFirst: mutation.tryModelFirst !== false,
      environment,
      ...(execFileImpl && { execFileImpl }),
      ...(fetchImpl && { fetchImpl }),
    });
    node.uiMockup = { ...gen, status: "pending" };
    node.reacted = true;
    markDownstreamImpacted(current, node.id);
    current.revision += 1;
    current.selectedNodeId = node.id;
    current.lastMutationNote = gen.mode === "model_image"
      ? `已通过模型（${gen.provider}）生成「${node.title}」效果图 v${nextVer}，请确认后放行`
      : `「${node.title}」已生成 v${nextVer} 结构化页面效果图（${gen.fallbackReason}）`;
  } else if (action === "confirm_mockup") {
    const node = current.nodes.find((n) => n.id === mutation.nodeId && n.kind !== "terminal");
    if (!node || !node.hasUiPage) throw new Error("workflow_ui_node_not_found");
    const nextStatus = mutation.confirmed === false ? "pending" : "confirmed";
    node.uiMockup = {
      ...(node.uiMockup || {
        version: 1,
        mode: "wireframe_fallback",
        variant: inferMockupVariant({ nodeId: node.id, title: node.title }),
        wireframeSpec: buildStructuredWireframeSpec({ title: node.title, objective: node.objective, version: 1 }),
      }),
      status: nextStatus,
    };
    node.reacted = false;
    current.revision += 1;
    current.selectedNodeId = node.id;
    current.lastMutationNote = nextStatus === "confirmed"
      ? `已确认「${node.title}」页面效果图 v${node.uiMockup.version}，开发门禁已放行`
      : `已撤回「${node.title}」效果图确认状态，恢复待确认拦截`;
  } else if (action === "save_positions" && mutation.positions && typeof mutation.positions === "object") {
    for (const [id, pt] of Object.entries(mutation.positions)) {
      if (!NODE_ID_RE.test(id) && id !== "start" && id !== "end") continue;
      const node = current.nodes.find((n) => n.id === id);
      if (node && Number.isFinite(pt?.x) && Number.isFinite(pt?.y)) {
        node.customPos = { x: Math.round(pt.x), y: Math.round(pt.y) };
      }
    }
  } else {
    throw new Error("unsupported_workflow_mutation");
  }

  writeCanvasState(workflowStateDir, current);
  return decorateSummary(current);
}

export function getPrdMockupImage({ projectRoot, profile = "default", imageId } = {}) {
  if (!projectRoot || !imageId) return null;
  try {
    const workflowStateDir = ensureWorkflowStateDir(projectRoot, profile);
    return readStoredMockupImage({ workflowStateDir, imageId });
  } catch {
    return null;
  }
}
