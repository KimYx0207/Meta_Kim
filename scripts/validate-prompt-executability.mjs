#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { assert, listFiles, repoPath } from "./governance-lib.mjs";

const REQUIRED_REFERENCE_SECTIONS = [
  "Use when",
  "Required inputs",
  "Do",
  "Do not",
  "Required packet",
  "Pass",
  "Fail",
  "Block",
  "Return to stage",
  "Verification",
  "Writeback",
  "Preserve",
];

const REQUIRED_AGENT_SECTIONS = [
  "Owns",
  "Does not own",
  "Trigger",
  "Required inputs",
  "Allowed actions",
  "Forbidden actions",
  "Output packet",
  "Pass criteria",
  "Fail criteria",
  "Escalation",
  "Silence / skip",
  "Verification",
  "Evolution",
  "Preserve",
];

const REQUIRED_SKILL_TERMS = [
  "Purpose",
  "Trigger",
  "Path classification",
  "Stage packet table",
  "Required Fetch config",
  "Native ability preservation",
  "Foundational capability preservation",
  "Dependency compatibility",
  "Execution gate",
  "Review gate",
  "Verification gate",
  "Evolution gate",
  "Reference loading",
  "No fake owner",
  "No general-purpose fallback",
  "No public-ready without userGoalDone",
  "No deletion of foundational capabilities",
  "No removal of runtime native abilities",
  "No dependency deletion due to low score",
  "No Hook loop",
  "Real testing and warning classification",
];

function lineCount(text) {
  return text.split(/\r?\n/).length;
}

function hasSection(text, name) {
  return new RegExp(`^#{1,3}\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "im").test(text);
}

const skillPath = repoPath("canonical/skills/meta-theory/SKILL.md");
const skillText = await fs.readFile(skillPath, "utf8");
assert(lineCount(skillText) <= 600 || /justified exception/i.test(skillText), "SKILL.md exceeds 600 lines without justified exception");
for (const term of REQUIRED_SKILL_TERMS) {
  assert(skillText.includes(term), `SKILL.md missing dispatcher term: ${term}`);
}
for (const term of ["web", "browser", "research", "shell", "filesystem", "apply_patch", "MCP", "memory", "graph", "hook"]) {
  assert(new RegExp(term, "i").test(skillText), `SKILL.md missing foundational preserve term ${term}`);
}

const referenceFiles = await listFiles(repoPath("canonical/skills/meta-theory/references"), (file) => file.endsWith(".md"));
for (const file of referenceFiles) {
  const text = await fs.readFile(file, "utf8");
  const rel = path.relative(repoPath("."), file).replace(/\\/g, "/");
  for (const section of REQUIRED_REFERENCE_SECTIONS) assert(hasSection(text, section), `${rel} missing ${section}`);
  assert(/owner|action|output/i.test(text), `${rel} missing owner/action/output instruction`);
  assert(/pass|fail|block/i.test(text), `${rel} missing pass/fail/block instruction`);
}

const agentFiles = await listFiles(repoPath("canonical/agents"), (file) => /^meta-.*\.md$/.test(path.basename(file)));
for (const file of agentFiles) {
  const text = await fs.readFile(file, "utf8");
  const rel = path.relative(repoPath("."), file).replace(/\\/g, "/");
  for (const section of REQUIRED_AGENT_SECTIONS) assert(hasSection(text, section), `${rel} missing ${section}`);
  assert(!/subagent_type:\s*general-purpose/i.test(text), `${rel} must not advertise general-purpose execution fallback`);
  assert(/does not own|forbidden actions/i.test(text), `${rel} missing boundary denial`);
  assert(/not.*implementation worker|not.*code executor|不得.*implementation|不得.*代码实现/i.test(text), `${rel} must block governance agent implementation work`);
}

const vaguePatterns = [
  /优秀的?专家/,
  /尽量完善/,
  /注意质量/,
  /看起来合理/,
  /do your best/i,
];
for (const file of [skillPath, ...referenceFiles, ...agentFiles]) {
  const text = await fs.readFile(file, "utf8");
  for (const pattern of vaguePatterns) {
    assert(!pattern.test(text), `${path.relative(repoPath("."), file)} contains vague phrase ${pattern}`);
  }
}

console.log("prompt executability valid");
