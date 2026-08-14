import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const hookPath = path.join(
  repoRoot,
  "canonical",
  "runtime-assets",
  "claude",
  "memory-hooks",
  "mcp_memory_global.py",
);

function availableCommand(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const python = availableCommand([process.env.PYTHON, "python3", "python"]);
const git = availableCommand(["git"]);

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
  );
  return result.stdout.trim();
}

function resolvedProjectRoot(cwd) {
  const script = [
    "import importlib.util, json, os, sys",
    "os.chdir(sys.argv[2])",
    "spec = importlib.util.spec_from_file_location('mcp_memory_global_test', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "print(json.dumps({'root': os.path.realpath(module.project_root())}))",
  ].join("; ");
  return JSON.parse(run(python, ["-c", script, hookPath, cwd], cwd)).root;
}

function comparable(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

test(
  "MCP memory project root follows Git worktree identity without escaping bare repositories",
  { skip: !python || !git },
  () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "meta-kim-memory-root-"));
    const mainRepo = path.join(fixture, "main");
    const linkedWorktree = path.join(fixture, "linked");
    const childRepo = path.join(fixture, "child");
    const submodule = path.join(mainRepo, "submodule");
    const nonRepo = path.join(fixture, "outside");
    const bareRepo = path.join(fixture, "project.git");
    const bareWorktree = path.join(fixture, "bare-linked");

    try {
      mkdirSync(mainRepo, { recursive: true });
      mkdirSync(childRepo, { recursive: true });
      mkdirSync(nonRepo, { recursive: true });
      run(git, ["init", "-q"], mainRepo);
      run(
        git,
        ["-c", "user.name=MetaKimTest", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "init", "-q"],
        mainRepo,
      );
      run(git, ["worktree", "add", "-q", linkedWorktree, "HEAD"], mainRepo);

      run(git, ["init", "-q"], childRepo);
      run(
        git,
        ["-c", "user.name=MetaKimTest", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "init", "-q"],
        childRepo,
      );
      run(
        git,
        ["-c", "protocol.file.allow=always", "submodule", "add", "-q", childRepo, "submodule"],
        mainRepo,
      );

      run(git, ["clone", "--bare", "-q", mainRepo, bareRepo], fixture);
      run(git, [`--git-dir=${bareRepo}`, "worktree", "add", "-q", bareWorktree, "HEAD"], fixture);

      assert.equal(comparable(resolvedProjectRoot(mainRepo)), comparable(mainRepo));
      assert.equal(comparable(resolvedProjectRoot(linkedWorktree)), comparable(mainRepo));
      assert.equal(comparable(resolvedProjectRoot(submodule)), comparable(submodule));
      assert.equal(comparable(resolvedProjectRoot(nonRepo)), comparable(nonRepo));
      assert.equal(comparable(resolvedProjectRoot(bareWorktree)), comparable(bareWorktree));
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  },
);
