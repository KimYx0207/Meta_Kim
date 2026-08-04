import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  canonicalJson,
  sha256,
} from "../../scripts/audit-release-binding.mjs";
import { recordReleasePlanningClosure } from "../../scripts/record-release-planning-closure.mjs";

const ISSUE = "P-128";
const VERSION = "2.9.9";
const TAG = `v${VERSION}`;
const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);
const TAG_OBJECT = "d".repeat(40);
const ATTEMPT = "20260727T140000000Z-11111111-2222-4333-8444-555555555555";
const PRD = "docs/ai-native-capability-gap-mvp-prd.zh-CN.md";

function auditRecord(overrides = {}) {
  const base = {
    schemaVersion: "meta-kim-release-binding-audit-v1",
    attemptId: ATTEMPT,
    createdAt: "2026-07-27T14:00:00.000Z",
    releaseVersion: VERSION,
    status: "published_bound",
    promotionEligible: true,
    result: {
      status: "published_bound",
      promotionEligible: true,
      artifactsBound: true,
      verificationBound: true,
      failureReasons: [],
    },
    evidence: {
      git: {
        tagName: TAG,
        tagObjectSha: TAG_OBJECT,
        peeledCommitSha: COMMIT,
        peeledTreeSha: TREE,
        packageVersion: VERSION,
        remoteMainSha: COMMIT,
        remoteMainRelation: "exact",
      },
      githubRelease: {
        url: `https://github.com/example/meta-kim/releases/tag/${TAG}`,
        draft: false,
        prerelease: false,
      },
      packageAsset: { sha256: "c".repeat(64) },
      verification: { sha256: "e".repeat(64), exact: true },
    },
    previousRecordHash: null,
    error: null,
    ...overrides,
  };
  return { ...base, recordHash: sha256(canonicalJson(base)) };
}

