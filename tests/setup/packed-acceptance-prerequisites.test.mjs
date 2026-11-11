import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { copyRuntimeCapabilityObservationSnapshot, isolatedEnvironment, makeIsolatedRoots } from "../../scripts/verify-packed-user-install-update.mjs";
import { assertExactStandardRuntimeObservationSet, standardRuntimeObservationSet } from "../../scripts/runtime-execution-gate.mjs";
import { requirePackedRuntimeObservationPrerequisites, requirePackedRuntimePrerequisites } from "../../scripts/packed-runtime-prerequisites.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-packed-prerequisites-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const roots = makeIsolatedRoots(root, "test");
  return { roots, env: isolatedEnvironment(process.env, roots) };
}

function installFixture({ roots, env }) {
  const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../scripts/managed-dependency-source.mjs")).href;
  return spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { existsSync } from "node:fs";
    import { materializeManagedServiceSource, readManagedServiceSource } from ${JSON.stringify(moduleUrl)};
    const value = await materializeManagedServiceSource({ sourceRoot: ${JSON.stringify(path.join(roots.localDependencyRoot, "Kim_Service"))}, metaKimVersion: "fixture" });
    console.log(JSON.stringify({ value, revision: readManagedServiceSource().revision, gitCopied: existsSync(value + "/.git") }));
  `], { env, cwd: roots.ordinaryCwd, encoding: "utf8", timeout: 30_000, windowsHide: true });
}

test("packed Service fixture passes the real indexed-closure validator without claiming a Git revision", t => {
  const f = fixture(t);
  const result = installFixture(f);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.revision.selection, "local_override");
  assert.equal(evidence.revision.commit, null);
  assert.equal(evidence.gitCopied, false);
});

test("packed Service fixture content tampering is rejected by the real materializer", t => {
  const f = fixture(t);
  appendFileSync(path.join(f.roots.localDependencyRoot, "Kim_Service/skills/find-skill/SKILL.md"), "\nChanged after indexing.\n");
  const result = installFixture(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Service component content hash mismatch/u);
});

test("packed environment retains the explicit Git proxy but excludes model tokens and unrelated overrides", t => {
  const { roots } = fixture(t);
  const env = isolatedEnvironment({
    PATH: process.env.PATH, HTTP_PROXY: "http://proxy.example.invalid:8080",
    META_KIM_GIT_PROXY: "http://git.example.invalid:8080", ANTHROPIC_API_KEY: "fixture-only",
    OPENAI_API_KEY: "fixture-only", GITHUB_TOKEN: "fixture-only", META_KIM_UNRELATED_OVERRIDE: "fixture-only",
  }, roots);
  assert.equal(env.META_KIM_GIT_PROXY, "http://git.example.invalid:8080");
  assert.equal(env.HTTP_PROXY, "http://proxy.example.invalid:8080");
  for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "META_KIM_UNRELATED_OVERRIDE"]) assert.equal(env[name], undefined);
  assert.equal(env.HOME, roots.userHome);
  assert.equal(env.CLAUDE_CONFIG_DIR, roots.claudeHome);
  assert.equal(env.CODEX_HOME, roots.codexHome);
});

test("missing native observations remain a strict ten-item failure with no advisory snapshot written", t => {
  const { roots } = fixture(t);
  mkdirSync(path.join(roots.projectDir, ".git"));
  assert.throws(() => copyRuntimeCapabilityObservationSnapshot({ sourceProjectRoot: roots.projectDir, targetProjectRoot: roots.ordinaryCwd }), error => {
    assert.equal(error.code, "environment_unavailable");
    const diagnostics = error.runtimeObservationPrerequisites;
    assert.equal(diagnostics.availableCount, 0);
    assert.equal(diagnostics.requiredCount, 10);
    assertExactStandardRuntimeObservationSet(diagnostics.missing);
    assert.equal(diagnostics.modelInvocation, false);
    assert.equal(diagnostics.executionAuthority, false);
    assert.equal(diagnostics.releaseGradeEligible, false);
    assert.equal(diagnostics.state, "empty");
    return true;
  });
  assert.equal(existsSync(path.join(roots.ordinaryCwd, ".meta-kim/state/default/runtime-capability-acceptance/advisory-snapshot.json")), false);
});

test("missing official runtime executables produce environment diagnostics without a model call", t => {
  const { roots, env } = fixture(t);
  assert.throws(() => requirePackedRuntimePrerequisites({ env: { ...env, PATH: "", Path: "" }, cwd: roots.ordinaryCwd }), error => {
    assert.equal(error.code, "environment_unavailable");
    assert.equal(error.runtimePrerequisites.probeKind, "executable_version_only");
    assert.deepEqual(error.runtimePrerequisites.unavailable, ["claude", "codex"]);
    assert.equal(error.runtimePrerequisites.modelInvocation, false);
    assert.equal(error.runtimePrerequisites.executionAuthority, false);
    return true;
  });
});

test("duplicate or unexpected native keys remain invalid rather than an environment skip", () => {
  const required = standardRuntimeObservationSet();
  for (const applied of [[...required, required[0]], [...required, { runtime: "fixture", capability: "agent", mode: "interactive_host" }]]) {
    assert.throws(() => requirePackedRuntimeObservationPrerequisites({ overlayStatus: { applied, rejected: [], state: "fixture_only" } }), error => {
      assert.equal(error.code, "invalid_observation_set");
      assert.equal(error.runtimeObservationPrerequisites.releaseGradeEligible, false);
      assert.ok(error.runtimeObservationPrerequisites.duplicateKeys.length || error.runtimeObservationPrerequisites.unexpected.length);
      return true;
    });
  }
});
