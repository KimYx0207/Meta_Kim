import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  LIVE_GRAPH_CHAIN_ORIENTATIONS,
  LIVE_GRAPH_LAYOUT_CONFIG_URL,
  LIVE_GRAPH_LAYOUT_SCHEMA_VERSION,
  loadLiveGraphLayoutPolicy,
  normalizeLiveGraphLayoutPolicy,
  resolveFanoutArrangement,
  resolveMeasuredCardMetrics,
  resolveNodeCardHeight,
  serializeFanoutArrangementResolver,
  serializeGraphLayoutPolicyForClient,
  serializeMeasuredCardMetricsResolver,
  serializeNodeCardHeightResolver,
} from "../../src/application/live/live-graph-layout.mjs";
import { loadLiveGraphCameraPolicy } from "../../src/application/live/live-graph-camera.mjs";

/**
 * The browser numbers that exposed the defect, at window 1707x825 dpr 1.5 with the
 * eight-stage rail expanded. These are the measurements the fix has to satisfy, so
 * they are the fixture rather than a rounded stand-in.
 *
 * The defect: the parent's fifteen children were placed in one unwrapped row,
 * giving a 4984x1180 scene. Fitting that into this canvas needs 0.257x, below the
 * camera's 0.28 minScale, so the camera declared the graph unfittable, kept scale
 * 1 with no translate, and left the owner chain and most of the row outside the
 * viewport. The first child card measured at viewport x=2365 against innerWidth
 * 1707.
 */
const MEASURED_CANVAS = Object.freeze({ width: 1651.3, height: 333.8 });
const MEASURED_CHILD_COUNT = 15;
const MEASURED_CHAIN_LENGTH = 2;
const DEFECT_SINGLE_ROW_SCENE = Object.freeze({ width: 4984, height: 1180 });
const SYMMETRIC_INSET = Object.freeze({ top: 26, right: 26, bottom: 26, left: 26 });

/**
 * Capability strips as a browser rendered them, at innerWidth 1738 dpr 1 with the
 * graph in card presentation and each card's previous reservation cleared off it
 * first. Untransformed box heights, so these are world px -- the unit the layout
 * reserves in -- not the post-transform screen px a bounding rect would report.
 *
 * Both row counts agree on the geometry: 74 = 1*74 + 0*6 and 154 = 2*74 + 1*6, so a
 * chip row is 74px tall, rows sit 6px apart, and the step one row adds is 80. The
 * configuration estimates that step at 40, which is half of it. What is left of a
 * card once its strip and the folded gap are removed is its chrome, and that does
 * legitimately vary -- 175 to 203 here -- because a long node name wraps to a
 * second line.
 */
const MEASURED_CAPABILITY_STRIPS = Object.freeze([
  Object.freeze({ cardHeightPx: 278, stripHeightPx: 74, rowGapPx: 6, renderedRows: 1, renderedColumns: 2, chips: 1 }),
  Object.freeze({ cardHeightPx: 255, stripHeightPx: 74, rowGapPx: 6, renderedRows: 1, renderedColumns: 2, chips: 1 }),
  Object.freeze({ cardHeightPx: 363, stripHeightPx: 154, rowGapPx: 6, renderedRows: 2, renderedColumns: 2, chips: 4 }),
  Object.freeze({ cardHeightPx: 335, stripHeightPx: 154, rowGapPx: 6, renderedRows: 2, renderedColumns: 2, chips: 4 }),
]);
const MEASURED_CAPABILITY_ROW_STEP = 80;
const MEASURED_CARD_CHROME = 203;

function arrangementRequest(overrides = {}) {
  const policy = overrides.policy || loadLiveGraphLayoutPolicy();
  return {
    childCount: MEASURED_CHILD_COUNT,
    chainLength: MEASURED_CHAIN_LENGTH,
    mode: policy.defaultMode,
    canvas: { ...MEASURED_CANVAS },
    inset: { ...SYMMETRIC_INSET },
    childWidth: policy.card.entityWidthPx,
    childHeight: policy.card.measuredMinHeightPx,
    chainWidth: policy.card.entityWidthPx,
    chainHeight: policy.card.measuredMinHeightPx,
    ...overrides.request,
  };
}

