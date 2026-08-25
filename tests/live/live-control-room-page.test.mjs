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
  assert.match(html, /<html[^>]+lang="en"/iu);
  assert.match(html, /<main\b/iu);
  assert.match(html, /data-snapshot-endpoint="\/api\/snapshot"/u);
  assert.match(html, /data-events-endpoint="\/api\/events"/u);
  assert.match(html, /rel="icon" href="data:image\/svg\+xml;base64,/u);
  assert.doesNotMatch(html, /<(?:script|link|img)[^>]+(?:https?:)?\/\//iu);
  assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:unpkg|jsdelivr|fonts\.googleapis)/iu);
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

  assert.match(html, /fetch\(snapshotEndpoint/iu);
  assert.match(html, /new\s+EventSource\(eventsEndpoint/iu);
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
  assert.match(html, /aria-controls="evidence-drawer"/iu);
  assert.match(html, /role="list"/iu);
  assert.match(html, /<svg\b[^>]*aria-hidden="true"/iu);
  assert.match(html, /data\.replayStatus|dataset\.replayStatus/u);
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
  });

  assert.match(html, /data-snapshot-endpoint="\/api\/snapshot\?view=control-room&amp;x=&quot;quoted&quot;"/u);
  assert.match(html, /data-events-endpoint="\/api\/events\?channel=live&amp;x=&lt;unsafe&gt;"/u);
  assert.doesNotMatch(html, /data-(?:snapshot|events)-endpoint="[^"]*<|data-(?:snapshot|events)-endpoint="[^"]*"[^>]*\bon/iu);
});

test("falls back from unsafe endpoints and circular initial snapshots", () => {
  const circular = {};
  circular.self = circular;
  const html = renderLiveControlRoomPage({
    snapshot: circular,
    snapshotEndpoint: "https://attacker.example/snapshot",
    eventsEndpoint: "//attacker.example/events",
  });
  assert.match(html, /data-snapshot-endpoint="\/api\/snapshot"/u);
  assert.match(html, /data-events-endpoint="\/api\/events"/u);
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
  assert.match(html, /graph-scene[^>]+style|transform:\translate/iu);
  assert.match(html, /data-live-graph-minimap/iu);
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
  assert.match(html, /data-replay-active|replay-active/iu);
  assert.match(html, /ArrowUp|ArrowDown|Enter/iu);
});

test("keeps the eight-stage spine distinct and derives omitted edge status from the target node", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /STAGE_MATCH_ORDER\s*=\s*\[\.\.\.STAGE_ORDER\]\.sort/iu);
  assert.match(html, /text\.startsWith\(stageName\s*\+\s*["']-["']\)/u);
  assert.match(html, /explicitStatus[\s\S]{0,500}nodeById\.get\(targetId\)\?\.status/u);
  assert.match(html, /edge-running[\s\S]{0,120}edge-flow/iu);
});

test("anchors the compact desktop cards and curved paths to one fixed geometry", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /const cardWidth\s*=\s*132/u);
  assert.match(html, /const cardHeight\s*=\s*76/u);
  assert.match(html, /\.node-card\s*\{[^}]*height:\s*76px/su);
  assert.match(html, /from\.x\s*\+\s*from\.width[\s\S]{0,250}to\.x/u);
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

test("uses explicit marker colors so SVG arrows do not inherit an unreliable currentColor", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /markerColors\s*=\s*\{[\s\S]*running:\s*["']#55e6d0["']/u);
  assert.match(html, /marker-end["'],\s*["']url\(#\s*["']\s*\+\s*edgeMarkerId/u);
  assert.doesNotMatch(html, /fill["'],\s*["']currentColor["']/u);
});

test("keeps the desktop workspace bounded and coalesces high-frequency snapshot updates", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /\.workspace-grid\s*\{[^}]*height:\s*430px/su);
  assert.match(html, /\.evidence-panel\s*\{[^}]*height:\s*430px[^}]*overflow:\s*hidden/su);
  assert.match(html, /\.evidence-drawer\s*\{[^}]*overflow:\s*auto/su);
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
  assert.doesNotMatch(html, /aria-pressed/u);
  assert.match(html, /replayPlay\.disabled\s*=\s*events\.length\s*<\s*2/u);
  assert.match(html, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/u);
  assert.match(html, /columnGap\s*=\s*layoutMode\s*===\s*["']compact["']\s*\?\s*126\s*:\s*144/u);
  assert.match(html, /\.node-meta\s*\{[^}]*flex-wrap:\s*nowrap/su);
  assert.match(html, /\.node-meta-item\s*\{[^}]*min-width:\s*0/su);
});
