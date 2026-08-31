import test from "node:test";
import assert from "node:assert/strict";

import {
  LIVE_SNAPSHOT_SCHEMA_VERSION,
  renderLiveControlRoomPage,
} from "../../src/presentation/live/live-control-room-page.mjs";

function modalBehaviorHarness() {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const modalStart = html.indexOf("  function modalBackgroundElements()");
  const modalEnd = html.indexOf("\n  function updateMinimap()", modalStart);
  const keydownStart = html.indexOf('  app.addEventListener("keydown", (event) => {', modalEnd);
  const keydownEnd = html.indexOf("\n  replayPlay?.addEventListener", keydownStart);
  assert.ok(modalStart >= 0 && modalEnd > modalStart, "modal controller must remain in the shipped client script");
  assert.ok(keydownStart >= 0 && keydownEnd > keydownStart, "modal keyboard binding must remain in the shipped client script");

  const document = {
    activeElement: null,
    skipLink: null,
    querySelector(selector) {
      return selector === ".skip-link" ? this.skipLink : null;
    },
  };
  class FakeElement {
    constructor(name, { dialog = false } = {}) {
      this.name = name;
      this.dialog = dialog;
      this.hidden = false;
      this.inert = false;
      this.children = [];
      this.focusables = [];
      this.attributes = new Map();
      this.focusCount = 0;
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }

    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    removeAttribute(name) {
      this.attributes.delete(name);
    }

    matches(selector) {
      return selector === "[data-live-dialog]" && this.dialog;
    }

    querySelector() {
      return this.focusables[0] || null;
    }

    querySelectorAll() {
      return this.focusables;
    }

    contains(element) {
      return element === this || this.focusables.includes(element);
    }

    focus() {
      this.focusCount += 1;
      document.activeElement = this;
    }

    blur() {
      if (document.activeElement === this) document.activeElement = null;
    }
  }

  const app = new FakeElement("app");
  const skipLink = new FakeElement("skip-link");
  const background = new FakeElement("background");
  const preservedBackground = new FakeElement("preserved-background");
  preservedBackground.inert = true;
  preservedBackground.setAttribute("aria-hidden", "legacy");
  const sessionsDialog = new FakeElement("sessions", { dialog: true });
  const helpDialog = new FakeElement("help", { dialog: true });
  const infoDialog = new FakeElement("info", { dialog: true });
  const first = new FakeElement("first");
  const last = new FakeElement("last");
  sessionsDialog.focusables = [first, last];
  sessionsDialog.setAttribute("aria-hidden", "true");
  sessionsDialog.hidden = true;
  helpDialog.setAttribute("aria-hidden", "true");
  helpDialog.hidden = true;
  infoDialog.setAttribute("aria-hidden", "true");
  infoDialog.hidden = true;
  app.children = [background, preservedBackground, sessionsDialog, helpDialog, infoDialog];
  document.skipLink = skipLink;
  app.addEventListener = (type, handler) => {
    if (type === "keydown") app.keydownHandler = handler;
  };

  const modalSource = html.slice(modalStart, modalEnd);
  const keydownSource = html.slice(keydownStart, keydownEnd);
  const createController = new Function(
    "document",
    "app",
    "sessionsDialog",
    "helpDialog",
    "infoDialog",
    "HTMLInputElement",
    "HTMLSelectElement",
    "HTMLTextAreaElement",
    `${String.raw`
      let dialogOpener = null;
      let activeDialog = null;
      const modalBackgroundState = new Map();
      const FOCUSABLE_DIALOG_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
      let selectedNodeId = null;
      const updateSelectedNodeVisuals = () => {};
      const setInspectorOpen = () => {};
      ${modalSource}
      ${keydownSource}
      return {
        setDialogOpen,
        trapDialogFocus,
        keydownHandler: () => app.keydownHandler,
        activeDialog: () => activeDialog,
      };
    `}`,
  );
  const controller = createController(
    document,
    app,
    sessionsDialog,
    helpDialog,
    infoDialog,
    class FakeInput extends FakeElement {},
    class FakeSelect extends FakeElement {},
    class FakeTextArea extends FakeElement {},
  );
  return {
    controller,
    document,
    skipLink,
    background,
    preservedBackground,
    sessionsDialog,
    first,
    last,
    FakeElement,
  };
}

const snapshotFixture = {
  schemaVersion: LIVE_SNAPSHOT_SCHEMA_VERSION,
  source: {
    kind: "local",
    label: "Meta_Kim local observer",
    generatedAt: "2026-08-24T08:00:00.000Z",
  },
  run: {
    id: "run-demo-42",
    title: "Ship the governed execution spine",
    status: "live",
    stage: "Execution",
    startedAt: "2026-08-24T07:58:00.000Z",
    updatedAt: "2026-08-24T08:00:00.000Z",
  },
  nodes: [
    {
      id: "critical",
      label: "Critical",
      status: "completed",
      roleDisplayName: "conductor",
      agent: "meta-conductor",
      runtime: "codex",
      summary: "Intent locked",
    },
    {
      id: "execution",
      label: "Execution",
      status: "running",
      roleDisplayName: "frontend",
      agent: "frontend-developer",
      runtime: "codex",
      summary: "Rendering the control room",
    },
  ],
  edges: [{ from: "critical", to: "execution", status: "active" }],
  evidence: [{ id: "ev-1", label: "Snapshot observed", status: "verified", nodeId: "execution" }],
  replay: {
    events: [
      { id: "r-1", timestamp: "2026-08-24T07:58:00.000Z", nodeId: "critical", label: "Critical completed" },
      { id: "r-2", timestamp: "2026-08-24T07:59:00.000Z", nodeId: "execution", label: "Execution started" },
    ],
  },
  permissions: { readOnly: true, canMutate: false },
};

test("renders a complete local control-room shell with no external assets", () => {
  const html = renderLiveControlRoomPage();

  assert.match(html, /^<!doctype html>/iu);
  assert.match(html, /<html[^>]+lang="zh-CN"/iu);
  assert.match(html, /<main\b/iu);
  assert.match(html, /data-snapshot-endpoint="\/api\/snapshot"/u);
  assert.match(html, /data-events-endpoint="\/api\/events"/u);
  assert.match(html, /data-projects-endpoint="\/api\/projects"/u);
  assert.match(html, /data-replay-endpoint="\/api\/replay"/u);
  assert.match(html, /rel="icon" href="data:image\/svg\+xml;base64,/u);
  assert.doesNotMatch(html, /<(?:script|link|img)[^>]+(?:https?:)?\/\//iu);
  assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:unpkg|jsdelivr|fonts\.googleapis)/iu);
});

test("defaults to Chinese and provides a persistent English language switch", () => {
  const html = renderLiveControlRoomPage();

  assert.match(html, /<title>Meta_Kim Live · 控制中心<\/title>/u);
  assert.match(html, /data-live-language-toggle/u);
  assert.match(html, /data-i18n-en="Execution graph" data-i18n-zh="实时运行图">实时运行图/u);
  assert.match(html, /data-i18n-en="Inspector" data-i18n-zh="检查器">检查器/u);
  assert.match(html, /data-i18n-en="Replay timeline" data-i18n-zh="回放时间线">回放时间线/u);
  assert.match(html, /LANGUAGE_STORAGE_KEY\s*=\s*"meta-kim-live-language"/u);
  assert.match(html, /localStorage\?\.getItem\(LANGUAGE_STORAGE_KEY\)\s*===\s*"en"/u);
  assert.match(html, /localStorage\?\.setItem\(LANGUAGE_STORAGE_KEY, currentLanguage\)/u);
  assert.match(html, /currentLanguage\s*=\s*currentLanguage\s*===\s*"zh"\s*\?\s*"en"\s*:\s*"zh"/u);
  assert.match(html, /window\.location\.reload\(\)/u);
});

