import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openRecorder, readManifest, manifestPathFor } from "../../scripts/install-manifest.mjs";
import { retireAbsorbedDependencyCopies } from "../../src/infrastructure/installer/retired-dependency-copies.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
function sandbox(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-retired-method-"));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = root; process.env.USERPROFILE = root;
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } rmSync(root, { recursive: true, force: true }); });
  const homes = Object.fromEntries(["claude", "codex", "cursor"].map((id) => [id, path.join(root, `.${id}`)]));
  return { root, homes };
}
function put(target, body = "Standalone source and license remain upstream.\n") {
  mkdirSync(target, { recursive: true }); writeFileSync(path.join(target, "SKILL.md"), body);
}
async function own(target) {
  const recorder = openRecorder({ scope: "global", metaKimVersion: "test" });
  recorder.recordDir(target, { category: "A", source: "install-global-skills-all-runtimes", purpose: "kim-decision-global-skill" });
  const result = await recorder.flush(); assert.equal(result.ok, true, result.error);
}

test("retirement removes only the unchanged owned copy and preserves edited, unknown and project copies", async (t) => {
  const { root, homes } = sandbox(t);
  const owned = path.join(homes.claude, "skills/kim-decision");
  const edited = path.join(homes.codex, "skills/kim-decision");
  const unknown = path.join(homes.cursor, "skills/kim-decision");
  const project = path.join(root, "project/.agents/skills/kim-decision");
  for (const target of [owned, edited, unknown, project]) put(target);
  await own(owned); await own(edited);
  writeFileSync(path.join(edited, "user-notes.txt"), "user work\n");
  const beforeEdited = readFileSync(path.join(edited, "SKILL.md"));
  const preview = await retireAbsorbedDependencyCopies({ repoRoot, homes, dryRun: true });
  assert.deepEqual(preview.planned.map((entry) => entry.path), [owned]);
  assert.equal(existsSync(owned), true);
  const result = await retireAbsorbedDependencyCopies({ repoRoot, homes });
  assert.deepEqual(result.removed.map((entry) => entry.path), [owned]);
  assert.deepEqual(result.preserved.map((entry) => entry.reason).sort(), ["exact_install_ownership_missing", "owned_content_changed"]);
  assert.equal(existsSync(owned), false);
  assert.deepEqual(readFileSync(path.join(edited, "SKILL.md")), beforeEdited);
  for (const target of [edited, unknown, project]) assert.equal(existsSync(target), true);
  const ledger = readManifest(manifestPathFor("global"));
  assert.equal(ledger.entries.some((entry) => entry.path === owned), false);
  assert.equal(ledger.entries.some((entry) => entry.path === edited), true);
  const again = await retireAbsorbedDependencyCopies({ repoRoot, homes });
  assert.deepEqual(again.removed, []);
});

test("a manifest flush failure restores the directory and its original ownership", async (t) => {
  const { homes } = sandbox(t); const target = path.join(homes.claude, "skills/kim-decision");
  put(target); await own(target);
  const before = readFileSync(manifestPathFor("global"));
  await assert.rejects(retireAbsorbedDependencyCopies({ repoRoot, homes,
    recorderFactory: () => ({ forget() {}, flush: async () => ({ ok: false, error: "simulated write failure" }) }),
  }), /manifest update failed/u);
  assert.equal(existsSync(path.join(target, "SKILL.md")), true);
  assert.deepEqual(readFileSync(manifestPathFor("global")), before);
  assert.equal(readdirSync(path.dirname(target)).some((name) => name.startsWith(".meta-kim-retire-")), false);
});

test("redirected skill paths preserve the link and outside content", async (t) => {
  const { root, homes } = sandbox(t);
  const outside = path.join(root, "independent-service"); put(outside);
  const target = path.join(homes.claude, "skills/kim-decision"); mkdirSync(path.dirname(target), { recursive: true });
  symlinkSync(outside, target, process.platform === "win32" ? "junction" : "dir");
  const result = await retireAbsorbedDependencyCopies({ repoRoot, homes });
  assert.equal(result.preserved[0].reason, "unsafe_or_redirected_path");
  assert.equal(existsSync(path.join(outside, "SKILL.md")), true);
  assert.equal(existsSync(target), true);
});

test("runtime aliases pointing to one exact owned target retire it once", async (t) => {
  const { homes } = sandbox(t); const target = path.join(homes.claude, "skills/kim-decision");
  put(target); await own(target);
  const result = await retireAbsorbedDependencyCopies({ repoRoot, homes: { claude: homes.claude, codex: homes.claude } });
  assert.equal(result.removed.length, 1);
  assert.equal(existsSync(target), false);
});

test("a scoped installer preserves retired copies unless whole-setup retirement is explicitly requested", async (t) => {
  const { root, homes } = sandbox(t); const target = path.join(homes.claude, "skills/kim-decision");
  put(target); await own(target);
  const args = [path.join(repoRoot, "scripts/install-global-skills-all-runtimes.mjs"), "--targets", "claude", "--skills", "", "--skip-plugins", "--skip-inventory-refresh", "--update"];
  const env = { ...process.env, META_KIM_CLAUDE_HOME: homes.claude, META_KIM_SKILL_IDS: "", META_KIM_LOCAL_DEPENDENCY_ROOT: path.join(root, "missing-source") };
  const run = (extra = []) => spawnSync(process.execPath, [...args, ...extra], { cwd: root, env, encoding: "utf8", timeout: 30000 });
  const scoped = run(); assert.equal(scoped.status, 0, scoped.stdout + scoped.stderr);
  assert.equal(existsSync(target), true);
  const maintained = run(["--retire-absorbed"]); assert.equal(maintained.status, 0, maintained.stdout + maintained.stderr);
  assert.match(maintained.stdout, /Retired absorbed dependency: kim-decision/u);
  assert.equal(existsSync(target), false);
});