function policyDocument() {
  return {
    schemaVersion: LIVE_GRAPH_LAYOUT_SCHEMA_VERSION,
    card: {
      entityWidthPx: 252,
      stageWidthPx: 228,
      baseHeightPx: 112,
      capabilityRowHeightPx: 40,
      capabilitiesPerRow: 2,
      measuredMinHeightPx: 333,
    },
    defaultMode: "compact",
    modes: {
      compact: {
        childColumnStepPx: 328,
        childRowGapPx: 88,
        chainColumnStepPx: 328,
        chainRowGapPx: 104,
        chainToBlockGapPx: 28,
        entityColumnStepPx: 356,
        entityRowGapPx: 88,
        stageColumns: 4,
        stageColumnGapPx: 276,
        stageRowGapPx: 206,
      },
      flow: {
        childColumnStepPx: 356,
        childRowGapPx: 104,
        chainColumnStepPx: 356,
        chainRowGapPx: 124,
        chainToBlockGapPx: 44,
        entityColumnStepPx: 384,
        entityRowGapPx: 104,
        stageColumns: 8,
        stageColumnGapPx: 248,
        stageRowGapPx: 190,
      },
    },
    scenePaddingPx: { top: 44, right: 96, bottom: 96, left: 44 },
    sceneMinimumPx: { entityWidth: 760, entityHeight: 420, stageWidth: 760, stageHeight: 300 },
    stageScenePaddingPx: { top: 38, right: 48, bottom: 42, left: 40, branchGap: 32 },
    renderedColumnGapPx: 88,
    fanout: { minimumChildren: 4, chainOrientations: ["chain-horizontal", "chain-vertical"] },
  };
}

test("the shipped layout configuration loads and declares both page layout modes", () => {
  const policy = loadLiveGraphLayoutPolicy();
  assert.equal(policy.schemaVersion, LIVE_GRAPH_LAYOUT_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(policy.modes).sort(), ["compact", "flow"]);
  assert.equal(policy.defaultMode, "compact", "compact is the mode the page starts in");
});

test("fifteen children on the measured canvas are wrapped instead of placed in one row", () => {
  const policy = loadLiveGraphLayoutPolicy();
  const arrangement = resolveFanoutArrangement(arrangementRequest({ policy }), policy);

  // The literal is the defect's own column count. Asserting `columns < childCount`
  // alone would also pass at fourteen columns, which is the same defect one card
  // narrower.
  assert.notEqual(arrangement.columns, 15, "fifteen children must not occupy fifteen columns");
  assert.ok(arrangement.rows > 1, `expected more than one row, received ${arrangement.rows}`);
  assert.ok(
    arrangement.columns > 1,
    `expected more than one column, received ${arrangement.columns}: a single column is the same defect rotated`,
  );
  assert.ok(
    arrangement.sceneWidth < DEFECT_SINGLE_ROW_SCENE.width,
    `expected a scene narrower than the ${DEFECT_SINGLE_ROW_SCENE.width}px defect, received ${arrangement.sceneWidth}`,
  );
});

test("the wrapped arrangement clears the camera's minimum scale, which the single row did not", () => {
  const policy = loadLiveGraphLayoutPolicy();
  const camera = loadLiveGraphCameraPolicy();
  const arrangement = resolveFanoutArrangement(arrangementRequest({ policy }), policy);

  // This is the assertion that names the user-visible symptom. Below minScale the
  // camera returns wholeGraphFits false and stops centring, which is why the owner
  // chain and most of the row rendered outside the viewport.
  const usableWidth = MEASURED_CANVAS.width - SYMMETRIC_INSET.left - SYMMETRIC_INSET.right;
  const usableHeight = MEASURED_CANVAS.height - SYMMETRIC_INSET.top - SYMMETRIC_INSET.bottom;
  const defectScale = Math.min(
    usableWidth / DEFECT_SINGLE_ROW_SCENE.width,
    usableHeight / DEFECT_SINGLE_ROW_SCENE.height,
  );
  assert.ok(
    defectScale < camera.minScale,
    `the recorded defect scene must be the unfittable one: ${defectScale} should be below ${camera.minScale}`,
  );
  assert.ok(
    arrangement.fittedScale >= camera.minScale,
    `the chosen arrangement must be fittable: ${arrangement.fittedScale} should reach ${camera.minScale}`,
  );
});

