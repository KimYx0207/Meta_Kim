import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareLiveProjectionRecord } from "../../src/application/live/prepare-live-projection-record.mjs";
import { normalizeLiveProjectionBackfillPolicy } from "../../src/application/live/live-projection-backfill-policy.mjs";
import {
  applyLiveProjectionBackfill,
  planLiveProjectionBackfill,
} from "../../src/infrastructure/live/live-projection-backfill.mjs";
import {
  LIVE_MAX_JSON_BYTES,
  createLiveReadRepository,
} from "../../src/infrastructure/live/live-read-repository.mjs";

const SHIPPED_POLICY_PATH = new URL(
  "../../config/live/projection-backfill.json",
  import.meta.url,
);

const DECLARED_NODE_COUNT = 3;
const POINTER_PATH_PREFIX = ".meta-kim/state/default/governed-executions";

function stageDagPacket() {
  return {
    status: "planned_not_invoked",
    nodes: [
      { nodeId: "critical", stage: "critical", dependsOn: [] },
      { nodeId: "fetch", stage: "fetch", dependsOn: ["critical"] },
      { nodeId: "thinking", stage: "thinking", dependsOn: ["fetch"] },
    ],
  };
}

function artifactFixture(runId) {
  return {
    schemaVersion: "meta-theory-governed-execution-v1",
    runId,
    status: "completed",
    startedAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-01T00:05:00.000Z",
    coreLoop: { stageDagPacket: stageDagPacket() },
    workerTaskPackets: [],
    verificationPacket: { ok: true },
  };
}

async function tempProject(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-projection-backfill-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executionDir = path.join(root, ".meta-kim", "state", "default", "governed-executions");
  await fs.mkdir(executionDir, { recursive: true });
  return { root, executionDir };
}

async function seedRun(executionDir, runId, { stale = true, pointer = false } = {}) {
  const artifact = artifactFixture(runId);
  await fs.writeFile(path.join(executionDir, `${runId}.json`), `${JSON.stringify(artifact)}\n`, "utf8");

  const current = prepareLiveProjectionRecord(artifact);
  // A stale file is what the builder produced before it learned `declaredPlan`:
  // same run, same fold, one key short.
  const content = stale
    ? `${JSON.stringify({ ...current.projection, declaredPlan: undefined })}\n`
    : current.content;
  const projectionPath = path.join(executionDir, `${runId}.live.json`);
  await fs.writeFile(projectionPath, content, "utf8");

  if (pointer) {
    await fs.writeFile(
      path.join(executionDir, "latest.json"),
      `${JSON.stringify({
        runId,
        jsonPath: `${POINTER_PATH_PREFIX}/${runId}.json`,
        // The runner records this path relative to the project root, not to the
        // execution directory. A bare file name resolves outside the directory the
        // reader is willing to serve from, so it would silently fall back to the raw
        // artifact and the pointer assertions below would pass against a run that
        // never used the projection at all.
        liveProjectionPath: `${POINTER_PATH_PREFIX}/${runId}.live.json`,
        liveProjectionSha256: createHash("sha256").update(content, "utf8").digest("hex"),
        liveProjectionBytes: Buffer.byteLength(content, "utf8"),
      }, null, 2)}\n`,
      "utf8",
    );
  }
  return { projectionPath, content };
}

