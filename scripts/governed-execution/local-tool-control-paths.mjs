import assert from 'node:assert/strict';
import { lstatSync, realpathSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const localToolSamePath = (left, right) => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  : path.resolve(left) === path.resolve(right);
export const localToolInside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

function localPath(value) {
  assert(typeof value === 'string' && !value.includes('\0') && !/^(?:\\\\|\/\/)/u.test(value), 'local path required; network and NUL paths are unsupported');
  return path.resolve(value);
}

// Check existing ancestors as well as the final path, including prospective
// output files: mkdir must never follow an output junction into the target.
export function checkedLocalToolControlPath(value) {
  const resolved = localPath(value);
  let current = resolved;
  while (true) {
    try {
      const stat = lstatSync(current);
      assert(!stat.isSymbolicLink() && localToolSamePath(realpathSync.native(current), current), 'control path cannot traverse a symlink or junction');
      // realpath preserves hardlink names. A regular control file with another
      // name could alias source inside the scan target; directory link counts
      // are unrelated and remain valid (notably on POSIX).
      assert(!stat.isFile() || stat.nlink === 1, 'control files cannot be hard linked');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolved;
}

export function checkedLocalToolTarget({ workspaceRoot, target }) {
  assert(path.isAbsolute(workspaceRoot), 'workspace must be absolute');
  const root = checkedLocalToolControlPath(workspaceRoot);
  assert(!localToolSamePath(root, path.parse(root).root), 'workspace cannot be a filesystem root');
  assert(lstatSync(root).isDirectory(), 'workspace must be an existing directory');
  localPath(target);
  const resolved = checkedLocalToolControlPath(path.resolve(root, target));
  assert(localToolInside(root, resolved), 'target must be within the workspace');
  assert(lstatSync(resolved).isDirectory(), 'target must be an existing directory');
  if (localToolSamePath(root, resolved)) assert(path.isAbsolute(target), 'whole-workspace target must be explicitly absolute');
  return { root, target: resolved };
}

export function checkedLocalToolTempRoot(target) {
  const temporaryRoot = checkedLocalToolControlPath(os.tmpdir());
  assert(lstatSync(temporaryRoot).isDirectory(), 'host temporary root must be an existing directory');
  assert(!localToolInside(target, temporaryRoot), 'owned temporary control directory cannot be inside the scan target');
  return temporaryRoot;
}

export function createLocalToolControlDirectory(target, purpose) {
  assert(['receipt', 'home', 'run', 'candidates'].includes(purpose), 'unsupported control directory purpose');
  const temporaryRoot = checkedLocalToolTempRoot(target);
  const directory = mkdtempSync(path.join(temporaryRoot, `meta-kim-local-tool-${purpose}-`));
  assert(localToolSamePath(path.dirname(directory), temporaryRoot) && !localToolInside(target, directory), 'owned control directory escaped its fixed temporary root');
  return directory;
}

export function resolveLocalToolRunnerControlPaths({ target, stateDir, artifactDir, dbPath, stageRunner, relocateDefaults = false }) {
  // The runner awaits before opening its durable database. Caller mutation
  // must not replace the scalar path that this preflight just validated.
  stageRunner = stageRunner == null ? stageRunner : { ...stageRunner };
  const durableDbPath = stageRunner?.durableDbPath ?? (stageRunner?.enabled === true ? path.join(stateDir, 'durable-runs.sqlite') : null);
  const databasePaths = [dbPath, durableDbPath].filter((value) => value != null);
  // SQLite can write existing companions even when the main database is new.
  const paths = [stateDir, path.join(stateDir, 'capability-inventory.json'), artifactDir, ...databasePaths.flatMap((file) =>
    [file, `${file}-wal`, `${file}-shm`, `${file}-journal`])].filter((value) => value != null);
  const overlap = paths.map(checkedLocalToolControlPath).some((value) => localToolInside(target, value));
  checkedLocalToolTempRoot(target);
  if (!overlap) return { stateDir, artifactDir, dbPath, stageRunner };
  assert(relocateDefaults, 'explicit local scan control paths cannot be inside the target');
  assert(stageRunner?.durableMode !== 'resume', 'cannot relocate an existing durable resume into a new control directory');
  const root = createLocalToolControlDirectory(target, 'run');
  return { stateDir: path.join(root, 'state'), artifactDir: path.join(root, 'artifacts'), dbPath: path.join(root, 'runs.sqlite'),
    stageRunner: stageRunner == null ? stageRunner : { ...stageRunner, durableDbPath: path.join(root, 'durable-runs.sqlite') } };
}
