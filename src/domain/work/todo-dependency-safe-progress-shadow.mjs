/**
 * Pure M3-A03 Todo/dependency/Safe Independent Progress shadow.
 *
 * Work items are a one-to-one projection of the authoritative topology. The
 * projection cannot create Todo truth, select a scheduler ready set, dispatch,
 * claim, retry, or mutate any durable/runtime state.
 */

export const TODO_DEPENDENCY_SAFE_PROGRESS_SHADOW_SCHEMA_VERSION = "todo-dependency-safe-progress-shadow-v1";
export const TODO_DEPENDENCY_SAFE_PROGRESS_SHADOW_DISPOSITIONS = Object.freeze([
  "candidates_available", "safe_independent_candidates_available", "wait", "stop", "escalate", "in_doubt",
]);
export const TODO_DEPENDENCY_SAFE_PROGRESS_SHADOW_REASON_CODES = deepFreeze({
  candidates_available: ["all_dependencies_completed", "continuation_shadow_recommends_continue"],
  safe_independent_candidates_available: [
    "all_dependencies_completed", "pending_decision_outside_dependency_closure",
    "decision_only_wait_preserves_independent_candidate", "shadow_safe_effect_boundary",
  ],
  wait: [
    "dependency_incomplete", "pending_decision_in_dependency_closure", "active_claim_present",
    "unresolved_effect_present", "execution_currentness_unproven", "continuation_wait_not_decision_only",
    "no_dependency_ready_candidate", "side_effect_boundary_not_shadow_safe",
  ],
  stop: ["continuation_policy_stopped", "authoritative_run_terminal"],
  escalate: [
    "topology_binding_mismatch", "execution_projection_integrity_failed", "node_projection_not_bijective",
    "contradictory_node_state", "evidence_transition_binding_mismatch", "continuation_binding_mismatch",
    "unsupported_shadow_input",
  ],
  in_doubt: ["decision_gate_unbound"],
});

const COMMAND_FIELDS = ["binding", "topology", "executionSnapshot", "decisionSnapshot", "evidenceTransition", "continuation"];
const BINDING_FIELDS = [
  "runId", "taskFingerprint", "graphDigest", "projectionDigest", "durableCursor",
  "headEventHash", "headCheckpointId", "policyDigest", "evaluationRevision",
];
const TOPOLOGY_FIELDS = ["schemaVersion", "authority", "graphDigest", "nodes"];
const NODE_FIELDS = [
  "nodeId", "stage", "laneKind", "ownerBindingRef", "capabilityBindingRef", "dependsOn",
  "effectClass", "resourceScopes", "isolation", "mergeNodeId",
];
const EXECUTION_FIELDS = [
  "projectionDigest", "eventChainState", "currentness", "completedNodeIds", "activeClaimNodeIds",
  "unresolvedEffectNodeIds", "inDoubtNodeIds",
];
const DECISION_FIELDS = ["pendingDecisionNodeIds", "verifiedDecisionNodeIds", "unknownDecisionNodeIds", "snapshotDigest"];
const EVIDENCE_FIELDS = [
  "schemaVersion", "resultDigest", "bindingDigest", "evaluationStatus", "verdict", "blockedDecisionIds", "reasonCodes",
];
const CONTINUATION_FIELDS = ["schemaVersion", "resultDigest", "bindingDigest", "evaluationStatus", "action", "reasonCodes"];
const RESULT_FIELDS = [
  "schemaVersion", "kind", "binding", "bindingDigest", "topologyDigest", "executionSnapshot",
  "decisionSnapshot", "evidenceTransition", "continuation", "workItems", "safeIndependentCandidates",
  "disposition", "eventIntents", "authorization",
];
const WORK_ITEM_FIELDS = [
  "workItemId", "nodeId", "nodeDefinitionDigest", "stage", "laneKind", "ownerBindingRef",
  "capabilityBindingRef", "dependsOn", "effectClass", "resourceScopes", "isolation", "mergeNodeId",
  "status", "reasonCodes", "evidenceRefs", "projectionOnly", "authoritative",
];
const PROOF_FIELDS = [
  "nodeId", "workItemId", "transitiveDependencyNodeIds", "pendingDecisionNodeIds",
  "intersectingDecisionNodeIds", "allDirectDependenciesCompleted", "decisionIndependenceProven",
  "effectBoundaryShadowSafe", "proofDigest",
];
const DISPOSITION_FIELDS = ["action", "reasonCodes", "evidenceRefs"];
const EVENT_FIELDS = ["kind", "intentDigest", "disposition", "reasonCodesDigest", "persisted", "authoritative", "writeAllowed"];
const AUTHORIZATION_FIELDS = [
  "todoTruthWriteAllowed", "workItemMutationAllowed", "dependencyMutationAllowed",
  "decisionDependencyMutationAllowed", "schedulerSelectionAllowed", "schedulerDispatchAllowed", "retryAllowed",
  "claimAllowed", "leaseMutationAllowed", "fenceMutationAllowed", "eventPersistenceAllowed",
  "durableCursorAdvanceAllowed", "checkpointMutationAllowed", "completeNodeAllowed",
  "runTerminalStatusWriteAllowed", "executionAllowed", "authoritativeWriteAllowed", "legacyGateCutoverAllowed",
];

