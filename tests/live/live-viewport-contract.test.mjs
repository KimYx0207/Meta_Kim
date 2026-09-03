import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  LIVE_VIEWPORT_PROFILES_SCHEMA_VERSION,
  evaluateMediaCondition,
  evaluateViewportChromeBudget,
  extractMediaBlocks,
  normalizeLiveViewportProfiles,
  resolveApplicableMediaBlocks,
} from "./_viewport-profiles.mjs";
import {
  loadLiveReplayTickBand,
  replayOpenCanvasFloorPx,
  resolveChromeConsumedPx,
  resolveDefaultLayoutState,
  resolveReplayTickCount,
  resolveReplayTickOffsetsMs,
  serializeReplayTickBandForClient,
  serializeReplayTickCountResolver,
  serializeReplayTickOffsetsResolver,
  stageOverviewOpenMinViewportHeightPx,
  stageRailExpandedCanvasFloorPx,
} from "../../src/application/live/live-viewport-budget.mjs";
import { renderLiveControlRoomPage } from "../../src/presentation/live/live-control-room-page.mjs";

const CONFIG_PATH = fileURLToPath(new URL("../../config/live/viewport-profiles.json", import.meta.url));
const config = normalizeLiveViewportProfiles(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));

const html = renderLiveControlRoomPage({});
const styleOpen = html.indexOf("<style>");
const styleClose = html.indexOf("</style>", styleOpen);
assert.ok(styleOpen >= 0 && styleClose > styleOpen, "rendered page must ship an inline stylesheet");
const css = html.slice(styleOpen + "<style>".length, styleClose);

const STACKED_FALLBACK_PATTERN = /\.workspace-grid[^{}]*\{[^{}]*display:\s*block/iu;

function ruleBodyFor(selectorPattern, source) {
  const match = new RegExp(`${selectorPattern}[^{}]*\\{([^{}]*)\\}`, "iu").exec(source);
  return match ? match[1] : null;
}

/**
 * Every rule body whose selector list contains `selector` exactly, in document
 * order, media blocks included. Substring matching would fold a descendant rule
 * into its ancestor's assertions -- `.replay-panel[open]` also prefixes
 * `.replay-panel[open] .replay-dock-header` -- so the selector list is split and
 * compared whole.
 */
function allRuleBodies(selector, source) {
  const bodies = [];
  for (const [, selectorList, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selectors = selectorList.split(",").map((entry) => entry.trim());
    if (selectors.some((entry) => entry === selector)) bodies.push(body);
  }
  return bodies;
}

/** The winning value of one property for one selector under document-order last-wins. */
function resolvedDeclarationValue(selector, property, source) {
  let resolved = null;
  for (const body of allRuleBodies(selector, source)) {
    const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "iu").exec(body);
    if (match) resolved = match[1].trim();
  }
  return resolved;
}

/** Every class that appears on a `<details>` element in the shipped markup. */
function detailsClassNames(markup) {
  const names = new Set();
  for (const [, attributes] of markup.matchAll(/<details\b([^>]*)>/giu)) {
    const classAttribute = /class="([^"]*)"/iu.exec(attributes);
    if (!classAttribute) continue;
    for (const name of classAttribute[1].split(/\s+/u).filter(Boolean)) names.add(name);
  }
  return names;
}

/**
 * Class names the stylesheet lays out as a grid or flex container.
 *
 * Only selectors that target the element itself count: a descendant or child
 * combinator makes the declaration someone else's layout. Presence in any state
 * is enough -- a `<details>` that is a grid only while `[open]` needs the same
 * opt-out as one that is always a grid.
 */
function containerLayoutClassNames(source) {
  const names = new Set();
  for (const [, selectorList, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    if (!/(?:^|;)\s*display\s*:\s*(?:inline-)?(?:grid|flex)\s*(?:;|$)/iu.test(body)) continue;
    for (const selector of selectorList.split(",")) {
      const ownElement = /^\s*\.([\w-]+)(?:\[[^\]]*\]|:not\([^)]*\)|::?[\w-]+)*\s*$/u.exec(selector);
      if (ownElement) names.add(ownElement[1]);
    }
  }
  return names;
}

