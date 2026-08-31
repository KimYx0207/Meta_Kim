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
    for (const replayOpen of [false, true]) {
      const budget = evaluateViewportChromeBudget(profile, config.chromeBudget, { replayOpen, dense: true });
      assert.ok(
        budget.fits,
        `${profile.label}: replayOpen=${replayOpen} leaves ${budget.canvasHeightPx}px, below the ${budget.minCanvasHeightPx}px canvas floor`,
      );
    }
  }
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
