import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Kim Service's v1 index hashes sorted JSON plus a final LF, and sorted
// component-relative file names separated from their raw bytes with NULs.
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort(compare).map((key) => [key, stable(value[key])]),
  );
  return value;
}
export const stableJson = (value) => JSON.stringify(stable(value), null, 2) + "\n";

function relativeSegments(value) {
  assert.equal(typeof value, "string", "component path must be a relative string");
  assert(!/[\\:\0]/u.test(value), "component path must use portable relative segments");
  const segments = value.split("/");
  assert(segments.every((part) => part && part !== "." && part !== ".."), "component path cannot escape its root");
  return segments;
}

export async function checkedPath(root, relative, directory = false) {
  let current = root;
  const segments = relativeSegments(relative);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    assert(!stat.isSymbolicLink(), "component path cannot traverse a symlink or junction");
    assert(index < segments.length - 1 || directory ? stat.isDirectory() : stat.isFile(), "component path has an unexpected file type");
  }
  return current;
}

export async function componentHash(root) {
  const files = [];
  async function visit(directory, prefix = "") {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      relativeSegments(name);
      const file = path.join(directory, entry.name);
      const stat = await fs.lstat(file);
      assert(!stat.isSymbolicLink(), "component tree cannot contain a symlink or junction");
      if (stat.isDirectory()) await visit(file, name);
      else {
        assert(stat.isFile(), "component tree must contain only regular files");
        files.push(name);
      }
    }
  }
  await visit(root);
  const hash = createHash("sha256");
  for (const name of files.sort(compare)) {
    hash.update(name).update("\0").update(await fs.readFile(path.join(root, name))).update("\0");
  }
  return hash.digest("hex");
}