test("viewport profile config is schema-valid and carries both mandated regression resolutions", () => {
  assert.equal(config.schemaVersion, LIVE_VIEWPORT_PROFILES_SCHEMA_VERSION);
  const baselines = config.profiles.filter((profile) => profile.role === "regression-baseline");
  assert.ok(baselines.length >= 2, "at least two regression baselines must be declared");
  const dimensions = baselines.map((profile) => `${profile.widthPx}x${profile.heightPx}`);
  assert.ok(dimensions.includes("2560x1368"), "2560x1368 regression baseline must be declared in config");
  assert.ok(dimensions.includes("2048x1094"), "2048x1094 regression baseline must be declared in config");
  for (const profile of baselines) {
    assert.ok(profile.screenshotRef, `${profile.id} must declare a screenshot reference path`);
  }
});

test("declared regression baselines exist on disk at exactly the resolution they claim", () => {
  // A screenshotRef that only names a file lets a stale or missing baseline pass
  // as evidence. Read the PNG header instead: signature plus IHDR width/height
  // is the cheapest proof that the capture really happened at that resolution.
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const baselines = config.profiles.filter((profile) => profile.role === "regression-baseline");
  assert.ok(baselines.length >= 2, "config must declare the baselines this assertion is meant to police");
  for (const profile of baselines) {
    const imagePath = fileURLToPath(new URL(`../../${profile.screenshotRef}`, import.meta.url));
    const bytes = readFileSync(imagePath);
    assert.ok(bytes.length > 1024, `${profile.id}: ${profile.screenshotRef} is too small to be a real capture`);
    assert.equal(bytes.subarray(0, 8).equals(PNG_SIGNATURE), true, `${profile.id}: ${profile.screenshotRef} is not a PNG`);
    assert.equal(bytes.readUInt32BE(16), profile.widthPx, `${profile.id}: baseline width must match the declared profile`);
    assert.equal(bytes.readUInt32BE(20), profile.heightPx, `${profile.id}: baseline height must match the declared profile`);
  }
});

test("stylesheet media blocks parse with balanced braces and expose viewport dependency", () => {
  const blocks = extractMediaBlocks(css);
  assert.ok(blocks.length >= 4, "shipped stylesheet must retain its responsive media blocks");
  for (const block of blocks) {
    assert.equal(block.body.split("{").length, block.body.split("}").length, `unbalanced braces in @media ${block.condition}`);
  }
  const reducedMotion = blocks.find((block) => /prefers-reduced-motion/iu.test(block.condition));
  assert.ok(reducedMotion, "prefers-reduced-motion block is mandatory (WCAG 2.1 AA)");
  assert.match(reducedMotion.body, /animation-duration:\s*\.?0*1?m?s\s*!important/iu);
  const evaluated = evaluateMediaCondition(reducedMotion.condition, config.profiles[0]);
  assert.equal(evaluated.viewportDependent, false, "reduced-motion must never be treated as a resolution gate");
});

test("dense desktop layout gate resolves exactly as each profile declares", () => {
  for (const profile of config.profiles) {
    const gate = evaluateMediaCondition(config.denseLayoutGate.condition, profile);
    assert.equal(
      gate.applies,
      profile.expectDenseLayout,
      `${profile.label}: dense gate applicability must match the declared expectation`,
    );
  }
  const denseProfiles = config.profiles.filter((profile) => profile.expectDenseLayout);
  const sparseProfiles = config.profiles.filter((profile) => !profile.expectDenseLayout);
  assert.ok(denseProfiles.length > 0 && sparseProfiles.length > 0, "config must keep both positive and negative controls so the gate assertion cannot pass vacuously");
});

test("regression baselines keep the canvas-first grid and never collapse to the stacked fallback", () => {
  const baseWorkspace = ruleBodyFor("\\.workspace-grid", css);
  assert.ok(baseWorkspace, "base .workspace-grid rule must exist");
  assert.match(baseWorkspace, /display:\s*grid/iu, "base workspace must be a grid, not a stacked block");

  for (const profile of config.profiles) {
    const applicable = resolveApplicableMediaBlocks(css, profile);
    const collapses = applicable.some((block) => STACKED_FALLBACK_PATTERN.test(block.body));
    assert.equal(
      collapses,
      profile.expectSingleColumnFallback,
      `${profile.label}: stacked workspace fallback must apply only where declared`,
    );
  }
});

