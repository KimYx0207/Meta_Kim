# Distribution Decision Matrix

Cross-referencing platform capabilities with dependency requirements to determine the correct distribution strategy for each skill across all 4 target runtimes.

## Platform Capability Baseline

| Feature | Claude Code | Codex | OpenClaw | Cursor |
|---------|------------|-------|----------|--------|
| Global Skills Path | `~/.claude/skills/` | `~/.codex/skills/` | `~/.openclaw/skills/` | `~/.cursor/skills/` |
| Project Skills Path | `.claude/skills/` | `.agents/skills/` | `skills/` | `.agents/skills/` |
| SKILL.md Format | Y | Y | Y | Y |
| allowed-tools | Y | Y | Y | Y |
| context:fork | Y | N | N | N |
| Hooks System | Y (12 events) | Y (5 events, v0.117.0+) | Y (Plugin SDK 28 hooks) | Y (4 events, some bugs) |
| Marketplace Plugins | Y (11 plugins) | Limited (placeholder) | Limited (placeholder) | Y (reuses Claude marketplaces) |
| Commands | Y (34 commands) | Y (15 commands) | N | N |
| Global Agents Path | `~/.claude/agents/` | `~/.codex/agents/` | `~/.openclaw/` workspaces | N (project-level only) |

Source: see `platforms/*.md` for detailed per-platform research.

## Per-Skill Distribution Decision

### 1. agent-teams-playbook

| Platform | Decision | Install Method | Rationale |
|----------|----------|---------------|-----------|
| Claude Code | DISTRIBUTE | `git clone --depth 1` | SKILL.md format, universal |
| Codex | DISTRIBUTE | `git clone --depth 1` | SKILL.md format, universal |
| OpenClaw | DISTRIBUTE | `git clone --depth 1` | SKILL.md format, universal |
| Cursor | DISTRIBUTE | `git clone --depth 1` | SKILL.md format, universal |

Notes: Contains optional `context: fork` (Claude Code only) but does not affect other platforms.

### 2. findskill

| Platform | Decision | Install Method | Rationale |
|----------|----------|---------------|-----------|
| Claude Code | DISTRIBUTE | subdirTemplate (win32/default) | Platform-specific subdir |
| Codex | DISTRIBUTE | subdirTemplate (win32/default) | Platform-specific subdir |
| OpenClaw | DISTRIBUTE | subdirTemplate (win32/default) | Platform-specific subdir |
| Cursor | DISTRIBUTE | subdirTemplate (win32/default) | Platform-specific subdir |

Notes: Private/restricted repo. `subdirMapping` selects `windows` on win32, `original` otherwise.

### 3. hookprompt

| Platform | Decision | Install Method | Rationale |
|----------|----------|---------------|-----------|
| Claude Code | DISTRIBUTE | `git clone --depth 1` | Uses `.claude/hooks/` + `.claude/settings.json` |
| Codex | SKIP | N/A | hookprompt only implements Claude Code's hook format |
| OpenClaw | SKIP | N/A | hookprompt only implements Claude Code's hook format |
| Cursor | SKIP | N/A | hookprompt only implements Claude Code's hook format |

Notes: Claude-only by design — hookprompt's code targets Claude Code's specific hook configuration format. Codex and Cursor both have hooks systems, but hookprompt does not implement adapters for them.

### 4. superpowers

| Platform | Decision | Install Method | Rationale |
|----------|----------|---------------|-----------|
| Claude Code | DISTRIBUTE | Claude Plugin (`superpowers@superpowers-marketplace`) + git clone | Dual-channel: marketplace plugin + skill dir |
| Codex | DISTRIBUTE | `git clone --depth 1` | SKILL.md format, explicitly supports Codex |
| OpenClaw | DISTRIBUTE | `git clone --depth 1` | SKILL.md format, explicitly supports OpenClaw |
| Cursor | DISTRIBUTE | `git clone --depth 1` | SKILL.md format, explicitly supports Cursor |

Notes: `claudePlugin` field triggers `claude plugin install` for Claude Code. Other platforms get git clone only.

### 5. everything-claude-code

