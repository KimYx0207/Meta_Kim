/** Pure, point-in-time, non-authoritative M3-A06 runtime-health projection. */
export const RUNTIME_HEALTH_PROJECTION_SCHEMA_VERSION = "runtime-health-projection-v1";
export const RUNTIME_HEALTH_STATUSES = Object.freeze([
  "responsive_at_observation",
  "unresponsive_at_observation_deadline",
  "unavailable_at_observation",
  "failed_at_observation",
  "not_observed",
  "in_doubt",
]);
export const RUNTIME_HEALTH_DISPOSITIONS = Object.freeze([
  "observed",
  "degraded",
  "not_observed",
  "in_doubt",
]);

const COMMAND_FIELDS = ["binding", "runtimeRegistryBinding", "trustedObservation", "excludedSignalContext"];
const BINDING_FIELDS = ["runId", "taskFingerprint", "graphDigest", "projectionDigest", "durableCursor", "headEventHash", "headCheckpointId", "runtimeRegistryDigest", "policyDigest", "evaluationRevision"];
const REGISTRY_FIELDS = ["runtimeId", "runtimeMode", "catalogDigest", "capabilityMatrixDigest", "evidenceLedgerDigest", "registryDigest"];
const OBSERVATION_FIELDS = ["source", "runtimeId", "runtimeMode", "currentRun", "nativeInvocationObserved", "invocationStatus", "failureClass", "startedAt", "endedAt", "observedAt", "evidenceRefDigest", "observationDigest"];
const OBSERVATION_RESULT_SOURCE_FIELDS = ["source", "runtimeId", "runtimeMode", "currentRun", "nativeInvocationObserved", "invocationStatus", "failureClass", "evidenceRefDigest", "observationDigest"];
const OBSERVATION_RESULT_FIELDS = [...OBSERVATION_RESULT_SOURCE_FIELDS, "lastSeenAtBindingDigest"];
const EXCLUDED_FIELDS = ["leaseClaimHeartbeat", "openClawScheduledHeartbeat", "presenceProbe", "installOrConfigPresence", "persistedCapabilityAcceptance"];
const EXCLUDED_ITEM_FIELDS = ["present", "evidenceDigest", "provesRuntimeHealth"];
const RESULT_FIELDS = ["schemaVersion", "kind", "binding", "bindingDigest", "runtimeObservation", "health", "excludedSignals", "disposition", "eventIntents", "authorization"];
const HEALTH_FIELDS = ["status", "lastSeenAt", "temporalScope", "source", "evidenceRefDigest", "reasonCodes", "currentLivenessClaimed", "projectionOnly", "authoritative"];
const DISPOSITION_FIELDS = ["state", "reasonCodes", "evidenceRefs"];
const EVENT_FIELDS = ["kind", "intentDigest", "disposition", "reasonCodesDigest", "persisted", "authoritative", "writeAllowed"];
const AUTHORIZATION_FIELDS = ["currentLivenessClaimAllowed", "schedulerDispatchAllowed", "executionAllowed", "claimAllowed", "takeoverAllowed", "heartbeatAllowed", "releaseAllowed", "coordinatorMutationAllowed", "nodeMutationAllowed", "leaseMutationAllowed", "fenceMutationAllowed", "retryAllowed", "quotaMutationAllowed", "quotaConsumptionAllowed", "eventPersistenceAllowed", "cursorAdvanceAllowed", "checkpointMutationAllowed", "completeNodeAllowed", "terminalStatusWriteAllowed", "legacyGateCutoverAllowed", "authoritativeWriteAllowed"];
const RUNTIME_MODES = ["native_cli", "injected_callback", "compatibility_projection"];
const SOURCES = ["stage_runner_bridge_native_invocation", "none"];
const INVOCATION_STATUSES = ["pass", "timeout", "launch_failed", "parse_failed", "output_limit", "nonzero_exit", "final_message_missing", "not_invoked", "conflict"];
const FAILURE_CLASSES = ["none", "runtime_safety_timeout", "runtime_launch_failed", "runtime_parse_failed", "runtime_output_limit", "runtime_nonzero_exit", "final_message_missing", "injected_callback", "not_applicable", "unknown"];
const REASON_CODES = ["runtime_responsive_at_observation", "runtime_unresponsive_at_deadline", "runtime_unavailable_at_observation", "runtime_failed_at_observation", "runtime_not_observed", "runtime_observation_in_doubt", "cross_runtime_observation", "observation_binding_mismatch", "future_observation_rejected", "conflicting_observation", "excluded_signals_not_health_authority"];
const SETTLED_OBSERVATION_STATUS = new Map([
  ["pass:none", "responsive_at_observation"],
  ["timeout:runtime_safety_timeout", "unresponsive_at_observation_deadline"],
  ["launch_failed:runtime_launch_failed", "unavailable_at_observation"],
  ["parse_failed:runtime_parse_failed", "failed_at_observation"],
  ["output_limit:runtime_output_limit", "failed_at_observation"],
  ["nonzero_exit:runtime_nonzero_exit", "failed_at_observation"],
  ["final_message_missing:final_message_missing", "failed_at_observation"],
]);
const PRIMARY_REASON_BY_STATUS = new Map([
  ["responsive_at_observation", "runtime_responsive_at_observation"],
  ["unresponsive_at_observation_deadline", "runtime_unresponsive_at_deadline"],
  ["unavailable_at_observation", "runtime_unavailable_at_observation"],
  ["failed_at_observation", "runtime_failed_at_observation"],
  ["not_observed", "runtime_not_observed"],
  ["in_doubt", "runtime_observation_in_doubt"],
]);
const IN_DOUBT_DETAIL_REASONS = new Set([
  "cross_runtime_observation",
  "observation_binding_mismatch",
  "future_observation_rejected",
  "conflicting_observation",
]);
const SHA256_REF = /^sha256:[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+\-]{0,511}$/u;

