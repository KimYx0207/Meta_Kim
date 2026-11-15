# Current research and unselected alternatives

Date: 2026-11-15. Scope: changes after v3.14.0, recorded under Unreleased.

## Problem and behavior

An explicit request for current online research and external GitHub research must reach actual retrieval in the current host. A reference list or the project's own repository is insufficient for that request. Host preparation and the canonical research method now state this directly, including publication versus observation dates, stable release versus development source, relevant implementation reading, and user/business alternatives before a build choice.

Previously, a populated research `decisionContext` required a selected alternative. `phase: comparison` now allows evidence-backed alternatives and an optional conditional recommendation while leaving `selectedAlternativeId` absent. Its question must belong to the existing material user decision frontier. An exploration can use this research; a delivery design that consumes its sources retains a pending-choice gap until a successor research record represents the resolved choice.

An optional, user-evidenced `constraints.maxSourceAgeHours` bounds source observation age. Normalization reports stale evidence, and dispatch rereads check the selected source's age again. This does not establish publication freshness, applicability or authenticated tool execution. The host must actually retrieve and review those facts. Legacy records without new optional fields retain their previous digest and selection rules.

## Focused regression evidence

Command executed after the implementation change:

```sh
node --test tests/governance/project-research.test.mjs tests/governance/project-professional-entry.test.mjs tests/governance/research-current-comparison.test.mjs
```

The first focused run passed **14 tests, 0 failed, 0 skipped**. The five new regressions first failed against the previous behavior, then passed after the fix. Existing coverage includes immutable evidence, legacy digests, the ordinary professional entry, and discovery/load/reuse of project-owned methods.

The new cases cover observation-age limits, conditional recommendations without selection, the existing material decision frontier, exploration versus delivery, and expiry during a later read without invalidating an unrelated fresh source. `git diff --check` passed after the code changes.

Independent review found that a fresh selected source could still carry a decision context supported by another source that had since expired or aged out. The normal required-research design gate already reports that stale source; the direct reread API needed the same scope. A sixth regression reproduced the missing rejection. Rereads now check all supporting sources carried with that topic's decision, preserving independent source-only reads and unrelated topics.

The final run of the command above passed **15 tests, 0 failed, 0 skipped** after that correction. No unrelated full local regression suite was repeated.

The actual updated Kim_Service source was also discovered as `verified_local` with 61 Agents. The three new ecommerce, global-expansion and short-drama methods loaded as `structured_method_loaded`, including default professional references and verified full component hashes. This confirms local source integration, not native-model invocation.

GitHub CI at `0291c9ee1f7b4adbc35333dcecba5bf9596597e2` subsequently found that the production knowledge registry still bound the previous core-loop contract bytes. The two new policy fields were reviewed again against the historical source and upgraded through the existing candidate, exact approval binding and repository CAS path. Registry revision 18 retains the old entry and transition history; identical replay is idempotent. No source rule, assertion or gate was relaxed. The focused command `node --test tests/meta-theory/79-knowledge-lifecycle-hygiene.test.mjs` then passed **16 tests, 0 failed, 0 skipped**. This corrects the observed registry drift; the earlier failed CI run is not reported as successful.

## Repository maintenance observations

- `discover:global` completed. Its local inventory reported missing configurations for several optional clients; discovery is not a claim that those clients are installed or accepted.
- `meta:sync` updated the selected Claude/Codex project projections, and `meta:check` passed runtime projection, sync coverage, source privacy and all seven project integrity checks.
- `meta:graphify:rebuild` was attempted but could not bind non-ASCII IDs to an installed Graphify Python runtime in this environment. No successful graph rebuild is claimed.
- `meta:check:global` did not pass: the temporary environment lacks matching global package authority, installed global projections and a valid setup launch inventory. This is separate from the passing project-source checks and is not presented as a full release gate.

## Claims and limits

This record reports deterministic local behavior and the stated host instructions. It does not claim a complete `meta:verify:all` run, native-model acceptance, automatic search by every host, complete industry coverage, or successful business outcomes. Actual market and repository research for ecommerce, global expansion and short drama is recorded in Kim_Service's dated research notes with source-reading and execution boundaries.

An observation-age threshold is chosen for the task; it is not a universal research quota. A recommendation remains conditional when the user's budget, assets, market, audience or risk tolerance could change the route. Further research returns to the affected question; it does not reopen already settled unrelated work.
