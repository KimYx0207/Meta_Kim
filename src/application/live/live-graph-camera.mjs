/**
 * Camera bounds for the Meta_Kim Live control room execution graph.
 *
 * The graph is the default view, so the overview state is the first thing a
 * reader sees. It was wrong: `fitGraph` clamped the fitted scale up to a
 * hardcoded floor (`width <= 1024 ? 1 : .68`), decided the graph therefore did
 * not fit, and parked the camera at the top-left inset while the status bar
 * still read "Overview". Measured in a browser at 1351x726 dpr 1.5, a 1890x955
 * content box in a 1295x382 canvas needed scale 0.346; the floor forced 0.68 and
 * one of eight node cards was fully visible.
 *
 * The floor was there to protect legibility, but legibility already had a
 * mechanism: below `semanticZoomCellMaxScale` the node cards render as a
 * monospace title band. Refusing to zoom out did not make anything readable, it
 * only hid the run's shape. So overview now shrinks to the same `minScale`
 * manual zoom has always accepted, and the reduced rendering carries the small
 * end of the range.
 *
 * That reduced rendering only carries it because `minOnScreenTextPx` exists.
 * Removing the scale floor on its own traded one defect for another: the cell
 * title kept a world-space `font-size`, so at scale 0.28 a 14.42px title
 * measured 4.04px on screen. A type ladder cannot catch this, because its floor
 * is in CSS pixels and the camera multiplies CSS pixels by its scale. The cell
 * title and its band therefore divide the declared on-screen floor by the live
 * scale, which makes the on-screen size the constant.
 *
 * `normalizeLiveGraphCameraPolicy` rejects `minScale` above
 * `semanticZoomCellMaxScale`, which makes the original defect shape
 * unrepresentable rather than merely discouraged: a floor above the cell
 * boundary is exactly a floor with no rendering behind it.
 *
 * The boundary has a second, symmetric obligation, and it was violated for as
 * long as it was hand-set. A cell title counter-scales, so it holds the floor by
 * construction; a full card declares world-space sizes, so the only thing between
 * it and sub-floor text is the scale at which full cards start being drawn. That
 * scale sat at 0.42 while cards needed 0.991, and a browser at 1760x900 fitted a
 * 17-node run at 0.4582 -- inside the gap, so `data-semantic-zoom` read "card"
 * and all twelve text elements in a node rendered between 5.46px and 9.01px.
 * `resolveCardLegibleMinScale` derives the requirement from the type ladder and
 * normalization rejects anything under it, so the gap cannot reopen.
 *
 * The resolvers are exported as functions and serialized into the browser
 * bundle by their own `toString()`. The client script is inlined into a page
 * string and cannot import this module, and a second copy of the fit arithmetic
 * in the page would be free to disagree with the copy the tests exercise.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadLiveTypographyScale } from "./live-typography-scale.mjs";

export const LIVE_GRAPH_CAMERA_SCHEMA_VERSION = "meta-kim-live-graph-camera-v1";

export const LIVE_GRAPH_CAMERA_CONFIG_URL = new URL(
  "../../../config/live/graph-camera.json",
  import.meta.url,
);

function fail(message, code = "LIVE_GRAPH_CAMERA_INVALID") {
  const error = new TypeError(`Live graph camera: ${message}`);
  error.code = code;
  throw error;
}

function positiveNumber(value, label) {
  if (!Number.isFinite(value) || value <= 0) fail(`${label} must be a positive number`);
  return value;
}

function nonNegativeNumber(value, label) {
  if (!Number.isFinite(value) || value < 0) fail(`${label} must be a non-negative number`);
  return value;
}

/**
 * The lowest scale at which a full node card can still honour the on-screen text
 * floor.
 *
 * Derived rather than declared, because the two numbers it sits between are both
 * owned elsewhere: the floor belongs to this document and the smallest card text
 * belongs to the type ladder. A hand-set boundary between them is a number that
 * can only be right by coincidence, and it was wrong -- measured in a browser at
 * 1760x900, a fitted scale of 0.4582 cleared a 0.42 boundary, so full cards
 * rendered with every one of their twelve text elements between 5.46px and
 * 9.01px against an 11px floor.
 *
 * `clamp()` cannot resolve below `base.min`, so that bound is the smallest base a
 * reader can reach, and the ladder's smallest ratio is the smallest size any card
 * child can name. The product is therefore the worst case across every viewport,
 * which is what a single boundary has to survive.
 */
export function resolveCardLegibleMinScale(minOnScreenTextPx, typographyScale) {
  const rootPx = typographyScale.legibility.rootFontSizePx;
  const baseMinPx = Number.parseFloat(typographyScale.base.min) * rootPx;
  const smallestStepRatio = Math.min(...typographyScale.steps.map((step) => step.ratio));
  return minOnScreenTextPx / (baseMinPx * smallestStepRatio);
}

