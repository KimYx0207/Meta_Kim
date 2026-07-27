import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  VERIFICATION_REPORT_POINTER_SCHEMA_VERSION,
  VERIFICATION_REPORT_SCHEMA_VERSION,
  resolveVerificationHistoryDir,
  writeVerificationReportAttempt,
} from "../../scripts/verification-report-history.mjs";

const DIRECTORY_LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

function fixtureReport({ completedAt, ok, releaseGrade }) {
  return {
    ok,
    releaseGrade,
    startedAt: "2026-07-27T00:00:00.000Z",
    completedAt,
    failedStage: ok ? null : "meta:test:unit",
    stages: [],
  };
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function withTempStore(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-verification-history-"));
  try {
    return run({
      root,
      reportPath: path.join(root, "verification-report.json"),
      historyDir: path.join(root, "verification-reports"),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("verification reports preserve every failed and successful attempt", () => {
  withTempStore(({ reportPath, historyDir }) => {
    const failed = writeVerificationReportAttempt({
      reportPath,
      historyDir,
      attemptId: "attempt-failed",
      report: fixtureReport({
        completedAt: "2026-07-27T01:00:00.000Z",
        ok: false,
        releaseGrade: false,
      }),
    });
    const passed = writeVerificationReportAttempt({
      reportPath,
      historyDir,
      attemptId: "attempt-passed",
      report: fixtureReport({
        completedAt: "2026-07-27T02:00:00.000Z",
        ok: true,
        releaseGrade: true,
      }),
    });

    assert.equal(readJson(failed.recordPath).attemptId, "attempt-failed");
    assert.equal(readJson(passed.recordPath).attemptId, "attempt-passed");
    assert.equal(readJson(reportPath).attemptId, "attempt-passed");
    assert.equal(readJson(reportPath).schemaVersion, VERIFICATION_REPORT_SCHEMA_VERSION);
    assert.deepEqual(
      readdirSync(path.join(historyDir, "attempts")).sort(),
      ["attempt-failed.json", "attempt-passed.json"],
    );
    const latest = readJson(path.join(historyDir, "latest-attempt.json"));
    assert.equal(latest.schemaVersion, VERIFICATION_REPORT_POINTER_SCHEMA_VERSION);
    assert.equal(latest.attemptId, "attempt-passed");
    assert.equal(
      readJson(path.join(historyDir, "latest-release-grade.json")).attemptId,
      "attempt-passed",
    );
  });
});

test("latest projection follows completedAt instead of last lock writer", () => {
  withTempStore(({ reportPath, historyDir }) => {
    writeVerificationReportAttempt({
      reportPath,
      historyDir,
      attemptId: "newer-completion",
      report: fixtureReport({
        completedAt: "2026-07-27T03:00:00.000Z",
        ok: true,
        releaseGrade: true,
      }),
    });
    writeVerificationReportAttempt({
      reportPath,
      historyDir,
      attemptId: "older-completion-written-last",
      report: fixtureReport({
        completedAt: "2026-07-27T02:00:00.000Z",
        ok: false,
        releaseGrade: false,
      }),
    });

    assert.equal(readJson(reportPath).attemptId, "newer-completion");
    assert.equal(
      readJson(path.join(historyDir, "latest-attempt.json")).attemptId,
      "newer-completion",
    );
  });
});

test("attempt files are immutable and duplicate ids fail closed", () => {
  withTempStore(({ reportPath, historyDir }) => {
    const options = {
      reportPath,
      historyDir,
      attemptId: "immutable-attempt",
      report: fixtureReport({
        completedAt: "2026-07-27T04:00:00.000Z",
        ok: false,
        releaseGrade: false,
      }),
    };
    const first = writeVerificationReportAttempt(options);
    const before = readFileSync(first.recordPath, "utf8");
    assert.throws(
      () => writeVerificationReportAttempt(options),
      (error) => error?.code === "EEXIST",
    );
    assert.equal(readFileSync(first.recordPath, "utf8"), before);
  });
});

test("first v2 write imports the existing legacy release-grade report", () => {
  withTempStore(({ reportPath, historyDir }) => {
    const legacy = fixtureReport({
      completedAt: "2026-07-27T04:30:00.000Z",
      ok: true,
      releaseGrade: true,
    });
    writeFileSync(reportPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
    const result = writeVerificationReportAttempt({
      reportPath,
      historyDir,
      attemptId: "new-failure",
      report: fixtureReport({
        completedAt: "2026-07-27T04:45:00.000Z",
        ok: false,
        releaseGrade: false,
      }),
    });

    const attemptNames = readdirSync(path.join(historyDir, "attempts"));
    assert.equal(attemptNames.length, 2);
    const preservedReleaseGrade = readJson(result.latestReleaseGradePath);
    assert.equal(preservedReleaseGrade.releaseGrade, true);
    assert.equal(preservedReleaseGrade.importedFromLegacyProjection, true);
    assert.equal(readJson(reportPath).attemptId, "new-failure");
    assert.equal(
      readJson(path.join(historyDir, "latest-release-grade.json")).attemptId,
      preservedReleaseGrade.attemptId,
    );
  });
});

test("custom report paths in one directory keep isolated histories", () => {
  withTempStore(({ root }) => {
    const reportA = path.join(root, "a.json");
    const reportB = path.join(root, "b.json");
    writeVerificationReportAttempt({
      reportPath: reportA,
      attemptId: "a-newer",
      report: fixtureReport({
        completedAt: "2026-07-27T06:00:00.000Z",
        ok: true,
        releaseGrade: true,
      }),
    });
    writeVerificationReportAttempt({
      reportPath: reportB,
      attemptId: "b-older",
      report: fixtureReport({
        completedAt: "2026-07-27T05:00:00.000Z",
        ok: false,
        releaseGrade: false,
      }),
    });

    assert.equal(readJson(reportA).attemptId, "a-newer");
    assert.equal(readJson(reportB).attemptId, "b-older");
    assert.notEqual(resolveVerificationHistoryDir(reportA), resolveVerificationHistoryDir(reportB));
    assert.deepEqual(readdirSync(path.join(resolveVerificationHistoryDir(reportA), "attempts")), ["a-newer.json"]);
    assert.deepEqual(readdirSync(path.join(resolveVerificationHistoryDir(reportB), "attempts")), ["b-older.json"]);
  });
});

test("a corrupt attempt is preserved as evidence without blocking later writes", () => {
  withTempStore(({ reportPath, historyDir }) => {
    const attemptsDir = path.join(historyDir, "attempts");
    mkdirSync(attemptsDir, { recursive: true });
    writeFileSync(path.join(attemptsDir, "half-written.json"), "{\"ok\":", "utf8");
    const result = writeVerificationReportAttempt({
      reportPath,
      historyDir,
      attemptId: "recovered-attempt",
      report: fixtureReport({
        completedAt: "2026-07-27T07:00:00.000Z",
        ok: true,
        releaseGrade: true,
      }),
    });

    assert.equal(readJson(result.recordPath).historyRecovery.corruptAttemptCount, 1);
    assert.equal(readdirSync(path.join(historyDir, "corrupt-attempts")).length, 1);
    assert.deepEqual(readdirSync(attemptsDir), ["recovered-attempt.json"]);
  });
});

test("a stale malformed lock is preserved and recovered", () => {
  withTempStore(({ reportPath, historyDir }) => {
    mkdirSync(historyDir, { recursive: true });
    const lockPath = path.join(historyDir, "write.lock");
    writeFileSync(lockPath, "{", "utf8");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    writeVerificationReportAttempt({
      reportPath,
      historyDir,
      attemptId: "after-stale-lock",
      malformedLockStaleMs: 1_000,
      report: fixtureReport({
        completedAt: "2026-07-27T08:00:00.000Z",
        ok: true,
        releaseGrade: true,
      }),
    });

    assert.equal(readdirSync(path.join(historyDir, "stale-locks")).length, 1);
    assert.equal(readJson(reportPath).attemptId, "after-stale-lock");
  });
});

test("a stale well-formed lock with a reused live pid is recovered by age", () => {
  withTempStore(({ reportPath, historyDir }) => {
    mkdirSync(historyDir, { recursive: true });
    const lockPath = path.join(historyDir, "write.lock");
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      token: "old-owner-token",
      createdAt: "2000-01-01T00:00:00.000Z",
    }), "utf8");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    writeVerificationReportAttempt({
      reportPath,
      historyDir,
      attemptId: "after-reused-pid-lock",
      wellFormedLockStaleMs: 1_000,
      report: fixtureReport({
        completedAt: "2026-07-27T08:30:00.000Z",
        ok: true,
        releaseGrade: true,
      }),
    });

    assert.equal(readdirSync(path.join(historyDir, "stale-locks")).length, 1);
    assert.equal(readJson(reportPath).attemptId, "after-reused-pid-lock");
  });
});

test("equal completion timestamps use attemptId as a deterministic tie-breaker", () => {
  withTempStore(({ reportPath, historyDir }) => {
    const completedAt = "2026-07-27T09:00:00.000Z";
    for (const attemptId of ["tie-z", "tie-a"]) {
      writeVerificationReportAttempt({
        reportPath,
        historyDir,
        attemptId,
        report: fixtureReport({ completedAt, ok: true, releaseGrade: true }),
      });
    }
    assert.equal(readJson(reportPath).attemptId, "tie-z");
  });
});

test("a v2 projection cannot escape attempts history through its attemptId", () => {
  withTempStore(({ root, reportPath, historyDir }) => {
    const unsafeWithoutHash = {
      ...fixtureReport({
        completedAt: "2026-07-27T09:30:00.000Z",
        ok: true,
        releaseGrade: true,
      }),
      schemaVersion: VERIFICATION_REPORT_SCHEMA_VERSION,
      attemptId: "../../escaped-report",
      previousAttemptId: null,
    };
    const unsafe = {
      ...unsafeWithoutHash,
      attemptRecordHash: createHash("sha256")
        .update(JSON.stringify(unsafeWithoutHash))
        .digest("hex"),
    };
    writeFileSync(reportPath, `${JSON.stringify(unsafe, null, 2)}\n`, "utf8");

    const recovered = writeVerificationReportAttempt({
      reportPath,
      historyDir,
      attemptId: "safe-new-attempt",
      report: fixtureReport({
        completedAt: "2026-07-27T10:00:00.000Z",
        ok: false,
        releaseGrade: false,
      }),
    });
    assert.equal(recovered.corruptProjections.length, 1);
    assert.equal(readJson(reportPath).attemptId, "safe-new-attempt");
    assert.equal(existsSync(path.join(root, "escaped-report.json")), false);
  });
});

test("a half-written legacy projection is preserved without blocking recovery", () => {
  withTempStore(({ reportPath, historyDir }) => {
    writeFileSync(reportPath, "{\"ok\":", "utf8");
    const recovered = writeVerificationReportAttempt({
      reportPath,
      historyDir,
      attemptId: "after-half-projection",
      report: fixtureReport({
        completedAt: "2026-07-27T10:15:00.000Z",
        ok: true,
        releaseGrade: true,
      }),
    });
    assert.equal(recovered.corruptProjections.length, 1);
    assert.equal(readdirSync(path.join(historyDir, "corrupt-projections")).length, 1);
    assert.equal(readJson(reportPath).attemptId, "after-half-projection");
  });
});

test("release-grade immutable path cannot be reused as another report output", () => {
  withTempStore(({ reportPath }) => {
    const first = writeVerificationReportAttempt({
      reportPath,
      attemptId: "release-grade-source",
      report: fixtureReport({
        completedAt: "2026-07-27T10:30:00.000Z",
        ok: true,
        releaseGrade: true,
      }),
    });
    const before = readFileSync(first.latestReleaseGradePath, "utf8");
    assert.throws(
      () => writeVerificationReportAttempt({
        reportPath: first.latestReleaseGradePath,
        attemptId: "colliding-custom-output",
        report: fixtureReport({
          completedAt: "2026-07-27T11:00:00.000Z",
          ok: false,
          releaseGrade: false,
        }),
      }),
      /cannot be placed inside report history/u,
    );
    assert.equal(readFileSync(first.latestReleaseGradePath, "utf8"), before);
  });
});

test("a normal directory named verification-reports remains a valid custom parent", () => {
  withTempStore(({ root }) => {
    const ordinaryDirectory = path.join(root, "reports", "verification-reports");
    mkdirSync(ordinaryDirectory, { recursive: true });
    const customReport = path.join(ordinaryDirectory, "custom.json");
    writeVerificationReportAttempt({
      reportPath: customReport,
      attemptId: "ordinary-parent-name",
      report: fixtureReport({
        completedAt: "2026-07-27T11:30:00.000Z",
        ok: true,
        releaseGrade: true,
      }),
    });
    assert.equal(readJson(customReport).attemptId, "ordinary-parent-name");
  });
});

test("Windows path casing cannot bypass immutable history protection", {
  skip: process.platform !== "win32",
}, () => {
  withTempStore(({ root, reportPath }) => {
    const first = writeVerificationReportAttempt({
      reportPath,
      attemptId: "windows-case-source",
      report: fixtureReport({
        completedAt: "2026-07-27T11:45:00.000Z",
        ok: true,
        releaseGrade: true,
      }),
    });
    const caseAlias = path.join(
      root,
      "Verification-Reports",
      "ATTEMPTS",
      "windows-case-source.json",
    );
    const before = readFileSync(first.recordPath, "utf8");
    assert.throws(
      () => writeVerificationReportAttempt({
        reportPath: caseAlias,
        attemptId: "case-alias-overwrite",
        report: fixtureReport({
          completedAt: "2026-07-27T12:00:00.000Z",
          ok: false,
          releaseGrade: false,
        }),
      }),
      /cannot be placed inside report history/u,
    );
    assert.equal(readFileSync(first.recordPath, "utf8"), before);
  });
});

test("an ancestor directory link cannot alias an immutable attempt as report output", (t) => {
  withTempStore(({ root, reportPath }) => {
    const first = writeVerificationReportAttempt({
      reportPath,
      attemptId: "linked-history-source",
      report: fixtureReport({
        completedAt: "2026-07-27T12:15:00.000Z",
        ok: true,
        releaseGrade: true,
      }),
    });
    const aliasRoot = path.join(root, "history-alias");
    try {
      symlinkSync(first.historyDir, aliasRoot, DIRECTORY_LINK_TYPE);
    } catch (error) {
      t.skip(`directory links unavailable: ${error.code ?? error.message}`);
      return;
    }
    const aliasedAttempt = path.join(
      aliasRoot,
      "attempts",
      "linked-history-source.json",
    );
    const before = readFileSync(first.recordPath, "utf8");
    assert.throws(
      () => writeVerificationReportAttempt({
        reportPath: aliasedAttempt,
        attemptId: "linked-history-overwrite",
        report: fixtureReport({
          completedAt: "2026-07-27T12:30:00.000Z",
          ok: false,
          releaseGrade: false,
        }),
      }),
      /cannot be placed inside report history/u,
    );
    assert.equal(readFileSync(first.recordPath, "utf8"), before);
  });
});

function runChild(scriptPath, index) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, String(index)], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`verification history child ${index} failed: ${stderr}`));
    });
  });
}

