import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GRAPHIFY_PACKAGE, GRAPHIFY_VERSION } from "../../scripts/graphify-package-install.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "scripts", "graphify-cli.mjs");
const setup = path.join(root, "setup.mjs");
const reference = path.join(root, "docs", "graphify-managed-lifecycle.md");

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function initRepo(parent) {
  const repo = path.join(parent, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "Test User"]);
  writeFileSync(path.join(repo, ".gitignore"), "graphify-out/\n");
  writeFileSync(path.join(repo, "app.py"), "def alpha():\n    return 1\n");
  git(repo, ["add", ".gitignore", "app.py"]);
  git(repo, ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "seed"]);
  return repo;
}

function writeSeedGraph(repo) {
  const output = path.join(repo, "graphify-out");
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, "graph.json"), JSON.stringify({
    nodes: [{ id: "app_py", label: "app.py", source_file: "app.py", source_location: "L1", file_type: "code", type: "file", _origin: "ast" }],
    links: [],
    built_at_commit: git(repo, ["rev-parse", "HEAD"]),
  }) + "\n");
  writeFileSync(path.join(output, "GRAPH_REPORT.md"), "# Graph Report\n");
  writeFileSync(path.join(output, ".graphify_analysis.json"), JSON.stringify({ communities: { 0: ["app_py"] } }) + "\n");
}

function writeFakeGraphify(bin) {
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(process.cwd(), ".graphify-cli-calls.log"), args.join(" ") + "\\n");
if (args.join(" ") === "--version") { console.log(${JSON.stringify(`graphify ${GRAPHIFY_VERSION}`)}); process.exit(0); }
if (args.join(" ") === "claude install") process.exit(0);
if (args.join(" ") === "hook install") {
  const hooks = path.join(process.cwd(), ".git", "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, "post-commit"), "#!/bin/sh\\n# graphify-hook-start\\nraw graphify hook\\n# graphify-hook-end\\n");
  process.exit(0);
}
if (args.join(" ") === "update .") {
  fs.appendFileSync(path.join(process.cwd(), ".raw-update-ran"), "1\\n");
  process.exit(0);
}
process.exit(0);
`);
  chmodSync(bin, 0o755);
}

function writeFakePython(bin, graphifyBin, { initialVersion = GRAPHIFY_VERSION, installedVersion = GRAPHIFY_VERSION } = {}) {
  writeFileSync(`${bin}.version`, initialVersion ?? "");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.argv[1] + ".calls.jsonl", JSON.stringify(args) + "\\n");
function repoFromArgs() { return args[args.indexOf("--repo") + 1] || process.cwd(); }
function gitDir(repo) { return spawnSync("git", ["-C", repo, "rev-parse", "--git-dir"], { encoding: "utf8" }).stdout.trim(); }
function manager(command) {
  const repo = repoFromArgs();
  const state = path.resolve(repo, gitDir(repo), "graphify");
  fs.mkdirSync(state, { recursive: true });
  fs.appendFileSync(path.join(state, "calls.log"), command + "\\n");
  fs.appendFileSync(path.join(state, "manager-paths.log"), args[0] + "\\n");
  fs.appendFileSync(path.join(state, "cwd.log"), process.cwd() + "\\n");
  if (["query", "path", "explain"].includes(command)) {
    fs.appendFileSync(path.join(state, "forwarded.log"), command + " " + args.slice(1).join(" ") + " GRAPHIFY_OUT=" + (process.env.GRAPHIFY_OUT || "") + "\\n");
    process.exit(0);
  }
  if (command === "install") {
    const hooks = path.join(repo, gitDir(repo), "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    for (const event of ["post-commit", "post-checkout", "post-merge", "post-rewrite"]) {
      fs.writeFileSync(path.join(hooks, event), "#!/bin/sh\\n# graphify-hook-start\\n" + JSON.stringify(process.argv[1]) + " request --repo " + JSON.stringify(repo) + " --event " + event + "\\n# graphify-hook-end\\n");
      fs.chmodSync(path.join(hooks, event), 0o755);
    }
    const stableManager = path.join(state, "runtime", "graphify-managed.py");
    fs.mkdirSync(path.dirname(stableManager), { recursive: true });
    fs.writeFileSync(stableManager, "# stable manager fixture\\n");
    fs.writeFileSync(path.join(state, "config.json"), JSON.stringify({ python: process.argv[1], repo, manager: stableManager }) + "\\n");
  }
  if (command === "run") {
    fs.writeFileSync(path.join(state, "status.json"), JSON.stringify({ status: "success", request: { event: "manual" } }) + "\\n");
  }
  process.exit(0);
}
if (args.join(" ") === "--version") { console.log("Python 3.12.0"); process.exit(0); }
if (args.join(" ") === "-m pip --version") { console.log("pip 24.0"); process.exit(0); }
if (args.join(" ") === "-m pip show graphifyy") {
  const version = fs.readFileSync(process.argv[1] + ".version", "utf8");
  if (!version) process.exit(1);
  console.log("Name: graphifyy\\nVersion: " + version); process.exit(0);
}
if (args[0] === "-c") { console.log(${JSON.stringify(graphifyBin)}); process.exit(0); }
if (args[0] === "-m" && args[1] === "pip" && args[2] === "install") {
  fs.appendFileSync(path.join(process.cwd(), ".pip-install-calls.log"), args.slice(2).join(" ") + "\\n");
  fs.writeFileSync(process.argv[1] + ".version", ${JSON.stringify(installedVersion)});
  process.exit(0);
}
if (args[0] === "-m" && args[1] === "graphify") {
  fs.appendFileSync(path.join(process.cwd(), ".python-graphify-calls.log"), args.slice(2).join(" ") + " GRAPHIFY_OUT=" + (process.env.GRAPHIFY_OUT || "") + "\\n");
  const result = spawnSync(${JSON.stringify(graphifyBin)}, args.slice(2), { stdio: "inherit", cwd: process.cwd(), env: process.env });
  process.exit(result.status ?? 1);
}
if (args[0]?.endsWith("graphify-managed.py")) manager(args[1]);
if (args[0]?.endsWith(".test.py")) process.exit(0);
process.exit(1);
`);
  chmodSync(bin, 0o755);
}

