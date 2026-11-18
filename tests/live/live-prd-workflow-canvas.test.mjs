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
