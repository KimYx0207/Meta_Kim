/**
 * Read-only admission bridge from an Agent B1/B2 intake to Meta_Kim's existing
 * governed Run and current-host Live workspace. It never creates a Run,
 * dispatches a model, authorizes a side effect or treats a browser decision as
 * native-host authentication. The official run must already exist and carry
 * the exact immutable Work context produced by this bridge.
 */
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { readSpineState } from "../../../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import { liveRecordIsGovernedRun } from "../live/live-record-origin.mjs";
import { createLiveWorkspaceService } from "../live/live-workspace-service.mjs";
import { normalizeWorkContext } from "../../domain/governance/work-context.mjs";
import { AGENT_WORKFLOW_KEY_PATTERN, agentWorkflowProjectFingerprint } from "../../domain/runtime/agent-workflow-decision.mjs";
import { digestAgentHandoffEnvelope } from "../../domain/runtime/agent-handoff-envelope.mjs";
import { inspectTrustedPath } from "../../../scripts/safe-managed-file-operations.mjs";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PROFILE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_OFFICIAL_ARTIFACT_BYTES = 8 * 1024 * 1024;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function blocked(reason, extras = {}) {
  return { schemaVersion: "meta-kim-agent-execution-bridge-v1", status: "blocked", reason,
    runId: null, executionAuthorized: false, nativeInvocationVerified: false,
    publicReady: false, ...extras };
}

function validHandoff(handoff, projectFingerprint) {
  const basis = handoff?.basis;
  const envelope = handoff?.envelope;
  const plan = envelope?.plan;
  const design = envelope?.design;
  const constraints = envelope?.constraints;
  if (handoff?.schemaVersion !== "meta-kim-agent-handoff-v1" || handoff.status !== "prepared"
    || !envelope || typeof envelope !== "object" || Array.isArray(envelope)
    || handoff.executionScope?.kind !== "server_bound"
    || handoff.executionScope?.projectFingerprint !== projectFingerprint
    || handoff.requiresNativeHostConfirmation !== true
    || handoff.runId !== null
    || !SHA256.test(handoff.handoffDigest ?? "")
    || digestAgentHandoffEnvelope(envelope) !== handoff.handoffDigest
    || handoff.receipt?.handoffDigest !== handoff.handoffDigest
    || !SHA256.test(handoff.designDigest ?? "") || !Number.isSafeInteger(handoff.designVersion)
    || handoff.designVersion < 1 || handoff.executionAuthorized !== false
    || handoff.readyForExecution !== false
    || basis?.projectFingerprint !== projectFingerprint || !SHA256.test(basis?.planDigest ?? "")
    || !AGENT_WORKFLOW_KEY_PATTERN.test(basis?.idempotencyKey ?? "")
    || typeof basis?.requestId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(basis.requestId)
    || typeof basis?.decisionKey !== "string" || !AGENT_WORKFLOW_KEY_PATTERN.test(basis.decisionKey)
    || typeof basis?.selectedStrategy !== "string" || !basis.selectedStrategy.trim()
    || typeof basis?.selectionReason !== "string" || !basis.selectionReason.trim()
    || envelope?.schemaVersion !== "meta-kim-agent-handoff-envelope-v1"
    || envelope.project?.kind !== "server_bound" || envelope.project.projectFingerprint !== projectFingerprint
    || plan?.requestId !== basis.requestId || plan.planDigest !== basis.planDigest
    || plan.decisionKey !== basis.decisionKey || plan.selectedStrategy !== basis.selectedStrategy
    || plan.selectionReason !== basis.selectionReason
    || plan.source !== "native_read_only_plan_human_selection"
    || plan.researchEvidenceVerified !== false
    || design?.version !== handoff.designVersion || design.designDigest !== handoff.designDigest
    || design.source !== "human_submitted_prd" || !design.system || !Array.isArray(design.modules)
    || design.modules.length < 1 || design.system.approval?.state !== "approved"
    || !design.modules.every(module => module?.approval?.state === "approved")
    || constraints?.nativeHostConfirmationRequired !== true
    || constraints?.governedRunCreationRequired !== true
    || constraints?.sideEffectApprovalRequired !== true
    || constraints?.executionAuthorized !== false) return false;
  return true;
}

