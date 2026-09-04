/**
 * Spacing scale policy for the Meta_Kim Live control room.
 *
 * The typography ladder fixed how large text is; it said nothing about how far
 * apart boxes sit, and that turned out to be the other half of the same defect.
 * The stylesheet carried 322 static spacing components across 52 distinct
 * values, sixteen of which sat inside a single 4.48px-to-8.8px window. A list of
 * per-rule literals cannot be reviewed for grouping any more than it could be
 * reviewed for hierarchy, because the relationship between the values is not
 * written down anywhere.
 *
 * This module is deliberately NOT fluid, unlike the type ladder. The vertical
 * chrome budget in `config/live/viewport-profiles.json` declares each band's
 * height as an absolute pixel count, and the canvas floor is checked against
 * their sum. A viewport-relative spacing base would make every band height a
 * function of window width, so that budget could no longer be verified as a
 * constant - it would need a sweep, and the sweep would have no worst case
 * because interior spacing and available height both grow. Fixed rem steps keep
 * the budget a checkable number while still honouring a reader who enlarges
 * their root.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LIVE_SPACING_SCALE_SCHEMA_VERSION = "meta-kim-live-spacing-scale-v1";

export const LIVE_SPACING_SCALE_CONFIG_URL = new URL(
  "../../../config/live/spacing-scale.json",
  import.meta.url,
);

/**
 * Steps the control room actually consumes, in ladder order. A document that
 * dropped one would ship CSS pointing at an undefined custom property, and an
 * invalid `var()` in a spacing property does not fail loudly - the declaration
 * becomes invalid at computed-value time and the box silently inherits a
 * distance nobody chose.
 */
export const REQUIRED_SPACING_STEPS = Object.freeze([
  "hairline",
  "tight",
  "snug",
  "cozy",
  "default",
  "roomy",
  "section",
  "band",
]);

