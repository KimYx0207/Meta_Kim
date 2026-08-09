#!/usr/bin/env node
/**
 * Release acceptance for the public package CLI.
 *
 * This deliberately runs the packed candidate instead of repository scripts:
 *   pack -> isolated npm install -> installed CLI install -> update -> second
 *   update -> delete pack/extraction -> installed CLI check and MCP transport.
 *
 * It proves the default global-only user path without writing to the caller's
 * HOME, runtime homes, temp directory, or ordinary working directory.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  mcpDefinitionFingerprint,
  resolveDurableMetaKimRuntimeLayout,
  resolvePackageCliName,
  resolvePortableMetaKimPackageIdentity,
} from "./global-runtime-mcp.mjs";
import {
  GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES,
  globalAgentProjectionFileName,
  globalProjectionIsOwnedBy,
  resolveGlobalAgentProjectionTargets,
  resolveRuntimeProfilesFromManifest,
} from "./meta-kim-sync-config.mjs";
import {
  assertExactRuntimeCapabilityMatrix,
  parseRuntimeCapabilityEvidenceLedger,
  validateRuntimeCapabilityMatrix,
} from "./mcp/runtime-resource-contract.mjs";
import { renderGlobalAgentProjection } from "./sync-runtimes.mjs";
import { loadEffectiveRuntimeCapabilityClaims } from "./effective-runtime-capability-claims.mjs";
import { loadRuntimeCapabilityAcceptanceAttempts } from "./runtime-capability-acceptance.mjs";
import { assertExactStandardRuntimeObservationSet } from "./runtime-execution-gate.mjs";
import { resolveWindowsCliInvocation } from "./runtime-cli-invocation.mjs";
import {
  PACKED_SYNC_MANIFEST,
  PACKED_USER_TARGETS,
} from "./packed-user-targets.mjs";
import {
  PROJECTION_PACKAGE_MANIFEST_SOURCE,
  PROJECTION_PACKAGE_PURPOSE,
  PROJECTION_PACKAGE_RECEIPT_SCHEMA,
} from "./global-projection-package-store.mjs";
import {
  createEmpty as createInstallManifest,
  record as recordInstallManifest,
  writeManifest as writeInstallManifest,
} from "./install-manifest.mjs";
import {
  renderCurrentWindowsMcpMemoryStartupVbsBytes,
  resolveMcpMemoryBootArtifactDescriptors,
} from "./mcp-memory-boot-artifacts.mjs";

export { PACKED_USER_TARGETS } from "./packed-user-targets.mjs";

const PACKED_RUNTIME_PROFILES = resolveRuntimeProfilesFromManifest(
  PACKED_SYNC_MANIFEST,
);
const PACKED_RELEASE_POLICY = JSON.parse(
  readFileSync(
    path.join(
      import.meta.dirname,
      "..",
      "config",
      "contracts",
      "release-verification-policy.json",
    ),
    "utf8",
  ),
);
export const PACKED_GLOBAL_AGENT_TARGETS = Object.freeze(
  resolveGlobalAgentProjectionTargets(
    PACKED_RUNTIME_PROFILES,
    PACKED_USER_TARGETS,
  ).map((target) => Object.freeze(target)),
);
export const PACKED_USER_ACCEPTANCE_EXPECTED_DURATION_MS =
  PACKED_RELEASE_POLICY.packedUserAcceptance.expectedDurationMs;
export const PACKED_PROJECT_AWARE_GLOBAL_UPDATE_TIMEOUT_MS =
  PACKED_RELEASE_POLICY.packedUserAcceptance.projectAwareGlobalUpdateTimeoutMs;
const ACCEPTANCE_SKILL_FILTER = "planning-with-files";
const TRANSIENT_PACKAGE_TARGETS = Object.freeze(["claude", "codex"]);
const DEFAULT_TIMEOUT_MS =
  PACKED_RELEASE_POLICY.packedUserAcceptance.commandTimeoutMs;
const PROJECT_AWARE_GLOBAL_UPDATE_OPERATION_ID =
  "packed-project-aware-global-update";
const PACKED_COMMAND_ERROR_CODE_ALLOWLIST = new Set([
  "EACCES",
  "EAGAIN",
  "EBADF",
  "EBUSY",
  "ECHILD",
  "EFAULT",
  "EINTR",
  "EINVAL",
  "EIO",
  "EISDIR",
  "EMFILE",
  "ENAMETOOLONG",
  "ENFILE",
  "ENOBUFS",
  "ENOENT",
  "ENOEXEC",
  "ENOMEM",
  "ENOSPC",
  "ENOTDIR",
  "ENOTEMPTY",
  "ENOTSUP",
  "EPERM",
  "EPIPE",
  "ESRCH",
  "ETIMEDOUT",
  "UNKNOWN",
]);
const PACKED_COMMAND_OPERATION_ALLOWLIST = new Set([
  PROJECT_AWARE_GLOBAL_UPDATE_OPERATION_ID,
]);
const PACKED_COMMAND_SIGNAL_ALLOWLIST = new Set(
  Object.keys(os.constants.signals ?? {}),
);
const HISTORICAL_REF_ENV_KEY =
  PACKED_RELEASE_POLICY.packedUserAcceptance.historicalRefEnvironmentKey;
const PROJECT_PROJECTION_NAMES = Object.freeze([
  ".claude",
  ".codex",
  ".agents",
  ".cursor",
  "openclaw",
  ".mcp.json",
  "AGENTS.md",
  "CLAUDE.md",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const PORTABILITY_PLACEHOLDERS = Object.freeze([
  "__REPO_ROOT__",
  "REPLACE_WITH_REPO_ROOT",
  "__META_KIM_PACKAGE_ROOT__",
]);

function normalizedReference(value) {
  return path.resolve(String(value)).replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
}

export function collectNonPortablePackedReferences(
  value,
  { forbiddenRoots = [], location = "$" } = {},
) {
  const normalizedForbiddenRoots = forbiddenRoots
    .filter((root) => typeof root === "string" && root.trim())
    .map((root) => ({ raw: root, normalized: normalizedReference(root) }));
  const findings = [];
  const visit = (entry, entryLocation) => {
    if (typeof entry === "string") {
      for (const placeholder of PORTABILITY_PLACEHOLDERS) {
        if (entry.includes(placeholder)) {
          findings.push({ location: entryLocation, reason: "unresolved_placeholder", value: placeholder });
        }
      }
      const normalizedEntry = entry.replaceAll("\\", "/").toLowerCase();
      for (const root of normalizedForbiddenRoots) {
        if (normalizedEntry.includes(root.normalized)) {
          findings.push({ location: entryLocation, reason: "forbidden_machine_root", value: root.raw });
        }
      }
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => visit(item, `${entryLocation}[${index}]`));
      return;
    }
    if (entry && typeof entry === "object") {
      Object.entries(entry).forEach(([key, item]) => visit(item, `${entryLocation}.${key}`));
    }
  };
  visit(value, location);
  return findings;
}

export function assertPortablePackedReferences(value, options = {}) {
  const findings = collectNonPortablePackedReferences(value, options);
  if (findings.length > 0) {
    throw new Error(
      `packed generated artifact contains non-portable references: ${findings
        .map((finding) => `${finding.location}:${finding.reason}`)
        .join(", ")}`,
    );
  }
  return { status: "passed", findingCount: 0 };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    input: options.input,
  });
  if (!Object.getOwnPropertyDescriptor(result, "error")) {
    Object.defineProperty(result, "error", {
      value: null,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return result;
}

function runCli(command, args, options = {}) {
  if (process.platform !== "win32") return run(command, args, options);
  const invocation = resolveWindowsCliInvocation(command, args, { env: options.env ?? process.env });
  return run(invocation.command, invocation.args, options);
}

function readOwnEnumerableDataValue(object, property) {
  if (
    object === null ||
    (typeof object !== "object" && typeof object !== "function")
  ) {
    return { valid: false };
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, property);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      return { valid: false };
    }
    return { valid: true, value: descriptor.value };
  } catch {
    return { valid: false };
  }
}

function snapshotErrorCode(error) {
  if (error === null || error === undefined) return null;
  const code = readOwnEnumerableDataValue(error, "code");
  if (!code.valid) {
    return "COMMAND_ERROR";
  }
  return PACKED_COMMAND_ERROR_CODE_ALLOWLIST.has(code.value)
    ? code.value
    : "COMMAND_ERROR";
}

function safeNonNegativeInteger(value) {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function safeExitCode(value) {
  return Number.isFinite(value) && Number.isInteger(value) ? value : null;
}

const PACKED_COMMAND_RESULT_PROPERTIES = Object.freeze([
  "status",
  "error",
  "signal",
  "stdout",
  "stderr",
]);
const PACKED_DIAGNOSTICS_OPTION_PROPERTIES = Object.freeze([
  "operation",
  "timeoutMs",
  "elapsedMs",
]);

function invalidPackedCommandDiagnostics(errorCode) {
  return Object.freeze({
    operation: "packed-command",
    timeoutMs: null,
    elapsedMs: null,
    timedOut: false,
    exitCode: null,
    errorCode,
    signal: null,
    outputRetention: "metadata_only",
    stdoutPresent: false,
    stderrPresent: false,
    stdoutChars: 0,
    stderrChars: 0,
  });
}

function packedCommandError(message, diagnostics) {
  const error = new Error(message);
  Object.defineProperty(error, "boundedDiagnostics", {
    value: diagnostics,
    enumerable: true,
  });
  return error;
}

function snapshotPackedCommandResult(result) {
  const values = Object.create(null);
  for (const property of PACKED_COMMAND_RESULT_PROPERTIES) {
    const read = readOwnEnumerableDataValue(result, property);
    if (!read.valid) {
      throw packedCommandError(
        "packed command result snapshot is invalid",
        invalidPackedCommandDiagnostics("COMMAND_RESULT_INVALID"),
      );
    }
    values[property] = read.value;
  }
  return Object.freeze({
    status: values.status,
    error: values.error,
    errorCode: snapshotErrorCode(values.error),
    signal: values.signal,
    stdout: values.stdout,
    stderr: values.stderr,
  });
}

function snapshotPackedDiagnosticsOptions(diagnosticsOptions) {
  const values = Object.create(null);
  for (const property of PACKED_DIAGNOSTICS_OPTION_PROPERTIES) {
    const read = readOwnEnumerableDataValue(diagnosticsOptions, property);
    if (!read.valid) {
      throw packedCommandError(
        "packed command diagnostics options are invalid",
        invalidPackedCommandDiagnostics("DIAGNOSTICS_OPTIONS_INVALID"),
      );
    }
    values[property] = read.value;
  }
  if (
    !PACKED_COMMAND_OPERATION_ALLOWLIST.has(values.operation) ||
    safeNonNegativeInteger(values.timeoutMs) === null ||
    safeNonNegativeInteger(values.elapsedMs) === null
  ) {
    throw packedCommandError(
      "packed command diagnostics options are invalid",
      invalidPackedCommandDiagnostics("DIAGNOSTICS_OPTIONS_INVALID"),
    );
  }
  return Object.freeze({
    operation: values.operation,
    timeoutMs: values.timeoutMs,
    elapsedMs: values.elapsedMs,
  });
}

function buildPackedCommandDiagnosticsFromSnapshot(result, options) {
  const stdoutChars = typeof result.stdout === "string" ? result.stdout.length : 0;
  const stderrChars = typeof result.stderr === "string" ? result.stderr.length : 0;
  return Object.freeze({
    operation: options.operation,
    timeoutMs: options.timeoutMs,
    elapsedMs: options.elapsedMs,
    timedOut: result.errorCode === "ETIMEDOUT",
    exitCode: safeExitCode(result.status),
    errorCode: result.errorCode,
    signal: PACKED_COMMAND_SIGNAL_ALLOWLIST.has(result.signal)
      ? result.signal
      : null,
    outputRetention: "metadata_only",
    stdoutPresent: stdoutChars > 0,
    stderrPresent: stderrChars > 0,
    stdoutChars,
    stderrChars,
  });
}

/**
 * Builds metadata-only command evidence without retaining subprocess output or errors.
 */
export function buildPackedCommandDiagnostics(options) {
  const diagnosticsOptions = snapshotPackedDiagnosticsOptions(options);
  const resultRead = readOwnEnumerableDataValue(options, "result");
  if (!resultRead.valid) {
    throw packedCommandError(
      "packed command diagnostics options are invalid",
      invalidPackedCommandDiagnostics("DIAGNOSTICS_OPTIONS_INVALID"),
    );
  }
  const result = snapshotPackedCommandResult(resultRead.value);
  return buildPackedCommandDiagnosticsFromSnapshot(result, diagnosticsOptions);
}

function commandFailure(label, result) {
  const streams = [
    result.stdout ? `stdout:\n${result.stdout}` : null,
    result.stderr ? `stderr:\n${result.stderr}` : null,
  ].filter(Boolean).join("\n");
  const detail = result.error?.message || streams || `exit ${result.status}`;
  return new Error(`${label} failed: ${String(detail).trim()}`);
}

/**
 * Enriches a packed command result with bounded diagnostics and fails closed.
 * The helper is pure so timeout/error behavior can be verified without running
 * the real packed install/update acceptance lane.
 */
export function requirePackedCommandSuccess(
  result,
  diagnosticsOptions,
) {
  const options = snapshotPackedDiagnosticsOptions(diagnosticsOptions);
  const snapshot = snapshotPackedCommandResult(result);
  const boundedDiagnostics = buildPackedCommandDiagnosticsFromSnapshot(
    snapshot,
    options,
  );
  if (
    snapshot.status !== 0 ||
    snapshot.error !== null ||
    snapshot.signal !== null
  ) {
    throw packedCommandError("packed command failed", boundedDiagnostics);
  }
  return Object.freeze({
    status: 0,
    signal: boundedDiagnostics.signal,
    boundedDiagnostics,
  });
}

function requireSuccess(label, result) {
  if (result.status !== 0 || result.error) throw commandFailure(label, result);
  return result;
}

