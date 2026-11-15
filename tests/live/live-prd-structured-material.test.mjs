import test from "node:test";
import assert from "node:assert/strict";
import { workspaceStructuredPrdMaterial, serializeLiveWorkspaceModel } from "../../src/presentation/live/live-workspace-model.mjs";

const overview = { kind: "outline", id: "system", artifactId: "prd:system" };
const module = { kind: "module", id: "orders", artifactId: "prd:orders" };
const read = (value, changes = {}) => ({ verified: true, loading: false, nextCursor: null, text: JSON.stringify(value), ...changes });

test("PRD level one projects the current architecture without changing the source", () => {
  const source = { architecture: { id: "system", summary: "Order platform", moduleIds: ["orders"] }, modules: [{ id: "orders", purpose: "Track orders" }] };
  assert.deepEqual(workspaceStructuredPrdMaterial(overview, read(source)), { kind: "outline", architecture: source.architecture, modules: source.modules });
  assert.equal(source.architecture.moduleIds[0], "orders");
});

test("PRD level two can surface actual module rules, states and acceptance references", () => {
  const source = { id: "orders", purpose: "Track orders", businessRules: ["Only owner can cancel"],
    states: [{ name: "empty", behavior: "Show first action" }], taskIds: ["task:create-order"], acceptanceCriterionIds: ["criterion:orders"] };
  assert.deepEqual(workspaceStructuredPrdMaterial(module, read(source)), { kind: "module", module: source });
});

test("partial, unverified, mismatched and non-JSON materials never become structured facts", () => {
  assert.equal(workspaceStructuredPrdMaterial(module, read({ id: "orders" }, { nextCursor: "more" })), null);
  assert.equal(workspaceStructuredPrdMaterial(module, read({ id: "orders" }, { verified: false })), null);
  assert.equal(workspaceStructuredPrdMaterial(module, read({ id: "orders" }, { conflict: true })), null);
  assert.equal(workspaceStructuredPrdMaterial(module, read({ id: "other" })), null);
  assert.equal(workspaceStructuredPrdMaterial(overview, read({ architecture: { id: "other" } })), null);
  assert.equal(workspaceStructuredPrdMaterial(module, read({}, { text: "# Human-written PRD" })), null);
});

test("browser serialization includes the same structured PRD reader", () => {
  assert.match(serializeLiveWorkspaceModel(), /function workspaceStructuredPrdMaterial/);
});
