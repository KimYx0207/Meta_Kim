import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalJson,
  collectGitReleaseFacts,
  evaluateReleaseBinding,
  fetchGitHubReleaseFacts,
  readPackageManifestFromTgz,
  readVerificationEvidence,
  requireContainedOutput,
  runReleaseBindingAudit,
  sha256,
  writeReleaseBindingAttempt,
} from "../../scripts/audit-release-binding.mjs";

const DIR_LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

function octalField(value, length) {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function tarFile(relativePath, body) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const header = Buffer.alloc(512);
  header.write(`package/${relativePath}`, 0, 100, "utf8");
  header.write(octalField(0o644, 8), 100, 8, "ascii");
  header.write(octalField(0, 8), 108, 8, "ascii");
  header.write(octalField(0, 8), 116, 8, "ascii");
  header.write(octalField(bytes.length, 12), 124, 12, "ascii");
  header.write(octalField(0, 12), 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = 48;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc(Math.ceil(bytes.length / 512) * 512 - bytes.length);
  return Buffer.concat([header, bytes, padding]);
}

function minimalTgz(manifest, extraFiles = []) {
  const packageJson = `${JSON.stringify(manifest, null, 2)}\n`;
  return gzipSync(Buffer.concat([
    tarFile("package.json", packageJson),
    ...extraFiles.map(({ path: relativePath, body }) => tarFile(relativePath, body)),
    Buffer.alloc(1024),
  ]));
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function createReleaseRepo(version = "9.9.9") {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-audit-"));
  writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "meta-kim", version }, null, 2)}\n`,
  );
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Meta Kim Test");
  git(root, "config", "user.email", "meta-kim@example.invalid");
  git(root, "remote", "add", "origin", "https://github.com/example/meta-kim.git");
  git(root, "add", "package.json");
  git(root, "commit", "--quiet", "-m", "release fixture");
  git(root, "tag", "-a", `v${version}`, "-m", `v${version}`);
  const head = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", head);
  return root;
}

function exactReport(gitFacts, { dirty = false, packageSha256 = "a".repeat(64) } = {}) {
  const snapshot = {
    captureOk: true,
    head: gitFacts.peeledCommitSha,
    tree: gitFacts.peeledTreeSha,
    dirty,
    diffHash: "d".repeat(64),
    packageManifestHash: gitFacts.tagPackageJsonSha256,
  };
  return Buffer.from(JSON.stringify({
    ok: true,
    releaseGrade: true,
    packedProductProofComplete: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    releasePreflight: {
      packedUserProof: {
        status: "passed",
        releaseGradeEligible: true,
        sourcePolicy: "npm_pack_installed_public_cli",
        currentPackage: {
          status: "passed",
          installedCliEntrypoints: true,
          packageSha256,
          modes: [
            { mode: "install", status: "passed" },
            { mode: "update", status: "passed" },
            { mode: "update", status: "passed" },
          ],
        },
      },
      sourceSnapshot: {
        invocation: snapshot,
        postProbe: snapshot,
        end: snapshot,
        stable: true,
        cleanCommitEligible: !dirty,
        releaseEligible: true,
        mismatchReasons: [],
        windows: [
          {
            from: "invocation",
            to: "post_probe",
            stable: true,
            releaseEligible: true,
            cleanCommitEligible: !dirty,
            mismatchReasons: [],
          },
          {
            from: "post_probe",
            to: "final",
            stable: true,
            releaseEligible: true,
            cleanCommitEligible: !dirty,
            mismatchReasons: [],
          },
        ],
      },
    },
  }));
}

function githubPayload(gitFacts, assetSha, assetSize) {
  return {
    tag_name: gitFacts.tagName,
    html_url: `https://github.com/example/meta-kim/releases/tag/${gitFacts.tagName}`,
    target_commitish: "main",
    published_at: "2026-01-01T01:00:00.000Z",
    draft: false,
    prerelease: false,
    assets: [{
      name: `${gitFacts.packageName}-${gitFacts.packageVersion}.tgz`,
      size: assetSize,
      digest: `sha256:${assetSha}`,
      browser_download_url: "https://github.com/example/meta-kim/releases/download/package.tgz",
    }],
  };
}

