/**
 * Capacity-wave scheduling projection for the Meta_Kim Live control room.
 *
 * A governed run artifact records the scheduling decision it actually made:
 * how many workers were requested, what the host capacity allowed, and which
 * task packets were grouped into which wave. The compact live projection used
 * to drop all of it, so the control room could either show nothing or guess a
 * wave order from the worker count. Guessing is forbidden — an inferred order
 * looks identical to a recorded one on screen.
 *
 * This module carries the recorded decision across the projection boundary
 * without carrying the things that must not cross it:
 *
 *   - Task packet identifiers are never emitted. They embed the raw task title,
 *     which is private prompt content. Wave membership is emitted as already
 *     public node identifiers, resolved through an injected resolver, and a
 *     packet that resolves to no node is counted rather than named.
 *   - The capacity source path (for example an active runtime config file) is
 *     never emitted. Only its kind crosses, so the operator learns why the
 *     capacity was what it was without learning where the file lives.
 *
 * Two things are deliberately NOT configurable. `provenance` is pinned to
 * `planned` in code, and `sanitizeLiveSchedulingProjection` re-pins it when it
 * reads a stored projection back. A wave list describes intended order; no
 * artifact field proves the waves ran in that order. Making the label
 * configurable, or trusting the one in a stored file, would let a wave chart be
 * relabelled as observed execution without any evidence behind it. Limits,
 * vocabularies, and the display threshold are product data and do live in
 * `config/live/scheduling.json`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LIVE_SCHEDULING_SCHEMA_VERSION = "meta-kim-live-scheduling-v1";

/** Wave order is declared, never observed. Not overridable by config or by a stored file. */
export const LIVE_SCHEDULING_PROVENANCE = "planned";

export const LIVE_SCHEDULING_SOURCE = "agent_teams_playbook";

export const LIVE_SCHEDULING_CONFIG_URL = new URL(
  "../../../config/live/scheduling.json",
  import.meta.url,
);

const WAVE_MODE_FALLBACK = "unspecified_wave";
const CAPACITY_SOURCE_KIND_FALLBACK = "unspecified";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;

function fail(message, code = "LIVE_SCHEDULING_CONFIG_INVALID") {
  const error = new TypeError(`Live scheduling: ${message}`);
  error.code = code;
  throw error;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) fail(`${label} must be a positive integer`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value === "") fail(`${label} must be a non-empty string`);
  return value;
}

function vocabulary(value, label) {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a non-empty array`);
  const entries = value.map((entry, index) => requiredString(entry, `${label}[${index}]`));
  if (new Set(entries).size !== entries.length) fail(`${label} must not repeat an entry`);
  return Object.freeze(entries);
}

function normalizeLimits(raw) {
  if (!raw || typeof raw !== "object") fail("limits must be an object");
  return Object.freeze({
    maxWaves: positiveInteger(raw.maxWaves, "limits.maxWaves"),
    maxNodeIdsPerWave: positiveInteger(raw.maxNodeIdsPerWave, "limits.maxNodeIdsPerWave"),
    maxParallelAgents: positiveInteger(raw.maxParallelAgents, "limits.maxParallelAgents"),
    maxRequestedParallelAgents: positiveInteger(
      raw.maxRequestedParallelAgents,
      "limits.maxRequestedParallelAgents",
    ),
  });
}

function normalizeDisplay(raw) {
  if (!raw || typeof raw !== "object") fail("display must be an object");
  if (typeof raw.showCapacityWithoutWaves !== "boolean") {
    fail("display.showCapacityWithoutWaves must be a boolean");
  }
  return Object.freeze({
    minWavesToAnnotate: positiveInteger(raw.minWavesToAnnotate, "display.minWavesToAnnotate"),
    showCapacityWithoutWaves: raw.showCapacityWithoutWaves,
  });
}

/** Validate and freeze a raw scheduling-policy document. */
export function normalizeLiveSchedulingConfig(raw) {
  if (!raw || typeof raw !== "object") fail("document must be an object");
  if (raw.schemaVersion !== LIVE_SCHEDULING_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${LIVE_SCHEDULING_SCHEMA_VERSION}`, "LIVE_SCHEDULING_SCHEMA_MISMATCH");
  }
  const waveModes = vocabulary(raw.waveModes, "waveModes");
  const capacitySourceKinds = vocabulary(raw.capacitySourceKinds, "capacitySourceKinds");
  if (waveModes.includes(WAVE_MODE_FALLBACK)) {
    fail(`waveModes must not declare the reserved fallback ${WAVE_MODE_FALLBACK}`);
  }
  if (capacitySourceKinds.includes(CAPACITY_SOURCE_KIND_FALLBACK)) {
    fail(`capacitySourceKinds must not declare the reserved fallback ${CAPACITY_SOURCE_KIND_FALLBACK}`);
  }
  return Object.freeze({
    schemaVersion: raw.schemaVersion,
    limits: normalizeLimits(raw.limits),
    waveModes,
    capacitySourceKinds,
    display: normalizeDisplay(raw.display),
  });
}

