import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CANDIDATE_RUNTIME_ADAPTER_SCHEMA_VERSION,
  assertValidQoderCandidateRuntimePlan,
  buildQoderCandidateRuntimePlan,
} from "../../src/runtimes/qoder/candidate-adapter.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

function probeFacts(overrides = {}) {
  return {
    runtimeId: "qoder",
    probeId: "probe:qoder:structural",
    evidenceRefs: ["evidence:qoder:commands", "evidence:qoder:docs"],
    capabilities: {
      rules: {
        status: "verified",
        observedPaths: [".qoder/rules/**/*.md", "AGENTS.md"],
      },
      skills: {
        status: "verified",
        observedPaths: [".qoder/skills/{skill-name}/SKILL.md"],
      },
      agents: {
        status: "verified",
        observedModes: ["plan", "--agents"],
        observedPaths: [".qoder/agents/{agent}.md"],
      },
      commands: {
        status: "verified",
        observedModes: ["/{command-name}"],
        observedPaths: [".qoder/commands/{command-name}.md"],
      },
      hooks: {
        status: "unknown",
        observedPaths: [".qoder/settings.json"],
      },
      mcp: {
        status: "unknown",
        configAuthority: "unknown",
        observedPaths: [".qoder/settings.json", ".mcp.json"],
      },
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

test("Qoder adapter emits a deterministic, deeply frozen beta plan", () => {
  const first = buildQoderCandidateRuntimePlan(probeFacts());
  const second = buildQoderCandidateRuntimePlan(probeFacts());

  assert.deepEqual(first, second);
  assertDeepFrozen(first);
  assert.deepEqual(Object.keys(first), [
    "schemaVersion",
    "runtimeId",
    "tier",
    "formalProjection",
    "probe",
    "capabilityAssessment",
    "projectionPlan",
    "invocationPolicy",
    "configurationPolicy",
    "authorization",
  ]);
  assert.equal(first.schemaVersion, CANDIDATE_RUNTIME_ADAPTER_SCHEMA_VERSION);
  assert.equal(first.runtimeId, "qoder");
  assert.equal(first.tier, "beta_compatibility");
  assert.equal(first.formalProjection, false);
  assert.equal(first.projectionPlan.integrationMode, "opt_in_rules_skills_plugin_plan");
  assert.equal(first.projectionPlan.formalProjection, false);
  assert.equal(first.projectionPlan.syncEligible, false);
  assert.equal(first.projectionPlan.installEligible, false);
  assert.deepEqual(first.projectionPlan.managedPaths, []);
  assert.deepEqual(first.invocationPolicy.headlessCommand, [
    "qodercli",
    "--permission-mode",
    "plan",
  ]);
  assert.deepEqual(first.invocationPolicy.forbiddenHeadlessModes, [
    "accept_edits",
    "auto",
    "bypass_permissions",
    "dangerously_skip_permissions",
    "dont_ask",
    "yolo",
  ]);
  assert.equal(first.invocationPolicy.yolo, false);
  assert.equal(first.invocationPolicy.hooks, "not_claimed");
  assert.equal(first.configurationPolicy.writeConfig, false);
  assert.equal(first.configurationPolicy.overwriteWholeFile, false);
  assert.equal(first.configurationPolicy.mcp.replacement, false);
  assert.equal(first.configurationPolicy.mcp.autoStart, false);
  assert.ok(Object.values(first.authorization).every((value) => value === false));
  assertValidQoderCandidateRuntimePlan(first);
});

test("missing and unknown facts remain fail-closed", () => {
  const result = buildQoderCandidateRuntimePlan(probeFacts({
    capabilities: {
      rules: { status: "unknown", observedPaths: [] },
      skills: { status: "verified", observedPaths: [] },
    },
  }));

  assert.equal(result.capabilityAssessment.status, "fail_closed");
  assert.equal(result.capabilityAssessment.rules.status, "unknown");
  assert.equal(result.capabilityAssessment.skills.status, "verified");
  assert.equal(result.capabilityAssessment.agents.status, "unknown");
  assert.equal(result.capabilityAssessment.hooks.claim, "not_claimed");
  assert.equal(result.capabilityAssessment.hooks.supported, false);
  assert.equal(result.capabilityAssessment.mcp.observedMcpSurface, false);
  assert.equal(result.authorization.modelInvocationAllowed, false);
  assert.equal(result.authorization.processSpawnAllowed, false);
});

test("the adapter rejects ambient, loose, and sensitive probe input", () => {
  assert.throws(
    () => buildQoderCandidateRuntimePlan({}),
    /probeFacts.*plain record|unsupported|runtimeId/iu,
  );
  assert.throws(
    () => buildQoderCandidateRuntimePlan({ ...probeFacts(), rawModelOutput: "model" }),
    /unsupported|sensitive/iu,
  );
  assert.throws(
    () => buildQoderCandidateRuntimePlan(probeFacts({
      evidenceRefs: ["sk-live-qoder-012345678901234567890123456789"],
    })),
    /sensitive/iu,
  );
  assert.throws(
    () => buildQoderCandidateRuntimePlan(probeFacts({
      capabilities: {
        rules: { status: "unknown", supported: true },
      },
    })),
    /support.*verified|verified.*support/iu,
  );
  assert.throws(
    () => buildQoderCandidateRuntimePlan(probeFacts({
      capabilities: {
        rules: { status: "verified", unknown: true },
      },
    })),
    /unsupported/iu,
  );
  const accessor = probeFacts();
  Object.defineProperty(accessor, "source", {
    enumerable: true,
    get: () => "ambient",
  });
  assert.throws(() => buildQoderCandidateRuntimePlan(accessor), /data properties|accessor/iu);
});

test("validator rejects forged native, write, automation, or authorization claims", () => {
  const cases = [
    ["formal projection", (plan) => { plan.formalProjection = true; }],
    ["headless mode", (plan) => { plan.invocationPolicy.headlessMode = "auto"; }],
    ["headless command", (plan) => { plan.invocationPolicy.headlessCommand = ["qodercli", "--yolo"]; }],
    ["hook claim", (plan) => { plan.capabilityAssessment.hooks.claim = "native"; }],
    ["MCP replacement", (plan) => { plan.configurationPolicy.mcp.replacement = true; }],
    ["authorization", (plan) => { plan.authorization.processSpawnAllowed = true; }],
  ];
  for (const [label, mutate] of cases) {
    const forged = structuredClone(buildQoderCandidateRuntimePlan(probeFacts()));
    mutate(forged);
    assert.throws(
      () => assertValidQoderCandidateRuntimePlan(forged),
      /candidate|false|plan|hook|replace|authorization|canonical/iu,
      label,
    );
  }
});

test("canonical Qoder material is explanatory only and adapter has no execution or write dependencies", () => {
  const asset = readFileSync(
    path.join(REPO_ROOT, "config", "candidate-runtime-assets", "qoder", "CANDIDATE_PROBE.md"),
    "utf8",
  );
  const source = readFileSync(
    path.join(REPO_ROOT, "src", "runtimes", "qoder", "candidate-adapter.mjs"),
    "utf8",
  );
  assert.match(asset, /beta_compatibility/u);
  assert.match(asset, /official|官方/iu);
  assert.match(asset, /\.qoder\/rules/iu);
  assert.match(asset, /\.qoder\/skills/iu);
  assert.match(asset, /\.qoder\/agents/iu);
  assert.match(asset, /\.qoder\/commands/iu);
  assert.match(asset, /settings\.json/iu);
  assert.match(asset, /mcp/iu);
  assert.match(asset, /plan-only|plan-only/iu);
  assert.doesNotMatch(source, /from\s+["']node:(?:child_process|fs|net|http|https|worker_threads)["']/u);
  assert.doesNotMatch(source, /\b(?:spawn|exec|fetch|writeFile|appendFile|mkdir|rename|rmSync)\s*\(/u);
  assert.doesNotMatch(source, /\bprocess\.(?:env|execPath|cwd|kill)\b/u);
});
