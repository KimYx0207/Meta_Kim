# DeepSeek Harness runtime

## Use when

Use this contract when installing, discovering, updating, removing or executing Meta_Kim and Kim_Service methods inside the official DeepSeek Harness host. Apply it before claiming that a DSH session loaded a Skill, delegated work, connected an MCP server or enforced a human gate.

This runtime is **DeepSeek Harness (DSH)**, the official `deepseek-ai/deepseek-harness` application. A DeepSeek model configured inside another application is not DSH compatibility evidence. The reviewed source is `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`, npm CLI `@deepseek-ai/dsh@0.2.2-rc.1`. DSH requires Node **>=24.9.0**; this does not raise Meta_Kim's minimum Node version for other hosts.

## Required inputs

- The actual host version, Node executable/version, effective DSH_HOME, current working directory, discovered project root and intended global/project scope. Use `canonical/runtime-assets/dsh/host-contract.json` as the reviewed integration contract; an unreviewed host version needs new host evidence.
- The existing `.meta-kim/install-manifest.json` and managed-file state, when present. Retain conflicts and user changes in the operation result; an absent ledger is not permission to adopt existing files.
- For Service methods, the exact built `--service-package` directory and its source identity. For execution, the selected native Skill, its `method.json`, all primary parts and applicable capability/method acceptance contracts must be readable from the actual host.
- The current session's discovered Skill catalogue, tool schemas, permissions, subagent preset/depth/model availability and MCP connection state. Separate observed surfaces from configuration that has only been generated.
- The current task intent, settled decisions, dependency and resource ownership boundaries, expected artifacts, acceptance criteria and human decision owner. Installation or a successful protocol probe does not supply missing task authorization.

## Do

### Native integration and installation

The normal CLI lists the dedicated integration:

```sh
meta-kim dsh install
meta-kim dsh check
meta-kim dsh update
meta-kim dsh uninstall
```

The default installs a separate `meta-kim` profile under `$DSH_HOME/profiles` (default `~/.dsh/profiles`), with the official base and Web bundles. It adds native Skills under `$DSH_HOME/skills`. It does not replace `web`, the home Cordis patch, model routes, credentials, permission policy, or user AGENTS.md. Start the installed profile with `dsh --profile meta-kim`, using the DSH_HOME reported by installation.

For a project, use `meta-kim dsh install --scope project --project-root /path/to/project`. Start DSH from that project using the returned `dsh --profile web --patch /path/to/project/.dsh/meta-kim/cordis.patch.yml` argv. Project Skills live in `.dsh/skills`. Keep the real user DSH_HOME active so the user's credentials and home configuration remain available. The reviewed filesystem provider scans the nearest ancestor containing a `.git` directory or worktree marker file, falling back to the launch directory. Installation/update refuses a child directory that the default provider would not scan, before writing files, and reports the correct root rather than silently relocating the installation. `check` diagnoses an existing installation whose root later becomes mismatched; `uninstall` still permits its managed cleanup. Root matching alone does not prove discovery: inspect the actual Skill catalogue, including custom-provider and shadowing behavior.

Pass `--service-package /path/to/built-service-package` to install the Kim_Service native Skill bundle, built by Kim_Service's `scripts/build-dsh-package.mjs`. Subsequent updates without this option preserve the existing Service projection. Pass the rebuilt package to update it. `--no-mcp` explicitly selects a Skills-only installation; it does not create an executable MCP binding. `--dry-run` plans without writing or materializing a package.

### Skills and complete method loading

DSH discovers one-level `<skill-root>/<name>/SKILL.md` entries. The integration creates one `meta-theory` dispatcher plus the **existing nine canonical governance roles**, as native Skills. These roles remain governance owners; business implementation methods come from Kim_Service or another discovered capability source. There is no invented `.dsh/agents` protocol and no persona-only preset pretending to contain the native tool stack.

