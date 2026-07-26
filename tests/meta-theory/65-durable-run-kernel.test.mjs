import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  openDurableRunKernel,
} from "../../scripts/governed-execution/durable-run-kernel.mjs";
import { importDatabaseSync } from "../../scripts/sqlite-runtime.mjs";

const execFileAsync = promisify(execFile);
const MODULE_URL = pathToFileURL(path.resolve(
  "scripts/governed-execution/durable-run-kernel.mjs",
)).href;

async function tempDatabase() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-p118-"));
  return {
    dbPath: path.join(root, "durable-runs.sqlite"),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

async function rootRun(t, overrides = {}) {
  const { dbPath, cleanup } = await tempDatabase();
  const store = await openDurableRunKernel(dbPath, { enableTestHooks: true });
  t.after(async () => {
    store.close();
    await cleanup();
  });
  const run = store.createRun({
    runId: "run-root",
    graphDigest: "graph-v1",
    taskFingerprint: "task-v1",
    ...overrides,
  });
  return { dbPath, store, run };
}

function claimArgs(overrides = {}) {
  return {
    runId: "run-root",
    nodeId: "stage:execution:lane:worker",
    nodeDefinitionHash: "node-v1",
    inputHash: "input-v1",
    dependencyOutputHash: "deps-v1",
    ownerId: "worker-a",
    leaseMs: 1_000,
    nowMs: 10_000,
    ...overrides,
  };
}

test("65 — creates a namespaced schema and enforces an immutable event log", async (t) => {
  const { store } = await rootRun(t);
  const database = store.testOnly.database;
  assert.equal(store.db, undefined);
  const tables = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'governed_%'
    ORDER BY name
  `).all().map((row) => row.name);
  assert.ok(tables.includes("governed_runs"));
  assert.ok(tables.includes("governed_events"));
  assert.ok(tables.includes("governed_checkpoints"));

  assert.throws(
    () => database.prepare("UPDATE governed_events SET event_type = 'tampered'").run(),
    /append-only|immutable/iu,
  );
  assert.throws(
    () => database.prepare("DELETE FROM governed_events").run(),
    /append-only|immutable/iu,
  );
});

test("65 — append uses per-run cursor CAS and exact idempotency without replacement", async (t) => {
  const { store, run } = await rootRun(t);
  const event = store.appendEvent({
    runId: run.runId,
    eventId: "manual-1",
    eventType: "ManualObservation",
    payload: { value: 1 },
    expectedCursor: run.cursor,
  });
  assert.equal(event.eventSeq, run.cursor + 1);

  const replayed = store.appendEvent({
    runId: run.runId,
    eventId: "manual-1",
    eventType: "ManualObservation",
    payload: { value: 1 },
    expectedCursor: run.cursor,
  });
  assert.equal(replayed.eventSeq, event.eventSeq);
  assert.equal(store.getEvents(run.runId).filter((item) => item.eventId === "manual-1").length, 1);

  assert.throws(
    () => store.appendEvent({
      runId: run.runId,
      eventId: "manual-1",
      eventType: "ManualObservation",
      payload: { value: 2 },
    }),
    /idempotency|different payload/iu,
  );
  assert.throws(
    () => store.appendEvent({
      runId: run.runId,
      eventId: "manual-2",
      eventType: "ManualObservation",
      payload: {},
      expectedCursor: run.cursor,
    }),
    /cursor/iu,
  );
  assert.equal(store.verifyEventChain(run.runId).ok, true);
});

test("65 — resume fails closed when graph or task binding changes", async (t) => {
  const { store } = await rootRun(t);
  assert.throws(
    () => store.resumeRun({ runId: "run-root", graphDigest: "graph-v2", taskFingerprint: "task-v1" }),
    /graph binding/iu,
  );
  assert.throws(
    () => store.resumeRun({ runId: "run-root", graphDigest: "graph-v1", taskFingerprint: "task-v2" }),
    /task binding/iu,
  );
});

test("65 — terminal node commit is atomic, resumable, and fork lineage is queryable", async (t) => {
  const { store } = await rootRun(t);
  const attempt = store.claimNode(claimArgs());
  const completed = store.completeNode({
    runId: "run-root",
    nodeId: claimArgs().nodeId,
    attemptId: attempt.attemptId,
    fenceToken: attempt.fenceToken,
    ownerId: "worker-a",
    output: { answer: 42 },
    nowMs: 10_100,
  });
  assert.equal(completed.status, "completed");
  assert.ok(completed.checkpointId);

  const resumed = store.resumeRun({
    runId: "run-root",
    graphDigest: "graph-v1",
    taskFingerprint: "task-v1",
  });
  assert.deepEqual(resumed.completedNodeIds, [claimArgs().nodeId]);
  assert.equal(resumed.blockingEffects.length, 0);

  const fork = store.forkRun({
    runId: "run-fork",
    parentRunId: "run-root",
    fromCheckpointId: completed.checkpointId,
    graphDigest: "graph-v1",
    taskFingerprint: "task-v1",
  });
  const forkResume = store.resumeRun({
    runId: fork.runId,
    graphDigest: "graph-v1",
    taskFingerprint: "task-v1",
  });
  assert.deepEqual(forkResume.completedNodeIds, [claimArgs().nodeId]);
  assert.deepEqual(
    store.getCheckpointLineage(fork.headCheckpointId).map((item) => item.runId),
    ["run-root", "run-fork"],
  );
});

test("65 — terminal commit rollback leaves no false completion or checkpoint", async (t) => {
  const { store } = await rootRun(t);
  const attempt = store.claimNode(claimArgs());
  const checkpointCount = store.testOnly.database.prepare(
    "SELECT COUNT(*) AS count FROM governed_checkpoints",
  ).get().count;

  assert.throws(
    () => store.completeNode({
      runId: "run-root",
      nodeId: claimArgs().nodeId,
      attemptId: attempt.attemptId,
      fenceToken: attempt.fenceToken,
      ownerId: "worker-a",
      output: { answer: "must rollback" },
      nowMs: 10_100,
    }, {
      onWriteStep(step) {
        if (step === "transition") throw new Error("injected crash");
      },
    }),
    /injected crash/,
  );
  assert.deepEqual(store.resumeRun({
    runId: "run-root",
    graphDigest: "graph-v1",
    taskFingerprint: "task-v1",
  }).completedNodeIds, []);
  assert.equal(
    store.testOnly.database.prepare("SELECT COUNT(*) AS count FROM governed_checkpoints").get().count,
    checkpointCount,
  );
});

test("65 — expired leases increment fencing and reject stale completion", async (t) => {
  const { store } = await rootRun(t);
  const first = store.claimNode(claimArgs({ leaseMs: 10 }));
  assert.throws(
    () => store.claimNode(claimArgs({ ownerId: "worker-b", leaseMs: 10, nowMs: 10_005 })),
    /lease|claimed/iu,
  );
  const second = store.claimNode(claimArgs({ ownerId: "worker-b", leaseMs: 10, nowMs: 10_011 }));
  assert.equal(second.attemptNo, 2);
  assert.equal(second.fenceToken, first.fenceToken + 1);
  assert.throws(
    () => store.completeNode({
      runId: "run-root",
      nodeId: claimArgs().nodeId,
      attemptId: first.attemptId,
      fenceToken: first.fenceToken,
      ownerId: "worker-a",
      output: { stale: true },
    }),
    /fence|stale/iu,
  );
});

test("65 — unresolved effects become in_doubt and block completion until reconciliation", async (t) => {
  const { store } = await rootRun(t);
  const attempt = store.claimNode(claimArgs());
  const effect = store.prepareEffect({
    effectId: "effect-1",
    runId: "run-root",
    nodeId: claimArgs().nodeId,
    attemptId: attempt.attemptId,
    logicalEffectKey: "publish:release-1",
    fingerprint: "effect-fingerprint-v1",
    idempotencyKey: "idempotency-release-1",
    providerBinding: { provider: "negative-control" },
    fenceToken: attempt.fenceToken,
    ownerId: "worker-a",
    nowMs: 10_100,
  });
  assert.equal(effect.state, "prepared");
  store.markEffectDispatchStarted({
    effectId: effect.effectId,
    attemptId: attempt.attemptId,
    fenceToken: attempt.fenceToken,
    ownerId: "worker-a",
    nowMs: 10_200,
  });
  assert.throws(
    () => store.reconcileEffect({
      effectId: effect.effectId,
      outcome: "completed",
      evidence: { source: "reviewer" },
      reconcilerIdentity: "reviewer-a",
    }),
    /in_doubt/iu,
  );
  const recovered = store.markUnresolvedEffectsInDoubt({ runId: "run-root" });
  assert.deepEqual(recovered.effectIds, [effect.effectId]);
  assert.throws(
    () => store.completeNode({
      runId: "run-root",
      nodeId: claimArgs().nodeId,
      attemptId: attempt.attemptId,
      fenceToken: attempt.fenceToken,
      ownerId: "worker-a",
      output: { unsafe: true },
      nowMs: 10_300,
    }),
    /effect|in_doubt/iu,
  );
  assert.equal(
    store.reconcileEffect({
      effectId: effect.effectId,
      outcome: "absent",
      evidence: { source: "provider-query", result: "not_found" },
      reconcilerIdentity: "reviewer-a",
    }).state,
    "reconciled_absent",
  );
  assert.equal(store.completeNode({
    runId: "run-root",
    nodeId: claimArgs().nodeId,
    attemptId: attempt.attemptId,
    fenceToken: attempt.fenceToken,
    ownerId: "worker-a",
    output: { safe: true },
    nowMs: 10_400,
  }).status, "completed");
});

test("65 — multiple Node processes append without duplicate cursors", async (t) => {
  const { dbPath, store } = await rootRun(t);
  store.close();
  const script = `
    import { openDurableRunKernel } from ${JSON.stringify(MODULE_URL)};
    const store = await openDurableRunKernel(process.argv[1]);
    store.appendEvent({
      runId: 'run-root',
      eventId: process.argv[2],
      eventType: 'ConcurrentObservation',
      payload: { writer: process.argv[2] },
    });
    store.close();
  `;
  await Promise.all(["writer-1", "writer-2", "writer-3", "writer-4"].map((eventId) =>
    execFileAsync(process.execPath, ["--input-type=module", "--eval", script, dbPath, eventId])
  ));
  const reopened = await openDurableRunKernel(dbPath);
  t.after(() => reopened.close());
  const concurrent = reopened.getEvents("run-root").filter(
    (event) => event.eventType === "ConcurrentObservation",
  );
  assert.equal(concurrent.length, 4);
  assert.equal(new Set(concurrent.map((event) => event.eventSeq)).size, 4);
  assert.equal(reopened.verifyEventChain("run-root").ok, true);
  reopened.close();
});

test("65 — legacy runs/events remain untouched and projection replay is pure", async (t) => {
  const { dbPath, cleanup } = await tempDatabase();
  const DatabaseSync = await importDatabaseSync();
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE runs (run_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
    CREATE TABLE run_events (event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, payload_json TEXT NOT NULL);
    INSERT INTO runs VALUES ('legacy-run', '{}');
    INSERT INTO run_events VALUES ('legacy-event', 'legacy-run', '{}');
  `);
  legacy.close();

  const store = await openDurableRunKernel(dbPath, { enableTestHooks: true });
  t.after(async () => {
    store.close();
    await cleanup();
  });
  store.createRun({ runId: "run-root", graphDigest: "graph-v1", taskFingerprint: "task-v1" });
  const before = store.getEvents("run-root");
  const first = store.projectRun("run-root");
  const second = store.replayRun("run-root");
  assert.deepEqual(second, first);
  assert.deepEqual(store.getEvents("run-root"), before);
  assert.equal(store.testOnly.database.prepare("SELECT COUNT(*) AS count FROM runs").get().count, 1);
  assert.equal(store.testOnly.database.prepare("SELECT COUNT(*) AS count FROM run_events").get().count, 1);
});

