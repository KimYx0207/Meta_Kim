/**
 * Execution-graph arrangement policy.
 *
 * The page module used to carry the layout distances as literals and to place a
 * high-fanout packet in one unwrapped row regardless of how much canvas the
 * browser reported. That produced a 4984x1180 scene against a measured 1651x334
 * canvas: 0.257x, below the camera's 0.28 minScale, so the camera declared the
 * graph unfittable and left most of it outside the viewport.
 *
 * The arrangement is therefore searched rather than typed: every column count
 * from one to the child count is scored against both chain orientations, and the
 * one that needs the least zoom wins. The resolvers are exported as functions and
 * serialized into the browser bundle by their own `toString()`. The client script
 * is inlined into a page string and cannot import this module, and a second copy
 * of the search in the page would be free to disagree with the copy the tests
 * exercise.
 */

import { readFileSync } from "node:fs";

export const LIVE_GRAPH_LAYOUT_SCHEMA_VERSION = "meta-kim-live-graph-layout-v1";
export const LIVE_GRAPH_LAYOUT_CONFIG_URL = new URL("../../../config/live/graph-layout.json", import.meta.url);

export const LIVE_GRAPH_CHAIN_ORIENTATIONS = Object.freeze(["chain-horizontal", "chain-vertical"]);

const MODE_NAMES = Object.freeze(["compact", "flow"]);

/**
 * Distances every mode must declare. These two modes are the page's own
 * `layoutMode` values and they are different arrangements, not a tight-versus-
 * loose ladder: compact runs four spine columns where flow runs eight, so
 * compact's stage gaps are legitimately the larger pair. An earlier draft of this
 * validator asserted compact was uniformly tighter and rejected the real
 * configuration — nothing orders one mode's steps against the other's, so
 * nothing here claims to.
 */
const MODE_STEP_KEYS = Object.freeze([
  "childColumnStepPx",
  "childRowGapPx",
  "chainColumnStepPx",
  "chainRowGapPx",
  "chainToBlockGapPx",
  "entityColumnStepPx",
  "entityRowGapPx",
  "stageColumnGapPx",
  "stageRowGapPx",
]);

function fail(message, code = "LIVE_GRAPH_LAYOUT_INVALID") {
  const error = new TypeError(`Live graph layout: ${message}`);
  error.code = code;
  throw error;
}

function positiveNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(`${label} must be a positive finite number`);
  }
  return value;
}

function nonNegativeNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(`${label} must be a non-negative finite number`);
  }
  return value;
}

function positiveInteger(value, label) {
  positiveNumber(value, label);
  if (!Number.isInteger(value)) fail(`${label} must be an integer`);
  return value;
}

function normalizeMode(raw, modeName) {
  if (!raw || typeof raw !== "object") fail(`modes.${modeName} must be an object`);
  const mode = {};
  for (const key of MODE_STEP_KEYS) {
    mode[key] = positiveNumber(raw[key], `modes.${modeName}.${key}`);
  }
  mode.stageColumns = positiveInteger(raw.stageColumns, `modes.${modeName}.stageColumns`);
  return Object.freeze(mode);
}

