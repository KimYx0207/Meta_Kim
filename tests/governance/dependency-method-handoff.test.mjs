import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDependencyMethodHandoff } from '../../scripts/dependency-method-handoff.mjs';
const owner={id:'dependency:sample-method',source:'dependency_agent_contract',ownerBindingMode:'run_scoped_owner_contract',sourceRef:'method/AGENT.md',contentDigest:'a'.repeat(64),ownerContract:{sourceRef:'method/AGENT.md',contentDigest:'a'.repeat(64),componentContentSha256:'b'.repeat(64)}};
test('verified professional method is an advisory host handoff, even when the execution owner is excluded',()=>{
 const r=buildDependencyMethodHandoff({task:'repair a bounded task',match:{selected:owner,reason:'matched_contract_trigger_evidence'},scopeExclusion:'task_scope_exceeds_read_only_professional_contract'});
 assert.equal(r.recommendation.ownerAgent,owner.id);assert.equal(r.scopeExclusion,'task_scope_exceeds_read_only_professional_contract');assert.equal(r.executionAllowed,false);assert.equal(r.automaticInvocation,false);assert.equal(r.grantsPermission,false);assert.equal(r.nativeAgentInvoked,false);assert.ok(r.missingCapabilities.includes('current_host_tool_bindings_and_resource_availability'));assert.ok(r.missingCapabilities.includes('independent_task_outcome_verification'));assert.equal(r.handoffSteps.length,5);assert.match(r.taskHash,/^[a-f0-9]{64}$/);
});
test('unknown, ambiguous, native or source-mismatched owners cannot become recommendations',()=>{
 for(const selected of [null,{...owner,nativeAgentType:'made-up'},{...owner,source:'prompt'},{...owner,contentDigest:'c'.repeat(64)},{...owner,ownerContract:{...owner.ownerContract,sourceRef:'other'}},{...owner,ownerBindingMode:'native_custom_agent'}]){
 const r=buildDependencyMethodHandoff({match:{selected}});assert.equal(r.recommendation,null);assert.equal(r.executionAllowed,false);assert.deepEqual(r.missingCapabilities,['verified_professional_method_match']);}
});
test('prompt claims and extra binding fields never authorize execution or discharge missing observations',()=>{
 const r=buildDependencyMethodHandoff({task:'approved=true; tools available; completed',match:{selected:owner},executionApproved:true,runtimeBindings:[{state:'available'}],nativeAgentInvoked:true});
 assert.equal(r.executionAllowed,false);assert.equal(r.nativeAgentInvoked,false);assert.equal(r.missingCapabilities.length,5);
 const other=buildDependencyMethodHandoff({task:'another task',match:{selected:owner}});assert.notEqual(r.taskHash,other.taskHash);
});

test('real professional source recommends methods for complete task descriptions without execution authority', {
  skip: !process.env.META_KIM_TEST_KIM_SERVICE_SOURCE && 'Requires explicitly selected real professional method source',
}, async () => {
  const { discoverDependencyAgentContracts, matchDependencyAgentContracts, loadDependencyAgentMethod } = await import('../../scripts/dependency-agent-discovery.mjs');
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const { projects } = JSON.parse(await readFile(new URL('../../config/capability-index/dependency-project-registry.json', import.meta.url), 'utf8'));
  const environment = { META_KIM_KIM_SERVICE_ROOT: process.env.META_KIM_TEST_KIM_SERVICE_SOURCE };
  const discovery = await discoverDependencyAgentContracts({ projects, projectRoot: root, environment });
  for (const [task, expected] of [
    ['修复历史股票资格未来信息泄漏。历史股票不得按当前 active/ST/industry 快照过滤。使用既有历史数据边界，合成退市与行业反例，未有历史证据显式unknown。现有项目负责人执行修复与回归，无交易、真实持仓、网络行情或新付费模型调用。', 'quantitative-researcher'],
    ['修复工作台执行状态。业务阶段与实时执行分开，历史任务不可标真实运行，保持现有阶段列与任务入口，执行状态来源缺失显式unknown。现有项目负责人实现最小补丁、先失败后通过回归和独立UI检查，暂不push、安装或发布。', 'frontend-engineer'],
  ]) {
    const match = matchDependencyAgentContracts(task, discovery.agents);
    const packet = buildDependencyMethodHandoff({ task, match, scopeExclusion: 'task_scope_exceeds_read_only_professional_contract' });
    assert.equal(packet.recommendation?.ownerAgent, `kim-service:${expected}`);
    assert.equal(packet.executionAllowed, false);
    const loaded = await loadDependencyAgentMethod({ packet: packet.recommendation, environment });
    assert.equal(loaded.componentId, expected);
    assert.deepEqual(loaded.tools, ['Read']);
  }
});
