#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import {
  ensureProfileState,
  getProfilePaths,
  toRepoRelative,
} from "./meta-kim-local-state.mjs";
import { validateArtifactFile } from "./validate-run-artifact.mjs";

const DEFAULT_SOURCE = "tests/fixtures/run-artifacts";
const command = process.argv[2] || "index";
const argv = process.argv.slice(3);

function takeFlag(name, fallback = undefined) {
  const direct = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (direct) {
    return direct.slice(name.length + 3);
  }
  const index = argv.indexOf(`--${name}`);
  if (index !== -1 && argv[index + 1] && !argv[index + 1].startsWith("--")) {
    return argv[index + 1];
  }
  return fallback;
}

function takeBooleanFlag(name) {
  const value = takeFlag(name, null);
  if (value === null) {
    return undefined;
  }
  return value === "true" || value === "1";
}

function positionalArgs() {
  return argv.filter((arg, index) => {
    if (arg.startsWith("--")) {
      return false;
    }
    const previous = argv[index - 1];
    return !previous || !previous.startsWith("--");
  });
}

async function walkJsonFiles(targetPath) {
  const stat = await fs.stat(targetPath);
  if (stat.isFile()) {
    return targetPath.endsWith(".json") ? [targetPath] : [];
  }

  const found = [];
  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walkJsonFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".json")) {
      found.push(fullPath);
    }
  }
  return found;
}

async function resolveArtifactSources() {
  const sources = positionalArgs().length > 0 ? positionalArgs() : [DEFAULT_SOURCE];
  const files = [];
  for (const source of sources) {
    const fullPath = path.resolve(process.cwd(), source);
    try {
      files.push(...(await walkJsonFiles(fullPath)));
    } catch {
      // Ignore missing sources so the operator can query an empty index.
    }
  }
  return [...new Set(files)];
}

