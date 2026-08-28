import crypto from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { importDatabaseSync } from "../src/data/sqlite/runtime.mjs";
import { withSqliteTransaction } from "../src/data/sqlite/transaction.mjs";

const PROJECT_BOOTSTRAP_SOURCE_TYPE = "project_bootstrap";
const PROJECT_BOOTSTRAP_SOURCE_REF = "setup-project-bootstrap";
const PROJECT_REGISTRY_REPAIR_SCHEMA = "meta-kim-project-registry-repair-v0.1";

function normalizeRepoPath(repoPath) {
  return path.resolve(repoPath);
}

function repoPathHash(repoPath) {
  return crypto
    .createHash("sha256")
    .update(normalizeRepoPath(repoPath).replace(/\\/g, "/").toLowerCase())
    .digest("hex")
    .slice(0, 12);
}

export function buildProjectRef({ repoPath = process.cwd() } = {}) {
  return `project-${repoPathHash(repoPath)}`;
}

export function getProjectRegistryPaths({ homeDir = os.homedir() } = {}) {
  const root = path.join(homeDir, ".meta-kim", "global");
  return {
    root,
    projectRegistryPath: path.join(root, "project-registry.sqlite"),
  };
}

async function openProjectRegistry(
  projectRegistryPath,
  { readOnly = false, create = true } = {},
) {
  if (!create && !existsSync(projectRegistryPath)) return null;
  const DatabaseSync = await importDatabaseSync();
  if (!readOnly) {
    await fs.mkdir(path.dirname(projectRegistryPath), { recursive: true });
  }
  const db = new DatabaseSync(projectRegistryPath, { readOnly });
  if (readOnly) return db;
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS projects (
      project_ref TEXT PRIMARY KEY,
      repo_root TEXT NOT NULL UNIQUE,
      repo_path_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      enrollment_status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_platforms (
      project_ref TEXT NOT NULL,
      platform TEXT NOT NULL,
      status TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (project_ref, platform),
      FOREIGN KEY (project_ref) REFERENCES projects(project_ref) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS project_sources (
      project_ref TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_ref, source_type, source_ref),
      FOREIGN KEY (project_ref) REFERENCES projects(project_ref) ON DELETE CASCADE
    );
  `);
  return db;
}

function pathIsStrictlyWithin(rootDir, candidatePath) {
  const relative = path.relative(path.resolve(rootDir), path.resolve(candidatePath));
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function joinedProjectRows(db) {
  const sourceQuery = db.prepare(`
    SELECT source_type AS sourceType, source_ref AS sourceRef
    FROM project_sources
    WHERE project_ref = ?
    ORDER BY source_type ASC, source_ref ASC
  `);
  return db
    .prepare(`
      SELECT
        project_ref AS projectRef,
        repo_root AS repoRoot,
        display_name AS displayName,
        updated_at AS updatedAt
      FROM projects
      WHERE enrollment_status = 'joined'
      ORDER BY repo_root ASC
    `)
    .all()
    .map((project) => ({
      ...project,
      sources: sourceQuery.all(project.projectRef),
    }));
}

function hasExactBootstrapRepairSource(sources) {
  return (
    sources.length === 1 &&
    sources[0]?.sourceType === PROJECT_BOOTSTRAP_SOURCE_TYPE &&
    sources[0]?.sourceRef === PROJECT_BOOTSTRAP_SOURCE_REF
  );
}

function buildEphemeralProjectRepairPlan(db, tempRoot) {
  const candidates = [];
  const skipped = [];
  const projects = joinedProjectRows(db);
  for (const project of projects) {
    let reason = null;
    if (!hasExactBootstrapRepairSource(project.sources)) {
      reason = "source_mismatch";
    } else if (!pathIsStrictlyWithin(tempRoot, project.repoRoot)) {
      reason = "outside_os_temp_root";
    } else if (existsSync(project.repoRoot)) {
      reason = "target_still_exists";
    }
    const record = {
      projectRef: project.projectRef,
      repoRoot: project.repoRoot,
      displayName: project.displayName,
      updatedAt: project.updatedAt,
    };
    if (reason) skipped.push({ ...record, reason });
    else candidates.push(record);
  }
  return {
    scannedCount: projects.length,
    eligibleCount: candidates.length,
    skippedCount: skipped.length,
    candidates,
    skipped,
  };
}

async function writeProjectRegistryBackup(db, projectRegistryPath) {
  const backupDir = path.join(
    path.dirname(projectRegistryPath),
    "backups",
    "project-registry",
  );
  await fs.mkdir(backupDir, { recursive: true });
  const backupPath = path.join(
    backupDir,
    `project-registry-${Date.now()}-${crypto.randomUUID()}.sqlite`,
  );
  const serialized = db.serialize();
  const handle = await fs.open(backupPath, "wx");
  try {
    await handle.writeFile(serialized);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(backupPath, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();

  const DatabaseSync = await importDatabaseSync();
  const backupDb = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const quickCheck = backupDb.prepare("PRAGMA quick_check").get();
    if (quickCheck?.quick_check !== "ok") {
      throw new Error("Project registry backup failed SQLite quick_check");
    }
  } finally {
    backupDb.close();
  }
  const stat = await fs.stat(backupPath);
  return {
    path: backupPath,
    bytes: stat.size,
    quickCheck: "ok",
  };
}

function statusFromEnrollment(enrollmentStatus) {
  if (enrollmentStatus === "joined") {
    return "known";
  }
  if (enrollmentStatus === "skipped") {
    return "skipped";
  }
  return "prompt_join";
}

export async function detectProjectRegistryEntry({
  homeDir = os.homedir(),
  repoPath = process.cwd(),
  runtimeFamily = "shared",
} = {}) {
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  const projectRef = buildProjectRef({ repoPath: normalizedRepoPath });
  const { projectRegistryPath } = getProjectRegistryPaths({ homeDir });
  const db = await openProjectRegistry(projectRegistryPath);
  try {
    const row = db
      .prepare(
        `
          SELECT project_ref, repo_root, repo_path_hash, display_name, enrollment_status, created_at, updated_at
          FROM projects
          WHERE project_ref = ?
        `,
      )
      .get(projectRef);

    if (!row) {
      return {
        projectRef,
        registryStatus: "prompt_join",
        known: false,
        runtimeFamily,
        projectRegistryPath,
      };
    }

    return {
      projectRef: row.project_ref,
      registryStatus: statusFromEnrollment(row.enrollment_status),
      known: row.enrollment_status === "joined",
      runtimeFamily,
      projectRegistryPath,
    };
  } finally {
    db.close();
  }
}

function upsertProjectRow(db, { repoPath, enrollmentStatus }) {
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  const projectRef = buildProjectRef({ repoPath: normalizedRepoPath });
  const now = new Date().toISOString();
  const displayName = path.basename(normalizedRepoPath) || projectRef;

  db.prepare(
    `
      INSERT INTO projects (
        project_ref, repo_root, repo_path_hash, display_name, enrollment_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_ref) DO UPDATE SET
        repo_root = excluded.repo_root,
        repo_path_hash = excluded.repo_path_hash,
        display_name = excluded.display_name,
        enrollment_status = excluded.enrollment_status,
        updated_at = excluded.updated_at
    `,
  ).run(
    projectRef,
    normalizedRepoPath,
    repoPathHash(normalizedRepoPath),
    displayName,
    enrollmentStatus,
    now,
    now,
  );

  return { projectRef, normalizedRepoPath, now };
}

export async function joinProjectRegistry({
  homeDir = os.homedir(),
  repoPath = process.cwd(),
  runtimeFamily = "shared",
  sourceType = "meta_architecture",
  sourceRef = "meta-kim-runtime",
  onWriteStep = null,
} = {}) {
  const { projectRegistryPath } = getProjectRegistryPaths({ homeDir });
  const db = await openProjectRegistry(projectRegistryPath);
  try {
    const { projectRef } = withSqliteTransaction(db, () => {
      const project = upsertProjectRow(db, {
        repoPath,
        enrollmentStatus: "joined",
      });
      onWriteStep?.("project");

      db.prepare(`
        INSERT INTO project_platforms (
          project_ref, platform, status, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_ref, platform) DO UPDATE SET
          status = excluded.status,
          last_seen_at = excluded.last_seen_at
      `).run(project.projectRef, runtimeFamily, "active", project.now, project.now);
      onWriteStep?.("platform");

      db.prepare(`
        INSERT INTO project_sources (
          project_ref, source_type, source_ref, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_ref, source_type, source_ref) DO UPDATE SET
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `).run(
        project.projectRef,
        sourceType,
        sourceRef,
        JSON.stringify({ runtimeFamily }),
        project.now,
        project.now,
      );
      onWriteStep?.("source");
      return project;
    });

    return {
      projectRef,
      registryStatus: "joined",
      known: true,
      runtimeFamily,
      projectRegistryPath,
    };
  } finally {
    db.close();
  }
}

export async function ensureGovernedLiveProjectRegistration({
  homeDir = os.homedir(),
  repoPath = null,
  preferredProjectRef = null,
  runtimeFamily = "shared",
  sourceRef = "meta-kim-live",
} = {}) {
  if (typeof repoPath !== "string" || !repoPath.trim()) {
    return {
      projectRef: preferredProjectRef,
      registryStatus: "not_applicable",
      known: false,
    };
  }
  const detected = await detectProjectRegistryEntry({ homeDir, repoPath, runtimeFamily });
  if (detected.registryStatus !== "prompt_join") return detected;
  return joinProjectRegistry({
    homeDir,
    repoPath,
    runtimeFamily,
    sourceType: "governed_live",
    sourceRef,
  });
}

export async function skipProjectRegistry({
  homeDir = os.homedir(),
  repoPath = process.cwd(),
} = {}) {
  const { projectRegistryPath } = getProjectRegistryPaths({ homeDir });
  const db = await openProjectRegistry(projectRegistryPath);
  try {
    const { projectRef } = upsertProjectRow(db, {
      repoPath,
      enrollmentStatus: "skipped",
    });
    return {
      projectRef,
      registryStatus: "skipped",
      known: false,
      projectRegistryPath,
    };
  } finally {
    db.close();
  }
}

export async function readProjectRegistryEntry({
  homeDir = os.homedir(),
  repoPath = process.cwd(),
} = {}) {
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  const projectRef = buildProjectRef({ repoPath: normalizedRepoPath });
  const { projectRegistryPath } = getProjectRegistryPaths({ homeDir });
  const db = await openProjectRegistry(projectRegistryPath);
  try {
    const project = db
      .prepare(
        `
          SELECT
            project_ref AS projectRef,
            repo_root AS repoRoot,
            repo_path_hash AS repoPathHash,
            display_name AS displayName,
            enrollment_status AS enrollmentStatus,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM projects
          WHERE project_ref = ?
        `,
      )
      .get(projectRef);

    if (!project) {
      return null;
    }

    const platforms = db
      .prepare(
        `
          SELECT
            platform,
            status,
            first_seen_at AS firstSeenAt,
            last_seen_at AS lastSeenAt
          FROM project_platforms
          WHERE project_ref = ?
          ORDER BY platform ASC
        `,
      )
      .all(project.projectRef);

    const sources = db
      .prepare(
        `
          SELECT
            source_type AS sourceType,
            source_ref AS sourceRef,
            metadata_json AS metadataJson,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM project_sources
          WHERE project_ref = ?
          ORDER BY source_type ASC, source_ref ASC
        `,
      )
      .all(project.projectRef)
      .map((row) => ({
        ...row,
        metadata: JSON.parse(row.metadataJson),
      }));

    return { project, platforms, sources };
  } finally {
    db.close();
  }
}

export async function listJoinedProjectRegistryEntries({ homeDir = os.homedir() } = {}) {
  const { projectRegistryPath } = getProjectRegistryPaths({ homeDir });
  const db = await openProjectRegistry(projectRegistryPath, { readOnly: true, create: false });
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT
        project_ref AS projectRef,
        repo_root AS repoRoot,
        display_name AS displayName,
        updated_at AS updatedAt
      FROM projects
      WHERE enrollment_status = 'joined'
      ORDER BY repo_root ASC
    `).all();
  } finally {
    db.close();
  }
}

