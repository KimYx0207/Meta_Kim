import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_TYPOGRAPHY_LEADING_FAMILIES,
  LIVE_TYPOGRAPHY_SCALE_SCHEMA_VERSION,
  REQUIRED_TYPOGRAPHY_STEPS,
  adjacentStepSeparations,
  loadLiveTypographyScale,
  normalizeLiveTypographyScale,
  resolveTypographyBasePx,
  resolveTypographyStepPixels,
  serializeTypographyCustomProperties,
  smallestRenderedPixels,
  typographyCustomProperties,
} from "../../src/application/live/live-typography-scale.mjs";
import { loadLiveGraphCameraPolicy } from "../../src/application/live/live-graph-camera.mjs";
import { renderLiveControlRoomPage } from "../../src/presentation/live/live-control-room-page.mjs";

/**
 * The shipped stylesheet may keep a numeric size only where the declaration
 * sizes a glyph box rather than a text level. `.stage-step-icon` is the single
 * such case: it is a fixed 1.55rem track whose child is an inline SVG with its
 * own width and height, so the value controls the fallback glyph metric and
 * never participates in the reading hierarchy.
 */
const NUMERIC_FONT_ALLOW_LIST = Object.freeze(["400 1.35rem/1 monospace"]);

/**
 * Font sizes the camera owns instead of the ladder. Cell mode counter-scales the
 * node title so its *on-screen* size stays at the camera's declared floor, which
 * makes its declared value a world-space size the ladder cannot express: the same
 * declaration renders 39px at scale 0.28 and 26px at 0.42 to hold 11px on screen.
 *
 * Every entry is listed by name rather than pattern-matched, and its definition is
 * separately asserted to keep a ladder step as one branch, so this is one named
 * exception with the ladder still in the chain -- not a hole a new hardcode can
 * slip through by naming itself `--something-fs`.
 */
const CAMERA_OWNED_FONT_SIZES = Object.freeze(["--cell-title-fs"]);

function stylesheetOf(html) {
  const start = html.indexOf("<style>");
  const end = html.indexOf("</style>", start);
  assert.ok(start >= 0 && end > start, "rendered page must contain a stylesheet");
  return html.slice(start + "<style>".length, end);
}

function rootRuleOf(css) {
  const match = css.match(/:root \{[^}]*\}/u);
  assert.ok(match, "stylesheet must declare a :root rule");
  return match[0];
}

/**
 * Round-trip the shipped document back into raw form so a rejection case can
 * mutate exactly one field. Building the literal by hand drifts every time the
 * schema gains a required block, and a builder that silently omits a new block
 * turns a rejection test into a test of the omission.
 */
function shippedDocument(scale) {
  return {
    schemaVersion: scale.schemaVersion,
    base: { ...scale.base },
    legibility: { ...scale.legibility },
    hierarchy: { ...scale.hierarchy },
    stepPropertyPrefix: scale.stepPropertyPrefix,
    steps: scale.steps.map((step) => ({ name: step.name, ratio: step.ratio, role: step.role })),
    leading: {
      customPropertyPrefix: scale.leading.customPropertyPrefix,
      minimumRatio: scale.leading.minimumRatio,
      rationale: scale.leading.rationale,
      families: scale.leading.families.map((family) => ({
        name: family.name,
        ratio: family.ratio,
        role: family.role,
      })),
    },
  };
}

/**
 * Resolution is the application layer's job, not the test's. A second copy of
 * the clamp arithmetic here could agree with itself while disagreeing with the
 * stylesheet the browser actually renders.
 */
function resolveBasePx(scale, viewportWidth) {
  return resolveTypographyBasePx(scale, viewportWidth);
}

/**
 * The largest on-screen size a camera-owned font size can reach, in CSS pixels.
 *
 * These sizes are `max(<ladder step>, floor / camera scale)`, so the reader sees
 * whichever branch is bigger, and the on-screen size is the one that belongs in
 * the map below: every other entry is a world-space size at camera scale 1, and a
 * cell title never coexists with scale 1. The ladder branch is largest at the top
 * of cell mode, which is `semanticZoomCellMaxScale`, and the floor is the other
 * end of the same range.
 *
 * Modelled as the maximum rather than as the floor because the only consumer asks
 * which selector renders biggest. Pinning the floor was safe only while the cell
 * boundary was small enough to keep the ladder branch under it; once the boundary
 * rose to the scale a full card is legible at, the floor understates this size by
 * about a third and the ceiling guard stops seeing it grow.
 *
 * The step name is read out of the shipped definition rather than named here, so
 * the two cannot drift apart.
 */
