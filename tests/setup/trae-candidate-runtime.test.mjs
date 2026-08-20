import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CANDIDATE_RUNTIME_ADAPTER_SCHEMA_VERSION,
  assertValidTraeCandidateRuntimePlan,
  buildTraeCandidateRuntimePlan,
} from "../../src/runtimes/trae/candidate-adapter.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

function probeFacts(overrides = {}) {
  return {
    runtimeId: "trae",
    probeId: "probe:trae:official-docs",
    evidenceRefs: [
      "https://docs.trae.ai/ide/agent",
      "https://docs.trae.ai/ide/rules",
      "https://docs.trae.ai/ide/skills",
      "https://docs.trae.ai/ide/model-context-protocol",
    ],
    capabilities: {
      instructions: {
        status: "verified",
        observedPaths: ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"],
        observedFormats: ["plain-text"],
      },
      rules: {
        status: "verified",
        observedPaths: [".trae/rules/", "%userprofile%/.trae/user_rules"],
        observedFormats: ["markdown-frontmatter"],
        observedModes: ["alwaysApply", "description", "globs"],
      },
      skills: {
        status: "verified",
        observedPaths: [".trae/skills/{skill-name}/SKILL.md", ".agents/skills/"],
        observedFormats: ["SKILL.md"],
        observedModes: ["on-demand", "project", "global"],
      },
      agents: {
        status: "verified",
        observedModes: ["custom", "@Agent", "callable-by-other-agents"],
      },
      modes: {
        status: "verified",
        observedModes: ["IDE", "SOLO"],
      },
      mcp: {
        status: "verified",
        observedModes: ["external-tools"],
        transportTypes: ["stdio", "SSE", "Streamable HTTP"],
        configAuthority: "unknown",
      },
      commands: { status: "unknown" },
      memory: {
        status: "verified",
        observedPaths: [
          "%userprofile%/.trae/memory/",
          "%userprofile%/.trae/memory/projects/{project_path}/",
        ],
        observedModes: ["global", "project", "local-only"],
      },
      hooks: { status: "not_observed" },
    },
    ...overrides,
  };
}