/** Validate and freeze a raw graph-camera document. */
export function normalizeLiveGraphCameraPolicy(raw, typographyScale = loadLiveTypographyScale()) {
  if (!raw || typeof raw !== "object") fail("document must be an object");
  if (raw.schemaVersion !== LIVE_GRAPH_CAMERA_SCHEMA_VERSION) {
    fail(
      `schemaVersion must be ${LIVE_GRAPH_CAMERA_SCHEMA_VERSION}`,
      "LIVE_GRAPH_CAMERA_SCHEMA_MISMATCH",
    );
  }
  const normalized = Object.freeze({
    schemaVersion: raw.schemaVersion,
    fitPaddingPx: nonNegativeNumber(raw.fitPaddingPx, "fitPaddingPx"),
    minScale: positiveNumber(raw.minScale, "minScale"),
    semanticZoomCellMaxScale: positiveNumber(
      raw.semanticZoomCellMaxScale,
      "semanticZoomCellMaxScale",
    ),
    overviewMaxScale: positiveNumber(raw.overviewMaxScale, "overviewMaxScale"),
    maxScale: positiveNumber(raw.maxScale, "maxScale"),
    minOnScreenTextPx: positiveNumber(raw.minOnScreenTextPx, "minOnScreenTextPx"),
    zoomInFactor: positiveNumber(raw.zoomInFactor, "zoomInFactor"),
    zoomOutFactor: positiveNumber(raw.zoomOutFactor, "zoomOutFactor"),
    wheelZoomInFactor: positiveNumber(raw.wheelZoomInFactor, "wheelZoomInFactor"),
    wheelZoomOutFactor: positiveNumber(raw.wheelZoomOutFactor, "wheelZoomOutFactor"),
  });
  if (normalized.minScale > normalized.semanticZoomCellMaxScale) {
    fail(
      "minScale must not exceed semanticZoomCellMaxScale, otherwise the cell rendering is unreachable and the "
        + "floor is a legibility claim with nothing behind it -- the exact shape of the overview defect",
      "LIVE_GRAPH_CAMERA_CELL_LOD_UNREACHABLE",
    );
  }
  const cardLegibleMinScale = resolveCardLegibleMinScale(
    normalized.minOnScreenTextPx,
    typographyScale,
  );
  if (normalized.semanticZoomCellMaxScale < cardLegibleMinScale) {
    fail(
      `semanticZoomCellMaxScale ${normalized.semanticZoomCellMaxScale} is below `
        + `${cardLegibleMinScale.toFixed(4)}, so a full card at that scale renders text below `
        + "minOnScreenTextPx. Every scale between the two draws a full card whose smallest step is "
        + "under the floor, which is a legibility floor with a rendering mode that ignores it",
      "LIVE_GRAPH_CAMERA_CARD_BELOW_TEXT_FLOOR",
    );
  }
  if (normalized.semanticZoomCellMaxScale > normalized.overviewMaxScale) {
    fail(
      "semanticZoomCellMaxScale must not exceed overviewMaxScale",
      "LIVE_GRAPH_CAMERA_CELL_ABOVE_OVERVIEW",
    );
  }
  if (normalized.overviewMaxScale > normalized.maxScale) {
    fail(
      "overviewMaxScale must not exceed maxScale, otherwise pressing Overview leaves a state manual zoom cannot return to",
      "LIVE_GRAPH_CAMERA_OVERVIEW_ABOVE_MAX",
    );
  }
  if (normalized.zoomOutFactor >= 1 || normalized.zoomInFactor <= 1) {
    fail(
      "zoomOutFactor must be below 1 and zoomInFactor above it",
      "LIVE_GRAPH_CAMERA_ZOOM_FACTORS_INVALID",
    );
  }
  // A wheel notch must not move further than a deliberate button press, or the
  // coarse control would be the precise one.
  if (
    normalized.wheelZoomOutFactor >= 1
    || normalized.wheelZoomInFactor <= 1
    || normalized.wheelZoomInFactor > normalized.zoomInFactor
    || normalized.wheelZoomOutFactor < normalized.zoomOutFactor
  ) {
    fail(
      "wheel zoom factors must straddle 1 and stay inside the button-press step",
      "LIVE_GRAPH_CAMERA_WHEEL_FACTORS_INVALID",
    );
  }
  return normalized;
}

/** Read and validate the shipped graph-camera document. */
export function loadLiveGraphCameraPolicy(configUrl = LIVE_GRAPH_CAMERA_CONFIG_URL) {
  const filePath = fileURLToPath(configUrl);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`cannot read ${filePath}: ${error.message}`, "LIVE_GRAPH_CAMERA_UNREADABLE");
  }
  return normalizeLiveGraphCameraPolicy(parsed);
}

