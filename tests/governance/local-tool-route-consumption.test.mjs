import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { componentHash, stableJson, sha256 } from "../../scripts/dependency-agent-discovery.mjs";
import { buildTaskGoalContract, taskOutcomeDigest } from "../../src/domain/governance/task-outcome.mjs";
import { intentDialogueDigest, prepareIntentDialogue } from "../../scripts/governed-execution/intent-dialogue.mjs";
import { evaluateObservedLocalToolOutcome, LOCAL_SCAN_OUTCOME_CRITERIA, prepareLocalToolRequest } from "../../scripts/run-meta-theory-governed-execution.mjs";
import { LOCAL_DEPENDENCY_TOOL_CONTRACT } from "../../scripts/governed-execution/local-dependency-tool-contract.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const task = "Run a local security scan on the explicitly authorized fixture target.";
function intent(root, target, strategy = "fast_usable", sourceReview = {
  status: 'pass', dependencyId: "kim-service", sourceRoot: root, componentVersion: "1.1.0",
  contractSha256: "a".repeat(64), componentContentSha256: "b".repeat(64), indexSha256: "c".repeat(64),
  evidenceRefs: ["test-only-reviewed-source"],
}) {
  const confirmed = { taskHash: taskOutcomeDigest(task), outcome: task,
    constraints: { workspaceRoot: root, target, scopeFiles: [target], deliveryStrategy: strategy, localToolSourceReview: sourceReview },
    acceptanceCriteria: [], evidenceRefs: ["test-only-host-understanding-boundary"] };
  const digest = intentDialogueDigest(confirmed);
  const dialogue = prepareIntentDialogue({ task, confirmedIntent: confirmed,
    sharedUnderstandingConfirmed: { trusted: true, binding: "plan-challenge-understanding-confirmation",
      taskHash: confirmed.taskHash, intentDigest: digest, evidenceRefs: confirmed.evidenceRefs } });
  return { dialogue, localToolInput: { taskHash: confirmed.taskHash, intentDigest: digest,
    input: { schemaVersion: 1, workspaceRoot: root, target, rules: "rules/local-security.yml" } } };
}
function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meta-kim-local-route-"));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const target = path.join(root, "owned-target"); fs.mkdirSync(target);
  return { root, target };
}

test("explicit target binding is unchanged by delivery strategy and grants no native permission", (t) => {
  const { root, target } = temp(t);
  for (const strategy of ["fast_usable", "long_term_extensible"]) {
    const bound = intent(root, target, strategy);
    const result = prepareLocalToolRequest({ task, ...bound });
    assert.equal(result.status, "ready"); assert.equal(result.input.target, target);
    assert.equal(result.input.workspaceRoot, root); assert.equal(result.executionAllowed, undefined);
    assert.equal(bound.dialogue.executionAllowed, false); assert.equal(bound.dialogue.nativeInvocationVerified, false);
  }
});

test("scope, task, intent, extra fields and remote rules cannot broaden local execution", (t) => {
  const { root, target } = temp(t);
  const bound = intent(root, target);
  const reject = (mutate, reason) => {
    const copy = structuredClone(bound); mutate(copy.localToolInput);
    const result = prepareLocalToolRequest({ task, ...copy });
    assert.equal(result.status, "blocked"); assert.ok(result.blockers.includes(reason)); assert.equal(result.input, null);
  };
  reject((value) => { value.taskHash = "a".repeat(64); }, "local_tool_intent_binding_mismatch");
  reject((value) => { value.intentDigest = "a".repeat(64); }, "local_tool_intent_binding_mismatch");
  reject((value) => { value.input.target = root; }, "target_not_in_confirmed_scope");
  reject((value) => { value.input.target = path.dirname(root); }, "local_target_outside_workspace");
  reject((value) => { value.nativePermission = true; }, "unsupported_local_tool_binding_field");
  reject((value) => { value.input.outputDir = root; }, "invalid_exact_local_tool_input");
  reject((value) => { value.input.rules = "https://semgrep.dev/rules"; }, "invalid_exact_local_tool_input");
  assert.equal(prepareLocalToolRequest({ task, dialogue: bound.dialogue }).status, "blocked");
  assert.equal(prepareLocalToolRequest({ task, dialogue: prepareIntentDialogue({ task }), localToolInput: bound.localToolInput }).status, "blocked");
  assert.equal(prepareLocalToolRequest({ task: "Build a website for long-term expansion", dialogue: null }).applies, false);
});