function fixture({
  activeIssue = ISSUE,
  ignored = true,
  dirty = false,
  globalOk = true,
  tagType = "tag",
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "meta-kim-release-close-"));
  const packageRoot = path.join(root, "packed-meta-kim");
  mkdirSync(path.join(root, "docs"), { recursive: true });
  mkdirSync(path.join(packageRoot, "scripts"), { recursive: true });
  writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: VERSION }), "utf8");
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: VERSION }), "utf8");
  writeFileSync(
    path.join(root, PRD),
    [
      "# private PRD",
      "<!-- CURRENT_QUEUE_START -->",
      "| 队列角色 | ID | 当前状态 | 发布语义 |",
      "|---|---|---|---|",
      `| ACTIVE | ${activeIssue} | 进行中 | 本地私有 |`,
      "| NEXT | P-129 | 待处理 | 未开始 |",
      "<!-- CURRENT_QUEUE_END -->",
      "",
    ].join("\n"),
    "utf8",
  );
  for (const file of ["task_plan.md", "findings.md", "progress.md"]) {
    writeFileSync(path.join(root, file), `# existing ${file}\n`, "utf8");
  }
  const auditDir = path.join(root, ".meta-kim", "state", "default", "release-binding-audit");
  const attemptsDir = path.join(auditDir, "attempts");
  mkdirSync(attemptsDir, { recursive: true });
  const record = auditRecord();
  writeFileSync(path.join(attemptsDir, `${ATTEMPT}.json`), JSON.stringify(record, null, 2), "utf8");
  const pointer = {
    schemaVersion: "meta-kim-release-binding-pointer-v1",
    attemptId: ATTEMPT,
    recordHash: record.recordHash,
    status: "published_bound",
    record: `attempts/${ATTEMPT}.json`,
  };
  writeFileSync(
    path.join(auditDir, "latest-published-bound.json"),
    JSON.stringify(pointer, null, 2),
    "utf8",
  );
  writeFileSync(
    path.join(auditDir, "latest-attempt.json"),
    JSON.stringify(pointer, null, 2),
    "utf8",
  );
  const calls = [];
  const runCommand = (command, args, options = {}) => {
    calls.push({ command, args: [...args], options });
    if (command === "git" && args[0] === "check-ignore") {
      return { status: ignored ? 0 : 1, stdout: "", stderr: "" };
    }
    if (command === "git" && args[0] === "status") {
      return { status: 0, stdout: dirty ? " M package.json\n" : "", stderr: "" };
    }
    if (command === "git" && args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { status: 0, stdout: `${root}\n`, stderr: "" };
    }
    if (command === "git" && args[0] === "rev-parse") {
      return {
        status: 0,
        stdout: `${args[1] === `refs/tags/${TAG}` ? TAG_OBJECT : COMMIT}\n`,
        stderr: "",
      };
    }
    if (command === "git" && args[0] === "cat-file") {
      return { status: 0, stdout: `${tagType}\n`, stderr: "" };
    }
    if (command === process.execPath) {
      return {
        status: globalOk ? 0 : 1,
        stdout: globalOk ? "Global Meta-Theory check passed\n" : "",
        stderr: globalOk ? "" : "Codex projection stale\n",
      };
    }
    return { status: 1, stdout: "", stderr: "unexpected command" };
  };
  return {
    root,
    packageRoot,
    runCommand,
    calls,
    auditPath: path.join(attemptsDir, `${ATTEMPT}.json`),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runFx(fx, overrides = {}) {
  return recordReleasePlanningClosure({
    repoRoot: fx.root,
    packageRoot: fx.packageRoot,
    issueId: ISSUE,
    prdPath: PRD,
    runCommand: fx.runCommand,
    verifyExactRelease: async () => ({ status: "published_bound" }),
    now: () => new Date("2026-07-27T14:05:00.000Z"),
    ...overrides,
  });
}

test("release close validates exact release evidence and appends one local-only closure projection", async () => {
  const fx = fixture();
  try {
    const result = await runFx(fx);
    assert.equal(result.record.version, VERSION);
    assert.equal(result.record.issueId, ISSUE);
    assert.equal(result.reusedRecord, false);
    for (const file of ["task_plan.md", "findings.md", "progress.md"]) {
      const text = readFileSync(path.join(fx.root, file), "utf8");
      assert.match(text, /META_KIM_RELEASE_CLOSURE:P-128-v2\.9\.9-/u);
      assert.match(text, /唯一队列/u);
      assert.match(text, /不是第二份任务队列/u);
      assert.equal(result.projectionResults[file], "appended");
    }
    assert.equal(
      existsSync(path.join(
        fx.root,
        ".meta-kim/state/default/planning-closures",
        `${ISSUE}-${TAG}-${ATTEMPT}.json`,
      )),
      true,
    );
    assert.equal(
      fx.calls.some(({ command, args }) =>
        command === process.execPath &&
        args.includes("--targets") &&
        args.includes("claude,codex") &&
        args.includes("--with-global-hooks")),
      true,
    );
  } finally {
    fx.cleanup();
  }
});

test("release close is idempotent and does not duplicate projections", async () => {
  const fx = fixture();
  try {
    await runFx(fx);
    const second = await runFx(fx);
    assert.equal(second.reusedRecord, true);
    for (const file of ["task_plan.md", "findings.md", "progress.md"]) {
      const text = readFileSync(path.join(fx.root, file), "utf8");
      assert.equal((text.match(/META_KIM_RELEASE_CLOSURE:[^:]+:START/gu) || []).length, 1);
      assert.equal(second.projectionResults[file], "already_current");
    }
  } finally {
    fx.cleanup();
  }
});

test("release close resumes after a crash between planning-file projections", async () => {
  const fx = fixture();
  try {
    let writes = 0;
    await assert.rejects(
      runFx(fx, {
        afterProjectionWrite: () => {
          writes += 1;
          if (writes === 1) throw new Error("simulated crash");
        },
      }),
      /simulated crash/u,
    );
    const recordPath = path.join(
      fx.root,
      ".meta-kim/state/default/planning-closures",
      `${ISSUE}-${TAG}-${ATTEMPT}.json`,
    );
    assert.equal(existsSync(recordPath), false, "closure record must not precede all projections");
    const resumed = await runFx(fx);
    assert.equal(resumed.projectionResults["task_plan.md"], "already_current");
    assert.equal(resumed.projectionResults["findings.md"], "appended");
    assert.equal(existsSync(recordPath), true);
  } finally {
    fx.cleanup();
  }
});

test("release close resumes after all projections but before immutable record publication", async () => {
  const fx = fixture();
  try {
    await assert.rejects(
      runFx(fx, { beforeRecordPublish: () => { throw new Error("publish crash"); } }),
      /publish crash/u,
    );
    const recordPath = path.join(
      fx.root,
      ".meta-kim/state/default/planning-closures",
      `${ISSUE}-${TAG}-${ATTEMPT}.json`,
    );
    assert.equal(existsSync(recordPath), false);
    const resumed = await runFx(fx);
    assert.equal(resumed.reusedRecord, false);
    assert.equal(existsSync(recordPath), true);
    for (const file of ["task_plan.md", "findings.md", "progress.md"]) {
      assert.equal(resumed.projectionResults[file], "already_current");
    }
  } finally {
    fx.cleanup();
  }
});

test("release close rejects a public PRD and a mismatched ACTIVE issue", async () => {
  const publicFx = fixture({ ignored: false });
  try {
    await assert.rejects(runFx(publicFx), (error) => error.code === "prd_not_private");
  } finally {
    publicFx.cleanup();
  }
  const mismatchFx = fixture({ activeIssue: "P-127" });
  try {
    await assert.rejects(runFx(mismatchFx), (error) => error.code === "prd_issue_mismatch");
  } finally {
    mismatchFx.cleanup();
  }
});

test("release close rejects altered audit evidence and dirty tracked source", async () => {
  const auditFx = fixture();
  try {
    const record = JSON.parse(readFileSync(auditFx.auditPath, "utf8"));
    record.evidence.githubRelease.url = "https://example.invalid/substituted";
    writeFileSync(auditFx.auditPath, JSON.stringify(record, null, 2), "utf8");
    await assert.rejects(runFx(auditFx), (error) => error.code === "release_audit_invalid");
  } finally {
    auditFx.cleanup();
  }
  const dirtyFx = fixture({ dirty: true });
  try {
    await assert.rejects(runFx(dirtyFx), (error) => error.code === "tracked_worktree_dirty");
  } finally {
    dirtyFx.cleanup();
  }
});

test("release close fails before projection when the Claude/Codex global check fails", async () => {
  const fx = fixture({ globalOk: false });
  try {
    await assert.rejects(runFx(fx), (error) => error.code === "global_check_failed");
    for (const file of ["task_plan.md", "findings.md", "progress.md"]) {
      assert.doesNotMatch(readFileSync(path.join(fx.root, file), "utf8"), /META_KIM_RELEASE_CLOSURE/u);
    }
  } finally {
    fx.cleanup();
  }
});

test("release close refuses partial markers instead of overwriting planning history", async () => {
  const fx = fixture();
  try {
    writeFileSync(
      path.join(fx.root, "task_plan.md"),
      `# existing\n<!-- META_KIM_RELEASE_CLOSURE:${ISSUE}-${TAG}-${ATTEMPT}:START -->\n`,
      "utf8",
    );
    await assert.rejects(runFx(fx), (error) => error.code === "planning_projection_conflict");
  } finally {
    fx.cleanup();
  }
});

test("release close validates a pre-existing immutable record before mutating projections", async () => {
  const fx = fixture();
  try {
    const stateDir = path.join(fx.root, ".meta-kim/state/default/planning-closures");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, `${ISSUE}-${TAG}-${ATTEMPT}.json`),
      JSON.stringify({
        schemaVersion: "meta-kim-release-planning-closure-v1",
        issueId: "P-999",
        version: VERSION,
        tag: TAG,
      }),
      "utf8",
    );
    const before = Object.fromEntries(
      ["task_plan.md", "findings.md", "progress.md"].map((file) => [
        file,
        readFileSync(path.join(fx.root, file), "utf8"),
      ]),
    );
    await assert.rejects(runFx(fx), (error) => error.code === "closure_record_conflict");
    for (const [file, text] of Object.entries(before)) {
      assert.equal(readFileSync(path.join(fx.root, file), "utf8"), text);
    }
  } finally {
    fx.cleanup();
  }
});