test("keeps snapshot values out of markup and safely seeds JSON for the text-only renderer", () => {
  const hostile = {
    ...snapshotFixture,
    run: {
      ...snapshotFixture.run,
      title: "</script><img src=x onerror=alert(1)> & <b>untrusted</b>",
    },
  };
  const html = renderLiveControlRoomPage({ snapshot: hostile });

  assert.equal((html.match(/<img\b/giu) || []).length, 1, "only the bundled brand mark may render as an image");
  assert.match(html, /<img class="brand-mark" src="\/assets\/meta-kim-k-mark\.png" alt=""/u);
  assert.doesNotMatch(html, /onerror\s*=/iu);
  assert.doesNotMatch(html, /<b>untrusted<\/b>/iu);
  assert.match(html, /live-initial-snapshot/iu);
  assert.match(html, /\\u003C\/script\\u003E/iu);
  assert.doesNotMatch(html, /\.innerHTML\b/iu);
  assert.doesNotMatch(html, /\beval\s*\(/iu);
  assert.match(html, /textContent\s*=/u);
});

test("wires read-only snapshot polling and server-sent events", () => {
  const html = renderLiveControlRoomPage();

  assert.match(html, /fetch\(endpointForSelection\(snapshotEndpoint\)/iu);
  assert.match(html, /new\s+EventSource\(endpointForSelection\(eventsEndpoint\)\)/iu);
  assert.match(html, /addEventListener\(["']snapshot["']/iu);
  assert.match(html, /addEventListener\(["']message["']/iu);
  assert.match(html, /eventSource\.close\(\)/iu);
  assert.match(html, /AbortController/iu);
  assert.doesNotMatch(html, /fetch\([^)]*method\s*:\s*["'](?:POST|PUT|PATCH|DELETE)/iu);
  assert.match(html, /Array\.isArray\(input\.replay\)/u);
  assert.match(html, /active.*live|live.*active/su);
  assert.match(html, /if \(!snapshot\.run\)/u);
});

test("includes graph, evidence drawer, and replay controls", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  for (const marker of [
    "data-live-graph",
    "data-live-edge-layer",
    "data-live-node-list",
    "data-evidence-drawer",
    "data-replay-timeline",
    "data-replay-range",
    "data-replay-play",
    "renderGraph",
    "renderEvidence",
    "renderReplay",
  ]) {
    assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), marker);
  }
  assert.match(html, /aria-controls="live-inspector"/iu);
  assert.match(html, /role="list"/iu);
  assert.match(html, /<svg\b[^>]*aria-hidden="true"/iu);
  assert.match(html, /data\.replayStatus|dataset\.replayStatus/u);
});

test("keeps event progress and the current stage in the compact status bar with a replay-backed stage rail", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /data-live-run-progress/u);
  assert.match(html, /data-live-run-workers/u);
  assert.match(html, /class="status-bar"/u);
  assert.match(html, /data-live-run-stage/u);
  assert.match(html, /data-live-stage-rail|function renderStageRail\(/u);
  assert.doesNotMatch(html, /class="[^"]*run-hero|class="[^"]*run-facts/u);
  assert.match(html, /selectedSession\.currentStage/u);
  assert.match(html, /selectedSession\.active\s*\?\s*"live"/u);
  assert.match(html, /"Event " \+ snapshot\.run\.eventIndex \+ " of " \+ snapshot\.run\.eventCount/u);
  assert.match(html, /eventCount\s*=\s*Math\.max\(replay\.length/u);
});

test("uses a canvas-first control-room hierarchy with an on-demand inspector and integrated transport", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /<header class="topbar"[\s\S]*data-live-open-sessions[\s\S]*<\/header>/u);
  assert.match(html, /class="workspace-grid"[^>]*data-inspector-open="false"[\s\S]*class="graph-panel"[\s\S]*class="replay-panel replay-dock"[\s\S]*class="status-bar"/u);
  assert.match(html, /data-live-sessions-dialog/u);
  assert.match(html, /data-live-help-dialog/u);
  assert.match(html, /data-live-info-dialog/u);
  assert.match(html, /data-live-inspector[^>]+data-open="false"/u);
  assert.match(html, /data-live-inspector-close/u);
  assert.match(html, /function setInspectorOpen\(/u);
  assert.match(html, /setInspectorOpen\(true\)/u);
  assert.match(html, /function repositionCameraAfterInspector\(active\)/u);
  assert.match(html, /requestAnimationFrame\(\(\)\s*=>\s*window\.requestAnimationFrame\(reposition\)\)/u);
  assert.match(html, /workspace\?\.addEventListener\("transitionend", reposition, \{ once: true \}\)/u);
  assert.match(html, /function reconcileCamera\([\s\S]{0,700}camera\.scale < \.68[\s\S]{0,160}centerGraphNode\(followTargetId\(\)\)/u);
  assert.match(html, /new ResizeObserver\(\(\)\s*=>\s*reconcileCamera\(\)\)/u);
  assert.match(html, /if \(firstSnapshot\) \{\s*setInspectorOpen\(false\)/u);
  assert.doesNotMatch(html, /setInspectorOpen\(currentWorkView === "run"[\s\S]{0,160}Boolean\(selectedNodeId\)\)/u);
  assert.match(html, /identity\.addEventListener\("click", \(\) => selectNode\(node\.id, \{ inspectorTab: "summary" \}\)\)/u);
  assert.match(html, /selectNode\(node\.id, \{ inspectorTab: record\.tab \}\)/u);
  assert.match(html, /evidenceToggle\?\.addEventListener\("click", \(\) => setInspectorOpen\(evidencePanel\?\.dataset\.open !== "true"\)\)/u);
  assert.match(html, /evidenceClose\?\.addEventListener\("click", \(\) => setInspectorOpen\(false\)\)/u);
  assert.match(html, /event\.key === "Escape"[\s\S]{0,260}setInspectorOpen\(false\)/u);
  assert.match(html, /app\.addEventListener\("pointerdown"[\s\S]{0,300}evidencePanel\.contains\(target\)[\s\S]{0,180}setInspectorOpen\(false\)/u);
  assert.match(html, /\.evidence-panel \.panel-header\s*\{[^}]*position:\s*sticky[^}]*z-index:\s*3[^}]*background:\s*var\(--panel\)/su);
  assert.match(html, /\.evidence-panel \[data-live-inspector-close\]\s*\{[^}]*width:\s*36px[^}]*height:\s*36px[^}]*place-items:\s*center/su);
  assert.match(html, /\.workspace-grid\[data-inspector-open="true"\]\s*\{[^}]*minmax\(0,\s*1fr\)[^}]*clamp\(320px,\s*26vw,\s*420px\)/su);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*\.evidence-panel\s*\{[^}]*position:\s*fixed/su);
  assert.match(html, /\.graph-panel\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)\s*116px\s*28px/su);
  assert.match(html, /<img class="brand-mark" src="\/assets\/meta-kim-k-mark\.png" alt=""[^>]*>/u);
  assert.match(html, /glyph\.setAttribute\("class", "node-glyph"\)/u);
  assert.match(html, /class="root-entry-path"|rootPath\.setAttribute\("class", "root-entry-path"\)/u);
  assert.match(html, /class="replay-ticks"/u);
  assert.match(html, /stageIconPaths/u);
  assert.match(html, /class="graph-canvas-header"[\s\S]*class="graph-canvas-title"/u);
});

test("is accessible by keyboard and respects reduced motion", () => {
  const html = renderLiveControlRoomPage();

  assert.match(html, /skip-to-content/iu);
  assert.match(html, /aria-live="polite"/iu);
  assert.match(html, /aria-label="Play replay"/iu);
  assert.match(html, /aria-label="Replay position"/iu);
  assert.match(html, /keydown/iu);
  assert.match(html, /ArrowLeft/iu);
  assert.match(html, /ArrowRight/iu);
  assert.match(html, /Home/iu);
  assert.match(html, /End/iu);
  assert.match(html, /prefers-reduced-motion\s*:\s*reduce/iu);
  assert.match(html, /focus-visible/iu);
  assert.match(html, /overflow-wrap:\s*anywhere/iu);
  assert.match(html, /event\.defaultPrevented \|\| typing \|\| interactive/u);
  assert.match(html, /button, a, \[role="button"\], \[role="option"\], \[contenteditable="true"\]/u);
  assert.match(html, /dialogActive[\s\S]{0,120}event\.defaultPrevented \|\| typing \|\| interactive \|\| dialogActive/u);
});

test("does not expose mutation affordances in the read-only MVP", () => {
  const renderedHtml = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  // The read-only contract is about what the browser receives in its initial
  // DOM. Conditional control templates may remain in the inert client script.
  const initialMarkup = renderedHtml.slice(0, renderedHtml.indexOf("<script"));
  const html = initialMarkup;

  assert.doesNotMatch(html, /<button[^>]+(?:pause|resume|handoff|cancel|stop|retry)/iu);
  assert.doesNotMatch(html, /(?:POST|PUT|PATCH|DELETE)\s*:/iu);
  assert.doesNotMatch(html, /\b(?:handoff|resume run|pause run)\b(?![^<]*coming next)/iu);
  assert.match(html, /read-only|read only/iu);
});