const TOPOLOGY_SCHEMA = "stage-dag-v0.1";
const TOPOLOGY_AUTHORITY = "config/contracts/core-loop-contract.json";
const SHA_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const OPAQUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+\-]{0,511}$/u;
const MAX_LIST = 512;
const WORK_STATUSES = [
  "completed", "dependency_ready_candidate", "safe_independent_candidate", "waiting_dependency",
  "waiting_decision", "waiting_active_claim", "waiting_unresolved_effect", "suppressed_by_run_disposition", "in_doubt",
];
const DECISION_ONLY_WAIT_REASONS = new Set(["awaiting_human_decision", "evidence_transition_blocked"]);

function fail(message) { throw new TypeError(`Todo dependency safe-progress shadow: ${message}`); }

function ownDataEntries(value, label) {
  let prototype;
  let keys;
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a plain Object.prototype record`);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch { fail(`${label} must be an inspectable plain own-data record`); }
  if (prototype !== Object.prototype) fail(`${label} must be a plain Object.prototype record`);
  return keys.map((key) => {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
    catch { fail(`${label} must be an inspectable plain own-data record`); }
    if (typeof key !== "string" || descriptor?.enumerable !== true || !("value" in descriptor)) {
      fail(`${label} must contain enumerable string own data properties only`);
    }
    return [key, descriptor.value];
  });
}

function exactRecord(value, fields, label) {
  const entries = ownDataEntries(value, label);
  const map = new Map(entries);
  if (entries.length !== fields.length || entries.some(([key]) => !fields.includes(key))) {
    fail(`${label} must contain exactly the supported fields`);
  }
  for (const field of fields) if (!map.has(field)) fail(`${label}.${field} is required`);
  return Object.fromEntries(fields.map((field) => [field, map.get(field)]));
}

function denseArray(value, label) {
  let prototype;
  let keys;
  let lengthDescriptor;
  try {
    if (!Array.isArray(value)) fail(`${label} must be a plain Array.prototype list`);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch { fail(`${label} must be an inspectable dense own-data list`); }
  if (prototype !== Array.prototype || !lengthDescriptor || !("value" in lengthDescriptor)) fail(`${label} must be a plain dense list`);
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_LIST) fail(`${label} length is outside the supported bound`);
  const items = new Map();
  for (const key of keys) {
    if (key === "length") continue;
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
    catch { fail(`${label} must be an inspectable dense own-data list`); }
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)
      || descriptor?.enumerable !== true || !("value" in descriptor)) {
      fail(`${label} must contain enumerable numeric own data properties only`);
    }
    items.set(key, descriptor.value);
  }
  if (items.size !== length) fail(`${label} must not contain sparse entries`);
  return Array.from({ length }, (_, index) => {
    if (!items.has(String(index))) fail(`${label} must not contain sparse entries`);
    return items.get(String(index));
  });
}

function hasSecretMarker(value) {
  const normalized = value.normalize("NFKC")
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/gu, "-")
    .replace(/[\u2024\uFE52\uFF0E]/gu, ".");
  const folded = normalized.toLowerCase()
    .replace(/[аα]/gu, "a").replace(/[еε]/gu, "e").replace(/[іι]/gu, "i")
    .replace(/[оο]/gu, "o").replace(/[рρ]/gu, "p").replace(/[сϲ]/gu, "c")
    .replace(/[ѕ]/gu, "s").replace(/[тτ]/gu, "t").replace(/[υу]/gu, "u")
    .replace(/[хχ]/gu, "x").replace(/[κ]/gu, "k").replace(/[ν]/gu, "v");
  const compact = folded.replace(/[^a-z0-9]/gu, "");
  const tokens = folded.split(/[^a-z0-9]+/gu).filter(Boolean);
  if (/(?:https?|ftp|file):|www\./u.test(folded)) return true;
  if (/(?:secret|password|passwd|credential|privatekey|apikey|accesstoken|refreshtoken|bearertoken)/u.test(compact)) return true;
  if (tokens.some((token) => ["raw", "path", "url", "token", "secret", "credential", "password", "privatekey", "bearer"].includes(token))) return true;
  if (/^sk(?:proj|ant|live|test)?[a-z0-9]{16,}$/u.test(compact)) return true;
  if (/^(?:akia|asia)[a-z0-9]{16}$/u.test(compact)) return true;
  if (/^gh[pousr][a-z0-9]{20,}$/u.test(compact)) return true;
  if (/^(?:xox[baprs]|ai?za)[a-z0-9]{20,}$/u.test(compact)) return true;
  if (/^(?:rk|pk|sk)(?:live|test)[a-z0-9]{16,}$/u.test(compact)) return true;
  if (/^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}$/u.test(normalized)) return true;
  if (normalized.includes(":") && normalized.split(":").filter(Boolean).some((part) => hasSecretMarker(part))) return true;
  return looksLikeHighEntropyCredential(normalized);
}

function looksLikeHighEntropyCredential(value) {
  if (value.includes(":") || value.length < 40 || value.length > 512 || !/^[A-Za-z0-9_+.-]+$/u.test(value)) return false;
  const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[_+.-]/u].filter((pattern) => pattern.test(value)).length;
  if (classes < 3) return false;
  const frequencies = new Map();
  for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= 4;
}

function opaqueRef(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !OPAQUE_PATTERN.test(value) || hasSecretMarker(value)) fail(`${label} must be a safe bounded opaque reference`);
  return value;
}

function topologyValue(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)
    || /^(?:[A-Za-z]:[\\/]|[\\/])/u.test(value) || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value) || hasSecretMarker(value)) {
    fail(`${label} must be a safe bounded topology value`);
  }
  return value;
}

function resourceScopeValue(value, label) {
  if (typeof value === "string" && value.startsWith("file:")) {
    const relativeToken=value.slice("file:".length);
    return `file:${topologyValue(relativeToken,label)}`;
  }
  return topologyValue(value,label);
}

function digestRef(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) fail(`${label} must be a strict sha256 reference`);
  return value;
}
function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative safe integer`);
  return value;
}
function enumValue(value, allowed, label) {
  if (typeof value !== "string" || !allowed.includes(value)) fail(`${label} is unsupported`);
  return value;
}
function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function sortedUnique(value, label, normalizer = opaqueRef) {
  const items = denseArray(value, label).map((item, index) => normalizer(item, `${label}[${index}]`));
  if (new Set(items).size !== items.length) fail(`${label} must not contain duplicates`);
  return items.sort(compare);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort(compare).map((key) => [key, canonical(value[key])]));
  return value;
}
function canonicalJson(value) { return JSON.stringify(canonical(value)); }

