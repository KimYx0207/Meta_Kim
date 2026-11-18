/**
 * Durable review receipts for the opt-in, read-only native agent intake.
 *
 * This is a persistence boundary, not a Meta_Kim run engine. It never calls
 * governed execution, mutating tools, or a native host itself. An accepted
 * plan and a human "adopt" decision do not authorize execution.
 */
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync,
  writeFileSync, rmdirSync,
} from "node:fs";
import path from "node:path";
import {
  AGENT_DECISION_SCHEMA, AGENT_REQUEST_SCHEMA, AGENT_WORKFLOW_SCHEMA,
  AGENT_WORKFLOW_KEY_PATTERN, agentWorkflowConflict,
  agentWorkflowFingerprint, agentWorkflowPlanDigest,
  agentWorkflowProjectFingerprint, validateAgentWorkflowDecision,
  validateAgentWorkflowIntake,
} from "../../domain/runtime/agent-workflow-decision.mjs";
import { createAgentDesignStore } from "./agent-design-store.mjs";
import { createAgentHandoffStore } from "./agent-handoff-store.mjs";
import { createAgentDesignDraftStore } from "./agent-design-draft-store.mjs";
import { normalizeDesign } from "../../domain/runtime/agent-design-contract.mjs";
import { discoverProjectArchitecturePrd } from "./project-architecture-prd-service.mjs";

const PROFILE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_NATIVE_PLAN_CHARS = 2_400;
const NATIVE_STATUSES = new Set(["accepted", "running", "completed", "failed", "blocked", "unknown"]);
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function ensurePrivateDirectory(realRoot, profile) {
  let current = realRoot;
  for (const segment of [".meta-kim", "state", profile, "agent-workflow"]) {
    current = path.join(current, segment);
    try { mkdirSync(current, { mode: 0o700 }); } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new TypeError("Agent workflow state path must contain only directories, not symlinks");
    }
  }
  return current;
}

function recordPath(stateRoot, key) {
  // The key is deliberately a validated filename, not user-selected path.
  if (!AGENT_WORKFLOW_KEY_PATTERN.test(key ?? "")) return null;
  return path.join(stateRoot, `${key}.json`);
}

function corruptRecord() {
  return agentWorkflowConflict("agent_record_unreadable");
}