function cameraOwnedOnScreenMaxPx(css, property, basePx, ratioOf, camera) {
  const definition = css.match(new RegExp(`${property}:\\s*([^;}]+)`, "u"));
  assert.ok(definition, `${property} is applied as a font-size but never defined`);
  const step = definition[1].match(/var\(--fs-([a-z-]+)\)/u);
  assert.ok(
    step && ratioOf.has(step[1]),
    `${property} must keep a ladder step as one branch of its own definition`,
  );
  return Math.max(
    basePx * ratioOf.get(step[1]) * camera.semanticZoomCellMaxScale,
    camera.minOnScreenTextPx,
  );
}

/**
 * Every selector that declares a `font-size`, paired with the largest size that
 * declaration resolves to. A bare value is kept as its literal pixel size so a
 * reintroduced hardcode is measured rather than skipped.
 *
 * One declaration is not on the ladder at all. The cell-mode node title is sized
 * `max(var(--fs-entity-body), calc(var(--min-onscreen-text-px) / var(--camera-scale)))`,
 * which is a world-space size that varies with the camera so that its *on-screen*
 * size never falls under the floor. On-screen pixels are the only pixels a reader
 * has, so that is what this map records for it -- see
 * `cameraOwnedOnScreenMaxPx` for which end of its range is the right one.
 */
function appliedTextSizes(css, scale, viewportWidth) {
  const base = resolveBasePx(scale, viewportWidth);
  const remPx = scale.legibility.rootFontSizePx;
  const ratioOf = new Map(scale.steps.map((step) => [step.name, step.ratio]));
  const camera = loadLiveGraphCameraPolicy();
  const cameraOwnedPx = new Map(CAMERA_OWNED_FONT_SIZES.map((property) => [
    property,
    cameraOwnedOnScreenMaxPx(css, property, base, ratioOf, camera),
  ]));
  const applied = new Map();
  for (const rule of css.matchAll(/([^{}\n]+)\{([^}]*)\}/gu)) {
    const selectors = rule[1].split(",").map((part) => part.trim()).filter((part) => !part.startsWith("@"));
    for (const declaration of rule[2].split(";")) {
      const size = declaration.match(/^\s*font-size:\s*(.+)$/u);
      if (!size) continue;
      const value = size[1].trim();
      const cameraOwned = value.match(/var\((--[a-z-]+)\)/u);
      const token = value.match(/var\(--fs-([a-z-]+)\)/u);
      let pixels;
      if (cameraOwned && cameraOwnedPx.has(cameraOwned[1])) {
        pixels = cameraOwnedPx.get(cameraOwned[1]);
      } else if (token && ratioOf.has(token[1])) {
        pixels = base * ratioOf.get(token[1]);
      } else {
        pixels = value.endsWith("rem") ? Number.parseFloat(value) * remPx : Number.parseFloat(value);
      }
      assert.ok(Number.isFinite(pixels), `font-size ${value} must resolve to a pixel size`);
      for (const selector of selectors) {
        const current = applied.get(selector);
        if (!current || current.pixels < pixels) applied.set(selector, { pixels, value });
      }
    }
  }
  return { base, heroPx: base * ratioOf.get("hero"), applied };
}