function sha256(value) {
  const bytes = new TextEncoder().encode(String(value));
  const bitLength = BigInt(bytes.length) * 8n;
  const paddedLength = ((bytes.length + 9 + 63) >> 6) << 6;
  const message = new Uint8Array(paddedLength); message.set(bytes); message[bytes.length] = 0x80;
  for (let i = 0; i < 8; i += 1) message[paddedLength - 1 - i] = Number((bitLength >> BigInt(i * 8)) & 0xffn);
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  let hash = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19,0x9b05688c].slice(0,8);
  const rotr = (word, bits) => (word >>> bits) | (word << (32 - bits));
  for (let offset = 0; offset < message.length; offset += 64) {
    const w = new Uint32Array(64);
    for (let i = 0; i < 16; i += 1) { const p = offset + i * 4; w[i] = ((message[p] << 24) | (message[p+1] << 16) | (message[p+2] << 8) | message[p+3]) >>> 0; }
    for (let i = 16; i < 64; i += 1) { const s0 = rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3); const s1=rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10); w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0; }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let i = 0; i < 64; i += 1) { const s1=rotr(e,6)^rotr(e,11)^rotr(e,25); const ch=(e&f)^(~e&g); const t1=(h+s1+ch+k[i]+w[i])>>>0; const s0=rotr(a,2)^rotr(a,13)^rotr(a,22); const maj=(a&b)^(a&c)^(b&c); const t2=(s0+maj)>>>0; h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0; }
    hash = hash.map((word, i) => (word + [a,b,c,d,e,f,g,h][i]) >>> 0);
  }
  return hash.map((word) => word.toString(16).padStart(8,"0")).join("");
}
function digest(value) { return `sha256:${sha256(canonicalJson(value))}`; }
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
}

function normalizeBinding(value) {
  const v = exactRecord(value, BINDING_FIELDS, "binding");
  return {
    runId: opaqueRef(v.runId,"binding.runId"), taskFingerprint:digestRef(v.taskFingerprint,"binding.taskFingerprint"),
    graphDigest:digestRef(v.graphDigest,"binding.graphDigest"), projectionDigest:digestRef(v.projectionDigest,"binding.projectionDigest"),
    durableCursor:integer(v.durableCursor,"binding.durableCursor"), headEventHash:digestRef(v.headEventHash,"binding.headEventHash",{nullable:true}),
    headCheckpointId:opaqueRef(v.headCheckpointId,"binding.headCheckpointId",{nullable:true}), policyDigest:digestRef(v.policyDigest,"binding.policyDigest"),
    evaluationRevision:integer(v.evaluationRevision,"binding.evaluationRevision"),
  };
}

