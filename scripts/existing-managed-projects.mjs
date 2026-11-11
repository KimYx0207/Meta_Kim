import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { inspectTrustedPath } from "./safe-managed-file-operations.mjs";

const HASH_RE = /^[a-f0-9]{64}$/iu;
const DEFAULT_SUPPORTED_TARGETS = Object.freeze(JSON.parse(
  readFileSync(new URL("../config/sync.json", import.meta.url), "utf8"),
).supportedTargets);

export function resolveExistingManagedProjectCandidates(
  candidates,
  {
    manifestRelPath = ".meta-kim/state/default/project-bootstrap.json",
    supportedTargets = DEFAULT_SUPPORTED_TARGETS,
  } = {},
) {
  const deployments = [];
  const rejected = [];
  const allowedTargets = new Set(supportedTargets);
  for (const candidate of candidates) {
    const targetDir = path.resolve(candidate.targetDir);
    const source = candidate.source;
    const optionalCwd = source === "current_working_directory";
    if (!existsSync(targetDir)) {
      if (!optionalCwd) rejected.push({ targetDir, source, reason: "target_missing" });
      continue;
    }
    const rootStats = lstatSync(targetDir);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      rejected.push({ targetDir, source, reason: "unsafe_project_root" });
      continue;
    }
    const manifestInfo = inspectTrustedPath(targetDir, manifestRelPath, { allowMissing: true });
    if (!manifestInfo) {
      rejected.push({ targetDir, source, reason: "unsafe_manifest_path" });
      continue;
    }
    if (!existsSync(manifestInfo.target)) {
      if (!optionalCwd) rejected.push({ targetDir, source, reason: "manifest_missing_or_invalid" });
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestInfo.target, "utf8"));
    } catch {
      rejected.push({ targetDir, source, reason: "manifest_missing_or_invalid" });
      continue;
    }
    const validManifest =
      manifest?.schemaVersion === "meta-kim-project-bootstrap-v0.1" &&
      Array.isArray(manifest.managedFiles) &&
      manifest.managedFiles.length > 0 &&
      manifest.managedFiles.every((entry) =>
        typeof entry?.relPath === "string" && HASH_RE.test(entry?.contentHash ?? ""));
    if (!validManifest) {
      rejected.push({ targetDir, source, reason: "manifest_missing_or_invalid" });
      continue;
    }
    const activeTargets = [];
    const seenTargets = new Set();
    let targetsValid = Array.isArray(manifest.activeTargets) && manifest.activeTargets.length > 0;
    for (const rawTarget of manifest.activeTargets ?? []) {
      const target = String(rawTarget ?? "").trim().toLowerCase();
      if (!allowedTargets.has(target)) {
        targetsValid = false;
        break;
      }
      if (!seenTargets.has(target)) {
        seenTargets.add(target);
        activeTargets.push(target);
      }
    }
    if (!targetsValid || activeTargets.length === 0) {
      rejected.push({ targetDir, source, reason: "invalid_active_targets" });
      continue;
    }
    deployments.push({ targetDir, activeTargets, source });
  }
  return { deployments, rejected };
}