function fileDigest(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

test("a stale projection is reported without being rewritten in report mode", async (t) => {
  const { root, executionDir } = await tempProject(t);
  const seeded = await seedRun(executionDir, "meta-run-stale-report");

  const plan = await planLiveProjectionBackfill({ projectRoot: root });
  const entry = plan.entries.find((candidate) => candidate.runId === "meta-run-stale-report");
  assert.equal(entry.status, "needs_backfill");
  assert.ok(entry.addedKeys.includes("declaredPlan"));
  assert.equal(plan.counts.needs_backfill, 1);
  assert.equal(await fs.readFile(seeded.projectionPath, "utf8"), seeded.content);
});

test("apply rebuilds the projection so the declared plan lands on disk", async (t) => {
  const { root, executionDir } = await tempProject(t);
  await seedRun(executionDir, "meta-run-stale-apply");

  const plan = await planLiveProjectionBackfill({ projectRoot: root });
  const applied = await applyLiveProjectionBackfill(plan);
  assert.equal(applied.written.length, 1);

  const rewritten = JSON.parse(
    await fs.readFile(path.join(executionDir, "meta-run-stale-apply.live.json"), "utf8"),
  );
  assert.equal(rewritten.declaredPlan.declaredNodeCount, DECLARED_NODE_COUNT);
  // The rebuilt bytes must describe the run whose file they replaced. The compact
  // projection carries the id under `run`, not at the top level.
  assert.equal(rewritten.run.runId, "meta-run-stale-apply");
});

test("apply keeps the pointer digest and byte count consistent with the rebuilt file", async (t) => {
  const { root, executionDir } = await tempProject(t);
  await seedRun(executionDir, "meta-run-pointer-target", { pointer: true });

  const plan = await planLiveProjectionBackfill({ projectRoot: root });
  assert.equal(plan.pointerRunId, "meta-run-pointer-target");
  assert.equal(plan.entries[0].isPointerTarget, true);
  await applyLiveProjectionBackfill(plan);

  const projectionText = await fs.readFile(
    path.join(executionDir, "meta-run-pointer-target.live.json"),
    "utf8",
  );
  const pointer = JSON.parse(await fs.readFile(path.join(executionDir, "latest.json"), "utf8"));
  assert.equal(pointer.liveProjectionSha256, fileDigest(projectionText));
  assert.equal(pointer.liveProjectionBytes, Buffer.byteLength(projectionText, "utf8"));
});

test("the production reader serves the backfilled projection instead of falling back", async (t) => {
  const { root, executionDir } = await tempProject(t);
  await seedRun(executionDir, "meta-run-reader-path", { pointer: true });

  const stalePlan = await planLiveProjectionBackfill({ projectRoot: root });
  await applyLiveProjectionBackfill(stalePlan);

  const repository = createLiveReadRepository({ projectRoot: root });
  const served = await repository.readLatestArtifact();
  assert.equal(served.__source, "live_projection");
  assert.equal(served.declaredPlan.declaredNodeCount, DECLARED_NODE_COUNT);
  assert.equal(executionDir.endsWith("governed-executions"), true);
});

test("a projection already built by the current builder is left byte-identical", async (t) => {
  const { root, executionDir } = await tempProject(t);
  const seeded = await seedRun(executionDir, "meta-run-current", { stale: false });

  const plan = await planLiveProjectionBackfill({ projectRoot: root });
  const entry = plan.entries.find((candidate) => candidate.runId === "meta-run-current");
  assert.equal(entry.status, "up_to_date");
  const applied = await applyLiveProjectionBackfill(plan);
  assert.equal(applied.written.length, 0);
  assert.equal(await fs.readFile(seeded.projectionPath, "utf8"), seeded.content);
});

test("apply backs up the replaced projection with its original bytes", async (t) => {
  const { root, executionDir } = await tempProject(t);
  const seeded = await seedRun(executionDir, "meta-run-backup");

  const plan = await planLiveProjectionBackfill({ projectRoot: root });
  const applied = await applyLiveProjectionBackfill(plan);
  assert.ok(applied.backupDir);
  const backupPath = path.join(applied.backupDir, "meta-run-backup.live.json");
  assert.equal(await fs.readFile(backupPath, "utf8"), seeded.content);
  assert.notEqual(
    await fs.readFile(path.join(executionDir, "meta-run-backup.live.json"), "utf8"),
    seeded.content,
  );
});

test("maxRuns bounds the plan and records what it left out", async (t) => {
  const { root, executionDir } = await tempProject(t);
  await seedRun(executionDir, "meta-run-bounded-a");
  await seedRun(executionDir, "meta-run-bounded-b");

  const unbounded = await planLiveProjectionBackfill({ projectRoot: root });
  assert.equal(unbounded.entries.length, 2);
  assert.equal(unbounded.omittedRunCount, 0);

  const bounded = await planLiveProjectionBackfill({ projectRoot: root, maxRuns: 1 });
  assert.equal(bounded.entries.length, 1);
  assert.equal(bounded.omittedRunCount, 1);
});

test("the policy's artifact bound is what governs the artifact read", async (t) => {
  const { root, executionDir } = await tempProject(t);
  await seedRun(executionDir, "meta-run-bounded-artifact");

  // One byte admits no artifact at all. If the read ignored the policy and used the
  // reader's own default instead, this run would come back rebuildable.
  const policy = normalizeLiveProjectionBackfillPolicy({
    ...JSON.parse(await fs.readFile(SHIPPED_POLICY_PATH, "utf8")),
    maxArtifactBytes: 1,
  });
  const plan = await planLiveProjectionBackfill({ projectRoot: root, policy });
  const entry = plan.entries.find((candidate) => candidate.runId === "meta-run-bounded-artifact");
  assert.equal(entry.status, "artifact_unreadable");
  assert.equal(plan.counts.needs_backfill, 0);
});

test("the shipped artifact bound is never blinder than the panel's own reader", async () => {
  // The pass exists to maintain what the reader serves, so an artifact the panel
  // would read must never be one this pass refuses to look at. Measured on this
  // repository: the record `latest.json` points at carries a 15.5MB artifact, so a
  // bound at the reader's 8MB left precisely the served run stale.
  const policy = normalizeLiveProjectionBackfillPolicy(
    JSON.parse(await fs.readFile(SHIPPED_POLICY_PATH, "utf8")),
  );
  assert.ok(
    policy.maxArtifactBytes > LIVE_MAX_JSON_BYTES,
    `shipped maxArtifactBytes ${policy.maxArtifactBytes} must exceed the reader cap ${LIVE_MAX_JSON_BYTES}`,
  );
});

test("a projection without its artifact is reported instead of rebuilt", async (t) => {
  const { root, executionDir } = await tempProject(t);
  const seeded = await seedRun(executionDir, "meta-run-orphan");
  await fs.rm(path.join(executionDir, "meta-run-orphan.json"));

  const plan = await planLiveProjectionBackfill({ projectRoot: root });
  const entry = plan.entries.find((candidate) => candidate.runId === "meta-run-orphan");
  assert.equal(entry.status, "artifact_missing");
  const applied = await applyLiveProjectionBackfill(plan);
  assert.equal(applied.written.length, 0);
  assert.equal(await fs.readFile(seeded.projectionPath, "utf8"), seeded.content);
});