test("dense profiles leave enough vertical space for the graph canvas in both replay states", () => {
  for (const profile of config.profiles.filter((entry) => entry.expectDenseLayout)) {
    const layout = resolveDefaultLayoutState(profile.heightPx, config.chromeBudget);
    for (const replayOpen of [false, true]) {
      const budget = evaluateViewportChromeBudget(profile, config.chromeBudget, {
        replayOpen,
        dense: true,
        stageOverviewOpen: layout.stageOverviewOpen,
      });
      assert.ok(
        budget.fits,
        `${profile.label}: replayOpen=${replayOpen} leaves ${budget.canvasHeightPx}px, below the ${budget.minCanvasHeightPx}px canvas floor`,
      );
    }
  }
});

test("the stage-rail auto-collapse policy is load-bearing, not decorative", () => {
  // Without this assertion the previous test could pass because every dense
  // profile happens to afford an expanded rail, which would make the collapse
  // policy untested rather than satisfied. At least one declared dense profile
  // must genuinely be unable to afford the expanded rail.
  const forcedOpenFailures = config.profiles
    .filter((entry) => entry.expectDenseLayout)
    .map((profile) => ({
      profile,
      budget: evaluateViewportChromeBudget(profile, config.chromeBudget, {
        replayOpen: false,
        dense: true,
        stageOverviewOpen: true,
      }),
    }))
    .filter((entry) => !entry.budget.fits);

  assert.ok(
    forcedOpenFailures.length > 0,
    "config must keep a dense profile short enough that an always-expanded stage rail breaks the canvas floor, "
      + "otherwise the auto-collapse contract is vacuous",
  );

  for (const { profile, budget } of forcedOpenFailures) {
    const collapsed = evaluateViewportChromeBudget(profile, config.chromeBudget, {
      replayOpen: false,
      dense: true,
      stageOverviewOpen: false,
    });
    assert.ok(
      collapsed.fits,
      `${profile.label}: collapsing the stage rail recovers only ${collapsed.canvasHeightPx}px, still below the `
        + `${collapsed.minCanvasHeightPx}px floor (${budget.canvasHeightPx}px while expanded)`,
    );
    assert.equal(
      resolveDefaultLayoutState(profile.heightPx, config.chromeBudget).stageOverviewOpen,
      false,
      `${profile.label}: default layout must ship the stage rail collapsed at a height that cannot afford it`,
    );
  }
});

test("the shipped page defers the stage rail's expanded state to the measured chrome budget", () => {
  // `<details open>` in the markup is a height decision taken without knowing the
  // viewport. At 1024x768 it rendered a 337px canvas against a declared 360px
  // floor, so the run's shape was off-screen in the default view. The rail must
  // ship collapsed and expand only where the budget affords it.
  const railMatch = /<details\b[^>]*\bclass="stage-overview"[^>]*>/iu.exec(html);
  assert.ok(railMatch, "page must ship the eight-stage rail as a details element");
  assert.doesNotMatch(
    railMatch[0],
    /\sopen(?=[\s>=])/iu,
    "stage rail must not hardcode `open`; the expanded state depends on viewport height",
  );

  const threshold = stageOverviewOpenMinViewportHeightPx(config.chromeBudget);
  assert.ok(
    html.includes(String(threshold)),
    `page must carry the derived stage-rail threshold (${threshold}px) so the client applies the same budget as this test`,
  );
});

test("the replay-open canvas floor is derived from the drawer's own cost", () => {
  // A second declared floor could be tuned downward until a failing profile
  // passed. Deriving it pins the concession to exactly the drawer's height.
  const { chromeBudget } = config;
  const drawerCost = chromeBudget.replayPanelHeightPx.open - chromeBudget.replayPanelHeightPx.collapsed;
  assert.equal(
    replayOpenCanvasFloorPx(chromeBudget),
    chromeBudget.minCanvasHeightPx - drawerCost,
    "opening the replay drawer may cost the canvas the drawer's height and nothing more",
  );
});

