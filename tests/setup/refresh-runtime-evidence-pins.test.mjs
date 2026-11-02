import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  digestRepositorySource,
  repositorySourcePath,
} from "../../scripts/runtime-capability-evidence.mjs";
import {
  REFRESH_PINS_SCRIPT,
  RUNTIME_CAPABILITY_EVIDENCE_PATH,
  refreshRuntimeEvidencePins,
  renderRuntimeEvidenceLedger,
} from "../../scripts/refresh-runtime-evidence-pins.mjs";
import { resolveNpmCliJsPath } from "../../scripts/runtime-cli-invocation.mjs";
import { createGovernanceRuntimeFixture } from "../helpers/governance-runtime-fixture.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The repo_projection pins are the only perishable part of the evidence
 * ledger: editing a pinned source silently invalidates the ledger. The
 * refresh command turns that into one official, reviewable action.
 *
 * Fixtures start from the committed ledger, then recompute every repo pin so
 * the test stays deterministic no matter which sources the working tree is
 * currently editing. Exactly one pin is then corrupted, and the command must
 * repair that pin and nothing else.
 */
function buildFixture(root, { corrupt } = {}) {
  const committed = JSON.parse(readFileSync(
    path.join(REPO_ROOT, RUNTIME_CAPABILITY_EVIDENCE_PATH),
    "utf8",
  ));
  const target = committed.observations.find((entry) =>
    entry.observationClass === "repo_projection" &&
    entry.sourceArtifacts.some((artifact) => artifact.path === corrupt),
  );
  assert.ok(target, `fixture must pin ${corrupt}`);
  for (const observation of committed.observations) {
    if (observation.observationClass !== "repo_projection") continue;
    for (const artifact of observation.sourceArtifacts) {
      const sourcePath = repositorySourcePath(artifact.path);
      assert.ok(sourcePath, `pinned source must resolve: ${artifact.path}`);
      artifact.sha256 = digestRepositorySource(sourcePath).toLowerCase();
    }
  }
  const corruptedBefore = target.sourceArtifacts.find(
    (artifact) => artifact.path === corrupt,
  );
  const originalSha256 = corruptedBefore.sha256;
  corruptedBefore.sha256 = "0".repeat(64);
  const fixturePath = path.join(root, "runtime-capability-evidence.json");
  writeFileSync(fixturePath, `${renderRuntimeEvidenceLedger(committed)}`, "utf8");
  return { fixturePath, committed, originalSha256, observationId: target.id };
}

function runRefresh(args) {
  return spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, REFRESH_PINS_SCRIPT), ...args],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 },
  );
}