function fail(message, code = "LIVE_SPACING_SCALE_INVALID") {
  const error = new TypeError(`Live spacing scale: ${message}`);
  error.code = code;
  throw error;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string`);
  return value.trim();
}

function positiveNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(`${label} must be a finite positive number`);
  }
  return value;
}

/**
 * A custom-property name is interpolated straight into the shipped stylesheet,
 * so restricting it to the CSS grammar keeps a malformed document from emitting
 * a declaration that swallows the rest of the block.
 */
function customPropertyName(value, label) {
  const name = requiredString(value, label);
  if (!/^--[a-z0-9][a-z0-9-]*$/u.test(name)) {
    fail(`${label} must match --[a-z0-9-]+`, "LIVE_SPACING_SCALE_UNSAFE_PROPERTY");
  }
  return name;
}

function stepName(value, label) {
  const name = requiredString(value, label);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/u.test(name)) {
    fail(`${label} must be lower-case kebab-case`, "LIVE_SPACING_SCALE_UNSAFE_PROPERTY");
  }
  return name;
}

/**
 * Only the two absolute units are accepted. A viewport-relative or em-relative
 * step would resolve differently per rule, which is the property this ladder
 * exists to remove.
 */
function lengthToPx(length, rootFontSizePx, label) {
  const rem = length.match(/^([0-9.]+)rem$/u);
  if (rem) return Number(rem[1]) * rootFontSizePx;
  const px = length.match(/^([0-9.]+)px$/u);
  if (px) return Number(px[1]);
  fail(`${label} is "${length}"; a spacing step must be rem or px`, "LIVE_SPACING_SCALE_UNRESOLVABLE_LENGTH");
  return 0;
}

function normalizeGrid(raw) {
  if (!raw || typeof raw !== "object") fail("grid must be an object");
  return Object.freeze({
    rootFontSizePx: positiveNumber(raw.rootFontSizePx, "grid.rootFontSizePx"),
    stepPx: positiveNumber(raw.stepPx, "grid.stepPx"),
    rationale: requiredString(raw.rationale, "grid.rationale"),
  });
}

/**
 * The separation contract. Ordering alone was the wrong quantity on the type
 * ladder and it is the wrong quantity here for the same reason: a strictly
 * increasing list of 52 values is still 52 values.
 */
function normalizeHierarchy(raw) {
  if (!raw || typeof raw !== "object") fail("hierarchy must be an object");
  const minimumAdjacentRatio = positiveNumber(raw.minimumAdjacentRatio, "hierarchy.minimumAdjacentRatio");
  if (minimumAdjacentRatio <= 1) {
    fail(
      `hierarchy.minimumAdjacentRatio (${minimumAdjacentRatio}) must exceed 1, or two steps may share a distance`,
      "LIVE_SPACING_SCALE_INDISTINCT",
    );
  }
  return Object.freeze({
    minimumAdjacentRatio,
    minimumAdjacentDeltaPx: positiveNumber(raw.minimumAdjacentDeltaPx, "hierarchy.minimumAdjacentDeltaPx"),
    rationale: requiredString(raw.rationale, "hierarchy.rationale"),
  });
}

/**
 * The floor and the population it governs. The family names belong to the
 * typography document, so this only checks that they are well-formed names -
 * whether each one exists is asserted where both documents are already in scope,
 * which keeps the two ladders independent modules rather than one importing the
 * other for a cross-reference neither owns.
 */
function normalizeTextAdjacency(raw) {
  if (!raw || typeof raw !== "object") fail("textAdjacency must be an object");
  const families = raw.appliesToLeadingFamilies;
  if (!Array.isArray(families) || families.length === 0) {
    fail(
      "textAdjacency.appliesToLeadingFamilies must name at least one leading family; "
        + "an unscoped floor cannot tell a padded prose block from a status pill",
      "LIVE_SPACING_TEXT_ADJACENT_UNSCOPED",
    );
  }
  return Object.freeze({
    minimumPx: positiveNumber(raw.minimumPx, "textAdjacency.minimumPx"),
    appliesToLeadingFamilies: Object.freeze(
      families.map((name, index) => stepName(name, `textAdjacency.appliesToLeadingFamilies[${index}]`)),
    ),
    rationale: requiredString(raw.rationale, "textAdjacency.rationale"),
    scopeRationale: requiredString(raw.scopeRationale, "textAdjacency.scopeRationale"),
  });
}

/**
 * The gap floor. Separate from `textAdjacency` because the two govern different
 * declarations rather than different magnitudes: padding is declared by the rule
 * that sizes its own text, and a gap is declared by the container between two
 * children that size theirs. A sweep built for the first cannot see the second at
 * all - the container declares no font size - which is how a 2px gap between a
 * label and its value passed a floor whose own role already claimed "between two
 * lines of one field".
 */
function normalizeBoxSeparation(raw) {
  if (!raw || typeof raw !== "object") fail("boxSeparation must be an object");
  return Object.freeze({
    minimumPx: positiveNumber(raw.minimumPx, "boxSeparation.minimumPx"),
    rationale: requiredString(raw.rationale, "boxSeparation.rationale"),
  });
}

function normalizeSteps(raw, { prefix, grid }) {
  if (!Array.isArray(raw) || raw.length === 0) fail("steps must be a non-empty array");
  const seen = new Set();
  let previousPixels = 0;
  const steps = raw.map((entry, index) => {
    if (!entry || typeof entry !== "object") fail(`steps[${index}] must be an object`);
    const name = stepName(entry.name, `steps[${index}].name`);
    if (seen.has(name)) fail(`steps[${index}].name duplicates "${name}"`, "LIVE_SPACING_SCALE_DUPLICATE_STEP");
    seen.add(name);
    const length = requiredString(entry.length, `steps[${index}].length`);
    const pixels = lengthToPx(length, grid.rootFontSizePx, `steps[${index}].length`);
    if (pixels % grid.stepPx !== 0) {
      fail(
        `"${name}" resolves to ${pixels}px, which is off the ${grid.stepPx}px grid`,
        "LIVE_SPACING_SCALE_OFF_GRID",
      );
    }
    if (pixels <= previousPixels) {
      fail(
        `steps must be ordered by strictly increasing distance; "${name}" (${pixels}px) does not exceed ${previousPixels}px`,
        "LIVE_SPACING_SCALE_NOT_MONOTONIC",
      );
    }
    previousPixels = pixels;
    return Object.freeze({
      name,
      length,
      pixels,
      role: requiredString(entry.role, `steps[${index}].role`),
      customProperty: `${prefix}${name}`,
    });
  });
  const missing = REQUIRED_SPACING_STEPS.filter((name) => !seen.has(name));
  if (missing.length > 0) {
    fail(`steps must define ${missing.join(", ")}`, "LIVE_SPACING_SCALE_MISSING_STEP");
  }
  return Object.freeze(steps);
}

/** Every step's resolved pixel distance, in ladder order. */
export function resolveSpacingStepPixels(scale) {
  return Object.freeze(
    scale.steps.map((step) => Object.freeze({ name: step.name, length: step.length, pixels: step.pixels })),
  );
}

/** The ratio and pixel gap between each pair of adjacent steps. */
export function adjacentSpacingSeparations(scale) {
  return Object.freeze(
    scale.steps.slice(1).map((step, index) => {
      const previous = scale.steps[index];
      return Object.freeze({
        from: previous.name,
        to: step.name,
        ratio: step.pixels / previous.pixels,
        deltaPx: step.pixels - previous.pixels,
      });
    }),
  );
}

/**
 * The step that text-adjacent padding bottoms out at. The floor has to be a step
 * rather than a free number: a floor between two steps can only be satisfied by
 * writing a literal, which grows a second hand-tuned set of values beside the
 * ladder instead of on it.
 */
export function textAdjacentFloorStep(scale) {
  return scale.steps.find((step) => step.pixels === scale.textAdjacency.minimumPx) ?? null;
}

/**
 * The step every gap bottoms out at, for the same reason the text floor is a step
 * rather than a number.
 */
export function boxSeparationFloorStep(scale) {
  return scale.steps.find((step) => step.pixels === scale.boxSeparation.minimumPx) ?? null;
}

/** Validate and freeze a raw spacing-scale document. */
export function normalizeLiveSpacingScale(raw) {
  if (!raw || typeof raw !== "object") fail("document must be an object");
  if (raw.schemaVersion !== LIVE_SPACING_SCALE_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${LIVE_SPACING_SCALE_SCHEMA_VERSION}`, "LIVE_SPACING_SCALE_SCHEMA_MISMATCH");
  }
  const grid = normalizeGrid(raw.grid);
  const stepPropertyPrefix = customPropertyName(raw.stepPropertyPrefix, "stepPropertyPrefix");
  const scale = Object.freeze({
    schemaVersion: raw.schemaVersion,
    grid,
    hierarchy: normalizeHierarchy(raw.hierarchy),
    textAdjacency: normalizeTextAdjacency(raw.textAdjacency),
    boxSeparation: normalizeBoxSeparation(raw.boxSeparation),
    stepPropertyPrefix,
    steps: normalizeSteps(raw.steps, { prefix: stepPropertyPrefix, grid }),
  });
  assertLadderIsDistinct(scale);
  assertTextAdjacencyFloorIsReachable(scale);
  assertBoxSeparationFloorIsReachable(scale);
  assertBoxSeparationIsUnderTextFloor(scale);
  return scale;
}

