import { lstatSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function contains(root, target) {
  const relative = path.relative(pathKey(root), pathKey(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function existingStat(target) {
  try { return lstatSync(target); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function projectedRealPath(target) {
  let current = path.resolve(target);
  const missing = [];
  while (true) {
    try { return path.join(realpathSync(current), ...missing.reverse()); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** Bind configured runtime roots once; recheck their identity before each write. */
export function createInstallerWriteBoundary({
  userHome = os.homedir(), runtimeHomes = [],
  storeRoot = process.env.META_KIM_PROJECTION_PACKAGE_STORE_ROOT || path.join(userHome, ".meta-kim/runtime/projection-packages"),
} = {}) {
  const roots = [...new Set([...runtimeHomes, userHome].map((root) => path.resolve(root)))]
    .sort((left, right) => right.length - left.length)
    .map((lexicalRoot) => {
      if (existingStat(lexicalRoot) && !statSync(lexicalRoot).isDirectory()) {
        throw new Error(`Refusing non-directory runtime root: ${lexicalRoot}`);
      }
      return Object.freeze({ lexicalRoot, realRoot: projectedRealPath(lexicalRoot) });
    });
  const protectedRoot = Object.freeze({ lexicalRoot: path.resolve(storeRoot), realRoot: projectedRealPath(storeRoot) });
  return Object.freeze({ roots: Object.freeze(roots), protectedRoot });
}

export function assertInstallerWritePath(targetPath, boundary) {
  const target = path.resolve(targetPath);
  if (pathKey(projectedRealPath(boundary.protectedRoot.lexicalRoot)) !== pathKey(boundary.protectedRoot.realRoot)) {
    throw new Error(`Refusing changed immutable projection store binding: ${boundary.protectedRoot.lexicalRoot}`);
  }
  const binding = boundary.roots.find((root) => contains(root.lexicalRoot, target));
  if (!binding) throw new Error(`Refusing path outside OS user home and configured runtime homes: ${target}`);
  if (pathKey(projectedRealPath(binding.lexicalRoot)) !== pathKey(binding.realRoot)) {
    throw new Error(`Refusing changed runtime root binding: ${binding.lexicalRoot}`);
  }
  const realTarget = projectedRealPath(target);
  if (contains(boundary.protectedRoot.lexicalRoot, target) || contains(boundary.protectedRoot.realRoot, realTarget)) {
    throw new Error(`Refusing write into immutable projection store: ${target}`);
  }
  let current = binding.lexicalRoot;
  for (const segment of path.relative(binding.lexicalRoot, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = existingStat(current);
    if (!stat) break;
    // Only the declared whole runtime root may redirect. An inner skill,
    // plugins directory, or transaction path never inherits that permission.
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink or junction in managed path: ${current}`);
    if (!contains(binding.realRoot, projectedRealPath(current))) {
      throw new Error(`Refusing managed path escape: ${current}`);
    }
  }
  if (!contains(binding.realRoot, realTarget)) throw new Error(`Refusing managed path escape: ${target}`);
  return target;
}