test("release close rejects duplicate current-queue blocks", async () => {
  const fx = fixture();
  try {
    const prdPath = path.join(fx.root, PRD);
    writeFileSync(
      prdPath,
      `${readFileSync(prdPath, "utf8")}\n<!-- CURRENT_QUEUE_START -->\n| ACTIVE | P-129 | duplicate | bad |\n<!-- CURRENT_QUEUE_END -->\n`,
      "utf8",
    );
    await assert.rejects(runFx(fx), (error) => error.code === "prd_queue_invalid");
  } finally {
    fx.cleanup();
  }
});

test("release close resolves repository-relative PRD from a nested caller directory", async () => {
  const fx = fixture();
  try {
    const nested = path.join(fx.root, "nested", "work");
    mkdirSync(nested, { recursive: true });
    const result = await runFx(fx, { repoRoot: undefined, callerCwd: nested });
    assert.equal(result.repoRoot, path.resolve(fx.root));
    assert.equal(result.record.prdPath, PRD);
  } finally {
    fx.cleanup();
  }
});

test("release close rejects a lightweight release tag", async () => {
  const fx = fixture({ tagType: "commit" });
  try {
    await assert.rejects(runFx(fx), (error) => error.code === "annotated_tag_required");
  } finally {
    fx.cleanup();
  }
});

