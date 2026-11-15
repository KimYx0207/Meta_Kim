# Minimal compatibility fixes — v3.15.1

This patch corrects installation choices, explicit configuration conflicts and
outdated host assumptions. It does not remove governance roles, shorten the
professional methods or add a new automation framework.

## Changes

| Area | Corrected behavior |
| --- | --- |
| Installer selection | First installation preselects detected supported clients. Updates retain saved choices. Explicit `--targets` wins. Empty selection cancels. DSH keeps its independent lifecycle. |
| Codex settings | Explicit `false`, Windows settings and existing concurrency values are preserved. Current and legacy capacity keys are recognized without inventing a second setting. |
| Claude MCP | Installation and discovery share the correct `.claude.json` path, including an official relocated config directory and the existing explicit project override. |
| Delegation | Instructions use the current host's real tools, namespace and supported arguments. Work is scheduled within available capacity. |
| Ownership and evidence | Warden requests dispatch through Conductor; exit-code-only receipts follow their declared format; persistent project work retains its project owner requirement. |
| Release verification | Dual-host native model certification is opt-in. Package installation, update, uninstall, portability, permissions, ownership and rollback checks remain required in their existing lanes. |
| Other hosts | Gemini/ZCode source-checkout self-install keeps the same execution root as source sync; external projects retain the immutable root and user edits remain protected. Source context files are not merged back into themselves. Shared Skill summaries name the selected clients. Correct three obsolete OpenClaw documentation paths. |

## Observed checks

The initial minimal-fix source tree (`5431dafe3e408a7313c9e398730907a7118e9d54`)
was checked before the release metadata and
installer-default follow-up. These results describe their actual scopes; they
are not a claim that every host completed a real model task.

- Configuration, planner, manifest, rollback, capacity and discovery checks:
  175 passed, 6 platform skips.
- Agent dispatch, stage bridge, runtime safety and projection checks: 141 passed.
- Structural, parallel-lane and capability-routing checks: 77 passed.
- Isolated global installation/check cases: 2 passed, including relocated Claude
  configuration and explicitly disabled Codex settings.
- Optional-certification and package evidence checks: 101 distinct tests passed.
- The full current-package diagnostic lane passed real packed install/update,
  reinstall, uninstall, project ownership, source-removal portability and MCP
  transport. Its historical lane was not requested, so that diagnostic did not
  itself carry a complete release-grade claim.
- The installer-default follow-up passed 83 focused checks.
- Six isolated public install/update scenarios passed with version-only CLI
  fixtures: Gemini and ZCode each install alone; updates preserve either saved
  target even when only Codex is detected; saved Claude without its executable
  fails with an explicit binding error; an empty selection without any client
  cancels without installing another target. No unselected Claude/Codex Agent
  or executable-binding files were created.
- Shared-Skill summary and existing projection manifest checks passed 49 tests,
  including actual single-Gemini, single-Codex and combined project syncs.
- Four complete source-checkout self-install/update probes passed for Gemini
  and ZCode. The native projection suite passed all 10 tests, including unchanged
  source context, repeat-update idempotence, rejection and byte preservation of
  user-edited MCP fragments, and the existing external/global stable-package
  checks after deleting their source. Three existing external managed-context
  merge tests also passed.
- Final local preparation passed all 7 Meta integrity checks and 56 release
  documentation, publisher and installer-default checks. The npm dependency
  tree is unchanged; only root version metadata and its reviewed digest changed.
- The first CI attempt identified a stale migration catalog after the two role
  corrections. The existing generator added their six exact projection
  fingerprints without removing historical entries; its check and all three
  catalog regression tests passed before the new CI attempt.
- Gemini/ZCode projection and lifecycle, DSH profile lifecycle and ZCode
  candidate checks passed 31 tests without model calls. They include isolated
  project/global updates, uninstall, preserved user configuration, portable
  execution references and native Hook protocol fixtures.

Repository CI and the release workflow bind their final results and package
hashes to the exact published commit. The release attachments are the authority
for the final package checks, not the counts above.

## Preserved rules and remaining limits

All nine Meta roles, eight governance stages, both PRD levels, professional
methods, capability discovery, permissions, provenance, project ownership,
backup and rollback remain in place.

- Gemini/ZCode have native projections; this round's file and lifecycle checks
  do not certify real model tasks or expand the existing stage-runner authority.
- DSH supplies the nine governance roles as Skills and keeps its separate
  profile/Skill/MCP lifecycle. Hard Hook enforcement and the existing stage
  runner remain outside that adapter. Older official no-model reports retain
  their original package/version scope.
- OpenClaw still lacks Meta_Kim's typed blocking-plugin adapter. ZCode project
  hooks remain unsupported; its existing global/plugin hook path is preserved.
- Kim_Service's automatic memory hooks remain on its existing Claude/Codex
  adapters. This patch does not add Gemini/ZCode/DSH HookPrompt or automatic
  memory adapters; the manual memory core remains available.
- No personal model token was used, and no personal installed client
  configuration was updated by these isolated checks.

Kim_Service's corresponding changes are documented separately in its V1.19
changelog and verification record.