function fail(message) { throw new TypeError(`Runtime health projection: ${message}`); }
function ownDataEntries(value, label) {
  let prototype; let keys;
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a plain record`);
    prototype = Object.getPrototypeOf(value); keys = Reflect.ownKeys(value);
  } catch { fail(`${label} must be an inspectable plain record`); }
  if (prototype !== Object.prototype) fail(`${label} must be a plain record`);
  return keys.map((key) => {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { fail(`${label} must be inspectable`); }
    if (typeof key !== "string" || descriptor?.enumerable !== true || !("value" in descriptor)) fail(`${label} must contain enumerable string own data only`);
    return [key, descriptor.value];
  });
}
function exactRecord(value, fields, label) {
  const entries = ownDataEntries(value, label); const map = new Map(entries);
  if (entries.length !== fields.length || entries.some(([key]) => !fields.includes(key))) fail(`${label} must contain exactly the supported fields`);
  for (const field of fields) if (!map.has(field)) fail(`${label} is incomplete`);
  return Object.fromEntries(fields.map((field) => [field, map.get(field)]));
}
function denseArray(value, label) {
  let prototype; let keys; let length;
  try { if (!Array.isArray(value)) fail(`${label} must be a plain list`); prototype = Object.getPrototypeOf(value); keys = Reflect.ownKeys(value); length = Object.getOwnPropertyDescriptor(value, "length")?.value; } catch { fail(`${label} must be inspectable`); }
  if (prototype !== Array.prototype || !Number.isSafeInteger(length) || length < 0 || length > 64) fail(`${label} must be a bounded plain list`);
  const values = new Map();
  for (const key of keys) {
    if (key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || descriptor?.enumerable !== true || !("value" in descriptor)) fail(`${label} must contain dense numeric own data only`);
    values.set(key, descriptor.value);
  }
  if (values.size !== length) fail(`${label} must be dense`);
  return Array.from({ length }, (_, index) => values.get(String(index)));
}
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); return value; }
function sha256(value) {
  const bytes = new TextEncoder().encode(String(value)); const bitLength = BigInt(bytes.length) * 8n; const paddedLength = ((bytes.length + 72) >> 6) << 6; const message = new Uint8Array(paddedLength); message.set(bytes); message[bytes.length] = 0x80;
  for (let i = 0; i < 8; i += 1) message[paddedLength - 1 - i] = Number((bitLength >> BigInt(i * 8)) & 0xffn);
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766aabb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  k[37] = 0x766a0abb;
  let hash = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]; const rotr = (word, bits) => (word >>> bits) | (word << (32 - bits));
  for (let offset = 0; offset < message.length; offset += 64) { const w = new Uint32Array(64); for (let i = 0; i < 16; i += 1) { const p = offset + i * 4; w[i] = ((message[p] << 24) | (message[p+1] << 16) | (message[p+2] << 8) | message[p+3]) >>> 0; } for (let i = 16; i < 64; i += 1) { const s0 = rotr(w[i-15],7) ^ rotr(w[i-15],18) ^ (w[i-15] >>> 3); const s1 = rotr(w[i-2],17) ^ rotr(w[i-2],19) ^ (w[i-2] >>> 10); w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0; } let [a,b,c,d,e,f,g,h] = hash; for (let i = 0; i < 64; i += 1) { const s1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25); const ch = (e & f) ^ (~e & g); const t1 = (h + s1 + ch + k[i] + w[i]) >>> 0; const s0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22); const maj = (a & b) ^ (a & c) ^ (b & c); const t2 = (s0 + maj) >>> 0; h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0; } hash = hash.map((word, index) => (word + [a,b,c,d,e,f,g,h][index]) >>> 0); }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}
function digest(value) { return `sha256:${sha256(JSON.stringify(canonical(value)))}`; }
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; }
function bool(value, label) { if (typeof value !== "boolean") fail(`${label} must be boolean`); return value; }
function integer(value, label, { nullable = false } = {}) { if (nullable && value === null) return null; if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative safe integer`); return value; }
function enumValue(value, values, label) { if (typeof value !== "string" || !values.includes(value)) fail(`${label} is unsupported`); return value; }
function digestRef(value, label, { nullable = false } = {}) { if (nullable && value === null) return null; if (typeof value !== "string" || !SHA256_REF.test(value)) fail(`${label} must be a strict sha256 reference`); return value; }
function highEntropy(value) { if (value.length < 40 || !/^[A-Za-z0-9_+.-]+$/u.test(value)) return false; const kinds = [/[a-z]/u,/[A-Z]/u,/[0-9]/u,/[_+.-]/u].filter((pattern) => pattern.test(value)).length; if (kinds < 3) return false; const counts = new Map(); for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1); let entropy = 0; for (const count of counts.values()) { const p = count / value.length; entropy -= p * Math.log2(p); } return entropy >= 4; }
function secretLike(value) { const folded = value.normalize("NFKC").toLowerCase(); const compact = folded.replace(/[^a-z0-9]/gu, ""); if (/(?:https?|ftp|file):|www\.|[\\/]/u.test(folded)) return true; if (/(?:secret|password|passwd|credential|privatekey|apikey|accesstoken|refreshtoken|bearertoken|stdout|stderr)/u.test(compact)) return true; if (/^(?:sk(?:-[a-z0-9]+)?|rk|pk|gh[pousr]|github_pat|xox[baprs]|npm|pat|akia|asia|aiza)[_+.-]/u.test(folded)) return true; if (/^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}$/u.test(value)) return true; return highEntropy(value); }
function safeId(value, label, { nullable = false } = {}) { if (nullable && value === null) return null; if (typeof value !== "string" || !SAFE_ID.test(value) || secretLike(value)) fail(`${label} must be a safe bounded identifier`); return value; }
function ordered(values) { const set = new Set(values); return REASON_CODES.filter((reason) => set.has(reason)); }
function normalizeBinding(value) { const v = exactRecord(value, BINDING_FIELDS, "binding"); return { runId: safeId(v.runId,"binding.runId"), taskFingerprint:digestRef(v.taskFingerprint,"binding.taskFingerprint"), graphDigest:digestRef(v.graphDigest,"binding.graphDigest"), projectionDigest:digestRef(v.projectionDigest,"binding.projectionDigest"), durableCursor:integer(v.durableCursor,"binding.durableCursor"), headEventHash:digestRef(v.headEventHash,"binding.headEventHash",{nullable:true}), headCheckpointId:safeId(v.headCheckpointId,"binding.headCheckpointId",{nullable:true}), runtimeRegistryDigest:digestRef(v.runtimeRegistryDigest,"binding.runtimeRegistryDigest"), policyDigest:digestRef(v.policyDigest,"binding.policyDigest"), evaluationRevision:integer(v.evaluationRevision,"binding.evaluationRevision") }; }
function normalizeRegistry(value) { const v = exactRecord(value, REGISTRY_FIELDS, "runtimeRegistryBinding"); return { runtimeId:safeId(v.runtimeId,"runtimeRegistryBinding.runtimeId"), runtimeMode:enumValue(v.runtimeMode,RUNTIME_MODES,"runtimeRegistryBinding.runtimeMode"), catalogDigest:digestRef(v.catalogDigest,"runtimeRegistryBinding.catalogDigest"), capabilityMatrixDigest:digestRef(v.capabilityMatrixDigest,"runtimeRegistryBinding.capabilityMatrixDigest"), evidenceLedgerDigest:digestRef(v.evidenceLedgerDigest,"runtimeRegistryBinding.evidenceLedgerDigest"), registryDigest:digestRef(v.registryDigest,"runtimeRegistryBinding.registryDigest") }; }
function normalizeObservation(value) { const v = exactRecord(value, OBSERVATION_FIELDS, "trustedObservation"); return { source:enumValue(v.source,SOURCES,"trustedObservation.source"), runtimeId:safeId(v.runtimeId,"trustedObservation.runtimeId"), runtimeMode:enumValue(v.runtimeMode,RUNTIME_MODES,"trustedObservation.runtimeMode"), currentRun:bool(v.currentRun,"trustedObservation.currentRun"), nativeInvocationObserved:bool(v.nativeInvocationObserved,"trustedObservation.nativeInvocationObserved"), invocationStatus:enumValue(v.invocationStatus,INVOCATION_STATUSES,"trustedObservation.invocationStatus"), failureClass:enumValue(v.failureClass,FAILURE_CLASSES,"trustedObservation.failureClass"), startedAt:integer(v.startedAt,"trustedObservation.startedAt",{nullable:true}), endedAt:integer(v.endedAt,"trustedObservation.endedAt",{nullable:true}), observedAt:integer(v.observedAt,"trustedObservation.observedAt",{nullable:true}), evidenceRefDigest:digestRef(v.evidenceRefDigest,"trustedObservation.evidenceRefDigest",{nullable:true}), observationDigest:digestRef(v.observationDigest,"trustedObservation.observationDigest") }; }
function normalizeExcluded(value, label="excludedSignalContext") { const v=exactRecord(value,EXCLUDED_FIELDS,label); return Object.fromEntries(EXCLUDED_FIELDS.map((field)=>{const item=exactRecord(v[field],EXCLUDED_ITEM_FIELDS,`${label}.${field}`);const present=bool(item.present,`${label}.${field}.present`);const evidenceDigest=digestRef(item.evidenceDigest,`${label}.${field}.evidenceDigest`,{nullable:true});if(!present&&evidenceDigest!==null)fail(`${label}.${field} absent evidence must be null`);if(item.provesRuntimeHealth!==false)fail(`${label}.${field} cannot prove runtime health`);return[field,{present,evidenceDigest,provesRuntimeHealth:false}];})); }
function authorization() { return Object.fromEntries(AUTHORIZATION_FIELDS.map((field)=>[field,false])); }
function observationCore(observation) { const { observationDigest, ...core } = observation; return core; }
function registryCore(registry) { const { registryDigest, ...core } = registry; return core; }