test("65 — contract API is present and edge/failure evidence stays append-only", async (t) => {
  const contract = JSON.parse(await fs.readFile(
    "config/contracts/durable-run-kernel-contract.json",
    "utf8",
  ));
  const { store } = await rootRun(t);
  for (const method of contract.requiredApi) assert.equal(typeof store[method], "function", method);

  const attempt = store.claimNode(claimArgs());
  assert.equal(store.heartbeatNode({
    runId: "run-root",
    nodeId: claimArgs().nodeId,
    attemptId: attempt.attemptId,
    fenceToken: attempt.fenceToken,
    ownerId: "worker-a",
    leaseMs: 1_000,
    nowMs: 10_100,
  }).leaseExpiresAtMs, 11_100);
  store.recordTraversedEdge({
    traversalId: "edge-1",
    runId: "run-root",
    fromNodeId: "stage:thinking:merge",
    toNodeId: claimArgs().nodeId,
    attemptId: attempt.attemptId,
    conditionDigest: "condition-v1",
  });
  assert.equal(store.failNode({
    runId: "run-root",
    nodeId: claimArgs().nodeId,
    attemptId: attempt.attemptId,
    fenceToken: attempt.fenceToken,
    ownerId: "worker-a",
    failure: { failureClass: "negative_control" },
    nowMs: 10_200,
  }).status, "failed");
  const projection = store.projectRun("run-root");
  assert.equal(projection.edgeTraversals.length, 1);
  assert.equal(projection.events.some((event) => event.eventType === "NodeAttemptFailed"), true);
});

