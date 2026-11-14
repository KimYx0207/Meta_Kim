import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { copyProjectCapability } from "../../scripts/project-capability-copy.mjs";

const REPO_ROOT = path.resolve(".");
const hash = value => createHash("sha256").update(value).digest("hex");

test("reviewed in-place project iteration binds candidate bytes and the current user-edited source", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "meta-kim-reviewed-iteration-"));
  try {
    const projectDir = path.join(temp, "project"), source = path.join(temp, "reviewer.toml");
    await mkdir(projectDir); await writeFile(path.join(projectDir, "package.json"), "{}");
    await writeFile(source, 'name = "reviewer"\ndeveloper_instructions = "Initial maintenance review"\n');
    const options = { projectDir, runtime: "codex", type: "agent", id: "reviewer", source, mode: "iterate", apply: true };
    const original = copyProjectCapability(options);
    const relPath = ".codex/agents/reviewer.toml", target = path.join(projectDir, relPath);
    writeFileSync(target, 'name = "reviewer"\ndeveloper_instructions = "User maintenance boundary"\n');
    const expectedProjectFiles = [{ relPath, sha256: hash(readFileSync(target)) }];
    const revised = 'name = "reviewer"\ndeveloper_instructions = "User maintenance boundary plus audited escalation acceptance"\n';
    await writeFile(source, revised);
    const contentDigest = "sha256:" + hash(JSON.stringify([{ relPath, baselineHash: hash(revised) }]));
    const approvalRef = path.join(projectDir, "review.json");
    const approval = { status: "approved", projectRoot: projectDir, runtime: "codex", capabilityType: "agent", requestedCapability: "reviewer", contentDigest, expectedProjectFiles };
    writeFileSync(approvalRef, JSON.stringify(approval));
    const updated = copyProjectCapability({ ...options, reviewedUpdate: { approvalRef, contentDigest, expectedProjectFiles } });
    assert.equal(updated.ok, true);
    assert.equal(readFileSync(target, "utf8"), revised);
    assert.deepEqual(updated.capability.sourceBaseline, original.capability.sourceBaseline);
    assert.equal(updated.capability.files[0].state, "reviewed_project_update");
    assert.throws(() => copyProjectCapability({ ...options, reviewedUpdate: { approvalRef, contentDigest, expectedProjectFiles } }), /expected file hash changed/u);
    assert.equal(readFileSync(target, "utf8"), revised);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

function runCli(args) {
  return spawnSync(process.execPath, [path.join(REPO_ROOT, "bin", "meta-kim.mjs"), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

test("project capability copy detaches an iterated global Agent from dependency updates", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "meta-kim-project-capability-"));
  try {
    const projectDir = path.join(temp, "project");
    const source = path.join(temp, "global-agent.toml");
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, "package.json"), "{}\n");
    await writeFile(source, 'name = "reviewer"\ndeveloper_instructions = "v1"\n');

    const first = runCli([
      "project", "capability", "copy",
      "--project-dir", projectDir,
      "--runtime", "codex",
      "--type", "agent",
      "--id", "reviewer",
      "--source", source,
      "--mode", "iterate",
      "--apply",
      "--json",
    ]);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const target = path.join(projectDir, ".codex", "agents", "reviewer.toml");
    const manifestPath = path.join(projectDir, ".meta-kim", "state", "default", "project-capabilities.json");
    assert.equal(existsSync(target), true);
    assert.equal(existsSync(manifestPath), true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.capabilities[0].detachedFromDependencyUpdates, true);
    assert.equal(manifest.capabilities[0].policy, "copy_to_project_for_modification");
    assert.equal(manifest.capabilities[0].sourceBaseline.files[0].sha256, manifest.capabilities[0].files[0].baselineHash);
    const originalBaseline = manifest.capabilities[0].sourceBaseline;

    writeFileSync(target, 'name = "reviewer"\ndeveloper_instructions = "project-owned"\n');
    writeFileSync(source, 'name = "reviewer"\ndeveloper_instructions = "dependency-v2"\n');
    const update = runCli([
      "project", "capability", "copy",
      "--project-dir", projectDir,
      "--runtime", "codex",
      "--type", "agent",
      "--id", "reviewer",
      "--source", source,
      "--mode", "iterate",
      "--apply",
      "--json",
    ]);
    assert.equal(update.status, 0, update.stderr || update.stdout);
    assert.match(readFileSync(target, "utf8"), /project-owned/u);
    assert.doesNotMatch(readFileSync(target, "utf8"), /dependency-v2/u);
    const retained = JSON.parse(readFileSync(manifestPath, "utf8")).capabilities[0];
    assert.deepEqual(retained.sourceBaseline, originalBaseline, "An upstream refresh cannot rewrite the project's original source provenance");
    assert.equal(retained.upstreamComparison.status, "source_changed_project_preserved");
    assert.notEqual(retained.upstreamComparison.candidateDigest, originalBaseline.contentDigest);
    assert.deepEqual(retained.upstreamComparison.changedPaths, [".codex/agents/reviewer.toml"]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
test("project capability copy handles Skill directories and Command files without overwriting unknown files", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "meta-kim-project-capability-types-"));
  try {
    const projectDir = path.join(temp, "project");
    const skillDir = path.join(temp, "skill");
    const command = path.join(temp, "command.md");
    await mkdir(projectDir, { recursive: true });
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(projectDir, "AGENTS.md"), "# project\n");
    await writeFile(path.join(skillDir, "SKILL.md"), "# Local skill\n");
    await writeFile(command, "# Local command\n");
    for (const args of [
      ["--runtime", "codex", "--type", "skill", "--id", "local-skill", "--source", skillDir],
      ["--runtime", "codex", "--type", "command", "--id", "local-command", "--source", command],
    ]) {
      const result = runCli(["project", "capability", "copy", "--project-dir", projectDir, ...args, "--mode", "create", "--apply"]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
    assert.equal(existsSync(path.join(projectDir, ".agents", "skills", "local-skill", "SKILL.md")), true);
    assert.equal(existsSync(path.join(projectDir, ".codex", "commands", "local-command.md")), true);

    const unknown = path.join(projectDir, ".codex", "commands", "unknown.md");
    await writeFile(unknown, "user-owned\n");
    const conflictSource = path.join(temp, "unknown.md");
    await writeFile(conflictSource, "dependency-owned\n");
    const conflict = runCli([
      "project", "capability", "copy", "--project-dir", projectDir,
      "--runtime", "codex", "--type", "command", "--id", "unknown",
      "--source", conflictSource, "--mode", "create", "--apply",
    ]);
    assert.notEqual(conflict.status, 0);
    assert.equal(readFileSync(unknown, "utf8"), "user-owned\n");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
