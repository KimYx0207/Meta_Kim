import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CODEX_APP_NATIVE_PLUGIN_IDS,
  CODEX_JS_REPL_FEATURE,
  CODEX_REQUEST_USER_INPUT_FEATURE,
} from "../../scripts/codex-config-merge.mjs";
import {
  buildCodexHooksJson,
  buildHookPromptAdapterSource,
} from "../../scripts/runtime-hook-mapping.mjs";

const CONTRACT = JSON.parse(
  readFileSync("config/governance/runtime-safety-hardening-contract.json", "utf8"),
);
const PACKAGE = JSON.parse(readFileSync("package.json", "utf8"));
const RUNTIME_COMPATIBILITY_CATALOG = JSON.parse(
  readFileSync("config/runtime-compatibility-catalog.json", "utf8"),
);
const HOOKPROMPT_FIXTURES = JSON.parse(
  readFileSync("tests/fixtures/hookprompt-bad-inputs.json", "utf8"),
);

function productIdsByTier(tier) {
  return RUNTIME_COMPATIBILITY_CATALOG.products
    .filter((product) => product.tier === tier)
    .map((product) => product.id)
    .sort();
}

test("runtime safety contract covers the five recent hardening lanes", () => {
  assert.equal(CONTRACT.contractId, "meta-kim-runtime-safety-hardening-contract");
  assert.deepEqual(CONTRACT.hostConfigMerge.requiredMatrixColumns, [
    "existingHostState",
    "stateAddedByChange",
    "stateMustPreserve",
    "rollbackPath",
  ]);
  assert.deepEqual(CONTRACT.hookPromptProtocol.requiredLayers.map((layer) => layer.id), [
    "sourcePayload",
    "adapterTransform",
    "hostRegistration",
    "modelVisibleResult",
  ]);
  assert.ok(CONTRACT.residueSweep.requiredBuckets.includes("i18n"));
  assert.ok(CONTRACT.runtimeEvidence.requiredTemplateFields.includes("hostVisibleResult"));
  assert.deepEqual(CONTRACT.installStatusSemantics.allowedClasses, [
    "success",
    "skipped",
    "manual",
    "failed",
  ]);
});

test("runtime safety validator is wired into governance verification", () => {
  assert.equal(
    PACKAGE.scripts[CONTRACT.releaseGate.packageScript],
    `node ${CONTRACT.releaseGate.validatorScript}`,
  );
  assert.match(
    `${PACKAGE.scripts["meta:verify:governance"]} && ${PACKAGE.scripts["meta:verify:governance:core"]}`,
    new RegExp(`npm run ${CONTRACT.releaseGate.packageScript}`),
  );

  const output = execFileSync(process.execPath, [CONTRACT.releaseGate.validatorScript], {
    encoding: "utf8",
  });
  assert.match(output, /runtime safety hardening contract valid/);
});

test("Codex host merge contract matches implementation constants", () => {
  assert.deepEqual(CONTRACT.hostConfigMerge.codexNativeControls.requiredFeatures, [
    CODEX_REQUEST_USER_INPUT_FEATURE,
    CODEX_JS_REPL_FEATURE,
  ]);
  assert.deepEqual(
    CONTRACT.hostConfigMerge.codexNativeControls.requiredPluginIds,
    CODEX_APP_NATIVE_PLUGIN_IDS,
  );
  assert.ok(
    CONTRACT.hostConfigMerge.protectedState.includes(
      "userOwnedGlobalInstructionFiles",
    ),
  );
  assert.deepEqual(
    CONTRACT.hostConfigMerge.codexGlobalInstructionFiles.protectedFiles,
    ["~/.codex/AGENTS.md"],
  );
  assert.ok(
    CONTRACT.hostConfigMerge.codexGlobalInstructionFiles.policy.includes(
      "quarantine exact ECC baseline if it appears in global AGENTS.md",
    ),
  );
  assert.equal(CONTRACT.hostConfigMerge.codexNativeControls.windowsSandbox, "unelevated");
  assert.ok(
    CONTRACT.hostConfigMerge.forbiddenOutcomes.includes("pinStaleBundledMarketplaceSource"),
  );
});