function normalizeNode(value, index) {
  const v = exactRecord(value, NODE_FIELDS, `topology.nodes[${index}]`);
  return {
    nodeId:opaqueRef(v.nodeId,`topology.nodes[${index}].nodeId`), stage:topologyValue(v.stage,`topology.nodes[${index}].stage`),
    laneKind:topologyValue(v.laneKind,`topology.nodes[${index}].laneKind`), ownerBindingRef:topologyValue(v.ownerBindingRef,`topology.nodes[${index}].ownerBindingRef`),
    capabilityBindingRef:topologyValue(v.capabilityBindingRef,`topology.nodes[${index}].capabilityBindingRef`),
    dependsOn:sortedUnique(v.dependsOn,`topology.nodes[${index}].dependsOn`), effectClass:topologyValue(v.effectClass,`topology.nodes[${index}].effectClass`),
    resourceScopes:sortedUnique(v.resourceScopes,`topology.nodes[${index}].resourceScopes`,resourceScopeValue), isolation:topologyValue(v.isolation,`topology.nodes[${index}].isolation`),
    mergeNodeId:opaqueRef(v.mergeNodeId,`topology.nodes[${index}].mergeNodeId`,{nullable:true}),
  };
}

function normalizeTopology(value) {
  const v = exactRecord(value, TOPOLOGY_FIELDS, "topology");
  if (v.schemaVersion !== TOPOLOGY_SCHEMA || v.authority !== TOPOLOGY_AUTHORITY) fail("topology schema or authority is unsupported");
  const nodes = denseArray(v.nodes,"topology.nodes").map(normalizeNode).sort((a,b)=>compare(a.nodeId,b.nodeId));
  const ids = new Set(nodes.map((node)=>node.nodeId));
  if (ids.size !== nodes.length) fail("topology.nodes must not duplicate nodeId");
  for (const node of nodes) for (const dependency of node.dependsOn) if (!ids.has(dependency)) fail("topology contains a missing dependency");
  const byId = new Map(nodes.map((node)=>[node.nodeId,node]));
  const visiting = new Set(); const visited = new Set();
  function visit(id) { if (visiting.has(id)) fail("topology must be acyclic"); if (visited.has(id)) return; visiting.add(id); for (const dependency of byId.get(id).dependsOn) visit(dependency); visiting.delete(id); visited.add(id); }
  for (const node of nodes) visit(node.nodeId);
  return { schemaVersion:TOPOLOGY_SCHEMA, authority:TOPOLOGY_AUTHORITY, graphDigest:digestRef(v.graphDigest,"topology.graphDigest"), nodes };
}

function normalizeExecution(value, nodeIds) {
  const v=exactRecord(value,EXECUTION_FIELDS,"executionSnapshot");
  const normalized={
    projectionDigest:digestRef(v.projectionDigest,"executionSnapshot.projectionDigest"),
    eventChainState:enumValue(v.eventChainState,["verified","failed","unknown"],"executionSnapshot.eventChainState"),
    currentness:enumValue(v.currentness,["bound_same_bridge_settlement","active_claim_present","unresolved_effect_present","unproven"],"executionSnapshot.currentness"),
    completedNodeIds:sortedUnique(v.completedNodeIds,"executionSnapshot.completedNodeIds"), activeClaimNodeIds:sortedUnique(v.activeClaimNodeIds,"executionSnapshot.activeClaimNodeIds"),
    unresolvedEffectNodeIds:sortedUnique(v.unresolvedEffectNodeIds,"executionSnapshot.unresolvedEffectNodeIds"), inDoubtNodeIds:sortedUnique(v.inDoubtNodeIds,"executionSnapshot.inDoubtNodeIds"),
  };
  for (const [field, ids] of Object.entries(normalized)) if (field.endsWith("NodeIds")) for (const id of ids) if (!nodeIds.has(id)) fail(`${field} must refer to topology nodes`);
  return normalized;
}