test("the chosen arrangement is the highest-scoring one over every orientation and column count", () => {
  const policy = loadLiveGraphLayoutPolicy();
  const request = arrangementRequest({ policy });
  const chosen = resolveFanoutArrangement(request, policy);

  // Rescoring the candidates through the resolver itself would only prove the
  // resolver agrees with the resolver, so the alternatives below are scored from
  // the configuration by hand. If the search ever stops at the first candidate or
  // skips an orientation, the hand-scored winner will beat the returned one.
  const alternatives = [];
  for (const orientation of LIVE_GRAPH_CHAIN_ORIENTATIONS) {
    for (let columns = 1; columns <= MEASURED_CHILD_COUNT; columns += 1) {
      const rows = Math.ceil(MEASURED_CHILD_COUNT / columns);
      const mode = policy.modes[policy.defaultMode];
      const blockWidth = (columns - 1) * mode.childColumnStepPx + request.childWidth;
      const blockHeight = rows * request.childHeight + (rows - 1) * mode.childRowGapPx;
      const chainGap = mode.chainToBlockGapPx;
      let sceneWidth;
      let sceneHeight;
      if (orientation === "chain-horizontal") {
        const chainWidth = (MEASURED_CHAIN_LENGTH - 1) * mode.chainColumnStepPx + request.chainWidth;
        sceneWidth = policy.scenePaddingPx.left + chainWidth + chainGap + blockWidth + policy.scenePaddingPx.right;
        sceneHeight = policy.scenePaddingPx.top + Math.max(request.chainHeight, blockHeight) + policy.scenePaddingPx.bottom;
      } else {
        sceneWidth = policy.scenePaddingPx.left + Math.max(request.chainWidth, blockWidth) + policy.scenePaddingPx.right;
        const chainHeight = MEASURED_CHAIN_LENGTH * request.chainHeight + (MEASURED_CHAIN_LENGTH - 1) * mode.chainRowGapPx;
        sceneHeight = policy.scenePaddingPx.top + chainHeight + chainGap + blockHeight + policy.scenePaddingPx.bottom;
      }
      sceneWidth = Math.max(policy.sceneMinimumPx.entityWidth, sceneWidth);
      sceneHeight = Math.max(policy.sceneMinimumPx.entityHeight, sceneHeight);
      const usableWidth = request.canvas.width - request.inset.left - request.inset.right;
      const usableHeight = request.canvas.height - request.inset.top - request.inset.bottom;
      alternatives.push({
        orientation,
        columns,
        fittedScale: Math.min(usableWidth / sceneWidth, usableHeight / sceneHeight),
      });
    }
  }

  const bestAlternative = alternatives.reduce((best, item) => (item.fittedScale > best.fittedScale ? item : best));
  assert.ok(
    chosen.fittedScale >= bestAlternative.fittedScale - 1e-9,
    `chosen ${chosen.orientation}/${chosen.columns} at ${chosen.fittedScale} lost to ${bestAlternative.orientation}/${bestAlternative.columns} at ${bestAlternative.fittedScale}`,
  );
});

test("the measured canvas resolves to the arrangement recorded from the browser", () => {
  const policy = loadLiveGraphLayoutPolicy();
  const arrangement = resolveFanoutArrangement(arrangementRequest({ policy }), policy);

  // Hardcoded rather than recomputed. A derived expectation would agree with a
  // resolver that had quietly stopped searching, because both sides would come
  // from the same arithmetic.
  assert.equal(arrangement.orientation, "chain-horizontal");
  assert.equal(arrangement.columns, 8);
  assert.equal(arrangement.rows, 2);
  assert.equal(arrangement.sceneWidth, 3296);
  assert.equal(arrangement.sceneHeight, 894);
});

test("the search reaches the same winner whichever orientation the configuration lists first", () => {
  const policy = loadLiveGraphLayoutPolicy();
  const request = arrangementRequest({ policy });
  const horizontalFirst = normalizeLiveGraphLayoutPolicy({
    ...policyDocument(),
    fanout: { minimumChildren: 4, chainOrientations: ["chain-horizontal", "chain-vertical"] },
  });
  const verticalFirst = normalizeLiveGraphLayoutPolicy({
    ...policyDocument(),
    fanout: { minimumChildren: 4, chainOrientations: ["chain-vertical", "chain-horizontal"] },
  });

  // Both documents offer both orientations, so this is not a test of the array
  // order: it asserts the search scores every candidate rather than settling for
  // the first one it visits. A first-match implementation would return the vertical
  // chain from the second document, which is the arrangement the page used to
  // hardcode and the one that put the graph off screen.
  const fromHorizontal = resolveFanoutArrangement(request, horizontalFirst);
  const fromVertical = resolveFanoutArrangement(request, verticalFirst);
  assert.equal(fromHorizontal.orientation, "chain-horizontal");
  assert.equal(fromVertical.orientation, "chain-horizontal");
  assert.equal(fromHorizontal.columns, fromVertical.columns);
});

