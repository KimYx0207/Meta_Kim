import { canonicalDigest } from "../shared/canonical-digest.mjs";
import {
  READ_ONLY_RUN_CANONICAL_PROJECTION_IDS,
  READ_ONLY_RUN_EVALUATION_STATUSES,
  READ_ONLY_RUN_PROJECTION_AUTHORIZATION_FIELDS,
  containsReadOnlyRunSensitiveMaterial,
} from "./read-only-run-projection-schema.mjs";

export const READ_ONLY_RUN_PROJECTION_SURFACES_SCHEMA_VERSION = "read-only-run-projection-surfaces-v1";
export const READ_ONLY_RUN_PROJECTION_STATUSES = Object.freeze(["projected", "in_doubt"]);
export { READ_ONLY_RUN_PROJECTION_AUTHORIZATION_FIELDS };
const COMMAND_FIELDS = ["authoritySnapshot"];
const BINDING_FIELDS = ["runId", "taskFingerprint", "graphDigest", "durableCursor", "headEventHash", "headCheckpointId", "policyDigest"];
const RESULT_FIELDS = ["schemaVersion", "kind", "binding", "bindingDigest", "sourceSnapshotDigest", "status", "semantic", "semanticDigest", "eventIntents", "authorization"];
const SEMANTIC_FIELDS = ["runId", "runStatus", "currentStage", "durableCursor", "headCheckpointId", "sourceSnapshotDigest", "nodeStates", "projectionStates"];
const NODE_STATE_FIELDS = ["nodeId", "status"];
const PROJECTION_STATE_FIELDS = ["projectionId", "evaluationStatus", "resultDigest"];
const SHA = /^sha256:[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9:._-]{1,160}$/u;

function fail(message) { throw new TypeError(`Invalid read-only run projection model: ${message}`); }
function plain(value) {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some((key) => typeof key !== "string")) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => descriptor.enumerable === true && "value" in descriptor);
}
function exact(value, fields, label) {
  if (!plain(value) || Object.keys(value).sort().join("|") !== [...fields].sort().join("|")) fail(`${label} must contain exact own data fields`);
  return value;
}
function dense(value, label) {
  if (!Array.isArray(value) || Reflect.ownKeys(value).some((key) => key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(String(key)))) fail(`${label} must be dense`);
  for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, index)) fail(`${label} must be dense`);
  return value;
}
function safeId(value, label) { const normalized = typeof value === "string" ? value.normalize("NFKC") : value; if (typeof normalized !== "string" || !SAFE_ID.test(normalized) || containsReadOnlyRunSensitiveMaterial(normalized)) fail(`${label} must be a safe identifier`); return normalized; }
function digest(value, label) { if (typeof value !== "string" || !SHA.test(value)) fail(`${label} must be a strict sha256 reference`); return value; }
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; }
function authorization() { return Object.fromEntries(READ_ONLY_RUN_PROJECTION_AUTHORIZATION_FIELDS.map((field) => [field, false])); }

export function buildReadOnlyRunProjectionModel(command) {
  exact(command, COMMAND_FIELDS, "command");
  const snapshot = command.authoritySnapshot;
  const semantic = {
    runId: snapshot.binding.runId,
    runStatus: snapshot.runStatus,
    currentStage: snapshot.currentStage,
    durableCursor: snapshot.binding.durableCursor,
    headCheckpointId: snapshot.binding.headCheckpointId,
    sourceSnapshotDigest: snapshot.snapshotDigest,
    nodeStates: snapshot.stageDag.nodes.map(({ nodeId, status }) => ({ nodeId, status })),
    projectionStates: snapshot.canonicalProjections.map(({ projectionId, evaluationStatus, resultDigest }) => ({ projectionId, evaluationStatus, resultDigest })),
  };
  const bindingDigest = canonicalDigest(snapshot.binding);
  const semanticDigest = canonicalDigest(semantic);
  const status = semantic.projectionStates.every((projection) => projection.evaluationStatus === "evaluated")
    ? "projected"
    : "in_doubt";
  const result = {
    schemaVersion: READ_ONLY_RUN_PROJECTION_SURFACES_SCHEMA_VERSION,
    kind: "read_only_run_projection_model",
    binding: snapshot.binding,
    bindingDigest,
    sourceSnapshotDigest: snapshot.snapshotDigest,
    status,
    semantic,
    semanticDigest,
    eventIntents: [{ kind: "read_only_run_projection_observed", intentDigest: canonicalDigest({ bindingDigest, sourceSnapshotDigest: snapshot.snapshotDigest, semanticDigest }), persisted: false, authoritative: false, writeAllowed: false }],
    authorization: authorization(),
  };
  assertValidReadOnlyRunProjectionModel(result);
  return deepFreeze(result);
}