test("the shipped scale document is a strictly increasing ladder", () => {
  const scale = loadLiveTypographyScale();

  assert.equal(scale.schemaVersion, LIVE_TYPOGRAPHY_SCALE_SCHEMA_VERSION);
  assert.ok(scale.steps.length >= REQUIRED_TYPOGRAPHY_STEPS.length);

  const ratios = scale.steps.map((step) => step.ratio);
  for (let index = 1; index < ratios.length; index += 1) {
    assert.ok(
      ratios[index] > ratios[index - 1],
      `steps[${index}] ratio ${ratios[index]} must exceed ${ratios[index - 1]}`,
    );
  }

  // A monotonic list is only useful if it is also complete: a missing tier would
  // leave the renderer pointing at an undefined custom property.
  for (const name of REQUIRED_TYPOGRAPHY_STEPS) {
    assert.ok(
      scale.steps.some((step) => step.name === name),
      `scale must define the "${name}" step`,
    );
  }

  // The ladder has to span a usable range. A set of near-identical ratios would
  // satisfy monotonicity while reproducing the flat hierarchy it replaces.
  const smallest = ratios[0];
  const largest = ratios[ratios.length - 1];
  assert.ok(largest / smallest >= 2, "largest tier must be at least twice the smallest");

  const entityTitle = scale.steps.find((step) => step.name === "entity-title");
  const entityBody = scale.steps.find((step) => step.name === "entity-body");
  assert.ok(
    entityTitle.ratio / entityBody.ratio >= 1.35,
    "an entity title must be clearly larger than its own description text",
  );

  const hero = scale.steps.find((step) => step.name === "hero");
  const micro = scale.steps.find((step) => step.name === "micro");
  assert.ok(hero.ratio === largest, "the run identity line must be the largest tier");
  assert.ok(micro.ratio === smallest, "placeholder copy must sit on the smallest tier");
});

test("a non-monotonic or incomplete document is rejected", () => {
  const shipped = loadLiveTypographyScale();
  const baseDocument = shippedDocument(shipped);

  assert.doesNotThrow(() => normalizeLiveTypographyScale(baseDocument));

  const inverted = {
    ...baseDocument,
    steps: [...baseDocument.steps].reverse(),
  };
  assert.throws(
    () => normalizeLiveTypographyScale(inverted),
    (error) => error.code === "LIVE_TYPOGRAPHY_SCALE_NOT_MONOTONIC",
  );

  const flattened = {
    ...baseDocument,
    steps: baseDocument.steps.map((step) => ({ ...step, ratio: 1 })),
  };
  assert.throws(
    () => normalizeLiveTypographyScale(flattened),
    (error) => error.code === "LIVE_TYPOGRAPHY_SCALE_NOT_MONOTONIC",
  );

  const truncated = {
    ...baseDocument,
    steps: baseDocument.steps.filter((step) => step.name !== "hero"),
  };
  assert.throws(
    () => normalizeLiveTypographyScale(truncated),
    (error) => error.code === "LIVE_TYPOGRAPHY_SCALE_MISSING_STEP",
  );

  const duplicated = {
    ...baseDocument,
    steps: [...baseDocument.steps, { name: "body", ratio: 99, role: "duplicate" }],
  };
  assert.throws(
    () => normalizeLiveTypographyScale(duplicated),
    (error) => error.code === "LIVE_TYPOGRAPHY_SCALE_DUPLICATE_STEP",
  );

  const unsafeProperty = {
    ...baseDocument,
    stepPropertyPrefix: "--fs-; } body { display: none",
  };
  assert.throws(
    () => normalizeLiveTypographyScale(unsafeProperty),
    (error) => error.code === "LIVE_TYPOGRAPHY_SCALE_UNSAFE_PROPERTY",
  );

  assert.throws(
    () => normalizeLiveTypographyScale({ ...baseDocument, schemaVersion: "v0" }),
    (error) => error.code === "LIVE_TYPOGRAPHY_SCALE_SCHEMA_MISMATCH",
  );
});