/** Advisory context accepted by the *existing* governed runner's Work contract.
 * Binding this context does not authenticate native intent or authorize work.
 * The existing runner must still prove Critical, Fetch, Thinking and permissions.
 */
export function buildAgentHandoffWorkContext(handoff, projectFingerprint) {
  if (!validHandoff(handoff, projectFingerprint)) return null;
  const { basis, designDigest, handoffDigest } = handoff;
  return normalizeWorkContext({
    schemaVersion: "kim-work-context-v1",
    organizationRef: "meta-kim:local-project",
    workRef: `agent-intake:${basis.requestId}`,
    contextRevision: `handoff:${handoffDigest}`,
    scopeRef: `project:${projectFingerprint}`,
    sourceRefs: [`plan:sha256:${basis.planDigest}`],
    acceptedArtifactRefs: [`design:sha256:${designDigest}`, `handoff:sha256:${handoffDigest}`],
    decisionRefs: [`agent-decision:${basis.decisionKey}`],
  });
}

function readOfficialArtifact(projectRoot, profile, runId) {
  const relative = `.meta-kim/state/${profile}/governed-executions/${runId}.json`;
  const checked = inspectTrustedPath(projectRoot, relative, { allowMissing: false });
  if (!checked?.target) return null;
  let fd;
  try {
    fd = openSync(checked.target, constants.O_RDONLY | O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_OFFICIAL_ARTIFACT_BYTES) return null;
    const bytes = readFileSync(fd);
    const artifact = JSON.parse(bytes.toString("utf8"));
    const after = fstatSync(fd);
    const current = statSync(checked.target);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || current.ino !== after.ino || current.dev !== after.dev) return null;
    return { artifact, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch { return null; }
  finally { if (fd != null) closeSync(fd); }
}

/**
 * A trusted local application may pass its real Live workspace service.
 * Browser input cannot replace the service, project root or profile.
 */
export function createAgentExecutionBridge({ projectRoot, profile = "default", agentWorkflowService, liveWorkspaceService = null } = {}) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)
    || !PROFILE_PATTERN.test(profile)
    || typeof agentWorkflowService?.inspectHandoff !== "function") {
    throw new TypeError("Agent execution bridge requires project-bound workflow with handoff inspection");
  }
  const realRoot = realpathSync(projectRoot);
  if (!statSync(realRoot).isDirectory()) throw new TypeError("Agent execution bridge requires directory");
  const projectFingerprint = agentWorkflowProjectFingerprint(realRoot, profile);
  const existingHost = liveWorkspaceService ?? createLiveWorkspaceService({ projectRoot: realRoot, profile });
  if (typeof existingHost.hostInspect !== "function") throw new TypeError("Agent execution bridge requires existing governed host inspection");

  async function prepare({ idempotencyKey } = {}) {
    if (!AGENT_WORKFLOW_KEY_PATTERN.test(idempotencyKey ?? "")) return blocked("agent_request_key_invalid");
    let handoff;
    try { handoff = await agentWorkflowService.inspectHandoff({ idempotencyKey }); }
    catch { return blocked("agent_handoff_unavailable"); }
    if (handoff?.status !== "prepared") return blocked(handoff?.status === "stale"
      ? "agent_handoff_stale" : "agent_b2_approval_pending");
    if (!validHandoff(handoff, projectFingerprint) || handoff.basis.idempotencyKey !== idempotencyKey) {
      return blocked("agent_handoff_binding_invalid");
    }
    const workContext = buildAgentHandoffWorkContext(handoff, projectFingerprint);
    return { schemaVersion: "meta-kim-agent-execution-bridge-v1", status: "awaiting_verified_native_run",
      runId: null, handoffDigest: handoff.handoffDigest, workContext,
      sourceEvidenceVerified: false, executionAuthorized: false, nativeInvocationVerified: false,
      publicReady: false, nextAction: "由现有治理宿主完成 Critical/Fetch/Thinking、创建正式 Run，并绑定此 Work context；不得直接执行副作用。" };
  }

  /** Read-only proof that an already existing official Run and verified host
   * have accepted the same immutable input. Never starts a Run or a CLI.
   */
  async function bindExistingRun({ idempotencyKey, runId } = {}) {
    const preflight = await prepare({ idempotencyKey });
    if (preflight.status !== "awaiting_verified_native_run") return preflight;
    if (!RUN_ID_PATTERN.test(runId ?? "")) return blocked("governed_run_id_required");
    const first = await readSpineState(realRoot, { profile });
    if (!first || first.runId !== runId || first.profile !== profile || first.active !== true
      || !liveRecordIsGovernedRun(first)) return blocked("governed_current_run_not_verified");
    const source = first.sourceConversation;
    // A manually typed browser session ID is never proof; the existing spine
    // must already have corroborated the current host transcript and run.
    if (first.conversationLinkState !== "verified" || source?.runId !== runId
      || source?.matchBasis !== "transcript_file_verified"
      || typeof source?.conversationId !== "string" || !source.conversationId) {
      return blocked("native_host_conversation_not_verified");
    }
    // The Agent launch profiles have not approved Gemini/ZCode/DSH native
    // mutation; Codex personal token is expressly not authorized here.
    if (source.runtime !== "claude") return blocked(source.runtime === "codex"
      ? "personal_codex_token_not_authorized" : "native_host_execute_not_reviewed");
    const official = readOfficialArtifact(realRoot, profile, runId);
    const artifact = official?.artifact;
    if (!artifact || artifact.runId !== runId || !liveRecordIsGovernedRun(artifact)
      || artifact.preparation || artifact.projectRoot != null &&
        (typeof artifact.projectRoot !== "string" || !path.isAbsolute(artifact.projectRoot)
          || path.resolve(artifact.projectRoot) !== realRoot)) {
      return blocked("governed_run_artifact_unavailable");
    }
    let actualContext;
    try { actualContext = normalizeWorkContext(artifact.workContext); }
    catch { return blocked("governed_run_work_context_invalid"); }
    if (actualContext == null || JSON.stringify(actualContext) !== JSON.stringify(preflight.workContext)) {
      return blocked("governed_run_work_context_mismatch");
    }
    let host;
    try { host = await existingHost.hostInspect({ runId, conversationId: source.conversationId }); }
    catch { return blocked("governed_host_binding_not_confirmed"); }
    const second = await readSpineState(realRoot, { profile });
    if (!second || second.runId !== first.runId || second.hostCheckpointRevision !== first.hostCheckpointRevision
      || second.conversationLinkState !== first.conversationLinkState
      || second.sourceConversation?.conversationId !== source.conversationId) {
      return blocked("governed_run_changed_during_binding");
    }
    if (readOfficialArtifact(realRoot, profile, runId)?.sha256 !== official.sha256) {
      return blocked("governed_run_artifact_changed_during_binding");
    }
    if (host?.runId !== runId || host.profile !== profile || host.stage !== "thinking") {
      return blocked("governed_host_not_in_design_stage");
    }
    if (host.designStatus !== "not_registered") return blocked("formal_design_digest_reconciliation_required");
    return { schemaVersion: "meta-kim-agent-execution-bridge-v1", status: "bound_for_native_design_publication",
      runId, handoffDigest: preflight.handoffDigest, sourceEvidenceVerified: false,
      nativeHostBinding: "existing_spine_transcript_file_verified",
      workContext: preflight.workContext, executionAuthorized: false, nativeInvocationVerified: false,
      publicReady: false, nextAction: "当前真实宿主须通过已有 publishDesign 工作单登记、复核正式 PRD，再分别完成模块审核和副作用授权。" };
  }

  return Object.freeze({ prepare, bindExistingRun });
}
