# Change Readiness Checklist

This checklist turns repeated Meta_Kim review findings into a pre-merge contract.
Use it before changing setup, update, runtime hooks, prompt adapters, provider
registries, workflow schemas, deletion paths, or release behavior.

## Host State Impact Matrix

For install, update, sync, and runtime-home changes, record these four columns
before editing implementation code:

| Existing host state | State this change adds | State this change must preserve | Rollback path |
|---|---|---|---|
| User config, native host plugin links, local MCP servers, hooks, agents, profiles, credentials, and generated state currently present. | Files, config blocks, hook entries, cache entries, manifest rows, or migration state introduced by this change. | User-owned config, credentials, custom servers, native host controls, and unrelated runtime state. | Command or manual steps that restore the prior state without deleting user-owned data. |

Minimum regression shape: existing user config -> install -> update. A happy-path
fresh install is not enough for host-preservation changes.

## Installed-User Compatibility Gate

Every bug fix or feature that touches install, update, sync, cleanup, runtime
homes, dependencies, startup registration, manifests, or generated config must
classify and verify all applicable user states before it can be release-ready:

| User state | Required evidence |
|---|---|
| Fresh install | Empty isolated home installs successfully. |
| Existing same-version install | Reinstall reconciles state without deleting user-owned assets or uninstalling healthy dependencies. |
| Historical-version update | A real prior packed version or an exact historical fixture migrates through the public update entrypoint. |
| Partial or failed prior install | Signature- or manifest-proven residue is repaired automatically, or preserved with an explicit blocking result. |
| User-modified or unknown state | Drift is preserved; the updater fails closed instead of widening ownership. |

If a reported bug can exist on machines that already installed Meta_Kim, the fix
must live in the normal public install/update path. A maintainer-only cleanup,
one-off shell command, fresh-install-only patch, or support instruction is not a
product fix. Automatic migration may remove or replace only exact historical
Meta_Kim shapes proven by a manifest, signature, closed-set fingerprint, or
strict legacy classifier; otherwise preserve and report the collision.

Release evidence must name the oldest supported source state or fixture, the
migration owner, the rollback/preservation behavior, and the packed public CLI
command that consumed it. Skipped historical coverage keeps the result below
release-ready unless the change demonstrably cannot affect installed users.

## Hook / Prompt Protocol Flow

For hook, prompt, or adapter changes, draw the data path before implementation:

| Source payload | Runtime adapter field | Model-visible field | UI-visible field | Assertion |
|---|---|---|---|---|
| Hook input, command stdout, or dependency adapter output. | Runtime-specific envelope such as Codex `hookSpecificOutput.additionalContext`, Cursor `prompt`, or lifecycle `decision`. | The exact field the model consumes. | The exact field the host displays, if any. | A test or live smoke that proves the hop. |

Keep policy decisions, model context, and UI notices separate. Advisory progress
messages must not become blocking decisions unless the contract explicitly says
the hook is a gate.

## Deletion / Refactor Residue Sweep

Before deleting a field, mode, backdoor, state key, or compatibility surface:

- Search old identifiers with `rg`.
- Check i18n strings and localized docs.
- Check README, changelog, and release notes.
- Check runtime mirrors, generated adapters, and install/update projections.
- Check compatibility exports, persisted state, and migration paths.
- Check test names, fixtures, assertion text, and skip/reminder wording.

Deletion is complete only when code, state, docs, mirrors, and tests agree.

## Evidence Budget

For third-party runtime, provider, hook, install, update, and release changes,
define evidence before writing completion prose:

- Local assertion: focused test, validator, or static contract check.
- Host-side self-test: installed-user, isolated runtime home, or tool-side smoke.
- User-visible result: release note, generated output, UI-visible behavior, or
  exact command output that a maintainer can replay.

Do not describe the work as complete until the evidence budget is either
satisfied or explicitly marked blocked with a reason.

Evidence template:

| Field | Meaning |
|---|---|
| `operationSteps` | The exact install, update, sync, hook, or runtime action performed. |
| `toolSideOutput` | The command, tool, or host-side output that proves the action happened. |
| `hostVisibleResult` | What the user or runtime can actually see after the action. |
| `failureBoundary` | What remains untested, blocked, optional, or unsafe to automate. |
| `reviewStatus` | Review pass, reviewer, or explicit blocked reason. |

## Install / Update Status Semantics

Use one of four status classes in user-visible install/update output:

| Class | Meaning | User next action |
|---|---|---|
| `success` | The requested action completed or the existing destination is already usable. | Continue. |
| `skipped` | The action was intentionally not run because it is optional, already satisfied, or not selected. | Continue unless the skipped optional capability is needed. |
| `manual` | The host requires a manual UI or command step that Meta_Kim cannot safely automate. | Perform the named manual action, then rerun the check. |
| `failed` | The requested action did not complete and needs intervention or retry. | Fix the reported cause before declaring install/update complete. |

## Execution Mode Classification

Workflow nodes use specific `executionMode` values, but reviews must first map
them into three classes:

| Class | Modes | Counts as real execution? |
|---|---|---|
| `real_execution` | `primary_execution`, `factory_then_dispatch`, `verification_execution` | Yes |
| `read_only_sidecar` | `readonly_fetch_sidecar`, `readonly_review_sidecar` | No |
| `approval_gate` | `approval_gate` | No |

Parallel groups and completion statistics must filter by class, not by raw node
count. Read-only sidecars and approval gates may support execution, but they do
not prove that executable work happened.
