# Current research and unselected alternatives

Date: 2026-11-15. Scope: the current-research and comparison changes prepared for v3.15.0, with the existing v3.14.0 evidence kept separate.

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

## Verified main baseline and v3.15.0 documentation

The previously incomplete CI follow-up is now resolved for the exact source commit `d251e9dd676d2a1acd84dfb51b7b5cec2a5fc584`. All four required repository workflows completed successfully:

| Required workflow | Exact-source run |
| --- | --- |
| Main CI | [43660319244](https://github.com/KimYx0207/Meta_Kim/actions/runs/43660319244) |
| Runtime evidence review | [43660319245](https://github.com/KimYx0207/Meta_Kim/actions/runs/43660319245) |
| README visuals | [43660319240](https://github.com/KimYx0207/Meta_Kim/actions/runs/43660319240) |
| Graphify | [43660319294](https://github.com/KimYx0207/Meta_Kim/actions/runs/43660319294) |

These are results for that main baseline. They do not certify the later v3.15.0 documentation and version edits; the publisher must bind those edits to their own final source CI and package check. The successful Graphify workflow also does not rewrite the earlier local rebuild failure recorded above.

The system panorama now connects current online and external repository research to viable alternatives, an existing or new material decision, system and module design in one PRD, project-owned specialist capabilities, dependency-based work, verification and scoped revision. Live is shown across the flow as the place to inspect evidence, progress and results. Its four translations and stable public SVG filenames are generated by the existing `scripts/build-readme-animations.mjs`; the overview is an explanatory diagram, not a record of a live business run.

The v3.14.0 full-gate limitation remains unchanged: [the earlier verification record](project-specialization-20261115.md) records missing original Claude Code/Codex host observations and an incomplete forward browser trial. This iteration does not claim native-host acceptance, paid-model evaluation, a complete `meta:verify:all` pass or measured business outcomes.

### Local documentation checks

- The shared builder's read-only check passed for all 48 localized diagrams. The public-asset validator passed for all 68 README image references.
- All four new panorama SVGs were rendered with Inkscape. Text measurements checked every card and connector against the rendered text bounds; the static layout had no text outside cards and no connector through text. This is a static layout check, not browser or native-host acceptance.
- `npm version 3.15.0 --no-git-tag-version --ignore-scripts` updated the package and both shrinkwrap root versions. The current verification record is included in the package file list.
- `meta:release:smoke` initially stopped because this checkout lacked full Git history. A normal `git fetch --unshallow origin main` resolved that prerequisite. The next run passed project sync and the migration catalog check, then stopped at capability discovery because this environment did not supply a selected execution route, specialist/creation providers, MCP/tool selection and verification method. The later meta-theory stage was not run by that command. Final-source repository CI and the publisher's package checks remain separate evidence.
- A separate `npm run meta:test:meta-theory` invocation completed on the v3.15.0 working tree: **1,683 tests, 1,678 passed, 0 failed, 5 existing skips**, across 165 suites in 292.896 seconds. This supplies the stage omitted after capability-discovery failure; it does not turn the combined smoke command into a pass.
- `npm pack --dry-run --json --ignore-scripts` listed 784 package files and confirmed inclusion of this verification record and all four panorama SVGs. This checks the package file list, not installation or execution of a published package.
- Final `git diff --check` passed.
