---
name: meta-theory-report
description: Reopen a Meta_Kim governed run report
args: [runId|latest]
---

Open the user-readable report for a governed Meta_Kim run.

Use the rendered package-root runner first:

```bash
node "__META_KIM_PACKAGE_ROOT__/scripts/run-meta-theory-governed-execution.mjs" --read "${ARGUMENTS:-latest}"
```

If the command has not been rendered and the current project is the Meta_Kim
source checkout, use:

```bash
npm run meta:theory:report -- "${ARGUMENTS:-latest}"
```

Relay the returned status, runId, markdown report path, and `selection`
explanation. `selectionSource` is `latest_committed_pointer` or
`explicit_run_id`. `selectionReason` is `last_committed_governed_report` or
`explicit_committed_run_id`. Both are stable machine-readable enums.
`selectionExplanation` carries the human-readable explanation. In plain language:

- `selectionSource=latest_committed_pointer` means the newest report that finished committing;
  it does not mean that report is the current Codex host run.
- `selectionSource=explicit_run_id` means the requested historical/committed run was opened
  directly.
- `artifactClaimStatus` is the selected artifact's own claim. A valid `partial`
  report is still readable and must not be hidden or turned into an error.
- `different_active_run` means canonical repository lifecycle state identifies
  another active run. Say that clearly, then relay `nextCommand` to inspect or
  continue it. Do not invent a report for it.
- `unknown_invalid_projection` means repository lifecycle state could not be
  validated; a weak `active-run.json` projection is not current-run authority.
- `not_checked_custom_output` means a custom, temporary, or external report
  directory was read without consulting repository lifecycle state.

Never relay task text or task fingerprints from lifecycle state. Do not treat
the report path itself as verification evidence.
