# Meta_Kim maintainer reference



Start with the [repository instructions](AGENTS.md). This reference gives the installation, runtime, and release details for the corresponding work.

## Install Scope And Runtime Sedimentation

Keep two independent scope decisions separate:

- `setup.mjs` install/update offers an interactive `global` or `project` choice and accepts the same choice explicitly through `--scope global|project` for non-interactive use. `global_only` describes install-generated projection scope: it keeps only the dependency-closed Claude/Codex/Cursor project Hook package needed to enter governance and does not install durable project agents, skills, commands, capability indexes, MCP entries, Codex config examples, or OpenClaw project projections.
- Distribution scope and existing project topology are independent. A normal `global` install/update still refreshes every current, explicit, or saved directory that already has a valid Meta_Kim project-bootstrap manifest, using the configured bootstrap merge/delta policy. With no existing managed project, it creates no project projection and asks no extra question. Normal install/update never turns this refresh into cleanup; project cleanup remains an explicit cleanup command.
- Under `project_bootstrap_merge_delta`, files recorded by the project-bootstrap manifest remain Meta_Kim-managed: generated projections are transaction-backed-up and replaced with the current package version, while shared JSON and managed text blocks are merged. This replacement rule does not apply to unknown user files or `runtime_sedimented_project_copy` capabilities; both remain preserved.
- Governed runtime sedimentation is a different lifecycle. When a run proves that an Agent, Skill, or Command must be created or iterated for the current project, write or copy it into that runtime's native project directory and record it as `runtime_sedimented_project_copy`. Global dependency install/update and `global_only` cleanup must never overwrite or remove that independent project copy.
- Persistent professional project delivery requires project-owned capabilities. Discover general foundations globally, research the actual project, then create or update its own Agents, Skills, Commands and rules through the existing project-capability lifecycle. Reuse an already suitable project owner rather than recreating it. `use_global_directly` remains available for genuinely shared foundations, preparation and read-only diagnostics; it does not satisfy a project-owned professional delivery requirement. Bind the project identity and rules separately from the versioned upstream professional method source, and require rediscovery and actual loading before claiming use.

For Gemini CLI, `global_only` may retain the inert project adapter file but removes owned project hooks, MCP and context registrations. ZCode has no project hook projection. Both targets retire only exact install-owned project agents/skills and preserve user configuration and runtime-sedimented capabilities.

Global execution-package stability is a separate lifecycle from project scope. Any install/update path that will persist Claude Code or Codex Commands, Hook registrations, or merged settings/config, and Gemini CLI/ZCode global or external-project execution references, must first materialize the exact packed package into the shared immutable store at `~/.meta-kim/runtime/projection-packages/<package>/<version>/<packed-sha256>/`, then render all persistent execution references from that stable root. npx remains supported; its disposable cache is an origin, never long-term authority. Help, status, and doctor do not materialize this store merely by being invoked, while check stays read-only and validates the current version's manifest-bound authority. This store does not change `global_only`, project-bootstrap merge/delta, or `runtime_sedimented_project_copy` ownership. Uninstall may remove only an exact manifest-owned, closure-matching bundle; unknown, drifted, and user-owned content must be preserved. A bundle still referenced by an enrolled Gemini/ZCode project remains installed until the last project reference is removed.

The install manifest records `install_projection` ownership, retains records for runtime targets not selected by the current update, and stores exact hash plus size for managed files. The independent `.meta-kim/state/default/project-capabilities.json` manifest records `runtime_sedimented_project_copy` / `preserve_project_copy` ownership for project Agent, Skill, and Command paths. Bootstrap planning, actual writes, stale cleanup, and explicit redundancy cleanup must all consult that manifest and preserve those paths. Unknown files and runtime-sedimented project copies are preserved; drift inside bootstrap-manifest-owned generated projections follows the configured merge/delta replacement-and-backup policy. A manifest recording or flush failure makes install/update partial or failed; it must not be reported as success.

Configuration files have four ownership classes: canonical source, install projection, runtime-sedimented project copy, and local/user state. Merged user configuration is never treated as whole-file Meta_Kim ownership; cleanup removes only the exact Meta_Kim fragment or an exact manifest-owned generated file.

