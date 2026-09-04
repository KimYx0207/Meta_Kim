/**
 * Typography scale policy for the Meta_Kim Live control room.
 *
 * The control room previously sized every text run with a per-rule literal. The
 * result inverted its own hierarchy: undeclared placeholder copy fell back to
 * the 16px root size while the primary run metric was pinned at `.68rem`, so
 * the least informative text on screen rendered largest and the most
 * informative rendered smallest.
 *
 * A list of literals cannot be checked for ordering, because ordering is not
 * written down anywhere in it. This module derives every step from one fluid
 * base and one ratio per step, so the rendered order follows from ratio
 * monotonicity at any viewport width instead of from someone re-reading 90
 * declarations. `normalizeLiveTypographyScale` rejects a non-increasing ratio
 * list, which makes an inverted ladder unrepresentable rather than merely
 * discouraged.
 *
 * Ordering and legibility are independent properties, and fixing the first does
 * not fix the second: a perfectly ordered ladder resolved 7.81px placeholder
 * prose and 9.89px button labels, because nothing bounded how small the bottom
 * of the ladder could get. `legibility.minimumRenderedPixels` closes that gap.
 * The bound needs no viewport list — `clamp(min, preferred, max)` can never
 * resolve below `min`, so the smallest size the ladder can ever render is
 * `base.min` times the smallest ratio, a property of the document alone.
 *
 * A well-ordered, legible ladder still says nothing about which element earns
 * which step. The top step was called `metric` and sized `.context-fact strong`,
 * one selector matching six counters, so six numbers rendered at 28.52px while
 * the run title beside them was clamped to one line and ellipsised 87px short at
 * a smaller step — the ladder was correct and the page still told the reader that
 * the event count mattered more than which run they were looking at. The step is
 * now `hero` and belongs to the run identity line, and the guard counts elements
 * rather than selectors, because "exactly one selector carries the top tier" was
 * true the whole time the defect shipped.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LIVE_TYPOGRAPHY_SCALE_SCHEMA_VERSION = "meta-kim-live-typography-scale-v2";

export const LIVE_TYPOGRAPHY_SCALE_CONFIG_URL = new URL(
  "../../../config/live/typography-scale.json",
  import.meta.url,
);

/**
 * Semantic steps the control room actually consumes. The renderer references
 * these names directly, so a document that drops one would ship CSS pointing at
 * an undefined custom property; that failure would only surface as unstyled
 * text in a browser, long after the run that introduced it.
 */
export const REQUIRED_TYPOGRAPHY_STEPS = Object.freeze([
  "micro",
  "label",
  "entity-body",
  "body",
  "entity-title",
  "view-title",
  "hero",
]);

/**
 * Leading families, keyed by how the text wraps rather than by which type step
 * it sits on. One step serves both a single-line uppercase monospace label and a
 * wrapped caption, and those want different leading, so the step name cannot
 * decide it.
 */
export const LIVE_TYPOGRAPHY_LEADING_FAMILIES = Object.freeze(["display", "flat", "snug", "normal"]);