function classify(binding, registry, observation) {
  const reasons=[];
  const registryValid=registry.registryDigest===digest(registryCore(registry));
  const observationValid=observation.observationDigest===digest(observationCore(observation));
  const registryBound=binding.runtimeRegistryDigest===registry.registryDigest;
  const runtimeBound=observation.runtimeId===registry.runtimeId&&observation.runtimeMode===registry.runtimeMode;
  const nativeShape=observation.source==="stage_runner_bridge_native_invocation"&&observation.runtimeMode==="native_cli"&&observation.nativeInvocationObserved===true&&observation.currentRun===true;
  const noObservationShape=observation.source==="none"&&observation.nativeInvocationObserved===false;
  const matchingFailure = new Map([["pass","none"],["timeout","runtime_safety_timeout"],["launch_failed","runtime_launch_failed"],["parse_failed","runtime_parse_failed"],["output_limit","runtime_output_limit"],["nonzero_exit","runtime_nonzero_exit"],["final_message_missing","final_message_missing"]]);
  if (!runtimeBound) reasons.push("cross_runtime_observation");
  if (!registryValid || !observationValid || !registryBound) reasons.push("observation_binding_mismatch");
  if (!observation.currentRun && observation.nativeInvocationObserved) reasons.push("conflicting_observation");
  if (observation.invocationStatus==="conflict") reasons.push("conflicting_observation");
  const timestamps=[observation.startedAt,observation.endedAt,observation.observedAt];
  const allNull=timestamps.every((value)=>value===null); const allPresent=timestamps.every((value)=>value!==null);
  if (allPresent && observation.endedAt>observation.observedAt) reasons.push("future_observation_rejected");
  if ((!allNull&&!allPresent)||(allPresent&&observation.startedAt>observation.endedAt)) reasons.push("conflicting_observation");
  const isNotObserved = noObservationShape || observation.runtimeMode!=="native_cli" || observation.invocationStatus==="not_invoked";
  const combinationValid = matchingFailure.get(observation.invocationStatus)===observation.failureClass;
  const expectedNoObservationFailure = observation.runtimeMode === "injected_callback" ? "injected_callback" : "not_applicable";
  const validNotObservedShape = noObservationShape && observation.currentRun === true && observation.invocationStatus === "not_invoked" && observation.failureClass === expectedNoObservationFailure && allNull && observation.evidenceRefDigest === null;
  if (!isNotObserved && (!nativeShape || !combinationValid || !allPresent || observation.evidenceRefDigest===null)) reasons.push("conflicting_observation");
  if (isNotObserved && !validNotObservedShape) reasons.push("conflicting_observation");
  if (reasons.length) return {status:"in_doubt", reasons:ordered(["runtime_observation_in_doubt",...reasons]), accepted:false};
  if (isNotObserved) return {status:"not_observed",reasons:["runtime_not_observed"],accepted:false};
  const status = observation.invocationStatus==="pass"?"responsive_at_observation":observation.invocationStatus==="timeout"?"unresponsive_at_observation_deadline":observation.invocationStatus==="launch_failed"?"unavailable_at_observation":"failed_at_observation";
  const primary = status==="responsive_at_observation"?"runtime_responsive_at_observation":status==="unresponsive_at_observation_deadline"?"runtime_unresponsive_at_deadline":status==="unavailable_at_observation"?"runtime_unavailable_at_observation":"runtime_failed_at_observation";
  return {status,reasons:[primary],accepted:true};
}

