/**
 * Vertical space budget for the Meta_Kim Live control room graph canvas, plus the
 * replay dock's horizontal geometry.
 *
 * The canvas is the default view, so the run's shape is only visible when the
 * canvas keeps a usable height. `config/live/viewport-profiles.json` has
 * declared `chromeBudget.minCanvasHeightPx` from the start, but the budget only
 * counted the topbar, run context, replay dock and status bar. Two bands sit
 * between the run context and the canvas and were never counted: the eight-stage
 * rail (`.stage-overview`, 101px while expanded) and the graph tool bar
 * (`.graph-stage-bar`, up to 95px once its controls wrap). The grid row gaps
 * were missing too. A budget that omits bands cannot fail, which is why the
 * contract test stayed green while a browser at 1024x768 rendered a 337px canvas
 * against a declared 360px floor.
 *
 * Every height here is a measured worst case rather than a CSS `min-height`.
 * `min-height` is a lower bound on what a band may occupy, so subtracting it
 * overstates what is left for the canvas -- exactly the direction that hides the
 * defect. The numbers live in config; this module only resolves them.
 *
 * The resolver returns one derived threshold,
 * `stageOverviewOpenMinViewportHeightPx`, instead of exporting the affordability
 * predicate itself. The control-room client script is serialized into a page
 * string and cannot import this module, so shipping a threshold keeps a single
 * implementation of the arithmetic; shipping a predicate would fork it.
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

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
  return value;
}

function requiredObject(value, label) {
  if (!value || typeof value !== "object") fail(`${label} must be an object`);
  return value;
}

/**
 * Validate and freeze the chrome budget.
 *
 * The band names are deliberately `...HeightPx` rather than `...MinHeightPx`:
 * the previous name invited callers to supply a CSS floor, and a floor is the
 * wrong quantity for a subtraction that has to be conservative.
 */
export function normalizeLiveChromeBudget(raw) {
  const budget = requiredObject(raw, "chromeBudget");
  const runContext = requiredObject(budget.runContextHeightPx, "chromeBudget.runContextHeightPx");
  const stageOverview = requiredObject(budget.stageOverviewHeightPx, "chromeBudget.stageOverviewHeightPx");
  const replay = requiredObject(budget.replayPanelHeightPx, "chromeBudget.replayPanelHeightPx");
  const normalized = Object.freeze({
    topbarHeightPx: positiveInteger(budget.topbarHeightPx, "chromeBudget.topbarHeightPx"),
    runContextHeightPx: Object.freeze({
      dense: positiveInteger(runContext.dense, "chromeBudget.runContextHeightPx.dense"),
      compact: positiveInteger(runContext.compact, "chromeBudget.runContextHeightPx.compact"),
    }),
    stageOverviewHeightPx: Object.freeze({
      open: positiveInteger(stageOverview.open, "chromeBudget.stageOverviewHeightPx.open"),
      collapsed: positiveInteger(stageOverview.collapsed, "chromeBudget.stageOverviewHeightPx.collapsed"),
    }),
    graphStageBarHeightPx: positiveInteger(budget.graphStageBarHeightPx, "chromeBudget.graphStageBarHeightPx"),
    replayPanelHeightPx: Object.freeze({
      collapsed: positiveInteger(replay.collapsed, "chromeBudget.replayPanelHeightPx.collapsed"),
      open: positiveInteger(replay.open, "chromeBudget.replayPanelHeightPx.open"),
    }),
    statusBarHeightPx: positiveInteger(budget.statusBarHeightPx, "chromeBudget.statusBarHeightPx"),
    workspaceRowGapPx: nonNegativeInteger(budget.workspaceRowGapPx, "chromeBudget.workspaceRowGapPx"),
    workspaceRowGapCount: nonNegativeInteger(budget.workspaceRowGapCount, "chromeBudget.workspaceRowGapCount"),
    minCanvasHeightPx: positiveInteger(budget.minCanvasHeightPx, "chromeBudget.minCanvasHeightPx"),
  });
  if (normalized.stageOverviewHeightPx.collapsed >= normalized.stageOverviewHeightPx.open) {
    fail(
      "chromeBudget.stageOverviewHeightPx.collapsed must be smaller than .open, otherwise collapsing the stage rail "
        + "cannot recover canvas height and the auto-collapse policy is a no-op",
      "LIVE_VIEWPORT_BUDGET_COLLAPSE_USELESS",
    );
  }
  if (normalized.replayPanelHeightPx.collapsed >= normalized.replayPanelHeightPx.open) {
    fail(
      "chromeBudget.replayPanelHeightPx.collapsed must be smaller than .open",
      "LIVE_VIEWPORT_BUDGET_REPLAY_INVERTED",
    );
  }
  return normalized;
}