function fail(message, code = "LIVE_TYPOGRAPHY_SCALE_INVALID") {
  const error = new TypeError(`Live typography scale: ${message}`);
  error.code = code;
  throw error;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string`);
  return value.trim();
}

function positiveRatio(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(`${label} must be a finite positive number`);
  }
  return value;
}

/**
 * A custom-property name is interpolated straight into the shipped stylesheet.
 * Restricting it to the CSS custom-property grammar keeps a malformed config
 * from emitting a declaration that silently swallows the rest of the block.
 */
function customPropertyName(value, label) {
  const name = requiredString(value, label);
  if (!/^--[a-z0-9][a-z0-9-]*$/u.test(name)) {
    fail(`${label} must match --[a-z0-9-]+`, "LIVE_TYPOGRAPHY_SCALE_UNSAFE_PROPERTY");
  }
  return name;
}

function stepName(value, label) {
  const name = requiredString(value, label);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/u.test(name)) {
    fail(`${label} must be lower-case kebab-case`, "LIVE_TYPOGRAPHY_SCALE_UNSAFE_PROPERTY");
  }
  return name;
}

/**
 * The base is a fluid length: a floor, a viewport-relative preferred value, and
 * a ceiling. Steps multiply it, so the floor and ceiling bound the whole ladder
 * and no step needs its own breakpoint override.
 */
function normalizeBase(raw) {
  if (!raw || typeof raw !== "object") fail("base must be an object");
  return Object.freeze({
    customProperty: customPropertyName(raw.customProperty, "base.customProperty"),
    min: requiredString(raw.min, "base.min"),
    preferred: requiredString(raw.preferred, "base.preferred"),
    max: requiredString(raw.max, "base.max"),
  });
}

/**
 * The absolute-size contract. `rootFontSizePx` is the root size the floor is
 * claimed against; a reader who enlarges their root only gets larger text, so
 * the standard 16px is the worst case rather than an assumption about everyone.
 */
function normalizeLegibility(raw) {
  if (!raw || typeof raw !== "object") fail("legibility must be an object");
  return Object.freeze({
    rootFontSizePx: positiveRatio(raw.rootFontSizePx, "legibility.rootFontSizePx"),
    minimumRenderedPixels: positiveRatio(raw.minimumRenderedPixels, "legibility.minimumRenderedPixels"),
    rationale: requiredString(raw.rationale, "legibility.rationale"),
  });
}

/**
 * Resolve one CSS length to pixels. Only the units the ladder is allowed to use
 * are accepted, so a unit this module cannot reason about is a config error
 * rather than a silent `NaN` that would disable every downstream bound.
 */
function lengthToPx(length, { rootFontSizePx, viewportWidth }) {
  const rem = length.match(/^([0-9.]+)rem$/u);
  if (rem) return Number(rem[1]) * rootFontSizePx;
  const px = length.match(/^([0-9.]+)px$/u);
  if (px) return Number(px[1]);
  const vw = length.match(/^([0-9.]+)vw$/u);
  if (vw) {
    if (!Number.isFinite(viewportWidth)) {
      fail(`${length} needs a viewport width to resolve`, "LIVE_TYPOGRAPHY_SCALE_UNRESOLVABLE_LENGTH");
    }
    return (Number(vw[1]) / 100) * viewportWidth;
  }
  fail(`unsupported length "${length}"; use rem, px or vw`, "LIVE_TYPOGRAPHY_SCALE_UNRESOLVABLE_LENGTH");
  return 0;
}

function sumLengths(expression, context) {
  return expression
    .split("+")
    .map((part) => lengthToPx(part.trim(), context))
    .reduce((total, part) => total + part, 0);
}

/**
 * Resolve `--fs-base` the way the browser resolves its `clamp()`, at one
 * viewport width.
 */
export function resolveTypographyBasePx(scale, viewportWidth) {
  const context = { rootFontSizePx: scale.legibility.rootFontSizePx, viewportWidth };
  const min = sumLengths(scale.base.min, context);
  const max = sumLengths(scale.base.max, context);
  const preferred = sumLengths(scale.base.preferred, context);
  return Math.min(Math.max(preferred, min), max);
}

/** Every step's rendered pixel size at one viewport width, in ladder order. */
export function resolveTypographyStepPixels(scale, viewportWidth) {
  const base = resolveTypographyBasePx(scale, viewportWidth);
  return Object.freeze(
    scale.steps.map((step) => Object.freeze({ name: step.name, ratio: step.ratio, pixels: base * step.ratio })),
  );
}

/**
 * The smallest size the ladder can render at any viewport width. `clamp()`
 * bottoms out at `min`, so this is the worst case for the whole document and
 * needs no width to evaluate.
 */
export function smallestRenderedPixels(scale) {
  const floorBase = sumLengths(scale.base.min, {
    rootFontSizePx: scale.legibility.rootFontSizePx,
    viewportWidth: Number.NaN,
  });
  return floorBase * scale.steps[0].ratio;
}

/**
 * The pixel and ratio separation between each pair of adjacent steps, evaluated
 * at the ladder floor.
 *
 * The floor is the worst case for both quantities. An adjacent pixel delta is
 * `base * (ratio_next - ratio_current)`, which is monotonically increasing in
 * the base, so a ladder that separates at `base.min` separates at every viewport
 * width; the ratio is independent of the base entirely. That is what lets this
 * be a property of the document rather than a sweep over widths.
 */
export function adjacentStepSeparations(scale) {
  const floorBase = sumLengths(scale.base.min, {
    rootFontSizePx: scale.legibility.rootFontSizePx,
    viewportWidth: Number.NaN,
  });
  return Object.freeze(
    scale.steps.slice(1).map((step, index) => {
      const previous = scale.steps[index];
      return Object.freeze({
        from: previous.name,
        to: step.name,
        ratio: step.ratio / previous.ratio,
        deltaPx: floorBase * (step.ratio - previous.ratio),
      });
    }),
  );
}

function normalizeSteps(raw, prefix) {
  if (!Array.isArray(raw) || raw.length === 0) fail("steps must be a non-empty array");
  const seen = new Set();
  let previousRatio = 0;
  const steps = raw.map((entry, index) => {
    if (!entry || typeof entry !== "object") fail(`steps[${index}] must be an object`);
    const name = stepName(entry.name, `steps[${index}].name`);
    if (seen.has(name)) fail(`steps[${index}].name duplicates "${name}"`, "LIVE_TYPOGRAPHY_SCALE_DUPLICATE_STEP");
    seen.add(name);
    const ratio = positiveRatio(entry.ratio, `steps[${index}].ratio`);
    if (ratio <= previousRatio) {
      fail(
        `steps must be ordered by strictly increasing ratio; steps[${index}] "${name}" (${ratio}) does not exceed ${previousRatio}`,
        "LIVE_TYPOGRAPHY_SCALE_NOT_MONOTONIC",
      );
    }
    previousRatio = ratio;
    return Object.freeze({
      name,
      ratio,
      role: requiredString(entry.role, `steps[${index}].role`),
      customProperty: `${prefix}${name}`,
    });
  });
  const missing = REQUIRED_TYPOGRAPHY_STEPS.filter((name) => !seen.has(name));
  if (missing.length > 0) {
    fail(`steps must define ${missing.join(", ")}`, "LIVE_TYPOGRAPHY_SCALE_MISSING_STEP");
  }
  return Object.freeze(steps);
}

/**
 * The separation contract. Monotonicity was already enforced and was the wrong
 * quantity on its own: an ordered ladder collapsed 54% of on-screen text onto
 * one size. Both bounds are required because each is blind at one end of the
 * ladder — a pixel delta lets the large end drift together, a ratio lets the
 * small end collapse.
 */
function normalizeHierarchy(raw) {
  if (!raw || typeof raw !== "object") fail("hierarchy must be an object");
  const minimumAdjacentRatio = positiveRatio(raw.minimumAdjacentRatio, "hierarchy.minimumAdjacentRatio");
  if (minimumAdjacentRatio <= 1) {
    fail(
      `hierarchy.minimumAdjacentRatio (${minimumAdjacentRatio}) must exceed 1, or it permits two steps at the same size`,
      "LIVE_TYPOGRAPHY_SCALE_INDISTINCT",
    );
  }
  return Object.freeze({
    minimumAdjacentRatio,
    minimumAdjacentDeltaPx: positiveRatio(raw.minimumAdjacentDeltaPx, "hierarchy.minimumAdjacentDeltaPx"),
    rationale: requiredString(raw.rationale, "hierarchy.rationale"),
  });
}

/**
 * The leading contract. `line-height: 1` makes the line box equal to the glyph
 * em box, so the text touches whatever is stacked against it however much
 * padding the container carries. Rejecting a ratio of 1 or less at the document
 * level makes that unrepresentable instead of merely discouraged.
 */
function normalizeLeading(raw) {
  if (!raw || typeof raw !== "object") fail("leading must be an object");
  const prefix = customPropertyName(raw.customPropertyPrefix, "leading.customPropertyPrefix");
  const minimumRatio = positiveRatio(raw.minimumRatio, "leading.minimumRatio");
  if (minimumRatio <= 1) {
    fail(
      `leading.minimumRatio (${minimumRatio}) must exceed 1; a line box equal to the glyph box has no leading`,
      "LIVE_TYPOGRAPHY_LEADING_TOO_TIGHT",
    );
  }
  if (!Array.isArray(raw.families) || raw.families.length === 0) {
    fail("leading.families must be a non-empty array");
  }
  const seen = new Set();
  const families = raw.families.map((entry, index) => {
    if (!entry || typeof entry !== "object") fail(`leading.families[${index}] must be an object`);
    const name = stepName(entry.name, `leading.families[${index}].name`);
    if (seen.has(name)) {
      fail(`leading.families[${index}].name duplicates "${name}"`, "LIVE_TYPOGRAPHY_LEADING_DUPLICATE_FAMILY");
    }
    seen.add(name);
    const ratio = positiveRatio(entry.ratio, `leading.families[${index}].ratio`);
    if (ratio < minimumRatio) {
      fail(
        `leading family "${name}" is ${ratio}, under the ${minimumRatio} floor`,
        "LIVE_TYPOGRAPHY_LEADING_TOO_TIGHT",
      );
    }
    return Object.freeze({
      name,
      ratio,
      role: requiredString(entry.role, `leading.families[${index}].role`),
      customProperty: `${prefix}${name}`,
    });
  });
  const missing = LIVE_TYPOGRAPHY_LEADING_FAMILIES.filter((name) => !seen.has(name));
  if (missing.length > 0) {
    fail(`leading.families must define ${missing.join(", ")}`, "LIVE_TYPOGRAPHY_LEADING_MISSING_FAMILY");
  }
  return Object.freeze({
    customPropertyPrefix: prefix,
    minimumRatio,
    rationale: requiredString(raw.rationale, "leading.rationale"),
    families: Object.freeze(families),
  });
}

/** Validate and freeze a raw typography-scale document. */
export function normalizeLiveTypographyScale(raw) {
  if (!raw || typeof raw !== "object") fail("document must be an object");
  if (raw.schemaVersion !== LIVE_TYPOGRAPHY_SCALE_SCHEMA_VERSION) {
    fail(
      `schemaVersion must be ${LIVE_TYPOGRAPHY_SCALE_SCHEMA_VERSION}`,
      "LIVE_TYPOGRAPHY_SCALE_SCHEMA_MISMATCH",
    );
  }
  const stepPropertyPrefix = customPropertyName(raw.stepPropertyPrefix, "stepPropertyPrefix");
  const scale = Object.freeze({
    schemaVersion: raw.schemaVersion,
    base: normalizeBase(raw.base),
    legibility: normalizeLegibility(raw.legibility),
    hierarchy: normalizeHierarchy(raw.hierarchy),
    stepPropertyPrefix,
    steps: normalizeSteps(raw.steps, stepPropertyPrefix),
    leading: normalizeLeading(raw.leading),
  });
  assertClampIsOrdered(scale);
  assertLadderIsLegible(scale);
  assertLadderIsDistinct(scale);
  return scale;
}

/**
 * An inverted clamp would make `base.min` unreachable, which would in turn make
 * the legibility floor a claim about a value the browser never resolves to.
 */
function assertClampIsOrdered(scale) {
  const context = { rootFontSizePx: scale.legibility.rootFontSizePx, viewportWidth: Number.NaN };
  const min = sumLengths(scale.base.min, context);
  const max = sumLengths(scale.base.max, context);
  if (min > max) {
    fail(
      `base.min (${scale.base.min}) must not exceed base.max (${scale.base.max})`,
      "LIVE_TYPOGRAPHY_SCALE_INVALID_RANGE",
    );
  }
}

function assertLadderIsLegible(scale) {
  const smallest = smallestRenderedPixels(scale);
  const floor = scale.legibility.minimumRenderedPixels;
  if (smallest < floor) {
    const step = scale.steps[0];
    fail(
      `"${step.name}" bottoms out at ${smallest.toFixed(2)}px, below the ${floor}px legibility floor; `
        + `raise base.min or ${step.name}'s ratio`,
      "LIVE_TYPOGRAPHY_SCALE_ILLEGIBLE",
    );
  }
}

