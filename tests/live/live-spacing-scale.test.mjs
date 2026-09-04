import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_SPACING_SCALE_SCHEMA_VERSION,
  REQUIRED_SPACING_STEPS,
  adjacentSpacingSeparations,
  boxSeparationFloorStep,
  loadLiveSpacingScale,
  normalizeLiveSpacingScale,
  resolveSpacingStepPixels,
  spacingCustomProperties,
  textAdjacentFloorStep,
} from "../../src/application/live/live-spacing-scale.mjs";
import { loadLiveTypographyScale } from "../../src/application/live/live-typography-scale.mjs";
import { renderLiveControlRoomPage } from "../../src/presentation/live/live-control-room-page.mjs";

/**
 * Spacing values a rule is allowed to write as a literal. `0` is a reset rather
 * than a distance - collapsing a gap on purpose is not a decision the ladder
 * should mediate, and forcing it through a token would need a zero step whose
 * only role is to defeat the ladder's own floor. Negative values are optical
 * corrections that pull a box back over its neighbour, which is the opposite of
 * what a spacing step means.
 */
const SPACING_LITERAL_ALLOW_LIST = Object.freeze(["0", "auto"]);

/**
 * Rules whose spacing is not a layout decision. `.sr-only` is the standard
 * visually-hidden recipe, where the 1px box and its negative margin exist to
 * keep the element in the accessibility tree without painting it; snapping those
 * onto a ladder would break the recipe rather than tidy it.
 */
const SPACING_RULE_EXEMPTIONS = Object.freeze([".sr-only"]);

const SPACING_PROPERTY = /\b(padding|margin|gap|row-gap|column-gap|(?:padding|margin)-(?:block|inline|top|right|bottom|left))\s*:\s*([^;}]+)/gu;

function stylesheetOf(html) {
  const opening = html.indexOf("<style>");
  const closing = html.indexOf("</style>");
  assert.ok(opening >= 0 && closing > opening, "the page must inline exactly one stylesheet");
  return html.slice(opening + "<style>".length, closing);
}

function rootRuleOf(css) {
  const start = css.indexOf(":root {");
  assert.ok(start >= 0, "the stylesheet must open with a :root token block");
  const end = css.indexOf("}", start);
  return css.slice(start, end + 1);
}

/** Every spacing declaration in the shipped stylesheet, with its rule selector. */
function spacingDeclarations(css) {
  const declarations = [];
  for (const rule of css.matchAll(/([^{}\n]+)\{([^}]*)\}/gu)) {
    const selector = rule[1].trim().replace(/\s+/gu, " ");
    for (const match of rule[2].matchAll(SPACING_PROPERTY)) {
      declarations.push({ selector, property: match[1], value: match[2].trim() });
    }
  }
  return declarations;
}

/**
 * Split a shorthand into its components without cutting a nested function call
 * in half. Depth tracking rather than a lookahead, because a value like
 * `calc(var(--w-replay-collapse) + var(--sp-cozy))` closes an inner paren before
 * the space that a lookahead would take for a component boundary.
 */
function componentsOf(value) {
  const components = [];
  let depth = 0;
  let current = "";
  for (const character of value.replace(/!important/gu, "").trim()) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (/\s/u.test(character) && depth === 0) {
      if (current !== "") components.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current !== "") components.push(current);
  return components;
}

/**
 * Custom properties the stylesheet defines for itself, mapped to every value it
 * gives them. Several distances are set once per viewport band and consumed by a
 * handful of rules, which is real indirection rather than a literal in disguise -
 * but only if every definition bottoms out on the ladder. Resolving one level
 * checks that, where an allow-list would only assume it.
 */
function localSpacingIndirection(css) {
  const definitions = new Map();
  for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/gu)) {
    const property = match[1];
    if (property.startsWith("--sp-")) continue;
    if (!definitions.has(property)) definitions.set(property, []);
    definitions.get(property).push(match[2].trim());
  }
  return definitions;
}

function resolvesToLadder(component, indirection) {
  const reference = component.match(/^var\((--[a-z0-9-]+)(?:\s*,[^)]*)?\)$/u);
  if (!reference) return false;
  if (reference[1].startsWith("--sp-")) return true;
  const definitions = indirection.get(reference[1]);
  if (!definitions || definitions.length === 0) return false;
  return definitions.every((definition) =>
    componentsOf(definition).every(
      (part) => SPACING_LITERAL_ALLOW_LIST.includes(part) || part.startsWith("var(--sp-"),
    ),
  );
}

