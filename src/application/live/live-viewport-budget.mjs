/**
 * The graph canvas floor and the replay dock's geometry, for the Meta_Kim Live
 * control room.
 *
 * This module used to carry a predicted chrome inventory: a hand-measured height
 * for every band that renders above the canvas, summed and subtracted from the
 * window height to decide whether the eight-stage rail could afford to ship
 * expanded. That model is gone, and not because its numbers were wrong. It was a
 * second authority for a height the browser already computes -- `.main` gives the
 * run-context band `auto` and the canvas `minmax(0, 1fr)`, so the layout was
 * always dynamic and the inventory existed only to feed one JS comparison. Worse,
 * it could not be right at every width: the `(max-width: 1180px)` gate restacks
 * the run context, so one field named `dense` described two different band
 * compositions and drifted from both.
 *
 * The client now expands the rail, forces layout, reads the canvas back, and
 * keeps the rail open only if what remains clears `minCanvasHeightPx`. A measured
 * decision needs no band inventory, because it measures whatever actually
 * rendered.
 *
 * What survives is what production consumes: the floor the client compares
 * against, and the two heights the stylesheet cannot derive from its own content
 * because a collapsed row must cost what it renders rather than what it could
 * expand to.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LIVE_VIEWPORT_PROFILES_SCHEMA_VERSION = "meta-kim-live-viewport-profiles-v1";

export const LIVE_VIEWPORT_PROFILES_CONFIG_URL = new URL(
  "../../../config/live/viewport-profiles.json",
  import.meta.url,
);

function fail(message, code = "LIVE_VIEWPORT_BUDGET_INVALID") {
  const error = new TypeError(`Live viewport budget: ${message}`);
  error.code = code;
  throw error;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) fail(`${label} must be a positive integer`);
  return value;
}

function requiredObject(value, label) {
  if (!value || typeof value !== "object") fail(`${label} must be an object`);
  return value;
}

/**
 * Validate and freeze the chrome budget.
 *
 * Only three quantities remain, and each has exactly one consumer: the canvas
 * floor the client measures against, and the two replay-drawer heights plus the
 * status bar height the stylesheet needs as shared custom properties. A band the
 * stylesheet sizes from its own content is deliberately absent -- declaring it
 * here would put a number back in two places, which is the drift this module was
 * trimmed to remove.
 */
export function normalizeLiveChromeBudget(raw) {
  const budget = requiredObject(raw, "chromeBudget");
  const replay = requiredObject(budget.replayPanelHeightPx, "chromeBudget.replayPanelHeightPx");
  const normalized = Object.freeze({
    replayPanelHeightPx: Object.freeze({
      collapsed: positiveInteger(replay.collapsed, "chromeBudget.replayPanelHeightPx.collapsed"),
      open: positiveInteger(replay.open, "chromeBudget.replayPanelHeightPx.open"),
    }),
    statusBarHeightPx: positiveInteger(budget.statusBarHeightPx, "chromeBudget.statusBarHeightPx"),
    minCanvasHeightPx: positiveInteger(budget.minCanvasHeightPx, "chromeBudget.minCanvasHeightPx"),
  });
  if (normalized.replayPanelHeightPx.collapsed >= normalized.replayPanelHeightPx.open) {
    fail(
      "chromeBudget.replayPanelHeightPx.collapsed must be smaller than .open",
      "LIVE_VIEWPORT_BUDGET_REPLAY_INVERTED",
    );
  }
  return normalized;
}

/** The budget facts the shipped page hands to its client script. */
export function serializeViewportBudgetForClient(chromeBudget) {
  return Object.freeze({
    minCanvasHeightPx: chromeBudget.minCanvasHeightPx,
  });
}

/**
 * The band heights the stylesheet needs, as CSS custom properties.
 *
 * The stylesheet used to carry these numbers as literals, which made config one
 * of two authorities for the same quantity -- and the copies had drifted. Worse,
 * the copy in `.graph-panel`'s row tracks was the drawer's OPEN height, charged
 * to the canvas while the drawer was collapsed. Shipping the budget as custom
 * properties leaves one authority and lets a collapsed row cost what it renders.
 *
 * Only the bands whose height is a shared quantity are emitted. A band the
 * stylesheet sizes from its own content does not need a property, and inventing
 * one would put a number back in two places.
 */
export function serializeChromeBudgetCustomProperties(chromeBudget) {
  return [
    ["--h-replay-collapsed", chromeBudget.replayPanelHeightPx.collapsed],
    ["--h-replay-open", chromeBudget.replayPanelHeightPx.open],
    ["--h-status-bar", chromeBudget.statusBarHeightPx],
  ]
    .map(([name, pixels]) => `${name}: ${pixels}px;`)
    .join(" ");
}

/**
 * Horizontal geometry the replay dock shares between two rules.
 *
 * The collapsed summary is absolutely positioned over the dock's first column,
 * so the open dock header has to be inset far enough to clear it. Only the width
 * is declared: the inset is the width plus the stylesheet's own spacing step, so
 * there is one number to change rather than a pair that can drift apart and
 * silently overlap the header.
 */
export function normalizeLiveDockBudget(raw) {
  const budget = requiredObject(raw, "dockBudget");
  return Object.freeze({
    replayCollapseSummaryWidthPx: positiveInteger(
      budget.replayCollapseSummaryWidthPx,
      "dockBudget.replayCollapseSummaryWidthPx",
    ),
  });
}

/** The dock geometry the stylesheet needs, as CSS custom properties. */
export function serializeDockBudgetCustomProperties(dockBudget) {
  return `--w-replay-collapse: ${dockBudget.replayCollapseSummaryWidthPx}px;`;
}

