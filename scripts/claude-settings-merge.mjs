/**
 * Shared Claude Code settings.json merge helpers.
 * Project sync (repo .claude/) and global sync (~/.claude/) must merge, never blind overwrite.
 */

import path from "node:path";

// ── Global ~/.claude/hooks/meta-kim/ (sync-global-meta-theory) ──────────

/**
 * Normalize a hook command string so single- and double-backslash forms
 * compare identically. Older versions of `hookCommandNode` produced
 * double-JSON-escaped Windows paths (e.g. `C:\\\\Users\\\\...` on disk,
 * `C:\\Users\\...` after parse), which the original single-backslash
 * matchers missed. Callers should compare against the normalized form.
 */
function normalizeHookCommand(command) {
  if (typeof command !== "string") return "";
  return command.replace(/\\\\/g, "\\");
}

export function isGlobalMetaKimManagedHookCommand(command) {
  if (typeof command !== "string") {
    return false;
  }
  const norm = normalizeHookCommand(command).replace(/\\/g, "/");
  if (norm.includes("hooks/meta-kim/")) {
    return true;
  }
  if (norm.includes("/hooks/hookprompt-adapter.mjs")) {
    return true;
  }
  return false;
}

export function isRawHookPromptUserPromptSubmitCommand(command) {
  if (typeof command !== "string") {
    return false;
  }
  const norm = normalizeHookCommand(command).replace(/\\/g, "/");
  return (
    norm.includes("/hooks/user-prompt-submit.js") ||
    norm.includes("/skills/hookprompt/.claude/hooks/user-prompt-submit.js") ||
    norm.includes("/skills/hookprompt/.codex/hooks/user-prompt-submit.js")
  );
}

const RETIRED_META_KIM_HOOK_FILES = new Set(["pre-git-push-confirm.mjs"]);

export function isRetiredMetaKimHookCommand(command) {
  if (typeof command !== "string") {
    return false;
  }
  const norm = normalizeHookCommand(command).replace(/\\/g, "/");
  return [...RETIRED_META_KIM_HOOK_FILES].some(
    (file) => norm.endsWith(file) || norm.includes(`/hooks/${file}`),
  );
}

/**
 * Render a `node <path>` hook command.
 *
 * Historical note: prior implementation was
 *   return `node ${JSON.stringify(absScriptPath)}`;
 * That produced a string containing literal `\\` byte sequences for
 * Windows paths, which were then JSON.stringify'd a second time when the
 * enclosing settings object was serialized — yielding `\\\\` on disk and
 * breaking identifier matching on cleanup. The fix inlines the quoted
 * path directly; `JSON.stringify` applied at settings-write time handles
 * escaping once, correctly.
 */
export function hookCommandNode(absScriptPath) {
  return `node "${absScriptPath.replace(/\\/g, "/")}"`;
}

/** Hook blocks matching Meta_Kim canonical runtime (absolute paths under meta-kim/). */
export function buildMetaKimHooksTemplate(
  absHooksDir,
  packageRoot = null,
  { hookPromptAdapter = false, hookPromptCommand = null } = {},
) {
  const cmd = (name, args = []) => ({
    type: "command",
    command: [
      hookCommandNode(path.join(absHooksDir, name)),
      ...args.map((arg) => JSON.stringify(String(arg).replace(/\\/g, "/"))),
    ].join(" "),
  });

  const userPromptHooks = [];
  if (hookPromptCommand) {
    userPromptHooks.push({
      type: "command",
      command: hookPromptCommand,
      timeout: 10000,
    });
  } else if (hookPromptAdapter) {
    userPromptHooks.push(cmd("hookprompt-adapter.mjs"));
  }
  userPromptHooks.push(
    cmd(
      "activate-meta-theory-spine.mjs",
      packageRoot ? ["--package-root", packageRoot] : [],
    ),
  );
  userPromptHooks.push(cmd("planning-continuity.mjs", ["--event", "user-prompt", "--runtime", "claude"]));

  return {
    SessionStart: [
      {
        matcher: "startup|resume",
        hooks: [cmd("planning-continuity.mjs", ["--event", "session-start", "--runtime", "claude"])],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: userPromptHooks,
      },
    ],
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [cmd("block-dangerous-bash.mjs")],
      },
      {
        matcher:
          "Write|Edit|Bash|Agent|Task|TaskCreate|TaskUpdate|TodoWrite|TaskStop|EnterPlanMode|ExitPlanMode|MultiEdit|NotebookEdit",
        hooks: [cmd("enforce-agent-dispatch.mjs", ["--runtime", "claude"])],
      },
    ],
    PostToolUse: [
      {
        matcher: "Edit|Write",
        hooks: [cmd("planning-continuity.mjs", ["--event", "post-tool", "--runtime", "claude"])],
      },
    ],
    PreCompact: [
      {
        matcher: "*",
        hooks: [cmd("planning-continuity.mjs", ["--event", "pre-compact", "--runtime", "claude"])],
      },
    ],
    Stop: [
      {
        matcher: "*",
        hooks: [
          cmd("planning-continuity.mjs", ["--event", "stop", "--runtime", "claude"]),
          cmd("stop-compaction.mjs"),
          cmd("stop-console-log-audit.mjs"),
          cmd("stop-completion-guard.mjs"),
          cmd("stop-memory-save.mjs"),
          cmd("stop-save-progress.mjs"),
          cmd("stop-spine-cleanup.mjs"),
        ],
      },
    ],
  };
}