test("every tier resolves from one fluid base so the order cannot invert at any width", () => {
  const scale = loadLiveTypographyScale();
  const properties = typographyCustomProperties(scale);

  assert.deepEqual(properties[0], [
    "--fs-base",
    `clamp(${scale.base.min}, ${scale.base.preferred}, ${scale.base.max})`,
  ]);

  // Each step must be a multiple of the same base. A step carrying its own
  // literal could cross another step at some viewport width. Leading rides along
  // in the same emission but is a unitless ratio rather than a length, so the two
  // families are partitioned by prefix instead of checked with one pattern.
  const stepProperties = properties.slice(1, 1 + scale.steps.length);
  const leadingProperties = properties.slice(1 + scale.steps.length);

  for (const [property, value] of stepProperties) {
    assert.match(property, /^--fs-[a-z-]+$/u);
    assert.match(value, /^calc\(var\(--fs-base\) \* [0-9.]+\)$/u);
  }

  // A leading ratio must stay unitless: a length here would stop scaling with
  // the step it is applied to, which is the whole point of a ratio.
  assert.equal(leadingProperties.length, scale.leading.families.length);
  for (const [property, value] of leadingProperties) {
    assert.match(property, /^--lh-[a-z-]+$/u);
    assert.match(value, /^[0-9.]+$/u);
  }

  const serialized = serializeTypographyCustomProperties(scale);
  for (const [property, value] of properties) {
    assert.ok(serialized.includes(`${property}: ${value};`), `${property} must be serialized`);
  }
});

test("the rendered page emits the ladder and no level-affecting hardcoded sizes", () => {
  const scale = loadLiveTypographyScale();
  const css = stylesheetOf(renderLiveControlRoomPage());
  const root = rootRuleOf(css);

  for (const [property, value] of typographyCustomProperties(scale)) {
    assert.ok(root.includes(`${property}: ${value};`), `:root must declare ${property}`);
  }

  // Nothing may fall through to the 16px user-agent default. That fallback is
  // what made empty-state copy render larger than the primary run metric.
  assert.match(css, /(^|[;}\s])body \{[^}]*font-size:\s*var\(--fs-body\)/u);

  const bareSizes = [];
  const sizeRule = /font-size:\s*([^;}]+)/gu;
  let sizeMatch = sizeRule.exec(css);
  while (sizeMatch) {
    const value = sizeMatch[1].trim();
    const cameraOwned = CAMERA_OWNED_FONT_SIZES.some((property) => value === `var(${property})`);
    if (!value.includes("var(--fs-") && !cameraOwned) bareSizes.push(value);
    sizeMatch = sizeRule.exec(css);
  }
  assert.deepEqual(bareSizes, [], "every font-size must resolve through a scale token");

  // A camera-owned size is an exception to the ladder token, not to the ladder. Each
  // one has to keep a real step as one branch of its own definition, otherwise
  // allow-listing the name would let any number reach the reader through it.
  for (const property of CAMERA_OWNED_FONT_SIZES) {
    const definition = css.match(new RegExp(`${property}:\\s*([^;}]+)`, "u"));
    assert.ok(definition, `${property} is applied as a font-size but never defined`);
    assert.match(
      definition[1],
      /var\(--fs-[a-z-]+\)/u,
      `${property} must keep a ladder step as one branch of its own definition`,
    );
  }

  const numericShorthands = [];
  const shorthandRule = /(?:^|[;{\s])font:\s*([^;}]+)/gu;
  let shorthandMatch = shorthandRule.exec(css);
  while (shorthandMatch) {
    const value = shorthandMatch[1].trim();
    if (/[0-9]/u.test(value)) numericShorthands.push(value);
    shorthandMatch = shorthandRule.exec(css);
  }
  assert.deepEqual(
    numericShorthands,
    [...NUMERIC_FONT_ALLOW_LIST],
    "a numeric font shorthand is only allowed for the justified glyph box",
  );

  // The allow-listed declaration must still be the glyph box it claims to be.
  assert.match(css, /\.stage-step-icon\s*\{(?:(?!\})[\s\S])*font:\s*400 1\.35rem\/1 monospace/u);
  assert.match(css, /\.stage-step-icon\s*\{(?:(?!\})[\s\S])*flex:\s*0 0 1\.55rem/u);
  assert.match(css, /\.stage-step-icon svg\s*\{(?:(?!\})[\s\S])*width:\s*1\.55rem;\s*height:\s*1\.55rem/u);
});

