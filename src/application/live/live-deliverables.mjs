import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { LIVE_MAX_JSON_BYTES, isPathInside, normalizeLiveRunId } from "../../infrastructure/live/live-read-repository.mjs";

const KINDS = new Map([[".txt", "text"], [".md", "markdown"], [".html", "html"], [".htm", "html"]]);
const PRIVATE_SEGMENTS = /^(?:\.env(?:\..*)?|\.git|node_modules|canonical|config|src|scripts|secrets?)$/iu;
const SECRET = /(?:api[_-]?key|access[_-]?token|password|secret|authorization|cookie)\s*[:=]|\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/iu;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const list = (value) => Array.isArray(value) ? value : [];

function safeLabel(value, fallback) {
  return typeof value === "string" && value.trim() && !SECRET.test(value) && !/[\\/\u0000-\u001f]/u.test(value)
    ? value.trim().slice(0, 96) : fallback;
}

function localReference(value) {
  if (typeof value !== "string" || value.length > 1024 || /[\\\u0000-\u001f?#%:]/u.test(value) || path.isAbsolute(value)) return null;
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || PRIVATE_SEGMENTS.test(segment))) return null;
  // Source/configuration files are never served. Only declared output locations
  // enter this reader, including task-local preview outputs beneath work/.
  const outputLocation = ["outputs", "artifacts"].includes(segments[0]) ||
    (segments[0] === ".meta-kim" && segments[1] === "work" && segments.slice(3, -1).includes("deliverables")) ||
    (segments[0] === ".meta-kim" && segments[1] === "state" && segments[3] === "deliverables");
  const kind = KINDS.get(path.posix.extname(value).toLowerCase());
  return outputLocation && kind && !SECRET.test(value) ? { reference: value, kind } : null;
}

function externalReference(value) {
  if (typeof value !== "string" || SECRET.test(value)) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
      ? { reference: url.href, kind: "external" } : null;
  } catch { return null; }
}

function executionObserved(result, artifact, runId) {
  if (!result || result.runId !== runId || !["executed", "completed"].includes(result.status)) return false;
  if (/structural|synthetic|planned|test_double|injected/iu.test(`${result.resultKind || ""} ${result.evidenceKind || ""}`)) return false;
  return result.resultKind === "actual_local_tool_worker_result" ||
    (result.resultKind === "native_read_only_worker_result" && artifact.executionResult?.actualWorkerExecution === true) ||
    list(result.workerExecutionEvidence).some((item) => item?.runId === runId && item?.taskPacketId === result.taskPacketId &&
      item.synthetic !== true && (item.proofValid === true || item.runtimeProcessInvoked === true || item.actualToolExecution === true));
}

/** Resolve only explicit, run-bound produced outputs; never search prose for paths. */
export function collectLiveDeliverables(artifact) {
  const runId = normalizeLiveRunId(artifact?.runId || artifact?.run?.runId);
  if (!runId) return [];
  const output = [];
  const add = (value, taskPacketId = null, fallback = "Primary deliverable") => {
    const raw = typeof value === "string" ? value : value?.path ?? value?.url ?? value?.href;
    const ref = localReference(raw) ?? externalReference(raw);
    if (!ref) return;
    const id = `deliverable:${sha(`${runId}:${taskPacketId || "primary"}:${ref.reference}`).slice(0, 24)}`;
    if (output.some((item) => item.id === id)) return;
    const referenceLabel = safeLabel(path.posix.basename(ref.reference), fallback);
    output.push({ id, runId, taskPacketId, label: safeLabel(value?.label ?? value?.title, referenceLabel),
      kind: ref.kind, availability: "declared", ...ref });
  };
  const results = list(artifact.workerResultPackets).length ? artifact.workerResultPackets : artifact.executionResult?.workerResultPackets;
  const tasks = new Map(list(artifact.workerTaskPackets ?? artifact.coreLoop?.thinkingPacket?.workerTaskPackets)
    .filter((packet) => typeof packet?.taskPacketId === "string").map((packet) => [packet.taskPacketId, packet]));
  const actual = list(results).filter((result) => {
    const packet = tasks.get(result?.taskPacketId);
    const owner = packet?.ownerAgent ?? packet?.owner;
    return typeof owner === "string" && owner.trim() && owner === (result?.ownerAgent ?? result?.owner) &&
      executionObserved(result, artifact, runId);
  });
  if (actual.length) {
    add(artifact.primaryDeliverable ?? artifact.summaryPacket?.primaryDeliverable ?? artifact.dispatchBoard?.primaryDeliverable);
  }
  for (const result of actual) {
    const taskPacketId = result.taskPacketId;
    if (typeof taskPacketId !== "string" || !taskPacketId.trim()) continue;
    for (const value of list(result.producedArtifacts)) add(value, taskPacketId, "Produced deliverable");
    add(result.deliverableLink, taskPacketId, "Worker deliverable");
    if (typeof result.output?.text === "string" && result.output.text.trim() && !SECRET.test(result.output.text)) {
      const text = result.output.text;
      output.push({ id: `deliverable:${sha(`${runId}:${taskPacketId}:${sha(text)}`).slice(0, 24)}`,
        runId, taskPacketId, label: "执行结果", kind: "text", availability: "available", text });
    }
  }
  return output.slice(0, 128);
}

/** Public metadata excludes local paths and output text, including compact-file inputs. */
export function publicLiveDeliverable(value, taskBinding = (taskId) => taskId) {
  if (!value || !/^deliverable:[a-f0-9]{24}$/u.test(value.id) || !normalizeLiveRunId(value.runId) ||
    !["text", "markdown", "html", "external"].includes(value.kind)) return null;
  return { id: value.id, runId: value.runId, taskPacketId: value.taskPacketId ? taskBinding(value.taskPacketId) : null,
    label: safeLabel(value.label, "Deliverable"), kind: value.kind,
    availability: value.availability === "available" ? "available" : "declared" };
}

/** Read through an exact declared id with bounded bytes and no symlink traversal. */
export async function readLiveDeliverable(artifact, deliverableId, projectRoot) {
  const item = collectLiveDeliverables(artifact).find((candidate) => candidate.id === deliverableId);
  if (!item) return null;
  if (item.kind === "external") return { kind: item.kind, label: item.label, url: item.reference };
  if (item.text !== undefined) return Buffer.byteLength(item.text, "utf8") <= LIVE_MAX_JSON_BYTES
    ? { kind: "text", label: item.label, text: item.text } : null;
  if (!projectRoot) return null;
  try {
    const root = path.resolve(projectRoot);
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    const target = path.resolve(root, item.reference);
    if (!isPathInside(root, target) || target === root) return null;
    let current = root;
    const parts = path.relative(root, target).split(path.sep);
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) return null;
    }
    const canonicalRoot = await realpath(root);
    const canonicalTarget = await realpath(target);
    if (!isPathInside(canonicalRoot, canonicalTarget)) return null;
    const handle = await open(target, "r");
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > LIVE_MAX_JSON_BYTES || before.nlink !== 1) return null;
      const bytes = Buffer.alloc(before.size + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const after = await handle.stat();
      const named = await lstat(target);
      if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        named.isSymbolicLink() || named.ino !== before.ino || named.dev !== before.dev ||
        await realpath(target) !== canonicalTarget) return null;
      return { kind: item.kind, label: item.label, text: bytes.subarray(0, bytesRead).toString("utf8") };
    } finally { await handle.close(); }
  } catch { return null; }
}
