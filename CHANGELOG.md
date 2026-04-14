# Changelog

All notable changes to Meta_Kim are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
When you tag a release, add a new **`## [version] - YYYY-MM-DD`** section at the top (above older entries) and list changes there.

## [2.0.2] - 2026-04-14

### Fixed

- **Windows `EBUSY` on skill staging cleanup**: `deployStagedSkill` no longer fails the whole global install when deleting a sibling `*.staged-*` folder hits `resource busy or locked` (Defender/indexer/transient handles). Uses `rmDirWithRetry` + `rmDirBestEffortLocked` with short backoff; lock errors log `warnStagingLocked` instead of aborting after a successful deploy.
- **Proxy detection UX overhaul**: `setup.mjs` now asks user to confirm detected proxy (default = yes, Enter to accept). Previously auto-detected and applied system proxy silently, which caused TLS failures.
- **Proxy auto-detection removed from install script**: `install-global-skills-all-runtimes.mjs` no longer auto-detects system proxy — only respects `--proxy` flag, `META_KIM_GIT_PROXY` env, or user's explicit choice from setup.mjs.
- **"loopback proxy stripped" false positive**: Fixed — strip logic now checks `META_KIM_GIT_PROXY` env var, so configured proxies are not stripped.
- **git subprocess proxy propagation**: `spawnSync` and `spawn` in `runGit()`/`runGitAsync()` now pass `env: process.env`, so proxy env vars actually reach git.
- **Staging directory EBUSY crashes**: `cleanupStaleStagingDirs()` now catches Windows lock errors and skips locked directories with a warning instead of crashing.
- **False-positive SKILL.md quarantine**: `listSkillFiles()` in `install-skill-sanitizer.mjs` now skips `openclaw/`, `cursor/`, `codex/`, and `openclaw/skills/` subdirectories — these contain legitimate cross-platform sub-skills (e.g. gstack's own OpenClaw skills) and are not invalid nested garbage.
- **`os.platform()` typo**: Fixed to `os.platform()` in `install-global-skills-all-runtimes.mjs`.
- **`sleepSyncMs` for Windows**: Replaced `spawnSync("sleep", ...)` with PowerShell `Start-Sleep` on Windows; POSIX `sleep` on others; last-resort busy-wait as fallback.

### Changed

- **`askProxyConfig()` default = yes**: When a proxy is detected, the prompt now defaults to using it (`[Y/n]`). User can still opt out by typing `n`.
- **Git fallback strategy**: `runGit()` and `runGitAsync()` now try direct connection first, then fall back to proxy if network fails. If user has no proxy configured, direct succeeds and proxy is never attempted.
- **`i18n` proxy keys**: Added `proxyDetectedPrompt`, `proxySkip`, `proxySkipDeclined`, `proxySaved`, `proxyFallbackProxy`, `proxyFallbackProxySuccess` across all 4 languages (en, zh-CN, ja-JP, ko-KR).
- **Concurrency limiting**: `MAX_CONCURRENT_CLONES = 3` limits parallel git clones to prevent system resource exhaustion.

## [2.0.1] - 2026-04-13

### Added

- **Git retry with skillLabel**: `runGit()` in `install-global-skills-all-runtimes.mjs` auto-retries TLS/proxy failures up to 3 times with increasing delays (2s/4s/6s), and retry messages now identify the exact skill name instead of raw git args.
- **setup.mjs full i18n migration**: All hardcoded English strings in `setup.mjs` replaced with `t.*()` calls across 4 languages (en, zh-CN, ja-JP, ko-KR) — 19 new i18n keys added.
- **warnGitRetry i18n key** added to `meta-kim-i18n.mjs` for all 4 languages.
- **Skill sanitizer script** (`scripts/install-skill-sanitizer.mjs`): detects and quarantines invalid nested `SKILL.md` files inside managed installs.
- **Research docs** (`docs/research/`): dependency analysis, platform profiles, and distribution matrix for third-party skills.
- **install-error-classifier** enhancements: `parseGitHubRepoUrl`, `buildGitHubTarballUrl`, expanded TLS/proxy classification.

### Changed

- `resolveRuntimeHomeDir()` extracted from `install-global-skills-all-runtimes.mjs` into `meta-kim-sync-config.mjs` for shared use.
- Legacy subdir install detection and repair now runs automatically during skill install/update.
- Archive extraction on Windows uses relative path + `cwd` to avoid tar misinterpreting `C:\path` as a remote host.

### Fixed

- **repoPath undefined crash** in `meta-kim-local-state.mjs`: `ensureProfileState()` used undeclared `repoPath` variable; now correctly uses `repoRoot` constant.
- **Retry message confusion**: `git -C` showed instead of skill name in retry warnings — all 5 `runGit` call sites now pass explicit `skillLabel`.
- **Windows tar path bug**: archive fallback extraction failed with `Cannot connect to C: resolve failed` on Windows due to colon in absolute path.

## [2.0.0] - 2026-04-11

### Added

- **Configurable multi-platform framework**: Meta_Kim now supports mapping to any runtime platform via `config/sync.json` manifests — add a new `generatedTargets` entry and a corresponding profile, and `sync-runtimes.mjs` projects to it automatically. No hardcoded platform list.
- **Cursor as a fourth runtime target**: `.cursor/agents/*.md`, `.cursor/skills/meta-theory/`, `.cursor/mcp.json`. Cursor agents use plain Markdown (no YAML frontmatter) for compatibility with Cursor's agent system.
- `runtimes/cursor.profile.json` with Cursor-specific projection and activation config.
- `--targets cursor` support in all sync/setup commands.
- **Enhanced agent principles**: all 8 canonical agents (`meta-warden` through `meta-scout`) updated with strengthened capability-first dispatch, explicit ownership boundaries, and cross-runtime awareness including Cursor.
- **Shared i18n module** (`scripts/meta-kim-i18n.mjs`) unifies all install/update strings across 4 languages.
- **Setup UI overhaul**: `setup.mjs` now features a branded ASCII art banner with gold gradient, streamlined headings (`▸` style), and compact status output.
- **X/Twitter contact** (`https://x.com/KimYx0207`) in banner and `config/skills.json` author links.
- Plugin pre-check in `install-global-skills-all-runtimes.mjs`: uses `claude plugins list --json` to detect already-installed plugins.

### Changed

- `installPythonTools()` and `install-global-skills-all-runtimes.mjs` now use `pip show graphifyy` for reliable detection with suppressed verbose output.
- `sync-global-meta-theory.mjs` and `meta-kim-sync-config.mjs` updated with cursor runtime spec support.
- `--scope project|global|both` now works consistently across `setup.mjs --update` and `sync:runtimes`.
- `meta-theory` skill version bumped to 2.0.0.

### Fixed

- **Graphify verbose output**: pip install no longer prints 20+ "Requirement already satisfied" lines when already installed.
- `sync-global-meta-theory.mjs` crash on cursor target (`Cannot read properties of undefined`) — cursor was missing from `runtimeSpecs` dict.
- `sync-runtimes.mjs` Codex paths corrected: `.claude/` → `.codex/` for all codex-*-Dir variables.

## [1.5.0] - 2026-04-11

### Added

- **Framework extensibility via `config/sync.json`**: Any platform can be added by editing the manifest — no hardcoded platform list. The sync system is now truly runtime-agnostic: add a new `generatedTargets` entry and a corresponding profile, and `sync-runtimes.mjs` projects to it automatically.
- `shared-skills/` sync block added to `sync-runtimes.mjs`: mirrors `meta-theory.md` and `references/` alongside OpenClaw projections, enabling a portable shared skill layer.
- `--scope project|global|both` now works consistently across `setup.mjs --update` and `sync:runtimes`: `project` writes to repo-local dirs, `global` writes directly to runtime homes, `both` writes to both.
- Shared i18n module (`scripts/meta-kim-i18n.mjs`) unifies all install/update strings across 4 languages, replacing scattered hardcoded English in `setup.mjs` and `install-global-skills-all-runtimes.mjs`.
- Plugin pre-check in `install-global-skills-all-runtimes.mjs`: uses `claude plugins list --json` to detect already-installed plugins before installing, preventing repeated re-install.

### Fixed

- `sync-runtimes.mjs` Codex paths corrected: `.claude/` → `.codex/` for all codex-*-Dir variables.
- graphify command on Windows: bare `graphify` replaced with `python -m graphify` in both scripts.
- `--update` mode now prompts for install scope (project/global/both) like install mode, instead of hardcoding `project`.
- `.gitignore` now correctly ignores derived directories at directory level: `.codex/`, `codex/`, `shared-skills/`, `.meta-kim/`, and `openclaw/workspaces/*/.openclaw/`.

## [1.4.0] - 2026-04-10

### Added

- Runtime-neutral canonical source layer under `canonical/`, plus repo-tracked sync manifest (`config/sync.json`) and three runtime profiles for Claude, Codex, and OpenClaw.
- Local activation configuration via `.meta-kim/local.overrides.json`, with explicit separation between repo `supportedTargets` / `defaultTargets` and machine-level `activeTargets`.
- `--targets` support across `setup.mjs`, `sync:runtimes`, `sync:global:meta-theory`, and `deps:install:all-runtimes`, so local activation can be multi-selected without shrinking the repo support surface.
- `--scope` support for `sync:runtimes`: `--scope project` writes to repo-local dirs (default), `--scope global` writes directly to `~/.claude/`, `~/.codex/`, `~/.openclaw/`, with safety assertions to prevent writes outside configured runtime homes.

### Changed

- `.claude/` is no longer treated as the canonical source layer; Claude, Codex, and OpenClaw are now peer runtime projections generated from `canonical/`.
- `setup.mjs` now saves machine-local active runtime selection and uses it for local activation, while repo projection sync still follows repo-supported targets.
- Validation, MCP runtime loading, migration staging, and meta-theory tests now read canonical agents / skill sources from `canonical/` instead of assuming `.claude/` is the source of truth.
- `validate` now guards the canonical kernel and runtime-asset templates only; projection freshness stays in `check:runtimes`, so repo correctness no longer depends on generated mirrors or repo-local OpenClaw config.
- OpenClaw evaluation now uses an ephemeral config outside the tracked repo surface, and the legacy `openclaw/openclaw.local.json` plus `sync:global:meta-theory:codex-active` path have been removed from the public project model.

## [1.3.0] - 2026-04-10

### Added

- Runtime-level `dispatchEnvelopePacket` governance for non-query runs, plus validator coverage for owner, capability boundary, memory mode, and review / verification ownership.
- Repo-local state layout under `.meta-kim/state/{profile}/`, including `run-index.sqlite`, local `compactionPacket` continuity state, and profile collision safeguards.
- Operator commands `index:runs`, `query:runs`, `rebuild:run-index`, and `migrate:meta-kim` for governed-run retrieval and staged migration from older prompt-pack / single-agent repos.

### Changed

- `discover:global` now rebuilds `.claude/capability-index/meta-kim-capabilities.json` first and keeps `global-capabilities.json` as a compatibility mirror.
- `doctor:governance` now reports layered health across canonical contracts, mirror parity, runtime hooks, and local profile / run-index state.
- Sync all runtime-facing governance docs to the new run-index / dispatch-envelope / compaction model, including `.claude/agents/*.md`, `CLAUDE.md`, `AGENTS.md`, and all four README language variants.

### Fixed

- Fill the previously missing README updates in `README.ja-JP.md` and `README.ko-KR.md` so the multilingual docs now cover the new capability index, local run index, migration helper, and layered governance doctor flow.

## [1.2.3] - 2026-04-04

### Documentation

- **README (all four languages)**: remove `<div align="center">` wrappers around fenced Mermaid code blocks so **Cursor** (and similar previews) can render diagrams instead of **Unable to render rich display**; keep `div` centering for Markdown **tables** only. Repo-wide pass: `README.md` 9 blocks, `README.zh-CN.md` 9, `README.ja-JP.md` / `README.ko-KR.md` 8 each.

## [1.2.2] - 2026-04-03

### Documentation

- Align **README.ja-JP.md** and **README.ko-KR.md** with **README.md** / **README.zh-CN.md**: shared anchors (`#complex-spine-*`, `#meta-kim-diagram-two-layers-*`, `#task-routing-*`), workflow maps, runtime / eight-agent mini diagrams, and links to English canonical sections where detail stays in `README.md`.
- Fix **Mermaid** layout: `flowchart TB` with two horizontal `subgraph` blocks often renders **side-by-side**; replace with **stacked `flowchart LR`** pairs for the eight-stage spine (rows 1–4 / 5–8) and for spine vs 10-phase business workflow.
- Wrap Markdown **tables** in `<div align="center">` across all four READMEs so GitHub / VS Code previews center consistently (including stage tables with `Critical`, Hooks, Commands, etc.).
- **Repository structure**: replace ASCII tree with **path | description** tables in `README.md`, `README.ja-JP.md`, and `README.ko-KR.md` (match `README.zh-CN.md` granularity); add `codex/`, `docs/`, `shared-skills/`, `CHANGELOG.md` rows where missing.
- **JA/KO**: add the **two-layer workflow vocabulary** table (8-stage spine vs 10-phase business contract); add **`npx … meta-kim`** row to Quick Start usage tables; link abbreviated npm script lists to **`README.md#commands`** for the full command reference.
- Document **Meta_Kim** (`node setup.mjs`) as the canonical install path for **KimYx0207/findskill**; four README languages plus `CLAUDE.md` state that **in-repo naming uses `findskill` only** (aligned with `~/.claude/skills/findskill/`).
- **`npx` one-shot entry**: `npx github:KimYx0207/Meta_Kim meta-kim` documented as equivalent to `node setup.mjs` with per-locale `--check` examples.

### Added

- **Graphify** optional integration: compressed code knowledge graphs for target projects (subgraph extraction, up to ~71× token reduction), `graphify:*` npm scripts, Fetch-stage auto-detection hooks, README sections in all languages.

### Fixed

- Unify **findskill** naming across this repository: remove mixed **`find-skills`** wording in `meta-scout` / `meta-artisan` (`.claude`, `.codex`, OpenClaw SOUL), all `dev-governance` mirrors, and `docs/zh-CN/agents`, so prompts match the installed skill directory.
- Install **planning-with-files** from `skills/planning-with-files/` (sparse/subdir copy) in `install-deps.sh`, `setup.mjs`, and `install-global-skills-all-runtimes.mjs` so `~/.claude/skills/planning-with-files/SKILL.md` exists and Claude Code can load the skill and its frontmatter hooks. Whole-repo clone left SKILL only nested, so the skill was invisible.
- Install **findskill** from `windows/` on Windows and `original/` elsewhere (`KimYx0207/findskill` keeps no top-level `SKILL.md`). Same three install entrypoints updated.

### Changed

- Extend `config/contracts/workflow-contract.json` again to formalize card governance: `cardPlanPacket`, `cardDecision`, `deliveryShell`, `silenceDecision`, `controlDecision`, `summaryPacket`, explicit dealer ownership, and run-artifact validation policy.
- Add `scripts/validate-run-artifact.mjs` plus run-artifact fixtures/tests so Meta_Kim now validates real packet chains instead of only schema presence.
- Sync `README.md`, `README.zh-CN.md`, `CLAUDE.md`, and `AGENTS.md` to the new card/dealer/silence/summary/run-validator model; these doc changes now map to concrete contract and script additions instead of standalone wording.
- Align `package.json` with the latest released changelog version and stop public-facing docs from treating private/untracked `docs/meta.md` and `docs/repo-map.md` as required public entry points.
- Clarify in both README files that `docs/` is internal-only and remove any public requirement to read `docs/runtime-capability-matrix.md`.
- Harden `config/contracts/workflow-contract.json` from documentation-only governance toward runtime-checkable governance: add `taskClassification`, finding-level closure rules, explicit `writebackDecision`, and hard public-display gate semantics.
- Extend `scripts/validate-project.mjs` and `tests/meta-theory/07-contract-compliance.test.mjs` to enforce the new task-classification, finding-closure, evolution-decision, and runtime-parity requirements.
- Expand `docs/runtime-capability-matrix.md` with a behavior parity matrix covering trigger parity, hook parity, review parity, verification parity, stop condition parity, and writeback parity.
- Sync `README.md`, `README.zh-CN.md`, `CLAUDE.md`, and `AGENTS.md` to the hardened governance model so the public docs match the canonical runtime contract.
- Re-scope `eval:agents` into a lightweight no-LLM runtime smoke pass by default, and add `eval:agents:live` plus `verify:all:live` for explicit prompt-backed runtime acceptance.
- Harden `scripts/eval-meta-agents.mjs` with cross-platform process-tree cleanup, runtime filtering, and progress logging so interrupted or timed-out runtime checks do not leave orphaned child processes behind.
- Sync `README.md`, `README.zh-CN.md`, `CLAUDE.md`, and `AGENTS.md` to the new smoke-vs-live evaluation split so maintenance guidance matches the actual scripts.
- Rewrite `README.zh-CN.md` into a newcomer-friendly Chinese guide with clearer quick start, runtime roles, maintenance flow, and FAQ.
- Rewrite `README.md` with matching English onboarding, clearer canonical-vs-derived asset guidance, and a simpler command reference.
- Expand both README files to restore key Meta_Kim design concepts: 8-stage spine vs. business workflow, hidden state skeleton, public-display gates, rollback protocol, and Evolution storage.
- Restore the original Mermaid flowcharts in both README files: method chain, 8-stage spine, iron-rules relation, and system flow.
- Rework `AGENTS.md` into a Codex-specific guide that keeps the dispatch-before-execution rule but removes cross-runtime ambiguity.
- Rework `CLAUDE.md` into a clearer Claude Code guide centered on canonical sources, hooks, and the sub-agent dispatch execution rule.
- Expand `AGENTS.md` and `CLAUDE.md` to restore capability-first dispatch, workflow-contract layering, hidden skeleton, and display-gate discipline.
- Normalize explanations for `deps:install`, `discover:global`, `probe:clis`, `eval:agents`, and `verify:all`.
- Strengthen the canonical governance sources to make agent ownership explicit: only pure `Q / Query` may bypass agents, every executable task must have an owner, capability gaps now resolve through existing owner / Type B creation / temporary fallback owner.
- Add protocol-first dispatch requirements across the canonical sources: `runHeader`, `dispatchBoard`, `workerTaskPacket`, `workerResultPacket`, `reviewPacket`, `verificationPacket`, and `evolutionWritebackPacket`.
- Require explicit dependency / parallel-group / merge-owner planning so independent work must parallelize instead of drifting into unnecessary serial execution.
- Tighten Review and Evolution rules so protocol compliance and owner coverage are reviewed, and durable learnings must write back into agents, skills, or workflow contracts.
- Sync both README files to the stronger canonical rules: pure-query bypass only, owner-first execution, protocol-first dispatch, explicit parallel planning, and Evolution writeback to capability assets.
- Add a workflow relation map to both README files so the real project paths are easier to distinguish: pure-query bypass, simple owner-driven shortcut, Type C 8-stage spine, 10-step governance upgrade, meta 3-phase flow, and Type D review flow.
- Clarify the README concept layer in both languages: engineering is a governed domain of meta, but meta should orchestrate execution owners rather than pretending to be a single omnipotent engineer.
- Clarify the README architecture stance in both languages: Meta_Kim still keeps a chain-like spine, but now overlays it with hidden states, event controls, owner protocols, and parallel orchestration rather than remaining a pure linear flow.
- Move the “capability assets reduce repeated token cost over time” explanation into the early README sections in both languages so the long-term economic logic of the system is visible immediately.
- Harden the core method Mermaid diagram in both README files to use GitHub-friendly quoted labels, avoiding render failures around `Meta (元)` and other spaced node text.

## [1.2.1] - 2026-04-02

### Changed

- Restore the two root README files to a more complete project-facing shape instead of the earlier over-compressed onboarding rewrite.
- Re-center the Chinese README on the `元` concept, preserving the original branding, concept explanation, contact block, support links, payment QR codes, and Mermaid diagrams.
- Bring `README.md`, `README.zh-CN.md`, `AGENTS.md`, and `CLAUDE.md` back into alignment with the current project design rather than leaving them as lighter onboarding-only summaries.
- Make the canonical governance sources explicit in documentation: `canonical/` plus `config/contracts/workflow-contract.json`.

### Added

- Canonical owner-first governance rules in `.claude/skills/meta-theory/references/dev-governance.md`: only pure `Q / Query` may bypass agents; every executable task must have an explicit owner.
- Explicit capability-gap resolution ladder: existing owner -> Type B owner creation/composition -> temporary `generalPurpose` owner with required justification and Evolution follow-up.
- Protocol-first dispatch requirements: `runHeader`, `dispatchBoard`, `workerTaskPacket`, `workerResultPacket`, `reviewPacket`, `verificationPacket`, and `evolutionWritebackPacket`.
- Parallelism requirements in the canonical sources: independent work must declare `dependsOn`, `parallelGroup`, and `mergeOwner` instead of defaulting to unnecessary serial execution.
- Evolution writeback rules that require each run to evaluate whether the current owner should be kept, adjusted, created, or retired.

### Synced

- Synced the strengthened canonical `meta-theory` skill and `dev-governance` reference into Codex mirrors, OpenClaw mirrors, shared skills, and workspace packs via `npm run sync:runtimes`.
- Synced the stronger owner-first / protocol-first / parallelism rules back into both public README files so outward-facing docs match the canonical project rules.

## [1.2.0] - 2026-03-28

### Changed

- Rename private `meta/` directory to `docs/` and update all path references across 15+ files.
- Sync `README.md`, `README.zh-CN.md`, `CLAUDE.md`, and `AGENTS.md` to the current project state.
- Remove stale `factory/` references from public documentation.
- Add `config/contracts/` to the repository trees documented in the README files.
- Fix duplicate step numbering in `README.zh-CN.md`.
- Remove hardcoded global capability counts from `CLAUDE.md`.
- Add `.claude/capability-index/` to `.gitignore`.
- Sanitize local Windows paths in `docs/runtime-capability-matrix.md`.

## [1.1.0] - 2026-03-27

### Added

- Agent versioning with a per-agent `version` field in YAML frontmatter.
- Improved CLI output UX for health reports and validation.

### Fixed

- Enforce single-source meta workflow validation.
- Enforce live agent registry checks in OpenClaw prompts.
- Harden meta runtime discovery and OpenClaw agent registry guidance.

## [1.0.0] - 2026-03-22

### Added

- Public open-source release surface.
- 8 flagship specialist meta-agent profiles (`meta-warden` through `meta-scout`).
- Cross-runtime sync tooling: `sync:runtimes`, `validate`, `eval:agents`.
- Global capability discovery via `discover:global`.
- OpenClaw workspace family with full `SOUL.md`, `BOOT.md`, and related files.
- Codex agent mirrors in `.codex/agents/*.toml`.
- Shared skill mirror layer in `shared-skills/`.
- Agent health report script at `scripts/agent-health-report.mjs`.
- MIT license.

### Changed

- Collapse release docs into the root README files.
- Streamline foundry outputs for the open-source release.
- Finalize the initial public release surface.

## [0.5.0] - 2026-03-21

### Added

- Cross-runtime coverage audit in `docs/runtime-coverage-audit.md`.
- Runtime capability matrix in `docs/runtime-capability-matrix.md`.
- Repository map in `docs/repo-map.md`.
- Portable runtime packs for Claude Code, OpenClaw, and Codex.
- OpenClaw bootstrap and local auth assets.
- Runtime evaluation scripts.
- Chinese translations for runtime guides.
- Paper reference and DOI: `10.5281/zenodo.18957649`.

### Fixed

- Bootstrap OpenClaw local auth for meta agents.
- Harden cross-runtime agent and skill portability.

## [0.1.0] - 2026-03-17

### Added

- Initial project structure as a Claude Code project.
- Convert skills to agents and merge SPEC content into agent definitions.
- Baseline snapshot of the Meta_Kim architecture.
