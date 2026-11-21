import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GRAPHIFY_PACKAGE, GRAPHIFY_VERSION } from "../../scripts/graphify-package-install.mjs";

// End-to-end coverage for the third Graphify entry point. The activation hook
// launches scripts/project-post-copy-init.mjs (`--auto` -> `--auto-worker`) in
// every Git project; these tests run that real script against stubbed,
// network-free python/graphify executables.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const postCopy = path.join(root, "scripts", "project-post-copy-init.mjs");
const HOOK_EVENTS = ["post-commit", "post-checkout", "post-merge", "post-rewrite"];
const skip = process.platform === "win32";

// Graphify and graphify-managed.py share these marker stems; post-checkout
// uses its own stem (graphify hooks.py, graphify-managed.py hook_block()).
const stem = (event) => (event === "post-checkout" ? "graphify-checkout-hook" : "graphify-hook");

// In-place replacement of the marker block, preserving bytes outside it.
const REPLACE_BLOCK_SOURCE = `function replaceBlock(file, stem, body) {
  const start = "# " + stem + "-start", end = "# " + stem + "-end";
  const block = start + "\\n" + body + "\\n" + end;
  const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "#!/bin/sh\\n";
  const i = old.indexOf(start), j = old.indexOf(end);
  const next = i >= 0 && j > i ? old.slice(0, i) + block + old.slice(j + end.length) : old + block + "\\n";
  fs.writeFileSync(file, next);
}
function stem(event) { return event === "post-checkout" ? "graphify-checkout-hook" : "graphify-hook"; }`;

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function writeFakeGraphify(bin, { hookFails }) {
  // Native `hook install` rewrites only post-commit and post-checkout.
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
${REPLACE_BLOCK_SOURCE}
const args = process.argv.slice(2).join(" ");
fs.appendFileSync(path.join(process.cwd(), ".graphify-calls.log"), args + "\\n");
if (args === "hook install") {
  const hooks = path.join(process.cwd(), ".git", "hooks");
  for (const event of ["post-commit", "post-checkout"]) replaceBlock(path.join(hooks, event), stem(event), "raw graphify hook");
  process.exit(${hookFails ? 3 : 0});
}
process.exit(0);
`);
  chmodSync(bin, 0o755);
}

function writeFakePython(bin, graphifyBin, { initialVersion, pipFails = false, networkxVersion = "3.5", managerFails = null }) {
  writeFileSync(`${bin}.version`, initialVersion ?? "");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
${REPLACE_BLOCK_SOURCE}
const args = process.argv.slice(2);
fs.appendFileSync(process.argv[1] + ".calls.jsonl", JSON.stringify(args) + "\\n");
if (args.join(" ") === "--version") { console.log("Python 3.12.0"); process.exit(0); }
if (args.join(" ") === "-m pip --version") { console.log("pip 24.0"); process.exit(0); }
if (args.join(" ") === "-m pip show networkx") { console.log("Name: networkx\\nVersion: ${networkxVersion}"); process.exit(0); }
if (args.join(" ") === "-m pip show graphifyy") {
  const version = fs.readFileSync(process.argv[1] + ".version", "utf8");
  if (!version) process.exit(1);
  console.log("Name: graphifyy\\nVersion: " + version); process.exit(0);
}
if (args[0] === "-m" && args[1] === "pip" && args[2] === "install") {
  const spec = args.at(-1);
  if (${pipFails} && spec.startsWith("graphifyy")) process.exit(2);
  if (spec.includes("graphifyy==")) fs.writeFileSync(process.argv[1] + ".version", spec.split("==")[1]);
  else if (spec === "graphifyy") fs.writeFileSync(process.argv[1] + ".version", "9.9.9");
  process.exit(0);
}
if (args[0] === "-m" && args[1] === "graphify") {
  const result = spawnSync(${JSON.stringify(graphifyBin)}, args.slice(2), { stdio: "inherit", cwd: process.cwd() });
  process.exit(result.status ?? 1);
}
if (args[0]?.endsWith("graphify-managed.py")) {
  const command = args[1];
  const repo = args[args.indexOf("--repo") + 1];
  fs.appendFileSync(path.join(repo, ".git", "graphify", "calls.log"), command + "\\n");
  if (command === ${JSON.stringify(managerFails)}) process.exit(7);
  if (command === "install") {
    for (const event of ${JSON.stringify(HOOK_EVENTS)}) {
      replaceBlock(path.join(repo, ".git", "hooks", event), stem(event), "managed request --event " + event);
    }
  }
  process.exit(0);
}
process.exit(0);
`);
  chmodSync(bin, 0o755);
}