test("semantic tiers land on the elements whose hierarchy was inverted", () => {
  const css = stylesheetOf(renderLiveControlRoomPage());

  const expectations = [
    // The top tier belongs to the run's identity line, not to its counters. It used
    // to size `.context-fact strong`, one selector matching six elements, which put
    // six numbers at the largest size on screen while the run title beside them was
    // clamped to one line and ellipsised at a smaller tier.
    [/\.run-context-title\s*\{(?:(?!\})[\s\S])*font-size:\s*var\(--fs-hero\)/u, "run identity line"],
    [/\.node-title\s*\{(?:(?!\})[\s\S])*font-size:\s*var\(--fs-entity-title\)/u, "node title"],
    [/\.node-summary\s*\{(?:(?!\})[\s\S])*font-size:\s*var\(--fs-entity-body\)/u, "node summary"],
    [/\.stage-step-name\s*\{(?:(?!\})[\s\S])*font-size:\s*var\(--fs-body\)/u, "stage step name"],
    [/\.empty-state\s*\{(?:(?!\})[\s\S])*font-size:\s*var\(--fs-micro\)/u, "empty state"],
    // The graph empty state carries three reason sentences, not a chip label, so it
    // sits a tier above the short prose empty states.
    [/\.graph-empty\s*\{(?:(?!\})[\s\S])*font-size:\s*var\(--fs-label\)/u, "graph empty state"],
    [/\.graph-canvas-title\s*\{(?:(?!\})[\s\S])*font-size:\s*var\(--fs-view-title\)/u, "canvas title"],
  ];
  for (const [pattern, label] of expectations) {
    assert.match(css, pattern, `${label} must use its semantic tier`);
  }
});

test("the resolved ladder keeps its order at the target viewport widths", () => {
  const scale = loadLiveTypographyScale();

  for (const viewportWidth of [1280, 2048, 2560, 3840]) {
    const base = resolveBasePx(scale, viewportWidth);
    const resolved = scale.steps.map((step) => base * step.ratio);
    for (let index = 1; index < resolved.length; index += 1) {
      assert.ok(
        resolved[index] > resolved[index - 1],
        `at ${viewportWidth}px, ${scale.steps[index].name} must render larger than ${scale.steps[index - 1].name}`,
      );
    }
    const placeholder = resolved[scale.steps.findIndex((step) => step.name === "micro")];
    const hero = resolved[scale.steps.findIndex((step) => step.name === "hero")];
    assert.ok(hero > placeholder, `at ${viewportWidth}px, the run identity line must outrank placeholder copy`);
  }
});

test("no tier renders below the declared legibility floor at any viewport width", () => {
  const scale = loadLiveTypographyScale();
  const { rootFontSizePx, minimumRenderedPixels } = scale.legibility;

  // A floor is only a floor if it is set where text stops being readable. The
  // previous ladder was perfectly ordered and still rendered 7.81px prose,
  // because ordering says nothing about absolute size.
  assert.ok(minimumRenderedPixels >= 11, "the smallest rendered text must stay at 11px or above");
  assert.equal(rootFontSizePx, 16, "the floor is claimed against the standard root size");

  // `clamp(min, preferred, max)` can never resolve below `min`, so the smallest
  // possible rendered size is a property of the document alone. Checking it
  // needs no viewport list, and cannot be dodged by choosing kind widths.
  const worstCase = smallestRenderedPixels(scale);
  assert.ok(
    worstCase >= minimumRenderedPixels,
    `the smallest tier bottoms out at ${worstCase.toFixed(2)}px against a ${minimumRenderedPixels}px floor`,
  );

  // The same claim measured the long way, at widths the control room is actually
  // regression-tested against, including one below the dense-layout gate.
  for (const viewportWidth of [390, 901, 1024, 1440, 1693, 2048, 2560, 3840]) {
    for (const { name, pixels } of resolveTypographyStepPixels(scale, viewportWidth)) {
      assert.ok(
        pixels >= minimumRenderedPixels,
        `at ${viewportWidth}px, ${name} renders ${pixels.toFixed(2)}px below the ${minimumRenderedPixels}px floor`,
      );
    }
  }
});