| Platform | Decision | Install Method | Rationale |
|----------|----------|---------------|-----------|
| Claude Code | DISTRIBUTE | sparse checkout `skills/` | Content in subdir, supports Claude Code |
| Codex | DISTRIBUTE | sparse checkout `skills/` | Explicitly supports Codex |
| OpenClaw | DISTRIBUTE | sparse checkout `skills/` | Explicitly supports OpenClaw |
| Cursor | DISTRIBUTE | sparse checkout `skills/` | Explicitly supports Cursor |

Notes: 140K+ stars, 38 agent templates, 156 skills. Content lives in `skills/` subdir of the repo.

### 6. planning-with-files

| Platform | Decision | Install Method | Rationale |
|----------|----------|---------------|-----------|
| Claude Code | DISTRIBUTE | sparse checkout `skills/planning-with-files/` → deploy `skills/planning-with-files` + `plugins/planning-with-files` alias | `pluginHookCompat` for upstream Stop hook path |
| Codex | DISTRIBUTE | same | 16+ platforms supported |
| OpenClaw | DISTRIBUTE | same | 16+ platforms supported |
| Cursor | DISTRIBUTE | same | 16+ platforms supported |

Notes: Has hooks for lifecycle management. Repo content lives under `skills/planning-with-files/`; Meta_Kim installs under each runtime’s `skills/planning-with-files/` and adds `plugins/planning-with-files` pointing at it for hook resolution.

### 7. cli-anything

| Platform | Decision | Install Method | Rationale |
|----------|----------|---------------|-----------|
| Claude Code | DISTRIBUTE | `git clone --depth 1` | 30K+ stars, universal |
| Codex | DISTRIBUTE | `git clone --depth 1` | Explicitly supports Codex |
| OpenClaw | DISTRIBUTE | `git clone --depth 1` | Explicitly supports OpenClaw |
| Cursor | DISTRIBUTE | `git clone --depth 1` | Has per-platform installers |

Notes: Makes any software agent-native. Has per-platform install scripts.

### 8. gstack

| Platform | Decision | Install Method | Rationale |
|----------|----------|---------------|-----------|
| Claude Code | DISTRIBUTE | `git clone --depth 1` | 23-tool suite by Garry Tan |
| Codex | DISTRIBUTE | `git clone --depth 1` | Explicitly supports Codex |
| OpenClaw | DISTRIBUTE | `git clone --depth 1` | Explicitly supports OpenClaw |
| Cursor | DISTRIBUTE | `git clone --depth 1` | Docs explicitly mention `~/.cursor/skills/gstack-*/` |

Notes: Garry Tan (YC President) 23-tool dev setup. Documentation explicitly lists Cursor as supported target.

### 9. skill-creator

| Platform | Decision | Install Method | Rationale |
|----------|----------|---------------|-----------|
| Claude Code | DISTRIBUTE | sparse checkout `skills/skill-creator/` | Anthropic official, universal SKILL.md |
| Codex | DISTRIBUTE | sparse checkout `skills/skill-creator/` | Agent Skills standard |
| OpenClaw | DISTRIBUTE | sparse checkout `skills/skill-creator/` | Agent Skills standard |
| Cursor | DISTRIBUTE | sparse checkout `skills/skill-creator/` | Agent Skills standard |

Notes: From `anthropics/skills` repo. SKILL.md specification reference.

## Code Review Results

### Files Reviewed

| File | Status | Notes |
|------|--------|-------|
| `config/skills.json` | CORRECT | All 9 skills have correct targets |
| `config/sync.json` | CORRECT | cursor in all 3 target lists |
| `scripts/meta-kim-sync-config.mjs` | RESOLVED | `supportsGlobalDependencyInstall: true` (previously reported as `false`; fixed) |
| `scripts/sync-runtimes.mjs` | CORRECT | Full cursor sync support |
| `scripts/install-global-skills-all-runtimes.mjs` | CORRECT | cursor in resolveHomes() and main() |

### Issue: supportsGlobalDependencyInstall Flag

**Location**: `scripts/meta-kim-sync-config.mjs:127`

```js
cursor: {
  activation: {
    supportsGlobalDependencyInstall: true,  // corrected from false
  }
}
```

Previously reported as `false`, but `install-global-skills-all-runtimes.mjs` does install to `~/.cursor/skills/` globally. The flag has been corrected to `true`.

**Impact**: Resolved. Flag now matches actual behavior.

## Research Date

2026-04-13