function readLines(file) {
  return existsSync(file) ? readFileSync(file, "utf8").trim().split(/\r?\n/u).filter(Boolean) : [];
}

function fixture(t, { managed = false, initialVersion = GRAPHIFY_VERSION, pipFails = false, networkxVersion,
  managerFails = null, hookFails = false, config } = {}) {
  const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "meta-kim-post-copy-managed-")));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const binDir = path.join(tmp, "bin");
  const managedDir = path.join(tmp, "managed-venv", "bin"); // deliberately not on PATH
  const repo = path.join(tmp, "repo");
  mkdirSync(binDir);
  mkdirSync(managedDir, { recursive: true });
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  const graphifyBin = path.join(binDir, "graphify");
  const pathPython = path.join(binDir, "python3");
  const managedPython = path.join(managedDir, "python3");
  writeFakeGraphify(graphifyBin, { hookFails });
  writeFakePython(pathPython, graphifyBin, { initialVersion, pipFails, networkxVersion, managerFails });
  writeFakePython(managedPython, graphifyBin, { initialVersion, pipFails, networkxVersion, managerFails });
  const hooksDir = path.join(repo, ".git", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  if (managed) {
    for (const event of HOOK_EVENTS) {
      writeFileSync(path.join(hooksDir, event),
        `#!/bin/sh\necho custom-before\n# ${stem(event)}-start\nmanaged request --event ${event}\n# ${stem(event)}-end\necho custom-after\n`);
    }
    const state = path.join(repo, ".git", "graphify");
    mkdirSync(state);
    // Same keys that graphify-managed.py `install` writes to config.json.
    writeFileSync(path.join(state, "config.json"), config ?? JSON.stringify({
      schema: 1, owner: "Meta_Kim", repo, python: managedPython,
      manager: path.join(state, "runtime", "graphify-managed.py"),
      producer: path.join(state, "runtime", "graphify-managed-producer.py"),
      alias: "!managed-alias", graphifyVersion: GRAPHIFY_VERSION,
    }, null, 2) + "\n");
  }
  const initialHooks = Object.fromEntries(HOOK_EVENTS.map((event) => [event, managed ? readFileSync(path.join(hooksDir, event), "utf8") : null]));
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.META_KIM_POST_COPY_AUTO;
  const calls = (bin) => readLines(`${bin}.calls.jsonl`).map((line) => JSON.parse(line));
  return {
    repo, initialHooks,
    run: () => spawnSync(process.execPath, [postCopy, "--auto-worker"], { cwd: repo, env, encoding: "utf8", timeout: 30_000 }),
    managedCalls: () => calls(managedPython),
    pathCalls: () => calls(pathPython),
    graphifyCalls: () => readLines(path.join(repo, ".graphify-calls.log")),
    managerCalls: () => readLines(path.join(repo, ".git", "graphify", "calls.log")),
    hook: (event) => readFileSync(path.join(hooksDir, event), "utf8"),
    marker: () => {
      const file = path.join(repo, ".meta-kim", "state", "default", "post-copy-init.json");
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    },
  };
}

const pipInstalls = (calls, name) => calls.filter((args) => args[1] === "pip" && args[2] === "install" && args.at(-1).startsWith(name));

function assertManagedHooksUntouched(f) {
  for (const event of HOOK_EVENTS) assert.equal(f.hook(event), f.initialHooks[event], `${event} must be unchanged`);
}

test("post-copy init keeps every managed hook block and refreshes through the manager", { skip }, (t) => {
  const f = fixture(t, { managed: true });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const event of HOOK_EVENTS) {
    const hook = f.hook(event);
    assert.match(hook, new RegExp(`# ${stem(event)}-start\\nmanaged request --event ${event}\\n# ${stem(event)}-end`));
    assert.doesNotMatch(hook, /raw graphify hook/u, `${event} must not keep the native block`);
    assert.match(hook, /custom-before[\s\S]*custom-after/u, `${event} custom bytes must survive`);
  }
  assert.deepEqual(f.managerCalls(), ["install", "run"]);
  assert.equal(f.graphifyCalls().includes("update ."), false, "managed refresh must not run a raw graphify update");
  assert.deepEqual(f.pathCalls(), [], "the PATH interpreter must not be used when a managed config names one");
  const calls = f.managedCalls().map((args) => args.join(" "));
  const nativeHook = calls.indexOf("-m graphify hook install");
  const lastPlatform = calls.findLastIndex((call) => /^-m graphify (claude|codex) install$/u.test(call));
  const repair = calls.findIndex((call) => call.endsWith(" install --repo " + f.repo));
  assert.ok(nativeHook >= 0 && lastPlatform > nativeHook, "native installers still run first");
  assert.ok(repair > lastPlatform, "manager repair must follow the last native installer");
  assert.deepEqual(pipInstalls(f.managedCalls(), "networkx"), [], "a compatible networkx is not upgraded again");
  assert.equal(f.marker()?.status, "passed");
});