/**
 * The floor that applies while the replay drawer is open.
 *
 * Derived rather than declared: opening the timeline is a user action that may
 * cost the canvas exactly the drawer's own extra height and nothing more. A
 * second literal in config could be tuned downward until a failing profile
 * passed, which is the failure mode this whole module exists to remove.
 */
export function replayOpenCanvasFloorPx(chromeBudget) {
  const drawerCost = chromeBudget.replayPanelHeightPx.open - chromeBudget.replayPanelHeightPx.collapsed;
  return Math.max(1, chromeBudget.minCanvasHeightPx - drawerCost);
}

/**
 * The floor that applies while the eight-stage rail is expanded by explicit user
 * choice below the affordability threshold.
 *
 * Derived for the same reason as the replay drawer's floor: expanding the rail is
 * a user action that may cost the canvas exactly the rail's own extra height and
 * nothing more. The alternative -- overriding the user's explicit expansion --
 * would be a refusal rather than a degradation, and a second declared floor could
 * be tuned downward until a failing profile passed.
 */
export function stageRailExpandedCanvasFloorPx(chromeBudget) {
  const railCost = chromeBudget.stageOverviewHeightPx.open - chromeBudget.stageOverviewHeightPx.collapsed;
  return Math.max(1, chromeBudget.minCanvasHeightPx - railCost);
}

/** Sum every band that competes with the canvas for vertical space. */
export function resolveChromeConsumedPx(
  chromeBudget,
  { dense = true, replayOpen = false, stageOverviewOpen = true } = {},
) {
  return (
    chromeBudget.topbarHeightPx
    + (dense ? chromeBudget.runContextHeightPx.dense : chromeBudget.runContextHeightPx.compact)
    + (stageOverviewOpen ? chromeBudget.stageOverviewHeightPx.open : chromeBudget.stageOverviewHeightPx.collapsed)
    + chromeBudget.graphStageBarHeightPx
    + (replayOpen ? chromeBudget.replayPanelHeightPx.open : chromeBudget.replayPanelHeightPx.collapsed)
    + chromeBudget.statusBarHeightPx
    + chromeBudget.workspaceRowGapPx * chromeBudget.workspaceRowGapCount
  );
}

/**
 * Resolve the canvas height one layout state leaves, and whether it clears the
 * floor that applies to that state.
 */
export function resolveGraphCanvasBudget(
  { viewportHeightPx, profileId = null },
  chromeBudget,
  { dense = true, replayOpen = false, stageOverviewOpen = true } = {},
) {
  positiveInteger(viewportHeightPx, "viewportHeightPx");
  const consumedPx = resolveChromeConsumedPx(chromeBudget, { dense, replayOpen, stageOverviewOpen });
  const canvasHeightPx = viewportHeightPx - consumedPx;
  const minCanvasHeightPx = replayOpen ? replayOpenCanvasFloorPx(chromeBudget) : chromeBudget.minCanvasHeightPx;
  return Object.freeze({
    profileId,
    dense,
    replayOpen,
    stageOverviewOpen,
    consumedPx,
    canvasHeightPx,
    minCanvasHeightPx,
    fits: canvasHeightPx >= minCanvasHeightPx,
  });
}

/**
 * The smallest viewport height at which the eight-stage rail can stay expanded
 * without pushing the canvas below its floor.
 *
 * This single number is what the shipped client script consumes. The rail then
 * ships collapsed and expands only where the height is affordable, so a short
 * viewport never renders a canvas too small to show the run.
 */
export function stageOverviewOpenMinViewportHeightPx(chromeBudget) {
  return (
    resolveChromeConsumedPx(chromeBudget, { dense: true, replayOpen: false, stageOverviewOpen: true })
    + chromeBudget.minCanvasHeightPx
  );
}

/**
 * The layout state the control room actually ships at one viewport height:
 * the rail expands only when the budget affords it.
 */
export function resolveDefaultLayoutState(viewportHeightPx, chromeBudget) {
  positiveInteger(viewportHeightPx, "viewportHeightPx");
  return Object.freeze({
    stageOverviewOpen: viewportHeightPx >= stageOverviewOpenMinViewportHeightPx(chromeBudget),
    replayOpen: false,
  });
}

/** The budget facts the shipped page hands to its client script. */
export function serializeViewportBudgetForClient(chromeBudget) {
  return Object.freeze({
    stageOverviewOpenMinViewportHeightPx: stageOverviewOpenMinViewportHeightPx(chromeBudget),
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

