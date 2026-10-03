// Reviewed local-tool safety policy. Targets, workspace roots and source hashes
// belong to the run's work order; they cannot override this executable allowlist.
function immutable(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") immutable(child);
  }
  return Object.freeze(value);
}

export const LOCAL_DEPENDENCY_TOOL_CONTRACT = immutable({
  dependencyId: "kim-service",
  componentId: "semgrep-skill",
  componentVersion: "1.1.0",
  capabilityId: "local-security-scan",
  // POSIX Kim scans detach their own process group; parent-group cleanup cannot
  // yet attest the full scanner tree. Windows Job ownership is verified.
  supportedPlatforms: ["win32"],
  rules: "rules/local-security.yml",
  ruleIds: ["python-subprocess-shell-true", "javascript-eval"],
  invocation: {
    schemaVersion: 1,
    type: "local_cli",
    runtime: "python",
    entrypoint: "scripts/scan.py",
    argv: ["--input-json", "-"],
    inputTransport: "stdin_json",
    outputTransport: "stdout_json",
    shell: false,
  },
});

export const LOCAL_DEPENDENCY_TOOL_SCHEMA_VERSION = 1;
export const LOCAL_DEPENDENCY_TOOL_INPUT_FIELDS = immutable(["schemaVersion", "workspaceRoot", "target"]);
export const LOCAL_DEPENDENCY_TOOL_OUTPUT_STATUSES = immutable(["completed", "partial", "invalid_input", "unavailable", "failed"]);
export const LOCAL_DEPENDENCY_TOOL_OUTPUT_SHAPES = immutable({
  root: ["schemaVersion", "componentVersion", "status", "completed", "findings", "errors", "runtime", "rules", "networkUsed", "filesModified"],
  runtime: ["pythonVersion", "semgrepVersion"],
  rules: ["source", "sourceSha256", "effectiveSha256", "includedRuleIds"],
  finding: ["checkId", "path", "start", "end", "severity", "message"],
  location: ["line", "col"],
  error: ["code", "message"],
});
