/**
 * hook-fixture.mjs
 *
 * Hook fixtures spawn a real hook from a temp directory, so every module that
 * hook imports has to sit beside it. A hand-written file list drifts the moment
 * a hook gains an import: the spawn dies during module resolution, writes
 * nothing, and the assertion that reads the projected state file reports a
 * confusing missing-file error rather than the missing module. Deriving the list
 * from the canonical sources keeps the fixture honest without a second list to
 * maintain.
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Shared comes first so the Claude compatibility stubs, which only re-export the
// shared implementation through a parent-relative path, never win resolution.
const HOOK_SOURCE_DIRS = [
  "canonical/runtime-assets/shared/hooks",
  "canonical/runtime-assets/claude/hooks",
];

const SIBLING_IMPORT_PATTERNS = [
  /from\s+"\.\/([^"]+)"/g,
  /import\(\s*"\.\/([^"]+)"\s*\)/g,
  /(?:^|\n)\s*import\s+"\.\/([^"]+)"/g,
];

const ESCAPING_IMPORT_PATTERN = /(?:from|import|import\()\s*"(\.\.\/[^"]+)"/;

function siblingImportNames(source) {
  const names = [];
  for (const pattern of SIBLING_IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      names.push(match[1]);
    }
  }
  return names;
}

function resolveHookSource(repoRoot, fileName) {
  for (const sourceDir of HOOK_SOURCE_DIRS) {
    const candidate = join(repoRoot, sourceDir, fileName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `no canonical hook source for "${fileName}" in ${HOOK_SOURCE_DIRS.join(" or ")}`,
  );
}

/**
 * Copies the entry hooks and every sibling module they transitively import into
 * one flattened directory, and returns the copied file names.
 */
export function copyHookClosure(repoRoot, hookDir, entryFileNames) {
  const pending = [...entryFileNames];
  const copied = [];
  while (pending.length > 0) {
    const fileName = pending.shift();
    if (copied.includes(fileName)) {
      continue;
    }
    const source = resolveHookSource(repoRoot, fileName);
    const text = readFileSync(source, "utf8");
    const escaping = text.match(ESCAPING_IMPORT_PATTERN);
    if (escaping) {
      throw new Error(
        `"${fileName}" imports "${escaping[1]}"; a flattened hook fixture cannot satisfy a parent-relative path`,
      );
    }
    copyFileSync(source, join(hookDir, fileName));
    copied.push(fileName);
    pending.push(...siblingImportNames(text));
  }
  return copied;
}

/**
 * A hook that cannot resolve its own imports exits non-zero and projects
 * nothing, which every state-file assertion downstream reports as a missing
 * file. Surfacing it here names the real cause once instead of in each caller.
 */
export function assertHookResolvedItsModules(result, hookName) {
  const stderr = result?.stderr || "";
  if (stderr.includes("ERR_MODULE_NOT_FOUND")) {
    const missing = stderr.match(/Cannot find module '([^']+)'/);
    throw new Error(
      `${hookName} could not resolve ${missing ? missing[1] : "a module"}; the fixture is missing part of its import closure`,
    );
  }
}