/**
 * Every rule that sizes its own text and pads its own box, with the leading
 * families it declares and the padding steps that land under the floor. A rule
 * that does both is text-adjacent by construction - whatever it pads is the
 * distance between that text and the edge around it - but whether that distance
 * is a container gap or the body of a control depends on the text wrapping, which
 * is what the leading family records.
 */
function textPaddingRules(css, spacing, typography) {
  const stepByProperty = new Map(spacing.steps.map((step) => [step.customProperty, step]));
  const familyByProperty = new Map(
    typography.leading.families.map((family) => [family.customProperty, family.name]),
  );
  const rules = [];
  for (const rule of css.matchAll(/([^{}\n]+)\{([^}]*)\}/gu)) {
    const body = rule[2];
    if (!typography.steps.some((step) => body.includes(`var(${step.customProperty})`))) continue;
    const below = [];
    for (const match of body.matchAll(SPACING_PROPERTY)) {
      if (!match[1].startsWith("padding")) continue;
      for (const component of componentsOf(match[2])) {
        const token = component.match(/^var\((--sp-[a-z0-9-]+)\)$/u);
        const step = token ? stepByProperty.get(token[1]) : undefined;
        if (step && step.pixels < spacing.textAdjacency.minimumPx) {
          below.push(`${match[1]}: ${match[2]} -> ${step.name} is ${step.pixels}px`);
        }
      }
    }
    rules.push({
      selector: rule[1].trim().replace(/\s+/gu, " "),
      families: [...familyByProperty]
        .filter(([property]) => body.includes(`var(${property})`))
        .map(([, name]) => name),
      below,
    });
  }
  return rules;
}

test("the shipped ladder is strictly increasing and lands on its own grid", () => {
  const scale = loadLiveSpacingScale();

  assert.equal(scale.schemaVersion, LIVE_SPACING_SCALE_SCHEMA_VERSION);
  assert.deepEqual(
    scale.steps.map((step) => step.name),
    [...REQUIRED_SPACING_STEPS],
    "the ladder must define exactly the steps the renderer consumes, in order",
  );

  const resolved = resolveSpacingStepPixels(scale);
  for (const [index, step] of resolved.entries()) {
    assert.ok(step.pixels > 0, `${step.name} must be a real distance`);
    assert.equal(
      step.pixels % scale.grid.stepPx,
      0,
      `${step.name} resolves to ${step.pixels}px, off the ${scale.grid.stepPx}px grid`,
    );
    if (index > 0) {
      assert.ok(
        step.pixels > resolved[index - 1].pixels,
        `${step.name} must exceed ${resolved[index - 1].name}`,
      );
    }
  }
});

test("adjacent steps are far enough apart to read as a different grouping level", () => {
  const scale = loadLiveSpacingScale();
  const separations = adjacentSpacingSeparations(scale);

  assert.equal(separations.length, scale.steps.length - 1);
  for (const { from, to, ratio, deltaPx } of separations) {
    assert.ok(
      ratio >= scale.hierarchy.minimumAdjacentRatio,
      `${from} -> ${to} steps by only ${ratio.toFixed(3)}x, under the ${scale.hierarchy.minimumAdjacentRatio}x minimum`,
    );
    assert.ok(
      deltaPx >= scale.hierarchy.minimumAdjacentDeltaPx,
      `${from} -> ${to} differs by only ${deltaPx}px, under the ${scale.hierarchy.minimumAdjacentDeltaPx}px minimum`,
    );
  }
});

