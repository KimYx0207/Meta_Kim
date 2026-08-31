#!/usr/bin/env node
// Materialize the P1.1 Claude Code real active run from a data fixture into
// `.meta-kim/state/default/governed-executions/<runId>.live.json`.
//
// Layering:
//   - data        : `fixtures/live-acceptance/claude-code-real-run.json`
//   - application : `src/application/live/live-acceptance-fixture-loader.mjs`
//                   (pure: fixture → governed artifact; no node/edge/evidence facts)
//   - service     : `buildLiveCompactProjection` + `serializeLiveCompactProjection`
//                   (canonical projection pipeline; same code path as real runs)
//   - presentation: this CLI; only writes the projection file.
//
// Hard rules:
//   - No node/edge/evidence/capability values are hardcoded here. All flow
//     through the loader from the fixture.
//   - Refuses to overwrite an existing `.live.json` unless LIVE_FORCE=1.
//   - The fixture's `{startBase}` placeholders resolve against a fresh base
//     timestamp so a re-run produces a stable, monotonic timeline.

import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  buildGovernedArtifact,
  resolveFixture,
} from "../src/application/live/live-acceptance-fixture-loader.mjs";
import {
  buildLiveCompactProjection,
  serializeLiveCompactProjection,
} from "../src/application/live/live-control-room-service.mjs";

const FIXTURE_PATH = path.resolve(
  process.cwd(),
  process.env.LIVE_FIXTURE_PATH ||
    "fixtures/live-acceptance/claude-code-real-run.json",
);
const STATE_DIR = path.resolve(
  process.cwd(),
  process.env.LIVE_STATE_DIR || ".meta-kim/state/default/governed-executions",
);
const RUN_ID = process.env.LIVE_RUN_ID;

const BASE_ISO = new Date().toISOString();

function ensureRunId(value) {
  if (!value || typeof value !== "string") {
    throw new Error("LIVE_RUN_ID is required and must be a non-empty string");
  }
  if (value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new Error("LIVE_RUN_ID must not contain path separators or traversal sequences");
  }
  return value;
}

async function fileExists(target) {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const runId = ensureRunId(RUN_ID);
  const fixtureRaw = await readFile(FIXTURE_PATH, "utf8");
  const fixture = JSON.parse(fixtureRaw);
  const resolved = resolveFixture(fixture, BASE_ISO);
  const artifact = buildGovernedArtifact(resolved, runId, BASE_ISO);
  const projection = buildLiveCompactProjection(artifact);
  const serialized = serializeLiveCompactProjection(projection);

  await mkdir(STATE_DIR, { recursive: true });
  const targetPath = path.join(STATE_DIR, `${runId}.live.json`);
  if (await fileExists(targetPath)) {
    if (process.env.LIVE_FORCE !== "1") {
      console.error(`[live-acceptance] refusing to overwrite existing ${targetPath}`);
      console.error("Set LIVE_FORCE=1 to overwrite.");
      process.exitCode = 2;
      return;
    }
    console.warn(`[live-acceptance] overwriting existing ${targetPath} because LIVE_FORCE=1`);
  }
  await writeFile(targetPath, serialized, "utf8");

  const summary = {
    runId,
    fixturePath: FIXTURE_PATH,
    targetPath,
    projectedNodes: projection.nodes.length,
    projectedEdges: projection.edges.length,
    hostEvidenceRows: projection.evidence.length,
    toolCalls: projection.toolCalls.length,
    replay: projection.replay.length,
    sessionRuntime: projection.session?.runtime,
    sessionMode: projection.session?.mode,
    sessionProofState: projection.session?.proofState,
    conversationLinkState: projection.run?.conversationLinkState,
    conversationRef: projection.run?.conversationRef,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}

main().catch((error) => {
  console.error("[live-acceptance] failed:", error);
  process.exit(1);
});