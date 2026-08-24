import {
  LIVE_SDK_VERSION,
  SDK_AUTHORITY,
  THEME_CAPABILITIES,
  assertAuthority,
  boundedText,
  capabilityList,
  deepFreeze,
  enumValue,
  fail,
  record,
  runWithBoundary,
  safeIdentifier,
  semver,
  snapshotData,
  timestamp,
} from "./common.mjs";

export const REPLAY_THEME_SCHEMA_VERSION = "meta-kim-live-replay-theme-v1";

const DEFINITION_FIELDS = ["id", "version", "label", "capabilities", "render"];
const THEME_FIELDS = ["id", "version", "label"];
const FRAME_FIELDS = ["sequence", "at", "kind", "nodeId", "status", "label"];
const PRESENTATION_FIELDS = ["title", "tone", "marker"];
const RESULT_FIELDS = ["schemaVersion", "kind", "theme", "frame", "presentation", "capabilityDeclaration", "authority"];
const STATUS_VALUES = Object.freeze(["idle", "pending", "running", "completed", "failed", "blocked", "in_doubt", "unknown"]);
const TONE_VALUES = Object.freeze(["neutral", "active", "success", "danger", "warning", "muted"]);

function normalizeStatus(value, label) {
  const aliases = new Map([["active", "running"], ["in_progress", "running"], ["pass", "completed"], ["passed", "completed"], ["error", "failed"]]);
  return enumValue(typeof value === "string" ? aliases.get(value) || value : value, STATUS_VALUES, label);
}

/**
 * Normalize a public replay frame. No interpolation or event synthesis is
 * performed; the frame must originate from an existing replay record.
 *
 * @param {object} value
 * @returns {Readonly<object>}
 */
export function normalizeReplayFrame(value) {
  const current = record(value, FRAME_FIELDS, "replay frame");
  if (!Number.isSafeInteger(current.sequence) || current.sequence < 1 || current.sequence > 1_000_000) fail("replay frame.sequence must be a positive safe integer");
  return deepFreeze({
    sequence: current.sequence,
    at: timestamp(current.at, "replay frame.at"),
    kind: safeIdentifier(current.kind, "replay frame.kind"),
    nodeId: current.nodeId === null ? null : safeIdentifier(current.nodeId, "replay frame.nodeId"),
    status: normalizeStatus(current.status, "replay frame.status"),
    label: boundedText(current.label, "replay frame.label", 256),
  });
}

function normalizeTheme(value) {
  const current = record(value, THEME_FIELDS, "replay theme", ["capabilities", "render", "schemaVersion", "sdkVersion", "capabilityDeclaration"]);
  return {
    id: safeIdentifier(current.id, "replay theme.id"),
    version: semver(current.version, "replay theme.version"),
    label: boundedText(current.label, "replay theme.label", 128),
  };
}

function normalizeDefinition(value) {
  const current = record(value, DEFINITION_FIELDS, "replay theme");
  if (typeof current.render !== "function") fail("replay theme.render must be a function");
  return {
    ...normalizeTheme(current),
    capabilities: capabilityList(current.capabilities, "replay theme.capabilities", THEME_CAPABILITIES),
    render: current.render,
  };
}

function normalizeCapabilityDeclaration(value, label) {
  const current = record(value, ["schemaVersion", "sdkVersion", "capabilities", "authority"], label);
  if (current.schemaVersion !== REPLAY_THEME_SCHEMA_VERSION || current.sdkVersion !== LIVE_SDK_VERSION || current.authority !== "self_declared_projection") fail(`${label} is invalid`);
  return {
    schemaVersion: REPLAY_THEME_SCHEMA_VERSION,
    sdkVersion: LIVE_SDK_VERSION,
    capabilities: capabilityList(current.capabilities, `${label}.capabilities`, THEME_CAPABILITIES),
    authority: "self_declared_projection",
  };
}

function normalizePresentation(value) {
  const current = record(value, PRESENTATION_FIELDS, "replay theme presentation");
  return deepFreeze({
    title: boundedText(current.title, "replay theme presentation.title", 256),
    tone: enumValue(current.tone, TONE_VALUES, "replay theme presentation.tone"),
    marker: boundedText(current.marker, "replay theme presentation.marker", 32),
  });
}

/**
 * Define a dependency-free replay theme contribution. Themes return
 * structured presentation tokens, never HTML or DOM, so a host can render
 * them with its own safe text APIs.
 *
 * @param {object} definition
 * @returns {Readonly<object>}
 */