test("65 — one run coordinator wins, expiry increments fence, and stale owners cannot act", async (t) => {
  const { dbPath, store } = await rootRun(t);
  const contender = await openDurableRunKernel(dbPath);
  try {
    const first = store.claimRunCoordinator({
      runId: "run-root",
      ownerId: "coordinator-a",
      leaseMs: 10,
      nowMs: 20_000,
    });
    assert.equal(first.fenceToken, 1);
    assert.throws(
      () => contender.claimRunCoordinator({
        runId: "run-root",
        ownerId: "coordinator-b",
        leaseMs: 10,
        nowMs: 20_005,
      }),
      /coordinator|lease|claimed/iu,
    );

    const second = contender.claimRunCoordinator({
      runId: "run-root",
      ownerId: "coordinator-b",
      leaseMs: 10,
      nowMs: 20_011,
    });
    assert.equal(second.fenceToken, 2);
    assert.throws(
      () => store.heartbeatRunCoordinator({
        runId: "run-root",
        ownerId: "coordinator-a",
        fenceToken: first.fenceToken,
        leaseMs: 10,
        nowMs: 20_012,
      }),
      /fence|stale/iu,
    );
    assert.throws(
      () => store.releaseRunCoordinator({
        runId: "run-root",
        ownerId: "coordinator-a",
        fenceToken: first.fenceToken,
        nowMs: 20_012,
      }),
      /fence|stale/iu,
    );

    assert.equal(contender.heartbeatRunCoordinator({
      runId: "run-root",
      ownerId: "coordinator-b",
      fenceToken: second.fenceToken,
      leaseMs: 20,
      nowMs: 20_012,
    }).leaseExpiresAtMs, 20_032);
    assert.equal(contender.releaseRunCoordinator({
      runId: "run-root",
      ownerId: "coordinator-b",
      fenceToken: second.fenceToken,
      nowMs: 20_013,
    }).released, true);
    assert.equal(store.claimRunCoordinator({
      runId: "run-root",
      ownerId: "coordinator-c",
      leaseMs: 10,
      nowMs: 20_014,
    }).fenceToken, 3);
  } finally {
    contender.close();
  }
});

test("65 — INSERT OR REPLACE cannot bypass immutable event identity", async (t) => {
  const { store } = await rootRun(t);
  const database = store.testOnly.database;
  assert.throws(
    () => database.exec(`
      INSERT OR REPLACE INTO governed_events(
        run_id, event_seq, event_id, event_type, node_id, attempt_id,
        payload_json, payload_sha256, previous_event_hash, event_hash, created_at, writer_id
      )
      SELECT run_id, event_seq, event_id, 'TamperedByReplace', node_id, attempt_id,
        '{}', payload_sha256, previous_event_hash, event_hash, created_at, writer_id
      FROM governed_events WHERE run_id = 'run-root' AND event_seq = 1
    `),
    /append-only|immutable|replace/iu,
  );
  assert.equal(store.verifyEventChain("run-root").ok, true);
});

