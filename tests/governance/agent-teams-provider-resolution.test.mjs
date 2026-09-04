import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runMetaTheoryGovernedExecution } from "../../scripts/run-meta-theory-governed-execution.mjs";

async function runFor(runtime, { dependencyRoots = null } = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), `meta-kim-agent-teams-${runtime}-`));
  const previousDependencyRoots = process.env.META_KIM_DEP_ROOTS;
  if (dependencyRoots !== null) process.env.META_KIM_DEP_ROOTS = dependencyRoots;
  try {
    const report = await runMetaTheoryGovernedExecution({
      task: "meta-theory 检查 Codex runtime 和 Claude Code runtime 的并行编排契约",
      runId: `agent-teams-provider-${runtime}`,
      stateDir,
      dbPath: path.join(stateDir, "runs.sqlite"),
      runtime,
      osTarget: "windows",
    });
    return report.coreLoop.agentTeamsPlaybookPacket.providerResolution;
  } finally {
    if (dependencyRoots !== null) {
      if (previousDependencyRoots === undefined) delete process.env.META_KIM_DEP_ROOTS;
      else process.env.META_KIM_DEP_ROOTS = previousDependencyRoots;
    }
    await rm(stateDir, { recursive: true, force: true });
  }
}

/**
 * Discovery resolves to the nearest declared candidate that exists, and to
 * nothing at all when none of them do.
 *
 * A literal source pinned here pins the maintainer's disk instead of the
 * contract. `sibling_dependency_checkout` resolves to `../agent-teams-playbook`,
 * so it is found on a machine that keeps the upstream package cloned beside this
 * repository and absent on one that does not: measured on this host it reports
 * `"sibling_dependency_checkout"` at version `4.8.0`, and on a host without that
 * sibling the very same code correctly reports `null`. Both literals are true
 * somewhere and neither is a property of the code, so asserting either one makes
 * the suite pass or fail on where it is run.
 *
 * The precedence rule is the part that holds on every disk, and it is the rule
 * the ordered candidate list exists to express: a farther candidate may never win
 * over a nearer one, and the reported version must belong to whichever candidate
 * won rather than to some other entry. Because this recomputes the production
 * rule it can only catch that rule changing, so the literal outcome is pinned
 * separately below, against a dependency root the test plants itself.
 */
function assertNearestFoundCandidateWins(resolution) {
  const nearestFound = resolution.candidates.find((candidate) => candidate.found) ?? null;
  assert.equal(resolution.selectedSource, nearestFound?.source ?? null);
  assert.equal(resolution.selectedVersion, nearestFound?.version ?? null);
  assert.equal(resolution.found, nearestFound !== null);
}

test("Codex discovers the local upstream checkout before a stale global package without selecting the optional adapter", async () => {
  const resolution = await runFor("codex");
  assert.equal(resolution.runtime, "codex");
  assert.equal(resolution.candidates[0].source, "project_codex_skill");
  assert.ok(
    resolution.candidates.findIndex((candidate) => candidate.source === "sibling_dependency_checkout") <
      resolution.candidates.findIndex((candidate) => candidate.source === "codex_global_skill"),
  );
  assertNearestFoundCandidateWins(resolution);
});

test("Claude Code discovers Claude-native roots and the local upstream contract without selecting the optional adapter", async () => {
  const resolution = await runFor("claude_code");
  assert.equal(resolution.runtime, "claude_code");
  assert.equal(resolution.candidates[0].source, "project_claude_skill");
  assert.ok(resolution.candidates.some((candidate) => candidate.source === "claude_global_skill"));
  assert.equal(resolution.candidates.some((candidate) => candidate.source === "codex_global_skill"), false);
  assertNearestFoundCandidateWins(resolution);
});

test("discovery prefers a declared dependency root over the sibling checkout and the global package", async (t) => {
  const dependencyRoot = await mkdtemp(path.join(os.tmpdir(), "meta-kim-agent-teams-dep-root-"));
  t.after(() => rm(dependencyRoot, { recursive: true, force: true }));
  await mkdir(path.join(dependencyRoot, "agent-teams-playbook"), { recursive: true });
  // 9.9.9-fixture cannot collide with a shipped version, so re-hardcoding the
  // selected version back to a real one cannot satisfy this assertion.
  await writeFile(
    path.join(dependencyRoot, "agent-teams-playbook", "SKILL.md"),
    "---\nname: agent-teams-playbook\nversion: 9.9.9-fixture\n---\n\n# fixture provider\n",
    "utf8",
  );

  for (const [runtime, globalSource] of [
    ["codex", "codex_global_skill"],
    ["claude_code", "claude_global_skill"],
  ]) {
    const resolution = await runFor(runtime, { dependencyRoots: dependencyRoot });
    assert.equal(resolution.selectedSource, "env_dependency_root_1", runtime);
    assert.equal(resolution.selectedVersion, "9.9.9-fixture", runtime);
    assert.equal(resolution.found, true, runtime);
    // The planted root is declared ahead of both farther sources, so a
    // nearest-wins rule has to report it by name. Measured: with this host's
    // sibling checkout also present, inverting the rule to farthest-wins reports
    // sibling_dependency_checkout here and fails.
    assertNearestFoundCandidateWins(resolution);
    const plantedIndex = resolution.candidates.findIndex(
      (candidate) => candidate.source === "env_dependency_root_1",
    );
    for (const fartherSource of ["sibling_dependency_checkout", globalSource]) {
      const fartherIndex = resolution.candidates.findIndex(
        (candidate) => candidate.source === fartherSource,
      );
      assert.ok(fartherIndex >= 0, `${runtime} must still declare ${fartherSource}`);
      assert.ok(
        plantedIndex < fartherIndex,
        `${runtime} must search the declared dependency root before ${fartherSource}`,
      );
    }
  }
});