test("a ladder whose steps land a hair apart is rejected", () => {
  const shipped = loadLiveSpacingScale();
  const document = documentOf(shipped);

  // 24px and 25px both ship in the current stylesheet. They are a 1.04x step,
  // which no reader resolves as two grouping levels - it only guarantees that
  // two boxes meant to align never quite do.
  const collapsed = {
    ...document,
    grid: { ...document.grid, stepPx: 1 },
    steps: document.steps.map((step) => (step.name === "section" ? { ...step, length: "1.5625rem" } : step)),
  };
  assert.throws(
    () => normalizeLiveSpacingScale(collapsed),
    (error) => error.code === "LIVE_SPACING_SCALE_INDISTINCT",
    "a 1.04x step between two named levels must be rejected",
  );

  assert.throws(
    () => normalizeLiveSpacingScale({
      ...document,
      steps: document.steps.map((step) => (step.name === "snug" ? { ...step, length: "0.3125rem" } : step)),
    }),
    (error) => error.code === "LIVE_SPACING_SCALE_OFF_GRID",
    "a step that lands between grid lines must be rejected",
  );

  assert.throws(
    () => normalizeLiveSpacingScale({ ...document, steps: document.steps.slice(1) }),
    (error) => error.code === "LIVE_SPACING_SCALE_MISSING_STEP",
    "a ladder missing a step the renderer consumes must be rejected",
  );
});

test("the text-adjacency floor is one of the ladder's own steps", () => {
  const scale = loadLiveSpacingScale();
  const floor = textAdjacentFloorStep(scale);

  assert.ok(floor, "the document must name which step text-adjacent spacing bottoms out at");
  assert.equal(
    floor.pixels,
    scale.textAdjacency.minimumPx,
    "the floor must land exactly on a step, or every rule that respects it drifts off the ladder",
  );

  // A floor no step reaches is a floor nothing can satisfy without writing a
  // literal, which is how a ladder ends up with a parallel set of hand-tuned
  // values living beside it.
  assert.throws(
    () => normalizeLiveSpacingScale({
      ...documentOf(scale),
      textAdjacency: { ...scale.textAdjacency, minimumPx: scale.textAdjacency.minimumPx + 1 },
    }),
    (error) => error.code === "LIVE_SPACING_TEXT_ADJACENT_UNREACHABLE",
    "a floor between two steps must be rejected",
  );
});

test("the page publishes every spacing token and references no undefined one", () => {
  const scale = loadLiveSpacingScale();
  const css = stylesheetOf(renderLiveControlRoomPage());
  const root = rootRuleOf(css);

  for (const [property, value] of spacingCustomProperties(scale)) {
    assert.ok(root.includes(`${property}: ${value};`), `:root must publish ${property}: ${value}`);
  }

  const published = new Set(scale.steps.map((step) => step.customProperty));
  const dangling = [
    ...new Set(
      [...css.matchAll(/var\((--sp-[a-z0-9-]+)\)/gu)]
        .map((match) => match[1])
        .filter((property) => !published.has(property)),
    ),
  ];
  assert.deepEqual(dangling, [], `the stylesheet references spacing tokens nobody defines: ${dangling.join(", ")}`);
});

