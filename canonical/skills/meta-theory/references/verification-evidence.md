# Verification Evidence

Never accept "I tested it" without evidence.

Every verified claim must answer:

- who tested it
- what was tested
- exact command/check or manual inspection method
- output/log/screenshot/artifact location
- failure disposition

## Worker Evidence

`workerTaskPackets[].verifySteps[].id` is the source of truth. `workerResultPackets[].workerExecutionEvidence[].verifyStepRef` must match one verify step.

`status=skipped` is only a blocked/accepted-risk signal. It cannot support `verificationPacket.verified=true` or `summaryPacket.publicReady=true`.

`successMarkerFormat`:

- `stdout-text`: non-empty output required.
- `exit-code-only`: exit code 0 and `commandRanAt` required.
- `json-output`: `actualOutput` must parse as JSON.

## Live Evidence Classification

Classify runtime evidence before claiming a live pass:

- `structural_smoke`: projection, config, schema, hook registration, matrix, startup, or non-live evaluator checks.
- `ui_warning_or_system_message`: visible warning, UI notice, or systemMessage-like output without a verified target-runtime invocation artifact.
- `skipped_or_needs_auth`: auth, model, config, permission, or environment blocker with a retry path.
- `runtime_live_pass`: real target-runtime invocation with a recoverable assistant/tool artifact and runtime-specific scoring or verification tied to that artifact.

Only `runtime_live_pass` supports a runtime-live claim for the observed artifact. Structural smoke, systemMessage/UI warnings, skipped states, config-only proof, auth-present checks, and matrix entries may support diagnosis or readiness, but they cannot be relabeled as live. A `runtime_live_pass` is still not the optional highest-assurance `live-certified` claim unless a separate private-attested observer joins every exact selected binding. If a live check times out, produces no recoverable assistant/tool artifact, or depends on a different backend than the declared runtime, classify it as incomplete.

## Fix Evidence

`verificationPacket.fixEvidence[]` is structured:

- `findingId`
- `actionId`
- `verifiedBy`
- `verificationMethod`
- `evidenceRefs`
- `resultArtifactRef`
- `result`
- `failureDisposition`
- `riskOwner`, `riskReason`, `expiryOrRevisitTrigger` when `result` or close state is `accepted_risk`

Closed findings require matching fix evidence.

## User-Facing Closure Evidence

Do not finish with only "done" or a plain-language restatement. The final user-facing closure must explain:

- root goal
- what this run did
- whether the work still fits the root direction
- whether the delivery is complete, partial, blocked, or deferred
- whether complexity was added or avoided, and why
- why changed
- what changed / where changed
- user impact
- verification evidence
- remaining limits
- deferred or not-done work
- next action

If no file changed, say that and cite the inspected evidence. If the route changed from the user's surface request, state the product reason.

Minimum closure template:

```text
Root goal:
This run did:
Direction fit:
Delivery completeness:
Verification:
Complexity:
Deferred / not done:
Next action:
```

Rule: a run that only reports files, commits, or passing tests without the root goal and completeness judgment is not closed. A partial foundation must be named as partial; do not let it sound like the product goal is fully achieved.

Release assurance has three explicit tiers:

1. Routine low-risk releases use smoke evidence by default: projection sync, default capability-discovery smoke, meta-theory tests, whitespace diff check, changelog/release-note readiness, and exact git/release artifacts.
2. Standard full releases use `npm run meta:verify:all` for install/update, global sync, hooks, runtime matrix, provider registry, dependency compatibility, runtime probes, package contents, security-sensitive behavior, or explicit full verification requests. A complete passing run is sufficient to publish an ordinary release. Include the declared runtime target set and evidence for update/install, project sync, global sync, global hooks if in scope, runtime matrix, provider registry, dependency compatibility, runtime evaluation/probes, default execution-demand route proof, changelog/release-note readiness, and security audit. After publication, upload the exact npm tgz and run `meta-kim release audit --tag <tag> --verification-report <report> --package-file <tgz> --require-exact`; attach the resulting `published_bound` record to the Release. The audit must bind the local and GitHub annotated tag object plus peeled commit, commit tree, clean source snapshots, Release URL, asset SHA-256, and the byte-exact npm candidate the clean full gate installed/tested; matching only package name, version, or `package.json` is insufficient. Failed attempts remain append-only, and historical dirty/missing reports stay `published_artifacts_bound_verification_unbound` with `promotionEligible=false`.
3. Optional highest-assurance certification uses `npm run meta:verify:live-certified`, which appends private-attested external-observer exact-binding clean-room verification. Missing attestation blocks only the `live-certified` label; it does not invalidate a separately passing standard `meta:verify:all` release.


