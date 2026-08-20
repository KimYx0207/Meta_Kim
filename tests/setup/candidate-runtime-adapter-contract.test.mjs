import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const readJson = (relativePath) =>
  JSON.parse(readFileSync(path.join(REPO_ROOT, relativePath), "utf8"));

const contract = readJson("config/contracts/candidate-runtime-adapter-contract.json");
const priorityContract = readJson(
  "config/contracts/runtime-priority-and-compatibility-contract.json",
);
const catalog = readJson("config/runtime-compatibility-catalog.json");
const syncManifest = readJson("config/sync.json");
const packageJson = readJson("package.json");

test("candidate adapter contract keeps both runtimes outside formal sync and all side effects denied", () => {
  assert.equal(contract.schemaVersion, "meta-kim-candidate-runtime-adapter-v1");
  assert.equal(contract.scope, "beta_compatibility");
  assert.equal(contract.decisionBoundary.candidateAdaptersDoNotCreateFormalSupport, true);
  assert.equal(
    contract.decisionBoundary.betaAdaptersDoNotEnterDefaultRuntimeActivationOrSync,
    true,
  );
  assert.equal(contract.decisionBoundary.betaAdaptersProvePackedStructuralAdapterOnly, true);
  assert.equal(contract.decisionBoundary.betaAdaptersAreNotLiveCertified, true);
  assert.equal(contract.inputBoundary.explicitProbeFactsOnly, true);
  assert.equal(contract.inputBoundary.credentialsOrRawModelOutputForbidden, true);
  assert.equal(contract.verification.requiresModelInvocation, false);
  assert.equal(contract.runtimeRules.zcode.headlessMode, "plan");
  assert.ok(contract.runtimeRules.zcode.forbiddenHeadlessModes.includes("yolo"));
  assert.equal(contract.runtimeRules["deepseek-harness"].integrationMode, "opt_in_plugin_preset");
  assert.match(contract.runtimeRules["deepseek-harness"].acpScope, /not_full_runtime_ui/u);
  assert.equal(contract.authorizationExactFields.length, 7);
  assert.match(contract.authorizationRule, /always false/u);
  assert.equal(contract.verification.evidenceKind, "packed_structural_adapter");
  assert.equal(contract.verification.liveCertified, false);
});

test("three-level priority keeps beta adapters between primary and compatibility", () => {
  assert.deepEqual(priorityContract.primaryRuntimeTier, ["claude_code", "codex"]);
  assert.deepEqual(priorityContract.betaCompatibilityRuntimeTier, ["zcode", "deepseek-harness"]);
  assert.deepEqual(priorityContract.compatibilityRuntimeTier, ["openclaw", "cursor"]);
  assert.deepEqual(priorityContract.priorityOrder, ["primary", "beta_compatibility", "compatibility"]);
  assert.equal(priorityContract.priorityRules.betaCompatibilityDoesNotBlockPrimary, true);
  assert.equal(priorityContract.priorityRules.compatibilityDoesNotBlockBetaCompatibility, true);
  assert.equal(priorityContract.priorityRules.betaCompatibilityPriorityLeakTarget, 0);
});

test("catalog admits ZCode and DeepSeek Harness only as beta compatibility", () => {
  const byId = new Map(catalog.products.map((product) => [product.id, product]));
  for (const id of ["zcode", "deepseek-harness"]) {
    const product = byId.get(id);
    assert.ok(product, id);
    assert.equal(product.tier, "beta_compatibility", id);
    assert.deepEqual(product.formalProjection, {
      inSyncManifest: false,
      hasRuntimeProfile: false,
      hasProjectionLayout: false,
      isDefaultTarget: false,
    });
    assert.equal(syncManifest.supportedTargets.includes(id), false, id);
    assert.equal(syncManifest.defaultTargets.includes(id), false, id);
    assert.equal(product.dependencyInstall.ecc.support, "not_supported", id);
    assert.match(product.decision, /beta_compatibility only/i, id);
  }
  assert.equal(byId.get("zcode").genericCompatibility.hookConfig, null);
  assert.match(byId.get("zcode").nextAction, /no-quota and plan-only/i);
  assert.ok(
    byId
      .get("deepseek-harness")
      .evidence.some((entry) => entry.ref.includes("packages/acp/acp/README.md")),
  );
  assert.match(byId.get("deepseek-harness").decision, /developer-preview status|developer-preview/u);
});