export function assertValidReadOnlyRunProjectionModel(result) {
  exact(result, RESULT_FIELDS, "result");
  if (result.schemaVersion !== READ_ONLY_RUN_PROJECTION_SURFACES_SCHEMA_VERSION || result.kind !== "read_only_run_projection_model" || !READ_ONLY_RUN_PROJECTION_STATUSES.includes(result.status)) fail("result identity is invalid");
  exact(result.binding, BINDING_FIELDS, "result.binding");
  safeId(result.binding.runId, "result.binding.runId");
  digest(result.binding.taskFingerprint, "result.binding.taskFingerprint");
  digest(result.binding.graphDigest, "result.binding.graphDigest");
  if (!Number.isSafeInteger(result.binding.durableCursor) || result.binding.durableCursor < 0) fail("result.binding.durableCursor is invalid");
  digest(result.binding.headEventHash, "result.binding.headEventHash");
  safeId(result.binding.headCheckpointId, "result.binding.headCheckpointId");
  digest(result.binding.policyDigest, "result.binding.policyDigest");
  if (result.bindingDigest !== canonicalDigest(result.binding)) fail("binding digest mismatch");
  digest(result.sourceSnapshotDigest, "result.sourceSnapshotDigest");
  exact(result.semantic, SEMANTIC_FIELDS, "result.semantic");
  dense(result.semantic.nodeStates, "result.semantic.nodeStates");
  dense(result.semantic.projectionStates, "result.semantic.projectionStates");
  if (result.semantic.runId !== result.binding.runId || result.semantic.durableCursor !== result.binding.durableCursor || result.semantic.headCheckpointId !== result.binding.headCheckpointId) fail("semantic binding is inconsistent");
  safeId(result.semantic.runStatus, "result.semantic.runStatus");
  safeId(result.semantic.currentStage, "result.semantic.currentStage");
  const seenNodeIds = new Set();
  for (const [index, node] of result.semantic.nodeStates.entries()) {
    exact(node, NODE_STATE_FIELDS, `result.semantic.nodeStates[${index}]`);
    safeId(node.nodeId, `result.semantic.nodeStates[${index}].nodeId`);
    safeId(node.status, `result.semantic.nodeStates[${index}].status`);
    if (seenNodeIds.has(node.nodeId)) fail("semantic node ids must be unique");
    seenNodeIds.add(node.nodeId);
  }
  if (result.semantic.projectionStates.length !== READ_ONLY_RUN_CANONICAL_PROJECTION_IDS.length) fail("all A01-A07 projection states are required");
  for (const [index, projection] of result.semantic.projectionStates.entries()) {
    exact(projection, PROJECTION_STATE_FIELDS, `result.semantic.projectionStates[${index}]`);
    if (projection.projectionId !== READ_ONLY_RUN_CANONICAL_PROJECTION_IDS[index]) fail("projection states must be complete and ordered");
    if (!READ_ONLY_RUN_EVALUATION_STATUSES.includes(projection.evaluationStatus)) fail("projection evaluation status is invalid");
    digest(projection.resultDigest, `result.semantic.projectionStates[${index}].resultDigest`);
  }
  const derivedStatus = result.semantic.projectionStates.every((projection) => projection.evaluationStatus === "evaluated") ? "projected" : "in_doubt";
  if (result.status !== derivedStatus) fail("result status contradicts projection states");
  if (result.semanticDigest !== canonicalDigest(result.semantic)) fail("semantic digest mismatch");
  if (result.sourceSnapshotDigest !== result.semantic.sourceSnapshotDigest) fail("snapshot reference is inconsistent");
  exact(result.authorization, READ_ONLY_RUN_PROJECTION_AUTHORIZATION_FIELDS, "result.authorization");
  if (!Object.values(result.authorization).every((value) => value === false)) fail("authorization must remain false");
  dense(result.eventIntents, "result.eventIntents");
  if (result.eventIntents.length !== 1) fail("one non-persistent event intent is required");
  const intent = exact(result.eventIntents[0], ["kind", "intentDigest", "persisted", "authoritative", "writeAllowed"], "result.eventIntents[0]");
  if (intent.kind !== "read_only_run_projection_observed" || intent.persisted !== false || intent.authoritative !== false || intent.writeAllowed !== false || intent.intentDigest !== canonicalDigest({ bindingDigest: result.bindingDigest, sourceSnapshotDigest: result.sourceSnapshotDigest, semanticDigest: result.semanticDigest })) fail("event intent is invalid");
  return result;
}
