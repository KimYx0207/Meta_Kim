import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { shortenIdentifier } from "../../src/application/live/live-display-format.mjs";
import {
  compareSelectionRows,
  pickDefaultRow,
  sessionSelectionRow,
} from "../../src/application/live/live-default-selection.mjs";
import {
  loadLiveGraphLayoutPolicy,
  resolveFanoutArrangement,
  resolveNodeCardHeight,
  serializeGraphLayoutPolicyForClient,
} from "../../src/application/live/live-graph-layout.mjs";
import { LIVE_RECORD_ORIGINS } from "../../src/application/live/live-record-origin.mjs";
import { loadLiveSpacingScale } from "../../src/application/live/live-spacing-scale.mjs";
import {
  loadLiveTypographyScale,
  resolveTypographyBasePx,
} from "../../src/application/live/live-typography-scale.mjs";
import {
  LIVE_VIEWPORT_PROFILES_CONFIG_URL,
  loadLiveChromeBudget,
} from "../../src/application/live/live-viewport-budget.mjs";
import {
  LIVE_SNAPSHOT_SCHEMA_VERSION,
  renderLiveControlRoomPage,
} from "../../src/presentation/live/live-control-room-page.mjs";

function modalBehaviorHarness() {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const modalStart = html.indexOf("  function modalBackgroundElements()");
  const modalEnd = html.indexOf("\n  function updateMinimap()", modalStart);
  const keydownStart = html.indexOf('  app.addEventListener("keydown", (event) => {', modalEnd);
  const keydownEnd = html.indexOf("\n  replayPlay?.addEventListener", keydownStart);
  assert.ok(modalStart >= 0 && modalEnd > modalStart, "modal controller must remain in the shipped client script");
  assert.ok(keydownStart >= 0 && keydownEnd > keydownStart, "modal keyboard binding must remain in the shipped client script");

  const document = {
    activeElement: null,
    skipLink: null,
    querySelector(selector) {
      return selector === ".skip-link" ? this.skipLink : null;
    },
  };
  class FakeElement {
    constructor(name, { dialog = false } = {}) {
      this.name = name;
      this.dialog = dialog;
      this.hidden = false;
      this.inert = false;
      this.children = [];
      this.focusables = [];
      this.attributes = new Map();
      this.focusCount = 0;
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }

    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    removeAttribute(name) {
      this.attributes.delete(name);
    }

    matches(selector) {
      return selector === "[data-live-dialog]" && this.dialog;
    }

    querySelector() {
      return this.focusables[0] || null;
    }

    querySelectorAll() {
      return this.focusables;
    }

    contains(element) {
      return element === this || this.focusables.includes(element);
    }

    focus() {
      this.focusCount += 1;
      document.activeElement = this;
    }

    blur() {
      if (document.activeElement === this) document.activeElement = null;
    }
  }

  const app = new FakeElement("app");
  const skipLink = new FakeElement("skip-link");
  const background = new FakeElement("background");
  const preservedBackground = new FakeElement("preserved-background");
  preservedBackground.inert = true;
  preservedBackground.setAttribute("aria-hidden", "legacy");
  const sessionsDialog = new FakeElement("sessions", { dialog: true });
  const helpDialog = new FakeElement("help", { dialog: true });
  const infoDialog = new FakeElement("info", { dialog: true });
  const first = new FakeElement("first");
  const last = new FakeElement("last");
  sessionsDialog.focusables = [first, last];
  sessionsDialog.setAttribute("aria-hidden", "true");
  sessionsDialog.hidden = true;
  helpDialog.setAttribute("aria-hidden", "true");
  helpDialog.hidden = true;
  infoDialog.setAttribute("aria-hidden", "true");
  infoDialog.hidden = true;
  app.children = [background, preservedBackground, sessionsDialog, helpDialog, infoDialog];
  document.skipLink = skipLink;
  app.addEventListener = (type, handler) => {
    if (type === "keydown") app.keydownHandler = handler;
  };

  const modalSource = html.slice(modalStart, modalEnd);
  const keydownSource = html.slice(keydownStart, keydownEnd);
  const createController = new Function(
    "document",
    "app",
    "sessionsDialog",
    "helpDialog",
    "infoDialog",
    "HTMLInputElement",
    "HTMLSelectElement",
    "HTMLTextAreaElement",
    `${String.raw`
      let dialogOpener = null;
      let activeDialog = null;
      const modalBackgroundState = new Map();
      const FOCUSABLE_DIALOG_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
      let selectedNodeId = null;
      const updateSelectedNodeVisuals = () => {};
      const setInspectorOpen = () => {};
      ${modalSource}
      ${keydownSource}
      return {
        setDialogOpen,
        trapDialogFocus,
        keydownHandler: () => app.keydownHandler,
        activeDialog: () => activeDialog,
      };
    `}`,
  );
  const controller = createController(
    document,
    app,
    sessionsDialog,
    helpDialog,
    infoDialog,
    class FakeInput extends FakeElement {},
    class FakeSelect extends FakeElement {},
    class FakeTextArea extends FakeElement {},
  );
  return {
    controller,
    document,
    skipLink,
    background,
    preservedBackground,
    sessionsDialog,
    first,
    last,
    FakeElement,
  };
}

/**
 * Evaluates the shipped graph-tools controller against fake geometry. String
 * assertions can prove the code is present; only running it can prove that a
 * point outside the canvas is pulled back inside it and that a corrupted stored
 * point degrades to the docked default instead of throwing during startup.
 */
/**
 * Occlusion regressions in this page have twice come from two rules with equal
 * specificity in the same media condition, where the later one silently undid an
 * avoidance value set by the earlier one. Matching rule text in isolation cannot
 * see that, so these helpers walk the shipped stylesheet and resolve the value a
 * browser would actually apply.
 */
function stylesheetRules(html) {
  const open = html.indexOf("<style>");
  const close = html.indexOf("</style>", open);
  assert.ok(open >= 0 && close > open, "rendered page must ship one inline stylesheet");
  const sheet = html.slice(open + "<style>".length, close).replace(/\/\*[\s\S]*?\*\//gu, "");

  const rules = [];
  const conditions = [];
  let prelude = "";
  for (let cursor = 0; cursor < sheet.length; cursor += 1) {
    const character = sheet[cursor];
    if (character === "}") {
      conditions.pop();
      prelude = "";
      continue;
    }
    if (character !== "{") {
      prelude += character;
      continue;
    }
    const selector = prelude.trim();
    prelude = "";
    if (selector.startsWith("@")) {
      conditions.push(selector);
      continue;
    }
    const blockEnd = sheet.indexOf("}", cursor);
    rules.push({
      conditions: conditions.slice(),
      selectors: selector.split(",").map((part) => part.trim()),
      declarations: sheet
        .slice(cursor + 1, blockEnd)
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => [part.slice(0, part.indexOf(":")).trim(), part.slice(part.indexOf(":") + 1).trim()]),
    });
    cursor = blockEnd;
  }
  return rules;
}

function resolvedDeclaration(rules, { selector, property, condition = "" }) {
  const applied = rules
    .filter((rule) => rule.selectors.includes(selector))
    .filter((rule) => (condition ? rule.conditions.includes(condition) : rule.conditions.length === 0))
    .flatMap((rule) => rule.declarations.filter(([name]) => name === property).map(([, value]) => value));
  return applied.length > 0 ? applied.at(-1) : null;
}

/**
 * Character range of one `<div>` element, matched by its opening tag. Containment
 * decides what an `inset: 0` overlay can reach, and a plain "does the substring
 * appear after this tag" check cannot tell a child from a later sibling, so the
 * closing tag has to be found by walking nesting depth.
 */
function elementRange(html, openTagPattern) {
  const opening = html.match(openTagPattern);
  assert.ok(opening, `markup must contain ${openTagPattern}`);
  const start = opening.index;
  const tags = /<(\/?)div\b/gu;
  tags.lastIndex = start;
  let depth = 0;
  for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
    depth += tag[1] === "/" ? -1 : 1;
    if (depth === 0) return { start, end: tag.index };
  }
  assert.fail(`${openTagPattern} is never closed`);
  return { start, end: html.length };
}

function declaredValues(rules, { selector, property }) {
  return rules
    .filter((rule) => rule.selectors.includes(selector))
    .flatMap((rule) => rule.declarations.filter(([name]) => name === property).map(([, value]) => value));
}

/** Two declarations only shadow each other when their values match after formatting. */
function normalizedValue(value) {
  return value.replace(/\s*,\s*/gu, ",").replace(/\s+/gu, " ").trim();
}

function isImportant(value) {
  return /!\s*important$/iu.test(value.trim());
}

/** The element a state selector decorates: `.a .b:hover[data-x="1"]` -> `.b`. */
function baseSelectorOf(selector) {
  const compound = selector.trim().split(/[\s>+~]+/u).at(-1);
  const cut = [compound.indexOf(":"), compound.indexOf("[")].filter((index) => index > 0);
  return cut.length > 0 ? compound.slice(0, Math.min(...cut)) : compound;
}

/** Split a shorthand into components without breaking `var(a, b)` apart. */
function splitTopLevel(value, separator = null) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const character of value) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    const boundary = separator === null ? /\s/u.test(character) : character === separator;
    if (depth === 0 && boundary) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function inlineComponentOf(parts) {
  if (parts.length === 1) return parts[0];
  return parts.length === 4 ? parts[3] : parts[1];
}

const SPACING_STEP_PIXELS = new Map(
  loadLiveSpacingScale().steps.map((step) => [step.customProperty, step.pixels]),
);

/**
 * Pixels one length resolves to. Spacing comes off a named ladder now, so a
 * `var(--sp-*)` reference is a length a browser resolves to a number and this
 * guard can compare. Resolving it here rather than at each call site keeps one
 * place that knows how a length becomes a number: track floors, gaps, paddings
 * and accent-bar insets all funnel through this.
 */
function lengthToPixels(value) {
  const step = /^var\((--sp-[a-z0-9-]+)\)$/u.exec(value.trim());
  if (step) {
    const pixels = SPACING_STEP_PIXELS.get(step[1]);
    assert.ok(
      pixels !== undefined,
      `${value} reads a spacing step the ladder does not publish, so it resolves to nothing at all`,
    );
    return pixels;
  }
  if (/^-?0(?:[a-z%]+)?$/u.test(value)) return 0;
  if (/rem$|em$/u.test(value)) return Number.parseFloat(value) * 16;
  if (value.endsWith("px")) return Number.parseFloat(value);
  return Number.NaN;
}

/**
 * Every pixel width one inline-padding value can resolve to, as
 * `[source, pixels]` pairs. A `var()` reference is not a single number: each
 * declaration site of the custom property is a real value the element can take,
 * so a bar that clears the widest band while covering text in a narrower one
 * still has to fail.
 */
function resolveInlinePadding(rules, value) {
  const reference = /^var\((--[\w-]+)(?:,\s*([^)]+))?\)$/u.exec(value);
  if (!reference) {
    const pixels = lengthToPixels(value);
    assert.ok(Number.isFinite(pixels), `inline padding ${value} is not a length this guard can compare`);
    return [[value, pixels]];
  }

  const [, name, fallback] = reference;
  const declared = rules.flatMap((rule) =>
    rule.declarations.filter(([property]) => property === name).map(([, declaredValue]) => declaredValue),
  );
  assert.ok(
    declared.length > 0,
    `inline padding reads ${name}, which nothing in the stylesheet declares, so only the `
      + `${fallback ?? "empty"} fallback ever applies`,
  );
  return declared.map((declaredValue) => [`${name}: ${declaredValue}`, lengthToPixels(declaredValue)]);
}

/**
 * The value `:root` publishes for one custom property.
 *
 * A count shared by three rules has to be declared once or the copies drift
 * apart one edit at a time, which moves the number a guard used to read at the
 * use site behind a `var()` reference. Following the reference to its
 * declaration is the difference between checking the count and reading `NaN`,
 * and `NaN >= 2` is false, so the loose form fails loudly rather than passing.
 */
function rootCustomProperty(rules, name) {
  const declared = rules
    .filter((rule) => rule.selectors.includes(":root") && rule.conditions.length === 0)
    .flatMap((rule) => rule.declarations.filter(([property]) => property === name).map(([, value]) => value));
  assert.equal(declared.length, 1, `:root must declare ${name} exactly once, found ${declared.length}`);
  return declared[0].trim();
}

/** A line count, whether written at the use site or held in a token. */
function lineClampCount(rules, value) {
  assert.ok(value, "a wrapped run must bound how many lines it may take");
  const reference = /^var\((--[\w-]+)\)$/u.exec(value.trim());
  const count = Number(reference ? rootCustomProperty(rules, reference[1]) : value);
  assert.ok(Number.isInteger(count) && count > 0, `line clamp ${value} does not resolve to a line count`);
  return count;
}

const TYPOGRAPHY_SCALE = loadLiveTypographyScale();
const TYPOGRAPHY_STEP_RATIOS = new Map(
  TYPOGRAPHY_SCALE.steps.map((step) => [step.customProperty, step.ratio]),
);
const TYPOGRAPHY_LEADING_RATIOS = new Map(
  TYPOGRAPHY_SCALE.leading.families.map((family) => [family.customProperty, family.ratio]),
);

/**
 * The height of one line of an element's text at one viewport width.
 *
 * A tier comparison cannot be made from `font-size` alone. The status title sat
 * one ladder step *above* the legend caption and still rendered shorter, because
 * leading multiplies the step and the caption carried the looser family: a
 * 0.81x step at 1.42 leading is a taller line box than a 0.81x step at 1.28. The
 * line box is what the reader's eye measures a hierarchy against, so it is what
 * gets ordered here.
 */
function renderedLineBoxPx(rules, selector, viewportWidth) {
  const fontSize = resolvedDeclaration(rules, { selector, property: "font-size" });
  const lineHeight = resolvedDeclaration(rules, { selector, property: "line-height" });
  assert.ok(fontSize, `${selector} must declare its own step, or its tier is whatever it inherits`);
  assert.ok(lineHeight, `${selector} must declare its own leading, or its line box is whatever it inherits`);
  const step = /^var\((--fs-[a-z0-9-]+)\)$/u.exec(fontSize.trim());
  const family = /^var\((--lh-[a-z0-9-]+)\)$/u.exec(lineHeight.trim());
  assert.ok(step, `${selector} sizes with ${fontSize} instead of a ladder step`);
  assert.ok(family, `${selector} leads with ${lineHeight} instead of a leading family`);
  const ratio = TYPOGRAPHY_STEP_RATIOS.get(step[1]);
  const leading = TYPOGRAPHY_LEADING_RATIOS.get(family[1]);
  assert.ok(ratio !== undefined, `${step[1]} is not a step the ladder publishes`);
  assert.ok(leading !== undefined, `${family[1]} is not a leading family the ladder publishes`);
  return resolveTypographyBasePx(TYPOGRAPHY_SCALE, viewportWidth) * ratio * leading;
}

/**
 * Whether one at-rule condition holds at a viewport size. Unsupported features
 * (`prefers-reduced-motion`, `@supports`, comma lists) resolve to "does not
 * match": a width invariant that silently absorbed a preference band would report
 * a floor no viewport actually has.
 */
function mediaMatches(condition, viewport) {
  const query = condition.replace(/^@media\s*/u, "").trim();
  if (!condition.startsWith("@media") || query.includes(",") || /\bor\b/u.test(query)) return false;
  const features = [...query.matchAll(/\(\s*([a-z-]+)\s*:\s*([^)]+?)\s*\)/gu)];
  if (features.length === 0) return false;
  return features.every(([, feature, raw]) => {
    const pixels = lengthToPixels(raw);
    if (!Number.isFinite(pixels)) return false;
    if (feature === "min-width") return viewport.width >= pixels;
    if (feature === "max-width") return viewport.width <= pixels;
    if (feature === "min-height") return viewport.height >= pixels;
    if (feature === "max-height") return viewport.height <= pixels;
    return false;
  });
}

/**
 * The value a browser applies at one viewport size. `resolvedDeclaration` scopes
 * to a single exact condition string, which cannot answer "what wins at 901x720"
 * — and a hand-written track floor only overflows inside the band that declares
 * it, so the comparison has to resolve every matching band in document order.
 */
function resolvedForViewport(rules, { selector, property, viewport }) {
  const applied = rules
    .filter((rule) => rule.selectors.includes(selector))
    .filter((rule) => rule.conditions.every((condition) => mediaMatches(condition, viewport)))
    .flatMap((rule) => rule.declarations.filter(([name]) => name === property).map(([, value]) => value));
  return applied.length > 0 ? applied.at(-1) : null;
}

/** An sRGB triple plus alpha, from `#rgb`, `#rrggbb`, `rgb()` or `rgba()`. */
function parseCssColor(value) {
  const text = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(text);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit) : [0, 2, 4].map((at) => hex[1].slice(at, at + 2));
    return { rgb: digits.map((pair) => Number.parseInt(pair, 16)), alpha: 1 };
  }
  const functional = /^rgba?\(([^)]+)\)$/iu.exec(text);
  assert.ok(functional, `${value} is not a colour this guard can measure`);
  const parts = functional[1].split(/[,/]/u).map((part) => Number.parseFloat(part.trim()));
  assert.ok(parts.length === 3 || parts.length === 4, `${value} does not carry three or four components`);
  const [red, green, blue, alpha = 1] = parts;
  for (const component of [red, green, blue, alpha]) {
    assert.ok(Number.isFinite(component), `${value} has a component this guard cannot read as a number`);
  }
  return { rgb: [red, green, blue], alpha };
}

/**
 * WCAG relative luminance of an opaque sRGB triple.
 *
 * Written out rather than approximated by averaging channels: green carries 72% of
 * perceived lightness and blue 7%, so a channel average ranks a blue-gray ink and a
 * green-gray ink as equally visible when the eye does not.
 */
