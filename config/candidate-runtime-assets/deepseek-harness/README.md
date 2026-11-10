# DeepSeek Harness beta compatibility preset

This beta asset directory is design-time only. It records the opt-in DeepSeek
Harness preset boundary for a packed structural adapter; it is not a runtime
projection, install target, global configuration, MCP launch recipe, or UI
adapter. It is disabled by default and is not live-certified.

DeepSeek Harness is treated as a developer preview where breaking changes are
possible. ACP is retained only as an automation transport seam. It does not
prove a complete Harness UI, native runtime support, live model acceptance, or
installed-user acceptance.

ACP is an automation structural seam only, not a complete Harness UI or native
runtime. The adapter must receive explicit probe facts for version and features. A
missing fact remains unknown and blocks the plan. Probe code must not install,
start, invoke, spend quota, write files, overwrite user configuration, or
retain credentials/raw model output.

## Native host integration

The separate `meta-kim dsh install|update|check|uninstall` entry now owns the
native DSH profile/patch, Skill projection and MCP configuration. Its contract
is documented in `canonical/skills/meta-theory/references/runtime-dsh.md`.
This older candidate-preset API remains non-authorizing design-time input;
installing native Skills does not turn its planning result into execution
authority, native custom-agent registration, Hook enforcement or model acceptance.
