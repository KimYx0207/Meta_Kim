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
 *     kind:        "file" | "dir" | "settings-merge" | "toml-fragment-merge" | "mcp-server"
 *                  | "pip-package" | "git-hook"
 *     installedAt: ISO-8601
 *     sha256?:     file checksum when kind === "file"
 *     size?:       bytes when kind === "file"
 *     ownershipClass?: "install_projection" | "runtime_sedimented_project_copy"
 *     mergedHookCommands?: string[]  (kind === "settings-merge")
 *     mergedSettingsKeys?: string[]  (kind === "settings-merge")
 *     tomlMutationJournal?: object[] (kind === "toml-fragment-merge")
 *     mcpServerName?: string         (kind === "mcp-server")
 *     mcpServerFingerprint?: string  (kind === "mcp-server")
 *     directoryClosureSha256?: string     (kind === "dir")
 *     directoryClosureEntryCount?: number (kind === "dir")
 *     pipPackageName?: string        (kind === "pip-package")
 *     pipPackageVersion?: string
 *   }
 *
 * Uniqueness key for entries: `${path}::${purpose}`.
 * `record()` merges in-place on matching key; `removeByPath()` drops by key.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  statSync,
  createReadStream,
  lstatSync,
  readdirSync,
  readlinkSync,
  unlinkSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir, hostname, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  invertCodexConfigMutations,
  normalizeCodexConfigMutations,
} from "./codex-config-merge.mjs";
import {
  pruneExactHistoricalHookSourceEntries,
} from "./historical-install-manifest-cleanup.mjs";

export const SCHEMA_VERSION = 1;

export const MANIFEST_LOCK_STALE_MS = 2 * 60 * 1000;
const MANIFEST_LOCK_RETRY_ATTEMPTS = 100;
const MANIFEST_LOCK_RETRY_BASE_MS = 20;
const MANIFEST_RENAME_RETRY_ATTEMPTS = 8;
const MANIFEST_RENAME_RETRY_BASE_MS = 25;
const RETRYABLE_RENAME_CODES = new Set(["EACCES", "EBUSY", "EEXIST", "EPERM"]);
export const TOML_MUTATION_JOURNAL_LIMIT = 256;
export const HISTORICAL_MIGRATION_RECEIPT_SCHEMA_VERSION = 1;
export const HISTORICAL_HOOK_SOURCE_MIGRATION_ID =
  "historical-hook-source-test-entry-v1";
export const MIGRATION_RECEIPT_LIMIT = 16;
export const MIGRATION_RECEIPT_SAMPLE_LIMIT = 32;
const MIGRATION_RECEIPT_STRING_LIMIT = 4096;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const TOML_FRAGMENT_ENTRY_FIELDS = new Set([
  "path",
  "category",
  "source",
  "purpose",
  "kind",
  "installedAt",
  "tomlMutationJournal",
]);
const TOML_MUTATION_FIELDS = new Set([
  "kind",
  "locator",
  "beforeFragment",
  "afterFragment",
]);
const TOML_MUTATION_LOCATOR_FIELDS = new Set(["table", "key"]);
const LEGACY_TOML_MERGE_FIELDS = new Set([
  "mergedHookCommands",
  "mergedHookFragments",
  "mergedSettingsKeys",
]);

// P156 remains intentionally pending: content-addressed artifact reuse needs
// a real consumer and a content-integrity design before it belongs here.

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

