#!/usr/bin/env node
/** Reproducible CLI/Live probe using real repository bytes and a synthetic identity.
 * No user votes, native calls, delivery completion, or global installation. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activateSpineState, createInitialState } from '../../canonical/runtime-assets/shared/hooks/spine-state.mjs';
import { taskProgressGoal } from '../../canonical/runtime-assets/shared/hooks/task-progress.mjs';
import { createLiveWorkspaceService } from '../../src/application/live/live-workspace-service.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination)) throw new Error('Pass a new absolute evidence directory');
await mkdir(destination); // Refuse overwrite: preserve the original evidence.
const root = path.join(destination, 'project');
await mkdir(path.join(root, '.git'), { recursive: true });
await mkdir(path.join(root, '.meta-kim/work'), { recursive: true });
await mkdir(path.join(root, 'sources'));
await mkdir(path.join(root, 'outputs'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = ['src/infrastructure/distribution/desktop-skill-package.mjs', 'src/infrastructure/distribution/desktop-skill-renderers.mjs',
  'src/application/live/live-workspace-service.mjs'];
const inventory = [];
for (const [index, source] of sources.entries()) {
  const bytes = await readFile(path.join(repo, source));
  const ref = `sources/${index}-${path.basename(source)}`;
  await writeFile(path.join(root, ref), bytes);
  inventory.push({ source, ref, sha256: sha(bytes), bytes: bytes.length });
}
const scope = '核清 Meta PRD→详细任务→八个或十一个阶段→发卡机制闭环；发现问题修复；不重复 DSH/ZCode。';
await writeFile(path.join(root, 'sources/user-scope.txt'), scope + '\n');
const chat = '01900000-0000-7000-8000-000000000195';
const state = createInitialState({ activationMode: 'hook_observed', driverMode: 'hook_observed', hookGateMode: 'advisory',
  sourceConversation: { runtime: 'codex', conversationId: chat, matchBasis: 'transcript_file_verified' } });
// Fixture scope only: this never represents an observed native-client transcript.
state.recordOrigin = 'synthetic_identity_real_repository_material';
state.currentStage = 'thinking'; state.stages.critical.status = 'completed'; state.stages.fetch.status = 'completed';
state.stages.thinking.status = 'in_progress';
state.criticalRecord = { realIntent: scope, successCriteria: ['Produce an honest source-bound closure review without invented native completion'] };
await activateSpineState(root, state);
const criterionId = taskProgressGoal(state.criticalRecord).criteria[0].criterionId;
const design = { schemaVersion: 1, design: { mode: 'exploration', taskSlices: [{ id: 'inspect-export', outcome: 'Review current export source boundaries',
  scopeFiles: sources, criterionIds: [criterionId], dependsOn: [], verification: [{ criterionId, procedure: 'Read current source and record SHA-256', expectedEvidence: 'Source inventory and review file' }] }],
  softwareDesign: { schemaVersion: 1, architecture: { id: 'meta-current-flow', revision: 1, summary: scope, decisionRefs: [], technologyChoices: [], constraints: [], moduleIds: ['export'] },
    modules: [{ id: 'export', purpose: 'Expose a portable export without claiming native execution', taskIds: ['inspect-export'],
      implementationNotes: 'Review the current real export source', businessRules: ['Preserve no-model boundaries'], states: [{ name: 'pending', behavior: 'Require actual user review' }] }] } },
  materialRefs: { modules: { export: inventory[0].ref } } };
await writeFile(path.join(root, '.meta-kim/work/design.json'), JSON.stringify(design));
let sequence = 0;
function cli(label, args) {
  const result = spawnSync(process.execPath, [path.join(repo, 'scripts/live-workspace-host.mjs'), '--project-root', root,
    '--run-id', state.runId, '--conversation-id', chat, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  return writeFile(path.join(destination, `${String(++sequence).padStart(2, '0')}-${label}.json`), result.stdout).then(() => value);
}
await cli('published', ['--publish-design', '--input', '.meta-kim/work/design.json', '--expected-revision', '0']);
const service = createLiveWorkspaceService({ projectRoot: root });
const view = await service.getOverview({ runId: state.runId });
// Synthetic feedback transport, quoting the actual current task direction. No accept vote.
const feedback = await service.feedback({ runId: state.runId, artifactId: view.design.architecture.artifactId,
  version: view.design.architecture.version, expectedWorkspaceRevision: view.revision, nonce: 'actual-source-feedback-195',
  original: scope + '\n先以本轮真实代码核对发卡与原生运行边界，保留未验证项。' });
await writeFile(path.join(destination, 'feedback.json'), JSON.stringify({ transport: 'synthetic_live_api_feedback', userApproval: false, ...feedback }, null, 2));
const inspected = await cli('inspect', ['--inspect']);
const claim = await cli('claimed', ['--claim-request', '--command-id', feedback.commandId, '--expected-revision', String(inspected.revision)]);
const restarted = await cli('restarted-after-claim', ['--inspect']);
assert.equal(restarted.requests.find(item => item.commandId === feedback.commandId).status, 'host_claimed');
const findings = [];
for (const item of inventory) {
  const bytes = await readFile(path.join(root, item.ref));
  assert.equal(sha(bytes), item.sha256);
  const source = bytes.toString('utf8');
  findings.push({ ...item, nativeBoundaryMentions: source.split('\n').filter(line => /native|model|approval|permission|planned_only|host_reported/i.test(line)).slice(0, 20) });
}
const output = { schemaVersion: 1, evidenceKind: 'actual_local_source_inspection', modelCalls: 0,
  identityKind: 'synthetic_fixture', syntheticUiDecision: false, nativeInvocationVerified: false, businessAccepted: false,
  findings, limitation: 'Text inspection and file hashes establish source evidence only; no native card or eight-stage business completion.' };
const outputBytes = JSON.stringify(output, null, 2) + '\n';
await writeFile(path.join(root, 'outputs/source-review.json'), outputBytes);
const receipt = { outcome: 'produced', summary: 'Read actual source bytes and wrote a bounded source review; native behavior remains unverified',
  evidenceRefs: [{ ref: 'outputs/source-review.json', sha256: sha(outputBytes) }] };
await writeFile(path.join(root, '.meta-kim/work/receipt.json'), JSON.stringify(receipt));
const reportArgs = ['--complete-request', '--command-id', claim.commandId, '--claim-token', claim.claimToken,
  '--input', '.meta-kim/work/receipt.json', '--expected-revision', String(restarted.revision)];
const report = await cli('reported', reportArgs);
assert.equal(report.status, 'host_reported'); assert.equal(report.completionVerified, false);
assert.equal((await cli('receipt-replay', reportArgs)).replay, true);
const final = await cli('restarted-after-report', ['--inspect']);
assert.equal(final.requests.find(item => item.commandId === claim.commandId).status, 'host_reported');
assert.notEqual(final.designStatus, 'accepted'); assert.equal(final.stage, 'thinking');
await writeFile(path.join(destination, 'summary.json'), JSON.stringify({ modelCalls: 0, nativeInvocationVerified: false, userApproval: false,
  identityKind: state.recordOrigin, runId: state.runId, inventory, commandId: claim.commandId, receiptSha256: sha(outputBytes),
  observed: ['publish CLI', 'feedback API', 'inspect CLI', 'claim CLI', 'restart retains claim', 'actual file read/write', 'receipt CLI', 'idempotent receipt replay', 'restart retains receipt'],
  remaining: ['real user design approval', 'native card delivery', 'native provider execution', 'eight-stage accepted business completion'], final }, null, 2));
console.log(JSON.stringify({ destination, status: 'host_reported_not_business_completed', modelCalls: 0 }));
