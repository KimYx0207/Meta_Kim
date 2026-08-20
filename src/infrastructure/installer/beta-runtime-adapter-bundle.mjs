import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BETA_RUNTIME_ADAPTER_BUNDLE_FILES,
  assertValidBetaRuntimeAdapterBundlePlan,
} from "../../application/installer/beta-runtime-adapter-bundle.mjs";
import { verifyGlobalProjectionPackage } from "../../../scripts/global-projection-package-store.mjs";

const BETA_CONTRACT_SCHEMA = "meta-kim-candidate-runtime-adapter-v1";
const BETA_SCOPES = new Set(["beta_compatibility"]);
const SHA256_RE = /^[a-f0-9]{64}$/u;

function fail(message) {
  throw new Error(`Beta runtime adapter bundle verification failed: ${message}`);
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathAtOrWithin(root, candidate) {
  const relative = path.relative(pathKey(root), pathKey(candidate));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function portableRelative(value) {
  const normalized = String(value ?? "").replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) fail("bundle entry path is unsafe");
  return normalized;
}

async function exactRegularFile(filePath, label) {
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    fail(`${label} is missing or is not an exact regular file`);
  }
  const bytes = await fs.readFile(filePath);
  return {
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes,
  };
}

async function assertPlainPathChain(root, filePath, label) {
  if (!pathAtOrWithin(root, filePath)) fail(`${label} escapes package root`);
  const relative = path.relative(root, filePath);
  let cursor = root;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    const stat = await fs.lstat(cursor).catch(() => null);
    if (!stat || stat.isSymbolicLink() || (!stat.isDirectory() && cursor !== filePath)) {
      fail(`${label} has a non-plain parent path`);
    }
  }
}

function assertContract(contract) {
  if (
    contract?.schemaVersion !== BETA_CONTRACT_SCHEMA ||
    !BETA_SCOPES.has(contract.scope) ||
    contract.decisionBoundary?.candidateAdaptersDoNotCreateFormalSupport !== true ||
    contract.decisionBoundary?.betaAdaptersDoNotEnterDefaultRuntimeActivationOrSync !== true ||
    contract.inputBoundary?.explicitProbeFactsOnly !== true ||
    contract.inputBoundary?.ambientRuntimeDiscovery !== false ||
    contract.inputBoundary?.credentialsOrRawModelOutputForbidden !== true ||
    !/always false for beta_compatibility plans\./u.test(
      contract.authorizationRule ?? "",
    )
  ) {
    fail("beta adapter contract is not the fixed fail-closed contract");
  }
  const authFields = contract.authorizationExactFields;
  if (
    !Array.isArray(authFields) ||
    authFields.length !== 7 ||
    authFields.some((field) => typeof field !== "string")
  ) fail("beta adapter contract authorization fields are invalid");
}

