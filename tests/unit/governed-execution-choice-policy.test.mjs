import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  evaluateChoiceRequirement,
  resolveNativeChoiceSurface,
} from "../../scripts/governed-execution/choice-policy.mjs";

const policy = JSON.parse(
  await readFile(new URL("../../config/governance/choice-surface-policy.json", import.meta.url), "utf8"),
);

test("runtime native choice surface comes from the canonical policy", () => {
  assert.equal(resolveNativeChoiceSurface(policy, "codex").surface, "request_user_input");
  assert.equal(resolveNativeChoiceSurface(policy, "claude_code").surface, "AskUserQuestion");
  assert.equal(resolveNativeChoiceSurface(policy, "claude").surface, "AskUserQuestion");
});
test("material branches are evaluated against policy dimensions", () => {
  const result = evaluateChoiceRequirement(policy, {
    runtime: "codex",
    stage: "Thinking",
    routeChangingDimensions: ["owner", "dependency", "acceptance"],
    materialBranch: true,
    decisionCardOptionCount: 3,
  });
  assert.equal(result.required, true);
  assert.equal(result.choicePolicy, "must_ask");
  assert.deepEqual(result.matchedPolicyDimensions, ["dependency", "acceptance"]);
  assert.equal(result.nativeSurface.surface, "request_user_input");
});

test("high-risk destructive or production execution always requires a native choice", () => {
  for (const facts of [
    { highRiskOperation: true },
    { destructiveOrProductionOperation: true },
  ]) {
    const result = evaluateChoiceRequirement(policy, {
      runtime: "claude_code",
      stage: "Critical",
      routeChangingDimensions: ["risk_or_permission"],
      ...facts,
    });
    assert.equal(result.required, true);
    assert.equal(result.reason, "high_risk_or_destructive_operation");
    assert.equal(result.nativeSurface.surface, "AskUserQuestion");
  }
});

test("a dimension hint without a material branch does not create filler questions", () => {
  const result = evaluateChoiceRequirement(policy, {
    runtime: "codex",
    stage: "Critical",
    routeChangingDimensions: ["scope"],
  });
  assert.equal(result.required, false);
  assert.equal(result.choicePolicy, "no_choice_needed");
});


test("internal owner and loadout alternatives cannot manufacture a user decision", () => {
  for (const routeChangingDimensions of [["owner"], ["verification owner"], ["model", "provider", "loadout"]]) {
    // Even an old policy's prose cannot revive an internal-only question.
    const stalePolicy = { ...policy, choiceRequiredWhen: [...policy.choiceRequiredWhen, "choice changes owner or verification owner"] };
    const result = evaluateChoiceRequirement(stalePolicy, { runtime: "codex", stage: "Thinking",
      routeChangingDimensions, materialBranch: true, decisionCardOptionCount: 2 });
    assert.equal(result.required, false);
    assert.deepEqual(result.matchedPolicyDimensions, []);
  }
  const material = evaluateChoiceRequirement(policy, { runtime: "codex", stage: "Thinking",
    routeChangingDimensions: ["owner", "risk_or_cost"], materialBranch: true, decisionCardOptionCount: 2 });
  assert.equal(material.required, true);
  assert.deepEqual(material.matchedPolicyDimensions, ["risk_or_cost"]);
});
