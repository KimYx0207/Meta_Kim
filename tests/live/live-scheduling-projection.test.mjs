import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  LIVE_SCHEDULING_PROVENANCE,
  LIVE_SCHEDULING_SCHEMA_VERSION,
  buildLiveSchedulingProjection,
  loadLiveSchedulingConfig,
  normalizeLiveSchedulingConfig,
  sanitizeLiveSchedulingProjection,
  schedulingAnnotationVisible,
  schedulingWaveIndexByNode,
} from "../../src/application/live/live-scheduling-projection.mjs";

// Shaped after the recorded agentTeamsPlaybookPacket of a real governed run:
// two agents per wave, a followup wave, a merge owner, and a capacity block
// whose request exceeded the active limit.
function samplePlaybook() {
  return {
    maxParallelAgents: 2,
    requestedParallelAgents: 8,
    runtimeCapacity: 2,
    capacitySourceKind: "active_config",
    capacitySource: ".codex/config.toml",
    waves: [
      {
        waveId: "agent-team-wave-1",
        mode: "primary_parallel_wave",
        parallelCount: 2,
        mergeOwner: "meta-conductor",
        taskPacketIds: ["packet-a", "packet-b"],
      },
      {
        waveId: "agent-team-wave-2",
        mode: "followup_parallel_wave",
        parallelCount: 2,
        mergeOwner: "meta-conductor",
        taskPacketIds: ["packet-c", "packet-d"],
      },
    ],
  };
}

const SAMPLE_NODE_BY_PACKET = new Map([
  ["packet-a", "agent:aaaa"],
  ["packet-b", "agent:bbbb"],
  ["packet-c", "agent:cccc"],
  ["packet-d", "agent:dddd"],
]);

function buildSample(overrides = {}) {
  return buildLiveSchedulingProjection({
    playbook: samplePlaybook(),
    resolveNodeId: (packetId) => SAMPLE_NODE_BY_PACKET.get(packetId) || null,
    ...overrides,
  });
}

test("projects recorded waves without inventing order or leaking packet identifiers", () => {
  const scheduling = buildSample();
  assert.equal(scheduling.schemaVersion, LIVE_SCHEDULING_SCHEMA_VERSION);
  assert.equal(scheduling.provenance, "planned");
  assert.equal(scheduling.waveCount, 2);
  assert.deepEqual(scheduling.waves.map((wave) => wave.waveIndex), [1, 2]);
  assert.deepEqual(scheduling.waves[0].nodeIds, ["agent:aaaa", "agent:bbbb"]);
  assert.equal(scheduling.waves[0].mergeOwner, "meta-conductor");
  assert.deepEqual(scheduling.coverage, { declaredTaskCount: 4, mappedNodeCount: 4, complete: true });
  const serialized = JSON.stringify(scheduling);
  assert.equal(serialized.includes("packet-a"), false);
  assert.equal(serialized.includes("config.toml"), false);
  assert.equal(serialized.includes("taskPacketIds"), false);
});

test("reports the recorded capacity numbers and derives throttling from them", () => {
  const { capacity } = buildSample();
  assert.deepEqual(capacity, {
    maxParallelAgents: 2,
    requestedParallelAgents: 8,
    runtimeCapacity: 2,
    capacitySourceKind: "active_config",
    throttled: true,
  });
});

test("does not claim throttling when the request fits the recorded limit", () => {
  const playbook = { ...samplePlaybook(), requestedParallelAgents: 2 };
  const scheduling = buildLiveSchedulingProjection({
    playbook,
    resolveNodeId: (packetId) => SAMPLE_NODE_BY_PACKET.get(packetId) || null,
  });
  assert.equal(scheduling.capacity.throttled, false);
});

test("counts a declared member that resolves to no node as unmapped instead of dropping it", () => {
  const scheduling = buildLiveSchedulingProjection({
    playbook: samplePlaybook(),
    resolveNodeId: (packetId) => (packetId === "packet-b" ? null : SAMPLE_NODE_BY_PACKET.get(packetId) || null),
  });
  assert.deepEqual(scheduling.waves[0].nodeIds, ["agent:aaaa"]);
  assert.equal(scheduling.waves[0].mappedCount, 1);
  assert.equal(scheduling.waves[0].unmappedCount, 1);
  assert.equal(scheduling.coverage.mappedNodeCount, 3);
  assert.equal(scheduling.coverage.complete, false);
});

