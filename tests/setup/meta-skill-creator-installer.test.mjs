import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  buildGlobalCapabilityInventoryArgs,
  normalizeInstallerSkillsFilter,
  replaceTargetDir,
  resolveSkillTargetDir,
  shouldRecordManagedDependencyTarget,
  transactionalReplaceMetaSkillTargets,
  validateInstallerArgs,
} from "../../scripts/install-global-skills-all-runtimes.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const installer = path.join(repoRoot, "scripts", "install-global-skills-all-runtimes.mjs");
const roots = [];

function tempRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-skill-installer-"));
  roots.push(root);
  return root;
}

function writeFixture(dir, version, { valid = true } = {}) {
  mkdirSync(dir, { recursive: true });
  const content = valid
    ? `---\nname: meta-skill-creator\ndescription: Create skills safely.\n---\n\n${version}\n`
    : `invalid-${version}\n`;
  writeFileSync(path.join(dir, "SKILL.md"), content);
  writeFileSync(path.join(dir, "payload.txt"), `${version}\n`);
}

function hashTree(root) {
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  walk(root);
  files.sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(root, file).replaceAll("\\", "/"));
    hash.update("\n");
    hash.update(readFileSync(file));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function childEnv(root, sourceDir, overrides = {}) {
  return {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    META_KIM_CLAUDE_HOME: path.join(root, "custom", "claude-home"),
    META_KIM_CODEX_HOME: path.join(root, "custom", "deep", "codex-home"),
    META_KIM_ALLOW_TEST_FIXTURES: "1",
    META_KIM_TEST_META_SKILL_SOURCE_DIR: sourceDir,
    META_KIM_SKIP_OPTIONAL_TOOLS: "1",
    ...overrides,
  };
}

