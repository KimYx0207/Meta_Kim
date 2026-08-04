#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  lstatSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { getProfilePaths } from "./meta-kim-local-state.mjs";
import { packedProductProofComplete } from "./packed-product-proof.mjs";
import { canonicalJson, sha256 } from "./release-binding-canonical.mjs";

export { canonicalJson, sha256 } from "./release-binding-canonical.mjs";

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MAX_ASSET_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_UNPACKED_BYTES = 128 * 1024 * 1024;
const TAG_PATTERN = /^v?[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function isSha256Hex(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function gitEvidenceEnvironment(environment) {
  const clean = { ...environment };
  for (const key of Object.keys(clean)) {
    if (key.toUpperCase().startsWith("GIT_")) delete clean[key];
  }
  return clean;
}

function assertSafeTag(tag) {
  if (!TAG_PATTERN.test(tag) || tag.includes("..") || tag.includes("@{")) {
    throw codedError("invalid_tag", "tag must be a simple release tag");
  }
  return tag;
}

function git(repoRoot, args, {
  encoding = "utf8",
  allowFailure = false,
  environment = process.env,
} = {}) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding,
    env: environment,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    throw codedError(
      "git_evidence_failed",
      `git ${args[0]} could not produce release evidence`,
    );
  }
  return result;
}

function parseGitHubOrigin(originUrl) {
  const value = String(originUrl ?? "").trim();
  const match = value.match(
    /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s:]+)\/([^/\s]+?)(?:\.git)?$/iu,
  );
  if (!match) {
    throw codedError(
      "unsupported_release_remote",
      "origin must identify a GitHub owner/repository for release audit",
    );
  }
  return { owner: match[1], repo: match[2] };
}

function readTagPackageManifest(repoRoot, tagRef, environment) {
  const result = git(repoRoot, ["show", `${tagRef}:package.json`], {
    encoding: null,
    environment,
  });
  const bytes = Buffer.from(result.stdout);
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw codedError("tag_package_manifest_invalid", "tag package.json is not valid JSON");
  }
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw codedError(
      "tag_package_manifest_invalid",
      "tag package.json must contain name and version",
    );
  }
  return { bytes, manifest, sha256: sha256(bytes) };
}

export function collectGitReleaseFacts(repoRoot, tagName, {
  environment = process.env,
} = {}) {
  environment = gitEvidenceEnvironment(environment);
  const tag = assertSafeTag(tagName);
  const tagRef = `refs/tags/${tag}`;
  const tagType = git(repoRoot, ["cat-file", "-t", tagRef], { environment }).stdout.trim();
  if (tagType !== "tag") {
    throw codedError("annotated_tag_required", "release audit requires an annotated tag");
  }
  const tagObjectSha = git(repoRoot, ["rev-parse", tagRef], { environment }).stdout.trim();
  const peeledCommitSha = git(repoRoot, ["rev-parse", `${tagRef}^{}`], { environment }).stdout.trim();
  const peeledTreeSha = git(repoRoot, ["rev-parse", `${tagRef}^{tree}`], { environment }).stdout.trim();
  const originUrl = git(repoRoot, ["remote", "get-url", "origin"], { environment }).stdout.trim();
  const repository = parseGitHubOrigin(originUrl);
  const packageManifest = readTagPackageManifest(repoRoot, tagRef, environment);
  const expectedVersion = tag.startsWith("v") ? tag.slice(1) : tag;
  if (packageManifest.manifest.version !== expectedVersion) {
    throw codedError(
      "tag_version_mismatch",
      "tag name and package.json version do not match",
    );
  }

  const remoteMainResult = git(repoRoot, ["rev-parse", "refs/remotes/origin/main"], {
    allowFailure: true,
    environment,
  });
  const remoteMainSha = remoteMainResult.status === 0
    ? remoteMainResult.stdout.trim()
    : null;
  let remoteMainRelation = "unavailable";
  if (remoteMainSha === peeledCommitSha) {
    remoteMainRelation = "exact";
  } else if (remoteMainSha) {
    const ancestor = git(
      repoRoot,
      ["merge-base", "--is-ancestor", peeledCommitSha, remoteMainSha],
      { allowFailure: true, environment },
    );
    remoteMainRelation = ancestor.status === 0 ? "tag_commit_is_ancestor" : "diverged";
  }

  return {
    tagName: tag,
    tagObjectSha,
    peeledCommitSha,
    peeledTreeSha,
    packageName: packageManifest.manifest.name,
    packageVersion: packageManifest.manifest.version,
    tagPackageJsonSha256: packageManifest.sha256,
    repository,
    remoteMainSha,
    remoteMainRelation,
    remoteMainEvidenceSource: "local_tracking_ref",
  };
}