test("65 — integrity verification rejects event, cursor, checkpoint, and output tampering", async (t) => {
  const { store } = await rootRun(t);
  const attempt = store.claimNode(claimArgs());
  const completed = store.completeNode({
    runId: "run-root",
    nodeId: claimArgs().nodeId,
    attemptId: attempt.attemptId,
    fenceToken: attempt.fenceToken,
    ownerId: "worker-a",
    output: { answer: 42 },
    nowMs: 10_100,
  });
  const database = store.testOnly.database;
  const checkpoint = database.prepare(
    "SELECT * FROM governed_checkpoints WHERE checkpoint_id = ?",
  ).get(completed.checkpointId);
  const checkpointNode = database.prepare(
    "SELECT * FROM governed_checkpoint_nodes WHERE checkpoint_id = ? AND node_id = ?",
  ).get(completed.checkpointId, claimArgs().nodeId);
  const head = database.prepare(
    "SELECT * FROM governed_run_heads WHERE run_id = 'run-root'",
  ).get();

  database.exec("DROP TRIGGER governed_checkpoint_nodes_no_update");
  database.exec("DROP TRIGGER governed_checkpoints_no_update");

  database.prepare(`
    UPDATE governed_checkpoint_nodes SET output_json = '{"answer":99}'
    WHERE checkpoint_id = ? AND node_id = ?
  `).run(completed.checkpointId, claimArgs().nodeId);
  assert.equal(store.verifyEventChain("run-root").reason, "checkpoint_output_hash_mismatch");
  assert.throws(
    () => store.resumeRun({ runId: "run-root", graphDigest: "graph-v1", taskFingerprint: "task-v1" }),
    /integrity|checkpoint|output/iu,
  );
  database.prepare(`
    UPDATE governed_checkpoint_nodes SET output_json = ?
    WHERE checkpoint_id = ? AND node_id = ?
  `).run(checkpointNode.output_json, completed.checkpointId, claimArgs().nodeId);

  database.prepare("UPDATE governed_checkpoints SET state_json = '{}' WHERE checkpoint_id = ?")
    .run(completed.checkpointId);
  assert.equal(store.verifyEventChain("run-root").reason, "checkpoint_state_hash_mismatch");
  database.prepare("UPDATE governed_checkpoints SET state_json = ? WHERE checkpoint_id = ?")
    .run(checkpoint.state_json, completed.checkpointId);

  database.prepare("UPDATE governed_checkpoints SET graph_digest = 'graph-tampered' WHERE checkpoint_id = ?")
    .run(completed.checkpointId);
  assert.equal(store.verifyEventChain("run-root").reason, "checkpoint_graph_binding_mismatch");
  database.prepare("UPDATE governed_checkpoints SET graph_digest = ? WHERE checkpoint_id = ?")
    .run(checkpoint.graph_digest, completed.checkpointId);

  database.prepare("UPDATE governed_checkpoints SET parent_checkpoint_id = checkpoint_id WHERE checkpoint_id = ?")
    .run(completed.checkpointId);
  assert.equal(store.verifyEventChain("run-root").reason, "checkpoint_parent_cycle");
  database.prepare("UPDATE governed_checkpoints SET parent_checkpoint_id = ? WHERE checkpoint_id = ?")
    .run(checkpoint.parent_checkpoint_id, completed.checkpointId);

  database.prepare("UPDATE governed_checkpoints SET event_seq = 1 WHERE checkpoint_id = ?")
    .run(completed.checkpointId);
  assert.equal(store.verifyEventChain("run-root").reason, "checkpoint_event_binding_mismatch");
  database.prepare("UPDATE governed_checkpoints SET event_seq = ? WHERE checkpoint_id = ?")
    .run(checkpoint.event_seq, completed.checkpointId);

  database.prepare("UPDATE governed_run_heads SET next_event_seq = next_event_seq + 1 WHERE run_id = 'run-root'").run();
  assert.equal(store.verifyEventChain("run-root").reason, "head_cursor_mismatch");
  database.prepare(`
    UPDATE governed_run_heads SET next_event_seq = ?, head_event_hash = ? WHERE run_id = 'run-root'
  `).run(head.next_event_seq, head.head_event_hash);

  database.exec("DROP TRIGGER governed_events_no_update");
  database.prepare(`
    UPDATE governed_events SET payload_json = '{"tampered":true}'
    WHERE run_id = 'run-root' AND event_seq = 1
  `).run();
  assert.equal(store.verifyEventChain("run-root").reason, "event_payload_hash_mismatch");
});

test("65 — node mutation APIs require the live owner, fence, attempt, and lease", async (t) => {
  const { store } = await rootRun(t);
  const first = store.claimNode(claimArgs({ leaseMs: 10 }));
  assert.throws(
    () => store.heartbeatNode({
      runId: "run-root",
      nodeId: claimArgs().nodeId,
      attemptId: first.attemptId,
      fenceToken: first.fenceToken,
      ownerId: "worker-a",
      leaseMs: 10,
      nowMs: 10_011,
    }),
    /expired|lease|stale/iu,
  );
  assert.throws(
    () => store.completeNode({
      runId: "run-root",
      nodeId: claimArgs().nodeId,
      attemptId: first.attemptId,
      fenceToken: first.fenceToken,
      ownerId: "worker-b",
      output: {},
      nowMs: 10_005,
    }),
    /owner|fence|stale/iu,
  );
  const second = store.claimNode(claimArgs({ ownerId: "worker-b", nowMs: 10_011 }));
  assert.equal(second.fenceToken, 2);
  assert.throws(
    () => store.prepareEffect({
      effectId: "effect-old-attempt",
      runId: "run-root",
      nodeId: claimArgs().nodeId,
      attemptId: first.attemptId,
      logicalEffectKey: "old-attempt-effect",
      fingerprint: "old-v1",
      idempotencyKey: "old-idempotency",
      providerBinding: {},
      fenceToken: first.fenceToken,
      ownerId: "worker-a",
      nowMs: 10_012,
    }),
    /active claim|attempt|fence|stale/iu,
  );
  const currentEffect = store.prepareEffect({
    effectId: "effect-current-attempt",
    runId: "run-root",
    nodeId: claimArgs().nodeId,
    attemptId: second.attemptId,
    logicalEffectKey: "current-attempt-effect",
    fingerprint: "current-v1",
    idempotencyKey: "current-idempotency",
    providerBinding: {},
    fenceToken: second.fenceToken,
    ownerId: "worker-b",
    nowMs: 10_012,
  });
  assert.throws(
    () => store.markEffectDispatchStarted({
      effectId: currentEffect.effectId,
      attemptId: second.attemptId,
      fenceToken: second.fenceToken,
      ownerId: "worker-a",
      nowMs: 10_013,
    }),
    /owner|active claim|fence|stale/iu,
  );
});

