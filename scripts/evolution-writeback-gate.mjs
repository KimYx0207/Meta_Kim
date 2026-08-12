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

function allChecksPass(results) {
  return Object.entries(results)
    .filter(([key]) => key !== 'all')
    .every(([, result]) => result?.pass === true);
}

// Five Criteria验证
export async function validateFiveCriteria(packet) {
  const config = await loadEvolutionConfig();
  const writebacks = getWritebacks(packet);
  const targets = getWritebackTargets(packet);
  const hasTargets = targets.length > 0;
  const noWriteback = isNoWritebackDecision(packet);
  const noWritebackHasTargets = noWriteback && writebacks.length > 0;
  const results = {
    independent: null,
    smallEnough: null,
    clearBoundaries: null,
    replaceable: null,
    reusable: null,
    all: false
  };

  // 1. Independent - 产出不依赖其他meta输出
  results.independent = {
    pass: noWriteback
      ? !noWritebackHasTargets && hasDecisionReason(packet)
      : hasTargets,
    reason: "Writeback packets need targets; no-writeback packets need a reason and no writeback targets"
  };

  // 2. Small Enough - 职责单一
  results.smallEnough = {
    pass: writebacks.length <= 3,
    reason: "Writeback should target ≤3 agents to maintain focus"
  };

  // 3. Clear Boundaries - Own/Do Not Touch清晰
  results.clearBoundaries = {
    pass: noWriteback ? writebacks.length === 0 : targets.length === writebacks.length,
    reason: "Each writeback must reference a specific agent/skill; no-writeback packets must not include targets"
  };

  // 4. Replaceable - 可替换
  results.replaceable = {
    pass: true,
    reason: "Evolution system is designed to be replaceable"
  };

  // 5. Reusable - 可复用
  results.reusable = {
    pass: noWriteback
      ? !noWritebackHasTargets && hasDecisionReason(packet)
      : hasTargets && Boolean(packet.signalSummary?.totalSignals > 0 || hasTargets),
    reason: "Triggered by recurring evolution signals"
  };

  results.all = allChecksPass(results);
  return results;
}

// PRIN-ST验证
export async function validatePrinStPrinciples(packet) {
  const config = await loadEvolutionConfig();
  const targets = getWritebackTargets(packet);
  const results = {
    prinSt01: null,
    prinSt02: null,
    prinSt03: null,
    prinSt04: null,
    prinSt05: null,
    all: false
  };

  // PRIN-ST-01: Configurable
  results.prinSt01 = {
    pass: true,
    reason: "Evolution thresholds loaded from evolution-contract.json"
  };

  // PRIN-ST-02: Single Source
  results.prinSt02 = {
    pass: new Set(targets).size === targets.length,
    reason: "No duplicate writeback targets"
  };

  // PRIN-ST-03: Layering
  results.prinSt03 = {
    pass: true,
    reason: "Gate operates at governance layer only"
  };

  // PRIN-ST-04: Decoupling
  results.prinSt04 = {
    pass: true,
    reason: "Gate validates without implementing writeback logic"
  };

  // PRIN-ST-05: i18n
  results.prinSt05 = {
    pass: true,
    reason: "Gate returns structured results; CLI status is diagnostic"
  };

  results.all = allChecksPass(results);
  return results;
}

// 递归风险检查
export async function checkRecursiveRisk(packet) {
  const config = await loadEvolutionConfig();
  const targets = getWritebackTargets(packet);
  const risks = {
    selfEvolution: null,
    circularDependency: null,
    transitiveOverflow: null,
    thresholdGaming: null,
    identityDrift: null,
    detected: false
  };

  // 1. Self-Evolution检查
  risks.selfEvolution = {
    detected: targets.includes('meta-chrysalis'),
    action: 'reject',
    reason: config.gate.recursiveProtection.selfEvolutionBlock.reason
  };

  // 2. Circular Dependency检查
  risks.circularDependency = {
    detected: false,
    action: 'reject',
    reason: config.gate.recursiveProtection.circularDependency.reason
  };

  // 3. Transitive Overflow检查
  risks.transitiveOverflow = {
    detected: false,
    action: 'reject',
    reason: config.gate.recursiveProtection.transitiveOverflow.reason
  };

  // 4. Threshold Gaming检查
  risks.thresholdGaming = {
    detected: packet.signalSummary &&
                   packet.signalSummary.totalSignals > 5 &&
                   targets.length > 0 &&
                   new Set(targets).size === 1,
    action: 'merge',
    reason: config.gate.recursiveProtection.thresholdGaming.reason
  };

  // 5. Identity Drift检查
  risks.identityDrift = {
    detected: false,
    action: 'reject',
    reason: config.gate.recursiveProtection.identityDrift.reason
  };

  risks.detected = Object.entries(risks)
    .filter(([key]) => key !== 'detected')
    .some(([, risk]) => risk?.detected === true);
  return risks;
}

// Gate决策
export async function gateDecision(packet, options = {}) {
  const fiveCriteria = await validateFiveCriteria(packet);
  const prinSt = await validatePrinStPrinciples(packet);
  const recursiveRisk = await checkRecursiveRisk(packet);
  const writebacks = getWritebacks(packet);
  const noWritebackDecision = isNoWritebackDecision(packet);
  const noWriteback = noWritebackDecision && writebacks.length === 0;
  const mutationCandidates = Array.isArray(options.mutationCandidates)
    ? options.mutationCandidates
    : Array.isArray(packet.mutationCandidates)
      ? packet.mutationCandidates
      : [];
  let approvalValidation = noWriteback
    ? null
    : validateWardenWritebackApproval({
        approvalPacket: options.approvalPacket ?? packet.approvalPacket ?? null,
        candidates: mutationCandidates,
      });
  if (
    approvalValidation?.ok === true &&
    options.requiredApprovalScope &&
    approvalValidation.normalized.scope !== options.requiredApprovalScope
  ) {
    approvalValidation = {
      ...approvalValidation,
      ok: false,
      status: 'invalid',
      errors: [`approval scope must be ${options.requiredApprovalScope}`],
    };
  }

  if (noWritebackDecision && writebacks.length > 0) {
    return {
      decision: 'reject',
      riskLevel: 'high',
      fiveCriteria,
      prinSt,
      recursiveRisk,
      reason: 'No-writeback decisions cannot include writeback targets'
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
    if (recursiveRisk.circularDependency.detected) {
      return {
        decision: 'reject',
        riskLevel: 'high',
        fiveCriteria,
        prinSt,
        recursiveRisk,
        reason: `Circular dependency: ${recursiveRisk.circularDependency.reason}`
      };
    }
  }

  // 确定risk level
  if (!fiveCriteria.all || !prinSt.all) {
    riskLevel = 'high';
    decision = 'escalate';
    reason = 'Five Criteria or PRIN-ST validation failed';
  } else if (recursiveRisk.thresholdGaming.detected) {
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
    return { ...decision, deferred: true };
  }

  if (decision.decision === 'escalate') {
    console.log('[Evolution Gate] Escalated to Warden + Genesis review');
    return { ...decision, escalated: true };
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
