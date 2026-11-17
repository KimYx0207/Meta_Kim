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

  let mode = "flow";
  let knowledgeLayer = "system";
  let knowledgeDepth = 2;
  let knowledgeLimit = 40;
  let selection = null;
  let selectedStrategy = null;
  let reviewedNodes = new Set();
  let localNotice = "";
  let lastThreadSignature = "";
  let lastAnnouncement = "";
  let lastCanvasSignature = "";
  let lastInventorySignature = "";
  let inventoryQuery = "";
  let resetInventoryScroll = false;
  const inventoryExpanded = new Set(["run", "registered-agents", "subagents"]);
  let nodeCount = 0;

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
  const designSource = () => {
    if (design.snapshot?.system && Array.isArray(design.snapshot.modules)) {
      const saved = design.snapshot;
      return {
        kind: "agent_saved_design",
        version: saved.version,
        design: {
          architecture: { id: "agent-system", title: saved.system.title || "系统设计",
            status: saved.system.approval?.state === "approved" ? "completed" : "waiting_human",
            summary: saved.system.goal, moduleIds: saved.modules.map(item => item.id) },
          modules: saved.modules.map(item => ({ id: item.id, title: item.title, summary: item.objective,
            status: item.approval?.state === "approved" ? "completed" : "waiting_human",
            dependsOn: item.dependencies || [] })),
        },
      };
    }
    if (nativeDraft.snapshot?.status === "completed" && nativeDraft.snapshot?.design?.system) {
      const draft = nativeDraft.snapshot.design;
      return {
        kind: "agent_unverified_draft",
        version: null,
        design: {
          architecture: { id: "agent-system", title: draft.system.title, status: "unproven",
            summary: draft.system.goal, moduleIds: draft.modules.map(item => item.id) },
          modules: draft.modules.map(item => ({ id: item.id, title: item.title, summary: item.objective,
            status: "unproven", dependsOn: item.dependencies || [] })),
        },
      };
    }
    if (isCurrentRun() && state.workspace?.design?.architecture) return { kind: "governed_run", version: state.workspace.revision, design: state.workspace.design };
    return null;
  };
  const conversationSignature = () => JSON.stringify({
    goal: agent.pending?.goal, agentStatus: agent.status,
    capabilityOrigin: agent.pending?.capabilityState?.recordOrigin,
    receipt: find("agent-status")?.textContent, preview: agent.pending?.resultPreview,
    decision: agent.pending?.decision, designVersion: design.snapshot?.version,
    designStatus: design.snapshot?.status, systemApproval: design.snapshot?.system?.approval?.state,
    moduleApprovals: (design.snapshot?.modules || []).map(item => `${item.id}:${item.approval?.state}`),
    draftStatus: nativeDraft.snapshot?.status, handoffStatus: handoff.snapshot?.status,
    designError: design.error, handoffError: handoff.error, draftError: nativeDraft.error,
    reviewNotes: (design.snapshot?.pendingReviewNotes || []).map(note => `${note.noteId}:${note.target?.kind}:${note.target?.moduleId}`),
    reviewHistory: design.snapshot?.history?.length, pendingMutation: design.pendingMutation?.mutationKey,
    decisionPending: agent.decisionPending?.key, busy: [agent.busy, agent.decisionBusy, design.busy, nativeDraft.busy, handoff.busy],
    selection: selection?.id, selectedStrategy, reviewedNodes: [...reviewedNodes], localNotice,
  });

  function bubble(kind, title, body) {
    const wrap = el("article", `uw-chat-bubble uw-chat-bubble-${kind}`);
    const heading = el("div", "uw-chat-bubble-heading");
    heading.append(el("span", "uw-chat-bubble-dot"), el("strong", "", title));
    wrap.append(heading);
    if (body) wrap.append(el("p", "", body));
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
        if (outstanding) box.append(el("p", "uw-chat-options-hint", `当前节点有 ${outstanding} 条待修改意见。点击右侧节点，直接在唯一输入框给出具体字段的新内容。`));
        const approve = makeButton(`确认「${next.record.title || "系统设计"}」`, () => {
          callbacks.approveNode(next.kind, next.id);
        }, "uw-chat-action");
        approve.disabled = !reviewedNodes.has(key) || Boolean(outstanding);
        approve.title = outstanding ? "待修改意见尚未解决" : !reviewedNodes.has(key) ? "请先展开完整设计后确认" : "已审阅，可确认";
        box.append(approve);
      }
      if (saved.status === "approved") {
        box.append(el("p", "uw-chat-options-hint", "设计已逐项确认；正式执行仍需要独立授权和可核对的真实 Run。"));
        if (handoff.snapshot?.status === "eligible" && !handoff.busy) {
          box.append(makeButton("准备交接材料（不执行）", () => callbacks.prepareHandoff(), "uw-chat-action"));
        } else if (handoff.snapshot?.status === "prepared") {
          box.append(el("p", "uw-chat-options-hint", `已封存交接：${handoff.snapshot.handoffDigest?.slice(0,12) || "待核对"}…。B3 尚未授权执行；B4 尚无验收产物。`));
        } else box.append(el("p", "uw-chat-options-hint", handoff.error || "正在核对交接资格；设计已完成不代表代码已执行。"));
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
      { id: "execution", title: "交接与执行", summary: handoff.snapshot?.status === "prepared" ? "B3 已封存；尚无真实 Run" : "B3 设计交接 / B4 真实 Run", status: handoff.snapshot?.status === "prepared" ? "partial" : "planned" },
      { id: "acceptance", title: "最终验收", summary: "可复核成果与 B4 交付", status: "planned" },
    ];
  };
  function selectDesktopAnnotationNode(node) {
    selection = { id: clean(node.id, 140), title: clean(node.title, 140), kind: node.kind || "stage", layer: node.layer || mode };
    localNotice = "";
    render();
    input.focus();
  }
  function renderFlow() {
    const list = flowStages();
    nodeCount = list.length;
    const shell = el("div", "uw-agent-flow");
    shell.append(el("div", "uw-live-view-kicker", isCurrentRun() ? "正式 Run · 已核对身份" : "当前研究与人工设计 · 尚非正式 Run"));
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
    return shell;
  }
  function renderKnowledge() {
    const shell = el("div", "uw-agent-knowledge");
    const layers = [["system", "系统与模块"], ["strategies", "方案与依据"], ["hosts", "客户端能力"]];
    const chooser = el("div", "uw-agent-knowledge-layers");
    chooser.setAttribute("role", "group"); chooser.setAttribute("aria-label", "选择知识关系类型");
    for (const [id, label] of layers) {
      const button = makeButton(label, () => { knowledgeLayer = id; selection = null; render(); }, "uw-agent-knowledge-layer");
      button.setAttribute("aria-pressed", String(knowledgeLayer === id));
      chooser.append(button);
    }
    shell.append(chooser);
    let blueprint = designSource();
    if (knowledgeLayer === "strategies") {
      const parsed = strategies();
      blueprint = parsed ? { kind: "native_plan_unverified", design: {
        architecture: { id: "research-options", title: "研究候选", status: "unproven", summary: parsed.summary,
          moduleIds: parsed.strategies.map(item => `option-${item.id.toLowerCase()}`) },
        modules: parsed.strategies.map(item => ({ id: `option-${item.id.toLowerCase()}`, title: `${item.id} · ${item.title}`,
          summary: `${item.evidenceSummary} · 风险：${item.risks}`, status: "unproven", dependsOn: [] })),
      } } : null;
    } else if (knowledgeLayer === "hosts") {
      const catalogHosts = Array.isArray(state.capabilityCatalog?.nativeHosts)
        ? state.capabilityCatalog.nativeHosts : [];
      const probes = new Map((agent.hosts || []).filter(host => host?.id).map(host => [host.id, host]));
      const hosts = new Map();
      for (const host of [...catalogHosts, ...(agent.hosts || [])]) {
        if (!host?.id || !host?.label) continue;
        const existing = hosts.get(host.id);
        hosts.set(host.id, existing ? { ...existing, ...host } : host);
      }
      const modules = [...hosts.values()].map(host => {
        const probe = probes.get(host.id);
        const detected = probe?.available === true || host.status === "detected";
        return { id: `host:${host.id}`, title: host.label, status: "unproven", dependsOn: [],
          summary: detected ? "本服务端检测到客户端 · 未证明真实调用"
            : "兼容性登记或配置扫描 · 未证明已连接" };
      });
      const capabilities = Array.isArray(state.capabilityCatalog?.nativeCapabilities)
        ? state.capabilityCatalog.nativeCapabilities : [];
      const nativeKindLabels = { agent: "Agent", subagent_config: "Subagent", skill: "Skill",
        mcp: "MCP", hook: "Hook", plugin: "Plugin", command: "Command" };
      for (const item of capabilities) {
        if (!hosts.has(item?.hostId) || !item.id || !nativeKindLabels[item.kind]) continue;
        modules.push({ id: `config:${item.hostId}:${item.scope}:${item.kind}:${item.id}`,
          title: `${nativeKindLabels[item.kind]} · ${item.label || item.id}`,
          summary: `${item.scope === "project" ? "项目" : "用户"}配置登记 · 加载和调用均未核验`,
          status: "unproven", dependsOn: [`host:${item.hostId}`] });
      }
      blueprint = hosts.size ? { kind: "host_detection_only", design: {
        architecture: { id: "host-detection", title: "客户端与配置关系", status: "unproven",
          summary: "仅展示登记和依赖关系，不代表已连接或执行",
          moduleIds: modules.map(item => item.id) },
        modules,
      } } : null;
    }
    if (!blueprint) {
      nodeCount = 0;
      const empty = el("div", "uw-live-empty");
      empty.append(el("span", "uw-live-empty-symbol", "◎"), el("h3", "", "等待真实关系记录"),
        el("p", "", knowledgeLayer === "system" ? "原生草稿、两级 PRD 与模块依赖将出现在这里。"
          : knowledgeLayer === "strategies" ? "需要符合结构化规则的原生研究回执才能绘制方案依据。"
            : "检测到本地客户端后，展示真实能力及权限边界。"));
      shell.append(empty);
      return shell;
    }
    const focusId = knowledgeLayer === "system" && selection?.kind === "module" ? selection.id.replace(/^module:/u, "")
      : knowledgeLayer === "hosts" && selection?.layer === "hosts" && selection?.id !== "host-detection"
        ? selection.id : null;
    const graph = buildGraph(blueprint.design, { focusId, depth: knowledgeDepth, limit: knowledgeLimit });
    nodeCount = graph.nodes.length;
    const label = ({ governed_run: "正式 Run · 已核对身份", agent_saved_design: `人类设计记录 · v${blueprint.version}`,
      agent_unverified_draft: "原生设计草稿 · 未批准", native_plan_unverified: "客户端候选方案 · 依据未独立核验",
      host_detection_only: "客户端检测记录 · 不是执行回执" })[blueprint.kind] || "来源待核对";
    const top = el("div", "uw-agent-knowledge-top");
    top.append(el("span", "uw-live-view-kicker", label));
    if (focusId) top.append(makeButton("返回完整图谱", () => { selection = null; render(); }, "uw-agent-knowledge-back"));
    shell.append(top);
    shell.append(createGraph({ doc, graph, copy, focusId, depth: knowledgeDepth,
      onSelect: node => selectDesktopAnnotationNode({ id: node.sourceId || node.id, title: node.title,
        kind: knowledgeLayer === "system" ? node.kind : knowledgeLayer === "hosts"
          ? node.sourceId?.startsWith("config:") ? "capability" : "host" : "strategy", layer: knowledgeLayer }),
      onDepthChange: value => { knowledgeDepth = value; lastCanvasSignature = ""; render(); },
      onExpand: () => { knowledgeLimit = Math.min(2000, knowledgeLimit + 40); lastCanvasSignature = ""; render(); } }));
    if (selection?.layer === "knowledge" || selection?.layer === knowledgeLayer) {
      const inspector = el("div", "uw-live-node-inspector");
      inspector.append(el("div", "uw-chat-inline-heading", `圈选节点 · ${selection.title}`));
      if (knowledgeLayer === "system" && savedDesign()) {
        const record = selection.kind === "architecture" ? design.snapshot.system
          : design.snapshot.modules.find(item => item.id === selection.id);
        if (record) {
          inspector.append(el("p", "", clean(record.goal || record.objective, 1300)));
          for (const note of designNotes(selection.kind === "architecture" ? "system" : "module", selection.id)) {
            inspector.append(el("p", "uw-live-node-note", `待修改 · ${note.feedback}`));
          }
          inspector.append(el("p", "", "在左侧同一个输入框提出返工意见；用「验收改为：…」等命令可直接修订。"));
        }
      } else if (knowledgeLayer === "strategies") {
        const option = strategies()?.strategies?.find(item => `option-${item.id.toLowerCase()}` === selection.id);
        if (option) {
          inspector.append(el("p", "", `依据（未独立核验）：${option.evidenceSummary}`));
          inspector.append(el("p", "", `限制与风险：${option.tradeoffs} · ${option.risks}`));
        }
      } else if (knowledgeLayer === "hosts" && selection.kind === "capability") {
        const entry = (Array.isArray(state.capabilityCatalog?.nativeCapabilities)
          ? state.capabilityCatalog.nativeCapabilities : []).find(item =>
          `config:${item.hostId}:${item.scope}:${item.kind}:${item.id}` === selection.id);
        if (entry) {
          const detail = el("div", "uw-native-host-inspection");
          const host = (state.capabilityCatalog?.nativeHosts || []).find(item => item.id === entry.hostId);
          const label = nativeFamilies.find(item => item.kind === entry.kind)?.label || "能力";
          const fields = [["宿主", host?.label || entry.hostId], ["类别", label],
            ["配置范围", entry.scope === "project" ? "当前项目" : entry.scope === "global" ? "用户配置" : "来源待确认"],
            ["配置来源", entry.source || "未提供"],
            ["加载状态", "尚未从原生客户端确认"], ["调用证据", "当前目录记录未证明实际调用"]];
          for (const [label, value] of fields) {
            const row = el("div", "uw-native-host-inspection-row");
            row.append(el("span", "", label), el("strong", "", clean(value, 160)));
            detail.append(row);
          }
          inspector.append(detail);
        }
        inspector.append(el("p", "", "该信息为只读发现记录，点击并未启动客户端或调用工具。"));
      } else inspector.append(el("p", "", "此视图为只读关系。选择不会启动或授权任何客户端。"));
      shell.append(inspector);
    }
    return shell;
  }
  function renderAgents() {
    const tasks = runTasks();
    nodeCount = tasks.length;
    const shell = el("div", "uw-agent-collaboration");
    shell.append(el("div", "uw-live-view-kicker", isCurrentRun() ? "正式 Run · Agent 工作与证据" : "Agent 协作 · 注册角色不代表已调用"));
    if (!tasks.length) {
      const empty = el("div", "uw-live-empty uw-live-agents-empty");
      empty.append(el("span", "uw-live-empty-symbol", "◇"), el("h3", "", "等待真实 Agent 协作记录"),
        el("p", "", "已注册 Agent 可在左侧查看；这里仅展示绑定当前 Run 的执行任务、回报和调用证据。"));
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
    const tasks = runTasks();
    const catalog = state.capabilityCatalog;
    const signature = JSON.stringify({ runId: isCurrentRun() ? state.selection?.runId : null,
      agentLoading: agent.loading === true, canWrite: state.canWrite !== false,
      selectionId: selection?.id, inventoryQuery,
      tasks: tasks.map(task => ({ id: task.id, owner: taskOwner(task), role: taskRole(task), title: task.title,
        status: task.status, source: { summary: task.source.summary, task: task.source.task,
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
    const surface = el("div", "uw-agent-inventory-body");
    const title = el("div", "uw-agent-inventory-title");
    title.append(el("strong", "", "Agent 协作"), el("span", "", tasks.length ? `${tasks.length} 个执行任务` : "等待执行"));
    surface.append(title);
    const search = el("input", "uw-agent-inventory-search");
    search.type = "search";
    search.value = inventoryQuery;
    search.placeholder = "搜索 Agent、客户端、Skill、MCP…";
    search.setAttribute("aria-label", "搜索 Agent、客户端与能力");
    search.setAttribute("autocomplete", "off");
    search.addEventListener("input", () => {
      const cursor = typeof search.selectionStart === "number" ? search.selectionStart : null;
      inventoryQuery = clean(search.value, 100);
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
    // Keep the capability families discoverable without making a 35-Hook or
    // 25-Skill directory occupy the entire sidebar by default. These are
    // navigation shortcuts, not second copies of the capability records.
    const quicknav = el("div", "uw-agent-inventory-quicknav");
    quicknav.setAttribute("aria-label", "快速查看 Agent 与能力");
    const quickGroups = [
      ["run", "结论", new Set(tasks.map(task => taskOwner(task))).size],
      ["subagents", "Subagents", tasks.filter(task => task.source?.isMain !== true
        && (task.source?.parentId || task.source?.nativeTaskCaption)).length],
      ["native-hosts", "宿主", discoveredHosts.length],
      ["registered-agents", "Agents", catalogItems("agents").length],
      ["professional-agents", "专业", Array.isArray(catalog?.professionalAgents) ? catalog.professionalAgents.length : 0],
      ["skill", "Skills", capabilityEntries("skill", "skills").length],
      ["mcp", "MCP", capabilityEntries("mcp", "mcpServers").length],
      ["hook", "Hooks", capabilityEntries("hook", "hooks").length],
    ];
    for (const [id, name, amount] of quickGroups) {
      const shortcut = makeButton(`${name} ${amount}`, () => {
        if (inventoryQuery) {
          inventoryQuery = "";
          lastInventorySignature = "";
          renderInventory();
        }
        const currentSurface = inventory.children?.[0];
        const section = [...(currentSurface?.children || [])].find(child => child?.dataset?.section === id);
        if (!section) return;
        section.open = true;
        inventoryExpanded.add(id);
        inventoryExpanded.delete(`${id}:closed`);
        section.scrollIntoView?.({ block: "nearest" });
      }, "uw-agent-inventory-shortcut");
      shortcut.dataset.targetSection = id;
      quicknav.append(shortcut);
    }
    surface.append(quicknav);
    const makeSection = (id, heading, amount, open = false) => {
      const details = el("details", "uw-agent-inventory-section");
      details.dataset.section = id;
      details.open = Boolean(normalizedInventoryQuery()) || inventoryExpanded.has(id) || (open && !inventoryExpanded.has(`${id}:closed`));
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
    const activeSection = makeSection("run", "当前 Run", agentsByOwner.size, true);
    if (!tasks.length && !inventoryQuery) activeSection.append(el("p", "uw-agent-inventory-hint", "暂无绑定当前 Run 的 Agent 结论。"));
    resultCount += agentsByOwner.size;
    for (const [name, owned] of agentsByOwner) {
      const latest = owned.find(task => taskVisualState(task) === "running") || owned.at(-1);
      const outcome = taskOutcome(latest);
      const row = makeButton("", () => {
        mode = "agents";
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
    surface.append(activeSection);
    const matchingHosts = discoveredHosts.filter(host => inventoryMatches(host.id, host.label, host.statusLabel)
      || nativeCapabilities.some(item => item.hostId === host.id && inventoryMatches(item.id, item.label, item.kind)));
    const nativeSection = makeSection("native-hosts", "当前服务端宿主", matchingHosts.length,
      discoveredHosts.length > 0);
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
    const inspectHostCapability = (id, label, kind = "host") => {
      mode = "knowledge";
      knowledgeLayer = "hosts";
      selection = { id, title: clean(label, 100), kind, layer: "hosts" };
      lastCanvasSignature = "";
      render();
      viewport.scrollIntoView?.({ block: "nearest" });
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
        const viewGraph = makeButton("查看能力关系", () =>
          inspectHostCapability(`host:${hostId}`, host.label || hostId), "uw-native-host-graph");
        viewGraph.setAttribute("aria-label", `在 Live 查看 ${host.label || hostId} 的能力关系`);
        body.append(viewGraph);
        body.append(el("p", "uw-native-host-capability-disclaimer", "已发现配置 · 未确认加载。点具体能力可查看关系。"));
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
        for (const item of entries) {
          const label = clean(item.label || item.id, 110);
          const row = makeButton("", () => inspectHostCapability(
            `config:${item.hostId}:${item.scope}:${item.kind}:${item.id}`, label, "capability"),
          "uw-native-host-capability");
          row.append(el("span", "", label));
          row.setAttribute("aria-label", `查看 ${host.label || hostId} 的 ${family.label} ${label} 关系`);
          row.title = `${clean(item.scope || "当前配置范围", 40)} · ${clean(item.source || "来源待核对", 80)} · ${item.installationState === "configured" ? "已发现配置" : "记录待核对"}，未确认加载或实际调用`;
          group.append(row);
        }
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
    surface.append(nativeSection);
    const subagents = tasks.filter(task => task.source?.isMain !== true
      && (task.source?.parentId || task.source?.nativeTaskCaption)
      && inventoryMatches(task.title, taskOwner(task), task.source?.nativeTaskCaption, task.statusLabel, taskOutcome(task).detail));
    const subagentsSection = makeSection("subagents", "Subagents · 编排与回执", subagents.length, subagents.length > 0);
    if (!subagents.length && !inventoryQuery) subagentsSection.append(el("p", "uw-agent-inventory-hint", "未观测到已绑定的子 Agent 任务。"));
    resultCount += subagents.length;
    for (const task of subagents) {
      const row = makeButton("", () => {
        mode = "agents";
        selectDesktopAnnotationNode({ id: task.id, title: task.title, kind: "task", layer: "agents" });
      }, "uw-agent-inventory-capability");
      row.dataset.state = taskVisualState(task);
      row.append(el("span", "uw-agent-inventory-item-title", clean(task.title, 90)),
        el("small", "", `${taskOwner(task)} · ${task.statusLabel || labelFor(task.status)} · ${taskOutcome(task).heading}`));
      subagentsSection.append(row);
    }
    if (inventoryQuery && !subagents.length) subagentsSection.hidden = true;
    surface.append(subagentsSection);
    const registeredAgents = catalogItems("agents").filter(item =>
      ![...agentsByOwner.keys()].some(owner => [item.id, item.label].some(value => clean(value).toLowerCase() === owner.toLowerCase()))
      && inventoryMatches(item.id, item.label, item.role, ...(Array.isArray(item.owns) ? item.owns : [item.owns])));
    const rolesSection = makeSection("registered-agents", "已注册 Agent", registeredAgents.length, true);
    if (!registeredAgents.length && !inventoryQuery) rolesSection.append(el("p", "uw-agent-inventory-hint", "尚无可读取的注册角色。"));
    resultCount += registeredAgents.length;
    for (const item of registeredAgents) {
      const label = clean(item.label || item.id, 90);
      const row = el("div", "uw-agent-inventory-agent uw-agent-inventory-registered");
      const copy = el("span", "uw-agent-inventory-agent-copy");
      copy.append(el("strong", "", label), el("small", "", "已注册 · 无本轮结论"));
      row.append(agentMark(item.id || label, true), copy);
      row.title = `${clean(item.role || item.owns || label, 240)} · 注册不代表已调用`;
      rolesSection.append(row);
    }
    if (inventoryQuery && !registeredAgents.length) rolesSection.hidden = true;
    surface.append(rolesSection);
    const professionalAgents = catalog?.professionalSourceStatus === "verified_local"
      && Array.isArray(catalog?.professionalAgents) ? catalog.professionalAgents.filter(item =>
        inventoryMatches(item.id, item.label, item.agentKind)) : [];
    const professionalSection = makeSection("professional-agents", "Kim_Service 专业 Agent", professionalAgents.length);
    if (!professionalAgents.length && !inventoryQuery) professionalSection.append(el("p", "uw-agent-inventory-hint",
      "当前项目尚未绑定已核验的专业 Agent 来源；注册来源不等于已安装或已调用。"));
    resultCount += professionalAgents.length;
    for (const item of professionalAgents) {
      if (!item || item.registrationState !== "verified_source_only" || !item.id) continue;
      const label = clean(item.label || item.id, 100);
      const row = el("div", "uw-agent-inventory-agent uw-agent-inventory-registered");
      const copy = el("span", "uw-agent-inventory-agent-copy");
      copy.append(el("strong", "", label), el("small", "", "来源哈希已核验 · 未观测调用"));
      row.append(agentMark(item.id, true), copy);
      professionalSection.append(row);
    }
    if (inventoryQuery && !professionalAgents.length) professionalSection.hidden = true;
    surface.append(professionalSection);
    for (const family of capabilityFamilies) {
      const entries = capabilityEntries(family.kind, family.catalog).filter(entry =>
        inventoryMatches(entry.label, family.name));
      const section = makeSection(family.kind, family.name, entries.length);
      if (!entries.length && !inventoryQuery) section.append(el("p", "uw-agent-inventory-hint", "暂无注册项或本轮调用证据。"));
      resultCount += entries.length;
      for (const entry of entries) {
        const row = el("div", "uw-agent-inventory-capability");
        row.dataset.state = entry.state;
        row.append(el("span", "uw-agent-inventory-item-title", entry.label));
        row.append(el("small", "", entry.referenceOnly ? "参考资料 · 非可调用能力"
          : entry.state === "observed" ? "本轮已观测调用" : entry.state === "planned" ? "已选择 · 未观测调用"
            : "已注册 · 未观测调用"));
        section.append(row);
      }
      if (inventoryQuery && !entries.length) section.hidden = true;
      surface.append(section);
    }
    if (inventoryQuery) {
      const searchResult = el("p", "uw-agent-inventory-search-result", resultCount
        ? `已筛出 ${resultCount} 条记录，点分类可查看` : "没有找到匹配记录，试试 Agent、客户端或能力名称");
      surface.insertBefore?.(searchResult, quicknav);
    }
    surface.append(el("p", "uw-agent-inventory-footnote", catalog?.evidenceLevel === "registered_only"
      ? "注册目录是能力索引。真实调用以当前 Run 回执为准。" : "无真实回执时，不把能力注册或任务分派当作执行。"));
    inventory.replaceChildren(surface);
    inventory.scrollTop = resetInventoryScroll ? 0 : previousScroll;
    resetInventoryScroll = false;
  }
  function renderCanvas() {
    const blueprint = designSource();
    const signature = JSON.stringify({ mode, knowledgeLayer, knowledgeDepth, knowledgeLimit, selection, agentStatus: agent.status,
      decision: agent.pending?.decision?.state, pendingId: agent.pending?.key,
      nativeDraftStatus: nativeDraft.snapshot?.status, designVersion: design.snapshot?.version,
      pendingReviewNotes: design.snapshot?.pendingReviewNotes, hosts: agent.hosts,
      workspaceRevision: state.workspace?.revision, runId: isCurrentRun() ? state.selection?.runId : null,
      tasks: runTasks().map(task => ({ id: task.id, status: task.status, summary: task.source.summary,
        ownerReport: task.source.ownerReport, nativeReturnEvidence: task.source.nativeReturnEvidence,
        capabilityTruth: task.source.capabilityTruth, task: task.source.task })),
      stages: (state.workspace?.stages || []).map(stage => `${stage.id}:${stage.status}`),
      graphData: blueprint?.design,
      // Host/Skill/MCP/Hook discovery completes after the initial Live paint.
      // Without this key a user already viewing the capability graph would
      // stay on a stale empty graph until manually changing tabs.
      nativeGraph: mode === "knowledge" && knowledgeLayer === "hosts"
        ? { hosts: state.capabilityCatalog?.nativeHosts, capabilities: state.capabilityCatalog?.nativeCapabilities }
        : null });
    if (signature === lastCanvasSignature) return;
    lastCanvasSignature = signature;
    const previousScroll = viewport.scrollTop;
    viewport.replaceChildren(mode === "knowledge" ? renderKnowledge() : mode === "agents" ? renderAgents() : renderFlow());
    viewport.scrollTop = previousScroll;
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
      : "点击或圈选节点，再在左侧同一个输入框反馈";
  }
  function updateTarget() {
    if (target) target.hidden = !selection;
    if (targetText) targetText.textContent = selection ? `已圈选：${selection.title}` : "";
  }
  function render() {
    if (project) project.textContent = state.agentServerProjectLabel || "项目身份待核对";
    if (connection) {
      const available = (agent.hosts || []).some(host => host.available && host.launchSupported && !/codex/iu.test(host.id));
      connection.textContent = agent.busy ? "正在提交" : available ? "已连接" : agent.loading ? "正在检测" : "客户端待连接";
      connection.dataset.state = available ? "connected" : "waiting";
    }
    if (send) send.disabled = agent.busy || agent.decisionBusy || design.busy || !input.value.trim();
    if (guidance) guidance.textContent = selection ? `消息将关联「${selection.title}」` :
      pendingChoice() ? selectedStrategy ? "发送理由后记录方案选择" : "选方案，或直接发送修改意见" :
        "Enter 发送，Shift+Enter 换行";
    updateTarget();
    renderThread();
    renderCanvas();
    renderInventory();
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
  form.addEventListener("submit", event => { event.preventDefault(); void submitMessage(); });
  input.addEventListener("input", () => { input.setCustomValidity(""); render(); });
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault(); void submitMessage();
    }
  });
  targetClear?.addEventListener("click", () => { selection = null; render(); input.focus(); });
  function activateTab(tab) {
    mode = tab.dataset.uwLiveMode;
    selection = null;
    render();
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
