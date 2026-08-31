import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { LIVE_HUB_RUNTIME_IDENTITY_PATHS } from "../../src/infrastructure/live/live-hub-lifecycle.mjs";

/**
 * The npm tarball uses a `files` whitelist. A shipped module that imports a
 * module outside that whitelist installs fine and then throws
 * ERR_MODULE_NOT_FOUND the first time the packed CLI touches it, so a
 * hand-maintained list of expected entries cannot catch a newly added import.
 * This test derives the Live import closure from the source tree instead and
 * asserts the whitelist covers all of it.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const whitelist = Array.isArray(packageJson.files) ? packageJson.files : [];

const SEARCH_ROOTS = ["src", "scripts", "bin"];
const IMPORT_PATTERN = /(?:from|import)\s*\(?\s*["']([^"']+)["']/gu;
const MODULE_EXTENSIONS = ["", ".mjs", ".js", ".json", "/index.mjs"];

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function listFiles(directory) {
  const absolute = path.join(repoRoot, directory);
  if (!existsSync(absolute)) return [];
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) found.push(toPosix(path.relative(repoRoot, next)));
    }
  };
  walk(absolute);
  return found;
}

function globToRegExp(pattern) {
  const parts = pattern.split("/").map((segment) => {
    if (segment === "**") return null;
    return segment.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, "[^/]*");
  });
  let expression = "";
  parts.forEach((part, index) => {
    const isLast = index === parts.length - 1;
    if (part === null) {
      expression += isLast ? ".*" : "(?:[^/]+/)*";
      return;
    }
    expression += isLast ? part : `${part}/`;
  });
  return new RegExp(`^${expression}$`, "u");
}

function whitelistCovers(relativePath) {
  return whitelist.some((entry) => {
    const pattern = toPosix(entry);
    if (pattern === relativePath) return true;
    if (pattern.endsWith("/")) return relativePath.startsWith(pattern);
    if (!pattern.includes("*")) return false;
    return globToRegExp(pattern).test(relativePath);
  });
}

function resolveRelativeImport(fromFile, specifier) {
  const base = path.join(repoRoot, path.dirname(fromFile), specifier);
  for (const extension of MODULE_EXTENSIONS) {
    const candidate = base + extension;
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return toPosix(path.relative(repoRoot, candidate));
    }
  }
  return null;
}

function importClosure(entryPoints) {
  const visited = new Set();
  const unresolved = [];
  const queue = [...entryPoints];
  while (queue.length > 0) {
    const current = queue.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    if (!/\.m?js$/u.test(current)) continue;
    const absolute = path.join(repoRoot, current);
    if (!existsSync(absolute)) continue;
    for (const match of readFileSync(absolute, "utf8").matchAll(IMPORT_PATTERN)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      const resolved = resolveRelativeImport(current, specifier);
      if (resolved) queue.push(resolved);
      else unresolved.push(`${current} -> ${specifier}`);
    }
  }
  return { visited, unresolved };
}

const liveEntryPoints = SEARCH_ROOTS
  .flatMap((root) => listFiles(root))
  .filter((file) => /\.mjs$/u.test(file) && file.includes("live") && whitelistCovers(file));

test("the shipped Live surface exposes enough entry points to make the closure meaningful", () => {
  assert.ok(
    liveEntryPoints.length >= 6,
    `expected several whitelisted Live entry points, found ${liveEntryPoints.length}: ${liveEntryPoints.join(", ")}`,
  );
  assert.ok(
    liveEntryPoints.includes("src/presentation/live/live-control-room-page.mjs"),
    "the control-room page must be part of the shipped Live surface",
  );
});

test("every relative import reachable from the shipped Live surface resolves on disk", () => {
  const { unresolved } = importClosure(liveEntryPoints);
  assert.deepEqual(unresolved, [], `unresolvable relative imports:\n${unresolved.join("\n")}`);
});

test("the package files whitelist closes over the shipped Live import graph", () => {
  const { visited } = importClosure(liveEntryPoints);
  const uncovered = [...visited].filter((file) => !whitelistCovers(file)).sort();
  assert.deepEqual(
    uncovered,
    [],
    `imported by shipped Live code but missing from package.json "files":\n${uncovered.join("\n")}`,
  );
});

test("the whitelist matcher distinguishes covered from uncovered paths", () => {
  assert.equal(
    whitelistCovers("tests/live/live-package-closure.test.mjs"),
    false,
    "negative control: tests must never be reported as whitelisted",
  );
  assert.equal(
    whitelistCovers("src/presentation/live/live-control-room-page.mjs"),
    true,
    "positive control: an explicitly listed file must match",
  );
  assert.equal(
    whitelistCovers("config/live/viewport-profiles.json"),
    true,
    "positive control: a directory entry must cover nested files",
  );
  assert.equal(
    whitelistCovers("scripts/meta-kim-live.mjs"),
    true,
    "positive control: a glob entry must match scripts",
  );
});

/**
 * The runtime identity hash decides whether a running hub may be reused or must
 * be replaced by the current package. It is read by path rather than imported,
 * so the closure test above cannot see it: an entry the tarball omits leaves the
 * packed hub unable to hash itself, and it then exits with
 * `package_identity_unavailable` instead of serving.
 */
test("every runtime identity path is present, packed, and actually loaded", () => {
  const { visited } = importClosure(liveEntryPoints);
  const missingFromDisk = LIVE_HUB_RUNTIME_IDENTITY_PATHS
    .filter((entry) => !existsSync(path.join(repoRoot, entry)))
    .sort();
  assert.deepEqual(
    missingFromDisk,
    [],
    `named in the runtime identity but absent from the source tree:\n${missingFromDisk.join("\n")}`,
  );

  const unpacked = LIVE_HUB_RUNTIME_IDENTITY_PATHS.filter((entry) => !whitelistCovers(entry)).sort();
  assert.deepEqual(
    unpacked,
    [],
    `hashed into the runtime identity but missing from package.json "files", so the packed hub cannot start:\n${unpacked.join("\n")}`,
  );

  const unloaded = LIVE_HUB_RUNTIME_IDENTITY_PATHS.filter((entry) => !visited.has(entry)).sort();
  assert.deepEqual(
    unloaded,
    [],
    `hashed into the runtime identity but imported by no shipped module, so editing it would force hub replacements that change nothing:\n${unloaded.join("\n")}`,
  );
});

test("the identity audit reads a real closure rather than the whole tree", () => {
  const { visited } = importClosure(liveEntryPoints);
  assert.ok(LIVE_HUB_RUNTIME_IDENTITY_PATHS.length >= 20, "the identity set must stay broad enough to be meaningful");
  assert.equal(
    visited.has("tests/live/live-package-closure.test.mjs"),
    false,
    "negative control: the closure must not reach test files, or the assertions above prove nothing",
  );
  assert.equal(
    visited.has("src/infrastructure/live/live-hub-lifecycle.mjs"),
    true,
    "positive control: the hub lifecycle module must be inside the shipped closure",
  );
});