test("omits the block entirely when nothing about scheduling was recorded", () => {
  assert.equal(buildLiveSchedulingProjection({ playbook: {}, resolveNodeId: () => null }), null);
  assert.equal(buildLiveSchedulingProjection({ playbook: null, resolveNodeId: () => null }), null);
  assert.equal(buildLiveSchedulingProjection(), null);
});

test("keeps capacity even when no wave was recorded", () => {
  const scheduling = buildLiveSchedulingProjection({
    playbook: { maxParallelAgents: 4, requestedParallelAgents: 4 },
    resolveNodeId: () => null,
  });
  assert.equal(scheduling.waveCount, 0);
  assert.equal(scheduling.capacity.maxParallelAgents, 4);
});

test("falls back to a reserved term instead of echoing an unrecognised wave mode", () => {
  const playbook = samplePlaybook();
  playbook.waves[0].mode = "wave_mode_we_never_declared";
  const scheduling = buildLiveSchedulingProjection({
    playbook,
    resolveNodeId: (packetId) => SAMPLE_NODE_BY_PACKET.get(packetId) || null,
  });
  assert.equal(scheduling.waves[0].mode, "unspecified_wave");
});

test("re-pins a stored projection that claims its wave order was observed", () => {
  const stored = JSON.parse(JSON.stringify(buildSample()));
  stored.provenance = "observed";
  const sanitized = sanitizeLiveSchedulingProjection(stored, {
    knownNodeIds: new Set(["agent:aaaa", "agent:bbbb", "agent:cccc", "agent:dddd"]),
  });
  assert.equal(sanitized.provenance, LIVE_SCHEDULING_PROVENANCE);
  assert.equal(sanitized.provenance, "planned");
});

test("drops stored wave members that no longer resolve and recounts the loss", () => {
  const stored = JSON.parse(JSON.stringify(buildSample()));
  stored.waves[0].nodeIds.push("agent:ghost");
  const sanitized = sanitizeLiveSchedulingProjection(stored, {
    knownNodeIds: new Set(["agent:aaaa", "agent:cccc", "agent:dddd"]),
  });
  assert.deepEqual(sanitized.waves[0].nodeIds, ["agent:aaaa"]);
  assert.equal(sanitized.waves[0].mappedCount, 1);
  assert.equal(sanitized.waves[0].unmappedCount, 2);
  assert.equal(sanitized.coverage.complete, false);
});

test("rejects a stored block written against a different scheduling schema", () => {
  const stored = { ...buildSample(), schemaVersion: "meta-kim-live-scheduling-v0" };
  assert.equal(sanitizeLiveSchedulingProjection(stored, { knownNodeIds: new Set(["agent:aaaa"]) }), null);
});

test("rejects stored scheduling shapes that are not objects with waves", () => {
  const knownNodeIds = new Set(["agent:aaaa"]);
  assert.equal(sanitizeLiveSchedulingProjection(null, { knownNodeIds }), null);
  assert.equal(sanitizeLiveSchedulingProjection("planned", { knownNodeIds }), null);
  assert.equal(sanitizeLiveSchedulingProjection([], { knownNodeIds }), null);
  assert.equal(sanitizeLiveSchedulingProjection({ schemaVersion: LIVE_SCHEDULING_SCHEMA_VERSION }, { knownNodeIds }), null);
});

test("keeps only the first record of a duplicated wave id", () => {
  const stored = JSON.parse(JSON.stringify(buildSample()));
  stored.waves.push({ ...stored.waves[0], mode: "serial_wave" });
  const sanitized = sanitizeLiveSchedulingProjection(stored, {
    knownNodeIds: new Set(["agent:aaaa", "agent:bbbb", "agent:cccc", "agent:dddd"]),
  });
  assert.equal(sanitized.waveCount, 2);
  assert.equal(sanitized.waves[0].mode, "primary_parallel_wave");
});

test("maps every node to the first wave that declares it", () => {
  const index = schedulingWaveIndexByNode(buildSample());
  assert.equal(index.get("agent:aaaa").waveIndex, 1);
  assert.equal(index.get("agent:cccc").waveIndex, 2);
  assert.equal(index.has("agent:ghost"), false);
  assert.equal(schedulingWaveIndexByNode(null).size, 0);
});

