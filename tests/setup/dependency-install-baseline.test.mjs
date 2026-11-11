import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEPENDENCY_BASELINE, readDependencyBaseline } from "../../scripts/dependency-baseline.mjs";
import { checkoutReviewedServiceSource, matchesReviewedServiceSource } from "../../scripts/managed-service-checkout.mjs";
import { upstreamCliArgsForTarget } from "../../scripts/upstream-cli-install-plan.mjs";
import { GRAPHIFY_PACKAGE, GRAPHIFY_VERSION, reconcileGraphifyPackage } from "../../scripts/graphify-package-install.mjs";
import { readReviewedNpmBaseline } from "../../scripts/npm-dependency-baseline.mjs";

const skills = JSON.parse(readFileSync(new URL("../../config/skills.json", import.meta.url)));
const ecc = skills.skills.find(spec => spec.id === "ecc");

test("reviewed CI Node baselines reject ranges, missing values and output injection", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-ci-node-baseline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "baseline.json");
  for (const key of ["nodeRegression", "nodeDshHost"]) {
    for (const value of [undefined, ">=22.13.0", "22", "v22.13.0", "022.13.0", "22.13.0\ninjected=24.0.0"]) {
      const baseline = structuredClone(DEPENDENCY_BASELINE);
      baseline.npm[key] = value;
      writeFileSync(file, JSON.stringify(baseline));
      assert.throws(() => readDependencyBaseline(file), /Node .*baseline must be an exact version/u, `${key}: ${value}`);
    }
  }
});

test("the real CI baseline command emits the checked-in versions with shell-independent output paths", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-ci-baseline-output-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "config"));
  const entrypoint = path.join(root, "scripts", "dependency-baseline.mjs");
  writeFileSync(entrypoint, readFileSync(new URL("../../scripts/dependency-baseline.mjs", import.meta.url)));
  const baseline = structuredClone(DEPENDENCY_BASELINE);
  baseline.npm.nodeRegression = "22.14.1";
  baseline.npm.nodeDshHost = "24.23.0";
  const baselineFile = path.join(root, "config", "dependency-baseline.json");
  writeFileSync(baselineFile, JSON.stringify(baseline));
  const output = path.join(root, "output file with spaces.txt");
  writeFileSync(output, "existing=value\n");
  const run = () => spawnSync(process.execPath, [entrypoint, "--github-output"], {
    cwd: root, env: { ...process.env, GITHUB_OUTPUT: output }, encoding: "utf8",
  });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const expected = `existing=value\nservice-commit=${baseline.kimService.commit}\nservice-repository=${baseline.kimService.repository}\nnode-regression=22.14.1\nnode-dsh-host=24.23.0\n`;
  assert.equal(readFileSync(output, "utf8"), expected);
  baseline.npm.nodeRegression = "22.14.1\ninjected=24.0.0";
  writeFileSync(baselineFile, JSON.stringify(baseline));
  assert.notEqual(run().status, 0);
  assert.equal(readFileSync(output, "utf8"), expected, "invalid input must not append any CI output");
});

test("the actual npm lock matches the reviewed digest and survives the package file allow-list", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const reviewed = readReviewedNpmBaseline(root, manifest);
  assert.equal(reviewed.sha256, DEPENDENCY_BASELINE.npm.sha256);
  assert(reviewed.packages.length > 0);
  assert(manifest.files.includes("npm-shrinkwrap.json"));
  assert(manifest.files.includes("config/"));
  assert(manifest.files.includes("scripts/**/*.mjs"));
});

test("ECC OpenCode arguments use the reviewed installer and explicit hook policy on install and update", () => {
  assert.equal(ecc.upstreamPackage, "ecc-universal@2.2.3");
  for (const target of ["opencode", "codex", "qwen", "cursor", "zed", "gemini"]) {
    assert.deepEqual(upstreamCliArgsForTarget(ecc, target), ["--yes", "--package", "ecc-universal@2.2.3",
      "ecc", "install", "--profile", "core", "--target", target, "--no-hooks"]);
  }
  assert.equal(upstreamCliArgsForTarget({ ...ecc, upstreamHookPolicyByTarget: { opencode: "enabled" } }, "opencode").at(-1), "--enable-hooks");
  assert.equal(upstreamCliArgsForTarget({ ...ecc, upstreamHookPolicyByTarget: { opencode: "enabled" } }, "codex").at(-1), "--no-hooks");
  assert.throws(() => upstreamCliArgsForTarget({ ...ecc, upstreamPackage: "ecc-universal@latest" }, "opencode"), /fixed|exact|version/i);
  assert.throws(() => upstreamCliArgsForTarget({ ...ecc, upstreamHookPolicy: "automatic" }, "opencode"), /hook policy/i);
});