test("65 — fence remains monotonic after a failed attempt releases its claim", async (t) => {
  const { store } = await rootRun(t);
  const first = store.claimNode(claimArgs());
  assert.equal(store.failNode({
    runId: "run-root",
    nodeId: claimArgs().nodeId,
    attemptId: first.attemptId,
    fenceToken: first.fenceToken,
    ownerId: "worker-a",
    failure: { failureClass: "retryable" },
    nowMs: 10_100,
  }).status, "failed");
  const second = store.claimNode(claimArgs({ ownerId: "worker-b", nowMs: 10_200 }));
  assert.equal(second.attemptNo, 2);
  assert.equal(second.fenceToken, 2);
});

test("65 — unresolved sibling effects block the root and completed effects require explicit reuse evidence", async (t) => {
  const { store } = await rootRun(t);
  const seedAttempt = store.claimNode(claimArgs());
  const seed = store.completeNode({
    runId: "run-root",
    nodeId: claimArgs().nodeId,
    attemptId: seedAttempt.attemptId,
    fenceToken: seedAttempt.fenceToken,
    ownerId: "worker-a",
    output: { seed: true },
    nowMs: 10_100,
  });
  for (const runId of ["run-fork-a", "run-fork-b"]) {
    store.forkRun({
      runId,
      parentRunId: "run-root",
      fromCheckpointId: seed.checkpointId,
      graphDigest: "graph-v1",
      taskFingerprint: "task-v1",
    });
  }
  const nodeId = "stage:execution:lane:effect";
  const effectAttempt = store.claimNode(claimArgs({ runId: "run-fork-a", nodeId, ownerId: "worker-a" }));
  const siblingAttempt = store.claimNode(claimArgs({ runId: "run-fork-b", nodeId, ownerId: "worker-b" }));
  const effect = store.prepareEffect({
    effectId: "root-effect",
    runId: "run-fork-a",
    nodeId,
    attemptId: effectAttempt.attemptId,
    logicalEffectKey: "publish:root-release",
    fingerprint: "root-effect-v1",
    idempotencyKey: "root-effect-idempotency",
    providerBinding: { provider: "negative-control" },
    fenceToken: effectAttempt.fenceToken,
    ownerId: "worker-a",
    nowMs: 10_100,
  });
  assert.equal(store.resumeRun({
    runId: "run-fork-b",
    graphDigest: "graph-v1",
    taskFingerprint: "task-v1",
  }).blockingEffects[0].effectId, effect.effectId);
  assert.throws(
    () => store.completeNode({
      runId: "run-fork-b",
      nodeId,
      attemptId: siblingAttempt.attemptId,
      fenceToken: siblingAttempt.fenceToken,
      ownerId: "worker-b",
      output: {},
      nowMs: 10_200,
    }),
    /root|effect|prepared/iu,
  );
  store.markEffectDispatchStarted({
    effectId: effect.effectId,
    attemptId: effectAttempt.attemptId,
    fenceToken: effectAttempt.fenceToken,
    ownerId: "worker-a",
    nowMs: 10_200,
  });
  store.markUnresolvedEffectsInDoubt({ runId: "run-fork-a", nowMs: 10_300 });
  store.reconcileEffect({
    effectId: effect.effectId,
    outcome: "completed",
    evidence: { providerReceipt: "receipt-1" },
    reconcilerIdentity: "reviewer-a",
    nowMs: 10_400,
  });
  assert.throws(
    () => store.prepareEffect({
      effectId: "must-not-alias",
      runId: "run-fork-b",
      nodeId,
      attemptId: siblingAttempt.attemptId,
      logicalEffectKey: "publish:root-release",
      fingerprint: "root-effect-v1",
      idempotencyKey: "root-effect-idempotency",
      providerBinding: { provider: "negative-control" },
      fenceToken: siblingAttempt.fenceToken,
      ownerId: "worker-b",
      nowMs: 10_500,
    }),
    /explicit reuse|different attempt|binding/iu,
  );
  const reuse = store.reuseCompletedEffect({
    effectId: effect.effectId,
    runId: "run-fork-b",
    nodeId,
    attemptId: siblingAttempt.attemptId,
    fenceToken: siblingAttempt.fenceToken,
    ownerId: "worker-b",
    evidence: { verifiedReceipt: "receipt-1" },
    reuserIdentity: "worker-b",
    nowMs: 10_500,
  });
  assert.equal(reuse.sourceAttemptId, effectAttempt.attemptId);
  assert.equal(reuse.targetAttemptId, siblingAttempt.attemptId);
});

test("65 — prepared crash can reconcile absent with evidence after lease expiry", async (t) => {
  const { store } = await rootRun(t);
  const first = store.claimNode(claimArgs({ leaseMs: 10 }));
  const effect = store.prepareEffect({
    effectId: "prepared-crash-effect",
    runId: "run-root",
    nodeId: claimArgs().nodeId,
    attemptId: first.attemptId,
    logicalEffectKey: "prepared:never-dispatched",
    fingerprint: "prepared-v1",
    idempotencyKey: "prepared-idempotency",
    providerBinding: {},
    fenceToken: first.fenceToken,
    ownerId: "worker-a",
    nowMs: 10_005,
  });
  assert.throws(
    () => store.reconcileEffect({
      effectId: effect.effectId,
      outcome: "absent",
      evidence: { inspection: "too-early" },
      reconcilerIdentity: "recovery-a",
      nowMs: 10_006,
    }),
    /active claim|lease/iu,
  );
  assert.equal(store.reconcileEffect({
    effectId: effect.effectId,
    outcome: "absent",
    evidence: { dispatchLogChecked: true, providerQuery: "not_found" },
    reconcilerIdentity: "recovery-a",
    nowMs: 10_011,
  }).state, "reconciled_absent");
  const second = store.claimNode(claimArgs({ ownerId: "worker-b", nowMs: 10_012 }));
  assert.equal(second.fenceToken, 2);
});