async function dependencyFixture(t, version = "1.1.0") {
  const { root, target } = temp(t);
  const componentRoot = path.join(root, "skills/semgrep-skill");
  const capability = { id: "local-security-scan", summary: "Local security scan", useWhen: ["Scan local source security"],
    doNotUseWhen: ["No install, network, or remediation"],
    input: { type: "object", required: ["schemaVersion", "workspaceRoot", "target"], properties: {} },
    output: { type: "object", required: ["completed"], properties: {} },
    permissions: ["Read selected target", "Execute existing local tool"], sideEffects: [], humanGate: { required: false, when: [] },
    validation: ["tests/behavior.py"], invocation: { schemaVersion: 1, type: "local_cli", runtime: "python", entrypoint: "scripts/scan.py",
      argv: ["--input-json", "-"], inputTransport: "stdin_json", outputTransport: "stdout_json", shell: false } };
  const contract = { schemaVersion: 1, id: "semgrep-skill", componentType: "skill", componentVersion: version,
    entrypoint: "SKILL.md", capabilities: [capability] };
  for (const [file, content] of Object.entries({ "SKILL.md": "---\nname: semgrep-skill\n---\n# Local security scan\n", "capability.json": stableJson(contract),
    "tests/behavior.py": "raise RuntimeError('route discovery must never execute this')\n",
    "scripts/scan.py": "raise RuntimeError('this is a discovery-only fixture')\n" })) {
    const name = path.join(componentRoot, file); fs.mkdirSync(path.dirname(name), { recursive: true }); fs.writeFileSync(name, content);
  }
  const contentSha256 = await componentHash(componentRoot), contractSha256 = sha256(stableJson(contract));
  const component = { id: contract.id, componentType: "skill", componentVersion: version, path: "skills/semgrep-skill", entrypoint: "SKILL.md",
    capabilityIds: [capability.id], validation: capability.validation, contentSha256, contractSha256 };
  const index = { schemaVersion: 1, componentCount: 1, capabilityCount: 1, components: [component], capabilities: [{ ...capability,
    componentId: component.id, componentType: "skill", componentVersion: version, componentPath: component.path,
    entrypoint: "SKILL.md", componentContentSha256: contentSha256, contractSha256 }] };
  fs.mkdirSync(path.join(root, "generated")); fs.writeFileSync(path.join(root, "generated/capabilities.json"), stableJson(index));
  return { root, target, contract, sourceReview: { status: 'pass', dependencyId: "kim-service", sourceRoot: root, componentVersion: version,
    contractSha256, componentContentSha256: contentSha256,
    indexSha256: sha256(fs.readFileSync(path.join(root, "generated/capabilities.json"))), evidenceRefs: ["test-only-reviewed-source"] } };
}
function route(request, root) {
  const result = spawnSync(process.execPath, [path.join(repo, "scripts/select-execution-route.mjs"), "--task", task,
    "--runtime", "codex", "--os", process.platform === "win32" ? "windows" : "linux", "--json", "--runner-compact",
    "--local-tool-request-json", JSON.stringify(request)], { cwd: repo, env: { ...process.env, META_KIM_KIM_SERVICE_ROOT: root },
    encoding: "utf8", timeout: 60000, maxBuffer: 20 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}

test("route discovery retains exact source contract and target but leaves native gates ungranted", async (t) => {
  const fixture = await dependencyFixture(t);
  const request = prepareLocalToolRequest({ task, ...intent(fixture.root, fixture.target, "fast_usable", fixture.sourceReview) });
  const selected = route(request, fixture.root);
  if (!LOCAL_DEPENDENCY_TOOL_CONTRACT.supportedPlatforms.includes(process.platform)) {
    assert.equal(selected.localToolExecutionGate.status, "blocked");
    assert.ok(selected.localToolExecutionGate.blockers.includes("local_tool_platform_unsupported"));
    assert.equal(selected.recommendedRoute, null); return;
  }
  assert.equal(selected.localToolExecutionGate.status, "ready", JSON.stringify(selected.ownerDiscoveryPacket.capabilityDiscoverySearchLog.filter((entry) => entry.source === "dependency_skill_contract")));
  const provider = selected.localToolExecutionGate.selectedCapability;
  assert.deepEqual(provider.fullContract, fixture.contract);
  assert.equal(provider.sourceRoot, fixture.root); assert.match(provider.indexSha256, /^[a-f0-9]{64}$/u);
  assert.equal(selected.localToolExecutionGate.input.target, fixture.target);
  assert.equal(provider.invocationStatus, "not_invoked"); assert.equal(provider.canExecute, false);
  assert.equal(selected.routeExecutionGate.canEnterExecution, false);
  assert.equal(selected.routeExecutionGate.executionAuthorized, false);
  assert.equal(selected.localToolExecutionGate.grantsNativePermission, false);
});

test("unreviewed component versions stay blocked without an unrelated route fallback", async (t) => {
  const fixture = await dependencyFixture(t, "1.0.0");
  const selected = route(prepareLocalToolRequest({ task, ...intent(fixture.root, fixture.target, "fast_usable", fixture.sourceReview) }), fixture.root);
  assert.equal(selected.localToolExecutionGate.status, "blocked");
  assert.equal(selected.recommendedRoute, null); assert.deepEqual(selected.rankedRoutes, []);
});

test("an unreviewed or differently reviewed source cannot acquire a local tool route", async (t) => {
  const fixture = await dependencyFixture(t);
  const absent = prepareLocalToolRequest({ task, ...intent(fixture.root, fixture.target, "fast_usable", null) });
  assert.equal(absent.status, "blocked"); assert.ok(absent.blockers.includes("exact_local_source_review_required"));
  for (const field of ["contractSha256", "componentContentSha256", "indexSha256", "sourceRoot"]) {
    const review = { ...fixture.sourceReview, [field]: field === "sourceRoot" ? repo : "d".repeat(64) };
    const selected = route(prepareLocalToolRequest({ task, ...intent(fixture.root, fixture.target, "fast_usable", review) }), fixture.root);
    assert.equal(selected.localToolExecutionGate.status, "blocked"); assert.equal(selected.recommendedRoute, null);
    assert.equal(selected.localToolExecutionGate.sourceReviewBinding.status, "not_verified");
  }
});

test('blocked or missing source-review verdict cannot launch a local route', (t) => {
  const { root, target } = temp(t);
  for (const status of [undefined, 'blocked_source_index_drift', 'unknown', 'failed']) {
    const bound = intent(root, target);
    bound.dialogue.constraints.localToolSourceReview.status = status;
    const request = prepareLocalToolRequest({task, ...bound});
    assert.equal(request.status, 'blocked');
    assert(request.blockers.includes('exact_local_source_review_required'));
  }
});

test("saved matching JSON and fabricated scanner stdout cannot establish outcome observations", () => {
  const goal = buildTaskGoalContract({ task, acceptanceCriteria: Object.entries(LOCAL_SCAN_OUTCOME_CRITERIA)
    .map(([id, description]) => ({ id, description, kind: "deterministic" })) });
  const result = evaluateObservedLocalToolOutcome({ goalContractPacket: goal }, {
    status: "pass", actualToolExecution: true, evidenceKind: "first_party_local_tool_subprocess",
    workerResults: [{ completed: true, localToolProcessInvoked: true, sourceUnmodifiedVerified: true,
      localToolReceipt: { path: "matching-receipt.json" }, outputText: JSON.stringify({ status: "completed", completed: true,
        filesModified: false, networkUsed: false, rules: { source: "canonical:skills/semgrep-skill/rules/local-security.yml",
          sourceSha256: "a".repeat(64), effectiveSha256: "b".repeat(64) } }) }],
  });
  assert.equal(result.status, "incomplete"); assert.equal(result.observationCount, 0);
  assert.equal(result.nativeInvocationVerified, false); assert.equal(result.publicReady, false);
});
