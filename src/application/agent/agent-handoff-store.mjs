/** Content-addressed preparation receipts; never a native-host or Run adapter. */
import { createHash } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, rmdirSync, statSync, writeFileSync,
} from "node:fs";
import path from "node:path";

import { AGENT_WORKFLOW_KEY_PATTERN, agentWorkflowConflict } from "../../domain/runtime/agent-workflow-decision.mjs";
import {
  AGENT_HANDOFF_SCHEMA, AGENT_HANDOFF_RECORD_SCHEMA, buildAgentHandoffEnvelope,
  digestAgentHandoffEnvelope, validateAgentHandoffPreparation,
} from "../../domain/runtime/agent-handoff-envelope.mjs";

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_HANDOFF_RECORD_BYTES = 2 * 1_048_576;
const MAX_HANDOFF_RECEIPTS = 128;
const FILE_NAME = /^p-([A-Za-z0-9_-]{16,128})\.json$/u;

function handoffDirectory(stateRoot, key) {
  if (!AGENT_WORKFLOW_KEY_PATTERN.test(key ?? "")) throw new TypeError("Invalid handoff request key");
  return path.join(stateRoot, `${key}.handoff`);
}

function assureDirectory(directory, create = false) {
  if (create && !existsSync(directory)) {
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  if (!existsSync(directory)) return false;
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw agentWorkflowConflict("agent_handoff_state_path_invalid");
  return true;
}

function recordDigest(record) {
  const { recordDigest: ignored, ...rest } = record;
  return createHash("sha256").update("meta-kim-static-handoff-receipt-v1\u0000")
    .update(JSON.stringify(rest)).digest("hex");
}

function inputDigest(input) {
  return createHash("sha256").update("meta-kim-static-handoff-input-v1\u0000")
    .update(JSON.stringify(input)).digest("hex");
}

function readReceipts(stateRoot, key, basis, scope) {
  const directory = handoffDirectory(stateRoot, key);
  if (!assureDirectory(directory)) return [];
  const names = readdirSync(directory).filter((name) => FILE_NAME.test(name));
  if (names.length > MAX_HANDOFF_RECEIPTS) throw agentWorkflowConflict("agent_handoff_receipt_limit");
  const records = names.map((name) => {
    const filename = path.join(directory, name);
    let fd;
    try {
      if (lstatSync(filename).isSymbolicLink()) throw new Error("symlink");
      fd = openSync(filename, constants.O_RDONLY | O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > MAX_HANDOFF_RECORD_BYTES) {
        throw new Error("unsafe record");
      }
      const record = JSON.parse(readFileSync(fd, "utf8"));
      if (!record || record.schemaVersion !== AGENT_HANDOFF_RECORD_SCHEMA
        || record.handoffKey !== FILE_NAME.exec(name)[1]
        || record.basis?.projectFingerprint !== scope.projectFingerprint
        || JSON.stringify(record.basis) !== JSON.stringify(basis)
        || record.envelope?.project?.projectFingerprint !== scope.projectFingerprint
        || record.handoffDigest !== digestAgentHandoffEnvelope(record.envelope)
        || record.recordDigest !== recordDigest(record)) throw new Error("integrity");
      return record;
    } catch {
      throw agentWorkflowConflict("agent_handoff_receipt_integrity_failed");
    } finally {
      if (fd != null) closeSync(fd);
    }
  });
  records.sort((a, b) => a.preparedAt.localeCompare(b.preparedAt) || a.handoffKey.localeCompare(b.handoffKey));
  return records;
}

function publicView({ basis, scope, design, plan, records }) {
  const candidate = buildAgentHandoffEnvelope({ scope, plan, basis, design });
  const current = candidate && records.filter((record) => record.handoffDigest === candidate.handoffDigest
    && record.designVersion === design.version).at(-1);
  const status = !candidate ? "blocked" : current ? "prepared" : records.length ? "stale" : "eligible";
  const reason = !candidate ? design.version === 0 ? "design_not_started" : "design_review_incomplete" : null;
  return {
    schemaVersion: AGENT_HANDOFF_SCHEMA,
    status,
    ...(reason && { reason }),
    executionScope: scope,
    basis,
    designVersion: design.version,
    designDigest: design.designDigest,
    handoffDigest: candidate?.handoffDigest ?? null,
    envelope: candidate?.envelope ?? null,
    receipt: current ? { handoffKey: current.handoffKey, preparedAt: current.preparedAt,
      handoffDigest: current.handoffDigest } : null,
    history: records.map((record) => ({ handoffKey: record.handoffKey,
      preparedAt: record.preparedAt, designVersion: record.designVersion,
      handoffDigest: record.handoffDigest })),
    previousProposalStale: !current && records.length > 0,
    requiresNativeHostConfirmation: true,
    readyForExecution: false,
    executionAuthorized: false,
    runId: null,
  };
}

export function createAgentHandoffStore({ stateRoot, designStore } = {}) {
  if (typeof stateRoot !== "string" || !path.isAbsolute(stateRoot)
    || !statSync(stateRoot).isDirectory() || lstatSync(stateRoot).isSymbolicLink()
    || typeof designStore?.inspect !== "function") throw new TypeError("Invalid static handoff store configuration");

  function inspect({ idempotencyKey, basis, scope, plan }) {
    const design = designStore.inspect({ idempotencyKey, basis });
    const records = readReceipts(stateRoot, idempotencyKey, basis, scope);
    return publicView({ basis, scope, design, plan, records });
  }

  function prepare({ input, basis, scope, plan }) {
    const command = validateAgentHandoffPreparation(input);
    if (!command) throw new TypeError("Invalid static handoff preparation");
    if (command.idempotencyKey !== basis.idempotencyKey || command.requestId !== basis.requestId
      || command.planDigest !== basis.planDigest || command.decisionKey !== basis.decisionKey) {
      throw agentWorkflowConflict("agent_handoff_plan_decision_mismatch");
    }
    const directory = handoffDirectory(stateRoot, command.idempotencyKey);
    const fingerprint = inputDigest(command);
    const prior = readReceipts(stateRoot, command.idempotencyKey, basis, scope);
    const replay = prior.find((record) => record.handoffKey === command.handoffKey);
    if (replay) {
      if (replay.inputDigest !== fingerprint) throw agentWorkflowConflict("agent_handoff_key_conflict");
      return inspect({ idempotencyKey: command.idempotencyKey, basis, scope, plan });
    }

    // Use the same exclusive lock as B2 design mutations: the approved
    // snapshot cannot change between the current-version check and sealing.
    const lockPath = path.join(stateRoot, `${command.idempotencyKey}.design-lock`);
    try { mkdirSync(lockPath, { mode: 0o700 }); }
    catch (error) {
      if (error.code === "EEXIST") throw agentWorkflowConflict("agent_handoff_design_busy_or_in_doubt");
      throw error;
    }
    try {
      const design = designStore.inspect({ idempotencyKey: command.idempotencyKey, basis });
      const candidate = buildAgentHandoffEnvelope({ scope, plan, basis, design });
      if (!candidate) throw agentWorkflowConflict("agent_handoff_design_not_fully_approved");
      if (design.version !== command.designVersion || design.designDigest !== command.designDigest) {
        throw agentWorkflowConflict("agent_handoff_design_version_conflict");
      }
      assureDirectory(directory, true);
      const checked = readReceipts(stateRoot, command.idempotencyKey, basis, scope);
      const repeated = checked.find((record) => record.handoffKey === command.handoffKey);
      if (repeated) {
        if (repeated.inputDigest !== fingerprint) throw agentWorkflowConflict("agent_handoff_key_conflict");
        return inspect({ idempotencyKey: command.idempotencyKey, basis, scope, plan });
      }
      if (checked.length >= MAX_HANDOFF_RECEIPTS) throw agentWorkflowConflict("agent_handoff_receipt_limit");
      const record = {
        schemaVersion: AGENT_HANDOFF_RECORD_SCHEMA,
        handoffKey: command.handoffKey,
        basis,
        preparedAt: new Date().toISOString(),
        designVersion: design.version,
        designDigest: design.designDigest,
        handoffDigest: candidate.handoffDigest,
        inputDigest: fingerprint,
        envelope: candidate.envelope,
      };
      record.recordDigest = recordDigest(record);
      const json = JSON.stringify(record);
      if (Buffer.byteLength(json, "utf8") > MAX_HANDOFF_RECORD_BYTES) throw new TypeError("Handoff packet too large");
      const filename = path.join(directory, `p-${command.handoffKey}.json`);
      let fd;
      try {
        fd = openSync(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
        writeFileSync(fd, json, "utf8");
        fsyncSync(fd);
      } catch (error) {
        if (error.code === "EEXIST") throw agentWorkflowConflict("agent_handoff_key_conflict");
        throw error;
      } finally {
        if (fd != null) closeSync(fd);
      }
      return inspect({ idempotencyKey: command.idempotencyKey, basis, scope, plan });
    } finally {
      rmdirSync(lockPath);
    }
  }

  return Object.freeze({ inspect, prepare });
}
