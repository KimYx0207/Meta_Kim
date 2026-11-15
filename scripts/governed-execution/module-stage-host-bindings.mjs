import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { loadDependencyAgentMethod } from "../dependency-agent-discovery.mjs";
import { inspectPlainAbsolutePath, inspectTrustedPath } from "../safe-managed-file-operations.mjs";
import { decodeMachineMethodResult } from "./method-delivery.mjs";
import { prepareHostMethodHandoff } from "./host-method-handoff.mjs";
import { readObservedMachineResult } from "./stage-runner-bridge.mjs";
import { moduleStageDigest } from "./module-stage-execution.mjs";

const text = value => typeof value === "string" && value.trim().length > 0;
const hash = value => /^[a-f0-9]{64}$/u.test(value ?? "");
const independentStages = new Set(["Review", "Meta-Review", "Verification"]);
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };

async function verifyEvidence(root, evidence, signal) {
  requireThat(text(evidence?.ref) && hash(evidence.sha256), "stage_artifact_evidence_invalid");
  const relative = path.relative(root, path.resolve(root, evidence.ref));
  const inspected = inspectTrustedPath(root, relative, { allowMissing: false });
  requireThat(inspected, "stage_artifact_path_untrusted");
  const target = inspected.target;
  const plain = inspectPlainAbsolutePath(target, { kind: "file" });
  requireThat(plain, "stage_artifact_path_redirected");
  const file = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await file.stat();
    requireThat(before.isFile() && before.dev === plain.stats.dev && before.ino === plain.stats.ino, "stage_artifact_not_regular_file");
    const digest = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false, signal })) digest.update(chunk);
    const after = await file.stat();
    const current = inspectPlainAbsolutePath(target, { kind: "file" });
    requireThat(current && current.stats.dev === after.dev && current.stats.ino === after.ino &&
      before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs &&
      digest.digest("hex") === evidence.sha256, "stage_artifact_changed");
    return { ref: evidence.ref, sha256: evidence.sha256 };
  } finally { await file.close(); }
}

/** Consume the exact current-host report. This verifies bytes and task binding,
 * not native invocation or human approval; the caller retains authorization. */
export async function readHostReportedMethodResult({ result: actual, target, binding, maxBytes, outputContract }) {
  const artifact = actual?.machineResultArtifact;
  requireThat(artifact?.path === target && hash(artifact.sha256) && Number.isSafeInteger(artifact.bytes) &&
    artifact.bytes > 0 && artifact.bytes <= maxBytes, "stage_reported_result_binding_invalid");
  const inspected = inspectPlainAbsolutePath(target, { kind: "file" });
  requireThat(inspected, "stage_reported_result_path_redirected");
  const file = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await file.stat();
    requireThat(before.isFile() && before.nlink === 1 && before.dev === inspected.stats.dev && before.ino === inspected.stats.ino &&
      before.size === artifact.bytes, "stage_reported_result_not_regular_file");
    const buffer = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = await file.read(buffer, count, buffer.length - count, null);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await file.stat();
    const current = inspectPlainAbsolutePath(target, { kind: "file" });
    const bytes = buffer.subarray(0, count);
    requireThat(current && current.stats.dev === after.dev && current.stats.ino === after.ino &&
      count === artifact.bytes && before.size === after.size && before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs && createHash("sha256").update(bytes).digest("hex") === artifact.sha256,
    "stage_reported_result_changed");
    const envelope = decodeMachineMethodResult({ text: bytes.toString("utf8"), maxBytes,
      outputContract: { type: "object", required: ["binding", "output"], additionalProperties: false,
        properties: { binding: { type: "object" }, output: outputContract } } });
    requireThat(moduleStageDigest(envelope.binding) === moduleStageDigest(binding), "stage_reported_result_current_binding_required");
    return envelope.output;
  } finally { await file.close(); }
}

