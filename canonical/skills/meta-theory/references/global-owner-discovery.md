# Global-First Owner Discovery

Capability discovery is **global-first**, not project-local-first. Fetch consults the relevant layers where a reusable owner can live before Thinking selects the owner. Named dispatch without discovery evidence is a design shortcut, not the canonical method. The main thread is the discovery orchestrator; independent discovery may run in parallel inside Fetch.

This reference is the long-form companion to `SKILL.md` § **Global-First Owner Discovery**. `config/contracts/core-loop-contract.json` is the single authority for scan scope, `capabilityDiscovery.fullScanTriggers`, stage order and stage-internal parallelism; `dev-governance.md` explains that contract. Normal discovery uses cached global inventory plus a project-light scan and stop-on-match once a qualified provider fits. The source catalog below does not require a full scan on every run.

## Use when

Use this reference on every non-query meta-theory run, before Thinking names an owner. It applies whenever the route needs an agent, skill, command, MCP tool, runtime tool, hook, plugin, or dependency owner. It does not apply to pure read-only queries where no owner is dispatched.

## Required inputs

Discovery requires: the **capability needed** (e.g. "frontend Next.js", "graph code review", "i18n string extraction"); the **runtime** in scope (claude / codex / cursor / openclaw); the **architecture type** (Meta vs project-technical); and the **project profile** (canonical assets present, active targets, local overrides). Without a capability statement, discovery cannot start.

## Do

Use the six source families below as a catalog, consulting route-relevant cached inventory and project evidence in locality order. Match by **capability and boundary**, not by agent title. Record actual sources checked (including empty results), cache references and reasons for skipping route-relevant sources in `dispatchEnvelopePacket.capabilityInventory`. Stop when a qualified provider fits; perform a full applicable scan only when the machine contract's `fullScanTriggers` applies. Prefer a global owner that already fits over creating a project-local copy. When multiple candidates match, prefer the most local durable owner, then the one whose scope already includes the architecture type.

## Do not

Do not hardcode an agent name before discovery. Do not skip a route-relevant unresolved source without a reason, or report an unscanned path as freshly checked. Do not silently synthesize a new owner when a global one fits. Do not copy a reusable global asset into the project when `use_global_directly` applies. Do not emit local absolute home paths in route reports.

## The six global discovery sources

Source catalog, considered in order of locality then priority under the machine scan policy:

1. **Local canonical assets** — `canonical/agents/`, `canonical/skills/`, `canonical/runtime-assets/shared/`, `canonical/runtime-assets/<runtime>/`. These are the durable sources of truth for Meta_Kim and must be searched first for any meta-owned capability.
2. **Capability indexes** — `config/capability-index/` and the runtime capability-index mirrors under `.claude/capability-index/`, `.codex/capability-index/`, `.cursor/capability-index/`. These are query-first indices that resolve capability → owner without reading every agent file.
3. **Global runtime homes** — `~/.claude/agents/`, `~/.claude/skills/`, `~/.codex/agents/`, `~/.cursor/agents/`, `~/.openclaw/`, `~/.agents/`. A reusable global owner that already matches the boundary wins over creating a project-local copy.
4. **Package scripts and local inventory** — `package.json` `scripts`, `bin/`, `scripts/`, and the local runtime inventory inside the project root. These often expose registered tools, MCP providers, and shell entry points that are themselves owners.
5. **MCP / runtime configs** — `.mcp.json`, `~/.mcp.json`, `.codex/config.toml`, `.cursor/mcp.json`, runtime adapter templates. MCP tools are first-class owners; capability matching must enumerate them.
6. **External discovery** — `findskill` / `meta-scout` / third-party registries, package indexes, and web research. Used only when sources 1-5 have no fit; the result must surface a `capabilityGapPacket` and a proposed owner creation/upgrade, not silent synthesis.

## Capability-first matching

The search query is the **capability needed** (e.g. "frontend Next.js", "graph code review", "i18n string extraction"), not the agent name. Match by boundary, not by title. The result of discovery is a shortlist of owner candidates with file refs, never a hardcoded dispatch.

Use the read-only, bounded query entrypoint instead of relying on the host to list
every installed skill in one prompt:

```sh
meta-kim capability search --query "code security review" --runtime codex --type agents --limit 5 --json
meta-kim capability search --query "安全审查" --keyword security --keyword review --runtime codex --type skills --limit 5
```

`--keyword` may be repeated up to eight times to add domain terms or translated
synonyms. Types include agents, skills, commands, tools, hooks, plugins and their
cached index types; `tools` searches MCP and runtime-tool entries. Runtime
filtering is exact (`codexapp` is distinct from `codex`). Canonical entries without
declared runtime coverage remain reference candidates only in an unfiltered query.
The result contains bounded descriptions, portable source references, qualified
provider identity, source/collision provenance, and the terms and fields that
matched. It reuses the inventory's source-aware winner and explicit alias mapping;
different providers with the same name remain distinct.

