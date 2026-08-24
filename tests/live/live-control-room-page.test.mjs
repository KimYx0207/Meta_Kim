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