test("release close rejects PRD traversal before any state write", async () => {
  const fx = fixture();
  try {
    await assert.rejects(
      runFx(fx, { prdPath: "../outside.md" }),
      (error) => error.code === "path_invalid",
    );
    assert.equal(
      existsSync(path.join(fx.root, ".meta-kim/state/default/planning-closures")),
      false,
    );
  } finally {
    fx.cleanup();
  }
});

test("release close revalidates the private queue after the global check", async () => {
  const fx = fixture();
  try {
    let mutated = false;
    const runCommand = (command, args, options) => {
      const result = fx.runCommand(command, args, options);
      if (command === process.execPath && !mutated) {
        mutated = true;
        const prdFile = path.join(fx.root, PRD);
        writeFileSync(
          prdFile,
          readFileSync(prdFile, "utf8").replace("| ACTIVE | P-128 |", "| ACTIVE | P-999 |"),
          "utf8",
        );
      }
      return result;
    };
    await assert.rejects(
      runFx(fx, { runCommand }),
      (error) => ["prd_changed", "prd_issue_mismatch"].includes(error.code),
    );
    for (const file of ["task_plan.md", "findings.md", "progress.md"]) {
      assert.doesNotMatch(readFileSync(path.join(fx.root, file), "utf8"), /META_KIM_RELEASE_CLOSURE/u);
    }
  } finally {
    fx.cleanup();
  }
});

test("release close requires a fresh exact-release recheck after global validation", async () => {
  const fx = fixture();
  try {
    let calls = 0;
    await assert.rejects(
      runFx(fx, {
        verifyExactRelease: async () => {
          calls += 1;
          assert.equal(
            fx.calls.some(({ command }) => command === process.execPath),
            true,
            "exact remote replay must run after the global check",
          );
          const error = new Error("remote package digest changed");
          error.code = "release_exact_recheck_failed";
          throw error;
        },
      }),
      (error) => error.code === "release_exact_recheck_failed",
    );
    assert.equal(calls, 1);
  } finally {
    fx.cleanup();
  }
});

test("release close keeps global-check, metadata, and asset timeout budgets separate", async () => {
  const fx = fixture();
  try {
    let exactOptions;
    await runFx(fx, {
      globalCheckTimeoutMs: 111,
      metadataTimeoutMs: 222,
      assetTimeoutMs: 333,
      verifyExactRelease: async (options) => {
        exactOptions = options;
        return { status: "published_bound" };
      },
    });
    const globalCall = fx.calls.find(({ command }) => command === process.execPath);
    assert.equal(globalCall.options.timeout, 111);
    assert.equal(exactOptions.metadataTimeoutMs, 222);
    assert.equal(exactOptions.assetTimeoutMs, 333);
  } finally {
    fx.cleanup();
  }
});