export function defineReplayTheme(definition) {
  const normalized = normalizeDefinition(definition);
  const capabilityDeclaration = Object.freeze({
    schemaVersion: REPLAY_THEME_SCHEMA_VERSION,
    sdkVersion: LIVE_SDK_VERSION,
    capabilities: normalized.capabilities,
    authority: "self_declared_projection",
  });
  const theme = {
    schemaVersion: REPLAY_THEME_SCHEMA_VERSION,
    sdkVersion: LIVE_SDK_VERSION,
    id: normalized.id,
    version: normalized.version,
    label: normalized.label,
    capabilityDeclaration,
    /**
     * @param {object} frame
     * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
     * @returns {Promise<Readonly<object>>}
     */
    async render(frame, options = {}) {
      const safeFrame = normalizeReplayFrame(snapshotData(frame, "replay theme.frame"));
      const context = Object.freeze({
        schemaVersion: REPLAY_THEME_SCHEMA_VERSION,
        sdkVersion: LIVE_SDK_VERSION,
        themeId: normalized.id,
        capabilityDeclaration,
        signal: options?.signal,
      });
      const raw = await runWithBoundary(() => normalized.render(safeFrame, context), options || {});
      return normalizePresentation(raw);
    },
  };
  return Object.freeze(theme);
}

/**
 * Render one existing replay frame through a theme and return a versioned,
 * projection-only envelope.
 *
 * @param {object} theme
 * @param {object} frame
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<Readonly<object>>}
 */
export async function renderReplayTheme(theme, frame, options = {}) {
  if (!theme || typeof theme !== "object" || typeof theme.render !== "function") fail("theme must be defined by defineReplayTheme");
  if (theme.schemaVersion !== REPLAY_THEME_SCHEMA_VERSION || theme.sdkVersion !== LIVE_SDK_VERSION) fail("theme schemaVersion or sdkVersion is unsupported");
  const manifest = record(theme, ["id", "version", "label"], "theme", ["schemaVersion", "sdkVersion", "capabilityDeclaration", "render"]);
  const normalizedManifest = normalizeTheme(manifest);
  const declaration = record(theme.capabilityDeclaration, ["schemaVersion", "sdkVersion", "capabilities", "authority"], "theme.capabilityDeclaration");
  if (declaration.schemaVersion !== REPLAY_THEME_SCHEMA_VERSION || declaration.sdkVersion !== LIVE_SDK_VERSION || declaration.authority !== "self_declared_projection") fail("theme capability declaration is invalid");
  const capabilities = capabilityList(declaration.capabilities, "theme.capabilityDeclaration.capabilities", THEME_CAPABILITIES);
  const normalizedFrame = normalizeReplayFrame(frame);
  const presentation = await theme.render(normalizedFrame, options);
  return deepFreeze({
    schemaVersion: REPLAY_THEME_SCHEMA_VERSION,
    kind: "replay_theme_frame",
    theme: Object.freeze(normalizedManifest),
    frame: normalizedFrame,
    presentation,
    capabilityDeclaration: normalizeCapabilityDeclaration(declaration, "theme.capabilityDeclaration"),
    authority: SDK_AUTHORITY,
    // Keep the declaration available for host diagnostics without making it
    // an authority claim. It is intentionally non-enumerable on the result.
  });
}

/**
 * Validate a rendered theme frame at a host boundary.
 *
 * @param {object} value
 * @returns {Readonly<object>}
 */
export function assertValidReplayThemeFrame(value) {
  const result = record(value, RESULT_FIELDS, "replay theme result");
  if (result.schemaVersion !== REPLAY_THEME_SCHEMA_VERSION || result.kind !== "replay_theme_frame") fail("replay theme identity is unsupported");
  const theme = record(result.theme, THEME_FIELDS, "replay theme result.theme");
  normalizeTheme(theme);
  normalizeReplayFrame(result.frame);
  normalizePresentation(result.presentation);
  normalizeCapabilityDeclaration(result.capabilityDeclaration, "replay theme result.capabilityDeclaration");
  assertAuthority(result.authority, "replay theme result.authority");
  return result;
}

export { STATUS_VALUES as REPLAY_THEME_STATUS_VALUES, TONE_VALUES as REPLAY_THEME_TONE_VALUES };