export function evaluateRuntimeHealthProjection(command) {
  const v=exactRecord(command,COMMAND_FIELDS,"command"); const binding=normalizeBinding(v.binding); const registry=normalizeRegistry(v.runtimeRegistryBinding); const observation=normalizeObservation(v.trustedObservation); const excludedSignals=normalizeExcluded(v.excludedSignalContext); const bindingDigest=digest(binding); const classification=classify(binding,registry,observation); const excludedPresent=EXCLUDED_FIELDS.some((field)=>excludedSignals[field].present);
  const reasons=ordered([...classification.reasons,...(excludedPresent?["excluded_signals_not_health_authority"]:[])]); const status=classification.status; const dispositionState=status==="responsive_at_observation"?"observed":["unresponsive_at_observation_deadline","unavailable_at_observation","failed_at_observation"].includes(status)?"degraded":status;
  const lastSeenAt=classification.accepted?observation.endedAt:null;
  const runtimeObservation={...Object.fromEntries(OBSERVATION_RESULT_SOURCE_FIELDS.map((field)=>[field,observation[field]])),lastSeenAtBindingDigest:digest({observationDigest:observation.observationDigest,lastSeenAt})};
  const health={status,lastSeenAt,temporalScope:"point_in_time_observation_only",source:classification.accepted?"stage_runner_bridge_native_invocation":"none",evidenceRefDigest:classification.accepted?observation.evidenceRefDigest:null,reasonCodes:reasons,currentLivenessClaimed:false,projectionOnly:true,authoritative:false};
  const disposition={state:dispositionState,reasonCodes:reasons,evidenceRefs:[bindingDigest,registry.registryDigest,observation.observationDigest]};
  const intentCore={bindingDigest,runtimeObservation,health,excludedSignals,disposition};
  const eventIntents=[{kind:"runtime_health_shadow_observed",intentDigest:digest(intentCore),disposition:dispositionState,reasonCodesDigest:digest(reasons),persisted:false,authoritative:false,writeAllowed:false}];
  const result={schemaVersion:RUNTIME_HEALTH_PROJECTION_SCHEMA_VERSION,kind:"runtime_health_projection_result",binding,bindingDigest,runtimeObservation,health,excludedSignals,disposition,eventIntents,authorization:authorization()};
  assertValidRuntimeHealthProjectionResult(result); return deepFreeze(result);
}

