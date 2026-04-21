# Codex - Platform Research

## Official Documentation

- Codex CLI: https://github.com/openai/codex (OpenAI's CLI agent)
- Agent Skills standard: https://github.com/vercel-labs/skills

## Skill System

### Format

- Standard: **AgentSkills open standard** (`SKILL.md` with YAML frontmatter)
- Codex supports the same universal SKILL.md format as Claude Code
- Progressive disclosure: metadata scanned, full content loaded on demand

### Path Conventions

| Scope | Path |
|-------|------|
| Global skills | `~/.codex/skills/<skill-id>/SKILL.md` |
| Project skills | `.agents/skills/<skill-id>/SKILL.md` |
| Agent config | `.codex/agents/*.toml` |
| User-level config | `~/.codex/config.toml` |

Note: The `.agents/skills/` project-level path is a **universal path** shared by Codex, Cursor, Cline, GitHub Copilot, and Gemini CLI.

### Supported Features

| Feature | Support | Notes |
|---------|---------|-------|
| Basic SKILL.md | Y | Full support |
| `allowed-tools` | Y | Tool restriction per skill |
| `context: fork` | N | Not supported |
| Hooks | Y | `.codex/hooks.json` (SessionStart, SessionStop, UserPromptSubmit, PreToolUse, PostToolUse); v0.117.0+ |
| Plugins | N | No marketplace |

### Agent Configuration

Codex uses TOML format for agent definitions:

```toml
name = "agent-id"
description = "Agent description"
developer_instructions = """
Full agent instructions here
"""
```

### Differences from Claude Code

- No hooks system
- No context:fork capability
- No plugin marketplace
- Uses TOML for agent config (Claude uses Markdown with frontmatter)
- Shares `.agents/skills/` universal project path with Cursor and others

## Data Sources

- OpenAI Codex CLI repository
- mintlify.com/vercel-labs/skills (AgentSkills standard)
- Skills CLI listing 40+ supported agents

## Research Date

2026-04-13