test("no rule writes its own spacing distance", () => {
  const scale = loadLiveSpacingScale();
  const css = stylesheetOf(renderLiveControlRoomPage());
  const root = rootRuleOf(css);
  const body = css.slice(root.length);
  const indirection = localSpacingIndirection(body);

  const offenders = [];
  for (const declaration of spacingDeclarations(body)) {
    if (SPACING_RULE_EXEMPTIONS.some((exempt) => declaration.selector.includes(exempt))) continue;
    for (const component of componentsOf(declaration.value)) {
      if (SPACING_LITERAL_ALLOW_LIST.includes(component)) continue;
      if (resolvesToLadder(component, indirection)) continue;
      if (/^(?:calc|clamp|min|max)\(/u.test(component)) continue;
      offenders.push(`${declaration.selector} { ${declaration.property}: ${declaration.value} }`);
      break;
    }
  }

  // 322 static spacing components spread over 52 distinct values, with sixteen
  // of them inside the 4.48px-8.8px window, is not a design anyone chose - it is
  // what happens when every rule decides its own distance and nothing compares
  // them. The ladder only helps if a rule cannot opt out of it.
  assert.deepEqual(
    offenders,
    [],
    `these ${offenders.length} declarations bypass the spacing ladder:\n${offenders.join("\n")}`,
  );
  assert.ok(scale.steps.length >= 4, "the ladder must offer enough levels to replace those 52 values");
});

test("the floor's scope names real leading families and governs something", () => {
  const spacing = loadLiveSpacingScale();
  const typography = loadLiveTypographyScale();
  const known = new Set(typography.leading.families.map((family) => family.name));

  const unknown = spacing.textAdjacency.appliesToLeadingFamilies.filter((name) => !known.has(name));
  assert.deepEqual(
    unknown,
    [],
    `the floor claims to govern leading families the type document does not define: ${unknown.join(", ")}`
      + " - a misspelled family silently empties the scope instead of failing",
  );

  const governed = textPaddingRules(stylesheetOf(renderLiveControlRoomPage()), spacing, typography)
    .filter((rule) => rule.families.some((name) => spacing.textAdjacency.appliesToLeadingFamilies.includes(name)));
  assert.ok(
    governed.length > 0,
    "no shipped rule falls inside the floor's scope, so the floor cannot fail and proves nothing",
  );
});

test("text never sits closer to its container edge than the declared floor", () => {
  const spacing = loadLiveSpacingScale();
  const typography = loadLiveTypographyScale();
  const floor = spacing.textAdjacency.minimumPx;
  const scope = spacing.textAdjacency.appliesToLeadingFamilies;

  const tooClose = [];
  const unstated = [];
  for (const rule of textPaddingRules(stylesheetOf(renderLiveControlRoomPage()), spacing, typography)) {
    if (rule.below.length === 0) continue;
    // A padded box means one of two things and the leading family is where the
    // stylesheet already says which: around wrapped prose the padding is the gap
    // to the container, and around a single-line label the padding is the control
    // itself. A rule that declares neither has not made that call, and defaulting
    // it either way hides a decision.
    if (rule.families.length === 0) {
      unstated.push(`${rule.selector} { ${rule.below.join("; ")} }`);
      continue;
    }
    if (!rule.families.some((name) => scope.includes(name))) continue;
    tooClose.push(`${rule.selector} [${rule.families.join(",")}] { ${rule.below.join("; ")} }`);
  }

  assert.deepEqual(
    unstated,
    [],
    "these rules pad their own text below the floor without declaring how that text wraps; "
      + `declare a leading family - ${scope.join("/")} to accept the ${floor}px floor, or a single-line `
      + `family to claim the exemption:\n${unstated.join("\n")}`,
  );
  assert.deepEqual(
    tooClose,
    [],
    `these rules wrap or display text and still pad it below the ${floor}px floor:\n${tooClose.join("\n")}`,
  );
});

const GAP_PROPERTY = /\b(gap|row-gap|column-gap)\s*:\s*([^;}]+)/gu;

/**
 * Every gap in the stylesheet that lands under a floor, with the leading families
 * declared by the rules nested inside it.
 *
 * The padding sweep above cannot reach these. It only considers a rule that sizes
 * its own text, which is the right scope for padding and the wrong scope for a
 * gap: the distance between a label and the value under it is declared by their
 * container, and a container declares no font size. `.context-fact` spent
 * `var(--sp-hairline)` there - 2px, from a step whose own role reads "never a
 * distance between two text runs" - and the shipped page measured 0.00px between
 * the bottom of one value and the top of the next label, with this file green.
 *
 * Which floor applies is read off the nested rules rather than a selector list:
 * a container whose children declare a wrapping leading family is separating text
 * and owes the text floor, and a container whose children are single-line controls
 * owes only the general separation floor.
 */
function gapRules(css, spacing, typography) {
  const stepByProperty = new Map(spacing.steps.map((step) => [step.customProperty, step]));
  const familyByProperty = new Map(
    typography.leading.families.map((family) => [family.customProperty, family.name]),
  );
  const parsed = [];
  for (const rule of css.matchAll(/([^{}\n]+)\{([^}]*)\}/gu)) {
    parsed.push({
      selectors: rule[1].trim().replace(/\s+/gu, " ").split(",").map((part) => part.trim()),
      body: rule[2],
    });
  }
  const rules = [];
  for (const { selectors, body } of parsed) {
    const declarations = [];
    for (const match of body.matchAll(GAP_PROPERTY)) {
      for (const component of componentsOf(match[2])) {
        if (SPACING_LITERAL_ALLOW_LIST.includes(component)) continue;
        const token = component.match(/^var\((--sp-[a-z0-9-]+)\)$/u);
        const step = token ? stepByProperty.get(token[1]) : undefined;
        if (step) declarations.push({ text: `${match[1]}: ${match[2]}`, step });
      }
    }
    if (declarations.length === 0) continue;
    // A nested rule is one whose selector starts with this one and then descends,
    // which is the only relationship a stylesheet states without a DOM. `>` and a
    // bare space are both descents; a suffix like `.context-fact.is-open` is the
    // same box, so it does not count as a child.
    const families = new Set();
    for (const selector of selectors) {
      for (const candidate of parsed) {
        for (const nested of candidate.selectors) {
          if (!nested.startsWith(selector) || nested === selector) continue;
          if (!/^[\s>]/u.test(nested.slice(selector.length))) continue;
          for (const [property, name] of familyByProperty) {
            if (candidate.body.includes(`var(${property})`)) families.add(name);
          }
        }
      }
    }
    rules.push({ selector: selectors.join(", "), declarations, families: [...families] });
  }
  return rules;
}

