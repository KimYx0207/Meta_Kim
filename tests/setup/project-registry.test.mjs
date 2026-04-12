import { describe, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import {
  buildProjectRef,
  detectProjectRegistryEntry,
  getProjectRegistryPaths,
  joinProjectRegistry,
  readProjectRegistryEntry,
  skipProjectRegistry,
} from "../../scripts/project-registry.mjs";

describe("project registry", () => {
  test("unknown project resolves to prompt_join with machine-global registry path", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-home-"));
    const repoPath = path.join(homeDir, "workspaces", "alpha");

    const paths = getProjectRegistryPaths({ homeDir });
    assert.equal(
      paths.projectRegistryPath,
      path.join(homeDir, ".meta-kim", "global", "project-registry.sqlite"),
    );

    const status = await detectProjectRegistryEntry({ homeDir, repoPath });
    assert.equal(status.registryStatus, "prompt_join");
    assert.equal(status.known, false);
    assert.equal(status.projectRef, buildProjectRef({ repoPath }));
  });

  test("joinProjectRegistry persists joined projects, platform rows, and source rows", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-home-"));
    const repoPath = path.join(homeDir, "workspaces", "beta");

    const joined = await joinProjectRegistry({
      homeDir,
      repoPath,
      runtimeFamily: "codex",
      sourceType: "meta_architecture",
      sourceRef: "meta-kim-runtime",
    });
    assert.equal(joined.registryStatus, "joined");

    const detected = await detectProjectRegistryEntry({
      homeDir,
      repoPath,
      runtimeFamily: "codex",
    });
    assert.equal(detected.registryStatus, "known");
    assert.equal(detected.known, true);

    const entry = await readProjectRegistryEntry({ homeDir, repoPath });
    assert.equal(entry.project.projectRef, buildProjectRef({ repoPath }));
    assert.equal(entry.project.enrollmentStatus, "joined");
    assert.equal(entry.platforms.length, 1);
    assert.equal(entry.platforms[0].platform, "codex");
    assert.equal(entry.platforms[0].status, "active");
    assert.equal(entry.sources.length, 1);
    assert.equal(entry.sources[0].sourceType, "meta_architecture");
    assert.equal(entry.sources[0].sourceRef, "meta-kim-runtime");
  });

  test("skipProjectRegistry persists a no-join decision", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-home-"));
    const repoPath = path.join(homeDir, "workspaces", "gamma");

    const skipped = await skipProjectRegistry({ homeDir, repoPath });
    assert.equal(skipped.registryStatus, "skipped");

    const detected = await detectProjectRegistryEntry({ homeDir, repoPath });
    assert.equal(detected.registryStatus, "skipped");
    assert.equal(detected.known, false);
  });
});
