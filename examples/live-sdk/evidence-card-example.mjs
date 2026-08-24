import { defineEvidenceCard } from "meta-kim/live-sdk";

/**
 * An independent test evidence card. The callback returns only the public
 * body; the SDK supplies schema, identity and projection authority.
 */
export const card = defineEvidenceCard({
  id: "example-test-card",
  version: "1.0.0",
  type: "test",
  label: "Example tests",
  capabilities: ["project"],
  build(input) {
    const count = Number.isSafeInteger(input.testCount) ? input.testCount : 0;
    const passed = Number.isSafeInteger(input.passed) ? input.passed : 0;
    const complete = count > 0 && passed === count;
    return {
      status: complete ? "pass" : "in_doubt",
      summary: complete ? `${passed}/${count} focused tests passed.` : "Test evidence is incomplete.",
      refs: ["example:test-fixture"],
      observedAt: input.observedAt,
    };
  },
});
