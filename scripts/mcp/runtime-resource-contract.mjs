import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  HOST_SUPPORT_VALUES,
  ROUTE_ELIGIBILITY_VALUES,
  RUNTIME_CAPABILITY_MODES,
  aggregateLegacyCapabilitySummary,
} from "../runtime-capability-claims.mjs";
import { validateRuntimeEvidenceLedger } from "../runtime-capability-evidence.mjs";

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

const unsafeObjectKeys = new Set(["__proto__", "prototype", "constructor"]);

function assertNoUnsafeObjectKeys(value, sourceLabel) {
  if (Array.isArray(value)) {
    value.forEach((entry) => assertNoUnsafeObjectKeys(entry, sourceLabel));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (unsafeObjectKeys.has(key)) {
      throw new Error(`${sourceLabel} contains an unsafe object key.`);
    }
    assertNoUnsafeObjectKeys(entry, sourceLabel);
  }
}

function assertInsideRoot(filePath, packageRoot) {
  const absolutePath = path.resolve(filePath);
  const absoluteRoot = path.resolve(packageRoot);
  const relative = path.relative(absoluteRoot, absolutePath);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Required MCP resource escapes its package root: ${filePath}`);
  }
  return absolutePath;
}

export async function readRequiredPackagedText(filePath, {
  packageRoot,
  label = "MCP resource",
} = {}) {
  try {
    const absoluteRoot = path.resolve(packageRoot);
    const rootStat = await fs.lstat(absoluteRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("unsafe package root");
    const realRoot = await fs.realpath(absoluteRoot);
    if (realRoot !== absoluteRoot) throw new Error("package root resolves through a link");
    const absolutePath = assertInsideRoot(filePath, realRoot);
    const stat = await fs.lstat(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("resource is not a regular file");
    const realFile = await fs.realpath(absolutePath);
    if (realFile !== absolutePath || !assertInsideRoot(realFile, realRoot)) throw new Error("resource parent chain resolves outside package root");
    const handle = await fs.open(realFile, "r");
    try {
      const before = await handle.stat();
      const text = await handle.readFile("utf8");
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || before.dev !== after.dev) throw new Error("resource changed while read");
      if (!text.trim() || text.includes("\0")) throw new Error("resource is empty or invalid");
      return text;
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = typeof error?.code === "string" ? ` (${error.code})` : "";
    throw new Error(`${label} could not be read safely${code}.`);
  }
}

export function validateRequiredMarkdown(text, {
  label = "MCP Markdown resource",
  requireFrontmatter = false,
  expectedFrontmatterName = null,
} = {}) {
  if (!nonEmptyString(text) || text.includes("\0") || !/^#\s+\S+/mu.test(text)) {
    throw new Error(`${label} is not valid non-empty Markdown.`);
  }
  if (requireFrontmatter) {
    const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1];
    if (!frontmatter) {
      throw new Error(`${label} is missing YAML frontmatter.`);
    }
    if (expectedFrontmatterName) {
      const name = frontmatter.match(/^name:\s*([^\r\n]+)\s*$/mu)?.[1]?.trim();
      if (name !== expectedFrontmatterName) {
        throw new Error(`${label} has an unexpected frontmatter name.`);
      }
    }
  }
  return text;
}

export function validateRuntimeCapabilityMatrix(matrix, sourceLabel = "runtime capability matrix") {
  assertNoUnsafeObjectKeys(matrix, sourceLabel);
  if (
    !isPlainObject(matrix) ||
    matrix.schemaVersion !== 2 ||
    matrix.claimSchemaVersion !== 2 ||
    !Array.isArray(matrix.generatedFrom) ||
    matrix.generatedFrom.length === 0 ||
    matrix.generatedFrom.some((entry) => !nonEmptyString(entry)) ||
    !nonEmptyString(matrix.lastReviewedAt) ||
    Object.hasOwn(matrix, "lastVerifiedAt") ||
    matrix.evidenceLedger !== "config/runtime-capability-evidence.json" ||
    !isPlainObject(matrix.claimSemantics) ||
    !Array.isArray(matrix.capabilityNames) ||
    matrix.capabilityNames.length === 0 ||
    matrix.capabilityNames.some((entry) => !nonEmptyString(entry)) ||
    new Set(matrix.capabilityNames).size !== matrix.capabilityNames.length ||
    !Array.isArray(matrix.platforms) ||
    matrix.platforms.length === 0 ||
    !isPlainObject(matrix.knownConstraints)
  ) {
    throw new Error(`${sourceLabel} is not a valid Meta_Kim runtime capability matrix.`);
  }

  const expectedCapabilities = new Set(matrix.capabilityNames);
  const seenPlatforms = new Set();
  for (const platform of matrix.platforms) {
    if (
      !isPlainObject(platform) ||
      !nonEmptyString(platform.platform) ||
      seenPlatforms.has(platform.platform) ||
      !nonEmptyString(platform.summary) ||
      !Array.isArray(platform.capabilities)
    ) {
      throw new Error(`${sourceLabel} contains an invalid or duplicate platform.`);
    }
    seenPlatforms.add(platform.platform);
    const seenCapabilities = new Set();
    for (const capability of platform.capabilities) {
      if (
        !isPlainObject(capability) ||
        capability.platform !== platform.platform ||
        !expectedCapabilities.has(capability.capability) ||
        seenCapabilities.has(capability.capability) ||
        !nonEmptyString(capability.support) ||
        !nonEmptyString(capability.confidence) ||
        !HOST_SUPPORT_VALUES.includes(capability.hostSupport) ||
        !nonEmptyString(capability.hostConfidence) ||
        !Array.isArray(capability.runtimeModes) ||
        capability.runtimeModes.length === 0 ||
        capability.runtimeModes.some((mode) => !RUNTIME_CAPABILITY_MODES.includes(mode)) ||
        !Array.isArray(capability.requiredModes) ||
        capability.requiredModes.some((mode) => !capability.runtimeModes.includes(mode)) ||
        !isPlainObject(capability.claimsByMode) ||
        Object.keys(capability.claimsByMode).length !== capability.runtimeModes.length ||
        capability.runtimeModes.some((mode) => {
          const claim = capability.claimsByMode[mode];
          return !isPlainObject(claim) ||
            !HOST_SUPPORT_VALUES.includes(claim.hostSupport) ||
            !nonEmptyString(claim.hostConfidence) ||
            !nonEmptyString(claim.metaKimIntegration) ||
            !nonEmptyString(claim.acceptanceRequirement) ||
            !nonEmptyString(claim.acceptanceState) ||
            !ROUTE_ELIGIBILITY_VALUES.includes(claim.routeEligibility) ||
            !Array.isArray(claim.evidenceRefs) ||
            claim.evidenceRefs.length === 0;
        }) ||
        !isPlainObject(capability.reviewState) ||
        !nonEmptyString(capability.reviewState.lastReviewedAt) ||
        !Array.isArray(capability.reviewState.evidenceRefs) ||
        capability.reviewState.evidenceRefs.length === 0 ||
        !isPlainObject(capability.trigger) ||
        !isPlainObject(capability.configLocations) ||
        !isPlainObject(capability.installLocations) ||
        !isPlainObject(capability.osSupport) ||
        !isPlainObject(capability.automationBoundary)
      ) {
        throw new Error(
          `${sourceLabel} contains an invalid or duplicate capability for ${platform.platform}.`,
        );
      }
      const aggregate = aggregateLegacyCapabilitySummary(capability);
      if (capability.support !== aggregate.support || capability.confidence !== aggregate.confidence) {
        throw new Error(`${sourceLabel} contains a non-conservative legacy capability summary for ${platform.platform}.`);
      }
      seenCapabilities.add(capability.capability);
    }
    if (seenCapabilities.size !== expectedCapabilities.size) {
      throw new Error(`${sourceLabel} is missing capabilities for ${platform.platform}.`);
    }
  }
  for (const constraints of Object.values(matrix.knownConstraints)) {
    if (!Array.isArray(constraints) || constraints.some((entry) => !nonEmptyString(entry))) {
      throw new Error(`${sourceLabel} contains invalid known constraints.`);
    }
  }
  return matrix;
}

export function parseRuntimeCapabilityMatrix(text, sourceLabel) {
  let matrix;
  try {
    matrix = JSON.parse(text);
  } catch (error) {
    throw new Error(`${sourceLabel} is not valid JSON: ${error.message}`);
  }
  return validateRuntimeCapabilityMatrix(matrix, sourceLabel);
}

export function parseRuntimeCapabilityEvidenceLedger(text, sourceLabel) {
  let ledger;
  try {
    ledger = JSON.parse(text);
  } catch (error) {
    throw new Error(`${sourceLabel} is not valid JSON: ${error.message}`);
  }
  assertNoUnsafeObjectKeys(ledger, sourceLabel);
  const { issues } = validateRuntimeEvidenceLedger(ledger);
  if (issues.length > 0) throw new Error(`${sourceLabel} is invalid:\n- ${issues.join("\n- ")}`);
  return ledger;
}

export function assertExactRuntimeCapabilityMatrix(actual, expected, label = "runtime capability matrix") {
  validateRuntimeCapabilityMatrix(actual, `${label} response`);
  validateRuntimeCapabilityMatrix(expected, `${label} source`);
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label} does not exactly match its packaged canonical source.`);
  }
  return actual;
}