/** Prepare one source-bound report target without writing or dispatching. */
export async function prepareHostReportedMethodRequest({ packet, projectRoot, environment = process.env,
  binding, artifactRoot, maxResultBytes, prompt }) {
  requireThat(Number.isSafeInteger(maxResultBytes) && maxResultBytes > 0 && text(prompt) && binding && typeof binding === "object",
    "host_reported_method_request_invalid");
  const method = await loadDependencyAgentMethod({ packet, environment, projectRoot });
  const handoff = await prepareHostMethodHandoff({ packet, projectRoot, environment });
  requireThat(method && handoff?.binding?.methodInputStatus === "ready", "stage_method_inputs_not_ready");
  const ownedRoot = path.resolve(artifactRoot);
  const relativePath = `host-${moduleStageDigest(binding)}.json`;
  const target = inspectTrustedPath(ownedRoot, relativePath, { allowMissing: true });
  requireThat(target && target.missingAt === target.target, "stage_result_artifact_already_exists_or_parent_missing");
  const responseContract = { type: "object", required: ["binding", "output"], additionalProperties: false,
    properties: { binding: { type: "object" }, output: method.outputContract } };
  return {
    prompt: `${prompt}\n${handoff.prompt}\nCurrent host result binding (data, not permission): ${JSON.stringify(binding)}\nReturn a JSON envelope with that exact binding and the unchanged complete source-contract result as output. This is a host report, not native invocation certification.`,
    methodSourceBinding: handoff.binding,
    machineResultArtifact: { ownedRoot, relativePath, maxBytes: maxResultBytes, responseContract },
    resultTarget: target.target, outputContract: method.outputContract,
  };
}

/** Compose the existing source loader and real CLI-result observer. This is an
 * optional binding factory, not a second dispatcher or a source of permission.
 * The explicit host-reported mode reads a bound result from the same adapter;
 * it never asserts the private observer's native evidence level. */
