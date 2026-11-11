# Installation, clients and task continuity

[English](technical-notes.md) · [简体中文](technical-notes.zh-CN.md) · [日本語](technical-notes.ja-JP.md) · [한국어](technical-notes.ko-KR.md)

[Back to the product overview](../README.md)

Use this page to choose installation options and find the right operational reference. The linked client guides and configuration files contain the detailed integration contracts.

## Installation options

The [README](../README.md#start-with-your-first-project) covers the first installation. Meta_Kim requires Node.js 22.13.0+ and a configured AI client.

| Choice | Use it when |
| --- | --- |
| Global scope | You want the same capabilities available across projects |
| Project scope | A project needs its own setup; specify `--scope project` when using a non-interactive command |
| Client selection | Select the clients you use; `--targets` can make that choice explicit for the regular setup targets |
| Global Hooks | Add `--with-global-hooks` when you want the selected clients' global Hook integration |
| Environment check | Run `node setup.mjs --check` to inspect the installed environment |

Existing settings are merged, and managed updates track which files belong to Meta_Kim. For the available CLI operations, run `node bin/meta-kim.mjs --help`. You can start the installer without cloning with `npx --yes github:KimYx0207/Meta_Kim`.

To update a clone, run `git pull --ff-only` before `node setup.mjs --update`. For an installation started with npx, use `npx --yes github:KimYx0207/Meta_Kim update`.

## Client guides

[Claude Code](../canonical/skills/meta-theory/references/runtime-claude.md) · [Codex](../canonical/skills/meta-theory/references/runtime-codex.md) · [Gemini CLI](../canonical/skills/meta-theory/references/runtime-gemini.md) · [ZCode](../canonical/skills/meta-theory/references/runtime-zcode.md)

The [compatibility catalog](../config/runtime-compatibility-catalog.json) records the available formats and current integration tier for each client, including Cursor, OpenClaw, Qoder and Trae. Hook coverage follows each host's available events; the [runtime operating guide](../AGENTS.md) describes those differences. Dependency projects maintain their own client support.

## DeepSeek Harness

DSH is an optional client integration with its own lifecycle command. It requires **Node.js 24.9.0+**; the reviewed host version is **DSH 0.2.2-rc.1**.

From the Meta_Kim checkout:

```sh
node bin/meta-kim.mjs dsh install
node bin/meta-kim.mjs dsh check
dsh --profile meta-kim
```

Use `node bin/meta-kim.mjs dsh update` and `node bin/meta-kim.mjs dsh uninstall` through the same Meta_Kim CLI to update or remove the managed integration. Add `--service-package /path/to/kim-service-dsh` to install the professional package built by [Kim Service](https://github.com/KimYx0207/Kim_Service/blob/main/docs/dsh.md). Project installation uses `--scope project --project-root /path/to/project` and reports the launch command for that project.

The [DSH guide](../canonical/skills/meta-theory/references/runtime-dsh.md) covers profiles, complete method loading, MCP and the host's permission model. The [observed verification record](verification/dsh-professional-quality-20261111.md) describes configuration, Skill discovery, source handoff and MCP checks. Native task results and model quality are assessed from the task's actual outputs.

## Continuing an interrupted task

Run records keep decisions, completed outputs, dependencies and remaining work with the project. Keep those records when moving or resuming a project. The Live view reads the current run and connects its tasks to their outputs and checks.

For tasks using the monitored execution path, repeated ineffective attempts pause the affected task and record the next review or recovery action. Independent work can continue. A reviewed change of approach starts a recovery trial. If a previous write has an uncertain outcome, first reconcile the saved receipt with the destination's current state.

See [intent to delivery](../canonical/skills/meta-theory/references/intent-to-delivery.md), [architecture](harness-architecture.md) and the [task trial and recovery record](verification/task-scoped-canary-20261111.md) for the underlying flow.

## Optional Memory service

Saved run records provide project continuity. Memory can additionally store and retrieve selected information across sessions. If you enable it, check the configured service address, for example:

```bash
curl -fsS --max-time 3 http://127.0.0.1:8000/api/health
```

The health endpoint checks availability. Verify writing, reading and recall with the configured service when those capabilities matter to your task. `npm run meta:test:mcp` checks Meta_Kim's own MCP server.

## Source and generated files

Shared Agents, Skills and runtime assets are maintained in `canonical/`, with machine-readable configuration in `config/`. Client directories such as `.claude/`, `.codex/` and `.cursor/` are generated locally by `npm run meta:sync`. These runtime projections are excluded from GitHub source and kept local through `.gitignore`; the distribution package includes their shared sources.

## Reading the project records

| Question | Reference |
| --- | --- |
| What does the installer accept? | [Setup entry](../setup.mjs) · [CLI](../bin/meta-kim.mjs) |
| Which client integration is available? | [Compatibility catalog](../config/runtime-compatibility-catalog.json) |
| How do design and methods reach workers? | [Intent to delivery](../canonical/skills/meta-theory/references/intent-to-delivery.md) |
| What changed in a released version? | [Changelog](../CHANGELOG.md) and its linked records |
| How should source changes be maintained? | [Contributor guide](../AGENTS.md) |