export function stripGlobalMetaKimHookEntriesFromBlocks(
  blocks,
  { isManagedHookCommand = isGlobalMetaKimManagedHookCommand } = {},
) {
  return blocks
    .map((block) => ({
      ...block,
      hooks: (block.hooks || []).filter(
        (h) =>
          !isManagedHookCommand(h.command || "") &&
          !isRawHookPromptUserPromptSubmitCommand(h.command || ""),
      ),
    }))
    .filter((block) => (block.hooks || []).length > 0);
}

// ── Repo .claude/hooks/*.mjs (sync-runtimes project scope) ──────────────

const REPO_META_KIM_HOOK_FILES = [
  "activate-meta-theory-spine.mjs",
  "block-dangerous-bash.mjs",
  "enforce-agent-dispatch.mjs",
  "graphify-context.mjs",
  "meta-kim-memory-save.mjs",
  "planning-continuity.mjs",
  "post-format.mjs",
  "post-typecheck.mjs",
  "post-console-log-warn.mjs",
  "subagent-context.mjs",
  "stop-compaction.mjs",
  "stop-memory-save.mjs",
  "stop-console-log-audit.mjs",
  "stop-completion-guard.mjs",
  "stop-spine-cleanup.mjs",
];

export function isRepoMetaKimHookCommand(command) {
  if (typeof command !== "string") {
    return false;
  }
  const norm = normalizeHookCommand(command).replace(/\\/g, "/");
  if (
    norm.includes("graphify-out/graph.json") &&
    (norm.includes("CMD=$(python3") || norm.includes("case \"$CMD\""))
  ) {
    return true;
  }
  if (!norm.includes(".claude/hooks/")) {
    return false;
  }
  const managedFiles = [
    ...REPO_META_KIM_HOOK_FILES,
    ...RETIRED_META_KIM_HOOK_FILES,
  ];
  return managedFiles.some((f) => norm.endsWith(f) || norm.includes(`/hooks/${f}`));
}

export function stripRepoMetaKimHookEntriesFromBlocks(blocks) {
  return blocks
    .map((block) => ({
      ...block,
      hooks: (block.hooks || []).filter(
        (h) => !isRepoMetaKimHookCommand(h.command || ""),
      ),
    }))
    .filter((block) => (block.hooks || []).length > 0);
}

export function stripRepoMetaKimHooksFromSettings(settings) {
  const next = { ...settings };
  const hooks = {};
  for (const [event, blocks] of Object.entries(next.hooks ?? {})) {
    const cleaned = stripRepoMetaKimHookEntriesFromBlocks(blocks || []);
    if (cleaned.length > 0) {
      hooks[event] = cleaned;
    }
  }
  next.hooks = hooks;
  return next;
}

// ── Shared block merge ───────────────────────────────────────────────────

