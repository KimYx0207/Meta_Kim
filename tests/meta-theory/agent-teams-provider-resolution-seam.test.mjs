import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
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
// governed run's orchestration evidence. Hermetic mode suppresses that read
// without withdrawing the declaration, because the ordered candidate list is
// itself a contract (tests/governance/agent-teams-provider-resolution.test.mjs
// asserts where the sibling sits relative to the env roots and the
// runtime-global root). The seam pins all three directions: the candidate stays
// declared in both modes, its probe result is withheld in hermetic mode, and a
// planted META_KIM_DEP_ROOTS fixture is still discovered and selected.

describe("agent-teams provider resolution seam", () => {
  test("the sibling dependency probe is part of the candidate list by default", () => {
    // The meta-theory suite runner (scripts/run-node-tests.mjs) injects
    // META_KIM_DISABLE_SIBLING_DEP_PROBE=1 for hermeticity; this case pins
    // the DEFAULT behavior, so it must lift that injection locally.
    const previous = process.env.META_KIM_DISABLE_SIBLING_DEP_PROBE;
    delete process.env.META_KIM_DISABLE_SIBLING_DEP_PROBE;
    try {
      const candidates = agentTeamsCandidateSkillPaths("claude_code");
      const sibling = candidates.find(
        (candidate) => candidate.source === "sibling_dependency_checkout",
      );
      assert.ok(sibling, "default discovery must keep observing the sibling checkout");
      assert.equal(sibling.probeSuppressed, false);
    } finally {
      if (previous !== undefined) process.env.META_KIM_DISABLE_SIBLING_DEP_PROBE = previous;
    }
  });

  test("META_KIM_DISABLE_SIBLING_DEP_PROBE=1 withholds the sibling probe result but keeps it declared", async (t) => {
    const previous = process.env.META_KIM_DISABLE_SIBLING_DEP_PROBE;
    const previousRoots = process.env.META_KIM_DEP_ROOTS;
    process.env.META_KIM_DISABLE_SIBLING_DEP_PROBE = "1";
    process.env.META_KIM_DEP_ROOTS = "";
    try {
      const candidates = agentTeamsCandidateSkillPaths("claude_code");
      const sibling = candidates.find(
        (candidate) => candidate.source === "sibling_dependency_checkout",
      );
      assert.ok(sibling, "the sibling candidate must stay declared under the seam");
      assert.equal(sibling.probeSuppressed, true);
      const siblingIndex = candidates.indexOf(sibling);
      const globalIndex = candidates.findIndex(
        (candidate) => candidate.source === "claude_global_skill",
      );
      assert.ok(
        globalIndex < 0 || siblingIndex < globalIndex,
        "the seam must not reorder the search",
      );
      assert.ok(
        candidates.some((candidate) => candidate.source === "canonical_skill"),
        "in-repo candidates must survive the seam",
      );

      const resolution = await resolveAgentTeamsPlaybookProvider("claude_code");
      const resolved = resolution.candidates.find(
        (candidate) => candidate.source === "sibling_dependency_checkout",
      );
      assert.ok(resolved, "the resolution must still report the sibling candidate");
      assert.equal(resolved.probeSuppressed, true);
      assert.equal(resolved.found, false);
      assert.equal(resolved.version, null);
      assert.notEqual(resolution.selectedSource, "sibling_dependency_checkout");

      // Withholding is only observable where the sibling actually exists: on a
      // host without it, a suppressed and an unsuppressed read both report
      // absent, so deleting the suppression would survive there. Record which
      // case this host measured instead of implying the stronger one.
      const siblingOnDisk = await stat(sibling.filePath).then(
        () => true,
        () => false,
      );
      t.diagnostic(
        siblingOnDisk
          ? "sibling checkout present: the withheld read is the measured signal here"
          : "no sibling checkout on this host: the withheld-read leg is not observable",
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
