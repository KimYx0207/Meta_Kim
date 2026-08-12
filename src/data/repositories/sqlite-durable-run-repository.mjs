import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { importDatabaseSync } from "../sqlite/runtime.mjs";
import { withSqliteTransaction } from "../sqlite/transaction.mjs";

const SCHEMA_VERSION = 5;
const GENESIS_HASH = "0".repeat(64);
const BLOCKING_EFFECT_STATES = new Set(["prepared", "dispatch_started", "in_doubt"]);
const TERMINAL_ATTEMPT_STATES = new Set(["completed", "failed", "abandoned"]);
const MIGRATION_HASHES = new Map([
  [1, sha256("p118-durable-run-kernel-schema-v1")],
  [2, sha256("p118-durable-run-coordinator-schema-v2")],
  [3, sha256("p118-durable-run-integrity-and-effect-reuse-schema-v3")],
  [4, sha256("p118-durable-run-terminal-and-reuse-requirement-schema-v4")],
  [5, sha256("p118-durable-run-bidirectional-projection-integrity-schema-v5")],
]);

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function canonicalValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON numbers must be finite");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item, seen));
  if (typeof value === "object") {
    if (seen.has(value)) throw new TypeError("JSON payload must not contain cycles");
    seen.add(value);
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item !== undefined && typeof item !== "function" && typeof item !== "symbol") {
        normalized[key] = canonicalValue(item, seen);
      }
    }
    seen.delete(value);
    return normalized;
  }
  throw new TypeError(`Unsupported JSON value: ${typeof value}`);
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value ?? null));
}

const durableResumeAttestations = new WeakMap();
const durableProjectionAttestations = new WeakMap();
const attestationDigest = (value) => sha256(canonicalJson(value));

export function isAttestedDurableRunResume(value) {
  return Boolean(value && typeof value === "object" && durableResumeAttestations.get(value) === attestationDigest(value));
}