function assertAdapterSource(source, runtimeId) {
  const namesByRuntime = {
    zcode: ["buildZCodeCandidateRuntimePlan", "assertValidZCodeCandidateRuntimePlan"],
    "deepseek-harness": [
      "buildDeepSeekHarnessCandidateRuntimePlan",
      "assertValidDeepSeekHarnessCandidateRuntimePlan",
    ],
    qoder: ["buildQoderCandidateRuntimePlan", "assertValidQoderCandidateRuntimePlan"],
    trae: ["buildTraeCandidateRuntimePlan", "assertValidTraeCandidateRuntimePlan"],
  };
  const names = namesByRuntime[runtimeId];
  if (!names) fail(`unknown beta adapter runtime ${runtimeId}`);
  for (const name of names) {
    if (!new RegExp(`export\\s+function\\s+${name}\\b`, "u").test(source)) {
      fail(`${runtimeId} adapter is missing ${name}`);
    }
  }
  if (/from\s+["']node:/u.test(source)) {
    fail(`${runtimeId} adapter must not import a Node runtime side effect`);
  }
}

function assertBetaAsset(bytes, entry) {
  const source = bytes.toString("utf8");
  if (entry.path.endsWith("candidate-preset.json")) {
    let preset;
    try {
      preset = JSON.parse(source);
    } catch {
      fail("DeepSeek beta preset is not valid JSON");
    }
    if (
      preset.kind !== "beta_compatibility_preset" ||
      preset.runtimeId !== "deepseek-harness" ||
      preset.tier !== "beta_compatibility" ||
      preset.formalProjection !== false ||
      preset.enabledByDefault !== false ||
      preset.optInRequired !== true ||
      (preset.packedStructuralAdapterOnly !== undefined && preset.packedStructuralAdapterOnly !== true) ||
      (preset.liveCertified !== undefined && preset.liveCertified !== false) ||
      preset.policy?.modelInvocationAllowed !== false ||
      preset.policy?.processSpawnAllowed !== false ||
      preset.policy?.globalConfigWriteAllowed !== false ||
      preset.policy?.userConfigOverwriteAllowed !== false ||
      preset.policy?.mcpAutoStartAllowed !== false ||
      preset.policy?.hookClaimAllowed !== false ||
      preset.policy?.formalRuntimePromotionAllowed !== false
    ) fail("DeepSeek beta preset grants activation or permission");
    return;
  }
  if (!/(?:beta_compatibility|beta\s+compatibility)/iu.test(source) || !/projection/iu.test(source)) {
    fail(`${entry.runtimeId} beta explanation is not beta-only`);
  }
}

async function verifyPackedAuthority(stablePackage, packageRoot) {
  if (!stablePackage?.digestDir) return null;
  const verified = await verifyGlobalProjectionPackage(stablePackage.digestDir, {
    homeRoot: stablePackage.homeRoot ?? os.homedir(),
    expectedPackageName: stablePackage.packageName ?? "meta-kim",
    expectedPackageVersion: stablePackage.packageVersion,
    expectedPackageTarballSha256: stablePackage.packageTarballSha256,
    expectedFirstPartyClosure: stablePackage.firstPartyClosure,
  });
  if (pathKey(verified.packageRoot) !== pathKey(packageRoot)) {
    fail("stable package authority changed before beta bundle verification");
  }
  return verified;
}

/**
 * Read-only verification of the beta bundle in a verified packed root.
 * No runtime executable, process, model, network, or configuration API is
 * called here.  `expectedEntries` is useful for focused tests and for callers
 * that already possess an independent packed-content hash receipt.
 */
export async function verifyBetaRuntimeAdapterBundle({
  packageRoot,
  plan,
  stablePackage = null,
  expectedEntries = null,
} = {}) {
  assertValidBetaRuntimeAdapterBundlePlan(plan);
  if (typeof packageRoot !== "string" || !path.isAbsolute(packageRoot)) {
    fail("packageRoot must be absolute");
  }
  const root = path.resolve(packageRoot);
  const rootStat = await fs.lstat(root).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    fail("packageRoot must be an exact plain directory");
  }
  await verifyPackedAuthority(stablePackage, root);

  const expectedByPath = new Map(
    Array.isArray(expectedEntries)
      ? expectedEntries.map((entry) => [portableRelative(entry.path), entry])
      : [],
  );
  const verifiedEntries = [];
  let contract = null;
  for (const entry of BETA_RUNTIME_ADAPTER_BUNDLE_FILES) {
    const relative = portableRelative(entry.path);
    const filePath = path.resolve(root, ...relative.split("/"));
    await assertPlainPathChain(root, filePath, relative);
    const integrity = await exactRegularFile(filePath, relative);
    const expected = expectedByPath.get(relative);
    if (
      expected &&
      (expected.size !== integrity.size || expected.sha256 !== integrity.sha256)
    ) fail(`${relative} hash does not match the packed receipt`);
    if (!SHA256_RE.test(integrity.sha256)) fail(`${relative} hash is invalid`);
    if (entry.role === "contract") {
      try {
        contract = JSON.parse(integrity.bytes.toString("utf8"));
      } catch {
        fail("beta adapter contract is not valid JSON");
      }
      assertContract(contract);
    } else if (entry.role === "adapter") {
      assertAdapterSource(integrity.bytes.toString("utf8"), entry.runtimeId);
    } else {
      assertBetaAsset(integrity.bytes, entry);
    }
    verifiedEntries.push({
      path: relative,
      role: entry.role,
      ...(entry.runtimeId ? { runtimeId: entry.runtimeId } : {}),
      size: integrity.size,
      sha256: integrity.sha256,
    });
  }
  return Object.freeze({
    schemaVersion: "meta-kim-beta-runtime-adapter-bundle-verification-v1",
    bundleId: "beta-runtime-adapter-bundle",
    packageRoot: root,
    status: "verified",
    available: true,
    activated: false,
    formalProjection: false,
    syncTarget: false,
    contract: Object.freeze({
      schemaVersion: contract.schemaVersion,
      scope: contract.scope,
    }),
    entries: Object.freeze(verifiedEntries.map((entry) => Object.freeze(entry))),
  });
}
