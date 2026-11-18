import { LIVE_WORKSPACE_MESSAGES, serializeLiveWorkspaceModel, workspaceArtifactItems, workspaceMaterialIdentity, workspaceMaterialMatches, workspaceMaterialReady, workspaceCommandMessage, buildLivePrdGraph } from "./live-workspace-model.mjs";
import { createLiveWorkspaceRenderer, projectLiveUserPhases } from "./live-workspace-renderer.mjs";
import { createPrdKnowledgeGraph } from "./live-prd-knowledge-graph.mjs";
import { createDynamicPrdWorkflowCanvas } from "./live-prd-workflow-canvas.mjs";
import { createUnifiedAgentDesktop } from "./live-agent-desktop.mjs";
import { serializeLiveAgentCopy, translateAgentUi } from "./live-agent-copy.mjs";

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
    language: options.language(), snapshot: null, project: null, agentServerProjectLabel: null, workspace: null, fallbackStages: [], origin: null,
    selection: {}, selectionKey: "", tasks: [], capabilityCatalog: null, capabilityCatalogError: null, taskPage: 0, taskFilter: "all", query: "", moduleSearch: "", recordPage: 0, pageSize: policy.pageSize,
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
  let capabilityCatalogRead = null;
  let capabilityCatalogLastRead = 0;
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
  const chatHostSelect = root.querySelector("[data-uw-chat-host]");
  const chatSwitchRepoBtn = root.querySelector("[data-uw-chat-switch-repo]");
  const agentSubmit = root.querySelector("[data-uw-agent-submit]");
  const agentStatus = root.querySelector("[data-uw-agent-status]");
  const agentRecovery = root.querySelector("[data-uw-agent-recovery]");
  const agentVerify = root.querySelector("[data-uw-agent-verify]");
  const agentRedetect = root.querySelector("[data-uw-agent-redetect]");
  const agentNew = root.querySelector("[data-uw-agent-new]");
  const agentResult = root.querySelector("[data-uw-agent-result]");
  const agentOutput = root.querySelector("[data-uw-agent-output]");
  const agentRaw = root.querySelector("[data-uw-agent-raw]");
  const agentOptions = root.querySelector("[data-uw-agent-options]");
  const agentResultSummary = root.querySelector("[data-uw-agent-result-summary]");
  const agentScope = root.querySelector("[data-uw-agent-scope]");
  const agentScopeNote = root.querySelector("[data-uw-agent-scope-note]");
  const agentDecision = root.querySelector("[data-uw-agent-decision]");
  const agentFeedback = root.querySelector("[data-uw-agent-feedback]");
  const agentStrategy = root.querySelector("[data-uw-agent-strategy]");
  const agentChoiceReason = root.querySelector("[data-uw-agent-choice-reason]");
  const agentAdopt = root.querySelector("[data-uw-agent-adopt]");
  const agentRevise = root.querySelector("[data-uw-agent-revise]");
  const agentReject = root.querySelector("[data-uw-agent-reject]");
  const agentDecisionReceipt = root.querySelector("[data-uw-agent-decision-receipt]");
  const agentDecisionRetry = root.querySelector("[data-uw-agent-decision-reconcile]");
  const agentDesign = root.querySelector("[data-uw-agent-design]");
  const agentDesignBody = root.querySelector("[data-uw-agent-design-body]");
  const agentDesignStatus = root.querySelector("[data-uw-agent-design-status]");
  const agentDesignRefresh = root.querySelector("[data-uw-agent-design-refresh]");
  const agentDraft = root.querySelector("[data-uw-agent-draft]");
  const agentDraftStatus = root.querySelector("[data-uw-agent-draft-status]");
  const agentDraftGenerate = root.querySelector("[data-uw-agent-draft-generate]");
  const agentDraftManual = root.querySelector("[data-uw-agent-draft-manual]");
  const agentDraftReconcile = root.querySelector("[data-uw-agent-draft-reconcile]");
  const agentHandoff = root.querySelector("[data-uw-agent-transfer]");
  const agentHandoffStatus = root.querySelector("[data-uw-agent-transfer-status]");
  const agentHandoffCheck = root.querySelector("[data-uw-agent-transfer-check]");
  const agentHandoffPrepare = root.querySelector("[data-uw-agent-transfer-prepare]");
  const agentHandoffReconcile = root.querySelector("[data-uw-agent-transfer-reconcile]");
  const agentHandoffReceipt = root.querySelector("[data-uw-agent-transfer-receipt]");
  const agentExecution = root.querySelector("[data-uw-agent-execution]");
  const agentExecutionStatus = root.querySelector("[data-uw-agent-execution-status]");
  const agentExecutionEvidence = root.querySelector("[data-uw-agent-execution-evidence]");
  const agentExecutionRecords = root.querySelector("[data-uw-agent-execution-records]");
  const agentExecutionAuthorize = root.querySelector("[data-uw-agent-execution-authorize]");
  const agentExecutionCheck = root.querySelector("[data-uw-agent-execution-check]");
  const agentExecutionNative = root.querySelector("[data-uw-agent-execution-native]");

  const agentAcceptance = root.querySelector("[data-uw-agent-acceptance]");
  const agentAcceptanceStatus = root.querySelector("[data-uw-agent-acceptance-status]");
  const agentAcceptanceEvidence = root.querySelector("[data-uw-agent-acceptance-evidence]");
  const agentStorageKey = "meta-kim-agent-planning:v1";
  const agent = { hosts: [], executionAllowed: false, loading: false, busy: false, pending: null, status: "idle", executionScope: null,
    scopeMismatch: false, decisionBusy: false, decisionPending: null, recommendedHostId: null, hostRetryCount: 0, hostRetryTimer: null };
  const design = { loading: false, busy: false, snapshot: null, draft: null, editTarget: null, error: null, stale: false, pendingMutation: null };
  const nativeDraft = { loading: false, busy: false, snapshot: null, error: null, pendingKey: null, autoAttempted: false,
    editorVisible: false, manualOverride: false, sourceApplied: false };
  const handoff = { loading: false, busy: false, snapshot: null, error: null, pendingKey: null };
  const execution = { loading: false, busy: false, snapshot: null, error: null, pendingKey: null };
  const acceptance = { loading: false, busy: false, snapshot: null, error: null, pendingKey: null };

  let desktop = null;
  function saveAgent() {
    if (!agentEntryEnabled) return;
    try {
      if (agent.pending) win.sessionStorage?.setItem(agentStorageKey, JSON.stringify({ pending: agent.pending, decisionPending: agent.decisionPending,
        designPendingMutation: design.pendingMutation, draftPendingKey: nativeDraft.pendingKey, handoffPendingKey: handoff.pendingKey,
        executionPendingKey: execution.pendingKey }));

      else win.sessionStorage?.removeItem(agentStorageKey);
    } catch { /* Session storage is optional; server receipts remain authoritative. */ }
  }
  if (agentEntryEnabled) {
    try {
      const saved = JSON.parse(win.sessionStorage?.getItem(agentStorageKey) || "null");
      // A localhost tab may later be served by a different project root. A
      // prior request without a server-bound fingerprint is not recoverable.
      if (saved?.pending?.key && saved.pending.hostId && saved.pending.goal && saved.pending.goal.length <= 6000
        && /^[a-f0-9]{64}$/iu.test(saved.pending.projectFingerprint || "")) {
        agent.pending = saved.pending;
        agent.decisionPending = saved.decisionPending?.key && saved.decisionPending.planDigest ? saved.decisionPending : null;
        design.pendingMutation = saved.designPendingMutation?.mutationKey ? saved.designPendingMutation : null;
        nativeDraft.pendingKey = saved.draftPendingKey?.key && typeof saved.draftPendingKey.key === "string" ? saved.draftPendingKey : null;
        handoff.pendingKey = saved.handoffPendingKey?.key && Number.isSafeInteger(saved.handoffPendingKey.designVersion)
          && /^[a-f0-9]{64}$/iu.test(saved.handoffPendingKey.designDigest || "") ? saved.handoffPendingKey : null;
        execution.pendingKey = saved.executionPendingKey?.key
          && /^[a-f0-9]{64}$/iu.test(saved.executionPendingKey.handoffDigest || "")
          ? saved.executionPendingKey : null;

        if (agentGoal) agentGoal.value = saved.pending.goal;
        agent.status = "unconfirmed";
      }
      else if (saved) win.sessionStorage?.removeItem(agentStorageKey);
    } catch { /* A corrupt or old record never enables an action. */ }
  }
  const route = (path, extra = {}, selection = state.selection) => {
    const url = new URL(path, win.location.origin);
    for (const [key, value] of Object.entries({ projectId: selection.projectId, runId: selection.runId, ...extra })) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    return url.href;
  };
  async function request(path, { method = "GET", body, query = {}, selection = state.selection, runScoped = !path.startsWith("/api/agent/") } = {}) {
    const controller = new AbortController();
    if (runScoped) pendingControllers.add(controller);
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
  let architectureRead = null;
  let architectureLastRead = 0;
  let architectureProjectId = "";
  const isEphemeralProjectName = (name) => /^(?:\d{10,}-[a-f0-9-]{8,}|draft-[a-f0-9-]{8,}|tmp\.|L\d{2}-[A-Za-z0-9]{4,}|probe-|meta-kim-agent-project-|metakim-|mk-spine-|conv-binding-)/iu.test(String(name || ""));

  function enhanceRepositorySurface() {
    const repoView = app.querySelector("[data-live-repository-view]");
    const factsHost = repoView?.querySelector("[data-live-repository-facts]");
    const repoTitle = repoView?.querySelector("[data-live-repository-title]");
    const repoBoundary = repoView?.querySelector("[data-live-repository-boundary]");
    if (!repoView || !factsHost) return;
    const facts = state.repositoryFacts;
    const activeProj = state.project;
    if (repoTitle && (activeProj?.displayName || facts?.projectName)) {
      repoTitle.textContent = activeProj?.displayName || facts?.projectName;
    }
    if (repoBoundary && facts) {
      repoBoundary.textContent = facts.isExecutionBoundRepo
        ? "当前启动绑定仓库 · 支持对话研究、B1–B4 执行与双向会话接入"
        : "已登记本地仓库 · 支持只读运行观测、两级架构 PRD 解析与外部会话接入";
    }
    let liveCard = repoView.querySelector("[data-uw-repo-live-panel]");
    if (!liveCard) {
      liveCard = doc.createElement("div");
      liveCard.className = "uw-repo-live-panel";
      liveCard.dataset.uwRepoLivePanel = "true";
      factsHost.parentElement?.insertBefore(liveCard, factsHost);
    }
    liveCard.replaceChildren();
    if (facts) {
      const grid = doc.createElement("div");
      grid.className = "uw-repo-facts-grid";
      const rows = [
        ["Git 分支", facts.branch || (facts.hasGit ? "detached" : "未初始化 Git")],
        ["最新提交", facts.headCommit || "无提交记录"],
        ["工作区状态", !facts.hasGit ? "非 Git 目录" : facts.worktree?.state === "clean" ? "干净（0 处未提交变更）"
          : `${facts.worktree?.totalChanges || 0} 处变更（修改 ${facts.worktree?.modifiedCount || 0} · 暂存 ${facts.worktree?.stagedCount || 0} · 未跟踪 ${facts.worktree?.untrackedCount || 0}）`],
        ["双向同步 Hook", facts.enrolledRuntimes?.length
          ? facts.enrolledRuntimes.map((h) => `${h.label}${h.autoSync ? "（自动同步）" : ""}`).join(" · ")
          : "尚未安装项目级 Hook"],
      ];
      for (const [k, v] of rows) {
        const cell = doc.createElement("div");
        cell.className = "uw-repo-fact-cell";
        const labelEl = doc.createElement("span"); labelEl.textContent = k;
        const valEl = doc.createElement("strong"); valEl.textContent = v;
        cell.append(labelEl, valEl);
        grid.append(cell);
      }
      liveCard.append(grid);
      const emptyPlaceholder = factsHost.querySelector(".repository-empty");
      emptyPlaceholder?.remove();
    }
    const allCatalog = typeof options.getCatalog === "function" ? (options.getCatalog() || []) : [];
    if (allCatalog.length > 0) {
      const primaryRepos = allCatalog.filter((p) => !isEphemeralProjectName(p.displayName));
      const tempRepos = allCatalog.filter((p) => isEphemeralProjectName(p.displayName));
      const switcher = doc.createElement("div");
      switcher.className = "uw-repo-catalog-box";
      const head = doc.createElement("div");
      head.className = "uw-repo-catalog-head";
      const titleEl = doc.createElement("strong");
      titleEl.textContent = `切换已登记仓库（核心工程 ${primaryRepos.length} 个 · 共 ${allCatalog.length} 个）`;
      head.append(titleEl);
      switcher.append(head);
      const makeRepoGrid = (list) => {
        const g = doc.createElement("div");
        g.className = "uw-repo-chip-grid";
        for (const item of list) {
          const btn = doc.createElement("button");
          btn.type = "button";
          btn.className = "uw-repo-chip";
          btn.dataset.selected = String(item.projectId === state.selection?.projectId);
          const nameSpan = doc.createElement("strong");
          nameSpan.textContent = item.displayName || item.projectId;
          const countSpan = doc.createElement("small");
          countSpan.textContent = `${item.sessionCount || 0} 条运行`;
          btn.append(nameSpan, countSpan);
          btn.addEventListener("click", () => {
            options.selectProjectRun?.(item.projectId, "");
          });
          g.append(btn);
        }
        return g;
      };
      switcher.append(makeRepoGrid(primaryRepos));
      if (tempRepos.length > 0) {
        const more = doc.createElement("details");
        more.className = "uw-repo-temp-group";
        const sum = doc.createElement("summary");
        sum.textContent = `展开临时测试与沙盒目录（${tempRepos.length} 个）`;
        more.append(sum, makeRepoGrid(tempRepos));
        switcher.append(more);
      }
      liveCard.append(switcher);
    }
  }

  async function loadAgentArchitecture({ force = false, projectId = state.selection?.projectId || "" } = {}) {
    if (!agentEntryEnabled || !token || (!desktop && !app.querySelector("[data-live-repository-view]")) || disposed) return;
    const targetProj = String(projectId || "");
    if (architectureRead && architectureProjectId === targetProj) return;
    if (!force && architectureProjectId === targetProj && Date.now() - architectureLastRead < 60_000) return;
    architectureProjectId = targetProj;
    const reqProj = targetProj;
    architectureRead = (async () => {
      try {
        const [arch, wfCanvas, repoFacts, bindings] = await Promise.all([
          request("/api/agent/architecture", { selection: {}, query: reqProj ? { projectId: reqProj } : {}, runScoped: false }).catch(() => null),
          request("/api/agent/prd-workflow", { selection: {}, query: reqProj ? { projectId: reqProj } : {}, runScoped: false }).catch(() => null),
          request("/api/agent/repository", { selection: {}, query: reqProj ? { projectId: reqProj } : {}, runScoped: false }).catch(() => null),
          request("/api/agent/bindings", { selection: {}, query: reqProj ? { projectId: reqProj } : {}, runScoped: false }).catch(() => null),
        ]);
        if (disposed || architectureProjectId !== reqProj) return;
        if (arch?.schemaVersion === "meta-kim-project-architecture-prd-v1"
          && arch?.system && Array.isArray(arch?.modules)) {
          state.projectArchitecturePrd = arch;
        }
        if (wfCanvas?.schemaVersion === "meta-kim-prd-workflow-canvas-v1" && Array.isArray(wfCanvas.nodes)) {
          state.prdWorkflowCanvas = wfCanvas;
        }
        if (repoFacts?.schemaVersion === "meta-kim-agent-repository-facts-v1") {
          state.repositoryFacts = repoFacts;
          if (repoFacts.projectName) state.agentServerProjectLabel = repoFacts.projectName;
        }
        if (bindings?.schemaVersion === "meta-kim-agent-bindings-v1") {
          state.sessionBindings = bindings;
        }
        architectureLastRead = Date.now();
      } catch (error) {
        if (disposed || error?.name === "AbortError") return;
        architectureLastRead = Date.now();
      }
      enhanceRepositorySurface();
      renderer.render();
      desktop?.render();
    })();
    try { await architectureRead; } finally { if (architectureProjectId === reqProj) architectureRead = null; }
  }
  async function loadAgentCapabilities({ force = false } = {}) {
    if (!agentEntryEnabled || !token || disposed || capabilityCatalogRead
      || (!force && Date.now() - capabilityCatalogLastRead < 60_000)) return;
    capabilityCatalogRead = (async () => {
      try {
        const catalog = await request("/api/agent/capabilities", { selection: {}, runScoped: false });
        if (disposed) return;
        if (catalog?.schemaVersion !== 1 || catalog?.evidenceLevel !== "registered_only"
          || !Array.isArray(catalog.agents) || !Array.isArray(catalog.skills)
          || !Array.isArray(catalog.hooks) || !Array.isArray(catalog.mcpServers)) {
          throw new Error("Capability registry schema mismatch");
        }
        // The registry is static evidence of registration, never proof of
        // selection, invocation or the outcome of a live subagent.
        state.capabilityCatalog = catalog;
        state.capabilityCatalogError = null;
        capabilityCatalogLastRead = Date.now();
      } catch (error) {
        if (disposed || error?.name === "AbortError") return;
        state.capabilityCatalogError = "本地能力登记暂不可读取";
        capabilityCatalogLastRead = Date.now();
      }
      renderer.render();
    })();
    try { await capabilityCatalogRead; } finally { capabilityCatalogRead = null; }
  }
  const designElement = (tag, className = "", value = null) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (value != null) node.textContent = String(value);
    return node;
  };
  const designLines = (value) => String(value || "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const freshSystem = () => ({ title: "", goal: "", architecture: "", techStack: "", acceptance: [] });
  const freshModule = (index) => ({ id: `module-${String(index).padStart(2, "0")}`, title: "", objective: "", inputContract: [], outputContract: [], boundaries: [], acceptance: [], dependencies: [] });
  const copyDesign = (value) => JSON.parse(JSON.stringify(value));
  const designBasis = () => {
    const pending = agent.pending;
    const decision = pending?.decision;
    return pending?.requestId && /^[a-f0-9]{64}$/iu.test(pending.planDigest || "")
      && decision?.state === "adopted_for_design" && typeof decision.decisionKey === "string"
      ? { idempotencyKey: pending.key, requestId: pending.requestId, planDigest: pending.planDigest, decisionKey: decision.decisionKey }
      : null;
  };
  function validNativeDraftReceipt(payload, basis) {
    if (payload?.schemaVersion !== "meta-kim-agent-design-draft-v1"
      || !["not_started", "accepted", "running", "completed", "failed", "blocked", "unknown"].includes(payload.status)
      || payload.executionAuthorized !== false || payload.runId !== null
      || payload.draftSource !== "native_readonly_unverified" || payload.nativeEvidenceVerified !== false
      || !payload.basis) return false;
    if (payload.basis.idempotencyKey !== basis.idempotencyKey
      || payload.basis.requestId !== basis.requestId || payload.basis.planDigest !== basis.planDigest
      || payload.basis.decisionKey !== basis.decisionKey
      || payload.basis.projectFingerprint !== agent.executionScope?.projectFingerprint
      || payload.basis.selectedStrategy !== agent.pending?.decision?.selectedStrategy
      || payload.basis.selectionReason !== agent.pending?.decision?.selectionReason) return false;
    if (payload.status !== "not_started" && !/^[A-Za-z0-9_-]{16,128}$/u.test(payload.draftKey || "")) return false;
    if (payload.status === "completed" && (!/^[a-f0-9]{64}$/iu.test(payload.draftDigest || "")
      || !validDesignDraft(payload.design))) return false;
    return true;
  }
  function nativeDraftReason(reason) {
    return ({ native_design_schema_invalid: "客户端给出的设计结构不完整",
      native_design_json_invalid: "客户端返回的数据格式有误",
      native_design_output_unavailable: "客户端没有返回设计内容",
      native_design_output_too_large_or_missing: "设计材料超出安全长度或内容缺失",
      native_design_redaction_invalidated_contract: "私密信息过滤后设计内容不完整",
      native_design_adapter_unavailable: "当前客户端暂不支持安全生成设计",
      native_design_handoff_failed: "客户端连接失败或不接受研究请求",
      gemini_noninteractive_plan_auto_execution_risk: "Gemini 的非交互只读安全性尚未确认，暂不开放",
      native_draft_outcome_not_confirmed: "原草稿结果尚待人工核对",
      agent_original_goal_unavailable_or_mismatch: "旧研究任务缺少可核验的原始目标",
      host_not_supported: "当前客户端不支持此项只读研究" })[reason] || "当前客户端未提供可采用的设计材料";
  }
  function renderNativeDraft() {
    if (!agentDraft) return;
    const current = nativeDraft.snapshot;
    agentDraft.hidden = !designBasis() || !design.snapshot || design.snapshot.status !== "not_started";
    if (agentDraft.hidden) return;
    const label = nativeDraft.error || (nativeDraft.busy || nativeDraft.loading
      ? "正在通过原生只读客户端生成／核对设计草稿…"
      : current?.status === "completed" && nativeDraft.sourceApplied
        ? `已载入原生只读草稿 · 来源摘要 ${current.draftDigest?.slice(0, 12)}…；未经独立核验，请检查并修改所有关键节点后保存。`
      : nativeDraft.manualOverride ? "手工编辑已展开；仍需逐项人工审阅和批准。"
      : current?.status === "accepted" || current?.status === "running" ? "原生客户端正在生成系统级 PRD 与模块任务图，当前尚无可批准设计。"
      : current?.recoveryState === "in_doubt" || current?.status === "unknown"
        ? "原生草稿结果尚未确定，需先核对原请求；不会自动重复启动。"
      : current?.status === "failed" || current?.status === "blocked"
        ? `自动草稿未生成：${nativeDraftReason(current.reason)}。可重试或改用手工。`
      : nativeDraft.pendingKey ? "旧设计草稿请求尚未确认，可用原号安全核对。"
      : "已采纳方案，准备自动生成两级 PRD 草稿；你也可手工编写。");
    if (agentDraftStatus) { agentDraftStatus.textContent = label; agentDraftStatus.dataset.state = nativeDraft.error ? "blocked" : current?.status || "waiting"; }
    if (agentDraftGenerate) {
      const canGenerate = !nativeDraft.pendingKey && current && ["not_started", "failed", "blocked"].includes(current.status)
        && !nativeDraft.editorVisible && !nativeDraft.busy && !nativeDraft.loading && state.canWrite;
      agentDraftGenerate.hidden = !canGenerate;
      agentDraftGenerate.disabled = !canGenerate;
      agentDraftGenerate.textContent = current?.status === "failed" || current?.status === "blocked"
        ? "重新生成设计草稿（只读）" : "生成设计草稿（只读）";
    }
    if (agentDraftManual) {
      agentDraftManual.hidden = nativeDraft.editorVisible;
      agentDraftManual.disabled = !state.canWrite;
    }
    if (agentDraftReconcile) {
      agentDraftReconcile.hidden = !nativeDraft.pendingKey || !(nativeDraft.error || ["unknown", "not_started"].includes(current?.status));
      agentDraftReconcile.disabled = nativeDraft.loading || nativeDraft.busy;
    }
    desktop?.render();
  }
  function applyNativeDraft(payload) {
    if (payload.status !== "completed" || nativeDraft.sourceApplied || nativeDraft.manualOverride
      || design.snapshot?.status !== "not_started") return;
    design.draft = copyDesign(payload.design);
    nativeDraft.sourceApplied = true;
    nativeDraft.editorVisible = true;
    renderAgentDesign();
  }
  async function loadNativeDraft({ autoStart = false } = {}) {
    const basis = designBasis();
    if (!agentDraft || !basis || design.snapshot?.status !== "not_started" || nativeDraft.busy || nativeDraft.loading || disposed) return;
    nativeDraft.loading = true;
    renderNativeDraft();
    let shouldStart = false;
    try {
      const payload = await request("/api/agent/design-drafts", { selection: {}, query: { idempotencyKey: basis.idempotencyKey } });
      if (disposed || designBasis()?.idempotencyKey !== basis.idempotencyKey || design.snapshot?.status !== "not_started") return;
      if (!validNativeDraftReceipt(payload, basis)) throw new Error("Native design draft source mismatch");
      nativeDraft.snapshot = payload;
      nativeDraft.error = null;
      if (nativeDraft.pendingKey && payload.draftKey && payload.draftKey !== nativeDraft.pendingKey.key) {
        nativeDraft.error = "服务器上的原生草稿号与当前会话不一致，请人工核对来源。";
      } else if (["failed", "blocked", "completed"].includes(payload.status) && nativeDraft.pendingKey) {
        nativeDraft.pendingKey = null; saveAgent();
      }
      if (payload.status === "completed" && !nativeDraft.error) applyNativeDraft(payload);
      shouldStart = autoStart && payload.status === "not_started" && !nativeDraft.pendingKey
        && !nativeDraft.autoAttempted && !nativeDraft.manualOverride && state.canWrite;
    } catch {
      if (!disposed) nativeDraft.error = "无法检查原生设计草稿。你可稍后重试，或使用手工编写。";
    } finally {
      nativeDraft.loading = false;
      renderNativeDraft();
      if (shouldStart) void startNativeDraft();
    }
  }
  async function startNativeDraft({ retry = false } = {}) {
    const basis = designBasis();
    if (!agentDraft || !basis || design.snapshot?.status !== "not_started" || !state.canWrite
      || nativeDraft.busy || nativeDraft.loading || disposed) return;
    let pending = nativeDraft.pendingKey;
    if (!retry) {
      if (pending || nativeDraft.manualOverride || !nativeDraft.snapshot
        || !["not_started", "failed", "blocked"].includes(nativeDraft.snapshot.status)) return;
      const key = win.crypto?.randomUUID?.();
      if (!key) { nativeDraft.error = "当前浏览器无法创建安全草稿请求号。"; renderNativeDraft(); return; }
      pending = { key };
      nativeDraft.pendingKey = pending;
      saveAgent();
    } else if (!pending || nativeDraft.snapshot?.recoveryState === "in_doubt") return;
    nativeDraft.autoAttempted = true;
    nativeDraft.busy = true; nativeDraft.error = null;
    renderNativeDraft();
    try {
      const payload = await request("/api/agent/design-drafts", { method: "POST", selection: {}, body: {
        ...basis, draftKey: pending.key, goal: agent.pending?.goal,
      } });
      if (disposed || designBasis()?.idempotencyKey !== basis.idempotencyKey) return;
      if (!validNativeDraftReceipt(payload, basis) || payload.draftKey && payload.draftKey !== pending.key) throw new Error("Native draft receipt mismatch");
      nativeDraft.snapshot = payload;
      if (["completed", "failed", "blocked"].includes(payload.status)) {
        nativeDraft.pendingKey = null;
        saveAgent();
      }
      if (payload.status === "completed") applyNativeDraft(payload);
    } catch (error) {
      if (disposed) return;
      if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
        nativeDraft.error = "原生草稿未被接受：" + (error.message || "请核对客户端与权限。") + "。可手工编写。";
        nativeDraft.pendingKey = null;
        saveAgent();
      } else {
        nativeDraft.error = "原生草稿回执尚未确定。保留原号，先核对服务器结果，不会再次自动启动。";
        nativeDraft.busy = false;
        await loadNativeDraft();
      }
    } finally { nativeDraft.busy = false; renderNativeDraft(); }
  }
  function handoffReady() {
    const snapshot = design.snapshot;
    return Boolean(designBasis() && snapshot?.status === "approved" && snapshot.reviewComplete === true
      && Number.isSafeInteger(snapshot.version) && snapshot.version > 0
      && /^[a-f0-9]{64}$/iu.test(snapshot.designDigest || ""));
  }
  function validHandoffSnapshot(payload, basis) {
    if (payload?.schemaVersion !== "meta-kim-agent-handoff-v1"
      || !["blocked", "eligible", "prepared", "stale"].includes(payload.status)
      || payload.requiresNativeHostConfirmation !== true || payload.readyForExecution !== false
      || payload.executionAuthorized !== false || payload.runId !== null) return false;
    if (payload.executionScope?.kind !== "server_bound" || !/^[a-f0-9]{64}$/iu.test(payload.executionScope.projectFingerprint || "")
      || payload.executionScope.projectFingerprint !== agent.executionScope?.projectFingerprint) return false;
    if (payload.status !== "blocked" && (!payload.basis || payload.basis.idempotencyKey !== basis.idempotencyKey
      || payload.basis.requestId !== basis.requestId || payload.basis.planDigest !== basis.planDigest
      || payload.basis.decisionKey !== basis.decisionKey)) return false;
    if (!["blocked", "stale"].includes(payload.status) && (!handoffReady()
      || payload.designVersion !== design.snapshot.version || payload.designDigest !== design.snapshot.designDigest)) return false;
    if (payload.status === "prepared" && (!payload.receipt?.handoffKey || !/^[a-f0-9]{64}$/iu.test(payload.handoffDigest || ""))) return false;
    return true;
  }
  function renderAgentFollowthrough() {
    if (!agentExecution || !agentAcceptance) return;
    const inDesignReview = Boolean(designBasis() && design.snapshot?.status === "approved"
      && design.snapshot.reviewComplete === true);
    agentExecution.hidden = !inDesignReview;
    agentAcceptance.hidden = !inDesignReview;
    if (!inDesignReview) return;
    const current = handoff.snapshot;
    const prepared = current?.status === "prepared" && handoffReady()
      && current.designVersion === design.snapshot.version && current.designDigest === design.snapshot.designDigest;
    const native = execution.snapshot?.handoffDigest === current?.handoffDigest ? execution.snapshot : null;
    const hasSelectedRun = Boolean(state.snapshot?.run?.id || state.selection?.runId);
    if (agentExecutionStatus) {
      agentExecutionStatus.textContent = !prepared
        ? "当前设计批准还不足以执行；先完成交接并独立授权。"
        : execution.error ? execution.error
          : native?.status === "ready_to_authorize" ? "B1、B2、交接已核对。现在可以单独批准一次本地草稿操作。"
            : native?.status === "running" ? "B3 已批准，原生客户端正在运行。修改暂未经过正式 Run 和测试验收。"
              : native?.status === "ready_for_review" ? "原生任务已结束，请核验文件和测试；还没有通过 B4 验收。"
                : native?.status === "waiting_input" ? "原生任务需要你在客户端处理输入或权限问题。"
                  : native?.status === "blocked" ? "受限执行暂不可用。请检查原生客户端或已批准版本。"
                    : native ? "原生任务状态尚未完全核实，已保留启动回执。" : "交接已封存；没有授权任何写入、发布、付费操作，正在核对 B3 入口。";
      agentExecutionStatus.dataset.state = execution.error || native?.status === "blocked" ? "blocked"
        : native?.status === "running" ? "prepared" : "waiting";
    }
    if (agentExecutionAuthorize) {
      const canAuthorize = prepared && native?.status === "ready_to_authorize" && !execution.pendingKey;
      agentExecutionAuthorize.hidden = !canAuthorize && !execution.pendingKey;
      agentExecutionAuthorize.disabled = !state.canWrite || execution.busy || execution.loading || !prepared
        || !canAuthorize && !execution.pendingKey;
      agentExecutionAuthorize.textContent = execution.pendingKey
        ? "用原授权号核对／安全重试" : "批准 B3 · 启动本地草稿";
    }
    if (agentExecutionCheck) agentExecutionCheck.disabled = execution.busy || execution.loading || !prepared;
    if (agentExecutionNative) {
      agentExecutionNative.textContent = execution.loading ? "正在查询原生任务…"
        : execution.error || (native?.nativeSessionId
          ? "Claude 后台任务 " + native.nativeSessionId + " · " + (native.nextAction || "等待核对")
          : native?.nextAction || "");

    }
    if (agentExecutionEvidence) {
      agentExecutionEvidence.replaceChildren();
      for (const [name, value] of [
        ["当前交接", prepared ? `仅静态材料已封存 · ${current.handoffDigest.slice(0, 12)}…` : "尚无当前版本的已封存交接"],
        ["真实 Run 身份", hasSelectedRun
          ? "左侧存在已选 Run，但尚无证据证明其与本次 B1/B2 相同" : "未关联经过核验的正式 Run"],
        ["原生执行证据", native?.nativeSessionId
          ? "已有后台任务 " + native.nativeSessionId + "；状态来自原生 CLI，仍需核对具体文件与正式 Run"
          : "尚无与本次批准交接绑定且可复核的原生任务"],
        ["B3 副作用授权（本地草稿）", native?.authorizedByLocalB3
          ? "已批准一次本项目本地草稿操作；没有授予发布、付款、消息或其他外部权限"
          : "待单独批准一次本地草稿操作；不自动执行"],

      ]) {
        const item = designElement("li");
        item.append(designElement("strong", "", name), designElement("span", "", value));
        agentExecutionEvidence.appendChild(item);
      }
    }
    if (agentExecutionRecords) agentExecutionRecords.textContent = hasSelectedRun
      ? "查看已选 Run 的记录" : "选择正式 Run 查看记录";
    if (agentAcceptanceStatus) {
      const b4 = acceptance.snapshot;
      agentAcceptanceStatus.textContent = b4?.status === "accepted_and_integrated"
        ? "B4 最终验收已通过，隔离区验证产物已合入主项目并沉淀方法卡。"
        : b4?.status === "awaiting_human_b4"
          ? `隔离区产物已通过自动核验（${b4.changedFiles?.length || 0} 个文件），等待你确认 B4 合入或指定模块退回。`
          : native?.status === "ready_for_review"
            ? "原生任务已结束。需先核验隔离工作区的真实改动、测试及正式 Run，才可以人工验收。"
            : "本任务尚无已核验的运行产物或 B4 最终验收结果，不能标记完成。";

      agentAcceptanceStatus.dataset.state = b4?.status === "accepted_and_integrated" ? "prepared"
        : b4?.status === "awaiting_human_b4" ? "eligible" : "waiting";
    }
    if (agentAcceptanceEvidence) {
      agentAcceptanceEvidence.replaceChildren();
      for (const [name, value] of [
        ["产物与实际效果", "尚未提供与本方案及设计版本绑定的真实文件、运行结果和来源哈希"],
        ["审查与复测", "尚无相同正式 Run 的 Review、Meta-Review、Verification 三层可核验证据"],
        ["人工最终决定", "没有通过 B4 最终接受或指定节点返工的有效决策记录"],
      ]) {
        const item = designElement("li");
        item.append(designElement("strong", "", name), designElement("span", "", value));
        agentAcceptanceEvidence.appendChild(item);
      }
    }
  }
  function renderAgentHandoff() {
    if (!agentHandoff) return;
    const basis = designBasis();
    agentHandoff.hidden = !basis;
    if (!basis) { renderAgentFollowthrough(); return; }
    const ready = handoffReady();
    const current = handoff.snapshot;
    const sameVersion = ready && current && current.designVersion === design.snapshot.version
      && current.designDigest === design.snapshot.designDigest;
    const eligible = Boolean(sameVersion && current.status === "eligible");
    const prepared = Boolean(sameVersion && current.status === "prepared");
    const status = handoff.error || (handoff.loading ? "正在核对真实交接回执…"
      : !ready ? "等待系统和全部模块设计人工批准；尚未创建正式运行。"
      : prepared ? "交接摘要已封存 · 等待受控客户端另行确认正式运行。"
      : eligible ? "设计已全部批准，可封存当前版本的交接摘要（不会执行）。"
      : current?.status === "stale" || current && !sameVersion ? "旧交接摘要对应早期设计版本；需核对最新版本并重新准备。"
      : current?.status === "blocked" ? "交接尚不满足服务端前置条件。" : "设计已批准，正在核对交接状态。始终未授权代码执行。");
    if (agentHandoffStatus) {
      agentHandoffStatus.textContent = status;
      agentHandoffStatus.dataset.state = handoff.error ? "blocked" : prepared ? "prepared" : eligible ? "eligible" : "waiting";
    }
    if (agentHandoffCheck) agentHandoffCheck.disabled = handoff.loading || handoff.busy || !ready;
    if (agentHandoffPrepare) {
      agentHandoffPrepare.hidden = !eligible || Boolean(handoff.pendingKey);
      agentHandoffPrepare.disabled = !state.canWrite || handoff.busy || handoff.loading || !eligible;
    }
    if (agentHandoffReconcile) {
      agentHandoffReconcile.hidden = !handoff.pendingKey;
      agentHandoffReconcile.disabled = handoff.busy || handoff.loading || !ready;
    }
    if (agentHandoffReceipt) {
      agentHandoffReceipt.hidden = !prepared;
      agentHandoffReceipt.replaceChildren();
      if (prepared) {
        agentHandoffReceipt.appendChild(designElement("strong", "", "交接回执 · 未执行"));
        agentHandoffReceipt.appendChild(designElement("span", "", `设计版本 ${current.designVersion} · 摘要 ${current.handoffDigest}`));
        if (current.receipt?.preparedAt) agentHandoffReceipt.appendChild(designElement("span", "", `封存时间 ${current.receipt.preparedAt}`));
        agentHandoffReceipt.appendChild(designElement("span", "", "下一步：受控客户端读取本交接并独立确认正式运行；当前 runId 为空。"));
      }
    }
    renderAgentFollowthrough();
    desktop?.render();
  }
  async function loadAgentHandoff() {
    const basis = designBasis();
    if (!agentHandoff || !basis || !handoffReady() || handoff.loading || handoff.busy || disposed) return;
    handoff.loading = true;
    renderAgentHandoff();
    try {
      const payload = await request("/api/agent/handoff", { selection: {}, query: { idempotencyKey: basis.idempotencyKey } });
      if (disposed || designBasis()?.idempotencyKey !== basis.idempotencyKey) return;
      if (!validHandoffSnapshot(payload, basis)) throw new Error("Handoff binding or authority mismatch");
      handoff.snapshot = payload;
      if (handoff.pendingKey) {
        const recorded = Array.isArray(payload.history) && payload.history.some((entry) => entry.handoffKey === handoff.pendingKey.key
          && entry.designVersion === handoff.pendingKey.designVersion);
        if (recorded) { handoff.pendingKey = null; saveAgent(); }
        else handoff.error = "交接请求结果仍待核实。保留原交接号，不会自动重复提交。";
      }
      if (!handoff.pendingKey) handoff.error = null;
    } catch (error) {
      if (!disposed) handoff.error = error.status === 409 ? "交接版本发生变化，请先核对设计并重新准备。" : "交接状态暂时无法核对，请检查本地服务连接后重试。";
    } finally {
      handoff.loading = false; renderAgentHandoff();
      if (handoff.snapshot?.status === "prepared") void loadAgentExecution();
    }

  }
  async function prepareAgentHandoff({ retry = false } = {}) {
    const basis = designBasis();
    if (!basis || !handoffReady() || handoff.busy || handoff.loading || disposed || !state.canWrite) return;
    let pending = handoff.pendingKey;
    if (!retry) {
      if (pending || handoff.snapshot?.status !== "eligible") return;
      const key = win.crypto?.randomUUID?.();
      if (!key) { handoff.error = "无法创建安全交接号，请使用受支持的浏览器。"; renderAgentHandoff(); return; }
      pending = { key, designVersion: design.snapshot.version, designDigest: design.snapshot.designDigest };
      handoff.pendingKey = pending;
      saveAgent();
    } else if (!pending || pending.designVersion !== design.snapshot.version || pending.designDigest !== design.snapshot.designDigest) return;
    handoff.busy = true; handoff.error = null; renderAgentHandoff();
    try {
      const payload = await request("/api/agent/handoff", { method: "POST", selection: {}, body: {
        ...basis, designVersion: pending.designVersion, designDigest: pending.designDigest, handoffKey: pending.key,
      } });
      if (disposed || designBasis()?.idempotencyKey !== basis.idempotencyKey) return;
      if (!validHandoffSnapshot(payload, basis) || payload.status !== "prepared" || payload.receipt?.handoffKey !== pending.key) {
        throw new Error("Handoff receipt not authoritative");
      }
      handoff.snapshot = payload;
      handoff.pendingKey = null;
      handoff.error = null;
      saveAgent();
    } catch (error) {
      if (disposed) return;
      if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
        handoff.pendingKey = null;
        saveAgent();
        handoff.error = error.status === 409 ? "交接版本或人工批准已变化。刷新设计，核对后再准备。"
          : "交接被服务端拒绝：" + (error.message || "请检查前置批准和版本。");
      } else {
        handoff.error = "交接回执暂不确定，请先查询；原交接号已保留。";
        handoff.busy = false;
        await loadAgentHandoff();
      }
    } finally {
      handoff.busy = false; renderAgentHandoff();
      if (handoff.snapshot?.status === "prepared") void loadAgentExecution();
    }
  }
  function validNativeExecutionReceipt(payload, digest) {
    return payload?.schemaVersion === "meta-kim-agent-b3-native-execution-v1"
      && ["ready_to_authorize", "running", "waiting_input", "ready_for_review",
        "failed", "in_doubt", "unconfirmed", "blocked"].includes(payload.status)
      && payload.scope === "local_project_draft"
      && payload.handoffDigest === digest
      && payload.officialRunId === null
      && payload.governedRunVerified === false
      && payload.acceptanceVerified === false
      && payload.publicReady === false;
  }
  async function loadAgentExecution() {
    const basis = designBasis();
    const digest = handoff.snapshot?.status === "prepared" ? handoff.snapshot.handoffDigest : null;
    if (!basis || !digest || execution.loading || execution.busy || disposed) return;
    execution.loading = true;
    renderAgentFollowthrough();
    try {
      const payload = await request("/api/agent/execution", {
        selection: {}, query: { idempotencyKey: basis.idempotencyKey },
      });
      if (disposed || designBasis()?.idempotencyKey !== basis.idempotencyKey
        || handoff.snapshot?.handoffDigest !== digest) return;
      if (!validNativeExecutionReceipt(payload, digest)) throw new Error("B3 receipt is not bound to this design");
      execution.snapshot = payload;
      execution.error = null;
      if (execution.pendingKey && payload.authorizedByLocalB3) {
        execution.pendingKey = null;
        saveAgent();
      }
    } catch {
      if (!disposed) execution.error = execution.pendingKey || execution.snapshot?.authorizedByLocalB3
        ? "原生任务暂无法核对；原授权号已保留，不会自动重复启动。"
        : "交接已封存；没有授权任何写入、发布、付费操作，原生执行入口暂无法核对。";
    } finally {
      execution.loading = false; renderAgentFollowthrough(); desktop?.render();
      if (execution.snapshot?.status === "ready_for_review") void loadAgentAcceptance();
    }
  }
  function validAcceptanceSnapshot(payload) {
    return payload?.schemaVersion === "meta-kim-agent-b4-acceptance-v1"
      && ["not_ready", "waiting_b3", "pending_verification", "awaiting_human_b4",
        "verification_failed", "accepted_and_integrated", "rework_requested",
        "rolled_back", "blocked"].includes(payload.status);
  }
  async function loadAgentAcceptance() {
    const basis = designBasis();
    if (!basis || acceptance.loading || acceptance.busy || disposed) return;
    acceptance.loading = true;
    desktop?.render();
    try {
      const payload = await request("/api/agent/acceptance", {
        selection: {}, query: { idempotencyKey: basis.idempotencyKey },
      });
      if (disposed || designBasis()?.idempotencyKey !== basis.idempotencyKey) return;
      if (!validAcceptanceSnapshot(payload)) throw new Error("B4 acceptance schema mismatch");
      acceptance.snapshot = payload;
      acceptance.error = null;
    } catch {
      if (!disposed) acceptance.error = "暂时无法核对 B4 产物与核验状态，请检查本地服务连接。";
    } finally {
      acceptance.loading = false; renderAgentFollowthrough(); desktop?.render();
    }
  }
  async function verifyAgentAcceptance() {
    const basis = designBasis();
    if (!basis || acceptance.busy || acceptance.loading || disposed || !state.canWrite) return false;
    acceptance.busy = true; acceptance.error = null; desktop?.render();
    try {
      const payload = await request("/api/agent/acceptance", {
        method: "POST", selection: {}, body: { idempotencyKey: basis.idempotencyKey, action: "verify" },
      });
      if (disposed || designBasis()?.idempotencyKey !== basis.idempotencyKey) return false;
      if (!validAcceptanceSnapshot(payload)) throw new Error("B4 verify receipt invalid");
      acceptance.snapshot = payload;
      return true;
    } catch (error) {
      if (!disposed) acceptance.error = "产物核验请求失败：" + (error.message || "请检查隔离工作区状态。");
      return false;
    } finally {
      acceptance.busy = false; renderAgentFollowthrough(); desktop?.render();
    }
  }
  async function decideAgentAcceptance(action, extra = {}) {
    const basis = designBasis();
    const snap = acceptance.snapshot;
    if (!basis || !snap?.handoffDigest || acceptance.busy || acceptance.loading || disposed || !state.canWrite) return false;
    const decisionKey = win.crypto?.randomUUID?.();
    if (!decisionKey) { acceptance.error = "当前浏览器无法生成安全确认号。"; desktop?.render(); return false; }
    acceptance.busy = true; acceptance.error = null; desktop?.render();
    try {
      const payload = await request("/api/agent/acceptance", {
        method: "POST", selection: {},
        body: {
          idempotencyKey: basis.idempotencyKey,
          decisionKey,
          handoffDigest: snap.handoffDigest,
          ...(snap.artifactsDigest && { artifactsDigest: snap.artifactsDigest }),
          action,
          ...extra,
        },
      });
      if (disposed || designBasis()?.idempotencyKey !== basis.idempotencyKey) return false;
      if (!validAcceptanceSnapshot(payload)) throw new Error("B4 decision receipt invalid");
      acceptance.snapshot = payload;
      if (payload.status === "blocked") {
        acceptance.error = payload.nextAction || "合入被安全门禁拦截，请先处理冲突或核验问题。";
        return false;
      }
      if (payload.status === "rework_requested") {
        handoff.snapshot = null; handoff.pendingKey = null;
        execution.snapshot = null; execution.pendingKey = null;
        saveAgent();
        await loadAgentDesign();
      }
      return true;
    } catch (error) {
      if (!disposed) acceptance.error = "B4 决策未能写入：" + (error.message || "请先刷新核对当前状态。");
      return false;
    } finally {
      acceptance.busy = false; renderAgentFollowthrough(); desktop?.render();
    }
  }
  async function approveAllAndPrepareHandoff() {
    if (!design.snapshot || design.snapshot.status === "approved"
      || (design.snapshot.pendingReviewNotes?.length || 0) > 0) return false;
    const ok = await submitAgentDesign("approve_all", {});
    if (!ok || design.snapshot?.status !== "approved" || design.snapshot?.reviewComplete !== true) return false;
    await loadAgentHandoff();
    if (handoff.snapshot?.status === "eligible") {
      await prepareAgentHandoff();
    }
    return true;
  }
  async function submitAgentExecution() {
    const basis = designBasis();
    const digest = handoff.snapshot?.status === "prepared" ? handoff.snapshot.handoffDigest : null;
    if (!basis || !digest || execution.busy || execution.loading || disposed || !state.canWrite) return;
    const pending = execution.pendingKey;
    if (pending && pending.handoffDigest !== digest) return;
    if (!pending && execution.snapshot?.status !== "ready_to_authorize") return;
    const approvalKey = pending?.key || win.crypto?.randomUUID?.();
    if (!approvalKey) {
      execution.error = "无法生成一次性授权号，请更新浏览器后重试。";
      renderAgentFollowthrough(); return;
    }
    execution.pendingKey = { key: approvalKey, handoffDigest: digest };
    saveAgent();
    execution.busy = true; execution.error = null;
    renderAgentFollowthrough();
    try {
      const payload = await request("/api/agent/execution", { method: "POST", selection: {},
        body: { idempotencyKey: basis.idempotencyKey, handoffDigest: digest,
          approvalKey, scope: "local_project_draft" },
      });
      if (disposed || designBasis()?.idempotencyKey !== basis.idempotencyKey
        || handoff.snapshot?.handoffDigest !== digest) return;
      if (!validNativeExecutionReceipt(payload, digest)) throw new Error("B3 response is not current");
      execution.snapshot = payload;
      if (payload.authorizedByLocalB3 || payload.status === "blocked") {
        execution.pendingKey = null;
        saveAgent();
      }
      execution.error = payload.status === "blocked"
        ? "无法启动受限草稿：" + (payload.reason || "请检查本机原生客户端") : null;
    } catch {
      execution.error = "启动回执暂时无法确定。请先核对原生状态，切勿换授权号重复启动。";
    } finally {
      execution.busy = false; renderAgentFollowthrough(); desktop?.render();
    }

  }
  function designMessage(message, kind = "waiting") {
    if (agentDesignStatus) { agentDesignStatus.textContent = message; agentDesignStatus.dataset.state = kind; }
    desktop?.render();
  }
  function designField(label, value, write, { multiline = false, wide = false, note = "" } = {}) {
    const field = designElement("label");
    if (wide) field.dataset.wide = "true";
    field.appendChild(designElement("span", "", label));
    const input = designElement(multiline ? "textarea" : "input");
    if (multiline) input.rows = 2;
    else input.type = "text";
    input.value = String(value ?? "");
    input.disabled = !state.canWrite;
    input.addEventListener("input", () => { write(input.value); });
    field.appendChild(input);
    if (note) field.appendChild(designElement("small", "", note));
    return field;
  }
  function designFields(fields) {
    const grid = designElement("div", "uw-agent-design-form");
    for (const field of fields) grid.appendChild(designField(...field));
    return grid;
  }
  function designButton(label, act, disabled = false) {
    const button = designElement("button", "", label);
    button.type = "button";
    button.disabled = disabled || !state.canWrite || design.busy || design.pendingMutation != null || design.stale;
    button.addEventListener("click", act);
    return button;
  }
  function designInputFields(object, kind) {
    const system = kind === "system";
    const entries = system ? [
      ["系统名称", "title"], ["系统目标", "goal"], ["架构和技术边界", "architecture"],
      ["技术栈", "techStack"], ["系统验收标准", "acceptance"],
    ] : [
      ["模块名称", "title"], ["模块目标", "objective"], ["输入契约", "inputContract"],
      ["输出契约", "outputContract"], ["边界与异常", "boundaries"], ["模块验收标准", "acceptance"],
    ];
    const fields = entries.map(([name, key]) => {
      const multi = !["title"].includes(key);
      const list = Array.isArray(object[key]);
      const value = list ? object[key].join("\n") : object[key];
      const note = list ? "每行一条，最多 24 条。可直接写中文，不需要 JSON。" : "";
      return [name, value, (text) => { object[key] = list ? designLines(text) : text; }, { multiline: multi, wide: multi, note }];
    });
    return designFields(fields);
  }
  function designDependencies(module, modules) {
    const field = designElement("fieldset", "uw-agent-design-deps");
    field.appendChild(designElement("legend", "", "依赖的前置模块（可多选）"));
    let choices = 0;
    for (const candidate of modules) {
      if (candidate.id === module.id) continue;
      const label = designElement("label");
      const input = designElement("input");
      input.type = "checkbox";
      input.checked = (module.dependencies || []).includes(candidate.id);
      input.addEventListener("change", () => {
        const selected = new Set(module.dependencies || []);
        if (input.checked) selected.add(candidate.id); else selected.delete(candidate.id);
        module.dependencies = [...selected];
      });
      label.appendChild(input);
      label.appendChild(designElement("span", "", candidate.title?.trim() || candidate.id));
      field.appendChild(label);
      choices += 1;
    }
    if (!choices) field.appendChild(designElement("span", "uw-agent-design-approval", "暂无其他模块"));
    return field;
  }
  function designApproval(node, approval) {
    const labels = { pending: "待人工确认", approved: "已批准（仅设计）", invalidated: "已失效，需重新确认", revoked: "已撤销批准" };
    const badge = designElement("span", "uw-agent-design-approval", labels[approval?.state] || "审批状态待核实");
    badge.dataset.state = approval?.state || "unknown";
    if (approval?.reason) badge.title = `原因：${approval.reason}`;
    node.appendChild(badge);
  }
  function designFacts(entries) {
    const facts = designElement("dl", "uw-agent-design-facts");
    for (const [label, value] of entries) {
      const fact = designElement("div", "uw-agent-design-fact");
      fact.appendChild(designElement("dt", "", label));
      fact.appendChild(designElement("dd", "", value || "无"));
      facts.appendChild(fact);
    }
    return facts;
  }
  function parseNativeStrategyOptions(preview) {
    let value;
    try { value = JSON.parse(preview); } catch { return null; }
    const valid = (item, max) => typeof item === "string" && item.trim().length >= 1 && item.length <= max;
    if (!value || value.schemaVersion !== "meta-kim-agent-strategy-options-v1" || value.provenance !== "native_plan_unverified"
      || value.evidenceVerified !== false || !valid(value.summary, 500)
      || !Array.isArray(value.strategies) || value.strategies.length < 2 || value.strategies.length > 3
      || !Array.isArray(value.openQuestions) || value.openQuestions.length > 4 || !value.openQuestions.every((item) => valid(item, 180))) return null;
    if (value.strategies.some((item, index) => !item || item.id !== ["A", "B", "C"][index]
      || !valid(item.title, 80) || !valid(item.approach, 320) || !valid(item.tradeoffs, 320)
      || !valid(item.evidenceSummary, 320) || !valid(item.risks, 220))) return null;
    if (value.recommendedStrategyId !== null && !value.strategies.some((item) => item.id === value.recommendedStrategyId)) return null;
    return value;
  }
  function renderNativeStrategyOptions(preview) {
    if (!agentOptions) return;
    agentOptions.replaceChildren();
    const parsed = parseNativeStrategyOptions(preview);
    agentOptions.hidden = !parsed;
    if (agentRaw) agentRaw.open = !parsed;
    if (!parsed) return;
    agentOptions.appendChild(designElement("p", "uw-agent-options-disclaimer", "客户端给出了候选方案，但内容、引证和推荐均未独立验证。请人工核对后选择。"));
    agentOptions.appendChild(designElement("p", "uw-agent-options-summary", parsed.summary));
    const list = designElement("div", "uw-agent-options-grid");
    for (const strategy of parsed.strategies) {
      const optionButton = designElement("button", "uw-agent-option");
      optionButton.type = "button";
      const selectedValue = `${strategy.id}：${strategy.title}`;
      optionButton.dataset.selected = String(agentStrategy?.value?.trim() === selectedValue);
      optionButton.setAttribute("aria-pressed", optionButton.dataset.selected);
      optionButton.appendChild(designElement("strong", "", `${strategy.id} · ${strategy.title}`));
      if (parsed.recommendedStrategyId === strategy.id) optionButton.appendChild(designElement("span", "uw-agent-option-label", "模型推荐 · 待核验"));
      for (const [label, content] of [["做法", strategy.approach], ["取舍", strategy.tradeoffs], ["依据", strategy.evidenceSummary], ["风险", strategy.risks]]) {
        const row = designElement("p");
        row.appendChild(designElement("span", "", `${label} · `));
        row.appendChild(designElement("span", "", content));
        optionButton.appendChild(row);
      }
      optionButton.addEventListener("click", () => {
        if (!agentStrategy || agentStrategy.disabled) return;
        agentStrategy.value = selectedValue;
        for (const sibling of list.children) {
          sibling.dataset.selected = String(sibling === optionButton);
          sibling.setAttribute("aria-pressed", sibling.dataset.selected);
        }
        updateAgentDecisionControls();
        agentChoiceReason?.focus();
      });
      list.appendChild(optionButton);
    }
    agentOptions.appendChild(list);
    if (parsed.openQuestions.length) agentOptions.appendChild(designElement("p", "uw-agent-options-disclaimer", "仍需确认：" + parsed.openQuestions.join("；")));
  }
  function renderAgentDesign() {
    if (!agentDesign || !agentDesignBody) return;
    const basis = designBasis();
    agentDesign.hidden = !basis;
    renderAgentHandoff();
    renderNativeDraft();
    if (!basis) return;
    if (agentDesignRefresh) agentDesignRefresh.disabled = design.busy || design.loading;
    agentDesignBody.replaceChildren();
    if (!design.snapshot) {
      designMessage(design.error || "待生成／导入真实设计。正在检查是否已有保存的设计材料。", design.error ? "blocked" : "waiting");
      return;
    }
    const snapshot = design.snapshot;
    const stateLabel = ({
      not_started: agentDraft && !nativeDraft.editorVisible ? "设计草稿准备中 · 尚未进入人工批准"
        : nativeDraft.sourceApplied ? "未核验的原生设计草稿已预填 · 请检查、修改并保存"
        : "尚无真实设计，请填写系统和模块内容",
      draft: "真实设计已保存，等待人工审阅", reviewing: "设计审阅中 · 按系统、模块顺序确认",
      approved: "系统和模块设计均已确认 · 尚未执行", blocked: "设计待处理 · 检查错误和版本",
    })[snapshot.status] || "设计状态待核实";
    designMessage(design.error || `设计版本 ${snapshot.version} · ${stateLabel}`, design.error ? "blocked" : snapshot.status);
    if (design.error) {
      agentDesignBody.appendChild(designElement("p", "uw-agent-design-note", "当前输入仍保留。先核对服务器版本，避免覆盖其他人的更新。"));
      if (design.pendingMutation && !design.busy) {
        const reconcile = designElement("button", "", "用原修改号安全重试");
        reconcile.type = "button";
        reconcile.addEventListener("click", () => { void submitAgentDesign(design.pendingMutation.action, design.pendingMutation.extra, { retry: true }); });
        agentDesignBody.appendChild(reconcile);
      }
      if (design.stale && !design.pendingMutation) {
        const discard = designElement("button", "", "舍弃本地编辑并读取最新版本");
        discard.type = "button";
        discard.addEventListener("click", () => {
        design.stale = false; design.error = null; design.editTarget = null; design.draft = null;
        if (design.remoteSnapshot) { design.snapshot = design.remoteSnapshot; design.remoteSnapshot = null; renderAgentDesign(); }
        else void loadAgentDesign();
        });
        agentDesignBody.appendChild(discard);
      }
    }
    if (snapshot.status === "not_started") {
      if (agentDraft && !nativeDraft.editorVisible) {
        agentDesignBody.appendChild(designElement("p", "uw-agent-design-note", "自动设计先按已采纳方案生成。完整草稿到达后会展开可编辑的系统级 PRD 与模块任务图；如客户端不可用，可点“改用手工填写”。"));
        return;
      }
      if (!design.draft) design.draft = { system: freshSystem(), modules: [freshModule(1)] };
      const overview = designElement("section", "uw-agent-design-panel");
      overview.appendChild(designElement("h4", "", "系统级 PRD · 基本设计"));
      overview.appendChild(designInputFields(design.draft.system, "system"));
      agentDesignBody.appendChild(overview);
      const modules = designElement("section", "uw-agent-design-panel");
      modules.appendChild(designElement("h4", "", `模块级任务图 · ${design.draft.modules.length} 个模块`));
      for (const [index, module] of design.draft.modules.entries()) {
        const item = designElement("details", "uw-agent-design-panel");
        item.open = index === design.draft.modules.length - 1;
        item.appendChild(designElement("summary", "", `${index + 1}. ${module.title?.trim() || "待填写模块"} · ${module.id}`));
        item.appendChild(designInputFields(module, "module"));
        item.appendChild(designDependencies(module, design.draft.modules));
        if (design.draft.modules.length > 1) item.appendChild(designButton("移除这个未提交模块", () => {
          design.draft.modules = design.draft.modules.filter((candidate) => candidate.id !== module.id);
          for (const entry of design.draft.modules) entry.dependencies = entry.dependencies.filter((id) => id !== module.id);
          renderAgentDesign();
        }));
        modules.appendChild(item);
      }
      const controls = designElement("div", "uw-agent-design-actions");
      controls.appendChild(designButton("添加模块", () => {
        if (design.draft.modules.length >= 32) { designMessage("一个设计最多 32 个模块。", "blocked"); return; }
        let index = 1;
        while (design.draft.modules.some((item) => item.id === freshModule(index).id)) index += 1;
        design.draft.modules.push(freshModule(index)); renderAgentDesign();
      }, design.draft.modules.length >= 32));
      controls.appendChild(designButton("保存设计并进入人工审阅", () => { void submitAgentDesign("submit", {
        design: design.draft,
        ...(nativeDraft.sourceApplied && nativeDraft.snapshot?.status === "completed"
          ? { sourceDraftDigest: nativeDraft.snapshot.draftDigest } : {}),
      }); }));
      modules.appendChild(controls);
      agentDesignBody.appendChild(modules);
      return;
    }
    const system = snapshot.system;
    if (system) {
      const panel = designElement("section", "uw-agent-design-panel");
      panel.appendChild(designElement("h4", "", `系统级 PRD · ${system.title || "未命名"}`));
      designApproval(panel, system.approval);
      if (design.editTarget === "system") {
        panel.appendChild(designInputFields(design.draft.system, "system"));
        const actions = designElement("div", "uw-agent-design-actions");
        actions.appendChild(designButton("保存系统修改", () => { void submitAgentDesign("revise_system", { system: design.draft.system }); }));
        actions.appendChild(designButton("取消修改", () => { design.editTarget = null; design.draft = null; renderAgentDesign(); }));
        panel.appendChild(actions);
      } else {
        panel.appendChild(designFacts([["目标", system.goal], ["架构与技术边界", system.architecture],
          ["技术栈", system.techStack], ["系统验收", (system.acceptance || []).join("\n")]]));
        const actions = designElement("div", "uw-agent-design-actions");
        actions.appendChild(designButton("修改系统", () => { design.editTarget = "system"; design.draft = { system: copyDesign(system) }; renderAgentDesign(); }));
        actions.appendChild(designButton(system.approval?.state === "approved" ? "撤销系统批准" : "批准系统设计", () => {
          void submitAgentDesign(system.approval?.state === "approved" ? "revoke" : "approve", { target: { kind: "system" } });
        }, Boolean(design.editTarget)));
        panel.appendChild(actions);
      }
      agentDesignBody.appendChild(panel);
    }
    const modules = Array.isArray(snapshot.modules) ? snapshot.modules : [];
    const list = designElement("section", "uw-agent-design-panel");
    list.appendChild(designElement("h4", "", `模块级任务图 · ${modules.length} 个模块`));
    // Keep the next decision in view. The user should not have to open every
    // collapsed card to discover which dependency-ordered approval is ready.
    const actionableModule = modules.find((module) => module.approval?.state !== "approved"
      && system?.approval?.state === "approved"
      && (module.dependencies || []).every((id) => modules.find((entry) => entry.id === id)?.approval?.state === "approved"));
    const focusModuleId = actionableModule?.id || modules.find((module) => module.approval?.state !== "approved")?.id;
    for (const [index, module] of modules.entries()) {
      const item = designElement("details", "uw-agent-design-panel");
      item.open = design.editTarget === module.id || (!design.editTarget && module.id === focusModuleId);
      item.dataset.current = String(module.id === actionableModule?.id);
      const summary = designElement("summary", "uw-agent-module-summary");
      summary.appendChild(designElement("span", "uw-agent-module-title", `${index + 1}. ${module.title || module.id}`));
      const status = module.approval?.state === "approved" ? "✓ 已批准" :
        module.approval?.state === "invalidated" ? "需重新确认" :
          module.approval?.state === "revoked" ? "已撤销" : "待确认";
      const statusBadge = designElement("span", "uw-agent-module-state", status);
      statusBadge.dataset.state = module.approval?.state || "pending";
      summary.appendChild(statusBadge);
      item.appendChild(summary);
      designApproval(item, module.approval);
      if (design.editTarget === module.id) {
        const edit = design.draft.module;
        item.appendChild(designInputFields(edit, "module"));
        item.appendChild(designDependencies(edit, modules));
        const actions = designElement("div", "uw-agent-design-actions");
        actions.appendChild(designButton("保存模块修改", () => { void submitAgentDesign("revise_module", { module: edit }); }));
        actions.appendChild(designButton("取消修改", () => { design.editTarget = null; design.draft = null; renderAgentDesign(); }));
        item.appendChild(actions);
      } else {
        item.appendChild(designFacts([["目标", module.objective], ["输入契约", (module.inputContract || []).join("\n")],
          ["输出契约", (module.outputContract || []).join("\n")], ["边界", (module.boundaries || []).join("\n")],
          ["验收", (module.acceptance || []).join("\n")],
          ["依赖", (module.dependencies || []).map((id) => modules.find((entry) => entry.id === id)?.title || id).join(" · ") || "无"]]));
        const actions = designElement("div", "uw-agent-design-actions");
        actions.appendChild(designButton("修改模块", () => { design.editTarget = module.id; design.draft = { module: copyDesign(module) }; renderAgentDesign(); }));
        const prereqsReady = (module.dependencies || []).every((id) => modules.find((entry) => entry.id === id)?.approval?.state === "approved");
        const canApprove = system?.approval?.state === "approved" && prereqsReady;
        actions.appendChild(designButton(module.approval?.state === "approved" ? "撤销模块批准" : "批准模块设计", () => {
          void submitAgentDesign(module.approval?.state === "approved" ? "revoke" : "approve", { target: { kind: "module", moduleId: module.id } });
        }, Boolean(design.editTarget) || module.approval?.state !== "approved" && !canApprove));
        item.appendChild(actions);
      }
      list.appendChild(item);
    }
    agentDesignBody.appendChild(list);
  }
  function validDesignDraft(candidate) {
    const system = candidate?.system;
    const modules = candidate?.modules;
    const bounded = (value, max) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;
    const lines = (value, required = true) => Array.isArray(value) && value.length >= (required ? 1 : 0)
      && value.length <= 24 && value.every((line) => bounded(line, 600));
    if (!system || !bounded(system.title, 160) || !bounded(system.goal, 4000)
      || !bounded(system.architecture, 8000) || !bounded(system.techStack, 4000) || !lines(system.acceptance)
      || !Array.isArray(modules) || modules.length < 1 || modules.length > 32) return false;
    const ids = new Set();
    for (const module of modules) {
      if (!/^[a-z][a-z0-9_-]{1,31}$/u.test(module.id || "") || ids.has(module.id) || !bounded(module.title, 160) || !bounded(module.objective, 4000)
        || !lines(module.inputContract) || !lines(module.outputContract) || !lines(module.acceptance)
        || !lines(module.boundaries, false) || !Array.isArray(module.dependencies) || module.dependencies.length > 31
        || new Set(module.dependencies).size !== module.dependencies.length) return false;
      ids.add(module.id);
    }
    if (!modules.every((module) => module.dependencies.every((id) => id !== module.id && ids.has(id)))) return false;
    const byId = new Map(modules.map((module) => [module.id, module]));
    const visited = new Set();
    function acyclic(id, branch = new Set()) {
      if (visited.has(id)) return true;
      if (branch.has(id)) return false;
      branch.add(id);
      for (const dependency of byId.get(id).dependencies) if (!acyclic(dependency, branch)) return false;
      branch.delete(id);
      visited.add(id);
      return true;
    }
    return [...byId.keys()].every((id) => acyclic(id));
  }
  function validAgentDesignSnapshot(payload, basis) {
    if (payload?.schemaVersion !== "meta-kim-agent-design-v1" || !["not_started", "draft", "reviewing", "approved", "blocked"].includes(payload.status)
      || !Number.isSafeInteger(payload.version) || payload.version < 0 || payload.readyForExecution !== false
      || payload.executionAuthorized === true) return false;
    const bound = payload.basis;
    if (payload.status !== "blocked" && (!bound || bound.idempotencyKey !== basis.idempotencyKey
      || bound.requestId !== basis.requestId || bound.planDigest !== basis.planDigest || bound.decisionKey !== basis.decisionKey
      || bound.projectFingerprint !== agent.executionScope?.projectFingerprint
      || bound.selectedStrategy !== agent.pending?.decision?.selectedStrategy
      || bound.selectionReason !== agent.pending?.decision?.selectionReason)) return false;
    if (payload.status === "not_started") return payload.version === 0 && !payload.system && Array.isArray(payload.modules) && payload.modules.length === 0;
    if (payload.status === "blocked") return true;
    return payload.system && typeof payload.system.title === "string" && Array.isArray(payload.modules) && payload.modules.length > 0 && payload.modules.length <= 32;
  }
  async function loadAgentDesign() {
    const basis = designBasis();
    if (!basis || design.loading || design.busy || disposed) return;
    design.loading = true;
    if (!design.snapshot) designMessage("正在核对真实设计与版本…", "checking");
    if (agentDesignRefresh) agentDesignRefresh.disabled = true;
    try {
      const payload = await request("/api/agent/designs", { selection: {}, query: { idempotencyKey: basis.idempotencyKey } });
      if (disposed || designBasis()?.idempotencyKey !== basis.idempotencyKey) return;
      if (!validAgentDesignSnapshot(payload, basis)) throw new Error("Design contract or source binding mismatch");
      if (design.pendingMutation) {
        const found = Array.isArray(payload.history) && payload.history.some((entry) => entry.mutationKey === design.pendingMutation.mutationKey);
        if (found) { design.pendingMutation = null; saveAgent(); }
        else { design.error = "修改结果尚未核实。请查看原始回执，或使用原修改号重试；不会自动重复提交。"; }
      }
      if (design.editTarget && design.snapshot && payload.version !== design.snapshot.version) {
        design.stale = true;
        design.remoteSnapshot = payload;
        design.error = "服务器设计版本已变化，本地修改尚未提交。请核对最新版本后重新编辑。";
      } else {
        design.snapshot = payload;
        design.stale = false;
        design.remoteSnapshot = null;
        if (!design.pendingMutation) design.error = null;
        if (payload.status === "blocked") design.error = "设计读取被阻止：" + (payload.reason || "请检查 B1 采纳回执");
        if (payload.status === "not_started" && agentDraft) void loadNativeDraft({ autoStart: true });
        if (payload.status === "approved" && payload.reviewComplete === true) void loadAgentHandoff();
      }
    } catch (error) {
      if (!disposed) design.error = error.status === 409 ? "设计版本存在冲突，修改尚未被确认。" : "暂时无法核对真实设计，请检查本地服务连接后重试。";
    } finally { design.loading = false; renderAgentDesign(); }
  }
  async function submitAgentDesign(action, extra, { retry = false } = {}) {
    const basis = designBasis();
    if (!basis || design.busy || design.loading || design.stale || disposed || !state.canWrite || !design.snapshot) return false;
    let mutation = design.pendingMutation;
    if (!retry) {
      if (mutation) return false;
      if (action === "submit" && !validDesignDraft(extra.design)) { designMessage("先填齐系统目标、架构、技术栈、验收标准，以及每个模块的输入、输出与验收。", "blocked"); return false; }
      if (action === "revise_system" && !validDesignDraft({ system: extra.system, modules: design.snapshot.modules })) {
        designMessage("系统内容长度或验收条目不符合规则，请核对每个必填项。", "blocked"); return false;
      }
      if (action === "revise_module" && !validDesignDraft({ system: design.snapshot.system,
        modules: design.snapshot.modules.map((item) => item.id === extra.module?.id ? extra.module : item) })) {
        designMessage("模块输入、验收或依赖关系不完整，可能存在循环依赖。请调整后保存。", "blocked"); return false;
      }
      const mutationKey = win.crypto?.randomUUID?.();
      if (!mutationKey) { designMessage("无法创建安全修改号，请使用受支持的浏览器。", "blocked"); return false; }
      mutation = { mutationKey, expectedVersion: design.snapshot.version, action, extra };
      design.pendingMutation = mutation;
      saveAgent();
    } else if (!mutation) return false;
    design.busy = true;
    renderAgentDesign();
    designMessage("正在记录设计修改；完成前不会授权执行。", "checking");
    try {
      const payload = await request("/api/agent/designs", { method: "POST", selection: {}, body: {
        ...basis, action: mutation.action, mutationKey: mutation.mutationKey, expectedVersion: mutation.expectedVersion, ...mutation.extra,
      } });
      if (disposed || designBasis()?.idempotencyKey !== basis.idempotencyKey) return false;
      if (!validAgentDesignSnapshot(payload, basis) || payload.version <= mutation.expectedVersion) throw new Error("Design mutation receipt not authoritative");
      design.snapshot = payload;
      design.pendingMutation = null;
      design.editTarget = null;
      design.draft = null;
      design.error = null;
      saveAgent();
      if (payload.status === "approved" && payload.reviewComplete === true) void loadAgentHandoff();
      return true;
    } catch (error) {
      if (disposed) return false;
      if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
        design.pendingMutation = null; saveAgent();
        design.stale = error.status === 409;
        design.error = error.status === 409 ? "设计版本或前置批准已变化，原修改未写入。请刷新核对后重试。"
          : "设计修改未通过服务端校验：" + (error.message || "请检查字段和依赖关系。");
      } else {
        design.error = "提交回执不确定。保留原修改号，先查询再决定是否重试。";
        design.busy = false;
        await loadAgentDesign();
      }
      return false;
    } finally { design.busy = false; renderAgentDesign(); }
  }
  function agentMessage(kind, message, { verify = false, retry = false, redetect = false, next = false } = {}) {
    agent.status = kind;
    if (agentStatus) {
      agentStatus.hidden = !message;
      agentStatus.dataset.state = kind;
      agentStatus.textContent = message || "";
    }
    desktop?.render();
    if (agentRecovery) agentRecovery.hidden = !(verify || retry || redetect || next);
    if (agentVerify) agentVerify.hidden = !verify;
    if (agentNew) agentNew.hidden = !next || Boolean(agent.decisionPending);
    if (agentRedetect) {
      agentRedetect.hidden = !(retry || redetect);
      agentRedetect.textContent = retry ? "重试同一请求" : "重新检测客户端";
      agentRedetect.dataset.action = retry ? "retry" : "redetect";
    }
    updateAgentControls();
  }
  function updateAgentScope(scope) {
    if (scope?.kind === "server_bound" && typeof scope.projectLabel === "string" && scope.projectLabel.trim()
      && /^[a-f0-9]{64}$/iu.test(scope.projectFingerprint || "")) {
      if (agent.pending?.projectFingerprint && agent.pending.projectFingerprint !== scope.projectFingerprint) {
        agent.pending = null;
        agent.decisionPending = null;
        design.snapshot = null; design.draft = null; design.editTarget = null;
        design.error = null; design.pendingMutation = null; design.remoteSnapshot = null; design.stale = false;
        nativeDraft.snapshot = null; nativeDraft.error = null; nativeDraft.pendingKey = null;
        nativeDraft.autoAttempted = false; nativeDraft.editorVisible = false; nativeDraft.manualOverride = false; nativeDraft.sourceApplied = false;
        handoff.snapshot = null; handoff.error = null; handoff.pendingKey = null;
        execution.snapshot = null; execution.error = null; execution.pendingKey = null;
        acceptance.snapshot = null; acceptance.error = null; acceptance.pendingKey = null;

        agent.scopeMismatch = true;
        if (agentResult) agentResult.hidden = true;
        if (agentOutput) agentOutput.textContent = "";
        renderNativeStrategyOptions("");
        if (agentDecision) agentDecision.hidden = true;
        if (agentDesign) agentDesign.hidden = true;
        if (agentHandoff) agentHandoff.hidden = true;
        saveAgent();
        agentMessage("blocked", "本地服务现在绑定另一个项目。旧项目的研究与审批回执已隔离，请在当前项目发起新任务。", { redetect: true });
      }
      agent.executionScope = scope;
      state.agentServerProjectLabel = scope.projectLabel.trim();
      if (agentScope) { agentScope.textContent = scope.projectLabel; agentScope.title = scope.projectFingerprint || scope.projectLabel; }
      if (agentScopeNote) agentScopeNote.textContent = "由本地服务绑定。左侧切换的项目仅用于查看记录，不会更改这次任务的目标目录。";
      renderer.render();
      return !agent.scopeMismatch;
    } else if (agentScope && !agent.executionScope) {
      agentScope.textContent = "本地服务固定范围（名称尚未核验）";
      if (agentScopeNote) agentScopeNote.textContent = "页面中选中的项目不等于本地执行目录；请以服务端回执为准。";
    }
    return !agent.scopeMismatch;
  }
  function updateAgentDecisionControls() {
    const pending = agent.pending;
    const digestReady = typeof pending?.planDigest === "string" && /^[a-f0-9]{64}$/iu.test(pending.planDigest);
    const hasPreview = Boolean(pending?.resultPreview?.trim());
    const decided = ["adopted_for_design", "revision_requested", "rejected"].includes(pending?.decision?.state);
    const reviewAllowed = !pending?.decision || pending.decision.state === "awaiting_human" || decided;
    const showDecision = agent.status === "completed" && hasPreview && reviewAllowed && (digestReady || decided);
    if (agentDecision) agentDecision.hidden = !showDecision;
    if (agentDecisionReceipt) {
      const label = ({ adopted_for_design: "已记录采纳：进入设计待接续；尚未授权代码执行或完成验收。", revision_requested: "已记录修改意见：等待后续重新研究；原方案不执行。", rejected: "已记录放弃：本方案不进入后续设计或执行。" })[pending?.decision?.state];
      agentDecisionReceipt.hidden = !label && !agent.decisionPending;
      const chosen = pending?.decision?.state === "adopted_for_design" && pending.decision.selectedStrategy
        ? ` 你选了：${pending.decision.selectedStrategy} · 理由：${pending.decision.selectionReason || "未附理由"}。` : "";
      agentDecisionReceipt.textContent = label ? label + chosen : agent.decisionPending ? "决策回执尚未确认，勿重复选择其他操作。" : "";
    }
    const canDecide = agentEntryEnabled && state.canWrite && showDecision && digestReady && !decided && !agent.decisionBusy && !agent.decisionPending;
    if (agentAdopt) agentAdopt.disabled = !canDecide || !agentStrategy?.value?.trim() || !agentChoiceReason?.value?.trim();
    if (agentRevise) agentRevise.disabled = !canDecide || !agentFeedback?.value?.trim();
    if (agentReject) agentReject.disabled = !canDecide;
    if (agentFeedback) agentFeedback.disabled = !canDecide;
    if (agentStrategy) agentStrategy.disabled = !canDecide;
    if (agentChoiceReason) agentChoiceReason.disabled = !canDecide;
    if (agentDecisionRetry) agentDecisionRetry.hidden = !agent.decisionPending || agent.decisionBusy;
    if (agentResultSummary) agentResultSummary.textContent = decided ? "研究方案 · 决策已记录" : "研究建议 · 等待你确认";
  }
  function launchableHosts() {
    // An explicit provider selection must never accidentally consume the
    // owner's Codex credentials; the backend enforces the same restriction.
    return agent.hosts.filter((host) => host.available === true && host.launchSupported === true && !/codex/iu.test(host.id));
  }
  function autoHostAvailable() { return launchableHosts().some((host) => host.id === agent.recommendedHostId); }
  function updateAgentControls() {
    const canLaunch = agentEntryEnabled && state.canWrite && agent.executionAllowed && !agent.loading && !agent.busy && !agent.pending
      && (launchableHosts().some((host) => host.id === agentHost?.value) || agentHost?.value === "auto" && autoHostAvailable());
    if (agentHost) agentHost.disabled = !agentEntryEnabled || !state.canWrite || !agent.executionAllowed || agent.loading || agent.busy || !launchableHosts().length;
    if (chatHostSelect) chatHostSelect.disabled = Boolean(agentHost?.disabled);
    if (agentSubmit) {
      agentSubmit.disabled = !canLaunch || !agentGoal?.value?.trim();
      agentSubmit.setAttribute("aria-busy", agent.busy ? "true" : "false");
    }
    updateAgentDecisionControls();
  }
  function populateAgentHosts() {
    if (!agentHost) return;
    const previousHost = chatHostSelect?.value || agentHost.value;
    const entries = agent.hosts.filter((host) => host && typeof host.id === "string" && host.id && typeof host.label === "string");
    agentHost.textContent = "";
    if (chatHostSelect) chatHostSelect.textContent = "";
    const appendBothOptions = (val, label, disabled = false, titleText = "") => {
      const opt1 = doc.createElement("option");
      opt1.value = val; opt1.textContent = label; opt1.disabled = disabled;
      if (titleText) opt1.title = titleText;
      agentHost.appendChild(opt1);
      if (chatHostSelect) {
        const opt2 = doc.createElement("option");
        opt2.value = val; opt2.textContent = label; opt2.disabled = disabled;
        if (titleText) opt2.title = titleText;
        chatHostSelect.appendChild(opt2);
      }
    };
    if (!entries.length) {
      appendBothOptions("", "没有可用渠道");
    } else {
      const recHost = entries.find((h) => h.id === agent.recommendedHostId) || launchableHosts()[0];
      if (autoHostAvailable()) {
        appendBothOptions("auto", recHost ? `自动优选（${recHost.label}）` : "自动选择可用客户端 · 只读研究");
      }
      for (const host of entries) {
        const supported = launchableHosts().includes(host);
        appendBothOptions(
          host.id,
          host.label + (supported ? " · 就绪" : " · 不可直接启动"),
          !supported,
          host.reason ? String(host.reason) : "",
        );
      }
      const usable = launchableHosts();
      const nextValue = (previousHost === "auto" && autoHostAvailable() || usable.some((item) => item.id === previousHost))
        ? previousHost : autoHostAvailable() ? "auto" : usable[0]?.id || "";
      agentHost.value = nextValue;
      if (chatHostSelect) chatHostSelect.value = nextValue;
    }
    if (agentHostStatus && agentHostList) {
      agentHostList.textContent = "";
      for (const host of entries) {
        const item = doc.createElement("li");
        const active = launchableHosts().includes(host);
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
      agent.hostRetryCount = 0;
      if (agent.hostRetryTimer) { win.clearTimeout(agent.hostRetryTimer); agent.hostRetryTimer = null; }
      agent.recommendedHostId = typeof payload.recommendedHostId === "string" ? payload.recommendedHostId : null;
      updateAgentScope(payload.executionScope);
      populateAgentHosts();
      // A recovered tab must not stay parked on an unverified receipt just
      // because its first host-discovery call hit a cold-start listener.
      if (agent.pending && agent.status === "unconfirmed"
        && agent.executionScope?.projectFingerprint === agent.pending.projectFingerprint) {
        agentMessage("unconfirmed", "已确认所属项目，正在按原请求号核对研究回执…", { verify: true });
        void verifyAgentRequest();
      }
      if (!agent.pending && !agent.scopeMismatch) {
        if (!agent.executionAllowed) agentMessage("blocked", "当前环境尚未开放客户端启动权限。可继续查看已有记录。");
        else if (!launchableHosts().length) agentMessage("blocked", "暂未找到可启动的客户端。只读研究需要已审阅的 Claude Code，请检查安装与连接；若已有采纳方案，仍可在 B2 手工填写设计。客户端原因见下方。", { redetect: true });
        else agentMessage("idle", "");
      }
    } catch {
      if (disposed) return;
      agent.hosts = []; agent.executionAllowed = false; populateAgentHosts();
      if (agent.hostRetryCount < 2) {
        agent.hostRetryCount += 1;
        if (!agent.pending) agentMessage("checking", `客户端连接还在准备，正在自动重试（${agent.hostRetryCount}/2）…`);
        agent.hostRetryTimer = win.setTimeout(() => {
          agent.hostRetryTimer = null;
          if (!disposed) void loadAgentHosts();
        }, agent.hostRetryCount * 1200);
      } else if (!agent.pending) agentMessage("unconfirmed", "客户端状态获取失败，请检查当前工作台连接后重试。", { redetect: true });
    } finally { agent.loading = false; updateAgentControls(); }
  }
  function showAgentReceipt(payload) {
    if (!agent.pending) return;
    const receiptStatus = payload?.status;
    if (payload?.executionScope && !updateAgentScope(payload.executionScope)) return;
    if (!agent.pending) return;
    if (typeof payload?.requestId === "string" && payload.requestId) agent.pending.requestId = payload.requestId;
    if (typeof payload?.selectedHostId === "string" && payload.selectedHostId) agent.pending.selectedHostId = payload.selectedHostId;
    if (typeof payload?.planDigest === "string") agent.pending.planDigest = payload.planDigest;
    if (payload?.decision && typeof payload.decision === "object") {
      agent.pending.decision = payload.decision;
      if (["adopted_for_design", "revision_requested", "rejected"].includes(payload.decision.state)) agent.decisionPending = null;
    }
    if (payload?.capabilityState && typeof payload.capabilityState === "object") {
      agent.pending.capabilityState = payload.capabilityState;
    }
    const methodState = agent.pending.capabilityState;
    const hostNote = agent.pending.hostId === "auto"
      ? (agent.pending.selectedHostId ? " · 已确认研究客户端：" + (agent.hosts.find((host) => host.id === agent.pending.selectedHostId)?.label || agent.pending.selectedHostId)
        : " · 实际研究客户端尚待回执确认") : "";
    const methodNote = (methodState?.status === "verified_local_method_bound" && methodState.methodProvidedToRuntime === true
      ? " · Kim_Service 专业方法已关联（来源已核验）" : "") + hostNote;
    // An excerpt is not an approvable plan. The native adapter must supply a
    // complete bounded preview or explicitly refuse human adoption.
    const preview = receiptStatus === "completed" && typeof payload?.resultPreview === "string"
      && payload.resultPreview.length <= 2400 ? payload.resultPreview.trim() : "";
    if (receiptStatus === "completed") agent.pending.resultPreview = preview;
    if (agentResult) { agentResult.hidden = !preview; agentResult.open = Boolean(preview); }
    // Never render untrusted model output as HTML, even inside a local app.
    if (agentOutput) agentOutput.textContent = preview;
    renderNativeStrategyOptions(preview);
    if (payload?.runId && typeof payload.runId === "string") agent.pending.runId = payload.runId;
    if (receiptStatus === "accepted") {
      agentMessage("accepted", (agent.pending.runId ? "只读研究请求已接收，原生会话记录已建立。" : "已接单，等待客户端建立会话。") + methodNote, { verify: true });
    } else if (receiptStatus === "running") {
      agentMessage("running", (agent.pending.runId ? "客户端已确认开始运行只读研究，可查看原生记录。" : "客户端已确认开始运行只读研究，等待关联运行记录。") + methodNote, { verify: true });
    } else if (receiptStatus === "completed") {
      agentMessage("completed", preview
        ? (["adopted_for_design", "revision_requested", "rejected"].includes(agent.pending.decision?.state)
          ? "只读研究结束，人工决策已有记录。后续设计与执行仍需真实运行接续。"
          : agent.pending.decision?.state === "not_ready" || agent.pending.decision?.state === "unavailable_no_plan"
            ? "服务端尚未开放此方案的人工确认，请检查研究产物和回执。"
            : "只读研究已返回建议，请核对后决定是否用于设计。") + methodNote
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
    saveAgent();
    updateAgentControls();
    renderAgentDesign();
    if (agentDesign && designBasis() && !design.snapshot && !design.loading) void loadAgentDesign();
  }
  async function submitAgentDecision(action, { retry = false } = {}) {
    const pending = agent.pending;
    if (!pending || agent.decisionBusy || disposed || !state.canWrite || agent.status !== "completed") return false;
    let decision = agent.decisionPending;
    if (!retry) {
      if (decision || pending.decision && pending.decision.state !== "awaiting_human") return false;
      const feedback = agentFeedback?.value?.trim() || "";
      const selectedStrategy = agentStrategy?.value?.trim() || "";
      const selectionReason = agentChoiceReason?.value?.trim() || "";
      if (action === "revise" && !feedback) { agentMessage("blocked", "请先填写你希望修改的地方。"); return false; }
      if (feedback.length > 2000) { agentMessage("blocked", "修改意见不能超过 2000 字。"); return false; }
      if (action === "adopt" && (!selectedStrategy || !selectionReason || selectedStrategy.length > 180 || selectionReason.length > 1200)) {
        agentMessage("blocked", "采纳前请写清你选择的方案（180 字内）以及理由（1200 字内）。"); return false;
      }
      if (!pending.requestId || !/^[a-f0-9]{64}$/iu.test(pending.planDigest || "")) {
        agentMessage("unconfirmed", "缺少可核对的方案版本或回执，请先检查提交结果。", { verify: true }); return false;
      }
      const key = win.crypto?.randomUUID?.();
      if (!key) { agentMessage("blocked", "当前浏览器无法生成安全决策号，请换用受支持的浏览器。"); return false; }
      decision = { key, action, feedback, ...(action === "adopt" ? { selectedStrategy, selectionReason } : {}), planDigest: pending.planDigest, requestId: pending.requestId };
      agent.decisionPending = decision;
      saveAgent();
    } else if (!decision) return false;
    agent.decisionBusy = true; updateAgentDecisionControls();
    if (agentDecisionReceipt) { agentDecisionReceipt.hidden = false; agentDecisionReceipt.textContent = retry ? "正在重试同一决策号…" : "正在记录你的选择…"; }
    try {
      const payload = await request("/api/agent/decisions", { method: "POST", selection: {}, body: {
        idempotencyKey: pending.key, requestId: decision.requestId, planDigest: decision.planDigest,
        action: decision.action, ...(decision.feedback ? { feedback: decision.feedback } : {}),
        ...(decision.action === "adopt" ? { selectedStrategy: decision.selectedStrategy, selectionReason: decision.selectionReason } : {}),
        decisionKey: decision.key,
      } });
      if (disposed || agent.pending !== pending) return false;
      if (payload?.schemaVersion !== "meta-kim-agent-decision-v1" || payload.status !== "recorded"
        || payload.executionAuthorized !== false || !payload.decision?.state) throw new Error("Decision receipt contract mismatch");
      pending.decision = payload.decision;
      agent.decisionPending = null;
      agentMessage("completed", "你的选择已记录。设计准备尚待接续，没有启动实际执行或验收。", { verify: true, next: true });
      saveAgent();
      renderAgentDesign();
      if (agentDesign && designBasis()) void loadAgentDesign();
      return true;
    } catch (error) {
      if (disposed || agent.pending !== pending) return false;
      if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
        agent.decisionPending = null;
        agentMessage("unconfirmed", "决策没有被接受：" + (error.message || "请重新读取方案版本。"), { verify: true });
        saveAgent();
      } else {
        // Unknown POST outcomes must reconcile against the original request.
        agentMessage("unconfirmed", "决策回执暂未确定，正在查询服务器。请勿另选操作。", { verify: true });
        agent.decisionBusy = false;
        await verifyAgentRequest();
      }
      return false;
    } finally { agent.decisionBusy = false; updateAgentDecisionControls(); }
  }
  async function verifyAgentRequest() {
    if (!agent.pending || agent.busy || disposed) return;
    const pending = agent.pending;
    agent.busy = true; updateAgentControls();
    try {
      const payload = await request("/api/agent/requests", { query: { idempotencyKey: pending.key }, selection: {} });
      if (disposed || agent.pending !== pending) return;
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
      if (!launchableHosts().some((host) => host.id === hostId) && !(hostId === "auto" && autoHostAvailable())) { agentMessage("blocked", "请选择可以启动的客户端，或重新检测客户端。", { redetect: true }); return; }
      const key = win.crypto?.randomUUID?.();
      if (!key) { agentMessage("blocked", "当前浏览器无法生成安全请求号，请使用受支持的浏览器。 "); return; }
      launch = { key, goal, hostId, runId: null, ...(agent.executionScope?.projectFingerprint ? { projectFingerprint: agent.executionScope.projectFingerprint } : {}) };
      agent.pending = launch;
      agent.decisionPending = null;
      agent.scopeMismatch = false;
      saveAgent();
      if (agentResult) agentResult.hidden = true;
      if (agentOutput) agentOutput.textContent = "";
      renderNativeStrategyOptions("");
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
        saveAgent();
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
  const dockedAnchors = new Map();
  let dockedMetaDetails = null;
  function ensureOriginAnchor(element) {
    if (!element || dockedAnchors.has(element)) return dockedAnchors.get(element) || null;
    if (!element.parentNode || typeof doc.createComment !== "function") return null;
    const marker = doc.createComment("uw-dock-origin");
    element.parentNode.insertBefore(marker, element);
    dockedAnchors.set(element, marker);
    return marker;
  }
  function restoreToOriginAnchor(element) {
    const marker = dockedAnchors.get(element);
    if (element && marker?.parentNode) {
      marker.parentNode.insertBefore(element, marker.nextSibling);
    }
  }
  function ensureDockedMetaBar(slot) {
    if (dockedMetaDetails) return dockedMetaDetails;
    if (typeof doc.createElement !== "function") return null;
    const details = doc.createElement("details");
    details.className = "uw-docked-run-meta";
    details.dataset.uwDockedRunMeta = "true";
    const summary = doc.createElement("summary");
    summary.className = "uw-docked-run-meta-summary";
    const titleSpan = doc.createElement("span");
    titleSpan.className = "uw-docked-run-meta-title";
    titleSpan.dataset.uwDockedMetaTitle = "true";
    titleSpan.textContent = translateAgentUi("运行摘要与工作清单", state.language || "zh");
    const actionsWrap = doc.createElement("span");
    actionsWrap.className = "uw-docked-run-meta-actions";
    const switchRunBtn = doc.createElement("button");
    switchRunBtn.type = "button";
    switchRunBtn.className = "uw-docked-switch-btn";
    switchRunBtn.dataset.uwDockedOpenSessions = "true";
    switchRunBtn.textContent = translateAgentUi("切换运行记录", state.language || "zh");
    switchRunBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      options.openProjects?.();
    });
    const toggleHint = doc.createElement("span");
    toggleHint.className = "uw-docked-meta-hint";
    toggleHint.dataset.uwDockedMetaHint = "true";
    toggleHint.textContent = translateAgentUi("展开摘要", state.language || "zh");
    details.addEventListener("toggle", () => {
      toggleHint.textContent = translateAgentUi(details.open ? "收起摘要" : "展开摘要", state.language || "zh");
      if (win?.requestAnimationFrame) win.requestAnimationFrame(() => win.dispatchEvent?.(new win.Event("resize")));
    });
    actionsWrap.append(switchRunBtn, toggleHint);
    summary.append(titleSpan, actionsWrap);
    const body = doc.createElement("div");
    body.className = "uw-docked-run-meta-body";
    body.dataset.uwDockedMetaBody = "true";
    details.append(summary, body);
    dockedMetaDetails = details;
    if (slot) slot.prepend?.(details);
    return details;
  }
  function syncDockedMetaCopy() {
    if (!dockedMetaDetails) return;
    const lang = state.language || "zh";
    const titleEl = dockedMetaDetails.querySelector?.("[data-uw-docked-meta-title]");
    const runTitle = state.snapshot?.run?.title;
    const baseLabel = translateAgentUi("运行摘要与工作清单", lang);
    if (titleEl) titleEl.textContent = runTitle ? `${baseLabel} · ${runTitle}` : baseLabel;
    const switchBtn = dockedMetaDetails.querySelector?.("[data-uw-docked-open-sessions]");
    if (switchBtn) switchBtn.textContent = translateAgentUi("切换运行记录", lang);
    const hintEl = dockedMetaDetails.querySelector?.("[data-uw-docked-meta-hint]");
    if (hintEl) hintEl.textContent = translateAgentUi(dockedMetaDetails.open ? "收起摘要" : "展开摘要", lang);
  }
  function dockLiveRunView(docked) {
    const runPanel = app.querySelector("[data-live-run-view]");
    const inspectorPanel = app.querySelector("[data-live-inspector]");
    const runContext = app.querySelector(".run-context");
    const runOverview = app.querySelector("[data-live-run-overview]");
    const emptyPanel = app.querySelector("[data-live-empty]");
    const slot = root.querySelector("[data-uw-docked-run-slot]");
    const wsGrid = app.querySelector(".workspace-grid");
    if (!runPanel || !wsGrid) return;
    if (docked && slot) {
      for (const el of [runContext, runOverview, runPanel, inspectorPanel, emptyPanel]) ensureOriginAnchor(el);
      if (app.dataset) app.dataset.dockedLiveRun = "true";
      root.dataset.dockedLiveRun = "true";
      const metaBar = ensureDockedMetaBar(slot);
      const metaBody = metaBar?.querySelector?.("[data-uw-docked-meta-body]");
      if (metaBar && metaBar.parentElement !== slot) slot.prepend(metaBar);
      if (metaBody) {
        if (runContext && runContext.parentElement !== metaBody) metaBody.append(runContext);
        if (runOverview && runOverview.parentElement !== metaBody) metaBody.append(runOverview);
      }
      if (runPanel.parentElement !== slot) slot.append(runPanel);
      if (inspectorPanel && inspectorPanel.parentElement !== slot) slot.append(inspectorPanel);
      if (emptyPanel && emptyPanel.parentElement !== slot) slot.append(emptyPanel);
      const hasRun = Boolean(state.snapshot?.run);
      runPanel.hidden = !hasRun;
      if (emptyPanel) emptyPanel.hidden = hasRun;
      const stageOverview = runPanel.querySelector?.(".stage-overview");
      if (stageOverview && !stageOverview.dataset?.uwInitOpened) {
        if (stageOverview.dataset) stageOverview.dataset.uwInitOpened = "true";
        stageOverview.open = true;
      }
      syncDockedMetaCopy();
      slot.hidden = false;
      const syncRunCamera = () => {
        options.refreshLiveRunGraph?.();
        win?.dispatchEvent?.(new win.Event("resize"));
      };
      if (win?.requestAnimationFrame) win.requestAnimationFrame(syncRunCamera);
      else syncRunCamera();
    } else {
      if (app.dataset) delete app.dataset.dockedLiveRun;
      delete root.dataset.dockedLiveRun;
      for (const el of [runContext, runOverview, runPanel, inspectorPanel, emptyPanel]) restoreToOriginAnchor(el);
      if (runPanel.parentElement === slot) wsGrid.append(runPanel);
      if (inspectorPanel && inspectorPanel.parentElement === slot) wsGrid.append(inspectorPanel);
      if (slot) slot.hidden = true;
      const onFullRun = state.externalView === "graph";
      runPanel.hidden = !onFullRun;
      if (emptyPanel && !onFullRun) emptyPanel.hidden = true;
    }
  }
  function setView(view, { updateUrl = true } = {}) {
    if (view !== "work" || ["graph", "repository"].includes(view)) dockLiveRunView(false);
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
  desktop = agentEntryEnabled && typeof createUnifiedAgentDesktop === "function" ? createUnifiedAgentDesktop({
    root, state, agent, design, nativeDraft, handoff, execution, acceptance, copy,
    translateUi: (value) => translateAgentUi(value, state.language || "zh"),
    createWorkflowCanvas: createDynamicPrdWorkflowCanvas,
    buildGraph: buildLivePrdGraph, createGraph: createPrdKnowledgeGraph,
    callbacks: {
      parseStrategies: parseNativeStrategyOptions,
      startGoal(goal) {
        if (!agentGoal || !agentSubmit) return false;
        agentGoal.value = goal;
        updateAgentControls();
        if (agentSubmit.disabled) {
          agentMessage("blocked", "当前尚无可用且已核验的研究客户端。请检查本机客户端和项目执行范围。");
          return false;
        }
        void submitAgent();
        return true;
      },
      adopt(strategy, reason) {
        if (!agentStrategy || !agentChoiceReason || agent.decisionPending || agent.decisionBusy) return false;
        agentStrategy.value = strategy;
        agentChoiceReason.value = reason;
        updateAgentDecisionControls();
        return submitAgentDecision("adopt");
      },
      revise(message) {
        if (!agentFeedback || agent.decisionPending || agent.decisionBusy) return false;
        agentFeedback.value = message;
        updateAgentDecisionControls();
        return submitAgentDecision("revise");
      },
      reject() { void submitAgentDecision("reject"); },
      redetect() {
        agent.hostRetryCount = 0;
        void Promise.all([
          loadAgentHosts(),
          loadAgentCapabilities({ force: true }),
          loadAgentArchitecture({ force: true, projectId: state.selection?.projectId || "" }),
        ]);
      },
      selectHostChannel(hostId) {
        if (!agentHost || !hostId) return;
        agentHost.value = hostId;
        if (chatHostSelect) chatHostSelect.value = hostId;
        updateAgentControls();
        desktop?.render();
      },
      getSelectedHostChannel: () => chatHostSelect?.value || agentHost?.value || "auto",
      openProjectPicker: () => options.openProjects?.(),
      selectProjectRun: (projId, runId) => options.selectProjectRun?.(projId || state.selection?.projectId || "", runId || ""),
      async bindExternalSession({ runtime, sessionId, turnId }) {
        try {
          const res = await request("/api/agent/bindings", {
            method: "POST",
            selection: {},
            runScoped: false,
            body: {
              projectId: state.selection?.projectId || undefined,
              runtime,
              sessionId,
              turnId,
            },
          });
          if (res?.status === "bound" && res?.runId) {
            await options.reloadCatalog?.();
            options.selectProjectRun?.(res.projectId || state.selection?.projectId || "", res.runId);
            void loadAgentArchitecture({ force: true, projectId: res.projectId || state.selection?.projectId || "" });
            return { ok: true, runId: res.runId };
          }
          return { ok: false };
        } catch {
          return { ok: false };
        }
      },
      verifyRequest() { void verifyAgentRequest(); },
      reconcileDecision() {
        if (agent.decisionPending?.action) void submitAgentDecision(agent.decisionPending.action, { retry: true });
      },
      newTask() {
        if (!agent.pending || agent.status !== "completed" || agent.busy || agent.decisionPending) return false;
        agentNew?.click();
        return !agent.pending;
      },
      saveDraft() {
        if (!nativeDraft.sourceApplied || !design.draft || design.snapshot?.status !== "not_started") return;
        void submitAgentDesign("submit", {
          design: design.draft,
          ...(nativeDraft.snapshot?.status === "completed" ? { sourceDraftDigest: nativeDraft.snapshot.draftDigest } : {}),
        });
      },
      retryDraft() { void startNativeDraft(); },
      reconcileDraft() { void loadNativeDraft(); },
      approveNode(kind, id) {
        void submitAgentDesign("approve", { target: kind === "system" ? { kind } : { kind, moduleId: id } });
      },
      confirmNodeMockup(moduleId) {
        void submitAgentDesign("confirm_mockup", { moduleId });
      },
      async mutatePrdWorkflow(mutation, activeBlueprint) {
        if (!mutation || !state.canWrite || state.prdWorkflowBusy) return false;
        if (activeBlueprint?.kind === "agent_saved_design" && design.snapshot?.system) {
          if (mutation.action === "confirm_mockup") {
            return submitAgentDesign("confirm_mockup", { moduleId: mutation.nodeId });
          }
          if (mutation.action === "revise_mockup") {
            const targetMod = design.snapshot.modules.find((m) => m.id === mutation.nodeId);
            if (!targetMod) return false;
            const nextVer = (targetMod.uiMockup?.version || 1) + 1;
            return submitAgentDesign("revise_mockup", {
              moduleId: mutation.nodeId,
              uiMockup: {
                status: "pending",
                version: nextVer,
                mode: "wireframe_fallback",
                variant: targetMod.uiMockup?.variant || "workbench",
                imageUrl: null,
                prompt: null,
                lastFeedback: String(mutation.feedback || "界面结构优化").slice(0, 600),
              },
            });
          }
          if (mutation.action === "update_node") {
            const targetMod = design.snapshot.modules.find((m) => m.id === mutation.nodeId);
            if (!targetMod) return false;
            const updatedMod = copyDesign(targetMod);
            delete updatedMod.approval;
            if (mutation.title) updatedMod.title = mutation.title;
            if (mutation.objective) updatedMod.objective = mutation.objective;
            if (typeof mutation.hasUiPage === "boolean") updatedMod.hasUiPage = mutation.hasUiPage;
            return submitAgentDesign("revise_module", { module: updatedMod });
          }
          if (mutation.action === "delete_node") {
            return submitAgentDesign("remove_module", { moduleId: mutation.nodeId });
          }
          if (mutation.action === "add_parallel" || mutation.action === "insert_on_edge") {
            const newId = `mod-${(win.crypto?.randomUUID?.() || String(Date.now())).slice(0, 8)}`.toLowerCase();
            const hasUiPage = mutation.hasUiPage !== false;
            const title = mutation.title || (hasUiPage ? "新增页面模块" : "新增并行模块");
            const firstDep = design.snapshot.modules[0]?.id ? [design.snapshot.modules[0].id] : [];
            return submitAgentDesign("add_module", {
              module: {
                id: newId,
                title,
                objective: `实时插入的${hasUiPage ? "前端页面" : "并行处理"}模块`,
                inputContract: ["承接上游流转输入"],
                outputContract: ["输出至下游模块"],
                boundaries: [hasUiPage ? "须先确认页面效果图再执行" : "独立并发执行"],
                acceptance: [`${title}交互与流转符合预期`],
                dependencies: firstDep,
                nodeKind: mutation.action === "add_parallel" ? "parallel" : "process",
                hasUiPage,
              },
            });
          }
        }
        state.prdWorkflowBusy = true;
        desktop?.render();
        try {
          const updated = await request("/api/agent/prd-workflow", {
            method: "POST",
            selection: {},
            runScoped: false,
            body: {
              ...(state.selection?.projectId && { projectId: state.selection.projectId }),
              ...mutation,
            },
          });
          if (updated?.schemaVersion === "meta-kim-prd-workflow-canvas-v1") {
            state.prdWorkflowCanvas = updated;
          }
          return true;
        } catch {
          return false;
        } finally {
          state.prdWorkflowBusy = false;
          desktop?.render();
        }
      },
      approveAllAndPrepare() {
        void approveAllAndPrepareHandoff();
      },
      requestRevision(kind, id, feedback) {
        return submitAgentDesign("request_revision", {
          target: kind === "system" ? { kind } : { kind, moduleId: id }, feedback,
        });
      },
      reviseField(kind, id, label, rawValue) {
        const map = kind === "system" ? {
          "标题": "title", "名称": "title", "目标": "goal", "整体架构": "architecture", "架构": "architecture", "技术栈": "techStack", "验收": "acceptance",
        } : {
          "标题": "title", "名称": "title", "目标": "objective", "输入": "inputContract", "输出": "outputContract",
          "边界": "boundaries", "验收": "acceptance", "依赖": "dependencies",
        };
        const field = map[label];
        const record = kind === "system" ? design.snapshot?.system : design.snapshot?.modules?.find(item => item.id === id);
        if (!field || !record || !rawValue?.trim() || design.pendingMutation || design.busy || design.stale) return false;
        const updated = copyDesign(record);
        const arrayField = ["acceptance", "inputContract", "outputContract", "boundaries", "dependencies"].includes(field);
        const parts = rawValue.split(field === "dependencies" ? /[\n,，、;；]+/u : /[\n;；]+/u).map(part => part.trim()).filter(Boolean);
        updated[field] = arrayField ? (field === "boundaries" && rawValue.trim() === "无" ? [] : parts) : rawValue.trim();
        const candidate = kind === "system" ? { system: updated, modules: design.snapshot.modules }
          : { system: design.snapshot.system, modules: design.snapshot.modules.map(item => item.id === id ? updated : item) };
        if (!validDesignDraft(candidate)) return false;
        return submitAgentDesign(kind === "system" ? "revise_system" : "revise_module",
          kind === "system" ? { system: updated } : { module: updated });
      },
      reconcileDesign() {
        if (design.pendingMutation) void loadAgentDesign();
        else if (design.stale) { design.editTarget = null; design.draft = null; design.stale = false; void loadAgentDesign(); }
        else void loadAgentDesign();
      },
      prepareHandoff() { void prepareAgentHandoff(); },
      reconcileHandoff() { void loadAgentHandoff(); },
      authorizeExecution() { void submitAgentExecution(); },
      inspectExecution() { void loadAgentExecution(); },
      verifyDeliverables() { void verifyAgentAcceptance(); },
      acceptDeliverables(summary) { void decideAgentAcceptance("accept", { summary }); },
      requestDeliverableRework(moduleId, feedback) {
        return decideAgentAcceptance("request_rework", { moduleId, feedback });
      },
      rollbackDeliverables() { void decideAgentAcceptance("rollback"); },
      dockLiveRunView,
      onLiveModeChange(nextMode, prevMode) {
        if (nextMode === "live-run") {
          if (!root.dataset.paneLayout || root.dataset.paneLayout === "split") {
            setPaneLayout("live-max", { autoFromLiveRun: true });
          } else {
            syncRestoreChatLabel();
          }
        } else if (prevMode === "live-run" && autoExpandedForLiveRun && root.dataset.paneLayout === "live-max") {
          setPaneLayout("split");
        } else {
          syncRestoreChatLabel();
        }
      },
    },
  }) : null;
  // Keep the single composer and Live diagrams in sync with real governed
  // receipts, including host polling and externally selected Run changes.
  const renderWorkspace = renderer.render;
  renderer.render = () => { renderWorkspace(); desktop?.render(); };
  agentForm?.addEventListener("submit", (event) => { event.preventDefault(); void submitAgent(); });
  agentGoal?.addEventListener("input", updateAgentControls);
  agentHost?.addEventListener("change", updateAgentControls);
  agentFeedback?.addEventListener("input", updateAgentDecisionControls);
  agentStrategy?.addEventListener("input", () => {
    renderNativeStrategyOptions(agent.pending?.resultPreview || "");
    updateAgentDecisionControls();
  });
  agentChoiceReason?.addEventListener("input", updateAgentDecisionControls);
  agentAdopt?.addEventListener("click", () => { void submitAgentDecision("adopt"); });
  agentRevise?.addEventListener("click", () => { void submitAgentDecision("revise"); });
  agentReject?.addEventListener("click", () => { void submitAgentDecision("reject"); });
  agentDecisionRetry?.addEventListener("click", () => { void submitAgentDecision(agent.decisionPending?.action, { retry: true }); });
  agentDesignRefresh?.addEventListener("click", () => { void loadAgentDesign(); });
  agentDraftGenerate?.addEventListener("click", () => { void startNativeDraft(); });
  agentDraftManual?.addEventListener("click", () => {
    if (design.snapshot?.status !== "not_started") return;
    nativeDraft.manualOverride = true;
    nativeDraft.editorVisible = true;
    if (!design.draft) design.draft = { system: freshSystem(), modules: [freshModule(1)] };
    renderAgentDesign();
  });
  agentDraftReconcile?.addEventListener("click", () => {
    if (nativeDraft.pendingKey && nativeDraft.snapshot?.status === "not_started" && nativeDraft.snapshot?.recoveryState !== "in_doubt") {
      void startNativeDraft({ retry: true });
    } else void loadNativeDraft();
  });
  agentHandoffCheck?.addEventListener("click", () => { void loadAgentHandoff(); });
  agentHandoffPrepare?.addEventListener("click", () => { void prepareAgentHandoff(); });
  agentHandoffReconcile?.addEventListener("click", () => { void prepareAgentHandoff({ retry: true }); });
  agentExecutionAuthorize?.addEventListener("click", () => { void submitAgentExecution(); });
  agentExecutionCheck?.addEventListener("click", () => { void loadAgentExecution(); });

  agentExecutionRecords?.addEventListener("click", () => {
    if (state.snapshot?.run?.id || state.selection?.runId) setView("records");
    else options.openProjects();
  });
  agentVerify?.addEventListener("click", () => { void verifyAgentRequest(); });
  agentRedetect?.addEventListener("click", () => {
    if (agentRedetect?.dataset.action === "retry") void submitAgent({ retry: true });
    else {
      agent.hostRetryCount = 0;
      if (agent.hostRetryTimer) { win.clearTimeout(agent.hostRetryTimer); agent.hostRetryTimer = null; }
      void loadAgentHosts();
    }
  });
  agentNew?.addEventListener("click", () => {
    // An accepted or running native request still owns the only active
    // receipt. Dropping its key stops polling and strands the user mid-task.
    if (agent.busy || agent.decisionPending || !agent.pending || agent.status !== "completed") return;
    if (agentGoal?.value?.trim() === agent.pending.goal) agentGoal.value = "";
    agent.pending = null;
    agent.decisionPending = null;
    design.snapshot = null; design.draft = null; design.editTarget = null; design.error = null; design.pendingMutation = null;
    nativeDraft.snapshot = null; nativeDraft.error = null; nativeDraft.pendingKey = null;
    nativeDraft.autoAttempted = false; nativeDraft.editorVisible = false; nativeDraft.manualOverride = false; nativeDraft.sourceApplied = false;
    handoff.snapshot = null; handoff.error = null; handoff.pendingKey = null;
    execution.snapshot = null; execution.error = null; execution.pendingKey = null;
    acceptance.snapshot = null; acceptance.error = null; acceptance.pendingKey = null;

    if (agentFeedback) agentFeedback.value = "";
    if (agentStrategy) agentStrategy.value = "";
    if (agentChoiceReason) agentChoiceReason.value = "";
    saveAgent();
    if (agentResult) agentResult.hidden = true;
    if (agentOutput) agentOutput.textContent = "";
    renderNativeStrategyOptions("");
    agentMessage("idle", "");
    renderAgentDesign();
    agentGoal?.focus();
  });
  chatHostSelect?.addEventListener("change", () => {
    if (agentHost) agentHost.value = chatHostSelect.value;
    updateAgentControls();
    desktop?.render();
  });
  agentHost?.addEventListener("change", () => {
    if (chatHostSelect) chatHostSelect.value = agentHost.value;
    updateAgentControls();
    desktop?.render();
  });
  chatSwitchRepoBtn?.addEventListener("click", () => options.openProjects?.());
  app.querySelectorAll("[data-uw-view]").forEach((node) => node.addEventListener("click", () => setView(node.dataset.uwView)));
  app.querySelector("[data-uw-project-switch]")?.addEventListener("click", options.openProjects);
  app.querySelector("[data-uw-nav-open]")?.addEventListener("click", () => { app.querySelector("[data-uw-navigation]")?.setAttribute("data-open", "true"); app.querySelector("[data-uw-nav-open]")?.setAttribute("aria-expanded", "true"); app.querySelector("[data-uw-nav-close]")?.focus(); });
  app.querySelector("[data-uw-nav-close]")?.addEventListener("click", () => { closeNavigation(); app.querySelector("[data-uw-nav-open]")?.focus(); });

  const navCollapseBtn = app.querySelector("[data-uw-nav-collapse]");
  const navExpandBtn = root.querySelector("[data-uw-nav-expand]");
  const setNavCollapsed = (collapsed) => {
    if (app.dataset) app.dataset.navCollapsed = String(Boolean(collapsed));
    if (navExpandBtn) navExpandBtn.hidden = !collapsed;
    if (win?.requestAnimationFrame) win.requestAnimationFrame(() => win.dispatchEvent?.(new win.Event("resize")));
  };
  navCollapseBtn?.addEventListener("click", () => setNavCollapsed(app.dataset?.navCollapsed !== "true"));
  navExpandBtn?.addEventListener("click", () => setNavCollapsed(false));

  const navResizer = app.querySelector("[data-uw-nav-resizer]");
  let navDrag = null;
  navResizer?.addEventListener("pointerdown", (event) => {
    if (typeof event.button === "number" && event.button !== 0) return;
    event.preventDefault();
    const navBox = app.querySelector("[data-uw-navigation]")?.getBoundingClientRect?.();
    navDrag = { pointerId: event.pointerId, startX: event.clientX, baseW: navBox?.width || 176 };
    navResizer.dataset.dragging = "true";
    navResizer.setPointerCapture?.(event.pointerId);
  });
  navResizer?.addEventListener("pointermove", (event) => {
    if (!navDrag || event.pointerId !== navDrag.pointerId) return;
    const nextW = Math.round(Math.min(360, Math.max(156, navDrag.baseW + (event.clientX - navDrag.startX))));
    app.style?.setProperty?.("--uw-nav-width", `${nextW}px`);
    win?.dispatchEvent?.(new win.Event("resize"));
  });
  const finishNavDrag = (event) => {
    if (!navDrag) return;
    delete navResizer.dataset.dragging;
    navResizer.releasePointerCapture?.(event?.pointerId);
    navDrag = null;
  };
  navResizer?.addEventListener("pointerup", finishNavDrag);
  navResizer?.addEventListener("pointercancel", finishNavDrag);
  navResizer?.addEventListener("dblclick", () => {
    app.style?.removeProperty?.("--uw-nav-width");
    win?.dispatchEvent?.(new win.Event("resize"));
  });

  const chatMaxBtn = root.querySelector('[data-uw-pane-toggle="chat-max"]');
  const liveMaxBtn = root.querySelector('[data-uw-pane-toggle="live-max"]');
  const liveMinBtn = root.querySelector('[data-uw-pane-toggle="live-min"]');
  const restoreLiveBtn = root.querySelector("[data-uw-pane-restore-live]");
  const restoreChatBtn = root.querySelector("[data-uw-pane-restore-chat]");
  let autoExpandedForLiveRun = false;
  function syncRestoreChatLabel() {
    if (!restoreChatBtn) return;
    const label = desktop?.mode === "live-run" ? "并排对话" : "还原分栏";
    restoreChatBtn.textContent = translateAgentUi(label, state.language || "zh");
  }
  function setPaneLayout(layout, { autoFromLiveRun = false } = {}) {
    const next = ["split", "chat-max", "live-max"].includes(layout) ? layout : "split";
    autoExpandedForLiveRun = next === "live-max" && Boolean(autoFromLiveRun);
    root.dataset.paneLayout = next;
    if (restoreLiveBtn) restoreLiveBtn.hidden = next !== "chat-max";
    if (restoreChatBtn) {
      restoreChatBtn.hidden = next !== "live-max";
      syncRestoreChatLabel();
    }
    chatMaxBtn?.setAttribute("aria-pressed", String(next === "chat-max"));
    liveMaxBtn?.setAttribute("aria-pressed", String(next === "live-max"));
    if (win?.requestAnimationFrame) win.requestAnimationFrame(() => win.dispatchEvent?.(new win.Event("resize")));
  }
  chatMaxBtn?.addEventListener("click", () => setPaneLayout(root.dataset.paneLayout === "chat-max" ? "split" : "chat-max"));
  liveMaxBtn?.addEventListener("click", () => setPaneLayout(root.dataset.paneLayout === "live-max" ? "split" : "live-max"));
  liveMinBtn?.addEventListener("click", () => setPaneLayout("chat-max"));
  restoreLiveBtn?.addEventListener("click", () => setPaneLayout("split"));
  restoreChatBtn?.addEventListener("click", () => setPaneLayout("split"));

  const splitResizer = root.querySelector("[data-uw-split-resizer]");
  let splitDrag = null;
  splitResizer?.addEventListener("pointerdown", (event) => {
    if (typeof event.button === "number" && event.button !== 0) return;
    event.preventDefault();
    const wsRect = root.getBoundingClientRect?.();
    const chatRect = root.querySelector("[data-uw-agent-entry]")?.getBoundingClientRect?.();
    if (!wsRect || !wsRect.width) return;
    if (root.dataset.paneLayout !== "split") setPaneLayout("split");
    splitDrag = { pointerId: event.pointerId, startX: event.clientX, wsWidth: wsRect.width, baseChatW: chatRect?.width || wsRect.width * 0.43 };
    splitResizer.dataset.dragging = "true";
    splitResizer.setPointerCapture?.(event.pointerId);
  });
  splitResizer?.addEventListener("pointermove", (event) => {
    if (!splitDrag || event.pointerId !== splitDrag.pointerId) return;
    const nextChatW = splitDrag.baseChatW + (event.clientX - splitDrag.startX);
    const pct = Math.min(72, Math.max(26, (nextChatW / splitDrag.wsWidth) * 100));
    root.style?.setProperty?.("--uw-chat-share", `${pct.toFixed(2)}%`);
    win?.dispatchEvent?.(new win.Event("resize"));
  });
  const finishSplitDrag = (event) => {
    if (!splitDrag) return;
    delete splitResizer.dataset.dragging;
    splitResizer.releasePointerCapture?.(event?.pointerId);
    splitDrag = null;
  };
  splitResizer?.addEventListener("pointerup", finishSplitDrag);
  splitResizer?.addEventListener("pointercancel", finishSplitDrag);
  splitResizer?.addEventListener("dblclick", () => {
    root.style?.removeProperty?.("--uw-chat-share");
    win?.dispatchEvent?.(new win.Event("resize"));
  });

  root.querySelector("[data-uw-refresh]")?.addEventListener("click", () => {
    state.notice = "";
    // Explicit refresh re-reads the pages already opened by this user. Polling
    // stays bounded to one page; no decision or readiness cache is added.
    void refresh({ force: true, reloadCount: state.workspace?.design?.modules?.length || 0 });
  });
  renderer.detailCloseButton?.addEventListener("click", closeDetail);
  const onKey = (event) => {
    if (event.key !== "Escape") return;
    const maximizedGraph = root.querySelector('[data-maximized="true"]');
    if (maximizedGraph) {
      event.preventDefault();
      maximizedGraph.dataset.maximized = "false";
      const toggle = maximizedGraph.querySelector("[data-uw-kg-maximize]");
      if (toggle) { toggle.setAttribute("aria-pressed", "false"); toggle.textContent = translateAgentUi("最大化", state.language || "zh"); }
      return;
    }
    if (root.dataset.paneLayout && root.dataset.paneLayout !== "split") {
      event.preventDefault();
      setPaneLayout("split");
      return;
    }
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
  const interval = win.setInterval(() => {
    if (doc.visibilityState === "visible" && !state.externalView && state.error !== 413) void refresh({ force: true });
    if (doc.visibilityState === "visible") void loadAgentCapabilities();
  }, policy.refreshMs);
  // The intake is a real native request, so reflect its status without making
  // the user click "check" repeatedly. Stop polling after any terminal state.
  const agentInterval = agentEntryEnabled ? win.setInterval(() => {
    if (!disposed && doc.visibilityState === "visible" && agent.pending && !agent.busy
      && ["accepted", "running"].includes(agent.status)) void verifyAgentRequest();
    if (!disposed && doc.visibilityState === "visible" && designBasis() && design.snapshot?.status === "not_started"
      && nativeDraft.snapshot && ["accepted", "running"].includes(nativeDraft.snapshot.status)
      && !nativeDraft.loading && !nativeDraft.busy) void loadNativeDraft();
    if (!disposed && doc.visibilityState === "visible" && handoff.snapshot?.status === "prepared"
      && execution.snapshot && ["unconfirmed", "running", "waiting_input", "in_doubt"].includes(execution.snapshot.status)
      && !execution.loading && !execution.busy) void loadAgentExecution();
    if (!disposed && doc.visibilityState === "visible" && execution.snapshot?.status === "ready_for_review"
      && (!acceptance.snapshot || ["pending_verification", "waiting_b3"].includes(acceptance.snapshot.status))
      && !acceptance.loading && !acceptance.busy) void loadAgentAcceptance();

  }, policy.agentReceiptPollMs) : null;
  renderer.render();
  void loadAgentCapabilities();
  void loadAgentArchitecture();
  const hostScopeCheck = loadAgentHosts();
  if (agent.pending) {
    agentMessage("unconfirmed", "发现本会话的研究回执，先核对本地项目身份，再检查原请求号…");
    void hostScopeCheck.then(() => {
      if (disposed || !agent.pending || agent.scopeMismatch) return;
      if (agent.executionScope?.projectFingerprint !== agent.pending.projectFingerprint) {
        agentMessage("unconfirmed", "服务端当前项目身份尚未核验，为避免跨项目显示，旧研究回执保持隔离。", { redetect: true });
        return;
      }
      agentMessage("unconfirmed", "已确认所属项目，正在按原请求号核对研究回执…", { verify: true });
      void verifyAgentRequest();
    });
  }
  return {
    initialView: state.externalView === "graph" ? "run" : state.externalView === "repository" ? "repository" : "workspace",
    update({ snapshot, project, selection, tasks, fallbackStages, origin }) {
      const prevProjectId = state.selection?.projectId || "";
      const key = [selection.projectId || "", selection.runId || ""].join("\u001f");
      const changed = key !== state.selectionKey;
      const projectChanged = (selection.projectId || "") !== prevProjectId;
      if (changed) {
        generation += 1; materialGeneration += 1;
        for (const controller of pendingControllers) controller.abort();
        state.workspace = null; state.material = null; state.detail = null; state.error = null; state.notice = ""; state.loading = false; state.history = emptyHistory(); state.recordPage = 0;
        workspaceInFlight = false; refreshAgain = false; queuedCursor = null; queuedReloadCount = 0; lastRefresh = 0;
        state.selectionKey = key; state.selection = selection; state.command = null;
        try { const saved = JSON.parse(win.sessionStorage?.getItem(commandStorageKey()) || "null"); if (saved?.nonce && saved?.targetIdentity) state.command = { ...saved, busy: false }; } catch {}
      }
      state.snapshot = snapshot; state.project = project; state.selection = selection; state.tasks = tasks || []; state.fallbackStages = fallbackStages || []; state.origin = state.workspace?.source?.recordOrigin || origin;
      if (project?.displayName) state.agentServerProjectLabel = project.displayName;
      state.language = options.language();
      syncDockedMetaCopy();
      syncRestoreChatLabel();
      if (projectChanged) void loadAgentArchitecture({ force: true, projectId: selection.projectId || "" });
      enhanceRepositorySurface();
      renderer.render();
      renderAgentFollowthrough();
      if (!state.externalView || changed) void refresh({ force: changed });
      ensureMaterial(); ensureRecords();
    },
    show(view) { state.externalView = view === "run" ? "graph" : view === "repository" ? "repository" : null; enhanceRepositorySurface(); renderer.render(); },
    dispose() { disposed = true; win.clearInterval(interval); if (agentInterval !== null) win.clearInterval(agentInterval);
      if (agent.hostRetryTimer) win.clearTimeout(agent.hostRetryTimer);
      doc.removeEventListener("keydown", onKey); for (const controller of pendingControllers) controller.abort(); },
  };
}

export function serializeLiveWorkspaceClient() {
  return `${serializeLiveWorkspaceModel()}\n${serializeLiveAgentCopy()}\nconst LIVE_WORKSPACE_UI_POLICY = ${JSON.stringify(LIVE_WORKSPACE_UI_POLICY)};\n${createPrdKnowledgeGraph.toString()}\n${createDynamicPrdWorkflowCanvas.toString()}\n${projectLiveUserPhases.toString()}\n${createLiveWorkspaceRenderer.toString()}\n${createUnifiedAgentDesktop.toString()}\n${createLiveWorkspaceController.toString()}`;
}