function relativeLuminance([red, green, blue]) {
  const linear = [red, green, blue].map((component) => {
    const ratio = component / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** A translucent colour laid over an opaque one, as the opaque triple it becomes. */
function compositeOver(foreground, background, alpha) {
  return foreground.map((component, index) => background[index] + (component - background[index]) * alpha);
}

/** WCAG contrast ratio between two opaque sRGB triples, always at least 1. */
function contrastRatio(one, other) {
  const [bright, dark] = [relativeLuminance(one), relativeLuminance(other)].sort((left, right) => right - left);
  return (bright + 0.05) / (dark + 0.05);
}

/**
 * Every background an edge can actually be drawn over at one viewport.
 *
 * The canvas fill is declared twice — once unconditionally and once inside the
 * desktop band — so reading the first declaration measures a colour that never
 * paints on a desktop window. On top of the fill the canvas paints a 28px grid, and
 * a dashed edge lands on a grid line for part of its length, where the local
 * backdrop is lighter than the fill. Both the fill and each grid stop are returned
 * so the ratio is checked against all of them instead of against whichever one the
 * guard's author happened to look at.
 */
function graphCanvasBackdrops(rules, viewport) {
  const fill = resolvedForViewport(rules, { selector: ".graph-canvas", property: "background-color", viewport });
  assert.ok(fill, `the canvas declares no background-color at ${viewport.width}x${viewport.height}`);
  const base = parseCssColor(fill);
  assert.equal(base.alpha, 1, `the canvas fill ${fill} is translucent, so what an edge sits on is not knowable from this sheet alone`);
  const backdrops = [[fill, base.rgb]];
  const image = resolvedForViewport(rules, { selector: ".graph-canvas", property: "background-image", viewport });
  for (const stop of image ? image.match(/rgba?\([^)]+\)/gu) ?? [] : []) {
    const overlay = parseCssColor(stop);
    if (overlay.alpha === 0) continue;
    backdrops.push([`${fill} under ${stop}`, compositeOver(overlay.rgb, base.rgb, overlay.alpha)]);
  }
  return backdrops;
}

/**
 * Selectors that paint a readable line in the edge layer, taken from the sheet
 * rather than kept as a list here: a state added later owes the same ratio, and a
 * hand-written list would not know it exists.
 *
 * `.edge-flow-*` is left out on purpose. Those are the blur-filtered glow and
 * tracer overlays drawn on top of an edge that already carries the ratio, and
 * several sit at `opacity: 0` until a run animates them. Holding a glow to a
 * reading threshold would force it to stop being a glow. The test asserts the page
 * never puts those classes on a base edge, so the exclusion is checked rather than
 * trusted.
 */
function edgeStrokeSelectors(rules) {
  const painted = [];
  for (const rule of rules) {
    if (!rule.declarations.some(([property]) => property === "stroke")) continue;
    for (const selector of rule.selectors) {
      if (/^\.edge(?:$|\[|-)/u.test(selector) && !painted.includes(selector)) painted.push(selector);
    }
  }
  const lines = painted.filter((selector) => !selector.startsWith(".edge-flow-"));
  assert.ok(
    lines.length >= 8,
    `only ${lines.length} edge selectors carry a stroke, so either the sheet lost most of its states or this filter stopped matching them`,
  );
  return lines;
}

/**
 * The ink and opacity a browser paints one edge selector with.
 *
 * Opacity falls back to `.edge` when a state does not declare its own, which is not
 * a convenience: `.edge-failed` sets only a stroke, so its ratio moves whenever the
 * base rule's opacity moves, and reading it as fully opaque would report a state
 * that is legible when it is not.
 */
function resolvedEdgePaint(rules, selector, viewport) {
  const stroke = resolvedForViewport(rules, { selector, property: "stroke", viewport });
  assert.ok(stroke, `${selector} declares no stroke at ${viewport.width}x${viewport.height}`);
  const token = /^var\((--[\w-]+)\)$/u.exec(stroke.trim());
  const ink = parseCssColor(token ? rootCustomProperty(rules, token[1]) : stroke);
  const opacity = resolvedForViewport(rules, { selector, property: "opacity", viewport })
    ?? resolvedForViewport(rules, { selector: ".edge", property: "opacity", viewport });
  assert.ok(opacity, `neither ${selector} nor .edge declares an opacity, so the painted ink is not knowable`);
  const alpha = Number.parseFloat(opacity) * ink.alpha;
  assert.ok(alpha > 0 && alpha <= 1, `${selector} resolves to alpha ${alpha}, which paints nothing a reader can follow`);
  return { source: token ? `${stroke} -> ${ink.rgb.join()}` : stroke, rgb: ink.rgb, alpha };
}

/**
 * WCAG 2.2 success criterion 1.4.11, Non-text Contrast.
 *
 * An execution edge is a graphical object a reader has to perceive to understand
 * the content — the line is the only thing saying which node feeds which — so it
 * owes 3:1 against what it is drawn on, the same as an icon or a form border.
 */
const NON_TEXT_CONTRAST_MINIMUM = 3;

function splitTrackList(value) {
  assert.ok(value, "track list must be declared");
  assert.doesNotMatch(value, /repeat\(/u, `repeat() in ${value} is not a track list this guard can count`);
  return splitTopLevel(value);
}

/** Pixels a grid track can never shrink below: `minmax(300px, 1fr)` -> 300. */
function trackFloorPx(track) {
  // The argument split has to be depth-aware: a `minmax(min(100%, 18rem), 1fr)`
  // minimum contains its own comma, and a `[^,]+?` capture stops at the first one,
  // handing this guard the fragment `min(100%` and failing on a track that is
  // perfectly legal.
  const minmax = /^minmax\((.+)\)$/u.exec(track);
  const floor = (minmax ? splitTopLevel(minmax[1], ",")[0] : track).trim();
  if (/^(?:auto|min-content|max-content|fit-content\(.+\))$/u.test(floor) || floor.endsWith("fr")) return 0;
  const comparison = /^(min|max)\((.+)\)$/u.exec(floor);
  if (comparison) return comparisonFloorPx(comparison[1], splitTopLevel(comparison[2], ","));
  const pixels = lengthToPixels(floor);
  assert.ok(Number.isFinite(pixels), `track floor ${floor} is not a length this guard can compare`);
  return pixels;
}

/**
 * The floor of a `min()` / `max()` track minimum, counting only the arguments this
 * guard can turn into a number.
 *
 * A percentage or `fr` argument is measured against the container, and the
 * container is the band itself, so such an argument can never on its own push the
 * row past the viewport - it is bounded by the very width being checked. An
 * absolute length can. So `min(100%, 18rem)` contributes 288px: that is the widest
 * the track's minimum can ever resolve to, which is the number the overflow sum
 * needs. If no argument is absolute the guard has nothing to compare and returns 0
 * rather than inventing a bound.
 */
function comparisonFloorPx(kind, args) {
  const absolute = args
    .map((arg) => lengthToPixels(arg.trim()))
    .filter((pixels) => Number.isFinite(pixels));
  if (absolute.length === 0) return 0;
  return kind === "min" ? Math.min(...absolute) : Math.max(...absolute);
}

function columnGapPx(value) {
  return lengthToPixels(inlineComponentOf(splitTopLevel(value)));
}

function horizontalPaddingPx(value) {
  const parts = splitTopLevel(value);
  const right = parts.length === 1 ? parts[0] : parts[1];
  const left = parts.length === 4 ? parts[3] : right;
  return lengthToPixels(right) + lengthToPixels(left);
}

const DENSE_BAND = "@media (min-width: 901px) and (min-height: 720px)";

function graphToolsHarness({ stored = null, canvas = { top: 40, height: 560, width: 1000 } } = {}) {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const storageStart = html.indexOf("  function safeStoredPoint(key)");
  const storageEnd = html.indexOf("\n  function setWorkView(", storageStart);
  const controllerStart = html.indexOf("  function graphToolsBounds()");
  const controllerEnd = html.indexOf("\n  function reconcileCamera(", controllerStart);
  assert.ok(storageStart >= 0 && storageEnd > storageStart, "point storage helpers must remain in the shipped script");
  assert.ok(controllerStart >= 0 && controllerEnd > controllerStart, "graph tools controller must remain in the shipped script");

  const makeStorage = (seed) => {
    const entries = new Map(seed ? [[GRAPH_TOOLS_KEY, seed]] : []);
    return {
      entries,
      getItem: (key) => (entries.has(key) ? entries.get(key) : null),
      setItem: (key, value) => entries.set(key, String(value)),
      removeItem: (key) => entries.delete(key),
    };
  };
  const window = { sessionStorage: makeStorage(stored), localStorage: makeStorage(stored) };
  const rect = (left, top, width, height) => () => ({ left, top, width, height });
  const graphStage = { getBoundingClientRect: rect(0, 0, canvas.width, canvas.top + canvas.height) };
  const graph = { getBoundingClientRect: rect(0, canvas.top, canvas.width, canvas.height) };
  const graphTools = {
    dataset: { floating: "false" },
    styleValues: new Map(),
    getBoundingClientRect: rect(0, 0, 200, 30),
    style: {
      setProperty(property, value) {
        graphTools.styleValues.set(property, value);
      },
      removeProperty(property) {
        graphTools.styleValues.delete(property);
      },
    },
  };
  const liveRegion = { textContent: "" };

  const createController = new Function(
    "window",
    "graphStage",
    "graph",
    "graphTools",
    "liveRegion",
    "GRAPH_TOOLS_STORAGE_KEY",
    `${String.raw`
      const GRAPH_TOOLS_EDGE_MARGIN = 8;
      const GRAPH_TOOLS_KEYBOARD_STEP = 12;
      const currentLanguage = "en";
      let graphToolsPosition = null;
      ${html.slice(storageStart, storageEnd)}
      ${html.slice(controllerStart, controllerEnd)}
      return {
        graphToolsBounds,
        clampGraphToolsPoint,
        moveGraphTools,
        dockGraphTools,
        reclampGraphTools,
        nudgeGraphTools,
        applyGraphToolsPosition,
        safeStoredPoint,
        restore: () => { graphToolsPosition = safeStoredPoint(GRAPH_TOOLS_STORAGE_KEY); applyGraphToolsPosition(); },
        position: () => graphToolsPosition,
      };
    `}`,
  );
  const controller = createController(window, graphStage, graph, graphTools, liveRegion, GRAPH_TOOLS_KEY);
  return { controller, window, graphTools, liveRegion };
}

const GRAPH_TOOLS_KEY = "meta-kim-live-graph-tools-position-v1";

/**
 * Slice one shipped helper out of the inlined controller. The helpers under test
 * are pure, so evaluating them directly proves the absent-value policy instead
 * of asserting that a call site merely mentions the right helper name.
 */
function shippedHelper(html, name) {
  const start = html.indexOf("  function " + name + "(");
  assert.ok(start >= 0, name + "() must remain in the shipped script");
  const end = html.indexOf("\n  function ", start + 1);
  assert.ok(end > start, name + "() must be followed by another shipped helper");
  return html.slice(start, end);
}

const SESSION_COPY_HELPERS = [
  "display",
  "firstValue",
  "nullableCount",
  "nullableCountOf",
  "usefulNodeMeta",
  "informativeValue",
  "generatedRunTitle",
  "sessionIsIdentified",
  "sessionIsSubstantive",
  "sessionRecordOrigin",
  "sessionIsGovernedRun",
  "sessionOriginCopy",
  "sessionIsForeground",
  "sessionGroups",
  "conversationLinkCopy",
  "conversationLinkCopyFor",
  "conversationChatIdentityValue",
  "conversationChatIdentityCopy",
  "sourceRuntimeLabel",
  "sessionDisplayTitle",
  "sessionStateCopy",
  "stateCopy",
  "runTaskCopy",
  "sessionRowMeta",
  "sessionTimeCopy",
];

function sessionCopyHarness({ language = "zh" } = {}) {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const displayFormat = JSON.parse(html.match(/const DISPLAY_FORMAT = (\{.*?\});\n/su)[1]);
  const originLiteral = html.match(/const RECORD_ORIGIN_TEXT = (\{.*?\});\n/su);
  assert.ok(originLiteral, "the shipped script must embed record-origin copy for the declared vocabulary");
  const originText = JSON.parse(originLiteral[1]);
  const refusalLiteral = html.match(/const CONVERSATION_REFUSAL_TEXT = (\{.*?\});\n/su);
  assert.ok(refusalLiteral, "the shipped script must embed a sentence for every recorded refusal reason");
  const refusalText = JSON.parse(refusalLiteral[1]);
  // Extracted leniently on purpose. Asserting it here would turn one missing
  // literal into a red in every test that builds copy helpers, which buries the
  // one assertion that names the defect.
  const discoveryLiteral = html.match(/const CONVERSATION_DISCOVERY_TEXT = (\{.*?\});\n/su);
  const discoveryText = discoveryLiteral ? JSON.parse(discoveryLiteral[1]) : null;
  const build = new Function(
    "DISPLAY_FORMAT",
    "RECORD_ORIGIN_TEXT",
    "CONVERSATION_REFUSAL_TEXT",
    "CONVERSATION_DISCOVERY_TEXT",
    "localize",
    "formatSessionTime",
    "currentLanguage",
    "shortenIdentifier",
    "DEFAULT_SELECTION",
    "sessionSelectionRow",
    "compareSelectionRows",
    `${SESSION_COPY_HELPERS.map((name) => shippedHelper(html, name)).join("\n")}
      return { ${SESSION_COPY_HELPERS.join(", ")} };
    `,
  );
  const selectionLiteral = html.match(/const DEFAULT_SELECTION = (\{.*?\});\n/su);
  assert.ok(selectionLiteral, "the shipped script must embed the policy its session ordering ranks with");
  const helpers = build(
    displayFormat,
    originText,
    refusalText,
    discoveryText ?? {},
    (value) => value,
    (value) => (value ? "at " + value : ""),
    language,
    // The page serializes this same export into the shipped script, so the harness
    // importing it is the one form that cannot drift from what ships.
    shortenIdentifier,
    JSON.parse(selectionLiteral[1]),
    sessionSelectionRow,
    compareSelectionRows,
  );
  return { html, displayFormat, originText, refusalText, discoveryText, ...helpers };
}

const snapshotFixture = {
  schemaVersion: LIVE_SNAPSHOT_SCHEMA_VERSION,
  source: {
    kind: "local",
    label: "Meta_Kim local observer",
    generatedAt: "2026-08-24T08:00:00.000Z",
  },
  run: {
    id: "run-demo-42",
    title: "Ship the governed execution spine",
    status: "live",
    stage: "Execution",
    startedAt: "2026-08-24T07:58:00.000Z",
    updatedAt: "2026-08-24T08:00:00.000Z",
  },
  nodes: [
    {
      id: "critical",
      label: "Critical",
      status: "completed",
      roleDisplayName: "conductor",
      agent: "meta-conductor",
      runtime: "codex",
      summary: "Intent locked",
    },
    {
      id: "execution",
      label: "Execution",
      status: "running",
      roleDisplayName: "frontend",
      agent: "frontend-developer",
      runtime: "codex",
      summary: "Rendering the control room",
    },
  ],
  edges: [{ from: "critical", to: "execution", status: "active" }],
  evidence: [{ id: "ev-1", label: "Snapshot observed", status: "verified", nodeId: "execution" }],
  replay: {
    events: [
      { id: "r-1", timestamp: "2026-08-24T07:58:00.000Z", nodeId: "critical", label: "Critical completed" },
      { id: "r-2", timestamp: "2026-08-24T07:59:00.000Z", nodeId: "execution", label: "Execution started" },
    ],
  },
  permissions: { readOnly: true, canMutate: false },
};

test("renders a complete local control-room shell with no external assets", () => {
  const html = renderLiveControlRoomPage();

  assert.match(html, /^<!doctype html>/iu);
  assert.match(html, /<html[^>]+lang="zh-CN"/iu);
  assert.match(html, /<main\b/iu);
  assert.match(html, /data-snapshot-endpoint="\/api\/snapshot"/u);
  assert.match(html, /data-events-endpoint="\/api\/events"/u);
  assert.match(html, /data-projects-endpoint="\/api\/projects"/u);
  assert.match(html, /data-replay-endpoint="\/api\/replay"/u);
  assert.match(html, /rel="icon" href="data:image\/svg\+xml;base64,/u);
  assert.doesNotMatch(html, /<(?:script|link|img)[^>]+(?:https?:)?\/\//iu);
  assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:unpkg|jsdelivr|fonts\.googleapis)/iu);
});

test("defaults to Chinese and provides a persistent English language switch", () => {
  const html = renderLiveControlRoomPage();

  assert.match(html, /<title>Meta_Kim Live · 控制中心<\/title>/u);
  assert.match(html, /data-live-language-toggle/u);
  assert.match(html, /data-i18n-en="Execution graph" data-i18n-zh="实时运行图">实时运行图/u);
  assert.match(html, /data-i18n-en="Inspector" data-i18n-zh="检查器">检查器/u);
  assert.match(html, /data-i18n-en="Replay timeline" data-i18n-zh="回放时间线">回放时间线/u);
  assert.match(html, /LANGUAGE_STORAGE_KEY\s*=\s*"meta-kim-live-language"/u);
  assert.match(html, /localStorage\?\.getItem\(LANGUAGE_STORAGE_KEY\)/u);
  assert.match(html, /localStorage\?\.setItem\(LANGUAGE_STORAGE_KEY, currentLanguage\)/u);
  assert.match(html, /currentLanguage\s*=\s*currentLanguage\s*===\s*"zh"\s*\?\s*"en"\s*:\s*"zh"/u);
  assert.match(html, /window\.location\.reload\(\)/u);
});

test("keeps snapshot values out of markup and safely seeds JSON for the text-only renderer", () => {
  const hostile = {
    ...snapshotFixture,
    run: {
      ...snapshotFixture.run,
      title: "</script><img src=x onerror=alert(1)> & <b>untrusted</b>",
    },
  };
  const html = renderLiveControlRoomPage({ snapshot: hostile });

  assert.equal((html.match(/<img\b/giu) || []).length, 1, "only the bundled brand mark may render as an image");
  assert.match(html, /<img class="brand-mark" src="\/assets\/meta-kim-k-mark\.png" alt=""/u);
  assert.doesNotMatch(html, /onerror\s*=/iu);
  assert.doesNotMatch(html, /<b>untrusted<\/b>/iu);
  assert.match(html, /live-initial-snapshot/iu);
  assert.match(html, /\\u003C\/script\\u003E/iu);
  assert.doesNotMatch(html, /\.innerHTML\b/iu);
  assert.doesNotMatch(html, /\beval\s*\(/iu);
  assert.match(html, /textContent\s*=/u);
});

test("wires read-only snapshot polling and server-sent events", () => {
  const html = renderLiveControlRoomPage();

  assert.match(html, /fetch\(endpointForSelection\(snapshotEndpoint\)/iu);
  assert.match(html, /new\s+EventSource\(endpointForSelection\(eventsEndpoint\)\)/iu);
  assert.match(html, /addEventListener\(["']snapshot["']/iu);
  assert.match(html, /addEventListener\(["']message["']/iu);
  assert.match(html, /eventSource\.close\(\)/iu);
  assert.match(html, /AbortController/iu);
  assert.doesNotMatch(html, /fetch\([^)]*method\s*:\s*["'](?:POST|PUT|PATCH|DELETE)/iu);
  assert.match(html, /Array\.isArray\(input\.replay\)/u);
  assert.match(html, /active.*live|live.*active/su);
  assert.match(html, /if \(!snapshot\.run\)/u);
});

test("includes graph, evidence drawer, and replay controls", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  for (const marker of [
    "data-live-graph",
    "data-live-edge-layer",
    "data-live-node-list",
    "data-evidence-drawer",
    "data-replay-timeline",
    "data-replay-range",
    "data-replay-play",
    "renderGraph",
    "renderEvidence",
    "renderReplay",
  ]) {
    assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), marker);
  }
  assert.match(html, /aria-controls="live-inspector"/iu);
  assert.match(html, /role="list"/iu);
  assert.match(html, /<svg\b[^>]*aria-hidden="true"/iu);
  assert.match(html, /data\.replayStatus|dataset\.replayStatus/u);
});

test("keeps event progress and the current stage in the compact status bar with a replay-backed stage rail", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /data-live-run-progress/u);
  assert.match(html, /data-live-run-workers/u);
  assert.match(html, /class="status-bar"/u);
  assert.match(html, /data-live-run-stage/u);
  assert.match(html, /data-live-stage-rail|function renderStageRail\(/u);
  assert.doesNotMatch(html, /class="[^"]*run-hero|class="[^"]*run-facts/u);
  assert.match(html, /selectedSession\.currentStage/u);
  assert.match(html, /selectedSession\.active\s*\?\s*"live"/u);
  assert.match(html, /"Event " \+ snapshot\.run\.eventIndex \+ " of " \+ snapshot\.run\.eventCount/u);
  assert.match(html, /eventCount\s*=\s*Math\.max\(replay\.length/u);
});

test("uses a canvas-first control-room hierarchy with an on-demand inspector and integrated transport", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /<header class="topbar"[\s\S]*data-live-open-sessions[\s\S]*<\/header>/u);
  assert.match(html, /class="workspace-grid"[^>]*data-inspector-open="false"[\s\S]*class="graph-panel"[\s\S]*class="replay-panel replay-dock"[\s\S]*class="status-bar"/u);
  assert.match(html, /data-live-sessions-dialog/u);
  assert.match(html, /data-live-help-dialog/u);
  assert.match(html, /data-live-info-dialog/u);
  assert.match(html, /data-live-inspector[^>]+data-open="false"/u);
  assert.match(html, /data-live-inspector-close/u);
  assert.match(html, /function setInspectorOpen\(/u);
  assert.match(html, /setInspectorOpen\(true\)/u);
  assert.match(html, /function repositionCameraAfterInspector\(active\)/u);
  assert.match(html, /requestAnimationFrame\(\(\)\s*=>\s*window\.requestAnimationFrame\(reposition\)\)/u);
  assert.match(html, /workspace\?\.addEventListener\("transitionend", reposition, \{ once: true \}\)/u);
  // The lift used to be a literal `.68`, a number with no relationship to any
  // declared bound. It is now the cell/card boundary itself: opening the
  // inspector means the reader wants to read one node, and the card rendering is
  // by definition the smallest scale at which a node is readable.
  assert.match(html, /function reconcileCamera\([\s\S]{0,700}camera\.scale < GRAPH_CAMERA\.semanticZoomCellMaxScale[\s\S]{0,220}centerGraphNode\(followTargetId\(\)\)/u);
  assert.match(html, /new ResizeObserver\(\(\)\s*=>\s*reconcileCamera\(\)\)/u);
  assert.match(html, /if \(firstSnapshot\) \{\s*setInspectorOpen\(false\)/u);
  assert.doesNotMatch(html, /setInspectorOpen\(currentWorkView === "run"[\s\S]{0,160}Boolean\(selectedNodeId\)\)/u);
  assert.match(html, /identity\.addEventListener\("click", \(\) => selectNode\(node\.id, \{ inspectorTab: "summary" \}\)\)/u);
  assert.match(html, /selectNode\(node\.id, \{ inspectorTab: record\.tab \}\)/u);
  assert.match(html, /evidenceToggle\?\.addEventListener\("click", \(\) => setInspectorOpen\(evidencePanel\?\.dataset\.open !== "true"\)\)/u);
  assert.match(html, /evidenceClose\?\.addEventListener\("click", \(\) => setInspectorOpen\(false\)\)/u);
  assert.match(html, /event\.key === "Escape"[\s\S]{0,260}setInspectorOpen\(false\)/u);
  assert.match(html, /app\.addEventListener\("pointerdown"[\s\S]{0,300}evidencePanel\.contains\(target\)[\s\S]{0,180}setInspectorOpen\(false\)/u);
  assert.match(html, /\.evidence-panel \.panel-header\s*\{[^}]*position:\s*sticky[^}]*z-index:\s*3[^}]*background:\s*var\(--panel\)/su);
  assert.match(html, /\.evidence-panel \[data-live-inspector-close\]\s*\{[^}]*width:\s*36px[^}]*height:\s*36px[^}]*place-items:\s*center/su);
  assert.match(html, /\.workspace-grid\[data-inspector-open="true"\]\s*\{[^}]*minmax\(0,\s*1fr\)[^}]*clamp\(320px,\s*26vw,\s*420px\)/su);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*\.evidence-panel\s*\{[^}]*position:\s*fixed/su);
  assert.match(html, /<img class="brand-mark" src="\/assets\/meta-kim-k-mark\.png" alt=""[^>]*>/u);
  assert.match(html, /glyph\.setAttribute\("class", "node-glyph"\)/u);
  assert.match(html, /class="root-entry-path"|rootPath\.setAttribute\("class", "root-entry-path"\)/u);
  assert.match(html, /class="replay-ticks"/u);
  assert.match(html, /stageIconPaths/u);
  assert.match(html, /class="graph-stage-bar"[\s\S]*class="graph-canvas-title"/u);
});

test("the panels that lay out the replay and status bands take their heights from the viewport budget", () => {
  const chromeBudget = loadLiveChromeBudget();
  const rules = stylesheetRules(renderLiveControlRoomPage({ snapshot: snapshotFixture }));

  // Measured at 1186x606 before this guard existed: the canvas rendered 151px
  // against the declared 360px floor, and 110px of the shortfall was space no
  // element occupied. `.graph-panel` reserved a fixed 116px for the replay row
  // while the collapsed drawer rendered 34px, and `.workspace-grid` reserved a
  // fixed 28px third row for a status bar that, outside the dense band, is a
  // child of `.graph-panel` and never occupies it. Both numbers are copies of
  // values `config/live/viewport-profiles.json` already owns, so config was one
  // of two authorities -- and the copies had already drifted, to `104px 26px` in
  // one band and `62px` in another.
  const BAND_PANELS = [".graph-panel", ".workspace-grid"];
  const tracks = rules.flatMap((rule) =>
    rule.selectors.some((selector) => BAND_PANELS.includes(selector))
      ? rule.declarations
          .filter(([property]) => property === "grid-template-rows")
          .map(([, value]) => ({ band: rule.conditions.join(" and ") || "base", selector: rule.selectors[0], value }))
      : [],
  );

  assert.ok(
    tracks.length >= 2,
    "found fewer than two band-panel row-track rules, so this guard would pass by scanning almost nothing",
  );

  for (const { band, selector, value } of tracks) {
    const rows = splitTopLevel(value);
    for (const row of rows) {
      const literal = /\d+(?:\.\d+)?px/u.exec(row);
      assert.equal(
        literal,
        null,
        `${band} ${selector} writes ${literal?.[0]} straight into its row tracks. Band heights belong to `
          + "config/live/viewport-profiles.json; read them through a custom property so there is one authority",
      );
    }
    if (rows.length > 1) {
      assert.equal(
        rows[1],
        "auto",
        `${band} ${selector} gives the replay row a fixed ${rows[1]}. A fixed track charges the canvas for a `
          + "drawer that is closed; `auto` charges what the drawer actually renders",
      );
    }
  }

  // The indirection is only worth anything if the property carries config's
  // number. Otherwise the fork just moves one level down and gets harder to see.
  for (const [property, expected] of [
    ["--h-replay-collapsed", chromeBudget.replayPanelHeightPx.collapsed],
    ["--h-replay-open", chromeBudget.replayPanelHeightPx.open],
    ["--h-status-bar", chromeBudget.statusBarHeightPx],
  ]) {
    assert.equal(
      resolvedDeclaration(rules, { selector: ":root", property }),
      `${expected}px`,
      `${property} must ship the ${expected}px that config declares`,
    );
  }

  // Two of those custom properties exist because the drawer's own height rules
  // are the same quantity config budgets for. Leaving a literal there recreates
  // the fork on the element the budget is about.
  for (const rule of rules) {
    if (!rule.selectors.some((selector) => selector.startsWith(".replay-panel"))) continue;
    for (const [property, value] of rule.declarations) {
      if (!/^(?:min-|max-)?height$/u.test(property)) continue;
      const literal = /(\d+(?:\.\d+)?)px/u.exec(value);
      if (!literal) continue;
      assert.ok(
        ![chromeBudget.replayPanelHeightPx.collapsed, chromeBudget.replayPanelHeightPx.open].includes(
          Number(literal[1]),
        ),
        `${rule.selectors.join(", ")} sets ${property}: ${value}, which is a literal copy of a replay height config `
          + "owns -- read it through --h-replay-collapsed or --h-replay-open instead",
      );
    }
  }
});

test("no band panel keeps a shadowed row-track declaration", () => {
  const rules = stylesheetRules(renderLiveControlRoomPage({ snapshot: snapshotFixture }));

  // Both drifted copies found at 1186x606 were unreachable: a later rule with the
  // identical selector in the identical media condition already replaced them, so
  // nobody editing the visible one could tell it did nothing. Same selector text
  // means same specificity, so an earlier declaration of the same property is
  // dead by construction -- worth blocking rather than re-discovering.
  const seen = new Map();
  const shadowed = [];
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      if (![".graph-panel", ".workspace-grid"].includes(selector)) continue;
      for (const [property] of rule.declarations) {
        if (!property.startsWith("grid-template-")) continue;
        const key = `${rule.conditions.join(" and ") || "base"} | ${selector} | ${property}`;
        if (seen.has(key)) shadowed.push(key);
        seen.set(key, true);
      }
    }
  }

  assert.ok(seen.size > 0, "found no band-panel track declarations at all, so this guard scanned nothing");
  assert.deepEqual(shadowed, [], "these declarations are overridden by a later identical selector in the same band");
});

test("no unconditioned rule cancels a media override of the same property", () => {
  const rules = stylesheetRules(renderLiveControlRoomPage({ snapshot: snapshotFixture }));

  // A media query adds no specificity, so document order alone settles a tie
  // between a band rule and an unconditioned rule wearing the same selector. An
  // unconditioned rule written later therefore erases the band value with no
  // marker at either edit site: the band rule still reads as if it applies. The
  // sheet grew a late override layer, so every band value declared before that
  // layer is exposed to this, not just the ones already found by hand.
  const cancelled = [];
  for (const [index, rule] of rules.entries()) {
    if (rule.conditions.length === 0) continue;
    for (const selector of rule.selectors) {
      for (const [property, value] of rule.declarations) {
        const beaten = rules.slice(index + 1).some(
          (later) =>
            later.conditions.length === 0 &&
            later.selectors.includes(selector) &&
            later.declarations.some(
              ([name, laterValue]) =>
                name === property && (isImportant(laterValue) || !isImportant(value)),
            ),
        );
        if (beaten) cancelled.push(`${rule.conditions.join(" and ")} | ${selector} | ${property}`);
      }
    }
  }

  assert.ok(
    rules.some((rule) => rule.conditions.length > 0),
    "found no media-conditioned rules at all, so this guard scanned nothing",
  );
  assert.deepEqual(cancelled, [], "an unconditioned rule later in the sheet undoes these band values");
});

test("no rule restates a value its own band already resolves to", () => {
  const rules = stylesheetRules(renderLiveControlRoomPage({ snapshot: snapshotFixture }));

  // Same selector plus same condition means same specificity, so a second
  // declaration of one property is only ever the winner. When the two values are
  // also identical the earlier one cannot change any pixel, yet it stays
  // editable: changing it looks like it should work and silently does nothing.
  // Restricting the check to identical values keeps the deliberate late
  // override layer intact while still refusing new dead copies.
  const resolved = new Map();
  const restated = [];
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      for (const [property, value] of rule.declarations) {
        const key = `${rule.conditions.join(" and ") || "base"} | ${selector} | ${property}`;
        if (resolved.get(key) === normalizedValue(value)) restated.push(`${key} = ${value}`);
        resolved.set(key, normalizedValue(value));
      }
    }
  }

  assert.ok(resolved.size > 0, "found no declarations at all, so this guard scanned nothing");
  assert.deepEqual(restated, [], "these declarations repeat a value the same band already resolves to");
});

test("keeps the graph control cluster out of the canvas and lets the operator move it", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  // The cluster used to be the first child of `.graph-canvas` with
  // `position: absolute`, so it always covered the top row of node cards. The
  // stage bar is a sibling that precedes the canvas, which makes occlusion in
  // the docked state structurally impossible rather than merely unlikely.
  assert.doesNotMatch(html, /graph-canvas-header/u);
  assert.match(html, /class="graph-stage-bar"[\s\S]{0,4000}class="graph-canvas"/u);
  assert.match(html, /\.graph-stage-bar\s*\{(?:(?!\})[\s\S])*flex:\s*0 0 auto/u);
  assert.doesNotMatch(html, /\.graph-stage-bar\s*\{(?:(?!\})[\s\S])*position:\s*absolute/u);
  assert.match(html, /\.graph-canvas-tools\[data-floating="true"\]\s*\{(?:(?!\})[\s\S])*position:\s*absolute/u);
  assert.match(html, /\.graph-canvas-tools\[data-floating="true"\]\s*\{(?:(?!\})[\s\S])*var\(--tools-x, 0px\)/u);

  // The long legend spanned the whole canvas width with `white-space: nowrap`,
  // so its tail sat on top of nodes. Living in the bar as an in-flow, wrapping
  // flex item is what keeps it off the canvas. Truncating it there was the first
  // fix and it silently deleted two of the four locked edge states at 900px and
  // 1024px — see "the edge legend keeps all four locked edge states at every
  // width" for the measured loss.
  assert.doesNotMatch(html, /\.graph-edge-legend\s*\{(?:(?!\})[\s\S])*position:\s*absolute/u);
  assert.doesNotMatch(html, /\.graph-edge-legend\s*\{(?:(?!\})[\s\S])*white-space:\s*nowrap/u);
  assert.match(html, /\.graph-stage-bar\s*\{(?:(?!\})[\s\S])*min-height:\s*40px/u);

  assert.match(html, /data-live-graph-tools-handle[^>]*aria-label="Move graph controls/u);
  // The localized instruction lives in aria-label and title, never in text
  // content — see the icon-control test for why textContent destroys the glyph.
  assert.match(html, /data-live-graph-tools-handle[^>]*title="Drag to move/u);
  assert.match(html, /\.graph-tools-handle:focus-visible\s*\{(?:(?!\})[\s\S])*outline:\s*2px solid/u);

  assert.match(html, /graphToolsHandle\?\.addEventListener\("pointerdown"/u);
  assert.match(html, /graphToolsHandle\.setPointerCapture\?\.\(event\.pointerId\)/u);
  assert.match(html, /graphToolsHandle\?\.releasePointerCapture\?\.\(graphToolsDrag\.pointerId\)/u);
  assert.match(html, /graphToolsHandle\?\.addEventListener\("pointercancel", stopGraphToolsDrag\)/u);

  // Canvas pan must not run while the cluster is being dragged, and the wheel
  // handler must not zoom the graph from inside the cluster.
  assert.match(html, /if \(graphToolsDrag\) return;/u);
  assert.match(html, /\[data-node-id\], button, \.graph-canvas-tools/u);
  assert.match(html, /\.graph-canvas-tools"\)\) return;\s*event\.preventDefault\(\);\s*setCameraMode\("manual"\)/u);

  // Clamping and re-clamping: bounds come from the canvas rect, and the existing
  // ResizeObserver path re-runs the clamp before its own early return.
  assert.match(html, /function graphToolsBounds\(\)[\s\S]{0,900}graph\.getBoundingClientRect\(\)/u);
  assert.match(html, /function clampGraphToolsPoint\(point\)[\s\S]{0,400}Math\.min\(Math\.max\(point\.x, bounds\.minX\), bounds\.maxX\)/u);
  assert.match(html, /function reconcileCamera\([^)]*\)[^{]*\{\s*reclampGraphTools\(\);/u);

  // Keyboard: arrows nudge with a step, Home docks. Escape stays global, so it
  // is deliberately not bound here.
  assert.match(html, /const GRAPH_TOOLS_KEYBOARD_STEP = \d+;/u);
  assert.match(html, /graphToolsHandle\?\.addEventListener\("keydown"[\s\S]{0,700}ArrowLeft: \[-step, 0\]/u);
  assert.match(html, /graphToolsHandle\?\.addEventListener\("keydown"[\s\S]{0,900}event\.key === "Home"[\s\S]{0,120}dockGraphTools\(\)/u);
  assert.match(html, /function nudgeGraphTools\(dx, dy\)[\s\S]{0,700}announceGraphTools\(/u);
  assert.match(html, /function announceGraphTools\(message\)\s*\{\s*if \(liveRegion\) liveRegion\.textContent = message;/u);

  // Persistence reuses the storage conventions of the work-view choice.
  assert.match(html, /const GRAPH_TOOLS_STORAGE_KEY = "meta-kim-live-graph-tools-position-v1";/u);
  assert.match(html, /graphToolsPosition = safeStoredPoint\(GRAPH_TOOLS_STORAGE_KEY\);\s*applyGraphToolsPosition\(\);/u);
  assert.match(html, /function safeStoredPoint\(key\)[\s\S]{0,900}catch \{\s*return null;/u);
  assert.match(html, /function persistStoredPoint\(key, point\)[\s\S]{0,700}window\.localStorage\?\.setItem\(key, raw\)/u);

  // Only the transition property is animated, and the reduced-motion umbrella
  // covers it because it is a stylesheet transition rather than an inline one.
  assert.match(html, /\.graph-canvas-tools\s*\{(?:(?!\})[\s\S])*transition:\s*box-shadow/u);
});

test("keeps the stage rail inside its own grid column instead of under the inspector", () => {
  const rules = stylesheetRules(renderLiveControlRoomPage({ snapshot: snapshotFixture }));

  // In the dense band the rail lives inside `.graph-stage`, which is grid column
  // 1 and `overflow: visible`. Sizing it to the full viewport made it spill into
  // column 2, where the opaque inspector is painted above it, so the last two
  // stage cells disappeared as soon as the inspector opened.
  for (const value of declaredValues(rules, { selector: ".stage-overview", property: "width" })) {
    assert.doesNotMatch(value, /100vw/u, "the stage rail must be sized by its column, not by the viewport");
  }

  // The previous avoidance was `margin-top: 88px` on the inspector, matching a
  // hardcoded rail height. The rail is `height: auto` now, so any fixed pixel
  // avoidance is decoupled from the thing it is supposed to avoid.
  assert.deepEqual(declaredValues(rules, { selector: ".evidence-panel", property: "margin-top" }), []);
  for (const value of declaredValues(rules, { selector: ".stage-overview", property: "height" })) {
    assert.doesNotMatch(value, /^\d/u, "the stage rail height must follow its content");
  }

  // The panel only covers anything once it is open, which is why a closed-default
  // measurement reports no occlusion at all.
  assert.equal(
    resolvedDeclaration(rules, { selector: '.evidence-panel[data-open="false"]', property: "visibility" }),
    "hidden",
  );

  // Column 2 outranks column 1 here, so raising the rail's z-index would only
  // trade this occlusion for another. Bounding the rail to its own column is the
  // fix, and that only holds while the stacking order stays this way.
  assert.equal(resolvedDeclaration(rules, { selector: ".graph-stage", property: "grid-column", condition: DENSE_BAND }), "1");
  assert.equal(resolvedDeclaration(rules, { selector: ".evidence-panel", property: "grid-column", condition: DENSE_BAND }), "2");
  const railLayer = Number(resolvedDeclaration(rules, { selector: ".stage-overview", property: "z-index", condition: DENSE_BAND }));
  const panelLayer = Number(resolvedDeclaration(rules, { selector: ".evidence-panel", property: "z-index", condition: DENSE_BAND }));
  assert.ok(Number.isFinite(railLayer) && Number.isFinite(panelLayer));
  assert.ok(panelLayer > railLayer, `the inspector (${panelLayer}) outranks the rail (${railLayer}), so the rail must stay in column 1`);
});

test("keeps the stage rail horizontally reachable in the base band", () => {
  const rules = stylesheetRules(renderLiveControlRoomPage({ snapshot: snapshotFixture }));

  // `.stage-rail` keeps a min-content floor outside the dense band, and
  // `.graph-stage` clips overflow, so without a scroll port the last stages are
  // unreachable rather than merely cramped. The scroll port is the body and not
  // the container, so the collapse summary stays put while the rail scrolls.
  assert.equal(resolvedDeclaration(rules, { selector: ".stage-overview-body", property: "overflow-x" }), "auto");
  assert.equal(resolvedDeclaration(rules, { selector: ".stage-rail", property: "min-width" }), "min-content");
  assert.equal(
    resolvedDeclaration(rules, { selector: ".stage-rail", property: "min-width", condition: DENSE_BAND }),
    "0",
  );

  // An unconditionally collapsed rail would hide this defect instead of fixing it,
  // so the scroll port above is only load-bearing while the rail can actually be
  // open. That claim moved: the client used to compare the window height against a
  // predicted sum of chrome bands, and it now measures the canvas the page rendered.
  // Both cases -- a viewport with room defaulting the rail open, and one without room
  // collapsing it -- are asserted by "the stage rail's default state is measured from
  // the rendered canvas", which executes the shipped decision rather than matching its
  // source. Repeating them here would give two guards one behaviour, and either could
  // then be deleted without anything going red.

  // The claim above is only true while `.graph-stage` actually clips. It flips to
  // `overflow: visible` in the dense band, so the scroll port cannot be delegated
  // to the container: the band that needs scrolling is the one that clips.
  assert.equal(resolvedDeclaration(rules, { selector: ".graph-stage", property: "overflow" }), "hidden");
  assert.equal(
    resolvedDeclaration(rules, { selector: ".graph-stage", property: "overflow", condition: DENSE_BAND }),
    "visible",
  );
});

test("reserves the minimap footprint when fitting the graph and drops the dead pan guard", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const rules = stylesheetRules(html);

  // The minimap is a bottom-right overlay, so a symmetric fit padding parked the
  // last node card underneath it. The reserve has to come from the overlay's own
  // measured box rather than from a copy of its stylesheet size.
  assert.match(html, /function graphFitInset\(\)/u);
  assert.match(html, /graphMinimap\.getBoundingClientRect\?\.\(\)/u);
  assert.doesNotMatch(html, /const padding = 26;/u);

  // The guard could never fire: the overlay is not a pointer target, so
  // `event.target` is never inside it.
  assert.equal(resolvedDeclaration(rules, { selector: ".graph-minimap", property: "pointer-events" }), "none");
  assert.doesNotMatch(html, /\.graph-minimap, \.graph-canvas-tools/u);
  assert.match(html, /\[data-node-id\], button, \.graph-canvas-tools/u);

  // `offsetParent === null` is the correct probe only because the dense band takes
  // the overlay out of layout. Hiding it by opacity or transform instead would
  // leave the probe reporting a visible overlay and the reserve would vanish.
  assert.equal(resolvedDeclaration(rules, { selector: ".graph-minimap", property: "display", condition: DENSE_BAND }), "none");
  assert.match(html, /graphMinimap\.offsetParent === null/u);

  // Only the cheaper axis gives way. Reserving both would shrink the graph twice
  // for one overlay that occupies a single corner.
  assert.match(html, /const pad = GRAPH_CAMERA\.fitPaddingPx;/u);
  assert.match(html, /if \(right \/ canvas\.width <= bottom \/ canvas\.height\)/u);
});

test("keeps the empty-state overlay off the graph toolbar", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const rules = stylesheetRules(html);

  // `inset: 0` resolves against the nearest positioned ancestor, so the overlay's
  // reach is decided by where it sits in the tree, not by how big it looks. Parked
  // in `.graph-stage` it spanned the stage bar too, and `elementFromPoint` at the
  // toolbar centre returned `div.graph-empty`: every graph control was dead
  // whenever the snapshot had no nodes. Its container must therefore hold no
  // controls, which `.graph-canvas` satisfies and `.graph-stage` does not.
  const canvas = elementRange(html, /<div class="graph-canvas"/u);
  const stage = elementRange(html, /<div class="graph-stage"/u);
  const overlay = html.indexOf("data-live-graph-empty");
  const toolbar = html.indexOf('<div class="graph-stage-bar"');
  assert.ok(overlay > 0 && toolbar > 0, "the overlay and the stage bar must both render");
  assert.ok(
    overlay > canvas.start && overlay < canvas.end,
    "the empty-state overlay must render inside .graph-canvas, whose box excludes every control",
  );
  assert.ok(
    toolbar > stage.start && (toolbar < canvas.start || toolbar > canvas.end),
    "the stage bar must stay outside .graph-canvas, otherwise the overlay's own container regains controls",
  );

  // The container fix stops the overlay covering controls; it does not stop it
  // swallowing pan and zoom on the canvas underneath. The overlay carries no
  // interactive content, so it has no reason to be a pointer target at all — the
  // minimap overlay already sets the same precedent.
  assert.equal(resolvedDeclaration(rules, { selector: ".graph-empty", property: "pointer-events" }), "none");

  // `.graph-canvas` has to keep its own positioning for `inset: 0` to mean "the
  // canvas". If it fell back to static, the overlay would resolve against
  // `.graph-stage` again and the defect would return with the markup unchanged.
  assert.equal(resolvedDeclaration(rules, { selector: ".graph-canvas", property: "position" }), "relative");
});

test("drops the work view switcher rules that no longer reach the element", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const rules = stylesheetRules(html);

  // The switcher is always nested in `<details class="work-view-menu">`, so the
  // two-class rule wins every property. Rules keyed on the bare class only look
  // like they position the element.
  assert.match(html, /<details class="work-view-menu"[\s\S]{0,400}class="work-view-switcher"/u);
  assert.deepEqual(
    rules.filter((rule) => rule.selectors.includes(".work-view-switcher")).map((rule) => rule.conditions),
    [[]],
  );
  assert.match(html, /\.work-view-menu \.work-view-switcher\s*\{(?:(?!\})[\s\S])*position:\s*absolute/u);
});

test("clamps the graph control cluster inside the canvas and survives corrupted stored positions", () => {
  const { controller, window, graphTools, liveRegion } = graphToolsHarness();

  // Stage 1000x600, bar 40 tall, canvas 1000x560 at y=40, cluster 200x30,
  // 8px margin. The reachable box is therefore x 8..792, y 48..562.
  assert.deepEqual(controller.graphToolsBounds(), { minX: 8, minY: 48, maxX: 792, maxY: 562 });
  assert.deepEqual(controller.clampGraphToolsPoint({ x: -4000, y: -4000 }), { x: 8, y: 48 });
  assert.deepEqual(controller.clampGraphToolsPoint({ x: 4000, y: 4000 }), { x: 792, y: 562 });

  // A drag that overshoots the canvas must leave the cluster on screen, not
  // parked behind the stage bar or past the right edge.
  controller.moveGraphTools({ x: 5000, y: -300 });
  assert.deepEqual(controller.position(), { x: 792, y: 48 });
  assert.equal(graphTools.dataset.floating, "true");
  assert.equal(graphTools.styleValues.get("--tools-x"), "792px");
  assert.equal(graphTools.styleValues.get("--tools-y"), "48px");
  assert.equal(window.localStorage.getItem(GRAPH_TOOLS_KEY), JSON.stringify({ x: 792, y: 48 }));

  // Docking clears the offset, the stored point, and announces the change.
  controller.dockGraphTools();
  assert.equal(controller.position(), null);
  assert.equal(graphTools.dataset.floating, "false");
  assert.equal(graphTools.styleValues.has("--tools-x"), false);
  assert.equal(window.localStorage.getItem(GRAPH_TOOLS_KEY), null);
  assert.match(liveRegion.textContent, /docked/iu);

  // Arrow keys move by a fixed step and report where the cluster landed.
  controller.nudgeGraphTools(12, 0);
  assert.deepEqual(controller.position(), { x: 12, y: 48 });
  assert.match(liveRegion.textContent, /12/u);
});

test("re-clamps the graph control cluster after the canvas viewport shrinks", () => {
  const wide = graphToolsHarness();
  wide.controller.moveGraphTools({ x: 700, y: 500 });
  assert.deepEqual(wide.controller.position(), { x: 700, y: 500 });

  // The same stored point is out of reach on a narrow, short canvas; the
  // ResizeObserver path must pull it back rather than leave it unreachable.
  const narrow = graphToolsHarness({
    stored: JSON.stringify({ x: 700, y: 500 }),
    canvas: { top: 40, height: 200, width: 420 },
  });
  narrow.controller.restore();
  assert.deepEqual(narrow.controller.position(), { x: 700, y: 500 });
  narrow.controller.reclampGraphTools();
  assert.deepEqual(narrow.controller.position(), { x: 212, y: 202 });

  // Re-clamping must not rewrite storage, so returning to a wide viewport
  // restores the operator's chosen placement.
  assert.equal(narrow.window.localStorage.getItem(GRAPH_TOOLS_KEY), JSON.stringify({ x: 700, y: 500 }));
});

test("falls back to the docked default when the stored cluster position is unusable", () => {
  for (const stored of ["", "not json", "null", "[]", '{"x":"12","y":8}', '{"x":null,"y":null}', '{"y":8}']) {
    const { controller, graphTools } = graphToolsHarness({ stored });
    assert.doesNotThrow(() => controller.restore(), `stored value ${JSON.stringify(stored)} must not throw`);
    assert.equal(controller.position(), null, `stored value ${JSON.stringify(stored)} must not be trusted`);
    assert.equal(graphTools.dataset.floating, "false");
  }

  const { controller } = graphToolsHarness({ stored: JSON.stringify({ x: 120, y: 90 }) });
  controller.restore();
  assert.deepEqual(controller.position(), { x: 120, y: 90 });
});

test("keeps the stage rail's declared floor consistent with its own track arithmetic", () => {
  const rules = stylesheetRules(renderLiveControlRoomPage({ snapshot: snapshotFixture }));

  const columns = resolvedDeclaration(rules, { selector: ".stage-rail", property: "grid-template-columns" });
  const repeated = columns.match(/repeat\((\d+),\s*minmax\((\d+(?:\.\d+)?)px/u);
  assert.ok(repeated, `.stage-rail must declare a repeat(count, minmax(floor, ...)) track list, got ${columns}`);
  const trackCount = Number(repeated[1]);
  const trackFloor = Number(repeated[2]);
  const gap = lengthToPixels(resolvedDeclaration(rules, { selector: ".stage-rail", property: "gap" }));
  const trackFloorSum = trackCount * trackFloor + (trackCount - 1) * gap;

  // A pixel floor written by hand has to be re-derived every time the track floor
  // or the gap moves. When it drifts below the sum, the tracks overflow the box the
  // rail declares for itself, so the last cell hangs outside its own container.
  const declaredFloor = resolvedDeclaration(rules, { selector: ".stage-rail", property: "min-width" });
  assert.ok(
    declaredFloor !== null && !/^-?[\d.]+(px|rem)$/u.test(declaredFloor),
    `.stage-rail min-width must be derived from its tracks, not a hand-maintained constant; got ${declaredFloor}`,
  );
  assert.equal(
    declaredFloor,
    "min-content",
    `.stage-rail min-width must resolve to the ${trackFloorSum}px its own tracks demand`,
  );
});

test("keeps the docked graph toolbar inside the canvas column at the dense band floor", () => {
  const rules = stylesheetRules(renderLiveControlRoomPage({ snapshot: snapshotFixture }));

  // The narrowest viewport that still gets the dense treatment, measured against
  // the canvas column rather than the viewport: the inspector owns a fixed track,
  // so the bar is far narrower than the window it sits in.
  const bandFloor = Number(DENSE_BAND.match(/min-width:\s*(\d+)px/u)[1]);
  const grid = resolvedDeclaration(rules, {
    selector: '.workspace-grid[data-inspector-open="true"]',
    property: "grid-template-columns",
    condition: DENSE_BAND,
  });
  const inspectorTrack = Number(grid.match(/(\d+)px\s*$/u)[1]);
  const gridGap = lengthToPixels(resolvedDeclaration(rules, { selector: ".workspace-grid", property: "gap", condition: DENSE_BAND }));
  const gridPadding = lengthToPixels(
    resolvedDeclaration(rules, { selector: ".workspace-grid", property: "padding", condition: DENSE_BAND }).split(/\s+/u)[1],
  );
  const canvasColumn = bandFloor - gridPadding * 2 - gridGap - inspectorTrack;

  const barPadding = lengthToPixels(
    resolvedDeclaration(rules, { selector: ".graph-stage-bar", property: "padding", condition: DENSE_BAND }).split(/\s+/u)[1],
  );
  const barGap = lengthToPixels(resolvedDeclaration(rules, { selector: ".graph-stage-bar", property: "gap" }));
  const barContent = canvasColumn - barPadding * 2 - barGap * 2;

  // The cluster is the only bar child that cannot yield: the title truncates and
  // the legend is `min-width: 0`. So whatever floor the toolbar declares becomes
  // an overflow that `.graph-stage` (overflow: visible in this band) paints over
  // the inspector.
  const handleFloor = lengthToPixels(resolvedDeclaration(rules, { selector: ".graph-tools-handle", property: "min-width" }));
  const toolsGap = lengthToPixels(resolvedDeclaration(rules, { selector: ".graph-canvas-tools", property: "gap" }));
  const toolbarFloorValue =
    resolvedDeclaration(rules, { selector: ".graph-toolbar", property: "min-width", condition: DENSE_BAND }) ??
    resolvedDeclaration(rules, { selector: ".graph-toolbar", property: "min-width" }) ??
    "0px";
  const clusterFloor = handleFloor + toolsGap + lengthToPixels(toolbarFloorValue);

  assert.ok(
    clusterFloor <= barContent,
    `docked control cluster floor ${clusterFloor}px must fit the ${barContent}px bar content box at a ${bandFloor}px viewport`,
  );

  // Yielding requires the flex parent to be allowed to shrink; `flex: 0 0 auto`
  // with no min-width made the constraint unenforceable.
  assert.equal(resolvedDeclaration(rules, { selector: ".graph-canvas-tools", property: "min-width" }), "0");
  assert.match(resolvedDeclaration(rules, { selector: ".graph-canvas-tools", property: "flex" }), /^0 1 auto$/u);
  assert.equal(resolvedDeclaration(rules, { selector: ".graph-toolbar", property: "flex-wrap" }), "wrap");
});

test("keeps the run context row inside every viewport width the config declares", () => {
  const rules = stylesheetRules(renderLiveControlRoomPage({ snapshot: snapshotFixture }));
  const config = JSON.parse(readFileSync(fileURLToPath(LIVE_VIEWPORT_PROFILES_CONFIG_URL), "utf8"));

  // Hand-written `minmax(<px>, …)` minimums plus gaps and padding can add up past
  // the band the rule lives in, and `main` is `overflow-x: hidden`, so the last
  // column is clipped with no scrollbar to reach it. Widths come from config so a
  // new profile or collapse gate is covered without editing this assertion.
  const dense = config.denseLayoutGate;
  const gateWidths = config.collapseGates.flatMap((gate) =>
    [gate.minWidthPx, gate.maxWidthPx, Number.isFinite(gate.maxWidthPx) ? gate.maxWidthPx + 1 : null]
      .filter((width) => Number.isFinite(width))
      .map((width) => [gate.id, width]),
  );
  const viewports = [
    ...config.profiles.map((profile) => ({ id: profile.id, width: profile.widthPx, height: profile.heightPx })),
    { id: "dense-gate-floor", width: dense.minWidthPx, height: dense.minHeightPx },
    ...gateWidths.flatMap(([id, width]) => [
      { id: `${id}-${width}-tall`, width, height: dense.minHeightPx },
      { id: `${id}-${width}-short`, width, height: dense.minHeightPx - 1 },
    ]),
  ];

  const evaluated = [];
  const skipped = [];
  for (const viewport of viewports) {
    const resolve = (property) => resolvedForViewport(rules, { selector: ".run-context", property, viewport });
    if (resolve("display") !== "grid") {
      skipped.push({ id: viewport.id, display: resolve("display") });
      continue;
    }
    const tracks = splitTrackList(resolve("grid-template-columns"));
    const floor = tracks.reduce((sum, track) => sum + trackFloorPx(track), 0)
      + columnGapPx(resolve("gap")) * (tracks.length - 1)
      + horizontalPaddingPx(resolve("padding"));
    evaluated.push({ id: viewport.id, width: viewport.width, floor, tracks: tracks.length });
    assert.ok(
      floor <= viewport.width,
      `.run-context declares a ${floor}px floor at the ${viewport.width}px ${viewport.id} viewport, so `
        + `${(floor - viewport.width).toFixed(1)}px is clipped by an overflow-x: hidden ancestor`,
    );
  }

  // Without this the whole assertion goes vacuous the moment the row stops
  // resolving to a grid, or the media matcher stops matching the dense band.
  assert.ok(
    evaluated.length >= config.profiles.filter((profile) => profile.expectDenseLayout).length,
    `every dense profile must be evaluated; evaluated ${JSON.stringify(evaluated.map((entry) => entry.id))}, `
      + `skipped ${JSON.stringify(skipped)}`,
  );
  assert.ok(
    evaluated.every((entry) => entry.tracks >= 2),
    `each evaluated viewport must resolve a real track list; got ${JSON.stringify(evaluated)}`,
  );
});

test("keeps the workspace session emphasis bar clear of its own label text", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  // The row had `padding: .72rem 0` while hover drew `inset 3px 0 0`, so the
  // emphasis bar landed on the first glyph of the session title.
  assert.match(html, /\.operational-section\s*\{(?:(?!\})[\s\S])*--section-inline:/u);
  assert.match(html, /\.workspace-child\s*\{(?:(?!\})[\s\S])*padding:\s*var\(--sp-default\) var\(--section-inline, 0px\)/u);
  assert.match(html, /\.workspace-child:hover, \.workspace-child\[data-active="true"\]\s*\{(?:(?!\})[\s\S])*inset 3px 0 0/u);

  // The default row state draws no bar at all, so asserting the two rules exist
  // proves nothing about the state that was broken. Measure the active row: the
  // inline padding that holds the title has to clear the bar in every band that
  // redefines `--section-inline`, not just in the widest one.
  const rules = stylesheetRules(html);
  const emphasis = rules
    .filter((rule) => rule.selectors.includes('.workspace-child[data-active="true"]'))
    .flatMap((rule) => rule.declarations.filter(([name]) => name === "box-shadow").map(([, value]) => value));
  assert.equal(emphasis.length, 1);
  const barWidth = Number(emphasis[0].match(/inset (\d+(?:\.\d+)?)px/u)[1]);
  const titleInset = declaredValues(rules, { selector: ".operational-section", property: "--section-inline" });
  assert.ok(titleInset.length >= 1);
  for (const value of titleInset) {
    const pixels = lengthToPixels(value);
    assert.ok(pixels >= barWidth, `title inset ${value} must clear the ${barWidth}px emphasis bar`);
  }

  // `outline: none` used to remove the only keyboard affordance on the row.
  assert.match(html, /\.workspace-child:focus-visible\s*\{(?:(?!\})[\s\S])*outline:\s*2px solid var\(--accent\)/u);
  assert.doesNotMatch(html, /\.workspace-child:focus-visible\s*\{(?:(?!\})[\s\S])*outline:\s*none/u);

  // The container title was clipped by a hardcoded header height.
  assert.doesNotMatch(html, /calc\(100% - 82px\)/u);
  assert.match(html, /\.repository-view\s*\{(?:(?!\})[\s\S])*grid-template-rows:\s*auto minmax\(0, 1fr\)/u);
  assert.match(html, /\.repository-layout\s*\{(?:(?!\})[\s\S])*min-height:\s*0/u);
});

test("every element that draws a left accent bar reserves inline padding for it", () => {
  const rules = stylesheetRules(renderLiveControlRoomPage({ snapshot: snapshotFixture }));

  // `.workspace-child` was the reported defect, but the shape repeats: any rule
  // that paints `inset <N>px 0 0` puts an opaque band over the element's own
  // leading edge, and only inline padding keeps text out from under it. Scanning
  // the whole stylesheet covers the rows nobody wrote a spot check for --
  // `.operational-row` and `.work-view-tab` among them -- and blocks the next one.
  const barred = new Map();
  for (const rule of rules) {
    for (const [property, value] of rule.declarations) {
      if (property !== "box-shadow") continue;
      const bar = /inset\s+(\d+(?:\.\d+)?)px\s+0\s+0/u.exec(value);
      if (!bar) continue;
      for (const selector of rule.selectors) {
        const base = baseSelectorOf(selector);
        barred.set(base, Math.max(barred.get(base) ?? 0, Number(bar[1])));
      }
    }
  }

  assert.ok(
    barred.size >= 2,
    "found no accent-bar rules to check, so this guard would pass by scanning nothing",
  );

  for (const [selector, barWidth] of barred) {
    const shorthand = resolvedDeclaration(rules, { selector, property: "padding" });
    const explicit =
      resolvedDeclaration(rules, { selector, property: "padding-inline" }) ??
      resolvedDeclaration(rules, { selector, property: "padding-left" });
    const inline = explicit
      ? splitTopLevel(explicit)[0]
      : shorthand && inlineComponentOf(splitTopLevel(shorthand));
    assert.ok(
      inline,
      `${selector} draws a ${barWidth}px accent bar but declares no padding at all, so the bar sits on its text`,
    );

    for (const [source, pixels] of resolveInlinePadding(rules, inline)) {
      assert.ok(
        pixels >= barWidth,
        `${selector} draws a ${barWidth}px accent bar over inline padding ${source} (${pixels}px)`,
      );
    }
  }
});

test("is accessible by keyboard and respects reduced motion", () => {
  const html = renderLiveControlRoomPage();

  assert.match(html, /skip-to-content/iu);
  assert.match(html, /aria-live="polite"/iu);
  assert.match(html, /aria-label="Play replay"/iu);
  assert.match(html, /aria-label="Replay position"/iu);
  assert.match(html, /keydown/iu);
  assert.match(html, /ArrowLeft/iu);
  assert.match(html, /ArrowRight/iu);
  assert.match(html, /Home/iu);
  assert.match(html, /End/iu);
  assert.match(html, /prefers-reduced-motion\s*:\s*reduce/iu);
  assert.match(html, /focus-visible/iu);
  assert.match(html, /overflow-wrap:\s*anywhere/iu);
  assert.match(html, /event\.defaultPrevented \|\| typing \|\| interactive/u);
  assert.match(html, /button, a, \[role="button"\], \[role="option"\], \[contenteditable="true"\]/u);
  assert.match(html, /dialogActive[\s\S]{0,120}event\.defaultPrevented \|\| typing \|\| interactive \|\| dialogActive/u);
});

test("does not expose mutation affordances in the read-only MVP", () => {
  const renderedHtml = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  // The read-only contract is about what the browser receives in its initial
  // DOM. Conditional control templates may remain in the inert client script.
  const initialMarkup = renderedHtml.slice(0, renderedHtml.indexOf("<script"));
  const html = initialMarkup;

  assert.doesNotMatch(html, /<button[^>]+(?:pause|resume|handoff|cancel|stop|retry)/iu);
  assert.doesNotMatch(html, /(?:POST|PUT|PATCH|DELETE)\s*:/iu);
  assert.doesNotMatch(html, /\b(?:handoff|resume run|pause run)\b(?![^<]*coming next)/iu);
  assert.match(html, /read-only|read only/iu);
});

test("escapes custom endpoint attributes without changing the runtime contract", () => {
  const html = renderLiveControlRoomPage({
    snapshotEndpoint: "/api/snapshot?view=control-room&x=\"quoted\"",
    eventsEndpoint: "/api/events?channel=live&x=<unsafe>",
    projectsEndpoint: "/api/projects?source=registry&x=<unsafe>",
    replayEndpoint: "/api/replay?view=timeline&x=\"quoted\"",
  });

  assert.match(html, /data-snapshot-endpoint="\/api\/snapshot\?view=control-room&amp;x=&quot;quoted&quot;"/u);
  assert.match(html, /data-events-endpoint="\/api\/events\?channel=live&amp;x=&lt;unsafe&gt;"/u);
  assert.match(html, /data-projects-endpoint="\/api\/projects\?source=registry&amp;x=&lt;unsafe&gt;"/u);
  assert.match(html, /data-replay-endpoint="\/api\/replay\?view=timeline&amp;x=&quot;quoted&quot;"/u);
  assert.doesNotMatch(html, /data-(?:snapshot|events)-endpoint="[^"]*<|data-(?:snapshot|events)-endpoint="[^"]*"[^>]*\bon/iu);
});

test("renders an accessible project and run-record selector with explicit identity guidance", () => {
  const html = renderLiveControlRoomPage();

  assert.match(html, /data-live-project-select/u);
  assert.match(html, /data-live-session-select/u);
  assert.match(html, /aria-label="Choose a Meta_Kim project"/u);
  assert.match(html, /aria-label="Choose a governed run record"/u);
  assert.match(html, /data-live-session-search/u);
  assert.match(html, /这里显示的是 Meta_Kim 运行记录，不是聊天列表/u);
  // "未关联" reads as a link that went missing. These runs never wrote one, so
  // the title has to name the absent id rather than an absent association.
  assert.match(html, /没有保存聊天标识的运行记录/u);
  assert.doesNotMatch(html, /未关联聊天/u, "no slot may still describe these runs as having lost a link");
  assert.match(html, /还没有可识别的聊天记录/u);
  assert.match(html, /showUnlinkedSessions = false/u);
  assert.match(html, /liveShowUnlinked/u);
  assert.match(html, /\.dialog-card\s*\{[^}]*overflow:\s*hidden[^}]*border-radius:/su);
  assert.match(html, /\.dialog-body\s*\{[^}]*overflow:\s*auto[^}]*scrollbar-gutter:\s*stable/su);
  assert.match(html, /data-live-hub-status[^>]+aria-live="polite"/u);
  assert.match(html, /No Meta_Kim projects are registered yet/u);
  assert.match(html, /no governed runs yet/iu);
  assert.match(html, /Hub never scans your disk/u);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*\.hub-switcher[^}]*grid-template-columns:\s*1fr/u);
});

test("loads the Hub catalog, honors deep links, and reconnects scoped read endpoints", () => {
  const html = renderLiveControlRoomPage();

  assert.match(html, /fetch\(projectsEndpoint/iu);
  assert.match(html, /selectionFromLocation\(\)/u);
  assert.match(html, /new URL\(window\.location\.href\)\.searchParams/u);
  assert.match(html, /new URLSearchParams\(url\.search\)/u);
  assert.match(html, /params\.set\("projectId", selectedProjectId\)/u);
  assert.match(html, /params\.set\("runId", selectedRunId\)/u);
  assert.match(html, /history\.replaceState/u);
  assert.match(html, /fetch\(endpointForSelection\(replayEndpoint\)/u);
  assert.match(html, /disconnectEvents\(\)/u);
  assert.match(html, /abortController\?\.abort\(\)/u);
  assert.match(html, /connectEvents\(generation\)/u);
  assert.match(html, /projectSelect\?\.addEventListener\("change"/u);
  assert.match(html, /sessionSelect\?\.addEventListener\("change"/u);
  assert.match(html, /loadProjectCatalog\(\{ refresh: true \}\)/u);
  assert.match(html, /document\.visibilityState === "visible"/u);
  assert.match(html, /clearInterval\(catalogRefreshTimer\)/u);
  assert.match(html, /const generation = \+\+selectionGeneration/u);
  assert.match(html, /generation !== selectionGeneration/u);
  assert.match(html, /pendingSnapshot = null/u);
  assert.match(html, /snapshotRequestInFlight = false/u);
  assert.match(html, /selectedNodeId = null/u);
});

test("renders catalog labels through bounded text-only DOM operations", () => {
  const html = renderLiveControlRoomPage();

  assert.match(html, /rawProjects\.slice\(0, 128\)/u);
  assert.match(html, /rawSessions\.slice\(0, 256\)/u);
  assert.match(html, /option\.textContent\s*=/u);
  assert.match(html, /option\.value\s*=/u);
  assert.match(html, /safeIdentifier/u);
  assert.match(html, /formatSessionTime\(session\.updatedAt\)/u);
  assert.match(html, /sessionShortId\(session\)/u);
  assert.match(html, /sessionIsIdentified\(session\)/u);
  assert.doesNotMatch(html, /\.innerHTML\b/iu);
  assert.doesNotMatch(html, /projectsEndpoint\s*\+|eventsEndpoint\s*\+|snapshotEndpoint\s*\+/u);
});

test("falls back from unsafe endpoints and circular initial snapshots", () => {
  const circular = {};
  circular.self = circular;
  const html = renderLiveControlRoomPage({
    snapshot: circular,
    snapshotEndpoint: "https://attacker.example/snapshot",
    eventsEndpoint: "//attacker.example/events",
    projectsEndpoint: "https://attacker.example/projects",
    replayEndpoint: "//attacker.example/replay",
  });
  assert.match(html, /data-snapshot-endpoint="\/api\/snapshot"/u);
  assert.match(html, /data-events-endpoint="\/api\/events"/u);
  assert.match(html, /data-projects-endpoint="\/api\/projects"/u);
  assert.match(html, /data-replay-endpoint="\/api\/replay"/u);
  assert.match(html, /id="live-initial-snapshot">null<\/script>/u);
});

test("exposes local share actions and the /api/share read path without upload affordances", () => {
  const html = renderLiveControlRoomPage({
    shareEndpoint: "/api/share?surface=public",
  });

  assert.match(html, /data-share-endpoint="\/api\/share\?surface=public"/u);
  assert.match(html, /data-live-share-export-json/u);
  assert.match(html, /data-live-share-copy-pr/u);
  assert.match(html, /data-live-share-copy-readme/u);
  assert.match(html, /Export JSON/iu);
  assert.match(html, /Copy PR card/iu);
  assert.match(html, /README embed/iu);
  assert.match(html, /navigator\.clipboard\.writeText/iu);
  assert.match(html, /loadShareText\("markdown"\)/u);
  assert.match(html, /loadShareText\("readme"\)/u);
  assert.doesNotMatch(html, /readmeEmbedFromArtifact|safeShareText/iu);
  assert.match(html, /meta-kim-live-share-status/iu);
  assert.doesNotMatch(html, /data-live-control-action="(?:pause|resume|reassign|handoff)"/iu);
  assert.doesNotMatch(html, /fetch\([^)]*method\s*:\s*["'](?:POST|PUT|PATCH|DELETE)/iu);
});

test("renders continuation controls only when every command capability is explicitly available", () => {
  const capabilities = {
    pause: { available: true },
    resume: { available: true },
    reassign: { available: true },
    handoff: { available: true },
  };
  const enabled = renderLiveControlRoomPage({
    snapshot: { ...snapshotFixture, control: { controlEnabled: true, controlHeader: "x-meta-kim-control-token", controlToken: "local-control-token-123456", capabilities } },
    controlEnabled: true,
    commandCapabilities: capabilities,
    controlHeader: "x-meta-kim-control-token",
    controlToken: "local-control-token-123456",
  });
  for (const action of ["pause", "resume", "reassign", "handoff"]) {
    assert.match(enabled, new RegExp(`data-live-control-action="${action}"`, "u"));
  }
  assert.match(enabled, /confirm/iu);
  assert.match(enabled, /aria-busy/iu);
  assert.match(enabled, /control.*error|error.*control/isu);
  assert.match(enabled, /control.*result|result.*control/isu);
  assert.match(enabled, /\/api\/commands/iu);

  const incomplete = renderLiveControlRoomPage({
    snapshot: { ...snapshotFixture, control: { controlEnabled: true, controlHeader: "x-meta-kim-control-token", controlToken: "local-control-token-123456", capabilities: { pause: true, resume: true, reassign: true } } },
    controlEnabled: true,
    commandCapabilities: { pause: true, resume: true, reassign: true },
    controlHeader: "x-meta-kim-control-token",
    controlToken: "local-control-token-123456",
  });
  assert.doesNotMatch(incomplete, /data-live-control-action="(?:pause|resume|reassign|handoff)"/iu);
});

test("keeps control and share values in text-safe DOM APIs and preserves reduced-motion hooks", () => {
  const html = renderLiveControlRoomPage({
    snapshot: {
      ...snapshotFixture,
      run: { ...snapshotFixture.run, title: "</script><img src=x onerror=alert(1)>" },
      control: {
        controlEnabled: true,
        controlHeader: "x-meta-kim-control-token",
        controlToken: "local-control-token-123456",
        capabilities: {
          pause: true,
          resume: true,
          reassign: true,
          handoff: true,
        },
      },
    },
    controlEnabled: true,
    commandCapabilities: { pause: true, resume: true, reassign: true, handoff: true },
    controlHeader: "x-meta-kim-control-token",
    controlToken: "local-control-token-123456",
  });
  assert.doesNotMatch(html, /\.innerHTML\b/iu);
  assert.match(html, /textContent\s*=/u);
  assert.match(html, /prefers-reduced-motion\s*:\s*reduce/iu);
  assert.match(html, /aria-live="(?:polite|assertive)"/iu);
  assert.match(html, /button[^>]+type="button"/iu);
});

test("requires the fixed control header and a bounded token before exposing controls", () => {
  const capabilities = {
    pause: true,
    resume: true,
    reassign: true,
    handoff: true,
  };
  const missingToken = renderLiveControlRoomPage({
    snapshot: { ...snapshotFixture, control: { controlEnabled: true, controlHeader: "x-meta-kim-control-token", capabilities } },
    controlEnabled: true,
    commandCapabilities: capabilities,
    controlHeader: "x-meta-kim-control-token",
  });
  assert.doesNotMatch(missingToken, /data-live-control-action="(?:pause|resume|reassign|handoff)"/iu);

  const wrongHeader = renderLiveControlRoomPage({
    snapshot: { ...snapshotFixture, control: { controlEnabled: true, controlHeader: "authorization", controlToken: "local-control-token-123456", capabilities } },
    controlEnabled: true,
    commandCapabilities: capabilities,
    controlHeader: "authorization",
    controlToken: "local-control-token-123456",
  });
  assert.doesNotMatch(wrongHeader, /data-live-control-action="(?:pause|resume|reassign|handoff)"/iu);

  const hostileToken = renderLiveControlRoomPage({
    snapshot: { ...snapshotFixture, control: { controlEnabled: true, controlHeader: "x-meta-kim-control-token", controlToken: "</script><img src=x>", capabilities } },
  });
  assert.doesNotMatch(hostileToken, /data-live-control-action="(?:pause|resume|reassign|handoff)"/iu);
  assert.doesNotMatch(hostileToken, /<\/script><img src=x>/iu);

  const escapedToken = renderLiveControlRoomPage({
    snapshot: { ...snapshotFixture, control: { controlEnabled: true, controlHeader: "x-meta-kim-control-token", controlToken: "safe-token-123456=", capabilities } },
  });
  assert.match(escapedToken, /safe-token-123456\\u003D/u);
  assert.doesNotMatch(escapedToken, /safe-token-123456=/u);
});

test("uses a compact, zoomable DAG canvas with a minimap and fit controls", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  for (const marker of [
    "data-live-graph-viewport",
    "data-live-graph-scene",
    "data-live-graph-minimap",
    "data-live-minimap-viewport",
    "data-live-graph-fit",
    "data-live-graph-zoom-in",
    "data-live-graph-zoom-out",
    "data-live-graph-layout",
    "layoutGraph",
    "updateCamera",
  ]) {
    assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\[\]\\]/gu, "\\$&"), "u"), marker);
  }
  assert.match(html, /graphScene\.style\.transform/u);
  assert.match(html, /data-live-graph-minimap/iu);
  assert.match(html, /dataset\.semanticZoom\s*=\s*resolveSemanticZoom\(camera\.scale,\s*GRAPH_CAMERA\)/u);
  assert.match(html, /const fit\s*=\s*resolveOverviewCamera\(canvas,\s*graphState\.bounds,\s*graphFitInset\(\),\s*GRAPH_CAMERA\)/u);
  assert.match(html, /wholeGraphFits\s*\?\s*inset\.left\s*\+\s*\(usableWidth\s*-\s*content\.width\s*\*\s*scale\)\s*\/\s*2\s*:\s*inset\.left/u);
});

test("draws curved status-aware edges and a live flow animation with reduced-motion fallback", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /createElementNS\(["']http:\/\/www\.w3\.org\/2000\/svg["'],\s*["']path["']\)/u);
  assert.match(html, /edge-running/iu);
  assert.match(html, /edge-failed/iu);
  assert.match(html, /edge-queued/iu);
  assert.match(html, /const stageFocusState\s*=\s*executionRelation\s*&&\s*snapshot\.run\?\.active[\s\S]{0,180}targetState\s*===\s*"active"\s*\?\s*"live"\s*:\s*"none"/u);
  assert.match(html, /EXECUTION_EDGE_KINDS\.has\(edge\.kind \|\| "sequence"\)/u);
  assert.match(html, /executionRelation \? nodeClass\(edge\.status\) : "structural"/u);
  assert.match(html, /path\.dataset\.liveFocus\s*=\s*stageFocusState/u);
  assert.match(html, /\.edge-flow-glow\[data-stage-focus="recorded"\][^{]*\{[^}]*stroke:\s*#d8a84e[^}]*filter:\s*blur\(3px\)/su);
  assert.match(html, /\.edge-flow-tracer\[data-stage-focus="recorded"\][^{]*\{[^}]*animation:\s*stage-route-flow/su);
  assert.match(html, /\.edge-flow-tracer\[data-stage-focus="live"\][^{]*\{[^}]*animation:\s*live-flow/su);
  assert.match(html, /createElementNS\("http:\/\/www\.w3\.org\/2000\/svg", "animateMotion"\)/u);
  assert.match(html, /!reducedMotion\.matches/u);
  assert.match(html, /"stage-live":\s*"#58d4cf"[\s\S]{0,80}"stage-recorded":\s*"#d8a84e"/u);
  assert.match(html, /const replayFocus\s*=\s*executionRelation\s*&&\s*!replayFollowingLive[\s\S]{0,180}\?\s*"recorded"[\s\S]{0,140}path\.dataset\.liveFocus/u);
  assert.match(html, /replayFocus\s*===\s*"recorded"[\s\S]{0,100}\?\s*"stage-recorded"[\s\S]{0,100}: replayState/u);
  assert.match(html, /march|dash|flow/iu);
  assert.match(html, /prefers-reduced-motion\s*:\s*reduce/iu);
});

test("every edge state clears the non-text contrast floor against whatever the canvas paints", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const rules = stylesheetRules(html);

  // The blurred glow, tracer and particle layers are left out of the floor below,
  // and that exclusion is only sound while those classes stay on their own overlay
  // elements. Put one on a base edge and a decorative opacity of .18 becomes the
  // edge's own paint — the floor would have been quietly opted out of rather than
  // met, and every ratio here would still read green.
  assert.doesNotMatch(html, /"edge edge-flow/u, "flow effect classes must stay off the base edge element");

  // Every ink below is read from the unconditional `:root` block. A media band
  // re-declaring one, or re-declaring it on `.shell`, which wraps the canvas,
  // would paint a colour this test never looks at: the ratios would all be
  // computed against a token that does not apply where the reader is looking.
  for (const token of ["--edge-ink-dim", "--edge-ink-idle", "--green", "--amber", "--danger"]) {
    const shadowing = rules
      .filter((rule) => rule.conditions.length > 0 || !rule.selectors.includes(":root"))
      .filter((rule) => rule.declarations.some(([property]) => property === token))
      .map((rule) => [...rule.conditions, ...rule.selectors].join(" "));
    assert.deepEqual(shadowing, [], `${token} is declared outside the unconditional :root block, so the measured ink is not the painted one`);
  }

  // Probes sit on the sheet's own band boundaries rather than on round numbers: the
  // canvas fill is declared twice and the second declaration only applies from
  // 901x720 up, so a single wide probe would never measure the darker fill and a
  // single narrow one would never measure the lighter.
  const probes = [
    { width: 1707, height: 825, note: "a window size the reporter actually ran" },
    { width: 901, height: 720, note: "the desktop band's own floor" },
    { width: 900, height: 719, note: "one pixel outside the desktop band" },
    { width: 721, height: 900, note: "one pixel above the width that hides the edge layer" },
  ];

  for (const viewport of probes) {
    // Below 721px the edge layer is display:none, so there is no line to read and
    // nothing to hold to a ratio. Asserting it here keeps the probe list and that
    // cutoff from drifting apart: move the cutoff up and this fails rather than
    // silently measuring a layer the reader cannot see.
    assert.notEqual(
      resolvedForViewport(rules, { selector: ".edge-layer", property: "display", viewport }),
      "none",
      `the edge layer is hidden at ${viewport.width}x${viewport.height} (${viewport.note}), so this probe proves nothing about legibility`,
    );

    const backdrops = graphCanvasBackdrops(rules, viewport);
    for (const selector of edgeStrokeSelectors(rules)) {
      const paint = resolvedEdgePaint(rules, selector, viewport);
      // Checked against every backdrop rather than against whichever one looks
      // worst. Which one binds depends on whether the ink is lighter or darker
      // than the canvas, and that is a fact about a colour someone may change
      // later, not a fact this test should assume today.
      for (const [label, backdrop] of backdrops) {
        const ratio = contrastRatio(compositeOver(paint.rgb, backdrop, paint.alpha), backdrop);
        assert.ok(
          ratio >= NON_TEXT_CONTRAST_MINIMUM,
          `${selector} paints ${paint.source} at alpha ${paint.alpha} over ${label}, giving ${ratio.toFixed(3)}:1 at ${viewport.width}x${viewport.height} — under the ${NON_TEXT_CONTRAST_MINIMUM}:1 a reader needs to follow the line`,
        );
      }
    }
  }
});

test("binds node selection to evidence and replay state without unbounded DOM growth", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /data-live-selected-node/iu);
  assert.match(html, /selectNode/iu);
  assert.match(html, /associated|nodeId|selected.*evidence/isu);
  assert.match(html, /slice\(0,\s*128\)/u);
  assert.match(html, /dataset\.replayActive/iu);
  assert.match(html, /ArrowUp|ArrowDown|Enter/iu);
});

test("keeps stage chapters out of a v2 entity graph while preserving v1 fallback", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /STAGE_MATCH_ORDER\s*=\s*\[\.\.\.STAGE_ORDER\]\.sort/iu);
  assert.match(html, /text\.startsWith\(stageName\s*\+\s*["']-["']\)/u);
  assert.match(html, /explicitStatus[\s\S]{0,500}nodeById\.get\(targetId\)\?\.status/u);
  assert.match(html, /nodeStatuses\s*=\s*new Set\(\[[^\]]*"skipped"/u);
  assert.match(html, /executionNodes\s*=\s*snapshot\.nodes\.filter[\s\S]{0,180}"stage_summary"/u);
  assert.match(html, /return executionNodes\.length \? executionNodes : snapshot\.nodes/u);
});

test("lays out worker and workflow entities by spawn depth with a v1 serpentine fallback", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  // Every distance the layout uses now comes from configuration, so the guard is
  // the round trip rather than a per-number regex: the object the page ships must
  // be exactly what the serializer exports for the loaded policy. Dropping a
  // field on the way to the browser leaves the page reading `undefined` and
  // computing NaN geometry, which nothing else here would notice.
  const shipped = /^\s*const GRAPH_LAYOUT = (\{.*\});$/mu.exec(html);
  assert.ok(shipped, "the page must ship the layout policy as one serialized object");
  assert.deepEqual(
    JSON.parse(shipped[1]),
    JSON.parse(JSON.stringify(serializeGraphLayoutPolicyForClient(loadLiveGraphLayoutPolicy()))),
    "the policy the browser receives must match the one the tests exercise",
  );

  assert.match(html, /const cardWidth\s*=\s*GRAPH_LAYOUT\.card\.stageWidthPx/u);
  assert.match(html, /function estimatedNodeCardHeight\(node\)/u);
  assert.match(html, /resolveNodeCardHeight\(nodeCapabilityCount\(node\), GRAPH_LAYOUT\.card\)/u);
  // The claim that used to live here matched the source line `depthFor(parentId,
  // seen) + 1`. That expression is gone, and it was never the claim worth making:
  // it read as "one deeper than the parent" while the parent it consumed was
  // whichever edge happened to land last in the array. The behaviour it was
  // reaching for -- one more than the deepest thing upstream, over every edge --
  // is asserted directly against the shipped helper in "ranks each node one step
  // past the deepest thing upstream of it".
  assert.match(html, /const orderedLanes\s*=\s*\[\.\.\.lanes\.entries\(\)\]\.sort/u);
  assert.match(html, /const maxLaneHeight\s*=\s*Math\.max\(estimatedNodeCardHeight\(nodes\[0\]\), \.\.\.laneHeights\.values\(\)\)/u);
  assert.match(html, /x:\s*laneX/u);
  assert.match(html, /y:\s*laneY/u);
  assert.match(html, /laneY \+= height \+ entityRowGap/u);
  assert.match(html, /const laneX\s*=\s*scenePad\.left \+ depth \* entityColumnStep/u);
  assert.match(html, /const spineColumns\s*=\s*mode\.stageColumns/u);
  assert.match(html, /const rowGap\s*=\s*mode\.stageRowGapPx/u);
  assert.match(html, /row\s*%\s*2\s*===\s*0\s*\?\s*withinRow\s*:\s*spineColumns\s*-\s*1\s*-\s*withinRow/u);
  assert.match(html, /function edgeGeometry\(/u);
  assert.match(html, /function edgePortSlot\(index, count, span\)/u);
  assert.match(html, /sourceIndex:\s*Math\.max\(0, outgoing\.indexOf\(edge\)\)/u);
  assert.match(html, /sourceCount:\s*outgoing\.length/u);
  assert.match(html, /from\.spine\s*===\s*true\s*&&\s*to\.spine\s*===\s*false[\s\S]{0,100}Math\.abs\(deltaY\)/u);
  assert.match(html, /\.node-card\s*\{[^}]*min-height:\s*176px/su);
  assert.match(html, /function syncLayoutToRenderedCards\(layout\)/u);
  assert.match(html, /Math\.ceil\(card\.scrollHeight\)/u);
  assert.match(html, /nextY = previousBottom \+ GRAPH_LAYOUT\.renderedColumnGapPx/u);
  assert.match(html, /syncLayoutToRenderedCards\(layout\);[\s\S]*for \(const edge of graphEdges\)/u);
});

test("lays out high-fanout work as a searched non-crossing grid and ships an isolated mixed-state demo", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /const fanoutEntry\s*=\s*\[\.\.\.childrenByParent\.entries\(\)\]/u);
  assert.match(html, /children\.length\s*>=\s*GRAPH_LAYOUT\.fanout\.minimumChildren/u);
  // The block used to be one unwrapped row of literal steps, which produced a
  // scene the camera could not fit at all. The shape is now searched against the
  // canvas the browser reports, and siblings are filled row by row so edge order
  // inside a row stays monotonic and sibling lines still cannot cross.
  assert.match(html, /const arrangement = resolveFanoutArrangement\(\{/u);
  assert.match(html, /canvas:\s*graphCanvasBox\(\)/u);
  assert.match(html, /const column = index % arrangement\.columns/u);
  assert.match(html, /const row = Math\.floor\(index \/ arrangement\.columns\)/u);
  assert.match(html, /x:\s*blockX \+ column \* mode\.childColumnStepPx/u);
  assert.match(html, /y:\s*rowTop/u);
  assert.match(html, /kind:\s*"fanout"/u);
  assert.match(html, /graph\.dataset\.layoutKind\s*=\s*layout\.kind/u);
  assert.match(html, /demoMode\s*=\s*new URL\(window\.location\.href\)\.searchParams\.get\("demo"\)\s*===\s*"states"/u);
  assert.match(html, /function buildStateDemoSnapshot\(\)/u);
  for (const state of ["completed", "active", "queued", "blocked"]) {
    assert.match(html, new RegExp(`displayState:\\s*"${state}"`, "u"));
  }
  for (const [id, from, to, kind] of [
    ["demo-edge-1", "demo-owner", "demo-requirements", "sequence"],
    ["demo-edge-2", "demo-requirements", "demo-plan", "sequence"],
    ["demo-edge-3", "demo-plan", "demo-running-ui", "fork"],
    ["demo-edge-4", "demo-plan", "demo-running-test", "fork"],
    ["demo-edge-5", "demo-running-ui", "demo-queued", "depends_on"],
    ["demo-edge-6", "demo-running-test", "demo-queued", "depends_on"],
    ["demo-edge-7", "demo-queued", "demo-blocked", "depends_on"],
  ]) {
    assert.match(html, new RegExp(`id:\\s*"${id}"[^\\n]+from:\\s*"${from}"[^\\n]+to:\\s*"${to}"[^\\n]+kind:\\s*"${kind}"`, "u"));
  }
  assert.match(html, /nodeId:\s*"demo-requirements"/u);
  assert.match(html, /演示数据 · 非真实运行/u);
  assert.match(html, /青色流光＝进行中 · 绿色实线＝已完成 · 灰色虚线＝排队 · 琥珀虚线＝阻塞 · 点线＝结构归属/u);
  assert.match(html, /\.edge-completed\s*\{[^}]*stroke:\s*var\(--green\)[^}]*stroke-dasharray:\s*none/su);
  // Only the dash is pinned here. The opacity used to be pinned at .38 alongside it,
  // and .38 was the defect: 1.41:1 against the canvas, a line the reporter could not
  // follow. What a queued edge owes is a ratio, and a ratio is asserted by computing
  // it from the sheet's own declared values, not by freezing one number at the use
  // site where any replacement number looks equally correct.
  assert.match(html, /\.edge-skipped, \.edge-queued\s*\{[^}]*stroke-dasharray:\s*5 9/su);
  assert.match(html, /\.node-running\s*\{[^}]*animation:\s*active-node-pulse/su);
  assert.match(html, /\["active", "in_progress", "executing"\]\.includes\(status\)\) return "running"/u);
  assert.match(html, /\.node-completed\s*\{[^}]*border-left-color:\s*var\(--green\)/su);
  assert.match(html, /\.node-card\[data-display-state="queued"\][^\{]*\{[^}]*opacity:\s*\.66/su);
  assert.match(html, /if \(!demoMode\) void \(async \(\) =>/u);
});

/**
 * Evaluate the shipped `layoutGraph` and `graphRankById` against a canvas the
 * caller declares.
 *
 * Position is the only thing a reader can use to infer structure, so the claims
 * worth testing are geometric. Matching the placement expression in the page
 * source cannot make them: `index % arrangement.columns` reads as a correct grid
 * fill and is still wrong, because the index it consumes is array order.
 */
function graphLayoutHarness({ width, height }) {
  const html = renderLiveControlRoomPage({
    snapshot: { generatedAt: new Date(0).toISOString(), sessions: [], nodes: [], edges: [] },
  });
  const evalLiteral = (source) => new Function("return " + source + ";")();
  const shippedConstant = (name) => {
    const match = html.match(
      new RegExp("\\n  const " + name + " = (\\{[\\s\\S]*?\\}|\\[[\\s\\S]*?\\]);\\n", "u"),
    );
    assert.ok(match, name + " must remain a literal in the shipped script");
    return evalLiteral(match[1]);
  };
  const helpers = [
    "stageIndex",
    "graphNodesForSnapshot",
    "graphEdgesForSnapshot",
    "nodeCapabilityCount",
    "estimatedNodeCardHeight",
    "graphCanvasBox",
    "graphFitInset",
    "graphRankById",
    "layoutGraph",
  ];
  const layout = shippedConstant("GRAPH_LAYOUT");
  const canvas = {
    clientWidth: width,
    clientHeight: height,
    getBoundingClientRect: () => ({ width, height, right: width, bottom: height }),
  };
  return new Function(
    "GRAPH_LAYOUT",
    "GRAPH_CAMERA",
    "STAGE_ORDER",
    "layoutMode",
    "graph",
    "graphMinimap",
    "resolveNodeCardHeight",
    "resolveFanoutArrangement",
    `${helpers.map((name) => shippedHelper(html, name)).join("\n")}\nreturn { layoutGraph, graphRankById };`,
  )(
    layout,
    shippedConstant("GRAPH_CAMERA"),
    shippedConstant("STAGE_ORDER"),
    layout.defaultMode,
    canvas,
    null,
    resolveNodeCardHeight,
    resolveFanoutArrangement,
  );
}

const RANK_FIXTURE_WORKER = (id, second) => ({
  id,
  label: id.toUpperCase(),
  kind: "worker",
  firstAt: `2026-01-01T00:00:0${second}Z`,
});

/**
 * Five siblings under one hub, so the fanout branch takes the layout. This is
 * the shape a real governed run produces, and the shape a reporter complained
 * about: `d -> c -> b -> a` is a four-deep chain and `e` depends on nothing.
 *
 * `expectedRank` is the longest path to each node over containment and execution
 * together. Containment counts because a run whose only edges are `contains` --
 * the common case, and the case in the browser session that prompted this -- has
 * no other way to separate a hub from the work it holds.
 */
const RANK_FIXTURE_FANOUT = {
  label: "fanout",
  expectedRank: { p: 0, d: 1, e: 1, c: 2, b: 3, a: 4 },
  nodes: [
    { id: "p", label: "workflow", kind: "workflow" },
    RANK_FIXTURE_WORKER("a", 1),
    RANK_FIXTURE_WORKER("b", 2),
    RANK_FIXTURE_WORKER("c", 3),
    RANK_FIXTURE_WORKER("d", 4),
    RANK_FIXTURE_WORKER("e", 5),
  ],
  edges: [
    { id: "s1", from: "p", to: "a", kind: "contains" },
    { id: "s2", from: "p", to: "b", kind: "contains" },
    { id: "s3", from: "p", to: "c", kind: "contains" },
    { id: "s4", from: "p", to: "d", kind: "contains" },
    { id: "s5", from: "p", to: "e", kind: "contains" },
    { id: "x1", from: "d", to: "c", kind: "depends_on" },
    { id: "x2", from: "c", to: "b", kind: "depends_on" },
    { id: "x3", from: "b", to: "a", kind: "depends_on" },
  ],
};

/** The same dependency claim below `fanout.minimumChildren`, so the layered branch runs. */
const RANK_FIXTURE_LAYERED = {
  label: "layered",
  expectedRank: { p: 0, b: 1, e: 1, a: 2 },
  nodes: [
    { id: "p", label: "workflow", kind: "workflow" },
    RANK_FIXTURE_WORKER("a", 1),
    RANK_FIXTURE_WORKER("b", 2),
    RANK_FIXTURE_WORKER("e", 5),
  ],
  edges: [
    { id: "s1", from: "p", to: "a", kind: "contains" },
    { id: "s2", from: "p", to: "b", kind: "contains" },
    { id: "s5", from: "p", to: "e", kind: "contains" },
    { id: "x3", from: "b", to: "a", kind: "depends_on" },
  ],
};

test("places every node at the column its longest dependency path earns", () => {
  // Asserted at two canvases because rank is a property of the graph, not of the
  // viewport. The short one is what a browser actually reported for a 17-node run;
  // at that height a single card row barely fits, so any arrangement search is
  // under maximum pressure to wrap -- and wrapping must still not move a node out
  // of its rank band.
  //
  // Asserted with the edge array reversed as well, and that variant is the reason
  // the layered case is here at all. Its ranks come out right today, but only
  // because `contains` happens to precede `depends_on` in the fixture and the last
  // write to a single-parent map wins. Reverse the array and the chain collapses,
  // which makes edge order -- not the graph -- the thing that decides the picture.
  for (const canvas of [{ width: 1651, height: 900 }, { width: 1704, height: 476 }]) {
    const { layoutGraph } = graphLayoutHarness(canvas);
    for (const fixture of [RANK_FIXTURE_FANOUT, RANK_FIXTURE_LAYERED]) {
      for (const edgeOrder of ["declared", "reversed"]) {
        const where = `${fixture.label} at ${canvas.width}x${canvas.height} with ${edgeOrder} edges`;
        const result = layoutGraph({
          ...fixture,
          edges: edgeOrder === "declared" ? fixture.edges : [...fixture.edges].reverse(),
        });
        const placed = (id) => {
          const position = result.positions.get(id);
          assert.ok(position, `${id} must be placed in ${where}`);
          return position;
        };

        // Rank is monotone in x, which is the whole claim a left-to-right graph
        // makes. Equality is deliberately not required of a shared rank: a rank
        // wider than the canvas may wrap into more than one column, and demanding
        // one x would forbid the wrap rather than the wrong order.
        const ranked = Object.entries(fixture.expectedRank);
        for (const [earlier, earlierRank] of ranked) {
          for (const [later, laterRank] of ranked) {
            if (earlierRank >= laterRank) continue;
            assert.ok(
              placed(earlier).x < placed(later).x,
              `${where}: ${earlier} is rank ${earlierRank} and ${later} is rank ${laterRank}, so `
                + `x(${earlier})=${placed(earlier).x} must be below x(${later})=${placed(later).x}`,
            );
          }
        }

        // A column that stacks a rank has to keep its members apart, otherwise
        // ranking would trade a wrong order for unreadable overlap.
        const byColumn = new Map();
        for (const [id, position] of result.positions) {
          const column = byColumn.get(position.x) || [];
          column.push({ id, top: position.y, bottom: position.y + position.height });
          byColumn.set(position.x, column);
        }
        for (const [columnX, members] of byColumn) {
          const ordered = [...members].sort((left, right) => left.top - right.top);
          for (let index = 1; index < ordered.length; index += 1) {
            assert.ok(
              ordered[index].top >= ordered[index - 1].bottom,
              `${where}: column x=${columnX} overlaps ${ordered[index - 1].id} and ${ordered[index].id}`,
            );
          }
        }
      }
    }
  }
});

test("ranks each node one step past the deepest thing upstream of it", () => {
  // Exact ranks, which the placement test deliberately does not assert: it only
  // requires x to increase with rank, so that a rank too wide for the canvas may
  // still wrap. That leaves the arithmetic itself unguarded, and the arithmetic is
  // where the original defect lived -- a node took one more than *a* parent rather
  // than one more than its deepest predecessor.
  const { graphRankById } = graphLayoutHarness({ width: 1651, height: 900 });
  const rankOf = (nodes, edges) => Object.fromEntries(graphRankById(nodes, edges));
  const node = (id) => ({ id, label: id, kind: "worker" });

  // A diamond: `late` waits on both a one-hop and a two-hop path. Shortest path
  // would call it 2, and then it would sit level with the work it waits on.
  assert.deepEqual(
    rankOf(
      ["root", "quick", "slow", "slower", "late"].map(node),
      [
        { id: "e1", from: "root", to: "quick", kind: "contains" },
        { id: "e2", from: "root", to: "slow", kind: "contains" },
        { id: "e3", from: "slow", to: "slower", kind: "depends_on" },
        { id: "e4", from: "quick", to: "late", kind: "depends_on" },
        { id: "e5", from: "slower", to: "late", kind: "depends_on" },
      ],
    ),
    { root: 0, quick: 1, slow: 1, slower: 2, late: 3 },
    "a node waiting on two paths takes the longer one",
  );

  // Containment alone has to separate a hub from what it holds. A run whose only
  // edges are `contains` is the ordinary case, and ranking a subset of edge kinds
  // that excluded it would flatten every such run into one column.
  assert.deepEqual(
    rankOf(
      ["hub", "held"].map(node),
      [{ id: "e1", from: "hub", to: "held", kind: "contains" }],
    ),
    { hub: 0, held: 1 },
    "containment is an ordering claim like any other edge",
  );

  // An edge naming a node outside the set contributes nothing rather than
  // throwing, because the snapshot filter can drop a node an edge still names.
  assert.deepEqual(
    rankOf([node("kept")], [{ id: "e1", from: "dropped", to: "kept", kind: "depends_on" }]),
    { kept: 0 },
    "an edge from a node that was filtered out cannot raise a rank",
  );

  // A cycle has no rank. It must still render: returning something finite for
  // every node beats refusing to lay out a malformed projection.
  const cyclic = rankOf(
    ["x", "y"].map(node),
    [
      { id: "e1", from: "x", to: "y", kind: "depends_on" },
      { id: "e2", from: "y", to: "x", kind: "depends_on" },
    ],
  );
  assert.deepEqual(Object.keys(cyclic).sort(), ["x", "y"], "a cycle still ranks every node");
  for (const [id, rank] of Object.entries(cyclic)) {
    assert.ok(Number.isFinite(rank) && rank >= 0, `${id} must take a finite rank inside a cycle`);
  }
});

test("separates active pending work from inactive structural work and keeps the flow visible", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /node\?\.active === true[\s\S]*\["pending", "queued"\][\s\S]*return "queued"/u);
  assert.match(html, /node\?\.active !== true[\s\S]*\["pending", "queued"\][\s\S]*return "unreported"/u);
  assert.match(html, /node\.statusReason/u);
  assert.match(html, /node-task/u);
  assert.match(html, /card\.addEventListener\("click", \(event\) =>/u);
  // The stage rail must stay discoverable, but `open` in the markup was a height
  // decision taken without knowing the viewport: at 1024x768 it left the graph
  // canvas at 337px against a declared 360px floor. Assert the disclosure and the
  // control that expands it, not a hardcoded expanded state.
  //
  // A third assertion here used to match the name of a predicted viewport threshold
  // in the page source. That threshold is gone: the client now expands the rail,
  // forces layout, and reads the rendered canvas back. The claim it stood for --
  // that the expanded state answers to a budget rather than to markup -- is owned
  // by the two guards that run the shipped decision function against a short and a
  // roomy canvas. Restating it as a source-token match would put two guards on one
  // behaviour, and either could then be deleted without a red run.
  assert.match(html, /<details class="stage-overview" aria-label="Stage progress">/u);
  assert.match(html, /data-stage-rail-state="expand"/u);
});

test("keeps inspector provenance and replay navigation visible and keyboard reachable", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  for (const marker of [
    "data-live-selected-node-status",
    "data-live-selected-node-owner",
    "data-live-selected-node-runtime",
    "data-live-selected-node-summary",
    "data-live-selected-node-evidence-detail",
    "data-replay-prev",
    "data-replay-next",
    "data-replay-live",
    "Escape",
    "aria-selected",
  ]) {
    assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\[\]\\]/gu, "\\$&"), "u"), marker);
  }
  assert.match(html, /entry\.addEventListener\(["']keydown["'][\s\S]{0,450}selectNode\(item\.nodeId\)/u);
  assert.match(html, /replayFollowingLive/iu);
});

test("consumes bounded v2 agent, prompt, tool, provenance, and event facts with v1 fallbacks", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  for (const marker of [
    "data-live-selected-node-model",
    "data-live-selected-node-duration",
    "data-live-selected-node-tools",
    "data-live-selected-node-tokens",
    "data-live-selected-node-provenance",
    "data-live-selected-node-prompt",
    "data-live-session-list",
    "renderInspectorHistory",
    "graphNodesForSnapshot",
    "toolCalls",
    "triggerPromptId",
    "reasoningExcerpt",
    "terminalEvidence",
    "outputTokens",
    "latestTool",
  ]) {
    assert.match(html, new RegExp(marker, "u"), marker);
  }
  assert.match(html, /promptInput\.slice\(0, 256\)/u);
  assert.match(html, /toolCallInput\.slice\(0, 512\)/u);
  assert.match(html, /provenanceInput\.slice\(0, 256\)/u);
  assert.match(html, /replayInputEvents\.slice\(0, 512\)/u);
  assert.match(html, /node\.toolCount \+ " tools"[\s\S]{0,120}node\.latestTool/u);
  assert.match(html, /node\.outputTokens \+ " tok"/u);
  assert.match(html, /item\.dataset\.kind = event\.kind/u);
  assert.match(html, /data-kind="prompt"/u);
  assert.match(html, /data-kind="spawn"/u);
  assert.match(html, /data-tool-density/u);
});

test("renders only present capability truth as dynamic keyboard-accessible ports", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /makeElement\("div", "node-capability-strip"\)/u);
  assert.match(html, /const NODE_CAPABILITY_KINDS = \["agent", "skill", "mcp", "command", "runtime_tool", "hook", "plugin", "memory_graph", "dependency"\]/u);
  assert.match(html, /const capabilityLabels = \{ agent: "Agent", skill: "Skill", mcp: "MCP", command: "Command", runtime_tool: "Tool", hook: "Hook", plugin: "Plugin", memory_graph: "Memory\/Graph", dependency: "Dependency" \}/u);
  assert.match(html, /\(node\.capabilityTruth \|\| \[\]\)\.map\(\(truth\)/u);
  assert.match(html, /button\.dataset\.capabilityKind = record\.kind/u);
  assert.match(html, /button\.dataset\.capabilityState = record\.state/u);
  assert.match(html, /record\.state === "observed"[\s\S]*record\.state === "planned"[\s\S]*"未记录"/u);
  assert.match(html, /event\.stopPropagation\(\)[\s\S]*selectNode\(node\.id, \{ inspectorTab: record\.tab \}\)/u);
  assert.match(html, /\["mcp", "command", "runtime_tool", "hook"\]\.includes\(kind\)/u);
  assert.match(html, /\["memory_graph", "dependency"\]\.includes\(kind\)/u);
  assert.match(html, /normalizeNodeCapabilityTruth\(item, loadout\)/u);
  assert.match(html, /record\.state === "observed" && record\.observation === "trusted_host_evidence"/u);
  assert.match(html, /capabilityNames\(\[\.\.\.plannedNames, \.\.\.capabilityNames\(record\.actualNames\)\]\)/u);
  assert.match(html, /if \(!downgradedNames\.length && !actualNames\.length\) return \[\]/u);
  assert.match(html, /filter\(\(record\) => record\.count > 0 && \["observed", "planned"\]\.includes\(record\.state\)\)/u);
  assert.match(html, /if \(capabilityStrip\.childElementCount\) card\.append\(capabilityStrip\)/u);
  assert.doesNotMatch(html, /state:\s*usefulNodeMeta\(node\.agent\)\s*\?\s*"observed"/u);
  assert.match(html, /function selectNode\(nodeId, \{ focus = false, inspectorTab = null \} = \{\}\)/u);
  assert.match(html, /INSPECTOR_TABS\.includes\(inspectorTab\)/u);
  assert.match(html, /\.node-capability-strip\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(2,minmax\(0,1fr\)\)[^}]*overflow:\s*visible/su);
  assert.match(html, /\.node-capability:last-child:nth-child\(odd\)\s*\{\s*grid-column:\s*1\s*\/\s*-1;\s*\}/u);
  // `data-capability-count` and `data-has-capabilities` are gone. Both were
  // written on every card and read by nobody: no CSS rule, no client branch, no
  // acceptance script. `data-has-capabilities` did have one reader, a cell-mode
  // rule that exempted any node with capabilities from the reduced rendering and
  // drew it as a full 176px card -- which at the overview scale put ~4px text on
  // screen. That rule was the defect, so removing it left the attribute with no
  // reader at all, and a hook nobody reads is deleted with its write site rather
  // than kept as a hook somebody might read later.
  assert.doesNotMatch(html, /card\.dataset\.capabilityCount/u);
  assert.doesNotMatch(html, /card\.dataset\.hasCapabilities/u);
  assert.doesNotMatch(html, /data-has-capabilities/u);
  assert.match(html, /\.node-card\s*\{[^}]*max-height:\s*none[^}]*overflow:\s*visible/su);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*\.node-card[^}]*min-height:\s*166px !important/su);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*\.node-capability-strip\s*\{\s*grid-template-columns:\s*1fr/su);
  // The narrow-viewport override used to bump these lines to a literal 10px so
  // they stayed readable once the strip collapsed to one column. It now steps up
  // one semantic tier instead, which keeps the same intent without reintroducing
  // a size that cannot be ordered against the rest of the hierarchy.
  assert.match(html, /\.node-capability-kind, \.node-capability-value, \.node-capability-state \{ font-size: var\(--fs-entity-body\); \}/u);
});

