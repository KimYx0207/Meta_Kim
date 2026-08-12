/**
 * Pure M3-A04 scheduler-authority reuse result builder.
 *
 * This module validates an already-produced selector input/output identity. It
 * does not calculate readiness, conflicts, capacity, or scheduling, and it
 * cannot dispatch, invoke callbacks, claim work, or mutate durable state.
 */

export const SCHEDULER_AUTHORITY_REUSE_SHADOW_SCHEMA_VERSION = "scheduler-authority-reuse-shadow-v1";
export const SCHEDULER_AUTHORITY_REUSE_SHADOW_PLAN_STATUSES = Object.freeze([
  "planned", "empty", "revalidation_required", "blocked", "in_doubt",
]);
export const SCHEDULER_AUTHORITY_REUSE_SHADOW_REASON_CODES = deepFreeze({
  planned: ["fresh_head_matches_advisory", "canonical_a03_candidates_consumed", "existing_selector_reused", "eligible_candidates_selected"],
  empty: ["a03_has_no_advisory_candidate", "eligible_candidates_not_dependency_ready", "no_conflict_safe_candidate_within_capacity"],
  revalidation_required: ["fresh_cursor_changed", "fresh_event_head_changed", "fresh_checkpoint_changed", "fresh_projection_digest_changed", "fresh_completed_set_changed", "fresh_claim_state_changed", "fresh_effect_state_changed", "fresh_in_doubt_state_changed", "advisory_snapshot_stale"],
  blocked: ["run_not_active", "event_chain_not_verified", "fresh_currentness_unproven", "active_claim_present", "unresolved_effect_present", "a03_disposition_blocks_scheduler_plan"],
  in_doubt: ["topology_binding_mismatch", "a03_binding_mismatch", "a03_result_invalid", "fresh_head_snapshot_invalid", "selector_input_invalid", "selector_output_identity_mismatch", "selector_returned_ineligible_node", "selector_algorithm_authority_unavailable"],
});

const COMMAND_FIELDS = ["binding", "freshHeadBinding", "advisoryBinding", "executionAssessment", "selectorInput", "selectorOutput"];
const BINDING_FIELDS = ["runId", "taskFingerprint", "graphDigest", "projectionDigest", "durableCursor", "headEventHash", "headCheckpointId", "policyDigest", "evaluationRevision"];
const FRESH_FIELDS = ["runId", "taskFingerprint", "graphDigest", "projectionDigest", "cursor", "headEventHash", "headCheckpointId", "snapshotDigest"];
const ADVISORY_FIELDS = ["schemaVersion", "resultDigest", "bindingDigest", "disposition", "candidateNodeIds"];
const EXECUTION_ASSESSMENT_FIELDS = ["runStatus", "eventChainState", "currentness", "completedNodeIds", "activeClaimNodeIds", "unresolvedEffectNodeIds", "inDoubtNodeIds", "advisoryCompletedNodeIds", "advisoryActiveClaimNodeIds", "advisoryUnresolvedEffectNodeIds", "advisoryInDoubtNodeIds", "advisoryDisposition"];
const INPUT_FIELDS = ["graphDigest", "completedNodeIds", "eligibleNodeIds", "stage", "capacity", "inputDigest"];
const OUTPUT_FIELDS = ["schemaVersion", "stage", "capacity", "candidateNodeIds", "readyNodeIds", "deferredNodeIds", "outputDigest"];
const RESULT_FIELDS = ["schemaVersion", "kind", "binding", "bindingDigest", "freshHeadBinding", "advisoryBinding", "executionAssessment", "selectorAuthority", "selectorInput", "selectorOutput", "plan", "eventIntents", "authorization"];
const AUTHORITY_FIELDS = ["module", "exportName", "algorithmCopied", "invocationCount", "topologyAuthorityConsumed"];
const PLAN_FIELDS = ["status", "plannedNodeIds", "deferredNodeIds", "reasonCodes", "planDigest", "dispatchRequiresFreshRevalidation"];
const EVENT_FIELDS = ["kind", "intentDigest", "planStatus", "reasonCodesDigest", "persisted", "authoritative", "writeAllowed"];
const AUTHORIZATION_FIELDS = ["schedulerPlanAuthoritative", "schedulerDispatchAllowed", "runtimeAdapterInvocationAllowed", "callbackExecutionAllowed", "claimAllowed", "leaseMutationAllowed", "fenceMutationAllowed", "retryAllowed", "eventPersistenceAllowed", "durableCursorAdvanceAllowed", "checkpointMutationAllowed", "completeNodeAllowed", "runTerminalStatusWriteAllowed", "todoMutationAllowed", "dependencyMutationAllowed", "executionAllowed", "authoritativeWriteAllowed", "legacyGateCutoverAllowed"];
const A03_DISPOSITIONS = ["candidates_available", "safe_independent_candidates_available", "wait", "stop", "escalate", "in_doubt"];
const SHA_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+\-]{0,511}$/u;
const MAX_LIST = 512;

