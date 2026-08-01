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

  test("profile state refuses a second runtime family before overwriting metadata", async () => {
    const profile = `collision-${process.pid}-${Date.now()}`;
    const paths = getProfilePaths({ profile, runtimeFamily: "shared" });
    try {
      await ensureProfileState({ profile, runtimeFamily: "shared" });
      await assert.rejects(
        ensureProfileState({ profile, runtimeFamily: "codex" }),
        /profile collision detected/,
      );
      const metadata = JSON.parse(await fs.readFile(paths.profileFile, "utf8"));
      assert.equal(metadata.runtimeFamily, "shared");
    } finally {
      await fs.rm(paths.profileDir, { recursive: true, force: true });
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
