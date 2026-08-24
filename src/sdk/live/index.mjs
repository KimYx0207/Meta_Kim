/**
 * Public Meta_Kim Live ecosystem SDK.
 *
 * This is the only supported import path for third-party Runtime Adapter,
 * Evidence Card and Replay Theme contributions. The SDK is ESM, has no
 * package dependencies, and produces projection-only data envelopes.
 */

export {
  LIVE_SDK_VERSION,
  SDK_AUTHORITY,
  SDK_CAPABILITIES,
  LiveSdkError,
  LiveSdkTimeoutError,
  LiveSdkAbortError,
} from "./common.mjs";

export {
  RUNTIME_ADAPTER_SCHEMA_VERSION,
  RUNTIME_ADAPTER_CAPABILITIES,
  RUNTIME_STATUS_VALUES,
  defineRuntimeAdapter,
  normalizeRuntimeObservation,
  runRuntimeAdapter,
  assertValidRuntimeAdapterResult,
} from "./runtime-adapter.mjs";

export {
  EVIDENCE_CARD_SCHEMA_VERSION,
  EVIDENCE_CARD_STATUS_VALUES,
  defineEvidenceCard,
  buildEvidenceCard,
  assertValidEvidenceCard,
} from "./evidence-card.mjs";

export {
  REPLAY_THEME_SCHEMA_VERSION,
  REPLAY_THEME_STATUS_VALUES,
  REPLAY_THEME_TONE_VALUES,
  defineReplayTheme,
  normalizeReplayFrame,
  renderReplayTheme,
  assertValidReplayThemeFrame,
} from "./replay-theme.mjs";
