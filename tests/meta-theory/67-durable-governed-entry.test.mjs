import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { openDurableRunKernel } from "../../scripts/governed-execution/durable-run-kernel.mjs";
import { runMetaTheoryGovernedExecution } from "../../scripts/run-meta-theory-governed-execution.mjs";

const execFileAsync = promisify(execFile);
const ENTRY = path.resolve("scripts/run-meta-theory-governed-execution.mjs");
const TASK = "Read package.json and report the exact package name and version. Do not modify files.";

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-p118-entry-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function workerCounter(counter) {
  return async ({ runtime, packet }) => {
    counter.count += 1;
    return {
      status: "pass",
      runtime,
      exitCode: 0,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 2,
      sessionId: `session-${packet.taskPacketId}`,
      messageId: `message-${packet.taskPacketId}`,
      outputText: "meta-kim 2.9.0",
      outputSha256: "a".repeat(64),
      rawOutputSha256: "b".repeat(64),
      hostEventCount: 1,
      toolEventCount: 1,
      stderrTail: "",
    };
  };
}

function durableStageRunner(root, counter, mode = "fresh") {
  return {
    enabled: true,
    runtime: "codex",
    durableMode: mode,
    durableDbPath: path.join(root, "durable-runs.sqlite"),
    durableLeaseMs: 1_000,
    durableHeartbeatIntervalMs: 100,
    capacity: 1,
    timeoutMs: 30_000,
    invokeWorker: workerCounter(counter),
  };
}

test("67 — CLI keeps planned-only default and validates durable fresh/resume flags before work", async (t) => {
  const root = await tempRoot(t);
  await assert.rejects(
    execFileAsync(process.execPath, [ENTRY, "--execute-stage-dag", "--resume-stage-dag", "--task", TASK], {
      cwd: process.cwd(),
      timeout: 10_000,
    }),
    /mutually exclusive|cannot be used together/iu,
  );
  await assert.rejects(
    execFileAsync(process.execPath, [ENTRY, "--resume-stage-dag", "--task", TASK], {
      cwd: process.cwd(),
      timeout: 10_000,
    }),
    /resume-stage-dag.*run-id|run-id.*required/iu,
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      ENTRY,
      "--execute-stage-dag",
      "--overwrite-run",
      "--task",
      TASK,
      "--state-dir",
      root,
    ], { cwd: process.cwd(), timeout: 10_000 }),
    /durable.*overwrite|overwrite.*durable/iu,
  );

  const planned = await runMetaTheoryGovernedExecution({
    task: TASK,
    stateDir: root,
    artifactDir: root,
    dbPath: path.join(root, "planned.sqlite"),
    projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
  });
  assert.equal(planned.stageRunnerBridgePacket, null);
  assert.equal(planned.executionResult.actualWorkerExecution, false);
  assert.equal(planned.durableExecution, undefined);
});

test("67 — fresh durable auto-run reserves identity, uses the stateDir database, and closes coordinator", async (t) => {
  const root = await tempRoot(t);
  const counter = { count: 0 };
  const report = await runMetaTheoryGovernedExecution({
    task: TASK,
    stateDir: root,
    artifactDir: root,
    dbPath: path.join(root, "analytics.sqlite"),
    projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
    stageRunner: {
      ...durableStageRunner(root, counter),
      durableDbPath: undefined,
    },
  });
  assert.ok(counter.count > 0);
  assert.equal(report.durableExecution.mode, "fresh");
  assert.equal(report.durableExecution.status, "materialized");
  assert.equal(report.durableExecution.database, "state_dir/durable-runs.sqlite");
  assert.equal(JSON.stringify(report.durableExecution).includes(path.resolve(root)), false);
  const reservation = JSON.parse(await fs.readFile(
    path.join(root, `${report.runId}.reservation.json`),
    "utf8",
  ));
  assert.equal(reservation.schemaVersion, "governed-run-reservation-v0.1");
  assert.equal(reservation.runId, report.runId);
  assert.equal(reservation.taskFingerprint, report.taskFingerprint);

  const kernel = await openDurableRunKernel(path.join(root, "durable-runs.sqlite"), {
    enableTestHooks: true,
  });
  try {
    assert.equal(kernel.projectRun(report.runId).run.status, "completed");
    const coordinator = kernel.testOnly.database.prepare(
      "SELECT * FROM governed_run_coordinators WHERE run_id = ?",
    ).get(report.runId);
    assert.equal(coordinator.owner_id, null);
    assert.equal(Number(coordinator.fence_token), report.durableExecution.fenceToken);
  } finally {
    kernel.close();
  }
});

