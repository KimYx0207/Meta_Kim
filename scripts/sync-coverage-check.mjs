#!/usr/bin/env node
/**
 * sync-coverage-check.mjs
 *
 * Static coverage gate for canonical/runtime-assets/ projection rules in
 * scripts/sync-runtimes.mjs.
 *
 * Problem this prevents:
 *   When a new asset class (e.g. cursor/rules/*.mdc) is added to
 *   canonical/runtime-assets/, sync-runtimes.mjs may not have a projection
 *   rule that copies it to the corresponding runtime mirror. Today nothing
 *   catches "canonical has X but sync doesn't copy X" — Blocker A in v2 was
 *   exactly this gap.
 *
 * What this script does:
 *   1. Walks canonical/runtime-assets/ recursively to enumerate every asset
 *      file (excluding .git, __pycache__, etc.).
 *   2. Loads .meta-kim/install-manifest.json (written by sync-runtimes.mjs)
 *      and indexes destination filenames as a "definitely projected"
 *      witness set.
 *   3. Loads scripts/sync-runtimes.mjs source as a secondary witness — a
 *      canonical asset whose filename, basename, or parent directory is
 *      referenced inside the sync script is considered covered.
 *   4. Reports canonical files that lack BOTH witnesses as sync gaps.
 *   5. Exits 0 on full coverage, exits 1 with a gap list otherwise.
 *
 * Allow-list:
 *   Some canonical paths are intentionally NOT projected by sync-runtimes.mjs
 *   (handled by other installers, used as templates only, design notes, etc.).
 *   Add new exclusions to KNOWN_INTENTIONAL_EXCLUSIONS with a one-line
 *   justification.
 *
 * Cross-OS notes:
 *   - Uses path.join / path.relative throughout.
 *   - Normalizes all comparison paths to forward slashes.
 *   - Uses fs.readdir { recursive: true } (Node >= 20).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptsDir, "..");

const canonicalRuntimeAssetsDir = path.join(
  repoRoot,
  "canonical",
  "runtime-assets",
);
const syncRuntimesScript = path.join(scriptsDir, "sync-runtimes.mjs");
const manifestPath = path.join(
  repoRoot,
  ".meta-kim",
  "install-manifest.json",
);

// ── Allow-list ────────────────────────────────────────────────────────
//
// Canonical paths (relative to canonical/runtime-assets/, forward-slash
// normalized) that are intentionally NOT projected by sync-runtimes.mjs.
// Each entry must come with a justification so future maintainers know
// why this file is excluded.
//
// Matching is "starts-with" semantics — listing a directory excludes
// every file under it.
const KNOWN_INTENTIONAL_EXCLUSIONS = [
  // DSH has a separate opt-in profile lifecycle; the ordinary six-target
  // projection must not install DSH or imply stage-runner authorization.
  {
    prefix: "dsh/dispatcher.md",
    reason: "Rendered by scripts/dsh-profile-package.mjs into the native DSH dispatcher Skill; covered by DSH lifecycle tests and the official host probe",
  },
  {
    prefix: "dsh/governance-role.md",
    reason: "Rendered by scripts/dsh-profile-package.mjs into native DSH role Skills; not custom-agent presets",
  },
  {
    prefix: "dsh/host-contract.json",
    reason: "Consumed by scripts/dsh-profile-package.mjs as the DSH profile/patch and complete-resource-reading contract",
  },
  // Installed by scripts/install-mcp-memory-hooks.mjs, not sync-runtimes.
  // sync-runtimes intentionally avoids touching the global Claude config dir
  // for these Python hooks; they have their own idempotent installer.
  {
    prefix: "claude/memory-hooks/",
    reason:
      "Installed via scripts/install-mcp-memory-hooks.mjs (separate installer for global Python hooks)",
  },
  // .meta-kim/state/ is a runtime state-dir scaffold shipped with the
  // canonical tree so package consumers see an empty state seed. It is not
  // a projection source — it is consumed in-place by sync-runtimes' state
  // helpers and runtime-local writers.
  {
    prefix: ".meta-kim/",
    reason:
      "Runtime state scaffold consumed in-place by .meta-kim/ helpers; no projection target",
  },
  {
    prefix: "shared/lib/",
    reason:
      "Retained design-time PoC modules are tested in place; they are not production-wired capabilities or runtime projection sources",
  },
];

// ── Helpers ───────────────────────────────────────────────────────────

function toPosix(p) {
  return p.replace(/\\/g, "/");
}

function isAllowed(relPosix) {
  return KNOWN_INTENTIONAL_EXCLUSIONS.some((rule) =>
    relPosix.startsWith(rule.prefix),
  );
}

function allowReason(relPosix) {
  const rule = KNOWN_INTENTIONAL_EXCLUSIONS.find((r) =>
    relPosix.startsWith(r.prefix),
  );
  return rule ? rule.reason : null;
}

async function listCanonicalAssets() {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(canonicalRuntimeAssetsDir, {
      withFileTypes: true,
      recursive: true,
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      return out;
    }
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // entry.parentPath is the directory containing the file (Node >= 20.12).
    // Fall back to entry.path for older runtimes.
    const parent = entry.parentPath || entry.path || canonicalRuntimeAssetsDir;
    const absPath = path.join(parent, entry.name);
    const rel = path.relative(canonicalRuntimeAssetsDir, absPath);
    const relPosix = toPosix(rel);
    // Skip OS / VCS noise even if the recursive walk somehow surfaces it.
    if (
      relPosix.split("/").some((part) =>
        part === ".git" ||
        part === ".DS_Store" ||
        part === "__pycache__" ||
        part === "node_modules",
      )
    ) {
      continue;
    }
    out.push({ abs: absPath, rel, relPosix });
  }
  return out;
}

async function loadManifestEntries() {
  let raw;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { entries: [], present: false };
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return { entries, present: true };
  } catch (error) {
    console.warn(
      `[sync-coverage-check] Failed to parse install-manifest.json: ${error.message}`,
    );
    return { entries: [], present: false };
  }
}

function indexManifestByFilename(entries) {
  // Manifest stores destination (runtime-mirror) paths, not source paths.
  // Index by basename so we can ask "did any projection write a file with
  // this basename?" — combined with the source-grep check this catches the
  // common case where sync-runtimes copies a canonical file to a mirror with
  // the same basename.
  const basenameSet = new Set();
  for (const entry of entries) {
    if (typeof entry?.path !== "string") continue;
    const base = path.basename(entry.path);
    if (base) basenameSet.add(base);
  }
  return basenameSet;
}

async function loadSyncRuntimesSource() {
  return fs.readFile(syncRuntimesScript, "utf8");
}

function isReferencedInSyncSource(asset, syncSource) {
  // Three witnesses, any of which counts as "covered":
  //   1. The full relative posix path under runtime-assets is mentioned.
  //   2. The basename is mentioned (e.g. "meta-enforcement.mdc").
  //   3. The parent dir under runtime-assets is mentioned as a path segment
  //      with the canonical "shared/hooks", "claude/hooks", "cursor/rules",
  //      "claude/memory-hooks", "openclaw/hooks/mcp-memory-service",
  //      "claude/commands/save-progress" pattern — meaning sync-runtimes
  //      walks the directory and projects every file in it.
  const fullRel = asset.relPosix;
  const baseName = path.basename(asset.relPosix);
  const parentDir = path.dirname(asset.relPosix);

  if (fullRel && syncSource.includes(fullRel)) return true;
  if (baseName && syncSource.includes(baseName)) return true;

  // Directory-walk pattern: sync-runtimes typically references the parent
  // path as a string used inside path.join(canonicalRuntimeAssetsDir, ...)
  // arguments, e.g. path.join(canonicalRuntimeAssetsDir, "claude", "hooks").
  // We look for the parent dir as a posix segment "claude/hooks" and as the
  // joined-segment list \"claude\", \"hooks\". Either match is enough.
  if (parentDir && parentDir !== ".") {
    if (syncSource.includes(parentDir)) return true;
    const segments = parentDir.split("/");
    if (segments.length > 0) {
      const joinedQuoted = segments
        .map((seg) => JSON.stringify(seg))
        .join(", ");
      if (syncSource.includes(joinedQuoted)) return true;
    }
  }

  return false;
}

function classifyAsset(asset, manifestBasenames, syncSource) {
  if (isAllowed(asset.relPosix)) {
    return {
      status: "allow-listed",
      reason: allowReason(asset.relPosix),
    };
  }
  const base = path.basename(asset.relPosix);
  const inManifest = manifestBasenames.has(base);
  const inSync = isReferencedInSyncSource(asset, syncSource);
  if (inManifest || inSync) {
    return {
      status: "covered",
      reason: inManifest
        ? inSync
          ? "manifest+source"
          : "manifest"
        : "source",
    };
  }
  return { status: "uncovered" };
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const assets = await listCanonicalAssets();
  if (assets.length === 0) {
    console.log(
      "[sync-coverage-check] No files found under canonical/runtime-assets/ — nothing to check.",
    );
    process.exit(0);
  }

  const [{ entries: manifestEntries, present: manifestPresent }, syncSource] =
    await Promise.all([loadManifestEntries(), loadSyncRuntimesSource()]);
  const manifestBasenames = indexManifestByFilename(manifestEntries);

  const covered = [];
  const allowListed = [];
  const uncovered = [];

  for (const asset of assets) {
    const verdict = classifyAsset(asset, manifestBasenames, syncSource);
    if (verdict.status === "covered") {
      covered.push({ asset, reason: verdict.reason });
    } else if (verdict.status === "allow-listed") {
      allowListed.push({ asset, reason: verdict.reason });
    } else {
      uncovered.push({ asset });
    }
  }

  console.log("[sync-coverage-check] canonical/runtime-assets/ coverage report");
  console.log(
    `  total canonical files       : ${assets.length}`,
  );
  console.log(`  covered by sync-runtimes.mjs: ${covered.length}`);
  console.log(`  intentionally excluded      : ${allowListed.length}`);
  console.log(`  UNCOVERED (sync gaps)       : ${uncovered.length}`);
  if (!manifestPresent) {
    console.log(
      "  note: install-manifest.json not found — relied on source grep only",
    );
  }

  if (allowListed.length > 0) {
    console.log("");
    console.log("[sync-coverage-check] Allow-listed (not projected by design):");
    for (const item of allowListed) {
      console.log(`  - ${item.asset.relPosix}`);
      console.log(`    reason: ${item.reason}`);
    }
  }

  if (uncovered.length > 0) {
    console.log("");
    console.log("[sync-coverage-check] FAIL — uncovered canonical assets:");
    for (const item of uncovered) {
      console.log(`  - canonical/runtime-assets/${item.asset.relPosix}`);
    }
    console.log("");
    console.log(
      "Each uncovered file must either gain a projection rule in",
    );
    console.log("scripts/sync-runtimes.mjs, or be added to the");
    console.log("KNOWN_INTENTIONAL_EXCLUSIONS allow-list in");
    console.log("scripts/sync-coverage-check.mjs with a justification.");
    process.exit(1);
  }

  // ── Runtime local-override marker symmetry (soft reminder) ───────────
  //
  // Invariant: if one writable runtime config carries `meta-kim: local-override`
  // so sync-runtimes skips it, every other writable runtime config must carry
  // the same marker, OR the asymmetry must be declared here. Prevents a user's
  // local divergence on one runtime from being silently overwritten on another.
  const runtimeMarkerConfigs = [
    { runtime: "codex", file: path.join(repoRoot, ".codex", "config.toml") },
    { runtime: "cursor", file: path.join(repoRoot, ".cursor", "hooks.json") },
  ];
  const markedRuntimes = [];
  for (const rc of runtimeMarkerConfigs) {
    try {
      const txt = await fs.readFile(rc.file, "utf8");
      if (txt.includes("meta-kim: local-override")) markedRuntimes.push(rc.runtime);
    } catch {
      /* unreadable or absent — treat as no marker */
    }
  }
  if (markedRuntimes.length === 1) {
    console.log("");
    console.log("[sync-coverage-check] local-override marker asymmetry reminder:");
    console.log(`  only ${markedRuntimes[0]} carries the marker;`);
    console.log("  invariant: every writable runtime config must carry it or be declared asymmetric here.");
  }

  console.log("");
  console.log("[sync-coverage-check] PASS — all canonical assets covered.");
  process.exit(0);
}

main().catch((error) => {
  console.error(`[sync-coverage-check] Fatal: ${error.message}`);
  console.error(error.stack);
  process.exit(2);
});