test("lazy project bootstrap contract keeps source chain, merge, and rollback explicit", () => {
  assert.equal(
    CONTRACT.lazyProjectBootstrap.mode,
    "global_first_first_trigger_project_projection",
  );
  assert.ok(
    CONTRACT.lazyProjectBootstrap.entrypoints.includes(
      "meta-kim project bootstrap --dry-run --project-dir <dir>",
    ),
  );
  assert.equal(CONTRACT.lazyProjectBootstrap.sourceChain.globalEntrypoint, "bin/meta-kim.mjs");
  assert.equal(CONTRACT.lazyProjectBootstrap.sourceChain.syncManifest, "config/sync.json");
  assert.equal(
    CONTRACT.lazyProjectBootstrap.postCopyInitializerPolicy.executorLocation,
    "installed package root scripts/project-post-copy-init.mjs",
  );
  assert.ok(
    CONTRACT.lazyProjectBootstrap.postCopyInitializerPolicy.projectOutputs.includes(
      "graphify-out/graph.json",
    ),
  );
  assert.ok(
    CONTRACT.lazyProjectBootstrap.postCopyInitializerPolicy.forbiddenProjectExecutables.includes(
      ".meta-kim/meta-kim-post-copy.mjs",
    ),
  );
  assert.ok(
    CONTRACT.lazyProjectBootstrap.sourceChain.canonicalRoots.includes("canonical/skills"),
  );
  assert.ok(
    CONTRACT.lazyProjectBootstrap.projectFilePolicies.merge.includes(".codex/hooks.json"),
  );
  assert.ok(
    CONTRACT.lazyProjectBootstrap.projectFilePolicies.managedTextBlock.includes("AGENTS.md"),
  );
  assert.ok(
    CONTRACT.lazyProjectBootstrap.projectFilePolicies.neverTouch.includes(".codex/config.toml"),
  );
  assert.equal(CONTRACT.lazyProjectBootstrap.rollback.requiredBeforeApply, true);
  assert.ok(
    CONTRACT.lazyProjectBootstrap.forbiddenOutcomes.includes(
      "project-level source described without packageRoot/canonical/syncManifest/runtimeMirror chain",
    ),
  );
});

test("install experience contract separates global capability, project projection, and directory authorization", () => {
  assert.equal(
    CONTRACT.installExperienceModel.goal,
    "clear_global_or_project_install_paths_with_optional_manifest_proven_project_cleanup",
  );
  assert.ok(
    CONTRACT.installExperienceModel.principles.includes(
      "project-level complete projections are preserved when the user explicitly selects project directory updates",
    ),
  );
  assert.deepEqual(
    CONTRACT.installExperienceModel.layers.projectCompleteProjectionLayer.defaultActiveTargets,
    ["claude", "codex"],
  );
  assert.equal(
    CONTRACT.installExperienceModel.layers.projectCompleteProjectionLayer.defaultProjectionSet.includes(
      ".agents/skills/",
    ),
    false,
  );
  assert.deepEqual(
    CONTRACT.installExperienceModel.layers.projectCompleteProjectionLayer.targetConditionalProjectionSets.claude,
    ["CLAUDE.md", ".claude/", ".mcp.json", ".meta-kim/state", ".meta-kim/backups"],
  );
  assert.ok(
    CONTRACT.installExperienceModel.layers.projectCompleteProjectionLayer.targetConditionalProjectionSets.codex.includes(
      ".codex/",
    ),
  );
  assert.ok(
    CONTRACT.installExperienceModel.layers.projectCompleteProjectionLayer.targetConditionalProjectionSets.cursor.includes(
      ".cursor/",
    ),
  );
  assert.ok(
    CONTRACT.installExperienceModel.layers.projectCompleteProjectionLayer.targetConditionalProjectionSets.openclaw.includes(
      "openclaw/",
    ),
  );
  assert.match(
    CONTRACT.installExperienceModel.layers.projectCompleteProjectionLayer.selectionInvariant,
    /activeTargets/,
  );
  assert.equal(
    CONTRACT.installExperienceModel.installOptions.find((option) => option.id === "global")
      .defaultOnEnter,
    true,
  );
  assert.equal(
    CONTRACT.installExperienceModel.installOptions.find(
      (option) => option.id === "project",
    ).defaultOnEnter,
    false,
  );
  assert.equal(
    CONTRACT.installExperienceModel.installOptions.find(
      (option) => option.id === "project_cleanup_after_global",
    ).requiresInstallOption,
    "global",
  );
  assert.equal(
    CONTRACT.installExperienceModel.installOptions.some((option) => option.id === "both"),
    false,
  );
  assert.equal(
    CONTRACT.installExperienceModel.installOptions.some(
      (option) => option.id === "advanced_global_controls",
    ),
    false,
  );
  assert.match(
    CONTRACT.installExperienceModel.layers.projectCleanupLayer.deletePolicy,
    /manifest/,
  );
  assert.ok(
    CONTRACT.installExperienceModel.noSkillSemantics.mustNotSkip.includes(
      "project projection when project scope is selected",
    ),
  );
  assert.ok(
    CONTRACT.installExperienceModel.dryRunDisclosure.mustShow.includes("rollbackPlan"),
  );
});