function linkDirectoryOrSkip(t, target, linkPath) {
  try {
    symlinkSync(target, linkPath, DIR_LINK_TYPE);
  } catch (error) {
    t.skip(`directory links unavailable: ${error.code ?? error.message}`);
    return false;
  }
  return true;
}

function assertNoAuditBytesChangedOutside(outsidePath, sentinelName = "sentinel.txt") {
  assert.equal(readFileSync(path.join(outsidePath, sentinelName), "utf8"), "outside bytes\n");
  assert.deepEqual(readdirSync(outsidePath).sort(), [sentinelName]);
  assert.equal(existsSync(path.join(outsidePath, "audit.lock")), false);
  assert.equal(existsSync(path.join(outsidePath, "latest-attempt.json")), false);
  assert.equal(existsSync(path.join(outsidePath, "latest-published-bound.json")), false);
  assert.equal(existsSync(path.join(outsidePath, "attempts")), false);
  assert.equal(existsSync(path.join(outsidePath, "stale-locks")), false);
}

function attemptedRecordInput(attemptId) {
  return {
    schemaVersion: "meta-kim-release-binding-audit-v1",
    attemptId,
    status: "failed",
    promotionEligible: false,
  };
}

test("release package manifest is read in-memory from a bounded npm-style tgz", () => {
  const tgz = minimalTgz({ name: "meta-kim", version: "9.9.9" });
  const parsed = readPackageManifestFromTgz(tgz);
  assert.equal(parsed.manifest.name, "meta-kim");
  assert.equal(parsed.manifest.version, "9.9.9");
  assert.equal(parsed.sha256, sha256(parsed.bytes));
  assert.throws(
    () => readPackageManifestFromTgz(Buffer.from("not gzip")),
    (error) => error.code === "package_tgz_invalid",
  );
});

test("dirty historical verification remains explicitly unbound", () => {
  const gitFacts = {
    peeledCommitSha: "a".repeat(40),
    peeledTreeSha: "b".repeat(40),
  };
  const dirty = readVerificationEvidence(exactReport({
    ...gitFacts,
    tagPackageJsonSha256: "c".repeat(64),
  }, { dirty: true }), gitFacts);
  assert.equal(dirty.bindingStatus, "verification_dirty_candidate");
  assert.equal(dirty.exact, false);
  const unavailable = readVerificationEvidence(null, gitFacts);
  assert.equal(unavailable.bindingStatus, "historical_report_unavailable");
  assert.equal(unavailable.exact, false);
  const wrongManifestReport = JSON.parse(exactReport({
    ...gitFacts,
    tagPackageJsonSha256: "c".repeat(64),
  }).toString("utf8"));
  for (const key of ["invocation", "postProbe", "end"]) {
    wrongManifestReport.releasePreflight.sourceSnapshot[key].packageManifestHash = "e".repeat(64);
  }
  const wrongManifest = readVerificationEvidence(
    Buffer.from(JSON.stringify(wrongManifestReport)),
    { ...gitFacts, tagPackageJsonSha256: "c".repeat(64) },
  );
  assert.equal(wrongManifest.bindingStatus, "verification_package_manifest_mismatch");
  assert.equal(wrongManifest.exact, false);

  const weakPackedProofReport = JSON.parse(exactReport({
    ...gitFacts,
    tagPackageJsonSha256: "c".repeat(64),
  }).toString("utf8"));
  delete weakPackedProofReport.releasePreflight.packedUserProof.currentPackage.modes;
  const weakPackedProof = readVerificationEvidence(
    Buffer.from(JSON.stringify(weakPackedProofReport)),
    { ...gitFacts, tagPackageJsonSha256: "c".repeat(64) },
  );
  assert.equal(weakPackedProof.bindingStatus, "verification_package_candidate_unproven");
  assert.equal(weakPackedProof.exact, false);
});

