# Meta_Kim Live ecosystem SDK

Meta_Kim Live exposes a small, dependency-free ESM SDK for community
projections. The public contributor entrypoint is:

```js
import {
  defineRuntimeAdapter,
  runRuntimeAdapter,
  defineEvidenceCard,
  defineReplayTheme,
} from "meta-kim/live-sdk";
```

The `meta-kim/live-sdk` subpath is the stable contributor import. Do not import
files below `src/sdk/live/` directly; the package keeps a wildcard compatibility
map for existing deep imports, but new integrations should use the stable
subpath.

## Contract and authority

The current SDK is `1.0.0` and has three versioned contracts:

| Surface | Schema | Purpose |
| --- | --- | --- |
| Runtime Adapter | `meta-kim-live-runtime-adapter-v1` | Normalize an explicit runtime record into a small Live observation |
| Evidence Card | `meta-kim-live-evidence-card-v1` | Project bounded evidence metadata and a safe summary |
| Replay Theme | `meta-kim-live-replay-theme-v1` | Turn an existing replay frame into structured presentation tokens |

Every result carries the same fixed authority:

```js
{
  projectionOnly: true,
  authoritative: false,
  executionAllowed: false,
  mutationAllowed: false,
  liveCertified: false,
}
```

Capability declarations describe what a contribution can normalize or render;
they are self-declarations and never promote a runtime, create a provider
claim, prove liveness, or grant permission. The SDK does not discover or
launch runtimes, read local configuration, write `.meta-kim`, call a model, or
create a scheduler/queue/authority store.

## Runtime Adapter SDK

An adapter receives an explicit data record and returns only the public
observation fields. The SDK validates and freezes the input snapshot and
output.

```js
const adapter = defineRuntimeAdapter({
  id: "my-runtime",
  version: "1.0.0",
  label: "My Runtime",
  capabilities: ["normalize", "project"],
  normalize(input) {
    return {
      status: input.running ? "running" : "unknown",
      stage: "execution",
      observedAt: input.observedAt,
      summary: input.running ? "Observed as running." : "No current status.",
      events: [],
    };
  },
});

const result = await runRuntimeAdapter(adapter, {
  running: true,
  observedAt: "2026-08-24T10:00:00.000Z",
}, { timeoutMs: 2_000, signal });
```

`status` is one of `idle`, `pending`, `running`, `completed`, `failed`,
`blocked`, `in_doubt`, or `unknown`. `stage` is a bounded identifier and
`events` contains only timestamped public event summaries. A callback cannot
return `authority`, raw output, a path, or an arbitrary extension field.

## Evidence Card SDK

Cards are bounded, typed projections. A contributor returns a body; the SDK
adds identity, schema version, and fixed projection authority.

```js
const card = defineEvidenceCard({
  id: "my-test-card",
  version: "1.0.0",
  type: "test",
  label: "Test results",
  capabilities: ["project"],
  build(input) {
    return {
      status: input.passed === input.total ? "pass" : "in_doubt",
      summary: `${input.passed}/${input.total} tests passed.`,
      refs: ["test:fixture"],
      observedAt: input.observedAt,
    };
  },
});

const result = await card.build({
  passed: 3,
  total: 3,
  observedAt: "2026-08-24T10:00:00.000Z",
});
```

Card statuses are `pending`, `pass`, `fail`, `in_doubt`, `unknown`, and
`not_observed`. `buildEvidenceCard({...})` is available as a pure helper when
no callback is needed. References are bounded, de-duplicated and sorted.

## Replay Theme SDK

Themes render existing replay frames into structured tokens. They do not
create history and do not return HTML.

```js
const theme = defineReplayTheme({
  id: "my-theme",
  version: "1.0.0",
  label: "My replay",
  capabilities: ["render"],
  render(frame) {
    return {
      title: frame.label,
      tone: frame.status === "running" ? "active" : "neutral",
      marker: "•",
    };
  },
});

const result = await renderReplayTheme(theme, {
  sequence: 1,
  at: "2026-08-24T10:00:00.000Z",
  kind: "stage",
  nodeId: "execution",
  status: "running",
  label: "Execution started",
});
```

The host should render `presentation.title` and other tokens with safe text
APIs such as `textContent`; the SDK intentionally has no DOM dependency.
Replay frames must come from an existing event/state record. The theme cannot
interpolate missing history or assert completion.

## Validation and failure boundaries

All public constructors reject unknown fields, accessors, symbol keys, sparse
arrays, control characters, secrets, URLs, absolute paths, and oversized
values. Returned envelopes are deeply frozen. Contribution callbacks receive
a frozen data snapshot, so caller-owned objects are not mutated.

`runRuntimeAdapter`, `card.build`, and `renderReplayTheme` accept
`{ timeoutMs, signal }`. The timeout is bounded to 1–120,000 ms. Cancellation
uses an AbortSignal-like object. Boundary failures reject with
`LIVE_SDK_TIMEOUT` or `LIVE_SDK_ABORTED`; contributor exceptions remain
errors and never become a successful projection.

## Independent examples and compatibility test

The repository includes three contribution-style examples that import only
the public entrypoint:

- `examples/live-sdk/adapter-example.mjs`
- `examples/live-sdk/evidence-card-example.mjs`
- `examples/live-sdk/replay-theme-example.mjs`

Run the compatibility contract with:

```text
node --test tests/live/live-sdk.test.mjs
```

This proves the public import path, versioned envelopes, strict validation,
authority boundary, timeout/cancellation behavior, frozen inputs, and the
three independent examples. It is a structural compatibility test; it is not
evidence of native runtime support, live certification, model invocation,
installed-user acceptance, or package publication.
