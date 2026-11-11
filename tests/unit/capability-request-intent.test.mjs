import assert from "node:assert/strict";
import test from "node:test";
import { durableCapabilityRequestsFromTask as parse } from "../../scripts/capability-request-intent.mjs";

test("explicit global reuse stays reuse across coordinated denied actions", () => {
  for (const type of ["agent", "skill", "command"]) {
    for (const task of [
      `请直接复用全局 ${type} acceptance-global-reuse-${type}，不需要迭代或修改，也不要复制到项目。`,
      `Please reuse ${type} saved-checks, no need to iterate or to modify it.`,
    ]) {
      const requests = parse(task);
      assert.equal(requests.length, 1, task);
      assert.equal(requests[0].requestedAction, "reuse", task);
      assert.equal(requests[0].mutationAuthorized, true, task);
    }
  }
});

test("a later explicit action binds its own target after a denied action", () => {
  for (const task of [
    "No need to iterate or modify skill alpha, then please create skill beta for checking local reports.",
    "Do not modify skill alpha. Please create skill beta for checking local reports.",
    "不要修改 skill alpha，然后请创建 skill beta，负责检查本地记录。",
    "不需要迭代或修改 skill alpha，然后请创建 skill beta，负责检查本地记录。",
  ]) {
    const requests = parse(task);
    assert.equal(requests.length, 1, task);
    assert.equal(requests[0].explicitCapabilityId, "beta", task);
    assert.equal(requests[0].requestedAction, "create", task);
    assert.equal(requests[0].mutationAuthorized, true, task);
  }
});

test("English sentence stops preserve dots inside explicit capability names", () => {
  const [request] = parse("Do not modify skill alpha.v1. Please create skill beta.v2 for checking local reports.");
  assert.equal(request?.explicitCapabilityId, "beta.v2");
  assert.equal(request?.mutationAuthorized, true);
  assert.equal(parse("Please create skill beta.v2.")[0]?.explicitCapabilityId, "beta.v2");
});

test("negated location-qualified creation never grants a durable write", () => {
  for (const task of [
    "不需要在项目创建 skill beta，负责审查本地记录。",
    "无需在当前项目创建 skill beta，用于检查记录。",
    "You don't need to create skill beta for checking local reports.",
    "Do not create the project skill beta for checking local reports.",
  ]) assert.deepEqual(parse(task), [], task);
});

test("approval requirements survive then and sentence boundaries", () => {
  for (const task of [
    "After approval, then please create skill beta for checking local reports.",
    "Before approval, please create skill beta for checking local reports.",
    "等我批准后，然后请创建 skill beta，负责检查本地记录。",
    "请创建 skill beta，用于检查本地记录。Awaiting Warden approval.",
    "Awaiting Warden approval. Please create skill beta for checking local reports.",
  ]) {
    const requests = parse(task);
    assert.ok(requests.some((request) => request.explicitCapabilityId === "beta"), task);
    assert.ok(requests.every((request) => request.mutationAuthorized === false), task);
  }
});

test("explicit names are distinct from actual approval conditions", () => {
  const [named] = parse("Do not modify skill alpha, then create skill named unless for checking local reports.");
  assert.equal(named?.explicitCapabilityId, "unless");
  assert.equal(named?.mutationAuthorized, true);
  const [conditional] = parse("Create skill named unless for checking local reports unless Warden approval is supplied.");
  assert.equal(conditional?.explicitCapabilityId, "unless");
  assert.equal(conditional?.mutationAuthorized, false);
});

test("unresolved pronouns cannot borrow the previously denied target", () => {
  for (const task of [
    "Do not modify skill alpha, then please create skill it for checking local reports.",
    "Do not modify skill alpha. Please create skill this for checking local reports.",
    "不要修改 skill alpha，然后请创建技能它，负责检查本地记录。",
  ]) {
    const requests = parse(task);
    assert.ok(requests.every((request) => request.explicitCapabilityId === null), task);
    assert.ok(requests.every((request) => request.mutationAuthorized === false), task);
  }
});

test("multiple targets without separately bound actions remain unresolved candidates", () => {
  for (const task of [
    "Please create skill alpha and skill beta for checking local reports.",
    "请创建 skill alpha 和 command beta，用于检查本地记录。",
  ]) {
    const requests = parse(task);
    assert.ok(requests.length > 0, task);
    assert.ok(requests.every((request) => request.explicitCapabilityId === null && request.mutationAuthorized === false), task);
  }
});

test("an explicit read-only task boundary applies across separated clauses", () => {
  for (const task of [
    "Read-only review. Please create skill beta for checking local reports.",
    "只读检查；请创建 skill beta，负责检查本地记录。",
  ]) assert.ok(parse(task).every((request) => request.mutationAuthorized === false), task);
});