test("adapts service field aliases and safely summarizes structured terminal evidence", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /const sessionCandidate = input\.sessionInfo \?\? input\.session/u);
  assert.match(html, /\["timestamp", "observedAt", "occurredAt", "createdAt"\]/u);
  assert.match(html, /\["startedAt", "occurredAt", "at", "timestamp"\]/u);
  assert.match(html, /function summarizeTerminalEvidence\(value\)/u);
  assert.match(html, /\["completed", "failed", "blocked"\]\.includes\(item\.status\)/u);
  assert.match(html, /trusted\.length \+ " terminal evidence/u);
  assert.match(html, /firstValue\(record, \["ownerBindingMode"\], ""\)/u);
  assert.match(html, /firstValue\(record, \["state", "status"\], ""\)/u);
  assert.doesNotMatch(html, /terminalEvidence:\s*display\(/u);
});

test("uses explicit marker colors so SVG arrows do not inherit an unreliable currentColor", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /markerColors\s*=\s*\{[\s\S]*running:\s*["']#58d4cf["'][\s\S]*completed:\s*["']#5b8cff["'][\s\S]*skipped:\s*["']#585858["']/u);
  assert.match(html, /marker-end["'],\s*["']url\(#\s*["']\s*\+\s*edgeMarkerId/u);
  assert.doesNotMatch(html, /fill["'],\s*["']currentColor["']/u);
});