test("chrome budget counts every band that renders above the graph canvas", () => {
  // The budget that shipped before this contract summed four bands and omitted
  // the eight-stage rail, the graph tool bar and the workspace row gaps, so it
  // could not fail. Assert the sum reacts to each band instead of trusting the
  // field list.
  const { chromeBudget } = config;
  const baseline = resolveChromeConsumedPx(chromeBudget, { dense: true, replayOpen: false, stageOverviewOpen: true });
  const collapsedRail = resolveChromeConsumedPx(chromeBudget, {
    dense: true,
    replayOpen: false,
    stageOverviewOpen: false,
  });
  assert.equal(
    baseline - collapsedRail,
    chromeBudget.stageOverviewHeightPx.open - chromeBudget.stageOverviewHeightPx.collapsed,
    "consumed height must track the stage rail's expanded/collapsed delta",
  );
  assert.ok(
    baseline > chromeBudget.topbarHeightPx
      + chromeBudget.runContextHeightPx.dense
      + chromeBudget.replayPanelHeightPx.collapsed
      + chromeBudget.statusBarHeightPx,
    "consumed height must exceed the four bands the original budget counted",
  );
  assert.ok(
    chromeBudget.graphStageBarHeightPx > 0 && chromeBudget.workspaceRowGapCount > 0,
    "the graph tool bar and workspace row gaps must be declared, not assumed away",
  );
});

test("inspector rail stays width-capped so extra horizontal space goes to the canvas", () => {
  const inspectorOpen = ruleBodyFor('\\.workspace-grid\\[data-inspector-open="true"\\]', css);
  assert.ok(inspectorOpen, "inspector-open workspace rule must exist");
  const clamp = /clamp\(\s*(\d+)px\s*,\s*[^,]+,\s*(\d+)px\s*\)/iu.exec(inspectorOpen);
  assert.ok(clamp, "inspector column must use a clamped width so it cannot grow unbounded on wide displays");
  const [, minWidth, maxWidth] = clamp.map(Number);
  assert.ok(maxWidth > minWidth, "inspector clamp upper bound must exceed its lower bound");
  for (const profile of config.profiles.filter((entry) => entry.role === "regression-baseline")) {
    assert.ok(
      profile.widthPx - maxWidth >= 900,
      `${profile.label}: canvas must retain at least 900px after the inspector rail`,
    );
  }
});

test("an explicit stage-rail expansion costs the canvas exactly the rail's own height and nothing more", () => {
  // The budget-driven default keeps the full canvas floor, but an explicit user
  // expansion below the threshold pins the rail open for the rest of the session
  // and the canvas pays for it. Left unbounded that is a floor with no contract:
  // any future band could be charged to the same state. Derive the concession
  // from the rail's own declared delta, exactly as the replay drawer does, so it
  // cannot be tuned downward until a failing profile passes.
  const { chromeBudget } = config;
  const railCost = chromeBudget.stageOverviewHeightPx.open - chromeBudget.stageOverviewHeightPx.collapsed;
  assert.equal(
    stageRailExpandedCanvasFloorPx(chromeBudget),
    chromeBudget.minCanvasHeightPx - railCost,
    "expanding the stage rail may cost the canvas the rail's own height and nothing more",
  );

  const expanded = config.profiles
    .filter((entry) => entry.expectDenseLayout)
    .map((profile) => ({
      profile,
      budget: evaluateViewportChromeBudget(profile, chromeBudget, {
        replayOpen: false,
        dense: true,
        stageOverviewOpen: true,
      }),
    }));
  assert.ok(expanded.length > 0, "config must declare dense profiles for this obligation to apply to");
  for (const { profile, budget } of expanded) {
    assert.ok(
      budget.canvasHeightPx >= stageRailExpandedCanvasFloorPx(chromeBudget),
      `${profile.label}: a user-expanded rail leaves ${budget.canvasHeightPx}px, below the `
        + `${stageRailExpandedCanvasFloorPx(chromeBudget)}px concession floor`,
    );
  }
  assert.ok(
    expanded.some(({ budget }) => budget.canvasHeightPx < chromeBudget.minCanvasHeightPx),
    "at least one dense profile must fail the full canvas floor while the rail is user-expanded, otherwise the "
      + "concession is decoration and must be deleted instead of asserted",
  );
});

