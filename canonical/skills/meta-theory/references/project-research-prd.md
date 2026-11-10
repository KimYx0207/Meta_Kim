# Project context, research and one PRD authority

## Use when

The order remains Critical -> Fetch -> Thinking -> Execution -> Review -> Meta-Review -> Verification -> Evolution. A bounded read-only project scan precedes Critical; it is not another stage. Its manifest/script declarations are evidence to inspect, not proof that a project builds, that a language is fully detected or that the host understood it. The packet records source hashes, module directories, declared versions, entry scripts, tracked/untracked worktree paths and explicit truncation/unavailability. Never run unknown project scripts just to classify a project. No manifests does not prove a directory is a new project: preserve `unclassified_existing_material` and inspect relevant files.

Use the existing requirements dialogue and decision frontier. Resolve inspectable facts yourself. Compare genuinely different feasible product mechanisms only when they exist; one feasible solution explains its constraints, and a settled small change needs no alternatives ceremony. Compare the same user scenario and constraints, including state, credentials, recovery and maintenance costs. Keep explicit requests/prohibitions and settled choices distinct from assumptions and assistant preferences. A recommendation or elapsed time never becomes user approval. Walk the whole experience and probe key feasibility risks before delivery modules; Thinking then maintains the one authoritative PRD and outcome slices at the depth the task needs.

## Required inputs

`requirementsDiscoveryInput.research` uses the existing versioned record binding to the current task and intent, topics and selected sources. Research resolves a specific decision-changing unknown or an explicit user research requirement; a full design is not by itself a demand to collect repositories. Relevant existing evidence can be sufficient. No general minimum repository count, star count or prescribed channel pair establishes adequacy. Preserve task-specific research constraints actually requested by the user, while keeping recorded source counts separate from quality. Sources must answer their linked question; unrelated evidence cannot close it.

A topic records the question, applicable keywords/actual queries, selected source IDs and related decisions. Select channels for the question: official docs for supported capability/version, actual user flows for experience, source code for implementation, cases for transferable mechanisms and primary papers for findings. Read original material and retain the source's observation time, applicable revision, findings, mechanism/conditions, decision impact and adaptation limits. GitHub stars are optional discovery metadata, never quality evidence. For changeable claims preserve freshness and recheck at use time. Inaccessibility, contradictions and missing evidence stay explicit; a small probe can resolve an unknown. Evidence can justify retaining a design. Supplied metadata and summaries alone do not authenticate research or establish semantic relevance.

The current writer emits research `schemaVersion:2`. A topic's `decisionImpact` states what choice the answer affects; `status` is `resolved`, `unresolved`, `conflicting` or `not_applicable`. Resolved topics require a `conclusion` and linked source; not-applicable topics require a concrete reason. `constraints` may carry explicit user-evidenced `minimumSources`, `minimumGithubRepositories`, `minimumObservedStars` or `requiredChannels`; none has a default quota. Legacy v1 records remain immutable and readable as review-needed evidence. Their host-reviewed successor uses the current writer, never a second simultaneous decision source.

The ordinary API's `governanceTaskFacts`, or CLI `--governance-task-facts-input`, takes task-bound `governance-task-facts-v2`. Its `design` distinguishes uncertainty, coupling, operational risk and verification conditions; the existing intent/change/security/evidence facts remain separate. The host derives these facts from actual materials and uses the emitted template, rather than asking users for technical labels. Unknown facts return to host Thinking; changed intent/research invalidates inherited facts. Legacy v1 is diagnostic read compatibility, not a current dispatch authority.

## Do

The runner persists immutable `research-<digest>.json` files inside the trusted project artifact directory, rejecting path escapes, symlinks and changed existing bytes. Existing preparation artifacts retain the record during a user wait; later ordinary-entry calls recover research through the same requirements record. New evidence produces a new digest; older files and decision artifacts remain available through bounded read compatibility, never a second writer or decision authority. PRD `researchRefs` summarize the basis and task slices select only relevant IDs; unaffected tasks retain their concrete not-applicable reason. Unknown source IDs, stale selected evidence, unresolved decision-relevant gaps and missing task bindings affect readiness; repository popularity and a generic source count do not.

Workers receive selected `researchEvidence` entries containing a short finding, relevance, adaptation, URL/revision and `recordRef`/`recordSha256`/`researchDigest`. `readTaskResearchEvidence({projectRoot,evidence,taskHash,intentDigest})` validates the trusted path, current goal binding, immutable bytes, selected summary and source freshness before returning only the selected source entries. A source hash binds the record, not the truth of an external claim. Do not copy all research into every worker or create another task authority.

## Software architecture and module views

For software work, read [intent to delivery](intent-to-delivery.md). Optional `designInput.softwareDesign` adds an architecture baseline and detailed modules to this same PRD. `mode: exploration` allows architecture-only work and module outlines; `mode: delivery` requires evidenced technology versions, implementation details, acceptance coverage and actual interface/state boundaries. Worker context includes the relevant module's actual settled decisions and contracts. Module/architecture/decision changes feed the existing task dependency closure. No new queue or approval is created.

Current project context also includes `relatedCode`: a bounded source-navigation snapshot with current-byte hashes, literal references and explicit limitations. Static absence of callers does not authorize deletion; check entry points, dynamic/generated paths and external consumers first.

## Design and production input

The existing `designInput` can describe actual product `solutionOptions`, `selectedOptionId` and `selectionRationale`. These preserve the scenario, mechanism, user flow and tradeoffs; they do not attest user approval or prove semantic diversity. Optional `sharedState` and `interfaces` identify real task owners/consumers. Task slices use their existing journey/decision references and optional state/interface/domain-term references. These are normalized into the same `designDigest`, not another plan or PRD. Existing inputs without these optional additions retain their historical digest.

