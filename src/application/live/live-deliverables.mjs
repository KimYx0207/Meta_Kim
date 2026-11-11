import { createHash } from "node:crypto";
import path from "node:path";
import { LIVE_MAX_JSON_BYTES, normalizeLiveRunId } from "../../domain/live/live-read-contract.mjs";
import { readBoundedDeliverable } from "../../data/repositories/live-deliverable-repository.mjs";
import deliverablePolicy from "../../../config/live-deliverables.json" with { type: "json" };

const KINDS = new Map(Object.entries(deliverablePolicy.textFormats));
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

function outputReference(value) {
  const raw = typeof value === "string" ? value : value?.path ?? value?.url ?? value?.href;
  return localReference(raw) ?? externalReference(raw);
}

function previewText(bytes) {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  return new TextDecoder(encoding).decode(bytes);
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
    const ref = outputReference(value);
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
  const primary = artifact.primaryDeliverable ?? artifact.summaryPacket?.primaryDeliverable ?? artifact.dispatchBoard?.primaryDeliverable;
  const primaryRef = outputReference(primary);
  if (primaryRef) {
    const producer = actual.find(result =>
      (primary?.taskPacketId == null || primary.taskPacketId === result.taskPacketId) &&
      [...list(result.producedArtifacts), result.deliverableLink].some(value => {
        const ref = outputReference(value);
        return ref?.kind === primaryRef.kind && ref.reference === primaryRef.reference;
      }));
    if (producer) add(primary, producer.taskPacketId);
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
export function publicLiveDeliverable(value, taskBinding = (taskId) => taskId, { contentObserved = false } = {}) {
  if (!value || !/^deliverable:[a-f0-9]{24}$/u.test(value.id) || !normalizeLiveRunId(value.runId) ||
    !["text", "markdown", "html", "external"].includes(value.kind)) return null;
  return { id: value.id, runId: value.runId, taskPacketId: value.taskPacketId ? taskBinding(value.taskPacketId) : null,
    label: safeLabel(value.label, "Deliverable"), kind: value.kind,
    availability: value.availability === "available" ? "available" : "declared",
    // A stored descriptor's claimed hash is not a read receipt.
    contentVersion: contentObserved && typeof value.text === "string" && value.kind !== "external" ? `sha256:${sha(value.text)}` : null };
}

/** Read through an exact declared id with bounded bytes and no symlink traversal. */
export async function readLiveDeliverable(artifact, deliverableId, projectRoot) {
  const item = collectLiveDeliverables(artifact).find((candidate) => candidate.id === deliverableId);
  if (!item) return null;
  if (item.kind === "external") return { kind: item.kind, label: item.label, url: item.reference };
  if (item.text !== undefined) return Buffer.byteLength(item.text, "utf8") <= LIVE_MAX_JSON_BYTES
    ? { kind: "text", label: item.label, filename: "result.txt", bytes: Buffer.from(item.text), text: item.text, contentVersion: `sha256:${sha(item.text)}` } : null;
  if (!projectRoot) return null;
  const bytes = await readBoundedDeliverable(projectRoot, item.reference);
  return bytes === null ? null : { kind: item.kind, label: item.label, filename: path.posix.basename(item.reference),
    bytes, text: previewText(bytes), contentVersion: `sha256:${sha(bytes)}` };
}