test("the replay drawer's open height comes from one authority in every band", () => {
  // The handheld band carried `height: 126px` against a config authority of
  // `replayPanelHeightPx.open`. Two numbers for one quantity means the budget
  // subtracts a height the stylesheet does not render. A band may either use the
  // shared property or size itself from its own declared row tracks; it may not
  // invent a second literal. Counting rules is not part of that contract: the
  // dense band once carried its own copy of the shared property, which an
  // unconditioned `[open]` rule already outranks on specificity, so a count
  // floor above two would only pin that duplicate back into place.
  const openRules = allRuleBodies(".replay-panel[open]", css);
  assert.ok(openRules.length >= 2, `stylesheet must keep its per-band replay-open rules (found ${openRules.length})`);
  let sharedPropertyUses = 0;
  let trackDerivedUses = 0;
  for (const body of openRules) {
    const height = /(?:^|;)\s*height\s*:\s*([^;]+)/iu.exec(body);
    if (!height) continue;
    const value = height[1].trim();
    if (value === "var(--h-replay-open)") {
      sharedPropertyUses += 1;
      continue;
    }
    assert.equal(
      value,
      "auto",
      `replay drawer open height must be var(--h-replay-open) or auto, found ${value}`,
    );
    const rows = /grid-template-rows\s*:\s*([^;]+)/iu.exec(body);
    assert.ok(rows, "a band that sizes the drawer from its rows must declare those rows in the same rule");
    const declared = [...rows[1].matchAll(/(\d+(?:\.\d+)?)px/gu)].reduce((sum, [, px]) => sum + Number(px), 0);
    assert.ok(
      declared > 0 && declared <= config.chromeBudget.replayPanelHeightPx.open,
      `row-derived drawer height ${declared}px must stay within the budgeted `
        + `${config.chromeBudget.replayPanelHeightPx.open}px, otherwise the budget is optimistic`,
    );
    trackDerivedUses += 1;
  }
  assert.ok(sharedPropertyUses >= 1, "the shared open-height property must stay load-bearing");
  assert.ok(trackDerivedUses >= 1, "the handheld band must derive its drawer height instead of declaring a literal");
  assert.doesNotMatch(css, /\.replay-panel\[open\][^{}]*\{[^{}]*height:\s*\d+px/iu);
});

test("the collapsed replay summary fills the panel it stands in, and only clears the dock header when open", () => {
  // `width: 116px` and `padding-left: 124px` were a pair with no owner: the
  // padding exists only to clear the absolutely positioned summary, so changing
  // one without the other silently overlaps the dock header.
  assert.match(css, /--w-replay-collapse:\s*\d+px/u, "page must emit the collapsed summary width as one authority");

  // That width is a clearance, not a label width, and it shipped as both. Measured
  // in Chrome at 1707x825 with the dock closed: the summary was 116px wide with
  // 12px of inline padding, leaving 92px for `回放` (26px) + gap (12px) +
  // `展开时间线` (65px) = 103px. Both spans flex-shrank and then wrapped inside the
  // shrunken boxes, so each reported `scrollWidth === clientWidth` while rendering
  // two lines at 33.21px - and the panel row around them was 1659.33px wide, with
  // roughly 1543px empty. English needs ~160px, so no single number fits both
  // locales. Closed, the summary is the whole control and has the whole row.
  assert.equal(
    resolvedDeclarationValue(".replay-collapse-summary", "width", css),
    "100%",
    "the closed summary must take the panel's width instead of the clearance the open dock needs",
  );
  const openSummaryRules = allRuleBodies(".replay-panel[open] .replay-collapse-summary", css);
  assert.ok(
    openSummaryRules.length >= 1,
    "the open dock must pin the summary back to the clearance width it shares with the header offset",
  );
  for (const body of openSummaryRules) {
    const width = /(?:^|;)\s*width\s*:\s*([^;]+)/iu.exec(body);
    assert.ok(width, "the open-state summary rule must declare its width");
    assert.match(
      width[1],
      /var\(--w-replay-collapse\)/u,
      `open summary width must derive from the shared property, found ${width[1].trim()}`,
    );
  }

  // Wrapping is what turned a one-line handle into two, so the labels refuse to
  // wrap. With the closed handle at full width there is nothing to wrap into, and
  // if a future layout narrows it the overflow is visible rather than silent.
  const labelRules = allRuleBodies(".replay-collapse-summary span", css);
  assert.ok(labelRules.length >= 1, "the summary labels must declare how they handle a narrow handle");
  for (const body of labelRules) {
    assert.match(
      body,
      /white-space\s*:\s*nowrap/iu,
      "a summary label that may wrap reproduces the two-line handle",
    );
  }

  const headerRules = allRuleBodies(".replay-panel[open] .replay-dock-header", css);
  assert.ok(headerRules.length >= 2, `every band that offsets the dock header must be covered (found ${headerRules.length})`);
  for (const body of headerRules) {
    const padding = /padding-left\s*:\s*([^;]+)/iu.exec(body);
    assert.ok(padding, "dock header rule must declare the offset that clears the summary");
    assert.match(
      padding[1],
      /var\(--w-replay-collapse\)/u,
      `dock header offset must derive from the summary width, found ${padding[1].trim()}`,
    );
  }
});

test("a <details> laid out as a grid or flex container opts its UA content wrapper out of layout", () => {
  // Current engines wrap a `<details>`'s non-summary children in a UA-generated
  // `::details-content` box. That box then becomes the container's only in-flow
  // item, so every child's `grid-row` / `grid-column` is inert: the replay dock
  // declared three row tracks, rendered all three children stacked in the first
  // one, collapsed the range row from 28px to 4.67px, and left the range input a
  // used height of 0 -- a native slider that cannot be pointer-hit.
  //
  // `display: contents` on the wrapper is the opt-out, and it degrades in both
  // directions: an engine without the pseudo-element drops the rule and has no
  // wrapper to remove, while an engine with it puts the real children back in the
  // grid. Declaring the container display on the wrapper instead would degrade
  // worse -- the older engine would then have no grid at all.
  const detailsClasses = detailsClassNames(html);
  assert.ok(detailsClasses.size > 0, "page must ship <details> elements for this obligation to apply to");

  const laidOutAsContainer = [...containerLayoutClassNames(css)].filter((name) => detailsClasses.has(name));
  assert.ok(
    laidOutAsContainer.length > 0,
    "at least one <details> must be a grid or flex container, otherwise this assertion is decoration and must be "
      + "deleted rather than kept green",
  );

  for (const name of laidOutAsContainer) {
    const wrapperRules = allRuleBodies(`.${name}::details-content`, css);
    assert.ok(
      wrapperRules.length > 0,
      `.${name} is a <details> laid out as a grid/flex container, so it must ship `
        + `\`.${name}::details-content { display: contents }\`; without it the UA wrapper is the only item and every `
        + "child's declared placement is inert",
    );
    assert.ok(
      wrapperRules.some((body) => /(?:^|;)\s*display\s*:\s*contents\s*(?:;|$)/iu.test(body)),
      `.${name}::details-content must be taken out of layout with \`display: contents\``,
    );
  }
});

test("the replay tick band renders inside the row that clips it", () => {
  // `.replay-ticks` was `position: absolute; bottom: -33px`, reaching out of its
  // row into the neighbouring one. A negative offset cannot escape a clipping
  // ancestor, so all nine tick labels were laid out and then thrown away. Clipping
  // one axis only is not available either: `overflow-x: hidden` with
  // `overflow-y: visible` computes the visible axis to `auto` and grows a
  // scrollbar. So the band has to sit in flow inside the row it belongs to.
  assert.equal(
    resolvedDeclarationValue(".replay-range-wrap", "overflow", css),
    "hidden",
    "the range row clips its overflow to keep the timeline inside the dock; this assertion exists because of that",
  );
  assert.equal(
    resolvedDeclarationValue(".replay-range-wrap", "display", css),
    "flex",
    "the range row lays its own children out",
  );
  assert.equal(
    resolvedDeclarationValue(".replay-range-wrap", "flex-direction", css),
    "column",
    "the progress bar and the tick band stack, so a row-direction wrap would put the labels beside the bar",
  );

  const tickRules = allRuleBodies(".replay-ticks", css);
  assert.ok(tickRules.length > 0, "stylesheet must style the tick band for this obligation to apply to");
  for (const body of tickRules) {
    const position = /(?:^|;)\s*position\s*:\s*([\w-]+)/iu.exec(body);
    if (position) {
      assert.ok(
        !["absolute", "fixed"].includes(position[1].toLowerCase()),
        `.replay-ticks must stay in flow, found position: ${position[1]}`,
      );
    }
    const escapingOffset = /(?:^|;)\s*(?:inset|top|right|bottom|left)\s*:\s*[^;]*-\s*[\d.]/iu.exec(body);
    assert.equal(
      escapingOffset,
      null,
      `.replay-ticks must not reach outside the row that clips it, found ${escapingOffset?.[0]?.trim()}`,
    );
  }
});

test("no band pins the replay drawer's row tracks to a literal that must equal the box minus its border", () => {
  // `--h-replay-open` is a border-box height and `.replay-panel` carries a
  // `border-top`, so a row-track list of fixed lengths summing to that height
  // needs one pixel more than the content box has. Measured live at 1024x768 the
  // dense band declared `43px 34px 39px` against a 115px content box and clipped:
  // `scrollHeight 116 > clientHeight 115`. Keeping those literals equal to
  // `--h-replay-open` minus the border is a second authority for one quantity --
  // the failure mode D10 and D13 exist to remove. A flexible last track resolves
  // to exactly what the box leaves, so the sum cannot drift by construction.
  const borderTop = resolvedDeclarationValue(".replay-panel", "border-top", css);
  assert.ok(borderTop, "the drawer must declare the border this assertion accounts for");
  assert.ok(
    Number(/(\d+(?:\.\d+)?)px/u.exec(borderTop)?.[1]) > 0,
    "with no border the border-box arithmetic cannot drift and this assertion is decoration, not a guard",
  );

  const trackLists = [...allRuleBodies(".replay-panel", css), ...allRuleBodies(".replay-panel[open]", css)]
    .map((body) => /(?:^|;)\s*grid-template-rows\s*:\s*([^;]+)/iu.exec(body)?.[1]?.trim())
    .filter(Boolean);
  assert.ok(trackLists.length >= 3, `every band's replay row tracks must be covered (found ${trackLists.length})`);
  for (const trackList of trackLists) {
    assert.doesNotMatch(
      trackList,
      /\d+(?:\.\d+)?px\s*$/u,
      `the last replay row track must absorb what the box leaves, found a fixed length in \`${trackList}\``,
    );
    assert.match(
      trackList,
      /(?:fr\)|\dfr|\bauto|\bmin-content|\bmax-content)\s*$/u,
      `the last replay row track must be flexible, found \`${trackList}\``,
    );
  }
});