test("the column count follows the canvas shape rather than a configured constant", () => {
  const policy = loadLiveGraphLayoutPolicy();
  const short = resolveFanoutArrangement(arrangementRequest({ policy }), policy);
  const tall = resolveFanoutArrangement(
    arrangementRequest({ policy, request: { canvas: { width: 1651.3, height: 900 } } }),
    policy,
  );
  const narrow = resolveFanoutArrangement(
    arrangementRequest({ policy, request: { canvas: { width: 900, height: 700 } } }),
    policy,
  );

  // Three canvases, three arrangements. If any pair matched, the search would be
  // returning a fixed grid and the automatic part of "automatically computed"
  // would be doing nothing.
  assert.equal(short.columns, 8);
  assert.equal(tall.columns, 5);
  assert.equal(narrow.columns, 4);
  assert.equal(tall.rows, 3);
  assert.equal(narrow.rows, 4);
});

test("widening the configured column step widens the scene the camera is asked to fit", () => {
  const shipped = normalizeLiveGraphLayoutPolicy(policyDocument());
  const document = policyDocument();
  document.modes.compact.childColumnStepPx = 900;
  const widened = normalizeLiveGraphLayoutPolicy(document);

  const before = resolveFanoutArrangement(arrangementRequest({ policy: shipped }), shipped);
  const after = resolveFanoutArrangement(arrangementRequest({ policy: widened }), widened);

  // Proves the step is read from the document rather than from a second copy
  // hidden in the resolver: a resolver carrying its own 328 would return the same
  // scene for both. The expected width is written out rather than recomputed from
  // the mutated step, so a resolver that had stopped reading the document could
  // not satisfy both sides of the comparison.
  //
  // The column count deliberately is not asserted here. On this canvas it stays at
  // eight, because 281.8px of usable height against a 333px card makes rows the
  // expensive axis: two rows is the optimum and eight is the fewest columns that
  // produce two rows, whatever the horizontal step costs.
  assert.equal(before.sceneWidth, 3296);
  assert.equal(after.sceneWidth, 7300, "seven wider gaps at 900 instead of 328 add 4004px");
  assert.equal(after.columns, before.columns);
});

test("raising the card height floor makes rows expensive enough to change the row count", () => {
  const shipped = normalizeLiveGraphLayoutPolicy(policyDocument());
  const document = policyDocument();
  document.card.measuredMinHeightPx = 600;
  const tallCards = normalizeLiveGraphLayoutPolicy(document);

  const before = resolveFanoutArrangement(arrangementRequest({ policy: shipped }), shipped);
  const after = resolveFanoutArrangement(arrangementRequest({ policy: tallCards }), tallCards);

  // With 600px cards a second row costs 1288px of scene height against 281.8px of
  // usable canvas, so the single row becomes the least-bad arrangement again. That
  // is the search working, not the defect returning: it only reaches that verdict
  // when the cards genuinely cannot fit either way. The point of the assertion is
  // that the card height reaches the row decision at all, which a resolver holding
  // its own height literal would not manage.
  assert.equal(before.rows, 2);
  assert.equal(after.rows, 1);
});

test("card height comes from the configured floor and rows, not from a literal", () => {
  const policy = loadLiveGraphLayoutPolicy();
  assert.equal(resolveNodeCardHeight(0, policy.card), policy.card.measuredMinHeightPx);
  assert.equal(
    resolveNodeCardHeight(12, policy.card),
    policy.card.baseHeightPx + 6 * policy.card.capabilityRowHeightPx,
    "twelve capabilities at two per row is six rows above the base",
  );

  const document = policyDocument();
  document.card.measuredMinHeightPx = 500;
  const raised = normalizeLiveGraphLayoutPolicy(document);
  assert.equal(resolveNodeCardHeight(0, raised.card), 500);
});

test("the card height floor may not promise a card shorter than its own chrome", () => {
  const document = policyDocument();
  document.card.measuredMinHeightPx = document.card.baseHeightPx - 1;
  assert.throws(
    () => normalizeLiveGraphLayoutPolicy(document),
    (error) => error.code === "LIVE_GRAPH_LAYOUT_CARD_FLOOR_BELOW_CHROME",
  );
});

