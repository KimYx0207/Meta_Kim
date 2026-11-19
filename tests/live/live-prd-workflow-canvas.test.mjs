import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyDesignMutation,
  validateDesignMutation,
} from "../../src/domain/runtime/agent-design-contract.mjs";
import {
  generatePageEffectMockup,
  readStoredMockupImage,
} from "../../src/application/agent/prd-mockup-generator-service.mjs";
import {
  getOrBuildPrdWorkflowCanvas,
  mutatePrdWorkflowCanvas,
} from "../../src/application/agent/prd-workflow-canvas-service.mjs";
import { createDynamicPrdWorkflowCanvas } from "../../src/presentation/live/live-prd-workflow-canvas.mjs";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

class FakeNode {
  constructor(tag) {
    this.tagName = tag;
    this.className = "";
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = [];
  }
  append(...items) {
    for (const item of items) {
      if (item) this.children.push(item);
    }
  }
  replaceChildren(...items) {
    this.children = items.filter(Boolean);
  }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.get(k) ?? null; }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  click() { this.listeners.get("click")?.({ stopPropagation() {}, preventDefault() {} }); }
}

const fakeDoc = {
  createElement: (t) => new FakeNode(t),
  createElementNS: (_ns, t) => new FakeNode(t),
};

function findAll(root, pred) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (pred(n)) out.push(n);
    for (const c of n.children || []) walk(c);
  };
  walk(root);
  return out;
}

test("mockup generator tries image model first and falls back cleanly to structured wireframe when unavailable", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "mk-mockup-test-"));
  try {
    // 1. Model succeeds (Gemini Image API returns PNG)
    const modelRes = await generatePageEffectMockup({
      workflowStateDir: tmpDir,
      projectId: "proj-1",
      projectName: "测试短视频平台",
      nodeId: "script-page",
      title: "AI 改稿与配音台",
      objective: "支持双栏改稿与试听波形",
      environment: { PATH: "", GEMINI_API_KEY: "test-key" },
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          candidates: [{
            content: { parts: [{ inlineData: { mimeType: "image/png", data: TINY_PNG.toString("base64") } }] },
          }],
        }),
      }),
    });
    assert.equal(modelRes.mode, "model_image");
    assert.match(modelRes.imageUrl, /^\/api\/agent\/prd-mockup-image\?/u);
    const stored = readStoredMockupImage({ workflowStateDir: tmpDir, imageId: modelRes.imageId });
    assert.ok(stored);
    assert.equal(stored.contentType, "image/png");

    // 2. Model unconfigured -> automatic structured wireframe fallback
    const fallbackRes = await generatePageEffectMockup({
      workflowStateDir: tmpDir,
      nodeId: "export-page",
      title: "成片审片与导出页",
      objective: "9:16 竖屏预览与导出",
      feedback: "改成左右双栏对照布局",
      version: 2,
      environment: { PATH: "" },
      fetchImpl: async () => ({ ok: false, status: 503 }),
    });
    assert.equal(fallbackRes.mode, "wireframe_fallback");
    assert.equal(fallbackRes.imageUrl, null);
    assert.equal(fallbackRes.wireframeSpec.dualColumn, true);
    assert.equal(fallbackRes.wireframeSpec.version, 2);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("B2 design contract blocks approving UI-bearing modules until uiMockup is confirmed, and supports live add/remove", () => {
  const baseFields = {
    idempotencyKey: "req_key_12345678",
    requestId: "req_12345678",
    planDigest: "a".repeat(64),
    decisionKey: "dec_key_12345678",
  };
  const submitMut = validateDesignMutation({
    ...baseFields,
    mutationKey: "mut_submit_000001",
    expectedVersion: 0,
    action: "submit",
    design: {
      system: {
        title: "数字人创作系统",
        goal: "三分钟出成片",
        architecture: "选角 -> 并行配音/驱动 -> 审片导出",
        techStack: "Node.js + Web SVG",
        acceptance: ["全链路可运行"],
      },
      modules: [
        {
          id: "ui-workbench",
          title: "脚本配音工作台",
          objective: "可视化改稿与试听",
          inputContract: ["原始文稿"],
          outputContract: ["定稿音轨"],
          boundaries: ["需先确认页面效果图"],
          acceptance: ["试听正常"],
          dependencies: [],
          hasUiPage: true,
        },
      ],
    },
  });
  assert.ok(submitMut);
  let state = applyDesignMutation(null, submitMut, 1, "2026-11-18T06:00:00Z");
  assert.equal(state.content.modules[0].uiMockup.status, "pending");

  // Approve system first
  state = applyDesignMutation(
    state.content,
    validateDesignMutation({
      ...baseFields,
      mutationKey: "mut_sys_ok_000002",
      expectedVersion: 1,
      action: "approve",
      target: { kind: "system" },
    }),
    2,
    "2026-11-18T06:01:00Z",
  );

  // Attempting to approve UI module BEFORE confirming its mockup MUST fail!
  assert.throws(() => {
    applyDesignMutation(
      state.content,
      validateDesignMutation({
        ...baseFields,
        mutationKey: "mut_mod_premature_03",
        expectedVersion: 2,
        action: "approve",
        target: { kind: "module", moduleId: "ui-workbench" },
      }),
      3,
      "2026-11-18T06:02:00Z",
    );
  }, (err) => err.reason === "agent_design_ui_mockup_not_confirmed");

  // Confirm UI mockup -> then module approval succeeds!
  state = applyDesignMutation(
    state.content,
    validateDesignMutation({
      ...baseFields,
      mutationKey: "mut_confirm_mock_04",
      expectedVersion: 2,
      action: "confirm_mockup",
      moduleId: "ui-workbench",
    }),
    3,
    "2026-11-18T06:03:00Z",
  );
  assert.equal(state.content.modules[0].uiMockup.status, "confirmed");

  state = applyDesignMutation(
    state.content,
    validateDesignMutation({
      ...baseFields,
      mutationKey: "mut_mod_ok_000005",
      expectedVersion: 3,
      action: "approve",
      target: { kind: "module", moduleId: "ui-workbench" },
    }),
    4,
    "2026-11-18T06:04:00Z",
  );
  assert.equal(state.status, "approved");

  // Live insert parallel module + remove module stitches DAG cleanly
  state = applyDesignMutation(
    state.content,
    validateDesignMutation({
      ...baseFields,
      mutationKey: "mut_add_par_00006",
      expectedVersion: 4,
      action: "add_module",
      module: {
        id: "par-audit",
        title: "并行违禁词检测",
        objective: "扫描敏感词",
        inputContract: ["定稿文稿"],
        outputContract: ["合规结果"],
        boundaries: [],
        acceptance: ["零误放"],
        dependencies: ["ui-workbench"],
        nodeKind: "parallel",
        hasUiPage: false,
      },
    }),
    5,
    "2026-11-18T06:05:00Z",
  );
  assert.equal(state.content.modules.length, 2);
});

