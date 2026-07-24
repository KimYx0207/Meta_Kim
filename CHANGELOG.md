# Changelog

> 🇨🇳 [中文版](./CHANGELOG.zh-CN.md) | English version

This file is the reader-facing release history for Meta_Kim.

The changelog explains the user-facing problem or risk each release solved, what changed to solve it, and why the change matters. It intentionally avoids long internal task ledgers, low-signal backlog ids, and implementation trivia. When exact evidence is needed, use the repository history, tests, generated reports, and PRD artifacts.

## Unreleased

## [2.9.0] - 2026-07-25

### Solved Problem

Meta_Kim's first Harness Fitness Lab could prove that its benchmark runner was honest, but two task classes hit a quality ceiling and the experiment could not isolate the cost or value of the core governance scaffold, the Review chain, and Evolution. Repeatedly making hidden tests harsher—or imposing an artificial task-time budget—would have manufactured failures instead of measuring user outcomes.

### Fixed

- **The lab now measures components without turning ceiling tasks into traps.** P-135 adds a cumulative `baseline -> slim -> reviewed -> full` ladder, three repetitions for each task/group pair, five visible requirements bound one-to-one to held-out behavior checks, an unbudgeted single-flight concurrency scenario, and a cost-only discrimination branch that is valid only when every group achieves the same perfect outcome. Cost-only evidence can prove overhead, never quality benefit.
- **Default governance depth now follows measured value.** Critical / Fetch / Thinking stay the canonical ordering and truth boundary but use concise inline records for clear low-risk local work. Review / Meta-Review run conditionally by risk, ambiguity, blast radius, failed verification, or claim strength. Evolution remains a canonical capability but leaves the default execution scaffold; without a durable learning trigger, the run closes inline with `none-with-reason` instead of dispatching Evolution work.
- **Fitness trials can genuinely resume after a crash.** Trial results now retain a stable provider identity separately from structured provider evidence, legacy results are inferred safely, and the formal-result pointer is excluded from the immutable contract-definition digest. Restarting the same formal run reused all 36 completed trials without another provider invocation.

### Verification

- The native Windows/Codex formal matrix completed 36/36 live trials with complete JSONL trajectories and product-evidence eligibility; all four groups achieved 9/9 and 5/5, so no governance component is credited with a quality gain.
- Core governance measured 1.201× token and 1.354× wall-clock cost versus baseline and is conditional; Review measured 1.029× token and 0.971× time versus slim and is conditional; Evolution measured 1.525× token and 1.289× time versus reviewed and is removed from the default scaffold.
- No Docker, WSL, task budget, elevated access, or sandbox bypass contributed to acceptance. Fixture runs and the stopped 2/12 budget experiment remain diagnostic-only and cannot satisfy product evidence.

## [2.8.93] - 2026-07-24

### Solved Problem

Meta_Kim had extensive governance structure but no controlled experiment showing whether that structure improved real outcomes. Its earlier Windows Codex pilot also mistook a headless approval-policy override for a platform-wide read-only limitation, which blocked real product evidence and encouraged an invalid Docker substitute.

### Fixed

- **Harness Fitness Lab now measures outcome truth instead of packet completeness.** A Codex-native runner executes a seeded 3-task × 3-group × 3-trial matrix with isolated committed workspaces, held-out environment tests, anonymized quality scoring, complete JSONL trajectories, token/tool/rework/wall-clock metrics, immutable resumable trial results, and explicit diagnostic-versus-product evidence boundaries.
- **Native Windows trials use Codex's supported permission path.** Standalone runs bind `:workspace` permissions to `on-request` plus the native auto-reviewer, use one external Git workspace root, and reject managed Codex Desktop nesting. Docker, fixtures, planned runs, elevated access, and sandbox bypasses cannot satisfy product acceptance.
- **The first result is preserved as a real negative fitness decision.** All 27 native trials completed: full governance succeeded 9/9 versus 8/9 for baseline and Review ablation, within the 1.5× cost budget, but only fuzzy product work improved materially. The general 2-of-3 fitness gate therefore remains failed, Review has no demonstrated independent benefit, and the next governed item is benchmark de-ceiling plus governance slimming—not another framework layer.

### Verification

- The standalone native Windows pilot completed real file changes plus public and held-out tests without Docker or unsafe permissions.
- The formal matrix completed 27/27 live Codex trials with product-evidence eligibility and retained `criteriaPass=false` rather than promoting a convenient result.
- Contract, planner, provider argument safety, scoring, failure-denominator, partial-pilot, package-surface, unique-PRD, Graphify, projection, setup, Meta-Theory, integration, and packed release paths are required to pass before publication.

## [2.8.92] - 2026-07-24

### Solved Problem

The standard release path could report success after a smoke evaluator exited cleanly even when its own evidence said the runtime was projection-only and not release-grade. Claude discovery also confused the Agent View command with custom-agent definitions, while Codex could satisfy the live evaluator with model-authored JSON or timeout recovery without proving that a real child Agent completed. This made the release claim stronger than the underlying Claude Code and Codex evidence.

### Fixed

- **Standard releases now have one dual-primary runtime fuse.** The release evaluator fixes its scope to Claude Code and Codex, requires the complete nine-agent structural inventory, and permits release-grade only after one real host invocation succeeds in each primary runtime. Smoke, canonical fallback, fixtures, model-authored JSON, and projection-only evidence remain diagnostic and cannot open the fuse.
- **Runtime identity is reported at the level the host actually proves.** Claude custom agents are discovered from declared project/global definitions and verified through a real `claude --agent` main-session binding. Codex definitions are discovered from TOML `name` fields; when the active `spawn_agent` schema has no `agent_type`, a completed child is recorded truthfully as a run-scoped invocation rather than being mislabeled as a loaded custom agent.
- **Codex completion evidence survives incomplete CLI forwarding without trusting arbitrary files.** The evaluator first consumes native JSONL events. If Codex 0.144.x persists the completed collaboration but omits it from `exec --json`, the fallback accepts only the exact fresh exec thread and its unique child backlink from the bounded local session store. Wrong, stale, duplicate, oversized, linked, or fixture evidence fails closed, and public reports retain only IDs and digests.
- **Global updates preserve ownership truth across host normalization and regeneration.** A Claude-managed durable MCP command may be migrated after Claude wraps it with an exact Windows `cmd` launcher only when the unwrapped definition matches the recorded manifest fingerprint. Codex TOML journals now collapse exact host-restored replays and rebase regenerated host values only when the managed result is unchanged; altered commands or different results still fail closed.

### Verification

- Focused evaluator, observer, release-chain, session-correlation, path-safety, and privacy regressions passed with 77 tests and 0 failures; an independent P0/P1 review found no release-truth or disclosure blocker.
- A real primary-runtime fuse completed with both Claude Code and Codex marked `strictReleasePass=true`; Codex proved `spawn_agent -> returned_child_final` while preserving the truthful run-scoped binding boundary.
- Focused global MCP ownership, durable bundle lifecycle, Codex TOML journal, and manifest regressions passed, including real v2.8.91-to-v2.8.92 global sync and post-sync checks.
- The final release candidate is required to pass the complete packed-product, four-runtime projection/install, Graphify, setup, Meta-Theory, integration, and dual-primary runtime release suite before publication.

## [2.8.91] - 2026-07-21

### Solved Problem

Version 2.8.90 repaired the unsafe Windows Graphify command after the main setup and Graphify CLI installers ran, but two real user paths remained open. The project post-copy initializer independently runs `graphify hook install` and could recreate the same backslash command, while projects that were already broken had no supported public migration command. Editing one project's `.claude/settings.json` therefore fixed that project only; it could not safely migrate another unmanaged project, and Meta_Kim must not scan and rewrite arbitrary repositories without explicit user scope.

### Fixed

- **Every Meta_Kim-owned Graphify install path now closes the Windows shell boundary.** The post-copy initializer sanitizes the project Hook immediately after the upstream installer, and install/update refreshes sanitize explicitly selected or manifest-managed Claude project deployments. Unmanaged projects remain untouched.
- **Existing projects have a public, scoped migration command.** Run `meta-kim doctor hooks --fix` from the affected project. The stable CLI defaults to that caller project; `--project-root <dir>` selects another project explicitly, and `--all` is required before user-level settings are included.
- **Repairs are narrow and recoverable.** Only the known Windows `graphify.EXE hook-guard read|search` shell form is rewritten. Hook metadata and executable paths containing spaces are preserved, the original JSON must be backed up successfully, and the repaired file is promoted atomically. Unknown incompatible Hooks remain diagnostic-only.
- **Global Codex config recovery remains reversible after external drift.** If an active marketplace key reappears beside Meta_Kim's earlier disabled-conflict comment, the planner now collapses the adjacent duplicate into one managed comment and records an exactly invertible mutation instead of leaving global sync permanently partial.

### Verification

- Focused Hook doctor, sanitizer, public CLI, Graphify wiring, and runtime tests passed with 106 tests and 0 failures; the complete setup suite passed with 415 tests and 0 failures.
- The Codex config planner regression suite passed with 26 tests and confirmed an exact in-memory round trip against the maintainer's previously failing real config shape.
- The packed-product preflight exercised four-runtime install/update probes and a real npm package install followed by two updates successfully.
- A fresh Claude Code `Read` probe and `meta-kim doctor hooks --project-root ... --silent` both completed without Hook errors in the originally reported multimedia project.

## [2.8.90] - 2026-07-21

### Solved Problem

graphify's upstream installer writes Windows shell-form hook commands (`C:\Users\<user>\...\graphify.EXE hook-guard read`) into the project `.claude/settings.json`. Claude Code runs shell-form hooks through Git Bash, which consumes those backslashes as escapes and collapses the path to something like `C:UsersKim...graphify.EXE`, so every `Read`, `Glob`, and `Bash` tool call logged a non-blocking `command not found`. The Meta_Kim hook doctor could already diagnose this as a `windows_shell_backslash_path` incompatibility, but only as a diagnostic — the install and update flows kept regenerating the broken command, so anyone who cloned the repo on Windows hit the same noise on every fresh install.

### Fixed

- **graphify hook commands are repaired at install time, not just diagnosed.** After `graphify hook install` runs, both the setup flow (`setup.mjs`) and the `meta:graphify:install` / `meta:graphify:update` flows rewrite the Windows shell-form graphify command into the direct-spawn `command` + `args` form (for example `command: "C:\\...\\graphify.EXE"`, `args: ["hook-guard", "read"]`). Direct-spawn hooks bypass the Bash boundary, so the executable path survives verbatim. The repair is Windows-only, idempotent, writes a timestamped backup before changing anything, and only touches graphify-injected commands — unrelated user hooks are preserved for explicit review.

### Verification

- New `rewriteHookToDirectSpawn` unit tests (in `doctor-hooks`) cover drive-letter and UNC shell-form rewrites, safe-form passthrough (forward slashes, quoted, already-split `args`, bare `graphify`), non-graphify preservation, and non-win32 no-op.
- New `sanitizeGraphifyWindowsHooks` unit tests cover the file round-trip, non-win32 no-op, idempotency, backup creation, missing-file handling, non-graphify preservation, and permissions/sibling-hook preservation.
- Full `npm run meta:test:setup` passed with 409 tests, 0 failures.

## [2.8.89] - 2026-07-16

### Solved Problem

Meta-Theory had more than one component trying to decide the same route. The entry classifier identified the task, but it also decided whether a native question was allowed and whether fan-out was authorized. Those decisions could disagree with the canonical Skill, the execution selector, and the host runtime, so material choices were rarely shown while safe parallel work could still be serialized or gated by an optional orchestration Skill. Separately, a legacy Claude `PostToolUse:Write` memory Hook could fail repeatedly when a CommonJS `.js` script inherited a project's ESM package type, and Hook diagnostics could mistake an unparseable external command for a healthy or broken file target.

### Fixed

- **Entry classification is factual instead of policy-owning.** The classifier now reports the entry path and observable signals only. It no longer owns native-choice state, fan-out authorization, lane counts, or execution policy.
- **Native choice has one runtime-aware policy.** Material route, scope, risk, owner, and acceptance branches are evaluated centrally. Claude Code uses `AskUserQuestion`; Codex uses `request_user_input`. Missing, empty, rejected, or stripped native answers block or return to the responsible stage instead of silently becoming approval.
- **The core-loop contract is the single parallelism authority.** All eight stages keep ordered merge barriers while independent work inside the active stage runs as the maximal safe ready set under dependency, resource, permission, isolation, useful-work, and host-capacity constraints. Parent/child paths and unknown write scopes are treated as real collisions instead of allowing unsafe apparent fan-out.
- **Native fan-out no longer depends on `agent-teams-playbook`.** Claude Agent/Task or Codex `spawn_agent` plus the authoritative stage DAG is sufficient. The playbook remains an optional adapter and is never a prerequisite, degradation trigger, or substitute for live host invocation evidence.
- **Hook diagnosis and legacy retirement are safer.** `doctor-hooks` accepts an explicit project root, detects CommonJS `.js` targets that run inside ESM projects, and reports commands whose target cannot be parsed as `unverified` instead of guessing. Automatic repair remains limited to proven missing zombie targets; unknown or incompatible user assets are preserved for explicit review.
- **Claude global refresh can preserve an in-use durable MCP runtime.** An explicit maintenance flag refreshes the global Skill, Agents, commands, and manifest without replacing the active MCP bundle or rewriting user MCP configuration. The default synchronization behavior remains unchanged.

### Verification

- Focused choice, stage-DAG, Hook doctor, runtime projection, ownership, and governed-run regressions passed, including native-surface mismatch, empty-answer, path-collision, unknown-write-scope, and legacy Hook cases.
- The Meta-Theory suite completed with 1,188 tests: 1,183 passed, 0 failed, and 5 declared skips.
- One fresh `npm run meta:verify:all` run passed all `13/13` standard release-grade stages with `releaseGrade=true`, including four-runtime install/update probes and real packed user/project install and repeated-update acceptance.
- Project and all four user-global Meta-Theory projections were synchronized with global Hooks enabled. Claude's durable MCP bundle and registration were transactionally upgraded to `2.8.89` with a pre-write backup, without terminating Claude. Optional private-attested `live-certified` verification was not requested.

## [2.8.88] - 2026-07-16

### Solved Problem

The cross-runtime dispatch Hook still treated ordinary local file and command tools as stage-transition drivers. A user could therefore ask Meta_Kim to edit a normal business file, but the Hook would block or warn because Fetch, Thinking, or another governance stage was active—even though Agent dispatch is the behavior the Hook is meant to govern. This could create a self-lock where even the state repair command was intercepted. Separately, Claude Code on Windows can normalize Meta_Kim's exact durable MCP launch command into an equivalent `cmd /c` form. Global install and update then misclassified Meta_Kim's own entry as an unowned user collision and refused to finish the required Claude user-level installation.

### Fixed

- **Ordinary project work is no longer stage-gated by `enforce-agent-dispatch`.** Local file edits and commands now proceed without stage-based denial or warning. The Hook still governs Agent dispatch, keeps explicit query-only runs read-only, and preserves the trusted runtime-injected meta-agent read-only boundary.
- **Historical dispatch records can no longer impersonate the current caller.** A prior meta-agent entry in the dispatch chain does not turn later main-thread business edits into meta-agent mutations or produce false warnings.
- **Claude's exact Windows MCP wrapper is recognized as Meta_Kim-owned.** The installer accepts only an exact `cmd`/`cmd.exe` wrapper around the expected executable and arguments. Extra flags, changed paths, joined command strings, environment drift, and unknown lookalikes remain protected collisions.
- **Claude global install and cleanup ownership stay exact.** Check and sync preserve the equivalent wrapper, while the install manifest records the fingerprint of the definition that is actually registered. Future update and cleanup can therefore act on Meta_Kim's fragment without claiming the rest of `.claude.json`.
- **Packed lifecycle coverage now includes Claude normalization.** The packed global install test rewrites the registration into Claude's wrapper form, proves check and sync idempotence, verifies the real manifest fingerprint, and keeps unrelated user configuration untouched.

### Verification

- Focused Hook, stage-runtime, Claude global asset, and packed runtime lifecycle regressions passed, including negative collision cases and the retained meta-agent/query-only safety boundaries.
- Claude user-level Agent, Skill, Hook, settings registration, commands, durable MCP bundle, and install manifest were synchronized; the all-target global release check passed.
- One uninterrupted `npm run meta:verify:all` run passed all `13/13` standard release-grade stages with `releaseGrade=true`; Graphify freshness and diff hygiene also passed.
- Optional private-attested `live-certified` verification was not requested and remains separate from the standard release gate.

## [2.8.87] - 2026-07-15

### Solved Problem

Global runtime installation, update, and cleanup still depended on fixed assumptions about runtime profiles, historical Agent paths, package locations, and prior release versions. Those assumptions could make a valid future runtime profile fail, leave obsolete projections behind, or mistake a plausible path for an actually owned asset. Codex configuration changes were safe to retain when ownership was uncertain, but they were not yet recorded as an exact reversible delta. The bundled MCP runtime could also return structurally valid placeholder resources instead of proving that its capability matrix, Agents, and Meta-Theory guidance came from the installed package. Separately, setup and test subprocesses could pollute real user inventory state, while packed release verification still mixed repository-source evidence with installed-product truth and fixed historical baselines.

### Fixed

- **Runtime projection and migration are now source-driven.** Runtime profiles declare their own projection outputs, renderers, and retirement boundaries. Historical Agent fingerprints are generated from repository history in a canonical migration catalog instead of being maintained as fixed path or Agent lists, and unknown future profile shapes fail closed.
- **Install ownership is exact and reversible.** Manifest policy binds category, source, runtime, asset type, purpose, and path before cleanup is allowed. Codex `config.toml` changes record only the real byte-preserving mutation delta, retain comments and line endings, use atomic compare-and-swap writes, and can be inverted without removing unrelated user edits. Drift, ambiguous TOML, symlink escapes, forged purposes, and legacy command-only ownership records are preserved or blocked rather than guessed.
- **MCP runtime truth comes from the installed package.** Global sync installs a versioned durable bundle with exact package identity and layout checks. The server validates and serves the full runtime capability matrix plus canonical Agent and Meta-Theory resources from that package; transport acceptance rejects placeholder, partial, duplicated, empty, or out-of-package payloads. Runtime startup no longer depends on the source checkout, `npx`, or ambient `PATH`.
- **Discovery and local state no longer leak across runtimes or tests.** Claude and Codex share an intentional runtime-family inventory profile without colliding through incidental entrypoint names. Targeted refreshes preserve unselected runtime inventories, concurrent refreshes use locked atomic publication, Setup owns one final inventory refresh, subprocess tests use isolated user homes, and the new project-registry repair command removes only exact missing temporary-project records with dry-run and backup safeguards.
- **Global cleanup follows declared ownership instead of plausible paths.** `global_only` retirement, OpenClaw workspace selection, Memory Hook assets, durable MCP bundles, Agents, Skills, Commands, Hooks, and capability indexes all use profile- or contract-derived allowlists with most-specific matching. Unknown files, user drift, runtime-sedimented project copies, and third-party configuration remain untouched.
- **Release verification now proves the packed product dynamically.** The isolated installed tarball runs real install, update, repeated-update, project, MCP, and historical-upgrade paths. The prior stable baseline is selected from repository tags instead of a fixed version, timeouts come from a release policy contract, slow packed acceptance has its own lane, and missing history fails release-grade verification unless an explicit diagnostic-only override is used.
- **Release tests now show real progress without duplicate packed CLI work.** The Node test runner streams child output, derives fast versus subprocess-heavy setup groups from imports instead of fixed file lists, and keeps packed CLI acceptance in the release preflight rather than repeating it inside the standard setup stage.

### Verification

- Focused suites for Codex TOML planning and inversion, manifest and uninstall safety, MCP package/resource contracts, global Agent migration, project-registry isolation, setup orchestration, and packed-package boundaries passed during implementation.
- One complete `npm run meta:verify:all` run passed all `13/13` standard release-grade stages with `releaseGrade=true`, `packedProductProofComplete=true`, and a stable source snapshot. The Meta-Theory stage completed with 1,190 tests, 1,185 passed, 0 failed, and 5 skipped.
- Optional private-attested `live-certified` verification was not requested and remains separate from the standard release gate.

## [2.8.86] - 2026-07-14

### Solved Problem

Global installation and project execution had been treated as if they were the same lifecycle. This could leave users unsure why project runtime files existed after choosing a global install, while a later global update could either miss an already managed project or risk overwriting a capability that had been intentionally customized for that project. Agent, Skill, Command, MCP, Hook, and tool status also did not consistently distinguish discovery, selection, host invocation, execution, and optional external certification. Separately, Issue #48 exposed two packed-update defects: the `npx` package was validated against a maintainer-only `.gitignore`, and an approved optional MCP Memory step did not forward its scoped Claude settings authorization.

### Fixed

- **Install scope and project capability ownership are now independent.** Users can install or update globally or for a project. A global update refreshes only projects already carrying a valid Meta_Kim bootstrap manifest; it does not create new project projections. Capabilities discovered globally are used directly unless the run must create or modify them for the current project, in which case the project copy receives independent sedimented ownership and is preserved by later global operations.
- **Managed project updates preserve both freshness and user work.** Manifest-owned generated projections are backed up and replaced with the current package version, shared configuration is merged, and unknown or project-sedimented files remain untouched. Planning, writes, stale cleanup, and explicit cleanup all consult the same ownership records.
- **Governed execution records runtime truth instead of display guesses.** Capability discovery now resolves owner, Agent, Skill, Command/tool, MCP provider, Hook, and verification path before mutation. User-facing status separates selected, requested, invoked, returned, failed, and externally certified states; Codex custom Agents are claimed only when the current host and projected TOML both support them.
- **Material plan changes use a real challenge boundary.** Plan Challenge appears only when scope, risk, acceptance, or implementation shape materially branches. Understanding confirmation remains separate from execution authorization, and ordinary no-branch work is not burdened with redundant acceptance steps.
- **Issue #48's packed-update failures are fixed.** Packed installs validate shipped product artifacts rather than a source-checkout `.gitignore`. An explicit MCP Memory confirmation now grants authorization only to the selected Claude child operation; the standalone installer remains fail-closed. Global Claude and Codex settings updates also use staged, synced, atomic replacement so an interrupted write cannot truncate user JSON.
- **Release acceptance now follows the real user path.** The packed CLI exercises install and update for Claude Code, Codex, Cursor, and OpenClaw, including a historical `v2.8.85` to `v2.8.86` update, instead of relying only on repository-source execution.

### Verification

- Focused Issue #48 setup and MCP Memory tests passed `71/71`; global Hook/settings policy tests passed `19/19`, including injected replacement failures for Claude and Codex.
- Packed-product install/update acceptance covers all four declared runtimes and the previous public release baseline.
- The standard `npm run meta:verify:all` release gate passed from the final release tree with `releaseGrade=true`; optional private-attested `live-certified` verification was not requested.

## [2.8.85] - 2026-07-13

### Solved Problem

An update launched through `setup.mjs` could fail before doing any work because the parent forwarded `--lang` to every child script, including strict child CLIs that did not support it. The failure was then followed by generic EBUSY, network, and conflict guesses, so Codex and other runtime users could be told to repair Claude-specific paths even though the exact argument error was already visible. The standard release checks exercised the installer directly and therefore did not prove the real setup-to-child argument contract.

### Fixed