test("makes aria-modal dialogs isolate the app, trap focus, and restore the opener", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /const FOCUSABLE_DIALOG_SELECTOR\s*=/u);
  assert.match(html, /function trapDialogFocus\(event\)[\s\S]{0,1200}event\.key !== "Tab"/u);
  assert.match(html, /event\.shiftKey[\s\S]{0,500}last\.focus\(\)/u);
  assert.match(html, /first\.focus\(\)/u);
  assert.match(html, /background\.inert\s*=\s*active/u);
  assert.match(html, /background\.setAttribute\("aria-hidden", "true"\)/u);
  assert.match(html, /restoreModalBackground\(\)/u);
  assert.match(html, /activeDialog\.contains\(document\.activeElement\)/u);
  assert.match(html, /dialogOpener\.focus\(\)/u);
  assert.match(html, /const hadOpenDialog\s*=\s*Boolean\(activeDialog\)/u);
  assert.match(html, /if \(!hadOpenDialog\) document\.activeElement\?\.blur\?\.\(\)/u);

  const {
    controller,
    document,
    skipLink,
    background,
    preservedBackground,
    sessionsDialog,
    first,
    last,
    FakeElement,
  } = modalBehaviorHarness();
  const opener = new FakeElement("opener");
  opener.focus();
  controller.setDialogOpen(sessionsDialog, true);

  assert.equal(controller.activeDialog(), sessionsDialog);
  assert.equal(sessionsDialog.hidden, false);
  assert.equal(sessionsDialog.getAttribute("aria-hidden"), "false");
  assert.equal(document.activeElement, first);
  for (const isolated of [skipLink, background, preservedBackground]) {
    assert.equal(isolated.inert, true, isolated.name);
    assert.equal(isolated.getAttribute("aria-hidden"), "true", isolated.name);
  }

  const tabEvent = (shiftKey = false) => ({
    key: "Tab",
    shiftKey,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  });
  last.focus();
  const forwardTab = tabEvent(false);
  controller.trapDialogFocus(forwardTab);
  assert.equal(forwardTab.defaultPrevented, true);
  assert.equal(document.activeElement, first);
  const reverseTab = tabEvent(true);
  controller.trapDialogFocus(reverseTab);
  assert.equal(reverseTab.defaultPrevented, true);
  assert.equal(document.activeElement, last);

  const escape = {
    key: "Escape",
    target: last,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  controller.keydownHandler()(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(controller.activeDialog(), null);
  assert.equal(sessionsDialog.hidden, true);
  assert.equal(sessionsDialog.getAttribute("aria-hidden"), "true");
  assert.equal(background.inert, false);
  assert.equal(background.getAttribute("aria-hidden"), null);
  assert.equal(skipLink.inert, false);
  assert.equal(skipLink.getAttribute("aria-hidden"), null);
  assert.equal(preservedBackground.inert, true);
  assert.equal(preservedBackground.getAttribute("aria-hidden"), "legacy");
  assert.equal(document.activeElement, opener);

  controller.setDialogOpen(sessionsDialog, true);
  controller.setDialogOpen(sessionsDialog, false);
  assert.equal(document.activeElement, opener);
  assert.equal(background.inert, false);
});

