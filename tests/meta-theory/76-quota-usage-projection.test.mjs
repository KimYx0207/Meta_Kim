import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildQuotaUsageProjection,
  buildTrustedQuotaUsageObservation,
} from "../../scripts/governed-execution/quota-usage-projection-adapter.mjs";
import { openDurableRunKernel } from "../../scripts/governed-execution/durable-run-kernel.mjs";
import { runStageRunnerBridge } from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import { buildStageDagPacket } from "../../scripts/governed-execution/stage-dag.mjs";
import {
  QUOTA_DISPOSITIONS,
  QUOTA_KEYS,
  QUOTA_METRIC_STATES,
  QUOTA_USAGE_PROJECTION_SCHEMA_VERSION,
  assertValidQuotaUsageProjectionResult,
  evaluateQuotaUsageProjection,
} from "../../src/domain/quota/quota-usage-projection.mjs";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}
const UNITS = { maxValidatedTransitions:"count", maxNoProgressLoops:"count", maxRetries:"count", maxWallClock:"milliseconds", maxCost:"micro_usd" };
const AUTHORIZATION_FIELDS = ["quotaEnforcementAllowed","quotaMutationAllowed","quotaConsumptionAllowed","automaticStopAllowed","automaticPauseAllowed","automaticRetryAllowed","schedulerDispatchAllowed","executionAllowed","claimAllowed","takeoverAllowed","eventPersistenceAllowed","cursorAdvanceAllowed","checkpointMutationAllowed","terminalStatusWriteAllowed","legacyGateCutoverAllowed","authoritativeWriteAllowed"];
const DEFAULT_POLICY = JSON.parse(readFileSync(new URL("../../config/governance/run-quota-policy.json", import.meta.url), "utf8"));

function policy(overrides = {}) {
  const limits = Object.fromEntries(QUOTA_KEYS.map((key) => [key, { ...DEFAULT_POLICY.limits[key], ...(overrides[key] ?? {}) }]));
  const core = { ...DEFAULT_POLICY, limits };
  delete core.policyDigest;
  return { ...core, policyDigest: digest(core) };
}
function metric(key, state, value = null, evidenceRefDigest = null) {
  return { state, value, unit: UNITS[key], scope: "root_run_lineage", evidenceRefDigest };
}
function observation({ retryState="observed", retries=2, wallState="observed", wallClock=50, runId="run:a07", rootRunId="run:a07", observedAt=1_050 }={}) {
  const metrics = {
    maxValidatedTransitions: metric("maxValidatedTransitions", "not_observed"),
    maxNoProgressLoops: metric("maxNoProgressLoops", "not_observed"),
    maxRetries: metric("maxRetries", retryState, retryState === "observed" ? retries : null, retryState === "observed" ? digest("retry-evidence") : null),
    maxWallClock: metric("maxWallClock", wallState, wallState === "observed" ? wallClock : null, wallState === "observed" ? digest("wall-evidence") : null),
    maxCost: metric("maxCost", "not_observed"),
  };
  const core = { source:"stage_runner_bridge_durable_root_lineage",runId,rootRunId,observedAt,metrics };
  return { ...core, observationDigest:digest(core) };
}
function command({ quotaPolicy=policy(), usage=observation(), bindingOverrides={} }={}) {
  const binding = {
    runId:usage.runId,rootRunId:usage.rootRunId,taskFingerprint:digest("task:a07"),graphDigest:digest("graph:a07"),projectionDigest:digest("projection:a07"),durableCursor:8,headEventHash:digest("event:a07"),headCheckpointId:"checkpoint:a07",quotaPolicyDigest:quotaPolicy.policyDigest,usageObservationDigest:usage.observationDigest,evaluationRevision:1,...bindingOverrides,
  };
  return { binding, quotaPolicy, trustedUsageObservation:usage };
}

