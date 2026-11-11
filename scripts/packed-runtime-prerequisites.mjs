import { probeRuntimeCli } from "./runtime-cli-probe.mjs";
import { assertExactStandardRuntimeObservationSet, standardRuntimeObservationSet } from "./runtime-execution-gate.mjs";

/** Free executable/version checks do not establish native invocation evidence. */
export function requirePackedRuntimePrerequisites({ env, cwd, targets = ["claude", "codex"] }) {
  const observations = targets.map(runtime => {
    const probe = probeRuntimeCli(runtime, { env, cwd });
    return { runtime, status: probe.status, version: probe.version, reason: probe.reason ?? null };
  });
  const unavailable = observations.filter(item => item.status !== "detected").map(item => item.runtime);
  const diagnostics = {
    status: unavailable.length ? "environment_unavailable" : "available",
    probeKind: "executable_version_only", observations, unavailable,
    modelInvocation: false, executionAuthority: false,
  };
  if (unavailable.length) {
    const error = new Error(`environment_unavailable: packed acceptance requires usable official runtime CLIs on PATH (${unavailable.join(", ")}); install them in a test-only prefix and verify --version before rerunning. No model call is required.`);
    error.code = "environment_unavailable";
    error.runtimePrerequisites = diagnostics;
    throw error;
  }
  return diagnostics;
}

/** Preserve the exact native set requirement and explain missing source evidence. */
export function requirePackedRuntimeObservationPrerequisites(effective) {
  const applied = effective.overlayStatus.applied;
  try {
    assertExactStandardRuntimeObservationSet(applied);
  } catch (cause) {
    const required = standardRuntimeObservationSet();
    const key = entry => `${entry.runtime}:${entry.capability}:${entry.mode}`;
    const actualKeys = applied.map(key);
    const expectedKeys = new Set(required.map(key));
    const missing = required.filter(entry => !actualKeys.includes(key(entry)));
    const unexpected = actualKeys.filter(value => !expectedKeys.has(value));
    const duplicateKeys = [...new Set(actualKeys.filter((value, index) => actualKeys.indexOf(value) !== index))];
    const status = missing.length && !unexpected.length && !duplicateKeys.length
      ? "environment_unavailable" : "invalid_observation_set";
    const diagnostics = {
      status, probeKind: "original_native_observation_read_only", readOnly: true,
      state: effective.overlayStatus.state, requiredCount: required.length, availableCount: applied.length,
      missing, unexpected, duplicateKeys, rejectedCount: effective.overlayStatus.rejected.length,
      modelInvocation: false, executionAuthority: false, releaseGradeEligible: false,
    };
    const error = new Error(`${status}: packed observation portability requires the exact ${required.length} fresh original Claude Code/Codex interactive_host observations; ${applied.length} available; missing: ${missing.map(key).join(", ") || "none"}. CLI --version, test fixtures and imported advisory snapshots do not satisfy this prerequisite.`, { cause });
    error.code = status;
    error.runtimeObservationPrerequisites = diagnostics;
    throw error;
  }
}