/**
 * How many labels the replay time axis may print.
 *
 * The axis shipped nine literal labels reading `00:00` through `02:00`, written
 * into the markup and never touched by the renderer, so a forty-minute run
 * displayed a two-minute axis. The ninth label was also clipped 26px at
 * 1024x768: nine 30px labels need 270px and the band offers 244px. Both are the
 * same defect -- a label count nobody resolved against either the run's duration
 * or the width available to show it.
 *
 * `minLabelWidthPx` is a measured worst case for the widest label a long run
 * produces, not a CSS lower bound. An optimistic label width overflows the band
 * exactly the way an optimistic band height clipped the drawer.
 */
export function normalizeLiveReplayTickBand(raw) {
  const band = requiredObject(raw, "replayTickBand");
  const normalized = Object.freeze({
    minLabelWidthPx: positiveInteger(band.minLabelWidthPx, "replayTickBand.minLabelWidthPx"),
    minLabelCount: positiveInteger(band.minLabelCount, "replayTickBand.minLabelCount"),
    maxLabelCount: positiveInteger(band.maxLabelCount, "replayTickBand.maxLabelCount"),
  });
  if (normalized.minLabelCount < 2) {
    fail(
      "replayTickBand.minLabelCount must be at least 2: one label cannot show a span, so an axis of one is decoration "
        + "rather than a timeline",
      "LIVE_VIEWPORT_BUDGET_TICK_SPAN_DEGENERATE",
    );
  }
  if (normalized.maxLabelCount < normalized.minLabelCount) {
    fail(
      "replayTickBand.maxLabelCount must not be smaller than .minLabelCount, otherwise no count satisfies both bounds "
        + "and the axis can never render",
      "LIVE_VIEWPORT_BUDGET_TICK_BOUNDS_INVERTED",
    );
  }
  return normalized;
}

/**
 * The number of labels a band of the given width can show without clipping.
 *
 * Returns 0 rather than a clipped axis when the width cannot even fit
 * `minLabelCount` labels. Hiding is the degradation; rendering a label the band
 * cuts in half is the defect this resolver exists to remove.
 *
 * Serialized into the page by source, so it must stay free of module scope.
 */
export function resolveReplayTickCount(availableWidthPx, tickBand) {
  if (!Number.isFinite(availableWidthPx) || availableWidthPx <= 0) return 0;
  const fits = Math.floor(availableWidthPx / tickBand.minLabelWidthPx);
  if (fits < tickBand.minLabelCount) return 0;
  return Math.min(fits, tickBand.maxLabelCount);
}

/**
 * Evenly spaced offsets, in milliseconds from the run's first replay event,
 * spanning the observed duration and nothing else.
 *
 * The last offset is the duration itself, which is what makes the axis a
 * statement about this run rather than a decorative ruler.
 *
 * Serialized into the page by source, so it must stay free of module scope.
 */
export function resolveReplayTickOffsetsMs(durationMs, count) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return [];
  if (!Number.isInteger(count) || count < 2) return [];
  const offsets = [];
  for (let index = 0; index < count; index += 1) {
    offsets.push(Math.round((durationMs * index) / (count - 1)));
  }
  return offsets;
}

/** The tick-band facts the shipped page hands to its client script. */
export function serializeReplayTickBandForClient(tickBand) {
  return Object.freeze({
    minLabelWidthPx: tickBand.minLabelWidthPx,
    minLabelCount: tickBand.minLabelCount,
    maxLabelCount: tickBand.maxLabelCount,
  });
}

/**
 * Ship the count resolver's own source to the browser.
 *
 * The client script cannot import this module, and a hand-written copy inside the
 * page string would be a second implementation of arithmetic the tests only
 * exercise here. Shipping the source keeps the browser running byte-for-byte
 * what the contract test asserts.
 */
export function serializeReplayTickCountResolver() {
  return resolveReplayTickCount.toString();
}

/** Ship the offset resolver's own source to the browser, for the same reason. */
export function serializeReplayTickOffsetsResolver() {
  return resolveReplayTickOffsetsMs.toString();
}

/** Read and validate the shipped viewport-profile document. */
function readViewportProfilesDocument(configUrl) {
  const filePath = fileURLToPath(configUrl);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`cannot read ${filePath}: ${error.message}`, "LIVE_VIEWPORT_BUDGET_UNREADABLE");
  }
  if (parsed.schemaVersion !== LIVE_VIEWPORT_PROFILES_SCHEMA_VERSION) {
    fail(
      `schemaVersion must be ${LIVE_VIEWPORT_PROFILES_SCHEMA_VERSION}`,
      "LIVE_VIEWPORT_BUDGET_SCHEMA_MISMATCH",
    );
  }
  return parsed;
}

/** Read and validate the shipped viewport-profile document's chrome budget. */
export function loadLiveChromeBudget(configUrl = LIVE_VIEWPORT_PROFILES_CONFIG_URL) {
  return normalizeLiveChromeBudget(readViewportProfilesDocument(configUrl).chromeBudget);
}

/** Read and validate the shipped viewport-profile document's dock budget. */
export function loadLiveDockBudget(configUrl = LIVE_VIEWPORT_PROFILES_CONFIG_URL) {
  return normalizeLiveDockBudget(readViewportProfilesDocument(configUrl).dockBudget);
}

/** Read and validate the shipped viewport-profile document's replay tick band. */
export function loadLiveReplayTickBand(configUrl = LIVE_VIEWPORT_PROFILES_CONFIG_URL) {
  return normalizeLiveReplayTickBand(readViewportProfilesDocument(configUrl).replayTickBand);
}

