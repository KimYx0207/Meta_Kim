import { workspaceStatusKey, workspaceArtifactItems, workspaceMaterialIdentity, workspaceMaterialReady, workspaceReviewForArtifact, workspaceCommandMessage, workspaceStructuredPrdMaterial, buildLivePrdGraph } from "./live-workspace-model.mjs";
import { createPrdKnowledgeGraph } from "./live-prd-knowledge-graph.mjs";

/** Product-facing grouping of native stages. Missing/partial records never imply completion. */
export function projectLiveUserPhases(stages) {
  const phases = [
    { title: "理解目标", ids: ["critical"], note: "明确需求与边界" },
    { title: "调查研究", ids: ["fetch"], note: "查证依据与备选方案" },
    { title: "设计决策", ids: ["thinking"], note: "方案与人工确认" },
    { title: "落实与复核", ids: ["execution", "review", "metareview"], note: "真实执行与两轮复核" },
    { title: "验收沉淀", ids: ["verification", "evolution"], note: "证据验证与经验回写" },
  ];
  const byId = new Map((Array.isArray(stages) ? stages : []).map((stage) => [String(stage.id || "").toLowerCase().replace(/[^a-z]/g, ""), stage]));
  return phases.map((phase, index) => {
    const members = phase.ids.map((id) => byId.get(id)).filter(Boolean);
    const statuses = members.map((item) => workspaceStatusKey(item.status));
    const complete = members.length === phase.ids.length && statuses.every((status) => status === "completed");
    const status = complete ? "completed"
      : statuses.some((value) => value === "blocked") ? "blocked"
      : statuses.some((value) => value === "waiting_human") ? "waiting_human"
      : statuses.some((value) => value === "running") ? "running"
      : statuses.some((value) => value === "unproven") ? "unproven"
      : statuses.some((value) => value === "completed") ? "partial"
      : statuses.some((value) => value === "planned") ? "planned"
      : statuses.some((value) => value === "waiting") ? "waiting" : "unknown";
    const statusLabel = ({ completed: "已完成", blocked: "已阻塞", waiting_human: "等待你确认", running: "正在运行", unproven: "待核实", partial: "部分有记录", planned: "尚未开始", waiting: "等待接续", unknown: "无可核验记录" })[status];
    return { index: index + 1, title: phase.title, note: phase.note, status, statusLabel };
  });
}