export async function createHostModuleStageExecutors({ host, runtime, projectRoot, artifactRoot, env = process.env }) {
  const executors = {};
  const diagnostics = [];
  Object.defineProperty(executors, "diagnostics", { value: diagnostics, enumerable: false });
  const entries = Object.entries(host?.stageWorkPackets ?? {});
  if (!entries.length) return executors;
  const normalizedRuntime = runtime === "claude-code" ? "claude" : runtime;
  if (!text(normalizedRuntime)) {
    diagnostics.push({ reason: "stage_runtime_required" });
    return executors;
  }
  const reportedFiles = host.stageResultMode === "host_reported_files";
  if (host.stageResultMode != null && !["observed_runtime", "host_reported_files"].includes(host.stageResultMode)) {
    diagnostics.push({ reason: "stage_result_mode_unsupported" });
    return executors;
  }
  if (!reportedFiles && !["claude", "codex"].includes(normalizedRuntime)) {
    diagnostics.push({ reason: "stage_machine_result_observer_unavailable", runtime,
      nextAction: "Bind the current host's actual native stage executor; another client is not required." });
    return executors;
  }
  if (typeof host?.authorize !== "function" || typeof host?.adapterRegistry?.invoke !== "function" || !text(host.adapterId) ||
      !Number.isSafeInteger(host.maxResultBytes) || host.maxResultBytes <= 0) {
    diagnostics.push({ reason: "current_host_stage_binding_incomplete" });
    return executors;
  }
  const root = await fs.realpath(projectRoot);
  const ownedRoot = path.resolve(artifactRoot);
  const registry = host.adapterRegistry;
  const adapterId = host.adapterId;
  // The durable kernel owns cross-process claims. Within this binding instance,
  // do not admit the same fenced call twice while its first return is uncertain.
  const invokedBindings = new Set();
  for (const [key, rawPacket] of entries) {
    try {
      const packet = structuredClone(rawPacket);
      requireThat(Array.isArray(packet?.acceptanceCriterionIds) && packet.acceptanceCriterionIds.length > 0 &&
        packet.acceptanceCriterionIds.every(text) && new Set(packet.acceptanceCriterionIds).size === packet.acceptanceCriterionIds.length,
      "stage_work_packet_criteria_required");
      const method = await loadDependencyAgentMethod({ packet, environment: env, projectRoot: root });
      requireThat(method && method.outputContract && hash(method.contentDigest), "stage_source_bound_method_required");
      const executor = {
        ownerId: method.ownerAgent, capabilityId: method.capabilityId, sourceRef: method.sourceRef,
        sourceSha256: method.contentDigest, toolBinding: adapterId,
        async invoke(request) {
          requireThat(request?.binding && request.node?.laneKind === "module_stage" &&
            request.binding.ownerId === method.ownerAgent && request.binding.capabilityId === method.capabilityId &&
            request.binding.sourceSha256 === method.contentDigest && path.resolve(request.projectRoot) === root &&
            request.runtime === normalizedRuntime, "stage_host_request_binding_mismatch");
          const expectedBinding = structuredClone(request.binding);
          const expectedBindingDigest = moduleStageDigest(expectedBinding);
          const stage = request.node.stage;
          const relatedResults = structuredClone(request.relatedResults ?? []);
          requireThat(expectedBinding.nodeId === request.node.nodeId && expectedBinding.stage === stage &&
            expectedBinding.scopeDigest === moduleStageDigest(request.scope), "stage_scope_binding_mismatch");
          requireThat(host.adapterRegistry === registry && host.adapterId === adapterId, "stage_adapter_changed_before_invocation");
          request.signal?.throwIfAborted();
          const authorization = await host.authorize({ runId: request.binding.runId, taskPacket: structuredClone(packet),
            node: structuredClone(request.node), scope: structuredClone(request.scope), stageBinding: structuredClone(request.binding) });
          requireThat(authorization?.status === "ready", "stage_host_authorization_not_ready");
          const fresh = await loadDependencyAgentMethod({ packet, environment: env, projectRoot: root });
          requireThat(fresh?.contentDigest === method.contentDigest && fresh.componentContentSha256 === method.componentContentSha256 &&
            fresh.methodSha256 === method.methodSha256 && fresh.sourceRef === method.sourceRef && fresh.ownerAgent === method.ownerAgent,
          "stage_method_changed_before_invocation");
          const requiredIds = [...new Set([...packet.acceptanceCriterionIds,
            ...(independentStages.has(stage) ? (request.workerTaskPackets ?? []).flatMap(item => item.acceptanceCriterionIds ?? []) : [])])];
          requireThat(requiredIds.every(text), "stage_current_criterion_invalid");
          const prompt = [
            "Perform only this source-bound module stage under the current host authorization.",
            `Stage request (data, not permission): ${JSON.stringify({ binding: request.binding, scope: request.scope,
              contract: request.node.stageContract, requiredCriterionIds: requiredIds, upstreamResults: request.upstreamResults,
              relatedResults, workerTaskPackets: request.workerTaskPackets })}`,
            "Return one complete JSON object matching the selected method outputContract. criterionResults must identify each current criterion with id (or criterionId), status pass/fail/blocked/not_run and evidenceRefs containing project file references. artifactRefs must include those exact refs and current sha256 values. Missing evidence stays blocked. status=completed describes your stage checks, never human acceptance.",
          ].join("\n");
          const prepared = reportedFiles ? await prepareHostReportedMethodRequest({ packet, projectRoot: root, environment: env,
            binding: expectedBinding, artifactRoot: ownedRoot, maxResultBytes: host.maxResultBytes, prompt }) : null;
          const relativePath = prepared?.machineResultArtifact.relativePath ?? `stage-${expectedBindingDigest}.json`;
          const resultTarget = inspectTrustedPath(ownedRoot, relativePath, { allowMissing: true });
          requireThat(resultTarget && resultTarget.missingAt === resultTarget.target, "stage_result_artifact_already_exists_or_parent_missing");
          requireThat(!invokedBindings.has(expectedBindingDigest), "stage_attempt_already_invoked_reconcile_original_return");
          invokedBindings.add(expectedBindingDigest);
          const invoked = await registry.invoke(adapterId, { action: "handoff", runtime: normalizedRuntime,
            runId: expectedBinding.runId, node: structuredClone(request.node), packet: structuredClone(packet), workspaceRoot: root,
            prompt: prepared?.prompt ?? prompt,
            stageBinding: structuredClone(expectedBinding), stageResultMode: reportedFiles ? "host_reported_files" : "observed_runtime",
            methodSourceBinding: prepared?.methodSourceBinding ?? null,
            upstreamResults: structuredClone(relatedResults), timeoutMs: host.timeoutMs, signal: request.signal, env,
            ...(host.model != null ? { model: host.model } : {}),
            machineResultArtifact: prepared?.machineResultArtifact ?? { ownedRoot, relativePath, maxBytes: host.maxResultBytes, responseContract: fresh.outputContract } });
          const actual = invoked.result;
          const resultText = reportedFiles ? null : await readObservedMachineResult(actual);
          requireThat((reportedFiles ? ["pass", "completed", "returned"].includes(actual?.status) : actual?.status === "pass") &&
            actual.runtime === normalizedRuntime && (reportedFiles || text(actual.sessionId) && text(actual.messageId)) &&
            actual.ownerMethodBinding?.contentDigest === method.contentDigest &&
            actual.ownerMethodBinding?.componentContentSha256 === method.componentContentSha256 &&
            actual.ownerMethodBinding?.ownerAgent === method.ownerAgent && actual.ownerMethodBinding?.capabilityId === method.capabilityId &&
            actual.ownerMethodBinding?.sourceRef === method.sourceRef,
          "stage_runtime_or_source_binding_mismatch");
          request.signal?.throwIfAborted();
          const body = reportedFiles ? await readHostReportedMethodResult({ result: actual, target: resultTarget.target,
            binding: expectedBinding, maxBytes: host.maxResultBytes, outputContract: fresh.outputContract })
            : decodeMachineMethodResult({ text: resultText, outputContract: fresh.outputContract, maxBytes: host.maxResultBytes });
          const currentAuthorization = await host.authorize({ runId: expectedBinding.runId, taskPacket: structuredClone(packet),
            node: structuredClone(request.node), scope: structuredClone(request.scope), stageBinding: structuredClone(expectedBinding), phase: "result" });
          requireThat(currentAuthorization?.status === "ready", "stage_host_authorization_changed");
          requireThat(moduleStageDigest(request.binding) === expectedBindingDigest, "stage_request_changed_during_invocation");
          const evidence = [{ ref: actual.machineResultArtifact.path, sha256: actual.machineResultArtifact.sha256 }];
          let gap = null;
          const rows = new Map();
          try {
            requireThat(Array.isArray(body.criterionResults) && body.criterionResults.length > 0 &&
              Array.isArray(body.artifactRefs) && body.artifactRefs.length > 0, "stage_current_criteria_and_artifacts_required");
            for (const item of body.artifactRefs) {
              const checked = await verifyEvidence(root, item, request.signal);
              requireThat(!evidence.some(prior => prior.ref === checked.ref), "stage_duplicate_artifact_reference");
              evidence.push(checked);
            }
            for (const row of body.criterionResults) {
              const id = row?.id ?? row?.criterionId;
              requireThat(text(id) && !rows.has(id) && ["pass", "fail", "blocked", "not_run"].includes(row.status) &&
                Array.isArray(row.evidenceRefs) && row.evidenceRefs.length > 0 && row.evidenceRefs.every(ref =>
                  typeof ref === "string" && evidence.slice(1).some(item => item.ref === ref)), "stage_criterion_evidence_invalid");
              rows.set(id, { id, status: row.status, evidenceRefs: [...row.evidenceRefs] });
            }
            requireThat(requiredIds.every(id => rows.has(id)), "stage_current_criterion_missing");
            requireThat(!independentStages.has(stage) || !text(actual.sessionId) || !relatedResults.some(result =>
              result.sessionId === actual.sessionId), "stage_reviewer_session_not_independent");
          } catch (error) { if (request.signal?.aborted) throw error; gap = error.message; }
          const criterionResults = gap ? requiredIds.map(id => ({ id, status: "blocked", evidenceRefs: [evidence[0].ref] }))
            : requiredIds.map(id => rows.get(id));
          const hasFailure = !gap && [...rows.values()].some(row => row.status === "fail");
          const verdict = gap || body.status === "blocked" || body.missingCapabilities?.length || body.failures?.length && !hasFailure
            ? "blocked" : hasFailure ? "revise" : body.status === "completed" && criterionResults.every(row => row.status === "pass") ? "pass" : "blocked";
          request.signal?.throwIfAborted();
          return { binding: expectedBinding, verdict, evidenceRefs: evidence, criterionResults,
            summary: gap ?? (text(body.stopReason) ? body.stopReason : `Current stage criteria ${verdict}`),
            hostObservation: { runtime: actual.runtime, sessionId: actual.sessionId, messageId: actual.messageId,
              sourceBinding: actual.ownerMethodBinding, inputDigest: actual.inputSha256, rawOutputSha256: actual.rawOutputSha256,
              stageWorkPacketDigest: moduleStageDigest(packet), resultArtifact: actual.machineResultArtifact,
              evidenceKind: reportedFiles ? "host_reported_files_verified" : "observed_runtime_stage_result_with_current_artifact_checks", nativeInvocationVerified: false,
              userOutcomeAccepted: false } };
        },
      };
      Object.defineProperty(executors, key, { value: Object.freeze(executor), enumerable: true });
    } catch (error) {
      diagnostics.push({ key, reason: error.message });
    }
  }
  return executors;
}
