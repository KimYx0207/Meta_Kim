import { canonicalDigest, canonicalize } from "../shared/canonical-digest.mjs";

/**
 * Public, read-only export contracts for Meta_Kim Live.
 *
 * This module deliberately has no filesystem, network, runtime, HTML, or
 * Markdown dependency. It accepts an already-produced M3-L01 snapshot and
 * creates a small allowlisted projection that can be copied outside the
 * project without carrying the source packet with it.
 */
export const LIVE_SHARE_ARTIFACT_SCHEMA_VERSION = "meta-kim-live-share-v1";
export const LIVE_PUBLIC_REPLAY_SCHEMA_VERSION = "meta-kim-live-public-replay-v1";
export const LIVE_SHARE_ARTIFACT_KIND = "live_share_artifact";

export const LIVE_SHARE_MAX_INPUT_BYTES = 512 * 1024;
export const LIVE_SHARE_MAX_OUTPUT_BYTES = 256 * 1024;
export const LIVE_SHARE_MAX_DEPTH = 32;
export const LIVE_SHARE_MAX_VALUES = 20_000;
export const LIVE_SHARE_MAX_STRING = 8_192;
export const LIVE_SHARE_MAX_NODES = 256;
export const LIVE_SHARE_MAX_EDGES = 512;
export const LIVE_SHARE_MAX_EVIDENCE = 512;
export const LIVE_SHARE_MAX_REPLAY = 1_024;

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const CONTROL_GLOBAL = /[\u0000-\u001f\u007f]/gu;
const ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/]|\\\\|(?:^|[\s([{"'])\/(?:[A-Za-z0-9._-]+[\\/])+[A-Za-z0-9._-]*)/u;
const SECRET = /(?:api[_-]?key|access[_-]?token|auth(?:entication)?|bearer|credential|password|passphrase|private[ _-]?key|secret|token|cookie|authorization)\s*[:=]|\b(?:gh[pousr]_|github_pat_|AKIA|ASIA)[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}|\bsk[-_][A-Za-z0-9_-]{8,}/iu;
const RAW_MATERIAL = /(?:^|[\s._:/-])(?:raw[\s_-]*)?(?:prompt|output|input|stdout|stderr|env(?:ironment)?|shell|command|trace|stack|cwd|path|file|directory|home|root)(?:$|[\s._:/=-])/iu;

const STATUS_ALIASES = new Map([
  ["running", "active"],
  ["live", "active"],
  ["in_progress", "active"],
  ["in-progress", "active"],
  ["started", "active"],
  ["success", "completed"],
  ["succeeded", "completed"],
  ["pass", "completed"],
  ["passed", "completed"],
  ["verified", "completed"],
  ["done", "completed"],
  ["failure", "failed"],
  ["error", "failed"],
  ["rejected", "failed"],
  ["queued", "pending"],
  ["unknown", "in_doubt"],
  ["stale", "in_doubt"],
  ["uncertain", "in_doubt"],
]);

const STATUSES = new Set([
  "active",
  "completed",
  "pending",
  "failed",
  "blocked",
  "cancelled",
  "session_stopped",
  "archived",
  "in_doubt",
]);

const KINDS = new Set([
  "stage",
  "transition",
  "node",
  "evidence",
  "review",
  "verification",
  "status",
  "test",
  "runtime",
  "in_doubt",
  "unknown",
]);

const SOURCE_KINDS = new Set([
  "durable_status",
  "governed_artifact",
  "local",
  "empty",
  "unknown",
]);

function fail(message) {
  throw new TypeError(`Invalid live share artifact: ${message}`);
}

function byteLength(value) {
  try {
    return new TextEncoder().encode(value).byteLength;
  } catch {
    fail("text encoding failed");
  }
}

function plainRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail(`${label} could not be safely inspected`);
  }
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`);
  if (keys.some((key) => typeof key !== "string")) fail(`${label} contains a symbol key`);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      fail(`${label}.${key} must be an enumerable data property`);
    }
  }
  return value;
}

function safeClone(value, state, label, depth = 0) {
  if (depth > LIVE_SHARE_MAX_DEPTH) fail(`${label} exceeds maximum depth`);
  state.values += 1;
  if (state.values > LIVE_SHARE_MAX_VALUES) fail("input contains too many values");

  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > LIVE_SHARE_MAX_STRING) fail(`${label} string is too large`);
    state.bytes += byteLength(value);
    if (state.bytes > LIVE_SHARE_MAX_INPUT_BYTES) fail("input is too large");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${label} number is not finite`);
    return value;
  }
  if (typeof value !== "object") fail(`${label} contains an unsupported value`);

  if (state.active.has(value)) fail(`${label} contains a circular reference`);
  state.active.add(value);
  let result;
  try {
    if (Array.isArray(value)) {
      let keys;
      try {
        keys = Reflect.ownKeys(value);
      } catch {
        fail(`${label} array could not be safely inspected`);
      }
      if (keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key)))) {
        fail(`${label} array contains unsupported properties`);
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
        fail(`${label} array length is invalid`);
      }
      result = [];
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        if (!Object.hasOwn(value, index)) fail(`${label} array must be dense`);
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) fail(`${label}[${index}] is not a data property`);
        result.push(safeClone(descriptor.value, state, `${label}[${index}]`, depth + 1));
      }
    } else {
      const input = plainRecord(value, label);
      result = Object.create(null);
      for (const key of Object.keys(input)) {
        result[key] = safeClone(input[key], state, `${label}.${key}`, depth + 1);
      }
    }
  } finally {
    state.active.delete(value);
  }
  return result;
}