test("refresh repairs a deliberately wrong pin and changes nothing else", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-pins-refresh-"));
  try {
    const { fixturePath, committed, originalSha256, observationId } =
      buildFixture(root, { corrupt: "setup.mjs" });
    const before = readFileSync(fixturePath, "utf8");

    const result = runRefresh(["--file", fixturePath]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`${observationId}  setup\\.mjs  0{64} -> ${originalSha256}`));

    const after = readFileSync(fixturePath, "utf8");
    const parsedAfter = JSON.parse(after);

    // Structure and field order survive untouched; only the corrupted pin moved.
    const expectedLedger = structuredClone(committed);
    expectedLedger.observations
      .find((entry) => entry.id === observationId)
      .sourceArtifacts.find((artifact) => artifact.path === "setup.mjs").sha256 = originalSha256;
    assert.deepEqual(parsedAfter, expectedLedger);
    assert.equal(
      after,
      before.replaceAll("0".repeat(64), originalSha256),
      "the written file must differ from the input only in the repaired pin",
    );

    // --check is clean after a refresh.
    const check = runRefresh(["--file", fixturePath, "--check"]);
    assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
    assert.match(check.stdout, /pins are current/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--check reports drift without writing and exits 1", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-pins-check-"));
  try {
    const { fixturePath, observationId, originalSha256 } =
      buildFixture(root, { corrupt: "setup.mjs" });
    const before = readFileSync(fixturePath, "utf8");

    const check = runRefresh(["--file", fixturePath, "--check"]);
    assert.equal(check.status, 1, `${check.stdout}\n${check.stderr}`);
    assert.match(check.stdout, new RegExp(`${observationId}  setup\\.mjs  0{64} -> ${originalSha256}`));
    assert.equal(readFileSync(fixturePath, "utf8"), before, "--check must not write");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed JSON fails closed with a clear error and no partial write", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-pins-malformed-"));
  try {
    const fixturePath = path.join(root, "runtime-capability-evidence.json");
    const malformed = `{"observations": [ {"id": "x", oops\n`;
    writeFileSync(fixturePath, malformed, "utf8");

    for (const extraArgs of [[], ["--check"]]) {
      const result = runRefresh(["--file", fixturePath, ...extraArgs]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /is not valid JSON/u);
      assert.match(result.stderr, /nothing was written/iu);
      assert.equal(readFileSync(fixturePath, "utf8"), malformed);
      assert.equal(readdirSync(root).length, 1, "no temporary files may survive a failed run");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pinned source outside the repository allowlist fails closed", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-pins-allowlist-"));
  try {
    const { fixturePath, committed } = buildFixture(root, { corrupt: "setup.mjs" });
    committed.observations
      .find((entry) => entry.observationClass === "repo_projection")
      .sourceArtifacts.push({ path: "outside/allowlist.txt", digestKind: "sha256", sha256: "0".repeat(64) });
    writeFileSync(fixturePath, renderRuntimeEvidenceLedger(committed), "utf8");
    const before = readFileSync(fixturePath, "utf8");

    const result = runRefresh(["--file", fixturePath]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside the repository evidence allowlist/u);
    assert.equal(readFileSync(fixturePath, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-repo_projection observations never trigger a recompute", () => {
  const ledger = {
    observations: [
      {
        id: "official.docs.example",
        observationClass: "official_docs",
        sourceArtifacts: [
          { path: "setup.mjs", digestKind: "sha256", sha256: "0".repeat(64) },
        ],
      },
    ],
  };
  const { ledger: next, changes } = refreshRuntimeEvidencePins(ledger);
  assert.deepEqual(changes, []);
  assert.deepEqual(next, ledger);
});

test("source maintenance repairs stale pins before projection and is idempotent", (t) => {
  const runtime = createGovernanceRuntimeFixture(t);
  const control = runtime.run([REFRESH_PINS_SCRIPT]);
  assert.equal(control.status, 0, control.stderr || control.stdout);
  const ledgerFile = path.join(runtime.repoRoot, RUNTIME_CAPABILITY_EVIDENCE_PATH);
  const before = JSON.parse(readFileSync(ledgerFile, "utf8"));
  appendFileSync(path.join(runtime.repoRoot, "AGENTS.md"), "\nSource-only lifecycle fixture change.\n");
  const stale = runtime.run([REFRESH_PINS_SCRIPT, "--check"]);
  assert.equal(stale.status, 1);
  const blocked = runtime.run(["scripts/select-execution-route.mjs", "--task", "Implement backend API pagination.", "--runtime", "codex", "--os", "windows", "--json"]);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /AGENTS\.md SHA-256 mismatch/u);

  // Exercise the maintained npm entry, not a test-side repair of the new drift.
  const args = [resolveNpmCliJsPath(), "run", "meta:sync", "--", "--targets", "codex"];
  const prepared = runtime.run(args);
  assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
  const current = runtime.run([REFRESH_PINS_SCRIPT, "--check"]);
  assert.equal(current.status, 0, current.stderr || current.stdout);
  const afterText = readFileSync(ledgerFile, "utf8");
  const expected = structuredClone(before);
  for (const observation of expected.observations) {
    if (observation.observationClass !== "repo_projection") continue;
    for (const artifact of observation.sourceArtifacts) {
      if (artifact.path === "AGENTS.md") artifact.sha256 = digestRepositorySource(path.join(runtime.repoRoot, "AGENTS.md"));
    }
  }
  assert.deepEqual(JSON.parse(afterText), expected, "maintenance changes source pins only, never dates or host/live facts");
  const consumer = runtime.run(["scripts/select-execution-route.mjs", "--task", "Implement backend API pagination.", "--runtime", "codex", "--os", "windows", "--json"]);
  assert.equal(consumer.status, 0, consumer.stderr || consumer.stdout);
  const repeated = runtime.run(args);
  assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
  assert.equal(readFileSync(ledgerFile, "utf8"), afterText);
});