function parseSemver(value) {
  const match = String(value).trim().match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u,
  );
  if (!match) return null;
  return {
    raw: String(value).trim(),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] == null) return -1;
    if (right[index] == null) return 1;
    const leftNumeric = /^\d+$/u.test(left[index]);
    const rightNumeric = /^\d+$/u.test(right[index]);
    if (leftNumeric && rightNumeric) {
      const delta = Number(left[index]) - Number(right[index]);
      if (delta !== 0) return Math.sign(delta);
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    const delta = left[index].localeCompare(right[index], "en");
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

function compareSemver(left, right) {
  for (const field of ["major", "minor", "patch"]) {
    const delta = left[field] - right[field];
    if (delta !== 0) return Math.sign(delta);
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function tagSemver(tag) {
  return parseSemver(String(tag).replace(/^v/u, ""));
}

export function selectHistoricalUpdateRef({ currentVersion, tags, overrideRef = null }) {
  const currentSemver = parseSemver(currentVersion);
  if (!currentSemver) {
    throw new Error(`current package version is not valid semver: ${currentVersion}`);
  }
  const candidates = tags
    .map((tag) => ({ tag, semver: tagSemver(tag) }))
    .filter((candidate) => candidate.semver && candidate.semver.prerelease.length === 0)
    .filter((candidate) => compareSemver(candidate.semver, currentSemver) < 0)
    .sort((left, right) =>
      compareSemver(right.semver, left.semver) || left.tag.localeCompare(right.tag, "en"),
    );
  if (overrideRef) {
    const overridden = candidates.find((candidate) => candidate.tag === overrideRef);
    if (!overridden) {
      throw new Error(
        `${HISTORICAL_REF_ENV_KEY} must name an existing lower stable semver tag: ${overrideRef}`,
      );
    }
    return overridden;
  }
  if (!candidates[0]) {
    throw new Error(`no prior stable release tag exists below ${currentVersion}`);
  }
  return candidates[0];
}

export function assertCurrentVersionTagAbsent({
  repoRoot = process.cwd(),
  environment = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const currentVersion = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ).version;
  if (!parseSemver(currentVersion)) {
    throw new Error(`current package version is not valid semver: ${currentVersion}`);
  }
  const exactTag = `v${currentVersion}`;
  const exactRef = `refs/tags/${exactTag}`;
  const result = run("git", ["show-ref", "--verify", "--quiet", exactRef], {
    cwd: repoRoot,
    env: environment,
    timeoutMs,
  });
  if (result.error || ![0, 1].includes(result.status)) {
    throw commandFailure(`check current package version tag ${exactRef}`, result);
  }
  if (result.status === 0) {
    throw new Error(
      `current package version tag already exists: ${exactTag}; bump package.version before release-grade verification`,
    );
  }
  return {
    status: "passed",
    currentVersion,
    exactTag,
    exactRef,
    currentVersionTagAbsent: true,
    checkMethod: "git_show_ref_verify_quiet_exact_ref",
  };
}

function readTaggedPackageVersion(repoRoot, tag, environment, timeoutMs) {
  const result = requireSuccess(
    `read ${tag} package version`,
    run("git", ["show", `${tag}:package.json`], {
      cwd: repoRoot,
      env: environment,
      timeoutMs,
    }),
  );
  return JSON.parse(result.stdout).version;
}

export function resolveHistoricalUpdateRef({
  repoRoot = process.cwd(),
  environment = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  overrideRef = environment[HISTORICAL_REF_ENV_KEY] ?? null,
} = {}) {
  const currentVersion = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ).version;
  const tagResult = requireSuccess(
    "list release tags for packed historical acceptance",
    run("git", ["tag", "--list"], { cwd: repoRoot, env: environment, timeoutMs }),
  );
  const tags = tagResult.stdout.split(/\r?\n/u).map((tag) => tag.trim()).filter(Boolean);
  const selected = selectHistoricalUpdateRef({ currentVersion, tags, overrideRef });
  const taggedVersion = readTaggedPackageVersion(
    repoRoot,
    selected.tag,
    environment,
    timeoutMs,
  );
  if (taggedVersion !== selected.semver.raw) {
    throw new Error(
      `release tag ${selected.tag} points to package version ${taggedVersion}, expected ${selected.semver.raw}`,
    );
  }
  return {
    ref: selected.tag,
    version: selected.semver.raw,
    currentVersion,
    source: overrideRef ? "validated_env_override" : "highest_prior_stable_semver_tag",
  };
}

function parsePackResult(result) {
  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || !parsed[0]?.filename) {
    throw new Error("npm pack did not return a tarball filename");
  }
  return parsed[0].filename;
}

function resolvePackedCliPath(workspace) {
  const packageManifest = JSON.parse(
    readFileSync(path.join(workspace, "package.json"), "utf8"),
  );
  const cliName = resolvePackageCliName(packageManifest);
  const cliRelativePath = packageManifest.bin[cliName];
  const portableCliRelativePath = typeof cliRelativePath === "string"
    ? cliRelativePath.replaceAll("\\", "/")
    : "";
  if (
    !portableCliRelativePath ||
    path.isAbsolute(cliRelativePath) ||
    path.win32.isAbsolute(cliRelativePath) ||
    portableCliRelativePath === ".." ||
    portableCliRelativePath.startsWith("../")
  ) {
    throw new Error(`packed candidate CLI ${cliName} must resolve to a relative file`);
  }
  const cliPath = path.resolve(workspace, cliRelativePath);
  const cliPathFromWorkspace = path.relative(workspace, cliPath);
  if (
    cliPathFromWorkspace === ".." ||
    cliPathFromWorkspace.startsWith(`..${path.sep}`) ||
    path.isAbsolute(cliPathFromWorkspace)
  ) {
    throw new Error(`packed candidate CLI ${cliName} escapes the package root`);
  }
  if (!existsSync(cliPath) || !statSync(cliPath).isFile()) {
    throw new Error(`packed candidate is missing its declared CLI bin: ${cliName}`);
  }
  return cliPath;
}

function packAndExtract({ sourceRoot, destinationRoot, environment, timeoutMs }) {
  const packDir = path.join(destinationRoot, "pack");
  const extractDir = path.join(destinationRoot, "extract");
  mkdirSync(packDir, { recursive: true });
  mkdirSync(extractDir, { recursive: true });
  const packed = requireSuccess(
    "npm pack",
    runCli("npm", ["pack", "--json", "--pack-destination", packDir], {
      cwd: sourceRoot,
      env: environment,
      timeoutMs,
    }),
  );
  const tarball = path.join(packDir, parsePackResult(packed));
  requireSuccess(
    "candidate tar extraction",
    run("tar", ["-xf", tarball, "-C", extractDir], {
      cwd: sourceRoot,
      env: environment,
      timeoutMs,
    }),
  );
  const workspace = path.join(extractDir, "package");
  resolvePackedCliPath(workspace);
  return {
    sourceRoot,
    workspace,
    extractDir,
    tarball,
    tarballSha256: sha256(readFileSync(tarball)),
  };
}

function isolatedEnvironment(baseEnvironment, roots) {
  const allowed = [
    "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec",
    "LANG", "LC_ALL", "TERM", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  ];
  const env = Object.fromEntries(
    allowed
      .filter((key) => baseEnvironment[key] !== undefined)
      .map((key) => [key, baseEnvironment[key]]),
  );
  const isolated = {
    ...env,
    HOME: roots.userHome,
    USERPROFILE: roots.userHome,
    TMP: roots.tempDir,
    TEMP: roots.tempDir,
    CLAUDE_CONFIG_DIR: roots.claudeHome,
    CLAUDE_SKILLS_DIR: path.join(roots.claudeHome, "skills"),
    CODEX_SKILLS_DIR: path.join(roots.codexHome, "skills"),
    META_KIM_SKIP_OPTIONAL_TOOLS: "1",
    META_KIM_WITH_GLOBAL_HOOKS: "0",
    META_KIM_PREFER_LOCAL_DEPENDENCIES: "1",
    META_KIM_LOCAL_DEPENDENCY_ROOT: roots.localDependencyRoot,
    NPM_CONFIG_CACHE: roots.npmCache,
    npm_config_cache: roots.npmCache,
  };
  for (const [targetId, profile] of Object.entries(PACKED_RUNTIME_PROFILES)) {
    const runtimeHome = roots.runtimeHomes[targetId];
    for (const envKey of profile.activation.envKeys) {
      isolated[envKey] = runtimeHome;
    }
  }
  return isolated;
}

function makeIsolatedRoots(root, name) {
  const laneRoot = path.join(root, name);
  const userHome = path.join(laneRoot, "user-home");
  const runtimeHomes = Object.fromEntries(
    Object.entries(PACKED_RUNTIME_PROFILES).map(([targetId, profile]) => [
      targetId,
      path.join(userHome, profile.activation.defaultHomeDir),
    ]),
  );
  const roots = {
    laneRoot,
    userHome,
    runtimeHomes,
    claudeHome: runtimeHomes.claude,
    codexHome: runtimeHomes.codex,
    cursorHome: runtimeHomes.cursor,
    openclawHome: runtimeHomes.openclaw,
    tempDir: path.join(laneRoot, "tmp"),
    ordinaryCwd: path.join(laneRoot, "ordinary-project"),
    projectDir: path.join(laneRoot, "governed-project"),
    localDependencyRoot: path.join(laneRoot, "local-dependencies"),
    cliPrefix: path.join(laneRoot, "installed-cli"),
    npmCache: path.join(laneRoot, "npm-cache"),
  };
  for (const directory of Object.values(roots).filter((value) => typeof value === "string")) {
    mkdirSync(directory, { recursive: true });
  }
  const planningFixture = path.join(roots.localDependencyRoot, "planning-with-files");
  mkdirSync(path.join(planningFixture, ".git"), { recursive: true });
  mkdirSync(path.join(planningFixture, "skills", "planning-with-files"), {
    recursive: true,
  });
  writeFileSync(
    path.join(planningFixture, "skills", "planning-with-files", "SKILL.md"),
    "---\nname: planning-with-files\ndescription: Deterministic packed acceptance fixture.\n---\n\n# Planning with Files\n",
    "utf8",
  );
  writeFileSync(path.join(roots.ordinaryCwd, "user-owned.txt"), "user-owned\n", "utf8");
  return roots;
}

function packedCliDescriptor(packageInfo, roots, globalNodeModules) {
  const packageManifest = JSON.parse(
    readFileSync(path.join(packageInfo.workspace, "package.json"), "utf8"),
  );
  const distribution = JSON.parse(
    readFileSync(
      path.join(packageInfo.workspace, "config", "distribution.json"),
      "utf8",
    ),
  );
  const identity = resolvePortableMetaKimPackageIdentity(
    packageManifest,
    distribution,
  );
  const binName = identity.cliName;
  const packageSegments = identity.packageName.split("/").filter(Boolean);
  const installedPackageRoot = path.join(globalNodeModules, ...packageSegments);
  const relativeToPrefix = path.relative(roots.cliPrefix, installedPackageRoot);
  if (
    relativeToPrefix === ".." ||
    relativeToPrefix.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToPrefix)
  ) {
    throw new Error("isolated packed CLI package root escaped its install prefix");
  }
  const installedPackageManifestPath = path.join(installedPackageRoot, "package.json");
  if (!existsSync(installedPackageManifestPath)) {
    throw new Error("isolated packed CLI package manifest is missing after npm install");
  }
  const installedPackageManifest = JSON.parse(
    readFileSync(installedPackageManifestPath, "utf8"),
  );
  const installedCliPath = path.resolve(
    installedPackageRoot,
    installedPackageManifest.bin?.[binName] ?? "",
  );
  if (!existsSync(installedCliPath) || !statSync(installedCliPath).isFile()) {
    throw new Error(`isolated packed CLI package is missing its declared bin: ${binName}`);
  }
  const durableLayout = resolveDurableMetaKimRuntimeLayout(
    roots.userHome,
    identity,
    packageManifest,
  );
  const packedCliPath = path.resolve(
    packageInfo.workspace,
    packageManifest.bin[binName],
  );
  const binDir = process.platform === "win32"
    ? roots.cliPrefix
    : path.join(roots.cliPrefix, "bin");
  const command = process.platform === "win32"
    ? path.join(binDir, `${binName}.cmd`)
    : path.join(binDir, binName);
  return {
    binName,
    binDir,
    command,
    globalNodeModules,
    installedPackageRoot,
    installedPackageManifestPath,
    installedCliPath,
    identity,
    durableLayout,
    packedCliSha256: sha256(readFileSync(installedCliPath)),
    extractedCliSha256: sha256(readFileSync(packedCliPath)),
  };
}

function installPackedCli(packageInfo, roots, env, timeoutMs) {
  requireSuccess(
    "packed candidate isolated global CLI install",
    runCli(
      "npm",
      [
        "install",
        "--global",
        "--prefix",
        roots.cliPrefix,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        packageInfo.tarball,
      ],
      { cwd: roots.laneRoot, env, timeoutMs },
    ),
  );
  const globalRoot = requireSuccess(
    "resolve isolated packed CLI global package root",
    runCli(
      "npm",
      ["root", "--global", "--prefix", roots.cliPrefix],
      { cwd: roots.laneRoot, env, timeoutMs },
    ),
  ).stdout.trim();
  if (!globalRoot || !path.isAbsolute(globalRoot)) {
    throw new Error("npm did not return an absolute isolated global package root");
  }
  const descriptor = packedCliDescriptor(packageInfo, roots, globalRoot);
  if (!existsSync(descriptor.command)) {
    throw new Error(`isolated packed CLI bin is missing: ${descriptor.binName}`);
  }
  if (descriptor.packedCliSha256 !== descriptor.extractedCliSha256) {
    throw new Error("installed packed CLI bytes differ from the npm tarball candidate");
  }
  const pathKey = Object.hasOwn(env, "Path") ? "Path" : "PATH";
  const pathValue = env[pathKey] ?? env.PATH ?? env.Path ?? "";
  env[pathKey] = [descriptor.binDir, pathValue].filter(Boolean).join(path.delimiter);
  env.PATH = env[pathKey];
  return descriptor;
}

function canonicalAgentIds(workspace) {
  const agentsDir = path.join(workspace, "canonical", "agents");
  return readdirSync(agentsDir)
    .filter((fileName) => fileName.endsWith(".md"))
    .map((fileName) => fileName.slice(0, -3))
    .sort();
}

function expectedGlobalAgentArtifacts(
  roots,
  agentIds,
  targetProjections = PACKED_GLOBAL_AGENT_TARGETS,
) {
  return Object.fromEntries(
    targetProjections.flatMap((target) =>
      agentIds.map((agentId) => [
        `${target.targetId}Agent:${agentId}`,
        path.join(
          roots.runtimeHomes[target.targetId],
          target.agentsDir,
          globalAgentProjectionFileName(target, agentId),
        ),
      ]),
    ),
  );
}

