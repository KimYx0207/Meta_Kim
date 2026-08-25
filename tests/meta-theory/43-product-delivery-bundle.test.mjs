import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importDatabaseSync } from "../../src/data/sqlite/runtime.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function hasLocalAbsolutePath(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /[A-Za-z]:[\\/]/.test(text) || /\/(?:Users|home|var|tmp|mnt)\//.test(text);
}

function runProductBundle({ stateDir, profile }) {
  const result = spawnSync(process.execPath, [
    "scripts/generate-product-delivery-bundle.mjs",
    "--state-dir",
    stateDir,
  ], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 90_000,
    env: { ...process.env, META_KIM_PROFILE: profile },
  });
  const jsonStart = result.stdout.indexOf("{");
  assert.notEqual(jsonStart, -1, result.stdout);
  const summary = JSON.parse(result.stdout.slice(jsonStart));
  assert.equal(result.status, summary.status === "pass" ? 0 : 1, result.stderr || result.stdout);
  return summary;
}

describe("43 — Product delivery bundle and reviewer calibration", () => {
  test("P-045/P-046/P-059/P-060 generate a privacy-safe AI-readable product bundle", async () => {
    const disposableRoot = mkdtempSync(path.join(tmpdir(), "meta-kim-delivery-bundle-test-"));
    const stateDir = path.join(disposableRoot, "state");
    const profile = `delivery-bundle-test-${path.basename(disposableRoot).replace(/[^A-Za-z0-9._-]/gu, "-")}`;
    const disposableProfileDir = path.join(REPO_ROOT, ".meta-kim", "state", profile);
    const defaultStateDir = path.join(REPO_ROOT, ".meta-kim", "state", "default", "product-delivery-bundle");
    const defaultBefore = existsSync(defaultStateDir)
      ? readdirSync(defaultStateDir).sort()
      : [];
    try {
    const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    assert.equal(
      packageJson.scripts["meta:delivery:bundle"],
      "node scripts/generate-product-delivery-bundle.mjs",
    );
    const legacyBundleScript = ["meta", "cour" + "se", "bundle"].join(":");
    assert.equal(packageJson.scripts[legacyBundleScript], undefined);

    const contract = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "config/contracts/product-delivery-bundle-contract.json"), "utf8"),
    );
    assert.equal(contract.schemaVersion, "product-delivery-bundle-contract-v0.1");
    assert.deepEqual(contract.requiredSections, [
      "design",
      "execution",
      "acceptance",
      "feedback",
      "deliverables",
    ]);
    assert.equal(contract.privacyRules.forbidLocalAbsolutePaths, true);

    const summary = runProductBundle({ stateDir, profile });
    assert.equal(summary.ok, false);
    assert.equal(summary.status, "partial");
    assert.equal(summary.governedRunStatus, "partial");
    assert.equal(summary.requiredSectionsCovered, 5);
    assert.ok(summary.fileCount >= 12);
    assert.equal(summary.scoringSampleCount, 8);
    assert.deepEqual(summary.missingPitfalls, []);
    assert.equal(summary.privacyStatus, "pass");
    assert.equal(summary.reusedGovernedRun, false);
    assert.match(summary.bundleIdentity, /^[a-f0-9]{16}$/u);
    assert.match(summary.sourceClosureDigest, /^[a-f0-9]{64}$/u);
    assert.equal(summary.governedRunId, `product-delivery-bundle-${summary.bundleIdentity}`);

    const repeated = runProductBundle({ stateDir, profile });
    assert.equal(repeated.bundleIdentity, summary.bundleIdentity);
    assert.equal(repeated.governedRunId, summary.governedRunId);
    assert.equal(repeated.reusedGovernedRun, true);
    const governedJsonPath = path.join(stateDir, `${summary.governedRunId}.json`);
    const governedMarkdownPath = path.join(stateDir, `${summary.governedRunId}.en.md`);
    const reservationPath = path.join(stateDir, `${summary.governedRunId}.reservation.json`);
    const sqlitePath = path.join(stateDir, `governed-${summary.bundleIdentity}.sqlite`);
    const reservation = JSON.parse(readFileSync(reservationPath, "utf8"));
    assert.equal(reservation.phase, "materialized");
    assert.equal(reservation.status, "materialized");
    assert.match(reservation.jsonSha256, /^[a-f0-9]{64}$/u);
    assert.match(reservation.markdownSha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(reservation.artifactRefs, {
      json: path.basename(governedJsonPath),
      markdown: path.basename(governedMarkdownPath),
    });

    const DatabaseSync = await importDatabaseSync();
    const db = new DatabaseSync(sqlitePath);
    try {
      const row = db.prepare(`
        SELECT status, artifact_status, task_fingerprint, bundle_identity
        FROM product_delivery_bundle_runs WHERE run_id = ?
      `).get(summary.governedRunId);
      assert.equal(row.status, "materialized");
      assert.equal(row.artifact_status, "partial");
      assert.equal(row.bundle_identity, summary.bundleIdentity);
      assert.equal(row.task_fingerprint, JSON.parse(readFileSync(governedJsonPath, "utf8")).taskFingerprint);
    } finally {
      db.close();
    }

    const tamperedJson = JSON.parse(readFileSync(governedJsonPath, "utf8"));
    tamperedJson.status = "pass";
    writeFileSync(governedJsonPath, `${JSON.stringify(tamperedJson, null, 2)}\n`, "utf8");
    assert.equal(runProductBundle({ stateDir, profile }).reusedGovernedRun, false);
    assert.equal(JSON.parse(readFileSync(governedJsonPath, "utf8")).status, "partial");

    writeFileSync(governedMarkdownPath, "tampered markdown\n", "utf8");
    assert.equal(runProductBundle({ stateDir, profile }).reusedGovernedRun, false);

    const incompleteReservation = JSON.parse(readFileSync(reservationPath, "utf8"));
    incompleteReservation.phase = "reserved";
    incompleteReservation.status = "reserved_or_incomplete";
    incompleteReservation.jsonSha256 = null;
    writeFileSync(reservationPath, `${JSON.stringify(incompleteReservation, null, 2)}\n`, "utf8");
    assert.equal(runProductBundle({ stateDir, profile }).reusedGovernedRun, false);

    const tamperDb = new DatabaseSync(sqlitePath);
    try {
      tamperDb.prepare(`
        UPDATE product_delivery_bundle_runs
        SET task_fingerprint = 'tampered'
        WHERE run_id = ?
      `).run(summary.governedRunId);
    } finally {
      tamperDb.close();
    }
    assert.equal(runProductBundle({ stateDir, profile }).reusedGovernedRun, false);
    assert.equal(runProductBundle({ stateDir, profile }).reusedGovernedRun, true);
    assert.deepEqual(
      readdirSync(stateDir).filter((name) => /^governed-.*\.sqlite$/u.test(name)),
      [`governed-${summary.bundleIdentity}.sqlite`],
    );
    assert.deepEqual(
      readdirSync(stateDir).filter((name) => name.endsWith(".reservation.json")),
      [`${summary.governedRunId}.reservation.json`],
    );
    assert.deepEqual(
      readdirSync(stateDir).filter((name) => /^product-delivery-bundle-.*\.json$/u.test(name)),
      [
        `${summary.governedRunId}.json`,
        `${summary.governedRunId}.reservation.json`,
      ],
    );
    assert.deepEqual(
      existsSync(defaultStateDir) ? readdirSync(defaultStateDir).sort() : [],
      defaultBefore,
      "isolated test execution must not add files to the real default profile",
    );

    assert.equal(hasLocalAbsolutePath(summary), false, JSON.stringify(summary));
    const reportPath = path.join(stateDir, "latest.json");
    const markdownPath = path.join(stateDir, "latest.zh-CN.md");
    assert.equal(existsSync(reportPath), true);
    assert.equal(existsSync(markdownPath), true);

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.schemaVersion, "product-delivery-bundle-v0.1");
    assert.equal(report.status, "partial");
    assert.equal(report.summary.governedRunStatus, "partial");
    assert.equal(report.lifecycle.sourceClosureDigest, summary.sourceClosureDigest);
    assert.equal(report.summary.requiredFilesCovered, contract.requiredFiles.length);
    assert.equal(report.privacyCheck.status, "pass");
    assert.equal(hasLocalAbsolutePath(report), false);

    assert.deepEqual(
      report.sections.map((section) => section.id),
      ["design", "execution", "acceptance", "feedback", "deliverables"],
    );
    for (const fileKey of contract.requiredFiles) {
      assert.ok(report.files[fileKey], `missing file ${fileKey}`);
      assert.ok(report.files[fileKey].reviewUse, `missing reviewUse for ${fileKey}`);
    }

    const calibration = report.reviewerCalibration;
    assert.equal(calibration.schemaVersion, "product-reviewer-calibration-v0.1");
    assert.equal(calibration.sampleCount, 8);
    assert.ok(calibration.positiveExampleCount >= 2);
    assert.ok(calibration.negativeExampleCount >= 5);
    assert.deepEqual(calibration.missingPitfalls, []);
    for (const pitfall of [
      "research_before_orchestration",
      "skill_only_capability",
      "fake_parallelism",
      "fixture_pass_as_live",
      "unauthorized_writeback",
      "github_gap_overclaim",
      "warden_approval_confusion",
      "mixed_deliverables",
    ]) {
      assert.ok(calibration.coveredPitfalls.includes(pitfall), `missing pitfall ${pitfall}`);
    }

    const markdown = readFileSync(markdownPath, "utf8");
    assert.match(markdown, /Product Delivery Bundle/);
    assert.match(markdown, /design/);
    assert.match(markdown, /execution/);
    assert.match(markdown, /acceptance/);
    assert.match(markdown, /feedback/);
    assert.match(markdown, /deliverables/);
    assert.match(markdown, /Reviewer Calibration/);
    assert.match(markdown, /Privacy check rejects local absolute paths/);
    assert.equal(hasLocalAbsolutePath(markdown), false);
    } finally {
      rmSync(disposableRoot, { recursive: true, force: true });
      rmSync(disposableProfileDir, { recursive: true, force: true });
    }
  });
});