function normalizeDecision(value, nodeById, completed) {
  const v=exactRecord(value,DECISION_FIELDS,"decisionSnapshot");
  const core={ pendingDecisionNodeIds:sortedUnique(v.pendingDecisionNodeIds,"decisionSnapshot.pendingDecisionNodeIds"), verifiedDecisionNodeIds:sortedUnique(v.verifiedDecisionNodeIds,"decisionSnapshot.verifiedDecisionNodeIds"), unknownDecisionNodeIds:sortedUnique(v.unknownDecisionNodeIds,"decisionSnapshot.unknownDecisionNodeIds") };
  const all=[...core.pendingDecisionNodeIds,...core.verifiedDecisionNodeIds,...core.unknownDecisionNodeIds];
  if (new Set(all).size!==all.length) fail("decisionSnapshot collections must be disjoint");
  for (const id of all) if (nodeById.get(id)?.effectClass!=="approval_gate") fail("decisionSnapshot may reference approval_gate nodes only");
  const approvalGateIds=[...nodeById.values()].filter((node)=>node.effectClass==="approval_gate").map((node)=>node.nodeId).sort(compare);
  if (approvalGateIds.length!==all.length || approvalGateIds.some((id)=>!all.includes(id))) {
    fail("decisionSnapshot must classify every approval_gate node exactly once");
  }
  for (const id of core.verifiedDecisionNodeIds) if (!completed.has(id)) fail("verified decision gates must be completed");
  for (const id of core.pendingDecisionNodeIds) if (completed.has(id)) fail("completed decision gates cannot remain pending");
  for (const id of approvalGateIds) {
    if (completed.has(id) && !core.verifiedDecisionNodeIds.includes(id)) fail("completed approval_gate nodes must be verified decisions");
  }
  const snapshotDigest=digestRef(v.snapshotDigest,"decisionSnapshot.snapshotDigest");
  if (snapshotDigest!==digest(core)) fail("decisionSnapshot.snapshotDigest does not match its canonical snapshot");
  return {...core,snapshotDigest};
}

function normalizeEvidence(value) {
  const v=exactRecord(value,EVIDENCE_FIELDS,"evidenceTransition");
  return {
    schemaVersion:enumValue(v.schemaVersion,["evidence-transition-shadow-v1"],"evidenceTransition.schemaVersion"), resultDigest:digestRef(v.resultDigest,"evidenceTransition.resultDigest"),
    bindingDigest:digestRef(v.bindingDigest,"evidenceTransition.bindingDigest"), evaluationStatus:enumValue(v.evaluationStatus,["evaluated","not_evaluated_missing_normalized_input","not_evaluated_invalid_normalized_input"],"evidenceTransition.evaluationStatus"),
    verdict:enumValue(v.verdict,["allowed","blocked","in_doubt"],"evidenceTransition.verdict"), blockedDecisionIds:sortedUnique(v.blockedDecisionIds,"evidenceTransition.blockedDecisionIds"),
    reasonCodes:sortedUnique(v.reasonCodes,"evidenceTransition.reasonCodes"),
  };
}

function normalizeContinuation(value) {
  const v=exactRecord(value,CONTINUATION_FIELDS,"continuation");
  return {
    schemaVersion:enumValue(v.schemaVersion,["continuation-policy-shadow-v1"],"continuation.schemaVersion"), resultDigest:digestRef(v.resultDigest,"continuation.resultDigest"),
    bindingDigest:digestRef(v.bindingDigest,"continuation.bindingDigest"), evaluationStatus:enumValue(v.evaluationStatus,["evaluated","not_evaluated_invalid_normalized_input","not_evaluated_missing_normalized_input"],"continuation.evaluationStatus"),
    action:enumValue(v.action,["continue","wait","stop","escalate"],"continuation.action"), reasonCodes:sortedUnique(v.reasonCodes,"continuation.reasonCodes"),
  };
}

function normalizeCommand(command) {
  const v=exactRecord(command,COMMAND_FIELDS,"command");
  const binding=normalizeBinding(v.binding); const topology=normalizeTopology(v.topology); const nodeById=new Map(topology.nodes.map((node)=>[node.nodeId,node]));
  const executionSnapshot=normalizeExecution(v.executionSnapshot,new Set(nodeById.keys()));
  const decisionSnapshot=normalizeDecision(v.decisionSnapshot,nodeById,new Set(executionSnapshot.completedNodeIds));
  return { binding, topology, executionSnapshot, decisionSnapshot, evidenceTransition:normalizeEvidence(v.evidenceTransition), continuation:normalizeContinuation(v.continuation) };
}

function intersection(left,right) { const set=new Set(right); return left.filter((item)=>set.has(item)); }
function closureFor(nodeId,nodeById,memo=new Map()) { if (memo.has(nodeId)) return memo.get(nodeId); const closure=new Set(); for (const dep of nodeById.get(nodeId).dependsOn) { closure.add(dep); for (const ancestor of closureFor(dep,nodeById,memo)) closure.add(ancestor); } const result=[...closure].sort(compare); memo.set(nodeId,result); return result; }
function effectShadowSafe(effectClass) { return effectClass.startsWith("read_only") || effectClass==="merge_only" || effectClass==="stage_control"; }
function isDecisionOnlyWait(continuation) { return continuation.action==="wait" && continuation.reasonCodes.length>0 && continuation.reasonCodes.every((reason)=>DECISION_ONLY_WAIT_REASONS.has(reason)); }