function boundedInput(value) {
  const state = { active: new WeakSet(), bytes: 0, values: 0 };
  const copy = safeClone(value, state, "input");
  let serialized;
  try {
    serialized = JSON.stringify(copy);
  } catch {
    fail("input could not be serialized");
  }
  if (typeof serialized !== "string" || byteLength(serialized) > LIVE_SHARE_MAX_INPUT_BYTES) fail("input is too large");
  return copy;
}

function objectValue(value, key) {
  return value && typeof value === "object" && !Array.isArray(value) ? value[key] : undefined;
}

function firstDefined(value, keys) {
  for (const key of keys) {
    const candidate = objectValue(value, key);
    if (candidate !== undefined && candidate !== null) return candidate;
  }
  return undefined;
}

function safeText(value, fallback = "unknown", max = 240) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  let text = String(value).normalize("NFKC").replace(CONTROL_GLOBAL, " ").replace(/\s+/gu, " ").trim();
  if (!text) return fallback;
  if (SECRET.test(text) || RAW_MATERIAL.test(text)) return "redacted";
  if (ABSOLUTE_PATH.test(text) || /(?:^|\s)(?:\.\.?[\\/]|src[\\/]|tests?[\\/]|node_modules[\\/])/iu.test(text)) return "path omitted";
  text = text.replace(/[<>]/gu, "").trim();
  return text ? text.slice(0, max) : fallback;
}

function safeId(value, fallback = "unknown") {
  if (typeof value !== "string") return fallback;
  const normalized = value.normalize("NFKC").trim();
  if (!SAFE_ID.test(normalized) || SECRET.test(normalized) || RAW_MATERIAL.test(normalized) || ABSOLUTE_PATH.test(normalized)) return fallback;
  return normalized;
}

function validatePublicText(value, label, max = 240) {
  if (typeof value !== "string" || value.length > max || CONTROL.test(value) || /[<>]/u.test(value)) fail(`${label} contains unsafe display text`);
  if (SECRET.test(value) || RAW_MATERIAL.test(value) || ABSOLUTE_PATH.test(value) || /(?:^|\s)(?:\.\.?[\\/]|src[\\/]|tests?[\\/]|node_modules[\\/])/iu.test(value)) {
    fail(`${label} contains secret, path, or raw material`);
  }
  return value;
}