test("escapes custom endpoint attributes without changing the runtime contract", () => {
  const html = renderLiveControlRoomPage({
    snapshotEndpoint: "/api/snapshot?view=control-room&x=\"quoted\"",
    eventsEndpoint: "/api/events?channel=live&x=<unsafe>",
    projectsEndpoint: "/api/projects?source=registry&x=<unsafe>",
    replayEndpoint: "/api/replay?view=timeline&x=\"quoted\"",
  });

  assert.match(html, /data-snapshot-endpoint="\/api\/snapshot\?view=control-room&amp;x=&quot;quoted&quot;"/u);
  assert.match(html, /data-events-endpoint="\/api\/events\?channel=live&amp;x=&lt;unsafe&gt;"/u);
  assert.match(html, /data-projects-endpoint="\/api\/projects\?source=registry&amp;x=&lt;unsafe&gt;"/u);
  assert.match(html, /data-replay-endpoint="\/api\/replay\?view=timeline&amp;x=&quot;quoted&quot;"/u);
  assert.doesNotMatch(html, /data-(?:snapshot|events)-endpoint="[^"]*<|data-(?:snapshot|events)-endpoint="[^"]*"[^>]*\bon/iu);
});

test("renders an accessible project and run-record selector with explicit identity guidance", () => {
  const html = renderLiveControlRoomPage();

  assert.match(html, /data-live-project-select/u);
  assert.match(html, /data-live-session-select/u);
  assert.match(html, /aria-label="Choose a Meta_Kim project"/u);
  assert.match(html, /aria-label="Choose a governed run record"/u);
  assert.match(html, /data-live-session-search/u);
  assert.match(html, /这里显示的是 Meta_Kim 运行记录，不是聊天列表/u);
  assert.match(html, /未关联聊天的运行记录/u);
  assert.match(html, /还没有可识别的聊天记录/u);
  assert.match(html, /showUnlinkedSessions = false/u);
  assert.match(html, /liveShowUnlinked/u);
  assert.match(html, /\.dialog-card\s*\{[^}]*overflow:\s*hidden[^}]*border-radius:/su);
  assert.match(html, /\.dialog-body\s*\{[^}]*overflow:\s*auto[^}]*scrollbar-gutter:\s*stable/su);
  assert.match(html, /data-live-hub-status[^>]+aria-live="polite"/u);
  assert.match(html, /No Meta_Kim projects are registered yet/u);
  assert.match(html, /no governed runs yet/iu);
  assert.match(html, /Hub never scans your disk/u);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*\.hub-switcher[^}]*grid-template-columns:\s*1fr/u);
});