function derive(command) {
  const {binding,topology,executionSnapshot:execution,decisionSnapshot:decisions,evidenceTransition:evidence,continuation}=command;
  const bindingDigest=digest(binding); const topologyDigest=digest(topology); const nodeById=new Map(topology.nodes.map((node)=>[node.nodeId,node]));
  const completed=new Set(execution.completedNodeIds); const active=new Set(execution.activeClaimNodeIds); const effects=new Set(execution.unresolvedEffectNodeIds); const inDoubt=new Set(execution.inDoubtNodeIds);
  const contradictions=[...completed].some((id)=>active.has(id)||effects.has(id)||inDoubt.has(id))
    || [...inDoubt].some((id)=>active.has(id)||effects.has(id))
    || (execution.currentness==="bound_same_bridge_settlement" && (active.size>0||effects.size>0))
    || (execution.currentness==="active_claim_present" && active.size===0)
    || (execution.currentness==="unresolved_effect_present" && effects.size===0);
  const topologyMismatch=binding.graphDigest!==topology.graphDigest || binding.projectionDigest!==execution.projectionDigest;
  const continuationMismatch=continuation.bindingDigest!==bindingDigest;
  const gates=new Set(topology.nodes.filter((node)=>node.effectClass==="approval_gate").map((node)=>node.nodeId));
  const unboundDecisions=evidence.blockedDecisionIds.filter((id)=>!gates.has(id)||!decisions.pendingDecisionNodeIds.includes(id));
  const decisionOnly=isDecisionOnlyWait(continuation)
    && continuation.evaluationStatus==="evaluated"
    && evidence.blockedDecisionIds.length>0
    && unboundDecisions.length===0
    && decisions.unknownDecisionNodeIds.length===0;
  const safeIndependentCandidates=[];
  const workItems=[];
  const memo=new Map();
  for (const node of topology.nodes) {
    const closure=closureFor(node.nodeId,nodeById,memo); const pendingIntersection=intersection(closure,decisions.pendingDecisionNodeIds);
    const depsComplete=node.dependsOn.every((id)=>completed.has(id)); const safeEffect=effectShadowSafe(node.effectClass);
    const eligibleSafe=decisionOnly && execution.eventChainState==="verified" && execution.currentness==="bound_same_bridge_settlement"
      && depsComplete && pendingIntersection.length===0 && !decisions.pendingDecisionNodeIds.includes(node.nodeId)
      && !completed.has(node.nodeId) && !active.has(node.nodeId) && !effects.has(node.nodeId) && !inDoubt.has(node.nodeId) && safeEffect;
    if (eligibleSafe) {
      const core={ nodeId:node.nodeId,workItemId:node.nodeId,transitiveDependencyNodeIds:closure,pendingDecisionNodeIds:decisions.pendingDecisionNodeIds,intersectingDecisionNodeIds:[],allDirectDependenciesCompleted:true,decisionIndependenceProven:true,effectBoundaryShadowSafe:true };
      safeIndependentCandidates.push({...core,proofDigest:digest(core)});
    }
    let status; const reasons=[]; const refs=[];
    if (completed.has(node.nodeId)) status="completed";
    else if (inDoubt.has(node.nodeId)) status="in_doubt";
    else if (active.has(node.nodeId)) { status="waiting_active_claim"; reasons.push("active_claim_present"); refs.push(node.nodeId); }
    else if (effects.has(node.nodeId)) { status="waiting_unresolved_effect"; reasons.push("unresolved_effect_present"); refs.push(node.nodeId); }
    else if (decisions.pendingDecisionNodeIds.includes(node.nodeId)||pendingIntersection.length>0) { status="waiting_decision"; reasons.push("pending_decision_in_dependency_closure"); refs.push(...pendingIntersection,node.nodeId); }
    else if (!depsComplete) { status="waiting_dependency"; reasons.push("dependency_incomplete"); refs.push(...node.dependsOn.filter((id)=>!completed.has(id))); }
    else if (eligibleSafe) { status="safe_independent_candidate"; reasons.push("all_dependencies_completed","pending_decision_outside_dependency_closure","decision_only_wait_preserves_independent_candidate","shadow_safe_effect_boundary"); }
    else if (continuation.action==="continue" && continuation.evaluationStatus==="evaluated"
      && execution.eventChainState==="verified" && execution.currentness==="bound_same_bridge_settlement") {
      status="dependency_ready_candidate"; reasons.push("all_dependencies_completed","continuation_shadow_recommends_continue");
    }
    else { status="suppressed_by_run_disposition"; reasons.push(safeEffect?"continuation_wait_not_decision_only":"side_effect_boundary_not_shadow_safe"); }
    const definition={nodeId:node.nodeId,stage:node.stage,laneKind:node.laneKind,ownerBindingRef:node.ownerBindingRef,capabilityBindingRef:node.capabilityBindingRef,dependsOn:node.dependsOn,effectClass:node.effectClass,resourceScopes:node.resourceScopes,isolation:node.isolation,mergeNodeId:node.mergeNodeId};
    workItems.push({workItemId:node.nodeId,nodeId:node.nodeId,nodeDefinitionDigest:digest(definition),...definition,status,reasonCodes:reasons,evidenceRefs:[...new Set(refs)].sort(compare),projectionOnly:true,authoritative:false});
  }
  let action; let reasons;
  if (topologyMismatch) { action="escalate"; reasons=["topology_binding_mismatch"]; }
  else if (execution.eventChainState==="failed") { action="escalate"; reasons=["execution_projection_integrity_failed"]; }
  else if (contradictions) { action="escalate"; reasons=["contradictory_node_state"]; }
  else if (continuationMismatch || continuation.action==="escalate") { action="escalate"; reasons=["continuation_binding_mismatch"]; }
  else if (continuation.evaluationStatus!=="evaluated") { action="escalate"; reasons=["unsupported_shadow_input"]; }
  else if (continuation.action==="stop") { action="stop"; reasons=["continuation_policy_stopped",...(continuation.reasonCodes.includes("authoritative_run_terminal")?["authoritative_run_terminal"]:[])]; }
  else if (unboundDecisions.length>0 || decisions.unknownDecisionNodeIds.length>0) { action="in_doubt"; reasons=["decision_gate_unbound"]; }
  else if (safeIndependentCandidates.length>0) { action="safe_independent_candidates_available"; reasons=["all_dependencies_completed","pending_decision_outside_dependency_closure","decision_only_wait_preserves_independent_candidate","shadow_safe_effect_boundary"]; }
  else if (continuation.action==="continue" && workItems.some((item)=>item.status==="dependency_ready_candidate")) { action="candidates_available"; reasons=["all_dependencies_completed","continuation_shadow_recommends_continue"]; }
  else { action="wait"; reasons=[]; if (execution.currentness!=="bound_same_bridge_settlement"||execution.eventChainState!=="verified") reasons.push("execution_currentness_unproven"); if (active.size) reasons.push("active_claim_present"); if (effects.size) reasons.push("unresolved_effect_present"); if (!decisionOnly) reasons.push("continuation_wait_not_decision_only"); if (workItems.some((item)=>item.status==="waiting_dependency")) reasons.push("dependency_incomplete"); if (workItems.some((item)=>item.status==="waiting_decision")) reasons.push("pending_decision_in_dependency_closure"); if (!workItems.some((item)=>["dependency_ready_candidate","safe_independent_candidate"].includes(item.status))) reasons.push("no_dependency_ready_candidate"); reasons=TODO_DEPENDENCY_SAFE_PROGRESS_SHADOW_REASON_CODES.wait.filter((reason)=>reasons.includes(reason)); }
  if (action!=="safe_independent_candidates_available") {
    safeIndependentCandidates.length=0;
  }
  for (const item of workItems) {
    const retainedSafe=action==="safe_independent_candidates_available"&&item.status==="safe_independent_candidate";
    const retainedReady=action==="candidates_available"&&item.status==="dependency_ready_candidate";
    if (retainedSafe||retainedReady||!["safe_independent_candidate","dependency_ready_candidate"].includes(item.status)) continue;
    if (["escalate","in_doubt"].includes(action)) item.status="in_doubt";
    else item.status="suppressed_by_run_disposition";
    item.reasonCodes=[...reasons];
  }
  return {bindingDigest,topologyDigest,workItems,safeIndependentCandidates,disposition:{action,reasonCodes:reasons,evidenceRefs:[...new Set([...unboundDecisions,...safeIndependentCandidates.map((item)=>item.nodeId)])].sort(compare)}};
}

