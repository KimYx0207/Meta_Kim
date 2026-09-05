import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  executeSafeManagedFileTransaction,
  sha256Buffer,
  sha256ManagedFile,
  validateManagedManifest,
  withSafeManagedFileLock,
} from "../../scripts/safe-managed-file-operations.mjs";

const transactionModuleUrl = new URL("../../scripts/safe-managed-file-operations.mjs", import.meta.url).href;

function childTransactionSource(options) {
  return `
    import { executeSafeManagedFileTransaction } from ${JSON.stringify(transactionModuleUrl)};
    const result = executeSafeManagedFileTransaction(${JSON.stringify(options)});
    process.stdout.write(JSON.stringify(result));
  `;
}

function runTransactionChild(options, env = {}) {
  return spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", childTransactionSource(options)],
    { encoding: "utf8", env: { ...process.env, ...env } },
  );
}

function parseSuccessfulChildResult(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(result.stdout.trim(), "child transaction should emit a JSON result");
  return JSON.parse(result.stdout);
}

function collectChildResult(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

async function waitForPath(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${filePath}`);
}

function tempRoot(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("mixed identical adoption plus unmanaged conflict performs zero writes", () => {
  const root = tempRoot("meta-kim-managed-conflict-");
  try {
    mkdirSync(path.join(root, "runtime"));
    const adopt = path.join(root, "runtime", "adopt.txt");
    const conflict = path.join(root, "runtime", "conflict.txt");
    writeFileSync(adopt, "canonical\n");
    writeFileSync(conflict, "user\n");
    const adoptMtime = statSync(adopt).mtimeMs;
    const result = executeSafeManagedFileTransaction({
      trustedRoot: root,
      backupRoot: path.join(root, ".meta-kim", "backups"),
      operations: [
        { kind: "write", relPath: "runtime/adopt.txt", content: "canonical\n", authorizedAdoptIdentical: true },
        { kind: "write", relPath: "runtime/conflict.txt", content: "canonical\n", authorizedAdoptIdentical: true },
        { kind: "write", relPath: ".meta-kim/manifest.json", content: "manifest\n" },
      ],
    });
    assert.equal(result.ok, false);
    assert.equal(readFileSync(adopt, "utf8"), "canonical\n");
    assert.equal(statSync(adopt).mtimeMs, adoptMtime);
    assert.equal(readFileSync(conflict, "utf8"), "user\n");
    assert.equal(existsSync(path.join(root, ".meta-kim")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("injected manifest commit failure rolls back earlier file commits", () => {
  const root = tempRoot("meta-kim-managed-rollback-");
  try {
    mkdirSync(path.join(root, "runtime"));
    const target = path.join(root, "runtime", "hook.mjs");
    writeFileSync(target, "old\n");
    const result = executeSafeManagedFileTransaction({
      trustedRoot: root,
      backupRoot: path.join(root, ".meta-kim", "backups"),
      injectFailureAtCommit: 2,
      operations: [
        { kind: "write", relPath: "runtime/hook.mjs", content: "new\n", expectedOldHash: sha256ManagedFile(target) },
        { kind: "write", relPath: ".meta-kim/manifest.json", content: "manifest\n" },
      ],
    });
    assert.equal(result.ok, false);
    assert.equal(readFileSync(target, "utf8"), "old\n");
    assert.equal(existsSync(path.join(root, ".meta-kim", "manifest.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a target changed after precommit is restored and retained for recovery", () => {
  const root = tempRoot("meta-kim-managed-precommit-race-");
  try {
    const target = path.join(root, "hook.mjs");
    const original = Buffer.from("managed old\n", "utf8");
    const concurrent = Buffer.from("USER CONCURRENT EDIT\n", "utf8");
    writeFileSync(target, original);
    const result = executeSafeManagedFileTransaction({
      trustedRoot: root,
      backupRoot: path.join(root, ".meta-kim", "backups"),
      operations: [{
        kind: "write",
        relPath: "hook.mjs",
        content: "managed new\n",
        expectedOldHash: sha256Buffer(original),
      }],
      injectBeforeCommitItem: () => writeFileSync(target, concurrent),
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "recovery_required");
    assert.match(result.originalFailure, /commit_rollback_hash_drift:hook\.mjs/u);
    assert.deepEqual(readFileSync(target), concurrent);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a transient Windows lock on the published target is retried instead of rolling the transaction back", () => {
  const root = tempRoot("meta-kim-managed-transient-publish-");
  try {
    const target = path.join(root, "hook.mjs");
    const original = Buffer.from("managed old\n", "utf8");
    writeFileSync(target, original);

    // Windows lets a scanner or indexer hold a handle on the managed file for a few
    // milliseconds, and the rename that publishes the staged content is where that
    // shows up as EPERM. Fail that one rename once and let every later attempt
    // through, so nothing but a retry can carry this transaction to a commit. Only
    // the platform and the failing primitive are supplied here; the attempt count
    // and the backoff are whatever a real install would use.
    let publishAttempts = 0;
    const result = executeSafeManagedFileTransaction({
      trustedRoot: root,
      backupRoot: path.join(root, ".meta-kim", "backups"),
      operations: [{
        kind: "write",
        relPath: "hook.mjs",
        content: "managed new\n",
        expectedOldHash: sha256Buffer(original),
      }],
      injectRenameOptions: {
        platform: "win32",
        rename(fromPath, toPath) {
          if (!fromPath.endsWith(".stage")) {
            renameSync(fromPath, toPath);
            return;
          }
          publishAttempts += 1;
          if (publishAttempts === 1) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
          renameSync(fromPath, toPath);
        },
      },
    });

    assert.equal(publishAttempts, 2, "the injected lock must reach the publish rename and be retried exactly once");
    assert.equal(result.ok, true);
    assert.equal(result.status, "committed");
    assert.equal(readFileSync(target, "utf8"), "managed new\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a transient Windows lock is retried when the managed file is being created rather than replaced", () => {
  const root = tempRoot("meta-kim-managed-transient-create-");
  try {
    const target = path.join(root, "hook.mjs");

    // A first install creates the file, so there is no prior hash and none of the
    // rollback renames run: the staged publish is the only rename in the commit.
    // Wiring the retry into the replace branch alone would leave exactly this path
    // — the common one on a fresh machine — failing on the first scanner handle.
    let publishAttempts = 0;
    const result = executeSafeManagedFileTransaction({
      trustedRoot: root,
      backupRoot: path.join(root, ".meta-kim", "backups"),
      operations: [{ kind: "write", relPath: "hook.mjs", content: "managed new\n" }],
      injectRenameOptions: {
        platform: "win32",
        initialDelayMs: 0,
        rename(fromPath, toPath) {
          publishAttempts += 1;
          if (publishAttempts === 1) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
          renameSync(fromPath, toPath);
        },
      },
    });

    assert.equal(publishAttempts, 2, "creating a managed file must retry the publish rename too");
    assert.equal(result.ok, true);
    assert.equal(result.status, "committed");
    assert.equal(readFileSync(target, "utf8"), "managed new\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rename failure outside the Windows lock set still rolls the transaction back", () => {
  const root = tempRoot("meta-kim-managed-persistent-rename-");
  try {
    const target = path.join(root, "hook.mjs");
    const original = Buffer.from("managed old\n", "utf8");
    writeFileSync(target, original);

    // Retrying a code that is not a transient directory lock would turn a real disk
    // failure into a slow one, so the boundary matters as much as the retry: a full
    // disk has to fail on its first attempt and leave the managed file untouched.
    // The sleep is recorded rather than thrown from, because throwing out of the
    // backoff would look exactly like the rename itself failing and would let a
    // widened transient set pass this test.
    let attempts = 0;
    const waits = [];
    const result = executeSafeManagedFileTransaction({
      trustedRoot: root,
      backupRoot: path.join(root, ".meta-kim", "backups"),
      operations: [{
        kind: "write",
        relPath: "hook.mjs",
        content: "managed new\n",
        expectedOldHash: sha256Buffer(original),
      }],
      injectRenameOptions: {
        platform: "win32",
        initialDelayMs: 0,
        wait: (delayMs) => waits.push(delayMs),
        rename() {
          attempts += 1;
          throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
        },
      },
    });

    assert.equal(attempts, 1, "a code outside the transient set must be raised on its first attempt");
    assert.deepEqual(waits, [], "a full disk must not be waited on and retried");
    assert.equal(result.ok, false);
    assert.equal(result.status, "rolled_back");
    // The caller has to learn the disk is full. Swallowing the rename failure would
    // still roll back, but only via a later internal drift check, so the reported
    // reason would send an operator after the wrong fault.
    assert.equal(result.reason, "ENOSPC");
    assert.equal(readFileSync(target, "utf8"), "managed old\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("idempotent identical adoption creates no backup and does not churn mtime", () => {
  const root = tempRoot("meta-kim-managed-idempotent-");
  try {
    const target = path.join(root, "hook.mjs");
    writeFileSync(target, "same\n");
    const before = statSync(target).mtimeMs;
    const result = executeSafeManagedFileTransaction({
      trustedRoot: root,
      backupRoot: path.join(root, ".meta-kim", "backups"),
      operations: [{ kind: "write", relPath: "hook.mjs", content: "same\n", authorizedAdoptIdentical: true }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.committed[0].action, "adopt");
    assert.equal(statSync(target).mtimeMs, before);
    assert.equal(existsSync(path.join(root, ".meta-kim")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unmanaged identical content requires explicit adoption authorization", () => {
  const root = tempRoot("meta-kim-managed-adopt-denied-");
  try {
    const target = path.join(root, "hook.mjs");
    writeFileSync(target, "same\n");
    const before = statSync(target).mtimeMs;
    const result = executeSafeManagedFileTransaction({
      trustedRoot: root,
      backupRoot: path.join(root, ".meta-kim", "backups"),
      operations: [{ kind: "write", relPath: "hook.mjs", content: "same\n" }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "unmanaged_existing_conflict");
    assert.equal(result.committed, undefined);
    assert.equal(readFileSync(target, "utf8"), "same\n");
    assert.equal(statSync(target).mtimeMs, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed identical content is a true no-op with no backup or mtime churn", () => {
  const root = tempRoot("meta-kim-managed-noop-");
  try {
    const target = path.join(root, "hook.mjs");
    writeFileSync(target, "same\n");
    const before = statSync(target).mtimeMs;
    const oldHash = sha256ManagedFile(target);
    const result = executeSafeManagedFileTransaction({
      trustedRoot: root,
      backupRoot: path.join(root, ".meta-kim", "backups"),
      operations: [{ kind: "write", relPath: "hook.mjs", content: "same\n", expectedOldHash: oldHash }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "noop");
    assert.equal(result.committed[0].action, "noop");
    assert.equal(statSync(target).mtimeMs, before);
    assert.equal(existsSync(path.join(root, ".meta-kim")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a concurrent process receives locked and performs zero target mutation", async () => {
  const root = tempRoot("meta-kim-managed-lock-");
  let firstChild = null;
  let firstCompleted = null;
  try {
    const target = path.join(root, "hook.mjs");
    writeFileSync(target, "old\n");
    const oldHash = sha256ManagedFile(target);
    const firstOptions = {
      trustedRoot: root,
      backupRoot: path.join(root, ".meta-kim", "backups"),
      lockKey: "concurrent-test",
      operations: [{ kind: "write", relPath: "hook.mjs", content: "first\n", expectedOldHash: oldHash }],
    };
    firstChild = spawn(
      process.execPath,
      ["--input-type=module", "--eval", childTransactionSource(firstOptions)],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, META_KIM_TEST_PAUSE_MANAGED_AFTER_LOCK_MS: "4000" },
      },
    );
    firstCompleted = collectChildResult(firstChild);
    await waitForPath(path.join(root, ".meta-kim", "transactions", "concurrent-test.lock.json"));

    const second = runTransactionChild({
      ...firstOptions,
      operations: [{ kind: "write", relPath: "hook.mjs", content: "second\n", expectedOldHash: oldHash }],
    });
    const secondResult = parseSuccessfulChildResult(second);
    assert.equal(secondResult.ok, false);
    assert.equal(secondResult.status, "locked");
    assert.equal(readFileSync(target, "utf8"), "old\n");

    const first = await firstCompleted;
    firstChild = null;
    assert.equal(parseSuccessfulChildResult(first).status, "committed");
    assert.equal(readFileSync(target, "utf8"), "first\n");
  } finally {
    if (firstChild?.exitCode === null) {
      firstChild.kill();
      if (firstCompleted) await firstCompleted;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("withSafeManagedFileLock rejects a second concurrent session", async () => {
  const root = tempRoot("meta-kim-managed-helper-lock-");
  let releaseFirst;
  try {
    const firstMayFinish = new Promise((resolve) => { releaseFirst = resolve; });
    const first = withSafeManagedFileLock(
      { trustedRoot: root, lockKey: "helper-lock" },
      async () => {
        await firstMayFinish;
        return "first-complete";
      },
    );
    await waitForPath(path.join(root, ".meta-kim", "transactions", "helper-lock.lock.json"));

    const second = await withSafeManagedFileLock(
      { trustedRoot: root, lockKey: "helper-lock" },
      async () => "must-not-run",
    );
    assert.equal(second.ok, false);
    assert.equal(second.status, "locked");

    releaseFirst();
    const completed = await first;
    assert.equal(completed.ok, true);
    assert.equal(completed.value, "first-complete");
  } finally {
    releaseFirst?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a valid-looking journal without its receipt cannot delete a target", () => {
  const root = tempRoot("meta-kim-managed-forged-journal-");
  try {
    const target = path.join(root, "victim.txt");
    const controlDir = path.join(root, ".meta-kim", "transactions");
    mkdirSync(controlDir, { recursive: true });
    writeFileSync(target, "user data\n");
    const relPath = "victim.txt";
    const nonce = "forged";
    const token = sha256Buffer(Buffer.from(relPath)).slice(0, 12);
    const journal = {
      schemaVersion: "meta-kim-managed-file-journal-v1",
      phase: "prepared",
      nonce,
      lockKey: "managed-files",
      trustedRoot: path.resolve(root),
      transactionLabel: "managed-files",
      createdAt: new Date().toISOString(),
      backupBaseRel: `.meta-kim/backups/managed-files-${nonce}`,
      entries: [{
        relPath,
        kind: "remove",
        phase: "content",
        oldHash: sha256ManagedFile(target),
        nextHash: null,
        oldMode: process.platform === "win32" ? null : statSync(target).mode & 0o7777,
        nextMode: null,
        stageRelPath: `.${nonce}-${token}.stage`,
        rollbackRelPath: `.${nonce}-${token}.rollback`,
        backupRelPath: `.meta-kim/backups/managed-files-${nonce}/${relPath}`,
      }],
    };
    const journalPath = path.join(controlDir, "managed-files.journal.json");
    writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

    const result = executeSafeManagedFileTransaction({
      trustedRoot: root,
      backupRoot: path.join(root, ".meta-kim", "backups"),
      operations: [],
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, "recovery_required");
    assert.equal(result.reason, "missing_or_invalid_transaction_receipt");
    assert.equal(readFileSync(target, "utf8"), "user data\n");
    assert.equal(existsSync(journalPath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("crashes after prepared, rename, and manifest phases recover deterministically on retry", () => {
  for (const checkpoint of ["after_prepared_journal", "after_first_rollback_rename", "after_manifest_commit"]) {
    const root = tempRoot(`meta-kim-managed-crash-${checkpoint}-`);
    try {
      mkdirSync(path.join(root, ".meta-kim"));
      const target = path.join(root, "hook.mjs");
      const manifest = path.join(root, ".meta-kim", "manifest.json");
      writeFileSync(target, "old hook\n");
      writeFileSync(manifest, "old manifest\n");
      const options = {
        trustedRoot: root,
        backupRoot: path.join(root, ".meta-kim", "backups"),
        operations: [
          { kind: "write", relPath: "hook.mjs", content: "new hook\n", expectedOldHash: sha256ManagedFile(target), phase: "content" },
          { kind: "write", relPath: ".meta-kim/manifest.json", content: "new manifest\n", expectedOldHash: sha256ManagedFile(manifest), phase: "manifest" },
        ],
      };
      const crashed = runTransactionChild(options, { META_KIM_TEST_CRASH_MANAGED_AT: checkpoint });
      assert.equal(crashed.status, 91, `${checkpoint}: ${crashed.stderr}`);
      assert.equal(existsSync(path.join(root, ".meta-kim", "transactions", "managed-files.journal.json")), true);

      const retried = parseSuccessfulChildResult(runTransactionChild(options));
      assert.equal(retried.ok, true, checkpoint);
      assert.equal(retried.status, "committed", checkpoint);
      assert.equal(retried.recovery, "recovered_rolled_back", checkpoint);
      assert.equal(readFileSync(target, "utf8"), "new hook\n", checkpoint);
      assert.equal(readFileSync(manifest, "utf8"), "new manifest\n", checkpoint);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a crash during recovery cleanup leaves only a safe orphan receipt", () => {
  const root = tempRoot("meta-kim-managed-recovery-cleanup-");
  try {
    mkdirSync(path.join(root, ".meta-kim"));
    const target = path.join(root, "hook.mjs");
    const manifest = path.join(root, ".meta-kim", "manifest.json");
    writeFileSync(target, "old hook\n");
    writeFileSync(manifest, "old manifest\n");
    const options = {
      trustedRoot: root,
      backupRoot: path.join(root, ".meta-kim", "backups"),
      operations: [
        { kind: "write", relPath: "hook.mjs", content: "new hook\n", expectedOldHash: sha256ManagedFile(target), phase: "content" },
        { kind: "write", relPath: ".meta-kim/manifest.json", content: "new manifest\n", expectedOldHash: sha256ManagedFile(manifest), phase: "manifest" },
      ],
    };
    const controlDir = path.join(root, ".meta-kim", "transactions");
    const journalPath = path.join(controlDir, "managed-files.journal.json");
    const receiptPath = path.join(controlDir, "managed-files.receipt.json");

    const committedCrash = runTransactionChild(options, {
      META_KIM_TEST_CRASH_MANAGED_AT: "after_verified_journal",
    });
    assert.equal(committedCrash.status, 91, committedCrash.stderr);
    assert.equal(existsSync(journalPath), true);
    assert.equal(existsSync(receiptPath), true);

    const cleanupCrash = runTransactionChild({ ...options, operations: [] }, {
      META_KIM_TEST_CRASH_MANAGED_AT: "after_recovery_journal_cleanup",
    });
    assert.equal(cleanupCrash.status, 91, cleanupCrash.stderr);
    assert.equal(existsSync(journalPath), false);
    assert.equal(existsSync(receiptPath), true);

    const retried = parseSuccessfulChildResult(
      runTransactionChild({ ...options, operations: [] }),
    );
    assert.equal(retried.ok, true);
    assert.equal(retried.status, "noop");
    assert.equal(existsSync(receiptPath), false);
    assert.equal(readFileSync(target, "utf8"), "new hook\n");
    assert.equal(readFileSync(manifest, "utf8"), "new manifest\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("input order cannot move the manifest ahead of content commits", () => {
  const root = tempRoot("meta-kim-managed-phase-order-");
  try {
    mkdirSync(path.join(root, ".meta-kim"));
    const target = path.join(root, "hook.mjs");
    const manifest = path.join(root, ".meta-kim", "manifest.json");
    writeFileSync(target, "old hook\n");
    writeFileSync(manifest, "old manifest\n");
    const options = {
      trustedRoot: root,
      backupRoot: path.join(root, ".meta-kim", "backups"),
      operations: [
        { kind: "write", relPath: ".meta-kim/manifest.json", content: "new manifest\n", expectedOldHash: sha256ManagedFile(manifest), phase: "manifest" },
        { kind: "write", relPath: "hook.mjs", content: "new hook\n", expectedOldHash: sha256ManagedFile(target), phase: "content" },
      ],
    };
    const crashed = runTransactionChild(options, { META_KIM_TEST_CRASH_MANAGED_AT: "after_first_target_commit" });
    assert.equal(crashed.status, 91, crashed.stderr);
    assert.equal(readFileSync(target, "utf8"), "new hook\n");
    assert.equal(readFileSync(manifest, "utf8"), "old manifest\n");

    const retried = parseSuccessfulChildResult(runTransactionChild(options));
    assert.equal(retried.recovery, "recovered_rolled_back");
    assert.equal(readFileSync(target, "utf8"), "new hook\n");
    assert.equal(readFileSync(manifest, "utf8"), "new manifest\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing POSIX permissions survive staging, journaling, and crash recovery", { skip: process.platform === "win32" }, () => {
  const root = tempRoot("meta-kim-managed-mode-");
  try {
    const target = path.join(root, "hook.mjs");
    writeFileSync(target, "old\n");
    chmodSync(target, 0o751);
    const options = {
      trustedRoot: root,
      backupRoot: path.join(root, ".meta-kim", "backups"),
      operations: [{ kind: "write", relPath: "hook.mjs", content: "new\n", expectedOldHash: sha256ManagedFile(target) }],
    };
    const crashed = runTransactionChild(options, { META_KIM_TEST_CRASH_MANAGED_AT: "after_first_target_commit" });
    assert.equal(crashed.status, 91, crashed.stderr);
    assert.equal(statSync(target).mode & 0o7777, 0o751);
    const journal = JSON.parse(readFileSync(path.join(root, ".meta-kim", "transactions", "managed-files.journal.json"), "utf8"));
    assert.equal(journal.entries[0].oldMode, 0o751);
    assert.equal(journal.entries[0].nextMode, 0o751);

    const retried = parseSuccessfulChildResult(runTransactionChild(options));
    assert.equal(retried.recovery, "recovered_rolled_back");
    assert.equal(readFileSync(target, "utf8"), "new\n");
    assert.equal(statSync(target).mode & 0o7777, 0o751);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("remove with hash drift and a runtime-root junction both fail closed", () => {
  const root = tempRoot("meta-kim-managed-drift-");
  const outside = tempRoot("meta-kim-managed-outside-");
  try {
    const drift = path.join(root, "drift.txt");
    writeFileSync(drift, "user changed\n");
    const driftResult = executeSafeManagedFileTransaction({
      trustedRoot: root,
      backupRoot: path.join(root, ".meta-kim", "backups"),
      operations: [{ kind: "remove", relPath: "drift.txt", expectedOldHash: sha256Buffer(Buffer.from("old\n")) }],
    });
    assert.equal(driftResult.ok, false);
    assert.equal(readFileSync(drift, "utf8"), "user changed\n");

    mkdirSync(path.join(root, "runtime"));
    writeFileSync(path.join(outside, "victim.txt"), "outside\n");
    symlinkSync(outside, path.join(root, "runtime", "hooks"), process.platform === "win32" ? "junction" : "dir");
    const linkResult = executeSafeManagedFileTransaction({
      trustedRoot: root,
      backupRoot: path.join(root, ".meta-kim", "backups"),
      operations: [{ kind: "write", relPath: "runtime/hooks/victim.txt", content: "new\n", expectedOldHash: sha256ManagedFile(path.join(outside, "victim.txt")) }],
    });
    assert.equal(linkResult.ok, false);
    assert.equal(readFileSync(path.join(outside, "victim.txt"), "utf8"), "outside\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("managed manifest validation rejects empty ownership evidence", () => {
  assert.equal(
    validateManagedManifest({ schemaVersion: "v1", files: [] }, { schemaVersion: "v1" }),
    null,
  );
});
