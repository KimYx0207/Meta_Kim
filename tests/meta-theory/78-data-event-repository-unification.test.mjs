import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import * as legacyKernelModule from "../../scripts/governed-execution/durable-run-kernel.mjs";
import { openRunStateStore } from "../../scripts/capability-gap-mvp.mjs";
import * as applicationModule from "../../src/application/run/open-durable-run-repository.mjs";
import {
  assertDurableRunRepositoryPort,
} from "../../src/application/ports/durable-run-repository-port.mjs";
import * as dataModule from "../../src/data/repositories/sqlite-durable-run-repository.mjs";
import {
  DURABLE_RUN_REPOSITORY_REQUIRED_METHODS,
} from "../../src/domain/execution/durable-run-repository-semantics.mjs";

const execFileAsync = promisify(execFile);
const DATA_MODULE_URL = pathToFileURL(path.resolve(
  "src/data/repositories/sqlite-durable-run-repository.mjs",
)).href;

async function tempDatabase(t, name = "durable.sqlite") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-a09-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, name);
}

function runIdentity(runId) {
  return {
    runId,
    graphDigest: `graph:${runId}`,
    taskFingerprint: `task:${runId}`,
  };
}

function claimInput(runId, overrides = {}) {
  return {
    runId,
    nodeId: "stage:execution:lane:worker",
    nodeDefinitionHash: "node:v1",
    inputHash: "input:v1",
    dependencyOutputHash: "dependencies:v1",
    ownerId: "worker:a",
    leaseMs: 1_000,
    nowMs: 10_000,
    ...overrides,
  };
}

test("78 — legacy, application, and Data entrypoints expose one repository API", async () => {
  assert.equal(legacyKernelModule.openDurableRunKernel, applicationModule.openDurableRunKernel);
  assert.equal(applicationModule.openDurableRunKernel, applicationModule.openDurableRunRepository);
  assert.equal(dataModule.openDurableRunKernel, dataModule.openSqliteDurableRunRepository);
  assert.equal(
    legacyKernelModule.DURABLE_RUN_KERNEL_SCHEMA_VERSION,
    dataModule.DURABLE_RUN_KERNEL_SCHEMA_VERSION,
  );

  for (const open of [
    legacyKernelModule.openDurableRunKernel,
    applicationModule.openDurableRunRepository,
    dataModule.openSqliteDurableRunRepository,
  ]) {
    const repository = await open();
    try {
      assert.equal(assertDurableRunRepositoryPort(repository), repository);
      for (const method of DURABLE_RUN_REPOSITORY_REQUIRED_METHODS) {
        assert.equal(typeof repository[method], "function", method);
      }
      assert.equal(repository.db, undefined);
    } finally {
      repository.close();
    }
  }
});

test("78 — old and new entrypoints reopen each other's existing database without migration", async (t) => {
  for (const [createWith, reopenWith, suffix] of [
    [legacyKernelModule.openDurableRunKernel, dataModule.openSqliteDurableRunRepository, "old-to-new"],
    [dataModule.openSqliteDurableRunRepository, legacyKernelModule.openDurableRunKernel, "new-to-old"],
  ]) {
    const dbPath = await tempDatabase(t, `${suffix}.sqlite`);
    const identity = runIdentity(`run:${suffix}`);
    const creator = await createWith(dbPath);
    creator.createRun(identity);
    creator.appendEvent({
      runId: identity.runId,
      eventId: `${identity.runId}:observation`,
      eventType: "CompatibilityObserved",
      payload: { direction: suffix },
    });
    const expected = creator.projectRun(identity.runId);
    creator.close();

    const reopened = await reopenWith(dbPath);
    try {
      assert.deepEqual(reopened.projectRun(identity.runId), expected);
      assert.equal(reopened.verifyEventChain(identity.runId).ok, true);
    } finally {
      reopened.close();
    }
  }
});

test("78 — an injected completion failure rolls back event, transition, checkpoint, and head", async (t) => {
  const dbPath = await tempDatabase(t);
  const repository = await dataModule.openSqliteDurableRunRepository(dbPath, { enableTestHooks: true });
  try {
    const identity = runIdentity("run:rollback");
    repository.createRun(identity);
    const attempt = repository.claimNode(claimInput(identity.runId));
    const before = repository.projectRun(identity.runId);

    assert.throws(
      () => repository.completeNode({
        runId: identity.runId,
        nodeId: claimInput(identity.runId).nodeId,
        attemptId: attempt.attemptId,
        fenceToken: attempt.fenceToken,
        ownerId: "worker:a",
        output: { mustNotCommit: true },
        nowMs: 10_100,
      }, {
        onWriteStep(step) {
          if (step === "checkpoint") throw new Error("injected A09 rollback");
        },
      }),
      /injected A09 rollback/u,
    );

    const after = repository.projectRun(identity.runId);
    assert.deepEqual(after, before);
    assert.equal(after.completedNodes.length, 0);
    assert.equal(after.headCheckpointId, null);
    assert.equal(
      repository.testOnly.database.prepare(
        "SELECT COUNT(*) AS count FROM governed_checkpoints WHERE run_id = ?",
      ).get(identity.runId).count,
      0,
    );
  } finally {
    repository.close();
  }
});

