import { lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// This selector is deliberately narrower than a generic stale-manifest cleanup.
// It identifies only the disposable hook-source test roots created by the old
// setup test. The caller remains responsible for the atomic manifest write.
export const HISTORICAL_HOOK_SOURCE_TEST_ROOT_PATTERN = /^meta-kim-hook-source-[A-Za-z0-9][A-Za-z0-9_-]*$/u;

const HISTORICAL_SOURCES = new Set(["sync-runtimes", "sync-global-meta-theory"]);
const GLOBAL_RUNTIME_NAMES = new Set(["claude", "codex", "cursor"]);
const GLOBAL_CATEGORIES = new Set(["A", "B", "C"]);
const GLOBAL_PURPOSE_PATTERN = /^(?:claude|codex|cursor)-global-[a-z0-9][a-z0-9:_-]*$/u;

function manifestEntries(manifest) {
  if (!manifest || !Array.isArray(manifest.entries)) {
    throw new TypeError("install manifest must contain an entries array");
  }
  return manifest.entries;
}

function isPathInside(rootDir, candidatePath) {
  const relativePath = path.relative(rootDir, candidatePath);
  return relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath);
}

function historicalPathParts(entryPath, tempRoot) {
  const absolutePath = path.resolve(entryPath);
  const absoluteTempRoot = path.resolve(tempRoot);
  if (!isPathInside(absoluteTempRoot, absolutePath)) {
    return null;
  }

  const relativePath = path.relative(absoluteTempRoot, absolutePath);
  const parts = relativePath.split(path.sep);
  if (parts.length < 3 || !HISTORICAL_HOOK_SOURCE_TEST_ROOT_PATTERN.test(parts[0])) {
    return null;
  }

  const runtimeName = parts[1];
  if (!GLOBAL_RUNTIME_NAMES.has(runtimeName)) {
    return null;
  }

  return { absolutePath, runtimeName, sourceTestRoot: parts[0] };
}

function pathExistsOrUnknown(candidatePath, stat = lstatSync) {
  try {
    stat(candidatePath);
    return true;
  } catch (error) {
    // ENOENT is the only state that proves the old test asset is gone. A
    // permission error, broken link, or other filesystem uncertainty is kept.
    return error?.code !== "ENOENT";
  }
}

/**
 * Classify one manifest entry without reading or copying the referenced file.
 * A match is safe to migrate only when every identity and absence condition is
 * true. Unknown or drifted entries return a preservation reason instead.
 */
export function classifyExactHistoricalHookSourceEntry(entry, {
  tempRoot = os.tmpdir(),
  stat = lstatSync,
} = {}) {
  if (!entry || typeof entry !== "object") {
    return { matched: false, reason: "invalid_entry" };
  }
  if (!HISTORICAL_SOURCES.has(entry.source)) {
    return { matched: false, reason: "source_not_exact" };
  }
  if (typeof entry.purpose !== "string" || !GLOBAL_PURPOSE_PATTERN.test(entry.purpose)) {
    return { matched: false, reason: "purpose_not_exact" };
  }
  if (!GLOBAL_CATEGORIES.has(entry.category)) {
    return { matched: false, reason: "category_not_supported" };
  }
  if (typeof entry.path !== "string" || !path.isAbsolute(entry.path)) {
    return { matched: false, reason: "path_not_absolute" };
  }

  const pathParts = historicalPathParts(entry.path, tempRoot);
  if (!pathParts) {
    return { matched: false, reason: "path_naming_or_runtime_not_exact" };
  }
  if (entry.runtimeTarget && entry.runtimeTarget !== pathParts.runtimeName) {
    return { matched: false, reason: "runtime_target_mismatch" };
  }
  if (pathExistsOrUnknown(pathParts.absolutePath, stat)) {
    return { matched: false, reason: "path_still_exists_or_is_unknown" };
  }

  return {
    matched: true,
    reason: "exact_historical_hook_source_test_target",
    runtimeName: pathParts.runtimeName,
    sourceTestRoot: pathParts.sourceTestRoot,
  };
}

/**
 * Return exact historical candidates with their original indexes. This is a
 * read-only planning function; it never mutates the manifest or the filesystem.
 */
export function selectExactHistoricalHookSourceEntries(manifest, options = {}) {
  return manifestEntries(manifest)
    .map((entry, index) => ({
      entry,
      index,
      classification: classifyExactHistoricalHookSourceEntry(entry, options),
    }))
    .filter(({ classification }) => classification.matched);
}

/**
 * Produce the manifest after removing only selected historical candidates.
 * The result is intentionally pure so a façade can back up, atomically flush,
 * and independently read back the change through install-manifest APIs.
 */
export function pruneExactHistoricalHookSourceEntries(manifest, options = {}) {
  const entries = manifestEntries(manifest);
  const selected = selectExactHistoricalHookSourceEntries(manifest, options);
  const selectedIndexes = new Set(selected.map(({ index }) => index));
  const nextManifest = {
    ...manifest,
    entries: entries.filter((_, index) => !selectedIndexes.has(index)),
  };

  return {
    manifest: nextManifest,
    removedEntries: selected.map(({ entry, index, classification }) => ({
      entry,
      index,
      classification,
    })),
    preservedEntries: entries.filter((_, index) => !selectedIndexes.has(index)),
  };
}

