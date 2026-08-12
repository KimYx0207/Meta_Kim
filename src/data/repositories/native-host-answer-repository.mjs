/**
 * Profile-local persistence for native host answer authority records.
 *
 * The Decision domain remains the record-shape and transition authority. This
 * repository contributes only durable identity uniqueness, immutable revision
 * history, and serialized compare-and-set persistence. It never interprets a
 * stored answer as execution authorization.
 *
 * These checks fail closed on observed links/reparse aliases and path identity
 * changes. Node filesystem APIs cannot make this store tamper-proof against a
 * malicious same-user process racing directory entries; the store is therefore
 * an integrity-checked local substrate, never verified host authenticity.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { assertValidNativeHostAnswerSubstrate } from "../../domain/decision/native-host-answer-authority.mjs";

export const NATIVE_HOST_ANSWER_REPOSITORY_SCHEMA_VERSION =
  "native-host-answer-repository-v1";

const LOCK_SCHEMA_VERSION = "native-host-answer-repository-lock-v1";
const STORE_DIRECTORY = "native-host-answer-authority";
const RECORDS_DIRECTORY = "records";
const STALE_LOCKS_DIRECTORY = "stale-locks";
const CONTEXTS_DIRECTORY = "contexts";
const HOST_EVENTS_DIRECTORY = "host-events";
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const SHA256_REFERENCE_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 10;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_LOCK_BYTES = 8 * 1024;
const PROCESS_START_REF = `sha256:${sha256(Buffer.from(`${process.pid}:${Math.trunc((Date.now() - process.uptime() * 1_000) / 1_000)}`))}`;
const IMMUTABLE_AUTHORITY_FIELDS = Object.freeze([
  "schemaVersion", "kind", "substrateRef", "substrateDigest", "decisionId",
  "presentedRevision", "runId", "challengeRef", "challengeDigest", "runtime",
  "surface", "hostEventClaimRef", "hostEventClaimDigest",
  "renderedHostPayloadDigest", "hostConnectionRef",
  "sessionOrThreadRef", "turnRef", "itemRef", "toolUseOrRequestRef",
  "issuedAt", "expiresAt", "presentationTimeSourceClaimRef",
]);
const UNIQUE_HOST_BINDING_FIELDS = Object.freeze([
  "challengeRef", "challengeDigest", "runtime", "surface", "hostConnectionRef",
  "sessionOrThreadRef", "turnRef", "itemRef", "toolUseOrRequestRef",
]);
const HOST_EVENT_CONTEXT_FIELDS = Object.freeze([
  "runtime", "surface", "hostConnectionRef", "sessionOrThreadRef", "turnRef",
  "itemRef", "toolUseOrRequestRef",
]);

const TRANSITION_STATES = Object.freeze({
  observe: Object.freeze({ from: ["presented"], to: "host_return_observed" }),
  consume: Object.freeze({ from: ["host_return_observed"], to: "consumed" }),
  expire: Object.freeze({ from: ["presented", "host_return_observed"], to: "expired" }),
  invalidate: Object.freeze({ from: ["presented", "host_return_observed"], to: "invalidated" }),
});

function fail(message, code = "NATIVE_HOST_ANSWER_REPOSITORY_INVALID") {
  const error = new Error(`Native host answer repository: ${message}`);
  error.code = code;
  throw error;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function inside(candidate, root) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function samePath(left, right) {
  const normalize = (value) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  return normalize(path.resolve(left)) === normalize(path.resolve(right));
}

function assertAbsolutePlainRoot(profileRoot) {
  if (typeof profileRoot !== "string" || !path.isAbsolute(profileRoot)) {
    fail("profileRoot must be an explicit absolute allowed root");
  }
  const requested = path.resolve(profileRoot);
  if (!existsSync(requested)) fail("profileRoot does not exist");
  const stats = lstatSync(requested);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    fail("profileRoot must be an ordinary non-link directory");
  }
  const real = realpathSync.native(requested);
  if (!samePath(real, requested)) {
    fail("profileRoot must not resolve through a symlink, junction, or reparse alias");
  }
  return real;
}

function assertPlainDirectory(directoryPath, allowedRoot, label) {
  if (!existsSync(directoryPath)) fail(`${label} does not exist`);
  const stats = lstatSync(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    fail(`${label} must be an ordinary non-link directory`);
  }
  const real = realpathSync.native(directoryPath);
  if (!inside(real, allowedRoot)) fail(`${label} escapes the allowed profile root`);
  if (!samePath(real, directoryPath)) {
    fail(`${label} must not resolve through a symlink, junction, or reparse alias`);
  }
  return real;
}

function ensurePlainDirectory(directoryPath, allowedRoot, label) {
  if (!inside(path.resolve(directoryPath), allowedRoot)) {
    fail(`${label} escapes the allowed profile root`);
  }
  if (!existsSync(directoryPath)) mkdirSync(directoryPath);
  return assertPlainDirectory(directoryPath, allowedRoot, label);
}

function fsyncParentBestEffort(filePath) {
  if (process.platform === "win32") return false;
  let handle;
  try {
    handle = openSync(path.dirname(filePath), "r");
    fsyncSync(handle);
    return true;
  } catch {
    // Explicit degradation: file bytes remain fsynced and every reopen is
    // integrity-checked, but directory-entry crash durability is not claimed.
    return false;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function writeExclusive(filePath, text) {
  let handle;
  try {
    handle = openSync(filePath, "wx", 0o600);
    writeFileSync(handle, text, "utf8");
    fsyncSync(handle);
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
  fsyncParentBestEffort(filePath);
}

function writeImmutable(filePath, text) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeExclusive(temporary, text);
    linkSync(temporary, filePath);
    fsyncParentBestEffort(filePath);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function assertSafeFilePath(filePath, allowedRoot, label) {
  const requested = path.resolve(filePath);
  if (!inside(requested, allowedRoot)) fail(`${label} escapes its allowed root`);
  let current = allowedRoot;
  const segments = path.relative(allowedRoot, requested).split(path.sep).filter(Boolean);
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    assertPlainDirectory(current, allowedRoot, `${label} ancestor`);
  }
  const stats = lstatSync(requested);
  if (!stats.isFile() || stats.isSymbolicLink()) fail(`${label} must be a regular non-link file`);
  const real = realpathSync.native(requested);
  if (!inside(real, allowedRoot) || !samePath(real, requested)) {
    fail(`${label} escapes its allowed root or resolves through a link`);
  }
  return { requested, real, stats };
}

function readBoundBytes(filePath, allowedRoot, label) {
  const { requested, real, stats } = assertSafeFilePath(filePath, allowedRoot, label);
  if (stats.size > MAX_RECORD_BYTES) fail(`${label} exceeds the bounded record size`);
  const handle = openSync(real, "r");
  try {
    const before = fstatSync(handle);
    if (!before.isFile() || before.size > MAX_RECORD_BYTES || before.ino !== stats.ino || before.dev !== stats.dev) fail(`${label} changed before read`);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(handle, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(handle);
    const rebound = assertSafeFilePath(requested, allowedRoot, label);
    if (
      offset !== bytes.length ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      after.ino !== rebound.stats.ino ||
      after.dev !== rebound.stats.dev
    ) {
      fail(`${label} changed while read`);
    }
    return bytes;
  } finally {
    closeSync(handle);
  }
}

function parseBoundJson(filePath, allowedRoot, label) {
  let value;
  try {
    value = JSON.parse(readBoundBytes(filePath, allowedRoot, label).toString("utf8"));
  } catch (error) {
    if (error?.code?.startsWith("NATIVE_HOST_ANSWER_")) throw error;
    fail(`${label} is not valid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must contain an object`);
  }
  return value;
}

function exactDataRecord(value, fields, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(`${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  ) {
    fail(`${label} has unsupported or missing fields`);
  }
  const snapshot = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      fail(`${label} must contain enumerable own data properties only`);
    }
    snapshot[field] = descriptor.value;
  }
  return snapshot;
}

function assertCasInput(value) {
  const input = exactDataRecord(
    value,
    ["record", "expectedRevision", "expectedSubstrateDigest", "expectedState"],
    "transition input",
  );
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    fail("expectedRevision must be a non-negative safe integer");
  }
  if (
    typeof input.expectedSubstrateDigest !== "string" ||
    !SHA256_REFERENCE_PATTERN.test(input.expectedSubstrateDigest)
  ) {
    fail("expectedSubstrateDigest must be a strict sha256 reference");
  }
  if (typeof input.expectedState !== "string" || !input.expectedState) {
    fail("expectedState must be a state string");
  }
  return input;
}

function safeCasInput(value) {
  try { return assertCasInput(value); }
  catch (error) {
    if (error?.code?.startsWith("NATIVE_HOST_ANSWER_")) throw error;
    fail("transition input could not be safely snapshotted");
  }
}

function substrateKey(substrateRef) {
  if (typeof substrateRef !== "string" || !substrateRef) {
    fail("substrateRef must be a validated non-empty reference");
  }
  return sha256(Buffer.from(substrateRef, "utf8"));
}

function revisionName(revision) {
  if (!Number.isSafeInteger(revision) || revision < 0) fail("record revision is invalid");
  return `${String(revision).padStart(12, "0")}.json`;
}

function recordEnvelope(record) {
  const body = {
    schemaVersion: NATIVE_HOST_ANSWER_REPOSITORY_SCHEMA_VERSION,
    kind: "native_host_answer_authority_revision",
    record,
  };
  // Corruption detection only. This self-hash is not an authenticity proof.
  return { ...body, storageDigest: `sha256:${sha256(canonicalJson(body))}` };
}

function validateEnvelope(value, identityKey, revision) {
  if (
    value?.schemaVersion !== NATIVE_HOST_ANSWER_REPOSITORY_SCHEMA_VERSION ||
    value?.kind !== "native_host_answer_authority_revision" ||
    typeof value?.storageDigest !== "string"
  ) {
    fail("stored authority revision has an unsupported envelope");
  }
  const body = {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    record: value.record,
  };
  if (`sha256:${sha256(canonicalJson(body))}` !== value.storageDigest) {
    fail("stored authority revision digest is invalid");
  }
  const record = validateAuthorityRecord(value.record);
  if (substrateKey(record.substrateRef) !== identityKey || record.revision !== revision) {
    fail("stored authority revision path binding is invalid");
  }
  return record;
}

function validateAuthorityRecord(value) {
  try {
    return assertValidNativeHostAnswerSubstrate(value);
  } catch {
    fail("substrate record failed domain validation");
  }
}

function readSmallText(filePath, label) {
  const stats = lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_LOCK_BYTES) {
    fail(`${label} is not a bounded regular non-link file`);
  }
  return readFileSync(filePath, "utf8");
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

function waitFor(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function safeLockOwner(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.length !== 5 ||
    !["schemaVersion", "token", "pid", "processStartRef", "createdAt"].every((key) => keys.includes(key)) ||
    value.schemaVersion !== LOCK_SCHEMA_VERSION ||
    typeof value.token !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(value.token) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.processStartRef !== "string" ||
    !SHA256_REFERENCE_PATTERN.test(value.processStartRef) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    return null;
  }
  return value;
}

function preserveStaleLock(paths, snapshot, token) {
  ensurePlainDirectory(paths.staleLocksDir, paths.root, "stale lock evidence directory");
  const evidence = path.join(
    paths.staleLocksDir,
    `${Date.now()}-${process.pid}-${token}.json`,
  );
  try {
    if (readSmallText(paths.lockPath, "write lock") !== snapshot) return false;
    renameSync(paths.lockPath, evidence);
    fsyncParentBestEffort(paths.lockPath);
    fsyncParentBestEffort(evidence);
    return true;
  } catch (error) {
    if (["ENOENT", "EEXIST"].includes(error?.code)) return false;
    throw error;
  }
}

function acquireLock(paths, options) {
  const deadline = performance.now() + options.lockTimeoutMs;
  const token = randomUUID();
  while (true) {
    try {
      writeExclusive(
        paths.lockPath,
        jsonText({
          schemaVersion: LOCK_SCHEMA_VERSION,
          token,
          pid: process.pid,
          processStartRef: PROCESS_START_REF,
          createdAt: new Date().toISOString(),
        }),
      );
      const confirmed = safeLockOwner(JSON.parse(readSmallText(paths.lockPath, "write lock")));
      if (
        confirmed?.token !== token ||
        confirmed.pid !== process.pid ||
        confirmed.processStartRef !== PROCESS_START_REF
      ) {
        fail("write lock ownership changed before the critical section", "NATIVE_HOST_ANSWER_REPOSITORY_BUSY");
      }
      return token;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const lockStats = lstatSync(paths.lockPath);
      if (!lockStats.isFile() || lockStats.isSymbolicLink()) {
        fail("write lock is not a regular non-link file", "NATIVE_HOST_ANSWER_REPOSITORY_UNSAFE_LOCK");
      }
      let snapshot = null;
      let owner = null;
      try {
        snapshot = readSmallText(paths.lockPath, "write lock");
        owner = safeLockOwner(JSON.parse(snapshot));
      } catch {
        // An unknown or malformed owner is never recoverable; fail closed.
      }
      const ownerAlive = owner ? processIsAlive(owner.pid) : null;
      const recoverable = owner && ownerAlive === false;
      if (recoverable && snapshot !== null) {
        waitFor(LOCK_POLL_MS);
        let stable = false;
        try { stable = readSmallText(paths.lockPath, "write lock") === snapshot; } catch {}
        if (stable && preserveStaleLock(paths, snapshot, token)) continue;
      }
      if (performance.now() >= deadline) {
        fail(
          "store remained locked by a live or unproven owner",
          "NATIVE_HOST_ANSWER_REPOSITORY_BUSY",
        );
      }
      waitFor(LOCK_POLL_MS);
    }
  }
}

function releaseLock(paths, token) {
  try {
    const stats = lstatSync(paths.lockPath);
    if (!stats.isFile() || stats.isSymbolicLink()) return;
    const owner = safeLockOwner(JSON.parse(readSmallText(paths.lockPath, "write lock")));
    if (owner?.token === token && owner.pid === process.pid && owner.processStartRef === PROCESS_START_REF) {
      unlinkSync(paths.lockPath);
      fsyncParentBestEffort(paths.lockPath);
    }
  } catch {
    // Never remove a lock that cannot be proven to belong to this process.
  }
}

function listRevisionNumbers(identityDir, root) {
  if (!existsSync(identityDir)) return [];
  assertPlainDirectory(identityDir, root, "authority identity directory");
  const revisions = [];
  for (const entry of readdirSync(identityDir, { withFileTypes: true })) {
    if (entry.isFile() && /^\d{12}\.json\.\d+\.[a-f0-9-]{36}\.tmp$/u.test(entry.name)) continue;
    if (!entry.isFile() || !/^\d{12}\.json$/u.test(entry.name)) {
      fail("authority identity directory contains an unexpected entry");
    }
    const revision = Number(entry.name.slice(0, -5));
    if (!Number.isSafeInteger(revision)) fail("authority revision filename is invalid");
    revisions.push(revision);
  }
  revisions.sort((left, right) => left - right);
  for (let index = 0; index < revisions.length; index += 1) {
    if (revisions[index] !== index) fail("authority revision chain is not contiguous");
  }
  return revisions;
}

function readRevision(paths, identityKey, revision) {
  const identityDir = path.join(paths.recordsDir, identityKey);
  const filePath = path.join(identityDir, revisionName(revision));
  const envelope = parseBoundJson(filePath, paths.root, "authority revision");
  return validateEnvelope(envelope, identityKey, revision);
}

function readLatest(paths, substrateRef) {
  const identityKey = substrateKey(substrateRef);
  const identityDir = path.join(paths.recordsDir, identityKey);
  const revisions = listRevisionNumbers(identityDir, paths.root);
  if (revisions.length === 0) return null;
  return readRevision(paths, identityKey, revisions.at(-1));
}

function uniqueHostBindingDigest(record) {
  return sha256(canonicalJson(Object.fromEntries(
    UNIQUE_HOST_BINDING_FIELDS.map((field) => [field, record[field]]),
  )));
}

function hostEventContextDigest(record) {
  return sha256(canonicalJson(Object.fromEntries(
    HOST_EVENT_CONTEXT_FIELDS.map((field) => [field, record[field]]),
  )));
}

function hostEventMarker(record) {
  const body = {
    schemaVersion: NATIVE_HOST_ANSWER_REPOSITORY_SCHEMA_VERSION,
    kind: "native_host_event_uniqueness",
    contextDigest: hostEventContextDigest(record),
    claimRefDigest: sha256(Buffer.from(record.hostEventClaimRef, "utf8")),
    hostEventClaimDigest: record.hostEventClaimDigest.slice("sha256:".length),
    substrateKey: substrateKey(record.substrateRef),
  };
  return { ...body, storageDigest: `sha256:${sha256(canonicalJson(body))}` };
}

function readHostEventMarkers(paths) {
  const markers = new Map();
  for (const entry of readdirSync(paths.hostEventsDir, { withFileTypes: true })) {
    if (entry.isFile() && /^[a-f0-9]{64}\.json\.\d+\.[a-f0-9-]{36}\.tmp$/u.test(entry.name)) continue;
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) {
      fail("host-event uniqueness index contains an unexpected entry");
    }
    const value = parseBoundJson(path.join(paths.hostEventsDir, entry.name), paths.root, "host-event uniqueness marker");
    const body = {
      schemaVersion: value.schemaVersion,
      kind: value.kind,
      contextDigest: value.contextDigest,
      claimRefDigest: value.claimRefDigest,
      hostEventClaimDigest: value.hostEventClaimDigest,
      substrateKey: value.substrateKey,
    };
    if (
      body.schemaVersion !== NATIVE_HOST_ANSWER_REPOSITORY_SCHEMA_VERSION ||
      body.kind !== "native_host_event_uniqueness" ||
      !HASH_PATTERN.test(body.contextDigest ?? "") ||
      !HASH_PATTERN.test(body.claimRefDigest ?? "") ||
      !HASH_PATTERN.test(body.hostEventClaimDigest ?? "") ||
      !HASH_PATTERN.test(body.substrateKey ?? "") ||
      entry.name !== `${body.contextDigest}.json` ||
      value.storageDigest !== `sha256:${sha256(canonicalJson(body))}`
    ) {
      fail("host-event uniqueness marker is invalid");
    }
    markers.set(body.contextDigest, body);
  }
  return markers;
}

function reconcileHostEventIndex(paths) {
  const records = readAllLatest(paths);
  const markers = readHostEventMarkers(paths);
  const seenContexts = new Map();
  const seenClaimRefs = new Map();
  const seenClaimDigests = new Map();
  for (const record of records) {
    const marker = hostEventMarker(record);
    const key = marker.substrateKey;
    for (const [seen, identity, label] of [
      [seenContexts, marker.contextDigest, "host-event context"],
      [seenClaimRefs, marker.claimRefDigest, "host-event claim ref"],
      [seenClaimDigests, marker.hostEventClaimDigest, "host-event claim digest"],
    ]) {
      if (seen.has(identity) && seen.get(identity) !== key) fail(`duplicate ${label} exists in substrate records`);
      seen.set(identity, key);
    }
    const stored = markers.get(marker.contextDigest);
    if (stored && canonicalJson(stored) !== canonicalJson({ ...marker, storageDigest: undefined })) {
      fail("host-event uniqueness marker conflicts with substrate record");
    }
    if (!stored) {
      writeImmutable(path.join(paths.hostEventsDir, `${marker.contextDigest}.json`), jsonText(marker));
    }
  }
  for (const [digest, marker] of markers) {
    if (seenContexts.get(digest) !== marker.substrateKey) fail("orphan host-event uniqueness marker requires recovery");
  }
  return { records, markers: readHostEventMarkers(paths), seenClaimRefs, seenClaimDigests };
}

function contextMarker(record) {
  const body = {
    schemaVersion: NATIVE_HOST_ANSWER_REPOSITORY_SCHEMA_VERSION,
    kind: "native_host_context_uniqueness",
    contextDigest: uniqueHostBindingDigest(record),
    substrateKey: substrateKey(record.substrateRef),
  };
  return { ...body, storageDigest: `sha256:${sha256(canonicalJson(body))}` };
}

function readContextMarkers(paths) {
  const markers = new Map();
  for (const entry of readdirSync(paths.contextsDir, { withFileTypes: true })) {
    if (entry.isFile() && /^[a-f0-9]{64}\.json\.\d+\.[a-f0-9-]{36}\.tmp$/u.test(entry.name)) continue;
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) {
      fail("context uniqueness index contains an unexpected entry");
    }
    const value = parseBoundJson(path.join(paths.contextsDir, entry.name), paths.root, "context uniqueness marker");
    const body = {
      schemaVersion: value.schemaVersion,
      kind: value.kind,
      contextDigest: value.contextDigest,
      substrateKey: value.substrateKey,
    };
    if (
      body.schemaVersion !== NATIVE_HOST_ANSWER_REPOSITORY_SCHEMA_VERSION ||
      body.kind !== "native_host_context_uniqueness" ||
      !HASH_PATTERN.test(body.contextDigest ?? "") ||
      !HASH_PATTERN.test(body.substrateKey ?? "") ||
      entry.name !== `${body.contextDigest}.json` ||
      value.storageDigest !== `sha256:${sha256(canonicalJson(body))}`
    ) {
      fail("context uniqueness marker is invalid");
    }
    markers.set(body.contextDigest, body.substrateKey);
  }
  return markers;
}

function reconcileContextIndex(paths) {
  const records = readAllLatest(paths);
  const markers = readContextMarkers(paths);
  const seen = new Map();
  for (const record of records) {
    const digest = uniqueHostBindingDigest(record);
    const key = substrateKey(record.substrateRef);
    if (seen.has(digest) && seen.get(digest) !== key) fail("duplicate host context exists in authority records");
    seen.set(digest, key);
    const markerKey = markers.get(digest);
    if (markerKey && markerKey !== key) fail("context uniqueness marker conflicts with authority record");
    if (!markerKey) {
      writeImmutable(path.join(paths.contextsDir, `${digest}.json`), jsonText(contextMarker(record)));
    }
  }
  for (const [digest, key] of markers) {
    if (seen.get(digest) !== key) fail("orphan context uniqueness marker requires recovery");
  }
  return { records, markers: readContextMarkers(paths) };
}

function readAllLatest(paths) {
  const records = [];
  for (const entry of readdirSync(paths.recordsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !HASH_PATTERN.test(entry.name)) {
      fail("authority records directory contains an unexpected entry");
    }
    const revisions = listRevisionNumbers(path.join(paths.recordsDir, entry.name), paths.root);
    if (revisions.length > 0) records.push(readRevision(paths, entry.name, revisions.at(-1)));
  }
  return records;
}

function appendRevision(paths, record) {
  const identityKey = substrateKey(record.substrateRef);
  const identityDir = path.join(paths.recordsDir, identityKey);
  ensurePlainDirectory(identityDir, paths.root, "authority identity directory");
  const filePath = path.join(identityDir, revisionName(record.revision));
  try {
    writeImmutable(filePath, jsonText(recordEnvelope(record)));
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail("authority revision already exists", "NATIVE_HOST_ANSWER_REPOSITORY_CONFLICT");
    }
    throw error;
  }
  return readRevision(paths, identityKey, record.revision);
}

function preparePaths(profileRoot) {
  const allowedRoot = assertAbsolutePlainRoot(profileRoot);
  const root = path.join(allowedRoot, STORE_DIRECTORY);
  ensurePlainDirectory(root, allowedRoot, "native host answer repository root");
  const recordsDir = path.join(root, RECORDS_DIRECTORY);
  ensurePlainDirectory(recordsDir, root, "authority records directory");
  const contextsDir = path.join(root, CONTEXTS_DIRECTORY);
  ensurePlainDirectory(contextsDir, root, "context uniqueness index directory");
  const hostEventsDir = path.join(root, HOST_EVENTS_DIRECTORY);
  ensurePlainDirectory(hostEventsDir, root, "host-event uniqueness index directory");
  return {
    profileRoot: allowedRoot,
    root,
    recordsDir,
    contextsDir,
    hostEventsDir,
    staleLocksDir: path.join(root, STALE_LOCKS_DIRECTORY),
    lockPath: path.join(root, "write.lock"),
  };
}

function withLock(paths, options, callback) {
  assertPlainDirectory(paths.root, paths.profileRoot, "native host answer repository root");
  assertPlainDirectory(paths.recordsDir, paths.root, "authority records directory");
  assertPlainDirectory(paths.contextsDir, paths.root, "context uniqueness index directory");
  assertPlainDirectory(paths.hostEventsDir, paths.root, "host-event uniqueness index directory");
  const token = acquireLock(paths, options);
  try {
    return callback();
  } finally {
    releaseLock(paths, token);
  }
}

function assertTransition(kind, current, next, expected) {
  const policy = TRANSITION_STATES[kind];
  if (
    current.revision !== expected.expectedRevision ||
    current.substrateDigest !== expected.expectedSubstrateDigest ||
    current.state !== expected.expectedState
  ) {
    fail("compare-and-set precondition failed", "NATIVE_HOST_ANSWER_REPOSITORY_CAS_MISMATCH");
  }
  if (!policy.from.includes(current.state) || next.state !== policy.to) {
    fail(`${kind} is not a legal repository transition`);
  }
  if (
    next.substrateRef !== current.substrateRef ||
    next.revision !== current.revision + 1
  ) {
    fail("next authority record does not continue the current revision");
  }
  for (const field of IMMUTABLE_AUTHORITY_FIELDS) {
    if (next[field] !== current[field]) {
      fail(`next authority record changed immutable binding ${field}`);
    }
  }
}

/**
 * Open a repository rooted below an already-selected profile state directory.
 * The caller owns project/profile selection; this port refuses implicit cwd,
 * environment, or home-directory authority.
 */