/**
 * Plan or apply a narrowly-scoped repair for project-bootstrap rows created by
 * temporary verification projects. The normal install/update path never calls
 * this function. Apply mode creates and validates a SQLite snapshot before a
 * single transaction removes exact child rows and their project rows.
 */
export async function repairEphemeralProjectRegistryEntries({
  homeDir = os.homedir(),
  tempRoot = os.tmpdir(),
  apply = false,
  onDeleteStep = null,
} = {}) {
  const { projectRegistryPath } = getProjectRegistryPaths({ homeDir });
  const baseResult = {
    schemaVersion: PROJECT_REGISTRY_REPAIR_SCHEMA,
    mode: apply ? "apply" : "dry-run",
    registryPath: projectRegistryPath,
    registryExists: existsSync(projectRegistryPath),
    criteria: {
      tempRoot: path.resolve(tempRoot),
      targetMustBeMissing: true,
      sourceType: PROJECT_BOOTSTRAP_SOURCE_TYPE,
      sourceRef: PROJECT_BOOTSTRAP_SOURCE_REF,
      exactSourceSetRequired: true,
    },
  };
  if (!baseResult.registryExists) {
    return {
      ...baseResult,
      scannedCount: 0,
      eligibleCount: 0,
      skippedCount: 0,
      candidates: [],
      skipped: [],
      deletedCount: 0,
      backup: null,
      transaction: apply ? "not_required" : "not_started",
    };
  }

  const db = await openProjectRegistry(projectRegistryPath, {
    readOnly: !apply,
    create: false,
  });
  try {
    const plan = buildEphemeralProjectRepairPlan(db, tempRoot);
    if (!apply || plan.eligibleCount === 0) {
      return {
        ...baseResult,
        ...plan,
        deletedCount: 0,
        backup: null,
        transaction: apply ? "not_required" : "not_started",
      };
    }

    const backup = await writeProjectRegistryBackup(db, projectRegistryPath);
    const plannedRefs = new Set(plan.candidates.map((candidate) => candidate.projectRef));
    try {
      const transactionResult = withSqliteTransaction(db, () => {
        const currentPlan = buildEphemeralProjectRepairPlan(db, tempRoot);
        const currentCandidates = currentPlan.candidates.filter((candidate) =>
          plannedRefs.has(candidate.projectRef),
        );
        const deleteSources = db.prepare(
          "DELETE FROM project_sources WHERE project_ref = ?",
        );
        const deletePlatforms = db.prepare(
          "DELETE FROM project_platforms WHERE project_ref = ?",
        );
        const deleteProject = db.prepare(`
          DELETE FROM projects
          WHERE project_ref = ? AND repo_root = ? AND enrollment_status = 'joined'
        `);
        const deleted = [];
        for (const [index, candidate] of currentCandidates.entries()) {
          deleteSources.run(candidate.projectRef);
          deletePlatforms.run(candidate.projectRef);
          const result = deleteProject.run(candidate.projectRef, candidate.repoRoot);
          if (Number(result.changes) !== 1) {
            throw new Error(
              `Project registry repair lost exact ownership for ${candidate.projectRef}`,
            );
          }
          deleted.push(candidate);
          onDeleteStep?.({ index, candidate });
        }
        return {
          deleted,
          becameIneligible: plan.candidates.filter(
            (candidate) =>
              !currentCandidates.some(
                (current) => current.projectRef === candidate.projectRef,
              ),
          ),
        };
      });
      return {
        ...baseResult,
        ...plan,
        deletedCount: transactionResult.deleted.length,
        deleted: transactionResult.deleted,
        becameIneligible: transactionResult.becameIneligible,
        backup,
        transaction: "committed",
      };
    } catch (error) {
      error.backup = backup;
      error.transaction = "rolled_back";
      throw error;
    }
  } finally {
    db.close();
  }
}