test("release close rejects a published pointer detached from latest attempt history", async () => {
  const fx = fixture();
  try {
    const auditDir = path.dirname(path.dirname(fx.auditPath));
    const detachedAttempt = `${ATTEMPT.slice(0, -1)}6`;
    const detached = auditRecord({
      attemptId: detachedAttempt,
      status: "failed",
      promotionEligible: false,
      result: {
        status: "failed",
        promotionEligible: false,
        artifactsBound: false,
        verificationBound: false,
        failureReasons: ["simulated"],
      },
    });
    writeFileSync(
      path.join(auditDir, "attempts", `${detachedAttempt}.json`),
      JSON.stringify(detached, null, 2),
      "utf8",
    );
    writeFileSync(
      path.join(auditDir, "latest-attempt.json"),
      JSON.stringify({
        schemaVersion: "meta-kim-release-binding-pointer-v1",
        attemptId: detachedAttempt,
        recordHash: detached.recordHash,
        status: "failed",
        record: `attempts/${detachedAttempt}.json`,
      }, null, 2),
      "utf8",
    );
    await assert.rejects(runFx(fx), (error) => error.code === "release_audit_invalid");
  } finally {
    fx.cleanup();
  }
});

test("release close rejects a recomputed local audit with a non-GitHub release URL", async () => {
  const fx = fixture();
  try {
    const record = JSON.parse(readFileSync(fx.auditPath, "utf8"));
    delete record.recordHash;
    record.evidence.githubRelease.url = `javascript:alert(1)/tag/${TAG}`;
    record.recordHash = sha256(canonicalJson(record));
    writeFileSync(fx.auditPath, JSON.stringify(record, null, 2), "utf8");
    const auditDir = path.dirname(path.dirname(fx.auditPath));
    for (const pointerName of ["latest-published-bound.json", "latest-attempt.json"]) {
      const pointerPath = path.join(auditDir, pointerName);
      const pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
      pointer.recordHash = record.recordHash;
      writeFileSync(pointerPath, JSON.stringify(pointer, null, 2), "utf8");
    }
    await assert.rejects(runFx(fx), (error) => error.code === "release_audit_invalid");
  } finally {
    fx.cleanup();
  }
});

test("release close detects any tampering in an existing closure record", async () => {
  const fx = fixture();
  try {
    const first = await runFx(fx);
    const stored = JSON.parse(readFileSync(first.recordPath, "utf8"));
    stored.globalCheck.command = "attacker";
    delete stored.recordHash;
    stored.recordHash = sha256(canonicalJson(stored));
    writeFileSync(first.recordPath, JSON.stringify(stored, null, 2), "utf8");
    await assert.rejects(runFx(fx), (error) => error.code === "closure_record_conflict");
  } finally {
    fx.cleanup();
  }
});

test("release close rejects a malformed marker belonging to another release", async () => {
  const fx = fixture();
  try {
    writeFileSync(
      path.join(fx.root, "task_plan.md"),
      "# existing\n<!-- META_KIM_RELEASE_CLOSURE:P-100-v1.0.0-old:START -->\n",
      "utf8",
    );
    await assert.rejects(runFx(fx), (error) => error.code === "planning_projection_conflict");
  } finally {
    fx.cleanup();
  }
});

test("release close rejects tracked or otherwise non-private planning files", async () => {
  const fx = fixture();
  try {
    const runCommand = (command, args, options) => {
      if (command === "git" && args[0] === "check-ignore" && args.at(-1) === "task_plan.md") {
        return { status: 1, stdout: "", stderr: "" };
      }
      return fx.runCommand(command, args, options);
    };
    await assert.rejects(
      runFx(fx, { runCommand }),
      (error) => error.code === "planning_files_not_private",
    );
  } finally {
    fx.cleanup();
  }
});

test("release close fails when all planning files are absent", async () => {
  const fx = fixture();
  try {
    for (const file of ["task_plan.md", "findings.md", "progress.md"]) {
      rmSync(path.join(fx.root, file));
    }
    await assert.rejects(runFx(fx), (error) => error.code === "planning_files_missing");
  } finally {
    fx.cleanup();
  }
});

test("release close preserves a missing file and projects it after the file is restored", async () => {
  const fx = fixture();
  try {
    rmSync(path.join(fx.root, "findings.md"));
    const first = await runFx(fx);
    assert.equal(first.projectionResults["findings.md"], "absent_preserved");
    writeFileSync(path.join(fx.root, "findings.md"), "# restored findings\n", "utf8");
    const second = await runFx(fx);
    assert.equal(second.reusedRecord, true);
    assert.equal(second.projectionResults["findings.md"], "appended");
  } finally {
    fx.cleanup();
  }
});

