/**
 * JSON persistence adapter for the knowledge lifecycle registry.
 *
 * The domain owns lifecycle legality. This adapter owns bounded file identity,
 * serialized compare-and-swap, atomic replacement, integrity readback, and
 * rollback after an interrupted write. It intentionally exposes no delete API.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  validateKnowledgeLifecycleRegistry,
} from "../../domain/evolution/knowledge-lifecycle.mjs";
import { canonicalDigest } from "../../domain/shared/canonical-digest.mjs";

export const JSON_KNOWLEDGE_LIFECYCLE_REGISTRY_REPOSITORY_SCHEMA_VERSION =
  "json-knowledge-lifecycle-registry-repository-v1";

const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;

function fail(message, code = "KNOWLEDGE_LIFECYCLE_REPOSITORY_INVALID") {
  const error = new Error(`Knowledge lifecycle registry repository: ${message}`);
  error.code = code;
  throw error;
}

function inside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function samePath(left, right) {
  const normalize = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  return normalize(path.resolve(left)) === normalize(path.resolve(right));
}

function assertPlainRoot(allowedRoot) {
  if (typeof allowedRoot !== "string" || !path.isAbsolute(allowedRoot)) {
    fail("allowedRoot must be an explicit absolute path");
  }
  const requested = path.resolve(allowedRoot);
  if (!existsSync(requested)) fail("allowedRoot does not exist");
  const stats = lstatSync(requested);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    fail("allowedRoot must be an ordinary non-link directory");
  }
  const real = realpathSync.native(requested);
  if (!samePath(requested, real)) fail("allowedRoot must not traverse a link or alias");
  return real;
}

function assertSafeParent(parent, root) {
  const requested = path.resolve(parent);
  if (!inside(requested, root)) fail("registry parent escapes allowedRoot");
  let current = root;
  for (const segment of path.relative(root, requested).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stats = lstatSync(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      fail("registry parent must contain ordinary non-link directories only");
    }
    const real = realpathSync.native(current);
    if (!inside(real, root) || !samePath(real, current)) {
      fail("registry parent resolves outside allowedRoot or through an alias");
    }
  }
  return requested;
}

function assertSafeRegistryPath(registryPath, root) {
  if (typeof registryPath !== "string" || !path.isAbsolute(registryPath)) {
    fail("registryPath must be an explicit absolute path");
  }
  const requested = path.resolve(registryPath);
  if (!inside(requested, root)) fail("registryPath escapes allowedRoot");
  assertSafeParent(path.dirname(requested), root);
  if (!existsSync(requested)) fail("registryPath does not exist");
  const stats = lstatSync(requested);
  if (!stats.isFile() || stats.isSymbolicLink()) fail("registryPath must be a regular non-link file");
  if (stats.size > MAX_REGISTRY_BYTES) fail("registry exceeds the bounded size limit");
  const real = realpathSync.native(requested);
  if (!inside(real, root) || !samePath(real, requested)) {
    fail("registryPath resolves outside allowedRoot or through an alias");
  }
  return { requested, stats };
}

function readBoundText(registryPath, root) {
  const binding = assertSafeRegistryPath(registryPath, root);
  const handle = openSync(binding.requested, "r");
  try {
    const before = fstatSync(handle);
    if (!before.isFile() || before.size > MAX_REGISTRY_BYTES) fail("registry changed before read");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(handle, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(handle);
    const rebound = assertSafeRegistryPath(registryPath, root);
    if (
      offset !== bytes.length ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      after.dev !== rebound.stats.dev ||
      after.ino !== rebound.stats.ino
    ) {
      fail("registry changed while read", "KNOWLEDGE_LIFECYCLE_REPOSITORY_RACE");
    }
    return bytes.toString("utf8");
  } finally {
    closeSync(handle);
  }
}

function parseRegistry(registryPath, root) {
  try {
    return validateKnowledgeLifecycleRegistry(JSON.parse(readBoundText(registryPath, root)));
  } catch (error) {
    if (error?.code?.startsWith("KNOWLEDGE_LIFECYCLE")) throw error;
    fail("registry is not valid bounded JSON");
  }
}

function fsyncParentBestEffort(filePath) {
  if (process.platform === "win32") return false;
  let handle;
  try {
    handle = openSync(path.dirname(filePath), "r");
    fsyncSync(handle);
    return true;
  } catch {
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
}

function acquireLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = openSync(lockPath, "wx", 0o600);
      writeFileSync(handle, `${process.pid}:${randomUUID()}\n`, "utf8");
      fsyncSync(handle);
      return handle;
    } catch (error) {
      if (handle !== undefined) closeSync(handle);
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const raw = readBoundText(lockPath, path.dirname(lockPath)).trim();
        const pid = Number(raw.split(":", 1)[0]);
        if (!Number.isSafeInteger(pid) || pid <= 0) {
          fail("registry writer lock identity is invalid", "KNOWLEDGE_LIFECYCLE_REPOSITORY_BUSY");
        }
        try {
          process.kill(pid, 0);
        } catch (probeError) {
          if (probeError?.code === "ESRCH") stale = true;
        }
      } catch (inspectionError) {
        if (inspectionError?.code?.startsWith("KNOWLEDGE_LIFECYCLE")) throw inspectionError;
      }
      if (stale && attempt === 0) {
        unlinkSync(lockPath);
        continue;
      }
      fail("registry writer lock is already held", "KNOWLEDGE_LIFECYCLE_REPOSITORY_BUSY");
    }
  }
  fail("registry writer lock is already held", "KNOWLEDGE_LIFECYCLE_REPOSITORY_BUSY");
}

function releaseLock(lockPath, handle) {
  closeSync(handle);
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function atomicReplace({ registryPath, root, previousText, nextRegistry, onWriteStep }) {
  const directory = path.dirname(registryPath);
  const token = `${process.pid}.${randomUUID()}`;
  const temporary = path.join(directory, `.${path.basename(registryPath)}.${token}.tmp`);
  const rollback = path.join(directory, `.${path.basename(registryPath)}.${token}.rollback.tmp`);
  let renamed = false;
  try {
    const nextText = jsonText(nextRegistry);
    if (Buffer.byteLength(nextText) > MAX_REGISTRY_BYTES) fail("next registry exceeds size limit");
    writeExclusive(temporary, nextText);
    onWriteStep?.("temporary_written");
    assertSafeRegistryPath(registryPath, root);
    onWriteStep?.("before_rename");
    renameSync(temporary, registryPath);
    renamed = true;
    fsyncParentBestEffort(registryPath);
    onWriteStep?.("after_rename");
    const persisted = parseRegistry(registryPath, root);
    if (canonicalDigest(persisted) !== canonicalDigest(nextRegistry)) {
      fail("post-write registry integrity check failed");
    }
    return persisted;
  } catch (error) {
    if (renamed) {
      try {
        writeExclusive(rollback, previousText);
        renameSync(rollback, registryPath);
        fsyncParentBestEffort(registryPath);
      } catch (rollbackError) {
        fail(`write failed and rollback could not restore the prior registry: ${rollbackError.message}`);
      }
    }
    throw error;
  } finally {
    for (const residue of [temporary, rollback]) {
      try {
        if (existsSync(residue)) unlinkSync(residue);
      } catch {
        // Residue is preserved for diagnosis when cleanup itself is unsafe.
      }
    }
  }
}

export function createJsonKnowledgeLifecycleRegistryRepository({
  registryPath,
  allowedRoot,
} = {}) {
  const root = assertPlainRoot(allowedRoot);
  const registry = assertSafeRegistryPath(registryPath, root).requested;
  const lockPath = `${registry}.lock`;

  function read() {
    const value = parseRegistry(registry, root);
    return Object.freeze({
      registry: value,
      revision: value.revision,
      digest: canonicalDigest(value),
    });
  }

  function readSourceDigest(targetRef) {
    if (
      typeof targetRef !== "string" ||
      !targetRef ||
      path.isAbsolute(targetRef) ||
      targetRef.includes("\\")
    ) {
      fail("targetRef must be a repo-relative forward-slash path");
    }
    const targetPath = path.resolve(root, ...targetRef.split("/"));
    if (!inside(targetPath, root)) fail("targetRef escapes allowedRoot");
    const content = readBoundText(targetPath, root);
    return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
  }

  function compareAndSwap({
    expectedRevision,
    expectedRegistryDigest,
    transitionId,
    candidateDigest,
    nextRegistry,
    onWriteStep,
  } = {}) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      fail("expectedRevision must be a non-negative safe integer");
    }
    if (typeof expectedRegistryDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(expectedRegistryDigest)) {
      fail("expectedRegistryDigest must be a strict sha256 reference");
    }
    if (typeof transitionId !== "string" || !transitionId) fail("transitionId is required");
    if (typeof candidateDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(candidateDigest)) {
      fail("candidateDigest must be a strict sha256 reference");
    }
    const proposed = validateKnowledgeLifecycleRegistry(nextRegistry);
    const lock = acquireLock(lockPath);
    try {
      const previousText = readBoundText(registry, root);
      const current = validateKnowledgeLifecycleRegistry(JSON.parse(previousText));
      const applied = current.appliedTransitions[transitionId];
      if (applied) {
        if (applied.candidateDigest !== candidateDigest) {
          fail("transitionId is already bound to a different candidate", "KNOWLEDGE_LIFECYCLE_IDEMPOTENCY_CONFLICT");
        }
        return Object.freeze({
          registry: current,
          revision: current.revision,
          digest: canonicalDigest(current),
          applied: false,
          idempotent: true,
        });
      }
      if (current.revision !== expectedRevision || canonicalDigest(current) !== expectedRegistryDigest) {
        fail("compare-and-swap precondition failed", "KNOWLEDGE_LIFECYCLE_CAS_MISMATCH");
      }
      if (proposed.revision !== current.revision + 1) {
        fail("next registry must advance exactly one revision");
      }
      if (proposed.appliedTransitions[transitionId]?.candidateDigest !== candidateDigest) {
        fail("next registry does not contain the exact transition/candidate binding");
      }
      const persisted = atomicReplace({
        registryPath: registry,
        root,
        previousText,
        nextRegistry: proposed,
        onWriteStep,
      });
      return Object.freeze({
        registry: persisted,
        revision: persisted.revision,
        digest: canonicalDigest(persisted),
        applied: true,
        idempotent: false,
      });
    } finally {
      releaseLock(lockPath, lock);
    }
  }

  return Object.freeze({
    schemaVersion: JSON_KNOWLEDGE_LIFECYCLE_REGISTRY_REPOSITORY_SCHEMA_VERSION,
    read,
    readSourceDigest,
    compareAndSwap,
  });
}
