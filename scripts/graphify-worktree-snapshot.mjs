import {
  copyFileSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function sanitizedGraphifyGitEnvironment(environment = process.env) {
  const clean = { ...environment };
  for (const key of Object.keys(clean)) {
    if (key.toUpperCase().startsWith("GIT_")) delete clean[key];
  }
  return clean;
}

function contains(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

const pathIdentity = candidate => process.platform === "win32" ? candidate.toLowerCase() : candidate;

function plainRoot(value) {
  const resolved = path.resolve(value);
  const stats = lstatSync(resolved);
  if (!stats.isDirectory() || stats.isSymbolicLink() || pathIdentity(realpathSync.native(resolved)) !== pathIdentity(resolved)) {
    throw new Error("Graphify snapshot root must be a plain directory");
  }
  return resolved;
}

/** Validate every source component before a snapshot reader touches its bytes. */
export function resolvePlainGraphifySourceFile(repoRoot, repositoryFile) {
  const sourceRoot = path.resolve(repoRoot);
  const segments = repositoryFile.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === ".." || segment === ".git")) {
    throw new Error("repository snapshot path escaped isolated worktree");
  }
  const source = path.resolve(sourceRoot, ...segments);
  if (!contains(sourceRoot, source)) {
    throw new Error("repository snapshot path escaped isolated worktree");
  }
  let current = sourceRoot;
  for (let index = 0; index <= segments.length; index += 1) {
    if (index > 0) current = path.join(current, segments[index - 1]);
    const stats = lstatSync(current);
    if (stats.isSymbolicLink() || (index === segments.length ? !stats.isFile() : !stats.isDirectory())) {
      throw new Error("repository snapshot contains a non-plain file or parent directory");
    }
  }
  const canonical = realpathSync.native(source);
  if (!contains(sourceRoot, canonical) || pathIdentity(canonical) !== pathIdentity(source)) {
    throw new Error("repository snapshot contains a non-plain source path");
  }
  return source;
}

/** Populate only a newly created, caller-owned disposable Git worktree. */
export function materializeGraphifyWorktreeSnapshot(repository, workspace) {
  const sourceRoot = plainRoot(repository.repoRoot);
  const targetRoot = plainRoot(workspace);
  if (contains(sourceRoot, targetRoot) || contains(targetRoot, sourceRoot)) {
    throw new Error("Graphify source and isolated worktree must not overlap");
  }
  let marker;
  try { marker = lstatSync(path.join(targetRoot, ".git")); } catch { /* Checked below. */ }
  if (!marker?.isFile() || marker.isSymbolicLink()) {
    throw new Error("Graphify destination must be a disposable linked worktree");
  }

  // Validate the whole input before clearing any part of the isolated checkout.
  const files = repository.repositoryFiles.map(repositoryFile => {
    const source = resolvePlainGraphifySourceFile(sourceRoot, repositoryFile);
    const target = path.resolve(targetRoot, ...repositoryFile.split("/"));
    if (!contains(targetRoot, target)) {
      throw new Error("repository snapshot path escaped isolated worktree");
    }
    return { source, target, repositoryFile };
  });

  // HEAD may contain files deleted or renamed by the current source snapshot,
  // or paths whose file/directory type changed. Start with an empty checkout,
  // preserving its Git pointer; the original source is never written here.
  for (const entry of readdirSync(targetRoot, { withFileTypes: true })) {
    if (entry.name !== ".git") {
      rmSync(path.join(targetRoot, entry.name), { recursive: true, force: true });
    }
  }
  for (const { source, target, repositoryFile } of files) {
    resolvePlainGraphifySourceFile(sourceRoot, repositoryFile);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
  }

  // This checkout's index still describes HEAD. Refresh only its disposable
  // index so file/directory replacements and newly tracked ignored files are
  // inventoried exactly as copied; no commit or source-index update is made.
  const indexed = spawnSync("git", ["add", "--all", "--force"], {
    cwd: targetRoot, encoding: "utf8", shell: false,
    env: sanitizedGraphifyGitEnvironment(), windowsHide: true,
  });
  if (indexed.status !== 0 || indexed.error) {
    throw new Error("isolated Graphify snapshot index could not be synchronized");
  }
}