export function mergeHookMatcherBlocks(existing, additions) {
  const result = structuredClone(existing);
  for (const addBlock of additions) {
    const idx = result.findIndex((b) => b.matcher === addBlock.matcher);
    if (idx === -1) {
      result.push(structuredClone(addBlock));
      continue;
    }
    const cmds = new Set(
      (result[idx].hooks || []).map((h) => h.command).filter(Boolean),
    );
    for (const h of addBlock.hooks || []) {
      if (!cmds.has(h.command)) {
        if (!result[idx].hooks) {
          result[idx].hooks = [];
        }
        result[idx].hooks.push(h);
        cmds.add(h.command);
      }
    }
  }
  return result;
}

/** Merge Meta_Kim global hooks (hooks/meta-kim/) into existing settings; preserves other keys. */
export function mergeGlobalMetaKimHooksIntoSettings(
  settings,
  template,
  options = {},
) {
  const next = { ...settings };
  if (!next.hooks) {
    next.hooks = {};
  }
  const hooks = {};
  for (const [event, blocks] of Object.entries(next.hooks)) {
    const cleaned = stripGlobalMetaKimHookEntriesFromBlocks(
      blocks || [],
      options,
    );
    if (cleaned.length > 0) {
      hooks[event] = cleaned;
    }
  }

  for (const [event, additionBlocks] of Object.entries(template)) {
    hooks[event] =
      event === "UserPromptSubmit"
        ? mergeHookMatcherBlocks(additionBlocks, hooks[event] || [])
        : mergeHookMatcherBlocks(hooks[event] || [], additionBlocks);
  }

  next.hooks = hooks;
  return next;
}

/** Merge Meta_Kim repo hooks (.claude/hooks/*.mjs) into existing settings.hooks. */
export function mergeRepoMetaKimHooksIntoSettings(settings, templateHooks) {
  const next = { ...settings };
  if (!templateHooks) {
    return next;
  }
  if (!next.hooks) {
    next.hooks = {};
  }
  const hooks = {};
  for (const [event, blocks] of Object.entries(next.hooks)) {
    const cleaned = stripRepoMetaKimHookEntriesFromBlocks(blocks || []);
    if (cleaned.length > 0) {
      hooks[event] = cleaned;
    }
  }

  for (const [event, additionBlocks] of Object.entries(templateHooks)) {
    hooks[event] = mergeHookMatcherBlocks(hooks[event] || [], additionBlocks);
  }

  next.hooks = hooks;
  return next;
}

/** Union deny lists; object fields: base overrides canonical for same keys except deny. */
export function mergePermissionsDenyUnion(canonicalPerm, basePerm) {
  if (!canonicalPerm && !basePerm) {
    return undefined;
  }
  const merged = { ...canonicalPerm, ...basePerm };
  const deny = [
    ...new Set([...(canonicalPerm?.deny ?? []), ...(basePerm?.deny ?? [])]),
  ];
  if (deny.length) {
    merged.deny = deny;
  }
  return merged;
}

/**
 * Merge canonical Claude settings into existing repo-local settings: keep user
 * keys, union permissions.deny, strip stale Meta_Kim hook commands, and merge
 * the current canonical project hook block. Global install carries reusable
 * global hooks; project bootstrap still writes project-native runtime config.
 * @param {Record<string, unknown>} base - existing ~/.meta or user file (may be {})
 * @param {Record<string, unknown>} canonical - parsed canonical/runtime-assets/claude/settings.json with repo-relative hook paths.
 */
export function mergeRepoClaudeSettings(base, canonical, repoRoot = null) {
  const out = { ...base };
  const canonicalForMerge = structuredClone(canonical);

  void repoRoot;

  for (const [k, v] of Object.entries(canonicalForMerge)) {
    if (k === "hooks" || k === "permissions") {
      continue;
    }
    if (out[k] === undefined) {
      out[k] = v;
    }
  }

  out.permissions = mergePermissionsDenyUnion(
    canonicalForMerge.permissions,
    base.permissions,
  );

  out.hooks = mergeRepoMetaKimHooksIntoSettings(
    stripRepoMetaKimHooksFromSettings(base),
    canonicalForMerge.hooks,
  ).hooks;

  return out;
}