function validatePublicId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value) || SECRET.test(value) || RAW_MATERIAL.test(value) || ABSOLUTE_PATH.test(value)) fail(`${label} is not a safe identifier`);
  return value;
}

function requiredId(value, label) {
  const normalized = safeId(value, "");
  if (!normalized) fail(`${label} must be a safe identifier`);
  return normalized;
}

function normalizeStatus(value) {
  if (typeof value !== "string") return "in_doubt";
  const normalized = value.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, "_");
  const status = STATUS_ALIASES.get(normalized) || normalized;
  return STATUSES.has(status) ? status : "in_doubt";
}

function normalizeKind(value) {
  if (typeof value !== "string") return "unknown";
  const normalized = value.normalize("NFKC").trim().toLowerCase().replace(/[ -]+/gu, "_");
  return KINDS.has(normalized) ? normalized : "unknown";
}

function normalizeSourceKind(value) {
  if (typeof value !== "string") return "unknown";
  const normalized = value.normalize("NFKC").trim().toLowerCase().replace(/[ -]+/gu, "_");
  return SOURCE_KINDS.has(normalized) ? normalized : "unknown";
}

function timestamp(value, label, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) fail(`${label} is required`);
    return null;
  }
  if (typeof value !== "string") fail(`${label} must be an ISO timestamp`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail(`${label} is invalid`);
  return date.toISOString();
}

function readReplay(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const candidate = value.events ?? value.replay ?? value.timeline;
  if (candidate === undefined) return [];
  if (!Array.isArray(candidate)) fail("replay events must be an array");
  if (value.schemaVersion !== undefined && !["meta-kim-live-replay-v1", LIVE_PUBLIC_REPLAY_SCHEMA_VERSION].includes(value.schemaVersion)) {
    fail("replay schema is unsupported");
  }
  return candidate;
}

function permissions() {
  return {
    readOnly: true,
    projectionOnly: true,
    executionAllowed: false,
    mutationAllowed: false,
  };
}

function normalizeSource(snapshot) {
  const source = objectValue(snapshot, "source") || {};
  return {
    kind: normalizeSourceKind(source.kind),
    observedAt: timestamp(source.observedAt ?? source.generatedAt, "source.observedAt"),
    stale: source.stale === true,
  };
}

function normalizeRun(snapshot, source) {
  const input = objectValue(snapshot, "run") || snapshot;
  const runId = requiredId(firstDefined(input, ["runId", "id"]), "run.runId");
  return {
    runId,
    status: normalizeStatus(firstDefined(input, ["status", "lifecycleStatus"])),
    currentStage: safeId(firstDefined(input, ["currentStage", "currentStageKey", "stage"]), "unknown"),
    updatedAt: timestamp(firstDefined(input, ["updatedAt", "completedAt", "startedAt"]), "run.updatedAt"),
  };
}

function normalizeNodes(snapshot) {
  const input = snapshot.nodes === undefined ? [] : snapshot.nodes;
  if (!Array.isArray(input) || input.length > LIVE_SHARE_MAX_NODES) fail("nodes are missing or too large");
  const output = [];
  const ids = new Set();
  for (const [index, item] of input.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail(`nodes[${index}] is invalid`);
    const id = requiredId(firstDefined(item, ["id", "nodeId"]), `nodes[${index}].id`);
    if (ids.has(id)) fail("node ids must be unique");
    ids.add(id);
    const evidenceCount = firstDefined(item, ["evidenceCount"]);
    if (evidenceCount !== undefined && (!Number.isSafeInteger(evidenceCount) || evidenceCount < 0 || evidenceCount > 1_000_000)) fail(`nodes[${index}].evidenceCount is invalid`);
    output.push({
      id,
      label: safeText(firstDefined(item, ["label", "name"]), id),
      stage: safeId(firstDefined(item, ["stage", "currentStage", "stageKey"]), "unknown"),
      status: normalizeStatus(firstDefined(item, ["status", "state"])),
      ownerAgent: safeId(firstDefined(item, ["ownerAgent", "owner", "agent", "roleDisplayName"]), "unknown"),
      runtime: safeId(firstDefined(item, ["runtime", "runtimeFamily"]), "unknown"),
      summary: safeText(firstDefined(item, ["summary", "description"]), ""),
      evidenceCount: evidenceCount === undefined ? 0 : evidenceCount,
    });
  }
  return output;
}

