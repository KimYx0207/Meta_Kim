/**
 * Append-only, human-authored B2 design snapshots. A version is an immutable
 * evidence file, not a runnable Meta_Kim graph, native session, or scheduler.
 */
import { createHash } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, rmdirSync, statSync, writeFileSync,
} from "node:fs";
import path from "node:path";

import { AGENT_WORKFLOW_KEY_PATTERN, agentWorkflowConflict } from "../../domain/runtime/agent-workflow-decision.mjs";
import {
  AGENT_DESIGN_SCHEMA, AGENT_DESIGN_RECORD_SCHEMA, AGENT_DESIGN_MAX_VERSIONS,
  applyDesignMutation, designArtifactDigest, designVersionDigest,
  validateDesignMutation,
} from "../../domain/runtime/agent-design-contract.mjs";

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_DESIGN_RECORD_BYTES = 1_048_576;
const VERSION_FILE = /^v([0-9]{6})\.json$/u;

function directoryFor(stateRoot, key) {
  if (!AGENT_WORKFLOW_KEY_PATTERN.test(key ?? "")) throw new TypeError("Invalid design request key");
  return path.join(stateRoot, `${key}.design`);
}

function verifyDirectory(directory) {
  if (!existsSync(directory)) return false;
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw agentWorkflowConflict("agent_design_state_path_invalid");
  return true;
}