test("release close preserves every existing byte before its appended block", async () => {
  const fx = fixture();
  try {
    const prefix = "# existing task plan  \n\n \n";
    writeFileSync(path.join(fx.root, "task_plan.md"), prefix, "utf8");
    await runFx(fx);
    assert.equal(readFileSync(path.join(fx.root, "task_plan.md"), "utf8").startsWith(prefix), true);
  } finally {
    fx.cleanup();
  }
});

test("release close sanitizes runtime-home and test overrides for the formal global check", async () => {
  const fx = fixture();
  try {
    const trustedUserHome = path.join(fx.root, "trusted-user");
    const environment = {
      ...process.env,
      HOME: "X:/fake-home",
      USERPROFILE: "X:/fake-profile",
      home: "X:/fake-lower-home",
      userprofile: "X:/fake-lower-profile",
      CODEX_HOME: "X:/fake-codex",
      CLAUDE_HOME: "X:/fake-claude",
      META_KIM_REPO_ROOT: "X:/fake-source",
      meta_kim_skill_ids: "attacker",
      META_KIM_TEST_FORCE_GLOBAL_FAILURE: "1",
      GIT_DIR: "X:/fake.git",
      GIT_WORK_TREE: "X:/fake-worktree",
      git_config_count: "1",
      NODE_OPTIONS: "--require X:/attacker.cjs",
      node_options: "--require X:/lower-attacker.cjs",
      NODE_PATH: "X:/attacker-modules",
      HTTP_PROXY: "http://user:secret@example.invalid:8080",
      HTTPS_PROXY: "http://user:secret@example.invalid:8080",
      ALL_PROXY: "http://user:secret@example.invalid:8080",
      NO_PROXY: "example.invalid",
      GH_TOKEN: "secret-token",
    };
    await runFx(fx, { environment, trustedUserHome });
    const call = fx.calls.find(({ command }) => command === process.execPath);
    assert.equal(call.options.env.CODEX_HOME, undefined);
    assert.equal(call.options.env.CLAUDE_HOME, undefined);
    assert.equal(call.options.env.META_KIM_REPO_ROOT, undefined);
    assert.equal(call.options.env.meta_kim_skill_ids, undefined);
    assert.equal(call.options.env.GIT_DIR, undefined);
    assert.equal(call.options.env.GIT_WORK_TREE, undefined);
    assert.equal(call.options.env.git_config_count, undefined);
    assert.equal(call.options.env.META_KIM_TEST_FORCE_GLOBAL_FAILURE, undefined);
    assert.equal(call.options.env.NODE_OPTIONS, undefined);
    assert.equal(call.options.env.node_options, undefined);
    assert.equal(call.options.env.NODE_PATH, undefined);
    assert.equal(call.options.env.HTTP_PROXY, undefined);
    assert.equal(call.options.env.HTTPS_PROXY, undefined);
    assert.equal(call.options.env.ALL_PROXY, undefined);
    assert.equal(call.options.env.NO_PROXY, undefined);
    assert.equal(call.options.env.GH_TOKEN, undefined);
    assert.equal(call.options.env.HOME, trustedUserHome);
    assert.equal(call.options.env.USERPROFILE, trustedUserHome);
    assert.equal(call.options.env.home, undefined);
    assert.equal(call.options.env.userprofile, undefined);
    for (const gitCall of fx.calls.filter(({ command }) => command === "git")) {
      assert.equal(gitCall.options.env.GIT_DIR, undefined);
      assert.equal(gitCall.options.env.GIT_WORK_TREE, undefined);
      assert.equal(gitCall.options.env.git_config_count, undefined);
    }
  } finally {
    fx.cleanup();
  }
});

test("release close rejects a junction-backed closure state directory", async (t) => {
  const fx = fixture();
  try {
    const stateDir = path.join(fx.root, ".meta-kim", "state", "default", "planning-closures");
    const userOwned = path.join(fx.root, "user-owned");
    mkdirSync(userOwned, { recursive: true });
    try {
      symlinkSync(userOwned, stateDir, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`linked-directory creation unavailable: ${error.code || error.message}`);
      return;
    }
    await assert.rejects(runFx(fx), (error) => error.code === "path_invalid");
    assert.deepEqual(readdirSync(userOwned), []);
  } finally {
    fx.cleanup();
  }
});

