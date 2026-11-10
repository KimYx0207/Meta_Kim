import { constants, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

/** Locate only explicitly registered commands. Never execute PATH contents. */
export async function discoverOptionalEngines({ projects = [], environment = process.env,
  platform = process.platform } = {}) {
  const windows = platform === "win32";
  const pathValue = environment.PATH ?? environment.Path ?? "";
  const directories = [...new Set(String(pathValue).split(windows ? ";" : path.delimiter)
    .filter((entry) => entry && path.isAbsolute(entry)))].slice(0, 256);
  const suffixes = windows ? [...new Set(["", ...String(environment.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";").filter((value) => /^\.[a-z0-9]+$/iu.test(value))])] : [""];
  const records = [];
  for (const project of projects) {
    const discovery = project.interface?.executableDiscovery;
    if (!discovery || discovery.policy !== "path_presence_only") continue;
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(discovery.command) ||
        discovery.automaticInstall !== false || discovery.automaticExecution !== false) {
      throw new Error(`Invalid read-only engine discovery contract: ${project.id}`);
    }
    let executable = null;
    let identity = null;
    for (const directory of directories) {
      for (const suffix of suffixes) {
        const candidate = path.join(directory, `${discovery.command}${suffix}`);
        try {
          const stat = await fs.stat(candidate);
          if (!stat.isFile()) continue;
          await fs.access(candidate, windows ? constants.F_OK : constants.X_OK);
          executable = candidate;
          identity = { size: stat.size, modified: stat.mtimeMs, realPath: await fs.realpath(candidate) };
          break;
        } catch (error) {
          if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(error.code)) throw error;
        }
      }
      if (executable) break;
    }
    records.push({
      id: project.id, command: discovery.command, capabilityType: project.capabilityType,
      interfaces: structuredClone(project.interfaces ?? []),
      description: project.capabilityCard?.oneLine ?? project.name,
      available: Boolean(executable), executablePath: executable,
      availability: executable ? "executable_present" : "not_located_on_allowed_path",
      // This digest binds an observation, not executable bytes or trust.
      observationDigest: createHash("sha256").update(JSON.stringify({ command: discovery.command, identity })).digest("hex"),
      observationKind: "path_presence_only", version: null, permissionStatus: "unknown",
      sessionStatus: "unverified", invocationState: "not_invoked", liveVerified: false,
      routeEligible: false, qualification: "requires_host_and_task_validation",
      sourceRef: project.source?.uri ?? null,
    });
  }
  return records;
}

export function optionalEngineCommand(record, platformId, platformName) {
  return {
    id: `${record.id}-cli`, type: "commands", platformId, platform: platformName,
    path: record.executablePath, sourceRef: record.executablePath,
    contentDigest: record.observationDigest,
    command: record.command, available: record.available, routeEligible: false,
    executionBlock: true,
    metadata: { name: record.id, description: record.description,
      providerKind: "optional_upstream_engine", capabilityType: record.capabilityType,
      interfaces: record.interfaces, transport: "local_process", command: record.command,
      permissionStatus: "unknown", observationKind: "path_presence_only",
      invocationState: "not_invoked", liveVerified: false },
  };
}
