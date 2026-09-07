import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  agentTeamsCandidateSkillPaths,
  resolveAgentTeamsPlaybookProvider,
} from "../../scripts/run-meta-theory-governed-execution.mjs";

// The provider resolution must be hermetic when a validator asks for it: the
// sibling_dependency_checkout probe reads the maintainer's disk beside the
// repo, so a machine that happens to keep a checkout there must not change a
// governed run's orchestration evidence. The seam pins both directions: with
// the probe disabled no sibling candidate is considered, and with a planted
// META_KIM_DEP_ROOTS fixture the env root is still discovered and selected.

describe("agent-teams provider resolution seam", () => {
  test("the sibling dependency probe is part of the candidate list by default", () => {
    // The meta-theory suite runner (scripts/run-node-tests.mjs) injects
    // META_KIM_DISABLE_SIBLING_DEP_PROBE=1 for hermeticity; this case pins
    // the DEFAULT behavior, so it must lift that injection locally.
    const previous = process.env.META_KIM_DISABLE_SIBLING_DEP_PROBE;
    delete process.env.META_KIM_DISABLE_SIBLING_DEP_PROBE;
    try {
      const candidates = agentTeamsCandidateSkillPaths("claude_code");
      assert.ok(
        candidates.some((candidate) => candidate.source === "sibling_dependency_checkout"),
        "default discovery must keep observing the sibling checkout",
      );
    } finally {
      if (previous !== undefined) process.env.META_KIM_DISABLE_SIBLING_DEP_PROBE = previous;
    }
  });

  test("META_KIM_DISABLE_SIBLING_DEP_PROBE=1 removes only the sibling candidate", async () => {
    const previous = process.env.META_KIM_DISABLE_SIBLING_DEP_PROBE;
    const previousRoots = process.env.META_KIM_DEP_ROOTS;
    process.env.META_KIM_DISABLE_SIBLING_DEP_PROBE = "1";
    process.env.META_KIM_DEP_ROOTS = "";
    try {
      const candidates = agentTeamsCandidateSkillPaths("claude_code");
      assert.ok(
        !candidates.some((candidate) => candidate.source === "sibling_dependency_checkout"),
        "the sibling probe must be absent when the seam is armed",
      );
      assert.ok(
        candidates.some((candidate) => candidate.source === "canonical_skill"),
        "in-repo candidates must survive the seam",
      );
      const resolution = await resolveAgentTeamsPlaybookProvider("claude_code");
      assert.equal(
        resolution.candidates.some((candidate) => candidate.source === "sibling_dependency_checkout"),
        false,
      );
    } finally {
      if (previous === undefined) delete process.env.META_KIM_DISABLE_SIBLING_DEP_PROBE;
      else process.env.META_KIM_DISABLE_SIBLING_DEP_PROBE = previous;
      if (previousRoots === undefined) delete process.env.META_KIM_DEP_ROOTS;
      else process.env.META_KIM_DEP_ROOTS = previousRoots;
    }
  });

  test("a planted META_KIM_DEP_ROOTS fixture is discovered even with the sibling probe disabled", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-atp-seam-"));
    const previous = process.env.META_KIM_DISABLE_SIBLING_DEP_PROBE;
    const previousRoots = process.env.META_KIM_DEP_ROOTS;
    process.env.META_KIM_DISABLE_SIBLING_DEP_PROBE = "1";
    process.env.META_KIM_DEP_ROOTS = tempDir;
    try {
      await mkdir(path.join(tempDir, "agent-teams-playbook"), { recursive: true });
      await writeFile(
        path.join(tempDir, "agent-teams-playbook", "SKILL.md"),
        "---\nname: agent-teams-playbook\nversion: 9.9.9-seam\n---\nplanted fixture\n",
        "utf8",
      );
      const resolution = await resolveAgentTeamsPlaybookProvider("claude_code");
      assert.equal(resolution.found, true, "the planted env root must be found");
      assert.equal(resolution.selectedSource, "env_dependency_root_1");
      assert.equal(resolution.selectedVersion, "9.9.9-seam");
    } finally {
      if (previous === undefined) delete process.env.META_KIM_DISABLE_SIBLING_DEP_PROBE;
      else process.env.META_KIM_DISABLE_SIBLING_DEP_PROBE = previous;
      if (previousRoots === undefined) delete process.env.META_KIM_DEP_ROOTS;
      else process.env.META_KIM_DEP_ROOTS = previousRoots;
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
