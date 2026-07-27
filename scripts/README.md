# Scripts Inventory

This directory is intentionally large because Meta_Kim exposes most maintenance and product checks as small CLI entrypoints. Do not prune scripts by filename count alone.

## Current Shape

The inventory is computed from the current checkout instead of copied into this
document. Run `npm run meta:inventory` for live script, package-entry, and
tracked-test counts. `npm run meta:test:inventory` additionally fails when a
tracked `*.test.mjs` file is outside the explicit standard suites.

## Core Loop And Discovery Bus

- Default governed execution entry: `npm run meta:theory:run` (`scripts/run-meta-theory-governed-execution.mjs`).
- Machine contract: `config/contracts/core-loop-contract.json`.
- Strict run artifact validator: `npm run meta:validate:run -- <artifact.json>` for full workflow-contract artifacts.
- Local capability discovery bus: `npm run meta:capabilities:index` (`scripts/build-capability-inventory.mjs`), which writes `.meta-kim/state/default/capability-inventory.json` with unified provider records across agents, skills, scripts, commands/tools, MCP, hooks, runtime, OS, memory, graph, and external dependency candidates.

## Main Buckets

| Bucket | What It Does | Examples | Keep Rule |
|---|---|---|---|
| Core engines | Capability-gap decisions, governed execution, routing, state, and tests | `capability-gap-mvp.mjs`, `run-meta-theory-governed-execution.mjs`, `select-execution-route.mjs`, `sqlite-runtime.mjs`, `run-node-tests.mjs` | Keep. These are behavior roots or test roots. |
| Product/report generators | Produce PRD-backed evidence reports, panels, bundles, and replay artifacts | `generate-*-report.mjs`, `run-product-reviewer-replay.mjs`, `run-complex-capability-gap-inputs.mjs` | Keep while their package script or meta-theory test exists. |
| Runtime evidence | Probe or evaluate Claude, Codex, Cursor, OpenClaw, OS, graphify, and live shards | `eval-meta-agents.mjs`, `probe-runtime-capabilities.mjs`, `generate-runtime-live-shard-matrix.mjs`, `graphify-cli.mjs` | Keep. These protect anti-overclaim release boundaries. |
| Sync/install/release | Install, sync projections, audit post-release commit/tree/package binding, uninstall, migrate, check dependencies, and update global targets | `sync-runtimes.mjs`, `audit-release-binding.mjs`, `install-global-skills-all-runtimes.mjs`, `postinstall-check.mjs`, `uninstall.mjs` | Keep unless the package script and tests are removed together. |
| Validators | Validate project, runtime, provider, prompt, route, run artifact, and governance contracts | `validate-*.mjs`, `validate-runtime-safety-contract.mjs`, `score-capability-candidates.mjs` | Keep. Validators are release and safety gates. |
| Doctor/status utilities | Human-facing diagnostics, status, compaction, migration, and next-iteration prompts | `doctor-*.mjs`, `footprint.mjs`, `write-compaction.mjs`, `prompt-next-iteration.mjs` | Keep if exposed in `package.json`; otherwise inspect before cleanup. |
| Shared helpers | Imported by package entries, tests, hooks, or setup flows | `governance-lib.mjs`, `meta-kim-local-state.mjs`, `runtime-hook-mapping.mjs`, `node-spawn-config.mjs` | Keep when referenced by imports, tests, config, or hooks. |

## Before Removing Any Script

Before removing any script, check changelog history, release notes, and whether it was a manual one-off CLI. The 2026-06-22 pass removed three former cleanup candidates (`agent-health-report.mjs`, `check-release-notes-consistency.mjs`, `meta-kim-aggregate.mjs`) after confirming zero source references outside gitignored state caches.

## Why There Are Many Report Scripts

The `generate-*` and `run-*` scripts are mostly one CLI per product acceptance lane. That made tests and evidence easy to audit, but it made the directory harder to scan.

If consolidation is desired, prefer adding a thin dispatcher such as:

```text
scripts/meta-product-report.mjs <trend|warden|runtime-probe|bundle|research|feedback>
```

Then keep old package script names as aliases during one release cycle so tests and users do not break.

## Do Not Delete Yet

Do not delete these groups without a deeper call-chain review:

- any script referenced by `package.json`
- any script referenced from `tests/`
- any script imported by another script using a relative import
- `sync-runtimes.mjs` and projection-related helpers
- runtime/live evidence scripts
- validators and setup/install scripts
- report generators still named in PRD or test evidence