test("live workflow canvas service supports edge insertion, parallel branch addition, downstream reaction, and interactive SVG rendering", async () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "mk-wf-repo-"));
  try {
    writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "demo-video-app", description: "AI 视频流水线" }));
    mkdirSync(path.join(repoDir, "src", "ui"), { recursive: true });
    mkdirSync(path.join(repoDir, "src", "engine"), { recursive: true });
    writeFileSync(path.join(repoDir, "src", "ui", "page.js"), "import '../engine/core.js';\nexport const ui = true;\n");
    writeFileSync(path.join(repoDir, "src", "engine", "core.js"), "export const core = true;\n");

    const initial = getOrBuildPrdWorkflowCanvas({ projectRoot: repoDir });
    assert.ok(initial.nodes.length >= 4);

    // Insert parallel UI node -> triggers wireframe fallback when no API key is present
    const afterPar = await mutatePrdWorkflowCanvas({
      projectRoot: repoDir,
      mutation: { action: "add_parallel", title: "并行封面设计台", hasUiPage: true },
      environment: { PATH: "" },
    });
    const inserted = afterPar.nodes.find((n) => n.title === "并行封面设计台");
    assert.ok(inserted);
    assert.equal(inserted.hasUiPage, true);
    assert.equal(inserted.uiMockup.status, "pending");

    // Render interactive canvas component and verify live mutation hooks
    const mutations = [];
    const view = createDynamicPrdWorkflowCanvas({
      doc: fakeDoc,
      workflow: afterPar,
      onSelectNode() {},
      onMutateWorkflow: (m) => mutations.push(m),
    });
    assert.equal(view.dataset.livePrdWorkflowCanvas, "true");
    const confirmBtns = findAll(view, (n) => n.dataset?.uwWfConfirmMockup);
    assert.equal(confirmBtns.length, 1);
    confirmBtns[0].click();
    assert.equal(mutations.at(-1).action, "confirm_mockup");

    const edgePlusBtns = findAll(view, (n) => n.dataset?.uwWfInsertEdge);
    assert.ok(edgePlusBtns.length >= 2);
    edgePlusBtns[0].click();
    assert.equal(mutations.at(-1).action, "insert_on_edge");
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// review #4 block: self-contained (own imports, own helper names) so it merges
// next to any other tests appended to this file.
// ---------------------------------------------------------------------------
import * as review4Prd from "../../src/application/agent/project-architecture-prd-service.mjs";
import * as review4Canvas from "../../src/application/agent/prd-workflow-canvas-service.mjs";

