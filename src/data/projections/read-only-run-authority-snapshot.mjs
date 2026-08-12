import { assertValidLeaseClaimAuthorityShadowResult } from "../../domain/claims/lease-claim-authority-shadow.mjs";
import { assertValidContinuationPolicyShadowResult } from "../../domain/continuation/continuation-policy-shadow.mjs";
import { assertValidEvidenceTransitionShadowResult } from "../../domain/evidence/evidence-transition.mjs";
import { assertValidQuotaUsageProjectionResult } from "../../domain/quota/quota-usage-projection.mjs";
import { assertValidRuntimeHealthProjectionResult } from "../../domain/runtime/runtime-health-projection.mjs";
import { assertValidSchedulerAuthorityReuseShadowResult } from "../../domain/scheduling/scheduler-authority-reuse-shadow.mjs";
import { canonicalDigest, sha256Hex } from "../../domain/shared/canonical-digest.mjs";
import { assertValidTodoDependencySafeProgressShadowResult } from "../../domain/work/todo-dependency-safe-progress-shadow.mjs";
import { isAttestedDurableRunProjection, isAttestedDurableRunResume } from "../repositories/sqlite-durable-run-repository.mjs";
import {
  READ_ONLY_RUN_CANONICAL_PROJECTION_IDS,
  READ_ONLY_RUN_EVALUATION_STATUSES,
  containsReadOnlyRunSensitiveMaterial,
} from "../../domain/presentation/read-only-run-projection-schema.mjs";

const BINDING_FIELDS = ["runId", "taskFingerprint", "graphDigest", "durableCursor", "headEventHash", "headCheckpointId", "policyDigest"];
const SNAPSHOT_FIELDS = ["binding", "currentness", "eventChainState", "runStatus", "currentStage", "stageDag", "durableHead", "canonicalProjections", "snapshotDigest"];
const BUILD_FIELDS = ["authoritativeDurableProjection", "authoritativeDurableResume", "stageDag", "canonicalProjectionEnvelopes"];
const PROJECTION_FIELDS = ["projectionId", "evaluationStatus", "resultDigest", "sourceBindingDigest", "settlementBindingDigest"];
const SHA = /^sha256:[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9:._-]{1,160}$/u;
const ATTESTED_SNAPSHOTS = new WeakSet();
const RESULT_VALIDATORS = Object.freeze([
  assertValidEvidenceTransitionShadowResult,
  assertValidContinuationPolicyShadowResult,
  assertValidTodoDependencySafeProgressShadowResult,
  assertValidSchedulerAuthorityReuseShadowResult,
  assertValidLeaseClaimAuthorityShadowResult,
  assertValidRuntimeHealthProjectionResult,
  assertValidQuotaUsageProjectionResult,
]);

function fail(message) { throw new TypeError(`Invalid read-only authority snapshot: ${message}`); }
function plain(value) {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some((key) => typeof key !== "string")) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => descriptor.enumerable === true && "value" in descriptor);
}
function exact(value, fields, label) { if (!plain(value) || Object.keys(value).sort().join("|") !== [...fields].sort().join("|")) fail(`${label} must contain exact own data fields`); return value; }
function dense(value, label, max = 256) {
  if (!Array.isArray(value) || value.length > max || Reflect.ownKeys(value).some((key) => key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(String(key)))) fail(`${label} must be a bounded dense array`);
  for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, index)) fail(`${label} must be dense`);
  return value;
}
function safeId(value, label) { const normalized = typeof value === "string" ? value.normalize("NFKC") : value; if (typeof normalized !== "string" || !SAFE_ID.test(normalized) || containsReadOnlyRunSensitiveMaterial(normalized)) fail(`${label} must be a safe identifier`); return normalized; }
function digestRef(value, label) { if (typeof value !== "string" || !SHA.test(value)) fail(`${label} must be a strict sha256 reference`); return value; }
function binding(value, label) {
  exact(value, BINDING_FIELDS, label);
  const result = { runId: safeId(value.runId, `${label}.runId`), taskFingerprint: digestRef(value.taskFingerprint, `${label}.taskFingerprint`), graphDigest: digestRef(value.graphDigest, `${label}.graphDigest`), durableCursor: value.durableCursor, headEventHash: digestRef(value.headEventHash, `${label}.headEventHash`), headCheckpointId: safeId(value.headCheckpointId, `${label}.headCheckpointId`), policyDigest: digestRef(value.policyDigest, `${label}.policyDigest`) };
  if (!Number.isSafeInteger(result.durableCursor) || result.durableCursor < 0) fail(`${label}.durableCursor must be a non-negative safe integer`);
  return result;
}
function sameBinding(left, right) { return BINDING_FIELDS.every((field) => left[field] === right[field]); }
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; }
function digestReference(value) { const normalized = String(value ?? ""); if (SHA.test(normalized)) return normalized; if (/^[a-f0-9]{64}$/u.test(normalized)) return `sha256:${normalized}`; return `sha256:${sha256Hex(normalized)}`; }

