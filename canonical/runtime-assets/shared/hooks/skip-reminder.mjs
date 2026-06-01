#!/usr/bin/env node
/**
 * Skip Reminder Module for Meta_Kim Hooks
 *
 * Provides consistent reminder formatting when hooks are skipped in simple mode.
 * Records skipped hooks to spine state for audit trail.
 *
 * Usage:
 *   import { remindSkipped, recordSkip } from "./skip-reminder.mjs";
 *   remindSkipped("post-format", "Simple mode active", "Potential code style issues");
 */

import process from "node:process";
import { t } from "./hook-i18n.mjs";

/**
 * Skip decision constants (PRIN-ST: explicit over implicit)
 */
export const SKIP_DECISION = {
  SKIP: "Skip",
  CHECK: "Check",
  KEEP: "Keep",
};

/**
 * Simple keywords that indicate a simple/query task
 * Used for auto-detection when skip mode is not explicitly set
 * PRIN-ST: word boundaries via regex to reduce false positives
 */
export const SIMPLE_KEYWORDS = [
  "\\bcheck\\b",
  "\\bwhat is\\b",
  "\\bexplain\\b",
  "\\bshow\\b",
  "\\blist\\b",
  "\\bread\\b",
  "\\bfind\\b",
  "\\bsearch\\b",
  "\\bvalidate\\b",
  "\\bquick\\b",
  "\\bsimple\\b",
  "\\bjust check\\b",
  "\\bonly read\\b",
];

/**
 * Governance flow to skip rules mapping (PRIN-ST: configuration over hardcoding)
 * Each hook type defines whether it should Check, Skip, or Keep for each governance flow
 */
export const GOVERNANCE_SKIP_RULES = {
  enforce_agent_dispatch: {
    query: SKIP_DECISION.SKIP,
    simple_exec: SKIP_DECISION.CHECK,
    complex_dev: SKIP_DECISION.CHECK,
  },
  post_format: {
    query: SKIP_DECISION.SKIP,
    simple_exec: SKIP_DECISION.SKIP,
    complex_dev: SKIP_DECISION.CHECK,
  },
  post_typecheck: {
    query: SKIP_DECISION.SKIP,
    simple_exec: SKIP_DECISION.SKIP,
    complex_dev: SKIP_DECISION.CHECK,
  },
  stop_hooks: {
    query: SKIP_DECISION.SKIP,
    simple_exec: SKIP_DECISION.KEEP,
    complex_dev: SKIP_DECISION.CHECK,
  },
};

/**
 * Get skip decision for a hook based on governance flow
 * @param {string} hookName - Name of the hook
 * @param {string} governanceFlow - Current governance flow from task classification
 * @returns {string} - "Skip", "Check", or "Keep"
 */
export function getSkipRule(hookName, governanceFlow) {
  const hookKey = hookName.replace(/^[-.]/, "").replace(/\.mjs$/, "").toLowerCase();

  // Map common hook names to rule keys
  const ruleMap = {
    "enforce-agent-dispatch": "enforce_agent_dispatch",
    "enforce_agent_dispatch": "enforce_agent_dispatch",
    "post-format": "post_format",
    "post_format": "post_format",
    "post-typecheck": "post_typecheck",
    "post_typecheck": "post_typecheck",
    "stop-console-log-audit": "stop_hooks",
    "stop-save-progress": "stop_hooks",
    "stop-memory-save": "stop_hooks",
    "stop-compaction": "stop_hooks",
    "stop-spine-cleanup": "stop_hooks",
  };

  const ruleKey = ruleMap[hookKey] || hookKey;

  // Default to Check if no specific rule exists
  const rules = GOVERNANCE_SKIP_RULES[ruleKey];
  if (!rules) return SKIP_DECISION.CHECK;

  // Default to simple_exec if governance flow not specified
  const flow = governanceFlow || "simple_exec";

  return rules[flow] || SKIP_DECISION.CHECK;
}

/**
 * Check if prompt contains simple/task keywords
 * @param {string} prompt - User prompt to analyze
 * @returns {boolean} - True if prompt suggests simple task
 */
export function hasSimpleKeyword(prompt) {
  if (!prompt || typeof prompt !== "string") return false;
  const lowerPrompt = prompt.toLowerCase();
  // Use regex for word boundary matching (PRIN-ST: precision over false positives)
  return SIMPLE_KEYWORDS.some((keyword) => {
    try {
      const regex = new RegExp(keyword, "i");
      return regex.test(lowerPrompt);
    } catch {
      // Fallback to simple includes if regex fails
      return lowerPrompt.includes(keyword.replace(/\\b/g, ""));
    }
  });
}

/**
 * Output skip reminder to stderr (visible to user but doesn't interfere with hook output)
 * @param {string} hookName - Name of the hook being skipped
 * @param {string} reason - Why the hook is being skipped
 * @param {string} impact - Potential risk/consequence of skipping
 */
export function remindSkipped(hookName, reason, impact = "") {
  const lines = [
    `\x1b[33m${t.hookSkipTitle}\x1b[0m`, // yellow
    `  ${t.hookLabel} ${hookName}`,
    `  ${t.reasonLabel} ${reason}`,
  ];

  if (impact) {
    lines.push(`  ${t.impactLabel} ${impact}`);
  }

  lines.push(`  ${t.restoreLabel} ${t.restoreInstructions}`, "");

  // Write to stderr to not interfere with JSON output on stdout
  process.stderr.write(lines.join("\n") + "\n");
}

/**
 * Create a skip record for spine state
 * @param {string} hookName - Name of the hook being skipped
 * @param {string} reason - Why the hook is being skipped
 * @returns {object} - Skip record object
 */
export function createSkipRecord(hookName, reason) {
  return {
    hook: hookName,
    reason,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Output reminder and create record (combined helper)
 * @param {string} hookName - Name of the hook being skipped
 * @param {string} reason - Why the hook is being skipped
 * @param {string} impact - Potential risk/consequence
 * @returns {object} - Skip record for spine state
 */
export function recordSkip(hookName, reason, impact = "") {
  remindSkipped(hookName, reason, impact);
  return createSkipRecord(hookName, reason);
}

/**
 * Get skip reason based on source
 * @param {string} source - Source of skip decision ("env_var", "keyword", "governance_flow")
 * @param {string} detail - Additional detail (e.g., specific governance flow)
 * @returns {string} - Human-readable reason
 */
export function formatSkipReason(source, detail = "") {
  const reasons = {
    env_var: t.skipReasonEnvVar,
    keyword: t.skipReasonKeyword,
    governance_flow: t.skipReasonGovernanceFlow(detail),
  };

  return reasons[source] || t.skipReasonUnknown(source);
}

/**
 * Get impact description for a hook
 * @param {string} hookName - Name of the hook
 * @returns {string} - Potential impact description
 */
export function getHookImpact(hookName) {
  const impacts = {
    "enforce-agent-dispatch": t.impactEnforceAgentDispatch,
    "post-format": t.impactPostFormat,
    "post-typecheck": t.impactPostTypecheck,
    "stop-console-log-audit": t.impactStopConsoleLogAudit,
    "stop-save-progress": t.impactStopSaveProgress,
    "stop-memory-save": t.impactStopMemorySave,
  };

  return impacts[hookName] || t.impactGeneric;
}
