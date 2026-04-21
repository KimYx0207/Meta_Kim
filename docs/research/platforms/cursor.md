# Cursor - Platform Research

## Official Documentation

- Primary site: https://docs.cursor.com
- Agent Skills support confirmed via Skills CLI reference
- Cursor IDE by Anysphere

## Skill System

### Format

- Standard: **AgentSkills open standard** (`SKILL.md` with YAML frontmatter)
- Cursor adopted the AgentSkills standard, confirmed by:
  - Skills CLI listing (mintlify.com/vercel-labs/skills) includes Cursor
  - Multiple third-party projects (gstack, superpowers, everything-claude-code) explicitly list Cursor support
  - Cursor documentation references `.agents/skills/` as project-level skill path

### Path Conventions

| Scope | Path |
|-------|------|
| Global skills | `~/.cursor/skills/<skill-id>/SKILL.md` |
| Project skills | `.agents/skills/<skill-id>/SKILL.md` |
| Agent definitions | `.cursor/agents/*.md` |
| MCP config | `.cursor/mcp.json` |

Note: The `.agents/skills/` project-level path is a **universal path** shared by Cursor, Codex, Cline, GitHub Copilot, and Gemini CLI.

### Supported Features

| Feature | Support | Notes |
|---------|---------|-------|
| Basic SKILL.md | Y | Full AgentSkills support |
| `allowed-tools` | Y | Tool restriction per skill |
| `context: fork` | N | Not supported |
| Hooks | Y | `.cursor/hooks.json` (userPromptSubmit, preToolUse, postToolUse, stop); some bugs reported |
| Plugins | Y | Reuses Claude Code marketplace infrastructure (`~/.cursor/plugins/`) |

### Agent Format

Cursor agents use plain Markdown files (no YAML frontmatter):

```markdown
# Agent Title

> Agent summary

Agent instructions and behavior description...
```

This differs from Claude Code (YAML frontmatter + body) and Codex (TOML format).

### Evidence of Cursor Skill Support

1. **Skills CLI** (mintlify.com/vercel-labs/skills): Lists Cursor among 40+ supported agents
2. **gstack** (garrytan/gstack): Documentation explicitly mentions `~/.cursor/skills/gstack-*/` as install path
3. **superpowers** (obra/superpowers): Lists Cursor in supported platforms
4. **everything-claude-code** (affaan-m): Lists Cursor in supported platforms
5. **planning-with-files** (OthmanAdi): 16+ platforms including Cursor
6. **AgentSkills standard**: Universal `.agents/skills/` path works for Cursor

### Plugin System

Cursor supports plugins via Claude Code marketplace infrastructure:

- `~/.cursor/plugins/installed.json` — lists installed plugins (e.g., `superpowers@superpowers-marketplace`)
- `~/.cursor/plugins/marketplaces.json` — configured marketplace sources (`claude-plugins-official`, `anthropic-agent-skills`, `superpowers-marketplace`)
- Plugin installation follows the same `name@registry` format as Claude Code

### Differences from Claude Code

- Hooks system via `.cursor/hooks.json` (userPromptSubmit, preToolUse, postToolUse, stop)
- No context:fork capability
- Plugin system reuses Claude Code marketplace (not a separate ecosystem)
- Agent format is plain Markdown (no frontmatter)
- Shares `.agents/skills/` universal project path with Codex and others
- Global skill install path is `~/.cursor/skills/`
- No global agents directory (agents are project-level only)

## Data Sources

- Skills CLI reference (mintlify.com/vercel-labs/skills)
- gstack README (explicit `~/.cursor/skills/` mention)
- superpowers README (lists Cursor support)
- everything-claude-code README (lists Cursor support)
- Multiple ecosystem projects confirming Cursor AgentSkills adoption

## Research Date

2026-04-13