function fsyncDirectory(directoryPath) {
  let handle = null;
  try {
    handle = openSync(directoryPath, "r");
    fsyncSync(handle);
  } catch (error) {
    const unsupportedOnWindows =
      process.platform === "win32" &&
      ["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(error?.code);
    if (!unsupportedOnWindows) throw error;
  } finally {
    if (handle !== null) closeSync(handle);
  }
}

export async function writeManifestAtomic(
  manifestPath,
  manifest,
  {
    renameFile = renameSync,
    wait = delay,
    renameRetryAttempts = MANIFEST_RENAME_RETRY_ATTEMPTS,
  } = {},
) {
  const dir = path.dirname(manifestPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const updated = { ...manifest, updatedAt: new Date().toISOString() };
  const temporaryPath = path.join(
    dir,
    `.meta-kim-install-manifest-${process.pid}-${randomUUID()}.tmp`,
  );
  let temporaryHandle = null;
  try {
    temporaryHandle = openSync(temporaryPath, "wx");
    writeFileSync(
      temporaryHandle,
      `${JSON.stringify(updated, null, 2)}\n`,
      "utf8",
    );
    fsyncSync(temporaryHandle);
    closeSync(temporaryHandle);
    temporaryHandle = null;

    let lastError = null;
    for (let attempt = 0; attempt < renameRetryAttempts; attempt += 1) {
      try {
        renameFile(temporaryPath, manifestPath);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (
          !RETRYABLE_RENAME_CODES.has(error?.code) ||
          attempt === renameRetryAttempts - 1
        ) {
          throw error;
        }
        await wait(MANIFEST_RENAME_RETRY_BASE_MS * (attempt + 1));
      }
    }
    if (lastError) throw lastError;
    fsyncDirectory(dir);
  } finally {
    if (temporaryHandle !== null) closeSync(temporaryHandle);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
  return updated;
}

function positiveIntegerFromEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readLockSnapshot(lockPath) {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const stats = statSync(lockPath);
    let metadata = null;
    try {
      metadata = JSON.parse(raw);
    } catch {
      // Invalid legacy lock files can still be reclaimed from their mtime.
    }
    return { raw, stats, metadata };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function lockOwnerIsAlive(metadata) {
  if (
    !metadata ||
    metadata.hostname !== hostname() ||
    !Number.isSafeInteger(metadata.pid) ||
    metadata.pid <= 0
  ) {
    return false;
  }
  try {
    process.kill(metadata.pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function reclaimStaleManifestLock(lockPath, staleMs) {
  const snapshot = readLockSnapshot(lockPath);
  if (!snapshot) return true;
  const declaredAt = Date.parse(snapshot.metadata?.createdAt ?? "");
  const createdAt = Number.isFinite(declaredAt)
    ? declaredAt
    : snapshot.stats.mtimeMs;
  if (Date.now() - createdAt < staleMs || lockOwnerIsAlive(snapshot.metadata)) {
    return false;
  }

  // Re-read immediately before removal. This token/content comparison prevents
  // a stale observer from deleting a lock that another writer has refreshed.
  const current = readLockSnapshot(lockPath);
  if (
    !current ||
    current.raw !== snapshot.raw ||
    current.stats.size !== snapshot.stats.size ||
    current.stats.mtimeMs !== snapshot.stats.mtimeMs
  ) {
    return false;
  }
  try {
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

async function withManifestLock(manifestPath, operation) {
  const dir = path.dirname(manifestPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const lockPath = `${manifestPath}.lock`;
  const token = randomUUID();
  const staleMs = positiveIntegerFromEnv(
    "META_KIM_MANIFEST_LOCK_STALE_MS",
    MANIFEST_LOCK_STALE_MS,
  );
  const owner = {
    schemaVersion: 1,
    token,
    pid: process.pid,
    hostname: hostname(),
    createdAt: new Date().toISOString(),
  };
  let handle = null;
  for (let attempt = 0; attempt < MANIFEST_LOCK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      handle = openSync(lockPath, "wx");
      try {
        writeFileSync(handle, `${JSON.stringify(owner)}\n`, "utf8");
        fsyncSync(handle);
      } catch (error) {
        closeSync(handle);
        handle = null;
        try {
          unlinkSync(lockPath);
        } catch (unlinkError) {
          if (unlinkError?.code !== "ENOENT") throw unlinkError;
        }
        throw error;
      }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (reclaimStaleManifestLock(lockPath, staleMs)) continue;
      if (attempt === MANIFEST_LOCK_RETRY_ATTEMPTS - 1) {
        throw new Error(`Timed out waiting for install manifest lock: ${lockPath}`);
      }
      await delay(
        MANIFEST_LOCK_RETRY_BASE_MS * Math.min(attempt + 1, 10),
      );
    }
  }
  try {
    return await operation();
  } finally {
    if (handle !== null) closeSync(handle);
    const current = readLockSnapshot(lockPath);
    if (current?.metadata?.token === token) {
      try {
        unlinkSync(lockPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
}

function entryKey(entry) {
  return `${entry.path}::${entry.purpose ?? ""}`;
}

function matchingEntries(manifest, targetPath, purpose) {
  return (manifest?.entries ?? []).filter((entry) =>
    entry.path === targetPath &&
    (purpose === undefined || entry.purpose === purpose)
  );
}

function entriesForKey(manifest, key) {
  return (manifest?.entries ?? []).filter((entry) => entryKey(entry) === key);
}

function sameEntryState(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function record(manifest, entry) {
  const next = { ...manifest, entries: [...manifest.entries] };
  const key = entryKey(entry);
  const idx = next.entries.findIndex((e) => entryKey(e) === key);
  const stamped = {
    ...entry,
    installedAt: entry.installedAt ?? new Date().toISOString(),
  };
  const merged = idx === -1 || next.entries[idx].kind !== stamped.kind
    ? stamped
    : { ...next.entries[idx], ...stamped };
  for (const [field, value] of Object.entries(merged)) {
    if (value === undefined) delete merged[field];
  }
  if (idx === -1) next.entries.push(merged);
  else next.entries[idx] = merged;
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

function receiptDigest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function historicalReceiptIdentity({ entry, classification }) {
  return {
    path: entry.path,
    source: entry.source,
    purpose: entry.purpose,
    category: entry.category,
    runtimeTarget: entry.runtimeTarget ?? null,
    runtimeName: classification.runtimeName,
    sourceTestRoot: classification.sourceTestRoot,
  };
}

function compareReceiptIdentities(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function boundReceiptString(value) {
  if (value.length <= MIGRATION_RECEIPT_STRING_LIMIT) return value;
  const digest = receiptDigest(value);
  return `${value.slice(0, MIGRATION_RECEIPT_STRING_LIMIT - 18)}:${digest.slice(0, 16)}`;
}

function createHistoricalMigrationReceipt({ removedEntries, examinedEntryCount }) {
  const identities = removedEntries
    .map(historicalReceiptIdentity)
    .sort(compareReceiptIdentities);
  const identityPayload = JSON.stringify(identities);
  return {
    schemaVersion: HISTORICAL_MIGRATION_RECEIPT_SCHEMA_VERSION,
    migrationId: HISTORICAL_HOOK_SOURCE_MIGRATION_ID,
    operation: "remove_exact_missing_historical_hook_source_test_entries",
    appliedAt: new Date().toISOString(),
    examinedEntryCount,
    preservedEntryCount: examinedEntryCount - identities.length,
    removedEntryCount: identities.length,
    removedEntryDigest: receiptDigest(identityPayload),
    removedEntries: identities
      .slice(0, MIGRATION_RECEIPT_SAMPLE_LIMIT)
      .map((identity) => ({
        ...identity,
        path: boundReceiptString(identity.path),
        source: boundReceiptString(identity.source),
        purpose: boundReceiptString(identity.purpose),
        runtimeName: boundReceiptString(identity.runtimeName),
        sourceTestRoot: boundReceiptString(identity.sourceTestRoot),
        runtimeTarget: identity.runtimeTarget === null
          ? null
          : boundReceiptString(identity.runtimeTarget),
      })),
  };
}

function appendHistoricalMigrationReceipt(manifest, receipt) {
  const receipts = Array.isArray(manifest.migrationReceipts)
    ? manifest.migrationReceipts
    : [];
  return {
    ...manifest,
    migrationReceipts: [
      ...receipts,
      receipt,
    ].slice(-MIGRATION_RECEIPT_LIMIT),
  };
}

function validateMigrationReceipts(manifest, errors) {
  if (manifest.migrationReceipts === undefined) return;
  if (!Array.isArray(manifest.migrationReceipts)) {
    errors.push("migrationReceipts must be an array");
    return;
  }
  if (manifest.migrationReceipts.length > MIGRATION_RECEIPT_LIMIT) {
    errors.push(`migrationReceipts exceeds ${MIGRATION_RECEIPT_LIMIT} entries`);
  }
  for (const [i, receipt] of manifest.migrationReceipts.entries()) {
    const label = `migrationReceipts[${i}]`;
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (receipt.schemaVersion !== HISTORICAL_MIGRATION_RECEIPT_SCHEMA_VERSION) {
      errors.push(`${label}.schemaVersion is unsupported`);
    }
    if (receipt.migrationId !== HISTORICAL_HOOK_SOURCE_MIGRATION_ID) {
      errors.push(`${label}.migrationId is invalid`);
    }
    if (receipt.operation !== "remove_exact_missing_historical_hook_source_test_entries") {
      errors.push(`${label}.operation is invalid`);
    }
    if (
      typeof receipt.appliedAt !== "string" ||
      !Number.isFinite(Date.parse(receipt.appliedAt))
    ) {
      errors.push(`${label}.appliedAt must be an ISO date`);
    }
    for (const field of [
      "examinedEntryCount",
      "preservedEntryCount",
      "removedEntryCount",
    ]) {
      if (!Number.isSafeInteger(receipt[field]) || receipt[field] < 0) {
        errors.push(`${label}.${field} must be a non-negative integer`);
      }
    }
    if (
      Number.isSafeInteger(receipt.examinedEntryCount) &&
      Number.isSafeInteger(receipt.removedEntryCount) &&
      receipt.removedEntryCount > receipt.examinedEntryCount
    ) {
      errors.push(`${label}.removedEntryCount exceeds examinedEntryCount`);
    }
    if (!SHA256_HEX_PATTERN.test(receipt.removedEntryDigest ?? "")) {
      errors.push(`${label}.removedEntryDigest must be a SHA-256 digest`);
    }
    if (!Array.isArray(receipt.removedEntries)) {
      errors.push(`${label}.removedEntries must be an array`);
      continue;
    }
    if (receipt.removedEntries.length > MIGRATION_RECEIPT_SAMPLE_LIMIT) {
      errors.push(
        `${label}.removedEntries exceeds ${MIGRATION_RECEIPT_SAMPLE_LIMIT} samples`,
      );
    }
    if (
      Number.isSafeInteger(receipt.removedEntryCount) &&
      receipt.removedEntries.length > receipt.removedEntryCount
    ) {
      errors.push(`${label}.removedEntries exceeds removedEntryCount`);
    }
    for (const [entryIndex, entry] of receipt.removedEntries.entries()) {
      const entryLabel = `${label}.removedEntries[${entryIndex}]`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        errors.push(`${entryLabel} must be an object`);
        continue;
      }
      for (const field of ["path", "source", "purpose", "runtimeName", "sourceTestRoot"]) {
        if (
          typeof entry[field] !== "string" ||
          entry[field].length === 0 ||
          entry[field].length > MIGRATION_RECEIPT_STRING_LIMIT
        ) {
          errors.push(`${entryLabel}.${field} is invalid`);
        }
      }
      if (!Object.prototype.hasOwnProperty.call(CATEGORIES, entry.category)) {
        errors.push(`${entryLabel}.category is invalid`);
      }
      if (entry.runtimeTarget !== null && typeof entry.runtimeTarget !== "string") {
        errors.push(`${entryLabel}.runtimeTarget is invalid`);
      }
    }
  }
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
      if (entry.kind === "toml-fragment-merge") {
        const label = `entries[${i}]`;
        for (const field of Object.keys(entry)) {
          if (LEGACY_TOML_MERGE_FIELDS.has(field)) {
            errors.push(`${label}.${field} is forbidden for toml-fragment-merge`);
          } else if (!TOML_FRAGMENT_ENTRY_FIELDS.has(field)) {
            errors.push(`${label}.${field} is not allowed for toml-fragment-merge`);
          }
        }
        for (const field of ["source", "purpose", "installedAt"]) {
          if (typeof entry[field] !== "string" || !entry[field]) {
            errors.push(`${label}.${field} missing for toml-fragment-merge`);
          }
        }
        const journal = entry.tomlMutationJournal;
        if (!Array.isArray(journal) || journal.length === 0) {
          errors.push(`${label}.tomlMutationJournal must be a non-empty array`);
          continue;
        }
        if (journal.length > TOML_MUTATION_JOURNAL_LIMIT) {
          errors.push(
            `${label}.tomlMutationJournal exceeds ${TOML_MUTATION_JOURNAL_LIMIT} entries`,
          );
          continue;
        }
        for (const [mutationIndex, mutation] of journal.entries()) {
          const mutationLabel = `${label}.tomlMutationJournal[${mutationIndex}]`;
          if (!mutation || typeof mutation !== "object" || Array.isArray(mutation)) {
            errors.push(`${mutationLabel} must be an object`);
            continue;
          }
          const unexpectedMutationFields = Object.keys(mutation).filter(
            (field) => !TOML_MUTATION_FIELDS.has(field),
          );
          if (unexpectedMutationFields.length > 0) {
            errors.push(
              `${mutationLabel} has unsupported fields: ${unexpectedMutationFields.join(", ")}`,
            );
          }
          if (
            !mutation.locator ||
            typeof mutation.locator !== "object" ||
            Array.isArray(mutation.locator)
          ) {
            errors.push(`${mutationLabel}.locator must be an object`);
            continue;
          }
          const unexpectedLocatorFields = Object.keys(mutation.locator).filter(
            (field) => !TOML_MUTATION_LOCATOR_FIELDS.has(field),
          );
          if (unexpectedLocatorFields.length > 0) {
            errors.push(
              `${mutationLabel}.locator has unsupported fields: ${unexpectedLocatorFields.join(", ")}`,
            );
          }
        }
        try {
          const normalized = normalizeCodexConfigMutations(journal);
          const alreadyNormalized = normalized.length === journal.length &&
            normalized.every((mutation, mutationIndex) => {
              const recorded = journal[mutationIndex];
              return Boolean(
                recorded &&
                mutation.kind === recorded.kind &&
                mutation.locator.table === recorded.locator?.table &&
                mutation.locator.key === recorded.locator?.key &&
                mutation.beforeFragment === recorded.beforeFragment &&
                mutation.afterFragment === recorded.afterFragment
              );
            });
          if (!alreadyNormalized) {
            errors.push(`${label}.tomlMutationJournal must already be normalized`);
          }
        } catch (error) {
          errors.push(
            `${label}.tomlMutationJournal invalid: ${error?.message ?? String(error)}`,
          );
        }
      }
    }
  }
  validateMigrationReceipts(manifest, errors);
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

/**
 * Return exact on-disk integrity metadata for a managed file.
 * Recording a file without both fields would make later cleanup unable to
 * distinguish Meta_Kim output from user-owned content at the same path.
 */
export function fileIntegritySync(filePath) {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return null;
    const content = readFileSync(filePath);
    return {
      size: stat.size,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  } catch {
    return null;
  }
}

/**
 * Hash a directory as a closed set of relative paths, entry kinds, file
 * bytes, and symlink targets. Symlinks are recorded but never followed.
 */
export function directoryClosureSync(directoryPath) {
  try {
    if (!lstatSync(directoryPath).isDirectory()) return null;
    const entries = [];
    const walk = (currentPath, relativeParent = "") => {
      const names = readdirSync(currentPath).sort();
      for (const name of names) {
        const absolutePath = path.join(currentPath, name);
        const relativePath = path.posix.join(
          ...relativeParent.split(path.sep).filter(Boolean),
          name,
        );
        const stat = lstatSync(absolutePath);
        if (stat.isSymbolicLink()) {
          entries.push({
            path: relativePath,
            kind: "symlink",
            target: readlinkSync(absolutePath),
          });
        } else if (stat.isDirectory()) {
          entries.push({ path: relativePath, kind: "dir" });
          if (walk(absolutePath, path.join(relativeParent, name)) === false) return false;
        } else if (stat.isFile()) {
          const bytes = readFileSync(absolutePath);
          entries.push({
            path: relativePath,
            kind: "file",
            size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          });
        } else {
          return false;
        }
      }
      return true;
    };
    if (walk(directoryPath) === false) return null;
    const payload = JSON.stringify(entries);
    return {
      entryCount: entries.length,
      sha256: createHash("sha256").update(payload).digest("hex"),
    };
  } catch {
    return null;
  }
}

export function manifestFileEntryMatches(entry, filePath = entry?.path) {
  if (entry?.kind !== "file" || !entry?.sha256 || !Number.isFinite(entry?.size)) {
    return false;
  }
  const integrity = fileIntegritySync(filePath);
  return Boolean(
    integrity &&
    integrity.size === entry.size &&
    integrity.sha256 === entry.sha256,
  );
}

/**
 * Open a recorder that buffers entries in-memory and writes the manifest
 * on `flush()`. Designed to slot into existing sync scripts without
 * fighting their control flow: open once, call recordXxx() at every
 * write point, flush at the end.
 *
 * Recording failures are buffered and make `flush()` return `ok: false`.
 * Callers must propagate that result so a sync cannot report success while
 * its ownership manifest is incomplete.
 *
 *   const rec = openRecorder({ scope: "global", metaKimVersion: "2.0.13" });
 *   rec.recordFile("/home/kim/.claude/hooks/meta-kim/block-dangerous-bash.mjs",
 *     { source: "sync-global-meta-theory",
 *       purpose: "claude-global-hook",
 *       category: CATEGORIES.B });
 *   rec.recordSettingsMerge("/home/kim/.claude/settings.json",
 *     ["node \"...block-dangerous-bash.mjs\""],
 *     { source: "claude-settings-merge",
 *       purpose: "claude-global-settings-merge",
 *       category: CATEGORIES.C });
 *   await rec.flush();
 */
export function openRecorder({
  scope,
  repoRoot,
  metaKimVersion,
  verbose,
  replaceSources = [],
  historicalTempRoot = tmpdir(),
  requireExistingValidManifest = false,
  expectedAbsentPaths = [],
}) {
  let manifest;
  let baseManifest;
  const recordErrors = [];
  const touchedEntryKeys = new Set();
  const expectedTouchedEntryStates = new Map();
  const forgetOperations = [];
  let promotedEntries = null;
  let promotedForgetEntryStates = null;
  try {
    const existingManifest = readManifest(manifestPathFor(scope, repoRoot));
    if (requireExistingValidManifest && !existingManifest) {
      throw new Error("install manifest must already exist and be valid");
    }
    baseManifest = existingManifest ?? createEmpty({ scope, repoRoot, metaKimVersion });
    manifest = structuredClone(baseManifest);
    if (replaceSources.length > 0) {
      const sourceSet = new Set(replaceSources);
      manifest = {
        ...manifest,
        entries: manifest.entries.filter((entry) => !sourceSet.has(entry.source)),
      };
    }
    if (metaKimVersion && manifest.metaKimVersion !== metaKimVersion) {
      manifest = { ...manifest, metaKimVersion };
    }
  } catch (error) {
    if (requireExistingValidManifest) throw error;
    baseManifest = createEmpty({ scope, repoRoot, metaKimVersion });
    manifest = structuredClone(baseManifest);
  }

  const absentPathKeys = new Set(expectedAbsentPaths.map((entryPath) => {
    if (typeof entryPath !== "string" || !path.isAbsolute(entryPath)) {
      throw new Error("expectedAbsentPaths must contain absolute paths");
    }
    const normalized = path.normalize(entryPath);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }));
  const entryPathKey = (entryPath) => {
    if (typeof entryPath !== "string") return null;
    const normalized = path.normalize(entryPath);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  if (baseManifest.entries.some((entry) => absentPathKeys.has(entryPathKey(entry.path)))) {
    throw new Error("install manifest expected-absent path already has an owner");
  }

  const safeRecord = (entry) => {
    try {
      const key = entryKey(entry);
      if (!expectedTouchedEntryStates.has(key)) {
        expectedTouchedEntryStates.set(
          key,
          structuredClone(entriesForKey(baseManifest, key)),
        );
      }
      manifest = record(manifest, entry);
      touchedEntryKeys.add(key);
    } catch (e) {
      recordErrors.push(e?.message ?? String(e));
      if (verbose) console.error(`[manifest] record failed: ${e?.message}`);
    }
  };

  return {
    recordFile(
      filePath,
      {
        source,
        purpose,
        category,
        kind = "file",
        size,
        sha256,
        ownershipClass,
        runtimeTarget,
      } = {},
    ) {
      if (!filePath || !category) return;
      const integrity = kind === "file" ? fileIntegritySync(filePath) : null;
      const resolvedSize = size ?? integrity?.size;
      const resolvedSha256 = sha256 ?? integrity?.sha256;
      if (kind === "file" && (!Number.isFinite(resolvedSize) || !resolvedSha256)) {
        recordErrors.push(`cannot record file integrity: ${filePath}`);
        return;
      }
      safeRecord({
        path: filePath,
        category,
        source: source ?? "unknown",
        purpose: purpose ?? null,
        kind,
        size: resolvedSize,
        sha256: resolvedSha256,
        ownershipClass: ownershipClass ?? null,
        runtimeTarget: runtimeTarget ?? null,
      });
    },
    recordDir(dirPath, { source, purpose, category } = {}) {
      if (!dirPath || !category) return;
      const closure = directoryClosureSync(dirPath);
      if (!closure) {
        recordErrors.push(`cannot record directory closure: ${dirPath}`);
        return;
      }
      safeRecord({
        path: dirPath,
        category,
        source: source ?? "unknown",
        purpose: purpose ?? null,
        kind: "dir",
        directoryClosureSha256: closure.sha256,
        directoryClosureEntryCount: closure.entryCount,
      });
    },
    recordSettingsMerge(
      settingsPath,
      managedCommands,
      {
        source,
        purpose,
        category,
        mergedSettingsKeys,
        managedHookFragments,
      } = {},
    ) {
      if (!settingsPath || !category) return;
      safeRecord({
        path: settingsPath,
        category,
        source: source ?? "unknown",
        purpose: purpose ?? "settings-merge",
        kind: "settings-merge",
        mergedHookCommands: managedCommands ?? [],
        mergedHookFragments: managedHookFragments ?? [],
        mergedSettingsKeys: mergedSettingsKeys ?? [],
      });
    },
    recordTomlFragmentMerge(
      settingsPath,
      mutationJournal,
      { source, purpose, category } = {},
    ) {
      if (!settingsPath || !category) return;
      if (
        !Array.isArray(mutationJournal) ||
        mutationJournal.length === 0 ||
        mutationJournal.some((entry) =>
          !entry || typeof entry !== "object" || Array.isArray(entry)
        )
      ) {
        if (Array.isArray(mutationJournal) && mutationJournal.length === 0) return;
        recordErrors.push(`invalid TOML mutation journal: ${settingsPath}`);
        return;
      }
      const resolvedPurpose = purpose ?? "toml-fragment-merge";
      const previous = manifest.entries.find((entry) =>
        entry.path === settingsPath &&
        entry.purpose === resolvedPurpose &&
        entry.kind === "toml-fragment-merge" &&
        Array.isArray(entry.tomlMutationJournal)
      );
      let normalizedJournal;
      try {
        normalizedJournal = normalizeCodexConfigMutations([
          ...(previous?.tomlMutationJournal ?? []),
          ...structuredClone(mutationJournal),
        ]);
      } catch (error) {
        recordErrors.push(
          `invalid TOML mutation journal for ${settingsPath}: ${error?.message ?? String(error)}`,
        );
        return;
      }
      if (normalizedJournal.length > TOML_MUTATION_JOURNAL_LIMIT) {
        recordErrors.push(
          `TOML mutation journal exceeds ${TOML_MUTATION_JOURNAL_LIMIT} entries: ${settingsPath}`,
        );
        return;
      }
      if (normalizedJournal.length === 0) {
        manifest = removeByPath(manifest, settingsPath, resolvedPurpose);
        touchedEntryKeys.delete(entryKey({ path: settingsPath, purpose: resolvedPurpose }));
        forgetOperations.push({ targetPath: settingsPath, purpose: resolvedPurpose });
        return;
      }
      try {
        const currentBytes = readFileSync(settingsPath);
        const currentText = currentBytes.toString("utf8");
        if (!Buffer.from(currentText, "utf8").equals(currentBytes)) {
          throw new Error("config is not valid UTF-8");
        }
        invertCodexConfigMutations(currentText, normalizedJournal);
      } catch (error) {
        recordErrors.push(
          `TOML mutation journal does not match current config ${settingsPath}: ${error?.message ?? String(error)}`,
        );
        return;
      }
      safeRecord({
        path: settingsPath,
        category,
        source: source ?? "unknown",
        purpose: resolvedPurpose,
        kind: "toml-fragment-merge",
        tomlMutationJournal: normalizedJournal,
        mergedHookCommands: undefined,
        mergedHookFragments: undefined,
        mergedSettingsKeys: undefined,
      });
    },
    recordMcpServer(mcpPath, name, { source, purpose, category, fingerprint } = {}) {
      if (!mcpPath || !name || !category) return;
      safeRecord({
        path: mcpPath,
        category,
        source: source ?? "unknown",
        purpose: purpose ?? `mcp-server:${name}`,
        kind: "mcp-server",
        mcpServerName: name,
        mcpServerFingerprint: fingerprint ?? null,
      });
    },
    recordPipPackage(name, version, { source } = {}) {
      if (!name) return;
      safeRecord({
        path: `pip:${name}`,
        category: CATEGORIES.I,
        source: source ?? "unknown",
        purpose: `pip-package:${name}`,
        kind: "pip-package",
        pipPackageName: name,
        pipPackageVersion: version ?? null,
      });
    },
    forget(targetPath, purpose) {
      try {
        manifest = removeByPath(manifest, targetPath, purpose);
        forgetOperations.push({
          targetPath,
          purpose,
          expectedEntries: structuredClone(
            matchingEntries(baseManifest, targetPath, purpose),
          ),
        });
      } catch {
        /* ignore */
      }
    },
    snapshot() {
      return manifest;
    },
    async flush() {
      if (recordErrors.length > 0) {
        return {
          ok: false,
          error: `manifest recording incomplete: ${recordErrors.join("; ")}`,
          errors: [...recordErrors],
        };
      }
      const target = manifestPathFor(scope, repoRoot);
      const hasRecorderChanges =
        touchedEntryKeys.size > 0 ||
        forgetOperations.length > 0 ||
        replaceSources.length > 0;
      if (!hasRecorderChanges && scope !== "global") {
        const current = readManifest(target);
        return {
          ok: true,
          path: target,
          entries: current?.entries?.length ?? 0,
          changed: false,
        };
      }
      try {
        const outcome = await withManifestLock(target, async () => {
          const current = readManifest(target);
          if (existsSync(target) && !current) {
            throw new Error(`cannot merge invalid install manifest: ${target}`);
          }
          if (requireExistingValidManifest && !current) {
            throw new Error(`install manifest is missing or invalid: ${target}`);
          }
          if (
            current?.entries?.some((entry) => absentPathKeys.has(entryPathKey(entry.path)))
          ) {
            throw new Error("install manifest expected-absent path changed concurrently");
          }
          for (const [key, expectedEntries] of expectedTouchedEntryStates) {
            const currentEntries = entriesForKey(current, key);
            if (!sameEntryState(currentEntries, expectedEntries)) {
              throw new Error(`install manifest entry changed concurrently: ${key}`);
            }
          }
          for (const operation of forgetOperations) {
            const currentEntries = matchingEntries(
              current,
              operation.targetPath,
              operation.purpose,
            );
            if (!sameEntryState(currentEntries, operation.expectedEntries)) {
              throw new Error(
                `install manifest entry changed concurrently: ${operation.targetPath}::${operation.purpose ?? "*"}`,
              );
            }
          }
          let next = current ?? createEmpty({ scope, repoRoot, metaKimVersion });
          if (replaceSources.length > 0) {
            const sourceSet = new Set(replaceSources);
            next = {
              ...next,
              entries: next.entries.filter((entry) => !sourceSet.has(entry.source)),
            };
          }
          for (const { targetPath, purpose } of forgetOperations) {
            next = removeByPath(next, targetPath, purpose);
          }
          const localEntries = new Map(
            manifest.entries.map((entry) => [entryKey(entry), entry]),
          );
          for (const key of touchedEntryKeys) {
            const entry = localEntries.get(key);
            if (entry) next = record(next, entry);
          }
          if (metaKimVersion && next.metaKimVersion !== metaKimVersion) {
            next = { ...next, metaKimVersion };
          }
          let migrationReceipt = null;
          if (scope === "global") {
            const migration = pruneExactHistoricalHookSourceEntries(next, {
              tempRoot: historicalTempRoot,
            });
            next = migration.manifest;
            if (migration.removedEntries.length > 0) {
              migrationReceipt = createHistoricalMigrationReceipt({
                removedEntries: migration.removedEntries,
                examinedEntryCount: next.entries.length + migration.removedEntries.length,
              });
              next = appendHistoricalMigrationReceipt(next, migrationReceipt);
            }
          }
          if (!hasRecorderChanges && !migrationReceipt) {
            return {
              manifest: next,
              changed: false,
              migrationReceipt: null,
            };
          }
          return {
            manifest: await writeManifestAtomic(target, next),
            changed: true,
            migrationReceipt,
          };
        });
        const updated = outcome.manifest;
        if (hasRecorderChanges) {
          promotedEntries = new Map(
            updated.entries
              .filter((entry) => touchedEntryKeys.has(entryKey(entry)))
              .map((entry) => [entryKey(entry), entry]),
          );
          promotedForgetEntryStates = forgetOperations.map((operation) => ({
            ...operation,
            promotedEntries: structuredClone(
              matchingEntries(updated, operation.targetPath, operation.purpose),
            ),
          }));
        } else {
          promotedEntries = null;
          promotedForgetEntryStates = null;
        }
        manifest = updated;
        return {
          ok: true,
          path: target,
          entries: updated.entries.length,
          changed: outcome.changed,
          migrationReceipt: outcome.migrationReceipt,
        };
      } catch (e) {
        if (verbose) console.error(`[manifest] flush failed: ${e?.message}`);
        return { ok: false, error: e?.message ?? String(e) };
      }
    },
    async rollback() {
      if (!promotedEntries) {
        return { ok: true, changed: false, reason: "not_flushed" };
      }
      if (replaceSources.length > 0) {
        return {
          ok: false,
          error: "recorder rollback does not support replaceSources",
        };
      }
      try {
        const target = manifestPathFor(scope, repoRoot);
        const baseEntries = new Map(
          baseManifest.entries.map((entry) => [entryKey(entry), entry]),
        );
        const updated = await withManifestLock(target, async () => {
          const current = readManifest(target);
          if (!current) throw new Error(`install manifest is missing or invalid: ${target}`);
          const currentEntries = new Map(
            current.entries.map((entry) => [entryKey(entry), entry]),
          );
          for (const [key, promoted] of promotedEntries) {
            if (JSON.stringify(currentEntries.get(key)) !== JSON.stringify(promoted)) {
              throw new Error(`install manifest entry changed concurrently: ${key}`);
            }
          }
          for (const operation of promotedForgetEntryStates ?? []) {
            const currentForgottenEntries = matchingEntries(
              current,
              operation.targetPath,
              operation.purpose,
            );
            if (
              !sameEntryState(
                currentForgottenEntries,
                operation.promotedEntries,
              )
            ) {
              throw new Error(
                `install manifest entry changed concurrently: ${operation.targetPath}::${operation.purpose ?? "*"}`,
              );
            }
          }
          let next = { ...current, entries: [...current.entries] };
          for (const key of promotedEntries.keys()) {
            next.entries = next.entries.filter((entry) => entryKey(entry) !== key);
            const baseEntry = baseEntries.get(key);
            if (baseEntry) next = record(next, baseEntry);
          }
          for (const operation of forgetOperations) {
            for (const entry of operation.expectedEntries) {
              next = record(next, entry);
            }
          }
          return await writeManifestAtomic(target, next);
        });
        manifest = updated;
        promotedEntries = null;
        promotedForgetEntryStates = null;
        return { ok: true, changed: true, path: target, entries: updated.entries.length };
      } catch (e) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    },
  };
}