test("hides the wave annotation below the configured wave threshold", () => {
  const config = loadLiveSchedulingConfig();
  const single = buildLiveSchedulingProjection({
    playbook: { waves: [samplePlaybook().waves[0]] },
    resolveNodeId: (packetId) => SAMPLE_NODE_BY_PACKET.get(packetId) || null,
  });
  assert.equal(single.waveCount, 1);
  assert.equal(config.display.minWavesToAnnotate, 2);
  assert.equal(schedulingAnnotationVisible(single, config), false);
  assert.equal(schedulingAnnotationVisible(buildSample(), config), true);
  assert.equal(schedulingAnnotationVisible(null, config), false);
});

test("loads the shipped scheduling config and treats it as the only source of vocabulary", () => {
  const config = loadLiveSchedulingConfig();
  assert.equal(config.schemaVersion, LIVE_SCHEDULING_SCHEMA_VERSION);
  assert.ok(config.waveModes.includes("primary_parallel_wave"));
  assert.ok(config.capacitySourceKinds.includes("active_config"));
  assert.ok(config.limits.maxWaves > 0);
  // provenance is a truth invariant, so the shipped config must not offer a knob
  // that could relabel a declared wave order as observed execution.
  assert.equal(Object.prototype.hasOwnProperty.call(config, "provenance"), false);
});

test("fails loudly instead of silently degrading when the config is unusable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meta-kim-scheduling-config-"));
  try {
    const configPath = path.join(directory, "scheduling.json");
    await writeFile(configPath, JSON.stringify({ schemaVersion: "wrong-version" }), "utf8");
    assert.throws(() => loadLiveSchedulingConfig(pathToFileURL(configPath)), /scheduling/iu);

    await writeFile(configPath, "{not json", "utf8");
    assert.throws(() => loadLiveSchedulingConfig(pathToFileURL(configPath)));

    assert.throws(() => loadLiveSchedulingConfig(pathToFileURL(path.join(directory, "absent.json"))));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a config that tries to declare a reserved fallback term", () => {
  const base = loadLiveSchedulingConfig();
  assert.throws(() => normalizeLiveSchedulingConfig({
    ...base,
    waveModes: [...base.waveModes, "unspecified_wave"],
  }), /reserved/iu);
  assert.throws(() => normalizeLiveSchedulingConfig({
    ...base,
    capacitySourceKinds: [...base.capacitySourceKinds, "unspecified"],
  }), /reserved/iu);
});

test("rejects a config with empty vocabularies or non-positive limits", () => {
  const base = loadLiveSchedulingConfig();
  assert.throws(() => normalizeLiveSchedulingConfig({ ...base, waveModes: [] }));
  assert.throws(() => normalizeLiveSchedulingConfig({ ...base, capacitySourceKinds: [] }));
  assert.throws(() => normalizeLiveSchedulingConfig({ ...base, limits: { ...base.limits, maxWaves: 0 } }));
});

test("bounds waves and wave membership by the configured limits without hiding the loss", () => {
  const config = normalizeLiveSchedulingConfig({
    ...loadLiveSchedulingConfig(),
    limits: { maxWaves: 1, maxNodeIdsPerWave: 1, maxParallelAgents: 512, maxRequestedParallelAgents: 4096 },
  });
  const scheduling = buildLiveSchedulingProjection({
    playbook: samplePlaybook(),
    resolveNodeId: (packetId) => SAMPLE_NODE_BY_PACKET.get(packetId) || null,
    config,
  });
  assert.equal(scheduling.waveCount, 1);
  assert.equal(scheduling.declaredWaveCount, 2);
  assert.equal(scheduling.waves[0].nodeIds.length, 1);
  // The member past the per-wave cap is still a declared member, so coverage
  // reports it as unmapped instead of reading as a complete one-member wave.
  assert.equal(scheduling.waves[0].unmappedCount, 1);
  assert.equal(scheduling.coverage.declaredTaskCount, 2);
  assert.equal(scheduling.coverage.complete, false);
});

test("reports how many waves were recorded next to how many were projected", () => {
  const scheduling = buildSample();
  assert.equal(scheduling.declaredWaveCount, 2);
  assert.equal(scheduling.waveCount, 2);
  const stored = JSON.parse(JSON.stringify(scheduling));
  const sanitized = sanitizeLiveSchedulingProjection(stored, {
    knownNodeIds: new Set(["agent:aaaa", "agent:bbbb", "agent:cccc", "agent:dddd"]),
  });
  assert.equal(sanitized.declaredWaveCount, 2);
});
