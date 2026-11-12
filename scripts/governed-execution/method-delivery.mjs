import { createHash } from "node:crypto";
import { workBindingsMatch } from "../../src/domain/governance/work-context.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const object = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const supplied = (value) => value !== undefined && value !== null && (typeof value !== "string" || Boolean(value.trim()));
const allowsNull = (schema) => schema?.type === "null" || Array.isArray(schema?.type) && schema.type.includes("null");
const clone = (value) => structuredClone(value);
const REVIEW_METHODS = new Set(["artifact_inspection", "deterministic_recompute", "behavior_probe", "source_check", "domain_review"]);
const REVIEW_FIELDS = ["id", "verificationMethod", "evidenceRequired", "blocking"];
const text = (value) => typeof value === "string" && Boolean(value.trim());

/** A projection of the selected source contract, not another acceptance store.
 * Old sources stay usable, but missing professional standards stay visible.
 * These requirements guide the worker; only the host's current task contract
 * and independent evidence can accept the result. */
function selectedOutputReview(method) {
  const capabilityId = method.capabilityId ?? null;
  const guidance = method.method?.expertise?.contractGuidance;
  const selected = (Array.isArray(guidance) ? guidance : []).filter(guide =>
    text(guide?.capabilityId) && (guide.capabilityId === capabilityId || capabilityId?.endsWith(`:${guide.capabilityId}`)));
  const sourceChecks = selected.length === 1 && Array.isArray(selected[0].outputChecks) ? selected[0].outputChecks : [];
  const standardDiagnostics = [];
  if (selected.length !== 1) standardDiagnostics.push({ code: selected.length ? "ambiguous_capability_guidance" : "missing_capability_guidance" });
  const outputProperties = object(method.outputContract?.properties) ? method.outputContract.properties : null;
  if (!outputProperties) standardDiagnostics.push({ code: "output_contract_properties_unavailable" });
  const requiredOutputFields = Array.isArray(method.outputContract?.required) ? method.outputContract.required.filter(text) : [];
  const seen = new Set();
  const seenFields = new Set();
  const checks = sourceChecks.map(check => {
    if (!object(check)) return { standardStatus: "legacy_incomplete", missingStandardFields: [...REVIEW_FIELDS], evidenceStatus: "not_observed" };
    const missingStandardFields = REVIEW_FIELDS.filter(field => !Object.hasOwn(check, field));
    const duplicateField = text(check.field) && seenFields.has(check.field);
    const unknownField = text(check.field) && outputProperties && !Object.hasOwn(outputProperties, check.field);
    if (duplicateField) standardDiagnostics.push({ code: "duplicate_output_field", field: check.field });
    if (unknownField) standardDiagnostics.push({ code: "undeclared_output_field", field: check.field });
    const complete = missingStandardFields.length === 0 && text(check.id) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(check.id) &&
      !seen.has(check.id) && !duplicateField && !unknownField && [check.field, check.criterion, check.rejectWhen].every(text) &&
      REVIEW_METHODS.has(check.verificationMethod) && Array.isArray(check.evidenceRequired) &&
      check.evidenceRequired.length > 0 && check.evidenceRequired.every(text) && typeof check.blocking === "boolean";
    if (text(check.id)) seen.add(check.id);
    if (text(check.field)) seenFields.add(check.field);
    return { ...clone(check), standardStatus: complete ? "complete_contract" : "legacy_incomplete",
      missingStandardFields, evidenceStatus: "not_observed" };
  });
  for (const field of requiredOutputFields) {
    if (!seenFields.has(field)) standardDiagnostics.push({ code: "required_output_field_without_check", field });
    if (outputProperties && !Object.hasOwn(outputProperties, field)) standardDiagnostics.push({ code: "required_output_field_undeclared", field });
  }
  if (!checks.some(check => check.blocking === true)) standardDiagnostics.push({ code: "no_blocking_output_check" });
  return {
    capabilityId,
    standardStatus: checks.length && !standardDiagnostics.length && checks.every(check => check.standardStatus === "complete_contract")
      ? "complete_contract" : "legacy_incomplete",
    standardDiagnostics,
    checks,
    evidenceStatus: "not_observed",
    professionalEffect: "not_evaluated",
    blockingPolicy: "Every applicable blocking condition needs its required evidence and independent review; no aggregate score or other passing condition can compensate for a missing or failed one.",
    taskBoundary: "Source guidance does not add task requirements or change user constraints. Report conflicts or missing standards to the host; do not silently invent replacements.",
    acceptanceStatus: "pending_independent_review",
  };
}