test("76 — constants and default policy are closed-set, disabled and digest-bound", () => {
  assert.equal(QUOTA_USAGE_PROJECTION_SCHEMA_VERSION, "quota-usage-projection-v1");
  assert.deepEqual(QUOTA_KEYS, ["maxValidatedTransitions","maxNoProgressLoops","maxRetries","maxWallClock","maxCost"]);
  assert.deepEqual(QUOTA_METRIC_STATES, ["observed","not_observed","in_doubt"]);
  assert.deepEqual(QUOTA_DISPOSITIONS, ["in_doubt","quota_exhausted","not_observed","not_configured","within_quota"]);
  assert.equal(DEFAULT_POLICY.policyDigest, digest(Object.fromEntries(Object.entries(DEFAULT_POLICY).filter(([key]) => key !== "policyDigest"))));
  assert.ok(Object.values(DEFAULT_POLICY.limits).every((limit) => limit.enabled === false && limit.limit === null));
});

test("76 — disabled default projects not_configured and grants no authority", () => {
  const result = evaluateQuotaUsageProjection(command());
  assertValidQuotaUsageProjectionResult(result);
  assert.equal(result.disposition.state, "not_configured");
  assert.ok(result.dimensionResults.every((dimension) => dimension.state === "disabled"));
  assert.deepEqual(Object.keys(result.authorization), AUTHORIZATION_FIELDS);
  assert.ok(Object.values(result.authorization).every((value) => value === false));
  assert.equal(result.eventIntents[0].persisted, false);
  assert.equal(result.eventIntents[0].authoritative, false);
  assert.equal(result.eventIntents[0].writeAllowed, false);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.usage.metrics));
});

test("76 — enabled limits distinguish under, at and over without taking action", () => {
  for (const [retries, expectedState, expectedDisposition, comparison] of [[1,"within_limit","within_quota","<"],[2,"at_limit","within_quota","="],[3,"exceeded","quota_exhausted",">"]]) {
    const quotaPolicy = policy({ maxRetries:{enabled:true,limit:2} });
    const result = evaluateQuotaUsageProjection(command({quotaPolicy,usage:observation({retries})}));
    assert.equal(result.dimensionResults[2].state, expectedState);
    assert.equal(result.dimensionResults[2].comparison, comparison);
    assert.equal(result.disposition.state, expectedDisposition);
    assert.equal(result.authorization.automaticStopAllowed, false);
    assert.equal(result.authorization.automaticPauseAllowed, false);
    assert.equal(result.authorization.automaticRetryAllowed, false);
    assert.equal(result.authorization.schedulerDispatchAllowed, false);
  }
});

test("76 — disposition priority is in_doubt over exhausted over not_observed", () => {
  const quotaPolicy = policy({maxRetries:{enabled:true,limit:1},maxWallClock:{enabled:true,limit:10}});
  const inDoubt = evaluateQuotaUsageProjection(command({quotaPolicy,usage:observation({retries:5,wallState:"in_doubt"})}));
  assert.equal(inDoubt.dimensionResults[2].state,"exceeded");
  assert.equal(inDoubt.disposition.state,"in_doubt");
  const missing = evaluateQuotaUsageProjection(command({quotaPolicy,usage:observation({retryState:"not_observed",wallClock:5})}));
  assert.equal(missing.disposition.state,"not_observed");
});

test("76 — only retries and wall clock may be observed in the first release", () => {
  const result=evaluateQuotaUsageProjection(command());
  assert.equal(result.usage.metrics.maxRetries.state,"observed");
  assert.equal(result.usage.metrics.maxWallClock.state,"observed");
  for(const key of ["maxValidatedTransitions","maxNoProgressLoops","maxCost"])assert.deepEqual(result.usage.metrics[key],metric(key,"not_observed"));
  const forged=structuredClone(command());
  forged.trustedUsageObservation.metrics.maxCost=metric("maxCost","observed",1,digest("estimated-cost"));
  const core={...forged.trustedUsageObservation};delete core.observationDigest;forged.trustedUsageObservation.observationDigest=digest(core);forged.binding.usageObservationDigest=forged.trustedUsageObservation.observationDigest;
  assert.throws(()=>evaluateQuotaUsageProjection(forged),/cannot be observed/);
});