test("install experience contract keeps full platform compatibility tiers explicit", () => {
  const tiers = CONTRACT.installExperienceModel.platformSupportTiers;

  assert.equal(tiers.sourceOfTruth, "config/runtime-compatibility-catalog.json");
  assert.deepEqual(tiers.formalProjectionTargets.toSorted(), productIdsByTier("runtime_projection"));
  assert.deepEqual(tiers.defaultSelectedTargets.toSorted(), ["claude", "codex"]);
  assert.deepEqual(tiers.nonDefaultFormalProjectionTargets.toSorted(), [
    "cursor",
    "openclaw",
  ]);
  assert.deepEqual(
    tiers.dependencyInstallTargets.toSorted(),
    productIdsByTier("dependency_install_target"),
  );
  assert.deepEqual(
    tiers.betaCompatibilityTargets.toSorted(),
    productIdsByTier("beta_compatibility"),
  );
  assert.deepEqual(tiers.candidateProbeTargets.toSorted(), productIdsByTier("candidate_probe"));
  assert.match(tiers.boundary, /formal Meta_Kim projection targets/);
  assert.match(tiers.promotionInvariant, /runtime profile/);
  assert.match(tiers.promotionInvariant, /sync tests/);
});

test("HookPrompt protocol contract binds source, adapter, host, and model-visible fields", () => {
  const codexSource = buildHookPromptAdapterSource("codex");
  const cursorSource = buildHookPromptAdapterSource("cursor");
  const codexHooks = buildCodexHooksJson({
    hookPromptAdapterPath: ".codex/hooks/hookprompt-adapter.mjs",
  });

  assert.match(codexSource, /hookSpecificOutput/);
  assert.match(codexSource, /additionalContext/);
  assert.doesNotMatch(codexSource, /systemMessage:\s*additionalContext/);
  assert.match(cursorSource, /prompt:\s*additionalContext/);
  assert.match(JSON.stringify(codexHooks), /hookprompt-adapter\.mjs/);
  assert.ok(
    CONTRACT.hookPromptProtocol.rules.some(
      (rule) =>
        /prompt-intake context only/i.test(rule) &&
        /active-run/i.test(rule) &&
        /Fetch/i.test(rule) &&
        /Thinking/i.test(rule) &&
        /verification/i.test(rule) &&
        /public-ready/i.test(rule),
    ),
    "HookPrompt must stay as prompt-intake context, not runtime evidence",
  );
});