/**
 * Place the whole content bounding box inside the canvas.
 *
 * Self-contained on purpose: this function's own source is inlined into the
 * browser bundle, so it may not close over anything in this module.
 *
 * `wholeGraphFits` is returned rather than kept private because the caller has
 * to tell the user when it is false. The previous code computed the same fact
 * and dropped it, which is how a top-left corner came to be labelled "Overview".
 */
export function resolveOverviewCamera(canvas, content, inset, policy) {
  const usableWidth = canvas.width - inset.left - inset.right;
  const usableHeight = canvas.height - inset.top - inset.bottom;
  if (!(usableWidth > 0) || !(usableHeight > 0) || !(content.width > 0) || !(content.height > 0)) {
    return { scale: policy.minScale, x: inset.left, y: inset.top, wholeGraphFits: false };
  }
  const fittedScale = Math.min(usableWidth / content.width, usableHeight / content.height);
  const scale = Math.max(policy.minScale, Math.min(policy.overviewMaxScale, fittedScale));
  const wholeGraphFits = fittedScale >= policy.minScale;
  return {
    scale,
    x: wholeGraphFits ? inset.left + (usableWidth - content.width * scale) / 2 : inset.left,
    y: wholeGraphFits ? inset.top + (usableHeight - content.height * scale) / 2 : inset.top,
    wholeGraphFits,
  };
}

/**
 * Which node rendering the current scale calls for. Also self-contained, and
 * also inlined into the browser bundle by its own source.
 */
export function resolveSemanticZoom(scale, policy) {
  return scale < policy.semanticZoomCellMaxScale ? "cell" : "card";
}

/**
 * Follow mode lifts the camera to the card boundary while the inspector is open,
 * because the inspector narrows the canvas and the focused node has to stay
 * readable. The lift used to be one-way: closing the inspector left the camera
 * at the boundary and the scale the user had chosen was gone for the rest of the
 * session (measured 0.5884 -> 0.991, no return).
 *
 * `liftedFrom` is the caller's record of the replaced scale, or null when no
 * lift is outstanding. The restore is deliberately conditional on the scale
 * still being the value the lift wrote: anything else is a scale the user picked
 * after the lift, and theirs wins.
 */
export function resolveInspectorCameraLift({ inspectorOpen, scale, liftedFrom }, policy) {
  const target = policy.semanticZoomCellMaxScale;
  const outstanding = Number.isFinite(liftedFrom) ? liftedFrom : null;
  if (inspectorOpen) {
    if (!(scale < target)) return { scale, liftedFrom: outstanding };
    return { scale: target, liftedFrom: outstanding === null ? scale : outstanding };
  }
  if (outstanding === null) return { scale, liftedFrom: null };
  return { scale: scale === target ? outstanding : scale, liftedFrom: null };
}

/** Serialize the overview resolver for inlining into the browser bundle. */
export function serializeOverviewCameraResolver() {
  return resolveOverviewCamera.toString();
}

/** Serialize the semantic-zoom resolver for inlining into the browser bundle. */
export function serializeSemanticZoomResolver() {
  return resolveSemanticZoom.toString();
}

/** Serialize the inspector-lift resolver for inlining into the browser bundle. */
export function serializeInspectorCameraLiftResolver() {
  return resolveInspectorCameraLift.toString();
}

/**
 * The two custom properties the cell rendering divides against.
 *
 * `--camera-scale` ships with a default of 1 rather than being left undefined:
 * the cell rules divide by it, and an undefined custom property makes the whole
 * `calc()` invalid at computed-value time, which would drop the font size
 * silently on any page that never moves the camera.
 */
export function serializeCameraLegibilityCustomProperties(policy) {
  return `--min-onscreen-text-px: ${policy.minOnScreenTextPx}px; --camera-scale: 1;`;
}

/** The camera bounds the shipped page hands to its client script. */
export function serializeGraphCameraPolicyForClient(policy) {
  return Object.freeze({
    fitPaddingPx: policy.fitPaddingPx,
    minScale: policy.minScale,
    semanticZoomCellMaxScale: policy.semanticZoomCellMaxScale,
    overviewMaxScale: policy.overviewMaxScale,
    maxScale: policy.maxScale,
    minOnScreenTextPx: policy.minOnScreenTextPx,
    zoomInFactor: policy.zoomInFactor,
    zoomOutFactor: policy.zoomOutFactor,
    wheelZoomInFactor: policy.wheelZoomInFactor,
    wheelZoomOutFactor: policy.wheelZoomOutFactor,
  });
}