test("a ladder that resolves below its own legibility floor is rejected", () => {
  const shipped = loadLiveTypographyScale();
  const baseDocument = shippedDocument(shipped);

  assert.doesNotThrow(() => normalizeLiveTypographyScale(baseDocument));

  // Dropping the base floor is how the illegible ladder was authored: every
  // ratio stayed ordered while the whole ladder sank.
  assert.throws(
    () => normalizeLiveTypographyScale({ ...baseDocument, base: { ...baseDocument.base, min: "0.8rem" } }),
    (error) => error.code === "LIVE_TYPOGRAPHY_SCALE_ILLEGIBLE",
  );

  // Widening the ladder downward is the other way in, and it must fail the same
  // way rather than only failing the monotonicity check it happens to satisfy.
  assert.throws(
    () =>
      normalizeLiveTypographyScale({
        ...baseDocument,
        steps: baseDocument.steps.map((step) => (step.name === "micro" ? { ...step, ratio: 0.3 } : step)),
      }),
    (error) => error.code === "LIVE_TYPOGRAPHY_SCALE_ILLEGIBLE",
  );

  assert.throws(
    () => normalizeLiveTypographyScale({ ...baseDocument, legibility: undefined }),
    (error) => error.code === "LIVE_TYPOGRAPHY_SCALE_INVALID",
  );

  // An inverted clamp would make `min` unreachable and the floor claim unsound.
  assert.throws(
    () => normalizeLiveTypographyScale({ ...baseDocument, base: { ...baseDocument.base, max: "0.5rem" } }),
    (error) => error.code === "LIVE_TYPOGRAPHY_SCALE_INVALID_RANGE",
  );
});

test("no element outranks the run identity line at the measured viewports", () => {
  const scale = loadLiveTypographyScale();
  const css = stylesheetOf(renderLiveControlRoomPage());

  // The reported inversion was a ratio, not a tier list: at 1693x818 the biggest
  // rendered size was 16px on empty-state and header copy while the top tier
  // resolved to 10.876px, so biggest/top measured 1.471. Asserting tier names
  // cannot catch that, because a tier can be correct and still be the largest
  // thing on screen. This measures the ratio the report was written against.
  for (const viewportWidth of [1693, 2048, 2560]) {
    const { heroPx, applied } = appliedTextSizes(css, scale, viewportWidth);

    // The denominator has to be unambiguous, so exactly one selector may carry the
    // top tier. Note that this counts SELECTORS, not elements: the tier used to sit
    // on `.context-fact strong`, which satisfied this assertion as a single entry
    // while the band rendered six of them, so six counters were simultaneously the
    // largest text on screen with this test green. `.run-context-title` is one
    // element as well as one selector, which is what makes the ratio below mean
    // something.
    const heroSelectors = [...applied]
      .filter(([, size]) => size.value === "var(--fs-hero)")
      .map(([selector]) => selector);
    assert.deepEqual(heroSelectors, [".run-context-title"]);

    const contenders = [...applied].filter(([, size]) => size.value !== "var(--fs-hero)");
    const biggest = contenders.reduce((best, entry) => (entry[1].pixels > best[1].pixels ? entry : best));
    const ratio = biggest[1].pixels / heroPx;
    assert.ok(
      ratio < 1,
      `at ${viewportWidth}px, ${biggest[0]} renders ${biggest[1].pixels.toFixed(2)}px against a ${heroPx.toFixed(2)}px top tier (ratio ${ratio.toFixed(4)})`,
    );
  }
});

