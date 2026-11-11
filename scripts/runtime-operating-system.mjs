/** Runtime adapter: read actual host data, then use the shared OS policy. */
import process from "node:process";
import { release } from "node:os";
import { resolveOperatingSystem } from "../src/application/runtime/operating-system.mjs";
export { OPERATING_SYSTEM_TARGETS } from "../src/application/runtime/operating-system.mjs";

export function runtimeOperatingSystem(requestedOs = null, { environment = process.env, platform = process.platform, kernelRelease = release() } = {}) {
  return resolveOperatingSystem({ requestedOs, environmentOs: environment.META_KIM_OS,
    hostPlatform: platform, hostRelease: kernelRelease });
}
export function normalizeOsTarget(requestedOs, context) {
  return runtimeOperatingSystem(requestedOs, context).targetOs;
}