let cachedConfig = null;

/**
 * Read and validate the shipped scheduling-policy document.
 *
 * The result is cached because projection building runs on the synchronous
 * governed-run commit path and must not re-read the file per run.
 */
export function loadLiveSchedulingConfig(configUrl = LIVE_SCHEDULING_CONFIG_URL) {
  if (configUrl === LIVE_SCHEDULING_CONFIG_URL && cachedConfig) return cachedConfig;
  const filePath = fileURLToPath(configUrl);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`cannot read ${filePath}: ${error.message}`, "LIVE_SCHEDULING_CONFIG_UNREADABLE");
  }
  const config = normalizeLiveSchedulingConfig(parsed);
  if (configUrl === LIVE_SCHEDULING_CONFIG_URL) cachedConfig = config;
  return config;
}

function safeSchedulingId(value) {
  return typeof value === "string" && ID_PATTERN.test(value.trim()) ? value.trim() : null;
}

function safeOwner(value) {
  return typeof value === "string" && OWNER_PATTERN.test(value.trim()) ? value.trim() : null;
}

function boundedCount(value, ceiling) {
  if (!Number.isInteger(value) || value < 0 || value > ceiling) return null;
  return value;
}

function allowedTerm(value, allowed, fallback) {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}

function capacityFrom(playbook, config) {
  const maxParallelAgents = boundedCount(playbook?.maxParallelAgents, config.limits.maxParallelAgents);
  const requestedParallelAgents = boundedCount(
    playbook?.requestedParallelAgents,
    config.limits.maxRequestedParallelAgents,
  );
  const runtimeCapacity = boundedCount(playbook?.runtimeCapacity, config.limits.maxParallelAgents);
  return {
    maxParallelAgents,
    requestedParallelAgents,
    runtimeCapacity,
    capacitySourceKind: allowedTerm(
      playbook?.capacitySourceKind,
      config.capacitySourceKinds,
      CAPACITY_SOURCE_KIND_FALLBACK,
    ),
    // Derived from two recorded numbers rather than assumed: the run asked for
    // more workers than the host allowed, which is why waves exist at all.
    throttled: maxParallelAgents !== null && requestedParallelAgents !== null
      ? requestedParallelAgents > maxParallelAgents
      : null,
  };
}

function capacityIsEmpty(capacity) {
  return capacity.maxParallelAgents === null
    && capacity.requestedParallelAgents === null
    && capacity.runtimeCapacity === null;
}

/**
 * Project the recorded wave plan of a governed artifact.
 *
 * `resolveNodeId` maps a recorded task packet identifier to the public node
 * identifier the projection already assigned it, and returns null when the
 * packet has no node. Injecting it keeps this module independent of how node
 * identifiers are derived and stops raw packet ids from leaking into the output.
 *
 * Returns null when the artifact records no usable scheduling decision, so the
 * caller can omit the block entirely rather than publish an empty shell.
 */
