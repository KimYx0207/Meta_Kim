import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { STAGES } from "../../scripts/run-verify-all.mjs";
import { SMOKE_STAGES, SMOKE_BEHAVIOR_STAGES, CI_LANES } from "../../scripts/verification-stage-manifest.mjs";
import { buildIsolatedTestEnvironment, localVerificationStages } from "../../scripts/run-local-verification.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

test("full verification executes the shared smoke floor exactly once, including Live coverage", () => {
  for (const stage of SMOKE_STAGES) {
    const full = STAGES.filter(({ name }) => name === stage.name);
    assert.equal(full.length, 1, stage.name);
    if (stage.name === "meta:sync") {
      assert.match(full[0].cmd, /^npm run meta:sync -- --targets /u);
    } else {
      assert.equal(full[0].cmd, stage.cmd, `${stage.name} cannot be replaced with inventory/structural proof`);
    }
    assert.ok(full[0].timeoutMs > 0, `${stage.name} needs a timeout policy`);
  }
  assert.ok(SMOKE_BEHAVIOR_STAGES.some(({ name }) => name === "meta:test:live:coverage"));
  for (const metric of ["lines", "functions", "branches"]) {
    assert.ok(pkg.scripts["meta:test:live:coverage"].includes(`--test-coverage-${metric}=80`));
  }
});

