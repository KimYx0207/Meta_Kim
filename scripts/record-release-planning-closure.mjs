#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  collectGitReleaseFacts,
  evaluateReleaseBinding,
  fetchGitHubReleaseFacts,
  readPackageManifestFromTgz,
  readVerificationEvidence,
  requireContainedOutput,
  sha256,
  validatePointer,
} from "./audit-release-binding.mjs";
import {
  DEFAULT_GLOBAL_CHECK_TIMEOUT_MS,
  DEFAULT_RELEASE_ASSET_TIMEOUT_MS,
  DEFAULT_RELEASE_METADATA_TIMEOUT_MS,
  resolveTimeoutMs,
} from "./release-network.mjs";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLANNING_FILES = ["task_plan.md", "findings.md", "progress.md"];
const ISSUE_PATTERN = /^P-\d{3}$/u;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const POINTER_SCHEMA = "meta-kim-release-binding-pointer-v1";
const AUDIT_SCHEMA = "meta-kim-release-binding-audit-v1";
const CLOSURE_SCHEMA = "meta-kim-release-planning-closure-v1";
const SHA1_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isContained(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveExistingPlainFile(repoRoot, requestedPath, label) {
  if (typeof requestedPath !== "string" || !requestedPath || path.isAbsolute(requestedPath)) {
    throw codedError("path_invalid", `${label} must be a repository-relative path`);
  }
  const resolved = path.resolve(repoRoot, requestedPath);
  if (!isContained(repoRoot, resolved) || !existsSync(resolved)) {
    throw codedError("path_invalid", `${label} must exist inside the repository`);
  }
  const stats = lstatSync(resolved);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw codedError("path_invalid", `${label} must be a plain file`);
  }
  const realRepo = realpathSync.native(repoRoot);
  const realFile = realpathSync.native(resolved);
  if (!isContained(realRepo, realFile)) {
    throw codedError("path_invalid", `${label} resolves outside the repository`);
  }
  return resolved;
}

function assertNoLinkedAncestors(repoRoot, candidate, label) {
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(candidate);
  if (!isContained(root, resolved)) {
    throw codedError("path_invalid", `${label} escapes the repository`);
  }
  const relative = path.relative(root, resolved);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) {
      throw codedError("path_invalid", `${label} contains a linked path component`);
    }
  }
}

