import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("graphify idempotent wiring (contract)", () => {
  test("graphify-cli.mjs invokes hook install after claude install", () => {
    const src = readFileSync(
      path.join(root, "scripts/graphify-cli.mjs"),
      "utf8",
    );
    const claudeIdx = src.indexOf('["-m", "graphify", "claude", "install"]');
    const hookIdx = src.indexOf('["-m", "graphify", "hook", "install"]');
    assert.notEqual(claudeIdx, -1);
    assert.notEqual(hookIdx, -1);
    assert.ok(hookIdx > claudeIdx, "hook install must follow claude install");
  });

  test("setup.mjs installPythonTools wires graphify for all activeTargets", () => {
    const lines = readFileSync(path.join(root, "setup.mjs"), "utf8").split(
      /\r?\n/,
    );
    const start = lines.findIndex((l) =>
      l.includes("async function installPythonTools("),
    );
    const end = lines.findIndex(
      (l, i) => i > start && l.startsWith("// ── Step 4.6:"),
    );
    assert.ok(start !== -1 && end !== -1, "installPythonTools body not found");
    const body = lines.slice(start, end).join("\n");
    assert.match(body, /\["-m", "graphify", "hook", "install"\]/);
    assert.match(body, /for \(const target of activeTargets\)/);
    assert.match(
      body,
      /\["-m", "graphify", "[a-z]+", "install"\]/,
      "per-platform graphify install present",
    );
    // pip install failure must NOT return early (skill install still needs to run)
    const afterPip = body.split(/pip install.*graphifyy.*\]/s)[1] || "";
    assert.doesNotMatch(
      afterPip.slice(0, 120),
      /^\s*return;/m,
      "no early return right after already-installed ok()",
    );
  });

  test("install-global-skills-all-runtimes.mjs calls wiring when pip skip", () => {
    const src = readFileSync(
      path.join(root, "scripts/install-global-skills-all-runtimes.mjs"),
      "utf8",
    );
    const idx = src.indexOf("if (pipShow.status === 0)");
    assert.notEqual(idx, -1);
    const branch = src.slice(idx, idx + 600);
    assert.match(branch, /ensureGraphifyWiring\(\)/);
  });

  test("canonical subagent-context mentions GRAPH_REPORT.md", () => {
    const src = readFileSync(
      path.join(
        root,
        "canonical/runtime-assets/claude/hooks/subagent-context.mjs",
      ),
      "utf8",
    );
    assert.match(src, /GRAPH_REPORT\.md/);
  });
});
