import { createHash } from "node:crypto";
import path from "node:path";

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireSafeToken(value, label) {
  if (typeof value !== "string" || !value || /[\s\0\r\n]/u.test(value)) {
    throw new Error(`${label} must be a non-empty token without whitespace.`);
  }
  return value;
}

export function mcpDefinitionFingerprint(definition) {
  return createHash("sha256").update(stableJson(definition)).digest("hex");
}

export function resolvePackageCliName(packageManifest) {
  const names = Object.keys(packageManifest?.bin ?? {});
  if (names.length !== 1) {
    throw new Error(`Meta_Kim package must expose exactly one CLI bin; found ${names.length}.`);
  }
  return requireSafeToken(names[0], "package bin name");
}

export function resolvePortableMetaKimPackageIdentity(packageManifest, distribution) {
  const packageName = requireSafeToken(packageManifest?.name, "package name");
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(packageName)) {
    throw new Error("package name is not a safe npm package identifier.");
  }
  const packageVersion = requireSafeToken(packageManifest?.version, "package version");
  const cliName = resolvePackageCliName(packageManifest);
  const distributionSpec = requireSafeToken(
    distribution?.project?.npxSpec,
    "distribution.project.npxSpec",
  );
  let packageSpec;
  if (packageManifest.private !== true) {
    packageSpec = `${packageName}@${packageVersion}`;
  } else {
    if (distributionSpec.includes("#")) {
      throw new Error("Private package distribution.project.npxSpec must not contain a mutable or preselected ref.");
    }
    packageSpec = `${distributionSpec}#v${packageVersion}`;
  }
  return Object.freeze({ packageName, packageVersion, cliName, packageSpec });
}

export function buildPortableMetaKimMcpServer(identity, platform = process.platform) {
  if (!isPlainObject(identity)) throw new Error("A portable package identity is required.");
  const packageSpec = requireSafeToken(identity.packageSpec, "portable package spec");
  const cliName = requireSafeToken(identity.cliName, "portable package CLI name");
  return {
    type: "stdio",
    command: platform === "win32" ? "npx.cmd" : "npx",
    args: ["--yes", packageSpec, cliName, "mcp", "serve"],
    env: {},
  };
}

export function buildDurableMetaKimMcpServer(nodePath, cliPath) {
  const absoluteOnAnySupportedPlatform = (value) =>
    typeof value === "string" && (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value));
  if (!absoluteOnAnySupportedPlatform(nodePath) || !absoluteOnAnySupportedPlatform(cliPath)) {
    throw new Error("Durable MCP projection requires absolute Node and package CLI paths.");
  }
  return {
    type: "stdio",
    command: nodePath,
    args: [cliPath, "mcp", "serve"],
    env: {},
  };
}

export function resolveDurableMetaKimRuntimeLayout(
  runtimeBaseDir,
  identity,
  packageManifest,
  nodePath = process.execPath,
) {
  if (!path.isAbsolute(runtimeBaseDir)) throw new Error("Runtime base directory must be absolute.");
  const binRelativePath = packageManifest?.bin?.[identity.cliName];
  if (typeof binRelativePath !== "string" || path.isAbsolute(binRelativePath)) {
    throw new Error(`Package bin ${identity.cliName} must resolve to a relative file.`);
  }
  const normalizedBin = path.normalize(binRelativePath);
  if (normalizedBin === ".." || normalizedBin.startsWith(`..${path.sep}`)) {
    throw new Error(`Package bin ${identity.cliName} escapes the package root.`);
  }
  const packageSegments = identity.packageName.split("/");
  const runtimeRoot = path.join(runtimeBaseDir, ".meta-kim", "runtime");
  const bundleDir = path.join(runtimeRoot, ...packageSegments, identity.packageVersion);
  const packageRoot = path.join(bundleDir, "node_modules", ...packageSegments);
  const cliPath = path.join(packageRoot, normalizedBin);
  const serverPath = path.join(packageRoot, "scripts", "mcp", "meta-runtime-server.mjs");
  return Object.freeze({
    runtimeRoot,
    bundleDir,
    packageRoot,
    packageManifestPath: path.join(packageRoot, "package.json"),
    cliPath,
    serverPath,
    definition: buildDurableMetaKimMcpServer(nodePath, cliPath),
  });
}

export function isPortableMetaKimMcpDefinition(definition, identity, platform = process.platform) {
  return isPlainObject(definition) &&
    mcpDefinitionFingerprint(definition) ===
      mcpDefinitionFingerprint(buildPortableMetaKimMcpServer(identity, platform));
}

export function legacyMetaKimMcpAliases(canonicalName) {
  return new Set([canonicalName, canonicalName.replaceAll("-", "_")]);
}