test("a column step at or below the card width is rejected as an overlapping grid", () => {
  const document = policyDocument();
  document.modes.compact.childColumnStepPx = document.card.entityWidthPx;
  assert.throws(
    () => normalizeLiveGraphLayoutPolicy(document),
    (error) => error.code === "LIVE_GRAPH_LAYOUT_COLUMN_STEP_OVERLAPS_CARD",
  );
});

test("configuration may not pin the arrangement to a single orientation", () => {
  const document = policyDocument();
  document.fanout.chainOrientations = ["chain-horizontal"];
  assert.throws(
    () => normalizeLiveGraphLayoutPolicy(document),
    (error) => error.code === "LIVE_GRAPH_LAYOUT_ORIENTATION_CHOICE_MISSING",
    "one orientation leaves the search nothing to choose, which is the defect wearing a config file",
  );
});

test("an unknown orientation is rejected rather than silently skipped", () => {
  const document = policyDocument();
  document.fanout.chainOrientations = ["chain-horizontal", "chain-diagonal"];
  assert.throws(
    () => normalizeLiveGraphLayoutPolicy(document),
    (error) => error.code === "LIVE_GRAPH_LAYOUT_UNKNOWN_ORIENTATION",
  );
});

test("the post-render gap may not exceed the routing lane the layout reserved", () => {
  const document = policyDocument();
  document.renderedColumnGapPx = document.modes.compact.childRowGapPx + 1;
  assert.throws(
    () => normalizeLiveGraphLayoutPolicy(document),
    (error) => error.code === "LIVE_GRAPH_LAYOUT_RENDERED_GAP_EXCEEDS_LANE",
  );
});

test("a schema version mismatch is refused instead of read on a best-effort basis", () => {
  const document = policyDocument();
  document.schemaVersion = "meta-kim-live-graph-layout-v0";
  assert.throws(
    () => normalizeLiveGraphLayoutPolicy(document),
    (error) => error.code === "LIVE_GRAPH_LAYOUT_SCHEMA_MISMATCH",
  );
});

test("an unmeasurable canvas falls back to the declared minimum scene rather than to the first candidate", () => {
  const policy = loadLiveGraphLayoutPolicy();
  const blind = resolveFanoutArrangement(
    arrangementRequest({ policy, request: { canvas: { width: 0, height: 0 } } }),
    policy,
  );

  // Scoring every candidate at zero would hand the win to whichever arrangement
  // the loop visited first, which is one column. The fallback has to produce a
  // real grid and has to say it was measured against a stand-in.
  assert.equal(blind.canvasMeasured, false);
  assert.ok(blind.columns > 1 && blind.columns < MEASURED_CHILD_COUNT);
  assert.equal(blind.columns, 5);
});

test("a measured canvas reports itself as measured", () => {
  const policy = loadLiveGraphLayoutPolicy();
  assert.equal(resolveFanoutArrangement(arrangementRequest({ policy }), policy).canvasMeasured, true);
});

test("the serialized resolvers are self-contained enough to run outside this module", () => {
  const policy = loadLiveGraphLayoutPolicy();
  const clientPolicy = serializeGraphLayoutPolicyForClient(policy);

  // The client script is inlined into a page string and cannot import this module.
  // Compiling the serialized source here proves the shipped copy computes the same
  // arrangement as the copy these tests exercise, instead of trusting that a second
  // hand-written copy in the page stayed in step.
  const compiled = new Function(
    `"use strict"; return { arrangement: ${serializeFanoutArrangementResolver()}, cardHeight: ${serializeNodeCardHeightResolver()} };`,
  )();

  // One request only walks one path through the resolver, so a module-scope
  // reference sitting on a branch that request never takes would compile here and
  // still throw in the browser. A mutation round proved that: putting the outside
  // reference on the unknown-mode fallback left this test green. Each request below
  // forces a different branch — the ordinary path, the fallback to the default mode,
  // and the unmeasurable-canvas path — so every branch is executed in the compiled
  // copy at least once.
  const paths = [
    { label: "the ordinary measured path", request: arrangementRequest({ policy }) },
    {
      label: "the fallback when the page asks for a mode the configuration does not carry",
      request: arrangementRequest({ policy, request: { mode: "no-such-mode" } }),
    },
    {
      label: "the unmeasurable-canvas fallback",
      request: arrangementRequest({ policy, request: { canvas: { width: 0, height: 0 } } }),
    },
    {
      label: "a parent with no owner chain above it",
      request: arrangementRequest({ policy, request: { chainLength: 0 } }),
    },
  ];
  for (const path of paths) {
    assert.deepEqual(
      compiled.arrangement(path.request, clientPolicy),
      resolveFanoutArrangement(path.request, policy),
      `the compiled copy disagreed on ${path.label}`,
    );
  }

  assert.equal(compiled.cardHeight(12, clientPolicy.card), resolveNodeCardHeight(12, policy.card));
  assert.equal(compiled.cardHeight(0, clientPolicy.card), resolveNodeCardHeight(0, policy.card));
});

