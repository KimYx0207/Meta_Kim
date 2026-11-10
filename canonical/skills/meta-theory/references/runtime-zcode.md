# ZCode runtime binding

## Use when

This reference is for Z.ai / Zhipu's ZCode ADE (https://github.com/zai-org/ZCode), not Zed or a GLM model endpoint used through another host. Canonical responsibility and workflow sources remain the single source of truth.

## Required inputs

Read the actual host tool inventory, trusted project root, selected install scope, native/fallback MCP configuration and existing install manifest. Governed work also requires the current pending artifact, task identity and intent/revision bindings.

## Native surfaces and boundaries

- Skills: `.zcode/skills/<name>/SKILL.md` and `~/.zcode/skills/<name>/SKILL.md`. Required metadata is `name` and `description`; keep descriptions within the documented 1024-character limit. Refresh Skills in the host after installing or updating.
- Agents: `.zcode/agents/*.md` and `~/.zcode/agents/*.md`; the existing 2026-10-17 observation of user agent discovery remains historical host evidence. Generated definitions use `model: inherit` and `injectAgentsMd: true`. Tools inherit the parent's actual tools and permissions; ZCode wildcard behavior differs from Gemini. Children cannot recursively dispatch children, so orchestration stays with the parent.
- Rules: workspace `AGENTS.md` and `~/.zcode/AGENTS.md`. Preserve user-authored rules and the host's instruction precedence.
- Native config: project `.zcode/config.json`; user `~/.zcode/cli/config.json`. MCP servers use `mcp.servers`. If native MCP is nonempty, the same-scope `.agents/mcp.json` fallback is not merged by ZCode; Meta_Kim carries fallback definitions into its reversible merge so adding one native server cannot hide existing user servers.
- Hooks execute only from user config or enabled plugins. **Current ZCode ignores project hooks.** Project projection therefore writes no hook registration. Global hooks require `hooks.enabled: true`, events under `hooks.events`, and native `type: "process"` with `command` plus `args`. Claude settings are not executable ZCode hook configuration.
- Keep `~/.zcode/v2/` model-provider settings, credentials and telemetry outside this installer. The installer neither chooses a model nor grants payment, account or external-action authority.

## Do

Use the current host to produce Critical, Fetch and Thinking for the existing governed entry. Carry forward the actual pending artifact, revision bindings, source references, decisions and task identity. The data-contract examples in `runtime-codex.md` remain reusable; Codex-native tool names and question UI do not. Discover ZCode's actual agent and tool inventory before dispatching. Where a native-only capability is unavailable, record that boundary and use only an already supported conversation fallback; do not fabricate acceptance.

The hook adapter maps native events to the existing governance core and maps its output back to ZCode's documented protocol. A temporary `transcript_path` is not durable conversation proof. Native task graph/session readers remain the existing read-only integration; projection installation does not promote the historical beta candidate planner to execution authority or certify a headless runner.

## Do not

Do not register project hooks, pass Claude settings as native ZCode configuration, infer recursive delegation, or fabricate host/session proof. Do not mutate account/provider state under `~/.zcode/v2/`, choose a paid model or grant external-action authority.

## Required packet

Reuse the existing Critical/Fetch/Thinking inputs, work orders and `hostInvocationRequestPacket` with their current bindings. Installation records exact file ownership and managed JSON fragments in the existing manifest; native task-graph projections remain read-only observations.

## Pass

Projection passes when install/update/check proves the native file/configuration shapes, execution dependency closure and user-configuration preservation. Live verification requires fresh actual host discovery, decision, bounded task invocation/result and outcome checks in the current session.

## Fail

Fail a project hook registration, missing native adapter dependency, hidden fallback MCP definition or overwritten user field. Fail an execution claim based only on a beta plan, a projected file, temporary transcript path or fixture output.

## Block

Block conflicting owned-fragment updates and unsupported native execution. When the needed host tool, permission, session proof or executor is absent, retain the pending work and precise capability gap; installing the projection does not clear that gap.

## Return to stage

Return to Fetch when current host inventory or official hook scope is unknown; to Thinking when an owner/route/tool must change; and to Critical for a changed goal or acceptance standard. Keep settled decisions bound to the same intent unless evidence invalidates them.

## Verification

Use target `zcode` with the existing project/global sync entry. Global hooks are explicitly included with `--with-global-hooks`. Re-run the same entry for update and `--check` for structural validation. Exact managed JSON fragments are recorded in the existing manifest; update/uninstall preserves other settings and refuses to overwrite changed owned fragments. The current uninstall entry applies its documented scope, not a new per-runtime selector.

Open a new ZCode session after changes; hook settings are snapshotted at session start. Refresh Skills, inspect the projected nine agents and verify an ordinary intent through an actual host decision and bounded task. Keep `projection_implemented` separate from `live_verified`. No paid CLI or model invocation is part of structural tests.

## Writeback

Record exact installation mutations in the existing ownership manifest and actual work in the bound run/checkpoint. Keep projection evidence separate from live acceptance, with unavailable live proof explicitly unverified; route reusable changes through the existing Evolution review.

## Preserve

Preserve canonical governance, user rules/settings, fallback MCP definitions, runtime-sedimented capabilities, shared execution-package references and account state. Retain the older dated project-hook observation as historical evidence with its limitations, alongside the current official restriction.

## Primary documentation

- https://zcode.z.ai/en/docs/skill
- https://zcode.z.ai/en/docs/subagents
- https://zcode.z.ai/en/docs/hooks
- https://zcode.z.ai/en/docs/mcp-services
- https://zcode.z.ai/en/docs/qa

Reviewed 2026-11-10. The current hook restrictions supersede the scope interpretation of the older bundled zcode-guide observation; retain that record with its date and limitations.
