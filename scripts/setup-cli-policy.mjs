export const SETUP_BOOLEAN_ARGS = Object.freeze([
  "--update", "-u", "--check", "--silent", "--with-global-hooks",
  "--without-global-hooks", "--all-projects", "--update-projects",
  "--save-project-dirs", "--prompt-proxy", "--project-bootstrap",
  "--cleanup-projects", "--project-cleanup", "--dry-run", "--apply", "--json",
  "--rebind-runtime-launch",
]);

export const SETUP_VALUE_ARGS = Object.freeze([
  "--lang", "--skills", "--targets", "--scope", "--project-dir", "--deploy-dir", "--target-dir",
]);

export class SetupCliPolicyError extends Error {
  constructor(message, { showHelp = false } = {}) {
    super(message);
    this.name = "SetupCliPolicyError";
    this.showHelp = showHelp;
  }
}

export function normalizeSetupCliArgs(argv = []) {
  return argv.flatMap((arg) => {
    const valueArg = SETUP_VALUE_ARGS.find((name) => arg.startsWith(`${name}=`));
    if (!valueArg) return [arg];
    return [valueArg, arg.slice(valueArg.length + 1)];
  });
}

export function validateSetupCliArgs(argv = []) {
  const normalizedArgv = normalizeSetupCliArgs(argv);
  const booleanArgs = new Set(SETUP_BOOLEAN_ARGS);
  const valueArgs = new Set(SETUP_VALUE_ARGS);
  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const arg = normalizedArgv[index];
    if (booleanArgs.has(arg)) continue;
    if (valueArgs.has(arg)) {
      const value = normalizedArgv[index + 1];
      if (typeof value !== "string" || !value.trim() || value.startsWith("--")) {
        throw new SetupCliPolicyError(`missing value for ${arg}`);
      }
      if (arg === "--scope" && !["global", "project"].includes(value)) {
        throw new SetupCliPolicyError(
          `invalid value for --scope: ${value} (expected global or project)`,
        );
      }
      index += 1;
      continue;
    }
    throw new SetupCliPolicyError(`unknown option '${arg}'`, { showHelp: true });
  }
  const modes = new Set();
  if (normalizedArgv.includes("--update") || normalizedArgv.includes("-u")) modes.add("update");
  if (normalizedArgv.includes("--check")) modes.add("check");
  if (normalizedArgv.includes("--project-bootstrap")) modes.add("project-bootstrap");
  if (normalizedArgv.includes("--project-cleanup") || normalizedArgv.includes("--cleanup-projects")) {
    modes.add("project-cleanup");
  }
  if (normalizedArgv.includes("--rebind-runtime-launch")) modes.add("rebind-runtime-launch");
  if (modes.size > 1) {
    throw new SetupCliPolicyError(`conflicting setup modes: ${[...modes].join(", ")}`);
  }
  return true;
}