test("the client-facing policy carries every field the serialized resolvers read", () => {
  const policy = loadLiveGraphLayoutPolicy();
  const clientPolicy = serializeGraphLayoutPolicyForClient(policy);

  // Derived from the policy rather than listed here. The list this replaced named
  // six of the seven fields and missed stageScenePaddingPx, which the serializer
  // does send — so the test passed while saying nothing about that field, and the
  // day someone dropped it from the serializer this would still have been green.
  // schemaVersion is the one deliberate omission: it identifies the contract the
  // loader validated and the browser has no use for it.
  const withheld = new Set(["schemaVersion"]);
  const expected = Object.keys(policy).filter((key) => !withheld.has(key));
  assert.ok(expected.length >= 7, `only ${expected.length} policy fields reached this guard, which is fewer than the loader returns`);
  assert.deepEqual(Object.keys(clientPolicy).sort(), expected.sort());
  assert.deepEqual(Object.keys(clientPolicy.modes).sort(), ["compact", "flow"]);
});

test("the card reservation covers the card the browser rendered, which the configured estimate does not", () => {
  const policy = loadLiveGraphLayoutPolicy();
  const metrics = resolveMeasuredCardMetrics(MEASURED_CAPABILITY_STRIPS, policy.card);

  assert.equal(metrics.basis, "measured");
  assert.equal(metrics.sampleCount, MEASURED_CAPABILITY_STRIPS.length);
  assert.equal(metrics.capabilityRowHeightPx, MEASURED_CAPABILITY_ROW_STEP);
  assert.equal(metrics.baseHeightPx, MEASURED_CARD_CHROME);
  assert.equal(metrics.capabilitiesPerRow, 2);
  assert.equal(metrics.measuredMinHeightPx, policy.card.measuredMinHeightPx, "the floor is not derived and must survive");

  // The claim worth making is not that the numbers moved but that the reservation
  // now covers the render. Asserting only the first direction would pass for any
  // absurdly large step, so the second direction pins the fixture to a case the
  // configured estimate actually fails -- if the configuration is ever brought into
  // line, this fails and says so rather than quietly guarding nothing.
  const understated = [];
  for (const sample of MEASURED_CAPABILITY_STRIPS) {
    assert.ok(
      resolveNodeCardHeight(sample.chips, metrics) >= sample.cardHeightPx,
      `the measured reservation was shorter than the ${sample.cardHeightPx}px card the browser rendered`,
    );
    if (resolveNodeCardHeight(sample.chips, policy.card) < sample.cardHeightPx) understated.push(sample.cardHeightPx);
  }
  assert.ok(
    understated.length > 0,
    "the configured estimate already covered every measured card, so this fixture no longer shows the defect it was taken for",
  );
});

