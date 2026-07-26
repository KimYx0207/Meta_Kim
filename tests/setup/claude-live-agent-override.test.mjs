import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import {
  buildClaudeSettingsIsolatedAgentOverride,
  parseClaudeAgentFrontmatter,
  redactClaudeLiveCommandText,
} from "../../scripts/claude-live-agent-override.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const metaPrismSource = readFileSync(
  path.join(repoRoot, "canonical", "agents", "meta-prism.md"),
  "utf8",
);

describe("Claude settings-isolated runtime agent override", () => {
  test("extracts the installed definition fields needed for a bounded inline agent", () => {
    const fields = parseClaudeAgentFrontmatter(metaPrismSource);
    assert.equal(fields.name, "meta-prism");
    assert.match(fields.own, /Quality forensics/u);
    assert.match(fields.do_not_touch, /Tool discovery/u);

    const override = buildClaudeSettingsIsolatedAgentOverride(metaPrismSource, "meta-prism");
    assert.deepEqual(Object.keys(override), ["meta-prism"]);
    assert.match(override["meta-prism"].prompt, /Do not perform business implementation or execution work/u);
    assert.match(override["meta-prism"].prompt, /Quality forensics/u);
    assert.match(override["meta-prism"].prompt, /Tool discovery/u);
    assert.ok(override["meta-prism"].prompt.length < 8_000);
  });

  test("rejects name substitution and incomplete runtime definitions", () => {
    assert.throws(
      () => buildClaudeSettingsIsolatedAgentOverride(metaPrismSource, "meta-scout"),
      /name mismatch/u,
    );
    assert.throws(
      () => buildClaudeSettingsIsolatedAgentOverride("---\nname: meta-prism\n---\n", "meta-prism"),
      /missing description, own, do_not_touch, or boundary/u,
    );
  });

  test("redacts inline definition, schema, and prompt from failed command text", () => {
    const sensitiveValues = [
      '{"meta-prism":{"prompt":"private boundary"}}',
      '{"type":"object"}',
      "private live prompt",
    ];
    const redacted = redactClaudeLiveCommandText(
      `failure ${sensitiveValues.join(" ")} ${sensitiveValues[0]}`,
      sensitiveValues,
    );
    for (const sensitiveValue of sensitiveValues) {
      assert.doesNotMatch(redacted, new RegExp(sensitiveValue.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"), "u"));
    }
    assert.equal(
      redacted.match(/<redacted-claude-live-input>/gu)?.length,
      4,
    );
  });
});