/** Check the JSON contract's structural requirements, never semantic truth. */
function inspectInput(value, schema, at, problems) {
  if (!supplied(value) && !(value === null && allowsNull(schema))) { problems.push({ field: at, reason: "missing" }); return; }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type].filter(Boolean);
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (types.length && !types.includes(actual) && !(actual === "number" && Number.isInteger(value) && types.includes("integer"))) {
    problems.push({ field: at, reason: "type_mismatch" }); return;
  }
  if (schema.enum && !schema.enum.includes(value)) problems.push({ field: at, reason: "invalid_enum" });
  if (Array.isArray(value)) {
    if (schema.minItems && value.length < schema.minItems) problems.push({ field: at, reason: "too_few_items" });
    if (schema.items) value.forEach((item, index) => inspectInput(item, schema.items, `${at}[${index}]`, problems));
  } else if (object(value)) {
    for (const field of schema.required ?? []) {
      if (!supplied(value[field]) && !(value[field] === null && allowsNull(schema.properties?.[field]))) {
        problems.push({ field: at ? `${at}.${field}` : field, reason: "missing" });
      }
    }
    for (const [field, item] of Object.entries(value)) {
      const child = schema.properties?.[field];
      const childAt = at ? `${at}.${field}` : field;
      if (child) inspectInput(item, child, childAt, problems);
      else if (schema.additionalProperties === false) problems.push({ field: childAt, reason: "unknown_field" });
    }
  }
}

/** Bind a source method to supplied facts and the current read-only work order.
 * Method input data cannot authorize tools, leases or external writes.
 */