function installFixture(t, { managed = false, initialVersion = null, installedVersion = GRAPHIFY_VERSION } = {}) {
  const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "meta-kim-graphify-install-")));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const binDir = path.join(tmp, "bin");
  mkdirSync(binDir);
  const repo = initRepo(tmp);
  const graphifyBin = path.join(binDir, "graphify");
  const pythonBin = path.join(binDir, "python3");
  writeFakeGraphify(graphifyBin);
  writeFakePython(pythonBin, graphifyBin, { initialVersion, installedVersion });
  if (managed) {
    mkdirSync(path.join(repo, ".git", "graphify"));
    writeFileSync(path.join(repo, ".git", "graphify", "config.json"), JSON.stringify({ python: pythonBin, repo }));
  }
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    META_KIM_GRAPHIFY_BIN: graphifyBin, META_KIM_GRAPHIFY_PYTHON: pythonBin };
  return { tmp, repo, pythonBin, env,
    calls: () => readFileSync(`${pythonBin}.calls.jsonl`, "utf8").trim().split(/\r?\n/u).map(line => JSON.parse(line)),
    run: command => spawnSync(process.execPath, [cli, command], { cwd: repo, env, encoding: "utf8", timeout: 10_000 }),
  };
}

for (const managed of [false, true]) {
  for (const command of ["install", "update"]) {
    test(`public Graphify ${command} uses the shared pin and verifies actual ${managed ? "managed" : "ordinary"} Python`, { skip: process.platform === "win32" }, t => {
      const fixture = installFixture(t, { managed });
      const result = fixture.run(command);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const calls = fixture.calls();
      const installs = calls.filter(args => args[0] === "-m" && args[1] === "pip" && args[2] === "install");
      assert.deepEqual(installs, [["-m", "pip", "install", ...(command === "update" ? ["--upgrade"] : []), GRAPHIFY_PACKAGE]]);
      const showIndices = calls.flatMap((args, index) => args.join(" ") === "-m pip show graphifyy" ? [index] : []);
      const installIndex = calls.indexOf(installs[0]);
      assert.equal(showIndices.length, 2, "installation requires actual package readback before and after pip");
      assert.ok(showIndices[0] < installIndex && installIndex < showIndices[1]);
      assert.equal(readFileSync(`${fixture.pythonBin}.version`, "utf8"), GRAPHIFY_VERSION);
      const hookIndex = calls.findIndex(args => args.join(" ") === "-m graphify hook install");
      assert.ok(hookIndex > showIndices[1], "hook installation must wait for verified package bytes/version");
    });
  }

  test(`public Graphify install reuses an exact ${managed ? "managed" : "ordinary"} package without pip`, { skip: process.platform === "win32" }, t => {
    const fixture = installFixture(t, { managed, initialVersion: GRAPHIFY_VERSION });
    const result = fixture.run("install");
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fixture.calls().some(args => args[1] === "pip" && args[2] === "install"), false);
    assert.ok(fixture.calls().some(args => args.join(" ") === "-m pip show graphifyy"));
  });

  test(`public Graphify install rejects a wrong ${managed ? "managed" : "ordinary"} post-install version before hooks`, { skip: process.platform === "win32" }, t => {
    const fixture = installFixture(t, { managed, installedVersion: "0.0.0" });
    const result = fixture.run("install");
    assert.notEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /graphify_package_version_mismatch/u);
    assert.equal(fixture.calls().some(args => args[0] === "-m" && args[1] === "graphify"), false,
      "pip exit zero alone must not install native integrations");
  });
}