test("package closure is exact for candidate adapters and does not widen src", () => {
  assert.equal(packageJson.files.includes("src/"), false);
  assert.equal(packageJson.files.includes("src/**"), false);
  assert.ok(packageJson.files.includes("src/runtimes/zcode/candidate-adapter.mjs"));
  assert.ok(
    packageJson.files.includes(
      "src/runtimes/deepseek-harness/candidate-adapter.mjs",
    ),
  );
  assert.ok(packageJson.files.includes("canonical/"));
});

test("candidate runtime source adapters are not swallowed by generated-runtime ignores", () => {
  const ignoreSource = readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");
  assert.match(ignoreSource, /^!\/src\/runtimes\/$/mu);
  assert.match(ignoreSource, /^!\/src\/runtimes\/\*\*$/mu);
});

test("candidate assets stay in the non-sync config namespace", () => {
  for (const relativePath of [
    "config/candidate-runtime-assets/zcode/CANDIDATE_PROBE.md",
    "config/candidate-runtime-assets/deepseek-harness/README.md",
    "config/candidate-runtime-assets/deepseek-harness/candidate-preset.json",
  ]) {
    assert.doesNotThrow(() => readFileSync(path.join(REPO_ROOT, relativePath)));
  }
  for (const relativePath of [
    "canonical/runtime-assets/zcode/CANDIDATE_PROBE.md",
    "canonical/runtime-assets/deepseek-harness/candidate-preset.json",
  ]) {
    assert.throws(() => readFileSync(path.join(REPO_ROOT, relativePath)));
  }
});

test("candidate adapters are data-only and cannot invoke runtimes or write configuration", () => {
  const forbiddenImports = /from\s+["']node:(?:child_process|fs|net|http|https|worker_threads)["']/u;
  const forbiddenCalls = /\b(?:spawn|spawnSync|exec|execFile|fork|fetch|writeFile|appendFile|mkdir|rename|rmSync)\s*\(/u;
  for (const relativePath of [
    "src/runtimes/zcode/candidate-adapter.mjs",
    "src/runtimes/deepseek-harness/candidate-adapter.mjs",
  ]) {
    const source = readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
    assert.doesNotMatch(source, forbiddenImports, relativePath);
    assert.doesNotMatch(source, forbiddenCalls, relativePath);
    assert.doesNotMatch(source, /\bprocess\.(?:env|execPath|cwd|kill)\b/u, relativePath);
  }
});

test("DeepSeek Harness beta preset is opt-in, disabled, and non-authorizing", () => {
  const preset = readJson(
    "config/candidate-runtime-assets/deepseek-harness/candidate-preset.json",
  );
  assert.equal(preset.runtimeId, "deepseek-harness");
  assert.equal(preset.tier, "beta_compatibility");
  assert.equal(preset.formalProjection, false);
  assert.equal(preset.packedStructuralAdapterOnly, true);
  assert.equal(preset.liveCertified, false);
  assert.equal(preset.enabledByDefault, false);
  assert.equal(preset.optInRequired, true);
  assert.equal(preset.acp.fullRuntimeUi, false);
  assert.ok(Object.values(preset.policy).every((value) => value === false));
});

test("candidate adapters stay absent from formal runtime profile and layout sources", () => {
  const syncConfigSource = readFileSync(
    path.join(REPO_ROOT, "scripts", "meta-kim-sync-config.mjs"),
    "utf8",
  );
  for (const id of ["zcode", "deepseek-harness"]) {
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    assert.doesNotMatch(
      syncConfigSource,
      new RegExp(`["']?${escapedId}["']?\\s*:`, "u"),
      id,
    );
  }
});