`projectDesignWorkerTasks` projects relevant complete journeys, selected solution/reason, decisions, terms, state/interfaces and artifact flows into `designContext`; `designBinding.contextDigest` joins it to the existing work order. Actual bridge preparation and native/injected dispatch recheck the task/design/source bindings. Slice input files are byte-bound under the project; an upstream artifact waits for the current producer, reported digest and actual readable bytes. Non-file references remain explicitly `reference_only`. Old design packets without current context return for migration/re-evaluation; stored history is preserved.

Existing worker packets carry their own `taskFacts` and `taskFactsSubject`, bound to their actual `todayTask`; design slices project the same assessment through the existing work order. A missing/unknown assessment, missing required design or missing decision evidence keeps that task pending. Current-bound independent ready work may enter the existing DAG while affected tasks and their real dependents wait; the batch remains partial until all required work is settled. Sensitive work still needs its separate verification and permission boundaries.

The actual dependency result text remains available as task data, with a labelled navigation preview. A preview must not replace necessary content. Already-truncated legacy output requires a complete current artifact or re-evaluation; existing output/process fuses fail explicitly. File hashes and complete context prove input integrity, not the model's comprehension, design quality or final user acceptance.

## Required packet

Use the existing requirements research record, normalized product design and worker work order. The Conductor is the merge owner; the selected professional capability produces design content. `designBinding.contextDigest` binds the task-scoped output context, not a new requirement authority.

## Do not

Do not manufacture alternatives, add source quotas, infer user approval from a selected option, or substitute complete fields and scores for actual design evidence. Do not silently treat truncated or unreadable sources as complete.

## Pass

The relevant decision has an evidenced conclusion or explicit not-applicable reason, explicit user research constraints are satisfied, and each ready worker can read its current related design and upstream material.

## Fail

An unresolved/conflicting decision, stale source, lost requirement, mismatched task/version or fabricated evidence cannot establish readiness. A numerical failure remains a real failure even when it is eligible for targeted repair.

## Block

Block the affected invocation for missing current task/design bindings, required unavailable inputs or unsafe paths. Keep actual permissions independent and retain unrelated ready work through existing DAG dependencies.

## Return to stage

Return missing facts to Fetch, unresolved material intent to Critical, and affected design/context migration to Thinking. Reuse existing decisions and evidence; do not restart unrelated work or the interview.

## Verification

Run the focused `product-context`, `project-research` and `numeric-revision` Node tests. Replay actual projection and bridge preparation; report native invocations and semantic/user acceptance separately from test-double and structural checks.

## Writeback

Change the owning normalizer, consumer, contract or canonical source when a defect is proved. Persist supporting evidence in the existing run records, never a second PRD or queue.

## Preserve

Keep old research bytes, task history, original user evidence, user configuration, permissions and unaffected completed outputs. Sync generated runtime mirrors from canonical sources rather than editing copies.

## Numerical acceptance

Use the existing structured `successCriteria` and `acceptanceCriteria`. A real numerical promise carries `criterion.measurement` with `kind`, `unit`, `scope`, `conditions`, `comparison`, `target`, optional `minimumSamples` and, for ratios, `expectedTotal`. Preserve this structure through intent evolution and PRD handoff. The host distinguishes performance/quality targets from incidental digits such as versions and phone numbers. Evaluators calculate counts, durations and ratios from samples, requiring each sample to meet the rule. Product outcome review additionally binds each sample's `evidenceRef` and `evidenceDigest` to an actual current artifact snapshot included in that observation. A supplied number or `pass` string is not measurement evidence or native execution proof.

## Reference adaptation reviewed 2026-11-04 (Asia/Shanghai)

These are method references, not new dependencies. All four repository metadata snapshots exceeded 100 stars; exact counts are time-bound observations, not quality scores.

| Original source and reviewed revision | Relevant method | Meta_Kim adaptation and limit |
| --- | --- | --- |
| [mattpocock/skills](https://github.com/mattpocock/skills/tree/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d), `skills/productivity/grilling/SKILL.md`, `skills/engineering/grill-with-docs/SKILL.md` | Independent dependency-ready question rounds, recommendation, discoverable facts read from sources; grill-with-docs explicitly composes grilling/domain-modeling | Reuse the existing decision frontier and requirements records. Do not assume a disabled invocation skill automatically loads or duplicate its workflow. |
| [github/spec-kit](https://github.com/github/spec-kit/tree/980f9c1550341e35672df17593ce2e5a792cb7d1), README | Separate idea/bug/product entry paths; specification before design/task execution | Size discovery to the request; keep one existing PRD/task authority rather than install another framework. |
| [bmad-code-org/BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD/tree/022be9314e4facd16826104a9f8033e1c5ed4fdc), README | Task-sized planning and documented decisions; existing-project context | Retain actual project facts and proportional work. Current main declares v7 alpha; do not treat its installer as stable v6 behavior. |
| [obra/superpowers](https://github.com/obra/superpowers/tree/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b), README | Clarify design before implementation, review design, then bounded work | Retain Meta_Kim's eight stages and authorization; do not import unrelated mandatory branch or full-suite policies. |

The reviewed `gsd-build/get-shit-done` README at `bdcaab2c752d9a33a1a1ca9acf3a3c81fb991815` redirects to `open-gsd/gsd-core`. It is a migration clue, not another reviewed implementation. These historical observations record what was inspected; their count does not define evidence sufficiency for another task. The two requested Matt skill files were read directly from their current original repository paths; no external code was copied.