test("HookPrompt bad-input fixtures flow through adapter into model-visible fields", () => {
  for (const runtimeId of ["codex", "cursor"]) {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), `meta-kim-hookprompt-${runtimeId}-`));
    try {
      const adapterPath = path.join(tempDir, "hookprompt-adapter.mjs");
      const hookPromptPath = path.join(tempDir, "user-prompt-submit.js");
      writeFileSync(path.join(tempDir, "package.json"), '{"type":"module"}\n', "utf8");
      writeFileSync(adapterPath, buildHookPromptAdapterSource(runtimeId), "utf8");
      writeFileSync(
        hookPromptPath,
        [
          'import { readFileSync } from "node:fs";',
          'const raw = readFileSync(0, "utf8");',
          'const payload = raw.trim() ? JSON.parse(raw) : {};',
          'const prompt = payload.prompt || "";',
          'console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: `CTX:${prompt}` } }));',
          "",
        ].join("\n"),
        "utf8",
      );

      for (const fixture of HOOKPROMPT_FIXTURES.fixtures) {
        const result = spawnSync(process.execPath, [adapterPath], {
          input: JSON.stringify(fixture.payload),
          encoding: "utf8",
          // The adapter's inner hook spawn has a timeout, and on timeout the
          // adapter stays silent by design. A loaded host can starve a healthy
          // inner hook past the interactive default, which would surface here as
          // a JSON parse error against empty stdout rather than as the contract
          // break this case is about. Lift the ceiling for the measurement.
          env: { ...process.env, META_KIM_HOOKPROMPT_INNER_TIMEOUT_MS: "60000" },
        });
        assert.equal(result.status, 0, result.stderr);
        assert.ok(
          result.stdout.trim(),
          `${runtimeId} adapter emitted nothing for ${fixture.id ?? fixture.expectedPromptFragment}`,
        );
        const parsed = JSON.parse(result.stdout);
        const modelVisible =
          runtimeId === "cursor"
            ? parsed.prompt
            : parsed.hookSpecificOutput?.additionalContext;
        assert.match(modelVisible, new RegExp(fixture.expectedPromptFragment));
        assert.doesNotMatch(JSON.stringify(parsed), /systemMessage/);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test("the HookPrompt adapter's inner timeout honours its override and falls back on a bad one", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-hookprompt-timeout-"));
  try {
    const adapterPath = path.join(tempDir, "hookprompt-adapter.mjs");
    writeFileSync(path.join(tempDir, "package.json"), '{"type":"module"}\n', "utf8");
    writeFileSync(adapterPath, buildHookPromptAdapterSource("codex"), "utf8");
    // Busy-waits past a sub-second ceiling and well under a generous one, so the
    // same inner hook is starved or served purely by the override's value.
    writeFileSync(
      path.join(tempDir, "user-prompt-submit.js"),
      [
        "const end = Date.now() + 900;",
        "while (Date.now() < end) {}",
        'console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: "CTX:served" } }));',
        "",
      ].join("\n"),
      "utf8",
    );

    const runWith = (override) =>
      spawnSync(process.execPath, [adapterPath], {
        input: JSON.stringify({ prompt: "seam probe" }),
        encoding: "utf8",
        env:
          override === null
            ? process.env
            : { ...process.env, META_KIM_HOOKPROMPT_INNER_TIMEOUT_MS: override },
      });

    const starved = runWith("200");
    assert.equal(starved.status, 0, starved.stderr);
    assert.equal(starved.stdout.trim(), "", "a ceiling below the inner hook must withhold output");

    const served = runWith("30000");
    assert.equal(served.status, 0, served.stderr);
    assert.match(served.stdout, /CTX:served/, "a raised ceiling must let the inner hook through");

    // A garbage override must not become the ceiling; the 10s default has to
    // still serve this 0.9s hook.
    for (const bad of ["nonsense", "0", "-5"]) {
      const fallback = runWith(bad);
      assert.equal(fallback.status, 0, fallback.stderr);
      assert.match(fallback.stdout, /CTX:served/, `override ${bad} must fall back to the default`);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
