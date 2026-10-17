# ZCode beta compatibility adapter

ZCode is `beta_compatibility`, not a Meta_Kim runtime projection. This folder is
an opt-in packed structural adapter boundary only. It is not read by `meta:sync`, is
not installed as a ZCode configuration, and does not grant ZCode native,
headless, hook, MCP, or model-execution support.

The companion adapter at
`src/runtimes/zcode/candidate-adapter.mjs` accepts only an explicit probe-fact
record. It does not discover a ZCode executable, read or write files, spawn a
process, call ZCode, start an MCP server, contact a network, or consume model
or API quota.

The accepted fact envelope is deliberately small:

```js
{
  runtimeId: "zcode",
  probeId: "probe-id-from-an-independent-observation",
  evidenceRefs: ["opaque-evidence-ref"],
  capabilities: {
    headless: { status: "verified", observedModes: ["plan"] },
    hooks: { status: "unknown" },
    mcp: { status: "unknown", configAuthority: "unknown" }
  }
}
```

Facts that are missing, unknown, or unverified remain fail-closed. The adapter
always emits a plan with:

- `beta_compatibility` and `formalProjection: false`;
- packed structural adapter evidence only; it is not live-certified or native;
- headless `zcode --mode plan` only; `build`, `edit`, and `yolo` are forbidden;
- no model invocation or process-spawn permission;
- no hook-support claim;
- an MCP preserve-user merge plan only, with no whole-file replacement and no
  automatic service start;
- all seven authorization fields set to `false`.

Promotion requires a separate reviewed runtime-projection work item. Packaging
or verifying this beta adapter must never be interpreted as runtime activation
or formal sync support.

## Confirmed path facts (2026-10-17, tier unchanged)

Independent probes no longer need to rediscover these; verify currency instead:

- User scope: `~/.zcode/*` (agents, skills, commands, `AGENTS.md`,
  `cli/config.json` for MCP/hooks) applies to every workspace.
- Workspace scope: `<repo>/.zcode/*` applies to the project;
  `.agents/*` works as a compatible fallback for skills/commands/MCP.
- Agents: `.md` definitions with Claude-style frontmatter
  (`name`/`description`/`tools`); user `~/.zcode/agents/{agent}.md`,
  workspace `<repo>/.zcode/agents/{agent}.md`; plugins may contribute agents.
  Verified live: a 65-file user-scope set was loaded by an interactive host
  as dispatchable subagents (see catalog evidence `host_observation`
  2026-10-17).
- Conflicts: same-named resources resolve first-match, user scope beats
  workspace; within a scope `.zcode` is scanned before `.agents`.
- Hooks: config-file hooks require `hooks.enabled: true`; seven documented
  events.
- MCP: `mcp.servers` in user/workspace config; user overrides workspace;
  all scopes auto-connect at session start.

Source: zcode-plugins-official/zcode-guide 0.3.0 (skill
`zcode-configuration-guide`) plus the live observation above. These facts
upgrade path/format knowledge only — they do not change the tier, unlock
formal sync, or grant execution permissions.
