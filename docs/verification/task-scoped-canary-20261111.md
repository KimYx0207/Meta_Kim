# Task-scoped canary and fuse review

Reviewed on 2026-11-11 against the release worktree based on `3a7a762`.

## What changed

Three actual Hook failures were reproduced before repair:

| Case | Previous behavior | Current behavior |
| --- | --- | --- |
| The same role-allocation notice in an old run | Default `progressive` switched from warning to denial after seven days, without any outcome measurement. | Run age and legacy grace-day variables do not escalate role notices. Explicit strict mode remains available. |
| Read-only diagnosis of an affected task | A task-bound `git status` or `git diff` was denied before reaching the read-only branch. | Pure inspection remains available; a compound command containing a write still meets the task fuse. |
| A registered serial task in a two-task chain | The presence of two work orders was treated as a parallel fan-out request. | One bound registered trial with no other active worker can proceed. Its successor waits for current prerequisite criterion results. Explicit parallel requests keep the independent-lane checks. |

The result fuse already existed in the task-progress ledger. This release uses that authority instead of creating a second warning counter or timer. Two ineffective terminal attempts on the same task, route and evidence basis require a scoped correction. Independent work remains eligible. Questions, waits and transport outcomes with unknown business results do not count as ineffective results.

Checkpoint inspection and the durable runner now expose the recorded state as `canary`, `open`, `recovery_trial` or `observed_progress`. A task permits one in-flight attempt. The corrected strategy must supply its own result evidence before its progress is reported. `observed_progress` is criterion progress, not a complete product acceptance verdict. External effects are not automatically retried or rolled back by this Hook.

## Design references

The following first-party sources were read on 2026-11-11:

- [Argo Rollouts analysis](https://argoproj.github.io/argo-rollouts/features/analysis/) separates dry-run metrics from blocking outcome analysis, and distinguishes inconclusive results from success and failure. Applied here: advisory policy notices do not become failure observations, and missing outcome evidence is not a successful trial.
- [Flagger's controller workflow](https://docs.flagger.app/usage/how-it-works) evaluates measured outcomes against thresholds while retaining the stable workload. Applied here: a small trial, observable results and a scoped stop. Meta_Kim uses its existing task correction flow; this change does not install a Kubernetes rollout controller or promise automatic restoration of arbitrary external actions.

## Verification

`tests/setup/task-scoped-hook-fuse.test.mjs` invokes the real Hook in temporary projects. It covers elapsed time, explicit strict mode, the first and second ineffective attempts, independent edits, pure and compound shell commands, replacement versus old work orders, failed recovery, one active attempt, serial prerequisites and the retained parallel gate.

The relevant existing suites cover task-progress deduplication and evidence, durable restart and independent-task admission, the eight-stage Hook contract, canonical source projection and Hook dependency closure. Exact release-wide results are recorded with the release verification artifact. These local tests exercise the real Node Hook and result reducer without paid model calls.

The complete Meta Theory suite finished with 1,666 passes, five conditional skips and no failures (1,671 tests). The complete governance suite had 1,139 passes, 39 conditional skips and one failure caused by the current-version changelog being edited concurrently. Its unchanged 17-test release-evidence file passed after the documentation update. The focused Hook/projection/task-progress set passed all 213 tests; the final five-case Hook regression also passed after adding explicit multi-criterion and other-active-task coverage. These overlapping results are not added together as unique tests.

## Verification runner repair

Review of the release command found a separate reproducible bug: `meta:check` and the Graphify stage passed displayed `&&` chains as arguments to one `npm` invocation. npm preserved those tokens as arguments, so subsequent checks could be omitted even when the stage exited successfully. The stage definitions now contain ordered command/argument arrays. Each subcommand runs without a shell, shares the stage timeout budget and retains its own exit result in the report. The first failed command stops the remaining commands.

`tests/governance/verification-command-sequence.test.mjs` runs the actual verification entrypoint against an isolated npm project. It verifies all four checks execute in order, failure of the first or second check prevents later checks, Graphify rebuild is followed by its verifier, and argument values containing spaces or shell punctuation remain literal. The existing structural assertions now inspect the executable stage definitions instead of matching old source-code string literals.

The command-sequence, release-evidence, gate-inclusion, isolated-global-check and release-tier files passed all 41 tests after the repair. The source-pin check and test inventory also passed.

## Official CLI format check

Preparing the isolated installation reproduced another unnecessary rejection. The official npm package `@anthropic-ai/claude-code@2.1.322` installed a Linux ELF payload under `bin/claude.exe`. Direct `--version` returned `2.1.322 (Claude Code)` with exit zero in an isolated environment without provider credentials, but Meta_Kim rejected the `.exe` name before running the same probe. The eligibility check now recognizes ELF and Mach-O formats for their applicable platforms before considering the filename suffix. Actual PE files, Windows launcher scripts and native binaries for an incompatible platform remain ineligible.

The three affected CLI-probe and executable-binding files passed 30 tests with five platform skips and no failures (35 tests). They include a real native executable copied to an `.exe` payload, PATH discovery through a launcher, actual version execution and inventory readback. Installation and version-probe evidence does not certify model task performance. The official installation method and version check were verified against [Claude Code setup documentation](https://code.claude.com/docs/en/setup).

## Source and deployment scope

The changed Hook and shared task-progress implementation use their existing projection dependencies. No new package or Hook entrypoint was added. Runtime source hashes are refreshed through the existing maintainer command. The scope of native Hook enforcement remains the host's supported Hook surface; loading DSH Skills does not establish DSH Hook enforcement.