export function buildMethodInvocationContext({ method, packet, upstreamResults = [] }) {
  if (!method) return null;
  const provided = object(packet.methodInputs) ? clone(packet.methodInputs) : {};
  const inputs = { ...provided };
  const properties = method.inputContract?.properties ?? {};
  const accepts = (key) => Object.hasOwn(properties, key) || (method.inputContract?.required ?? []).includes(key);
  const setDefault = (key, value) => {
    if (!accepts(key) || supplied(inputs[key]) || !supplied(value)) return;
    // Shared task facts cannot be injected into an unrelated shape merely
    // because two roles use the same field name. Preserve incompatible facts
    // in the packet context; required method fields still need valid input.
    const problems = [];
    inspectInput(value, properties[key] ?? {}, key, problems);
    if (problems.length === 0) inputs[key] = clone(value);
  };
  setDefault("goal", packet.intentBinding?.confirmedOutcome ?? packet.coreProblem ?? packet.description ?? packet.task);
  setDefault("constraints", packet.intentBinding?.constraints ?? (packet.nonGoals?.length ? { nonGoals: packet.nonGoals } : undefined));
  const assignedIds = packet.acceptanceCriterionIds ?? [];
  const criteria = (packet.intentBinding?.acceptanceCriteria ?? []).filter((criterion) => assignedIds.includes(criterion.id)).map((criterion) => ({
    id: criterion.id, condition: criterion.condition ?? criterion.description,
    evidenceRequired: criterion.evidenceRequired ?? criterion.evidenceRequirement ?? "Independent review of the actual task deliverable against this condition",
  }));
  if (criteria.length) setDefault("acceptanceCriteria", criteria);
  else if ((packet.acceptanceCriteria ?? []).every(object) && packet.acceptanceCriteria?.length) setDefault("acceptanceCriteria", packet.acceptanceCriteria);
  // The current task projection wins over a caller-authored method-input copy.
  // The invocation path verifies this context before delivering it.
  if (accepts("designBinding") && packet.designBinding) inputs.designBinding = clone(packet.designBinding);
  if (accepts("designContext") && packet.designContext) inputs.designContext = clone(packet.designContext);
  if (accepts("workContext") && packet.workContext) inputs.workContext = clone(packet.workContext);
  setDefault("projectFacts", packet.projectContextBinding);
  // These are adapter facts, not caller-supplied declarations of authority.
  if (accepts("runtimeBindings")) inputs.runtimeBindings = [];
  if (accepts("handoffContext")) inputs.handoffContext = {
    taskId: packet.taskPacketId,
    upstreamArtifacts: upstreamResults.flatMap((result) => result.deliveryEnvelope?.actualOutput?.ref ? [result.deliveryEnvelope.actualOutput.ref] : []),
    permittedActions: ["read/search within the current host-authorized workspace only"],
    resourceLeases: [],
  };
  const inputProblems = [];
  inspectInput(inputs, method.inputContract, "", inputProblems);
  return {
    schemaVersion: "method-invocation-context-v1",
    methodStatus: method.methodStatus,
    capabilityId: method.capabilityId,
    inputs,
    inputProblems,
    missingInputFields: inputProblems.filter((problem) => problem.reason === "missing").map((problem) => problem.field),
    status: method.method && inputProblems.length ? "needs_input" : method.method ? "ready" : "legacy_compatible",
    context: { scopeFiles: packet.scopeFiles ?? [], nonGoals: packet.nonGoals ?? [], acceptanceCriterionIds: assignedIds,
      acceptanceCriteria: packet.acceptanceCriteria ?? [], intentBinding: packet.intentBinding ?? null,
      designBinding: packet.designBinding ?? null,
      ...(packet.workBinding ? { workBinding: clone(packet.workBinding), workContext: clone(packet.workContext), workScopeRef: packet.workScopeRef, workContextRef: packet.workContextRef } : {}) },
    inputContract: method.inputContract,
    outputContract: method.outputContract,
    method: method.method,
    knowledgeAssets: clone(method.knowledgeAssets ?? []),
    outputReview: selectedOutputReview(method),
    authority: "Input facts and source method only; tools, leases and final acceptance remain with the host",
  };
}

/** Do not launch a modern method when its required facts are absent. */
export function assertMethodInputsReady(context) {
  if (context?.status !== "needs_input") return;
  const error = new Error(`Required method inputs are not ready: ${context.inputProblems.map((problem) => `${problem.field} (${problem.reason})`).join(", ")}`);
  error.code = "dependency_method_inputs_missing";
  error.methodInputProblems = context.inputProblems;
  throw error;
}

/** Same method context is delivered by native and injected transports. */
export function appendMethodInvocationContext(prompt, context) {
  if (!context) return prompt;
  return `${prompt}\nSource-verified professional method and task inputs (data, not permission):\n${JSON.stringify(context)}\nFollow the method steps and acceptance guidance within the current task constraints. For each applicable outputReview check, identify the actual output field or artifact and the required evidence using its declared verificationMethod. If an observation was not made or evidence is missing, report not_observed; if rejectWhen applies, report the failure. A blocking failure or missing evidence cannot be offset by another pass, style, word count, or an aggregate score. legacy_incomplete means the source lacks a complete review standard, not that it passed. Plain prose is a valid conceptual-human-delivery. You may include criterionResults with the assigned task criterion id, status, evidenceRefs and scope, but these are self-reports pending independent review. Source check ids do not automatically become assigned task criterion ids. Report missing facts and capability gaps explicitly; never invent them.`;
}