export function normalizeLiveGraphLayoutPolicy(raw) {
  if (!raw || typeof raw !== "object") fail("policy document must be an object");
  if (raw.schemaVersion !== LIVE_GRAPH_LAYOUT_SCHEMA_VERSION) {
    fail(
      `schemaVersion must be ${LIVE_GRAPH_LAYOUT_SCHEMA_VERSION}, received ${JSON.stringify(raw.schemaVersion)}`,
      "LIVE_GRAPH_LAYOUT_SCHEMA_MISMATCH",
    );
  }

  const rawCard = raw.card;
  if (!rawCard || typeof rawCard !== "object") fail("card must be an object");
  const card = Object.freeze({
    entityWidthPx: positiveNumber(rawCard.entityWidthPx, "card.entityWidthPx"),
    stageWidthPx: positiveNumber(rawCard.stageWidthPx, "card.stageWidthPx"),
    baseHeightPx: positiveNumber(rawCard.baseHeightPx, "card.baseHeightPx"),
    capabilityRowHeightPx: positiveNumber(rawCard.capabilityRowHeightPx, "card.capabilityRowHeightPx"),
    capabilitiesPerRow: positiveInteger(rawCard.capabilitiesPerRow, "card.capabilitiesPerRow"),
    measuredMinHeightPx: positiveNumber(rawCard.measuredMinHeightPx, "card.measuredMinHeightPx"),
  });
  if (card.measuredMinHeightPx < card.baseHeightPx) {
    fail(
      "card.measuredMinHeightPx must be at least card.baseHeightPx, or the floor promises a card shorter than its own chrome",
      "LIVE_GRAPH_LAYOUT_CARD_FLOOR_BELOW_CHROME",
    );
  }

  const rawModes = raw.modes;
  if (!rawModes || typeof rawModes !== "object") fail("modes must be an object");
  const modes = {};
  for (const modeName of MODE_NAMES) {
    modes[modeName] = normalizeMode(rawModes[modeName], modeName);
  }
  // A column step at or below the card width overlaps neighbouring cards, and a
  // chain step at or below it overlaps the chain. Requiring clearance here makes
  // the overlap unrepresentable instead of something a reviewer has to spot.
  for (const modeName of MODE_NAMES) {
    for (const key of ["childColumnStepPx", "chainColumnStepPx", "entityColumnStepPx"]) {
      if (modes[modeName][key] <= card.entityWidthPx) {
        fail(
          `modes.${modeName}.${key} must exceed card.entityWidthPx, or adjacent cards overlap`,
          "LIVE_GRAPH_LAYOUT_COLUMN_STEP_OVERLAPS_CARD",
        );
      }
    }
  }

  const defaultMode = raw.defaultMode;
  if (!MODE_NAMES.includes(defaultMode)) {
    fail(
      `defaultMode must be one of ${MODE_NAMES.join(", ")}, received ${JSON.stringify(defaultMode)}`,
      "LIVE_GRAPH_LAYOUT_UNKNOWN_DEFAULT_MODE",
    );
  }

  const rawPadding = raw.scenePaddingPx;
  if (!rawPadding || typeof rawPadding !== "object") fail("scenePaddingPx must be an object");
  const scenePaddingPx = Object.freeze({
    top: positiveNumber(rawPadding.top, "scenePaddingPx.top"),
    right: positiveNumber(rawPadding.right, "scenePaddingPx.right"),
    bottom: positiveNumber(rawPadding.bottom, "scenePaddingPx.bottom"),
    left: positiveNumber(rawPadding.left, "scenePaddingPx.left"),
  });

  const rawMinimum = raw.sceneMinimumPx;
  if (!rawMinimum || typeof rawMinimum !== "object") fail("sceneMinimumPx must be an object");
  const sceneMinimumPx = Object.freeze({
    entityWidth: positiveNumber(rawMinimum.entityWidth, "sceneMinimumPx.entityWidth"),
    entityHeight: positiveNumber(rawMinimum.entityHeight, "sceneMinimumPx.entityHeight"),
    stageWidth: positiveNumber(rawMinimum.stageWidth, "sceneMinimumPx.stageWidth"),
    stageHeight: positiveNumber(rawMinimum.stageHeight, "sceneMinimumPx.stageHeight"),
  });

  const rawStagePadding = raw.stageScenePaddingPx;
  if (!rawStagePadding || typeof rawStagePadding !== "object") fail("stageScenePaddingPx must be an object");
  const stageScenePaddingPx = Object.freeze({
    top: positiveNumber(rawStagePadding.top, "stageScenePaddingPx.top"),
    right: positiveNumber(rawStagePadding.right, "stageScenePaddingPx.right"),
    bottom: positiveNumber(rawStagePadding.bottom, "stageScenePaddingPx.bottom"),
    left: positiveNumber(rawStagePadding.left, "stageScenePaddingPx.left"),
    branchGap: nonNegativeNumber(rawStagePadding.branchGap, "stageScenePaddingPx.branchGap"),
  });

  const renderedColumnGapPx = positiveNumber(raw.renderedColumnGapPx, "renderedColumnGapPx");
  let smallestLayoutRowGap = Infinity;
  for (const modeName of MODE_NAMES) {
    smallestLayoutRowGap = Math.min(smallestLayoutRowGap, modes[modeName].childRowGapPx);
  }
  if (renderedColumnGapPx > smallestLayoutRowGap) {
    fail(
      "renderedColumnGapPx must not exceed the smallest childRowGapPx, or the post-render pass pushes cards past the lane the layout reserved for their edges",
      "LIVE_GRAPH_LAYOUT_RENDERED_GAP_EXCEEDS_LANE",
    );
  }

  const rawFanout = raw.fanout;
  if (!rawFanout || typeof rawFanout !== "object") fail("fanout must be an object");
  const minimumChildren = positiveInteger(rawFanout.minimumChildren, "fanout.minimumChildren");
  if (minimumChildren < 2) {
    fail("fanout.minimumChildren must be at least 2", "LIVE_GRAPH_LAYOUT_FANOUT_THRESHOLD_TOO_LOW");
  }
  if (!Array.isArray(rawFanout.chainOrientations)) fail("fanout.chainOrientations must be an array");
  const chainOrientations = [];
  for (const orientation of rawFanout.chainOrientations) {
    if (!LIVE_GRAPH_CHAIN_ORIENTATIONS.includes(orientation)) {
      fail(
        `fanout.chainOrientations contains unknown orientation ${JSON.stringify(orientation)}`,
        "LIVE_GRAPH_LAYOUT_UNKNOWN_ORIENTATION",
      );
    }
    if (chainOrientations.includes(orientation)) {
      fail(
        `fanout.chainOrientations repeats ${JSON.stringify(orientation)}`,
        "LIVE_GRAPH_LAYOUT_DUPLICATE_ORIENTATION",
      );
    }
    chainOrientations.push(orientation);
  }
  if (chainOrientations.length < 2) {
    fail(
      "fanout.chainOrientations must offer at least two orientations, or the search has nothing to choose and the arrangement is pinned by configuration",
      "LIVE_GRAPH_LAYOUT_ORIENTATION_CHOICE_MISSING",
    );
  }

  return Object.freeze({
    schemaVersion: raw.schemaVersion,
    card,
    defaultMode,
    modes: Object.freeze(modes),
    scenePaddingPx,
    sceneMinimumPx,
    stageScenePaddingPx,
    renderedColumnGapPx,
    fanout: Object.freeze({ minimumChildren, chainOrientations: Object.freeze(chainOrientations) }),
  });
}