function validateProjectionEnvelope(raw, index, root) {
  const projectionId = READ_ONLY_RUN_CANONICAL_PROJECTION_IDS[index];
  const settlementBindingDigest = canonicalDigest(root);
  if (raw === null) return { projectionId, evaluationStatus: "not_evaluated", resultDigest: canonicalDigest({ projectionId, evaluationStatus: "not_evaluated" }), sourceBindingDigest: null, settlementBindingDigest };
  if (!plain(raw) || typeof raw.evaluationStatus !== "string" || !Object.hasOwn(raw, "result")) fail(`${projectionId} envelope is invalid`);
  if (!READ_ONLY_RUN_EVALUATION_STATUSES.includes(raw.evaluationStatus) && !raw.evaluationStatus.startsWith("not_evaluated_")) fail(`${projectionId} evaluation status is invalid`);
  if (raw.result === null) return { projectionId, evaluationStatus: "not_evaluated", resultDigest: canonicalDigest({ projectionId, evaluationStatus: raw.evaluationStatus }), sourceBindingDigest: null, settlementBindingDigest };
  if (raw.evaluationStatus !== "evaluated") fail(`${projectionId} result contradicts its evaluation status`);
  RESULT_VALIDATORS[index](raw.result);
  const sourceBinding = raw.result.binding;
  if (!plain(sourceBinding) || sourceBinding.runId !== root.runId || sourceBinding.taskFingerprint !== root.taskFingerprint || sourceBinding.graphDigest !== root.graphDigest) fail(`${projectionId} result binding does not match the durable settlement`);
  for (const [sourceField, rootField] of [["durableCursor", "durableCursor"], ["headEventHash", "headEventHash"], ["headCheckpointId", "headCheckpointId"]]) {
    if (Object.hasOwn(sourceBinding, sourceField) && sourceBinding[sourceField] !== root[rootField]) fail(`${projectionId} result head binding is stale`);
  }
  return { projectionId, evaluationStatus: "evaluated", resultDigest: canonicalDigest(raw.result), sourceBindingDigest: digestRef(raw.result.bindingDigest, `${projectionId}.bindingDigest`), settlementBindingDigest };
}

function normalizeSnapshotPayload(snapshot) {
  const root = binding(snapshot.binding, "snapshot.binding");
  if (snapshot.currentness !== "fresh_bound_same_settlement" || snapshot.eventChainState !== "verified") fail("snapshot must be fresh and event-chain verified");
  if (!["active", "completed", "failed", "blocked"].includes(snapshot.runStatus)) fail("runStatus is unsupported");
  const currentStage = safeId(snapshot.currentStage, "snapshot.currentStage");
  const stageDag = exact(snapshot.stageDag, ["graphDigest", "nodes"], "snapshot.stageDag");
  if (digestRef(stageDag.graphDigest, "snapshot.stageDag.graphDigest") !== root.graphDigest) fail("stageDag graph digest mismatch");
  const seenNodes = new Set();
  const nodes = dense(stageDag.nodes, "snapshot.stageDag.nodes").map((raw, index) => {
    const node = exact(raw, ["nodeId", "status"], `snapshot.stageDag.nodes[${index}]`);
    const normalized = { nodeId: safeId(node.nodeId, `snapshot.stageDag.nodes[${index}].nodeId`), status: safeId(node.status, `snapshot.stageDag.nodes[${index}].status`) };
    if (seenNodes.has(normalized.nodeId)) fail("stageDag node ids must be unique");
    seenNodes.add(normalized.nodeId); return normalized;
  });
  const durableHead = binding(snapshot.durableHead, "snapshot.durableHead");
  if (!sameBinding(root, durableHead)) fail("durable head binding mismatch");
  const canonicalProjections = dense(snapshot.canonicalProjections, "snapshot.canonicalProjections", READ_ONLY_RUN_CANONICAL_PROJECTION_IDS.length).map((raw, index) => {
    const item = exact(raw, PROJECTION_FIELDS, `snapshot.canonicalProjections[${index}]`);
    if (item.projectionId !== READ_ONLY_RUN_CANONICAL_PROJECTION_IDS[index]) fail("canonical projections must be complete and ordered");
    if (!READ_ONLY_RUN_EVALUATION_STATUSES.includes(item.evaluationStatus)) fail("canonical projection evaluation status is unsupported");
    return { projectionId: item.projectionId, evaluationStatus: item.evaluationStatus, resultDigest: digestRef(item.resultDigest, `${item.projectionId}.resultDigest`), sourceBindingDigest: item.sourceBindingDigest === null ? null : digestRef(item.sourceBindingDigest, `${item.projectionId}.sourceBindingDigest`), settlementBindingDigest: digestRef(item.settlementBindingDigest, `${item.projectionId}.settlementBindingDigest`) };
  });
  if (canonicalProjections.length !== READ_ONLY_RUN_CANONICAL_PROJECTION_IDS.length || canonicalProjections.some((item) => item.settlementBindingDigest !== canonicalDigest(root))) fail("all A01-A07 projections must bind the same settlement");
  return { binding: root, currentness: snapshot.currentness, eventChainState: snapshot.eventChainState, runStatus: snapshot.runStatus, currentStage, stageDag: { graphDigest: root.graphDigest, nodes }, durableHead, canonicalProjections };
}