test("keeps the desktop workspace bounded and coalesces high-frequency snapshot updates", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /\.workspace-grid\s*\{[^}]*height:\s*100%[^}]*overflow:\s*hidden/su);
  assert.match(html, /\.evidence-panel\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/su);
  assert.match(html, /\.evidence-drawer\s*\{[^}]*overflow:\s*auto/su);
  assert.match(html, /graphMinimap\.hidden\s*=\s*!overflowing/u);
  assert.match(html, /SNAPSHOT_COALESCE_MS\s*=\s*75/u);
  assert.match(html, /scheduleSnapshotUpdate[\s\S]*snapshotCoalesceTimer[\s\S]*setTimeout/su);
  assert.match(html, /beforeunload[\s\S]*clearTimeout\(snapshotCoalesceTimer\)/su);
});

test("preserves real edge state without replay evidence and uses interactive list semantics", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /let replayState\s*=\s*edge\.status/u);
  assert.match(html, /if\s*\(!hasReplayState\)\s*replayState\s*=\s*edge\.status/u);
  assert.match(html, /data-live-node-list role="list"/u);
  assert.match(html, /setAttribute\(["']role["'],\s*["']listitem["']\)/u);
  assert.match(html, /makeElement\("button", "node-identity-row node-identity-button"\)/u);
  assert.match(html, /data-live-graph-follow[^>]+data-active="false"[^>]+aria-pressed="false"/u);
  assert.match(html, /if \(firstSnapshot\)[\s\S]{0,400}fitGraph\(\);/u);
  assert.doesNotMatch(
    html,
    /if \(firstSnapshot\)[\s\S]{0,400}setCameraMode\("overview"\)/u,
    "only fitGraph may claim overview, so the clipped flag is never overwritten with an unconditional true",
  );
  assert.doesNotMatch(html, /if \(firstSnapshot\)[\s\S]{0,800}centerGraphNode\(selectedNodeId\)/u);
  assert.doesNotMatch(html, /card\.setAttribute\(["']aria-pressed/u);
  assert.match(html, /replayPlay\.disabled\s*=\s*events\.length\s*<\s*2/u);
  assert.match(html, /columnGap\s*=\s*mode\.stageColumnGapPx/u);
  assert.match(html, /entityColumnStep\s*=\s*mode\.entityColumnStepPx/u);
  assert.match(html, /entityRowGap\s*=\s*mode\.entityRowGapPx/u);
  assert.match(html, /nextY\s*=\s*previousBottom\s*\+\s*GRAPH_LAYOUT\.renderedColumnGapPx/u);
  assert.match(html, /\.replay-panel\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%[^}]*grid-template-columns:\s*330px\s*minmax\(0,1fr\)[^}]*overflow:\s*hidden[^}]*contain:\s*inline-size/su);
  assert.match(html, /\.replay-dock-header\s*\{[^}]*min-width:\s*0[^}]*width:\s*330px[^}]*max-width:\s*100%[^}]*grid-template-columns:\s*minmax\(88px,1fr\)\s*auto[^}]*overflow:\s*hidden/su);
  assert.match(html, /\.replay-range-wrap\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%[^}]*overflow:\s*hidden/su);
  assert.match(html, /\.replay-track\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%[^}]*overflow:\s*hidden/su);
  assert.match(html, /grid-template-columns:\s*minmax\(0,300px\)\s*minmax\(0,1fr\)\s*minmax\(0,410px\)/su);
  assert.match(html, /\.replay-empty\s*\{[^}]*align-self:\s*end[^}]*height:\s*28px[^}]*min-height:\s*0[^}]*margin:\s*var\(--sp-band\)\s+0\s+0\s+calc\(100%\s*-\s*410px\)[^}]*overflow:\s*hidden/su);
  assert.match(html, /\.replay-current \.panel-note\s*\{[^}]*display:\s*none/su);
  assert.doesNotMatch(html, /\.workspace-grid\[data-inspector-open="true"\] \.replay-current\s*\{[^}]*display:\s*none/su);
  assert.equal(
    resolvedDeclaration(stylesheetRules(html), {
      selector: ".top-run-context",
      property: "display",
      condition: "@media (max-width: 720px)",
    }),
    "none",
    "the topbar run context has no room at handheld width",
  );
  assert.match(html, /data-live-open-sessions[\s\S]{0,500}data-live-language-toggle[\s\S]{0,500}data-live-open-help[\s\S]{0,500}data-live-open-info/u);
  assert.match(html, /\[data-live-graph-fit\], \[data-live-graph-layout\], \[data-live-graph-zoom-out\], \[data-live-graph-zoom-in\]\s*\{\s*display:\s*none/su);
  assert.match(html, /\.replay-events\s*\{[^}]*overflow-x:\s*auto[^}]*overflow-y:\s*hidden/su);
  assert.match(html, /scrollIntoView\?\.\(\{ behavior:\s*"auto", block:\s*"nearest", inline:\s*"nearest" \}\)/u);
  assert.match(html, /for \(const other of \[sessionsDialog, helpDialog, infoDialog\]\)/u);
  assert.match(html, /dialogOpener = document\.activeElement/u);
  assert.match(html, /dialogOpener\.focus\(\)/u);
  assert.match(html, /data-semantic-zoom="cell"\] \.node-card\s*\{[^}]*height:\s*140px[^}]*background:\s*transparent/su);
  assert.match(html, /class="status-bar"/u);
  assert.match(html, /\.activity-chips\s*\{[^}]*display:\s*flex/su);
  assert.match(html, /\.activity-chip\s*\{[^}]*min-width:\s*0/su);
  assert.match(html, /graph\.scrollTo\(\{[\s\S]{0,260}behavior:\s*reducedMotion\.matches\s*\?\s*"auto"\s*:\s*"smooth"/u);
});

test("keeps secondary Repository and Workspace surfaces in an on-demand keyboard menu", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /class="work-view-menu"/u);
  assert.match(html, /class="work-view-switcher" role="tablist" aria-label="Optional work surface views"/u);
  for (const view of ["repository", "workspace", "run"]) {
    assert.match(html, new RegExp(`role="tab"[^>]+data-live-work-view="${view}"`, "u"));
    assert.match(html, new RegExp(`data-live-${view === "run" ? "run" : view}-view`, "u"));
  }
  assert.match(html, /WORK_VIEW_STORAGE_KEY\s*=\s*"meta-kim-live-work-view-v3"/u);
  assert.match(html, /window\.sessionStorage\?\.getItem\(key\)/u);
  assert.match(html, /window\.localStorage\?\.getItem\(key\)/u);
  assert.match(html, /window\.sessionStorage\?\.setItem\(key, value\)/u);
  assert.match(html, /bindRovingTabs\(workViewTabs, WORK_VIEWS, setWorkView\)/u);
  assert.match(html, /\["ArrowLeft", "ArrowRight", "Home", "End"\]/u);
  assert.match(html, /setWorkView\(currentWorkView, \{ persist: false \}\)/u);
  assert.match(html, /params\.set\("projectId", selectedProjectId\)[\s\S]*params\.set\("runId", selectedRunId\)/u);
  assert.doesNotMatch(html, /worktree children|session worktree/iu);
});

test("renders repository and workspace facts without inventing unavailable source-control data", () => {
  const html = renderLiveControlRoomPage({
    snapshot: {
      ...snapshotFixture,
      repository: {
        name: { state: "observed", value: "Meta_Kim" },
        branch: { state: "observed", value: "codex/live-hub-canvas-first" },
      },
      workspace: {
        workspaceId: { state: "observed", value: "workspace-17" },
        transcript: { state: "unavailable", value: null },
        terminal: { state: "unavailable", value: null },
      },
    },
  });

  assert.match(html, /data-live-repository-title/u);
  assert.match(html, /data-live-repository-boundary/u);
  assert.match(html, /data-live-repository-sessions/u);
  assert.match(html, /Active workspace|Observed workspace/u);
  assert.match(html, /\["Branch", repository\.branch\]/u);
  assert.match(html, /\["Worktree", repository\.worktree\]/u);
  assert.match(html, /\["Pull request", repository\.pullRequest\]/u);
  assert.match(html, /\["Diff", repository\.diff\]/u);
  assert.match(html, /fact\?\.summary \|\| "Unavailable"/u);
  assert.match(html, /data-live-workspace-boundary/u);
  assert.match(html, /function renderWorkspaceSessions/u);
  assert.match(html, /function renderWorkspaceBoard/u);
  assert.match(html, /function renderWorkspaceDetail/u);
  assert.match(html, /workspaceColumnForStatus/u);
  assert.match(html, /legacy status-only record/u);
  assert.match(html, /snapshot\.repository\.diff\?\.state === "observed"/u);
  assert.match(html, /No deliverable or verification evidence is linked yet/u);
  assert.doesNotMatch(html, /repositoryInput\.(?:root|projectRoot|path)/u);
});

test("uses the execution flow as the default surface while preserving the workspace", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.match(html, /class="company-workspace"/u);
  assert.match(html, /class="company-session-rail"/u);
  assert.match(html, /class="company-board"/u);
  assert.match(html, /class="company-context-panel"/u);
  for (const hook of ["workspace-session-list", "workspace-board", "workspace-detail"]) {
    assert.match(html, new RegExp(`data-live-${hook}`, "u"));
  }
  assert.match(html, /currentWorkView\s*=\s*safeStoredChoice\(WORK_VIEW_STORAGE_KEY, WORK_VIEWS, "run"\)/u);
  assert.match(html, /aria-selected="true"[^>]*data-live-work-view="run"/u);
  assert.match(html, /data-live-workspace-view hidden/u);
  assert.match(html, /workspaceOpenRunMap\?\.addEventListener/u);
  assert.match(html, /New runs preserve that telemetry/u);
});

test("groups Inspector evidence into four bounded reference-aligned tabs and distinguishes planned context delivery", () => {
  const html = renderLiveControlRoomPage({
    snapshot: {
      ...snapshotFixture,
      contextTransfers: [{ id: "ctx-1", state: "planned", fromNodeId: "critical", toNodeId: "execution" }],
    },
  });

  assert.match(html, /class="inspector-tabs" role="tablist" aria-label="Inspector sections"/u);
  for (const tab of ["summary", "evidence", "terminal", "context"]) {
    assert.match(html, new RegExp(`data-live-inspector-tab="${tab}"`, "u"));
    assert.match(html, new RegExp(`data-live-inspector-panel="${tab}"`, "u"));
  }
  assert.match(html, /data-live-conversation-list/u);
  assert.match(html, /data-live-changes-list/u);
  assert.match(html, /data-i18n-zh="工具"/u);
  assert.match(html, /data-i18n-zh="决策"/u);
  assert.match(html, /contextTransferInput\.slice\(0, 256\)/u);
  assert.match(html, /\["observed", "accepted"\]\.includes\(rawState\) \? rawState : "planned"/u);
  assert.match(html, /nullableCount\(record\.summaryCount\)/u);
  assert.match(html, /planned · delivery not observed/u);
  assert.match(html, /entry\.dataset\.transferState = item\.transferState/u);
  assert.match(html, /entry\.dataset\.deliveryObserved = item\.transferState === "observed" \|\| item\.transferState === "accepted" \? "true" : "false"/u);
  assert.match(html, /\.evidence-item\[data-transfer-state="planned"\][^}]*border-left-style:\s*dashed/su);
  assert.doesNotMatch(html, /data-transfer-state="planned"[^}]*animation/isu);
  // The narrow band used to reflow the switcher into a topbar grid row. It is a
  // dropdown inside `<details>` now, so the contract is that the panel stays
  // anchored to its own trigger instead of stretching across the topbar.
  assert.match(html, /\.work-view-menu \.work-view-switcher\s*\{[^}]*top:\s*calc\(100% \+ \.45rem\)/su);
  assert.match(html, /html, body \{[^}]*overflow:\s*hidden/su);
});

test("annotates planned scheduling waves without turning them into edges or animation", () => {
  const html = renderLiveControlRoomPage({
    snapshot: {
      ...snapshotFixture,
      scheduling: {
        schemaVersion: "meta-kim-live-scheduling-v1",
        provenance: "observed",
        capacity: {
          maxParallelAgents: 2,
          requestedParallelAgents: 8,
          runtimeCapacity: 2,
          capacitySourceKind: "active_config",
          throttled: true,
        },
        waves: [
          { waveId: "wave-1", waveIndex: 1, mode: "primary_parallel_wave", declaredParallelCount: 2, nodeIds: ["critical", "execution"], mappedCount: 2, unmappedCount: 0, mergeOwner: "meta-conductor" },
          { waveId: "wave-2", waveIndex: 2, mode: "followup_parallel_wave", declaredParallelCount: 2, nodeIds: [], mappedCount: 0, unmappedCount: 2, mergeOwner: "meta-conductor" },
        ],
        waveCount: 2,
        declaredWaveCount: 2,
        coverage: { declaredTaskCount: 4, mappedNodeCount: 2, complete: false },
      },
    },
  });

  // The page re-pins provenance locally, so a payload claiming its wave order was
  // observed cannot relabel a declared plan on screen.
  assert.match(html, /provenance: "planned",/u);
  assert.doesNotMatch(html, /provenance: display\(/u);
  // The badge goes into the status strip, never into .node-meta: that row is
  // display:none in the card layout, so a wave annotation placed there would be
  // present in the DOM and invisible on screen.
  assert.match(html, /top\.append\(waveBadge\)/u);
  assert.doesNotMatch(html, /meta\.append\(wave/u);
  assert.match(html, /\.node-meta \{ display: none; \}/u);
  assert.match(html, /waveBadge\.dataset\.waveProvenance = "planned"/u);
  assert.match(html, /kind: "scheduling_wave"/u);
  assert.match(html, /kind: "scheduling_capacity"/u);
  assert.match(html, /planned · declared order, not observed execution/u);
  assert.match(html, /schedulingRows\.concat\(transfers\)/u);
  // Waves stay an annotation: no scheduling input reaches edge construction, and
  // the badge carries neither motion nor a box that could grow the card.
  assert.doesNotMatch(html, /graphEdgesForSnapshot\([^)]*scheduling/u);
  assert.match(html, /\.node-wave-badge \{[^}]*flex: 0 0 auto/su);
  assert.doesNotMatch(html, /\.node-wave-badge \{[^}]*(animation|border-width|border:)/su);
});

test("keeps the reference-inspired cool-tech surface restrained, stateful, and mobile-bounded", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const themeCss = html.slice(html.lastIndexOf(":root {"));
  const variable = (name) => themeCss.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "iu"))?.[1].toLowerCase();
  const pixelVariable = (name) => Number(themeCss.match(new RegExp(`--${name}:\\s*([0-9]+(?:\\.[0-9]+)?)px`, "iu"))?.[1]);
  const rgbToHsl = (hex) => {
    const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
    const maximum = Math.max(...channels);
    const minimum = Math.min(...channels);
    const lightness = (maximum + minimum) / 2;
    const saturation = maximum === minimum
      ? 0
      : (maximum - minimum) / (1 - Math.abs(2 * lightness - 1));
    return { saturation: saturation * 100 };
  };

  const completion = variable("completion");
  const completionBright = variable("completion-bright");
  const running = variable("running");
  const success = variable("green");
  const danger = variable("danger");
  assert.ok(completion && completionBright && running && success && danger, "the final theme must expose semantic color variables");
  assert.equal(completion, "#68a4ff", "completion must use the cool-blue state color");
  assert.equal(running, "#4fd1c5", "running must use the teal state color");
  assert.equal(new Set([completion, running, success, danger]).size, 4, "completion, running, success, and failed states need distinct colors");
  assert.doesNotMatch(html, /gold|#a68d5e|#cfbd96|#5a4b08|#e5c07b|#c8a96b|#d7af00|#f0d56a|#87d787/iu, "the full generated HTML and script must not retain gold names or warm completion swatches");
  assert.match(themeCss, /--accent:\s*#4fd1c5/iu);
  assert.match(themeCss, /\.node-running\s*\{[^}]*border-left-color:\s*var\(--running\)/su);
  assert.match(themeCss, /\.node-completed\s*\{[^}]*border-left-color:\s*var\(--green\)/su);
  assert.match(themeCss, /\.node-failed, \.node-in-doubt\s*\{[^}]*border-left-color:\s*var\(--danger\)/su);

  const pixelRadii = [...themeCss.matchAll(/border-radius:\s*([0-9]+(?:\.[0-9]+)?)px/giu)]
    .map((match) => Number(match[1]));
  assert.ok(pixelRadii.length > 0, "the final theme should declare a restrained radius hierarchy");
  assert.ok(Math.max(...pixelRadii) <= 12, "non-circular component radii must stay restrained");
  assert.ok(pixelVariable("radius-sm") <= 8 && pixelVariable("radius") <= 12, "theme radius tokens must stay restrained");

  assert.match(themeCss, /@media \(max-width: 720px\)[\s\S]*\.topbar\s*\{[^}]*grid-template-columns:\s*auto\s+minmax\(0,1fr\)\s+auto/su);
  assert.match(themeCss, /\.work-view-menu \.work-view-switcher\s*\{[^}]*width:\s*164px/su);
  assert.match(themeCss, /@media \(max-width: 720px\)[\s\S]*\.work-view-tab\s*\{[^}]*min-width:\s*0/su);
  assert.match(themeCss, /@media \(max-width: 720px\)[\s\S]*\.node-card\s*\{[^}]*width:\s*100%\s*!important/su);
  assert.match(themeCss, /@media \(max-width: 720px\)[\s\S]*\.graph-toolbar\s*\{[^}]*overflow-x:\s*auto/su);
  assert.match(themeCss, /\.inspector-tabs\s*\{[^}]*min-width:\s*0[^}]*overflow-x:\s*auto/su);
});

test("inactive legacy unknown nodes use the honest no-writeback label and human owner copy", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  assert.match(html, /state === "unknown" && node\?\.active !== true/u);
  assert.match(html, /normalizedRunDisplayState\(runInput/u);
  assert.match(html, /"未收到执行回写"/u);
  assert.match(html, /"角色 · "/u);
  assert.match(html, /"AI 执行者 · "/u);
  assert.doesNotMatch(html, /"专业 "/u);
  assert.match(html, /\.node-owner-line \{[^}]*display:\s*flex[^}]*gap:/su);
});

test("absent worker and event counts stay absent instead of collapsing to zero", () => {
  const { html, nullableCountOf } = sessionCopyHarness();
  assert.equal(nullableCountOf({}, ["workerCount", "agentCount", "nodeCount"]), null);
  assert.equal(nullableCountOf({ workerCount: null }, ["workerCount"]), null);
  assert.equal(nullableCountOf({ workerCount: "" }, ["workerCount"]), null);
  assert.equal(nullableCountOf({ workerCount: -3 }, ["workerCount"]), null);
  assert.equal(nullableCountOf({ workerCount: 1.5 }, ["workerCount"]), null);
  assert.equal(nullableCountOf({ workerCount: "not a number" }, ["workerCount"]), null);
  assert.equal(nullableCountOf({ workerCount: 0 }, ["workerCount"]), 0, "an observed zero is a real report and must survive");
  assert.equal(nullableCountOf({ workerCount: "7" }, ["workerCount"]), 7);
  assert.equal(nullableCountOf({ nodeCount: 4 }, ["workerCount", "nodeCount"]), 4);

  assert.match(html, /workerCount: nullableCountOf\(session, \["workerCount", "agentCount", "nodeCount"\]\)/u);
  assert.match(html, /eventCount: nullableCountOf\(session, \["eventCount", "totalEvents"\]\)/u);
  assert.match(html, /session\.workerCount === null \? "No worker report" : session\.workerCount \+ " workers"/u);
  assert.match(html, /session\.eventCount === null \? "No event report" : session\.eventCount \+ " events"/u);
  assert.match(html, /session\.workerCount === null \? "" : " · " \+ localize\(session\.workerCount \+ " workers"\)/u);
  assert.match(html, /"No worker report": "未收到执行者回报"/u);
  assert.match(html, /"No event report": "未收到事件回报"/u);
  assert.ok(html.includes(String.raw`/^(\d+) workers?$/u`), "the count sentence needs a Chinese branch or it ships as English");
  assert.ok(html.includes(String.raw`/^(\d+) events?$/u`), "the event sentence needs a Chinese branch or it ships as English");
});

