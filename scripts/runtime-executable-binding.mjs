import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { resolveWindowsCliLaunchDescriptor } from "./runtime-cli-invocation.mjs";

const INVENTORY_SCHEMA = "meta-kim-runtime-launch-inventory-v2";
const INVENTORY_PURPOSE = "setup_inventory_and_drift_detection";
const INVENTORY_TRUST_BOUNDARY = "Same-user writable setup inventory for launch consistency and drift detection only; it is not a same-user trust root and does not eliminate TOCTOU between validation and the kernel opening a file.";

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function executableIdentity(filePath) {
  if (!path.isAbsolute(filePath)) throw new Error("runtime launch component must be an absolute path");
  const resolved = realpathSync.native(filePath);
  const stat = lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("runtime launch component must resolve to a regular file");
  return { realpath: resolved, sha256: sha256File(resolved), size: stat.size };
}

function pathResolutions(commandName) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const locatorArgs = process.platform === "win32"
    ? [commandName]
    : ["-a", commandName];
  const result = spawnSync(locator, locatorArgs, { encoding: "utf8", windowsHide: true, shell: false });
  if (result.status !== 0) return [];
  return String(result.stdout).split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
}

function normalizePathResolutions(resolved) {
  const values = Array.isArray(resolved) ? resolved : [resolved];
  const seen = new Set();
  const candidates = [];
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    const candidate = value.trim();
    const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return candidates;
}

function candidateFailure(candidate, error) {
  const reason = error?.message ?? String(error);
  return `${candidate}: ${reason}`;
}

function rawLaunchDescriptor(candidate) {
  if (!candidate || !path.isAbsolute(candidate)) throw new Error("runtime command discovery did not return an absolute entry");
  if (process.platform === "win32") return resolveWindowsCliLaunchDescriptor(candidate);
  return {
    platform: process.platform,
    source: "native_executable",
    discoveredEntry: candidate,
    shim: null,
    launcher: candidate,
    jsEntry: null,
    argsPrefix: [],
  };
}

function identityLaunchDescriptor(candidate) {
  const raw = rawLaunchDescriptor(candidate);
  const identified = {
    platform: raw.platform,
    source: raw.source,
    discoveredEntry: executableIdentity(raw.discoveredEntry),
    shim: raw.shim ? executableIdentity(raw.shim) : null,
    launcher: executableIdentity(raw.launcher),
    jsEntry: raw.jsEntry ? executableIdentity(raw.jsEntry) : null,
    argsPrefix: [...raw.argsPrefix],
  };
  if (identified.jsEntry && identified.argsPrefix[0] !== identified.jsEntry.realpath) {
    throw new Error("runtime launch descriptor JS entry and argsPrefix disagree");
  }
  return identified;
}

function validateStoredIdentity(stored, label) {
  if (!stored || typeof stored.realpath !== "string" || !/^[a-f0-9]{64}$/u.test(String(stored.sha256 ?? "")) || !Number.isSafeInteger(stored.size) || stored.size < 0) {
    throw new Error(`${label} identity is invalid`);
  }
  const current = executableIdentity(stored.realpath);
  if (current.realpath !== stored.realpath || current.sha256 !== stored.sha256 || current.size !== stored.size) {
    throw new Error(`${label} identity changed`);
  }
  return current;
}

