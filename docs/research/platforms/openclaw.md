# OpenClaw - Platform Research

## Official Documentation

- Repository: https://github.com/openclaw/openclaw
- OpenClaw is an open-source AI agent orchestration platform

## Skill System

### Format

- Standard: **AgentSkills open standard** (`SKILL.md` with YAML frontmatter)
- Also supports single-file Markdown skill format (e.g., `meta-theory.md`)
- Progressive disclosure: metadata scanned, full content loaded on demand

### Path Conventions

| Scope | Path |
|-------|------|
| Global skills | `~/.openclaw/skills/<skill-id>/SKILL.md` |
| Project skills | `openclaw/skills/<skill-id>/` |
| Shared skills | `shared-skills/<skill-id>.md` |
| Workspace config | `openclaw/workspaces/<agent-id>/` |
| Template config | `openclaw/openclaw.template.json` |

### Supported Features

| Feature | Support | Notes |
|---------|---------|-------|
| Basic SKILL.md | Y | Full support |
| `allowed-tools` | Y | Tool restriction per skill |
| `context: fork` | N | Not supported |
| Hooks | Y | Plugin SDK 28 hooks (agent lifecycle, tool execution, message flow, subagent coordination, gateway lifecycle) |
| Plugins | N | No marketplace |
| Workspaces | Y | Multi-agent workspace isolation |

### Workspace Model

OpenClaw has a unique workspace model where each agent gets its own workspace directory containing:

- `BOOT.md` / `BOOTSTRAP.md` - Startup instructions
- `IDENTITY.md` - Agent identity
- `SOUL.md` - Agent behavior boundaries
- `TOOLS.md` - Available tools and teammates
- `AGENTS.md` - Team directory
- `MEMORY.md` - Persistent memory
- `HEARTBEAT.md` - Scheduled task policy
- `USER.md` - User profile context

### Shared Skills Layer

OpenClaw uses a `shared-skills/` directory for project-level skills that are shared across all workspaces, avoiding duplication.

### Differences from Claude Code

- No hooks system
- No context:fork capability
- No plugin marketplace
- Has workspace-per-agent model (unique to OpenClaw)
- Has shared-skills layer for deduplication
- Supports both SKILL.md directory format and single-file Markdown format

## Data Sources

- OpenClaw GitHub repository
- mintlify.com/vercel-labs/skills (AgentSkills standard)
- Meta_Kim project integration code

## Research Date

2026-04-13
