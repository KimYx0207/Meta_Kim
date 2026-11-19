import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { translateAgentUi } from "../../src/presentation/live/live-agent-copy.mjs";
import { renderLiveWorkspaceNavigation, renderLiveWorkspaceSurface } from "../../src/presentation/live/live-workspace-view.mjs";
import { buildLivePrdGraph } from "../../src/application/live/live-prd-knowledge-graph.mjs";
import { createPrdKnowledgeGraph } from "../../src/presentation/live/live-prd-knowledge-graph.mjs";
import { LIVE_WORKSPACE_MESSAGES } from "../../src/presentation/live/live-workspace-copy.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Facts are named after the real checkout directory, which is not always
// "Meta_Kim" (for example /workspace in containers).
const checkoutName = path.basename(realpathSync(repoRoot));

test("4-locale Agent UI copy translates chrome across en/ja/ko while leaving unknown user text intact", () => {
  for (const lang of ["en", "ja", "ko"]) {
    for (const phrase of [
      "对话与决策",
      "执行流程",
      "知识图谱",
      "Agent 协作",
      "完整运行图",
      "能力目录",
      "Subagent 执行 B3",
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

test("Tauri v2 + Rust desktop shell enforces release hardening, loopback guard, tray persistence and single-connection ownership", () => {
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
  // Reconnect/switch: only the newest connect generation may own the child or show errors.
  assert.match(mainRs, /generation: AtomicU64/);
  assert.match(mainRs, /fn show_boot_error_if_current\(/);
  assert.doesNotMatch(
    mainRs.split("fn spawn_and_connect")[1].split("const RELEASE_SURFACE_GUARD_JS")[0],
    /\bshow_boot_error\(/,
    "spawn_and_connect must only report errors through the generation guard",
  );
  // Version and Node requirement come from the root package.json.
  assert.match(mainRs, /env!\("META_KIM_NODE_ENGINE"\)/);
  assert.doesNotMatch(mainRs, /Node\.js >= 20/);
  const tauriConf = JSON.parse(readFileSync(path.join(repoRoot, "desktop/src-tauri/tauri.conf.json"), "utf8"));
  assert.equal(tauriConf.version, "../../package.json");
  // CI compiles the crate with exactly this toolchain; the locked Tauri 2.7 tree needs rustc 1.90.
  assert.match(cargoToml, /rust-version = "1\.90"/);
});

test("compact single-column sidebar CSS, duplicate topbar session guard, and single-project /api/projects catalog work end-to-end", async (t) => {
  const { LIVE_WORKSPACE_CSS } = await import("../../src/presentation/live/live-workspace-styles.mjs");
  const { translateLiveUiCopy } = await import("../../src/presentation/live/live-ui-copy.mjs");
  const { createLiveControlRoomServer } = await import("../../src/infrastructure/live/live-control-room-server.mjs");

  assert.match(LIVE_WORKSPACE_CSS, /--uw-nav-width:\s*176px/);
  assert.match(LIVE_WORKSPACE_CSS, /\.uw-agent-inventory-quicknav\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(LIVE_WORKSPACE_CSS, /\[data-unified-workspace="true"\]:not\(\[data-nav-collapsed="true"\]\)\s+\.topbar-actions\s*>\s*\[data-live-open-sessions\]\s*\{\s*display:\s*none;\s*\}/);
  assert.match(LIVE_WORKSPACE_CSS, /\[data-work-view="repository"\]\s+\.main\s*>\s*\.run-context/);

  assert.equal(translateLiveUiCopy("Registered project", "ja"), "登録済みプロジェクト");
  assert.equal(translateLiveUiCopy("Registered project", "ko"), "등록된 프로젝트");

  const controller = createLiveControlRoomServer({
    projectRoot: repoRoot,
    port: 0,
    globalHub: false,
    enableProjectCatalog: true,
    workspaceEnabled: true,
  });
  t.after(() => controller.close());
  const address = await controller.start();
  const res = await fetch(`${address.url}/api/projects`);
  assert.equal(res.status, 200);
  const catalog = await res.json();
  assert.ok(Array.isArray(catalog.projects) && catalog.projects.length >= 1, "bound project must appear in /api/projects");
  assert.ok(catalog.projects.some((p) => p.displayName === "Meta_Kim" || p.projectId === catalog.selected.projectId));
});

test("project architecture PRD baseline extracts Level-1 system framework and Level-2 acyclic module organization without leaking host paths", async () => {
  const { discoverProjectArchitecturePrd, PROJECT_ARCHITECTURE_PRD_SCHEMA } = await import("../../src/application/agent/project-architecture-prd-service.mjs");
  const prd = discoverProjectArchitecturePrd({ projectRoot: repoRoot });
  assert.ok(prd, "should extract architecture PRD for Meta_Kim");
  assert.equal(prd.schemaVersion, PROJECT_ARCHITECTURE_PRD_SCHEMA);
  assert.equal(prd.recordOrigin, "repository_architecture_baseline");
  assert.equal(prd.approvalClaimed, false);
  assert.equal(prd.dagValid, true, "measured cross-module dependencies must form a valid acyclic DAG");
  assert.equal(prd.system.title, "Meta_Kim · 系统框架");
  // Finding a module's source is not accepting it: with no acceptance evidence
  // behind any module, nothing in the baseline may read as complete.
  assert.equal(prd.system.status, "identified");
  assert.equal(prd.system.completedModuleCount, 0);
  assert.equal(prd.system.completionBasis, "acceptance_evidence");
  assert.ok(prd.modules.every((module) => module.status === "identified"));
  assert.ok(Array.isArray(prd.system.layers) && prd.system.layers.length >= 4);
  assert.ok(prd.modules.length >= 8, `expected >= 8 subsystems, got ${prd.modules.length}`);
  const serialized = JSON.stringify(prd);
  assert.doesNotMatch(serialized, /[A-Za-z]:\\\\/u, "must never leak raw Windows absolute paths");
  const presentation = prd.modules.find((m) => m.id === "presentation-workspace");
  assert.ok(presentation, "presentation-workspace subsystem must be discovered");
  assert.ok(Array.isArray(presentation.features) && presentation.features.length >= 2);
  assert.ok(presentation.dependencies.includes("app-live-projection"),
    "presentation layer must reflect its real import dependency on app-live-projection");
});

test("repository facts, bidirectional agent session discovery, top flow ribbon, primary nav 仓库, and visible channel picker respect governance boundaries", async () => {
  const {
    inspectRepositoryFacts,
    discoverBidirectionalAgentSessions,
    AGENT_REPOSITORY_FACTS_SCHEMA,
    AGENT_BINDINGS_SCHEMA,
  } = await import("../../src/application/agent/agent-repository-and-binding-service.mjs");
  const { renderLiveWorkspaceNavigation, renderLiveWorkspaceSurface } = await import("../../src/presentation/live/live-workspace-view.mjs");
  const { renderLiveControlRoomPage } = await import("../../src/presentation/live/live-control-room-page.mjs");

  const pageHtml = renderLiveControlRoomPage();
  assert.match(pageHtml, /data-uw-top-flow/, "Single-row global execution progress bar must sit right below topbar");
  const navHtml = renderLiveWorkspaceNavigation();
  assert.match(navHtml, /data-uw-view="repository"[^>]*>.*仓库/s, "Repository view must sit in primary left navigation");
  const surfaceHtml = renderLiveWorkspaceSurface();
  assert.match(surfaceHtml, /data-uw-chat-host/, "Visible channel picker must be mounted in chat composer");
  assert.match(surfaceHtml, /data-uw-open-binding/, "Bidirectional binding trigger must be mounted in chat header");
  assert.match(surfaceHtml, /data-uw-chat-switch-repo/, "Repository switcher button must be mounted in chat scope bar");

  const facts = inspectRepositoryFacts({ projectRoot: repoRoot, startupProjectRoot: repoRoot });
  assert.equal(facts.schemaVersion, AGENT_REPOSITORY_FACTS_SCHEMA);
  assert.equal(facts.projectName, checkoutName);
  assert.equal(facts.isExecutionBoundRepo, true);
  assert.equal(facts.hasGit, true);
  assert.ok(facts.branch, "Git branch must be measured");
  assert.doesNotMatch(JSON.stringify(facts), /[A-Za-z]:\\\\/u, "Repository facts must not leak raw host paths");

  const bindings = await discoverBidirectionalAgentSessions({ projectRoot: repoRoot, startupProjectRoot: repoRoot });
  assert.equal(bindings.schemaVersion, AGENT_BINDINGS_SCHEMA);
  assert.equal(bindings.projectName, checkoutName);
  assert.equal(bindings.bidirectionalModes.forwardCallFromApp, true);
  assert.equal(bindings.bidirectionalModes.reverseAttachFromExternalAgent, true);
  assert.ok(Array.isArray(bindings.enrolledRuntimes));
  assert.ok(Array.isArray(bindings.externalSessions));
  assert.doesNotMatch(JSON.stringify(bindings), /[A-Za-z]:\\\\/u, "Session binding discovery must not leak raw host paths");
});
