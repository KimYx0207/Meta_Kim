import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";

import {
  decideCapabilityGap,
  openRunStateStore,
} from "../../scripts/capability-gap-mvp.mjs";
import {
  detectProfileCollision,
  ensureProfileState,
  getProfilePaths,
  resolveProfileName,
  resolveRuntimeFamily,
  SHARED_RUNTIME_FAMILY,
} from "../../scripts/meta-kim-local-state.mjs";
import {
  joinProjectRegistry,
  readProjectRegistryEntry,
} from "../../scripts/project-registry.mjs";
import { createReportContext } from "../../scripts/report-context.mjs";
import { sanitizeStateProfile } from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import { openDb, upsertRun } from "../../scripts/run-index.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.join(import.meta.dirname, "..", "..");

function sampleSummary(payloadMarker = "original") {
  return {
    artifactPath: "artifacts/run.json",
    indexedAt: "2026-07-11T00:00:00.000Z",
    governanceFlow: "standard_path",
    taskClass: "implementation",
    requestClass: "execution",
    primaryDeliverable: "result",
    ownerAgents: ["worker"],
    publicReady: false,
    verifyPassed: false,
    openFindingIds: ["finding-1"],
    writebackDecision: "none_with_reason",
    payload: {
      marker: payloadMarker,
      reviewFindings: [
        { findingId: "finding-1", owner: "worker", severity: "high" },
      ],
    },
  };
}

describe("sqlite unit-of-work boundaries", () => {
  test("capability-gap persistence rolls back every table after an injected failure", async () => {
    const store = await openRunStateStore(":memory:");
    const result = decideCapabilityGap("Need a bounded worker task", {
      expectedDecision: "worker_task_only",
      runId: "rollback-run",
    });

    assert.throws(
      () => store.persistDecisionRun(result, {
        onWriteStep(step) {
          if (step === "capability_gap") throw new Error("injected failure");
        },
      }),
      /injected failure/,
    );
    assert.equal(store.count("runs"), 0);
    assert.equal(store.count("capability_gaps"), 0);
    assert.equal(store.count("gap_decisions"), 0);
    assert.equal(store.count("run_events"), 0);
    store.close();
  });

  test("project enrollment rolls back project, platform, and source rows together", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-tx-home-"));
    const repoPath = path.join(homeDir, "workspace", "rollback");
    await assert.rejects(
      joinProjectRegistry({
        homeDir,
        repoPath,
        runtimeFamily: "codex",
        onWriteStep(step) {
          if (step === "platform") throw new Error("injected failure");
        },
      }),
      /injected failure/,
    );
    assert.equal(await readProjectRegistryEntry({ homeDir, repoPath }), null);
  });

  test("run-index preserves the previous run and findings when replacement fails", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-run-index-"));
    const db = await openDb(path.join(tempDir, "run-index.sqlite"));
    upsertRun(db, sampleSummary("original"));

    assert.throws(
      () => upsertRun(db, sampleSummary("replacement"), {
        onWriteStep(step) {
          if (step === "delete_findings") throw new Error("injected failure");
        },
      }),
      /injected failure/,
    );
    const run = db.prepare("SELECT payload_json FROM runs WHERE artifact_path = ?")
      .get("artifacts/run.json");
    const findingCount = db.prepare("SELECT COUNT(*) AS count FROM run_findings").get().count;
    assert.equal(JSON.parse(run.payload_json).marker, "original");
    assert.equal(findingCount, 1);
    db.close();
  });
});

