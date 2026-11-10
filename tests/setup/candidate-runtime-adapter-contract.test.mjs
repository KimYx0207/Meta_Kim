import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  resolveRuntimeProfilesFromManifest,
  resolveRuntimeProjection,
} from "../../scripts/meta-kim-sync-config.mjs";

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

test("legacy candidate APIs remain plan-only and cannot grant formal support or side effects", () => {
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
  assert.equal(contract.runtimeRules.qoder.projectRulePath, ".qoder/rules");
  assert.equal(contract.runtimeRules.qoder.projectSkillPath, ".qoder/skills/{skill-name}/SKILL.md");
  assert.equal(contract.runtimeRules.trae.projectRulePath, ".trae/rules");
  assert.equal(contract.authorizationExactFields.length, 7);
  assert.match(contract.authorizationRule, /always false/u);
  assert.equal(contract.verification.evidenceKind, "packed_structural_adapter");
  assert.equal(contract.verification.liveCertified, false);
});

test("three-level priority keeps beta adapters between primary and compatibility", () => {
  assert.deepEqual(priorityContract.primaryRuntimeTier, ["claude_code", "codex"]);
  assert.deepEqual(priorityContract.betaCompatibilityRuntimeTier, ["zcode", "deepseek-harness", "qoder", "trae"]);
  assert.deepEqual(priorityContract.compatibilityRuntimeTier, ["openclaw", "cursor"]);
  assert.deepEqual(priorityContract.priorityOrder, ["primary", "beta_compatibility", "compatibility"]);
  assert.equal(priorityContract.priorityRules.betaCompatibilityDoesNotBlockPrimary, true);
  assert.equal(priorityContract.priorityRules.compatibilityDoesNotBlockBetaCompatibility, true);
  assert.equal(priorityContract.priorityRules.betaCompatibilityPriorityLeakTarget, 0);
});

test("catalog separates native integrations from unchanged plan-only candidate authority", () => {
  const byId = new Map(catalog.products.map((product) => [product.id, product]));
  for (const id of ["deepseek-harness", "qoder", "trae"]) {
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
    if (id !== "deepseek-harness") assert.match(product.decision, /beta_compatibility only/i, id);
  }
  const zcode = byId.get("zcode");
  assert.equal(zcode.tier, "runtime_projection");
  assert.equal(zcode.formalProjection.hasRuntimeProfile, true);
  assert.equal(zcode.formalProjection.isDefaultTarget, false);
  assert.equal(zcode.genericCompatibility.status, "partial");
  assert.match(zcode.genericCompatibility.hookConfig, /~\/\.zcode\/cli\/config\.json/u);
  assert.match(zcode.genericCompatibility.hookConfig, /project hooks.*ignored/iu);
  assert.ok(zcode.evidence.some((entry) => entry.type === "official_docs"
    && entry.ref.includes("zcode-guide 0.3.0")
    && entry.ref.includes("zcode.docs.configuration.2026-10-17")));
  assert.match(byId.get("zcode").nextAction, /no-quota and plan-only/i);
  assert.ok(
    byId
      .get("deepseek-harness")
      .evidence.some((entry) => entry.ref.includes("packages/acp/acp/README.md")),
  );
  const dsh = byId.get("deepseek-harness");
  assert.match(dsh.decision, /beta_compatibility and existing plan-only candidate authority/u);
  assert.match(dsh.decision, /opt-in native profile\/Skills\/MCP installation through meta-kim dsh/u);
  assert.match(dsh.decision, /no promotion of stage-runner authority, hard Hooks, custom-agent presets or model outcome certification/u);
  assert.equal(dsh.genericCompatibility.status, "partial");
  assert.equal(dsh.genericCompatibility.hookConfig, null);
  assert.ok(dsh.compatibilitySurfaces.includes("mcp_tooling"));
  assert.ok(dsh.evidence.some((entry) => entry.ref === "canonical/runtime-assets/dsh/host-contract.json"));
  const dshContract = readJson("canonical/runtime-assets/dsh/host-contract.json");
  assert.equal(dshContract.nativeSkills, true);
  assert.equal(dshContract.nativeCustomAgentPresets, false);
  assert.equal(dshContract.nativeHookEnforcement, false);
  assert.equal(dshContract.nativeStageRunner, false);
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
  assert.ok(packageJson.files.includes("src/runtimes/qoder/candidate-adapter.mjs"));
  assert.ok(packageJson.files.includes("src/runtimes/trae/candidate-adapter.mjs"));
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
    "config/candidate-runtime-assets/qoder/CANDIDATE_PROBE.md",
    "config/candidate-runtime-assets/trae/CANDIDATE_PROBE.md",
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
    "src/runtimes/qoder/candidate-adapter.mjs",
    "src/runtimes/trae/candidate-adapter.mjs",
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

test("remaining candidate-only products stay absent from formal profiles; ZCode native layout is separate", () => {
  assert.equal(resolveRuntimeProfilesFromManifest(syncManifest).zcode.id, "zcode");
  assert.match(resolveRuntimeProjection("zcode", "project", { projectRoot: REPO_ROOT }).settingsFile, /\.zcode[/\\]config\.json$/u);
  for (const id of ["deepseek-harness", "qoder", "trae"]) {
    assert.throws(
      () =>
        resolveRuntimeProfilesFromManifest({
          ...syncManifest,
          supportedTargets: [id],
        }),
      /Unknown runtime target|Missing runtime catalog entry/u,
      `${id} must not resolve a formal runtime profile`,
    );
    assert.throws(
      () => resolveRuntimeProjection(id, "project", { projectRoot: REPO_ROOT }),
      /Missing projection layout/u,
      `${id} must not resolve a formal projection layout`,
    );
  }
});
