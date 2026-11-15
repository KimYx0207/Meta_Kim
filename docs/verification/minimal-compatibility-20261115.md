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
| Diagnostic source reads | The configured Service analyst receives its existing required method inputs from the actual task and inspected scope. Custom provider selection and production input guards remain unchanged. |
| Work-order ownership | Routes already verified from current Thinking bindings retain their selected owner, source contract and scope when the overall task contains multiple durable capability requests. Candidate generation remains separate. |
| OpenClaw smoke | Recognize the exact missing-auth stderr from the normally exited, cleanup-verified preparation command so the existing structural smoke can run without credentials. Other process failures remain errors. |
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
- The next CI attempt caught the stale reviewed `meta-theory/SKILL.md` source
  binding. Main thread `/root`, acting in the `meta-warden` review role, reviewed
  all four host-delegation/schema wording changes and confirmed every other
  source byte, Fetch/Thinking, owner, permissions, verification and project
  ownership requirement remained unchanged. The existing candidate, exact
  v0.2 approval and repository CAS upgraded only that binding, revision 18 to
  19, retaining all 18 prior history entries and both other current bindings.
  An exact replay was idempotent. All 16 lifecycle hygiene tests and the runtime
  evidence-pin check passed. This was an internal source review, not a native
  custom-agent call, external signature, human approval or model-task certification.
  The approval ID is
  `meta-warden:/root:reviewed-host-delegation-source:2026-11-15T12:45:13.650Z`;
  the candidate digest is
  `sha256:01353e11fdd26fbdeeb56e810d58776b802548fb5831cac457ec2f23ce271aa9`
  and the approval digest is
  `sha256:e00474df9627e1612f30a57caaa718df0cb358666cde3514bbf46ff1d7421220`.
  Rollback remains a separately reviewed upgrade to the exact prior source,
  preserving unknown state and granting no deletion authority.
- A subsequent standard verification attempt exposed an existing diagnostic
  contract mismatch: the configured Service analyst was discovered correctly,
  but its required `question`, `sources` and `deliverablePurpose` inputs were
  absent. The diagnostic/guard sources and relevant Service contracts match the
  prior baselines (`98cb66a2` and `397ed460` respectively). The diagnostic driver
  now supplies those inputs only for the exact discovered dependency analyst,
  using its actual task and already-read scope. Production method-input,
  ownership, permission, readiness and fanout guards were not changed.
  The diagnostic protocol, host method handoff and method delivery suites
  passed all 21 focused tests. In the unchanged isolated environment, the
  original default validator passed with honest `validated_partial` status:
  four structurally ready lanes, fanout safety passed and actual worker
  execution remained false. Removing each of the three required fields from
  the actual selected method handoff still returned `needs_input`,
  `canExecute: false` and `not_invoked`. These are targeted diagnostic results,
  not a replacement for the complete standard release verification.
- The subsequent asset and research validators exposed another existing
  mismatch: the durable-request heuristic replaced an already verified
  Thinking owner with role labels while retaining its dependency source.
  Both the current diagnostic inputs and their prior shape reproduced this.
  The runner now skips that heuristic only for `host_selected_current_bindings`;
  other routes, candidate generation and source-validation guards are unchanged.
  All 24 projection and method-handoff tests passed. Both original asset and
  research validators passed in the unchanged isolated environment. The asset
  run retained its two skill/agent candidates as `candidate_only`, with zero
  canonical writes and no actual worker execution. An unknown owner still
  failed source validation, and removing any of the three required inputs
  still returned `needs_input`, `canExecute: false` and `not_invoked`.
- The standard attempt at `7a21ad17` passed packed preflight and stages 1–7,
  then exposed an OpenClaw smoke compatibility error: the guarded runner kept
  the prepare command's exact missing-auth diagnostic in `stderr`, while the
  old classifier read only its now-generic `message`. The classifier now
  recognizes only that command's normal exit 1 with verified cleanup and the
  exact single diagnostic line. Timeouts, aborts, output limits, launch and
  cleanup failures, other commands, stdout and mixed or approximate messages
  remain rejected. Direct legacy missing-auth errors remain compatible;
  authentication preparation, structural checks and live behavior are unchanged.
  All 44 targeted evaluator, preparation and process-runner tests passed with
  no skips. The original public OpenClaw smoke passed in the same isolated
  home as `structural-template`, `openclaw_auth_not_configured` and
  `strictReleasePass: false`; the original evidence-pin check required no
  ledger changes. The previously unreached stage 9–17 commands then ran
  independently in order, all nine exiting 0 with original arguments and
  timeouts. Meta-theory reported 1,678 passes, 5 existing skips and no failures.
  These diagnostics used official Node 22.13.0 / npm 10.9.2 and the existing
  isolated homes and discovery-only fixtures, with no added authentication or
  model calls. The failed full attempt remains unchanged; these targeted
  results do not replace a clean, complete standard gate or certify native tasks.

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