- **Setup now uses explicit child CLI contracts.** Install, update, and quick deploy share production argument builders; localized children receive the selected language, while strict global Meta-Theory sync receives only supported arguments. Unknown child contracts and legacy argument-array calls fail loudly instead of silently dropping language.
- **Installer language handling is complete and fail-closed.** Split and equals forms are equivalent, only supported language codes and aliases are accepted, and nested capability discovery inherits the same effective language.
- **The real parent-to-child boundary is regression-tested.** Setup's production builders generate the quick-deploy/install/update argv accepted by the real installer validator, while strict global sync is executed in isolated runtime homes and proves both language exclusion and zero writes.
- **Failure guidance is accurate across four languages.** English, Simplified Chinese, Japanese, and Korean prioritize the first exact error, make lock/network/permission/conflict advice conditional, use runtime-neutral recovery commands, and preserve useful cleanup guidance without recommending wildcard deletion of user-owned directories.
- **The selected language remains consistent through final validation.** Runtime sync, capability discovery, dependency installation, and project validation no longer switch back to the host language mid-run.

### Verification

- Focused merged setup, language, strict-parser, and UX checks passed `109/109`; a final bounded language/validation check passed `63/63`.
- The complete setup suite passed `648/649` with `0` failures and `1` expected POSIX-only skip on Windows.
- Three independent correctness, security, and UX/test reviews closed every Critical/HIGH finding; the second review reported `0` Critical and `0` HIGH.
- One complete `npm run meta:verify:all` run passed the standard release gate with `releaseGrade=true`; optional private-attested `live-certified` verification was not requested.

## [2.8.84] - 2026-07-13

### Solved Problem

Meta_Kim's install, update, and cleanup paths still had several ways to confuse "not tracked by Git" with "owned by Meta_Kim." A renamed Hook could remain as a ghost file, an already-correct managed file could be backed up and rewritten again, malformed user settings could be overwritten, and a partial cleanup or runtime mismatch could still look successful. Concurrent setup/cleanup, interrupted writes, Windows Junctions and NTFS alternate data streams also needed one shared safety boundary. At the same time, long release probes could appear stuck and important recovery guidance was not consistently available in the user's language and chat-facing status.

### Fixed

- **Managed files now use one safe transaction lifecycle.** Exact manifest and prior-hash ownership, root/Junction containment, conflict preflight, verified backups, staging, atomic commit, rollback, receipt-bound recovery journals, deterministic paths, and cross-process locks protect install, update, sync, and cleanup operations.
- **Cleanup is resumable and preserves user state.** Removed or renamed managed entries are retired only with exact ownership proof; drifted, unknown, malformed, seed-only, and user-authored files are preserved with an actionable `partial` or blocked result. Already-correct managed files are true no-ops without backup, rewrite, or mtime churn.
- **Cross-runtime checks report the real result.** Claude, Codex, Cursor, and OpenClaw Hook/config writes share the safe boundary; `global_only` validates every required Hook dependency pair, OpenClaw check mode exits nonzero on mismatch, and failed setup sync or backup work can no longer be summarized as success.
- **User guidance stays visible and localized.** Setup, cleanup, status, details, failures, choices, and recovery steps are consistent across English, Simplified Chinese, Japanese, and Korean. Redundant update confirmation was removed, while migration, safety, and next-action guidance remains available in the chat/terminal surface instead of being hidden in generated files.
- **Release evidence and Windows report writes are more reliable.** Standard verification binds the isolated four-runtime install/update probes to stable source snapshots, emits progress before long operations, and reports a recovery action on failure. Governed-run report replacement now applies a short bounded retry only to transient Windows lock errors and still fails immediately for other error classes.
- **Large setup safety policy was split into focused modules.** Managed-file transaction and project-bootstrap file-safety logic now live in narrow reusable modules instead of further expanding `setup.mjs` or duplicating call-site guards.

### Verification

- Focused governed-run surface checks passed `12/12`; the full Meta-Theory suite passed `1137/1142` with `0` failures and `5` expected conditional skips.
- The full setup suite passed `641/642` with `0` failures and `1` expected POSIX-only skip on Windows; integration checks passed `6/6`.
- Claude Code, Codex, Cursor, and OpenClaw project projections, global Meta-Theory skills/commands, and Claude/Codex global Hooks were synchronized and checked; Graphify was rebuilt and passed freshness verification.
- One complete `npm run meta:verify:all` run passed all `11/11` standard release-grade stages with `releaseGrade=true`; isolated install and update probes each verified four runtime artifacts. Optional private-attested `live-certified` verification was not requested and remains separate from the ordinary release gate.

## [2.8.83] - 2026-07-12

### Solved Problem

A stray meta-theory activation could previously treat an arbitrary working directory as a project and create `.meta-kim` or `graphify-out` state there. The initial PR fix removed that unsafe fallback, but its project-root logic was duplicated between the activation hook and post-copy initializer, accepted only a Claude-specific explicit root, and did not yet guarantee that every Claude, Codex, Cursor, global-sync, and project-bootstrap path shipped the resolver dependency with the activator. Maintainer entry documents also did not describe the new stable boundary.

### Fixed

- **Project-root resolution now has one shared implementation.** The activation hook and post-copy initializer use `project-root.mjs` instead of maintaining two copies that can drift.
- **Cross-runtime fallback is safe and ordered.** Trusted explicit declarations win first, a marker-backed cwd project wins over payload input, and only absolute marker-backed runtime payload roots may be used as a final fallback. Relative payload paths and unmarked arbitrary directories are rejected.
- **Post-copy receives the already resolved root.** The activation hook passes `--project-root` explicitly, so post-copy does not guess a second project location.
- **Every projection ships a complete dependency set.** Claude, Codex, and Cursor project hooks, global Hook packages, `setup.mjs --project-bootstrap`, package inventory, and managed cleanup include `project-root.mjs` with the activator.
- **Maintainer guides match runtime truth.** `AGENTS.md` and `CLAUDE.md` now document the resolver priority, no-write fallback, and shared dependency rule without expanding user-facing setup complexity.

### Verification

- Real subprocess tests cover arbitrary temp directories, `.git` and bootstrap markers, nested directories, invalid declarations, cross-runtime payload fields, cross-repository redirect attempts, relative payload rejection, Hook-to-post-copy argument binding, and startup from an actually generated Codex Hook directory.
- Project and global runtime projections were synchronized for Claude Code, Codex, OpenClaw, and Cursor; Claude/Codex global Hook packages were refreshed with backups.
- One complete standard release-grade verification run passed all `11/11` stages with `releaseGrade=true`; optional private-attested `live-certified` verification remains a separate, unrequested assurance layer.

## [2.8.82] - 2026-07-12

### Solved Problem

Meta_Kim could report a Codex or Claude subagent capability as unavailable even when the current chat had already shown successful native calls, because user execution truth was flattened together with exact-binding and optional external-certification state. Important run progress also remained too dependent on generated artifacts, while install/update failures, run identity, host-observer evidence, and duplicated verification paths could still produce confusing or unsafe completion claims.

### Fixed

- **User execution truth is separate from internal assurance.** Current native results now drive the chat status: completed, called, partially failed, failed, denied, blocked, genuinely unavailable, and pending are distinct. Missing exact audit association can no longer erase a successful call, and `unavailable` is reserved for an unsupported surface or missing provider with no successful or strictly failed binding.
- **Chat is the primary human-readable run surface.** Start, route, execution, review, verification, risk, owner handoff, and next action are emitted in the user's language. English, Simplified Chinese, Japanese, and Korean reports and panels avoid raw packet names, provider ids, lane enums, and certification jargon without removing useful guidance.
- **Editable artifacts cannot certify themselves.** Caller JSON, environment hints, public trust flags, UI badges, fixtures, and ordinary run files cannot mint called/completed or independent-review status. Codex/Claude host observations, content-addressed candidate bundles, pinned trust roots, and the optional private-attested verifier remain fail-closed and separate from the standard release gate.
- **Governed runs and installers fail closed.** Run ids are path-safe and collision-resistant, explicit overwrites require authorization, latest pointers are atomic, and readback is bound to the requested run. Setup aggregates deployment, MCP, Graphify, and optional-step failures so partial installation cannot report success.
- **Routing and verification are less fragile.** Natural-language classification covers multilingual UX requests without content-brand hardcoding, visible consumers read the user presentation while strict validators read the top-level audit packet, and the standard verification chain has one canonical orchestrator instead of recursively duplicating stages.

### Verification

- Project and global Meta-Theory projections were synchronized for Claude Code, Codex, OpenClaw, and Cursor; Claude/Codex global hooks were synchronized with backups.
- Graphify was rebuilt and passed freshness verification.
- One complete `npm run meta:verify:all` run passed all `11/11` standard release-grade stages with `releaseGrade=true`.
- Optional private-attested `live-certified` verification was not requested; this does not invalidate the standard release or the actual current-chat call results.

## [2.8.81] - 2026-07-12

### Solved Problem

Meta_Kim could treat a business content request as runtime-platform governance and relied on specific content-platform names in route selection, research detection, and product naming. That made a reusable governance layer behave differently just because a user named one brand. GoalPro and Kim_Decision were also installed dependencies without a clear product-facing route boundary.

### Fixed

- **Business intent is now separated from runtime-platform governance.** Runtime governance requires technical signals such as hooks, adapters, permissions, MCP, installation, or configuration; content and growth work no longer becomes a runtime route merely because it mentions a platform.
- **Removed named content-platform routing.** Product orchestration, external-research detection, release-risk recognition, and project identifiers now use general intent signals such as third-party service, current rules, publishing, authorization, or content automation instead of brand names.
- **Kim_Decision is a decision lens, not an executor.** Explicit decision requests can use it across Critical, Fetch, and Thinking to frame the problem, identify evidence, and choose a path; it cannot become an implementation worker, scheduler, or code executor.
- **GoalPro remains opt-in and prompt-only.** It is selected only for an explicit Goal Prompt, Loop Prompt, or goal-contract request; Evolution does not create user goals and a Loop starts only after a Goal result exists.
- **GoalPro and Kim_Decision are registered dependencies.** Provider, dependency, installation, compatibility, and routing records now expose their boundaries across Claude Code, Codex, Cursor, and OpenClaw.

### Verification

- Standard full release gate: `npm run meta:verify:all`.
- Focused routing, dependency, entry-classifier, governed-deliverable, and product-experience checks cover the new decision route and generic content-automation behavior.

## [2.8.80] - 2026-07-11

### Solved Problem

Meta_Kim still installed and routed the external official `skill-creator` even though the project now has an owner-maintained `meta-skill-creator`. Changing only the repository entry was not enough: Claude Code and Codex use different user skill roots, Codex also needs a compatibility copy, empty dependency selections must remain empty, existing `skill-creator` trees must stay user-owned, and a failed multi-root update must not leave only part of the replacement installed.

### Fixed

- **Meta Skill Creator is now the formal skill-creation provider.** Dependency manifests, capability registries, routing, foundational validation, and evolution guidance select `KimYx0207/meta-skill-creator` for Claude Code and Codex instead of the external official package.
- **Each runtime receives the skill through its actual discovery roots.** Claude Code installs to `~/.claude/skills`; Codex installs to `~/.agents/skills` and receives a synchronized `~/.codex/skills` compatibility copy, including when `CODEX_HOME` is customized.
- **Install and update are transactional across all three targets.** Source validation and staging finish before live replacement; commit failures roll every target back, incomplete recovery reports retained backup paths, and symlink/Junction escapes fail closed.
- **Existing `skill-creator` installations remain untouched.** Meta_Kim changes provider selection without deleting, migrating, or renaming user, compatibility, or Codex-bundled skill trees.
- **Dependency selection and CLI queries are safe.** An explicit empty `--skills` selection installs nothing, while help and unknown arguments remain zero-write.

### Verification

- Installer transaction suite: `10/10` passed; focused routing, provider, and foundational suites: `10/10` passed.
- Upstream commit `ace057d771c1baaa58811a00a2cbbdcad30d8e72` passed package and closed-loop validation; installed copies shared the exact `SKILL.md` SHA-256 `1528407a46fb3f47c035a831e91a8965f8a711f0ad6df458a7f7ef563d46d682`.
- Fresh Claude Code and Codex read-only sessions discovered and read the installed `meta-skill-creator`; legacy user, compatibility, and Codex-bundled `skill-creator` tree hashes remained unchanged.
- Standard full release gate: `npm run meta:verify:all` passed all `11/11` stages before the release metadata update; final release checks rerun the required version, package, and diff assertions.

## [2.8.79] - 2026-07-11

### Solved Problem

The install, runtime-state, Hook, capability-discovery, and release paths had accumulated duplicated implementations and unsafe edge cases. Large cleanup diffs could pass focused tests while profile state split across directories, global sync followed Windows junctions or treated a user's same-name Hook as Meta_Kim-owned, CLI help performed writes, restored design tests stayed outside the standard test chain, and package contents were not asserted by the release suite.

### Fixed

- **Runtime state now has one collision-resistant profile contract.** Application and Hook code share the same sanitizer; traversal-like, Unicode, colliding, and overlong inputs keep deterministic isolated identities, while normal profile names remain compatible. Spine, active-run, and run-status files resolve one profile even with custom state directories and concurrent writes.
- **Global sync fails closed at filesystem and ownership boundaries.** Help and unknown options are zero-write, runtime-home writes reject symlink/junction escapes, and retired Hook cleanup requires Meta_Kim ownership evidence, creates a backup, and removes only the matching managed settings entry. User-owned same-name files and settings remain untouched.
- **Hook implementations have one canonical source without erasing runtime variants.** Claude compatibility adapters project the shared implementation, capability discovery records canonical and adapter paths, and independent Claude/OpenClaw same-name Hooks retain separate namespaces instead of being collapsed by basename.
- **CLI and setup behavior is consistent from any directory.** The package CLI resolves its own scripts, setup accepts equivalent separated and equals-form value options, and empty or unknown values fail before installation work begins.
- **Data and reporting helpers are modular and transactional.** Shared project inventory, report context, memory endpoint, SQLite transaction, setup policy, and governed fan-out helpers replace repeated ad-hoc logic while preserving user-owned state and rollback boundaries.
- **Design PoC retirement is explicit and testable.** Four configuration-driven design-gate modules, their contract, and 59 tests remain packaged and covered; the unused draft validator and stale results report stay retired. The guard blocks real executable consumption without rejecting documentation or negative package assertions.
- **The standard release chain covers every test and package boundary.** Inventory classification includes unit, setup, integration, meta-theory, and design-gate suites; offline `npm pack --dry-run` assertions prove required files are included and retired files are absent.

### Verification

- Adversarial correctness, security, and completeness reviews with traversal, collision, same-name user Hook, settings ownership, and Windows junction cases.
- Focused merged repair suite: `130/130` passed before release metadata update.
- `npm run meta:test:inventory`, `npm run meta:test:unit`, and offline package-manifest assertions.
- Full four-runtime sync, Graphify rebuild, `npm run meta:verify:all`, and final package/diff checks are required on the release commit.

## [2.8.78] - 2026-07-11

### Solved Problem

The governed runner could still make orchestration look more complete than the host evidence justified. A configured provider, a callable probe, a fixture, a generic shell call, or a runner-generated result could be promoted into an invocation claim, while supposedly clean tests could still inherit real-user skills, sibling checkouts, or temporary-state residue.

### Fixed

- **Live orchestration can no longer self-certify.** Readiness probes, MCP `--self-test`, configured providers, matched hooks, fixture strings, public CLI trust flags, and runner-generated worker plans no longer count as live invocation evidence.
- **Invocation coverage is binding-level.** Every selected family/provider/task binding needs a matching externally observed host event; one family-level claim cannot cover unrelated lanes or providers.
- **Clean-room host observation is now available for Codex CLI and Claude Code.** The harness tests a packaged snapshot with isolated user/runtime/temp homes, no global inventory or sibling checkout, and a blind business prompt. Its parser can report observed behavior but cannot self-promote that report to the optional highest-assurance `live-certified` status; a separate private-attested exact-binding verifier is required only for that certification.
- **MCP has a real transport acceptance probe.** The new probe performs `initialize`, `tools/list`, and `tools/call`; catalog-only self-test output remains readiness evidence.
- **Pinned dependency fallback survives Windows Unicode archives.** Clean installs verify agent-teams-playbook v4.8.0 by commit or by GitHub archive commit prefix plus the exact Skill hash; a traversal/link-safe Python fallback handles filenames that Windows tar rejects.
- **Archive and credential handling now fail closed.** Dependency archives are size-bounded before extraction, member paths/types/counts and expanded sizes are checked before native tar runs, extraction uses isolated staging, copied Codex auth is scrubbed before any diagnostic preservation, and Windows CLI prompts no longer pass through `cmd.exe` expansion.
- **Release verification now has explicit assurance tiers.** `meta:verify:all` is the standard full release gate and a complete passing run permits an ordinary release. `meta:verify:live-certified` reruns that standard chain and appends the pinned Ed25519 external-observer gate; a resumed final stage cannot claim `live-certified`, caller-supplied keys cannot replace the trust root, and readiness probes remain separate from exact observed invocation coverage.
- **Fan-out hints no longer fabricate Fetch evidence.** Natural-language scope signals may mark a run fan-out eligible, but only real capability discovery plus Thinking-proven independent lanes can permit execution dispatch.
- **Historical examples no longer republish personal absolute paths.** Reader-facing release notes and planning-path fixtures now use portable placeholders instead of machine-specific user and project directories.

### Verification

- `node --test tests/governance/live-evidence-boundary.test.mjs`
- `node scripts/validate-product-experience-core-goals.mjs`
- `node scripts/live-acceptance/probe-mcp-transport.mjs`
- `node scripts/live-acceptance/run-clean-room-live-acceptance.mjs --preflight`
- Focused final regressions: release/evidence `16/16`, setup/archive `28/28`, and orchestration `191/191` passed.
- Standard full `meta:verify:all`: stages 1-8 passed on the final source and satisfy the ordinary release gate. The separate optional `meta:verify:live-certified` certification remains unavailable with `private_attested_exact_binding_report_missing`; this candidate must not be described as `live-certified`, but that missing external signature does not block standard tagging or publication.
- Local diagnostic negative control with concurrency hints removed: neither pure read-only control invoked Agent, Skill, MCP, or a selected Command, so the control is no longer used as fan-out acceptance. This observation is diagnostic, not `live-certified` attestation.
- Local governed-run diagnostics observed Claude Code using Agent, Skill, Hook, and runtime-tool surfaces. MCP remained callable but was not route-selected, and generic shell never became selected Command evidence. These diagnostics cannot support the optional `live-certified` label until exact selected bindings receive independent observer attestation; they are not required for the standard release tier.
- Codex CLI clean-room now blocks before host invocation when the OS-user `~/.agents/skills` root is present, because current CLI discovery still reads that real-user root despite isolated HOME/CODEX_HOME. CLI evidence remains separate from Codex Desktop.

## [2.8.77] - 2026-07-10

### Solved Problem

The current Codex host now exposes a top-level native `spawn_agent(task_name, fork_turns, message)` surface. The unreleased route still emitted the removed typed/namespaced parameter shape, so a correct owner-reuse plan could fail or render through the wrong host path. The migration also needed to prove that removing Codex-only legacy fields would not weaken Claude Code's independent native Agent/Task route.

### Changes

- **Codex now emits only the native task plan.** The route uses top-level `spawn_agent` with a sanitized `task_name`, bounded worker `message`, and minimal `fork_turns`; it no longer emits typed/namespaced fallback parameters.
- **Owner reuse remains explicit without pretending the host loaded an agent type.** `ownerAgent`, owner source, capability loadout, lane, merge owner, and visible binding stay in the worker packet/message while the runtime task name remains only a run-scoped identifier.
- **Stage-chain activation and Hook state now agree without skipping Thinking.** Structured Critical/Fetch/Thinking/Review activation sets `fanout_eligible` without requiring another parallel-agent keyword; only a Thinking result with 2+ independent worker packets, one parallel group, merge ownership, and collision boundaries can set `fan_out_ready`.
- **Claude Code support is preserved independently.** Claude Code continues to use its native Agent/Task and SubagentStart surfaces, with a matrix regression test protecting agent, subagent, and custom-agent native declarations.
- **`agent-teams-playbook` resolution no longer forces a fallback ritual.** Existing Agent/Skill/Tool/Command/MCP providers stop discovery immediately; external Skill search runs only for a proven gap, and successful native Agent dispatch is never relabeled as fallback merely because an optional Skill was not installed.
- **Dependency checkout resolution is runtime-aware.** Local development prefers the sibling upstream checkout before stale global packages, while Claude Code scans `.claude`/`~/.claude` skill roots and Codex scans `.agents`/`~/.codex` roots.

### Verification

- `node --test tests/meta-theory/01-structural.test.mjs tests/meta-theory/11-eight-stage-spine.test.mjs tests/meta-theory/47-meta-theory-entry-classifier.test.mjs tests/meta-theory/50-parallel-execution-lanes.test.mjs`
- `node --test tests/governance/capability-routing.test.mjs tests/governance/fanout-completion-gate.test.mjs tests/governance/runtime-capability-matrix.test.mjs`
- `npm run meta:route:validate`
- `npm run meta:verify:governance`
- `npm run meta:release:smoke`
- `npm run meta:check:global:release`
- `git diff --check`

## [2.8.76] - 2026-07-06

### Solved Problem

Codex could still appear to "create agents" and, more importantly, collapse a governed fan-out request into too few worker lanes when the task used whitespace-separated capability anchors or Chinese sentence punctuation instead of commas. That made global agent reuse hard to trust from the visible run.

### Changes

- **Whitespace capability anchors now split into reusable global-agent lanes.** Meta-governed Codex tasks such as platform adapter, capability ledger, route, and upload-evidence work now produce multiple worker packets instead of one broad worker.
- **Natural sentence boundaries count as lane boundaries.** Newlines and Chinese/English sentence punctuation now feed lane extraction, while duplicate anchor matches are suppressed when a natural segment already covers the capability.
- **Regression coverage now checks typed global owner reuse.** Tests assert Codex fan-out workers use existing discovered agent owners through `typed_spawn` bindings rather than invented or durable projected agents.

### Verification

- `node --test tests/meta-theory/50-parallel-execution-lanes.test.mjs tests/governance/capability-routing.test.mjs`
- `node --test tests/meta-theory/26-core-mvp-acceptance.test.mjs tests/meta-theory/30-capability-gap-complete-product.test.mjs tests/meta-theory/32-meta-theory-four-product-targets.test.mjs`
- `npm run meta:route:validate`
- `npm run meta:release:smoke`

## [2.8.75] - 2026-07-06

### Solved Problem

`2.8.74` fixed explicit "dispatch / parallel" corrections, but the design was still too narrow. Meta_Kim / `meta-theory` activation itself should authorize safe automatic fan-out when Thinking proves separable lanes. Users should not need to add another "dispatch" word, a special structured chain, or a native choice panel after already entering governed execution.

### Changes

- **Meta activation now authorizes safe fan-out.** Explicit `meta-theory`, `/meta-theory`, `元理论`, natural-language governed execution, and structured chain variants now produce `meta_theory_trigger_request` when scopes are separable, instead of waiting for a native choice surface.
- **Automatic fan-out still respects specific business routes.** Subjective UI requests keep the `subjective-ui-design-orchestration` route and its required native choices; meta activation adds fan-out metadata without stealing the route.
- **Codex route selection treats meta activation like auto fan-out.** When scopes are separable, route selection produces multiple agent-owned worker packets with typed Codex `spawn_agent` bindings and the agent-teams fan-out adapter.
- **Canonical docs now remove the false "plain meta-theory is not authorization" rule.** Native choice remains required for branch-changing route, scope, risk, or acceptance decisions, but not just to permit safe parallelism after Meta_Kim activation.

### Verification

