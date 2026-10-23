import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/** Read the actual discovery files in declared priority order, without changing discovery. */
export async function inspectOptionalPlaybookProvider(candidatePaths) {
  const candidates = [];
  for (const candidate of candidatePaths) {
    let text = null;
    if (!candidate.probeSuppressed) {
      try {
        text = await readFile(candidate.filePath, "utf8");
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
      }
    }
    candidates.push({
      source: candidate.source,
      pathRef: candidate.pathRef,
      found: Boolean(text),
      version: text?.match(/^version:\s*["']?([^"'\n]+)["']?/m)?.[1]?.trim() ?? null,
      probeSuppressed: candidate.probeSuppressed === true,
    });
  }
  const nearest = candidates.find((candidate) => candidate.found) ?? null;
  return {
    candidates,
    found: nearest !== null,
    selectedSource: nearest?.source ?? null,
    selectedPathRef: nearest?.pathRef ?? null,
    selectedVersion: nearest?.version ?? null,
  };
}

/** Assert discovery provenance, native fanout readiness, and the absence of host invocation. */
export async function assertOptionalPlaybookContract(packet, invocationTruth, candidatePaths, { ready = true } = {}) {
  const expected = await inspectOptionalPlaybookProvider(candidatePaths);
  const resolution = packet.providerResolution;
  assert.equal(resolution.schemaVersion, "agent-teams-playbook-provider-resolution-v0.1");
  assert.equal(resolution.providerId, "agent-teams-playbook");
  for (const [field, value] of Object.entries(expected)) {
    assert.deepEqual(resolution[field], value, `optional provider ${field} must match the nearest real source`);
  }
  if (!ready) {
    assert.equal(packet.status, "partial");
    assert.equal(packet.selected, false);
    assert.equal(packet.fanoutSafetyPacket.safeForParallelFanout, false);
    assert.equal(packet.acceptance.orchestrationReadyWhenParallelLanes, false);
    assert.equal(packet.evidenceKind, "fanout_safety_or_wave_unproven");
    assert.deepEqual(packet.waves, [], "Unsafe planned lanes must not enter dispatch waves");
    assert.ok(packet.totalWorkerTaskCount >= 2, "The worker plan remains available before dispatch readiness");
    const invocation = invocationTruth.rows.find((row) => row.family === "agent_teams_playbook");
    assert.equal(invocation.state, "unavailable");
    assert.equal(invocation.invokedCount, 0);
    return expected;
  }
  assert.equal(packet.status, "pass");
  assert.equal(packet.triggered, true);
  assert.equal(packet.selected, expected.found);
  assert.equal(packet.selectedAs, expected.found
    ? "parallel_fanout_orchestration_adapter"
    : "optional_adapter_not_required_for_native_fanout");
  assert.equal(packet.evidenceKind, expected.found
    ? "orchestration_provider_selected"
    : "native_stage_dag_ready_optional_playbook_not_selected");
  assert.equal(packet.acceptance.optionalProviderDoesNotGateNativeFanout, !expected.found);
  assert.equal(packet.fanoutSafetyPacket.safeForParallelFanout, true);
  for (const field of [
    "orchestrationReadyWhenParallelLanes", "independentLanesProven", "parallelWaveExists",
    "dagAndCollisionSafe", "waveSizeWithinCap", "waveSizeWithinRuntimeCapacity",
    "noArbitraryMetaKimCap", "workerPacketsPreserved", "noLiveSubagentOverclaim",
  ]) {
    assert.equal(packet.acceptance[field], true, `native fanout ${field}`);
  }
  const invocation = invocationTruth.rows.find((row) => row.family === "agent_teams_playbook");
  assert.ok(invocation);
  assert.equal(invocation.state, expected.found ? "selected_not_invoked" : "not_required");
  assert.equal(invocation.selectedCount, expected.found ? 1 : 0);
  assert.equal(invocation.invokedCount, 0);
  assert.equal(packet.runtimeInvocationBoundary.runnerCanCallHostSpawnAgent, false);
  assert.equal(packet.runtimeInvocationBoundary.hostSpawnAgentEvidenceAttached, false);
  return expected;
}