describe("profile-aware state paths", () => {
test("runtime-family inference reads the real entrypoint, not business argument values", () => {
  assert.equal(
    resolveRuntimeFamily(undefined, {
      environment: {},
      argv: [
        process.execPath,
        path.join(REPO_ROOT, "scripts", "discover-global-capabilities.mjs"),
        "--targets",
        "claude,codex",
      ],
    }),
    SHARED_RUNTIME_FAMILY,
  );
  assert.equal(
    resolveRuntimeFamily(undefined, {
      environment: {},
      argv: [
        process.execPath,
        path.join("C:\\", "Users", "Runtime", ".codex", "hooks", "check.mjs"),
        "--targets",
        "claude,codex",
      ],
    }),
    "codex",
  );
});

/**
 * Measured in a live Claude Code session: `CLAUDECODE=1` and
 * `CLAUDE_CODE_SESSION_ID=<chat id>` are both present, and `CLAUDE_PROJECT_DIR`
 * is not. A governed run started by an npm script also has no `claude` segment
 * in its entrypoint, so without these two markers the only Claude signals the
 * host actually exports are ignored and the run files its state under the
 * shared family. Codex is recognized from its own real markers on the branch
 * directly above, so the gap was one-sided.
 */
test("a real Claude Code environment is recognized from the markers the host exports", () => {
  const neutralArgv = [process.execPath, path.join(REPO_ROOT, "scripts", "run-meta-theory-governed-execution.mjs")];
  for (const environment of [
    { CLAUDECODE: "1" },
    { CLAUDE_CODE_SESSION_ID: "b5799d00-ef7a-4882-818d-d9053cacba71" },
    { CLAUDE_CODE_ENTRYPOINT: "cli" },
  ]) {
    assert.equal(
      resolveRuntimeFamily(undefined, { environment, argv: neutralArgv }),
      "claude",
      `${Object.keys(environment)[0]} is exported by the host and must identify the runtime`,
    );
  }
});

/**
 * A nested launch keeps the outer host's variables, so the inner runtime has to
 * win or a Codex run inside a Claude session would write to the Claude profile.
 */
test("an inner runtime outranks the outer host's inherited markers", () => {
  assert.equal(
    resolveRuntimeFamily(undefined, {
      environment: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "b5799d00", CODEX_HOME: "/codex" },
      argv: [process.execPath, path.join(REPO_ROOT, "scripts", "run-meta-theory-governed-execution.mjs")],
    }),
    "codex",
  );
});

  test("META_KIM_PROFILE selects an isolated profile for state and reports", () => {
    const previous = process.env.META_KIM_PROFILE;
    process.env.META_KIM_PROFILE = "test";
    try {
      const paths = getProfilePaths();
      const reports = createReportContext();
      assert.equal(paths.profile, "test");
      assert.match(paths.profileDir.replaceAll("\\", "/"), /\.meta-kim\/state\/test$/);
      assert.equal(reports.resolveStatePath("verification-report.json"), path.join(paths.profileDir, "verification-report.json"));
      assert.doesNotMatch(reports.resolveStatePath("verification-report.json").replaceAll("\\", "/"), /\/state\/default\//);
    } finally {
      if (previous === undefined) delete process.env.META_KIM_PROFILE;
      else process.env.META_KIM_PROFILE = previous;
    }
  });

  test("profile names cannot escape the repo-local state root", () => {
    const escaped = resolveProfileName("../escape");
    assert.match(escaped, /^derived-escape-[a-f0-9]{12}$/u);
    const paths = getProfilePaths({ canonicalProfile: escaped });
    assert.equal(paths.profile, escaped);
    assert.ok(paths.profileDir.startsWith(path.dirname(getProfilePaths().profileDir)));
  });

  test("unsafe and overlong profile names keep collision-resistant identities", () => {
    assert.notEqual(resolveProfileName("tenant/a"), resolveProfileName("tenant a"));
    assert.notEqual(
      resolveProfileName("tenant/a"),
      resolveProfileName(resolveProfileName("tenant/a")),
      "derived profile names are a reserved namespace and cannot be impersonated by explicit legal input",
    );
    assert.notEqual(resolveProfileName("x".repeat(81)), "default");
    assert.equal(resolveProfileName("safe.profile-1"), "safe.profile-1");
    const generated = resolveProfileName("tenant/a");
    assert.equal(getProfilePaths({ canonicalProfile: generated }).profile, generated);
    assert.notEqual(
      getProfilePaths({ profile: generated }).profile,
      generated,
      "raw user input cannot impersonate the reserved generated namespace",
    );
    assert.throws(
      () => getProfilePaths({ profile: "raw", canonicalProfile: generated }),
      /either raw profile or canonicalProfile/u,
    );
    for (const value of ["tenant/a", "tenant a", "x".repeat(81), ".", ".."]) {
      assert.ok(resolveProfileName(value).length <= 80);
    }
  });

  test("runtime-only discovery cannot traverse through META_KIM_PROFILE", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-profile-attack-"));
    const rawProfile = `../../escape-${process.pid}-${Date.now()}`;
    const safeProfile = resolveProfileName(rawProfile);
    const profileDir = getProfilePaths({
      profile: rawProfile,
      runtimeFamily: "shared",
      repoPath: home,
      stateRoot: path.join(home, ".meta-kim", "state"),
    }).profileDir;
    const escapedDir = path.resolve(home, ".meta-kim", "state", rawProfile);
    try {
      await execFileAsync(
        process.execPath,
        [
          path.join(REPO_ROOT, "scripts", "discover-global-capabilities.mjs"),
          "--runtime-inventory-only",
          "--targets",
          "claude",
        ],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            META_KIM_CLAUDE_HOME: path.join(home, "claude"),
            META_KIM_PROFILE: rawProfile,
            META_KIM_RUNTIME_FAMILY: "shared",
          },
          maxBuffer: 1024 * 1024 * 4,
        },
      );

      await fs.access(
        path.join(profileDir, "capability-index", "global-capabilities.json"),
      );
      await assert.rejects(() => fs.access(escapedDir));
      assert.equal(path.basename(profileDir), safeProfile);
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("cross-runtime discovery keeps shared profile ownership under Codex host pollution", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-shared-discovery-"));
    const profile = `shared-discovery-${process.pid}-${Date.now()}`;
    const paths = getProfilePaths({
      profile,
      runtimeFamily: SHARED_RUNTIME_FAMILY,
      repoPath: home,
      stateRoot: path.join(home, ".meta-kim", "state"),
    });
    try {
      await execFileAsync(
        process.execPath,
        [
          path.join(REPO_ROOT, "scripts", "discover-global-capabilities.mjs"),
          "--runtime-inventory-only",
          "--targets",
          "claude,codex",
        ],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            CODEX_HOME: path.join(home, ".codex-host"),
            META_KIM_CODEX_HOME: path.join(home, ".codex-runtime"),
            META_KIM_CLAUDE_HOME: path.join(home, ".claude-runtime"),
            META_KIM_PROFILE: profile,
            META_KIM_RUNTIME: "codex",
            META_KIM_RUNTIME_FAMILY: "codex",
          },
          maxBuffer: 1024 * 1024 * 4,
        },
      );

      const metadata = JSON.parse(await fs.readFile(paths.profileFile, "utf8"));
      assert.equal(metadata.runtimeFamily, SHARED_RUNTIME_FAMILY);
      assert.equal(metadata.repoRoot, home);
      await fs.access(
        path.join(paths.profileDir, "capability-index", "global-capabilities.json"),
      );
      await assert.rejects(() =>
        fs.access(getProfilePaths({ profile }).profileFile)
      );
    } finally {
      await fs.rm(paths.profileDir, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("global Hook discovery excludes exact Meta_Kim backup trees but keeps user directories", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-hook-discovery-"));
    const profile = `hook-discovery-${process.pid}-${Date.now()}`;
    const inventoryPath = path.join(
      home,
      ".meta-kim",
      "state",
      profile,
      "capability-index",
      "global-capabilities.json",
    );
    try {
      for (const runtimeHome of [".claude", ".codex"]) {
        const hooksDir = path.join(home, runtimeHome, "hooks");
        const hookFiles = [
          ["active.mjs", "// active hook\n"],
          [path.join("user-backup-tools", "user-hook.mjs"), "// user hook\n"],
          [
            path.join(
              ".meta-kim-hook-package-backup",
              "2026-08-01T00-00-00-000Z",
              "meta-kim",
              "old.mjs",
            ),
            "// retained package backup\n",
          ],
          [path.join(".meta-kim-legacy-backup", "old.mjs"), "// retained legacy backup\n"],
        ];
        for (const [relativePath, content] of hookFiles) {
          const targetPath = path.join(hooksDir, relativePath);
          await fs.mkdir(path.dirname(targetPath), { recursive: true });
          await fs.writeFile(targetPath, content, "utf8");
        }
      }

      const runDiscovery = async () =>
        execFileAsync(
          process.execPath,
          [
            path.join(REPO_ROOT, "scripts", "discover-global-capabilities.mjs"),
            "--runtime-inventory-only",
            "--targets",
            "claude,codex",
            "--json",
          ],
          {
            cwd: REPO_ROOT,
            env: {
              ...process.env,
              HOME: home,
              USERPROFILE: home,
              META_KIM_PROFILE: profile,
              META_KIM_RUNTIME_FAMILY: "shared",
            },
            maxBuffer: 1024 * 1024 * 4,
          },
        );

      await runDiscovery();

      const inventory = JSON.parse(await fs.readFile(inventoryPath, "utf8"));
      const hooks = Object.values(inventory.byCapabilityType.hooks);
      for (const platformId of ["claudeCode", "codex"]) {
        const hookRefs = hooks
          .filter((record) => record.platformId === platformId)
          .map((record) => record.sourceRef);
        assert.equal(hookRefs.some((ref) => ref.endsWith("/active.mjs")), true);
        assert.equal(hookRefs.some((ref) => ref.includes("/user-backup-tools/user-hook.mjs")), true);
      }
      const hookRefs = hooks.map((record) => record.sourceRef);
      assert.equal(hookRefs.some((ref) => ref.includes("/.meta-kim-hook-package-backup/")), false);
      assert.equal(hookRefs.some((ref) => ref.includes("/.meta-kim-legacy-backup/")), false);

      const firstHookRefs = [...hookRefs].sort();
      const secondBackupFiles = [];
      for (const runtimeHome of [".claude", ".codex"]) {
        const backupPath = path.join(
          home,
          runtimeHome,
          "hooks",
          ".meta-kim-hook-package-backup",
          "2026-08-01T00-01-00-000Z",
          "meta-kim",
          "newer-old.mjs",
        );
        await fs.mkdir(path.dirname(backupPath), { recursive: true });
        await fs.writeFile(backupPath, "// newer retained package backup\n", "utf8");
        secondBackupFiles.push(backupPath);
      }

      await runDiscovery();
      const secondInventory = JSON.parse(await fs.readFile(inventoryPath, "utf8"));
      const secondHookRefs = Object.values(secondInventory.byCapabilityType.hooks)
        .map((record) => record.sourceRef)
        .sort();
      assert.deepEqual(secondHookRefs, firstHookRefs);
      for (const backupPath of secondBackupFiles) {
        assert.equal((await fs.stat(backupPath)).isFile(), true);
      }
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("application and Hook layers normalize profile names identically", () => {
    const cases = [
      { label: "unset", value: undefined },
      { label: "safe default", value: "default" },
      { label: "safe punctuation", value: "team.one_2-safe" },
      { label: "space", value: "team one" },
      { label: "single traversal", value: "../escape" },
      { label: "multi traversal", value: "../../customer-a" },
      { label: "repeated dots and dashes", value: "...---tenant---..." },
      { label: "unicode", value: "中文 profile" },
      { label: "long", value: "a".repeat(81) },
    ];
    for (const { label, value } of cases) {
      assert.equal(
        resolveProfileName(value),
        sanitizeStateProfile(value),
        label,
      );
    }
  });

  /**
   * The guard exists so two *runtimes* cannot share one profile, which is what
   * its own error message tells the reader to fix. `shared` is not a runtime: it
   * is what the resolver returns when it could not identify one. Refusing to
   * sharpen an unidentified family into an identified one would make correct
   * detection a breaking change — the repo's own `default` profile was written
   * as `shared` while Claude markers went unread, so the first run after
   * detection improves would have died on a collision instead of recording the
   * runtime it finally knew.
   */
  test("an unidentified profile family is sharpened by a runtime that can name itself", async () => {
    const profile = `sharpen-${process.pid}-${Date.now()}`;
    const paths = getProfilePaths({ profile, runtimeFamily: "claude" });
    try {
      const seeded = await ensureProfileState({ profile, runtimeFamily: SHARED_RUNTIME_FAMILY });
      assert.equal(seeded.metadata.runtimeFamily, SHARED_RUNTIME_FAMILY);

      const sharpened = await ensureProfileState({ profile, runtimeFamily: "claude" });
      assert.equal(sharpened.metadata.runtimeFamily, "claude");
      assert.equal(sharpened.metadata.profileKey, paths.profileKey);
      assert.equal(
        sharpened.metadata.createdAt,
        seeded.metadata.createdAt,
        "sharpening records the runtime without presenting the profile as newly created",
      );
    } finally {
      await fs.rm(paths.profileDir, { recursive: true, force: true });
    }
  });

  /**
   * The reverse must not erase what is already proven. A process that cannot see
   * its own markers knows less than the record does, so treating its `shared`
   * result as an update would let one unidentified run downgrade a profile that
   * a previous identified run had labelled correctly.
   */
  test("a run that cannot identify its runtime keeps the family already recorded", async () => {
    const profile = `preserve-${process.pid}-${Date.now()}`;
    const paths = getProfilePaths({ profile, runtimeFamily: "codex" });
    try {
      await ensureProfileState({ profile, runtimeFamily: "codex" });
      const later = await ensureProfileState({ profile, runtimeFamily: SHARED_RUNTIME_FAMILY });
      assert.equal(later.metadata.runtimeFamily, "codex");
      assert.equal(later.metadata.profileKey, paths.profileKey);
    } finally {
      await fs.rm(paths.profileDir, { recursive: true, force: true });
    }
  });

  test("profile state refuses a second identified runtime before overwriting metadata", async () => {
    const profile = `collision-${process.pid}-${Date.now()}`;
    const paths = getProfilePaths({ profile, runtimeFamily: "claude" });
    try {
      await ensureProfileState({ profile, runtimeFamily: "claude" });
      await assert.rejects(
        ensureProfileState({ profile, runtimeFamily: "codex" }),
        /profile collision detected/,
      );
      const metadata = JSON.parse(await fs.readFile(paths.profileFile, "utf8"));
      assert.equal(metadata.runtimeFamily, "claude");
    } finally {
      await fs.rm(paths.profileDir, { recursive: true, force: true });
    }
  });

  /**
   * The governance doctor asks this same question through a different function,
   * and it asks first — so a difference the writer reconciles without complaint
   * still fails the gate if the reporter calls it a collision. Two answers to one
   * question is how the repo's own `default` profile would keep failing
   * `meta:doctor:governance` after the writer stopped rejecting it.
   */
  test("the collision report agrees with what writing the profile would actually do", async () => {
    const profile = `agree-${process.pid}-${Date.now()}`;
    const paths = getProfilePaths({ profile, runtimeFamily: "claude" });
    try {
      await ensureProfileState({ profile, runtimeFamily: SHARED_RUNTIME_FAMILY });
      const reconcilable = await detectProfileCollision({ profile, runtimeFamily: "claude" });
      assert.deepEqual(
        reconcilable.mismatches,
        [],
        "a runtime naming itself over an unidentified record is what the writer accepts",
      );
      assert.equal(reconcilable.collision, false);

      await ensureProfileState({ profile, runtimeFamily: "claude" });
      const genuine = await detectProfileCollision({ profile, runtimeFamily: "codex" });
      assert.deepEqual(genuine.mismatches, ["runtimeFamily"]);
      assert.equal(
        genuine.collision,
        true,
        "two runtimes that can both name themselves are the collision the gate exists for",
      );
    } finally {
      await fs.rm(paths.profileDir, { recursive: true, force: true });
    }
  });

  /**
   * The repo-path half was compared against this module's own repo root rather
   * than the root the caller asked about, so every profile living outside the
   * repo — the global one included — read as a repo mismatch. Nothing calls it
   * that way today, which is exactly why the wrong reference survived.
   */
  test("a profile rooted outside the repo is not reported as a repo mismatch", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "metakim-elsewhere-"));
    const foreignRepo = await fs.mkdtemp(path.join(os.tmpdir(), "metakim-foreign-repo-"));
    try {
      const options = { profile: "default", repoPath: foreignRepo, stateRoot };
      await ensureProfileState({ ...options, runtimeFamily: "claude" });
      const report = await detectProfileCollision({ ...options, runtimeFamily: "claude" });
      assert.deepEqual(report.mismatches, []);
      assert.equal(report.collision, false);
    } finally {
      await fs.rm(stateRoot, { recursive: true, force: true });
      await fs.rm(foreignRepo, { recursive: true, force: true });
    }
  });

  test("public capability-gap commands resolve outputs through the active profile", async () => {
    for (const fileName of [
      "run-capability-gap-orchestration.mjs",
      "run-capability-gap-codex-real-test.mjs",
      "run-capability-gap-isolated-report.mjs",
    ]) {
      const source = await fs.readFile(path.join(process.cwd(), "scripts", fileName), "utf8");
      assert.match(source, /getProfilePaths/);
      assert.doesNotMatch(source, /\.meta-kim\/state\/default/);
    }
  });
});