function seedPortableRuntimeUserState(
  roots,
  agentIds,
  targetProjections = PACKED_GLOBAL_AGENT_TARGETS,
) {
  const userAgentId = "user-owned-runtime-agent";
  if (agentIds.includes(userAgentId)) {
    throw new Error("portable acceptance user Agent fixture collides with a canonical Agent");
  }
  const fixtureAgent = {
    id: userAgentId,
    description: "Preserve this user-owned runtime Agent.",
    sourceFile: "user-owned-runtime-agent.md",
    title: "User-owned runtime Agent",
    summary: "User-owned runtime state must be preserved.",
    role: "preserve",
    raw: `---\nname: ${userAgentId}\ndescription: "Preserve this user-owned runtime Agent."\n---\n\n# User-owned runtime Agent\n`,
    body: "# User-owned runtime Agent\n",
  };
  const userAgents = targetProjections.map((target) => {
    const targetPath = path.join(
      roots.runtimeHomes[target.targetId],
      target.agentsDir,
      globalAgentProjectionFileName(target, userAgentId),
    );
    const content = renderGlobalAgentProjection(fixtureAgent, target);
    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, content, "utf8");
    return { targetId: target.targetId, path: targetPath, content };
  });

  const claudeSettingsPath = path.join(roots.claudeHome, "settings.json");
  const userHookCommand = "node user-owned-hook.mjs";
  writeFileSync(
    claudeSettingsPath,
    `${JSON.stringify({
      userPreference: { preserve: true },
      hooks: {
        SessionStart: [
          { matcher: "*", hooks: [{ type: "command", command: userHookCommand }] },
        ],
      },
    }, null, 2)}\n`,
    "utf8",
  );

  const claudeUserConfigPath = path.join(roots.userHome, ".claude.json");
  const legacyPackageRoot = path.join(roots.laneRoot, "retired-package-root");
  const unknownServer = {
    command: "user-owned-mcp-command",
    args: ["--preserve"],
    env: { USER_OWNED_ENV: "preserve" },
  };
  const auth = { provider: "user-owned", profile: "preserve" };
  writeFileSync(
    claudeUserConfigPath,
    `${JSON.stringify({
      auth,
      unknownUserField: { preserve: true },
      mcpServers: {
        "user-owned-server": unknownServer,
        meta_kim_runtime: {
          type: "stdio",
          command: "cmd",
          args: [
            "/c",
            process.execPath,
            path.join(legacyPackageRoot, "scripts", "mcp", "meta-runtime-server.mjs"),
          ],
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  return {
    runtimeBaseDir: roots.userHome,
    userAgentId,
    userAgents,
    claudeSettingsPath,
    userHookCommand,
    claudeUserConfigPath,
    legacyPackageRoot,
    unknownServer,
    auth,
  };
}

export function durableMcpDefinitionMatches(
  definition,
  expectedDefinition,
) {
  return mcpDefinitionFingerprint(definition) ===
    mcpDefinitionFingerprint(expectedDefinition);
}

function isPathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

function valueReferencesRoot(value, root) {
  const normalizedValue = String(value ?? "").replaceAll("\\", "/").toLowerCase();
  const normalizedRoot = path.resolve(root).replaceAll("\\", "/").toLowerCase();
  return normalizedValue.includes(normalizedRoot);
}

function repositoryIndependentEnvironment(environment, forbiddenRoots) {
  const portable = { ...environment };
  for (const key of ["PATH", "Path"]) {
    if (typeof portable[key] !== "string") continue;
    portable[key] = portable[key]
      .split(path.delimiter)
      .filter((entry) => !forbiddenRoots.some((root) => valueReferencesRoot(entry, root)))
      .join(path.delimiter);
  }
  for (const [key, value] of Object.entries(portable)) {
    if (["PATH", "Path"].includes(key)) continue;
    if (forbiddenRoots.some((root) => valueReferencesRoot(value, root))) delete portable[key];
  }
  if (Object.values(portable).some((value) => forbiddenRoots.some((root) => valueReferencesRoot(value, root)))) {
    throw new Error("installed-product environment still references the repository or candidate workspace");
  }
  return portable;
}

function requireDurableMcpServer(
  config,
  seeded,
  forbiddenRoots,
  descriptor,
) {
  if (config.mcpServers?.meta_kim_runtime) {
    throw new Error("packed update did not migrate the legacy meta_kim_runtime MCP alias");
  }
  const server = config.mcpServers?.["meta-kim-runtime"];
  if (!server || typeof server.command !== "string" || !Array.isArray(server.args)) {
    throw new Error("packed update did not register canonical meta-kim-runtime MCP server");
  }
  if (!durableMcpDefinitionMatches(server, descriptor.durableLayout.definition)) {
    throw new Error(
      "durable Meta_Kim MCP registration does not match the shared runtime layout strategy",
    );
  }
  if (JSON.stringify(config.mcpServers?.["user-owned-server"]) !== JSON.stringify(seeded.unknownServer)) {
    throw new Error("packed update changed an unknown user MCP server");
  }
  if (JSON.stringify(config.auth) !== JSON.stringify(seeded.auth)) {
    throw new Error("packed update changed unknown Claude auth state");
  }
  if (config.unknownUserField?.preserve !== true) {
    throw new Error("packed update changed unknown Claude user configuration");
  }
  const { durableLayout, identity, packedCliSha256 } = descriptor;
  if (!isPathWithin(seeded.runtimeBaseDir, durableLayout.bundleDir)) {
    throw new Error("durable Meta_Kim MCP runtime escaped the isolated user home");
  }
  for (const requiredPath of [
    durableLayout.packageManifestPath,
    durableLayout.cliPath,
    durableLayout.serverPath,
  ]) {
    if (!existsSync(requiredPath)) {
      throw new Error(`durable Meta_Kim MCP runtime is incomplete: ${path.basename(requiredPath)}`);
    }
  }
  const installedManifest = JSON.parse(
    readFileSync(durableLayout.packageManifestPath, "utf8"),
  );
  if (
    installedManifest.name !== identity.packageName ||
    installedManifest.version !== identity.packageVersion ||
    installedManifest.bin?.[identity.cliName] === undefined
  ) {
    throw new Error("durable Meta_Kim MCP runtime package identity does not match the packed candidate");
  }
  if (sha256(readFileSync(durableLayout.cliPath)) !== packedCliSha256) {
    throw new Error("durable Meta_Kim MCP runtime CLI does not match the packed candidate");
  }
  assertPortablePackedReferences(server, { forbiddenRoots });
  return server;
}

function runPortableRuntimePreparation({ packageInfo, descriptor, roots, env, timeoutMs }) {
  requireInstalledCliDescriptor(descriptor);
  const agentIds = canonicalAgentIds(descriptor.installedPackageRoot);
  const agentTargetIds = PACKED_GLOBAL_AGENT_TARGETS.map(
    (target) => target.targetId,
  );
  const runtimeTargetIds = [...PACKED_USER_TARGETS];
  const seeded = seedPortableRuntimeUserState(
    roots,
    agentIds,
    PACKED_GLOBAL_AGENT_TARGETS,
  );
  const hookEnv = { ...env, META_KIM_WITH_GLOBAL_HOOKS: "1" };
  requireSuccess(
    "packed installed CLI global runtime update",
    runCli(
      descriptor.command,
      [
        "update",
        "--silent",
        "--scope",
        "global",
        "--targets",
        runtimeTargetIds.join(","),
        "--skills",
        ACCEPTANCE_SKILL_FILTER,
        "--with-global-hooks",
      ],
      { cwd: roots.ordinaryCwd, env: hookEnv, timeoutMs },
    ),
  );

  const agentProof = artifactFingerprint(
    expectedGlobalAgentArtifacts(roots, agentIds, PACKED_GLOBAL_AGENT_TARGETS),
  );
  for (const userAgent of seeded.userAgents) {
    if (readFileSync(userAgent.path, "utf8") !== userAgent.content) {
      throw new Error(
        `packed global update changed an unknown ${userAgent.targetId} Agent`,
      );
    }
  }

  const settings = JSON.parse(readFileSync(seeded.claudeSettingsPath, "utf8"));
  if (!JSON.stringify(settings.hooks ?? {}).includes(seeded.userHookCommand)) {
    throw new Error("packed global Hook update removed an unknown user Hook");
  }
  const config = JSON.parse(readFileSync(seeded.claudeUserConfigPath, "utf8"));
  const forbiddenRoots = [
    packageInfo.sourceRoot,
    packageInfo.workspace,
    seeded.legacyPackageRoot,
  ];
  const server = requireDurableMcpServer(
    config,
    seeded,
    forbiddenRoots,
    descriptor,
  );
  const ownershipProof = verifyGlobalProjectionOwnership(
    path.join(roots.userHome, ".meta-kim", "install-manifest.json"),
    roots,
    agentIds,
    { runtimeTargetIds, agentTargets: PACKED_GLOBAL_AGENT_TARGETS },
  );
  return {
    proof: {
      status: "prepared",
      agentProjection: {
        status: "passed",
        canonicalAgentCount: agentIds.length,
        runtimeTargets: agentTargetIds,
        projectedArtifactCount: Object.keys(agentProof).length,
        unknownAgentsPreserved: true,
      },
      ownershipManifest: ownershipProof,
      hookProjection: {
        status: "passed",
        globalHookAuthorization: "explicit",
        unknownHookPreserved: true,
      },
      mcpRegistration: {
        status: "passed",
        canonicalServerId: "meta-kim-runtime",
        legacyAliasMigrated: true,
        unknownServerEnvAndAuthPreserved: true,
        invocation: {
          command: server.command,
          args: [...server.args],
        },
      },
      portability: { status: "passed", unresolvedPlaceholderCount: 0 },
    },
    context: {
      descriptor,
      hookEnv,
      roots,
      seeded,
      server,
      forbiddenRoots,
      runtimeTargetIds,
    },
  };
}

function copyPreservingPath(source, target) {
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
}

export function copyRuntimeCapabilityObservationSnapshot({ sourceProjectRoot, targetProjectRoot, sourceUserHome = os.homedir(), targetUserHome, profile = "default" } = {}) {
  const effective = loadEffectiveRuntimeCapabilityClaims({ projectRoot: sourceProjectRoot, profile });
  assertExactStandardRuntimeObservationSet(effective.overlayStatus.applied);
  const store = loadRuntimeCapabilityAcceptanceAttempts({ projectRoot: sourceProjectRoot, profile });
  const sourceProfile = store.paths.profileRoot;
  const targetProfile = path.join(targetProjectRoot, ".meta-kim", "state", profile);
  mkdirSync(targetProfile, { recursive: true });
  writeFileSync(path.join(targetProfile, "project-bootstrap.json"), "{}\n", "utf8");
  const copied = [];
  for (const binding of effective.overlayStatus.applied) {
    const attempt = store.attempts.find((entry) => entry.attemptId === binding.attemptId);
    if (!attempt || attempt.releaseGrade === true) throw new Error("packed snapshot requires original non-releaseGrade host observations");
    const attemptSource = path.join(store.paths.attemptsDir, `${attempt.attemptId}.json`);
    const attemptTarget = path.join(targetProfile, "runtime-capability-acceptance", "attempts", `${attempt.attemptId}.json`);
    copyPreservingPath(attemptSource, attemptTarget);
    const receiptSource = path.resolve(sourceProfile, attempt.sourceReport.path);
    const receiptTarget = path.resolve(targetProfile, attempt.sourceReport.path);
    copyPreservingPath(receiptSource, receiptTarget);
    const receipt = JSON.parse(readFileSync(receiptSource, "utf8"));
    copyPreservingPath(path.resolve(sourceProfile, receipt.rawArtifact.path), path.resolve(targetProfile, receipt.rawArtifact.path));
    for (const ref of [receipt.compositeLifecycle?.parentSessionRef, receipt.compositeLifecycle?.childSessionRef].filter(Boolean)) {
      copyPreservingPath(path.join(sourceUserHome, ".codex", "sessions", ref), path.join(targetUserHome, ".codex", "sessions", ref));
    }
    copied.push({ runtime: attempt.runtime, capability: attempt.capability, mode: attempt.mode, attemptId: attempt.attemptId, receiptSha256: attempt.sourceReport.sha256 });
  }
  assertExactStandardRuntimeObservationSet(copied);
  writeFileSync(path.join(targetProfile, "runtime-capability-acceptance", "advisory-snapshot.json"), `${JSON.stringify({
    schemaVersion: "meta-kim-runtime-advisory-snapshot-v1",
    evidenceClass: "read_only_advisory_snapshot",
    observedInCurrentRun: false,
    executionAuthority: false,
    bindings: copied,
  }, null, 2)}\n`, "utf8");
  return { evidenceClass: "read_only_advisory_snapshot", observedInCurrentRun: false, executionAuthority: false, count: copied.length, bindings: copied };
}

export function assertPackedAdvisoryEffectiveMatrix(actualMatrix, expectedMatrix, effectiveState) {
  assertExactRuntimeCapabilityMatrix(
    effectiveState.baselineMatrix,
    expectedMatrix,
    "packed MCP advisory baseline matrix",
  );
  return assertExactRuntimeCapabilityMatrix(
    actualMatrix,
    effectiveState.effectiveMatrix,
    "packed MCP advisory effective matrix",
  );
}

function probePackedMcpTransport(server, context, timeoutMs, { projectCwd = context.roots.ordinaryCwd, expectedObservationCount = 10 } = {}) {
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "meta-kim-packed-acceptance", version: "1.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_meta_runtime_capabilities", arguments: {} },
    },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_meta_runtime_evidence", arguments: {} } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_meta_effective_runtime_capabilities", arguments: {} } },
  ];
  const result = runCli(server.command, server.args, {
    cwd: projectCwd,
    env: { ...context.hookEnv, ...(server.env ?? {}) },
    timeoutMs,
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
  });
  requireSuccess("packed durable CLI MCP transport", result);
  const responses = String(result.stdout ?? "")
    .split(/\r?\n/u)
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line));
  const tools = responses.find((response) => response.id === 2)?.result?.tools ?? [];
  const call = responses.find((response) => response.id === 3);
  const evidenceCall = responses.find((response) => response.id === 4);
  const effectiveCall = responses.find((response) => response.id === 5);
  for (const requiredTool of ["get_meta_runtime_capabilities", "get_meta_runtime_evidence", "get_meta_effective_runtime_capabilities"]) {
    if (!tools.some((tool) => tool.name === requiredTool)) {
      throw new Error(`packed durable CLI MCP transport did not expose ${requiredTool}`);
    }
  }
  if (!tools.some((tool) => tool.name === "get_meta_runtime_capabilities")) {
    throw new Error("packed durable CLI MCP transport did not expose Meta_Kim tools");
  }
  if (!call?.result || call.error) {
    throw new Error("packed durable CLI MCP transport tool call did not succeed");
  }
  const textContent = call.result.content?.filter(
    (entry) => entry?.type === "text" && typeof entry.text === "string",
  ) ?? [];
  if (textContent.length !== 1) {
    throw new Error(
      "packed durable CLI MCP capability call must return exactly one text payload",
    );
  }
  let capabilityPayload;
  try {
    capabilityPayload = JSON.parse(textContent[0].text);
  } catch (error) {
    throw new Error(
      `packed durable CLI MCP capability payload is not JSON: ${error.message}`,
    );
  }
  const expectedMatrixPath = path.join(
    context.descriptor.installedPackageRoot,
    "config",
    "runtime-capability-matrix.json",
  );
  const expectedMatrix = validateRuntimeCapabilityMatrix(
    JSON.parse(
      readFileSync(
        expectedMatrixPath,
        "utf8",
      ),
    ),
    expectedMatrixPath,
  );
  assertExactRuntimeCapabilityMatrix(
    capabilityPayload,
    expectedMatrix,
    "packed durable CLI MCP capability matrix",
  );
  const evidenceText = evidenceCall?.result?.content?.find((entry) => entry?.type === "text")?.text;
  const expectedLedgerPath = path.join(context.descriptor.installedPackageRoot, "config", "runtime-capability-evidence.json");
  const evidencePayload = parseRuntimeCapabilityEvidenceLedger(evidenceText, "packed MCP evidence response");
  const expectedLedger = parseRuntimeCapabilityEvidenceLedger(readFileSync(expectedLedgerPath, "utf8"), expectedLedgerPath);
  if (JSON.stringify(evidencePayload) !== JSON.stringify(expectedLedger)) throw new Error("packed MCP evidence ledger does not match packaged source");
  const effectiveText = effectiveCall?.result?.content?.find((entry) => entry?.type === "text")?.text;
  const effectivePayload = JSON.parse(effectiveText);
  if (effectivePayload.executionAuthority !== false || effectivePayload.observedInCurrentRun !== false || effectivePayload.currentHostAdapter !== "unavailable_over_mcp_resource_read") {
    throw new Error("packed MCP advisory readback incorrectly exposed current-run execution authority");
  }
  const expectedEffectiveState = loadEffectiveRuntimeCapabilityClaims({
    packageRoot: context.descriptor.installedPackageRoot,
    projectRoot: projectCwd,
    profile: "default",
  });
  assertPackedAdvisoryEffectiveMatrix(
    effectivePayload.matrix,
    expectedMatrix,
    expectedEffectiveState,
  );
  if (!Array.isArray(effectivePayload.results) || !Array.isArray(effectivePayload.missing) || effectivePayload.results.length !== expectedObservationCount || effectivePayload.missing.length !== 10 - expectedObservationCount) {
    throw new Error("packed MCP effective status did not return the exact results/missing partition");
  }
  if (expectedObservationCount === 10) {
    assertExactStandardRuntimeObservationSet(effectivePayload.results);
  } else if (expectedObservationCount === 0) {
    assertExactStandardRuntimeObservationSet(effectivePayload.missing);
  }
  if ((effectivePayload.overlayStatus?.applied?.length ?? 0) !== expectedObservationCount || effectivePayload.overlayStatus?.applied?.some((entry) => entry.executionAuthority !== false || entry.observedInCurrentRun !== false)) {
    throw new Error("packed MCP effective matrix did not expose the expected advisory observation snapshot");
  }
  if (JSON.stringify(effectivePayload.matrix).includes('"routeEligibility":"executable"')) throw new Error("packed MCP advisory observations became executable");
  const serializedCapabilities = JSON.stringify(capabilityPayload).toLowerCase();
  if (
    serializedCapabilities.includes("stub") ||
    serializedCapabilities.includes("docs/runtime-capability-matrix.md")
  ) {
    throw new Error("packed durable CLI MCP capabilities returned a stub payload");
  }
  return {
    status: "passed",
    evidenceTier: "packed_isolated_transport",
    liveHostInvocation: false,
    toolListed: "get_meta_runtime_capabilities",
    toolCallSucceeded: true,
    semanticMatrixMatched: true,
    staticEvidenceMatched: true,
    projectOverlayObserved: expectedObservationCount > 0,
    observationCount: effectivePayload.results.length,
    missingCount: effectivePayload.missing.length,
    executionAuthority: effectivePayload.executionAuthority,
    observedInCurrentRun: effectivePayload.observedInCurrentRun,
    currentHostAdapter: effectivePayload.currentHostAdapter,
    externalOverlayStayedNonExecutable: true,
    platformCount: capabilityPayload.platforms.length,
    stubFree: true,
  };
}

function finalizePortableRuntimeProof(prepared, packageInfo, timeoutMs) {
  rmSync(packageInfo.extractDir, { recursive: true, force: true });
  rmSync(path.dirname(packageInfo.tarball), { recursive: true, force: true });
  if (existsSync(packageInfo.workspace)) {
    throw new Error("packed extraction directory still exists before MCP portability proof");
  }
  if (existsSync(packageInfo.tarball)) {
    throw new Error("packed tarball still exists before installed-product checks");
  }
  const { descriptor, hookEnv, roots, runtimeTargetIds } = prepared.context;
  const forbiddenExecutionRoots = [packageInfo.sourceRoot, packageInfo.workspace, packageInfo.extractDir, path.dirname(packageInfo.tarball)];
  if (forbiddenExecutionRoots.some((root) => valueReferencesRoot(roots.ordinaryCwd, root))) {
    throw new Error("installed-product working directory still depends on the repository or candidate workspace");
  }
  const portableHookEnv = repositoryIndependentEnvironment(hookEnv, forbiddenExecutionRoots);
  prepared.context.hookEnv = portableHookEnv;
  const authority = currentProjectionPackageAuthority(
    path.join(roots.userHome, ".meta-kim", "install-manifest.json"),
    descriptor,
  );
  requireSuccess(
    "installed packed global runtime exact projection check after candidate removal",
    run(process.execPath, [
      path.join(authority.packageRoot, "scripts", "sync-runtimes.mjs"),
      "--check",
      "--scope",
      "global",
      "--targets",
      runtimeTargetIds.join(","),
      "--json",
    ], { cwd: roots.ordinaryCwd, env: portableHookEnv, timeoutMs }),
  );
  requireSuccess(
    "installed packed global Hook release check after candidate removal",
    run(process.execPath, [
      path.join(authority.packageRoot, "scripts", "sync-global-meta-theory.mjs"),
      "--check",
      "--targets",
      runtimeTargetIds.join(","),
      "--with-global-hooks",
    ], { cwd: roots.ordinaryCwd, env: portableHookEnv, timeoutMs }),
  );
  const config = JSON.parse(readFileSync(prepared.context.seeded.claudeUserConfigPath, "utf8"));
  const forbiddenRoots = [packageInfo.workspace, ...prepared.context.forbiddenRoots];
  const server = requireDurableMcpServer(
    config,
    prepared.context.seeded,
    forbiddenRoots,
    prepared.context.descriptor,
  );
  const populatedStatus = requireSuccess("installed packed CLI advisory observation status", runCli(descriptor.command, ["runtime", "status", "--require-fresh"], { cwd: roots.ordinaryCwd, env: portableHookEnv, timeoutMs }));
  const populatedPayload = JSON.parse(populatedStatus.stdout);
  assertExactStandardRuntimeObservationSet(populatedPayload.results);
  if (populatedPayload.results.length !== 10 || populatedPayload.executionAuthority !== false || populatedPayload.observedInCurrentRun !== false) throw new Error("installed packed CLI did not preserve exactly 10 advisory observations");
  const emptyProject = path.join(roots.userHome, "empty-runtime-observation-project");
  mkdirSync(path.join(emptyProject, ".meta-kim", "state", "default"), { recursive: true });
  writeFileSync(path.join(emptyProject, ".meta-kim", "state", "default", "project-bootstrap.json"), "{}\n", "utf8");
  const emptyStatus = runCli(descriptor.command, ["runtime", "status", "--require-fresh"], { cwd: emptyProject, env: portableHookEnv, timeoutMs });
  if (emptyStatus.status === 0) throw new Error("empty packed project runtime status unexpectedly succeeded");
  const emptyPayload = JSON.parse(emptyStatus.stdout);
  assertExactStandardRuntimeObservationSet(emptyPayload.missing);
  if (emptyPayload.missing.length !== 10 || JSON.stringify(emptyPayload).includes(packageInfo.sourceRoot)) throw new Error("empty packed project status did not report exact sanitized 10-item absence");
  const populatedMcpTransport = probePackedMcpTransport(server, prepared.context, timeoutMs, { expectedObservationCount: 10 });
  const emptyMcpTransport = probePackedMcpTransport(server, prepared.context, timeoutMs, { projectCwd: emptyProject, expectedObservationCount: 0 });
  return {
    ...prepared.proof,
    status: "passed",
    populatedMcpTransport,
    emptyMcpTransport,
    advisorySnapshot: prepared.context.advisorySnapshot,
    portability: {
      status: "passed",
      packExtractionDeletedBeforeTransport: true,
      tarballDeletedBeforeInstalledChecks: true,
      candidateExtractionUnavailable: true,
      candidateTarballUnavailable: true,
      repoIndependentCwd: true,
      repoIndependentEnvironment: true,
      installedPackageChecksAfterCandidateRemoval: true,
      unresolvedPlaceholderCount: 0,
      forbiddenRootReferenceCount: 0,
    },
  };
}

function expectedProjectArtifacts(projectDir) {
  return {
    agentsGuide: path.join(projectDir, "AGENTS.md"),
    claudeGuide: path.join(projectDir, "CLAUDE.md"),
    claudeSettings: path.join(projectDir, ".claude", "settings.json"),
    mcpConfig: path.join(projectDir, ".mcp.json"),
    codexHooks: path.join(projectDir, ".codex", "hooks.json"),
    projectSkill: path.join(projectDir, ".agents", "skills", "meta-theory", "SKILL.md"),
    cursorSkill: path.join(projectDir, ".cursor", "skills", "meta-theory", "SKILL.md"),
    cursorMcp: path.join(projectDir, ".cursor", "mcp.json"),
    openclawSkill: path.join(projectDir, "openclaw", "skills", "meta-theory", "SKILL.md"),
    openclawTemplate: path.join(projectDir, "openclaw", "openclaw.template.json"),
    bootstrapManifest: path.join(
      projectDir,
      ".meta-kim",
      "state",
      "default",
      "project-bootstrap.json",
    ),
  };
}

function expectedArtifacts(roots) {
  return {
    claudeSkill: path.join(roots.claudeHome, "skills", "meta-theory", "SKILL.md"),
    claudeCommand: path.join(roots.claudeHome, "commands", "meta-theory.md"),
    codexSkill: path.join(roots.codexHome, "skills", "meta-theory", "SKILL.md"),
    codexCommand: path.join(roots.codexHome, "commands", "meta-theory.md"),
    codexConfig: path.join(roots.codexHome, "config.toml"),
    cursorSkill: path.join(roots.cursorHome, "skills", "meta-theory", "SKILL.md"),
    openclawSkill: path.join(roots.openclawHome, "skills", "meta-theory", "SKILL.md"),
    claudeDependencySkill: path.join(
      roots.claudeHome,
      "skills",
      ACCEPTANCE_SKILL_FILTER,
      "SKILL.md",
    ),
    codexDependencySkill: path.join(
      roots.codexHome,
      "skills",
      ACCEPTANCE_SKILL_FILTER,
      "SKILL.md",
    ),
    manifest: path.join(roots.userHome, ".meta-kim", "install-manifest.json"),
  };
}

function assertOrdinaryCwdUntouched(ordinaryCwd) {
  const polluted = PROJECT_PROJECTION_NAMES.filter((name) => existsSync(path.join(ordinaryCwd, name)));
  if (polluted.length > 0) {
    throw new Error(`global-only CLI polluted ordinary cwd: ${polluted.join(", ")}`);
  }
  if (readFileSync(path.join(ordinaryCwd, "user-owned.txt"), "utf8") !== "user-owned\n") {
    throw new Error("global-only CLI changed the user-owned cwd sentinel");
  }
  return { pollutedPaths: [], sentinelPreserved: true };
}

function artifactFingerprint(artifacts) {
  const proof = {};
  for (const [id, filePath] of Object.entries(artifacts)) {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      throw new Error(`packed user acceptance missing ${id}: ${filePath}`);
    }
    const bytes = readFileSync(filePath);
    const stat = statSync(filePath);
    proof[id] = {
      sha256: sha256(bytes),
      bytes: bytes.length,
      mtimeMs: stat.mtimeMs,
    };
  }
  return proof;
}

export function verifyGlobalProjectionOwnership(
  manifestPath,
  roots,
  agentIds,
  {
    runtimeTargetIds = PACKED_USER_TARGETS,
    agentTargets = PACKED_GLOBAL_AGENT_TARGETS,
  } = {},
) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.scope !== "global" || !Array.isArray(manifest.entries)) {
    throw new Error("packed global ownership manifest is invalid");
  }
  const fileEntries = manifest.entries.filter((entry) => entry.kind === "file");
  for (const entry of fileEntries) {
    if (
      !existsSync(entry.path) ||
      statSync(entry.path).size !== entry.size ||
      sha256(readFileSync(entry.path)) !== entry.sha256
    ) {
      throw new Error(`packed global ownership integrity mismatch: ${entry.path}`);
    }
  }

  for (const target of agentTargets) {
    for (const agentId of agentIds) {
      const agentPath = path.join(
        roots.runtimeHomes[target.targetId],
        target.agentsDir,
        globalAgentProjectionFileName(target, agentId),
      );
      if (
        !fileEntries.some(
          (entry) =>
            entry.source === "sync-global-meta-theory" &&
            entry.purpose === `${target.targetId}-global-agent:${agentId}` &&
            path.resolve(entry.path) === path.resolve(agentPath),
        )
      ) {
        throw new Error(
          `packed global Agent ownership is missing: ${target.targetId}/${agentId}`,
        );
      }
    }
  }

  const syncRuntimeEntries = fileEntries.filter(
    (entry) => entry.source === "sync-runtimes",
  );
  for (const targetId of runtimeTargetIds) {
    const profile = PACKED_RUNTIME_PROFILES[targetId];
    const ownsGlobalAssets = profile.projection.assetTypes.some((assetType) =>
      globalProjectionIsOwnedBy(
        profile,
        assetType,
        GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES,
      ),
    );
    if (
      ownsGlobalAssets &&
      !syncRuntimeEntries.some((entry) => entry.runtimeTarget === targetId)
    ) {
      throw new Error(
        `packed global ownership is missing sync-runtimes records for ${targetId}`,
      );
    }
  }

  const syncGlobalPaths = new Set(
    fileEntries
      .filter((entry) => entry.source === "sync-global-meta-theory")
      .map((entry) => path.resolve(entry.path)),
  );
  const overlappingPath = syncRuntimeEntries.find((entry) =>
    syncGlobalPaths.has(path.resolve(entry.path)),
  );
  if (overlappingPath) {
    throw new Error(
      `packed global projection has multiple writers: ${overlappingPath.path}`,
    );
  }
  const agentRoots = agentTargets.map((target) =>
    path.join(roots.runtimeHomes[target.targetId], target.agentsDir),
  );
  if (
    syncRuntimeEntries.some((entry) =>
      agentRoots.some((agentRoot) => isPathWithin(agentRoot, entry.path)),
    )
  ) {
    throw new Error("sync-runtimes claimed a profile-owned global Agent path");
  }

  return {
    status: "passed",
    runtimeTargets: [...runtimeTargetIds],
    agentOwner: "sync-global-meta-theory",
    projectionOwner: GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES,
    fileEntryCount: fileEntries.length,
    syncRuntimeEntryCount: syncRuntimeEntries.length,
    overlappingWriterPathCount: 0,
  };
}

function normalizedManifest(manifestPath, userHome) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.scope !== "global" || !Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new Error("global install manifest is missing required entries");
  }
  return {
    schemaVersion: manifest.schemaVersion,
    scope: manifest.scope,
    metaKimVersion: manifest.metaKimVersion,
    entries: manifest.entries
      .map(({ installedAt: _installedAt, ...entry }) => ({
        ...entry,
        path: path.relative(userHome, entry.path).replaceAll("\\", "/"),
      }))
      .sort((left, right) => `${left.path}:${left.purpose ?? ""}`.localeCompare(`${right.path}:${right.purpose ?? ""}`)),
  };
}

function readValidatedProjectBootstrapManifest(projectDir) {
  const manifestPath = path.join(
    projectDir,
    ".meta-kim",
    "state",
    "default",
    "project-bootstrap.json",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    manifest.schemaVersion !== "meta-kim-project-bootstrap-v0.1" ||
    !Array.isArray(manifest.managedFiles) ||
    manifest.managedFiles.length === 0
  ) {
    throw new Error("packed project bootstrap manifest is not valid");
  }
  for (const entry of manifest.managedFiles) {
    if (
      typeof entry?.relPath !== "string" ||
      !/^[a-f0-9]{64}$/iu.test(entry?.contentHash ?? "")
    ) {
      throw new Error(`packed project bootstrap manifest has an invalid entry: ${entry?.relPath ?? "missing"}`);
    }
    const managedPath = path.join(projectDir, ...entry.relPath.split("/"));
    if (!existsSync(managedPath) || sha256(readFileSync(managedPath)) !== entry.contentHash) {
      throw new Error(`packed project bootstrap manifest hash does not match ${entry.relPath}`);
    }
  }
  return { manifestPath, manifest };
}

function readProjectProjectionMode(projectRoot) {
  const overridesPath = path.join(
    projectRoot,
    ".meta-kim",
    "local.overrides.json",
  );
  const overrides = JSON.parse(readFileSync(overridesPath, "utf8"));
  return overrides.projectProjectionMode ?? null;
}

function managedTextBlock(raw, relPath) {
  const id = `META_KIM MANAGED BLOCK: ${relPath}`;
  const begin = `<!-- BEGIN ${id} -->`;
  const end = `<!-- END ${id} -->`;
  const start = raw.indexOf(begin);
  const finish = raw.indexOf(end);
  if (start < 0 || finish < start) {
    throw new Error(`packed project ${relPath} is missing its managed block`);
  }
  return raw.slice(start, finish + end.length);
}

function stableArtifactProof(before, after, { ignoreIds = [] } = {}) {
  const ignored = new Set(ignoreIds);
  const changed = [];
  for (const id of Object.keys(before)) {
    if (ignored.has(id)) continue;
    const changedFields = ["sha256", "bytes", "mtimeMs"].filter(
      (field) => before[id][field] !== after[id][field],
    );
    if (changedFields.length > 0) {
      changed.push({ id, changedFields, before: before[id], after: after[id] });
    }
  }
  return { stable: changed.length === 0, changed };
}

function formatArtifactChanges(changed) {
  return changed
    .map((entry) =>
      `${entry.id}[${entry.changedFields.join("+")}]:` +
      `before=${JSON.stringify(entry.before)};after=${JSON.stringify(entry.after)}`,
    )
    .join(", ");
}

function requireInstalledCliDescriptor(descriptor) {
  if (
    !descriptor ||
    typeof descriptor.command !== "string" ||
    !descriptor.command ||
    typeof descriptor.installedPackageRoot !== "string" ||
    !descriptor.installedPackageRoot
  ) {
    throw new Error("packed release entrypoints require an installed CLI descriptor");
  }
  return descriptor;
}

export function runInstalledPublicCli(descriptor, roots, env, mode, timeoutMs) {
  const installed = requireInstalledCliDescriptor(descriptor);
  const args = [
    mode,
    "--silent",
    "--scope",
    "global",
    "--targets",
    PACKED_USER_TARGETS.join(","),
    "--skills",
    ACCEPTANCE_SKILL_FILTER,
  ];
  return runCli(installed.command, args, {
    cwd: roots.ordinaryCwd,
    env,
    timeoutMs,
  });
}

function runPackedUninstallLane({
  packageInfo,
  root,
  environment,
  timeoutMs,
  onProgress,
}) {
  emit(onProgress, { event: "packed_uninstall_start" });
  const roots = makeIsolatedRoots(root, "packed-uninstall");
  const env = isolatedEnvironment(environment, roots);
  env.METAKIM_LANG = "en";
  const descriptor = installPackedCli(packageInfo, roots, env, timeoutMs);
  const installed = requireInstalledCliDescriptor(descriptor);
  const installedCommandWithinIsolatedPrefix = isPathWithin(
    roots.cliPrefix,
    installed.command,
  );
  if (!installedCommandWithinIsolatedPrefix) {
    throw new Error("packed uninstall lane did not use the isolated installed public CLI");
  }

  const bootDescriptors = resolveMcpMemoryBootArtifactDescriptors({
    homeRoot: roots.userHome,
    platformName: process.platform,
  });
  let manifest = createInstallManifest({
    scope: "global",
    metaKimVersion: installed.identity.packageVersion,
  });
  for (const bootDescriptor of bootDescriptors) {
    const bytes = Buffer.from(`packed uninstall ${bootDescriptor.id}\n`, "utf8");
    mkdirSync(path.dirname(bootDescriptor.path), { recursive: true });
    writeFileSync(bootDescriptor.path, bytes);
    manifest = recordInstallManifest(manifest, {
      path: bootDescriptor.path,
      source: bootDescriptor.source,
      purpose: bootDescriptor.purpose,
      category: bootDescriptor.category,
      kind: bootDescriptor.kind,
      ownershipClass: bootDescriptor.ownershipClass,
      runtimeTarget: bootDescriptor.runtimeTarget,
      size: bytes.length,
      sha256: sha256(bytes),
    });
  }
  const manifestPath = path.join(
    roots.userHome,
    ".meta-kim",
    "install-manifest.json",
  );
  const persistedManifest = writeInstallManifest(manifestPath, manifest);
  for (const bootDescriptor of bootDescriptors) {
    const recorded = persistedManifest.entries.find(
      (entry) =>
        entry.path === bootDescriptor.path &&
        entry.purpose === bootDescriptor.purpose,
    );
    if (
      !recorded ||
      recorded.source !== bootDescriptor.source ||
      recorded.category !== bootDescriptor.category ||
      recorded.kind !== bootDescriptor.kind ||
      recorded.ownershipClass !== bootDescriptor.ownershipClass ||
      recorded.runtimeTarget !== bootDescriptor.runtimeTarget ||
      !Number.isSafeInteger(recorded.size) ||
      !/^[a-f0-9]{64}$/u.test(recorded.sha256 ?? "")
    ) {
      throw new Error(`packed uninstall manifest identity is incomplete: ${bootDescriptor.id}`);
    }
  }

  requireSuccess(
    "packed installed public CLI normal manifest uninstall",
    runCli(installed.command, ["uninstall", "--scope=global", "--yes"], {
      cwd: roots.ordinaryCwd,
      env,
      timeoutMs,
    }),
  );
  const remainingBootArtifacts = bootDescriptors
    .filter((entry) => existsSync(entry.path))
    .map((entry) => entry.id);
  if (remainingBootArtifacts.length > 0) {
    throw new Error(
      `packed normal manifest uninstall left boot artifacts: ${remainingBootArtifacts.join(", ")}`,
    );
  }

  const privateFlag = runCli(
    installed.command,
    ["uninstall", "--no-manifest", "--scope=global"],
    { cwd: roots.ordinaryCwd, env, timeoutMs },
  );
  const privateFlagOutput = `${privateFlag.stdout ?? ""}\n${privateFlag.stderr ?? ""}`;
  if (
    privateFlag.error ||
    privateFlag.status !== 2 ||
    !/unknown uninstall option '--no-manifest'/u.test(privateFlagOutput)
  ) {
    throw new Error(
      `packed public CLI did not reject --no-manifest: exit=${privateFlag.status}; ${privateFlagOutput.trim()}`,
    );
  }
  const helpAfterFailedUninstall = runCli(installed.command, ["--help"], {
    cwd: roots.ordinaryCwd,
    env,
    timeoutMs,
  });
  if (
    helpAfterFailedUninstall.error ||
    helpAfterFailedUninstall.status !== 0 ||
    !/meta-kim uninstall/u.test(helpAfterFailedUninstall.stdout ?? "")
  ) {
    throw new Error(
      "packed installed public CLI was unavailable after the failed manifestless uninstall",
    );
  }

  let windowsRecovery;
  if (process.platform === "win32") {
    const byId = new Map(bootDescriptors.map((entry) => [entry.id, entry]));
    const startupVbs = byId.get("windows-startup")?.path;
    const commandPath = byId.get("windows-command")?.path;
    if (!startupVbs || !commandPath || existsSync(commandPath)) {
      throw new Error("packed Windows recovery fixture did not begin with an orphan Startup VBS");
    }
    mkdirSync(path.dirname(startupVbs), { recursive: true });
    writeFileSync(
      startupVbs,
      renderCurrentWindowsMcpMemoryStartupVbsBytes({ commandPath }),
    );
    const recoveryDryRun = requireSuccess(
      "packed installed public CLI recovery dry-run",
      runCli(installed.command, ["uninstall", "--recover", "--scope=global"], {
        cwd: roots.ordinaryCwd,
        env,
        timeoutMs,
      }),
    );
    if (
      !existsSync(startupVbs) ||
      !/complete uninstall cannot be proven/iu.test(
        `${recoveryDryRun.stdout ?? ""}\n${recoveryDryRun.stderr ?? ""}`,
      )
    ) {
      throw new Error("packed recovery dry-run did not preserve the orphan and report its proof boundary");
    }
    requireSuccess(
      "packed installed public CLI recovery live run",
      runCli(
        installed.command,
        ["uninstall", "--recover", "--scope=global", "--yes"],
        { cwd: roots.ordinaryCwd, env, timeoutMs },
      ),
    );
    if (existsSync(startupVbs)) {
      throw new Error("packed recovery live run left the exact orphan Startup VBS");
    }
    windowsRecovery = {
      status: "passed",
      fixture: "shared_renderer_exact_orphan_startup_vbs",
      missingCommandTarget: true,
      dryRunPreserved: true,
      unprovenBoundaryReported: true,
      liveRunRemoved: true,
    };
  } else {
    windowsRecovery = {
      status: "not_applicable",
      reason: "windows_exact_signature_recovery_only",
    };
  }

  const proof = {
    status: "passed",
    platform: process.platform,
    evidenceTier: "packed_isolated_installed_public_cli",
    packageSha256: packageInfo.tarballSha256,
    isolatedHomeAndPrefix: true,
    normalManifestUninstall: {
      status: "passed",
      evidenceScope: "synthetic_manifest_fixture_consumed_by_packed_public_cli",
      descriptorIds: bootDescriptors.map((entry) => entry.id),
      syntheticFixtureExactOwnershipAndIntegrityRecorded: true,
      allChainFilesRemoved: true,
    },
    privateManifestBypass: {
      status: "passed",
      option: "--no-manifest",
      exitCode: privateFlag.status,
      rejectedByPublicCli: true,
    },
    publicCliAfterFailedUninstall: {
      status: "passed",
      commandSource: "isolated_installed_public_cli",
      withinIsolatedPrefix: installedCommandWithinIsolatedPrefix,
      entrypoint: "--help",
      exitCode: helpAfterFailedUninstall.status,
    },
    windowsRecovery,
  };
  const serializedProof = JSON.stringify(proof);
  for (const forbiddenRoot of [
    roots.laneRoot,
    roots.userHome,
    roots.tempDir,
    roots.cliPrefix,
  ]) {
    const serializedForbiddenRoot = JSON.stringify(forbiddenRoot).slice(1, -1);
    if (serializedProof.includes(serializedForbiddenRoot)) {
      throw new Error("packed uninstall proof serialized an isolated home or temporary path");
    }
  }
  emit(onProgress, { event: "packed_uninstall_complete", status: proof.status });
  return proof;
}

function filesRecursively(rootPath) {
  if (!existsSync(rootPath)) return [];
  const files = [];
  const visit = (directoryPath) => {
    for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  };
  visit(rootPath);
  return files;
}

function currentProjectionPackageAuthority(manifestPath, descriptor) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const candidates = manifest.entries
    .filter(
      (entry) =>
        entry.source === PROJECTION_PACKAGE_MANIFEST_SOURCE &&
        entry.purpose === PROJECTION_PACKAGE_PURPOSE.bundle &&
        entry.kind === "dir",
    )
    .sort((left, right) =>
      String(right.installedAt ?? "").localeCompare(String(left.installedAt ?? "")),
    );
  for (const candidate of candidates) {
    try {
      const receiptPath = path.join(candidate.path, "receipt.json");
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      if (
        receipt.schemaVersion !== PROJECTION_PACKAGE_RECEIPT_SCHEMA ||
        receipt.packageName !== descriptor.identity.packageName ||
        receipt.packageVersion !== descriptor.identity.packageVersion ||
        !/^[a-f0-9]{64}$/u.test(receipt.packageTarballSha256 ?? "") ||
        path.basename(candidate.path) !== receipt.packageTarballSha256
      ) continue;
      const publicCli = manifest.entries.find(
        (entry) =>
          entry.source === PROJECTION_PACKAGE_MANIFEST_SOURCE &&
          entry.purpose === PROJECTION_PACKAGE_PURPOSE.cli &&
          entry.kind === "file" &&
          isPathWithin(candidate.path, entry.path),
      );
      if (
        !publicCli ||
        !existsSync(publicCli.path) ||
        statSync(publicCli.path).size !== publicCli.size ||
        sha256(readFileSync(publicCli.path)) !== publicCli.sha256
      ) continue;
      return {
        digestDir: candidate.path,
        digest: receipt.packageTarballSha256,
        packageRoot: path.resolve(candidate.path, receipt.packageRootRelative),
        publicCliPath: publicCli.path,
        receiptPath,
        purpose: candidate.purpose,
      };
    } catch {
      // Historical or incomplete candidates are not current authority.
    }
  }
  throw new Error("current packed version has no exact stable projection package authority");
}

function referencedAbsoluteRuntimePaths(text) {
  const references = new Set();
  const quotedFile = /["']((?:[A-Za-z]:[\\/]|\/)[^"'\r\n]+?\.(?:mjs|cjs|js|exe|cmd|ps1))["']/gu;
  const packageRoot = /--package-root\s+(?:"([^"]+)"|'([^']+)'|([^\s"']+))/gu;
  for (const match of text.matchAll(quotedFile)) references.add(match[1]);
  for (const match of text.matchAll(packageRoot)) {
    references.add(match[1] ?? match[2] ?? match[3]);
  }
  return [...references].map((entry) => entry.replaceAll("\\\\", "\\"));
}

const EXECUTABLE_SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".mjs",
  ".ps1",
  ".py",
  ".sh",
]);

export function referencedPersistentRuntimePaths(textByPath) {
  return [...new Set(
    Object.entries(textByPath).flatMap(([filePath, text]) => {
      if (EXECUTABLE_SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
        return [];
      }
      let corpus = [text];
      try {
        corpus = [...corpus, ...stringLeaves(JSON.parse(text))];
      } catch {
        // Non-JSON runtime declarations are scanned as plain text.
      }
      return corpus.flatMap(referencedAbsoluteRuntimePaths);
    }),
  )];
}

function referencedDeclaredPackageRoots(text) {
  const roots = new Set();
  const pattern = /--package-root\s+(?:"([^"]+)"|'([^']+)'|([^\s"']+))/gu;
  for (const match of text.matchAll(pattern)) {
    roots.add((match[1] ?? match[2] ?? match[3]).replaceAll("\\\\", "\\"));
  }
  return [...roots];
}

function stringLeaves(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(stringLeaves);
  }
  return [];
}

function runtimeReadbackCorpus(textByPath) {
  return Object.values(textByPath).flatMap((text) => {
    try {
      return [text, ...stringLeaves(JSON.parse(text))];
    } catch {
      return [text];
    }
  });
}

function structuredRuntimeReadback(textByPath) {
  return Object.fromEntries(
    Object.entries(textByPath).map(([filePath, text]) => {
      try {
        return [filePath, JSON.parse(text)];
      } catch {
        return [filePath, text];
      }
    }),
  );
}

function assertTransientRuntimeReadback({
  roots,
  descriptor,
  seeded,
  authority,
  forbiddenRoots,
}) {
  assertOrdinaryCwdUntouched(roots.ordinaryCwd);
  for (const userAgent of seeded.userAgents) {
    if (readFileSync(userAgent.path, "utf8") !== userAgent.content) {
      throw new Error(`transient packed update changed user ${userAgent.targetId} Agent`);
    }
  }
  const settings = JSON.parse(readFileSync(seeded.claudeSettingsPath, "utf8"));
  if (
    settings.userPreference?.preserve !== true ||
    !JSON.stringify(settings.hooks ?? {}).includes(seeded.userHookCommand)
  ) {
    throw new Error("transient packed update changed user Claude settings");
  }
  const claudeConfig = JSON.parse(readFileSync(seeded.claudeUserConfigPath, "utf8"));
  requireDurableMcpServer(
    claudeConfig,
    seeded,
    forbiddenRoots,
    descriptor,
  );
  const codexConfigPath = path.join(roots.codexHome, "config.toml");
  const codexHooksPath = path.join(roots.codexHome, "hooks.json");
  if (!/\[user_owned_transient\]\s+preserve\s*=\s*true/u.test(
    readFileSync(codexConfigPath, "utf8"),
  )) {
    throw new Error("transient packed update changed user Codex config");
  }
  if (
    JSON.parse(readFileSync(codexHooksPath, "utf8"))
      .userOwnedTransient?.preserve !== true
  ) {
    throw new Error("transient packed update changed user Codex hooks state");
  }

  const readbackPaths = [
    path.join(roots.userHome, ".meta-kim", "install-manifest.json"),
    seeded.claudeSettingsPath,
    seeded.claudeUserConfigPath,
    codexConfigPath,
    codexHooksPath,
    ...TRANSIENT_PACKAGE_TARGETS.flatMap((runtime) => {
      const runtimeHome = roots.runtimeHomes[runtime];
      return [
        ...filesRecursively(path.join(runtimeHome, "commands")),
        ...filesRecursively(path.join(runtimeHome, "hooks")),
      ];
    }),
  ];
  const textByPath = Object.fromEntries(
    [...new Set(readbackPaths)].map((filePath) => {
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        throw new Error(`transient packed readback is missing ${filePath}`);
      }
      return [filePath, readFileSync(filePath, "utf8")];
    }),
  );
  const readbackCorpus = runtimeReadbackCorpus(textByPath);
  const forbiddenReferences = collectNonPortablePackedReferences(
    structuredRuntimeReadback(textByPath),
    {
      forbiddenRoots,
      location: "$readback",
    },
  );
  if (forbiddenReferences.length > 0) {
    throw new Error(
      `global readback contains non-portable references: ${forbiddenReferences
        .map((finding) => `${finding.location}:${finding.reason}:${finding.value}`)
        .join(", ")}`,
    );
  }
  const manifest = JSON.parse(textByPath[
    path.join(roots.userHome, ".meta-kim", "install-manifest.json")
  ]);
  const authorityEntries = manifest.entries.filter(
    (entry) =>
      entry.source === PROJECTION_PACKAGE_MANIFEST_SOURCE &&
      typeof entry.purpose === "string" &&
      entry.purpose.startsWith(PROJECTION_PACKAGE_PURPOSE.bundle),
  );
  if (
    authorityEntries.length < 5 ||
    authorityEntries.some((entry) =>
      path.resolve(entry.path) !== path.resolve(authority.digestDir) &&
      !isPathWithin(authority.digestDir, entry.path)
    )
  ) {
    throw new Error("transient packed manifest is not bound to one stable authority digest");
  }
  for (const entry of manifest.entries.filter((candidate) => candidate.kind === "file")) {
    if (
      !existsSync(entry.path) ||
      statSync(entry.path).size !== entry.size ||
      sha256(readFileSync(entry.path)) !== entry.sha256
    ) {
      throw new Error(`transient packed manifest reference is missing or stale: ${entry.path}`);
    }
  }
  const referencedPaths = referencedPersistentRuntimePaths(textByPath);
  if (referencedPaths.length === 0) {
    throw new Error("transient packed readback exposed no absolute runtime references");
  }
  const missingReferences = referencedPaths.filter((filePath) => !existsSync(filePath));
  if (missingReferences.length > 0) {
    throw new Error(
      `transient packed readback contains missing runtime references: ${missingReferences.join(", ")}`,
    );
  }
  const authorityReferences = referencedPaths.filter((filePath) =>
    valueReferencesRoot(filePath, authority.digestDir)
  );
  const declaredPackageRoots = [...new Set(
    readbackCorpus.flatMap(referencedDeclaredPackageRoots),
  )];
  const foreignDeclaredPackageRoots = declaredPackageRoots.filter(
    (packageRoot) =>
      path.resolve(packageRoot) !== path.resolve(authority.packageRoot) &&
      !isPathWithin(authority.packageRoot, packageRoot),
  );
  const foreignProjectionPackageReferences = referencedPaths.filter((filePath) =>
    String(filePath).replaceAll("\\", "/").includes("/.meta-kim/runtime/projection-packages/") &&
    !valueReferencesRoot(filePath, authority.digestDir)
  );
  if (
    authorityReferences.length === 0 ||
    declaredPackageRoots.length === 0 ||
    foreignDeclaredPackageRoots.length > 0 ||
    foreignProjectionPackageReferences.length > 0
  ) {
    throw new Error(
      "transient packed readback is not exclusively bound to the selected stable authority",
    );
  }
  return {
    forbiddenRootReferenceCount: forbiddenReferences.length,
    referencedPathCount: referencedPaths.length,
    stableAuthorityReferenceCount: authorityReferences.length,
    declaredPackageRootCount: declaredPackageRoots.length,
  };
}

function prepareTransientPackageRoot({
  packageInfo,
  descriptor,
  roots,
  env,
  timeoutMs,
}) {
  const transientPrefix = path.join(
    roots.npmCache,
    "_npx",
    "p138-current-version",
  );
  requireSuccess(
    "install exact candidate into transient npx-shaped package root",
    runCli(
      "npm",
      [
        "install",
        "--prefix",
        transientPrefix,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        packageInfo.tarball,
      ],
      { cwd: roots.laneRoot, env, timeoutMs },
    ),
  );
  const transientNodeModules = path.join(transientPrefix, "node_modules");
  const transientPackageRoot = path.join(
    transientNodeModules,
    ...descriptor.identity.packageName.split("/").filter(Boolean),
  );
  if (existsSync(path.join(transientPackageRoot, ".meta-kim"))) {
    throw new Error(
      "fresh transient npx-shaped package unexpectedly contains package-local runtime state",
    );
  }
  const transientCliPath = path.join(
    transientPackageRoot,
    path.relative(descriptor.installedPackageRoot, descriptor.installedCliPath),
  );
  if (!existsSync(transientCliPath)) {
    throw new Error("transient npx-shaped package is missing its packed public CLI");
  }
  return {
    transientPrefix,
    transientPackageRoot,
    transientCliPath,
  };
}

function runTransientPackageRootLane({
  packageInfo,
  descriptor,
  roots,
  env,
  seeded,
  timeoutMs,
  transientPackage,
}) {
  const manifestPath = path.join(roots.userHome, ".meta-kim", "install-manifest.json");
  const authorityBefore = currentProjectionPackageAuthority(manifestPath, descriptor);
  const codexConfigPath = path.join(roots.codexHome, "config.toml");
  writeFileSync(
    codexConfigPath,
    `${readFileSync(codexConfigPath, "utf8").trimEnd()}\n\n` +
      "[user_owned_transient]\npreserve = true\n",
    "utf8",
  );
  const codexHooksPath = path.join(roots.codexHome, "hooks.json");
  const codexHooks = JSON.parse(readFileSync(codexHooksPath, "utf8"));
  codexHooks.userOwnedTransient = { preserve: true };
  writeFileSync(codexHooksPath, `${JSON.stringify(codexHooks, null, 2)}\n`, "utf8");
  const { transientCliPath } = transientPackage;
  requireSuccess(
    "transient npx-shaped packed public CLI global update",
    run(
      process.execPath,
      [
        transientCliPath,
        "update",
        "--silent",
        "--scope",
        "global",
        "--targets",
        TRANSIENT_PACKAGE_TARGETS.join(","),
        "--skills",
        ACCEPTANCE_SKILL_FILTER,
        "--with-global-hooks",
      ],
      { cwd: roots.ordinaryCwd, env, timeoutMs },
    ),
  );
  const authorityAfterApply = currentProjectionPackageAuthority(manifestPath, descriptor);
  if (path.resolve(authorityAfterApply.digestDir) !== path.resolve(authorityBefore.digestDir)) {
    throw new Error("transient packed update did not reuse the current stable authority");
  }

  const disposableOrigins = [
    roots.npmCache,
    roots.cliPrefix,
    descriptor.globalNodeModules,
    descriptor.installedPackageRoot,
    packageInfo.workspace,
    packageInfo.extractDir,
    path.dirname(packageInfo.tarball),
  ];
  const forbiddenRoots = [...new Set([
    ...disposableOrigins,
    packageInfo.sourceRoot,
  ].map((entry) => path.resolve(entry)))];
  rmSync(roots.npmCache, { recursive: true, force: true });
  rmSync(roots.cliPrefix, { recursive: true, force: true });
  const remainingDisposableOrigins = disposableOrigins.filter(existsSync);
  if (remainingDisposableOrigins.length > 0) {
    throw new Error(
      `disposable packed origins still exist before stable public CLI check: ${remainingDisposableOrigins.join(", ")}`,
    );
  }
  const stableEnvironment = repositoryIndependentEnvironment(env, forbiddenRoots);
  requireSuccess(
    "stable authority packed public CLI check after transient cache deletion",
    run(
      process.execPath,
      [
        authorityAfterApply.publicCliPath,
        "check",
        "--silent",
        "--scope",
        "global",
        "--targets",
        TRANSIENT_PACKAGE_TARGETS.join(","),
        "--skills",
        ACCEPTANCE_SKILL_FILTER,
        "--with-global-hooks",
      ],
      { cwd: roots.ordinaryCwd, env: stableEnvironment, timeoutMs },
    ),
  );
  const authorityAfterCheck = currentProjectionPackageAuthority(manifestPath, descriptor);
  if (path.resolve(authorityAfterCheck.digestDir) !== path.resolve(authorityAfterApply.digestDir)) {
    throw new Error("stable public CLI check changed the selected authority digest");
  }
  const readback = assertTransientRuntimeReadback({
    roots,
    descriptor,
    seeded,
    authority: authorityAfterCheck,
    forbiddenRoots,
  });
  return {
    status: "passed",
    publicCliApplied: true,
    originDeletedBeforeCheck: true,
    stablePublicCliCheck: true,
    claudeCodexReadback: true,
    forbiddenRootReferenceCount: readback.forbiddenRootReferenceCount,
    referencedPathCount: readback.referencedPathCount,
    authorityReused: true,
    authorityPurpose: authorityAfterCheck.purpose,
    stableAuthorityDigest: authorityAfterCheck.digest,
    stableAuthorityPath: authorityAfterCheck.digestDir,
    stablePackageRoot: authorityAfterCheck.packageRoot,
    stableAuthorityReferenceCount: readback.stableAuthorityReferenceCount,
    declaredPackageRootCount: readback.declaredPackageRootCount,
    allPersistentPackageReferencesBound: true,
    allReferencedPathsExist: true,
    manifestAuthorityBound: true,
    disposableOriginCount: disposableOrigins.length,
    remainingDisposableOriginCount: remainingDisposableOrigins.length,
  };
}

function runInstalledPublicProjectCli(descriptor, roots, env, mode, timeoutMs) {
  const installed = requireInstalledCliDescriptor(descriptor);
  return runCli(installed.command, [
    mode,
    "--silent",
    "--scope",
    "project",
    "--targets",
    PACKED_USER_TARGETS.join(","),
    "--project-dir",
    roots.projectDir,
  ], {
    cwd: roots.ordinaryCwd,
    env,
    timeoutMs,
  });
}

function runInstalledPublicGlobalUpdateFromProject(descriptor, roots, env) {
  const installed = requireInstalledCliDescriptor(descriptor);
  const startedAt = Date.now();
  const result = runCli(installed.command, [
    "update",
    "--silent",
    "--scope",
    "global",
    "--targets",
    PACKED_USER_TARGETS.join(","),
    "--skills",
    ACCEPTANCE_SKILL_FILTER,
  ], {
    cwd: roots.projectDir,
    env,
    timeoutMs: PACKED_PROJECT_AWARE_GLOBAL_UPDATE_TIMEOUT_MS,
  });
  return requirePackedCommandSuccess(
    result,
    {
      operation: PROJECT_AWARE_GLOBAL_UPDATE_OPERATION_ID,
      timeoutMs: PACKED_PROJECT_AWARE_GLOBAL_UPDATE_TIMEOUT_MS,
      elapsedMs: Date.now() - startedAt,
    },
  );
}

function runProjectCapabilityCopy(
  descriptor,
  roots,
  env,
  { type, id, source, mode },
  timeoutMs,
) {
  const installed = requireInstalledCliDescriptor(descriptor);
  return runCli(installed.command, [
    "project",
    "capability",
    "copy",
    "--project-dir",
    roots.projectDir,
    "--runtime",
    "codex",
    "--type",
    type,
    "--id",
    id,
    "--source",
    source,
    "--mode",
    mode,
    "--apply",
    "--json",
  ], {
    cwd: roots.ordinaryCwd,
    env,
    timeoutMs,
  });
}

function runtimeSedimentationFixtures(roots) {
  const fixtures = [
    {
      type: "agent",
      id: "acceptance-runtime-agent",
      source: path.join(roots.codexHome, "agents", "acceptance-runtime-agent.toml"),
      target: path.join(roots.projectDir, ".codex", "agents", "acceptance-runtime-agent.toml"),
      first: 'name = "acceptance-runtime-agent"\ndescription = "runtime v1"\ndeveloper_instructions = "v1"\n',
      second: 'name = "acceptance-runtime-agent"\ndescription = "runtime v2"\ndeveloper_instructions = "v2"\n',
    },
    {
      type: "skill",
      id: "acceptance-runtime-skill",
      source: path.join(roots.codexHome, "skills", "acceptance-runtime-skill", "SKILL.md"),
      target: path.join(roots.projectDir, ".agents", "skills", "acceptance-runtime-skill", "SKILL.md"),
      first: "# acceptance runtime skill\n\nv1\n",
      second: "# acceptance runtime skill\n\nv2\n",
    },
    {
      type: "command",
      id: "acceptance-runtime-command",
      source: path.join(roots.codexHome, "commands", "acceptance-runtime-command.md"),
      target: path.join(roots.projectDir, ".codex", "commands", "acceptance-runtime-command.md"),
      first: "# acceptance runtime command\n\nv1\n",
      second: "# acceptance runtime command\n\nv2\n",
    },
  ];
  for (const fixture of fixtures) {
    mkdirSync(path.dirname(fixture.source), { recursive: true });
    writeFileSync(fixture.source, fixture.first, "utf8");
  }
  return fixtures;
}

function globalReuseOnlyFixtures(roots) {
  const fixtures = [
    {
      type: "agent",
      id: "acceptance-global-reuse-agent",
      source: path.join(roots.codexHome, "agents", "acceptance-global-reuse-agent.toml"),
      target: path.join(roots.projectDir, ".codex", "agents", "acceptance-global-reuse-agent.toml"),
      content: 'name = "acceptance-global-reuse-agent"\ndescription = "reuse globally"\ndeveloper_instructions = "reuse"\n',
    },
    {
      type: "skill",
      id: "acceptance-global-reuse-skill",
      source: path.join(roots.codexHome, "skills", "acceptance-global-reuse-skill", "SKILL.md"),
      target: path.join(roots.projectDir, ".agents", "skills", "acceptance-global-reuse-skill", "SKILL.md"),
      content:
        "---\nname: acceptance-global-reuse-skill\n" +
        "description: Reusable global packed acceptance skill.\n---\n\n" +
        "# Acceptance global reuse skill\n",
    },
    {
      type: "command",
      id: "acceptance-global-reuse-command",
      source: path.join(roots.codexHome, "commands", "acceptance-global-reuse-command.md"),
      target: path.join(roots.projectDir, ".codex", "commands", "acceptance-global-reuse-command.md"),
      content: "# acceptance global reuse command\n",
    },
  ];
  for (const fixture of fixtures) {
    mkdirSync(path.dirname(fixture.source), { recursive: true });
    writeFileSync(fixture.source, fixture.content, "utf8");
  }
  return fixtures;
}

function runGlobalReuseNegativeLane({ descriptor, roots, env, fixtures, timeoutMs }) {
  const artifactDir = path.join(roots.projectDir, ".meta-kim", "acceptance", "global-reuse");
  const stateDir = path.join(roots.projectDir, ".meta-kim", "state", "acceptance-global-reuse");
  const dbPath = path.join(stateDir, "runs.sqlite");
  mkdirSync(artifactDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const task = [
    "请直接复用全局 agent acceptance-global-reuse-agent，不需要迭代或修改，也不要复制到项目。",
    "请直接复用全局 skill acceptance-global-reuse-skill，不需要迭代或修改，也不要复制到项目。",
    "请直接复用全局 command acceptance-global-reuse-command，不需要迭代或修改，也不要复制到项目。",
  ].join("\n");
  const runId = "packed-global-reuse-negative";
  requireSuccess(
    "governed global reuse negative acceptance",
    run(process.execPath, [
      path.join(
        descriptor.installedPackageRoot,
        "scripts",
        "run-meta-theory-governed-execution.mjs",
      ),
      "--task",
      task,
      "--run-id",
      runId,
      "--state-dir",
      stateDir,
      "--artifact-dir",
      artifactDir,
      "--db",
      dbPath,
      "--runtime",
      "codex",
      "--os",
      "windows",
      "--output-language",
      "zh-CN",
    ], {
      cwd: roots.projectDir,
      env,
      timeoutMs,
    }),
  );
  const artifact = JSON.parse(readFileSync(path.join(artifactDir, `${runId}.json`), "utf8"));
  const packet = artifact.projectCustomizationPacket;
  if (packet?.decision !== "use_global_directly") {
    const inventoryPath = path.join(
      descriptor.installedPackageRoot,
      ".meta-kim",
      "state",
      "default",
      "capability-index",
      "global-capabilities.json",
    );
    const inventory = existsSync(inventoryPath)
      ? JSON.parse(readFileSync(inventoryPath, "utf8"))
      : null;
    const acceptanceInventoryKeys = Object.fromEntries(
      ["agents", "skills", "commands"].map((type) => [
        type,
        Object.keys(inventory?.byCapabilityType?.[type] ?? {}).filter((key) =>
          key.includes("acceptance-global-reuse"),
        ),
      ]),
    );
    throw new Error(
      `global reuse request resolved to ${packet?.decision ?? "missing"} instead of use_global_directly: ` +
      JSON.stringify({ decisions: packet?.decisions ?? [], acceptanceInventoryKeys }),
    );
  }
  const requested = new Set(fixtures.map((fixture) => fixture.id));
  const relevantDecisions = (packet.decisions ?? []).filter((decision) =>
    requested.has(decision.globalCandidateChecked?.providerId),
  );
  if (
    relevantDecisions.length !== fixtures.length ||
    !relevantDecisions.every(
      (decision) =>
        decision.decision === "use_global_directly" &&
        decision.copyPolicy === "use_global_directly" &&
        requested.has(decision.globalCandidateChecked?.providerId) &&
        decision.approvalRequired === false,
    )
  ) {
    throw new Error("global reuse request did not keep all Agent/Skill/Command decisions copy-free");
  }
  const copied = fixtures.filter((fixture) => existsSync(fixture.target));
  if (copied.length > 0) {
    throw new Error(`use_global_directly created project copies: ${copied.map((item) => item.type).join(", ")}`);
  }
  const manifestPath = path.join(
    roots.projectDir,
    ".meta-kim",
    "state",
    "default",
    "project-capabilities.json",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const unexpectedEntries = manifest.capabilities.filter((entry) => requested.has(entry.id));
  if (unexpectedEntries.length > 0) {
    throw new Error("use_global_directly added project capability ownership entries");
  }
  return {
    status: "passed",
    decision: packet.decision,
    types: fixtures.map((fixture) => fixture.type),
    projectCopiesCreated: 0,
    ownershipEntriesCreated: 0,
  };
}

function runRuntimeSedimentationLane({ descriptor, roots, env, timeoutMs }) {
  const fixtures = runtimeSedimentationFixtures(roots);
  const reuseOnlyFixtures = globalReuseOnlyFixtures(roots);
  for (const fixture of fixtures) {
    const copied = requireSuccess(
      `project capability create ${fixture.type}`,
      runProjectCapabilityCopy(
        descriptor,
        roots,
        env,
        { ...fixture, mode: "create" },
        timeoutMs,
      ),
    );
    const result = JSON.parse(copied.stdout);
    if (result.status !== "committed" || result.capability?.ownership !== "project") {
      throw new Error(`project capability create ${fixture.type} did not commit project ownership`);
    }
    if (readFileSync(fixture.target, "utf8") !== fixture.first) {
      throw new Error(`project capability create ${fixture.type} did not copy the runtime source`);
    }
    writeFileSync(fixture.target, `${fixture.first}\nproject-user-modification\n`, "utf8");
    writeFileSync(fixture.source, fixture.second, "utf8");
  }

  const capabilityManifestPath = path.join(
    roots.projectDir,
    ".meta-kim",
    "state",
    "default",
    "project-capabilities.json",
  );
  const capabilityManifestBefore = JSON.parse(
    readFileSync(capabilityManifestPath, "utf8"),
  );
  if (
    capabilityManifestBefore.capabilities?.length !== fixtures.length ||
    !capabilityManifestBefore.capabilities.every(
      (entry) =>
        entry.ownershipClass === "runtime_sedimented_project_copy" &&
        entry.dependencyUpdatePolicy === "preserve_project_copy",
    )
  ) {
    throw new Error("project capability manifest was not prepared before the global update");
  }

  const bootstrapBefore = readValidatedProjectBootstrapManifest(roots.projectDir);
  const projectProjectionModeBefore = readProjectProjectionMode(
    roots.projectDir,
  );
  if (projectProjectionModeBefore !== "project") {
    throw new Error("packed project install did not establish project projection mode");
  }
  const globalArtifacts = expectedArtifacts(roots);
  const projectArtifacts = expectedProjectArtifacts(roots.projectDir);
  const candidateVersion = JSON.parse(
    readFileSync(descriptor.installedPackageManifestPath, "utf8"),
  ).version;
  const globalSkillExpected = readFileSync(globalArtifacts.codexSkill, "utf8");
  const projectSkillExpected = readFileSync(projectArtifacts.projectSkill, "utf8");
  const agentsExpectedBlock = managedTextBlock(
    readFileSync(projectArtifacts.agentsGuide, "utf8"),
    "AGENTS.md",
  );
  const agentsUserNote = "packed-acceptance-user-agents-note";
  const agentsBegin = "<!-- BEGIN META_KIM MANAGED BLOCK: AGENTS.md -->";
  const agentsEnd = "<!-- END META_KIM MANAGED BLOCK: AGENTS.md -->";
  const unknownProjectFile = path.join(
    roots.projectDir,
    ".codex",
    "commands",
    "packed-user-owned-command.md",
  );
  const unknownProjectContent = "# packed user-owned command\n\nkeep me\n";

  writeFileSync(globalArtifacts.codexSkill, "stale packed global skill\n", "utf8");
  writeFileSync(projectArtifacts.projectSkill, "stale packed project skill\n", "utf8");
  writeFileSync(
    projectArtifacts.agentsGuide,
    `${agentsUserNote}\n\n${agentsBegin}\nstale packed managed block\n${agentsEnd}\n`,
    "utf8",
  );
  mkdirSync(path.dirname(unknownProjectFile), { recursive: true });
  writeFileSync(unknownProjectFile, unknownProjectContent, "utf8");

  const dependencyUpdate = runInstalledPublicGlobalUpdateFromProject(
    descriptor,
    roots,
    env,
  );
  assertOrdinaryCwdUntouched(roots.ordinaryCwd);

  if (readFileSync(globalArtifacts.codexSkill, "utf8") !== globalSkillExpected) {
    throw new Error("project-aware global update did not refresh the global Codex skill");
  }
  if (readFileSync(projectArtifacts.projectSkill, "utf8") !== projectSkillExpected) {
    throw new Error("project-aware global update did not replace the manifest-managed project skill");
  }
  const agentsAfter = readFileSync(projectArtifacts.agentsGuide, "utf8");
  if (
    !agentsAfter.includes(agentsUserNote) ||
    managedTextBlock(agentsAfter, "AGENTS.md") !== agentsExpectedBlock
  ) {
    throw new Error("project-aware global update did not merge AGENTS.md while preserving user text");
  }
  if (readFileSync(unknownProjectFile, "utf8") !== unknownProjectContent) {
    throw new Error("project-aware global update changed an unknown user project file");
  }
  for (const fixture of fixtures) {
    const expected = `${fixture.first}\nproject-user-modification\n`;
    if (readFileSync(fixture.target, "utf8") !== expected) {
      throw new Error(`project-aware global update overwrote the runtime-sedimented ${fixture.type}`);
    }
  }

  const bootstrapAfter = readValidatedProjectBootstrapManifest(roots.projectDir);
  const projectProjectionModeAfter = readProjectProjectionMode(
    roots.projectDir,
  );
  if (projectProjectionModeAfter !== projectProjectionModeBefore) {
    throw new Error("project-aware global update changed the existing project projection mode");
  }
  if (bootstrapAfter.manifest.metaKimVersion !== candidateVersion) {
    throw new Error("project-aware global update did not advance the project bootstrap manifest");
  }
  const projectSkillEntry = bootstrapAfter.manifest.managedFiles.find(
    (entry) => entry.relPath === ".agents/skills/meta-theory/SKILL.md",
  );
  const agentsEntry = bootstrapAfter.manifest.managedFiles.find(
    (entry) => entry.relPath === "AGENTS.md",
  );
  if (projectSkillEntry?.mergePolicy !== "manifest_managed_projection_replace") {
    throw new Error("project-aware global update did not record project skill replace ownership");
  }
  if (agentsEntry?.mergePolicy !== "managed_block_preserve_user_text") {
    throw new Error("project-aware global update did not record AGENTS.md merge ownership");
  }

  const globalReuse = runGlobalReuseNegativeLane({
    descriptor,
    roots,
    env,
    fixtures: reuseOnlyFixtures,
    timeoutMs,
  });

  for (const fixture of fixtures) {
    const expected = `${fixture.first}\nproject-user-modification\n`;
    if (readFileSync(fixture.target, "utf8") !== expected) {
      throw new Error(`global update overwrote the project-owned ${fixture.type}`);
    }
    const iterated = requireSuccess(
      `project capability iterate ${fixture.type}`,
      runProjectCapabilityCopy(
        descriptor,
        roots,
        env,
        { ...fixture, mode: "iterate" },
        timeoutMs,
      ),
    );
    const result = JSON.parse(iterated.stdout);
    const entry = result.capability?.files?.find((file) => file.relPath);
    if (entry?.state !== "preserved_project_copy") {
      throw new Error(`project capability iterate ${fixture.type} did not report preserved_project_copy`);
    }
    if (readFileSync(fixture.target, "utf8") !== expected) {
      throw new Error(`global update or iterate overwrote the project-owned ${fixture.type}`);
    }
  }

  const manifest = JSON.parse(readFileSync(capabilityManifestPath, "utf8"));
  if (manifest.capabilities?.length !== fixtures.length) {
    throw new Error("project capability ownership manifest does not contain all three capability types");
  }
  if (
    !manifest.capabilities.every(
      (entry) =>
        entry.ownership === "project" &&
        entry.dependencyUpdatePolicy === "preserve_project_copy" &&
        entry.detachedFromDependencyUpdates === true,
    )
  ) {
    throw new Error("project capability ownership manifest lost preserve_project_copy policy");
  }
  return {
    status: "passed",
    publicEntry: "meta-kim project capability copy",
    types: fixtures.map((fixture) => fixture.type),
    dependencyUpdateExitCode: dependencyUpdate.status,
    projectCopiesPreserved: true,
    manifest: ".meta-kim/state/default/project-capabilities.json",
    projectAwareGlobalUpdate: {
      status: "passed",
      targets: [...PACKED_USER_TARGETS],
      publicEntry: "meta-kim update --scope global",
      cwd: "bootstrapped_project",
      bootstrapManifestValidBefore: Boolean(bootstrapBefore.manifest),
      bootstrapManifestVersionAfter: bootstrapAfter.manifest.metaKimVersion,
      globalHomesUpdated: true,
      managedProjectionReplaceVerified: true,
      managedTextMergeVerified: true,
      unknownProjectFilePreserved: true,
      runtimeSedimentedCopiesPreserved: true,
      projectProjectionModePreserved: true,
      diagnostics: dependencyUpdate.boundedDiagnostics,
    },
    globalReuse,
  };
}

function runProjectPackageLane({ descriptor, roots, env, timeoutMs, onProgress }) {
  writeFileSync(path.join(roots.projectDir, "user-owned-project.txt"), "project-owned\n", "utf8");
  const projectArtifacts = expectedProjectArtifacts(roots.projectDir);
  const modes = [];
  let firstProof = null;
  for (const ordinal of [1, 2]) {
    emit(onProgress, { event: "packed_project_mode_start", mode: ordinal === 1 ? "install" : "update", ordinal });
    const mode = ordinal === 1 ? "install" : "update";
    const result = runInstalledPublicProjectCli(descriptor, roots, env, mode, timeoutMs);
    if (result.status !== 0 || result.error) throw commandFailure(`packed project ${mode}`, result);
    const proof = artifactFingerprint(projectArtifacts);
    if (readFileSync(path.join(roots.projectDir, "user-owned-project.txt"), "utf8") !== "project-owned\n") {
      throw new Error("project bootstrap changed the user-owned project sentinel");
    }
    const record = {
      mode: ordinal === 1 ? "install" : "update",
      ordinal,
      status: "passed",
      artifactCount: Object.keys(proof).length,
      outputHash: sha256(`${result.stdout ?? ""}\n${result.stderr ?? ""}`),
    };
    if (ordinal === 1) {
      firstProof = proof;
    } else {
      const idempotence = stableArtifactProof(firstProof, proof);
      if (!idempotence.stable) {
        throw new Error(
          `second packed project update changed managed artifacts: ${formatArtifactChanges(idempotence.changed)}`,
        );
      }
      record.idempotence = idempotence;
    }
    modes.push(record);
    emit(onProgress, { event: "packed_project_mode_complete", ...record });
  }
  return {
    status: "passed",
    targets: [...PACKED_USER_TARGETS],
    modes,
    projectDirOutsidePackage: true,
    userOwnedProjectContentPreserved: true,
    publicScopeSelection: "--scope project",
  };
}

function emit(onProgress, payload) {
  if (typeof onProgress !== "function") return;
  try {
    onProgress(payload);
  } catch {
    // Progress is diagnostic only.
  }
}

function runCurrentPackageLane({
  packageInfo,
  root,
  environment,
  timeoutMs,
  onProgress,
  stopAfterGlobalIdempotence = false,
}) {
  const roots = makeIsolatedRoots(root, "current-package");
  const env = isolatedEnvironment(environment, roots);
  const descriptor = installPackedCli(packageInfo, roots, env, timeoutMs);
  const artifacts = expectedArtifacts(roots);
  let automaticOrphanBootRepair = {
    status: "not_applicable",
    reason: "windows_startup_vbs_only",
  };
  let seededOrphanVbs = null;
  if (process.platform === "win32") {
    const bootDescriptors = resolveMcpMemoryBootArtifactDescriptors({
      homeRoot: roots.userHome,
      platformName: "win32",
    });
    const startup = bootDescriptors.find((entry) => entry.id === "windows-startup");
    const command = bootDescriptors.find((entry) => entry.id === "windows-command");
    mkdirSync(path.dirname(startup.path), { recursive: true });
    writeFileSync(
      startup.path,
      renderCurrentWindowsMcpMemoryStartupVbsBytes({ commandPath: command.path }),
    );
    if (existsSync(command.path)) {
      throw new Error("packed automatic repair fixture unexpectedly has a command target");
    }
    seededOrphanVbs = startup.path;
  }
  const modes = [];
  let firstUpdateProof = null;
  let firstUpdateManifest = null;
  for (const mode of ["install", "update", "update"]) {
    emit(onProgress, { event: "packed_user_mode_start", mode, ordinal: modes.length + 1 });
    const result = runInstalledPublicCli(descriptor, roots, env, mode, timeoutMs);
    const record = {
      mode,
      ordinal: modes.length + 1,
      status: result.status === 0 && !result.error ? "passed" : "failed",
      exitCode: result.status,
      outputHash: sha256(`${result.stdout ?? ""}\n${result.stderr ?? ""}`),
      error: result.error?.message ?? null,
    };
    modes.push(record);
    if (record.status !== "passed") throw commandFailure(`packed user ${mode}`, result);
    if (mode === "install" && seededOrphanVbs) {
      if (existsSync(seededOrphanVbs)) {
        throw new Error("packed installed public CLI left the exact orphan Startup VBS");
      }
      automaticOrphanBootRepair = {
        status: "passed",
        evidenceTier: "packed_isolated_installed_public_cli",
        fixture: "exact_startup_vbs_with_missing_command_target",
        removedBeforeDependencyWork: true,
      };
    }
    const cwdProof = assertOrdinaryCwdUntouched(roots.ordinaryCwd);
    const currentProof = artifactFingerprint(artifacts);
    const currentManifest = normalizedManifest(artifacts.manifest, roots.userHome);
    record.artifactCount = Object.keys(currentProof).length;
    record.cwdProof = cwdProof;
    if (mode === "update" && firstUpdateProof === null) {
      firstUpdateProof = currentProof;
      firstUpdateManifest = currentManifest;
    } else if (mode === "update") {
      const idempotence = stableArtifactProof(firstUpdateProof, currentProof, {
        ignoreIds: ["manifest"],
      });
      if (!idempotence.stable) {
        throw new Error(
          `second packed user update changed managed artifacts: ${formatArtifactChanges(idempotence.changed)}`,
        );
      }
      if (JSON.stringify(firstUpdateManifest) !== JSON.stringify(currentManifest)) {
        throw new Error("second packed user update changed global manifest semantics");
      }
      record.idempotence = { ...idempotence, manifestStable: true };
    }
    emit(onProgress, { event: "packed_user_mode_complete", ...record });
  }
  const packedUninstall = runPackedUninstallLane({
    packageInfo,
    root,
    environment,
    timeoutMs,
    onProgress,
  });
  if (stopAfterGlobalIdempotence) {
    return {
      status: "passed",
      targets: [...PACKED_USER_TARGETS],
      modes,
      packageSha256: packageInfo.tarballSha256,
      cwdBoundary: "ordinary_cwd_untouched",
      idempotentSecondUpdate: true,
      freshGlobalUpdateCreatedProjectCopies: false,
      stoppedAfterGlobalIdempotence: true,
      installedCliEntrypoints: true,
      automaticOrphanBootRepair,
      packedUninstall,
    };
  }
  const projectPackage = runProjectPackageLane({
    descriptor,
    roots,
    env,
    timeoutMs,
    onProgress,
  });
  const runtimeSedimentation = runRuntimeSedimentationLane({
    descriptor,
    roots,
    env,
    timeoutMs,
  });
  const portableRuntimePrepared = runPortableRuntimePreparation({
    packageInfo,
    descriptor,
    roots,
    env,
    timeoutMs,
  });
  emit(onProgress, {
    event: "packed_legacy_mcp_migration_complete",
    ...portableRuntimePrepared.proof.mcpRegistration,
  });
  return {
    status: "passed",
    targets: [...PACKED_USER_TARGETS],
    modes,
    packageSha256: packageInfo.tarballSha256,
    cwdBoundary: "ordinary_cwd_untouched",
    idempotentSecondUpdate: true,
    automaticOrphanBootRepair,
    freshGlobalUpdateCreatedProjectCopies: false,
    projectPackage,
    runtimeSedimentation,
    installedCliEntrypoints: true,
    packedUninstall,
    portableRuntime: portableRuntimePrepared.proof,
    _portableRuntimeContext: portableRuntimePrepared.context,
  };
}

function extractHistoricalSource(repoRoot, root, historicalRef, environment, timeoutMs) {
  const historicalRoot = path.join(root, "historical-source");
  const archivePath = path.join(historicalRoot, "source.tar");
  const sourceRoot = path.join(historicalRoot, "source");
  mkdirSync(sourceRoot, { recursive: true });
  requireSuccess(
    `git archive ${historicalRef}`,
    run("git", ["archive", "--format=tar", `--output=${archivePath}`, historicalRef], {
      cwd: repoRoot,
      env: environment,
      timeoutMs,
    }),
  );
  requireSuccess(
    `extract ${historicalRef}`,
    run("tar", ["-xf", archivePath, "-C", sourceRoot], {
      cwd: repoRoot,
      env: environment,
      timeoutMs,
    }),
  );
  return sourceRoot;
}

function runHistoricalUpdateLane({
  repoRoot,
  packageInfo,
  root,
  environment,
  timeoutMs,
  historicalRef,
}) {
  const historicalSource = extractHistoricalSource(
    repoRoot,
    root,
    historicalRef,
    environment,
    timeoutMs,
  );
  const historicalPackage = packAndExtract({
    sourceRoot: historicalSource,
    destinationRoot: path.join(root, "historical-package"),
    environment,
    timeoutMs,
  });
  const roots = makeIsolatedRoots(root, "historical-update");
  const env = isolatedEnvironment(environment, roots);
  const artifacts = expectedArtifacts(roots);
  const historicalDescriptor = installPackedCli(
    historicalPackage,
    roots,
    env,
    timeoutMs,
  );
  requireSuccess(
    `${historicalRef} installed CLI global state seed`,
    runInstalledPublicCli(
      historicalDescriptor,
      roots,
      env,
      "install",
      timeoutMs,
    ),
  );
  const before = normalizedManifest(artifacts.manifest, roots.userHome);
  const currentDescriptor = installPackedCli(packageInfo, roots, env, timeoutMs);
  const update = requireSuccess(
    `installed packed user update from ${historicalRef}`,
    runInstalledPublicCli(currentDescriptor, roots, env, "update", timeoutMs),
  );
  assertOrdinaryCwdUntouched(roots.ordinaryCwd);
  const proof = artifactFingerprint(artifacts);
  const after = normalizedManifest(artifacts.manifest, roots.userHome);
  if (before.metaKimVersion === after.metaKimVersion) {
    throw new Error(`${historicalRef} update did not advance the global manifest version`);
  }
  return {
    status: "passed",
    targets: [...PACKED_USER_TARGETS],
    historicalRef,
    completed: true,
    seedMethod: "historical_tarball_installed_cli",
    updateMethod: "current_tarball_installed_cli",
    checkMethod: "current_update_internal_global_check_plus_exact_artifact_manifest_validation",
    beforeVersion: before.metaKimVersion,
    afterVersion: after.metaKimVersion,
    exitCode: update.status,
    artifactCount: Object.keys(proof).length,
    cwdBoundary: "ordinary_cwd_untouched",
  };
}

export function runPackedUserInstallUpdateAcceptance({
  repoRoot = process.cwd(),
  environment = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  historicalRef = null,
  includeHistorical = true,
  allowMissingHistory = false,
  onProgress = null,
  stopAfterGlobalIdempotence = false,
} = {}) {
  let currentVersionTagCheck = null;
  let tempRoot = null;
  emit(onProgress, { event: "packed_user_acceptance_start", targets: [...PACKED_USER_TARGETS] });
  try {
    currentVersionTagCheck = assertCurrentVersionTagAbsent({
      repoRoot,
      environment,
      timeoutMs,
    });
    tempRoot = realpathSync.native(
      mkdtempSync(path.join(os.tmpdir(), "meta-kim-packed-user-")),
    );
    let historicalResolution = null;
    let historicalResolutionError = null;
    if (!stopAfterGlobalIdempotence && includeHistorical) {
      try {
        historicalResolution = resolveHistoricalUpdateRef({
          repoRoot,
          environment,
          timeoutMs,
          overrideRef: historicalRef ?? environment[HISTORICAL_REF_ENV_KEY] ?? null,
        });
      } catch (error) {
        if (!allowMissingHistory) throw error;
        historicalResolutionError = error.message;
      }
    }
    const packageInfo = packAndExtract({
      sourceRoot: repoRoot,
      destinationRoot: path.join(tempRoot, "candidate"),
      environment,
      timeoutMs,
    });
    const currentPackage = runCurrentPackageLane({
      packageInfo,
      root: tempRoot,
      environment,
      timeoutMs,
      onProgress,
      stopAfterGlobalIdempotence,
    });
    const historicalUpdate = stopAfterGlobalIdempotence
      ? {
          status: "not_requested",
          historicalRef: historicalResolution?.ref ?? historicalRef,
          completed: false,
          reason: "stopped_after_global_idempotence",
        }
      : includeHistorical && historicalResolution
      ? runHistoricalUpdateLane({
          repoRoot,
          packageInfo,
          root: tempRoot,
          environment,
          timeoutMs,
          historicalRef: historicalResolution.ref,
        })
      : {
          status: historicalResolutionError ? "not_available" : "not_requested",
          historicalRef: historicalResolution?.ref ?? historicalRef,
          completed: false,
          reason: historicalResolutionError
            ? "historical_release_baseline_unavailable"
            : "historical_lane_disabled",
          error: historicalResolutionError,
        };
    if (currentPackage._portableRuntimeContext) {
      const prepared = {
        proof: currentPackage.portableRuntime,
        context: currentPackage._portableRuntimeContext,
      };
      prepared.context.advisorySnapshot = copyRuntimeCapabilityObservationSnapshot({
        sourceProjectRoot: packageInfo.sourceRoot,
        targetProjectRoot: prepared.context.roots.ordinaryCwd,
        sourceUserHome: os.homedir(),
        targetUserHome: prepared.context.roots.userHome,
      });
      const transientPackage = prepareTransientPackageRoot({
        packageInfo,
        descriptor: prepared.context.descriptor,
        roots: prepared.context.roots,
        env: prepared.context.hookEnv,
        timeoutMs,
      });
      currentPackage.portableRuntime = finalizePortableRuntimeProof(
        prepared,
        packageInfo,
        timeoutMs,
      );
      currentPackage.transientPackageRoot = runTransientPackageRootLane({
        packageInfo,
        descriptor: prepared.context.descriptor,
        roots: prepared.context.roots,
        env: prepared.context.hookEnv,
        seeded: prepared.context.seeded,
        timeoutMs,
        transientPackage,
      });
      delete currentPackage._portableRuntimeContext;
    }
    const releaseGradeEligible =
      !stopAfterGlobalIdempotence &&
      includeHistorical &&
      historicalUpdate.status === "passed";
    const status = releaseGradeEligible ? "passed" : "diagnostic_passed";
    const result = {
      status,
      releaseGradeEligible,
      sourcePolicy: "npm_pack_installed_public_cli",
      currentVersionTagAbsent: currentVersionTagCheck.currentVersionTagAbsent,
      currentVersionTagCheck,
      currentPackage,
      historicalUpdate: {
        ...historicalUpdate,
        resolution: historicalResolution,
      },
      error: null,
    };
    emit(onProgress, { event: "packed_user_acceptance_complete", status });
    return result;
  } catch (error) {
    const result = {
      status: "failed",
      releaseGradeEligible: false,
      sourcePolicy: "npm_pack_installed_public_cli",
      currentVersionTagAbsent:
        currentVersionTagCheck?.currentVersionTagAbsent === true,
      currentVersionTagCheck,
      currentPackage: null,
      historicalUpdate: null,
      boundedDiagnostics: error.boundedDiagnostics ?? null,
      error: error.message,
    };
    emit(onProgress, {
      event: "packed_user_acceptance_complete",
      status: "failed",
      error: error.message,
    });
    return result;
  } finally {
    if (tempRoot) {
      try {
        rmSync(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
      } catch (error) {
        if (!["EBUSY", "EPERM"].includes(error?.code)) throw error;
        process.stderr.write(
          `[packed-user-acceptance] temp cleanup deferred because a child still holds a file: ${tempRoot}\n`,
        );
      }
    }
  }
}

function main() {
  const includeHistorical = !process.argv.includes("--skip-history");
  const allowMissingHistory = process.argv.includes("--allow-missing-history");
  const stopAfterGlobalIdempotence = process.argv.includes("--stop-after-global-idempotence");
  const result = runPackedUserInstallUpdateAcceptance({
    includeHistorical,
    allowMissingHistory,
    stopAfterGlobalIdempotence,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.status === "failed" ? 1 : 0);
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();