- `node --test tests/meta-theory/47-meta-theory-entry-classifier.test.mjs tests/governance/capability-routing.test.mjs` -> 20 entry-classifier tests plus capability-routing fixtures pass.
- `npm run meta:route:validate` -> pass.
- `npm run meta:sync` -> project runtime projection manifest refreshed.
- `npm run meta:release:smoke` -> 1106 pass, 0 fail, 5 skipped; integration pass.

## [2.8.74] - 2026-07-06

### Solved Problem

After the `2.8.73` authorization split, Codex still had a practical fan-out failure: a direct correction such as "我要的是派发 / 并行" was detected as a fan-out signal, but the entry classifier could still leave it on `fast_path`. Even when a route was selected, separable Chinese scopes could collapse into one worker or bind lanes to skills instead of reusable Codex agent owners, so users saw protocol explanations instead of real parallel dispatch.

### Changes

- **Direct dispatch/parallel wording is now a governed execution entry.** Chinese corrections such as "派发" and "并行" enter the standard governed path, become fan-out eligible, and count as direct Codex subagent authorization.
- **Explicit fan-out routes now prefer agent owners.** When users ask for agent fan-out, worker lanes bind reusable Codex global/project agent owners first; skills, commands, MCP tools, and runtime tools stay as loadout or dependency bindings.
- **Chinese scoped fan-out splits correctly.** Route selection now treats Chinese commas, enumeration marks, semicolons, and colons as lane separators so prompts like "规则、runtime、测试缺口" can produce multiple worker packets.
- **Regression coverage locks the real route shape.** Tests now require direct parallel dispatch to produce multiple agent-owned worker packets with typed Codex `spawn_agent` bindings and the agent-teams fan-out adapter.

### Verification

- `node --test tests/meta-theory/47-meta-theory-entry-classifier.test.mjs tests/governance/capability-routing.test.mjs` -> 18 entry-classifier tests plus capability-routing fixtures pass.
- `npm run meta:route:validate` -> pass.
- `npm run meta:sync` -> project runtime projection manifest refreshed.
- `npm run meta:release:smoke` -> 1105 pass, 0 fail, 5 skipped; integration pass.

## [2.8.73] - 2026-07-05

### Solved Problem

`meta-theory` could enter a governed run and produce parallel worker lanes, but Codex could still execute the work serially in the main thread because the docs and tests treated a `meta-theory` trigger as if it were live `spawn_agent` authorization. In real Codex sessions this made "multi-agent orchestration" look present in protocol text while no host subagent call actually happened.

### Changes

- **Governed routing and live subagent authorization are now separate.** `meta-theory` triggers governed routing and fan-out candidacy; live Codex subagent fan-out now requires direct subagent/delegation/parallel-agent wording or a completed native choice surface.
- **Silent serial fallback is guarded.** Codex-selected `spawn_agent` lanes with zero recorded dispatches now trip the fan-out completion gate unless a valid degraded state is recorded.
- **Invocation truth has a distinct `not_authorized` state.** Capability truth packets, contracts, reports, and product-goal validation now distinguish "not authorized" from "host tool unavailable" and "blocked".
- **Codex command and runtime docs no longer overclaim `/meta-theory`.** The command adapter now says `/meta-theory` authorizes governed routing only, and live delegation still depends on explicit authorization plus a callable host tool.

### Verification

- `node --test tests/meta-theory/32-meta-theory-four-product-targets.test.mjs tests/meta-theory/34-run-deliverables.test.mjs tests/governance/fanout-completion-gate.test.mjs tests/meta-theory/47-meta-theory-entry-classifier.test.mjs` -> 48/48 pass.
- `node scripts/validate-product-experience-core-goals.mjs` -> pass; default run shows `not_authorized`, trusted self-test reaches product-experience pass.
- `node scripts/validate-runtime-matrix.mjs` -> pass.
- `npm run meta:sync -- --targets claude,codex,cursor,openclaw` -> project runtime mirrors updated.
- `npm run meta:sync:global:release` and `npm run meta:check:global:release` -> Claude Code and Codex global skills, hooks, and commands synced and checked.
- `npm run meta:check` -> pass.
- `npm run meta:release:smoke` -> 1104 pass, 0 fail, 5 skipped; integration pass.
- `npm run meta:graphify:check` -> graph matches HEAD.
- `git diff --check` -> pass.

## [2.8.72] - 2026-07-05

### Solved Problem

Codex execution dispatch still felt like it was creating new agents repeatedly instead of finding and reusing the global/project agent inventory. At the same time, Meta_Kim's observed hook mode had grown into a second high-risk keyword gate: user-explicit Git, delete, GitHub API, install, publish, and release commands could be blocked by Meta_Kim even though generic keyword safety belongs to the host/runtime safety layer, not the Meta_Kim flow gate.

### Changes

- **Codex dispatch is global-first and typed-spawn aware.** The Codex `/meta-theory` route and runtime reference now prefer discovered global/project owners, bind typed `spawn_agent` calls with `agent_type`, and keep `fork_context` only for full-context forks where no durable agent type is being requested.
- **Execution owner fallback is stricter.** Capability routing now avoids arbitrary "first candidate" ownership and records fit evidence for implementation, verification, research, provider, and test lanes before selecting an owner.
- **Observed hooks no longer duplicate keyword safety.** `enforce-agent-dispatch.mjs` removed the observed-mode command blacklist and the GitHub Git Data API release-approval side path. In observed mode, Meta_Kim no longer blocks commands by class; Review and Verification judge release truth, rollback evidence, policy adherence, and public-ready claims.
- **Meta_Kim flow gates stay intact.** Managed-stage readiness, choice/capability/owner evidence, meta-agent direct mutation boundaries, `queryBypass` mutation limits, and known unsupported runtime/OS checks still block because they are Meta_Kim flow-design concerns.

### Verification

- `npm run meta:setup:update` -> global update completed; global skills, dependencies, MCP memory hooks, and capability inventory refreshed.
- `npm run meta:sync:global:release` -> Claude Code and Codex global skills, commands, and hooks synced.
- `git fetch --tags origin` -> succeeds after global hook sync, confirming Git is no longer blocked by Meta_Kim observed hook policy.
- `node --test tests/governance/capability-routing.test.mjs tests/meta-theory/01-structural.test.mjs tests/meta-theory/11-eight-stage-spine.test.mjs` -> 199/199 pass.
- `node scripts/validate-stage-runtime-control.mjs` -> pass.
- `npm run meta:route:validate` -> pass.
- `npm run meta:release:smoke` -> 1103 pass, 0 fail, 5 skipped; integration pass.
- `npm run meta:graphify:check` -> graph matches HEAD.
- `git diff --check` -> pass.

## [2.8.71] - 2026-07-05

### Solved Problem

Windows installs and release checks could show Node's `[DEP0190]` warning because setup, global dependency installation, release verification, and OS probing still had child-process paths that combined argument arrays with shell execution. At the same time, the Codex fan-out path still had practical failure edges: execution routing could fall back to an arbitrary first agent, Codex `spawn_agent` fork mode could mix `fork_context: true` with `agent_type`, and the shared spine-state helper was not projected everywhere that imported it.

### Changes

- **Install and release commands no longer trigger DEP0190.** `setup.mjs`, `scripts/install-global-skills-all-runtimes.mjs`, `scripts/run-verify-all.mjs`, and `scripts/governance-lib.mjs` now avoid Node's `shell: true` + args warning path while preserving Windows `.cmd` compatibility through explicit `cmd.exe /d /s /c` handoff where needed.
- **Execution owner selection avoids arbitrary fallback.** `scripts/select-execution-route.mjs` now evaluates the full existing execution-owner inventory with semantic preference groups for test, verification, provider, research, and implementation work, returning `null` instead of guessing when no fit exists.
- **Codex fork rules are Codex-only.** The Codex command adapter and runtime reference now document that full-context forks use `fork_context: true` without `agent_type`, while typed spawns use `agent_type` without full-context fork. Structural coverage prevents this Codex-specific rule from leaking into shared, Claude, Cursor, or OpenClaw surfaces.
- **Shared spine-state imports resolve across projected hook targets.** `spine-state-utils.mjs` is included in project and global Codex/Cursor hook copy paths and their sync/discovery tests, matching the shared `spine-state.mjs` import graph.

### Verification

- `node --trace-deprecation setup.mjs --check --silent` -> no DEP0190 warning.
- `node --trace-deprecation scripts/install-global-skills-all-runtimes.mjs --dry-run --plugins-only --targets claude` -> no DEP0190 warning.
- `NODE_OPTIONS=--trace-deprecation node scripts/run-verify-all.mjs` -> 8/8 stages pass, no DEP0190 warning.
- `node scripts/probe-os-compatibility.mjs --check` -> pass.
- `npm run meta:test:setup` -> 504/504 pass.
- `npm run meta:test:meta-theory` -> 1104 pass, 0 fail, 5 skipped.
- `npm run meta:route:validate` -> pass.
- `node --test tests/meta-theory/01-structural.test.mjs` -> 63/63 pass.
- `npm run meta:prompt:validate` -> pass.
- `git diff --check` -> pass.

## [2.8.70] - 2026-07-05

### Solved Problem

Users wanted Claude Code and Codex to both support a "fan-out / team" workflow — main agent spawns multiple sub-agents in parallel — but Meta_Kim's trigger and dispatch gates made the flow impossible to actually run. `activate-meta-theory-spine.mjs` only matched on `meta-theory` / `critical + fetch + thinking + review` / `元理论`, so a request like "开 3 个 agent 扫全量发布差距" never entered the multi-agent path. Once entered, `enforce-agent-dispatch.mjs` denied any `Agent` / `spawn_agent` call in execution / review / meta_review / verification / evolution unless `fetchRecord.capabilitySearchPerformed === true`, and that flag was never auto-set, so the main thread got stuck. `spine-state.mjs` also wrote the JSON state file directly, racing when fan-out forked multiple agents that each transitioned the same run. None of this had a documented hook for `team` / `fan-out` / `军团` / `并行` keywords, no agent eligibility tier, no atomic state transition, and no auto-progress from `critical` to `fetch` once a multi-agent run was actually requested.

### Changes

- **Multi-agent trigger keywords + auto capability search + stage pre-progression.** `canonical/runtime-assets/shared/hooks/activate-meta-theory-spine.mjs` (and its `claude` mirror) now matches `team` / `fan-out` / `multi-agent` / `agent teams` / `军团` / `分队` / `并行` / `并发` / `多 agent` / `开 N 个`. On hit it auto-runs a capability search that reads `config/capability-index/agent-eligibility.json` plus `canonical/agents/`, populates `fetchRecord.capabilitySearchPerformed = true` + `capabilityMatches`, pre-progresses `currentStage` from `critical` to `fetch`, and records `linkedCommands` / `linkedSkills` / `dispatchMode = "fan_out_ready"` so the main thread can fork immediately.
- **Capability gate exemption for fan-out runs.** `canonical/runtime-assets/claude/hooks/enforce-agent-dispatch.mjs` (projected to `.codex/hooks/` and `.cursor/hooks/`) treats `stageRuntimeControl.dispatchMode ∈ {fan_out_ready, fan_out_in_progress}` as a discovery-equivalent stage for the capability gate, so an Agent / `spawn_agent` dispatch during a multi-agent run no longer denies on missing `capabilitySearchPerformed`.
- **Three-tier agent eligibility registry.** `config/capability-index/agent-eligibility.json` enumerates `eligible` (the nine meta-* agents with role + owns[]), `conditional`, and `hard_reject` tiers with rejection-reason strings, so capability search returns a single verdict per agent rather than free-form ownerCandidates.
- **Atomic spine-state writes with file lock.** `canonical/runtime-assets/shared/hooks/spine-state-utils.mjs` provides `atomicWriteJson` (temp-file + rename) and `withFileLock` (`open` + `wx` + jittered retry). `spine-state.mjs` `writeSpineState` now wraps both, so concurrent fan-out agents cannot corrupt the run JSON.
- **Command + skill auto-link on multi-agent trigger.** Triggered runs extract `/slash-command` names and `skill:xxx` references from the prompt into `stageRuntimeControl.linkedCommands` / `linkedSkills`, so the dispatch board can show what each lane should load.

### Verification

- `node --check` on all touched canonical sources → SYNTAX OK.
- `npm run meta:validate` → 7/7 pass.
- `node --test tests/setup/graphify-wiring-contract.test.mjs tests/setup/sync-runtimes-manifest.test.mjs` → 71/71 pass.
- `npm run meta:check:runtimes` → runtime mirrors up to date across Claude Code + Codex + Cursor.
- `npm run meta:sync` → 2 files updated in `.claude/hooks/`, then mirrored to `.codex/` + `.cursor/`.

## [2.8.69] - 2026-07-05

### Solved Problem

Open-source users who installed Meta_Kim and then ran the spine hook in a different project or on a different machine hit a silent dead path. `setup.mjs` and `sync-runtimes.mjs` render the canonical `__REPO_ROOT__` placeholder into an absolute path at install time, so the `--package-root <absolute-path>` argument baked into global and project hook registrations pointed at a directory that did not exist on the user's machine. The spine activator swallowed the mismatch silently (EXIT=0), so `startPostCopyAutoInit` never found `scripts/project-post-copy-init.mjs` and the global post-copy initializer was unreachable for anyone who was not the original author.

### Changes

- **Spine activator resolves the package root at runtime instead of trusting the baked-in path.** `canonical/runtime-assets/claude/hooks/activate-meta-theory-spine.mjs` and `canonical/runtime-assets/shared/hooks/activate-meta-theory-spine.mjs` add `resolvePackageRoot(candidate)`. If the `--package-root` argument or `META_KIM_PACKAGE_ROOT` env var points at a directory that actually exists, it is used as-is; otherwise the script walks up from its own location (`import.meta.url`) until it finds a directory containing `scripts/project-post-copy-init.mjs`, and falls back to `null` only when no Meta_Kim root is reachable. The `.claude/hooks`, `.codex/hooks`, and `.cursor/hooks` mirrors and the global `~/.claude/hooks/meta-kim` and `~/.codex/hooks/meta-kim` copies all carry the same resolver.

### Verification

- `node --check` on both canonical sources → SYNTAX OK.
- `npm run meta:validate` → 7/7 pass.
- `node --test tests/setup/graphify-wiring-contract.test.mjs tests/setup/sync-runtimes-manifest.test.mjs` → 71/71 pass.
- `npm run meta:check:runtimes` → runtime mirrors up to date.
- `npm run meta:sync:global:release` → Claude Code and Codex global hooks/skills/commands synced; `resolvePackageRoot` present in both `~/.claude/hooks/meta-kim/activate-meta-theory-spine.mjs` and `~/.codex/hooks/meta-kim/activate-meta-theory-spine.mjs`.

## [2.8.68] - 2026-07-04

### Solved Problem

Codex users could see multiple Meta_Kim entries for the same governed route after installing or upgrading across several historical releases. Old global skill aliases such as `meta_kim`, legacy report/verify commands, agent-calling-gap notes, and `critical/fetch/thinking/review` route aliases could remain in `~/.agents`, `~/.codex`, or `~/.claude`, so `/meta` surfaced several confusing choices instead of one canonical `meta-theory` entry. During release verification, `npm run meta:graphify:rebuild` could also fail after source changes because Graphify refused to overwrite a smaller regenerated graph, leaving `meta:graphify:check` stale even when the rebuild was intentional.

### Changes

- **Global sync now removes stale Meta_Kim skill aliases safely.** `scripts/sync-global-meta-theory.mjs` checks known legacy alias directories by content signature, backs them up under `.meta-kim/backups/stale-skill-aliases`, and removes only Meta_Kim-managed stale aliases. User-created skills with similar names are preserved.
- **Codex shared skill cleanup is covered.** The sync path now checks the legacy shared `~/.agents/skills` root when Codex is selected, including the old duplicate `meta-theory` mirror once the canonical `~/.codex/skills/meta-theory` exists.
- **Graphify rebuild recovers from the smaller-graph guard.** `scripts/graphify-cli.mjs rebuild` now detects Graphify's specific "Refusing to overwrite" guard, retries with `--force`, and stamps the rebuilt graph to the current HEAD. The wrapper also supports `META_KIM_GRAPHIFY_BIN` and `META_KIM_GRAPHIFY_BIN_ARGS` for deterministic tests and diagnostics.
- **Capability discovery language flags work.** `discover-global-capabilities.mjs` now honors short language flags such as `--zh`, `--en`, `--ja`, and `--ko`, matching the existing test and CLI expectation.

### Verification

- `npm run meta:graphify:rebuild` recovered from the smaller graph guard and stamped the graph to HEAD.
- `npm run meta:graphify:check` → graph matches the current HEAD after rebuild.
- `node --test tests/setup/graphify-wiring-contract.test.mjs tests/setup/sync-global-hooks-policy.test.mjs` → 41/41 pass.
- `npm run meta:release:smoke` → 1108 tests, 1103 pass, 0 fail, 5 skipped; integration 6/6 pass.
- `git diff --check` → pass.

## [2.8.67] - 2026-07-04

### Solved Problem

`npm run meta:check` 对 `projectProjectionMode: global_only` 的项目会在第一步静默放过——`meta:check:runtimes` 默认什么 target 都不传,直接拿到一个"工具端镜像已是最新"的绿灯,其实啥也没对比。这条路径上的项目看上去是健康的,但实际从未走过 `claude` / `codex` 项目投影的对照检查。

### Changes

- **`meta:check:runtimes` 默认显式选 target。** `package.json` 里这条 script 现在固定传 `--scope project --targets claude,codex`。对 global_only 项目,跑 `npm run meta:check` 会真的去对比两边镜像,silent skip 不再发生。

### Verification

- `npm run meta:check` 退出码 0,7/7 通过
- `npm run meta:graphify:check` 报 `graphify graph matches HEAD a6dc5734`(rebuild 后)
- `npm run meta:doctor:governance` 报 `run index ready`(rebuild 后)

## [2.8.66] - 2026-07-04

### Solved Problem

Open-source users running `meta-kim` had no way to know the runtime projection was actually healthy. `meta:check:runtimes` returned "工具端镜像已是最新" even when no runtime target was selected — `global_only` projects hit a silent skip, got no warning, and looked like sync worked when it had not. On a different lane, every `weapon-registry.json` owner was governance-layer (`meta-*`), but `select-execution-route.mjs` filter-stripped `layer === "meta"` from `candidateExecutionAgents`, so every weapon's `ownerCandidates` always missed the available set and all six routes were blocked — `fuzzy_strategy` tasks emitted `capabilityGapPacket` even though the right governance owners were sitting right there. A third class lived in tests written before v2.8.61's i18n extraction refactor moved all localized prompts into `config/i18n/setup-strings.mjs`: three setup tests (`i18n`, `mcp-memory-hooks`, `setup-update-default-flow`) still called `readFileSync("setup.mjs")` and asserted literal Chinese / Japanese / Korean phrases — the strings moved but the tests did not, so 28 setup tests reported stale i18n coverage that had been complete since the refactor.

### Changes

- **`sync-runtimes.mjs` no longer lies when there is nothing to check.** The `check` branch now distinguishes "no runtime target selected because `global_only`" from "all selected runtimes up to date." With no `--targets` argument and `projectProjectionMode: global_only`, the script prints an explicit "未选定 runtime target — 未检查任何镜像" message and the suggested `--targets claude,codex` command instead of a green "最新" stamp that implies work was done.
- **`select-execution-route.mjs` accepts governance owners for governance work without allowing them as implementation workers.** The `routeForWeapon` available set now unions `ownerDiscoveryPacket.candidateExistingExecutionOwners` with `governanceStageOwners` whenever the task shape is not `engineering_execution`. The `engineering_execution` arm keeps the existing execution-only filter, so the `meta-*` agents can satisfy `meta-kim-decision-patterns` / `runtime-capability-matrix` routing while still being blocked from becoming implementation workers.
- **`build-capability-inventory.mjs` no longer collapses the global inventory to meta-only.** The `global-capabilities.json` cache now emits every agent the global plugin installs, not only `meta-*` ones; each record's `ownerCandidates` is the actual agent id (instead of a `["meta-artisan"]` fallback for non-meta agents). `selectExecutionOwner` was rewritten to fuzzy-match preference-group terms against the available owner ids, so "test" / "smoke" / "verify" style tasks in a global-only project land on `test-automator` / `e2e-runner` style real agents instead of an empty `available` set.
- **Setup tests follow the i18n extraction.** `tests/setup/i18n.test.mjs`, `tests/setup/mcp-memory-hooks.test.mjs`, and `tests/setup/setup-update-default-flow.test.mjs` now read from `config/i18n/setup-strings.mjs` (or use `readRepoFile`) for any literal localized assertion. `setup.mjs` exports the i18n block via `buildI18N({ MIN_NODE_VERSION })`; tests stay aligned with the actual source-of-truth after the v2.8.61 refactor.
- **`sync-runtimes.mjs` no longer writes a 1.7 MB full JSON dump to stdout.** The CLI entry now prints a one-line summary (`capability inventory written: N records (projectProjectionMode=...)`). Tests that `spawnSync` the script (e.g. `capability-inventory-bus.test.mjs`) no longer hit Node's default 1 MB `maxBuffer` ceiling and falsely report `result.status = null`.
- **Stable spine-state projection for hook imports.** The single-`shared` strategy from earlier in this work stream was over-eager — multiple `claude/hooks/*.mjs` files (`stop-compaction`, `stop-spine-cleanup`, `enforce-agent-dispatch`, ...) `import "./spine-state.mjs"` relative to their own directory. `canonical/runtime-assets/claude/hooks/spine-state.mjs` and `shared/hooks/spine-state.mjs` are both kept in sync (verified identical bytes), `activate-meta-theory-spine.mjs` and `skip-reminder.mjs` likewise stay in both places. `PROJECT_CLAUDE_HOOK_FILES` keeps `spine-state` so the universal loop still emits the Claude-side copy; the codex projection now comes only from the codex-specific block. Hooks that `import "./spine-state.mjs"` continue to resolve.

### Verification

- `npm run meta:verify:all` → 1108 tests, 1103 pass, 0 fail, 5 skipped. All 8 steps green.
- `npm run meta:check:runtimes -- --scope project --targets claude,codex` → "工具端镜像已是最新".
- `npm install @inquirer/prompts` (env refresh) + `npm run meta:test:setup` → 502/0.
- Manual `node scripts/select-execution-route.mjs --task "<fuzzy strategy>"` → produces `recommendedRoute` with `meta-kim-decision-patterns` worker selection.

## [2.8.65] - 2026-07-03

### Solved Problem

The `enforce-agent-dispatch` fan-out gate tried to force the main thread to dispatch a Claude Code `Agent` before mutating files, but the gate ran inside a Node hook while the real dispatch must happen on the host side. The runner also declared that live subagent claims required an external host spawn, yet never wrote the worker lanes into spine state, so the gate never fired and the main thread kept self-executing. Each prior patch added another soft constraint; the underlying design fought the host's native fan-out ability.

### Changes

- **Removed the fan-out gate from `enforce-agent-dispatch.mjs`** — host-native `Agent` / `spawn_agent` is now the orchestrator; the hook no longer denies main-thread mutation for lack of Agent dispatch.
- **Preserved the degraded-declaration guard as an independent check** — a run that claims `degradedMode: true` still needs `fetchRecord.capabilitySearchPerformed` plus at least 3 `capabilityMatches`, otherwise the hook denies.
- **Softened `runtimeInvocationBoundary` in the runner** — the Node runner records evidence and suggests lanes; it no longer claims to enforce host dispatch.
- **Claude / Codex command adapters switched from `DISPATCH IS MANDATORY` to `HOST-NATIVE FAN-OUT PREFERRED`**, and the Codex adapter now recommends a named subagent over a fork when the worker lane needs its own agent type.
- **`validateDegradedDeclaration` is now exported from `shared/hooks/spine-state.mjs`** (it was only in the Claude copy), fixing the 44-test regression where the hook import failed under `runEnforceHook`.
- **`tests/governance/degraded-declaration-guard.test.mjs`** added (11 cases) and `tests/meta-theory/01-structural.test.mjs` updated to match the new command wording.

