import test from "node:test";
import assert from "node:assert/strict";

import {
  LIVE_SNAPSHOT_SCHEMA_VERSION,
  renderLiveControlRoomPage,
} from "../../src/presentation/live/live-control-room-page.mjs";

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
  assert.match(html, /data-i18n-en="Node provenance" data-i18n-zh="节点来源与依据">节点来源与依据/u);
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

  assert.doesNotMatch(html, /<img\b/iu);
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
  assert.match(html, /\.workspace-grid\[data-inspector-open="true"\]\s*\{[^}]*30%[^}]*70%/su);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*\.evidence-panel\s*\{[^}]*position:\s*fixed/su);
  assert.match(html, /\.graph-panel\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)\s*92px\s*24px/su);
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

test("renders an accessible project and session selector with explicit empty guidance", () => {
  const html = renderLiveControlRoomPage();

  assert.match(html, /data-live-project-select/u);
  assert.match(html, /data-live-session-select/u);
  assert.match(html, /aria-label="Choose a Meta_Kim project"/u);
  assert.match(html, /aria-label="Choose a governed session"/u);
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
  assert.match(html, /session\.runId\.slice\(-6\)/u);
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
  assert.match(html, /const scale\s*=\s*Math\.max\(\.42,/u);
});

test("draws curved status-aware edges and a live flow animation with reduced-motion fallback", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /createElementNS\(["']http:\/\/www\.w3\.org\/2000\/svg["'],\s*["']path["']\)/u);
  assert.match(html, /edge-running/iu);
  assert.match(html, /edge-failed/iu);
  assert.match(html, /edge-queued/iu);
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

  assert.match(html, /const cardWidth\s*=\s*168/u);
  assert.match(html, /const cardHeight\s*=\s*116/u);
  assert.match(html, /depthFor\(parentId, seen\) \+ 1/u);
  assert.match(html, /Math\.ceil\(Math\.sqrt\(lane\.length\)\)/u);
  assert.match(html, /index % laneColumns/u);
  assert.match(html, /laneStartX/u);
  assert.match(html, /const spineColumns\s*=\s*layoutMode\s*===\s*["']compact["']\s*\?\s*4\s*:\s*8/u);
  assert.match(html, /const rowGap\s*=\s*layoutMode\s*===\s*["']compact["']\s*\?\s*150\s*:\s*126/u);
  assert.match(html, /row\s*%\s*2\s*===\s*0\s*\?\s*withinRow\s*:\s*spineColumns\s*-\s*1\s*-\s*withinRow/u);
  assert.match(html, /function edgeGeometry\(/u);
  assert.match(html, /vertical\s*=\s*Math\.abs\(deltaY\)/u);
  assert.match(html, /\.node-card\s*\{[^}]*min-height:\s*116px/su);
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

  assert.match(html, /markerColors\s*=\s*\{[\s\S]*running:\s*["']#87d787["'][\s\S]*skipped:\s*["']#585858["']/u);
  assert.match(html, /marker-end["'],\s*["']url\(#\s*["']\s*\+\s*edgeMarkerId/u);
  assert.doesNotMatch(html, /fill["'],\s*["']currentColor["']/u);
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

test("preserves real edge state without replay evidence and uses valid listbox semantics", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /let replayState\s*=\s*edge\.status/u);
  assert.match(html, /if\s*\(!hasReplayState\)\s*replayState\s*=\s*edge\.status/u);
  assert.match(html, /data-live-node-list role="listbox"/u);
  assert.match(html, /setAttribute\(["']role["'],\s*["']option["']\)/u);
  assert.match(html, /data-live-graph-follow[^>]+aria-pressed="true"/u);
  assert.doesNotMatch(html, /card\.setAttribute\(["']aria-pressed/u);
  assert.match(html, /replayPlay\.disabled\s*=\s*events\.length\s*<\s*2/u);
  assert.match(html, /columnGap\s*=\s*layoutMode\s*===\s*["']compact["']\s*\?\s*220\s*:\s*184/u);
  assert.match(html, /\.replay-panel\s*\{[^}]*grid-template-columns:\s*300px\s*minmax\(0,1fr\)/su);
  assert.match(html, /\.replay-dock-header\s*\{[^}]*min-width:\s*300px[^}]*grid-template-columns:\s*minmax\(74px,1fr\)\s*auto/su);
  assert.match(html, /\.replay-current \.panel-note\s*\{[^}]*display:\s*none/su);
  assert.match(html, /\.workspace-grid\[data-inspector-open="true"\] \.replay-panel\s*\{[^}]*grid-template-columns:\s*minmax\(0,1fr\)/su);
  assert.match(html, /\.workspace-grid\[data-inspector-open="true"\] \.replay-current\s*\{[^}]*display:\s*none/su);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*\.top-run-context, \.connection span:last-child\s*\{\s*display:\s*none/su);
  assert.match(html, /data-live-open-sessions[\s\S]{0,500}data-live-language-toggle[\s\S]{0,500}data-live-open-help[\s\S]{0,500}data-live-open-info/u);
  assert.match(html, /\[data-live-graph-fit\], \[data-live-graph-layout\], \[data-live-graph-zoom-out\], \[data-live-graph-zoom-in\]\s*\{\s*display:\s*none/su);
  assert.match(html, /\.replay-events\s*\{[^}]*overflow-x:\s*auto[^}]*overflow-y:\s*hidden/su);
  assert.match(html, /scrollIntoView\?\.\(\{ behavior:\s*"auto", block:\s*"nearest", inline:\s*"nearest" \}\)/u);
  assert.match(html, /for \(const other of \[sessionsDialog, helpDialog, infoDialog\]\)/u);
  assert.match(html, /dialogOpener = document\.activeElement/u);
  assert.match(html, /dialogOpener\.focus\(\)/u);
  assert.match(html, /data-semantic-zoom="cell"\] \.node-card\s*\{[^}]*height:\s*116px[^}]*background:\s*transparent/su);
  assert.match(html, /class="status-bar"/u);
  assert.match(html, /\.activity-chips\s*\{[^}]*display:\s*flex/su);
  assert.match(html, /\.activity-chip\s*\{[^}]*min-width:\s*0/su);
  assert.match(html, /graph\.scrollTo\(\{[\s\S]{0,260}behavior:\s*reducedMotion\.matches\s*\?\s*"auto"\s*:\s*"smooth"/u);
});

test("adds a persistent keyboard-accessible Repository Workspace Run work surface", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /class="work-view-switcher" role="tablist" aria-label="Work surface view"/u);
  for (const view of ["repository", "workspace", "run"]) {
    assert.match(html, new RegExp(`role="tab"[^>]+data-live-work-view="${view}"`, "u"));
    assert.match(html, new RegExp(`data-live-${view === "run" ? "run" : view}-view`, "u"));
  }
  assert.match(html, /WORK_VIEW_STORAGE_KEY\s*=\s*"meta-kim-live-work-view"/u);
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
  assert.match(html, /\["Plan", plan\].*\["Conversation", thread\].*\["Terminal", terminal\].*\["Changes", changes\].*\["Review", review\]/su);
  assert.match(html, /Conversation transcript unavailable/u);
  assert.match(html, /Terminal adapter telemetry unavailable/u);
  assert.match(html, /Diff telemetry unavailable/u);
  assert.doesNotMatch(html, /repositoryInput\.(?:root|projectRoot|path)/u);
});

test("splits Inspector into six bounded tabs and distinguishes planned context delivery", () => {
  const html = renderLiveControlRoomPage({
    snapshot: {
      ...snapshotFixture,
      contextTransfers: [{ id: "ctx-1", state: "planned", fromNodeId: "critical", toNodeId: "execution" }],
    },
  });

  assert.match(html, /class="inspector-tabs" role="tablist" aria-label="Inspector sections"/u);
  for (const tab of ["summary", "conversation", "terminal", "changes", "evidence", "context"]) {
    assert.match(html, new RegExp(`data-live-inspector-tab="${tab}"`, "u"));
    assert.match(html, new RegExp(`data-live-inspector-panel="${tab}"`, "u"));
  }
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

test("keeps the reference-inspired black-gold surface restrained, stateful, and mobile-bounded", () => {
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

  const gold = variable("gold");
  const goldBright = variable("gold-bright");
  const running = variable("teal");
  const success = variable("green");
  const danger = variable("danger");
  assert.ok(gold && goldBright && running && success && danger, "the final theme must expose semantic color variables");
  assert.ok(rgbToHsl(gold).saturation <= 70, "primary gold should remain low-saturation");
  assert.ok(rgbToHsl(goldBright).saturation <= 70, "highlight gold should remain low-saturation");
  assert.equal(new Set([gold, running, success, danger]).size, 4, "gold, running, success, and failed states need distinct colors");
  assert.match(themeCss, /\.node-running\s*\{[^}]*border-left-color:\s*var\(--teal\)/su);
  assert.match(themeCss, /\.node-completed\s*\{[^}]*border-left-color:\s*var\(--gold\)/su);
  assert.match(themeCss, /\.node-failed, \.node-in-doubt\s*\{[^}]*border-left-color:\s*var\(--danger\)/su);

  const pixelRadii = [...themeCss.matchAll(/border-radius:\s*([0-9]+(?:\.[0-9]+)?)px/giu)]
    .map((match) => Number(match[1]));
  assert.ok(pixelRadii.length > 0, "the final theme should declare a restrained radius hierarchy");
  assert.ok(Math.max(...pixelRadii) <= 6, "non-circular component radii must not exceed 6px");
  assert.ok(pixelVariable("radius-sm") <= 6 && pixelVariable("radius") <= 6, "theme radius tokens must not exceed 6px");

  assert.match(themeCss, /@media \(max-width: 720px\)[\s\S]*\.topbar\s*\{[^}]*grid-template-columns:\s*auto\s+minmax\(0,1fr\)\s+auto/su);
  assert.match(themeCss, /@media \(max-width: 720px\)[\s\S]*\.work-view-switcher\s*\{[^}]*width:\s*100%/su);
  assert.match(themeCss, /@media \(max-width: 720px\)[\s\S]*\.work-view-tab\s*\{[^}]*min-width:\s*0/su);
  assert.match(themeCss, /@media \(max-width: 720px\)[\s\S]*\.node-card\s*\{[^}]*width:\s*100%\s*!important/su);
  assert.match(themeCss, /@media \(max-width: 720px\)[\s\S]*\.graph-toolbar\s*\{[^}]*overflow-x:\s*auto/su);
  assert.match(themeCss, /\.inspector-tabs\s*\{[^}]*min-width:\s*0[^}]*overflow-x:\s*auto/su);
});
