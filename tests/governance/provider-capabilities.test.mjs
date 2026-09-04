import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

const node = process.execPath;

function runValidator(args = []) {
  return spawnSync(node, ["scripts/validate-provider-capabilities.mjs", ...args], {
    encoding: "utf8",
  });
}

test("provider capability validator passes portable registry checks", () => {
  const result = runValidator(["--json"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.ok(payload.summary.providers >= 10);
});

test("provider registry covers all provider kinds and required modeled providers", () => {
  const registry = JSON.parse(
    readFileSync("config/capability-index/provider-registry.json", "utf8"),
  );
  for (const type of [
    "runtime_native",
    "canonical_agent",
    "canonical_skill",
    "external_skill",
    "plugin_marketplace",
    "plugin_bundle",
    "mcp_server",
    "hook_script",
    "command",
    "rule_file",
    "dependency_project",
    "memory_provider",
    "graph_provider",
  ]) {
    assert.ok(registry.providerTypes.includes(type), `missing ${type}`);
    if (type !== "plugin_bundle") {
      assert.ok(
        registry.providers.some((provider) => provider.providerType === type),
        `missing provider instance for ${type}`,
      );
    }
  }

  for (const id of [
    "external-skill-hookprompt",
    "plugin-marketplace-superpowers",
    "plugin-marketplace-ecc",
    "mcp-server-meta-kim-runtime",
    "hook-script-codex-hookprompt-adapter",
    "hook-script-cursor-hookprompt-adapter",
  ]) {
    assert.ok(registry.providers.some((provider) => provider.id === id), id);
  }

  for (const provider of registry.providers) {
    for (const field of [
      "providerKind",
      "capabilities",
      "source",
      "trust",
      "installMethod",
      "runtimeAdapters",
      "osAdapters",
      "installLayers",
      "exposedArtifacts",
      "activationEvents",
      "outputContracts",
      "safetyBoundary",
      "degradation",
      "owner",
      "reviewOwner",
      "evolutionKey",
    ]) {
      assert.ok(provider[field], `${provider.id} missing ${field}`);
    }
    assert.equal(provider.providerKind, provider.providerType);
    for (const runtime of ["claude_code", "codex", "cursor", "openclaw"]) {
      assert.ok(provider.runtimeAdapters[runtime], `${provider.id} missing ${runtime} adapter`);
    }
    for (const osName of ["macos", "windows", "linux", "wsl2"]) {
      assert.ok(provider.osAdapters[osName], `${provider.id} missing ${osName} adapter`);
    }
  }
});

test("provider schema validates the registry and rejects private run-state fields", () => {
  const schema = JSON.parse(
    readFileSync("config/contracts/capability-provider.schema.json", "utf8"),
  );
  const registry = JSON.parse(
    readFileSync("config/capability-index/provider-registry.json", "utf8"),
  );
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  assert.equal(validate(registry), true, JSON.stringify(validate.errors));

  const forged = structuredClone(registry);
  forged.providers[0].runtimeAdapters.claude_code.selected = true;
  assert.equal(validate(forged), false);
  assert.ok(
    validate.errors.some(
      (entry) =>
        entry.keyword === "additionalProperties" &&
        entry.params.additionalProperty === "selected",
    ),
  );
});

test("runtime-scoped providers cannot claim other runtimes as verified or leak activation", () => {
  const registry = JSON.parse(
    readFileSync("config/capability-index/provider-registry.json", "utf8"),
  );
  assert.deepEqual(registry.mappingPolicy.providerRuntimeClaims, {
    sourceRef: "providers[*].support",
    required: true,
    runtimeAdapters: "derived_projection",
    selection: "run_scoped_only",
    availability: "support_state_and_install_layers",
    nativeSupport: "runtime_native_target_only",
    liveEvidence: "verification_artifact_required",
  });
  for (const providerId of [
    "runtime-native-claude-code",
    "runtime-native-codex",
    "runtime-native-cursor",
    "runtime-native-openclaw",
  ]) {
    const provider = registry.providers.find((entry) => entry.id === providerId);
    const target = provider.mappings.runtimeMatrixPlatforms[0];
    assert.deepEqual(provider.mappings.runtimeTargets, [target]);
    for (const runtime of registry.runtimes) {
      const adapter = provider.runtimeAdapters[runtime];
      if (runtime === target) {
        assert.equal(
          adapter.status,
          provider.support.runtimes[target].status,
          `${providerId}/${runtime}`,
        );
        continue;
      }
      assert.equal(adapter.status, "blocked", `${providerId}/${runtime}`);
      assert.equal(adapter.state, "blocked_for_execution", `${providerId}/${runtime}`);
      assert.equal(adapter.activationEvent, null, `${providerId}/${runtime}`);
      assert.ok(
        Object.values(adapter.installLayers).every((value) => value === "unsupported"),
        `${providerId}/${runtime} must not turn projection presence into support`,
      );
    }
  }
});

test("provider validator rejects forged cross-runtime and duplicate projection claims", () => {
  const registry = JSON.parse(
    readFileSync("config/capability-index/provider-registry.json", "utf8"),
  );
  const provider = registry.providers.find(
    (entry) => entry.id === "runtime-native-claude-code",
  );
  provider.support.default = structuredClone(provider.support.runtimes.claude_code);
  provider.runtimeAdapters.codex = {
    ...structuredClone(provider.runtimeAdapters.claude_code),
    state: "projected",
    selected: true,
  };

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-provider-claims-"));
  const registryPath = path.join(tempDir, "provider-registry.json");
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  try {
    const result = runValidator(["--registry", registryPath, "--json"]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout);
    const codes = new Set(payload.issues.map((entry) => entry.code));
    assert.ok(codes.has("cross_runtime_claim_without_target"));
    assert.ok(codes.has("runtime_claim_projection_mismatch"));
    assert.ok(codes.has("static_selected_claim_forbidden"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("adding a positive support override cannot expand a runtime-scoped provider target", () => {
  const registry = JSON.parse(
    readFileSync("config/capability-index/provider-registry.json", "utf8"),
  );
  const provider = registry.providers.find(
    (entry) => entry.id === "hook-script-codex-hookprompt-adapter",
  );
  provider.support.runtimes.claude_code = structuredClone(provider.support.runtimes.codex);
  provider.runtimeAdapters.claude_code = {
    ...structuredClone(provider.runtimeAdapters.codex),
    activationEvent: "Codex UserPromptSubmit",
  };

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-provider-targets-"));
  const registryPath = path.join(tempDir, "provider-registry.json");
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  try {
    const result = runValidator(["--registry", registryPath, "--json"]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.ok(
      payload.issues.some(
        (entry) =>
          entry.code === "cross_runtime_claim_without_target" &&
          entry.runtimeId === "claude_code",
      ),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("non-target OS claims and contradictory state/status pairs fail closed", () => {
  const registry = JSON.parse(
    readFileSync("config/capability-index/provider-registry.json", "utf8"),
  );
  const provider = registry.providers.find(
    (entry) => entry.id === "runtime-native-codex",
  );
  provider.support.default.os.windows = "verified";

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-provider-semantics-"));
  const registryPath = path.join(tempDir, "provider-registry.json");
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  try {
    const osResult = runValidator(["--registry", registryPath, "--json"]);
    assert.notEqual(osResult.status, 0);
    assert.ok(
      JSON.parse(osResult.stdout).issues.some(
        (entry) =>
          entry.code === "cross_runtime_claim_without_target" &&
          entry.runtimeId === "claude_code",
      ),
    );

    provider.support.default.os.windows = "unsupported";
    provider.support.runtimes.codex.state = "blocked_for_execution";
    provider.runtimeAdapters.codex.state = "blocked_for_execution";
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    const pairResult = runValidator(["--registry", registryPath, "--json"]);
    assert.notEqual(pairResult.status, 0);
    assert.ok(
      JSON.parse(pairResult.stdout).issues.some(
        (entry) =>
          entry.code === "inconsistent_state_status" && entry.runtimeId === "codex",
      ),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runtime-scoped verified claims need verified state and unknown runtime keys are rejected", () => {
  const registry = JSON.parse(
    readFileSync("config/capability-index/provider-registry.json", "utf8"),
  );
  const provider = registry.providers.find(
    (entry) => entry.id === "hook-script-codex-hookprompt-adapter",
  );
  provider.support.runtimes.codex.status = "verified";
  provider.runtimeAdapters.codex.status = "verified";
  provider.support.runtimes.gemini = structuredClone(provider.support.runtimes.codex);
  provider.runtimeAdapters.gemini = structuredClone(provider.runtimeAdapters.codex);
  registry.runtimes.push("gemini");

  const schema = JSON.parse(
    readFileSync("config/contracts/capability-provider.schema.json", "utf8"),
  );
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  assert.equal(validate(registry), false);

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-provider-runtime-keys-"));
  const registryPath = path.join(tempDir, "provider-registry.json");
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  try {
    const result = runValidator(["--registry", registryPath, "--json"]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout);
    const codes = new Set(payload.issues.map((entry) => entry.code));
    assert.ok(codes.has("inconsistent_state_status"));
    assert.ok(codes.has("unknown_runtime_claim_key"));
    assert.ok(codes.has("unknown_runtime_registry_key"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("activation metadata cannot replace support authority or mint live execution claims", () => {
  const registry = JSON.parse(
    readFileSync("config/capability-index/provider-registry.json", "utf8"),
  );
  const provider = registry.providers.find(
    (entry) => entry.id === "hook-script-codex-hookprompt-adapter",
  );
  provider.support.runtimes.codex.live = true;
  provider.runtimeAdapters.codex.live = true;

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-provider-activation-claims-"));
  const registryPath = path.join(tempDir, "provider-registry.json");
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  try {
    const result = runValidator(["--registry", registryPath, "--json"]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.ok(
      payload.issues.some(
        (entry) => entry.code === "metadata_claim_forbidden" && entry.runtimeId === "codex",
      ),
    );
    assert.ok(
      payload.issues.some(
        (entry) => entry.code === "static_selected_claim_forbidden" && entry.runtimeId === "codex",
      ),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("blocked support cannot be upgraded by a runtime activation event", () => {
  const registry = JSON.parse(
    readFileSync("config/capability-index/provider-registry.json", "utf8"),
  );
  const provider = registry.providers.find(
    (entry) => entry.id === "hook-script-codex-hookprompt-adapter",
  );
  const blocked = {
    state: "blocked_for_execution",
    status: "blocked",
    installLayers: Object.fromEntries(
      Object.keys(provider.support.runtimes.codex.installLayers).map((key) => [key, "unsupported"]),
    ),
    os: Object.fromEntries(
      Object.keys(provider.support.runtimes.codex.os).map((key) => [key, "unsupported"]),
    ),
    reason: "test-only blocked support",
  };
  provider.support.runtimes.codex = blocked;
  provider.runtimeAdapters.codex = {
    ...provider.runtimeAdapters.codex,
    ...blocked,
    activationEvent: "forged live activation",
  };

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-provider-blocked-activation-"));
  const registryPath = path.join(tempDir, "provider-registry.json");
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  try {
    const result = runValidator(["--registry", registryPath, "--json"]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.ok(
      payload.issues.some(
        (entry) => entry.code === "blocked_runtime_activation_claim" && entry.runtimeId === "codex",
      ),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runtime adapter projection comparison is independent of object key order", () => {
  const registry = JSON.parse(
    readFileSync("config/capability-index/provider-registry.json", "utf8"),
  );
  const provider = registry.providers.find(
    (entry) => entry.id === "runtime-native-claude-code",
  );
  provider.runtimeAdapters.claude_code.installLayers = Object.fromEntries(
    Object.entries(provider.runtimeAdapters.claude_code.installLayers).reverse(),
  );

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-provider-key-order-"));
  const registryPath = path.join(tempDir, "provider-registry.json");
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  try {
    const result = runValidator(["--registry", registryPath, "--json"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("meta-skill-creator is the formal skill creation provider for Claude Code and Codex", () => {
  const skills = JSON.parse(readFileSync("config/skills.json", "utf8"));
  const dependencies = JSON.parse(
    readFileSync("config/capability-index/dependency-project-registry.json", "utf8"),
  );
  const registry = JSON.parse(
    readFileSync("config/capability-index/provider-registry.json", "utf8"),
  );

  const manifestEntry = skills.skills.find((skill) => skill.id === "meta-skill-creator");
  assert.ok(manifestEntry, "meta-skill-creator must be installable from the skills manifest");
  assert.equal(manifestEntry.repo, "${skillOwner}/meta-skill-creator");
  assert.equal(manifestEntry.subdir, "skills/meta-skill-creator");
  assert.deepEqual(manifestEntry.targets, ["claude", "codex"]);
  assert.equal(skills.skills.some((skill) => skill.id === "skill-creator"), false);

  const dependency = dependencies.projects.find((project) => project.id === "meta-skill-creator");
  assert.ok(dependency, "meta-skill-creator must be present in the dependency registry");
  assert.deepEqual(dependency.interface.requiredRuntime, ["claude_code", "codex"]);
  assert.equal(dependencies.projects.some((project) => project.id === "skill-creator"), false);

  const provider = registry.providers.find(
    (candidate) => candidate.id === "external-skill-meta-skill-creator",
  );
  assert.ok(provider, "meta-skill-creator must be present in the provider registry");
  assert.deepEqual(provider.mappings.skillsJsonIds, ["meta-skill-creator"]);
  assert.equal(provider.runtimeAdapters.cursor.status, "blocked");
  assert.equal(provider.runtimeAdapters.openclaw.status, "blocked");
  assert.equal(
    registry.providers.some((candidate) => candidate.id === "external-skill-skill-creator"),
    false,
  );
});

test("strict global hook validation checks Codex and Cursor HookPrompt adapters", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-hooks-"));
  const codexHooks = path.join(tempDir, ".codex", "hooks.json");
  const cursorHooks = path.join(tempDir, ".cursor", "hooks.json");
  mkdirSync(path.dirname(codexHooks), { recursive: true });
  mkdirSync(path.dirname(cursorHooks), { recursive: true });
  writeFileSync(codexHooks, `${JSON.stringify({ hooks: {} }, null, 2)}\n`);
  writeFileSync(cursorHooks, `${JSON.stringify({ hooks: {} }, null, 2)}\n`);

  try {
    const result = runValidator([
      "--strict-global-hooks",
      "--codex-hooks",
      codexHooks,
      "--cursor-hooks",
      cursorHooks,
      "--json",
    ]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout);
    const runtimes = new Set(payload.issues.map((entry) => entry.runtimeId));
    assert.ok(runtimes.has("codex"));
    assert.ok(runtimes.has("cursor"));
    assert.match(JSON.stringify(payload.issues), /UserPromptSubmit/);
    assert.match(JSON.stringify(payload.issues), /beforeSubmitPrompt/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("HookPrompt fixer writes adapter source before registering global hooks", () => {
  const source = readFileSync("scripts/validate-provider-capabilities.mjs", "utf8");

  assert.match(source, /buildHookPromptAdapterSource/);
  assert.match(
    source,
    /fs\.writeFile\(\s*adapter,\s*buildHookPromptAdapterSource\(runtimeId\)/s,
    "fix mode must create hookprompt-adapter.mjs, not only add a hooks.json command",
  );
});

test("plugin manifest entries cannot exist only in skills.json", () => {
  const registry = JSON.parse(
    readFileSync("config/capability-index/provider-registry.json", "utf8"),
  );
  registry.providers = registry.providers.filter(
    (provider) => !provider.mappings?.skillsJsonIds?.includes("superpowers"),
  );

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-providers-"));
  const registryPath = path.join(tempDir, "provider-registry.json");
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

  try {
    const result = runValidator(["--registry", registryPath]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /superpowers/);
    assert.match(result.stdout + result.stderr, /plugin|provider/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("canonical capability index exposes plugin providers", () => {
  const index = JSON.parse(
    readFileSync("config/capability-index/meta-kim-capabilities.json", "utf8"),
  );
  assert.ok(index.summary.totalPlugins >= 3, "totalPlugins must not regress to 0");
  for (const key of [
    "manifest:plugin-marketplace:superpowers",
    "manifest:plugin-marketplace:ecc",
    "manifest:plugin-marketplace:cli-anything",
  ]) {
    assert.ok(index.byCapabilityType.plugins?.[key], `${key} missing`);
  }
});
