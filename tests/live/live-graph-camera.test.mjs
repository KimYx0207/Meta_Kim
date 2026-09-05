import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_GRAPH_CAMERA_SCHEMA_VERSION,
  loadLiveGraphCameraPolicy,
  normalizeLiveGraphCameraPolicy,
  resolveInspectorCameraLift,
  resolveOverviewCamera,
  resolveSemanticZoom,
  serializeCameraLegibilityCustomProperties,
  serializeGraphCameraPolicyForClient,
  serializeInspectorCameraLiftResolver,
  serializeOverviewCameraResolver,
  serializeSemanticZoomResolver,
} from "../../src/application/live/live-graph-camera.mjs";
import { loadLiveTypographyScale } from "../../src/application/live/live-typography-scale.mjs";
import { renderLiveControlRoomPage } from "../../src/presentation/live/live-control-room-page.mjs";

/**
 * The camera state measured in a real browser when the overview defect was
 * confirmed: tab at 1351x726 dpr 1.5, English locale, run `live-ui-regression`.
 * The canvas rect was l:24 t:266 r:1319 b:648 and the laid-out content bounding
 * box was about 1890x955 in scene coordinates. Clicking Overview produced
 * `matrix(0.68, 0, 0, 0.68, 26, 26)`: one of eight node cards fully visible, one
 * partially, six entirely off-canvas.
 *
 * These are the numbers the fix has to satisfy, so they are the fixture rather
 * than a rounded stand-in.
 */
const MEASURED_CANVAS = Object.freeze({ width: 1295, height: 382 });
const MEASURED_CONTENT = Object.freeze({ width: 1890, height: 955 });
const SYMMETRIC_INSET = Object.freeze({ top: 26, right: 26, bottom: 26, left: 26 });
const DEFECT_SCALE = 0.68;

function fixtureSnapshot() {
  return {
    schemaVersion: "meta-kim-live-snapshot-v2",
    run: { id: "live-ui-regression", title: "Overview fit regression", active: true },
    nodes: [],
    edges: [],
    evidence: [],
    prompts: [],
    provenance: [],
    toolCalls: [],
    replay: [],
    stages: [],
  };
}

function clientScriptOf(html) {
  const start = html.lastIndexOf("<script>");
  const end = html.indexOf("</script>", start);
  assert.ok(start >= 0 && end > start, "rendered page must contain a client script");
  return html.slice(start + "<script>".length, end);
}

test("the shipped graph-camera document validates and orders every scale bound", () => {
  const policy = loadLiveGraphCameraPolicy();

  assert.equal(policy.schemaVersion, LIVE_GRAPH_CAMERA_SCHEMA_VERSION);
  assert.ok(policy.minScale > 0, "minScale must be positive");
  assert.ok(
    policy.minScale <= policy.semanticZoomCellMaxScale,
    "minScale must not exceed the cell-LOD boundary, or the reduced rendering is unreachable",
  );
  assert.ok(
    policy.semanticZoomCellMaxScale <= policy.overviewMaxScale,
    "the cell boundary must sit at or below the overview ceiling",
  );
  assert.ok(
    policy.overviewMaxScale <= policy.maxScale,
    "overview must never exceed what manual zoom permits",
  );
  assert.ok(policy.zoomOutFactor < 1 && policy.zoomInFactor > 1, "zoom factors must straddle 1");
  assert.ok(Number.isFinite(policy.fitPaddingPx) && policy.fitPaddingPx >= 0);
});

test("a floor above the cell boundary is unrepresentable, because it would strand the reduced rendering", () => {
  const base = loadLiveGraphCameraPolicy();

  assert.throws(
    () => normalizeLiveGraphCameraPolicy({ ...base, minScale: base.semanticZoomCellMaxScale + 0.1 }),
    (error) => error.code === "LIVE_GRAPH_CAMERA_CELL_LOD_UNREACHABLE",
  );
});

test("a floor above the overview ceiling is unrepresentable", () => {
  const base = loadLiveGraphCameraPolicy();

  assert.throws(
    () => normalizeLiveGraphCameraPolicy({ ...base, overviewMaxScale: base.maxScale + 0.5 }),
    (error) => error.code === "LIVE_GRAPH_CAMERA_OVERVIEW_ABOVE_MAX",
  );
});

