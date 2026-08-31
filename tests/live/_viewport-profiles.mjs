/**
 * Viewport profile evaluation for the Meta_Kim Live control room.
 *
 * Pure functions only. Profiles and chrome budgets arrive as injected data so
 * that no resolution, breakpoint, or panel height is hardcoded here. The
 * evaluator resolves which top-level `@media` blocks of a stylesheet apply to a
 * declared profile, and whether the remaining vertical space still fits the
 * graph canvas.
 *
 * This is verification machinery, not shipped runtime code, which is why it sits
 * beside its test rather than under src/. The control room emits its own media
 * queries; nothing in the shipped tree reads a viewport profile. Living under
 * src/application/live would put it inside the set of modules that
 * tests/live/live-hub-lifecycle.test.mjs requires the hub package identity to
 * hash, and hashing a module the tarball omits makes the packed hub unable to
 * identify itself. Move it back only together with a real shipped importer and a
 * package.json `files` entry.
 */
export const LIVE_VIEWPORT_PROFILES_SCHEMA_VERSION = "meta-kim-live-viewport-profiles-v1";

const FEATURE_PATTERN = /\(\s*(min|max)-(width|height)\s*:\s*(-?\d+(?:\.\d+)?)px\s*\)/giu;

function fail(message, code = "LIVE_VIEWPORT_PROFILE_INVALID") {
  const error = new TypeError(`Live viewport profile: ${message}`);
  error.code = code;
  throw error;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) fail(`${label} must be a positive integer`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string`);
  return value;
}

function normalizeChromeBudget(raw) {
  if (!raw || typeof raw !== "object") fail("chromeBudget must be an object");
  const runContext = raw.runContextMinHeightPx;
  const replay = raw.replayPanelHeightPx;
  if (!runContext || typeof runContext !== "object") fail("chromeBudget.runContextMinHeightPx must be an object");
  if (!replay || typeof replay !== "object") fail("chromeBudget.replayPanelHeightPx must be an object");
  return Object.freeze({
    topbarHeightPx: positiveInteger(raw.topbarHeightPx, "chromeBudget.topbarHeightPx"),
    runContextMinHeightPx: Object.freeze({
      dense: positiveInteger(runContext.dense, "chromeBudget.runContextMinHeightPx.dense"),
      compact: positiveInteger(runContext.compact, "chromeBudget.runContextMinHeightPx.compact"),
    }),
    replayPanelHeightPx: Object.freeze({
      collapsed: positiveInteger(replay.collapsed, "chromeBudget.replayPanelHeightPx.collapsed"),
      open: positiveInteger(replay.open, "chromeBudget.replayPanelHeightPx.open"),
    }),
    statusBarHeightPx: positiveInteger(raw.statusBarHeightPx, "chromeBudget.statusBarHeightPx"),
    minCanvasHeightPx: positiveInteger(raw.minCanvasHeightPx, "chromeBudget.minCanvasHeightPx"),
  });
}

function normalizeGate(raw, label) {
  if (!raw || typeof raw !== "object") fail(`${label} must be an object`);
  return Object.freeze({
    id: typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id : label,
    condition: requiredString(raw.condition, `${label}.condition`),
  });
}

function normalizeProfile(raw, index) {
  if (!raw || typeof raw !== "object") fail(`profiles[${index}] must be an object`);
  return Object.freeze({
    id: requiredString(raw.id, `profiles[${index}].id`),
    label: requiredString(raw.label, `profiles[${index}].label`),
    widthPx: positiveInteger(raw.widthPx, `profiles[${index}].widthPx`),
    heightPx: positiveInteger(raw.heightPx, `profiles[${index}].heightPx`),
    role: requiredString(raw.role, `profiles[${index}].role`),
    expectDenseLayout: raw.expectDenseLayout === true,
    expectSingleColumnFallback: raw.expectSingleColumnFallback === true,
    screenshotRef: typeof raw.screenshotRef === "string" && raw.screenshotRef.trim() !== "" ? raw.screenshotRef : null,
  });
}

/** Validate and freeze a raw viewport-profile document. */
export function normalizeLiveViewportProfiles(raw) {
  if (!raw || typeof raw !== "object") fail("document must be an object");
  if (raw.schemaVersion !== LIVE_VIEWPORT_PROFILES_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${LIVE_VIEWPORT_PROFILES_SCHEMA_VERSION}`, "LIVE_VIEWPORT_PROFILE_SCHEMA_MISMATCH");
  }
  if (!Array.isArray(raw.profiles) || raw.profiles.length === 0) fail("profiles must be a non-empty list");
  const profiles = raw.profiles.map(normalizeProfile);
  const ids = new Set();
  for (const profile of profiles) {
    if (ids.has(profile.id)) fail(`duplicate profile id ${profile.id}`, "LIVE_VIEWPORT_PROFILE_DUPLICATE");
    ids.add(profile.id);
  }
  const collapseGates = Array.isArray(raw.collapseGates)
    ? raw.collapseGates.map((gate, index) => normalizeGate(gate, `collapseGates[${index}]`))
    : [];
  return Object.freeze({
    schemaVersion: raw.schemaVersion,
    denseLayoutGate: normalizeGate(raw.denseLayoutGate, "denseLayoutGate"),
    collapseGates: Object.freeze(collapseGates),
    chromeBudget: normalizeChromeBudget(raw.chromeBudget),
    profiles: Object.freeze(profiles),
  });
}