export function buildLiveSchedulingProjection({ playbook, resolveNodeId, config } = {}) {
  if (!playbook || typeof playbook !== "object" || Array.isArray(playbook)) return null;
  const policy = config || loadLiveSchedulingConfig();
  const resolve = typeof resolveNodeId === "function" ? resolveNodeId : () => null;
  const capacity = capacityFrom(playbook, policy);
  const allWaves = Array.isArray(playbook.waves) ? playbook.waves : [];
  const rawWaves = allWaves.slice(0, policy.limits.maxWaves);

  let declaredTaskCount = 0;
  const waves = [];
  for (const rawWave of rawWaves) {
    if (!rawWave || typeof rawWave !== "object" || Array.isArray(rawWave)) continue;
    const waveId = safeSchedulingId(rawWave.waveId);
    if (!waveId) continue;
    const allPacketIds = Array.isArray(rawWave.taskPacketIds) ? rawWave.taskPacketIds : [];
    const packetIds = allPacketIds.slice(0, policy.limits.maxNodeIdsPerWave);
    declaredTaskCount += allPacketIds.length;
    const nodeIds = [];
    for (const packetId of packetIds) {
      const nodeId = typeof packetId === "string" ? resolve(packetId) : null;
      const safeNodeId = safeSchedulingId(nodeId);
      if (safeNodeId && !nodeIds.includes(safeNodeId)) nodeIds.push(safeNodeId);
    }
    // A declared member that produced no distinct node is reported as unmapped
    // rather than dropped, so mapped + unmapped always equals what was declared.
    // Members past the per-wave cap count as unmapped too: a cap that quietly
    // shrank the wave would still read as full coverage on screen.
    const unmappedCount = allPacketIds.length - nodeIds.length;
    waves.push({
      waveId,
      waveIndex: waves.length + 1,
      mode: allowedTerm(rawWave.mode, policy.waveModes, WAVE_MODE_FALLBACK),
      declaredParallelCount: boundedCount(rawWave.parallelCount, policy.limits.maxParallelAgents),
      nodeIds,
      mappedCount: nodeIds.length,
      unmappedCount,
      mergeOwner: safeOwner(rawWave.mergeOwner),
    });
  }

  if (waves.length === 0 && capacityIsEmpty(capacity)) return null;

  const mappedNodeCount = waves.reduce((total, wave) => total + wave.mappedCount, 0);
  return {
    schemaVersion: LIVE_SCHEDULING_SCHEMA_VERSION,
    provenance: LIVE_SCHEDULING_PROVENANCE,
    source: LIVE_SCHEDULING_SOURCE,
    capacity,
    waves,
    waveCount: waves.length,
    declaredWaveCount: allWaves.length,
    coverage: {
      declaredTaskCount,
      mappedNodeCount,
      complete: declaredTaskCount > 0 && mappedNodeCount === declaredTaskCount,
    },
  };
}

/**
 * Re-validate a scheduling block that came back from a stored projection file.
 *
 * Stored bytes are untrusted input: the file may predate the current schema, may
 * name nodes that later compaction removed, and may claim a provenance it cannot
 * support. Node identifiers are therefore intersected with the nodes that
 * survive in the same projection, and provenance is re-pinned rather than read.
 */
