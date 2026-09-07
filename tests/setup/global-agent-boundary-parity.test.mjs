import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync, realpathSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import os from "node:os";
import { recordSetupRuntimeExecutableBindings } from "../../scripts/runtime-executable-binding.mjs";

const repoRoot = join(import.meta.dirname, "..", "..");
const fixturePackages = new WeakMap();

const NINE_AGENTS = [
  "meta-warden",
  "meta-conductor",
  "meta-genesis",
  "meta-artisan",
  "meta-sentinel",
  "meta-librarian",
  "meta-prism",
  "meta-scout",
  "meta-chrysalis",
];

function runGlobalSync(env, extraArgs = []) {
  if (extraArgs.includes("--check")) {
    recordSetupRuntimeExecutableBindings({
      roots: [env.HOME], targets: ["claude", "codex"],
      pathResolver: () => process.execPath,
    });
  }
  const result = spawnSync(
    process.execPath,
    [join(fixturePackages.get(env) ?? repoRoot, "scripts/sync-global-meta-theory.mjs"), "--targets", "claude,codex", "--with-global-hooks", "--skip-durable-mcp", ...extraArgs],
    { cwd: repoRoot, env, encoding: "utf8", timeout: 240_000 },
  );
  if (result.status === 0 && !fixturePackages.has(env)) {
    const manifest = JSON.parse(readFileSync(join(env.HOME, ".meta-kim/install-manifest.json"), "utf8"));
    const entry = manifest.entries.find((item) => item.purpose === "primary-runtime-global-projection-package-runtime-bundle:receipt");
    assert.ok(entry, "fixture must bind the exact materialized package");
    const receipt = JSON.parse(readFileSync(entry.path, "utf8"));
    fixturePackages.set(env, resolve(dirname(entry.path), receipt.packageRootRelative));
  }
  return result;
}

function isolatedHomeEnv(root) {
  return {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    META_KIM_CLAUDE_HOME: join(root, ".claude"),
    META_KIM_CODEX_HOME: join(root, ".codex"),
    META_KIM_PROJECTION_PACKAGE_STORE_ROOT: join(root, "projection-store"),
  };
}

/**
 * Redirect a single managed asset directory out of the runtime home using a
 * junction. Windows refuses file/dir symlinks without Developer Mode or
 * elevation, so junctions are the only portable way to express the layout the
 * external-skill-storage report described.
 */
function redirectAgentsDirOutsideHome(claudeHome, externalStore) {
  const agentsDir = join(claudeHome, "agents");
  cpSync(agentsDir, externalStore, { recursive: true, dereference: true });
  rmSync(agentsDir, { recursive: true, force: true });
  symlinkSync(externalStore, agentsDir, "junction");
}

test("global agent check and write path agree on an out-of-home agent redirect", async () => {
  const root = mkdtempSync(join(os.tmpdir(), "meta-kim-agent-boundary-"));
  try {
    const claudeHome = join(root, ".claude");
    const env = isolatedHomeEnv(root);

    const seeded = runGlobalSync(env);
    assert.equal(seeded.status, 0, `${seeded.stderr}\n${seeded.stdout}`);

    // Baseline: plain files inside the runtime home are the supported shape and
    // both gates must accept them.
    const baselineCheck = runGlobalSync(env, ["--check"]);
    assert.equal(baselineCheck.status, 0, `${baselineCheck.stderr}\n${baselineCheck.stdout}`);
    assert.match(
      baselineCheck.stdout,
      new RegExp(`claude global agents: ${NINE_AGENTS.length}/${NINE_AGENTS.length}`),
      `real files in-home must count as in sync:\n${baselineCheck.stdout}`,
    );
    assert.doesNotMatch(baselineCheck.stdout, /resolve outside the configured runtime homes/);

    redirectAgentsDirOutsideHome(claudeHome, join(root, "external-store", "claude-agents"));

    // The write path refuses this layout because the real target escapes every
    // configured runtime home.
    const write = runGlobalSync(env);
    assert.equal(write.status, 1, `write path must refuse the redirect:\n${write.stdout}`);
    assert.match(
      `${write.stdout}${write.stderr}`,
      /Refusing to follow a symlink or junction outside configured runtime homes/,
    );

    // The check path must reach the same verdict about the same bytes. Reading
    // content through the redirect would report a full count and contradict the
    // write path.
    const check = runGlobalSync(env, ["--check"]);
    assert.equal(check.status, 1, `check must not pass a refused layout:\n${check.stdout}`);
    assert.match(
      check.stdout,
      new RegExp(`claude global agents: 0/${NINE_AGENTS.length}`),
      `redirected agents must not be counted as in sync:\n${check.stdout}`,
    );
    assert.match(check.stdout, /resolve outside the configured runtime homes/);
    for (const agentId of NINE_AGENTS) {
      assert.match(
        check.stdout,
        new RegExp(`${agentId}\\.md`),
        `check must name the unbound agent ${agentId}:\n${check.stdout}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("global agent check accepts a whole runtime home redirected outside the user home", async () => {
  const root = mkdtempSync(join(os.tmpdir(), "meta-kim-agent-home-redirect-"));
  try {
    const claudeHome = join(root, ".claude");
    const env = isolatedHomeEnv(root);

    const seeded = runGlobalSync(env);
    assert.equal(seeded.status, 0, `${seeded.stderr}\n${seeded.stdout}`);

    // Redirecting the whole runtime home keeps every managed asset inside the
    // root the guard resolves, so aggregated external storage stays supported.
    const externalHome = join(root, "external-store", "claude-home");
    cpSync(realpathSync(claudeHome), externalHome, { recursive: true, dereference: true });
    rmSync(claudeHome, { recursive: true, force: true });
    symlinkSync(externalHome, claudeHome, "junction");

    const check = runGlobalSync(env, ["--check"]);
    assert.equal(check.status, 0, `${check.stderr}\n${check.stdout}`);
    assert.match(
      check.stdout,
      new RegExp(`claude global agents: ${NINE_AGENTS.length}/${NINE_AGENTS.length}`),
      `whole-home redirect must stay in sync:\n${check.stdout}`,
    );
    assert.doesNotMatch(check.stdout, /resolve outside the configured runtime homes/);

    const write = runGlobalSync(env);
    assert.equal(write.status, 0, `write path must accept a whole-home redirect:\n${write.stdout}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