Every entry is bounded below the reviewed standard preset's 8192-character result-pruner threshold. Its `method.json` points to a primary `partsIndex`; read every listed index page and part in order. Parts preserve the complete source with at most 6000 characters, 120 lines and 1500 characters per line, reserving room for DSH's line-numbered read envelope and avoiding the read tool's separate 2000-character line cap. Large indexes are paginated as well. Load **all primary parts** before using the method. Read the complete required capability/professional-method contracts through their indexes, including late outputChecks and acceptance rules. Load only relevant additional references, with original source directories as link bases.

Original bytes, contracts, reference trees, licenses and notices remain under the shared Skill's `source/` directory. Markdown, JSON, YAML, TOML, text, CSV and supported text-source files (JavaScript/TypeScript, Python, shell, PowerShell, SQL, HTML/CSS, XML and SVG) have sibling `<filename>.dsh-parts/index.json` views with source checksums. Read selected executable source through its complete bounded views when review is required; late rejection logic matters as much as the first lines. Execute the unchanged original script, never a part, and keep programmatic validators reading the original complete files. Short catalogue descriptions and partial JSON or source code are not substitutes for professional knowledge or acceptance rules.

DSH's `skill` tool reports a base directory; resolve relative resource paths against it. The loader does not attach references automatically. Check the actual catalogue and read the selected method/resources. Home Skills can be shadowed by project `.dsh/skills` or `.agents/skills`; a custom provider with `includeDefaultRoots: false` can omit the normal roots. Report this rather than silently changing the user's provider settings.

### Delegation and human decisions

Discover `subagent`, its current schema, the current preset, tool inventory, depth limit and available models in the actual session. When no `agentPreset` or `allowedAgentPresets` override is configured, DSH's local subagent joins the parent's current preset revision. Preserve that tool stack. Pass a task-local contract containing:

- exact selected role/skill and complete method resource paths;
- settled intent, relevant research and architecture/module PRD decisions;
- owned paths or output artifacts, inputs, dependencies and non-goals;
- actual tool/permission bindings and missing capability states;
- review criteria, evidence format, acceptance owner and escalation route.

The native `subagent` tool returns a start receipt. It is asynchronous; consume the terminal result or completion notification and evaluate the output before accepting it. The default depth limit is a host configuration, not a promise that arbitrary nested teams are available. A skill role name is not a preset ID. Do not send it as `agentPreset` without a separately verified native preset registration. Do not override model routing merely to make a test pass.

Use the actual host's question/approval surface when a material human choice is required. A waiting branch must keep its human gate pending; independent ready branches may continue if they do not depend on the answer or touch the same owned resources. Do not convert an unanswered question into an inferred approval. Bind terminal results and acceptance to the current task/run, not a prior run or static screenshot.

### MCP, Hooks and acceptance boundaries

The Cordis overlay inserts a unique `@deepseek-ai/dsh-mcp-client` entry with `serverName: meta-kim-runtime`, `transport: stdio`, an explicit Node executable and the verified immutable Meta_Kim package's `scripts/mcp/meta-runtime-server.mjs`. The CLI package already carries this official plugin at the reviewed revision. The overlay is JSON-form YAML and changes no existing Cordis row. Cordis replaces whole addressed configuration objects, so never merge a few guessed fields into a builtin preset.

MCP gives the current host a real protocol surface for methods, resources and supported tools. An MCP tool name is host-scoped, typically `mcp__meta-kim-runtime__<tool>`. Inspect the actual advertised schema and permissions; a server connection does not grant write/release approval. Canonical MCP resources may exceed the host's result-pruner limit: use the native Skill's bounded source indexes for complete instruction or contract loading, rather than treating a cropped MCP response as the full method. An installation command does not start DSH, connect to a model, or supply credentials.

This integration **does not install a native hard-enforcement Hook plugin**. The upstream Claude Code and Codex hook bridges are experimental, cover subsets, and can fail open on errors. They are not sufficient proof of Meta_Kim's blocking gates. This integration also does not add DSH to the existing Codex/Claude stage-runner adapter. A requested workflow that needs those machine gates or that stage-runner must retain the unavailable state and select an actually supported route with the user where necessary. Never mark that gate complete because the Skill tells the model to obey it.