function assertDeepFrozen(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

test("Trae adapter emits a deterministic, deeply frozen structural plan", () => {
  const first = buildTraeCandidateRuntimePlan(probeFacts());
  const second = buildTraeCandidateRuntimePlan(structuredClone(probeFacts()));

  assert.deepEqual(first, second);
  assertDeepFrozen(first);
  assert.equal(first.schemaVersion, CANDIDATE_RUNTIME_ADAPTER_SCHEMA_VERSION);
  assert.equal(first.runtimeId, "trae");
  assert.equal(first.tier, "beta_compatibility");
  assert.equal(first.formalProjection, false);
  assert.equal(first.capabilityAssessment.status, "fail_closed");
  assert.equal(first.projectionPlan.formalProjection, false);
  assert.equal(first.projectionPlan.syncEligible, false);
  assert.equal(first.projectionPlan.installEligible, false);
  assert.deepEqual(first.projectionPlan.managedPaths, []);
  assert.deepEqual(first.invocationPolicy.observedModes, ["IDE", "SOLO"]);
  assert.equal(first.invocationPolicy.modelInvocation, "forbidden");
  assert.equal(first.invocationPolicy.processSpawn, "forbidden");
  assert.equal(first.invocationPolicy.commandExecution, "forbidden");
  assert.equal(first.invocationPolicy.mcpToolInvocation, "forbidden");
  assert.equal(first.configurationPolicy.writeConfig, false);
  assert.equal(first.configurationPolicy.mcp.writeConfig, false);
  assert.equal(first.configurationPolicy.mcp.configPathClaim, "unknown");
  assert.ok(Object.values(first.authorization).every((value) => value === false));
  assertValidTraeCandidateRuntimePlan(first);
});

test("official surfaces remain explicit facts and missing facts fail closed", () => {
  const result = buildTraeCandidateRuntimePlan({
    runtimeId: "trae",
    probeId: "probe:trae:partial",
    evidenceRefs: ["evidence:trae:partial"],
    capabilities: {
      rules: { status: "verified", observedPaths: [".trae/rules/"] },
      skills: { status: "unknown" },
      agents: { status: "verified", observedModes: ["custom"] },
      mcp: { status: "verified", transportTypes: ["stdio"] },
    },
  });

  assert.equal(result.capabilityAssessment.status, "fail_closed");
  assert.equal(result.capabilityAssessment.rules.observedSurface, true);
  assert.equal(result.capabilityAssessment.skills.observedSurface, false);
  assert.equal(result.capabilityAssessment.mcp.observedSurface, true);
  assert.deepEqual(result.capabilityAssessment.mcp.transportTypes, ["stdio"]);
  assert.equal(result.capabilityAssessment.mcp.configPathClaim, "unknown");
  assert.equal(result.capabilityAssessment.hooks.claim, "not_claimed");
  assert.equal(result.capabilityAssessment.hooks.supported, false);
  assert.equal(result.capabilityAssessment.commands.claim, "not_claimed");
  assert.equal(result.capabilityAssessment.commands.supported, false);
  assertValidTraeCandidateRuntimePlan(result);
});

test("capability aliases normalize deterministically without broadening the surface", () => {
  const result = buildTraeCandidateRuntimePlan({
    runtimeId: "trae",
    probeId: "probe:trae:aliases",
    evidenceRefs: ["evidence:trae:aliases"],
    capabilities: {
      instruction_context: { status: "verified", observedPaths: ["AGENTS.md"] },
      skill_workflow: { status: "verified", observedPaths: [".trae/skills/"] },
      agent_mode: { status: "verified", observedModes: ["custom"] },
      mcp_tooling: { status: "unknown" },
      memory_context: { status: "unknown" },
    },
  });

  assert.equal(result.probe.capabilities.instructions.status, "verified");
  assert.equal(result.probe.capabilities.skills.status, "verified");
  assert.equal(result.probe.capabilities.agents.status, "verified");
  assert.equal(result.probe.capabilities.mcp.status, "unknown");
  assert.equal(result.probe.capabilities.memory.status, "unknown");
  assertValidTraeCandidateRuntimePlan(result);
});

test("invalid, ambient, sensitive, and forged input is rejected", () => {
  assert.throws(() => buildTraeCandidateRuntimePlan({}), /probeFacts.*plain record|probeId|evidenceRefs/iu);
  assert.throws(
    () => buildTraeCandidateRuntimePlan({
      ...probeFacts(),
      rawModelOutput: "use the tool now",
    }),
    /unsupported|sensitive/iu,
  );
  assert.throws(
    () => buildTraeCandidateRuntimePlan({
      ...probeFacts(),
      evidenceRefs: ["sk-live-trae-secret-material"],
    }),
    /sensitive/iu,
  );
  assert.throws(
    () => buildTraeCandidateRuntimePlan({
      ...probeFacts(),
      capabilities: {
        ...probeFacts().capabilities,
        rules: { status: "unknown", supported: true },
      },
    }),
    /support.*verified|verified.*support/iu,
  );
  const accessor = probeFacts();
  Object.defineProperty(accessor, "source", {
    enumerable: true,
    get: () => "ambient",
  });
  assert.throws(() => buildTraeCandidateRuntimePlan(accessor), /data properties|accessor/iu);
});

test("validator rejects native, write, MCP, and authorization claims", () => {
  const cases = [
    ["formal projection", (plan) => { plan.formalProjection = true; }],
    ["process spawn", (plan) => { plan.invocationPolicy.processSpawn = "allowed"; }],
    ["MCP invocation", (plan) => { plan.invocationPolicy.mcpToolInvocation = "allowed"; }],
    ["configuration write", (plan) => { plan.configurationPolicy.writeConfig = true; }],
    ["MCP replacement", (plan) => { plan.configurationPolicy.mcp.replacement = true; }],
    ["authorization", (plan) => { plan.authorization.processSpawnAllowed = true; }],
  ];
  for (const [label, mutate] of cases) {
    const forged = structuredClone(buildTraeCandidateRuntimePlan(probeFacts()));
    mutate(forged);
    assert.throws(
      () => assertValidTraeCandidateRuntimePlan(forged),
      /candidate|false|forbidden|plan|replace|authorization|canonical/iu,
      label,
    );
  }
});

test("Trae asset and adapter stay structural and side-effect free", () => {
  const asset = readFileSync(
    path.join(REPO_ROOT, "config", "candidate-runtime-assets", "trae", "CANDIDATE_PROBE.md"),
    "utf8",
  );
  const source = readFileSync(
    path.join(REPO_ROOT, "src", "runtimes", "trae", "candidate-adapter.mjs"),
    "utf8",
  );
  assert.match(asset, /beta_compatibility/u);
  assert.match(asset, /official.*Trae|Trae.*documentation/iu);
  assert.match(asset, /packed structural adapter|opt-in/u);
  assert.match(asset, /\.trae\/rules|\.trae\/skills/u);
  assert.doesNotMatch(source, /from\s+["']node:(?:child_process|fs|net|http|https|worker_threads)["']/u);
  assert.doesNotMatch(source, /\b(?:spawn|exec|fetch)\s*\(/u);
  assert.doesNotMatch(source, /\bprocess\.(?:env|execPath|cwd|kill)\b/u);
  assert.doesNotMatch(source, /writeFile|appendFile|mkdir|rmSync|rename/u);
});
