import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync, renameSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInstallerWriteBoundary, assertInstallerWritePath } from "../../scripts/installer-write-boundary.mjs";
import { transactionalReplaceMetaSkillTargets } from "../../scripts/install-global-skills-all-runtimes.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");

test("dependency installer accepts only the configured whole runtime home redirect", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-installer-home-"));
  const home = path.join(root, "user");
  const external = path.join(root, "external");
  const runtime = path.join(home, ".codex");
  mkdirSync(home);
  mkdirSync(external);
  symlinkSync(external, runtime, "junction");
  const env = {
    ...process.env, HOME: home, USERPROFILE: home,
    CODEX_HOME: runtime, META_KIM_CODEX_HOME: runtime,
    META_KIM_SKIP_OPTIONAL_TOOLS: "1",
  };
  const run = () => spawnSync(process.execPath, [
    path.join(repoRoot, "scripts/install-global-skills-all-runtimes.mjs"),
    "--targets", "codex", "--skills", "agent-teams-playbook",
    "--dry-run", "--skip-plugins", "--skip-inventory-refresh",
  ], { cwd: repoRoot, env, encoding: "utf8", timeout: 30_000 });
  try {
    const accepted = run();
    assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
    const outside = path.join(root, "untrusted-skills");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "user-owned.txt"), "preserve\n");
    symlinkSync(outside, path.join(external, "skills"), "junction");
    const refused = run();
    assert.equal(refused.status, 1, `${refused.stdout}\n${refused.stderr}`);
    assert.match(refused.stderr, /Refusing.*(symlink|junction|escape)/);
    assert.equal(readFileSync(path.join(outside, "user-owned.txt"), "utf8"), "preserve\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("configured physical homes work, while internal redirects, store aliases and rebinding fail closed", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-boundary-bindings-"));
  try {
    const home = path.join(root, "home");
    const runtime = path.join(root, "external-runtime");
    const other = path.join(root, "other");
    const store = path.join(root, "store");
    for (const dir of [home, runtime, other, store]) mkdirSync(dir);
    const binding = createInstallerWriteBoundary({ userHome: home, runtimeHomes: [runtime], storeRoot: store });
    assert.doesNotThrow(() => assertInstallerWritePath(path.join(runtime, "skills/new"), binding));
    assert.throws(() => assertInstallerWritePath(path.join(other, "new"), binding), /outside/);
    const skills = path.join(runtime, "skills");
    symlinkSync(other, skills, "junction");
    assert.throws(() => assertInstallerWritePath(path.join(skills, "new"), binding), /symlink|junction|escape/);
    rmSync(skills, { recursive: true });
    const alias = path.join(home, "store-alias");
    symlinkSync(store, alias, "junction");
    const storeAlias = createInstallerWriteBoundary({ userHome: home, runtimeHomes: [alias], storeRoot: store });
    assert.throws(() => assertInstallerWritePath(path.join(alias, "new"), storeAlias), /immutable projection store/);
    renameSync(store, path.join(root, "previous-store"));
    symlinkSync(other, store, "junction");
    assert.throws(() => assertInstallerWritePath(path.join(runtime, "new"), binding), /changed immutable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("transaction rollback and staging cleanup preserve outside content after runtime root rebinding", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-boundary-rollback-"));
  try {
    const home = path.join(root, "home");
    const original = path.join(root, "original");
    const outside = path.join(root, "outside");
    const runtime = path.join(home, ".claude");
    const source = path.join(root, "source");
    for (const dir of [home, original, outside, source]) mkdirSync(dir);
    symlinkSync(original, runtime, "junction");
    const target = path.join(runtime, "skills/meta-skill-creator");
    mkdirSync(target, { recursive: true });
    const skill = "---\nname: meta-skill-creator\ndescription: fixture\n---\n";
    writeFileSync(path.join(source, "SKILL.md"), `${skill}new\n`);
    writeFileSync(path.join(target, "SKILL.md"), `${skill}old\n`);
    const writeBoundary = createInstallerWriteBoundary({ userHome: home, runtimeHomes: [runtime] });
    let injected = false;
    await assert.rejects(transactionalReplaceMetaSkillTargets(source, [target], {
      userHome: home, writeBoundary,
      renameOptions: {
        rename: async (from, to) => {
          renameSync(from, to);
          if (to === target && !injected) {
            injected = true;
            rmSync(runtime, { recursive: true });
            symlinkSync(outside, runtime, "junction");
            for (const dir of [target, from]) {
              mkdirSync(dir, { recursive: true });
              writeFileSync(path.join(dir, "user-owned.txt"), "untouched\n");
            }
            throw new Error("injected runtime root rebinding");
          }
        },
      },
    }), /changed runtime root|recovery was incomplete/);
    assert.equal(injected, true);
    assert.equal(readFileSync(path.join(target, "user-owned.txt"), "utf8"), "untouched\n");
    assert.equal(readdirSync(path.join(outside, "skills")).length, 2, "cleanup must preserve the outside staging sentinel");
    assert.ok(readdirSync(path.join(original, "skills")).some((name) => name.includes("transaction-backup")), "original recovery backup remains available");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