Evidence levels remain separate: generated package integrity; actual DSH config/Skill loading; actual MCP connection; native delegation; task output and independent acceptance. Only claim the levels observed in the current version/configuration. Local no-credential probes can validate the first three without calling a model; they cannot certify the final two.

### Lifecycle, ownership and evidence

Files use the existing global/project `.meta-kim/install-manifest.json`, with `runtimeTarget: deepseek-harness`. There is no second authoritative install state. Source/purpose ownership and content hashes decide updates and removals. The same safe managed-file transaction writes projection files and the ledger together, with rollback and recovery. Symbolic links, junctions, path escapes, unowned files and changes to owned files are refused or preserved. Identical unowned bytes are not silently adopted. Updates remove obsolete **unchanged owned** files; user-modified obsolete files remain conflicts. Uninstall removes unchanged owned files, preserves user changes and unrelated files, and reports a partial result until conflicts are resolved. Empty directories and transaction backups may remain; they do not represent active Skills.

Executable references use the existing verified immutable package store rather than a checkout or transient npx directory. That package is shared with other Meta_Kim runtimes; DSH-only uninstall does not delete shared package storage. `check` verifies projection hashes and the executable package closure. It also reports whether the verified installation record configures MCP; missing or changed installation evidence yields `unknown`, not a claim that MCP is disabled. It reports file verification, never native execution acceptance.

The core `installation.json` and Service `projection.json` contain expected content paths. These indexes detect missing ownership records and incomplete resource trees; they do not authorize writes or removals. Ownership remains exclusively in the existing installation ledger. A remaining Service subset with no Meta dispatcher is reported as incomplete. Core-only updates preserve and count the already installed Service Skills.

## Do not

- Do not invent DSH agent directories, preset IDs, permission fields or Hook enforcement. Inspect native schemas before invoking a tool; keep the existing nine Meta_Kim roles as governance Skills.
- Do not use a catalogue summary, truncated resource, partial JSON or unread index page as the complete professional method. Do not silently fall back to another Skill when project shadowing changes the selected source.
- Do not count a subagent start receipt as completed work, an MCP connection as write permission, a pending human gate as approval, or local file verification as native execution acceptance.
- Do not rewrite user provider settings, credentials, model routing, unrelated files or modified owned files to force a passing installation. Do not delete shared immutable execution packages during DSH-only uninstall.

## Required packet

Return a task-local evidence packet containing the actual host/version and roots; operation/scope and launch argv; selected Skill names and complete method/index paths; source or package hashes; ownership/conflict diagnostics; observed tool/MCP/permission state; and the requested outcome with its acceptance owner. Use the installer or host's returned values rather than inventing a second authoritative schema.

For delegation, include each work order's inputs, owned resources, dependencies, allowed tools, output contract and review criteria, followed by its actual start receipt and terminal result when available. Keep pending human decisions attached to the affected branch. Record each evidence level separately as observed, unavailable, failed or still pending, with the exact command/tool result that supports it.

## Pass

An install/update passes its own boundary only when the operation reports success and `dsh check` verifies the complete expected projection and immutable executable closure without unresolved conflicts. A Skills-only install must explicitly report that MCP was not configured.

Native loading passes only after the actual DSH version discovers the intended Skills and reads their complete bounded methods/contracts. MCP connectivity needs a real successful protocol connection and advertised schema. Delegation needs a terminal result; task delivery additionally needs applicable output checks, independent acceptance and all required human decisions. Passing an earlier boundary does not complete a later one.

## Fail

Report the exact failed operation and affected paths when hashes, ownership records, content indexes or immutable execution references disagree; preserve conflicting files. Treat missing method parts, cropped rule content, wrong/shadowed Skill sources, invalid host configuration, MCP errors and rejected output checks as failed evidence for the corresponding boundary. Never convert partial install or uninstall results into success.

## Block

Stop the affected action when required authorization or human acceptance is pending, the selected method cannot be read completely, host tools/permissions are unavailable, or the requested workflow requires a hard Hook or stage-runner surface that this integration does not provide. Retain the concrete missing capability and dependency. Independent ready branches may continue only within their own resource and authorization boundaries.