function tarText(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  return buffer.subarray(start, end >= start && end < start + length ? end : start + length)
    .toString("utf8")
    .trim();
}

function tarOctal(buffer, start, length) {
  const value = tarText(buffer, start, length).replace(/^0+/u, "") || "0";
  if (!/^[0-7]+$/u.test(value)) {
    throw codedError("package_tar_invalid", "package tar contains an invalid size field");
  }
  return Number.parseInt(value, 8);
}

export function readPackageManifestFromTgz(bytes, {
  maxUnpackedBytes = DEFAULT_MAX_UNPACKED_BYTES,
} = {}) {
  let tar;
  try {
    tar = gunzipSync(bytes, { maxOutputLength: maxUnpackedBytes });
  } catch {
    throw codedError("package_tgz_invalid", "release package is not a bounded gzip tarball");
  }
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarText(header, 0, 100);
    const prefix = tarText(header, 345, 155);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    const size = tarOctal(header, 124, 12);
    const type = header[156];
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (!Number.isSafeInteger(size) || size < 0 || dataEnd > tar.length) {
      throw codedError("package_tar_invalid", "release package contains an invalid entry");
    }
    if (entryPath === "package/package.json" && [0, 48].includes(type)) {
      if (size > 1024 * 1024) {
        throw codedError("package_manifest_too_large", "packed package.json exceeds 1 MiB");
      }
      const manifestBytes = tar.subarray(dataStart, dataEnd);
      try {
        const manifest = JSON.parse(manifestBytes.toString("utf8"));
        return { manifest, bytes: manifestBytes, sha256: sha256(manifestBytes) };
      } catch {
        throw codedError("package_manifest_invalid", "packed package.json is not valid JSON");
      }
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  throw codedError("package_manifest_missing", "release package has no package/package.json");
}

export async function fetchGitHubReleaseFacts(gitFacts, {
  fetchImpl = globalThis.fetch,
  environment = process.env,
  timeoutMs = 30_000,
  downloadAsset = false,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw codedError("fetch_unavailable", "release audit requires a fetch implementation");
  }
  const { owner, repo } = gitFacts.repository;
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/tags/${encodeURIComponent(gitFacts.tagName)}`;
  const token = environment.GH_TOKEN || environment.GITHUB_TOKEN || null;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "meta-kim-release-binding-audit",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  let response;
  try {
    response = await fetchImpl(apiUrl, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw codedError("github_release_unavailable", "GitHub Release metadata could not be fetched");
  }
  if (!response.ok) {
    throw codedError(
      "github_release_unavailable",
      `GitHub Release metadata returned HTTP ${response.status}`,
    );
  }
  const payload = await response.json();
  const expectedUrl = `https://github.com/${owner}/${repo}/releases/tag/${gitFacts.tagName}`;
  const expectedAssetName = `${gitFacts.packageName}-${gitFacts.packageVersion}.tgz`;
  const matchingAssets = Array.isArray(payload.assets)
    ? payload.assets.filter((asset) => asset?.name === expectedAssetName)
    : [];
  if (matchingAssets.length !== 1) {
    throw codedError(
      "release_package_asset_missing",
      `GitHub Release must contain exactly one ${expectedAssetName} asset`,
    );
  }
  const asset = matchingAssets[0];
  const digestMatch = String(asset.digest ?? "").match(/^sha256:([a-f0-9]{64})$/u);
  if (!digestMatch) {
    throw codedError(
      "release_package_digest_missing",
      "GitHub Release package asset must expose a SHA-256 digest",
    );
  }
  if (payload.tag_name !== gitFacts.tagName || payload.html_url !== expectedUrl) {
    throw codedError("github_release_identity_mismatch", "GitHub Release tag or URL does not match origin");
  }

  const refUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/tags/${encodeURIComponent(gitFacts.tagName)}`;
  let refResponse;
  try {
    refResponse = await fetchImpl(refUrl, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw codedError("github_tag_unavailable", "GitHub tag reference could not be fetched");
  }
  if (!refResponse.ok) {
    throw codedError("github_tag_unavailable", `GitHub tag reference returned HTTP ${refResponse.status}`);
  }
  const refPayload = await refResponse.json();
  if (
    refPayload?.object?.type !== "tag" ||
    refPayload?.object?.sha !== gitFacts.tagObjectSha
  ) {
    throw codedError(
      "remote_tag_object_mismatch",
      "GitHub annotated tag object does not match the local release tag",
    );
  }
  const tagObjectUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/tags/${refPayload.object.sha}`;
  let tagResponse;
  try {
    tagResponse = await fetchImpl(tagObjectUrl, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw codedError("github_tag_object_unavailable", "GitHub annotated tag object could not be fetched");
  }
  if (!tagResponse.ok) {
    throw codedError(
      "github_tag_object_unavailable",
      `GitHub annotated tag object returned HTTP ${tagResponse.status}`,
    );
  }
  const tagPayload = await tagResponse.json();
  if (
    tagPayload?.object?.type !== "commit" ||
    tagPayload?.object?.sha !== gitFacts.peeledCommitSha
  ) {
    throw codedError(
      "remote_tag_peeled_commit_mismatch",
      "GitHub annotated tag does not peel to the local release commit",
    );
  }

  let downloadedBytes = null;
  if (downloadAsset) {
    let assetResponse;
    try {
      assetResponse = await fetchImpl(asset.browser_download_url, {
        headers: { "User-Agent": "meta-kim-release-binding-audit" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw codedError("release_package_download_failed", "release package asset download failed");
    }
    if (!assetResponse.ok) {
      throw codedError(
        "release_package_download_failed",
        `release package asset returned HTTP ${assetResponse.status}`,
      );
    }
    const length = Number(assetResponse.headers.get("content-length") ?? 0);
    if (length > DEFAULT_MAX_ASSET_BYTES) {
      throw codedError("release_package_too_large", "release package exceeds 64 MiB");
    }
    downloadedBytes = Buffer.from(await assetResponse.arrayBuffer());
    if (downloadedBytes.length > DEFAULT_MAX_ASSET_BYTES) {
      throw codedError("release_package_too_large", "release package exceeds 64 MiB");
    }
    if (sha256(downloadedBytes) !== digestMatch[1]) {
      throw codedError("release_package_digest_mismatch", "downloaded package digest does not match GitHub");
    }
  }

  return {
    url: payload.html_url,
    targetCommitish: payload.target_commitish ?? null,
    publishedAt: payload.published_at ?? null,
    draft: payload.draft === true,
    prerelease: payload.prerelease === true,
    remoteTagObjectSha: refPayload.object.sha,
    remotePeeledCommitSha: tagPayload.object.sha,
    asset: {
      name: asset.name,
      size: asset.size,
      sha256: digestMatch[1],
      downloadUrl: asset.browser_download_url,
    },
    downloadedBytes,
  };
}

function compactSourceSnapshot(report) {
  const source = report?.releasePreflight?.sourceSnapshot;
  if (!source || typeof source !== "object") return null;
  const snapshot = source.end ?? source.final ?? source.start ?? source.postProbe ?? source.invocation;
  if (!snapshot || typeof snapshot !== "object") return null;
  return {
    head: snapshot.head ?? null,
    tree: snapshot.tree ?? null,
    dirty: snapshot.dirty ?? null,
    diffHash: snapshot.diffHash ?? null,
    packageManifestHash: snapshot.packageManifestHash ?? null,
    cleanCommitEligible: source.cleanCommitEligible === true,
    stable: source.stable === true,
    releaseEligible: source.releaseEligible === true,
    mismatchReasons: Array.isArray(source.mismatchReasons) ? [...source.mismatchReasons] : null,
  };
}

export function readVerificationEvidence(reportBytes, gitFacts) {
  if (reportBytes == null) {
    return {
      provided: false,
      sha256: null,
      ok: null,
      releaseGrade: null,
      sourceSnapshot: null,
      verifiedPackageSha256: null,
      bindingStatus: "historical_report_unavailable",
      exact: false,
    };
  }
  let report;
  try {
    report = JSON.parse(Buffer.from(reportBytes).toString("utf8"));
  } catch {
    throw codedError("verification_report_invalid", "verification report is not valid JSON");
  }
  const sourceSnapshot = compactSourceSnapshot(report);
  const source = report?.releasePreflight?.sourceSnapshot;
  const packedUserProof = report?.releasePreflight?.packedUserProof;
  const currentPackage = packedUserProof?.currentPackage;
  const verifiedPackageSha256 =
    currentPackage?.packageSha256 ?? null;
  const packedCandidateProofComplete = packedProductProofComplete(packedUserProof);
  const requiredSnapshots = [source?.invocation, source?.postProbe, source?.end];
  const allSnapshots = [source?.invocation, source?.postProbe, source?.start, source?.end]
    .filter(Boolean);
  const snapshotsComplete = requiredSnapshots.every(
    (snapshot) => snapshot && typeof snapshot === "object" && snapshot.captureOk === true,
  );
  const anyDirty = allSnapshots.some((snapshot) => snapshot?.dirty !== false);
  const commitTreeExact = snapshotsComplete && allSnapshots.every(
    (snapshot) =>
      snapshot.head === gitFacts.peeledCommitSha &&
      snapshot.tree === gitFacts.peeledTreeSha,
  );
  const packageManifestExact = snapshotsComplete && allSnapshots.every(
    (snapshot) => snapshot.packageManifestHash === gitFacts.tagPackageJsonSha256,
  );
  const sourceClaimsExact =
    source?.stable === true &&
    source?.cleanCommitEligible === true &&
    source?.releaseEligible === true &&
    Array.isArray(source?.mismatchReasons) &&
    source.mismatchReasons.length === 0 &&
    Array.isArray(source?.windows) &&
    source.windows.length >= 2 &&
    source.windows.every(
      (window) =>
        window?.stable === true &&
        window?.releaseEligible === true &&
        window?.cleanCommitEligible === true &&
        Array.isArray(window?.mismatchReasons) &&
        window.mismatchReasons.length === 0,
    );
  let bindingStatus = "verification_not_release_grade";
  if (report.ok === true && report.releaseGrade === true && sourceSnapshot) {
    if (!snapshotsComplete) {
      bindingStatus = "verification_source_snapshot_incomplete";
    } else if (!isSha256Hex(verifiedPackageSha256)) {
      bindingStatus = "verification_package_candidate_missing";
    } else if (!packedCandidateProofComplete) {
      bindingStatus = "verification_package_candidate_unproven";
    } else if (!sourceClaimsExact || anyDirty) {
      bindingStatus = "verification_dirty_candidate";
    } else if (!commitTreeExact) {
      bindingStatus = "verification_targets_different_commit";
    } else if (!packageManifestExact) {
      bindingStatus = "verification_package_manifest_mismatch";
    } else {
      bindingStatus = "exact_commit_tree";
    }
  }
  return {
    provided: true,
    sha256: sha256(reportBytes),
    ok: report.ok === true,
    releaseGrade: report.releaseGrade === true,
    startedAt: report.startedAt ?? null,
    completedAt: report.completedAt ?? null,
    sourceSnapshot,
    verifiedPackageSha256: isSha256Hex(verifiedPackageSha256) ? verifiedPackageSha256 : null,
    packedCandidateProofComplete,
    bindingStatus,
    exact: bindingStatus === "exact_commit_tree",
  };
}

export function evaluateReleaseBinding({
  gitFacts,
  githubFacts,
  verification,
  localPackage = null,
}) {
  const failureReasons = [];
  if (githubFacts.draft) failureReasons.push("github_release_is_draft");
  if (githubFacts.prerelease) failureReasons.push("github_release_is_prerelease");
  if (!githubFacts.publishedAt) failureReasons.push("github_release_not_published");
  if (!["exact", "tag_commit_is_ancestor"].includes(gitFacts.remoteMainRelation)) {
    failureReasons.push("tag_commit_not_in_remote_main_history");
  }
  if (verification.exact === true && !localPackage) {
    failureReasons.push("local_package_evidence_missing_for_exact_binding");
  }
  if (verification.exact === true && !isSha256Hex(verification.verifiedPackageSha256)) {
    failureReasons.push("verified_package_candidate_missing");
  }
  if (localPackage) {
    if (localPackage.sha256 !== githubFacts.asset.sha256) {
      failureReasons.push("local_package_digest_mismatch");
    }
    if (localPackage.packageName !== gitFacts.packageName) {
      failureReasons.push("local_package_name_mismatch");
    }
    if (localPackage.packageVersion !== gitFacts.packageVersion) {
      failureReasons.push("local_package_version_mismatch");
    }
    if (localPackage.packageJsonSha256 !== gitFacts.tagPackageJsonSha256) {
      failureReasons.push("local_package_manifest_mismatch");
    }
    if (
      verification.exact === true &&
      isSha256Hex(verification.verifiedPackageSha256) &&
      (
        localPackage.sha256 !== verification.verifiedPackageSha256 ||
        githubFacts.asset.sha256 !== verification.verifiedPackageSha256
      )
    ) {
      failureReasons.push("verified_package_candidate_mismatch");
    }
  }
  const artifactsBound = failureReasons.length === 0;
  const publishedBound = artifactsBound && verification.exact === true;
  return {
    status: !artifactsBound
      ? "failed"
      : publishedBound
        ? "published_bound"
        : "published_artifacts_bound_verification_unbound",
    promotionEligible: publishedBound,
    artifactsBound,
    verificationBound: verification.exact === true,
    failureReasons,
  };
}

function safeJsonRead(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function pathIdentity(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertPlainExistingDirectory(directoryPath, label) {
  const resolved = path.resolve(directoryPath);
  let stats;
  try {
    stats = lstatSync(resolved);
  } catch (error) {
    throw codedError(
      "output_outside_repo",
      `${label} could not be inspected before release audit writes`,
    );
  }
  if (stats.isSymbolicLink()) {
    throw codedError(
      "output_outside_repo",
      `${label} must not be a symlink or junction`,
    );
  }
  const real = realpathSync.native(resolved);
  if (pathIdentity(real) !== pathIdentity(resolved)) {
    throw codedError(
      "output_outside_repo",
      `${label} resolves through a symlink or junction`,
    );
  }
  if (!stats.isDirectory()) {
    throw codedError("output_outside_repo", `${label} must be a directory`);
  }
}

function assertNearestPlainAncestor(candidatePath, label) {
  let existingAncestor = path.resolve(candidatePath);
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw codedError("output_outside_repo", `${label} has no inspectable ancestor`);
    }
    existingAncestor = parent;
  }
  assertPlainExistingDirectory(existingAncestor, `${label} ancestor`);
}

function ensurePlainDirectory(directoryPath, label) {
  const resolved = path.resolve(directoryPath);
  assertNearestPlainAncestor(resolved, label);
  mkdirSync(resolved, { recursive: true });
  assertPlainExistingDirectory(resolved, label);
  return resolved;
}

function assertOptionalPlainDirectory(directoryPath, label) {
  if (!existsSync(directoryPath)) return;
  assertPlainExistingDirectory(directoryPath, label);
}

function prepareReleaseAuditOutput(outputDir) {
  const resolvedOutputDir = ensurePlainDirectory(outputDir, "release audit output directory");
  ensurePlainDirectory(path.join(resolvedOutputDir, "attempts"), "release audit attempts directory");
  assertOptionalPlainDirectory(
    path.join(resolvedOutputDir, "stale-locks"),
    "release audit stale-locks directory",
  );
  return resolvedOutputDir;
}

function validatedRecord(recordPath) {
  const record = safeJsonRead(recordPath);
  if (!record || typeof record.recordHash !== "string") {
    throw codedError("audit_chain_head_invalid", "release audit record is missing or invalid");
  }
  const withoutHash = Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== "recordHash"),
  );
  if (sha256(canonicalJson(withoutHash)) !== record.recordHash) {
    throw codedError("audit_chain_head_invalid", "release audit record hash is invalid");
  }
  return record;
}

function validateAttemptChain(outputDir, headRecord) {
  const recordsDir = path.join(outputDir, "attempts");
  const records = new Map();
  for (const name of readdirSync(recordsDir, { withFileTypes: true })) {
    if (!name.isFile() || !name.name.endsWith(".json")) continue;
    const record = validatedRecord(path.join(recordsDir, name.name));
    if (records.has(record.recordHash)) {
      throw codedError("audit_chain_head_invalid", "release audit chain has duplicate record hashes");
    }
    records.set(record.recordHash, record);
  }
  const visited = new Set();
  let current = headRecord;
  while (current) {
    if (visited.has(current.recordHash)) {
      throw codedError("audit_chain_head_invalid", "release audit chain contains a cycle");
    }
    visited.add(current.recordHash);
    if (current.previousRecordHash == null) break;
    current = records.get(current.previousRecordHash);
    if (!current) {
      throw codedError("audit_chain_head_invalid", "release audit chain predecessor is missing");
    }
  }
}

export function validatePointer(outputDir, pointerPath) {
  if (!existsSync(pointerPath)) return null;
  const pointer = safeJsonRead(pointerPath);
  if (
    pointer?.schemaVersion !== "meta-kim-release-binding-pointer-v1" ||
    typeof pointer.attemptId !== "string" ||
    typeof pointer.recordHash !== "string" ||
    pointer.record !== `attempts/${pointer.attemptId}.json`
  ) {
    throw codedError("audit_chain_head_invalid", "release audit pointer is invalid");
  }
  const recordPath = path.join(outputDir, "attempts", `${pointer.attemptId}.json`);
  const record = validatedRecord(recordPath);
  if (record.recordHash !== pointer.recordHash) {
    throw codedError("audit_chain_head_invalid", "release audit pointer record is missing or mismatched");
  }
  validateAttemptChain(outputDir, record);
  return pointer;
}

function atomicWrite(filePath, text) {
  ensurePlainDirectory(path.dirname(filePath), "release audit pointer directory");
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = openSync(temporary, "wx", 0o600);
    writeFileSync(handle, text, "utf8");
    closeSync(handle);
    handle = null;
    renameSync(temporary, filePath);
  } finally {
    if (handle !== null && handle !== undefined) closeSync(handle);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function acquireLock(outputDir) {
  ensurePlainDirectory(outputDir, "release audit output directory");
  const lockPath = path.join(outputDir, "audit.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = openSync(lockPath, "wx", 0o600);
      writeFileSync(handle, JSON.stringify({
        pid: process.pid,
        token,
        createdAt: new Date().toISOString(),
      }));
      closeSync(handle);
      handle = undefined;
      return () => {
        try {
          const owner = safeJsonRead(lockPath);
          if (owner?.token === token && owner?.pid === process.pid) unlinkSync(lockPath);
        } catch {
          // Evidence records are immutable even if lock cleanup is interrupted.
        }
      };
    } catch (error) {
      if (handle !== undefined) closeSync(handle);
      if (error.code !== "EEXIST") throw error;
      const owner = safeJsonRead(lockPath);
      if (processIsAlive(owner?.pid)) {
        throw codedError("audit_busy", "another release-binding audit owns the output directory");
      }
      const staleDir = ensurePlainDirectory(
        path.join(outputDir, "stale-locks"),
        "release audit stale-locks directory",
      );
      try {
        renameSync(
          lockPath,
          path.join(staleDir, `${new Date().toISOString().replace(/[-:.]/gu, "")}-${randomUUID()}.json`),
        );
      } catch (renameError) {
        if (["ENOENT", "EEXIST"].includes(renameError.code)) continue;
        throw renameError;
      }
    }
  }
  throw codedError("audit_busy", "release-binding audit lock could not be acquired");
}

function attemptId(now = new Date()) {
  return `${now.toISOString().replace(/[-:.]/gu, "")}-${randomUUID()}`;
}

export function writeReleaseBindingAttempt(outputDir, recordInput) {
  const safeOutputDir = prepareReleaseAuditOutput(outputDir);
  const releaseLock = acquireLock(safeOutputDir);
  try {
    const recordsDir = ensurePlainDirectory(
      path.join(safeOutputDir, "attempts"),
      "release audit attempts directory",
    );
    const latestAttemptPath = path.join(safeOutputDir, "latest-attempt.json");
    const previousPointer = validatePointer(safeOutputDir, latestAttemptPath);
    const latestPublishedPath = path.join(safeOutputDir, "latest-published-bound.json");
    validatePointer(safeOutputDir, latestPublishedPath);
    const id = recordInput.attemptId ?? attemptId();
    const recordWithoutHash = {
      ...recordInput,
      attemptId: id,
      previousRecordHash:
        typeof previousPointer?.recordHash === "string" ? previousPointer.recordHash : null,
    };
    const recordHash = sha256(canonicalJson(recordWithoutHash));
    const record = { ...recordWithoutHash, recordHash };
    const recordPath = path.join(recordsDir, `${id}.json`);
    let handle;
    try {
      handle = openSync(recordPath, "wx", 0o600);
      writeFileSync(handle, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      closeSync(handle);
      handle = null;
    } finally {
      if (handle !== null && handle !== undefined) closeSync(handle);
    }
    const pointer = {
      schemaVersion: "meta-kim-release-binding-pointer-v1",
      attemptId: id,
      recordHash,
      status: record.status,
      record: `attempts/${id}.json`,
    };
    atomicWrite(latestAttemptPath, `${JSON.stringify(pointer, null, 2)}\n`);
    if (record.status === "published_bound") {
      atomicWrite(
        latestPublishedPath,
        `${JSON.stringify(pointer, null, 2)}\n`,
      );
    }
    return { record, recordPath, pointer };
  } finally {
    releaseLock();
  }
}

function readLocalPackage(packagePath) {
  const size = statSync(packagePath).size;
  if (size > DEFAULT_MAX_ASSET_BYTES) {
    throw codedError("release_package_too_large", "local release package exceeds 64 MiB");
  }
  const bytes = readFileSync(packagePath);
  if (bytes.length > DEFAULT_MAX_ASSET_BYTES) {
    throw codedError("release_package_too_large", "local release package exceeds 64 MiB");
  }
  const packed = readPackageManifestFromTgz(bytes);
  return {
    sha256: sha256(bytes),
    size: bytes.length,
    packageName: packed.manifest.name ?? null,
    packageVersion: packed.manifest.version ?? null,
    packageJsonSha256: packed.sha256,
  };
}

function safeRecordError(error, roots = []) {
  let message = typeof error?.message === "string"
    ? error.message.replaceAll(process.cwd(), "<repo>")
    : "release audit failed";
  for (const root of roots) {
    if (root) message = message.replaceAll(root, "<repo>");
  }
  if (process.env.USERPROFILE) message = message.replaceAll(process.env.USERPROFILE, "<home>");
  return {
    code: typeof error?.code === "string" ? error.code : "release_audit_failed",
    message,
  };
}

export async function runReleaseBindingAudit({
  repoRoot,
  tagName,
  verificationReportPath = null,
  historicalReportUnavailable = false,
  localPackagePath = null,
  outputDir,
  fetchImpl = globalThis.fetch,
  environment = process.env,
  now = new Date(),
}) {
  const id = attemptId(now);
  let recordInput;
  try {
    const gitFacts = collectGitReleaseFacts(repoRoot, tagName);
    const githubFacts = await fetchGitHubReleaseFacts(gitFacts, {
      fetchImpl,
      environment,
    });
    const reportBytes = historicalReportUnavailable
      ? null
      : readFileSync(verificationReportPath);
    const verification = readVerificationEvidence(reportBytes, gitFacts);
    const localPackage = localPackagePath ? readLocalPackage(localPackagePath) : null;
    const evaluation = evaluateReleaseBinding({
      gitFacts,
      githubFacts,
      verification,
      localPackage,
    });
    const evidence = {
      git: gitFacts,
      githubRelease: {
        url: githubFacts.url,
        targetCommitish: githubFacts.targetCommitish,
        publishedAt: githubFacts.publishedAt,
        draft: githubFacts.draft,
        prerelease: githubFacts.prerelease,
        remoteTagObjectSha: githubFacts.remoteTagObjectSha,
        remotePeeledCommitSha: githubFacts.remotePeeledCommitSha,
      },
      packageAsset: {
        ...githubFacts.asset,
        ...(localPackage ? { localVerification: localPackage } : {}),
      },
      verification,
    };
    recordInput = {
      schemaVersion: "meta-kim-release-binding-audit-v1",
      attemptId: id,
      createdAt: now.toISOString(),
      releaseVersion: gitFacts.packageVersion,
      status: evaluation.status,
      promotionEligible: evaluation.promotionEligible,
      result: evaluation,
      evidence,
      evidenceFingerprint: sha256(canonicalJson(evidence)),
      error: null,
    };
  } catch (error) {
    const safeError = safeRecordError(error, [repoRoot]);
    recordInput = {
      schemaVersion: "meta-kim-release-binding-audit-v1",
      attemptId: id,
      createdAt: now.toISOString(),
      releaseVersion: null,
      status: "failed",
      promotionEligible: false,
      result: {
        status: "failed",
        promotionEligible: false,
        artifactsBound: false,
        verificationBound: false,
        failureReasons: [safeError.code],
      },
      evidence: null,
      evidenceFingerprint: null,
      error: safeError,
    };
  }
  const written = writeReleaseBindingAttempt(outputDir, recordInput);
  if (
    written.record.status === "published_bound" &&
    verificationReportPath &&
    path.basename(path.resolve(outputDir)) === "release-binding-audit" &&
    path.basename(path.dirname(path.resolve(outputDir)))
  ) {
    const profileRoot = path.dirname(path.resolve(outputDir));
    const stateRoot = path.dirname(profileRoot);
    const metaKimRoot = path.dirname(stateRoot);
    if (path.basename(stateRoot) === "state" && path.basename(metaKimRoot) === ".meta-kim") {
      const projectRoot = path.dirname(metaKimRoot);
      const { promoteControlledRuntimeCapabilityAcceptancesForPublishedRelease } = await import("./runtime-capability-acceptance.mjs");
      written.acceptancePromotion = promoteControlledRuntimeCapabilityAcceptancesForPublishedRelease({
        projectRoot,
        profile: path.basename(profileRoot),
        auditRecordPath: written.recordPath,
      });
    }
  }
  return written;
}

function optionValue(args, name) {
  const exact = args.indexOf(name);
  if (exact >= 0) return args[exact + 1] ?? null;
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function cliOptions(args) {
  const allowedFlags = new Set([
    "--json",
    "--require-exact",
    "--historical-report-unavailable",
    "--help",
    "-h",
  ]);
  const valueNames = new Set([
    "--tag",
    "--verification-report",
    "--package-file",
    "--output-dir",
    "--profile",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (allowedFlags.has(arg)) continue;
    const equalsName = [...valueNames].find((name) => arg.startsWith(`${name}=`));
    if (equalsName) continue;
    if (valueNames.has(arg)) {
      if (!args[index + 1] || args[index + 1].startsWith("--")) {
        throw codedError("invalid_cli", `${arg} requires a value`);
      }
      index += 1;
      continue;
    }
    throw codedError("invalid_cli", `unknown option ${arg}`);
  }
  return {
    help: args.includes("--help") || args.includes("-h"),
    json: args.includes("--json"),
    requireExact: args.includes("--require-exact"),
    historicalReportUnavailable: args.includes("--historical-report-unavailable"),
    tagName: optionValue(args, "--tag"),
    verificationReportPath: optionValue(args, "--verification-report"),
    localPackagePath: optionValue(args, "--package-file"),
    outputDir: optionValue(args, "--output-dir"),
    profile: optionValue(args, "--profile") ?? environmentProfile(),
  };
}

function environmentProfile() {
  return process.env.META_KIM_PROFILE || "default";
}

function usage() {
  return [
    "Usage:",
    "  meta-kim release audit --tag <tag> [--verification-report <file>] [--package-file <tgz>] [--require-exact] [--json]",
    "  meta-kim release audit --tag <tag> --historical-report-unavailable [--json]",
    "  Optional state controls: [--profile <name>] [--output-dir <repo-relative-dir>]",
    "",
    "The audit appends an immutable attempt. A failed attempt never replaces the latest published-bound record.",
  ].join("\n");
}

function statusExplanation(status) {
  if (status === "published_bound") {
    return "Clean verification, commit/tree, annotated tag, GitHub Release, and package asset are exactly bound.";
  }
  if (status === "published_artifacts_bound_verification_unbound") {
    return "Release assets are bound, but the historical verification report is unavailable or not exact; promotion is not allowed.";
  }
  return "Release binding failed; inspect failureReasons and the immutable attempt record.";
}

export function requireContainedOutput(repoRoot, candidate) {
  const resolvedRepo = path.resolve(repoRoot);
  const resolvedCandidate = path.resolve(candidate);
  const lexicalRelative = path.relative(resolvedRepo, resolvedCandidate);
  if (
    lexicalRelative.startsWith("..") ||
    path.isAbsolute(lexicalRelative)
  ) {
    throw codedError("output_outside_repo", "release audit output must stay inside the repository");
  }
  const realRepo = realpathSync.native(resolvedRepo);
  let existingAncestor = resolvedCandidate;
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw codedError("output_outside_repo", "release audit output has no valid repository ancestor");
    }
    existingAncestor = parent;
  }
  const realAncestor = realpathSync.native(existingAncestor);
  const ancestorRelative = path.relative(realRepo, realAncestor);
  if (ancestorRelative.startsWith("..") || path.isAbsolute(ancestorRelative)) {
    throw codedError(
      "output_outside_repo",
      "release audit output resolves outside the repository through a link",
    );
  }
  mkdirSync(resolvedCandidate, { recursive: true });
  const realCandidate = realpathSync.native(resolvedCandidate);
  const realRelative = path.relative(realRepo, realCandidate);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw codedError(
      "output_outside_repo",
      "release audit output resolves outside the repository through a link",
    );
  }
  return realCandidate;
}

async function main() {
  let options;
  try {
    options = cliOptions(process.argv.slice(2));
  } catch (error) {
    console.error(`meta-kim release audit: ${error.message}`);
    console.error(usage());
    process.exit(2);
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.tagName) {
    console.error("meta-kim release audit: --tag is required");
    console.error(usage());
    process.exit(2);
  }
  if (options.historicalReportUnavailable && options.verificationReportPath) {
    console.error(
      "meta-kim release audit: choose a verification report or --historical-report-unavailable, not both",
    );
    process.exit(2);
  }
  const repoRoot = path.resolve(process.env.META_KIM_CALLER_CWD || process.cwd());
  const profilePaths = getProfilePaths({ repoPath: repoRoot, profile: options.profile });
  const outputDir = requireContainedOutput(repoRoot, options.outputDir
    ? path.resolve(repoRoot, options.outputDir)
    : path.join(profilePaths.profileDir, "release-binding-audit"));
  const verificationReportPath = options.historicalReportUnavailable
    ? null
    : path.resolve(
        repoRoot,
        options.verificationReportPath ||
          path.relative(repoRoot, path.join(profilePaths.profileDir, "verification-report.json")),
      );
  const localPackagePath = options.localPackagePath
    ? path.resolve(repoRoot, options.localPackagePath)
    : null;
  const { record, recordPath } = await runReleaseBindingAudit({
    repoRoot,
    tagName: options.tagName,
    verificationReportPath,
    historicalReportUnavailable: options.historicalReportUnavailable,
    localPackagePath,
    outputDir,
  });
  const output = {
    status: record.status,
    promotionEligible: record.promotionEligible,
    attemptId: record.attemptId,
    releaseVersion: record.releaseVersion,
    record: path.relative(repoRoot, recordPath).replaceAll("\\", "/"),
    failureReasons: record.result.failureReasons,
    error: record.error,
    explanation: statusExplanation(record.status),
  };
  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`status=${output.status}`);
    console.log(`promotionEligible=${output.promotionEligible}`);
    console.log(`explanation=${output.explanation}`);
    console.log(`record=${output.record}`);
    if (output.failureReasons.length) {
      console.log(`failureReasons=${output.failureReasons.join(",")}`);
    }
  }
  if (record.status === "failed" || (options.requireExact && !record.promotionEligible)) {
    process.exit(1);
  }
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    await main();
  } catch (error) {
    const safe = safeRecordError(error);
    console.error(`meta-kim release audit: ${safe.code}: ${safe.message}`);
    process.exit(1);
  }
}