test("CI lanes cover smoke test suites and governance without installed-provider acceptance", () => {
  const ciStages = Object.values(CI_LANES).flat();
  for (const stage of SMOKE_BEHAVIOR_STAGES.filter(({ name }) => name.startsWith("meta:test:"))) assert.ok(ciStages.includes(stage), stage.name);
  assert.equal(ciStages.some(({ name }) => name === "meta:capabilities:smoke"), false);
  assert.ok(ciStages.some(({ name }) => name === "meta:test:governance"));
  assert.equal(new Set(ciStages.map(({ name }) => name)).size, ciStages.length);
  assert.equal(pkg.scripts["meta:release:smoke"], "node scripts/run-local-verification.mjs --suite smoke");
  assert.equal(pkg.scripts["meta:test:ci"], "node scripts/run-local-verification.mjs --isolated");
  assert.throws(() => localVerificationStages("external-model"), /Unknown verification suite/u);
  const workflow = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /lane: \[core, governance, live\]/u);
  assert.match(workflow, /npm run meta:test:ci -- --suite \$\{\{ matrix.lane \}\}/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /persist-credentials: false\s*\n\s*# The migration fingerprint check reads historical agent blobs\.\s*\n\s*fetch-depth: 0/u);
  assert.doesNotMatch(workflow, /^\s*(?:paths|paths-ignore):/mu, "Markdown product changes must trigger CI");
  assert.match(workflow, /needs: \[behavior-regression,/u, "packaging must wait for behavior checks");
});

test("isolated test environment strips credentials and ambient runtime/config overrides", () => {
  const home = path.join(os.tmpdir(), "verification-home-example");
  const env = buildIsolatedTestEnvironment(home, {
    PATH: "test-tools", SystemRoot: "test-system", ComSpec: "test-shell",
    HOME: "real-home", USERPROFILE: "real-home", CODEX_HOME: "real-codex",
    ANTHROPIC_API_KEY: "sentinel", OPENAI_API_KEY: "sentinel", GH_TOKEN: "sentinel",
    AWS_ACCESS_KEY_ID: "sentinel", CUSTOM_PROVIDER_SECRET: "sentinel",
    NODE_OPTIONS: "--import=untrusted", NODE_PATH: "untrusted",
    META_KIM_DEP_ROOTS: "real-dependencies", META_KIM_REPO_ROOT: "real-repo",
    npm_config_userconfig: "real-npmrc", GIT_CONFIG_GLOBAL: "real-gitconfig",
    GIT_DIR: "real-git", HTTP_PROXY: "credential-bearing-proxy",
  });
  assert.equal(env.PATH, "test-tools");
  assert.equal(env.SystemRoot, "test-system");
  assert.equal(env.HOME, home);
  assert.equal(env.USERPROFILE, home);
  assert.equal(env.npm_config_userconfig, path.join(home, ".npmrc"));
  assert.equal(env.META_KIM_DISABLE_SIBLING_DEP_PROBE, "1");
  assert.doesNotMatch(JSON.stringify(env), /sentinel|real-|untrusted|credential-bearing/u);
});

test("CI runs setup and process guard regressions on every supported host", () => {
  assert.deepEqual(CI_LANES["setup-platform"].map(({ name }) => name), [
    "meta:test:setup:cross-platform", "meta:test:process-guard",
  ]);
  const stages = localVerificationStages("setup-platform");
  for (const stage of CI_LANES["setup-platform"]) assert.ok(stages.includes(stage));
  for (const file of ["codex-config-merge", "mcp-memory-process-control"]) {
    assert.ok(pkg.scripts["meta:test:setup:cross-platform"].includes(`tests/setup/${file}.test.mjs`));
  }
  for (const file of ["windows-job-process-runner", "posix-process-group-runner", "process-runner-contract"]) {
    assert.ok(pkg.scripts["meta:test:process-guard"].includes(`tests/setup/${file}.test.mjs`));
  }
  const workflow = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const job = workflow.split("  setup-platform:\n")[1]?.split("\n  planning-continuity:")[0];
  assert.ok(job, "the cross-platform lane must have a real CI job");
  assert.match(job, /os: \[ubuntu-latest, macos-latest, windows-latest\]/u);
  assert.match(job, /runs-on: \$\{\{ matrix.os \}\}/u);
  assert.match(job, /persist-credentials: false/u);
  assert.match(job, /fetch-depth: 0/u);
  assert.match(job, /npm run meta:test:ci -- --suite setup-platform/u);
  assert.match(workflow, /needs: \[behavior-regression, setup-platform,/u);
});

test("a real failing Live fixture stops smoke, full resumed diagnostics, and the CI entrypoint", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "meta-kim-failing-live-gate-"));
  try {
    mkdirSync(path.join(fixture, "tests/live"), { recursive: true });
    writeFileSync(path.join(fixture, "pass.mjs"), "process.exit(0);\n");
    writeFileSync(path.join(fixture, "tests/live/failing.test.mjs"), [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'test("injected Live regression", () => assert.fail("LIVE_GATE_FAILURE_SENTINEL"));',
    ].join("\n"));
    const scripts = Object.fromEntries([...SMOKE_STAGES, ...STAGES].map(({ name }) => [name, "node pass.mjs"]));
    scripts["meta:test:live:coverage"] = "node --test tests/live/failing.test.mjs";
    scripts["meta:release:smoke"] = `node "${path.join(root, "scripts/run-local-verification.mjs")}" --suite smoke`;
    scripts["meta:test:ci"] = `node "${path.join(root, "scripts/run-local-verification.mjs")}" --isolated`;
    scripts["meta:verify:all"] = `node "${path.join(root, "scripts/run-verify-all.mjs")}"`;
    writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "failing-live-fixture", private: true, scripts }));
    // A nested Node test runner must not inherit the parent test-file context;
    // otherwise Node can skip the nested file and report a false green result.
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
    delete env.NODE_TEST_CONTEXT;
    const invoke = (command, args) => spawnSync(command, args, {
      cwd: fixture, encoding: "utf8", timeout: 60_000, windowsHide: true,
      env,
    });
    for (const args of [["init", "--quiet"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "fixture"]]) {
      const result = invoke("git", args);
      assert.equal(result.status, 0, result.stderr);
    }
    for (const args of [
      ["run", "meta:release:smoke"],
      ["run", "meta:verify:all", "--", "--from", "meta:test:live:coverage", "--no-report", "--json"],
      ["run", "meta:test:ci", "--", "--suite", "live"],
    ]) {
      const result = process.platform === "win32"
        ? invoke(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `npm ${args.join(" ")}`])
        : invoke("npm", args);
      assert.equal(result.status, 1, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
      assert.match(result.stdout + result.stderr, /LIVE_GATE_FAILURE_SENTINEL/u);
      assert.match(result.stdout + result.stderr, /meta:test:live:coverage/u);
      if (args.includes("meta:verify:all")) {
        assert.match(result.stdout, /"failedStage": "meta:test:live:coverage"/u);
        assert.match(result.stdout, /"releaseGrade": false/u);
      }
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
