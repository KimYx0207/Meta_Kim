import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCapabilityGapOrchestration } from '../../scripts/run-capability-gap-orchestration.mjs';
import { evaluateGovernedArtifact } from '../../scripts/evaluate-governance-outcomes.mjs';

test('Critical keeps each user outcome instead of substituting a framework maintenance goal', () => {
  for (const request of [
    '比较三个搬家方案，按通勤、预算和可逆性推荐最合适的路线。',
    '根据实际店铺数据分析退货原因，不承诺没有证据的销量提升。',
    'Help me plan an accessible Electron study app and explain the trade-offs.',
    '根据学习者已有基础，安排两周的数学复习并说明验收方式。',
  ]) {
    const report = buildCapabilityGapOrchestration(request);
    assert.equal(report.criticalSummary.realGoal, request);
    assert.equal(report.rootGoal, request);
  }
});

test('the real governed entry binds a non-coding decision and a user-selected technology', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'meta-kim-goal-binding-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('meta-kim-goal-binding-'));
    await rm(temp, { recursive: true, force: true });
  });
  for (const [index, task] of [
    '比较两种搬家方案，考虑通勤时间、预算和不确定性，推荐后说明依据。',
    'Compare Electron and Tauri for an accessible study tool and recommend an implementation plan.',
  ].entries()) {
    const runId = `goal-binding-${index}`;
    const result = spawnSync(process.execPath, [
      'scripts/run-meta-theory-governed-execution.mjs', '--no-emit-conversation-notice',
      '--task', task, '--run-id', runId, '--state-dir', temp, '--db', path.join(temp, `${runId}.sqlite`),
    ], { encoding: 'utf8', cwd: path.resolve(import.meta.dirname, '../..'), maxBuffer: 10 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    const artifact = JSON.parse(await readFile(path.join(temp, `${runId}.json`), 'utf8'));
    assert.equal(artifact.coreLoop.intentPacket.realIntent, task);
    assert.equal(artifact.coreLoop.goalContractPacket.contractFields.outcome, task);
    assert.deepEqual(artifact.coreLoop.intentPacket.successCriteria, [task]);
    assert.equal(artifact.coreLoop.traceEvalControlPlane.outcomeEvaluation.status, 'incomplete');
    assert.equal(evaluateGovernedArtifact(artifact).status, 'incomplete');
    const fixtureGate = artifact.coreLoop.productExperiencePacket.supportGates.find((gate) => gate.id === 'P-108');
    assert.equal(fixtureGate.status, 'pass', 'Legitimate user technology must not become a forbidden durable fixture');
  }
});