function validateStoredDescriptor(descriptor, label) {
  if (!descriptor || !["win32", "darwin", "linux", "aix", "freebsd", "openbsd", "sunos"].includes(descriptor.platform) || typeof descriptor.source !== "string" || !Array.isArray(descriptor.argsPrefix)) {
    throw new Error(`${label} descriptor is invalid`);
  }
  const current = {
    platform: descriptor.platform,
    source: descriptor.source,
    discoveredEntry: validateStoredIdentity(descriptor.discoveredEntry, `${label} discovered entry`),
    shim: descriptor.shim ? validateStoredIdentity(descriptor.shim, `${label} shim`) : null,
    launcher: validateStoredIdentity(descriptor.launcher, `${label} launcher`),
    jsEntry: descriptor.jsEntry ? validateStoredIdentity(descriptor.jsEntry, `${label} JS entry`) : null,
    argsPrefix: [...descriptor.argsPrefix],
  };
  if (current.argsPrefix.some((entry) => typeof entry !== "string") || (current.jsEntry && current.argsPrefix[0] !== current.jsEntry.realpath)) {
    throw new Error(`${label} argsPrefix is invalid`);
  }
  return current;
}

function normalizeRuntime(runtime) {
  if (runtime === "claude") return "claude_code";
  if (["claude_code", "codex"].includes(runtime)) return runtime;
  throw new Error(`unsupported runtime launch inventory target: ${runtime}`);
}

function validateInventoryHeader(manifest, profile, label) {
  if (
    manifest?.schemaVersion !== INVENTORY_SCHEMA ||
    manifest?.profile !== profile ||
    manifest?.purpose !== INVENTORY_PURPOSE ||
    manifest?.executionAuthority !== false ||
    manifest?.sameUserTrustRoot !== false ||
    manifest?.eliminatesTOCTOU !== false ||
    manifest?.trustBoundary !== INVENTORY_TRUST_BOUNDARY ||
    !manifest?.bindings || typeof manifest.bindings !== "object" || Array.isArray(manifest.bindings)
  ) throw new Error(`${label} runtime launch inventory is invalid`);
  return manifest;
}

function readInventoryManifest(manifestPath, profile, label) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`${label} runtime launch inventory is invalid: ${error.message}`);
  }
  return validateInventoryHeader(manifest, profile, label);
}

function validateBinding(binding, runtime, label) {
  const target = runtime === "claude_code" ? "claude" : "codex";
  if (
    binding?.target !== target ||
    binding?.runtime !== runtime ||
    binding?.recordedBy !== "setup_runtime_launch_inventory" ||
    binding?.purpose !== INVENTORY_PURPOSE ||
    binding?.executionAuthority !== false ||
    binding?.trustBoundary !== INVENTORY_TRUST_BOUNDARY ||
    typeof binding.version !== "string" || !binding.version.trim()
  ) throw new Error(`${label} runtime launch binding is invalid`);
  return { ...binding, launchDescriptor: validateStoredDescriptor(binding.launchDescriptor, `${label} runtime launch binding`) };
}

function descriptorMatches(left, right) {
  const pathOf = (value) => value?.realpath ?? null;
  return left.platform === right.platform &&
    left.source === right.source &&
    pathOf(left.discoveredEntry) === pathOf(right.discoveredEntry) &&
    pathOf(left.shim) === pathOf(right.shim) &&
    pathOf(left.launcher) === pathOf(right.launcher) &&
    pathOf(left.jsEntry) === pathOf(right.jsEntry) &&
    JSON.stringify(left.argsPrefix) === JSON.stringify(right.argsPrefix);
}

export function readSetupRuntimeLaunchInventory({ root = os.homedir(), profile = "default", runtimes = ["claude_code", "codex"] } = {}) {
  if (!path.isAbsolute(root)) throw new Error("runtime launch inventory root must be absolute");
  const manifestPath = path.join(root, ".meta-kim", "state", profile, "runtime-capability-producers", "host-executable-bindings.json");
  if (!existsSync(manifestPath)) throw new Error("setup runtime launch inventory is unavailable");
  const manifest = readInventoryManifest(manifestPath, profile, "setup");
  const bindings = {};
  for (const requested of runtimes) {
    const runtime = normalizeRuntime(requested);
    const binding = manifest.bindings[runtime];
    if (!binding) throw new Error(`setup runtime launch inventory is missing ${runtime}`);
    bindings[runtime] = validateBinding(binding, runtime, "setup");
  }
  return { ...manifest, manifestPath, bindings };
}

