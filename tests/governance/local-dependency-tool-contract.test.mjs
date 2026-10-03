import assert from "node:assert/strict";
import test from "node:test";
import * as policy from "../../scripts/governed-execution/local-dependency-tool-contract.mjs";

function assertImmutable(value) {
  if (!value || typeof value !== "object") return;
  assert(Object.isFrozen(value), "all policy containers must be frozen");
  for (const child of Object.values(value)) assertImmutable(child);
}

test("local-tool policy stays immutable across consumers, including nested executable argv", async () => {
  const { LOCAL_DEPENDENCY_TOOL_CONTRACT: contract } = policy;
  for (const value of Object.values(policy)) assertImmutable(value);
  const before = JSON.stringify(policy);
  assert.throws(() => { contract.componentVersion = "unreviewed"; }, TypeError);
  assert.throws(() => { contract.invocation.shell = true; }, TypeError);
  assert.throws(() => contract.invocation.argv.push("--autofix"), TypeError);
  assert.throws(() => contract.ruleIds.push("remote-rule"), TypeError);
  assert.throws(() => policy.LOCAL_DEPENDENCY_TOOL_OUTPUT_SHAPES.finding.push("matchedSecret"), TypeError);
  assert.throws(() => policy.LOCAL_DEPENDENCY_TOOL_OUTPUT_STATUSES.push("assumed_success"), TypeError);
  const secondConsumer = await import("../../scripts/governed-execution/local-dependency-tool-contract.mjs");
  assert.strictEqual(secondConsumer.LOCAL_DEPENDENCY_TOOL_CONTRACT, contract);
  assert.equal(JSON.stringify(policy), before);
});

test("business target selection is separate from the fixed shell-free local adapter policy", () => {
  const { LOCAL_DEPENDENCY_TOOL_CONTRACT: contract, LOCAL_DEPENDENCY_TOOL_INPUT_FIELDS: fields } = policy;
  assert.equal(contract.invocation.shell, false);
  assert(fields.includes("target") && fields.includes("workspaceRoot"));
  for (const forbidden of ["command", "executable", "argv", "shell", "configUrl", "credentials"]) {
    assert(!fields.includes(forbidden), `work-order input cannot supply ${forbidden}`);
  }
  assert(contract.invocation.argv.every((arg) => !/https?:|--autofix|--config|--login/u.test(arg)));
  assert.equal(Object.hasOwn(contract, "target"), false);
  assert.equal(Object.hasOwn(contract, "workspaceRoot"), false);
});