test("78 — concurrent Data writers preserve per-run cursor CAS and hash-chain order", async (t) => {
  const dbPath = await tempDatabase(t);
  const identity = runIdentity("run:concurrent-cas");
  const repository = await dataModule.openSqliteDurableRunRepository(dbPath);
  repository.createRun(identity);
  repository.close();

  const childScript = `
    const { openSqliteDurableRunRepository } = await import(process.argv[1]);
    const repository = await openSqliteDurableRunRepository(process.argv[2]);
    repository.appendEvent({
      runId: ${JSON.stringify(identity.runId)},
      eventId: process.argv[3],
      eventType: "ConcurrentObservation",
      payload: { writer: process.argv[3] },
    });
    repository.close();
  `;
  await Promise.all(["writer:1", "writer:2", "writer:3", "writer:4"].map((eventId) =>
    execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      childScript,
      DATA_MODULE_URL,
      dbPath,
      eventId,
    ]),
  ));

  const reopened = await legacyKernelModule.openDurableRunKernel(dbPath);
  try {
    const events = reopened.getEvents(identity.runId);
    assert.deepEqual(events.map((event) => event.eventSeq), [1, 2, 3, 4, 5]);
    assert.equal(new Set(events.map((event) => event.eventId)).size, 5);
    assert.equal(reopened.verifyEventChain(identity.runId).ok, true);
  } finally {
    reopened.close();
  }
});

test("78 — lease takeover increments the fence and completion stays checkpoint-event bound", async (t) => {
  const repository = await dataModule.openSqliteDurableRunRepository(await tempDatabase(t));
  try {
    const identity = runIdentity("run:lease-fence-checkpoint");
    repository.createRun(identity);
    const first = repository.claimNode(claimInput(identity.runId, { leaseMs: 10 }));
    const second = repository.claimNode(claimInput(identity.runId, {
      ownerId: "worker:b",
      leaseMs: 10,
      nowMs: 10_011,
    }));
    assert.equal(second.fenceToken, first.fenceToken + 1);
    assert.throws(
      () => repository.completeNode({
        runId: identity.runId,
        nodeId: claimInput(identity.runId).nodeId,
        attemptId: first.attemptId,
        fenceToken: first.fenceToken,
        ownerId: "worker:a",
        output: { stale: true },
        nowMs: 10_012,
      }),
      /stale|fence|claim/iu,
    );

    const completed = repository.completeNode({
      runId: identity.runId,
      nodeId: claimInput(identity.runId).nodeId,
      attemptId: second.attemptId,
      fenceToken: second.fenceToken,
      ownerId: "worker:b",
      output: { accepted: true },
      nowMs: 10_012,
    });
    const projection = repository.projectRun(identity.runId);
    const completionEvent = projection.events.find(
      (event) => event.eventType === "NodeAttemptCompleted" && event.attemptId === second.attemptId,
    );
    const lineage = repository.getCheckpointLineage(completed.checkpointId);
    assert.equal(completionEvent.eventSeq, completed.eventSeq);
    assert.equal(lineage.at(-1).eventSeq, completionEvent.eventSeq);
    assert.equal(projection.headCheckpointId, completed.checkpointId);
    assert.equal(projection.completedNodes[0].sourceAttemptId, second.attemptId);
    assert.equal(repository.verifyEventChain(identity.runId).ok, true);
  } finally {
    repository.close();
  }
});

test("78 — Data projections retain A08 identity attestation across the legacy facade", async () => {
  const repository = await dataModule.openSqliteDurableRunRepository();
  try {
    const identity = runIdentity("run:a08-attestation");
    repository.createRun(identity);
    const projection = repository.projectRun(identity.runId);
    const resume = repository.resumeRun(identity);
    for (const module of [dataModule, applicationModule, legacyKernelModule]) {
      assert.equal(module.isAttestedDurableRunProjection(projection), true);
      assert.equal(module.isAttestedDurableRunResume(resume), true);
      assert.equal(module.isAttestedDurableRunProjection(structuredClone(projection)), false);
      assert.equal(module.isAttestedDurableRunResume(structuredClone(resume)), false);
    }
  } finally {
    repository.close();
  }
});

test("78 — legacy analytics run_events can coexist but cannot alter durable execution truth", async (t) => {
  const dbPath = await tempDatabase(t);
  const runId = "run:shared-name-isolated-authority";
  const analytics = await openRunStateStore(dbPath);
  analytics.appendEvent({
    eventId: "analytics:event",
    runId,
    stage: "review",
    eventType: "analytics_projection",
    payload: { revision: 1 },
    createdAt: "2026-08-12T00:00:00.000Z",
  });
  analytics.close();

  const durable = await dataModule.openSqliteDurableRunRepository(dbPath);
  durable.createRun(runIdentity(runId));
  const durableBefore = durable.projectRun(runId);
  durable.close();

  const analyticsReplacement = await openRunStateStore(dbPath);
  analyticsReplacement.appendEvent({
    eventId: "analytics:event",
    runId,
    stage: "review",
    eventType: "analytics_projection_replaced",
    payload: { revision: 2 },
    createdAt: "2026-08-12T00:00:01.000Z",
  });
  assert.equal(analyticsReplacement.count("run_events"), 1);
  analyticsReplacement.close();

  const durableReopened = await legacyKernelModule.openDurableRunKernel(dbPath);
  try {
    assert.deepEqual(durableReopened.projectRun(runId), durableBefore);
    assert.deepEqual(
      durableReopened.getEvents(runId).map((event) => event.eventType),
      ["RunCreated"],
    );
    assert.equal(durableReopened.verifyEventChain(runId).ok, true);
  } finally {
    durableReopened.close();
  }
});