// Every one of the sixteen "阶段未确认" rows in one profile held the `in_doubt`
// sentinel, so the sentinel filter itself has to keep working — the catalog now
// supplies a real stage, and the filter is what stops a machine word reaching the
// screen when it genuinely cannot.
test("machine sentinels never reach a session row, repository row, or run context", () => {
  const { html, displayFormat, informativeValue, sessionRowMeta } = sessionCopyHarness();
  for (const sentinel of displayFormat.nonInformativeValues) {
    assert.equal(informativeValue(sentinel, "Stage unconfirmed"), "Stage unconfirmed", sentinel + " must be treated as absent");
    assert.equal(informativeValue(sentinel.toUpperCase(), "Stage unconfirmed"), "Stage unconfirmed", sentinel + " must be filtered case-folded");
  }
  assert.equal(informativeValue("", "Stage unconfirmed"), "Stage unconfirmed");
  assert.equal(informativeValue(displayFormat.emptyPlaceholder, "Stage unconfirmed"), "Stage unconfirmed");
  assert.equal(informativeValue("Execution", "Stage unconfirmed"), "Execution", "a real stage must pass through untouched");

  const meta = sessionRowMeta({ active: false, substanceClass: "recorded", currentStage: "in_doubt", updatedAt: "2026-08-24T08:00:00.000Z" });
  assert.match(meta, /Stage unconfirmed/u);
  assert.doesNotMatch(meta, /in_doubt/u);
  assert.match(sessionRowMeta({ active: true, currentStage: "Execution", updatedAt: "" }), /^Running · Execution$/u, "an unobserved time must drop out of the row instead of printing a placeholder");

  assert.doesNotMatch(html, /setText\([A-Za-z]+, [^;]*, "in_doubt"\)/u, "no visible slot may fall back to a machine sentinel");
  assert.match(html, /setText\(contextStage, informativeValue\(snapshot\.run\.stage, "Stage unconfirmed"\)/u);
  assert.match(html, /localize\(informativeValue\(snapshot\.run\.stage, "Stage unconfirmed"\)\)/u);
  assert.match(html, /"Stage unconfirmed": "阶段未确认"/u);
});

// A run that executed, verified, and was then refused release is not a run whose
// state is unknown. Thirteen rows in one profile carry exactly that record and
// read "阶段未确认" anyway, so the row has to say what the record says.
// The catalog's verdict crosses five layers before it reaches a row, and each
// one drops fields it does not name. This is the last of them: the client
// sanitizer. Without the field here the row falls back to the raw status the
// server already judged incomplete, and the fix looks green in every unit test.
test("the client sanitizer carries the catalog's verdict instead of dropping it at the last layer", () => {
  const { html } = sessionCopyHarness();
  assert.match(
    html,
    /displayState:\s*display\(session\.displayState/u,
    "normalizeCatalog must keep displayState or the row re-derives an outcome from the raw status",
  );
});

test("a run row states the outcome its record proves instead of an unjudged state", () => {
  const { sessionStateCopy } = sessionCopyHarness();
  assert.equal(sessionStateCopy({ displayState: "partial" }), "已执行并验证 · 未达发布标准");
  assert.equal(sessionStateCopy({ displayState: "superseded" }), "被新任务替代");
  assert.equal(sessionStateCopy({ displayState: "archived_legacy" }), "早期版本的归档记录");
  assert.equal(sessionStateCopy({ displayState: "unreported" }), "未收到执行回写");
  assert.equal(
    sessionStateCopy({ displayState: "unknown" }),
    "记录不足以判断",
    "the only rows left saying nothing is known are the ones where nothing is",
  );
  // displayState is the judged field; a raw status must not outrank it.
  assert.equal(sessionStateCopy({ displayState: "partial", status: "in_doubt" }), "已执行并验证 · 未达发布标准");
  assert.equal(sessionStateCopy({ status: "partial" }), "已执行并验证 · 未达发布标准");
  // A row carrying no outcome at all must drop the segment, the same way an
  // unobserved timestamp already does. Printing a fallback word here would
  // invent a verdict for the one case where the record supplies none.
  assert.equal(sessionStateCopy({}), "", "a row with no recorded outcome must say nothing rather than guess one");
  assert.equal(sessionStateCopy({ displayState: "", status: "" }), "");
});

test("the run row carries its outcome, and every new label ships both languages", () => {
  const { html, sessionRowMeta } = sessionCopyHarness();
  const meta = sessionRowMeta({
    active: false,
    displayState: "partial",
    currentStage: "evolution",
    updatedAt: "2026-08-24T08:00:00.000Z",
  });
  assert.match(meta, /已执行并验证 · 未达发布标准/u, "the row must carry the outcome, not only the stage");

  // These labels are chosen by a language branch rather than the zhText map, so a
  // missing translation cannot throw — it silently ships English. Asserting both
  // sides of each branch is what makes the gap visible.
  for (const [zh, en] of [
    ["已执行并验证 · 未达发布标准", "Executed and verified · below release bar"],
    ["被新任务替代", "Replaced by a newer task"],
    ["早期版本的归档记录", "Archived record from an earlier version"],
    ["记录不足以判断", "Record is not enough to judge"],
    ["未记录运行来源", "Runtime not recorded"],
    ["这次运行没有保存聊天标识", "No chat id was saved for this run"],
    ["没有保存聊天标识的运行记录", "Run without a saved chat id"],
  ]) {
    assert.ok(
      html.includes(`"${zh}" : "${en}"`),
      `"${en}" needs a Chinese branch or the label ships untranslated`,
    );
  }
});

// 42 of 44 rows read "来源未知" while the runtime was recorded, and the two that
// truly had none said the same thing. The label has to separate "we did not read
// it" from "the record does not contain it".
test("an unrecorded runtime says the record is silent rather than that the source is unknown", () => {
  const { sourceRuntimeLabel } = sessionCopyHarness();
  assert.equal(sourceRuntimeLabel("claude"), "Claude Code");
  assert.equal(sourceRuntimeLabel("codex"), "Codex");
  assert.equal(sourceRuntimeLabel("unavailable"), "未记录运行来源");
  assert.equal(sourceRuntimeLabel(""), "未记录运行来源");
  assert.equal(sourceRuntimeLabel(undefined), "未记录运行来源");
});

// All 44 rows are genuinely unlinked: no record stored a conversation id, so no
// fix can back-fill one. What the copy owes the reader is why the link is absent.
// The producer now writes real links, so the page has to be able to show one.
// Asserting only that an unlinked row says "unlinked" is vacuous — it stays green
// with the whole verified branch deleted. What has to hold is that the two rows
// read differently on every surface that carries link state.
test("a verified run reads differently from an unlinked one on every surface that carries link state", () => {
  const { conversationLinkCopy, sessionDisplayTitle, sessionIsIdentified, sessionGroups } = sessionCopyHarness();
  const verified = {
    runId: "run-verified-0001",
    title: "Run ABCD1234",
    titleSource: "generated_run_id",
    conversationLinkState: "verified",
    conversationRef: "conv-9f2c",
    substanceClass: "substantive",
    updatedAt: "2026-09-01T15:15:00.000Z",
  };
  const unlinked = {
    runId: "run-unlinked-0001",
    title: "Run EFGH5678",
    titleSource: "generated_run_id",
    conversationLinkState: "unlinked",
    substanceClass: "substantive",
    updatedAt: "2026-09-01T15:16:00.000Z",
  };

  assert.notEqual(
    conversationLinkCopy(verified.conversationLinkState),
    conversationLinkCopy(unlinked.conversationLinkState),
    "a stored link and an absent one must not print the same sentence",
  );
  assert.equal(conversationLinkCopy(verified.conversationLinkState), "已确认关联");

  // A generated run id is the same on both rows, so identity has to come from the
  // link rather than from the title, or a real link changes nothing on screen.
  assert.equal(sessionIsIdentified(verified), true, "a verified link identifies a run even under a generated title");
  assert.equal(sessionIsIdentified(unlinked), false);
  assert.notEqual(
    sessionDisplayTitle(verified),
    sessionDisplayTitle(unlinked),
    "a verified run must not be titled as one with no saved chat id",
  );

  // The unlinked group is what the footer folds away. A verified run landing in
  // it would be hidden by default despite having exactly the fact the fold is for.
  const groups = sessionGroups([unlinked, verified]);
  assert.deepEqual(groups.foreground.map((session) => session.runId), ["run-verified-0001"]);
  assert.deepEqual(groups.background.map((session) => session.runId), ["run-unlinked-0001"]);
});

test("an unlinked run names the missing chat id rather than implying a lost link", () => {
  const { conversationLinkCopy, sessionDisplayTitle } = sessionCopyHarness();
  assert.equal(conversationLinkCopy("verified"), "已确认关联");
  assert.equal(conversationLinkCopy("candidate"), "可能相关 · 未验证");
  assert.equal(conversationLinkCopy("unlinked"), "这次运行没有保存聊天标识");
  assert.equal(
    sessionDisplayTitle({ title: "Run ABCD1234", titleSource: "generated_run_id" }),
    "没有保存聊天标识的运行记录",
  );
  assert.equal(
    sessionDisplayTitle({ title: "Close the display honesty gap", identificationState: "descriptive" }),
    "Close the display honesty gap",
    "a run that named itself keeps its own title",
  );
});

// The hook records why a binding was refused, and every unlinked row printed the
// same sentence regardless. "The transcript file was deleted" and "no chat id was
// ever recorded" send a reader to completely different places, so a row that
// carries a reason has to print that reason instead of the generic fallback.
test("an unlinked row prints the recorded reason instead of the generic sentence", () => {
  const { conversationLinkCopy, refusalText } = sessionCopyHarness();
  const generic = conversationLinkCopy("unlinked");

  const missingFile = conversationLinkCopy("unlinked", "transcript_file_absent");
  assert.equal(missingFile, refusalText.transcript_file_absent);
  assert.notEqual(missingFile, generic, "a recorded reason must replace the fallback, not read the same as it");

  const noChatId = conversationLinkCopy("unlinked", "conversation_id_not_identified");
  assert.notEqual(
    noChatId,
    missingFile,
    "a deleted transcript and a chat id that was never recorded must not read identically",
  );

  // Every reason the vocabulary can carry has to reach the reader; one missing
  // entry silently falls back and looks exactly like a run with no reason at all.
  for (const [reason, sentence] of Object.entries(refusalText)) {
    assert.equal(conversationLinkCopy("unlinked", reason), sentence, `${reason} must print its own sentence`);
  }

  assert.equal(
    conversationLinkCopy("unlinked", "some_reason_this_build_never_declared"),
    generic,
    "a reason this build does not understand falls back rather than printing a raw token",
  );
  assert.equal(
    conversationLinkCopy("verified", "transcript_file_absent"),
    "已确认关联",
    "a confirmed link never explains itself away with a stale refusal",
  );
});

// A refusal is only written when a binding was attempted, so every record older
// than that hook has none and prints the generic sentence. The catalog does know
// something about those runs: whether the tool was ever identified at all. 86 of
// 103 real records were never able to name a tool, which is a different problem
// from a run whose tool is known but saved no chat id, and the generic sentence
// collapsed both into one unactionable line.
test("an unlinked row with no refusal still says how far the lookup got", () => {
  const { conversationLinkCopy, refusalText, discoveryText } = sessionCopyHarness();
  assert.ok(discoveryText, "the shipped script must embed a sentence for every discovery reason");
  const generic = conversationLinkCopy("unlinked");

  const noSource = conversationLinkCopy("unlinked", null, { state: "unsupported", reason: "no_safe_runtime_metadata_source" });
  assert.equal(noSource, discoveryText.no_safe_runtime_metadata_source);
  assert.notEqual(noSource, generic, "a recorded discovery reason must replace the fallback, not read the same as it");

  const runBound = conversationLinkCopy("unlinked", null, { state: "metadata_only", runtime: "claude", reason: "run_bound_metadata_only" });
  assert.equal(runBound, discoveryText.run_bound_metadata_only);
  assert.notEqual(runBound, noSource, "a tool that was never identified and one that was must not read identically");

  for (const [reason, sentence] of Object.entries(discoveryText)) {
    assert.equal(conversationLinkCopy("unlinked", null, { reason }), sentence, `${reason} must print its own sentence`);
  }

  // The refusal names the step that failed; discovery only names how far the
  // lookup could reach. When a run carries both, the more specific one wins.
  assert.equal(
    conversationLinkCopy("unlinked", "transcript_file_absent", { reason: "no_safe_runtime_metadata_source" }),
    refusalText.transcript_file_absent,
    "a recorded refusal must outrank the coarser discovery reason",
  );

  assert.equal(
    conversationLinkCopy("unlinked", null, { reason: "a_reason_this_build_never_declared" }),
    generic,
    "a reason this build does not understand falls back rather than printing a raw token",
  );
  assert.equal(
    conversationLinkCopy("unlinked", null, null),
    generic,
    "a record with no discovery block at all still gets the generic sentence",
  );
  assert.equal(
    conversationLinkCopy("verified", null, { reason: "no_safe_runtime_metadata_source" }),
    "已确认关联",
    "a confirmed link never explains why it could not be found",
  );
});

// The reason is useless if the row never receives it. `normalizeCatalog` rebuilds
// every session from the wire, so a field it does not copy is gone before any
// renderer runs, and the row falls back to the generic sentence exactly as if the
// server had never sent one.
test("the client keeps the discovery reason the server allow-list already ships", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const normalize = new Function(
    "safeIdentifier",
    "display",
    "firstValue",
    "nullableCountOf",
    "generatedRunTitle",
    "sessionRecordOrigin",
    "projectSelectionRow",
    "compareSelectionRows",
    "DEFAULT_SELECTION",
    `${shippedHelper(html, "normalizeCatalog")}
      return normalizeCatalog;
    `,
  )(
    (value) => (typeof value === "string" && value ? value : ""),
    (value, fallback = "") => (value === undefined || value === null || value === "" ? fallback : String(value)),
    (source, keys, fallback = "") => {
      for (const key of keys) if (source?.[key]) return source[key];
      return fallback;
    },
    () => null,
    () => false,
    () => "governed_run",
    (project) => ({ project }),
    () => 0,
    {},
  );

  const catalog = normalize({
    projects: [{
      projectId: "project-a",
      sessions: [{
        sessionId: "s-1",
        runId: "run-1",
        conversationLinkState: "unlinked",
        conversationDiscovery: { state: "unsupported", reason: "no_safe_runtime_metadata_source" },
      }],
    }],
  });

  assert.equal(
    catalog.projects[0].sessions[0].conversationDiscovery?.reason,
    "no_safe_runtime_metadata_source",
    "the discovery reason was dropped in normalization, so no renderer can ever show it",
  );
});

/**
 * Build `normalizeSnapshot` out of the shipped script. Two separate defects live
 * in this one function — a dropped discovery reason and a dropped chat id — and
 * both are proved by evaluating it, so the build is shared instead of copied.
 * Only stage helpers that are themselves under test elsewhere are stubbed; the
 * value helpers are sliced from the real script so a normalizer that starts
 * depending on a new one fails here instead of silently reading undefined.
 */
function runNormalizerHarness() {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const displayFormat = JSON.parse(html.match(/const DISPLAY_FORMAT = (\{.*?\});\n/su)[1]);
  const stubs = {
    normalizedStatus: () => "in_doubt",
    normalizedRunDisplayState: () => "in_doubt",
    normalizedNodeStatus: () => "in_doubt",
    normalizedAvailability: () => ({}),
    normalizeControlConfig: () => ({}),
    normalizeScheduling: () => null,
    normalizeNodeCapabilityTruth: () => ({}),
    summarizeTerminalEvidence: () => null,
    capabilityNames: () => [],
  };
  const stubNames = Object.keys(stubs);
  const normalizeSnapshot = new Function(
    "DISPLAY_FORMAT",
    ...stubNames,
    `${["normalizeSnapshot", "display", "firstValue", "numberOr", "nullableCount", "safeIdentifier"].map((name) => shippedHelper(html, name)).join("\n")}
      return normalizeSnapshot;
    `,
  )(displayFormat, ...stubNames.map((name) => stubs[name]));
  return normalizeSnapshot;
}

/**
 * The run header reads a snapshot this normalizer rebuilds field by field, and it
 * did not name `conversationDiscovery` — so the field the service now emits was
 * gone before `updateHeader` ran, and the header fell back to the generic
 * sentence while the session card printed the reason. Same shape of defect as the
 * catalog case above, on the other of the two surfaces.
 */
test("the client keeps the discovery reason on the run the header renders", () => {
  const normalizeSnapshot = runNormalizerHarness();
  const fromRun = normalizeSnapshot({
    run: {
      runId: "run-1",
      conversationLinkState: "unlinked",
      conversationDiscovery: { state: "metadata_only", runtime: "claude", reason: "run_bound_metadata_only" },
    },
  });
  assert.equal(
    fromRun.run.conversationDiscovery?.reason,
    "run_bound_metadata_only",
    "the header's own run object lost the reason, so only the session card can explain the row",
  );

  // The snapshot's session projection carries the same fact, and a run object
  // enriched from the selected session arrives without it, so the fallback is
  // what keeps a partially-enriched snapshot from reading as no reason at all.
  const fromSession = normalizeSnapshot({
    run: { runId: "run-1" },
    session: { conversationDiscovery: { state: "unsupported", reason: "no_safe_runtime_metadata_source" } },
  });
  assert.equal(fromSession.run.conversationDiscovery?.reason, "no_safe_runtime_metadata_source");

  assert.equal(
    normalizeSnapshot({ run: { runId: "run-1" } }).run.conversationDiscovery,
    null,
    "a record with no discovery block must stay absent rather than gain an empty one",
  );
});

/**
 * `/api/snapshot` ships `run.conversationRef`, and this normalizer copied five
 * conversation fields without it — so the chat id was gone before the header
 * rendered, and the header could only ever print the verdict, never the chat the
 * verdict is about. Same dropped-field defect as the discovery reason above.
 */
test("the client keeps the chat id the server already ships on the run", () => {
  const normalizeSnapshot = runNormalizerHarness();

  const fromRun = normalizeSnapshot({
    run: {
      runId: "run-1",
      conversationLinkState: "verified",
      conversationRef: "b5799d00-ef7a-4882-818d-d9053cacba71",
      conversationTitle: "Live control room closure",
    },
  });
  assert.equal(
    fromRun.run.conversationRef,
    "b5799d00-ef7a-4882-818d-d9053cacba71",
    "the header's own run object lost the chat id, so a confirmed link cannot name what it found",
  );
  assert.equal(fromRun.run.conversationTitle, "Live control room closure");

  // A run object enriched from the selected session arrives without the id, and
  // the session projection carries the same fact, so the fallback is what keeps a
  // partially-enriched snapshot from reading as a link with nothing behind it.
  const fromSession = normalizeSnapshot({
    run: { runId: "run-1", conversationLinkState: "verified" },
    session: { conversationRef: "18f2a4c1-2b77-4d0e-9a55-6c1de4477f01" },
  });
  assert.equal(fromSession.run.conversationRef, "18f2a4c1-2b77-4d0e-9a55-6c1de4477f01");

  assert.strictEqual(
    normalizeSnapshot({ run: { runId: "run-1" } }).run.conversationRef,
    "",
    "a run that was never bound must stay empty rather than gain a placeholder id",
  );
  // This value reaches the DOM, so it goes through the same identifier gate as
  // every other id on the page rather than being trusted because the server sent it.
  assert.strictEqual(
    normalizeSnapshot({ run: { runId: "run-1", conversationRef: "b5799d00\nef7a" } }).run.conversationRef,
    "",
    "a chat id carrying control characters must be dropped, not rendered",
  );
});

/**
 * "已确认关联" on its own is a claim the reader cannot check. Measured on the
 * running hub: the one verified row of 21 rendered no chat id anywhere on the page
 * and exposed nothing to click, so the only way to see which chat had been found
 * was to read the projection off disk — which is why a working link still read as
 * broken. This helper is what makes the verdict falsifiable on screen.
 */
test("a confirmed chat link names the chat it points at", () => {
  const { html, conversationChatIdentityCopy, conversationLinkCopyFor } = sessionCopyHarness();

  const verified = { conversationLinkState: "verified", conversationRef: "b5799d00-ef7a-4882-818d-d9053cacba71" };
  const identity = conversationChatIdentityCopy(verified);
  assert.ok(
    identity.includes("b5799d00"),
    "the verdict is unfalsifiable while the chat id it claims to have found appears nowhere",
  );
  assert.notEqual(
    identity,
    conversationLinkCopyFor(verified),
    "the id and the verdict are different facts, so one must not be printed in place of the other",
  );
  // Without this the helper could return a fixed string and still satisfy the
  // assertion above, which is exactly the unfalsifiable label it replaces.
  assert.notEqual(
    conversationChatIdentityCopy({ conversationLinkState: "verified", conversationRef: "18f2a4c1-2b77-4d0e-9a55-6c1de4477f01" }),
    identity,
    "two runs bound to different chats must not print the same id",
  );

  assert.equal(
    conversationChatIdentityCopy({ conversationLinkState: "candidate", conversationRef: "b5799d00-ef7a-4882-818d-d9053cacba71" }),
    identity,
    "an unverified match is the case a reader most needs to check, so it names its chat too",
  );

  // A state saying verified with no id behind it is the same uncheckable claim one
  // layer down, so it prints nothing rather than a placeholder that looks like an id.
  assert.strictEqual(conversationChatIdentityCopy({ conversationLinkState: "verified", conversationRef: "" }), "");
  assert.strictEqual(conversationChatIdentityCopy({ conversationLinkState: "unlinked", conversationRef: "b5799d00-ef7a" }), "");
  assert.strictEqual(conversationChatIdentityCopy(null), "");

  const declaration = /^\s*function /u;
  const callSites = [...html.matchAll(/[^\n]*\bconversationChatIdentityCopy\(/gu)]
    .filter((match) => !declaration.test(match[0]));
  assert.ok(
    callSites.length >= 2,
    "both surfaces that print the verdict must also print the id, or one of them keeps the unfalsifiable label",
  );
});

/**
 * Printing a shortened id makes the verdict visible but still not checkable: the
 * displayed form drops most of the characters, so a reader who wants to open the
 * chat the run claims to have found has nothing to search with. The page must be
 * able to hand over the whole id, and the shortened label must not be what it
 * hands over — those are the two ways this closes and the two ways it regresses.
 */
test("a confirmed chat link hands over the whole id it claims to have found", async () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  // Sliced on its own rather than through the shared harness so a missing helper
  // reds here instead of in every test that builds session copy.
  const chatIdentityValue = new Function(
    shippedHelper(html, "conversationChatIdentityValue") + "\nreturn conversationChatIdentityValue;",
  )();

  const full = "b5799d00-ef7a-4882-818d-d9053cacba71";
  assert.strictEqual(
    chatIdentityValue({ conversationLinkState: "verified", conversationRef: full }),
    full,
    "the copyable value must be the whole chat id, not the shortened form already on screen",
  );
  assert.strictEqual(
    chatIdentityValue({ conversationLinkState: "candidate", conversationRef: "  " + full + "  " }),
    full,
    "a stored id with surrounding whitespace still identifies one chat, so it hands over the trimmed id",
  );

  const { conversationChatIdentityCopy } = sessionCopyHarness();
  const label = conversationChatIdentityCopy({ conversationLinkState: "verified", conversationRef: full });
  assert.ok(
    label !== "" && !label.includes(full),
    "the visible label is lossy on purpose; if it already carried the whole id there would be nothing to hand over",
  );

  // Same absence rules as the label: no state to check, or no id behind the
  // state, means there is nothing to copy rather than something empty to copy.
  assert.strictEqual(chatIdentityValue({ conversationLinkState: "verified", conversationRef: "" }), "");
  assert.strictEqual(chatIdentityValue({ conversationLinkState: "unlinked", conversationRef: full }), "");
  assert.strictEqual(chatIdentityValue({ conversationLinkState: "verified", conversationRef: { id: full } }), "");
  assert.strictEqual(chatIdentityValue(null), "");

  const declaration = /^\s*function /u;
  const valueCallSites = [...html.matchAll(/[^\n]*\bconversationChatIdentityValue\(/gu)]
    .filter((match) => !declaration.test(match[0]));
  assert.ok(
    valueCallSites.length >= 2,
    "the whole id has to reach both the copy control and the card, or one surface keeps only the shortened form",
  );

  assert.match(
    html,
    /data-live-context-chat-copy/u,
    "the run header needs a real control to activate; a hover title is neither keyboard reachable nor copyable",
  );

  // Executed rather than pattern-matched: what has to hold is that activating the
  // control puts the whole id on the clipboard, and a regex over the call would
  // pass just as happily if the shortened label were handed over instead.
  const copyStart = html.indexOf("  async function copyChatIdentity()");
  assert.ok(copyStart >= 0, "copyChatIdentity() must remain in the shipped script");
  const copyEnd = html.indexOf("\n  async function ", copyStart + 1);
  assert.ok(copyEnd > copyStart, "copyChatIdentity() must be followed by another shipped helper");
  const written = [];
  const runCopy = new Function(
    "conversationChatIdentityValue",
    "currentSnapshot",
    "navigator",
    "liveRegion",
    "localize",
    html.slice(copyStart, copyEnd) + "\nreturn copyChatIdentity;",
  )(
    chatIdentityValue,
    { run: { conversationLinkState: "verified", conversationRef: full } },
    { clipboard: { writeText: (value) => { written.push(value); return Promise.resolve(); } } },
    null,
    (value) => value,
  );
  await runCopy();
  assert.deepEqual(
    written,
    [full],
    "activating the control must copy the whole chat id, not the shortened form the row displays",
  );
});

/**
 * Three call sites print this one fact — the run header, the session card's
 * activity line, and the card's meta row. Each used to assemble the arguments
 * itself, and the header passed two of the three: measured on the real
 * repository, 42 of 46 rows said "only the run record was checked" in the list
 * and "no chat id was saved for this run" in the header of the same run.
 *
 * Equal output for equal input is not enough to guard that, because the defect
 * was an argument a caller never passed. What closes it is leaving exactly one
 * place that can pass arguments at all.
 */
test("one wrapper is the only caller allowed to assemble the chat-state sentence", () => {
  const { html, conversationLinkCopy, conversationLinkCopyFor, discoveryText } = sessionCopyHarness();
  const record = {
    conversationLinkState: "unlinked",
    conversationLinkRefusal: "",
    conversationDiscovery: { state: "metadata_only", runtime: "claude", reason: "run_bound_metadata_only" },
  };
  assert.equal(
    conversationLinkCopyFor(record),
    discoveryText.run_bound_metadata_only,
    "the wrapper dropped the discovery block, so every surface reading through it prints the fallback",
  );
  assert.notEqual(
    conversationLinkCopyFor(record),
    conversationLinkCopy("unlinked"),
    "the wrapper's sentence must differ from the generic one, or this test cannot see the defect",
  );
  assert.equal(conversationLinkCopyFor(null), conversationLinkCopy("unlinked"));

  const declaration = /^\s*function /u;
  const callsOf = (name) => [...html.matchAll(new RegExp(`[^\\n]*\\b${name}\\(`, "gu"))]
    .filter((match) => !declaration.test(match[0]));

  // Without this, a build where nothing calls the wrapper would satisfy the
  // assertion below: with no call sites left there is nothing to get wrong, and
  // "one raw call" would be the wrapper's own line talking to itself.
  assert.ok(
    callsOf("conversationLinkCopyFor").length >= 1,
    "nothing calls the wrapper, so the assertion below is the wrapper describing itself",
  );
  assert.deepEqual(
    callsOf("conversationLinkCopy").map((match) => match[0].trim()),
    ["return conversationLinkCopy("],
    "a surface calls the raw helper directly, so it can forget an argument again",
  );
});

test("the hidden-record footer names both reasons a record is folded away", () => {
  const { html, sessionGroups } = sessionCopyHarness();

  // The fold is about substance as well as identity, so a chat-linked run can
  // land in it. Measured on the running hub: one of 27 folded records carried a
  // verified link while the footer told the user all 27 had no chat id, which is
  // the exact reading that makes a working link look broken.
  const linkedActivation = {
    runId: "run-linked-activation",
    title: "Run 33907331",
    titleSource: "generated_run_id",
    conversationLinkState: "verified",
    substanceClass: "activation_only",
    updatedAt: "2026-09-01T22:56:30.447Z",
  };
  assert.deepEqual(
    sessionGroups([linkedActivation]).background.map((session) => session.runId),
    ["run-linked-activation"],
    "a linked activation-only run still folds away, so the footer cannot blame a missing chat id",
  );

  assert.match(html, /条只登记了启动或没有聊天关联的运行记录（默认收起）/u);
  assert.match(html, /runs that only recorded an activation or have no chat link, hidden by default/u);
  assert.doesNotMatch(
    html,
    /条没有保存聊天标识的运行记录（默认收起）/u,
    "the footer must not claim every folded record lacks a chat id",
  );

  // The same claim reaches the user through the no-foreground empty state, which
  // folds the same mixed group behind its own reveal.
  assert.match(html, /条次要运行记录/u);
  assert.doesNotMatch(
    html,
    /条未关联历史记录/u,
    "the empty-state reveal must describe the same group as the footer",
  );
});

// A run the panel lists first and a run the panel opens are decided by two
// different comparators: the list order is hand-written here, while the run that
// actually opens goes through the configured default-selection policy. They agree
// on the terms both happen to carry and disagree on every term only one of them
// has, so the panel can open a run that is not the row at the top of its own list.
test("the run listed first is the run the page opens", () => {
  const { html, sessionGroups } = sessionCopyHarness();
  const policyLiteral = html.match(/const DEFAULT_SELECTION = (\{.*?\});\n/su);
  assert.ok(policyLiteral, "the shipped script must embed the default-selection policy it ranks with");
  const policy = JSON.parse(policyLiteral[1]);

  // Identical provenance, identical drawability class, both identified: the only
  // term left to separate them is one the two comparators do not share.
  const sessions = [
    {
      runId: "idle-newer",
      title: "Rebuild the canvas",
      identificationState: "descriptive",
      substanceClass: "recorded",
      nodeCount: 5,
      active: false,
      updatedAt: "2026-08-24T10:00:00.000Z",
    },
    {
      runId: "active-older",
      title: "Ship the spine",
      identificationState: "descriptive",
      substanceClass: "recorded",
      nodeCount: 5,
      active: true,
      updatedAt: "2026-08-24T08:00:00.000Z",
    },
  ];

  // Hard-written from config/live/default-selection.json, where `active` precedes
  // `recency`. Reading the expected order back off either comparator would pass
  // while both of them rank a stale run above a live one.
  assert.deepEqual(
    sessionGroups(sessions).ordered.map((session) => session.runId),
    ["active-older", "idle-newer"],
    "a live run must be listed above a stale one that merely recorded more recently",
  );

  const opened = pickDefaultRow(sessions.map((session) => sessionSelectionRow(session)), policy);
  assert.equal(
    sessionGroups(sessions).ordered[0].runId,
    opened.session.runId,
    "the row the panel puts first must be the row the panel opens",
  );
});

test("one ordering rule puts substantive identified runs first and collapses the rest", () => {
  const { html, sessionGroups } = sessionCopyHarness();
  const sessions = [
    { runId: "a", title: "run-a", titleSource: "generated_run_id", substanceClass: "activation_only", updatedAt: "2026-08-24T09:00:00.000Z" },
    { runId: "b", title: "Ship the spine", identificationState: "descriptive", substanceClass: "recorded", updatedAt: "2026-08-24T08:00:00.000Z" },
    { runId: "c", title: "Rebuild the canvas", identificationState: "descriptive", substanceClass: "recorded", updatedAt: "2026-08-24T08:30:00.000Z" },
    { runId: "d", title: "run-d", titleSource: "generated_run_id", substanceClass: "recorded", updatedAt: "2026-08-24T10:00:00.000Z" },
    { runId: "e", title: "run-e", titleSource: "generated_run_id", substanceClass: "recorded", updatedAt: "2026-08-24T07:00:00.000Z" },
    { runId: "f", title: "Activate the hub", identificationState: "descriptive", substanceClass: "activation_only", updatedAt: "2026-08-24T11:00:00.000Z" },
  ];
  const groups = sessionGroups(sessions);
  // The newest record is an activation-only one, so recency alone and identity
  // alone both produce a different order than substance-first does.
  assert.deepEqual(groups.ordered.map((session) => session.runId), ["c", "b", "d", "e", "f", "a"]);
  assert.deepEqual(groups.foreground.map((session) => session.runId), ["c", "b"]);
  assert.deepEqual(groups.background.map((session) => session.runId), ["d", "e", "f", "a"]);
  assert.equal(groups.ordered.length, groups.foreground.length + groups.background.length, "grouping must partition, not drop");
  assert.deepEqual(sessionGroups(undefined).ordered, [], "an absent list must not throw");
  assert.notStrictEqual(sessionGroups(sessions).ordered, sessions, "ordering must not sort the caller's array in place");

  assert.match(html, /groups\.foreground\.forEach\(\(session\) => appendSessionRow\(repositorySessions, session\)\)/u);
  // The guard must short-circuit, but how many statements share the branch is a
  // formatting detail this test has no business pinning.
  assert.match(html, /if \(!groups\.background\.length\)[\s\S]{0,120}?return;/u);
  assert.match(html, /"Background run records": "次要运行记录"/u);
});

// A projection built from an acceptance fixture reaches the browser through the
// same catalog as a real run and is shaped the same way, so nothing on screen
// separates them unless the declared origin is both carried through the client
// rebuild and shown on the row. Measured on this repo before the contract
// existed: the only two of 44 rows carrying worker counts and a resolved runtime
// were both fixtures, so they rendered as the two healthiest rows in the panel.
test("a fixture record reaches the browser labelled and never outranks a real run", () => {
  const { html, originText, sessionRecordOrigin, sessionOriginCopy, sessionGroups } = sessionCopyHarness();
  assert.deepEqual(
    Object.keys(originText).sort(),
    [...LIVE_RECORD_ORIGINS].sort(),
    "an origin with no shipped copy renders as an unmarked row, which asserts the record is real",
  );
  assert.equal(originText.governed_run, "", "badging a real run would make the badge stop meaning anything");

  assert.equal(sessionRecordOrigin({}), "governed_run", "an unmarked record is a real run, so existing history needs no migration");
  assert.equal(
    sessionRecordOrigin({ recordOrigin: "definitely-real" }),
    "governed_run",
    "an unrecognized origin must collapse to the neutral default instead of reaching the badge as a self-declared label",
  );
  assert.equal(sessionRecordOrigin({ recordOrigin: "acceptance_fixture" }), "acceptance_fixture");
  assert.equal(sessionOriginCopy({}), "");
  assert.equal(sessionOriginCopy({ recordOrigin: "acceptance_fixture" }), originText.acceptance_fixture);
  assert.equal(sessionOriginCopy({ recordOrigin: "demo" }), originText.demo);

  const sessions = [
    {
      runId: "fixture",
      title: "Live control-room acceptance",
      identificationState: "descriptive",
      substanceClass: "recorded",
      recordOrigin: "acceptance_fixture",
      nodeCount: 8,
      updatedAt: "2026-09-01T13:46:20.387Z",
    },
    {
      runId: "real",
      title: "Ship the spine",
      identificationState: "descriptive",
      substanceClass: "recorded",
      updatedAt: "2026-08-24T08:00:00.000Z",
    },
  ];
  assert.deepEqual(
    sessionGroups(sessions).ordered.map((session) => session.runId),
    ["real", "fixture"],
    "the fixture is newer and the only one with nodes, so only a provenance term keeps the real run first",
  );

  assert.match(html, /recordOrigin: sessionRecordOrigin\(session\)/u, "the client rebuild drops every field it does not name");
  assert.match(html, /card\.dataset\.recordOrigin = /u);
  assert.match(html, /"Acceptance fixture, not a real run": "验收样例数据，不是真实运行"/u);
  assert.match(html, /"Demo data, not a real run": "演示数据，不是真实运行"/u);
  assert.match(html, /\.session-card-origin \{/u, "the label needs its own rule or it reads as ordinary row text");
});

test("an empty graph names which of the reasons produced it", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const literal = html.match(/const GRAPH_EMPTY_REASON_TEXT = (\{.*?\});/u);
  assert.ok(literal, "the shipped script must embed the reason copy the server's vocabulary requires");
  const build = new Function("GRAPH_EMPTY_REASON_TEXT", `${shippedHelper(html, "graphEmptyReason")}
    return graphEmptyReason;
  `);
  const graphEmptyReason = build(JSON.parse(literal[1]));

  assert.equal(
    graphEmptyReason({ run: { executionEvidenceState: "recorded" }, graphAvailability: { state: "no_graph_evidence", reason: "artifact_declared_no_nodes" } }),
    "This run wrote a governed artifact, and that artifact declares no task nodes.",
    "a run that advanced and declared nothing must not read the same as a run that never wrote an artifact",
  );
  assert.equal(
    graphEmptyReason({ graphAvailability: { state: "no_graph_evidence", reason: "no_governed_artifact_for_run" } }),
    "This session only recorded its activation. No governed run artifact was written, so there is nothing to draw.",
  );
  assert.equal(
    graphEmptyReason({ run: { executionEvidenceState: "structural_planning_only" }, graphAvailability: { state: "no_graph_evidence", reason: "artifact_declared_no_nodes" } }),
    "This run registered stages but never reported execution nodes.",
  );
  assert.equal(
    graphEmptyReason({ run: { executionEvidenceState: "structural_planning_only" }, truncated: { applied: true } }),
    "Nodes were dropped to stay inside the snapshot budget.",
    "a budget drop is the only reason the operator can act on, so it outranks the others",
  );
  assert.equal(graphEmptyReason({}), "No task nodes in this snapshot.", "an unknown reason must not throw or invent a cause");

  assert.match(html, /executionEvidenceState: display\(firstValue\(runInput, \["executionEvidenceState"\]/u);
  assert.match(html, /graphAvailability: \{\n\s+state: display\(firstValue\(availabilityInput, \["state"\]/u);
  assert.match(html, /truncated: \{ applied: input\.truncated\?\.applied === true \}/u);

  assert.match(html, /function showGraphEmpty\(copy\)/u);
  assert.match(html, /paragraph\.dataset\.i18nEn = copy;/u);
  assert.match(html, /paragraph\.dataset\.i18nZh = zhText\.get\(copy\) \|\| copy;/u);
  assert.match(html, /if \(graphEmpty\) showGraphEmpty\(graphEmptyReason\(snapshot\)\);/u);
  assert.match(html, /"This run registered stages but never reported execution nodes\.": "这次运行登记了阶段，但没有回报执行节点。"/u);
  assert.match(html, /"Nodes were dropped to stay inside the snapshot budget\.": "为控制快照体积，部分节点未被下发。"/u);

  // The reason sentences are prose, not a chip label, so the empty state cannot
  // stay on the smallest tier where CJK copy resolves to roughly 8.5px at 2048px.
  const rules = stylesheetRules(html);
  assert.equal(resolvedDeclaration(rules, { selector: ".graph-empty", property: "font-size" }), "var(--fs-label)");
});

test("switching the empty-graph reason announces once and survives a language toggle", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const build = new Function(
    "graphEmpty",
    "document",
    "zhText",
    "localize",
    "liveRegion",
    `${shippedHelper(html, "showGraphEmpty")}
    return showGraphEmpty;
  `,
  );

  const paragraph = {
    dataset: { i18nEn: "No task nodes in this snapshot.", i18nZh: "当前快照中没有任务节点。" },
    textContent: "当前快照中没有任务节点。",
  };
  const graphEmpty = { hidden: true, firstElementChild: paragraph, appendChild: () => assert.fail("the shipped paragraph must be reused, not duplicated") };
  const liveRegion = { textContent: "", announcements: 0 };
  const zhText = new Map([["Nodes were dropped to stay inside the snapshot budget.", "为控制快照体积，部分节点未被下发。"]]);
  const showGraphEmpty = build(
    graphEmpty,
    { createElement: () => assert.fail("the shipped paragraph must be reused, not duplicated") },
    zhText,
    (value) => zhText.get(value) || value,
    { set textContent(value) { liveRegion.announcements += 1; liveRegion.value = value; } },
  );

  showGraphEmpty("No task nodes in this snapshot.");
  assert.equal(graphEmpty.hidden, false);
  assert.equal(liveRegion.announcements, 0, "an unchanged reason must not re-announce on every poll");

  showGraphEmpty("Nodes were dropped to stay inside the snapshot budget.");
  assert.equal(paragraph.dataset.i18nEn, "Nodes were dropped to stay inside the snapshot budget.");
  assert.equal(paragraph.dataset.i18nZh, "为控制快照体积，部分节点未被下发。");
  assert.equal(paragraph.textContent, "为控制快照体积，部分节点未被下发。");
  assert.equal(liveRegion.announcements, 1);
  assert.equal(liveRegion.value, "为控制快照体积，部分节点未被下发。");

  // applyLanguage() re-reads both attributes, so a JS-driven copy that updates
  // only textContent would silently revert on the next language toggle.
  assert.equal(paragraph.dataset.i18nEn, "Nodes were dropped to stay inside the snapshot budget.");

  showGraphEmpty("Nodes were dropped to stay inside the snapshot budget.");
  assert.equal(liveRegion.announcements, 1, "repeating the same reason must stay silent");
});

test("an icon control keeps its glyph and carries its instruction in aria and title", () => {
  const html = renderLiveControlRoomPage();
  const body = html.slice(html.indexOf("</style>"));

  const handle = body.match(/<button class="graph-tools-handle"[^>]*>[\s\S]*?<\/button>/u);
  assert.ok(handle, "the graph tools drag handle must remain in the shipped markup");

  // The handle shipped a braille grip as text content alongside i18n text
  // attributes. applyLanguage() rewrites textContent for every element carrying
  // those attributes, so on first paint the glyph was replaced by the 19-word
  // instruction sentence and the handle measured 195.58px wide.
  assert.doesNotMatch(handle[0], /data-i18n-en|data-i18n-zh/u, "a glyph control must not carry i18n text attributes");
  assert.match(handle[0], /<svg class="ui-icon"/u, "the grip must be an icon the language pass cannot overwrite");
  assert.match(handle[0], /aria-label="Move graph controls: drag, or arrow keys to nudge, Enter to dock"/u);
  assert.match(handle[0], /title="Drag to move · arrow keys to nudge · Enter to dock"/u);

  // The class of bug, not just this instance: any element that carries i18n text
  // attributes has its children destroyed on every language pass, so it may not
  // hold an icon.
  const conflicts = [];
  for (const element of body.matchAll(/<([a-z]+)[^>]*data-i18n-en[^>]*>([\s\S]*?)<\/\1>/gu)) {
    if (element[2].includes("<svg")) conflicts.push(element[0].slice(0, 120));
  }
  assert.deepEqual(conflicts, [], "an element localized by textContent must not contain an icon");

  // An icon next to visible text needs the text in its own child, otherwise the
  // label can only be localized by destroying the icon. The canvas title read
  // Chinese in English mode for exactly that reason.
  assert.match(
    body,
    /<span class="graph-canvas-title"[^>]*>\s*<svg[^>]*>[\s\S]*?<\/svg><span data-i18n-en="Live execution graph" data-i18n-zh="实时运行图">/u,
  );

  // Moving an instruction into title only helps a Chinese reader if titles are
  // localized, and the shipped page had no title pass at all.
  assert.match(html, /document\.querySelectorAll\("\[title\]"\)\.forEach/u);
  assert.match(html, /"Drag to move · arrow keys to nudge · Enter to dock": "拖动移动 · 方向键微调 · 回车归位"/u);
  assert.match(html, /"Move graph controls: drag, or arrow keys to nudge, Enter to dock": "移动图控件：拖动，或用方向键微调，回车归位"/u);
});

/**
 * The run-context band is the page's identity line and it shipped with the
 * hierarchy inverted. Measured in Chrome at 1707x825 on run `live-ui-regression`:
 * `.run-context-title` carried `white-space: nowrap` with `text-overflow:
 * ellipsis` and deleted 87px of its own text (scrollWidth 606 against clientWidth
 * 519), while the fact strip beside it held 986.26px in three 328.53px tracks
 * whose widest content needed 77px - roughly 880px of empty padding next to a
 * truncated title. In the same band the six fact values rendered at 28.52px, the
 * top tier of the type ladder, and row one's value bottom and row two's label top
 * measured 118.82 against 118.82: a 0.00px separation.
 *
 * So the band's contract is the inverse of what shipped. The title takes the top
 * tier and wraps; the facts are label/value pairs at the body tier that flow in a
 * row and take only the width they need.
 *
 * The assertions this replaced pinned `auto-fit` tracks, a `--context-fact-cap`
 * percentage and a `--context-fact-min` floor derived from `--fs-metric`. None of
 * them were wrong about their own premise - at a 25.42px metric, six full-width
 * CJK values genuinely could not share one row, so the cap was the only thing
 * standing between the strip and a 5+1 orphan row. That premise is exactly what
 * the maintainer rejected: the values should never have been at that tier. With
 * them at the body step the six pairs need roughly 450px of a 591-986px strip, so
 * there is no track to starve and no column count to bound.
 */
test("the run context band gives its width to the title and its top tier to the run, not to six counters", () => {
  const rules = stylesheetRules(renderLiveControlRoomPage());

  // An ellipsis on a run title deletes the run's identity rather than shortening
  // a caption, and the band has the width to avoid it. Checked in every condition:
  // the narrow-branch override is where a `nowrap` would come back.
  for (const property of ["white-space", "text-overflow"]) {
    assert.deepEqual(
      declaredValues(rules, { selector: ".run-context-title", property }),
      [],
      `.run-context-title declares ${property}, so a title wider than its column is deleted rather than wrapped`,
    );
  }

  // Wrapping without a bound trades a truncated title for an unbounded band, and
  // the band's height is spent against `minCanvasHeightPx`. A clamp keeps both
  // properties: it wraps, and a pathological title cannot push the canvas under
  // its floor.
  const clamp = resolvedDeclaration(rules, {
    selector: ".run-context-title",
    property: "-webkit-line-clamp",
  });
  assert.ok(clamp, ".run-context-title must bound how many lines it may take");
  assert.ok(
    lineClampCount(rules, clamp) >= 2,
    `-webkit-line-clamp is ${clamp}; a one-line clamp is the ellipsis again under another property`,
  );
  assert.match(
    resolvedDeclaration(rules, { selector: ".run-context-title", property: "font-size" }) ?? "",
    /var\(--fs-hero\)/u,
    "the run title must carry the ladder's top tier; that tier existed for a counter and the counters won",
  );

  // Grid tracks are what starved the values, so the strip has to size itself from
  // its content instead of dividing a fixed width. No condition may reintroduce a
  // track list.
  assert.deepEqual(
    declaredValues(rules, { selector: ".run-context-facts", property: "grid-template-columns" }),
    [],
    "the fact strip declares a track list again; equal tracks are what left 880px empty beside a clipped title",
  );
  const factDisplay = declaredValues(rules, { selector: ".run-context-facts", property: "display" });
  assert.ok(factDisplay.length > 0, "the fact strip must declare how it flows");
  for (const value of factDisplay) {
    // A band too narrow to carry the strip drops it outright, and a hidden strip has
    // no flow to get wrong. The failure this guards is a track list coming back
    // under a condition, not the handheld branch choosing to show fewer facts.
    if (value.trim() === "none") continue;
    assert.match(value, /flex/u, `.run-context-facts { display: ${value} } cannot flow to content width`);
  }
  assert.match(
    resolvedDeclaration(rules, { selector: ".run-context-facts", property: "flex-wrap" }) ?? "",
    /wrap/u,
    "the strip must wrap rather than overflow when the run has more facts than the band can hold",
  );

  // The top tier is a hierarchy claim, not a size: six elements at the largest
  // step on screen is the inversion the maintainer reported twice. The values
  // belong at the prose tier, where a wrapped second line is legible.
  const factSize = resolvedDeclaration(rules, { selector: ".context-fact strong", property: "font-size" });
  assert.ok(factSize, "a fact value must declare its tier");
  assert.doesNotMatch(
    factSize,
    /var\(--fs-hero\)/u,
    "a fact value is back on the top tier, so the band has six things competing to be the largest text",
  );

  // The values are a closed vocabulary - `目标确认`, `04:35:27`, `0` - so an
  // ellipsis destroys a value instead of shortening it. Measured in Chrome at a
  // 25.42px metric, `阶段未确认` was 130px in Chinese against 225px for `Stage
  // unconfirmed` in English, which is why no single fixed width covers both
  // locales and the box has to wrap.
  for (const property of ["white-space", "text-overflow"]) {
    assert.deepEqual(
      declaredValues(rules, { selector: ".context-fact strong", property }),
      [],
      `.context-fact strong declares ${property}, so a value wider than its box is deleted rather than wrapped`,
    );
  }
  assert.match(
    resolvedDeclaration(rules, { selector: ".context-fact strong", property: "overflow-wrap" }) ?? "",
    /anywhere/u,
    "a fact value must be able to break inside an unspaced run such as `Verification`",
  );

  // Measured at 900x728: `.connection` shrank to an 82px box around 96px of
  // `nowrap` text with `overflow: visible`, so "Snapshot loaded" painted to
  // x=722 while the neighbouring `运行记录` button's box started at x=717 — five
  // pixels of text on top of a control. Clipping the text keeps the spill inside
  // the box; the occlusion sweep cannot catch this, because the victim button's
  // own centre still hit-tests to itself.
  for (const property of ["overflow", "text-overflow", "min-width"]) {
    assert.ok(
      resolvedDeclaration(rules, { selector: ".connection span:last-child", property }),
      `the connection label must declare ${property} so it cannot paint outside its box`,
    );
  }
  assert.equal(
    resolvedDeclaration(rules, { selector: ".connection span:last-child", property: "overflow" }),
    "hidden",
  );
  assert.equal(
    resolvedDeclaration(rules, { selector: ".connection span:last-child", property: "text-overflow" }),
    "ellipsis",
  );

  // An ellipsis only moves the problem unless the full text stays reachable, and
  // the label is written by JS on every snapshot. The markup declares an i18n
  // pair for the initial "Connecting…" that every later status invalidates, so
  // the writer has to refresh the pair and the title cache alongside the text.
  const html = renderLiveControlRoomPage();
  for (const pattern of [
    /connectionLabel\.dataset\.i18nEn = message/u,
    /connectionLabel\.dataset\.i18nZh = zhText\.get\(message\)/u,
    /connectionLabel\.dataset\.i18nTitleEn = message/u,
    /connectionLabel\.title = localize\(message\)/u,
  ]) {
    assert.match(html, pattern);
  }

  // `zhText.get(message) || message` degrades to English rather than throwing, so
  // a status written without a translation renders English inside the Chinese UI
  // and nothing fails. That is how "Snapshot loaded" shipped untranslated while
  // "Connecting…", "Streaming" and "Reconnecting" beside it were localized. The
  // status is not always a bare argument — the snapshot writer picks it with a
  // ternary — so every quoted message inside a call is collected, not just the
  // calls whose second argument happens to be a literal.
  const statusCalls = [...html.matchAll(/updateConnection\(([^;]*?)\);/gu)].map((call) => call[1]);
  const statusLiterals = statusCalls.flatMap((args) => [...args.matchAll(/"([A-Z][^"]*)"/gu)].map((hit) => hit[1]));
  assert.ok(statusLiterals.length >= 4, "the transport writer must be called with literal statuses");
  assert.ok(
    statusLiterals.includes("Snapshot loaded"),
    "the ternary-selected snapshot status must be collected, or this guard checks nothing",
  );
  for (const status of new Set(statusLiterals)) {
    assert.match(
      html,
      new RegExp(`"${status.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}": "`, "u"),
      `updateConnection writes "${status}" with no zhText entry, so the Chinese UI shows English`,
    );
  }

  // A caller that localizes before writing would cache Chinese as the English
  // original. The demo-mode call did exactly that.
  for (const args of statusCalls) {
    assert.doesNotMatch(
      args,
      /currentLanguage/u,
      `updateConnection(${args}) localizes at the call site and poisons the title cache`,
    );
  }
});

/**
 * The edge legend is the only place the four locked edge states are written
 * down, so truncating it removes the key to the graph rather than shortening a
 * caption. Measured losses on `span.graph-edge-legend`: 141px at 900px, 86px at
 * 1024px and 29px at 501px, which dropped `琥珀虚线＝阻塞 · 点线＝结构归属` —
 * two of the four states — with the ellipsis as the only hint anything was gone.
 */
test("the edge legend keeps all four locked edge states at every width", () => {
  const html = renderLiveControlRoomPage();
  const rules = stylesheetRules(html);

  // Wrapping is what makes the legend width-independent. An ellipsis on a
  // single line can only ever hide the tail, and the tail is where the amber
  // and dotted states live.
  const whiteSpace = resolvedDeclaration(rules, { selector: ".graph-edge-legend", property: "white-space" });
  assert.notEqual(whiteSpace, "nowrap", "a single-line legend loses its tail at narrow widths");

  // A legend that wraps but is clipped to one line's height would regress the
  // same way, so the height must not be capped either.
  for (const property of ["height", "max-height"]) {
    const capped = resolvedDeclaration(rules, { selector: ".graph-edge-legend", property });
    assert.ok(
      capped === null || /auto|none|fit-content/u.test(capped),
      `the legend must not cap ${property} (${capped}) or wrapped states stay hidden`,
    );
  }

  // Deleting states is the other way to make the overflow go away, so the copy
  // itself is pinned. Both locales carry all four, in both edge vocabularies.
  const legend = html.match(/<span class="graph-edge-legend"[^>]*>/u);
  assert.ok(legend, "markup must contain the edge legend");
  for (const state of ["Green solid = done", "Gray dashed = queued", "Amber dashed = blocked", "Dotted = ownership"]) {
    assert.ok(legend[0].includes(state), `the English legend must document "${state}"`);
  }
  for (const state of ["绿色实线＝已完成", "灰色虚线＝排队", "琥珀虚线＝阻塞", "点线＝结构归属"]) {
    assert.ok(legend[0].includes(state), `the Chinese legend must document "${state}"`);
  }
});

test("an explicit stage-rail expansion refits the camera instead of cropping the run", () => {
  // Expanding the rail below the budget threshold pins it open for the session and
  // charges the canvas the rail's own height. That concession only holds if the
  // shrunken canvas still shows the run's shape, so both the budget path and the
  // user-choice path must refit the camera. Without this assertion the concession
  // is a silent crop.
  const page = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const toggleHandler = /stageOverview\?\.addEventListener\("toggle", \(\) => \{([\s\S]*?)\n  \}\);/u.exec(page);
  assert.ok(toggleHandler, "stage rail must keep a toggle listener that records the user's explicit choice");
  assert.match(toggleHandler[1], /stageRailUserChoice = stageOverview\.open/u);
  assert.match(toggleHandler[1], /reconcileCamera\(\)/u);

  const budgetApply = /function applyStageRailBudget\(\) \{([\s\S]*?)\n  \}/u.exec(page);
  assert.ok(budgetApply, "budget-driven rail policy must stay a named function");
  assert.match(budgetApply[1], /reconcileCamera\(\)/u);
  assert.match(budgetApply[1], /stageRailUserChoice !== null/u);
});

// The task summary held real text for 19 of 23 records while a top-level
// `display: none` kept every one of them off screen. Unhiding it alone would
// have traded an invisible row for a false one: the service substitutes
// "Governed execution" for the runs that recorded no task, so the placeholder
// the page must show is the one naming the absence, not the shared filler.
test("the run task summary reaches the screen and names an absent summary instead of inventing one", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });

  assert.doesNotMatch(
    html,
    /\.run-context-heading \.context-kicker, \.run-context-task \{ display: none; \}/u,
    "the task summary must not be hidden unconditionally while it carries real text",
  );

  const writeSite = /setText\(contextTask,([^;]*)\);/u.exec(html);
  assert.ok(writeSite, "the task summary must keep a single write site");
  assert.doesNotMatch(
    writeSite[1],
    /Governed execution/u,
    "a run that recorded no task must not be captioned with the shared filler",
  );
  assert.match(writeSite[1], /runTaskCopy\(/u, "the write site must route through the absence-aware helper");

  const helper = /function runTaskCopy\(task\) \{([\s\S]*?)\n  \}/u.exec(html);
  assert.ok(helper, "runTaskCopy() must ship as a named helper");
  assert.match(helper[1], /"未保存任务摘要" : "No task summary saved"/u, "both locales must ship the absence copy");
});

// The absence branch is the one that carries the risk: 25 of these runs recorded
// only a status file, and the read model hands those the same filler string a
// real run would carry. Asserting the helper merely exists leaves that branch
// free to print the filler, so each substitute is evaluated for what it renders.
test("a run that recorded no task reads as one, in both languages", () => {
  for (const [language, absent, withheld] of [
    ["zh", "未保存任务摘要", "任务摘要因含敏感内容未显示"],
    ["en", "No task summary saved", "Task summary withheld as sensitive"],
  ]) {
    const { runTaskCopy } = sessionCopyHarness({ language });
    assert.equal(runTaskCopy("Governed execution"), absent, "the read model's filler must not reach the screen");
    assert.equal(runTaskCopy(""), absent);
    assert.equal(runTaskCopy(undefined), absent);
    assert.equal(runTaskCopy("[path omitted]"), withheld, "a withheld summary must not read as an unrecorded one");
    assert.equal(runTaskCopy("redacted"), withheld);
    assert.equal(runTaskCopy("提交 推送 更新更新记录 发布新版本"), "提交 推送 更新更新记录 发布新版本",
      "a recorded task must survive unchanged in every language");
    assert.notEqual(runTaskCopy("Governed execution"), runTaskCopy("[path omitted]"),
      "an unrecorded summary and a withheld one must not print the same sentence");
  }
});

function shippedInitialLanguage(html) {
  const key = /const LANGUAGE_STORAGE_KEY = "([^"]+)"/u.exec(html);
  assert.ok(key, "the language storage key must remain a named constant in the shipped script");
  const factory = new Function("window", "LANGUAGE_STORAGE_KEY",
    shippedHelper(html, "initialLanguage") + "\n  return initialLanguage;");
  return (stored, tags) => factory(
    {
      localStorage: { getItem: () => stored },
      navigator: { language: tags[0] ?? "", languages: tags },
    },
    key[1],
  )();
}

// A stored choice belongs to the reader and outranks everything else; only its
// absence is an open question. The page answered that question with Chinese for
// everyone, so an English-locale visitor met a Chinese page on first load and
// had to find the toggle to say what the browser had already said. Locale tags
// arrive region-coded, so pinning bare "zh" and "en" would leave the shapes a
// browser actually sends untested.
test("the first visit follows the browser locale, and a stored choice still wins", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const initialLanguage = shippedInitialLanguage(html);

  assert.match(html, /let currentLanguage = initialLanguage\(\);/u,
    "the initial language must be resolved by the shipped helper, not by an inline expression");

  assert.equal(initialLanguage("en", ["zh-CN"]), "en", "a stored English choice must survive a Chinese browser");
  assert.equal(initialLanguage("zh", ["en-US"]), "zh", "a stored Chinese choice must survive an English browser");

  for (const tag of ["zh", "zh-CN", "zh-Hans-CN", "zh-TW"]) {
    assert.equal(initialLanguage(null, [tag]), "zh", tag + " must open in Chinese");
  }
  for (const tag of ["en", "en-US", "en-GB", "de-DE", "ja-JP"]) {
    assert.equal(initialLanguage(null, [tag]), "en", tag + " must not open in Chinese");
  }

  assert.equal(initialLanguage(null, []), "zh",
    "a browser that states no locale must fall back to the shipped default");
  assert.equal(initialLanguage("fr", ["en-GB"]), "en",
    "a stored value the page cannot render must not outrank a readable browser locale");
});

// Counted on the panel itself: 22 of the 37 session rows this repo's own project
// publishes show the record file's own write time, in the same chip and the same
// format as a run that reported a time of its own. Six of those 22 are same-day
// records, so "it looks old, nobody will be misled" does not hold; rewrite one of
// those files — a sync, a migration, a copy — and the row claims the run was
// touched just now. The data layers now publish which of the two a value is; this
// is the surface refusing to flatten them back together.
test("a session row says when its time is only the record file's write time", () => {
  const { sessionTimeCopy } = sessionCopyHarness({ language: "en" });

  const reported = sessionTimeCopy({
    updatedAt: "2026-08-26T09:00:00.000Z",
    updatedAtBasis: "recorded",
  });
  assert.equal(reported.text, "at 2026-08-26T09:00:00.000Z",
    "a reported time is shown plainly, with no qualifier to explain away");

  const fileDated = sessionTimeCopy({
    updatedAt: "2026-07-05T08:35:53.574Z",
    updatedAtBasis: "record_file_write_time",
  });
  assert.equal(fileDated.text, "File time at 2026-07-05T08:35:53.574Z",
    "a time that came only from the file must be marked in the chip itself, not only in a tooltip nobody opens");
  assert.match(fileDated.hint, /reports no time of its own/u,
    "the tooltip must say why the value is qualified");

  // The permissive direction is the dangerous one: an older server that does not
  // publish the basis at all must not have its rows read as reported.
  const unstated = sessionTimeCopy({ updatedAt: "2026-08-26T09:00:00.000Z" });
  assert.equal(unstated.text, "at 2026-08-26T09:00:00.000Z");
  assert.doesNotMatch(unstated.hint, /reported by the record/u,
    "a missing basis is an unanswered question, not a claim that the run reported the time");

  const startedToo = sessionTimeCopy({
    updatedAt: "2026-08-26T09:00:00.000Z",
    updatedAtBasis: "recorded",
    startedAt: "2026-08-26T07:05:00.000Z",
  });
  assert.match(startedToo.hint, /2026-08-26T07:05:00\.000Z/u,
    "a recorded start instant belongs in the tooltip; the card already carries five chips and cannot take a sixth");
});

/**
 * Measured on the real repository at 127.0.0.1:4331 with the run-records panel
 * open: the project picker read "Meta_Kim · 36 次运行" while the run picker beside
 * it offered 23 rows, and the 13 missing runs were named nowhere on that panel.
 * The two numbers came from two independent derivations — one printed the shipped
 * session count, the other filtered the same array by sessionIsIdentified — so
 * neither could see that it disagreed with its neighbour.
 *
 * The label alone is not the guard. A label built from one number would still
 * pass an assertion that only reads the total, so the openable count is mutated
 * independently below: the two counters must both reach the string.
 */
test("the project label and the run picker report one reconciled tally", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const { projectRunTally, projectOptionLabel, unopenableRunNoticeLabel } = new Function(
    "sessionIsIdentified",
    `${shippedHelper(html, "projectRunTally")}
      ${shippedHelper(html, "projectOptionLabel")}
      ${shippedHelper(html, "unopenableRunNoticeLabel")}
      return { projectRunTally, projectOptionLabel, unopenableRunNoticeLabel };
    `,
  )((session) => session?.identificationState === "descriptive" || session?.conversationLinkState === "verified");

  const openable = { identificationState: "descriptive" };
  const unopenable = { identificationState: "unlinked" };
  const project = (openableCount, unopenableCount) => ({
    displayName: "Meta_Kim",
    sessions: [
      ...Array.from({ length: openableCount }, () => openable),
      ...Array.from({ length: unopenableCount }, () => unopenable),
    ],
  });

  const measured = projectRunTally(project(23, 13));
  assert.deepEqual(
    { held: measured.held, openable: measured.openable, unopenable: measured.unopenable },
    { held: 36, openable: 23, unopenable: 13 },
    "the tally must publish all three counters; a surface given only the total cannot disclose the gap",
  );

  assert.equal(
    projectOptionLabel(project(23, 13)),
    "Meta_Kim · 23 of 36 runs",
    "the label must state both counts, or the panel claims 36 runs while offering 23",
  );
  // Mutating only the openable count must move the label. Both counters are read
  // off the same array, so a label that derived one from the other would be
  // green on the assertion above and blind to the defect it exists to catch.
  assert.equal(
    projectOptionLabel(project(9, 27)),
    "Meta_Kim · 9 of 36 runs",
    "the openable count must reach the label independently of the total",
  );
  assert.equal(
    projectOptionLabel(project(4, 0)),
    "Meta_Kim · 4 runs",
    "a project whose every run is openable keeps the plain form, or the existing zh mapping goes dead",
  );
  assert.equal(
    projectOptionLabel(project(0, 0)),
    "Meta_Kim · no runs",
    "an empty project keeps its own sentence rather than reading 0 of 0",
  );

  assert.equal(
    unopenableRunNoticeLabel(13),
    "+ 13 runs without an openable record",
    "the runs the picker withholds must be named inside the picker, not only in another panel",
  );
});

/**
 * The label is English at the call site because the renderer localizes on output.
 * A new English form with no zh pattern falls through `localize` unchanged, which
 * is the failure the fallback is built to hide: the sentence renders in English
 * on a Chinese page instead of raising anything.
 */
test("both new run-count sentences have a Chinese form", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const zhLiteral = html.match(/const zhText = new Map\(Object\.entries\((\{.*?\})\)\);\n/su);
  assert.ok(zhLiteral, "the shipped script must embed the zh dictionary");
  const localize = new Function(
    "display",
    "currentLanguage",
    "zhText",
    `${shippedHelper(html, "localize")}
      return localize;
    `,
  )(
    (value, fallback = "") => (value === undefined || value === null || value === "" ? fallback : String(value)),
    "zh",
    new Map(Object.entries(JSON.parse(zhLiteral[1]))),
  );

  assert.equal(
    localize("Meta_Kim · 23 of 36 runs"),
    "Meta_Kim · 共 36 次运行（可打开 23 条）",
    "the split form must localize; falling through leaves English on a Chinese page",
  );
  assert.equal(
    localize("+ 13 runs without an openable record"),
    "另有 13 条没有可打开的记录",
    "the picker's withheld-run row must localize",
  );
  assert.equal(
    localize("Meta_Kim · 4 runs"),
    "Meta_Kim · 4 次运行",
    "the plain form must keep working; a more specific new pattern must not shadow it",
  );
});

