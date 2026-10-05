import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateDeliveryEnvelope } from "../../scripts/governed-execution/dependency-calculation.mjs";

const tool = { id: "fixture-unit-conversion", toolVersion: "1.0.0" };
const task = "Convert the supplied measurements";
const seal = (value) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const receipt = { schemaVersion: 1, tool: tool.id, status: "completed", networkUsed: false,
    filesModified: false, measurements: [{ original: "100 cm", converted: "1 m" }] };
  return { schemaVersion: 1, status: "completed", tool: tool.id, toolVersion: tool.toolVersion,
    calculationPerformed: true, brief: { request: task }, missing: [], questions: [], issues: [],
    receipt, receiptJson: JSON.stringify(receipt), receiptSha256: seal(JSON.stringify(receipt)), delivery: "100 cm = 1 m",
    handoff: { status: "ready", code: null, questions: [] }, networkUsed: false, filesModified: false };
}

test("generic delivery accepts a non-industry fixture without framework-specific business fields", () => {
  assert.doesNotThrow(() => validateDeliveryEnvelope(fixture(), tool, task));
});

test("generic delivery rejects corrupted identity, evidence, safety claims and receipt transport", () => {
  for (const mutate of [
    (value) => { value.tool = "other"; },
    (value) => { value.toolVersion = "unreviewed"; },
    (value) => { value.brief.request = "different task"; },
    (value) => { value.networkUsed = true; },
    (value) => { value.filesModified = true; },
    (value) => { value.receipt.measurements[0].converted = "999 m"; },
    (value) => { value.receipt.networkUsed = true; value.receiptJson = JSON.stringify(value.receipt); value.receiptSha256 = seal(value.receiptJson); },
    (value) => { value.receipt = null; },
    (value) => { value.calculationPerformed = false; },
    (value) => { value.handoff.status = "execute_anything"; },
    (value) => { value.questions = "not an array"; },
  ]) {
    const value = fixture(); mutate(value);
    assert.throws(() => validateDeliveryEnvelope(value, tool, task));
  }
});

test("missing-material delivery does not claim a calculation or a ready handoff", () => {
  const value = { ...fixture(), status: "needs_input", calculationPerformed: false, receipt: null,
    receiptSha256: null, receiptJson: null, delivery: null, missing: ["measurements"], questions: ["Provide measurements"],
    handoff: { status: "needs_input", code: "missing_materials", questions: ["Provide measurements"] } };
  assert.doesNotThrow(() => validateDeliveryEnvelope(value, tool, task));
  value.handoff.status = "ready";
  assert.throws(() => validateDeliveryEnvelope(value, tool, task));
});

test("Meta execution and handoff have no industry-specific branches or report fields", () => {
  for (const filename of ["dependency-calculation.mjs", "dependency-calculation-handoff.mjs"]) {
    const source = readFileSync(new URL(`../../scripts/governed-execution/${filename}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /supplier-comparison|store-performance|paidOrdersPerVisitorPercent|normalizedQuotes|qualityDefinition|landedTotal|\bsku\b|采购数量|退款净收入|广告CAC/u);
  }
});