### Verification

- `npm run meta:release:smoke` → 1108 tests, 1103 pass, 0 fail, 5 skipped.
- `npm run meta:test:governance` → 87/87 pass.

## [2.8.64] - 2026-07-02

### Solved Problem

Three related root causes kept the "fan-out does not happen" problem recurring across releases even though the project had shipped a fan-out gate in earlier patches: (1) `enforce-agent-dispatch.mjs` detected the main thread self-executing with zero Agent dispatches in the Execution stage but only emitted a `process.stderr.write` warn and let the self-execution continue — a soft constraint that explained the "main thread self-executes anyway" symptom; (2) `scripts/sync-runtimes.mjs` skipped canonical hook projection to runtime mirrors whenever `local.overrides.json` had `projectProjectionMode: "global_only"` (because that mode forces `selectedTargets = []`, so the per-runtime `syncClaudeProjection` was never called), so any new canonical hook changes silently drifted out of sync until a manual `cp`; (3) `setup.mjs` made global hook projection opt-in (`--with-global-hooks`) on fresh install, so `npx meta-kim` first-time installers never received new governance surface from later releases until they re-ran setup explicitly. Each was a separate mechanism defect, not a documentation issue; fixing only one would have re-recured the user-visible symptom.

### Changes

- **Execution-stage fan-out gate is now a real block, not a warn** — `enforce-agent-dispatch.mjs` replaces the long-standing warn-only path at the Execution stage with a call to a new pure function `evaluateFanoutGate(state)` (in `spine-state.mjs`) followed by `META_KIM_FANOUT_GATE` (block | warn | progressive | off, default `progressive` with 7-day grace). When the run is a real fan-out run (≥2 worker packets, 0 recorded Agent dispatches, not explicitly `degradedMode: true`), the gate denies the next mutation with `META_KIM_FANOUT_GATE effective mode` reported; the only legitimate way out is to dispatch an Agent or write `degradedMode: true` into spine state. Single-lane work (`workerTaskPackets.length < 2`) is exempt so Codex / Cursor / OpenClaw dispatch-event coverage differences do not block legitimate single-owner runs.
- **New pure function `evaluateFanoutGate(state)` in `spine-state.mjs`** — returns `{ triggered, dispatched, workerCount, stage, degraded, reason }`. Shared across runtime hooks and unit-tested directly without needing to spawn the full PreToolUse hook. The reason text is the human-readable explanation attached to every deny / warn event.
- **Regression coverage in `tests/governance/fanout-completion-gate.test.mjs`** — 6 cases pin: triggered (execution + 0 dispatch + ≥2 worker + not degraded), not triggered when an Agent dispatch is recorded, not triggered when `degradedMode: true`, not triggered for single-lane work (`<2` worker packets), not triggered outside the Execution stage, and null-safe (no throw on missing / empty state).
- **Root-cause fix for `meta:sync` silently skipping hook projection under `global_only`** — `scripts/sync-runtimes.mjs` now has a main-scope block (gated by `scope !== "global"`) that projects the canonical `claude/hooks/*` (intersected with `PROJECT_CLAUDE_HOOK_FILES` and the shared-hook dependencies `activate-meta-theory-spine.mjs` + `skip-reminder.mjs`) to `.claude/hooks/`, `.codex/hooks/`, and `.cursor/hooks/` unconditionally. The block also performs the same `REMOVED_PROJECT_CLAUDE_HOOK_FILES` cleanup in all three runtime mirrors, so legacy hooks do not leak back after rename or removal.
- **Root-cause fix for `npx meta-kim` first-time install silently skipping global hooks** — `setup.mjs` redefines `setupWithGlobalHooks` so fresh install (`npx meta-kim`, `node setup.mjs` without `--update`) defaults to installing global hooks. `--update` remains opt-in (avoid overwriting hand-edited hooks between releases). Explicit `--with-global-hooks` (force on, even during update) and `--without-global-hooks` (force off, even during install) override either default. This means downstream users upgrading to this release get the fan-out gate in their global hook surface without any extra flag.

### Verification

- `node --test tests/governance/fanout-completion-gate.test.mjs` → 6 pass / 0 fail.
- `npm run meta:test:governance` → 76 pass / 0 fail (no regression in any existing test).
- `npm run meta:check` → 7/7 pass, including `meta:open-source-boundary:validate` (canonical-only `package.json` `files` whitelist is intact; no per-runtime mirror or test fixture leaked into the publish set).
- **Reverse-test for `meta:sync`**: corrupted `.claude/hooks/enforce-agent-dispatch.mjs` by removing the `evaluateFanoutGate` block (3 → 2 matches), then ran `npm run meta:sync`; output reported "已更新 2 个文件" / "已更新 10 个文件" / "已更新 10 个文件" and the mirror recovered to 3 matches. Canonical unchanged (diff clean), `.codex` and `.cursor` mirrors also restored.
- Real-machine run on Windows + Node 22.16.0: `npm run meta:setup:check` and `npm run meta:setup:update` both pass. The `Skipped global hooks (opt in with --with-global-hooks)` notice still appears for `setup.mjs --update` (correct opt-in behaviour preserved); the new default will apply on the next `npx meta-kim` install.

## [2.8.63] - 2026-06-30

### Solved Problem

The 8-stage spine gate had a stage-key drift: `enforce-agent-dispatch.mjs` used `meta_review` (underscore) in its local stage order while `spine-state.mjs` and the canonical labels used `meta-review` (hyphen), so `indexOf` silently failed at the Meta-Review stage. The Fetch stage also lacked the symmetric business-mutation deny branch that Critical had, so `npm install` and business-file writes were not blocked before `fetchRecord` was committed. Separately, the SubagentStart hook fired for every spawned agent (`matcher: "*"`), the MCP-memory installer wrote to the user-global `~/.claude/settings.json` without consent, there was no single command to sync global hooks, and the new `global-owner-discovery.md` reference missed the standard section structure the prompt-executability validator requires — which broke the product-experience test chain.

### Changes

- Unified the stage key to `meta-review` across `enforce-agent-dispatch.mjs`, `spine-state.mjs` (claude + shared sources), and every runtime projection (`.claude` / `.codex` / `.cursor` plus the global `~/.claude/hooks/meta-kim` and `~/.codex/hooks/meta-kim` packages), so the Meta-Review gate resolves correctly on every platform.
- Added a Fetch-stage business-mutation deny branch symmetric to the existing Critical branch, so capability discovery must commit `fetchRecord` before any business-file write or package install.
- Narrowed the SubagentStart hook matcher from `*` to `meta-*` in the Claude and Codex projections, so context injection targets only meta-governance subagents.
- Added a `META_KIM_CONFIRM_GLOBAL` consent gate to `install-mcp-memory-hooks.mjs`, so user-global `~/.claude/settings.json` is no longer mutated without an explicit flag.
- Added the `meta:sync:global:release` npm script (mirrors `meta:check:global:release`) as the single command that syncs global skill + commands + hooks + settings in one step.
- Added `canonical/skills/meta-theory/references/global-owner-discovery.md` with the full 12-section reference structure, and linked it from `SKILL.md` and `dev-governance.md`.

## [2.8.62] - 2026-06-29

### Solved Problem

`scripts/discover-global-capabilities.mjs` exported its `OUTPUT_I18N` with only English and Chinese translation blocks, even though the wider project advertises `en / zh / ja / ko` as the supported language set in `setup.mjs` (`LANG_ARG_ALIASES`). Passing `--lang ja` or `--lang ko` therefore fell back to English silently, and the `Skills by family` truncation marker read `+N more` in both English and Chinese but had no Japanese or Korean translation. This was an oversight from v2.8.60 (truncation wording) and v2.8.61 (setup i18n extraction) — neither release finished the 4-language coverage.

### Changes

- **`OUTPUT_I18N` now covers all 4 supported languages** — Japanese (`ja-JP`) and Korean (`ko-KR`) blocks added with the same 16 keys as English and Chinese: title, byPlatform, hooksByCategory, skillsByFamily, detailsHidden, noMatchingCapabilities, noMatchingCapabilityType, warnings, more, none, scanning, scanningPlatform, errors, detailedInventory, governanceRules, canonicalIndexWritten, localInventoryWritten, canonicalIndexMirrored, searchIndexWritten.
- **`normalizeOutputLang` routes ja and ko prefixes to the new blocks** — `ja*` maps to `"ja-JP"`, `ko*` maps to `"ko-KR"`; previously both fell back to English.
- **Truncation wording localized** — the Japanese `more` reads `等、残り {n} 件は篇幅の都合により非表示`; the Korean `more` reads `등, 나머지 {n}개 항목은 분량상 표시되지 않음`. `{n}` is still substituted by `formatCounts`.
- **Regression coverage** — `tests/meta-theory/52-discover-i18n-truncate-format.test.mjs` adds two cases that pin (a) all four language blocks exist in the source and (b) `normalizeOutputLang` has `ja → "ja-JP"` and `ko → "ko-KR"` branches.

### Verification

- Live run: `node scripts/discover-global-capabilities.mjs --lang ja | head -5` now shows `🔍 グローバル能力をスキャン中...` and `  Claude Code をスキャン中...`; the equivalent `--lang ko` shows the Korean scan banner.
- `node --test tests/meta-theory/*.test.mjs` → 1071 pass / 0 fail.
- Other suites → 638 pass / 0 fail.
- `npm run meta:doctor:governance` → `All governance doctor checks passed`.

### Note on prior release

v2.8.60 introduced the truncation marker and v2.8.61 extracted the setup i18n block, but neither shipped 4-language coverage for `discover-global-capabilities.mjs`. v2.8.62 finishes that work. No v2.8.61 release is amended; the GitHub release for v2.8.61 is left as-is for traceability.

## [2.8.61] - 2026-06-29

### Solved Problem

`setup.mjs` had grown to 9 204 lines and embedded a 2 463-line I18N object literal (4 languages × hundreds of keys) directly inside the script. The same translation data effectively lived in two places (`scripts/meta-kim-i18n.mjs` and `setup.mjs`) and the bulk of the script file was a translation table, not orchestration logic. The setup flow's own `LANG_ARG_ALIASES` advertises `en / zh / ja / ko` as the supported language set, but the inline I18N object was the only place the strings actually lived, with no file-level test pinning the single-source-of-truth contract.

### Changes

- **I18N strings extracted to `config/i18n/setup-strings.mjs`** — the 2 463-line 4-language block now lives in its own file. The function is exposed as `export function buildI18N({ MIN_NODE_VERSION })` so the existing `(v) => ... template literals` can still reference `MIN_NODE_VERSION` via closure capture.
- **`setup.mjs` imports the strings** — the 2 463-line inline object is replaced with `import { buildI18N } from "./config/i18n/setup-strings.mjs"; const I18N = buildI18N({ MIN_NODE_VERSION });`. `setup.mjs` drops from 9 204 to 6 745 lines.
- **Single source of truth restored** — changing a translation now requires editing exactly one file. `scripts/meta-kim-i18n.mjs` continues to serve other scripts; `config/i18n/setup-strings.mjs` now serves setup.mjs.
- **Regression coverage** — `tests/meta-theory/53-setup-i18n-extracted.test.mjs` pins the single-source contract: the strings file exists and exports `buildI18N`, `setup.mjs` imports it and contains no inline `const I18N = {`, all 4 languages (`en` / `zh-CN` / `ja-JP` / `ko-KR`) are present, and `setup.mjs` shrank below 7 500 lines.

### Verification

- `node setup.mjs --help` loads cleanly through the new import + closure.
- `node --test tests/meta-theory/*.test.mjs` → 1071 pass / 0 fail (added 4 cases in suite 53).
- Other suites → 638 pass / 0 fail.
- `npm run meta:doctor:governance` → `All governance doctor checks passed`.

## [2.8.60] - 2026-06-29

### Solved Problem

`meta:deps:install` / `discover-global-capabilities.mjs` printed a Skills-by-family line that hid everything past the 8 most popular families behind a terse suffix. The English version read `+N more`, the Chinese version read `项未显示` — both easily mistaken for a missing-data warning rather than a truncation marker. The behaviour itself was not a bug (the missing families were still discoverable via `--verbose`), but the phrasing made it look like one.

### Changes

- **Default visible families raised from 8 to 20** — `formatCounts(counts, maxItems = 20, ...)` and the two `formatCounts(...)` call sites now use 20 instead of 8.
- **Truncation marker is self-describing** — both English and Chinese labels were rewritten to spell out the hidden count and the reason. English: `more, remaining {n} hidden due to length`. Chinese: `等，剩余 {n} 项因篇幅关系未显示`. The `{n}` placeholder is substituted by `formatCounts` itself.
- **Regression coverage** — `tests/meta-theory/52-discover-i18n-truncate-format.test.mjs` pins the new wording and asserts at least 10 visible families per platform before truncation.

### Verification

- Live run: `node scripts/discover-global-capabilities.mjs --zh | grep "Skills 家族统计" -A 4` shows lines like `Claude Code: vercel 4, agent-browser 1, ..., django-security 1, 等，剩余 56 项因篇幅关系未显示`.
- `node --test tests/meta-theory/*.test.mjs` → 1067 pass / 0 fail (added 3 cases in suite 52).
- Other suites → 638 pass / 0 fail.
- `npm run meta:doctor:governance` → `All governance doctor checks passed`.

### Note

This release only ships the two i18n strings that are present in the source today (`en` + `zh`). Other locales will continue to fall back to English. If a translation pass for additional languages is wanted, ship them in a follow-up release alongside a translator review.

## [2.8.59] - 2026-06-28

### Solved Problem

v2.8.58 only exposed a single owner class (execution agent). Meta_Kim actually has nine owner classes (agent / skill / MCP / command / runtime tool / hook / plugin / memory-graph / dependency), but lane resolution only searched the agent pool, so a lane that wanted a real command, MCP server, or runtime tool had to fall back to a fake agent owner. The fan-out orchestrator stayed one-dimensional: any `>=2 workers` fan-out was forced through `agent-teams-playbook` even when the lanes were skill, MCP, or command workers, which the playbook cannot dispatch.

### Changes

- **Owner resolution now covers all nine capability classes** — `findOwnerForLaneTerms` is replaced by `resolveProvider({ kind, terms })` over a typed `PROVIDER_POOL_SOURCES` map. Lanes walk the priority chain `agent → skill → mcp → command → runtimeTool → hook → plugin → memory → dependency` and adopt the first kind that yields a real provider.
- **Lanes carry an `ownerKind` field** — every parallel-execution lane now records which capability class its owner came from, so dispatchers can pick the right host tool (Task / Skill / Bash / apply_patch / MCP call etc.) instead of guessing.
- **Orchestrator-kind bucketing replaces the single-playbook gate** — `classifyOrchestratorKinds` groups lanes by owner kind and emits up to six parallel orchestrators: `agentTeamsPlaybook` (>=2 agent lanes), `skillComposition` / `mcpComposition` / `commandSequence` / `runtimeToolSequence` (other buckets reaching the >=2 threshold), plus `mixedParallelism` whenever more than one kind is present. The dispatch board reports the triggered set; `agent-teams-playbook` is no longer asked to dispatch non-agent lanes.
- **Worker packets propagate `ownerKind` and `orchestratorKinds`** — `run-meta-theory-governed-execution.mjs` copies `ownerKind` through every `workerTaskPacket`, so the host dispatcher can drive each lane with the matching tool.
- **Regression coverage** — `tests/meta-theory/50-parallel-execution-lanes.test.mjs` now asserts by `ownerKind` bucket and `tests/meta-theory/51-orchestrator-kind-bucketing.test.mjs` pins the orchestrator-kind trigger logic.

### Verification

- Live run: `node scripts/run-meta-theory-governed-execution.mjs --runtime claude_code "refactor frontend in src/ui, rebuild backend api in src/api, migrate database schema, deploy config ci"` → `orchestratorKinds: ["agentTeamsPlaybook","mixedParallelism"]`, 5 workers with `ownerKind` distribution `[agent, agent, agent, command, agent]`; the `migrate database schema` lane is now resolved to a real command provider (`package-script:migrate:meta-kim`) instead of a fake agent.
- `node --test tests/meta-theory/*.test.mjs` → 1064 pass / 0 fail.
- Other suites → 638 pass / 0 fail.
- `npm run meta:doctor:governance` → `All governance doctor checks passed`.

## [2.8.58] - 2026-06-28

### Solved Problem

Under `/meta-theory`, engineering tasks never actually selected `agent-teams-playbook` as a fan-out adapter, so the multi-worker parallel pattern was effectively dead. Route analysis kept collapsing to a single-worker fallback branch, and the playbook stayed pinned at `not_required`. At the same time, `workerTaskPacketDrafts` and the upper-layer sourceTasks only consumed `subjectiveUiCapabilityAmplification.lanes`, so engineering work had no second door into multi-lane fan-out. A separate Windows-specific bug in `meta:doctor:governance` made the governance doctor report a false-positive hook mismatch for any project whose `.claude/settings.json` carried the canonical `--runtime` flag on the dispatch-enforcement hook.

### Changes

- **Engineering tasks can split into multiple lanes** - `select-execution-route.mjs` adds `buildParallelExecutionLanes`, which temporarily recognizes independent work units from the task text (paths, explicit `lane` markers, sentence segments) and splits when two or more are present. Worker output and the dispatch board now also recognize this lane source.
- **Owners must come from runtime-scoped discovery** - `findOwnerForLaneTerms` uses the lane description as a query string and matches against `candidateExecutionAgents` `id + description + own + boundary + trigger`; a match is required, no hard-coded `frontend / backend / test / docs` shortcuts. `compactAgent` now also preserves `description / own / boundary / trigger` so semantic matching has real evidence.
- **No real owner means skip the lane, never invent one** - When a lane cannot resolve a real owner, it does not enter `workerTaskPacketDrafts`; the route gate naturally downgrades.
- **Doctor normalizeHookName is platform-correct** - `doctor-governance.mjs` now strips trailing CLI args before basename matching and removes the `.mjs` extension explicitly, so Windows `path.basename(p, ".mjs")` no longer leaks the suffix into the comparison.

### Verification

- Live run: `node scripts/run-meta-theory-governed-execution.mjs --runtime claude_code --emit-conversation-notice "refactor frontend components in src/ui, rebuild backend api routes in src/api, and migrate database schema."` shows `Agent Teams Playbook: status=pass / selected=是 / waves=1` and `Peer Agent Mesh: peers=4 / handoffs=10` with owners that are real runtime agents (`build-error-resolver / ai-engineer-* / api-documenter-* / database-admin-*`).
- Tests: `node --test tests/meta-theory/*.test.mjs` → 1058 pass / 0 fail; other suites → 638 pass / 0 fail; `npm run meta:doctor:governance` → `All governance doctor checks passed`.
- Regression coverage: new file `tests/meta-theory/50-parallel-execution-lanes.test.mjs` pins the no-fake-owner and multi-lane contract.

## [2.8.57] - 2026-06-25

### Solved Problem

Review follow-up showed the next risk was not missing more checklists, but weak default route selection: command targets, runtime proof, and user-owned state all needed the same conservative rule before Execution. When the route-critical type is unclear, Meta_Kim should degrade, block, return `null`, or keep reference-only evidence instead of guessing and relying on validators or hooks to catch it later.

### Changed

- **Type-First Route Policy** - `select-execution-route` now emits a machine-readable `typeFirstRoutePolicy` plus per-run `routeTypeClassification` covering object type, evidence type, ownership type, and conservative disposition.
- **No New Gate Contract** - Stage runtime control now references that policy as a route-selection invariant, explicitly not another acceptance gate or hook loop.
- **Executable Regression Coverage** - Capability routing validation and tests now assert that unknown object, evidence, and ownership types use conservative dispositions instead of shape-based guessing.
- **Meta-Theory Prompt Guidance** - The canonical meta-theory skill now tells Fetch and Thinking to classify route-critical types before adding checklist or validator machinery.

### Verification

- `node scripts/select-execution-route.mjs --task "missing dependency task" --runtime codex --os windows --json --compact-json`
- `npm run meta:route:validate`
- `npm run meta:prd:stage-runtime-control:validate`
- `node --test tests/governance/capability-routing.test.mjs`
- `node --test tests/meta-theory/11-eight-stage-spine.test.mjs`
- `npm run meta:release:smoke`
- `git diff --check`

## [2.8.56] - 2026-06-23

### Solved Problem

The audit found three remaining governance-runtime hazards: observed-mode hooks could still block read-only `node -e` Fetch inspections from global hook homes, runtime projection failure classes still depended on words inside human-readable prose, and Graphify could not show Meta_Kim agent-to-agent governance edges even though those edges matter for review.

### Changed

- **Observed Read-Only Node Eval Safety** - `node -e` inspections that only read/parse/print local files are now classified as read-only, while file writes, child processes, network calls, imports, and eval-like execution remain blocked.
- **Global Hook Sync Proof** - The fixed hook package was synced into local Claude Code and Codex global hook homes with `--with-global-hooks`, so the active runtime hook no longer keeps using a stale read-only whitelist.
- **Structured Runtime Failure Reasons** - Governed runtime projection evidence now records `failureReasonCode`; failure classes no longer substring-match prose such as `native` or `live`.
- **Capability Count Semantics** - The repo capability index now separates canonical inventory totals from local runtime projection actual counts, so `totalHooks` / `totalCommands` are not mistaken for mounted hook/command counts.
- **Graphify Governance Enrichment** - Graphify rebuilds now add Meta_Kim agent-governance edges and a `type` alias for `file_type`, making agent relations and node type consumers auditable.

### Verification

- `node --test tests/meta-theory/11-eight-stage-spine.test.mjs`
- `node --test tests/meta-theory/32-meta-theory-four-product-targets.test.mjs`
- `node --test tests/setup/capability-index-inheritance-chain.test.mjs`
- `node --test tests/setup/graphify-wiring-contract.test.mjs`
- `npm run meta:release:smoke`
- `npm run meta:check`
- `npm run meta:graphify:rebuild`
- `npm run meta:graphify:check`
- `git diff --check`

## [2.8.55] - 2026-06-23

### Solved Problem

The observed-mode release fix still had one text-payload edge case: PowerShell here-strings used to write release notes could contain words like `git push` or `gh release`, and the hook could still treat that release-note text as if it were a real shell command.

### Changed

- **Here-String Text Safety** - Observed-mode high-risk detection now strips PowerShell here-string bodies before matching command verbs, so release-note or search text is not mistaken for an executable publish command.
- **Executable Here-String Guard** - `Invoke-Expression` / `iex` remain high-risk, so a here-string piped into shell execution is still blocked.

### Verification

- `node --test tests/meta-theory/11-eight-stage-spine.test.mjs`
- `npm run meta:release:smoke`
- `node scripts/run-verify-all.mjs --no-report`
- `npm run meta:graphify:check`
- `git diff --check`

## [2.8.54] - 2026-06-23

### Solved Problem

Observed-mode hooks still made maintainer releases feel self-locking. After a user explicitly asked to commit, push, publish a new version, and update release notes, the same run could still block `git push` or GitHub Release commands because the hook only saw a high-risk external side effect, not the user's release authorization. The hook could also misread quoted search text such as a Graphify query containing `git push` or `gh release` as if the command itself were trying to publish.

### Changed