test("the replay tick axis is derived from the run's own timeline instead of written into the markup", () => {
  // Nine literal `<span>00:00</span>` .. `<span>02:00</span>` shipped in the
  // markup behind `aria-hidden="true"`, and `renderReplay` never touched them: a
  // run spanning forty minutes still displayed a two-minute axis. That is a
  // data-truthfulness defect, not only a layout one. The layout half followed
  // from the same cause -- nine labels at 30px each need 270px against the 244px
  // the dense band affords, so the last label was clipped by 26.1px.
  const band = /<div class="replay-ticks"([^>]*)>([\s\S]*?)<\/div>/iu.exec(html);
  assert.ok(band, "page must ship the tick band element for this obligation to apply to");
  assert.equal(
    band[2].trim(),
    "",
    "the tick band must ship empty; any label written into the markup is a value the run cannot correct",
  );
  assert.match(band[1], /data-replay-ticks/u, "the client needs a hook to write the derived labels into");
  assert.doesNotMatch(
    html,
    /<span>\d{1,3}:\d{2}<\/span>/u,
    "no time-of-day or elapsed label may be a literal anywhere in the shipped page",
  );
});

test("the tick label budget is declared as data and clamps to what the band can actually show", () => {
  // The label count was fixed at nine regardless of available width. It is a
  // width budget like every other number in this module's config: declared as a
  // measured worst-case label width, resolved against the band's own measured
  // width, and clamped. `minLabelWidthPx` must be a worst case rather than a
  // typical case -- the same direction rule the chrome budget follows, because an
  // optimistic label width overflows the band exactly like an optimistic band
  // height clipped the drawer.
  const tickBand = loadLiveReplayTickBand();
  assert.ok(tickBand.minLabelWidthPx > 0, "a label needs a declared worst-case width");
  assert.ok(tickBand.minLabelCount >= 2, "an axis with fewer than two labels shows no range");
  assert.ok(
    tickBand.maxLabelCount >= tickBand.minLabelCount,
    "the label ceiling must not sit below the floor",
  );

  // The band's own measured dense width. The count must never need more room
  // than this, which is the assertion the clipped ninth label failed.
  const denseBandWidthPx = 244;
  const resolved = resolveReplayTickCount(denseBandWidthPx, tickBand);
  assert.ok(resolved >= tickBand.minLabelCount, `dense band must still show an axis, resolved ${resolved}`);
  assert.ok(
    resolved * tickBand.minLabelWidthPx <= denseBandWidthPx,
    `${resolved} labels need ${resolved * tickBand.minLabelWidthPx}px against ${denseBandWidthPx}px available`,
  );
  assert.ok(resolved <= tickBand.maxLabelCount, "the ceiling must hold");
  assert.equal(
    resolveReplayTickCount(1600, tickBand),
    tickBand.maxLabelCount,
    "a wide band is capped by the declared ceiling, not by available width",
  );

  // Degradation, not refusal: below the floor the axis is dropped rather than
  // rendered clipped, because a clipped axis is the defect being removed.
  assert.equal(
    resolveReplayTickCount(tickBand.minLabelWidthPx * tickBand.minLabelCount - 1, tickBand),
    0,
    "too narrow to seat the floor must hide the axis, not clip it",
  );
  assert.equal(resolveReplayTickCount(0, tickBand), 0);
  assert.equal(resolveReplayTickCount(Number.NaN, tickBand), 0);
});

