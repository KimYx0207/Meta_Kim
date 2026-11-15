# Owner Resolution

Capability-first dispatch order:

1. canonical capability index
2. runtime mirror indexes
3. project runtime agent inventory
4. local global agent inventory
5. available capability providers: skills, commands, hooks, rules/prompts, MCP tools, runtime tools, plugins
6. external discovery when allowed

## Ladder

existing owner -> owner upgrade -> create owner -> `capabilityGapPacket`.

Degraded path: when no Agent dispatch exists and no owner matches, record `capabilityGapPacket` with `currentAgentsChecked`, `currentProvidersChecked`, and `degradationReason`. Enter `controlState=degraded`. The dispatcher may self-execute only with `degradedFlag: true`, `publicReadinessState=internal-ready`, and runtime `surfaceState=notice` or `silent`.

Do not use temporary fallback owners. Do not persist concrete child skills into long-term agent identity; keep concrete skill/provider selection run-scoped.

Use [native host interaction](native-host-interaction.md) for the current client's dispatch, child-to-parent work orders, result collection and recovery. A child lacking delegation tools returns the bounded work order to its native parent; this does not by itself make the selected owner or the whole host unavailable. A second client is not a required dependency.

## Existing agent discovery evidence

Before `upgrade_existing_owner`, `create_owner_first`, `upgrade_execution_agent`, or `create_execution_agent`, Thinking must receive an `ownerDiscoveryPacket` from Fetch. It must name the checked repo canonical owners, runtime mirror owners, project runtime agents such as `.codex/agents/*.toml`, local global inventory agents, and reusable capability providers such as skills, commands, hooks, rules/prompts, MCP tools, runtime tools, and plugins. Empty or unavailable sources are still evidence and must be recorded with a blocker or no-impact reason.

Critical, Fetch, Thinking, and Review governance nodes are covered by the governance-stage policy in `workflow-contract.json`; they are not execution agents. Execution agents may be reused directly only when the discovery evidence shows a fitting global or project-local owner. A skill or tool provider may satisfy the capability without requiring a new owner. If no fitting owner or provider exists, write the checked owners/providers into `capabilityGapPacket.currentAgentsChecked` before factory work starts.

For default execution-demand proof, owner discovery is only the first segment. Thinking must also bind:

- execution owner search and final owner selection
- execution-agent creation provider or explicit `creation_not_needed`
- skill search and selected skill/provider
- skill creation provider or explicit `creation_not_needed`
- MCP provider search and selected MCP provider or no-impact reason
- command/runtime tool selection
- verification owner and verification method

This chain must be present before mutation for release-grade install/update/sync work. Routine low-risk releases may use the lighter maintainer smoke route when the user asks for speed and the change does not alter install, runtime, hooks, provider, dependency, package, or security behavior. A release-grade route that discovers only an owner and leaves skill, MCP, command/tool, or verification choice to later validators is incomplete.

## Scan cadence and UX

Use a two-speed discovery model:

- Full global scan: run on install, update, explicit user refresh, missing cache, cache older than 14 days, missing required provider evidence, or high-risk provider routes. Persist results to the local global capability inventory.
- Per-run scan: do not full-scan the machine. Read the cached global inventory, perform a lightweight project scan of known runtime directories and config files, and expose only counts, top candidates, source refs, and refresh hints.

If cache freshness could change the route, show one short user-facing hint with the refresh command. If the last full scan is older than 2 weeks, tell the user this run will update first to match newly added content and reach the best capability route, then refresh before execution. Do not dump the full provider catalog into chat or worker packets; load full definitions only after Thinking selects a provider for the current run.

## Agent Teams Playbook

The authoritative stage DAG plus the runtime's native Agent/Task/`spawn_agent` surface is sufficient for fan-out. `agent-teams-playbook` is an optional adapter after Thinking: select it only when it improves orchestration, record `not_required` when there are fewer than two ready lanes, and record `optional_adapter_not_selected` when native fan-out is sufficient. Unsafe lanes remain pending or serialized; the absence of this optional adapter is not degraded mode. A selected provider remains `selected_not_invoked` unless a live Skill/Agent Team/`spawn_agent` call is attached as evidence.

## Use when

Use when a task needs owner, weapon, dependency, runtime, OS, or verification routing before Execution.

## Required inputs

- `intentPacket`
- `fetchPacket.capabilityDiscovery`
- `ownerDiscoveryPacket`
- weapon registry
- dependency registry
- runtime and OS matrices

## Do

- `meta-conductor` searches owner candidates in canonical index, runtime mirrors, local inventory, installed skills/tools, then external discovery.
- `meta-conductor` separates stage governance owners from execution owners; Critical/Fetch/Thinking/Review coverage proves governance readiness, not implementation ownership.
- `meta-artisan` matches weapon and invocation path.
- `meta-scout` labels dependency evidence and support confidence.
- Output owner + weapon + dependency + runtime + OS + verification owner.

## Do not

- Do not use `general-purpose`, runtime nickname, or governance agent as implementation owner.
- Do not route reference-only or missing-invocation dependencies into execution.
- Do not delete low-score dependencies.

## Required packet

`ownerResolutionPacket`: `ownerDiscoveryPacket`, `candidateOwners`, `candidateWeapons`, `candidateDependencies`, `runtimeFilterResult`, `osFilterResult`, `rankedRoutes`, `recommendedRoute`, `blockedReasons`, `capabilityGapPacket`.

## Pass

- `recommendedRoute.score >= 85`.
- owner, weapon, runtime, OS, verificationOwner, and verificationMethod are non-empty.
- callable dependency has invocationPath and verificationMethod.
- create/upgrade routes include checked existing agents and the reason each did not fit.

## Fail

- owner missing, weapon missing, verificationOwner missing, fake owner, runtime alias owner, or governance agent implementation route.

## Block

Block Execution if runtime or OS is unsupported, dependency is reference-only, or no rollback/verification path exists.

## Return to stage

Return to Thinking for route gaps. Return to Fetch when support evidence or dependency status is unknown and route-changing.

## Verification

Run `npm run meta:route:validate` and inspect `npm run meta:capabilities:route -- --task "<task>" --runtime <runtime> --os <os> --json`.

## Writeback

Write repeated missing owner/weapon/dependency patterns to `config/capability-index/*` or `capabilityGapPacket` with `nextRunReuseKey`.

## Preserve

Preserve skills, WebSearch/browser/research, shell, filesystem, apply_patch, MCP, memory, graph, hooks, commands, runtime tools, and runtime-native abilities.