test("a strip CSS collapsed to one column decides the column count, because fewer chips per row means a taller card", () => {
  const policy = loadLiveGraphLayoutPolicy();

  // Not part of the measured population: every card the browser reported at 1738px wide
  // had two columns. The narrow band in the stylesheet drops .node-capability-strip to a
  // single column, so both counts are reachable and the resolver has to choose between
  // them. Row height and chrome are held at the values the two-column cards already
  // produce, so nothing but the column count can satisfy what follows.
  const collapsed = { cardHeightPx: 283, stripHeightPx: 74, rowGapPx: 6, renderedRows: 1, renderedColumns: 1, chips: 1 };
  const metrics = resolveMeasuredCardMetrics([...MEASURED_CAPABILITY_STRIPS, collapsed], policy.card);
  const wider = resolveMeasuredCardMetrics(MEASURED_CAPABILITY_STRIPS, policy.card);

  assert.equal(metrics.basis, "measured");
  assert.equal(metrics.capabilitiesPerRow, 1, "the smaller count is the conservative one and must win over the two-column cards");
  assert.equal(wider.capabilitiesPerRow, 2, "without the collapsed strip the two-column cards are all there is to read");
  assert.equal(metrics.capabilityRowHeightPx, wider.capabilityRowHeightPx, "the fixture must not move the step, or the count is not what this proves");
  assert.equal(metrics.baseHeightPx, wider.baseHeightPx, "the fixture must not move the chrome either");

  // The count only matters through the height it produces, so state that consequence
  // rather than the field alone: taking the larger count would halve the rows for a
  // four-chip node and hand the arrangement a card shorter than one column can render.
  assert.ok(
    resolveNodeCardHeight(4, metrics) > resolveNodeCardHeight(4, wider),
    "a four-chip node must reserve more once a column has been taken away, or the count is not reaching the height",
  );
});

test("a strip the browser never rendered leaves the configured estimate in place", () => {
  const policy = loadLiveGraphLayoutPolicy();
  const configured = { ...policy.card, basis: "configured", sampleCount: 0 };
  const valid = MEASURED_CAPABILITY_STRIPS[2];

  // One request only walks one of these arms, and the page calls this before any
  // card exists as well as after, so each refusal is exercised separately rather
  // than trusting that whichever one the happy path skips would also hold.
  const arms = [
    ["nothing measured at all", []],
    ["no measurement passed", null],
    ["a measurement that is not a list", { ...valid }],
    ["a hole in the list", [null]],
    ["a strip with no rows", [{ ...valid, renderedRows: 0 }]],
    ["a strip with no columns", [{ ...valid, renderedColumns: 0 }]],
    ["a card the browser reported as zero-height", [{ ...valid, cardHeightPx: 0 }]],
    ["a strip the browser reported as zero-height", [{ ...valid, stripHeightPx: 0 }]],
    ["a strip as tall as the card holding it", [{ ...valid, stripHeightPx: valid.cardHeightPx }]],
    ["a gap that is not a number", [{ ...valid, rowGapPx: Number.NaN }]],
    ["a negative gap", [{ ...valid, rowGapPx: -6 }]],
  ];
  for (const [label, measurement] of arms) {
    assert.deepEqual(
      resolveMeasuredCardMetrics(measurement, policy.card),
      configured,
      `${label} must leave the estimate where the configuration put it`,
    );
  }

  // A single unusable strip must not discard the usable ones. The page measures
  // every card on screen, so one card caught mid-transition would otherwise drop
  // the whole run back to the configured guess.
  const mixed = resolveMeasuredCardMetrics([{ ...valid, renderedRows: 0 }, ...MEASURED_CAPABILITY_STRIPS], policy.card);
  assert.equal(mixed.basis, "measured");
  assert.equal(mixed.sampleCount, MEASURED_CAPABILITY_STRIPS.length);
  assert.equal(mixed.capabilityRowHeightPx, MEASURED_CAPABILITY_ROW_STEP);
});

test("the serialized measured-metrics resolver runs outside this module on every branch", () => {
  const policy = loadLiveGraphLayoutPolicy();
  const clientPolicy = serializeGraphLayoutPolicyForClient(policy);
  const compiled = new Function(`"use strict"; return ${serializeMeasuredCardMetricsResolver()};`)();

  const branches = [
    ["the measured path", MEASURED_CAPABILITY_STRIPS],
    ["nothing measured", []],
    ["no measurement passed", null],
    ["a measurement that is not a list", { ...MEASURED_CAPABILITY_STRIPS[2] }],
    ["a strip with no rows", [{ ...MEASURED_CAPABILITY_STRIPS[2], renderedRows: 0 }]],
    ["a strip taller than its card", [{ ...MEASURED_CAPABILITY_STRIPS[2], stripHeightPx: 999 }]],
  ];
  for (const [label, measurement] of branches) {
    assert.deepEqual(
      compiled(measurement, clientPolicy.card),
      resolveMeasuredCardMetrics(measurement, policy.card),
      `the compiled copy disagreed on ${label}`,
    );
  }
});