- **Explicit Observed Release Intent** - Prompt activation now records a short-lived, user-explicit external publish intent when the user's wording clearly asks for commit / push / release / version publication.
- **Narrow Release Allowance** - Observed mode can now allow only non-force `git push` and GitHub Release `view/create/edit/upload` commands under that intent; `npm publish`, installs, force pushes, and destructive commands remain blocked.
- **Quoted Search Safety** - Read-only search and graph queries no longer become high-risk just because the quoted search text mentions `git push` or `gh release`.
- **Global Hook Sync Proof** - The fixed hook package was synced into the local Claude Code and Codex global hook homes with `--with-global-hooks`, and release-grade global hook checks verify those files.

### Verification

- `node --check canonical/runtime-assets/claude/hooks/enforce-agent-dispatch.mjs`
- `node --check canonical/runtime-assets/claude/hooks/activate-meta-theory-spine.mjs`
- `node --check canonical/runtime-assets/shared/hooks/activate-meta-theory-spine.mjs`
- `node --test tests/meta-theory/11-eight-stage-spine.test.mjs`
- `npm run meta:prd:stage-runtime-control:validate`
- `npm run meta:sync`
- `node scripts/sync-global-meta-theory.mjs --with-global-hooks`
- `npm run meta:check`
- `npm run meta:check:global:release`
- `npm run meta:graphify:check`
- `git diff --check`

## [2.8.53] - 2026-06-23

### Solved Problem

Meta_Kim's runtime hook could still make the design-time stages feel like they required Agent dispatch. During Fetch, a real business-file write was correctly blocked, but the denial text told the operator to dispatch an Agent even though Critical, Fetch, and Thinking are allowed to proceed in the main thread. The same gate could also block Claude plan-mode updates, making `/plan` look like another forbidden business mutation.

That created the wrong repair loop: the operator needed to finish Fetch and Thinking evidence before Execution, but the hook implied the next step was mandatory Agent dispatch.

The release audit also found several first-run and maintainer-release hazards: `npx github:...` could fail before dependencies were installed, global setup could silently update user-home hook wiring, Codex/Cursor hook runtime detection still relied on path sniffing, MCP Memory failures around port `8000` and Windows Python shims were hard to diagnose, and `meta:verify:all` was still too opaque when a nested validator failed.

### Changed

- **First-Run Setup Fallback** - `setup.mjs` now falls back to numbered terminal menus when `@inquirer/prompts` is not installed yet, so a fresh GitHub/npx setup can still reach the dependency install path.
- **Global Hooks Opt-In** - Global reusable capability install no longer treats hooks as default-global. `--with-global-hooks` is now the explicit setup/sync switch for updating Claude/Codex/Cursor hook wiring, and docs/tests keep that boundary visible.
- **Explicit Hook Runtime Selection** - Generated Claude, Codex, and Cursor hook commands pass explicit runtime arguments; the canonical dispatcher still supports detection as a fallback, but normal projections no longer depend on path sniffing.
- **Capability Gate Visibility** - Progressive capability gating now exposes grace-window status in hook output, and setup tells maintainers how to choose `warn`, `block`, or `off`.
- **MCP Memory Diagnostics** - MCP Memory hooks and installer paths honor `MCP_MEMORY_URL` / `META_KIM_MEMORY_PORT`, report likely port owners when startup health checks fail, and keep Windows Python shim failures diagnosable.
- **Staged Verify Runner** - `meta:verify:all` now uses the staged runner by default, with `--json`, `--from`, report output, per-stage duration, and resumable failure context; the old one-line chain remains as `meta:verify:all:chain`.
- **State Portability Warning** - `meta:status` reports machine-portability risk for `.meta-kim/state/` so local absolute-path state is not mistaken for shareable project material.
- **Projection Tier Clarity** - Public docs now describe Claude Code and Codex as default projections while OpenClaw and Cursor remain compatibility projections that require maintainer handshake and native self-test evidence.
- **Design-Time Stage Semantics** - Critical, Fetch, and Thinking denial messages now say business mutation waits for Execution, while the main thread may continue with read/search, capability discovery, planning/control-plane updates, and spine-state packet writes.
- **Execution-Only Dispatch Requirement** - The stage runtime control contract now records that Fetch and Thinking in progress do not require Agent dispatch; execution owner/loadout and dispatch evidence remain Execution-stage gates.
- **Planning Control Plane Allowance** - Claude plan-mode surfaces, task/todo bookkeeping, `.claude/plans/*.md`, and Meta_Kim planning files can update during Fetch without a `fetchRecord`, while ordinary business files remain blocked.
- **Observed Local Publish Step** - Auto-triggered observed mode now allows local `git add` and `git commit` checkpoints and ignores risky words inside quoted search text, while continuing to block external publish/destructive commands such as `git push`, package installs, and resets.
- **Hook Payload Path Compatibility** - Hook file-path extraction now handles camelCase and target path variants so runtime planning surfaces are classified by their real target.
- **Run-Scoped Worker Execution Regression Coverage** - Eight-stage spine, setup, MCP Memory, hook-runtime, release-doc, and staged-verify tests cover the no-Agent design-stage rule, planning control-plane allowance, opt-in global hooks, explicit runtime selection, and the exact business-mutation denial wording that must not tell users to dispatch an Agent.

### Verification

- `npm run meta:prd:stage-runtime-control:validate`
- `node --test tests/meta-theory/11-eight-stage-spine.test.mjs`
- `npm run meta:sync`
- `npm run discover:global`
- `npm run meta:check`
- `npm run meta:check:global`
- `node scripts/run-verify-all.mjs --no-report`
- `git diff --check`

## [2.8.52] - 2026-06-23

### Solved Problem

After the governed-execution hardening work, Meta_Kim still needed a release pass that tied the merged cleanup back to concrete maintainer risks: maintainers should be able to run the right verification chain without relying on scattered commands, the MCP runtime server should have its required SDK declared explicitly, stale helper scripts should not look like supported public entry points, and fuzzy natural-language acceptance should not be mistaken for live Codex-native proof.

The release also needed the canonical capability index refreshed after the merged source changes, so capability discovery would describe the current source tree instead of the previous release snapshot.

### Changed

- **Staged Verification Runner** - Added the `meta:verify:stages` runner so maintainers can run or resume the release-grade verification chain by named stages from the main working tree.
- **MCP Runtime Dependency** - Declared `@modelcontextprotocol/sdk` as a package dependency so `scripts/mcp/meta-runtime-server.mjs` can self-test on a fresh install instead of depending on an undeclared local package.
- **Governed Runner Evidence Repair** - Hardened `--temp-output` coverage and capability-need reporting so generated governed-run artifacts validate while still keeping public-ready and host-invocation evidence boundaries honest.
- **Dead Script Cleanup** - Removed former cleanup/reporting scripts that no longer had source references, and documented the script-removal rule so obsolete CLIs do not become accidental public API.
- **Release Evidence Refresh** - Refreshed the canonical capability index, Graphify graph, global hooks, and release checks against the merged `main` state.

### Verification

- `node scripts/mcp/meta-runtime-server.mjs --self-test`
- `npm run meta:test:meta-theory`
- `npm run meta:release:smoke`
- `npm run meta:verify:all`
- `npm run meta:graphify:check`
- `npm run meta:check:global:release`
- Temp-output governed run with a plain fuzzy Chinese release-audit request; artifact validated, spine reached Fetch/Thinking/Review/Verification, and host evidence correctly stayed `partial`.
- `git diff --check`

## [2.8.51] - 2026-06-22

### Solved Problem

Meta_Kim could still self-lock during a governed run after entering later spine stages such as Verification. The operator could be blocked from running read-only Fetch or diagnostic commands like `git status` and `Get-Content` because the execution-tool hook checked the choice surface gate before it allowed read-only Bash inspection.

That created a governance contradiction: the run needed Fetch evidence to continue, but the hook could deny the very commands needed to collect or repair that evidence.

### Changed

- **Read-Only Inspection Before Choice Gate** - The dispatch enforcement hook now lets safe read-only Bash inspection run before `checkChoiceSurfaceGate`, preserving the ability to inspect and repair state without weakening mutation controls.
- **Mutation Still Blocked** - The same incomplete-state path still denies mutating commands such as `npm install`, so the fix restores Fetch access without turning off capability-first enforcement.
- **Verification-Stage Regression Coverage** - The eight-stage spine tests now cover the exact self-lock shape: Verification stage with incomplete choice evidence allows `git status --short` but still denies mutation.
- **Global Hook Refresh** - The fixed canonical hook was synced into the global Claude Code and Codex hook packages so the active runtime receives the same behavior as the source tree.

### Verification

- `node --test tests/meta-theory/11-eight-stage-spine.test.mjs`
- `npm run meta:sync`
- `npm run discover:global`
- `node scripts/graphify-cli.mjs rebuild --force`
- `npm run meta:graphify:check`
- `npm run meta:check`
- `node scripts/sync-global-meta-theory.mjs --with-global-hooks`
- `node scripts/sync-global-meta-theory.mjs --check --with-global-hooks`
- `npm run meta:check:global`
- `npm run meta:release:smoke`
- `git diff --check`

## [2.8.50] - 2026-06-22

### Solved Problem

Meta_Kim had enough rules, validators, and architecture language to look governed, but a maintainer still could not quickly tell which mechanisms were truly running, which ones were structural-only, and where user-visible evidence stopped. That created a product risk: Dynamic Workflow, LangGraph-style control, Graphify, MCP Memory, evolution writeback, automation, and open-source readiness could be discussed as if they were all equally proven.

The project also needed a clearer release boundary for automation. Automation should help gather evidence and reduce repeat work, but release decisions, Critical/Fetch/Thinking/Review judgment, and public-ready claims must stay human-governed and evidence-backed.

### Changed

- **Product Governance Evidence** - Governed execution now keeps automation assistance, human decision stages, self-test evidence, host/native evidence, and product-experience status in separate layers.
- **Honest Product Validator** - Product-experience validation can pass trusted self-tests without opening a native popup, while the default host/native boundary remains `partial` when live host evidence is absent.
- **Dynamic Workflow And LangGraph-Style Coverage** - Meta-theory tests now cover graph-shaped state, nodes, edges, checkpoint/replay behavior, dynamic lane binding, agent-team packet parsing, and dispatch envelope evidence.
- **Graphify Productization** - Graphify CLI support now better exposes query, path, explain, check, and rebuild flows so the graph works as a navigation and verification aid instead of a context dump.
- **Evolution Writeback Gate** - Evolution writeback now distinguishes real writeback targets from explicit `none-with-reason`, reducing the chance that a temporary record is mistaken for a sustainable learning loop.
- **Global Hooks And MCP Memory Boundaries** - Global hook sync and MCP Memory guidance now separate registration, lifecycle hooks, service health, and local memory writes more clearly.
- **Open-Source Health** - Added GitHub community health and maintenance files, including contribution, security, ownership, and dependency update surfaces, without requiring a GitHub Actions workflow.

### Verification

- `npm run meta:verify:all` before merge
- `node scripts/graphify-cli.mjs rebuild --force`
- `npm run meta:graphify:check`
- `node scripts/validate-product-experience-core-goals.mjs`
- `npm run meta:release:smoke`
- Codex App observer thread with one-sentence fuzzy release-audit prompt
- `npm run meta:capabilities:smoke`
- `npm run meta:test:meta-theory`
- `npm run meta:test:integration`
- `git diff --check`

## [2.8.49] - 2026-06-21

### Solved Problem

Codex could fail on macOS before Meta_Kim even started when the user-level `config.toml` had a malformed TOML array above `[features]`. The host error pointed at `multi_agent = true`, which made a valid Codex feature flag look wrong even though the real issue was an unclosed or comma-broken array above it.

Meta_Kim's global sync and dependency install paths also edited Codex config through line-based merges, so they needed a guard that refuses to merge into a structurally unsafe config and explains the local repair.

### Changed

- **Codex Config Merge Guard** - Codex config merge now rejects unclosed TOML arrays or inline tables before writing feature flags, App native controls, or add-only dependency config.
- **Human-Readable Diagnosis** - The error now points to the line that is still inside an unclosed TOML container, reports the opener line/column, and shows the correct `[features]` placement for `multi_agent = true`.
- **Global Check Visibility** - `meta:check:global` now reports invalid Codex `config.toml` separately instead of reducing the problem to a missing `default_mode_request_user_input` feature.
- **Regression Coverage** - Setup tests reproduce the screenshot-style `notify = [` plus `multi_agent = true` failure and keep valid multiline TOML arrays accepted.

### Verification

- `node --check scripts/codex-config-merge.mjs`
- `node --check scripts/sync-global-meta-theory.mjs`
- `node --test tests/setup/codex-config-merge.test.mjs`
- Temporary Codex home `sync-global-meta-theory.mjs --check --targets codex` invalid-config reproduction
- `npm run meta:test:setup`
- `npm run meta:check`
- `npm run meta:check:global`
- `npm run meta:release:smoke`
- `git diff --check`

## [2.8.48] - 2026-06-21

### Solved Problem

Graphify guidance could still push agents toward broad `GRAPH_REPORT.md` or graph context use, which made large projects feel too heavy and blurred the boundary between a graph navigation hint and source-backed evidence. A stale global Codex hook could also keep emitting the old short Graphify hint even after the canonical source had been updated.

Global-only installs could also show false red sync failures on macOS because `setup.mjs --check` still required project-local runtime projection files for every supported runtime instead of respecting the active global targets.

### Changed

- **Graphify Query-First Policy** - Meta-theory now treats Graphify as a navigation capability, not a context dump. Focused work should use `graphify query`, `graphify path`, or `graphify explain` to find candidate anchors.
- **Source Verification Boundary** - Graphify results are now explicitly candidate file anchors only; route-changing claims must be verified against source files, with targeted repository search as the fallback for stale, generic, or polluted graph results.
- **Hook Context Slimming** - Claude subagent and Graphify hooks now forbid injecting full `graph.json`, full `GRAPH_REPORT.md`, or broad graph dumps into worker context.
- **Sync Template Alignment** - Codex runtime sync and setup templates now carry the same query-first wording, preventing project or global sync from restoring the old guidance.
- **Global-Only Setup Check** - Setup check/update paths now respect `projectProjectionMode=global_only`; repo-local projection checks are skipped in global-only mode, and project-scope validation checks only selected active targets.
- **Global Hook Refresh** - The global Claude and Codex `meta-kim` hooks were refreshed with `--with-global-hooks` so the active runtime hint matches the canonical policy.
- **Documentation And Regression Coverage** - README/CLAUDE surfaces now describe Graphify as query/path/explain slices plus source verification, and setup tests reject the old compressed-context wording.

### Verification

- `node --test tests/setup/sync-runtimes-manifest.test.mjs`
- `node --test tests/setup/graphify-wiring-contract.test.mjs`
- `node --test tests/setup/setup-update-default-flow.test.mjs`
- `npm run meta:sync`
- `npm run meta:validate`
- `node scripts/graphify-cli.mjs rebuild --force`
- `npm run meta:graphify:check`
- `npm run discover:global`
- `npm run meta:check`
- `npm run meta:sync:global -- --with-global-hooks`
- `npm run meta:check:global -- --with-global-hooks`
- `npm run meta:release:smoke`
- Runtime Codex `rg` hook probe emitted the new query-first/source-verification Graphify hint.
- `git diff --check`

## [2.8.47] - 2026-06-21

### Solved Problem

The governed execution CLI and smoke-test path could stall or crash in Codex/Windows hosts that block nested Node child processes. That made fuzzy-instruction acceptance look broken even when the route selector and Node tests were valid.

The product-experience gate also still treated structural native-choice support as a pass. A run could prove worker packets and selected providers, but it could still over-read `selected_not_invoked`, a CLI child process, or a markdown/card artifact as real host invocation or native choice evidence.

### Changed

- **Route Selector Host Fallback** - Governed execution now falls back to an in-process route selector when `spawnSync(process.execPath, ...)` is blocked, while keeping the normal CLI path unchanged for unrestricted hosts.
- **Compact Selector Output** - Added a runner-compact selector mode so governed runs avoid oversized route payloads but still preserve selected providers, worker lanes, and owner discovery counts.
- **Eight-Stage Visible Progress** - Conversation notices and stage operation plans now surface Critical, Fetch, Thinking, Execution, Review, Meta-Review, Verification, and Evolution instead of stopping at Review.
- **Capability Smoke Host Fallback** - Capability-discovery smoke now uses the same in-process selector fallback and reports spawn errors honestly instead of writing undefined output.
- **Node Test Wrapper Fallback** - The shared Node test wrapper now has a narrow worker-backed fallback for local repo scripts when child-process execution is unavailable.
- **Trusted Host Invocation Evidence** - Governed execution now accepts trusted host evidence through CLI/env only when it includes a real family, state, provider or surface, accepted evidence kind, and non-empty evidence ref; `hostInvocationRequestPacket` must be pass before the artifact can be pass.
- **Native Choice Evidence Gate** - P-106 no longer defaults to pass from structural card evidence. Branch-changing Codex/Claude choices now stay `needs-host-invocation` until trusted `request_user_input` / `AskUserQuestion` evidence is attached.
- **No Forged Native Choice Shortcut** - `select-execution-route` no longer accepts plain `completed` / `confirmed` strings as trusted native choice proof; structured evidence now needs a native surface and evidence reference.
- **Honest Validator Summary** - The default governed-execution validator now reports `validationStatus` separately from `governedExecutionStatus`, so a valid partial run is no longer summarized as a top-level pass.

### Verification

- `node --check scripts/run-meta-theory-governed-execution.mjs scripts/select-execution-route.mjs scripts/run-capability-discovery-smoke.mjs scripts/run-node-tests.mjs scripts/meta-kim-i18n.mjs`
- `node scripts/run-meta-theory-governed-execution.mjs --task "帮我把这个系统弄得更顺、更能自动处理复杂任务，并让我看见它怎么判断、怎么分工、怎么推进、怎么验收。" --run-id codex-goal-fuzzy-acceptance --state-dir .meta-kim/state/codex-goal-fuzzy --db .meta-kim/state/codex-goal-fuzzy/runs.sqlite --emit-conversation-notice --emit-card-dealing-summary`
- `node scripts/validate-run-artifact.mjs .meta-kim/state/codex-goal-fuzzy/codex-goal-fuzzy-acceptance.json`
- `node --test --test-concurrency=1 tests/meta-theory/*.test.mjs`
- `npm run meta:test:integration`
- `node --test tests/meta-theory/32-meta-theory-four-product-targets.test.mjs`
- `node --test tests/governance/core-loop-contract.test.mjs tests/meta-theory/34-run-deliverables.test.mjs tests/governance/capability-routing.test.mjs`
- `npm run meta:prd:default-execution:validate`
- `npm run meta:prd:product-experience:validate`
- clean host-acceptance process via `Start-Process node scripts/run-meta-theory-governed-execution.mjs`, using current Codex `spawn_agent` and `request_user_input` evidence; result artifact status `pass`, `hostInvocationRequest=pass`, `realInvocationCoverage=pass`, `nativeChoiceGate=pass`, `productExperience=product_experience_pass`
- `npm run meta:release:smoke`
- `npm run meta:verify:all`
- `node scripts/graphify-cli.mjs rebuild --force`
- `npm run meta:graphify:check`
- `git diff --check`
- Release boundary retained: full verification, validators, graphify check, and clean host evidence support this patch release; all-runtime native live proof remains a separate release-grade target.

## [2.8.46] - 2026-06-21

### Solved Problem

This release fixes the boundary that made interrupted Claude Code runs look like they could continue an active Meta_Kim run when the runtime spine had already stopped. HookPrompt remains the first prompt-intake and intent-amplification layer, but its model-visible context can no longer be mistaken for Fetch, Thinking, worker, execution, verification, or public-ready evidence.

### Changed

- **HookPrompt Evidence Boundary** - Documented HookPrompt as prompt-intake context only in the meta-theory skill, abstract capability contract, and runtime safety contract; it may clarify intent, but it cannot advance stages or satisfy governance evidence.
- **HookPrompt JSONL Transcript Safety** - Stop hooks now strip HookPrompt display segments without swallowing later real transcript content when Claude stores the prompt display as a one-line JSONL record with escaped newlines.
- **Public Readiness State Split** - Separated runtime `surfaceState` (`silent` / `notice` / `decision`) from Warden-owned `publicReadinessState` (`debug-surface` / `internal-ready` / `public-ready`) so UI interaction mode can no longer masquerade as release readiness.
- **Dynamic Workflow Lane Truth** - Route-selected worker lanes now feed the business-flow blueprint directly, preserve omitted lanes with reasons, and use `meta-conductor` as the merge owner for orchestration synthesis.
- **Invocation Truth Public-Ready Gate** - Run artifact validation now rejects public-ready claims when selected executable capabilities are only selected, unavailable, blocked, missing host evidence, or inconsistent between top-level packets and `coreLoop`.
- **LangGraph-Style Runtime Boundary** - Product evidence now identifies the graph work as a LangGraph-style structural control graph without adding or claiming a real LangGraph runtime dependency.
- **Global-Only Capability Inventory** - Capability discovery can now use cached global runtime inventory in `global_only` projection mode while preserving project config records as reference-only.
- **Inactive Run Continuation Boundary** - `active-run.json` and status envelopes now expose `deactivatedAt`, `deactivationReason`, and `continuationBoundary` so `session_stop` histories are visible without being treated as active managed runs.
- **Claude Runtime Session-Stop Repair** - Claude spine activation now reads inactive spine state before starting a new observed run, records the previous stopped run when the user asks to continue, and refuses to claim the old run is still active.
- **Continuation Wording Parity** - Shared and Claude activation hooks now recognize the same broad continuation wording such as `current run`, `same run`, `当前 run`, and `同一个 run`.
- **Stop Hook Transcript Filtering** - Stop compaction and progress hooks strip HookPrompt foreground display blocks before transcript heuristics, preventing prompt-optimization text from producing false stage progress, findings, or continuation handoffs.
- **Stop Cleanup Path Safety** - `stop-spine-cleanup` now reuses the repo-local state resolver before deleting completed spine state, so an unsafe `META_KIM_SPINE_STATE_DIR` cannot delete files outside `.meta-kim/state`.
- **Local Continuity Wording** - Stop compaction and project task state now mark handoffs as `local_continuity_only` with `mustNotClaimActiveRun`, replacing misleading "Resume from X stage" language.
- **Status CLI Honesty** - `meta-run-status` reports inactive `session_stop` reason and continuation boundary instead of collapsing stopped runs into a generic inactive line.
- **Release Metadata Alignment** - Bumped the package metadata to `2.8.46` so the source tree, tag, and GitHub release point at the same version.

### Verification

- `node --check canonical/runtime-assets/claude/hooks/stop-compaction.mjs canonical/runtime-assets/claude/hooks/stop-save-progress.mjs canonical/runtime-assets/claude/hooks/activate-meta-theory-spine.mjs canonical/runtime-assets/claude/hooks/spine-state.mjs canonical/runtime-assets/shared/hooks/spine-state.mjs scripts/meta-run-status.mjs`
- `node --test tests/meta-theory/20-run-status-envelope.test.mjs`
- `node --test tests/meta-theory/09-run-artifact-validator.test.mjs`
- `node --test tests/meta-theory/32-meta-theory-four-product-targets.test.mjs`
- `node --test tests/meta-theory/11-eight-stage-spine.test.mjs`
- `node --test tests/governance/runtime-safety-contract.test.mjs`
- `node --test tests/governance/capability-inventory-bus.test.mjs`
- `node --test tests/setup/mcp-memory-hooks.test.mjs`
- `npm run meta:release:smoke`
- `npm run meta:verify:all`
- Public-ready boundary retained: HookPrompt prompt-intake context is not runtime invocation, verification, or release-grade all-runtime live evidence.

