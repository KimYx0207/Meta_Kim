import assert from "node:assert/strict";
import test from "node:test";
import { selectRuntimeAgentEvidence } from "../../scripts/runtime-agent-evidence.mjs";

test("bounded evidence retains a selected late owner and same-name identities from different runtimes", () => {
  const agents = [
    ...Array.from({ length: 8 }, (_, index) => ({ id: `early-${index}`, runtime: "first" })),
    { id: "shared", runtime: "second", sourceRef: "second/shared" },
    { id: "shared", runtime: "third", sourceRef: "third/shared" },
    { id: "late-owner", runtime: "third", sourceRef: "third/late" },
  ];
  const actual = selectRuntimeAgentEvidence(agents, 5, new Set(["late-owner", "not-discovered"]));
  assert.equal(actual.length, 5);
  assert.ok(actual.includes(agents.at(-1)), "a selected owner beyond the original slice survives");
  assert.deepEqual(actual.filter((agent) => agent.id === "shared").map((agent) => agent.runtime), ["second", "third"]);
  assert.deepEqual([...new Set(actual.map((agent) => agent.runtime))], ["first", "second", "third"]);
  assert.ok(actual.every((agent) => agents.includes(agent)), "publication only retains discovered records");
  assert.equal(agents.length, 11, "selection does not mutate the discovery inventory");
});

test("evidence preserves small inventories and prioritizes selected owners when the budget cannot cover every runtime", () => {
  const agents = [{ id: "first", runtime: "one" }, { id: "last", runtime: "two" }];
  assert.deepEqual(selectRuntimeAgentEvidence(agents, 30), agents);
  assert.deepEqual(selectRuntimeAgentEvidence(agents, 1, new Set(["last"])), [agents[1]]);
  assert.deepEqual(selectRuntimeAgentEvidence(agents, 0), []);
  assert.deepEqual(selectRuntimeAgentEvidence([], 30), []);
});

test("same selected names across six runtimes cannot consume the budget before the last runtime", () => {
  const runtimes = ["claude_code", "codex", "cursor", "gemini", "zcode", "openclaw"];
  const ids = ["analysis", "frontend", "backend", "test", "review", "docs"];
  const agents = runtimes.flatMap(runtime => ids.map(id => ({ id, runtime, sourceRef: `${runtime}/${id}` })));
  const actual = selectRuntimeAgentEvidence(agents, 30, new Set(ids));
  assert.equal(actual.length, 30);
  assert.deepEqual(Object.fromEntries(runtimes.map(runtime => [runtime, actual.filter(agent => agent.runtime === runtime).length])),
    Object.fromEntries(runtimes.map(runtime => [runtime, 5])));
  assert.deepEqual(actual.map(agent => agents.indexOf(agent)), actual.map(agent => agents.indexOf(agent)).sort((a, b) => a - b));
});

test("when runtimes exceed the budget only selected groups get priority and selection terminates", () => {
  const agents = [
    { id: "ordinary", runtime: "first" },
    { id: "ordinary", runtime: "second" },
    { id: "selected", runtime: "third" },
    { id: "ordinary", runtime: "fourth" },
    { id: "selected", runtime: "fifth" },
  ];
  assert.deepEqual(selectRuntimeAgentEvidence(agents, 2, new Set(["selected"])), [agents[2], agents[4]]);
  assert.deepEqual(selectRuntimeAgentEvidence(agents, 1, new Set(["selected"])), [agents[2]]);
});
