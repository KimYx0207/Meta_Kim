import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { GRAPHIFY_VERSION } from "../../scripts/graphify-package-install.mjs";

const script = resolve(import.meta.dirname, "../../scripts/project-post-copy-init.mjs");
const gitExecutable = process.platform === "win32" ? "git.exe" : "git";
const gitHookEvents = ["post-commit", "post-checkout", "post-merge", "post-rewrite"];
const fixtureSource = `
import childProcess from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";

const realSpawn = childProcess.spawnSync;
const ok = { status: 0, stdout: "", stderr: "" };
const failed = { status: 1, stdout: "", stderr: "fake command failure" };
if (process.env.FIXTURE_PLATFORM) {
  Object.defineProperty(process, "platform", { value: process.env.FIXTURE_PLATFORM });
}
childProcess.spawnSync = (command, args, options) => {
  if (command === "git") return realSpawn(command, args, options);
  const call = args.join(" ");
  appendFileSync(process.env.FIXTURE_LOG, JSON.stringify([command, ...args]) + "\\n");
  if (call.endsWith("--version") && basename(command) !== "where.exe") {
    return { ...ok, stdout: call.includes("pip") ? "pip 24.0" : "Python 3.12.0" };
  }
  if (call === "-m pip show graphifyy") {
    return process.env.FIXTURE_FAIL_PACKAGE ? failed : { ...ok, stdout: "Version: " + process.env.FIXTURE_GRAPHIFY_VERSION };
  }
  if (call === "-m pip show networkx") return { ...ok, stdout: "Version: 3.4.2" };
  if (process.env.FIXTURE_FAIL_PACKAGE && call.startsWith("-m pip install")) return failed;
  if (call === "-m graphify hook install") writeFileSync(process.env.FIXTURE_HOOK, "overwritten by native install\\n");
  if (call === "-m graphify update .") writeFileSync(process.env.FIXTURE_GRAPH, "raw update\\n");
  if (basename(args[0] ?? "") === "graphify-managed.py" && args[1] === "install") {
    if (process.env.FIXTURE_FAIL_REPAIR) return failed;
    writeFileSync(process.env.FIXTURE_HOOK, process.env.FIXTURE_MANAGED_HOOK);
  }
  return ok;
};
syncBuiltinESMExports();
`;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "meta-kim-post-copy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "repo");
  const home = join(directory, "home");
  mkdirSync(home);
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, "missing-gitconfig"),
    FIXTURE_PLATFORM: "linux",
    FIXTURE_LOG: join(directory, "calls.jsonl"),
    FIXTURE_GRAPHIFY_VERSION: GRAPHIFY_VERSION,
    FIXTURE_GRAPH: join(root, "graphify-out", "graph.json"),
    FIXTURE_HOOK: join(root, ".git", "hooks", "post-commit"),
    FIXTURE_MANAGED_HOOK: "#!/bin/sh\n# user prefix\n# managed Graphify block\n# user suffix\n",
  };
  const runGit = (cwd, ...args) => {
    const result = spawnSync(gitExecutable, args, { cwd, env, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  };
  runGit(directory, "init", "-q", root);
  runGit(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@invalid.test", "commit", "--allow-empty", "-qm", "Fixture");
  mkdirSync(join(root, ".git", "graphify"));
  mkdirSync(join(root, "graphify-out"));
  for (const event of gitHookEvents) writeFileSync(join(root, ".git", "hooks", event), env.FIXTURE_MANAGED_HOOK);
  writeFileSync(env.FIXTURE_GRAPH, "original graph\n");
  writeFileSync(env.FIXTURE_LOG, "");
  const config = join(root, ".git", "graphify", "config.json");
  const python = join(directory, "private", "python");
  writeFileSync(config, JSON.stringify({ python }));
  const preload = join(directory, "fixture.mjs");
  writeFileSync(preload, fixtureSource);
  return {
    root, directory, env, python, config, runGit,
    run(cwd = root) {
      const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, script, "--auto-worker"], {
        cwd, env, encoding: "utf8", timeout: 15000, windowsHide: true,
      });
      const marker = join(cwd, ".meta-kim", "state", "default", "post-copy-init.json");
      return {
        ...result,
        calls: readFileSync(env.FIXTURE_LOG, "utf8").split("\n").filter(Boolean).map(JSON.parse),
        marker: existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")) : null,
      };
    },
  };
}

test("post-copy uses the managed interpreter and refreshes only through the graph manager", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.marker?.status, "passed");
  assert.ok(result.calls.length > 0);
  assert.ok(result.calls.every(([python]) => python === f.python));
  const commands = result.calls.map((call) => call.slice(1).join(" "));
  assert.doesNotMatch(commands.join("\n"), /pip install|graphify hook install|graphify update/);
  assert.match(commands.at(-3), /graphify codex install/);
  assert.match(commands.at(-2), /graphify-managed\.py install --repo/);
  assert.match(commands.at(-1), /graphify-managed\.py run --repo/);
  for (const event of gitHookEvents) {
    assert.equal(readFileSync(join(f.root, ".git", "hooks", event), "utf8"), f.env.FIXTURE_MANAGED_HOOK);
  }
});

test("post-copy cannot overwrite shared managed hooks from a linked worktree", (t) => {
  const f = fixture(t);
  const worktree = join(f.directory, "linked");
  f.runGit(f.root, "worktree", "add", "--detach", "-q", worktree);
  const result = f.run(worktree);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.marker?.status, "skipped");
  assert.match(result.marker.message, /linked worktree/);
  assert.deepEqual(result.calls, []);
  for (const event of gitHookEvents) {
    assert.equal(readFileSync(join(f.root, ".git", "hooks", event), "utf8"), f.env.FIXTURE_MANAGED_HOOK);
  }
  assert.equal(readFileSync(f.env.FIXTURE_GRAPH, "utf8"), "original graph\n");
});

test("invalid or unavailable managed Graphify does not fall back to unmanaged writes", async (t) => {
  const cases = {
    "invalid configuration": (f) => writeFileSync(f.config, "{broken"),
    "missing Python": (f) => writeFileSync(f.config, "{}"),
    "package install failure": (f) => { f.env.FIXTURE_FAIL_PACKAGE = "1"; },
    "manager repair failure": (f) => { f.env.FIXTURE_FAIL_REPAIR = "1"; },
    "unsupported Windows managed runtime": (f) => { f.env.FIXTURE_PLATFORM = "win32"; },
  };
  for (const [name, prepare] of Object.entries(cases)) {
    await t.test(name, (subtest) => {
      const f = fixture(subtest);
      prepare(f);
      const result = f.run();
      assert.equal(result.status, 1, result.stdout);
      assert.equal(result.marker?.status, "failed");
      assert.ok(result.calls.every(([python]) => python === f.python));
      assert.doesNotMatch(result.calls.map((call) => call.join(" ")).join("\n"), /graphify-managed\.py run|graphify update/);
      assert.equal(readFileSync(f.env.FIXTURE_HOOK, "utf8"), f.env.FIXTURE_MANAGED_HOOK);
      assert.equal(readFileSync(f.env.FIXTURE_GRAPH, "utf8"), "original graph\n");
    });
  }
});