test("release close rejects a junction-backed stale-locks directory before stale recovery", async (t) => {
  const fx = fixture();
  const outside = mkdtempSync(path.join(tmpdir(), "meta-kim-release-close-outside-"));
  try {
    const stateDir = path.join(fx.root, ".meta-kim", "state", "default", "planning-closures");
    mkdirSync(stateDir, { recursive: true });
    try {
      symlinkSync(
        outside,
        path.join(stateDir, "stale-locks"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      t.skip(`linked-directory creation unavailable: ${error.code || error.message}`);
      return;
    }
    writeFileSync(
      path.join(stateDir, "planning-closure.lock"),
      JSON.stringify({ pid: 2147483647, token: "dead", createdAt: "2020-01-01T00:00:00.000Z" }),
      "utf8",
    );
    await assert.rejects(runFx(fx), (error) => error.code === "path_invalid");
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    fx.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("release close rejects malformed markers whose ids contain extra colons", async () => {
  const fx = fixture();
  try {
    writeFileSync(
      path.join(fx.root, "task_plan.md"),
      "# existing\n<!-- META_KIM_RELEASE_CLOSURE:bad:id:START -->\n",
      "utf8",
    );
    await assert.rejects(runFx(fx), (error) => error.code === "planning_projection_conflict");
  } finally {
    fx.cleanup();
  }
});

test("release close rejects planning-file disappearance after its final presence snapshot", async () => {
  const fx = fixture();
  try {
    await assert.rejects(
      runFx(fx, {
        afterProjectionWrite: (file) => {
          if (file === "task_plan.md") rmSync(path.join(fx.root, "findings.md"));
        },
      }),
      (error) => error.code === "planning_file_changed",
    );
    assert.equal(
      existsSync(path.join(
        fx.root,
        ".meta-kim/state/default/planning-closures",
        `${ISSUE}-${TAG}-${ATTEMPT}.json`,
      )),
      false,
    );
  } finally {
    fx.cleanup();
  }
});

test("release close rejects restoration of an absent planning file during projection", async () => {
  const fx = fixture();
  try {
    rmSync(path.join(fx.root, "findings.md"));
    await assert.rejects(
      runFx(fx, {
        afterProjectionWrite: (file) => {
          if (file === "task_plan.md") {
            writeFileSync(path.join(fx.root, "findings.md"), "# concurrently restored\n", "utf8");
          }
        },
      }),
      (error) => error.code === "planning_file_changed",
    );
  } finally {
    fx.cleanup();
  }
});

test("release close revalidates the PRD after all planning projections and before record publish", async () => {
  const fx = fixture();
  try {
    let changed = false;
    await assert.rejects(
      runFx(fx, {
        afterProjectionWrite: () => {
          if (changed) return;
          changed = true;
          const prdFile = path.join(fx.root, PRD);
          writeFileSync(
            prdFile,
            readFileSync(prdFile, "utf8").replace("| ACTIVE | P-128 |", "| ACTIVE | P-129 |"),
            "utf8",
          );
        },
      }),
      (error) => ["prd_changed", "prd_issue_mismatch"].includes(error.code),
    );
    assert.equal(
      existsSync(path.join(
        fx.root,
        ".meta-kim/state/default/planning-closures",
        `${ISSUE}-${TAG}-${ATTEMPT}.json`,
      )),
      false,
    );
  } finally {
    fx.cleanup();
  }
});

test("release close rejects a discovered Git top-level that does not own caller cwd", async () => {
  const fx = fixture();
  try {
    const nested = path.join(fx.root, "nested", "work");
    const fakeTop = path.join(fx.root, "unrelated");
    mkdirSync(nested, { recursive: true });
    mkdirSync(fakeTop, { recursive: true });
    const runCommand = (command, args, options) => {
      if (command === "git" && args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return { status: 0, stdout: `${fakeTop}\n`, stderr: "" };
      }
      return fx.runCommand(command, args, options);
    };
    await assert.rejects(
      runFx(fx, { repoRoot: undefined, callerCwd: nested, runCommand }),
      (error) => error.code === "git_root_failed",
    );
  } finally {
    fx.cleanup();
  }
});
