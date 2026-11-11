import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { STAGES, RELEASE_RUNTIME_TARGETS, runVerificationCommands } from "../../scripts/run-verify-all.mjs";

const runner = fileURLToPath(new URL("../../scripts/run-verify-all.mjs", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-verify-sequence-"));
  const repo = path.join(root, "repo");
  const trace = path.join(root, "commands.jsonl");
  mkdirSync(repo);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = Object.fromEntries(STAGES.flatMap(({ commands }) => commands)
    .filter(({ command }) => command === "npm")
    .map(({ args }) => [args[1], `node record.mjs ${args[1]}`]));
  writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "verification-sequence-fixture", private: true, scripts }));
  writeFileSync(path.join(repo, "record.mjs"), [
    'import { appendFileSync } from "node:fs";',
    'appendFileSync(process.env.VERIFICATION_TRACE, JSON.stringify(process.argv.slice(2)) + "\\n");',
    'if (process.argv[2] === process.env.VERIFICATION_FAIL_STAGE) process.exit(Number(process.env.VERIFICATION_FAIL_CODE));',
  ].join("\n"));
  for (const args of [["init", "--quiet"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "fixture"]]) {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }
  const environment = { ...process.env, VERIFICATION_TRACE: trace };
  delete environment.NODE_TEST_CONTEXT;
  return {
    repo,
    environment,
    reset: () => writeFileSync(trace, ""),
    calls: () => readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse),
  };
}

function cliReport(result) {
  const start = result.stdout.indexOf('\n{\n  "ok":');
  const end = result.stdout.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, result.stderr + result.stdout);
  return JSON.parse(result.stdout.slice(start + 1, end + 2));
}

test("the actual full-verification entrypoint executes every check and preserves the first failure", async (t) => {
  const f = fixture(t);
  const expected = ["meta:check:runtimes", "meta:check:sync-coverage", "meta:open-source-boundary:validate", "meta:validate"];
  for (const [failStage, code, called] of [
    ["meta:verify:governance:core", 9, [...expected, "meta:verify:governance:core"]],
    [expected[0], 7, expected.slice(0, 1)],
    [expected[1], 13, expected.slice(0, 2)],
  ]) {
    await t.test(failStage, () => {
      f.reset();
      const result = spawnSync(process.execPath, [runner, "--from", "meta:check", "--no-report", "--json"], {
        cwd: f.repo,
        env: { ...f.environment, VERIFICATION_FAIL_STAGE: failStage, VERIFICATION_FAIL_CODE: String(code) },
        encoding: "utf8",
        timeout: 45_000,
        windowsHide: true,
      });
      assert.equal(result.status, 1, result.stderr + result.stdout);
      assert.deepEqual(f.calls().map(([name]) => name), called);
      assert.deepEqual(f.calls()[0], [expected[0], "--targets", RELEASE_RUNTIME_TARGETS.join(",")]);
      const report = cliReport(result);
      assert.equal(report.releaseGrade, false);
      assert.equal(report.failedStage, failStage === "meta:verify:governance:core" ? failStage : "meta:check");
      const check = report.stages.find(({ name }) => name === "meta:check");
      assert.equal(check.commands.length, Math.min(called.length, expected.length));
      assert.equal(check.status, failStage === "meta:verify:governance:core" ? "passed" : "failed");
      if (check.status === "failed") assert.equal(check.commands.at(-1).exitCode, code);
    });
  }
});

test("Graphify rebuild and verification both execute, while a failed rebuild short-circuits", (t) => {
  const f = fixture(t);
  const stage = STAGES.find(({ name }) => name === "meta:graphify:verified-rebuild");
  f.reset();
  const passed = runVerificationCommands(stage.commands, 30_000, { cwd: f.repo, environment: f.environment, captureStdout: true });
  assert.equal(passed.ok, true, JSON.stringify(passed));
  assert.deepEqual(f.calls(), [["meta:graphify:verified-rebuild"], ["meta:graphify:check"]]);
  assert.equal(passed.commands.length, 2);
  f.reset();
  const failed = runVerificationCommands(stage.commands, 30_000, {
    cwd: f.repo,
    environment: { ...f.environment, VERIFICATION_FAIL_STAGE: "meta:graphify:verified-rebuild", VERIFICATION_FAIL_CODE: "17" },
    captureStdout: true,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.exitCode, 17);
  assert.deepEqual(f.calls(), [["meta:graphify:verified-rebuild"]]);
});

test("structured verification arguments are passed literally without a shell", () => {
  const args = ["contains spaces", "&&", "$(never-run)", 'a"b'];
  const result = runVerificationCommands([{
    command: "node",
    args: ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...args],
  }], 5_000, { captureStdout: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.stdout), args);
});