test("source maintenance help, check, reverse preview and installed roots never repair pins", (t) => {
  const runtime = createGovernanceRuntimeFixture(t);
  assert.equal(runtime.run([REFRESH_PINS_SCRIPT]).status, 0);
  appendFileSync(path.join(runtime.repoRoot, "AGENTS.md"), "\nRead-only lifecycle fixture.\n");
  const ledger = path.join(runtime.repoRoot, RUNTIME_CAPABILITY_EVIDENCE_PATH);
  const before = readFileSync(ledger, "utf8");
  const base = ["scripts/sync-runtimes.mjs", "--refresh-source-pins", "--targets", "codex"];
  for (const [args, status] of [[ ["--help"], 0 ], [ ["--check"], 1 ], [ ["--reverse"], 0 ], [ ["--reverse", "--dry-run"], 0 ]]) {
    const result = runtime.run([...base, ...args]);
    assert.equal(result.status, status, result.stderr || result.stdout);
    assert.equal(readFileSync(ledger, "utf8"), before, args.join(" "));
  }
  rmSync(path.join(runtime.repoRoot, ".git"), { recursive: true, force: true });
  const installed = runtime.run(base);
  assert.notEqual(installed.status, 0);
  assert.match(installed.stderr, /requires a Meta_Kim source checkout/u);
  assert.equal(readFileSync(ledger, "utf8"), before);
});

test("source maintenance refuses a different configured source root before any writes", (t) => {
  const runtime = createGovernanceRuntimeFixture(t);
  assert.equal(runtime.run([REFRESH_PINS_SCRIPT]).status, 0);
  const otherRoot = path.join(runtime.root, "other-repo");
  cpSync(runtime.repoRoot, otherRoot, { recursive: true });
  rmSync(path.join(runtime.repoRoot, ".git"), { recursive: true });
  appendFileSync(path.join(runtime.repoRoot, "AGENTS.md"), "\nExecuting installed-like package drift.\n");
  appendFileSync(path.join(otherRoot, "AGENTS.md"), "\nDifferent source checkout drift.\n");
  appendFileSync(path.join(otherRoot, "canonical/agents/meta-warden.md"), "\nOther source projection fixture.\n");
  const snapshot = (root) => ({
    ledger: readFileSync(path.join(root, RUNTIME_CAPABILITY_EVIDENCE_PATH), "utf8"),
    manifest: readFileSync(path.join(root, ".meta-kim/install-manifest.json"), "utf8"),
    projection: readFileSync(path.join(root, ".codex/agents/meta-warden.toml"), "utf8"),
  });
  const executingBefore = snapshot(runtime.repoRoot);
  const otherBefore = snapshot(otherRoot);
  const args = ["scripts/sync-runtimes.mjs", "--refresh-source-pins", "--targets", "codex"];
  const env = { ...runtime.env, META_KIM_REPO_ROOT: otherRoot };
  for (const extraArgs of [[], ["--check"], ["--reverse"], ["--reverse", "--dry-run"]]) {
    const result = runtime.run([...args, ...extraArgs], { env });
    const executingAfter = snapshot(runtime.repoRoot);
    const otherAfter = snapshot(otherRoot);
    t.diagnostic(JSON.stringify({
      args: extraArgs,
      status: result.status,
      executingLedgerUnchanged: executingAfter.ledger === executingBefore.ledger,
      otherLedgerUnchanged: otherAfter.ledger === otherBefore.ledger,
      executingManifestUnchanged: executingAfter.manifest === executingBefore.manifest,
      otherManifestUnchanged: otherAfter.manifest === otherBefore.manifest,
    }));
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /Source pin maintenance requires the configured source root to match the executing package root/u);
    assert.deepEqual(executingAfter, executingBefore);
    assert.deepEqual(otherAfter, otherBefore);
  }

  // The raw installer override remains independent of source maintenance.
  const raw = runtime.run(["scripts/sync-runtimes.mjs", "--targets", "codex"], { env });
  assert.equal(raw.status, 0, raw.stderr || raw.stdout);
  assert.deepEqual(snapshot(runtime.repoRoot), executingBefore);
  const otherAfterRaw = snapshot(otherRoot);
  assert.equal(otherAfterRaw.ledger, otherBefore.ledger);
  assert.match(otherAfterRaw.projection, /Other source projection fixture/u);
  assert.notEqual(otherAfterRaw.manifest, otherBefore.manifest);
});