/**
 * Decide whether a `@media` condition list applies to a profile.
 *
 * Only pixel width/height features participate. A condition carrying any other
 * feature (for example `prefers-reduced-motion`) is reported as
 * viewport-independent so callers never treat it as a resolution gate.
 */
export function evaluateMediaCondition(condition, profile) {
  const text = requiredString(condition, "condition");
  const features = [...text.matchAll(FEATURE_PATTERN)];
  const featureless = text.replace(FEATURE_PATTERN, "").replace(/\band\b|\ball\b|\bonly\b|\bscreen\b|,|\s/giu, "");
  if (features.length === 0) return { applies: false, viewportDependent: false, features: [] };
  const evaluated = features.map(([, bound, axis, rawValue]) => {
    const threshold = Number(rawValue);
    const actual = axis === "width" ? profile.widthPx : profile.heightPx;
    const satisfied = bound === "min" ? actual >= threshold : actual <= threshold;
    return { bound, axis, threshold, actual, satisfied };
  });
  return {
    applies: featureless === "" && evaluated.every((feature) => feature.satisfied),
    viewportDependent: true,
    features: Object.freeze(evaluated),
  };
}

/**
 * Extract top-level `@media` blocks from a stylesheet using brace matching.
 * Regex alone cannot survive the nested rule bodies these blocks contain.
 */
export function extractMediaBlocks(css) {
  const source = requiredString(css, "css");
  const blocks = [];
  let cursor = 0;
  while (cursor < source.length) {
    const at = source.indexOf("@media", cursor);
    if (at === -1) break;
    const open = source.indexOf("{", at);
    if (open === -1) break;
    const condition = source.slice(at + "@media".length, open).trim();
    let depth = 0;
    let index = open;
    for (; index < source.length; index += 1) {
      const character = source[index];
      if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) break;
    blocks.push({ condition, body: source.slice(open + 1, index), startIndex: at });
    cursor = index + 1;
  }
  return blocks;
}

/** Resolve every stylesheet media block that applies to one profile. */
export function resolveApplicableMediaBlocks(css, profile) {
  return extractMediaBlocks(css)
    .map((block) => ({ ...block, ...evaluateMediaCondition(block.condition, profile) }))
    .filter((block) => block.applies);
}

/**
 * Compute the vertical space left for the graph canvas after fixed chrome.
 * `replayOpen` selects the expanded replay drawer height.
 */
export function evaluateViewportChromeBudget(profile, chromeBudget, { replayOpen = false, dense = true } = {}) {
  const runContextHeight = dense
    ? chromeBudget.runContextMinHeightPx.dense
    : chromeBudget.runContextMinHeightPx.compact;
  const replayHeight = replayOpen
    ? chromeBudget.replayPanelHeightPx.open
    : chromeBudget.replayPanelHeightPx.collapsed;
  const consumedPx = chromeBudget.topbarHeightPx + runContextHeight + replayHeight + chromeBudget.statusBarHeightPx;
  const canvasHeightPx = profile.heightPx - consumedPx;
  return Object.freeze({
    profileId: profile.id,
    dense,
    replayOpen,
    consumedPx,
    canvasHeightPx,
    minCanvasHeightPx: chromeBudget.minCanvasHeightPx,
    fits: canvasHeightPx >= chromeBudget.minCanvasHeightPx,
  });
}
