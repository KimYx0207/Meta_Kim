import assert from "node:assert/strict";
import test from "node:test";
import { renderLiveControlRoomPage } from "../../src/presentation/live/live-control-room-page.mjs";
import { buildNativeZcodeLiveSnapshot } from "../../src/application/live/live-native-zcode-projection.mjs";
import { classifyGraphRelations, resolveDependencyGraphLayout, resolveGraphEdgePresentation } from "../../src/application/live/live-graph-readability.mjs";
import { loadLiveGraphLayoutPolicy } from "../../src/application/live/live-graph-layout.mjs";
import { loadLiveGraphCameraPolicy, resolveOverviewCamera } from "../../src/application/live/live-graph-camera.mjs";

const html = renderLiveControlRoomPage({});
const script = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
const css = html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
const narrowCss = [...css.matchAll(/@media \(max-width: 720px\) \{([\s\S]*?)\n\}/gu)].map((match) => match[1]).join("\n");
const executionKinds = ["sequence", "depends_on", "dependency", "fork", "join", "blocks", "execution", "invokes"];

test("a narrow run view retains SVG edges, scene transforms and overview/zoom controls", () => {
  assert.ok(narrowCss.length > 1000);
  for (const [, selectors, body] of narrowCss.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    for (const selector of selectors.split(",").map((value) => value.trim())) {
      if (selector.includes(':not([data-work-view="run"])')) continue;
      if (selector.includes(".edge-layer")) assert.doesNotMatch(body, /display:\s*none/u, selector);
      if (selector.includes(".graph-scene")) assert.doesNotMatch(body, /transform:\s*none|height:\s*auto\s*!important/u, selector);
      if (selector.includes(".node-card")) assert.doesNotMatch(body, /position:\s*relative\s*!important|width:\s*100%\s*!important|min-height:\s*166px/u, selector);
      if (/data-live-graph-(?:fit|zoom-out|zoom-in)/u.test(selector)) assert.doesNotMatch(body, /display:\s*none/u, selector);
    }
  }
  assert.match(narrowCss, /\[data-work-view="run"\] \.graph-canvas \{[^}]*overflow:\s*hidden;[^}]*touch-action:\s*none/u);
  assert.match(css, /\.graph-scene \{[^}]*position:\s*absolute;[^}]*transform-origin:\s*0 0/u);
});

test("compact node titles and status remain visible outside desktop-only media rules", () => {
  // Geometry alone passed while the real cells were blank. Inspect the shared
  // cell renderer after removing conditional media branches from the stylesheet.
  let sharedCss = "";
  let offset = 0;
  for (;;) {
    const start = css.indexOf("@media", offset);
    if (start < 0) { sharedCss += css.slice(offset); break; }
    sharedCss += css.slice(offset, start);
    const open = css.indexOf("{", start);
    let depth = 1;
    let end = open + 1;
    while (end < css.length && depth) {
      if (css[end] === "{") depth += 1;
      if (css[end] === "}") depth -= 1;
      end += 1;
    }
    offset = end;
  }
  assert.doesNotMatch(sharedCss, /\.graph-canvas\[data-semantic-zoom="cell"\] \.node-card > \* \{[^}]*visibility:\s*hidden/u);
  for (const child of ["node-card-top", "node-identity-row", "node-title"]) {
    assert.match(sharedCss, new RegExp(`\\.graph-canvas\\[data-semantic-zoom="cell"\\] \\.node-card \\.${child}[^{}]*\\{[^}]*visibility:\\s*visible`, "u"));
  }
  assert.match(sharedCss, /\.node-card \.node-title \{[^}]*font-size:\s*var\(--cell-title-fs\)/u);
  assert.match(sharedCss, /--cell-title-fs:[^;}]*calc\(var\(--fs-body\) \/ var\(--camera-scale\)\)/u);
  assert.match(sharedCss, /\.node-card \.node-card-top \{[^}]*font-size:[^;]*calc\(11px \/ var\(--camera-scale\)\)/u);
  assert.match(sharedCss, /\.node-card \.node-state-short \{\s*display:\s*inline/u);
});

test("narrow graph focus uses the same scene camera instead of scrolling a card list", () => {
  const start = script.indexOf("  function centerGraphNode(");
  const end = script.indexOf("\n  }", start);
  const centerSource = script.slice(start, end + 4);
  const updates = [];
  const graph = { clientWidth: 420, clientHeight: 360, scrollTo: () => assert.fail("run graph must use camera coordinates at narrow widths") };
  const position = { x: 300, y: 200, width: 252, height: 128 };
  const center = new Function("graph", "graphState", "camera", "updateCamera", "window", `${centerSource}; return centerGraphNode;`)(
    graph, { positions: new Map([["child", position]]) }, { x: 0, y: 0, scale: 0.5 }, (next) => updates.push(next), { matchMedia: () => ({ matches: true }) });
  center("child");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].x + (position.x + position.width / 2) * updates[0].scale, 210);
  assert.equal(updates[0].y + (position.y + position.height / 2) * updates[0].scale, 180);
});

test("the observed parent and two native Agent calls fit a connected 420 by 360 overview", () => {
  const snapshot = buildNativeZcodeLiveSnapshot({ state: "observed", binding: { projectRootMatched: true, sessionMetadataVerified: true, userTurnAnchorVerified: true },
    sessionId: "sess_11111111-1111-4111-8111-111111111111", turnId: "turn_22222222-2222-4222-8222-222222222222", startedAt: "2026-10-30T15:56:18Z",
    agents: [{ id: "call-l1", owner: "python-pro", taskName: "L1 holdings/sync 域修复", status: "running" }, { id: "call-l4", owner: "python-pro", taskName: "L4 策略域修复", status: "running" }], toolCalls: [] });
  const plan = classifyGraphRelations(snapshot.nodes, snapshot.edges, executionKinds);
  assert.equal(plan.executionNodes.length, 3);
  assert.equal(plan.executionEdges.length, 2);
  for (const edge of snapshot.edges) assert.equal(resolveGraphEdgePresentation(edge, { mode: "dependency", executionKinds, focusActive: false }).visible, true);
  const policy = loadLiveGraphLayoutPolicy();
  const camera = loadLiveGraphCameraPolicy();
  const mode = policy.modes.compact;
  const canvas = { width: 420, height: 360 };
  const inset = { top: 26, right: 26, bottom: 26, left: 26 };
  let scale = camera.minScale;
  let layout;
  let fit;
  for (let pass = 0; pass < 4; pass += 1) {
    layout = resolveDependencyGraphLayout({ plan, canvas, inset, tier: "cell", scale, cellScreenHeight: 64,
      cardWidth: policy.card.entityWidthPx, cardHeight: policy.card.measuredMinHeightPx,
      columnGap: mode.entityColumnStepPx - policy.card.entityWidthPx, rowGap: mode.entityRowGapPx, padding: policy.scenePaddingPx });
    fit = resolveOverviewCamera(canvas, layout.bounds, inset, camera);
    scale = fit.scale;
  }
  assert.equal(fit.wholeGraphFits, true);
  assert.equal(layout.positions.size, 3);
  for (const box of layout.positions.values()) {
    assert.ok(fit.x + box.x * fit.scale >= 0);
    assert.ok(fit.y + box.y * fit.scale >= 0);
    assert.ok(fit.x + (box.x + box.width) * fit.scale <= canvas.width + 0.5);
    assert.ok(fit.y + (box.y + box.height) * fit.scale <= canvas.height + 0.5);
  }
});