export function loadLiveGraphLayoutPolicy(configUrl = LIVE_GRAPH_LAYOUT_CONFIG_URL) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configUrl, "utf8"));
  } catch (error) {
    fail(`unable to read ${configUrl}: ${error.message}`, "LIVE_GRAPH_LAYOUT_UNREADABLE");
  }
  return normalizeLiveGraphLayoutPolicy(parsed);
}

/**
 * Card height for a node, from its capability count.
 *
 * Serialized into the browser bundle, so it must stay self-contained.
 */
export function resolveNodeCardHeight(capabilityCount, card) {
  const count = Number.isFinite(capabilityCount) && capabilityCount > 0 ? Math.floor(capabilityCount) : 0;
  const rows = Math.ceil(count / card.capabilitiesPerRow);
  return Math.max(card.measuredMinHeightPx, card.baseHeightPx + rows * card.capabilityRowHeightPx);
}

/**
 * Card chrome and capability-row step recovered from cards the browser rendered.
 *
 * The configuration has to carry an estimate for both, because the arrangement
 * search runs before any card exists. Once cards are on screen their capability
 * strips state the truth, and that truth is viewport-dependent: CSS drops the strip
 * from two columns to one in the narrow band and changes the chip's minimum height
 * per band, so a literal is wrong in at least one band whatever value it holds.
 *
 * The arithmetic is exact rather than fitted. A strip of `rows` rows with gap `g`
 * occupies rows*rowHeight + (rows-1)*g, so (strip + g) / rows is the step one row
 * adds including its gap, and whatever the card has left over is its chrome.
 * Nothing here divides one card's height by another card's, so a long name wrapping
 * in one card cannot tilt the step read from a different one.
 *
 * Where cards disagree the larger reservation wins, because the two directions are
 * not symmetric. Over-reserving costs vertical space. Under-reserving hands the
 * arrangement search a shorter block than the browser then renders, which is the
 * defect this replaces. Chrome legitimately differs per card -- a wrapped node name
 * adds a line -- so the maximum is the only value that covers every card. Column
 * count goes the other way: fewer chips per row means more rows, so the smallest
 * count observed is the conservative one.
 *
 * Serialized into the browser bundle, so it must stay self-contained: no imports,
 * no module-scope references, no closures.
 */
