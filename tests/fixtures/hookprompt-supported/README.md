# Reviewed HookPrompt source snapshots

These are portable source snapshots for static-diagnostic regression tests. They
are read as text and never imported or executed by the tests.

The files were read from the installed Claude/Codex HookPrompt components and
matched byte-for-byte against the clean tracked files in the local `Kim_Service`
checkout at commit `ce928a10f9a4d874aea7afd4b878da5f28594eba` on 2026-10-26.
They contain reusable component code and generic display contracts, not a user's
conversation, private prompt, configuration, credential, or absolute home path.

| Snapshot | Source path in Kim_Service | SHA256 (LF source) |
| --- | --- | --- |
| implementation.cjs | hooks/hookprompt/.claude/hooks/user-prompt-submit.cjs | 7d7161b4e4c9cf7efbd6db8e7e99b5e03468bfceec91bc4b4fbe77aa8b63a361 |
| claude-entry.js | hooks/hookprompt/.claude/hooks/user-prompt-submit.js | 4e6258bf5eb4fd031c5f3ce1da22516e82bd1ea17ca679dbf23e0018646ce021 |
| codex-entry.js | hooks/hookprompt/.codex/hooks/user-prompt-submit.js | b6e81f42f26c5cc9ed4aec33dee660434579b2b6da09cf5c6b852df73ea3d4f3 |

The runtime diagnostic allowlist identifies these entire reviewed implementations
and shims. A matching fingerprint establishes a supported static display
contract only. It does not certify execution, package provenance, or visible chat
rendering. Source changes require a fresh complete-source review; synthetic
positive fixtures are not added to the allowlist. Only physical LF/CRLF variation
is normalized. Test fixtures are excluded from the npm product package.