test("loads the Hub catalog, honors deep links, and reconnects scoped read endpoints", () => {
  const html = renderLiveControlRoomPage();

  assert.match(html, /fetch\(projectsEndpoint/iu);
  assert.match(html, /selectionFromLocation\(\)/u);
  assert.match(html, /new URL\(window\.location\.href\)\.searchParams/u);
  assert.match(html, /new URLSearchParams\(url\.search\)/u);
  assert.match(html, /params\.set\("projectId", selectedProjectId\)/u);
  assert.match(html, /params\.set\("runId", selectedRunId\)/u);
  assert.match(html, /history\.replaceState/u);
  assert.match(html, /fetch\(endpointForSelection\(replayEndpoint\)/u);
  assert.match(html, /disconnectEvents\(\)/u);
  assert.match(html, /abortController\?\.abort\(\)/u);
  assert.match(html, /connectEvents\(generation\)/u);
  assert.match(html, /projectSelect\?\.addEventListener\("change"/u);
  assert.match(html, /sessionSelect\?\.addEventListener\("change"/u);
  assert.match(html, /loadProjectCatalog\(\{ refresh: true \}\)/u);
  assert.match(html, /document\.visibilityState === "visible"/u);
  assert.match(html, /clearInterval\(catalogRefreshTimer\)/u);
  assert.match(html, /const generation = \+\+selectionGeneration/u);
  assert.match(html, /generation !== selectionGeneration/u);
  assert.match(html, /pendingSnapshot = null/u);
  assert.match(html, /snapshotRequestInFlight = false/u);
  assert.match(html, /selectedNodeId = null/u);
});

test("renders catalog labels through bounded text-only DOM operations", () => {
  const html = renderLiveControlRoomPage();

  assert.match(html, /rawProjects\.slice\(0, 128\)/u);
  assert.match(html, /rawSessions\.slice\(0, 256\)/u);
  assert.match(html, /option\.textContent\s*=/u);
  assert.match(html, /option\.value\s*=/u);
  assert.match(html, /safeIdentifier/u);
  assert.match(html, /formatSessionTime\(session\.updatedAt\)/u);
  assert.match(html, /sessionShortId\(session\)/u);
  assert.match(html, /sessionIsIdentified\(session\)/u);
  assert.doesNotMatch(html, /\.innerHTML\b/iu);
  assert.doesNotMatch(html, /projectsEndpoint\s*\+|eventsEndpoint\s*\+|snapshotEndpoint\s*\+/u);
});

test("falls back from unsafe endpoints and circular initial snapshots", () => {
  const circular = {};
  circular.self = circular;
  const html = renderLiveControlRoomPage({
    snapshot: circular,
    snapshotEndpoint: "https://attacker.example/snapshot",
    eventsEndpoint: "//attacker.example/events",
    projectsEndpoint: "https://attacker.example/projects",
    replayEndpoint: "//attacker.example/replay",
  });
  assert.match(html, /data-snapshot-endpoint="\/api\/snapshot"/u);
  assert.match(html, /data-events-endpoint="\/api\/events"/u);
  assert.match(html, /data-projects-endpoint="\/api\/projects"/u);
  assert.match(html, /data-replay-endpoint="\/api\/replay"/u);
  assert.match(html, /id="live-initial-snapshot">null<\/script>/u);
});

test("exposes local share actions and the /api/share read path without upload affordances", () => {
  const html = renderLiveControlRoomPage({
    shareEndpoint: "/api/share?surface=public",
  });

  assert.match(html, /data-share-endpoint="\/api\/share\?surface=public"/u);
  assert.match(html, /data-live-share-export-json/u);
  assert.match(html, /data-live-share-copy-pr/u);
  assert.match(html, /data-live-share-copy-readme/u);
  assert.match(html, /Export JSON/iu);
  assert.match(html, /Copy PR card/iu);
  assert.match(html, /README embed/iu);
  assert.match(html, /navigator\.clipboard\.writeText/iu);
  assert.match(html, /loadShareText\("markdown"\)/u);
  assert.match(html, /loadShareText\("readme"\)/u);
  assert.doesNotMatch(html, /readmeEmbedFromArtifact|safeShareText/iu);
  assert.match(html, /meta-kim-live-share-status/iu);
  assert.doesNotMatch(html, /data-live-control-action="(?:pause|resume|reassign|handoff)"/iu);
  assert.doesNotMatch(html, /fetch\([^)]*method\s*:\s*["'](?:POST|PUT|PATCH|DELETE)/iu);
});

test("renders continuation controls only when every command capability is explicitly available", () => {
  const capabilities = {
    pause: { available: true },
    resume: { available: true },
    reassign: { available: true },
    handoff: { available: true },
  };
  const enabled = renderLiveControlRoomPage({
    snapshot: { ...snapshotFixture, control: { controlEnabled: true, controlHeader: "x-meta-kim-control-token", controlToken: "local-control-token-123456", capabilities } },
    controlEnabled: true,
    commandCapabilities: capabilities,
    controlHeader: "x-meta-kim-control-token",
    controlToken: "local-control-token-123456",
  });
  for (const action of ["pause", "resume", "reassign", "handoff"]) {
    assert.match(enabled, new RegExp(`data-live-control-action="${action}"`, "u"));
  }
  assert.match(enabled, /confirm/iu);
  assert.match(enabled, /aria-busy/iu);
  assert.match(enabled, /control.*error|error.*control/isu);
  assert.match(enabled, /control.*result|result.*control/isu);
  assert.match(enabled, /\/api\/commands/iu);

  const incomplete = renderLiveControlRoomPage({
    snapshot: { ...snapshotFixture, control: { controlEnabled: true, controlHeader: "x-meta-kim-control-token", controlToken: "local-control-token-123456", capabilities: { pause: true, resume: true, reassign: true } } },
    controlEnabled: true,
    commandCapabilities: { pause: true, resume: true, reassign: true },
    controlHeader: "x-meta-kim-control-token",
    controlToken: "local-control-token-123456",
  });
  assert.doesNotMatch(incomplete, /data-live-control-action="(?:pause|resume|reassign|handoff)"/iu);
});

test("keeps control and share values in text-safe DOM APIs and preserves reduced-motion hooks", () => {
  const html = renderLiveControlRoomPage({
    snapshot: {
      ...snapshotFixture,
      run: { ...snapshotFixture.run, title: "</script><img src=x onerror=alert(1)>" },
      control: {
        controlEnabled: true,
        controlHeader: "x-meta-kim-control-token",
        controlToken: "local-control-token-123456",
        capabilities: {
          pause: true,
          resume: true,
          reassign: true,
          handoff: true,
        },
      },
    },
    controlEnabled: true,
    commandCapabilities: { pause: true, resume: true, reassign: true, handoff: true },
    controlHeader: "x-meta-kim-control-token",
    controlToken: "local-control-token-123456",
  });
  assert.doesNotMatch(html, /\.innerHTML\b/iu);
  assert.match(html, /textContent\s*=/u);
  assert.match(html, /prefers-reduced-motion\s*:\s*reduce/iu);
  assert.match(html, /aria-live="(?:polite|assertive)"/iu);
  assert.match(html, /button[^>]+type="button"/iu);
});

test("requires the fixed control header and a bounded token before exposing controls", () => {
  const capabilities = {
    pause: true,
    resume: true,
    reassign: true,
    handoff: true,
  };
  const missingToken = renderLiveControlRoomPage({
    snapshot: { ...snapshotFixture, control: { controlEnabled: true, controlHeader: "x-meta-kim-control-token", capabilities } },
    controlEnabled: true,
    commandCapabilities: capabilities,
    controlHeader: "x-meta-kim-control-token",
  });
  assert.doesNotMatch(missingToken, /data-live-control-action="(?:pause|resume|reassign|handoff)"/iu);

  const wrongHeader = renderLiveControlRoomPage({
    snapshot: { ...snapshotFixture, control: { controlEnabled: true, controlHeader: "authorization", controlToken: "local-control-token-123456", capabilities } },
    controlEnabled: true,
    commandCapabilities: capabilities,
    controlHeader: "authorization",
    controlToken: "local-control-token-123456",
  });
  assert.doesNotMatch(wrongHeader, /data-live-control-action="(?:pause|resume|reassign|handoff)"/iu);

  const hostileToken = renderLiveControlRoomPage({
    snapshot: { ...snapshotFixture, control: { controlEnabled: true, controlHeader: "x-meta-kim-control-token", controlToken: "</script><img src=x>", capabilities } },
  });
  assert.doesNotMatch(hostileToken, /data-live-control-action="(?:pause|resume|reassign|handoff)"/iu);
  assert.doesNotMatch(hostileToken, /<\/script><img src=x>/iu);

  const escapedToken = renderLiveControlRoomPage({
    snapshot: { ...snapshotFixture, control: { controlEnabled: true, controlHeader: "x-meta-kim-control-token", controlToken: "safe-token-123456=", capabilities } },
  });
  assert.match(escapedToken, /safe-token-123456\\u003D/u);
  assert.doesNotMatch(escapedToken, /safe-token-123456=/u);
});

test("uses a compact, zoomable DAG canvas with a minimap and fit controls", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  for (const marker of [
    "data-live-graph-viewport",
    "data-live-graph-scene",
    "data-live-graph-minimap",
    "data-live-minimap-viewport",
    "data-live-graph-fit",
    "data-live-graph-zoom-in",
    "data-live-graph-zoom-out",
    "data-live-graph-layout",
    "layoutGraph",
    "updateCamera",
  ]) {
    assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\[\]\\]/gu, "\\$&"), "u"), marker);
  }
  assert.match(html, /graphScene\.style\.transform/u);
  assert.match(html, /data-live-graph-minimap/iu);
  assert.match(html, /dataset\.semanticZoom\s*=\s*camera\.scale\s*<\s*\.42\s*\?\s*"cell"\s*:\s*"card"/u);
  assert.match(html, /const minimumLegibleScale\s*=\s*width\s*<=\s*1024\s*\?\s*1\s*:\s*\.68/u);
  assert.match(html, /Math\.max\(minimumLegibleScale,/u);
  assert.match(html, /const wholeGraphFits\s*=\s*fittedScale\s*>=\s*minimumLegibleScale/u);
  assert.match(html, /wholeGraphFits\s*\?\s*\(width\s*-\s*graphState\.bounds\.width\s*\*\s*scale\)\s*\/\s*2\s*:\s*padding/u);
});

test("draws curved status-aware edges and a live flow animation with reduced-motion fallback", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /createElementNS\(["']http:\/\/www\.w3\.org\/2000\/svg["'],\s*["']path["']\)/u);
  assert.match(html, /edge-running/iu);
  assert.match(html, /edge-failed/iu);
  assert.match(html, /edge-queued/iu);
  assert.match(html, /const stageFocusState\s*=\s*executionRelation\s*&&\s*snapshot\.run\?\.active[\s\S]{0,180}targetState\s*===\s*"active"\s*\?\s*"live"\s*:\s*"none"/u);
  assert.match(html, /EXECUTION_EDGE_KINDS\.has\(edge\.kind \|\| "sequence"\)/u);
  assert.match(html, /executionRelation \? nodeClass\(edge\.status\) : "structural"/u);
  assert.match(html, /path\.dataset\.liveFocus\s*=\s*stageFocusState/u);
  assert.match(html, /\.edge-flow-glow\[data-stage-focus="recorded"\][^{]*\{[^}]*stroke:\s*#d8a84e[^}]*filter:\s*blur\(3px\)/su);
  assert.match(html, /\.edge-flow-tracer\[data-stage-focus="recorded"\][^{]*\{[^}]*animation:\s*stage-route-flow/su);
  assert.match(html, /\.edge-flow-tracer\[data-stage-focus="live"\][^{]*\{[^}]*animation:\s*live-flow/su);
  assert.match(html, /createElementNS\("http:\/\/www\.w3\.org\/2000\/svg", "animateMotion"\)/u);
  assert.match(html, /!reducedMotion\.matches/u);
  assert.match(html, /"stage-live":\s*"#58d4cf"[\s\S]{0,80}"stage-recorded":\s*"#d8a84e"/u);
  assert.match(html, /const replayFocus\s*=\s*executionRelation\s*&&\s*!replayFollowingLive[\s\S]{0,180}\?\s*"recorded"[\s\S]{0,140}path\.dataset\.liveFocus/u);
  assert.match(html, /replayFocus\s*===\s*"recorded"[\s\S]{0,100}\?\s*"stage-recorded"[\s\S]{0,100}: replayState/u);
  assert.match(html, /march|dash|flow/iu);
  assert.match(html, /prefers-reduced-motion\s*:\s*reduce/iu);
});

test("binds node selection to evidence and replay state without unbounded DOM growth", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /data-live-selected-node/iu);
  assert.match(html, /selectNode/iu);
  assert.match(html, /associated|nodeId|selected.*evidence/isu);
  assert.match(html, /slice\(0,\s*128\)/u);
  assert.match(html, /dataset\.replayActive/iu);
  assert.match(html, /ArrowUp|ArrowDown|Enter/iu);
});

test("keeps stage chapters out of a v2 entity graph while preserving v1 fallback", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /STAGE_MATCH_ORDER\s*=\s*\[\.\.\.STAGE_ORDER\]\.sort/iu);
  assert.match(html, /text\.startsWith\(stageName\s*\+\s*["']-["']\)/u);
  assert.match(html, /explicitStatus[\s\S]{0,500}nodeById\.get\(targetId\)\?\.status/u);
  assert.match(html, /nodeStatuses\s*=\s*new Set\(\[[^\]]*"skipped"/u);
  assert.match(html, /executionNodes\s*=\s*snapshot\.nodes\.filter[\s\S]{0,180}"stage_summary"/u);
  assert.match(html, /return executionNodes\.length \? executionNodes : snapshot\.nodes/u);
});

test("lays out worker and workflow entities by spawn depth with a v1 serpentine fallback", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /const cardWidth\s*=\s*228/u);
  assert.match(html, /function estimatedNodeCardHeight\(node\)/u);
  assert.match(html, /Math\.ceil\(nodeCapabilityCount\(node\) \/ 2\)/u);
  assert.match(html, /Math\.max\(220, 112 \+ capabilityRows \* 40\)/u);
  assert.match(html, /depthFor\(parentId, seen\) \+ 1/u);
  assert.match(html, /const orderedLanes\s*=\s*\[\.\.\.lanes\.entries\(\)\]\.sort/u);
  assert.match(html, /const maxLaneHeight\s*=\s*Math\.max\(estimatedNodeCardHeight\(nodes\[0\]\), \.\.\.laneHeights\.values\(\)\)/u);
  assert.match(html, /x:\s*laneX/u);
  assert.match(html, /y:\s*laneY/u);
  assert.match(html, /laneY \+= height \+ entityRowGap/u);
  assert.match(html, /const laneX\s*=\s*52 \+ depth \* entityColumnStep/u);
  assert.match(html, /const spineColumns\s*=\s*layoutMode\s*===\s*["']compact["']\s*\?\s*4\s*:\s*8/u);
  assert.match(html, /const rowGap\s*=\s*layoutMode\s*===\s*["']compact["']\s*\?\s*206\s*:\s*190/u);
  assert.match(html, /row\s*%\s*2\s*===\s*0\s*\?\s*withinRow\s*:\s*spineColumns\s*-\s*1\s*-\s*withinRow/u);
  assert.match(html, /function edgeGeometry\(/u);
  assert.match(html, /function edgePortSlot\(index, count, span\)/u);
  assert.match(html, /sourceIndex:\s*Math\.max\(0, outgoing\.indexOf\(edge\)\)/u);
  assert.match(html, /sourceCount:\s*outgoing\.length/u);
  assert.match(html, /from\.spine\s*===\s*true\s*&&\s*to\.spine\s*===\s*false[\s\S]{0,100}Math\.abs\(deltaY\)/u);
  assert.match(html, /\.node-card\s*\{[^}]*min-height:\s*176px/su);
  assert.match(html, /function syncLayoutToRenderedCards\(layout\)/u);
  assert.match(html, /Math\.ceil\(card\.scrollHeight\)/u);
  assert.match(html, /item\.position\.y \+ item\.position\.height \+ 88/u);
  assert.match(html, /syncLayoutToRenderedCards\(layout\);[\s\S]*for \(const edge of graphEdges\)/u);
});

test("lays out high-fanout work as one non-crossing row and ships an isolated mixed-state demo", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /const fanoutEntry\s*=\s*\[\.\.\.childrenByParent\.entries\(\)\]/u);
  assert.match(html, /children\.length\s*>=\s*4/u);
  assert.match(html, /const childY\s*=\s*chainY/u);
  assert.match(html, /x:\s*childStartX\s*\+\s*index\s*\*\s*childStep/u);
  assert.match(html, /kind:\s*"fanout"/u);
  assert.match(html, /graph\.dataset\.layoutKind\s*=\s*layout\.kind/u);
  assert.match(html, /demoMode\s*=\s*new URL\(window\.location\.href\)\.searchParams\.get\("demo"\)\s*===\s*"states"/u);
  assert.match(html, /function buildStateDemoSnapshot\(\)/u);
  for (const state of ["completed", "active", "queued", "blocked"]) {
    assert.match(html, new RegExp(`displayState:\\s*"${state}"`, "u"));
  }
  for (const [id, from, to, kind] of [
    ["demo-edge-1", "demo-owner", "demo-requirements", "sequence"],
    ["demo-edge-2", "demo-requirements", "demo-plan", "sequence"],
    ["demo-edge-3", "demo-plan", "demo-running-ui", "fork"],
    ["demo-edge-4", "demo-plan", "demo-running-test", "fork"],
    ["demo-edge-5", "demo-running-ui", "demo-queued", "depends_on"],
    ["demo-edge-6", "demo-running-test", "demo-queued", "depends_on"],
    ["demo-edge-7", "demo-queued", "demo-blocked", "depends_on"],
  ]) {
    assert.match(html, new RegExp(`id:\\s*"${id}"[^\\n]+from:\\s*"${from}"[^\\n]+to:\\s*"${to}"[^\\n]+kind:\\s*"${kind}"`, "u"));
  }
  assert.match(html, /nodeId:\s*"demo-requirements"/u);
  assert.match(html, /演示数据 · 非真实运行/u);
  assert.match(html, /青色流光＝进行中 · 绿色实线＝已完成 · 灰色虚线＝排队 · 琥珀虚线＝阻塞 · 点线＝结构归属/u);
  assert.match(html, /\.edge-completed\s*\{[^}]*stroke:\s*var\(--green\)[^}]*stroke-dasharray:\s*none/su);
  assert.match(html, /\.edge-skipped, \.edge-queued\s*\{[^}]*stroke-dasharray:\s*5 9[^}]*opacity:\s*\.38/su);
  assert.match(html, /\.node-running\s*\{[^}]*animation:\s*active-node-pulse/su);
  assert.match(html, /\["active", "in_progress", "executing"\]\.includes\(status\)\) return "running"/u);
  assert.match(html, /\.node-completed\s*\{[^}]*border-left-color:\s*var\(--green\)/su);
  assert.match(html, /\.node-card\[data-display-state="queued"\][^\{]*\{[^}]*opacity:\s*\.66/su);
  assert.match(html, /if \(!demoMode\) void \(async \(\) =>/u);
});

test("separates active pending work from inactive structural work and keeps the flow visible", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /node\?\.active === true[\s\S]*\["pending", "queued"\][\s\S]*return "queued"/u);
  assert.match(html, /node\?\.active !== true[\s\S]*\["pending", "queued"\][\s\S]*return "unreported"/u);
  assert.match(html, /node\.statusReason/u);
  assert.match(html, /node-task/u);
  assert.match(html, /card\.addEventListener\("click", \(event\) =>/u);
  assert.match(html, /<details class="stage-overview" open/u);
});

test("keeps inspector provenance and replay navigation visible and keyboard reachable", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  for (const marker of [
    "data-live-selected-node-status",
    "data-live-selected-node-owner",
    "data-live-selected-node-runtime",
    "data-live-selected-node-summary",
    "data-live-selected-node-evidence-detail",
    "data-replay-prev",
    "data-replay-next",
    "data-replay-live",
    "Escape",
    "aria-selected",
  ]) {
    assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\[\]\\]/gu, "\\$&"), "u"), marker);
  }
  assert.match(html, /entry\.addEventListener\(["']keydown["'][\s\S]{0,450}selectNode\(item\.nodeId\)/u);
  assert.match(html, /replayFollowingLive/iu);
});

test("consumes bounded v2 agent, prompt, tool, provenance, and event facts with v1 fallbacks", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  for (const marker of [
    "data-live-selected-node-model",
    "data-live-selected-node-duration",
    "data-live-selected-node-tools",
    "data-live-selected-node-tokens",
    "data-live-selected-node-provenance",
    "data-live-selected-node-prompt",
    "data-live-session-list",
    "renderInspectorHistory",
    "graphNodesForSnapshot",
    "toolCalls",
    "triggerPromptId",
    "reasoningExcerpt",
    "terminalEvidence",
    "outputTokens",
    "latestTool",
  ]) {
    assert.match(html, new RegExp(marker, "u"), marker);
  }
  assert.match(html, /promptInput\.slice\(0, 256\)/u);
  assert.match(html, /toolCallInput\.slice\(0, 512\)/u);
  assert.match(html, /provenanceInput\.slice\(0, 256\)/u);
  assert.match(html, /replayInputEvents\.slice\(0, 512\)/u);
  assert.match(html, /node\.toolCount \+ " tools"[\s\S]{0,120}node\.latestTool/u);
  assert.match(html, /node\.outputTokens \+ " tok"/u);
  assert.match(html, /item\.dataset\.kind = event\.kind/u);
  assert.match(html, /data-kind="prompt"/u);
  assert.match(html, /data-kind="spawn"/u);
  assert.match(html, /data-tool-density/u);
});

test("renders only present capability truth as dynamic keyboard-accessible ports", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /makeElement\("div", "node-capability-strip"\)/u);
  assert.match(html, /const NODE_CAPABILITY_KINDS = \["agent", "skill", "mcp", "command", "runtime_tool", "hook", "plugin", "memory_graph", "dependency"\]/u);
  assert.match(html, /const capabilityLabels = \{ agent: "Agent", skill: "Skill", mcp: "MCP", command: "Command", runtime_tool: "Tool", hook: "Hook", plugin: "Plugin", memory_graph: "Memory\/Graph", dependency: "Dependency" \}/u);
  assert.match(html, /\(node\.capabilityTruth \|\| \[\]\)\.map\(\(truth\)/u);
  assert.match(html, /button\.dataset\.capabilityKind = record\.kind/u);
  assert.match(html, /button\.dataset\.capabilityState = record\.state/u);
  assert.match(html, /record\.state === "observed"[\s\S]*record\.state === "planned"[\s\S]*"未记录"/u);
  assert.match(html, /event\.stopPropagation\(\)[\s\S]*selectNode\(node\.id, \{ inspectorTab: record\.tab \}\)/u);
  assert.match(html, /\["mcp", "command", "runtime_tool", "hook"\]\.includes\(kind\)/u);
  assert.match(html, /\["memory_graph", "dependency"\]\.includes\(kind\)/u);
  assert.match(html, /normalizeNodeCapabilityTruth\(item, loadout\)/u);
  assert.match(html, /record\.state === "observed" && record\.observation === "trusted_host_evidence"/u);
  assert.match(html, /capabilityNames\(\[\.\.\.plannedNames, \.\.\.capabilityNames\(record\.actualNames\)\]\)/u);
  assert.match(html, /if \(!downgradedNames\.length && !actualNames\.length\) return \[\]/u);
  assert.match(html, /filter\(\(record\) => record\.count > 0 && \["observed", "planned"\]\.includes\(record\.state\)\)/u);
  assert.match(html, /if \(capabilityStrip\.childElementCount\) card\.append\(capabilityStrip\)/u);
  assert.doesNotMatch(html, /state:\s*usefulNodeMeta\(node\.agent\)\s*\?\s*"observed"/u);
  assert.match(html, /function selectNode\(nodeId, \{ focus = false, inspectorTab = null \} = \{\}\)/u);
  assert.match(html, /INSPECTOR_TABS\.includes\(inspectorTab\)/u);
  assert.match(html, /\.node-capability-strip\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(2,minmax\(0,1fr\)\)[^}]*overflow:\s*visible/su);
  assert.match(html, /\.node-capability:last-child:nth-child\(odd\)\s*\{\s*grid-column:\s*1\s*\/\s*-1;\s*\}/u);
  assert.match(html, /card\.dataset\.capabilityCount = String\(capabilityRecords\.length\)/u);
  assert.match(html, /card\.dataset\.hasCapabilities = capabilityRecords\.length \? "true" : "false"/u);
  assert.match(html, /\.node-card\s*\{[^}]*max-height:\s*none[^}]*overflow:\s*visible/su);
  assert.match(html, /data-semantic-zoom="cell"\] \.node-card\[data-has-capabilities="true"\][^}]*height:\s*auto !important[^}]*overflow:\s*visible/su);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*\.node-card[^}]*min-height:\s*166px !important/su);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*\.node-capability-strip\s*\{\s*grid-template-columns:\s*1fr/su);
  assert.match(html, /\.node-capability-kind, \.node-capability-value, \.node-capability-state \{ font-size: 10px; \}/u);
});

