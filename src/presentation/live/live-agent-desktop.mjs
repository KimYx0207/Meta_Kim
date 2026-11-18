/**
 * Agent-first presentation of the existing Meta_Kim Live model.
 *
 * One conversational composer owns user text. Live nodes are read-only
 * projections of server receipts until the separately governed execution
 * pathway accepts a scoped change. Selecting a node scopes feedback; it never
 * silently approves a design or authorizes a host operation.
 *
 * Kept dependency-free so the Live single-file client can serialize it.
 */
export function createUnifiedAgentDesktop({ root, state, agent, design, nativeDraft, handoff,
  execution = { snapshot: null, error: null, pendingKey: null, busy: false, loading: false },
  acceptance = { snapshot: null, error: null, pendingKey: null, busy: false, loading: false },
  translateUi = null,
  createWorkflowCanvas = null,
  copy, buildGraph, createGraph, callbacks }) {
  const doc = root.ownerDocument;
  const find = (name) => root.querySelector(`[data-uw-${name}]`);
  const chat = find("agent-chat");
  const thread = find("chat-thread");
  const announcement = find("chat-announcement");
  const form = find("chat-form");
  const input = find("chat-input");
  const send = find("chat-send");
  const project = find("chat-project");
  const connection = find("chat-connection");
  const guidance = find("chat-guidance");
  const target = find("chat-target");
  const targetText = find("chat-target-text");
  const targetClear = find("chat-target-clear");
  // The navigation sidebar is a sibling of the workspace inside the same Live
  // shell. Querying the workspace root alone silently hid the entire native
  // Agent / Subagent / Skill / MCP / Hook inventory in the real browser.
  const inventory = root.closest?.("[data-unified-workspace]")?.querySelector("[data-uw-agent-inventory]")
    || find("agent-inventory");
  const viewport = find("live-viewport");
  const caption = find("live-caption");
  const count = find("live-count");
  const source = find("live-source");
  const modes = [...root.querySelectorAll("[data-uw-live-mode]")];
  if (!chat || !thread || !form || !input || !viewport || !modes.length) return null;

  const topFlowRibbon = root.closest?.("[data-unified-workspace]")?.querySelector?.("[data-uw-top-flow]") || null;
  let mode = topFlowRibbon ? "knowledge" : "flow";
  let lastTopFlowSignature = "";
  let knowledgeLayer = "system";
  let prdSourcePref = "auto";
  let knowledgeDepth = 2;
  let knowledgeLimit = 40;
  let selection = null;
  let selectedStrategy = null;
  let reviewedNodes = new Set();
  let reworkModuleChoice = "";
  let reworkFeedbackDraft = "";
  let localNotice = "";
  let lastThreadSignature = "";
  let lastAnnouncement = "";
  let lastCanvasSignature = "";
  let lastInventorySignature = "";
  let inventoryQuery = "";
  let inventoryFlyoutOpen = false;
  let activeFlyoutSection = "all";
  let selectedNativeCapId = null;
  let resetInventoryScroll = false;
  const inventoryExpanded = new Set();
  let nodeCount = 0;
  const openBindingBtn = find("open-binding");
  const bindingDrawer = find("binding-drawer");
  let bindingDrawerOpen = false;
  let bindingNotice = "";
  let lastBindingSignature = "";
  const dockedRunSlot = find("docked-run-slot");
  const liveFooter = find("live-footer");

  openBindingBtn?.addEventListener("click", () => {
    bindingDrawerOpen = !bindingDrawerOpen;
    lastBindingSignature = "";
    renderBindingDrawer();
  });

  doc.addEventListener?.("keydown", event => {
    if (event?.key === "Escape" && inventoryFlyoutOpen) {
      inventoryFlyoutOpen = false;
      lastInventorySignature = "";
      renderInventory();
    }
  });
  doc.addEventListener?.("pointerdown", event => {
    if (!inventoryFlyoutOpen || typeof event?.target?.closest !== "function") return;
    if (!event.target.closest("[data-uw-agent-inventory]")) {
      inventoryFlyoutOpen = false;
      lastInventorySignature = "";
      renderInventory();
    }
  });

  const el = (tag, className = "", value = null) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (value !== null && value !== undefined) node.textContent = String(value);
    return node;
  };
  const clean = (value, max = 2200) => String(value || "").trim().slice(0, max);
  const normalizedInventoryQuery = () => clean(inventoryQuery, 100).normalize("NFKC").toLocaleLowerCase();
  const inventoryMatches = (...values) => {
    const query = normalizedInventoryQuery();
    return !query || values.some(value => String(value || "").normalize("NFKC").toLocaleLowerCase().includes(query));
  };
  const makeButton = (label, action, className = "") => {
    const button = el("button", className, label);
    button.type = "button";
    button.addEventListener("click", action);
    return button;
  };
  const labelFor = (status) => ({
    completed: "已完成", running: "正在执行", waiting_human: "等待你确认", planned: "待开始",
    blocked: "已阻塞", reviewing: "审阅中", draft: "设计草稿", unknown: "待核对", partial: "部分完成",
    accepted: "已接单", unproven: "待核验", in_doubt: "需要核对", not_started: "待设计",
  })[status] || "待核对";
  const t = (val) => typeof translateUi === "function" ? translateUi(val) : String(val ?? "");
  function localizeSubtree(container) {
    const lang = state.language || "zh";
    if (!container || !lang || lang === "zh" || lang.startsWith("zh") || typeof translateUi !== "function") return;
    const walkNodes = (node) => {
      if (!node) return;
      if (node.dataset?.uwUntranslated === "true") return;
      if (node.getAttribute) {
        for (const attr of ["placeholder", "title", "aria-label"]) {
          const cur = node.getAttribute(attr);
          if (cur) {
            if (!node._uwOrigAttrs) node._uwOrigAttrs = {};
            if (!node._uwOrigAttrs[attr]) node._uwOrigAttrs[attr] = cur;
            const base = node._uwOrigAttrs[attr];
            const next = t(base);
            if (next !== cur) node.setAttribute(attr, next);
          }
        }
      }
      const children = node.childNodes || node.children || [];
      if (!children.length && typeof node.textContent === "string" && node.textContent.trim()) {
        const base = node._uwOrigText ?? node.textContent;
        if (node._uwOrigText === undefined) node._uwOrigText = base;
        const next = t(base);
        if (next !== node.textContent) node.textContent = next;
        return;
      }
      for (const child of children) {
        if (child && child.nodeType === 3) {
          const raw = child.nodeValue;
          if (raw && raw.trim()) {
            const base = child._uwOrigText ?? raw;
            if (child._uwOrigText === undefined) child._uwOrigText = base;
            const next = t(base);
            if (next !== raw) child.nodeValue = next;
          }
        } else if (child) {
          walkNodes(child);
        }
      }
    };
    walkNodes(container);
  }
  const safeStatus = (status) => /^[a-z_]+$/u.test(status || "") ? status : "unknown";
  const adopted = () => agent.pending?.decision?.state === "adopted_for_design";
  const pendingChoice = () => agent.status === "completed" && agent.pending?.resultPreview
    && !["adopted_for_design", "revision_requested", "rejected", "not_ready", "unavailable_no_plan"].includes(agent.pending?.decision?.state);
  const designNotes = (kind, id) => (design.snapshot?.pendingReviewNotes || []).filter(note =>
    note.target?.kind === kind && (kind === "system" || note.target.moduleId === id));
  const savedDesign = () => Boolean(design.snapshot?.system && design.snapshot?.version > 0);
  const isCurrentRun = () => Boolean(state.origin === "governed_run"
    && state.selection?.runId && (state.snapshot?.run?.id || state.snapshot?.run?.runId || state.workspace?.runId)
      === state.selection.runId
    // A real native research receipt can own the selected governed Run while
    // remaining pending for B1 human review. Do not hide its actual events;
    // equally, never attach a different Run just because it was selected.
    && (!agent.pending || agent.pending.runId === state.selection.runId));
  // All names come from the registered catalog or the selected run's receipts.
  // A selected loadout is NOT an invocation: only observed capabilityTruth.actualNames is.
  const capabilityFamilies = [
    { kind: "skill", name: "Skills", catalog: "skills" },
    { kind: "mcp", name: "MCP", catalog: "mcpServers" },
    { kind: "hook", name: "Hooks", catalog: "hooks" },
    { kind: "plugin", name: "Plugins", catalog: "plugins" },
    { kind: "command", name: "Commands", catalog: "commands" },
    { kind: "mcp_tool", name: "MCP Tools", catalog: "mcpTools" },
    { kind: "runtime_tool", name: "Runtime Tools", catalog: null },
  ];
  const nativeFamilies = [
    { kind: "agent", label: "Agents" },
    { kind: "subagent_config", label: "Subagent 预设" },
    { kind: "skill", label: "Skills" },
    { kind: "mcp", label: "MCP" },
    { kind: "hook", label: "Hooks" },
    { kind: "plugin", label: "Plugins" },
    { kind: "command", label: "Commands" },
  ];
  const runTasks = () => isCurrentRun() && Array.isArray(state.tasks)
    ? state.tasks.filter(task => task?.source && ["agent", "worker"].includes(task.source.kind)
      && (!task.source.runId || task.source.runId === state.selection?.runId))
    : [];
  const isDispatchedRunTask = task => {
    if (!task || state.snapshot?.run?.executionEvidenceState === "structural_planning_only") return false;
    const record = task.source || {};
    if (record.declaredNotStarted === true || record.executionState === "not_executed") return false;
    if (["not_started", "planned"].includes(task.status)
      && !record.executionObserved && !record.ownerReport && !record.nativeReturnEvidence) return false;
    return true;
  };
  const taskOwner = task => {
    const owner = clean(task?.source?.ownerAgent || task?.source?.agent || task?.owner, 90);
    return owner && !["unavailable", "unknown", "worker"].includes(owner.toLowerCase()) ? owner : "未确认执行者";
  };
  const taskRole = task => {
    const role = clean(task?.source?.role || task?.source?.roleDisplayName || taskOwner(task), 80);
    const display = role && role !== "worker" ? role : taskOwner(task);
    return task?.source?.isMain === true ? `主 Agent · ${display}` : display;
  };
  const taskVisualState = task => {
    const observed = task?.source;
    return observed?.active === true && (observed.observedOnly === true
      || observed.observedStatus === "active" || observed.executionObserved === true)
      ? "running" : safeStatus(task?.status);
  };
  const taskOutcome = task => {
    const record = task?.source || {};
    const report = record.ownerReport;
    if (report?.evidenceLevel === "owner_reported" && report?.summary && report?.nativeInvocationVerified === false
      && report.runId === state.selection?.runId && report.taskPacketId === record.taskPacketId
      && report.ownerAgent === taskOwner(task)) {
      return { heading: "负责人回报 · 待独立验证", detail: clean(report.summary, 1000), at: clean(report.reportedAt, 40), level: "reported" };
    }
    if (record.nativeReturnEvidence?.evidenceKind === "native_host_observation"
      && record.nativeReturnEvidence?.executionObserved === true && record.nativeReturnEvidence?.synthetic === false
      && record.nativeReturnEvidence?.runId === state.selection?.runId) {
      return { heading: "原生返回已观测 · 待验收", detail: "任务已返回；当前回执没有可单独核实的结论正文。",
        at: clean(record.nativeReturnEvidence.observedAt, 40), level: "returned" };
    }
    if (record.terminalEvidence && record.executionState === "executed") {
      return { heading: "执行证据 · 待验收", detail: clean(record.terminalEvidence, 500), level: "evidence" };
    }
    return { heading: "尚无结论回执", detail: clean(record.statusReason, 180) || "任务已登记，但尚没有完成且可核对的结论。", level: "absent" };
  };
  const agentMark = (identity, registered = false) => {
    const marker = el("span", "uw-agent-identity-mark");
    marker.setAttribute("aria-hidden", "true");
    const key = clean(identity, 100).toLowerCase().replace(/^meta-/u, "");
    // Nine semantic, code-native role insignias. These are our own UI symbols,
    // not claims to be official logos for a model, provider, or registered tool.
    const iconPaths = {
      warden: [["path", "M12 2 20 6v5c0 5.3-3.5 8.8-8 11-4.5-2.2-8-5.7-8-11V6Z"], ["path", "m8.5 12 2.2 2.2 4.8-4.8"]],
      conductor: [["circle", "4 12 2"], ["circle", "20 5 2"], ["circle", "20 19 2"], ["path", "M6 12h5a3 3 0 0 0 3-3V7h4M11 12a3 3 0 0 1 3 3v2h4"]],
      genesis: [["circle", "12 12 3"], ["path", "M12 2v5M12 17v5M2 12h5M17 12h5M5 5l3.5 3.5M15.5 15.5 19 19M19 5l-3.5 3.5M8.5 15.5 5 19"]],
      artisan: [["path", "m4 20 10-10M11 4l9 9-3 3-9-9 3-3ZM3 20l3 1 1-3"]],
      sentinel: [["path", "M12 2 21 7v5a9 9 0 0 1-18 0V7Z"], ["circle", "12 12 2"], ["path", "M12 9v-2M12 17v-2M7 12h2M15 12h2"]],
      librarian: [["path", "M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1ZM12 6v14"], ["path", "M6 9h3M15 9h3M6 13h3M15 13h3"]],
      prism: [["path", "m12 2 9 18H3Z"], ["path", "m12 2-2 11 11 7M10 13l-7 7M10 13h6"]],
      scout: [["circle", "12 12 10"], ["path", "m15 9-2 6-5 2 2-6Z"], ["path", "M12 2v3M22 12h-3M12 22v-3M2 12h3"]],
      chrysalis: [["path", "M12 2c-4 0-7 4-7 9 0 6 3 11 7 11s7-5 7-11c0-5-3-9-7-9Z"], ["path", "M8 6c3 2 5 4 8 4M7 12c4 1 7 1 10-1M8 17c3-1 5-2 8-4"]],
    };
    const shapes = iconPaths[key];
    if (shapes && typeof doc.createElementNS === "function") {
      const namespace = "http://www.w3.org/2000/svg";
      const svg = doc.createElementNS(namespace, "svg");
      for (const [attribute, value] of Object.entries({ viewBox: "0 0 24 24", width: "21", height: "21",
        fill: "none", stroke: "currentColor", "stroke-width": "1.45", "stroke-linecap": "round", "stroke-linejoin": "round" })) svg.setAttribute(attribute, value);
      for (const [kind, geometry] of shapes) {
        const shape = doc.createElementNS(namespace, kind);
        if (kind === "circle") { const [cx, cy, radius] = geometry.split(" "); shape.setAttribute("cx", cx); shape.setAttribute("cy", cy); shape.setAttribute("r", radius); }
        else shape.setAttribute("d", geometry);
        svg.append(shape);
      }
      marker.append(svg);
    } else {
      const roleName = clean(identity, 100).split(":").at(-1).replace(/^meta-/u, "");
      const parts = roleName.split(/[-_.]/u).filter(Boolean);
      marker.textContent = (parts.length > 1 ? parts.slice(0, 2).map(part => part.slice(0, 1)).join("")
        : roleName.slice(0, 2)).toUpperCase() || "A";
    }
    marker.dataset.registered = String(registered);
    marker.title = shapes ? `${clean(identity, 96)} · 角色专属图形标识` : "Agent 角色标识 · 非第三方品牌 Logo";
    return marker;
  };
  const nativeHostMark = hostId => {
    const id = clean(hostId, 50).toLowerCase();
    const monograms = { claude: "CL", codex: "CX", gemini: "GM", zcode: "ZC",
      dsh: "DS", opencode: "OC", openclaw: "OW", cursor: "CU", pi: "PI" };
    const mark = el("span", "uw-native-host-mark", monograms[id] || (id.slice(0, 2).toUpperCase() || "AI"));
    mark.title = "客户端字母标识 · 非第三方官方 Logo";
    mark.setAttribute("aria-hidden", "true");
    return mark;
  };
  const catalogItems = key => key && Array.isArray(state.capabilityCatalog?.[key])
    ? state.capabilityCatalog[key].filter(item => item && item.registrationState === "registered"
      && (item.label || item.id)) : [];
  function runtimeCapabilities(kind) {
    const records = new Map();
    for (const task of runTasks()) {
      for (const truth of task.source.capabilityTruth || []) {
        if (truth?.kind !== kind) continue;
        for (const name of Array.isArray(truth.plannedNames) ? truth.plannedNames : []) {
          const label = clean(name, 100);
          if (!label) continue;
          const key = label.toLocaleLowerCase();
          if (!records.has(key)) records.set(key, { label, state: "planned" });
        }
        if (truth.state === "observed") {
          for (const name of Array.isArray(truth.actualNames) ? truth.actualNames : []) {
            const label = clean(name, 100);
            if (!label) continue;
            records.set(label.toLocaleLowerCase(), { label, state: "observed" });
          }
        }
      }
    }
    return records;
  }
  function capabilityEntries(kind, key) {
    const rows = runtimeCapabilities(kind);
    for (const item of catalogItems(key)) {
      const label = clean(item.label || item.id, 100);
      const match = rows.get(label.toLocaleLowerCase());
      if (match) { match.registered = true; match.referenceOnly = item.referenceOnly === true; }
      else rows.set(label.toLocaleLowerCase(), { label, state: "registered", registered: true,
        referenceOnly: item.referenceOnly === true });
    }
    return [...rows.values()].sort((a, b) => ({ observed: 0, planned: 1, registered: 2 })[a.state]
      - ({ observed: 0, planned: 1, registered: 2 })[b.state] || a.label.localeCompare(b.label));
  }
  const strategies = () => {
    return callbacks.parseStrategies?.(agent.pending?.resultPreview || "") || null;
  };
  const taskDesignSource = () => {
    if (design.snapshot?.system && Array.isArray(design.snapshot.modules)) {
      const saved = design.snapshot;
      const b4Accepted = acceptance.snapshot?.status === "accepted_and_integrated";
      const b4Waiting = acceptance.snapshot?.status === "awaiting_human_b4";
      const b3Running = ["running", "waiting_input"].includes(execution.snapshot?.status);
      const resolveItemState = (approved) => {
        if (b4Accepted) return "completed";
        if (b4Waiting && approved) return "partial";
        if (b3Running && approved) return "running";
        return approved ? "completed" : "waiting_human";
      };
      const sysApproved = saved.system.approval?.state === "approved";
      const approvedMods = saved.modules.filter(item => item.approval?.state === "approved").length;
      return {
        kind: "agent_saved_design",
        version: saved.version,
        raw: saved,
        design: {
          architecture: {
            id: "agent-system",
            title: saved.system.title || "系统框架",
            status: resolveItemState(sysApproved),
            progressNote: b4Accepted
              ? `已验收完成 ${saved.modules.length}/${saved.modules.length} 个模块`
              : `已确认 ${approvedMods}/${saved.modules.length} 个模块`,
            summary: saved.system.goal,
            moduleIds: saved.modules.map(item => item.id),
          },
          modules: saved.modules.map(item => ({
            id: item.id,
            title: item.title,
            shortSummary: clean(item.objective, 40),
            summary: item.objective,
            status: resolveItemState(item.approval?.state === "approved"),
            hasUiPage: Boolean(item.hasUiPage),
            uiMockup: item.uiMockup || null,
            nodeKind: item.nodeKind || "process",
            dependsOn: item.dependencies || [],
          })),
        },
      };
    }
    if (nativeDraft.snapshot?.status === "completed" && nativeDraft.snapshot?.design?.system) {
      const draft = nativeDraft.snapshot.design;
      return {
        kind: "agent_unverified_draft",
        version: null,
        raw: draft,
        design: {
          architecture: { id: "agent-system", title: draft.system.title, status: "unproven",
            progressNote: `草稿待确认 · 共 ${draft.modules.length} 个模块`,
            summary: draft.system.goal, moduleIds: draft.modules.map(item => item.id) },
          modules: draft.modules.map(item => ({ id: item.id, title: item.title,
            shortSummary: clean(item.objective, 40), summary: item.objective,
            status: "unproven", dependsOn: item.dependencies || [] })),
        },
      };
    }
    if (isCurrentRun() && state.workspace?.design?.architecture) {
      return { kind: "governed_run", version: state.workspace.revision, raw: null, design: state.workspace.design };
    }
    return null;
  };
  const baselineDesignSource = () => {
    const base = state.projectArchitecturePrd;
    if (!base?.system || !Array.isArray(base.modules) || !base.modules.length) return null;
    const doneMods = base.modules.filter(item => (item.status || "completed") === "completed").length;
    const sysStatus = base.system.status || (doneMods === base.modules.length ? "completed" : doneMods > 0 ? "partial" : "planned");
    return {
      kind: "project_architecture_baseline",
      version: null,
      raw: base,
      design: {
        architecture: {
          id: base.system.id || "system-architecture",
          title: base.system.title || "系统框架",
          status: sysStatus,
          progressNote: `已完成 ${doneMods}/${base.modules.length} 个系统模块`,
          summary: base.system.goal || "",
          moduleIds: base.modules.map(item => item.id),
        },
        modules: base.modules.map(item => ({
          id: item.id,
          title: item.title,
          shortSummary: item.shortSummary || clean(item.objective, 40),
          summary: item.objective,
          status: item.status || "completed",
          layer: item.layer,
          layerShort: item.layerShort,
          layerRank: item.layerRank,
          flowColumn: item.flowColumn,
          nodeKind: item.nodeKind,
          hasUiPage: Boolean(item.hasUiPage),
          uiMockup: item.uiMockup || null,
          subflow: item.subflow || null,
          directory: item.directory,
          fileCount: item.fileCount,
          dependsOn: item.dependencies || [],
        })),
      },
    };
  };
  const designSource = () => {
    const taskSrc = taskDesignSource();
    const baseSrc = baselineDesignSource();
    if (prdSourcePref === "baseline" && baseSrc) return baseSrc;
    if (prdSourcePref === "task" && taskSrc) return taskSrc;
    return taskSrc || baseSrc;
  };
  const conversationSignature = () => JSON.stringify({
    goal: agent.pending?.goal, agentStatus: agent.status,
    capabilityOrigin: agent.pending?.capabilityState?.recordOrigin,
    receipt: find("agent-status")?.textContent, preview: agent.pending?.resultPreview,
    decision: agent.pending?.decision, designVersion: design.snapshot?.version,
    designStatus: design.snapshot?.status, systemApproval: design.snapshot?.system?.approval?.state,
    moduleApprovals: (design.snapshot?.modules || []).map(item => `${item.id}:${item.approval?.state}:${item.uiMockup?.status}:${item.uiMockup?.version}`),
    draftStatus: nativeDraft.snapshot?.status, handoffStatus: handoff.snapshot?.status,
    executionStatus: execution.snapshot?.status, executionSession: execution.snapshot?.nativeSessionId,
    executionError: execution.error, executionPending: execution.pendingKey?.key,
    acceptanceStatus: acceptance.snapshot?.status, acceptanceDigest: acceptance.snapshot?.artifactsDigest,
    acceptanceFiles: acceptance.snapshot?.changedFiles?.length, acceptanceError: acceptance.error,
    acceptancePlaybooks: acceptance.snapshot?.matchedPlaybooks?.length,

    designError: design.error, handoffError: handoff.error, draftError: nativeDraft.error,
    reviewNotes: (design.snapshot?.pendingReviewNotes || []).map(note => `${note.noteId}:${note.target?.kind}:${note.target?.moduleId}`),
    reviewHistory: design.snapshot?.history?.length, pendingMutation: design.pendingMutation?.mutationKey,
    decisionPending: agent.decisionPending?.key, busy: [agent.busy, agent.decisionBusy, design.busy, nativeDraft.busy, handoff.busy, execution.busy, acceptance.busy],
    selection: selection?.id, selectedStrategy, reviewedNodes: [...reviewedNodes], localNotice,
  });

  function bubble(kind, title, body) {
    const wrap = el("article", `uw-chat-bubble uw-chat-bubble-${kind}`);
    const heading = el("div", "uw-chat-bubble-heading");
    heading.append(el("span", "uw-chat-bubble-dot"), el("strong", "", title));
    wrap.append(heading);
    if (body) {
      const p = el("p", "", body);
      if (kind === "user") p.dataset.uwUntranslated = "true";
      wrap.append(p);
    }
    return wrap;
  }
  function drawOptions(host) {
    const parsed = strategies();
    if (!parsed || !pendingChoice()) return;
    const wrapper = el("div", "uw-chat-options");
    wrapper.append(el("div", "uw-chat-inline-heading", "选择方向 · B1 人工确认"));
    if (parsed.summary) wrapper.append(el("p", "uw-chat-options-summary", clean(parsed.summary, 350)));
    const list = el("div", "uw-chat-option-list");
    for (const option of parsed.strategies) {
      const key = `${option.id}：${option.title}`;
      const choice = makeButton("", () => {
        selectedStrategy = key;
        input.placeholder = `写下选择 ${option.id} 的理由，发送后才会记录采纳`;
        render();
        input.focus();
      }, "uw-chat-option");
      choice.setAttribute("aria-pressed", String(selectedStrategy === key));
      const heading = el("span", "uw-chat-option-top");
      heading.append(el("b", "uw-chat-option-letter", option.id), el("strong", "", clean(option.title, 90)));
      const approach = el("span", "uw-chat-option-text", clean(option.approach, 240));
      const tradeoffs = el("span", "uw-chat-option-note", `取舍：${clean(option.tradeoffs, 210)}`);
      const risks = el("span", "uw-chat-option-note", `风险：${clean(option.risks, 210)}`);
      const evidence = el("span", "uw-chat-option-note", `依据（未经独立核验）：${clean(option.evidenceSummary, 210)}`);
      choice.append(heading, approach, tradeoffs, risks, evidence);
      if (parsed.recommendedStrategyId === option.id) choice.append(el("span", "uw-chat-recommendation", "模型推荐 · 待你核对"));
      list.append(choice);
    }
    wrapper.append(list);
    if (parsed.openQuestions?.length) wrapper.append(el("p", "uw-chat-options-hint", `尚待澄清：${parsed.openQuestions.join("；")}`));
    wrapper.append(el("p", "uw-chat-options-hint", selectedStrategy
      ? "已选择方案。请在下方唯一输入框说明理由并发送；也可以改选。"
      : "点选方案，再在下方输入框说理由；直接发送修改意见则退回研究。"));
    host.append(wrapper);
  }
  function reviewDetails(record, kind, id, version) {
    const details = el("details", "uw-chat-review-details");
    const fields = kind === "system" ? [
      ["目标", record.goal], ["整体架构", record.architecture], ["技术栈", record.techStack],
      ["验收标准", (record.acceptance || []).join("\n")],
    ] : [
      ["目标", record.objective], ["输入契约", (record.inputContract || []).join("\n")],
      ["输出契约", (record.outputContract || []).join("\n")],
      ["边界", (record.boundaries || []).join("\n")], ["验收标准", (record.acceptance || []).join("\n")],
      ["前置依赖", (record.dependencies || []).join("、") || "无"],
    ];
    const key = `${version}:${kind}:${id}`;
    details.open = reviewedNodes.has(key);
    details.append(el("summary", "", `查看「${record.title}」的完整设计 · v${version}`));
    const content = el("div", "uw-chat-review-fields");
    for (const [title, body] of fields) {
      const field = el("div", "uw-chat-review-field");
      field.append(el("strong", "", title), el("p", "", body || "未填写"));
      content.append(field);
    }
    details.append(content);
    details.addEventListener("toggle", () => {
      if (details.open && !reviewedNodes.has(key)) { reviewedNodes.add(key); render(); }
    });
    return details;
  }
  function drawAcceptanceCard(host) {
    const snap = acceptance.snapshot;
    const currentExec = execution.snapshot?.handoffDigest === handoff.snapshot?.handoffDigest ? execution.snapshot : null;
    if (!snap && currentExec?.status !== "ready_for_review") return;
    const card = el("div", "uw-b4-card");
    card.dataset.state = safeStatus(snap?.status || "pending_verification");
    card.append(el("div", "uw-chat-inline-heading", "成果核验与改进 · B4 最终验收"));
    if (acceptance.error) card.append(el("p", "uw-chat-error", acceptance.error));
    const summaryText = snap?.nextAction
      || (currentExec?.status === "ready_for_review"
        ? "隔离工作区任务已完成，正在自动读取变更清单与核验状态…"
        : "等待隔离工作区执行完成后进入核验。");
    card.append(el("p", "uw-b4-summary", summaryText));

    const files = Array.isArray(snap?.changedFiles) ? snap.changedFiles : [];
    if (files.length) {
      const fileList = el("div", "uw-b4-files");
      const changeLabels = { added: "新增", modified: "修改", deleted: "删除" };
      for (const item of files.slice(0, 16)) {
        const row = el("div", "uw-b4-file-row");
        const tag = el("span", "uw-b4-file-tag", changeLabels[item.changeType] || "变更");
        tag.dataset.change = item.changeType || "modified";
        row.append(tag, el("code", "uw-b4-file-path", clean(item.path, 160)),
          el("small", "uw-b4-file-size", item.changeType === "deleted" ? "已移除" : `${item.bytes || 0} B`));
        fileList.append(row);
      }
      card.append(fileList);
    }

    const checks = Array.isArray(snap?.verification?.checks) ? snap.verification.checks : [];
    if (checks.length) {
      const checkBox = el("div", "uw-b4-checks");
      for (const chk of checks) {
        const row = el("div", "uw-b4-check-row");
        row.dataset.passed = String(chk.passed === true);
        row.append(el("span", "uw-b4-check-icon", chk.passed ? "✓" : "✕"),
          el("strong", "", clean(chk.label, 80)),
          el("small", "", clean(chk.detail, 200)));
        checkBox.append(row);
      }
      card.append(checkBox);
    }

    const actions = el("div", "uw-b4-actions");
    if ((!snap || snap.status === "pending_verification") && typeof callbacks.verifyDeliverables === "function") {
      const verifyBtn = makeButton("立即核验隔离区产物", () => callbacks.verifyDeliverables(), "uw-chat-action");
      verifyBtn.disabled = acceptance.busy || acceptance.loading;
      actions.append(verifyBtn);
    }
    if (snap?.status === "awaiting_human_b4" && typeof callbacks.acceptDeliverables === "function") {
      const acceptBtn = makeButton("通过 B4 验收并合入主项目", () =>
        callbacks.acceptDeliverables("人工确认核验通过并合入主项目"), "uw-chat-action");
      acceptBtn.disabled = acceptance.busy || acceptance.loading;
      actions.append(acceptBtn);
    }
    if (snap?.status === "accepted_and_integrated") {
      const badge = el("div", "uw-b4-accepted-banner", "✓ 隔离区产物已安全合入主项目，并自动沉淀为经验方法卡");
      card.append(badge);
      if (typeof callbacks.rollbackDeliverables === "function") {
        const rb = makeButton("回滚本次合入", () => callbacks.rollbackDeliverables(), "uw-chat-secondary");
        rb.disabled = acceptance.busy || acceptance.loading;
        actions.append(rb);
      }
    }
    if (actions.children?.length || actions.childNodes?.length) card.append(actions);

    if (["awaiting_human_b4", "verification_failed", "blocked"].includes(snap?.status)
      && typeof callbacks.requestDeliverableRework === "function" && savedDesign()) {
      const reworkBar = el("div", "uw-b4-rework-bar");
      const select = el("select", "uw-b4-rework-select");
      select.setAttribute("aria-label", "选择退回重做的模块");
      const modules = design.snapshot?.modules || [];
      if (!reworkModuleChoice && modules[0]?.id) reworkModuleChoice = modules[0].id;
      for (const mod of modules) {
        const opt = el("option", "", `${mod.title || mod.id}`);
        opt.value = mod.id;
        if (mod.id === reworkModuleChoice) opt.selected = true;
        select.append(opt);
      }
      const sysOpt = el("option", "", "系统整体架构（system）");
      sysOpt.value = "system";
      if (reworkModuleChoice === "system") sysOpt.selected = true;
      select.append(sysOpt);
      select.addEventListener("change", () => { reworkModuleChoice = select.value; });

      const reasonInput = el("input", "uw-b4-rework-input");
      reasonInput.type = "text";
      reasonInput.placeholder = "填写退回该模块重做的具体问题…";
      reasonInput.value = reworkFeedbackDraft;
      reasonInput.addEventListener("input", () => { reworkFeedbackDraft = reasonInput.value; });

      const reworkBtn = makeButton("退回所选模块重做", () => {
        const targetMod = select.value || reworkModuleChoice || modules[0]?.id || "system";
        const reason = reasonInput.value.trim() || reworkFeedbackDraft.trim();
        if (!reason) {
          localNotice = "请先填写退回重做的具体原因，再点击退回。";
          render();
          return;
        }
        reworkFeedbackDraft = "";
        callbacks.requestDeliverableRework(targetMod, reason);
      }, "uw-chat-secondary");
      reworkBtn.disabled = acceptance.busy || acceptance.loading;
      reworkBar.append(select, reasonInput, reworkBtn);
      card.append(reworkBar);
    }

    const activePlaybook = snap?.playbook;
    const matched = Array.isArray(snap?.matchedPlaybooks) ? snap.matchedPlaybooks : [];
    const lessons = Array.isArray(snap?.reworkLessons) ? snap.reworkLessons : [];
    if (activePlaybook || matched.length || lessons.length) {
      const improve = el("div", "uw-playbook-section");
      improve.append(el("div", "uw-chat-inline-heading", "经验沉淀与跨项目复用门禁"));
      if (lessons.length) {
        improve.append(el("p", "uw-playbook-lessons", `本轮改进记录：${lessons.join("；")}`));
      }
      const cardsToShow = activePlaybook
        ? [{ ...activePlaybook, applicability: "sedimented", matchReasons: ["本轮验收新沉淀方法卡"], mismatchReasons: [] },
          ...matched.filter(item => item.playbookId !== activePlaybook.playbookId)]
        : matched;
      for (const pb of cardsToShow.slice(0, 4)) {
        const pbCard = el("div", "uw-playbook-card");
        pbCard.dataset.applicability = pb.applicability || "review_required";
        const statusLabel = pb.applicability === "sedimented" ? "新沉淀 · 可跨店复用"
          : pb.applicability === "compatible" ? "适用性核验通过 · 可复用"
            : pb.applicability === "incompatible_context" ? "场景不匹配 · 已拦截套用"
              : "待核对适用条件";
        const top = el("div", "uw-playbook-card-top");
        top.append(el("strong", "", clean(pb.title, 100)), el("span", "uw-playbook-badge", statusLabel));
        pbCard.append(top);
        const reasons = pb.applicability === "incompatible_context" ? pb.mismatchReasons : pb.matchReasons;
        if (Array.isArray(reasons) && reasons.length) {
          pbCard.append(el("small", "", reasons.join(" · ")));
        }
        if (Array.isArray(pb.reworkLessons) && pb.reworkLessons.length) {
          pbCard.append(el("small", "uw-playbook-lesson-item", `历史避坑经验：${pb.reworkLessons.join("；")}`));
        }
        improve.append(pbCard);
      }
      card.append(improve);
    }
    host.append(card);
  }

  function drawDesignCard(host) {
    if (!adopted()) return;
    const saved = design.snapshot;
    const draft = nativeDraft.snapshot;
    const box = el("div", "uw-chat-design-card");
    const heading = el("div", "uw-chat-inline-heading", "设计与节点 · B2 人工确认");
    box.append(heading);
    if (saved?.status === "not_started" && draft?.status === "completed") {
      box.append(el("p", "", `已生成系统设计与 ${draft.design?.modules?.length || 0} 个模块草稿。右侧「知识图谱」可查看依赖，尚未批准。`));
      box.append(makeButton("保存设计草稿，进入人工审阅", () => callbacks.saveDraft(), "uw-chat-action"));
    } else if (saved?.status === "not_started") {
      box.append(el("p", "", nativeDraft.error || `设计草稿：${labelFor(draft?.status || "not_started")}。待草稿生成后才能人工确认。`));
      if (["failed", "blocked", "not_started"].includes(draft?.status) && !nativeDraft.busy && !nativeDraft.pendingKey) {
        box.append(makeButton("重新生成只读设计草稿", () => callbacks.retryDraft(), "uw-chat-secondary"));
      }
    } else if (saved?.system) {
      box.append(el("p", "", `${saved.system.title || "系统设计"} · 版本 ${saved.version} · ${saved.modules?.length || 0} 个模块`));
      const approvals = el("div", "uw-chat-approval-list");
      const systemReady = saved.system.approval?.state === "approved";
      approvals.append(el("span", "", `系统：${systemReady ? "已确认" : "待确认"}`));
      for (const module of saved.modules || []) approvals.append(el("span", "", `${module.title}：${module.approval?.state === "approved" ? "已确认" : "待确认"}`));
      box.append(approvals);
      const next = !systemReady ? { kind: "system", record: saved.system, id: "system" } : (() => {
        const record = (saved.modules || []).find(item => item.approval?.state !== "approved"
          && (item.dependencies || []).every(id => saved.modules.find(mod => mod.id === id)?.approval?.state === "approved"));
        return record ? { kind: "module", record, id: record.id } : null;
      })();
      if (next) {
        const key = `${saved.version}:${next.kind}:${next.id}`;
        box.append(reviewDetails(next.record, next.kind, next.id, saved.version));
        const outstanding = designNotes(next.kind, next.id).length;
        const mockupPending = next.kind === "module" && next.record.hasUiPage === true && next.record.uiMockup?.status !== "confirmed";
        if (outstanding) box.append(el("p", "uw-chat-options-hint", `当前节点有 ${outstanding} 条待修改意见。点击右侧节点，直接在唯一输入框给出具体字段的新内容。`));
        if (mockupPending) box.append(el("p", "uw-chat-options-hint", "⏸ 此模块涉及前端页面：必须先确认「页面效果图」后才能批准设计进入开发。"));
        const approve = makeButton(`确认「${next.record.title || "系统设计"}」`, () => {
          callbacks.approveNode(next.kind, next.id);
        }, "uw-chat-action");
        approve.disabled = !reviewedNodes.has(key) || Boolean(outstanding) || mockupPending;
        approve.title = outstanding ? "待修改意见尚未解决"
          : mockupPending ? "请先确认该页面模块的效果图"
          : !reviewedNodes.has(key) ? "请先展开完整设计后确认" : "已审阅，可确认";
        const actionRow = el("div", "uw-chat-action-group");
        actionRow.append(approve);
        if (mockupPending && typeof callbacks.confirmNodeMockup === "function") {
          const confirmMockBtn = makeButton("✓ 确认该模块页面效果图", () => {
            callbacks.confirmNodeMockup(next.id);
          }, "uw-chat-secondary");
          confirmMockBtn.disabled = design.busy;
          actionRow.append(confirmMockBtn);
        }
        const anyMockupUnconfirmed = (saved.modules || []).some(m => m.hasUiPage === true && m.uiMockup?.status !== "confirmed");
        const totalPendingNotes = (saved.pendingReviewNotes || []).length;
        if (totalPendingNotes === 0 && !anyMockupUnconfirmed && typeof callbacks.approveAllAndPrepare === "function") {
          const fastTrack = makeButton("一键确认全部设计并自动封存", () => {
            callbacks.approveAllAndPrepare();
          }, "uw-chat-secondary uw-chat-fasttrack");
          fastTrack.disabled = design.busy || handoff.busy;
          fastTrack.title = "无未决修改意见时，一次原子确认系统与全部模块并封存交接材料";
          actionRow.append(fastTrack);
        }
        box.append(actionRow);
      }
      if (saved.status === "approved") {
        box.append(el("p", "uw-chat-options-hint", "设计已逐项确认；正式执行仍需要独立授权和可核对的真实 Run。"));
        if (handoff.snapshot?.status === "eligible" && !handoff.busy) {
          box.append(makeButton("准备交接材料（不执行）", () => callbacks.prepareHandoff(), "uw-chat-action"));
        } else if (handoff.snapshot?.status === "prepared") {
          const currentExecution = execution.snapshot?.handoffDigest === handoff.snapshot.handoffDigest
            ? execution.snapshot : null;
          box.append(el("p", "uw-chat-options-hint",
            "已封存交接 · " + (handoff.snapshot.handoffDigest?.slice(0, 12) || "待核对") + "…"));
          if (execution.error) box.append(el("p", "uw-chat-error", execution.error));
          if (currentExecution?.status === "ready_to_authorize" && !execution.pendingKey) {
            box.append(el("p", "uw-chat-options-hint",
              "授权范围：仅当前项目的一次本地草稿操作。无命令、外网、付款、发消息、发布权限；成果仍需测试和验收。"));
            const start = makeButton("批准 B3 · 启动受限草稿", () => callbacks.authorizeExecution(), "uw-chat-action");
            start.disabled = execution.busy || execution.loading;
            box.append(start);
          } else if (execution.pendingKey) {
            box.append(el("p", "uw-chat-options-hint", "原生执行请求结果不确定，先用原授权号核对。"));
            box.append(makeButton("核对原 B3 授权", () => callbacks.authorizeExecution(), "uw-chat-secondary"));
          } else if (currentExecution?.nativeSessionId) {
            box.append(el("p", "uw-chat-options-hint",
              "原生任务 " + currentExecution.nativeSessionId + " · " + currentExecution.status
              + "。已发起草稿，并不代表正式 Run 或 B4 验收。"));
            box.append(makeButton("查看原生任务状态", () => callbacks.inspectExecution(), "uw-chat-secondary"));
          } else if (currentExecution?.status === "blocked") {
            box.append(el("p", "uw-chat-options-hint",
              "受限客户端暂不可用：" + (currentExecution.reason || "请检查本机 Claude")));
            box.append(makeButton("重新检测 B3 入口", () => callbacks.inspectExecution(), "uw-chat-secondary"));
          } else {
            box.append(el("p", "uw-chat-options-hint", "正在确认本地受限执行入口；尚未授权任何副作用。"));
          }
          drawAcceptanceCard(box);

        } else box.append(el("p", "uw-chat-options-hint", handoff.error || "正在核对交接资格；设计已完成不代表代码已执行。"));
      } else if (acceptance.snapshot?.status === "rework_requested") {
        drawAcceptanceCard(box);
      }
    } else box.append(el("p", "", "正在检查设计草稿。生成后可在右侧查看模块关系。"));
    if (design.error) box.append(el("p", "uw-chat-error", design.error));
    if (handoff.error) box.append(el("p", "uw-chat-error", handoff.error));
    if (design.pendingMutation) box.append(makeButton("核对原设计修改回执", () => callbacks.reconcileDesign(), "uw-chat-secondary"));
    if (handoff.pendingKey) box.append(makeButton("核对原交接回执", () => callbacks.reconcileHandoff(), "uw-chat-secondary"));
    if (saved?.status !== "approved" && saved?.status !== "not_started" && saved?.system) {
      box.append(el("p", "uw-chat-options-hint", "可在右侧圈选系统或模块节点，再用同一个输入框要求返工，或输入「目标改为：…」「验收改为：…」直接提交字段修订。"));
    }
    host.append(box);
  }
  function renderThread() {
    const signature = conversationSignature();
    if (signature === lastThreadSignature) return;
    lastThreadSignature = signature;
    const announcementText = [agent.status, design.error, nativeDraft.error, handoff.error,
      design.snapshot?.pendingReviewNotes?.length ? `${design.snapshot.pendingReviewNotes.length} 条待修改意见` : "",
      agent.pending?.decision?.state].filter(Boolean).join("；");
    if (announcement && announcementText !== lastAnnouncement) {
      announcement.textContent = announcementText;
      lastAnnouncement = announcementText;
    }
    const wasBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 90;
    thread.replaceChildren();
    if (!agent.pending) {
      const welcome = el("div", "uw-chat-welcome");
      welcome.append(el("span", "uw-chat-welcome-mark", "✳"), el("h2", "", "今天想做什么？"),
        el("p", "", "说一句你的目标。我会研究、提出方案，关键决定交给你。整个过程在右侧 Live 实时展开。"));
      thread.append(welcome);
      if (["blocked", "unconfirmed", "checking"].includes(agent.status)) {
        thread.append(bubble("assistant", "连接与权限", clean(find("agent-status")?.textContent, 500)));
        if (!agent.loading) thread.append(makeButton("重新检测可用客户端", () => callbacks.redetect(), "uw-chat-secondary"));
      }
    } else {
      thread.append(bubble("user", "你", clean(agent.pending.goal, 6000)));
      const stateText = clean(find("agent-status")?.textContent, 350) || labelFor(agent.status);
      const assistant = bubble("assistant", agent.pending?.capabilityState?.recordOrigin === "acceptance_fixture"
        ? "Meta_Kim · 模拟验收回执" : "Meta_Kim", stateText);
      assistant.dataset.state = safeStatus(agent.status);
      thread.append(assistant);
      if (agent.pending.resultPreview && agent.status === "completed") {
        const parsed = strategies();
        if (parsed) drawOptions(thread);
        else if (pendingChoice()) {
          thread.append(bubble("assistant", "原始研究摘要 · 未独立核验", clean(agent.pending.resultPreview, 1500)));
          thread.append(el("p", "uw-chat-options-hint", "如果材料足够，请在下方输入「采纳：方案名称｜你的选择理由」；也可以直接写修改要求。"));
        }
      }
      if (pendingChoice() && !agent.decisionBusy && !agent.decisionPending) {
        thread.append(makeButton("放弃本次候选方案", () => callbacks.reject(), "uw-chat-secondary"));
      }
      const decision = agent.pending.decision;
      if (decision?.state === "adopted_for_design") thread.append(bubble("assistant", "选择已记录", `采纳：${decision.selectedStrategy}。${decision.selectionReason || ""}`));
      else if (decision?.state === "revision_requested") thread.append(bubble("assistant", "修改请求已记录", "等待新的研究回执。原方案不会执行。"));
      else if (decision?.state === "rejected") thread.append(bubble("assistant", "本次方案已放弃", "没有进入设计或执行。"));
      if (agent.decisionPending) thread.append(makeButton("核对原决策回执", () => callbacks.reconcileDecision(), "uw-chat-secondary"));
      if (["blocked", "unconfirmed"].includes(agent.status)) {
        thread.append(bubble("assistant", "需要处理", clean(find("agent-status")?.textContent, 500)));
        if (!agent.busy) thread.append(makeButton("查询原请求回执", () => callbacks.verifyRequest(), "uw-chat-secondary"));
      }
      if (agent.status === "completed" && !agent.decisionPending && ["adopted_for_design", "rejected"].includes(decision?.state)) {
        thread.append(makeButton("开始另一个任务", () => callbacks.newTask(), "uw-chat-secondary"));
      }
      drawDesignCard(thread);
    }
    for (const entry of design.snapshot?.history || []) {
      if (!entry.reviewNote) continue;
      const note = entry.reviewNote;
      const title = note.target?.kind === "system" ? design.snapshot?.system?.title || "系统设计" :
        design.snapshot?.modules?.find(item => item.id === note.target?.moduleId)?.title || note.target?.moduleId || "模块";
      thread.append(bubble("user", `已记录的节点修改意见 · v${entry.version} · ${title}`, note.feedback));
      const unresolved = (design.snapshot?.pendingReviewNotes || []).some(item => item.noteId === note.noteId);
      thread.append(bubble("assistant", "设计版本回执", unresolved ? "意见已持久化；该节点需真实修改后才能重新批准。" : "修改意见已有后续修订回执，历史记录保留。"));
    }
    if (localNotice) thread.append(bubble("assistant", "操作提示", localNotice));
    if (wasBottom || !thread.scrollTop) thread.scrollTop = thread.scrollHeight;
  }

  const flowStages = () => {
    const stages = Array.isArray(state.workspace?.stages) && state.workspace.stages.length
      ? state.workspace.stages.map(stage => ({ id: stage.id, title: stage.label || stage.id,
        summary: stage.summary || "", status: safeStatus(stage.status) })) : null;
    if (stages && isCurrentRun()) return stages;
    const pending = Boolean(agent.pending);
    const decision = agent.pending?.decision?.state;
    const researchDone = agent.status === "completed";
    const designStatus = design.snapshot?.status;
    const systemApproved = designStatus === "approved";
    return [
      { id: "goal", title: "理解目标", summary: "记录需求与项目边界", status: pending ? "completed" : "planned" },
      { id: "research", title: "研究与方案比选", summary: "研究来自原生客户端；引证需独立核验", status: researchDone ? "completed" :
        agent.status === "running" ? "running" : agent.status === "accepted" ? "accepted" : "planned" },
      { id: "decision", title: "方案选择", summary: "关键决策 B1", status: decision === "adopted_for_design" ? "completed" :
        pendingChoice() ? "waiting_human" : "planned" },
      { id: "design", title: "系统设计与模块", summary: "PRD、依赖与 B2 确认", status: systemApproved ? "completed" :
        designStatus === "reviewing" || designStatus === "draft" ? "waiting_human" :
          nativeDraft.snapshot && ["accepted", "running"].includes(nativeDraft.snapshot.status) ? "running" :
            nativeDraft.snapshot?.status === "completed" ? "waiting_human" : "planned" },
      { id: "execution", title: "交接与执行",
        summary: execution.snapshot?.nativeSessionId
          ? "B3 原生任务 " + execution.snapshot.status + " · 正式 Run 待验"
          : handoff.snapshot?.status === "prepared" ? "交接已封存 · B3 权限待确认" : "先批准交接，再授权 B3",
        status: ["running", "waiting_input"].includes(execution.snapshot?.status) ? "running"
          : execution.snapshot?.status === "ready_for_review"
            ? (acceptance.snapshot?.status === "accepted_and_integrated" ? "completed" : "partial")
            : handoff.snapshot?.status === "prepared" ? "waiting_human" : "planned" },

      { id: "acceptance", title: "最终验收",
        summary: acceptance.snapshot?.status === "accepted_and_integrated"
          ? "B4 验收通过 · 产物已合入主项目并沉淀方法卡"
          : acceptance.snapshot?.status === "awaiting_human_b4"
            ? `自动核验通过（${acceptance.snapshot.changedFiles?.length || 0} 个文件）· 等待你确认合入或退回`
            : acceptance.snapshot?.status === "pending_verification"
              ? "后台正在比对隔离工作区产物并执行核验"
              : ["verification_failed", "blocked"].includes(acceptance.snapshot?.status)
                ? "核验未通过或存在主仓冲突 · 请退回模块修复"
                : acceptance.snapshot?.status === "rework_requested"
                  ? "已退回指定模块重做 · 修订确认后可重新执行"
                  : "可复核成果与 B4 交付",
        status: acceptance.snapshot?.status === "accepted_and_integrated" ? "completed"
          : ["awaiting_human_b4", "rework_requested"].includes(acceptance.snapshot?.status) ? "waiting_human"
            : acceptance.snapshot?.status === "pending_verification" ? "running"
              : ["verification_failed", "blocked"].includes(acceptance.snapshot?.status) ? "blocked" : "planned" },
    ];
  };
  function renderCockpitStrip(stages) {
    const strip = el("div", "uw-cockpit-pillars");
    strip.setAttribute("data-uw-cockpit-pillars", "true");
    const completedCount = stages.filter(s => s.status === "completed").length;
    const activeTasks = runTasks().filter(t => taskVisualState(t) === "running");
    const goalText = agent.pending?.goal ? clean(agent.pending.goal, 44) : "输入一句话目标";
    const goalSub = agent.pending ? `已完成 ${completedCount}/${stages.length} 步` : "串联研究·设计·执行·验收";

    const execStatus = activeTasks.length ? `${activeTasks.length} 个 Agent 正在工作`
      : execution.snapshot?.status === "running" ? `Claude 草稿执行中 · ${execution.snapshot.nativeSessionId || ""}`
        : execution.snapshot?.status === "ready_for_review" ? "隔离草稿已跑完 · 已移交核验"
          : agent.status === "running" ? "正在研究候选方案"
            : agent.pending ? "阶段就绪 · 按授权推进" : "空闲待命";

    const b4 = acceptance.snapshot;
    const fileCount = b4?.changedFiles?.length || 0;
    const resultText = b4?.status === "accepted_and_integrated" ? `已合入主仓 · ${fileCount} 个文件`
      : b4?.status === "awaiting_human_b4" ? `核验通过 · ${fileCount} 个变更待合入`
        : ["verification_failed", "blocked"].includes(b4?.status) ? "核验发现问题 · 已阻断合入"
          : fileCount > 0 ? `检测到 ${fileCount} 个草稿文件` : "暂无核验产物";

    const gateText = pendingChoice() ? "待拍板 B1 · 选择方案"
      : adopted() && design.snapshot?.status && design.snapshot.status !== "approved" ? "待拍板 B2 · 确认设计"
        : handoff.snapshot?.status === "prepared" && execution.snapshot?.status === "ready_to_authorize" ? "待拍板 B3 · 授权草稿执行"
          : b4?.status === "awaiting_human_b4" ? "待拍板 B4 · 确认合入或退回"
            : "当前无需拍板";
    const gateActive = gateText.startsWith("待拍板");

    const pbCount = (b4?.playbook ? 1 : 0) + (b4?.matchedPlaybooks?.filter(p => p.applicability === "compatible")?.length || 0);
    const lessonCount = b4?.reworkLessons?.length || (design.snapshot?.pendingReviewNotes?.length || 0);
    const improveText = b4?.playbook ? "已沉淀新方法卡 · 可跨店复用"
      : pbCount > 0 ? `匹配 ${pbCount} 张可复用方法卡`
        : lessonCount > 0 ? `已记录 ${lessonCount} 条改进约束`
          : "验收沉淀经验";

    const items = [
      { key: "goal", label: "目标", main: goalText, sub: goalSub, state: agent.pending ? "active" : "idle",
        onClick: () => selectDesktopAnnotationNode({ id: "goal", title: "理解目标", kind: "stage" }) },
      { key: "execution", label: "执行", main: execStatus, sub: "真凭实据驱动",
        state: execution.snapshot?.status === "running" || agent.status === "running" ? "running" : "idle",
        onClick: () => { if (runTasks().length) { mode = "agents"; render(); } else selectDesktopAnnotationNode({ id: "execution", title: "交接与执行", kind: "stage" }); } },
      { key: "result", label: "结果", main: resultText, sub: b4?.verification?.passed ? "语法与契约已校验" : "核验后可合入",
        state: b4?.status === "accepted_and_integrated" ? "completed" : ["verification_failed", "blocked"].includes(b4?.status) ? "blocked" : "idle",
        onClick: () => selectDesktopAnnotationNode({ id: "acceptance", title: "最终验收", kind: "stage" }) },
      { key: "decision", label: "决策", main: gateText, sub: gateActive ? "仅关键节点打扰你" : "常规步骤自动衔接",
        state: gateActive ? "waiting_human" : "completed",
        onClick: () => selectDesktopAnnotationNode({ id: b4?.status === "awaiting_human_b4" ? "acceptance" : adopted() ? "design" : "decision", title: gateText, kind: "stage" }) },
      { key: "improve", label: "改进", main: improveText, sub: "复用前核对条件",
        state: pbCount > 0 || b4?.playbook ? "completed" : "idle",
        onClick: () => selectDesktopAnnotationNode({ id: "acceptance", title: "最终验收", kind: "stage" }) },
    ];

    for (const item of items) {
      const card = makeButton("", item.onClick, "uw-cockpit-pillar");
      card.dataset.pillar = item.key;
      card.dataset.state = item.state;
      card.append(el("span", "uw-cockpit-pillar-kicker", item.label),
        el("strong", "uw-cockpit-pillar-main", item.main),
        el("small", "uw-cockpit-pillar-sub", item.sub));
      strip.append(card);
    }
    return strip;
  }
  function selectDesktopAnnotationNode(node) {
    selection = { id: clean(node.id, 140), title: clean(node.title, 140), kind: node.kind || "stage", layer: node.layer || mode };
    localNotice = "";
    render();
    input.focus();
  }
  function renderEightStageStrip(list) {
    const rawStages = isCurrentRun() && Array.isArray(state.workspace?.stages) && state.workspace.stages.length
      ? state.workspace.stages : null;
    const byId = new Map((rawStages || []).map(s => [String(s.id || "").toLowerCase().replace(/[^a-z]/gu, ""), safeStatus(s.status)]));
    const stageByFlow = Object.fromEntries(list.map(s => [s.id, safeStatus(s.status)]));
    const eight = [
      { id: "critical", code: "01", short: "目标", title: "目标确认", state: byId.get("critical") || stageByFlow.goal || "planned", target: "goal" },
      { id: "fetch", code: "02", short: "调研", title: "证据收集", state: byId.get("fetch") || stageByFlow.research || "planned", target: "research" },
      { id: "thinking", code: "03", short: "设计", title: "方案设计", state: byId.get("thinking")
        || (stageByFlow.design === "completed" ? "completed" : stageByFlow.decision !== "planned" ? stageByFlow.decision : stageByFlow.design) || "planned", target: "design" },
      { id: "execution", code: "04", short: "执行", title: "落实执行", state: byId.get("execution") || stageByFlow.execution || "planned", target: "execution" },
      { id: "review", code: "05", short: "审查", title: "结果审查", state: byId.get("review")
        || (["awaiting_human_b4", "accepted_and_integrated"].includes(acceptance.snapshot?.status) ? "completed"
          : acceptance.snapshot?.status === "pending_verification" ? "running" : "planned"), target: "acceptance" },
      { id: "metareview", code: "06", short: "复审", title: "独立复审", state: byId.get("metareview")
        || (["awaiting_human_b4", "accepted_and_integrated"].includes(acceptance.snapshot?.status) ? "completed" : "planned"), target: "acceptance" },
      { id: "verification", code: "07", short: "验收", title: "证据验收", state: byId.get("verification") || stageByFlow.acceptance || "planned", target: "acceptance" },
      { id: "evolution", code: "08", short: "沉淀", title: "经验沉淀", state: byId.get("evolution")
        || (acceptance.snapshot?.playbook ? "completed" : "planned"), target: "acceptance" },
    ];
    const bar = el("div", "uw-eight-stage-bar");
    bar.setAttribute("role", "list");
    bar.setAttribute("aria-label", "Meta 治理八阶段总览");
    for (const item of eight) {
      const chip = makeButton("", () => selectDesktopAnnotationNode({ id: item.target, title: item.title, kind: "stage" }), "uw-eight-stage-chip");
      chip.setAttribute("role", "listitem");
      chip.dataset.state = item.state;
      chip.title = `${item.code} ${item.title} · ${labelFor(item.state)}`;
      chip.append(el("b", "uw-eight-stage-num", item.code), el("span", "uw-eight-stage-name", item.short));
      bar.append(chip);
    }
    return bar;
  }

  function renderInteractiveFlowCanvas(list) {
    if (typeof doc.createElementNS !== "function") return null;
    const ns = "http://www.w3.org/2000/svg";
    const svgEl = (tag, attrs = {}) => {
      const node = doc.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
      return node;
    };
    const card = el("section", "uw-flow-dag-card");
    const head = el("header", "uw-flow-dag-head");
    const headLeft = el("div", "uw-flow-dag-title");
    headLeft.append(el("strong", "", "流程与模块拓扑图"), el("small", "", "可自由拖拽节点与画布 · 滚轮缩放"));
    const tools = el("div", "uw-flow-dag-tools");
    const openFullBtn = makeButton("完整运行图", () => activateMode("live-run"), "uw-flow-dag-tool uw-flow-dag-primary");
    openFullBtn.title = "切换到带回放时间线与检查器的原版完整运行图";
    const zOut = makeButton("−", () => { scale = Math.max(0.45, scale / 1.18); applyCam(); }, "uw-flow-dag-tool");
    zOut.title = "缩小流程图"; zOut.setAttribute("aria-label", "缩小流程图");
    const zReset = makeButton("100%", () => {
      tx = 0; ty = 0; scale = 1;
      for (const [id, orig] of origPos.entries()) {
        pos.set(id, { x: orig.x, y: orig.y });
        groups.get(id)?.setAttribute("transform", `translate(${orig.x},${orig.y})`);
      }
      for (const rec of edgeDom) rec.path.setAttribute("d", calcPath(rec.from, rec.to, rec.dashed));
      applyCam();
    }, "uw-flow-dag-tool uw-flow-dag-scale");
    zReset.title = "重置缩放与节点排布";
    const zIn = makeButton("+", () => { scale = Math.min(2.5, scale * 1.18); applyCam(); }, "uw-flow-dag-tool");
    zIn.title = "放大流程图"; zIn.setAttribute("aria-label", "放大流程图");
    const maxToggle = makeButton("最大化", () => {
      const next = card.dataset.maximized !== "true";
      card.dataset.maximized = String(next);
      maxToggle.textContent = t(next ? "还原" : "最大化");
    }, "uw-flow-dag-tool");
    maxToggle.title = "最大化或还原流程图画布";
    tools.append(openFullBtn, zOut, zReset, zIn, maxToggle);
    head.append(headLeft, tools);
    card.append(head);

    const cw = 186, ch = 56, xGap = 32, yGap = 28, cols = 3;
    const blueprint = designSource();
    const modules = (blueprint?.design?.modules || []).slice(0, 6);
    const workers = runTasks().slice(0, 6);
    const dagNodes = list.map((s, idx) => {
      const row = Math.floor(idx / cols);
      const col = idx % cols;
      return {
        id: `stage:${s.id}`, rawId: s.id, kind: "stage", code: String(idx + 1).padStart(2, "0"),
        title: s.title, state: safeStatus(s.status), summary: s.summary,
        x: 20 + col * (cw + xGap), y: 18 + row * (ch + yGap),
      };
    });
    const dagEdges = [];
    for (let i = 0; i < dagNodes.length - 1; i += 1) {
      dagEdges.push({ from: dagNodes[i].id, to: dagNodes[i + 1].id, dashed: false });
    }
    const baseExtraY = 18 + Math.ceil(list.length / cols) * (ch + yGap);
    modules.forEach((m, idx) => {
      const nid = `mod:${m.id}`;
      dagNodes.push({
        id: nid, rawId: m.id, kind: "module", code: `M${idx + 1}`,
        title: m.title || m.id, state: safeStatus(m.status), summary: m.summary || "",
        x: 20 + (idx % cols) * (cw + xGap), y: baseExtraY + Math.floor(idx / cols) * (ch + 22),
      });
      dagEdges.push({ from: "stage:design", to: nid, dashed: true });
      dagEdges.push({ from: nid, to: "stage:execution", dashed: true });
    });
    const workerBaseY = baseExtraY + (modules.length ? Math.ceil(modules.length / cols) * (ch + 22) : 0);
    workers.forEach((w, idx) => {
      const nid = `task:${w.id}`;
      dagNodes.push({
        id: nid, rawId: w.id, kind: "task", code: `A${idx + 1}`,
        title: taskRole(w), state: taskVisualState(w), summary: w.title || "",
        x: 20 + (idx % cols) * (cw + xGap), y: workerBaseY + Math.floor(idx / cols) * (ch + 22),
      });
      dagEdges.push({ from: "stage:execution", to: nid, dashed: false });
    });

    const svgW = cols * cw + (cols - 1) * xGap + 40;
    const maxY = Math.max(...dagNodes.map(n => n.y + ch));
    const svgH = Math.max(108, maxY + 18);
    const pos = new Map(dagNodes.map(n => [n.id, { x: n.x, y: n.y }]));
    const origPos = new Map(dagNodes.map(n => [n.id, { x: n.x, y: n.y }]));
    let tx = 0, ty = 0, scale = 1;
    const canvas = el("div", "uw-flow-dag-canvas");
    const svg = svgEl("svg", { viewBox: `0 0 ${svgW} ${svgH}`, width: svgW, height: svgH, role: "group", "aria-label": "流程与模块交互拓扑" });
    const applyCam = () => {
      const moved = tx !== 0 || ty !== 0 || scale !== 1;
      svg.setAttribute("style", moved
        ? `transform:translate(${Math.round(tx)}px,${Math.round(ty)}px) scale(${scale.toFixed(3)});transform-origin:left top` : "");
      zReset.textContent = `${Math.round(scale * 100)}%`;
    };
    const defs = svgEl("defs");
    const marker = svgEl("marker", { id: "uw-flow-dag-arrow", markerWidth: 8, markerHeight: 8, refX: 6.5, refY: 3.5, orient: "auto", markerUnits: "userSpaceOnUse" });
    marker.append(svgEl("path", { d: "M0 0L7 3.5L0 7", class: "uw-kg-arrow-head" }));
    defs.append(marker); svg.append(defs);
    const calcPath = (fromId, toId) => {
      const a = pos.get(fromId), b = pos.get(toId);
      if (!a || !b) return "";
      const horiz = Math.abs(b.x - a.x) > cw * 0.75 && Math.abs(b.y - a.y) < ch;
      if (horiz) {
        const dir = b.x >= a.x ? 1 : -1;
        const sx = a.x + (dir > 0 ? cw : 0), sy = a.y + ch / 2;
        const ex = b.x + (dir > 0 ? 0 : cw), ey = b.y + ch / 2;
        return `M${sx} ${sy} C${sx + dir * 24} ${sy},${ex - dir * 24} ${ey},${ex} ${ey}`;
      }
      const down = b.y >= a.y;
      const sx = a.x + cw / 2, sy = a.y + (down ? ch : 0);
      const ex = b.x + cw / 2, ey = b.y + (down ? 0 : ch);
      return `M${sx} ${sy} C${sx} ${sy + (down ? 28 : -28)},${ex} ${ey + (down ? -28 : 28)},${ex} ${ey}`;
    };
    const edgeDom = [];
    for (const edge of dagEdges) {
      const p = svgEl("path", { d: calcPath(edge.from, edge.to), class: `uw-kg-edge ${edge.dashed ? "contains" : "required"}`, "marker-end": "url(#uw-flow-dag-arrow)" });
      const targetNode = dagNodes.find(n => n.id === edge.to);
      if (targetNode?.state === "running") p.setAttribute("data-activity", "observed-running");
      svg.append(p);
      edgeDom.push({ ...edge, path: p });
    }
    const groups = new Map();
    let dragNode = null, skipClick = false;
    for (const n of dagNodes) {
      const g = svgEl("g", { class: "uw-kg-node uw-flow-dag-node", transform: `translate(${n.x},${n.y})`, tabindex: 0, role: "button" });
      g.dataset.state = n.state;
      g.dataset.selected = String(selection?.id === n.rawId);
      g.append(svgEl("rect", { x: 0, y: 0, width: cw, height: ch, rx: 10 }));
      const top = svgEl("text", { x: 11, y: 19, class: "uw-kg-node-kind" });
      top.textContent = `${n.code} · ${t(labelFor(n.state))}`;
      const main = svgEl("text", { x: 11, y: 42, class: "uw-kg-node-title" });
      const rawTitle = n.kind === "stage" ? t(n.title) : n.title;
      const maxChars = /^[\x00-\x7f]+$/u.test(rawTitle) ? 21 : 11;
      main.textContent = Array.from(rawTitle).length > maxChars ? Array.from(rawTitle).slice(0, maxChars - 1).join("") + "…" : rawTitle;
      const tip = svgEl("title");
      tip.textContent = `${rawTitle} · ${t(labelFor(n.state))}${n.summary ? ` · ${t(n.summary)}` : ""}`;
      g.append(top, main, tip);
      g.addEventListener("pointerdown", e => {
        if (!e || (typeof e.button === "number" && e.button !== 0)) return;
        e.stopPropagation?.();
        const cur = pos.get(n.id) || { x: 0, y: 0 };
        dragNode = { id: n.id, g, pid: e.pointerId, sx: e.clientX, sy: e.clientY, ox: cur.x, oy: cur.y, moved: false };
        g.setPointerCapture?.(e.pointerId);
      });
      g.addEventListener("pointermove", e => {
        if (!dragNode || dragNode.id !== n.id || e.pointerId !== dragNode.pid) return;
        if (!dragNode.moved && Math.hypot(e.clientX - dragNode.sx, e.clientY - dragNode.sy) > 4) {
          dragNode.moved = true; g.dataset.dragging = "true";
        }
        if (!dragNode.moved) return;
        const nx = Math.round(dragNode.ox + (e.clientX - dragNode.sx) / (scale || 1));
        const ny = Math.round(dragNode.oy + (e.clientY - dragNode.sy) / (scale || 1));
        pos.set(n.id, { x: nx, y: ny });
        g.setAttribute("transform", `translate(${nx},${ny})`);
        for (const rec of edgeDom) {
          if (rec.from === n.id || rec.to === n.id) rec.path.setAttribute("d", calcPath(rec.from, rec.to));
        }
      });
      const stopDrag = e => {
        if (!dragNode || dragNode.id !== n.id) return;
        if (dragNode.moved) skipClick = true;
        delete g.dataset.dragging;
        g.releasePointerCapture?.(e?.pointerId);
        dragNode = null;
      };
      g.addEventListener("pointerup", stopDrag);
      g.addEventListener("pointercancel", stopDrag);
      g.addEventListener("click", e => {
        if (skipClick) { skipClick = false; e?.preventDefault?.(); return; }
        selectDesktopAnnotationNode({
          id: n.rawId, title: n.title,
          kind: n.kind === "module" ? "module" : n.kind === "task" ? "task" : "stage",
          layer: n.kind === "module" ? "system" : n.kind === "task" ? "agents" : "flow",
        });
      });
      svg.append(g);
      groups.set(n.id, g);
    }
    let pan = null;
    canvas.addEventListener("pointerdown", e => {
      if (!e || (typeof e.button === "number" && e.button !== 0) || dragNode) return;
      if (e.target?.closest?.(".uw-kg-node, button")) return;
      pan = { pid: e.pointerId, sx: e.clientX, sy: e.clientY, bx: tx, by: ty };
      canvas.dataset.panning = "true";
      canvas.setPointerCapture?.(e.pointerId);
    });
    canvas.addEventListener("pointermove", e => {
      if (!pan || e.pointerId !== pan.pid) return;
      tx = pan.bx + (e.clientX - pan.sx);
      ty = pan.by + (e.clientY - pan.sy);
      applyCam();
    });
    const stopPan = e => {
      if (!pan) return;
      delete canvas.dataset.panning;
      canvas.releasePointerCapture?.(e?.pointerId);
      pan = null;
    };
    canvas.addEventListener("pointerup", stopPan);
    canvas.addEventListener("pointercancel", stopPan);
    canvas.addEventListener("wheel", e => {
      if (!e) return;
      if (e.ctrlKey || e.metaKey || card.dataset.maximized === "true" || scale !== 1) {
        e.preventDefault?.();
        scale = Math.min(2.5, Math.max(0.45, scale * (e.deltaY < 0 ? 1.12 : 0.89)));
        applyCam();
      }
    }, { passive: false });
    canvas.append(svg);
    card.append(canvas);
    return card;
  }

  const SHORT_STAGE_TITLES = {
    goal: "明确目标",
    research: "方案比选",
    decision: "拍板方案 B1",
    design: "产品设计 B2",
    execution: "Subagent 执行",
    acceptance: "成果验收 B4",
    critical: "明确目标",
    fetch: "调研取证",
    thinking: "产品设计",
    subagent: "Subagent 执行",
    review: "质量审查",
    metareview: "独立复审",
    "meta-review": "独立复审",
    meta_review: "独立复审",
    verification: "证据验收",
    evolution: "经验沉淀",
  };

  function renderTopFlowRibbon() {
    if (!topFlowRibbon) return;
    const list = flowStages();
    const activeSubagents = runTasks().filter(isDispatchedRunTask).length;
    const sig = JSON.stringify({
      mode,
      selectedId: selection?.id,
      activeSubagents,
      b4: acceptance.snapshot?.status,
      stages: list.map(s => `${s.id}:${s.status}:${s.summary}`),
    });
    if (sig === lastTopFlowSignature) return;
    lastTopFlowSignature = sig;
    topFlowRibbon.replaceChildren();
    const kicker = el("span", "uw-top-flow-kicker", "执行进度");
    topFlowRibbon.append(kicker);
    const nodes = el("ol", "uw-top-flow-list");
    for (const [index, stage] of list.entries()) {
      const row = el("li", "uw-top-flow-item");
      const stageKey = String(stage.id || stage.title || "").toLowerCase();
      const shortTitle = SHORT_STAGE_TITLES[stageKey] || stage.title;
      const node = makeButton("", () => {
        if (stage.id === "design") {
          activateMode("knowledge");
          return;
        }
        if (stage.id === "acceptance" && (acceptance.snapshot || execution.snapshot?.status === "ready_for_review")) {
          mode = "knowledge";
          selectDesktopAnnotationNode({ id: "acceptance", title: stage.title, kind: "stage" });
          return;
        }
        selectDesktopAnnotationNode({ id: stage.id, title: stage.title, kind: "stage" });
        activateMode("live-run");
      }, "uw-agent-flow-node uw-top-flow-step");
      node.dataset.state = safeStatus(stage.status);
      node.dataset.selected = String(selection?.id === stage.id);
      node.setAttribute("aria-pressed", String(selection?.id === stage.id));
      node.setAttribute("aria-label", `${stage.title}，${labelFor(stage.status)}；点击查看进度或完整运行图`);
      node.title = `${stage.title}（${labelFor(stage.status)}）· ${clean(stage.summary, 140)} · 点击打开完整运行图`;
      node.append(
        el("span", "uw-top-flow-num", String(index + 1).padStart(2, "0")),
        el("strong", "uw-top-flow-name", shortTitle),
        el("small", "uw-top-flow-state", labelFor(stage.status)),
      );
      row.append(node);
      nodes.append(row);
    }
    topFlowRibbon.append(nodes);
    const runJumpLabel = mode === "live-run"
      ? "← 返回产品设计 PRD"
      : (activeSubagents > 0 ? `完整运行图 · Subagents (${activeSubagents}) ↗` : "完整运行图 · Subagents ↗");
    const runJumpBtn = makeButton(runJumpLabel, () => {
      activateMode(mode === "live-run" ? "knowledge" : "live-run");
    }, "uw-top-flow-graph-btn");
    runJumpBtn.setAttribute("aria-pressed", String(mode === "live-run"));
    runJumpBtn.title = mode === "live-run" ? "切回两级产品设计 PRD 与模块完成状态" : "打开包含 Main Agent 与 Subagent 实时拓扑的完整运行图";
    topFlowRibbon.append(runJumpBtn);
  }

  function renderFlow() {
    const list = flowStages();
    nodeCount = list.length;
    const shell = el("div", "uw-agent-flow");
    shell.append(renderEightStageStrip(list));
    const nodes = el("ol", "uw-agent-flow-nodes");
    for (const [index, stage] of list.entries()) {
      const row = el("li", "uw-agent-flow-row");
      const node = makeButton("", () => selectDesktopAnnotationNode({ id: stage.id, title: stage.title, kind: "stage" }), "uw-agent-flow-node");
      node.dataset.state = safeStatus(stage.status);
      node.dataset.selected = String(selection?.id === stage.id);
      node.setAttribute("aria-pressed", String(selection?.id === stage.id));
      node.setAttribute("aria-label", `${stage.title}，${labelFor(stage.status)}；点击标注这个节点`);
      const number = el("span", "uw-agent-flow-index", String(index + 1).padStart(2, "0"));
      const content = el("span", "uw-agent-flow-copy");
      content.append(el("strong", "", stage.title), el("small", "", clean(stage.summary, 140)));
      node.append(number, content, el("span", "uw-agent-flow-status", labelFor(stage.status)));
      row.append(node);
      nodes.append(row);
    }
    shell.append(nodes);
    if (selection?.kind === "stage" && selection.id === "acceptance"
      && (acceptance.snapshot || execution.snapshot?.status === "ready_for_review")) {
      drawAcceptanceCard(shell);
    }
    return shell;
  }
  function appendPrdSpecSection(host, titleText, itemsOrText, wide = false) {
    if (!itemsOrText || (Array.isArray(itemsOrText) && !itemsOrText.length)) return;
    const block = el("div", wide ? "uw-prd-spec-field uw-prd-spec-wide" : "uw-prd-spec-field");
    block.append(el("strong", "", titleText));
    if (Array.isArray(itemsOrText)) {
      const ul = el("ul", "uw-prd-spec-list");
      for (const row of itemsOrText) {
        const textVal = clean(row, 420);
        if (textVal) ul.append(el("li", "", textVal));
      }
      if (!ul.children.length) return;
      block.append(ul);
    } else {
      block.append(el("p", "", clean(itemsOrText, 1600)));
    }
    host.append(block);
  }
  function prdStatusBadge(statusValue) {
    const normalized = safeStatus(statusValue || "planned");
    const badge = el("span", "uw-prd-status-pill", labelFor(normalized));
    badge.dataset.state = normalized;
    return badge;
  }
  function renderSystemSpecCard(blueprint, { compact = false, onSelectModule = null } = {}) {
    const rawSystem = blueprint.raw?.system || {
      title: blueprint.design?.architecture?.title || "系统框架",
      goal: blueprint.design?.architecture?.summary || "",
      userJourney: [],
      architecture: "",
      boundaries: [],
      acceptance: [],
      layers: [],
    };
    const designModules = Array.isArray(blueprint.design?.modules) ? blueprint.design.modules : [];
    const doneCount = designModules.filter(m => m.status === "completed" || m.status === "accepted").length;
    const sysState = blueprint.design?.architecture?.status || rawSystem.status || "planned";
    const card = el("section", "uw-prd-spec-card uw-prd-spec-level1");
    const head = el("div", "uw-prd-spec-card-head");
    const titleGroup = el("div", "uw-prd-spec-title-group");
    titleGroup.append(
      el("span", "uw-prd-level-badge", "一级 PRD · 系统框架"),
      el("h4", "", clean(rawSystem.title || "系统框架", 160)),
    );
    const headRight = el("div", "uw-prd-spec-head-actions");
    headRight.append(
      prdStatusBadge(sysState),
      el("span", "uw-prd-spec-meta", `已完成 ${doneCount} / ${designModules.length} 个二级模块`),
    );
    head.append(titleGroup, headRight);
    card.append(head);
    const grid = el("div", "uw-prd-spec-grid");
    appendPrdSpecSection(grid, "产品定位与核心价值", rawSystem.goal, true);
    if (Array.isArray(rawSystem.userJourney) && rawSystem.userJourney.length) {
      appendPrdSpecSection(grid, "核心用户使用流程", rawSystem.userJourney, true);
    } else if (rawSystem.architecture) {
      appendPrdSpecSection(grid, "核心业务主流程", rawSystem.architecture, true);
    }
    if (Array.isArray(rawSystem.layers) && rawSystem.layers.length) {
      const layerBox = el("div", "uw-prd-spec-field uw-prd-spec-wide");
      layerBox.append(el("strong", "", "一级系统框架版图（点击任意二级模块查看系统详情与完成状态）"));
      const layerStack = el("div", "uw-prd-layer-stack");
      for (const [idx, layer] of rawSystem.layers.entries()) {
        const row = el("div", "uw-prd-layer-row");
        row.append(el("span", "uw-prd-layer-tag", `板块 ${idx + 1} · ${clean(layer.label, 60)}`));
        const chips = el("div", "uw-prd-layer-chips");
        for (const [mIdx, modId] of (layer.moduleIds || []).entries()) {
          const modTitle = layer.moduleTitles?.[mIdx] || modId;
          const modObj = designModules.find(m => m.id === modId);
          const modState = safeStatus(modObj?.status || layer.moduleStatuses?.[mIdx] || "completed");
          const chipLabel = `${clean(modTitle, 52)} · ${labelFor(modState)}`;
          if (typeof onSelectModule === "function") {
            const chip = makeButton(chipLabel, () => onSelectModule(modId, modTitle), "uw-prd-module-chip");
            chip.dataset.state = modState;
            chips.append(chip);
          } else {
            const spanChip = el("span", "uw-prd-module-chip", chipLabel);
            spanChip.dataset.state = modState;
            chips.append(spanChip);
          }
        }
        row.append(chips);
        layerStack.append(row);
      }
      layerBox.append(layerStack);
      grid.append(layerBox);
    }
    if (!compact || !rawSystem.layers?.length) {
      appendPrdSpecSection(grid, "产品体验原则与安全红线", rawSystem.boundaries);
    }
    appendPrdSpecSection(grid, "整体产品验收标准", rawSystem.acceptance);
    card.append(grid);
    if (savedDesign() && blueprint.kind === "agent_saved_design") {
      for (const note of designNotes("system", "system")) {
        card.append(el("p", "uw-live-node-note", `待修改 · ${note.feedback}`));
      }
    }
    return card;
  }
  function renderModuleSpecCard(blueprint, moduleId, { onSelectModule = null, onFocusGraph = null } = {}) {
    const rawModules = Array.isArray(blueprint.raw?.modules) ? blueprint.raw.modules : [];
    const designModules = Array.isArray(blueprint.design?.modules) ? blueprint.design.modules : [];
    const rawMod = rawModules.find(item => item.id === moduleId);
    const projMod = designModules.find(item => item.id === moduleId);
    if (!rawMod && !projMod) return null;
    const titleText = clean(rawMod?.title || projMod?.title || moduleId, 140);
    const modStatus = projMod?.status || rawMod?.status || "planned";
    const deps = rawMod?.dependencies || projMod?.dependsOn || [];
    const dependents = designModules.filter(item => (item.dependsOn || []).includes(moduleId));
    const card = el("section", "uw-prd-spec-card uw-prd-spec-level2");
    const head = el("div", "uw-prd-spec-card-head");
    const titleGroup = el("div", "uw-prd-spec-title-group");
    const badgeParts = ["二级 PRD · 系统详情"];
    if (rawMod?.layer) badgeParts.push(clean(rawMod.layer, 50));
    titleGroup.append(el("span", "uw-prd-level-badge", badgeParts.join(" · ")), el("h4", "", titleText));
    const headActions = el("div", "uw-prd-spec-head-actions");
    headActions.append(prdStatusBadge(modStatus));
    if (typeof onFocusGraph === "function") {
      headActions.append(makeButton("在图谱定位", () => onFocusGraph(moduleId, titleText), "uw-agent-knowledge-back"));
    }
    head.append(titleGroup, headActions);
    card.append(head);
    const grid = el("div", "uw-prd-spec-grid");
    appendPrdSpecSection(grid, "功能定位与用户价值", rawMod?.objective || projMod?.summary, true);
    if (Array.isArray(rawMod?.features) && rawMod.features.length) {
      appendPrdSpecSection(grid, "核心功能点与交互体验", rawMod.features, true);
    }
    appendPrdSpecSection(grid, "上游输入（用户操作 / 前置条件）", rawMod?.inputContract);
    appendPrdSpecSection(grid, "下游产出（页面反馈 / 交付结果）", rawMod?.outputContract);
    const relBlock = el("div", "uw-prd-spec-field");
    relBlock.append(el("strong", "", "上下游协同模块"));
    const relWrap = el("div", "uw-prd-layer-chips");
    if (!deps.length && !dependents.length) {
      relWrap.append(el("span", "uw-prd-spec-meta", "独立基础能力 · 无需等待其他模块"));
    } else {
      for (const depId of deps) {
        const depTitle = designModules.find(m => m.id === depId)?.title || depId;
        const label = `前置：${clean(depTitle, 48)}`;
        relWrap.append(typeof onSelectModule === "function"
          ? makeButton(label, () => onSelectModule(depId, depTitle), "uw-prd-module-chip")
          : el("span", "uw-prd-module-chip", label));
      }
      for (const child of dependents) {
        const label = `支撑：${clean(child.title || child.id, 48)}`;
        relWrap.append(typeof onSelectModule === "function"
          ? makeButton(label, () => onSelectModule(child.id, child.title || child.id), "uw-prd-module-chip uw-prd-chip-downstream")
          : el("span", "uw-prd-module-chip uw-prd-chip-downstream", label));
      }
    }
    relBlock.append(relWrap);
    grid.append(relBlock);
    appendPrdSpecSection(grid, "异常兜底与体验边界", rawMod?.boundaries);
    appendPrdSpecSection(grid, "产品验收清单", rawMod?.acceptance, true);
    card.append(grid);
    if (rawMod?.directory && rawMod.directory !== ".") {
      const tech = el("details", "uw-prd-tech-footnote");
      tech.append(
        el("summary", "", "开发实现映射（供工程师参考）"),
        el("p", "", `对应工程模块路径：${rawMod.directory}${Number.isInteger(rawMod.fileCount) ? `（受管源文件 ${rawMod.fileCount} 个）` : ""}${rawMod.entrypoints?.length ? ` · 关键入口：${rawMod.entrypoints.join("、")}` : ""}`),
      );
      card.append(tech);
    }
    if (savedDesign() && blueprint.kind === "agent_saved_design") {
      for (const note of designNotes("module", moduleId)) {
        card.append(el("p", "uw-live-node-note", `待修改 · ${note.feedback}`));
      }
      card.append(el("p", "uw-prd-spec-hint", "已圈选此二级模块：可在左侧输入框直接输入修改意见，或用「验收改为：…」修订字段。"));
    }
    return card;
  }
  function renderKnowledge() {
    const shell = el("div", "uw-agent-knowledge");
    if (acceptance.snapshot || execution.snapshot?.status === "ready_for_review") {
      drawAcceptanceCard(shell);
    }
    const hasTaskDesign = Boolean(taskDesignSource());
    const hasBaselineDesign = Boolean(baselineDesignSource());
    const parsedStrategies = strategies();
    if (!["system", "spec", "strategies"].includes(knowledgeLayer)
      || (knowledgeLayer === "strategies" && !parsedStrategies)) {
      knowledgeLayer = "system";
    }
    const toolbar = el("div", "uw-agent-knowledge-toolbar");
    const layers = [["system", "系统框架与进度图"], ["spec", "完整产品设计 PRD"]];
    if (parsedStrategies) layers.push(["strategies", "B1 候选方案对照"]);
    const chooser = el("div", "uw-agent-knowledge-layers");
    chooser.setAttribute("role", "group"); chooser.setAttribute("aria-label", "选择产品设计 PRD 视图");
    for (const [id, label] of layers) {
      const button = makeButton(label, () => { knowledgeLayer = id; lastCanvasSignature = ""; render(); }, "uw-agent-knowledge-layer");
      button.setAttribute("aria-pressed", String(knowledgeLayer === id));
      chooser.append(button);
    }
    toolbar.append(chooser);
    if (hasTaskDesign && hasBaselineDesign && knowledgeLayer !== "strategies") {
      const currentBlueprint = designSource();
      const srcGroup = el("div", "uw-agent-knowledge-layers");
      srcGroup.setAttribute("role", "group"); srcGroup.setAttribute("aria-label", "切换 PRD 设计来源");
      for (const [pref, label, active] of [
        ["task", "本轮新需求 PRD", currentBlueprint?.kind !== "project_architecture_baseline"],
        ["baseline", "当前产品总 PRD", currentBlueprint?.kind === "project_architecture_baseline"],
      ]) {
        const btn = makeButton(label, () => { prdSourcePref = pref; selection = null; lastCanvasSignature = ""; render(); }, "uw-agent-knowledge-layer");
        btn.setAttribute("aria-pressed", String(active));
        srcGroup.append(btn);
      }
      toolbar.append(srcGroup);
    }
    shell.append(toolbar);

    if (knowledgeLayer === "strategies" && parsedStrategies) {
      nodeCount = parsedStrategies.strategies.length;
      const stratWrap = el("section", "uw-prd-spec-card");
      stratWrap.append(
        el("div", "uw-live-view-kicker", "B1 候选方案对照矩阵 · 客户端研究回执（依据尚未独立核验）"),
        el("p", "uw-prd-spec-summary", clean(parsedStrategies.summary, 600)),
      );
      const matrix = el("div", "uw-prd-strategy-grid");
      for (const option of parsedStrategies.strategies) {
        const card = el("article", "uw-prd-strategy-card");
        const topRow = el("div", "uw-prd-spec-card-head");
        topRow.append(el("strong", "", `方案 ${option.id} · ${clean(option.title, 90)}`));
        if (parsedStrategies.recommendedStrategyId === option.id) {
          topRow.append(el("span", "uw-prd-level-badge", "模型推荐 · 待人工拍板"));
        }
        card.append(topRow);
        appendPrdSpecSection(card, "实施路径", option.approach);
        appendPrdSpecSection(card, "关键取舍", option.tradeoffs);
        appendPrdSpecSection(card, "潜在风险", option.risks);
        appendPrdSpecSection(card, "参考依据（未经独立核验）", option.evidenceSummary);
        matrix.append(card);
      }
      stratWrap.append(matrix);
      shell.append(stratWrap);
      return shell;
    }

    const blueprint = designSource();
    if (!blueprint) {
      nodeCount = 0;
      const empty = el("div", "uw-live-empty");
      empty.append(
        el("span", "uw-live-empty-symbol", "◎"),
        el("h3", "", "正在加载产品设计 PRD"),
        el("p", "", "一级展示系统整体框架与定位，二级展示各子系统功能详情与完成状态。可在左侧直接输入需求，或稍候当前仓库产品基线载入。"),
      );
      const actions = el("div", "uw-chat-action-group");
      actions.append(makeButton("打开完整运行图 · Subagents", () => activateMode("live-run"), "uw-chat-secondary"));
      empty.append(actions);
      shell.append(empty);
      return shell;
    }

    const pickModule = (modId, modTitle) => {
      const cleanId = String(modId || "").replace(/^module:/u, "");
      selectDesktopAnnotationNode({ id: cleanId, title: modTitle || cleanId, kind: "module", layer: "system" });
    };
    const focusId = selection?.kind === "module" && ["knowledge", "system"].includes(selection?.layer)
      ? selection.id.replace(/^module:/u, "")
      : null;

    const allMods = Array.isArray(blueprint.design?.modules) ? blueprint.design.modules : [];
    const doneMods = allMods.filter(m => m.status === "completed" || m.status === "accepted").length;
    const pct = allMods.length ? Math.round((doneMods / allMods.length) * 100) : 0;
    const progressBanner = el("div", "uw-prd-completion-banner");
    const progressTop = el("div", "uw-prd-completion-top");
    const originTitle = ({
      governed_run: "正式运行 · 两级产品设计 PRD",
      agent_saved_design: `本轮任务产品设计 PRD · v${blueprint.version}`,
      agent_unverified_draft: "本轮任务产品设计草稿 · 待人工审阅",
      project_architecture_baseline: "当前仓库产品设计 PRD（一级：系统框架 · 二级：系统详情）",
    })[blueprint.kind] || "两级产品设计 PRD";
    progressTop.append(
      el("strong", "", originTitle),
      el("span", "uw-prd-completion-stat", `完成进度：${doneMods} / ${allMods.length} 个二级系统（${pct}%）`),
    );
    const track = el("div", "uw-prd-completion-track");
    const fill = el("span", "uw-prd-completion-fill");
    fill.setAttribute("style", `width:${pct}%`);
    track.append(fill);
    progressBanner.append(progressTop, track);
    shell.append(progressBanner);

    if (focusId && knowledgeLayer === "system") {
      const top = el("div", "uw-agent-knowledge-top");
      top.append(
        el("span", "uw-live-view-kicker", `当前正在查看二级系统详情：${allMods.find(m => m.id === focusId)?.title || focusId}`),
        makeButton("返回完整系统框架图", () => { selection = null; lastCanvasSignature = ""; render(); }, "uw-agent-knowledge-back"),
      );
      shell.append(top);
    }

    if (knowledgeLayer === "spec") {
      nodeCount = (blueprint.design?.modules?.length || 0) + 1;
      const specDoc = el("div", "uw-prd-full-spec");
      specDoc.append(renderSystemSpecCard(blueprint, {
        compact: false,
        onSelectModule: (modId, modTitle) => { knowledgeLayer = "system"; pickModule(modId, modTitle); },
      }));
      const modulesHeading = el("div", "uw-prd-spec-section-heading");
      modulesHeading.append(
        el("span", "uw-prd-level-badge", "二级 PRD · 系统详情"),
        el("strong", "", `共 ${blueprint.design?.modules?.length || 0} 个二级系统详情规格`),
      );
      specDoc.append(modulesHeading);
      for (const mod of blueprint.design?.modules || []) {
        const modCard = renderModuleSpecCard(blueprint, mod.id, {
          onSelectModule: (targetId, targetTitle) => {
            knowledgeLayer = "system";
            pickModule(targetId, targetTitle);
          },
          onFocusGraph: (targetId, targetTitle) => {
            knowledgeLayer = "system";
            pickModule(targetId, targetTitle);
          },
        });
        if (modCard) specDoc.append(modCard);
      }
      shell.append(specDoc);
      return shell;
    }

    if (typeof createWorkflowCanvas === "function") {
      const wfSource = blueprint.kind === "project_architecture_baseline" ? state.prdWorkflowCanvas : null;
      nodeCount = wfSource?.nodes?.filter(n => n.kind !== "terminal")?.length || (blueprint.design?.modules?.length || 0);
      shell.append(createWorkflowCanvas({
        doc,
        workflow: wfSource,
        blueprint,
        selectedNodeId: focusId,
        busy: Boolean(state.prdWorkflowBusy || design.busy),
        errorMessage: state.prdWorkflowError || "",
        onSelectNode: node => {
          if (node.kind === "architecture") {
            selectDesktopAnnotationNode({ id: node.sourceId || node.id, title: node.title, kind: "architecture", layer: "system" });
          } else {
            pickModule(node.sourceId || node.id, node.title);
          }
        },
        onMutateWorkflow: typeof callbacks.mutatePrdWorkflow === "function"
          ? (mutation) => callbacks.mutatePrdWorkflow(mutation, blueprint)
          : null,
      }));
    } else {
      const graph = buildGraph(blueprint.design, { focusId, depth: knowledgeDepth, limit: knowledgeLimit });
      nodeCount = graph.nodes.length;
      shell.append(createGraph({ doc, graph, copy, focusId, depth: knowledgeDepth,
        onSelect: node => {
          if (node.kind === "architecture") {
            selectDesktopAnnotationNode({ id: node.sourceId || node.id, title: node.title, kind: "architecture", layer: "system" });
          } else {
            pickModule(node.sourceId || node.id, node.title);
          }
        },
        onDepthChange: value => { knowledgeDepth = value; lastCanvasSignature = ""; render(); },
        onExpand: () => { knowledgeLimit = Math.min(2000, knowledgeLimit + 40); lastCanvasSignature = ""; render(); } }));
    }

    const specInspector = el("div", "uw-prd-spec-inspector");
    if (focusId) {
      const modSpec = renderModuleSpecCard(blueprint, focusId, { onSelectModule: pickModule });
      if (modSpec) specInspector.append(modSpec);
    } else {
      specInspector.append(renderSystemSpecCard(blueprint, { compact: true, onSelectModule: pickModule }));
    }
    shell.append(specInspector);
    return shell;
  }
  function sessionsWithRealWorkers() {
    const sessions = Array.isArray(state.project?.sessions) ? state.project.sessions : [];
    return sessions.filter(s => s?.runId && s.runId !== state.selection?.runId
      && ((s.workerCount || 0) >= 2 || ((s.workerCount || 0) >= 1 && s.status === "completed") || s.observationKind === "native_execution"))
      .slice(0, 4);
  }
  function renderBindingDrawer() {
    if (!bindingDrawer) return;
    openBindingBtn?.setAttribute("aria-expanded", String(bindingDrawerOpen));
    bindingDrawer.hidden = !bindingDrawerOpen;
    if (!bindingDrawerOpen) return;
    const selectedChannel = callbacks.getSelectedHostChannel?.() || "auto";
    const bindings = state.sessionBindings;
    const sig = JSON.stringify({
      open: bindingDrawerOpen,
      selectedChannel,
      hosts: (agent.hosts || []).map(h => `${h.id}:${h.available}:${h.launchSupported}:${h.version}`),
      ext: (bindings?.externalSessions || []).map(s => `${s.runtime}:${s.sessionId}:${s.turnId}:${s.alreadyBound}`),
      hooks: bindings?.enrolledRuntimes,
      notice: bindingNotice,
      project: state.agentServerProjectLabel,
    });
    if (sig === lastBindingSignature) return;
    lastBindingSignature = sig;
    bindingDrawer.replaceChildren();
    const head = el("div", "uw-binding-head");
    head.append(
      el("strong", "", `双向 Agent 绑定与渠道中心 · ${state.agentServerProjectLabel || "当前仓库"}`),
      makeButton("收起 ×", () => { bindingDrawerOpen = false; renderBindingDrawer(); }, "uw-inventory-flyout-close"),
    );
    bindingDrawer.append(head);
    if (bindingNotice) bindingDrawer.append(el("p", "uw-binding-notice", bindingNotice));

    const cols = el("div", "uw-binding-columns");
    // Forward direction: App -> External CLI Channel
    const forwardBox = el("div", "uw-binding-card");
    forwardBox.append(
      el("span", "uw-prd-level-badge", "正向调用 · 本控制台调起 Agent 渠道"),
      el("p", "uw-binding-desc", "在下方输入框发送目标时，使用所选受控 CLI 渠道执行只读研究与设计生成："),
    );
    const channelList = el("div", "uw-binding-channel-list");
    const readyHosts = (agent.hosts || []).filter(h => h.available && h.launchSupported && !/codex/iu.test(h.id));
    if (readyHosts.length) {
      const autoBtn = makeButton(`自动优选（${readyHosts[0].label}）`, () => {
        callbacks.selectHostChannel?.("auto");
        bindingNotice = `已切换正向调用渠道为：自动优选（${readyHosts[0].label}）`;
        lastBindingSignature = "";
        renderBindingDrawer();
      }, "uw-binding-channel-btn");
      autoBtn.setAttribute("aria-pressed", String(selectedChannel === "auto"));
      channelList.append(autoBtn);
    }
    for (const h of agent.hosts || []) {
      const usable = Boolean(h.available && h.launchSupported && !/codex/iu.test(h.id));
      const tag = usable ? `就绪${h.version ? ` · ${h.version}` : ""}` : (h.available ? "已检测 · 仅观测/待授权" : "未安装");
      const btn = makeButton(`${h.label}（${tag}）`, () => {
        if (!usable) {
          bindingNotice = `${h.label} 当前不可直接由控制台启动（${h.statusLabel || "可用于反向 Hook 接入"}）。`;
        } else {
          callbacks.selectHostChannel?.(h.id);
          bindingNotice = `已切换正向调用渠道为：${h.label}`;
        }
        lastBindingSignature = "";
        renderBindingDrawer();
      }, "uw-binding-channel-btn");
      btn.dataset.usable = String(usable);
      btn.setAttribute("aria-pressed", String(selectedChannel === h.id));
      channelList.append(btn);
    }
    forwardBox.append(channelList);
    if (typeof callbacks.redetect === "function") {
      forwardBox.append(makeButton("重新探测本机渠道", () => { bindingNotice = "正在重新扫描本机 CLI 渠道…"; callbacks.redetect(); }, "uw-native-host-detect"));
    }
    cols.append(forwardBox);

    // Reverse direction: Started inside external Agent -> Bound live to this console
    const reverseBox = el("div", "uw-binding-card");
    reverseBox.append(
      el("span", "uw-prd-level-badge", "反向接入 · 外部 Agent 启动并实时同步"),
      el("p", "uw-binding-desc", "在终端或 IDE 的 Agent 中直接工作，自动或一键接入当前独立控制台："),
    );
    const hookRow = el("div", "uw-prd-layer-chips");
    if (Array.isArray(bindings?.enrolledRuntimes) && bindings.enrolledRuntimes.length) {
      for (const hr of bindings.enrolledRuntimes) {
        hookRow.append(el("span", "uw-prd-module-chip uw-prd-chip-downstream", `${hr.label}${hr.autoSync ? " · Hook 自动同步已启用" : " · 配置已就绪"}`));
      }
    } else {
      hookRow.append(el("span", "uw-prd-spec-meta", "运行 npm run meta:sync 可为该仓库开启自动同步 Hook"));
    }
    reverseBox.append(hookRow);
    const extList = Array.isArray(bindings?.externalSessions) ? bindings.externalSessions : [];
    if (extList.length) {
      const sessWrap = el("div", "uw-binding-session-list");
      for (const sess of extList.slice(0, 5)) {
        const item = el("div", "uw-binding-session-row");
        const meta = el("div", "uw-binding-session-copy");
        meta.append(
          el("strong", "", `${sess.runtimeLabel} · ${clean(sess.title, 56)}`),
          el("small", "", `${sess.sessionId.slice(0, 8)}${sess.branch ? ` · ${sess.branch}` : ""}`),
        );
        item.append(meta);
        if (sess.bindable && sess.turnId) {
          const bindBtn = makeButton(sess.alreadyBound ? "实时查看" : "接入观测", async () => {
            if (sess.alreadyBound && sess.runId) {
              callbacks.selectProjectRun?.(state.selection?.projectId, sess.runId);
              bindingDrawerOpen = false;
              renderBindingDrawer();
              return;
            }
            bindingNotice = "正在绑定外部会话…";
            lastBindingSignature = "";
            renderBindingDrawer();
            const out = await callbacks.bindExternalSession?.({ runtime: sess.runtime, sessionId: sess.sessionId, turnId: sess.turnId });
            bindingNotice = out?.ok ? `已接入会话 ${sess.sessionId.slice(0, 8)}，正在同步实时流！` : "该会话暂无法绑定，请确认会话日志完整。";
            if (out?.ok) bindingDrawerOpen = false;
            lastBindingSignature = "";
            renderBindingDrawer();
          }, "uw-agent-knowledge-back");
          item.append(bindBtn);
        } else {
          const viewRunsBtn = makeButton("从运行记录打开", () => {
            bindingDrawerOpen = false;
            renderBindingDrawer();
            callbacks.openProjectPicker?.();
          }, "uw-agent-knowledge-back");
          item.append(viewRunsBtn);
        }
        sessWrap.append(item);
      }
      reverseBox.append(sessWrap);
    } else {
      reverseBox.append(el("p", "uw-prd-spec-meta", "暂未扫描到该仓库近期的外部 Codex / Claude Code 本地会话日志。"));
    }
    cols.append(reverseBox);
    bindingDrawer.append(cols);
  }
  function renderAgents() {
    const allTasks = runTasks();
    const tasks = allTasks.filter(isDispatchedRunTask);
    const hasOnlyPlanning = !tasks.length && allTasks.length > 0;
    nodeCount = tasks.length;
    const shell = el("div", "uw-agent-collaboration");
    shell.append(el("div", "uw-live-view-kicker", isCurrentRun() ? "正式 Run · Agent 工作与证据" : "Agent 协作 · 注册角色不代表已调用"));
    if (!tasks.length) {
      const empty = el("div", "uw-live-empty uw-live-agents-empty");
      empty.append(
        el("span", "uw-live-empty-symbol", "◇"),
        el("h3", "", hasOnlyPlanning ? "当前所选运行仅含规划，尚未派发 Subagents" : "等待真实 Agent / Subagent 协作记录"),
        el("p", "", hasOnlyPlanning
          ? "当前选中的历史记录仅生成了任务规划占位，并未实际启动子 Agent。你可在下方一键切换到含真实 Subagent 执行回执的运行，或在左侧「Subagents」查看 60+ 已配置预设。"
          : "已注册 Agent 与 Subagent 预设可在左侧打开大面板查看；这里仅展示真实派发的执行任务、回报和调用证据。"),
      );
      const richSessions = sessionsWithRealWorkers();
      if (richSessions.length && typeof callbacks.selectProjectRun === "function") {
        const jumpGroup = el("div", "uw-chat-action-group");
        for (const s of richSessions) {
          jumpGroup.append(makeButton(
            `查看「${clean(s.title || s.runId, 24)}」（${s.workerCount || 1} 个执行节点）`,
            () => callbacks.selectProjectRun(state.selection?.projectId, s.runId),
            "uw-chat-secondary",
          ));
        }
        empty.append(jumpGroup);
      }
      shell.append(empty);
      return shell;
    }
    for (const task of tasks) {
      const selected = selection?.kind === "task" && selection.id === task.id;
      const card = el("article", "uw-agent-runtime-card");
      card.dataset.state = taskVisualState(task);
      card.dataset.selected = String(selected);
      const header = makeButton("", () => selectDesktopAnnotationNode({ id: task.id, title: task.title, kind: "task", layer: "agents" }), "uw-agent-runtime-card-heading");
      header.setAttribute("aria-pressed", String(selected));
      const identity = el("span", "uw-agent-runtime-identity");
      const copy = el("span", "uw-agent-runtime-copy");
      copy.append(el("strong", "", taskRole(task)), el("small", "", taskOwner(task)));
      identity.append(agentMark(taskOwner(task)), copy);
      header.append(identity, el("span", "uw-agent-runtime-state", task.statusLabel || labelFor(task.status)));
      card.append(header);
      card.append(el("p", "uw-agent-runtime-task", clean(task.title || task.source?.task, 180)));
      const outcome = taskOutcome(task);
      const result = el("div", "uw-agent-runtime-result");
      result.dataset.level = outcome.level;
      result.append(el("strong", "", outcome.heading), el("p", "", outcome.detail));
      if (outcome.at) result.append(el("small", "", outcome.at));
      card.append(result);
      if (selected) {
        const scope = clean(task.source?.task || task.summary, 320);
        if (scope && scope !== outcome.detail) card.append(el("p", "uw-agent-runtime-scope", `任务范围：${scope}`));
        const details = el("div", "uw-agent-runtime-capabilities");
        for (const family of capabilityFamilies) {
          const record = (task.source?.capabilityTruth || []).find(item => item?.kind === family.kind);
          if (!record) continue;
          const actual = record.state === "observed" && Array.isArray(record.actualNames) ? record.actualNames : [];
          const selectedNames = Array.isArray(record.plannedNames) ? record.plannedNames.filter(name => !actual.includes(name)) : [];
          if (!actual.length && !selectedNames.length) continue;
          const group = el("div", "uw-agent-runtime-capability-group");
          group.append(el("b", "", family.name));
          for (const name of actual) group.append(el("span", "", `${clean(name, 96)} · 已观测调用`));
          for (const name of selectedNames) group.append(el("span", "", `${clean(name, 96)} · 已选择未观测调用`));
          details.append(group);
        }
        if (!details.children.length) details.append(el("p", "", "未记录 Skill / MCP / Hook 等实际调用证据。"));
        card.append(details);
        card.append(el("p", "uw-agent-runtime-inspector-note", "关联当前任务的正式修改仍须经过受控执行接口；这里只查看真实回执。"));
      }
      shell.append(card);
    }
    return shell;
  }
  function renderInventory() {
    if (!inventory) return;
    const allRunTasks = runTasks();
    const tasks = allRunTasks.filter(isDispatchedRunTask);
    const hasPlanningOnlyTasks = !tasks.length && allRunTasks.length > 0;
    const catalog = state.capabilityCatalog;
    const signature = JSON.stringify({ runId: isCurrentRun() ? state.selection?.runId : null,
      planningOnly: state.snapshot?.run?.executionEvidenceState === "structural_planning_only",
      agentLoading: agent.loading === true, canWrite: state.canWrite !== false,
      selectionId: selection?.id, inventoryQuery, inventoryFlyoutOpen, activeFlyoutSection, selectedNativeCapId,
      tasks: allRunTasks.map(task => ({ id: task.id, owner: taskOwner(task), role: taskRole(task), title: task.title,
        status: task.status, declaredNotStarted: task.source?.declaredNotStarted === true,
        executionState: task.source?.executionState,
        source: { summary: task.source.summary, task: task.source.task,
          ownerReport: task.source.ownerReport, nativeReturnEvidence: task.source.nativeReturnEvidence,
          statusReason: task.source.statusReason, parentId: task.source.parentId,
          nativeTaskCaption: task.source.nativeTaskCaption, capabilityTruth: task.source.capabilityTruth } })),
      catalog: catalog ? { agents: catalog.agents, skills: catalog.skills, hooks: catalog.hooks,
        mcpServers: catalog.mcpServers, mcpTools: catalog.mcpTools, plugins: catalog.plugins,
        commands: catalog.commands, professionalAgents: catalog.professionalAgents,
        professionalSourceStatus: catalog.professionalSourceStatus, nativeHosts: catalog.nativeHosts,
        nativeCapabilities: catalog.nativeCapabilities, evidenceLevel: catalog.evidenceLevel } : null,
      hostProbes: (agent.hosts || []).map(host => ({ id: host.id, status: host.status,
        statusLabel: host.statusLabel, available: host.available, launchSupported: host.launchSupported,
        version: host.version, reason: host.reason, nextAction: host.nextAction })) });
    if (signature === lastInventorySignature) return;
    lastInventorySignature = signature;
    const previousScroll = inventory.scrollTop;
    const isFlyoutVisible = Boolean(inventoryFlyoutOpen || normalizedInventoryQuery());
    const surface = el("div", "uw-agent-inventory-body");
    surface.dataset.flyoutOpen = String(isFlyoutVisible);
    const title = el("div", "uw-agent-inventory-title");
    const toggleFlyoutBtn = makeButton(isFlyoutVisible ? "收起 ×" : "展开 ›", () => {
      inventoryFlyoutOpen = !isFlyoutVisible;
      if (inventoryFlyoutOpen && (!activeFlyoutSection || activeFlyoutSection === "all")) {
        activeFlyoutSection = "native-hosts";
        inventoryExpanded.add("native-hosts");
      }
      if (!inventoryFlyoutOpen) {
        inventoryQuery = "";
        selectedNativeCapId = null;
      }
      lastInventorySignature = "";
      renderInventory();
    }, "uw-inventory-flyout-trigger");
    toggleFlyoutBtn.title = isFlyoutVisible ? "收起侧边能力大面板" : "在侧边展开宽幅能力与宿主大面板";
    title.append(el("strong", "", "能力与宿主"), toggleFlyoutBtn);
    surface.append(title);
    const search = el("input", "uw-agent-inventory-search");
    search.type = "search";
    search.value = inventoryQuery;
    search.placeholder = "搜索能力 / Agent";
    search.setAttribute("aria-label", "搜索 Agent、客户端与能力");
    search.setAttribute("autocomplete", "off");
    search.addEventListener("input", () => {
      const cursor = typeof search.selectionStart === "number" ? search.selectionStart : null;
      inventoryQuery = clean(search.value, 100);
      if (inventoryQuery) {
        inventoryFlyoutOpen = true;
        activeFlyoutSection = "all";
      } else if (activeFlyoutSection === "all") {
        inventoryFlyoutOpen = false;
      }
      resetInventoryScroll = true;
      lastInventorySignature = "";
      renderInventory();
      const replacement = inventory.children?.[0]?.children?.[1];
      replacement?.focus?.();
      if (cursor !== null) replacement?.setSelectionRange?.(cursor, cursor);
    });
    surface.append(search);
    let resultCount = 0;
    const nativeHosts = new Map();
    for (const host of Array.isArray(catalog?.nativeHosts) ? catalog.nativeHosts : []) {
      const id = clean(host?.id, 50);
      if (!id || nativeHosts.has(id)) continue;
      nativeHosts.set(id, { ...host, id });
    }
    for (const probe of Array.isArray(agent.hosts) ? agent.hosts : []) {
      const id = clean(probe?.id, 50);
      if (!id) continue;
      const host = nativeHosts.get(id) || { id, label: probe.label || id };
      nativeHosts.set(id, { ...host, probe });
    }
    const nativeCapabilities = (Array.isArray(catalog?.nativeCapabilities) ? catalog.nativeCapabilities : [])
      .filter(item => item && nativeFamilies.some(family => family.kind === item.kind)
        && typeof item.hostId === "string" && typeof item.id === "string");
    for (const item of nativeCapabilities) {
      if (!nativeHosts.has(item.hostId)) nativeHosts.set(item.hostId,
        { id: item.hostId, label: item.hostId, status: "not_probed" });
    }
    const discoveredHosts = [...nativeHosts.values()].filter(host => host.probe
      || nativeCapabilities.some(item => item.hostId === host.id)
      || !["not_probed", "unprobed", undefined, null].includes(host.status));
    const referenceHosts = [...nativeHosts.values()].filter(host => !discoveredHosts.includes(host));

    const openFlyoutCategory = (id) => {
      const wasSearching = Boolean(inventoryQuery);
      const alreadySameOpen = !wasSearching && inventoryFlyoutOpen && activeFlyoutSection === id && inventoryExpanded.has(id);
      if (wasSearching) inventoryQuery = "";
      const willOpen = !alreadySameOpen;
      for (const existingSec of sectionsHost.children || []) {
        if (existingSec?.dataset?.section) existingSec.open = willOpen && existingSec.dataset.section === id;
      }
      if (!willOpen) {
        inventoryFlyoutOpen = false;
        inventoryExpanded.delete(id);
        inventoryExpanded.add(`${id}:closed`);
      } else {
        inventoryFlyoutOpen = true;
        activeFlyoutSection = id;
        for (const key of [...inventoryExpanded]) {
          if (!key.startsWith("native-host:") && !key.endsWith(":closed")) inventoryExpanded.delete(key);
        }
        if (id !== "all") {
          inventoryExpanded.add(id);
          inventoryExpanded.delete(`${id}:closed`);
        }
      }
      resetInventoryScroll = true;
      lastInventorySignature = "";
      renderInventory();
    };

    const presetSubagents = nativeCapabilities.filter(item => item.kind === "subagent_config"
      && inventoryMatches(item.id, item.label, item.hostId, "subagent"));
    const totalPresetSubagents = nativeCapabilities.filter(item => item.kind === "subagent_config").length;
    const dispatchedSubagentCount = tasks.filter(task => task.source?.isMain !== true
      && (task.source?.parentId || task.source?.nativeTaskCaption)).length;
    const quicknav = el("div", "uw-agent-inventory-quicknav");
    quicknav.setAttribute("aria-label", "快速查看 Agent 与能力");
    const quickGroups = [
      ["run", "本轮活跃", new Set(tasks.map(task => taskOwner(task))).size],
      ["subagents", "Subagents", dispatchedSubagentCount],
      ["native-hosts", "宿主", discoveredHosts.length],
      ["registered-agents", "Agents", catalogItems("agents").length],
      ["professional-agents", "专业", Array.isArray(catalog?.professionalAgents) ? catalog.professionalAgents.length : 0],
      ["skill", "Skills", capabilityEntries("skill", "skills").length],
      ["mcp", "MCP", capabilityEntries("mcp", "mcpServers").length],
      ["hook", "Hooks", capabilityEntries("hook", "hooks").length],
    ];
    for (const [id, name, amount] of quickGroups) {
      const shortcut = makeButton("", () => openFlyoutCategory(id), "uw-agent-inventory-shortcut");
      shortcut.dataset.targetSection = id;
      const isShortcutActive = isFlyoutVisible && activeFlyoutSection === id && !normalizedInventoryQuery();
      shortcut.setAttribute("aria-pressed", String(isShortcutActive));
      shortcut.setAttribute("aria-label", `${name} ${amount}`);
      const badgeText = id === "subagents" && amount === 0 && totalPresetSubagents > 0
        ? `0/${totalPresetSubagents} ›`
        : `${amount} ›`;
      if (id === "subagents" && totalPresetSubagents > 0) {
        shortcut.title = `本轮派发 ${amount} 个 · 本机已配置 ${totalPresetSubagents} 个 Subagent 预设`;
      }
      shortcut.append(
        el("span", "uw-inventory-shortcut-label", name),
        el("strong", "uw-inventory-shortcut-count", badgeText),
      );
      quicknav.append(shortcut);
    }
    const extraCount = capabilityEntries("plugin", "plugins").length
      + capabilityEntries("command", "commands").length
      + capabilityEntries("mcp_tool", "mcpTools").length;
    if (extraCount > 0) {
      const moreBtn = makeButton("", () => openFlyoutCategory("plugin"), "uw-inventory-more-trigger");
      moreBtn.setAttribute("aria-pressed", String(isFlyoutVisible && ["plugin", "command", "mcp_tool", "runtime_tool"].includes(activeFlyoutSection)));
      moreBtn.append(
        el("span", "uw-inventory-shortcut-label", "更多工具与插件"),
        el("strong", "uw-inventory-shortcut-count", `${extraCount} ›`),
      );
      quicknav.append(moreBtn);
    }
    surface.append(quicknav);

    const flyout = el("aside", "uw-agent-inventory-flyout");
    flyout.dataset.uwInventoryFlyout = "true";
    flyout.setAttribute("aria-label", "能力与宿主侧边大面板");
    const flyoutHead = el("header", "uw-inventory-flyout-head");
    const flyoutTitleWrap = el("div", "uw-inventory-flyout-title");
    flyoutTitleWrap.append(
      el("strong", "", "能力与宿主目录"),
      el("small", "", tasks.length ? `${tasks.length} 个执行任务运行中` : hasPlanningOnlyTasks ? "仅规划 · 未执行（尚未派发实际任务）" : "只读能力与宿主配置状态"),
    );
    const flyoutClose = makeButton("关闭 ×", () => {
      inventoryFlyoutOpen = false;
      inventoryQuery = "";
      selectedNativeCapId = null;
      lastInventorySignature = "";
      renderInventory();
    }, "uw-inventory-flyout-close");
    flyoutHead.append(flyoutTitleWrap, flyoutClose);
    flyout.append(flyoutHead);

    const flyoutTabs = el("div", "uw-inventory-flyout-tabs");
    const allFlyoutGroups = [
      ["all", "全部"],
      ...quickGroups.map(([id, name, amount]) => [id, `${name} ${amount}`]),
      ...(totalPresetSubagents > 0 ? [["subagent-presets", `Subagent 预设 ${totalPresetSubagents}`]] : []),
      ["plugin", `Plugins ${capabilityEntries("plugin", "plugins").length}`],
      ["command", `Commands ${capabilityEntries("command", "commands").length}`],
      ["mcp_tool", `MCP Tools ${capabilityEntries("mcp_tool", "mcpTools").length}`],
    ];
    for (const [tabId, tabLabel] of allFlyoutGroups) {
      const pill = makeButton(tabLabel, () => {
        activeFlyoutSection = tabId;
        inventoryFlyoutOpen = true;
        if (tabId !== "all") {
          inventoryExpanded.add(tabId);
          inventoryExpanded.delete(`${tabId}:closed`);
        }
        lastInventorySignature = "";
        renderInventory();
      }, "uw-inventory-flyout-tab");
      pill.setAttribute("aria-pressed", String(activeFlyoutSection === tabId && !normalizedInventoryQuery()));
      flyoutTabs.append(pill);
    }
    flyout.append(flyoutTabs);

    if (selectedNativeCapId) {
      const selectedEntry = nativeCapabilities.find(item =>
        `config:${item.hostId}:${item.scope}:${item.kind}:${item.id}` === selectedNativeCapId);
      if (selectedEntry) {
        const capCard = el("div", "uw-inventory-flyout-detail");
        const capHead = el("div", "uw-inventory-flyout-detail-head");
        capHead.append(
          el("strong", "", `能力配置详情 · ${clean(selectedEntry.label || selectedEntry.id, 90)}`),
          makeButton("收起详情", () => { selectedNativeCapId = null; lastInventorySignature = ""; renderInventory(); }, "uw-inventory-flyout-close"),
        );
        capCard.append(capHead);
        const detailGrid = el("div", "uw-native-host-inspection");
        const hostObj = nativeHosts.get(selectedEntry.hostId);
        const famLabel = nativeFamilies.find(item => item.kind === selectedEntry.kind)?.label || "能力";
        const rawSourceLabel = ({
          user_native_config: "用户级客户端配置目录",
          project_native_config: "当前项目客户端配置目录",
        })[selectedEntry.source] || selectedEntry.source || "未提供";
        for (const [k, v] of [
          ["所属宿主", hostObj?.label || selectedEntry.hostId],
          ["能力类别", famLabel],
          ["配置范围", selectedEntry.scope === "project" ? "当前项目" : selectedEntry.scope === "global" ? "用户配置" : "来源待确认"],
          ["配置来源", rawSourceLabel],
          ["加载状态", "尚未从原生客户端确认"],
          ["调用证据", "当前目录记录未证明实际调用"],
        ]) {
          const r = el("div", "uw-native-host-inspection-row");
          r.append(el("span", "", k), el("strong", "", clean(v, 160)));
          detailGrid.append(r);
        }
        capCard.append(detailGrid);
        flyout.append(capCard);
      }
    }

    const sectionsHost = el("div", "uw-agent-inventory-sections");
    const makeSection = (id, heading, amount, open = false) => {
      const details = el("details", "uw-agent-inventory-section");
      details.dataset.section = id;
      const isFocusedTab = activeFlyoutSection === id || activeFlyoutSection === "all";
      details.dataset.flyoutFiltered = String(!normalizedInventoryQuery() && activeFlyoutSection !== "all" && activeFlyoutSection !== id);
      details.open = Boolean(normalizedInventoryQuery()) || activeFlyoutSection === id || inventoryExpanded.has(id) || (open && !inventoryExpanded.has(`${id}:closed`)) || (activeFlyoutSection === "all" && isFocusedTab && open);
      const summary = el("summary", "uw-agent-inventory-summary");
      summary.append(el("span", "", heading), el("small", "", String(amount)));
      details.append(summary);
      details.addEventListener("toggle", () => {
        if (inventoryQuery) return;
        if (details.open) { inventoryExpanded.add(id); inventoryExpanded.delete(`${id}:closed`); }
        else { inventoryExpanded.delete(id); inventoryExpanded.add(`${id}:closed`); }
      });
      return details;
    };
    const agentsByOwner = new Map();
    for (const task of tasks) {
      const name = taskOwner(task);
      const outcome = taskOutcome(task);
      if (!inventoryMatches(name, taskRole(task), task.title, task.statusLabel, outcome.heading, outcome.detail)) continue;
      if (!agentsByOwner.has(name)) agentsByOwner.set(name, []);
      agentsByOwner.get(name).push(task);
    }
    const activeSection = makeSection("run", "本轮活跃 Agent", agentsByOwner.size, false);
    if (!tasks.length && !inventoryQuery) activeSection.append(el("p", "uw-agent-inventory-hint",
      hasPlanningOnlyTasks ? "当前记录仅含任务规划，尚未派发执行。" : "暂无绑定当前 Run 的活跃 Agent 或结论。"));
    resultCount += agentsByOwner.size;
    for (const [name, owned] of agentsByOwner) {
      const latest = owned.find(task => taskVisualState(task) === "running") || owned.at(-1);
      const outcome = taskOutcome(latest);
      const row = makeButton("", () => {
        mode = "agents";
        inventoryFlyoutOpen = false;
        selectDesktopAnnotationNode({ id: latest.id, title: latest.title, kind: "task", layer: "agents" });
      }, "uw-agent-inventory-agent");
      row.dataset.state = taskVisualState(latest);
      row.dataset.selected = String(selection?.id === latest.id);
      row.setAttribute("aria-label", `${name}；${latest.statusLabel || labelFor(latest.status)}；${outcome.heading}；右侧查看`);
      const copy = el("span", "uw-agent-inventory-agent-copy");
      copy.append(el("strong", "", name), el("small", "", outcome.heading));
      if (outcome.level === "reported") copy.append(el("small", "uw-agent-outcome-peek", clean(outcome.detail, 180)));
      row.append(agentMark(name), copy);
      activeSection.append(row);
    }
    if (inventoryQuery && !agentsByOwner.size) activeSection.hidden = true;
    sectionsHost.append(activeSection);
    const matchingHosts = discoveredHosts.filter(host => inventoryMatches(host.id, host.label, host.statusLabel)
      || nativeCapabilities.some(item => item.hostId === host.id && inventoryMatches(item.id, item.label, item.kind)));
    const nativeSection = makeSection("native-hosts", "当前服务端宿主", matchingHosts.length, false);
    if (typeof callbacks.redetect === "function" && state.canWrite !== false) {
      const controls = el("div", "uw-native-host-controls");
      const detectButton = makeButton("重新扫描宿主", () => callbacks.redetect(), "uw-native-host-detect");
      detectButton.disabled = agent.loading === true;
      detectButton.title = "更新当前 Meta_Kim 服务端的客户端检测和能力目录；不会安装、登录或执行任务";
      controls.append(detectButton);
      nativeSection.append(controls);
    }
    if (!discoveredHosts.length && !inventoryQuery) nativeSection.append(el("p", "uw-agent-inventory-hint",
      "当前服务端宿主尚无可验证的客户端检测或配置；不等于您的 Windows 电脑未安装。"));
    resultCount += matchingHosts.length;
    const inspectHostCapability = (id) => {
      inventoryFlyoutOpen = true;
      selectedNativeCapId = selectedNativeCapId === id ? null : id;
      lastInventorySignature = "";
      renderInventory();
    };
    for (const host of matchingHosts) {
      const hostId = clean(host.id, 50);
      const hostMatch = inventoryMatches(host.id, host.label, host.statusLabel);
      const hostItems = nativeCapabilities.filter(item => item.hostId === hostId
        && (hostMatch || inventoryMatches(item.id, item.label, item.kind)));
      const details = el("details", "uw-native-host");
      details.open = Boolean(inventoryQuery) || inventoryExpanded.has(`native-host:${hostId}`);
      details.addEventListener("toggle", () => {
        if (inventoryQuery) return;
        if (details.open) inventoryExpanded.add(`native-host:${hostId}`);
        else inventoryExpanded.delete(`native-host:${hostId}`);
      });
      const header = el("summary", "uw-native-host-summary");
      const identity = el("span", "uw-native-host-identity");
      const hostCopy = el("span", "uw-native-host-copy");
      hostCopy.append(el("strong", "", clean(host.label || hostId, 80)));
      const probe = host.probe || null;
      const observedVersion = clean(probe?.version || host.version, 36);
      const available = probe?.available === true || (probe == null && host.available === true);
      const launchSupported = probe?.launchSupported === true || (probe == null && host.launchSupported === true);
      const probeState = clean(probe?.statusLabel || host.statusLabel, 70);
      const statusText = available && launchSupported
        ? `${probeState || "已检测 · 可用于只读研究"} · 执行需授权`
        : available
          ? `${probeState || "已检测 · 当前不可启动"} · 执行未授权`
          : probeState ? probeState
            : host.status === "detected" || host.availability === "detected"
              ? "已检测 · 连接能力待核验"
              : host.status === "not_found" || host.availability === "not_found"
                ? "未检测到 · 需安装或配置"
                : "尚未完成客户端检测";
      hostCopy.append(el("small", "", observedVersion ? `${statusText} · ${observedVersion}` : statusText));
      if (hostItems.length) {
        const breakdown = nativeFamilies.map(family => ({ ...family,
          count: hostItems.filter(item => item.kind === family.kind).length }))
          .filter(family => family.count).map(family => `${family.label} ${family.count}`).join(" · ");
        hostCopy.append(el("small", "uw-native-host-summary-counts", breakdown));
      }
      identity.append(nativeHostMark(hostId), hostCopy);
      header.append(identity);
      if (!hostItems.length) header.append(el("small", "uw-native-host-count", "暂无配置"));
      details.append(header);
      const body = el("div", "uw-native-host-body");
      const connectionKind = clean(host.connectionKind || probe?.connectionKind, 70);
      const connectionMode = clean(host.connectionMode || probe?.connectionMode, 90);
      const connectionLabel = clean(host.connectionLabel, 120)
        || ({ manual_skill_import_only: "手动导入 Skill ZIP", cli: "服务端命令行客户端",
          local_cli: "服务端命令行客户端", local_process: "服务端进程连接",
          api: "API 接入" })[connectionKind]
        || ({ manual_skill_zip_import: "手动导入 Skill ZIP",
          reviewed_read_only_cli: "已审阅的服务端 CLI，只读研究",
          native_cli_diagnostics_only: "仅检测 CLI，未获启动授权",
          native_projection_configuration_only: "仅兼容配置，未建立连接",
          compatibility_reference_only: "兼容性参考，未建立连接" })[connectionMode]
        || "接入方式待核对";
      const rawReason = clean(probe?.reason || host.blockedReason, 200);
      const blockedReason = ({ client_not_installed: "当前服务端没有检测到该客户端",
        client_detection_not_verified: "客户端探测结果未通过核验",
        client_version_unreviewed: "客户端版本尚未获审阅",
        needs_native_launch_review: "尚未审阅原生启动方式",
        not_probed_or_not_connected: "尚未检测或建立连接",
        personal_codex_token_not_authorized: "不得使用个人 Codex Token",
        no_reviewed_client_available: "没有可启动且已审阅的客户端" })[rawReason]
        || (/^[a-z][a-z0-9_]+$/u.test(rawReason) ? "暂不可启动，具体原因见客户端诊断" : rawReason);
      const nextAction = clean(probe?.nextAction || host.nextAction, 160);
      const access = el("div", "uw-native-host-access");
      access.append(el("span", "", "接入方式"), el("strong", "", connectionLabel));
      if (blockedReason && (!available || !launchSupported))
        access.append(el("span", "", "不可用原因"), el("strong", "", blockedReason));
      if (nextAction) access.append(el("span", "", "下一步"), el("strong", "", nextAction));
      body.append(access);
      if (hostItems.length) {
        body.append(el("p", "uw-native-host-capability-disclaimer", "已发现配置 · 未确认加载。点击具体能力可在此面板查看来源与权限边界。"));
      }
      if (!hostItems.length) body.append(el("p", "uw-agent-inventory-hint", "暂无当前项目或用户配置中可核对的能力；CLI 检测不代表已经加载 Agent。"));
      for (const family of nativeFamilies) {
        const entries = hostItems.filter(item => item.kind === family.kind);
        if (!entries.length) continue;
        const group = el("details", "uw-native-host-family");
        const familyKey = `native-host:${hostId}:${family.kind}`;
        group.open = Boolean(inventoryQuery) || inventoryExpanded.has(familyKey);
        group.addEventListener("toggle", () => {
          if (inventoryQuery) return;
          if (group.open) inventoryExpanded.add(familyKey);
          else inventoryExpanded.delete(familyKey);
        });
        group.append(el("summary", "uw-native-host-family-summary", `${family.label} · ${entries.length}`));
        const capGrid = el("div", "uw-native-host-cap-grid");
        for (const item of entries) {
          const label = clean(item.label || item.id, 110);
          const capKey = `config:${item.hostId}:${item.scope}:${item.kind}:${item.id}`;
          const row = makeButton("", () => inspectHostCapability(capKey), "uw-native-host-capability");
          row.dataset.selected = String(selectedNativeCapId === capKey);
          row.append(el("span", "", label));
          row.setAttribute("aria-label", `查看 ${host.label || hostId} 的 ${family.label} ${label} 配置详情`);
          row.title = `${clean(item.scope || "当前配置范围", 40)} · ${clean(item.source || "来源待核对", 80)} · ${item.installationState === "configured" ? "已发现配置" : "记录待核对"}，未确认加载或实际调用`;
          capGrid.append(row);
        }
        group.append(capGrid);
        body.append(group);
      }
      details.append(body);
      nativeSection.append(details);
    }
    if (referenceHosts.length && !inventoryQuery) {
      const candidates = el("details", "uw-native-host-candidates");
      const candidateHeader = el("summary", "uw-native-host-candidates-summary",
        `兼容性参考 · ${referenceHosts.length} 项（未检测）`);
      candidates.append(candidateHeader);
      const candidateList = el("div", "uw-native-host-candidates-list");
      for (const host of referenceHosts) {
        const row = el("span", "", clean(host.label || host.id, 80));
        row.title = "仅登记兼容性目标；未确认此服务端宿主或您的 Windows 本机已安装";
        candidateList.append(row);
      }
      candidates.append(candidateList);
      nativeSection.append(candidates);
    }
    nativeSection.append(el("p", "uw-agent-inventory-hint",
      "云端扫描不代表连接了您的 Windows 电脑。发现配置不等于已加载或调用。"));
    if (inventoryQuery && !matchingHosts.length) nativeSection.hidden = true;
    sectionsHost.append(nativeSection);
    const subagents = tasks.filter(task => task.source?.isMain !== true
      && (task.source?.parentId || task.source?.nativeTaskCaption)
      && inventoryMatches(task.title, taskOwner(task), task.source?.nativeTaskCaption, task.statusLabel, taskOutcome(task).detail));
    const subagentsSection = makeSection("subagents", "Subagents · 编排与回执", subagents.length, false);
    if (!subagents.length && !inventoryQuery) {
      subagentsSection.append(el("p", "uw-agent-inventory-hint",
        hasPlanningOnlyTasks
          ? `当前所选运行仅含规划节点，本轮已派发 Subagents 为 0（本机宿主另有 ${totalPresetSubagents} 个已配置 Subagent 预设，可点上方「Subagent 预设」查看）。`
          : "当前未选中含子 Agent 派发回执的运行。"));
      const richRuns = sessionsWithRealWorkers();
      if (richRuns.length && typeof callbacks.selectProjectRun === "function") {
        const jumpList = el("div", "uw-inventory-card-grid");
        for (const s of richRuns) {
          const btn = makeButton("", () => {
            inventoryFlyoutOpen = false;
            mode = topFlowRibbon ? "live-run" : "agents";
            callbacks.selectProjectRun(state.selection?.projectId, s.runId);
          }, "uw-subagent-run-jump");
          btn.append(
            el("strong", "", `切换至：${clean(s.title || s.runId, 34)}`),
            el("small", "", `含 ${s.workerCount || 1} 个实测执行节点 · 点击在完整运行图查看`),
          );
          jumpList.append(btn);
        }
        subagentsSection.append(jumpList);
      }
    }
    resultCount += subagents.length;
    const subagentGrid = el("div", "uw-inventory-card-grid");
    for (const task of subagents) {
      const row = makeButton("", () => {
        mode = topFlowRibbon ? "live-run" : "agents";
        inventoryFlyoutOpen = false;
        selectDesktopAnnotationNode({ id: task.id, title: task.title, kind: "task", layer: "agents" });
      }, "uw-agent-inventory-capability");
      row.dataset.state = taskVisualState(task);
      row.append(el("span", "uw-agent-inventory-item-title", clean(task.title, 90)),
        el("small", "", `${taskOwner(task)} · ${task.statusLabel || labelFor(task.status)} · ${taskOutcome(task).heading}`));
      subagentGrid.append(row);
    }
    if (subagents.length) subagentsSection.append(subagentGrid);
    if (inventoryQuery && !subagents.length) subagentsSection.hidden = true;
    sectionsHost.append(subagentsSection);

    if (totalPresetSubagents > 0) {
      const presetSection = makeSection("subagent-presets", "宿主已配置 Subagent 预设（静态发现 · 未代表本轮调用）", presetSubagents.length, false);
      resultCount += presetSubagents.length;
      const presetGrid = el("div", "uw-inventory-card-grid");
      for (const item of presetSubagents) {
        const hostObj = nativeHosts.get(item.hostId);
        const capKey = `config:${item.hostId}:${item.scope}:${item.kind}:${item.id}`;
        const chip = makeButton("", () => inspectHostCapability(capKey), "uw-native-host-capability");
        chip.dataset.selected = String(selectedNativeCapId === capKey);
        chip.append(
          el("span", "", clean(item.label || item.id, 90)),
          el("small", "", `${hostObj?.label || item.hostId} · ${item.scope === "project" ? "当前项目" : "用户全局"}预设`),
        );
        presetGrid.append(chip);
      }
      if (presetSubagents.length) presetSection.append(presetGrid);
      if (inventoryQuery && !presetSubagents.length) presetSection.hidden = true;
      sectionsHost.append(presetSection);
    }
    const registeredAgents = catalogItems("agents").filter(item =>
      ![...agentsByOwner.keys()].some(owner => [item.id, item.label].some(value => clean(value).toLowerCase() === owner.toLowerCase()))
      && inventoryMatches(item.id, item.label, item.role, ...(Array.isArray(item.owns) ? item.owns : [item.owns])));
    const rolesSection = makeSection("registered-agents", "已注册 Agent", registeredAgents.length, false);
    if (!registeredAgents.length && !inventoryQuery) rolesSection.append(el("p", "uw-agent-inventory-hint", "尚无可读取的注册角色。"));
    resultCount += registeredAgents.length;
    const rolesGrid = el("div", "uw-inventory-card-grid");
    for (const item of registeredAgents) {
      const label = clean(item.label || item.id, 90);
      const row = el("div", "uw-agent-inventory-agent uw-agent-inventory-registered");
      const copy = el("span", "uw-agent-inventory-agent-copy");
      copy.append(el("strong", "", label), el("small", "", clean(item.role || "已注册 · 无本轮结论", 60)));
      row.append(agentMark(item.id || label, true), copy);
      row.title = `${clean(item.role || item.owns || label, 240)} · 注册不代表已调用`;
      rolesGrid.append(row);
    }
    if (registeredAgents.length) rolesSection.append(rolesGrid);
    if (inventoryQuery && !registeredAgents.length) rolesSection.hidden = true;
    sectionsHost.append(rolesSection);
    const professionalAgents = catalog?.professionalSourceStatus === "verified_local"
      && Array.isArray(catalog?.professionalAgents) ? catalog.professionalAgents.filter(item =>
        inventoryMatches(item.id, item.label, item.agentKind)) : [];
    const professionalSection = makeSection("professional-agents", "Kim_Service 专业 Agent", professionalAgents.length);
    if (!professionalAgents.length && !inventoryQuery) professionalSection.append(el("p", "uw-agent-inventory-hint",
      "当前项目尚未绑定已核验的专业 Agent 来源；注册来源不等于已安装或已调用。"));
    resultCount += professionalAgents.length;
    const profGrid = el("div", "uw-inventory-card-grid");
    for (const item of professionalAgents) {
      if (!item || item.registrationState !== "verified_source_only" || !item.id) continue;
      const label = clean(item.label || item.id, 100);
      const row = el("div", "uw-agent-inventory-agent uw-agent-inventory-registered");
      const copy = el("span", "uw-agent-inventory-agent-copy");
      copy.append(el("strong", "", label), el("small", "", "来源哈希已核验 · 未观测调用"));
      row.append(agentMark(item.id, true), copy);
      profGrid.append(row);
    }
    if (professionalAgents.length) professionalSection.append(profGrid);
    if (inventoryQuery && !professionalAgents.length) professionalSection.hidden = true;
    sectionsHost.append(professionalSection);
    for (const family of capabilityFamilies) {
      const entries = capabilityEntries(family.kind, family.catalog).filter(entry =>
        inventoryMatches(entry.label, family.name));
      const section = makeSection(family.kind, family.name, entries.length);
      if (!entries.length && !inventoryQuery) section.append(el("p", "uw-agent-inventory-hint", "暂无注册项或本轮调用证据。"));
      resultCount += entries.length;
      const famGrid = el("div", "uw-inventory-card-grid");
      for (const entry of entries) {
        const row = el("div", "uw-agent-inventory-capability");
        row.dataset.state = entry.state;
        row.append(el("span", "uw-agent-inventory-item-title", entry.label));
        row.append(el("small", "", entry.referenceOnly ? "参考资料 · 非可调用能力"
          : entry.state === "observed" ? "本轮已观测调用" : entry.state === "planned" ? "已选择 · 未观测调用"
            : "已注册 · 未观测调用"));
        famGrid.append(row);
      }
      if (entries.length) section.append(famGrid);
      if (inventoryQuery && !entries.length) section.hidden = true;
      sectionsHost.append(section);
    }
    flyout.append(sectionsHost);
    if (inventoryQuery) {
      const searchResult = el("p", "uw-agent-inventory-search-result", resultCount
        ? `已筛出 ${resultCount} 条记录` : "没有找到匹配记录");
      surface.insertBefore?.(searchResult, quicknav);
    }
    surface.append(flyout);
    inventory.replaceChildren(surface);
    sectionsHost.scrollTop = resetInventoryScroll ? 0 : previousScroll;
    inventory.scrollTop = resetInventoryScroll ? 0 : previousScroll;
    resetInventoryScroll = false;
  }
  function renderCanvas() {
    const blueprint = designSource();
    const signature = JSON.stringify({ mode, knowledgeLayer, prdSourcePref, knowledgeDepth, knowledgeLimit, selection, agentStatus: agent.status,
      decision: agent.pending?.decision?.state, pendingId: agent.pending?.key,
      nativeDraftStatus: nativeDraft.snapshot?.status, designVersion: design.snapshot?.version,
      pendingReviewNotes: design.snapshot?.pendingReviewNotes, hosts: agent.hosts,
      workspaceRevision: state.workspace?.revision, runId: isCurrentRun() ? state.selection?.runId : null,
      executionStatus: execution.snapshot?.status, executionSession: execution.snapshot?.nativeSessionId,
      acceptanceStatus: acceptance.snapshot?.status, acceptanceDigest: acceptance.snapshot?.artifactsDigest,
      acceptanceFiles: acceptance.snapshot?.changedFiles?.length,
      tasks: runTasks().map(task => ({ id: task.id, status: task.status, summary: task.source.summary,
        ownerReport: task.source.ownerReport, nativeReturnEvidence: task.source.nativeReturnEvidence,
        capabilityTruth: task.source.capabilityTruth, task: task.source.task })),
      stages: (state.workspace?.stages || []).map(stage => `${stage.id}:${stage.status}`),
      graphData: blueprint?.design,
      prdWfRev: state.prdWorkflowCanvas?.revision || 0,
      prdWfBusy: Boolean(state.prdWorkflowBusy),
      prdWfError: state.prdWorkflowError || "",
      moduleMockups: (design.snapshot?.modules || []).map(m => `${m.id}:${m.uiMockup?.status}:${m.uiMockup?.version}`),
      archModules: state.projectArchitecturePrd?.modules?.length || 0 });
    if (signature === lastCanvasSignature) return;
    lastCanvasSignature = signature;
    const isLiveRunDocked = mode === "live-run" && !state.externalView && state.view === "work";
    callbacks.dockLiveRunView?.(isLiveRunDocked);
    if (dockedRunSlot) dockedRunSlot.hidden = !isLiveRunDocked;
    viewport.hidden = isLiveRunDocked;
    if (liveFooter) liveFooter.hidden = isLiveRunDocked;
    if (!isLiveRunDocked) {
      const previousScroll = viewport.scrollTop;
      viewport.replaceChildren(mode === "knowledge" ? renderKnowledge() : mode === "agents" ? renderAgents() : renderFlow());
      viewport.scrollTop = previousScroll;
    } else {
      nodeCount = Array.isArray(state.snapshot?.nodes) ? state.snapshot.nodes.length : 0;
    }
    for (const tab of modes) {
      const selected = tab.dataset.uwLiveMode === mode;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    viewport.setAttribute("aria-labelledby", `uw-live-tab-${mode}`);
    if (count) count.textContent = `${nodeCount} 个节点`;
    if (source) source.textContent = state.origin === "acceptance_fixture"
      || agent.pending?.capabilityState?.recordOrigin === "acceptance_fixture" ? "模拟验收数据 · 未调用真实 Agent"
      : isCurrentRun() ? "真实 Run · 绑定当前项目" : agent.pending ? "研究与设计回执 · 尚非正式 Run" : "未执行 · 等待任务";
    if (caption) caption.textContent = selection
      ? `已关联「${selection.title}」，可在左侧输入修改意见`
      : "拖拽节点或分栏可自由布局；点击节点可在左侧反馈";
  }
  function updateTarget() {
    if (target) target.hidden = !selection;
    if (targetText) targetText.textContent = selection ? `已圈选：${selection.title}` : "";
  }
  function render() {
    const lang = state.language || "zh";
    if (project) {
      project.dataset.uwUntranslated = "true";
      project.textContent = state.agentServerProjectLabel || t("项目身份待核对");
    }
    const headerIdentityTitle = chat.querySelector?.(".uw-agent-chat-identity strong");
    if (headerIdentityTitle) headerIdentityTitle.textContent = t("对话与决策");
    if (connection) {
      const available = (agent.hosts || []).some(host => host.available && host.launchSupported && !/codex/iu.test(host.id));
      connection.textContent = t(agent.busy ? "正在提交" : available ? "已连接" : agent.loading ? "正在检测" : "客户端待连接");
      connection.dataset.state = available ? "connected" : "waiting";
    }
    if (send) send.disabled = agent.busy || agent.decisionBusy || design.busy || !input.value.trim();
    if (guidance) guidance.textContent = t(selection ? `消息将关联「${selection.title}」` :
      pendingChoice() ? selectedStrategy ? "发送理由后记录方案选择" : "选方案，或直接发送修改意见" :
        "Enter 发送，Shift+Enter 换行");
    updateTarget();
    lastThreadSignature = lang !== "zh" ? "" : lastThreadSignature;
    lastBindingSignature = lang !== "zh" ? "" : lastBindingSignature;
    lastTopFlowSignature = lang !== "zh" ? "" : lastTopFlowSignature;
    lastCanvasSignature = lang !== "zh" ? "" : lastCanvasSignature;
    lastInventorySignature = lang !== "zh" ? "" : lastInventorySignature;
    renderThread();
    renderBindingDrawer();
    renderTopFlowRibbon();
    renderCanvas();
    renderInventory();
    if (lang && lang !== "zh" && !lang.startsWith("zh")) {
      const entrySection = find("agent-entry");
      if (entrySection?.getAttribute) {
        entrySection._uwOrigAttrs = entrySection._uwOrigAttrs || {};
        entrySection._uwOrigAttrs["aria-label"] = entrySection._uwOrigAttrs["aria-label"] || entrySection.getAttribute("aria-label") || "";
        if (entrySection._uwOrigAttrs["aria-label"]) entrySection.setAttribute("aria-label", t(entrySection._uwOrigAttrs["aria-label"]));
      }
      localizeSubtree(topFlowRibbon);
      localizeSubtree(chat);
      localizeSubtree(find("agent-live") || viewport);
      localizeSubtree(inventory);
      localizeSubtree(find("split-resizer"));
      const navShell = root.closest?.("[data-unified-workspace]");
      const navEl = navShell?.querySelector?.("[data-uw-navigation]");
      if (navEl) {
        for (const attr of ["aria-label", "title"]) {
          const cur = navEl.getAttribute?.(attr);
          if (cur) {
            navEl._uwOrigAttrs = navEl._uwOrigAttrs || {};
            navEl._uwOrigAttrs[attr] = navEl._uwOrigAttrs[attr] || cur;
            navEl.setAttribute(attr, t(navEl._uwOrigAttrs[attr]));
          }
        }
        localizeSubtree(navEl.querySelector?.(".uw-primary-nav"));
        localizeSubtree(navEl.querySelector?.("[data-uw-nav-collapse]"));
        localizeSubtree(navEl.querySelector?.("[data-uw-nav-resizer]"));
        localizeSubtree(navEl.querySelector?.("[data-uw-modules]"));
        const invEl = navEl.querySelector?.("[data-uw-agent-inventory]");
        if (invEl?.getAttribute) {
          invEl._uwOrigAttrs = invEl._uwOrigAttrs || {};
          invEl._uwOrigAttrs["aria-label"] = invEl._uwOrigAttrs["aria-label"] || invEl.getAttribute("aria-label") || "";
          if (invEl._uwOrigAttrs["aria-label"]) invEl.setAttribute("aria-label", t(invEl._uwOrigAttrs["aria-label"]));
        }
        const modEl = navEl.querySelector?.("[data-uw-modules]");
        if (modEl?.getAttribute) {
          modEl._uwOrigAttrs = modEl._uwOrigAttrs || {};
          modEl._uwOrigAttrs["aria-label"] = modEl._uwOrigAttrs["aria-label"] || modEl.getAttribute("aria-label") || "";
          if (modEl._uwOrigAttrs["aria-label"]) modEl.setAttribute("aria-label", t(modEl._uwOrigAttrs["aria-label"]));
        }
      }
      const tabLabels = { flow: "阶段进度", knowledge: "产品设计 PRD", agents: "Agent 协作", "live-run": "完整运行图 · Subagents" };
      for (const tab of modes) {
        const key = tab.dataset?.uwLiveMode;
        if (key && tabLabels[key]) tab.textContent = t(tabLabels[key]);
      }
    }
  }

  async function submitMessage() {
    const message = input.value.trim();
    if (!message || agent.busy || agent.decisionBusy || design.busy) return;
    const explain = text => { localNotice = text; render(); input.focus(); };
    if (selection) {
      let accepted = false;
      if (selection.kind === "stage" && selection.id === "decision" && pendingChoice()) {
        if (message.length > 2000) return explain("方案修改意见最多 2000 字，请精简后再提交。");
        accepted = await callbacks.revise(message);
      } else if (savedDesign() && selection.layer === "knowledge" && ["architecture", "module"].includes(selection.kind)
        || savedDesign() && selection.layer === "system" && ["architecture", "module"].includes(selection.kind)) {
        const kind = selection.kind === "architecture" ? "system" : "module";
        const id = selection.id;
        const direct = /^(标题|名称|目标|整体架构|架构|技术栈|输入|输出|边界|验收|依赖)改为\s*[:：]\s*([\s\S]+)$/u.exec(message);
        if (direct) {
          accepted = await callbacks.reviseField(kind, id, direct[1], direct[2]);
        } else {
          if (message.length > 2000) return explain("节点返工意见最多 2000 字，请精简后再提交。");
          accepted = await callbacks.requestRevision(kind, id, message);
        }
      } else if (selection.kind === "stage" && selection.id === "acceptance"
        && ["awaiting_human_b4", "verification_failed", "blocked"].includes(acceptance.snapshot?.status)
        && typeof callbacks.requestDeliverableRework === "function") {
        const parsedRework = /^([a-z][a-z0-9_-]{1,31}|system)\s*[:：|｜]\s*([\s\S]{1,2000})$/u.exec(message);
        const modId = parsedRework ? parsedRework[1] : (design.snapshot?.modules?.[0]?.id || "system");
        const reason = parsedRework ? parsedRework[2].trim() : message;
        if (!reason || reason.length > 2000) return explain("B4 返工意见请控制在 2000 字以内。");
        accepted = await callbacks.requestDeliverableRework(modId, reason);
      } else return explain("这个节点当前仅能查看。要修改 PRD 节点，请先保存 B2 设计，再圈选系统或模块提出意见。正式 Run 的节点反馈需要对应的受控执行接口。");
      if (accepted !== true) return explain("修改尚未被确认。请核对原回执或先解决正在处理的请求；你的文字已保留。");
      selection = null;
      if (input.value.trim() === message) input.value = "";
      localNotice = "";
      render();
      return;
    }
    if (pendingChoice()) {
      const explicit = !selectedStrategy && /^采纳\s*[:：]\s*(.{1,180})\s*[|｜]\s*([\s\S]{1,1200})$/u.exec(message);
      let accepted = false;
      if (selectedStrategy || explicit) {
        const choice = selectedStrategy || explicit[1].trim();
        const reason = selectedStrategy ? message : explicit[2].trim();
        if (!reason || reason.length > 1200 || choice.length > 180) return explain("采纳需完整写明方案名称和不超过 1200 字的理由。可在下方修改后重发。");
        accepted = await callbacks.adopt(choice, reason);
      } else {
        if (message.length > 2000) return explain("研究修改意见最多 2000 字，请精简后再发。");
        accepted = await callbacks.revise(message);
      }
      if (accepted !== true) return explain("方案选择或修改请求尚未被确认。请核对原回执；你的文字已保留。");
      if (input.value.trim() === message) input.value = "";
      selectedStrategy = null;
      localNotice = "";
      render();
      return;
    }
    if (!agent.pending) {
      if (callbacks.startGoal(message)) input.value = "";
      else return explain("当前没有经过核验的可用研究客户端。请先核对连接状态或重新检测。");
      render();
      return;
    }
    if (/^新任务\s*[:：]/u.test(message) && agent.status === "completed") {
      if (!callbacks.newTask()) return explain("上一任务仍有未确定的回执，请先核对，不能丢弃原请求号。");
      const goal = message.replace(/^新任务\s*[:：]\s*/u, "");
      if (!goal) return explain("请在「新任务：」后写上目标。");
      if (callbacks.startGoal(goal)) { input.value = ""; localNotice = ""; render(); }
      return;
    }
    explain(adopted() ? "设计阶段请从右侧圈选系统或模块，用这个输入框修改该节点。新任务请输入「新任务：你的目标」。" :
      "这条研究请求已有处理决定或正在运行。请先核对回执；目前没有经过验证的任意继续对话接口，不会假装已提交。");
  }
  const closeFlyoutOnChat = () => {
    if (!inventoryFlyoutOpen) return;
    inventoryFlyoutOpen = false;
    lastInventorySignature = "";
    renderInventory();
  };
  form.addEventListener("submit", event => {
    event.preventDefault();
    closeFlyoutOnChat();
    if (bindingDrawerOpen) { bindingDrawerOpen = false; renderBindingDrawer(); }
    void submitMessage();
  });
  input.addEventListener("focus", closeFlyoutOnChat);
  input.addEventListener("input", () => { closeFlyoutOnChat(); input.setCustomValidity(""); render(); });
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault(); void submitMessage();
    }
  });
  targetClear?.addEventListener("click", () => { selection = null; render(); input.focus(); });
  function activateMode(nextMode) {
    const prevMode = mode;
    mode = nextMode;
    selection = null;
    lastCanvasSignature = "";
    callbacks.onLiveModeChange?.(nextMode, prevMode);
    render();
  }
  function activateTab(tab) {
    activateMode(tab.dataset.uwLiveMode);
  }
  for (const [index, tab] of modes.entries()) {
    tab.addEventListener("click", () => activateTab(tab));
    tab.addEventListener("keydown", event => {
      const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (offset) { event.preventDefault(); const next = modes[(index + offset + modes.length) % modes.length]; activateTab(next); next.focus(); }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault(); const next = modes[event.key === "Home" ? 0 : modes.length - 1]; activateTab(next); next.focus();
      }
    });
  }
  render();
  return { render, selectNode: selectDesktopAnnotationNode, get mode() { return mode; } };
}