The shared immutable projection-package lifecycle does not include live-MCP replacement, active Node/npm CLI resolution, historical manifest repair, project-state/dependency weight reduction, Cursor live acceptance, Docker-based user acceptance, or the cancelled Claude context-reduction A/B. Keep those concerns in their own work items instead of expanding an install-root repair.

Release verification for install/update must exercise the real packed CLI: create the npm package, install that package in an isolated location, and run its install and update entrypoints. Running repository source directly is useful development evidence but is not packed-product truth.

Do not impose arbitrary source line-count gates. Architecture tests should enforce entrypoint responsibility, dependency direction, source/projection boundaries, and observable behavior. `setup.mjs` is a CLI façade; new domain logic belongs in focused modules with their own tests.

## Codex Runtime Map

When this repository is opened in Codex:

- `AGENTS.md` is this resident project guide.
- `.codex/agents/*.toml` contains Codex custom-agent mirrors for the nine Meta_Kim governance agents only. Codex is the only target here that uses agent TOML. Execution-layer labels such as `worker`, `explorer`, `frontend`, `backend`, `test`, `review`, `analysis`, `verify`, or `docs` remain run-scoped packet labels and must not be generated by Meta_Kim sync.
- `.agents/skills/meta-theory/SKILL.md` is the byte-identical project skill shared by Codex and Gemini CLI. Both writers preserve an independently edited copy. Project-local `.codex/skills/meta-theory/` was a legacy compatibility mirror and should be removed by sync when present. The canonical source is `canonical/skills/meta-theory/SKILL.md`.
- `.codex/hooks.json` and `.codex/hooks/` carry Codex-compatible project hook wiring.
- `activate-meta-theory-spine.mjs` imports the shared `project-root.mjs` resolver. Project sync, global Hook sync, `setup.mjs --project-bootstrap`, package manifests, and managed-file cleanup must always project and retire those files as one dependency set; a copied activator without its resolver is an invalid runtime projection.
- `codex/config.toml.example` is generated from `canonical/runtime-assets/codex/config.toml.example`.

Cursor parity is maintained through `.cursor/agents/*.md`, `.cursor/skills/meta-theory/`, `.cursor/hooks.json`, `.cursor/hooks/`, `.cursor/mcp.json`, and `.cursor/capability-index/`.

Project-root selection is a cross-runtime safety contract. The shared resolver uses this order: a valid trusted explicit declaration (currently Claude's `CLAUDE_PROJECT_DIR`, or the activator's explicit `--project-root` handoff to post-copy), then the nearest `.git` or project-bootstrap marker found from the current cwd, then an absolute marker-backed runtime payload candidate. A valid cwd project wins over payload fallback, relative payload paths are rejected, and no resolved project root means spine and post-copy projection must no-op instead of writing into an arbitrary directory.

Cross-runtime format boundary:

- Claude Code agents: `.claude/agents/*.md` with YAML frontmatter.
- Codex agents: `.codex/agents/*.toml` with `name`, `description`, `developer_instructions`, and optional ASCII `nickname_candidates`. Do not copy Codex TOML fields into Claude Code, Cursor, or OpenClaw.
- Cursor agents: `.cursor/agents/*.md` with YAML frontmatter plus `.cursor/rules/*.mdc` and `AGENTS.md` context.
- OpenClaw agents: `openclaw/workspaces/<agent>/` identity/workspace files plus `openclaw/openclaw.template.json`.
- Gemini CLI agents: `.gemini/agents/*.md` with native `kind: local` and `model: inherit`; context filenames and MCP/hooks merge into `.gemini/settings.json`. The user config is `~/.gemini/settings.json`; `GEMINI_CLI_HOME` changes its parent home, not the `.gemini` directory name.
- ZCode agents: `.zcode/agents/*.md` with `model: inherit` and `injectAgentsMd: true`; native skills use `.zcode/skills/`. Project MCP uses `.zcode/config.json`; global MCP and hooks use `~/.zcode/cli/config.json`. Hooks require `hooks.enabled: true` and native `process` entries under `hooks.events`. Never register project hooks or mutate the host's account/provider state under `~/.zcode/v2/`.

