import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
if (args.join(" ") === "--version") { console.log("graphify 0.9.56"); process.exit(0); }
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

function writeFakePython(bin, graphifyBin) {
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const args = process.argv.slice(2);
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
if (args.join(" ") === "-m pip show graphifyy") { console.log("Name: graphifyy\\nVersion: 0.9.56"); process.exit(0); }
if (args[0] === "-c") { console.log(${JSON.stringify(graphifyBin)}); process.exit(0); }
if (args[0] === "-m" && args[1] === "pip" && args[2] === "install") {
  fs.appendFileSync(path.join(process.cwd(), ".pip-install-calls.log"), args.slice(2).join(" ") + "\\n");
  process.exit(0);
}
if (args[0] === "-m" && args[1] === "graphify") {
  fs.appendFileSync(path.join(process.cwd(), ".python-graphify-calls.log"), args.slice(2).join(" ") + " GRAPHIFY_OUT=" + (process.env.GRAPHIFY_OUT || "") + "\\n");
  const result = spawnSync(${JSON.stringify(graphifyBin)}, args.slice(2), { stdio: "inherit", cwd: process.cwd(), env: process.env });
  process.exit(result.status ?? 1);
}
if (args[0]?.endsWith("graphify-managed.py")) manager(args[1]);
process.exit(1);
`);
  chmodSync(bin, 0o755);
}

test("graphify-cli exposes managed commands and routes rebuild through existing managed config", { skip: process.platform === "win32" }, () => {
  const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "meta-kim-managed-cli-")));
  const binDir = path.join(tmp, "bin");
  mkdirSync(binDir);
  const repo = initRepo(tmp);
  writeSeedGraph(repo);
  const graphifyBin = path.join(binDir, "graphify");
  const pythonBin = path.join(binDir, "python3");
  writeFakeGraphify(graphifyBin);
  writeFakePython(pythonBin, graphifyBin);
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
    assert.match(readFileSync(path.join(repo, ".pip-install-calls.log"), "utf8"), /graphifyy==0\.9\.56/);

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
  assert.match(src, /const graphifyPackage = managedGraphConfig \? "graphifyy==0\.9\.56" : "graphifyy"/);
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