function assertProjectedSemanticConsistency({ observation, health, healthReasons, excludedSignals }) {
  const excludedPresent = EXCLUDED_FIELDS.some((field) => excludedSignals[field].present);
  const expectedPrimaryReason = PRIMARY_REASON_BY_STATUS.get(health.status);
  if (!healthReasons.includes(expectedPrimaryReason)) fail("result health reason does not match health status");
  if (healthReasons.includes("excluded_signals_not_health_authority") !== excludedPresent) fail("result excluded-signal reason is inconsistent");

  if (health.status === "in_doubt") {
    if (!healthReasons.some((reason) => IN_DOUBT_DETAIL_REASONS.has(reason))) fail("result in-doubt status lacks a conflict reason");
    return;
  }

  const expectedReasons = ordered([
    expectedPrimaryReason,
    ...(excludedPresent ? ["excluded_signals_not_health_authority"] : []),
  ]);
  if (JSON.stringify(healthReasons) !== JSON.stringify(expectedReasons)) fail("result health reasons do not exactly match projected semantics");

  if (health.status === "not_observed") {
    const expectedFailureClass = observation.runtimeMode === "injected_callback" ? "injected_callback" : "not_applicable";
    if (observation.source !== "none" || observation.currentRun !== true || observation.nativeInvocationObserved !== false || observation.invocationStatus !== "not_invoked" || observation.failureClass !== expectedFailureClass || observation.evidenceRefDigest !== null) fail("result not-observed status contradicts runtime observation");
    return;
  }

  const expectedStatus = SETTLED_OBSERVATION_STATUS.get(`${observation.invocationStatus}:${observation.failureClass}`);
  if (observation.source !== "stage_runner_bridge_native_invocation" || observation.runtimeMode !== "native_cli" || observation.currentRun !== true || observation.nativeInvocationObserved !== true || observation.evidenceRefDigest === null || expectedStatus !== health.status) fail("result observed health contradicts runtime observation");
  if (health.evidenceRefDigest !== observation.evidenceRefDigest) fail("result observed health evidence does not match runtime observation");
}

