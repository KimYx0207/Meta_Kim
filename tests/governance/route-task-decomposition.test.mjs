import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { decomposeTaskActions, extractActionPaths } from "../../scripts/task-action-decomposition.mjs";
import { createGovernanceRuntimeFixture } from "../helpers/governance-runtime-fixture.mjs";

const orderedTask = "Run meta-theory. First inspect the API contract in src/api/contract.json; then use the API contract findings to review src/client/types.ts; finally review tests/client.test.ts against those findings.";
let fixture;
before(() => { fixture = createGovernanceRuntimeFixture(null); });
after(() => fixture?.cleanup());

function route(task, compact = true, os = "windows") {
  const result = fixture.run([
    "scripts/select-execution-route.mjs", "--task", task, "--runtime", "codex", "--os", os, "--json",
    ...(compact ? ["--runner-compact"] : []),
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("ordered API review stays three complete actions with explicit prerequisites", () => {
  const actions = decomposeTaskActions(orderedTask);
  assert.equal(actions.length, 3);
  assert.deepEqual(actions.map((action) => extractActionPaths(action.terms)), [
    ["src/api/contract.json"], ["src/client/types.ts"], ["tests/client.test.ts"],
  ]);
  assert.deepEqual(actions.map((action) => action.dependsOnIndexes), [[], [0], [0, 1]]);
  assert.match(actions[2].terms, /against those findings$/u);
});

test("one action with multiple paths and conjunctions stays one action", () => {
  const actions = decomposeTaskActions("Review src/API/Contract.json and src/Client/Types.ts together and compare their fields.");
  assert.equal(actions.length, 1);
  assert.deepEqual(extractActionPaths(actions[0].terms), ["src/API/Contract.json", "src/Client/Types.ts"]);
});

test("URLs, versions and decimals do not become lanes", () => {
  const actions = decomposeTaskActions("Inspect https://example.com/v1.2.3/api and compare version 3.6.2 with the 0.25 threshold in src/Version.ts.");
  assert.equal(actions.length, 1);
  assert.deepEqual(extractActionPaths(actions[0].terms), ["src/Version.ts"]);
});

test("paths retain mixed case, quoted spaces, punctuation and Unicode", () => {
  const text = 'Review "D:\\Mixed Case\\客户\\API.Contract.json" and `src/UI and Data/字段.ts`, then review \'tests/Case and Types.test.ts\'.';
  const actions = decomposeTaskActions(text);
  assert.equal(actions.length, 2);
  assert.deepEqual(extractActionPaths(actions[0].terms), ["D:\\Mixed Case\\客户\\API.Contract.json", "src/UI and Data/字段.ts"]);
  assert.deepEqual(extractActionPaths(actions[1].terms), ["tests/Case and Types.test.ts"]);
  assert.deepEqual(actions[1].dependsOnIndexes, [0]);
});

test("unmarked clauses and output-dependent parallel requests keep independence unproven", () => {
  for (const task of [
    "Inspect src/A.ts; review src/B.ts.",
    "In parallel inspect src/A.ts; review src/B.ts using those findings.",
  ]) {
    assert.ok(decomposeTaskActions(task).every((action) => action.dependencyEvidence === "unproven"));
  }
});

test("Chinese sequential cues preserve complete Unicode paths", () => {
  for (const task of [
    "首先检查 src/接口/Contract.json；然后对照 src/客户端/Types.ts；最后验证 tests/客户.test.ts。",
    "先检查 src/接口/Contract.json；再据此审查 src/客户端/Types.ts；最后验证 tests/客户.test.ts。",
  ]) {
    const actions = decomposeTaskActions(task);
    assert.equal(actions.length, 3);
    assert.deepEqual(actions.map((action) => action.dependsOnIndexes), [[], [0], [0, 1]]);
    assert.deepEqual(extractActionPaths(actions[1].terms), ["src/客户端/Types.ts"]);
  }
});

test("quoted parallel terms and negated concurrency never prove independence", () => {
  for (const task of [
    'Inspect "src/parallel tasks/A.ts"; review src/B.ts.',
    'Inspect src/A.ts; review src/B.ts with the label "independent tasks".',
    "Inspect src/A.ts; review src/B.ts. Do not run in parallel.",
    "Inspect src/A.ts; review src/B.ts. Parallel tasks are unsafe.",
    "检查 src/A.ts；审查 src/B.ts。不要并行执行。",
  ]) {
    assert.ok(decomposeTaskActions(task).every((action) => action.dependencyEvidence === "unproven"), task);
  }
});

test("route and compact drafts retain all ordered actions, dependencies and full purpose", () => {
  for (const compact of [false, true]) {
    const result = route(orderedTask, compact);
    const lanes = result.recommendedRoute.parallelExecutionLanes;
    assert.equal(lanes.length, 3);
    assert.deepEqual(lanes.map((lane) => lane.dependsOn), [[], [lanes[0].laneId], [lanes[0].laneId, lanes[1].laneId]]);
    assert.deepEqual(lanes.map((lane) => lane.safetyEvidence.shardScope), [
      ["src/api/contract.json"], ["src/client/types.ts"], ["tests/client.test.ts"],
    ]);
    assert.match(lanes[2].purpose, /against those findings/u);
    assert.doesNotMatch(lanes[2].purpose, /独立交付/u);
    assert.equal(result.dispatchBoardDraft.fanoutReadiness.independentLanes, false);
    assert.equal(result.dispatchBoardDraft.orderedExecutionReadiness.ready, true);
    assert.equal(result.dispatchBoardDraft.orderedExecutionReadiness.executionAuthorized, false);
    assert.equal(result.routeExecutionGate.blockedBy.includes("parallel_lane_safety_not_proven"), false);
    assert.equal(result.routeExecutionGate.handoffStatus, "ready_for_host_handoff");
    assert.equal(result.routeExecutionGate.executionAuthorized, false);
    for (const [index, draft] of result.workerTaskPacketDrafts.entries()) {
      assert.deepEqual(draft.dependsOn, lanes[index].dependsOn);
      assert.deepEqual(draft.shardScope, lanes[index].safetyEvidence.shardScope);
      const message = JSON.parse(draft.codexSpawnBinding.message);
      assert.deepEqual(message.coordination.dependsOn, draft.dependsOn);
    }
  }
});

test("route safety and compact output preserve original case and quoted path spelling", () => {
  const result = route('Run meta-theory. First inspect "src/API Contract/用户.json"; then review "src/Client Types.ts" against the findings; finally verify "tests/Case Check.test.ts".', true, "linux");
  assert.deepEqual(result.workerTaskPacketDrafts.map((draft) => draft.shardScope), [
    ["src/API Contract/用户.json"], ["src/Client Types.ts"], ["tests/Case Check.test.ts"],
  ]);
});

test("ambiguous read-only clauses are drafts rather than proven independent execution", () => {
  const result = route("Run meta-theory. Inspect src/API.ts; review src/Client.ts.");
  assert.equal(result.recommendedRoute.parallelExecutionLanes.length, 2);
  assert.ok(result.workerTaskPacketDrafts.every((draft) => draft.safetyEvidence.status === "unproven"));
  assert.equal(result.dispatchBoardDraft.fanoutReadiness.thinkingApproved, false);
  assert.ok(result.routeExecutionGate.blockedBy.includes("parallel_lane_safety_not_proven"));
});

test("explicit independent read-only paths can be planned concurrently without authorization", () => {
  const result = route("Run meta-theory. Inspect src/API.ts; review src/Client.ts. Two independent parallel lanes.");
  assert.equal(result.recommendedRoute.parallelExecutionLanes.length, 2);
  assert.equal(result.dispatchBoardDraft.fanoutReadiness.thinkingApproved, true);
  assert.equal(result.routeExecutionGate.executionAuthorized, false);
});

test("real selector rejects contracted negations and parallel feasibility questions", () => {
  for (const sentence of [
    "Don't run in parallel.",
    "Don’t run in parallel.",
    "These can't run in parallel.",
    "These can’t run in parallel.",
    "Don't assume these are independent tasks; they can't run in parallel.",
    "Can these run in parallel?",
    "Check whether these can run in parallel.",
    "能否并行执行？",
  ]) {
    const result = route(`Run meta-theory. Inspect src/A.ts; review src/B.ts. ${sentence}`);
    assert.ok(result.workerTaskPacketDrafts.length >= 2, sentence);
    assert.equal(result.dispatchBoardDraft.fanoutReadiness.thinkingApproved, false, sentence);
    assert.equal(result.routeExecutionGate.executionAuthorized, false, sentence);
    assert.ok(result.routeExecutionGate.blockedBy.includes("parallel_lane_safety_not_proven"), sentence);
    for (const draft of result.workerTaskPacketDrafts) {
      assert.equal(draft.safetyEvidence.status, "unproven", sentence);
      assert.equal(draft.dependencyEvidence, "unproven", sentence);
      assert.equal(JSON.parse(draft.codexSpawnBinding.message).coordination.collisionPolicy, "unproven", sentence);
    }
  }
});

test("create actions are never described as read-only in route drafts or native handoff", () => {
  for (const task of [
    "Run meta-theory. Inspect src/A.ts; create src/B.ts. Two independent parallel lanes.",
    "meta-theory。检查 src/A.ts；创建 src/B.ts。并行执行。",
  ]) {
    const result = route(task);
    const draft = result.workerTaskPacketDrafts.find((candidate) => candidate.shardScope.includes("src/B.ts"));
    assert.ok(draft, task);
    assert.equal(draft.mutationPolicy, "scoped_local_writes_only", task);
    assert.equal(draft.workspaceIsolation, "shared_workspace_disjoint_paths", task);
    const message = JSON.parse(draft.codexSpawnBinding.message);
    assert.equal(message.coordination.workspaceIsolation, "shared_workspace_disjoint_paths", task);
    assert.equal(result.routeExecutionGate.executionAuthorized, false, task);
  }
});

test("actual selector rejects lexical aliases as independent write scopes", () => {
  for (const alias of ["src/unused/../A.ts", "src//A.ts", "./src/A.ts"]) {
    const result = route(`Run meta-theory. Edit src/A.ts; update ${alias}. Two independent parallel lanes.`);
    assert.equal(result.workerTaskPacketDrafts.length, 2, alias);
    assert.ok(result.workerTaskPacketDrafts.some((draft) => draft.shardScope.includes(alias)), alias);
    assert.equal(result.dispatchBoardDraft.fanoutReadiness.thinkingApproved, false, alias);
    assert.ok(result.routeExecutionGate.blockedBy.includes("parallel_lane_safety_not_proven"), alias);
  }
});

test("actual selector cannot prove independence across unbound root forms", () => {
  for (const [left, right] of [
    ["src/A.ts", "C:/repo/src/A.ts"],
    ["/src/A.ts", "C:/src/A.ts"],
    ["src/A.ts", "//server/share/src/A.ts"],
    ["C:/src/A.ts", "//server/share/src/A.ts"],
  ]) {
    const result = route(`Run meta-theory. Edit ${left}; update ${right}. Two independent parallel lanes.`);
    assert.equal(result.workerTaskPacketDrafts.length, 2);
    assert.ok(result.workerTaskPacketDrafts.every((draft) => draft.shardScope.length === 1));
    assert.equal(result.dispatchBoardDraft.fanoutReadiness.thinkingApproved, false, `${left} vs ${right}`);
    assert.equal(result.dispatchBoardDraft.fanoutReadiness.shardScopesPairwiseDisjoint, false);
    assert.ok(result.routeExecutionGate.blockedBy.includes("parallel_lane_safety_not_proven"));
  }
});

test("actual selector retains same-root writes, shared reads and ordered mixed-root handoff", () => {
  for (const root of ["src", "C:/repo/src", "/src", "//server/share/src"]) {
    const result = route(`Run meta-theory. Edit ${root}/A.ts; update ${root}/B.ts. Two independent parallel lanes.`);
    assert.equal(result.dispatchBoardDraft.fanoutReadiness.thinkingApproved, true, root);
    assert.equal(result.routeExecutionGate.handoffStatus, "ready_for_host_handoff", root);
    assert.equal(result.routeExecutionGate.executionAuthorized, false);
  }
  const reads = route("Run meta-theory. Inspect src/A.ts; review C:/repo/src/A.ts. Two independent parallel lanes.");
  assert.equal(reads.dispatchBoardDraft.fanoutReadiness.thinkingApproved, true);
  assert.equal(reads.dispatchBoardDraft.fanoutReadiness.shardScopesPairwiseDisjoint, false);
  assert.equal(reads.routeExecutionGate.handoffStatus, "ready_for_host_handoff");
  assert.equal(reads.routeExecutionGate.executionAuthorized, false);
  const ordered = route("Run meta-theory. First edit /src/A.ts; then update C:/src/A.ts.");
  assert.equal(ordered.dispatchBoardDraft.fanoutReadiness.thinkingApproved, false);
  assert.equal(ordered.dispatchBoardDraft.orderedExecutionReadiness.ready, true);
  assert.equal(ordered.routeExecutionGate.handoffStatus, "ready_for_host_handoff");
  assert.deepEqual(ordered.workerTaskPacketDrafts[1].dependsOn, [ordered.workerTaskPacketDrafts[0].roleInstanceId]);
  assert.equal(ordered.routeExecutionGate.executionAuthorized, false);
});

test("single read-only action retains its actual file scope and purpose", () => {
  const task = "Run meta-theory: inspect package.json and produce a durable verification report of the exact package name and version. Do not modify files.";
  const result = route(task);
  assert.equal(result.workerTaskPacketDrafts.length, 1);
  const draft = result.workerTaskPacketDrafts[0];
  assert.deepEqual(draft.scopeFiles, ["package.json"]);
  assert.deepEqual(draft.shardScope, ["package.json"]);
  assert.equal(draft.mutationPolicy, "read_only");
  assert.equal(draft.safetyEvidence.status, "proven");
  assert.match(draft.purpose, /exact package name and version/);
  assert.equal(result.routeExecutionGate.executionAuthorized, false);
  const unknown = route("Run meta-theory: inspect package metadata and prepare a report.");
  assert.equal(unknown.workerTaskPacketDrafts[0].safetyEvidence.status, "unproven");
  const mutation = route("Run meta-theory: inspect package.json and modify its version.");
  assert.equal(mutation.workerTaskPacketDrafts[0].mutationPolicy, "scoped_local_writes_only");
});
