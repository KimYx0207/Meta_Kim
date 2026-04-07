# Changelog

All notable changes to Meta_Kim are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Documentation

- State that **Meta_Kim** (`node setup.mjs`) is the canonical install path for **KimYx0207/findskill** (maintained/optimized on top of public baselines); discourage parallel duplicate installs and note that labels like `find-skills` often name the same capability family (`README.zh-CN.md`, `CLAUDE.md`).

### Fixed

- Install **planning-with-files** from `skills/planning-with-files/` (sparse/subdir copy) in `install-deps.sh`, `setup.mjs`, and `install-global-skills-all-runtimes.mjs` so `~/.claude/skills/planning-with-files/SKILL.md` exists and Claude Code can load the skill and its frontmatter hooks. Whole-repo clone left SKILL only nested, so the skill was invisible.
- Install **findskill** from `windows/` on Windows and `original/` elsewhere (`KimYx0207/findskill` keeps no top-level `SKILL.md`). Same three install entrypoints updated.

### Changed

- Extend `contracts/workflow-contract.json` again to formalize card governance: `cardPlanPacket`, `cardDecision`, `deliveryShell`, `silenceDecision`, `controlDecision`, `summaryPacket`, explicit dealer ownership, and run-artifact validation policy.
- Add `scripts/validate-run-artifact.mjs` plus run-artifact fixtures/tests so Meta_Kim now validates real packet chains instead of only schema presence.
- Sync `README.md`, `README.zh-CN.md`, `CLAUDE.md`, and `AGENTS.md` to the new card/dealer/silence/summary/run-validator model; these doc changes now map to concrete contract and script additions instead of standalone wording.
- Align `package.json` with the latest released changelog version and stop public-facing docs from treating private/untracked `docs/meta.md` and `docs/repo-map.md` as required public entry points.
- Clarify in both README files that `docs/` is internal-only and remove any public requirement to read `docs/runtime-capability-matrix.md`.
- Harden `contracts/workflow-contract.json` from documentation-only governance toward runtime-checkable governance: add `taskClassification`, finding-level closure rules, explicit `writebackDecision`, and hard public-display gate semantics.
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
- Clarify the README concept layer in both languages: engineering is a governed domain of yuan, but yuan should orchestrate execution owners rather than pretending to be a single omnipotent engineer.
- Clarify the README architecture stance in both languages: Meta_Kim still keeps a chain-like spine, but now overlays it with hidden states, event controls, owner protocols, and parallel orchestration rather than remaining a pure linear flow.
- Move the “capability assets reduce repeated token cost over time” explanation into the early README sections in both languages so the long-term economic logic of the system is visible immediately.
- Harden the core method Mermaid diagram in both README files to use GitHub-friendly quoted labels, avoiding render failures around `Yuan (元)` and other spaced node text.

## [1.2.1] - 2026-04-02

### Changed

- Restore the two root README files to a more complete project-facing shape instead of the earlier over-compressed onboarding rewrite.
- Re-center the Chinese README on the `元` concept, preserving the original branding, concept explanation, contact block, support links, payment QR codes, and Mermaid diagrams.
- Bring `README.md`, `README.zh-CN.md`, `AGENTS.md`, and `CLAUDE.md` back into alignment with the current project design rather than leaving them as lighter onboarding-only summaries.
- Make the canonical governance sources explicit in documentation: `.claude/` plus `contracts/workflow-contract.json`.

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
- Add `contracts/` to the repository trees documented in the README files.
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