export function buildReadOnlyRunAuthoritySnapshot(input) {
  exact(input, BUILD_FIELDS, "builder input");
  const projection = input.authoritativeDurableProjection;
  const resume = input.authoritativeDurableResume;
  if (!isAttestedDurableRunProjection(projection) || !isAttestedDurableRunResume(resume)) fail("durable inputs are not kernel-attested or were modified after projection");
  const lastEvent = projection.events.at(-1) ?? null;
  const policyDigest = canonicalDigest({ schemaVersion: "read-only-run-projection-policy-v1", projectionBindings: input.canonicalProjectionEnvelopes.map((item) => item?.result?.bindingDigest ?? null) });
  const root = binding({
    runId: projection.run.runId,
    taskFingerprint: digestReference(projection.run.taskFingerprint),
    graphDigest: digestReference(projection.run.graphDigest),
    durableCursor: projection.cursor,
    headEventHash: lastEvent ? digestReference(lastEvent.eventHash) : canonicalDigest({ runId: projection.run.runId, cursor: projection.cursor, emptyEventHead: true }),
    headCheckpointId: projection.headCheckpointId ?? `checkpoint:none:${projection.run.runId}`,
    policyDigest,
  }, "kernel-derived binding");
  const sameHead = projection.run.runId === resume.runId && projection.run.rootRunId === resume.rootRunId && projection.cursor === resume.cursor && projection.headCheckpointId === resume.headCheckpointId && projection.eventChain?.ok === true && (lastEvent === null || lastEvent.eventSeq === resume.cursor);
  if (!sameHead) fail("durable projection and resume are not the same verified head");
  if (!input.stageDag || digestReference(input.stageDag.graphDigest) !== root.graphDigest || !Array.isArray(input.stageDag.nodes)) fail("stageDag does not match the attested durable graph");
  const envelopes = dense(input.canonicalProjectionEnvelopes, "builder input.canonicalProjectionEnvelopes", READ_ONLY_RUN_CANONICAL_PROJECTION_IDS.length);
  if (envelopes.length !== READ_ONLY_RUN_CANONICAL_PROJECTION_IDS.length) fail("builder requires exactly seven canonical envelopes");
  const completed = new Set(projection.completedNodes.map((item) => item.nodeId));
  const claimed = new Set((resume.activeClaims ?? []).map((item) => item.nodeId));
  const blocked = new Set((resume.blockingEffects ?? []).map((item) => item.nodeId));
  const inDoubt = new Set(projection.events.filter((item) => item.eventType === "NodeAttemptInDoubt").map((item) => item.nodeId));
  const currentStage = input.stageDag.nodes.find((node) => !completed.has(node.nodeId))?.stage ?? input.stageDag.stageOrder?.at(-1) ?? "Verification";
  const payload = normalizeSnapshotPayload({
    binding: root,
    currentness: "fresh_bound_same_settlement",
    eventChainState: "verified",
    runStatus: projection.run.status,
    currentStage,
    stageDag: { graphDigest: root.graphDigest, nodes: input.stageDag.nodes.map((node) => ({ nodeId: node.nodeId, status: completed.has(node.nodeId) ? "completed" : inDoubt.has(node.nodeId) ? "in_doubt" : blocked.has(node.nodeId) ? "blocked" : claimed.has(node.nodeId) ? "running" : "pending" })) },
    durableHead: { ...root },
    canonicalProjections: envelopes.map((raw, index) => validateProjectionEnvelope(raw, index, root)),
    snapshotDigest: "sha256:" + "0".repeat(64),
  });
  const snapshot = deepFreeze({ ...payload, snapshotDigest: canonicalDigest(payload) });
  ATTESTED_SNAPSHOTS.add(snapshot);
  return snapshot;
}

export function digestReadOnlyRunAuthoritySnapshotPayload(payload) { return canonicalDigest(payload); }

export function normalizeReadOnlyRunAuthoritySnapshot(input) {
  if (!ATTESTED_SNAPSHOTS.has(input)) fail("snapshot was not produced by the trusted authority builder");
  const snapshot = exact(input, SNAPSHOT_FIELDS, "snapshot");
  const payload = normalizeSnapshotPayload(snapshot);
  if (digestRef(snapshot.snapshotDigest, "snapshot.snapshotDigest") !== canonicalDigest(payload)) fail("snapshot digest mismatch");
  return input;
}

export { READ_ONLY_RUN_CANONICAL_PROJECTION_IDS };
