# Meta_Kim Repository Guide

Meta_Kim is a cross-runtime prompt and agent-architecture pack built around the theory in `meta/meta.md`.

This repository intentionally separates:
- canonical theory
- Claude Code runtime assets
- OpenClaw runtime assets
- Codex/shared repository instructions

## Canonical Sources

- `meta/meta.md`: canonical theory source and vocabulary
- `.claude/agents/*.md`: source of truth for the eight Meta_Kim agent definitions
- `.claude/skills/meta-theory/SKILL.md`: source of truth for the reusable method workflow

## Runtime Mapping

| Shared concept | Claude Code | OpenClaw | Codex |
| --- | --- | --- | --- |
| Project instructions | `CLAUDE.md` | workspace `SOUL.md` + `AGENTS.md` | repo-root `AGENTS.md` |
| Specialized agents | `.claude/agents/*.md` | `openclaw/workspaces/*/SOUL.md` | use this file plus repo docs |
| Reusable method | `.claude/skills/meta-theory/` | reflected into workspace prompts | referenced from this file |
| Validation | `npm run validate` | `npm run validate` | `npm run validate` |

## Editing Rules

- Treat `.claude/agents/*.md` as the primary editable source.
- Keep valid YAML frontmatter on every Claude agent file. Claude Code requires `name` and `description`.
- Do not hand-maintain `openclaw/workspaces/*` as the primary source. Rebuild them from the Claude agent files.
- After changing any agent prompt or runtime-facing docs, run:
  - `npm run sync:runtimes`
  - `npm run validate`
- `meta/meta.md` is intentionally long. Reference it when needed; do not blindly inline the whole transcript into every runtime prompt.

## Key Commands

- `npm run sync:runtimes`: rebuild OpenClaw workspace assets and local OpenClaw config output from `.claude/agents`
- `npm run validate`: validate the repo shape, agent frontmatter, and runtime artifacts
- `npm run check`: ensure generated assets are up to date and the project validates cleanly

## What Each Runtime Expects

- Claude Code expects project memory in `CLAUDE.md` and project subagents in `.claude/agents/`.
- OpenClaw expects isolated agent workspaces and identity files such as `SOUL.md`, `AGENTS.md`, and `HEARTBEAT.md`.
- Codex performs best with a clear repo-root `AGENTS.md`, explicit commands, and reliable tests/docs.

## Project Intent

The goal of this repository is not to ship application code. It ships a reusable operating model for agent design:

- `元` solves how to split work.
- `组织镜像` solves how to structure responsibilities.
- `节奏编排` solves how work is released and coordinated.
- `意图放大` solves how higher-level intent survives translation into delivery.
