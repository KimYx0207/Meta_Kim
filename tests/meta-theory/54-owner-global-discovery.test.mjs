import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const SKILL_FILE = "canonical/skills/meta-theory/SKILL.md";
const DEV_GOVERNANCE_FILE = "canonical/skills/meta-theory/references/dev-governance.md";

describe("54 — Owner Global-First Discovery (meta-theory SKILL.md)", () => {
  test("SKILL.md exists at canonical path", () => {
    assert.ok(existsSync(SKILL_FILE), `${SKILL_FILE} must exist`);
  });

  test("SKILL.md contains the 'Global-First Owner Discovery' section header", () => {
    const src = readFileSync(SKILL_FILE, "utf8");
    assert.match(
      src,
      /^##\s+Global-First Owner Discovery\s*$/m,
      "SKILL.md must contain a level-2 section titled 'Global-First Owner Discovery'"
    );
  });

  test("SKILL.md lists at least 6 global owner discovery sources", () => {
    const src = readFileSync(SKILL_FILE, "utf8");
    const markers = [
      "canonical/agents/",
      "config/capability-index/",
      "~/.claude/agents/",
      "package.json",
      ".mcp.json",
      "meta-scout",
    ];
    for (const marker of markers) {
      assert.ok(
        src.includes(marker),
        `Global-First Owner Discovery must reference ${marker}`
      );
    }
  });

  test("SKILL.md states capability-first rather than agent-name-first", () => {
    const src = readFileSync(SKILL_FILE, "utf8");
    assert.match(
      src,
      /capability[-\s]first|capability.*not.*agent[-\s]name/i,
      "SKILL.md must state that discovery is capability-first, not agent-name-first"
    );
  });

  test("SKILL.md references dev-governance.md and the single machine parallelism contract", () => {
    const src = readFileSync(SKILL_FILE, "utf8");
    assert.match(
      src,
      /dev-governance\.md/,
      "SKILL.md must reference dev-governance.md"
    );
    assert.match(src, /core-loop-contract\.json/);
    assert.match(src, /stage-internal parallel policy|Inside each stage/iu);
  });

  test("discovery guidance uses the machine scan policy without requiring every source or a fixed wave", () => {
    const src = readFileSync(SKILL_FILE, "utf8");
    const reference = readFileSync("canonical/skills/meta-theory/references/global-owner-discovery.md", "utf8");
    assert.match(src, /Fetch discovery minimum checklist:[\s\S]*?source catalog[\s\S]*?stop-on-match/iu);
    assert.match(reference, /core-loop-contract\.json/iu);
    assert.match(reference, /cached[\s\S]*?project-light[\s\S]*?stop-on-match/iu);
    assert.match(reference, /fullScanTriggers/u);
    assert.doesNotMatch(reference, /before any Wave 1|every one of the six sources|each of the six sources with checked-at|complete the six-source scan/iu);
  });
});

describe("54b — Owner Global-First Discovery (dev-governance.md cross-link)", () => {
  test("dev-governance.md exists at canonical path", () => {
    assert.ok(existsSync(DEV_GOVERNANCE_FILE), `${DEV_GOVERNANCE_FILE} must exist`);
  });

  test("dev-governance.md mentions global discovery sources or cross-links SKILL.md", () => {
    const src = readFileSync(DEV_GOVERNANCE_FILE, "utf8");
    const linked =
      src.includes("Global-First Owner Discovery") ||
      src.includes("canonical/agents/") ||
      src.includes("capabilityDiscovery");
    assert.ok(linked, "dev-governance.md must reference global discovery / capability sources");
  });
});