export function loadSetupBoundRuntimeExecutable({ projectRoot, profile = "default", runtime, pathResolver = pathResolutions, globalRoot = os.homedir() } = {}) {
  const normalizedRuntime = normalizeRuntime(runtime);
  const projectManifest = path.join(projectRoot, ".meta-kim", "state", profile, "runtime-capability-producers", "host-executable-bindings.json");
  const globalManifest = path.join(globalRoot, ".meta-kim", "state", profile, "runtime-capability-producers", "host-executable-bindings.json");
  let manifestPath;
  let inventoryScope;
  let manifest;
  if (existsSync(projectManifest)) {
    const projectInventory = readInventoryManifest(projectManifest, profile, "project");
    if (Object.hasOwn(projectInventory.bindings, normalizedRuntime)) {
      manifestPath = projectManifest;
      inventoryScope = "project";
      manifest = projectInventory;
    }
  }
  if (!manifest) {
    if (!existsSync(globalManifest)) throw new Error("setup runtime launch inventory is unavailable");
    manifestPath = globalManifest;
    inventoryScope = "global";
    manifest = readInventoryManifest(globalManifest, profile, "global");
  }
  const binding = validateBinding(manifest.bindings[normalizedRuntime], normalizedRuntime, inventoryScope);
  const commandName = normalizedRuntime === "claude_code" ? "claude" : "codex";
  const candidates = normalizePathResolutions(pathResolver(commandName));
  if (candidates.length === 0) throw new Error(`current PATH no longer resolves ${commandName}`);
  const failures = [];
  let matched = false;
  for (const candidate of candidates) {
    try {
      const currentDescriptor = identityLaunchDescriptor(candidate);
      if (descriptorMatches(binding.launchDescriptor, currentDescriptor)) {
        matched = true;
        break;
      }
      failures.push(`${candidate}: descriptor does not match the stored binding`);
    } catch (error) {
      failures.push(candidateFailure(candidate, error));
    }
  }
  if (!matched) {
    throw new Error(
      `${inventoryScope} runtime launch binding does not match any shell-free PATH candidate for ${commandName}: ${failures.join("; ")}`,
    );
  }
  return {
    ...binding.launchDescriptor.launcher,
    commandName,
    argsPrefix: [...binding.launchDescriptor.argsPrefix],
    launchDescriptor: binding.launchDescriptor,
    bindingSource: "setup_runtime_launch_inventory",
    inventoryScope,
    inventoryManifestPath: manifestPath,
    purpose: INVENTORY_PURPOSE,
    executionAuthority: false,
    trustBoundary: INVENTORY_TRUST_BOUNDARY,
  };
}

export function revalidateRuntimeExecutableIdentity(identity) {
  if (identity?.launchDescriptor) {
    const current = validateStoredDescriptor(identity.launchDescriptor, "runtime launch inventory");
    return { ...identity, ...current.launcher, launchDescriptor: current };
  }
  const current = executableIdentity(identity.realpath);
  if (current.realpath !== identity.realpath || current.sha256 !== identity.sha256 || current.size !== identity.size) {
    throw new Error("runtime executable identity changed during host invocation");
  }
  return current;
}

function atomicWriteJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, filePath);
}

export function resolveSetupRuntimeLaunchInventoryRoots({
  installScope,
  deployments = [],
  homeRoot = os.homedir(),
  callerCwd = process.cwd(),
} = {}) {
  if (!["global", "project"].includes(installScope)) {
    throw new Error("runtime launch inventory install scope is invalid");
  }
  const deploymentRoots = deployments.map((candidate) =>
    typeof candidate === "string" ? candidate : candidate?.targetDir,
  );
  const candidates = installScope === "global"
    ? [homeRoot, ...deploymentRoots]
    : (deploymentRoots.length > 0 ? deploymentRoots : [callerCwd]);
  const seen = new Set();
  const roots = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
      throw new Error("runtime launch inventory root must be absolute");
    }
    const resolved = path.resolve(candidate);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(resolved);
  }
  return roots;
}