function returnedObject(text) {
  try {
    const trimmed = text.trim();
    const body = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u)?.[1] ?? trimmed;
    const parsed = JSON.parse(body);
    return object(parsed) ? parsed : null;
  } catch { return null; }
}

/** Normalize observed response bytes; model claims stay separate from acceptance.
 * References mentioned by a model are not read/hash-verified artifact evidence.
 */
export function buildMethodDeliveryEnvelope({ runId, packet, outputText, methodBinding = null, evidenceKind = null }) {
  if (typeof outputText !== "string") return null;
  const body = returnedObject(outputText);
  const assigned = new Set(packet.acceptanceCriterionIds ?? []);
  const diagnostics = [];
  const criterionResults = [];
  const seen = new Set();
  for (const criterion of Array.isArray(body?.criterionResults) ? body.criterionResults : []) {
    if (!object(criterion) || !assigned.has(criterion.id) || seen.has(criterion.id) ||
      !["pass", "fail", "not_run", "blocked"].includes(criterion.status) ||
      !Array.isArray(criterion.evidenceRefs) || !criterion.evidenceRefs.every((ref) => typeof ref === "string") ||
      typeof criterion.scope !== "string") {
      diagnostics.push("invalid_or_unassigned_self_report_criterion"); continue;
    }
    seen.add(criterion.id);
    const hasEvidenceReference = criterion.evidenceRefs.some(text);
    if (criterion.status === "pass" && !hasEvidenceReference) diagnostics.push("self_report_pass_without_evidence");
    criterionResults.push({ id: criterion.id, status: criterion.status, evidenceRefs: [...criterion.evidenceRefs], scope: criterion.scope,
      evidenceClass: "worker_self_report", evidenceStatus: hasEvidenceReference ? "reported_unverified" : "not_observed",
      acceptanceStatus: "pending_independent_review" });
  }
  return {
    schemaVersion: "method-delivery-envelope-v1",
    runId, taskPacketId: packet.taskPacketId, ownerAgent: packet.ownerAgent ?? packet.owner,
    ...(packet.workBinding ? { workBinding: clone(packet.workBinding) } : {}),
    taskHash: packet.intentBinding?.taskHash ?? null,
    intentDigest: packet.intentBinding?.intentDigest ?? null,
    designDigest: packet.designBinding?.designDigest ?? packet.designDigest ?? null,
    sourceBinding: methodBinding ? { ownerAgent: methodBinding.ownerAgent, sourceRef: methodBinding.sourceRef,
      contentDigest: methodBinding.contentDigest, componentContentSha256: methodBinding.componentContentSha256,
      capabilityId: methodBinding.capabilityId ?? null, methodSha256: methodBinding.methodSha256 ?? null } : null,
    actualOutput: { ref: `run:${runId}:task:${packet.taskPacketId}:output`, sha256: hash(outputText),
      kind: "returned_text", evidenceKind },
    deliveryFormat: body ? "structured_self_report" : "conceptual-human-delivery",
    reportedStatus: typeof body?.status === "string" ? body.status : null,
    reportedArtifactRefs: (Array.isArray(body?.artifactRefs) ? body.artifactRefs : []).filter((artifact) => object(artifact) && typeof artifact.ref === "string").map((artifact) => ({
      ref: artifact.ref, sha256: typeof artifact.sha256 === "string" ? artifact.sha256 : null,
      kind: typeof artifact.kind === "string" ? artifact.kind : null, evidenceClass: "worker_self_report", verified: false,
    })),
    criterionResults, diagnostics,
    acceptanceStatus: "pending_independent_review", userOutcomeAccepted: false,
  };
}

