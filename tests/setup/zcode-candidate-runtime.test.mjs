import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CANDIDATE_RUNTIME_ADAPTER_SCHEMA_VERSION,
  assertValidZCodeCandidateRuntimePlan,
  buildZCodeCandidateRuntimePlan,
} from "../../src/runtimes/zcode/candidate-adapter.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

function probeFacts(overrides = {}) {
  return {
    runtimeId: "zcode",
    probeId: "probe:zcode:structural",
    evidenceRefs: ["evidence:zcode:help", "evidence:zcode:version"],
    capabilities: {
      headless: {
        status: "verified",
        observedModes: ["plan", "build", "edit", "yolo"],
      },
      hooks: { status: "unknown" },
      mcp: { status: "unknown", configAuthority: "unknown" },
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

test("ZCode adapter emits a deterministic, deeply frozen candidate plan", () => {
  const first = buildZCodeCandidateRuntimePlan(probeFacts());
  const second = buildZCodeCandidateRuntimePlan(probeFacts());

  assert.deepEqual(first, second);
  assertDeepFrozen(first);
  assert.equal(first.schemaVersion, CANDIDATE_RUNTIME_ADAPTER_SCHEMA_VERSION);
  assert.equal(first.runtimeId, "zcode");
  assert.equal(first.tier, "beta_compatibility");
  assert.equal(first.formalProjection, false);
  assert.equal(first.projectionPlan.formalProjection, false);
  assert.equal(first.projectionPlan.syncEligible, false);
  assert.equal(first.projectionPlan.installEligible, false);
  assert.deepEqual(first.projectionPlan.managedPaths, []);
  assert.deepEqual(first.invocationPolicy.headlessCommand, ["zcode", "--mode", "plan"]);
  assert.equal(first.invocationPolicy.yolo, false);
  assert.equal(first.invocationPolicy.hooks, "not_claimed");
  assert.equal(first.configurationPolicy.mcp.replacement, false);
  assert.equal(first.configurationPolicy.mcp.autoStart, false);
  assert.ok(Object.values(first.authorization).every((value) => value === false));
  assertValidZCodeCandidateRuntimePlan(first);
});

test("unknown and unverified facts fail closed without inventing support", () => {
  const result = buildZCodeCandidateRuntimePlan(probeFacts({
    capabilities: {
      headless: { status: "unknown", observedModes: [] },
      hooks: { status: "unverified" },
      mcp: { status: "verified", configAuthority: "user_owned" },
    },
  }));

  assert.equal(result.capabilityAssessment.status, "fail_closed");
  assert.equal(result.capabilityAssessment.headless.observedHeadlessSurface, false);
  assert.equal(result.capabilityAssessment.hooks.claim, "not_claimed");
  assert.equal(result.capabilityAssessment.hooks.supported, false);
  assert.equal(result.capabilityAssessment.mcp.observedMcpSurface, true);
  assert.equal(result.configurationPolicy.mode, "preserve_user_merge_plan_only");
  assert.equal(result.authorization.modelInvocationAllowed, false);
  assert.equal(result.authorization.processSpawnAllowed, false);
});

test("the adapter rejects ambient, loose, and sensitive probe input", () => {
  assert.throws(
    () => buildZCodeCandidateRuntimePlan({}),
    /probeFacts.*plain record|unsupported|runtimeId/iu,
  );
  assert.throws(
    () => buildZCodeCandidateRuntimePlan({
      ...probeFacts(),
      rawModelOutput: "do this now",
    }),
    /unsupported|sensitive/iu,
  );
  assert.throws(
    () => buildZCodeCandidateRuntimePlan(probeFacts({
      evidenceRefs: ["sk-live-zcode-secret-material"],
    })),
    /sensitive/iu,
  );
  assert.throws(
    () => buildZCodeCandidateRuntimePlan(probeFacts({
      capabilities: {
        headless: { status: "unknown", supported: true, observedModes: [] },
        hooks: { status: "unknown" },
        mcp: { status: "unknown" },
      },
    })),
    /support.*verified|verified.*support/iu,
  );
  const accessor = probeFacts();
  Object.defineProperty(accessor, "source", {
    enumerable: true,
    get: () => "ambient",
  });
  assert.throws(() => buildZCodeCandidateRuntimePlan(accessor), /data properties|accessor/iu);
});

test("validator rejects forged native, yolo, hook, replacement, or authorization claims", () => {
  const cases = [
    ["formalProjection", (plan) => { plan.formalProjection = true; }],
    ["headless mode", (plan) => { plan.invocationPolicy.headlessMode = "yolo"; }],
    ["headless command", (plan) => { plan.invocationPolicy.headlessCommand = ["zcode", "--mode", "yolo"]; }],
    ["hook claim", (plan) => { plan.capabilityAssessment.hooks.claim = "native"; }],
    ["mcp replacement", (plan) => { plan.configurationPolicy.mcp.replacement = true; }],
    ["authorization", (plan) => { plan.authorization.processSpawnAllowed = true; }],
  ];
  for (const [label, mutate] of cases) {
    const forged = structuredClone(buildZCodeCandidateRuntimePlan(probeFacts()));
    mutate(forged);
    assert.throws(() => assertValidZCodeCandidateRuntimePlan(forged), /candidate|false|plan|hook|replace|authorization|canonical/iu, label);
  }
});

test("canonical ZCode material is explanatory only and adapter has no execution or write dependencies", () => {
  const template = readFileSync(
    path.join(REPO_ROOT, "config", "candidate-runtime-assets", "zcode", "CANDIDATE_PROBE.md"),
    "utf8",
  );
  const source = readFileSync(
    path.join(REPO_ROOT, "src", "runtimes", "zcode", "candidate-adapter.mjs"),
    "utf8",
  );
  assert.match(template, /beta_compatibility/u);
  assert.match(template, /beta_compatibility.*runtime projection/iu);
  assert.match(template, /packed structural adapter|opt-in/u);
  assert.doesNotMatch(source, /from\s+["']node:(?:child_process|fs|net|http|https|fetch)/u);
  assert.doesNotMatch(source, /\b(?:spawn|exec|fetch)\s*\(/u);
  assert.doesNotMatch(source, /\bprocess\.(?:env|exec|spawn|cwd)\b/u);
  assert.doesNotMatch(source, /writeFile|appendFile|mkdir|rmSync|rename/u);
});