test("post-copy init reconciles a managed interpreter to the shared Graphify pin", { skip }, (t) => {
  const f = fixture(t, { managed: true, initialVersion: null, networkxVersion: "3.2" });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(pipInstalls(f.managedCalls(), "graphifyy"), [["-m", "pip", "install", GRAPHIFY_PACKAGE]]);
  assert.deepEqual(pipInstalls(f.managedCalls(), "networkx"), [["-m", "pip", "install", "--upgrade", "networkx>=3.4"]]);
  assert.deepEqual(f.pathCalls(), []);
});

test("post-copy init stops before any installer when the managed pin cannot be applied", { skip }, (t) => {
  const f = fixture(t, { managed: true, initialVersion: "0.0.1", pipFails: true });
  const result = f.run();
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /graphify_package_install_failed/u);
  assert.deepEqual(f.pathCalls(), []);
  assert.deepEqual(f.graphifyCalls(), [], "no native installer may run");
  assert.deepEqual(f.managerCalls(), []);
  assertManagedHooksUntouched(f);
  assert.equal(f.marker()?.status, "failed");
});

test("post-copy init fails closed on an unreadable managed config without touching hooks", { skip }, (t) => {
  const f = fixture(t, { managed: true, config: "{not json" });
  const result = f.run();
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /Cannot read managed Graphify config/u);
  assert.deepEqual(f.pathCalls(), []);
  assert.deepEqual(f.graphifyCalls(), [], "no native installer or raw update may run");
  assertManagedHooksUntouched(f);
  assert.equal(f.marker()?.status, "failed");
});

test("post-copy init fails closed on a managed config without an interpreter", { skip }, (t) => {
  const f = fixture(t, { managed: true, config: "{}" });
  const result = f.run();
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /has no python interpreter/u);
  assert.deepEqual(f.pathCalls(), []);
  assert.deepEqual(f.graphifyCalls(), []);
  assertManagedHooksUntouched(f);
  assert.equal(f.marker()?.status, "failed");
});

test("post-copy init repairs managed hooks before reporting a failed native hook install", { skip }, (t) => {
  const f = fixture(t, { managed: true, hookFails: true });
  const result = f.run();
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /managed hooks were repaired/u);
  assert.deepEqual(f.pathCalls(), []);
  assert.deepEqual(f.managerCalls(), ["install"], "repair runs, refresh does not");
  for (const event of HOOK_EVENTS) assert.match(f.hook(event), /managed request/u);
  assert.equal(f.graphifyCalls().includes("update ."), false);
  assert.equal(f.marker()?.status, "failed");
});

test("post-copy init stops before a raw update when the manager repair fails", { skip }, (t) => {
  const f = fixture(t, { managed: true, managerFails: "install" });
  const result = f.run();
  assert.notEqual(result.status, 0, result.stdout);
  assert.deepEqual(f.managerCalls(), ["install"]);
  assert.equal(f.graphifyCalls().includes("update ."), false);
  assert.deepEqual(f.pathCalls(), []);
  assert.equal(f.marker()?.status, "failed");
});

test("post-copy init without managed config keeps the native flow unchanged", { skip }, (t) => {
  const f = fixture(t, { initialVersion: null });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(f.managerCalls(), []);
  assert.deepEqual(f.managedCalls(), []);
  assert.ok(f.graphifyCalls().includes("hook install"));
  assert.equal(f.graphifyCalls().at(-1), "update .", "ordinary projects still finish with the native update");
  assert.deepEqual(pipInstalls(f.pathCalls(), "graphifyy"), [["-m", "pip", "install", "graphifyy"]], "unmanaged package handling is out of scope here");
  assert.deepEqual(pipInstalls(f.pathCalls(), "networkx"), [["-m", "pip", "install", "--upgrade", "networkx>=3.4"]]);
  assert.match(f.hook("post-commit"), /raw graphify hook/u);
  assert.equal(f.marker()?.status, "passed");
});

test("post-copy init without managed config still stops on a failed native hook install", { skip }, (t) => {
  const f = fixture(t, { hookFails: true });
  const result = f.run();
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /Command failed: -m graphify hook install/u);
  assert.deepEqual(f.graphifyCalls(), ["hook install"]);
  assert.equal(f.marker()?.status, "failed");
});
