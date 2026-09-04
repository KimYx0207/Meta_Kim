#!/usr/bin/env node
// Materialize the P1.1 Claude Code acceptance run from a data fixture into a
// Live compact projection file.
//
// Layering:
//   - data        : `fixtures/live-acceptance/claude-code-real-run.json`
//   - application : `src/application/live/live-acceptance-fixture-loader.mjs`
//                   (pure: fixture → governed artifact; no node/edge/evidence facts)
//   - service     : `buildLiveCompactProjection` + `serializeLiveCompactProjection`
//                   (canonical projection pipeline; same code path as real runs)
//   - presentation: this CLI; only resolves the target and writes the file.
//
// Hard rules:
//   - No node/edge/evidence/capability values are hardcoded here. All flow
//     through the loader from the fixture.
//   - The loader stamps every artifact as a fixture, so the written record says
//     what it is. This CLI additionally keeps it out of the directory that holds
//     real run history unless that is explicitly asked for.
//   - Refuses to overwrite an existing `.live.json` unless LIVE_FORCE=1.
//   - The fixture's `{startBase}` placeholders resolve against a fresh base
//     timestamp so a re-run produces a stable, monotonic timeline.

import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  buildGovernedArtifact,
  resolveFixture,
} from "../src/application/live/live-acceptance-fixture-loader.mjs";
import {
  buildLiveCompactProjection,
  serializeLiveCompactProjection,
} from "../src/application/live/live-control-room-service.mjs";
import { liveRecordOrigin } from "../src/application/live/live-record-origin.mjs";

/**
 * Where a fixture goes when nobody says otherwise.
 *
 * Ignored scratch space, not project state. The stamp the loader applies makes a
 * fixture honest about itself; it does not stop one from accumulating in the
 * store the hub reads, where it is counted, retained, and offered as a default
 * landing row. Measured before this default existed: two fixture records sat in
 * `.meta-kim/state/default/governed-executions` among 44 rows and, being the only
 * two with worker counts and a resolved runtime, sorted above every real run.
 */
export const FIXTURE_STATE_DIR_DEFAULT = "tests/output/live-acceptance/governed-executions";

export const PROJECT_STATE_OPT_IN_ENV = "LIVE_ALLOW_PROJECT_STATE";

const RUN_STORE_DIR_NAME = "governed-executions";
const RUN_STORE_ROOT_NAME = ".meta-kim";

/**
 * Whether a directory is one the hub reads real run history from.
 *
 * Written against the three read paths that exist in this repo rather than
 * against one remembered string: `live-read-repository.mjs` and
 * `live-hub-project-catalog.mjs` both join `governed-executions` onto a
 * `.meta-kim/state/<profile>` root, and `live-run-retention-store.mjs` joins it
 * directly onto `.meta-kim`. Matching the leaf under any `.meta-kim` ancestor
 * covers both depths and any future profile name, where a fixed relative path
 * would only have covered the one profile that happened to be polluted.
 */
export function targetIsRealRunStore(targetDir) {
  if (typeof targetDir !== "string" || targetDir === "") return false;
  const segments = path.resolve(targetDir).split(path.sep).map((segment) => segment.toLowerCase());
  if (segments[segments.length - 1] !== RUN_STORE_DIR_NAME) return false;
  return segments.slice(0, -1).includes(RUN_STORE_ROOT_NAME);
}

/**
 * Resolve where this run may write, or refuse with a reason.
 *
 * A refusal returns no path at all, so a caller cannot read past the reason and
 * write anyway.
 */
export function resolveFixtureWriteTarget({ stateDir, allowProjectState = false, cwd = process.cwd() } = {}) {
  const requested = stateDir || FIXTURE_STATE_DIR_DEFAULT;
  const targetDir = path.resolve(cwd, requested);
  if (targetIsRealRunStore(targetDir) && allowProjectState !== true) {
    return {
      targetDir: null,
      refusal: `${targetDir} holds real run history; a fixture written there is retained and ranked alongside `
        + `genuine runs. Set ${PROJECT_STATE_OPT_IN_ENV}=1 to write there deliberately, or leave `
        + `LIVE_STATE_DIR unset to use ${FIXTURE_STATE_DIR_DEFAULT}.`,
    };
  }
  return { targetDir, refusal: null };
}

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

export async function main() {
  const fixturePath = path.resolve(
    process.cwd(),
    process.env.LIVE_FIXTURE_PATH || "fixtures/live-acceptance/claude-code-real-run.json",
  );
  const runId = ensureRunId(process.env.LIVE_RUN_ID);
  const { targetDir, refusal } = resolveFixtureWriteTarget({
    stateDir: process.env.LIVE_STATE_DIR,
    allowProjectState: process.env[PROJECT_STATE_OPT_IN_ENV] === "1",
  });
  if (refusal) {
    console.error(`[live-acceptance] refusing to write: ${refusal}`);
    process.exitCode = 2;
    return;
  }

  const baseIso = new Date().toISOString();
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const resolved = resolveFixture(fixture, baseIso);
  const artifact = buildGovernedArtifact(resolved, runId, baseIso);
  const projection = buildLiveCompactProjection(artifact);
  const serialized = serializeLiveCompactProjection(projection);

  await mkdir(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, `${runId}.live.json`);
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
    fixturePath,
    targetPath,
    recordOrigin: liveRecordOrigin(projection),
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

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("[live-acceptance] failed:", error);
    process.exit(1);
  });
}
