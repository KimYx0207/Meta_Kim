import { LIVE_WORKSPACE_MESSAGES, serializeLiveWorkspaceModel, workspaceArtifactItems, workspaceMaterialIdentity, workspaceMaterialMatches, workspaceMaterialReady, workspaceCommandMessage } from "./live-workspace-model.mjs";
import { createLiveWorkspaceRenderer } from "./live-workspace-renderer.mjs";

export const LIVE_WORKSPACE_UI_POLICY = Object.freeze({ pageSize: 50, refreshMs: 15000, requestTimeoutMs: 12000, refreshCoalesceMs: 1500 });

/** Same-origin transport and view state only. The server owns decisions and progress. */
export function createLiveWorkspaceController(options) {
  const { app } = options;
  const root = app.querySelector("[data-uw-workspace]");
  if (!root) return null;
  const policy = options.policy;
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  const token = options.config?.controlHeader === "x-meta-kim-workspace-token" && typeof options.config?.controlToken === "string" && options.config.controlToken.length >= 16 ? options.config.controlToken : null;
  const emptyHistory = () => ({ rows: [], revision: null, total: null, nextCursor: null, loading: false, loaded: false, attempted: false, stale: false, error: null });
  const state = {
    view: "work", externalView: null, prdMode: "overview", selectedModuleId: null, detail: null, opener: null,
    language: options.language(), snapshot: null, project: null, workspace: null, fallbackStages: [], origin: null,
    selection: {}, selectionKey: "", tasks: [], taskPage: 0, taskFilter: "all", query: "", recordPage: 0, pageSize: policy.pageSize,
    loading: false, error: null, notice: "", material: null, command: null, history: emptyHistory(), drafts: new Map(), canWrite: options.config?.enabled === true && Boolean(token),
  };
  let generation = 0;
  let materialGeneration = 0;
  let workspaceInFlight = false;
  let refreshAgain = false;
  let queuedCursor = null;
  let lastRefresh = 0;
  let disposed = false;
  const pendingControllers = new Set();
  const copy = (key) => LIVE_WORKSPACE_MESSAGES[state.language]?.[key] || LIVE_WORKSPACE_MESSAGES.en[key] || String(key || "");
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
    state.selectedModuleId = id; state.prdMode = "module"; state.material = null; state.detail = null;
    setView("prd");
    renderer.content.scrollTop = 0;
  }
  function setPrdMode(mode) {
    state.prdMode = mode === "module" ? "module" : "overview";
    state.material = null; state.detail = null; materialGeneration += 1;
    updateLocation(); renderer.render(); ensureMaterial();
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
    state.material = { identity, text: previous?.text || "", loadedBytes: previous?.loadedBytes || 0, totalBytes: previous?.totalBytes, nextCursor: previous?.nextCursor, sha256: previous?.sha256, sourceState: previous?.sourceState, verified: previous?.verified === true, loading: true, error: null, conflict: false };
    renderer.renderMain();
    try {
      const page = await request("/api/workspace/material", { query: { artifactId: item.artifactId, version: item.version, cursor: previous?.nextCursor } });
      if (generation !== currentGeneration || materialGeneration !== currentMaterialGeneration || disposed) return;
      if (!workspaceMaterialMatches(item, page) || previous && previous.sha256 !== page.sha256) {
        state.material.loading = false; state.material.error = copy("materialSourceMismatch"); state.material.conflict = true; renderer.renderMain(); return;
      }
      state.material = { identity, text: (previous?.text || "") + page.text, loadedBytes: (previous?.loadedBytes || 0) + new TextEncoder().encode(page.text).byteLength, totalBytes: page.totalBytes, nextCursor: page.nextCursor, sha256: page.sha256, sourceState: page.sourceState, verified: true, loading: false, error: page.sourceState === "changed" ? copy("archivedSource") : null, conflict: false };
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
  async function refresh({ force = false, cursor = null } = {}) {
    if (disposed || !state.selection.runId || state.origin === "demo") return;
    if (workspaceInFlight) { refreshAgain = refreshAgain || force; if (cursor) queuedCursor = cursor; return; }
    if (!force && Date.now() - lastRefresh < policy.refreshCoalesceMs) return;
    const requestGeneration = generation;
    workspaceInFlight = true; state.loading = true;
    if (!state.workspace) renderer.render();
    try {
      const payload = await request("/api/workspace", { query: { cursor } });
      if (requestGeneration !== generation || disposed) return;
      if (payload?.schemaVersion !== "meta-kim-live-workspace-v1" || payload.runId !== state.selection.runId || (state.selection.projectId && payload.projectId !== state.selection.projectId)) throw new Error("Workspace identity mismatch");
      if (![payload.stages, payload.reviews, payload.requests, payload.design?.modules].every(Array.isArray)) throw new Error("Workspace collection contract mismatch");
      const previousWorkspace = state.workspace;
      if (cursor && previousWorkspace) {
        if (payload.revision !== previousWorkspace.revision || payload.design?.version !== previousWorkspace.design?.version) {
          state.notice = copy("conflict"); state.error = "conflict"; return;
        }
      }
      if (previousWorkspace && payload.revision === previousWorkspace.revision && payload.design?.version === previousWorkspace.design?.version) {
        const modules = new Map((previousWorkspace.design?.modules || []).map((item) => [item.id, item]));
        for (const module of payload.design?.modules || []) modules.set(module.id, module);
        const reviews = new Map((previousWorkspace.reviews || []).map((item) => [item.decisionId, item]));
        for (const review of payload.reviews || []) reviews.set(review.decisionId, review);
        payload.design = { ...payload.design, modules: [...modules.values()], nextCursor: cursor ? payload.design.nextCursor : previousWorkspace.design.nextCursor };
        payload.reviews = [...reviews.values()];
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
        if (queuedCursor) { const cursor = queuedCursor; queuedCursor = null; refreshAgain = false; void refresh({ force: true, cursor }); }
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
    selectModule, setPrdMode, openDetail, closeDetail, loadMaterial, loadRecords,
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
  app.querySelectorAll("[data-uw-view]").forEach((node) => node.addEventListener("click", () => setView(node.dataset.uwView)));
  app.querySelector("[data-uw-project-switch]")?.addEventListener("click", options.openProjects);
  app.querySelector("[data-uw-nav-open]")?.addEventListener("click", () => { app.querySelector("[data-uw-navigation]")?.setAttribute("data-open", "true"); app.querySelector("[data-uw-nav-open]")?.setAttribute("aria-expanded", "true"); app.querySelector("[data-uw-nav-close]")?.focus(); });
  app.querySelector("[data-uw-nav-close]")?.addEventListener("click", () => { closeNavigation(); app.querySelector("[data-uw-nav-open]")?.focus(); });
  root.querySelector("[data-uw-refresh]")?.addEventListener("click", () => { state.notice = ""; void refresh({ force: true }); });
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
  state.selectedModuleId = initial.searchParams.get("moduleId");
  const interval = win.setInterval(() => { if (doc.visibilityState === "visible" && !state.externalView) void refresh({ force: true }); }, policy.refreshMs);
  renderer.render();
  return {
    initialView: state.externalView === "graph" ? "run" : state.externalView === "repository" ? "repository" : "workspace",
    update({ snapshot, project, selection, tasks, fallbackStages, origin }) {
      const key = [selection.projectId || "", selection.runId || ""].join("\u001f");
      const changed = key !== state.selectionKey;
      if (changed) {
        generation += 1; materialGeneration += 1;
        for (const controller of pendingControllers) controller.abort();
        state.workspace = null; state.material = null; state.detail = null; state.error = null; state.notice = ""; state.loading = false; state.history = emptyHistory(); state.recordPage = 0;
        workspaceInFlight = false; refreshAgain = false; queuedCursor = null; lastRefresh = 0;
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
    dispose() { disposed = true; win.clearInterval(interval); doc.removeEventListener("keydown", onKey); for (const controller of pendingControllers) controller.abort(); },
  };
}

export function serializeLiveWorkspaceClient() {
  return `${serializeLiveWorkspaceModel()}\nconst LIVE_WORKSPACE_UI_POLICY = ${JSON.stringify(LIVE_WORKSPACE_UI_POLICY)};\n${createLiveWorkspaceRenderer.toString()}\n${createLiveWorkspaceController.toString()}`;
}
