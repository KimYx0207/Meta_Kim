/**
 * Meta_Kim install manifest — ledger that records every path Meta_Kim writes,
 * every settings.json key it merges, and every external dependency it installs.
 *
 * Two physical manifests exist at once:
 *   - Global: ~/.meta-kim/install-manifest.json
 *     Tracks writes into runtime homes (~/.claude, ~/.codex, ~/.claw, ~/.cursor).
 *   - Project: <repoRoot>/.meta-kim/install-manifest.json
 *     Tracks writes inside the repository itself (.claude/, .codex/, ...).
 *
 * Schema (v1):
 *   {
 *     schemaVersion: 1,
 *     scope: "global" | "project",
 *     metaKimVersion: "2.0.12",
 *     repoRoot?: "/abs/path/to/repo",   // only when scope === "project"
 *     createdAt: "ISO-8601",
 *     updatedAt: "ISO-8601",
 *     entries: Entry[]
 *   }
 *
 * Entry (v1):
 *   {
 *     path:        absolute path touched
 *     category:    one of Categories.{A..I}  (see CATEGORY_LABELS below)
 *     source:      logical source (script name or "setup.mjs:step4.5")
 *     purpose:     short tag, e.g. "global-hook", "project-agent"
 *     kind:        "file" | "dir" | "settings-merge" | "mcp-server"
 *                  | "pip-package" | "git-hook"
 *     installedAt: ISO-8601
 *     sha256?:     file checksum when kind === "file"
 *     size?:       bytes when kind === "file"
 *     mergedHookCommands?: string[]  (kind === "settings-merge")
 *     mergedSettingsKeys?: string[]  (kind === "settings-merge")
 *     mcpServerName?: string         (kind === "mcp-server")
 *     pipPackageName?: string        (kind === "pip-package")
 *     pipPackageVersion?: string
 *   }
 *
 * Uniqueness key for entries: `${path}::${purpose}`.
 * `record()` merges in-place on matching key; `removeByPath()` drops by key.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  createReadStream,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

export const SCHEMA_VERSION = 1;

export const CATEGORIES = Object.freeze({
  A: "A",
  B: "B",
  C: "C",
  D: "D",
  E: "E",
  F: "F",
  G: "G",
  H: "H",
  I: "I",
});

export const CATEGORY_LABELS = Object.freeze({
  A: "Global runtime skills",
  B: "Global runtime hooks",
  C: "Global settings.json merges",
  D: "Project runtime skills",
  E: "Project runtime hooks",
  F: "Project runtime agents",
  G: "Project settings + MCP config",
  H: "Project local state (.meta-kim/)",
  I: "Shared dependencies (pip / git hooks)",
});

/** Compute manifest path for a scope. `repoRoot` required for project scope. */
export function manifestPathFor(scope, repoRoot) {
  if (scope === "global") {
    return path.join(homedir(), ".meta-kim", "install-manifest.json");
  }
  if (scope === "project") {
    if (!repoRoot) {
      throw new Error("manifestPathFor('project', repoRoot) requires repoRoot");
    }
    return path.join(repoRoot, ".meta-kim", "install-manifest.json");
  }
  throw new Error(`Unknown scope: ${scope}`);
}

export function createEmpty({ scope, repoRoot, metaKimVersion }) {
  const now = new Date().toISOString();
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    scope,
    metaKimVersion: metaKimVersion ?? "unknown",
    createdAt: now,
    updatedAt: now,
    entries: [],
  };
  if (scope === "project" && repoRoot) {
    manifest.repoRoot = repoRoot;
  }
  return manifest;
}

export function readManifest(manifestPath) {
  if (!existsSync(manifestPath)) return null;
  let raw;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const { ok } = validate(parsed);
  if (!ok) return null;
  return parsed;
}

export function writeManifest(manifestPath, manifest) {
  const dir = path.dirname(manifestPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const updated = { ...manifest, updatedAt: new Date().toISOString() };
  writeFileSync(manifestPath, `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}

function entryKey(entry) {
  return `${entry.path}::${entry.purpose ?? ""}`;
}

export function record(manifest, entry) {
  const next = { ...manifest, entries: [...manifest.entries] };
  const key = entryKey(entry);
  const idx = next.entries.findIndex((e) => entryKey(e) === key);
  const stamped = {
    ...entry,
    installedAt: entry.installedAt ?? new Date().toISOString(),
  };
  if (idx === -1) next.entries.push(stamped);
  else next.entries[idx] = { ...next.entries[idx], ...stamped };
  return next;
}

export function removeByPath(manifest, targetPath, purpose) {
  const next = {
    ...manifest,
    entries: manifest.entries.filter((e) => {
      if (e.path !== targetPath) return true;
      if (purpose !== undefined && e.purpose !== purpose) return true;
      return false;
    }),
  };
  return next;
}

export function validate(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object") {
    return { ok: false, errors: ["manifest is not an object"] };
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`unsupported schemaVersion: ${manifest.schemaVersion}`);
  }
  if (manifest.scope !== "global" && manifest.scope !== "project") {
    errors.push(`scope must be "global" or "project"`);
  }
  if (!Array.isArray(manifest.entries)) {
    errors.push("entries must be an array");
  } else {
    for (const [i, entry] of manifest.entries.entries()) {
      if (!entry || typeof entry !== "object") {
        errors.push(`entries[${i}] is not an object`);
        continue;
      }
      if (typeof entry.path !== "string" || !entry.path) {
        errors.push(`entries[${i}].path missing`);
      }
      if (!Object.prototype.hasOwnProperty.call(CATEGORIES, entry.category)) {
        errors.push(`entries[${i}].category invalid: ${entry.category}`);
      }
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function listByCategory(manifest) {
  const out = {};
  for (const k of Object.keys(CATEGORY_LABELS)) out[k] = [];
  for (const entry of manifest?.entries ?? []) {
    if (out[entry.category]) out[entry.category].push(entry);
  }
  return out;
}

/** Checksum helper — used opportunistically; never throws. */
export async function sha256OfFile(filePath) {
  return new Promise((resolve) => {
    try {
      const hash = createHash("sha256");
      const stream = createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

export function safeStat(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}
