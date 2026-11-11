/** Pure OS resolution. Host filesystem semantics are separate from route targets. */
import matrix from "../../../config/os-compatibility-matrix.json" with { type: "json" };

const policy = matrix.hostDetection;
const normalize = value => String(value ?? "").trim().toLowerCase();
const mapped = (map, value) => Object.hasOwn(map, value) ? map[value] : value;
export const OPERATING_SYSTEM_TARGETS = Object.freeze(matrix.operatingSystems.map(system => system.id));

export function resolveOperatingSystem({ requestedOs = null, environmentOs = null, hostPlatform = "", hostRelease = "" } = {}) {
  const platform = normalize(hostPlatform);
  let hostOs = Object.hasOwn(policy.nodePlatformAliases, platform) ? policy.nodePlatformAliases[platform] : policy.unknownHost;
  if (hostOs === "linux" && new RegExp(policy.wsl2KernelPattern, "iu").test(String(hostRelease))) hostOs = "wsl2";
  const requested = normalize(requestedOs ?? environmentOs) || "auto";
  const targetOs = requested === "auto" ? hostOs : mapped(policy.targetAliases, requested);
  return Object.freeze({ requested, hostOs, targetOs,
    source: requested === "auto" ? "observed_host" : requestedOs == null ? "environment_target" : "explicit_target",
    supported: OPERATING_SYSTEM_TARGETS.includes(targetOs) });
}