The command reads the existing global inventory and packaged canonical index. It
does not rescan runtime homes, read all capability bodies, access the network,
install, create, select or invoke providers. Missing/malformed indexes yield an
explicit gap; caches older than seven days are marked stale, and future timestamps
are disclosed. The output names the existing `discover:global` refresh command;
refresh is a separate explicit action. `--inventory` and `--canonical` permit
read-only queries against explicit index files, and `--profile` selects a global
state profile. A no-match query is a gap to refine or record, never an excuse to
guess an owner.

Relevance scores only order text matches. They are not the 85-point provider
qualification gate, native support, safety approval, or execution evidence. Check
the candidate's current source and task boundary before choosing it, then retain
the actual native dispatch result and worker artifact separately. A cached match
remains `not_invoked`, even if its cached definition was valid when discovered.

When multiple candidates match:

- Prefer the most local durable owner (canonical asset > capability index > global home > local).
- Among ties, prefer the agent whose scope statement already includes the current architecture type.
- If a global owner fits without modification, dispatch to it. Do not copy it into the project.

## Cross-runtime portability

Discovery must be cross-runtime portable. Use repo-relative refs, runtime ids, or home-relative refs such as `~/.codex`, `~/.claude`, `~/.cursor`, `~/.openclaw`, `~/.agents`. Do not emit local absolute home paths in route reports. See `dev-governance.md` § **Capability Discovery And Owner Resolution** for the runtime-portable reporting contract.

## When the gap is real

If the relevant existing inventory sources (1-5) return no qualified fit:

- Source 6 (external discovery) is consulted only with recorded reason and routing impact.
- The result is a `capabilityGapPacket` with `capabilityNeed`, `globalCandidateChecked[]`, `recommendedAction` (`create` / `upgrade` / `accept_reference_only`), and `ownerCandidate`.
- The run does not silently synthesize a new agent. Owner creation is governed by Type B (see `SKILL.md` § **Type B: Agent / Skill / Owner Creation Or Upgrade**).

## Required packet

The dispatcher merges `dispatchEnvelopePacket.capabilityInventory` at the Fetch stage boundary before Thinking closes its owner route. Independent discovery inside Fetch may run in parallel. Required fields: `searchLog[]` (actual consulted sources with checked-at, result count, top candidates or cached-inventory references, and reasons for skipping route-relevant sources), `capabilityInventory` (route-relevant agents / skills / commands / hooks / mcp / runtime-tools / plugins / dependencies), `ownerCandidates[]` per capability need, and `selectedOwner` with boundary-fit reason. A `capabilityGapPacket` is emitted when no qualified existing owner fits.

## Pass

Discovery passes when `capabilityInventory` is written, `searchLog` identifies the actual consulted sources and cache evidence (empty results recorded explicitly), route-relevant omissions have reasons, each capability need has at least one candidate or a recorded gap, and the selected owner is a real provider (not `general-purpose`, not a governance agent acting as implementation worker, not a runtime alias). A qualified match may end further discovery under the machine contract.

## Fail

Discovery fails when the inventory is missing, when `searchLog` omits a route-relevant unresolved source without a reason or claims a fresh scan that did not occur, when an owner is named without search evidence (hardcoded dispatch), or when a selected owner is `general-purpose` / a runtime alias / a governance agent used as an implementation worker. Review rejects fake discovery on the same chain, not via a separate gate.

## Block

Block (return upstream, do not advance to Execution) when sources 1-5 return no fit and source 6 is unavailable or `blocked`. Emit a `capabilityGapPacket` with `recommendedAction` and surface the blocker to the user through the native choice surface. Do not guess an owner to unblock.

## Return to stage

On fake discovery or missing inventory: return to **Fetch** to complete the missing route-relevant discovery under the machine scan policy. On a real capability gap: return to **Thinking** with the `capabilityGapPacket` to decide `create` / `upgrade` / `accept_reference_only`. On a `general-purpose` or alias owner: return to **Thinking** to re-resolve against the inventory.

## Verification

Verification confirms the inventory exists, `searchLog` identifies actual consulted sources and cache freshness with reasons for route-relevant omissions, each `ownerCandidate` resolves to a real file or provider, and the selected owner's boundary fits the capability need. Check full-scan coverage only when `capabilityDiscovery.fullScanTriggers` applies. `capabilityInvocationProbePacket` may record readiness for callable local families, but it never proves that the selected provider binding was invoked and never satisfies product-experience live evidence.

## Writeback

When discovery surfaces a recurring new owner class that no existing provider owns, write the gap through the Type B pipeline (`GapDecision = create_agent` + `GeneratedAgentSpec` review). When a global owner is repeatedly partial, write an `upgrade_existing_owner` signal. Stale inventory older than 14 days triggers a refresh on the next run.

## Preserve

Preserve global runtime homes (`~/.claude`, `~/.codex`, `~/.cursor`, `~/.openclaw`, `~/.agents`) — discovery reads them, never deletes them. Preserve foundational capabilities (Skills, WebSearch, browser, MCP, memory, graph, hooks, commands, runtime tools) even if risky or unavailable; mark them instead. Preserve runtime-native abilities for every runtime; discovery may add boundaries but never replaces native surfaces.