## [2.8.45] - 2026-06-20

### Solved Problem

This release closes the gap between Meta_Kim's Dynamic Workflow / LangGraph-style governed execution claims and the evidence users can inspect. The default release surface now records the latest hook self-lock repair, keeps private project manuals outside the open-source source set, and ships with a full-pass governed execution artifact that proves capability discovery, worker fan-out, host invocation truth, and verification without upgrading the claim to release-grade live all-runtime readiness.

### Changed

- **Dynamic Workflow Evidence Closure** - Verified the governed execution artifact at `<temp>/meta-kim-host-full/artifacts/goalpro-codex-host-full-proof.json`, including `fetchPacket`, `capabilityInventory`, `capabilityRoute`, `dynamicWorkflowRuntimePacket`, `langGraphRunPacket`, `workerTaskPackets`, `workerResultPackets`, and `verificationPacket`.
- **Host Invocation Truth** - Confirmed real Codex host evidence for `spawn_agent_result`, `agent_team_result`, and `skill_application`, plus fresh local probes for MCP, command/script, and runtime-tool families; `realInvocationCoverage.missingFamilies` is empty in the artifact.
- **Hook Self-Lock Repair** - The Fetch-stage dispatch gate can now repair its own constrained `fetchRecord` state without opening business-file mutation before capability discovery and execution clearance exist.
- **Open-Source Source Boundary** - Removed private manual documents from the public source tree and kept README references aligned with the supported public documentation surface.
- **Release Metadata Alignment** - Bumped the package metadata to `2.8.45` so the source tree, tag, and GitHub release point at the same version.

### Verification

- `npm run meta:validate:run -- <temp>/meta-kim-host-full/artifacts/goalpro-codex-host-full-proof.json`
- `npm run meta:test:meta-theory`
- `npm run meta:release:smoke`
- `git diff --check`
- Public-ready boundary retained: `publicReadyDecision.publicReady = false` because release-grade live all-runtime evidence is not attached.

## [2.8.44] - 2026-06-19

### Solved Problem

This release closes the install/update gap between canonical Meta_Kim sources, global hook packages, and project runtime projections. Fresh users and existing projects now get the same governed `meta-theory` behavior without copying reusable global assets into project mirrors, and source-repository health checks no longer misread intentionally absent generated runtime folders as stale installs.

### Changed

- **Canonical Runtime Source Projection** - `meta-theory` runtime smoke checks now fall back to canonical source assets when generated project mirrors are absent, while still failing materialized runtime mirrors that are broken or incomplete.
- **Global Hook Dependency Closure** - Global Claude hook scripts now resolve shared helpers from the packaged `hooks/meta-kim/` directory instead of importing missing project-local shared paths.
- **Fetch Self-Lock Repair Path** - Fetch-stage hook enforcement now allows a constrained repair-only `fetchRecord` write to `spine-state.json`, while keeping business-file mutation blocked until real capability discovery and execution clearance exist.
- **Install And Update Scope Alignment** - Setup/update paths keep global installs global, bootstrap project mirrors only from canonical sources, and avoid treating the Meta_Kim source repository as a special-case install target.
- **11-Phase User Visibility** - Governed run reports now keep the user-facing business phase focused on feedback/acceptance when runtime verification remains blocked, so users can see the next human action without losing blocker evidence.
- **Product Bundle Bootstrap** - Product delivery bundle generation now shares one run id and state directory between the governed run and deliverable generation, eliminating the missing-run failure in clean smoke tests.
- **First-Class Memory Discovery** - Canonical memory hooks are now represented as stable `memory` providers in the default capability inventory, so clean-state governed runs no longer depend on pre-existing local state files to prove memory capability coverage.
- **Source Repository Health Wording** - Runtime health checks distinguish source-repository self-checks from installed-user mirrors, avoiding misleading stale-mirror messages for empty generated folders.

### Verification

- `npm run meta:verify:all`
- `npm run meta:release:smoke`
- `npm run meta:prd:smooth-capability:validate`
- `npm run meta:prd:stage-runtime-control:validate`
- `node --test tests/meta-theory/11-eight-stage-spine.test.mjs`
- `node --test tests/meta-theory/32-meta-theory-four-product-targets.test.mjs`
- `node --test tests/meta-theory/43-product-delivery-bundle.test.mjs`
- `node --test tests/meta-theory/49-business-phase-visibility.test.mjs`
- isolated setup/hooks worker: `130 pass / 0 fail`
- runtime health worker: `meta:public-assets:validate`, `meta:check:runtimes`, hook sync tests, and stale projection simulation
- `git diff --check`

## [2.8.43] - 2026-06-19

### Solved Problem

This release addresses governed runs that could look complete in hidden hook context or generated artifacts while the user still lacked visible progress, native choice proof, or a real capability route. It also tightens setup/update cleanup so project-local residue from older installs can be removed without deleting user-owned files.

### Changed

- **Visible Governed Run Notices** - Added a host-visible notice contract and runtime guidance so Codex and Claude Code must render important run-start, route, blocker, and closure updates in normal assistant chat, while native choice surfaces stay reserved for branch-changing decisions.
- **Autonomous Capability Discovery** - Expanded route selection so natural-language durable work scans project/runtime/global skills, commands, MCP providers, hooks, scripts, and runtime tools before Thinking binds owners, instead of relying on users to name agents, skills, or protocol stages.
- **Native Choice Evidence Gate** - Strengthened subjective or route-changing work so Codex `request_user_input` and Claude `AskUserQuestion` evidence is tracked before execution, with structural reports no longer standing in for a real native choice.
- **Project Cleanup And Bootstrap Safety** - Added setup cleanup paths for redundant Meta_Kim project assets, managed-block handling for `AGENTS.md` / `CLAUDE.md`, Codex `.agents/skills` projection coverage, and regression tests that preserve unknown local skills and tracked files.
- **Global Hook And Memory Alignment** - Preserved HookPrompt ordering ahead of Meta_Kim spine hooks, added Codex global HookPrompt adapter sync, accepted healthy global Claude hooks in doctor checks, and taught MCP memory checks to find hooks under `hooks/meta-kim/`.

### Verification

- `npm run meta:verify:all`
- `npm run meta:release:smoke`
- `npm run meta:check`
- `npm run meta:doctor:governance`
- `npm run meta:check:global:release`
- `node --test tests/setup/claude-settings-merge.test.mjs tests/setup/lazy-project-bootstrap.test.mjs tests/setup/doctor-governance.test.mjs tests/setup/mcp-memory-hooks.test.mjs`
- `node scripts/validate-capability-routing.mjs`
- `git diff --check`

## [2.8.42] - 2026-06-18

### Solved Problem

This release addresses confusion between global reusable installs and project-local generated state. A global `meta-theory` install can now be verified end to end without copying the reusable Codex skill into every project, while project cache and Graphify outputs remain project-local.

### Changed

- **Codex Global Hook Registration** - Global sync now copies Meta_Kim hook scripts to `~/.codex/hooks/meta-kim/` and merges the prompt-entry spine hook into `~/.codex/hooks.json` with package-root evidence, preserving user hooks and replacing only Meta_Kim-managed entries.
- **Project Cache Verification** - Added `npm run meta:project-cache:verify`, including `--real-global`, to prove global hooks generate `.meta-kim/state/default/post-copy-init.json`, `graphify-out/graph.json`, and `graphify-out/GRAPH_REPORT.md` in the current project without copying `.agents/skills/meta-theory/`.
- **Install Scope Matrix** - Extended install scope verification so global/default, global all-formal, project default, and project all-formal cases prove their expected files and absence of unexpected writes.
- **Formal Projection Wording** - Updated README wording so OpenClaw and Cursor are non-default formal projections, not a compatibility layer, while candidate probes remain separate.

### Verification

- `node scripts/sync-global-meta-theory.mjs --check --targets claude,codex,cursor,openclaw --with-global-hooks`
- `npm run meta:project-cache:verify -- --real-global`
- `npm run meta:project-cache:verify`
- `npm run meta:install-scope:verify`
- `node --test tests/setup/sync-global-hooks-policy.test.mjs tests/setup/install-scope-matrix.test.mjs`
- `node scripts/validate-runtime-safety-contract.mjs`
- `git diff --check`

## [2.8.41] - 2026-06-16

### Solved Problem

This release addresses the gap between "Meta_Kim selected a capability" and "the host actually invoked it." Users can now see which Claude Code or Codex action is still required, which evidence counts, and why long-lived agents are not complete until the host reloads and invokes them.

### Changed

- **Host Invocation Request Contract** - Added `hostInvocationRequestPacket` so selected Agent, Skill, MCP, command/script, runtime-tool, and `agent-teams-playbook` families expose the exact Claude Code or Codex host action still required instead of hiding missing live calls behind partial reports.
- **Trusted Evidence Boundary** - Tightened governed execution so host requests, CLI/env claims, markdown reports, and app-visible badges remain non-proof until a trusted host adapter returns fresh evidence with accepted state, provider/surface, evidence kind, and evidence ref.
- **Durable Agent Lifecycle Proof** - Added `durableAgentLifecyclePacket` so long-lived agents must pass definition candidate, Warden approval/writeback, host reload/discovery, and live invocation proof before completion is claimed.
- **Runtime Adapter Guidance** - Updated Claude Code and Codex references to distinguish runner handoff, real host provider calls, and durable project agent discovery for future adapter implementations.
- **Product Evidence Propagation** - Extended run reports, product delivery bundles, validators, and support gates to carry host invocation requests and durable-agent lifecycle status.

### Verification

- `node --test tests/governance/core-loop-contract.test.mjs tests/meta-theory/32-meta-theory-four-product-targets.test.mjs tests/meta-theory/34-run-deliverables.test.mjs tests/meta-theory/43-product-delivery-bundle.test.mjs`
- `npm run meta:test:meta-theory`
- `npm run meta:check`
- `git diff --check`

## [2.8.40] - 2026-06-16

### Solved Problem

This release addresses the stale-project problem where global Meta_Kim could be updated, but an opened project still failed to discover the new governance entry path. Prompt-entry activation now explains why governance starts and probes project readiness before writing anything.

### Changed

- **Prompt-Entry Governance Activation** - Claude Code and Codex project prompt entries now run the meta-theory spine hook, so natural-language durable work and `critical/fetch/thinking/review` wording can trigger governance before execution instead of relying only on explicit skill activation.
- **Global Claude Project Readiness Detection** - Claude Code global hooks now install the prompt-entry bootstrap hook package with package-root evidence, allowing stale or unbootstrapped projects to receive a concise project readiness reason before any bootstrap write.
- **Project Bootstrap Safety Boundary** - Project bootstrap remains dry-run first and confirmation-gated; stale or equivalent projects surface `status`, active targets, reason, and the native choice requirement without silently applying project files.
- **Spine Deadlock Breaker** - Spine-state writes are now allowed even when Fetch is waiting for `fetchRecord`, preventing prompt-entry smoke runs from locking maintainers out of the state file needed to record Fetch evidence.
- **Global Capability Evidence Refresh** - Refreshed global capability discovery after installing the new hook package; the inventory now includes the Meta_Kim global prompt-entry hook alongside agents, skills, commands, MCP servers/tools, plugins, and runtime hooks.

### Verification

- `node --test tests/setup/graphify-wiring-contract.test.mjs tests/meta-theory/11-eight-stage-spine.test.mjs tests/setup/sync-runtimes-manifest.test.mjs tests/setup/sync-global-hooks-policy.test.mjs tests/meta-theory/47-meta-theory-entry-classifier.test.mjs tests/governance/capability-routing.test.mjs`
- `node --check canonical/runtime-assets/shared/hooks/activate-meta-theory-spine.mjs`
- `node --check canonical/runtime-assets/claude/hooks/enforce-agent-dispatch.mjs`
- `npm run meta:sync`
- `npm run meta:sync:global -- --with-global-hooks`
- `npm run discover:global`
- Claude Code global `UserPromptSubmit` smoke in `<project-root>/game-design`
- Codex project `UserPromptSubmit` smoke in `<project-root>/Meta_Kim`

## [2.8.39] - 2026-06-16

### Solved Problem

This release addresses the problem that card dealing existed in the contract but was not visibly or measurably triggered for users. Card decisions now have scores, evidence, counterfactual checks, and concise user-facing reasons.

### Changed

- **Card Dealing Accuracy Standard** - Upgraded `cardPlanPacket` to v0.2 so every card records a deal/suppress/defer/skip/interrupt/escalate decision with an 80-point standard, quantitative signals, evidence refs, and falsification checks.
- **User-Visible Card Trigger Reason** - Added a concise run-start and report line explaining why card dealing triggered, how many cards activated, and whether the minimum score passed.
- **Contract-Backed Card Proof** - Made `dealStandard` a required `cardPlanPacket` field, aligned generated card shells/sources/silence/control decisions with the workflow contract, and refreshed validator fixtures.
- **Deep Research-Style Card Review** - Bound each card decision to decision impact and counterfactual checks, so unused cards suppress with evidence instead of lingering as vague defers.
- **Global Discovery Readiness** - Synced the updated meta-theory skill into project and global runtime homes, then refreshed the global capability inventory for Claude Code, Codex, OpenClaw, and Cursor.

### Verification

- `node --test tests/meta-theory/14-card-deck-complete.test.mjs tests/meta-theory/34-run-deliverables.test.mjs tests/meta-theory/12-ten-step-workflow.test.mjs tests/meta-theory/07-contract-compliance.test.mjs`
- `node scripts/run-meta-theory-governed-execution.mjs --task "帮我做个小红书营销自动发布器" --run-id card-proof --emit-conversation-notice`
- `npm run meta:check`
- `npm run meta:test:meta-theory`
- `npm run discover:global`
- `npm run meta:sync:global`
- `npm run meta:check:global`
- `npm run meta:release:smoke`

## [2.8.38] - 2026-06-16

### Solved Problem

This release addresses the problem that the 11-phase business workflow could look complete just because all phase names appeared. Each phase now needs evidence, a score, and a trigger/skip/block/wait decision before coverage can pass.

### Changed

- **11-Phase Trigger Standard** - Upgraded `businessPhasePlanPacket` to v0.2 so every phase records a trigger/skip/block/wait decision, score, evidence refs, quantitative signals, and falsification checks instead of passing because eleven phase names were listed.
- **Business Workflow Coverage Truth** - Replaced the old phase-count-only coverage string with contract-aligned `complete` / `incomplete` judgment plus `coverageDetail`, so "recorded" and "accurately triggered" are no longer conflated.
- **Concise Start Reason** - Added a run-start user-facing explanation for why the 8-stage spine and 11-phase workflow triggered, kept short and evidence-backed rather than exposing internal packets.
- **Deep Research-Style Phase Proof** - Bound phase decisions to key signals, counterfactual checks, and decision evidence; accurate skips such as Revision and pending Feedback are now explicitly represented.
- **Report Visibility** - Added trigger state, trigger score, and start-reason visibility to the user-readable meta-theory report and CLI conversation notice.

### Verification

- `node --test tests/meta-theory/34-run-deliverables.test.mjs`
- `node --test tests/meta-theory/12-ten-step-workflow.test.mjs tests/meta-theory/09-run-artifact-validator.test.mjs`
- `npm run meta:check`
- `npm run meta:test:meta-theory`
- `npm run discover:global`
- `npm run meta:check:global`
- `npm run meta:release:smoke`
- `git diff --check`

## [2.8.37] - 2026-06-16

### Solved Problem

This release addresses shallow Review, Meta-Review, and Evolution passes. Runs must now prove evidence quality, blind-spot checks, reusable-learning decisions, and public-ready boundaries instead of passing because packets merely exist.

### Changed

- **Deep Review Gates** - Upgraded prompt-first live acceptance so Review must prove evidence quality, counterevidence, decision impact, falsification checks, and upstream stage trace instead of passing on packet presence alone.
- **Meta-Review Depth Audit** - Added a mechanical depth audit that rejects shallow packet-only Review, checks adversarial coverage and blind spots, and keeps public-ready evidence separate from live/runtime proof.
- **Evolution Strategy Evidence** - Required Evolution to show reusable-pattern, writeback-target, scar-need, and next-run reuse-key assessment before a `none-with-reason` writeback decision can pass.
- **Strict Live Acceptance Regression** - Added regression coverage so missing or shallow Review / Meta-Review / Evolution packets fail strict live normalization rather than being filled by fallback data.

### Verification

- `node --test tests/governance/prompt-first-live-acceptance.test.mjs`
- `node --test tests/governance/decision-cross-validation.test.mjs tests/governance/prompt-first-live-acceptance.test.mjs`
- `npm run meta:check`
- `npm run meta:test:meta-theory`
- `npm run meta:sync`
- `npm run discover:global`
- `npm run meta:check:global`
- `npm run meta:prd:prompt-first-live:validate`
- `git diff --check`

## [2.8.36] - 2026-06-16

### Solved Problem

This release addresses the tendency to create or route to new execution agents before checking existing professional capabilities. Meta_Kim now searches global and project providers first, treats worker tasks as run-scoped work orders, and refreshes local capability inventory after installs or updates.

### Changed

- **Professional Provider-First Routing** - Made governed routes prefer existing global/project professional providers before creating or upgrading execution agents, with explicit coverage for agents, skills, commands, MCP providers/tools, runtime tools, hooks, plugins, memory/graph providers, and dependency providers.
- **WorkerTask Identity Boundary** - Clarified and validated that `workerTaskPacket` is a run-scoped work order for a selected owner/loadout, not a temporary small agent, subagent definition, or durable provider identity.
- **Automatic Global Capability Refresh** - Updated setup/update and global dependency install/update flows to refresh the local global capability inventory automatically after runtime homes change, while keeping machine-specific inventory out of GitHub source.
- **Capability Gap Evidence** - Added `fetch.global_professional_providers_checked` evidence and regression coverage so `create_agent` decisions must prove existing professional providers were checked first.
- **Setup Regression Coverage** - Added release tests for automatic global inventory refresh and fixed the project-deploy protected JSON merge test to match the current planning/write split.

### Verification

- `npm run meta:release:smoke`
- `npm run meta:test:setup`
- `npm run meta:validate`
- `npm run discover:global`
- `npm run meta:gap:real-input-replay`
- `npm run meta:prd:smooth-capability:validate`
- `npm run meta:runtime:validate`
- `npm run meta:graphify:rebuild`
- `git diff --check`

## [2.8.35] - 2026-06-16

### Solved Problem

This release addresses deep research that collected sources without turning them into better decisions. Fetch now targets key information, iterates queries and reads, records stop conditions, and blocks weak or unverified claims from shaping Thinking.

### Changed

- **Decision-Grade Deep Research** - Upgraded Fetch evidence from source collection to key-information targeting, iterative query/read/update logs, explicit stop conditions, and decision-update rules before Thinking.
- **Claim Evidence Cards** - Added `claimEvidenceCards` and stricter run-artifact validation so route-changing claims must cite resolvable evidence refs, counterevidence, confidence, falsification status, and decision impact.
- **Research Execution Proof** - Extended live research execution packets with query iteration counts, evidence-gap closure, confidence-before/after updates, and falsification attempts, keeping blocked evidence out of Thinking.
- **Canonical Governance Alignment** - Updated Scout, Conductor, Prism, and the meta-theory dispatcher so deep research quality is enforced by role responsibilities, generated packets, validators, fixtures, and regression tests rather than prompt wording alone.

### Verification

- `node scripts/run-node-tests.mjs "tests/meta-theory/02-clarity-gate.test.mjs" "tests/meta-theory/37-research-preparation-layer.test.mjs" "tests/meta-theory/44-research-execution-and-innovation.test.mjs" "tests/meta-theory/09-run-artifact-validator.test.mjs"`
- `npm run meta:check`
- `npm run meta:release:smoke`
- `node scripts/run-node-tests.mjs "tests/meta-theory/09-run-artifact-validator.test.mjs"`
- `git diff --check`

## [2.8.34] - 2026-06-16

### Solved Problem

This release addresses install/update confusion between global reusable capabilities, project projections, and open-source package contents. Defaults, platform tiers, and package boundaries now make clear what is installed, what is generated locally, and what is only a compatibility probe.

### Changed

- **Install Scope Boundary** - Restored the default install/update model to "global reusable capabilities + current project projection", now explicitly target-selected: the Enter default projects Claude Code + Codex, while Cursor and OpenClaw project files appear only when those formal projection compatibility targets are selected.
- **Open-Source Runtime Projection Boundary** - Added a release validator that keeps generated runtime projection directories such as `.codex/`, `.agents/`, `.claude/`, `.cursor/`, and `openclaw/` out of GitHub source and package files, while documenting that Codex adapter/business-role TOML files are local host projections rather than governance agents.
- **Platform Compatibility Tiers** - Made the install contract and verification output distinguish formal projections, dependency-owned targets, and candidate probes, while public docs avoid repeating upstream dependency install matrices as Meta_Kim support claims.
- **Public Platform Wording** - Updated README badges, platform tables, and cross-platform mapping copy so default formal projections, explicit formal compatibility projections, and candidate compatibility probes are visible separately; refreshed Qoder official doc links and added Cline's official Skills primitive to the catalog.
- **Project Governance UX** - Updated the PRD, setup, and README copy so global skills are reusable discovery entrypoints, project governance requires dry-run bootstrap confirmation, and `AGENTS.md` is described as platform-specific context rather than a universal Codex/Cursor/OpenClaw entrypoint.
- **Install Scope Verification** - Added `npm run meta:install-scope:verify` to exercise temp global homes and temp project bootstraps, then report global-layer and project-layer surfaces by platform.

## [2.8.33] - 2026-06-15

### Solved Problem

This release addresses the burden of manually keeping global Meta_Kim and each project-level runtime projection in sync. Project bootstrap now dry-runs, shows the source chain, preserves user files, and only applies project writes after confirmation.

### Added

- **Global-First Project Bootstrap** - Added `meta-kim project bootstrap` and `npm run meta:project:bootstrap` so a global Meta_Kim install can dry-run and apply project-level Claude Code / Codex projections without asking users to manually maintain both global and project state.
- **First-Trigger Bootstrap Probe** - Extended the meta-theory activation hook to run a dry-run project bootstrap probe on first meta-theory activation and save source-chain evidence without silently applying project files.
- **Lazy Bootstrap Acceptance Tests** - Added fixture coverage for empty projects, existing user config, stale manifests, read-only failures, managed-block replacement, protected JSON merge, backup manifests, and `.codex/config.toml` never-touch behavior.

### Changed

- **Project Source Chain Evidence** - Project bootstrap plans now expose the installed package root, canonical roots, `config/sync.json`, generated runtime mirrors, target project, file actions, merge policies, and skipped files before any write.
- **Runtime Choice Surfaces** - Updated Claude Code and Codex choice-surface contracts to preserve structured decision-panel semantics while using the active host schema's maximum meaningful option count instead of a Meta_Kim hard cap.
- **Capability Routing** - Moved capability discovery to canonical/index-first routing and prevented Codex and Claude Code routes from binding the other runtime's project agent adapters as callable execution owners.

### Verification

- `npm run meta:check`
- `npm run meta:test:setup`
- `npm run meta:test:governance`
- `npm run meta:runtime:safety:validate`
- `npm run meta:release:smoke`
- `git diff --check`

## [2.8.32] - 2026-06-15

### Solved Problem

This release addresses Codex governed work silently collapsing into a single main-thread executor. Complex work now becomes fan-out eligible when safe, while unavailable host dispatch and selected-but-not-invoked providers stay visible as partial evidence.

### Changed