function assertLadderIsDistinct(scale) {
  const { minimumAdjacentRatio, minimumAdjacentDeltaPx } = scale.hierarchy;
  for (const { from, to, ratio, deltaPx } of adjacentSpacingSeparations(scale)) {
    if (ratio < minimumAdjacentRatio) {
      fail(
        `"${from}" and "${to}" step by only ${ratio.toFixed(3)}x, under the ${minimumAdjacentRatio}x minimum; `
          + "two distances this close group identically",
        "LIVE_SPACING_SCALE_INDISTINCT",
      );
    }
    if (deltaPx < minimumAdjacentDeltaPx) {
      fail(
        `"${from}" and "${to}" differ by only ${deltaPx}px, under the ${minimumAdjacentDeltaPx}px minimum`,
        "LIVE_SPACING_SCALE_INDISTINCT",
      );
    }
  }
}

function assertTextAdjacencyFloorIsReachable(scale) {
  if (textAdjacentFloorStep(scale)) return;
  const nearest = scale.steps
    .map((step) => `${step.name} (${step.pixels}px)`)
    .join(", ");
  fail(
    `textAdjacency.minimumPx is ${scale.textAdjacency.minimumPx}px, which no step reaches exactly; steps are ${nearest}`,
    "LIVE_SPACING_TEXT_ADJACENT_UNREACHABLE",
  );
}

function assertBoxSeparationFloorIsReachable(scale) {
  if (boxSeparationFloorStep(scale)) return;
  const nearest = scale.steps.map((step) => `${step.name} (${step.pixels}px)`).join(", ");
  fail(
    `boxSeparation.minimumPx is ${scale.boxSeparation.minimumPx}px, which no step reaches exactly; steps are ${nearest}`,
    "LIVE_SPACING_BOX_SEPARATION_UNREACHABLE",
  );
}

function assertBoxSeparationIsUnderTextFloor(scale) {
  if (scale.boxSeparation.minimumPx <= scale.textAdjacency.minimumPx) return;
  fail(
    `boxSeparation.minimumPx (${scale.boxSeparation.minimumPx}px) exceeds textAdjacency.minimumPx `
      + `(${scale.textAdjacency.minimumPx}px), so the general gap floor would overrule the text floor `
      + "it is supposed to sit under",
    "LIVE_SPACING_BOX_SEPARATION_ABOVE_TEXT_FLOOR",
  );
}

/** Read and validate the shipped spacing-scale document. */
export function loadLiveSpacingScale(configUrl = LIVE_SPACING_SCALE_CONFIG_URL) {
  const filePath = fileURLToPath(configUrl);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`cannot read ${filePath}: ${error.message}`, "LIVE_SPACING_SCALE_UNREADABLE");
  }
  return normalizeLiveSpacingScale(parsed);
}

/** Resolve the ladder into ordered `[customProperty, cssValue]` pairs. */
export function spacingCustomProperties(scale) {
  return Object.freeze(
    scale.steps.map((step) => Object.freeze([step.customProperty, step.length])),
  );
}

/** Serialize the ladder as CSS declarations for a rule body. */
export function serializeSpacingCustomProperties(scale) {
  return spacingCustomProperties(scale)
    .map(([property, value]) => `${property}: ${value};`)
    .join(" ");
}