function openDb(runIndexPath) {
  const db = new DatabaseSync(runIndexPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS runs (
      artifact_path TEXT PRIMARY KEY,
      indexed_at TEXT NOT NULL,
      governance_flow TEXT NOT NULL,
      task_class TEXT NOT NULL,
      request_class TEXT NOT NULL,
      primary_deliverable TEXT NOT NULL,
      owner_agents_json TEXT NOT NULL,
      owner_agents_text TEXT NOT NULL,
      public_ready INTEGER NOT NULL,
      verify_passed INTEGER NOT NULL,
      open_findings_count INTEGER NOT NULL,
      writeback_decision TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS run_findings (
      artifact_path TEXT NOT NULL,
      finding_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      severity TEXT NOT NULL,
      close_state TEXT NOT NULL,
      is_open INTEGER NOT NULL,
      PRIMARY KEY (artifact_path, finding_id)
    );
    CREATE INDEX IF NOT EXISTS idx_runs_governance_flow ON runs(governance_flow);
    CREATE INDEX IF NOT EXISTS idx_runs_public_ready ON runs(public_ready);
    CREATE INDEX IF NOT EXISTS idx_runs_owner_agents ON runs(owner_agents_text);
    CREATE INDEX IF NOT EXISTS idx_findings_open ON run_findings(is_open);
  `);
  return db;
}

function deriveOpenFindingIds(artifact) {
  const reviewFindings = artifact.reviewPacket?.findings ?? [];
  const verificationResults = new Map(
    (artifact.verificationPacket?.verificationResults ?? []).map((result) => [result.findingId, result])
  );
  const closedIds = new Set(artifact.verificationPacket?.closeFindings ?? []);
  return reviewFindings
    .filter((finding) => {
      const result = verificationResults.get(finding.findingId);
      return !result || !closedIds.has(finding.findingId);
    })
    .map((finding) => finding.findingId);
}

function deriveOwnerAgents(artifact) {
  const owners = new Set();
  if (artifact.dispatchEnvelopePacket?.ownerAgent) {
    owners.add(artifact.dispatchEnvelopePacket.ownerAgent);
  }
  for (const packet of artifact.workerTaskPackets ?? []) {
    if (packet.owner) {
      owners.add(packet.owner);
    }
  }
  for (const finding of artifact.reviewPacket?.findings ?? []) {
    if (finding.owner) {
      owners.add(finding.owner);
    }
  }
  if (artifact.dispatchEnvelopePacket?.reviewOwner) {
    owners.add(artifact.dispatchEnvelopePacket.reviewOwner);
  }
  if (artifact.dispatchEnvelopePacket?.verificationOwner) {
    owners.add(artifact.dispatchEnvelopePacket.verificationOwner);
  }
  return [...owners].sort();
}

function summarizeArtifact(artifact, artifactPath) {
  const owners = deriveOwnerAgents(artifact);
  const openFindingIds = deriveOpenFindingIds(artifact);
  return {
    artifactPath: toRepoRelative(artifactPath),
    indexedAt: new Date().toISOString(),
    governanceFlow: artifact.taskClassification.governanceFlow,
    taskClass: artifact.taskClassification.taskClass,
    requestClass: artifact.taskClassification.requestClass,
    primaryDeliverable: artifact.runHeader.primaryDeliverable,
    ownerAgents: owners,
    publicReady: artifact.summaryPacket.publicReady === true,
    verifyPassed: artifact.summaryPacket.verifyPassed === true,
    openFindingIds,
    writebackDecision: artifact.evolutionWritebackPacket.writebackDecision,
    payload: {
      taskClassification: artifact.taskClassification,
      cardPlanPacket: artifact.cardPlanPacket,
      orchestrationTaskBoardPacket: artifact.orchestrationTaskBoardPacket,
      capabilityGapPacket: artifact.capabilityGapPacket,
      executionAgentCard: artifact.executionAgentCard,
      reviewFindings: artifact.reviewPacket.findings,
      verificationResults: artifact.verificationPacket.verificationResults,
      summaryPacket: artifact.summaryPacket,
      writebackDecision: artifact.evolutionWritebackPacket.writebackDecision,
      dispatchEnvelopePacket: artifact.dispatchEnvelopePacket,
    },
  };
}

function upsertRun(db, summary) {
  db.prepare("DELETE FROM run_findings WHERE artifact_path = ?").run(summary.artifactPath);
  db.prepare(`
    INSERT INTO runs (
      artifact_path, indexed_at, governance_flow, task_class, request_class, primary_deliverable,
      owner_agents_json, owner_agents_text, public_ready, verify_passed, open_findings_count,
      writeback_decision, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(artifact_path) DO UPDATE SET
      indexed_at=excluded.indexed_at,
      governance_flow=excluded.governance_flow,
      task_class=excluded.task_class,
      request_class=excluded.request_class,
      primary_deliverable=excluded.primary_deliverable,
      owner_agents_json=excluded.owner_agents_json,
      owner_agents_text=excluded.owner_agents_text,
      public_ready=excluded.public_ready,
      verify_passed=excluded.verify_passed,
      open_findings_count=excluded.open_findings_count,
      writeback_decision=excluded.writeback_decision,
      payload_json=excluded.payload_json
  `).run(
    summary.artifactPath,
    summary.indexedAt,
    summary.governanceFlow,
    summary.taskClass,
    summary.requestClass,
    summary.primaryDeliverable,
    JSON.stringify(summary.ownerAgents),
    `|${summary.ownerAgents.join("|")}|`,
    summary.publicReady ? 1 : 0,
    summary.verifyPassed ? 1 : 0,
    summary.openFindingIds.length,
    summary.writebackDecision,
    JSON.stringify(summary.payload)
  );

  const insertFinding = db.prepare(`
    INSERT INTO run_findings (
      artifact_path, finding_id, owner, severity, close_state, is_open
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const finding of summary.payload.reviewFindings) {
    insertFinding.run(
      summary.artifactPath,
      finding.findingId,
      finding.owner,
      finding.severity,
      summary.openFindingIds.includes(finding.findingId) ? "open" : "closed",
      summary.openFindingIds.includes(finding.findingId) ? 1 : 0
    );
  }
}

async function indexArtifacts({ reset = false } = {}) {
  const { runIndexPath, metadata, profile, runtimeFamily } = await ensureProfileState({
    profile: takeFlag("profile"),
    runtimeFamily: takeFlag("runtime-family"),
  });
  const db = openDb(runIndexPath);
  if (reset) {
    db.exec("DELETE FROM run_findings; DELETE FROM runs;");
  }

  const indexed = [];
  const skipped = [];
  for (const artifactPath of await resolveArtifactSources()) {
    try {
      const artifact = await validateArtifactFile(artifactPath);
      const summary = summarizeArtifact(artifact, artifactPath);
      upsertRun(db, summary);
      indexed.push(summary.artifactPath);
    } catch (error) {
      skipped.push({
        artifactPath: toRepoRelative(artifactPath),
        reason: error.message,
      });
    }
  }

  db.close();
  return {
    ok: true,
    command: reset ? "rebuild" : "index",
    profile,
    runtimeFamily,
    profileKey: metadata.profileKey,
    runIndexPath: toRepoRelative(runIndexPath),
    indexedCount: indexed.length,
    skippedCount: skipped.length,
    indexed,
    skipped,
  };
}

function queryRuns() {
  const paths = getProfilePaths({
    profile: takeFlag("profile"),
    runtimeFamily: takeFlag("runtime-family"),
  });
  return ensureProfileState({
    profile: paths.profile,
    runtimeFamily: paths.runtimeFamily,
  }).then((state) => {
    const db = openDb(state.runIndexPath);

    const where = [];
    const params = [];

    const governanceFlow = takeFlag("governance-flow");
    if (governanceFlow) {
      where.push("governance_flow = ?");
      params.push(governanceFlow);
    }

    const owner = takeFlag("owner");
    if (owner) {
      where.push("owner_agents_text LIKE ?");
      params.push(`%|${owner}|%`);
    }

    const publicReady = takeBooleanFlag("public-ready");
    if (publicReady !== undefined) {
      where.push("public_ready = ?");
      params.push(publicReady ? 1 : 0);
    }

    const openFindings = takeBooleanFlag("open-findings");
    if (openFindings !== undefined) {
      where.push(openFindings ? "open_findings_count > 0" : "open_findings_count = 0");
    }

    const limit = Number.parseInt(takeFlag("limit", "20"), 10);
    const sql = `
      SELECT artifact_path, governance_flow, primary_deliverable, owner_agents_json, public_ready,
             verify_passed, open_findings_count, writeback_decision, payload_json
      FROM runs
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY indexed_at DESC
      LIMIT ${Number.isFinite(limit) ? Math.max(limit, 1) : 20}
    `;

    const rows = db.prepare(sql).all(...params).map((row) => ({
      artifactPath: row.artifact_path,
      governanceFlow: row.governance_flow,
      primaryDeliverable: row.primary_deliverable,
      ownerAgents: JSON.parse(row.owner_agents_json),
      publicReady: Boolean(row.public_ready),
      verifyPassed: Boolean(row.verify_passed),
      openFindingsCount: row.open_findings_count,
      writebackDecision: row.writeback_decision,
      payload: JSON.parse(row.payload_json),
    }));
    db.close();

    return {
      ok: true,
      command: "query",
      profile: state.profile,
      runtimeFamily: state.runtimeFamily,
      profileKey: state.metadata.profileKey,
      runIndexPath: toRepoRelative(state.runIndexPath),
      count: rows.length,
      rows,
    };
  });
}

async function main() {
  let result;
  if (command === "rebuild") {
    result = await indexArtifacts({ reset: true });
  } else if (command === "query") {
    result = await queryRuns();
  } else if (command === "index") {
    result = await indexArtifacts({ reset: false });
  } else {
    throw new Error(`Unknown run-index command: ${command}`);
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