test("tick offsets span the observed replay duration and nothing else", () => {
  // The old axis ran 00:00 to 02:00 for every run. Offsets are therefore derived
  // from the observed first and last event: the last label is the run's real
  // duration, and an unknown duration produces no axis rather than a fabricated
  // one.
  assert.deepEqual(resolveReplayTickOffsetsMs(120_000, 5), [0, 30_000, 60_000, 90_000, 120_000]);
  assert.deepEqual(resolveReplayTickOffsetsMs(2_400_000, 3), [0, 1_200_000, 2_400_000]);
  assert.deepEqual(resolveReplayTickOffsetsMs(1000, 2), [0, 1000]);
  assert.deepEqual(resolveReplayTickOffsetsMs(120_000, 0), [], "no axis means no offsets");
  assert.deepEqual(resolveReplayTickOffsetsMs(120_000, 1), [], "one label cannot express a range");
  assert.deepEqual(resolveReplayTickOffsetsMs(Number.NaN, 5), [], "an unknown duration must not be fabricated");
  assert.deepEqual(resolveReplayTickOffsetsMs(-1, 5), []);
});

test("the shipped page runs the tick-band arithmetic the tests exercise", () => {
  // Same discipline as the camera resolvers: the browser gets the resolver's own
  // source and the budget as data, so a second copy of the arithmetic cannot
  // drift away from the copy under test.
  const tickBand = loadLiveReplayTickBand();
  assert.ok(
    html.includes(JSON.stringify(serializeReplayTickBandForClient(tickBand))),
    "the page must hand the declared tick budget to its client script as data",
  );
  assert.ok(
    html.includes(serializeReplayTickCountResolver()),
    "the client must run the same tick-count resolver, inlined by its own source",
  );
  assert.ok(
    html.includes(serializeReplayTickOffsetsResolver()),
    "the client must run the same tick-offset resolver, inlined by its own source",
  );
});