export function recordSetupRuntimeExecutableBindings({
  roots,
  profile = "default",
  targets,
  pathResolver = pathResolutions,
  versionRunner = (launcher, args) => spawnSync(launcher, args, { encoding: "utf8", windowsHide: true, shell: false }),
} = {}) {
  if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(profile) || profile === "." || profile === "..") {
    throw new Error("runtime launch inventory profile is invalid");
  }
  const selected = [...new Set(targets ?? [])].filter((target) => ["claude", "codex"].includes(target));
  if (selected.length === 0) throw new Error("at least one supported runtime launch inventory target is required");
  const bindings = {};
  for (const target of selected) {
    const runtime = target === "claude" ? "claude_code" : "codex";
    const candidates = normalizePathResolutions(pathResolver(target));
    if (candidates.length === 0) throw new Error(`selected runtime executable is unavailable: ${target}`);
    const failures = [];
    let selectedCandidate = null;
    for (const candidate of candidates) {
      try {
        const launchDescriptor = identityLaunchDescriptor(candidate);
        const version = versionRunner(launchDescriptor.launcher.realpath, [...launchDescriptor.argsPrefix, "--version"], launchDescriptor);
        if (version.status !== 0) {
          const detail = String(version.stderr || version.stdout || version.error?.message || "no diagnostic output").trim().split(/\r?\n/u)[0];
          throw new Error(`version probe exited ${version.status ?? "without status"}: ${detail}`);
        }
        const versionText = String(version.stdout || version.stderr || "").trim().split(/\r?\n/u)[0];
        if (!versionText) throw new Error("version probe returned no version");
        selectedCandidate = { launchDescriptor, versionText };
        break;
      } catch (error) {
        failures.push(candidateFailure(candidate, error));
      }
    }
    if (!selectedCandidate) {
      throw new Error(
        `selected runtime executable has no usable PATH candidate: ${target}; ${failures.join("; ")}`,
      );
    }
    const { launchDescriptor, versionText } = selectedCandidate;
    bindings[runtime] = {
      target,
      runtime,
      recordedBy: "setup_runtime_launch_inventory",
      purpose: INVENTORY_PURPOSE,
      executionAuthority: false,
      trustBoundary: INVENTORY_TRUST_BOUNDARY,
      launchDescriptor,
      version: versionText,
      recordedAt: new Date().toISOString(),
    };
  }
  const written = [];
  const normalizedRoots = [...new Set((roots ?? []).map((root) => {
    if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("runtime launch inventory root must be absolute");
    const resolved = realpathSync.native(root);
    if (!lstatSync(resolved).isDirectory()) throw new Error("runtime launch inventory root must be a directory");
    return resolved;
  }))];
  if (normalizedRoots.length === 0) throw new Error("at least one runtime launch inventory root is required");
  for (const root of normalizedRoots) {
    const manifestPath = path.join(root, ".meta-kim", "state", profile, "runtime-capability-producers", "host-executable-bindings.json");
    let retainedBindings = {};
    if (existsSync(manifestPath)) {
      retainedBindings = readInventoryManifest(manifestPath, profile, "existing").bindings;
    }
    atomicWriteJson(manifestPath, {
      schemaVersion: INVENTORY_SCHEMA,
      profile,
      purpose: INVENTORY_PURPOSE,
      executionAuthority: false,
      sameUserTrustRoot: false,
      eliminatesTOCTOU: false,
      trustBoundary: INVENTORY_TRUST_BOUNDARY,
      bindings: { ...retainedBindings, ...bindings },
    });
    written.push(manifestPath);
  }
  return { profile, targets: selected, bindings, written, purpose: INVENTORY_PURPOSE, executionAuthority: false };
}