test("no gap in the stylesheet sits under the separation floor", () => {
  const spacing = loadLiveSpacingScale();
  const typography = loadLiveTypographyScale();
  const boxFloor = spacing.boxSeparation.minimumPx;
  const textFloor = spacing.textAdjacency.minimumPx;
  const scope = spacing.textAdjacency.appliesToLeadingFamilies;

  assert.ok(
    boxSeparationFloorStep(spacing),
    "the separation floor must be a named step, or a rule that respects it has to write a literal",
  );

  const underBox = [];
  const underText = [];
  for (const rule of gapRules(stylesheetOf(renderLiveControlRoomPage()), spacing, typography)) {
    const separatesText = rule.families.some((name) => scope.includes(name));
    const applicable = separatesText ? textFloor : boxFloor;
    for (const { text, step } of rule.declarations) {
      if (step.pixels >= applicable) continue;
      const entry = `${rule.selector} { ${text} } -> ${step.name} is ${step.pixels}px`;
      if (separatesText) underText.push(`${entry} [wraps: ${rule.families.join(",")}]`);
      else underBox.push(entry);
    }
  }

  assert.deepEqual(
    underText,
    [],
    `these containers separate two runs of wrapping text with less than the ${textFloor}px text floor, `
      + `which is the "chrome butting into text" the floor was written for:\n${underText.join("\n")}`,
  );
  assert.deepEqual(
    underBox,
    [],
    `these gaps fall under the ${boxFloor}px separation floor, where a gap reads as a rendering `
      + `artifact rather than a grouping level:\n${underBox.join("\n")}`,
  );
});

test("the separation floor governs something and cannot outrank the text floor", () => {
  const spacing = loadLiveSpacingScale();
  const typography = loadLiveTypographyScale();

  const rules = gapRules(stylesheetOf(renderLiveControlRoomPage()), spacing, typography);
  assert.ok(rules.length > 0, "no shipped rule declares a laddered gap, so this floor proves nothing");
  assert.ok(
    rules.some((rule) => rule.families.length > 0),
    "no gap-declaring rule has a nested rule with a leading family, so the text/box split is never exercised",
  );

  // The mutation has to land on a real step, or the reachability check fires
  // first and this assertion would pass for the wrong reason.
  const above = spacing.steps.find((step) => step.pixels > spacing.textAdjacency.minimumPx);
  assert.ok(above, "the ladder must offer a step above the text floor for this case to mean anything");
  assert.throws(
    () => normalizeLiveSpacingScale({
      ...documentOf(spacing),
      boxSeparation: { ...spacing.boxSeparation, minimumPx: above.pixels },
    }),
    (error) => error.code === "LIVE_SPACING_BOX_SEPARATION_ABOVE_TEXT_FLOOR",
    "a separation floor above the text floor must be rejected rather than silently overruling it",
  );
});

/** The shipped scale as a raw document, for negative cases that mutate one field. */
function documentOf(scale) {
  return {
    schemaVersion: scale.schemaVersion,
    grid: { ...scale.grid },
    hierarchy: { ...scale.hierarchy },
    textAdjacency: {
      ...scale.textAdjacency,
      appliesToLeadingFamilies: [...scale.textAdjacency.appliesToLeadingFamilies],
    },
    boxSeparation: { ...scale.boxSeparation },
    stepPropertyPrefix: scale.stepPropertyPrefix,
    steps: scale.steps.map((step) => ({ name: step.name, length: step.length, role: step.role })),
  };
}