test("adapts service field aliases and safely summarizes structured terminal evidence", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /const sessionCandidate = input\.sessionInfo \?\? input\.session/u);
  assert.match(html, /\["timestamp", "observedAt", "occurredAt", "createdAt"\]/u);
  assert.match(html, /\["startedAt", "occurredAt", "at", "timestamp"\]/u);
  assert.match(html, /function summarizeTerminalEvidence\(value\)/u);
  assert.match(html, /\["completed", "failed", "blocked"\]\.includes\(item\.status\)/u);
  assert.match(html, /trusted\.length \+ " terminal evidence/u);
  assert.match(html, /firstValue\(record, \["ownerBindingMode"\], ""\)/u);
  assert.match(html, /firstValue\(record, \["state", "status"\], ""\)/u);
  assert.doesNotMatch(html, /terminalEvidence:\s*display\(/u);
});

test("uses explicit marker colors so SVG arrows do not inherit an unreliable currentColor", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /markerColors\s*=\s*\{[\s\S]*running:\s*["']#58d4cf["'][\s\S]*completed:\s*["']#5b8cff["'][\s\S]*skipped:\s*["']#585858["']/u);
  assert.match(html, /marker-end["'],\s*["']url\(#\s*["']\s*\+\s*edgeMarkerId/u);
  assert.doesNotMatch(html, /fill["'],\s*["']currentColor["']/u);
});