test("the withheld-run notice row cannot be picked or become a run id", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const options = [];
  const select = {
    disabled: null,
    append(option) {
      options.push(option);
    },
  };
  const replaceSelectOptions = new Function(
    "clearChildren",
    "document",
    "localize",
    `${shippedHelper(html, "replaceSelectOptions")}
      return replaceSelectOptions;
    `,
  )(
    () => {},
    { createElement: () => ({ value: null, textContent: null, disabled: false, selected: false }) },
    (value) => value,
  );

  replaceSelectOptions(
    select,
    [
      { value: "RUN-A", label: "first run" },
      { value: "RUN-B", label: "second run" },
      { value: "", selectable: false, label: "+ 13 runs without an openable record" },
    ],
    "",
  );

  assert.equal(options.length, 3, "every supplied row must reach the select");
  assert.deepEqual(
    options.map((option) => option.disabled),
    [false, false, true],
    "only the notice row is disabled; disabling a real run would make it unopenable",
  );
  assert.equal(
    options[2].value,
    "",
    "the notice row must carry no run id, or selecting it navigates to a run that does not exist",
  );
  assert.equal(
    options[2].selected,
    false,
    "the notice row must not be preselected even when the selected run id is empty, which is the state before any run is chosen",
  );

  const withSelection = [];
  replaceSelectOptions(
    { disabled: null, append: (option) => withSelection.push(option) },
    [
      { value: "RUN-A", label: "first run" },
      { value: "RUN-B", label: "second run" },
      { value: "", selectable: false, label: "+ 13 runs without an openable record" },
    ],
    "RUN-B",
  );
  assert.deepEqual(
    withSelection.map((option) => option.selected),
    [false, true, false],
    "adding the notice row must not break ordinary preselection",
  );
});

/**
 * Ten text runs were measured deleting their own content at 1512px while the
 * space to hold it sat free directly below. `p.run-context-task` carried 1685px
 * of text in a 648px box; eight `span.node-title` cells each lost their tail.
 *
 * `text-overflow` is not a fit strategy. It is a decision to discard whatever did
 * not reach the end of line one, taken before a second line has been offered, and
 * on a title the discarded part is the identity the reader came for.
 *
 * The bound the ellipsis was providing still has to hold, so the clamp is
 * asserted beside its absence: wrapping with no line cap trades a deleted title
 * for a card that grows until it collides with the row beneath it.
 */
test("a title too long for one line takes a second line instead of deleting its tail", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const rules = stylesheetRules(html);
  const wrapped = [".node-title", ".run-context-task"];

  // `.node-title` is reached by five selectors across three conditions, and the
  // cell band and the hover state are two of them. Collecting them by base
  // selector rather than by the one spelling this guard was written against is
  // what keeps a `nowrap` from coming back inside a media branch unseen.
  const decorated = rules
    .flatMap((rule) => rule.selectors)
    .filter((selector) => wrapped.includes(baseSelectorOf(selector)));
  assert.ok(
    decorated.length >= 6,
    `every rule reaching a wrapped run must be checked, found only ${decorated.length}`,
  );
  for (const selector of decorated) {
    assert.deepEqual(
      declaredValues(rules, { selector, property: "text-overflow" }),
      [],
      `${selector} declares text-overflow, which discards the tail before line two is offered`,
    );
    for (const value of declaredValues(rules, { selector, property: "white-space" })) {
      assert.notEqual(
        normalizedValue(value),
        "nowrap",
        `${selector} refuses to wrap, so any clamp on it can never reach a second line`,
      );
    }
  }

  for (const selector of wrapped) {
    assert.equal(
      resolvedDeclaration(rules, { selector, property: "display" }),
      "-webkit-box",
      `${selector} needs the box display, or -webkit-line-clamp is inert and the run grows unbounded`,
    );
    assert.equal(resolvedDeclaration(rules, { selector, property: "-webkit-box-orient" }), "vertical");
    assert.equal(resolvedDeclaration(rules, { selector, property: "overflow" }), "hidden");
    assert.equal(
      lineClampCount(rules, resolvedDeclaration(rules, { selector, property: "-webkit-line-clamp" })),
      2,
      `${selector} must clamp at two lines: one is the ellipsis again, none is an unbounded box`,
    );
  }

  // The second line is only free if the layout already reserved it. Node cards
  // are absolutely positioned from a height the layout computes before they
  // render, so a card that grows past that reservation overlaps the row below
  // instead of showing more title — the same defect with a different symptom.
  //
  // The reserve used to be scraped out of the page with a regex anchored on a
  // literal inside `estimatedNodeCardHeight`. Once that literal moved into
  // configuration the unbounded scan ran past the end of the function and matched
  // an unrelated `Math.max(0,` further down the page, so the guard read a reserve
  // of 0 and failed as though the cards really did overlap. It now reads the
  // configured number and proves that number is the one shipped to the browser.
  const reservePx = loadLiveGraphLayoutPolicy().card.measuredMinHeightPx;
  assert.match(
    html,
    /resolveNodeCardHeight\(nodeCapabilityCount\(node\), GRAPH_LAYOUT\.card\)/u,
    "card height must come from the configured resolver, or this reserve is not the one the page uses",
  );
  assert.match(
    html,
    new RegExp(`"measuredMinHeightPx":\\s*${reservePx}\\b`, "u"),
    "the configured card floor must reach the browser, or the reserve asserted here is not the shipped one",
  );
  const cardFloor = lengthToPixels(resolvedDeclaration(rules, { selector: ".node-card", property: "min-height" }));
  const widestBase = resolveTypographyBasePx(TYPOGRAPHY_SCALE, 4000);
  const secondTitleLine = widestBase * TYPOGRAPHY_STEP_RATIOS.get("--fs-entity-title")
    * TYPOGRAPHY_LEADING_RATIOS.get("--lh-snug");
  assert.ok(
    cardFloor + secondTitleLine <= reservePx,
    `a ${cardFloor}px card plus a ${secondTitleLine.toFixed(2)}px second title line exceeds the `
      + `${reservePx}px the layout reserved, so the wrapped title overlaps the next row`,
  );
});

/**
 * `h1.run-context-title` was measured showing 2 of its 4 lines. The clamp was
 * doing exactly what it said, and what it said was written when the title shared
 * its row with six counters at the ladder's top tier. The counters have since
 * been demoted and the row is the title's, so the clamp is the only thing still
 * holding the old layout's shape.
 *
 * Two of four lines is not a shortened title. It is a different title.
 */
test("the run title shows its whole identity instead of the first half of it", () => {
  const rules = stylesheetRules(renderLiveControlRoomPage({ snapshot: snapshotFixture }));

  assert.equal(
    rootCustomProperty(rules, "--clamp-lines-hero"),
    "3",
    "the hero clamp is the shipped value this fix was measured against",
  );
  assert.ok(
    lineClampCount(rules, resolvedDeclaration(rules, { selector: ".run-context-title", property: "-webkit-line-clamp" })) >= 3,
    "a two-line clamp is what hid two of the four lines that were measured",
  );

  // Clamping wider is half of it. A container that caps its own height crops the
  // lines the clamp now permits, and that crop leaves no ellipsis behind to hint
  // anything is missing.
  for (const selector of [".run-context", ".run-context-heading", ".run-context-title"]) {
    for (const property of ["height", "max-height"]) {
      const capped = resolvedDeclaration(rules, { selector, property });
      assert.ok(
        capped === null || /auto|none|fit-content|min-content|max-content/u.test(capped),
        `${selector} caps ${property} at ${capped}, so the third line is clipped rather than shown`,
      );
    }
  }
});

/**
 * The measured type scale ran backwards: a legend caption rendered a 17.3px line
 * against a 13.3px status title. The caption explains the diagram; the status
 * title names what the reader is looking at.
 *
 * Ordering cannot be read off `font-size`, which is why this shipped green. The
 * caption sat a step *below* the title on the ladder and still rendered taller,
 * because leading multiplies the step and the caption carried the looser family.
 * So the tokens are pinned as literals and the resulting line boxes are ordered.
 */
test("the type scale runs from the brand mark down to the legend caption, not back up", () => {
  const rules = stylesheetRules(renderLiveControlRoomPage({ snapshot: snapshotFixture }));

  // Hand-written, not derived: every one of these four is a tier decision that a
  // future edit can only make by disagreeing with this list out loud.
  assert.deepEqual(
    [".brand-title", ".status-bar .status-title", ".stage-step-name", ".graph-edge-legend"].map((selector) => [
      selector,
      resolvedDeclaration(rules, { selector, property: "font-size" }),
      resolvedDeclaration(rules, { selector, property: "line-height" }),
    ]),
    [
      [".brand-title", "var(--fs-view-title)", "var(--lh-display)"],
      [".status-bar .status-title", "var(--fs-entity-title)", "var(--lh-display)"],
      [".stage-step-name", "var(--fs-body)", "var(--lh-flat)"],
      [".graph-edge-legend", "var(--fs-label)", "var(--lh-snug)"],
    ],
    "each of these four carries a declared tier, and a legend caption is not one of the top two",
  );

  // The products are ordered at every width, because the fluid base is a common
  // positive factor and cancels out of the comparison. One width is therefore the
  // whole claim rather than a sample of it.
  const descending = [".brand-title", ".status-bar .status-title", ".stage-step-name", ".graph-edge-legend"]
    .map((selector) => [selector, renderedLineBoxPx(rules, selector, 1512)]);
  for (let index = 1; index < descending.length; index += 1) {
    const [above, taller] = descending[index - 1];
    const [below, shorter] = descending[index];
    assert.ok(
      taller > shorter,
      `${above} renders a ${taller.toFixed(2)}px line and ${below} renders ${shorter.toFixed(2)}px, `
        + "so the smaller thing is at least as large as the thing above it",
    );
  }

  // Raising a tier inside a fixed-height bar is how a legible title becomes a
  // clipped one. The bar is one track with no vertical padding, so the worst case
  // is the widest base the clamp can reach.
  const barHeight = loadLiveChromeBudget().statusBarHeightPx;
  const titleLine = renderedLineBoxPx(rules, ".status-bar .status-title", 4000);
  assert.ok(
    titleLine <= barHeight,
    `the status title renders a ${titleLine.toFixed(2)}px line box in a ${barHeight}px bar`,
  );
});

/**
 * "紧凑到眼睛疼 ui和文字都贴到一起了" — the run task summary sat 4px under the
 * title it belongs to, on 1.28 leading. The ladder already says both are wrong:
 * `--sp-tight` documents itself as a padding step, because 4px between two boxes
 * reads as a rendering artifact rather than as a grouping level, and the text
 * floor is `--sp-cozy`.
 *
 * The two move together. The 8px floor is declared to apply only to the wrapped
 * leading families, so a run still on `--lh-flat` would satisfy the letter of the
 * spacing contract while staying the cramped single-line row that was reported.
 */