test("65 — migration hashes are exact and reconciliation requires attributable evidence", async (t) => {
  const { dbPath, store } = await rootRun(t);
  assert.throws(
    () => store.reconcileEffect({ effectId: "missing", outcome: "absent" }),
    /evidence|identity/iu,
  );
  store.testOnly.database.prepare(`
    UPDATE governed_schema_migrations SET migration_sha256 = 'tampered' WHERE version = 2
  `).run();
  store.close();
  await assert.rejects(
    () => openDurableRunKernel(dbPath),
    /migration|hash|integrity/iu,
  );
});

test("65 — terminal run status requires the live coordinator and disables resume", async (t) => {
  const { store } = await rootRun(t);
  const coordinator = store.claimRunCoordinator({
    runId: "run-root",
    ownerId: "coordinator-a",
    leaseMs: 1_000,
    nowMs: 30_000,
  });
  assert.throws(
    () => store.setRunTerminalStatus({
      runId: "run-root",
      status: "completed",
      ownerId: "coordinator-b",
      fenceToken: coordinator.fenceToken,
      nowMs: 30_100,
    }),
    /coordinator|owner|fence/iu,
  );
  assert.equal(store.setRunTerminalStatus({
    runId: "run-root",
    status: "completed",
    ownerId: "coordinator-a",
    fenceToken: coordinator.fenceToken,
    nowMs: 30_100,
  }).status, "completed");
  const resumed = store.resumeRun({
    runId: "run-root",
    graphDigest: "graph-v1",
    taskFingerprint: "task-v1",
  });
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.resumable, false);
  assert.throws(() => store.claimNode(claimArgs({ nowMs: 30_200 })), /terminal|completed/iu);
});

test("65 — terminal status rejects active claims and unresolved effects, then forbids later mutations", async (t) => {
  const { store } = await rootRun(t);
  const coordinator = store.claimRunCoordinator({
    runId: "run-root",
    ownerId: "coordinator-a",
    leaseMs: 10_000,
    nowMs: 40_000,
  });
  const attempt = store.claimNode(claimArgs({ nowMs: 40_000, leaseMs: 10_000 }));
  assert.throws(
    () => store.setRunTerminalStatus({
      runId: "run-root",
      status: "completed",
      ownerId: "coordinator-a",
      fenceToken: coordinator.fenceToken,
      nowMs: 40_100,
    }),
    /active claim|node claim/iu,
  );
  const effect = store.prepareEffect({
    effectId: "terminal-blocking-effect",
    runId: "run-root",
    nodeId: claimArgs().nodeId,
    attemptId: attempt.attemptId,
    logicalEffectKey: "terminal:blocking",
    fingerprint: "terminal-blocking-v1",
    idempotencyKey: "terminal-blocking-key",
    providerBinding: {},
    fenceToken: attempt.fenceToken,
    ownerId: "worker-a",
    nowMs: 40_100,
  });
  store.markEffectDispatchStarted({
    effectId: effect.effectId,
    attemptId: attempt.attemptId,
    fenceToken: attempt.fenceToken,
    ownerId: "worker-a",
    nowMs: 40_200,
  });
  store.markUnresolvedEffectsInDoubt({ runId: "run-root", nowMs: 40_300 });
  store.failNode({
    runId: "run-root",
    nodeId: claimArgs().nodeId,
    attemptId: attempt.attemptId,
    fenceToken: attempt.fenceToken,
    ownerId: "worker-a",
    failure: { failureClass: "test_cleanup" },
    nowMs: 40_400,
  });
  assert.throws(
    () => store.setRunTerminalStatus({
      runId: "run-root",
      status: "failed",
      ownerId: "coordinator-a",
      fenceToken: coordinator.fenceToken,
      nowMs: 40_500,
    }),
    /blocking effect|unresolved effect/iu,
  );
  store.reconcileEffect({
    effectId: effect.effectId,
    outcome: "absent",
    evidence: { providerQuery: "not_found" },
    reconcilerIdentity: "reviewer-a",
    nowMs: 40_500,
  });
  assert.equal(store.setRunTerminalStatus({
    runId: "run-root",
    status: "failed",
    ownerId: "coordinator-a",
    fenceToken: coordinator.fenceToken,
    nowMs: 40_600,
  }).status, "failed");
  assert.throws(
    () => store.appendEvent({
      runId: "run-root",
      eventId: "illegal-post-terminal-completion",
      eventType: "NodeAttemptCompleted",
      nodeId: claimArgs().nodeId,
      attemptId: attempt.attemptId,
      payload: {},
    }),
    /terminal|active/iu,
  );
  assert.throws(
    () => store.prepareEffect({
      effectId: "illegal-post-terminal-effect",
      runId: "run-root",
      nodeId: claimArgs().nodeId,
      attemptId: attempt.attemptId,
      logicalEffectKey: "terminal:illegal",
      fingerprint: "illegal",
      idempotencyKey: "illegal",
      providerBinding: {},
      fenceToken: attempt.fenceToken,
      ownerId: "worker-a",
      nowMs: 40_700,
    }),
    /terminal|active/iu,
  );
});