function normalizeEdges(snapshot, nodeIds) {
  const input = snapshot.edges === undefined ? [] : snapshot.edges;
  if (!Array.isArray(input) || input.length > LIVE_SHARE_MAX_EDGES) fail("edges are missing or too large");
  const output = [];
  const seen = new Set();
  for (const [index, item] of input.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail(`edges[${index}] is invalid`);
    const from = requiredId(item.from, `edges[${index}].from`);
    const to = requiredId(item.to, `edges[${index}].to`);
    if (!nodeIds.has(from) || !nodeIds.has(to) || from === to) continue;
    const key = `${from}\u0000${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ from, to });
  }
  return output;
}

function normalizeEvidence(snapshot) {
  const input = snapshot.evidence === undefined ? [] : snapshot.evidence;
  if (!Array.isArray(input) || input.length > LIVE_SHARE_MAX_EVIDENCE) fail("evidence is missing or too large");
  return input.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail(`evidence[${index}] is invalid`);
    return {
      id: safeId(firstDefined(item, ["id", "evidenceId"]), `evidence:${index + 1}`),
      type: normalizeKind(firstDefined(item, ["type", "kind", "evidenceKind"])),
      label: safeText(firstDefined(item, ["label", "name"]), "unknown"),
      status: normalizeStatus(firstDefined(item, ["status", "state", "result"])),
    };
  });
}

function normalizeReplay(snapshot, replayInput, run, source, nodeIds) {
  const input = readReplay(replayInput ?? snapshot.replay);
  if (input.length > LIVE_SHARE_MAX_REPLAY) fail("replay is too large");
  const events = input.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail(`replay[${index}] is invalid`);
    const eventRunId = firstDefined(item, ["runId", "run"]);
    if (eventRunId !== undefined && eventRunId !== null && requiredId(eventRunId, `replay[${index}].runId`) !== run.runId) fail("replay crosses run boundaries");
    const sequence = item.sequence === undefined ? index + 1 : item.sequence;
    if (!Number.isSafeInteger(sequence) || sequence < 1) fail(`replay[${index}].sequence is invalid`);
    const eventAt = timestamp(firstDefined(item, ["at", "timestamp", "occurredAt", "updatedAt"]), `replay[${index}].at`, { required: true });
    const nodeId = safeId(firstDefined(item, ["nodeId", "id"]), "unknown");
    return {
      sequence,
      at: eventAt,
      kind: normalizeKind(firstDefined(item, ["kind", "type", "eventType"])),
      nodeId: nodeIds.has(nodeId) ? nodeId : "unknown",
      status: source.stale ? "in_doubt" : normalizeStatus(firstDefined(item, ["status", "state"])),
      label: safeText(firstDefined(item, ["label", "name"]), "unknown"),
    };
  });
  const seenSequences = new Set();
  for (const event of events) {
    if (seenSequences.has(event.sequence)) fail("replay sequence values must be unique");
    seenSequences.add(event.sequence);
  }
  events.sort((left, right) => left.sequence - right.sequence || left.at.localeCompare(right.at));
  return {
    schemaVersion: LIVE_PUBLIC_REPLAY_SCHEMA_VERSION,
    runId: run.runId,
    source: {
      observedAt: source.observedAt,
      stale: source.stale,
    },
    events: events.map((event, index) => ({ ...event, sequence: index + 1 })),
    permissions: permissions(),
  };
}

function outputSize(value) {
  let serialized;
  try {
    serialized = JSON.stringify(canonicalize(value));
  } catch {
    fail("artifact could not be serialized");
  }
  if (typeof serialized !== "string" || byteLength(serialized) > LIVE_SHARE_MAX_OUTPUT_BYTES) fail("artifact is too large");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function artifactPayload(value) {
  const payload = {};
  for (const key of Object.keys(value)) {
    if (key !== "contentDigest") payload[key] = value[key];
  }
  return payload;
}

/**
 * Compute the SHA-256 digest over the canonical artifact payload. The claimed
 * `contentDigest` field is always ignored, so a caller cannot make its own
 * digest authoritative.
 */
export function canonicalShareDigest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("digest input must be an object");
  const payload = artifactPayload(value);
  boundedInput(payload);
  return canonicalDigest(payload);
}

/**
 * Build a deterministic, deeply-frozen, public projection from an M3-L01
 * snapshot. Input is copied and bounded before any allowlist mapping occurs.
 */
export function buildLiveShareArtifact(input) {
  const copied = boundedInput(input);
  const envelope = copied && typeof copied === "object" && !Array.isArray(copied) ? copied : null;
  const snapshot = envelope && envelope.snapshot !== undefined ? envelope.snapshot : copied;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) fail("snapshot must be an object");
  if (snapshot.schemaVersion !== undefined && snapshot.schemaVersion !== "meta-kim-live-snapshot-v1") fail("snapshot schema is unsupported");

  const source = normalizeSource(snapshot);
  const run = normalizeRun(snapshot, source);
  const nodes = normalizeNodes(snapshot);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = normalizeEdges(snapshot, nodeIds);
  const evidence = normalizeEvidence(snapshot);
  const replayInput = envelope && envelope.replay !== undefined ? envelope.replay : undefined;
  const replay = normalizeReplay(snapshot, replayInput, run, source, nodeIds);
  if (replayInput && !Array.isArray(replayInput) && objectValue(replayInput, "runId") !== undefined && requiredId(replayInput.runId, "replay.runId") !== run.runId) fail("replay crosses run boundaries");

  const payload = {
    schemaVersion: LIVE_SHARE_ARTIFACT_SCHEMA_VERSION,
    kind: LIVE_SHARE_ARTIFACT_KIND,
    source,
    run,
    nodes,
    edges,
    evidence,
    replay,
    permissions: permissions(),
  };
  outputSize(payload);
  const artifact = { ...payload, contentDigest: canonicalShareDigest(payload) };
  outputSize(artifact);
  return deepFreeze(artifact);
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value).sort().join("|");
  const expected = [...keys].sort().join("|");
  if (actual !== expected) fail(`${label} contains unexpected fields`);
}

function validateArtifactShape(artifact) {
  plainRecord(artifact, "artifact");
  exactKeys(artifact, ["schemaVersion", "kind", "source", "run", "nodes", "edges", "evidence", "replay", "permissions", "contentDigest"], "artifact");
  if (artifact.schemaVersion !== LIVE_SHARE_ARTIFACT_SCHEMA_VERSION || artifact.kind !== LIVE_SHARE_ARTIFACT_KIND) fail("artifact identity is invalid");
  if (typeof artifact.contentDigest !== "string" || !SHA256.test(artifact.contentDigest)) fail("contentDigest is invalid");
  plainRecord(artifact.source, "artifact.source");
  exactKeys(artifact.source, ["kind", "observedAt", "stale"], "artifact.source");
  if (!SOURCE_KINDS.has(artifact.source.kind) || (artifact.source.observedAt !== null && timestamp(artifact.source.observedAt, "artifact.source.observedAt") === null) || typeof artifact.source.stale !== "boolean") fail("artifact.source is invalid");
  plainRecord(artifact.run, "artifact.run");
  exactKeys(artifact.run, ["runId", "status", "currentStage", "updatedAt"], "artifact.run");
  validatePublicId(artifact.run.runId, "artifact.run.runId");
  if (!STATUSES.has(artifact.run.status) || !SAFE_ID.test(artifact.run.currentStage) || (artifact.run.updatedAt !== null && timestamp(artifact.run.updatedAt, "artifact.run.updatedAt") === null)) fail("artifact.run is invalid");
  validatePublicId(artifact.run.currentStage, "artifact.run.currentStage");
  if (!Array.isArray(artifact.nodes) || artifact.nodes.length > LIVE_SHARE_MAX_NODES) fail("artifact.nodes is invalid");
  const nodeIds = new Set();
  for (const [index, node] of artifact.nodes.entries()) {
    plainRecord(node, `artifact.nodes[${index}]`);
    exactKeys(node, ["id", "label", "stage", "status", "ownerAgent", "runtime", "summary", "evidenceCount"], `artifact.nodes[${index}]`);
    const id = validatePublicId(node.id, `artifact.nodes[${index}].id`);
    if (nodeIds.has(id)) fail("artifact node ids are not unique");
    nodeIds.add(id);
    if (typeof node.stage !== "string" || !STATUSES.has(node.status) || !Number.isSafeInteger(node.evidenceCount) || node.evidenceCount < 0) fail(`artifact.nodes[${index}] is invalid`);
    validatePublicText(node.label, `artifact.nodes[${index}].label`);
    validatePublicId(node.stage, `artifact.nodes[${index}].stage`);
    validatePublicId(node.ownerAgent, `artifact.nodes[${index}].ownerAgent`);
    validatePublicId(node.runtime, `artifact.nodes[${index}].runtime`);
    validatePublicText(node.summary, `artifact.nodes[${index}].summary`);
  }
  if (!Array.isArray(artifact.edges) || artifact.edges.length > LIVE_SHARE_MAX_EDGES) fail("artifact.edges is invalid");
  for (const [index, edge] of artifact.edges.entries()) {
    plainRecord(edge, `artifact.edges[${index}]`);
    exactKeys(edge, ["from", "to"], `artifact.edges[${index}]`);
    validatePublicId(edge.from, `artifact.edges[${index}].from`);
    validatePublicId(edge.to, `artifact.edges[${index}].to`);
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.from === edge.to) fail(`artifact.edges[${index}] is invalid`);
  }
  if (!Array.isArray(artifact.evidence) || artifact.evidence.length > LIVE_SHARE_MAX_EVIDENCE) fail("artifact.evidence is invalid");
  for (const [index, item] of artifact.evidence.entries()) {
    plainRecord(item, `artifact.evidence[${index}]`);
    exactKeys(item, ["id", "type", "label", "status"], `artifact.evidence[${index}]`);
    if (!KINDS.has(item.type) || !STATUSES.has(item.status)) fail(`artifact.evidence[${index}] is invalid`);
    validatePublicId(item.id, `artifact.evidence[${index}].id`);
    validatePublicText(item.label, `artifact.evidence[${index}].label`);
  }
  plainRecord(artifact.replay, "artifact.replay");
  exactKeys(artifact.replay, ["schemaVersion", "runId", "source", "events", "permissions"], "artifact.replay");
  if (artifact.replay.schemaVersion !== LIVE_PUBLIC_REPLAY_SCHEMA_VERSION || artifact.replay.runId !== artifact.run.runId) fail("artifact.replay binding is invalid");
  validatePublicId(artifact.replay.runId, "artifact.replay.runId");
  plainRecord(artifact.replay.source, "artifact.replay.source");
  exactKeys(artifact.replay.source, ["observedAt", "stale"], "artifact.replay.source");
  if ((artifact.replay.source.observedAt !== null && timestamp(artifact.replay.source.observedAt, "artifact.replay.source.observedAt") === null) || typeof artifact.replay.source.stale !== "boolean") fail("artifact.replay.source is invalid");
  if (!Array.isArray(artifact.replay.events) || artifact.replay.events.length > LIVE_SHARE_MAX_REPLAY) fail("artifact.replay.events is invalid");
  const sequences = new Set();
  for (const [index, event] of artifact.replay.events.entries()) {
    plainRecord(event, `artifact.replay.events[${index}]`);
    exactKeys(event, ["sequence", "at", "kind", "nodeId", "status", "label"], `artifact.replay.events[${index}]`);
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || sequences.has(event.sequence) || timestamp(event.at, `artifact.replay.events[${index}].at`, { required: true }) === null || !KINDS.has(event.kind) || typeof event.nodeId !== "string" || !STATUSES.has(event.status)) fail(`artifact.replay.events[${index}] is invalid`);
    validatePublicId(event.nodeId, `artifact.replay.events[${index}].nodeId`);
    validatePublicText(event.label, `artifact.replay.events[${index}].label`);
    sequences.add(event.sequence);
    if (event.nodeId !== "unknown" && !nodeIds.has(event.nodeId)) fail(`artifact.replay.events[${index}] references an unknown node`);
  }
  for (const [label, permissionsValue] of [["artifact.permissions", artifact.permissions], ["artifact.replay.permissions", artifact.replay.permissions]]) {
    plainRecord(permissionsValue, label);
    exactKeys(permissionsValue, ["readOnly", "projectionOnly", "executionAllowed", "mutationAllowed"], label);
    if (permissionsValue.readOnly !== true || permissionsValue.projectionOnly !== true || permissionsValue.executionAllowed !== false || permissionsValue.mutationAllowed !== false) fail(`${label} is not read-only`);
  }
  return artifact;
}

/** Validate shape and canonical content binding without trusting the claim. */
export function assertValidLiveShareArtifact(artifact) {
  validateArtifactShape(artifact);
  if (canonicalShareDigest(artifact) !== artifact.contentDigest) fail("contentDigest does not match canonical content");
  return artifact;
}

/** Return a bounded verification result instead of throwing on untrusted data. */
export function verifyLiveShareArtifact(artifact) {
  try {
    const declaredDigest = artifact && typeof artifact === "object" && typeof artifact.contentDigest === "string" ? artifact.contentDigest : null;
    const computedDigest = artifact && typeof artifact === "object" && !Array.isArray(artifact)
      ? canonicalShareDigest(artifact)
      : null;
    validateArtifactShape(artifact);
    const valid = computedDigest !== null && declaredDigest === computedDigest;
    return Object.freeze({ valid, declaredDigest, computedDigest, reason: valid ? null : "content_digest_mismatch" });
  } catch {
    return Object.freeze({ valid: false, declaredDigest: null, computedDigest: null, reason: "invalid_artifact" });
  }
}

export function isLiveShareArtifactValid(artifact) {
  return verifyLiveShareArtifact(artifact).valid;
}

export const createLiveShareArtifact = buildLiveShareArtifact;

// Compatibility names for callers that use the shorter Live contract terms.
export const LIVE_SHARE_SCHEMA_VERSION = LIVE_SHARE_ARTIFACT_SCHEMA_VERSION;
export const PUBLIC_REPLAY_SCHEMA_VERSION = LIVE_PUBLIC_REPLAY_SCHEMA_VERSION;
export const buildLiveShareExport = buildLiveShareArtifact;
export const validateLiveShareArtifact = assertValidLiveShareArtifact;
export function canonicalizeLiveShareArtifact(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("canonicalization input must be an object");
  const payload = artifactPayload(value);
  boundedInput(payload);
  return canonicalize(payload);
}
export const sha256ShareDigest = canonicalShareDigest;