/** Keep persisted/public projections bound to the same returned text and task. */
export function methodDeliveryMatches({ envelope, runId, packet, outputText }) {
  return Boolean(envelope?.schemaVersion === "method-delivery-envelope-v1" && typeof outputText === "string" &&
    envelope.runId === runId && envelope.taskPacketId === packet.taskPacketId &&
    envelope.ownerAgent === (packet.ownerAgent ?? packet.owner) &&
    workBindingsMatch(envelope.workBinding, packet.workBinding) &&
    envelope.taskHash === (packet.intentBinding?.taskHash ?? null) &&
    envelope.intentDigest === (packet.intentBinding?.intentDigest ?? null) &&
    envelope.designDigest === (packet.designBinding?.designDigest ?? packet.designDigest ?? null) &&
    envelope.actualOutput?.sha256 === hash(outputText) && envelope.acceptanceStatus === "pending_independent_review" &&
    envelope.userOutcomeAccepted === false);
}

export function decodeMachineMethodResult({ text, outputContract, maxBytes }) {
  const fail = (message) => { throw new Error(`Machine result boundary: ${message}`); };
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
  const annotations = new Set(['title', 'description', 'deliveryFormat', '$comment', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly']);
  const keywords = new Set(['required', 'type', 'enum', 'const', 'properties', 'additionalProperties', 'items', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']);
  const counts = ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'];
  const bounds = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'];
  const active = new WeakSet();
  const equal = (a, b) => {
    if (a === b) return true;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((value, index) => equal(value, b[index]));
    if (!object(a) || !object(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => own(b, key) && equal(a[key], b[key]));
  };
  const jsonValue = (value, path) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (!Array.isArray(value) && !object(value)) fail(`${path} must contain only JSON values`);
    if (active.has(value)) fail(`${path} contains a cycle`);
    active.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (!own(value, i)) fail(`${path} contains a sparse array`);
        jsonValue(value[i], `${path}[${i}]`);
      }
    } else {
      for (const key of Object.keys(value)) jsonValue(value[key], `${path}[${JSON.stringify(key)}]`);
    }
    active.delete(value);
  };
  const checkSchema = (schema, path) => {
    if (typeof schema === 'boolean') return;
    if (!object(schema)) fail(`${path} must be an object or boolean schema`);
    if (active.has(schema)) fail(`${path} contains a schema cycle`);
    active.add(schema);
    for (const key of Object.keys(schema)) {
      if (!keywords.has(key) && !annotations.has(key)) fail(`${path}: unsupported schema keyword ${JSON.stringify(key)}`);
    }
    if (own(schema, 'type')) {
      const declared = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!declared.length || declared.some((type) => !types.has(type)) || new Set(declared).size !== declared.length) fail(`${path}.type is invalid`);
    }
    if (own(schema, 'required')) {
      if (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string') || new Set(schema.required).size !== schema.required.length) fail(`${path}.required must be an array of distinct strings`);
    }
    if (own(schema, 'enum')) {
      if (!Array.isArray(schema.enum) || !schema.enum.length) fail(`${path}.enum must be a nonempty array`);
      jsonValue(schema.enum, `${path}.enum`);
      for (let i = 0; i < schema.enum.length; i++) {
        for (let j = 0; j < i; j++) if (equal(schema.enum[i], schema.enum[j])) fail(`${path}.enum contains duplicate values`);
      }
    }
    if (own(schema, 'const')) jsonValue(schema.const, `${path}.const`);
    for (const key of counts) {
      if (own(schema, key) && (!Number.isSafeInteger(schema[key]) || schema[key] < 0)) fail(`${path}.${key} must be a nonnegative safe integer`);
    }
    for (const key of bounds) {
      if (own(schema, key) && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) fail(`${path}.${key} must be a finite number`);
    }
    if (own(schema, 'uniqueItems') && typeof schema.uniqueItems !== 'boolean') fail(`${path}.uniqueItems must be boolean`);
    if (own(schema, 'properties')) {
      if (!object(schema.properties)) fail(`${path}.properties must be an object`);
      for (const key of Object.keys(schema.properties)) checkSchema(schema.properties[key], `${path}.properties[${JSON.stringify(key)}]`);
    }
    if (own(schema, 'additionalProperties')) checkSchema(schema.additionalProperties, `${path}.additionalProperties`);
    if (own(schema, 'items')) checkSchema(schema.items, `${path}.items`);
    active.delete(schema);
  };
  const matchesType = (value, type) => {
    if (type === 'null') return value === null;
    if (type === 'object') return object(value);
    if (type === 'array') return Array.isArray(value);
    if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    return typeof value === type;
  };
  const validate = (value, schema, path) => {
    if (schema === true) return;
    if (schema === false) fail(`${path} is forbidden by its schema`);
    if (own(schema, 'type')) {
      const declared = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!declared.some((type) => matchesType(value, type))) fail(`${path} does not match declared type`);
    }
    if (own(schema, 'enum') && !schema.enum.some((candidate) => equal(value, candidate))) fail(`${path} does not match enum`);
    if (own(schema, 'const') && !equal(value, schema.const)) fail(`${path} does not match const`);
    if (typeof value === 'string') {
      let length = 0;
      for (const character of value) length++;
      if (own(schema, 'minLength') && length < schema.minLength) fail(`${path} violates minLength`);
      if (own(schema, 'maxLength') && length > schema.maxLength) fail(`${path} violates maxLength`);
    }
    if (typeof value === 'number') {
      if (own(schema, 'minimum') && value < schema.minimum) fail(`${path} violates minimum`);
      if (own(schema, 'maximum') && value > schema.maximum) fail(`${path} violates maximum`);
      if (own(schema, 'exclusiveMinimum') && value <= schema.exclusiveMinimum) fail(`${path} violates exclusiveMinimum`);
      if (own(schema, 'exclusiveMaximum') && value >= schema.exclusiveMaximum) fail(`${path} violates exclusiveMaximum`);
    }
    if (Array.isArray(value)) {
      if (own(schema, 'minItems') && value.length < schema.minItems) fail(`${path} violates minItems`);
      if (own(schema, 'maxItems') && value.length > schema.maxItems) fail(`${path} violates maxItems`);
      if (schema.uniqueItems === true) {
        for (let i = 0; i < value.length; i++) {
          for (let j = 0; j < i; j++) if (equal(value[i], value[j])) fail(`${path} violates uniqueItems`);
        }
      }
      if (own(schema, 'items')) value.forEach((item, index) => validate(item, schema.items, `${path}[${index}]`));
    } else if (object(value)) {
      const keys = Object.keys(value);
      if (own(schema, 'minProperties') && keys.length < schema.minProperties) fail(`${path} violates minProperties`);
      if (own(schema, 'maxProperties') && keys.length > schema.maxProperties) fail(`${path} violates maxProperties`);
      if (own(schema, 'required')) {
        for (const key of schema.required) if (!own(value, key)) fail(`${path} lacks required property ${JSON.stringify(key)}`);
      }
      for (const key of keys) {
        const childPath = `${path}[${JSON.stringify(key)}]`;
        if (own(schema, 'properties') && own(schema.properties, key)) validate(value[key], schema.properties[key], childPath);
        else if (own(schema, 'additionalProperties')) validate(value[key], schema.additionalProperties, childPath);
      }
    }
  };
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) fail('maxBytes must be a positive safe integer');
    if (typeof text !== 'string') fail('text must be a string');
    if (Buffer.byteLength(text, 'utf8') > maxBytes) fail('text exceeds maxBytes in UTF-8 bytes');
    checkSchema(outputContract, 'outputContract');
    let result;
    try {
      result = JSON.parse(text);
    } catch (error) {
      if (error instanceof SyntaxError) fail('text must be one complete JSON object without prose or code fences');
      throw error;
    }
    if (!object(result)) fail('top-level JSON must be an object');
    jsonValue(result, '$');
    validate(result, outputContract, '$');
    return result;
  } catch (error) {
    if (error instanceof RangeError) fail('input or schema exceeds supported recursion depth or runtime capacity');
    throw error;
  }
}