test("adjacent tiers are separated enough to read as different levels", () => {
  const scale = loadLiveTypographyScale();
  const { minimumAdjacentRatio, minimumAdjacentDeltaPx } = scale.hierarchy;

  // Monotonicity was the wrong quantity to guard alone. A ladder whose ratios
  // increase by 0.79 -> 0.83 -> 0.87 -> 0.93 satisfies strict ordering perfectly
  // and still resolved 54% of on-screen text to one size, with 64% inside a
  // 1.17px band and adjacent deltas of 0.88px and 1.02px. The order was right
  // and the hierarchy was still invisible, which is the same failure shape as a
  // budget that stays green because it never counted the omitted rows.
  const separations = adjacentStepSeparations(scale);
  assert.equal(separations.length, scale.steps.length - 1);

  for (const { from, to, ratio, deltaPx } of separations) {
    // Two constraints, because one of them is blind at each end of the ladder.
    // A pixel delta alone lets the large end drift together (28px vs 29.5px is
    // 1.5px and indistinguishable); a ratio alone lets the small end collapse
    // (11px vs 11.8px is 7% and indistinguishable). Both ends are load-bearing.
    assert.ok(
      ratio >= minimumAdjacentRatio,
      `${from} -> ${to} steps by ${ratio.toFixed(4)}x, under the ${minimumAdjacentRatio}x minimum`,
    );
    assert.ok(
      deltaPx >= minimumAdjacentDeltaPx,
      `${from} -> ${to} steps by ${deltaPx.toFixed(2)}px at the ladder floor, under the ${minimumAdjacentDeltaPx}px minimum`,
    );
  }

  // The floor is the worst case for both quantities: the delta between adjacent
  // steps is base x (ratio_next - ratio_current), which grows with the base, so
  // a ladder that separates at `base.min` separates at every viewport width.
  // Verified the long way rather than asserted, so the claim is not just a
  // restatement of the arithmetic the module already performed.
  for (const viewportWidth of [390, 901, 1024, 1440, 2560]) {
    const pixels = resolveTypographyStepPixels(scale, viewportWidth);
    for (let index = 1; index < pixels.length; index += 1) {
      const delta = pixels[index].pixels - pixels[index - 1].pixels;
      assert.ok(
        delta >= minimumAdjacentDeltaPx,
        `at ${viewportWidth}px, ${pixels[index - 1].name} -> ${pixels[index].name} steps by only ${delta.toFixed(2)}px`,
      );
    }
  }
});

test("a ladder that collapses into one perceived level is rejected", () => {
  const shipped = loadLiveTypographyScale();
  const baseDocument = shippedDocument(shipped);

  assert.doesNotThrow(() => normalizeLiveTypographyScale(baseDocument));

  // The exact shape of the defect: still strictly increasing, still above the
  // legibility floor, and still one visual level. Nothing but a separation
  // constraint rejects this document.
  const collapsed = baseDocument.steps.map((step, index) =>
    index < 4 ? { ...step, ratio: Number((0.9 + index * 0.025).toFixed(3)) } : step,
  );
  assert.throws(
    () => normalizeLiveTypographyScale({ ...baseDocument, steps: collapsed }),
    (error) => error.code === "LIVE_TYPOGRAPHY_SCALE_INDISTINCT",
  );

  // The large end fails through the ratio constraint rather than the pixel one,
  // so both halves of the guard need their own rejection case.
  const crowdedTop = baseDocument.steps.map((step, index) =>
    index === baseDocument.steps.length - 1
      ? { ...step, ratio: Number((baseDocument.steps[index - 1].ratio + 0.08).toFixed(3)) }
      : step,
  );
  assert.throws(
    () => normalizeLiveTypographyScale({ ...baseDocument, steps: crowdedTop }),
    (error) => error.code === "LIVE_TYPOGRAPHY_SCALE_INDISTINCT",
  );

  assert.throws(
    () => normalizeLiveTypographyScale({ ...baseDocument, hierarchy: undefined }),
    (error) => error.code === "LIVE_TYPOGRAPHY_SCALE_INVALID",
  );
});

test("every leading family leaves the glyph box some room", () => {
  const scale = loadLiveTypographyScale();
  const { minimumRatio, families } = scale.leading;

  // `line-height: 1` makes the line box equal to the glyph em box, so the text
  // touches whatever is stacked against it no matter how much padding the
  // container carries. 19 of the stylesheet's 55 line-height declarations were
  // exactly 1, and the two largest text populations measured a line box equal to
  // their font size to the pixel. That is the mechanical cause of text butting
  // into adjacent chrome, and it is a property of the leading document, not of
  // any one component.
  assert.ok(minimumRatio > 1, "a leading floor of 1 or less permits a zero-leading line box");

  const declared = families.map((family) => family.name);
  assert.deepEqual(
    [...declared].sort(),
    [...LIVE_TYPOGRAPHY_LEADING_FAMILIES].sort(),
    "the leading document must define exactly the families the stylesheet consumes",
  );

  for (const family of families) {
    assert.ok(
      family.ratio >= minimumRatio,
      `leading family ${family.name} is ${family.ratio}, under the ${minimumRatio} floor`,
    );
    assert.match(family.customProperty, /^--lh-[a-z0-9-]+$/u);
    assert.ok(family.role.trim().length > 0, `leading family ${family.name} must say what it is for`);
  }

  // Families are separated by wrapping behaviour, not by type step, because the
  // same step serves both a single-line uppercase monospace label and a wrapped
  // caption and those need different leading. A step name cannot know which.
  const ratios = families.map((family) => family.ratio);
  assert.equal(new Set(ratios).size, ratios.length, "two families with the same ratio are one family");
});