test("concurrent processes preserve all attempts and one valid latest projection", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-verification-concurrency-"));
  try {
    const reportPath = path.join(root, "verification-report.json");
    const historyDir = path.join(root, "verification-reports");
    const moduleUrl = pathToFileURL(
      path.resolve("scripts", "verification-report-history.mjs"),
    ).href;
    const scriptPath = path.join(root, "writer.mjs");
    writeFileSync(
      scriptPath,
      [
        `import { writeVerificationReportAttempt } from ${JSON.stringify(moduleUrl)};`,
        `const index = Number(process.argv[2]);`,
        `writeVerificationReportAttempt({`,
        `  reportPath: ${JSON.stringify(reportPath)},`,
        `  historyDir: ${JSON.stringify(historyDir)},`,
        `  attemptId: \`concurrent-\${index}\`,`,
        `  report: {`,
        `    ok: index % 2 === 0,`,
        `    releaseGrade: index % 2 === 0,`,
        `    startedAt: "2026-07-27T00:00:00.000Z",`,
        `    completedAt: \`2026-07-27T05:00:0\${index}.000Z\`,`,
        `    stages: [],`,
        `  },`,
        `});`,
      ].join("\n"),
      "utf8",
    );

    await Promise.all(Array.from({ length: 6 }, (_, index) => runChild(scriptPath, index)));

    const attempts = readdirSync(path.join(historyDir, "attempts"));
    assert.equal(attempts.length, 6);
    assert.equal(readJson(reportPath).attemptId, "concurrent-5");
    assert.equal(
      readJson(path.join(historyDir, "latest-attempt.json")).attemptId,
      "concurrent-5",
    );
    assert.equal(
      readJson(path.join(historyDir, "latest-release-grade.json")).attemptId,
      "concurrent-4",
    );
    assert.equal(
      readdirSync(historyDir).some((name) => name.endsWith(".tmp") || name === "write.lock"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