function fail(message) { throw new TypeError(`Scheduler authority reuse shadow: ${message}`); }

function ownDataEntries(value, label) {
  let prototype; let keys;
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a plain Object.prototype record`);
    prototype = Object.getPrototypeOf(value); keys = Reflect.ownKeys(value);
  } catch { fail(`${label} must be an inspectable plain own-data record`); }
  if (prototype !== Object.prototype) fail(`${label} must be a plain Object.prototype record`);
  return keys.map((key) => {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
    catch { fail(`${label} must be an inspectable plain own-data record`); }
    if (typeof key !== "string" || descriptor?.enumerable !== true || !("value" in descriptor)) fail(`${label} must contain enumerable string own data properties only`);
    return [key, descriptor.value];
  });
}

function exactRecord(value, fields, label) {
  const entries = ownDataEntries(value, label); const map = new Map(entries);
  if (entries.length !== fields.length || entries.some(([key]) => !fields.includes(key))) fail(`${label} must contain exactly the supported fields`);
  for (const field of fields) if (!map.has(field)) fail(`${label}.${field} is required`);
  return Object.fromEntries(fields.map((field) => [field, map.get(field)]));
}

function denseArray(value, label) {
  let prototype; let keys; let lengthDescriptor;
  try {
    if (!Array.isArray(value)) fail(`${label} must be a plain Array.prototype list`);
    prototype = Object.getPrototypeOf(value); keys = Reflect.ownKeys(value); lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
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
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || descriptor?.enumerable !== true || !("value" in descriptor)) fail(`${label} must contain enumerable numeric own data properties only`);
    items.set(key, descriptor.value);
  }
  if (items.size !== length) fail(`${label} must not contain sparse entries`);
  return Array.from({length}, (_, index) => { if (!items.has(String(index))) fail(`${label} must not contain sparse entries`); return items.get(String(index)); });
}

function containsSensitive(value) {
  const normalized=value.normalize("NFKC").replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/gu,"-").replace(/[\u2024\uFE52\uFF0E]/gu,".");
  const folded=normalized.toLowerCase().replace(/[аα]/gu,"a").replace(/[еε]/gu,"e").replace(/[іι]/gu,"i").replace(/[оο]/gu,"o").replace(/[рρ]/gu,"p").replace(/[сϲ]/gu,"c").replace(/[ѕ]/gu,"s").replace(/[тτ]/gu,"t").replace(/[υу]/gu,"u").replace(/[хχ]/gu,"x").replace(/[κ]/gu,"k").replace(/[ν]/gu,"v");
  const compact=folded.replace(/[^a-z0-9]/gu,""); const tokens=folded.split(/[^a-z0-9]+/gu).filter(Boolean);
  if (/(?:https?|ftp|file):|www\.|[\\/]/u.test(folded)) return true;
  if (/(?:secret|password|passwd|credential|privatekey|apikey|accesstoken|refreshtoken|bearertoken)/u.test(compact)) return true;
  if (tokens.some((token)=>["raw","path","url","token","secret","credential","password","privatekey","bearer","stdout","stderr"].includes(token))) return true;
  if (/^sk(?:proj|ant|live|test)?[a-z0-9]{16,}$/u.test(compact)||/^(?:akia|asia)[a-z0-9]{16}$/u.test(compact)||/^gh[pousr][a-z0-9]{20,}$/u.test(compact)||/^(?:xox[baprs]|ai?za)[a-z0-9]{20,}$/u.test(compact)||/^(?:rk|pk|sk)(?:live|test)[a-z0-9]{16,}$/u.test(compact)) return true;
  if (/^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}$/u.test(normalized)) return true;
  if (normalized.includes(":") && normalized.split(":").filter(Boolean).some((part)=>containsSensitive(part))) return true;
  return highEntropy(normalized);
}
function highEntropy(value) {
  if (value.length<40||value.length>512||!/^[A-Za-z0-9_+.-]+$/u.test(value)) return false;
  const classes=[/[a-z]/u,/[A-Z]/u,/[0-9]/u,/[_+.-]/u].filter((pattern)=>pattern.test(value)).length; if(classes<3)return false;
  const frequencies=new Map(); for(const character of value) frequencies.set(character,(frequencies.get(character)??0)+1);
  let entropy=0; for(const count of frequencies.values()){const p=count/value.length;entropy-=p*Math.log2(p);} return entropy>=4;
}
function safeId(value,label,{nullable=false}={}) { if(nullable&&value===null)return null; if(typeof value!=="string"||!SAFE_ID_PATTERN.test(value)||containsSensitive(value))fail(`${label} must be a safe bounded identifier`); return value; }
function digestRef(value,label,{nullable=false}={}) { if(nullable&&value===null)return null; if(typeof value!=="string"||!SHA_PATTERN.test(value))fail(`${label} must be a strict sha256 reference`); return value; }
function integer(value,label,{positive=false}={}) { if(!Number.isSafeInteger(value)||value<(positive?1:0))fail(`${label} must be a ${positive?"positive":"non-negative"} safe integer`); return value; }
function enumValue(value,allowed,label){if(typeof value!=="string"||!allowed.includes(value))fail(`${label} is unsupported`);return value;}
function compare(left,right){return left<right?-1:left>right?1:0;}
function sortedIds(value,label){const ids=denseArray(value,label).map((item,index)=>safeId(item,`${label}[${index}]`));if(new Set(ids).size!==ids.length)fail(`${label} must not contain duplicates`);return ids.sort(compare);}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==="object")return Object.fromEntries(Object.keys(value).sort(compare).map((key)=>[key,canonical(value[key])]));return value;}
function canonicalJson(value){return JSON.stringify(canonical(value));}

function sha256(value) {
  const bytes=new TextEncoder().encode(String(value));const bitLength=BigInt(bytes.length)*8n;const paddedLength=((bytes.length+9+63)>>6)<<6;const message=new Uint8Array(paddedLength);message.set(bytes);message[bytes.length]=0x80;
  for(let i=0;i<8;i+=1)message[paddedLength-1-i]=Number((bitLength>>BigInt(i*8))&0xffn);
  const k=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  let hash=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];const rotr=(word,bits)=>(word>>>bits)|(word<<(32-bits));
  for(let offset=0;offset<message.length;offset+=64){const w=new Uint32Array(64);for(let i=0;i<16;i+=1){const p=offset+i*4;w[i]=((message[p]<<24)|(message[p+1]<<16)|(message[p+2]<<8)|message[p+3])>>>0;}for(let i=16;i<64;i+=1){const s0=rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3);const s1=rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10);w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0;}let[a,b,c,d,e,f,g,h]=hash;for(let i=0;i<64;i+=1){const s1=rotr(e,6)^rotr(e,11)^rotr(e,25);const ch=(e&f)^(~e&g);const t1=(h+s1+ch+k[i]+w[i])>>>0;const s0=rotr(a,2)^rotr(a,13)^rotr(a,22);const maj=(a&b)^(a&c)^(b&c);const t2=(s0+maj)>>>0;h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}hash=hash.map((word,i)=>(word+[a,b,c,d,e,f,g,h][i])>>>0);}return hash.map((word)=>word.toString(16).padStart(8,"0")).join("");
}
function digest(value){return `sha256:${sha256(canonicalJson(value))}`;}
function deepFreeze(value){if(value&&typeof value==="object"&&!Object.isFrozen(value)){for(const child of Object.values(value))deepFreeze(child);Object.freeze(value);}return value;}

function normalizeBinding(value){const v=exactRecord(value,BINDING_FIELDS,"binding");return{runId:safeId(v.runId,"binding.runId"),taskFingerprint:digestRef(v.taskFingerprint,"binding.taskFingerprint"),graphDigest:digestRef(v.graphDigest,"binding.graphDigest"),projectionDigest:digestRef(v.projectionDigest,"binding.projectionDigest"),durableCursor:integer(v.durableCursor,"binding.durableCursor"),headEventHash:digestRef(v.headEventHash,"binding.headEventHash",{nullable:true}),headCheckpointId:safeId(v.headCheckpointId,"binding.headCheckpointId",{nullable:true}),policyDigest:digestRef(v.policyDigest,"binding.policyDigest"),evaluationRevision:integer(v.evaluationRevision,"binding.evaluationRevision")};}
function normalizeFresh(value){const v=exactRecord(value,FRESH_FIELDS,"freshHeadBinding");const core={runId:safeId(v.runId,"freshHeadBinding.runId"),taskFingerprint:digestRef(v.taskFingerprint,"freshHeadBinding.taskFingerprint"),graphDigest:digestRef(v.graphDigest,"freshHeadBinding.graphDigest"),projectionDigest:digestRef(v.projectionDigest,"freshHeadBinding.projectionDigest"),cursor:integer(v.cursor,"freshHeadBinding.cursor"),headEventHash:digestRef(v.headEventHash,"freshHeadBinding.headEventHash",{nullable:true}),headCheckpointId:safeId(v.headCheckpointId,"freshHeadBinding.headCheckpointId",{nullable:true})};const snapshotDigest=digestRef(v.snapshotDigest,"freshHeadBinding.snapshotDigest");if(snapshotDigest!==digest(core))fail("freshHeadBinding.snapshotDigest does not match its canonical binding");return{...core,snapshotDigest};}
function normalizeAdvisory(value){const v=exactRecord(value,ADVISORY_FIELDS,"advisoryBinding");return{schemaVersion:enumValue(v.schemaVersion,["todo-dependency-safe-progress-shadow-v1"],"advisoryBinding.schemaVersion"),resultDigest:digestRef(v.resultDigest,"advisoryBinding.resultDigest"),bindingDigest:digestRef(v.bindingDigest,"advisoryBinding.bindingDigest"),disposition:enumValue(v.disposition,A03_DISPOSITIONS,"advisoryBinding.disposition"),candidateNodeIds:sortedIds(v.candidateNodeIds,"advisoryBinding.candidateNodeIds")};}
function normalizeExecutionAssessment(value){const v=exactRecord(value,EXECUTION_ASSESSMENT_FIELDS,"executionAssessment");const normalized={runStatus:enumValue(v.runStatus,["active","completed","failed","blocked"],"executionAssessment.runStatus"),eventChainState:enumValue(v.eventChainState,["verified","failed","unknown"],"executionAssessment.eventChainState"),currentness:enumValue(v.currentness,["fresh_bound_for_shadow_selection","unproven"],"executionAssessment.currentness"),completedNodeIds:sortedIds(v.completedNodeIds,"executionAssessment.completedNodeIds"),activeClaimNodeIds:sortedIds(v.activeClaimNodeIds,"executionAssessment.activeClaimNodeIds"),unresolvedEffectNodeIds:sortedIds(v.unresolvedEffectNodeIds,"executionAssessment.unresolvedEffectNodeIds"),inDoubtNodeIds:sortedIds(v.inDoubtNodeIds,"executionAssessment.inDoubtNodeIds"),advisoryCompletedNodeIds:sortedIds(v.advisoryCompletedNodeIds,"executionAssessment.advisoryCompletedNodeIds"),advisoryActiveClaimNodeIds:sortedIds(v.advisoryActiveClaimNodeIds,"executionAssessment.advisoryActiveClaimNodeIds"),advisoryUnresolvedEffectNodeIds:sortedIds(v.advisoryUnresolvedEffectNodeIds,"executionAssessment.advisoryUnresolvedEffectNodeIds"),advisoryInDoubtNodeIds:sortedIds(v.advisoryInDoubtNodeIds,"executionAssessment.advisoryInDoubtNodeIds"),advisoryDisposition:enumValue(v.advisoryDisposition,A03_DISPOSITIONS,"executionAssessment.advisoryDisposition")};const completed=new Set(normalized.completedNodeIds);if([...normalized.activeClaimNodeIds,...normalized.unresolvedEffectNodeIds,...normalized.inDoubtNodeIds].some((id)=>completed.has(id)))fail("executionAssessment contains contradictory node state");const advisoryCompleted=new Set(normalized.advisoryCompletedNodeIds);if([...normalized.advisoryActiveClaimNodeIds,...normalized.advisoryUnresolvedEffectNodeIds,...normalized.advisoryInDoubtNodeIds].some((id)=>advisoryCompleted.has(id)))fail("executionAssessment contains contradictory advisory node state");return normalized;}
function capacity(value,label){if(value===null)return null;return integer(value,label,{positive:true});}
function stage(value,label){if(value===null)return null;return safeId(value,label);}
function normalizeInput(value){if(value===null)return null;const v=exactRecord(value,INPUT_FIELDS,"selectorInput");const core={graphDigest:digestRef(v.graphDigest,"selectorInput.graphDigest"),completedNodeIds:sortedIds(v.completedNodeIds,"selectorInput.completedNodeIds"),eligibleNodeIds:sortedIds(v.eligibleNodeIds,"selectorInput.eligibleNodeIds"),stage:stage(v.stage,"selectorInput.stage"),capacity:capacity(v.capacity,"selectorInput.capacity")};const inputDigest=digestRef(v.inputDigest,"selectorInput.inputDigest");if(inputDigest!==digest(core))fail("selectorInput.inputDigest does not match its canonical input");return{...core,inputDigest};}
function normalizeOutput(value){if(value===null)return null;const v=exactRecord(value,OUTPUT_FIELDS,"selectorOutput");const core={schemaVersion:enumValue(v.schemaVersion,["stage-dag-ready-set-v0.1"],"selectorOutput.schemaVersion"),stage:stage(v.stage,"selectorOutput.stage"),capacity:capacity(v.capacity,"selectorOutput.capacity"),candidateNodeIds:sortedIds(v.candidateNodeIds,"selectorOutput.candidateNodeIds"),readyNodeIds:sortedIds(v.readyNodeIds,"selectorOutput.readyNodeIds"),deferredNodeIds:sortedIds(v.deferredNodeIds,"selectorOutput.deferredNodeIds")};const outputDigest=digestRef(v.outputDigest,"selectorOutput.outputDigest");if(outputDigest!==digest(core))fail("selectorOutput.outputDigest does not match its canonical output");return{...core,outputDigest};}

function sameArray(left,right){return left.length===right.length&&left.every((item,index)=>item===right[index]);}
function normalizedCommand(command){const v=exactRecord(command,COMMAND_FIELDS,"command");const selectorInput=normalizeInput(v.selectorInput);const selectorOutput=normalizeOutput(v.selectorOutput);if((selectorInput===null)!==(selectorOutput===null))fail("selectorInput and selectorOutput must be jointly present or absent");return{binding:normalizeBinding(v.binding),freshHeadBinding:normalizeFresh(v.freshHeadBinding),advisoryBinding:normalizeAdvisory(v.advisoryBinding),executionAssessment:normalizeExecutionAssessment(v.executionAssessment),selectorInput,selectorOutput};}
function authority(invoked){return{module:"scripts/governed-execution/stage-dag.mjs",exportName:"selectMaximalSafeReadySet",algorithmCopied:false,invocationCount:invoked?1:0,topologyAuthorityConsumed:invoked};}
function authorization(){return Object.fromEntries(AUTHORIZATION_FIELDS.map((field)=>[field,false]));}

function derivePlan(command,bindingDigest){
  const {binding,freshHeadBinding:fresh,advisoryBinding:advisory,executionAssessment:execution,selectorInput:input,selectorOutput:output}=command;
  const headMatches=binding.runId===fresh.runId&&binding.taskFingerprint===fresh.taskFingerprint&&binding.graphDigest===fresh.graphDigest&&binding.projectionDigest===fresh.projectionDigest&&binding.durableCursor===fresh.cursor&&binding.headEventHash===fresh.headEventHash&&binding.headCheckpointId===fresh.headCheckpointId;
  const advisoryMatches=advisory.bindingDigest===bindingDigest;
  const invoked=input!==null;
  const inputMatches=!invoked||(input.graphDigest===binding.graphDigest&&sameArray(input.eligibleNodeIds,advisory.candidateNodeIds));
  const selectorCompletedMatches=!invoked||sameArray(input.completedNodeIds,execution.completedNodeIds);
  const freshSetReasons=[];
  if(!sameArray(execution.completedNodeIds,execution.advisoryCompletedNodeIds))freshSetReasons.push("fresh_completed_set_changed");
  if(!sameArray(execution.activeClaimNodeIds,execution.advisoryActiveClaimNodeIds))freshSetReasons.push("fresh_claim_state_changed");
  if(!sameArray(execution.unresolvedEffectNodeIds,execution.advisoryUnresolvedEffectNodeIds))freshSetReasons.push("fresh_effect_state_changed");
  if(!sameArray(execution.inDoubtNodeIds,execution.advisoryInDoubtNodeIds))freshSetReasons.push("fresh_in_doubt_state_changed");
  const outputIdentity=!invoked||((input.stage===null||output.stage===input.stage)&&output.capacity===input.capacity);
  const eligible=new Set(input?.eligibleNodeIds??[]);const candidates=new Set(output?.candidateNodeIds??[]);const ready=new Set(output?.readyNodeIds??[]);const deferred=new Set(output?.deferredNodeIds??[]);
  const outputEligible=!invoked||[...candidates,...ready,...deferred].every((id)=>eligible.has(id));
  const partition=!invoked||(output.readyNodeIds.every((id)=>candidates.has(id))&&output.deferredNodeIds.every((id)=>candidates.has(id))&&intersection(output.readyNodeIds,output.deferredNodeIds).length===0&&new Set([...output.readyNodeIds,...output.deferredNodeIds]).size===output.candidateNodeIds.length&&output.candidateNodeIds.every((id)=>ready.has(id)||deferred.has(id)));
  let status;let reasonCodes;let plannedNodeIds=[];let deferredNodeIds=[];
  if(!headMatches){status="revalidation_required";reasonCodes=[];if(binding.durableCursor!==fresh.cursor)reasonCodes.push("fresh_cursor_changed");if(binding.headEventHash!==fresh.headEventHash)reasonCodes.push("fresh_event_head_changed");if(binding.headCheckpointId!==fresh.headCheckpointId)reasonCodes.push("fresh_checkpoint_changed");if(binding.projectionDigest!==fresh.projectionDigest)reasonCodes.push("fresh_projection_digest_changed");if(reasonCodes.length===0)reasonCodes.push("advisory_snapshot_stale");reasonCodes=SCHEDULER_AUTHORITY_REUSE_SHADOW_REASON_CODES.revalidation_required.filter((reason)=>reasonCodes.includes(reason));}
  else if(!advisoryMatches){status="in_doubt";reasonCodes=["a03_binding_mismatch"];}
  else if(execution.advisoryDisposition!==advisory.disposition){status="in_doubt";reasonCodes=["a03_result_invalid"];}
  else if(freshSetReasons.length>0){status="revalidation_required";reasonCodes=SCHEDULER_AUTHORITY_REUSE_SHADOW_REASON_CODES.revalidation_required.filter((reason)=>freshSetReasons.includes(reason));}
  else if(execution.runStatus!=="active"){status="blocked";reasonCodes=["run_not_active"];}
  else if(execution.eventChainState!=="verified"){status="blocked";reasonCodes=["event_chain_not_verified"];}
  else if(execution.currentness!=="fresh_bound_for_shadow_selection"){status="blocked";reasonCodes=["fresh_currentness_unproven"];}
  else if(execution.activeClaimNodeIds.length>0){status="blocked";reasonCodes=["active_claim_present"];}
  else if(execution.unresolvedEffectNodeIds.length>0){status="blocked";reasonCodes=["unresolved_effect_present"];}
  else if(execution.inDoubtNodeIds.length>0){status="in_doubt";reasonCodes=["fresh_head_snapshot_invalid"];}
  else if(!invoked&&!["candidates_available","safe_independent_candidates_available"].includes(advisory.disposition)){status="blocked";reasonCodes=["a03_disposition_blocks_scheduler_plan"];}
  else if(!invoked&&advisory.candidateNodeIds.length===0){status="empty";reasonCodes=["a03_has_no_advisory_candidate"];}
  else if(!invoked){status="in_doubt";reasonCodes=["selector_algorithm_authority_unavailable"];}
  else if(!selectorCompletedMatches){status="in_doubt";reasonCodes=["selector_input_invalid"];}
  else if(!inputMatches){status="in_doubt";reasonCodes=[input.graphDigest!==binding.graphDigest?"topology_binding_mismatch":"selector_input_invalid"];}
  else if(!outputIdentity||!partition){status="in_doubt";reasonCodes=["selector_output_identity_mismatch"];}
  else if(!outputEligible){status="in_doubt";reasonCodes=["selector_returned_ineligible_node"];}
  else if(output.readyNodeIds.length>0){status="planned";reasonCodes=[...SCHEDULER_AUTHORITY_REUSE_SHADOW_REASON_CODES.planned];plannedNodeIds=[...output.readyNodeIds];deferredNodeIds=[...output.deferredNodeIds];}
  else{status="empty";if(advisory.candidateNodeIds.length===0)reasonCodes=["a03_has_no_advisory_candidate"];else if(output.candidateNodeIds.length===0)reasonCodes=["eligible_candidates_not_dependency_ready"];else reasonCodes=["no_conflict_safe_candidate_within_capacity"];deferredNodeIds=[...output.deferredNodeIds];}
  const core={status,plannedNodeIds,deferredNodeIds,reasonCodes,dispatchRequiresFreshRevalidation:true};return{...core,planDigest:digest(core)};
}
function intersection(left,right){const set=new Set(right);return left.filter((item)=>set.has(item));}

export function buildSchedulerAuthorityReuseShadowResult(command){
  const normalized=normalizedCommand(command);const bindingDigest=digest(normalized.binding);const plan=derivePlan(normalized,bindingDigest);const reasonCodesDigest=digest(plan.reasonCodes);
  const eventIntents=[{kind:"scheduler_shadow_plan_observed",intentDigest:digest({bindingDigest,planDigest:plan.planDigest,planStatus:plan.status,reasonCodesDigest}),planStatus:plan.status,reasonCodesDigest,persisted:false,authoritative:false,writeAllowed:false}];
  return deepFreeze({schemaVersion:SCHEDULER_AUTHORITY_REUSE_SHADOW_SCHEMA_VERSION,kind:"scheduler_authority_reuse_shadow_result",binding:normalized.binding,bindingDigest,freshHeadBinding:normalized.freshHeadBinding,advisoryBinding:normalized.advisoryBinding,executionAssessment:normalized.executionAssessment,selectorAuthority:authority(normalized.selectorInput!==null),selectorInput:normalized.selectorInput,selectorOutput:normalized.selectorOutput,plan,eventIntents,authorization:authorization()});
}

function validateGeneratedFields(snapshot){
  digestRef(snapshot.bindingDigest,"result.bindingDigest");const selectorAuthority=exactRecord(snapshot.selectorAuthority,AUTHORITY_FIELDS,"result.selectorAuthority");const expectedAuthority=authority(snapshot.selectorInput!==null);for(const field of AUTHORITY_FIELDS)if(selectorAuthority[field]!==expectedAuthority[field])fail(`result.selectorAuthority.${field} is invalid`);
  const plan=exactRecord(snapshot.plan,PLAN_FIELDS,"result.plan");enumValue(plan.status,SCHEDULER_AUTHORITY_REUSE_SHADOW_PLAN_STATUSES,"result.plan.status");sortedIds(plan.plannedNodeIds,"result.plan.plannedNodeIds");sortedIds(plan.deferredNodeIds,"result.plan.deferredNodeIds");const allowedReasons=SCHEDULER_AUTHORITY_REUSE_SHADOW_REASON_CODES[plan.status]??[];for(const [index,reason]of denseArray(plan.reasonCodes,"result.plan.reasonCodes").entries())enumValue(reason,allowedReasons,`result.plan.reasonCodes[${index}]`);digestRef(plan.planDigest,"result.plan.planDigest");if(plan.dispatchRequiresFreshRevalidation!==true)fail("result plan must require fresh revalidation");
  const events=denseArray(snapshot.eventIntents,"result.eventIntents");if(events.length!==1)fail("result must contain one shadow event intent");const event=exactRecord(events[0],EVENT_FIELDS,"result.eventIntents[0]");if(event.kind!=="scheduler_shadow_plan_observed"||event.persisted!==false||event.authoritative!==false||event.writeAllowed!==false)fail("result event intent fixed values are invalid");enumValue(event.planStatus,SCHEDULER_AUTHORITY_REUSE_SHADOW_PLAN_STATUSES,"result.eventIntents[0].planStatus");digestRef(event.intentDigest,"result.eventIntents[0].intentDigest");digestRef(event.reasonCodesDigest,"result.eventIntents[0].reasonCodesDigest");
  const auth=exactRecord(snapshot.authorization,AUTHORIZATION_FIELDS,"result.authorization");for(const field of AUTHORIZATION_FIELDS)if(auth[field]!==false)fail(`result.authorization.${field} must be false`);
}

export function assertValidSchedulerAuthorityReuseShadowResult(result){
  const snapshot=exactRecord(result,RESULT_FIELDS,"result");if(snapshot.schemaVersion!==SCHEDULER_AUTHORITY_REUSE_SHADOW_SCHEMA_VERSION||snapshot.kind!=="scheduler_authority_reuse_shadow_result")fail("result schemaVersion or kind is invalid");validateGeneratedFields(snapshot);
  const expected=buildSchedulerAuthorityReuseShadowResult({binding:snapshot.binding,freshHeadBinding:snapshot.freshHeadBinding,advisoryBinding:snapshot.advisoryBinding,executionAssessment:snapshot.executionAssessment,selectorInput:snapshot.selectorInput,selectorOutput:snapshot.selectorOutput});
  if(canonicalJson(snapshot)!==canonicalJson(expected))fail("result does not match its canonical derived shadow evaluation");return result;
}
