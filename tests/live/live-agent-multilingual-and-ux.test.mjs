import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { translateAgentUi } from "../../src/presentation/live/live-agent-copy.mjs";
import { renderLiveWorkspaceNavigation, renderLiveWorkspaceSurface } from "../../src/presentation/live/live-workspace-view.mjs";
import { buildLivePrdGraph } from "../../src/application/live/live-prd-knowledge-graph.mjs";
import { createPrdKnowledgeGraph } from "../../src/presentation/live/live-prd-knowledge-graph.mjs";
import { LIVE_WORKSPACE_MESSAGES } from "../../src/presentation/live/live-workspace-copy.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("4-locale Agent UI copy translates chrome across en/ja/ko while leaving unknown user text intact", () => {
  for (const lang of ["en", "ja", "ko"]) {
    for (const phrase of [
      "对话与决策",
      "执行流程",
      "知识图谱",
      "Agent 协作",
      "完整运行图",
      "能力与宿主",
      "输入一句话目标",
      "收起侧边栏",
      "最大化右侧画布",
      "最小化右侧画布",
      "流程与模块拓扑图",
      "说说你想完成什么,或直接指出右侧节点的问题...",
      "01 目标确认 · 待开始",
      "子任务 2",
      "已完成 3/6 步",
    ]) {
      const translated = translateAgentUi(phrase, lang);
      assert.notEqual(translated, phrase, `expected ${lang} translation for: ${phrase}`);
    }
    const userGoal = "给第二个跨境店铺配置独立库存预警与客服SOP";
    assert.equal(translateAgentUi(userGoal, lang), userGoal);
  }
});

test("workspace markup exposes split resizers, maximize/minimize controls, and Full Live Graph slot", () => {
  const nav = renderLiveWorkspaceNavigation();
  const surface = renderLiveWorkspaceSurface();
  assert.match(nav, /data-uw-nav-collapse/);
  assert.match(nav, /data-uw-nav-resizer/);
  assert.match(surface, /data-uw-split-resizer/);
  assert.match(surface, /data-uw-pane-toggle="chat-max"/);
  assert.match(surface, /data-uw-pane-toggle="live-min"/);
  assert.match(surface, /data-uw-pane-toggle="live-max"/);
  assert.match(surface, /data-uw-live-mode="live-run"/);
  assert.match(surface, /data-uw-docked-run-slot/);
});

test("PRD knowledge graph exposes zoom controls, reset, maximize toggle, and draggable node handlers", () => {
  class FakeEl {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.dataset = {};
      this.attributes = new Map();
      this.listeners = new Map();
      this.textContent = "";
    }
    append(...items) { this.children.push(...items); }
    get lastChild() { return this.children.at(-1); }
    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    addEventListener(k, fn) { this.listeners.set(k, fn); }
    click() { this.listeners.get("click")?.({}); }
  }
  const doc = { createElement: (t) => new FakeEl(t), createElementNS: (_ns, t) => new FakeEl(t) };
  const walk = (root, pred, out = []) => {
    if (pred(root)) out.push(root);
    for (const c of root.children || []) walk(c, pred, out);
    return out;
  };
  const graph = buildLivePrdGraph({
    architecture: { id: "sys", title: "系统", status: "accepted", moduleIds: ["m1"] },
    modules: [{ id: "m1", title: "模块一", status: "in_progress", dependsOn: [] }],
  });
  const view = createPrdKnowledgeGraph({
    doc,
    graph,
    copy: (k) => LIVE_WORKSPACE_MESSAGES.zh[k] || k,
    onSelect() {},
    onDepthChange() {},
  });
  const zoomIn = walk(view, (n) => n.dataset?.uwKgZoom === "in")[0];
  const zoomReset = walk(view, (n) => n.dataset?.uwKgZoom === "reset")[0];
  const maxBtn = walk(view, (n) => n.dataset?.uwKgMaximize === "true")[0];
  assert.ok(zoomIn && zoomReset && maxBtn);
  assert.equal(zoomReset.textContent, "100%");
  zoomIn.click();
  assert.equal(zoomReset.textContent, "118%");
  maxBtn.click();
  assert.equal(view.dataset.maximized, "true");
  maxBtn.click();
  assert.equal(view.dataset.maximized, "false");

  const nodeGroup = walk(view, (n) => n.tagName === "g" && n.dataset?.livePrdGraphNode === "m1")[0];
  assert.ok(nodeGroup.listeners.has("pointerdown"));
  assert.ok(nodeGroup.listeners.has("pointermove"));
});

test("standalone Tauri v2 + Rust desktop client enforces release hardening, loopback guard, and tray persistence", () => {
  const cargoToml = readFileSync(path.join(repoRoot, "desktop/src-tauri/Cargo.toml"), "utf8");
  assert.match(cargoToml, /strip\s*=\s*true/);
  assert.match(cargoToml, /lto\s*=\s*true/);
  assert.match(cargoToml, /panic\s*=\s*"abort"/);
  assert.doesNotMatch(cargoToml, /features\s*=\s*\[[^\]]*"devtools"/);

  const mainRs = readFileSync(path.join(repoRoot, "desktop/src-tauri/src/main.rs"), "utf8");
  assert.match(mainRs, /windows_subsystem\s*=\s*"windows"/);
  assert.match(mainRs, /http:\/\/127\.0\.0\.1:/);
  assert.match(mainRs, /CREATE_NO_WINDOW/);
  assert.match(mainRs, /tauri_plugin_single_instance/);
  assert.match(mainRs, /TrayIconBuilder/);
  assert.match(mainRs, /RELEASE_SURFACE_GUARD_JS/);
});