function isStrictLegacyMetaKimMcpDefinition(definition, legacyScriptSuffix) {
  if (!isPlainObject(definition) || !legacyScriptSuffix) return false;
  if (definition.type !== undefined && definition.type !== "stdio") return false;
  if (definition.env !== undefined && (!isPlainObject(definition.env) || Object.keys(definition.env).length > 0)) {
    return false;
  }
  if (!Array.isArray(definition.args)) return false;

  let scriptArg = null;
  if (/^(?:node|node\.exe)$/iu.test(definition.command ?? "")) {
    if (definition.args.length !== 1) return false;
    [scriptArg] = definition.args;
  } else if (/^(?:cmd|cmd\.exe)$/iu.test(definition.command ?? "")) {
    const args = [...definition.args];
    const seenFlags = new Set();
    while (/^\/(?:d|s)$/iu.test(args[0] ?? "")) {
      const flag = args.shift().toLowerCase();
      if (seenFlags.has(flag)) return false;
      seenFlags.add(flag);
    }
    if (
      args.length !== 3 ||
      !/^\/c$/iu.test(args[0] ?? "") ||
      !/^(?:node|node\.exe)$/iu.test(args[1] ?? "")
    ) {
      return false;
    }
    scriptArg = args[2];
    if (typeof scriptArg !== "string" || /[&|<>^%!\r\n\0]/u.test(scriptArg)) return false;
  } else {
    return false;
  }

  const normalizedArg = String(scriptArg).replace(/\\/g, "/");
  const normalizedSuffix = legacyScriptSuffix.replace(/\\/g, "/").replace(/^\/+/, "");
  const isAbsolute = /^[A-Za-z]:\//u.test(normalizedArg) || normalizedArg.startsWith("/");
  return isAbsolute && normalizedArg.endsWith(`/${normalizedSuffix}`);
}

function unwrapExactWindowsCmdWrapper(definition) {
  if (!isPlainObject(definition) || !isPlainObject(definition.env) || !Array.isArray(definition.args)) {
    return null;
  }
  const commandBase = path.win32.basename(String(definition.command ?? "")).toLowerCase();
  if (commandBase !== "cmd" && commandBase !== "cmd.exe") return null;

  const args = [...definition.args];
  const seenFlags = new Set();
  while (/^\/(?:d|s)$/iu.test(args[0] ?? "")) {
    const flag = args.shift().toLowerCase();
    if (seenFlags.has(flag)) return null;
    seenFlags.add(flag);
  }
  if (!/^\/c$/iu.test(args.shift() ?? "") || args.length < 1) return null;

  const unwrapped = {
    command: args.shift(),
    args,
    env: structuredClone(definition.env),
  };
  if (definition.type !== undefined) unwrapped.type = definition.type;
  return unwrapped;
}

function isExactWindowsCmdWrapperOf(definition, expectedDefinition) {
  if (!isPlainObject(expectedDefinition)) return false;
  const unwrapped = unwrapExactWindowsCmdWrapper(definition);
  return unwrapped !== null &&
    mcpDefinitionFingerprint(unwrapped) === mcpDefinitionFingerprint(expectedDefinition);
}

export function mergeClaudeUserMcpConfig(base, {
  canonicalName,
  portableDefinition,
  identity,
  legacyScriptSuffix,
  managedFingerprints = new Set(),
}) {
  if (!isPlainObject(base)) throw new Error("Claude user configuration must be a plain JSON object.");
  if (Object.hasOwn(base, "mcpServers") && !isPlainObject(base.mcpServers)) {
    throw new Error("Claude user configuration mcpServers must be a plain JSON object.");
  }
  const next = structuredClone(base);
  next.mcpServers = { ...(base.mcpServers ?? {}) };
  const collisions = [];
  let canonicalEquivalent = false;
  for (const alias of legacyMetaKimMcpAliases(canonicalName)) {
    if (!Object.hasOwn(next.mcpServers, alias)) continue;
    const existing = next.mcpServers[alias];
    const fingerprint = isPlainObject(existing) ? mcpDefinitionFingerprint(existing) : null;
    const unwrapped = alias === canonicalName
      ? unwrapExactWindowsCmdWrapper(existing)
      : null;
    const managedUnwrapped = unwrapped !== null &&
      managedFingerprints.has(mcpDefinitionFingerprint(unwrapped));
    const exactWindowsWrapper = alias === canonicalName &&
      isExactWindowsCmdWrapperOf(existing, portableDefinition);
    const proven = alias === canonicalName
      ? fingerprint === mcpDefinitionFingerprint(portableDefinition) ||
        managedFingerprints.has(fingerprint) ||
        managedUnwrapped ||
        exactWindowsWrapper
      : isStrictLegacyMetaKimMcpDefinition(existing, legacyScriptSuffix);
    if (!proven) {
      collisions.push(alias);
      continue;
    }
    if (exactWindowsWrapper) {
      canonicalEquivalent = true;
      continue;
    }
    delete next.mcpServers[alias];
  }
  if (collisions.length === 0 && !canonicalEquivalent) {
    next.mcpServers[canonicalName] = structuredClone(portableDefinition);
  }
  return { config: next, collisions, canonicalEquivalent };
}

export function removeExactManagedMcpFragment(base, name, expectedFingerprint) {
  const next = structuredClone(isPlainObject(base) ? base : {});
  if (!isPlainObject(next.mcpServers)) return { config: next, removed: false };
  const definition = next.mcpServers[name];
  if (!definition || mcpDefinitionFingerprint(definition) !== expectedFingerprint) {
    return { config: next, removed: false };
  }
  delete next.mcpServers[name];
  return { config: next, removed: true };
}