test("makes aria-modal dialogs isolate the app, trap focus, and restore the opener", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /const FOCUSABLE_DIALOG_SELECTOR\s*=/u);
  assert.match(html, /function trapDialogFocus\(event\)[\s\S]{0,1200}event\.key !== "Tab"/u);
  assert.match(html, /event\.shiftKey[\s\S]{0,500}last\.focus\(\)/u);
  assert.match(html, /first\.focus\(\)/u);
  assert.match(html, /background\.inert\s*=\s*active/u);
  assert.match(html, /background\.setAttribute\("aria-hidden", "true"\)/u);
  assert.match(html, /restoreModalBackground\(\)/u);
  assert.match(html, /activeDialog\.contains\(document\.activeElement\)/u);
  assert.match(html, /dialogOpener\.focus\(\)/u);
  assert.match(html, /const hadOpenDialog\s*=\s*Boolean\(activeDialog\)/u);
  assert.match(html, /if \(!hadOpenDialog\) document\.activeElement\?\.blur\?\.\(\)/u);

  const {
    controller,
    document,
    skipLink,
    background,
    preservedBackground,
    sessionsDialog,
    first,
    last,
    FakeElement,
  } = modalBehaviorHarness();
  const opener = new FakeElement("opener");
  opener.focus();
  controller.setDialogOpen(sessionsDialog, true);

  assert.equal(controller.activeDialog(), sessionsDialog);
  assert.equal(sessionsDialog.hidden, false);
  assert.equal(sessionsDialog.getAttribute("aria-hidden"), "false");
  assert.equal(document.activeElement, first);
  for (const isolated of [skipLink, background, preservedBackground]) {
    assert.equal(isolated.inert, true, isolated.name);
    assert.equal(isolated.getAttribute("aria-hidden"), "true", isolated.name);
  }

  const tabEvent = (shiftKey = false) => ({
    key: "Tab",
    shiftKey,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  });
  last.focus();
  const forwardTab = tabEvent(false);
  controller.trapDialogFocus(forwardTab);
  assert.equal(forwardTab.defaultPrevented, true);
  assert.equal(document.activeElement, first);
  const reverseTab = tabEvent(true);
  controller.trapDialogFocus(reverseTab);
  assert.equal(reverseTab.defaultPrevented, true);
  assert.equal(document.activeElement, last);

  const escape = {
    key: "Escape",
    target: last,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  controller.keydownHandler()(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(controller.activeDialog(), null);
  assert.equal(sessionsDialog.hidden, true);
  assert.equal(sessionsDialog.getAttribute("aria-hidden"), "true");
  assert.equal(background.inert, false);
  assert.equal(background.getAttribute("aria-hidden"), null);
  assert.equal(skipLink.inert, false);
  assert.equal(skipLink.getAttribute("aria-hidden"), null);
  assert.equal(preservedBackground.inert, true);
  assert.equal(preservedBackground.getAttribute("aria-hidden"), "legacy");
  assert.equal(document.activeElement, opener);

  controller.setDialogOpen(sessionsDialog, true);
  controller.setDialogOpen(sessionsDialog, false);
  assert.equal(document.activeElement, opener);
  assert.equal(background.inert, false);
});

test("keeps the desktop workspace bounded and coalesces high-frequency snapshot updates", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /\.workspace-grid\s*\{[^}]*height:\s*100%[^}]*overflow:\s*hidden/su);
  assert.match(html, /\.evidence-panel\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/su);
  assert.match(html, /\.evidence-drawer\s*\{[^}]*overflow:\s*auto/su);
  assert.match(html, /graphMinimap\.hidden\s*=\s*!overflowing/u);
  assert.match(html, /SNAPSHOT_COALESCE_MS\s*=\s*75/u);
  assert.match(html, /scheduleSnapshotUpdate[\s\S]*snapshotCoalesceTimer[\s\S]*setTimeout/su);
  assert.match(html, /beforeunload[\s\S]*clearTimeout\(snapshotCoalesceTimer\)/su);
});

