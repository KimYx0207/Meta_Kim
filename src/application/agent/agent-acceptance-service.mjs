/**
 * B4 Deliverable Inspection, Shell-Free Verification, Conflict-Guarded Merge,
 * Module-Scoped Rework, Background Watch Reconciler, and Verified Playbook Reuse.
 *
 * Security & Governance Guarantees:
 * 1. Never exposes raw absolute filesystem paths over HTTP receipts.
 * 2. Never uses a shell to verify isolated worktree outputs (JSON.parse + node --check).
 * 3. Never overwrites concurrently edited files in projectRoot (3-way baseline check + backup).
 * 4. Never retries or relaunches an `in_doubt` B3 session during background watch ticks.
 * 5. Gates cross-project / multi-store Playbook reuse on explicit applicabilityConditions.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";

import { spawnCli } from "../../../scripts/runtime-cli-invocation.mjs";
import {
  AGENT_WORKFLOW_KEY_PATTERN, agentWorkflowConflict, agentWorkflowProjectFingerprint,
} from "../../domain/runtime/agent-workflow-decision.mjs";

export const AGENT_ACCEPTANCE_SCHEMA = "meta-kim-agent-b4-acceptance-v1";
export const AGENT_PLAYBOOK_SCHEMA = "meta-kim-verified-playbook-v1";

const PROFILE = /^[a-z][a-z0-9_-]{0,31}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const NODE_ID = /^[a-z][a-z0-9_-]{1,31}$/u;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_RECORD_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_WORKTREE_FILES = 2_500;
const IGNORED_DIRS = new Set([".git", ".meta-kim", "node_modules", ".claude-worktrees"]);

function hashJson(value, domain) {
  return createHash("sha256").update(domain).update("\u0000").update(JSON.stringify(value)).digest("hex");
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function ensurePrivateChain(baseRoot, segments) {
  let current = baseRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    try { mkdirSync(current, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new TypeError("Unsafe acceptance state directory");
    }
  }
  return current;
}

function writeAtomicJson(directory, targetPath, payload, maxBytes = MAX_RECORD_BYTES) {
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, "utf8") > maxBytes) {
    throw new TypeError("Acceptance state record exceeds maximum size");
  }
  const tmpPath = path.join(directory, `.tmp-${randomUUID()}.json`);
  let fd;
  try {
    fd = openSync(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    writeFileSync(fd, json, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, targetPath);
  } finally {
    if (fd != null) closeSync(fd);
    if (existsSync(tmpPath)) {
      try { unlinkSync(tmpPath); } catch { /* ignore cleanup race */ }
    }
  }
}

function readSafeJson(targetPath, maxBytes = MAX_RECORD_BYTES) {
  if (!targetPath || !existsSync(targetPath)) return null;
  let fd;
  try {
    if (lstatSync(targetPath).isSymbolicLink()) return null;
    fd = openSync(targetPath, constants.O_RDONLY | NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > maxBytes) return null;
    return JSON.parse(readFileSync(fd, "utf8"));
  } catch {
    return null;
  } finally {
    if (fd != null) closeSync(fd);
  }
}

export function isForbiddenDeliverablePath(relPosix) {
  if (typeof relPosix !== "string" || !relPosix || relPosix.startsWith("/") || relPosix.includes("..")) {
    return true;
  }
  const parts = relPosix.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return true;
  if ([".git", ".meta-kim"].includes(parts[0])) return true;
  if (relPosix.startsWith(".claude/hooks/") || relPosix.startsWith(".codex/hooks/")
    || relPosix.startsWith(".cursor/hooks/") || relPosix.startsWith(".gemini/hooks/")) return true;
  const base = parts.at(-1);
  if (/^\.env(?:\..+)?$/iu.test(base) && !/^\.env\.example$/iu.test(base)) return true;
  if (/(?:secret|credential|private[_-]?key|\.pem$|\.key$|\.pfx$)/iu.test(base)) return true;
  return false;
}

// Streams both files and compares bytes; never loads an oversize file whole.
function sameRegularFileContent(leftPath, rightPath, expectedBytes) {
  let rightInfo;
  try { rightInfo = lstatSync(rightPath); }
  catch { return false; }
  if (!rightInfo.isFile() || rightInfo.isSymbolicLink() || rightInfo.size !== expectedBytes) return false;
  let leftFd;
  let rightFd;
  try {
    leftFd = openSync(leftPath, constants.O_RDONLY | NOFOLLOW);
    rightFd = openSync(rightPath, constants.O_RDONLY | NOFOLLOW);
    const leftBuf = Buffer.allocUnsafe(1024 * 1024);
    const rightBuf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const leftRead = readSync(leftFd, leftBuf, 0, leftBuf.length, null);
      const rightRead = readSync(rightFd, rightBuf, 0, rightBuf.length, null);
      if (leftRead !== rightRead) return false;
      if (leftRead === 0) return true;
      if (!leftBuf.subarray(0, leftRead).equals(rightBuf.subarray(0, rightRead))) return false;
    }
  } catch {
    return false;
  } finally {
    if (leftFd != null) closeSync(leftFd);
    if (rightFd != null) closeSync(rightFd);
  }
}

/**
 * Scans the isolated worktree. Oversize files are only reported when they
 * differ from the same path in referenceRoot (the main project): an untouched
 * large asset is not a draft change and must not block B4.
 */