/**
 * Every distance in this configuration is a layout input, and a reader with no
 * rationale for one has no way to tell a measured value from a typed guess. The
 * file already carried notes, but nothing checked them, so `stageScenePaddingPx`
 * and its `branchGap` shipped with no explanation at all while `card` had notes
 * for two of its five fields — the gap was invisible because it was a hand-kept
 * list of prose entries with no relationship to the data beside it.
 *
 * Both directions are checked, and they fail for different reasons:
 *
 *  - a knob with no note reaching it means a value is being honoured with nothing
 *    saying why, which is how branchGap arrived
 *  - a note whose key resolves to nothing means the prose was left behind when the
 *    field it described was renamed or removed
 *
 * The knobs are walked out of the configuration itself, so a field added tomorrow
 * is in scope the day it is added rather than the day someone remembers this test.
 */test("every layout knob carries a rationale, and every rationale points at a knob that exists", () => {
  const raw = JSON.parse(readFileSync(LIVE_GRAPH_LAYOUT_CONFIG_URL, "utf8"));

  // Only three keys are exempt, and none of them is a layout input: the schema
  // version identifies the contract, and the other two are the prose itself.
  const notPolicyInputs = new Set(["schemaVersion", "comment", "policyNotes"]);

  const knobs = [];
  const walk = (value, path) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, nested] of Object.entries(value)) walk(nested, path ? `${path}.${key}` : key);
      return;
    }
    if (path) knobs.push(path);
  };
  for (const [key, value] of Object.entries(raw)) {
    if (!notPolicyInputs.has(key)) walk(value, key);
  }

  // A note reaches a knob when its key names the knob — directly, or through the
  // wildcard spelling `modes.*.childColumnStepPx` the file already uses to say one
  // thing about the same field in both modes.
  //
  // A note on an ancestor group counts too, but only when its prose names the field
  // itself. Prefix matching alone was tried first and was too weak to be worth
  // shipping: a group note swallowed everything beneath it, so `branchGap` was
  // caught only because its group happened to have no note, and a mutation adding a
  // new field to a documented group stayed green. Requiring the field to be named
  // means silence is what fails, which is the shape the defect actually had.
  //
  // What this cannot do is judge whether the sentence naming a field explains it.
  // A field name dropped into unrelated prose satisfies this, and no mechanical
  // check gets past that; the bar it does raise is that someone has to write the
  // name down rather than say nothing.
  const namesField = (text, field) => new RegExp(`(?<![A-Za-z0-9_])${field}(?![A-Za-z0-9_])`, "u").test(text);
  const reaches = (note, text, knob) => {
    const noteSegments = note.split(".");
    const knobSegments = knob.split(".");
    if (noteSegments.length > knobSegments.length) return false;
    if (!noteSegments.every((segment, index) => segment === "*" || segment === knobSegments[index])) return false;
    if (noteSegments.length === knobSegments.length) return true;
    return namesField(text, knobSegments.at(-1));
  };

  const notes = Object.entries(raw.policyNotes ?? {});
  assert.ok(
    knobs.length >= 40,
    `only ${knobs.length} knobs were walked out of the configuration, which is fewer than it carries, so this sweep `
      + "has stopped seeing them rather than found them all documented",
  );
  assert.ok(notes.length > 0, "the configuration carries no rationales at all, so both halves below are vacuous");

  assert.deepEqual(
    knobs.filter((knob) => !notes.some(([note, text]) => reaches(note, text, knob))),
    [],
    "these layout knobs are honoured by the loader with nothing in policyNotes saying what they do or where their "
      + "value came from",
  );
  // The other direction asks whether the note's key still resolves to something in
  // the configuration, which is the rename defect: prose left behind pointing at a
  // field that moved. It deliberately does not ask whether the note reaches a leaf.
  // `modes` reaches none — every mode field now carries its own note — but it is not
  // stale, it explains the group itself, and failing it would push a real
  // explanation out of the file to satisfy a test.
  const pathExists = (note) => {
    let frontier = [raw];
    for (const segment of note.split(".")) {
      const next = [];
      for (const value of frontier) {
        if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
        if (segment === "*") next.push(...Object.values(value));
        else if (segment in value) next.push(value[segment]);
      }
      if (next.length === 0) return false;
      frontier = next;
    }
    return true;
  };
  assert.deepEqual(
    notes.filter(([note]) => !pathExists(note)).map(([note]) => note),
    [],
    "these rationales name fields the configuration no longer carries, so they read as documentation while "
      + "documenting nothing",
  );
});
