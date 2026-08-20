# Trae beta compatibility adapter

Trae is `beta_compatibility`, not a Meta_Kim runtime projection. This folder is
an opt-in packed structural adapter boundary only. It is not read by
`meta:sync`, is not installed as Trae configuration, and does not grant native
Trae execution, hook, MCP, or model support.

The companion adapter at
`src/runtimes/trae/candidate-adapter.mjs` accepts only an explicit probe-fact
record. It does not discover a Trae installation, contact a network, invoke a
model or process, read or write configuration, call an MCP tool, or consume
model/API quota.

## Official fact boundary

These official Trae documentation pages are the source-backed inputs for a
future probe. They describe capability surfaces, not a Meta_Kim projection
contract:

- [Rules](https://docs.trae.ai/ide/rules)
- [Skills](https://docs.trae.ai/ide/skills)
- [Create and manage custom agents](https://docs.trae.ai/ide/agent)
- [Model Context Protocol](https://docs.trae.ai/ide/model-context-protocol)
- [Memories](https://docs.trae.ai/ide/memories)
- [Official TRAE repository](https://github.com/Trae-AI/TRAE)

The documented surfaces include:

- project Rules under `.trae/rules/`, with Markdown content and documented
  application properties such as `alwaysApply`, `description`, and `globs`;
  global Rules have a platform-specific user location. Rules can also import
  project-root `AGENTS.md`, `CLAUDE.md`, and `CLAUDE.local.md`.
- project Skills under `.trae/skills/{skill-name}/SKILL.md`, global Skills under
  the user `.trae/skills` directory, and the convention-based `.agents/skills/`
  directory. Skills are loaded on demand and may contain supporting files.
- custom Agents configured through TraeCode with a prompt, callable identifier,
  call conditions, MCP servers, and built-in tools. The official page does not
  establish a stable exported agent file path.
- IDE and SOLO product modes, without a documented on-disk mode configuration
  contract for this adapter.
- MCP servers using `stdio`, SSE, or Streamable HTTP transports. The official
  page does not establish a stable project MCP file path or serialized config
  format for this adapter.
- global and project Memories stored locally under user-scoped Trae memory
  locations. Memory files are user-owned and are not written by this adapter.
- a Skills & Commands settings surface, without a stable command file path or
  command schema established by the official pages used here.

The adapter therefore keeps unprobed paths, formats, hooks, and command
behavior unknown. A fact that is absent, `unknown`, `unverified`, or
`not_observed` produces a fail-closed plan rather than an inferred support
claim.

## Example probe envelope

```js
{
  runtimeId: "trae",
  probeId: "probe:trae:official-docs",
  evidenceRefs: ["https://docs.trae.ai/ide/rules"],
  capabilities: {
    instructions: { status: "verified", observedPaths: ["AGENTS.md"] },
    rules: { status: "verified", observedPaths: [".trae/rules/"] },
    skills: { status: "verified", observedPaths: [".trae/skills/{skill-name}/SKILL.md"] },
    agents: { status: "verified", observedModes: ["custom", "@Agent"] },
    modes: { status: "verified", observedModes: ["IDE", "SOLO"] },
    mcp: { status: "verified", transportTypes: ["stdio", "SSE", "Streamable HTTP"] },
    commands: { status: "unknown" },
    memory: { status: "verified", observedModes: ["global", "project"] },
    hooks: { status: "not_observed" }
  }
}
```

Every emitted plan remains `beta_compatibility` with `formalProjection: false`,
empty managed paths, and no install or sync eligibility. It always forbids
model invocation, process spawning, command execution, MCP tool invocation,
MCP auto-start, configuration writes, whole-file replacement, hook claims, and
formal runtime promotion. All seven authorization fields are `false`.

Packaging or verifying this asset and its adapter proves only a packed
structural adapter. It must never be interpreted as Trae runtime activation,
formal sync support, installed-user acceptance, or live certification.
