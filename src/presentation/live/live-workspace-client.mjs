import { LIVE_WORKSPACE_MESSAGES, serializeLiveWorkspaceModel, workspaceArtifactItems, workspaceMaterialIdentity, workspaceMaterialMatches, workspaceMaterialReady, workspaceCommandMessage } from "./live-workspace-model.mjs";
import { createLiveWorkspaceRenderer } from "./live-workspace-renderer.mjs";
import { createPrdKnowledgeGraph } from "./live-prd-knowledge-graph.mjs";

export const LIVE_WORKSPACE_UI_POLICY = Object.freeze({ pageSize: 50, refreshMs: 15000, requestTimeoutMs: 12000, refreshCoalesceMs: 1500, agentReceiptPollMs: 2500 });

/** Same-origin transport and view state only. The server owns decisions and progress. */
export function createLiveWorkspaceController(options) {
  const { app } = options;
  const root = app.querySelector("[data-uw-workspace]");
  if (!root) return null;
  const policy = options.policy;
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  const agentEntryEnabled = options.config?.agentEntryEnabled === true;
  const token = options.config?.controlHeader === "x-meta-kim-workspace-token" && typeof options.config?.controlToken === "string" && options.config.controlToken.length >= 16 ? options.config.controlToken : null;
  const emptyHistory = () => ({ rows: [], revision: null, total: null, nextCursor: null, loading: false, loaded: false, attempted: false, stale: false, error: null });
  const state = {
    view: "work", externalView: null, prdMode: "overview", prdDepth: 2, prdGraphLimit: 40, selectedModuleId: null, detail: null, opener: null,
    language: options.language(), snapshot: null, project: null, workspace: null, fallbackStages: [], origin: null,
    selection: {}, selectionKey: "", tasks: [], taskPage: 0, taskFilter: "all", query: "", moduleSearch: "", recordPage: 0, pageSize: policy.pageSize,
    loading: false, error: null, notice: "", material: null, command: null, history: emptyHistory(), drafts: new Map(), canWrite: options.config?.enabled === true && Boolean(token),
  };
  let generation = 0;
  let materialGeneration = 0;
  let workspaceInFlight = false;
  let refreshAgain = false;
  let queuedCursor = null;
  let queuedReloadCount = 0;
  let lastRefresh = 0;
  let disposed = false;
  const pendingControllers = new Set();
  const copy = (key) => LIVE_WORKSPACE_MESSAGES[state.language]?.[key] || LIVE_WORKSPACE_MESSAGES.en[key] || String(key || "");
  const agentForm = root.querySelector("[data-uw-agent-start]");
  const agentEntry = root.querySelector("[data-uw-agent-entry]");
  if (agentEntry) agentEntry.hidden = !agentEntryEnabled;
  if (root.dataset) root.dataset.agentEntryEnabled = String(agentEntryEnabled);
  const agentGoal = root.querySelector("[data-uw-agent-goal]");
  const agentHost = root.querySelector("[data-uw-agent-host]");
  const agentHostStatus = root.querySelector("[data-uw-agent-host-status]");
  const agentHostList = root.querySelector("[data-uw-agent-host-list]");
  const agentSubmit = root.querySelector("[data-uw-agent-submit]");
  const agentStatus = root.querySelector("[data-uw-agent-status]");
  const agentRecovery = root.querySelector("[data-uw-agent-recovery]");
  const agentVerify = root.querySelector("[data-uw-agent-verify]");
  const agentRedetect = root.querySelector("[data-uw-agent-redetect]");
  const agentNew = root.querySelector("[data-uw-agent-new]");
  const agentResult = root.querySelector("[data-uw-agent-result]");
  const agentOutput = root.querySelector("[data-uw-agent-output]");
  const agent = { hosts: [], executionAllowed: false, loading: false, busy: false, pending: null, status: "idle" };
  const route = (path, extra = {}, selection = state.selection) => {
    const url = new URL(path, win.location.origin);
    for (const [key, value] of Object.entries({ projectId: selection.projectId, runId: selection.runId, ...extra })) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    return url.href;
  };
  async function request(path, { method = "GET", body, query = {}, selection = state.selection } = {}) {
    const controller = new AbortController();
    pendingControllers.add(controller);
    const timer = win.setTimeout(() => controller.abort(), policy.requestTimeoutMs);
    try {
      const headers = { accept: "application/json" };
      if (token) headers["x-meta-kim-workspace-token"] = token;
      if (method !== "GET") headers["content-type"] = "application/json";
      const response = await win.fetch(route(path, query, selection), { method, headers, credentials: "same-origin", cache: "no-store", signal: controller.signal, ...(body ? { body: JSON.stringify(body) } : {}) });
      let payload;
      try { payload = await response.json(); } catch { payload = null; }
      if (!response.ok) { const error = new Error(payload?.error?.message || payload?.message || "Workspace request failed"); error.status = response.status; error.code = typeof payload?.error === "string" ? payload.error : payload?.error?.code; throw error; }
      return payload;
    } finally { win.clearTimeout(timer); pendingControllers.delete(controller); }
  }
  function agentMessage(kind, message, { verify = false, retry = false, redetect = false, next = false } = {}) {
    agent.status = kind;
    if (agentStatus) {
      agentStatus.hidden = !message;
      agentStatus.dataset.state = kind;
      agentStatus.textContent = message || "";
    }
    if (agentRecovery) agentRecovery.hidden = !(verify || retry || redetect || next);
    if (agentVerify) agentVerify.hidden = !verify;
    if (agentNew) agentNew.hidden = !next;
    if (agentRedetect) {
      agentRedetect.hidden = !(retry || redetect);
      agentRedetect.textContent = retry ? "重试同一请求" : "重新检测客户端";
      agentRedetect.dataset.action = retry ? "retry" : "redetect";
    }
    updateAgentControls();
  }
  function launchableHosts() {
    return agent.hosts.filter((host) => host.available === true && host.launchSupported === true);
  }
  function updateAgentControls() {
    const canLaunch = agentEntryEnabled && state.canWrite && agent.executionAllowed && !agent.loading && !agent.busy && !agent.pending
      && launchableHosts().some((host) => host.id === agentHost?.value);
    if (agentHost) agentHost.disabled = !agentEntryEnabled || !state.canWrite || !agent.executionAllowed || agent.loading || agent.busy || !launchableHosts().length;
    if (agentSubmit) {
      agentSubmit.disabled = !canLaunch || !agentGoal?.value?.trim();
      agentSubmit.setAttribute("aria-busy", agent.busy ? "true" : "false");
    }
  }
  function populateAgentHosts() {
    if (!agentHost) return;
    const previousHost = agentHost.value;
    const entries = agent.hosts.filter((host) => host && typeof host.id === "string" && host.id && typeof host.label === "string");
    agentHost.textContent = "";
    if (!entries.length) {
      const option = doc.createElement("option"); option.value = ""; option.textContent = "没有可用客户端"; agentHost.appendChild(option);
    } else {
      for (const host of entries) {
        const option = doc.createElement("option");
        option.value = host.id;
        option.textContent = host.label + (host.available === true && host.launchSupported === true ? "" : " · 不可启动");
        option.disabled = host.available !== true || host.launchSupported !== true;
        if (host.reason) option.title = String(host.reason);
        agentHost.appendChild(option);
      }
      const usable = launchableHosts();
      agentHost.value = usable.some((item) => item.id === previousHost) ? previousHost : usable[0]?.id || "";
    }
    if (agentHostStatus && agentHostList) {
      agentHostList.textContent = "";
      for (const host of entries) {
        const item = doc.createElement("li");
        const active = host.available === true && host.launchSupported === true;
        item.dataset.state = active ? "ready" : "unavailable";
        const status = typeof host.statusLabel === "string" && host.statusLabel.trim()
          ? host.statusLabel : active ? "可生成只读方案" : "暂不可启动";
        const action = typeof host.nextAction === "string" && host.nextAction.trim()
          ? ` · 下一步：${host.nextAction}` : "";
        item.textContent = `${host.label} · ${status}${action}`;
        agentHostList.appendChild(item);
      }
      agentHostStatus.hidden = entries.length === 0;
      // When no host can run, the reason is immediately visible without
      // relying on hover-only option titles (unavailable on touch screens).
      if (!launchableHosts().length) agentHostStatus.open = true;
    }
    updateAgentControls();
  }
  async function loadAgentHosts() {
    if (!agentEntryEnabled || !agentForm || disposed || agent.loading || agent.busy) return;
    if (!state.canWrite) {
      agent.hosts = []; agent.executionAllowed = false; populateAgentHosts();
      agentMessage("blocked", "此工作台尚未启用私有控制权限，暂时只能查看运行记录。");
      return;
    }
    agent.loading = true; updateAgentControls();
    if (!agent.pending) agentMessage("checking", "正在检查可启动的客户端…");
    try {
      const payload = await request("/api/agent/hosts", { selection: {} });
      if (disposed) return;
      if (payload?.schemaVersion !== "meta-kim-agent-hosts-v1" || !Array.isArray(payload.hosts) || typeof payload.executionAllowed !== "boolean") throw new Error("Client capability contract mismatch");
      agent.hosts = payload.hosts; agent.executionAllowed = payload.executionAllowed;
      populateAgentHosts();
      if (!agent.pending) {
        if (!agent.executionAllowed) agentMessage("blocked", "当前环境尚未开放客户端启动权限。可继续查看已有记录。");
        else if (!launchableHosts().length) agentMessage("blocked", "暂未找到可启动的客户端。请先打开已安装的客户端，再重新检测。", { redetect: true });
        else agentMessage("idle", "");
      }
    } catch {
      if (disposed) return;
      agent.hosts = []; agent.executionAllowed = false; populateAgentHosts();
      if (!agent.pending) agentMessage("unconfirmed", "客户端状态获取失败，请检查当前工作台连接后重试。", { redetect: true });
    } finally { agent.loading = false; updateAgentControls(); }
  }
  function showAgentReceipt(payload) {
    if (!agent.pending) return;
    const receiptStatus = payload?.status;
    if (payload?.capabilityState && typeof payload.capabilityState === "object") {
      agent.pending.capabilityState = payload.capabilityState;
    }
    const methodState = agent.pending.capabilityState;
    const methodNote = methodState?.status === "verified_local_method_bound" && methodState.methodProvidedToRuntime === true
      ? " · Kim_Service 专业方法已关联（来源已核验）" : "";
    const preview = receiptStatus === "completed" && typeof payload?.resultPreview === "string"
      ? payload.resultPreview.slice(0, 2400).trim() : "";
    if (agentResult) { agentResult.hidden = !preview; agentResult.open = Boolean(preview); }
    // Never render untrusted model output as HTML, even inside a local app.
    if (agentOutput) agentOutput.textContent = preview;
    if (payload?.runId && typeof payload.runId === "string") agent.pending.runId = payload.runId;
    if (receiptStatus === "accepted") {
      agentMessage("accepted", (agent.pending.runId ? "执行请求已接收，运行记录已建立。" : "已接单，等待客户端建立会话。") + methodNote, { verify: true });
    } else if (receiptStatus === "running") {
      agentMessage("running", (agent.pending.runId ? "客户端已确认开始运行，可在运行记录中查看进展。" : "客户端已确认开始运行，等待关联运行记录。") + methodNote, { verify: true });
    } else if (receiptStatus === "completed") {
      agentMessage("completed", preview
        ? "只读研究已返回建议，请核对后决定是否继续执行。" + methodNote
        : "只读研究已结束，但没有可展示的建议。完整任务尚未执行。", { verify: true, next: true });
    } else if (receiptStatus === "failed") {
      agentMessage("blocked", "客户端报告执行失败：" + (payload.reason || "请检查运行记录后重试。"));
      agent.pending = null;
    } else if (receiptStatus === "blocked" || receiptStatus === "unavailable") {
      agentMessage("blocked", payload.reason || "当前客户端无法接收此任务，请检查权限或切换客户端。", { redetect: true });
      agent.pending = null;
    } else {
      agentMessage("unconfirmed", "尚未查到这次提交的回执。为避免重复执行，请先检查；必要时使用同一请求号重试。", { verify: true, retry: true });
    }
    updateAgentControls();
  }
  async function verifyAgentRequest() {
    if (!agent.pending || agent.busy || disposed) return;
    agent.busy = true; updateAgentControls();
    try {
      const payload = await request("/api/agent/requests", { query: { idempotencyKey: agent.pending.key }, selection: {} });
      if (disposed || !agent.pending) return;
      if (payload?.schemaVersion !== "meta-kim-agent-request-v1" || !["unknown", "accepted", "running", "completed", "failed", "blocked"].includes(payload.status)) throw new Error("Request receipt contract mismatch");
      showAgentReceipt(payload);
    } catch {
      if (!disposed) agentMessage("unconfirmed", "暂时无法确认提交结果。请稍后检查，或使用同一请求号安全重试。", { verify: true, retry: true });
    } finally { agent.busy = false; updateAgentControls(); }
  }
  async function submitAgent({ retry = false } = {}) {
    if (!agentEntryEnabled || !agentForm || agent.busy || disposed || !state.canWrite || !agent.executionAllowed) return;
    let launch = agent.pending;
    if (!retry) {
      if (launch) return;
      const goal = agentGoal?.value?.trim() || "";
      const hostId = agentHost?.value || "";
      if (!goal || goal.length > 6000) { agentMessage("blocked", "请先描述你想完成的事情（最多 6000 字）。"); return; }
      if (!launchableHosts().some((host) => host.id === hostId)) { agentMessage("blocked", "请选择可以启动的客户端，或重新检测客户端。", { redetect: true }); return; }
      const key = win.crypto?.randomUUID?.();
      if (!key) { agentMessage("blocked", "当前浏览器无法生成安全请求号，请使用受支持的浏览器。 "); return; }
      launch = { key, goal, hostId, runId: null };
      agent.pending = launch;
      if (agentResult) agentResult.hidden = true;
      if (agentOutput) agentOutput.textContent = "";
    } else if (!launch) return;
    agent.busy = true;
    agentMessage("sending", retry ? "正在用原请求号重试…" : "正在提交，请稍候…");
    try {
      const payload = await request("/api/agent/start", {
        method: "POST", selection: {}, body: {
          goal: launch.goal, hostId: launch.hostId, idempotencyKey: launch.key,
        },
      });
      if (disposed || agent.pending !== launch) return;
      if (!payload || !["accepted", "blocked", "unavailable"].includes(payload.status) || typeof payload.requestId !== "string" || !payload.requestId) throw new Error("Agent submission receipt contract mismatch");
      if (payload.status === "accepted") showAgentReceipt(payload);
      else showAgentReceipt({ status: payload.status, reason: payload.reason || payload.nextAction });
    } catch (error) {
      if (disposed || agent.pending !== launch) return;
      if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
        const reasons = {
          400: "任务内容不符合要求，请检查描述后重试。",
          401: "当前授权已失效，请重新连接私有工作台。",
          403: "当前工作台无权启动客户端。",
          404: "此环境尚未开放一键启动服务。",
          409: "客户端当前有冲突任务，请先查看已有运行。",
          413: "任务描述超出服务端长度限制，请缩短后重试。",
          422: "任务描述或客户端选择无效，请修改后重试。",
        };
        agentMessage("blocked", reasons[error.status] || "请求被拒绝，请检查客户端状态后重试。", { redetect: [401, 403, 404, 409].includes(error.status) });
        agent.pending = null;
      } else {
        // A timed-out POST may already have reached the client. Never issue a
        // second POST with a fresh key before reconciling its original receipt.
        agentMessage("unconfirmed", "请求可能已送达，正在检查提交结果…", { verify: true });
        agent.busy = false;
        await verifyAgentRequest();
      }
    } finally { agent.busy = false; updateAgentControls(); }
  }
  function selectedArtifact() {
    const items = workspaceArtifactItems(state.workspace);
    return state.prdMode === "overview" ? items.find((item) => item.kind === "outline") : state.selectedModuleId
      ? items.find((item) => item.moduleId === state.selectedModuleId)
      : items.find((item) => item.kind === "module");
  }
  function updateLocation() {
    const url = new URL(win.location.href);
    url.searchParams.set("view", state.externalView || state.view);
    if (state.view === "prd") url.searchParams.set("prdView", state.prdMode); else url.searchParams.delete("prdView");
    if (state.view === "prd" && state.prdMode === "module") url.searchParams.set("prdDepth", String(state.prdDepth)); else url.searchParams.delete("prdDepth");
    if (state.selectedModuleId) url.searchParams.set("moduleId", state.selectedModuleId); else url.searchParams.delete("moduleId");
    win.history.replaceState(null, "", url.href);
  }
  function closeNavigation() {
    app.querySelector("[data-uw-navigation]")?.setAttribute("data-open", "false");
    app.querySelector("[data-uw-nav-open]")?.setAttribute("aria-expanded", "false");
  }
  function setView(view, { updateUrl = true } = {}) {
    if (["graph", "repository"].includes(view)) { state.externalView = view; options.showLegacyView(view === "graph" ? "run" : "repository"); }
    else {
      state.externalView = null; state.view = ["work", "prd", "records"].includes(view) ? view : "work";
      options.showLegacyView("workspace");
    }
    closeNavigation();
    if (updateUrl) updateLocation();
    renderer.render();
    if (!state.externalView) { void refresh(); ensureMaterial(); ensureRecords(); }
  }
  function selectModule(id) {
    state.selectedModuleId = id; state.prdMode = "module"; state.prdGraphLimit = 40; state.material = null; state.detail = null;
    setView("prd");
    renderer.content.scrollTop = 0;
  }
  function setPrdMode(mode) {
    state.prdMode = mode === "module" ? "module" : "overview";
    state.material = null; state.detail = null; materialGeneration += 1;
    updateLocation(); renderer.render(); ensureMaterial();
  }
  function setPrdDepth(level) {
    if (![1, 2, 3, "all"].includes(level)) return;
    state.prdDepth = level;
    updateLocation(); renderer.renderMain();
  }
  function openOverview() {
    state.prdMode = "overview"; state.prdGraphLimit = 40; state.detail = null; state.material = null;
    setView("prd");
  }
  function openDetail(detail, opener) {
    state.detail = detail; state.opener = opener;
    renderer.render();
    renderer.detailCloseButton?.focus({ preventScroll: true });
  }
  function closeDetail() {
    const previous = state.detail;
    state.detail = null; renderer.render();
    let opener = state.opener;
    if (!opener?.isConnected && previous) {
      const attribute = previous.kind === "task" ? "data-live-workspace-task" : "data-live-workspace-stage";
      opener = [...root.querySelectorAll("[" + attribute + "]")].find((node) => node.getAttribute(attribute) === previous.id);
    }
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    else renderer.content.focus({ preventScroll: true });
  }
  function ensureMaterial() {
    if (state.view !== "prd" || state.externalView) return;
    const item = selectedArtifact();
    if (item?.artifactId && (!state.material || state.material.identity !== workspaceMaterialIdentity(item))) void loadMaterial(item, false);
  }
  async function loadMaterial(item, append) {
    if (!item?.artifactId || state.material?.loading && state.material.identity === workspaceMaterialIdentity(item)) return;
    const currentGeneration = generation;
    const currentMaterialGeneration = ++materialGeneration;
    const identity = workspaceMaterialIdentity(item);
    const previous = append && state.material?.identity === identity ? state.material : null;
    state.material = { identity, text: previous?.text || "", format: previous?.format, loadedBytes: previous?.loadedBytes || 0, totalBytes: previous?.totalBytes, nextCursor: previous?.nextCursor, sha256: previous?.sha256, sourceState: previous?.sourceState, verified: previous?.verified === true, loading: true, error: null, conflict: false };
    renderer.renderMain();
    try {
      const page = await request("/api/workspace/material", { query: { artifactId: item.artifactId, version: item.version, cursor: previous?.nextCursor } });
      if (generation !== currentGeneration || materialGeneration !== currentMaterialGeneration || disposed) return;
      if (!workspaceMaterialMatches(item, page) || previous && previous.sha256 !== page.sha256) {
        state.material.loading = false; state.material.error = copy("materialSourceMismatch"); state.material.conflict = true; renderer.renderMain(); return;
      }
      state.material = { identity, text: (previous?.text || "") + page.text, format: page.format, loadedBytes: (previous?.loadedBytes || 0) + new TextEncoder().encode(page.text).byteLength, totalBytes: page.totalBytes, nextCursor: page.nextCursor, sha256: page.sha256, sourceState: page.sourceState, verified: true, loading: false, error: page.sourceState === "changed" ? copy("archivedSource") : null, conflict: false };
    } catch (error) {
      if (generation !== currentGeneration || materialGeneration !== currentMaterialGeneration || disposed) return;
      state.material.loading = false;
      state.material.conflict = error.status === 409;
      state.material.error = copy(error.status === 409 ? "materialConflict" : "loadUnavailable");
    }
    renderer.renderMain();
  }
  function ensureRecords() {
    if (state.view === "records" && !state.externalView && state.workspace?.available && !state.history.attempted) void loadRecords(false);
  }
  async function loadRecords(append = false) {
    const history = state.history;
    if (disposed || !state.selection.runId || state.origin === "demo" || history.loading || append && (!history.nextCursor || history.stale)) return;
    const requestGeneration = generation;
    history.loading = true; history.attempted = true; history.error = null; renderer.renderMain();
    try {
      const payload = await request("/api/workspace/requests", { query: { cursor: append ? history.nextCursor : null } });
      if (requestGeneration !== generation || disposed) return;
      if (payload?.schemaVersion !== "meta-kim-live-workspace-requests-v1" || payload.runId !== state.selection.runId
        || !Array.isArray(payload.requests) || !Number.isSafeInteger(payload.revision) || !Number.isSafeInteger(payload.total)
        || payload.total < payload.requests.length || payload.order !== "newest_first"
        || payload.requests.some((row) => typeof row.commandId !== "string" || !row.commandId)) throw new Error("Workspace request history contract mismatch");
      if (append && payload.revision !== history.revision) { history.stale = true; history.error = copy("recordsChanged"); return; }
      const rows = new Map((append ? history.rows : []).map((row) => [row.commandId, row]));
      for (const row of payload.requests) rows.set(row.commandId, row);
      state.history = { rows: [...rows.values()], revision: payload.revision, total: payload.total, nextCursor: payload.nextCursor || null,
        loading: false, loaded: true, attempted: true, stale: Number.isSafeInteger(state.workspace?.revision) && state.workspace.revision > payload.revision, error: null };
      if (!append) state.recordPage = 0;
    } catch (error) {
      if (requestGeneration !== generation || disposed) return;
      history.error = copy(error.status === 409 ? "recordsChanged" : "loadUnavailable");
      if (error.status === 409) history.stale = true;
    } finally {
      if (requestGeneration === generation) { state.history.loading = false; renderer.renderMain(); }
    }
  }
  async function refresh({ force = false, cursor = null, reloadCount = 0 } = {}) {
    if (disposed || !state.selection.runId || state.origin === "demo") return;
    if (workspaceInFlight) {
      refreshAgain = refreshAgain || force;
      if (cursor) queuedCursor = cursor;
      queuedReloadCount = Math.max(queuedReloadCount, reloadCount);
      return;
    }
    if (!force && Date.now() - lastRefresh < policy.refreshCoalesceMs) return;
    const requestGeneration = generation;
    let nextReload = null;
    workspaceInFlight = true; state.loading = true;
    if (!state.workspace) renderer.render();
    try {
      const payload = await request("/api/workspace", { query: { cursor } });
      if (requestGeneration !== generation || disposed) return;
      if (payload?.schemaVersion !== "meta-kim-live-workspace-v1" || payload.runId !== state.selection.runId || (state.selection.projectId && payload.projectId !== state.selection.projectId)) throw new Error("Workspace identity mismatch");
      if (![payload.stages, payload.reviews, payload.requests, payload.design?.modules].every(Array.isArray)) throw new Error("Workspace collection contract mismatch");
      if (["readyActions", "blockedActions"].some((key) => payload[key] !== undefined && !Array.isArray(payload[key]))) throw new Error("Workspace action collection contract mismatch");
      const invalidation = payload.design.materialInvalidation;
      if (invalidation !== undefined && (!invalidation || typeof invalidation.architecture !== "boolean"
        || !Array.isArray(invalidation.moduleIds) || invalidation.moduleIds.length > payload.design.totalModules
        || invalidation.moduleIds.some((id) => typeof id !== "string" || !id))) throw new Error("Workspace material invalidation contract mismatch");
      if (reloadCount > payload.design.modules.length && payload.design.nextCursor) {
        nextReload = { cursor: payload.design.nextCursor, reloadCount: reloadCount - payload.design.modules.length };
      }
      const previousWorkspace = state.workspace;
      if (cursor && previousWorkspace) {
        if (payload.revision !== previousWorkspace.revision || payload.design?.version !== previousWorkspace.design?.version) {
          state.notice = copy("conflict"); state.error = "conflict"; return;
        }
      }
      if (previousWorkspace && payload.revision === previousWorkspace.revision && payload.design?.version === previousWorkspace.design?.version) {
        const pageModuleIds = new Set(payload.design.modules.map((item) => item.id));
        for (const key of ["readyActions", "blockedActions"]) {
          if (Array.isArray(payload[key])) payload[key] = [
            ...(previousWorkspace[key] || []).filter((action) => action.moduleId && !pageModuleIds.has(action.moduleId)),
            ...payload[key],
          ];
        }
        const modules = new Map((previousWorkspace.design?.modules || []).map((item) => [item.id, item]));
        for (const module of payload.design?.modules || []) modules.set(module.id, module);
        const reviews = new Map((previousWorkspace.reviews || []).map((item) => [item.decisionId, item]));
        for (const review of payload.reviews || []) reviews.set(review.decisionId, review);
        payload.design = { ...payload.design, modules: [...modules.values()], nextCursor: cursor ? payload.design.nextCursor : previousWorkspace.design.nextCursor };
        payload.reviews = [...reviews.values()];
      }
      // The server checks all source material on every page. Apply its bounded
      // invalidation projection to cached pages without inventing readiness.
      if (invalidation) {
        const affectedModules = new Set(invalidation.moduleIds);
        const affectedArtifacts = new Set();
        if (invalidation.architecture && payload.design.architecture) {
          payload.design.architecture = { ...payload.design.architecture, status: "material_changed" };
          affectedArtifacts.add(payload.design.architecture.artifactId);
        }
        payload.design.modules = payload.design.modules.map((item) => {
          if (!invalidation.architecture && !affectedModules.has(item.id)) return item;
          affectedArtifacts.add(item.artifactId);
          return { ...item, status: "material_changed" };
        });
        if (Array.isArray(payload.readyActions)) payload.readyActions = payload.readyActions.filter((action) =>
          !invalidation.architecture && !(action.scope?.requiredModuleIds || [action.moduleId]).some((id) => affectedModules.has(id)));
        payload.reviews = payload.reviews.map((item) => affectedArtifacts.has(item.artifactId)
          ? { ...item, state: "material_changed", available: false, reason: "material_changed" } : item);
      }
      state.workspace = payload; state.error = null; state.loading = false; lastRefresh = Date.now();
      if (state.history.loaded && payload.revision !== state.history.revision) state.history.stale = true;
      const command = state.command;
      if (command?.awaitingRefresh && command.commandId) {
        const recorded = payload.requests.find((row) => row.commandId === command.commandId);
        if (recorded || Number.isSafeInteger(command.confirmedRevision) && payload.revision >= command.confirmedRevision) {
          command.awaitingRefresh = false;
          if (recorded) { command.status = recorded.status; command.message = copy(workspaceCommandMessage(recorded.status, command.kind)); }
          saveCommand();
        }
      }
      state.lastReadAt = lastRefresh;
      if (["governed_run", "acceptance_fixture", "demo"].includes(payload.source?.recordOrigin)) state.origin = payload.source.recordOrigin;
      if (state.prdMode === "module" && !state.selectedModuleId) state.selectedModuleId = payload.design?.modules?.[0]?.id || null;
      renderer.render(); ensureMaterial(); ensureRecords();
    } catch (error) {
      if (requestGeneration !== generation || disposed) return;
      state.error = error.status || "unavailable";
      if (error.status === 409) state.notice = copy("conflict");
    } finally {
      if (requestGeneration === generation) {
        workspaceInFlight = false; state.loading = false; renderer.render();
        const selectedModuleMissing = state.view === "prd" && state.prdMode === "module" && state.selectedModuleId
          && !(state.workspace?.design?.modules || []).some((item) => item.id === state.selectedModuleId);
        if (queuedReloadCount) {
          const reloadCount = queuedReloadCount; queuedReloadCount = 0; refreshAgain = false;
          void refresh({ force: true, reloadCount });
        }
        else if (nextReload && !state.error) void refresh({ force: true, ...nextReload });
        else if (queuedCursor) { const cursor = queuedCursor; queuedCursor = null; refreshAgain = false; void refresh({ force: true, cursor }); }
        else if (selectedModuleMissing && state.workspace?.design?.nextCursor && !state.error) void refresh({ force: true, cursor: state.workspace.design.nextCursor });
        else if (refreshAgain) { refreshAgain = false; void refresh({ force: true }); }
      }
    }
  }
  function commandStorageKey() { return "meta-kim-workspace-pending:" + state.selectionKey; }
  function saveCommand() {
    try {
      if (state.command) win.sessionStorage?.setItem(commandStorageKey(), JSON.stringify(state.command));
      else win.sessionStorage?.removeItem(commandStorageKey());
    } catch {}
  }
  async function verifyCommand(command = state.command) {
    if (!command || command.busy) return;
    const requestGeneration = generation;
    command.busy = true; renderer.renderMain();
    try {
      const payload = await request("/api/workspace/requests", { query: command.commandId ? { commandId: command.commandId } : { nonce: command.nonce } });
      if (requestGeneration !== generation || disposed) return;
      const record = (payload?.requests || []).find((row) => row.nonce === command.nonce || command.commandId && row.commandId === command.commandId);
      if (record) { command.status = record.status; command.commandId = record.commandId; command.message = copy(workspaceCommandMessage(record.status, command.kind)); command.awaitingRefresh = true; command.confirmedRevision = Number.isSafeInteger(payload.revision) ? payload.revision : null; }
      else { command.status = "pending_verification"; command.message = copy("notFoundReceipt"); }
    } catch {
      if (requestGeneration !== generation || disposed) return;
      command.status = "pending_verification"; command.message = copy("uncertain");
    } finally {
      if (requestGeneration === generation) { command.busy = false; saveCommand(); renderer.render(); void refresh({ force: true }); }
    }
  }
  async function submit(kind, item, fields) {
    if (!state.canWrite || state.command?.busy || state.command?.awaitingRefresh) return;
    if (state.command && ["pending_verification", "in_doubt"].includes(state.command.status)) { await verifyCommand(); return; }
    const capability = state.workspace?.capabilities?.[kind];
    if (capability?.available !== true) { state.notice = capability?.reason || copy("readOnly"); renderer.render(); return; }
    const nonce = win.crypto?.randomUUID?.();
    if (!nonce) { state.notice = copy("requestRejected"); renderer.render(); return; }
    const requestGeneration = generation;
    const command = { nonce, commandId: null, kind, status: "pending_verification", busy: true, targetIdentity: workspaceMaterialIdentity(item), message: copy("sending") };
    state.command = command; saveCommand(); renderer.renderMain();
    try {
      const payload = await request(kind === "review" ? "/api/workspace/reviews" : "/api/workspace/feedback", {
        method: "POST", body: { runId: state.selection.runId, expectedWorkspaceRevision: state.workspace.revision, artifactId: item.artifactId, version: item.version, nonce, ...fields },
      });
      if (requestGeneration !== generation || disposed) return;
      if (!payload?.commandId || payload.nonce !== nonce || !["recorded", "waiting_host"].includes(payload.status)) {
        command.status = "pending_verification"; command.message = copy("uncertain");
      } else { command.commandId = payload.commandId; command.status = payload.status; command.message = copy(workspaceCommandMessage(payload.status, kind)); command.awaitingRefresh = true; }
    } catch (error) {
      if (requestGeneration !== generation || disposed) return;
      if (error.status === 409) { command.status = "conflict"; command.message = copy("conflict"); state.notice = command.message; }
      else if (error.status >= 400 && error.status < 500) { command.status = "rejected"; command.message = copy(["workspace_request_capacity_reached", "workspace_review_capacity_reached"].includes(error.code) ? "requestCapacity" : error.status === 413 ? "requestTooLarge" : "requestRejected"); }
      else { command.status = "pending_verification"; command.message = copy("uncertain"); }
    } finally {
      if (requestGeneration === generation) {
        command.busy = false; saveCommand(); renderer.render();
        if (command.status === "pending_verification") void verifyCommand(command);
        else void refresh({ force: true });
      }
    }
  }
  const actions = {
    selectModule, setPrdMode, setPrdDepth, openOverview, openDetail, closeDetail, loadMaterial, loadRecords,
    expandPrdGraph: () => { state.prdGraphLimit = Math.min(2000, state.prdGraphLimit + 40); renderer.renderMain(); },
    openRecords: () => setView("records"),
    openNextAction: (action) => {
      if (action.moduleId) selectModule(action.moduleId);
      else if (action.kind === "continue_governed_run") setView("records");
      else { state.prdMode = "overview"; state.material = null; setView("prd"); }
    },
    loadModules: () => refresh({ force: true, cursor: state.workspace?.design?.nextCursor }),
    verifyCommand: () => verifyCommand(),
    openGraph: (nodeId) => { state.externalView = "graph"; updateLocation(); options.openGraph(nodeId); renderer.render(); },
    review: (review, item, choice) => {
      if (review.state !== "awaiting_human" || review.available === false) return;
      if (!workspaceMaterialReady(item, state.material)) { state.notice = copy("materialUnread"); renderer.render(); return; }
      void submit("review", item, { decisionId: review.decisionId, expectedRevision: review.revision, choice });
    },
    feedback: (item, original) => {
      if (!workspaceMaterialReady(item, state.material)) { state.notice = copy("materialUnread"); renderer.render(); return; }
      if (!original.trim()) { state.notice = copy("inputRequired"); renderer.render(); return; }
      void submit("feedback", item, { moduleId: item.moduleId || null, original });
    },
  };
  const renderer = createLiveWorkspaceRenderer({ app, root, state, copy, actions, taskOutputs: options.taskOutputs });
  agentForm?.addEventListener("submit", (event) => { event.preventDefault(); void submitAgent(); });
  agentGoal?.addEventListener("input", updateAgentControls);
  agentHost?.addEventListener("change", updateAgentControls);
  agentVerify?.addEventListener("click", () => { void verifyAgentRequest(); });
  agentRedetect?.addEventListener("click", () => {
    if (agentRedetect?.dataset.action === "retry") void submitAgent({ retry: true });
    else void loadAgentHosts();
  });
  agentNew?.addEventListener("click", () => {
    // An accepted or running native request still owns the only active
    // receipt. Dropping its key stops polling and strands the user mid-task.
    if (agent.busy || !agent.pending || agent.status !== "completed") return;
    if (agentGoal?.value?.trim() === agent.pending.goal) agentGoal.value = "";
    agent.pending = null;
    if (agentResult) agentResult.hidden = true;
    if (agentOutput) agentOutput.textContent = "";
    agentMessage("idle", "");
    agentGoal?.focus();
  });
  app.querySelectorAll("[data-uw-view]").forEach((node) => node.addEventListener("click", () => setView(node.dataset.uwView)));
  app.querySelector("[data-uw-project-switch]")?.addEventListener("click", options.openProjects);
  app.querySelector("[data-uw-nav-open]")?.addEventListener("click", () => { app.querySelector("[data-uw-navigation]")?.setAttribute("data-open", "true"); app.querySelector("[data-uw-nav-open]")?.setAttribute("aria-expanded", "true"); app.querySelector("[data-uw-nav-close]")?.focus(); });
  app.querySelector("[data-uw-nav-close]")?.addEventListener("click", () => { closeNavigation(); app.querySelector("[data-uw-nav-open]")?.focus(); });
  root.querySelector("[data-uw-refresh]")?.addEventListener("click", () => {
    state.notice = "";
    // Explicit refresh re-reads the pages already opened by this user. Polling
    // stays bounded to one page; no decision or readiness cache is added.
    void refresh({ force: true, reloadCount: state.workspace?.design?.modules?.length || 0 });
  });
  renderer.detailCloseButton?.addEventListener("click", closeDetail);
  const onKey = (event) => {
    if (event.key !== "Escape") return;
    if (state.detail && !state.externalView) { event.preventDefault(); closeDetail(); }
    else if (app.querySelector('[data-uw-navigation][data-open="true"]')) { event.preventDefault(); closeNavigation(); app.querySelector("[data-uw-nav-open]")?.focus(); }
  };
  doc.addEventListener("keydown", onKey);
  const initial = new URL(win.location.href);
  const requestedView = initial.searchParams.get("view");
  state.view = ["work", "prd", "records"].includes(requestedView) ? requestedView : "work";
  state.externalView = ["graph", "repository"].includes(requestedView) ? requestedView : null;
  state.prdMode = initial.searchParams.get("prdView") === "module" ? "module" : "overview";
  const requestedDepth = initial.searchParams.get("prdDepth");
  state.prdDepth = requestedDepth === "all" ? "all" : ["1", "2", "3"].includes(requestedDepth) ? Number(requestedDepth) : 2;
  state.selectedModuleId = initial.searchParams.get("moduleId");
  const interval = win.setInterval(() => { if (doc.visibilityState === "visible" && !state.externalView) void refresh({ force: true }); }, policy.refreshMs);
  // The intake is a real native request, so reflect its status without making
  // the user click "check" repeatedly. Stop polling after any terminal state.
  const agentInterval = agentEntryEnabled ? win.setInterval(() => {
    if (!disposed && doc.visibilityState === "visible" && agent.pending && !agent.busy
      && ["accepted", "running"].includes(agent.status)) void verifyAgentRequest();
  }, policy.agentReceiptPollMs) : null;
  renderer.render();
  void loadAgentHosts();
  return {
    initialView: state.externalView === "graph" ? "run" : state.externalView === "repository" ? "repository" : "workspace",
    update({ snapshot, project, selection, tasks, fallbackStages, origin }) {
      const key = [selection.projectId || "", selection.runId || ""].join("\u001f");
      const changed = key !== state.selectionKey;
      if (changed) {
        generation += 1; materialGeneration += 1;
        for (const controller of pendingControllers) controller.abort();
        state.workspace = null; state.material = null; state.detail = null; state.error = null; state.notice = ""; state.loading = false; state.history = emptyHistory(); state.recordPage = 0;
        workspaceInFlight = false; refreshAgain = false; queuedCursor = null; queuedReloadCount = 0; lastRefresh = 0;
        state.selectionKey = key; state.selection = selection; state.command = null;
        try { const saved = JSON.parse(win.sessionStorage?.getItem(commandStorageKey()) || "null"); if (saved?.nonce && saved?.targetIdentity) state.command = { ...saved, busy: false }; } catch {}
      }
      state.snapshot = snapshot; state.project = project; state.selection = selection; state.tasks = tasks || []; state.fallbackStages = fallbackStages || []; state.origin = state.workspace?.source?.recordOrigin || origin;
      state.language = options.language();
      renderer.render();
      if (!state.externalView || changed) void refresh({ force: changed });
      ensureMaterial(); ensureRecords();
    },
    show(view) { state.externalView = view === "run" ? "graph" : view === "repository" ? "repository" : null; renderer.render(); },
    dispose() { disposed = true; win.clearInterval(interval); if (agentInterval !== null) win.clearInterval(agentInterval); doc.removeEventListener("keydown", onKey); for (const controller of pendingControllers) controller.abort(); },
  };
}

export function serializeLiveWorkspaceClient() {
  return `${serializeLiveWorkspaceModel()}\nconst LIVE_WORKSPACE_UI_POLICY = ${JSON.stringify(LIVE_WORKSPACE_UI_POLICY)};\n${createPrdKnowledgeGraph.toString()}\n${createLiveWorkspaceRenderer.toString()}\n${createLiveWorkspaceController.toString()}`;
}