export function assertValidRuntimeHealthProjectionResult(result) {
  const r=exactRecord(result,RESULT_FIELDS,"result"); if(r.schemaVersion!==RUNTIME_HEALTH_PROJECTION_SCHEMA_VERSION||r.kind!=="runtime_health_projection_result")fail("result identity is invalid"); const binding=normalizeBinding(r.binding); if(r.bindingDigest!==digest(binding))fail("result binding digest is invalid");
  const observationRecord=exactRecord(r.runtimeObservation,OBSERVATION_RESULT_FIELDS,"result.runtimeObservation"); const observation={source:enumValue(observationRecord.source,SOURCES,"result.runtimeObservation.source"),runtimeId:safeId(observationRecord.runtimeId,"result.runtimeObservation.runtimeId"),runtimeMode:enumValue(observationRecord.runtimeMode,RUNTIME_MODES,"result.runtimeObservation.runtimeMode"),currentRun:bool(observationRecord.currentRun,"result.runtimeObservation.currentRun"),nativeInvocationObserved:bool(observationRecord.nativeInvocationObserved,"result.runtimeObservation.nativeInvocationObserved"),invocationStatus:enumValue(observationRecord.invocationStatus,INVOCATION_STATUSES,"result.runtimeObservation.invocationStatus"),failureClass:enumValue(observationRecord.failureClass,FAILURE_CLASSES,"result.runtimeObservation.failureClass"),evidenceRefDigest:digestRef(observationRecord.evidenceRefDigest,"result.runtimeObservation.evidenceRefDigest",{nullable:true}),observationDigest:digestRef(observationRecord.observationDigest,"result.runtimeObservation.observationDigest"),lastSeenAtBindingDigest:digestRef(observationRecord.lastSeenAtBindingDigest,"result.runtimeObservation.lastSeenAtBindingDigest")};
  const health=exactRecord(r.health,HEALTH_FIELDS,"result.health"); enumValue(health.status,RUNTIME_HEALTH_STATUSES,"result.health.status"); integer(health.lastSeenAt,"result.health.lastSeenAt",{nullable:true}); if(observation.lastSeenAtBindingDigest!==digest({observationDigest:observation.observationDigest,lastSeenAt:health.lastSeenAt}))fail("result last-seen binding is invalid"); if(health.temporalScope!=="point_in_time_observation_only"||health.currentLivenessClaimed!==false||health.projectionOnly!==true||health.authoritative!==false)fail("result health authority is invalid"); enumValue(health.source,SOURCES,"result.health.source"); digestRef(health.evidenceRefDigest,"result.health.evidenceRefDigest",{nullable:true}); const healthReasons=denseArray(health.reasonCodes,"result.health.reasonCodes").map((reason)=>enumValue(reason,REASON_CODES,"result health reason")); if(new Set(healthReasons).size!==healthReasons.length||healthReasons.some((reason,index)=>reason!==ordered(healthReasons)[index]))fail("result health reasons are not canonical");
  const excluded=normalizeExcluded(r.excludedSignals,"result.excludedSignals"); const disposition=exactRecord(r.disposition,DISPOSITION_FIELDS,"result.disposition"); enumValue(disposition.state,RUNTIME_HEALTH_DISPOSITIONS,"result.disposition.state"); const dispositionReasons=denseArray(disposition.reasonCodes,"result.disposition.reasonCodes").map((reason)=>enumValue(reason,REASON_CODES,"result disposition reason")); if(JSON.stringify(dispositionReasons)!==JSON.stringify(healthReasons))fail("result reason ledgers must match"); const evidenceRefs=denseArray(disposition.evidenceRefs,"result.disposition.evidenceRefs").map((ref)=>digestRef(ref,"result disposition evidence")); if(evidenceRefs.length!==3||evidenceRefs[0]!==r.bindingDigest||evidenceRefs[2]!==observation.observationDigest)fail("result disposition evidence is invalid");
  const mapped=health.status==="responsive_at_observation"?"observed":["unresponsive_at_observation_deadline","unavailable_at_observation","failed_at_observation"].includes(health.status)?"degraded":health.status; if(disposition.state!==mapped)fail("result disposition does not match health status"); const accepted=!["not_observed","in_doubt"].includes(health.status); if(accepted?(health.lastSeenAt===null||health.source!=="stage_runner_bridge_native_invocation"||health.evidenceRefDigest===null):(health.lastSeenAt!==null||health.source!=="none"||health.evidenceRefDigest!==null))fail("result health evidence projection is invalid");
  assertProjectedSemanticConsistency({observation,health,healthReasons,excludedSignals:excluded});
  const events=denseArray(r.eventIntents,"result.eventIntents"); if(events.length!==1)fail("result must contain one event intent"); const event=exactRecord(events[0],EVENT_FIELDS,"result.eventIntents[0]"); if(event.kind!=="runtime_health_shadow_observed"||event.disposition!==disposition.state||event.reasonCodesDigest!==digest(healthReasons)||event.persisted!==false||event.authoritative!==false||event.writeAllowed!==false)fail("result event intent is invalid"); if(event.intentDigest!==digest({bindingDigest:r.bindingDigest,runtimeObservation:observation,health:{...health,reasonCodes:healthReasons},excludedSignals:excluded,disposition:{state:disposition.state,reasonCodes:dispositionReasons,evidenceRefs}}))fail("result intent digest is invalid");
  const auth=exactRecord(r.authorization,AUTHORIZATION_FIELDS,"result.authorization"); for(const field of AUTHORIZATION_FIELDS)if(auth[field]!==false)fail("result authorization must be false"); return result;
}
