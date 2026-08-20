/**
 * Pure plan for the non-formal beta compatibility adapter bundle.
 *
 * This module intentionally has no Node or filesystem dependency.  The
 * installer composition root asks Infrastructure to verify this plan inside
 * the immutable packed package, but never turns the beta adapters into
 * sync targets or runtime activation.
 */

export const BETA_RUNTIME_ADAPTER_BUNDLE_SCHEMA_VERSION =
  "meta-kim-beta-runtime-adapter-bundle-v1";
export const BETA_RUNTIME_ADAPTER_BUNDLE_ID =
  "beta-runtime-adapter-bundle";

const REQUIRED_MODES = Object.freeze(["install", "update"]);

export const BETA_RUNTIME_ADAPTER_BUNDLE_FILES = Object.freeze([
  Object.freeze({
    path: "config/contracts/candidate-runtime-adapter-contract.json",
    role: "contract",
  }),
  Object.freeze({
    path: "src/runtimes/zcode/candidate-adapter.mjs",
    role: "adapter",
    runtimeId: "zcode",
  }),
  Object.freeze({
    path: "src/runtimes/deepseek-harness/candidate-adapter.mjs",
    role: "adapter",
    runtimeId: "deepseek-harness",
  }),
  Object.freeze({
    path: "src/runtimes/qoder/candidate-adapter.mjs",
    role: "adapter",
    runtimeId: "qoder",
  }),
  Object.freeze({
    path: "src/runtimes/trae/candidate-adapter.mjs",
    role: "adapter",
    runtimeId: "trae",
  }),
  Object.freeze({
    path: "config/candidate-runtime-assets/zcode/CANDIDATE_PROBE.md",
    role: "beta_asset",
    runtimeId: "zcode",
  }),
  Object.freeze({
    path: "config/candidate-runtime-assets/deepseek-harness/README.md",
    role: "beta_asset",
    runtimeId: "deepseek-harness",
  }),
  Object.freeze({
    path: "config/candidate-runtime-assets/deepseek-harness/candidate-preset.json",
    role: "beta_asset",
    runtimeId: "deepseek-harness",
  }),
  Object.freeze({
    path: "config/candidate-runtime-assets/qoder/CANDIDATE_PROBE.md",
    role: "beta_asset",
    runtimeId: "qoder",
  }),
  Object.freeze({
    path: "config/candidate-runtime-assets/trae/CANDIDATE_PROBE.md",
    role: "beta_asset",
    runtimeId: "trae",
  }),
]);

const SIDE_EFFECT_POLICY = Object.freeze({
  modelInvocationAllowed: false,
  processSpawnAllowed: false,
  userConfigWriteAllowed: false,
  runtimeConfigWriteAllowed: false,
  mcpAutoStartAllowed: false,
});

function fail(message) {
  throw new TypeError(`Beta runtime adapter bundle: ${message}`);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlanRecord(value) {
  if (!isPlainRecord(value)) fail("plan must be a plain record");
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function cloneFiles() {
  return BETA_RUNTIME_ADAPTER_BUNDLE_FILES.map((entry) => ({ ...entry }));
}

export function buildBetaRuntimeAdapterBundlePlan({ mode } = {}) {
  if (!REQUIRED_MODES.includes(mode)) {
    fail("mode must be install or update");
  }
  return freeze({
    schemaVersion: BETA_RUNTIME_ADAPTER_BUNDLE_SCHEMA_VERSION,
    bundleId: BETA_RUNTIME_ADAPTER_BUNDLE_ID,
    mode,
    availability: "automatic",
    activation: "inactive_until_explicit_opt_in",
    formalProjection: false,
    syncTarget: false,
    packageRootOnly: true,
    requiredFiles: cloneFiles(),
    verification: {
      exactRegularFiles: true,
      sha256: true,
      betaContractRequired: true,
      packedPackageRequired: true,
    },
    sideEffects: { ...SIDE_EFFECT_POLICY },
  });
}

export function assertValidBetaRuntimeAdapterBundlePlan(plan) {
  assertPlanRecord(plan);
  if (plan.schemaVersion !== BETA_RUNTIME_ADAPTER_BUNDLE_SCHEMA_VERSION) {
    fail("plan schemaVersion is invalid");
  }
  if (plan.bundleId !== BETA_RUNTIME_ADAPTER_BUNDLE_ID) {
    fail("plan bundleId is invalid");
  }
  if (!REQUIRED_MODES.includes(plan.mode)) fail("plan mode is invalid");
  if (plan.availability !== "automatic") fail("plan availability is invalid");
  if (plan.activation !== "inactive_until_explicit_opt_in") {
    fail("beta bundle must remain inactive by default");
  }
  if (plan.formalProjection !== false || plan.syncTarget !== false) {
    fail("beta bundle cannot become a formal sync target");
  }
  if (plan.packageRootOnly !== true) fail("plan must require a package root");
  if (!Array.isArray(plan.requiredFiles)) fail("requiredFiles must be an array");
  const expected = JSON.stringify(BETA_RUNTIME_ADAPTER_BUNDLE_FILES);
  const actual = JSON.stringify(plan.requiredFiles);
  if (actual !== expected) fail("requiredFiles are not the fixed beta closure");
  assertPlanRecord(plan.verification);
  for (const field of [
    "exactRegularFiles",
    "sha256",
    "betaContractRequired",
    "packedPackageRequired",
  ]) {
    if (plan.verification[field] !== true) {
      fail(`verification.${field} must be true`);
    }
  }
  assertPlanRecord(plan.sideEffects);
  for (const field of Object.keys(SIDE_EFFECT_POLICY)) {
    if (plan.sideEffects[field] !== false) {
      fail(`sideEffects.${field} must be false`);
    }
  }
  return plan;
}