## Use when

Use when verified claims, public-ready evidence, and userGoalDone closure affects route, owner, risk, acceptance, verification, public-ready, or evolution writeback.

## Required inputs

- Latest user request and `intentPacket`
- `fetchPacket` evidence that changes decision
- runtime and OS targets when tools or dependencies are involved
- relevant config, registry, script, or artifact path

## Do

- Assign an owner for each action.
- Produce a checkable packet or artifact.
- Bind pass/fail to evidence, threshold, or command output.
- Preserve existing foundational and native runtime capabilities.

## Do not

- Do not delete skills, dependencies, web/browser/research, shell, filesystem, apply_patch, MCP, memory, graph, hooks, scripts, runtime tools, or native platform abilities.
- Do not use vague advice without trigger, output, evidence, and writeback.
- Do not route reference-only or unknown dependencies into execution.

## Required packet

`referenceContractPacket`: `referenceId`, `trigger`, `requiredInputs`, `actions`, `outputs`, `passCriteria`, `failCriteria`, `blockConditions`, `returnStage`, `verification`, `writebackTarget`.

## Pass

- At least one action has owner, input, output, and verification.
- Pass criteria include numeric threshold, required field list, command, artifact, or human acceptance record.
- Unsupported, unknown, or partial capability is marked rather than removed.

## Fail

- Instruction is only theory or roleplay.
- No block condition exists for missing evidence, unsupported runtime/OS, fake owner, or missing verification.
- Public-ready can be claimed without userGoalDone and evidence.

## Block

Block Execution when owner, weapon, dependency eligibility, runtime support, OS support, verification owner, or rollback boundary is missing. Block public-ready when verification evidence, intent acceptance, writebackDecision, or high/critical closure is missing.

## Return to stage

Return to Critical for intent gaps, Fetch for evidence/support gaps, Thinking for route gaps, Execution for missing artifact, Review for open findings, Verification for missing proof, and Evolution for missing writeback.

## Verification

Run the most specific validator for this reference plus `npm run meta:prompt:validate`. Use command/log/artifact/human acceptance evidence, not a narrative claim.

For `live-certified` capability claims, use a clean-room host run with isolated HOME/runtime homes and TMP/TEMP, a packaged source snapshot, no sibling dependency checkout, no global inventory injection, and a blind business prompt that does not name or hint at the expected capability families or concurrency. Keep a pure read-only `fast_path_control` separate from a durable-artifact `governed_execution` scenario; the control must not be used to demand fan-out, and the governed scenario must not inherit the answer through prompt wording. Readiness probes prove callability only. A host transcript parser may report `orchestration_observed`, but it cannot promote its own report to `live-certified`. Highest-assurance certification requires a separate post-process verifier with private observer attestation and externally observed successful request/result events joined to every exact selected binding. Fixtures, self-authored hashes, self-tests, caller-supplied trust flags, generic shell calls mislabeled as Commands, and synthesized worker results are forbidden substitutes. This external signature is not a prerequisite for a standard release whose `meta:verify:all` run passed.

## Writeback

Write durable improvements to canonical references, governance configs, capability indexes, validators, tests, or scars. If no durable change exists, record `none-with-reason`.

## Preserve

Preserve Skills, WebSearch/browser/research, filesystem, shell, apply_patch, MCP, memory, Graphify, graph, hooks, commands, rules, agents, subagents, approval, sandbox, runtime tools, package scripts, setup, sync, install, uninstall, status, doctor, validators, and runtime projections.