test("overview fits the whole graph at the viewport where the defect was measured", () => {
  const policy = loadLiveGraphCameraPolicy();
  const fit = resolveOverviewCamera(MEASURED_CANVAS, MEASURED_CONTENT, SYMMETRIC_INSET, policy);

  assert.equal(fit.wholeGraphFits, true, "the measured graph must fit, it is what the user reported as broken");
  assert.ok(
    fit.scale < DEFECT_SCALE,
    `overview must shrink below the removed ${DEFECT_SCALE} floor, resolved ${fit.scale}`,
  );

  const right = fit.x + MEASURED_CONTENT.width * fit.scale;
  const bottom = fit.y + MEASURED_CONTENT.height * fit.scale;
  assert.ok(fit.x >= SYMMETRIC_INSET.left - 0.5, `left edge ${fit.x} must clear the inset`);
  assert.ok(fit.y >= SYMMETRIC_INSET.top - 0.5, `top edge ${fit.y} must clear the inset`);
  assert.ok(
    right <= MEASURED_CANVAS.width - SYMMETRIC_INSET.right + 0.5,
    `right edge ${right} must stay inside the canvas`,
  );
  assert.ok(
    bottom <= MEASURED_CANVAS.height - SYMMETRIC_INSET.bottom + 0.5,
    `bottom edge ${bottom} must stay inside the canvas`,
  );
});

test("overview never zooms past what fitting requires", () => {
  const policy = loadLiveGraphCameraPolicy();
  const contents = [
    { width: 1890, height: 955 },
    { width: 3200, height: 1800 },
    { width: 640, height: 300 },
    { width: 120, height: 90 },
  ];

  for (const content of contents) {
    const fit = resolveOverviewCamera(MEASURED_CANVAS, content, SYMMETRIC_INSET, policy);
    const usableWidth = MEASURED_CANVAS.width - SYMMETRIC_INSET.left - SYMMETRIC_INSET.right;
    const usableHeight = MEASURED_CANVAS.height - SYMMETRIC_INSET.top - SYMMETRIC_INSET.bottom;
    const required = Math.min(usableWidth / content.width, usableHeight / content.height);
    if (required <= policy.overviewMaxScale && required >= policy.minScale) {
      assert.ok(
        fit.scale <= required + 1e-9,
        `content ${content.width}x${content.height} needs ${required} but overview used ${fit.scale}`,
      );
      assert.equal(fit.wholeGraphFits, true);
    }
    assert.ok(fit.scale >= policy.minScale, "overview must respect the shared manual-zoom floor");
    assert.ok(fit.scale <= policy.overviewMaxScale, "overview must respect its own ceiling");
  }
});

test("a graph too large even for the floor reports a clipped overview instead of claiming a fit", () => {
  const policy = loadLiveGraphCameraPolicy();
  const oversized = { width: 40_000, height: 40_000 };
  const fit = resolveOverviewCamera(MEASURED_CANVAS, oversized, SYMMETRIC_INSET, policy);

  assert.equal(fit.wholeGraphFits, false);
  assert.equal(fit.scale, policy.minScale, "a clipped overview still parks at the floor, not above it");
  assert.equal(fit.x, SYMMETRIC_INSET.left);
  assert.equal(fit.y, SYMMETRIC_INSET.top);
});

test("degenerate canvas or content geometry reports no fit rather than dividing by zero", () => {
  const policy = loadLiveGraphCameraPolicy();

  for (const [canvas, content] of [
    [{ width: 0, height: 0 }, MEASURED_CONTENT],
    [MEASURED_CANVAS, { width: 0, height: 955 }],
    [{ width: 40, height: 40 }, MEASURED_CONTENT],
  ]) {
    const fit = resolveOverviewCamera(canvas, content, SYMMETRIC_INSET, policy);
    assert.equal(fit.wholeGraphFits, false);
    assert.ok(Number.isFinite(fit.scale) && fit.scale > 0, `scale ${fit.scale} must stay finite and positive`);
    assert.ok(Number.isFinite(fit.x) && Number.isFinite(fit.y));
  }
});