function event({eventId,runId="run:a07",eventSeq,eventType="NodeAttemptClaimed",attemptId,payload={attemptNo:1},eventHash=digest(eventId)}) {
  return {eventId,runId,eventSeq,eventType,nodeId:"node:a07",attemptId,payload,payloadSha256:digest(payload),previousEventHash:eventSeq===1?"0".repeat(64):digest(`previous:${eventSeq}`),eventHash,createdAt:"2026-08-12T00:00:00.000Z",writerId:"writer:a07"};
}
function snapshot({events=[],parentRunId=null,rootRunId="run:a07",cursor=events.length,eventChainOk=true,createdAt="2026-08-12T00:00:00.000Z"}={}) {
  const run={runId:"run:a07",rootRunId,parentRunId,forkCheckpointId:parentRunId?"checkpoint:parent":null,graphDigest:digest("stage-graph"),taskFingerprint:"task:a07",status:"active",createdAt};
  const projection={schemaVersion:"durable-governed-run-projection-v0.1",run,cursor,headCheckpointId:"checkpoint:a07",completedNodes:[],effects:[],edgeTraversals:[],events,eventChain:{ok:eventChainOk}};
  const resume={runId:"run:a07",rootRunId,parentRunId,cursor,headCheckpointId:"checkpoint:a07",completedNodes:[],completedNodeIds:[],blockingEffects:[],activeClaims:[],status:"active",resumable:true};
  return {durableRunProjection:projection,durableResume:resume};
}

test("76 — trusted observation counts only unique attempt claims above attempt one", () => {
  const events=[event({eventId:"event:1",eventSeq:1,attemptId:"attempt:1",payload:{attemptNo:1}}),event({eventId:"event:2",eventSeq:2,attemptId:"attempt:2",payload:{attemptNo:2}}),event({eventId:"event:3",eventSeq:3,eventType:"NodeAttemptCompleted",attemptId:"attempt:2",payload:{status:"completed"}}),event({eventId:"event:4",eventSeq:4,eventType:"NodeAttemptFailed",attemptId:"attempt:3",payload:{status:"failed"}})];
  const usage=buildTrustedQuotaUsageObservation({authoritativeExecutionSnapshot:snapshot({events}),observedAt:Date.parse("2026-08-12T00:00:00.100Z")});
  assert.equal(usage.metrics.maxRetries.state,"observed");
  assert.equal(usage.metrics.maxRetries.value,1);
  assert.equal(usage.metrics.maxWallClock.value,100);
});

test("76 — duplicate claims, forks, broken chains and reverse clocks fail closed", () => {
  const duplicate=[event({eventId:"event:1",eventSeq:1,attemptId:"attempt:same",payload:{attemptNo:2}}),event({eventId:"event:2",eventSeq:2,attemptId:"attempt:same",payload:{attemptNo:2}})];
  assert.equal(buildTrustedQuotaUsageObservation({authoritativeExecutionSnapshot:snapshot({events:duplicate}),observedAt:Date.parse("2026-08-12T00:00:00.100Z")}).metrics.maxRetries.state,"in_doubt");
  const forked=buildTrustedQuotaUsageObservation({authoritativeExecutionSnapshot:snapshot({parentRunId:"run:parent",rootRunId:"run:root"}),observedAt:Date.parse("2026-08-12T00:00:00.100Z")});
  assert.equal(forked.metrics.maxRetries.state,"in_doubt");
  assert.equal(forked.metrics.maxWallClock.state,"in_doubt");
  const broken=buildTrustedQuotaUsageObservation({authoritativeExecutionSnapshot:snapshot({eventChainOk:false}),observedAt:Date.parse("2026-08-12T00:00:00.100Z")});
  assert.equal(broken.metrics.maxRetries.state,"in_doubt");
  const reverse=buildTrustedQuotaUsageObservation({authoritativeExecutionSnapshot:snapshot(),observedAt:Date.parse("2026-08-11T23:59:59.999Z")});
  assert.equal(reverse.metrics.maxWallClock.state,"in_doubt");
});

