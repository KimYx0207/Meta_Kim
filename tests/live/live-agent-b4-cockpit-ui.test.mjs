import assert from "node:assert/strict";
import test from "node:test";

import { createUnifiedAgentDesktop } from "../../src/presentation/live/live-agent-desktop.mjs";
import { LIVE_WORKSPACE_CSS } from "../../src/presentation/live/live-workspace-styles.mjs";
import { renderLiveWorkspaceSurface } from "../../src/presentation/live/live-workspace-view.mjs";

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || "div").toUpperCase();
    this.ownerDocument = ownerDocument;
    this.className = "";
    this.id = "";
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.value = "";
    this.placeholder = "";
    this.title = "";
    this.type = "";
    this.tabIndex = 0;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 600;
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = [];
    this.parentNode = null;
    this._text = "";
  }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this._text + this.children.map((c) => c.textContent).join("");
  }

  set textContent(val) {
    this._text = String(val ?? "");
    this.children = [];
  }

  setAttribute(name, value) {
    const str = String(value);
    this.attributes.set(name, str);
    if (name === "id") this.id = str;
    if (name.startsWith("data-")) {
      const camel = name.slice(5).replace(/-([a-z])/gu, (_, ch) => ch.toUpperCase());
      this.dataset[camel] = str;
    }
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  append(...nodes) {
    for (const item of nodes) {
      if (item == null) continue;
      const child = typeof item === "string" ? this.ownerDocument.createTextNode(item) : item;
      child.parentNode = this;
      this.children.push(child);
    }
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  replaceChildren(...nodes) {
    this.children = [];
    this._text = "";
    this.append(...nodes);
  }

  insertBefore(newNode, refNode) {
    newNode.parentNode = this;
    const idx = this.children.indexOf(refNode);
    if (idx === -1) this.children.push(newNode);
    else this.children.splice(idx, 0, newNode);
    return newNode;
  }

  addEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  click() {
    if (this.disabled) return;
    for (const fn of this.listeners.get("click") || []) {
      fn({ preventDefault() {}, target: this });
    }
  }

  matchesSelector(selector) {
    if (selector.startsWith("[data-uw-") && selector.endsWith("]")) {
      const body = selector.slice(1, -1);
      const [attr, rawVal] = body.split("=");
      const actual = this.attributes.get(attr);
      if (rawVal === undefined) return actual !== undefined;
      return actual === rawVal.replace(/^"|"$/gu, "");
    }
    if (selector.startsWith(".")) return this.className.split(/\s+/u).includes(selector.slice(1));
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children || []) {
        if (typeof child.matchesSelector === "function" && child.matchesSelector(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  closest() {
    return null;
  }

  focus() {}
}

function createDesktopDom() {
  const doc = {
    createElement(tag) {
      return new FakeElement(tag, doc);
    },
    createElementNS(_ns, tag) {
      return new FakeElement(tag, doc);
    },
    createTextNode(text) {
      const t = new FakeElement("#text", doc);
      t._text = String(text);
      return t;
    },
  };

  const root = doc.createElement("div");
  const makeHook = (hook, tag = "div") => {
    const node = doc.createElement(tag);
    node.setAttribute(`data-uw-${hook}`, "");
    root.append(node);
    return node;
  };

  makeHook("agent-chat");
  const thread = makeHook("chat-thread");
  makeHook("chat-announcement");
  const form = makeHook("chat-form", "form");
  const input = makeHook("chat-input", "textarea");
  makeHook("chat-send", "button");
  makeHook("chat-project");
  makeHook("chat-connection");
  makeHook("chat-guidance");
  makeHook("chat-target");
  makeHook("chat-target-text");
  makeHook("chat-target-clear", "button");
  makeHook("agent-inventory");
  const viewport = makeHook("live-viewport");
  makeHook("live-caption");
  makeHook("live-count");
  makeHook("live-source");

  for (const mode of ["flow", "agents", "knowledge"]) {
    const tab = doc.createElement("button");
    tab.setAttribute("data-uw-live-mode", mode);
    tab.id = `uw-live-tab-${mode}`;
    root.append(tab);
  }

  return { doc, root, thread, form, input, viewport };
}

test("Wave 2 Cockpit UI: renders 5-pillar strip, one-click B2 fast-track button, live Stage 06 status, and B4 accept/rework/playbook cards", () => {
  const { root, thread, viewport } = createDesktopDom();

  const actionsCalled = [];
  const state = {
    canWrite: true,
    agentServerProjectLabel: "eu-shop-one",
    origin: "local",
    workspace: null,
    selection: {},
    tasks: [],
    capabilityCatalog: { agents: [], skills: [], nativeHosts: [], nativeCapabilities: [] },
  };
  const agent = {
    status: "completed",
    busy: false,
    decisionBusy: false,
    loading: false,
    hosts: [{ id: "claude", label: "Claude Code", available: true, launchSupported: true }],
    pending: {
      key: "req_cockpit_00001",
      goal: "运营欧洲跨境电商一号店，优化定价与旺季库存",
      resultPreview: "候选方案摘要",
      decision: {
        state: "adopted_for_design",
        selectedStrategy: "A：稳健库存联动转化方案",
        selectionReason: "优先保障毛利与不断货",
      },
    },
  };
  const design = {
    busy: false,
    error: null,
    pendingMutation: null,
    snapshot: {
      version: 2,
      status: "draft",
      reviewComplete: false,
      pendingReviewNotes: [],
      system: {
        title: "欧洲电商运营系统",
        goal: "提升转化率",
        architecture: "选品-定价-增长",
        techStack: "Node.js ESM, Shopify B2C",
        acceptance: ["语法与配置校验通过"],
        approval: { state: "pending" },
      },
      modules: [
        {
          id: "pricing-inventory",
          title: "动态定价与安全库存",
          objective: "计算旺季安全库存",
          inputContract: ["config/store-eu.json"],
          outputContract: ["src/pricing-engine.mjs"],
          boundaries: ["不自动付款"],
          acceptance: ["导出 computeSafetyStock"],
          dependencies: [],
          approval: { state: "pending" },
        },
      ],
      history: [],
    },
  };
  const nativeDraft = { snapshot: { status: "completed" }, error: null, busy: false };
  const handoff = { snapshot: { status: "eligible", handoffDigest: null }, error: null, busy: false, pendingKey: null };
  const execution = { snapshot: null, error: null, pendingKey: null, busy: false, loading: false };
  const acceptance = { snapshot: null, error: null, pendingKey: null, busy: false, loading: false };

  const desktop = createUnifiedAgentDesktop({
    root,
    state,
    agent,
    design,
    nativeDraft,
    handoff,
    execution,
    acceptance,
    copy: (k) => k,
    buildGraph: () => ({ nodes: [], edges: [] }),
    createGraph: ({ doc }) => doc.createElement("div"),
    callbacks: {
      parseStrategies: () => null,
      approveNode: (kind, id) => actionsCalled.push(["approveNode", kind, id]),
      approveAllAndPrepare: () => actionsCalled.push(["approveAllAndPrepare"]),
      prepareHandoff: () => actionsCalled.push(["prepareHandoff"]),
      authorizeExecution: () => actionsCalled.push(["authorizeExecution"]),
      inspectExecution: () => actionsCalled.push(["inspectExecution"]),
      verifyDeliverables: () => actionsCalled.push(["verifyDeliverables"]),
      acceptDeliverables: (summary) => actionsCalled.push(["acceptDeliverables", summary]),
      requestDeliverableRework: (moduleId, feedback) => actionsCalled.push(["requestDeliverableRework", moduleId, feedback]),
      rollbackDeliverables: () => actionsCalled.push(["rollbackDeliverables"]),
    },
  });

  // 1. Deduplicated Flow view renders a single 8-stage pipeline bar + 6-step milestone list with zero duplicate cockpit/DAG blocks!
  assert.equal(viewport.querySelectorAll(".uw-cockpit-pillar").length, 0, "Duplicate 5-pillar strip must be removed from Flow view");
  assert.equal(viewport.querySelectorAll(".uw-flow-dag-card").length, 0, "Duplicate nested DAG scrollbox must be removed from Flow view");
  const eightStageChips = viewport.querySelectorAll(".uw-eight-stage-chip");
  assert.equal(eightStageChips.length, 8);
  const initialFlowNodes = viewport.querySelectorAll(".uw-agent-flow-node");
  assert.equal(initialFlowNodes.length, 6);

  // 2. One-click B2 approve-all & handoff button appears when pendingReviewNotes is empty!
  const fastTrackBtn = thread.querySelectorAll("button").find((b) => b.textContent.includes("一键确认全部设计"));
  assert.ok(fastTrackBtn, "Expected one-click approve-all fast-track button in B2 card");
  fastTrackBtn.click();
  assert.deepEqual(actionsCalled.at(-1), ["approveAllAndPrepare"]);

  // 3. Advance state to B3 done + B4 awaiting_human_b4 with Playbook matches!
  design.snapshot.status = "approved";
  design.snapshot.reviewComplete = true;
  design.snapshot.system.approval.state = "approved";
  design.snapshot.modules[0].approval.state = "approved";
  handoff.snapshot = { status: "prepared", handoffDigest: "f".repeat(64) };
  execution.snapshot = {
    status: "ready_for_review",
    handoffDigest: "f".repeat(64),
    nativeSessionId: "a1b2c3d4",
    authorizedByLocalB3: true,
  };
  acceptance.snapshot = {
    schemaVersion: "meta-kim-agent-b4-acceptance-v1",
    status: "awaiting_human_b4",
    b3Status: "ready_for_review",
    handoffDigest: "f".repeat(64),
    artifactsDigest: "d".repeat(64),
    changedFiles: [
      { path: "src/pricing-engine.mjs", changeType: "added", bytes: 142, sha256: "1".repeat(64) },
      { path: "config/store-eu.json", changeType: "modified", bytes: 68, sha256: "2".repeat(64) },
    ],
    verification: {
      passed: true,
      checks: [
        { id: "no_forbidden_paths", label: "敏感文件与治理边界检查", passed: true, detail: "通过" },
        { id: "syntax_and_structure", label: "代码语法与配置结构核验", passed: true, detail: "通过" },
      ],
    },
    reworkLessons: ["[pricing-inventory] 旺季安全库存需乘以 1.5 系数"],
    matchedPlaybooks: [
      {
        playbookId: "pb_eu_01",
        title: "欧洲站库存联动经验卡",
        applicability: "compatible",
        matchReasons: ["业务模式一致（B2C 零售）"],
        mismatchReasons: [],
        reworkLessons: ["[pricing-inventory] 旺季安全库存需乘以 1.5 系数"],
      },
    ],
  };

  desktop.render();

  // Stage 06 (`acceptance`) is now waiting_human instead of stuck on planned!
  const flowNodes = viewport.querySelectorAll(".uw-agent-flow-node");
  assert.equal(flowNodes.length, 6);
  assert.equal(flowNodes[5].dataset.state, "waiting_human");
  assert.ok(flowNodes[5].textContent.includes("2 个文件"));

  // B4 card renders changed files, accept button, rework action, and reusable playbook!
  const threadText = thread.textContent;
  assert.ok(threadText.includes("src/pricing-engine.mjs"));
  assert.ok(threadText.includes("欧洲站库存联动经验卡"));

  const acceptBtn = thread.querySelectorAll("button").find((b) => b.textContent.includes("通过 B4 验收并合入主项目"));
  assert.ok(acceptBtn, "Expected B4 accept & merge button");
  acceptBtn.click();
  assert.equal(actionsCalled.at(-1)[0], "acceptDeliverables");

  // Stylesheet includes the new cockpit & B4 styles while preserving existing layout invariants!
  assert.match(LIVE_WORKSPACE_CSS, /\.uw-cockpit-pillars/);
  assert.match(LIVE_WORKSPACE_CSS, /\.uw-b4-card/);
  assert.match(renderLiveWorkspaceSurface(), /B4 用户验收/);
});

// ---------------------------------------------------------------------------
// review #25: every state highlights at most one next step (the gold
// `uw-chat-action`); every other action is secondary.
// ---------------------------------------------------------------------------
const NEXT_STEP_HOSTS = [{ id: "claude", label: "Claude Code", available: true, launchSupported: true }];
function nextStepDesign({ systemApproved = false, moduleApproved = false, mockup = null, status = "draft" } = {}) {
  return {
    version: 2, status, reviewComplete: status === "approved", pendingReviewNotes: [], history: [],
    system: { title: "运营系统", goal: "提升转化", architecture: "选品-定价", techStack: "Node.js", acceptance: ["校验通过"],
      approval: { state: systemApproved ? "approved" : "pending" } },
    modules: [{ id: "pricing", title: "动态定价", objective: "定价", inputContract: ["输入"], outputContract: ["输出"], boundaries: ["不付款"],
      acceptance: ["导出函数"], dependencies: [], approval: { state: moduleApproved ? "approved" : "pending" },
      ...(mockup ? { hasUiPage: true, uiMockup: { status: mockup } } : {}) }],
  };
}
function nextStepDesktop({ agent: agentOverride, design: designSnapshot = null, designExtra = {}, nativeDraft: draftSnapshot = { status: "completed" },
  handoff: handoffState = {}, execution: executionSnapshot = null, acceptance: acceptanceSnapshot = null } = {}) {
  const dom = createDesktopDom();
  const state = { canWrite: true, agentServerProjectLabel: "eu-shop", origin: "local", workspace: null, selection: {}, tasks: [],
    capabilityCatalog: { agents: [], skills: [], nativeHosts: [], nativeCapabilities: [] } };
  const agent = agentOverride || { status: "completed", busy: false, decisionBusy: false, loading: false, hosts: NEXT_STEP_HOSTS,
    pending: { key: "req_next_00001", goal: "优化定价", resultPreview: "候选方案摘要",
      decision: { state: "adopted_for_design", selectedStrategy: "A：稳健方案", selectionReason: "保毛利" } } };
  const design = { busy: false, error: null, pendingMutation: null, snapshot: designSnapshot, ...designExtra };
  const nativeDraft = { snapshot: draftSnapshot, error: null, busy: false };
  const handoff = { snapshot: { status: "eligible", handoffDigest: null }, error: null, busy: false, pendingKey: null, ...handoffState };
  const execution = { snapshot: executionSnapshot, error: null, pendingKey: null, busy: false, loading: false };
  const acceptance = { snapshot: acceptanceSnapshot, error: null, pendingKey: null, busy: false, loading: false };
  const noop = () => true;
  const desktop = createUnifiedAgentDesktop({ root: dom.root, state, agent, design, nativeDraft, handoff, execution, acceptance,
    copy: (k) => k, buildGraph: () => ({ nodes: [], edges: [] }), createGraph: ({ doc }) => doc.createElement("div"),
    callbacks: { parseStrategies: () => null, redetect: noop, reconcileDecision: noop, verifyRequest: noop, newTask: noop, saveDraft: noop,
      retryDraft: noop, approveNode: noop, confirmNodeMockup: noop, approveAllAndPrepare: noop, prepareHandoff: noop, reconcileHandoff: noop,
      reconcileDesign: noop, authorizeExecution: noop, inspectExecution: noop, verifyDeliverables: noop, acceptDeliverables: noop,
      requestDeliverableRework: noop, rollbackDeliverables: noop } });
  desktop.render();
  const primaries = () => [...dom.thread.querySelectorAll(".uw-chat-action"), ...dom.viewport.querySelectorAll(".uw-chat-action")];
  const button = (fragment) => [...dom.thread.querySelectorAll("button"), ...dom.viewport.querySelectorAll("button")]
    .find((node) => node.textContent.includes(fragment));
  return { ...dom, desktop, primaries, button };
}
const primaryLabels = (env) => env.primaries().map((node) => node.textContent);

test("review #25: a blocked client makes re-detecting the one highlighted next step", () => {
  const env = nextStepDesktop({ agent: { status: "blocked", busy: false, loading: false, hosts: [], pending: null } });
  assert.deepEqual(primaryLabels(env), ["重新检测可用客户端"]);
});

test("review #25: an uncertain decision receipt makes checking it the next step", () => {
  const env = nextStepDesktop({ agent: { status: "completed", busy: false, decisionBusy: false, loading: false, hosts: NEXT_STEP_HOSTS,
    decisionPending: { action: "adopt" }, pending: { key: "req_next_00002", goal: "优化定价", resultPreview: "候选方案摘要" } } });
  assert.deepEqual(primaryLabels(env), ["核对原决策回执"]);
});

test("review #25: a failed design draft makes regenerating it the next step", () => {
  const env = nextStepDesktop({ design: { status: "not_started" }, nativeDraft: { status: "failed" } });
  assert.deepEqual(primaryLabels(env), ["重新生成只读设计草稿"]);
});

test("review #25: while a module's page mockup is unconfirmed, confirming it is the next step and approval is secondary", () => {
  const env = nextStepDesktop({ design: nextStepDesign({ systemApproved: true, mockup: "pending" }) });
  assert.deepEqual(primaryLabels(env), ["确认该模块页面效果图"]);
  assert.ok(env.button("确认「动态定价」").className.includes("uw-chat-secondary"));
});

test("review #25: an uncertain handoff receipt is checked before anything moves forward", () => {
  const env = nextStepDesktop({ design: nextStepDesign({ systemApproved: true, moduleApproved: true, status: "approved" }),
    handoff: { pendingKey: "handoff-key-1" } });
  assert.deepEqual(primaryLabels(env), ["核对原交接回执"]);
  assert.ok(env.button("准备交接材料").className.includes("uw-chat-secondary"));
});

test("review #25: with the right panel showing B4 too, only the chat's accept button is highlighted", () => {
  const digest = "f".repeat(64);
  const env = nextStepDesktop({ design: nextStepDesign({ systemApproved: true, moduleApproved: true, status: "approved" }),
    handoff: { snapshot: { status: "prepared", handoffDigest: digest } },
    execution: { status: "ready_for_review", handoffDigest: digest, nativeSessionId: "a1b2c3d4" },
    acceptance: { status: "awaiting_human_b4", handoffDigest: digest, changedFiles: [], verification: { passed: true, checks: [] } } });
  env.root.querySelectorAll("[data-uw-live-mode]").find((tab) => tab.dataset.uwLiveMode === "knowledge").click();
  assert.equal(env.viewport.querySelectorAll(".uw-b4-card").length, 1, "the right panel shows the B4 card as well");
  assert.deepEqual(primaryLabels(env), ["通过 B4 验收并合入主项目"]);
  assert.equal(env.thread.querySelectorAll(".uw-chat-action").length, 1, "the highlighted one sits in the chat");
});

test("review #25: the fast-track button looks like every other secondary action", () => {
  const blocks = LIVE_WORKSPACE_CSS.split("}").filter((block) => block.split("{")[0].trim() === ".uw-chat-fasttrack");
  assert.equal(blocks.length, 0, "no rule restyles the fast-track button away from the secondary look");
});