test("65 — transition projections are immutable and event binding tamper fails closed", async (t) => {
  const { store } = await rootRun(t);
  const attempt = store.claimNode(claimArgs());
  const effect = store.prepareEffect({
    effectId: "projection-effect",
    runId: "run-root",
    nodeId: claimArgs().nodeId,
    attemptId: attempt.attemptId,
    logicalEffectKey: "projection:effect",
    fingerprint: "projection-v1",
    idempotencyKey: "projection-key",
    providerBinding: {},
    fenceToken: attempt.fenceToken,
    ownerId: "worker-a",
    nowMs: 10_100,
  });
  const database = store.testOnly.database;
  assert.throws(
    () => database.prepare(`
      UPDATE governed_effect_transitions SET detail_json = '{}'
      WHERE effect_id = ? AND transition_no = 1
    `).run(effect.effectId),
    /immutable|append-only/iu,
  );
  database.exec("DROP TRIGGER governed_effect_transitions_no_update");
  database.prepare(`
    UPDATE governed_effect_transitions SET event_seq = 1
    WHERE effect_id = ? AND transition_no = 1
  `).run(effect.effectId);
  assert.equal(store.verifyEventChain("run-root").reason, "effect_transition_event_binding_mismatch");
  assert.throws(
    () => store.resumeRun({ runId: "run-root", graphDigest: "graph-v1", taskFingerprint: "task-v1" }),
    /integrity|effect_transition_event_binding_mismatch/iu,
  );
});

test("65 — completed effect conflict persists a pending reuse requirement until explicit reuse", async (t) => {
  const { store } = await rootRun(t);
  const first = store.claimNode(claimArgs());
  const effect = store.prepareEffect({
    effectId: "reuse-requirement-effect",
    runId: "run-root",
    nodeId: claimArgs().nodeId,
    attemptId: first.attemptId,
    logicalEffectKey: "reuse:requirement",
    fingerprint: "reuse-requirement-v1",
    idempotencyKey: "reuse-requirement-key",
    providerBinding: {},
    fenceToken: first.fenceToken,
    ownerId: "worker-a",
    nowMs: 10_100,
  });
  store.markEffectDispatchStarted({
    effectId: effect.effectId,
    attemptId: first.attemptId,
    fenceToken: first.fenceToken,
    ownerId: "worker-a",
    nowMs: 10_200,
  });
  store.markUnresolvedEffectsInDoubt({ runId: "run-root", nowMs: 10_300 });
  store.reconcileEffect({
    effectId: effect.effectId,
    outcome: "completed",
    evidence: { receipt: "reuse-receipt" },
    reconcilerIdentity: "reviewer-a",
    nowMs: 10_400,
  });
  store.failNode({
    runId: "run-root",
    nodeId: claimArgs().nodeId,
    attemptId: first.attemptId,
    fenceToken: first.fenceToken,
    ownerId: "worker-a",
    failure: { failureClass: "retry_after_external_completion" },
    nowMs: 10_500,
  });
  const second = store.claimNode(claimArgs({ ownerId: "worker-b", nowMs: 10_600 }));
  assert.throws(
    () => store.prepareEffect({
      effectId: "reuse-requirement-alias",
      runId: "run-root",
      nodeId: claimArgs().nodeId,
      attemptId: second.attemptId,
      logicalEffectKey: "reuse:requirement",
      fingerprint: "reuse-requirement-v1",
      idempotencyKey: "reuse-requirement-key",
      providerBinding: {},
      fenceToken: second.fenceToken,
      ownerId: "worker-b",
      nowMs: 10_700,
    }),
    /explicit reuse|reuse requirement/iu,
  );
  const requirement = store.testOnly.database.prepare(`
    SELECT * FROM governed_effect_reuse_requirements
    WHERE effect_id = ? AND target_attempt_id = ?
  `).get(effect.effectId, second.attemptId);
  assert.equal(requirement.status, "pending");
  assert.throws(
    () => store.completeNode({
      runId: "run-root",
      nodeId: claimArgs().nodeId,
      attemptId: second.attemptId,
      fenceToken: second.fenceToken,
      ownerId: "worker-b",
      output: {},
      nowMs: 10_800,
    }),
    /reuse requirement|pending reuse/iu,
  );
  store.reuseCompletedEffect({
    effectId: effect.effectId,
    runId: "run-root",
    nodeId: claimArgs().nodeId,
    attemptId: second.attemptId,
    fenceToken: second.fenceToken,
    ownerId: "worker-b",
    evidence: { verifiedReceipt: "reuse-receipt" },
    reuserIdentity: "worker-b",
    nowMs: 10_900,
  });
  assert.equal(store.completeNode({
    runId: "run-root",
    nodeId: claimArgs().nodeId,
    attemptId: second.attemptId,
    fenceToken: second.fenceToken,
    ownerId: "worker-b",
    output: { reused: true },
    nowMs: 11_000,
  }).status, "completed");
});

test("65 — forged checkpoint output plus forged hash cannot escape completion-event binding", async (t) => {
  const { store } = await rootRun(t);
  const attempt = store.claimNode(claimArgs());
  const completed = store.completeNode({
    runId: "run-root",
    nodeId: claimArgs().nodeId,
    attemptId: attempt.attemptId,
    fenceToken: attempt.fenceToken,
    ownerId: "worker-a",
    output: { answer: 42 },
    nowMs: 10_100,
  });
  const database = store.testOnly.database;
  assert.throws(
    () => database.prepare(`
      UPDATE governed_checkpoint_nodes SET output_json = '{}'
      WHERE checkpoint_id = ? AND node_id = ?
    `).run(completed.checkpointId, claimArgs().nodeId),
    /immutable|append-only/iu,
  );
  database.exec("DROP TRIGGER governed_checkpoint_nodes_no_update");
  const forgedJson = '{"answer":99}';
  const forgedHash = createHash("sha256").update(forgedJson).digest("hex");
  database.prepare(`
    UPDATE governed_checkpoint_nodes SET output_json = ?, output_sha256 = ?
    WHERE checkpoint_id = ? AND node_id = ?
  `).run(forgedJson, forgedHash, completed.checkpointId, claimArgs().nodeId);
  assert.equal(store.verifyEventChain("run-root").reason, "checkpoint_completion_event_binding_mismatch");
  assert.throws(
    () => store.resumeRun({ runId: "run-root", graphDigest: "graph-v1", taskFingerprint: "task-v1" }),
    /integrity|checkpoint_completion_event_binding_mismatch/iu,
  );
});