/** DOM-only workspace rendering. Inputs are retained across refreshes. */
export function createLiveWorkspaceRenderer({ app, root, state, copy, actions, taskOutputs }) {
  const doc = root.ownerDocument;
  const find = (name) => root.querySelector("[data-uw-" + name + "]");
  const nav = app.querySelector("[data-uw-navigation]");
  const content = find("content");
  const toolbar = find("toolbar");
  const detail = find("detail");
  const detailBody = find("detail-body");
  const forms = new Map();
  let toolbarKey = "";
  const e = (tag, className = "", text = "") => {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };
  const text = (name, value) => { const node = find(name); if (node) node.textContent = String(value ?? ""); };
  const replace = (node, ...children) => { if (node) node.replaceChildren(...children); };
  const label = (status) => copy(workspaceStatusKey(status));
  const displayVersion = (value) => {
    const full = String(value ?? "");
    const digest = /^(sha256:)?([a-f0-9]{64})$/i.exec(full);
    return digest ? (digest[1] || "") + digest[2].slice(0, 12) + "…" + digest[2].slice(-8) : full;
  };
  const nextActionSummary = (action) => {
    if (!action) return "";
    const module = (state.workspace?.design?.modules || []).find((item) => item.id === action.moduleId);
    const item = action.moduleId ? module : state.workspace?.design?.architecture;
    let key;
    switch (action.kind) {
      case "awaiting_review":
        key = ["expired", "not_reviewed", "material_changed"].includes(item?.status)
          ? (action.moduleId ? "nextReviseModule" : "nextReviseOutline")
          : (action.moduleId ? "nextReviewModule" : "nextReviewOutline");
        break;
      case "design_module": key = "nextDesignModule"; break;
      case "revise_outline": key = "nextReviseOutline"; break;
      case "revise_module": key = "nextReviseModule"; break;
      case "continue_module": key = "nextContinueModule"; break;
      case "awaiting_dependency": key = "nextAwaitDependency"; break;
      case "continue_governed_run": key = "nextContinueRun"; break;
      case "register_design_review": key = "nextRegisterReview"; break;
      case "refresh_design_review": key = "nextRefreshReview"; break;
      case "refresh_design_material": key = "nextRefreshMaterial"; break;
      case "apply_feedback": key = "feedbackRecorded"; break;
      default: return action.summary || copy("waiting");
    }
    // Module names and original summaries stay authoritative business data;
    // only known system instructions use the selected interface language.
    return copy(key).replace("{module}", () => module?.title || action.moduleId || copy("moduleDetail"));
  };
  const workspaceActions = () => {
    const workspace = state.workspace;
    if (!workspace) return [];
    if (!Array.isArray(workspace.readyActions) && !Array.isArray(workspace.blockedActions)) {
      return workspace.nextAction ? [{ action: workspace.nextAction, state: null }] : [];
    }
    const items = [...(workspace.readyActions || []).map((action) => ({ action, state: "ready" })),
      ...(workspace.blockedActions || []).map((action) => ({ action, state: "blocked" }))];
    const next = workspace.nextAction;
    if (["refresh_design_material", "refresh_design_review", "apply_feedback", "register_design_review"].includes(next?.kind) &&
      !items.some(({ action }) => action.kind === next.kind && action.moduleId === next.moduleId)) {
      items.push({ action: next, state: null });
    }
    return items;
  };
  const button = (title, action, attributes = {}, secondary = false) => {
    const node = e("button", "uw-button" + (secondary ? " secondary" : ""), title);
    node.type = "button";
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    node.addEventListener("click", action);
    return node;
  };
  const empty = (title, note, retry = null) => {
    const box = e("div", "uw-empty");
    box.append(e("span", "uw-empty-mark", "◇"), e("h3", "", title), e("p", "", note));
    if (retry) box.append(button(copy("retry"), retry, {}, true));
    return box;
  };
  const skeleton = () => {
    const box = e("div", "uw-skeleton");
    box.setAttribute("role", "status");
    box.setAttribute("aria-label", copy("loading"));
    for (let i = 0; i < 3; i += 1) box.append(e("span"));
    return box;
  };
  const section = (title, body) => {
    const node = e("section", "uw-section");
    node.append(e("h3", "", title));
    if (typeof body === "string") node.append(e("p", "", body));
    else if (body) node.append(body);
    return node;
  };
  const facts = (entries) => {
    const node = e("dl", "uw-facts");
    for (const [name, value] of entries) if (value !== undefined && value !== null && value !== "") node.append(e("dt", "", name), e("dd", "", Array.isArray(value) ? value.join(" · ") : value));
    return node;
  };
  const pageButtons = (page, total, size, change) => {
    const box = e("div", "uw-pagination");
    const previous = button(copy("previous"), () => change(page - 1), {}, true);
    previous.disabled = page <= 0;
    const next = button(copy("next"), () => change(page + 1), {}, true);
    next.disabled = (page + 1) * size >= total;
    box.append(previous, e("span", "", (page + 1) + " / " + Math.max(1, Math.ceil(total / size))), next);
    return box;
  };
  function renderHeader() {
    const snapshot = state.snapshot;
    root.dataset.workspaceRevision = state.workspace?.revision == null ? "" : String(state.workspace.revision);
    const boundProject = !snapshot?.run && !state.project && state.agentServerProjectLabel;
    const title = snapshot?.run?.title || state.project?.displayName || (boundProject
      ? `本地项目 ${boundProject} · 尚未开始正式运行` : copy("projectEmpty"));
    const subtitle = snapshot?.run?.task || nextActionSummary(workspaceActions()[0]?.action) || (boundProject
      ? "上方可先做研究与设计；正式 Run 需要真实运行记录。" : state.workspace ? copy("noReviews") : copy("chooseRun"));
    text("title", title);
    text("project-label", state.project?.displayName || (boundProject ? boundProject : copy("workspace")));
    text("next", subtitle);
    find("next").hidden = !subtitle || String(subtitle).trim() === String(title).trim();
    text("status", snapshot?.run?.status ? label(snapshot.run.status) : copy("waitingRun"));
    const fullVersion = String(state.workspace?.source?.version ?? "");
    text("update", [fullVersion ? copy("version") + " " + displayVersion(fullVersion) : "", state.lastReadAt ? new Date(state.lastReadAt).toLocaleTimeString(state.language === "zh" ? "zh-CN" : state.language, { hour: "2-digit", minute: "2-digit" }) : ""].filter(Boolean).join(" · "));
    find("update").title = fullVersion;
    find("update").dataset.version = fullVersion;
    text("data-state", copy(state.loading && !state.workspace ? "loading" : state.error ? "stale" : state.workspace ? "fresh" : "partial"));
    text("source", copy("footer"));
    text("read-state", state.workspace?.capabilities?.host?.mode === "current_host_pull" ? copy("hostBoundary") : "");
    const origin = find("origin");
    origin.hidden = !["demo", "acceptance_fixture"].includes(state.origin);
    origin.textContent = state.origin === "demo" ? copy("demo") : copy("fixture");
    const unresolved = ["pending_verification", "in_doubt"].includes(state.command?.status);
    const notice = state.notice || (state.error ? copy("refreshError") : unresolved ? copy("uncertain") : state.command?.awaitingRefresh ? copy("bindingPending") : "");
    find("notice").hidden = !notice;
    text("notice", notice);
    if ((unresolved || state.command?.awaitingRefresh) && !state.command?.busy) find("notice").append(button(copy("checkResult"), actions.verifyCommand, { "data-live-workspace-pending-verify": "" }, true));
    text("view-title", copy(state.view));
    text("eyebrow", copy("currentRun"));
    find("detail-close")?.setAttribute("aria-label", copy("close"));
    find("refresh")?.setAttribute("aria-label", copy("refresh"));
  }
  function renderNavigation() {
    if (!nav) return;
    nav.setAttribute("aria-label", copy("workspace"));
    nav.querySelector("[data-uw-nav-heading-text]").textContent = copy("workspace");
    const researchingWithoutRun = root.dataset.agentEntryEnabled === "true" && !state.snapshot?.run;
    nav.querySelector("[data-uw-module-heading]").textContent = researchingWithoutRun ? "正式运行模块" : copy("modules");
    nav.querySelector("[data-uw-nav-footer]").textContent = copy("footer");
    nav.querySelector("[data-uw-project-switch]").setAttribute("aria-label", copy("chooseRun"));
    nav.querySelector("[data-uw-nav-close]").setAttribute("aria-label", copy("closeNavigation"));
    app.querySelector("[data-uw-nav-open]")?.setAttribute("aria-label", copy("openNavigation"));
    const projectName = nav.querySelector("[data-uw-project-name]");
    if (projectName) { projectName.textContent = state.project?.displayName || copy("project"); projectName.title = projectName.textContent; }
    const runName = nav.querySelector("[data-uw-run-name]");
    if (runName) { runName.textContent = state.snapshot?.run?.title || copy("chooseRun"); runName.title = runName.textContent; }
    nav.querySelectorAll("[data-uw-label]").forEach((node) => { node.textContent = copy(node.dataset.uwLabel); });
    nav.querySelectorAll("[data-uw-view]").forEach((node) => node.setAttribute("aria-current", (state.externalView || state.view) === node.dataset.uwView ? "page" : "false"));
    const modules = state.workspace?.design?.modules || [];
    nav.querySelector("[data-uw-module-count]").textContent = String(state.workspace?.design?.totalModules ?? modules.length);
    const host = nav.querySelector("[data-uw-modules]");
    const selectedFocus = doc.activeElement?.dataset?.liveWorkspaceModule;
    const searchFocused = doc.activeElement?.className === "uw-structure-search";
    const searchCaret = searchFocused ? [doc.activeElement.selectionStart, doc.activeElement.selectionEnd] : null;
    replace(host);
    const architecture = state.workspace?.design?.architecture;
    if (architecture) {
      const overview = e("button", "uw-structure-root"); overview.type = "button";
      overview.dataset.liveWorkspaceOutline = architecture.id;
      overview.dataset.selected = String(state.prdMode === "overview" && state.view === "prd");
      overview.title = [architecture.title || copy("overview"), copy("prdFirstLayer")].join(" · ");
      overview.append(e("span", "uw-structure-number", "01"), e("span", "", architecture.title || copy("overview")));
      overview.addEventListener("click", actions.openOverview);
      host.append(overview);
    }
    const children = e("div", "uw-structure-children");
    const search = e("input", "uw-structure-search"); search.type = "search";
    search.placeholder = copy("prdGraphSearch"); search.setAttribute("aria-label", copy("prdGraphSearch"));
    search.value = state.moduleSearch;
    const searchEmpty = e("p", "uw-nav-empty", copy("prdGraphSearchEmpty")); searchEmpty.hidden = true;
    const filterModules = () => {
      const query = state.moduleSearch.trim().toLocaleLowerCase();
      let visible = 0;
      for (const node of children.querySelectorAll("[data-live-workspace-module]")) {
        const match = !query || node.title.toLocaleLowerCase().includes(query) || node.dataset.liveWorkspaceModule.toLocaleLowerCase().includes(query);
        node.hidden = !match;
        if (match) visible += 1;
      }
      searchEmpty.hidden = visible > 0 || !query;
    };
    search.addEventListener("input", () => { state.moduleSearch = search.value; filterModules(); });
    if (modules.length) host.append(search);
    if (!modules.length) children.append(e("p", "uw-nav-empty", researchingWithoutRun
      ? "正式 Run 尚未生成模块。已采纳的设计模块请到上方 B2 审阅。" : copy("noModules")));
    for (const module of modules) {
      const item = e("button"); item.type = "button";
      item.dataset.liveWorkspaceModule = module.id;
      item.dataset.selected = String(state.selectedModuleId === module.id && state.prdMode === "module");
      item.title = [module.title || module.id, module.id].join(" · ");
      item.append(e("span", "", module.title || module.id));
      item.addEventListener("click", () => actions.selectModule(module.id));
      children.append(item);
    }
    host.append(children, searchEmpty);
    filterModules();
    if (selectedFocus) [...children.querySelectorAll("[data-live-workspace-module]")]
      .find(node => node.dataset.liveWorkspaceModule === selectedFocus)?.focus({ preventScroll: true });
    if (searchFocused) {
      search.focus({ preventScroll: true });
      if (searchCaret.every(Number.isInteger)) search.setSelectionRange(...searchCaret);
    }
    if (state.workspace?.design?.nextCursor) host.append(button(copy("loadMore"), actions.loadModules, { "data-live-workspace-modules-more": "" }, true));
    const reviewCount = (state.workspace?.reviews || []).filter((review) => review.state === "awaiting_human").length;
    const count = nav.querySelector('[data-uw-count="prd"]');
    if (count) { count.hidden = !reviewCount; count.textContent = String(reviewCount); }
  }
  function renderStages() {
    const host = find("stages");
    const previousFocus = doc.activeElement?.dataset?.liveWorkspaceStage;
    replace(host);
    const stages = state.workspace?.stages || state.fallbackStages || [];
    // A product-facing projection of recorded stages. No progress is inferred
    // merely because a later stage exists; the canonical eight remain below.
    const phases = projectLiveUserPhases(stages);
    const phaseHost = find("phases");
    if (phaseHost) {
      replace(phaseHost);
      for (const phase of phases) {
        const item = e("li", "uw-phase");
        item.dataset.state = phase.status;
        item.append(e("span", "uw-phase-number", String(phase.index).padStart(2, "0")));
        const description = e("div", "uw-phase-copy");
        description.append(e("strong", "", phase.title), e("small", "", phase.statusLabel));
        item.title = `${phase.title} · ${phase.note} · ${phase.statusLabel}`;
        item.append(description);
        phaseHost.append(item);
      }
    }
    for (const [index, stage] of stages.entries()) {
      const node = e("button", "uw-stage"); node.type = "button";
      node.setAttribute("role", "listitem"); node.dataset.liveWorkspaceStage = stage.id;
      node.dataset.state = workspaceStatusKey(stage.status);
      node.title = [stage.label || stage.id, label(stage.status), stage.summary].filter(Boolean).join(" · ");
      const names = e("span", "uw-stage-copy");
      names.append(e("strong", "", stage.label || stage.id), e("small", "", label(stage.status)));
      node.append(e("span", "uw-stage-number", String(index + 1).padStart(2, "0")), names);
      node.addEventListener("click", () => actions.openDetail({ kind: "stage", id: stage.id }, node));
      host.append(node);
      if (previousFocus === stage.id) node.focus({ preventScroll: true });
    }
    host.hidden = !host.children.length;
  }
  function renderToolbar() {
    const key = [state.view, state.language, (state.workspace?.design?.modules || []).map((item) => item.id + item.title).join("|")].join(":");
    if (toolbarKey === key) {
      toolbar.querySelectorAll("[data-live-workspace-prd-view]").forEach((node) => node.setAttribute("aria-pressed", String(node.dataset.liveWorkspacePrdView === state.prdMode)));
      return;
    }
    toolbarKey = key;
    replace(toolbar);
    if (state.view === "work") {
      const input = e("input", "uw-input"); input.type = "search"; input.placeholder = copy("search"); input.value = state.query;
      input.setAttribute("aria-label", copy("search")); input.dataset.liveWorkspaceSearch = "";
      input.addEventListener("input", () => { state.query = input.value; state.taskPage = 0; renderMain(); });
      const filter = e("select", "uw-select"); filter.setAttribute("aria-label", copy("status")); filter.dataset.liveWorkspaceFilter = "";
      for (const value of ["all", "running", "waiting_human", "blocked", "completed", "planned", "unproven", "unknown"]) { const option = e("option", "", copy(value)); option.value = value; filter.append(option); }
      filter.value = state.taskFilter;
      filter.addEventListener("change", () => { state.taskFilter = filter.value; state.taskPage = 0; renderMain(); });
      toolbar.append(input, filter);
    } else if (state.view === "prd") {
      const modes = e("div", "uw-segmented"); modes.setAttribute("role", "group"); modes.setAttribute("aria-label", copy("prd"));
      for (const [value, name] of [["overview", "overview"], ["module", "moduleDetail"]]) modes.append(button(copy(name), () => actions.setPrdMode(value), { "data-live-workspace-prd-view": value, "aria-pressed": String(state.prdMode === value) }));
      toolbar.append(modes);
    } else if (state.view === "records") {
      toolbar.append(e("span", "uw-source-ref", copy("events") + " · " + copy("decision") + " · " + copy("receipt")));
    }
  }
  function renderTasks() {
    for (const { action: nextAction, state: actionState } of workspaceActions()) {
      const card = e("section", "uw-next-action");
      card.dataset.liveWorkspaceNextAction = nextAction.kind;
      if (actionState) card.dataset.liveWorkspaceActionState = actionState;
      if (nextAction.moduleId) card.dataset.liveWorkspaceActionModule = nextAction.moduleId;
      card.append(e("span", "uw-eyebrow", copy(actionState === "ready" ? "readyActions" : actionState === "blocked" ? "blockedActions" : "nextAction")), e("h3", "", nextActionSummary(nextAction)));
      if (nextAction.dependsOn?.length) {
        const modules = state.workspace.design?.modules || [];
        card.append(e("p", "uw-source-ref", copy("dependsOn") + ": " + nextAction.dependsOn.map((id) => modules.find((item) => item.id === id)?.title || id).join(" · ")));
      }
      const request = nextAction.commandId && (state.workspace.requests || []).find((item) => item.commandId === nextAction.commandId);
      if (request) card.append(e("p", "", label(request.status)));
      card.append(button(copy(nextAction.kind === "awaiting_review" ? "openMaterial" : nextAction.moduleId ? "openModule" : nextAction.kind === "continue_governed_run" ? "openContinuation" : "overview"), () => actions.openNextAction(nextAction), { "data-live-workspace-next-action-open": "" }));
      content.append(card);
    }
    const query = state.query.trim().toLocaleLowerCase();
    const tasks = state.tasks.filter((item) => (!query || [item.title, item.summary, item.owner, item.id].join(" ").toLocaleLowerCase().includes(query))
      && (state.taskFilter === "all" || workspaceStatusKey(item.status) === state.taskFilter));
    if (!tasks.length) {
      content.append(empty(copy(query || state.taskFilter !== "all" ? "searchEmpty" : "noWork"), copy("noWorkNote")));
      return;
    }
    state.taskPage = Math.min(state.taskPage, Math.max(0, Math.ceil(tasks.length / state.pageSize) - 1));
    const list = e("div", "uw-task-list");
    const start = state.taskPage * state.pageSize;
    for (const task of tasks.slice(start, start + state.pageSize)) {
      const row = e("button", "uw-task-row"); row.type = "button";
      row.dataset.liveWorkspaceTask = task.id; row.dataset.state = workspaceStatusKey(task.status); row.dataset.selected = String(state.detail?.kind === "task" && state.detail.id === task.id);
      const body = e("span", "uw-task-copy");
      body.append(e("strong", "", task.title || task.id), e("small", "", [task.owner, task.summary].filter(Boolean).join(" · ")));
      row.append(e("span", "uw-task-dot"), body, e("span", "uw-task-state", task.statusLabel || label(task.status)));
      row.addEventListener("click", () => actions.openDetail({ kind: "task", id: task.id }, row));
      list.append(row);
    }
    content.append(list);
    if (tasks.length > state.pageSize) content.append(pageButtons(state.taskPage, tasks.length, state.pageSize, (page) => { state.taskPage = page; renderMain(); }));
    text("footer", copy("itemTotal") + " " + tasks.length + " " + copy("taskCount"));
  }
  function appendDocumentText(host, value) {
    let code = false;
    let block = [];
    const flush = () => { if (block.length) { host.append(e(code ? "pre" : "p", "", block.join("\n"))); block = []; } };
    const lines = String(value || "").split("\n");
    const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\s*```/.test(line)) { flush(); code = !code; continue; }
      if (code) { block.push(line); continue; }
      if (line.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1] || "")) {
        flush();
        const wrapper = e("div", "uw-table-wrap"); const table = e("table", "uw-table");
        const head = e("thead"); const heading = e("tr");
        for (const cell of cells(line)) heading.append(e("th", "", cell));
        head.append(heading); table.append(head); index += 1;
        const body = e("tbody");
        while (index + 1 < lines.length && lines[index + 1].trim() && lines[index + 1].includes("|")) {
          const row = e("tr"); for (const cell of cells(lines[++index])) row.append(e("td", "", cell)); body.append(row);
        }
        table.append(body); wrapper.append(table); host.append(wrapper); continue;
      }
      const bullet = /^\s*(?:[-*+]\s+|\d+\.\s+)(.+)$/.exec(line);
      if (bullet) {
        flush(); const ordered = /^\s*\d+\./.test(line); const list = e(ordered ? "ol" : "ul");
        list.append(e("li", "", bullet[1]));
        while (index + 1 < lines.length) { const next = /^\s*(?:[-*+]\s+|\d+\.\s+)(.+)$/.exec(lines[index + 1]); if (!next) break; list.append(e("li", "", next[1])); index += 1; }
        host.append(list); continue;
      }
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (heading) { flush(); host.append(e(heading[1].length < 3 ? "h3" : "h4", "", heading[2])); }
      else if (!line.trim()) flush();
      else block.push(line);
    }
    flush();
  }
  function appendStructuredPrd(host, structured) {
    // Human-facing headings are derived from the validated material currently
    // being viewed; no derived summary replaces its source JSON or review gate.
    const bulletSection = (title, rows, format) => {
      if (!Array.isArray(rows) || !rows.length) return;
      const list = e("ul", "uw-prd-facts-list");
      for (const row of rows) {
        const item = e("li", "", format ? format(row) : String(row));
        list.append(item);
      }
      host.append(section(title, list));
    };
    const refSection = (title, rows) => bulletSection(title, rows, row => typeof row === "string" ? row : String(row?.id || row?.name || ""));
    const architecture = structured.kind === "outline" ? structured.architecture : null;
    const module = structured.kind === "module" ? structured.module : null;
    if (architecture) {
      host.append(section(copy("overview"), architecture.summary || copy("noMaterialNote")));
      bulletSection(copy("prdTechnology"), architecture.technologyChoices, choice => [choice.name, choice.version, choice.rationale,
        ...(Array.isArray(choice.evidenceRefs) ? choice.evidenceRefs : [])].filter(Boolean).join(" · "));
      bulletSection(copy("prdConstraints"), architecture.constraints, constraint => [constraint.requirement, constraint.verification].filter(Boolean).join(" · "));
      refSection(copy("prdModules"), (structured.modules || []).map(row => [row.id, row.purpose].filter(Boolean).join(" · ")));
      refSection(copy("decision"), architecture.decisionRefs);
    }
    if (module) {
      host.append(section(copy("prdPurpose"), module.purpose || copy("moduleSummary")));
      if (module.implementationNotes) {
        const notes = Array.isArray(module.implementationNotes) ? module.implementationNotes.join("\n") : module.implementationNotes;
        host.append(section(copy("prdImplementation"), notes));
      }
      bulletSection(copy("prdBusinessRules"), module.businessRules);
      bulletSection(copy("prdStates"), module.states, row => [row.name, row.behavior].filter(Boolean).join(" — "));
      const links = e("div", "uw-prd-reference-grid");
      for (const [key, rows] of [["prdJourneys", module.journeyRefs], ["prdInterfaces", module.interfaceRefs],
        ["prdSharedState", module.stateRefs], ["tasks", module.taskIds], ["prdAcceptance", module.acceptanceCriterionIds], ["decision", module.decisionRefs]]) {
        if (!Array.isArray(rows) || !rows.length) continue;
        links.append(section(copy(key), rows.join(" · ")));
      }
      if (links.children.length) host.append(links);
      bulletSection(copy("prdRemovalCandidates"), module.removalCandidates, row =>
        [row.path, row.replacement, row.reason, ...(Array.isArray(row.evidenceRefs) ? row.evidenceRefs : [])].filter(Boolean).join(" · "));
    }
  }
  function renderCommand(host, item) {
    const command = state.command;
    if (!command || command.targetIdentity !== workspaceMaterialIdentity(item)) return;
    const status = e("div", "uw-command-status", command.message || copy(workspaceCommandMessage(command.status, command.kind)));
    status.dataset.liveWorkspaceCommandState = command.status;
    status.setAttribute("role", "status");
    if (command.commandId) status.append(e("p", "uw-source-ref", command.commandId));
    if (command.awaitingRefresh) status.append(e("p", "", copy("bindingPending")));
    if (["pending_verification", "in_doubt"].includes(command.status)) status.append(button(copy("checkResult"), actions.verifyCommand, { "data-live-workspace-command-verify": "" }, true));
    host.append(status);
  }
  function renderReview(host, item) {
    const review = workspaceReviewForArtifact(state.workspace, item);
    if (review) {
      const card = e("section", "uw-decision"); card.dataset.liveWorkspaceReview = review.decisionId;
      card.append(e("h3", "", copy("reviewTitle")), e("p", "", copy("reviewHint")));
      const allowed = state.canWrite && state.workspace?.capabilities?.review?.available === true && review.available !== false;
      if (!allowed) card.append(e("p", "", copy(review.reason || state.workspace?.capabilities?.review?.reason || "readOnly")));
      else if (!workspaceMaterialReady(item, state.material)) card.append(e("p", "", copy("materialUnread")));
      const actionRow = e("div", "uw-actions");
      for (const option of review.options || []) {
        if (!["accept", "revise", "return"].includes(option.id)) continue;
        const action = button(copy(option.id), () => actions.review(review, item, option.id), { "data-live-workspace-review-choice": option.id }, option.id !== "accept");
        action.disabled = !allowed || Boolean(state.command?.busy || state.command?.awaitingRefresh) || ["pending_verification", "in_doubt"].includes(state.command?.status) || !workspaceMaterialReady(item, state.material);
        actionRow.append(action);
      }
      card.append(actionRow);
      host.append(card);
    }
    renderCommand(host, item);
  }
  function renderFeedback(host, item) {
    if (!item?.artifactId) return;
    const key = state.selectionKey + ":" + workspaceMaterialIdentity(item);
    let form = forms.get(key);
    if (!form) {
      const box = e("section", "uw-section");
      const heading = e("h3");
      const hint = e("p");
      const input = e("textarea", "uw-textarea"); input.dataset.liveWorkspaceFeedback = "";
      input.value = state.drafts.get(key) || "";
      input.addEventListener("input", () => state.drafts.set(key, input.value));
      const submit = button(copy("sendFeedback"), () => actions.feedback(form.item, input.value), { "data-live-workspace-submit-feedback": "" });
      const availability = e("p", "uw-source-ref");
      box.append(heading, hint, input, e("div", "uw-actions"), availability);
      box.children[3].append(submit);
      form = { box, heading, hint, input, submit, availability };
      forms.set(key, form);
    }
    form.item = item;
    form.heading.textContent = copy("feedback"); form.hint.textContent = copy("feedbackHint");
    form.input.setAttribute("aria-label", copy("feedback")); form.input.placeholder = copy("feedbackPlaceholder");
    form.submit.textContent = copy(state.command?.busy ? "sending" : "sendFeedback");
    const allowed = state.canWrite && state.workspace?.capabilities?.feedback?.available === true;
    form.submit.disabled = !allowed || Boolean(state.command?.busy || state.command?.awaitingRefresh) || ["pending_verification", "in_doubt"].includes(state.command?.status) || !workspaceMaterialReady(item, state.material);
    form.availability.textContent = allowed ? workspaceMaterialReady(item, state.material) ? "" : copy("materialUnread") : copy(state.workspace?.capabilities?.feedback?.reason || "readOnly");
    host.append(form.box);
  }
  function renderPrd() {
    const items = workspaceArtifactItems(state.workspace);
    const item = state.prdMode === "overview" ? items.find((value) => value.kind === "outline") : state.selectedModuleId
      ? items.find((value) => value.moduleId === state.selectedModuleId)
      : items.find((value) => value.kind === "module");
    if (!item) {
      if (state.prdMode === "module" && state.selectedModuleId && state.workspace?.design?.nextCursor) content.append(skeleton());
      else content.append(empty(copy("noDesign"), copy("noDesignNote")));
      return;
    }
    if (item.moduleId && !state.selectedModuleId) state.selectedModuleId = item.moduleId;
    const layout = e("div", "uw-prd-layout");
    layout.dataset.prdMode = state.prdMode;
    const focusId = state.prdMode === "module" ? state.selectedModuleId : null;
    const graph = buildLivePrdGraph(state.workspace?.design || {}, { focusId, depth: state.prdDepth === "all" ? "all" : state.prdDepth, limit: state.prdGraphLimit || 40 });
    layout.append(createPrdKnowledgeGraph({ doc, graph, copy, focusId: graph.focusKind === "module" ? focusId : null,
      depth: state.prdDepth, onSelect: node => node.kind === "architecture" ? actions.openOverview() : actions.selectModule(node.sourceId),
      onDepthChange: actions.setPrdDepth, onExpand: actions.expandPrdGraph }));
    const article = e("article", "uw-document");
    article.dataset.liveWorkspaceArtifact = item.artifactId || item.id;
    const header = e("header", "uw-document-header");
    const fullVersion = String(item.version ?? copy("unknown"));
    const version = e("span", "uw-version", copy("version") + " " + displayVersion(fullVersion));
    version.title = fullVersion;
    version.dataset.version = fullVersion;
    version.setAttribute("aria-label", copy("version") + " " + fullVersion);
    const heading = e("div", "uw-document-heading");
    heading.append(e("span", "uw-knowledge-kicker", copy(item.kind === "module" ? "prdSecondLayer" : "prdFirstLayer")),
      e("h3", "", item.title || item.id), e("span", "uw-source-ref", item.artifactId || item.id));
    const metadata = e("div", "uw-document-meta");
    const currentStatus = e("span", "uw-document-state", label(item.status));
    currentStatus.dataset.state = workspaceStatusKey(item.status);
    metadata.append(version, currentStatus);
    header.append(heading, metadata);
    article.append(header);
    if (item.purpose || item.summary) article.append(section(copy(item.kind === "module" ? "moduleSummary" : "overview"), item.purpose || item.summary));
    if (item.dependsOn?.length) article.append(section(copy("dependsOn"), item.dependsOn.join(" · ")));
    renderReview(article, item);
    const material = state.material;
    if (!item.artifactId) article.append(empty(copy("noMaterial"), copy("noMaterialNote")));
    else if (!material || material.identity !== workspaceMaterialIdentity(item) || (material.loading && !material.text)) article.append(skeleton());
    else {
      if (material.error) {
        const note = e("div", "uw-notice", material.error);
        note.append(button(copy("retry"), () => actions.loadMaterial(item, false), {}, true));
        article.append(note);
      }
      const body = e("div", "uw-document-body"); body.dataset.liveWorkspaceMaterial = ""; body.dataset.version = String(item.version ?? ""); body.dataset.sha256 = item.sha256 || "";
      const structured = workspaceStructuredPrdMaterial(item, material);
      if (structured) {
        const reading = e("div", "uw-prd-structured");
        appendStructuredPrd(reading, structured);
        body.append(reading);
        const full = e("details", "uw-prd-raw");
        full.append(e("summary", "", copy("prdRawMaterial")));
        const original = e("pre", "", material.text);
        full.append(original); body.append(full);
      } else appendDocumentText(body, material.text);
      article.append(body);
      if (material.nextCursor && !material.conflict) {
        const more = button(copy(material.loading ? "loadingMaterial" : "loadMore"), () => actions.loadMaterial(item, true), { "data-live-workspace-material-more": "" }, true);
        more.disabled = material.loading; article.append(more);
      }
      if (Number.isFinite(material.totalBytes)) article.append(e("p", "uw-source-ref", copy("source") + " · " + material.loadedBytes + " / " + material.totalBytes + " bytes"));
    }
    renderFeedback(article, item);
    layout.append(article);
    content.append(layout);
    text("footer", copy("itemTotal") + " " + (state.workspace?.design?.totalModules ?? (state.workspace?.design?.modules || []).length) + " " + copy("moduleCount"));
  }
  function renderRecords() {
    const history = state.history;
    const requests = new Map((history.rows || []).map((item) => [item.commandId, item]));
    for (const item of state.workspace?.requests || []) requests.set(item.commandId, item);
    const rows = [
      ...(state.snapshot?.replay || []).map((item) => ({ id: item.id, title: item.label || item.kind, summary: item.detail || item.summary || "", at: item.at, kind: item.kind })),
      ...[...requests.values()].map((item) => ({ id: item.commandId, title: copy(item.kind === "feedback" ? "feedback" : item.kind === "review" ? "decision" : "request") + " · " + label(item.status), summary: item.summary || copy(workspaceCommandMessage(item.status, item.kind)), at: item.updatedAt || item.createdAt, kind: "request", receipt: item.receipt })),
    ].sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    if (history.stale || history.error) {
      const note = e("div", "uw-notice", history.stale ? copy("recordsChanged") : history.error);
      note.append(button(copy("refreshRecords"), () => actions.loadRecords(false), { "data-live-workspace-records-refresh": "" }, true));
      content.append(note);
    }
    if (!rows.length) content.append(history.loading ? skeleton() : empty(copy("noEvents"), copy("noEventsNote")));
    state.recordPage = Math.min(state.recordPage, Math.max(0, Math.ceil(rows.length / state.pageSize) - 1));
    const list = e("ol", "uw-timeline");
    const start = state.recordPage * state.pageSize;
    for (const row of rows.slice(start, start + state.pageSize)) {
      const item = e("li", "uw-timeline-item"); item.dataset.liveWorkspaceEvent = row.id || "";
      const body = e("div", "uw-timeline-copy"); body.append(e("strong", "", row.title), e("p", "", row.summary), e("time", "", row.at || copy("unknown")));
      if (row.receipt) {
        const evidence = e("details", "uw-source-ref");
        evidence.append(e("summary", "", copy("receipt") + " · " + copy("evidence")));
        for (const ref of row.receipt.evidenceRefs || []) evidence.append(e("p", "", ref.ref + " · SHA-256: " + ref.sha256));
        if (row.receipt.evidenceOmitted > 0) evidence.append(e("p", "", copy("evidenceMore").replace("{count}", String(row.receipt.evidenceOmitted))));
        evidence.append(e("p", "", copy("receipt") + ": " + row.receipt.ref + " · SHA-256: " + row.receipt.sha256));
        body.append(evidence);
      }
      item.append(e("span", "uw-timeline-marker"), body); list.append(item);
    }
    content.append(list);
    if (rows.length > state.pageSize) content.append(pageButtons(state.recordPage, rows.length, state.pageSize, (page) => { state.recordPage = page; renderMain(); }));
    const total = state.workspace?.revision === history.revision ? history.total : state.workspace?.requestsTotal ?? history.total;
    if (Number.isSafeInteger(total)) content.append(e("p", "uw-source-ref", copy("loadedRecords") + " " + requests.size + " / " + total));
    if (history.nextCursor && !history.stale) {
      const more = button(copy(history.loading ? "loading" : "loadMoreRecords"), () => actions.loadRecords(true), { "data-live-workspace-records-more": "" }, true);
      more.disabled = history.loading; content.append(more);
    }
    text("footer", copy("loadedRecords") + " " + requests.size + (Number.isSafeInteger(total) ? " / " + total : "") + " · " + copy("events") + " " + (state.snapshot?.replay || []).length);
  }
  function renderDetail() {
    detail.hidden = !state.detail;
    root.dataset.detailOpen = String(Boolean(state.detail));
    if (!state.detail) return;
    replace(detailBody);
    if (state.detail.kind === "stage") {
      const stage = (state.workspace?.stages || state.fallbackStages || []).find((item) => item.id === state.detail.id);
      text("detail-kind", copy("stageDetails")); text("detail-title", stage?.label || state.detail.id);
      detailBody.append(section(copy("status"), label(stage?.status)), section(copy("details") + (stage?.summaryTruncated ? " · " + copy("summaryExcerpt") : ""), stage?.summary || copy("unknown")));
      if (stage?.evidenceLevel) detailBody.append(section(copy("evidence"), stage.evidenceLevel));
      const references = stage?.evidenceRefs || stage?.sourceRefs || stage?.evidence || [];
      if (Array.isArray(references) && references.length) {
        const list = e("ul", "uw-evidence-refs");
        for (const reference of references) list.append(e("li", "", typeof reference === "string" ? reference : [reference.label, reference.sourceRef, reference.path, reference.id, reference.summary].filter(Boolean).join(" · ")));
        detailBody.append(section(copy("source"), list));
      } else if (!(stage?.evidenceTotal > 0)) detailBody.append(section(copy("source"), copy("stageEvidenceMissing")));
      if (Number.isSafeInteger(stage?.evidenceOmitted) && stage.evidenceOmitted > 0) detailBody.append(section(copy("source"), copy("evidenceMore").replace("{count}", String(stage.evidenceOmitted))));
      for (const { action } of workspaceActions()) detailBody.append(section(copy("nextAction"), nextActionSummary(action)));
    } else {
      const task = state.tasks.find((item) => item.id === state.detail.id);
      text("detail-kind", copy("tasks")); text("detail-title", task?.title || state.detail.id);
      detailBody.append(section(copy("status"), task?.statusLabel || label(task?.status)), section(copy("details"), task?.summary || copy("unknown")));
      detailBody.append(section(copy("details"), facts([[copy("owner"), task?.owner], [copy("runtime"), task?.runtime], [copy("model"), task?.model], [copy("source"), task?.id]])));
      const outputs = e("div");
      if (taskOutputs && task?.source) taskOutputs(outputs, state.snapshot, task.source);
      if (outputs.children.length) detailBody.append(section(copy("outputs"), outputs));
      detailBody.append(button(copy("openGraph"), () => actions.openGraph(task?.id), {}, true));
    }
  }
  function renderMain() {
    const active = doc.activeElement;
    const activeTask = active?.dataset?.liveWorkspaceTask;
    const activeGraphDepth = active?.dataset?.livePrdGraphDepth;
    const activeGraphNode = active?.dataset?.livePrdGraphNode;
    const selection = typeof active?.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
    const scroll = content.scrollTop;
    const previousGraph = content.querySelector(".uw-knowledge-graph");
    const previousCanvas = previousGraph?.querySelector(".uw-knowledge-canvas");
    const previousPosition = previousCanvas ? { focus: previousGraph.dataset.livePrdKnowledgeFocus,
      depth: previousGraph.dataset.livePrdKnowledgeDepth, left: previousCanvas.scrollLeft, top: previousCanvas.scrollTop } : null;
    replace(content); text("footer", "");
    if (state.loading && !state.workspace && !state.snapshot) content.append(skeleton());
    else if (state.view === "prd") renderPrd();
    else if (state.view === "records") renderRecords();
    else renderTasks();
    content.scrollTop = scroll;
    const nextGraph = content.querySelector(".uw-knowledge-graph");
    const nextCanvas = nextGraph?.querySelector(".uw-knowledge-canvas");
    if (nextCanvas) {
      if (previousPosition?.focus === nextGraph.dataset.livePrdKnowledgeFocus && previousPosition?.depth === nextGraph.dataset.livePrdKnowledgeDepth) {
        nextCanvas.scrollLeft = previousPosition.left;
        nextCanvas.scrollTop = previousPosition.top;
      } else if (Number.isFinite(Number(nextCanvas.dataset.focusCenterX)) && nextCanvas.clientWidth > 0) {
        nextCanvas.scrollLeft = Math.max(0, Number(nextCanvas.dataset.focusCenterX) - nextCanvas.clientWidth / 2);
      }
    }
    if (active?.isConnected && active !== doc.body) {
      active.focus({ preventScroll: true });
      if (selection) active.setSelectionRange(...selection);
    }
    else if (activeTask) [...content.querySelectorAll("[data-live-workspace-task]")].find((node) => node.dataset.liveWorkspaceTask === activeTask)?.focus({ preventScroll: true });
    else if (activeGraphDepth) content.querySelector(`[data-live-prd-graph-depth="${activeGraphDepth}"]`)?.focus({ preventScroll: true });
    else if (activeGraphNode) [...content.querySelectorAll("[data-live-prd-graph-node]")].find(node => node.dataset.livePrdGraphNode === activeGraphNode)?.focus({ preventScroll: true });
  }
  return {
    render() { root.dataset.view = state.view; renderHeader(); renderNavigation(); renderStages(); renderToolbar(); renderMain(); renderDetail(); },
    renderMain,
    detailCloseButton: find("detail-close"),
    content,
  };
}