function authorization() { return Object.fromEntries(AUTHORIZATION_FIELDS.map((field)=>[field,false])); }

export function evaluateTodoDependencySafeProgressShadow(command) {
  const normalized=normalizeCommand(command); const derived=derive(normalized); const reasonCodesDigest=digest(derived.disposition.reasonCodes);
  const eventIntents=[{kind:"safe_progress_shadow_observed",intentDigest:digest({bindingDigest:derived.bindingDigest,disposition:derived.disposition.action,reasonCodesDigest}),disposition:derived.disposition.action,reasonCodesDigest,persisted:false,authoritative:false,writeAllowed:false}];
  return deepFreeze({schemaVersion:TODO_DEPENDENCY_SAFE_PROGRESS_SHADOW_SCHEMA_VERSION,kind:"todo_dependency_safe_progress_shadow_result",binding:normalized.binding,bindingDigest:derived.bindingDigest,topologyDigest:derived.topologyDigest,executionSnapshot:normalized.executionSnapshot,decisionSnapshot:normalized.decisionSnapshot,evidenceTransition:normalized.evidenceTransition,continuation:normalized.continuation,workItems:derived.workItems,safeIndependentCandidates:derived.safeIndependentCandidates,disposition:derived.disposition,eventIntents,authorization:authorization()});
}