export function isAttestedDurableRunProjection(value) {
  return Boolean(value && typeof value === "object" && durableProjectionAttestations.get(value) === attestationDigest(value));
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function timestamp(nowMs = Date.now()) {
  if (!Number.isFinite(nowMs)) throw new TypeError("nowMs must be finite");
  return new Date(nowMs).toISOString();
}

function parseJson(value) {
  return value == null ? null : JSON.parse(value);
}

function normalizeEventRow(row) {
  if (!row) return null;
  return {
    eventId: row.event_id,
    runId: row.run_id,
    eventSeq: Number(row.event_seq),
    eventType: row.event_type,
    nodeId: row.node_id,
    attemptId: row.attempt_id,
    payload: parseJson(row.payload_json),
    payloadSha256: row.payload_sha256,
    previousEventHash: row.previous_event_hash,
    eventHash: row.event_hash,
    createdAt: row.created_at,
    writerId: row.writer_id,
  };
}

function normalizeCheckpointRow(row) {
  if (!row) return null;
  return {
    checkpointId: row.checkpoint_id,
    runId: row.run_id,
    parentCheckpointId: row.parent_checkpoint_id,
    lineageKind: row.lineage_kind,
    eventSeq: Number(row.event_seq),
    graphDigest: row.graph_digest,
    state: parseJson(row.state_json),
    stateSha256: row.state_sha256,
    createdAt: row.created_at,
  };
}

function initializeSchema(db) {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  withSqliteTransaction(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS governed_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL,
        migration_sha256 TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS governed_runs (
        run_id TEXT PRIMARY KEY,
        root_run_id TEXT NOT NULL,
        parent_run_id TEXT,
        fork_checkpoint_id TEXT,
        graph_digest TEXT NOT NULL,
        task_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        CHECK (
          (parent_run_id IS NULL AND fork_checkpoint_id IS NULL AND root_run_id = run_id)
          OR (parent_run_id IS NOT NULL AND fork_checkpoint_id IS NOT NULL)
        ),
        FOREIGN KEY (root_run_id) REFERENCES governed_runs(run_id) ON DELETE RESTRICT,
        FOREIGN KEY (parent_run_id) REFERENCES governed_runs(run_id) ON DELETE RESTRICT,
        FOREIGN KEY (fork_checkpoint_id) REFERENCES governed_checkpoints(checkpoint_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS governed_run_heads (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'failed', 'blocked')),
        next_event_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_event_seq > 0),
        head_event_hash TEXT NOT NULL DEFAULT '${GENESIS_HASH}',
        head_checkpoint_id TEXT,
        version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
        updated_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES governed_runs(run_id) ON DELETE RESTRICT,
        FOREIGN KEY (head_checkpoint_id) REFERENCES governed_checkpoints(checkpoint_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS governed_run_coordinators (
        run_id TEXT PRIMARY KEY,
        owner_id TEXT,
        fence_token INTEGER NOT NULL CHECK (fence_token > 0),
        lease_expires_at_ms INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES governed_runs(run_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS governed_events (
        run_id TEXT NOT NULL,
        event_seq INTEGER NOT NULL CHECK (event_seq > 0),
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        node_id TEXT,
        attempt_id TEXT,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        payload_sha256 TEXT NOT NULL,
        previous_event_hash TEXT NOT NULL,
        event_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        writer_id TEXT NOT NULL,
        PRIMARY KEY (run_id, event_seq),
        FOREIGN KEY (run_id) REFERENCES governed_runs(run_id) ON DELETE RESTRICT
      );

      CREATE TRIGGER IF NOT EXISTS governed_events_no_update
      BEFORE UPDATE ON governed_events
      BEGIN
        SELECT RAISE(ABORT, 'governed_events is append-only and immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS governed_events_no_delete
      BEFORE DELETE ON governed_events
      BEGIN
        SELECT RAISE(ABORT, 'governed_events is append-only and immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS governed_events_no_replace
      BEFORE INSERT ON governed_events
      WHEN EXISTS (
        SELECT 1 FROM governed_events existing
        WHERE existing.event_id = NEW.event_id
          OR (existing.run_id = NEW.run_id AND existing.event_seq = NEW.event_seq)
      )
      BEGIN
        SELECT RAISE(ABORT, 'governed_events is append-only and immutable; replace is forbidden');
      END;

      CREATE TABLE IF NOT EXISTS governed_node_attempts (
        attempt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
        fence_token INTEGER NOT NULL CHECK (fence_token > 0),
        node_definition_hash TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        dependency_output_hash TEXT NOT NULL,
        attempt_kind TEXT NOT NULL CHECK (attempt_kind IN ('execute', 'reuse', 'reconcile')),
        reused_from_attempt_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (run_id, node_id, attempt_no),
        FOREIGN KEY (run_id) REFERENCES governed_runs(run_id) ON DELETE RESTRICT,
        FOREIGN KEY (reused_from_attempt_id) REFERENCES governed_node_attempts(attempt_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS governed_node_attempt_transitions (
        attempt_id TEXT NOT NULL,
        transition_no INTEGER NOT NULL CHECK (transition_no > 0),
        run_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('claimed', 'running', 'completed', 'failed', 'abandoned', 'in_doubt')),
        event_seq INTEGER NOT NULL,
        detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (attempt_id, transition_no),
        FOREIGN KEY (attempt_id) REFERENCES governed_node_attempts(attempt_id) ON DELETE RESTRICT,
        FOREIGN KEY (run_id, event_seq) REFERENCES governed_events(run_id, event_seq) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS governed_node_claims (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL UNIQUE,
        fence_token INTEGER NOT NULL CHECK (fence_token > 0),
        lease_owner TEXT NOT NULL,
        lease_expires_at_ms INTEGER NOT NULL,
        PRIMARY KEY (run_id, node_id),
        FOREIGN KEY (run_id) REFERENCES governed_runs(run_id) ON DELETE RESTRICT,
        FOREIGN KEY (attempt_id) REFERENCES governed_node_attempts(attempt_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS governed_effects (
        effect_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        root_run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        logical_effect_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        provider_binding_json TEXT NOT NULL CHECK (json_valid(provider_binding_json)),
        created_at TEXT NOT NULL,
        UNIQUE (root_run_id, logical_effect_key),
        FOREIGN KEY (run_id) REFERENCES governed_runs(run_id) ON DELETE RESTRICT,
        FOREIGN KEY (root_run_id) REFERENCES governed_runs(run_id) ON DELETE RESTRICT,
        FOREIGN KEY (attempt_id) REFERENCES governed_node_attempts(attempt_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS governed_effect_transitions (
        effect_id TEXT NOT NULL,
        transition_no INTEGER NOT NULL CHECK (transition_no > 0),
        run_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'dispatch_started', 'in_doubt', 'reconciled_completed', 'reconciled_absent'
        )),
        event_seq INTEGER NOT NULL,
        detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (effect_id, transition_no),
        FOREIGN KEY (effect_id) REFERENCES governed_effects(effect_id) ON DELETE RESTRICT,
        FOREIGN KEY (run_id, event_seq) REFERENCES governed_events(run_id, event_seq) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS governed_effect_reuses (
        reuse_id TEXT PRIMARY KEY,
        effect_id TEXT NOT NULL,
        root_run_id TEXT NOT NULL,
        target_run_id TEXT NOT NULL,
        target_node_id TEXT NOT NULL,
        source_attempt_id TEXT NOT NULL,
        target_attempt_id TEXT NOT NULL,
        reuser_identity TEXT NOT NULL,
        evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
        evidence_sha256 TEXT NOT NULL,
        event_seq INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (effect_id, target_attempt_id),
        FOREIGN KEY (effect_id) REFERENCES governed_effects(effect_id) ON DELETE RESTRICT,
        FOREIGN KEY (root_run_id) REFERENCES governed_runs(run_id) ON DELETE RESTRICT,
        FOREIGN KEY (target_run_id, event_seq) REFERENCES governed_events(run_id, event_seq) ON DELETE RESTRICT,
        FOREIGN KEY (source_attempt_id) REFERENCES governed_node_attempts(attempt_id) ON DELETE RESTRICT,
        FOREIGN KEY (target_attempt_id) REFERENCES governed_node_attempts(attempt_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS governed_effect_reuse_requirements (
        requirement_id TEXT PRIMARY KEY,
        effect_id TEXT NOT NULL,
        root_run_id TEXT NOT NULL,
        target_run_id TEXT NOT NULL,
        target_node_id TEXT NOT NULL,
        target_attempt_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'satisfied')),
        required_event_seq INTEGER NOT NULL,
        satisfied_event_seq INTEGER,
        created_at TEXT NOT NULL,
        satisfied_at TEXT,
        UNIQUE (effect_id, target_attempt_id),
        FOREIGN KEY (effect_id) REFERENCES governed_effects(effect_id) ON DELETE RESTRICT,
        FOREIGN KEY (root_run_id) REFERENCES governed_runs(run_id) ON DELETE RESTRICT,
        FOREIGN KEY (target_run_id, required_event_seq) REFERENCES governed_events(run_id, event_seq) ON DELETE RESTRICT,
        FOREIGN KEY (target_run_id, satisfied_event_seq) REFERENCES governed_events(run_id, event_seq) ON DELETE RESTRICT,
        FOREIGN KEY (target_attempt_id) REFERENCES governed_node_attempts(attempt_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS governed_checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        lineage_kind TEXT NOT NULL CHECK (lineage_kind IN ('root', 'advance', 'fork')),
        event_seq INTEGER NOT NULL,
        graph_digest TEXT NOT NULL,
        state_json TEXT NOT NULL CHECK (json_valid(state_json)),
        state_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (run_id, event_seq),
        FOREIGN KEY (run_id, event_seq) REFERENCES governed_events(run_id, event_seq) ON DELETE RESTRICT,
        FOREIGN KEY (parent_checkpoint_id) REFERENCES governed_checkpoints(checkpoint_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS governed_checkpoint_nodes (
        checkpoint_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        source_attempt_id TEXT NOT NULL,
        node_definition_hash TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        dependency_output_hash TEXT NOT NULL,
        output_json TEXT NOT NULL CHECK (json_valid(output_json)),
        output_sha256 TEXT NOT NULL,
        completion_event_hash TEXT NOT NULL,
        PRIMARY KEY (checkpoint_id, node_id),
        FOREIGN KEY (checkpoint_id) REFERENCES governed_checkpoints(checkpoint_id) ON DELETE RESTRICT,
        FOREIGN KEY (source_attempt_id) REFERENCES governed_node_attempts(attempt_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS governed_edge_traversals (
        traversal_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        from_node_id TEXT NOT NULL,
        to_node_id TEXT NOT NULL,
        attempt_id TEXT,
        condition_digest TEXT NOT NULL,
        event_seq INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id, event_seq) REFERENCES governed_events(run_id, event_seq) ON DELETE RESTRICT,
        FOREIGN KEY (attempt_id) REFERENCES governed_node_attempts(attempt_id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS governed_events_node_idx
        ON governed_events(run_id, node_id, event_seq);
      CREATE INDEX IF NOT EXISTS governed_events_type_idx
        ON governed_events(run_id, event_type, event_seq);
      CREATE INDEX IF NOT EXISTS governed_attempts_node_idx
        ON governed_node_attempts(run_id, node_id, attempt_no);
      CREATE INDEX IF NOT EXISTS governed_effects_attempt_idx
        ON governed_effects(attempt_id);
      CREATE INDEX IF NOT EXISTS governed_effect_reuses_target_idx
        ON governed_effect_reuses(target_attempt_id);
      CREATE INDEX IF NOT EXISTS governed_effect_reuse_requirements_target_idx
        ON governed_effect_reuse_requirements(target_attempt_id, status);
      CREATE INDEX IF NOT EXISTS governed_checkpoints_parent_idx
        ON governed_checkpoints(parent_checkpoint_id);
      CREATE INDEX IF NOT EXISTS governed_runs_parent_idx
        ON governed_runs(parent_run_id);
      CREATE INDEX IF NOT EXISTS governed_edge_run_idx
        ON governed_edge_traversals(run_id, event_seq);

      CREATE TRIGGER IF NOT EXISTS governed_node_attempts_no_update
      BEFORE UPDATE ON governed_node_attempts BEGIN
        SELECT RAISE(ABORT, 'governed_node_attempts is append-only and immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS governed_node_attempts_no_delete
      BEFORE DELETE ON governed_node_attempts BEGIN
        SELECT RAISE(ABORT, 'governed_node_attempts is append-only and immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS governed_node_attempt_transitions_no_update
      BEFORE UPDATE ON governed_node_attempt_transitions BEGIN
        SELECT RAISE(ABORT, 'governed_node_attempt_transitions is append-only and immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS governed_node_attempt_transitions_no_delete
      BEFORE DELETE ON governed_node_attempt_transitions BEGIN
        SELECT RAISE(ABORT, 'governed_node_attempt_transitions is append-only and immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS governed_effects_no_update
      BEFORE UPDATE ON governed_effects BEGIN
        SELECT RAISE(ABORT, 'governed_effects is append-only and immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS governed_effects_no_delete
      BEFORE DELETE ON governed_effects BEGIN
        SELECT RAISE(ABORT, 'governed_effects is append-only and immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS governed_effect_transitions_no_update
      BEFORE UPDATE ON governed_effect_transitions BEGIN
        SELECT RAISE(ABORT, 'governed_effect_transitions is append-only and immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS governed_effect_transitions_no_delete
      BEFORE DELETE ON governed_effect_transitions BEGIN
        SELECT RAISE(ABORT, 'governed_effect_transitions is append-only and immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS governed_effect_reuses_no_update
      BEFORE UPDATE ON governed_effect_reuses BEGIN
        SELECT RAISE(ABORT, 'governed_effect_reuses is append-only and immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS governed_effect_reuses_no_delete
      BEFORE DELETE ON governed_effect_reuses BEGIN
        SELECT RAISE(ABORT, 'governed_effect_reuses is append-only and immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS governed_edge_traversals_no_update
      BEFORE UPDATE ON governed_edge_traversals BEGIN
        SELECT RAISE(ABORT, 'governed_edge_traversals is append-only and immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS governed_edge_traversals_no_delete
      BEFORE DELETE ON governed_edge_traversals BEGIN
        SELECT RAISE(ABORT, 'governed_edge_traversals is append-only and immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS governed_checkpoints_no_update
      BEFORE UPDATE ON governed_checkpoints BEGIN
        SELECT RAISE(ABORT, 'governed_checkpoints is append-only and immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS governed_checkpoints_no_delete
      BEFORE DELETE ON governed_checkpoints BEGIN
        SELECT RAISE(ABORT, 'governed_checkpoints is append-only and immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS governed_checkpoint_nodes_no_update
      BEFORE UPDATE ON governed_checkpoint_nodes BEGIN
        SELECT RAISE(ABORT, 'governed_checkpoint_nodes is append-only and immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS governed_checkpoint_nodes_no_delete
      BEFORE DELETE ON governed_checkpoint_nodes BEGIN
        SELECT RAISE(ABORT, 'governed_checkpoint_nodes is append-only and immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS governed_effect_reuse_requirements_no_delete
      BEFORE DELETE ON governed_effect_reuse_requirements BEGIN
        SELECT RAISE(ABORT, 'governed_effect_reuse_requirements is append-only and immutable');
      END;
    `);
    const headColumns = new Set(
      db.prepare("PRAGMA table_info(governed_run_heads)").all().map((column) => column.name),
    );
    if (!headColumns.has("head_event_hash")) {
      db.exec(`
        ALTER TABLE governed_run_heads
        ADD COLUMN head_event_hash TEXT NOT NULL DEFAULT '${GENESIS_HASH}'
      `);
      db.exec(`
        UPDATE governed_run_heads
        SET head_event_hash = COALESCE((
          SELECT event_hash FROM governed_events event
          WHERE event.run_id = governed_run_heads.run_id
          ORDER BY event.event_seq DESC LIMIT 1
        ), '${GENESIS_HASH}')
      `);
    }
    const checkpointNodeColumns = new Set(
      db.prepare("PRAGMA table_info(governed_checkpoint_nodes)").all().map((column) => column.name),
    );
    if (!checkpointNodeColumns.has("completion_event_hash")) {
      db.exec("ALTER TABLE governed_checkpoint_nodes ADD COLUMN completion_event_hash TEXT");
      db.exec(`
        UPDATE governed_checkpoint_nodes
        SET completion_event_hash = (
          SELECT event.event_hash FROM governed_events event
          JOIN governed_node_attempt_transitions transition
            ON transition.run_id = event.run_id AND transition.event_seq = event.event_seq
          WHERE transition.attempt_id = governed_checkpoint_nodes.source_attempt_id
            AND transition.state = 'completed'
          ORDER BY transition.transition_no DESC LIMIT 1
        )
      `);
    }
    for (const [version, migrationSha256] of MIGRATION_HASHES) {
      db.prepare(`
        INSERT INTO governed_schema_migrations(version, applied_at, migration_sha256)
        VALUES (?, ?, ?)
        ON CONFLICT(version) DO NOTHING
      `).run(version, timestamp(), migrationSha256);
      const recorded = db.prepare(`
        SELECT migration_sha256 FROM governed_schema_migrations WHERE version = ?
      `).get(version);
      if (recorded?.migration_sha256 !== migrationSha256) {
        throw new Error(`Durable run migration hash integrity mismatch for version ${version}`);
      }
    }
  });
}

function runRow(db, runId) {
  return db.prepare(`
    SELECT r.*, h.status, h.next_event_seq, h.head_event_hash,
      h.head_checkpoint_id, h.version, h.updated_at
    FROM governed_runs r
    JOIN governed_run_heads h ON h.run_id = r.run_id
    WHERE r.run_id = ?
  `).get(runId);
}

function assertRunBinding(db, { runId, graphDigest, taskFingerprint }) {
  const row = runRow(db, requiredString(runId, "runId"));
  if (!row) throw new Error(`Unknown governed run: ${runId}`);
  if (graphDigest != null && row.graph_digest !== graphDigest) {
    throw new Error(`Governed run graph binding mismatch for ${runId}`);
  }
  if (taskFingerprint != null && row.task_fingerprint !== taskFingerprint) {
    throw new Error(`Governed run task binding mismatch for ${runId}`);
  }
  return row;
}

function assertActiveRun(db, runId) {
  const run = assertRunBinding(db, { runId });
  if (run.status !== "active") {
    throw new Error(`Governed run ${runId} is terminal with status ${run.status}; mutation requires an active run`);
  }
  return run;
}

function eventHashInput({
  runId,
  eventSeq,
  eventId,
  eventType,
  nodeId,
  attemptId,
  payloadSha256,
  previousEventHash,
  createdAt,
  writerId,
}) {
  return canonicalJson({
    runId,
    eventSeq,
    eventId,
    eventType,
    nodeId: nodeId ?? null,
    attemptId: attemptId ?? null,
    payloadSha256,
    previousEventHash,
    createdAt,
    writerId,
  });
}

function appendEventInTransaction(db, {
  runId,
  eventId,
  eventType,
  payload = null,
  nodeId = null,
  attemptId = null,
  expectedCursor = null,
  writerId = "durable-run-kernel",
  createdAt = timestamp(),
}) {
  requiredString(runId, "runId");
  requiredString(eventId, "eventId");
  requiredString(eventType, "eventType");
  requiredString(writerId, "writerId");
  const payloadJson = canonicalJson(payload);
  const payloadSha256 = sha256(payloadJson);
  const existing = db.prepare("SELECT * FROM governed_events WHERE event_id = ?").get(eventId);
  if (existing) {
    const exact = existing.run_id === runId &&
      existing.event_type === eventType &&
      existing.node_id === (nodeId ?? null) &&
      existing.attempt_id === (attemptId ?? null) &&
      existing.payload_sha256 === payloadSha256;
    if (!exact) {
      throw new Error(`Event idempotency violation: ${eventId} already has different payload or binding`);
    }
    return normalizeEventRow(existing);
  }

  const head = db.prepare("SELECT * FROM governed_run_heads WHERE run_id = ?").get(runId);
  if (!head) throw new Error(`Unknown governed run: ${runId}`);
  const cursor = Number(head.next_event_seq) - 1;
  if (expectedCursor != null && Number(expectedCursor) !== cursor) {
    throw new Error(`Per-run cursor CAS failed for ${runId}: expected ${expectedCursor}, actual ${cursor}`);
  }
  const eventSeq = Number(head.next_event_seq);
  const previous = db.prepare(`
    SELECT event_hash FROM governed_events
    WHERE run_id = ? AND event_seq = ?
  `).get(runId, eventSeq - 1);
  const previousEventHash = previous?.event_hash ?? GENESIS_HASH;
  const eventHash = sha256(eventHashInput({
    runId,
    eventSeq,
    eventId,
    eventType,
    nodeId,
    attemptId,
    payloadSha256,
    previousEventHash,
    createdAt,
    writerId,
  }));
  db.prepare(`
    INSERT INTO governed_events(
      run_id, event_seq, event_id, event_type, node_id, attempt_id,
      payload_json, payload_sha256, previous_event_hash, event_hash, created_at, writer_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    eventSeq,
    eventId,
    eventType,
    nodeId,
    attemptId,
    payloadJson,
    payloadSha256,
    previousEventHash,
    eventHash,
    createdAt,
    writerId,
  );
  const advanced = db.prepare(`
    UPDATE governed_run_heads
    SET next_event_seq = next_event_seq + 1, head_event_hash = ?,
      version = version + 1, updated_at = ?
    WHERE run_id = ? AND next_event_seq = ? AND version = ?
  `).run(eventHash, createdAt, runId, eventSeq, head.version);
  if (Number(advanced.changes) !== 1) {
    throw new Error(`Per-run cursor CAS lost while appending ${eventId}`);
  }
  return normalizeEventRow(db.prepare("SELECT * FROM governed_events WHERE event_id = ?").get(eventId));
}

function latestAttemptState(db, attemptId) {
  return db.prepare(`
    SELECT state FROM governed_node_attempt_transitions
    WHERE attempt_id = ? ORDER BY transition_no DESC LIMIT 1
  `).get(attemptId)?.state ?? null;
}

function addAttemptTransition(db, { attemptId, runId, state, eventSeq, detail, createdAt }) {
  const next = Number(db.prepare(`
    SELECT COALESCE(MAX(transition_no), 0) + 1 AS transition_no
    FROM governed_node_attempt_transitions WHERE attempt_id = ?
  `).get(attemptId).transition_no);
  db.prepare(`
    INSERT INTO governed_node_attempt_transitions(
      attempt_id, transition_no, run_id, state, event_seq, detail_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(attemptId, next, runId, state, eventSeq, canonicalJson(detail), createdAt);
  return next;
}

function latestEffectState(db, effectId) {
  return db.prepare(`
    SELECT state FROM governed_effect_transitions
    WHERE effect_id = ? ORDER BY transition_no DESC LIMIT 1
  `).get(effectId)?.state ?? null;
}

function addEffectTransition(db, { effectId, runId, state, eventSeq, detail, createdAt }) {
  const next = Number(db.prepare(`
    SELECT COALESCE(MAX(transition_no), 0) + 1 AS transition_no
    FROM governed_effect_transitions WHERE effect_id = ?
  `).get(effectId).transition_no);
  db.prepare(`
    INSERT INTO governed_effect_transitions(
      effect_id, transition_no, run_id, state, event_seq, detail_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(effectId, next, runId, state, eventSeq, canonicalJson(detail), createdAt);
  return next;
}

function effectView(db, effectId) {
  const effect = db.prepare("SELECT * FROM governed_effects WHERE effect_id = ?").get(effectId);
  if (!effect) return null;
  return {
    effectId: effect.effect_id,
    runId: effect.run_id,
    rootRunId: effect.root_run_id,
    nodeId: effect.node_id,
    attemptId: effect.attempt_id,
    logicalEffectKey: effect.logical_effect_key,
    fingerprint: effect.fingerprint,
    idempotencyKey: effect.idempotency_key,
    providerBinding: parseJson(effect.provider_binding_json),
    state: latestEffectState(db, effectId),
    createdAt: effect.created_at,
  };
}

function lineageRunIds(db, runId) {
  return db.prepare(`
    WITH RECURSIVE lineage(run_id, parent_run_id, depth) AS (
      SELECT run_id, parent_run_id, 0 FROM governed_runs WHERE run_id = ?
      UNION ALL
      SELECT parent.run_id, parent.parent_run_id, lineage.depth + 1
      FROM governed_runs parent JOIN lineage ON lineage.parent_run_id = parent.run_id
    )
    SELECT run_id FROM lineage ORDER BY depth DESC
  `).all(runId).map((row) => row.run_id);
}

function blockingEffectsForAttempt(db, attemptId) {
  return db.prepare("SELECT effect_id FROM governed_effects WHERE attempt_id = ? ORDER BY effect_id")
    .all(attemptId)
    .map((row) => effectView(db, row.effect_id))
    .filter((effect) => BLOCKING_EFFECT_STATES.has(effect.state));
}

function blockingEffectsForRoot(db, rootRunId) {
  return db.prepare("SELECT effect_id FROM governed_effects WHERE root_run_id = ? ORDER BY effect_id")
    .all(rootRunId)
    .map((row) => effectView(db, row.effect_id))
    .filter((effect) => BLOCKING_EFFECT_STATES.has(effect.state));
}

function requireActiveNodeClaim(db, {
  runId,
  nodeId,
  attemptId,
  fenceToken,
  ownerId,
  nowMs,
}) {
  for (const [value, label] of [
    [runId, "runId"], [nodeId, "nodeId"], [attemptId, "attemptId"], [ownerId, "ownerId"],
  ]) requiredString(value, label);
  positiveInteger(fenceToken, "fenceToken");
  const claim = db.prepare(`
    SELECT * FROM governed_node_claims
    WHERE run_id = ? AND node_id = ? AND attempt_id = ?
      AND fence_token = ? AND lease_owner = ? AND lease_expires_at_ms > ?
  `).get(runId, nodeId, attemptId, fenceToken, ownerId, nowMs);
  if (!claim) {
    throw new Error("Stale fence, owner, attempt, or expired lease cannot mutate the active claim");
  }
  const state = latestAttemptState(db, attemptId);
  if (!["claimed", "running"].includes(state)) {
    throw new Error(`Active node claim attempt cannot mutate from ${state}`);
  }
  return claim;
}

function integrityFailure(reason, details = {}) {
  return { ok: false, reason, ...details };
}

function verifyDurableRunIntegrity(db, runId) {
  const run = runRow(db, requiredString(runId, "runId"));
  if (!run) return integrityFailure("unknown_run");

  for (const [version, expectedHash] of MIGRATION_HASHES) {
    const migration = db.prepare(`
      SELECT migration_sha256 FROM governed_schema_migrations WHERE version = ?
    `).get(version);
    if (migration?.migration_sha256 !== expectedHash) {
      return integrityFailure("migration_hash_mismatch", { version });
    }
  }

  const events = db.prepare(`
    SELECT * FROM governed_events WHERE run_id = ? ORDER BY event_seq
  `).all(runId);
  let previousEventHash = GENESIS_HASH;
  let expectedSeq = 1;
  for (const row of events) {
    if (Number(row.event_seq) !== expectedSeq) {
      return integrityFailure("event_sequence_gap", { eventId: row.event_id });
    }
    if (sha256(row.payload_json) !== row.payload_sha256) {
      return integrityFailure("event_payload_hash_mismatch", { eventId: row.event_id });
    }
    if (row.previous_event_hash !== previousEventHash) {
      return integrityFailure("previous_hash_mismatch", { eventId: row.event_id });
    }
    const expectedHash = sha256(eventHashInput({
      runId: row.run_id,
      eventSeq: Number(row.event_seq),
      eventId: row.event_id,
      eventType: row.event_type,
      nodeId: row.node_id,
      attemptId: row.attempt_id,
      payloadSha256: row.payload_sha256,
      previousEventHash: row.previous_event_hash,
      createdAt: row.created_at,
      writerId: row.writer_id,
    }));
    if (row.event_hash !== expectedHash) {
      return integrityFailure("event_hash_mismatch", { eventId: row.event_id });
    }
    previousEventHash = row.event_hash;
    expectedSeq += 1;
  }
  if (Number(run.next_event_seq) !== expectedSeq) {
    return integrityFailure("head_cursor_mismatch");
  }
  if (run.head_event_hash !== previousEventHash) {
    return integrityFailure("head_hash_mismatch");
  }

  const rootRuns = db.prepare(`
    SELECT * FROM governed_runs WHERE root_run_id = ? ORDER BY created_at, run_id
  `).all(run.root_run_id);
  const checkpoints = db.prepare(`
    SELECT checkpoint.* FROM governed_checkpoints checkpoint
    JOIN governed_runs governed_run ON governed_run.run_id = checkpoint.run_id
    WHERE governed_run.root_run_id = ?
    ORDER BY checkpoint.created_at, checkpoint.checkpoint_id
  `).all(run.root_run_id);
  const checkpointById = new Map(checkpoints.map((checkpoint) => [checkpoint.checkpoint_id, checkpoint]));
  for (const checkpoint of checkpoints) {
    if (sha256(checkpoint.state_json) !== checkpoint.state_sha256) {
      return integrityFailure("checkpoint_state_hash_mismatch", { checkpointId: checkpoint.checkpoint_id });
    }
    const checkpointRun = rootRuns.find((item) => item.run_id === checkpoint.run_id);
    if (!checkpointRun || checkpoint.graph_digest !== checkpointRun.graph_digest) {
      return integrityFailure("checkpoint_graph_binding_mismatch", { checkpointId: checkpoint.checkpoint_id });
    }
    const event = db.prepare(`
      SELECT * FROM governed_events WHERE run_id = ? AND event_seq = ?
    `).get(checkpoint.run_id, checkpoint.event_seq);
    const expectedEventType = checkpoint.lineage_kind === "fork" ? "RunForked" : "NodeAttemptCompleted";
    if (!event || event.event_type !== expectedEventType) {
      return integrityFailure("checkpoint_event_binding_mismatch", { checkpointId: checkpoint.checkpoint_id });
    }
    const checkpointState = parseJson(checkpoint.state_json);
    const eventPayload = parseJson(event.payload_json);
    if (checkpoint.lineage_kind === "fork") {
      if (
        eventPayload?.fromCheckpointId !== checkpoint.parent_checkpoint_id ||
        checkpointState?.forkedFromCheckpointId !== checkpoint.parent_checkpoint_id
      ) {
        return integrityFailure("checkpoint_event_binding_mismatch", { checkpointId: checkpoint.checkpoint_id });
      }
    } else if (
      event.attempt_id !== checkpointState?.sourceAttemptId ||
      event.node_id !== checkpointState?.completedNodeId ||
      Number(checkpointState?.eventSeq) !== Number(checkpoint.event_seq) ||
      eventPayload?.outputSha256 !== checkpointState?.outputSha256
    ) {
      return integrityFailure("checkpoint_event_binding_mismatch", { checkpointId: checkpoint.checkpoint_id });
    }

    const seen = new Set([checkpoint.checkpoint_id]);
    let parentId = checkpoint.parent_checkpoint_id;
    while (parentId != null) {
      if (seen.has(parentId)) {
        return integrityFailure("checkpoint_parent_cycle", { checkpointId: checkpoint.checkpoint_id });
      }
      seen.add(parentId);
      const parent = checkpointById.get(parentId);
      if (!parent) return integrityFailure("checkpoint_parent_missing", { checkpointId: checkpoint.checkpoint_id });
      parentId = parent.parent_checkpoint_id;
    }
    if (checkpoint.lineage_kind === "root" && checkpoint.parent_checkpoint_id !== null) {
      return integrityFailure("checkpoint_parent_binding_mismatch", { checkpointId: checkpoint.checkpoint_id });
    }
    if (checkpoint.lineage_kind === "advance") {
      const parent = checkpointById.get(checkpoint.parent_checkpoint_id);
      if (!parent || parent.run_id !== checkpoint.run_id || Number(parent.event_seq) >= Number(checkpoint.event_seq)) {
        return integrityFailure("checkpoint_parent_binding_mismatch", { checkpointId: checkpoint.checkpoint_id });
      }
    }
    if (
      checkpoint.lineage_kind === "fork" &&
      checkpoint.parent_checkpoint_id !== checkpointRun.fork_checkpoint_id
    ) {
      return integrityFailure("checkpoint_parent_binding_mismatch", { checkpointId: checkpoint.checkpoint_id });
    }

    const allowedSourceRuns = new Set(lineageRunIds(db, checkpoint.run_id));
    const nodes = db.prepare(`
      SELECT * FROM governed_checkpoint_nodes WHERE checkpoint_id = ? ORDER BY node_id
    `).all(checkpoint.checkpoint_id);
    for (const node of nodes) {
      if (sha256(node.output_json) !== node.output_sha256) {
        return integrityFailure("checkpoint_output_hash_mismatch", {
          checkpointId: checkpoint.checkpoint_id,
          nodeId: node.node_id,
        });
      }
      const completionEvent = db.prepare(`
        SELECT event.* FROM governed_node_attempt_transitions transition
        JOIN governed_events event
          ON event.run_id = transition.run_id AND event.event_seq = transition.event_seq
        WHERE transition.attempt_id = ? AND transition.state = 'completed'
        ORDER BY transition.transition_no DESC LIMIT 1
      `).get(node.source_attempt_id);
      if (
        !completionEvent || completionEvent.event_type !== "NodeAttemptCompleted" ||
        completionEvent.event_hash !== node.completion_event_hash ||
        parseJson(completionEvent.payload_json)?.outputSha256 !== node.output_sha256
      ) {
        return integrityFailure("checkpoint_completion_event_binding_mismatch", {
          checkpointId: checkpoint.checkpoint_id,
          nodeId: node.node_id,
        });
      }
      const attempt = db.prepare(`
        SELECT * FROM governed_node_attempts WHERE attempt_id = ?
      `).get(node.source_attempt_id);
      if (
        !attempt || !allowedSourceRuns.has(attempt.run_id) || attempt.node_id !== node.node_id ||
        attempt.node_definition_hash !== node.node_definition_hash ||
        attempt.input_hash !== node.input_hash ||
        attempt.dependency_output_hash !== node.dependency_output_hash ||
        latestAttemptState(db, attempt.attempt_id) !== "completed"
      ) {
        return integrityFailure("checkpoint_attempt_binding_mismatch", {
          checkpointId: checkpoint.checkpoint_id,
          nodeId: node.node_id,
        });
      }
    }
  }

  for (const rootRun of rootRuns) {
    const head = db.prepare(`
      SELECT * FROM governed_run_heads WHERE run_id = ?
    `).get(rootRun.run_id);
    if (head?.head_checkpoint_id != null) {
      const headCheckpoint = checkpointById.get(head.head_checkpoint_id);
      if (!headCheckpoint || headCheckpoint.run_id !== rootRun.run_id) {
        return integrityFailure("head_checkpoint_binding_mismatch", { runId: rootRun.run_id });
      }
    }
    const terminalEvent = db.prepare(`
      SELECT payload_json FROM governed_events
      WHERE run_id = ? AND event_type = 'RunTerminalStatusSet'
      ORDER BY event_seq DESC LIMIT 1
    `).get(rootRun.run_id);
    if (
      (!terminalEvent && head.status !== "active") ||
      (terminalEvent && parseJson(terminalEvent.payload_json)?.status !== head.status)
    ) {
      return integrityFailure("run_status_event_binding_mismatch", { runId: rootRun.run_id });
    }
  }

  const checkpointEvents = db.prepare(`
    SELECT event.run_id, event.event_seq, event.event_type
    FROM governed_events event
    JOIN governed_runs governed_run ON governed_run.run_id = event.run_id
    WHERE governed_run.root_run_id = ?
      AND event.event_type IN ('NodeAttemptCompleted', 'RunForked')
  `).all(run.root_run_id);
  for (const event of checkpointEvents) {
    const projection = db.prepare(`
      SELECT checkpoint_id FROM governed_checkpoints WHERE run_id = ? AND event_seq = ?
    `).get(event.run_id, event.event_seq);
    if (!projection) {
      return integrityFailure("checkpoint_event_projection_missing", {
        runId: event.run_id,
        eventSeq: Number(event.event_seq),
      });
    }
  }

  const claims = db.prepare(`
    SELECT claim.*, attempt.fence_token AS attempt_fence_token
    FROM governed_node_claims claim
    JOIN governed_node_attempts attempt ON attempt.attempt_id = claim.attempt_id
    JOIN governed_runs governed_run ON governed_run.run_id = claim.run_id
    WHERE governed_run.root_run_id = ?
  `).all(run.root_run_id);
  for (const claim of claims) {
    const latestEvent = db.prepare(`
      SELECT event_type, payload_json FROM governed_events
      WHERE run_id = ? AND attempt_id = ?
        AND event_type IN ('NodeAttemptClaimed', 'NodeClaimHeartbeat')
      ORDER BY event_seq DESC LIMIT 1
    `).get(claim.run_id, claim.attempt_id);
    const payload = latestEvent ? parseJson(latestEvent.payload_json) : null;
    if (
      !latestEvent || payload?.ownerId !== claim.lease_owner ||
      Number(payload?.fenceToken) !== Number(claim.fence_token) ||
      Number(claim.fence_token) !== Number(claim.attempt_fence_token) ||
      Number(payload?.leaseExpiresAtMs) !== Number(claim.lease_expires_at_ms) ||
      !["claimed", "running"].includes(latestAttemptState(db, claim.attempt_id))
    ) {
      return integrityFailure("node_claim_event_binding_mismatch", { attemptId: claim.attempt_id });
    }
  }
  for (const attempt of db.prepare(`
    SELECT attempt.* FROM governed_node_attempts attempt
    JOIN governed_runs governed_run ON governed_run.run_id = attempt.run_id
    WHERE governed_run.root_run_id = ?
  `).all(run.root_run_id)) {
    const state = latestAttemptState(db, attempt.attempt_id);
    const claim = claims.find((item) => item.attempt_id === attempt.attempt_id);
    if (["claimed", "running"].includes(state) !== Boolean(claim)) {
      return integrityFailure("node_claim_event_binding_mismatch", { attemptId: attempt.attempt_id });
    }
  }

  const coordinators = db.prepare(`
    SELECT coordinator.* FROM governed_run_coordinators coordinator
    JOIN governed_runs governed_run ON governed_run.run_id = coordinator.run_id
    WHERE governed_run.root_run_id = ?
  `).all(run.root_run_id);
  for (const coordinator of coordinators) {
    const latestEvent = db.prepare(`
      SELECT event_type, payload_json FROM governed_events
      WHERE run_id = ? AND event_type IN (
        'RunCoordinatorClaimed', 'RunCoordinatorReclaimed',
        'RunCoordinatorHeartbeat', 'RunCoordinatorReleased'
      ) ORDER BY event_seq DESC LIMIT 1
    `).get(coordinator.run_id);
    const payload = latestEvent ? parseJson(latestEvent.payload_json) : null;
    const released = latestEvent?.event_type === "RunCoordinatorReleased";
    if (
      !latestEvent || Number(payload?.fenceToken) !== Number(coordinator.fence_token) ||
      (released
        ? coordinator.owner_id !== null || Number(coordinator.lease_expires_at_ms) !== 0
        : payload?.ownerId !== coordinator.owner_id ||
          Number(payload?.leaseExpiresAtMs) !== Number(coordinator.lease_expires_at_ms))
    ) {
      return integrityFailure("coordinator_event_binding_mismatch", { runId: coordinator.run_id });
    }
  }
  const coordinatorEventRuns = db.prepare(`
    SELECT DISTINCT event.run_id FROM governed_events event
    JOIN governed_runs governed_run ON governed_run.run_id = event.run_id
    WHERE governed_run.root_run_id = ? AND event.event_type IN (
      'RunCoordinatorClaimed', 'RunCoordinatorReclaimed',
      'RunCoordinatorHeartbeat', 'RunCoordinatorReleased'
    )
  `).all(run.root_run_id);
  for (const eventRun of coordinatorEventRuns) {
    if (!coordinators.some((item) => item.run_id === eventRun.run_id)) {
      return integrityFailure("coordinator_event_projection_missing", { runId: eventRun.run_id });
    }
  }

  const attemptEventTypes = new Map([
    ["claimed", "NodeAttemptClaimed"],
    ["running", "NodeAttemptRunning"],
    ["completed", "NodeAttemptCompleted"],
    ["failed", "NodeAttemptFailed"],
    ["abandoned", "NodeAttemptAbandoned"],
    ["in_doubt", "NodeAttemptInDoubt"],
  ]);
  const attempts = db.prepare(`
    SELECT attempt.* FROM governed_node_attempts attempt
    JOIN governed_runs governed_run ON governed_run.run_id = attempt.run_id
    WHERE governed_run.root_run_id = ? ORDER BY attempt.run_id, attempt.attempt_id
  `).all(run.root_run_id);
  for (const attempt of attempts) {
    const claimedTransition = db.prepare(`
      SELECT event_seq FROM governed_node_attempt_transitions
      WHERE attempt_id = ? AND transition_no = 1 AND state = 'claimed'
    `).get(attempt.attempt_id);
    const claimedEvent = claimedTransition ? db.prepare(`
      SELECT event_type, node_id, attempt_id, payload_json FROM governed_events
      WHERE run_id = ? AND event_seq = ?
    `).get(attempt.run_id, claimedTransition.event_seq) : null;
    const payload = claimedEvent ? parseJson(claimedEvent.payload_json) : null;
    if (
      !claimedEvent || claimedEvent.event_type !== "NodeAttemptClaimed" ||
      claimedEvent.node_id !== attempt.node_id || claimedEvent.attempt_id !== attempt.attempt_id ||
      Number(payload?.attemptNo) !== Number(attempt.attempt_no) ||
      Number(payload?.fenceToken) !== Number(attempt.fence_token)
    ) {
      return integrityFailure("attempt_event_binding_mismatch", { attemptId: attempt.attempt_id });
    }
  }
  const attemptTransitions = db.prepare(`
    SELECT transition.* FROM governed_node_attempt_transitions transition
    JOIN governed_runs governed_run ON governed_run.run_id = transition.run_id
    WHERE governed_run.root_run_id = ?
    ORDER BY transition.run_id, transition.attempt_id, transition.transition_no
  `).all(run.root_run_id);
  for (const transition of attemptTransitions) {
    const event = db.prepare(`
      SELECT event_type, attempt_id FROM governed_events WHERE run_id = ? AND event_seq = ?
    `).get(transition.run_id, transition.event_seq);
    if (
      !event || event.attempt_id !== transition.attempt_id ||
      event.event_type !== attemptEventTypes.get(transition.state)
    ) {
      return integrityFailure("attempt_transition_event_binding_mismatch", {
        attemptId: transition.attempt_id,
        transitionNo: Number(transition.transition_no),
      });
    }
  }

  const effectEventTypes = new Map([
    ["prepared", "EffectPrepared"],
    ["dispatch_started", "EffectDispatchStarted"],
    ["in_doubt", "EffectInDoubt"],
    ["reconciled_completed", "EffectReconciledCompleted"],
    ["reconciled_absent", "EffectReconciledAbsent"],
  ]);
  const effects = db.prepare(`
    SELECT * FROM governed_effects WHERE root_run_id = ? ORDER BY run_id, effect_id
  `).all(run.root_run_id);
  for (const effect of effects) {
    const preparedTransition = db.prepare(`
      SELECT event_seq FROM governed_effect_transitions
      WHERE effect_id = ? AND transition_no = 1 AND state = 'prepared'
    `).get(effect.effect_id);
    const preparedEvent = preparedTransition ? db.prepare(`
      SELECT event_type, node_id, attempt_id, payload_json FROM governed_events
      WHERE run_id = ? AND event_seq = ?
    `).get(effect.run_id, preparedTransition.event_seq) : null;
    const payload = preparedEvent ? parseJson(preparedEvent.payload_json) : null;
    if (
      !preparedEvent || preparedEvent.event_type !== "EffectPrepared" ||
      preparedEvent.node_id !== effect.node_id || preparedEvent.attempt_id !== effect.attempt_id ||
      payload?.effectId !== effect.effect_id || payload?.logicalEffectKey !== effect.logical_effect_key ||
      payload?.fingerprint !== effect.fingerprint || payload?.idempotencyKey !== effect.idempotency_key
    ) {
      return integrityFailure("effect_transition_event_binding_mismatch", { effectId: effect.effect_id });
    }
  }
  const effectTransitions = db.prepare(`
    SELECT transition.*, effect.attempt_id
    FROM governed_effect_transitions transition
    JOIN governed_effects effect ON effect.effect_id = transition.effect_id
    WHERE effect.root_run_id = ?
    ORDER BY transition.run_id, transition.effect_id, transition.transition_no
  `).all(run.root_run_id);
  for (const transition of effectTransitions) {
    const event = db.prepare(`
      SELECT event_type, attempt_id, payload_json FROM governed_events
      WHERE run_id = ? AND event_seq = ?
    `).get(transition.run_id, transition.event_seq);
    if (
      !event || event.attempt_id !== transition.attempt_id ||
      event.event_type !== effectEventTypes.get(transition.state) ||
      parseJson(event.payload_json)?.effectId !== transition.effect_id
    ) {
      return integrityFailure("effect_transition_event_binding_mismatch", {
        effectId: transition.effect_id,
        transitionNo: Number(transition.transition_no),
      });
    }
  }

  const reuses = db.prepare(`
    SELECT reuse.* FROM governed_effect_reuses reuse WHERE reuse.root_run_id = ?
    ORDER BY reuse.target_run_id, reuse.event_seq
  `).all(run.root_run_id);
  for (const reuse of reuses) {
    const event = db.prepare(`
      SELECT event_type, attempt_id, payload_json FROM governed_events
      WHERE run_id = ? AND event_seq = ?
    `).get(reuse.target_run_id, reuse.event_seq);
    const payload = event ? parseJson(event.payload_json) : null;
    if (
      !event || event.event_type !== "EffectReused" || event.attempt_id !== reuse.target_attempt_id ||
      payload?.effectId !== reuse.effect_id || payload?.sourceAttemptId !== reuse.source_attempt_id ||
      payload?.targetAttemptId !== reuse.target_attempt_id ||
      payload?.evidenceSha256 !== reuse.evidence_sha256 ||
      sha256(reuse.evidence_json) !== reuse.evidence_sha256
    ) {
      return integrityFailure("effect_reuse_event_binding_mismatch", { reuseId: reuse.reuse_id });
    }
  }

  const requirements = db.prepare(`
    SELECT requirement.* FROM governed_effect_reuse_requirements requirement
    WHERE requirement.root_run_id = ? ORDER BY requirement.target_run_id, requirement.required_event_seq
  `).all(run.root_run_id);
  for (const requirement of requirements) {
    const requiredEvent = db.prepare(`
      SELECT event_type, attempt_id, payload_json FROM governed_events
      WHERE run_id = ? AND event_seq = ?
    `).get(requirement.target_run_id, requirement.required_event_seq);
    const payload = requiredEvent ? parseJson(requiredEvent.payload_json) : null;
    if (
      !requiredEvent || requiredEvent.event_type !== "EffectReuseRequired" ||
      requiredEvent.attempt_id !== requirement.target_attempt_id ||
      payload?.effectId !== requirement.effect_id ||
      payload?.targetAttemptId !== requirement.target_attempt_id
    ) {
      return integrityFailure("effect_reuse_requirement_event_binding_mismatch", {
        requirementId: requirement.requirement_id,
      });
    }
    if (requirement.status === "satisfied") {
      const reuse = reuses.find((item) =>
        item.effect_id === requirement.effect_id && item.target_attempt_id === requirement.target_attempt_id
      );
      if (!reuse || Number(reuse.event_seq) !== Number(requirement.satisfied_event_seq)) {
        return integrityFailure("effect_reuse_requirement_satisfaction_mismatch", {
          requirementId: requirement.requirement_id,
        });
      }
    }
  }
  const reuseProjectionEvents = db.prepare(`
    SELECT event.run_id, event.event_seq, event.event_type, event.payload_json
    FROM governed_events event
    JOIN governed_runs governed_run ON governed_run.run_id = event.run_id
    WHERE governed_run.root_run_id = ?
      AND event.event_type IN ('EffectReuseRequired', 'EffectReused')
  `).all(run.root_run_id);
  for (const event of reuseProjectionEvents) {
    const payload = parseJson(event.payload_json);
    const projection = event.event_type === "EffectReuseRequired"
      ? requirements.find((item) =>
          item.effect_id === payload?.effectId &&
          item.target_attempt_id === payload?.targetAttemptId &&
          Number(item.required_event_seq) === Number(event.event_seq)
        )
      : reuses.find((item) =>
          item.effect_id === payload?.effectId &&
          item.target_attempt_id === payload?.targetAttemptId &&
          Number(item.event_seq) === Number(event.event_seq)
        );
    if (!projection) {
      return integrityFailure("effect_reuse_event_projection_missing", {
        runId: event.run_id,
        eventSeq: Number(event.event_seq),
      });
    }
  }

  const traversals = db.prepare(`
    SELECT traversal.* FROM governed_edge_traversals traversal
    JOIN governed_runs governed_run ON governed_run.run_id = traversal.run_id
    WHERE governed_run.root_run_id = ? ORDER BY traversal.run_id, traversal.event_seq
  `).all(run.root_run_id);
  for (const traversal of traversals) {
    const event = db.prepare(`
      SELECT event_type, attempt_id, payload_json FROM governed_events
      WHERE run_id = ? AND event_seq = ?
    `).get(traversal.run_id, traversal.event_seq);
    const payload = event ? parseJson(event.payload_json) : null;
    if (
      !event || event.event_type !== "EdgeTraversed" || event.attempt_id !== traversal.attempt_id ||
      payload?.traversalId !== traversal.traversal_id ||
      payload?.fromNodeId !== traversal.from_node_id || payload?.toNodeId !== traversal.to_node_id ||
      payload?.conditionDigest !== traversal.condition_digest
    ) {
      return integrityFailure("edge_traversal_event_binding_mismatch", {
        traversalId: traversal.traversal_id,
      });
    }
  }

  return { ok: true, eventCount: events.length, headHash: previousEventHash };
}

function completedNodesAtCheckpoint(db, checkpointId) {
  if (!checkpointId) return [];
  return db.prepare(`
    SELECT * FROM governed_checkpoint_nodes
    WHERE checkpoint_id = ? ORDER BY node_id
  `).all(checkpointId).map((row) => ({
    nodeId: row.node_id,
    sourceAttemptId: row.source_attempt_id,
    nodeDefinitionHash: row.node_definition_hash,
    inputHash: row.input_hash,
    dependencyOutputHash: row.dependency_output_hash,
    output: parseJson(row.output_json),
    outputSha256: row.output_sha256,
    completionEventHash: row.completion_event_hash,
  }));
}

function assertMutationIntegrity(db, runId) {
  const integrity = verifyDurableRunIntegrity(db, runId);
  if (!integrity.ok) {
    throw new Error(`Durable run integrity blocks mutation: ${integrity.reason}`);
  }
}

export async function openSqliteDurableRunRepository(dbPath = ":memory:", { enableTestHooks = false } = {}) {
  if (dbPath !== ":memory:") await fs.mkdir(path.dirname(path.resolve(dbPath)), { recursive: true });
  const DatabaseSync = await importDatabaseSync();
  const db = new DatabaseSync(dbPath);
  try {
    initializeSchema(db);
  } catch (error) {
    db.close();
    throw error;
  }
  let closed = false;

  const api = {
    createRun({ runId, graphDigest, taskFingerprint, nowMs = Date.now() }) {
      requiredString(runId, "runId");
      requiredString(graphDigest, "graphDigest");
      requiredString(taskFingerprint, "taskFingerprint");
      return withSqliteTransaction(db, () => {
        if (runRow(db, runId)) throw new Error(`Governed run already exists: ${runId}`);
        const createdAt = timestamp(nowMs);
        db.prepare(`
          INSERT INTO governed_runs(
            run_id, root_run_id, parent_run_id, fork_checkpoint_id,
            graph_digest, task_fingerprint, created_at
          ) VALUES (?, ?, NULL, NULL, ?, ?, ?)
        `).run(runId, runId, graphDigest, taskFingerprint, createdAt);
        db.prepare(`
          INSERT INTO governed_run_heads(run_id, status, next_event_seq, version, updated_at)
          VALUES (?, 'active', 1, 0, ?)
        `).run(runId, createdAt);
        const event = appendEventInTransaction(db, {
          runId,
          eventId: `${runId}:run-created`,
          eventType: "RunCreated",
          payload: { graphDigest, taskFingerprint },
          createdAt,
        });
        return {
          runId,
          rootRunId: runId,
          parentRunId: null,
          graphDigest,
          taskFingerprint,
          cursor: event.eventSeq,
          headCheckpointId: null,
          createdAt,
        };
      });
    },

    forkRun({
      runId,
      parentRunId,
      fromCheckpointId,
      graphDigest,
      taskFingerprint,
      nowMs = Date.now(),
    }) {
      requiredString(runId, "runId");
      requiredString(parentRunId, "parentRunId");
      requiredString(fromCheckpointId, "fromCheckpointId");
      return withSqliteTransaction(db, () => {
        if (runRow(db, runId)) throw new Error(`Governed run already exists: ${runId}`);
        assertMutationIntegrity(db, parentRunId);
        const parent = assertRunBinding(db, { parentRunId, runId: parentRunId, graphDigest, taskFingerprint });
        const source = db.prepare(
          "SELECT * FROM governed_checkpoints WHERE checkpoint_id = ? AND run_id = ?",
        ).get(fromCheckpointId, parentRunId);
        if (!source) throw new Error("Fork checkpoint must belong to the exact parent run");
        const createdAt = timestamp(nowMs);
        db.prepare(`
          INSERT INTO governed_runs(
            run_id, root_run_id, parent_run_id, fork_checkpoint_id,
            graph_digest, task_fingerprint, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          runId,
          parent.root_run_id,
          parentRunId,
          fromCheckpointId,
          graphDigest,
          taskFingerprint,
          createdAt,
        );
        db.prepare(`
          INSERT INTO governed_run_heads(run_id, status, next_event_seq, version, updated_at)
          VALUES (?, 'active', 1, 0, ?)
        `).run(runId, createdAt);
        const event = appendEventInTransaction(db, {
          runId,
          eventId: `${runId}:run-forked`,
          eventType: "RunForked",
          payload: { parentRunId, fromCheckpointId, graphDigest, taskFingerprint },
          createdAt,
        });
        const checkpointId = `${runId}:checkpoint:${event.eventSeq}`;
        const state = {
          forkedFromCheckpointId: fromCheckpointId,
          inheritedCompletedNodeIds: completedNodesAtCheckpoint(db, fromCheckpointId).map((node) => node.nodeId),
        };
        const stateJson = canonicalJson(state);
        db.prepare(`
          INSERT INTO governed_checkpoints(
            checkpoint_id, run_id, parent_checkpoint_id, lineage_kind, event_seq,
            graph_digest, state_json, state_sha256, created_at
          ) VALUES (?, ?, ?, 'fork', ?, ?, ?, ?, ?)
        `).run(
          checkpointId,
          runId,
          fromCheckpointId,
          event.eventSeq,
          graphDigest,
          stateJson,
          sha256(stateJson),
          createdAt,
        );
        db.prepare(`
          INSERT INTO governed_checkpoint_nodes(
            checkpoint_id, node_id, source_attempt_id, node_definition_hash,
            input_hash, dependency_output_hash, output_json, output_sha256, completion_event_hash
          )
          SELECT ?, node_id, source_attempt_id, node_definition_hash,
            input_hash, dependency_output_hash, output_json, output_sha256, completion_event_hash
          FROM governed_checkpoint_nodes WHERE checkpoint_id = ?
        `).run(checkpointId, fromCheckpointId);
        db.prepare(`
          UPDATE governed_run_heads SET head_checkpoint_id = ?, updated_at = ? WHERE run_id = ?
        `).run(checkpointId, createdAt, runId);
        return {
          runId,
          rootRunId: parent.root_run_id,
          parentRunId,
          graphDigest,
          taskFingerprint,
          cursor: event.eventSeq,
          headCheckpointId: checkpointId,
          createdAt,
        };
      });
    },

    appendEvent(event) {
      return withSqliteTransaction(db, () => {
        assertMutationIntegrity(db, event?.runId);
        assertActiveRun(db, event?.runId);
        return appendEventInTransaction(db, event);
      });
    },

    claimRunCoordinator({ runId, ownerId, leaseMs, nowMs = Date.now() }) {
      requiredString(runId, "runId");
      requiredString(ownerId, "ownerId");
      positiveInteger(leaseMs, "leaseMs");
      return withSqliteTransaction(db, () => {
        assertMutationIntegrity(db, runId);
        assertRunBinding(db, { runId });
        const current = db.prepare(
          "SELECT * FROM governed_run_coordinators WHERE run_id = ?",
        ).get(runId);
        if (
          current?.owner_id != null &&
          Number(current.lease_expires_at_ms) > nowMs
        ) {
          throw new Error(`Run coordinator lease is already claimed by ${current.owner_id}`);
        }
        const fenceToken = current ? Number(current.fence_token) + 1 : 1;
        const createdAt = timestamp(nowMs);
        const event = appendEventInTransaction(db, {
          runId,
          eventId: `${runId}:coordinator:${fenceToken}:claimed`,
          eventType: current ? "RunCoordinatorReclaimed" : "RunCoordinatorClaimed",
          payload: {
            ownerId,
            fenceToken,
            leaseExpiresAtMs: nowMs + leaseMs,
            previousOwnerId: current?.owner_id ?? null,
            previousLeaseExpired: current != null,
          },
          createdAt,
        });
        if (!current) {
          db.prepare(`
            INSERT INTO governed_run_coordinators(
              run_id, owner_id, fence_token, lease_expires_at_ms, updated_at
            ) VALUES (?, ?, ?, ?, ?)
          `).run(runId, ownerId, fenceToken, nowMs + leaseMs, createdAt);
        } else {
          const claimed = db.prepare(`
            UPDATE governed_run_coordinators
            SET owner_id = ?, fence_token = ?, lease_expires_at_ms = ?, updated_at = ?
            WHERE run_id = ? AND fence_token = ?
          `).run(
            ownerId,
            fenceToken,
            nowMs + leaseMs,
            createdAt,
            runId,
            current.fence_token,
          );
          if (Number(claimed.changes) !== 1) {
            throw new Error("Run coordinator fence CAS was lost");
          }
        }
        return {
          runId,
          ownerId,
          fenceToken,
          leaseExpiresAtMs: nowMs + leaseMs,
          eventSeq: event.eventSeq,
        };
      });
    },

    heartbeatRunCoordinator({
      runId,
      ownerId,
      fenceToken,
      leaseMs,
      nowMs = Date.now(),
    }) {
      requiredString(runId, "runId");
      requiredString(ownerId, "ownerId");
      positiveInteger(fenceToken, "fenceToken");
      positiveInteger(leaseMs, "leaseMs");
      return withSqliteTransaction(db, () => {
        assertMutationIntegrity(db, runId);
        const current = db.prepare(`
          SELECT * FROM governed_run_coordinators
          WHERE run_id = ? AND owner_id = ? AND fence_token = ? AND lease_expires_at_ms > ?
        `).get(runId, ownerId, fenceToken, nowMs);
        if (!current) throw new Error("Stale coordinator fence cannot heartbeat or revive an expired lease");
        const updatedAt = timestamp(nowMs);
        const event = appendEventInTransaction(db, {
          runId,
          eventId: `${runId}:coordinator:${fenceToken}:heartbeat:${nowMs}`,
          eventType: "RunCoordinatorHeartbeat",
          payload: { ownerId, fenceToken, leaseExpiresAtMs: nowMs + leaseMs },
          writerId: ownerId,
          createdAt: updatedAt,
        });
        const heartbeat = db.prepare(`
          UPDATE governed_run_coordinators
          SET lease_expires_at_ms = ?, updated_at = ?
          WHERE run_id = ? AND owner_id = ? AND fence_token = ?
            AND lease_expires_at_ms > ?
        `).run(nowMs + leaseMs, updatedAt, runId, ownerId, fenceToken, nowMs);
        if (Number(heartbeat.changes) !== 1) {
          throw new Error("Stale coordinator fence cannot heartbeat or revive an expired lease");
        }
        return { runId, ownerId, fenceToken, leaseExpiresAtMs: nowMs + leaseMs, eventSeq: event.eventSeq };
      });
    },

    releaseRunCoordinator({ runId, ownerId, fenceToken, nowMs = Date.now() }) {
      requiredString(runId, "runId");
      requiredString(ownerId, "ownerId");
      positiveInteger(fenceToken, "fenceToken");
      return withSqliteTransaction(db, () => {
        assertMutationIntegrity(db, runId);
        const current = db.prepare(`
          SELECT * FROM governed_run_coordinators
          WHERE run_id = ? AND owner_id = ? AND fence_token = ?
            AND lease_expires_at_ms > ?
        `).get(runId, ownerId, fenceToken, nowMs);
        if (!current) throw new Error("Stale coordinator fence cannot release run coordinator");
        const createdAt = timestamp(nowMs);
        const event = appendEventInTransaction(db, {
          runId,
          eventId: `${runId}:coordinator:${fenceToken}:released`,
          eventType: "RunCoordinatorReleased",
          payload: { ownerId, fenceToken },
          createdAt,
        });
        const released = db.prepare(`
          UPDATE governed_run_coordinators
          SET owner_id = NULL, lease_expires_at_ms = 0, updated_at = ?
          WHERE run_id = ? AND owner_id = ? AND fence_token = ?
        `).run(createdAt, runId, ownerId, fenceToken);
        if (Number(released.changes) !== 1) {
          throw new Error("Stale coordinator fence cannot release run coordinator");
        }
        return { released: true, runId, ownerId, fenceToken, eventSeq: event.eventSeq };
      });
    },

    setRunTerminalStatus({ runId, status, ownerId, fenceToken, nowMs = Date.now() }) {
      requiredString(runId, "runId");
      requiredString(ownerId, "ownerId");
      positiveInteger(fenceToken, "fenceToken");
      if (!["completed", "failed", "blocked"].includes(status)) {
        throw new TypeError("Terminal run status must be completed, failed, or blocked");
      }
      return withSqliteTransaction(db, () => {
        assertMutationIntegrity(db, runId);
        const run = assertRunBinding(db, { runId });
        if (run.status !== "active") {
          throw new Error(`Run is already terminal with status ${run.status}`);
        }
        const coordinator = db.prepare(`
          SELECT * FROM governed_run_coordinators
          WHERE run_id = ? AND owner_id = ? AND fence_token = ?
            AND lease_expires_at_ms > ?
        `).get(runId, ownerId, fenceToken, nowMs);
        if (!coordinator) {
          throw new Error("Live run coordinator owner and fence are required to set terminal status");
        }
        const activeClaim = db.prepare(`
          SELECT node_id, attempt_id FROM governed_node_claims
          WHERE run_id = ? ORDER BY node_id LIMIT 1
        `).get(runId);
        if (activeClaim) {
          throw new Error(`Run terminal status is blocked by active node claim ${activeClaim.attempt_id}`);
        }
        const blockingEffect = blockingEffectsForRoot(db, run.root_run_id)[0];
        if (blockingEffect) {
          throw new Error(`Run terminal status is blocked by unresolved effect ${blockingEffect.effectId}`);
        }
        const createdAt = timestamp(nowMs);
        const event = appendEventInTransaction(db, {
          runId,
          eventId: `${runId}:terminal:${status}`,
          eventType: "RunTerminalStatusSet",
          payload: { status, ownerId, fenceToken },
          writerId: ownerId,
          createdAt,
        });
        const updated = db.prepare(`
          UPDATE governed_run_heads SET status = ?, updated_at = ?
          WHERE run_id = ? AND status = 'active'
        `).run(status, createdAt, runId);
        if (Number(updated.changes) !== 1) {
          throw new Error("Run terminal status CAS was lost");
        }
        return { runId, status, ownerId, fenceToken, eventSeq: event.eventSeq };
      });
    },

    getEvents(runId) {
      return db.prepare("SELECT * FROM governed_events WHERE run_id = ? ORDER BY event_seq")
        .all(runId).map(normalizeEventRow);
    },

    verifyEventChain(runId) {
      return verifyDurableRunIntegrity(db, runId);
    },

    claimNode({
      runId,
      nodeId,
      nodeDefinitionHash,
      inputHash,
      dependencyOutputHash,
      ownerId,
      leaseMs,
      nowMs = Date.now(),
    }) {
      for (const [value, label] of [
        [runId, "runId"], [nodeId, "nodeId"], [nodeDefinitionHash, "nodeDefinitionHash"],
        [inputHash, "inputHash"], [dependencyOutputHash, "dependencyOutputHash"], [ownerId, "ownerId"],
      ]) requiredString(value, label);
      positiveInteger(leaseMs, "leaseMs");
      return withSqliteTransaction(db, () => {
        assertMutationIntegrity(db, runId);
        const run = assertRunBinding(db, { runId });
        if (run.status !== "active") {
          throw new Error(`Cannot claim node on terminal run ${runId} with status ${run.status}`);
        }
        const completed = completedNodesAtCheckpoint(db, run.head_checkpoint_id)
          .find((node) => node.nodeId === nodeId);
        if (completed) throw new Error(`Node is already completed at the current checkpoint: ${nodeId}`);
        const existingClaim = db.prepare(`
          SELECT * FROM governed_node_claims WHERE run_id = ? AND node_id = ?
        `).get(runId, nodeId);
        let fenceToken = Number(db.prepare(`
          SELECT COALESCE(MAX(fence_token), 0) + 1 AS fence_token
          FROM governed_node_attempts WHERE run_id = ? AND node_id = ?
        `).get(runId, nodeId).fence_token);
        if (existingClaim) {
          if (Number(existingClaim.lease_expires_at_ms) > nowMs) {
            throw new Error(`Node lease is already claimed by ${existingClaim.lease_owner}`);
          }
          const blocking = blockingEffectsForAttempt(db, existingClaim.attempt_id);
          if (blocking.length > 0) {
            throw new Error(`Expired attempt has unresolved effect state ${blocking[0].state}; reconciliation required`);
          }
          const previousState = latestAttemptState(db, existingClaim.attempt_id);
          if (!TERMINAL_ATTEMPT_STATES.has(previousState)) {
            const abandonedAt = timestamp(nowMs);
            const event = appendEventInTransaction(db, {
              runId,
              eventId: `${existingClaim.attempt_id}:abandoned`,
              eventType: "NodeAttemptAbandoned",
              nodeId,
              attemptId: existingClaim.attempt_id,
              payload: { previousFenceToken: Number(existingClaim.fence_token) },
              createdAt: abandonedAt,
            });
            addAttemptTransition(db, {
              attemptId: existingClaim.attempt_id,
              runId,
              state: "abandoned",
              eventSeq: event.eventSeq,
              detail: { reason: "lease_expired" },
              createdAt: abandonedAt,
            });
          }
        }
        const attemptNo = Number(db.prepare(`
          SELECT COALESCE(MAX(attempt_no), 0) + 1 AS attempt_no
          FROM governed_node_attempts WHERE run_id = ? AND node_id = ?
        `).get(runId, nodeId).attempt_no);
        const attemptId = `${runId}:${sha256(nodeId).slice(0, 16)}:attempt:${attemptNo}`;
        const createdAt = timestamp(nowMs);
        db.prepare(`
          INSERT INTO governed_node_attempts(
            attempt_id, run_id, node_id, attempt_no, fence_token,
            node_definition_hash, input_hash, dependency_output_hash,
            attempt_kind, reused_from_attempt_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'execute', NULL, ?)
        `).run(
          attemptId,
          runId,
          nodeId,
          attemptNo,
          fenceToken,
          nodeDefinitionHash,
          inputHash,
          dependencyOutputHash,
          createdAt,
        );
        const event = appendEventInTransaction(db, {
          runId,
          eventId: `${attemptId}:claimed`,
          eventType: "NodeAttemptClaimed",
          nodeId,
          attemptId,
          payload: { attemptNo, fenceToken, ownerId, leaseExpiresAtMs: nowMs + leaseMs },
          createdAt,
        });
        addAttemptTransition(db, {
          attemptId,
          runId,
          state: "claimed",
          eventSeq: event.eventSeq,
          detail: { ownerId, fenceToken },
          createdAt,
        });
        db.prepare(`
          INSERT INTO governed_node_claims(
            run_id, node_id, attempt_id, fence_token, lease_owner, lease_expires_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id, node_id) DO UPDATE SET
            attempt_id = excluded.attempt_id,
            fence_token = excluded.fence_token,
            lease_owner = excluded.lease_owner,
            lease_expires_at_ms = excluded.lease_expires_at_ms
        `).run(runId, nodeId, attemptId, fenceToken, ownerId, nowMs + leaseMs);
        return {
          attemptId,
          runId,
          nodeId,
          attemptNo,
          fenceToken,
          leaseOwner: ownerId,
          leaseExpiresAtMs: nowMs + leaseMs,
          status: "claimed",
        };
      });
    },

    heartbeatNode({ runId, nodeId, attemptId, fenceToken, ownerId, leaseMs, nowMs = Date.now() }) {
      for (const [value, label] of [
        [runId, "runId"], [nodeId, "nodeId"], [attemptId, "attemptId"], [ownerId, "ownerId"],
      ]) requiredString(value, label);
      positiveInteger(fenceToken, "fenceToken");
      positiveInteger(leaseMs, "leaseMs");
      return withSqliteTransaction(db, () => {
        assertMutationIntegrity(db, runId);
        assertActiveRun(db, runId);
        requireActiveNodeClaim(db, {
          runId, nodeId, attemptId, fenceToken, ownerId, nowMs,
        });
        const createdAt = timestamp(nowMs);
        const event = appendEventInTransaction(db, {
          runId,
          eventId: `${attemptId}:heartbeat:${nowMs}`,
          eventType: "NodeClaimHeartbeat",
          nodeId,
          attemptId,
          payload: { ownerId, fenceToken, leaseExpiresAtMs: nowMs + leaseMs },
          writerId: ownerId,
          createdAt,
        });
        const result = db.prepare(`
          UPDATE governed_node_claims SET lease_expires_at_ms = ?
          WHERE run_id = ? AND node_id = ? AND attempt_id = ?
            AND fence_token = ? AND lease_owner = ? AND lease_expires_at_ms > ?
        `).run(nowMs + leaseMs, runId, nodeId, attemptId, fenceToken, ownerId, nowMs);
        if (Number(result.changes) !== 1) throw new Error("Stale fence cannot heartbeat node claim");
        return { leaseExpiresAtMs: nowMs + leaseMs, eventSeq: event.eventSeq };
      });
    },

    completeNode({
      runId,
      nodeId,
      attemptId,
      fenceToken,
      ownerId,
      output,
      traversedEdges = [],
      nowMs = Date.now(),
    }, { onWriteStep = null } = {}) {
      if (!Array.isArray(traversedEdges)) throw new TypeError("traversedEdges must be an array");
      return withSqliteTransaction(db, () => {
        assertMutationIntegrity(db, runId);
        const run = assertActiveRun(db, runId);
        requireActiveNodeClaim(db, {
          runId, nodeId, attemptId, fenceToken, ownerId, nowMs,
        });
        const pendingReuse = db.prepare(`
          SELECT requirement_id FROM governed_effect_reuse_requirements
          WHERE target_attempt_id = ? AND status = 'pending'
          ORDER BY requirement_id LIMIT 1
        `).get(attemptId);
        if (pendingReuse) {
          throw new Error(`Node completion blocked by pending reuse requirement ${pendingReuse.requirement_id}`);
        }
        const blockingEffects = blockingEffectsForRoot(db, run.root_run_id);
        if (blockingEffects.length > 0) {
          throw new Error(`Node completion blocked by effect ${blockingEffects[0].effectId} in ${blockingEffects[0].state}`);
        }
        const attempt = db.prepare("SELECT * FROM governed_node_attempts WHERE attempt_id = ?").get(attemptId);
        if (!attempt || attempt.run_id !== runId || attempt.node_id !== nodeId) {
          throw new Error("Attempt binding does not match node completion");
        }
        const createdAt = timestamp(nowMs);
        const outputJson = canonicalJson(output);
        const outputSha256 = sha256(outputJson);
        const event = appendEventInTransaction(db, {
          runId,
          eventId: `${attemptId}:completed`,
          eventType: "NodeAttemptCompleted",
          nodeId,
          attemptId,
          payload: { outputSha256, fenceToken },
          createdAt,
        });
        addAttemptTransition(db, {
          attemptId,
          runId,
          state: "completed",
          eventSeq: event.eventSeq,
          detail: { outputSha256 },
          createdAt,
        });
        onWriteStep?.("transition");
        const checkpointId = `${runId}:checkpoint:${event.eventSeq}`;
        const stateValue = {
          completedNodeId: nodeId,
          sourceAttemptId: attemptId,
          outputSha256,
          eventSeq: event.eventSeq,
        };
        const stateJson = canonicalJson(stateValue);
        db.prepare(`
          INSERT INTO governed_checkpoints(
            checkpoint_id, run_id, parent_checkpoint_id, lineage_kind, event_seq,
            graph_digest, state_json, state_sha256, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          checkpointId,
          runId,
          run.head_checkpoint_id,
          run.head_checkpoint_id ? "advance" : "root",
          event.eventSeq,
          run.graph_digest,
          stateJson,
          sha256(stateJson),
          createdAt,
        );
        if (run.head_checkpoint_id) {
          db.prepare(`
            INSERT INTO governed_checkpoint_nodes(
              checkpoint_id, node_id, source_attempt_id, node_definition_hash,
              input_hash, dependency_output_hash, output_json, output_sha256, completion_event_hash
            )
            SELECT ?, node_id, source_attempt_id, node_definition_hash,
              input_hash, dependency_output_hash, output_json, output_sha256, completion_event_hash
            FROM governed_checkpoint_nodes WHERE checkpoint_id = ?
          `).run(checkpointId, run.head_checkpoint_id);
        }
        db.prepare(`
          INSERT INTO governed_checkpoint_nodes(
            checkpoint_id, node_id, source_attempt_id, node_definition_hash,
            input_hash, dependency_output_hash, output_json, output_sha256, completion_event_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          checkpointId,
          nodeId,
          attemptId,
          attempt.node_definition_hash,
          attempt.input_hash,
          attempt.dependency_output_hash,
          outputJson,
          outputSha256,
          event.eventHash,
        );
        onWriteStep?.("checkpoint");
        for (const edge of traversedEdges) {
          for (const [value, label] of [
            [edge?.traversalId, "traversedEdges.traversalId"],
            [edge?.fromNodeId, "traversedEdges.fromNodeId"],
            [edge?.toNodeId, "traversedEdges.toNodeId"],
            [edge?.conditionDigest, "traversedEdges.conditionDigest"],
          ]) requiredString(value, label);
          const edgeEvent = appendEventInTransaction(db, {
            runId,
            eventId: `${edge.traversalId}:edge-traversed`,
            eventType: "EdgeTraversed",
            nodeId: edge.toNodeId,
            attemptId,
            payload: {
              traversalId: edge.traversalId,
              fromNodeId: edge.fromNodeId,
              toNodeId: edge.toNodeId,
              conditionDigest: edge.conditionDigest,
            },
            createdAt,
          });
          db.prepare(`
            INSERT INTO governed_edge_traversals(
              traversal_id, run_id, from_node_id, to_node_id,
              attempt_id, condition_digest, event_seq, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            edge.traversalId,
            runId,
            edge.fromNodeId,
            edge.toNodeId,
            attemptId,
            edge.conditionDigest,
            edgeEvent.eventSeq,
            createdAt,
          );
        }
        onWriteStep?.("edges");
        const head = db.prepare(`
          UPDATE governed_run_heads SET head_checkpoint_id = ?, updated_at = ? WHERE run_id = ?
        `).run(checkpointId, createdAt, runId);
        if (Number(head.changes) !== 1) throw new Error("Run head disappeared during terminal commit");
        const released = db.prepare(`
          DELETE FROM governed_node_claims
          WHERE run_id = ? AND node_id = ? AND attempt_id = ? AND fence_token = ?
        `).run(runId, nodeId, attemptId, fenceToken);
        if (Number(released.changes) !== 1) throw new Error("Stale fence cannot release node claim");
        onWriteStep?.("head");
        return { status: "completed", attemptId, outputSha256, checkpointId, eventSeq: event.eventSeq };
      });
    },

    failNode({ runId, nodeId, attemptId, fenceToken, ownerId, failure, nowMs = Date.now() }) {
      return withSqliteTransaction(db, () => {
        assertMutationIntegrity(db, runId);
        assertActiveRun(db, runId);
        requireActiveNodeClaim(db, {
          runId, nodeId, attemptId, fenceToken, ownerId, nowMs,
        });
        const blockingEffects = blockingEffectsForAttempt(db, attemptId);
        const terminalState = blockingEffects.length > 0 ? "in_doubt" : "failed";
        const createdAt = timestamp(nowMs);
        const event = appendEventInTransaction(db, {
          runId,
          eventId: `${attemptId}:${terminalState}`,
          eventType: terminalState === "in_doubt" ? "NodeAttemptInDoubt" : "NodeAttemptFailed",
          nodeId,
          attemptId,
          payload: { failure, blockingEffectIds: blockingEffects.map((effect) => effect.effectId) },
          createdAt,
        });
        addAttemptTransition(db, {
          attemptId,
          runId,
          state: terminalState,
          eventSeq: event.eventSeq,
          detail: { failure },
          createdAt,
        });
        db.prepare(`
          DELETE FROM governed_node_claims
          WHERE run_id = ? AND node_id = ? AND attempt_id = ? AND fence_token = ?
        `).run(runId, nodeId, attemptId, fenceToken);
        return { status: terminalState, attemptId, eventSeq: event.eventSeq };
      });
    },

    resumeRun({ runId, graphDigest, taskFingerprint }) {
      const run = assertRunBinding(db, { runId, graphDigest, taskFingerprint });
      const integrity = verifyDurableRunIntegrity(db, runId);
      if (!integrity.ok) {
        throw new Error(`Durable run integrity verification failed: ${integrity.reason}`);
      }
      const completedNodes = completedNodesAtCheckpoint(db, run.head_checkpoint_id);
      const blockingEffects = blockingEffectsForRoot(db, run.root_run_id);
      const activeClaims = db.prepare(`
        SELECT run_id, node_id, attempt_id, fence_token, lease_owner, lease_expires_at_ms
        FROM governed_node_claims WHERE run_id = ? ORDER BY node_id
      `).all(runId).map((claim) => ({
        runId: claim.run_id,
        nodeId: claim.node_id,
        attemptId: claim.attempt_id,
        fenceToken: Number(claim.fence_token),
        leaseOwner: claim.lease_owner,
        leaseExpiresAtMs: Number(claim.lease_expires_at_ms),
      }));
      const result = {
        runId,
        rootRunId: run.root_run_id,
        parentRunId: run.parent_run_id,
        cursor: Number(run.next_event_seq) - 1,
        headCheckpointId: run.head_checkpoint_id,
        completedNodes,
        completedNodeIds: completedNodes.map((node) => node.nodeId),
        blockingEffects,
        activeClaims,
        status: run.status,
        resumable: run.status === "active" && blockingEffects.length === 0,
      };
      durableResumeAttestations.set(result, attestationDigest(result));
      return result;
    },

    prepareEffect({
      effectId,
      runId,
      nodeId,
      attemptId,
      logicalEffectKey,
      fingerprint,
      idempotencyKey,
      providerBinding,
      fenceToken,
      ownerId,
      nowMs = Date.now(),
    }) {
      for (const [value, label] of [
        [effectId, "effectId"], [runId, "runId"], [nodeId, "nodeId"], [attemptId, "attemptId"],
        [logicalEffectKey, "logicalEffectKey"], [fingerprint, "fingerprint"], [idempotencyKey, "idempotencyKey"],
      ]) requiredString(value, label);
      const prepared = withSqliteTransaction(db, () => {
        assertMutationIntegrity(db, runId);
        const run = assertActiveRun(db, runId);
        requireActiveNodeClaim(db, {
          runId, nodeId, attemptId, fenceToken, ownerId, nowMs,
        });
        const attempt = db.prepare("SELECT * FROM governed_node_attempts WHERE attempt_id = ?").get(attemptId);
        if (!attempt || attempt.run_id !== runId || attempt.node_id !== nodeId) {
          throw new Error("Effect attempt binding mismatch");
        }
        const existing = db.prepare(`
          SELECT effect_id FROM governed_effects
          WHERE root_run_id = ? AND logical_effect_key = ?
        `).get(run.root_run_id, logicalEffectKey);
        if (existing) {
          const current = effectView(db, existing.effect_id);
          if (
            current.fingerprint !== fingerprint ||
            current.idempotencyKey !== idempotencyKey ||
            canonicalJson(current.providerBinding) !== canonicalJson(providerBinding)
          ) {
            throw new Error("Logical effect idempotency conflict has a different fingerprint or binding");
          }
          if (
            current.effectId !== effectId || current.runId !== runId ||
            current.nodeId !== nodeId || current.attemptId !== attemptId
          ) {
            if (current.state !== "reconciled_completed") {
              throw new Error("Logical effect belongs to a different attempt; explicit reuse evidence is required");
            }
            const requirementId = `${current.effectId}:reuse-required:${attemptId}`;
            let requirement = db.prepare(`
              SELECT * FROM governed_effect_reuse_requirements
              WHERE effect_id = ? AND target_attempt_id = ?
            `).get(current.effectId, attemptId);
            if (!requirement) {
              const createdAt = timestamp(nowMs);
              const event = appendEventInTransaction(db, {
                runId,
                eventId: requirementId,
                eventType: "EffectReuseRequired",
                nodeId,
                attemptId,
                payload: {
                  effectId: current.effectId,
                  sourceAttemptId: current.attemptId,
                  targetAttemptId: attemptId,
                  logicalEffectKey,
                },
                createdAt,
              });
              db.prepare(`
                INSERT INTO governed_effect_reuse_requirements(
                  requirement_id, effect_id, root_run_id, target_run_id,
                  target_node_id, target_attempt_id, status,
                  required_event_seq, satisfied_event_seq, created_at, satisfied_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, NULL)
              `).run(
                requirementId,
                current.effectId,
                current.rootRunId,
                runId,
                nodeId,
                attemptId,
                event.eventSeq,
                createdAt,
              );
              requirement = db.prepare(`
                SELECT * FROM governed_effect_reuse_requirements WHERE requirement_id = ?
              `).get(requirementId);
            }
            return {
              reuseRequirementPending: true,
              requirementId: requirement.requirement_id,
              effectId: current.effectId,
              targetAttemptId: attemptId,
            };
          }
          return current;
        }
        const createdAt = timestamp(nowMs);
        db.prepare(`
          INSERT INTO governed_effects(
            effect_id, run_id, root_run_id, node_id, attempt_id,
            logical_effect_key, fingerprint, idempotency_key, provider_binding_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          effectId,
          runId,
          run.root_run_id,
          nodeId,
          attemptId,
          logicalEffectKey,
          fingerprint,
          idempotencyKey,
          canonicalJson(providerBinding),
          createdAt,
        );
        const event = appendEventInTransaction(db, {
          runId,
          eventId: `${effectId}:prepared`,
          eventType: "EffectPrepared",
          nodeId,
          attemptId,
          payload: { effectId, logicalEffectKey, fingerprint, idempotencyKey },
          createdAt,
        });
        addEffectTransition(db, {
          effectId,
          runId,
          state: "prepared",
          eventSeq: event.eventSeq,
          detail: { firstSliceExternalExecution: false },
          createdAt,
        });
        return effectView(db, effectId);
      });
      if (prepared?.reuseRequirementPending) {
        throw new Error(
          `Logical effect belongs to a different attempt; explicit reuse requirement ${prepared.requirementId} is pending`,
        );
      }
      return prepared;
    },

    markEffectDispatchStarted({
      effectId,
      attemptId,
      fenceToken,
      ownerId,
      nowMs = Date.now(),
    }) {
      return withSqliteTransaction(db, () => {
        const effect = effectView(db, effectId);
        if (!effect) throw new Error(`Unknown effect: ${effectId}`);
        assertMutationIntegrity(db, effect.runId);
        assertActiveRun(db, effect.runId);
        if (effect.attemptId !== attemptId) throw new Error("Effect attempt binding mismatch");
        requireActiveNodeClaim(db, {
          runId: effect.runId,
          nodeId: effect.nodeId,
          attemptId,
          fenceToken,
          ownerId,
          nowMs,
        });
        if (effect.state !== "prepared") {
          throw new Error(`Effect dispatch can start only from prepared, not ${effect.state}`);
        }
        const createdAt = timestamp(nowMs);
        const event = appendEventInTransaction(db, {
          runId: effect.runId,
          eventId: `${effectId}:dispatch-started`,
          eventType: "EffectDispatchStarted",
          nodeId: effect.nodeId,
          attemptId,
          payload: { effectId, fingerprint: effect.fingerprint },
          createdAt,
        });
        addEffectTransition(db, {
          effectId,
          runId: effect.runId,
          state: "dispatch_started",
          eventSeq: event.eventSeq,
          detail: { noExternalOutcomeRecorded: true },
          createdAt,
        });
        return effectView(db, effectId);
      });
    },

    markUnresolvedEffectsInDoubt({ runId, nowMs = Date.now() }) {
      return withSqliteTransaction(db, () => {
        assertMutationIntegrity(db, runId);
        assertActiveRun(db, runId);
        const effectIds = db.prepare(
          "SELECT effect_id FROM governed_effects WHERE run_id = ? ORDER BY effect_id",
        ).all(runId)
          .map((row) => row.effect_id)
          .filter((effectId) => latestEffectState(db, effectId) === "dispatch_started");
        const createdAt = timestamp(nowMs);
        for (const effectId of effectIds) {
          const effect = effectView(db, effectId);
          const event = appendEventInTransaction(db, {
            runId,
            eventId: `${effectId}:in-doubt`,
            eventType: "EffectInDoubt",
            nodeId: effect.nodeId,
            attemptId: effect.attemptId,
            payload: { effectId, reason: "dispatch_started_without_terminal_outcome" },
            createdAt,
          });
          addEffectTransition(db, {
            effectId,
            runId,
            state: "in_doubt",
            eventSeq: event.eventSeq,
            detail: { automaticRetryForbidden: true },
            createdAt,
          });
        }
        return { runId, effectIds };
      });
    },

    reconcileEffect({
      effectId,
      outcome,
      evidence = null,
      reconcilerIdentity,
      nowMs = Date.now(),
    }) {
      if (!new Set(["completed", "absent"]).has(outcome)) {
        throw new TypeError("Effect reconciliation outcome must be completed or absent");
      }
      if (evidence == null) throw new TypeError("Effect reconciliation evidence is required");
      requiredString(reconcilerIdentity, "reconcilerIdentity");
      return withSqliteTransaction(db, () => {
        const effect = effectView(db, effectId);
        if (!effect) throw new Error(`Unknown effect: ${effectId}`);
        assertMutationIntegrity(db, effect.runId);
        assertActiveRun(db, effect.runId);
        if (effect.state === "prepared") {
          if (outcome !== "absent") {
            throw new Error("A prepared effect may only reconcile absent after its active claim lease expires");
          }
          const claim = db.prepare(`
            SELECT lease_expires_at_ms FROM governed_node_claims
            WHERE run_id = ? AND node_id = ? AND attempt_id = ?
          `).get(effect.runId, effect.nodeId, effect.attemptId);
          if (claim && Number(claim.lease_expires_at_ms) > nowMs) {
            throw new Error("Prepared effect cannot reconcile while its active claim lease is valid");
          }
        } else if (effect.state !== "in_doubt") {
          throw new Error(`Effect must be in_doubt before reconciliation; current state is ${effect.state}`);
        }
        const state = outcome === "completed" ? "reconciled_completed" : "reconciled_absent";
        const createdAt = timestamp(nowMs);
        const event = appendEventInTransaction(db, {
          runId: effect.runId,
          eventId: `${effectId}:${state}`,
          eventType: outcome === "completed" ? "EffectReconciledCompleted" : "EffectReconciledAbsent",
          nodeId: effect.nodeId,
          attemptId: effect.attemptId,
          payload: { effectId, outcome, evidence, reconcilerIdentity },
          createdAt,
        });
        addEffectTransition(db, {
          effectId,
          runId: effect.runId,
          state,
          eventSeq: event.eventSeq,
          detail: { evidence, reconcilerIdentity },
          createdAt,
        });
        return effectView(db, effectId);
      });
    },

    reuseCompletedEffect({
      effectId,
      runId,
      nodeId,
      attemptId,
      fenceToken,
      ownerId,
      evidence,
      reuserIdentity,
      nowMs = Date.now(),
    }) {
      if (evidence == null) throw new TypeError("Completed effect reuse evidence is required");
      requiredString(reuserIdentity, "reuserIdentity");
      return withSqliteTransaction(db, () => {
        assertMutationIntegrity(db, runId);
        const targetRun = assertActiveRun(db, runId);
        requireActiveNodeClaim(db, {
          runId, nodeId, attemptId, fenceToken, ownerId, nowMs,
        });
        const effect = effectView(db, requiredString(effectId, "effectId"));
        if (!effect) throw new Error(`Unknown effect: ${effectId}`);
        if (effect.rootRunId !== targetRun.root_run_id) {
          throw new Error("Completed effect reuse must remain within the same root run");
        }
        if (effect.state !== "reconciled_completed") {
          throw new Error(`Only reconciled_completed effects can be reused; current state is ${effect.state}`);
        }
        const existing = db.prepare(`
          SELECT * FROM governed_effect_reuses WHERE effect_id = ? AND target_attempt_id = ?
        `).get(effectId, attemptId);
        const evidenceJson = canonicalJson(evidence);
        const evidenceSha256 = sha256(evidenceJson);
        if (existing) {
          if (
            existing.target_run_id !== runId || existing.target_node_id !== nodeId ||
            existing.reuser_identity !== reuserIdentity || existing.evidence_sha256 !== evidenceSha256
          ) {
            throw new Error("Completed effect reuse idempotency binding mismatch");
          }
          return {
            reuseId: existing.reuse_id,
            effectId,
            sourceAttemptId: existing.source_attempt_id,
            targetAttemptId: existing.target_attempt_id,
            evidenceSha256,
            eventSeq: Number(existing.event_seq),
          };
        }
        const createdAt = timestamp(nowMs);
        const event = appendEventInTransaction(db, {
          runId,
          eventId: `${effectId}:reused:${attemptId}`,
          eventType: "EffectReused",
          nodeId,
          attemptId,
          payload: {
            effectId,
            sourceAttemptId: effect.attemptId,
            targetAttemptId: attemptId,
            evidence,
            evidenceSha256,
            reuserIdentity,
          },
          createdAt,
        });
        const reuseId = `${effectId}:reuse:${attemptId}`;
        db.prepare(`
          INSERT INTO governed_effect_reuses(
            reuse_id, effect_id, root_run_id, target_run_id, target_node_id,
            source_attempt_id, target_attempt_id, reuser_identity,
            evidence_json, evidence_sha256, event_seq, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          reuseId,
          effectId,
          effect.rootRunId,
          runId,
          nodeId,
          effect.attemptId,
          attemptId,
          reuserIdentity,
          evidenceJson,
          evidenceSha256,
          event.eventSeq,
          createdAt,
        );
        db.prepare(`
          UPDATE governed_effect_reuse_requirements
          SET status = 'satisfied', satisfied_event_seq = ?, satisfied_at = ?
          WHERE effect_id = ? AND target_attempt_id = ? AND status = 'pending'
        `).run(event.eventSeq, createdAt, effectId, attemptId);
        return {
          reuseId,
          effectId,
          sourceAttemptId: effect.attemptId,
          targetAttemptId: attemptId,
          evidenceSha256,
          eventSeq: event.eventSeq,
        };
      });
    },

    recordTraversedEdge({
      traversalId,
      runId,
      fromNodeId,
      toNodeId,
      attemptId = null,
      conditionDigest,
      nowMs = Date.now(),
    }) {
      return withSqliteTransaction(db, () => {
        assertMutationIntegrity(db, runId);
        assertActiveRun(db, runId);
        const createdAt = timestamp(nowMs);
        const event = appendEventInTransaction(db, {
          runId,
          eventId: `${traversalId}:edge-traversed`,
          eventType: "EdgeTraversed",
          nodeId: toNodeId,
          attemptId,
          payload: { traversalId, fromNodeId, toNodeId, conditionDigest },
          createdAt,
        });
        db.prepare(`
          INSERT INTO governed_edge_traversals(
            traversal_id, run_id, from_node_id, to_node_id,
            attempt_id, condition_digest, event_seq, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          traversalId,
          runId,
          fromNodeId,
          toNodeId,
          attemptId,
          conditionDigest,
          event.eventSeq,
          createdAt,
        );
        return { traversalId, eventSeq: event.eventSeq };
      });
    },

    getCheckpointLineage(checkpointId) {
      return db.prepare(`
        WITH RECURSIVE lineage(
          checkpoint_id, run_id, parent_checkpoint_id, lineage_kind, event_seq,
          graph_digest, state_json, state_sha256, created_at, depth
        ) AS (
          SELECT checkpoint_id, run_id, parent_checkpoint_id, lineage_kind, event_seq,
            graph_digest, state_json, state_sha256, created_at, 0
          FROM governed_checkpoints WHERE checkpoint_id = ?
          UNION ALL
          SELECT parent.checkpoint_id, parent.run_id, parent.parent_checkpoint_id,
            parent.lineage_kind, parent.event_seq, parent.graph_digest,
            parent.state_json, parent.state_sha256, parent.created_at, lineage.depth + 1
          FROM governed_checkpoints parent
          JOIN lineage ON lineage.parent_checkpoint_id = parent.checkpoint_id
        )
        SELECT * FROM lineage ORDER BY depth DESC
      `).all(checkpointId).map(normalizeCheckpointRow);
    },

    projectRun(runId) {
      const run = assertRunBinding(db, { runId });
      const resume = this.resumeRun({
        runId,
        graphDigest: run.graph_digest,
        taskFingerprint: run.task_fingerprint,
      });
      const effects = db.prepare(
        "SELECT effect_id FROM governed_effects WHERE run_id = ? ORDER BY effect_id",
      ).all(runId).map((row) => effectView(db, row.effect_id));
      const edges = db.prepare(`
        SELECT traversal_id, from_node_id, to_node_id, attempt_id, condition_digest, event_seq
        FROM governed_edge_traversals WHERE run_id = ? ORDER BY event_seq
      `).all(runId).map((edge) => ({
        traversalId: edge.traversal_id,
        fromNodeId: edge.from_node_id,
        toNodeId: edge.to_node_id,
        attemptId: edge.attempt_id,
        conditionDigest: edge.condition_digest,
        eventSeq: Number(edge.event_seq),
      }));
      const result = {
        schemaVersion: "durable-governed-run-projection-v0.1",
        run: {
          runId,
          rootRunId: run.root_run_id,
          parentRunId: run.parent_run_id,
          forkCheckpointId: run.fork_checkpoint_id,
          graphDigest: run.graph_digest,
          taskFingerprint: run.task_fingerprint,
          status: run.status,
          createdAt: run.created_at,
        },
        cursor: resume.cursor,
        headCheckpointId: resume.headCheckpointId,
        completedNodes: resume.completedNodes,
        effects,
        edgeTraversals: edges,
        events: this.getEvents(runId),
        eventChain: this.verifyEventChain(runId),
      };
      durableProjectionAttestations.set(result, attestationDigest(result));
      return result;
    },

    replayRun(runId) {
      return this.projectRun(runId);
    },

    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };

  if (enableTestHooks) {
    Object.defineProperty(api, "testOnly", {
      value: Object.freeze({ database: db }),
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  return api;
}

export { SCHEMA_VERSION as DURABLE_RUN_KERNEL_SCHEMA_VERSION };
export { openSqliteDurableRunRepository as openDurableRunKernel };