// A checkout shaped like Meta_Kim's own: nine curated modules, every one of them
// with source files and with the test directory its blueprint points at.
function review4CuratedFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "mk-prd-curated-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "meta-kim", description: "fixture" }));
  writeFileSync(path.join(root, "AGENTS.md"), "# Fixture\n");
  for (const [dir, file, text] of [
    ["canonical", "rules.md", "# Rules\n"],
    ["config", "hosts.json", "{}\n"],
    ["src/domain", "model.mjs", "export const model = 1;\n"],
    ["src/data", "store.mjs", "export const store = 1;\n"],
    ["src/application/agent", "agent.mjs", "export const agent = 1;\n"],
    ["src/application/live", "live.mjs", "export const live = 1;\n"],
    ["src/infrastructure", "server.mjs", "export const server = 1;\n"],
    ["src/presentation", "page.mjs", "export const page = 1;\n"],
    ["desktop", "main.rs", "fn main() {}\n"],
    ["desktop/src-tauri", "lib.rs", "pub fn run() {}\n"],
    ["tests/live", "one.test.mjs", "export {};\n"],
  ]) {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, dir, file), text);
  }
  return root;
}

test("review #4: a module whose test directory exists is identified, never completed, and nothing is accepted without acceptance evidence", () => {
  const root = review4CuratedFixture();
  try {
    const prd = review4Prd.discoverProjectArchitecturePrd({ projectRoot: root });
    assert.equal(prd.modules.length, 9);
    for (const module of prd.modules) assert.equal(module.status, "identified", module.id);
    assert.equal(prd.system.status, "identified");
    assert.equal(prd.system.completedModuleCount, 0);
    assert.equal(prd.system.totalModuleCount, 9);
    assert.equal(prd.system.completionBasis, "acceptance_evidence");
    for (const module of prd.modules.filter((item) => item.hasUiPage)) {
      assert.equal(module.uiMockup.status, "pending", `${module.id}: the repository alone cannot confirm a page mockup`);
    }
    for (const module of prd.modules) {
      assert.ok(module.subflow.nodes.every((node) => node.status === "identified"), `${module.id}: its sub-workflow follows the module`);
    }
    assert.doesNotMatch(JSON.stringify(prd), /"status":"(?:completed|partial)"/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review #4: a repository with no discoverable module source is planned, not partly done", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mk-prd-empty-"));
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "empty-app" }));
    const prd = review4Prd.discoverProjectArchitecturePrd({ projectRoot: root });
    assert.equal(prd.modules.length, 1);
    assert.equal(prd.modules[0].status, "planned");
    assert.equal(prd.system.status, "planned");
    assert.equal(prd.system.completedModuleCount, 0);
    assert.equal(prd.system.completionBasis, "acceptance_evidence");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review #4: the desktop module and the system text claim nothing the product cannot back, in plain words", () => {
  const root = review4CuratedFixture();
  try {
    const prd = review4Prd.discoverProjectArchitecturePrd({ projectRoot: root });
    const desktop = prd.modules.find((module) => module.id === "desktop-tauri-shell");
    assert.ok(desktop);
    assert.equal(desktop.title, "实验性 Tauri 桌面壳，需在完整源码检出旁运行");
    const text = JSON.stringify(desktop);
    assert.doesNotMatch(text, /即开即用|双击即用|双击|正式产品级|正式版|独立原生桌面|告别浏览器|防逆向|崩溃自动恢复|像日常桌面办公软件/u);
    for (const fact of [/完整源码检出/u, /本地服务/u, /主窗口/u, /托盘/u, /单实例/u, /尚未/u, /不作为安装包发布/u]) {
      assert.match(text, fact);
    }
    const everything = JSON.stringify(prd);
    assert.doesNotMatch(everything, /经验沉淀|双向绑定|渠道/u, "plain words: no jargon for lessons learned, linking outside chats, or clients");
    assert.doesNotMatch(prd.system.acceptance.join("\n"), /Logo|完整运行图/u, "the removed progress-button line is gone from the system acceptance");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review #4: the plain-word rule also covers the modules inferred for an ordinary repository", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mk-prd-generic-"));
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "ordinary-app" }));
    for (const dir of ["src/server", "src/ui"]) {
      mkdirSync(path.join(root, dir), { recursive: true });
      writeFileSync(path.join(root, dir, "index.mjs"), "export const index = 1;\n");
    }
    const prd = review4Prd.discoverProjectArchitecturePrd({ projectRoot: root });
    assert.ok(prd.modules.length >= 2);
    assert.doesNotMatch(JSON.stringify(prd), /经验沉淀|双向绑定|渠道/u);
    assert.ok(prd.modules.every((module) => module.status === "identified"));
    assert.match(prd.system.boundaries.join("\n"), /验收证据/u, "the boundary states what makes a module complete");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review #4: the canvas service never defaults a node to completed", () => {
  const root = review4CuratedFixture();
  try {
    const canvas = getOrBuildPrdWorkflowCanvas({ projectRoot: root });
    const business = canvas.nodes.filter((node) => node.kind !== "terminal");
    assert.equal(business.length, 9);
    assert.ok(business.every((node) => node.status === "identified"));
    assert.equal(canvas.summary.completedNodes, 0);
    assert.equal(canvas.nodes.find((node) => node.id === "end").status, "identified", "the closing node follows the system status");
    for (const node of business.filter((item) => item.hasUiPage)) assert.equal(node.uiMockup.status, "pending", node.id);

    const bare = review4Prd.buildDefaultSubflowForModule({ id: "bare-module", title: "没有状态的模块", hasUiPage: true });
    assert.ok(bare.nodes.every((node) => node.status === "identified"), "a module that states no status is identified, not completed");
    assert.ok(bare.nodes.filter((node) => node.hasUiPage).every((node) => node.mockupStatus === "pending"));
    const accepted = review4Prd.buildDefaultSubflowForModule({ id: "ok-module", title: "已验收的模块", status: "accepted", hasUiPage: true });
    assert.ok(accepted.nodes.every((node) => node.status === "accepted"));
    assert.ok(accepted.nodes.filter((node) => node.hasUiPage).every((node) => node.mockupStatus === "confirmed"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review #4: a saved canvas counts accepted and verified nodes only, and an upstream change withdraws acceptance downstream", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mk-prd-saved-"));
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "saved-app" }));
    const workflowDir = review4Canvas.ensureWorkflowStateDir(root);
    const node = (id, status) => ({ id, kind: "process", title: id, status, column: 0, hasUiPage: false, uiMockup: null, reacted: false });
    const saved = {
      schemaVersion: review4Canvas.PRD_WORKFLOW_CANVAS_SCHEMA,
      revision: 1,
      projectName: "saved-app",
      nodes: [
        { id: "start", kind: "terminal", title: "开始", status: "completed", column: -1, hasUiPage: false, uiMockup: null },
        node("mod-a", "identified"),
        node("mod-b", "accepted"),
        node("mod-c", "verified"),
        // Statuses an earlier build wrote for modules it had only found in source.
        node("mod-d", "completed"),
        node("mod-e", "partial"),
        { id: "end", kind: "terminal", title: "结束", status: "identified", column: 9, hasUiPage: false, uiMockup: null },
      ],
      edges: [
        { id: "e1", from: "start", to: "mod-a", label: "", kind: "normal" },
        { id: "e2", from: "mod-a", to: "mod-b", label: "", kind: "normal" },
        { id: "e3", from: "mod-b", to: "mod-c", label: "", kind: "normal" },
        { id: "e4", from: "mod-c", to: "end", label: "", kind: "normal" },
      ],
    };
    writeFileSync(path.join(workflowDir, "canvas-state.json"), JSON.stringify(saved));

    const canvas = getOrBuildPrdWorkflowCanvas({ projectRoot: root });
    assert.equal(canvas.summary.completedNodes, 2, "only the accepted node and the verified node are complete");
    assert.deepEqual(
      canvas.nodes.filter((item) => item.kind !== "terminal").map((item) => [item.id, item.status]),
      [["mod-a", "identified"], ["mod-b", "accepted"], ["mod-c", "verified"], ["mod-d", "identified"], ["mod-e", "identified"]],
      "an earlier build's completed and partial are read back as identified",
    );

    const changed = await mutatePrdWorkflowCanvas({
      projectRoot: root,
      mutation: { action: "update_node", nodeId: "mod-a", title: "改过的上游模块" },
    });
    const downstream = (id) => changed.nodes.find((item) => item.id === id);
    assert.equal(downstream("mod-b").status, "identified", "an upstream change withdraws the acceptance it no longer covers");
    assert.equal(downstream("mod-b").reacted, true);
    assert.equal(downstream("mod-c").status, "identified");
    assert.equal(changed.summary.completedNodes, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