function scanTree(rootDir, { referenceRoot = null } = {}) {
  const files = new Map();
  const forbiddenPaths = [];
  const oversizePaths = [];
  let count = 0;

  function walk(currentDir, relPrefix) {
    if (count >= MAX_WORKTREE_FILES) return;
    let entries = [];
    try { entries = readdirSync(currentDir, { withFileTypes: true }); }
    catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (count >= MAX_WORKTREE_FILES) break;
      const relPosix = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (IGNORED_DIRS.has(entry.name) || relPosix === ".claude/worktrees"
        || relPosix.startsWith(".claude/worktrees/")) continue;
      const fullPath = path.join(currentDir, entry.name);
      let info;
      try { info = lstatSync(fullPath); }
      catch { continue; }
      if (info.isSymbolicLink()) {
        forbiddenPaths.push(relPosix);
        continue;
      }
      if (info.isDirectory()) {
        walk(fullPath, relPosix);
      } else if (info.isFile()) {
        if (isForbiddenDeliverablePath(relPosix)) {
          forbiddenPaths.push(relPosix);
          continue;
        }
        if (info.size > MAX_FILE_BYTES) {
          const referencePath = referenceRoot ? path.join(referenceRoot, ...relPosix.split("/")) : null;
          if (!referencePath || !sameRegularFileContent(fullPath, referencePath, info.size)) {
            oversizePaths.push(relPosix);
          }
          continue;
        }
        const buf = readFileSync(fullPath);
        const textPreview = !buf.includes(0)
          ? buf.toString("utf8").slice(0, 280).trim()
          : null;
        files.set(relPosix, {
          path: relPosix,
          bytes: info.size,
          sha256: sha256Buffer(buf),
          preview: textPreview,
          hasNullByte: buf.includes(0),
        });
        count += 1;
      }
    }
  }

  walk(rootDir, "");
  return { files, forbiddenPaths, oversizePaths };
}

function diffAgainstBaseline(baselineMap, worktreeScan) {
  const baseline = baselineMap && typeof baselineMap === "object" ? baselineMap : {};
  const changed = [];
  const allPaths = new Set([...Object.keys(baseline), ...worktreeScan.files.keys()]);
  for (const relPosix of [...allPaths].sort()) {
    const before = baseline[relPosix] ?? null;
    const after = worktreeScan.files.get(relPosix) ?? null;
    if (!before && after) {
      changed.push({
        path: relPosix,
        changeType: "added",
        bytes: after.bytes,
        sha256: after.sha256,
        preview: after.preview,
      });
    } else if (before && after && before.sha256 !== after.sha256) {
      changed.push({
        path: relPosix,
        changeType: "modified",
        bytes: after.bytes,
        sha256: after.sha256,
        preview: after.preview,
      });
    } else if (before && !after) {
      changed.push({
        path: relPosix,
        changeType: "deleted",
        bytes: 0,
        sha256: null,
        preview: null,
      });
    }
  }
  return changed;
}

function extractContextProfile({ goal = "", techStack = "", system = null, constraints = [] } = {}) {
  const corpus = [
    goal,
    techStack,
    system?.title || "",
    system?.goal || "",
    system?.architecture || "",
    system?.techStack || "",
    ...(Array.isArray(constraints) ? constraints : []),
  ].join(" \n ").toLowerCase();

  const isB2BWholesale = /\bb2b\b|大宗批发|线下账期|授信审批|wholesale|offline\s*credit/iu.test(corpus);
  const isB2CRetail = /\bb2c\b|零售|独立站|shopify|跨境电商|店铺|选品|转化率/iu.test(corpus);
  const stackTokens = [];
  if (/shopify/iu.test(corpus)) stackTokens.push("shopify");
  if (/node(?:\.js)?|\besm\b|javascript|mjs/iu.test(corpus)) stackTokens.push("nodejs");
  if (/java\s*erp|\bspring\b/iu.test(corpus)) stackTokens.push("java_erp");
  if (/python|fastapi|django/iu.test(corpus)) stackTokens.push("python");
  if (/react|next\.js|vue/iu.test(corpus)) stackTokens.push("web_frontend");

  const domainTags = [];
  if (/跨境|电商|shopify|店铺|选品|sku|库存|转化率/iu.test(corpus)) domainTags.push("cross_border_ecommerce");
  if (isB2CRetail) domainTags.push("b2c_retail");
  if (isB2BWholesale) domainTags.push("b2b_wholesale");
  if (/库存|定价|pricing|inventory/iu.test(corpus)) domainTags.push("pricing_inventory");
  if (/增长|投放|转化|campaign|growth/iu.test(corpus)) domainTags.push("conversion_growth");

  return {
    businessModel: isB2BWholesale && !isB2CRetail ? "b2b_wholesale"
      : isB2CRetail && !isB2BWholesale ? "b2c_retail"
        : isB2BWholesale ? "hybrid_b2b" : "general",
    stackTokens,
    domainTags: domainTags.length ? domainTags : ["general_software"],
  };
}