function readRecord(stateRoot, key, scopeFingerprint) {
  const target = recordPath(stateRoot, key);
  if (!target || !existsSync(target)) return null;
  let fd;
  try {
    if (lstatSync(target).isSymbolicLink()) throw corruptRecord();
    fd = openSync(target, constants.O_RDONLY | O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_RECORD_BYTES || stat.nlink !== 1) {
      throw corruptRecord();
    }
    const record = JSON.parse(readFileSync(fd, "utf8"));
    if (!record || record.schemaVersion !== AGENT_WORKFLOW_SCHEMA
      || record.projectFingerprint !== scopeFingerprint
      || record.idempotencyKey !== key || typeof record.requestId !== "string"
      || typeof record.fingerprint !== "string") throw corruptRecord();
    return record;
  } catch {
    // Never relaunch when a receipt exists but cannot be trusted.
    throw corruptRecord();
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function persistNewRecord(stateRoot, record) {
  const target = recordPath(stateRoot, record.idempotencyKey);
  const data = JSON.stringify(record);
  if (Buffer.byteLength(data, "utf8") > MAX_RECORD_BYTES) throw new TypeError("Agent workflow receipt too large");
  let fd;
  try {
    // Atomic exclusivity across processes: no second native dispatch can
    // reserve the same idempotency key, even after a crash or restart.
    fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
    writeFileSync(fd, data, "utf8");
    fsyncSync(fd);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    // An incomplete receipt on disk is intentionally retained. A subsequent
    // retry must fail closed instead of launching the CLI a second time.
    throw error;
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function replaceRecord(stateRoot, record) {
  const target = recordPath(stateRoot, record.idempotencyKey);
  const data = JSON.stringify(record);
  if (Buffer.byteLength(data, "utf8") > MAX_RECORD_BYTES) throw new TypeError("Agent workflow receipt too large");
  const temporary = path.join(stateRoot, `${record.idempotencyKey}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
    writeFileSync(fd, data, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, target);
  } finally {
    if (fd != null) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function safeNativeReceipt(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null;
  const status = NATIVE_STATUSES.has(receipt.status) ? receipt.status : "unknown";
  const rawPreview = typeof receipt.resultPreview === "string" ? receipt.resultPreview : "";
  const resultPreview = status === "completed" && rawPreview.trim()
    && rawPreview.length <= MAX_NATIVE_PLAN_CHARS
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(rawPreview)
    ? rawPreview : null;
  const reason = typeof receipt.reason === "string" && /^[a-z][a-z0-9_-]{1,70}$/u.test(receipt.reason)
    ? receipt.reason : null;
  const selectedHostId = typeof receipt.selectedHostId === "string"
    && /^[a-z][a-z0-9_-]{1,31}$/u.test(receipt.selectedHostId) ? receipt.selectedHostId : null;
  const rawCapability = receipt.capabilityState;
  const capabilityState = rawCapability && typeof rawCapability === "object" && !Array.isArray(rawCapability)
    && JSON.stringify(rawCapability).length < 4_096 ? rawCapability : null;
  return { status, resultPreview, reason, selectedHostId, capabilityState };
}

function publicDecision(record) {
  if (record.decision) return { ...record.decision };
  return { state: record.planDigest ? "awaiting_human"
    : record.status === "completed" ? "unavailable_no_plan" : "not_ready" };
}

function publicReceipt(record, scope, { restarted = false } = {}) {
  if (!record) return { schemaVersion: AGENT_REQUEST_SCHEMA, status: "unknown", runId: null,
    executionAuthorized: false, executionScope: scope };
  const isInDoubt = restarted && ["reserved", "accepted", "running"].includes(record.status);
  const status = isInDoubt ? "unknown" : record.status === "reserved" ? "accepted" : record.status;
  return {
    schemaVersion: AGENT_REQUEST_SCHEMA,
    status,
    requestId: record.requestId,
    runId: null,
    executionAuthorized: false,
    executionScope: scope,
    requestedHostId: record.requestedHostId,
    ...(record.selectedHostId && { selectedHostId: record.selectedHostId }),
    ...(record.reason && { reason: record.reason }),
    ...(record.capabilityState && { capabilityState: record.capabilityState }),
    ...(record.resultPreview && { resultPreview: record.resultPreview }),
    ...(record.planDigest && { planDigest: record.planDigest }),
    decision: publicDecision(record),
    ...(isInDoubt && { recoveryState: "in_doubt", reason: "native_outcome_not_confirmed",
      nextAction: "原客户端结果尚未核实；请先检查原客户端，避免再次发起相同任务。" }),
  };
}

/**
 * @param {object} options
 * @param {string} options.projectRoot - Trusted absolute root, fixed at server startup.
 * @param {object} options.agentStartService - Existing opt-in, read-only native agent intake.
 * @param {string} [options.profile='default'] - Trusted local profile, not a browser input.
 */
export function createAgentWorkflowService({ projectRoot, agentStartService, profile = "default" } = {}) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)
    || !agentStartService || ["getHosts", "start", "inspect"].some((key) => typeof agentStartService[key] !== "function")
    || !PROFILE_PATTERN.test(profile)) {
    throw new TypeError("Agent workflow requires trusted project, profile, and native intake service");
  }
  const realRoot = realpathSync(projectRoot);
  if (!statSync(realRoot).isDirectory()) throw new TypeError("Agent workflow project must be a directory");
  const stateRoot = ensurePrivateDirectory(realRoot, profile);
  const designStore = createAgentDesignStore({ stateRoot });
  const handoffStore = createAgentHandoffStore({ stateRoot, designStore });
  const draftStore = createAgentDesignDraftStore({ stateRoot, projectFingerprint: agentWorkflowProjectFingerprint(realRoot, profile) });
  const projectFingerprint = agentWorkflowProjectFingerprint(realRoot, profile);
  const executionScope = Object.freeze({ kind: "server_bound", projectLabel: path.basename(realRoot), projectFingerprint });
  const localKeys = new Set();
  const inFlightStarts = new Map();
  const localDraftKeys = new Set();
  const inFlightDraftStarts = new Map();
  let closed = false;

  function getRecord(key) { return readRecord(stateRoot, key, projectFingerprint); }
  function draftOwnerKey(basis, draftKey) { return `${basis.idempotencyKey}\u0000${draftKey}`; }

  function safeDraftMeta(native) {
    const selectedHostId = typeof native?.selectedHostId === "string"
      && /^[a-z][a-z0-9_-]{1,31}$/u.test(native.selectedHostId) ? native.selectedHostId : null;
    const rawCapability = native?.capabilityState;
    let capabilityState = null;
    if (rawCapability && typeof rawCapability === "object" && !Array.isArray(rawCapability)) {
      let serialized = null;
      try { serialized = JSON.stringify(rawCapability); } catch { /* unsafe native metadata */ }
      if (typeof serialized === "string" && serialized.length < 4_096
        && !/(?:sk-ant-|ghp_|github_pat_|xox[baprs]-|Bearer\s|api[_-]?key\s*[:=]|access[_-]?token\s*[:=])/iu.test(serialized)) {
        capabilityState = JSON.parse(serialized);
      }
    }
    return { ...(selectedHostId && { selectedHostId }), ...(capabilityState && { capabilityState }) };
  }

  function adoptedDesignBasis(key) {
    const record = getRecord(key);
    const decision = record?.decision;
    if (!record || record.status !== "completed" || !record.planDigest
      || !decision || decision.state !== "adopted_for_design"
      || decision.planDigest !== record.planDigest
      || typeof decision.selectedStrategy !== "string" || !decision.selectedStrategy.trim()
      || typeof decision.selectionReason !== "string" || !decision.selectionReason.trim()) return null;
    return {
      projectFingerprint,
      idempotencyKey: key,
      requestId: record.requestId,
      planDigest: record.planDigest,
      decisionKey: decision.decisionKey,
      selectedStrategy: decision.selectedStrategy,
      selectionReason: decision.selectionReason,
    };
  }

  function inspectDesign({ idempotencyKey, version = null } = {}) {
    const basis = adoptedDesignBasis(idempotencyKey);
    if (!basis) return {
      schemaVersion: "meta-kim-agent-design-v1", status: "blocked",
      reason: "agent_plan_not_adopted", version: 0, currentVersion: 0,
      system: null, modules: [], history: [], basis: null,
      readyForExecution: false, executionAuthorized: false, runId: null,
    };
    return designStore.inspect({ idempotencyKey, basis, version });
  }

  function recordDesign(input) {
    const basis = adoptedDesignBasis(input?.idempotencyKey);
    if (!basis) throw agentWorkflowConflict("agent_plan_not_adopted");
    if (input.requestId !== basis.requestId || input.planDigest !== basis.planDigest
      || input.decisionKey !== basis.decisionKey) {
      throw agentWorkflowConflict("agent_design_decision_basis_mismatch");
    }
    if (input.action === "submit" && input.sourceDraftDigest != null) {
      const completedSource = draftStore.all(basis.idempotencyKey).find((row) => row.status === "completed"
        && row.draftDigest === input.sourceDraftDigest);
      const verifiedDesign = completedSource && normalizeDesign(completedSource.design);
      if (!verifiedDesign || draftRecordDigest(basis, verifiedDesign) !== input.sourceDraftDigest) {
        throw agentWorkflowConflict("agent_design_source_draft_mismatch");
      }
    }
    return designStore.commit({ input, basis });
  }

  function draftBindingDigest(basis, { nativeHostId, goal, planPreview }) {
    return createHash("sha256").update("meta-kim-native-draft-binding-v1\u0000")
      .update(JSON.stringify({ basis, nativeHostId, goal, planPreview }))
      .digest("hex");
  }

  function draftRecordDigest(basis, design) {
    return createHash("sha256").update("meta-kim-native-design-draft-v1\u0000")
      .update(JSON.stringify({ basis, design })).digest("hex");
  }

  function privateNativeDraftKey(basis, draftKey) {
    return createHash("sha256").update("meta-kim-native-design-invocation-v1\u0000")
      .update(basis.projectFingerprint).update("\u0000").update(basis.requestId)
      .update("\u0000").update(draftKey).digest("hex");
  }

  function publicDraft(basis, record, restarted = false) {
    const inDoubt = restarted && ["reserved", "accepted", "running"].includes(record?.status);
    return {
      schemaVersion: "meta-kim-agent-design-draft-v1",
      status: !record ? "not_started" : inDoubt ? "unknown" : record.status === "reserved" ? "accepted" : record.status,
      basis,
      ...(record && { draftKey: record.draftKey }),
      ...(record?.selectedHostId && { selectedHostId: record.selectedHostId }),
      ...(record?.capabilityState && { capabilityState: record.capabilityState }),
      ...(record?.draftDigest && { draftDigest: record.draftDigest }),
      ...(record?.design && { design: record.design }),
      draftSource: "native_readonly_unverified",
      nativeEvidenceVerified: false,
      ...(record?.reason && { reason: record.reason }),
      ...(inDoubt && { reason: "native_draft_outcome_not_confirmed", recoveryState: "in_doubt" }),
      executionAuthorized: false,
      runId: null,
    };
  }

  async function refreshDraft(basis, record) {
    if (!record || !localDraftKeys.has(draftOwnerKey(basis, record.draftKey)) || closed
      || !["reserved", "accepted", "running"].includes(record.status)) return record;
    const native = typeof agentStartService.inspectDesignDraft === "function"
      ? await agentStartService.inspectDesignDraft({ idempotencyKey: record.nativeKey }) : null;
    if (!native || native.status === "unknown") return record;
    const completed = native.status === "completed" && normalizeDesign(native.design);
    const status = native.status === "completed" && !completed ? "failed"
      : ["completed", "running", "accepted", "blocked", "failed"].includes(native.status)
        ? native.status : "failed";
    const next = {
      ...record, status,
      reason: status === "failed" && native.status === "completed" ? "native_design_schema_invalid"
        : typeof native.reason === "string" && /^[a-z][a-z0-9_-]{1,70}$/u.test(native.reason) ? native.reason : null,
      ...safeDraftMeta(native),
      ...(completed && { design: completed, draftDigest: draftRecordDigest(basis, completed) }),
    };
    if (JSON.stringify(next) === JSON.stringify(record)) return record;
    next.updatedAt = new Date().toISOString();
    draftStore.replace(next);
    return next;
  }

  async function inspectDesignDraft({ idempotencyKey } = {}) {
    const basis = adoptedDesignBasis(idempotencyKey);
    if (!basis) return {
      schemaVersion: "meta-kim-agent-design-draft-v1", status: "blocked",
      reason: "agent_plan_not_adopted", basis: null,
      draftSource: "native_readonly_unverified", nativeEvidenceVerified: false,
      executionAuthorized: false, runId: null,
    };
    const rows = draftStore.all(idempotencyKey);
    const last = rows.at(-1) ?? null;
    const latest = await refreshDraft(basis, last);
    return publicDraft(basis, latest,
      Boolean(latest && !localDraftKeys.has(draftOwnerKey(basis, latest.draftKey))));
  }

  async function startDesignDraft(input = {}) {
    const basis = adoptedDesignBasis(input?.idempotencyKey);
    if (!basis) return { ...publicDraft(null, null), status: "blocked",
      reason: "agent_plan_not_adopted" };
    if (input.requestId !== basis.requestId || input.planDigest !== basis.planDigest
      || input.decisionKey !== basis.decisionKey
      || !AGENT_WORKFLOW_KEY_PATTERN.test(input.draftKey ?? "") || input.draftKey === input.idempotencyKey) {
      return { ...publicDraft(basis, null), status: "blocked", reason: "agent_draft_basis_invalid" };
    }
    const plan = getRecord(basis.idempotencyKey);
    const goal = typeof plan.originalGoal === "string" ? plan.originalGoal
      : typeof input.goal === "string" ? input.goal.trim() : null;
    if (!goal || !validateAgentWorkflowIntake({ goal, hostId: plan.requestedHostId,
      idempotencyKey: basis.idempotencyKey })
      || agentWorkflowFingerprint(goal, plan.requestedHostId) !== plan.fingerprint) {
      return { ...publicDraft(basis, null), status: "blocked",
        reason: "agent_original_goal_unavailable_or_mismatch" };
    }
    if (plan.requestedHostId === "auto" && !plan.selectedHostId) {
      return { ...publicDraft(basis, null), status: "blocked",
        reason: "agent_selected_native_host_unavailable" };
    }
    const nativeHostId = plan.selectedHostId || plan.requestedHostId;
    const nativeKey = privateNativeDraftKey(basis, input.draftKey);
    const bindingDigest = draftBindingDigest(basis, { nativeHostId, goal, planPreview: plan.resultPreview });
    const record = {
      schemaVersion: "meta-kim-native-design-draft-record-v1",
      projectFingerprint,
      idempotencyKey: basis.idempotencyKey,
      draftKey: input.draftKey,
      nativeKey,
      bindingDigest,
      status: "reserved",
      reason: null,
      selectedHostId: null,
      capabilityState: null,
      design: null,
      draftDigest: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const ownerKey = draftOwnerKey(basis, input.draftKey);
    if (inFlightDraftStarts.has(ownerKey)) return inFlightDraftStarts.get(ownerKey);
    let reservation;
    try { reservation = draftStore.reserve({ idempotencyKey: basis.idempotencyKey,
      draftKey: input.draftKey, record }); }
    catch (error) {
      if (error.code === "AGENT_REQUEST_CONFLICT") return { ...publicDraft(basis, null),
        status: "blocked", reason: error.reason };
      throw error;
    }
    if (!reservation.newRecord) {
      const saved = reservation.record;
      const latest = await refreshDraft(basis, saved);
      return publicDraft(basis, latest, !localDraftKeys.has(draftOwnerKey(basis, saved.draftKey)));
    }
    if (typeof agentStartService.startDesignDraft !== "function"
      || typeof agentStartService.inspectDesignDraft !== "function") {
      const failed = { ...record, status: "blocked", reason: "native_design_adapter_unavailable",
        updatedAt: new Date().toISOString() };
      draftStore.replace(failed);
      return publicDraft(basis, failed);
    }
    localDraftKeys.add(ownerKey);
    const promise = (async () => {
      let accepted;
      try {
        accepted = await agentStartService.startDesignDraft({
          goal, hostId: nativeHostId, idempotencyKey: nativeKey,
          selectedStrategy: basis.selectedStrategy,
          selectionReason: basis.selectionReason,
          planPreview: plan.resultPreview,
          planDigest: basis.planDigest,
        });
      } catch { accepted = { status: "unavailable", reason: "native_design_handoff_failed" }; }
      const next = {
        ...record,
        status: accepted?.status === "accepted" ? "accepted" : "blocked",
        reason: accepted?.status === "accepted" ? null
          : typeof accepted?.reason === "string" && /^[a-z][a-z0-9_-]{1,70}$/u.test(accepted.reason)
            ? accepted.reason : "native_design_handoff_failed",
        ...safeDraftMeta(accepted),
        updatedAt: new Date().toISOString(),
      };
      draftStore.replace(next);
      return publicDraft(basis, next);
    })();
    inFlightDraftStarts.set(ownerKey, promise);
    try { return await promise; }
    finally { inFlightDraftStarts.delete(ownerKey); }
  }

  function inspectHandoff({ idempotencyKey } = {}) {
    const basis = adoptedDesignBasis(idempotencyKey);
    if (!basis) return {
      schemaVersion: "meta-kim-agent-handoff-v1",
      status: "blocked",
      reason: "agent_plan_not_adopted",
      executionScope,
      basis: null,
      designVersion: 0,
      designDigest: null,
      handoffDigest: null,
      envelope: null,
      receipt: null,
      history: [],
      requiresNativeHostConfirmation: true,
      readyForExecution: false,
      executionAuthorized: false,
      runId: null,
    };
    return handoffStore.inspect({ idempotencyKey, basis, scope: executionScope,
      plan: getRecord(idempotencyKey) });
  }

  // Trusted application-only input for the separate, explicitly approved B3
  // adapter. Never expose this through the browser's GET receipt: it contains
  // the original user goal and can include private project information.
  function getTrustedExecutionInput({ idempotencyKey } = {}) {
    const basis = adoptedDesignBasis(idempotencyKey);
    const record = basis && getRecord(idempotencyKey);
    const goal = record?.originalGoal;
    if (!basis || typeof goal !== "string" || !validateAgentWorkflowIntake({
      goal, hostId: record.requestedHostId, idempotencyKey,
    }) || agentWorkflowFingerprint(goal, record.requestedHostId) !== record.fingerprint) return null;
    const handoff = inspectHandoff({ idempotencyKey });
    if (handoff.status !== "prepared" || handoff.basis.requestId !== basis.requestId
      || handoff.basis.planDigest !== basis.planDigest) return null;
    return Object.freeze({
      goal, requestedHostId: record.requestedHostId,
      selectedHostId: record.selectedHostId ?? null,
      planPreview: record.resultPreview, basis,
      handoffDigest: handoff.handoffDigest,
      envelope: handoff.envelope,
    });
  }

  async function getTrustedProfessionalMethod({ idempotencyKey } = {}) {
    const trusted = getTrustedExecutionInput({ idempotencyKey });
    if (!trusted || typeof agentStartService.getProfessionalReference !== "function") return null;
    return agentStartService.getProfessionalReference(trusted.goal);
  }


  function prepareHandoff(input) {
    const basis = adoptedDesignBasis(input?.idempotencyKey);
    if (!basis) throw agentWorkflowConflict("agent_plan_not_adopted");
    return handoffStore.prepare({ input, basis, scope: executionScope,
      plan: getRecord(input.idempotencyKey) });
  }

  async function getHosts() {
    return { ...(await agentStartService.getHosts()), executionScope };
  }

  async function refreshReceipt(key, record) {
    // The native intake owns live status only in the process that launched it.
    // A new process may show the saved decision, but never invent a resumed CLI.
    if (!localKeys.has(key) || closed || !["reserved", "accepted", "running"].includes(record.status)) return record;
    const native = safeNativeReceipt(await agentStartService.inspect({ idempotencyKey: key }));
    if (!native || native.status === "unknown") return record;
    if (record.status === native.status && !native.resultPreview && !native.capabilityState && !native.reason) return record;
    const next = {
      ...record,
      status: native.status,
      reason: native.reason,
      ...(native.selectedHostId && { selectedHostId: native.selectedHostId }),
      ...(native.capabilityState && { capabilityState: native.capabilityState }),
      ...(native.resultPreview && { resultPreview: native.resultPreview }),
      updatedAt: new Date().toISOString(),
    };
    if (next.status === "completed" && next.resultPreview) {
      next.planDigest = agentWorkflowPlanDigest({ projectFingerprint, requestId: next.requestId,
        resultPreview: next.resultPreview });
    }
    replaceRecord(stateRoot, next);
    return next;
  }

  async function inspect({ idempotencyKey } = {}) {
    if (!AGENT_WORKFLOW_KEY_PATTERN.test(idempotencyKey ?? "")) return publicReceipt(null, executionScope);
    const record = getRecord(idempotencyKey);
    if (!record) return publicReceipt(null, executionScope);
    const latest = await refreshReceipt(idempotencyKey, record);
    return publicReceipt(latest, executionScope, { restarted: !localKeys.has(idempotencyKey) });
  }

  async function start(input = {}) {
    const validated = validateAgentWorkflowIntake(input);
    if (!validated) return { status: "blocked", reason: "invalid_request", executionAuthorized: false,
      nextAction: "请填写有效任务、客户端和请求标识。" };
    const { goal, hostId, idempotencyKey } = validated;
    const fingerprint = agentWorkflowFingerprint(goal, hostId);
    const saved = getRecord(idempotencyKey);
    if (saved) {
      if (saved.fingerprint !== fingerprint) return { status: "blocked", reason: "idempotency_conflict",
        executionAuthorized: false, nextAction: "任务内容已变化，请使用新的请求标识。" };
      if (inFlightStarts.has(idempotencyKey)) return inFlightStarts.get(idempotencyKey);
      const receipt = await inspect({ idempotencyKey });
      if (receipt.recoveryState === "in_doubt") return { status: "blocked", reason: "agent_request_in_doubt",
        requestId: saved.requestId, runId: null, executionAuthorized: false,
        nextAction: "先核实原客户端执行状态，避免重复启动。" };
      return { status: saved.startStatus ?? "accepted", requestId: saved.requestId, runId: null,
        executionAuthorized: false, ...(saved.startReason && { reason: saved.startReason }),
        ...(receipt.planDigest && { planDigest: receipt.planDigest }),
        ...(receipt.selectedHostId && { selectedHostId: receipt.selectedHostId }),
        executionScope };
    }
    if (closed) return { status: "blocked", reason: "service_closed", executionAuthorized: false };

    const now = new Date().toISOString();
    const record = {
      schemaVersion: AGENT_WORKFLOW_SCHEMA,
      projectFingerprint,
      idempotencyKey,
      requestId: randomUUID(),
      fingerprint,
      originalGoal: goal,
      requestedHostId: hostId,
      selectedHostId: null,
      status: "reserved",
      startStatus: "accepted",
      startReason: null,
      reason: null,
      resultPreview: null,
      planDigest: null,
      decision: null,
      createdAt: now,
      updatedAt: now,
    };
    if (!persistNewRecord(stateRoot, record)) {
      // A competing process reserved this key first; trust its ledger only.
      return { status: "blocked", reason: "agent_request_already_reserved", executionAuthorized: false,
        nextAction: "请求已经登记。请查询其回执，勿重复启动。" };
    }
    localKeys.add(idempotencyKey);
    const acceptedPromise = (async () => {
      let acceptance;
      try { acceptance = await agentStartService.start(validated); }
      catch { acceptance = { status: "unavailable", reason: "native_handoff_failed" }; }
      const native = safeNativeReceipt(acceptance);
      const accepted = acceptance?.status === "accepted";
      const startStatus = accepted ? "accepted"
        : ["blocked", "unavailable"].includes(acceptance?.status) ? acceptance.status : "unavailable";
      const next = {
        ...record,
        startStatus,
        startReason: typeof acceptance?.reason === "string" ? acceptance.reason.slice(0, 72) : null,
        status: accepted ? "accepted" : "blocked",
        reason: accepted ? null : (native?.reason ?? "native_handoff_failed"),
        ...(native?.selectedHostId && { selectedHostId: native.selectedHostId }),
        ...(native?.capabilityState && { capabilityState: native.capabilityState }),
        updatedAt: new Date().toISOString(),
      };
      replaceRecord(stateRoot, next);
      return { status: startStatus, requestId: record.requestId, runId: null,
        executionAuthorized: false, executionScope,
        ...(next.startReason && { reason: next.startReason }),
        ...(next.selectedHostId && { selectedHostId: next.selectedHostId }),
        ...(next.capabilityState && { capabilityState: next.capabilityState }),
      };
    })();
    inFlightStarts.set(idempotencyKey, acceptedPromise);
    try { return await acceptedPromise; }
    finally { inFlightStarts.delete(idempotencyKey); }
  }

  async function recordDecision(input) {
    const decisionInput = validateAgentWorkflowDecision(input);
    if (!decisionInput) throw new TypeError("Invalid agent decision payload");
    const record = getRecord(decisionInput.idempotencyKey);
    if (!record) throw agentWorkflowConflict("agent_request_not_found");
    const latest = await refreshReceipt(decisionInput.idempotencyKey, record);
    function verifyBasis(row) {
      if (row.requestId !== decisionInput.requestId || !row.planDigest
        || row.planDigest !== decisionInput.planDigest || row.status !== "completed") {
        throw agentWorkflowConflict("agent_plan_not_current_or_not_ready");
      }
    }
    function existingDecision(row) {
      if (!row.decision) return null;
      if (row.decision.decisionKey !== decisionInput.decisionKey
        || row.decision.action !== decisionInput.action
        || row.decision.feedback !== decisionInput.feedback
        || (row.decision.selectedStrategy ?? null) !== decisionInput.selectedStrategy
        || (row.decision.selectionReason ?? null) !== decisionInput.selectionReason) {
        throw agentWorkflowConflict("agent_decision_already_recorded");
      }
      return { schemaVersion: AGENT_DECISION_SCHEMA, status: "recorded", decision: publicDecision(row),
        requestId: row.requestId, planDigest: row.planDigest, runId: null,
        executionAuthorized: false, executionScope };
    }
    verifyBasis(latest);
    const replay = existingDecision(latest);
    if (replay) return replay;

    // A filesystem-exclusive per-request CAS lock stops two local processes
    // from silently overwriting each other's human decision. A crash before
    // release leaves a fail-closed lock for explicit recovery; a committed
    // decision above remains idempotently readable even in that case.
    const lockPath = path.join(stateRoot, `${decisionInput.idempotencyKey}.decision-lock`);
    try { mkdirSync(lockPath, { mode: 0o700 }); }
    catch (error) {
      if (error.code === "EEXIST") throw agentWorkflowConflict("agent_decision_busy_or_in_doubt");
      throw error;
    }
    try {
      const current = getRecord(decisionInput.idempotencyKey);
      if (!current) throw agentWorkflowConflict("agent_request_not_found");
      verifyBasis(current);
      const committed = existingDecision(current);
      if (committed) return committed;
      const decision = {
        state: decisionInput.state,
        action: decisionInput.action,
        feedback: decisionInput.feedback,
        recordedAt: new Date().toISOString(),
        decisionKey: decisionInput.decisionKey,
        planDigest: decisionInput.planDigest,
        ...(decisionInput.action === "adopt" && {
          selectedStrategy: decisionInput.selectedStrategy,
          selectionReason: decisionInput.selectionReason,
          strategySelectionBasis: "human_named_unstructured_plan",
          alternativesVerified: false,
        }),
      };
      replaceRecord(stateRoot, { ...current, decision, updatedAt: decision.recordedAt });
      return { schemaVersion: AGENT_DECISION_SCHEMA, status: "recorded", decision,
        requestId: current.requestId, planDigest: current.planDigest, runId: null,
        executionAuthorized: false, executionScope };
    } finally {
      rmdirSync(lockPath);
    }
  }

  async function close() {
    if (closed) return;
    if (typeof agentStartService.close === "function") await agentStartService.close();
    // A graceful shutdown can persist native cancellation; a power loss will
    // instead display in_doubt on restart, never a fabricated completion.
    for (const key of localKeys) {
      try {
        const record = getRecord(key);
        if (record && ["reserved", "accepted", "running"].includes(record.status)) {
          const native = safeNativeReceipt(await agentStartService.inspect({ idempotencyKey: key }));
          if (native && ["failed", "blocked", "completed"].includes(native.status)) {
            const next = { ...record, status: native.status, reason: native.reason,
              resultPreview: native.resultPreview, updatedAt: new Date().toISOString() };
            if (next.status === "completed" && next.resultPreview) next.planDigest = agentWorkflowPlanDigest({
              projectFingerprint, requestId: next.requestId, resultPreview: next.resultPreview });
            replaceRecord(stateRoot, next);
          }
        }
      } catch {
        // Never mask server shutdown or overwrite unverified evidence.
      }
    }
    closed = true;
  }

  const getProfessionalDirectory = (...args) => typeof agentStartService.getProfessionalDirectory === "function"
    ? agentStartService.getProfessionalDirectory(...args)
    : Promise.resolve({ status: "not_configured", agents: [] });
  const getNativeDirectory = (...args) => typeof agentStartService.getNativeDirectory === "function"
    ? agentStartService.getNativeDirectory(...args)
    : Promise.resolve({ nativeHosts: [], nativeCapabilities: [] });
  const getArchitecturePrd = (opts = {}, ...rest) => typeof agentStartService.getArchitecturePrd === "function"
    ? agentStartService.getArchitecturePrd(opts, ...rest)
    : Promise.resolve(discoverProjectArchitecturePrd({ projectRoot: opts?.targetProjectRoot || realRoot }));
  const getRepositoryFacts = (...args) => typeof agentStartService.getRepositoryFacts === "function"
    ? agentStartService.getRepositoryFacts(...args)
    : Promise.resolve(null);
  const getSessionBindings = (...args) => typeof agentStartService.getSessionBindings === "function"
    ? agentStartService.getSessionBindings(...args)
    : Promise.resolve(null);
  const bindSession = (...args) => typeof agentStartService.bindSession === "function"
    ? agentStartService.bindSession(...args)
    : Promise.resolve({ status: "blocked", reason: "not_available" });

  return Object.freeze({
    getHosts, getProfessionalDirectory, getNativeDirectory, getArchitecturePrd,
    getRepositoryFacts, getSessionBindings, bindSession,
    start, inspect, recordDecision, inspectDesign, recordDesign,
    inspectDesignDraft, startDesignDraft, inspectHandoff, prepareHandoff, close,
    getTrustedExecutionInput, getTrustedProfessionalMethod,
  });
}