test("published-bound requires exact clean verification and the uploaded local package", () => {
  const gitFacts = {
    remoteMainRelation: "exact",
    packageName: "meta-kim",
    packageVersion: "9.9.9",
  };
  const githubFacts = {
    draft: false,
    prerelease: false,
    publishedAt: "2026-01-01T00:00:00.000Z",
    asset: { sha256: "a".repeat(64) },
  };
  const verification = { exact: true, verifiedPackageSha256: "a".repeat(64) };
  const localPackage = {
    sha256: "a".repeat(64),
    packageName: "meta-kim",
    packageVersion: "9.9.9",
    packageJsonSha256: "b".repeat(64),
  };
  gitFacts.tagPackageJsonSha256 = "b".repeat(64);
  assert.deepEqual(
    evaluateReleaseBinding({ gitFacts, githubFacts, verification, localPackage }).status,
    "published_bound",
  );
  const missingPackage = evaluateReleaseBinding({
    gitFacts,
    githubFacts,
    verification,
  });
  assert.equal(missingPackage.status, "failed");
  assert.ok(
    missingPackage.failureReasons.includes("local_package_evidence_missing_for_exact_binding"),
  );
  const historical = evaluateReleaseBinding({
    gitFacts,
    githubFacts,
    verification: { exact: false },
  });
  assert.equal(historical.status, "published_artifacts_bound_verification_unbound");
  assert.equal(historical.promotionEligible, false);
  const alteredManifest = evaluateReleaseBinding({
    gitFacts,
    githubFacts,
    verification,
    localPackage: { ...localPackage, packageJsonSha256: "c".repeat(64) },
  });
  assert.equal(alteredManifest.status, "failed");
  assert.ok(alteredManifest.failureReasons.includes("local_package_manifest_mismatch"));
  const alteredPackageBytes = evaluateReleaseBinding({
    gitFacts,
    githubFacts: { ...githubFacts, asset: { sha256: "c".repeat(64) } },
    verification,
    localPackage: { ...localPackage, sha256: "c".repeat(64) },
  });
  assert.equal(alteredPackageBytes.status, "failed");
  assert.ok(
    alteredPackageBytes.failureReasons.includes("verified_package_candidate_mismatch"),
  );
});

test("changed non-manifest package bytes cannot replace the clean verified candidate", () => {
  const manifest = { name: "meta-kim", version: "9.9.9" };
  const verifiedTgz = minimalTgz(manifest, [{ path: "bin/meta-kim.mjs", body: "verified\n" }]);
  const replacedTgz = minimalTgz(manifest, [{ path: "bin/meta-kim.mjs", body: "tampered\n" }]);
  const replacedSha = sha256(replacedTgz);
  const packageJsonSha = readPackageManifestFromTgz(replacedTgz).sha256;
  const result = evaluateReleaseBinding({
    gitFacts: {
      remoteMainRelation: "exact",
      packageName: "meta-kim",
      packageVersion: "9.9.9",
      tagPackageJsonSha256: packageJsonSha,
    },
    githubFacts: {
      draft: false,
      prerelease: false,
      publishedAt: "2026-01-01T00:00:00.000Z",
      asset: { sha256: replacedSha },
    },
    verification: { exact: true, verifiedPackageSha256: sha256(verifiedTgz) },
    localPackage: {
      sha256: replacedSha,
      packageName: "meta-kim",
      packageVersion: "9.9.9",
      packageJsonSha256: packageJsonSha,
    },
  });
  assert.equal(result.status, "failed");
  assert.ok(result.failureReasons.includes("verified_package_candidate_mismatch"));
});

