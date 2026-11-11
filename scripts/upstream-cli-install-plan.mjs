const HOME_TARGETS = new Set(["codex", "opencode", "qwen"]);
const PROJECT_TARGETS = new Set(["cursor", "zed", "gemini", "codebuddy", "antigravity", "joycode"]);

export function upstreamCliTargetMode(runtimeId) {
  return HOME_TARGETS.has(runtimeId) ? "home" : PROJECT_TARGETS.has(runtimeId) ? "project" : null;
}

/** The npm yes flag is not ECC's hook choice. Keep the choice explicit. */
export function upstreamCliArgsForTarget(spec, runtimeId) {
  const pkg = spec.upstreamPackage;
  if (spec.id !== "ecc" || !/^ecc-universal@\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(pkg ?? "")) {
    throw new Error("ECC upstreamPackage must name an exact reviewed ecc-universal version");
  }
  if (!upstreamCliTargetMode(runtimeId)) throw new Error(`Unsupported ECC target: ${runtimeId}`);
  const profile = spec.upstreamProfile || "core";
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(profile)) throw new Error("Invalid ECC profile");
  const hookPolicy = spec.upstreamHookPolicyByTarget?.[runtimeId] ?? spec.upstreamHookPolicy ?? "disabled";
  if (!["disabled", "enabled"].includes(hookPolicy)) throw new Error("Invalid ECC hook policy");
  return ["--yes", "--package", pkg, "ecc", "install", "--profile", profile, "--target", runtimeId,
    hookPolicy === "enabled" ? "--enable-hooks" : "--no-hooks"];
}