test("preserves real edge state without replay evidence and uses interactive list semantics", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /let replayState\s*=\s*edge\.status/u);
  assert.match(html, /if\s*\(!hasReplayState\)\s*replayState\s*=\s*edge\.status/u);
  assert.match(html, /data-live-node-list role="list"/u);
  assert.match(html, /setAttribute\(["']role["'],\s*["']listitem["']\)/u);
  assert.match(html, /makeElement\("button", "node-identity-row node-identity-button"\)/u);
  assert.match(html, /data-live-graph-follow[^>]+data-active="false"[^>]+aria-pressed="false"/u);
  assert.match(html, /if \(firstSnapshot\)[\s\S]*fitGraph\(\);[\s\S]*setCameraMode\("overview"\)/u);
  assert.doesNotMatch(html, /if \(firstSnapshot\)[\s\S]{0,800}centerGraphNode\(selectedNodeId\)/u);
  assert.doesNotMatch(html, /card\.setAttribute\(["']aria-pressed/u);
  assert.match(html, /replayPlay\.disabled\s*=\s*events\.length\s*<\s*2/u);
  assert.match(html, /columnGap\s*=\s*layoutMode\s*===\s*["']compact["']\s*\?\s*276\s*:\s*248/u);
  assert.match(html, /entityColumnStep\s*=\s*layoutMode\s*===\s*"compact"\s*\?\s*356\s*:\s*384/u);
  assert.match(html, /entityRowGap\s*=\s*layoutMode\s*===\s*"compact"\s*\?\s*88\s*:\s*104/u);
  assert.match(html, /nextY\s*=\s*item\.position\.y\s*\+\s*item\.position\.height\s*\+\s*88/u);
  assert.match(html, /\.replay-panel\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%[^}]*grid-template-columns:\s*330px\s*minmax\(0,1fr\)[^}]*overflow:\s*hidden[^}]*contain:\s*inline-size/su);
  assert.match(html, /\.replay-dock-header\s*\{[^}]*min-width:\s*0[^}]*width:\s*330px[^}]*max-width:\s*100%[^}]*grid-template-columns:\s*minmax\(88px,1fr\)\s*auto[^}]*overflow:\s*hidden/su);
  assert.match(html, /\.replay-range-wrap\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%[^}]*overflow:\s*hidden/su);
  assert.match(html, /\.replay-track\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%[^}]*overflow:\s*hidden/su);
  assert.match(html, /grid-template-columns:\s*minmax\(0,300px\)\s*minmax\(0,1fr\)\s*minmax\(0,410px\)/su);
  assert.match(html, /\.replay-empty\s*\{[^}]*align-self:\s*end[^}]*height:\s*28px[^}]*min-height:\s*0[^}]*margin:\s*32px\s+0\s+0\s+calc\(100%\s*-\s*410px\)[^}]*overflow:\s*hidden/su);
  assert.match(html, /\.replay-current \.panel-note\s*\{[^}]*display:\s*none/su);
  assert.doesNotMatch(html, /\.workspace-grid\[data-inspector-open="true"\] \.replay-current\s*\{[^}]*display:\s*none/su);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*\.top-run-context, \.connection span:last-child\s*\{\s*display:\s*none/su);
  assert.match(html, /data-live-open-sessions[\s\S]{0,500}data-live-language-toggle[\s\S]{0,500}data-live-open-help[\s\S]{0,500}data-live-open-info/u);
  assert.match(html, /\[data-live-graph-fit\], \[data-live-graph-layout\], \[data-live-graph-zoom-out\], \[data-live-graph-zoom-in\]\s*\{\s*display:\s*none/su);
  assert.match(html, /\.replay-events\s*\{[^}]*overflow-x:\s*auto[^}]*overflow-y:\s*hidden/su);
  assert.match(html, /scrollIntoView\?\.\(\{ behavior:\s*"auto", block:\s*"nearest", inline:\s*"nearest" \}\)/u);
  assert.match(html, /for \(const other of \[sessionsDialog, helpDialog, infoDialog\]\)/u);
  assert.match(html, /dialogOpener = document\.activeElement/u);
  assert.match(html, /dialogOpener\.focus\(\)/u);
  assert.match(html, /data-semantic-zoom="cell"\] \.node-card\s*\{[^}]*height:\s*140px[^}]*background:\s*transparent/su);
  assert.match(html, /class="status-bar"/u);
  assert.match(html, /\.activity-chips\s*\{[^}]*display:\s*flex/su);
  assert.match(html, /\.activity-chip\s*\{[^}]*min-width:\s*0/su);
  assert.match(html, /graph\.scrollTo\(\{[\s\S]{0,260}behavior:\s*reducedMotion\.matches\s*\?\s*"auto"\s*:\s*"smooth"/u);
});

test("keeps secondary Repository and Workspace surfaces in an on-demand keyboard menu", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /class="work-view-menu"/u);
  assert.match(html, /class="work-view-switcher" role="tablist" aria-label="Optional work surface views"/u);
  for (const view of ["repository", "workspace", "run"]) {
    assert.match(html, new RegExp(`role="tab"[^>]+data-live-work-view="${view}"`, "u"));
    assert.match(html, new RegExp(`data-live-${view === "run" ? "run" : view}-view`, "u"));
  }
  assert.match(html, /WORK_VIEW_STORAGE_KEY\s*=\s*"meta-kim-live-work-view-v3"/u);
  assert.match(html, /window\.sessionStorage\?\.getItem\(key\)/u);
  assert.match(html, /window\.localStorage\?\.getItem\(key\)/u);
  assert.match(html, /window\.sessionStorage\?\.setItem\(key, value\)/u);
  assert.match(html, /bindRovingTabs\(workViewTabs, WORK_VIEWS, setWorkView\)/u);
  assert.match(html, /\["ArrowLeft", "ArrowRight", "Home", "End"\]/u);
  assert.match(html, /setWorkView\(currentWorkView, \{ persist: false \}\)/u);
  assert.match(html, /params\.set\("projectId", selectedProjectId\)[\s\S]*params\.set\("runId", selectedRunId\)/u);
  assert.doesNotMatch(html, /worktree children|session worktree/iu);
});

test("renders repository and workspace facts without inventing unavailable source-control data", () => {
  const html = renderLiveControlRoomPage({
    snapshot: {
      ...snapshotFixture,
      repository: {
        name: { state: "observed", value: "Meta_Kim" },
        branch: { state: "observed", value: "codex/live-hub-canvas-first" },
      },
      workspace: {
        workspaceId: { state: "observed", value: "workspace-17" },
        transcript: { state: "unavailable", value: null },
        terminal: { state: "unavailable", value: null },
      },
    },
  });

  assert.match(html, /data-live-repository-title/u);
  assert.match(html, /data-live-repository-boundary/u);
  assert.match(html, /data-live-repository-sessions/u);
  assert.match(html, /Active workspace|Observed workspace/u);
  assert.match(html, /\["Branch", repository\.branch\]/u);
  assert.match(html, /\["Worktree", repository\.worktree\]/u);
  assert.match(html, /\["Pull request", repository\.pullRequest\]/u);
  assert.match(html, /\["Diff", repository\.diff\]/u);
  assert.match(html, /fact\?\.summary \|\| "Unavailable"/u);
  assert.match(html, /data-live-workspace-boundary/u);
  assert.match(html, /function renderWorkspaceSessions/u);
  assert.match(html, /function renderWorkspaceBoard/u);
  assert.match(html, /function renderWorkspaceDetail/u);
  assert.match(html, /workspaceColumnForStatus/u);
  assert.match(html, /legacy status-only record/u);
  assert.match(html, /snapshot\.repository\.diff\?\.state === "observed"/u);
  assert.match(html, /No deliverable or verification evidence is linked yet/u);
  assert.doesNotMatch(html, /repositoryInput\.(?:root|projectRoot|path)/u);
});

test("uses the execution flow as the default surface while preserving the workspace", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /class="company-workspace"/u);
  assert.match(html, /class="company-session-rail"/u);
  assert.match(html, /class="company-board"/u);
  assert.match(html, /class="company-context-panel"/u);
  for (const hook of ["workspace-session-list", "workspace-board", "workspace-detail"]) {
    assert.match(html, new RegExp(`data-live-${hook}`, "u"));
  }
  assert.match(html, /currentWorkView\s*=\s*safeStoredChoice\(WORK_VIEW_STORAGE_KEY, WORK_VIEWS, "run"\)/u);
  assert.match(html, /aria-selected="true"[^>]*data-live-work-view="run"/u);
  assert.match(html, /data-live-workspace-view hidden/u);
  assert.match(html, /workspaceOpenRunMap\?\.addEventListener/u);
  assert.match(html, /New runs preserve that telemetry/u);
});