function runInstaller(root, sourceDir, extraArgs = [], overrides = {}) {
  return spawnSync(
    process.execPath,
    [
      installer,
      "--targets",
      "claude,codex",
      "--skills",
      "meta-skill-creator",
      "--skip-plugins",
      "--skip-inventory-refresh",
      ...extraArgs,
    ],
    { cwd: repoRoot, env: childEnv(root, sourceDir, overrides), encoding: "utf8" },
  );
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

test("setup-compatible empty --skills is accepted while real missing values fail closed", () => {
  assert.doesNotThrow(() => validateInstallerArgs(["--skills", ""]));
  assert.doesNotThrow(() => validateInstallerArgs(["--skills="]));
  assert.deepEqual(normalizeInstallerSkillsFilter([]), []);
  assert.throws(() => validateInstallerArgs(["--targets", ""]), /requires a value/);
  assert.throws(() => validateInstallerArgs(["--skills"]), /requires a value/);
  assert.throws(
    () => validateInstallerArgs(["--targets", "codex"]),
    /explicit selection/,
  );
  assert.throws(
    () => validateInstallerArgs(["--all", "--skills", "ecc"]),
    /mutually exclusive/,
  );
  assert.doesNotThrow(() => validateInstallerArgs(["--all", "--targets", "codex"]));
  assert.doesNotThrow(() => validateInstallerArgs(["--help"]));
  for (const language of ["en", "zh", "zh-CN", "ja", "ja-JP", "ko", "ko-KR"]) {
    assert.doesNotThrow(() => validateInstallerArgs(["--all", `--lang=${language}`]));
  }
  for (const language of ["", "-x", "en-US", "../../tmp", "unknown"]) {
    assert.throws(
      () => validateInstallerArgs([`--lang=${language}`]),
      /requires (?:a value|one of)/,
    );
  }
  assert.throws(() => validateInstallerArgs(["--lang", "-x"]), /requires a value/);
  assert.deepEqual(buildGlobalCapabilityInventoryArgs(["claude", "codex"], "ja-JP"), [
    "--lang",
    "ja-JP",
    "--runtime-inventory-only",
    "--targets",
    "claude,codex",
  ]);
});

test("an existing user directory is not adopted without a current write or matching receipt", () => {
  const closure = { sha256: "a".repeat(64), entryCount: 2 };
  assert.equal(shouldRecordManagedDependencyTarget({ currentClosure: closure }), false);
  assert.equal(shouldRecordManagedDependencyTarget({
    currentClosure: closure,
    previousEntry: {
      directoryClosureSha256: "b".repeat(64),
      directoryClosureEntryCount: 2,
    },
  }), false);
  assert.equal(shouldRecordManagedDependencyTarget({
    currentClosure: closure,
    previousEntry: {
      directoryClosureSha256: closure.sha256,
      directoryClosureEntryCount: 2,
    },
  }), true);
  assert.equal(shouldRecordManagedDependencyTarget({ wasWritten: true }), true);
});

test("legacy shell wrapper preserves explicit dependency selection for install and update", () => {
  const wrapper = readFileSync(path.join(repoRoot, "install-deps.sh"), "utf8");
  assert.match(wrapper, /ARGS=\(--all --targets claude\)/u);
  assert.match(wrapper, /ARGS=\(--update --all --targets claude\)/u);
});

test("split and equals language forms produce the same localized zero-write output", () => {
  for (const languageArgs of [["--lang", "zh-CN"], ["--lang=zh"]]) {
    const root = tempRoot();
    const result = spawnSync(
      process.execPath,
      [
        installer,
        ...languageArgs,
        "--targets",
        "openclaw",
        "--skills",
        "",
        "--dry-run",
        "--skip-plugins",
        "--skip-inventory-refresh",
      ],
      {
        cwd: repoRoot,
        env: childEnv(root, path.join(root, "unused"), { META_KIM_LANG: "en" }),
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /未选择任何第三方技能仓库/u);
    assert.deepEqual(readdirSync(root), []);
  }
});

test("custom CODEX_HOME still resolves the official Codex skill under OS user home", () => {
  const root = tempRoot();
  const customCodex = path.join(root, "custom", "deep", "codex-home");
  assert.equal(
    resolveSkillTargetDir(customCodex, { id: "meta-skill-creator" }, "codex", root),
    path.join(root, ".agents", "skills", "meta-skill-creator"),
  );
});

test("fresh skill promotion retries transient Windows rename locks atomically", async () => {
  const root = tempRoot();
  const staged = path.join(root, "planning-with-files.staged-fixture");
  const target = path.join(root, "planning-with-files");
  mkdirSync(staged, { recursive: true });
  writeFileSync(path.join(staged, "SKILL.md"), "fresh\n");
  let attempts = 0;
  const waits = [];

  await replaceTargetDir(target, staged, {
    renameOptions: {
      platform: "win32",
      retries: 4,
      retryDelayMs: 1,
      wait: async (ms) => waits.push(ms),
      rename: async (sourcePath, targetPath) => {
        attempts += 1;
        if (attempts < 3) {
          const error = new Error("transient lock");
          error.code = "EPERM";
          throw error;
        }
        renameSync(sourcePath, targetPath);
      },
    },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(waits, [1, 2]);
  assert.equal(existsSync(staged), false);
  assert.equal(readFileSync(path.join(target, "SKILL.md"), "utf8"), "fresh\n");
});

test("persistent Windows rename locks fail bounded without publishing a partial target", async () => {
  const root = tempRoot();
  const staged = path.join(root, "planning-with-files.staged-fixture");
  const target = path.join(root, "planning-with-files");
  mkdirSync(staged, { recursive: true });
  writeFileSync(path.join(staged, "SKILL.md"), "fresh\n");
  let attempts = 0;

  await assert.rejects(
    replaceTargetDir(target, staged, {
      renameOptions: {
        platform: "win32",
        retries: 3,
        retryDelayMs: 1,
        wait: async () => {},
        rename: async () => {
          attempts += 1;
          const error = new Error("persistent lock");
          error.code = "EBUSY";
          throw error;
        },
      },
    }),
    /persistent lock/,
  );

  assert.equal(attempts, 3);
  assert.equal(existsSync(target), false);
  assert.equal(readFileSync(path.join(staged, "SKILL.md"), "utf8"), "fresh\n");
});

test("meta-skill transaction uses the same bounded Windows rename retry", async () => {
  const root = tempRoot();
  const source = path.join(root, "source");
  const primary = path.join(root, ".agents", "skills", "meta-skill-creator");
  const compat = path.join(root, ".codex", "skills", "meta-skill-creator");
  writeFixture(source, "retry-safe");
  let attempts = 0;

  await transactionalReplaceMetaSkillTargets(source, [primary, compat], {
    userHome: root,
    renameOptions: {
      platform: "win32",
      retries: 4,
      retryDelayMs: 1,
      wait: async () => {},
      rename: async (sourcePath, targetPath) => {
        attempts += 1;
        if (attempts < 3) {
          const error = new Error("transient transaction lock");
          error.code = "EACCES";
          throw error;
        }
        renameSync(sourcePath, targetPath);
      },
    },
  });

  assert.ok(attempts >= 4);
  assert.equal(hashTree(primary), hashTree(source));
  assert.equal(hashTree(compat), hashTree(source));
});

test("real child process fresh install and update cover Claude plus both Codex roots", () => {
  const root = tempRoot();
  const fixture = path.join(root, "fixture");
  writeFixture(fixture, "v1");
  const oldAgents = path.join(root, ".agents", "skills", "skill-creator");
  const oldCodex = path.join(root, "custom", "deep", "codex-home", "skills", "skill-creator");
  writeFixture(oldAgents, "old-agents");
  writeFixture(oldCodex, "old-codex");
  const oldHashes = [hashTree(oldAgents), hashTree(oldCodex)];
  const fresh = runInstaller(root, fixture);
  assert.equal(fresh.status, 0, fresh.stderr || fresh.stdout);

  const claude = path.join(root, "custom", "claude-home", "skills", "meta-skill-creator");
  const codexMain = path.join(root, ".agents", "skills", "meta-skill-creator");
  const codexCompat = path.join(root, "custom", "deep", "codex-home", "skills", "meta-skill-creator");
  const v1Hash = hashTree(fixture);
  assert.deepEqual([hashTree(claude), hashTree(codexMain), hashTree(codexCompat)], [v1Hash, v1Hash, v1Hash]);
  const manifestPath = path.join(root, ".meta-kim", "install-manifest.json");
  const freshManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const freshReceipts = freshManifest.entries.filter(
    (entry) => entry.purpose === "meta-skill-creator-global-skill",
  );
  assert.deepEqual(
    freshReceipts.map((entry) => path.resolve(entry.path)).sort(),
    [claude, codexMain, codexCompat].map((entry) => path.resolve(entry)).sort(),
  );
  assert.equal(
    freshReceipts.every(
      (entry) => /^[a-f0-9]{64}$/u.test(entry.directoryClosureSha256) &&
        Number.isSafeInteger(entry.directoryClosureEntryCount) &&
        entry.directoryClosureEntryCount > 0,
    ),
    true,
  );

  rmSync(fixture, { recursive: true, force: true });
  writeFixture(fixture, "v2");
  const update = runInstaller(root, fixture, ["--update"]);
  assert.equal(update.status, 0, update.stderr || update.stdout);
  const v2Hash = hashTree(fixture);
  assert.notEqual(v2Hash, v1Hash);
  assert.deepEqual([hashTree(claude), hashTree(codexMain), hashTree(codexCompat)], [v2Hash, v2Hash, v2Hash]);
  const updatedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const updatedReceipts = updatedManifest.entries.filter(
    (entry) => entry.purpose === "meta-skill-creator-global-skill",
  );
  assert.equal(updatedReceipts.length, 3);
  assert.equal(
    updatedReceipts.every((entry) => entry.directoryClosureSha256 !== freshReceipts.find(
      (before) => path.resolve(before.path) === path.resolve(entry.path),
    )?.directoryClosureSha256),
    true,
  );
  assert.deepEqual([hashTree(oldAgents), hashTree(oldCodex)], oldHashes);
});

test("invalid update rolls back and leaves all prior new-skill roots unchanged", () => {
  const root = tempRoot();
  const fixture = path.join(root, "fixture");
  writeFixture(fixture, "good");
  assert.equal(runInstaller(root, fixture).status, 0);
  const targets = [
    path.join(root, "custom", "claude-home", "skills", "meta-skill-creator"),
    path.join(root, ".agents", "skills", "meta-skill-creator"),
    path.join(root, "custom", "deep", "codex-home", "skills", "meta-skill-creator"),
  ];
  const before = targets.map(hashTree);
  rmSync(fixture, { recursive: true, force: true });
  writeFixture(fixture, "bad", { valid: false });
  const failed = runInstaller(root, fixture, ["--update"]);
  assert.notEqual(failed.status, 0);
  assert.deepEqual(targets.map(hashTree), before);
});

test("injected mid-commit failure rolls back Claude and both Codex roots", () => {
  const root = tempRoot();
  const fixture = path.join(root, "fixture");
  writeFixture(fixture, "v1");
  assert.equal(runInstaller(root, fixture).status, 0);
  const targets = [
    path.join(root, "custom", "claude-home", "skills", "meta-skill-creator"),
    path.join(root, ".agents", "skills", "meta-skill-creator"),
    path.join(root, "custom", "deep", "codex-home", "skills", "meta-skill-creator"),
  ];
  const before = targets.map(hashTree);
  rmSync(fixture, { recursive: true, force: true });
  writeFixture(fixture, "v2");
  const failed = runInstaller(root, fixture, ["--update"], {
    META_KIM_TEST_FAIL_COMMIT_AFTER: "1",
  });
  assert.notEqual(failed.status, 0);
  assert.deepEqual(targets.map(hashTree), before);
});

test("rollback failure is explicit and preserves recovery backup path", () => {
  const root = tempRoot();
  const fixture = path.join(root, "fixture");
  writeFixture(fixture, "v1");
  assert.equal(runInstaller(root, fixture).status, 0);
  rmSync(fixture, { recursive: true, force: true });
  writeFixture(fixture, "v2");
  const failed = runInstaller(root, fixture, ["--update"], {
    META_KIM_TEST_FAIL_COMMIT_AFTER: "1",
    META_KIM_TEST_FAIL_ROLLBACK_TARGET_INDEX: "0",
  });
  assert.notEqual(failed.status, 0);
  assert.match(`${failed.stdout}\n${failed.stderr}`, /recovery was incomplete|recovery backup/i);
  assert.match(`${failed.stdout}\n${failed.stderr}`, /transaction-backup-/i);
  const claudeSkills = path.join(root, "custom", "claude-home", "skills");
  const backups = readdirSync(claudeSkills).filter((name) =>
    name.startsWith("meta-skill-creator.transaction-backup-"),
  );
  assert.equal(backups.length, 1);
  assert.match(readFileSync(path.join(claudeSkills, backups[0], "SKILL.md"), "utf8"), /v1/);
});

test("transaction rejects junction targets without writing outside", async () => {
  const root = tempRoot();
  const source = path.join(root, "source");
  const outside = path.join(root, "outside");
  const agentsRoot = path.join(root, ".agents");
  writeFixture(source, "safe");
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, agentsRoot, "junction");
  const primary = path.join(agentsRoot, "skills", "meta-skill-creator");
  const compat = path.join(root, ".codex", "skills", "meta-skill-creator");
  await assert.rejects(
    transactionalReplaceMetaSkillTargets(source, [primary, compat], { userHome: root }),
    /symlink|junction|escape/i,
  );
  assert.deepEqual(readdirSync(outside), []);
});

test("child process rejects compat junction and never touches old skill-creator or outside", () => {
  const root = tempRoot();
  const fixture = path.join(root, "fixture");
  const outside = path.join(root, "outside");
  const codexHome = path.join(root, "custom", "deep", "codex-home");
  writeFixture(fixture, "safe");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, path.join(codexHome, "skills"), "junction");
  const oldAgents = path.join(root, ".agents", "skills", "skill-creator");
  const oldCodex = path.join(outside, "skill-creator");
  writeFixture(oldAgents, "old-agents");
  writeFixture(oldCodex, "old-codex");
  const agentsSentinel = hashTree(oldAgents);
  const codexSentinel = hashTree(oldCodex);

  const result = runInstaller(root, fixture);
  assert.notEqual(result.status, 0);
  assert.equal(hashTree(oldAgents), agentsSentinel);
  assert.equal(hashTree(oldCodex), codexSentinel);
  assert.deepEqual(readdirSync(outside).sort(), ["skill-creator"]);
  assert.equal(existsSync(path.join(outside, "meta-skill-creator")), false);
  assert.equal(existsSync(path.join(root, ".agents", "skills", "meta-skill-creator")), false);
  assert.equal(existsSync(path.join(root, "custom", "claude-home", "skills", "meta-skill-creator")), false);
});

test("help and invalid arguments are zero-write", () => {
  for (const args of [
    ["--help"],
    ["-h"],
    ["--unknown-option"],
    ["--help", "--lang=../../tmp"],
  ]) {
    const root = tempRoot();
    const result = spawnSync(process.execPath, [installer, ...args], {
      cwd: repoRoot,
      env: { ...process.env, HOME: root, USERPROFILE: root },
      encoding: "utf8",
    });
    if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
      assert.equal(result.status, 0);
    } else {
      assert.notEqual(result.status, 0);
    }
    assert.deepEqual(readdirSync(root), []);
  }
});
