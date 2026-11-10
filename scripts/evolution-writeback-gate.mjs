#!/usr/bin/env node
/**
 * Evolution Writeback Gate
 *
 * 所有evolution writeback操作的强制协调点
 *
 * Gate流程:
 * 1. 接收evolutionWritebackPacket
 * 2. 验证Five Criteria compliance
 * 3. 验证PRIN-ST principles
 * 4. 递归风险检查
 * 5. 根据risk level要求用户确认
 * 6. 协调实际写back操作
 * 7. 记录audit trail
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateWardenWritebackApproval } from '../src/domain/evolution/warden-writeback-approval.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// 从evolution-contract.json加载配置
let EVOLUTION_CONFIG = null;

const NO_WRITEBACK_DECISIONS = new Set(['none', 'none-with-reason']);

async function loadEvolutionConfig() {
  if (EVOLUTION_CONFIG) return EVOLUTION_CONFIG;

  const configPath = path.join(PROJECT_ROOT, 'config', 'contracts', 'evolution-contract.json');
  const content = await fs.readFile(configPath, 'utf8');
  EVOLUTION_CONFIG = JSON.parse(content);
  return EVOLUTION_CONFIG;
}

function getWritebacks(packet) {
  return Array.isArray(packet.writebacks) ? packet.writebacks : [];
}

function getWritebackTarget(writeback) {
  if (typeof writeback === 'string') return writeback;
  if (!writeback || typeof writeback !== 'object') return null;
  return writeback.target ?? writeback.owner ?? writeback.agent ?? writeback.id ?? null;
}

function getWritebackTargets(packet) {
  return getWritebacks(packet)
    .map(getWritebackTarget)
    .filter((target) => typeof target === 'string' && target.length > 0);
}

function isNoWritebackDecision(packet) {
  return NO_WRITEBACK_DECISIONS.has(packet.writebackDecision);
}

function hasDecisionReason(packet) {
  return typeof packet.decisionReason === 'string' && packet.decisionReason.trim().length > 0;
}

function checkResult(status, reason, details = {}) {
  return { status, pass: status === 'pass' ? true : status === 'fail' ? false : null, reason, ...details };
}

function allChecksPass(results) {
  return Object.entries(results)
    .filter(([key]) => key !== 'all')
    .every(([, result]) => result?.pass === true || result?.status === 'not_applicable');
}

function hasFailedCheck(results) {
  return Object.values(results).some((result) => result?.pass === false);
}

function mutationCandidatesFor(packet, options) {
  return Array.isArray(options.mutationCandidates) ? options.mutationCandidates
    : Array.isArray(packet.mutationCandidates) ? packet.mutationCandidates : [];
}

function hasDeclaredMutations(packet, options = {}) {
  // A caller's empty override cannot make a candidate declared in the packet
  // disappear from a no-writeback claim. Malformed declarations need review.
  return [packet.mutationCandidates, options.mutationCandidates]
    .some((value) => value != null && (!Array.isArray(value) || value.length > 0));
}

function approvalFor(packet, options) {
  const approval = validateWardenWritebackApproval({
    approvalPacket: options.approvalPacket ?? packet.approvalPacket ?? null,
    candidates: mutationCandidatesFor(packet, options),
  });
  if (approval.ok && options.requiredApprovalScope && approval.normalized.scope !== options.requiredApprovalScope) {
    return { ...approval, ok: false, status: 'invalid',
      errors: [`approval scope must be ${options.requiredApprovalScope}`] };
  }
  return approval;
}

function reviewedCheck(packet, options, section, key, reason) {
  // Review data belongs inside the existing exact-bound approval. Candidate
  // prose and free-floating evidence refs never become write authorization.
  const approval = approvalFor(packet, options);
  const review = approval.ok ? approval.normalized.riskReview : null;
  const assessment = review?.qualityChecks?.[section]?.[key];
  const refs = assessment?.evidenceRefs;
  if (review?.status !== 'accepted' || typeof review.owner !== 'string' || !review.owner.trim() ||
      !['pass', 'fail'].includes(assessment?.verdict) || typeof assessment.reason !== 'string' || !assessment.reason.trim() ||
      !Array.isArray(refs) || refs.length === 0 || refs.some((ref) => typeof ref !== 'string' || !ref.trim())) {
    return checkResult('not_evaluated', reason, { evidenceRefs: [], evidenceLevel: 'not_assessed' });
  }
  return checkResult(assessment.verdict, assessment.reason, {
    evidenceRefs: [...refs], reviewer: review.owner, approvalDigest: approval.approvalDigest,
    evidenceLevel: 'reviewer_reported', evidenceContentVerified: false,
  });
}

function noWritebackCheck(packet, options = {}) {
  return isNoWritebackDecision(packet) && getWritebacks(packet).length === 0 &&
    (packet.writebacks == null || Array.isArray(packet.writebacks)) &&
    !hasDeclaredMutations(packet, options) && hasDecisionReason(packet);
}

// Structural checks can reject malformed candidates. Semantic properties are
// explicitly unassessed until the exact-bound reviewer supplies an assessment.
export async function validateFiveCriteria(packet, options = {}) {
  const writebacks = getWritebacks(packet);
  const targets = getWritebackTargets(packet);
  const noWriteback = noWritebackCheck(packet, options);
  const assess = (key, reason) => noWriteback
    ? checkResult('not_applicable', 'No durable mutation was requested; no candidate quality is claimed')
    : reviewedCheck(packet, options, 'fiveCriteria', key, reason);
  const results = {
    independent: isNoWritebackDecision(packet)
      ? checkResult(noWriteback ? 'pass' : 'fail', 'No-writeback closure requires a reason and zero mutation targets')
      : targets.length === 0 ? checkResult('fail', 'Writeback candidates require explicit targets')
        : assess('independent', 'Target presence does not demonstrate responsibility independence'),
    smallEnough: writebacks.length > 3
      ? checkResult('fail', 'A writeback review must cover no more than three targets')
      : assess('smallEnough', 'A small target count does not demonstrate a single responsibility'),
    clearBoundaries: targets.length !== writebacks.length || isNoWritebackDecision(packet) && writebacks.length > 0
      ? checkResult('fail', 'Every writeback must resolve to a specific target')
      : assess('clearBoundaries', 'Candidate responsibility boundaries have not been reviewed'),
    replaceable: assess('replaceable', 'Replacement and rollback behavior have not been reviewed'),
    reusable: !noWriteback && packet.signalSummary?.totalSignals === 0
      ? checkResult('fail', 'Zero recorded signals cannot establish a reusable change')
      : assess('reusable', 'Recurring signals and demonstrated future use require review evidence'),
  };
  results.all = allChecksPass(results);
  return results;
}

export async function validatePrinStPrinciples(packet, options = {}) {
  const targets = getWritebackTargets(packet);
  const noWriteback = noWritebackCheck(packet, options);
  const assess = (key, reason) => noWriteback
    ? checkResult('not_applicable', 'No durable mutation was requested; no candidate quality is claimed')
    : reviewedCheck(packet, options, 'prinSt', key, reason);
  const results = {
    prinSt01: assess('prinSt01', 'Loading gate configuration does not prove the candidate is configurable'),
    prinSt02: new Set(targets).size !== targets.length
      ? checkResult('fail', 'Duplicate writeback targets require consolidation')
      : assess('prinSt02', 'Distinct targets do not prove a single source of truth'),
    prinSt03: assess('prinSt03', 'Candidate dependency direction and layer ownership require review'),
    prinSt04: assess('prinSt04', 'Candidate interface and dependency coupling require review'),
    prinSt05: assess('prinSt05', 'Candidate user-facing language behavior requires review'),
  };
  results.all = allChecksPass(results);
  return results;
}

export async function checkRecursiveRisk(packet, options = {}) {
  const config = await loadEvolutionConfig();
  const targets = getWritebackTargets(packet);
  const noWriteback = noWritebackCheck(packet, options);
  const candidateTargets = [packet.mutationCandidates, options.mutationCandidates].filter(Array.isArray)
    .flatMap((candidates) => candidates.map((candidate) => candidate?.targetRef)).filter((target) => typeof target === 'string');
  const normalizedTargets = [...targets, ...candidateTargets]
    .map((target) => target.trim().replaceAll('\\', '/').split('/').at(-1).toLowerCase().replace(/\.md$/u, ''));
  const selfDetected = normalizedTargets.includes('meta-chrysalis');
  const risks = {
    selfEvolution: { status: noWriteback ? 'not_applicable' : selfDetected ? 'fail' : 'pass', detected: selfDetected,
      action: 'reject', reason: config.gate.recursiveProtection.selfEvolutionBlock.reason },
  };
  for (const key of ['circularDependency', 'transitiveOverflow', 'thresholdGaming', 'identityDrift']) {
    const result = noWriteback
      ? checkResult('not_applicable', 'No durable mutation requested')
      : reviewedCheck(packet, options, 'recursiveRisk', key, `${key} has not been evaluated against this exact candidate`);
    risks[key] = { ...result, detected: result.status === 'not_applicable' ? false : result.pass === null ? null : !result.pass,
      action: config.gate.recursiveProtection[key].action };
  }
  risks.detected = Object.values(risks).some((risk) => risk?.detected === true);
  risks.fullyEvaluated = Object.values(risks).filter((risk) => risk && typeof risk === 'object')
    .every((risk) => ['pass', 'fail', 'not_applicable'].includes(risk.status));
  return risks;
}

// Gate决策
export async function gateDecision(packet, options = {}) {
  const fiveCriteria = await validateFiveCriteria(packet, options);
  const prinSt = await validatePrinStPrinciples(packet, options);
  const recursiveRisk = await checkRecursiveRisk(packet, options);
  const writebacks = getWritebacks(packet);
  const noWritebackDecision = isNoWritebackDecision(packet);
  const noWriteback = noWritebackCheck(packet, options);
  const approvalValidation = noWriteback ? null : approvalFor(packet, options);

  if (noWritebackDecision && (writebacks.length > 0 || hasDeclaredMutations(packet, options))) {
    return {
      decision: 'reject',
      riskLevel: 'high',
      fiveCriteria,
      prinSt,
      recursiveRisk,
      reason: 'No-writeback decisions cannot include writeback targets or mutation candidates'
    };
  }

  let decision = noWriteback ? 'approve' : 'candidate_only';
  let riskLevel = 'low';
  let reason = noWriteback
    ? 'No durable writeback requested; none-with-reason accepted'
    : 'Canonical writeback remains candidate-only until an exact Warden approval is validated';

  // 检查递归风险
  if (recursiveRisk.detected) {
    if (recursiveRisk.selfEvolution.detected) {
      return {
        decision: 'reject',
        riskLevel: 'critical',
        fiveCriteria,
        prinSt,
        recursiveRisk,
        reason: `Self-evolution blocked: ${recursiveRisk.selfEvolution.reason}`
      };
    }
    const rejectedRisk = ['circularDependency', 'transitiveOverflow', 'identityDrift']
      .find((key) => recursiveRisk[key].detected === true);
    if (rejectedRisk) {
      return {
        decision: 'reject',
        riskLevel: 'high',
        fiveCriteria,
        prinSt,
        recursiveRisk,
        reason: `${rejectedRisk}: ${recursiveRisk[rejectedRisk].reason}`
      };
    }
  }

  // 确定risk level
  if (hasFailedCheck(fiveCriteria) || hasFailedCheck(prinSt)) {
    riskLevel = 'high';
    decision = 'escalate';
    reason = 'Five Criteria or PRIN-ST validation failed';
  } else if (recursiveRisk.thresholdGaming.detected === true) {
    riskLevel = 'medium';
    decision = 'merge';
    reason = 'Threshold gaming detected - merge writebacks';
  } else if (packet.scarIds && packet.scarIds.length > 0) {
    riskLevel = 'critical';
    decision = 'escalate';
    reason = 'Critical scars detected - requires dual review';
  } else if (options.boundaryModification) {
    riskLevel = 'medium';
    decision = 'defer';
    reason = 'Boundary modification requires user confirmation';
  } else if (!fiveCriteria.all || !prinSt.all || !recursiveRisk.fullyEvaluated) {
    riskLevel = 'medium';
    decision = 'candidate_only';
    reason = 'Candidate preserved; quality and recursive-risk checks require evidence in the exact-bound Warden review';
  } else if (!noWriteback && approvalValidation?.ok === true) {
    decision = 'approve';
    reason = 'Exact Warden approval covers every mutation candidate';
  }

  return {
    decision,
    riskLevel,
    fiveCriteria,
    prinSt,
    recursiveRisk,
    approvalValidation,
    qualityStatus: fiveCriteria.all && prinSt.all && recursiveRisk.fullyEvaluated ? 'reviewed' :
      hasFailedCheck(fiveCriteria) || hasFailedCheck(prinSt) || recursiveRisk.detected ? 'failed' : 'not_evaluated',
    reason
  };
}

// 主函数 - 处理evolution writeback packet
export async function processEvolutionPacket(packet, options = {}) {
  console.log('[Evolution Gate] Processing evolution writeback packet...');

  const decision = await gateDecision(packet, options);

  console.log(`[Evolution Gate] Decision: ${decision.decision}`);
  console.log(`[Evolution Gate] Risk Level: ${decision.riskLevel}`);
  console.log(`[Evolution Gate] Reason: ${decision.reason}`);

  if (decision.decision === 'reject') {
    throw new Error(`Evolution writeback rejected: ${decision.reason}`);
  }

  if (decision.decision === 'defer') {
    console.log('[Evolution Gate] Deferred - user confirmation required');
    return { ...decision, deferred: true, approved: false, canonicalWrites: 0 };
  }

  if (decision.decision === 'escalate') {
    console.log('[Evolution Gate] Escalated to Warden + Genesis review');
    return { ...decision, escalated: true, approved: false, canonicalWrites: 0 };
  }

  if (decision.decision === 'merge') {
    return { ...decision, mergeRequired: true, approved: false, canonicalWrites: 0 };
  }

  if (decision.decision === 'candidate_only') {
    console.log('[Evolution Gate] Candidate-only - no canonical write authorized');
    return {
      ...decision,
      approved: false,
      candidateOnly: true,
      canonicalWrites: 0,
      approvalRequired: true,
    };
  }

  if (isNoWritebackDecision(packet) && getWritebackTargets(packet).length === 0) {
    console.log('[Evolution Gate] Approved - no writeback requested');
    return { ...decision, approved: true, noWriteback: true };
  }

  console.log('[Evolution Gate] Warden-approved - writeback may proceed through the bound apply path');
  return { ...decision, approved: true, canonicalWrites: 0 };
}

// CLI入口
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Evolution Writeback Gate

Usage:
  node evolution-writeback-gate.mjs <packet-file> [options]

Options:
  --approval <file>  Exact Warden approval v0.2 packet
  --apply            Authorize the caller to apply only the approved bindings
  --force            Conflict handling only; never substitutes for approval
  --dry-run  Show decision without processing
  --help     Show this help

Examples:
  node evolution-writeback-gate.mjs evolution-packet.json
  node evolution-writeback-gate.mjs evolution-packet.json --dry-run
  node evolution-writeback-gate.mjs evolution-packet.json --approval approval.json --apply
    `);
    process.exit(0);
  }

  const packetFile = args[0];
  if (!packetFile) {
    console.error('Error: Packet file required');
    process.exit(1);
  }

  const packet = JSON.parse(await fs.readFile(packetFile, 'utf8'));
  const approvalIndex = args.indexOf('--approval');
  const approvalFile = approvalIndex >= 0 ? args[approvalIndex + 1] : null;
  if (approvalIndex >= 0 && !approvalFile) {
    console.error('Error: --approval requires a packet file');
    process.exit(1);
  }
  const approvalPacket = approvalFile
    ? JSON.parse(await fs.readFile(path.resolve(approvalFile), 'utf8'))
    : null;
  const options = {
    force: args.includes('--force'),
    dryRun: args.includes('--dry-run'),
    apply: args.includes('--apply'),
    approvalPacket,
    mutationCandidates: packet.mutationCandidates,
    boundaryModification: packet.boundaryModification
  };

  await processEvolutionPacket(packet, options)
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.decision === 'approve' ? 0 : 1);
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
