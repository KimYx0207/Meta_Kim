# Native CLI stream observations

`native_cli_stream` is an explicit controlled-producer source for the official
CLI's **current, newly started probe**. It is not an authorization grant from
Codex Desktop, and it does not import a user's old conversation.

## Authentication and execution boundary

- Use an existing official Claude Code OAuth login or Codex ChatGPT login. The
  official CLI resolves and refreshes its own authentication. Meta does not read
  or copy credential files, tokens, keychains, or session directories.
- Read-only CLI authentication metadata is checked before the probe. Unknown,
  API, gateway, third-party or ambiguous identities fail closed. No API-key
  fallback, new login, provider setup, or persistent permission change occurs.
- Existing login does not establish billing entitlement. Running the probes
  consumes model usage and requires the user's authorization for that usage.
  An API dollar-budget option is not a subscription/no-charge guarantee.
- Each probe uses a new bounded workspace. Codex uses ephemeral JSON output and
  workspace-write, retaining applicable execpolicy and managed security rules.
  Optional project-prompt and skill discovery is disabled for the synthetic
  probe; this is not a test of user skill loading. Claude uses safe mode, empty
  optional settings, an empty strict MCP configuration, non-persistent print
  output and the actual native tools, with probe-specific tool denials, exact
  read/edit paths and a nonce-bound shell permission rule. `--bare` is deliberately not used because
  it disables subscription OAuth. `--tools` is not used: some supported Claude
  versions resolve that option to an empty tool list.
- A fresh working directory is not an operating-system security boundary.
  Host security policy remains authoritative; successful but unexpected tool
  actions cause rejection without retaining their output.
- CLI flags and executable identity are checked. Authentication and managed
  policy remain host-owned. A denied, unsupported or unavailable host stops
  the attempt; this source never repairs security settings automatically.

## Evidence retained

Only this child process's private stdout pipe is consumed. The collector keeps
bounded, replay-complete structural/tool/child-result lifecycle records and
discards unrelated chat, reasoning and identity/configuration metadata. It
rejects failures, malformed/truncated data, cross-thread joins and unsupported
operational events before writing evidence. Raw historical sessions are never
read, and the full transient stdout is never saved by this source.

The retained event tape and full transient stdout have **separate hashes**.
Receipts bind source, runtime version, launch-inventory executable identity,
request hash, fresh nonce, parent/child IDs, native event IDs, exact child
marker result, tool outcomes and file content. Codex engineering observations
retain the ordered shell write / read / native edit / final read chain because
its file-change event identifies the path but does not contain edited bytes.

The packed verifier copies only the self-contained receipt and minimal event
tape for this source. It does not copy authentication or original sessions.
The ten-item observation set and full release/precise-package binding gates
are unchanged. CLI-native observations do not certify Desktop UI, every
professional role, model quality or external-signature `liveCertified`.

The trusted boundary remains the fixed producer launched by the maintainer on
their own host. Hashes detect mismatches; they are not independent attestation
against a malicious same-user process capable of rewriting every evidence
file. Arbitrary public report imports remain reference-only. Synthetic test
executors always produce test-only evidence and cannot authorize production.

## Commands and compatibility

Inspect without making a model call:

    node scripts/run-runtime-capability-producers.mjs --status --require-fresh

After separately authorizing the existing model-account usage, run each host
explicitly:

    node scripts/run-runtime-capability-producers.mjs --source native_cli_stream --runtimes claude_code --timeout-ms 60000
    node scripts/run-runtime-capability-producers.mjs --source native_cli_stream --runtimes codex --timeout-ms 60000

Codex shell, filesystem and edit requests must be selected together so their
shared four-event chain is complete. Agent and subagent remain separate exact
marker probes. A model/tool refusal, timeout or missing event stays unaccepted.

Source inspection supports Codex 0.157.1's structured collaboration events and
Claude Code 2.1.236's safe mode and forwarded subagent text. This is not a claim
that live acceptance has passed on either installed version. Actual execution
and all ten fresh observations must pass before the standard release gate can
complete.

Legacy `live_controlled` and Desktop-session sources retain their historical
contracts; they are not automatic fallbacks for `native_cli_stream`.