test("the cell rendering is selected by the same boundary the policy declares", () => {
  const policy = loadLiveGraphCameraPolicy();

  assert.equal(resolveSemanticZoom(policy.semanticZoomCellMaxScale - 0.01, policy), "cell");
  assert.equal(resolveSemanticZoom(policy.semanticZoomCellMaxScale, policy), "card");
  assert.equal(resolveSemanticZoom(policy.minScale, policy), "cell");
});

test("the shipped page inlines the resolvers rather than forking their arithmetic", () => {
  const html = renderLiveControlRoomPage({ snapshot: fixtureSnapshot() });
  const script = clientScriptOf(html);

  assert.ok(script.includes(serializeOverviewCameraResolver()), "overview resolver source must be inlined verbatim");
  assert.ok(script.includes(serializeSemanticZoomResolver()), "semantic-zoom resolver source must be inlined verbatim");
  assert.ok(
    script.includes(serializeInspectorCameraLiftResolver()),
    "inspector-lift resolver source must be inlined verbatim",
  );
  assert.ok(
    script.includes(JSON.stringify(serializeGraphCameraPolicyForClient(loadLiveGraphCameraPolicy()))),
    "the camera policy literal must come from config, not from a second copy in the page",
  );
});

test("the client script keeps no camera scale literal of its own", () => {
  const html = renderLiveControlRoomPage({ snapshot: fixtureSnapshot() });
  const script = clientScriptOf(html);
  // The two resolver sources are inlined at separate sites, so each is removed
  // on its own. Stripping their concatenation would match nothing and silently
  // widen the assertion to the resolver bodies too.
  const pageOwned = [
    serializeOverviewCameraResolver(),
    serializeSemanticZoomResolver(),
    serializeInspectorCameraLiftResolver(),
  ].reduce((rest, source) => rest.split(source).join(""), script);

  assert.ok(pageOwned.length < script.length, "both resolver sources must actually be found and stripped");
  for (const literal of [
    /const minimumLegibleScale/u,
    /width\s*<=\s*1024\s*\?\s*1\s*:\s*\.68/u,
    /Math\.min\(1\.1,/u,
    /camera\.scale\s*<\s*\.42/u,
    /Math\.max\(\.28,\s*Math\.min\(1\.6,/u,
    /const GRAPH_FIT_PADDING = 26/u,
  ]) {
    assert.doesNotMatch(pageOwned, literal, `camera literal ${literal} must live in config`);
  }
});

test("the camera declares an on-screen text floor, and that floor is measurably needed", () => {
  const camera = loadLiveGraphCameraPolicy();
  const typography = loadLiveTypographyScale();

  assert.ok(
    Number.isFinite(camera.minOnScreenTextPx) && camera.minOnScreenTextPx > 0,
    "the camera must declare the smallest text it is willing to leave on screen",
  );

  // Necessity, not preference. The type ladder's floor is a CSS-pixel floor,
  // and the camera multiplies CSS pixels by its scale, so the ladder cannot see
  // this failure at all. `--fs-entity-body` resolves smallest at the base
  // clamp's own minimum, which is the worst case a reader can reach.
  const rootPx = typography.legibility.rootFontSizePx;
  const baseMinPx = Number.parseFloat(typography.base.min) * rootPx;
  const entityBodyRatio = typography.steps.find((step) => step.name === "entity-body").ratio;
  const cellTitleWorldPx = baseMinPx * entityBodyRatio;
  const onScreenWithoutFloor = cellTitleWorldPx * camera.minScale;

  assert.ok(
    onScreenWithoutFloor < camera.minOnScreenTextPx,
    `a world-space cell title renders ${onScreenWithoutFloor.toFixed(2)}px on screen at minScale `
      + `${camera.minScale}; if that already cleared ${camera.minOnScreenTextPx}px the floor would be decoration`,
  );

  assert.ok(
    camera.minOnScreenTextPx <= typography.legibility.minimumRenderedPixels,
    "the camera floor must not exceed the type ladder's own floor, or the camera would be overruling the "
      + "typography authority about how big the smallest step is",
  );
});

/**
 * The smallest world-space text a full node card can declare, in CSS pixels,
 * derived rather than remembered. `clamp()` cannot resolve below `base.min`, so
 * that bound is the worst case a reader can reach, and the ladder's smallest
 * step is the smallest size any card child can name. Deriving from the ladder
 * instead of enumerating `.node-*` selectors keeps this honest when a card gains
 * a child: a new selector can only pick an existing step, and every step is
 * already covered by the minimum.
 */
function smallestCardTextPx(typography) {
  const baseMinPx = Number.parseFloat(typography.base.min) * typography.legibility.rootFontSizePx;
  return baseMinPx * Math.min(...typography.steps.map((step) => step.ratio));
}

test("full cards are never drawn at a scale where their own smallest step is below the floor", () => {
  const camera = loadLiveGraphCameraPolicy();
  const typography = loadLiveTypographyScale();

  // The symmetric half of the guard above, and the half that was missing. A cell
  // title counter-scales, so it holds the floor by construction. A full card
  // declares world-space sizes, so the only thing between it and sub-floor text
  // is the scale at which the camera stops drawing full cards -- and that
  // threshold was hand-set, so nothing tied it to the sizes it protects.
  //
  // Measured in a browser at 1760x900 before this guard existed: the fitted
  // scale was 0.4582, just above a 0.42 threshold, so `data-semantic-zoom` read
  // "card" and all 12 text elements in a node rendered between 5.46px and
  // 9.01px against a declared 11px floor. The threshold was not too small by a
  // rounding error; it was below every scale a card is legible at.
  const requiredScale = camera.minOnScreenTextPx / smallestCardTextPx(typography);

  assert.ok(
    camera.semanticZoomCellMaxScale >= requiredScale,
    `full cards begin at scale ${camera.semanticZoomCellMaxScale}, where the smallest card step renders `
      + `${(smallestCardTextPx(typography) * camera.semanticZoomCellMaxScale).toFixed(2)}px against a `
      + `${camera.minOnScreenTextPx}px floor. Cards need scale ${requiredScale.toFixed(4)}; every scale `
      + "between the two is a band that draws a full card no reader can read",
  );
});

test("normalization rejects a card boundary below the scale the type ladder requires", () => {
  const base = loadLiveGraphCameraPolicy();
  const typography = loadLiveTypographyScale();
  const requiredScale = base.minOnScreenTextPx / smallestCardTextPx(typography);

  // Unrepresentable rather than discouraged, the same way `minScale` above the
  // cell boundary is unrepresentable. A boundary below this value is exactly the
  // defect shape: a legibility floor with a rendering mode that ignores it.
  assert.throws(
    () => normalizeLiveGraphCameraPolicy({
      ...base,
      minScale: requiredScale / 4,
      semanticZoomCellMaxScale: requiredScale / 2,
    }),
    /full card at that scale renders text below minOnScreenTextPx/u,
    "a card boundary under the derived requirement must be rejected, not merely noted",
  );

  // And the accepted side has to stay accepted, or the guard would be refusing
  // the only value that satisfies it.
  assert.doesNotThrow(() => normalizeLiveGraphCameraPolicy({
    ...base,
    semanticZoomCellMaxScale: requiredScale,
  }));
});

test("the legibility custom properties carry the floor and a scale that defaults to 1", () => {
  const camera = loadLiveGraphCameraPolicy();
  const css = serializeCameraLegibilityCustomProperties(camera);

  assert.match(css, new RegExp(`--min-onscreen-text-px:\\s*${camera.minOnScreenTextPx}px`, "u"));
  // The client republishes `--camera-scale` on every camera write. The default
  // has to be 1 so a page that never moves the camera still divides by a real
  // number instead of resolving the whole `calc()` to an invalid value.
  assert.match(css, /--camera-scale:\s*1\b/u);
});

test("normalization rejects a missing or non-positive on-screen text floor", () => {
  const base = loadLiveGraphCameraPolicy();

  for (const broken of [undefined, 0, -3, "9px", Number.NaN]) {
    assert.throws(
      () => normalizeLiveGraphCameraPolicy({ ...base, minOnScreenTextPx: broken }),
      /minOnScreenTextPx must be a positive number/u,
      `minOnScreenTextPx ${String(broken)} must be rejected`,
    );
  }
});

test("the cell rendering sizes its title and band from the on-screen floor, not from world pixels", () => {
  const html = renderLiveControlRoomPage({ snapshot: fixtureSnapshot() });
  const camera = loadLiveGraphCameraPolicy();

  assert.ok(
    html.includes(serializeCameraLegibilityCustomProperties(camera)),
    "the root must publish the legibility tokens from config",
  );
  // The scale is published on the same element that carries `data-semantic-zoom`
  // because both describe one camera state, and the cell rules that divide by it
  // are matched on that element. Publishing it on the scaled scene instead would
  // leave the rules resolving the `:root` default of 1 at every real scale.
  assert.match(
    html,
    /graph\.dataset\.semanticZoom = resolveSemanticZoom\(camera\.scale, GRAPH_CAMERA\);\s*graph\.style\.setProperty\("--camera-scale", String\(camera\.scale\)\)/u,
    "every camera write must republish --camera-scale next to the semantic-zoom write",
  );

  assert.match(
    html,
    /--cell-title-fs:\s*max\(var\(--fs-entity-body\),\s*calc\(var\(--min-onscreen-text-px\)\s*\/\s*var\(--camera-scale\)\)\)/u,
    "the cell title must be the larger of its ladder step and the counter-scaled floor",
  );
  assert.match(
    html,
    /--cell-band-h:\s*max\(26px,\s*calc\(var\(--cell-title-fs\)\s*\*\s*var\(--lh-flat\)\s*\+\s*var\(--sp-snug\)\s*\*\s*2\)\)/u,
    "the band has to grow with the title it contains, or a legible title overflows an illegible band",
  );
  assert.doesNotMatch(
    html,
    /data-semantic-zoom="cell"\] \.node-card \.node-title \{[^}]*font-size:\s*var\(--fs-entity-body\)/su,
    "the cell title must not keep a world-space font size beside the counter-scaled one",
  );
});

test("cell mode has no per-node escape hatch back to full cards", () => {
  const html = renderLiveControlRoomPage({ snapshot: fixtureSnapshot() });

  // This used to be asserted the other way round: a node with capabilities was
  // exempted from cell mode and rendered a full 176px card with every child
  // visible. At the overview scale that put ~4px text on screen and the old
  // assertion pinned it in place, which is why the defect survived a green suite.
  assert.doesNotMatch(
    html,
    /data-semantic-zoom="cell"\] \.node-card\[data-has-capabilities="true"\]/u,
    "a node may not opt out of the level of detail the camera scale selected",
  );
});

test("the follow-mode zoom floor comes from the cell boundary in config", () => {
  const html = renderLiveControlRoomPage({ snapshot: fixtureSnapshot() });

  assert.match(
    html,
    /resolveInspectorCameraLift\(\s*\{ inspectorOpen: inspectorOpen && cameraMode === "follow", scale: camera\.scale, liftedFrom: inspectorCameraLiftOrigin \},\s*GRAPH_CAMERA,\s*\)/u,
    "follow mode must lift the camera through the shared resolver, not through its own comparison",
  );
  assert.doesNotMatch(html, /camera\.scale < \.68/u, "the 0.68 literal must be gone from the page");
  assert.doesNotMatch(
    html,
    /camera\.scale < GRAPH_CAMERA\.semanticZoomCellMaxScale\) updateCamera/u,
    "the page must not keep its own one-way lift beside the reversible resolver",
  );
});

