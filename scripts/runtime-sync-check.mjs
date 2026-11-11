import { ENTRY_CLASSIFIER_HOOK_FILES } from "./runtime-hook-mapping.mjs";
export const META_AGENTS = [
  "meta-artisan",
  "meta-chrysalis",
  "meta-conductor",
  "meta-genesis",
  "meta-librarian",
  "meta-prism",
  "meta-scout",
  "meta-sentinel",
  "meta-warden",
];

// Meta_Kim projects only nine governance agents into Codex. Execution-layer
// labels such as frontend/backend/test remain run-scoped packet labels; they
// are not generated as durable `.codex/agents/*.toml` files.
export const CODEX_RUNTIME_ADAPTER_AGENT_IDS = [];

export const CODEX_BUSINESS_ROLE_AGENT_IDS = [];

export const OPENCLAW_WORKSPACE_MD = [
  "BOOT.md",
  "BOOTSTRAP.md",
  "IDENTITY.md",
  "MEMORY.md",
  "USER.md",
  "SOUL.md",
  "AGENTS.md",
  "HEARTBEAT.md",
  "TOOLS.md",
];

export const SHARED_HOOK_FILES = [
  ...ENTRY_CLASSIFIER_HOOK_FILES,
  "skip-reminder.mjs",
  "activate-meta-theory-spine.mjs",
  "bash-readonly-whitelist.mjs",
  "enforce-agent-dispatch.mjs",
  "graphify-context.mjs",
  "post-format.mjs",
  "post-typecheck.mjs",
  "post-console-log-warn.mjs",
  "subagent-context.mjs",
  "stop-compaction.mjs",
  "stop-console-log-audit.mjs",
  "stop-completion-guard.mjs",
  "stop-spine-cleanup.mjs",
];

// Legacy export alias for backwards compatibility
export const CLAUDE_HOOK_FILES = SHARED_HOOK_FILES;

export function expectedAgentProjectionFiles(
  extension,
  agentIds = META_AGENTS,
) {
  return agentIds.map((id) => `${id}${extension}`);
}

export function summarizeExpectedFiles(existingFiles, expectedFiles) {
  const existing = new Set(existingFiles);
  const expected = [...expectedFiles];
  const present = expected.filter((file) => existing.has(file));
  const missing = expected.filter((file) => !existing.has(file));
  const extra = existingFiles.filter((file) => !expected.includes(file));

  return {
    present,
    missing,
    extra,
    presentCount: present.length,
  };
}