test("source maintenance accepts an equivalent explicit source root", (t) => {
  const runtime = createGovernanceRuntimeFixture(t);
  assert.equal(runtime.run([REFRESH_PINS_SCRIPT]).status, 0);
  appendFileSync(path.join(runtime.repoRoot, "AGENTS.md"), "\nEquivalent root lifecycle fixture.\n");
  const equivalentRoot = `${runtime.repoRoot}${path.sep}scripts${path.sep}..${path.sep}`;
  const env = {
    ...runtime.env,
    META_KIM_REPO_ROOT: process.platform === "win32" ? equivalentRoot.toUpperCase() : equivalentRoot,
  };
  const args = ["scripts/sync-runtimes.mjs", "--refresh-source-pins", "--targets", "codex"];
  const prepared = runtime.run(args, { env });
  assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
  assert.equal(runtime.run([REFRESH_PINS_SCRIPT, "--check"]).status, 0);
  const ledger = path.join(runtime.repoRoot, RUNTIME_CAPABILITY_EVIDENCE_PATH);
  const after = readFileSync(ledger, "utf8");
  const repeated = runtime.run(args, { env });
  assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
  assert.equal(readFileSync(ledger, "utf8"), after);
});

test("source preparation fails before projection and a failed manifest never reverts correct pins", (t) => {
  const runtime = createGovernanceRuntimeFixture(t);
  assert.equal(runtime.run([REFRESH_PINS_SCRIPT]).status, 0);
  const ledger = path.join(runtime.repoRoot, RUNTIME_CAPABILITY_EVIDENCE_PATH);
  const original = readFileSync(ledger, "utf8");
  const projected = path.join(runtime.repoRoot, ".codex/agents/meta-warden.toml");
  const projectedBefore = readFileSync(projected, "utf8");
  appendFileSync(path.join(runtime.repoRoot, "canonical/agents/meta-warden.md"), "\nSource preparation fixture note.\n");
  appendFileSync(path.join(runtime.repoRoot, "AGENTS.md"), "\nSource preparation fixture change.\n");
  writeFileSync(ledger, "{ malformed fixture\n");
  const args = ["scripts/sync-runtimes.mjs", "--refresh-source-pins", "--targets", "codex"];
  const invalid = runtime.run(args);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Nothing was written/u);
  assert.equal(readFileSync(ledger, "utf8"), "{ malformed fixture\n");
  assert.equal(readFileSync(projected, "utf8"), projectedBefore);

  writeFileSync(ledger, original);
  const partial = runtime.run(args, { env: { ...runtime.env, META_KIM_TEST_FAIL_SYNC_RUNTIMES_MANIFEST: "1" } });
  assert.notEqual(partial.status, 0);
  assert.match(partial.stderr, /manifest persistence was intentionally failed/u);
  const prepared = readFileSync(ledger, "utf8");
  assert.equal(runtime.run([REFRESH_PINS_SCRIPT, "--check"]).status, 0);
  const recovered = runtime.run(args);
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  assert.equal(readFileSync(ledger, "utf8"), prepared);
});