function defaultRun(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

function commandResult(
  runCommand,
  command,
  args,
  options,
  errorCode,
  message,
  timeoutCode = `${errorCode}_timeout`,
) {
  const result = runCommand(command, args, options);
  if (result?.error?.code === "ETIMEDOUT" || result?.signal === "SIGTERM" && options?.timeout) {
    throw codedError(timeoutCode, `${message} timed out`);
  }
  if (result.status !== 0) {
    throw codedError(errorCode, message);
  }
  return result;
}

function gitText(runCommand, repoRoot, args, errorCode, message) {
  return commandResult(
    runCommand,
    "git",
    args,
    { cwd: repoRoot },
    errorCode,
    message,
  ).stdout.trim();
}

function validatePrdQueue(prdText, issueId) {
  const startMarkers = prdText.match(/<!-- CURRENT_QUEUE_START -->/gu) || [];
  const endMarkers = prdText.match(/<!-- CURRENT_QUEUE_END -->/gu) || [];
  if (startMarkers.length !== 1 || endMarkers.length !== 1) {
    throw codedError("prd_queue_invalid", "PRD must contain exactly one current queue block");
  }
  const start = prdText.indexOf("<!-- CURRENT_QUEUE_START -->");
  const end = prdText.indexOf("<!-- CURRENT_QUEUE_END -->");
  if (start < 0 || end <= start) {
    throw codedError("prd_queue_invalid", "PRD is missing the unique current queue block");
  }
  const active = [...prdText.slice(start, end).matchAll(/^\|\s*ACTIVE\s*\|\s*(P-\d{3})\s*\|/gmu)];
  if (active.length !== 1) {
    throw codedError("prd_queue_invalid", "PRD must contain exactly one ACTIVE queue row");
  }
  if (active[0][1] !== issueId) {
    throw codedError(
      "prd_issue_mismatch",
      `PRD ACTIVE is ${active[0][1]}, not requested issue ${issueId}`,
    );
  }
}

function validatePlanningMarkers(content, planningFile) {
  const tokens = [...content.matchAll(
    /<!-- META_KIM_RELEASE_CLOSURE:([^\r\n]*):(START|END) -->/gu,
  )];
  const markerPrefixes = content.match(/<!-- META_KIM_RELEASE_CLOSURE:/gu) || [];
  if (tokens.length !== markerPrefixes.length) {
    throw codedError(
      "planning_projection_conflict",
      `${planningFile} contains a malformed release-closure marker`,
    );
  }
  const completed = new Set();
  let openId = null;
  for (const token of tokens) {
    const [, id, kind] = token;
    if (kind === "START") {
      if (openId != null || completed.has(id)) {
        throw codedError(
          "planning_projection_conflict",
          `${planningFile} contains nested or duplicate release-closure blocks`,
        );
      }
      openId = id;
    } else if (openId !== id) {
      throw codedError(
        "planning_projection_conflict",
        `${planningFile} contains an unmatched release-closure end marker`,
      );
    } else {
      completed.add(id);
      openId = null;
    }
  }
  if (openId != null) {
    throw codedError(
      "planning_projection_conflict",
      `${planningFile} contains an incomplete release-closure block`,
    );
  }
}

function assertPublishedPointerAncestry(repoRoot, auditRoot, publishedPointer) {
  const latestAttemptPath = resolveExistingPlainFile(
    repoRoot,
    path.relative(repoRoot, path.join(auditRoot, "latest-attempt.json")),
    "latest release-audit attempt pointer",
  );
  let latestPointer;
  try {
    latestPointer = validatePointer(auditRoot, latestAttemptPath);
  } catch (error) {
    throw codedError("release_audit_invalid", `latest release audit chain is invalid: ${error.message}`);
  }
  const records = new Map();
  const attemptsDir = path.join(auditRoot, "attempts");
  for (const entry of readdirSync(attemptsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const record = JSON.parse(readFileSync(path.join(attemptsDir, entry.name), "utf8"));
    records.set(record.recordHash, record);
  }
  let current = records.get(latestPointer.recordHash);
  while (current) {
    if (current.recordHash === publishedPointer.recordHash) return;
    current = current.previousRecordHash == null ? null : records.get(current.previousRecordHash);
  }
  throw codedError(
    "release_audit_invalid",
    "latest published-bound audit is detached from the latest audit attempt chain",
  );
}

function readAndValidateAudit(repoRoot, profile, packageVersion, head, tagCommit, tagObject) {
  const auditRoot = path.join(
    repoRoot,
    ".meta-kim",
    "state",
    profile,
    "release-binding-audit",
  );
  assertNoLinkedAncestors(repoRoot, auditRoot, "release audit directory");
  const pointerPath = resolveExistingPlainFile(
    repoRoot,
    path.relative(repoRoot, path.join(auditRoot, "latest-published-bound.json")),
    "latest published-bound pointer",
  );
  try {
    validatePointer(auditRoot, pointerPath);
  } catch (error) {
    throw codedError("release_audit_invalid", `release audit chain is invalid: ${error.message}`);
  }
  const pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
  if (
    pointer.schemaVersion !== POINTER_SCHEMA ||
    pointer.status !== "published_bound" ||
    typeof pointer.record !== "string" ||
    path.isAbsolute(pointer.record)
  ) {
    throw codedError("release_audit_invalid", "latest published-bound pointer is invalid");
  }
  assertPublishedPointerAncestry(repoRoot, auditRoot, pointer);
  const recordPath = path.resolve(auditRoot, pointer.record);
  const expectedRecordPath = path.join(auditRoot, "attempts", `${pointer.attemptId}.json`);
  if (!isContained(auditRoot, recordPath) || path.resolve(recordPath) !== path.resolve(expectedRecordPath)) {
    throw codedError("release_audit_invalid", "release audit record escapes its state directory");
  }
  const record = JSON.parse(readFileSync(
    resolveExistingPlainFile(
      repoRoot,
      path.relative(repoRoot, recordPath),
      "release audit record",
    ),
    "utf8",
  ));
  const { recordHash, ...recordWithoutHash } = record;
  if (
    record.schemaVersion !== AUDIT_SCHEMA ||
    record.status !== "published_bound" ||
    record.promotionEligible !== true ||
    record.result?.status !== "published_bound" ||
    record.result?.promotionEligible !== true ||
    record.result?.artifactsBound !== true ||
    record.result?.verificationBound !== true ||
    recordHash !== sha256(canonicalJson(recordWithoutHash)) ||
    pointer.recordHash !== recordHash ||
    pointer.attemptId !== record.attemptId ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(record.attemptId || "") ||
    record.releaseVersion !== packageVersion ||
    record.evidence?.git?.tagName !== `v${packageVersion}` ||
    record.evidence?.git?.packageVersion !== packageVersion ||
    record.evidence?.git?.tagObjectSha !== tagObject ||
    record.evidence?.git?.peeledCommitSha !== head ||
    record.evidence?.git?.peeledCommitSha !== tagCommit ||
    !SHA1_PATTERN.test(record.evidence?.git?.peeledTreeSha || "") ||
    record.evidence?.git?.remoteMainSha !== head ||
    record.evidence?.git?.remoteMainRelation !== "exact" ||
    record.evidence?.githubRelease?.draft !== false ||
    record.evidence?.githubRelease?.prerelease !== false ||
    typeof record.evidence?.githubRelease?.url !== "string" ||
    !/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/tag\/v[^/]+$/u.test(
      record.evidence.githubRelease.url,
    ) ||
    !record.evidence.githubRelease.url.endsWith(`/tag/v${packageVersion}`) ||
    !SHA256_PATTERN.test(record.evidence?.packageAsset?.sha256 || "") ||
    !Number.isFinite(Date.parse(record.createdAt || ""))
  ) {
    throw codedError(
      "release_audit_invalid",
      "published release audit does not exactly bind the current version, HEAD, tag, remote main, and Release",
    );
  }
  return { pointer, record, recordPath };
}

function findVerificationReport(repoRoot, profile, expectedSha256) {
  if (!SHA256_PATTERN.test(expectedSha256 || "")) {
    throw codedError("release_audit_invalid", "published audit lacks an exact verification report digest");
  }
  const attemptsDir = path.join(
    repoRoot,
    ".meta-kim",
    "state",
    profile,
    "verification-reports",
    "attempts",
  );
  assertNoLinkedAncestors(repoRoot, attemptsDir, "verification report attempts directory");
  if (!existsSync(attemptsDir) || !lstatSync(attemptsDir).isDirectory()) {
    throw codedError("verification_report_missing", "exact verification report directory is unavailable");
  }
  const matches = [];
  for (const entry of readdirSync(attemptsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const candidate = path.join(attemptsDir, entry.name);
    assertNoLinkedAncestors(repoRoot, candidate, "verification report");
    const bytes = readFileSync(candidate);
    if (sha256(bytes) === expectedSha256) matches.push(bytes);
  }
  if (matches.length !== 1) {
    throw codedError(
      "verification_report_missing",
      "exactly one local verification report must match the published audit digest",
    );
  }
  return matches[0];
}

export async function verifyPublishedReleaseExact({
  repoRoot,
  profile,
  tag,
  storedAudit,
  environment = process.env,
  metadataTimeoutMs = null,
  assetTimeoutMs = null,
  platform = process.platform,
  systemProxyReader,
} = {}) {
  const gitFacts = collectGitReleaseFacts(repoRoot, tag, { environment });
  const reportBytes = findVerificationReport(
    repoRoot,
    profile,
    storedAudit.evidence?.verification?.sha256,
  );
  const verification = readVerificationEvidence(reportBytes, gitFacts);
  const githubFacts = await fetchGitHubReleaseFacts(gitFacts, {
    environment,
    metadataTimeoutMs,
    assetTimeoutMs,
    platform,
    systemProxyReader,
    downloadAsset: true,
  });
  const packed = readPackageManifestFromTgz(githubFacts.downloadedBytes);
  const localPackage = {
    sha256: sha256(githubFacts.downloadedBytes),
    size: githubFacts.downloadedBytes.length,
    packageName: packed.manifest.name,
    packageVersion: packed.manifest.version,
    packageJsonSha256: packed.sha256,
  };
  const result = evaluateReleaseBinding({
    gitFacts,
    githubFacts,
    verification,
    localPackage,
  });
  const stored = storedAudit.evidence;
  if (
    result.status !== "published_bound" ||
    result.promotionEligible !== true ||
    gitFacts.tagObjectSha !== stored.git?.tagObjectSha ||
    gitFacts.peeledCommitSha !== stored.git?.peeledCommitSha ||
    gitFacts.peeledTreeSha !== stored.git?.peeledTreeSha ||
    gitFacts.remoteMainSha !== stored.git?.remoteMainSha ||
    gitFacts.remoteMainRelation !== "exact" ||
    githubFacts.url !== stored.githubRelease?.url ||
    githubFacts.asset.sha256 !== stored.packageAsset?.sha256 ||
    verification.sha256 !== stored.verification?.sha256 ||
    verification.exact !== true ||
    localPackage.sha256 !== stored.packageAsset?.sha256
  ) {
    throw codedError(
      "release_exact_recheck_failed",
      "live GitHub release, package, verification report, tag, and remote main no longer exactly match the audit",
    );
  }
  return { gitFacts, githubFacts, verification, localPackage, result };
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

function acquireClosureLock(repoRoot, stateDir, now) {
  mkdirSync(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, "planning-closure.lock");
  const staleDir = path.join(stateDir, "stale-locks");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assertNoLinkedAncestors(repoRoot, lockPath, "planning closure lock");
    assertNoLinkedAncestors(repoRoot, staleDir, "planning closure stale-locks directory");
    const token = randomUUID();
    let handle;
    try {
      handle = openSync(lockPath, "wx", 0o600);
      writeFileSync(handle, jsonText({ pid: process.pid, token, createdAt: now().toISOString() }));
      closeSync(handle);
      handle = undefined;
      return () => {
        try {
          const owner = JSON.parse(readFileSync(lockPath, "utf8"));
          if (owner.pid === process.pid && owner.token === token) unlinkSync(lockPath);
        } catch {
          // The immutable audit and closure record remain authoritative.
        }
      };
    } catch (error) {
      if (handle !== undefined) closeSync(handle);
      if (error.code !== "EEXIST") throw error;
      const lockStats = lstatSync(lockPath);
      if (!lockStats.isFile() || lockStats.isSymbolicLink()) {
        throw codedError("planning_closure_lock_invalid", "planning closure lock must be a plain file");
      }
      let owner = null;
      try {
        owner = JSON.parse(readFileSync(lockPath, "utf8"));
      } catch {
        // A malformed lock is recoverable only after it is no longer brand new.
      }
      const malformedOldEnough = !owner && Date.now() - statSync(lockPath).mtimeMs >= 2_000;
      if ((owner && !processIsAlive(owner.pid)) || malformedOldEnough) {
        mkdirSync(staleDir, { recursive: true });
        assertNoLinkedAncestors(repoRoot, staleDir, "planning closure stale-locks directory");
        renameSync(
          lockPath,
          path.join(staleDir, `${now().toISOString().replace(/[-:.]/gu, "")}-${randomUUID()}.json`),
        );
        continue;
      }
      throw codedError("planning_closure_busy", "another planning-closure writer owns the state");
    }
  }
  throw codedError("planning_closure_busy", "planning-closure lock could not be acquired");
}

function atomicWrite(filePath, text, expectedSha256 = null) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = openSync(temporary, "wx", 0o600);
    writeFileSync(handle, text, "utf8");
    closeSync(handle);
    handle = undefined;
    if (expectedSha256 != null && sha256(readFileSync(filePath)) !== expectedSha256) {
      throw codedError("planning_file_changed", "planning file changed during release-closure projection");
    }
    renameSync(temporary, filePath);
  } finally {
    if (handle !== undefined) closeSync(handle);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function immutableWrite(filePath, text) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = openSync(temporary, "wx", 0o600);
    writeFileSync(handle, text, "utf8");
    closeSync(handle);
    handle = undefined;
    linkSync(temporary, filePath);
  } finally {
    if (handle !== undefined) closeSync(handle);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function markerText(record, planningFile) {
  const id = `${record.issueId}-${record.tag}-${record.audit.attemptId}`;
  const start = `<!-- META_KIM_RELEASE_CLOSURE:${id}:START -->`;
  const end = `<!-- META_KIM_RELEASE_CLOSURE:${id}:END -->`;
  const common = [
    `- 发布：${record.tag}（commit \`${record.commit}\`）`,
    `- GitHub Release：${record.releaseUrl}`,
    `- 精确审计：\`published_bound\` / \`${record.audit.attemptId}\``,
    `- 全局状态：Claude Code 与 Codex 检查通过`,
    `- 唯一队列：\`${record.prdPath}\`；本段只是发布事实投影，不是第二份任务队列。`,
  ];
  const title = `## ${record.releaseBoundAt.slice(0, 10)} — ${record.issueId} ${record.tag} 发布收尾`;
  const perFile = {
    "task_plan.md": ["- [x] 代码、验证、发布审计和双主运行端全局状态已闭合。", ...common],
    "findings.md": ["- 公开连续性由更新日志、Git 标签、GitHub Release 与发布审计共同提供；私有 PRD 不公开。", ...common],
    "progress.md": ["- 当前状态：release_closed。下一个事项只能从唯一 PRD 的 CURRENT_QUEUE 读取。", ...common],
  };
  return `${start}\n${title}\n\n${perFile[planningFile].join("\n")}\n${end}`;
}

function projectClosureBlock(
  repoRoot,
  planningFile,
  record,
  stateDir,
  expectedPresent,
  afterProjectionWrite,
) {
  const target = path.join(repoRoot, planningFile);
  if (existsSync(target) !== expectedPresent) {
    throw codedError("planning_file_changed", `${planningFile} presence changed before projection`);
  }
  if (!expectedPresent) return "absent_preserved";
  resolveExistingPlainFile(repoRoot, planningFile, planningFile);
  const block = markerText(record, planningFile);
  const start = block.split("\n", 1)[0];
  const end = block.trimEnd().split("\n").at(-1);
  const current = readFileSync(target, "utf8");
  validatePlanningMarkers(current, planningFile);
  const startCount = current.split(start).length - 1;
  const endCount = current.split(end).length - 1;
  if (startCount === 1 && endCount === 1 && current.includes(block)) return "already_current";
  if (startCount !== 0 || endCount !== 0) {
    throw codedError(
      "planning_projection_conflict",
      `${planningFile} contains a partial or conflicting release-closure marker`,
    );
  }
  const backupDir = requireContainedOutput(
    repoRoot,
    path.join(stateDir, "backups", `${record.issueId}-${record.tag}-${record.audit.attemptId}`),
  );
  assertNoLinkedAncestors(repoRoot, backupDir, "planning closure backup directory");
  const backup = path.join(backupDir, planningFile);
  if (!existsSync(backup)) {
    immutableWrite(backup, Buffer.from(current, "utf8"));
  } else {
    resolveExistingPlainFile(
      repoRoot,
      path.relative(repoRoot, backup),
      "planning closure backup",
    );
    if (sha256(readFileSync(backup)) !== sha256(Buffer.from(current, "utf8"))) {
      throw codedError("planning_backup_conflict", `${planningFile} backup conflicts with current content`);
    }
  }
  const separator = current.length === 0
    ? ""
    : current.endsWith("\n\n")
      ? ""
      : current.endsWith("\n")
        ? "\n"
        : "\n\n";
  atomicWrite(target, `${current}${separator}${block}\n`, sha256(Buffer.from(current, "utf8")));
  afterProjectionWrite?.(planningFile);
  return "appended";
}

function validateProjectedState(repoRoot, record, expectedPlanningFiles) {
  const expected = new Set(expectedPlanningFiles);
  for (const planningFile of PLANNING_FILES) {
    const target = path.join(repoRoot, planningFile);
    if (existsSync(target) !== expected.has(planningFile)) {
      throw codedError("planning_file_changed", `${planningFile} presence changed during projection`);
    }
    if (!expected.has(planningFile)) continue;
    resolveExistingPlainFile(repoRoot, planningFile, planningFile);
    const content = readFileSync(target, "utf8");
    validatePlanningMarkers(content, planningFile);
    if (!content.includes(markerText(record, planningFile))) {
      throw codedError("planning_file_changed", `${planningFile} closure block changed during projection`);
    }
  }
}

function validateExistingClosureRecord(recordPath, expected) {
  const current = JSON.parse(readFileSync(recordPath, "utf8"));
  const { recordHash, ...withoutHash } = current;
  const allowedKeys = [
    "schemaVersion",
    "issueId",
    "version",
    "tag",
    "commit",
    "tree",
    "releaseUrl",
    "packageSha256",
    "prdPath",
    "audit",
    "globalCheck",
    "planningFiles",
    "releaseBoundAt",
    "recordedAt",
    "projectionResults",
    "recordHash",
  ].sort();
  if (
    !SHA256_PATTERN.test(recordHash || "") ||
    recordHash !== sha256(canonicalJson(withoutHash)) ||
    canonicalJson(Object.keys(current).sort()) !== canonicalJson(allowedKeys) ||
    !Array.isArray(current.planningFiles) ||
    new Set(current.planningFiles).size !== current.planningFiles.length ||
    !current.planningFiles.every((file) => PLANNING_FILES.includes(file)) ||
    canonicalJson(Object.keys(current.projectionResults || {}).sort()) !==
      canonicalJson([...PLANNING_FILES].sort()) ||
    !Object.values(current.projectionResults || {}).every((value) =>
      ["appended", "already_current", "absent_preserved"].includes(value)) ||
    PLANNING_FILES.some((file) =>
      current.planningFiles.includes(file)
        ? current.projectionResults[file] === "absent_preserved"
        : current.projectionResults[file] !== "absent_preserved") ||
    current.audit?.status !== "published_bound" ||
    canonicalJson(current.globalCheck?.targets) !== canonicalJson(["claude", "codex"]) ||
    current.globalCheck?.command !==
      "node scripts/sync-global-meta-theory.mjs --check --targets claude,codex --with-global-hooks" ||
    !SHA256_PATTERN.test(current.globalCheck?.outputSha256 || "") ||
    !Number.isFinite(Date.parse(current.recordedAt || ""))
  ) {
    throw codedError("closure_record_conflict", "existing closure record failed full integrity validation");
  }
  for (const key of [
    "schemaVersion",
    "issueId",
    "version",
    "tag",
    "commit",
    "tree",
    "releaseUrl",
    "packageSha256",
    "prdPath",
    "releaseBoundAt",
  ]) {
    if (current[key] !== expected[key]) {
      throw codedError("closure_record_conflict", "existing closure record conflicts with current release evidence");
    }
  }
  if (current.audit?.attemptId !== expected.audit.attemptId) {
    throw codedError("closure_record_conflict", "existing closure record binds a different audit attempt");
  }
  if (
    current.audit?.recordHash !== expected.audit.recordHash ||
    canonicalJson(current.globalCheck?.targets) !== canonicalJson(expected.globalCheck.targets)
  ) {
    throw codedError("closure_record_conflict", "existing closure record binds different release evidence");
  }
  return current;
}

function assertIgnoredFiles(runCommand, repoRoot, files, code, message) {
  for (const file of files) {
    const result = runCommand("git", ["check-ignore", "--quiet", "--", file], { cwd: repoRoot });
    if (result.status !== 0) throw codedError(code, message);
  }
}

function sanitizedGlobalEnvironment(environment, trustedUserHome) {
  const clean = { ...environment };
  for (const key of Object.keys(clean)) {
    const upperKey = key.toUpperCase();
    if (
      upperKey.startsWith("META_KIM_") ||
      upperKey.startsWith("GIT_") ||
      [
        "HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "CLAUDE_HOME",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "CODEX_CONFIG_DIR",
        "NODE_OPTIONS",
        "NODE_PATH",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "NPM_TOKEN",
      ].includes(upperKey)
    ) {
      delete clean[key];
    }
  }
  clean.HOME = trustedUserHome;
  clean.USERPROFILE = trustedUserHome;
  if (process.platform === "win32") {
    const parsed = path.parse(trustedUserHome);
    clean.HOMEDRIVE = parsed.root.replace(/[\\/]$/u, "");
    clean.HOMEPATH = trustedUserHome.slice(parsed.root.length - 1);
  }
  return clean;
}

function sanitizedGitEnvironment(environment) {
  const clean = { ...environment };
  for (const key of Object.keys(clean)) {
    if (key.toUpperCase().startsWith("GIT_")) delete clean[key];
  }
  return clean;
}

export async function recordReleasePlanningClosure({
  repoRoot,
  callerCwd = path.resolve(process.env.META_KIM_CALLER_CWD || process.cwd()),
  packageRoot = PACKAGE_ROOT,
  issueId,
  prdPath,
  profile = "default",
  runCommand = defaultRun,
  environment = process.env,
  trustedUserHome = userInfo().homedir,
  verifyExactRelease = verifyPublishedReleaseExact,
  globalCheckTimeoutMs = null,
  metadataTimeoutMs = null,
  assetTimeoutMs = null,
  platform = process.platform,
  systemProxyReader,
  now = () => new Date(),
  afterProjectionWrite,
  beforeRecordPublish,
} = {}) {
  if (!ISSUE_PATTERN.test(issueId || "")) {
    throw codedError("issue_invalid", "--issue must use a value such as P-128");
  }
  if (!PROFILE_PATTERN.test(profile || "")) {
    throw codedError("profile_invalid", "--profile contains unsupported characters");
  }
  globalCheckTimeoutMs = resolveTimeoutMs(
    globalCheckTimeoutMs,
    DEFAULT_GLOBAL_CHECK_TIMEOUT_MS,
    "global check timeout",
  );
  metadataTimeoutMs = resolveTimeoutMs(
    metadataTimeoutMs,
    DEFAULT_RELEASE_METADATA_TIMEOUT_MS,
    "release metadata timeout",
  );
  assetTimeoutMs = resolveTimeoutMs(
    assetTimeoutMs,
    DEFAULT_RELEASE_ASSET_TIMEOUT_MS,
    "release asset timeout",
  );
  const callerRunCommand = runCommand;
  const gitEnvironment = sanitizedGitEnvironment(environment);
  runCommand = (command, args, options = {}) => callerRunCommand(
    command,
    args,
    command === "git" ? { ...options, env: gitEnvironment } : options,
  );
  const repoWasDiscovered = repoRoot == null;
  if (repoRoot == null) {
    repoRoot = gitText(
      runCommand,
      callerCwd,
      ["rev-parse", "--show-toplevel"],
      "git_root_failed",
      "caller directory is not inside a Git repository",
    );
  }
  repoRoot = realpathSync.native(path.resolve(repoRoot));
  if (repoWasDiscovered) {
    const realCaller = realpathSync.native(path.resolve(callerCwd));
    if (!isContained(repoRoot, realCaller)) {
      throw codedError("git_root_failed", "Git top-level does not own the caller directory");
    }
  }
  const prdFile = resolveExistingPlainFile(repoRoot, prdPath, "PRD");
  const normalizedPrdPath = path.relative(repoRoot, prdFile).replaceAll("\\", "/");
  const prdText = readFileSync(prdFile, "utf8");
  validatePrdQueue(prdText, issueId);
  const prdDigest = sha256(prdText);
  assertIgnoredFiles(
    runCommand,
    repoRoot,
    [normalizedPrdPath],
    "prd_not_private",
    "PRD must remain gitignored and local-private",
  );
  const trackedState = gitText(
    runCommand,
    repoRoot,
    ["status", "--porcelain=v1", "--untracked-files=no"],
    "git_status_failed",
    "tracked worktree state could not be checked",
  );
  if (trackedState) {
    throw codedError("tracked_worktree_dirty", "tracked worktree must be clean before release closure");
  }
  const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const version = packageJson.version;
  const callerPackage = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  if (callerPackage.version !== version) {
    throw codedError("package_version_mismatch", "caller repository and release CLI package versions differ");
  }
  const tag = `v${version}`;
  const head = gitText(runCommand, repoRoot, ["rev-parse", "HEAD"], "git_head_failed", "HEAD unavailable");
  const tagCommit = gitText(
    runCommand,
    repoRoot,
    ["rev-parse", `${tag}^{}`],
    "git_tag_failed",
    `${tag} annotated tag is unavailable`,
  );
  const tagObject = gitText(
    runCommand,
    repoRoot,
    ["rev-parse", `refs/tags/${tag}`],
    "git_tag_failed",
    `${tag} tag object is unavailable`,
  );
  const tagType = gitText(
    runCommand,
    repoRoot,
    ["cat-file", "-t", tagObject],
    "git_tag_failed",
    `${tag} tag type is unavailable`,
  );
  if (tagType !== "tag") {
    throw codedError("annotated_tag_required", `${tag} must remain an annotated tag`);
  }
  const audit = readAndValidateAudit(repoRoot, profile, version, head, tagCommit, tagObject);
  const globalCheckArgs = [
    path.join(packageRoot, "scripts", "sync-global-meta-theory.mjs"),
    "--check",
    "--targets",
    "claude,codex",
    "--with-global-hooks",
  ];
  const requestedStateDir = path.join(
    repoRoot,
    ".meta-kim",
    "state",
    profile,
    "planning-closures",
  );
  assertNoLinkedAncestors(repoRoot, requestedStateDir, "planning closure state directory");
  const stateDir = requireContainedOutput(repoRoot, requestedStateDir);
  const releaseLock = acquireClosureLock(repoRoot, stateDir, now);
  try {
    const revalidateLocalState = () => {
      const lockedPrdText = readFileSync(prdFile, "utf8");
      validatePrdQueue(lockedPrdText, issueId);
      if (sha256(lockedPrdText) !== prdDigest) {
        throw codedError("prd_changed", "PRD changed between release validation and closure write");
      }
      assertIgnoredFiles(
        runCommand,
        repoRoot,
        [normalizedPrdPath],
        "prd_not_private",
        "PRD must remain gitignored and local-private",
      );
      const lockedTrackedState = gitText(
        runCommand,
        repoRoot,
        ["status", "--porcelain=v1", "--untracked-files=no"],
        "git_status_failed",
        "tracked worktree state could not be rechecked",
      );
      if (lockedTrackedState) {
        throw codedError("tracked_worktree_dirty", "tracked worktree changed before release closure write");
      }
      const lockedCallerPackage = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
      if (lockedCallerPackage.version !== version) {
        throw codedError("package_version_mismatch", "caller repository version changed before closure write");
      }
      const lockedHead = gitText(
        runCommand,
        repoRoot,
        ["rev-parse", "HEAD"],
        "git_head_failed",
        "HEAD unavailable",
      );
      const lockedTagCommit = gitText(
        runCommand,
        repoRoot,
        ["rev-parse", `${tag}^{}`],
        "git_tag_failed",
        `${tag} annotated tag is unavailable`,
      );
      const lockedTagObject = gitText(
        runCommand,
        repoRoot,
        ["rev-parse", `refs/tags/${tag}`],
        "git_tag_failed",
        `${tag} tag object is unavailable`,
      );
      const lockedTagType = gitText(
        runCommand,
        repoRoot,
        ["cat-file", "-t", lockedTagObject],
        "git_tag_failed",
        `${tag} tag type is unavailable`,
      );
      if (
        lockedHead !== head ||
        lockedTagCommit !== tagCommit ||
        lockedTagObject !== tagObject ||
        lockedTagType !== "tag"
      ) {
        throw codedError("release_state_changed", "HEAD or release tag changed before closure write");
      }
      const lockedAudit = readAndValidateAudit(
        repoRoot,
        profile,
        version,
        lockedHead,
        lockedTagCommit,
        lockedTagObject,
      );
      if (
        lockedAudit.record.attemptId !== audit.record.attemptId ||
        lockedAudit.record.recordHash !== audit.record.recordHash
      ) {
        throw codedError("release_state_changed", "latest published-bound audit changed before closure write");
      }
      const existingPlanningFiles = PLANNING_FILES.filter((file) => existsSync(path.join(repoRoot, file)));
      if (existingPlanningFiles.length === 0) {
        throw codedError("planning_files_missing", "no existing planning files are available for release closure");
      }
      for (const file of existingPlanningFiles) resolveExistingPlainFile(repoRoot, file, file);
      assertIgnoredFiles(
        runCommand,
        repoRoot,
        existingPlanningFiles,
        "planning_files_not_private",
        "planning files must remain gitignored and local-private",
      );
      return { lockedAudit, existingPlanningFiles };
    };
    let { lockedAudit, existingPlanningFiles } = revalidateLocalState();
    const globalCheck = commandResult(
      runCommand,
      process.execPath,
      globalCheckArgs,
      {
        cwd: packageRoot,
        env: sanitizedGlobalEnvironment(environment, trustedUserHome),
        timeout: globalCheckTimeoutMs,
      },
      "global_check_failed",
      "Claude Code and Codex global release check failed",
      "global_check_timeout",
    );
    ({ lockedAudit, existingPlanningFiles } = revalidateLocalState());
    await verifyExactRelease({
      repoRoot,
      profile,
      tag,
      storedAudit: lockedAudit.record,
      environment,
      metadataTimeoutMs,
      assetTimeoutMs,
      platform,
      systemProxyReader,
    });
    ({ lockedAudit, existingPlanningFiles } = revalidateLocalState());
    const record = {
      schemaVersion: CLOSURE_SCHEMA,
      issueId,
      version,
      tag,
      commit: head,
      tree: lockedAudit.record.evidence.git.peeledTreeSha,
      releaseUrl: lockedAudit.record.evidence.githubRelease.url,
      packageSha256: lockedAudit.record.evidence.packageAsset.sha256,
      prdPath: normalizedPrdPath,
      audit: {
        attemptId: lockedAudit.record.attemptId,
        recordHash: lockedAudit.record.recordHash,
        status: lockedAudit.record.status,
      },
      globalCheck: {
        targets: ["claude", "codex"],
        command: "node scripts/sync-global-meta-theory.mjs --check --targets claude,codex --with-global-hooks",
        outputSha256: sha256(`${globalCheck.stdout || ""}\n${globalCheck.stderr || ""}`),
      },
      planningFiles: existingPlanningFiles,
      releaseBoundAt: lockedAudit.record.createdAt,
      recordedAt: now().toISOString(),
    };
    const recordName = `${issueId}-${tag}-${lockedAudit.record.attemptId}.json`;
    const recordPath = path.join(stateDir, recordName);
    let existingRecord = null;
    if (existsSync(recordPath)) {
      resolveExistingPlainFile(
        repoRoot,
        path.relative(repoRoot, recordPath),
        "release planning closure record",
      );
      existingRecord = validateExistingClosureRecord(recordPath, record);
    }
    const projectionRecord = existingRecord || record;
    const projectionResults = Object.fromEntries(
      PLANNING_FILES.map((file) => [
        file,
        projectClosureBlock(
          repoRoot,
          file,
          projectionRecord,
          stateDir,
          existingPlanningFiles.includes(file),
          afterProjectionWrite,
        ),
      ]),
    );
    beforeRecordPublish?.();
    const finalState = revalidateLocalState();
    if (
      canonicalJson(finalState.existingPlanningFiles) !== canonicalJson(existingPlanningFiles) ||
      finalState.lockedAudit.record.recordHash !== lockedAudit.record.recordHash
    ) {
      throw codedError("release_state_changed", "release facts changed during planning projection");
    }
    validateProjectedState(repoRoot, projectionRecord, existingPlanningFiles);
    if (existingRecord) {
      return { record: existingRecord, recordPath, projectionResults, reusedRecord: true, repoRoot };
    }
    const recordWithoutHash = { ...record, projectionResults };
    const finalRecord = {
      ...recordWithoutHash,
      recordHash: sha256(canonicalJson(recordWithoutHash)),
    };
    immutableWrite(recordPath, jsonText(finalRecord));
    return {
      record: finalRecord,
      recordPath,
      projectionResults,
      reusedRecord: false,
      repoRoot,
    };
  } finally {
    releaseLock();
  }
}

function cliOptions(args) {
  const options = { profile: "default", json: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (["--help", "-h"].includes(arg)) options.help = true;
    else if (arg === "--json") options.json = true;
    else if ([
      "--issue",
      "--prd",
      "--profile",
      "--global-check-timeout-ms",
      "--metadata-timeout-ms",
      "--asset-timeout-ms",
    ].includes(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw codedError("cli_invalid", `${arg} requires a value`);
      const optionName = {
        "--issue": "issueId",
        "--prd": "prdPath",
        "--profile": "profile",
        "--global-check-timeout-ms": "globalCheckTimeoutMs",
        "--metadata-timeout-ms": "metadataTimeoutMs",
        "--asset-timeout-ms": "assetTimeoutMs",
      }[arg];
      options[optionName] = optionName.endsWith("TimeoutMs") ? Number(value) : value;
      index += 1;
    } else if (arg.startsWith("--profile=")) options.profile = arg.slice("--profile=".length);
    else if (arg.startsWith("--global-check-timeout-ms=")) options.globalCheckTimeoutMs = Number(arg.slice("--global-check-timeout-ms=".length));
    else if (arg.startsWith("--metadata-timeout-ms=")) options.metadataTimeoutMs = Number(arg.slice("--metadata-timeout-ms=".length));
    else if (arg.startsWith("--asset-timeout-ms=")) options.assetTimeoutMs = Number(arg.slice("--asset-timeout-ms=".length));
    else throw codedError("cli_invalid", `unknown option '${arg}'`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  meta-kim release close --issue P-128 --prd <repo-relative-file> [--profile default] [--global-check-timeout-ms <ms>] [--metadata-timeout-ms <ms>] [--asset-timeout-ms <ms>] [--json]",
    "",
    "The command records an already-published exact release into existing local planning files.",
    "It never publishes the private PRD and never creates a second queue.",
  ].join("\n");
}

async function main() {
  let options;
  try {
    options = cliOptions(process.argv.slice(2));
  } catch (error) {
    console.error(`meta-kim release close: ${error.message}`);
    console.error(usage());
    process.exit(2);
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.issueId || !options.prdPath) {
    console.error("meta-kim release close: --issue and --prd are required");
    console.error(usage());
    process.exit(2);
  }
  try {
    const result = await recordReleasePlanningClosure(options);
    const output = {
      status: "release_closed",
      issueId: result.record.issueId,
      version: result.record.version,
      releaseUrl: result.record.releaseUrl,
      record: path.relative(
        result.repoRoot,
        result.recordPath,
      ).replaceAll("\\", "/"),
      projectionResults: result.projectionResults,
      reusedRecord: result.reusedRecord,
    };
    if (options.json) console.log(JSON.stringify(output, null, 2));
    else {
      console.log(`status=${output.status}`);
      console.log(`issue=${output.issueId}`);
      console.log(`version=${output.version}`);
      console.log(`record=${output.record}`);
    }
  } catch (error) {
    console.error(`meta-kim release close: ${error.code || "failed"}: ${error.message}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) await main();