test("attempt journal is immutable, chained, and failure preserves latest published-bound", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-journal-"));
  try {
    const first = writeReleaseBindingAttempt(root, {
      schemaVersion: "meta-kim-release-binding-audit-v1",
      attemptId: "attempt-one",
      status: "published_bound",
      promotionEligible: true,
    });
    const second = writeReleaseBindingAttempt(root, {
      schemaVersion: "meta-kim-release-binding-audit-v1",
      attemptId: "attempt-two",
      status: "failed",
      promotionEligible: false,
    });
    assert.equal(second.record.previousRecordHash, first.record.recordHash);
    assert.equal(
      first.record.recordHash,
      sha256(canonicalJson(Object.fromEntries(
        Object.entries(first.record).filter(([key]) => key !== "recordHash"),
      ))),
    );
    assert.ok(readFileSync(first.recordPath, "utf8").includes("attempt-one"));
    assert.ok(readFileSync(second.recordPath, "utf8").includes("attempt-two"));
    const publishedPointer = JSON.parse(
      readFileSync(path.join(root, "latest-published-bound.json"), "utf8"),
    );
    assert.equal(publishedPointer.attemptId, "attempt-one");
    const latestAttempt = JSON.parse(readFileSync(path.join(root, "latest-attempt.json"), "utf8"));
    assert.equal(latestAttempt.attemptId, "attempt-two");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("journal recovers a dead-owner lock but rejects a live owner and tampered chain head", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-lock-"));
  try {
    writeFileSync(
      path.join(root, "audit.lock"),
      JSON.stringify({ pid: 2_147_483_647, token: "dead", createdAt: "2020-01-01T00:00:00Z" }),
    );
    const recovered = writeReleaseBindingAttempt(root, {
      schemaVersion: "meta-kim-release-binding-audit-v1",
      attemptId: "recovered",
      status: "failed",
      promotionEligible: false,
    });
    assert.equal(recovered.record.attemptId, "recovered");
    assert.equal(readdirSync(path.join(root, "stale-locks")).length, 1);

    writeFileSync(
      path.join(root, "audit.lock"),
      JSON.stringify({ pid: process.pid, token: "live", createdAt: new Date().toISOString() }),
    );
    assert.throws(
      () => writeReleaseBindingAttempt(root, {
        schemaVersion: "meta-kim-release-binding-audit-v1",
        attemptId: "must-not-write",
        status: "failed",
        promotionEligible: false,
      }),
      (error) => error.code === "audit_busy",
    );
    rmSync(path.join(root, "audit.lock"), { force: true });

    const record = JSON.parse(readFileSync(recovered.recordPath, "utf8"));
    record.status = "published_bound";
    writeFileSync(recovered.recordPath, `${JSON.stringify(record, null, 2)}\n`);
    assert.throws(
      () => writeReleaseBindingAttempt(root, {
        schemaVersion: "meta-kim-release-binding-audit-v1",
        attemptId: "after-tamper",
        status: "failed",
        promotionEligible: false,
      }),
      (error) => error.code === "audit_chain_head_invalid",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote annotated-tag identity must match the local tag object and peeled commit", async () => {
  const root = createReleaseRepo();
  try {
    const gitFacts = collectGitReleaseFacts(root, "v9.9.9");
    const tgz = minimalTgz({ name: "meta-kim", version: "9.9.9" });
    const payload = githubPayload(gitFacts, sha256(tgz), tgz.length);
    const fetchImpl = async (url) => {
      let responsePayload = payload;
      if (String(url).includes("/git/ref/tags/")) {
        responsePayload = { object: { type: "tag", sha: "f".repeat(40) } };
      }
      return new Response(JSON.stringify(responsePayload), { status: 200 });
    };
    await assert.rejects(
      () => fetchGitHubReleaseFacts(gitFacts, { fetchImpl }),
      (error) => error.code === "remote_tag_object_mismatch",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("output containment rejects a repository link that resolves outside before writing", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-output-root-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-output-outside-"));
  const link = path.join(root, "linked-output");
  try {
    if (!linkDirectoryOrSkip(t, outside, link)) return;
    const escaped = path.join(link, "audit");
    assert.throws(
      () => requireContainedOutput(root, escaped),
      (error) => error.code === "output_outside_repo",
    );
    assert.equal(
      (() => {
        try {
          readFileSync(path.join(outside, "audit", "latest-attempt.json"));
          return true;
        } catch {
          return false;
        }
      })(),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("release attempt rejects an output directory link before external bytes change", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-output-link-root-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-output-link-outside-"));
  const outputLink = path.join(root, "audit-output");
  try {
    writeFileSync(path.join(outside, "sentinel.txt"), "outside bytes\n");
    if (!linkDirectoryOrSkip(t, outside, outputLink)) return;
    assert.throws(
      () => writeReleaseBindingAttempt(outputLink, attemptedRecordInput("must-not-write-output")),
      (error) => error.code === "output_outside_repo",
    );
    assertNoAuditBytesChangedOutside(outside);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("release attempt rejects a linked attempts directory before lock or record writes", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-attempts-root-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-attempts-outside-"));
  try {
    writeFileSync(path.join(outside, "sentinel.txt"), "outside bytes\n");
    if (!linkDirectoryOrSkip(t, outside, path.join(root, "attempts"))) return;
    assert.throws(
      () => writeReleaseBindingAttempt(root, attemptedRecordInput("must-not-write-attempts")),
      (error) => error.code === "output_outside_repo",
    );
    assertNoAuditBytesChangedOutside(outside);
    assert.equal(existsSync(path.join(root, "audit.lock")), false);
    assert.equal(existsSync(path.join(root, "latest-attempt.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("release attempt rejects a linked stale-locks directory before stale lock recovery writes outside", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-stale-root-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-stale-outside-"));
  try {
    writeFileSync(path.join(outside, "sentinel.txt"), "outside bytes\n");
    mkdirSync(path.join(root, "attempts"));
    if (!linkDirectoryOrSkip(t, outside, path.join(root, "stale-locks"))) return;
    writeFileSync(
      path.join(root, "audit.lock"),
      JSON.stringify({ pid: 2_147_483_647, token: "dead", createdAt: "2020-01-01T00:00:00Z" }),
    );
    assert.throws(
      () => writeReleaseBindingAttempt(root, attemptedRecordInput("must-not-write-stale-lock")),
      (error) => error.code === "output_outside_repo",
    );
    assertNoAuditBytesChangedOutside(outside);
    assert.equal(existsSync(path.join(root, "audit.lock")), true);
    assert.equal(existsSync(path.join(root, "latest-attempt.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("end-to-end audit binds annotated tag, clean report, GitHub asset digest, and local tgz", async () => {
  const root = createReleaseRepo();
  const outputDir = path.join(root, ".meta-kim", "release-binding-audit");
  try {
    const gitFacts = collectGitReleaseFacts(root, "v9.9.9");
    assert.match(gitFacts.tagObjectSha, /^[a-f0-9]{40}$/u);
    assert.equal(gitFacts.remoteMainRelation, "exact");
    const tgz = minimalTgz({ name: "meta-kim", version: "9.9.9" });
    const tgzPath = path.join(root, "meta-kim-9.9.9.tgz");
    const reportPath = path.join(root, "verification-report.json");
    writeFileSync(tgzPath, tgz);
    writeFileSync(reportPath, exactReport(gitFacts, { packageSha256: sha256(tgz) }));
    const payload = githubPayload(gitFacts, sha256(tgz), tgz.length);
    const fetchImpl = async (url) => {
      let responsePayload = payload;
      if (String(url).includes("/git/ref/tags/")) {
        responsePayload = { object: { type: "tag", sha: gitFacts.tagObjectSha } };
      } else if (String(url).includes("/git/tags/")) {
        responsePayload = { object: { type: "commit", sha: gitFacts.peeledCommitSha } };
      }
      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const first = await runReleaseBindingAudit({
      repoRoot: root,
      tagName: "v9.9.9",
      verificationReportPath: reportPath,
      localPackagePath: tgzPath,
      outputDir,
      fetchImpl,
      now: new Date("2026-01-01T02:00:00.000Z"),
    });
    assert.equal(first.record.status, "published_bound");
    assert.equal(first.record.promotionEligible, true);
    assert.equal(first.record.evidence.verification.bindingStatus, "exact_commit_tree");

    const second = await runReleaseBindingAudit({
      repoRoot: root,
      tagName: "v9.9.9",
      verificationReportPath: reportPath,
      localPackagePath: tgzPath,
      outputDir,
      fetchImpl,
      now: new Date("2026-01-01T02:01:00.000Z"),
    });
    assert.equal(second.record.status, "published_bound");
    assert.equal(second.record.evidenceFingerprint, first.record.evidenceFingerprint);
    assert.equal(second.record.previousRecordHash, first.record.recordHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