test("groups Inspector evidence into four bounded reference-aligned tabs and distinguishes planned context delivery", () => {
  const html = renderLiveControlRoomPage({
    snapshot: {
      ...snapshotFixture,
      contextTransfers: [{ id: "ctx-1", state: "planned", fromNodeId: "critical", toNodeId: "execution" }],
    },
  });

  assert.match(html, /class="inspector-tabs" role="tablist" aria-label="Inspector sections"/u);
  for (const tab of ["summary", "evidence", "terminal", "context"]) {
    assert.match(html, new RegExp(`data-live-inspector-tab="${tab}"`, "u"));
    assert.match(html, new RegExp(`data-live-inspector-panel="${tab}"`, "u"));
  }
  assert.match(html, /data-live-conversation-list/u);
  assert.match(html, /data-live-changes-list/u);
  assert.match(html, /data-i18n-zh="工具"/u);
  assert.match(html, /data-i18n-zh="决策"/u);
  assert.match(html, /contextTransferInput\.slice\(0, 256\)/u);
  assert.match(html, /\["observed", "accepted"\]\.includes\(rawState\) \? rawState : "planned"/u);
  assert.match(html, /nullableCount\(record\.summaryCount\)/u);
  assert.match(html, /planned · delivery not observed/u);
  assert.match(html, /entry\.dataset\.transferState = item\.transferState/u);
  assert.match(html, /entry\.dataset\.deliveryObserved = item\.transferState === "observed" \|\| item\.transferState === "accepted" \? "true" : "false"/u);
  assert.match(html, /\.evidence-item\[data-transfer-state="planned"\][^}]*border-left-style:\s*dashed/su);
  assert.doesNotMatch(html, /data-transfer-state="planned"[^}]*animation/isu);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*\.work-view-switcher[^}]*grid-column:\s*1 \/ -1/su);
  assert.match(html, /html, body \{[^}]*overflow:\s*hidden/su);
});

test("annotates planned scheduling waves without turning them into edges or animation", () => {
  const html = renderLiveControlRoomPage({
    snapshot: {
      ...snapshotFixture,
      scheduling: {
        schemaVersion: "meta-kim-live-scheduling-v1",
        provenance: "observed",
        capacity: {
          maxParallelAgents: 2,
          requestedParallelAgents: 8,
          runtimeCapacity: 2,
          capacitySourceKind: "active_config",
          throttled: true,
        },
        waves: [
          { waveId: "wave-1", waveIndex: 1, mode: "primary_parallel_wave", declaredParallelCount: 2, nodeIds: ["critical", "execution"], mappedCount: 2, unmappedCount: 0, mergeOwner: "meta-conductor" },
          { waveId: "wave-2", waveIndex: 2, mode: "followup_parallel_wave", declaredParallelCount: 2, nodeIds: [], mappedCount: 0, unmappedCount: 2, mergeOwner: "meta-conductor" },
        ],
        waveCount: 2,
        declaredWaveCount: 2,
        coverage: { declaredTaskCount: 4, mappedNodeCount: 2, complete: false },
      },
    },
  });

  // The page re-pins provenance locally, so a payload claiming its wave order was
  // observed cannot relabel a declared plan on screen.
  assert.match(html, /provenance: "planned",/u);
  assert.doesNotMatch(html, /provenance: display\(/u);
  // The badge goes into the status strip, never into .node-meta: that row is
  // display:none in the card layout, so a wave annotation placed there would be
  // present in the DOM and invisible on screen.
  assert.match(html, /top\.append\(waveBadge\)/u);
  assert.doesNotMatch(html, /meta\.append\(wave/u);
  assert.match(html, /\.node-meta \{ display: none; \}/u);
  assert.match(html, /waveBadge\.dataset\.waveProvenance = "planned"/u);
  assert.match(html, /kind: "scheduling_wave"/u);
  assert.match(html, /kind: "scheduling_capacity"/u);
  assert.match(html, /planned · declared order, not observed execution/u);
  assert.match(html, /schedulingRows\.concat\(transfers\)/u);
  // Waves stay an annotation: no scheduling input reaches edge construction, and
  // the badge carries neither motion nor a box that could grow the card.
  assert.doesNotMatch(html, /graphEdgesForSnapshot\([^)]*scheduling/u);
  assert.match(html, /\.node-wave-badge \{[^}]*flex: 0 0 auto/su);
  assert.doesNotMatch(html, /\.node-wave-badge \{[^}]*(animation|border-width|border:)/su);
});

test("keeps the reference-inspired cool-tech surface restrained, stateful, and mobile-bounded", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const themeCss = html.slice(html.lastIndexOf(":root {"));
  const variable = (name) => themeCss.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "iu"))?.[1].toLowerCase();
  const pixelVariable = (name) => Number(themeCss.match(new RegExp(`--${name}:\\s*([0-9]+(?:\\.[0-9]+)?)px`, "iu"))?.[1]);
  const rgbToHsl = (hex) => {
    const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
    const maximum = Math.max(...channels);
    const minimum = Math.min(...channels);
    const lightness = (maximum + minimum) / 2;
    const saturation = maximum === minimum
      ? 0
      : (maximum - minimum) / (1 - Math.abs(2 * lightness - 1));
    return { saturation: saturation * 100 };
  };

  const completion = variable("completion");
  const completionBright = variable("completion-bright");
  const running = variable("running");
  const success = variable("green");
  const danger = variable("danger");
  assert.ok(completion && completionBright && running && success && danger, "the final theme must expose semantic color variables");
  assert.equal(completion, "#68a4ff", "completion must use the cool-blue state color");
  assert.equal(running, "#4fd1c5", "running must use the teal state color");
  assert.equal(new Set([completion, running, success, danger]).size, 4, "completion, running, success, and failed states need distinct colors");
  assert.doesNotMatch(html, /gold|#a68d5e|#cfbd96|#5a4b08|#e5c07b|#c8a96b|#d7af00|#f0d56a|#87d787/iu, "the full generated HTML and script must not retain gold names or warm completion swatches");
  assert.match(themeCss, /--accent:\s*#4fd1c5/iu);
  assert.match(themeCss, /\.node-running\s*\{[^}]*border-left-color:\s*var\(--running\)/su);
  assert.match(themeCss, /\.node-completed\s*\{[^}]*border-left-color:\s*var\(--green\)/su);
  assert.match(themeCss, /\.node-failed, \.node-in-doubt\s*\{[^}]*border-left-color:\s*var\(--danger\)/su);

  const pixelRadii = [...themeCss.matchAll(/border-radius:\s*([0-9]+(?:\.[0-9]+)?)px/giu)]
    .map((match) => Number(match[1]));
  assert.ok(pixelRadii.length > 0, "the final theme should declare a restrained radius hierarchy");
  assert.ok(Math.max(...pixelRadii) <= 12, "non-circular component radii must stay restrained");
  assert.ok(pixelVariable("radius-sm") <= 8 && pixelVariable("radius") <= 12, "theme radius tokens must stay restrained");

  assert.match(themeCss, /@media \(max-width: 720px\)[\s\S]*\.topbar\s*\{[^}]*grid-template-columns:\s*auto\s+minmax\(0,1fr\)\s+auto/su);
  assert.match(themeCss, /@media \(max-width: 720px\)[\s\S]*\.work-view-switcher\s*\{[^}]*width:\s*100%/su);
  assert.match(themeCss, /@media \(max-width: 720px\)[\s\S]*\.work-view-tab\s*\{[^}]*min-width:\s*0/su);
  assert.match(themeCss, /@media \(max-width: 720px\)[\s\S]*\.node-card\s*\{[^}]*width:\s*100%\s*!important/su);
  assert.match(themeCss, /@media \(max-width: 720px\)[\s\S]*\.graph-toolbar\s*\{[^}]*overflow-x:\s*auto/su);
  assert.match(themeCss, /\.inspector-tabs\s*\{[^}]*min-width:\s*0[^}]*overflow-x:\s*auto/su);
});

test("inactive legacy unknown nodes use the honest no-writeback label and human owner copy", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  assert.match(html, /state === "unknown" && node\?\.active !== true/u);
  assert.match(html, /normalizedRunDisplayState\(runInput/u);
  assert.match(html, /"未收到执行回写"/u);
  assert.match(html, /"角色 · "/u);
  assert.match(html, /"AI 执行者 · "/u);
  assert.doesNotMatch(html, /"专业 "/u);
  assert.match(html, /\.node-owner-line \{[^}]*display:\s*flex[^}]*gap:/su);
});