The native projection helper preserves one canonical governance source while translating host schemas. Gemini and ZCode children return nested work orders to the parent instead of inventing recursive subagent tools. See `canonical/skills/meta-theory/references/runtime-gemini.md` and `runtime-zcode.md` for official sources and live acceptance steps. `projection_implemented` and `live_verified` remain separate; their new projections do not expand the existing stage-runner host authority.

## Release Modes

Routine patch/minor releases should stay fast. If the change is prompt text, docs, changelog, version metadata, or narrow governance wording with no runtime wiring change, the default release path is:

1. `npm run meta:sync`
2. `npm run meta:capabilities:smoke`
3. `npm run meta:test:meta-theory`
4. `git diff --check`

This can be run directly as `npm run meta:release:smoke`, followed by `git diff --check`.

Upgrade from smoke to the standard full release gate, `npm run meta:verify:all`, when the task changes install/update behavior, global sync, hooks, runtime matrix, provider registry, dependency compatibility, runtime probes, package contents, security-sensitive behavior, or when the user explicitly asks for full release verification.

Standard full-release work is stricter than a local green check. Before commit, push, tag, changelog/release-note update, or publication, the run must have current evidence for:

- all declared runtime install/update targets; if machine-local defaults select only one runtime, use explicit all-runtime target selection
- project sync, global sync, and global hooks when hooks are in scope
- runtime matrix, provider registry, dependency compatibility, and runtime probe
- a real execution-demand route that naturally selects owner, creation providers, skill, MCP provider, command/runtime tool, and verification owner/path
- runtime evaluation/probe results for the targets declared by the standard release

After a standard full release is published, upload the exact npm tgz and run `meta-kim release audit --tag <tag> --verification-report <report> --package-file <tgz> --require-exact`. Attach the successful `published_bound` audit record to the GitHub Release. The audit must bind the clean report to the annotated tag object, peeled commit/tree, Release URL, GitHub asset digest, and the byte-exact npm tgz candidate that the clean full gate actually installed and tested; package name, version, or `package.json` alone are insufficient. Attempts are append-only; a dirty or unavailable historical report remains explicitly unbound and cannot be promoted.

If the run uses local planning files and a local-private PRD, finish the stable Claude Code/Codex global update and read-only global check, then run `meta-kim release close --issue <P-NNN> --prd <repo-relative-private-prd>`. This explicit final step refuses a dirty tracked tree, a public/mismatched PRD, a non-exact audit, or stale global projections. It repairs only missing local planning projections after interruption and never creates a public queue.

The optional highest-assurance mode is `npm run meta:verify:live-certified`. It appends a private-attested external observer gate that must join successful host request/result events to every exact Thinking-selected binding in a clean-room run. Missing or failed external attestation means only `liveCertified=false`: do not claim `live-certified`, exact-binding live coverage, or externally signed runtime proof. It does **not** invalidate a separately complete `meta:verify:all` run and does not block an ordinary standard release.

Do not treat structural smoke, systemMessage/UI warning output, auth-present checks, skipped/needsAuth states, or config-only proof as live pass evidence. Those are valid diagnostics, not live completion. Validators and gates protect against empty or dangerous routes; they are not the primary mechanism that makes the default path correct.

## Install And Packaging Notes

- Node must satisfy the `package.json` engine requirement.
- `package.json` uses a `files` whitelist so GitHub / npm tarballs include the full `canonical/` tree.
- `node setup.mjs` installs selected platform projections and graphify wiring idempotently.
- Runtime target selection has two layers: repo defaults in `config/sync.json`, machine-active targets in `.meta-kim/local.overrides.json`.
- MCP Memory Service uses port `8000`.
- `stop-memory-save.mjs` is a canonical/global MCP memory lifecycle asset installed by `scripts/install-mcp-memory-hooks.mjs`; it is not registered in the project `.claude/settings.json` projection.