test("67 — resume returns already_materialized without workers or overwrites and rejects one-sided artifacts", async (t) => {
  const root = await tempRoot(t);
  const runId = "p118-entry-already-materialized";
  const firstCounter = { count: 0 };
  const first = await runMetaTheoryGovernedExecution({
    task: TASK,
    runId,
    stateDir: root,
    artifactDir: root,
    dbPath: path.join(root, "analytics.sqlite"),
    projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
    stageRunner: durableStageRunner(root, firstCounter, "fresh"),
  });
  const jsonBefore = await fs.readFile(first.paths.json, "utf8");
  const markdownBefore = await fs.readFile(first.paths.markdown, "utf8");
  const resumedCounter = { count: 0 };
  const resumed = await runMetaTheoryGovernedExecution({
    task: TASK,
    runId,
    stateDir: root,
    artifactDir: root,
    dbPath: path.join(root, "analytics.sqlite"),
    projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
    stageRunner: durableStageRunner(root, resumedCounter, "resume"),
  });
  assert.equal(resumed.durableExecution.status, "already_materialized");
  assert.equal(resumed.durableExecution.workerCount, 0);
  assert.equal(resumedCounter.count, 0);
  assert.equal(await fs.readFile(first.paths.json, "utf8"), jsonBefore);
  assert.equal(await fs.readFile(first.paths.markdown, "utf8"), markdownBefore);

  await fs.rm(first.paths.markdown);
  await assert.rejects(
    runMetaTheoryGovernedExecution({
      task: TASK,
      runId,
      stateDir: root,
      artifactDir: root,
      dbPath: path.join(root, "analytics.sqlite"),
      projectRoot: process.cwd(),
      projectCapabilityMutationMode: "read_only",
      stageRunner: durableStageRunner(root, { count: 0 }, "resume"),
    }),
    /artifact.*incomplete|json.*markdown|fail.*closed/iu,
  );
});

test("67 — resume continues an identity-bound active kernel run and materializes it once", async (t) => {
  const root = await tempRoot(t);
  const runId = "p118-entry-active-resume";
  const planned = await runMetaTheoryGovernedExecution({
    task: TASK,
    runId,
    stateDir: root,
    artifactDir: root,
    dbPath: path.join(root, "analytics.sqlite"),
    projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
  });
  await fs.rm(planned.paths.json);
  await fs.rm(planned.paths.markdown);
  const durableDbPath = path.join(root, "durable-runs.sqlite");
  const kernel = await openDurableRunKernel(durableDbPath);
  try {
    kernel.createRun({
      runId,
      graphDigest: planned.coreLoop.stageDagPacket.graphDigest,
      taskFingerprint: planned.taskFingerprint,
    });
  } finally {
    kernel.close();
  }
  const counter = { count: 0 };
  const resumed = await runMetaTheoryGovernedExecution({
    task: TASK,
    runId,
    stateDir: root,
    artifactDir: root,
    dbPath: path.join(root, "analytics.sqlite"),
    projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
    stageRunner: durableStageRunner(root, counter, "resume"),
  });
  assert.ok(counter.count > 0);
  assert.equal(resumed.durableExecution.mode, "resume");
  assert.equal(resumed.durableExecution.status, "materialized");
  assert.equal(resumed.stageRunnerBridgePacket.executionProjection.durable.resumed, true);
});

test("67 — resume strictly binds reservation schema, runId, and task fingerprint", async (t) => {
  const root = await tempRoot(t);
  const runId = "p118-entry-reservation-binding";
  await fs.writeFile(
    path.join(root, `${runId}.reservation.json`),
    `${JSON.stringify({
      schemaVersion: "governed-run-reservation-v0.0",
      runId,
      taskFingerprint: "wrong",
      status: "reserved_or_incomplete",
    })}\n`,
  );
  await assert.rejects(
    runMetaTheoryGovernedExecution({
      task: TASK,
      runId,
      stateDir: root,
      artifactDir: root,
      dbPath: path.join(root, "analytics.sqlite"),
      projectRoot: process.cwd(),
      projectCapabilityMutationMode: "read_only",
      stageRunner: durableStageRunner(root, { count: 0 }, "resume"),
    }),
    /reservation.*schema|identity|fingerprint/iu,
  );
});