test("65 — mutable head, claim, and coordinator projections must match their latest events", async (t) => {
  const { store } = await rootRun(t);
  const database = store.testOnly.database;
  const coordinator = store.claimRunCoordinator({
    runId: "run-root", ownerId: "coordinator-a", leaseMs: 10_000, nowMs: 50_000,
  });
  const attempt = store.claimNode(claimArgs({ nowMs: 50_000, leaseMs: 10_000 }));
  database.prepare(`
    UPDATE governed_node_claims SET lease_owner = 'forged-owner', fence_token = fence_token + 9
    WHERE run_id = 'run-root'
  `).run();
  assert.equal(store.verifyEventChain("run-root").reason, "node_claim_event_binding_mismatch");
  database.prepare(`
    UPDATE governed_node_claims SET lease_owner = 'worker-a', fence_token = ?
    WHERE run_id = 'run-root'
  `).run(attempt.fenceToken);
  database.prepare(`
    UPDATE governed_run_coordinators SET owner_id = 'forged-coordinator'
    WHERE run_id = 'run-root'
  `).run();
  assert.equal(store.verifyEventChain("run-root").reason, "coordinator_event_binding_mismatch");
  database.prepare(`
    UPDATE governed_run_coordinators SET owner_id = 'coordinator-a'
    WHERE run_id = 'run-root'
  `).run();
  store.failNode({
    runId: "run-root",
    nodeId: claimArgs().nodeId,
    attemptId: attempt.attemptId,
    fenceToken: attempt.fenceToken,
    ownerId: "worker-a",
    failure: {},
    nowMs: 50_100,
  });
  store.setRunTerminalStatus({
    runId: "run-root",
    status: "failed",
    ownerId: "coordinator-a",
    fenceToken: coordinator.fenceToken,
    nowMs: 50_200,
  });
  database.prepare("UPDATE governed_run_heads SET status = 'active' WHERE run_id = 'run-root'").run();
  assert.equal(store.verifyEventChain("run-root").reason, "run_status_event_binding_mismatch");
});

test("65 — reuse requirements cannot be deleted and checkpoints are immutable projections", async (t) => {
  const { store } = await rootRun(t);
  const first = store.claimNode(claimArgs());
  const effect = store.prepareEffect({
    effectId: "immutable-reuse-effect",
    runId: "run-root",
    nodeId: claimArgs().nodeId,
    attemptId: first.attemptId,
    logicalEffectKey: "immutable:reuse",
    fingerprint: "immutable-reuse-v1",
    idempotencyKey: "immutable-reuse-key",
    providerBinding: {},
    fenceToken: first.fenceToken,
    ownerId: "worker-a",
    nowMs: 10_100,
  });
  store.markEffectDispatchStarted({
    effectId: effect.effectId,
    attemptId: first.attemptId,
    fenceToken: first.fenceToken,
    ownerId: "worker-a",
    nowMs: 10_200,
  });
  store.markUnresolvedEffectsInDoubt({ runId: "run-root", nowMs: 10_300 });
  store.reconcileEffect({
    effectId: effect.effectId,
    outcome: "completed",
    evidence: { receipt: "immutable" },
    reconcilerIdentity: "reviewer-a",
    nowMs: 10_400,
  });
  store.failNode({
    runId: "run-root", nodeId: claimArgs().nodeId, attemptId: first.attemptId,
    fenceToken: first.fenceToken, ownerId: "worker-a", failure: {}, nowMs: 10_500,
  });
  const second = store.claimNode(claimArgs({ ownerId: "worker-b", nowMs: 10_600 }));
  assert.throws(() => store.prepareEffect({
    effectId: "immutable-reuse-alias",
    runId: "run-root", nodeId: claimArgs().nodeId, attemptId: second.attemptId,
    logicalEffectKey: "immutable:reuse", fingerprint: "immutable-reuse-v1",
    idempotencyKey: "immutable-reuse-key", providerBinding: {},
    fenceToken: second.fenceToken, ownerId: "worker-b", nowMs: 10_700,
  }), /reuse/iu);
  assert.throws(
    () => store.testOnly.database.prepare(`
      DELETE FROM governed_effect_reuse_requirements WHERE target_attempt_id = ?
    `).run(second.attemptId),
    /immutable|append-only/iu,
  );
});

test("65 — node completion and traversed edges commit atomically and retry without duplication", async (t) => {
  const { store } = await rootRun(t);
  const attempt = store.claimNode(claimArgs());
  const completion = {
    runId: "run-root",
    nodeId: claimArgs().nodeId,
    attemptId: attempt.attemptId,
    fenceToken: attempt.fenceToken,
    ownerId: "worker-a",
    output: { answer: 42 },
    traversedEdges: [{
      traversalId: "atomic-edge-1",
      fromNodeId: "stage:execution:start",
      toNodeId: claimArgs().nodeId,
      conditionDigest: "condition-v1",
    }],
    nowMs: 10_100,
  };
  assert.throws(
    () => store.completeNode(completion, {
      onWriteStep(step) {
        if (step === "edges") throw new Error("edge crash");
      },
    }),
    /edge crash/,
  );
  assert.equal(store.getEvents("run-root").some((event) => event.eventType === "NodeAttemptCompleted"), false);
  assert.equal(store.testOnly.database.prepare(
    "SELECT COUNT(*) AS count FROM governed_edge_traversals WHERE traversal_id = 'atomic-edge-1'",
  ).get().count, 0);
  assert.equal(store.completeNode(completion).status, "completed");
  assert.equal(store.testOnly.database.prepare(
    "SELECT COUNT(*) AS count FROM governed_edge_traversals WHERE traversal_id = 'atomic-edge-1'",
  ).get().count, 1);
  assert.equal(store.verifyEventChain("run-root").ok, true);
});
