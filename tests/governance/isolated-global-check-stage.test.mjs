import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { parseIsolatedGlobalHome, verificationStageEnvironment, RELEASE_RUNTIME_TARGETS, STAGES } from "../../scripts/run-verify-all.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-global-check-scope-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("isolated global check accepts only an explicit existing plain home distinct from caller", () => {
  assert.equal(parseIsolatedGlobalHome([]), null);
  assert.equal(parseIsolatedGlobalHome(["--isolated-global-home", root]), root);
  const file = path.join(root, "file");
  writeFileSync(file, "fixture");
  for (const args of [["--isolated-global-home"], ["--isolated-global-home", "relative"], ["--isolated-global-home", root, "--isolated-global-home", root], [`--isolated-global-home=${root}`], ["--isolated-global-home", os.homedir()], ["--isolated-global-home", file], ["--isolated-global-home", path.join(root, "missing")]]) {
    assert.throws(() => parseIsolatedGlobalHome(args));
  }
});

test("physical caller home aliases cannot masquerade as an isolated global directory", context => {
  if (process.platform === "win32") {
    for (const value of [os.homedir().toUpperCase(), path.toNamespacedPath(os.homedir())]) {
      assert.throws(() => parseIsolatedGlobalHome(["--isolated-global-home", value]));
    }
  }
  const alias = path.join(root, "home-alias");
  try { symlinkSync(os.homedir(), alias, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return context.skip(`directory alias fixture unavailable: ${error.code}`); throw error; }
  assert.throws(() => parseIsolatedGlobalHome(["--isolated-global-home", alias]));
  const physical = path.join(root, "physical-parent");
  mkdirSync(path.join(physical, "nested"), { recursive: true });
  const ancestorAlias = path.join(root, "ancestor-alias");
  symlinkSync(physical, ancestorAlias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => parseIsolatedGlobalHome(["--isolated-global-home", path.join(ancestorAlias, "nested")]));
});

test("only the unchanged exact global check stage receives the confined HOME and runtime homes", () => {
  const environment = { PATH: process.env.PATH, HOME: "/original-home", USERPROFILE: "/original-home", CODEX_HOME: "/original-codex", META_KIM_CLAUDE_HOME: "/original-claude", META_KIM_PROJECTION_PACKAGE_STORE_ROOT: "/original-store", CLAUDE_CONFIG_DIR: "/original-config", META_KIM_CLAUDE_USER_CONFIG: "/original-auth", NPM_CONFIG_CACHE: "/original-cache", harmless: "keep" };
  for (const stage of STAGES.filter(stage => stage.name !== "meta:check:global:release")) {
    assert.deepEqual(verificationStageEnvironment(stage.name, { isolatedGlobalHome: root, environment }), { environment, scope: null });
  }
  const isolated = verificationStageEnvironment("meta:check:global:release", { isolatedGlobalHome: root, environment });
  assert.equal(isolated.environment.HOME, root);
  assert.equal(isolated.environment.USERPROFILE, root);
  assert.equal(isolated.environment.CODEX_HOME, path.join(root, ".codex"));
  assert.equal(isolated.environment.CLAUDE_CONFIG_DIR, path.join(root, ".claude"));
  assert.equal(isolated.environment.META_KIM_CLAUDE_USER_CONFIG, path.join(root, ".claude.json"));
  assert.equal(isolated.environment.META_KIM_PROJECTION_PACKAGE_STORE_ROOT, undefined);
  assert.equal(isolated.environment.harmless, "keep");
  assert.deepEqual(Object.keys(isolated.scope.runtimeHomes).sort(), [...RELEASE_RUNTIME_TARGETS].sort());
  assert.equal(isolated.scope.personalGlobalUpdated, false);
  assert.equal(isolated.scope.readOnly, true);
  assert.equal(STAGES.find(stage => stage.name === "meta:check:global:release").cmd, "npm run meta:check:global:release");
  const packageJson = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../package.json"), "utf8"));
  assert.match(packageJson.scripts["meta:check:global:release"], /--check/u);
  assert.deepEqual(verificationStageEnvironment("meta:check:global:release", { environment }), { environment, scope: null });
});

test("a selected empty home still fails the real installed global authority check", () => {
  const isolated = verificationStageEnvironment("meta:check:global:release", { isolatedGlobalHome: root });
  const result = spawnSync(process.execPath, ["scripts/sync-global-meta-theory.mjs", "--check", "--with-global-hooks"], { cwd: path.resolve(import.meta.dirname, "../.."), env: isolated.environment, encoding: "utf8", timeout: 30000, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /missing|not found|未|缺|manifest|authority/iu);
});