test("a leading document that permits a zero-leading line box is rejected", () => {
  const shipped = loadLiveTypographyScale();
  const baseDocument = shippedDocument(shipped);

  assert.throws(
    () =>
      normalizeLiveTypographyScale({
        ...baseDocument,
        leading: { ...baseDocument.leading, minimumRatio: 1 },
      }),
    (error) => error.code === "LIVE_TYPOGRAPHY_LEADING_TOO_TIGHT",
  );

  assert.throws(
    () =>
      normalizeLiveTypographyScale({
        ...baseDocument,
        leading: {
          ...baseDocument.leading,
          families: baseDocument.leading.families.map((family) =>
            family.name === "flat" ? { ...family, ratio: 1 } : family,
          ),
        },
      }),
    (error) => error.code === "LIVE_TYPOGRAPHY_LEADING_TOO_TIGHT",
  );

  assert.throws(
    () => normalizeLiveTypographyScale({ ...baseDocument, leading: undefined }),
    (error) => error.code === "LIVE_TYPOGRAPHY_SCALE_INVALID",
  );
});

test("the stylesheet takes its leading from the document instead of per-rule literals", () => {
  const scale = loadLiveTypographyScale();
  const css = stylesheetOf(renderLiveControlRoomPage());
  const root = rootRuleOf(css);

  for (const family of scale.leading.families) {
    assert.ok(
      root.includes(`${family.customProperty}: ${family.ratio};`),
      `:root must publish ${family.customProperty}`,
    );
  }

  // Every remaining numeric line-height is a component re-deciding leading on
  // its own, which is how 12 different values ended up spread over 55 sites with
  // no reviewable relationship between them.
  const offenders = [...css.slice(root.length).matchAll(/line-height:\s*([^;}]+)/gu)]
    .map((match) => match[1].trim())
    .filter((value) => !value.startsWith("var(--lh-"));
  assert.deepEqual(offenders, [], `these line-height declarations bypass the leading document: ${offenders.join(", ")}`);
});

test("every type token the stylesheet references is one the document actually publishes", () => {
  const scale = loadLiveTypographyScale();
  const css = stylesheetOf(renderLiveControlRoomPage());
  const root = rootRuleOf(css);

  const published = new Set([
    scale.base.customProperty,
    ...scale.steps.map((step) => step.customProperty),
    ...scale.leading.families.map((family) => family.customProperty),
  ]);

  // A reference to a token the document dropped is not a CSS error the browser
  // reports: the declaration becomes invalid-at-computed-value-time and silently
  // falls back to `unset`, so the element inherits a size or leading nobody
  // chose. Renaming a step is the normal way to create one - dropping `meta`
  // from the ladder left six live `var(--fs-meta)` references behind, and the
  // only reason that surfaced was an unrelated ranking assertion happening to
  // resolve the same property.
  const dangling = [
    ...new Set(
      [...css.matchAll(/var\((--(?:fs|lh)-[a-z0-9-]+)\)/gu)]
        .map((match) => match[1])
        .filter((property) => !published.has(property)),
    ),
  ];
  assert.deepEqual(
    dangling,
    [],
    `the stylesheet references type tokens the scale document does not define: ${dangling.join(", ")}`,
  );

  const prefixes = [scale.stepPropertyPrefix, scale.leading.customPropertyPrefix];
  const definedInRoot = [...root.matchAll(/(--[a-z0-9-]+):/gu)]
    .map((match) => match[1])
    .filter((property) => prefixes.some((prefix) => property.startsWith(prefix)));
  assert.deepEqual(
    [...definedInRoot].sort(),
    [...published].sort(),
    ":root must publish exactly the tokens the document declares, with no extra hand-written type token",
  );
});

