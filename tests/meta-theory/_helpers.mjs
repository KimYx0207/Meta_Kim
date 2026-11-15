import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const SKILL_PATH = path.join(REPO_ROOT, "canonical", "skills", "meta-theory", "SKILL.md");
export const REFERENCE_DIR = path.join(REPO_ROOT, "canonical", "skills", "meta-theory", "references");
export const AGENTS_DIR = path.join(REPO_ROOT, "canonical", "agents");
export const CONTRACTS_DIR = path.join(REPO_ROOT, "contracts");

export const ALL_TYPES = ["A", "B", "C", "D", "E"];

export const ALL_AGENTS = [
  "meta-warden",
  "meta-conductor",
  "meta-genesis",
  "meta-artisan",
  "meta-sentinel",
  "meta-librarian",
  "meta-prism",
  "meta-scout",
  "meta-chrysalis",
];

export const CLARITY_DIMENSIONS = ["Scope", "Goal", "Constraints", "Architecture type"];

export const FIVE_CRITERIA = [
  "Independent",
  "Small Enough",
  "Clear Boundaries",
  "Replaceable",
  "Reusable",
];

export const FOUR_DEATH_PATTERNS = [
  "Stew-All",
  "Shattered",
  "Governance-Free Execution",
  "Result-Chasing Without Structure",
];

export const EIGHT_STAGES = [
  "Critical",
  "Fetch",
  "Thinking",
  "Execution",
  "Review",
  "Meta-Review",
  "Verification",
  "Evolution",
];

export const EMPTY_ADJECTIVES = [
  "advanced",
  "intelligent",
  "powerful",
  "seamless",
  "elegant",
  "revolutionary",
  "excellent",
  "innovative",
  "perfect",
  "outstanding",
];

export const QUALITY_GRADES = ["S", "A", "B", "C", "D"];

export const SCAR_TYPES = ["overstep", "boundary-violation", "process-gap", "false-positive"];
export const SCAR_IMPACT_LEVELS = ["none", "degraded", "recovered", "critical"];

export const REFERENCE_FILES = [
  "meta-theory.md",
  "dev-governance.md",
  "path-selection.md",
  "spine-state.md",
  "runtime-claude.md",
  "runtime-codex.md",
  "owner-resolution.md",
  "verification-evidence.md",
  "planning-files.md",
  "evolution-writeback.md",
  "rhythm-orchestration.md",
  "intent-amplification.md",
  "cross-agent-thinking-patterns.md",
  // Legacy file name kept as a compatibility alias for the 11-phase workflow reference.
  "ten-step-governance.md",
  "create-agent.md",
];

/** Canonical English labels (aligned with references/rhythm-orchestration.md). */
export const TEN_CARD_TYPES = [
  "Clarify",
  "Shrink scope",
  "Options",
  "Execute",
  "Verify",
  "Fix",
  "Rollback",
  "Risk",
  "Nudge",
  "Pause",
];

export const DELIVERY_SHELL_DIMENSIONS = [
  "audience",
  "touchpoint",
  "contextDensity",
  "attentionBudget",
];

/**
 * Replicates the frontmatter parser from validate-project.mjs.
 * Splits YAML frontmatter between --- delimiters into a key-value object.
 */
export function parseFrontmatter(raw, filePath = "<unknown>") {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`${filePath} is missing YAML frontmatter.`);
  }

  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      throw new Error(`${filePath} has an invalid frontmatter line: ${line}`);
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    data[key] = value.replace(/^['"]|['"]$/g, "");
  }

  return data;
}

export async function readFile(relativePath) {
  const fullPath = path.join(REPO_ROOT, relativePath);
  return fs.readFile(fullPath, "utf-8");
}

export async function readJson(relativePath) {
  const raw = await readFile(relativePath);
  return JSON.parse(raw);
}

/** Canonical skill + references — use for assertions whose content lives across files. */
export async function loadMetaTheoryCorpus() {
  const skill = await readFile("canonical/skills/meta-theory/SKILL.md");
  const references = {};
  for (const file of REFERENCE_FILES) {
    references[file] = await readFile(`canonical/skills/meta-theory/references/${file}`);
  }
  const devGov = references["dev-governance.md"];
  const metaTheory = references["meta-theory.md"];
  const createAgent = references["create-agent.md"];
  const combined = [skill, ...REFERENCE_FILES.map((file) => references[file])].join("\n");
  return { skill, devGov, metaTheory, createAgent, references, combined };
}

export async function fileExists(relativePath) {
  try {
    await fs.access(path.join(REPO_ROOT, relativePath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract markdown content under a heading (## or ###) up to the next heading
 * of equal or higher level.
 */
export function extractSection(markdown, heading) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `(^#{1,3})\\s+${escapedHeading}[\\s\\S]*?\\n([\\s\\S]*?)(?=\\n\\1\\s|$)`,
    "m"
  );
  const match = markdown.match(regex);
  return match ? match[2].trim() : null;
}

/**
 * Count occurrences of words from a list within a text block.
 * Used for AI-Slop density calculation.
 */
export function countWordOccurrences(text, wordList) {
  const lower = text.toLowerCase();
  let count = 0;
  for (const word of wordList) {
    const regex = new RegExp(`\\b${word}\\b`, "gi");
    const matches = lower.match(regex);
    if (matches) count += matches.length;
  }
  return count;
}