function assertLadderIsDistinct(scale) {
  const { minimumAdjacentRatio, minimumAdjacentDeltaPx } = scale.hierarchy;
  for (const { from, to, ratio, deltaPx } of adjacentStepSeparations(scale)) {
    if (ratio < minimumAdjacentRatio) {
      fail(
        `"${from}" and "${to}" step by only ${ratio.toFixed(4)}x, under the ${minimumAdjacentRatio}x minimum; `
          + "two steps this close read as one level",
        "LIVE_TYPOGRAPHY_SCALE_INDISTINCT",
      );
    }
    if (deltaPx < minimumAdjacentDeltaPx) {
      fail(
        `"${from}" and "${to}" differ by only ${deltaPx.toFixed(2)}px at the ladder floor, `
          + `under the ${minimumAdjacentDeltaPx}px minimum`,
        "LIVE_TYPOGRAPHY_SCALE_INDISTINCT",
      );
    }
  }
}

/** Read and validate the shipped typography-scale document. */
export function loadLiveTypographyScale(configUrl = LIVE_TYPOGRAPHY_SCALE_CONFIG_URL) {
  const filePath = fileURLToPath(configUrl);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`cannot read ${filePath}: ${error.message}`, "LIVE_TYPOGRAPHY_SCALE_UNREADABLE");
  }
  return normalizeLiveTypographyScale(parsed);
}

/**
 * Trailing zeros in the emitted ratio would make the stylesheet disagree with
 * the config document for no benefit, so the number is printed in its shortest
 * exact form.
 */
function ratioLiteral(ratio) {
  return String(ratio);
}

/** Resolve the ladder into ordered `[customProperty, cssValue]` pairs. */
export function typographyCustomProperties(scale) {
  const { base, steps, leading } = scale;
  const baseValue = `clamp(${base.min}, ${base.preferred}, ${base.max})`;
  return Object.freeze([
    Object.freeze([base.customProperty, baseValue]),
    ...steps.map((step) =>
      Object.freeze([step.customProperty, `calc(var(${base.customProperty}) * ${ratioLiteral(step.ratio)})`]),
    ),
    ...leading.families.map((family) =>
      Object.freeze([family.customProperty, ratioLiteral(family.ratio)]),
    ),
  ]);
}

/** Serialize the ladder as CSS declarations for a rule body. */
export function serializeTypographyCustomProperties(scale) {
  return typographyCustomProperties(scale)
    .map(([property, value]) => `${property}: ${value};`)
    .join(" ");
}