- **Codex Meta-Theory Fan-Out** - Made explicit `/meta-theory` and complex governed work fan-out eligible when there are multiple safe worker lanes, so Codex should plan real parallel work instead of silently falling back to one main-thread executor.
- **Runtime Capacity Sizing** - Replaced the stale fixed five-agent wave cap with runtime capacity detection from Codex config and the official default, while still proving DAG dependencies, collision boundaries, workspace isolation, and external-write safety before fan-out.
- **Invocation Truth Evidence** - Tightened run evidence so live subagents are reported as `invoked` only with host spawn evidence; unavailable host dispatch is reported as `unavailable`, single-lane work as `not_required`, and provider selection can no longer masquerade as execution.

### Verification

- `npm run meta:release:smoke`
- `git diff --check`

## [2.8.31] - 2026-06-14

### Solved Problem

This release addresses the missing bridge between dynamic workflow planning and real parallel execution. Meta_Kim now selects the agent-teams playbook only when multiple safe executable lanes exist and keeps provider selection, subagent calls, MCP calls, skills, commands, hooks, and local workers distinct.

### Added

- **Agent Teams Playbook Gate** - Added the P-110 support gate and `agentTeamsPlaybookPacket` so the default governed route selects `agent-teams-playbook` for two or more independent executable worker lanes, proves DAG/collision/workspace/external-write safety, sizes waves by runtime agent capacity, and records `not_required` for single-lane work.
- **Capability Invocation Truth Layer** - Added explicit `agent_teams_playbook` truth states so selected providers, live subagent calls, MCP calls, skills, commands, hooks, and local workers cannot be relabeled as each other.
- **Product Experience Validator** - Added a PRD/product validator that checks the three core goals plus support gates, including LangGraph-style run packets, Dynamic Workflow coverage, user-visible run surfaces, capability invocation truth, and the agent-teams adapter.

### Changed

- **Codex Meta-Theory Runtime** - Tightened the Codex `/meta-theory` adapter and meta-conductor prompt so `agent-teams-playbook` is selected only for real parallel worker lanes, not for every non-trivial task.
- **Dependency Registry** - Promoted `agent-teams-playbook` from an external reference to an installed skill candidate with compatibility validation and a no-overclaim boundary.
- **Release Smoke Coverage** - Extended release smoke to include the `agent-teams-playbook` integration test.

### Verification

- `npm run meta:deps:compat`
- `npm run meta:prd:product-experience:validate`
- `npm run meta:prd:default-execution:validate`
- `npm run meta:prompt:validate`
- `npm run meta:graphify:check`
- `npm run meta:release:smoke`
- Codex live probe created reviewer subagent `019ec274-15a4-7603-9986-335dad22c699` from thread `019ec26d-8837-77b2-95c8-1361bcb91128`; the `wait_agent` return was interrupted, so full review-return closure remains partial evidence.

## [2.8.30] - 2026-06-13

### Solved Problem

This release addresses overbroad runtime support claims and research that was too easy to accept at face value. The release separates primary install defaults from compatibility probes, and turns deep research into a Fetch contract with source-quality and synthesis rules.

### Changed

- **Primary Install Defaults** - Changed direct-Enter install/update defaults to Claude Code + Codex while keeping OpenClaw and Cursor available through explicit all-runtime or `--targets` selection.
- **Fetch Research Quality Gate** - Internalized ECC-style deep research as a Meta_Kim-native Fetch contract with source-quality ladders, key-source deep reading, claim attribution, cross-checking, and original synthesis boundaries.
- **Compatibility Candidate Framework** - Added a source-backed primitive-surface framework for Qoder CLI, Trae, Kiro, Windsurf / Devin Desktop Cascade, Cline, Roo Code, and Continue while keeping them as candidate probes instead of formal runtime projections.
- **Compatibility Evidence Boundary** - Split GitHub completion from all-tool compatibility evidence so generated reports keep Cursor in the compatibility follow-up lane, separate from primary release decisions.

### Verification

- `npm run meta:sync`
- `npm run meta:release:smoke`
- `git diff --check`
- `node setup.mjs --update --lang zh --targets claude,codex --project-dir <dir>...`

## [2.8.29] - 2026-06-13

### Solved Problem

This release addresses branch-changing decisions being faked by chat text or artifact fallbacks. Codex and Claude Code must use their native choice surfaces for required decisions, and governed runs expose progress without leaking packet jargon.

### Added

- **Native Choice Surface Guard** - Added regression coverage that prevents Codex and Claude Code branch-changing decisions from being completed by chat-card or artifact-only fallbacks.
- **Run Status Surface** - Added localized run-status envelopes and commands so governed runs can expose reader-facing progress without leaking internal packet names.

### Changed

- **Codex and Claude Code No-Downgrade Rule** - Required Codex to use `request_user_input` and Claude Code to use `AskUserQuestion` or deferred `AskUserQuestion` for required execution decisions; unavailable or empty native surfaces now block before Execution instead of degrading silently.
- **Runtime Mirror Mapping** - Synced the canonical meta-theory skill, meta agents, runtime references, and project-local runtime mirrors across Claude Code, Codex, Cursor, and OpenClaw.

### Verification

- `npm run meta:sync`
- `npm run meta:governance:validate`
- `npm run meta:prompt:validate`
- `npm run meta:check:runtimes`
- `npm run meta:test:meta-theory`
- `git diff --check`

## [2.8.28] - 2026-06-13

### Solved Problem

This release addresses the risk that default governed execution looked complete while evidence layers were mixed together. Product validators now check core goals, default execution evidence, research-to-native adoption, runtime priority, and capability discovery without overclaiming live proof.

### Added

- **Default Governed Execution Evidence** - Added validators and run artifact packets proving the default Meta-Theory path emits governance agent results, Conductor consumption evidence, worker results, and worker execution evidence without relabeling structural boards as live runtime proof.
- **Research-to-Native Productization** - Added source-backed productization contracts for research adoption, MCP/provider maturity, trace/eval control, AG-UI-style stage events, performance/cost budgets, and context engineering.
- **Smooth Capability Discovery Guard** - Added a PRD validator that keeps agents, skills, scripts, MCP, tools, hooks, runtimes, memory, graph, and external providers as first-class discovery categories while allowing safe `no_expansion_needed` cases.
- **Runtime Priority Contract** - Added a machine-readable contract and validator that keep Claude Code and Codex as primary prompt-first runtimes while preserving OpenClaw and Cursor as compatibility targets only.

### Changed

- **Framework Prompt Architecture** - Prompt assets are now validated across layered system/project/agent/skill/contract/runtime-adapter/eval surfaces, with review dimensions, regression fixtures, and context-sprawl budget rules.
- **Governance Verification** - `meta:verify:governance` now includes default execution, asset sedimentation, research-native, framework prompt architecture, smooth capability discovery, and runtime priority validators.
- **Single PRD Source** - The local-private PRD now records P-067, P-068 through P-084, P-085, and P-092 as locally tested while keeping Cursor native live evidence in the compatibility follow-up lane.

### Verification

- `npm run meta:prd:smooth-capability:validate`
- `npm run meta:prd:runtime-priority:validate`
- `node scripts/run-node-tests.mjs "tests/meta-theory/29-capability-gap-complete-product-prd.test.mjs"`
- `npm run meta:verify:governance`
- `npm run meta:release:smoke`
- `git diff --check`
- `npm run meta:github:gap`

## [2.8.27] - 2026-06-13

### Solved Problem

This release addresses planning that could name many lanes without proving which owners, dependencies, and verifications were actually ready. The orchestration contract now requires a usable board, explicit dependency policy, and reviewable handoff before execution.

### Added

- **Prompt-First Live Acceptance** - Added a PRD-linked live acceptance contract and runner that proves the same framework prompt through Claude Code and Codex before the prompt-first flow can be called complete.
- **Source-Backed PRD Gates** - Added PRD source-map and dossier validators for product discovery, prompt/runtime, MCP/tools/providers, security, evaluation/observability, and architecture/release categories.

### Changed

- **Abstract Prompt Capability Validation** - `meta:prompt:validate` and governance verification now cover abstract capability families such as capability discovery, prompt intake optimization, planning continuity, runtime-native surfaces, MCP/providers, memory/graph, safety hooks, release evidence, and i18n.
- **Prompt-First Release Evidence** - Governance verification now includes prompt-first stage contracts, live acceptance fixtures, source-map validation, PRD category dossiers, and public docs image-asset boundaries.
- **Codex Live Runner Stability** - The Codex live acceptance runner now sends the prompt through stdin with `codex exec -`, avoiding Windows `.cmd` multiline prompt stalls while preserving real Codex execution evidence.

### Verification

- `npm run meta:prd:prompt-first-live:run`
- `npm run meta:prd:prompt-first-live:validate`
- `npm run meta:verify:governance`
- `npm run meta:release:smoke`
- `git diff --check`

## [2.8.26] - 2026-06-12

### Solved Problem

This release addresses drift between local/private PRD status, public-facing docs, and current implementation evidence. Remaining product work is now tracked through clearer dossiers, validators, and public-safe status language.

### Fixed

- **Meta-Theory Deep Fetch Entry** - Project/repo/codebase understanding and commercialization strategy prompts now enter the governed Fetch path instead of falling through to shallow fast-path answers.
- **Cross-Runtime Entry Parity** - Added Claude Code `/meta-theory` command projection support, Cursor's native always-on dispatch rule, and OpenClaw HEARTBEAT/SOUL project-understanding requirements so Claude, Codex, Cursor, and OpenClaw all route through the same governed entry contract.
- **Run Artifact Evidence** - `meta:theory:run` now records project overview, maintainer contract, command inventory, Graphify, MCP, capability-index, machine-contract, and external-research capability source classes for project-understanding runs.

### Verification

- `node --test tests/meta-theory/47-meta-theory-entry-classifier.test.mjs`
- `node --test tests/setup/sync-runtimes-manifest.test.mjs`
- `node --test tests/governance/core-loop-contract.test.mjs`
- `npm run meta:sync`
- `npm run meta:check`
- `git diff --check`

## [2.8.25] - 2026-06-12

### Solved Problem

This release addresses repeated confusion over which product goals were complete, partial, or blocked. The product-experience checklist now ties completion claims to concrete evidence instead of broad status language.

### Fixed

- **Claude Code Global Hook Cleanup** - Global Meta_Kim sync now validates the Claude Code `settings.json` hook commands, not only the `~/.claude/hooks/meta-kim/` package directory. This catches stale global Meta_Kim hook registrations that point at removed scripts and cause Claude Code `MODULE_NOT_FOUND` Stop hook errors.
- **Installed-User Recovery Path** - Running the normal setup/update path now cleans stale global Meta_Kim hook entries and leaves only the currently managed global hook command, so existing installations recover without hand-editing Claude settings.

### Verification

- `npm run meta:check:global:release`
- `npm run meta:test:setup`
- `npm run meta:verify:governance`
- `npm run meta:check`
- `git diff --check`

## [2.8.24] - 2026-06-12

### Solved Problem

This release addresses release-readiness misses in host config, hook protocol, deletion residue, and evidence reporting. The checklist and PR template now force maintainers to state source of truth, host-state impact, cleanup scope, and evidence budget before merge.

### Changed

- **Runtime Safety Hardening Contract** - Added a release-grade governance contract that binds the five recent repair lanes into one validator: host config merge safety, cross-runtime HookPrompt protocol modeling, deletion/refactor residue sweep, runtime evidence templates, and install/update status semantics.
- **Install Status Semantics** - Install and update messages now have machine-readable status classes (`success`, `skipped`, `manual`, `failed`) with next-action semantics, so user-facing setup output can distinguish expected skips, manual host steps, and real failures.
- **HookPrompt Bad-Input Regression Coverage** - Added regression fixtures for markdown fences, delegated prompts, and internal-goal filtering, and verified Codex/Cursor adapters keep optimized prompt content in model-visible fields without reusing UI notices as policy.

### Verification

- Added `npm run meta:runtime:safety:validate` to `meta:verify:governance`.
- `npm run meta:verify:governance`
- `npm run meta:test:setup`
- `npm run meta:sync`
- `npm run discover:global`
- `npm run meta:check`
- `npm run meta:validate`
- `npm run meta:release:smoke`
- `npm run meta:setup:check`
- `npm run meta:validate:run -- tests/fixtures/run-artifacts/valid-core-loop-release-run.json`
- `npm run meta:graphify:rebuild`
- `npm run meta:verify:all`
- `git diff --check`

## [2.8.23] - 2026-06-12

### Solved Problem

This release addresses stale graph and package-boundary assumptions before release. The release path now keeps Graphify and open-source package boundaries visible as explicit checks.

### Changed

- **Run-Scoped Worker Execution** - `meta:theory:run` now executes bounded worker task packets through a local run-scoped worker executor instead of stopping at structural dispatch readiness. The main thread still scopes, delegates, reviews, and synthesizes; no extra external agent is spawned.

### Verification

- Adds governance coverage that requires worker execution evidence while preserving the public-ready release gate.

## [2.8.22] - 2026-06-12

### Solved Problem

This release addresses runtime projection drift that could make generated files diverge from canonical Meta_Kim behavior. Sync coverage and runtime checks now make projection gaps easier to catch before release.

### Changed

- **Core Loop Release Evidence Closure** - Completed the PDR release checklist and final release evidence for the governed execution repair so the shipped tag includes commit, tag, push, and GitHub Release proof.

### Verification

- Reused the `2.8.21` core-loop implementation evidence and reran the local release checks for the final `2.8.22` patch release.

## [2.8.21] - 2026-06-12

### Solved Problem

This release addresses weak capability-gap decisions that jumped from "we need something" to "create an agent." Capability gaps now compare skills, scripts, MCP providers, runtime tools, and existing agents before durable creation is allowed.

### Changed

- **Core Loop Governed Execution Repair** - Meta_Kim now has a compact machine contract for the default eight-stage governed path, covering Critical, Fetch, Thinking, Execution, Review, Meta-Review, Verification, and Evolution with explicit IO, skip, gate, blocking, warning, public-ready, and writeback policy.
- **Default Run Artifact Closure** - `meta:theory:run` now emits top-level request, intent, fetch, capability inventory, gap/ready, thinking, dispatch, worker task, execution, review, meta-review, verification, evolution, dynamic workflow, and public-ready packets for durable natural-language work.
- **Capability Discovery Bus Integration** - The default run now uses the unified capability inventory bus instead of a skill-only or coarse summary. Inventory records cover agents, skills, scripts/tools, MCP, hooks, runtime, OS, memory, graph, and external dependency candidates with shared provider fields.
- **Release Governance Gates** - Full release verification now includes governance validators and governance tests, including strict workflow fixture validation, PDR evidence mapping, and script registry cleanup-candidate protection.

### Verification

- `npm run meta:sync`
- `npm run discover:global`
- `npm run meta:check`
- `npm run meta:validate`
- `npm run meta:release:smoke`
- `npm run meta:verify:governance`
- `npm run meta:graphify:rebuild`
- `npm run meta:check:global:release`
- `npm run meta:verify:all`
- `npm run meta:validate:run -- tests/fixtures/run-artifacts/valid-core-loop-release-run.json`
- `git diff --check`

## [2.8.20] - 2026-06-11

### Solved Problem

This release addresses the risk that Meta_Kim could report governance progress without proving the user-facing deliverable chain was closed. Run reports and product bundles now carry clearer completion, warning, and remaining-action evidence.

### Changed

- **Project Hook Ownership Rationalization** - Project runtime exports now keep project-specific hooks focused on Meta_Kim behavior, such as graph context, capability-first dispatch, and meta-theory activation. Global personal or reusable hooks, including prompt optimization, memory lifecycle helpers, planning helpers, and generic dangerous-command guards, are kept in the global runtime homes instead of being duplicated into every project.
- **Global Hook Sync Coverage** - Global sync and release checks now compare the selected global hook files explicitly, while project sync removes stale global-only hook adapters from generated Codex and Cursor project folders. This keeps dependency-owned hooks updateable from their source projects and prevents duplicated prompt/context injection.
- **Codex MCP Config Merge Normalization** - Codex MCP config merging was tightened so ECC-managed servers are normalized consistently while user-owned config remains preserved.

### Verification

- `npm run meta:release:smoke`
- `npm run meta:check`
- `npm run meta:check:global:release`
- `npm run meta:test:setup`
- `node scripts/validate-provider-capabilities.mjs`
- `node scripts/validate-foundational-capabilities.mjs`
- `node scripts/validate-hook-progression.mjs`
- `npm run meta:graphify:check`
- `git diff --check`

## [2.8.19] - 2026-06-11

### Solved Problem

This release addresses unclear release closure when GitHub completion, runtime compatibility, and local verification were mixed into one "done" claim. Completion and compatibility evidence now stay separated so each blocker has an owner and next action.

### Changed

- **Apache-2.0 License With NOTICE Attribution** - Meta_Kim's main project license changed from MIT to Apache License 2.0, with a root `NOTICE` file that carries the recommended attribution. Commercial use remains allowed, while redistributions of Meta_Kim or substantial portions of it must keep the Apache license text and NOTICE attribution. Earlier releases remain governed by the license that shipped with those releases.
- **Automated Multi-Project Runtime Updates** - `setup.mjs` can now refresh project-level runtime files across multiple explicit or saved project directories, including `--project-dir` for scriptable targets, `--save-project-dirs` to remember a script-provided list, and `--all-projects` for saved local targets.
- **Saved Project Directory Manager** - The update wizard now lets users manage a saved project directory list, enter multiple directories in one semicolon/comma-separated line, update all saved projects from the menu, and rerun saved targets with `--all-projects`.
- **Project Config Protection During Batch Updates** - Multi-project runtime exports preserve and merge existing local `settings`, MCP, and hook configs instead of blindly replacing them. Local-only state such as `.claude/settings.local.json`, Codex project config, and OpenClaw workspace state is not exported.

### Verification

- `node --check setup.mjs`
- `node --test tests/setup/project-deploy-protection.test.mjs tests/setup/setup-update-default-flow.test.mjs tests/setup/i18n.test.mjs`
- `npm run meta:test:setup`
- `npm run meta:sync`
- `npm run meta:check`
- `npm run meta:verify:all`
- `npm --registry=https://registry.npmjs.org audit --audit-level=high`
- `npm run meta:graphify:check`
- `git diff --check`

## [2.8.18] - 2026-06-11

### Solved Problem

This release addresses brittle live/runtime evidence where timeout, skipped, and partial results could be confused with release-grade success. Runtime probes now classify evidence more strictly and preserve recovery paths.

### Fixed

- **Codex Planning Stop Hook Advisory Mode** - Codex planning-with-files Stop hooks no longer turn ordinary progress reminders into blocking continuations. This prevents completed answers from being folded into Codex App's processed section just because a stale or advisory plan reminder fired at the end of the turn.
- **Zero-Phase Plan Handling** - Codex planning hook adapters now ignore `0/0` phase counts instead of treating them as incomplete work. Mixed `**Status:**` and inline `[status]` phase formats are counted consistently with the shell and PowerShell hooks.

### Changed

- **Change Readiness Contract** - Runtime, hook, setup, sync, provider, deletion, and release PRs now have a reusable checklist for host-state impact matrices, hook/prompt protocol flow, deletion residue sweeps, and evidence budgets.
- **Execution Mode Classes** - `executionMode` values are now explicitly mapped into `real_execution`, `read_only_sidecar`, and `approval_gate` classes so validators and reviews can reason about execution semantics instead of raw task counts.

### Verification

- `node --check scripts/install-global-skills-all-runtimes.mjs`
- `node --check scripts/validate-project.mjs`
- `node --check scripts/validate-run-artifact.mjs`
- `node --test tests/setup/release-docs-semantics.test.mjs tests/setup/install-cross-platform.test.mjs`
- `node --test tests/meta-theory/09-run-artifact-validator.test.mjs tests/meta-theory/31-capability-gap-orchestration.test.mjs tests/meta-theory/33-capability-gap-orchestration-quality.test.mjs`
- `node scripts/validate-provider-capabilities.mjs --strict-global-hooks --json`
- `npm --registry=https://registry.npmjs.org audit --audit-level=high`
- `npm run meta:verify:all`
- Codex planning Stop hook smoke on this Windows host: `0/0` phase plans emit no block; normal incomplete plans emit `systemMessage`, not `decision:block`.
- Installed-user hook merge smoke: after reinstalling `planning-with-files`, Codex keeps both `user_prompt_submit.py` and `hookprompt-adapter.mjs`; Cursor keeps `beforeSubmitPrompt` with `hookprompt-adapter.mjs`.

## [2.8.17] - 2026-06-11

### Solved Problem

This release addresses generated report and product-surface clutter that made governed runs harder to inspect. Reports were consolidated around the evidence users need for decisions, review, and follow-up.

### Fixed

- **Real Execution Mode For Orchestration** - Worker task packets now declare `executionMode`, so Meta_Kim can distinguish real execution workers from approval gates and read-only Fetch/Review sidecars. Parallel groups can no longer pass quality gates when they contain only sidecars or approval steps.
- **Capability Gap Board Validation** - Capability-gap orchestration reports now carry execution mode through the worker packet, task board, review checks, validation summary, and run-artifact validator. This makes fake parallelism visible and testable.
- **ECC Plugin Update Path** - Claude plugin update mode now calls `claude plugin update ecc@ecc` when an installed ECC plugin record exists, and refreshes the plugin manager record after a successful update instead of relying on stale local metadata.
- **Graphify Python Discovery** - Graphify setup and runtime checks now try Homebrew and Linuxbrew Python paths after normal `python3` / `python` launchers, improving macOS and Linux setup reliability when Python is installed outside PATH.

### Verification

- `node --test tests/meta-theory/09-run-artifact-validator.test.mjs`
- `node --test tests/meta-theory/31-capability-gap-orchestration.test.mjs tests/meta-theory/33-capability-gap-orchestration-quality.test.mjs`
- `node --test tests/setup/graphify-runtime.test.mjs tests/setup/graphify-wiring-contract.test.mjs tests/setup/install-cross-platform.test.mjs tests/setup/install-plugin-bundles.test.mjs`
- `node --test tests/integration/agent-teams-playbook-integration.test.mjs tests/meta-theory/39-orchestration-dag-report.test.mjs tests/meta-theory/40-orchestration-scheduler-report.test.mjs`
- `npm run meta:gap:validate-board`
- `npm run meta:gap:complex-inputs`
- `npm run meta:gap:codex-real-test`
- `npm run meta:test:setup`
- `npm run meta:test:meta-theory`
- `npm run meta:check`
- `npm run meta:graphify:rebuild`
- `npm run meta:graphify:check`
- `npm run meta:release:smoke`
- `git diff --check`

## [2.8.16] - 2026-06-10

### Solved Problem

This release addresses copied-project installs where generated files existed but the target project was not actually initialized. The post-copy flow now initializes Graphify in the final project root and avoids treating temporary export folders as real projects.

### Fixed

- **Automatic Post-Copy Graphify Initialization** - Copied project-level Meta_Kim folders no longer require users to remember `node meta-kim-post-copy.mjs`. On the first `meta-theory` activation, Meta_Kim now starts the post-copy bootstrap automatically from the final project root.
- **Non-Blocking First Trigger** - The generated `meta-kim-post-copy.mjs` now supports `--auto` and `--auto-worker`. The hook launches a detached background worker, records one-time state in `.meta-kim/state/default/post-copy-init.json`, and keeps the meta-theory startup path responsive even when Graphify dependency installation or graph generation takes longer.
- **Runtime Hook Coverage** - Claude Code and Codex Skill activation now call the same shared spine hook, and Cursor prompt hooks can bootstrap explicit `meta-theory` prompts through the same path. The hook also honors `META_KIM_POST_COPY_AUTO=off` for explicit opt-out.
- **Regression Coverage** - Setup tests now lock the automatic bootstrap contract, Cursor prompt hook ordering, and the copy-ready Graphify post-copy behavior.