function topologyFromWorkItems(binding,workItems) {
  const nodes=denseArray(workItems,"result.workItems").map((item,index)=>{ const v=exactRecord(item,WORK_ITEM_FIELDS,`result.workItems[${index}]`); enumValue(v.status,WORK_STATUSES,`result.workItems[${index}].status`); if (v.workItemId!==v.nodeId) fail("result workItemId must equal nodeId"); if (v.projectionOnly!==true||v.authoritative!==false) fail("result workItems must remain non-authoritative projections"); digestRef(v.nodeDefinitionDigest,`result.workItems[${index}].nodeDefinitionDigest`); sortedUnique(v.reasonCodes,`result.workItems[${index}].reasonCodes`); sortedUnique(v.evidenceRefs,`result.workItems[${index}].evidenceRefs`); return Object.fromEntries(NODE_FIELDS.map((field)=>[field,v[field]])); });
  return {schemaVersion:TOPOLOGY_SCHEMA,authority:TOPOLOGY_AUTHORITY,graphDigest:binding.graphDigest,nodes};
}

function validateResultOnly(snapshot) {
  digestRef(snapshot.bindingDigest,"result.bindingDigest"); digestRef(snapshot.topologyDigest,"result.topologyDigest");
  const proofs=denseArray(snapshot.safeIndependentCandidates,"result.safeIndependentCandidates");
  for (const [index,item] of proofs.entries()) { const v=exactRecord(item,PROOF_FIELDS,`result.safeIndependentCandidates[${index}]`); if (v.nodeId!==v.workItemId||v.allDirectDependenciesCompleted!==true||v.decisionIndependenceProven!==true||v.effectBoundaryShadowSafe!==true) fail("safe-independent proof fixed values are invalid"); if (denseArray(v.intersectingDecisionNodeIds,`result.safeIndependentCandidates[${index}].intersectingDecisionNodeIds`).length!==0) fail("safe-independent proof intersects a pending decision"); sortedUnique(v.transitiveDependencyNodeIds,`result.safeIndependentCandidates[${index}].transitiveDependencyNodeIds`); sortedUnique(v.pendingDecisionNodeIds,`result.safeIndependentCandidates[${index}].pendingDecisionNodeIds`); digestRef(v.proofDigest,`result.safeIndependentCandidates[${index}].proofDigest`); }
  const disposition=exactRecord(snapshot.disposition,DISPOSITION_FIELDS,"result.disposition"); enumValue(disposition.action,TODO_DEPENDENCY_SAFE_PROGRESS_SHADOW_DISPOSITIONS,"result.disposition.action"); sortedUnique(disposition.reasonCodes,"result.disposition.reasonCodes"); sortedUnique(disposition.evidenceRefs,"result.disposition.evidenceRefs");
  const events=denseArray(snapshot.eventIntents,"result.eventIntents"); if(events.length!==1) fail("result must contain one shadow event intent"); const event=exactRecord(events[0],EVENT_FIELDS,"result.eventIntents[0]"); if(event.kind!=="safe_progress_shadow_observed"||event.persisted!==false||event.authoritative!==false||event.writeAllowed!==false) fail("result event intent fixed values are invalid"); digestRef(event.intentDigest,"result.eventIntents[0].intentDigest"); digestRef(event.reasonCodesDigest,"result.eventIntents[0].reasonCodesDigest");
  enumValue(event.disposition,TODO_DEPENDENCY_SAFE_PROGRESS_SHADOW_DISPOSITIONS,"result.eventIntents[0].disposition");
  const auth=exactRecord(snapshot.authorization,AUTHORIZATION_FIELDS,"result.authorization"); for(const field of AUTHORIZATION_FIELDS) if(auth[field]!==false) fail(`result.authorization.${field} must be false`);
}

export function assertValidTodoDependencySafeProgressShadowResult(result) {
  const snapshot=exactRecord(result,RESULT_FIELDS,"result");
  if(snapshot.schemaVersion!==TODO_DEPENDENCY_SAFE_PROGRESS_SHADOW_SCHEMA_VERSION||snapshot.kind!=="todo_dependency_safe_progress_shadow_result") fail("result schemaVersion or kind is invalid");
  validateResultOnly(snapshot);
  const normalizedBinding=normalizeBinding(snapshot.binding);
  const topology=topologyFromWorkItems(normalizedBinding,snapshot.workItems);
  const expected=evaluateTodoDependencySafeProgressShadow({binding:normalizedBinding,topology,executionSnapshot:snapshot.executionSnapshot,decisionSnapshot:snapshot.decisionSnapshot,evidenceTransition:snapshot.evidenceTransition,continuation:snapshot.continuation});
  if(canonicalJson(snapshot)!==canonicalJson(expected)) fail("result does not match its canonical derived shadow evaluation");
  return result;
}
