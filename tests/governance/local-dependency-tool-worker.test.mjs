import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverDependencySkillContracts } from '../../scripts/dependency-skill-discovery.mjs';
import { componentHash, stableJson, sha256 } from '../../scripts/dependency-agent-discovery.mjs';
import { taskOutcomeDigest } from '../../src/domain/governance/task-outcome.mjs';
import { invokeLocalDependencyToolWorker, isObservedLocalDependencyToolResult, bindLocalDependencyToolWorkOrder } from '../../scripts/governed-execution/local-dependency-tool-worker.mjs';

const invocation = { schemaVersion: 1, type: 'local_cli', runtime: 'python', entrypoint: 'scripts/scan.py', argv: ['--input-json', '-'], inputTransport: 'stdin_json', outputTransport: 'stdout_json', shell: false };
async function fixture(t, { behavior = 'completed' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-kim-local-worker-test-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const dependency = path.join(root, 'dependency');
  const workspace = path.join(root, 'workspace');
  const target = path.join(workspace, 'fixture');
  const componentRoot = path.join(dependency, 'skills/semgrep-skill');
  await fs.mkdir(target, { recursive: true }); await fs.writeFile(path.join(target, 'sample.py'), 'print("fixture")\n');
  const capability = { id: 'local-security-scan', summary: 'Scan explicit local source for security patterns', useWhen: ['Run local security scan'], doNotUseWhen: ['Do not install packages or use network'],
    input: { type: 'object', required: ['schemaVersion', 'workspaceRoot', 'target'], properties: { schemaVersion: { const: 1 }, workspaceRoot: { type: 'string' }, target: { type: 'string' } } },
    output: { type: 'object', required: ['completed'], properties: { completed: { type: 'boolean' } } },
    permissions: ['Read selected target', 'Execute already installed tool'], sideEffects: [], humanGate: { required: false, when: [] }, validation: ['tests/behavior.py'], invocation };
  const contract = { schemaVersion: 1, id: 'semgrep-skill', componentType: 'skill', componentVersion: '1.1.0', entrypoint: 'SKILL.md', capabilities: [capability] };
  const script = `import sys, json, pathlib, hashlib, platform, os\ni=json.load(sys.stdin)\nassert not any(k in os.environ for k in ['ANTHROPIC_AUTH_TOKEN','OPENAI_API_KEY','HTTP_PROXY','HTTPS_PROXY','NODE_OPTIONS'])\nassert pathlib.Path(os.environ['HOME']).resolve() != pathlib.Path.home().parent\nr=pathlib.Path(__file__).resolve().parent.parent/'rules/local-security.yml'\nh=hashlib.sha256(r.read_bytes()).hexdigest()\no={'schemaVersion':1,'componentVersion':'1.1.0','status':'${behavior === 'unavailable' ? 'unavailable' : 'completed'}','completed':${behavior === 'unavailable' ? 'False' : 'True'},'findings':[],'errors':[],'runtime':{'pythonVersion':platform.python_version(),'semgrepVersion':${behavior === 'unavailable' ? 'None' : "'fixture-not-semgrep'"}},'rules':{'source':'canonical:skills/semgrep-skill/rules/local-security.yml','sourceSha256':h,'effectiveSha256':h,'includedRuleIds':['python-subprocess-shell-true','javascript-eval']},'networkUsed':False,'filesModified':False}\n${behavior === 'malformed' ? "o['secretSnippet']='not permitted'" : ''}\n${behavior === 'modify' ? "(pathlib.Path(i['workspaceRoot'])/i['target']/'sample.py').write_text('changed')" : ''}\nprint(json.dumps(o))\nsys.exit(${behavior === 'unavailable' ? '3' : '0'})\n`;
  const files = { 'SKILL.md': '---\nname: semgrep-skill\n---\n# Fixture only\n', 'capability.json': stableJson(contract), 'scripts/scan.py': script, 'rules/local-security.yml': 'rules: []\n', 'tests/behavior.py': '# discovery must not invoke\n' };
  for (const [name, bytes] of Object.entries(files)) { const file = path.join(componentRoot, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); }
  const contentSha256 = await componentHash(componentRoot), contractSha256 = sha256(stableJson(contract));
  const index = { schemaVersion: 1, componentCount: 1, capabilityCount: 1,
    components: [{ id: 'semgrep-skill', componentType: 'skill', componentVersion: '1.1.0', path: 'skills/semgrep-skill', entrypoint: 'SKILL.md', capabilityIds: ['local-security-scan'], validation: capability.validation, contentSha256, contractSha256 }],
    capabilities: [{ ...capability, componentId: 'semgrep-skill', componentType: 'skill', componentVersion: '1.1.0', componentPath: 'skills/semgrep-skill', entrypoint: 'SKILL.md', componentContentSha256: contentSha256, contractSha256 }] };
  await fs.mkdir(path.join(dependency, 'generated')); await fs.writeFile(path.join(dependency, 'generated/capabilities.json'), stableJson(index));
  const discovery = await discoverDependencySkillContracts({ projectRoot: workspace, projects: [{ id: 'fixture-library', source: { localPath: dependency }, interface: { capabilityIndex: { format: 'component-capabilities-v1', path: 'generated/capabilities.json' } } }], capabilityNeedIds: ['local-security-scan'], environment: {} });
  assert.equal(discovery.capabilities.length, 1);
  const selectedCapability = { ...discovery.capabilities[0], testOnly: true, evidence: { ...discovery.capabilities[0].evidence, fixture: true } };
  const requestTask = 'Read-only scan of the explicit internal fixture; do not use a model or modify source';
  const intentDigest = sha256('settled fixture scan');
  const review = Object.fromEntries(['dependencyId', 'sourceRoot', 'componentVersion', 'contractSha256', 'componentContentSha256', 'indexSha256'].map((key) => [key, selectedCapability[key]]));
  review.status = 'pass';
  review.evidenceRefs = ['internal-fixture-source-review-only'];
  const packet = { taskPacketId: 'fixture-scan', intentDigest, intentBinding: { constraints: { localToolSourceReview: review } }, scopeFiles: ['fixture'], localToolBinding: { runId: 'fixture-run', taskHash: taskOutcomeDigest(requestTask), intentDigest, selectedCapability, input: { schemaVersion: 1, workspaceRoot: workspace.replaceAll('\\', '/'), target: 'fixture' } } };
  const options = { runId: 'fixture-run', runtime: 'codex', workspaceRoot: workspace, timeoutMs: 30000, node: { nodeId: 'execute-fixture', effectClass: 'read_only_support' }, packet, requestTask };
  bindLocalDependencyToolWorkOrder(packet, { ...options, testOnly: true });
  return { root, dependency, componentRoot, target, workspace, selectedCapability, packet, requestTask, options };
}

test('task and intent changes are blocked before any local executable runs', async (t) => {
  const f = await fixture(t);
  for (const override of [{ requestTask: 'Another request' }, { packet: { ...f.packet, intentDigest: sha256('different intent') } }]) {
    const result = await invokeLocalDependencyToolWorker({ ...f.options, ...override });
    assert.equal(result.status, 'failed'); assert.equal(result.localToolProcessInvoked, false); assert.equal(result.localToolReceipt, null);
    assert.equal(isObservedLocalDependencyToolResult(result, f.options), false);
  }
});

test('asynchronous work-order mutation cannot substitute a different authorized scope', async (t) => {
  const f = await fixture(t);
  const pending = invokeLocalDependencyToolWorker(f.options);
  f.packet.scopeFiles.push('other');
  const result = await pending;
  assert.equal(result.status, 'failed'); assert.equal(result.localToolProcessInvoked, false);
  assert.match(result.failureMessage, /binding changed/u);
});

test('explicit work-order target scope cannot be replaced by permission booleans or root scope', async (t) => {
  const f = await fixture(t);
  for (const scopeFiles of [[], ['other'], ['.'], ['../']]) {
    const packet = { ...f.packet, scopeFiles, permissionGranted: true };
    bindLocalDependencyToolWorkOrder(packet, { ...f.options, packet, testOnly: true });
    const result = await invokeLocalDependencyToolWorker({ ...f.options, packet });
    assert.equal(result.localToolProcessInvoked, false); assert.equal(result.failureClass, 'local_tool_preflight_blocked');
  }
});

test('unexpected rules, command fields and workspace roots fail before execution', async (t) => {
  const f = await fixture(t);
  for (const fields of [{ rules: 'https://registry/rules' }, { command: 'anything' }, { workspaceRoot: f.root }, { target: '../dependency' }]) {
    const packet = { ...f.packet, localToolBinding: { ...f.packet.localToolBinding, input: { ...f.packet.localToolBinding.input, ...fields } } };
    bindLocalDependencyToolWorkOrder(packet, { ...f.options, packet, testOnly: true });
    const result = await invokeLocalDependencyToolWorker({ ...f.options, packet });
    assert.equal(result.localToolProcessInvoked, false); assert.equal(result.status, 'failed');
  }
});

test('index and component drift invalidate selected capability before invocation', async (t) => {
  for (const file of ['generated/capabilities.json', 'skills/semgrep-skill/scripts/scan.py', 'skills/semgrep-skill/rules/local-security.yml']) {
    const f = await fixture(t); await fs.appendFile(path.join(f.dependency, file), '\n');
    const result = await invokeLocalDependencyToolWorker(f.options);
    assert.equal(result.localToolProcessInvoked, false); assert.equal(result.localToolReceipt, null);
  }
});

test('a linked scan target fails before any process or receipt is created', async (t) => {
  const f = await fixture(t);
  const link = path.join(f.workspace, 'linked');
  await fs.symlink(f.target, link, process.platform === 'win32' ? 'junction' : 'dir');
  const packet = { ...f.packet, scopeFiles: ['linked'], localToolBinding: { ...f.packet.localToolBinding, input: { ...f.packet.localToolBinding.input, target: 'linked' } } };
  bindLocalDependencyToolWorkOrder(packet, { ...f.options, packet, testOnly: true });
  const result = await invokeLocalDependencyToolWorker({ ...f.options, packet });
  assert.equal(result.localToolProcessInvoked, false); assert.equal(result.localToolReceipt, null);
});

test('a target covering the control-plane directory is rejected without adding source files', async (t) => {
  const f = await fixture(t); const target = path.join(f.workspace, 'tmp');
  await fs.mkdir(target); await fs.writeFile(path.join(target, 'sample.py'), '# target\n');
  const before = await componentHash(target);
  const packet = { ...f.packet, scopeFiles: ['tmp'], localToolBinding: { ...f.packet.localToolBinding, input: { ...f.packet.localToolBinding.input, target: 'tmp' } } };
  bindLocalDependencyToolWorkOrder(packet, { ...f.options, packet, testOnly: true });
  const result = await invokeLocalDependencyToolWorker({ ...f.options, packet });
  assert.equal(result.localToolProcessInvoked, false); assert.equal(result.localToolReceipt, null);
  assert.equal(await componentHash(target), before);
});

test('a real guarded Python fixture invocation preserves source and cannot mint production authority', async (t) => {
  const f = await fixture(t); const before = await componentHash(f.target);
  const result = await invokeLocalDependencyToolWorker(f.options);
  assert.equal(result.status, 'pass', JSON.stringify(result)); assert.equal(result.exitCode, 0);
  assert.equal(result.localToolProcessInvoked, true); assert.equal(result.completed, true);
  assert.equal(result.cleanup.ownedProcessGroupCleanupVerified, true); assert.equal(result.cleanup.tempHomeRemoved, true);
  assert.equal(await componentHash(f.target), before);
  assert.equal(result.nativeInvocationVerified, false); assert.equal(result.modelInvocationVerified, false);
  assert.equal(isObservedLocalDependencyToolResult(result, f.options), false, 'fixture result is never production branded');
  assert.equal(isObservedLocalDependencyToolResult(JSON.parse(JSON.stringify(result)), f.options), false);
  const receipt = await fs.readFile(result.localToolReceipt.path);
  assert.equal(sha256(receipt), result.localToolReceipt.sha256);
  assert.equal(JSON.parse(receipt).targetBeforeSha256, JSON.parse(receipt).targetAfterSha256);
});

test('an unavailable scanner is an actual attempt with nonzero exit, not completion', async (t) => {
  const f = await fixture(t, { behavior: 'unavailable' }); const result = await invokeLocalDependencyToolWorker(f.options);
  assert.equal(result.localToolProcessInvoked, true); assert.equal(result.status, 'failed'); assert.equal(result.exitCode, 3);
  assert.equal(result.completed, false); assert.equal(result.outcomeStatus, 'unavailable'); assert.equal(result.failureClass, 'local_tool_unavailable');
  assert(result.localToolReceipt); assert.equal(result.localToolReceipt.summary.completed, false);
});

test('unknown output fields and source mutation cannot produce a completed result', async (t) => {
  for (const behavior of ['malformed', 'modify']) {
    const f = await fixture(t, { behavior }); const result = await invokeLocalDependencyToolWorker(f.options);
    assert.equal(result.localToolProcessInvoked, true); assert.equal(result.status, 'failed'); assert.equal(result.completed, false);
    assert.equal(result.sourceUnmodifiedVerified, false); assert.equal(isObservedLocalDependencyToolResult(result, f.options), false);
    assert(result.localToolReceipt, 'retain owned failure evidence');
  }
});

test('JSON receipt or pass-shaped caller objects never become observed execution', () => {
  assert.equal(isObservedLocalDependencyToolResult({ status: 'pass', completed: true, localToolProcessInvoked: true, authority: 'local_tool' }, {}), false);
  assert.equal(isObservedLocalDependencyToolResult(null), false);
});

test('JSON-cloned or directly constructed work orders are blocked before writes and Python probes', async (t) => {
  const f = await fixture(t);
  const clone = JSON.parse(JSON.stringify(f.packet));
  const result = await invokeLocalDependencyToolWorker({ ...f.options, packet: clone });
  assert.equal(result.localToolProcessInvoked, false); assert.equal(result.localToolReceipt, null);
  assert.match(result.failureMessage, /host-bound original work order/u);
  assert.equal(await fs.access(path.join(f.workspace, 'tmp')).then(() => true, () => false), false);
  assert.throws(() => bindLocalDependencyToolWorkOrder(clone, { ...f.options, testOnly: false }), /fixture cannot/u);
});