test("76 — adapter rejects stale heads and caller usage, limit, timeout, cost or action injection", () => {
  const stageDagPacket=buildStageDagPacket({stageOrder:["Execution","Review"],stageLanes:{Execution:[],Review:[]},runtimeCapacity:1});
  const baseSnapshot=snapshot();
  baseSnapshot.durableRunProjection.run.graphDigest=stageDagPacket.graphDigest;
  const trustedUsageObservation=buildTrustedQuotaUsageObservation({authoritativeExecutionSnapshot:baseSnapshot,observedAt:Date.parse("2026-08-12T00:00:00.100Z")});
  const options={authoritativeStageDagPacket:stageDagPacket,authoritativeExecutionSnapshot:baseSnapshot,trustedQuotaPolicy:DEFAULT_POLICY,trustedUsageObservation};
  assert.equal(buildQuotaUsageProjection({},options).evaluationStatus,"evaluated");
  for(const injected of [{maxRetries:0},{timeoutMs:1},{maxCost:0},{automaticStop:true},{limits:{maxRetries:999}}])assert.equal(buildQuotaUsageProjection(injected,options).evaluationStatus,"not_evaluated_invalid_normalized_input");
  const lowUsage=structuredClone(options);lowUsage.trustedUsageObservation.metrics.maxWallClock.value=0;const core={...lowUsage.trustedUsageObservation};delete core.observationDigest;lowUsage.trustedUsageObservation.observationDigest=digest(core);assert.equal(buildQuotaUsageProjection({},lowUsage).evaluationStatus,"not_evaluated_invalid_normalized_input");
  const stale=structuredClone(options);stale.authoritativeExecutionSnapshot.durableResume.cursor+=1;assert.equal(buildQuotaUsageProjection({},stale).evaluationStatus,"not_evaluated_invalid_normalized_input");
  const crossRun=structuredClone(options);crossRun.authoritativeExecutionSnapshot.durableResume.runId="run:other";assert.equal(buildQuotaUsageProjection({},crossRun).evaluationStatus,"not_evaluated_invalid_normalized_input");
});

function lane(){return{laneId:"quota-worker",laneKind:"execution_worker",ownerBindingRef:"owner:quota-worker",capabilityBindingRef:"capability:quota-worker",dependsOn:[],effectClass:"read_only_worker",resourceScopes:["file:package.json"],isolation:"shared_read_only",status:"planned_not_invoked"};}
async function bridgeVariant(enabled,{withHealth=false}={}){const runId="m3-a07-bridge-parity";const stageDagPacket=buildStageDagPacket({stageOrder:["Execution","Review"],stageLanes:{Execution:[lane()],Review:[]},runtimeCapacity:1});const taskFingerprint=`task:${runId}`;const kernel=await openDurableRunKernel();let calls=0;try{const result=await runStageRunnerBridge({runId,runtime:"codex",stageDagPacket,workerTaskPackets:[{taskPacketId:"quota-worker",ownerAgent:"test-automator",description:"Observe quota usage parity",output:"quota usage projection observed",dependsOn:[],executionMode:"primary_execution",externalWriteBoundary:false}],workspaceRoot:process.cwd(),durable:{enabled:true,kernel,mode:"create",taskFingerprint,ownerId:`owner:${runId}`,leaseMs:10_000},...(enabled?{quotaUsageProjection:{}}:{}),...(withHealth?{runtimeHealthProjection:{}}:{}),evidenceKind:"test_double",invokeWorker:async({runtime})=>{calls+=1;return{status:"pass",runtime,exitCode:0,startedAt:"2026-08-12T00:00:00.000Z",endedAt:"2026-08-12T00:00:00.001Z",durationMs:1,sessionId:`session:${runId}`,messageId:`message:${runId}`,outputText:"meta-kim",outputSha256:"a".repeat(64),rawOutputSha256:"b".repeat(64),hostEventCount:1,toolEventCount:1,stderrTail:""};}});const projection=kernel.projectRun(runId);return{result,calls,legacy:{status:result.status,nodeRecords:result.nodeRecords.map(({nodeId,status,outputSha256})=>({nodeId,status,outputSha256})),cursor:projection.cursor,eventTypes:projection.events.map((item)=>item.eventType),completedNodeIds:projection.completedNodes.map((item)=>item.nodeId)}};}finally{kernel.close();}}

