import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { LIVE_MAX_JSON_BYTES, isPathInside } from "../../domain/live/live-read-contract.mjs";

/** Bounded read of an already-authorized output reference; never discovers files. */
export async function readBoundedDeliverable(projectRoot, reference) {
  try {
    const root = path.resolve(projectRoot);
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    const target = path.resolve(root, reference);
    if (!isPathInside(root, target) || target === root) return null;
    let current = root;
    const parts = path.relative(root, target).split(path.sep);
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) return null;
    }
    const canonicalRoot = await realpath(root);
    const canonicalTarget = await realpath(target);
    if (!isPathInside(canonicalRoot, canonicalTarget)) return null;
    const handle = await open(target, "r");
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > LIVE_MAX_JSON_BYTES || before.nlink !== 1) return null;
      const bytes = Buffer.alloc(before.size + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const after = await handle.stat();
      const named = await lstat(target);
      if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        named.isSymbolicLink() || named.ino !== before.ino || named.dev !== before.dev ||
        await realpath(target) !== canonicalTarget) return null;
      return bytes.subarray(0, bytesRead);
    } finally { await handle.close(); }
  } catch { return null; }
}