export function resolveMeasuredCardMetrics(measurement, card) {
  const samples = Array.isArray(measurement) ? measurement : [];
  let rowStep = 0;
  let chrome = 0;
  let perRow = 0;
  let used = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (!sample || typeof sample !== "object") continue;
    const rows = Number(sample.renderedRows);
    const columns = Number(sample.renderedColumns);
    const cardHeight = Number(sample.cardHeightPx);
    const stripHeight = Number(sample.stripHeightPx);
    const gap = Number(sample.rowGapPx);
    if (!Number.isFinite(rows) || rows < 1) continue;
    if (!Number.isFinite(columns) || columns < 1) continue;
    if (!Number.isFinite(cardHeight) || cardHeight <= 0) continue;
    if (!Number.isFinite(stripHeight) || stripHeight <= 0) continue;
    if (!Number.isFinite(gap) || gap < 0) continue;
    const step = (stripHeight + gap) / Math.floor(rows);
    const base = cardHeight - stripHeight - gap;
    if (!(step > 0) || !(base > 0)) continue;
    used += 1;
    if (step > rowStep) rowStep = step;
    if (base > chrome) chrome = base;
    if (perRow === 0 || Math.floor(columns) < perRow) perRow = Math.floor(columns);
  }
  if (used === 0) return { ...card, basis: "configured", sampleCount: 0 };
  return {
    ...card,
    baseHeightPx: chrome,
    capabilityRowHeightPx: rowStep,
    capabilitiesPerRow: perRow,
    basis: "measured",
    sampleCount: used,
  };
}

/**
 * Choose the fanout arrangement that needs the least zoom.
 *
 * Every column count from one to the child count is scored against every
 * configured chain orientation, and the candidate with the highest fitted scale
 * wins. Ties go to the smaller scene and then to fewer columns, so an unwrapped
 * row cannot tie its way past a compact grid when the height axis is what binds.
 *
 * Serialized into the browser bundle, so it must stay self-contained: no imports,
 * no module-scope references, no closures.
 */