export function createNativeHostAnswerRepository({
  profileRoot,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
} = {}) {
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0) {
    fail("lockTimeoutMs must be a non-negative safe integer");
  }
  const paths = preparePaths(profileRoot);
  const lockOptions = Object.freeze({ lockTimeoutMs });

  function issue(candidate) {
    const record = validateAuthorityRecord(candidate);
    if (record.state !== "presented" || record.revision !== 0) {
      fail("issue requires a presented revision-zero authority record");
    }
    return withLock(paths, lockOptions, () => {
      if (readLatest(paths, record.substrateRef) !== null) {
        fail("substrateRef was already issued", "NATIVE_HOST_ANSWER_REPOSITORY_REPLAY");
      }
      const bindingDigest = uniqueHostBindingDigest(record);
      const index = reconcileContextIndex(paths);
      const hostEvents = reconcileHostEventIndex(paths);
      if (index.records.some((current) =>
        current.challengeRef === record.challengeRef ||
        current.challengeDigest === record.challengeDigest
      )) {
        fail("native challenge was already issued", "NATIVE_HOST_ANSWER_REPOSITORY_REPLAY");
      }
      if (index.markers.has(bindingDigest)) {
        fail("host challenge/request binding was already issued", "NATIVE_HOST_ANSWER_REPOSITORY_REPLAY");
      }
      const eventMarker = hostEventMarker(record);
      if (
        hostEvents.markers.has(eventMarker.contextDigest) ||
        hostEvents.seenClaimRefs.has(eventMarker.claimRefDigest) ||
        hostEvents.seenClaimDigests.has(eventMarker.hostEventClaimDigest)
      ) {
        fail("host event was already issued", "NATIVE_HOST_ANSWER_REPOSITORY_REPLAY");
      }
      const stored = appendRevision(paths, record);
      writeImmutable(path.join(paths.contextsDir, `${bindingDigest}.json`), jsonText(contextMarker(record)));
      writeImmutable(path.join(paths.hostEventsDir, `${eventMarker.contextDigest}.json`), jsonText(eventMarker));
      return stored;
    });
  }

  function transition(kind, candidate) {
    const input = safeCasInput(candidate);
    const next = validateAuthorityRecord(input.record);
    return withLock(paths, lockOptions, () => {
      reconcileContextIndex(paths);
      reconcileHostEventIndex(paths);
      const current = readLatest(paths, next.substrateRef);
      if (!current) fail("substrateRef has not been issued", "NATIVE_HOST_ANSWER_REPOSITORY_NOT_FOUND");
      assertTransition(kind, current, next, input);
      return appendRevision(paths, next);
    });
  }

  function read(candidate) {
    let input;
    try { input = exactDataRecord(candidate, ["substrateRef"], "read input"); }
    catch (error) {
      if (error?.code?.startsWith("NATIVE_HOST_ANSWER_")) throw error;
      fail("read input could not be safely snapshotted");
    }
    return withLock(paths, lockOptions, () => {
      reconcileContextIndex(paths);
      reconcileHostEventIndex(paths);
      const record = readLatest(paths, input.substrateRef);
      if (!record) fail("substrateRef was not found", "NATIVE_HOST_ANSWER_REPOSITORY_NOT_FOUND");
      return record;
    });
  }

  return Object.freeze({
    paths: Object.freeze({
      profileRoot: paths.profileRoot,
      root: paths.root,
      recordsDir: paths.recordsDir,
    }),
    issue,
    observe: (input) => transition("observe", input),
    consume: (input) => transition("consume", input),
    expire: (input) => transition("expire", input),
    invalidate: (input) => transition("invalidate", input),
    read,
  });
}