export function sanitizeLiveSchedulingProjection(raw, { knownNodeIds, config } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.schemaVersion !== LIVE_SCHEDULING_SCHEMA_VERSION) return null;
  const policy = config || loadLiveSchedulingConfig();
  const known = knownNodeIds instanceof Set
    ? knownNodeIds
    : new Set(Array.isArray(knownNodeIds) ? knownNodeIds : []);
  const capacity = capacityFrom(raw.capacity, policy);
  const allWaves = Array.isArray(raw.waves) ? raw.waves : [];
  const rawWaves = allWaves.slice(0, policy.limits.maxWaves);

  let declaredTaskCount = 0;
  const waves = [];
  const seenWaveIds = new Set();
  for (const rawWave of rawWaves) {
    if (!rawWave || typeof rawWave !== "object" || Array.isArray(rawWave)) continue;
    const waveId = safeSchedulingId(rawWave.waveId);
    if (!waveId || seenWaveIds.has(waveId)) continue;
    seenWaveIds.add(waveId);
    const allStoredIds = Array.isArray(rawWave.nodeIds) ? rawWave.nodeIds : [];
    const storedIds = allStoredIds.slice(0, policy.limits.maxNodeIdsPerWave);
    const nodeIds = [];
    for (const candidate of storedIds) {
      const nodeId = safeSchedulingId(candidate);
      if (nodeId && known.has(nodeId) && !nodeIds.includes(nodeId)) nodeIds.push(nodeId);
    }
    const storedUnmapped = boundedCount(rawWave.unmappedCount, policy.limits.maxNodeIdsPerWave) ?? 0;
    // Whatever the file claims, a node id that no longer resolves is an unmapped
    // member now. Recount instead of trusting the stored total.
    const unmappedCount = storedUnmapped + (allStoredIds.length - nodeIds.length);
    declaredTaskCount += nodeIds.length + unmappedCount;
    waves.push({
      waveId,
      waveIndex: waves.length + 1,
      mode: allowedTerm(rawWave.mode, policy.waveModes, WAVE_MODE_FALLBACK),
      declaredParallelCount: boundedCount(rawWave.declaredParallelCount, policy.limits.maxParallelAgents),
      nodeIds,
      mappedCount: nodeIds.length,
      unmappedCount,
      mergeOwner: safeOwner(rawWave.mergeOwner),
    });
  }

  if (waves.length === 0 && capacityIsEmpty(capacity)) return null;

  const mappedNodeCount = waves.reduce((total, wave) => total + wave.mappedCount, 0);
  return {
    schemaVersion: LIVE_SCHEDULING_SCHEMA_VERSION,
    provenance: LIVE_SCHEDULING_PROVENANCE,
    source: LIVE_SCHEDULING_SOURCE,
    capacity,
    waves,
    waveCount: waves.length,
    declaredWaveCount: allWaves.length,
    coverage: {
      declaredTaskCount,
      mappedNodeCount,
      complete: declaredTaskCount > 0 && mappedNodeCount === declaredTaskCount,
    },
  };
}

/**
 * Whether the control room should annotate the graph with wave order.
 *
 * A single wave carries no ordering information, so the threshold lives in
 * config rather than being assumed to be one.
 */
export function schedulingAnnotationVisible(scheduling, config) {
  if (!scheduling || typeof scheduling !== "object") return false;
  const policy = config || loadLiveSchedulingConfig();
  const waveCount = Number.isInteger(scheduling.waveCount) ? scheduling.waveCount : 0;
  if (waveCount >= policy.display.minWavesToAnnotate) return true;
  return policy.display.showCapacityWithoutWaves && !capacityIsEmpty(capacityFrom(scheduling.capacity, policy));
}

/** Index wave membership by node id so a renderer can look a node up in constant time. */
export function schedulingWaveIndexByNode(scheduling) {
  const index = new Map();
  if (!scheduling || !Array.isArray(scheduling.waves)) return index;
  for (const wave of scheduling.waves) {
    if (!wave || !Array.isArray(wave.nodeIds)) continue;
    for (const nodeId of wave.nodeIds) {
      if (typeof nodeId === "string" && !index.has(nodeId)) {
        index.set(nodeId, { waveId: wave.waveId, waveIndex: wave.waveIndex, mode: wave.mode });
      }
    }
  }
  return index;
}