test("managed Python test runner follows a changed shared baseline instead of silently skipping it", { skip: process.platform === "win32" }, t => {
  const baseline = JSON.parse(readFileSync(path.join(root, "config", "dependency-baseline.json"), "utf8"));
  const [major, minor, patch] = baseline.graphify.version.split(".").map(Number);
  baseline.graphify.version = `${major}.${minor}.${patch + 1}`;
  const fixture = installFixture(t, { initialVersion: baseline.graphify.version });
  const copiedRoot = path.join(fixture.tmp, "runner");
  mkdirSync(path.join(copiedRoot, "scripts"), { recursive: true });
  mkdirSync(path.join(copiedRoot, "config"));
  for (const name of ["run-graphify-managed-tests.mjs", "graphify-runtime.mjs", "graphify-package-install.mjs", "dependency-baseline.mjs"]) {
    copyFileSync(path.join(root, "scripts", name), path.join(copiedRoot, "scripts", name));
  }
  writeFileSync(path.join(copiedRoot, "config", "dependency-baseline.json"), JSON.stringify(baseline));
  const result = spawnSync(process.execPath, [path.join(copiedRoot, "scripts", "run-graphify-managed-tests.mjs")], {
    cwd: fixture.repo, env: fixture.env, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /SKIP/u, "the current exact baseline must execute the managed tests");
  const launched = fixture.calls().filter(args => args[0]?.endsWith(".test.py")).map(args => path.basename(args[0]));
  assert.deepEqual(launched, ["graphify-managed-safety.test.py", "graphify-managed.test.py", "graphify-managed-producer.test.py"]);
});

test("graphify-cli exposes managed commands and routes rebuild through existing managed config", { skip: process.platform === "win32" }, () => {
  const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "meta-kim-managed-cli-")));
  const binDir = path.join(tmp, "bin");
  mkdirSync(binDir);
  const repo = initRepo(tmp);
  writeSeedGraph(repo);
  const graphifyBin = path.join(binDir, "graphify");
  const pythonBin = path.join(binDir, "python3");
  writeFakeGraphify(graphifyBin);
  writeFakePython(pythonBin, graphifyBin, { initialVersion: null });
  mkdirSync(path.join(repo, ".git", "graphify"), { recursive: true });
  writeFileSync(
    path.join(repo, ".git", "graphify", "config.json"),
    JSON.stringify({ python: pythonBin, repo }) + "\n",
  );

  try {
    const env = {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      META_KIM_GRAPHIFY_BIN: graphifyBin,
      META_KIM_GRAPHIFY_PYTHON: pythonBin,
    };
    const installCommand = spawnSync(process.execPath, [cli, "install"], { cwd: repo, env, encoding: "utf8" });
    assert.equal(installCommand.status, 0, installCommand.stderr || installCommand.stdout);
    assert.match(readFileSync(path.join(repo, ".pip-install-calls.log"), "utf8"), new RegExp(escapeRegExp(GRAPHIFY_PACKAGE)));

    const install = spawnSync(process.execPath, [cli, "managed-install"], { cwd: repo, env, encoding: "utf8" });
    assert.equal(install.status, 0, install.stderr || install.stdout);
    const rebuild = spawnSync(process.execPath, [cli, "rebuild"], { cwd: repo, env, encoding: "utf8" });
    assert.equal(rebuild.status, 0, rebuild.stderr || rebuild.stdout);
    const calls = readFileSync(path.join(repo, ".git", "graphify", "calls.log"), "utf8");
    assert.match(calls, /^install$/m);
    assert.match(calls, /^run$/m);
    const managerPaths = readFileSync(path.join(repo, ".git", "graphify", "manager-paths.log"), "utf8").trim().split(/\r?\n/u);
    assert.match(managerPaths[0], /scripts\/graphify-managed\.py$/);
    assert.match(managerPaths.at(-1), /scripts\/graphify-managed\.py$/);
    assert.equal(existsSync(path.join(repo, ".raw-update-ran")), false, "managed rebuild must not bypass to raw graphify update");
    const status = spawnSync(process.execPath, [cli, "managed-status"], { cwd: repo, env, encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const afterStatusPaths = readFileSync(path.join(repo, ".git", "graphify", "manager-paths.log"), "utf8").trim().split(/\r?\n/u);
    assert.match(afterStatusPaths.at(-1), /scripts\/graphify-managed\.py$/);

    const nested = path.join(repo, "nested");
    mkdirSync(nested);
    const query = spawnSync(process.execPath, [cli, "query", "alpha"], { cwd: nested, env, encoding: "utf8" });
    assert.equal(query.status, 0, query.stderr || query.stdout);
    const pythonCalls = readFileSync(path.join(repo, ".python-graphify-calls.log"), "utf8");
    assert.match(pythonCalls, new RegExp("query alpha GRAPHIFY_OUT=" + escapeRegExp(path.join(repo, "graphify-out"))));
    assert.equal(existsSync(path.join(nested, ".python-graphify-calls.log")), false);

    const explain = spawnSync(process.execPath, [cli, "explain", "alpha", "--graph", "alternate.json"], { cwd: nested, env, encoding: "utf8" });
    assert.equal(explain.status, 0, explain.stderr || explain.stdout);
    const explicitCalls = readFileSync(path.join(nested, ".graphify-cli-calls.log"), "utf8");
    assert.match(explicitCalls, /^explain alpha --graph alternate\.json$/m);
    assert.equal(existsSync(path.join(repo, ".git", "graphify", "forwarded.log")), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("setup source preserves existing managed config after native hook install and routes final update through manager", () => {
  const src = readFileSync(setup, "utf8");
  const hookInstall = src.indexOf('["-m", "graphify", "hook", "install"]');
  const managedRead = src.indexOf('let managedGraphConfig = readManagedGraphConfig(graphifyDir);');
  const platformLoop = src.indexOf('for (const target of expandGraphifyTargets(activeTargets))');
  const platformInstall = src.indexOf('["-m", "graphify", platform, "install"]');
  const managedRepair = src.indexOf('runManagedGraphLifecycle(graphifyDir, "install", managedGraphConfig)');
  const finalRun = src.indexOf('runManagedGraphLifecycle(graphifyDir, "run", managedGraphConfig)');
  const rawUpdate = src.indexOf('["-m", "graphify", "update", "."]', finalRun);
  assert.ok(hookInstall > 0);
  assert.ok(managedRead > 0);
  assert.ok(platformLoop > hookInstall);
  assert.ok(platformInstall > platformLoop);
  assert.ok(managedRepair > platformInstall, "managed repair must follow platform installers that rewrite AGENTS graphify guidance");
  assert.ok(finalRun > managedRepair, "final refresh must route through manager when config exists");
  assert.ok(rawUpdate > finalRun, "raw update must stay only as the unmanaged fallback branch");
  assert.match(src, /function readManagedGraphConfig\(targetDir\)/);
  assert.match(src, /let managedGraphConfig = readManagedGraphConfig\(graphifyDir\);[\s\S]*?let python = managedGraphConfig/);
  assert.match(src, /reconcileGraphifyPackage\(python, \{/);
  assert.doesNotMatch(src, /managedGraphConfig \? "graphifyy/);
  assert.doesNotMatch(src, /managedConfig\.manager \?\? sourceManager/);
  assert.match(src, /function runManagedGraphLifecycle\(targetDir, action, managedConfig\)/);
});

test("managed lifecycle reference states opt-in POSIX Git-event scope and excludes autosave/model semantics", () => {
  const doc = readFileSync(reference, "utf8");
  assert.match(doc, /opt-in/i);
  assert.match(doc, /POSIX-only/);
  assert.match(doc, /post-commit/);
  assert.match(doc, /post-checkout/);
  assert.match(doc, /post-merge/);
  assert.match(doc, /post-rewrite/);
  assert.match(doc, /same-entry Git alias `meta-graphify`/);
  assert.match(doc, /git meta-graphify run/);
  assert.match(doc, /preserve existing managed memory and reflections material/);
  assert.match(doc, /fixed `current` at `graphify-out`/);
  assert.match(doc, /one previous published graph bundle at `.git\/graphify\/previous`/);
  assert.match(doc, /one candidate bundle at `.git\/graphify\/candidate`/);
  assert.match(doc, /`.git\/graphify\/runtime`/);
  assert.match(doc, /source package or npx cache removal/);
  assert.match(doc, /Explicit `.graphifyignore` matches retire those sources/);
  assert.match(doc, /before historical Gitignored-source protection/);
  assert.match(doc, /2 MiB with three rotated backups/);
  assert.match(doc, /30 days or above 1 GiB/);
  assert.match(doc, /Unknown Graphify output records are retained/);
  assert.match(doc, /does not promise file-save or uncommitted autosave refresh/);
  assert.match(doc, /no model calls/i);
});