function pythonFixture(versions, installStatus = 0) {
  const calls = [];
  return { calls, runPython(_python, args) {
    calls.push(args);
    if (args[2] === "show") {
      const version = versions.shift();
      return version ? { status: 0, stdout: `Name: graphifyy\nVersion: ${version}\n` } : { status: 1, stderr: "not installed" };
    }
    return { status: installStatus, stdout: "fixture installer" };
  } };
}

test("ordinary and managed Graphify reuse only the shared exact version", () => {
  const fixture = pythonFixture([GRAPHIFY_VERSION]);
  const result = reconcileGraphifyPackage({}, fixture);
  assert.equal(result.action, "reuse"); assert.equal(result.ok, true);
  assert.equal(fixture.calls.length, 1);
});

for (const before of [null, "0.9.55", "0.9.59"]) {
  test(`Graphify repairs ${before ?? "missing"} to the shared pin and verifies the installed version`, () => {
    const fixture = pythonFixture([before, GRAPHIFY_VERSION]);
    const result = reconcileGraphifyPackage({}, fixture);
    assert.equal(result.ok, true); assert.equal(result.version, GRAPHIFY_VERSION);
    assert.equal(fixture.calls[1].at(-1), GRAPHIFY_PACKAGE);
    assert.equal(fixture.calls.length, 3);
    assert.equal(fixture.calls[1].includes("--upgrade"), Boolean(before));
  });
}

test("Graphify explicit update stays pinned, while failed or wrong-version installation never reports success", () => {
  const update = pythonFixture([GRAPHIFY_VERSION, GRAPHIFY_VERSION]);
  assert.equal(reconcileGraphifyPackage({}, { ...update, inUpdateMode: true }).ok, true);
  assert.equal(update.calls[1].at(-1), GRAPHIFY_PACKAGE);
  const failed = pythonFixture(["0.9.59"], 1);
  assert.equal(reconcileGraphifyPackage({}, failed).code, "graphify_package_install_failed");
  assert.equal(failed.calls.length, 2);
  const mismatched = pythonFixture([null, "0.9.59"]);
  assert.equal(reconcileGraphifyPackage({}, mismatched).code, "graphify_package_version_mismatch");
});

test("Service checkout selects the reviewed commit even when the default branch has advanced", async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-service-revision-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), checkout = path.join(root, "checkout");
  mkdirSync(source); mkdirSync(checkout);
  const git = args => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  git(["init", "--quiet"]);
  git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "core.hooksPath", path.join(root, "no-hooks")]);
  writeFileSync(path.join(source, "capability.txt"), "reviewed\n"); git(["add", "."]); git(["commit", "--quiet", "-m", "reviewed"]);
  const commit = git(["rev-parse", "HEAD"]);
  writeFileSync(path.join(source, "capability.txt"), "unreviewed head\n"); git(["commit", "--quiet", "-am", "advanced"]);
  const calls = [];
  const revision = await checkoutReviewedServiceSource({ directory: checkout, repositoryUrl: source,
    repository: "fixture/Kim_Service", commit, runGit: async args => {
      calls.push(args); return spawnSync("git", args, { encoding: "utf8" });
    } });
  assert.equal(revision.commit, commit);
  assert.equal(readFileSync(path.join(checkout, "capability.txt"), "utf8"), "reviewed\n");
  assert.deepEqual(calls.find(args => args.includes("fetch")).slice(-4), ["--depth", "1", "origin", commit]);
  assert.equal(matchesReviewedServiceSource({ revision }), false);
  assert.equal(matchesReviewedServiceSource({ revision: { ...revision, repository: DEPENDENCY_BASELINE.kimService.repository,
    commit: DEPENDENCY_BASELINE.kimService.commit } }), true);
  assert.equal(matchesReviewedServiceSource({ revision: null }), false);
  assert.equal(matchesReviewedServiceSource({ revision: { ...revision, selection: "local_override" } }), false);
});

test("Service failed fetch and unexpected HEAD fail closed before materialization", async () => {
  const sha = DEPENDENCY_BASELINE.kimService.commit;
  await assert.rejects(checkoutReviewedServiceSource({ directory: "fixture", repositoryUrl: "fixture",
    runGit: async args => ({ status: args.includes("fetch") ? 1 : 0, stdout: "" }) }), /checkout failed/);
  await assert.rejects(checkoutReviewedServiceSource({ directory: "fixture", repositoryUrl: "fixture", commit: sha,
    runGit: async args => ({ status: 0, stdout: args.includes("rev-parse") ? "0".repeat(40) : "" }) }), /differs from the reviewed commit/);
});