export function resolveFanoutArrangement(request, layout) {
  const mode = layout.modes[request.mode] || layout.modes[layout.defaultMode];
  const pad = layout.scenePaddingPx;
  const childCount = Math.max(1, Math.floor(request.childCount));
  const chainLength = Math.max(0, Math.floor(request.chainLength || 0));
  const inset = request.inset || { top: 0, right: 0, bottom: 0, left: 0 };

  // An unmeasurable canvas falls back to the declared minimum scene box rather
  // than to a fresh literal: the search still runs against a real aspect ratio,
  // and scoring every candidate at zero would hand the win to whichever
  // arrangement the loop happened to visit first.
  let usableWidth = (request.canvas ? request.canvas.width : 0) - inset.left - inset.right;
  let usableHeight = (request.canvas ? request.canvas.height : 0) - inset.top - inset.bottom;
  const canvasMeasured = usableWidth > 0 && usableHeight > 0;
  if (!canvasMeasured) {
    usableWidth = layout.sceneMinimumPx.entityWidth;
    usableHeight = layout.sceneMinimumPx.entityHeight;
  }

  let best = null;
  for (let orientationIndex = 0; orientationIndex < layout.fanout.chainOrientations.length; orientationIndex += 1) {
    const orientation = layout.fanout.chainOrientations[orientationIndex];
    for (let columns = 1; columns <= childCount; columns += 1) {
      const rows = Math.ceil(childCount / columns);
      const blockWidth = (columns - 1) * mode.childColumnStepPx + request.childWidth;
      const blockHeight = rows * request.childHeight + (rows - 1) * mode.childRowGapPx;
      const chainGap = chainLength > 0 ? mode.chainToBlockGapPx : 0;
      let chainWidth = 0;
      let chainHeight = 0;
      let sceneWidth = 0;
      let sceneHeight = 0;
      if (orientation === "chain-horizontal") {
        chainWidth = chainLength > 0 ? (chainLength - 1) * mode.chainColumnStepPx + request.chainWidth : 0;
        chainHeight = chainLength > 0 ? request.chainHeight : 0;
        sceneWidth = pad.left + chainWidth + chainGap + blockWidth + pad.right;
        sceneHeight = pad.top + Math.max(chainHeight, blockHeight) + pad.bottom;
      } else {
        chainWidth = chainLength > 0 ? request.chainWidth : 0;
        chainHeight = chainLength > 0
          ? chainLength * request.chainHeight + Math.max(0, chainLength - 1) * mode.chainRowGapPx
          : 0;
        sceneWidth = pad.left + Math.max(chainWidth, blockWidth) + pad.right;
        sceneHeight = pad.top + chainHeight + chainGap + blockHeight + pad.bottom;
      }
      sceneWidth = Math.max(layout.sceneMinimumPx.entityWidth, sceneWidth);
      sceneHeight = Math.max(layout.sceneMinimumPx.entityHeight, sceneHeight);
      const fittedScale = Math.min(usableWidth / sceneWidth, usableHeight / sceneHeight);
      const candidate = {
        orientation,
        columns,
        rows,
        blockWidth,
        blockHeight,
        chainWidth,
        chainHeight,
        chainGap,
        sceneWidth,
        sceneHeight,
        fittedScale,
        canvasMeasured,
      };
      if (best === null) {
        best = candidate;
        continue;
      }
      if (candidate.fittedScale > best.fittedScale + 1e-9) {
        best = candidate;
        continue;
      }
      if (candidate.fittedScale > best.fittedScale - 1e-9) {
        const candidateArea = candidate.sceneWidth * candidate.sceneHeight;
        const bestArea = best.sceneWidth * best.sceneHeight;
        if (candidateArea < bestArea - 1e-9) best = candidate;
        else if (candidateArea < bestArea + 1e-9 && candidate.columns < best.columns) best = candidate;
      }
    }
  }
  return best;
}

export function serializeNodeCardHeightResolver() {
  return resolveNodeCardHeight.toString();
}

export function serializeMeasuredCardMetricsResolver() {
  return resolveMeasuredCardMetrics.toString();
}

export function serializeFanoutArrangementResolver() {
  return resolveFanoutArrangement.toString();
}

export function serializeGraphLayoutPolicyForClient(policy) {
  return Object.freeze({
    card: policy.card,
    defaultMode: policy.defaultMode,
    modes: policy.modes,
    scenePaddingPx: policy.scenePaddingPx,
    sceneMinimumPx: policy.sceneMinimumPx,
    stageScenePaddingPx: policy.stageScenePaddingPx,
    renderedColumnGapPx: policy.renderedColumnGapPx,
    fanout: policy.fanout,
  });
}
