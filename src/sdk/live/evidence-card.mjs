import {
  EVIDENCE_CAPABILITIES,
  LIVE_SDK_VERSION,
  SDK_AUTHORITY,
  assertAuthority,
  boundedText,
  capabilityList,
  deepFreeze,
  enumValue,
  fail,
  record,
  runWithBoundary,
  safeArray,
  safeIdentifier,
  safeReference,
  semver,
  snapshotData,
  timestamp,
} from "./common.mjs";

export const EVIDENCE_CARD_SCHEMA_VERSION = "meta-kim-live-evidence-card-v1";

const DEFINITION_FIELDS = ["id", "version", "type", "label", "capabilities", "build"];
const CARD_FIELDS = ["schemaVersion", "kind", "id", "version", "type", "label", "status", "summary", "refs", "observedAt", "capabilityDeclaration", "authority"];
const BODY_FIELDS = ["status", "summary", "observedAt"];
const STATUS_VALUES = Object.freeze(["pending", "pass", "fail", "in_doubt", "unknown", "not_observed"]);

function normalizeStatus(value, label) {
  const aliases = new Map([["passed", "pass"], ["failed", "fail"], ["indeterminate", "in_doubt"]]);
  return enumValue(typeof value === "string" ? aliases.get(value) || value : value, STATUS_VALUES, label);
}

function normalizeRefs(value, label) {
  const refs = safeArray(value, label, 64).map((ref, index) => safeReference(ref, `${label}[${index}]`));
  if (new Set(refs).size !== refs.length) fail(`${label} must not contain duplicates`);
  return [...refs].sort((left, right) => left.localeCompare(right));
}

function normalizeDefinition(value) {
  const current = record(value, DEFINITION_FIELDS, "evidence card");
  if (typeof current.build !== "function") fail("evidence card.build must be a function");
  return {
    id: safeIdentifier(current.id, "evidence card.id"),
    version: semver(current.version, "evidence card.version"),
    type: safeIdentifier(current.type, "evidence card.type"),
    label: boundedText(current.label, "evidence card.label", 128),
    capabilities: capabilityList(current.capabilities, "evidence card.capabilities", EVIDENCE_CAPABILITIES),
    build: current.build,
  };
}

function capabilityDeclaration(capabilities) {
  return Object.freeze({
    schemaVersion: EVIDENCE_CARD_SCHEMA_VERSION,
    sdkVersion: LIVE_SDK_VERSION,
    capabilities,
    authority: "self_declared_projection",
  });
}

function normalizeCapabilityDeclaration(value, label) {
  const current = record(value, ["schemaVersion", "sdkVersion", "capabilities", "authority"], label);
  if (current.schemaVersion !== EVIDENCE_CARD_SCHEMA_VERSION || current.sdkVersion !== LIVE_SDK_VERSION || current.authority !== "self_declared_projection") fail(`${label} is invalid`);
  return capabilityDeclaration(capabilityList(current.capabilities, `${label}.capabilities`, EVIDENCE_CAPABILITIES));
}

function normalizeBody(value) {
  const current = record(value, BODY_FIELDS, "evidence card body", ["refs"]);
  return {
    status: normalizeStatus(current.status, "evidence card body.status"),
    summary: boundedText(current.summary, "evidence card body.summary", 512, { allowEmpty: true }),
    refs: Object.hasOwn(current, "refs") ? normalizeRefs(current.refs, "evidence card body.refs") : [],
    observedAt: timestamp(current.observedAt, "evidence card body.observedAt"),
  };
}

/**
 * Build a stable evidence card without invoking any contributor callback.
 * This is the recommended pure helper for small integrations.
 *
 * @param {object} value
 * @returns {Readonly<object>}
 */
export function buildEvidenceCard(value) {
  const current = record(value, ["id", "version", "type", "label", "status", "summary", "refs", "observedAt"] , "evidence card", ["capabilities"]);
  const capabilities = Object.hasOwn(current, "capabilities")
    ? capabilityList(current.capabilities, "evidence card.capabilities", EVIDENCE_CAPABILITIES)
    : EVIDENCE_CAPABILITIES;
  const card = {
    schemaVersion: EVIDENCE_CARD_SCHEMA_VERSION,
    kind: "evidence_card",
    id: safeIdentifier(current.id, "evidence card.id"),
    version: semver(current.version, "evidence card.version"),
    type: safeIdentifier(current.type, "evidence card.type"),
    label: boundedText(current.label, "evidence card.label", 128),
    status: normalizeStatus(current.status, "evidence card.status"),
    summary: boundedText(current.summary, "evidence card.summary", 512, { allowEmpty: true }),
    refs: normalizeRefs(current.refs, "evidence card.refs"),
    observedAt: timestamp(current.observedAt, "evidence card.observedAt"),
    capabilityDeclaration: capabilityDeclaration(capabilities),
    authority: SDK_AUTHORITY,
  };
  return deepFreeze(card);
}

/**
 * Define a dependency-free evidence card contribution.
 *
 * @param {object} definition
 * @returns {Readonly<object>}
 */
export function defineEvidenceCard(definition) {
  const normalized = normalizeDefinition(definition);
  const manifest = Object.freeze({
    schemaVersion: EVIDENCE_CARD_SCHEMA_VERSION,
    sdkVersion: LIVE_SDK_VERSION,
    id: normalized.id,
    version: normalized.version,
    type: normalized.type,
    label: normalized.label,
    capabilities: normalized.capabilities,
  });
  const card = {
    ...manifest,
    /**
     * @param {object} input
     * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
     * @returns {Promise<Readonly<object>>}
     */
    async build(input, options = {}) {
      const safeInput = snapshotData(input, "evidence card.input");
      const context = Object.freeze({
        schemaVersion: EVIDENCE_CARD_SCHEMA_VERSION,
        sdkVersion: LIVE_SDK_VERSION,
        cardId: normalized.id,
        capabilityDeclaration: capabilityDeclaration(normalized.capabilities),
        signal: options?.signal,
      });
      const raw = await runWithBoundary(() => normalized.build(safeInput, context), options || {});
      const body = normalizeBody(raw);
      return buildEvidenceCard({
        id: normalized.id,
        version: normalized.version,
        type: normalized.type,
        label: normalized.label,
        capabilities: normalized.capabilities,
        ...body,
      });
    },
  };
  return Object.freeze(card);
}

/**
 * Validate a card at a trust boundary. This never upgrades unknown evidence
 * into pass/fail and never changes its authority flags.
 *
 * @param {object} value
 * @returns {Readonly<object>}
 */
export function assertValidEvidenceCard(value) {
  const card = record(value, CARD_FIELDS, "evidence card result");
  if (card.schemaVersion !== EVIDENCE_CARD_SCHEMA_VERSION || card.kind !== "evidence_card") fail("evidence card identity is unsupported");
  safeIdentifier(card.id, "evidence card result.id");
  semver(card.version, "evidence card result.version");
  safeIdentifier(card.type, "evidence card result.type");
  boundedText(card.label, "evidence card result.label", 128);
  normalizeStatus(card.status, "evidence card result.status");
  boundedText(card.summary, "evidence card result.summary", 512, { allowEmpty: true });
  normalizeRefs(card.refs, "evidence card result.refs");
  timestamp(card.observedAt, "evidence card result.observedAt");
  normalizeCapabilityDeclaration(card.capabilityDeclaration, "evidence card result.capabilityDeclaration");
  assertAuthority(card.authority, "evidence card result.authority");
  return card;
}

export { STATUS_VALUES as EVIDENCE_CARD_STATUS_VALUES };