export function createAgentAcceptanceService({
  projectRoot,
  profile = "default",
  workflowService,
  nativeExecutionService,
  sharedPlaybooksRoot = null,
  launch = spawnCli,
} = {}) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot) || !PROFILE.test(profile)
    || typeof workflowService?.inspectHandoff !== "function"
    || typeof workflowService?.inspectDesign !== "function"
    || typeof workflowService?.recordDesign !== "function"
    || typeof workflowService?.getTrustedExecutionInput !== "function"
    || typeof nativeExecutionService?.inspect !== "function"
    || typeof nativeExecutionService?.getTrustedExecutionState !== "function") {
    throw new TypeError("B4 acceptance service requires projectRoot, workflowService and nativeExecutionService");
  }

  const realRoot = realpathSync(projectRoot);
  if (!statSync(realRoot).isDirectory()) throw new TypeError("Invalid B4 project root");
  const fingerprint = agentWorkflowProjectFingerprint(realRoot, profile);
  const acceptanceDir = ensurePrivateChain(realRoot, [".meta-kim", "state", profile, "agent-workflow", "acceptance"]);
  const localPlaybooksDir = ensurePrivateChain(realRoot, [".meta-kim", "state", profile, "agent-workflow", "playbooks"]);
  const externalPlaybooksDir = typeof sharedPlaybooksRoot === "string" && path.isAbsolute(sharedPlaybooksRoot)
    ? (() => {
      mkdirSync(sharedPlaybooksRoot, { recursive: true, mode: 0o700 });
      const resolved = realpathSync(sharedPlaybooksRoot);
      if (lstatSync(resolved).isSymbolicLink() || !statSync(resolved).isDirectory()) {
        throw new TypeError("Unsafe sharedPlaybooksRoot");
      }
      return resolved;
    })()
    : null;

  function ledgerPath(key) {
    if (!AGENT_WORKFLOW_KEY_PATTERN.test(key ?? "")) return null;
    return path.join(acceptanceDir, `acceptance-${key}.json`);
  }

  function readLedger(key) {
    const row = readSafeJson(ledgerPath(key));
    if (!row || row.projectFingerprint !== fingerprint || row.idempotencyKey !== key) {
      return {
        schemaVersion: "meta-kim-agent-b4-ledger-v1",
        projectFingerprint: fingerprint,
        idempotencyKey: key,
        verifications: {},
        decisions: {},
        reworkLessons: [],
        history: [],
      };
    }
    return row;
  }

  function saveLedger(ledger) {
    const target = ledgerPath(ledger.idempotencyKey);
    if (!target) throw new TypeError("Invalid acceptance ledger key");
    writeAtomicJson(acceptanceDir, target, ledger);
    return ledger;
  }

  function readAllPlaybooks() {
    const roots = [localPlaybooksDir, ...(externalPlaybooksDir && externalPlaybooksDir !== localPlaybooksDir ? [externalPlaybooksDir] : [])];
    const seen = new Set();
    const list = [];
    for (const dir of roots) {
      let names = [];
      try { names = readdirSync(dir); }
      catch { continue; }
      for (const name of names) {
        if (!/^playbook-[A-Za-z0-9_-]{8,96}\.json$/u.test(name)) continue;
        const parsed = readSafeJson(path.join(dir, name));
        if (!parsed || parsed.schemaVersion !== AGENT_PLAYBOOK_SCHEMA || !DIGEST.test(parsed.playbookDigest ?? "")) continue;
        const { playbookDigest, ...body } = parsed;
        if (hashJson(body, "meta-kim-verified-playbook-v1") !== playbookDigest) continue;
        if (seen.has(playbookDigest)) continue;
        seen.add(playbookDigest);
        list.push(parsed);
      }
    }
    list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return list;
  }

  function matchPlaybooks({ goal = "", techStack = "", constraints = [] } = {}) {
    const targetProfile = extractContextProfile({ goal, techStack, constraints });
    const playbooks = readAllPlaybooks();
    return playbooks.map((pb) => {
      const cond = pb.applicabilityConditions || {};
      const mismatchReasons = [];
      const matchReasons = [];

      if (cond.businessModel === "b2c_retail" && (targetProfile.businessModel === "b2b_wholesale" || targetProfile.businessModel === "hybrid_b2b")) {
        mismatchReasons.push("原方法卡验证于 B2C 零售独立站场景，不适用于 B2B 大宗批发或线下账期业务");
      } else if (cond.businessModel === "b2b_wholesale" && targetProfile.businessModel === "b2c_retail") {
        mismatchReasons.push("原方法卡验证于 B2B 大宗批发场景，不适用于 B2C 零售独立站业务");
      } else if (cond.businessModel && cond.businessModel === targetProfile.businessModel) {
        matchReasons.push(`业务模式一致（${cond.businessModel === "b2c_retail" ? "B2C 零售" : cond.businessModel}）`);
      }

      if (Array.isArray(cond.stackTokens) && cond.stackTokens.length > 0 && targetProfile.stackTokens.length > 0) {
        const sharedStack = cond.stackTokens.filter((token) => targetProfile.stackTokens.includes(token));
        if (sharedStack.length === 0) {
          mismatchReasons.push(`技术栈与平台不匹配（需 ${cond.stackTokens.join("/")}，当前为 ${targetProfile.stackTokens.join("/")}）`);
        } else {
          matchReasons.push(`共享关键技术栈（${sharedStack.join(", ")}）`);
        }
      }

      const sharedDomains = (pb.domainTags || []).filter((tag) => targetProfile.domainTags.includes(tag));
      if (sharedDomains.length > 0) {
        matchReasons.push(`命中同领域经验标签（${sharedDomains.join(", ")}）`);
      } else if ((pb.domainTags || []).length > 0 && targetProfile.domainTags.length > 0
        && !targetProfile.domainTags.includes("general_software")) {
        mismatchReasons.push("业务领域标签无交集，禁止直接套用");
      }

      const applicability = mismatchReasons.length > 0
        ? "incompatible_context"
        : matchReasons.length > 0 ? "compatible" : "review_required";

      return {
        playbookId: pb.playbookId,
        playbookDigest: pb.playbookDigest,
        title: pb.title,
        domainTags: pb.domainTags,
        applicability,
        matchReasons,
        mismatchReasons,
        verifiedStrategy: pb.verifiedStrategy,
        moduleCount: Array.isArray(pb.moduleBlueprints) ? pb.moduleBlueprints.length : 0,
        verificationSummary: pb.verificationSummary,
        reworkLessons: pb.reworkLessons || [],
        createdAt: pb.createdAt,
      };
    });
  }

  function baseResponse(key, overrides = {}) {
    return {
      schemaVersion: AGENT_ACCEPTANCE_SCHEMA,
      idempotencyKey: AGENT_WORKFLOW_KEY_PATTERN.test(key ?? "") ? key : null,
      status: "not_ready",
      reason: null,
      b3Status: null,
      handoffDigest: null,
      artifactsDigest: null,
      changedFiles: [],
      forbiddenPaths: [],
      oversizePaths: [],
      verification: null,
      decision: null,
      playbook: null,
      matchedPlaybooks: [],
      reworkLessons: [],
      nextAction: "完成 B3 隔离草稿执行后，系统会自动比对产物并执行核验，再进入 B4 人工最终验收。",
      ...overrides,
    };
  }

  function buildWorktreeSnapshot(trustedExec) {
    const worktreeRoot = trustedExec?.nativeWorktreePath;
    if (!worktreeRoot || !existsSync(worktreeRoot)) {
      return { errorReason: "worktree_not_available", changedFiles: [], forbiddenPaths: [], artifactsDigest: null };
    }
    let resolvedWorktree;
    try {
      if (lstatSync(worktreeRoot).isSymbolicLink()) {
        return { errorReason: "worktree_symlink_rejected", changedFiles: [], forbiddenPaths: [], artifactsDigest: null };
      }
      resolvedWorktree = realpathSync(worktreeRoot);
    } catch {
      return { errorReason: "worktree_not_available", changedFiles: [], forbiddenPaths: [], artifactsDigest: null };
    }
    const rel = path.relative(realRoot, resolvedWorktree);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      return { errorReason: "worktree_outside_project", changedFiles: [], forbiddenPaths: [], artifactsDigest: null };
    }
    const worktreeScan = scanTree(resolvedWorktree, { referenceRoot: realRoot });
    const changedFiles = diffAgainstBaseline(trustedExec.baselineFiles, worktreeScan);
    const artifactsDigest = hashJson({
      handoffDigest: trustedExec.handoffDigest,
      files: changedFiles.map(({ path: p, changeType, sha256, bytes }) => ({ path: p, changeType, sha256, bytes })),
      forbiddenPaths: worktreeScan.forbiddenPaths,
      // Only present when non-empty, so digests of ordinary drafts stay stable.
      ...(worktreeScan.oversizePaths.length > 0 ? { oversizePaths: worktreeScan.oversizePaths } : {}),
    }, "meta-kim-agent-b4-artifacts-v1");
    return {
      resolvedWorktree,
      worktreeScan,
      changedFiles,
      forbiddenPaths: worktreeScan.forbiddenPaths,
      oversizePaths: worktreeScan.oversizePaths,
      artifactsDigest,
      errorReason: null,
    };
  }

  async function inspect({ idempotencyKey } = {}) {
    if (!AGENT_WORKFLOW_KEY_PATTERN.test(idempotencyKey ?? "")) {
      return baseResponse(null, { status: "blocked", reason: "invalid_request_key" });
    }
    const ledger = readLedger(idempotencyKey);
    const trustedGoal = workflowService.getTrustedExecutionInput({ idempotencyKey });
    const matchedPlaybooks = trustedGoal
      ? matchPlaybooks({
        goal: trustedGoal.goal,
        techStack: trustedGoal.envelope?.design?.system?.techStack || "",
      })
      : readAllPlaybooks().slice(0, 6).map((pb) => ({
        playbookId: pb.playbookId,
        playbookDigest: pb.playbookDigest,
        title: pb.title,
        domainTags: pb.domainTags,
        applicability: "review_required",
        matchReasons: [],
        mismatchReasons: [],
        verifiedStrategy: pb.verifiedStrategy,
        moduleCount: Array.isArray(pb.moduleBlueprints) ? pb.moduleBlueprints.length : 0,
        verificationSummary: pb.verificationSummary,
        reworkLessons: pb.reworkLessons || [],
        createdAt: pb.createdAt,
      }));

    const execReceipt = await nativeExecutionService.inspect({ idempotencyKey });
    const latestHistory = ledger.history.at(-1) ?? null;

    if (execReceipt.status === "ready_to_authorize" || (execReceipt.status === "blocked" && !execReceipt.authorizedByLocalB3)) {
      if (latestHistory?.status === "rework_requested") {
        return baseResponse(idempotencyKey, {
          status: "rework_requested",
          b3Status: execReceipt.status,
          decision: latestHistory,
          matchedPlaybooks,
          reworkLessons: ledger.reworkLessons,
          nextAction: `已将模块「${latestHistory.moduleId}」退回 B2 重做；修改确认并重新封装交接包后，可发起新一轮 B3 执行。`,
        });
      }
      return baseResponse(idempotencyKey, {
        status: "not_ready",
        reason: "b3_not_started",
        b3Status: execReceipt.status,
        matchedPlaybooks,
        reworkLessons: ledger.reworkLessons,
      });
    }

    if (execReceipt.status !== "ready_for_review") {
      return baseResponse(idempotencyKey, {
        status: "waiting_b3",
        reason: execReceipt.reason ?? null,
        b3Status: execReceipt.status,
        handoffDigest: execReceipt.handoffDigest,
        matchedPlaybooks,
        reworkLessons: ledger.reworkLessons,
        nextAction: execReceipt.nextAction,
      });
    }

    const trustedExec = nativeExecutionService.getTrustedExecutionState({ idempotencyKey });
    if (!trustedExec) {
      return baseResponse(idempotencyKey, {
        status: "blocked",
        reason: "b3_trusted_state_unavailable",
        b3Status: execReceipt.status,
        matchedPlaybooks,
        reworkLessons: ledger.reworkLessons,
      });
    }

    const existingDecision = ledger.decisions[trustedExec.handoffDigest] ?? null;
    if (existingDecision?.status === "accepted_and_integrated") {
      return baseResponse(idempotencyKey, {
        status: "accepted_and_integrated",
        b3Status: execReceipt.status,
        handoffDigest: trustedExec.handoffDigest,
        artifactsDigest: existingDecision.artifactsDigest,
        changedFiles: existingDecision.changedFiles || [],
        verification: ledger.verifications[existingDecision.artifactsDigest] ?? null,
        decision: existingDecision,
        playbook: existingDecision.playbook ?? null,
        matchedPlaybooks,
        reworkLessons: ledger.reworkLessons,
        nextAction: "B4 最终验收已通过，隔离区验证产物已安全合入主项目，并沉淀为可复用经验方法卡。",
      });
    }
    if (existingDecision?.status === "rolled_back") {
      return baseResponse(idempotencyKey, {
        status: "rolled_back",
        b3Status: execReceipt.status,
        handoffDigest: trustedExec.handoffDigest,
        artifactsDigest: existingDecision.artifactsDigest,
        changedFiles: existingDecision.changedFiles || [],
        verification: ledger.verifications[existingDecision.artifactsDigest] ?? null,
        decision: existingDecision,
        matchedPlaybooks,
        reworkLessons: ledger.reworkLessons,
        nextAction: "已按回滚备份恢复主项目文件，可重新审阅或退回模块修改。",
      });
    }

    const wt = buildWorktreeSnapshot(trustedExec);
    if (wt.errorReason) {
      return baseResponse(idempotencyKey, {
        status: "blocked",
        reason: wt.errorReason,
        b3Status: execReceipt.status,
        handoffDigest: trustedExec.handoffDigest,
        matchedPlaybooks,
        reworkLessons: ledger.reworkLessons,
        nextAction: "未找到可核验的隔离工作区目录；请核对客户端后台任务输出。",
      });
    }
    if (wt.forbiddenPaths.length > 0) {
      return baseResponse(idempotencyKey, {
        status: "blocked",
        reason: "worktree_forbidden_path_modified",
        b3Status: execReceipt.status,
        handoffDigest: trustedExec.handoffDigest,
        artifactsDigest: wt.artifactsDigest,
        changedFiles: wt.changedFiles,
        forbiddenPaths: wt.forbiddenPaths,
        matchedPlaybooks,
        reworkLessons: ledger.reworkLessons,
        nextAction: "隔离工作区触碰了受保护文件（如密钥或治理目录），已被拦截，禁止合入主项目。",
      });
    }
    if (wt.oversizePaths.length > 0) {
      return baseResponse(idempotencyKey, {
        status: "blocked",
        reason: "worktree_changed_file_too_large",
        b3Status: execReceipt.status,
        handoffDigest: trustedExec.handoffDigest,
        artifactsDigest: wt.artifactsDigest,
        changedFiles: wt.changedFiles,
        oversizePaths: wt.oversizePaths,
        matchedPlaybooks,
        reworkLessons: ledger.reworkLessons,
        nextAction: `草稿新增或改动的文件超过 ${MAX_FILE_BYTES / 1024 / 1024} MB 上限（${wt.oversizePaths.join(", ")}），不能自动核验合入；请缩小该文件或退回模块重做。`,
      });
    }

    const verification = ledger.verifications[wt.artifactsDigest] ?? null;
    const status = !verification
      ? "pending_verification"
      : verification.passed ? "awaiting_human_b4" : "verification_failed";

    return baseResponse(idempotencyKey, {
      status,
      b3Status: execReceipt.status,
      handoffDigest: trustedExec.handoffDigest,
      artifactsDigest: wt.artifactsDigest,
      changedFiles: wt.changedFiles,
      verification,
      matchedPlaybooks,
      reworkLessons: ledger.reworkLessons,
      nextAction: status === "awaiting_human_b4"
        ? "隔离区产物已通过语法、结构与契约核验。请确认合入主项目，或指定模块退回重做。"
        : status === "verification_failed"
          ? "产物自动核验未通过，不能合入主项目；请查看失败项并退回对应模块重做。"
          : "隔离区已生成草稿产物，正在等待或执行自动核验。",
    });
  }

  async function verifyArtifacts({ idempotencyKey } = {}) {
    if (!AGENT_WORKFLOW_KEY_PATTERN.test(idempotencyKey ?? "")) {
      return baseResponse(null, { status: "blocked", reason: "invalid_request_key" });
    }
    const execReceipt = await nativeExecutionService.inspect({ idempotencyKey });
    if (execReceipt.status !== "ready_for_review") {
      return inspect({ idempotencyKey });
    }
    const trustedExec = nativeExecutionService.getTrustedExecutionState({ idempotencyKey });
    const trustedInput = workflowService.getTrustedExecutionInput({ idempotencyKey });
    if (!trustedExec || !trustedInput) {
      return baseResponse(idempotencyKey, { status: "blocked", reason: "b3_trusted_state_unavailable" });
    }
    const wt = buildWorktreeSnapshot(trustedExec);
    if (wt.errorReason) {
      return baseResponse(idempotencyKey, { status: "blocked", reason: wt.errorReason });
    }
    if (wt.forbiddenPaths.length > 0) {
      return baseResponse(idempotencyKey, {
        status: "blocked",
        reason: "worktree_forbidden_path_modified",
        b3Status: execReceipt.status,
        handoffDigest: trustedExec.handoffDigest,
        artifactsDigest: wt.artifactsDigest,
        changedFiles: wt.changedFiles,
        forbiddenPaths: wt.forbiddenPaths,
      });
    }
    if (wt.oversizePaths.length > 0) {
      return baseResponse(idempotencyKey, {
        status: "blocked",
        reason: "worktree_changed_file_too_large",
        b3Status: execReceipt.status,
        handoffDigest: trustedExec.handoffDigest,
        artifactsDigest: wt.artifactsDigest,
        changedFiles: wt.changedFiles,
        oversizePaths: wt.oversizePaths,
      });
    }

    const checks = [];
    checks.push({
      id: "no_forbidden_paths",
      label: "敏感文件与治理边界检查",
      passed: wt.forbiddenPaths.length === 0,
      detail: "未触碰密钥、Hook 或治理状态目录",
    });

    const hasDeliverables = wt.changedFiles.length > 0;
    checks.push({
      id: "deliverables_present",
      label: "有效变更产物检查",
      passed: hasDeliverables,
      detail: hasDeliverables ? `共检测到 ${wt.changedFiles.length} 个文件变更` : "隔离工作区没有任何文件变更",
    });

    const syntaxFailures = [];
    for (const item of wt.changedFiles) {
      if (item.changeType === "deleted") continue;
      const fullPath = path.join(wt.resolvedWorktree, ...item.path.split("/"));
      const scanned = wt.worktreeScan.files.get(item.path);
      if (scanned?.hasNullByte) {
        syntaxFailures.push(`${item.path}: 包含非法二进制空字节`);
        continue;
      }
      if (item.path.endsWith(".json")) {
        try { JSON.parse(readFileSync(fullPath, "utf8")); }
        catch { syntaxFailures.push(`${item.path}: JSON 格式无效`); }
      } else if (/\.(?:mjs|cjs|js)$/iu.test(item.path)) {
        const res = await launch(process.execPath, ["--check", fullPath], {
          cwd: wt.resolvedWorktree,
          timeoutMs: 6_000,
          maxOutputBytes: 16_384,
        });
        if (!res || res.status !== 0 || res.error || res.timedOut) {
          syntaxFailures.push(`${item.path}: JavaScript 语法校验未通过`);
        }
      }
    }
    checks.push({
      id: "syntax_and_structure",
      label: "代码语法与配置结构核验",
      passed: syntaxFailures.length === 0,
      detail: syntaxFailures.length === 0 ? "全部变更文件通过语法与格式校验" : syntaxFailures.join("；"),
    });

    const modules = trustedInput.envelope?.design?.modules || [];
    const missingOutputs = [];
    for (const mod of modules) {
      for (const out of mod.outputContract || []) {
        const trimmed = String(out).trim();
        if (/^[A-Za-z0-9_./-]+\.[A-Za-z0-9]+$/u.test(trimmed) && !trimmed.startsWith(".")
          && !wt.worktreeScan.files.has(trimmed)) {
          missingOutputs.push(`${mod.id} 缺少声明产物 ${trimmed}`);
        }
      }
    }
    checks.push({
      id: "design_contract_alignment",
      label: "B2 模块输出契约对齐检查",
      passed: missingOutputs.length === 0,
      detail: missingOutputs.length === 0
        ? `已对齐 ${modules.length} 个已批准模块的输出契约`
        : missingOutputs.join("；"),
    });

    const passed = checks.every((c) => c.passed);
    const verifiedAt = new Date().toISOString();
    const verificationBody = {
      handoffDigest: trustedExec.handoffDigest,
      artifactsDigest: wt.artifactsDigest,
      passed,
      checks,
      verifiedAt,
    };
    const verification = {
      ...verificationBody,
      verificationDigest: hashJson(verificationBody, "meta-kim-agent-b4-verification-v1"),
    };

    const ledger = readLedger(idempotencyKey);
    ledger.verifications[wt.artifactsDigest] = verification;
    saveLedger(ledger);
    return inspect({ idempotencyKey });
  }

  function buildAndSavePlaybook({ idempotencyKey, trustedInput, verification, changedFiles, reworkLessons, summary }) {
    const design = trustedInput.envelope.design;
    const context = extractContextProfile({
      goal: trustedInput.goal,
      techStack: design.system?.techStack || "",
      system: design.system,
    });
    const playbookId = `pb_${idempotencyKey.slice(0, 24)}_${verification.artifactsDigest.slice(0, 10)}`;
    const body = {
      schemaVersion: AGENT_PLAYBOOK_SCHEMA,
      playbookId,
      sourceProjectFingerprint: fingerprint,
      title: design.system?.title || "已验证业务执行方法卡",
      domainTags: context.domainTags,
      applicabilityConditions: {
        businessModel: context.businessModel,
        stackTokens: context.stackTokens,
        moduleCount: Array.isArray(design.modules) ? design.modules.length : 0,
      },
      verifiedStrategy: trustedInput.basis.selectedStrategy,
      selectionReason: trustedInput.basis.selectionReason,
      systemSummary: {
        goal: design.system?.goal || "",
        architecture: design.system?.architecture || "",
        techStack: design.system?.techStack || "",
      },
      moduleBlueprints: (design.modules || []).map((mod) => ({
        id: mod.id,
        title: mod.title,
        objective: mod.objective,
        outputContract: mod.outputContract,
        dependencies: mod.dependencies,
      })),
      verificationSummary: {
        artifactsDigest: verification.artifactsDigest,
        verificationDigest: verification.verificationDigest,
        changedFileCount: changedFiles.length,
        deliverablePaths: changedFiles.map((item) => item.path),
        acceptanceNote: summary || "",
      },
      reworkLessons: [...reworkLessons],
      createdAt: new Date().toISOString(),
    };
    const complete = {
      ...body,
      playbookDigest: hashJson(body, "meta-kim-verified-playbook-v1"),
    };
    writeAtomicJson(localPlaybooksDir, path.join(localPlaybooksDir, `playbook-${playbookId}.json`), complete);
    if (externalPlaybooksDir && externalPlaybooksDir !== localPlaybooksDir) {
      writeAtomicJson(externalPlaybooksDir, path.join(externalPlaybooksDir, `playbook-${playbookId}.json`), complete);
    }
    return complete;
  }

  async function decide(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.hasOwn(input, "projectRoot") || Object.hasOwn(input, "projectId")
      || !AGENT_WORKFLOW_KEY_PATTERN.test(input.idempotencyKey ?? "")
      || !AGENT_WORKFLOW_KEY_PATTERN.test(input.decisionKey ?? "")
      || !DIGEST.test(input.handoffDigest ?? "")
      || !["accept", "request_rework", "rollback"].includes(input.action)) {
      throw new TypeError("Invalid B4 acceptance decision payload");
    }
    const { idempotencyKey, decisionKey, handoffDigest, action } = input;
    const ledger = readLedger(idempotencyKey);

    if (action === "rollback") {
      const committed = ledger.decisions[handoffDigest];
      if (!committed || committed.status !== "accepted_and_integrated") {
        throw agentWorkflowConflict("agent_b4_nothing_to_rollback");
      }
      const backupDir = path.join(acceptanceDir, "backups", `${idempotencyKey}-${handoffDigest.slice(0, 12)}`);
      for (const item of committed.changedFiles || []) {
        const targetFile = path.join(realRoot, ...item.path.split("/"));
        const backupFile = path.join(backupDir, ...item.path.split("/"));
        if (item.changeType === "added") {
          if (existsSync(targetFile) && !lstatSync(targetFile).isSymbolicLink()) {
            const currentSha = sha256Buffer(readFileSync(targetFile));
            if (currentSha === item.sha256) unlinkSync(targetFile);
          }
        } else if (existsSync(backupFile)) {
          mkdirSync(path.dirname(targetFile), { recursive: true });
          writeFileSync(targetFile, readFileSync(backupFile));
        }
      }
      const rolled = {
        ...committed,
        status: "rolled_back",
        rolledBackAt: new Date().toISOString(),
        rollbackDecisionKey: decisionKey,
      };
      ledger.decisions[handoffDigest] = rolled;
      ledger.history.push(rolled);
      saveLedger(ledger);
      return inspect({ idempotencyKey });
    }

    if (!DIGEST.test(input.artifactsDigest ?? "")) {
      throw new TypeError("B4 accept/rework requires artifactsDigest");
    }

    const trustedExec = nativeExecutionService.getTrustedExecutionState({ idempotencyKey });
    const trustedInput = workflowService.getTrustedExecutionInput({ idempotencyKey });
    if (!trustedExec || !trustedInput || trustedExec.handoffDigest !== handoffDigest) {
      throw agentWorkflowConflict("agent_b4_handoff_not_current");
    }

    if (action === "request_rework") {
      const moduleId = typeof input.moduleId === "string" ? input.moduleId.trim() : "";
      const feedback = typeof input.feedback === "string" ? input.feedback.trim() : "";
      if ((!NODE_ID.test(moduleId) && moduleId !== "system") || !feedback || feedback.length > 2_000) {
        throw new TypeError("Invalid B4 rework moduleId or feedback");
      }
      const designSnap = await workflowService.inspectDesign({ idempotencyKey });
      if (!designSnap?.basis || designSnap.version < 1) {
        throw agentWorkflowConflict("agent_b4_design_unavailable");
      }
      await workflowService.recordDesign({
        ...designSnap.basis,
        action: "request_revision",
        mutationKey: `b4rw_${decisionKey}`.slice(0, 88),
        expectedVersion: designSnap.version,
        target: moduleId === "system" ? { kind: "system" } : { kind: "module", moduleId },
        feedback,
      });
      if (typeof nativeExecutionService.archiveCompletedForRework === "function") {
        nativeExecutionService.archiveCompletedForRework({
          idempotencyKey,
          expectedHandoffDigest: handoffDigest,
        });
      }
      const lesson = `[${moduleId}] ${feedback}`;
      if (!ledger.reworkLessons.includes(lesson)) ledger.reworkLessons.push(lesson);
      const record = {
        decisionKey,
        action: "request_rework",
        status: "rework_requested",
        handoffDigest,
        artifactsDigest: input.artifactsDigest,
        moduleId,
        feedback,
        decidedAt: new Date().toISOString(),
      };
      ledger.decisions[handoffDigest] = record;
      ledger.history.push(record);
      saveLedger(ledger);
      return inspect({ idempotencyKey });
    }

    // action === "accept"
    const existing = ledger.decisions[handoffDigest];
    if (existing?.status === "accepted_and_integrated") {
      if (existing.decisionKey !== decisionKey) throw agentWorkflowConflict("agent_b4_already_accepted");
      return inspect({ idempotencyKey });
    }

    const wt = buildWorktreeSnapshot(trustedExec);
    if (wt.oversizePaths?.length > 0) {
      throw agentWorkflowConflict("agent_b4_changed_file_too_large");
    }
    if (wt.errorReason || wt.forbiddenPaths.length > 0 || wt.artifactsDigest !== input.artifactsDigest) {
      throw agentWorkflowConflict("agent_b4_artifacts_changed_or_blocked");
    }
    const verification = ledger.verifications[wt.artifactsDigest];
    if (!verification || verification.passed !== true) {
      throw agentWorkflowConflict("agent_b4_verification_required");
    }

    // 3-way conflict guard against main projectRoot before touching any file!
    const baseline = trustedExec.baselineFiles || {};
    const conflictingPaths = [];
    for (const item of wt.changedFiles) {
      const targetPath = path.join(realRoot, ...item.path.split("/"));
      const baseEntry = baseline[item.path] ?? null;
      const existsInMain = existsSync(targetPath);
      if (existsInMain && lstatSync(targetPath).isSymbolicLink()) {
        conflictingPaths.push(item.path);
        continue;
      }
      if (!baseEntry) {
        if (existsInMain) {
          const mainSha = sha256Buffer(readFileSync(targetPath));
          if (mainSha !== item.sha256) conflictingPaths.push(item.path);
        }
      } else if (!existsInMain) {
        conflictingPaths.push(item.path);
      } else {
        const mainSha = sha256Buffer(readFileSync(targetPath));
        if (mainSha !== baseEntry.sha256 && mainSha !== item.sha256) {
          conflictingPaths.push(item.path);
        }
      }
    }

    if (conflictingPaths.length > 0) {
      return baseResponse(idempotencyKey, {
        status: "blocked",
        reason: "merge_conflict_detected",
        b3Status: "ready_for_review",
        handoffDigest,
        artifactsDigest: wt.artifactsDigest,
        changedFiles: wt.changedFiles,
        conflictingPaths,
        verification,
        reworkLessons: ledger.reworkLessons,
        nextAction: `主项目在执行期间发生了并发修改（${conflictingPaths.join(", ")}），已阻止覆盖主项目文件。`,
      });
    }

    // Backup affected main files, then atomically integrate verified deliverables.
    const backupDir = path.join(acceptanceDir, "backups", `${idempotencyKey}-${handoffDigest.slice(0, 12)}`);
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    for (const item of wt.changedFiles) {
      const targetPath = path.join(realRoot, ...item.path.split("/"));
      if (existsSync(targetPath)) {
        const backupPath = path.join(backupDir, ...item.path.split("/"));
        mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
        writeFileSync(backupPath, readFileSync(targetPath));
      }
    }

    for (const item of wt.changedFiles) {
      const targetPath = path.join(realRoot, ...item.path.split("/"));
      if (item.changeType === "deleted") {
        if (existsSync(targetPath)) rmSync(targetPath, { force: true });
      } else {
        const srcPath = path.join(wt.resolvedWorktree, ...item.path.split("/"));
        mkdirSync(path.dirname(targetPath), { recursive: true });
        const tmpTarget = path.join(path.dirname(targetPath), `.b4-merge-${randomUUID()}.tmp`);
        writeFileSync(tmpTarget, readFileSync(srcPath));
        renameSync(tmpTarget, targetPath);
      }
    }

    const summary = typeof input.summary === "string" ? input.summary.trim().slice(0, 600) : "";
    const playbook = buildAndSavePlaybook({
      idempotencyKey,
      trustedInput,
      verification,
      changedFiles: wt.changedFiles,
      reworkLessons: ledger.reworkLessons,
      summary,
    });

    const decisionRecord = {
      decisionKey,
      action: "accept",
      status: "accepted_and_integrated",
      handoffDigest,
      artifactsDigest: wt.artifactsDigest,
      changedFiles: wt.changedFiles,
      summary,
      playbook: {
        playbookId: playbook.playbookId,
        playbookDigest: playbook.playbookDigest,
        title: playbook.title,
        domainTags: playbook.domainTags,
        applicabilityConditions: playbook.applicabilityConditions,
        reworkLessons: playbook.reworkLessons,
      },
      decidedAt: new Date().toISOString(),
    };
    ledger.decisions[handoffDigest] = decisionRecord;
    ledger.history.push(decisionRecord);
    saveLedger(ledger);
    return inspect({ idempotencyKey });
  }

  let watchInFlight = null;

  async function reconcileActive() {
    if (watchInFlight) return watchInFlight;
    watchInFlight = (async () => {
      const keys = typeof nativeExecutionService.listActiveKeys === "function"
        ? nativeExecutionService.listActiveKeys()
        : [];
      let checkedCount = 0;
      let verifiedCount = 0;
      const readyKeys = [];
      for (const key of keys) {
        checkedCount += 1;
        try {
          const b3 = await nativeExecutionService.inspect({ idempotencyKey: key });
          // Never auto-retry or mutate in_doubt / failed / waiting_input tasks.
          if (b3.status !== "ready_for_review") continue;
          const current = await inspect({ idempotencyKey: key });
          if (current.status === "pending_verification") {
            const verified = await verifyArtifacts({ idempotencyKey: key });
            if (verified.status === "awaiting_human_b4" || verified.status === "verification_failed") {
              verifiedCount += 1;
            }
            if (verified.status === "awaiting_human_b4") readyKeys.push(key);
          } else if (current.status === "awaiting_human_b4") {
            readyKeys.push(key);
          }
        } catch {
          // Isolate per-task reconciliation errors so one bad state never halts watch duty.
        }
      }
      return { checkedCount, verifiedCount, readyKeys };
    })();
    try { return await watchInFlight; }
    finally { watchInFlight = null; }
  }

  function listPlaybooks() {
    return readAllPlaybooks().map((pb) => ({
      playbookId: pb.playbookId,
      playbookDigest: pb.playbookDigest,
      title: pb.title,
      domainTags: pb.domainTags,
      applicabilityConditions: pb.applicabilityConditions,
      verifiedStrategy: pb.verifiedStrategy,
      moduleCount: Array.isArray(pb.moduleBlueprints) ? pb.moduleBlueprints.length : 0,
      verificationSummary: pb.verificationSummary,
      reworkLessons: pb.reworkLessons || [],
      createdAt: pb.createdAt,
    }));
  }

  return Object.freeze({
    inspect,
    verifyArtifacts,
    decide,
    matchPlaybooks,
    listPlaybooks,
    reconcileActive,
  });
}
