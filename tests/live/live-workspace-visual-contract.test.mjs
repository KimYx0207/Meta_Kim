import assert from "node:assert/strict";
import test from "node:test";
import { LIVE_WORKSPACE_CSS } from "../../src/presentation/live/live-workspace-styles.mjs";

const token = name => {
  const match = LIVE_WORKSPACE_CSS.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "iu"));
  assert.ok(match, `missing shared visual token: ${name}`);
  return match[1];
};
const luminance = hex => {
  const rgb = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = rgb.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
};
const contrast = (one, two) => {
  const [bright, dark] = [luminance(one), luminance(two)].sort((a, b) => b - a);
  return (bright + .05) / (dark + .05);
};

test("the Live workspace keeps black backgrounds, fine gold graph frames and bright running emphasis", () => {
  const background = token("uw-bg");
  assert.ok(luminance(background) < .008, "the workspace background must read as true black");
  for (const name of ["uw-bg", "uw-surface", "uw-raised"]) {
    const rgb = [1, 3, 5].map(index => Number.parseInt(token(name).slice(index, index + 2), 16));
    assert.ok(Math.max(...rgb) - Math.min(...rgb) <= 2, `${name} must be neutral black rather than blue-gray`);
  }
  assert.ok(contrast(token("uw-ink"), background) >= 12, "primary copy needs strong contrast");
  assert.ok(contrast(token("uw-muted"), background) >= 6, "supporting information must remain readable");
  const focus = token("uw-accent");
  const focusRgb = [1, 3, 5].map(index => Number.parseInt(focus.slice(index, index + 2), 16));
  assert.ok(Math.max(...focusRgb) - Math.min(...focusRgb) <= 12, "selection and generic focus must stay neutral");
  const running = token("uw-running");
  const [red, green, blue] = [1, 3, 5].map(index => Number.parseInt(running.slice(index, index + 2), 16));
  assert.ok(red > green && green > blue, "running gold must stay warm, not blue or green");
  assert.ok(contrast(running, background) >= 10, "running gold must be visible on black");
  assert.match(LIVE_WORKSPACE_CSS, /\.uw-kg-node rect\s*\{[^}]*stroke:\s*var\(--uw-node-stroke\)/u,
    "ordinary graph node frames should use restrained gold while their fill stays dark");
  assert.match(LIVE_WORKSPACE_CSS, /\.uw-kg-node\[data-state="running"\] rect\s*,[^}]*var\(--uw-running\)/u,
    "running graph nodes should use a brighter gold border and distinct glow");
  assert.match(LIVE_WORKSPACE_CSS, /\.uw-kg-edge\[data-activity="observed-running"\]\s*\{[^}]*stroke:\s*var\(--uw-running\)/u,
    "animated running graph edges must be gold");
  assert.doesNotMatch(LIVE_WORKSPACE_CSS, /\.uw-nav-item\[aria-current="page"\][^}]*var\(--uw-running\)/u,
    "ordinary navigation selection must not imply active execution");
  assert.doesNotMatch(LIVE_WORKSPACE_CSS, /#(?:68e5ff|4bdfff|49dfff|52dfff|69e5ff)/iu,
    "the PRD graph, selection and ambient effects should not regress to cyan");
});

test("PRD adapts by available content width and motion is decorative and optional", () => {
  assert.match(LIVE_WORKSPACE_CSS, /container:\s*uw-content\s*\/\s*inline-size/u);
  assert.match(LIVE_WORKSPACE_CSS, /@container\s+uw-content\s*\(max-width:\s*1040px\)/u);
  assert.match(LIVE_WORKSPACE_CSS, /\.uw-knowledge-canvas\s*\{[^}]*min-height:\s*0/u,
    "short PRD graphs must not reserve a fixed-height empty band");
  assert.match(LIVE_WORKSPACE_CSS, /\.uw-prd-layout\s*>\s*\.uw-knowledge-graph\s*\{\s*position:\s*sticky/u);
  assert.match(LIVE_WORKSPACE_CSS, /\.uw-prd-layout\[data-prd-mode="module"\]\s*\{\s*grid-template-columns:\s*minmax\(0,1fr\)/u,
    "Module PRD should have a short relation strip followed by the full-width reading surface");
  assert.match(LIVE_WORKSPACE_CSS, /\.uw-knowledge-surface\s*\{\s*display:\s*grid/u,
    "The PRD must combine relationships with source-backed module navigation instead of leaving an empty half-screen");
  assert.match(LIVE_WORKSPACE_CSS, /@container\s+uw-content\s*\(max-width:\s*490px\)\s*\{\s*\.uw-knowledge-map\s*\{\s*display:\s*none/u,
    "Narrow phones must switch to the full-width navigable source-backed relationship list, rather than clip SVG nodes");
  assert.match(LIVE_WORKSPACE_CSS, /\.uw-knowledge-canvas::before\s*\{[^}]*animation:\s*uw-radar-sweep/u);
  assert.match(LIVE_WORKSPACE_CSS, /\.uw-body::before\s*\{[^}]*animation:\s*uw-ambient-field/u,
    "ambient motion can occupy unused workspace space without impersonating task progress");
  assert.match(LIVE_WORKSPACE_CSS, /\.uw-kg-edge\[data-activity="observed-running"\]/u);
  assert.match(LIVE_WORKSPACE_CSS, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*animation:\s*none\s*!important/u);
});
