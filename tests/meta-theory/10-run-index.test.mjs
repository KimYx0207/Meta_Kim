import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { REPO_ROOT } from "./_helpers.mjs";

const execFileAsync = promisify(execFile);

describe("run-index.mjs", () => {
  const profile = `test-run-index-${process.pid}`;
  const profileDir = path.join(REPO_ROOT, ".meta-kim", "state", profile);
  let isolatedHome;
  const validFixture = path.join(REPO_ROOT, "tests", "fixtures", "run-artifacts", "valid-run.json");
  const invalidFixture = path.join(REPO_ROOT, "tests", "fixtures", "run-artifacts", "invalid-run-public-ready.json");
  const invalidCompactionFixture = path.join(
    REPO_ROOT,
    "tests",
    "fixtures",
    "run-artifacts",
    "invalid-run-compaction-open-findings.json"
  );

  before(async () => {
    isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-run-index-home-"));
  });
  after(async () => {
    await fs.rm(profileDir, { recursive: true, force: true });
    if (isolatedHome) await fs.rm(isolatedHome, { recursive: true, force: true });
  });

  async function runRunIndex(args) {
    const { stdout } = await execFileAsync("node", ["scripts/run-index.mjs", ...args], {
      cwd: REPO_ROOT,
      // Profile setup also opens the global project registry. Keep that real
      // SQLite path isolated rather than mutating the developer's home state.
      env: { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome },
    });
    return JSON.parse(stdout);
  }

  test("rebuild indexes only validated artifacts", async () => {
    await fs.rm(profileDir, { recursive: true, force: true });
    const result = await runRunIndex([
      "rebuild",
      validFixture,
      invalidFixture,
      invalidCompactionFixture,
      "--profile",
      profile,
      "--runtime-family",
      "codex",
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "rebuild");
    assert.equal(result.indexedCount, 1);
    assert.equal(result.skippedCount, 2);
    assert.deepEqual(result.indexed, ["tests/fixtures/run-artifacts/valid-run.json"]);
    assert.equal((await fs.stat(path.join(profileDir, "run-index.sqlite"))).isFile(), true);
    assert.equal((await fs.stat(path.join(isolatedHome, ".meta-kim", "global", "project-registry.sqlite"))).isFile(), true);
  });

  test("query filters by governance flow, owner, publicReady, and open findings", async () => {
    for (const owner of [
      "meta-conductor",
      "meta-warden",
    ]) {
      const result = await runRunIndex([
        "query",
        "--profile",
        profile,
        "--runtime-family",
        "codex",
        "--governance-flow",
        "complex_dev",
        "--owner",
        owner,
        "--public-ready",
        "true",
        "--open-findings",
        "false",
      ]);

      assert.equal(result.ok, true);
      assert.equal(result.count, 1, `expected one row for owner ${owner}`);
      assert.equal(result.rows[0].artifactPath, "tests/fixtures/run-artifacts/valid-run.json");
      assert.equal(result.rows[0].governanceFlow, "complex_dev");
      assert.equal(result.rows[0].publicReady, true);
      assert.equal(result.rows[0].openFindingsCount, 0);
      assert.ok(result.rows[0].ownerAgents.includes(owner));
      assert.ok(!result.rows[0].ownerAgents.includes("backend"));
      assert.ok(result.rows[0].payload.businessRoles.includes("backend"));
      assert.ok(result.rows[0].payload.matchedSkillProviders.includes("meta-theory"));
      assert.ok(result.rows[0].payload.matchedSkillIds.includes("local-project-code-change"));
      assert.equal(result.rows[0].payload.taskClassification.queryScope, "current_project");
      assert.equal(result.rows[0].payload.fetchPacket.projectsChecked.length, 1);
      assert.deepEqual(result.rows[0].payload.summaryPacket.sourceProjects, [
        result.rows[0].payload.taskClassification.projectRef,
      ]);
    }
  });

  test("query does not treat business role labels as owners", async () => {
    const result = await runRunIndex([
      "query",
      "--profile",
      profile,
      "--runtime-family",
      "codex",
      "--owner",
      "backend",
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.count, 0);
  });
});