/**
 * The lift was measured in a real browser as 0.5884 -> 0.991 on opening the
 * inspector, and closing it left the camera at 0.991: the scale the user had
 * chosen was gone for the rest of the session. These cases pin the round trip.
 */
test("opening the inspector lifts the camera and closing it gives the scale back", () => {
  const policy = loadLiveGraphCameraPolicy();
  const target = policy.semanticZoomCellMaxScale;
  const chosen = target - 0.4;

  const lifted = resolveInspectorCameraLift({ inspectorOpen: true, scale: chosen, liftedFrom: null }, policy);
  assert.equal(lifted.scale, target, "an inspector open below the card boundary must lift to the boundary");
  assert.equal(lifted.liftedFrom, chosen, "the lift must remember the scale it replaced");

  const held = resolveInspectorCameraLift(
    { inspectorOpen: true, scale: lifted.scale, liftedFrom: lifted.liftedFrom },
    policy,
  );
  assert.equal(held.scale, target, "a reconcile while the inspector stays open must not move the camera again");
  assert.equal(held.liftedFrom, chosen, "the memory must survive every reconcile the open inspector triggers");

  const restored = resolveInspectorCameraLift(
    { inspectorOpen: false, scale: held.scale, liftedFrom: held.liftedFrom },
    policy,
  );
  assert.equal(restored.scale, chosen, "closing the inspector must return the camera to the user's own scale");
  assert.equal(restored.liftedFrom, null, "a completed round trip must leave no memory to replay");
});

