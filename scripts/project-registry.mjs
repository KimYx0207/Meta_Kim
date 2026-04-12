import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

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

async function openProjectRegistry(projectRegistryPath) {
  const { DatabaseSync } = await import("node:sqlite");
  await fs.mkdir(path.dirname(projectRegistryPath), { recursive: true });
  const db = new DatabaseSync(projectRegistryPath);
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
          WHERE repo_root = ?
        `,
      )
      .get(normalizedRepoPath);

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
      ON CONFLICT(repo_root) DO UPDATE SET
        project_ref = excluded.project_ref,
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
} = {}) {
  const { projectRegistryPath } = getProjectRegistryPaths({ homeDir });
  const db = await openProjectRegistry(projectRegistryPath);
  try {
    const { projectRef, now } = upsertProjectRow(db, {
      repoPath,
      enrollmentStatus: "joined",
    });

    db.prepare(
      `
        INSERT INTO project_platforms (
          project_ref, platform, status, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_ref, platform) DO UPDATE SET
          status = excluded.status,
          last_seen_at = excluded.last_seen_at
      `,
    ).run(projectRef, runtimeFamily, "active", now, now);

    db.prepare(
      `
        INSERT INTO project_sources (
          project_ref, source_type, source_ref, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_ref, source_type, source_ref) DO UPDATE SET
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `,
    ).run(
      projectRef,
      sourceType,
      sourceRef,
      JSON.stringify({ runtimeFamily }),
      now,
      now,
    );

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
          WHERE repo_root = ?
        `,
      )
      .get(normalizedRepoPath);

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