test("67 — progress callback crash after reservation resumes by creating the missing kernel run", async (t) => {
  const root = await tempRoot(t);
  const runId = "p118-progress-crash-resume";
  await assert.rejects(
    runMetaTheoryGovernedExecution({
      task: TASK,
      runId,
      stateDir: root,
      artifactDir: root,
      dbPath: path.join(root, "analytics.sqlite"),
      projectRoot: process.cwd(),
      projectCapabilityMutationMode: "read_only",
      onConversationProgress() {
        throw new Error("progress callback crash");
      },
      stageRunner: durableStageRunner(root, { count: 0 }, "fresh"),
    }),
    /progress callback crash/iu,
  );
  assert.equal((await fs.stat(path.join(root, `${runId}.reservation.json`))).isFile(), true);
  await assert.rejects(fs.stat(path.join(root, "durable-runs.sqlite")), /ENOENT/iu);
  const counter = { count: 0 };
  const resumed = await runMetaTheoryGovernedExecution({
    task: TASK,
    runId,
    stateDir: root,
    artifactDir: root,
    dbPath: path.join(root, "analytics.sqlite"),
    projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
    stageRunner: durableStageRunner(root, counter, "resume"),
  });
  assert.equal(resumed.durableExecution.mode, "resume");
  assert.equal(resumed.durableExecution.status, "materialized");
  assert.ok(counter.count > 0);
});

test("67 — already_materialized validates paired digests and CLI reports resume with zero workers", async (t) => {
  const root = await tempRoot(t);
  const runId = "p118-digest-bound-materialized";
  const first = await runMetaTheoryGovernedExecution({
    task: TASK,
    runId,
    stateDir: root,
    artifactDir: root,
    dbPath: path.join(root, "analytics.sqlite"),
    projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
    stageRunner: durableStageRunner(root, { count: 0 }, "fresh"),
  });
  const reservation = JSON.parse(await fs.readFile(path.join(root, `${runId}.reservation.json`), "utf8"));
  assert.equal(reservation.phase, "materialized");
  assert.match(reservation.jsonSha256, /^[a-f0-9]{64}$/u);
  assert.match(reservation.markdownSha256, /^[a-f0-9]{64}$/u);
  assert.ok(reservation.stagingRefs.json && !path.isAbsolute(reservation.stagingRefs.json));
  assert.ok(reservation.stagingRefs.markdown && !path.isAbsolute(reservation.stagingRefs.markdown));

  const { stdout } = await execFileAsync(process.execPath, [
    ENTRY,
    "--resume-stage-dag",
    "--run-id",
    runId,
    "--task",
    TASK,
    "--state-dir",
    root,
    "--artifact-dir",
    root,
    "--db",
    path.join(root, "analytics.sqlite"),
    "--durable-db",
    path.join(root, "durable-runs.sqlite"),
  ], { cwd: process.cwd(), timeout: 30_000 });
  const summary = JSON.parse(stdout);
  assert.equal(summary.durableExecution.mode, "resume");
  assert.equal(summary.durableExecution.status, "already_materialized");
  assert.equal(summary.durableExecution.workerCount, 0);

  await fs.appendFile(first.paths.json, " \n");
  await assert.rejects(
    runMetaTheoryGovernedExecution({
      task: TASK,
      runId,
      stateDir: root,
      artifactDir: root,
      dbPath: path.join(root, "analytics.sqlite"),
      projectRoot: process.cwd(),
      projectCapabilityMutationMode: "read_only",
      stageRunner: durableStageRunner(root, { count: 0 }, "resume"),
    }),
    /digest|tamper|pair/iu,
  );
});