## Return to stage

Return to Critical for unclear intent or an unapproved goal change; Fetch for missing host facts, method resources or reference evidence; and Deep Thinking for a changed route, unsupported required tool or revised dependency plan. Return rejected outputs to their owning execution branch and repeat Review against the same acceptance contract. Resume a human-gated branch only after the actual decision is bound to the current task; use Verification for fresh host or artifact evidence after changes.

## Verification

An opt-in reproducible host probe is available in a repository checkout:

```sh
node tests/setup/dsh-native-host-probe.mjs --dsh-root /path/to/npm-environment --service-package /path/to/service-dsh-package --report /path/to/report.json
```

The npm environment must already contain the pinned official `@deepseek-ai/dsh@0.2.2-rc.1`. The probe creates an isolated HOME, installs through the real public CLI and verified packed CLI, and checks update/uninstall/reinstall. The official host work runs in a separate child with a strict environment allowlist; only the initial package-provisioning process receives the configured network proxy/CA plumbing. No provider credentials or host-runtime overrides enter either environment.

It composes both the global profile and project overlay through the official CLI. The official Skill registry selects and loads every projected Skill through the filesystem provider, including project-over-global precedence. The probe reads **all** bounded resource parts/indexes using the official filesystem read tool and result pruner, checks complete line content and unpruned rendered Skill loaders, and demonstrates pruning on an original large JSON control. It connects the official Cordis MCP client/resource plugins to the immutable Meta_Kim service and verifies that the project overlay names the same executable configuration. Packed project install/update/check/uninstall is exercised independently; project removal must preserve the global installation. It mounts no LLM provider or agent loop and makes no model calls. It removes its isolated environment by default; `--keep-artifacts` retains evidence for diagnosis. This is an explicit development check, not an automatically imported runtime acceptance receipt.

Run `node --test tests/setup/dsh-profile-package.test.mjs` for projection lifecycle behavior. Run `node --test tests/governance/prompt-executability.test.mjs tests/governance/reference-contract.test.mjs` after changing this reference. Keep these local checks separate from a fresh official-host report and from model-driven delegation or business-output acceptance.

## Writeback

Write operation and verification results into the current task's owned evidence location, retaining host/package versions, exact commands, source hashes, output paths, observed limitations and pending decisions. The installer alone updates its existing ownership ledger through the managed transaction; a narrative or content index must not rewrite ownership authority. Keep generated host reports outside the canonical package being measured so that writing evidence does not change its own measured package hash.

When a host revision or repeated failure suggests an improvement, record the reproducible symptom, proposed contract change, affected methods and required regression checks for Review. Only reviewed canonical changes may alter future projections; a successful local probe does not grant itself native execution authority.

## Preserve

Preserve user credentials, permission/model configuration, unrelated and modified files, source licenses/notices, full original method bytes and the shared immutable package lifecycle. Preserve the nine governance-agent boundaries, Service ownership of professional implementation methods, real native tool stacks, complete human decisions and the distinction between package, host, delegation and accepted-delivery evidence. Keep the general Meta_Kim Node requirement unchanged for other hosts.

## Upstream source contract

All links below refer to the exact reviewed revision:

- [CLI profiles, patch precedence, configuration dumps and launch semantics](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/cli/README.md)
- [CLI version, Node engine and bundled MCP client](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/cli/package.json)
- [Filesystem Skill discovery and root precedence](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/skill/skill-filesystem/README.md)
- [Native Skill catalogue, resource bases and loading](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/skill/tool-skill/README.md)
- [Preset composition and builtin result pruning](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/preset/agent-preset/README.md)
- [Subagent inheritance, asynchronous results and depth](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/tool-subagent/README.md)
- [Native MCP plugin contract](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/mcp/mcp-client/README.md)
- [Experimental Claude hook bridge limits](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/experimental/hooks-claude-code/README.md)
- [Experimental Codex hook bridge limits](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/experimental/hooks-codex/README.md)