test("a scale the user chose while the inspector was open is theirs to keep", () => {
  const policy = loadLiveGraphCameraPolicy();
  const target = policy.semanticZoomCellMaxScale;
  const chosen = target - 0.4;
  const theirs = policy.maxScale;

  const kept = resolveInspectorCameraLift({ inspectorOpen: false, scale: theirs, liftedFrom: chosen }, policy);
  assert.equal(kept.scale, theirs, "a scale that is no longer the lifted value must not be overwritten on close");
  assert.equal(kept.liftedFrom, null, "the stale memory must be dropped rather than kept for the next close");

  const noop = resolveInspectorCameraLift({ inspectorOpen: false, scale: chosen, liftedFrom: null }, policy);
  assert.equal(noop.scale, chosen, "a close with no outstanding lift must leave the camera alone");
  assert.equal(noop.liftedFrom, null);
});

test("an inspector opened at or above the card boundary records no lift to undo", () => {
  const policy = loadLiveGraphCameraPolicy();
  const target = policy.semanticZoomCellMaxScale;

  const atBoundary = resolveInspectorCameraLift({ inspectorOpen: true, scale: target, liftedFrom: null }, policy);
  assert.equal(atBoundary.scale, target);
  assert.equal(atBoundary.liftedFrom, null, "no lift happened, so closing must not pull the camera down to it");

  const above = resolveInspectorCameraLift({ inspectorOpen: true, scale: policy.maxScale, liftedFrom: null }, policy);
  assert.equal(above.scale, policy.maxScale, "a camera already past the boundary must not be dragged back to it");
  assert.equal(above.liftedFrom, null);
});

