import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializeGraphifyWorktreeSnapshot } from "../../scripts/graphify-worktree-snapshot.mjs";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function inventory(repo) {
  const deleted = new Set(git(repo, ["ls-files", "--deleted", "-z"]).split("\0"));
  return git(repo, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0").filter(file => file && !deleted.has(file)).sort();
}

function snapshot(repo) {
  return { repoRoot: repo, repositoryFiles: inventory(repo) };
}

function bytes(repo) {
  return inventory(repo).map(file => [file, readFileSync(path.join(repo, file)).toString("hex")]);
}

function fixture(t, initial = {}) {
  const temp = mkdtempSync(path.join(os.tmpdir(), "meta-kim-graphify-snapshot-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, "source");
  const workspace = path.join(temp, "isolated");
  mkdirSync(source);
  git(source, ["init"]);
  git(source, ["config", "user.email", "test@example.invalid"]);
  git(source, ["config", "user.name", "Graphify snapshot test"]);
  const files = { ".gitignore": "graphify-out/\nignored/\n", "kept.txt": "original\n", ...initial };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    writeFileSync(path.join(source, file), content);
  }
  git(source, ["add", "."]);
  git(source, ["commit", "-m", "seed disposable snapshot"]);
  git(source, ["worktree", "add", "--detach", workspace, "HEAD"]);
  return { source, workspace, temp };
}

test("isolated snapshots mirror deletions, renames and untracked bytes without changing source or Git metadata", t => {
  const { source, workspace } = fixture(t, { "deleted.txt": "retired\n", "old.txt": "renamed\n" });
  rmSync(path.join(source, "deleted.txt"));
  renameSync(path.join(source, "old.txt"), path.join(source, "new.txt"));
  writeFileSync(path.join(source, "kept.txt"), "current\r\n");
  writeFileSync(path.join(source, "new asset.bin"), Buffer.from([0xff, 0xfe, 0, 13, 10]));
  mkdirSync(path.join(source, "ignored"));
  writeFileSync(path.join(source, "ignored", "private.txt"), "keep in source only");
  mkdirSync(path.join(workspace, "graphify-out"));
  writeFileSync(path.join(workspace, "graphify-out", "stale.json"), "{}");
  const sourceBefore = bytes(source);
  const sourceIndexBefore = readFileSync(path.join(source, ".git", "index"));
  const metadataBefore = readFileSync(path.join(workspace, ".git"));

  materializeGraphifyWorktreeSnapshot(snapshot(source), workspace);

  assert.deepEqual(bytes(workspace), sourceBefore);
  assert.deepEqual(bytes(source), sourceBefore);
  assert.deepEqual(readFileSync(path.join(source, ".git", "index")), sourceIndexBefore);
  assert.deepEqual(readFileSync(path.join(workspace, ".git")), metadataBefore);
  assert.equal(existsSync(path.join(workspace, "deleted.txt")), false);
  assert.equal(existsSync(path.join(workspace, "old.txt")), false);
  assert.equal(existsSync(path.join(workspace, "ignored")), false);
  assert.equal(existsSync(path.join(workspace, "graphify-out")), false);
  assert.equal(readFileSync(path.join(source, "ignored", "private.txt"), "utf8"), "keep in source only");
  assert.equal(git(workspace, ["rev-parse", "HEAD"]), git(source, ["rev-parse", "HEAD"]));
});

test("isolated snapshots handle tracked file-to-directory and directory-to-file replacements", t => {
  const { source, workspace } = fixture(t, { "file": "old file", "directory/old.txt": "old child" });
  rmSync(path.join(source, "file"));
  mkdirSync(path.join(source, "file"));
  writeFileSync(path.join(source, "file", "child.txt"), "new child");
  rmSync(path.join(source, "directory"), { recursive: true });
  writeFileSync(path.join(source, "directory"), "new file");
  git(source, ["add", "-A"]);
  const sourceBefore = bytes(source);

  materializeGraphifyWorktreeSnapshot(snapshot(source), workspace);

  assert.deepEqual(bytes(workspace), sourceBefore);
  assert.deepEqual(bytes(source), sourceBefore);
});

test("isolated snapshots reject ignored ancestor symlinks before clearing the worktree", t => {
  const { source, workspace, temp } = fixture(t, { "dir/file.txt": "tracked fixture\n" });
  writeFileSync(path.join(source, ".gitignore"), "graphify-out/\nignored/\ndir\n");
  const outside = path.join(temp, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "file.txt"), "outside fixture sentinel\n");
  rmSync(path.join(source, "dir"), { recursive: true });
  symlinkSync(outside, path.join(source, "dir"), "junction");
  const sourceIndexBefore = readFileSync(path.join(source, ".git", "index"));
  const targetBefore = bytes(workspace);
  assert.deepEqual(inventory(source), [".gitignore", "dir/file.txt", "kept.txt"]);

  assert.throws(() => materializeGraphifyWorktreeSnapshot(snapshot(source), workspace), /non-plain/u);

  assert.deepEqual(bytes(workspace), targetBefore);
  assert.deepEqual(readFileSync(path.join(source, ".git", "index")), sourceIndexBefore);
  assert.equal(readFileSync(path.join(outside, "file.txt"), "utf8"), "outside fixture sentinel\n");
});

test("invalid snapshot paths and overlapping roots are rejected before changing either worktree", t => {
  const { source, workspace, temp } = fixture(t);
  const sourceBefore = bytes(source);
  const targetBefore = bytes(workspace);
  const metadataBefore = readFileSync(path.join(workspace, ".git"));
  for (const repositoryFiles of [["../outside.txt"], [".git/config"], ["/absolute.txt"], ["kept.txt", "missing.txt"]]) {
    assert.throws(() => materializeGraphifyWorktreeSnapshot({ repoRoot: source, repositoryFiles }, workspace));
  }
  for (const target of [source, temp]) {
    assert.throws(() => materializeGraphifyWorktreeSnapshot(snapshot(source), target), /overlap/u);
  }
  assert.deepEqual(bytes(source), sourceBefore);
  assert.deepEqual(bytes(workspace), targetBefore);
  assert.deepEqual(readFileSync(path.join(workspace, ".git")), metadataBefore);
});

test("a non-worktree destination and a non-file source entry are never cleared", t => {
  const { source, workspace, temp } = fixture(t);
  const other = path.join(temp, "not-a-worktree");
  mkdirSync(other);
  writeFileSync(path.join(other, "keep.txt"), "untouched");
  assert.throws(() => materializeGraphifyWorktreeSnapshot(snapshot(source), other), /worktree/u);
  mkdirSync(path.join(source, "not-a-file"));
  const targetBefore = bytes(workspace);
  assert.throws(() => materializeGraphifyWorktreeSnapshot({ repoRoot: source, repositoryFiles: ["not-a-file"] }, workspace), /non-plain/u);
  assert.equal(readFileSync(path.join(other, "keep.txt"), "utf8"), "untouched");
  assert.deepEqual(bytes(workspace), targetBefore);
});
