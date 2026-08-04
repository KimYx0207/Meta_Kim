import {
  parseScopeArg,
  parseTargetsArg,
} from "./meta-kim-sync-config.mjs";

const SUPPORTED_RUNTIME_LAUNCH_TARGETS = Object.freeze(["claude", "codex"]);

export function resolveRuntimeLaunchRebindRequest(argv = []) {
  const targets = argv.some(
    (arg) => arg === "--targets" || arg.startsWith("--targets="),
  )
    ? parseTargetsArg(argv)
    : [...SUPPORTED_RUNTIME_LAUNCH_TARGETS];
  const unsupported = targets.filter(
    (target) => !SUPPORTED_RUNTIME_LAUNCH_TARGETS.includes(target),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `--rebind-runtime-launch does not support ${unsupported.join(", ")} (expected claude, codex)`,
    );
  }
  if (targets.length === 0) {
    throw new Error(
      "--rebind-runtime-launch needs at least one of --targets claude,codex",
    );
  }

  const hasScope = argv.some(
    (arg) => arg === "--scope" || arg.startsWith("--scope="),
  );
  const scope = hasScope ? parseScopeArg(argv) : "global";
  if (!['global', 'project'].includes(scope)) {
    throw new Error(
      `--rebind-runtime-launch does not support scope ${scope} (expected global or project)`,
    );
  }
  return { targets, scope };
}

export async function runRuntimeLaunchRebind({
  argv = [],
  nodeVersion,
  minimumNodeVersion,
  supportsNodeVersion,
  refreshBindings,
  writeOutput = (message) => console.log(message),
  writeError = (message) => console.error(message),
} = {}) {
  if (!supportsNodeVersion(nodeVersion)) {
    writeError(
      `meta-kim setup: --rebind-runtime-launch requires Node ${minimumNodeVersion} or newer (running ${nodeVersion})`,
    );
    return false;
  }

  let request;
  try {
    request = resolveRuntimeLaunchRebindRequest(argv);
  } catch (error) {
    writeError(`meta-kim setup: ${error.message}`);
    return false;
  }

  const bound = await refreshBindings(request.targets, request.scope);
  if (!bound) return false;
  writeOutput(
    `Re-recorded runtime launch inventory: ${request.targets.join(", ")} (scope: ${request.scope})`,
  );
  return true;
}