function readVersionFile(directory, version) {
  const filename = path.join(directory, `v${String(version).padStart(6, "0")}.json`);
  if (lstatSync(filename).isSymbolicLink()) throw agentWorkflowConflict("agent_design_state_path_invalid");
  let fd;
  try {
    fd = openSync(filename, constants.O_RDONLY | O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_DESIGN_RECORD_BYTES) {
      throw agentWorkflowConflict("agent_design_record_invalid");
    }
    return JSON.parse(readFileSync(fd, "utf8"));
  } catch {
    throw agentWorkflowConflict("agent_design_record_invalid");
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function readHistory(stateRoot, key, basis) {
  const directory = directoryFor(stateRoot, key);
  if (!verifyDirectory(directory)) return [];
  const names = readdirSync(directory).filter((name) => VERSION_FILE.test(name));
  if (names.length > AGENT_DESIGN_MAX_VERSIONS) throw agentWorkflowConflict("agent_design_version_limit");
  const numbers = names.map((name) => Number(VERSION_FILE.exec(name)[1])).sort((a, b) => a - b);
  const records = [];
  for (let index = 0; index < numbers.length; index++) {
    if (numbers[index] !== index + 1) throw agentWorkflowConflict("agent_design_version_gap");
    const record = readVersionFile(directory, index + 1);
    if (!record || record.schemaVersion !== AGENT_DESIGN_RECORD_SCHEMA
      || record.version !== index + 1 || record.basis?.projectFingerprint !== basis.projectFingerprint
      || record.basis?.idempotencyKey !== key
      || JSON.stringify(record.basis) !== JSON.stringify(basis)
      || record.previousDigest !== (records.at(-1)?.recordDigest ?? null)
      || record.artifactDigest !== designArtifactDigest(basis, record.content)
      || record.recordDigest !== designVersionDigest(record)) {
      throw agentWorkflowConflict("agent_design_integrity_failed");
    }
    records.push(record);
  }
  return records;
}

function digestMutation(mutation) {
  return createHash("sha256").update("meta-kim-human-design-mutation-v1\u0000")
    .update(JSON.stringify(mutation)).digest("hex");
}

function publicSnapshot(records, basis, version = null, { replayed = false, replayVersion = null } = {}) {
  const latest = records.at(-1) ?? null;
  const selected = version == null ? latest : records.find((record) => record.version === version);
  if (version != null && !selected) throw agentWorkflowConflict("agent_design_version_not_found");
  const history = records.map((record) => ({ version: record.version, action: record.action,
    mutationKey: record.mutationKey, recordedAt: record.recordedAt,
    designDigest: record.artifactDigest, changedNodeIds: record.changedNodeIds,
    invalidatedModuleIds: record.invalidatedModuleIds,
    ...(record.reviewNote && { reviewNote: record.reviewNote }),
    ...(record.resolvedReviewNoteIds?.length && { resolvedReviewNoteIds: record.resolvedReviewNoteIds }) }));
  return {
    schemaVersion: AGENT_DESIGN_SCHEMA,
    status: selected?.status ?? "not_started",
    version: selected?.version ?? 0,
    currentVersion: latest?.version ?? 0,
    historical: Boolean(selected && latest && selected.version !== latest.version),
    basis,
    source: "human_submitted_prd",
    ...(selected?.sourceDraftDigest && { sourceDraftDigest: selected.sourceDraftDigest,
      draftSource: "native_readonly_unverified", nativeEvidenceVerified: false }),
    designDigest: selected?.artifactDigest ?? null,
    recordDigest: selected?.recordDigest ?? null,
    system: selected?.content.system ?? null,
    modules: selected?.content.modules ?? [],
    pendingReviewNotes: selected?.content.pendingReviewNotes ?? [],
    history,
    ...(selected && { mutation: { action: selected.action, mutationKey: selected.mutationKey,
      recordedAt: selected.recordedAt, changedNodeIds: selected.changedNodeIds,
      invalidatedModuleIds: selected.invalidatedModuleIds } }),
    ...(replayed && { replayed: true, replayVersion }),
    reviewComplete: selected?.status === "approved",
    readyForExecution: false,
    executionAuthorized: false,
    runId: null,
  };
}

function writeImmutableVersion(directory, record) {
  const filename = path.join(directory, `v${String(record.version).padStart(6, "0")}.json`);
  const json = JSON.stringify(record);
  if (Buffer.byteLength(json, "utf8") > MAX_DESIGN_RECORD_BYTES) {
    throw new TypeError("Design artifact exceeds the per-version size limit");
  }
  let fd;
  try {
    fd = openSync(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
    writeFileSync(fd, json, "utf8");
    fsyncSync(fd);
  } catch (error) {
    if (error.code === "EEXIST") throw agentWorkflowConflict("agent_design_concurrent_version_conflict");
    // A partially written, exclusive filename must not be automatically
    // erased; subsequent reads fail closed until the owner repairs evidence.
    throw error;
  } finally {
    if (fd != null) closeSync(fd);
  }
}

export function createAgentDesignStore({ stateRoot } = {}) {
  if (typeof stateRoot !== "string" || !path.isAbsolute(stateRoot) || !statSync(stateRoot).isDirectory()
    || lstatSync(stateRoot).isSymbolicLink()) throw new TypeError("Design store requires trusted state directory");

  function inspect({ idempotencyKey, basis, version = null }) {
    const records = readHistory(stateRoot, idempotencyKey, basis);
    if (version != null && (!Number.isSafeInteger(version) || version < 1)) {
      throw new TypeError("Invalid design history version");
    }
    return publicSnapshot(records, basis, version);
  }

  function commit({ input, basis }) {
    const mutation = validateDesignMutation(input);
    if (!mutation) throw new TypeError("Invalid design mutation payload");
    const directory = directoryFor(stateRoot, mutation.idempotencyKey);
    if (!verifyDirectory(directory)) {
      try { mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      verifyDirectory(directory);
    }
    const existing = readHistory(stateRoot, mutation.idempotencyKey, basis);
    const mutationDigest = digestMutation(mutation);
    const priorMutation = existing.find((record) => record.mutationKey === mutation.mutationKey);
    if (priorMutation) {
      if (priorMutation.mutationDigest !== mutationDigest) throw agentWorkflowConflict("agent_design_mutation_key_conflict");
      return publicSnapshot(existing, basis, null, { replayed: true, replayVersion: priorMutation.version });
    }

    const lockPath = path.join(stateRoot, `${mutation.idempotencyKey}.design-lock`);
    try { mkdirSync(lockPath, { mode: 0o700 }); }
    catch (error) {
      if (error.code === "EEXIST") throw agentWorkflowConflict("agent_design_busy_or_in_doubt");
      throw error;
    }
    try {
      const versions = readHistory(stateRoot, mutation.idempotencyKey, basis);
      const repeated = versions.find((record) => record.mutationKey === mutation.mutationKey);
      if (repeated) {
        if (repeated.mutationDigest !== mutationDigest) throw agentWorkflowConflict("agent_design_mutation_key_conflict");
        return publicSnapshot(versions, basis, null, { replayed: true, replayVersion: repeated.version });
      }
      const previous = versions.at(-1) ?? null;
      const currentVersion = previous?.version ?? 0;
      if (currentVersion !== mutation.expectedVersion) throw agentWorkflowConflict("agent_design_version_conflict");
      if (currentVersion >= AGENT_DESIGN_MAX_VERSIONS) throw agentWorkflowConflict("agent_design_version_limit");
      const now = new Date().toISOString();
      const nextVersion = currentVersion + 1;
      const transformed = applyDesignMutation(previous?.content ?? null, mutation, nextVersion, now);
      const record = {
        schemaVersion: AGENT_DESIGN_RECORD_SCHEMA,
        basis,
        version: nextVersion,
        previousDigest: previous?.recordDigest ?? null,
        action: mutation.action,
        mutationKey: mutation.mutationKey,
        mutationDigest,
        sourceDraftDigest: mutation.action === "submit" ? mutation.sourceDraftDigest ?? null
          : previous?.sourceDraftDigest ?? null,
        changedNodeIds: transformed.changedNodeIds,
        invalidatedModuleIds: transformed.invalidatedModuleIds,
        ...(transformed.reviewNote && { reviewNote: transformed.reviewNote }),
        ...(transformed.resolvedReviewNoteIds?.length && { resolvedReviewNoteIds: transformed.resolvedReviewNoteIds }),
        recordedAt: now,
        status: transformed.status,
        artifactDigest: designArtifactDigest(basis, transformed.content),
        content: transformed.content,
      };
      record.recordDigest = designVersionDigest(record);
      writeImmutableVersion(directory, record);
      return publicSnapshot([...versions, record], basis);
    } finally {
      rmdirSync(lockPath);
    }
  }

  return Object.freeze({ inspect, commit });
}