test("67 — resume repairs a missing final artifact from a bounded staging reference", async (t) => {
  const root = await tempRoot(t);
  const runId = "p118-stage-repair";
  const first = await runMetaTheoryGovernedExecution({
    task: TASK,
    runId,
    stateDir: root,
    artifactDir: root,
    dbPath: path.join(root, "analytics.sqlite"),
    projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
    stageRunner: durableStageRunner(root, { count: 0 }, "fresh"),
  });
  const reservationPath = path.join(root, `${runId}.reservation.json`);
  const reservation = JSON.parse(await fs.readFile(reservationPath, "utf8"));
  const markdownStage = path.join(root, reservation.stagingRefs.markdown);
  await fs.copyFile(first.paths.markdown, markdownStage);
  await fs.rm(first.paths.markdown);
  reservation.phase = "artifacts_committing";
  await fs.writeFile(reservationPath, `${JSON.stringify(reservation, null, 2)}\n`);
  const resumed = await runMetaTheoryGovernedExecution({
    task: TASK,
    runId,
    stateDir: root,
    artifactDir: root,
    dbPath: path.join(root, "analytics.sqlite"),
    projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
    stageRunner: durableStageRunner(root, { count: 0 }, "resume"),
  });
  assert.equal(resumed.durableExecution.status, "already_materialized");
  assert.equal((await fs.stat(first.paths.markdown)).isFile(), true);
});

test("67 — dual committed artifacts with an active DB resume to terminal without worker replay", async (t) => {
  const root = await tempRoot(t);
  const runId = "p118-artifacts-active-db";
  const crash = new Error("simulated materialization crash");
  crash.simulatedProcessCrash = true;
  const firstCounter = { count: 0 };
  await assert.rejects(
    runMetaTheoryGovernedExecution({
      task: TASK,
      runId,
      stateDir: root,
      artifactDir: root,
      dbPath: path.join(root, "analytics.sqlite"),
      projectRoot: process.cwd(),
      projectCapabilityMutationMode: "read_only",
      stageRunner: {
        ...durableStageRunner(root, firstCounter, "fresh"),
        materializationFaultInjector(step) {
          if (step === "artifacts_committed") throw crash;
        },
      },
    }),
    /simulated materialization crash/iu,
  );
  assert.ok(firstCounter.count > 0);
  assert.equal((await fs.stat(path.join(root, `${runId}.json`))).isFile(), true);
  assert.equal((await fs.stat(path.join(root, `${runId}.en.md`))).isFile(), true);
  const resumedCounter = { count: 0 };
  const resumed = await runMetaTheoryGovernedExecution({
    task: TASK,
    runId,
    stateDir: root,
    artifactDir: root,
    dbPath: path.join(root, "analytics.sqlite"),
    projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
    stageRunner: durableStageRunner(root, resumedCounter, "resume"),
  });
  assert.equal(resumed.durableExecution.status, "materialized");
  assert.equal(resumedCounter.count, 0);
});

test("67 — terminal kernel plus missing final artifact is finalized from staging without workers", async (t) => {
  const root = await tempRoot(t);
  const runId = "p118-terminal-missing-final";
  const crash = new Error("simulated post-terminal crash");
  crash.simulatedProcessCrash = true;
  await assert.rejects(
    runMetaTheoryGovernedExecution({
      task: TASK,
      runId,
      stateDir: root,
      artifactDir: root,
      dbPath: path.join(root, "analytics.sqlite"),
      projectRoot: process.cwd(),
      projectCapabilityMutationMode: "read_only",
      stageRunner: {
        ...durableStageRunner(root, { count: 0 }, "fresh"),
        materializationFaultInjector(step) {
          if (step === "kernel_terminal") throw crash;
        },
      },
    }),
    /simulated post-terminal crash/iu,
  );
  await fs.rm(path.join(root, `${runId}.json`));
  const counter = { count: 0 };
  const resumed = await runMetaTheoryGovernedExecution({
    task: TASK,
    runId,
    stateDir: root,
    artifactDir: root,
    dbPath: path.join(root, "analytics.sqlite"),
    projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
    stageRunner: durableStageRunner(root, counter, "resume"),
  });
  assert.equal(counter.count, 0);
  assert.equal(resumed.durableExecution.status, "already_materialized");
  const persisted = JSON.parse(await fs.readFile(path.join(root, `${runId}.json`), "utf8"));
  assert.equal(persisted.durableExecution.status, "materialized");
  assert.equal(JSON.parse(await fs.readFile(
    path.join(root, `${runId}.reservation.json`),
    "utf8",
  )).phase, "materialized");
});