/**
 * A second lift while the inspector is still open — a resize or a mode round trip
 * can drop the scale below the boundary again — must not renumber the origin. The
 * scale worth restoring is the one the user had before the inspector took over,
 * not whatever the camera happened to be showing between two lifts.
 */
test("a second lift keeps the origin the first one recorded", () => {
  const policy = loadLiveGraphCameraPolicy();
  const target = policy.semanticZoomCellMaxScale;
  const chosen = target - 0.4;
  const intermediate = target - 0.1;

  const relifted = resolveInspectorCameraLift(
    { inspectorOpen: true, scale: intermediate, liftedFrom: chosen },
    policy,
  );
  assert.equal(relifted.scale, target, "a scale back below the boundary must be lifted again");
  assert.equal(relifted.liftedFrom, chosen, "the origin must stay the pre-inspector scale, not the intermediate one");

  const restored = resolveInspectorCameraLift(
    { inspectorOpen: false, scale: relifted.scale, liftedFrom: relifted.liftedFrom },
    policy,
  );
  assert.equal(restored.scale, chosen, "closing after two lifts must still land on the user's own scale");
});

test("a clipped overview is labelled as clipped in both locales", () => {
  const html = renderLiveControlRoomPage({ snapshot: fixtureSnapshot() });
  const script = clientScriptOf(html);

  assert.match(script, /setCameraMode\("overview",\s*\w+\.wholeGraphFits\)/u);
  assert.match(script, /dataset\.overviewClipped/u);
  assert.match(script, /"Overview · partial"/u);
  assert.match(script, /"Overview · partial":\s*"总览 · 局部"/u);
});