test("source maintenance detects a later source edit without signing it again", (t) => {
  const runtime = createGovernanceRuntimeFixture(t);
  assert.equal(runtime.run([REFRESH_PINS_SCRIPT]).status, 0);
  const agents = path.join(runtime.repoRoot, "AGENTS.md");
  appendFileSync(agents, "\nPrepared source fixture.\n");
  const preparedHash = digestRepositorySource(agents);
  const preload = path.join(runtime.root, "concurrent-source-edit.mjs");
  // Fault injection belongs only to this disposable launcher. No production
  // Hook or retry mode is introduced to manufacture a passing source state.
  writeFileSync(preload, `import { appendFileSync } from "node:fs";\nconst original = process.stdout.write.bind(process.stdout);\nlet edited = false;\nprocess.stdout.write = function (chunk, ...args) {\n  const result = original(chunk, ...args);\n  if (!edited && /^refreshed \\d+ repo_projection/u.test(String(chunk))) {\n    edited = true;\n    appendFileSync(${JSON.stringify(agents)}, "\\nConcurrent fixture edit after preparation.\\n");\n  }\n  return result;\n};\n`);
  const result = runtime.run(["--import", pathToFileURL(preload).href, "scripts/sync-runtimes.mjs", "--refresh-source-pins", "--targets", "codex"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Source runtime evidence check failed/u);
  const ledger = JSON.parse(readFileSync(path.join(runtime.repoRoot, RUNTIME_CAPABILITY_EVIDENCE_PATH), "utf8"));
  const artifact = ledger.observations.find((entry) => entry.id === "codex.repo.projection.2026-07-28").sourceArtifacts.find((entry) => entry.path === "AGENTS.md");
  assert.equal(artifact.sha256, preparedHash);
  assert.notEqual(digestRepositorySource(agents), preparedHash);
});

test("reverse source maintenance prepares pins only after exact approved canonical apply", (t) => {
  const runtime = createGovernanceRuntimeFixture(t);
  assert.equal(runtime.run([REFRESH_PINS_SCRIPT]).status, 0);
  const ledger = path.join(runtime.repoRoot, RUNTIME_CAPABILITY_EVIDENCE_PATH);
  const before = readFileSync(ledger, "utf8");
  const canonical = path.join(runtime.repoRoot, "canonical/agents/meta-warden.md");
  const canonicalBefore = readFileSync(canonical, "utf8");
  const projected = path.join(runtime.repoRoot, ".claude/agents/meta-warden.md");
  appendFileSync(projected, "\nReverse lifecycle fixture note.\n");
  appendFileSync(path.join(runtime.repoRoot, "AGENTS.md"), "\nPending reverse preparation fixture.\n");
  const candidatePath = path.join(runtime.root, "reverse-candidate.json");
  const args = ["scripts/sync-runtimes.mjs", "--refresh-source-pins", "--targets", "claude", "--reverse", "--candidate-output", candidatePath];
  const collected = runtime.run(args);
  assert.equal(collected.status, 0, collected.stderr || collected.stdout);
  assert.equal(readFileSync(canonical, "utf8"), canonicalBefore);
  assert.equal(readFileSync(ledger, "utf8"), before);
  const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
  assert.equal(candidate.mutationCandidates.length, 1);
  // This exact-bound approval is disposable development input, not a claim
  // that a production Warden approved or a host executed any mutation.
  const approval = {
    ...candidate.approvalPacketTemplate,
    approvalId: "source-lifecycle-fixture",
    approvedAt: new Date().toISOString(),
    diffSummary: "Apply one exact disposable lifecycle fixture note.",
    rollbackPlan: "Restore the exact prior fixture bytes.",
    riskReview: { status: "accepted", owner: "meta-sentinel" },
  };
  const approvalPath = path.join(runtime.root, "reverse-approval.json");
  const wrong = structuredClone(approval);
  wrong.mutationBindings[0].candidateDigest = `sha256:${"0".repeat(64)}`;
  writeFileSync(approvalPath, JSON.stringify(wrong));
  const rejected = runtime.run([...args, "--approval", approvalPath, "--apply"]);
  assert.equal(rejected.status, 0, rejected.stderr || rejected.stdout);
  assert.match(rejected.stdout, /canonicalWrites=0/u);
  assert.equal(readFileSync(canonical, "utf8"), canonicalBefore);
  assert.equal(readFileSync(ledger, "utf8"), before);
  writeFileSync(approvalPath, JSON.stringify(approval));
  const check = runtime.run([...args, "--approval", approvalPath, "--apply", "--check"]);
  assert.notEqual(check.status, 0);
  assert.match(check.stderr, /--check cannot apply reverse source maintenance/u);
  assert.equal(readFileSync(canonical, "utf8"), canonicalBefore);
  assert.equal(readFileSync(ledger, "utf8"), before);
  const applied = runtime.run([...args, "--approval", approvalPath, "--apply"]);
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  assert.match(readFileSync(canonical, "utf8"), /Reverse lifecycle fixture note/u);
  assert.match(readFileSync(projected, "utf8"), /Reverse lifecycle fixture note/u);
  assert.equal(runtime.run([REFRESH_PINS_SCRIPT, "--check"]).status, 0);
});
