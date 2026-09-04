import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLiveControlRoomService } from "../../src/application/live/live-control-room-service.mjs";
import { createLiveReadRepository } from "../../src/infrastructure/live/live-read-repository.mjs";

// The project catalog enumerates a session from `runs/<runId>/status.json` on
// disk. Snapshot reads used to consult only the governed artifact and the single
// newest durable record, so an older run the catalog had already listed opened
// as an empty panel that claimed its record could not be read. These tests hold
// the two endpoints to the same source of truth.

const OBSERVED_AT = "2026-08-31T12:00:00.000Z";
const ACTIVE_RUN_ID = "meta-2026-08-31t11-59-30-000z-2161b9a31b11";
const HISTORICAL_RUN_ID = "meta-2026-07-05T15-47-49-695Z";
const OLDER_HISTORICAL_RUN_ID = "meta-2026-06-11T08-02-13-117Z";
const MISLABELLED_RUN_ID = "meta-2026-05-02T04-04-04-004Z";

function statusRecord({
  runId,
  updatedAt,
  active = false,
  lifecycleStatus = "archived_legacy",
  stageIndex = 2,
  currentStage = "Fetch",
}) {
  return {
    schemaVersion: 2,
    runId,
    active,
    lifecycleStatus,
    currentStage,
    currentStageKey: currentStage.toLowerCase(),
    stageIndex,
    stageTotal: 8,
    completed: [],
    startedAt: updatedAt,
    updatedAt,
  };
}

async function writeRunStatus(stateDir, runId, record) {
  const runDir = path.join(stateDir, "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "status.json"), JSON.stringify(record), "utf8");
}

async function projectWithHistory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-kim-live-history-"));
  await mkdir(path.join(root, ".git"));
  const stateDir = path.join(root, ".meta-kim", "state", "default");
  await mkdir(stateDir, { recursive: true });

  const activeRecord = statusRecord({
    runId: ACTIVE_RUN_ID,
    updatedAt: "2026-08-31T11:59:30.000Z",
    active: true,
    lifecycleStatus: "active",
    stageIndex: 4,
    currentStage: "Execution",
  });
  await writeFile(path.join(stateDir, "active-run.json"), JSON.stringify(activeRecord), "utf8");
  await writeRunStatus(stateDir, ACTIVE_RUN_ID, activeRecord);
  await writeRunStatus(
    stateDir,
    HISTORICAL_RUN_ID,
    statusRecord({ runId: HISTORICAL_RUN_ID, updatedAt: "2026-07-05T15:47:49.695Z" }),
  );
  await writeRunStatus(
    stateDir,
    OLDER_HISTORICAL_RUN_ID,
    statusRecord({ runId: OLDER_HISTORICAL_RUN_ID, updatedAt: "2026-06-11T08:02:13.117Z" }),
  );

  return { root, stateDir };
}

function serviceFor(root) {
  const repository = createLiveReadRepository({ projectRoot: root });
  return createLiveControlRoomService({ repository, clock: () => new Date(OBSERVED_AT) });
}

async function enumerateRunIds(stateDir) {
  const entries = await readdir(path.join(stateDir, "runs"), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

test("a historical run keeps its own identity instead of reading as an unreadable record", async () => {
  const { root } = await projectWithHistory();
  try {
    const service = serviceFor(root);
    const snapshot = await service.getSnapshot(HISTORICAL_RUN_ID);

    assert.equal(snapshot.run?.runId, HISTORICAL_RUN_ID);
    assert.equal(snapshot.graphAvailability.state, "no_graph_evidence");
    assert.notEqual(
      snapshot.graphAvailability.reason,
      "no_readable_run_record",
      "the record is on disk, so the snapshot must not report it as unreadable",
    );
    assert.equal(snapshot.nodes.length, 0, "an artifact-less run must report real zeros");
    assert.equal(snapshot.graphAvailability.substanceClass, "substantive");
    assert.equal(snapshot.graphAvailability.substanceSignals.stageIndex, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("no run the catalog can enumerate opens as an unreadable record", async () => {
  const { root, stateDir } = await projectWithHistory();
  try {
    const service = serviceFor(root);
    const runIds = await enumerateRunIds(stateDir);
    assert.deepEqual(
      runIds,
      [ACTIVE_RUN_ID, OLDER_HISTORICAL_RUN_ID, HISTORICAL_RUN_ID].sort(),
      "the fixture must enumerate one active and two historical runs",
    );

    const unreadable = [];
    for (const runId of runIds) {
      const snapshot = await service.getSnapshot(runId);
      if (snapshot.run?.runId !== runId || snapshot.graphAvailability.reason === "no_readable_run_record") {
        unreadable.push(`${runId} -> ${snapshot.run?.runId ?? "null"} / ${snapshot.graphAvailability.reason}`);
      }
    }
    assert.deepEqual(unreadable, [], "every enumerated run must resolve to itself");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the active run still resolves through the durable record", async () => {
  const { root } = await projectWithHistory();
  try {
    const snapshot = await serviceFor(root).getSnapshot(ACTIVE_RUN_ID);

    assert.equal(snapshot.run?.runId, ACTIVE_RUN_ID);
    assert.equal(snapshot.run.active, true);
    assert.equal(snapshot.source.stale, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a per-run record that declares a different run is refused instead of borrowed", async () => {
  const { root, stateDir } = await projectWithHistory();
  try {
    await writeRunStatus(
      stateDir,
      MISLABELLED_RUN_ID,
      statusRecord({ runId: HISTORICAL_RUN_ID, updatedAt: "2026-05-02T04:04:04.004Z" }),
    );

    const snapshot = await serviceFor(root).getSnapshot(MISLABELLED_RUN_ID);

    assert.equal(
      snapshot.run,
      null,
      "a record whose declared run disagrees with the request must not render under the requested row",
    );
    assert.equal(snapshot.graphAvailability.state, "no_run_selected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the per-run reader refuses ids that could leave the state directory", async () => {
  const { root, stateDir } = await projectWithHistory();
  try {
    const outside = path.join(root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(
      path.join(outside, "status.json"),
      JSON.stringify(statusRecord({ runId: "meta-outside", updatedAt: "2026-08-01T00:00:00.000Z" })),
      "utf8",
    );
    await writeRunStatus(stateDir, "sibling", statusRecord({ runId: "sibling", updatedAt: "2026-08-02T00:00:00.000Z" }));

    const repository = createLiveReadRepository({ projectRoot: root });
    assert.equal(typeof repository.readRunStatus, "function", "the repository must expose a per-run reader");

    for (const hostile of [
      "../outside",
      "../../outside",
      "..",
      ".",
      "runs/sibling",
      "sibling/../sibling",
      path.join(outside, "status.json"),
      "",
      null,
    ]) {
      assert.equal(
        await repository.readRunStatus(hostile),
        null,
        `readRunStatus must refuse ${JSON.stringify(hostile)}`,
      );
    }

    assert.equal((await repository.readRunStatus("sibling")).runId, "sibling");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