test("the run task summary is spaced and led as prose rather than as a one-line label", () => {
  const rules = stylesheetRules(renderLiveControlRoomPage({ snapshot: snapshotFixture }));
  const spacing = loadLiveSpacingScale();

  const margin = resolvedDeclaration(rules, { selector: ".run-context-task", property: "margin" });
  assert.ok(margin, ".run-context-task must declare its own separation from the title above it");
  const topMargin = lengthToPixels(splitTopLevel(margin)[0]);
  assert.equal(topMargin, 8, "the gap under the run title is the measured value this fix was written for");
  assert.ok(
    topMargin >= spacing.textAdjacency.minimumPx,
    `${topMargin}px is under the ${spacing.textAdjacency.minimumPx}px the ladder declares as the text floor`,
  );

  const leading = resolvedDeclaration(rules, { selector: ".run-context-task", property: "line-height" });
  const family = /^var\(--lh-([a-z0-9-]+)\)$/u.exec(String(leading).trim());
  assert.ok(family, `.run-context-task leads with ${leading} instead of a leading family`);
  assert.ok(
    spacing.textAdjacency.appliesToLeadingFamilies.includes(family[1]),
    `.run-context-task wraps to two lines on the "${family[1]}" leading, which the text floor does not `
      + `cover (it covers ${spacing.textAdjacency.appliesToLeadingFamilies.join(", ")}), so the 8px above `
      + "it is unguarded and the lines inside it stay pressed together",
  );
});

/**
 * The cell band is the eight measured node titles. Its height was derived for one
 * line, so a two-line clamp inside it renders the second line behind the band's
 * own bottom edge — legible text, invisible.
 *
 * `--cell-band-h` is the counter-scaled one-line height and stays untouched: it
 * is the quantity the camera contract is written against. The band the reader
 * sees is a second property derived from it and from the same line count the
 * clamp uses, so the two cannot disagree about how many lines exist.
 */
test("the cell band is as tall as the number of lines its title is allowed to take", () => {
  const rules = stylesheetRules(renderLiveControlRoomPage({ snapshot: snapshotFixture }));
  const cellCard = '.graph-canvas[data-semantic-zoom="cell"] .node-card';

  assert.equal(
    rootCustomProperty(rules, "--clamp-lines-title"),
    "2",
    "the band derivation and the clamp have to read one count, and this is its shipped value",
  );
  assert.equal(
    resolvedDeclaration(rules, { selector: cellCard, property: "--cell-band-box-h" }),
    "calc(var(--cell-band-h) + (var(--clamp-lines-title) - 1) * var(--cell-title-fs) * var(--lh-flat))",
    "the visible band must be the one-line band plus the extra lines the clamp permits",
  );

  const bandHeight = resolvedDeclaration(rules, { selector: `${cellCard}::after`, property: "height" });
  const titleHeight = resolvedDeclaration(rules, { selector: `${cellCard} .node-title`, property: "height" });
  assert.equal(bandHeight, "var(--cell-band-box-h)", "the painted band must take the derived height");
  assert.equal(
    titleHeight,
    bandHeight,
    `the title box is ${titleHeight} and the band behind it is ${bandHeight}; whichever is shorter `
      + "decides which line the reader loses",
  );
});

/**
 * The stage rail's default state used to be predicted: the client compared the
 * window height against a sum of hand-measured chrome bands kept in config. A
 * predicted sum is a second authority for a quantity the browser already knows,
 * and it had drifted -- the run-context band was written down at 106px while the
 * rule that sizes it clamps to three lines of the largest step on the ladder.
 * Worse, one number cannot describe the band at every width, because a media
 * gate restacks it below 1180px, so the composition the number describes is not
 * the composition that renders there.
 *
 * The decision is now taken from the canvas the page actually rendered. That
 * needs no band inventory and cannot drift, because there is nothing to keep in
 * step. The measurement has to happen after layout is forced, so the fake below
 * only commits a new height when the page asks for a reflow: an implementation
 * that reads the height first sees the stale value and decides the other way.
 */
test("the stage rail's default state is measured from the rendered canvas, not predicted from the window", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const resolveStageRailOpenState = new Function(
    `${shippedHelper(html, "resolveStageRailOpenState")}
return resolveStageRailOpenState;`,
  )();

  function harness({ openCanvasHeightPx, closedCanvasHeightPx, railStartsOpen = false }) {
    const transitions = [];
    const rail = {
      state: railStartsOpen,
      get open() {
        return this.state;
      },
      set open(next) {
        this.state = next;
        transitions.push(next);
      },
    };
    let committed = railStartsOpen ? openCanvasHeightPx : closedCanvasHeightPx;
    return {
      rail,
      transitions,
      canvas: {
        get clientHeight() {
          return committed;
        },
      },
      reflow() {
        committed = rail.open ? openCanvasHeightPx : closedCanvasHeightPx;
      },
    };
  }

  const tight = harness({ openCanvasHeightPx: 281, closedCanvasHeightPx: 394 });
  const tightResult = resolveStageRailOpenState({
    rail: tight.rail,
    canvas: tight.canvas,
    minCanvasHeightPx: 360,
    reflow: tight.reflow,
  });
  assert.equal(
    tightResult.openCanvasHeightPx,
    281,
    "the decision must be taken on the height the canvas renders with the rail expanded, "
      + "which is only knowable after layout is forced",
  );
  assert.equal(tightResult.open, false, "281px of canvas is under the 360px floor, so the rail must not default open");
  assert.deepEqual(
    tight.transitions,
    [true, false],
    "the rail must be expanded to be measured and then left in the state the measurement decided",
  );

  const roomy = harness({ openCanvasHeightPx: 512, closedCanvasHeightPx: 606 });
  const roomyResult = resolveStageRailOpenState({
    rail: roomy.rail,
    canvas: roomy.canvas,
    minCanvasHeightPx: 360,
    reflow: roomy.reflow,
  });
  assert.equal(roomyResult.openCanvasHeightPx, 512);
  assert.equal(roomyResult.open, true, "512px of canvas clears the floor, so the rail may default open");
  assert.deepEqual(roomy.transitions, [true], "the rail must still be expanded to be measured");

  assert.ok(
    !/window\.innerHeight\s*>=\s*viewportBudget\./u.test(html),
    "the rail decision must not go back to comparing the window height against a predicted chrome sum",
  );
});

/**
 * Measuring the rail means expanding it, so the page now moves the widget itself
 * before it has decided anything. A `details` element reports that move as a
 * toggle event, and the listener that captures a real user preference cannot tell
 * the two apart on its own -- it compares against the state the page last decided
 * on. So the decision has to be written back to that baseline, or the page's own
 * probe reads as a click and pins the rail for the rest of the session.
 *
 * This runs the caller, not the measurement, with a stubbed measurement whose
 * answer differs from where the rail started. If the caller forgets to record the
 * answer, the baseline stays at its initial value and the mismatch shows up here.
 */
test("the measured rail state becomes the baseline the toggle listener compares against", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const start = html.indexOf("  function applyStageRailBudget(");
  assert.ok(start >= 0, "applyStageRailBudget() must remain in the shipped script");
  const end = html.indexOf("\n  stageOverview?.addEventListener", start);
  assert.ok(end > start, "applyStageRailBudget() must still be followed by the toggle listener it feeds");
  const source = html.slice(start, end);

  function runCaller({ decided }) {
    const cameraReconciles = [];
    const scope = new Function(
      `const { rail, canvas, decided, reconcileCamera } = arguments[0];
const stageOverview = rail;
const graph = canvas;
const viewportBudget = { minCanvasHeightPx: 360 };
let stageRailUserChoice = null;
let stageRailBudgetState = null;
function resolveStageRailOpenState({ rail: target }) {
  target.open = true;
  target.open = decided;
  return { open: decided, openCanvasHeightPx: decided ? 512 : 281 };
}
${source}
return { run: applyStageRailBudget, baseline: () => stageRailBudgetState };`,
    )({
      rail: { open: false, clientHeight: 0 },
      canvas: { clientHeight: 0, offsetHeight: 0 },
      decided,
      reconcileCamera: () => cameraReconciles.push(true),
    });
    scope.run();
    return { baseline: scope.baseline(), cameraReconciles: cameraReconciles.length };
  }

  const collapsed = runCaller({ decided: false });
  assert.strictEqual(
    collapsed.baseline,
    false,
    "a rail the measurement left closed must be recorded as closed, so the probe's own toggle is not read as a click",
  );
  assert.strictEqual(
    collapsed.cameraReconciles,
    0,
    "a rail that starts closed and is measured closed did not change, so the camera has nothing to redo",
  );

  const expanded = runCaller({ decided: true });
  assert.strictEqual(expanded.baseline, true, "a rail the measurement left open must be recorded as open");
  assert.strictEqual(
    expanded.cameraReconciles,
    1,
    "a rail that ends in a different state than it started changed the canvas, so the camera must be redone once",
  );
});

/**
 * The grid arrangement reserves gutters between the columns and a lane above each
 * row, then routes every child edge through them. Two assertions elsewhere pin the
 * routing function's name and the order it runs in relative to the edge loop, which
 * is not the same as knowing where the line goes: a corner-to-corner curve satisfies
 * both and still passes behind every sibling sharing the target's row.
 *
 * These run the shipped geometry against hand-computed coordinates. Each case is a
 * separate branch, so a mutation that collapses one leaves the others green and the
 * failure names the branch that broke.
 */
test("a child in the searched grid is routed along its reserved gutters, not corner to corner", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const edgeGeometry = new Function(
    `${shippedHelper(html, "edgePortSlot")}
${shippedHelper(html, "edgeGeometry")}
return edgeGeometry;`,
  )();

  // The bus is inside the source's own width, so there is no sideways run to make:
  // the line leaves the bottom edge at the bus and drops to the lane.
  const throughSource = edgeGeometry(
    { x: 100, y: 100, width: 200, height: 60 },
    { x: 500, y: 400, width: 200, height: 60, busX: 180, laneY: 360 },
  );
  assert.strictEqual(
    throughSource.path,
    "M 180 160 V 360 H 600 V 400",
    "a bus inside the source's span must be entered from the source's bottom edge, with no sideways run first",
  );
  assert.strictEqual(throughSource.x1, 180, "the line must start on the bus, not at the card's centre");
  assert.strictEqual(throughSource.y1, 160, "the line must leave the source's bottom edge");

  // The bus is to the right and outside the source, so the line has to travel out
  // of the side first. It leaves at the source's vertical centre, not a port slot.
  const busRight = edgeGeometry(
    { x: 100, y: 100, width: 200, height: 60 },
    { x: 500, y: 400, width: 200, height: 60, busX: 420, laneY: 360 },
  );
  assert.strictEqual(
    busRight.path,
    "M 300 130 H 420 V 360 H 600 V 400",
    "a bus to the right must be reached from the source's right edge along a horizontal run",
  );

  // Mirror image. If the exit side were fixed rather than chosen, this line would
  // start at the far edge and cross the whole card to get to the bus.
  const busLeft = edgeGeometry(
    { x: 400, y: 100, width: 200, height: 60 },
    { x: 100, y: 400, width: 200, height: 60, busX: 60, laneY: 360 },
  );
  assert.strictEqual(
    busLeft.path,
    "M 400 130 H 60 V 360 H 200 V 400",
    "a bus to the left must be reached from the source's left edge, not by crossing the card",
  );
  assert.strictEqual(busLeft.x1, 400, "the exit side must follow the bus, so a left-hand bus exits left");

  for (const [label, routed] of [["through-source", throughSource], ["right", busRight], ["left", busLeft]]) {
    assert.ok(
      !routed.path.includes("C"),
      label + " routing must stay orthogonal: a curve cuts the corner and passes behind the target's siblings",
    );
  }

  // The layered path has no bus to follow, so it must keep its curve. Without this
  // case an implementation that always routed orthogonally would satisfy every
  // assertion above, and the gate that picks between the two would be untested.
  const layered = edgeGeometry(
    { x: 100, y: 100, width: 200, height: 60, spine: true },
    { x: 100, y: 400, width: 200, height: 60, spine: false },
    { layoutKind: "fanout" },
  );
  assert.ok(
    layered.path.includes("C"),
    "an edge with no reserved bus must fall back to the curve, so the orthogonal route stays gated on the arrangement",
  );
  assert.ok(
    !layered.path.includes("undefined"),
    "the fallback must not read bus coordinates that were never reserved",
  );
});

/**
 * The lane a child's horizontal run travels down is reserved while the cards are
 * still nominal heights. A card that renders taller than budgeted swallows the gap
 * the lane was placed in, which would send the run straight across it. The page
 * re-centres the lane in the gap that exists after measuring.
 *
 * The function under test writes to the DOM, so its closure values are injected as
 * parameters. That couples this guard to the set of names it closes over: a new
 * dependency shows up here as a reference error rather than a behavioural failure,
 * and the fix is to inject the new name, not to loosen an assertion.
 */
test("a lane reserved before measuring is re-centred into the gap the rendered cards leave", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const graphLayout = {
    scenePaddingPx: { right: 48, bottom: 42 },
    sceneMinimumPx: { entityWidth: 100, entityHeight: 100 },
    renderedColumnGapPx: 24,
  };
  const positions = new Map([
    ["a", { x: 0, y: 0, width: 200, height: 60 }],
    ["b", { x: 0, y: 120, width: 200, height: 60, laneY: 90 }],
    ["c", { x: 400, y: 0, width: 200, height: 60 }],
    ["d", { x: 400, y: 120, width: 200, height: 60 }],
  ]);
  const renderedHeights = { a: 200, b: 60, c: 300, d: 60 };
  const graphState = {
    nodeElements: new Map(
      Object.entries(renderedHeights).map(([id, height]) => [id, {
        offsetHeight: height,
        scrollHeight: height,
        style: {},
        getBoundingClientRect: () => ({ height }),
      }]),
    ),
  };
  const syncLayoutToRenderedCards = new Function(
    "GRAPH_LAYOUT",
    "graphState",
    "graphScene",
    "edgeLayer",
    "graph",
    `${shippedHelper(html, "measureRenderedCardHeights")}
${shippedHelper(html, "syncLayoutToRenderedCards")}
return syncLayoutToRenderedCards;`,
  )(graphLayout, graphState, null, null, { dataset: { semanticZoom: "card" } });

  const layout = { positions, bounds: { width: 0, height: 0 } };
  syncLayoutToRenderedCards(layout);

  // The card above renders 200 tall instead of 60, so its bottom lands at 200 and
  // the next card is pushed to 200 + 24. The only gap left is 200..224.
  assert.strictEqual(positions.get("a").height, 200, "a card's measured height must replace the budgeted one");
  assert.strictEqual(positions.get("b").y, 224, "the card below must be pushed clear of the measured card above it");
  assert.strictEqual(
    positions.get("b").laneY,
    212,
    "the lane must be re-centred in the gap the measured cards leave, not left at the 90 the layout budgeted",
  );
  assert.ok(
    positions.get("b").laneY > 200 && positions.get("b").laneY < 224,
    "a lane outside the real gap would put the horizontal run inside a card",
  );

  assert.ok(
    !Object.hasOwn(positions.get("d"), "laneY"),
    "a position that reserved no lane must not be given one, or the edge router reads a bus route that was never planned",
  );

  // Both columns grew, so the scene has to grow with them. Bounds taken from the
  // budgeted heights would be 222 tall and the camera would fit against a block
  // the render then overflows.
  assert.deepEqual(
    layout.bounds,
    { width: 648, height: 426 },
    "the scene bounds must be recomputed from the measured cards, so the camera fits what is actually drawn",
  );
  assert.deepEqual(graphState.bounds, layout.bounds, "the camera reads bounds off graphState, so both must agree");
});

/**
 * The scene carries the camera's transform, so a client rect taken inside it answers
 * in screen pixels while the layout it feeds is written in world pixels. Mixing the
 * two makes the reservation - and therefore the spacing between rows - a function of
 * wherever the zoom happened to be sitting when the layout last ran.
 *
 * The fixture has to make the two disagree. A stub that returns the same number for
 * both is satisfied by the contaminated expression and by the correct one alike.
 */
test("a card's reservation is its layout height, not its height after the camera's transform", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const graphLayout = {
    scenePaddingPx: { right: 48, bottom: 42 },
    sceneMinimumPx: { entityWidth: 100, entityHeight: 100 },
    renderedColumnGapPx: 24,
  };
  const cameraScale = 1.0799;
  const layoutHeight = 362;
  const card = {
    offsetHeight: layoutHeight,
    scrollHeight: layoutHeight,
    style: {},
    getBoundingClientRect: () => ({ height: layoutHeight * cameraScale }),
  };
  const positions = new Map([["a", { x: 0, y: 0, width: 200, height: 333 }]]);
  const syncLayoutToRenderedCards = new Function(
    "GRAPH_LAYOUT",
    "graphState",
    "graphScene",
    "edgeLayer",
    "graph",
    `${shippedHelper(html, "measureRenderedCardHeights")}
${shippedHelper(html, "syncLayoutToRenderedCards")}
return syncLayoutToRenderedCards;`,
  )(graphLayout, { nodeElements: new Map([["a", card]]) }, null, null, { dataset: { semanticZoom: "card" } });

  syncLayoutToRenderedCards({ positions, bounds: { width: 0, height: 0 } });

  assert.strictEqual(
    positions.get("a").height,
    layoutHeight,
    "reserving the transformed height makes row spacing depend on the zoom at relayout time",
  );
});

/**
 * Cell presentation clamps every card to the cell band, so a height read while the
 * canvas is drawing cells is the band's height and not the card's. The camera picks
 * the presentation and the layout does not control when that happens, so the
 * measurement has to name the presentation it wants rather than inherit one.
 */
test("a card is measured as a card even while the canvas is drawing cells", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const graphLayout = {
    scenePaddingPx: { right: 48, bottom: 42 },
    sceneMinimumPx: { entityWidth: 100, entityHeight: 100 },
    renderedColumnGapPx: 24,
  };
  const graph = { dataset: { semanticZoom: "cell" } };
  const cellBandHeight = 140;
  const cardHeight = 362;
  const heightForPresentation = () => (graph.dataset.semanticZoom === "cell" ? cellBandHeight : cardHeight);
  const card = {
    get offsetHeight() { return heightForPresentation(); },
    get scrollHeight() { return heightForPresentation(); },
    style: {},
    getBoundingClientRect: () => ({ height: heightForPresentation() }),
  };
  const positions = new Map([["a", { x: 0, y: 0, width: 200, height: 60 }]]);
  const syncLayoutToRenderedCards = new Function(
    "GRAPH_LAYOUT",
    "graphState",
    "graphScene",
    "edgeLayer",
    "graph",
    `${shippedHelper(html, "measureRenderedCardHeights")}
${shippedHelper(html, "syncLayoutToRenderedCards")}
return syncLayoutToRenderedCards;`,
  )(graphLayout, { nodeElements: new Map([["a", card]]) }, null, null, graph);

  syncLayoutToRenderedCards({ positions, bounds: { width: 0, height: 0 } });

  assert.strictEqual(
    positions.get("a").height,
    cardHeight,
    "reserving the cell band leaves the card short of room the moment the viewer zooms in",
  );
});

test("measuring restores the presentation the camera had chosen", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const graphLayout = {
    scenePaddingPx: { right: 48, bottom: 42 },
    sceneMinimumPx: { entityWidth: 100, entityHeight: 100 },
    renderedColumnGapPx: 24,
  };
  const graph = { dataset: { semanticZoom: "cell" } };
  const card = { offsetHeight: 362, scrollHeight: 362, style: {}, getBoundingClientRect: () => ({ height: 362 }) };
  const syncLayoutToRenderedCards = new Function(
    "GRAPH_LAYOUT",
    "graphState",
    "graphScene",
    "edgeLayer",
    "graph",
    `${shippedHelper(html, "measureRenderedCardHeights")}
${shippedHelper(html, "syncLayoutToRenderedCards")}
return syncLayoutToRenderedCards;`,
  )(graphLayout, { nodeElements: new Map([["a", card]]) }, null, null, graph);

  syncLayoutToRenderedCards({ positions: new Map([["a", { x: 0, y: 0, width: 200, height: 60 }]]), bounds: {} });

  assert.strictEqual(
    graph.dataset.semanticZoom,
    "cell",
    "leaving the forced presentation behind would draw full cards at a scale the camera rejected as illegible",
  );
});

/**
 * The reservation is written back onto the card as an inline min-height, so the next
 * pass measures a card the previous pass already inflated. Without clearing it first
 * the height can only ever climb: one relayout at the wrong zoom raises it, and every
 * later pass reads its own old answer back as if it were a measurement.
 */
test("a reservation left on the card by an earlier pass does not floor the next measurement", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const graphLayout = {
    scenePaddingPx: { right: 48, bottom: 42 },
    sceneMinimumPx: { entityWidth: 100, entityHeight: 100 },
    renderedColumnGapPx: 24,
  };
  const naturalHeight = 200;
  const style = { minHeight: "500px" };
  const heightUnderStyle = () => Math.max(naturalHeight, Number.parseFloat(style.minHeight) || 0);
  const card = {
    get offsetHeight() { return heightUnderStyle(); },
    get scrollHeight() { return heightUnderStyle(); },
    style,
    getBoundingClientRect: () => ({ height: heightUnderStyle() }),
  };
  const positions = new Map([["a", { x: 0, y: 0, width: 200, height: 60 }]]);
  const syncLayoutToRenderedCards = new Function(
    "GRAPH_LAYOUT",
    "graphState",
    "graphScene",
    "edgeLayer",
    "graph",
    `${shippedHelper(html, "measureRenderedCardHeights")}
${shippedHelper(html, "syncLayoutToRenderedCards")}
return syncLayoutToRenderedCards;`,
  )(graphLayout, { nodeElements: new Map([["a", card]]) }, null, null, { dataset: { semanticZoom: "card" } });

  syncLayoutToRenderedCards({ positions, bounds: { width: 0, height: 0 } });

  assert.strictEqual(
    positions.get("a").height,
    naturalHeight,
    "a reservation that reads back its own previous answer can only ratchet upward",
  );
  assert.strictEqual(style.minHeight, naturalHeight + "px", "the card must be left holding the height that was measured");
});

/**
 * "上面的文字 为啥要一行显示省略号 … 下面明明有空隙但是非得弄成两行" — the
 * workspace board header's run-boundary line deleted its own tail on one line while
 * the header it sits in was a `min-height` box with room to grow directly under it.
 *
 * That line names which part of a run the board is scoped to, so the discarded part
 * is the scope the reader came to read. Four claims move together here and each is
 * separately breakable, so they are asserted separately:
 *
 *  - nothing reaching the line may discard its tail, in any media branch
 *  - a wrapped run still needs a line cap, or the header grows without bound
 *  - the gap to the title above it is the ladder's text floor, not the padding step
 *  - the leading has to be a family the text floor governs, or the two lines the
 *    clamp now permits sit pressed together and the fix trades one defect for another
 */
test("the board header's run boundary wraps to a second line instead of deleting its tail", () => {
  const rules = stylesheetRules(renderLiveControlRoomPage({ snapshot: snapshotFixture }));
  const spacing = loadLiveSpacingScale();
  const selector = ".company-board-header p";

  // Collected by descendant match rather than by this one spelling, so a `nowrap`
  // reintroduced through a narrow-width branch cannot slip past.
  const reaching = rules
    .flatMap((rule) => rule.selectors)
    .filter((candidate) => /\.company-board-header\b[\s>]+p\b/u.test(candidate));
  assert.ok(reaching.length >= 1, `no rule reaches ${selector}, so this guard checks nothing`);
  for (const candidate of reaching) {
    assert.deepEqual(
      declaredValues(rules, { selector: candidate, property: "text-overflow" }),
      [],
      `${candidate} declares text-overflow, which throws away the run scope before line two is offered`,
    );
    for (const value of declaredValues(rules, { selector: candidate, property: "white-space" })) {
      assert.notEqual(
        normalizedValue(value),
        "nowrap",
        `${candidate} refuses to wrap, so any clamp on it can never reach a second line`,
      );
    }
  }

  assert.equal(
    resolvedDeclaration(rules, { selector, property: "display" }),
    "-webkit-box",
    `${selector} needs the box display, or -webkit-line-clamp is inert and the header grows unbounded`,
  );
  assert.equal(resolvedDeclaration(rules, { selector, property: "-webkit-box-orient" }), "vertical");
  assert.equal(resolvedDeclaration(rules, { selector, property: "overflow" }), "hidden");
  assert.equal(
    lineClampCount(rules, resolvedDeclaration(rules, { selector, property: "-webkit-line-clamp" })),
    2,
    `${selector} must clamp at two lines: one is the ellipsis again, none is an unbounded header`,
  );

  const margin = resolvedDeclaration(rules, { selector, property: "margin" });
  assert.ok(margin, `${selector} must declare its own separation from the title above it`);
  const topMargin = lengthToPixels(splitTopLevel(margin)[0]);
  assert.equal(topMargin, 8, "the gap under the board title is the measured value this fix was written for");
  assert.ok(
    topMargin >= spacing.textAdjacency.minimumPx,
    `${topMargin}px is under the ${spacing.textAdjacency.minimumPx}px the ladder declares as the text floor`,
  );

  const leading = resolvedDeclaration(rules, { selector, property: "line-height" });
  const family = /^var\(--lh-([a-z0-9-]+)\)$/u.exec(String(leading).trim());
  assert.ok(family, `${selector} leads with ${leading} instead of a leading family`);
  assert.ok(
    spacing.textAdjacency.appliesToLeadingFamilies.includes(family[1]),
    `${selector} now wraps to two lines on the "${family[1]}" leading, which the text floor does not cover `
      + `(it covers ${spacing.textAdjacency.appliesToLeadingFamilies.join(", ")}), so the two lines stay pressed together`,
  );
});

/**
 * The same board header measured 1803px of content inside a 1075px box, which put
 * its "查看运行图" button 728px past the header's right edge — off a 1707px screen
 * entirely. The button was unreachable and the title's ellipsis never fired, so the
 * title overflowed instead of shortening.
 *
 * Nothing about the title rule was wrong. A flex item's `min-width` defaults to
 * `auto`, which is its min-content width, and a `nowrap` title has no min-content
 * width smaller than the whole string. So the block holding the title refused to
 * shrink and pushed its sibling out. The top bar already carries the fix as
 * `.run-context-heading { min-width: 0 }`; these headers never got it.
 *
 * Two claims, each breakable on its own:
 *
 *  - whatever element directly holds an ellipsizing title must be allowed to shrink,
 *    or the ellipsis is decoration and the header overflows in its place
 *  - the cluster beside the title must stay pinned, which is what makes the title
 *    block the only place the shrinking can come from
 *
 * The headers are collected from the rule that grants the ellipsis rather than from
 * a list written here, so a fourth header joining that rule is covered on the day it
 * joins rather than on the day someone remembers to extend this test.
 */
test("a header that shortens its title lets the title block shrink, so its own actions stay inside it", () => {
  const html = renderLiveControlRoomPage({ snapshot: snapshotFixture });
  const rules = stylesheetRules(html);

  const declares = (rule, property, expected) =>
    rule.declarations.some(([name, value]) => name === property && normalizedValue(value) === expected);
  const ellipsizedTitles = rules
    .filter((rule) => declares(rule, "text-overflow", "ellipsis") && declares(rule, "white-space", "nowrap"))
    .flatMap((rule) => rule.selectors)
    .filter((selector) => /^\.company-[a-z-]+-header h2$/u.test(selector));
  assert.ok(
    ellipsizedTitles.length >= 1,
    "no company header shortens its title any more, so this guard is checking nothing",
  );

  // The element that directly holds the title, read off the markup rather than
  // assumed, because the wrapper is exactly the thing that goes missing.
  const holderOfTitle = (block) => {
    const stack = [];
    const tag = /<(\/?)([a-z0-9]+)((?:[^>"]|"[^"]*")*)>/giu;
    for (let match = tag.exec(block); match !== null; match = tag.exec(block)) {
      const [, closing, name, attributes] = match;
      if (name === "h2" && !closing) return stack.at(-1) ?? null;
      if (closing) stack.pop();
      else if (!attributes.trimEnd().endsWith("/")) stack.push(attributes);
    }
    return null;
  };

  for (const titleSelector of ellipsizedTitles) {
    const headerClass = titleSelector.replace(/ h2$/u, "").slice(1);
    const block = new RegExp(`<header class="${headerClass}"[^>]*>.*?</header>`, "su").exec(html)?.[0] ?? null;
    assert.ok(block, `${headerClass} has a rule but no markup, so the rule shortens nothing`);

    const holder = holderOfTitle(block);
    assert.ok(holder !== null, `no element in ${headerClass} holds the title the rule shortens`);
    const holderClasses = (/class="([^"]*)"/u.exec(holder)?.[1] ?? "").split(/\s+/u).filter(Boolean);
    const shrinkable = holderClasses.filter(
      (name) => normalizedValue(resolvedDeclaration(rules, { selector: `.${name}`, property: "min-width" }) ?? "") === "0",
    );
    assert.ok(
      shrinkable.length >= 1,
      `the block holding ${headerClass}'s title (${holderClasses.join(".") || "unclassed"}) keeps its automatic minimum `
        + "width, so it cannot shrink below the whole title and pushes the header's own actions out of it instead of shortening",
    );
  }

  // The shrink has to come from somewhere. If the cluster beside the title were
  // allowed to give way, it would be the button that collapsed rather than the
  // title that shortened, and the fix above would be pointing at the wrong item.
  const actions = resolvedDeclaration(rules, { selector: ".company-board-actions", property: "flex" });
  assert.equal(
    normalizedValue(String(actions)),
    "0 0 auto",
    `.company-board-actions declares flex: ${actions}, so it absorbs the shrink instead of the title block`,
  );
});

/**
 * `.work-surface-header p` sat 6px under the title it explains, on a leading family
 * the ladder's 8px text floor covers. It shipped because the spacing guards sweep
 * `padding` and `gap` and never `margin`, and the ladder's own words are that
 * "Text-run gaps are held to textAdjacency.minimumPx on top of this" — which a top
 * margin on the lower run is, expressed on the child instead of on the container.
 *
 * The set is derived from the stylesheet, not written here, so the next text run
 * added under the floor turns this red without anyone remembering to extend it.
 * Two things put a rule in scope and both are read off the rule itself:
 *
 *  - it declares a leading family the floor governs, which is how the ladder already
 *    separates wrapped prose from a single-line control whose padding IS its height
 *  - its top margin is directional — `margin-top`, or a shorthand whose other sides
 *    collapse to 0 — which is a deliberate separation from whatever precedes it. A
 *    uniform `margin: X` is an inset from a container, and the ladder holds that to
 *    the 6px box floor instead, which is why the two bordered empty-state boxes that
 *    also carry 6px are not defects and are not dragged in here.
 */
test("no text run sits closer to the run above it than the ladder's own text floor", () => {
  const rules = stylesheetRules(renderLiveControlRoomPage({ snapshot: snapshotFixture }));
  const spacing = loadLiveSpacingScale();
  const governed = new Set(spacing.textAdjacency.appliesToLeadingFamilies);

  const directionalTopMargin = (rule) => {
    const explicit = rule.declarations.findLast(([name]) => name === "margin-top")?.[1];
    if (explicit !== undefined) return explicit;
    const shorthand = rule.declarations.findLast(([name]) => name === "margin")?.[1];
    if (shorthand === undefined) return null;
    const sides = splitTopLevel(shorthand);
    if (sides.length === 1) return null;
    return sides.slice(1).every((side) => lengthToPixels(side) === 0) ? sides[0] : null;
  };

  const separated = [];
  for (const rule of rules) {
    const leading = rule.declarations.findLast(([name]) => name === "line-height")?.[1];
    const family = /^var\(--lh-([a-z0-9-]+)\)$/u.exec(String(leading ?? "").trim())?.[1];
    if (!family || !governed.has(family)) continue;
    const declared = directionalTopMargin(rule);
    if (declared === null) continue;
    const top = lengthToPixels(declared);
    if (top === null || top === 0) continue;
    separated.push({ selectors: rule.selectors.join(", "), declared, top });
  }

  assert.ok(
    separated.length >= 3,
    `only ${separated.length} text runs declare their own separation from the run above them, which is fewer than `
      + "the page shipped with, so this sweep has stopped seeing them rather than found them all compliant",
  );
  assert.ok(
    separated.some((entry) => entry.selectors === ".work-surface-header p"),
    "the rule this sweep was written for is no longer in scope, so a green result here says nothing about it",
  );
  assert.deepEqual(
    separated.filter((entry) => entry.top < spacing.textAdjacency.minimumPx),
    [],
    `these text runs sit closer to the run above them than the ${spacing.textAdjacency.minimumPx}px the ladder `
      + "declares for a text-run gap, which is the density the maintainer called painful to look at",
  );
});