test("76 — bridge opt-in adds only a sibling and preserves durable legacy truth", async () => {
  const off=await bridgeVariant(false);const on=await bridgeVariant(true);
  assert.equal(Object.hasOwn(off.result,"quotaUsageProjection"),false);
  assert.equal(Object.hasOwn(on.result,"quotaUsageProjection"),true);
  assert.deepEqual(on.legacy,off.legacy);
  assert.equal(off.calls,1);assert.equal(on.calls,1);
  assert.equal(on.result.quotaUsageProjection.evaluationStatus,"evaluated");
  assert.equal(on.result.quotaUsageProjection.result.usage.metrics.maxRetries.value,0);
  assert.equal(JSON.stringify(on.legacy).includes("quota_usage"),false);
});

test("76 — unrelated health toggle cannot change A07 usage or durable truth", async () => {
  const originalNow=Date.now;Date.now=()=>Date.parse("2026-08-12T00:00:00.100Z");
  try{const without=await bridgeVariant(true);const withToggle=await bridgeVariant(true,{withHealth:true});assert.deepEqual(withToggle.legacy,without.legacy);assert.deepEqual(withToggle.result.quotaUsageProjection.result.usage,without.result.quotaUsageProjection.result.usage);assert.equal(withToggle.calls,1);}finally{Date.now=originalNow;}
});

test("76 — A07 sources exclude forbidden authority and unrelated projection inputs", () => {
  const files=["../../src/domain/quota/quota-usage-projection.mjs","../../scripts/governed-execution/quota-usage-projection-adapter.mjs"];
  const forbidden=["projectRun(","resumeRun(","appendEvent(","completeNode(","claimNode(","heartbeatNode(","selectMaximalSafeReadySet(","executeNativeReadySet(","timeoutMs","runtime"+"HealthProjection"];
  for(const file of files){const source=readFileSync(new URL(file,import.meta.url),"utf8");for(const token of forbidden)assert.equal(source.includes(token),false,`${file} contains ${token}`);}
});

test("76 — accessors, sparse arrays, prototypes, raw fields and action fields fail closed", () => {
  const accessor=command();Object.defineProperty(accessor.binding,"runId",{enumerable:true,get(){return"run:a07";}});assert.throws(()=>evaluateQuotaUsageProjection(accessor),/own data/);
  const exotic=command();exotic.quotaPolicy=Object.create(null);assert.throws(()=>evaluateQuotaUsageProjection(exotic),/plain record/);
  const raw=command();raw.trustedUsageObservation.stdout="secret";assert.throws(()=>evaluateQuotaUsageProjection(raw),/exactly/);
  const jwt=command();jwt.binding.runId="eyJhbGciOiJIUzI1NiJ9.eyJydW4iOiJhMDcifQ.signature";assert.throws(()=>evaluateQuotaUsageProjection(jwt),/safe identifier/);
  const token=command();token.quotaPolicy.policyId="sk-live-x";assert.throws(()=>evaluateQuotaUsageProjection(token),/safe identifier/);
  const highEntropy=command();highEntropy.binding.headCheckpointId="Aa0_bBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrRsStT";assert.throws(()=>evaluateQuotaUsageProjection(highEntropy),/safe identifier/);
  const result=structuredClone(evaluateQuotaUsageProjection(command()));result.authorization.executionAllowed=true;assert.throws(()=>assertValidQuotaUsageProjectionResult(result),/authorization/);
  const forged=structuredClone(evaluateQuotaUsageProjection(command({quotaPolicy:policy({maxRetries:{enabled:true,limit:1}}),usage:observation({retries:3})})));forged.dimensionResults[2].state="within_limit";forged.eventIntents[0].intentDigest=digest({bindingDigest:forged.bindingDigest,quotaPolicy:forged.quotaPolicy,usage:forged.usage,dimensionResults:forged.dimensionResults,disposition:forged.disposition});assert.throws(()=>assertValidQuotaUsageProjectionResult(forged),/dimension semantics/);
  const sparse=structuredClone(evaluateQuotaUsageProjection(command()));delete sparse.dimensionResults[1];assert.throws(()=>assertValidQuotaUsageProjectionResult(sparse),/dense/);
});
