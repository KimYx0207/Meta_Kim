# Qoder CLI beta compatibility adapter

Qoder CLI is represented here as `qoder`, a `beta_compatibility` candidate. This
file and `src/runtimes/qoder/candidate-adapter.mjs` are a packed structural
adapter only. They are not a Meta_Kim formal runtime projection, do not enter
`meta:sync`, and do not install or activate Qoder configuration.

The adapter accepts only explicit, independently observed probe facts. It does
not discover `qodercli`, start a process, invoke a model, contact a network,
read or write local files, alter settings, start an MCP server, or consume
model/API quota. Its plan is deterministic, deeply frozen, and fail-closed;
all authorization fields remain `false`.

## Officially documented mapping surface

The following entries are documented Qoder CLI locations or interfaces. A
documented path is not proof that a local installation loaded it, and this
adapter does not probe those paths.

| Surface | Project scope | User scope / alternate entry |
|---|---|---|
| Instructions and rules | `AGENTS.md`, `AGENTS.local.md`, `.qoder/rules/**/*.md` | `~/.qoder/AGENTS.md`, `~/.qoder/rules/**/*.md` |
| Skills | `.qoder/skills/{skill-name}/SKILL.md` | `~/.qoder/skills/{skill-name}/SKILL.md` |
| Subagents | `.qoder/agents/{agent}.md` | `~/.qoder/agents/{agent}.md`; one-shot `qodercli --agents <json>` |
| Prompt commands | `.qoder/commands/{command-name}.md` | `~/.qoder/commands/{command-name}.md`; invoke as `/{command-name}` |
| Settings and hooks | `.qoder/settings.json`, `.qoder/settings.local.json` | `~/.qoder/settings.json` |
| MCP | project/user settings `mcpServers`, optional `.mcp.json`, `qodercli mcp` management | User settings or explicit CLI configuration |

Qoder's documented planning entry is `/plan` or
`qodercli --permission-mode plan`. The adapter records this as a structural
plan-only command; it must never execute that command. Automation modes such as
`auto`, `accept_edits`, `bypass_permissions`, `dont_ask`, `yolo`, and
`dangerously-skip-permissions` are forbidden by the adapter plan.

## Probe fact envelope

Callers must provide a small fact record, for example:

```js
{
  runtimeId: "qoder",
  probeId: "probe:qoder:structural",
  evidenceRefs: ["evidence:qoder:official-docs"],
  capabilities: {
    rules: { status: "verified", observedPaths: [".qoder/rules/**/*.md"] },
    skills: { status: "verified", observedPaths: [".qoder/skills/{skill-name}/SKILL.md"] },
    agents: { status: "verified", observedPaths: [".qoder/agents/{agent}.md"] },
    commands: { status: "verified", observedPaths: [".qoder/commands/{command-name}.md"] },
    hooks: { status: "unknown" },
    mcp: { status: "unknown", configAuthority: "unknown" }
  }
}
```

Missing, unknown, or unverified facts keep the result `fail_closed`. Secrets,
credentials, raw prompts/model output, ambient discovery, accessors, and
unknown fields are rejected. Even verified facts authorize no execution,
configuration write, MCP write/autostart, hook claim, or formal promotion.

## Official references

- [Qoder CLI memory, rules, and instruction paths](https://docs.qoder.com/cli/memory)
- [Qoder CLI Skills](https://docs.qoder.com/cli/Skills)
- [Qoder CLI Subagent](https://docs.qoder.com/cli/subagent)
- [Qoder CLI Commands](https://docs.qoder.com/cli/commands)
- [Qoder CLI Hooks](https://docs.qoder.com/cli/hooks)
- [Qoder CLI MCP reference](https://docs.qoder.com/cli/mcp-reference)
- [Qoder CLI configuration scope](https://docs.qoder.com/cli/config-scope)
- [Qoder CLI plan mode](https://docs.qoder.com/cli/plan-mode)
- [Qoder CLI permissions](https://docs.qoder.com/cli/permissions)
- [QoderAI official Agent SDK samples](https://github.com/QoderAI/qoder-agent-sdk-samples)

These sources establish reusable capability primitives only. Promotion requires
a separate reviewed runtime profile/layout, merge-safe install/update/uninstall
policy, and independent live acceptance.