### Verification

- `npm run meta:test:setup`
- `npm run meta:graphify:rebuild`
- `npm run meta:release:smoke`
- `npm run meta:graphify:check`
- `git diff --check`
- `node --check setup.mjs`
- `node --check canonical/runtime-assets/shared/hooks/activate-meta-theory-spine.mjs`
- `node --check scripts/runtime-hook-mapping.mjs`
- `node --check scripts/sync-runtimes.mjs`

## [2.8.15] - 2026-06-10

### Solved Problem

This release addresses copy-ready project setup failing after users move generated files into a real project. The bootstrap script now runs from the copied destination and keeps Graphify setup tied to the final project directory.

### Fixed

- **Copy-Ready Graphify Initialization** - Project-level folders generated by quick setup or install/update export now include `meta-kim-post-copy.mjs`. After copying the generated folder contents from a staging location, such as Desktop, into any project root, run `node meta-kim-post-copy.mjs` there to initialize Graphify for the final project.
- **Staging Directory Boundary** - Meta_Kim no longer treats the generated staging folder as the final Graphify root. This avoids creating or copying stale `graphify-out/` data for the wrong project while preserving per-project Graphify setup.
- **Post-Copy Contract Coverage** - Setup tests now lock the copy-ready contract: exports write the bootstrap after runtime files are copied, the bootstrap resolves its own directory as the project root, and install/update exports do not silently build Graphify in the staging directory.

### Verification

- `node --check setup.mjs`
- `node --test tests/setup/graphify-wiring-contract.test.mjs`
- `node --test tests/setup/install-cross-platform.test.mjs tests/setup/setup-update-default-flow.test.mjs tests/setup/i18n.test.mjs`
- `npm run meta:test:setup`
- `npm run meta:graphify:rebuild`
- `npm run meta:graphify:check`
- `git diff --check`

## [2.8.14] - 2026-06-10

### Solved Problem

This release addresses install/update output that looked like failures or English-only internals instead of actionable user status. Notices are localized, expected manual host-plugin steps are labeled honestly, and HookPrompt output no longer breaks Markdown rendering.

### Fixed

- **Localized Install And Update Notices** - Install/update output for ECC, Graphify, Codex config preservation, native plugin handoff, marketplace checks, and loopback proxy handling now goes through Meta_Kim's shared i18n layer instead of hardcoded English strings. Chinese, Japanese, and Korean users now see localized status lines for expected skips and manual host-plugin steps.
- **ECC Upstream Version Tracking** - ECC native installs now use `ecc-universal@latest` instead of the older `2.0.0-rc.1` release candidate in the runtime manifest, docs, compatibility evidence, and setup tests.
- **Less Misleading Plugin Handoff Output** - Expected host limitations are now reported as skipped/manual steps instead of warning-like failures. Cursor and Codex native plugin messages now explain the manual host-plugin path without implying that the skill fallback failed.
- **Graphify Skip Output Consistency** - Already-wired Graphify guide sections now report localized skip notices, and the old `[SKIP] graphify ...` line was aligned with Meta_Kim's normal skipped-state output.
- **HookPrompt Markdown-Safe Output** - The upstream HookPrompt dependency now wraps raw user input and the optimized full prompt in fenced code blocks, so attachment headings such as `# Files mentioned by the user:` no longer render as oversized Markdown headings in the middle of Codex output.

### Verification

- `node --check .claude/hooks/user-prompt-submit.js; node --check .codex/hooks/user-prompt-submit.js; node --check test-hook.js` in `<project-root>/HookPrompt`
- `node test-hook.js` in `<project-root>/HookPrompt`
- `node scripts/install-global-skills-all-runtimes.mjs --dry-run --update --skills ecc,superpowers --targets claude,codex,cursor --lang zh-CN`
- `node --test tests/setup/install-plugin-bundles.test.mjs tests/setup/graphify-wiring-contract.test.mjs tests/setup/install-cross-platform.test.mjs`
- `npm run meta:test:setup`
- `npm run meta:capabilities:smoke`
- `npm run meta:check`
- `npm run meta:release:smoke`
- `npm run meta:verify:all`
- `npm run meta:graphify:rebuild`
- `npm run meta:graphify:check`
- `git diff --check`

## [2.8.13] - 2026-06-10

### Solved Problem

This release addresses ECC installs overwriting Codex App user configuration and breaking native controls. Meta_Kim now preserves the user config as the base, merges ECC additions add-only, and restores Browser, Chrome, and Computer Use plugin settings.

### Fixed

- **Codex App Native Controls Protection** - Meta_Kim now protects a user's existing `~/.codex/config.toml` before running the ECC Codex home installer. The issue was discovered because ECC's Codex install path can copy its reference `config.toml` over the user's Codex App configuration, which can break the Codex Computer Use and Chrome plugin links.
- **ECC Config Merge Safety** - After the upstream ECC installer runs, Meta_Kim restores the user's original Codex config as the base, merges ECC additions add-only, and then restores the Codex App Browser, Chrome, and Computer Use native plugin settings. This avoids losing user MCP servers, hooks, agents, projects, profiles, and other global Codex settings.
- **Windows Codex App Recovery** - Windows installs now repair the Codex App native control surface by keeping `windows.sandbox = "unelevated"`, enabling `features.js_repl`, removing stale `.codex/.tmp/bundled-marketplaces/openai-bundled` marketplace sources, and preserving the Computer Use notification helper when it exists.

### Verification

- `node --test tests/setup/codex-config-merge.test.mjs`
- `node --test tests/setup/install-plugin-bundles.test.mjs`
- `npm run meta:release:smoke`
- `npm run meta:verify:all`
- `npm run meta:graphify:rebuild`
- `git diff --check`

## [2.8.12] - 2026-06-10

### Solved Problem

This release addresses HookPrompt appearing to run in Codex while the optimized prompt did not reliably reach model context. Codex now uses the model-visible `additionalContext` envelope, while UI notices remain separate.

### Fixed

- **Codex HookPrompt Model Context** - Codex HookPrompt adapters now emit `hookSpecificOutput.additionalContext` instead of `systemMessage`. This fixes the case where HookPrompt ran and produced visible hook output, but the optimized prompt was not reliably injected into the model context.
- **Codex Memory Context** - Shared Meta_Kim memory hooks now use the same model-visible context envelope on Codex as Claude Code, while Cursor keeps its `prompt` envelope and UI-only notices remain separate.

### Changed

- **HookPrompt Dependency Path** - Meta_Kim now looks for HookPrompt's Codex adapter before falling back to the Claude hook implementation, matching the upstream dependency layout.

### Verification

- `node test-hook.js` in `<project-root>/HookPrompt`
- `node --test tests/setup/sync-runtimes-manifest.test.mjs tests/setup/mcp-memory-hooks.test.mjs`
- `node scripts/install-global-skills-all-runtimes.mjs --update --skills hookprompt --targets codex`
- `codex exec --dangerously-bypass-hook-trust --skip-git-repo-check --sandbox read-only --cd <project-root>/course-materials "帮我做个小红书营销自动发布器，先别改文件，先说你理解到什么"`
- `npm run meta:release:smoke`
- `git diff --check`

## [2.8.11] - 2026-06-09

### Solved Problem

This release addresses global hooks becoming too heavy or too runtime-specific. Meta_Kim now separates safe global reusable hooks from stronger project-scoped governance hooks and validates HookPrompt provider mapping by runtime.

### Changed

- **Global and Project Hook Strategy** - Meta_Kim now separates project-level governance hooks from global reusable hooks. Strong governance hooks such as dispatch enforcement, Graphify context, and meta-theory spine stay project-scoped by default, while global installs focus on safe reusable entry points such as memory save, HookPrompt, and the OpenClaw memory bridge.

### Fixed

- **Cursor HookPrompt Global Install** - Cursor global `beforeSubmitPrompt` now receives the HookPrompt adapter just like Codex global `UserPromptSubmit`, and strict provider validation checks both runtimes.
- **Hook Capability Inventory** - The provider registry now models Codex and Cursor HookPrompt adapters separately, so project projection and global install evidence are checked against the right runtime and hook event.

### Verification

- `node scripts/install-global-skills-all-runtimes.mjs --skills hookprompt --targets cursor`
- `node scripts/validate-provider-capabilities.mjs --strict-global-hooks --json`
- `node --test tests/setup/install-cross-platform.test.mjs`
- `node --test tests/governance/provider-capabilities.test.mjs`

## [2.8.10] - 2026-06-09

### Solved Problem

This release addresses natural-language durable work being forced through fixed checklists or requiring users to know protocol words. Meta_Kim now derives task-specific lanes, checks local baseline evidence, and shows human-readable progress.

### Added

- **Dynamic Workflow** - Natural product requests now expand into task-specific execution lanes instead of a fixed checklist. For example, a Xiaohongshu automation request can select product, research, content, UX, frontend, backend, data, integration, security, test, and ops lanes, while a local todo board selects only the smaller set it actually needs.
- **Project Agent Profiles** - Dynamic lanes synthesize run-pinned project agent profiles before execution. The profile records the project scope, role family, capability loadout, memory strategy, evidence rules, and promotion policy; one-run workers stay separate from durable project agents.
- **Evidence Policy** - Research, integration, security, and ops lanes now declare when current external evidence is required. Claims about platform rules, APIs, provider capability, compliance, security, release paths, or third-party feasibility must be source-backed before the route is locked.
- **Local Baseline Comparison** - Every selected lane must compare against the local project reality before dispatch: canonical agents and skills, contracts, capability indexes, runtime mirrors, package scripts, MCP config, OS/runtime matrices, and project memory.
- **Graphify Agent Equipment** - Project agent profiles now treat Graphify as a navigation and subgraph-slicing capability, not as a full-context dump. Runs use existing graph artifacts when present, inject only worker-relevant slices, verify claims against source files, and rebuild the graph after mutations.
- **Conversation Notice** - Governed runs now emit localized, human-readable notices for ordinary requests so users can see what is happening without knowing packet names or command syntax.

### Fixed

- **Natural-language entry** - Durable human requests no longer require words like `meta-theory`, `Critical`, or `Fetch`. Product-building requests enter the governed path automatically, while pure read-only questions stay lightweight.
- **OpenClaw and Cursor contribution gate** - OpenClaw or Cursor changes now require strict tool-side self-test evidence before merge.
- **Orchestration output clarity** - The orchestration summary now exposes project agent ids, pinned capability profiles, external evidence requirements, and local baseline requirements in a way maintainers can inspect.

### Verification

- `node --test tests/meta-theory/31-capability-gap-orchestration.test.mjs`
- `node --test tests/meta-theory/34-run-deliverables.test.mjs`
- `npm run meta:sync`
- `npm run meta:release:smoke`
- `npm run meta:graphify:rebuild`
- `git diff --check`

## [2.8.8] - 2026-06-09

### Solved Problem

This release addresses reports and platform claims that were technically correct but hard for users to interpret. Tool support levels, durable-agent boundaries, and runtime target sources are now described in plainer terms.

### Changed

- **Tool-facing report language** - Public meta-theory reports kept the protocol labels but paired them with plain-language explanations.
- **Runtime target honesty** - Claude Code and Codex are described as fully supported. OpenClaw and Cursor are described as formal compatible projections with stricter contribution evidence requirements.
- **Durable agent boundary** - Temporary subagents are described as factory or review workers, not as the project agents being created.
- **Tool target source** - Reported tool targets now come from runtime compatibility data instead of hardcoded names.

### Verification

- `npm run meta:sync`
- `npm run meta:check`
- `npm run meta:providers:validate`
- `npm run meta:hook:validate`
- `npm run meta:route:validate`
- `npm run meta:runtime:validate`
- `npm run meta:release:smoke`
- `git diff --check`

## [2.8.7] - 2026-06-09

### Solved Problem

This release addresses capability discovery that was too narrow and too tool-name driven. Fetch now records project/global inventories across supported projections before Thinking chooses owners or loadouts.

### Changed

- **Cross-tool Fetch discovery** - Fetch now records explicit project and global capability inventory evidence before Thinking across Claude Code, Codex, Cursor, and OpenClaw.
- **Provider scanning parity** - Global discovery covers settings, hooks, skills, prompts, rules, MCP config, package scripts, and workspace agents across the supported tool projections.
- **Runtime skill projection stability** - Runtime sync preserves cross-tool Fetch checklist wording instead of rewriting paths into the wrong projection.

### Verification

- `npm run meta:sync`
- `npm run meta:route:validate`
- `npm run meta:capabilities:smoke`
- `npm run meta:check:runtimes`
- `npm run meta:test:meta-theory`
- `git diff --check`

## [2.8.6] - 2026-06-05

### Solved Problem

This release addresses capability-gap handling as a loose script task instead of a complete product workflow. Gaps now have decision contracts, replay evidence, user-facing deliverables, runtime evidence hardening, and report hygiene.

### Added

- **Capability Gap productization** - Capability Gap handling became a product workflow with decision contracts, output contracts, real-input replay, orchestration board validation, and acceptance gates.
- **Run deliverables** - Governed runs gained user-visible deliverables, trend panels, approval panels, GitHub gap reports, verification packets, research reports, capability browsers, DAG/scheduler reports, worker output reports, and product delivery bundles.
- **Runtime evidence hardening** - Runtime checks gained live shard matrices, Cursor live boundary contracts, OpenClaw batch stability evidence, Codex timeout recovery evidence, and complex replay scenarios.
- **Reusable project-file inventory skill** - Added the project-local inventory skill for repeated same-set file analysis.

### Fixed

- **Portable hook sync** - Project Claude hook commands remain repo-relative while global hooks keep slash-normalized absolute commands.
- **Stale report hygiene** - Generated reports moved out of tracked docs paths, and risky cross-project batch updating was removed.
- **PRD closure alignment** - The complete-product guard now tracks the current completed backlog instead of stale unfinished markers.

### Verification

- `npm run meta:sync`
- `npm run discover:global`
- `npm run meta:check:global`
- `npm run meta:check`
- `npm run meta:graphify:rebuild`
- `npm run meta:release:smoke`
- `npm run meta:verify:all`
- `git diff --check`

## [2.8.5] - 2026-06-03

### Solved Problem

This release addresses release checks being either too slow for small wording changes or too weak for runtime/security work. Release modes now distinguish fast routine checks from stricter release-grade evidence.

### Added

- **Release modes** - Low-risk prompt, documentation, and governance wording changes now use a fast release path. Install, runtime, hook, provider, dependency, package, security, and live-evidence work still require the stricter release-grade path.
- **Execution-demand proof** - Release-grade work must prove the Fetch -> Thinking route selects owner, agent provider, skill provider, MCP provider, command/runtime tool, and verification path before mutation or release.
- **Live evidence classification** - Structural smoke, warnings, skipped/needs-auth states, and true runtime live passes are now separated.

## [2.8.4] - 2026-06-02

### Solved Problem

This release addresses execution routes that could proceed without proving owner, provider, tool, and verification readiness. Capability smoke and OpenClaw live sharding now make real route readiness testable.

### Added

- **Capability discovery smoke** - Added a smoke command that proves a real execution demand can naturally select owner, provider, tool, and verification path.
- **OpenClaw live sharding** - Long Claude/OpenClaw live checks can be split by agent for recovery and diagnosis.

### Fixed

- **Execution routing** - Engineering execution routes now bind real owner/provider/verification evidence before Execution.
- **OpenClaw live evaluation** - OpenClaw checks inherit the configured provider/model surface and recover better from nested JSON and session output.
- **OpenClaw auth hydration** - Local OpenClaw auth can reuse an existing usable meta-agent auth source without overwriting working files.

## [2.8.3] - 2026-06-02

### Solved Problem

This release addresses provider discovery being scattered across tools, hooks, skills, plugins, MCP, memory, and graph surfaces. The provider registry gives those surfaces a shared lifecycle and validation model.

### Added

- **Capability Provider Contract** - Added a provider registry and lifecycle model for runtime-native tools, skills, agents, hooks, commands, rules, plugins, MCP servers, dependency projects, memory, and graph providers.
- **Provider validator** - Added validation for provider/runtime/OS/install-layer gaps, including strict global Codex hook checks.

### Fixed

- **Codex HookPrompt chain** - The global Codex prompt hook now preserves existing planning hooks while ensuring HookPrompt output reaches model context.
- **Plugin visibility** - Plugin and plugin-bundle providers are represented in the capability index and provider registry.

## [2.8.2] - 2026-06-02

### Solved Problem

This release addresses runtime support claims that were hard to compare or too easy to overstate. Compatibility data now records sync behavior, native-surface claims, package targets, and candidate probes separately.

### Changed

- **Runtime compatibility catalog** - Runtime support data was normalized into a catalog with sync behavior, native surface claims, and package targets.
- **Candidate runtime handling** - Non-primary tools such as opencode, Qwen, Zed, Gemini, CodeBuddy, Antigravity, JoyCode, and Qoder are tracked honestly as install targets or candidate probes rather than overstated full projections.

## [2.8.1] - 2026-06-02

### Solved Problem

This release addresses public docs that did not clearly separate supported, compatible, and candidate runtime states. README and runtime-facing docs now make those states easier to explain and verify.

### Changed

- **Public runtime support wording** - README and runtime-facing docs were aligned so supported, compatible, and candidate states are easier to distinguish.
- **Projection sync clarity** - Project-local and global sync behavior became easier to explain and verify.

## [2.8.0] - 2026-06-01

### Solved Problem

This release addresses tool-name routing that could ignore provider readiness, runtime support, OS support, dependencies, and verification ownership. Meta_Kim shifted toward provider-first governance with release evidence built into the normal flow.

### Added

- **Provider-first governance** - Meta_Kim shifted from tool-name routing toward provider and capability routing.
- **Runtime and OS evidence gates** - Execution routes now check runtime support, OS support, dependency state, owner, weapon, and verification path before acting.
- **Install and release evidence** - Setup, sync, runtime, provider, and release checks became part of the normal release story.

## [2.7.0] - 2026-06-01

### Solved Problem

This release addresses governed work starting from agent names instead of capability needs. Capability-first routing, owner/loadout evidence, and runtime alignment became the default shape for execution.

### Added

- **Capability route governance** - Introduced capability-first execution routing, owner/loadout evidence, and provider discovery as the default shape for governed work.
- **Runtime alignment** - Claude Code, Codex, OpenClaw, and Cursor projections were aligned around canonical source data while preserving honest runtime limitations.

## [2.6.x] - 2026-05-29 to 2026-05-30

### Solved Problem

This release band addresses governance outputs that were difficult to audit after the run. Reports, status envelopes, research preparation, capability inventory, and global discovery became more visible and source-backed.

### Added

- **Governed execution reports** - Added richer run reports, status envelopes, and public-facing evidence surfaces.
- **Research and capability preparation** - Added source-backed research preparation, retrieval capability discovery, and multi-type capability inventory.
- **Global capability discovery** - Added broader scans for installed agents, skills, hooks, commands, MCP config, plugins, and runtime mirrors.

## [2.5.x] - 2026-05-28

### Solved Problem

This release band addresses decisions that lacked shared gates for runtime, OS, dependency, weapon, trigger, intent, and choice-surface evidence. The decision engine and architecture docs made those checks explicit.

### Added

- **Governance decision engine** - Added runtime capability, OS compatibility, dependency capability, weapon routing, trigger-action policy, intent amplification, choice surfaces, dynamic lens selection, and decision-pattern contracts.
- **User-facing architecture docs** - Expanded documentation around runtime capability, dependency discovery, owner/weapon routing, and choice surfaces.

## [2.4.x] - 2026-05-27 to 2026-05-28

### Solved Problem

This release band addresses research and integration work influencing route design without enough retrieval or contract evidence. Research capability evidence, integration packets, unknown-field handling, and run-status output were added.

### Added

- **Research route hardening** - Research work now requires retrieval capability evidence before it can influence route design.
- **Interface integration contracts** - Third-party and internal API integration work gained explicit contract packets, unknown-field handling, evidence refs, and review gates.
- **Run status surface** - Added localized run-status output for public governance state.

## [2.3.x] - 2026-05-26

### Solved Problem

This release band addresses workers claiming tests, command success, or silent success without structured proof. Execution evidence and validation schema structure were tightened.

### Added

- **Evidence integrity contracts** - Worker claims about tests and command success now need structured execution evidence.
- **Silent-success handling** - Commands that succeed without output are represented by exit-code evidence rather than fabricated placeholder text.
- **Validation contract structure** - Validation rules were moved toward reusable schemas and runners.

## [2.2.x] - 2026-05-25

### Solved Problem

This release band addresses governance vocabulary and agent creation being too loose for durable execution. Workflow packets, naming policy, dispatch evidence, agent factory rules, and sub-agent boundaries were made explicit.

### Added

- **Workflow contract expansion** - Added packet vocabulary, naming policy, dimension definitions, dispatch evidence, and business-flow tests.
- **Agent factory governance** - Project-local execution agent creation now requires capability gap evidence, governance participation, and review before durable files are written.
- **Sub-agent boundary rules** - Meta agents govern, review, and route; they do not become generic implementation workers.

### Fixed

- **Worker write-completion honesty** - Workers with declared file scope must report each promised file as completed, skipped, or failed.
- **Historical release-note accuracy** - Earlier low-level release-note mistakes were corrected, then folded into this reader-facing format.

## [2.1.x] - 2026-05-23 to 2026-05-24

### Solved Problem

This release band addresses ambiguous work entering orchestration before the user choice and public-ready boundary were clear. Critical, Fetch, verification, summary closure, and deliverable-chain gates became more explicit.

### Added

- **Choice and confirmation flow** - Critical and Fetch gained clearer gates for ambiguity, candidate paths, and user confirmation before detailed orchestration.
- **Public-ready gates** - Verification, summary closure, and deliverable-chain closure became explicit requirements before claiming completion.

## [2.0.x] - 2026-04-11 to 2026-05-23

### Solved Problem

This release band addresses the need for a reusable cross-runtime governance architecture rather than scattered prompts and one-off runtime files. Meta_Kim 2.x established the core spine, projections, memory, Graphify, setup/update, packaging, and governance-agent foundation.

### Added

- **Meta_Kim 2.x architecture** - Established the 8-stage spine, 11-phase business workflow, hidden governance packets, runtime projections, memory layers, Graphify support, setup/update flow, and capability boundaries.
- **Cross-runtime projection system** - Canonical sources can project into Claude Code, Codex, Cursor, and OpenClaw files.
- **Install and packaging foundation** - Added setup, sync, status, package whitelist, runtime asset projection, local overrides, and project/global install modes.
- **Meta agent team** - Introduced the governance agents such as Warden, Conductor, Genesis, Artisan, Sentinel, Librarian, Prism, Scout, and Chrysalis.

### Fixed

- **README and architecture clarity** - Documentation was repeatedly tightened so the project explains the difference between the 8-stage execution spine, the business workflow, contracts, gates, and runtime projections.
- **Runtime mirror drift** - Sync checks and validation reduced drift between canonical sources and projected runtime files.

## [1.x] - 2026-03-22 to 2026-04-11

### Added

- **Initial governance model** - Established the early meta-agent architecture, workflow vocabulary, and reusable governance concepts that became Meta_Kim 2.x.
- **Early documentation and examples** - Added first public README material, diagrams, and release notes.

## [0.x] - 2026-03-17 to 2026-03-21

### Added

- **Project seed** - Started the repository and first experimental Meta_Kim workflow assets.
